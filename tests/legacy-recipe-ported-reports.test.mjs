import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { prepare, capture, open, load } from "./legacy-api-chat-recipes-fixtures.mjs";

const { LegacyRecipeExternalReports } = await import("../dist/legacy-recipe-external-reports.js");
const { WorkflowExecutor } = await import("../dist/workflow-executor.js");
const { compileWorkflowDefinitionV1 } = await import("../dist/domain/project-recipes-workflow-contracts.js");
const require = createRequire(import.meta.url);
const originalExtension = process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION;
const installedOracleSkip = !originalExtension && "Requires an actual original VSIX.";

function node({ ports, control } = {}) {
  return {
    kind: "pkm.step.noop/v1", nodeId: "inspect", dependsOn: [], config: {},
    ...(ports ? { ports } : {}), ...(control ? { control } : {}),
  };
}

function reports(options = {}) {
  return new LegacyRecipeExternalReports({
    id: "ported-report-test", authorizationDigest: "a".repeat(64),
    authorizeDefinition: () => true, ...options,
  });
}

function invocation(workflowNode) {
  return {
    actorId: "fixture-user", runId: "ported-run", node: workflowNode, iteration: 0,
    invocationId: "invocation", executableDigest: "b".repeat(64),
    adapter: { id: "ported-report-test", version: 1, outputContractDigest: "c".repeat(64),
      authorizationDigest: "a".repeat(64), key: "pkm.step.noop/v1" },
    inputs: {}, previousOutputs: {}, inputDigest: "d".repeat(64), deadline: Date.now() + 30_000,
    lease: { proof: "fixture" },
  };
}

test("ported NoOp reports are opt-in and require exact output-port shape without consuming rejected reports", async () => {
  const workflowNode = node({ ports: { inputs: [], outputs: ["evidence"] } });
  const disabled = reports();
  assert.equal(disabled.supportsNode(workflowNode), false);
  assert.equal(disabled.adapter.outputContractDigest === reports({ portedNoops: true }).adapter.outputContractDigest, false);

  const enabled = reports({ portedNoops: true });
  assert.equal(enabled.supportsNode(workflowNode), true);
  const controller = new AbortController();
  const execution = enabled.adapter.execute(invocation(workflowNode), { signal: controller.signal });
  assert.throws(() => enabled.validate("ported-run", "inspect", "succeeded", {}, ""),
    /exactly its declared output ports/);
  assert.throws(() => enabled.validate("ported-run", "inspect", "succeeded", { evidence: true, extra: 1 }, ""),
    /exactly its declared output ports/);
  const raw = { evidence: { finding: "synthetic" } };
  enabled.submit("ported-run", "inspect", "succeeded", raw, "");
  assert.deepEqual(await execution, { status: "succeeded", outputs: raw });
});

test("ported static branch outcomes preserve the case and report failures without fabricating outputs", async () => {
  const workflowNode = node({
    ports: { inputs: [], outputs: ["selected", "valid", "invalid"] },
    control: { mode: "branch", cases: ["valid", "invalid"], defaultCase: "invalid" },
  });
  assert.equal(reports({ portedNoops: true }).supportsNode(workflowNode), false);
  const enabled = reports({ portedNoops: true, staticBranches: true });
  assert.equal(enabled.supportsNode(workflowNode), true);

  const controller = new AbortController();
  const selected = enabled.adapter.execute(invocation(workflowNode), { signal: controller.signal });
  enabled.submit("ported-run", "inspect", "valid", { selected: "valid", valid: true, invalid: false }, "");
  assert.deepEqual(await selected, { status: "succeeded", branch: "valid",
    outputs: { selected: "valid", valid: true, invalid: false } });

  const failed = enabled.adapter.execute(invocation(workflowNode), { signal: controller.signal });
  enabled.submit("ported-run", "inspect", "failed", { malformed: "raw legacy result" }, "original error");
  assert.deepEqual(await failed, { status: "failed", outputs: {} });
});

test("cancelling an in-flight ported report drops its lease and rejects a late result", async () => {
  const enabled = reports({ portedNoops: true });
  const workflowNode = node({ ports: { inputs: [], outputs: ["evidence"] } });
  const controller = new AbortController();
  const execution = enabled.adapter.execute(invocation(workflowNode), { signal: controller.signal });
  controller.abort();
  assert.equal(await execution, undefined);
  assert.throws(() => enabled.submit("ported-run", "inspect", "succeeded", { evidence: "late" }, ""),
    /currently claimed running node/);
});

