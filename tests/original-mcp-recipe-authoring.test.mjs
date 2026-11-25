import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { recipeExecutionFixture, originalRecipeTraceProjection } from "./fixtures/original-mcp-recipe-execution-fixture.mjs";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { canonicalJson } from "../dist/domain/project-recipes-workflow-contracts.js";
import { NativeRecipeLibrary } from "../dist/native-recipe-library.js";
import { captureOriginalMcpRecipeLibraryBase } from "../dist/original-mcp-recipe-library.js";
import { assertOriginalMcpNativeRecipeSourceApprovalCurrent,
  originalMcpNativeRecipeSourceApprovalSignal } from "../dist/original-mcp-native-recipe-policy.js";
import { verifyOriginalMcpNativeRecipeLibraryReadState,
  prepareOriginalMcpRecipeLibraryRun,
  acquireOriginalMcpNativeRecipeLibraryExecution,
  prepareOriginalMcpRecipeAdhoc } from "../dist/original-mcp-recipe-authoring.js";
import { withOriginalMcpPublicRequest } from "../dist/original-mcp-native-host.js";
import { assertOriginalMcpPrivacy } from "../dist/original-mcp-root-custody.js";
import { originalRecipeLibrarySource, originalNativeRecipeLibrarySource } from "../dist/original-mcp-recipe-source-contracts.js";
import { verifyOriginalMcpHistoricalReadSchema } from "../dist/original-mcp-historical-read-schema.js";

const sha = value => createHash("sha256").update(value).digest("hex");
const knowledge = [{ area: "skills", path: "Source.md", raw:
  "---\nschema: pkm.knowledge/v1\nknowledgeId: knowledge_aaaaaaaaaaaaaaaaaaaaaaaa\naliases: [skill:Source]\nname: Source\nrevision: 3\ndescription: Required recipe gap\nrecipe_required: true\nrecipe_hint: Build a reusable Recipe\n---\nUse a Recipe for this reusable workflow.\n" }];
const skillHash = sha(canonicalJson({ name: "Source", description: "Required recipe gap", category: "",
  tags: [], content: "Use a Recipe for this reusable workflow.\n" }));
const definition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {},
  nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
  completion: { requiredNodes: ["work"] } } };
const api = f => createNativePublicOwnerBackend(f.opened.owner,
  { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: f.host });
const originalRunShape = value => {
  const result = originalRecipeTraceProjection(value);
  delete result.runtime;
  return result;
};
const prepareAdhocSource = (f, args) => withOriginalMcpPublicRequest(f.opened.storage, f.host, {
  operation: "mcp.tool.recipe_run_start_adhoc", tool: "recipe_run_start_adhoc", version: 1, readOnly: false,
  arguments: args, argumentsDigest: sha(canonicalJson(args)),
}, () => prepareOriginalMcpRecipeAdhoc(f.opened.owner, f.host, { id: "mcp:external", canWrite: true }, args));

test("native authored execution-source reactivation preserves exact plan across actual cold reopen but obtains fresh signed approval", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t, { knowledge }), backend = api(f);
  const authored = await backend.invoke("original_mcp_public", { tool: "recipe_create_from_skill", arguments: {
    name: "Cold authored source", definition_json: JSON.stringify(definition), command_id: "cold-authored-source",
    source_skill_id: "Source", source_skill_hash: skillHash } });
  assert.equal(authored.structuredContent.ok, true, JSON.stringify(authored));
  const args = { recipe_id: authored.structuredContent.recipe.recipe_id, command_id: "cold-source-activation" };
  const prepare = () => withOriginalMcpPublicRequest(f.opened.storage, f.host, {
    operation: "mcp.tool.recipe_run_start", tool: "recipe_run_start", version: 1, readOnly: false,
    arguments: args, argumentsDigest: sha(canonicalJson(args)),
  }, () => prepareOriginalMcpRecipeLibraryRun(f.opened.owner, f.host, { id: "mcp:external", canWrite: true }, args));
  const first = await prepare(), oldEpoch = f.host.receipt.epoch, oldReceipt = f.host.receipt.receiptSha256;
  assert.equal(first.source.purpose, "execute");
  assert.deepEqual(first.catalog().recipes.map(recipe => recipe.recipeId), [args.recipe_id]);
  await backend.close(); await f.close(); await f.reopen();
  assert.notEqual(f.host.receipt.epoch, oldEpoch);
  f.controls.allow = false;
  await assert.rejects(prepare(), /Native source\/authoring decision denied/);
  assert.equal(await acquireOriginalMcpNativeRecipeLibraryExecution(f.opened.owner, f.host), undefined);
  f.controls.allow = true;
  const second = await prepare();
  assert.deepEqual(second.source, first.source);
  assert.equal(first.signal.aborted, true);
  second.assertCurrent();
  const requests = f.frames.filter(frame => frame.method === "recipe.source.approve"
    && frame.payload.request.purpose === "execute").map(frame => frame.payload.request);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].planSha256, requests[2].planSha256);
  assert.equal(requests[0].nativeHostReceiptSha256, oldReceipt);
  assert.equal(requests[2].nativeHostReceiptSha256, f.host.receipt.receiptSha256);
  assert.notEqual(requests[0].nativeHostReceiptSha256, requests[2].nativeHostReceiptSha256);
});

test("actual original public from-Skill authoring preserves deterministic identity, required binding and idempotent receipt", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t, { knowledge });
  const args = { name: "Reusable Skill Recipe", description: "Concrete reusable workflow", category: "",
    definition_json: JSON.stringify(definition), command_id: "fresh-from-skill", source_skill_id: "Source",
    source_skill_hash: skillHash };
  const old = f.oracle([{ tool: "recipe_create_from_skill", args }, { tool: "recipe_create_from_skill", args }]);
  assert.equal(old[0].ok, true, JSON.stringify(old));
  t.diagnostic(JSON.stringify({ behavior: "from-skill", originalResponses: old }));
  const backend = api(f);
  try {
    for (const [index, call] of [{ tool: "recipe_create_from_skill", arguments: args },
      { tool: "recipe_create_from_skill", arguments: args }].entries()) {
      const result = await backend.invoke("original_mcp_public", call);
      assert.deepEqual(result.structuredContent, old[index]);
    }
    const start = { recipe_id: old[0].recipe.recipe_id, command_id: "from-skill-empty-inputs", inputs_json: "" };
    const originalStart = f.oracle([{ tool: "recipe_run_start", args: start }])[0];
    assert.equal(originalStart.ok, true, JSON.stringify(originalStart));
    const actualStart = await backend.invoke("original_mcp_public", { tool: "recipe_run_start", arguments: start });
    assert.equal(actualStart.structuredContent.ok, true, JSON.stringify(actualStart));
    assert.equal(actualStart.structuredContent.runtime.executionSemantics, "original-recipe-metadata/v1");
    assert.deepEqual(originalRunShape(actualStart.structuredContent), originalRunShape(originalStart));
  } finally { await backend.close(); }
});

