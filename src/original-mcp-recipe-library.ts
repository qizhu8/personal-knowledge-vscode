import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import { assertRootOwner, type RootOwner } from "./root-owner.js";
import type { Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, originalMcpPublicRequestMatches, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import { openOriginalMcpCustodyReader } from "./original-mcp-root.js";
import type { OriginalMcpJournal } from "./original-mcp-root-custody.js";
import type { OriginalMcpNativeHostReceipt } from "./original-mcp-native-host-receipt.js";
import { readOriginalMcpRecipeHistoricalHost } from "./original-mcp-recipe-history.js";
import { canonicalJson, compileWorkflowDefinitionV1 } from "./domain/project-recipes-workflow-contracts.js";
import { validateRecipeRecord, recipeIdFromFile, normalizeRecipeCategory } from "./domain/project-recipes-storage-rules.js";
import { assertReportedRecipeNumbers } from "./legacy-recipe-reported-usage.js";
import { searchLocalRecipes } from "./legacy-recipe-search.js";
import { legacyRecipeSearchInput } from "./recipe-public-contracts.js";
import type { ProjectRecipeRecord } from "./project-recipes.js";
import {
  originalRecipeLibrarySource, originalRecipeLibraryApprovalRequest, originalRecipeSourceApproval,
  type OriginalRecipeLibrarySource, type OriginalRecipeSourceApprovalRequest,
  type OriginalRecipeSourceApproval, type OriginalRecipeSourcePolicy,
} from "./original-mcp-recipe-source-contracts.js";
import {
  assertOriginalMcpNativeRecipeSourcePolicy, retainOriginalMcpNativeRecipeSourceApproval,
  assertOriginalMcpNativeRecipeSourceApprovalCurrent, originalMcpNativeRecipeSourceApprovalSignal,
} from "./original-mcp-native-recipe-policy.js";

type Json = Record<string, any>;
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const control = ".pkm/state/recipe-store.json";
const ddl = `CREATE TABLE original_recipe_library_source(singleton INTEGER PRIMARY KEY CHECK(singleton=1),source TEXT NOT NULL,record TEXT NOT NULL,approval TEXT NOT NULL);
 CREATE TRIGGER original_recipe_library_source_no_update BEFORE UPDATE ON original_recipe_library_source
 BEGIN SELECT RAISE(ABORT,'original Recipe Library source immutable'); END;
 CREATE TRIGGER original_recipe_library_source_no_delete BEFORE DELETE ON original_recipe_library_source
 BEGIN SELECT RAISE(ABORT,'original Recipe Library source immutable'); END;`;
export const originalMcpRecipeLibraryDdl = ddl;
const plans = new WeakMap<object, { owner: RootOwner; host: OriginalMcpNativeHost; digest: string; recipe: ProjectRecipeRecord }>();
interface Session {
  owner: RootOwner; host: OriginalMcpNativeHost; source: OriginalRecipeLibrarySource; recipe: ProjectRecipeRecord;
  approval: OriginalRecipeSourceApproval; policy: OriginalRecipeSourcePolicy; request: OriginalRecipeSourceApprovalRequest;
  lifetime: AbortController;
}
const sessions = new WeakMap<Storage, Session>(), retained = new WeakSet<Storage>();
function fail(message: string): never { throw new CoreError("ACCESS_DENIED", `ORIGINAL_RECIPE_LIBRARY_SOURCE_REQUIRED: ${message}`); }
export async function originalRecipeLibraryScope(owner: RootOwner, host: OriginalMcpNativeHost) {
  assertRootOwner(owner);
  const { storage, runtime } = await owner.ensureFull();
  owner.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
  const journal = assertOriginalMcpPrivacy(owner.workspaceRoot());
  if (!journal || !host.receipt.domains.includes("mcp-public")) fail("Actual custody/current native host are required.");
  return { storage, runtime, journal };
}
const pin = (root: string, path: string) => {
  const stat = lstatSync(join(root, path), { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail("Source must remain single-link regular files.");
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid].join(":");
};
function canonicalBytes(root: string, path: string, maximumBytes: number) {
  if (!["recipes/", "project/"].some(prefix => path.startsWith(prefix))
    || path.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\")))
    fail("An exact canonical source path is required.");
  let ancestor = root;
  for (const part of path.split("/").slice(0, -1)) {
    ancestor = join(ancestor, part);
    const stat = lstatSync(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Canonical source ancestors changed.");
  }
  const before = pin(root, path), fd = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    const descriptorPin = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid].join(":");
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(maximumBytes) || descriptorPin !== before)
      fail("Canonical source exceeded its exact single-file envelope or changed while opening.");
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    const after = fstatSync(fd, { bigint: true });
    if (length !== Number(stat.size) || before !== pin(root, path)
      || descriptorPin !== [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs, after.mode, after.uid].join(":"))
      fail("Canonical source changed during independent admission.");
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}
function membership(root: string) {
  const files = [control]; let entries = 0;
  const visit = (path: string, depth: number) => {
    if (depth > 16 || ++entries > 1024) fail("Recipe source membership exceeds the explicit bounded canonical library.");
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) fail("Canonical Recipe source cannot contain aliases.");
    if (stat.isDirectory()) {
      for (const name of readdirSync(join(root, path)).sort()) {
        if (path === "recipes" && name === ".trash") continue;
        visit(`${path}/${name}`, depth + 1);
      }
    } else if (stat.isFile() && path.endsWith(".json")) files.push(path);
    else fail("Unknown canonical Recipe source entry.");
  };
  visit("recipes", 0);
  if (files.length > 128) fail("At most 127 canonical Recipe files may be independently admitted in this source envelope.");
  return files.sort();
}
function projectMembership(root: string) {
  const paths = [".pkm/state/projects.json"];
  if (!existsSync(join(root, ".pkm/state/project-store.json"))) return paths;
  paths.push(".pkm/state/project-store.json");
  let entries = 0;
  const visit = (path: string, depth: number) => {
    if (++entries > 1024 || depth > 16) fail("Project source membership exceeded its explicit envelope.");
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) fail("Project source aliases are forbidden.");
    if (stat.isDirectory()) {
      for (const name of readdirSync(join(root, path)).sort()) {
        if (path === "project" && name === ".trash") continue;
        visit(`${path}/${name}`, depth + 1);
      }
    } else if (stat.isFile() && path.endsWith(".json")) paths.push(path);
    else fail("Unknown canonical Project source entry.");
  };
  visit("project", 0);
  return paths.sort();
}
function checkPlan(source: OriginalRecipeLibrarySource, receipt: OriginalMcpNativeHostReceipt) {
  source = originalRecipeLibrarySource.parse(source);
  const { planSha256, ...body } = source;
  if (digest(body) !== planSha256 || digest(source.files) !== source.sourceSha256 || source.root !== receipt.root
    || source.workspaceId !== receipt.workspaceId || source.custodyPlanSha256 !== receipt.planSha256
    || source.profileSha256 !== receipt.profileSha256) fail("Library source plan/root/profile/custody changed.");
}
function checkPins(source: OriginalRecipeLibrarySource) {
  if (canonicalJson(membership(source.root)) !== canonicalJson(source.files.map(file => file.path).sort())
    || source.files.some(file => pin(source.root, file.path) !== file.pin)) fail("Canonical Library source membership or bytes changed.");
}
function json(bytes: Buffer): Json {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  assertReportedRecipeNumbers(value, "Original Recipe Library");
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected an original Library JSON record.");
  return value as Json;
}
function record(value: Json, path: string): ProjectRecipeRecord {
  validateRecipeRecord(value as ProjectRecipeRecord);
  if (value.schema !== "pkm.knowledge/v1" || !/^knowledge_[a-f0-9]{24}$/.test(value.knowledgeId)
    || !Array.isArray(value.aliases) || !value.aliases.length || value.aliases.some((alias: unknown) => typeof alias !== "string")
    || recipeIdFromFile(path) !== value.recipeId) fail("Original Recipe filename/Knowledge identity changed.");
  const category = path.slice("recipes/".length, path.lastIndexOf("/"));
  if (normalizeRecipeCategory(value.category) !== (category === "Uncategorized" ? "" : category))
    fail("Original Recipe category does not match canonical source path.");
  return structuredClone(value) as ProjectRecipeRecord;
}
function qualify(recipe: ProjectRecipeRecord) {
  const compiled = compileWorkflowDefinitionV1(recipe.definition);
  if (!compiled.ok || compiled.executableDigest !== recipe.executableDigest || recipe.nodeBindings?.some(node => node.bindings.length)
    || compiled.model.spec.trigger || compiled.model.spec.nodes.length > 128 || compiled.model.spec.nodes.some(node =>
      node.dependsOn.some(edge => edge.loop)
      || (node.kind === "pkm.step.noop/v1"
        ? node.control?.mode === "repeat" || node.control?.mode === "branch" && node.control.dynamicCases
        : !["pkm.step.command/v1", "pkm.step.script/v1", "pkm.step.pipeline/v1"].includes(node.kind)
          || node.control && node.control.mode !== "single")))
    fail("This Library source supports compiled static unbound NoOp/command/Script/Pipeline definitions only; no dynamic/repeat/trigger/subflow/native/Knowledge graph authority is admitted.");
  return compiled.model;
}
async function fresh(owner: RootOwner, host: OriginalMcpNativeHost, source: OriginalRecipeLibrarySource, signal?: AbortSignal) {
  const { journal } = await originalRecipeLibraryScope(owner, host);
  checkPlan(source, host.receipt); checkPins(source); signal?.throwIfAborted();
  const reader = await openOriginalMcpCustodyReader(journal.plan);
  try {
    let selected: ProjectRecipeRecord | undefined;
    const recipes: ProjectRecipeRecord[] = [];
    const ids = new Set<string>(), knowledgeIds = new Set<string>();
    for (const file of source.files) {
      signal?.throwIfAborted(); host.signal.throwIfAborted();
      const bytes = file.path === control ? await reader.read(file.path, source.maxFileBytes)
        : canonicalBytes(source.root, file.path, source.maxFileBytes);
      if (hash(bytes) !== file.sha256 || bytes.length !== file.bytes) fail("Library differs from its independently captured original source.");
      const value = json(bytes);
      if (file.path === control) {
        if (value.schema !== 1) fail("Canonical original Recipe store control is unsupported.");
      } else {
        const recipe = record(value, file.path);
        if (ids.has(recipe.recipeId) || knowledgeIds.has(recipe.knowledgeId!)) fail("Original Recipe or Knowledge identity is ambiguous.");
        ids.add(recipe.recipeId); knowledgeIds.add(recipe.knowledgeId!);
        recipes.push(recipe);
        if (recipe.recipeId === source.recipeId) selected = recipe;
      }
    }
    if (!selected || selected.revision !== source.revision || selected.executableDigest !== source.executableDigest
      || digest(selected) !== source.recordSha256 || canonicalJson(qualify(selected).spec.nodes.map(node => node.nodeId)) !== canonicalJson(source.nodeIds))
      fail("Selected Library revision/definition changed.");
    reader.assertCurrent(); checkPins(source); await originalRecipeLibraryScope(owner, host);
    return { recipe: selected, recipes };
  } finally { reader.close(); }
}
function schema(db: DatabaseSync) {
  const expected = new DatabaseSync(":memory:");
  const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'original_recipe_library_source%' ORDER BY name";
  try { expected.exec(ddl); if (canonicalJson(db.prepare(query).all()) !== canonicalJson(expected.prepare(query).all())) fail("Immutable Library admission schema changed."); }
  finally { expected.close(); }
}
export async function verifyOriginalMcpRecipeLibraryReadState(db: DatabaseSync, journal: OriginalMcpJournal) {
  schema(db);
  const rows = db.prepare("SELECT * FROM original_recipe_library_source").all(), row = rows[0];
  if (rows.length !== 1 || typeof row?.source !== "string" || typeof row.record !== "string") fail("Incomplete historical Library source.");
  const source = originalRecipeLibrarySource.parse(JSON.parse(row.source));
  const host = readOriginalMcpRecipeHistoricalHost(db, journal, source, String(row.approval));
  checkPlan(source, host); checkPins(source);
  const reader = await openOriginalMcpCustodyReader(journal.plan);
  let selected: ProjectRecipeRecord | undefined;
  try {
    for (const file of source.files) {
      const raw = file.authority === "sealed-custody" ? await reader.read(file.path, source.maxFileBytes)
        : canonicalBytes(source.root, file.path, source.maxFileBytes);
      if (hash(raw) !== file.sha256 || raw.length !== file.bytes) fail("Historical Library source bytes changed.");
      if (file.path !== control) {
        const candidate = record(json(raw), file.path);
        if (candidate.recipeId === source.recipeId) selected = candidate;
      }
    }
    reader.assertCurrent();
  } finally { reader.close(); }
  if (!selected || row.source !== canonicalJson(source) || row.record !== canonicalJson(selected)
    || digest(selected) !== source.recordSha256 || selected.revision !== source.revision
    || selected.executableDigest !== source.executableDigest) fail("Historical Library record/definition changed.");
  qualify(selected);
  return { source, recipe: selected };
}
export async function planOriginalMcpRecipeLibrary(owner: RootOwner, host: OriginalMcpNativeHost,
  input: { recipeId: string; expectedRevision: number; expectedExecutableDigest: string; maxFileBytes: number }) {
  const { journal } = await originalRecipeLibraryScope(owner, host);
  if (!Number.isSafeInteger(input.maxFileBytes) || input.maxFileBytes < 1 || input.maxFileBytes > 2_097_152)
    throw new CoreError("INVALID_ARGUMENT", "An explicit Library source read budget is required.");
  const reader = await openOriginalMcpCustodyReader(journal.plan);
  try {
    const files: OriginalRecipeLibrarySource["files"] = [];
    let selected: ProjectRecipeRecord | undefined;
    for (const path of membership(journal.plan.root)) {
      const bytes = path === control ? await reader.read(path, input.maxFileBytes)
        : canonicalBytes(journal.plan.root, path, input.maxFileBytes);
      files.push({ path, sha256: hash(bytes), bytes: bytes.length, pin: pin(journal.plan.root, path),
        authority: path === control ? "sealed-custody" : "independent-canonical" });
      if (path !== control) {
        const candidate = record(json(bytes), path);
        if (candidate.recipeId === input.recipeId) selected = candidate;
      }
    }
    if (!selected || selected.revision !== input.expectedRevision || selected.executableDigest !== input.expectedExecutableDigest)
      throw new CoreError("CONFLICT", "The independently selected original Library identity/revision/digest changed.");
    const definition = qualify(selected);
    const body = { schema: "pkm.original-recipe-library-source/v1" as const, root: journal.plan.root, workspaceId: journal.workspaceId,
      custodyPlanSha256: journal.plan.planSha256, profileSha256: journal.plan.profileSha256, files, sourceSha256: digest(files),
      recipeId: selected.recipeId, revision: selected.revision, executableDigest: selected.executableDigest, recordSha256: digest(selected),
      nodeIds: definition.spec.nodes.map(node => node.nodeId), maxFileBytes: input.maxFileBytes,
      protocol: "controlled-external-report/v1" as const, effects: ["caller-reported-result-only"] as ["caller-reported-result-only"], noExecution: true as const };
    const source = originalRecipeLibrarySource.parse({ ...body, planSha256: digest(body) });
    await fresh(owner, host, source);
    plans.set(source, { owner, host, digest: source.planSha256, recipe: selected });
    return source;
  } finally { reader.close(); }
}
function revoke(storage: Storage) { const state = sessions.get(storage); sessions.delete(storage); state?.lifetime.abort(); }
function bind(storage: Storage, session: Session) {
  revoke(storage); sessions.set(storage, session);
  const signal = originalMcpNativeRecipeSourceApprovalSignal(session.approval)!;
  const revoked = () => { if (sessions.get(storage) === session) revoke(storage); };
  signal.addEventListener("abort", revoked, { once: true }); if (signal.aborted) revoked();
  if (!retained.has(storage)) { retained.add(storage); storage.retainNativeCleanup({ release() { revoke(storage); } }); }
}
async function approve(owner: RootOwner, host: OriginalMcpNativeHost, source: OriginalRecipeLibrarySource,
  policy: OriginalRecipeSourcePolicy, phase: "admit" | "activate", signal?: AbortSignal) {
  const { storage } = await originalRecipeLibraryScope(owner, host);
  assertOriginalMcpNativeRecipeSourcePolicy(policy, owner, host); revoke(storage);
  const request = originalRecipeLibraryApprovalRequest.parse({ ...source, phase, actorId: "mcp:external",
    epoch: host.receipt.epoch, nativeHostReceiptSha256: host.receipt.receiptSha256 });
  const cancelled = AbortSignal.any([policy.signal, host.signal, ...(signal ? [signal] : [])]);
  cancelled.throwIfAborted();
  const observed = await policy.authorize(request, cancelled);
  cancelled.throwIfAborted();
  if (!observed) fail("Fresh independently signed Library source admission was denied.");
  const approval = originalRecipeSourceApproval.parse(observed);
  retainOriginalMcpNativeRecipeSourceApproval(observed, approval, request);
  if (!originalMcpNativeRecipeSourceApprovalSignal(approval) || approval.requestSha256 !== digest(request)
    || approval.expiresAtMs <= Date.now() || approval.expiresAtMs > Date.now() + 300000)
    fail("Actual exact bounded native Library source decision is required.");
  const { recipe } = await fresh(owner, host, source, cancelled);
  assertOriginalMcpNativeRecipeSourceApprovalCurrent(approval);
  return { storage, recipe, approval, request };
}
export async function admitOriginalMcpRecipeLibrary(owner: RootOwner, host: OriginalMcpNativeHost,
  source: OriginalRecipeLibrarySource, policy: OriginalRecipeSourcePolicy, signal?: AbortSignal) {
  const prepared = plans.get(source);
  if (!prepared || prepared.owner !== owner || prepared.host !== host || prepared.digest !== source.planSha256) fail("Actual same-owner Library planner required.");
  const original = source; source = structuredClone(source);
  const { storage, recipe, approval, request } = await approve(owner, host, source, policy, "admit", signal);
  await storage.withWorkspaceExclusive(() => {
    const db = storage.connectNative();
    try {
      assertOriginalMcpNativeRecipeSourceApprovalCurrent(approval); signal?.throwIfAborted(); checkPins(source);
      db.exec("BEGIN IMMEDIATE");
      if (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'original_recipe_library_source%'").get()) fail("Library source already sealed; separately reactivate it.");
      db.exec(ddl);
      db.prepare("INSERT INTO original_recipe_library_source VALUES(1,?,?,?)").run(canonicalJson(source), canonicalJson(recipe), canonicalJson(approval));
      storage.assertWorkspaceLease(); assertOriginalMcpNativeRecipeSourceApprovalCurrent(approval); signal?.throwIfAborted();
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    finally { db.close(); }
  });
  bind(storage, { owner, host, source, recipe, approval, request, policy, lifetime: new AbortController() }); plans.delete(original);
  return structuredClone(source);
}
export async function activateOriginalMcpRecipeLibrary(owner: RootOwner, host: OriginalMcpNativeHost,
  policy: OriginalRecipeSourcePolicy, signal?: AbortSignal) {
  const { storage } = await originalRecipeLibraryScope(owner, host), db = storage.connectNative();
  let source: OriginalRecipeLibrarySource;
  try {
    schema(db);
    const row = db.prepare("SELECT source,record FROM original_recipe_library_source WHERE singleton=1").get();
    if (typeof row?.source !== "string" || typeof row.record !== "string") fail("No sealed Library source.");
    source = originalRecipeLibrarySource.parse(JSON.parse(row.source));
    if (digest(JSON.parse(row.record)) !== source.recordSha256) fail("Sealed Library source record changed.");
  } finally { db.close(); }
  const { recipe, approval, request } = await approve(owner, host, source, policy, "activate", signal);
  bind(storage, { owner, host, source, recipe, approval, request, policy, lifetime: new AbortController() });
  return structuredClone(source);
}
/** Synchronous denial checks used at the native scheduler/lease/output boundaries. */
export function originalMcpRecipeLibrarySession(storage: Storage, owner: RootOwner, host: OriginalMcpNativeHost) {
  const state = sessions.get(storage);
  assertRootOwner(owner); owner.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
  if (!state || state.owner !== owner || state.host !== host || state.lifetime.signal.aborted) fail("A fresh independent Library source decision is required.");
  assertOriginalMcpNativeRecipeSourcePolicy(state.policy, owner, host);
  assertOriginalMcpNativeRecipeSourceApprovalCurrent(state.approval); checkPlan(state.source, host.receipt); checkPins(state.source);
  return { source: structuredClone(state.source), recipe: structuredClone(state.recipe), signal: state.lifetime.signal };
}
export async function verifyOriginalMcpRecipeLibrary(owner: RootOwner, host: OriginalMcpNativeHost, signal?: AbortSignal) {
  const { storage } = await originalRecipeLibraryScope(owner, host), session = originalMcpRecipeLibrarySession(storage, owner, host);
  const cancelled = AbortSignal.any([session.signal, ...(signal ? [signal] : [])]);
  const { recipes } = await fresh(owner, host, session.source, cancelled); cancelled.throwIfAborted();
  originalMcpRecipeLibrarySession(storage, owner, host);
  return { ...session, recipes };
}
/** Routing classification only; presence never grants source, read or execution authority. */
export async function originalMcpRecipeLibrarySourceExists(owner: RootOwner, host: OriginalMcpNativeHost) {
  const { storage } = await originalRecipeLibraryScope(owner, host), db = storage.connectNative();
  try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='original_recipe_library_source'").get(); }
  finally { db.close(); }
}
export async function readOriginalMcpRecipeLibrarySearch(owner: RootOwner, host: OriginalMcpNativeHost,
  actor: Readonly<Actor>, args: Record<string, unknown>, signal?: AbortSignal) {
  const { storage } = await originalRecipeLibraryScope(owner, host);
  if (actor.id !== "mcp:external" || actor.boardWorker
    || !originalMcpPublicRequestMatches(storage, host, { operation: "mcp.tool.recipe_search", tool: "recipe_search",
      version: 1, readOnly: true, arguments: args, argumentsDigest: digest(args) }))
    throw new CoreError("ACCESS_DENIED", "Exact fresh native public Library search approval is required.");
  const session = await verifyOriginalMcpRecipeLibrary(owner, host, signal);
  const result = searchLocalRecipes(session.recipes, legacyRecipeSearchInput.parse(args));
  signal?.throwIfAborted(); originalMcpRecipeLibrarySession(storage, owner, host);
  return result;
}
export async function captureOriginalMcpRecipeLibraryBase(owner: RootOwner, host: OriginalMcpNativeHost,
  maxFileBytes = 2_097_152, includeProjectSource = false) {
  const { journal } = await originalRecipeLibraryScope(owner, host);
  return captureOriginalMcpRecipeLibraryJournalBase(journal, maxFileBytes, includeProjectSource);
}
export async function captureOriginalMcpRecipeLibraryJournalBase(journal: OriginalMcpJournal,
  maxFileBytes = 2_097_152, includeProjectSource = false) {
  const reader = await openOriginalMcpCustodyReader(journal.plan);
  try {
    const files: OriginalRecipeLibrarySource["files"] = [], recipes: ProjectRecipeRecord[] = [];
    let projects: Array<{ projectId: string; name: string }> = [];
    const paths = !existsSync(join(journal.plan.root, "recipes")) && !existsSync(join(journal.plan.root, control))
      ? [] : membership(journal.plan.root);
    if (includeProjectSource) paths.push(...projectMembership(journal.plan.root));
    paths.sort();
    const ids = new Set<string>(), knowledge = new Set<string>();
    for (const path of paths) {
      const sealed = path.startsWith(".pkm/");
      const bytes = sealed ? await reader.read(path, maxFileBytes)
        : canonicalBytes(journal.plan.root, path, maxFileBytes);
      files.push({ path, sha256: hash(bytes), bytes: bytes.length, pin: pin(journal.plan.root, path),
        authority: sealed ? "sealed-custody" : "independent-canonical" });
      const value = json(bytes);
      if (path === ".pkm/state/projects.json") {
        if (value.schema !== 1 || !Number.isSafeInteger(value.storeVersion) || !value.payload
          || digest(value.payload) !== value.digest || !Array.isArray(value.payload.state?.projects))
          fail("Current original Project source envelope changed.");
        projects = value.payload.state.projects.map((project: Json) => {
          if (typeof project.projectId !== "string" || typeof project.name !== "string")
            fail("Invalid current Project source identity.");
          return { projectId: project.projectId, name: project.name };
        });
      } else if (path === ".pkm/state/project-store.json") {
        if (value.schema !== 1 || !Number.isSafeInteger(value.storeVersion) || !/^[a-f0-9]{64}$/.test(value.canonicalDigest))
          fail("Invalid canonical Project source control.");
      } else if (path.startsWith("project/")) {
        continue;
      } else if (path === control) { if (value.schema !== 1) fail("Unsupported canonical Recipe control."); }
      else {
        const candidate = record(value, path);
        if (ids.has(candidate.recipeId) || knowledge.has(candidate.knowledgeId!)) fail("Ambiguous canonical Recipe identity.");
        ids.add(candidate.recipeId); knowledge.add(candidate.knowledgeId!); recipes.push(candidate);
      }
    }
    if (includeProjectSource && files.some(file => file.path === ".pkm/state/project-store.json")) {
      const { ProjectFilesystemStore } = createRequire(import.meta.url)("../legacy/dist/workflows/project-filesystem-store.js") as {
        ProjectFilesystemStore: new (stateDirectory: string) => { list(): { projects: Array<{ projectId: string; name: string }> } };
      };
      const store = new ProjectFilesystemStore(join(journal.plan.root, ".pkm/state"));
      // The retained list method otherwise rolls forward pending writes; source capture must remain read-only.
      Object.defineProperty(store, "recoverPendingCommit", { value() {
        if (existsSync(join(journal.plan.root, ".pkm/state/project-store-intent.json")))
          fail("Pending original Project writes require separate explicit recovery.");
      } });
      const snapshot = store.list();
      projects = snapshot.projects.map(project => ({ projectId: project.projectId, name: project.name }));
      assertOriginalMcpNativeRecipeLibraryFiles({ root: journal.plan.root, files });
    }
    reader.assertCurrent();
    return { files, recipes, projects, snapshotRevision: digest(files) };
  } finally { reader.close(); }
}
export function originalMcpRecipeLibraryCurrentPolicy(storage: Storage, owner: RootOwner, host: OriginalMcpNativeHost) {
  const state = sessions.get(storage);
  if (!state || state.owner !== owner || state.host !== host) fail("No retained canonical Recipe source policy.");
  originalMcpRecipeLibrarySession(storage, owner, host);
  return state.policy;
}
export function assertOriginalMcpNativeRecipeLibraryFiles(source: { root: string; files: OriginalRecipeLibrarySource["files"] }) {
  const expected = source.files.filter(file => file.path.startsWith("recipes/") || file.path === control).map(file => file.path).sort();
  const actual = !existsSync(join(source.root, "recipes")) && !existsSync(join(source.root, control)) ? [] : membership(source.root);
  if (canonicalJson(expected) !== canonicalJson(actual)) fail("Canonical native Recipe source membership changed.");
  if (source.files.some(file => file.path === ".pkm/state/projects.json")) {
    const projects = source.files.filter(file => file.path.startsWith("project/") || file.path.startsWith(".pkm/state/project"))
      .map(file => file.path).sort();
    if (canonicalJson(projects) !== canonicalJson(projectMembership(source.root))) fail("Canonical Project source membership changed.");
  }
  for (const file of source.files) {
    let ancestor = source.root;
    for (const segment of file.path.split("/").slice(0, -1)) {
      ancestor = join(ancestor, segment);
      const stat = lstatSync(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Native Recipe source ancestor changed.");
    }
    if (pin(source.root, file.path) !== file.pin) fail("Native Recipe source pin changed.");
  }
}
