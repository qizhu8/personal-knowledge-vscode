import { createHash } from "node:crypto";
import * as path from "node:path";
import { CoreError } from "./contracts.js";
import { githubSyncIgnoredPath, githubSyncSafeRelativePath } from "./sync-storage-boundary.js";
import { syncPlanHash } from "./sync-plan.js";
import type { SyncManifest, SyncPlanInput } from "./sync-plan-contracts.js";
import { validatePersona, portablePersonaPath } from "./domain/sync-transport-original.js";
import { actionDefinitionDiagnostics, actionBuiltinId, actionComponents, actionIdValid, loadModuleSet, originalDigest,
  safeModuleMember, validResourceReference } from "./domain/action-compiler-validation.js";
import { ACTION_COMPILER_LIMITS } from "./action-compiler-contracts.js";
import { legacySyncScriptIdentity } from "./legacy-sync-script-identity.js";
import { projectRecipeSchema } from "./project-recipes-contracts.js";
import { normalizeRecipeCategory, validateRecipeRecord } from "./domain/project-recipes-storage-rules.js";

type File = SyncManifest["files"][number];
type Deletion = SyncManifest["deletions"][number];
export type SyncContentReview = {
  actorId: string; sessionId: string; sourcePins: { base: string; local: string; remote: string };
  sourceSha256: string; entities: Array<{ type: File["type"]; itemId: string }>;
};
/** Native producer custody. Never supplied through public operation arguments or historical receipts. */
export type SyncContentAuthority = {
  root: string; actorId: string; epoch: string; profileSha256: string;
  assertCurrent(review: SyncContentReview): void;
};
const knowledge = new Set(["notes", "papers", "prompts", "skills", "scripts"]);
const assets = new Set([".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".svg", ".tif", ".tiff", ".webp"]);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never { throw new CoreError("CONFLICT", message); }
const key = (value: { type: string; itemId: string }) => JSON.stringify([value.type, value.itemId]);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("Sync content requires a typed object.");
  return value as Record<string, unknown>;
};
function text(bytes: Buffer): string {
  if (bytes.includes(0)) return fail("Sync structured content contains NUL.");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return fail("Sync structured content is not UTF-8."); }
}
function json(file: File): Record<string, unknown> {
  if (file.contentBase64 === undefined) return fail(`Typed source has no staged bytes: ${file.path}`);
  try { return record(JSON.parse(text(Buffer.from(file.contentBase64, "base64")))); }
  catch (error) { if (error instanceof CoreError) throw error; return fail(`Invalid typed JSON: ${file.path}`); }
}
function noCredentials(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(noCredentials); return; }
  if (!value || typeof value !== "object") return;
  for (const [name, member] of Object.entries(value)) {
    if (/^(?:password|token|accessToken|refreshToken|apiKey|secret|privateKey|credentials|authorization|cookie|sessionHistory|transcript)$/i.test(name)
      || /(?:^|[_-])(?:password|token|access_token|refresh_token|api_key|secret|private_key|credentials)(?:$|[_-])/i.test(name)) {
      if (member !== undefined && member !== null && member !== "")
        fail("Raw credentials or historical conversation state are not portable Sync metadata.");
    }
    noCredentials(member);
  }
}
export function syncContentPath(value: string, type: string): string {
  const safe = githubSyncSafeRelativePath(value);
  if (safe !== value || value !== value.normalize("NFC") || value.includes("\\") || value.startsWith("/")
    || value.split("/")[0] !== type || value.split("/").some(part => [".git", ".pkm", ".trash"].includes(part.toLowerCase()))
    || githubSyncIgnoredPath(value) || githubSyncIgnoredPath(value.toLowerCase()))
    fail(`Unsafe or ignored Sync content path: ${value}`);
  if (type === "scripts" || type === "prompts") return safe;
  if (knowledge.has(type)) {
    const ext = path.posix.extname(value).toLowerCase();
    if (ext !== ".md" && !assets.has(ext)) fail(`Unsupported knowledge member: ${value}`);
    return safe;
  }
  switch (type) {
    case "packages": case "servers":
      if (value.split("/").length < 3) fail("Package/server content requires an owned directory member.");
      return safe;
    case "recipes": case "actions": case "profiles":
      if (!value.endsWith(".json")) fail("Typed metadata requires JSON.");
      return safe;
    case "action-module-sets":
      if (!/^action-module-sets\/[a-z][a-z0-9_.-]{2,100}\/[1-9][0-9]*\/(?:manifest\.json|(?:definitions|assets)\/.+)$/.test(value))
        fail("ModuleSet member is not part of an immutable version.");
      return safe;
    case "agentSnapshots":
      fail("Original Agent Snapshot payloads are local-obfuscated history, not current portable encrypted source authority.");
    default: return fail("Unsupported Sync content type.");
  }
}
function validateScript(files: File[]): void {
  const body = files.find(file => file.member === "");
  if (!body || files.filter(file => file.member === "").length !== 1 || path.posix.basename(body.path).startsWith("."))
    fail("Script source requires exactly one primary body.");
  const relative = body.path.slice("scripts/".length);
  const locator = relative.replace(/\.[^.]+$/, "");
  const stableId = /^script_[a-f0-9]{24}$/.test(body.itemId);
  if (body.itemId !== relative && body.itemId !== locator && !stableId)
    fail("Script primary identity differs from its source locator.");
  if (body.category !== path.posix.dirname(relative).replace(/^\.$/, "")) fail("Script category differs from its body path.");
  const sidecar = files.find(file => file.member === "identity-sidecar");
  if (stableId && !sidecar) fail("Stable Script identity requires its paired sidecar.");
  if (sidecar) {
    const identity = legacySyncScriptIdentity();
    const expected = identity.syncScriptSidecarPath(body.path);
    if (sidecar.contentBase64 === undefined) fail("Script identity has no staged bytes.");
    const value = identity.readSyncScriptIdentity(Buffer.from(sidecar.contentBase64, "base64"));
    if (sidecar.path !== expected || value.knowledgeId !== body.itemId || !stableId)
      fail("Script sidecar identity or ownership differs.");
  }
  for (const file of files) if (file !== body && file !== sidecar) {
    if (file.member !== file.path || !file.path.startsWith(body.path.replace(/\.[^.]+$/, "") + ".assets/"))
      fail("Script dependency is not owned by its primary source.");
  }
}
function validateEntity(files: File[]): void {
  const first = files[0];
  for (const file of files) {
    syncContentPath(file.path, file.type);
    if (file.type !== first.type || file.itemId !== first.itemId || file.category !== first.category || file.privacy !== first.privacy)
      fail("Inconsistent Sync entity custody.");
    if (file.contentBase64 !== undefined) {
      const bytes = Buffer.from(file.contentBase64, "base64");
      if (bytes.toString("base64") !== file.contentBase64 || hash(bytes) !== file.digest) fail("Sync member bytes differ from source SHA.");
    }
  }
  if (first.type === "scripts") { validateScript(files); return; }
  if (first.type === "prompts") {
    const prefix = `prompts/${first.itemId}/`;
    if (files.some(file => file.path.startsWith(prefix))) {
      if (first.itemId.split("/").length !== 2 || first.category !== first.itemId.split("/")[0]
        || files.some(file => !file.path.startsWith(prefix) || file.member !== file.path.slice(prefix.length)))
        fail("Prompt members do not belong to their exact project/task source.");
    } else if (files.some(file => path.posix.extname(file.path).toLowerCase() !== ".md"
      && !assets.has(path.posix.extname(file.path).toLowerCase()))) {
      fail("Opaque Prompt members require exact project/task ownership.");
    }
    return;
  }
  if (knowledge.has(first.type)) return;
  if (first.type === "packages" || first.type === "servers") {
    for (const file of files) {
      const parts = file.path.split("/");
      if (parts[1] !== file.itemId || file.member !== parts.slice(2).join("/")) fail("Package/server member is not root-owned.");
      if (file.path.endsWith(".json")) noCredentials(json(file));
    }
    return;
  }
  if (first.type === "action-module-sets") {
    const prefix = `action-module-sets/${first.itemId}/`;
    const primary = files.find(file => file.path === prefix + "manifest.json");
    if (!primary || primary.member || first.category !== first.itemId.split("/")[0]) fail("ModuleSet primary identity differs.");
    const value = json(primary), inventory = record(value.files);
    if (`${value.module_set_id}/${value.version}` !== first.itemId) fail("ModuleSet version identity differs.");
    const members = files.filter(file => file !== primary);
    if (members.length !== Object.keys(inventory).length) fail("ModuleSet inventory is incomplete.");
    for (const file of members) if (!file.path.startsWith(prefix) || file.member !== file.path
      || !safeModuleMember(file.path.slice(prefix.length)) || file.contentBase64 === undefined
      || inventory[file.path.slice(prefix.length)] !== file.digest) fail("ModuleSet inventory member/hash differs.");
    const allText = members.every(file => {
      const bytes = Buffer.from(file.contentBase64 ?? "", "base64");
      return !bytes.includes(0) && Buffer.from(bytes.toString("utf8")).equals(bytes);
    });
    if (allText) {
      loadModuleSet({ kind: "moduleSet", enabled: false, manifest: value,
        files: Object.fromEntries(members.map(file => [file.path.slice(prefix.length),
          text(Buffer.from(file.contentBase64 ?? "", "base64"))])) });
    } else {
      if (value.schema !== "pkm.action.module-set/v1" || !Array.isArray(value.actions)
        || value.actions.length > ACTION_COMPILER_LIMITS.moduleActions || new Set(value.actions).size !== value.actions.length
        || files.length > ACTION_COMPILER_LIMITS.moduleFiles
        || value.package_hash !== originalDigest(Object.fromEntries(Object.entries(value).filter(([name]) => name !== "package_hash"))))
        fail("Invalid immutable binary ModuleSet manifest/hash.");
      for (const actionId of value.actions) {
        if (!actionIdValid(actionId) || actionBuiltinId(actionId) || actionId in actionComponents()
          || /^(core|system)(?:\.|$)/i.test(actionId))
          fail("Invalid binary ModuleSet Action identity.");
        const definition = members.find(file => file.path === `${prefix}definitions/${actionId}.json`);
        if (!definition) fail("Binary ModuleSet definition is missing.");
        validateEntity([{ ...definition, path: `actions/${actionId}.json`, type: "actions", itemId: actionId,
          member: "", category: "" }]);
      }
      const resources = record(value.resources ?? {});
      for (const [actionId, raw] of Object.entries(resources)) {
        if (!value.actions.includes(actionId)) fail("Binary ModuleSet resource owner is missing.");
        for (const [reference, member] of Object.entries(record(raw))) {
          if (!validResourceReference(reference) || typeof member !== "string" || !member.startsWith("assets/")
            || !safeModuleMember(member) || !(member in inventory)) fail("Binary ModuleSet resource is outside its exact inventory.");
        }
      }
    }
    return;
  }
  if (files.length !== 1 || first.member) fail("Typed metadata requires one primary record.");
  const value = json(first);
  noCredentials(value);
  if (first.type === "actions") {
    const { knowledgeId, ...definition } = value;
    if (first.path !== `actions/${first.itemId}.json` || value.action_id !== first.itemId
      || first.category || actionBuiltinId(first.itemId) || /^(core|system)(?:\.|$)/i.test(first.itemId)
      || knowledgeId !== undefined && (typeof knowledgeId !== "string" || !/^action_[a-f0-9]{24}$/.test(knowledgeId))
      || actionDefinitionDiagnostics(definition).length) fail("Action definition identity or schema differs.");
  } else if (first.type === "recipes") {
    const parsed = projectRecipeSchema.safeParse(value);
    if (!parsed.success) fail("Recipe source is not a portable typed definition record.");
    validateRecipeRecord(parsed.data);
    const category = path.posix.dirname(first.path).slice("recipes/".length).replace(/^Uncategorized$/, "");
    if (value.recipeId !== first.itemId || !first.path.endsWith(`.${first.itemId}.json`)
      || (value.category ?? "") !== category || first.category !== category || typeof value.name !== "string"
      || normalizeRecipeCategory(category) !== category || value.trashedAt || value.systemKind)
      fail("Recipe source definition, executable digest or identity differs.");
  } else if (first.type === "profiles") {
    validatePersona(value);
    if (first.path !== portablePersonaPath(value) || first.privacy !== "private"
      || first.itemId !== `${value.kind}/${value.id}` || first.category !== value.kind)
      fail("Private Profile card path or typed identity differs.");
  }
}
export function validateSyncContentState(files: File[], deletion?: Deletion): void {
  if (files.length) validateEntity(files);
  if (!deletion) return;
  if (githubSyncSafeRelativePath(deletion.itemId) !== deletion.itemId || deletion.itemId.includes("\\")
    || deletion.category && githubSyncSafeRelativePath(deletion.category) !== deletion.category)
    fail("Tombstone identity or category is not portable.");
  if (deletion.type === "actions" && (actionBuiltinId(deletion.itemId) || /^(core|system)(?:\.|$)/i.test(deletion.itemId)))
    fail("System Action tombstones cannot be synchronized.");
  if (deletion.type === "agentSnapshots") syncContentPath("agentSnapshots/deletion.json", deletion.type);
  if (!knowledge.has(deletion.type) && (deletion.category === undefined || deletion.privacy === undefined))
    fail("Typed tombstone requires explicit category and privacy.");
  if (deletion.type === "profiles" && (deletion.privacy !== "private"
    || !/^(user|agent)\/[a-f0-9-]{36}$/.test(deletion.itemId))) fail("Invalid private Profile tombstone.");
  if (deletion.type === "action-module-sets" && !/^[a-z][a-z0-9_.-]{2,100}\/[1-9][0-9]*$/.test(deletion.itemId))
    fail("Invalid immutable ModuleSet tombstone.");
}
export function syncContentReview(request: {
  actorId: string; sessionId: string; input: SyncPlanInput;
}, entities: Array<{ type: File["type"]; itemId: string }>): SyncContentReview {
  const privileged = entities.filter(entity => !knowledge.has(entity.type));
  return {
    actorId: request.actorId, sessionId: request.sessionId,
    sourcePins: { base: request.input.base.sha256, local: request.input.local.sha256, remote: request.input.remote.sha256 },
    sourceSha256: syncPlanHash(request.input),
    entities: [...new Map(privileged.map(entity => [key(entity), entity])).values()].sort((a, b) => key(a).localeCompare(key(b))),
  };
}
export function assertSyncContentAuthority(authority: SyncContentAuthority | undefined, request: {
  actorId: string; sessionId: string; input: SyncPlanInput;
}, entities: Array<{ type: File["type"]; itemId: string }>, root?: string): void {
  const review = syncContentReview(request, entities);
  if (!review.entities.length) return;
  if (!authority || authority.actorId !== request.actorId || !authority.epoch
    || !/^[a-f0-9]{64}$/.test(authority.profileSha256) || !path.isAbsolute(authority.root)
    || root !== undefined && authority.root !== root || typeof authority.assertCurrent !== "function")
    throw new CoreError("ACCESS_DENIED", "Typed Sync content requires current native root/profile/epoch and exact source approval.");
  const result = authority.assertCurrent(review) as unknown;
  if (result !== undefined) {
    if (result && (typeof result === "object" || typeof result === "function") && "then" in result)
      void Promise.resolve(result).catch(() => {});
    throw new CoreError("ACCESS_DENIED", "Current native Sync source approval must be a synchronous assertion, not a boolean or asynchronous grant.");
  }
}