test("first public from-Skill Recipe authors and replays against a genuinely empty current Library without weakening canonical file manifests", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t, { knowledge, emptyLibrary: true,
    project: { projectId: "project_" + randomUUID(), name: "Existing workspace Project" } }), backend = api(f);
  assert.deepEqual((await captureOriginalMcpRecipeLibraryBase(f.opened.owner, f.host)).files, []);
  const args = { name: "First reusable Recipe", definition_json: JSON.stringify(definition), command_id: "first-empty-library-recipe",
    source_skill_id: "Source", source_skill_hash: skillHash };
  const old = f.oracle([{ tool: "recipe_create_from_skill", args }, { tool: "recipe_create_from_skill", args }]);
  assert(old.every(value => value.ok), JSON.stringify(old));
  try {
    for (const [index, call] of old.entries()) {
      const actual = await backend.invoke("original_mcp_public", { tool: "recipe_create_from_skill", arguments: args });
      assert.deepEqual(actual.structuredContent, call, `first native Recipe public call ${index}`);
    }
    const reviews = f.frames.filter(frame => frame.method === "recipe.source.approve"
      && frame.payload.request.schema === "pkm.original-native-recipe-library-source/v1");
    assert(reviews.length > 0);
    assert(reviews.every(frame => frame.payload.request.files.length === 0));
    assert.equal(f.frames.some(frame => frame.method === "recipe.effect.approve"), false);
    assert.equal(originalRecipeLibrarySource.shape.files.safeParse([]).success, false);
    assert.equal(originalNativeRecipeLibrarySource.shape.files.safeParse([{
      path: "recipes/forged.json", sha256: "invalid", bytes: 0, pin: "", authority: "independent-canonical",
    }]).success, false);
    const file = { path: "recipes/valid-shape.json", sha256: "a".repeat(64), bytes: 0, pin: "descriptor",
      authority: "independent-canonical" };
    assert.equal(originalRecipeLibrarySource.shape.files.safeParse([file]).success, false);
    assert.equal(originalNativeRecipeLibrarySource.shape.files.safeParse(Array(129).fill(file)).success, false);
  } finally { await backend.close(); }
});

test("public from-Skill admits valid original repeat metadata as definition-only, without scheduling or effect consent", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t, { knowledge }), backend = api(f);
  const graph = structuredClone(definition);
  graph.spec.nodes[0].control = { mode: "repeat", count: { kind: "dynamic" } };
  const args = { name: "Original repeat metadata", definition_json: JSON.stringify(graph), command_id: "authored-controls",
    source_skill_id: "Source", source_skill_hash: skillHash };
  try {
    const expected = f.oracle([{ tool: "recipe_create_from_skill", args }])[0];
    assert.equal(expected.ok, true, JSON.stringify(expected));
    const actual = await backend.invoke("original_mcp_public", { tool: "recipe_create_from_skill", arguments: args });
    assert.deepEqual(actual.structuredContent, expected);
    const source = f.frames.find(frame => frame.method === "recipe.source.approve").payload.request;
    assert.equal(source.executionSemantics, "definition-only/v1");
    assert.equal(source.noExecution, true);
    assert.equal(f.frames.filter(frame => frame.method === "recipe.effect.approve").length, 0);
  } finally { await backend.close(); }
});

test("public from-Skill replay compares semantic JSON and rejects changed authoring payload or stale Skill content", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t, { knowledge }), backend = api(f);
  const args = { name: "Semantic Recipe", description: "Reusable", category: "",
    definition_json: JSON.stringify(definition), command_id: "semantic-from-skill",
    source_skill_id: "Source", source_skill_hash: skillHash };
  try {
    const invoke = args => backend.invoke("original_mcp_public", { tool: "recipe_create_from_skill", arguments: args });
    assert.equal((await invoke(args)).structuredContent.ok, true);
    assert.equal((await invoke({ ...args, definition_json: JSON.stringify(definition, null, 2) })).structuredContent.replayed, true);
    assert.equal((await invoke({ ...args, name: "Changed payload" })).structuredContent.ok, false);
    writeFileSync(join(f.root, "skills/Source.md"), knowledge[0].raw.replace("Use a Recipe", "Changed workflow"));
    assert.equal((await invoke({ ...args, command_id: "stale-skill" })).structuredContent.ok, false);
  } finally { await backend.close(); }
});

test("public from-Skill denied native write/source review cannot create a record or durable receipt", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t, { knowledge }), backend = api(f);
  f.controls.allow = false;
  try {
    const result = await backend.invoke("original_mcp_public", { tool: "recipe_create_from_skill", arguments: {
      name: "Denied source", definition_json: JSON.stringify(definition), command_id: "denied-source",
      source_skill_id: "Source", source_skill_hash: skillHash } });
    assert.equal(result.structuredContent.ok, false);
    const db = f.opened.storage.connectNative();
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM native_recipe_library_records").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM native_recipe_library_receipts").get().count, 0);
    } finally { db.close(); }
  } finally { await backend.close(); }
});

test("public native Library metadata admits a fresh exact payload witness, remains read-only and follows native revisions", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t), backend = api(f);
  const base = await captureOriginalMcpRecipeLibraryBase(f.opened.owner, f.host);
  const library = new NativeRecipeLibrary({ database: f.opened.storage.connectNative(), workspaceId: f.host.receipt.workspaceId,
    assertLease() { f.opened.owner.assertWorkspaceLease(); }, original: () => base });
  try {
    const draft = library.draft(f.recipe.recipeId), fields = library.editable(draft);
    fields.name = "Fresh native metadata";
    const saved = library.save({ actorId: "vscode:operator", operationId: randomUUID(), recipeId: draft.recipeId,
      expectedRevision: 0, expectedSnapshot: library.snapshot().snapshotRevision, fields });
    const search = async () => (await backend.invoke("original_mcp_public",
      { tool: "recipe_search", arguments: { query: "Fresh native metadata" } })).structuredContent;
    const first = await search();
    assert.equal(first.candidates.find(recipe => recipe.recipe_id === saved.recipeId)?.revision, 1, JSON.stringify(first));
    assert.equal(f.frames.filter(frame => frame.method === "recipe.effect.approve").length, 0);
    const start = async command_id => (await backend.invoke("original_mcp_public", { tool: "recipe_run_start",
      arguments: { recipe_id: saved.recipeId, command_id } })).structuredContent;
    const originalRun = await start("native-revision-one");
    assert.equal(originalRun.ok, true, JSON.stringify(originalRun));
    const originalSource = await acquireOriginalMcpNativeRecipeLibraryExecution(f.opened.owner, f.host);
    const updated = library.save({ actorId: "vscode:operator", operationId: randomUUID(), recipeId: saved.recipeId,
      expectedRevision: 1, expectedSnapshot: library.snapshot().snapshotRevision,
      fields: { ...library.editable(saved), description: "Current native revision two" } });
    const newRun = await start("native-revision-two");
    assert.equal(newRun.ok, true, JSON.stringify(newRun));
    assert.equal(newRun.recipe.revision, 2);
    assert.equal(originalSource.signal.aborted, true);
    assert.equal(f.frames.filter(frame => frame.method === "recipe.source.approve"
      && frame.payload.request.purpose === "execute").length, 2);
    const second = await search();
    assert.equal(second.candidates.find(recipe => recipe.recipe_id === updated.recipeId)?.revision, 2, JSON.stringify(second));
  } finally { library.close(); await backend.close(); }
});

