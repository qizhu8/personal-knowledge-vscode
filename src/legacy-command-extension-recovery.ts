import type { DatabaseSync } from "node:sqlite";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { sha256 } from "./file-write.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { projectMutationPlanSchema } from "./project-mutations-contracts.js";
import { applyProjectMutation, deserializeProjectMutationPlan, planProjectMutation } from "./project-mutations.js";
import type { ProjectMutationRequest } from "./project-mutations-contracts.js";
import { legacyProjectDomainDigest, readCurrentLegacyProjectSnapshot, readLegacyProjectControl,
  type LegacyProjectDomain } from "./legacy-control-import.js";
import { LegacyExtensionJournalError, stageLegacyExtensionIntent, finalizeLegacyExtensionIntent,
  legacyExtensionEnvelopeSchema, type LegacyExtensionEnvelope } from "./legacy-command-extension-journal.js";
import { scanMarkdown } from "./markdown.js";
import {
  inspectLegacyProjectThreadEffect, recoverLegacyProjectThreadEffect, serializeLegacyProjectThreadEffect,
  type LegacyProjectThreadEffect,
} from "./legacy-project-thread-parity.js";
import { stageLegacyProjectThreadIntent } from "./legacy-command-extension-journal.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const fileSchema = z.strictObject({
  path: z.string().min(1).max(2048), sha256: digest, base64: z.string().max(2_796_204),
});
const extensionSchema = z.strictObject({
  schema: z.literal("pkm.legacy-command-extension/v1"),
  plan: projectMutationPlanSchema,
  before: z.array(fileSchema).max(4096),
  beforeDigest: digest,
  rootId: z.string().min(1).max(4096),
});
const threadExtensionSchema = z.strictObject({
  schema: z.literal("pkm.legacy-project-thread-extension/v1"),
  effect: z.unknown(),
  before: z.array(fileSchema).max(4096),
  beforeDigest: digest,
  rootId: z.string().min(1).max(4096),
});
type ThreadExtensionEffectPlan = z.infer<typeof threadExtensionSchema> & { effect: LegacyProjectThreadEffect };
type AnyExtensionEffectPlan = LegacyExtensionEffectPlan | ThreadExtensionEffectPlan;
export type LegacyExtensionEffectPlan = z.infer<typeof extensionSchema>;
const mapping = { "project-archive": "project.archive", "recipe-create": "project.recipe.create",
  "recipe-update": "project.recipe.update" } as const;
const journalDDL = `CREATE TABLE IF NOT EXISTS legacy_command_extension_intent(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    operation_id TEXT NOT NULL UNIQUE,
    effect_plan TEXT NOT NULL CHECK(typeof(effect_plan)='text'),
    effect_sha256 TEXT NOT NULL CHECK(length(effect_sha256)=64 AND effect_sha256 NOT GLOB '*[^0-9a-f]*'))`;
