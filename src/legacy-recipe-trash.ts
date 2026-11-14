import { createHash } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { originalSources as legacyRecipeTrashOriginal } from "./domain/legacy-recipe-trash-original.js";
import { legacyKnowledgeAlias } from "./domain/knowledge-contracts.js";
import {
  LEGACY_RECIPE_TRASH_OPERATIONS, legacyRecipeTrashEffectPlanSchema,
  legacyRecipeTrashEnvelopeSchema, legacyRecipeTrashImportPlanSchema,
  type LegacyRecipeTrashCommand, type LegacyRecipeTrashEffectPlan, type LegacyRecipeTrashEnvelope,
  type LegacyRecipeTrashImportPlan, type LegacyRecipeTrashTreeEntry,
} from "./legacy-recipe-trash-contracts.js";
import { readLegacyProjectControl } from "./legacy-control-import.js";
import { normalizeRecipeCategory, safeRecipeFileName, validateRecipeRecord } from "./domain/project-recipes-storage-rules.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TREE_BYTES = 8 * 1024 * 1024;
const journalDDL = `CREATE TABLE IF NOT EXISTS legacy_recipe_trash_intent(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    workspace_id TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    actor_id TEXT NOT NULL,
    caller_host_fingerprint TEXT NOT NULL CHECK(length(caller_host_fingerprint)=64 AND caller_host_fingerprint NOT GLOB '*[^0-9a-f]*'),
    command TEXT NOT NULL,
    plan TEXT NOT NULL,
    plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64 AND plan_sha256 NOT GLOB '*[^0-9a-f]*'))`;
const journalRowSchema = z.strictObject({
  singleton: z.literal(1),
  workspace_id: z.string().uuid(),
  operation_id: z.string().uuid(),
  actor_id: z.string().min(1).max(500),
  caller_host_fingerprint: digestSchema,
  command: z.string().max(8192),
  plan: z.string().max(32 * 1024 * 1024),
  plan_sha256: digestSchema,
});
const originalReceiptSchema = z.strictObject({
  commandId: z.string().min(1).max(4096),
  fingerprint: z.string().min(1).max(4096),
  operation: z.string().min(1).max(512),
  storeVersion: z.number().int().safe().positive(),
  entityId: z.string().min(1).max(4096),
});
const admittedPlans = new WeakSet<object>();

export class LegacyRecipeTrashError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface LegacyRecipeTrashHost {
  receiptOperation?: "project.legacy.command" | "project.recipe.trash.command";
  assertExclusive(): void;
  authorize(actorId: string, operation: LegacyRecipeTrashCommand["operation"] | "recipe-trash-recovery-rollback"): boolean;
  verifyCallerHostFingerprint(
    envelope: LegacyRecipeTrashEnvelope,
    binding: { root: string; rootId: string; controlSha256: string },
  ): boolean;
  assertOperationAvailable(operationId: string): void;
  recoveryActorId?: string;
}

export interface LegacyRecipeTrashImportAuthority {
  sourceRootId: string;
  sourceStoreVersion: number;
  sourceControlPath?: string;
}

function fail(code: string, message: string): never { throw new LegacyRecipeTrashError(code, message); }
function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function jsonBytes(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function failIfInTransaction(database: DatabaseSync): void {
  if (database.isTransaction) fail("FILESYSTEM_TRANSACTION_FORBIDDEN", "Recipe trash inspection and file effects must run outside SQLite transactions.");
}
function inTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) fail("TRANSACTION_REQUIRED", "Recipe trash journal writes require the host's immediate SQLite transaction.");
}

function assertNoSymlinkAncestors(path: string): void {
  for (let current = resolve(path);;) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) fail("SYMLINK", "Recipe trash refuses a symbolic-link path or ancestor.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function inside(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\\") || relativePath.startsWith("/")
    || relativePath.split("/").some(part => !part || part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part))) {
    fail("INVALID_PATH", "Recipe trash path is not a portable relative path.");
  }
  const absolute = resolve(root, ...relativePath.split("/"));
  const local = relative(resolve(root), absolute);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || resolve(root, local) !== absolute) {
    fail("INVALID_PATH", "Recipe trash path escapes the workspace.");
  }
  assertNoSymlinkAncestors(absolute);
  return absolute;
}

function assertRootBinding(database: DatabaseSync, root: string, workspaceId: string): void {
  failIfInTransaction(database);
  assertNoSymlinkAncestors(root);
  const absoluteRoot = resolve(root);
  const rootStat = lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("ROOT_BINDING", "Workspace root is not a real directory.");
  const databases = database.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>;
  const main = databases.find(row => row.name === "main");
  if (!main?.file || resolve(dirname(main.file)) !== absoluteRoot || resolve(main.file) !== join(absoluteRoot, "core.sqlite")) {
    fail("ROOT_BINDING", "SQLite database is not bound to the workspace root.");
  }
  const markerPath = inside(root, ".pkm-next-workspace");
  const markerStat = lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 4096) {
    fail("ROOT_BINDING", "Workspace identity marker is invalid.");
  }
  let marker: unknown;
  try { marker = JSON.parse(readFileSync(markerPath, "utf8")); }
  catch { fail("ROOT_BINDING", "Workspace identity marker is not valid JSON."); }
  if (!marker || typeof marker !== "object"
    || (marker as Record<string, unknown>).schema !== "pkm.next-workspace/v2"
    || (marker as Record<string, unknown>).id !== workspaceId) {
    fail("ROOT_BINDING", "Workspace identity marker does not match the command.");
  }
}

function assertHost(host: LegacyRecipeTrashHost, envelope: LegacyRecipeTrashEnvelope, root: string, rootId: string, controlSha256: string): void {
  host.assertExclusive();
  if (!host.verifyCallerHostFingerprint(envelope, { root: resolve(root), rootId, controlSha256 })) {
    fail("HOST_FINGERPRINT", "Caller host fingerprint does not match the bound workspace and original control.");
  }
  if (host.authorize(envelope.actorId, envelope.command.operation) !== true) {
    fail("FORBIDDEN", `Native authorization denied ${envelope.command.operation}.`);
  }
  host.assertOperationAvailable(envelope.operationId);
}

function control(database: DatabaseSync, workspaceId: string) {
  const value = readLegacyProjectControl(database, workspaceId);
  if (!value) fail("LEGACY_CONTROL_MISSING", "Workspace has no imported original Project control.");
  return value;
}

function checkReplay(database: DatabaseSync, envelope: LegacyRecipeTrashEnvelope) {
  const current = control(database, envelope.workspaceId);
  const prior = current.receipts.find(receipt => receipt.commandId === envelope.command.commandId);
  if (prior) {
    if (prior.fingerprint !== envelope.command.fingerprint) {
      fail("COMMAND_CONFLICT", "Original command ID was already used with a different opaque fingerprint.");
    }
    return { status: "replay" as const, entityId: prior.entityId, storeVersion: current.storeVersion, replayed: true as const };
  }
  if (!(LEGACY_RECIPE_TRASH_OPERATIONS as readonly string[]).includes(envelope.command.operation)) {
    fail("LEGACY_COMMAND_UNSUPPORTED", "Only original Recipe trash and restore are qualified by this seam.");
  }
  if (current.storeVersion !== envelope.command.expectedStoreVersion) {
    fail("STORE_VERSION_CONFLICT", "Original Project store version changed.");
  }
  if (!Number.isSafeInteger(current.storeVersion + 1)) fail("STORE_VERSION_CONFLICT", "Original Project store version is exhausted.");
  return { status: "new" as const, storeVersion: current.storeVersion, replayed: false as const };
}