test("public native metadata never upgrades a historical bare native save receipt into current producer authority", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t), backend = api(f);
  const base = await captureOriginalMcpRecipeLibraryBase(f.opened.owner, f.host);
  const library = new NativeRecipeLibrary({ database: f.opened.storage.connectNative(), workspaceId: f.host.receipt.workspaceId,
    assertLease() { f.opened.owner.assertWorkspaceLease(); }, original: () => base });
  try {
    const draft = library.draft(f.recipe.recipeId), request = { actorId: "vscode:operator", operationId: randomUUID(),
      recipeId: draft.recipeId, expectedRevision: 0, expectedSnapshot: library.snapshot().snapshotRevision, fields: library.editable(draft) };
    library.save(request);
    const db = f.opened.storage.connectNative();
    try { db.prepare("DELETE FROM native_recipe_library_receipts WHERE operation_id=?").run("native-library-payload:" + request.operationId); }
    finally { db.close(); }
    await assert.rejects(backend.invoke("original_mcp_public", { tool: "recipe_search", arguments: {} }),
      /exact current producer payload witness/);
    assert.equal(f.frames.filter(frame => frame.method === "recipe.source.approve").length, 0);
  } finally { library.close(); await backend.close(); }
});

test("public from-Skill resolves the actual modern Knowledge identity and never replaces it with an inferred alias", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t, { knowledge }), backend = api(f);
  try {
    const result = await backend.invoke("original_mcp_public", { tool: "recipe_create_from_skill", arguments: {
      name: "Modern identity Recipe", description: "Required exact identity", category: "",
      definition_json: JSON.stringify(definition), command_id: "modern-source",
      source_skill_id: "knowledge_aaaaaaaaaaaaaaaaaaaaaaaa", source_skill_hash: skillHash } });
    assert.equal(result.structuredContent.ok, true, JSON.stringify(result.structuredContent));
    const db = f.opened.storage.connectNative();
    try {
      const record = JSON.parse(db.prepare("SELECT record FROM native_recipe_library_records").get().record);
      assert.equal(record.nodeBindings[0].bindings[0].knowledgeId, "knowledge_aaaaaaaaaaaaaaaaaaaaaaaa");
    } finally { db.close(); }
  } finally { await backend.close(); }
});

test("actual signed source review keeps read and execution decisions independent while session revoke fences both", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t, { knowledge }), backend = api(f);
  try {
    const authored = await backend.invoke("original_mcp_public", { tool: "recipe_create_from_skill", arguments: {
      name: "Separate review lanes", definition_json: JSON.stringify(definition), command_id: "review-lanes",
      source_skill_id: "Source", source_skill_hash: skillHash } });
    assert.equal(authored.structuredContent.ok, true, JSON.stringify(authored.structuredContent));
    const original = f.frames.find(frame => frame.method === "recipe.source.approve").payload.request;
    const request = purpose => {
      const { planSha256, phase, actorId, epoch, nativeHostReceiptSha256, ...body } = original;
      body.purpose = purpose;
      return { ...body, planSha256: sha(canonicalJson(body)), phase, actorId, epoch, nativeHostReceiptSha256 };
    };
    const execute = await f.producer.policy.authorize(request("execute"), new AbortController().signal);
    const read = await f.producer.policy.authorize(request("read"), new AbortController().signal);
    assertOriginalMcpNativeRecipeSourceApprovalCurrent(execute);
    assert.equal(originalMcpNativeRecipeSourceApprovalSignal(execute).aborted, false);
    await f.producer.policy.authorize(request("execute"), new AbortController().signal);
    assert.equal(originalMcpNativeRecipeSourceApprovalSignal(execute).aborted, true);
    assertOriginalMcpNativeRecipeSourceApprovalCurrent(read);
    f.producer.revoke();
    assert.equal(originalMcpNativeRecipeSourceApprovalSignal(read).aborted, true);
  } finally { await backend.close(); }
});

test("public from-Skill Project authoring uses the sealed actual Project name and Original portable category", { timeout: 90000 }, async t => {
  const project = { projectId: "project_70000000-0000-4000-a000-000000000007", name: "Reusable Project" };
  const f = await recipeExecutionFixture(t, { knowledge, project }), backend = api(f);
  const args = { name: "Project Skill Recipe", description: "Project scoped", category: "Reusable",
    definition_json: JSON.stringify(definition), command_id: "project-from-skill", source_skill_id: "Source",
    source_skill_hash: skillHash, scope: "project", project_id: project.projectId };
  try {
    const expected = f.oracle([{ tool: "recipe_create_from_skill", args }])[0];
    assert.equal(expected.ok, true, JSON.stringify(expected));
    const actual = await backend.invoke("original_mcp_public", { tool: "recipe_create_from_skill", arguments: args });
    assert.deepEqual(actual.structuredContent, expected);
  } finally { await backend.close(); }
});

test("public from-Skill binds the first raw node before compilation and replays the same normalized definition", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t, { knowledge }), backend = api(f);
  const raw = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {},
    nodes: ["z", "a"].map(nodeId => ({ nodeId, kind: "pkm.step.noop/v1", config: {}, dependsOn: [] })),
    completion: { requiredNodes: ["z", "a"] } } };
  const args = { name: "First original node", definition_json: JSON.stringify(raw), command_id: "first-raw-node",
    source_skill_id: "Source", source_skill_hash: skillHash };
  const replay = { ...args, definition_json: JSON.stringify({ ...raw, spec: { ...raw.spec, nodes: [...raw.spec.nodes].reverse() } }),
    source_skill_node_id: "z" };
  try {
    const expected = f.oracle([{ tool: "recipe_create_from_skill", args }, { tool: "recipe_create_from_skill", args: replay }]);
    assert.equal(expected[0].ok, true, JSON.stringify(expected));
    assert.equal(expected[1].replayed, true, JSON.stringify(expected));
    for (const [index, arguments_] of [args, replay].entries()) {
      const actual = await backend.invoke("original_mcp_public", { tool: "recipe_create_from_skill", arguments: arguments_ });
      assert.deepEqual(actual.structuredContent, expected[index]);
    }
    const db = f.opened.storage.connectNative();
    try { assert.equal(JSON.parse(db.prepare("SELECT record FROM native_recipe_library_records").get().record).nodeBindings[0].nodeId, "z"); }
    finally { db.close(); }
  } finally { await backend.close(); }
});