test("portless NoOp output and static-branch permissions keep their independent legacy gates", async () => {
  const portless = node({ control: { mode: "branch", cases: ["valid", "invalid"], defaultCase: "invalid" } });
  assert.equal(reports({ portedNoops: true }).supportsNode(portless), false);
  assert.equal(reports({ staticBranches: true }).supportsNode(portless), true);
  assert.equal(reports({ staticBranches: true, portedNoops: true }).supportsNode(portless), true);

  const adapter = reports({ staticBranches: true, portedNoops: true });
  const controller = new AbortController();
  const execution = adapter.adapter.execute(invocation(portless), { signal: controller.signal });
  adapter.submit("ported-run", "inspect", "valid", null, "");
  assert.deepEqual(await execution, { status: "succeeded", branch: "valid", outputs: { result: null, reportedError: "" } });
});

test("ported branch outputs map into the selected node, skip the other path, and converge at the declared join", async t => {
  const definition = {
    schema: "pkm.workflow.definition/v1",
    spec: {
      inputs: { seed: { type: "string", required: true, nullable: false, schema: {} } },
      nodes: [
        { nodeId: "inspect", kind: "pkm.step.noop/v1", config: {}, dependsOn: [],
          ports: {
            inputs: ["seed"],
            outputs: ["token", "valid", "invalid"],
          },
          control: { mode: "branch", kind: "switch", cases: ["valid", "invalid"] } },
        { nodeId: "valid", kind: "pkm.step.noop/v1", config: {},
          dependsOn: [{ from: "inspect", fromOutput: "token", toInput: "incoming", accept: ["valid"], required: true }],
          ports: {
            inputs: ["incoming"],
            outputs: ["checked"],
          } },
        { nodeId: "invalid", kind: "pkm.step.noop/v1", config: {},
          dependsOn: [{ from: "inspect", fromOutput: "token", toInput: "incoming", accept: ["invalid"], required: true }],
          ports: {
            inputs: ["incoming"],
            outputs: ["repaired"],
          } },
        { nodeId: "join", kind: "pkm.step.noop/v1", config: {},
          dependsOn: [
            { from: "inspect", accept: ["valid", "invalid"], required: true },
            { from: "valid", accept: ["succeeded", "skipped"], required: true },
            { from: "invalid", accept: ["succeeded", "skipped"], required: true },
          ] },
      ],
      outputs: {}, completion: { requiredNodes: ["join"] },
    },
  };
  const compiled = compileWorkflowDefinitionV1(definition);
  assert.equal(compiled.ok, true, JSON.stringify(compiled));

  const root = resolve(`.ported-recipe-reports-${randomUUID()}`);
  await mkdir(root);
  const database = new DatabaseSync(resolve(root, "workflow.sqlite"));
  const received = [], external = reports({ portedNoops: true, staticBranches: true });
  const execute = external.adapter.execute;
  external.adapter.execute = (invocationValue, context) => {
    received.push({ nodeId: invocationValue.node.nodeId, inputs: invocationValue.inputs });
    return execute(invocationValue, context);
  };
  const executor = new WorkflowExecutor(database, {
    workspaceRoot: root, ownerId: "ported-test-host", adapters: { "pkm.step.noop/v1": external.adapter },
    resolveRecipe: source => ({ status: "valid", executableDigest: compiled.executableDigest, definition, source }),
  });
  t.after(() => { executor.close(); database.close(); return rm(root, { recursive: true, force: true }); });
  const runId = "ported-branch-join";
  executor.create("fixture-user", {
    operationId: randomUUID(), runId, source: { kind: "recipe", recipeId: "fixture-recipe", expectedRevision: 1,
      expectedExecutableDigest: compiled.executableDigest },
    expectedExecutableDigest: compiled.executableDigest, deadline: Date.now() + 60_000, inputs: { seed: "root-seed" },
  });

  async function reportNext(expectedNode, outcome, rawResult) {
    const work = executor.tick("fixture-user", runId);
    let preview;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { preview = external.preview(runId, expectedNode); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 2)); }
    }
    assert(preview, `Expected ${expectedNode} to be claimed.`);
    const nodeId = expectedNode;
    external.submit(runId, nodeId, outcome, rawResult, "");
    return work;
  }

  await reportNext("inspect", "valid", { token: "mapped-token", valid: true, invalid: false });
  await reportNext("valid", "succeeded", { checked: "mapped-token" });
  const finalWork = executor.tick("fixture-user", runId);
  let joinPreview;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { joinPreview = external.preview(runId, "join"); } catch {}
    if (joinPreview) break;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert(joinPreview, "Expected the converged join to be claimed.");
  external.submit(runId, "join", "succeeded", {}, "");
  const final = await finalWork;
  assert.equal(final.state, "succeeded");
  assert.equal(final.nodes.find(item => item.nodeId === "inspect").branch, "valid");
  assert.equal(final.nodes.find(item => item.nodeId === "valid").outputs.checked, "mapped-token");
  assert.equal(final.nodes.find(item => item.nodeId === "invalid").state, "skipped");
  assert.deepEqual(received.find(item => item.nodeId === "valid"), {
    nodeId: "valid", inputs: { seed: "root-seed", incoming: "mapped-token" },
  });
});