function recipePath(recipe: Record<string, unknown>): string {
  if (recipe.scope !== "global" || recipe.projectId !== undefined) {
    fail("RECIPE_CANONICALIZATION_REQUIRED", "Only canonical global Recipes are supported; Project-scoped Recipes require the original migration path.");
  }
  const recipeId = String(recipe.recipeId || "");
  const category = normalizeRecipeCategory(recipe.category);
  return `recipes/${category || "Uncategorized"}/${safeRecipeFileName(String(recipe.name || ""), recipeId)}`;
}

function parseRecipe(bytes: Buffer, expectedId: string, trashed: boolean): Record<string, unknown> {
  let value: unknown;
  try {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) fail("RECIPE_INVALID", "Recipe JSON is not valid UTF-8.");
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof LegacyRecipeTrashError) throw error;
    fail("RECIPE_INVALID", "Recipe file is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("RECIPE_INVALID", "Recipe file is not an object.");
  const recipe = value as Record<string, unknown>;
  if (recipe.recipeId !== expectedId) fail("RECIPE_IDENTITY", "Recipe identity does not match its canonical filename.");
  const { trashedAt: _trashedAt, ...record } = recipe;
  try { validateRecipeRecord(record as never); }
  catch { fail("RECIPE_INVALID", "Recipe metadata or executable definition is not valid original Recipe data."); }
  if (trashed) {
    if (typeof recipe.trashedAt !== "string" || !Number.isFinite(Date.parse(recipe.trashedAt))
      || new Date(recipe.trashedAt).toISOString() !== recipe.trashedAt) {
      fail("RECIPE_INVALID", "Trashed Recipe has no canonical original trashedAt timestamp.");
    }
  } else if (recipe.trashedAt !== undefined
    && (typeof recipe.trashedAt !== "string" || !Number.isFinite(Date.parse(recipe.trashedAt))
      || new Date(recipe.trashedAt).toISOString() !== recipe.trashedAt)) {
    fail("RECIPE_INVALID", "Active Recipe contains a non-canonical legacy trashedAt value.");
  }
  return recipe;
}