test("public from-Skill replay of an actual Original-authored canonical identity does not create a shadow native record", { timeout: 90000 }, async t => {
  const args = { name: "Already Original", definition_json: JSON.stringify(definition), command_id: "existing-original-skill",
    source_skill_id: "Source", source_skill_hash: skillHash };
  const f = await recipeExecutionFixture(t, { knowledge, seedFromSkill: args }), backend = api(f);
  try {
    const expected = f.oracle([{ tool: "recipe_create_from_skill", args }])[0];
    assert.equal(expected.replayed, true, JSON.stringify(expected));
    const actual = await backend.invoke("original_mcp_public", { tool: "recipe_create_from_skill", arguments: args });
    assert.deepEqual(actual.structuredContent, expected);
    const db = f.opened.storage.connectNative();
    try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM native_recipe_library_records").get().count, 0); }
    finally { db.close(); }
  } finally { await backend.close(); }
});

test("public from-Skill resolves a fresh canonical Project instead of trusting a stale legacy Project envelope", { timeout: 90000 }, async t => {
  const project = { projectId: "project_70000000-0000-4000-a000-000000000008", name: "Current canonical Project" };
  const f = await recipeExecutionFixture(t, { knowledge, project, projectCanonical: true }), backend = api(f);
  try {
    const actual = await backend.invoke("original_mcp_public", { tool: "recipe_create_from_skill", arguments: {
      name: "Canonical Project Recipe", definition_json: JSON.stringify(definition), command_id: "canonical-project",
      source_skill_id: "Source", source_skill_hash: skillHash, scope: "project", project_id: project.projectId } });
    assert.equal(actual.structuredContent.ok, true, JSON.stringify(actual.structuredContent));
    assert.equal(actual.structuredContent.recipe.category, "Project/Current canonical Project");
    const source = f.frames.find(frame => frame.method === "recipe.source.approve").payload.request;
    assert.ok(source.files.some(file => file.path === ".pkm/state/project-store.json"));
    assert.ok(source.files.some(file => file.path.startsWith("project/")));
    const intent = join(f.root, ".pkm/state/project-store-intent.json");
    const pending = '{"schema":1,"domain":{},"control":{}}';
    writeFileSync(intent, pending);
    await assert.rejects(captureOriginalMcpRecipeLibraryBase(f.opened.owner, f.host, 2_097_152, true));
    assert.equal(readFileSync(intent, "utf8"), pending);
  } finally { await backend.close(); }
});

test("native authored cold history validates exact payload/host/source pins without turning authoring into execution", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t, { knowledge }), backend = api(f);
  try {
    const authored = await backend.invoke("original_mcp_public", { tool: "recipe_create_from_skill", arguments: {
      name: "Cold authored history", definition_json: JSON.stringify(definition), command_id: "cold-author",
      source_skill_id: "Source", source_skill_hash: skillHash } });
    assert.equal(authored.structuredContent.ok, true, JSON.stringify(authored.structuredContent));
    const journal = assertOriginalMcpPrivacy(f.root), db = f.opened.storage.connectNative();
    try {
      assert.deepEqual(await verifyOriginalMcpNativeRecipeLibraryReadState(db, journal), []);
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE native_recipe_library_receipts SET fingerprint=? WHERE operation_id LIKE ?")
          .run("0".repeat(64), "native-library-payload:%");
        await assert.rejects(verifyOriginalMcpNativeRecipeLibraryReadState(db, journal), /payload witness/);
      } finally { db.exec("ROLLBACK"); }
      const before = readFileSync(f.sourceFile);
      try {
        writeFileSync(f.sourceFile, before);
        await assert.rejects(verifyOriginalMcpNativeRecipeLibraryReadState(db, journal), /source membership\/custody pins changed/);
      } finally { writeFileSync(f.sourceFile, before); }
    } finally { db.close(); }
  } finally { await backend.close(); }
});

test("actual original public adhoc start admits exact instance-only definition and required Skill input without authoring a Library record", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t, { knowledge });
  const bindings = [{ nodeId: "work", bindings: [{ bindingId: "source", kind: "skill",
    knowledgeId: "Source", contentHash: skillHash, usage: "required" }] }];
  const args = { name: "Concrete adhoc", definition_json: JSON.stringify(definition), command_id: "fresh-bound-adhoc",
    node_bindings_json: JSON.stringify(bindings) };
  const runId = "recipe_run_" + sha(args.command_id).slice(0, 24);
  const claim = { run_id: runId, command_id: "claim-bound-adhoc" };
  const old = f.oracle([{ tool: "recipe_run_start_adhoc", args }, { tool: "recipe_run_next", args: claim }]);
  assert.equal(old[0].ok, true, JSON.stringify(old));
  t.diagnostic(JSON.stringify({ behavior: "bound-adhoc", originalResponse: old[0] }));
  const backend = api(f);
  try {
    const result = await backend.invoke("original_mcp_public", { tool: "recipe_run_start_adhoc", arguments: args });
    assert.equal(result.structuredContent.runtime.executionSemantics, "original-recipe-metadata/v1");
    assert.deepEqual(originalRunShape(result.structuredContent), old[0]);
    const next = await backend.invoke("original_mcp_public", { tool: "recipe_run_next", arguments: claim });
    assert.deepEqual(originalRunShape(next.structuredContent), originalRunShape(old[1]));
    assert.deepEqual(next.structuredContent.next_action.knowledge_bindings, bindings[0].bindings);
    const db = f.opened.storage.connectNative();
    try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM native_recipe_library_records").get().count, 0); }
    finally { db.close(); }
    writeFileSync(join(f.root, "skills/Source.md"), knowledge[0].raw + "Changed current required Skill.\n");
    await assert.rejects(backend.invoke("original_mcp_public", { tool: "recipe_run_report", arguments: {
      run_id: runId, node_id: "work", command_id: "report-stale-bound-adhoc", outcome: "succeeded", result_json: "null",
    } }), /Knowledge|binding|source|changed/i);
  } finally { await backend.close(); }
});

test("public adhoc normalizes Original typed defaults for replay and rejects command conflict before revoking its active source", { timeout: 90000 }, async t => {
  const graph = structuredClone(definition);
  graph.spec.inputs = { message: { type: "string", required: false, nullable: false, schema: {}, default: "same" } };
  const f = await recipeExecutionFixture(t), backend = api(f);
  const initial = { name: "Semantic adhoc", definition_json: JSON.stringify(graph), command_id: "semantic-adhoc",
    detail: " COMPACT " };
  const equivalent = { ...initial, detail: "compact", inputs_json: '{"message":"same"}' };
  const changed = { ...equivalent, inputs_json: '{"message":"different"}' };
  const old = f.oracle([initial, equivalent, changed].map(args => ({ tool: "recipe_run_start_adhoc", args })));
  assert.equal(old[0].ok, true, JSON.stringify(old));
  assert.deepEqual(old[1], { ...old[0], replayed: true });
  assert.equal(old[2].ok, false);
  try {
    for (const [index, args] of [initial, equivalent, changed].entries()) {
      const actual = await backend.invoke("original_mcp_public", { tool: "recipe_run_start_adhoc", arguments: args });
      if (index < 2) assert.equal(actual.structuredContent.runtime.executionSemantics, "original-recipe-metadata/v1");
      assert.deepEqual(originalRunShape(actual.structuredContent), old[index], JSON.stringify(actual));
    }
    const active = await acquireOriginalMcpNativeRecipeLibraryExecution(f.opened.owner, f.host);
    active.assertCurrent();
    assert.equal(f.frames.filter(frame => frame.method === "recipe.source.approve"
      && frame.payload.request.kind === "adhoc").length, 1);
  } finally { await backend.close(); }
});

