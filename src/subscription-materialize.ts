import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { z } from "zod";
import { CoreError, documentId } from "./contracts.js";
import { documentPath, resourcePath } from "./document-path.js";
import { legacyKnowledgeAlias } from "./domain/knowledge-contracts.js";
import { localAssetReference, markdownAssetDirectory, markdownReferences } from "./domain/markdown-assets.js";
import { forkRootName } from "./domain/subscription-materialize-original-fork.js";
import { hash, safeRelativePath } from "./domain/subscription-materialize-original-worker.js";
import { sha256 } from "./file-write.js";
import { decodeMarkdown, scanMarkdown } from "./markdown.js";
import { subscriptionMaterializeInput, subscriptionMaterializeResultSchema, subscriptionMaterializeLimits as limits, type SubscriptionMaterializeInput, type SubscriptionMaterializePreview, type SubscriptionMaterializeResult } from "./subscription-materialize-contracts.js";

export { subscriptionMaterializeDefinitions, subscriptionMaterializeLimits } from "./subscription-materialize-contracts.js";
type Source = SubscriptionMaterializeInput["source"];
/** Authorization must be derived from a trusted host policy, never a request-supplied role. */
export type SubscriptionMaterializePolicy = (actorId: string, source: Readonly<Source>, action: "fork") => boolean;
export interface SubscriptionMaterializeChange {
  area: SubscriptionMaterializeInput["area"]; path: string; beforeSha256: null; afterSha256: string;
  afterBase64: string;
}
export interface SubscriptionMaterializePlan {
  kind: "subscription-materialize/v1"; operationId: string; actorId: string;
  source: Source; snapshotSha256: string; workspaceRevision: string;
  changes: SubscriptionMaterializeChange[]; result: SubscriptionMaterializeResult;
  requiresCompoundJournal: true; planSha256: string;
}
const actor = z.string().min(1).max(256).refine(v => !/[\u0000-\u001f]/.test(v));
const digest = /^[a-f0-9]{64}$/;
function fail(code: string, message: string): never { throw new CoreError(code, message); }
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail("INVALID_ARGUMENT", "Invalid materialization contract.");
  return parsed.data;
}
function missing(e: unknown) { return e instanceof Error && "code" in e && e.code === "ENOENT"; }
function rootCheck(root: string) {
  const full = resolve(root);
  for (let current = full; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_WORKSPACE", "Root and ancestors must be real directories.");
    if (dirname(current) === current) break;
  }
  return full;
}
function entry(root: string, area: string, path: string) {
  let current = root;
  for (const component of [area, ...path.split("/")]) {
    const folded = component.normalize("NFC").toLocaleLowerCase("en-US");
    if (readdirSync(current).some(name => name !== component && name.normalize("NFC").toLocaleLowerCase("en-US") === folded)) fail("CONFLICT", "Destination collides with existing portable path.");
    current = join(current, component);
    let stat;
    try { stat = lstatSync(current); } catch (e) { if (missing(e)) return undefined; throw e; }
    if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) fail("CONFLICT", "Linked or special destination entry.");
    if (current !== join(root, area, ...path.split("/")) && !stat.isDirectory()) fail("CONFLICT", "Destination ancestor is not a directory.");
  }
  return lstatSync(current);
}
function boundedWorkspace(root: string) {
  function walk(dir: string, depth: number) {
    if (depth > limits.depth) fail("INVALID_WORKSPACE", "Workspace depth limit exceeded.");
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) fail("INVALID_WORKSPACE", "Workspace contains linked or special entries.");
      if (stat.isDirectory()) walk(path, depth + 1);
    }
  }
  for (const area of ["notes", "skills", "papers"]) {
    try {
      const path = join(root, area), stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_WORKSPACE", "Workspace area must be a real directory.");
      walk(path, 0);
    } catch (e) { if (!missing(e) || area === "notes") throw e; }
  }
}
function workspace(root: string) {
  boundedWorkspace(root);
  const documents = scanMarkdown(root);
  const revision = sha256(JSON.stringify(documents.map(d => [d.record.area, d.record.path, d.record.id, d.record.sha256])));
  return { documents, revision };
}
function key(area: string, path: string) {
  return legacyKnowledgeAlias(area === "skills" ? "skill" : area === "papers" ? "research" : "note", path);
}
function validPath(path: unknown, document = false): string {
  if (typeof path !== "string" || !(document ? documentPath : resourcePath).safeParse(path).success
    || safeRelativePath(path) !== path || path.split("/").length > limits.depth
    || path.split("/").some(part => part.toLowerCase() === "system")) fail("INVALID_DOCUMENT", "Unsafe or normalized source path.");
  return path;
}
function names(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(x => typeof x !== "string")) fail("INVALID_DOCUMENT", "Invalid source aliases.");
  return value;
}
function snapshotDocuments(input: SubscriptionMaterializeInput) {
  if (Buffer.from(input.snapshot).toString("utf8") !== input.snapshot
    || input.area !== "notes" && Buffer.byteLength(input.snapshot) > limits.snapshotBytes
    || hash(input.snapshot) !== input.source.collectionHash) fail("CONFLICT", "Original collection digest mismatch.");
  let bundle: Record<string, unknown>;
  try { bundle = JSON.parse(input.snapshot) as Record<string, unknown>; } catch { fail("INVALID_DOCUMENT", "Snapshot is not JSON."); }
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) fail("INVALID_DOCUMENT", "Snapshot must be an object.");
  const raw = bundle[input.area] ?? [];
  if (!Array.isArray(raw)) fail("INVALID_DOCUMENT", "Snapshot document collection must be an array.");
  if (input.area !== "notes" && raw.length > limits.documents) fail("INVALID_DOCUMENT", "Snapshot document count exceeds limit.");
  const docs = new Map<string, string>();
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_DOCUMENT", "Invalid snapshot document.");
    const item = value as Record<string, unknown>;
    const meta = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata) ? item.metadata as Record<string, unknown> : {};
    let path: string;
    if (input.area === "skills") {
      if (typeof item.name !== "string" || (meta.category !== undefined && typeof meta.category !== "string")) fail("INVALID_DOCUMENT", "Skill source path requires explicit name/category.");
      path = `${meta.category ? `${meta.category}/` : ""}${item.name}.md`;
    } else if (input.area === "notes") {
      if (typeof (item.slug || item.title) !== "string") fail("INVALID_DOCUMENT", "Note source path requires explicit slug/title.");
      path = `${item.slug || item.title}.md`;
    } else {
      if (typeof (item.slug || item.title) !== "string" || (item.category !== undefined && typeof item.category !== "string")) fail("INVALID_DOCUMENT", "Paper source path requires explicit slug/title.");
      path = `${item.slug || [item.category, item.title].filter(Boolean).join("/")}.md`;
    }
    validPath(path, true);
    if (typeof item.content !== "string" || Buffer.from(item.content).toString("utf8") !== item.content
      || input.area !== "notes" && Buffer.byteLength(item.content) > limits.markdownBytes
      || docs.has(path)) fail("INVALID_DOCUMENT", "Missing, invalid or duplicate Markdown.");
    docs.set(path, item.content);
  }
  const assets = new Map<string, Buffer>();
  const rawAssets = bundle.assets ?? [];
  if (!Array.isArray(rawAssets) || rawAssets.length > limits.assets) fail("INVALID_DOCUMENT", "Snapshot asset count exceeds limit.");
  for (const value of rawAssets) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_DOCUMENT", "Invalid snapshot asset.");
    const asset = value as Record<string, unknown>;
    if (!["notes", "skills", "papers"].includes(String(asset.type))) fail("INVALID_DOCUMENT", "Invalid asset area.");
    const path = validPath(asset.path);
    if (!path.split("/").some(part => part === "_assets" || part.toLowerCase().endsWith(".assets"))) fail("INVALID_DOCUMENT", "Invalid Markdown asset path.");
    if (typeof asset.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) fail("INVALID_DOCUMENT", "Invalid asset base64.");
    const bytes = Buffer.from(asset.data, "base64");
    if (bytes.length > limits.assetBytes || hash(bytes) !== asset.digest) fail("CONFLICT", "Asset digest or size mismatch.");
    if (asset.type === input.area) {
      if (assets.has(path)) fail("INVALID_DOCUMENT", "Duplicate asset path.");
      assets.set(path, bytes);
    }
  }
  return { docs, assets };
}
function prepare(root: string, value: unknown, actorId: string, policy: SubscriptionMaterializePolicy) {
  const input = parse(subscriptionMaterializeInput, value);
  parse(actor, actorId);
  if (typeof policy !== "function" || policy(actorId, Object.freeze({ ...input.source }), "fork") !== true) fail("ACCESS_DENIED", "Trusted source policy denied fork.");
  root = rootCheck(root);
  const snapshot = snapshotDocuments(input), current = workspace(root);
  const selected = [...new Set(input.paths)].sort();
  if (selected.length !== input.paths.length) fail("INVALID_ARGUMENT", "Duplicate selected paths.");
  const folk = forkRootName(input.source.brokerName, input.source.publisherUser, input.source.publisherHost);
  validPath(folk);
  const usedIds = new Set<string>(), usedAliases = new Set<string>();
  for (const doc of current.documents) {
    usedIds.add(doc.record.id);
    const id = doc.metadata.get("knowledgeId");
    if (typeof id === "string") usedIds.add(id);
    const data = doc.metadata.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
    for (const alias of [...names(data.aliases), key(doc.record.area, doc.record.path)]) usedAliases.add(alias);
  }
  const mappings: SubscriptionMaterializePreview["mappings"] = [], changes: SubscriptionMaterializeChange[] = [];
  const needed = new Set<string>();
  let totalBytes = 0;
  for (const path of selected) {
    const raw = snapshot.docs.get(path);
    if (raw === undefined) fail("NOT_FOUND", "Selected document missing from snapshot.");
    const dest = validPath(`${folk}/${path}`, true);
    if (entry(root, input.area, dest)) fail("CONFLICT", "Destination already exists.");
    const implicit = `legacy_${sha256(input.area === "notes" ? dest : `${input.area}/${dest}`).slice(0, 32)}`;
    const doc = decodeMarkdown(implicit, raw, dest, input.area);
    const metadata = doc.metadata.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
    if (metadata.deleted === true || metadata.memory !== undefined || metadata.documentKind === "todo-board" || posix.basename(path).toLowerCase() === "todo board.md") fail("ACCESS_DENIED", "Deleted, memory and Todo authority require dedicated migration.");
    const prototype = metadata.schema === "pkm.knowledge/v1" && metadata.revision !== undefined && metadata.deleted !== undefined
      ? [...new Set(names(metadata.aliases).filter(a => a.startsWith("note:") && documentId.safeParse(a.slice(5)).success).map(a => a.slice(5)))] : [];
    const explicit = metadata.documentId ?? (prototype.length === 1 ? prototype[0] : metadata.knowledgeId);
    if (explicit !== undefined && !documentId.safeParse(explicit).success) fail("INVALID_DOCUMENT", "Invalid explicit document identity.");
    const identity = typeof explicit === "string" ? explicit : null;
    const ids = new Set([identity ?? implicit, ...(typeof metadata.knowledgeId === "string" ? [metadata.knowledgeId] : [])]);
    for (const id of ids) { if (usedIds.has(id)) fail("CONFLICT", "Document identity already owned."); usedIds.add(id); }
    const aliases = names(metadata.aliases);
    const destAlias = key(input.area, dest);
    for (const alias of new Set([...aliases, destAlias])) {
      if (usedAliases.has(alias)) fail("CONFLICT", "Document alias already owned.");
      usedAliases.add(alias);
    }
    for (const ref of markdownReferences(raw)) {
      const local = localAssetReference(ref.value);
      if (!local) {
        if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref.value) && /(?:_assets|\.assets)/i.test(ref.value)) fail("INVALID_DOCUMENT", "Unresolvable asset reference.");
        continue;
      }
      if (local.startsWith("/")) fail("INVALID_DOCUMENT", "Absolute encoded source reference.");
      const target = posix.normalize(posix.join(posix.dirname(path), local));
      if (target === ".." || target.startsWith("../") || target.startsWith("/")) fail("INVALID_DOCUMENT", "Reference escapes source area.");
      if (target.split("/").some(part => part === "_assets" || part.toLowerCase().endsWith(".assets"))) {
        validPath(target);
        if (!snapshot.assets.has(target)) fail("INCOMPLETE", `Referenced asset missing: ${target}`);
        const segments = target.split("/"), index = segments.findIndex(part => part.toLowerCase().endsWith(".assets"));
        if (index >= 0) {
          const owner = [...segments.slice(0, index), segments[index]!.slice(0, -7) + ".md"].join("/");
          if (!selected.includes(owner)) fail("INCOMPLETE", "Paired asset owner must be selected.");
        }
        needed.add(target);
      } else if (!selected.includes(target)) {
        fail("INCOMPLETE", `Relative target not selected: ${target}`);
      }
    }
    for (const asset of snapshot.assets.keys()) if (asset.startsWith(markdownAssetDirectory(path) + "/")) needed.add(asset);
    const bytes = Buffer.from(raw);
    totalBytes += bytes.length;
    mappings.push({ sourcePath: path, destinationPath: dest, identity, aliases, sourceAlias: key(input.area, path), destinationAlias: destAlias, sha256: sha256(bytes) });
    changes.push({ area: input.area, path: dest, beforeSha256: null, afterSha256: sha256(bytes), afterBase64: bytes.toString("base64") });
  }
  const assets: SubscriptionMaterializePreview["assets"] = [];
  for (const path of [...needed].sort()) {
    const bytes = snapshot.assets.get(path)!;
    if (posix.basename(path).toLowerCase() === "pkm-todo-board.json") fail("ACCESS_DENIED", "Todo backing authority requires dedicated migration.");
    const dest = validPath(`${folk}/${path}`);
    if (entry(root, input.area, dest)) fail("CONFLICT", "Asset destination already exists.");
    totalBytes += bytes.length;
    assets.push({ sourcePath: path, destinationPath: dest, sha256: sha256(bytes), size: bytes.length });
    changes.push({ area: input.area, path: dest, beforeSha256: null, afterSha256: sha256(bytes), afterBase64: bytes.toString("base64") });
  }
  const folded = new Set<string>();
  for (const change of changes) {
    const foldedPath = change.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (folded.has(foldedPath)) fail("CONFLICT", "Destination paths collide on a case-insensitive filesystem.");
    folded.add(foldedPath);
  }
  for (const path of folded) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (folded.has(parts.slice(0, i).join("/"))) fail("CONFLICT", "A destination file is also a parent directory.");
  }
  if (input.area !== "notes" && totalBytes > limits.totalBytes) fail("INVALID_DOCUMENT", "Materialization byte limit exceeded.");
  changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const preview: SubscriptionMaterializePreview = { source: input.source, area: input.area, forkRoot: folk, snapshotSha256: sha256(input.snapshot), workspaceRevision: current.revision, mappings, assets, totalBytes, destinationAbsent: true };
  return { preview, changes };
}