function safeRecipeTree(root: string, validateRecipes = true): LegacyRecipeTrashTreeEntry[] {
  const recipesRoot = inside(root, "recipes");
  const rootStat = lstatSync(recipesRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("UNSUPPORTED_LAYOUT", "Canonical Recipe root is not a real directory.");
  const entries: LegacyRecipeTrashTreeEntry[] = [{ path: "recipes", kind: "directory" }];
  const portable = new Map<string, string>();
  let total = 0;
  function walk(directory: string, relativePath: string, depth: number): void {
    if (depth > 32 || entries.length > 8192) fail("RESOURCE_LIMIT", "Recipe tree exceeds bounded recovery limits.");
    for (const dirent of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${relativePath}/${dirent.name}`;
      const key = rel.normalize("NFC").toLocaleLowerCase("en-US");
      const prior = portable.get(key);
      if (prior && prior !== rel) fail("PORTABLE_COLLISION", `Recipe paths collide portably: ${prior} and ${rel}.`);
      portable.set(key, rel);
      const absolute = inside(root, rel);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        fail("UNSUPPORTED_LAYOUT", "Recipe trash refuses symlinks and special files.");
      }
      if (stat.isDirectory()) {
        entries.push({ path: rel, kind: "directory" });
        walk(absolute, rel, depth + 1);
        continue;
      }
      if (!rel.endsWith(".json") || stat.size > MAX_FILE_BYTES) {
        fail("UNSUPPORTED_LAYOUT", "Only bounded canonical Recipe JSON files are supported.");
      }
      const bytes = readFileSync(absolute);
      const after = lstatSync(absolute);
      if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino
        || after.size !== stat.size || bytes.length !== stat.size) {
        fail("SOURCE_CHANGED", "Recipe file changed while it was inspected.");
      }
      total += bytes.length;
      if (total > MAX_TREE_BYTES) fail("RESOURCE_LIMIT", "Recipe tree exceeds the source byte limit.");
      entries.push({ path: rel, kind: "file", sha256: hash(bytes), base64: bytes.toString("base64") });
    }
  }
  walk(recipesRoot, "recipes", 0);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  assertCanonicalDirectories(entries);
  if (validateRecipes) assertRecipeIds(entries);
  return entries;
}

function assertCanonicalDirectories(entries: LegacyRecipeTrashTreeEntry[]): void {
  const files = entries.filter((entry): entry is Extract<LegacyRecipeTrashTreeEntry, { kind: "file" }> => entry.kind === "file");
  const expected = new Set(["recipes"]);
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index++) expected.add(parts.slice(0, index).join("/"));
  }
  const actual = entries.filter(entry => entry.kind === "directory").map(entry => entry.path);
  if (actual.length !== expected.size || actual.some(path => !expected.has(path))) {
    fail("NONCANONICAL_LAYOUT", "Recipe tree contains empty or unowned directories; canonicalize before native trash.");
  }
}

function assertRecipeIds(entries: LegacyRecipeTrashTreeEntry[]): void {
  const ids = new Set<string>();
  const knowledge = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const id = /\.([A-Za-z][A-Za-z0-9._-]{0,127})\.json$/i.exec(entry.path.split("/").at(-1) || "")?.[1];
    if (!id) fail("RECIPE_IDENTITY", "Recipe filename does not contain its original identity.");
    const recipe = parseRecipe(Buffer.from(entry.base64, "base64"), id, entry.path.startsWith("recipes/.trash/"));
    if (ids.has(id)) fail("RECIPE_IDENTITY", `Recipe identity is duplicated: ${id}.`);
    ids.add(id);
    const knowledgeId = String(recipe.knowledgeId || "");
    if (knowledgeId && knowledge.has(knowledgeId)) fail("RECIPE_IDENTITY", `Knowledge identity is duplicated: ${knowledgeId}.`);
    if (knowledgeId) knowledge.add(knowledgeId);
    const expectedPath = entry.path.startsWith("recipes/.trash/")
      ? `recipes/.trash/${safeRecipeFileName(String(recipe.name), id)}`
      : recipePath(recipe);
    if (entry.path !== expectedPath) fail("NONCANONICAL_LAYOUT", "Recipe filename or category differs from original canonical layout.");
  }
}

function expectedDirectories(files: LegacyRecipeTrashTreeEntry[]): LegacyRecipeTrashTreeEntry[] {
  const dirs = new Set(["recipes"]);
  for (const entry of files) {
    if (entry.kind !== "file") continue;
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index++) dirs.add(parts.slice(0, index).join("/"));
  }
  return [...dirs].map(path => ({ path, kind: "directory" as const }));
}

function canonicalStoredRecipe(input: Record<string, unknown>, relativePath: string): Record<string, unknown> {
  try { validateRecipeRecord(input as never); }
  catch { fail("RECIPE_INVALID", "Recipe metadata or executable definition is not valid original Recipe data."); }
  const candidateKnowledgeId = String(input.knowledgeId || "");
  const aliases = [...new Set([
    ...(Array.isArray(input.aliases)
      ? input.aliases.filter((value): value is string => typeof value === "string" && /^(note|skill|research|recipe):[^\u0000-\u001f]+$/.test(value))
      : []),
    legacyKnowledgeAlias("recipe", String(input.recipeId)),
    legacyKnowledgeAlias("recipe", relativePath),
    legacyKnowledgeAlias("recipe", relativePath),
  ])].sort();
  const stored: Record<string, unknown> = {
    ...JSON.parse(canonicalJson(input)) as Record<string, unknown>,
    schema: "pkm.knowledge/v1",
    knowledgeId: /^knowledge_[a-f0-9]{24}$/.test(candidateKnowledgeId)
      ? candidateKnowledgeId : deterministicKnowledgeId(String(input.recipeId)),
    aliases,
    scope: "global",
    ...(normalizeRecipeCategory(input.category) ? { category: normalizeRecipeCategory(input.category) } : {}),
  };
  delete stored.projectId;
  if (!normalizeRecipeCategory(input.category)) delete stored.category;
  return stored;
}

function materializeOriginalTree(
  entries: LegacyRecipeTrashTreeEntry[],
  operation: LegacyRecipeTrashCommand["operation"],
  recipeId: string,
  timestamp: string | undefined,
): LegacyRecipeTrashTreeEntry[] {
  const active: Record<string, unknown>[] = [];
  const trash: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const trashed = entry.path.startsWith("recipes/.trash/");
    const filename = entry.path.split("/").at(-1) || "";
    const id = /\.([A-Za-z][A-Za-z0-9._-]{0,127})\.json$/i.exec(filename)?.[1];
    if (!id) fail("RECIPE_IDENTITY", "Recipe filename does not contain its original identity.");
    const recipe = parseRecipe(Buffer.from(entry.base64, "base64"), id, trashed);
    if (trashed) trash.push(recipe);
    else active.push(recipe);
  }
  if (operation === "recipe-trash-move") {
    const index = active.findIndex(recipe => recipe.recipeId === recipeId);
    if (index < 0 || trash.some(recipe => recipe.recipeId === recipeId)) fail("RECIPE_NOT_FOUND", "Original Recipe is not active.");
    const [recipe] = active.splice(index, 1);
    if (recipe.systemKind === "built-in") fail("BUILTIN_PROTECTED", "Built-in Recipes cannot be moved to Trash.");
    trash.push({ ...recipe, trashedAt: timestamp });
  } else {
    const index = trash.findIndex(recipe => recipe.recipeId === recipeId);
    if (index < 0 || active.some(recipe => recipe.recipeId === recipeId)) fail("RECIPE_NOT_FOUND", "Original Recipe is not in Trash.");
    const [recipe] = trash.splice(index, 1);
    if (recipe.systemKind === "built-in") fail("BUILTIN_PROTECTED", "Built-in Recipes cannot be restored from Trash.");
    const { trashedAt: _trashedAt, ...restored } = recipe;
    active.push({ ...restored, trashedAt: recipe.trashedAt });
  }
  const files: Extract<LegacyRecipeTrashTreeEntry, { kind: "file" }>[] = [];
  for (const recipe of active) {
    const path = recipePath(recipe);
    const relativePath = path.slice("recipes/".length);
    const stored = canonicalStoredRecipe(recipe, relativePath);
    const bytes = jsonBytes(stored);
    files.push({ path, kind: "file", sha256: hash(bytes), base64: bytes.toString("base64") });
  }
  for (const recipe of trash) {
    const category = normalizeRecipeCategory(recipe.category);
    const relativePath = `${category || "Uncategorized"}/${safeRecipeFileName(String(recipe.name), String(recipe.recipeId))}`;
    const path = `recipes/.trash/${safeRecipeFileName(String(recipe.name), String(recipe.recipeId))}`;
    const stored = canonicalStoredRecipe(recipe, relativePath);
    const bytes = jsonBytes({ ...stored, trashedAt: recipe.trashedAt });
    files.push({ path, kind: "file", sha256: hash(bytes), base64: bytes.toString("base64") });
  }
  return [...files, ...expectedDirectories(files)].sort((a, b) => a.path.localeCompare(b.path));
}

function targetRecipe(entries: LegacyRecipeTrashTreeEntry[], id: string, trashed: boolean) {
  const matches = entries.filter((entry): entry is Extract<LegacyRecipeTrashTreeEntry, { kind: "file" }> => {
    if (entry.kind !== "file" || entry.path.startsWith("recipes/.trash/") !== trashed) return false;
    try {
      const parsed = JSON.parse(Buffer.from(entry.base64, "base64").toString("utf8")) as Record<string, unknown>;
      return parsed.recipeId === id;
    } catch { return false; }
  });
  if (matches.length > 1) fail("RECIPE_IDENTITY", `Recipe identity occurs more than once: ${id}.`);
  return matches[0];
}

function deterministicKnowledgeId(recipeId: string): string {
  return `knowledge_${hash(`recipe\0${recipeId}`).slice(0, 24)}`;
}

function recipeIdReferences(root: string, recipeId: string): void {
  for (const guard of [".pkm/state/actions/runs", ".pkm/state/agent-sessions", ".pkm/state/recipe-runs"]) {
    const path = inside(root, guard);
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(path).length > 0) {
      fail("ACTIVE_WORKFLOW", "Recipe mutation is blocked while native workflow/session state exists.");
    }
  }
  const projectRoot = inside(root, "project");
  let stat;
  try { stat = lstatSync(projectRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("REFERENCE_CHECK", "Project reference root is unsafe.");
  function walk(directory: string): void {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      const child = lstatSync(path);
      if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) fail("REFERENCE_CHECK", "Project reference tree contains an unsafe entry.");
      if (child.isDirectory()) walk(path);
      else if (child.size <= MAX_FILE_BYTES && readFileSync(path).toString("utf8").includes(recipeId)) {
        fail("RECIPE_REFERENCED", "Recipe is referenced by Project data; remove or migrate that reference first.");
      }
    }
  }
  walk(projectRoot);
}

function planBody(plan: Omit<LegacyRecipeTrashEffectPlan, "planSha256">): string {
  return canonicalJson(plan);
}

export function legacyRecipeTrashJournalDDL(): string { return journalDDL; }

export function initializeLegacyRecipeTrashJournal(database: DatabaseSync): void {
  inTransaction(database);
  database.exec(journalDDL);
  validateLegacyRecipeTrashJournalSchema(database);
}

export function validateLegacyRecipeTrashJournalSchema(database: DatabaseSync): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='legacy_recipe_trash_intent'").get() as
    { sql: string } | undefined;
  const normalize = (value: string) => value.replace("IF NOT EXISTS ", "").replace(/\s+/g, " ").trim();
  if (!row || normalize(row.sql) !== normalize(journalDDL)) fail("JOURNAL_SCHEMA", "Recipe trash intent table has an unrecognized schema.");
}

export function compileLegacyRecipeTrashEffectPlan(
  database: DatabaseSync,
  root: string,
  input: LegacyRecipeTrashEnvelope,
  host: LegacyRecipeTrashHost,
  now: string = new Date().toISOString(),
): LegacyRecipeTrashEffectPlan {
  const envelope = legacyRecipeTrashEnvelopeSchema.parse(input);
  failIfInTransaction(database);
  assertRootBinding(database, root, envelope.workspaceId);
  const current = control(database, envelope.workspaceId);
  assertHost(host, envelope, root, current.rootId, current.controlSha256);
  const replay = checkReplay(database, envelope);
  if (replay.status === "replay") fail("COMMAND_REPLAY", "Command has already completed and cannot be planned again.");
  if (current.storeVersion !== envelope.command.expectedStoreVersion) fail("STORE_VERSION_CONFLICT", "Original Project store version changed.");
  if (!database.prepare("SELECT 1 FROM legacy_recipe_trash_intent LIMIT 1").get()
    && database.prepare("SELECT 1 FROM pending_project_mutation LIMIT 1").get()) {
    fail("BUSY", "A different Project command is pending.");
  }
  const timestamp = envelope.command.operation === "recipe-trash-move" ? new Date(now).toISOString() : undefined;
  if (timestamp && (!Number.isFinite(Date.parse(now)) || timestamp !== now)) {
    fail("INVALID_ARGUMENT", "Original Recipe trash timestamp must be canonical UTC.");
  }
  const before = safeRecipeTree(root);
  const id = envelope.command.recipeId;
  const active = targetRecipe(before, id, false);
  const trashed = targetRecipe(before, id, true);
  recipeIdReferences(root, id);
  if (envelope.command.operation === "recipe-trash-move") {
    if (!active || trashed) fail(trashed ? "RECIPE_ALREADY_TRASHED" : "RECIPE_NOT_FOUND", "Original Recipe is not active.");
    const source = parseRecipe(Buffer.from(active.base64, "base64"), id, false);
    if (source.systemKind === "built-in") fail("BUILTIN_PROTECTED", "Built-in Recipes cannot be moved to Trash.");
    const trashPath = `recipes/.trash/${safeRecipeFileName(String(source.name), id)}`;
    if (before.some(entry => entry.path.normalize("NFC").toLocaleLowerCase("en-US")
      === trashPath.normalize("NFC").toLocaleLowerCase("en-US"))) {
      fail("PORTABLE_COLLISION", "Trash destination already exists or collides portably.");
    }
    if (!timestamp) fail("INVALID_ARGUMENT", "Original Recipe trash timestamp is missing.");
  } else {
    if (!trashed || active) fail(active ? "IDENTITY_CONFLICT" : "RECIPE_NOT_FOUND", "Original Recipe is not restorable from Trash.");
    const source = parseRecipe(Buffer.from(trashed.base64, "base64"), id, true);
    if (source.systemKind === "built-in") fail("BUILTIN_PROTECTED", "Built-in Recipes cannot be restored from Trash.");
    const { trashedAt: _trashedAt, ...restored } = source;
    try { validateRecipeRecord(restored as never); }
    catch { fail("RECIPE_INVALID", "Restored Recipe does not pass original metadata validation."); }
    const activePath = recipePath(restored);
    if (before.some(entry => entry.path.normalize("NFC").toLocaleLowerCase("en-US")
      === activePath.normalize("NFC").toLocaleLowerCase("en-US"))) {
      fail("PORTABLE_COLLISION", "Restore destination already exists or collides portably.");
    }
  }
  const after = materializeOriginalTree(before, envelope.command.operation, id, timestamp);
  const body = {
    schema: "pkm.legacy-recipe-trash-effect/v1" as const,
    workspaceId: envelope.workspaceId,
    operationId: envelope.operationId,
    actorId: envelope.actorId,
    callerHostFingerprint: envelope.callerHostFingerprint,
    command: envelope.command,
    rootId: current.rootId,
    controlSha256: current.controlSha256,
    canonicalDigest: current.canonicalDigest,
    priorReceipts: current.receipts.map(({ ordinal: _ordinal, ...receipt }) => receipt),
    recipeId: id,
    before,
    after,
  };
  const plan = legacyRecipeTrashEffectPlanSchema.parse({
    ...body,
    planSha256: hash(planBody(body)),
  });
  admittedPlans.add(plan);
  return plan;
}

export function validateLegacyRecipeTrashEffectPlan(input: unknown): LegacyRecipeTrashEffectPlan {
  const plan = legacyRecipeTrashEffectPlanSchema.parse(input);
  const { planSha256, ...body } = plan;
  if (hash(planBody(body)) !== planSha256) fail("PLAN_DIGEST", "Recipe trash plan digest does not match its exact source-bound contents.");
  validateTree(plan.before);
  validateTree(plan.after);
  assertRecipeIds(plan.before);
  assertRecipeIds(plan.after);
  let timestamp: string | undefined;
  if (plan.command.operation === "recipe-trash-move") {
    const trashed = targetRecipe(plan.after, plan.recipeId, true);
    if (!trashed) fail("INVALID_PLAN", "Recipe trash effect does not contain its moved Recipe.");
    timestamp = String(JSON.parse(Buffer.from(trashed.base64, "base64").toString("utf8")).trashedAt || "");
    if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
      fail("INVALID_PLAN", "Recipe trash effect has no canonical original timestamp.");
    }
  }
  const reproduced = materializeOriginalTree(plan.before, plan.command.operation, plan.recipeId, timestamp);
  if (canonicalJson(reproduced) !== canonicalJson(plan.after)) {
    fail("INVALID_PLAN", "Recipe trash effect does not reproduce the original RecipeFilesystemStore serialization.");
  }
  return plan;
}

function validateTree(entries: LegacyRecipeTrashTreeEntry[]): void {
  const paths = new Set<string>();
  const portable = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    inside("/", entry.path);
    if (!entry.path.startsWith("recipes/") && entry.path !== "recipes") fail("INVALID_PLAN", "Recipe trash tree contains a path outside Recipes.");
    const key = entry.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (paths.has(entry.path) || portable.has(key)) fail("INVALID_PLAN", "Recipe trash plan contains duplicate or portable-colliding paths.");
    paths.add(entry.path); portable.add(key);
    if (entry.kind === "file") {
      const bytes = Buffer.from(entry.base64, "base64");
      if (!bytes.toString("base64").replace(/=+$/, "").startsWith(entry.base64.replace(/=+$/, ""))
        || bytes.length > MAX_FILE_BYTES || hash(bytes) !== entry.sha256) fail("INVALID_PLAN", "Recipe trash file bytes do not match their source digest.");
      total += bytes.length;
    }
  }
  if (total > MAX_TREE_BYTES) fail("RESOURCE_LIMIT", "Recipe trash plan exceeds its source byte limit.");
  assertCanonicalDirectories(entries);
}

export function stageLegacyRecipeTrashEffect(
  database: DatabaseSync,
  input: LegacyRecipeTrashEnvelope,
  planInput: LegacyRecipeTrashEffectPlan,
): void {
  inTransaction(database);
  const envelope = legacyRecipeTrashEnvelopeSchema.parse(input);
  if (!planInput || typeof planInput !== "object" || !admittedPlans.has(planInput)) {
    fail("PLAN_NOT_ADMITTED", "Only an in-process source-inspected Recipe trash plan can be journaled.");
  }
  const plan = validateLegacyRecipeTrashEffectPlan(planInput);
  if (plan.workspaceId !== envelope.workspaceId || plan.operationId !== envelope.operationId
    || plan.actorId !== envelope.actorId || plan.callerHostFingerprint !== envelope.callerHostFingerprint
    || canonicalJson(plan.command) !== canonicalJson(envelope.command)) {
    fail("INVALID_PLAN", "Recipe trash plan identity does not match its original command envelope.");
  }
  const controlRecord = control(database, envelope.workspaceId);
  if (controlRecord.rootId !== plan.rootId || controlRecord.storeVersion !== envelope.command.expectedStoreVersion
    || controlRecord.controlSha256 !== plan.controlSha256 || controlRecord.canonicalDigest !== plan.canonicalDigest
    || canonicalJson(controlRecord.receipts.map(({ ordinal: _ordinal, ...receipt }) => receipt)) !== canonicalJson(plan.priorReceipts)) {
    fail("STORE_VERSION_CONFLICT", "Original control, source receipts or expected Project version changed before journal staging.");
  }
  if (checkReplay(database, envelope).status !== "new") fail("COMMAND_ALREADY_RECORDED", "Replay cannot stage a Recipe trash effect.");
  if (database.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(envelope.operationId)) fail("GLOBAL_OPERATION_CONFLICT", "Global operation ID already exists.");
  if (database.prepare("SELECT 1 FROM legacy_recipe_trash_intent LIMIT 1").get()
    || database.prepare("SELECT 1 FROM pending_project_mutation LIMIT 1").get()) fail("BUSY", "Another Project mutation is pending.");
  const serialized = canonicalJson(plan);
  if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) fail("RESOURCE_LIMIT", "Recipe trash intent exceeds its journal limit.");
  database.prepare(`INSERT INTO legacy_recipe_trash_intent
    (singleton,workspace_id,operation_id,actor_id,caller_host_fingerprint,command,plan,plan_sha256)
    VALUES(1,?,?,?,?,?,?,?)`)
    .run(envelope.workspaceId, envelope.operationId, envelope.actorId, envelope.callerHostFingerprint,
      canonicalJson(envelope.command), serialized, hash(serialized));
}

function readPendingPlan(database: DatabaseSync, envelope: LegacyRecipeTrashEnvelope): LegacyRecipeTrashEffectPlan {
  validateLegacyRecipeTrashJournalSchema(database);
  const rows = database.prepare("SELECT * FROM legacy_recipe_trash_intent").all();
  const row = rows.length === 1 ? journalRowSchema.safeParse(rows[0]) : undefined;
  if (!row?.success || row.data.workspace_id !== envelope.workspaceId || row.data.operation_id !== envelope.operationId
    || row.data.actor_id !== envelope.actorId || row.data.caller_host_fingerprint !== envelope.callerHostFingerprint
    || row.data.command !== canonicalJson(envelope.command) || hash(row.data.plan) !== row.data.plan_sha256) {
    fail("RECOVERY_CONFLICT", "Pending Recipe trash journal is missing or does not match the command envelope.");
  }
  const plan = validateLegacyRecipeTrashEffectPlan(JSON.parse(row.data.plan));
  return plan;
}

export function readLegacyRecipeTrashPendingEnvelope(database: DatabaseSync): LegacyRecipeTrashEnvelope | undefined {
  validateLegacyRecipeTrashJournalSchema(database);
  const rows = database.prepare("SELECT * FROM legacy_recipe_trash_intent").all();
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) fail("RECOVERY_CONFLICT", "Recipe trash journal has multiple pending rows.");
  const parsed = journalRowSchema.safeParse(rows[0]);
  if (!parsed.success || hash(parsed.data.plan) !== parsed.data.plan_sha256) {
    fail("RECOVERY_CONFLICT", "Recipe trash journal row is malformed.");
  }
  return legacyRecipeTrashEnvelopeSchema.parse({
    workspaceId: parsed.data.workspace_id,
    operationId: parsed.data.operation_id,
    actorId: parsed.data.actor_id,
    callerHostFingerprint: parsed.data.caller_host_fingerprint,
    command: JSON.parse(parsed.data.command),
  });
}

export type LegacyRecipeTrashRecoveryState = "before" | "after" | "mixed";

function compareCurrent(root: string, plan: LegacyRecipeTrashEffectPlan): LegacyRecipeTrashRecoveryState {
  const actual = safeRecipeTree(root, false);
  const before = canonicalJson(plan.before);
  const after = canonicalJson(plan.after);
  const current = canonicalJson(actual);
  if (current === before) return "before";
  if (current === after) return "after";
  const beforeMap = new Map(plan.before.map(entry => [entry.path, entry]));
  const afterMap = new Map(plan.after.map(entry => [entry.path, entry]));
  const actualMap = new Map(actual.map(entry => [entry.path, entry]));
  const allPaths = new Set([...beforeMap.keys(), ...afterMap.keys(), ...actualMap.keys()]);
  let hasBefore = false, hasAfter = false;
  for (const path of allPaths) {
    const currentEntry = actualMap.get(path);
    const beforeEntry = beforeMap.get(path);
    const afterEntry = afterMap.get(path);
    const equal = (left: LegacyRecipeTrashTreeEntry | undefined, right: LegacyRecipeTrashTreeEntry | undefined) =>
      left === undefined ? right === undefined : right !== undefined && canonicalJson(left) === canonicalJson(right);
    if (equal(currentEntry, beforeEntry)) hasBefore = true;
    else if (equal(currentEntry, afterEntry)) hasAfter = true;
    else fail("RECOVERY_UNKNOWN_STATE", "Recipe tree contains bytes or paths outside the exact before/after plan.");
  }
  if (!hasBefore || !hasAfter) fail("RECOVERY_UNKNOWN_STATE", "Recipe tree is not a recognized mixed application of the pending plan.");
  return "mixed";
}

export function inspectLegacyRecipeTrashPending(
  database: DatabaseSync, root: string, input: LegacyRecipeTrashEnvelope, host: LegacyRecipeTrashHost,
): { plan: LegacyRecipeTrashEffectPlan; state: LegacyRecipeTrashRecoveryState } {
  const envelope = legacyRecipeTrashEnvelopeSchema.parse(input);
  failIfInTransaction(database);
  assertRootBinding(database, root, envelope.workspaceId);
  const plan = readPendingPlan(database, envelope);
  const current = control(database, envelope.workspaceId);
  if (current.rootId !== plan.rootId || current.storeVersion !== envelope.command.expectedStoreVersion
    || current.controlSha256 !== plan.controlSha256 || current.canonicalDigest !== plan.canonicalDigest
    || canonicalJson(current.receipts.map(({ ordinal: _ordinal, ...receipt }) => receipt)) !== canonicalJson(plan.priorReceipts)
    || current.receipts.some(receipt => receipt.commandId === envelope.command.commandId)) {
    fail("RECOVERY_CONFLICT", "Pending Recipe trash effect no longer matches original control or command history.");
  }
  assertHost(host, envelope, root, current.rootId, current.controlSha256);
  recipeIdReferences(root, envelope.command.recipeId);
  return { plan, state: compareCurrent(root, plan) };
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function currentEntry(root: string, relativePath: string): { bytes: Buffer; digest: string } | undefined {
  const absolute = inside(root, relativePath);
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) fail("RECOVERY_UNKNOWN_STATE", "Recipe target is not a bounded regular file.");
    const bytes = readFileSync(absolute);
    if (bytes.length !== stat.size) fail("SOURCE_CHANGED", "Recipe file changed during recovery.");
    return { bytes, digest: hash(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function writeExact(root: string, relativePath: string, expected: LegacyRecipeTrashTreeEntry | undefined,
  next: LegacyRecipeTrashTreeEntry | undefined, operationId: string): void {
  if (next?.kind === "directory") return;
  const absolute = inside(root, relativePath);
  const before = currentEntry(root, relativePath);
  const expectedDigest = expected?.kind === "file" ? expected.sha256 : undefined;
  if ((before?.digest ?? undefined) !== expectedDigest) {
    const desiredDigest = next?.kind === "file" ? next.sha256 : undefined;
    if ((before?.digest ?? undefined) === desiredDigest) return;
    fail("RECOVERY_UNKNOWN_STATE", "Recipe file changed after exact recovery inspection.");
  }
  if (next?.kind === "file") {
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(next.base64, "base64");
    if (hash(bytes) !== next.sha256) fail("INVALID_PLAN", "Recipe effect bytes changed.");
    const temporary = join(dirname(absolute), `.pkm-recipe-trash-${operationId}`);
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); }
    finally { closeSync(fd); }
    if ((currentEntry(root, relativePath)?.digest ?? undefined) !== expectedDigest) {
      unlinkSync(temporary);
      fail("RECOVERY_UNKNOWN_STATE", "Recipe file changed while preparing the exact replacement.");
    }
    renameSync(temporary, absolute);
    fsyncDirectory(dirname(absolute));
    return;
  }
  if (before) {
    unlinkSync(absolute);
    fsyncDirectory(dirname(absolute));
  }
}

function applyTree(root: string, plan: LegacyRecipeTrashEffectPlan, direction: "after" | "before"): void {
  const source = direction === "after" ? plan.before : plan.after;
  const destination = direction === "after" ? plan.after : plan.before;
  const sourceFiles = new Map(source.filter(entry => entry.kind === "file").map(entry => [entry.path, entry]));
  const destinationFiles = new Map(destination.filter(entry => entry.kind === "file").map(entry => [entry.path, entry]));
  const all = new Set([...sourceFiles.keys(), ...destinationFiles.keys()]);
  const creations = [...all].filter(path => destinationFiles.has(path)).sort();
  const deletions = [...all].filter(path => !destinationFiles.has(path)).sort().reverse();
  for (const path of creations) writeExact(root, path, sourceFiles.get(path), destinationFiles.get(path), plan.operationId);
  for (const path of deletions) writeExact(root, path, sourceFiles.get(path), undefined, plan.operationId);
  const desiredDirectories = new Set(destination.filter(entry => entry.kind === "directory").map(entry => entry.path));
  const currentDirectories = source.filter((entry): entry is Extract<LegacyRecipeTrashTreeEntry, { kind: "directory" }> => entry.kind === "directory");
  for (const entry of destination.filter((item): item is Extract<LegacyRecipeTrashTreeEntry, { kind: "directory" }> => item.kind === "directory")) {
    mkdirSync(inside(root, entry.path), { recursive: true, mode: 0o700 });
  }
  for (const entry of currentDirectories.sort((a, b) => b.path.split("/").length - a.path.split("/").length)) {
    if (desiredDirectories.has(entry.path) || entry.path === "recipes") continue;
    const absolute = inside(root, entry.path);
    try {
      if (readdirSync(absolute).length === 0) {
        rmdirSync(absolute);
        fsyncDirectory(dirname(absolute));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    }
  }
}

function finalize(database: DatabaseSync, envelope: LegacyRecipeTrashEnvelope, plan: LegacyRecipeTrashEffectPlan, now: string, host: LegacyRecipeTrashHost): number {
  inTransaction(database);
  const current = control(database, envelope.workspaceId);
  if (current.rootId !== plan.rootId || current.storeVersion !== envelope.command.expectedStoreVersion
    || current.controlSha256 !== plan.controlSha256 || current.canonicalDigest !== plan.canonicalDigest
    || canonicalJson(current.receipts.map(({ ordinal: _ordinal, ...receipt }) => receipt)) !== canonicalJson(plan.priorReceipts)) {
    fail("STORE_VERSION_CONFLICT", "Original Project control changed before Recipe trash receipt commit.");
  }
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) fail("INVALID_RESULT", "Receipt timestamp is not canonical UTC.");
  const version = current.storeVersion + 1;
  const receipt = {
    commandId: envelope.command.commandId,
    fingerprint: envelope.command.fingerprint,
    operation: envelope.command.operation,
    storeVersion: version,
    entityId: envelope.command.recipeId,
  };
  const receipts = [...current.receipts.map(({ ordinal: _ordinal, ...value }) => value), receipt].slice(-256);
  const update = database.prepare(`UPDATE legacy_project_control SET store_version=?,canonical_digest=?
    WHERE workspace_id=? AND store_version=? AND canonical_digest=? AND control_sha256=?`)
    .run(version, current.canonicalDigest, envelope.workspaceId, current.storeVersion, current.canonicalDigest, current.controlSha256);
  if (update.changes !== 1) fail("STORE_VERSION_CONFLICT", "Original Project control changed during Recipe trash finalization.");
  database.prepare("DELETE FROM legacy_project_receipt WHERE workspace_id=?").run(envelope.workspaceId);
  const insert = database.prepare(`INSERT INTO legacy_project_receipt
    (workspace_id,ordinal,command_id,fingerprint,operation,store_version,entity_id) VALUES(?,?,?,?,?,?,?)`);
  receipts.forEach((value, ordinal) => insert.run(envelope.workspaceId, ordinal, value.commandId, value.fingerprint,
    value.operation, value.storeVersion, value.entityId));
  const result = {
    operationId: envelope.operationId,
    operation: envelope.command.operation,
    entityId: envelope.command.recipeId,
    storeVersion: version,
    replayed: false,
  };
  database.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
    .run(envelope.operationId, envelope.callerHostFingerprint, JSON.stringify(result), envelope.actorId,
      host.receiptOperation ?? "project.legacy.command", now);
  database.prepare("DELETE FROM legacy_recipe_trash_intent WHERE singleton=1 AND operation_id=?").run(envelope.operationId);
  return version;
}

function replayResult(database: DatabaseSync, envelope: LegacyRecipeTrashEnvelope) {
  const result = checkReplay(database, envelope);
  return result.status === "replay" ? result : undefined;
}

export function resumeLegacyRecipeTrashCommand(
  database: DatabaseSync,
  root: string,
  input: LegacyRecipeTrashEnvelope,
  host: LegacyRecipeTrashHost,
  transaction: <T>(work: () => T) => T,
  now: string = new Date().toISOString(),
): { entityId: string; storeVersion: number; replayed: boolean } {
  const envelope = legacyRecipeTrashEnvelopeSchema.parse(input);
  failIfInTransaction(database);
  assertRootBinding(database, root, envelope.workspaceId);
  const admittedControl = control(database, envelope.workspaceId);
  assertHost(host, envelope, root, admittedControl.rootId, admittedControl.controlSha256);
  const replay = replayResult(database, envelope);
  if (replay) return { entityId: replay.entityId, storeVersion: replay.storeVersion, replayed: true };
  const inspected = inspectLegacyRecipeTrashPending(database, root, envelope, host);
  if (inspected.state !== "after") {
    host.assertExclusive();
    applyTree(root, inspected.plan, "after");
    host.assertExclusive();
  }
  const verified = inspectLegacyRecipeTrashPending(database, root, envelope, host);
  if (verified.state !== "after") fail("RECOVERY_CONFLICT", "Recipe trash after-state did not verify exactly.");
  host.assertExclusive();
  const version = transaction(() => finalize(database, envelope, verified.plan, now, host));
  const result = replayResult(database, envelope);
  if (!result || result.storeVersion !== version) fail("RECEIPT_COMMIT", "Original Recipe trash receipt did not survive commit.");
  return { entityId: result.entityId, storeVersion: version, replayed: false };
}

export function executeLegacyRecipeTrashCommand(
  database: DatabaseSync,
  root: string,
  input: LegacyRecipeTrashEnvelope,
  host: LegacyRecipeTrashHost,
  transaction: <T>(work: () => T) => T,
  now: string = new Date().toISOString(),
): { entityId: string; storeVersion: number; replayed: boolean } {
  const envelope = legacyRecipeTrashEnvelopeSchema.parse(input);
  assertRootBinding(database, root, envelope.workspaceId);
  const admittedControl = control(database, envelope.workspaceId);
  assertHost(host, envelope, root, admittedControl.rootId, admittedControl.controlSha256);
  const replay = replayResult(database, envelope);
  if (replay) return { entityId: replay.entityId, storeVersion: replay.storeVersion, replayed: true };
  const plan = compileLegacyRecipeTrashEffectPlan(database, root, envelope, host, now);
  host.assertExclusive();
  transaction(() => stageLegacyRecipeTrashEffect(database, envelope, plan));
  return resumeLegacyRecipeTrashCommand(database, root, envelope, host, transaction, now);
}

export function rollbackLegacyRecipeTrashCommand(
  database: DatabaseSync,
  root: string,
  input: LegacyRecipeTrashEnvelope,
  host: LegacyRecipeTrashHost,
  transaction: <T>(work: () => T) => T,
): { rolledBack: true; state: LegacyRecipeTrashRecoveryState } {
  const envelope = legacyRecipeTrashEnvelopeSchema.parse(input);
  if (!host.recoveryActorId || host.recoveryActorId !== envelope.actorId
    || host.authorize(envelope.actorId, "recipe-trash-recovery-rollback") !== true) {
    fail("FORBIDDEN", "Recipe trash rollback requires the explicitly configured native recovery actor and permission.");
  }
  const inspected = inspectLegacyRecipeTrashPending(database, root, envelope, host);
  if (inspected.state !== "before") {
    host.assertExclusive();
    applyTree(root, inspected.plan, "before");
    host.assertExclusive();
  }
  if (compareCurrent(root, inspected.plan) !== "before") fail("RECOVERY_CONFLICT", "Recipe trash rollback before-state did not verify exactly.");
  host.assertExclusive();
  transaction(() => {
    inTransaction(database);
    database.prepare("DELETE FROM legacy_recipe_trash_intent WHERE singleton=1 AND operation_id=?").run(envelope.operationId);
  });
  return { rolledBack: true, state: inspected.state };
}

function importHistory(controlBytes: Buffer, sourceRootId: string, sourceStoreVersion: number) {
  let value: unknown;
  try { value = JSON.parse(controlBytes.toString("utf8")); }
  catch { fail("IMPORT_UNSUPPORTED", "Original Project control is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("IMPORT_UNSUPPORTED", "Original Project control is not an object.");
  const controlValue = value as Record<string, unknown>;
  if (controlValue.schema !== 1 || controlValue.rootId !== sourceRootId
    || controlValue.storeVersion !== sourceStoreVersion || !Array.isArray(controlValue.receipts)
    || controlValue.receipts.length > 256) {
    fail("IMPORT_UNSUPPORTED", "Original Project control does not match the supported quiescent receipt format.");
  }
  const parsed = controlValue.receipts.map(item => originalReceiptSchema.parse(item));
  let priorVersion = 0;
  const ids = new Set<string>();
  for (const receipt of parsed) {
    if (ids.has(receipt.commandId) || receipt.storeVersion <= priorVersion || receipt.storeVersion > sourceStoreVersion) {
      fail("IMPORT_UNSUPPORTED", "Original Project command history is duplicated, unordered or out of range.");
    }
    ids.add(receipt.commandId);
    priorVersion = receipt.storeVersion;
  }
  if (controlValue.migration && !["cutover", "rolled-back"].includes(String((controlValue.migration as Record<string, unknown>).phase))) {
    fail("IMPORT_UNSUPPORTED", "Original Project migration must be quiescent before Recipe trash import.");
  }
  return parsed;
}

export function planLegacyRecipeTrashImport(
  sourceRoot: string,
  authority: LegacyRecipeTrashImportAuthority,
): LegacyRecipeTrashImportPlan {
  assertNoSymlinkAncestors(sourceRoot);
  const root = resolve(sourceRoot);
  const controlPath = inside(root, authority.sourceControlPath || ".pkm/state/project-store.json");
  const controlStat = lstatSync(controlPath);
  if (!controlStat.isFile() || controlStat.isSymbolicLink() || controlStat.size > MAX_FILE_BYTES) {
    fail("IMPORT_UNSUPPORTED", "Original Project control is not a bounded regular file.");
  }
  const controlBytes = readFileSync(controlPath);
  const receipts = importHistory(controlBytes, authority.sourceRootId, authority.sourceStoreVersion);
  const trashRoot = inside(root, "recipes/.trash");
  let stat;
  try { stat = lstatSync(trashRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") stat = undefined; else throw error; }
  const trashFiles: Extract<LegacyRecipeTrashTreeEntry, { kind: "file" }>[] = [];
  let totalBytes = 0;
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("IMPORT_UNSUPPORTED", "Original Recipe Trash is not a real directory.");
    for (const name of readdirSync(trashRoot).sort()) {
      const path = `recipes/.trash/${name}`;
      const absolute = inside(root, path);
      const fileStat = lstatSync(absolute);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || !name.endsWith(".json") || fileStat.size > MAX_FILE_BYTES) {
        fail("IMPORT_UNSUPPORTED", "Only canonical original Recipe Trash JSON files are supported.");
      }
      const bytes = readFileSync(absolute);
      if (bytes.length !== fileStat.size) fail("SOURCE_CHANGED", "Original Recipe Trash changed during import planning.");
      const id = /\.([A-Za-z][A-Za-z0-9._-]{0,127})\.json$/i.exec(name)?.[1];
      if (!id) fail("IMPORT_UNSUPPORTED", "Original Recipe Trash filename does not preserve a valid Recipe identity.");
      parseRecipe(bytes, id, true);
      totalBytes += bytes.length;
      if (trashFiles.length >= 4096 || totalBytes > MAX_TREE_BYTES) fail("RESOURCE_LIMIT", "Original Recipe Trash exceeds import limits.");
      trashFiles.push({ path, kind: "file", sha256: hash(bytes), base64: bytes.toString("base64") });
    }
  }
  const body = {
    schema: "pkm.legacy-recipe-trash-import/v1" as const,
    sourceRootId: authority.sourceRootId,
    sourceStoreVersion: authority.sourceStoreVersion,
    sourceControlSha256: hash(controlBytes),
    sourceControlBytes: controlBytes.toString("base64"),
    receipts,
    trashFiles,
    totalBytes,
  };
  return legacyRecipeTrashImportPlanSchema.parse({
    ...body,
    planSha256: hash(canonicalJson(body)),
  });
}

export function verifyLegacyRecipeTrashImportSource(
  sourceRoot: string,
  authority: LegacyRecipeTrashImportAuthority,
  input: LegacyRecipeTrashImportPlan,
): void {
  const plan = legacyRecipeTrashImportPlanSchema.parse(input);
  const current = planLegacyRecipeTrashImport(sourceRoot, authority);
  if (canonicalJson(current) !== canonicalJson(plan)) fail("IMPORT_SOURCE_CHANGED", "Original Recipe Trash or Project receipt history changed after planning.");
}

function validateLegacyRecipeTrashImportPlan(input: LegacyRecipeTrashImportPlan): LegacyRecipeTrashImportPlan {
  const plan = legacyRecipeTrashImportPlanSchema.parse(input);
  const { planSha256, ...body } = plan;
  if (hash(canonicalJson(body)) !== planSha256) fail("IMPORT_PLAN_DIGEST", "Recipe Trash import plan digest changed.");
  const controlBytes = Buffer.from(plan.sourceControlBytes, "base64");
  if (controlBytes.toString("base64") !== plan.sourceControlBytes
    || hash(controlBytes) !== plan.sourceControlSha256
    || canonicalJson(importHistory(controlBytes, plan.sourceRootId, plan.sourceStoreVersion)) !== canonicalJson(plan.receipts)) {
    fail("IMPORT_PLAN_DIGEST", "Recipe Trash import control bytes and receipt history do not match.");
  }
  const paths = new Set<string>();
  const portable = new Set<string>();
  let total = 0;
  for (const entry of plan.trashFiles) {
    if (!entry.path.startsWith("recipes/.trash/") || entry.path.split("/").length !== 3) {
      fail("IMPORT_UNSUPPORTED", "Recipe Trash import contains a path outside the original flat Trash directory.");
    }
    const bytes = Buffer.from(entry.base64, "base64");
    const name = entry.path.split("/").at(-1) || "";
    const id = /\.([A-Za-z][A-Za-z0-9._-]{0,127})\.json$/i.exec(name)?.[1];
    if (bytes.toString("base64") !== entry.base64 || hash(bytes) !== entry.sha256 || !id) {
      fail("IMPORT_PLAN_DIGEST", "Recipe Trash import file name or bytes do not match the captured original record.");
    }
    const recipe = parseRecipe(bytes, id, true);
    if (name !== safeRecipeFileName(String(recipe.name || ""), id)) {
      fail("IMPORT_PLAN_DIGEST", "Recipe Trash import path does not match the original Recipe name and identity.");
    }
    const key = entry.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (paths.has(entry.path) || portable.has(key)) fail("PORTABLE_COLLISION", "Recipe Trash import contains a path collision.");
    paths.add(entry.path); portable.add(key);
    total += bytes.length;
  }
  if (total !== plan.totalBytes || total > MAX_TREE_BYTES) fail("IMPORT_PLAN_DIGEST", "Recipe Trash import byte count changed.");
  return plan;
}

export function stageLegacyRecipeTrashImport(
  input: LegacyRecipeTrashImportPlan,
  destinationRoot: string,
): string {
  const plan = validateLegacyRecipeTrashImportPlan(input);
  const root = resolve(destinationRoot);
  assertNoSymlinkAncestors(root);
  const target = inside(root, "recipes/.trash");
  if (existsSync(target)) fail("IMPORT_COLLISION", "Recipe Trash import never merges or overwrites an existing destination.");
  for (const entry of plan.trashFiles) {
    const bytes = Buffer.from(entry.base64, "base64");
    if (hash(bytes) !== entry.sha256) fail("IMPORT_PLAN_DIGEST", "Recipe Trash import bytes differ from their plan.");
    const path = inside(root, entry.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const handle = openSync(path, "wx", 0o600);
    try { writeFileSync(handle, bytes); fsyncSync(handle); }
    finally { closeSync(handle); }
    fsyncDirectory(dirname(path));
  }
  if (plan.trashFiles.length === 0) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  return target;
}

export function verifyLegacyRecipeTrashImportStage(
  input: LegacyRecipeTrashImportPlan,
  destinationRoot: string,
): { bytes: number; trash: number; planSha256: string; history: LegacyRecipeTrashImportPlan["receipts"] } {
  const plan = validateLegacyRecipeTrashImportPlan(input);
  const target = inside(resolve(destinationRoot), "recipes/.trash");
  const rootStat = lstatSync(target);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("IMPORT_STAGE_INVALID", "Staged Recipe Trash is not a real directory.");
  const actual: Array<{ path: string; sha256: string; base64: string }> = [];
  function walk(directory: string): void {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, item.name);
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) fail("IMPORT_STAGE_INVALID", "Staged Recipe Trash contains an unsupported entry.");
      const bytes = readFileSync(absolute);
      actual.push({ path: `recipes/.trash/${relative(target, absolute).split(sep).join("/")}`, sha256: hash(bytes), base64: bytes.toString("base64") });
    }
  }
  walk(target);
  const expected = plan.trashFiles.map(({ path, sha256, base64 }) => ({ path, sha256, base64 }));
  if (canonicalJson(actual) !== canonicalJson(expected)) fail("IMPORT_STAGE_INVALID", "Staged Recipe Trash does not preserve original paths and exact bytes.");
  return { bytes: plan.totalBytes, trash: plan.trashFiles.length, planSha256: plan.planSha256, history: plan.receipts };
}

export { legacyRecipeTrashOriginal };