test("actual public adhoc distinguishes Original once-only metadata from declared native repeat controls and typed outputs", { timeout: 90000 }, async t => {
  const graph = structuredClone(definition);
  const descriptor = { type: "string", required: true, nullable: false, schema: {} };
  graph.spec.inputs = { workflowControls: descriptor,
    count: { type: "int64", required: true, nullable: false, schema: {} } };
  graph.spec.outputs = { answer: { type: "int64", required: true, nullable: false, schema: {} } };
  graph.spec.nodes[0].control = { mode: "repeat", count: { kind: "dynamic" } };
  const f = await recipeExecutionFixture(t), backend = api(f);
  const start = { name: "Explicit controls", definition_json: JSON.stringify(graph), command_id: "original-repeat-metadata",
    inputs_json: JSON.stringify({ workflowControls: "ordinary Original string", count: "3" }) };
  const runId = command => "recipe_run_" + sha(command).slice(0, 24);
  const report = (command, index) => ({ run_id: runId(command), node_id: "work", command_id: `${command}-report-${index}`,
    outcome: "succeeded", result_json: JSON.stringify({ callerReportedIteration: index }) });
  const claim = (command, index) => ({ run_id: runId(command), command_id: `${command}-claim-${index}` });
  const old = f.oracle([{ tool: "recipe_run_start_adhoc", args: start },
    { tool: "recipe_run_next", args: claim(start.command_id, 1) },
    { tool: "recipe_run_report", args: report(start.command_id, 1) }]);
  assert.equal(old[2].status, "completed", JSON.stringify(old));
  const typed = { ...start, command_id: "native-explicit-repeat", inputs_json: JSON.stringify({ count: "3",
    workflowControls: JSON.stringify({ schema: "pkm.workflow.runtime-controls/v1", bindings: {
      nodes: { work: { repeat: { source: { kind: "input", name: "count" }, semantics: "count" } } },
      outputs: { answer: { kind: "input", name: "count" } },
    } }) }) };
  const invoke = async (tool, args) => {
    const result = (await backend.invoke("original_mcp_public", { tool, arguments: args })).structuredContent;
    if (result.status === "failed") {
      const db = f.opened.storage.connectNative();
      try { t.diagnostic(JSON.stringify({ failedPublicControls: db.prepare(
        "SELECT kind,record FROM workflow_executor_events WHERE run_id=? ORDER BY sequence DESC LIMIT 4").all(result.run_id) })); }
      finally { db.close(); }
    }
    return result;
  };
  try {
    const metadata = await invoke("recipe_run_start_adhoc", start);
    assert.equal(metadata.runtime.executionSemantics, "original-recipe-metadata/v1");
    assert.deepEqual(originalRunShape(metadata), originalRunShape(old[0]));
    assert.deepEqual(originalRunShape(await invoke("recipe_run_next", claim(start.command_id, 1))), originalRunShape(old[1]));
    assert.deepEqual(originalRunShape(await invoke("recipe_run_report", report(start.command_id, 1))), originalRunShape(old[2]));
    const native = await invoke("recipe_run_start_adhoc", typed);
    assert.equal(native.ok, true, JSON.stringify(native));
    assert.equal(native.runtime.executionSemantics, "native-runtime-bindings/v1");
    for (let iteration = 1; iteration <= 3; iteration++) {
      const offered = await invoke("recipe_run_next", claim(typed.command_id, iteration));
      assert.equal(offered.ok, true, JSON.stringify(offered));
      const current = await invoke("recipe_run_report", report(typed.command_id, iteration));
      assert.equal(current.ok, true, JSON.stringify(current));
      assert.equal(current.status, iteration === 3 ? "completed" : "running", JSON.stringify(current));
      if (iteration === 3) assert.deepEqual(current.current_result.outputs, { answer: "3" });
    }
    const db = f.opened.storage.connectNative();
    try {
      const read = command => JSON.parse(db.prepare("SELECT snapshot FROM workflow_executor_runs WHERE run_id=?").get(runId(command)).snapshot);
      const attempts = command => db.prepare("SELECT COUNT(*) AS count FROM workflow_executor_assignments WHERE run_id=?").get(runId(command)).count;
      assert.equal(attempts(start.command_id), 1);
      assert.equal(attempts(typed.command_id), 3);
      assert.deepEqual(read(typed.command_id).definition, graph);
    } finally { db.close(); }
  } finally { await backend.close(); }
});

test("actual public adhoc preserves nonalphabetical Original ready-node order and never executes an unnecessary optional node", { timeout: 90000 }, async t => {
  const graph = structuredClone(definition);
  graph.spec.nodes = ["z-first", "a-optional"].map(nodeId => ({
    nodeId, kind: "pkm.step.noop/v1", config: {}, dependsOn: [],
  }));
  graph.spec.completion.requiredNodes = ["z-first"];
  const f = await recipeExecutionFixture(t), backend = api(f), command = "authored-node-order";
  const runId = "recipe_run_" + sha(command).slice(0, 24);
  const calls = [
    { tool: "recipe_run_start_adhoc", args: { name: "Authored order", command_id: command, definition_json: JSON.stringify(graph) } },
    { tool: "recipe_run_next", args: { run_id: runId, command_id: "authored-order-claim" } },
    { tool: "recipe_run_report", args: { run_id: runId, node_id: "z-first", command_id: "authored-order-report",
      outcome: "succeeded", result_json: '{"performed":"z-first"}' } },
    { tool: "recipe_run_get", args: { run_id: runId } },
  ];
  const old = f.oracle(calls);
  assert(old.every(value => value.ok), JSON.stringify(old));
  assert.equal(old[1].next_action.node.nodeId, "z-first");
  assert.equal(old[3].status, "completed");
  try {
    for (const [index, call] of calls.entries()) {
      const actual = await backend.invoke("original_mcp_public", { tool: call.tool, arguments: call.args });
      assert.deepEqual(originalRunShape(actual.structuredContent), originalRunShape(old[index]), call.tool);
    }
    const db = f.opened.storage.connectNative();
    try {
      const run = JSON.parse(db.prepare("SELECT snapshot FROM workflow_executor_runs WHERE run_id=?").get(runId).snapshot);
      assert.deepEqual(run.definition.spec.nodes.map(node => node.nodeId), ["z-first", "a-optional"]);
      assert.deepEqual(run.nodes.filter(node => node.assignmentId).map(node => node.nodeId), ["z-first"]);
    } finally { db.close(); }
  } finally { await backend.close(); }
});