const journalRowSchema = z.strictObject({
  singleton: z.literal(1), operation_id: z.string().uuid(),
  effect_plan: z.string().max(16 * 1024 * 1024), effect_sha256: digest,
});
function fail(message: string): never {
  throw new LegacyExtensionJournalError("CONTROL_RECOVERY_CONFLICT", message);
}
function outsideSQL(db: DatabaseSync): void {
  if (db.isTransaction) throw new LegacyExtensionJournalError("FILESYSTEM_TRANSACTION_FORBIDDEN", "Filesystem work must be outside SQL transactions.");
}
function validRelativePath(path: string): void {
  if (!/^(project|recipes)\//.test(path) || path.includes("\\")
    || path.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".")
      || /[:\u0000-\u001f\u007f]/.test(part))) fail("Invalid manifest path.");
}
function safePath(root: string, path: string): string {
  validRelativePath(path);
  const target = join(resolve(root), ...path.split("/"));
  for (let parent = target;; parent = dirname(parent)) {
    try { if (lstatSync(parent).isSymbolicLink()) fail("Manifest path traverses a symlink."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(parent) === parent) break;
  }
  return target;
}

export function assertLegacyExtensionRoot(db: DatabaseSync, root: string, workspaceId: string): void {
  outsideSQL(db);
  const databases = db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>;
  const main = databases.find(item => item.name === "main");
  if (!main?.file || dirname(resolve(main.file)) !== resolve(root)) fail("Extension root differs from the native SQLite workspace.");
  safePath(root, "project/placeholder");
  const markerPath = join(root, ".pkm-next-workspace");
  const stat = lstatSync(markerPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) fail("Invalid workspace marker.");
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { schema?: string; id?: string };
  if (marker.schema !== "pkm.next-workspace/v2" || marker.id !== workspaceId) fail("Extension workspace marker differs from command admission.");
}
function manifest(root: string): LegacyExtensionEffectPlan["before"] {
  const result: LegacyExtensionEffectPlan["before"] = [];
  const portable = new Set<string>();
  let total = 0, entries = 0;
  function walk(path: string, depth: number): void {
    if (++entries > 8192 || depth > 32) fail("Manifest exceeds bounded inspection limits.");
    const key = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (portable.has(key)) fail("Portable path collision.");
    portable.add(key);
    const target = safePath(root, path + (path.includes("/") ? "" : "/placeholder"));
    const absolute = path.includes("/") ? target : join(root, path);
    let stat;
    try { stat = lstatSync(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && depth === 0) return; throw error; }
    if (stat.isDirectory()) {
      for (const child of readdirSync(absolute).sort()) walk(`${path}/${child}`, depth + 1);
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) fail("Unsupported manifest entry.");
    const bytes = readFileSync(absolute);
    const after = lstatSync(absolute);
    if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size || bytes.length !== stat.size) fail("File changed during inspection.");
    total += bytes.length;
    if (total > 8 * 1024 * 1024 || result.length >= 4096) fail("Manifest exceeds bounded byte limits.");
    result.push({ path, sha256: sha256(bytes), base64: bytes.toString("base64") });
  }
  walk("project", 0); walk("recipes", 0);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/** Additional journal metadata is explicit, schema-versioned, and backup-visible. */
export function initializeLegacyExtensionJournal(db: DatabaseSync): void {
  if (!db.isTransaction) throw new LegacyExtensionJournalError("TRANSACTION_REQUIRED", "Initialize the extension journal in the host migration transaction.");
  db.exec(journalDDL);
  validateLegacyExtensionJournalSchema(db);
}

export function validateLegacyExtensionJournalSchema(db: DatabaseSync): void {
  const actual = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='legacy_command_extension_intent'")
    .get() as { sql: string } | undefined;
  const normalized = (sql: string) => sql.replace("IF NOT EXISTS ", "").replace(/\s+/g, " ").trim();
  if (!actual || normalized(actual.sql) !== normalized(journalDDL)) fail("Extension journal schema is unrecognized.");
}

export function compileLegacyExtensionEffectPlan(db: DatabaseSync, root: string, envelope: LegacyExtensionEnvelope,
  args: ProjectMutationRequest["args"]): LegacyExtensionEffectPlan {
  envelope = legacyExtensionEnvelopeSchema.parse(envelope);
  outsideSQL(db);
  assertLegacyExtensionRoot(db, root, envelope.workspaceId);
  const operation = mapping[envelope.command.operation as keyof typeof mapping];
  if (!operation) throw new LegacyExtensionJournalError("LEGACY_COMMAND_UNSUPPORTED", "No concrete extension effect compiler.");
  const before = manifest(root);
  if (operation.startsWith("project.recipe.")) {
    for (const file of before.filter(item => item.path.startsWith("recipes/"))) {
      const recipe = JSON.parse(Buffer.from(file.base64, "base64").toString("utf8")) as {
        recipeId?: string; aliases?: string[];
      };
      const aliases = recipe.aliases ?? [];
      if (!aliases.includes(`recipe:${recipe.recipeId}`) || !aliases.includes(`recipe:${file.path.slice("recipes/".length)}`)
        || aliases.some(alias => !/^(note|skill|research|recipe):[^\u0000-\u001f]+$/.test(alias))
        || canonicalJson(aliases) !== canonicalJson([...new Set(aliases)].sort())) {
        throw new LegacyExtensionJournalError("LEGACY_RECIPE_CANONICALIZATION_REQUIRED",
          "Original Recipe store would repair unrelated aliases; normalize the export before bounded command execution.");
      }

    }
  }
  const snapshot = readCurrentLegacyProjectSnapshot(db, envelope.workspaceId);
  const current = readLegacyProjectControl(db, envelope.workspaceId);
  if (!current || legacyProjectDomainDigest(snapshot) !== current.canonicalDigest) fail("Canonical before-state is not authenticated.");
  const plan = planProjectMutation(root, { operation, args: { ...args, operationId: envelope.operationId },
    actorId: envelope.actorId }, scanMarkdown(root));
  for (const file of plan.files) {
    if (file.afterBase64 === null) continue;
    const item = JSON.parse(Buffer.from(file.afterBase64, "base64").toString("utf8")) as Record<string, unknown>;
    let content: string;
    if (operation === "project.archive") content = canonicalJson(item);
    else {
      let stored = JSON.parse(canonicalJson(item)) as Record<string, unknown>;
      if (operation === "project.recipe.create") {
        const { schema, knowledgeId, aliases, ...originalRecord } = item;
        stored = { ...JSON.parse(canonicalJson(originalRecord)) as Record<string, unknown>, schema, knowledgeId, aliases };
      }
      content = `${JSON.stringify(stored, null, 2)}\n`;
    }
    const bytes = Buffer.from(content, "utf8");
    file.afterBase64 = bytes.toString("base64");
    file.afterSha256 = sha256(bytes);
  }
  if (canonicalJson(before) !== canonicalJson(manifest(root))) fail("Workspace changed during planning.");
  return validateLegacyExtensionEffectPlan({ schema: "pkm.legacy-command-extension/v1", plan, before,
    beforeDigest: current.canonicalDigest, rootId: current.rootId });
}

export function compileLegacyProjectThreadExtensionEffect(db: DatabaseSync, root: string,
  envelope: LegacyExtensionEnvelope, input: LegacyProjectThreadEffect): ThreadExtensionEffectPlan {
  envelope = legacyExtensionEnvelopeSchema.parse(envelope);
  outsideSQL(db);
  assertLegacyExtensionRoot(db, root, envelope.workspaceId);
  const effect = JSON.parse(serializeLegacyProjectThreadEffect(input)) as LegacyProjectThreadEffect;
  const current = readLegacyProjectControl(db, envelope.workspaceId);
  const before = manifest(root);
  const beforeDigest = legacyProjectDomainDigest({ ...effect.beforeDomain, storeVersion: effect.expectedStoreVersion });
  if (!current || current.rootId !== effect.rootId || current.storeVersion !== effect.expectedStoreVersion
    || current.canonicalDigest !== beforeDigest || effect.workspaceId !== envelope.workspaceId
    || effect.actorId !== envelope.actorId || effect.operationId !== envelope.operationId
    || effect.operation !== envelope.command.operation
    || canonicalJson(effect.command) !== canonicalJson(envelope.command)) {
    fail("Captured Project/Thread before-state differs from native command authority.");
  }
  const actual = readCurrentLegacyProjectSnapshot(db, envelope.workspaceId);
  if (legacyProjectDomainDigest(actual) !== beforeDigest) fail("Current Project control does not match the captured before-state.");
  for (const file of effect.files) {
    const pinned = before.find(item => item.path === file.relativePath);
    if ((pinned?.sha256 ?? null) !== file.beforeSha256 || (pinned?.base64 ?? null) !== file.beforeBase64) {
      fail("Project/Thread effect differs from the complete native before manifest.");
    }
  }
  const wrapper = parseThreadExtension({
    schema: "pkm.legacy-project-thread-extension/v1", effect, before, beforeDigest, rootId: effect.rootId,
  });
  if (canonicalJson(manifest(root)) !== canonicalJson(before)) fail("Workspace changed during captured Project/Thread planning.");
  return wrapper;
}

export function stageLegacyProjectThreadExtensionEffect(db: DatabaseSync, envelope: LegacyExtensionEnvelope,
  input: ThreadExtensionEffectPlan): void {
  if (!db.isTransaction) fail("Project/Thread extension staging requires the shared immediate SQL transaction.");
  envelope = legacyExtensionEnvelopeSchema.parse(envelope);
  const wrapper = parseThreadExtension(input);
  const effect = wrapper.effect;
  if (effect.workspaceId !== envelope.workspaceId || effect.actorId !== envelope.actorId
    || effect.operationId !== envelope.operationId || canonicalJson(effect.command) !== canonicalJson(envelope.command)) {
    fail("Captured Project/Thread effect identity changed before staging.");
  }
  const serialized = canonicalJson(wrapper);
  if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) fail("Project/Thread extension journal exceeds its bound.");
  stageLegacyProjectThreadIntent(db, envelope, effect, wrapper.beforeDigest);
  db.prepare("INSERT INTO legacy_command_extension_intent VALUES(1,?,?,?)")
    .run(envelope.operationId, serialized, sha256(serialized));
}

