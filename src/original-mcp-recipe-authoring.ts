import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import type { RootOwner } from "./root-owner.js";
import type { Storage } from "./storage.js";
import type { ProjectRecipeRecord } from "./project-recipes.js";
import { originalLocalRecipeSummary } from "./legacy-recipe-search.js";
import { NativeRecipeLibrary, nativeRecipeLibraryDdl, nativeRecipePayloadReceiptPrefix,
  nativeRecipePayloadReceiptSchema, type LibraryRecord } from "./native-recipe-library.js";
import { recipeLibraryEditable } from "./recipe-library-fields.js";
import { canonicalJson, compileWorkflowDefinitionV1 } from "./domain/project-recipes-workflow-contracts.js";
import { workflowRuntimeBindingsFromOriginalInputs } from "./domain/workflow-executor-bindings.js";
import { normalizeLegacyRecipeInputs } from "./domain/legacy-recipe-run-inputs.js";
import { normalizeRecipeNodeBindings } from "./domain/workflow-compiler-bindings.js";
import { normalizeRecipeCategory, safeRecipeCategorySegment } from "./domain/project-recipes-storage-rules.js";
import { decodeMarkdownPath, readKnowledgePathSnapshot, type MarkdownRecord } from "./markdown.js";
import { resolveRecipeKnowledgeContext, recipeKnowledgeForNode, type RecipeKnowledgeContext } from "./recipe-knowledge-context.js";
import {
  originalNativeRecipeLibrarySource, originalNativeRecipeLibraryApprovalRequest,
  originalRecipeSourceApproval, type OriginalNativeRecipeLibrarySource, type OriginalRecipeSourcePolicy,
  type OriginalRecipeSourceApproval,
} from "./original-mcp-recipe-source-contracts.js";
import {
  assertOriginalMcpNativeRecipeSourceApprovalCurrent, retainOriginalMcpNativeRecipeSourceApproval,
  originalMcpNativeRecipeSourceApprovalSignal, originalMcpNativeRecipeSourcePolicyForOwner,
  originalMcpNativeRecipeSourcePolicySession, assertOriginalMcpNativeRecipeSourcePolicy,
} from "./original-mcp-native-recipe-policy.js";
import { originalMcpPublicRequestMatches, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { captureOriginalMcpRecipeLibraryBase, captureOriginalMcpRecipeLibraryJournalBase,
  assertOriginalMcpNativeRecipeLibraryFiles, originalRecipeLibraryScope } from "./original-mcp-recipe-library.js";
import { readOriginalMcpRecipeHistoricalHost } from "./original-mcp-recipe-history.js";
import type { OriginalMcpJournal } from "./original-mcp-root-custody.js";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const uuid = (value: string) => {
  const h = createHash("sha256").update(value).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const receiptPrefix = "original-native-recipe:";
const sourceReceipt = z.strictObject({
  schema: z.literal("pkm.original-native-recipe-receipt/v1"),
  kind: z.enum(["author", "admit", "adhoc"]),
  source: originalNativeRecipeLibrarySource, approval: originalRecipeSourceApproval,
  record: z.json(), nativeInput: z.json().nullable(), publicArguments: z.record(z.string(), z.json()),
});
const fromSkillInput = z.strictObject({
  name: z.string(), description: z.string().default(""), category: z.string().default(""), definition_json: z.string(),
  command_id: z.string(), source_skill_id: z.string(), source_skill_hash: z.string(),
  scope: z.string().default("global"), project_id: z.string().default(""), source_skill_node_id: z.string().default(""),
});
export const originalRecipeAdhocInput = z.strictObject({
  name: z.string().refine(value => !!value.trim()), definition_json: z.string(),
  command_id: z.string().refine(value => !!value.trim()), inputs_json: z.string().default("{}"),
  node_bindings_json: z.string().default("[]"),
  detail: z.string().default("compact").transform(value => (value || "compact").trim().toLowerCase()).pipe(z.enum(["compact", "full"])),
  autonomous: z.boolean().default(false), max_auto_nodes: z.number().int().min(1).max(1000).default(100),
  max_auto_seconds: z.number().int().min(1).max(3600).default(300),
});
type Base = Awaited<ReturnType<typeof captureOriginalMcpRecipeLibraryBase>>;
type NativeInput = Parameters<NativeRecipeLibrary["save"]>[0];
interface State {
  owner: RootOwner; host: OriginalMcpNativeHost; source: OriginalNativeRecipeLibrarySource;
  recipe: ProjectRecipeRecord; policy: OriginalRecipeSourcePolicy; approval: OriginalRecipeSourceApproval;
  lifetime: AbortController; context: RecipeKnowledgeContext; base: Base;
  recipes?: ProjectRecipeRecord[]; contexts?: Map<string, RecipeKnowledgeContext>;
}
const states = new WeakMap<Storage, State>();
const metadataStates = new WeakMap<Storage, State>();
function deny(message: string): never { throw new CoreError("ACCESS_DENIED", `NATIVE_RECIPE_LIBRARY_REQUIRED: ${message}`); }
function parseDefinition(value: unknown) {
  if (Buffer.byteLength(canonicalJson(value)) > 262144) deny("Definition exceeds its exact compiler budget.");
  const compiled = compileWorkflowDefinitionV1(value);
  if (!compiled.ok || compiled.model.spec.nodes.length > 128) deny("Invalid or oversized Recipe definition.");
  return compiled;
}
function databaseSchema(database: DatabaseSync) {
  const expected = new DatabaseSync(":memory:");
  const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'native_recipe_library_%' ORDER BY name";
  try {
    expected.exec(nativeRecipeLibraryDdl);
    if (canonicalJson(database.prepare(query).all()) !== canonicalJson(expected.prepare(query).all()))
      deny("Native Library schema differs from its canonical existing authority.");
  } finally { expected.close(); }
}
function rows(database: DatabaseSync, workspaceId: string) {
  databaseSchema(database);
  const result = database.prepare("SELECT * FROM native_recipe_library_records ORDER BY recipe_id").all();
  if (result.length > 127 || result.some(row => row.workspace_id !== workspaceId)) deny("Foreign or oversized native Library.");
  return result;
}
function nativeSnapshot(database: DatabaseSync, workspaceId: string) { return hash(rows(database, workspaceId)); }
function projection(record: LibraryRecord, publicId: string): ProjectRecipeRecord {
  return { ...structuredClone(record), recipeId: publicId };
}
function locateKnowledge(database: DatabaseSync, root: string, kind: "note" | "skill", key: string) {
  const area = kind === "skill" ? "skills" : "notes";
  if (!key || key.length > 256 || key.includes("\\") || key.startsWith("/")
    || key.split("/").some(part => !part || part === "." || part === "..")) deny("Knowledge needs an exact typed identity.");
  let indexed = database.prepare("SELECT id,path FROM documents WHERE area=? AND deleted=0 AND (id=? OR path=?)")
    .all(area, key, key.endsWith(".md") ? key : `${key}.md`);
  if (!indexed.length && /^knowledge_[a-f0-9]{24}$/.test(key)) {
    const candidates = database.prepare("SELECT id,path FROM documents WHERE area=? AND deleted=0 LIMIT 4097").all(area);
    if (candidates.length > 4096) deny("Knowledge identity lookup exceeded its document envelope.");
    let bytes = 0;
    indexed = candidates.filter(candidate => {
      const snapshot = readKnowledgePathSnapshot(root, String(candidate.path), area, true);
      if (!snapshot.file) return false;
      bytes += snapshot.file.size;
      if (snapshot.file.size > 2_097_152 || bytes > 8_388_608) deny("Knowledge identity lookup exceeded its byte envelope.");
      const document = decodeMarkdownPath(new TextDecoder("utf-8", { fatal: true }).decode(snapshot.file.bytes), String(candidate.path), area);
      return document.metadata.get("knowledgeId") === key;
    });
  }
  if (indexed.length > 1) deny("Ambiguous current Knowledge identity.");
  return { area: area as "skills" | "notes", path: indexed.length ? String(indexed[0]!.path)
    : key.endsWith(".md") ? key : `${key}.md` };
}
function knowledge(database: DatabaseSync, root: string, recipe: ProjectRecipeRecord) {
  const compiled = parseDefinition(recipe.definition);
  const bindings = normalizeRecipeNodeBindings(recipe.nodeBindings ?? [], new Set(compiled.model.spec.nodes.map(node => node.nodeId)));
  if (bindings.reduce((n, node) => n + node.bindings.length, 0) > 128) deny("Knowledge binding budget exceeded.");
  const documents: MarkdownRecord[] = [], pins: OriginalNativeRecipeLibrarySource["knowledgePins"] = [];
  const seen = new Set<string>();
  for (const binding of bindings.flatMap(node => node.bindings)) {
    const key = `${binding.kind}\0${binding.knowledgeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const address = locateKnowledge(database, root, binding.kind, binding.knowledgeId);
    const snapshot = readKnowledgePathSnapshot(root, address.path, address.area, true);
    if (!snapshot.file || snapshot.file.size > 2_097_152) deny("Required Knowledge is absent, private or oversized.");
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.file.bytes);
    const document = decodeMarkdownPath(raw, address.path, address.area);
    const modern = document.metadata.get("knowledgeId");
    documents.push(document);
    pins.push({ kind: binding.kind, bindingKey: binding.knowledgeId, path: address.path,
      documentId: document.record.id, knowledgeId: typeof modern === "string" ? modern : document.record.id,
      revision: document.record.revision, sha256: document.record.sha256, contentHash: binding.contentHash,
      pin: snapshot.file.pin, parentsSha256: hash(snapshot.parents) });
  }
  return { pins, documents, context: resolveRecipeKnowledgeContext(root, recipe, documents) };
}
function assertKnowledge(root: string, source: OriginalNativeRecipeLibrarySource) {
  for (const pin of source.knowledgePins) {
    const snapshot = readKnowledgePathSnapshot(root, pin.path, pin.kind === "skill" ? "skills" : "notes", true);
    if (!snapshot.file || snapshot.file.pin !== pin.pin || hash(snapshot.parents) !== pin.parentsSha256)
      deny("Approved Knowledge bytes, identity, revision or parent custody changed.");
  }
}
function assertPublic(storage: Storage, host: OriginalMcpNativeHost, actor: Readonly<Actor>,
  tool: string, args: Record<string, unknown>, readOnly = false) {
  if (actor.id !== "mcp:external" || actor.boardWorker || !readOnly && !actor.canWrite
    || !originalMcpPublicRequestMatches(storage, host, { operation: `mcp.tool.${tool}`, tool,
      version: 1, readOnly, arguments: args, argumentsDigest: hash(args) })) deny("Exact fresh native public request required.");
}
async function approve(owner: RootOwner, host: OriginalMcpNativeHost, source: OriginalNativeRecipeLibrarySource,
  signal?: AbortSignal) {
  const policy = await originalMcpNativeRecipeSourcePolicyForOwner(owner, host);
  assertOriginalMcpNativeRecipeSourcePolicy(policy, owner, host);
  const request = originalNativeRecipeLibraryApprovalRequest.parse({ ...source, phase: "admit", actorId: "mcp:external",
    epoch: host.receipt.epoch, nativeHostReceiptSha256: host.receipt.receiptSha256 });
  const cancelled = AbortSignal.any([policy.signal, host.signal, ...(signal ? [signal] : [])]);
  cancelled.throwIfAborted();
  const observed = await policy.authorize(request, cancelled);
  cancelled.throwIfAborted();
  if (!observed) deny("Native source/authoring decision denied.");
  const approval = originalRecipeSourceApproval.parse(observed);
  retainOriginalMcpNativeRecipeSourceApproval(observed, approval, request);
  if (!originalMcpNativeRecipeSourceApprovalSignal(approval) || approval.requestSha256 !== hash(request))
    deny("Actual current source producer approval required.");
  assertOriginalMcpNativeRecipeSourceApprovalCurrent(approval);
  return { policy, approval };
}
function buildSource(host: OriginalMcpNativeHost, base: Base, record: ProjectRecipeRecord, input: {
  kind: OriginalNativeRecipeLibrarySource["kind"]; purpose: OriginalNativeRecipeLibrarySource["purpose"];
  nativeRecipeId: string | null; nativeRecordSha256: string; nativeReceiptSha256: string | null;
  nativeSnapshotSha256: string; previousNativeSnapshotSha256: string; publicExecutableDigest: string;
  payloadSha256: string; knowledgePins: OriginalNativeRecipeLibrarySource["knowledgePins"];
  executionSemantics?: OriginalNativeRecipeLibrarySource["executionSemantics"];
  runtimeBindings?: OriginalNativeRecipeLibrarySource["runtimeBindings"];
  reachableRecipes?: OriginalNativeRecipeLibrarySource["reachableRecipes"];
}) {
  const model = parseDefinition(record.definition);
  const body = { schema: "pkm.original-native-recipe-library-source/v1" as const,
    root: host.receipt.root, workspaceId: host.receipt.workspaceId, custodyPlanSha256: host.receipt.planSha256,
    profileSha256: host.receipt.profileSha256, files: base.files, sourceSha256: hash(base.files),
    recipeId: record.recipeId, revision: record.revision, executableDigest: model.executableDigest,
    recordSha256: hash(record), nodeIds: model.model.spec.nodes.map(node => node.nodeId), maxFileBytes: 2_097_152,
    protocol: "controlled-external-report/v1" as const, effects: ["caller-reported-result-only"] as ["caller-reported-result-only"],
    noExecution: true as const, executionSemantics: input.purpose === "execute"
      ? "original-recipe-metadata/v1" as const : "definition-only/v1" as const, ...input };
  return originalNativeRecipeLibrarySource.parse({ ...body, planSha256: hash(body) });
}
function storeReceipt(database: DatabaseSync, workspaceId: string, id: string, envelope: z.infer<typeof sourceReceipt>) {
  const body = canonicalJson(envelope), fingerprint = hash(envelope);
  const previous = database.prepare("SELECT * FROM native_recipe_library_receipts WHERE operation_id=?").get(id);
  if (previous) {
    if (previous.workspace_id !== workspaceId || previous.actor_id !== "mcp:external"
      || previous.result !== body || previous.fingerprint !== fingerprint) deny("Native source receipt identity reused.");
    return;
  }
  database.prepare("INSERT INTO native_recipe_library_receipts VALUES(?,?,?,?,?)")
    .run(id, workspaceId, "mcp:external", fingerprint, body);
}
function readReceipt(database: DatabaseSync, journal: OriginalMcpJournal, row: Record<string, unknown>) {
  if (row.workspace_id !== journal.workspaceId || row.actor_id !== "mcp:external"
    || typeof row.result !== "string" || !String(row.operation_id).startsWith(receiptPrefix))
    deny("Foreign native source receipt.");
  const envelope = sourceReceipt.parse(JSON.parse(row.result));
  if (row.result !== canonicalJson(envelope) || row.fingerprint !== hash(envelope)
    || envelope.source.root !== journal.plan.root || envelope.source.workspaceId !== journal.workspaceId)
    deny("Native source receipt changed.");
  const { planSha256, ...body } = envelope.source;
  if (hash(body) !== planSha256 || hash(envelope.record) !== envelope.source.recordSha256
    || hash(envelope.source.files) !== envelope.source.sourceSha256) deny("Native source body changed.");
  readOriginalMcpRecipeHistoricalHost(database, journal, envelope.source, canonicalJson(envelope.approval));
  const record = envelope.record as unknown as ProjectRecipeRecord;
  const compiled = parseDefinition(record.definition);
  if (record.recipeId !== envelope.source.recipeId || record.revision !== envelope.source.revision
    || compiled.executableDigest !== record.executableDigest) deny("Native source graph/identity changed.");
  if (envelope.nativeInput) {
    const input = envelope.nativeInput as unknown as NativeInput;
    const native = database.prepare("SELECT * FROM native_recipe_library_receipts WHERE operation_id=?").get(input.operationId);
    if (!native || native.workspace_id !== journal.workspaceId || native.actor_id !== input.actorId
      || native.fingerprint !== hash(input)) deny("Exact native authoring payload/receipt changed.");
    const raw = JSON.parse(String(native.result)) as LibraryRecord;
    if (hash(raw) !== envelope.source.nativeRecordSha256
      || raw.recipeId !== `recipe_${envelope.source.nativeRecipeId}`
      || hash(projection(raw, record.recipeId)) !== envelope.source.recordSha256)
      deny("Native authoring record/alias proof changed.");
  }
  return envelope;
}
function retainedExecutionSource(database: DatabaseSync, journal: OriginalMcpJournal,
  source: OriginalNativeRecipeLibrarySource, rows: Array<Record<string, unknown>>) {
  for (const row of rows) {
    const previous = readReceipt(database, journal, row).source;
    if (previous.purpose === "execute" && previous.planSha256 === source.planSha256) {
      if (canonicalJson(previous) !== canonicalJson(source)) deny("Retained execution-source identity changed.");
      return previous;
    }
  }
  return source;
}
async function verifyBase(owner: RootOwner, host: OriginalMcpNativeHost, source: OriginalNativeRecipeLibrarySource) {
  const base = await captureOriginalMcpRecipeLibraryBase(owner, host, source.maxFileBytes,
    source.files.some(file => file.path === ".pkm/state/projects.json"));
  if (canonicalJson(base.files) !== canonicalJson(source.files)) deny("Canonical Recipe membership/custody bytes changed.");
  return base;
}
function bind(storage: Storage, state: State) {
  const lane = state.source.purpose === "execute" ? states : metadataStates;
  lane.get(storage)?.lifetime.abort();
  lane.set(storage, state);
  const revoked = () => { if (lane.get(storage) === state) { state.lifetime.abort(); lane.delete(storage); } };
  originalMcpNativeRecipeSourceApprovalSignal(state.approval)!.addEventListener("abort", revoked, { once: true });
  storage.retainNativeCleanup({ release: revoked });
}
function assertState(storage: Storage, state: State) {
  state.owner.assertWorkspaceLease();
  state.lifetime.signal.throwIfAborted();
  assertOriginalMcpNativeRecipeSourcePolicy(state.policy, state.owner, state.host);
  assertOriginalMcpNativeRecipeSourceApprovalCurrent(state.approval);
  assertOriginalMcpNativeRecipeLibraryFiles(state.source);
  assertKnowledge(state.source.root, state.source);
  const db = storage.connectNative();
  try {
    if (nativeSnapshot(db, state.source.workspaceId) !== state.source.nativeSnapshotSha256)
      deny("Native Library revision/payload snapshot changed.");
  } finally { db.close(); }
}
export async function dispatchOriginalMcpRecipeFromSkill(owner: RootOwner, host: OriginalMcpNativeHost,
  actor: Readonly<Actor>, args: Record<string, unknown>, signal?: AbortSignal) {
  const { storage, journal } = await originalRecipeLibraryScope(owner, host);
  assertPublic(storage, host, actor, "recipe_create_from_skill", args);
  try {
    const input = fromSkillInput.parse(args);
    if (![input.name, input.command_id, input.source_skill_id].every(value => value.trim())
      || !/^[a-f0-9]{64}$/.test(input.source_skill_hash)) throw Error("name, command_id, and source Skill hash are required.");
    if (!["global", "project"].includes(input.scope)) throw Error("scope must be global or project.");
    let category = normalizeRecipeCategory(input.category);
    if (input.scope === "global" && category.split("/")[0]?.toLowerCase() === "system")
      throw Error("System files and folders are read-only for Agent MCP writes.");
    const raw = JSON.parse(input.definition_json) as { spec?: { nodes?: Array<{ nodeId: string }> } };
    const first = input.source_skill_node_id || raw.spec?.nodes?.[0]?.nodeId;
    const compiled = parseDefinition(raw);
    if (!first || !compiled.model.spec.nodes.some(node => node.nodeId === first)) throw Error("source_skill_node_id must identify a node in the definition.");
    const publicId = "recipe_" + createHash("sha256").update("skill-recipe\0" + input.command_id).digest("hex").slice(0, 32);
    const nativeId = uuid(`original-skill-recipe:${journal.workspaceId}:${input.command_id}`);
    const base = await captureOriginalMcpRecipeLibraryBase(owner, host, 2_097_152, input.scope === "project");
    if (input.scope === "project") {
      if (!input.project_id.trim()) throw Error("project_id is required for a Project Recipe.");
      const projects = base.projects.filter(project => project.projectId === input.project_id);
      if (projects.length !== 1) throw Error("Project Recipe references an unknown or ambiguous Project.");
      category = ["Project", safeRecipeCategorySegment(projects[0]!.name), category].filter(Boolean).join("/");
    }
    const semanticPayload = hash({ name: input.name.trim(), description: input.description.trim(), category: normalizeRecipeCategory(input.category),
      definition: compiled.model, scope: input.scope, project_id: input.project_id, source_skill_id: input.source_skill_id,
      source_skill_hash: input.source_skill_hash, source_skill_node_id: first });
    const db = storage.connectNative();
    let library: NativeRecipeLibrary | undefined;
    try {
      const fields = recipeLibraryEditable.parse({ name: input.name.trim(), description: input.description.trim(), category,
        definition: compiled.model, metadata: { applicableFunctions: [], solution: input.description.trim(),
          requiredInputs: [], expectedOutputs: [] },
        nodeBindings: [{ nodeId: first, bindings: [{ bindingId: "source-skill", kind: "skill",
          knowledgeId: input.source_skill_id, contentHash: input.source_skill_hash, usage: "required" }] }] });
      const preview: LibraryRecord = { schema: "pkm.knowledge/v1", knowledgeId: `knowledge_${hash(`recipe_${nativeId}`).slice(0, 24)}`,
        aliases: [`recipe:recipe_${nativeId}`], origin: { kind: "native" }, ...fields, scope: "global",
        recipeId: `recipe_${nativeId}`, revision: 1, executableDigest: compiled.executableDigest };
      const record = projection(preview, publicId), resolved = knowledge(db, owner.workspaceRoot(), record);
      if (resolved.documents.length !== 1 || resolved.documents[0]!.metadata.get("recipe_required") !== true)
        throw Error("Source Skill must explicitly declare a required Recipe gap.");
      const existingCanonical = base.recipes.find(recipe => recipe.recipeId === publicId);
      if (existingCanonical) {
        const existing = structuredClone(existingCanonical) as unknown as Record<string, unknown>;
        for (const key of ["schema", "knowledgeId", "aliases"]) delete existing[key];
        if (existing.systemKind === "built-in" || String(existing.category ?? "").split("/")[0]!.toLowerCase() === "system")
          throw Error("System Recipes are read-only for Agent MCP writes.");
        const authored = { recipeId: publicId, scope: "global", category, name: input.name.trim(),
          description: input.description.trim(), metadata: fields.metadata, definition: compiled.model,
          nodeBindings: fields.nodeBindings, executableDigest: compiled.executableDigest, revision: 1,
          origin: { kind: "skill-recipe-gap", skillId: input.source_skill_id } };
        if (hash(existing) !== hash(authored)) throw Error("command_id was reused with different parameters.");
        const present = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('native_recipe_library_records','native_recipe_library_receipts')").all();
        if (!present.length) db.exec(nativeRecipeLibraryDdl);
        else databaseSchema(db);
        const snapshot = nativeSnapshot(db, journal.workspaceId);
        const source = buildSource(host, base, existingCanonical, { kind: "canonical", purpose: "author",
          nativeRecipeId: null, nativeRecordSha256: hash(existingCanonical), nativeReceiptSha256: null, nativeSnapshotSha256: snapshot,
          previousNativeSnapshotSha256: snapshot, publicExecutableDigest: compiled.executableDigest,
          payloadSha256: semanticPayload, knowledgePins: resolved.pins });
        const approved = await approve(owner, host, source, signal);
        await verifyBase(owner, host, source); assertKnowledge(owner.workspaceRoot(), source);
        bind(storage, { owner, host, source, recipe: existingCanonical, ...approved,
          lifetime: new AbortController(), context: resolved.context, base });
        return { schema: "pkm.recipe.api/v1", ok: true, outcome: "recipe-created",
          recipe: originalLocalRecipeSummary(existingCanonical), replayed: true,
          next_action: { kind: "qualify_recipe", candidate_recipe_ids: [publicId] } };
      }
      const receiptId = receiptPrefix + "author:" + hash(input.command_id);
      let witness: Parameters<typeof storeReceipt>[3] | undefined;
      let approved: Awaited<ReturnType<typeof approve>> | undefined;
      library = new NativeRecipeLibrary({ database: db, workspaceId: journal.workspaceId,
        original: () => ({ snapshotRevision: base.snapshotRevision, recipes: base.recipes }),
        assertLease() {
          owner.assertWorkspaceLease(); signal?.throwIfAborted();
          if (approved) { assertOriginalMcpNativeRecipeSourceApprovalCurrent(approved.approval); assertKnowledge(owner.workspaceRoot(), witness!.source); }
        },
        receiptWitness(database, result, nativeInput) {
          if (hash(result) !== hash(preview) || !witness || !approved) deny("Native authoring output differs from its approved payload.");
          if (hash(nativeInput) !== hash(witness.nativeInput)) deny("Native authoring input changed.");
          assertOriginalMcpNativeRecipeSourceApprovalCurrent(approved.approval);
          if (nativeSnapshot(database, journal.workspaceId) !== witness.source.nativeSnapshotSha256) deny("Native authoring post-snapshot changed.");
          const retained = database.prepare("SELECT * FROM native_recipe_library_receipts WHERE operation_id=?").get(receiptId);
          if (!retained) storeReceipt(database, journal.workspaceId, receiptId, witness);
        } });
      const previous = db.prepare("SELECT * FROM native_recipe_library_receipts WHERE operation_id=?").get(receiptId);
      const savedReceipt = previous ? readReceipt(db, journal, previous) : undefined;
      if (savedReceipt && savedReceipt.source.payloadSha256 !== semanticPayload) throw Error("command_id was reused with different parameters.");
      if (savedReceipt && db.prepare("SELECT digest FROM native_recipe_library_records WHERE recipe_id=?").get(preview.recipeId)?.digest
        !== savedReceipt.source.nativeRecordSha256) throw Error("command_id was reused with different parameters.");
      const nativeInput: NativeInput = savedReceipt?.nativeInput as unknown as NativeInput ?? {
        actorId: actor.id, operationId: uuid(`original-skill-operation:${journal.workspaceId}:${input.command_id}`),
        recipeId: preview.recipeId, expectedRevision: 0, expectedSnapshot: library.snapshot().snapshotRevision, fields };
      const before = nativeSnapshot(db, journal.workspaceId);
      const predicted = rows(db, journal.workspaceId).filter(row => row.recipe_id !== preview.recipeId);
      predicted.push({ workspace_id: journal.workspaceId, recipe_id: preview.recipeId, original_digest: hash(null),
        record: canonicalJson(preview), digest: hash(preview) });
      predicted.sort((a, b) => String(a.recipe_id).localeCompare(String(b.recipe_id)));
      const source = buildSource(host, base, record, { kind: "overlay", purpose: "author", nativeRecipeId: nativeId,
        nativeRecordSha256: hash(preview), nativeReceiptSha256: null, previousNativeSnapshotSha256: before,
        nativeSnapshotSha256: hash(predicted), publicExecutableDigest: compiled.executableDigest,
        payloadSha256: semanticPayload, knowledgePins: resolved.pins });
      approved = await approve(owner, host, source, signal);
      await verifyBase(owner, host, source);
      if (nativeSnapshot(db, journal.workspaceId) !== before) deny("Native authoring CAS changed before commit.");
      witness = { schema: "pkm.original-native-recipe-receipt/v1", kind: "author", source,
        approval: approved.approval, record: record as never, nativeInput: nativeInput as never, publicArguments: args as never };
      library.save(nativeInput);
      bind(storage, { owner, host, source, recipe: record, ...approved, lifetime: new AbortController(), context: resolved.context, base });
      return { schema: "pkm.recipe.api/v1", ok: true, outcome: "recipe-created",
        recipe: originalLocalRecipeSummary(record), replayed: !!previous,
        next_action: { kind: "qualify_recipe", candidate_recipe_ids: [publicId] } };
    } finally { if (library) library.close(); else db.close(); }
  } catch (error) {
    return { schema: "pkm.recipe.api/v1", ok: false, error: { code: "recipe-create-from-skill-failed",
      message: error instanceof Error ? error.message : String(error) } };
  }
}
export async function prepareOriginalMcpRecipeAdhoc(owner: RootOwner, host: OriginalMcpNativeHost,
  actor: Readonly<Actor>, args: Record<string, unknown>, signal?: AbortSignal) {
  const { storage, journal } = await originalRecipeLibraryScope(owner, host);
  assertPublic(storage, host, actor, "recipe_run_start_adhoc", args);
  const input = originalRecipeAdhocInput.parse(args);
  if (!input.name.trim() || !input.command_id.trim()) throw Error("name and command_id are required.");
  const raw = JSON.parse(input.definition_json), bindings = JSON.parse(input.node_bindings_json);
  if (!Array.isArray(bindings)) throw Error("node_bindings_json must decode to list");
  const compiled = parseDefinition(raw), publicDigest = hash({ definition: raw, nodeBindings: bindings });
  const inputs = normalizeLegacyRecipeInputs(compiled.model, input.inputs_json);
  const runtimeBindings = workflowRuntimeBindingsFromOriginalInputs(compiled.model, JSON.parse(input.inputs_json || "{}"));
  const semanticPayload = hash({ name: input.name.trim(), definition: raw, node_bindings: bindings,
    inputs, detail: input.detail, autonomous: input.autonomous,
    max_auto_nodes: input.max_auto_nodes, max_auto_seconds: input.max_auto_seconds });
  const retained = states.get(storage);
  if (retained?.source.kind === "adhoc" && retained.source.payloadSha256 === semanticPayload) {
    assertState(storage, retained);
    await verifyBase(owner, host, retained.source);
    return { source: retained.source, recipe: retained.recipe, input, publicExecutableDigest: publicDigest };
  }
  const nodeBindings = normalizeRecipeNodeBindings(bindings, new Set(compiled.model.spec.nodes.map(node => node.nodeId)));
  if (nodeBindings.length !== bindings.filter((node: { bindings?: unknown[] }) => node.bindings?.length).length)
    throw Error("Recipe Knowledge bindings reference an invalid node.");
  const record: ProjectRecipeRecord = { recipeId: `adhoc_recipe_${publicDigest.slice(0, 24)}`, revision: 1,
    name: input.name.trim(), description: "", category: "", scope: "global",
    definition: raw as ProjectRecipeRecord["definition"],
    executableDigest: compiled.executableDigest, nodeBindings, origin: { kind: "agent-session-adhoc" } };
  const base = await captureOriginalMcpRecipeLibraryBase(owner, host), db = storage.connectNative();
  try {
    db.exec(nativeRecipeLibraryDdl);
    const snapshot = nativeSnapshot(db, host.receipt.workspaceId);
    const previous = db.prepare("SELECT * FROM native_recipe_library_receipts WHERE operation_id LIKE ? LIMIT 4097")
      .all(receiptPrefix + "adhoc:" + hash(input.command_id) + ":%");
    if (previous.length > 4096) deny("Adhoc command review envelope exceeded.");
    if (previous.some(row => readReceipt(db, journal, row).source.payloadSha256 !== semanticPayload))
      throw Error("command_id was reused with different parameters.");
    const closure = executionRecipes(db, owner, journal, base, record);
    const resolved = { context: closure.contexts.get(record.recipeId)!, pins: closure.pins };
    const source = retainedExecutionSource(db, journal, buildSource(host, base, record, { kind: "adhoc", purpose: "execute", nativeRecipeId: null,
      nativeRecordSha256: hash(record), nativeReceiptSha256: null, nativeSnapshotSha256: snapshot,
      previousNativeSnapshotSha256: snapshot, publicExecutableDigest: publicDigest, payloadSha256: semanticPayload, knowledgePins: resolved.pins,
      ...(runtimeBindings ? { runtimeBindings, executionSemantics: "native-runtime-bindings/v1" as const } : {}),
      ...(closure.reachableRecipes ? { reachableRecipes: closure.reachableRecipes } : {}) }), previous);
    if (nativeSnapshot(db, host.receipt.workspaceId) !== snapshot) deny("Adhoc reachable sources changed during capture.");
    const approved = await approve(owner, host, source, signal);
    await verifyBase(owner, host, source); assertKnowledge(owner.workspaceRoot(), source);
    const receipt = { schema: "pkm.original-native-recipe-receipt/v1" as const, kind: "adhoc" as const,
      source, approval: approved.approval, record: record as never, nativeInput: null, publicArguments: args as never };
    db.exec("BEGIN IMMEDIATE");
    try {
      if (nativeSnapshot(db, host.receipt.workspaceId) !== snapshot) deny("Adhoc native snapshot changed.");
      assertOriginalMcpNativeRecipeSourceApprovalCurrent(approved.approval);
      storeReceipt(db, host.receipt.workspaceId, receiptPrefix + "adhoc:" + hash(input.command_id) + ":" + approved.approval.decisionId, receipt);
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    bind(storage, { owner, host, source, recipe: record, ...approved, lifetime: new AbortController(), context: resolved.context,
      recipes: closure.recipes, contexts: closure.contexts, base });
    return { source, recipe: record, input, publicExecutableDigest: publicDigest };
  } finally { db.close(); }
}
export async function acquireOriginalMcpNativeRecipeLibraryExecution(owner: RootOwner, host: OriginalMcpNativeHost) {
  const { storage } = await originalRecipeLibraryScope(owner, host);
  const state = states.get(storage);
  if (!state || state.owner !== owner || state.host !== host) return undefined;
  if (state.source.purpose !== "execute") deny("A separately current native execution-source decision is required.");
  if (!state.source.executionSemantics || state.source.executionSemantics === "definition-only/v1")
    deny("Exact source-bound execution semantics are required.");
  assertState(storage, state);
  await verifyBase(owner, host, state.source);
  const recordForRecipe = (recipeId: string) => {
    assertState(storage, state);
    const record = (state.recipes ?? [state.recipe]).find(record => record.recipeId === recipeId);
    if (!record) throw new CoreError("ACCESS_DENIED", "Recipe is not in the independently pinned reachable source closure.");
    return record;
  };
  return {
    source: structuredClone(state.source), recipe: structuredClone(state.recipe), signal: state.lifetime.signal,
    session: originalMcpNativeRecipeSourcePolicySession(state.policy, owner, host),
    context: structuredClone(state.context),
    executionSemantics: state.source.executionSemantics,
    runtimeBindings: state.source.runtimeBindings ? structuredClone(state.source.runtimeBindings) : undefined,
    assertCurrent() { assertState(storage, state); },
    async refresh() { assertState(storage, state); await verifyBase(owner, host, state.source); assertState(storage, state); },
    catalog() { assertState(storage, state); return { recipes: structuredClone(state.recipes ?? [state.recipe]), snapshotRevision: state.source.planSha256 }; },
    recordForRecipe(recipeId: string) { return structuredClone(recordForRecipe(recipeId)); },
    publicExecutableDigestForRecipe(recipeId: string) {
      const record = recordForRecipe(recipeId);
      return recipeId === state.recipe.recipeId ? state.source.publicExecutableDigest : record.executableDigest;
    },
    knowledgeForNode(nodeId: string) { assertState(storage, state); return recipeKnowledgeForNode(state.context, nodeId); },
    knowledgeForRecipeNode(recipeId: string, nodeId: string) {
      recordForRecipe(recipeId);
      const context = state.contexts?.get(recipeId) ?? (recipeId === state.recipe.recipeId ? state.context : undefined);
      if (!context) deny("Exact reachable Recipe Knowledge context is required.");
      return recipeKnowledgeForNode(context, nodeId);
    },
    resolveRecipe(ref: Record<string, unknown>) {
      assertState(storage, state);
      const recipe = recordForRecipe(String(ref.recipeId ?? ""));
      const revision = ref.expectedRevision === undefined ? ref.revision : ref.expectedRevision;
      const digest = ref.expectedExecutableDigest === undefined ? ref.executableDigest : ref.expectedExecutableDigest;
      if (ref.kind !== "recipe" || ref.recipeId !== recipe.recipeId || revision !== recipe.revision
        || digest !== recipe.executableDigest || ref.snapshotRevision !== state.source.planSha256
        || ref.revision !== undefined && ref.revision !== revision
        || ref.executableDigest !== undefined && ref.executableDigest !== digest)
        throw new CoreError("CONFLICT", "Exact native Recipe source revision/digest changed.");
      const compiled = parseDefinition(recipe.definition).model;
      const authored = recipe.definition as unknown as typeof compiled;
      const nodes = new Map(compiled.spec.nodes.map(node => [node.nodeId, node]));
      const definition = { ...compiled, spec: { ...compiled.spec,
        nodes: authored.spec.nodes.map(node => nodes.get(node.nodeId)!) } };
      return { status: "valid" as const, definition,
        executableDigest: recipe.executableDigest, source: { kind: "recipe" as const,
          recipeId: recipe.recipeId, revision: recipe.revision, executableDigest: recipe.executableDigest,
          snapshotRevision: state.source.planSha256 } };
    },
  };
}
function payloadReceipt(database: DatabaseSync, workspaceId: string, input: NativeInput, record: LibraryRecord) {
  const row = database.prepare("SELECT * FROM native_recipe_library_receipts WHERE operation_id=?")
    .get(nativeRecipePayloadReceiptPrefix + input.operationId);
  if (!row || row.workspace_id !== workspaceId || row.actor_id !== input.actorId || typeof row.result !== "string")
    deny("A current native producer payload witness is required; historical bare receipts cannot be upgraded implicitly.");
  const witness = nativeRecipePayloadReceiptSchema.parse(JSON.parse(row.result));
  const ordinary = database.prepare("SELECT * FROM native_recipe_library_receipts WHERE operation_id=?").get(input.operationId);
  if (row.result !== canonicalJson(witness) || row.fingerprint !== hash(witness)
    || witness.recordSha256 !== hash(record) || hash(witness.input) !== hash(input)
    || !ordinary || ordinary.workspace_id !== workspaceId || ordinary.actor_id !== input.actorId
    || ordinary.fingerprint !== hash(input) || hash(JSON.parse(String(ordinary.result))) !== hash(record))
    deny("Exact current native payload witness changed.");
  return row;
}
function executionRecipes(database: DatabaseSync, owner: RootOwner,
  journal: OriginalMcpJournal, base: Base, selected: ProjectRecipeRecord, projectId = "") {
  const assertProject = (record: ProjectRecipeRecord) => {
    if (record.scope !== "global" && record.projectId !== projectId)
      deny("Recipe is not accessible in the requested Project scope.");
  };
  assertProject(selected);
  const selectedContext = knowledge(database, owner.workspaceRoot(), selected);
  const recipes = [selected], contexts = new Map([[selected.recipeId, selectedContext.context]]);
  if (!parseDefinition(selected.definition).model.spec.nodes.some(node => node.kind === "pkm.subflow/v1"))
    return { recipes, contexts, pins: selectedContext.pins, reachableRecipes: undefined };
  const library = new NativeRecipeLibrary({ database, workspaceId: journal.workspaceId,
    assertLease() { owner.assertWorkspaceLease(); },
    original: () => ({ recipes: base.recipes, snapshotRevision: base.snapshotRevision }) });
  const catalogue = new Map(base.recipes.map(record => [record.recipeId, record]));
  const native = new Map<string, LibraryRecord>();
  for (const record of library.snapshot().recipes) {
    catalogue.set(record.recipeId, record);
    if (database.prepare("SELECT 1 FROM native_recipe_library_records WHERE recipe_id=?").get(record.recipeId))
      native.set(record.recipeId, record as LibraryRecord);
  }
  const authorRows = database.prepare("SELECT * FROM native_recipe_library_receipts WHERE operation_id LIKE ? LIMIT 4097")
    .all(receiptPrefix + "author:%");
  if (authorRows.length > 4096) deny("Reachable source authoring envelope exceeded.");
  for (const row of authorRows) {
    const receipt = readReceipt(database, journal, row);
    if (receipt.kind !== "author") deny("Unexpected reachable authoring receipt.");
    if (!receipt.source.nativeRecipeId) continue;
    const record = native.get(`recipe_${receipt.source.nativeRecipeId}`);
    if (!record) deny("Reachable authored public identity lost its native record.");
    catalogue.set(receipt.source.recipeId, projection(record, receipt.source.recipeId));
    native.set(receipt.source.recipeId, record);
  }
  catalogue.set(selected.recipeId, selected);
  const witnessRows = database.prepare("SELECT * FROM native_recipe_library_receipts WHERE operation_id LIKE ? LIMIT 4097")
    .all(nativeRecipePayloadReceiptPrefix + "%");
  if (witnessRows.length > 4096) deny("Reachable payload witness envelope exceeded.");
  const pins = [...selectedContext.pins], reachableRecipes: NonNullable<OriginalNativeRecipeLibrarySource["reachableRecipes"]> = [];
  const visited = new Set<string>();
  let totalNodes = 0;
  const visit = (record: ProjectRecipeRecord, ancestors: Set<string>) => {
    const nativeRecord = native.get(record.recipeId);
    const identity = nativeRecord?.recipeId ?? record.recipeId;
    if (ancestors.has(identity)) deny("Recursive Recipe source ancestry is not permitted.");
    if (ancestors.size >= 16) deny("Reachable Recipe depth exceeds 16.");
    if (visited.has(record.recipeId)) return;
    visited.add(record.recipeId);
    const compiled = parseDefinition(record.definition);
    if (compiled.executableDigest !== record.executableDigest) deny("Reachable Recipe compiler digest changed.");
    totalNodes += compiled.model.spec.nodes.length;
    if (visited.size > 32 || totalNodes > 128) deny("Reachable Recipe graph exceeds its shared source budget.");
    if (record !== selected) {
      const current = knowledge(database, owner.workspaceRoot(), record);
      recipes.push(record); contexts.set(record.recipeId, current.context); pins.push(...current.pins);
      let nativeReceiptSha256: string | null = null;
      if (nativeRecord) {
        const matches = witnessRows.flatMap(row => {
          if (row.workspace_id !== journal.workspaceId || typeof row.result !== "string") return [];
          const witness = nativeRecipePayloadReceiptSchema.parse(JSON.parse(row.result));
          if (row.actor_id !== witness.input.actorId) deny("Reachable native witness actor changed.");
          if (witness.input.recipeId !== nativeRecord.recipeId || witness.recordSha256 !== hash(nativeRecord)) return [];
          return [payloadReceipt(database, journal.workspaceId, witness.input, nativeRecord)];
        });
        if (matches.length !== 1) deny("Reachable native Recipe needs its exact current producer witness.");
        nativeReceiptSha256 = hash(matches[0]);
      }
      reachableRecipes.push({ recipeId: record.recipeId, revision: record.revision,
        executableDigest: record.executableDigest, recordSha256: hash(record),
        nativeRecipeId: nativeRecord ? nativeRecord.recipeId.slice("recipe_".length) : null,
        nativeRecordSha256: hash(nativeRecord ?? record), nativeReceiptSha256 });
    }
    const next = new Set(ancestors); next.add(identity);
    for (const node of compiled.model.spec.nodes) if (node.kind === "pkm.subflow/v1") {
      const child = catalogue.get(node.config.recipeId);
      if (!child || child.revision !== node.config.revision || child.executableDigest !== node.config.executableDigest)
        deny("Subflow requires an exact current child Recipe revision and executable digest.");
      assertProject(child);
      visit(child, next);
    }
  };
  visit(selected, new Set());
  const uniquePins = [...new Map(pins.map(pin => [canonicalJson(pin), pin])).values()];
  if (uniquePins.length > 128) deny("Reachable Knowledge source budget exceeds 128.");
  return { recipes, contexts, pins: uniquePins, reachableRecipes: reachableRecipes.length ? reachableRecipes : undefined };
}
function historicalExecutionRecipes(database: DatabaseSync, journal: OriginalMcpJournal,
  source: OriginalNativeRecipeLibrarySource, selected: ProjectRecipeRecord, base: Base) {
  const recipes = [selected], identities = new Map([[selected.recipeId, source.nativeRecipeId ?? selected.recipeId]]);
  const pins = source.reachableRecipes ?? [];
  for (const pin of pins) {
    let record: ProjectRecipeRecord | undefined;
    if (pin.nativeRecipeId) {
      const row = database.prepare("SELECT * FROM native_recipe_library_records WHERE recipe_id=?").get(`recipe_${pin.nativeRecipeId}`);
      if (!row || row.workspace_id !== journal.workspaceId || typeof row.record !== "string"
        || row.digest !== pin.nativeRecordSha256 || hash(JSON.parse(row.record)) !== pin.nativeRecordSha256)
        deny("Historical reachable native Recipe changed.");
      const native = JSON.parse(row.record) as LibraryRecord;
      record = projection(native, pin.recipeId);
      const witnesses = database.prepare("SELECT * FROM native_recipe_library_receipts WHERE operation_id LIKE ? LIMIT 4097")
        .all(nativeRecipePayloadReceiptPrefix + "%");
      if (witnesses.length > 4096) deny("Historical reachable witness envelope exceeded.");
      const witness = witnesses.find(row => hash(row) === pin.nativeReceiptSha256);
      if (!witness || typeof witness.result !== "string") deny("Historical reachable native witness is missing.");
      payloadReceipt(database, journal.workspaceId, nativeRecipePayloadReceiptSchema.parse(JSON.parse(witness.result)).input, native);
    } else {
      record = base.recipes.find(record => record.recipeId === pin.recipeId);
      if (!record || pin.nativeReceiptSha256 !== null || pin.nativeRecordSha256 !== hash(record))
        deny("Historical reachable canonical Recipe changed.");
    }
    if (record.recipeId !== pin.recipeId || record.revision !== pin.revision || record.executableDigest !== pin.executableDigest
      || parseDefinition(record.definition).executableDigest !== pin.executableDigest || hash(record) !== pin.recordSha256
      || recipes.some(previous => previous.recipeId === record!.recipeId)) deny("Historical reachable Recipe identity changed.");
    recipes.push(record); identities.set(record.recipeId, pin.nativeRecipeId ?? record.recipeId);
  }
  const catalogue = new Map(recipes.map(record => [record.recipeId, record])), visited = new Set<string>();
  let totalNodes = 0;
  const visit = (record: ProjectRecipeRecord, ancestors: Set<string>) => {
    const identity = identities.get(record.recipeId)!;
    if (ancestors.has(identity) || ancestors.size >= 16) deny("Historical reachable Recipe ancestry is invalid.");
    if (record.scope !== "global" && record.projectId !== (source.rootProjectId ?? ""))
      deny("Historical reachable Recipe is outside the pinned Project scope.");
    if (visited.has(record.recipeId)) return;
    visited.add(record.recipeId);
    const compiled = parseDefinition(record.definition);
    totalNodes += compiled.model.spec.nodes.length;
    if (visited.size > 32 || totalNodes > 128) deny("Historical reachable Recipe graph exceeds its bounded envelope.");
    const next = new Set(ancestors); next.add(identity);
    for (const node of compiled.model.spec.nodes) if (node.kind === "pkm.subflow/v1") {
      const child = catalogue.get(node.config.recipeId);
      if (!child || child.revision !== node.config.revision || child.executableDigest !== node.config.executableDigest)
        deny("Historical subflow lost its exact closed child source.");
      if (child.scope !== "global" && child.projectId !== (source.rootProjectId ?? ""))
        deny("Historical subflow is outside the pinned Project scope.");
      visit(child, next);
    }
  };
  if (pins.length) visit(selected, new Set());
  if (pins.length && visited.size !== recipes.length) deny("Historical source contains an unreferenced child grant.");
  return recipes;
}
export async function prepareOriginalMcpRecipeLibraryRun(owner: RootOwner, host: OriginalMcpNativeHost,
  actor: Readonly<Actor>, args: Record<string, unknown>, signal?: AbortSignal) {
  const { storage, journal } = await originalRecipeLibraryScope(owner, host);
  assertPublic(storage, host, actor, "recipe_run_start", args);
  const requestedId = String(args.recipe_id ?? "");
  const inputText = String(args.inputs_json ?? "{}") || "{}";
  const retained = states.get(storage);
  const retainedBindings = retained ? workflowRuntimeBindingsFromOriginalInputs(parseDefinition(retained.recipe.definition).model,
    JSON.parse(inputText)) : undefined;
  if (retained?.source.purpose === "execute" && retained.recipe.recipeId === requestedId
    && (retained.source.rootProjectId ?? "") === String(args.project_id ?? "")
    && canonicalJson(retainedBindings ?? null) === canonicalJson(retained.source.runtimeBindings ?? null)
    && (!args.expected_revision || args.expected_revision === retained.recipe.revision)
    && (!args.expected_digest || args.expected_digest === retained.recipe.executableDigest)) {
    try {
      assertState(storage, retained);
      await verifyBase(owner, host, retained.source);
      return acquireOriginalMcpNativeRecipeLibraryExecution(owner, host);
    } catch {
      retained.lifetime.abort();
      if (states.get(storage) === retained) states.delete(storage);
    }
  }
  const base = await captureOriginalMcpRecipeLibraryBase(owner, host), db = storage.connectNative();
  let library: NativeRecipeLibrary | undefined;
  try {
    library = new NativeRecipeLibrary({ database: db, workspaceId: journal.workspaceId,
      assertLease() { owner.assertWorkspaceLease(); signal?.throwIfAborted(); },
      original: () => ({ recipes: base.recipes, snapshotRevision: base.snapshotRevision }) });
    const snapshot = nativeSnapshot(db, journal.workspaceId);
    const nativeRecords = library.snapshot().recipes;
    let record = base.recipes.find(recipe => recipe.recipeId === requestedId);
    let nativeRecord: LibraryRecord | undefined, nativeInput: NativeInput | null = null;
    let nativeReceiptHash: string | null = null;
    const receipts = db.prepare("SELECT * FROM native_recipe_library_receipts WHERE operation_id LIKE ? LIMIT 4097")
      .all(receiptPrefix + "%");
    if (receipts.length > 4096) deny("Native source receipt envelope exceeded.");
    const authored = receipts.map(row => readReceipt(db, journal, row)).filter(receipt =>
      receipt.kind === "author" && receipt.source.recipeId === requestedId);
    if (authored.length) {
      const selected = authored.sort((a, b) => b.source.revision - a.source.revision)[0]!;
      nativeRecord = nativeRecords.find(item => item.recipeId === `recipe_${selected.source.nativeRecipeId}`) as LibraryRecord | undefined;
      if (!nativeRecord) deny("Authored public identity has no current native record.");
      record = projection(nativeRecord, requestedId);
    } else if (db.prepare("SELECT 1 FROM native_recipe_library_records WHERE recipe_id=?").get(requestedId)) {
      nativeRecord = nativeRecords.find(item => item.recipeId === requestedId) as LibraryRecord | undefined;
      record = nativeRecord;
    }
      if (nativeRecord) {
        const payloadRows = db.prepare("SELECT * FROM native_recipe_library_receipts WHERE operation_id LIKE ? LIMIT 4097")
          .all(nativeRecipePayloadReceiptPrefix + "%");
        if (payloadRows.length > 4096) deny("Native authoring witness envelope exceeded.");
        const matches = payloadRows.flatMap(row => {
          if (row.workspace_id !== journal.workspaceId || typeof row.result !== "string") return [];
          const parsed = nativeRecipePayloadReceiptSchema.parse(JSON.parse(row.result));
          if (row.actor_id !== parsed.input.actorId) deny("Native payload actor proof changed.");
          if (parsed.input.recipeId !== nativeRecord!.recipeId || parsed.recordSha256 !== hash(nativeRecord)) return [];
          payloadReceipt(db, journal.workspaceId, parsed.input, nativeRecord!);
          return [{ row, parsed }];
        });
        if (matches.length !== 1) deny("Exact actor-owned current native authoring payload witness is required.");
        nativeInput = matches[0]!.parsed.input;
        nativeReceiptHash = hash(matches[0]!.row);
      }
    if (!record) throw Error("Recipe was not found.");
    if (args.expected_revision && args.expected_revision !== record.revision) throw Error("Recipe revision does not match expected_revision.");
    if (args.expected_digest && args.expected_digest !== record.executableDigest) throw Error("Recipe digest does not match expected_digest.");
    normalizeLegacyRecipeInputs(parseDefinition(record.definition).model, inputText);
    const projectId = String(args.project_id ?? "");
    const closure = executionRecipes(db, owner, journal, base, record, projectId);
    const context = { context: closure.contexts.get(record.recipeId)!, pins: closure.pins };
    const runtimeBindings = workflowRuntimeBindingsFromOriginalInputs(parseDefinition(record.definition).model,
      JSON.parse(inputText));
    const source = retainedExecutionSource(db, journal, buildSource(host, base, record, {
      kind: nativeRecord ? "overlay" : "canonical", purpose: "execute",
      nativeRecipeId: nativeRecord ? nativeRecord.recipeId.slice("recipe_".length) : null,
      nativeRecordSha256: hash(nativeRecord ?? record), nativeReceiptSha256: nativeReceiptHash,
      previousNativeSnapshotSha256: snapshot, nativeSnapshotSha256: snapshot,
      publicExecutableDigest: record.executableDigest, payloadSha256: hash({ recipeId: record.recipeId,
        revision: record.revision, executableDigest: record.executableDigest, runtimeBindings: runtimeBindings ?? null }), knowledgePins: context.pins,
      ...(runtimeBindings ? { runtimeBindings, executionSemantics: "native-runtime-bindings/v1" as const } : {}),
      ...(closure.reachableRecipes ? { reachableRecipes: closure.reachableRecipes } : {}),
      ...(projectId ? { rootProjectId: projectId } : {}),
    }), receipts);
    if (nativeSnapshot(db, journal.workspaceId) !== snapshot) deny("Reachable Library sources changed during capture.");
    const approved = await approve(owner, host, source, signal);
    await verifyBase(owner, host, source); assertKnowledge(owner.workspaceRoot(), source);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (nativeSnapshot(db, journal.workspaceId) !== snapshot) deny("Native source changed during admission.");
      assertOriginalMcpNativeRecipeSourceApprovalCurrent(approved.approval);
      storeReceipt(db, journal.workspaceId, receiptPrefix + "admit:" + source.planSha256 + ":" + approved.approval.decisionId,
        { schema: "pkm.original-native-recipe-receipt/v1", kind: "admit", source,
          approval: approved.approval, record: record as never, nativeInput: nativeInput as never, publicArguments: args as never });
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    bind(storage, { owner, host, source, recipe: record, ...approved, lifetime: new AbortController(), context: context.context,
      recipes: closure.recipes, contexts: closure.contexts, base });
    return acquireOriginalMcpNativeRecipeLibraryExecution(owner, host);
  } finally { if (library) library.close(); else db.close(); }
}
export async function readOriginalMcpNativeRecipeLibrarySearch(owner: RootOwner, host: OriginalMcpNativeHost,
  actor: Readonly<Actor>, args: Record<string, unknown>, signal?: AbortSignal) {
  const { storage, journal } = await originalRecipeLibraryScope(owner, host);
  assertPublic(storage, host, actor, "recipe_search", args, true);
  let state = states.get(storage) ?? metadataStates.get(storage);
  if (state) {
    try { assertState(storage, state); }
    catch {
      state.lifetime.abort();
      if (states.get(storage) === state) states.delete(storage);
      if (metadataStates.get(storage) === state) metadataStates.delete(storage);
      state = undefined;
    }
  }
  if (!state) {
    const base = await captureOriginalMcpRecipeLibraryBase(owner, host), db = storage.connectNative();
    let library: NativeRecipeLibrary | undefined;
    try {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE name='native_recipe_library_records'").get()
        || !db.prepare("SELECT 1 FROM native_recipe_library_records LIMIT 1").get()) return undefined;
      library = new NativeRecipeLibrary({ database: db, workspaceId: journal.workspaceId,
        assertLease() { owner.assertWorkspaceLease(); signal?.throwIfAborted(); },
        original: () => ({ recipes: base.recipes, snapshotRevision: base.snapshotRevision }) });
      const current = library.snapshot().recipes.filter(recipe =>
        db.prepare("SELECT 1 FROM native_recipe_library_records WHERE recipe_id=?").get(recipe.recipeId));
      const witnesses = db.prepare("SELECT * FROM native_recipe_library_receipts WHERE operation_id LIKE ? LIMIT 4097")
        .all(nativeRecipePayloadReceiptPrefix + "%");
      if (witnesses.length > 4096 || !current.length) deny("Current native metadata source is incomplete.");
      let selectedInput: NativeInput | undefined, selectedWitness: Record<string, unknown> | undefined;
      for (const record of current) {
        const candidates = witnesses.flatMap(row => {
          if (row.workspace_id !== journal.workspaceId || typeof row.result !== "string") return [];
          const candidate = nativeRecipePayloadReceiptSchema.parse(JSON.parse(row.result));
          if (row.actor_id !== candidate.input.actorId) deny("Native metadata payload actor proof changed.");
          return candidate.recordSha256 === hash(record) && candidate.input.recipeId === record.recipeId ? [{ candidate, row }] : [];
        });
        if (candidates.length !== 1) deny("Each native metadata record needs an exact current producer payload witness.");
        payloadReceipt(db, journal.workspaceId, candidates[0]!.candidate.input, record as LibraryRecord);
        if (!selectedInput) { selectedInput = candidates[0]!.candidate.input; selectedWitness = candidates[0]!.row; }
      }
      const record = current[0]!, snapshot = nativeSnapshot(db, journal.workspaceId);
      const emptyContext = resolveRecipeKnowledgeContext(owner.workspaceRoot(), { ...record, nodeBindings: [] }, []);
      const source = buildSource(host, base, record, { kind: "overlay", purpose: "read",
        nativeRecipeId: record.recipeId.slice("recipe_".length), nativeRecordSha256: hash(record),
        nativeReceiptSha256: hash(selectedWitness), nativeSnapshotSha256: snapshot, previousNativeSnapshotSha256: snapshot,
        publicExecutableDigest: record.executableDigest, payloadSha256: hash({ purpose: "read", snapshot }), knowledgePins: [] });
      const approved = await approve(owner, host, source, signal);
      await verifyBase(owner, host, source);
      if (nativeSnapshot(db, journal.workspaceId) !== snapshot) deny("Native metadata source changed during consent.");
      storeReceipt(db, journal.workspaceId, receiptPrefix + "read:" + source.planSha256 + ":" + approved.approval.decisionId,
        { schema: "pkm.original-native-recipe-receipt/v1", kind: "admit", source, approval: approved.approval,
          record: record as never, nativeInput: selectedInput as never, publicArguments: args as never });
      state = { owner, host, source, recipe: record, ...approved, lifetime: new AbortController(), context: emptyContext, base };
      bind(storage, state);
    } finally { if (library) library.close(); else db.close(); }
  }
  assertState(storage, state);
  const base = await verifyBase(owner, host, state.source), db = storage.connectNative();
  try {
    const catalogue = new Map(base.recipes.map(record => [record.recipeId, record]));
    const native = new NativeRecipeLibrary({ database: db, workspaceId: journal.workspaceId,
      assertLease() { assertState(storage, state!); }, original: () => ({ recipes: base.recipes, snapshotRevision: base.snapshotRevision }) });
    for (const record of native.snapshot().recipes) catalogue.set(record.recipeId, record);
    for (const row of db.prepare("SELECT * FROM native_recipe_library_receipts WHERE operation_id LIKE ? LIMIT 4097").all(receiptPrefix + "author:%")) {
      const receipt = readReceipt(db, journal, row);
      if (receipt.kind !== "author") deny("Unexpected native authoring receipt kind.");
      let record = receipt.record as unknown as ProjectRecipeRecord;
      const currentNative = catalogue.get(`recipe_${receipt.source.nativeRecipeId}`);
      if (currentNative && currentNative.revision >= record.revision) record = projection(currentNative as LibraryRecord, record.recipeId);
      catalogue.delete(`recipe_${receipt.source.nativeRecipeId}`);
      const current = catalogue.get(record.recipeId);
      if (!current || current.revision < record.revision) catalogue.set(record.recipeId, record);
    }
    const { searchLocalRecipes } = await import("./legacy-recipe-search.js");
    const { legacyRecipeSearchInput } = await import("./recipe-public-contracts.js");
    const result = searchLocalRecipes([...catalogue.values()], legacyRecipeSearchInput.parse(args));
    signal?.throwIfAborted(); assertState(storage, state);
    return result;
  } finally { db.close(); }
}
export async function verifyOriginalMcpNativeRecipeLibraryReadState(database: DatabaseSync, journal: OriginalMcpJournal) {
  databaseSchema(database);
  const allRows = database.prepare("SELECT * FROM native_recipe_library_receipts LIMIT 16385").all();
  if (allRows.length > 16384) deny("Historical native Library receipt envelope exceeded.");
  const admitted = allRows.filter(row => String(row.operation_id).startsWith(receiptPrefix))
    .map(row => readReceipt(database, journal, row));
  const captures = new Map<string, Awaited<ReturnType<typeof captureOriginalMcpRecipeLibraryJournalBase>>>();
  const verified = new Map<string, ProjectRecipeRecord[]>();
  for (const receipt of admitted) {
    const source = receipt.source;
    const key = `${source.maxFileBytes}:${source.files.some(file => file.path === ".pkm/state/projects.json")}`;
    if (!captures.has(key)) captures.set(key, await captureOriginalMcpRecipeLibraryJournalBase(journal, source.maxFileBytes,
      source.files.some(file => file.path === ".pkm/state/projects.json")));
    const base = captures.get(key)!;
    if (canonicalJson(base.files) !== canonicalJson(source.files)) deny("Historical native Recipe source membership/custody pins changed.");
    assertOriginalMcpNativeRecipeLibraryFiles(source);
    if (source.kind === "canonical" && !base.recipes.some(recipe => hash(recipe) === source.recordSha256))
      deny("Historical canonical Recipe source payload changed.");
    verified.set(source.planSha256, historicalExecutionRecipes(database, journal, source,
      receipt.record as unknown as ProjectRecipeRecord, base));
  }
  const witnessRows = allRows.filter(row => String(row.operation_id).startsWith(nativeRecipePayloadReceiptPrefix));
  for (const row of witnessRows) {
    if (row.workspace_id !== journal.workspaceId || typeof row.actor_id !== "string" || !row.actor_id || typeof row.result !== "string")
      deny("Foreign historical native payload witness.");
    const parsed = nativeRecipePayloadReceiptSchema.parse(JSON.parse(row.result));
    if (row.result !== canonicalJson(parsed) || row.fingerprint !== hash(parsed) || parsed.input.actorId !== row.actor_id)
      deny("Malformed historical native payload witness.");
    const native = allRows.find(item => item.operation_id === parsed.input.operationId);
    if (!native || native.workspace_id !== journal.workspaceId || native.actor_id !== parsed.input.actorId
      || native.fingerprint !== hash(parsed.input) || hash(JSON.parse(String(native.result))) !== parsed.recordSha256)
      deny("Orphaned or changed historical native producer receipt.");
  }
  for (const row of rows(database, journal.workspaceId)) {
    if (typeof row.record !== "string" || row.digest !== hash(JSON.parse(row.record))) deny("Changed native Library record.");
    const record = JSON.parse(row.record) as LibraryRecord;
    const base = [...captures.values()][0]?.recipes.find(recipe => recipe.recipeId === record.recipeId);
    if (row.original_digest !== hash(base ?? null)) deny("Historical native overlay canonical authority changed.");
    if (!admitted.some(receipt => receipt.source.kind === "overlay" && receipt.source.nativeRecordSha256 === row.digest
      || receipt.source.reachableRecipes?.some(pin => pin.nativeRecipeId && `recipe_${pin.nativeRecipeId}` === row.recipe_id
        && pin.nativeRecordSha256 === row.digest)))
      deny("Nonempty native Library record lacks a separately approved current native source proof.");
  }
  for (const row of allRows) {
    if (String(row.operation_id).startsWith(receiptPrefix) || String(row.operation_id).startsWith(nativeRecipePayloadReceiptPrefix)) continue;
    if (!witnessRows.some(witness => witness.operation_id === nativeRecipePayloadReceiptPrefix + row.operation_id))
      deny("Historical native authoring receipt cannot acquire a fabricated payload witness.");
  }
  return admitted.filter(receipt => receipt.source.purpose === "execute" && (receipt.kind === "admit" || receipt.kind === "adhoc"))
    .map(receipt =>     ({ source: receipt.source, recipe: receipt.record as unknown as ProjectRecipeRecord,
      recipes: verified.get(receipt.source.planSha256)! }));
}