test("actual public adhoc preserves Original feedback claims, iteration history and bounded loop failure", { timeout: 90000 }, async t => {
  for (const limit of [false, true]) await t.test(limit ? "limit" : "termination", async t => {
    const graph = structuredClone(definition);
    graph.spec.nodes = [
      { nodeId: "head", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "tail", accept: ["repeat"],
        loop: { termination: { condition: "Caller explicitly reports done", maxIterations: 2 } } }] },
      { nodeId: "tail", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "head", accept: ["succeeded"] }],
        ports: { inputs: [], outputs: ["repeat", "done"] },
        control: { mode: "branch", kind: "switch", cases: ["repeat", "done"] } },
    ];
    graph.spec.completion.requiredNodes = ["tail"];
    const f = await recipeExecutionFixture(t), backend = api(f), command = `public-loop-${limit}`;
    const runId = "recipe_run_" + sha(command).slice(0, 24);
    const calls = [{ tool: "recipe_run_start_adhoc", args: {
      name: "Original feedback", command_id: command, definition_json: JSON.stringify(graph) } }];
    for (let iteration = 1; iteration <= 2; iteration++) for (const nodeId of ["head", "tail"]) {
      const again = iteration === 1 || limit;
      calls.push({ tool: "recipe_run_next", args: { run_id: runId, command_id: `claim-${iteration}-${nodeId}` } });
      if (iteration === 1 && nodeId === "head") calls.push({ tool: "recipe_run_progress", args: {
        run_id: runId, node_id: nodeId, command_id: "first-iteration-progress",
        progress_json: '{"phase":"working","message":"First iteration custom progress"}', detail: "full" } });
      calls.push({ tool: "recipe_run_report", args: { run_id: runId, node_id: nodeId,
        command_id: `report-${iteration}-${nodeId}`, outcome: nodeId === "head" ? "succeeded" : again ? "repeat" : "done",
        result_json: JSON.stringify(nodeId === "head" ? { iteration } : { repeat: again, done: !again }), detail: "full" } });
    }
    calls.push({ tool: "recipe_run_get", args: { run_id: runId } });
    const old = f.oracle(calls);
    assert(old.every(value => value.ok), JSON.stringify(old));
    assert.equal(old.at(-1).status, limit ? "failed" : "completed");
    const history = old.at(-1).current_result.control_state.loops[0].history;
    assert.equal(history[0].nodes.head.progress.phase, "working");
    assert.equal(history[1].nodes.head.progress.phase, "claimed");
    try {
      for (const [index, call] of calls.entries()) {
        const actual = await backend.invoke("original_mcp_public", { tool: call.tool, arguments: call.args });
        assert.deepEqual(originalRunShape(actual.structuredContent), originalRunShape(old[index]),
          `public feedback ${limit ? "limit" : "termination"} ${index} ${call.tool}`);
      }
      const db = f.opened.storage.connectNative();
      try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_executor_assignments WHERE run_id=?").get(runId).count, 4); }
      finally { db.close(); }
    } finally { await backend.close(); }
  });
});

test("authenticated reachable source binds child graph, current Knowledge and cold history without admitting unrelated recipes", { timeout: 90000 }, async t => {
  const bindings = [{ nodeId: "work", bindings: [{ bindingId: "source", kind: "skill",
    knowledgeId: "Source", contentHash: skillHash, usage: "required" }] }];
  const f = await recipeExecutionFixture(t, { definition, knowledge, nodeBindings: bindings });
  const parent = structuredClone(definition);
  parent.spec.nodes = [{ nodeId: "sub", kind: "pkm.subflow/v1", config: {
    recipeId: f.recipe.recipeId, revision: f.recipe.revision, executableDigest: f.recipe.executableDigest,
  }, dependsOn: [] }];
  parent.spec.completion.requiredNodes = ["sub"];
  const prepared = await prepareAdhocSource(f, { name: "Pinned parent", command_id: "pinned-child-source",
    definition_json: JSON.stringify(parent) });
  const current = await acquireOriginalMcpNativeRecipeLibraryExecution(f.opened.owner, f.host);
  assert.deepEqual(current.catalog().recipes.map(record => record.recipeId), [prepared.recipe.recipeId, f.recipe.recipeId]);
  assert.equal(prepared.source.reachableRecipes.length, 1);
  assert.equal(prepared.source.reachableRecipes[0].recipeId, f.recipe.recipeId);
  assert.equal(prepared.source.reachableRecipes[0].recordSha256, sha(canonicalJson(current.recordForRecipe(f.recipe.recipeId))));
  assert.equal(current.publicExecutableDigestForRecipe(f.recipe.recipeId), f.recipe.executableDigest);
  const reference = { kind: "recipe", recipeId: f.recipe.recipeId, expectedRevision: f.recipe.revision,
    expectedExecutableDigest: f.recipe.executableDigest, snapshotRevision: prepared.source.planSha256 };
  assert.equal(current.resolveRecipe(reference).executableDigest, f.recipe.executableDigest);
  assert.throws(() => current.resolveRecipe({ ...reference, expectedRevision: f.recipe.revision + 1 }), /revision\/digest changed/);
  assert.throws(() => current.recordForRecipe("recipe_unadmitted_command"), /pinned reachable source closure/);
  assert.deepEqual(current.knowledgeForRecipeNode(f.recipe.recipeId, "work").nodes[0].bindings, bindings[0].bindings);
  const db = f.opened.storage.connectNative();
  try {
    const verified = await verifyOriginalMcpNativeRecipeLibraryReadState(db, assertOriginalMcpPrivacy(f.root));
    const source = verified.find(item => item.source.planSha256 === prepared.source.planSha256);
    assert.deepEqual(source.source, prepared.source);
    assert.deepEqual(source.recipes.map(record => record.recipeId), [prepared.recipe.recipeId, f.recipe.recipeId]);
  } finally { db.close(); }
  assert.equal(f.frames.some(frame => frame.method === "recipe.effect.approve"), false);
  writeFileSync(join(f.root, "skills/Source.md"), knowledge[0].raw + "Changed current child Knowledge.\n");
  assert.throws(() => current.assertCurrent(), /Knowledge|binding|changed/i);
});