function parseThreadExtension(value: unknown): ThreadExtensionEffectPlan {
  const wrapper = threadExtensionSchema.parse(value);
  const effect = JSON.parse(serializeLegacyProjectThreadEffect(wrapper.effect as LegacyProjectThreadEffect)) as LegacyProjectThreadEffect;
  if (effect.rootId !== wrapper.rootId
    || legacyProjectDomainDigest({ ...effect.beforeDomain, storeVersion: effect.expectedStoreVersion }) !== wrapper.beforeDigest) {
    fail("Captured Project/Thread journal before-state binding changed.");
  }
  return { ...wrapper, effect };
}

function inspectThreadExtensionPending(db: DatabaseSync, root: string, envelope: LegacyExtensionEnvelope,
  raw: unknown, pending: Record<string, unknown> | undefined): { effect: ThreadExtensionEffectPlan; state: "before" | "after" | "mixed" | "unknown" } {
  const effect = parseThreadExtension(raw);
  if (!pending || pending.operation_id !== envelope.operationId || pending.actor_id !== envelope.actorId
    || pending.fingerprint !== envelope.globalFingerprint || pending.operation !== "project.legacy.command"
    || pending.legacy_command !== canonicalJson(envelope.command)
    || String(pending.plan) !== serializeLegacyProjectThreadEffect(effect.effect)) fail("Unrecognized Project/Thread extension envelope.");
  const control = readLegacyProjectControl(db, envelope.workspaceId);
  if (!control || control.rootId !== effect.rootId || control.canonicalDigest !== effect.beforeDigest
    || control.storeVersion !== envelope.command.expectedStoreVersion
    || control.receipts.some(item => item.commandId === envelope.command.commandId)) {
    fail("Project/Thread extension no longer matches original control admission.");
  }
  const actual = manifest(root), changed = new Set(effect.effect.files.map(file => file.relativePath));
  if (canonicalJson(actual.filter(file => !changed.has(file.path)))
    !== canonicalJson(effect.before.filter(file => !changed.has(file.path)))) {
    fail("Unaffected workspace bytes changed during Project/Thread extension.");
  }
  for (const file of effect.effect.files) {
    const current = actual.find(item => item.path === file.relativePath);
    const isBefore = (current?.sha256 ?? null) === file.beforeSha256 && (current?.base64 ?? null) === file.beforeBase64;
    const isAfter = (current?.sha256 ?? null) === file.afterSha256 && (current?.base64 ?? null) === file.afterBase64;
    if (!isBefore && !isAfter) fail("Project/Thread target matches neither recognized before nor after bytes.");
  }
  const state = inspectLegacyProjectThreadEffect(root, effect.effect).state;
  if (effect.effect.files.length === 0) {
    if (!["thread-rename", "thread-move"].includes(effect.effect.operation)
      || canonicalJson(effect.effect.beforeDomain) !== canonicalJson(effect.effect.afterDomain)) {
      fail("Empty Project/Thread effect does not describe an unchanged-domain command.");
    }
    return { effect, state: "after" };
  }
  return { effect, state };
}