export function previewSubscriptionMaterialize(root: string, input: unknown, actorId: string, policy: SubscriptionMaterializePolicy): SubscriptionMaterializePreview {
  return prepare(root, input, actorId, policy).preview;
}
export function planSubscriptionMaterialize(root: string, input: unknown, actorId: string, policy: SubscriptionMaterializePolicy, operationId: string, expectedWorkspaceRevision: string): SubscriptionMaterializePlan {
  parse(z.string().uuid(), operationId);
  const { preview, changes } = prepare(root, input, actorId, policy);
  if (preview.workspaceRevision !== expectedWorkspaceRevision) fail("CONFLICT", "Workspace changed since preview.");
  const result = { ...preview, operationId, actorId };
  const body = { kind: "subscription-materialize/v1" as const, operationId, actorId, source: preview.source, snapshotSha256: preview.snapshotSha256, workspaceRevision: preview.workspaceRevision, changes, result, requiresCompoundJournal: true as const };
  return { ...body, planSha256: sha256(JSON.stringify(body)) };
}

/** Pure recovery decision; caller reads every destination with no-follow under the shared lock. */
export function recoverSubscriptionMaterialize(plan: SubscriptionMaterializePlan, actorId: string, operationId: string, observed: Array<string | null>) {
  if (!plan || plan.kind !== "subscription-materialize/v1" || !z.string().uuid().safeParse(operationId).success
    || !actor.safeParse(actorId).success || plan.actorId !== actorId || plan.operationId !== operationId
    || !Array.isArray(plan.changes) || plan.changes.length < 1 || plan.changes.length > limits.documents + limits.assets
    || !Array.isArray(observed) || observed.length !== plan.changes.length) fail("RECOVERY_CONFLICT", "Invalid recovery identity or state vector.");
  const { planSha256, ...body } = plan;
  if (!digest.test(planSha256) || sha256(JSON.stringify(body)) !== planSha256 || plan.requiresCompoundJournal !== true
    || !subscriptionMaterializeResultSchema.safeParse(plan.result).success
    || plan.result?.operationId !== operationId || plan.result?.actorId !== actorId
    || plan.snapshotSha256 !== plan.result?.snapshotSha256 || plan.workspaceRevision !== plan.result?.workspaceRevision
    || JSON.stringify(plan.source) !== JSON.stringify(plan.result?.source)) fail("RECOVERY_CONFLICT", "Serialized intent integrity mismatch.");
  const expected = new Map<string, { sha256: string; size?: number }>();
  for (const item of plan.result.mappings) {
    if (expected.has(item.destinationPath)) fail("RECOVERY_CONFLICT", "Duplicate result paths.");
    expected.set(item.destinationPath, { sha256: item.sha256 });
  }
  for (const item of plan.result.assets) {
    if (expected.has(item.destinationPath)) fail("RECOVERY_CONFLICT", "Duplicate result paths.");
    expected.set(item.destinationPath, { sha256: item.sha256, size: item.size });
  }
  if (expected.size !== plan.changes.length) fail("RECOVERY_CONFLICT", "Intent/result paths differ.");
  let beforeSeen = false, completed = 0, previous = "", size = 0;
  for (let i = 0; i < plan.changes.length; i++) {
    const change = plan.changes[i]!;
    if (!change || change.area !== plan.result.area || !resourcePath.safeParse(change.path).success || change.path <= previous
      || !change.path.startsWith(plan.result.forkRoot + "/") || change.beforeSha256 !== null || !digest.test(change.afterSha256)
      || typeof change.afterBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(change.afterBase64)) fail("RECOVERY_CONFLICT", "Invalid persisted change.");
    const bytes = Buffer.from(change.afterBase64, "base64");
    const item = expected.get(change.path);
    size += bytes.length;
    if (!item || item.sha256 !== change.afterSha256 || (item.size !== undefined && item.size !== bytes.length)
      || plan.result.area !== "notes" && size > limits.totalBytes || sha256(bytes) !== change.afterSha256) fail("RECOVERY_CONFLICT", "Persisted bytes mismatch.");
    previous = change.path;
    if (observed[i] === null) beforeSeen = true;
    else if (!beforeSeen && observed[i] === change.afterSha256) completed++;
    else fail("RECOVERY_CONFLICT", "Unknown or out-of-order state; preserve intent.");
  }
  if (size !== plan.result.totalBytes) fail("RECOVERY_CONFLICT", "Intent total differs from result.");
  return { completed, remaining: plan.changes.slice(completed), result: plan.result };
}