test("reachable source signs the explicit public root Project and never reuses a different Project grant", { timeout: 90000 }, async t => {
  const projectId = "project_" + randomUUID();
  const f = await recipeExecutionFixture(t, { definition, project: { projectId, name: "Pinned project" } });
  const base = await captureOriginalMcpRecipeLibraryBase(f.opened.owner, f.host);
  const library = new NativeRecipeLibrary({ database: f.opened.storage.connectNative(), workspaceId: f.host.receipt.workspaceId,
    assertLease() { f.opened.owner.assertWorkspaceLease(); }, original: () => base });
  try {
    const draft = library.draft(f.recipe.recipeId), parent = structuredClone(definition);
    parent.spec.nodes = [{ nodeId: "sub", kind: "pkm.subflow/v1", config: {
      recipeId: f.recipe.recipeId, revision: f.recipe.revision, executableDigest: f.recipe.executableDigest,
    }, dependsOn: [] }];
    parent.spec.completion.requiredNodes = ["sub"];
    const fields = { ...library.editable(draft), category: "", definition: parent };
    const saved = library.save({ actorId: "vscode:operator", operationId: randomUUID(), recipeId: draft.recipeId,
      expectedRevision: 0, expectedSnapshot: library.snapshot().snapshotRevision, fields });
    const prepare = project_id => {
      const args = { recipe_id: saved.recipeId, command_id: "project-source", project_id };
      return withOriginalMcpPublicRequest(f.opened.storage, f.host, {
        operation: "mcp.tool.recipe_run_start", tool: "recipe_run_start", version: 1, readOnly: false,
        arguments: args, argumentsDigest: sha(canonicalJson(args)),
      }, () => prepareOriginalMcpRecipeLibraryRun(f.opened.owner, f.host, { id: "mcp:external", canWrite: true }, args));
    };
    const global = await prepare("");
    assert.equal(global.source.rootProjectId, undefined);
    const admitted = await prepare(projectId);
    assert.equal(admitted.source.rootProjectId, projectId);
    assert.equal(admitted.recordForRecipe(f.recipe.recipeId).scope, "global");
    assert.notEqual(global.source.planSha256, admitted.source.planSha256);
    assert.equal(global.signal.aborted, true);
    assert.equal(f.frames.filter(frame => frame.method === "recipe.source.approve").length, 2);
    const db = f.opened.storage.connectNative();
    try {
      const verified = await verifyOriginalMcpNativeRecipeLibraryReadState(db, assertOriginalMcpPrivacy(f.root));
      assert.deepEqual(verified.find(item => item.source.planSha256 === admitted.source.planSha256).recipes
        .map(record => record.recipeId), [saved.recipeId, f.recipe.recipeId]);
    } finally { db.close(); }
  } finally { library.close(); }
});

test("reachable source rejects missing or mismatched child pins before requesting source consent", { timeout: 90000 }, async t => {
  for (const mismatch of ["missing", "revision", "digest"]) await t.test(mismatch, async t => {
    const f = await recipeExecutionFixture(t, { definition }), parent = structuredClone(definition);
    parent.spec.nodes = [{ nodeId: "sub", kind: "pkm.subflow/v1", config: {
      recipeId: mismatch === "missing" ? "recipe_missing" : f.recipe.recipeId,
      revision: f.recipe.revision + (mismatch === "revision" ? 1 : 0),
      executableDigest: mismatch === "digest" ? "f".repeat(64) : f.recipe.executableDigest,
    }, dependsOn: [] }];
    parent.spec.completion.requiredNodes = ["sub"];
    await assert.rejects(prepareAdhocSource(f, { name: "Unresolved parent", command_id: `unresolved-${mismatch}`,
      definition_json: JSON.stringify(parent) }), /exact current child Recipe revision/);
    assert.equal(f.frames.some(frame => frame.method === "recipe.source.approve"), false);
  });
});

test("reachable native child requires both the exact producer witness and unchanged ordinary save receipt", { timeout: 90000 }, async t => {
  for (const missing of ["neither", "witness", "ordinary"]) await t.test(missing, async t => {
    const f = await recipeExecutionFixture(t, { definition }), base = await captureOriginalMcpRecipeLibraryBase(f.opened.owner, f.host);
    const library = new NativeRecipeLibrary({ database: f.opened.storage.connectNative(), workspaceId: f.host.receipt.workspaceId,
      assertLease() { f.opened.owner.assertWorkspaceLease(); }, original: () => base });
    try {
      const draft = library.draft(f.recipe.recipeId), operationId = randomUUID();
      const child = library.save({ actorId: "vscode:operator", operationId, recipeId: draft.recipeId,
        expectedRevision: 0, expectedSnapshot: library.snapshot().snapshotRevision, fields: library.editable(draft) });
      const db = f.opened.storage.connectNative();
      try {
        if (missing !== "neither") db.prepare("DELETE FROM native_recipe_library_receipts WHERE operation_id=?")
          .run(missing === "witness" ? "native-library-payload:" + operationId : operationId);
      }
      finally { db.close(); }
      const parent = structuredClone(definition);
      parent.spec.nodes = [{ nodeId: "sub", kind: "pkm.subflow/v1", config: {
        recipeId: child.recipeId, revision: child.revision, executableDigest: child.executableDigest,
      }, dependsOn: [] }];
      parent.spec.completion.requiredNodes = ["sub"];
      const preparing = prepareAdhocSource(f, { name: "Witnessed native child", command_id: `witnessed-${missing}`,
        definition_json: JSON.stringify(parent) });
      if (missing !== "neither") {
        await assert.rejects(preparing, /producer witness|payload witness/);
        assert.equal(f.frames.some(frame => frame.method === "recipe.source.approve"), false);
      } else {
        const prepared = await preparing, db = f.opened.storage.connectNative();
        try {
          const verified = await verifyOriginalMcpNativeRecipeLibraryReadState(db, assertOriginalMcpPrivacy(f.root));
          assert.deepEqual(verified.find(item => item.source.planSha256 === prepared.source.planSha256)
            .recipes.map(record => record.recipeId), [prepared.recipe.recipeId, child.recipeId]);
        } finally { db.close(); }
        assert.equal(f.frames.filter(frame => frame.method === "recipe.source.approve").length, 1);
      }
    } finally { library.close(); }
  });
});

test("reachable source rejects a genuinely authored over-depth child chain before source consent", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t, { definition }), base = await captureOriginalMcpRecipeLibraryBase(f.opened.owner, f.host);
  const library = new NativeRecipeLibrary({ database: f.opened.storage.connectNative(), workspaceId: f.host.receipt.workspaceId,
    assertLease() { f.opened.owner.assertWorkspaceLease(); }, original: () => base });
  try {
    let child = f.recipe;
    for (let depth = 0; depth < 16; depth++) {
      const draft = library.draft(f.recipe.recipeId), parent = structuredClone(definition);
      parent.spec.nodes = [{ nodeId: "sub", kind: "pkm.subflow/v1", config: {
        recipeId: child.recipeId, revision: child.revision, executableDigest: child.executableDigest,
      }, dependsOn: [] }];
      parent.spec.completion.requiredNodes = ["sub"];
      child = library.save({ actorId: "vscode:operator", operationId: randomUUID(), recipeId: draft.recipeId,
        expectedRevision: 0, expectedSnapshot: library.snapshot().snapshotRevision,
        fields: { ...library.editable(draft), definition: parent } });
    }
    const parent = structuredClone(definition);
    parent.spec.nodes = [{ nodeId: "sub", kind: "pkm.subflow/v1", config: {
      recipeId: child.recipeId, revision: child.revision, executableDigest: child.executableDigest,
    }, dependsOn: [] }];
    parent.spec.completion.requiredNodes = ["sub"];
    await assert.rejects(prepareAdhocSource(f, { name: "Deep current child chain", command_id: "source-depth-limit",
      definition_json: JSON.stringify(parent) }), /depth exceeds 16/);
    assert.equal(f.frames.some(frame => frame.method === "recipe.source.approve"), false);
  } finally { library.close(); }
});