export function validateLegacyExtensionEffectPlan(input: unknown): LegacyExtensionEffectPlan {
  const effect = extensionSchema.parse(input);
  deserializeProjectMutationPlan(effect.plan);
  if (!Object.values(mapping).includes(effect.plan.operation as typeof mapping[keyof typeof mapping])) fail("Unsupported effect operation.");
  const seen = new Set<string>();
  let total = 0;
  for (const file of effect.before) {
    validRelativePath(file.path);
    const key = file.path.normalize("NFC").toLocaleLowerCase("en-US");
    const bytes = Buffer.from(file.base64, "base64");
    if (seen.has(key) || bytes.toString("base64") !== file.base64 || sha256(bytes) !== file.sha256
      || bytes.length > 2 * 1024 * 1024) fail("Invalid before manifest.");
    seen.add(key); total += bytes.length;
  }
  if (total > 8 * 1024 * 1024) fail("Manifest exceeds bounded byte limits.");
  for (const file of effect.plan.files) {
    const prior = effect.before.find(item => item.path === file.relativePath);
    if ((prior?.sha256 ?? null) !== file.beforeSha256 || (prior?.base64 ?? null) !== file.beforeBase64) fail("Native effect differs from pinned before manifest.");
  }
  if (new Set(effect.plan.files.map(file => file.relativePath.normalize("NFC").toLocaleLowerCase("en-US"))).size !== effect.plan.files.length) {
    fail("Native effects have a portable target collision.");
  }
  if (legacyProjectDomainDigest(domainFromManifest(effect.before, effect.rootId, 1)) !== effect.beforeDigest) {
    fail("Before manifest does not authenticate the Project domain.");
  }
  return effect;
}