test("legacy lazy adapter receives the original global inputs instead of Next port mappings", async t => {
  const definition = {
    schema: "pkm.workflow.definition/v1",
    spec: {
      inputs: { seed: { type: "string", required: true, nullable: false, schema: {} } },
      nodes: [
        { nodeId: "inspect", kind: "pkm.step.noop/v1", config: {}, dependsOn: [],
          ports: { inputs: ["seed"], outputs: ["token"] } },
        { nodeId: "consume", kind: "pkm.step.noop/v1", config: {},
          dependsOn: [{ from: "inspect", fromOutput: "token", toInput: "incoming", accept: ["succeeded"], required: true }],
          ports: { inputs: ["incoming"], outputs: ["checked"] } },
      ],
      outputs: {}, completion: { requiredNodes: ["consume"] },
    },
  };
  const compiled = compileWorkflowDefinitionV1(definition);
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  const recipe = { recipeId: "legacy-input-fixture", revision: 1, executableDigest: compiled.executableDigest,
    definition: compiled.model, nodeBindings: [] };
  const root = resolve(`.legacy-global-input-${randomUUID()}`);
  await mkdir(root);
  const database = new DatabaseSync(resolve(root, "workflow.sqlite"));
  const { LegacyRecipeLazyRuntime } = await import("../dist/legacy-recipe-lazy-runtime.js");
  const { canonicalJson } = await import("../dist/domain/project-recipes-workflow-contracts.js");
  const seenInputs = [];
  const external = reports({
    portedNoops: true, id: "legacy-global-input-reporter",
    authorizeDefinition: binding => binding.source?.recipeId === recipe.recipeId
      && canonicalJson(binding.node) === canonicalJson(recipe.definition.spec.nodes.find(node => node.nodeId === binding.node.nodeId)),
    authorizeData: binding => { seenInputs.push(structuredClone(binding.inputs)); return true; },
  });
  const execute = external.adapter.execute;
  external.adapter.execute = (invocationValue, context) => {
    seenInputs.push(structuredClone(invocationValue.inputs));
    return execute(invocationValue, context);
  };
  const catalog = { recipes: [recipe], snapshotRevision: "e".repeat(64) };
  const actor = { id: "fixture-user", canWrite: true };
  const lazy = new LegacyRecipeLazyRuntime(database, {
    actorId: actor.id, root, bindingFingerprint: "f".repeat(64), ownerId: "legacy-input-test-host",
    adapters: {}, externalReports: external, catalog: async () => catalog,
    resolveRecipe: source => ({ status: "valid", executableDigest: recipe.executableDigest,
      definition: recipe.definition, source }),
    assertOwner: () => {}, requestCancel: () => {},
  });
  t.after(() => { lazy.close(); database.close(); return rm(root, { recursive: true, force: true }); });
  const started = await lazy.dispatch("mcp.tool.recipe_run_start", {
    recipe_id: recipe.recipeId, command_id: "legacy-global-input-start",
    inputs_json: '{"seed":"root-seed"}',
  }, actor);
  assert.equal(started.ok, true, JSON.stringify(started));
  const claimed = await lazy.dispatch("mcp.tool.recipe_run_next", {
    run_id: started.run_id, command_id: "legacy-global-input-first",
  }, actor);
  assert.deepEqual(claimed.next_action.inputs, { seed: "root-seed" });
  assert(seenInputs.some(inputs => canonicalJson(inputs) === canonicalJson({ seed: "root-seed" })));
  const completed = await lazy.dispatch("mcp.tool.recipe_run_report", {
    run_id: started.run_id, node_id: "inspect", command_id: "legacy-global-input-report",
    outcome: "succeeded", result_json: '{"rawLegacyResult":"not-a-declared-output-port"}',
  }, actor);
  assert.equal(completed.ok, true, JSON.stringify(completed));
  const inspected = await lazy.dispatch("mcp.tool.recipe_run_get", { run_id: started.run_id }, actor);
  assert.deepEqual(inspected.current_result.completed_nodes[0].result,
    { rawLegacyResult: "not-a-declared-output-port" });
  assert.deepEqual(completed.next_action.inputs, { seed: "root-seed" });
  assert(seenInputs.every(inputs => canonicalJson(inputs) === canonicalJson({ seed: "root-seed" })));
});