test("actual cold public parent and child reads retain one authentic source plan without replaying interrupted work", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t, { definition }), parent = structuredClone(definition);
  parent.spec.nodes = [{ nodeId: "sub", kind: "pkm.subflow/v1", config: {
    recipeId: f.recipe.recipeId, revision: f.recipe.revision, executableDigest: f.recipe.executableDigest,
  }, dependsOn: [] }];
  parent.spec.completion.requiredNodes = ["sub"];
  let backend = api(f);
  const args = { name: "Cold pinned parent", command_id: "cold-pinned-parent", definition_json: JSON.stringify(parent) };
  const started = (await backend.invoke("original_mcp_public", { tool: "recipe_run_start_adhoc", arguments: args })).structuredContent;
  assert.equal(started.ok, true, JSON.stringify(started));
  const claimed = (await backend.invoke("original_mcp_public", { tool: "recipe_run_next",
    arguments: { run_id: started.run_id, command_id: "cold-parent-subflow-claim" } })).structuredContent;
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const childId = claimed.next_action.child_run_id;
  assert.equal(typeof childId, "string");
  const childBefore = (await backend.invoke("original_mcp_public", { tool: "recipe_run_get",
    arguments: { run_id: childId } })).structuredContent;
  assert.equal(childBefore.ok, true, JSON.stringify(childBefore));
  let claims;
  let db = f.opened.storage.connectNative();
  try { claims = db.prepare("SELECT count(*) AS count FROM workflow_executor_assignments").get().count; }
  finally { db.close(); }
  await backend.close(); await f.close(); await f.reopen();
  backend = api(f);
  try {
    const restored = (await backend.invoke("original_mcp_public", { tool: "recipe_run_start_adhoc",
      arguments: args })).structuredContent;
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.run_id, started.run_id);
    const reviews = f.frames.filter(frame => frame.method === "recipe.source.approve"
      && frame.payload.request.schema === "pkm.original-native-recipe-library-source/v1"
      && frame.payload.request.purpose === "execute").map(frame => frame.payload.request);
    assert.equal(reviews.length, 2);
    assert.equal(reviews[0].planSha256, reviews[1].planSha256);
    assert.notEqual(reviews[0].nativeHostReceiptSha256, reviews[1].nativeHostReceiptSha256);
    for (const runId of [started.run_id, childId]) {
      const read = (await backend.invoke("original_mcp_public", { tool: "recipe_run_get",
        arguments: { run_id: runId } })).structuredContent;
      assert.equal(read.ok, true, JSON.stringify(read));
      assert.equal(read.run_id, runId);
    }
    await backend.invoke("original_mcp_public", { tool: "recipe_run_next",
      arguments: { run_id: childId, command_id: "cold-child-no-replay" } });
    db = f.opened.storage.connectNative();
    db.exec("BEGIN DEFERRED");
    try {
      assert.equal(db.prepare("SELECT count(*) AS count FROM workflow_executor_assignments").get().count, claims);
      const claimed = db.prepare("SELECT snapshot FROM workflow_executor_runs").all()
        .flatMap(row => JSON.parse(row.snapshot).nodes).filter(step => step.assignmentId);
      assert(claimed.some(step => ["unknown", "cancelled", "failed"].includes(step.state)));
      t.diagnostic(JSON.stringify({ behavior: "cold-parent-child-no-replay", claims,
        claimedStates: claimed.map(step => step.state), parentSourcePlan: reviews[0].planSha256 }));
      const admitted = await verifyOriginalMcpNativeRecipeLibraryReadState(db, assertOriginalMcpPrivacy(f.root));
      t.diagnostic(JSON.stringify({ behavior: "cold-parent-child-source-bindings",
        runs: db.prepare("SELECT actor_id,run_id,binding,version,record FROM legacy_recipe_lazy_runs").all().map(row => {
          const run = JSON.parse(row.record);
          return { actor: row.actor_id, rowId: row.run_id, rowVersion: row.version, id: run.runId,
            version: run.version, recipeId: run.recipeId, revision: run.revision, digest: run.executableDigest,
            binding: row.binding, definitionHash: sha(canonicalJson(run.definition)) };
        }), sources: admitted.map(item => ({ plan: item.source.planSha256, root: item.source.recipeId,
          revision: item.source.revision, compiledDigest: item.source.executableDigest,
          expectedBinding: sha(canonicalJson({ root: assertOriginalMcpPrivacy(f.root).plan.root,
            workspaceId: assertOriginalMcpPrivacy(f.root).workspaceId, source: item.source.planSha256, actorId: "mcp:external" })),
          publicDigest: item.source.publicExecutableDigest, recipes: item.recipes.map(record => ({
            id: record.recipeId, revision: record.revision, digest: record.executableDigest,
            definitionHash: sha(canonicalJson(record.definition)) })) })) }));
      await verifyOriginalMcpHistoricalReadSchema(db, db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all(),
        assertOriginalMcpPrivacy(f.root));
    } finally { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); }
    assert.equal(f.frames.some(frame => frame.method === "recipe.effect.approve"), false);
  } finally { await backend.close(); }
});

test("actual public Original subflow creates a pinned child without automatic work and synchronizes its authoritative result", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t, { definition }), backend = api(f), command = "public-subflow-parent";
  const parentId = "recipe_run_" + sha(command).slice(0, 24), childId = "recipe_run_" + sha(`${parentId}:sub:1`).slice(0, 24);
  const parent = structuredClone(definition);
  parent.spec.nodes = [{ nodeId: "sub", kind: "pkm.subflow/v1", config: {
    recipeId: f.recipe.recipeId, revision: f.recipe.revision, executableDigest: f.recipe.executableDigest,
  }, dependsOn: [] }];
  parent.spec.completion.requiredNodes = ["sub"];
  const calls = [
    { tool: "recipe_run_start_adhoc", args: { name: "Original parent", command_id: command,
      definition_json: JSON.stringify(parent), inputs_json: '{"token":"owned-parent-input"}' } },
    { tool: "recipe_run_next", args: { run_id: parentId, command_id: "claim-parent-subflow" } },
    { tool: "recipe_run_get", args: { run_id: childId } },
    { tool: "recipe_run_next", args: { run_id: childId, command_id: "claim-child-work" } },
    { tool: "recipe_run_report", args: { run_id: childId, node_id: "work", command_id: "report-child-work",
      outcome: "succeeded", result_json: '{"performed":"child-work"}' } },
    { tool: "recipe_run_get", args: { run_id: parentId } },
  ];
  const old = f.oracle(calls);
  assert(old.every(value => value.ok), JSON.stringify(old));
  assert.equal(old[1].next_action.kind, "run_subrecipe");
  assert.equal(old[1].next_action.child_run_id, childId);
  assert.equal(old[2].current_result.counts.running, 0, "Original child creation must not dispatch its work.");
  assert.equal(old[3].next_action.inputs.token, "owned-parent-input");
  assert.equal(old.at(-1).status, "completed");
  t.diagnostic(JSON.stringify({ behavior: "genuine-public-subflow", originalResponses: old }));
  try {
    for (const [index, call] of calls.entries()) {
      const actual = await backend.invoke("original_mcp_public", { tool: call.tool, arguments: call.args });
      assert.deepEqual(originalRunShape(actual.structuredContent), originalRunShape(old[index]),
        `public subflow ${index} ${call.tool}`);
    }
  } finally { await backend.close(); }
});