export function stageLegacyExtensionEffect(db: DatabaseSync, envelope: LegacyExtensionEnvelope,
  input: LegacyExtensionEffectPlan): void {
  const effect = validateLegacyExtensionEffectPlan(input);
  const serialized = canonicalJson(effect);
  if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) fail("Extension journal exceeds serialized limit.");
  stageLegacyExtensionIntent(db, envelope, effect.plan, effect.beforeDigest);
  db.prepare("INSERT INTO legacy_command_extension_intent VALUES(1,?,?,?)")
    .run(envelope.operationId, serialized, sha256(serialized));
}

/** Inspect every affected and unaffected file before any effect, including mixed rename states. */
export function inspectLegacyExtensionPending(db: DatabaseSync, root: string, envelope: LegacyExtensionEnvelope):
  { effect: AnyExtensionEffectPlan; state: "before" | "after" | "mixed" | "unknown" } {
  envelope = legacyExtensionEnvelopeSchema.parse(envelope);
  outsideSQL(db);
  assertLegacyExtensionRoot(db, root, envelope.workspaceId);
  validateLegacyExtensionJournalSchema(db);
  const rows = db.prepare("SELECT * FROM legacy_command_extension_intent").all();
  const parsed = journalRowSchema.safeParse(rows[0]);
  if (rows.length !== 1 || !parsed.success) fail("Extension journal row is unrecognized.");
  const row = parsed.data;
  const pending = db.prepare("SELECT * FROM pending_project_mutation WHERE singleton=1").get() as Record<string, unknown> | undefined;
  if (!pending || row.operation_id !== envelope.operationId || pending.operation_id !== envelope.operationId
    || pending.actor_id !== envelope.actorId || pending.fingerprint !== envelope.globalFingerprint
    || pending.operation !== "project.legacy.command" || pending.legacy_command !== canonicalJson(envelope.command)
    || sha256(String(row.effect_plan)) !== row.effect_sha256) fail("Unrecognized extension journal envelope.");
  if ((db.prepare("SELECT COUNT(*) AS count FROM pending_project_mutation").get() as { count: number }).count !== 1
    || db.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(envelope.operationId)) fail("Pending extension conflicts with global journal state.");
  for (const table of ["pending_write", "pending_todo", "pending_asset", "pending_resource",
    "pending_document_lifecycle", "data_runtime_intents", "migration_runtime_intents"]) {
    if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) fail("Another workspace intent prevents extension recovery.");
  }
  const rawEffect: unknown = JSON.parse(String(row.effect_plan));
  if (rawEffect && typeof rawEffect === "object" && (rawEffect as Record<string, unknown>).schema === "pkm.legacy-project-thread-extension/v1") {
    return inspectThreadExtensionPending(db, root, envelope, rawEffect, pending);
  }
  const effect = validateLegacyExtensionEffectPlan(rawEffect);
  if (canonicalJson(deserializeProjectMutationPlan(String(pending.plan))) !== canonicalJson(effect.plan)
    || effect.plan.operation !== mapping[envelope.command.operation as keyof typeof mapping]
    || effect.plan.workspaceId !== envelope.workspaceId || effect.plan.actorId !== envelope.actorId
    || effect.plan.operationId !== envelope.operationId) fail("Extension journal plan identities disagree.");
  const control = readLegacyProjectControl(db, envelope.workspaceId);
  if (!control || control.rootId !== effect.rootId || control.canonicalDigest !== effect.beforeDigest || control.storeVersion !== envelope.command.expectedStoreVersion
    || control.receipts.some(item => item.commandId === envelope.command.commandId)) fail("Extension journal no longer matches control admission.");
  const beforeDomain = domainFromManifest(effect.before, control.rootId, control.storeVersion);
  if (legacyProjectDomainDigest(beforeDomain) !== effect.beforeDigest) fail("Before manifest does not authenticate the Project domain.");
  const actual = manifest(root);
  const changed = new Set(effect.plan.files.map(file => file.relativePath));
  const unaffected = (files: typeof actual) => files.filter(file => !changed.has(file.path));
  if (canonicalJson(unaffected(actual)) !== canonicalJson(unaffected(effect.before))) fail("Unaffected workspace file changed.");
  const states = effect.plan.files.map(file => {
    const current = actual.find(item => item.path === file.relativePath);
    if ((current?.sha256 ?? null) === file.afterSha256 && (current?.base64 ?? null) === file.afterBase64) return "after";
    if ((current?.sha256 ?? null) === file.beforeSha256 && (current?.base64 ?? null) === file.beforeBase64) return "before";
    return fail("Target matches neither recognized before nor after bytes.");
  });
  for (const guard of effect.plan.guards) {
    const path = join(root, guard.relativePath);
    for (let parent = path;; parent = dirname(parent)) {
      try { if (lstatSync(parent).isSymbolicLink()) fail("Runtime guard traverses a symlink."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (dirname(parent) === parent) break;
    }
    let expected = sha256("missing\0");
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(path).length) fail("Runtime guard is not empty.");
      expected = sha256("directory\0");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (guard.sha256 !== expected) fail("Runtime guard changed.");
  }
  return { effect, state: states.every(state => state === "after") ? "after" as const
    : states.every(state => state === "before") ? "before" as const : "mixed" as const };
}