test("actual original Recipe ports keep raw reports, legacy inputs, branch selection, and join through the explicitly ported host opt-in",
  { skip: installedOracleSkip, timeout: 90000 }, async t => {
    const prepared = prepare(), helper = require("../legacy/tests/next-trial-electron/legacy-ported-branch-fixture.cjs");
    let env, expectedSave, before;
    t.after(async () => {
      try { await env?.close(); if (before) assert.deepEqual(capture(prepared.originalRoot), before); }
      finally { await rm(prepared.base, { recursive: true, force: true }); }
    });
    const evidence = helper.create({ extension: originalExtension, fixture: prepared.fixture, root: prepared.originalRoot });
    const command = require("../legacy/tests/next-trial-electron/controlled-lazy-recipe-fixture.cjs").create({
      extension: originalExtension, fixture: prepared.fixture, root: prepared.originalRoot,
    });
    prepared.additionalRecipes = [evidence.recipe, command.recipe];
    const oracle = spawnSync("python3", ["-B", resolve(import.meta.dirname, "../legacy/tests/next-trial-electron/legacy-ported-branch-oracle.py"),
      originalExtension, prepared.fixture], { encoding: "utf8", timeout: 30000 });
    assert.equal(oracle.status, 0, oracle.stderr + oracle.stdout);
    const old = JSON.parse(oracle.stdout);
    before = capture(prepared.originalRoot);
    const { canonicalJson } = await load("domain/project-recipes-workflow-contracts");
    env = await open(prepared, { library: true, publicApi: { authorizeMutation(request) {
      if (!expectedSave || request.operation !== "recipe.library.save" || request.actor.id !== prepared.actorId
        || canonicalJson(request.args) !== canonicalJson(expectedSave)) return false;
      expectedSave = undefined;
      return true;
    } } });
    const actor = { id: prepared.actorId, canWrite: true, recipeProtocol: true };
    const draft = await env.authority.editor(env.binding, { namespace: env.binding.namespace,
      chatId: env.binding.chatId, recipeId: evidence.recipe.recipeId, copy: true });
    const fields = Object.fromEntries(["name", "category", "description", "definition", "metadata", "editorLayout",
      "nodeBindings", "methodology"].filter(key => key in evidence.recipe).map(key => [key, evidence.recipe[key]]));
    fields.nodeBindings = [];
    const saveArgs = { namespace: env.binding.namespace, chatId: env.binding.chatId, operationId: randomUUID(),
      expectedDigest: draft.digest, recipeId: draft.recipe.recipeId, expectedRevision: 0, fields };
    const token = randomUUID(), http = await (await load("http")).startHttp(env.runtime.core, token, actor, 0);
    let native;
    try {
      const save = () => fetch(`${http.url}/v1/capability_call`, { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ operation: "recipe.library.save", version: 1, arguments: saveArgs }) });
      assert.equal((await save()).status, 403);
      expectedSave = saveArgs;
      const saved = await (await save()).json();
      assert(!saved.error, JSON.stringify(saved));
      native = (await env.authority.catalog(env.binding)).recipes.find(row => row.recipeId === draft.recipe.recipeId);
      assert(native);
    } finally { http.server.closeAllConnections(); await new Promise(resolve => http.server.close(resolve)); }
    await env.close();
    const reports = ({ binding }) => ({
      id: "fixture-explicit-ported-recipe-reporter", staticBranches: true, portedNoops: true,
      authorizationDigest: createHash("sha256").update(canonicalJson({ binding, recipeId: native.recipeId,
        executableDigest: native.executableDigest, authority: "external-caller-reported-ported-noop" })).digest("hex"),
      authorizeDefinition: candidate => candidate.actorId === binding.actorId
        && candidate.source?.kind === "recipe" && candidate.source.recipeId === native.recipeId
        && candidate.executableDigest === native.executableDigest
        && canonicalJson(candidate.node) === canonicalJson(native.definition.spec.nodes.find(node => node.nodeId === candidate.node.nodeId)),
      authorizeData: candidate => candidate.inputs.seed === old.inputs.seed,
    });
    env = await open(prepared, { library: true, publicApi: true, lazy: true, externalReports: reports });
    async function invoke(name, args) {
      const operation = `mcp.tool.recipe_run_${name}`;
      const translated = { ...args, ...(args.recipe_id ? { recipe_id: native.recipeId } : {}) };
      const preview = await env.publicRecipes.previewLazy(env.binding, { operation, args: translated });
      await env.publicRecipes.approveLazy(env.binding, { operation, args: translated, previewDigest: preview.previewDigest });
      const result = await env.runtime.core.dispatch("capability_call", {
        operation, version: 1, arguments: translated,
      }, actor);
      assert(!result.error, JSON.stringify(result));
      return result.result;
    }
    const started = await invoke("start", old.start_args);
    assert.equal(started.run_id, old.start.run_id);
    const initial = await invoke("next", { ...old.next_args, run_id: started.run_id });
    assert.equal(initial.next_action.node_id, "inspect");
    assert.deepEqual(initial.next_action.inputs, old.inputs);
    for (const [index, report] of old.reports.entries()) {
      assert.deepEqual(old.legacy_inputs[index], { node_id: report.args.node_id, inputs: old.inputs });
      const response = await invoke("report", { ...report.args, run_id: started.run_id });
      const completed = response.current_result.completed_nodes.find(node => node.node_id === report.args.node_id);
      assert.equal(completed.outcome, report.args.outcome);
      assert.deepEqual(completed.result, JSON.parse(report.args.result_json));
    }
    const final = await invoke("get", { run_id: started.run_id });
    assert.equal(final.status, "completed");
    assert.equal(final.current_result.completed_nodes.find(node => node.node_id === "inspect").outcome, "valid");
    assert.equal(final.current_result.completed_nodes.find(node => node.node_id === "record-invalid").outcome, "skipped");
    assert.equal(env.lazyTrusted.executions.length, 0);

    const failedStart = await invoke("start", old.failure.start_args);
    const failedClaim = await invoke("next", { ...old.failure.next_args, run_id: failedStart.run_id });
    assert.equal(failedClaim.next_action.node_id, "inspect");
    const failed = await invoke("report", { ...old.failure.report_args, run_id: failedStart.run_id });
    const failedNode = failed.current_result.completed_nodes.find(node => node.node_id === "inspect");
    assert.equal(failedNode.outcome, "failed");
    assert.deepEqual(failedNode.result, { raw: "caller-evidence" });
    assert.equal(failedNode.error, "Caller inspection failed.");
    assert.equal((await invoke("get", { run_id: failedStart.run_id })).status, "failed");

    const interruptedStart = await invoke("start", { ...old.start_args, command_id: "ported-branch-interrupted" });
    const interruptedClaim = await invoke("next", { run_id: interruptedStart.run_id, command_id: "claim-before-ported-restart" });
    assert.equal(interruptedClaim.next_action.node_id, "inspect");
    await env.close();
    env = await open(prepared, { library: true, publicApi: true, lazy: true, externalReports: reports });
    const unknown = await invoke("get", { run_id: interruptedStart.run_id });
    assert.equal(unknown.next_action.state, "launch-outcome-unknown");
    assert.equal(unknown.next_action.replay_allowed, false);
    assert.equal(unknown.current_result.counts.pending, 3);
    const late = await env.lazy.dispatch("mcp.tool.recipe_run_report", {
      run_id: interruptedStart.run_id, node_id: "inspect", command_id: "late-ported-report",
      outcome: "invalid", result_json: '{"token":"late","valid":false,"invalid":true}', detail: "full",
    }, actor);
    assert.equal(late.ok, false);
    const noReplay = await invoke("next", { run_id: interruptedStart.run_id, command_id: "no-ported-replay" });
    assert.equal(noReplay.next_action.replay_allowed, false);
    assert.equal(noReplay.current_result.counts.pending, 3);
    assert.equal(noReplay.current_result.completed_nodes?.some(node =>
      ["record-valid", "record-invalid", "join"].includes(node.node_id)) ?? false, false);
  });