/** Startup may obtain the envelope, then invoke the same all-files inspector before recovery. */
export function readLegacyExtensionPendingEnvelope(db: DatabaseSync): LegacyExtensionEnvelope | undefined {
  validateLegacyExtensionJournalSchema(db);
  const rows = db.prepare("SELECT * FROM legacy_command_extension_intent").all();
  if (!rows.length) return undefined;
  const row = journalRowSchema.safeParse(rows[0]);
  if (rows.length !== 1 || !row.success || sha256(row.data.effect_plan) !== row.data.effect_sha256) fail("Invalid extension metadata.");
  const pending = db.prepare("SELECT operation_id,actor_id,fingerprint,operation,plan,legacy_command FROM pending_project_mutation WHERE singleton=1")
    .get() as Record<string, unknown> | undefined;
  if (!pending || pending.operation !== "project.legacy.command" || pending.operation_id !== row.data.operation_id) fail("Extension metadata has no matching native intent.");
  const rawEffect: unknown = JSON.parse(row.data.effect_plan);
  if (rawEffect && typeof rawEffect === "object" && (rawEffect as Record<string, unknown>).schema === "pkm.legacy-project-thread-extension/v1") {
    const thread = parseThreadExtension(rawEffect);
    if (String(pending.plan) !== serializeLegacyProjectThreadEffect(thread.effect)
      || pending.actor_id !== thread.effect.actorId
      || pending.legacy_command !== canonicalJson(thread.effect.command)
      || thread.effect.operationId !== row.data.operation_id) fail("Project/Thread extension metadata has no matching command.");
    return legacyExtensionEnvelopeSchema.parse({
      workspaceId: thread.effect.workspaceId, operationId: thread.effect.operationId, actorId: String(pending.actor_id),
      globalFingerprint: String(pending.fingerprint), command: JSON.parse(String(pending.legacy_command)),
    });
  }
  const effect = validateLegacyExtensionEffectPlan(rawEffect);
  return legacyExtensionEnvelopeSchema.parse({
    workspaceId: effect.plan.workspaceId, operationId: effect.plan.operationId, actorId: String(pending.actor_id),
    globalFingerprint: String(pending.fingerprint), command: JSON.parse(String(pending.legacy_command)),
  });
}

function domainFromManifest(files: LegacyExtensionEffectPlan["before"], rootId: string, storeVersion: number): LegacyProjectDomain {
  const domain: LegacyProjectDomain = { rootId, storeVersion, projects: [], threads: [], ganttTasks: [], collaborationTasks: [] };
  for (const file of files.filter(item => item.path.startsWith("project/"))) {
    const record = JSON.parse(Buffer.from(file.base64, "base64").toString("utf8")) as Record<string, unknown>;
    const key = file.path.endsWith("/project.json") ? "projects" : file.path.includes("/threads/") ? "threads"
      : file.path.includes("/gantt/") ? "ganttTasks" : "collaborationTasks";
    domain[key].push(record);
  }
  return domain;
}

/** Roll forward only; the caller retains the exclusive workspace owner across both SQL phases. */
export function recoverLegacyExtensionEffects(db: DatabaseSync, root: string, envelope: LegacyExtensionEnvelope) {
  const inspected = inspectLegacyExtensionPending(db, root, envelope);
  if (inspected.effect.schema === "pkm.legacy-project-thread-extension/v1") {
    const result = recoverLegacyProjectThreadEffect(root, inspected.effect.effect);
    if (result.state !== "complete") fail(`Project/Thread effect recovery failed: ${result.state}`);
    const verified = inspectLegacyExtensionPending(db, root, envelope);
    if (verified.state !== "after") fail("Project/Thread effect did not reach its complete after-state.");
    const snapshot = readCurrentLegacyProjectSnapshot(db, envelope.workspaceId);
    if (verified.effect.schema !== "pkm.legacy-project-thread-extension/v1") fail("Project/Thread extension type changed during recovery.");
    const expected = { ...verified.effect.effect.afterDomain, storeVersion: envelope.command.expectedStoreVersion };
    if (legacyProjectDomainDigest(snapshot) !== legacyProjectDomainDigest(expected)) fail("Canonical Project/Thread snapshot differs from the original after-domain.");
    return { snapshot, effect: verified.effect };
  }
  if (inspected.effect.schema !== "pkm.legacy-command-extension/v1") fail("Extension effect type changed during recovery.");
  const result = applyProjectMutation(root, inspected.effect.plan, scanMarkdown(root));
  if (result.state !== "complete") fail(`Native effect recovery failed: ${result.state}`);
  const verified = inspectLegacyExtensionPending(db, root, envelope);
  if (verified.effect.schema !== "pkm.legacy-command-extension/v1") fail("Extension effect type changed during recovery.");
  if (verified.state !== "after") fail("Native effect did not reach its complete after-state.");
  const snapshot = readCurrentLegacyProjectSnapshot(db, envelope.workspaceId);
  const after = new Map(verified.effect.before.map(file => [file.path, file]));
  for (const file of verified.effect.plan.files) {
    if (file.afterBase64 === null) after.delete(file.relativePath);
    else after.set(file.relativePath, { path: file.relativePath, base64: file.afterBase64, sha256: file.afterSha256! });
  }
  const expected = domainFromManifest([...after.values()], verified.effect.rootId, envelope.command.expectedStoreVersion);
  if (legacyProjectDomainDigest(snapshot) !== legacyProjectDomainDigest(expected)) fail("Canonical snapshot differs from the planned after-domain.");
  return { snapshot, effect: verified.effect };
}

export function commitLegacyExtensionEffects(db: DatabaseSync, envelope: LegacyExtensionEnvelope,
  verified: ReturnType<typeof recoverLegacyExtensionEffects>, now: string): void {
  const row = db.prepare("SELECT effect_sha256 FROM legacy_command_extension_intent WHERE singleton=1").get() as { effect_sha256: string } | undefined;
  if (!row || row.effect_sha256 !== sha256(canonicalJson(verified.effect))) fail("Verified effect differs from durable extension metadata.");
  finalizeLegacyExtensionIntent(db, envelope, verified.snapshot, now);
  db.prepare("DELETE FROM legacy_command_extension_intent WHERE singleton=1").run();
}
