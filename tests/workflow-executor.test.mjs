import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { WorkflowExecutor, mutateWorkflowExecutor } from "../dist/workflow-executor.js";
import { compileWorkflowDefinitionV1 } from "../dist/domain/project-recipes-workflow-contracts.js";
import { workflowRuntimeBindingsFromOriginalInputs, ORIGINAL_RECIPE_METADATA_SEMANTICS } from "../dist/domain/workflow-executor-bindings.js";
import { workflowExecutorDefinitions } from "../dist/workflow-executor-contracts.js";
import {
  workflowExecutorAdapterKey as key, workflowExecutorSyntheticAdapter as adapter,
  workflowExecutorNode as node, workflowExecutorFixture as fixture, workflowExecutorDAGFixture as dag,
} from "./workflow-executor-fixtures.mjs";

async function setup(t, execute, leaseMs = 100, overrides = {}) {
  const root = resolve(`.workflow-executor-${randomUUID()}`);
  await mkdir(root);
  const file = resolve(root, "core.sqlite"), db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000");
  let now = 1000;
  const options = { workspaceRoot: root, ownerId: "host-one", adapters: { [key]: adapter(execute) }, clock: () => now, leaseMs, ...overrides };
  const host = new WorkflowExecutor(db, options), hosts = [host], databases = [db];
  t.after(async () => {
    for (const host of hosts) { try { host.close(); } catch {} }
    for (const db of databases) { try { db.close(); } catch {} }
    await rm(root, { recursive: true, force: true });
  });
  return {
    host, db, root, file, options, now: value => { now = value; },
    other(overrides = {}) {
      const database = new DatabaseSync(file); database.exec("PRAGMA busy_timeout=1000");
      const other = new WorkflowExecutor(database, { ...options, ownerId: "host-two", ...overrides });
      hosts.push(other); databases.push(database); return other;
    },
  };
}
function args(value = dag, runId = "test-run", extra = {}) {
  return { operationId: randomUUID(), runId, source: { kind: "inline", definition: value.definition },
    expectedExecutableDigest: value.executableDigest, deadline: 10_000, inputs: {}, ...extra };
}
async function drain(host, runId = "test-run") {
  for (let index = 0; index < 70; index++) {
    const result = await host.tick("actor", runId);
    if (!["ready", "running"].includes(result.state)) return result;
  }
  throw new Error("Synthetic run did not terminate within budget.");
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function subflowFixture(t, budget = { maxSteps: 1000, maxDepth: 16, maxRuns: 32 }, nested = false) {
  const grand = fixture([node("grand")]);
  const child = fixture(nested ? [{ nodeId: "nested", kind: "pkm.subflow/v1", config: {
    recipeId: "recipe_grand", revision: 1, executableDigest: grand.executableDigest,
  }, dependsOn: [] }] : [node("leaf"), node("second")], nested ? ["nested"] : ["leaf", "second"]);
  child.definition.spec.inputs = {
    token: { type: "string", required: true, nullable: false, schema: {} },
    childDefault: { type: "string", required: false, nullable: false, schema: {}, default: "not forwarded" },
  };
  child.executableDigest = compileWorkflowDefinitionV1(child.definition).executableDigest;
  const parent = fixture([{ nodeId: "sub", kind: "pkm.subflow/v1", config: {
    recipeId: "recipe_child", revision: 1, executableDigest: child.executableDigest,
  }, dependsOn: [] }]);
  const catalog = { recipe_child: child, recipe_grand: grand };
  const calls = [], invocations = new Map(), starts = new Map(), finishes = new Map();
  let current = true;
  const subAdapter = { ...adapter(), id: "trusted-subflow-fixture",
    authorizeDefinition: binding => binding.actorId === "actor" && binding.node.kind === "pkm.subflow/v1"
      && binding.executionSemantics === ORIGINAL_RECIPE_METADATA_SEMANTICS,
    execute: async (invocation, { signal }) => {
      invocations.set(invocation.runId, invocation);
      const finish = deferred(); finishes.set(invocation.runId, finish);
      signal.addEventListener("abort", () => finish.resolve({ status: "unknown", outputs: {} }), { once: true });
      starts.get(invocation.runId)?.resolve(invocation);
      return finish.promise;
    },
  };
  const env = await setup(t, undefined, 1000, {
    adapters: {
      "pkm.subflow/v1": subAdapter,
      [key]: { ...adapter(), authorizeDefinition: binding => binding.actorId === "actor"
        && binding.source.kind === "recipe" && Object.hasOwn(catalog, binding.source.recipeId),
      execute: async invocation => { calls.push(invocation); return { status: "succeeded", outputs: { value: 1 } }; } },
    },
    resolveRecipe: ref => {
      const value = catalog[ref.recipeId];
      if (!current || !value || (ref.expectedRevision ?? ref.revision) !== 1
        || (ref.expectedExecutableDigest ?? ref.executableDigest) !== value.executableDigest)
        return { status: "invalid", executableDigest: "", definition: child.definition, source: ref };
      return { status: "valid", executableDigest: value.executableDigest, definition: value.definition,
        source: { kind: "recipe", recipeId: ref.recipeId, revision: 1, executableDigest: value.executableDigest } };
    },
  });
  function waitInvocation(runId) {
    if (invocations.has(runId)) return Promise.resolve(invocations.get(runId));
    const start = deferred(); starts.set(runId, start); return start.promise;
  }
  const entered = waitInvocation("parent");
  env.db.exec("BEGIN IMMEDIATE");
  env.host.createInTransaction("actor", args(parent, "parent", { inputs: { token: "normalized", extra: "opaque" } }), {
    dispatchMode: "explicit", originalRecipeMetadata: true, treeBudget: budget,
  });
  env.db.exec("COMMIT");
  const work = env.host.tick("actor", "parent"); work.catch(() => {});
  const invocation = await entered;
  function childRequest(parentInvocation = invocation) {
    const config = parentInvocation.node.config, value = catalog[config.recipeId];
    const runId = `recipe_run_${createHash("sha256").update(`${parentInvocation.runId}:${parentInvocation.node.nodeId}:${parentInvocation.iteration + 1}`).digest("hex").slice(0, 24)}`;
    return { request: args(value, runId, { source: { kind: "recipe", recipeId: config.recipeId,
      expectedRevision: 1, expectedExecutableDigest: value.executableDigest },
    inputs: { token: "normalized", extra: "opaque" } }),
    ref: { recipeId: config.recipeId, revision: 1, executableDigest: value.executableDigest,
      compiledExecutableDigest: value.executableDigest } };
  }
  function createChild(request = childRequest().request, ref = childRequest().ref, parentInvocation = invocation, actorId = "actor", host = env.host) {
    env.db.exec("BEGIN IMMEDIATE");
    try {
      const result = host.createHostOwnedSubflowChildInTransaction(actorId, parentInvocation.runId, parentInvocation.invocationId, request, ref);
      env.db.exec("COMMIT"); return result;
    } catch (error) { env.db.exec("ROLLBACK"); throw error; }
  }
  return { ...env, calls, invocation, work, childRequest, createChild, waitInvocation,
    revoke: () => { current = false; },
    restore: () => { current = true; },
    finish: (runId, status = "succeeded") => finishes.get(runId).resolve({ status, outputs: { value: 1 } }) };
}

test("trusted subflow intent pins one deterministic child, forwards exact globals and awaits explicit child claims", async t => {
  const env = await subflowFixture(t), { request, ref } = env.childRequest();
  const child = env.createChild(request, ref);
  assert.equal(child.state, "ready"); assert.equal(child.steps, 0); assert.equal(env.calls.length, 0);
  assert.equal(env.createChild(request, ref).runId, child.runId);
  env.revoke(); assert.throws(() => env.createChild(request, ref), /Pinned workflow source changed/); env.restore();
  assert.equal(env.host.hostOwnedSubflowChildren("actor", "parent").length, 1);
  assert.equal(env.host.list("actor").length, 2);
  assert.equal((await env.other().tick("actor", child.runId)).state, "ready");
  assert.equal(env.calls.length, 0);
  assert.equal((await drain(env.host, child.runId)).state, "succeeded");
  assert.equal(env.createChild(request, ref).state, "succeeded");
  assert.deepEqual(env.calls.map(call => call.inputs), [
    { token: "normalized", extra: "opaque" }, { token: "normalized", extra: "opaque" },
  ]);
  env.finish("parent"); assert.equal((await env.work).state, "succeeded");
  assert.equal(env.host.knownInvocationResult("actor", "parent", env.invocation.invocationId).status, "succeeded");
});

test("subflow admission fences changed actor, pins, identity, global inputs, deadline and source before creating children", async t => {
  const env = await subflowFixture(t), { request, ref } = env.childRequest();
  assert.throws(() => env.createChild(request, ref, env.invocation, "other-actor"), /not found/i);
  assert.throws(() => env.createChild(request, { ...ref, executableDigest: "f".repeat(64) }), /authored pins/);
  assert.throws(() => env.createChild({ ...request, runId: "different-child" }, ref), /deterministic/);
  assert.throws(() => env.createChild({ ...request, inputs: { token: "changed" } }, ref), /exact parent global inputs/);
  assert.throws(() => env.createChild({ ...request, deadline: 10_001 }, ref), /deadline changed/);
  env.revoke(); assert.throws(() => env.createChild(request, ref), /compiler rejected/);
  assert.equal(env.host.list("actor").length, 1); assert.equal(env.calls.length, 0);
  assert.deepEqual(env.host.hostOwnedSubflowChildren("actor", "parent"), []);
  env.host.cancel("actor", { operationId: randomUUID(), runId: "parent",
    expectedVersion: env.host.get("actor", "parent").version }); await env.work;
  assert.equal(env.host.knownInvocationResult("actor", "parent", env.invocation.invocationId), undefined);
});

test("subflow descendants share the root claim budget rather than resetting a child allowance", async t => {
  const env = await subflowFixture(t, { maxSteps: 2, maxDepth: 16, maxRuns: 32 }), child = env.createChild();
  assert.equal((await env.host.tick("actor", child.runId)).steps, 1);
  assert.equal((await env.host.tick("actor", "parent")).state, "running");
  assert.equal((await env.host.tick("actor", child.runId)).state, "failed");
  assert.equal(env.calls.length, 1);
  env.finish("parent", "failed"); assert.equal((await env.work).state, "failed");
  assert.equal(env.host.get("actor", "parent").steps + env.host.get("actor", child.runId).steps, 2);
});

test("subflow depth denial and parent interruption fence pending descendants and late results without replay", async t => {
  const env = await subflowFixture(t, { maxSteps: 1000, maxDepth: 1, maxRuns: 32 }, true), child = env.createChild();
  const entered = env.waitInvocation(child.runId), childWork = env.host.tick("actor", child.runId);
  childWork.catch(() => {});
  const invocation = await entered, { request, ref } = env.childRequest(invocation);
  assert.throws(() => env.createChild(request, ref, invocation), /depth or run capacity/);
  assert.equal(env.host.list("actor").length, 2);
  assert.equal(env.host.interruptHostOwnedRun("actor", "parent").state, "unknown");
  assert.equal(env.host.get("actor", child.runId).state, "unknown");
  await Promise.all([env.work, childWork]);
  assert.equal((await env.host.tick("actor", child.runId)).state, "unknown");
  assert.equal(env.calls.length, 0);
  assert.equal(env.host.knownInvocationResult("actor", child.runId, invocation.invocationId), undefined);
  const pending = await subflowFixture(t), pendingChild = pending.createChild();
  pending.host.cancel("actor", { operationId: randomUUID(), runId: "parent",
    expectedVersion: pending.host.get("actor", "parent").version });
  await pending.work;
  assert.equal((await pending.host.tick("actor", pendingChild.runId)).state, "cancelled");
  assert.equal(pending.calls.length, 0);
});

test("Original node observations preserve host metadata but cannot assert completion without the exact known invocation", async t => {
  const started = deferred(), release = deferred(), value = fixture([node("one")]);
  const env = await setup(t, async invocation => { started.resolve(invocation); return release.promise; }, 1000);
  env.db.exec("BEGIN IMMEDIATE");
  env.host.createInTransaction("actor", args(value), { dispatchMode: "explicit", originalRecipeMetadata: true });
  env.db.exec("COMMIT");
  const work = env.host.tick("actor", "test-run"), invocation = await started.promise;
  const observation = { schema: "pkm.original-recipe-node-observation/v1", actorId: "actor", runId: "test-run",
    invocationId: invocation.invocationId, nodeId: "one", iteration: invocation.iteration,
    progress: { phase: "claimed", message: "Observed host progress", events: [{ message: "Observed event" }] },
    startedAt: new Date(1000).toISOString(), completedAt: null,
    lastHeartbeatAt: new Date(1000).toISOString(), lastProgressAt: new Date(1000).toISOString() };
  const write = record => env.host.recordHostControlInTransaction("actor", "test-run", "legacy-recipe-node-observation", record);
  env.db.exec("BEGIN IMMEDIATE");
  assert.throws(() => write({ ...observation, actorId: "other" }), /Original actor\/run/);
  assert.throws(() => write({ ...observation, invocationId: randomUUID() }), /exact running reporter/);
  assert.throws(() => write({ ...observation, iteration: observation.iteration + 1 }), /node attempt/);
  assert.throws(() => write({ ...observation, progress: { message: "x".repeat(4096) } }), /byte limit/);
  write(observation); env.db.exec("COMMIT");
  assert.equal(env.host.hostOwnedOriginalNodeObservation("actor", "test-run", "one", invocation.iteration), undefined);
  assert.equal(env.host.knownInvocationResult("actor", "test-run", invocation.invocationId), undefined);
  env.now(1500); release.resolve({ status: "succeeded", outputs: { value: 1 } }); await work;
  assert.deepEqual(env.host.hostOwnedOriginalNodeObservation("actor", "test-run", "one", invocation.iteration),
    { ...observation, completedAt: new Date(1500).toISOString() });
  assert.equal(env.host.knownInvocationResult("actor", "test-run", invocation.invocationId).completedAt, 1500);
  env.db.exec("BEGIN IMMEDIATE"); assert.throws(() => write(observation), /active Original actor\/run/); env.db.exec("ROLLBACK");
  const lostStarted = deferred(), lostRelease = deferred();
  const lost = await setup(t, async current => { lostStarted.resolve(current); return lostRelease.promise; }, 1000);
  lost.db.exec("BEGIN IMMEDIATE");
  lost.host.createInTransaction("actor", args(value), { dispatchMode: "explicit", originalRecipeMetadata: true });
  lost.db.exec("COMMIT");
  const lostWork = lost.host.tick("actor", "test-run"), lostInvocation = await lostStarted.promise;
  lost.db.exec("BEGIN IMMEDIATE");
  lost.host.recordHostControlInTransaction("actor", "test-run", "legacy-recipe-node-observation",
    { ...observation, invocationId: lostInvocation.invocationId });
  lost.db.exec("COMMIT");
  lost.now(2001); lostRelease.resolve({ status: "succeeded", outputs: { value: 1 } });
  assert.equal((await lostWork).state, "unknown");
  assert.equal(lost.host.hostOwnedOriginalNodeObservation("actor", "test-run", "one", lostInvocation.iteration), undefined);
  assert.equal(lost.host.knownInvocationResult("actor", "test-run", lostInvocation.invocationId), undefined);
});

test("fresh source-first binding import initializes the shared schemas without a contracts cycle", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { workflowRuntimeBindings } = await import("./dist/domain/workflow-executor-bindings.js");
    const { workflowExecutorCreate } = await import("./dist/workflow-executor-contracts.js");
    const bindings = workflowRuntimeBindings.parse({ nodes: {}, outputs: {} });
    if (!workflowExecutorCreate.shape.runtimeBindings.safeParse(bindings).success) throw new Error("Binding schema unavailable.");
    console.log(JSON.stringify(bindings));
  `], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { nodes: {}, outputs: {} });
});

test("genuine Original registered Recipe tools treat cron/repeat/output fields as metadata and dynamic cases as declared reported outcomes", {
  skip: !process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION && "Requires genuine Original 4.0.22.",
}, async t => {
  const root = resolve(`.workflow-original-controls-${randomUUID()}`);
  await mkdir(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = { type: "int64", required: true, nullable: false, schema: {} };
  const base = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {},
    nodes: [{ nodeId: "one", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
    completion: { requiredNodes: ["one"] } } };
  const definitions = {};
  for (const name of ["cron", "repeat", "fixed", "branch", "outputs", "optin"]) {
    const definition = structuredClone(base);
    if (name === "cron") definition.spec.trigger = { kind: "cron", expression: "* * * * *", timezone: "UTC" };
    if (name === "repeat" || name === "optin") {
      definition.spec.nodes[0].control = { mode: "repeat", count: { kind: "dynamic" } };
      definition.spec.inputs.count = descriptor;
    }
    if (name === "fixed") definition.spec.nodes[0].control = { mode: "repeat", count: { kind: "fixed", value: 3 } };
    if (name === "branch") definition.spec.nodes[0].control = { mode: "branch", kind: "switch", cases: ["left", "right"], dynamicCases: true };
    if (name === "outputs") definition.spec.outputs.value = descriptor;
    const inputs = Object.hasOwn(definition.spec.inputs, "count") ? { count: "3" } : {};
    if (name === "optin") {
      definition.spec.inputs.workflowControls = { type: "string", required: true, nullable: false, schema: {} };
      inputs.workflowControls = JSON.stringify({ schema: "pkm.workflow.runtime-controls/v1",
        bindings: { nodes: { one: { repeat: { source: { kind: "input", name: "count" }, semantics: "count" } } } } });
    }
    assert.equal(compileWorkflowDefinitionV1(definition).ok, true);
    definitions[name] = { definition, inputs };
  }
  const loopDefinition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {}, nodes: [
    { nodeId: "head", kind: "pkm.step.noop/v1", config: {}, dependsOn: [
      { from: "tail", accept: ["again"], fromOutput: "value", toInput: "payload",
        loop: { termination: { condition: "until done", maxIterations: 2 } } },
    ] },
    { nodeId: "tail", kind: "pkm.step.noop/v1", config: {}, control: {
      mode: "branch", kind: "switch", cases: ["again", "done"],
    }, dependsOn: [{ from: "head", accept: ["succeeded"], fromOutput: "value" }] },
  ], completion: { requiredNodes: ["tail"] } } };
  assert.equal(compileWorkflowDefinitionV1(loopDefinition).ok, true);
  definitions.loop = { definition: loopDefinition, inputs: { token: "original" } };
  definitions.limit = { definition: loopDefinition, inputs: { token: "original" } };
  definitions.selection = { definition: { schema: base.schema, spec: { inputs: {}, outputs: {}, nodes: [
    { nodeId: "head", kind: "pkm.step.noop/v1", config: {}, dependsOn: [],
      control: { mode: "branch", kind: "switch", cases: ["left", "right"], dynamicCases: true } },
    { nodeId: "wait", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "head", accept: ["left"] }] },
    { nodeId: "required", kind: "pkm.step.noop/v1", config: {}, dependsOn: [
      { from: "head", accept: ["right"] }, { from: "wait", accept: ["succeeded"] },
    ] },
    { nodeId: "optional", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] },
  ], completion: { requiredNodes: ["required"] } } }, inputs: {} };
  assert.equal(compileWorkflowDefinitionV1(definitions.selection.definition).ok, true);
  const oracle = spawnSync(process.env.PKM_TEST_PYTHON ?? "python3", ["-B", "-c", `
import hashlib,importlib.util,json,pathlib,sys
extension,root=map(pathlib.Path,sys.argv[1:3])
sys.dont_write_bytecode=True
sys.path.insert(0,str(extension/"resources"))
spec=importlib.util.spec_from_file_location("genuine_workflow_controls",extension/"resources/recipe_runtime.py")
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
class Registration:
    def __init__(self): self.tools={}
    def tool(self,**options):
        def register(function): self.tools[function.__name__]=function;return function
        return register
registration=Registration();runtime.register_recipe_tools(registration,root)
trace={}
for name,fixture in json.loads(sys.argv[3]).items():
    start=registration.tools["recipe_run_start_adhoc"](name=name,definition_json=json.dumps(fixture["definition"]),
        command_id="original-controls-"+name,inputs_json=json.dumps(fixture["inputs"]))
    assert start["ok"],start
    run_id=start["run_id"]
    if name=="selection":
        registration.tools["recipe_run_next"](run_id=run_id,command_id="selection-head")
        head=registration.tools["recipe_run_report"](run_id=run_id,node_id="head",outcome="left",
            command_id="selection-report-head",result_json='{"value":1}')
        assert head["next_action"]["node_id"]=="wait",head
        final=registration.tools["recipe_run_report"](run_id=run_id,node_id="wait",outcome="succeeded",
            command_id="selection-report-wait",result_json='{"value":2}')
        assert final["status"]=="failed" and final["next_action"]["reason"]=="required-node-skipped",final
        record=runtime._load_run(runtime._run_paths(root,run_id)[0])
        assert record["nodeAttemptCounts"]=={"head":1,"wait":1},record
        trace[name]={"attempts":record["nodeAttemptCounts"],"action":final["next_action"]}
        continue
    if name in ("loop","limit"):
        contexts=[];action=start["next_action"]
        for iteration in (1,2):
            if action["kind"]!="execute_node":
                action=registration.tools["recipe_run_next"](run_id=run_id,command_id="claim-head-"+name+str(iteration))["next_action"]
            assert action["inputs"]==fixture["inputs"],action
            contexts.append(action["loop_context"])
            head_report=registration.tools["recipe_run_report"](run_id=run_id,node_id="head",outcome="succeeded",
                command_id="report-head-"+name+str(iteration),result_json=json.dumps({"value":iteration*2-1}))
            contexts.append(head_report["next_action"]["loop_context"])
            assert head_report["next_action"]["inputs"]==fixture["inputs"],head_report
            outcome="done" if name=="loop" and iteration==2 else "again"
            report=registration.tools["recipe_run_report"](run_id=run_id,node_id="tail",outcome=outcome,
                command_id="report-tail-"+name+str(iteration),result_json=json.dumps({"value":iteration*2}))
            action=report["next_action"]
        record=runtime._load_run(runtime._run_paths(root,run_id)[0])
        assert record["nodeAttemptCounts"]=={"head":2,"tail":2},record
        assert record["loops"]["tail->head"]["iteration"]==2,record
        assert record["loops"]["tail->head"]["state"]==("completed" if name=="loop" else "limited"),record
        assert report["status"]==("completed" if name=="loop" else "failed"),report
        trace[name]={"attempts":record["nodeAttemptCounts"],"contexts":contexts,"loops":record["loops"],
            "status":report["status"],"action":report["next_action"]}
        continue
    for index in range(3):
        read=registration.tools["recipe_run_get"](run_id=run_id)
        assert read["status"]=="running" and read["current_result"]["counts"]["pending"]==1,read
    claim=registration.tools["recipe_run_next"](run_id=run_id,command_id="claim-"+name)
    outcome="right" if name=="branch" else "succeeded"
    report=registration.tools["recipe_run_report"](run_id=run_id,node_id="one",outcome=outcome,
        command_id="report-"+name,result_json='{"value":"7"}')
    assert report["status"]=="completed",report
    record=runtime._load_run(runtime._run_paths(root,run_id)[0])
    assert record["nodeAttemptCounts"]=={"one":1},record
    assert record["definition"]==fixture["definition"] and record["inputs"]==fixture["inputs"]
    restart=Registration();runtime.register_recipe_tools(restart,root)
    reread=restart.tools["recipe_run_get"](run_id=run_id)
    assert reread["status"]=="completed"
    trace[name]={"attempts":record["nodeAttemptCounts"]["one"],"action":claim["next_action"],
        "result":reread["current_result"],"rawDefinitionPreserved":True,"rawInputsPreserved":True}
print(json.dumps({"sourceSha256":hashlib.sha256((extension/"resources/recipe_runtime.py").read_bytes()).hexdigest(),
    "registeredTools":sorted(registration.tools),"trace":trace}))
`, process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION, root, JSON.stringify(definitions)], {
    encoding: "utf8", timeout: 20000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(oracle.status, 0, oracle.stderr + oracle.stdout);
  const result = JSON.parse(oracle.stdout);
  assert.deepEqual(Object.entries(result.trace).filter(([name]) => !["loop", "limit", "selection"].includes(name)).map(([, value]) => value.attempts), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(result.trace.selection.attempts, { head: 1, wait: 1 });
  assert.deepEqual(result.trace.loop.contexts.flat().map(context => context.iteration), [1, 1, 2, 2]);
  assert.equal(result.trace.loop.loops["tail->head"].history.length, 2);
  assert.equal(result.trace.limit.action.reason, "loop-limit-reached");
  assert(result.trace.branch.action.accepted_outcomes.includes("right"));
  assert.deepEqual(result.trace.outputs.result.completed_nodes[0].result, { value: "7" });
  assert.equal(Object.hasOwn(result.trace.outputs.result, "outputs"), false);
  if (process.env.PKM_TEST_REPORTS) {
    await mkdir(process.env.PKM_TEST_REPORTS, { recursive: true });
    await writeFile(resolve(process.env.PKM_TEST_REPORTS, "original-controls-runtime-oracle.json"), JSON.stringify(result, null, 2) + "\n");
  }
});

test("explicit source-authorized Original metadata semantics preserve raw definitions and once-only dispatch without claiming typed control execution", async t => {
  const seen = [];
  const noop = "pkm.step.noop/v1";
  const custom = { ...adapter(async invocation => {
    assert.equal(invocation.executionSemantics, ORIGINAL_RECIPE_METADATA_SEMANTICS);
    if (invocation.node.control?.mode === "repeat") {
      assert.equal(invocation.runtimeControl.mode, "single");
      assert.equal(invocation.node.control.count.kind, "dynamic");
    }
    seen.push(invocation.runId);
    return { status: "succeeded", outputs: { value: 1 },
      ...(invocation.node.control?.mode === "branch" ? { branch: "right" } : {}) };
  }), authorizeDefinition: binding => binding.node.kind === noop && binding.executionSemantics === ORIGINAL_RECIPE_METADATA_SEMANTICS };
  const env = await setup(t, undefined, 100, { adapters: { [noop]: custom } });
  for (const name of ["cron", "repeat", "branch", "outputs"]) {
    const definition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {},
      nodes: [{ nodeId: "one", kind: noop, config: {}, dependsOn: [] }], completion: { requiredNodes: ["one"] } } };
    if (name === "cron") definition.spec.trigger = { kind: "cron", expression: "* * * * *", timezone: "UTC" };
    if (name === "repeat") definition.spec.nodes[0].control = { mode: "repeat", count: { kind: "dynamic" } };
    if (name === "branch") definition.spec.nodes[0].control = { mode: "branch", kind: "switch", cases: ["left", "right"], dynamicCases: true };
    if (name === "outputs") definition.spec.outputs.value = { type: "int64", required: true, nullable: false, schema: {} };
    const compiled = compileWorkflowDefinitionV1(definition);
    const request = args({ definition, executableDigest: compiled.executableDigest }, name);
    assert.throws(() => env.host.create("actor", request));
    env.db.exec("BEGIN IMMEDIATE");
    env.host.createInTransaction("actor", request, { dispatchMode: "explicit", originalRecipeMetadata: true, legacyRunInputs: true });
    env.db.exec("COMMIT");
    assert.equal(env.host.autoDispatchAllowed("actor", name), false);
    const final = await drain(env.host, name);
    assert.equal(final.state, "succeeded");
    assert.equal(final.steps, 1);
    assert.equal(env.host.executionSemantics("actor", name), ORIGINAL_RECIPE_METADATA_SEMANTICS);
    assert.deepEqual(JSON.parse(env.db.prepare("SELECT snapshot FROM workflow_executor_runs WHERE run_id=?").get(name).snapshot).definition, definition);
    if (name === "branch") assert.equal(final.nodes[0].branch, "right");
    assert.throws(() => env.host.outputs("actor", name), /metadata mode/);
  }
  assert.deepEqual(seen, ["cron", "repeat", "branch", "outputs"]);
});

test("Original feedback bodies preserve outcome-driven iteration, history, limits and explicit restart authority", async t => {
  const seen = [], receipts = [];
  const env = await setup(t, async invocation => {
    const context = invocation.loopContext[0];
    assert.deepEqual(invocation.inputs, { token: "original" });
    seen.push([invocation.runId, invocation.node.nodeId, context.iteration]);
    receipts.push(invocation);
    return { status: "succeeded", outputs: { value: context.iteration },
      ...(invocation.node.nodeId === "tail" ? { branch: invocation.runId === "limit" || context.iteration === 1 ? "again" : "done" } : {}) };
  });
  const value = fixture([
    node("head", [{ from: "tail", accept: ["again"], fromOutput: "value", toInput: "payload",
      loop: { termination: { condition: "until done", maxIterations: 2 } } }]),
    node("tail", [{ from: "head", accept: ["succeeded"], fromOutput: "value" }], { control: { mode: "branch", kind: "switch", cases: ["again", "done"] } }),
  ], ["tail"]);
  for (const id of ["complete", "limit"]) {
    assert.throws(() => env.host.create("actor", args(value, id)), /unqualified/);
    env.db.exec("BEGIN IMMEDIATE");
    env.host.createInTransaction("actor", args(value, id, { inputs: { token: "original" } }), { dispatchMode: "explicit", originalRecipeMetadata: true });
    env.db.exec("COMMIT");
    await env.host.tick("actor", id);
    await env.host.tick("actor", id);
    const first = env.host.originalRecipeLoopState("actor", id)["tail->head"];
    assert.equal(first.iteration, 2); assert.equal(first.history.length, 1);
    assert.equal(first.history[0].nodes.tail.outcome, "again");
    const completed = receipts.find(item => item.runId === id && item.node.nodeId === "tail");
    assert.equal(env.host.get("actor", id).nodes.find(item => item.nodeId === "tail").effect, "not-started");
    assert.equal(env.host.knownInvocationResult("actor", id, completed.invocationId).status, "succeeded");
    assert.equal(env.host.knownInvocationResult("actor", id, randomUUID()), undefined);
    env.host.interruptHostOwnedRun("actor", id);
    const resumed = env.other();
    assert.equal(resumed.autoDispatchAllowed("actor", id), false);
    assert.equal(resumed.knownInvocationResult("actor", id, completed.invocationId).status, "succeeded");
    assert.equal((await drain(resumed, id)).state, id === "limit" ? "failed" : "succeeded");
    const final = resumed.originalRecipeLoopState("actor", id)["tail->head"];
    assert.equal(final.history.length, 2);
    assert.equal(final.state, id === "limit" ? "limited" : "completed");
    assert.deepEqual(final.history.map(item => item.nodes.head.result.value), [1, 2]);
    await resumed.tick("actor", id);
  }
  assert.deepEqual(seen.map(item => item.slice(1)), [
    ["head", 1], ["tail", 1], ["head", 2], ["tail", 2],
    ["head", 1], ["tail", 1], ["head", 2], ["tail", 2],
  ]);
});

test("Original feedback never resets unknown or revoked effects and cancellation cannot start another iteration", async t => {
  const release = deferred(), started = deferred();
  let effects = 0, allowed = true;
  const custom = { ...adapter(async invocation => {
    effects++;
    if (invocation.runId === "unknown") { started.resolve(); return release.promise; }
    if (invocation.runId === "revoked" && invocation.node.nodeId === "tail") allowed = false;
    return { status: "succeeded", outputs: { value: 1 }, ...(invocation.node.nodeId === "tail" ? { branch: "again" } : {}) };
  }), authorizeDefinition: () => allowed };
  const env = await setup(t, undefined, 100, { adapters: { [key]: custom } });
  const make = (maximum = 2) => fixture([
    node("head", [{ from: "tail", accept: ["again"], loop: { termination: { condition: "again", maxIterations: maximum } } }]),
    node("tail", [{ from: "head", accept: ["succeeded"] }], { control: { mode: "branch", kind: "switch", cases: ["again", "done"] } }),
  ]);
  const create = id => {
    env.db.exec("BEGIN IMMEDIATE");
    env.host.createInTransaction("actor", args(make(), id), { dispatchMode: "explicit", originalRecipeMetadata: true });
    env.db.exec("COMMIT");
  };
  env.db.exec("BEGIN IMMEDIATE");
  assert.throws(() => env.host.createInTransaction("actor", args(make(65), "oversized"),
    { dispatchMode: "explicit", originalRecipeMetadata: true }), /unqualified/);
  env.db.exec("COMMIT");
  create("cancelled");
  await env.host.tick("actor", "cancelled"); await env.host.tick("actor", "cancelled");
  env.host.cancel("actor", { operationId: randomUUID(), runId: "cancelled", expectedVersion: env.host.get("actor", "cancelled").version });
  assert.equal((await env.host.tick("actor", "cancelled")).state, "cancelled");
  assert.equal(env.host.originalRecipeLoopState("actor", "cancelled")["tail->head"].history.length, 1);
  create("unknown");
  const pending = env.host.tick("actor", "unknown"); await started.promise;
  env.host.interruptHostOwnedRun("actor", "unknown"); await pending;
  release.resolve({ status: "succeeded", outputs: { value: 1 } });
  const other = env.other();
  assert.equal((await other.tick("actor", "unknown")).state, "unknown");
  assert.equal(other.originalRecipeLoopState("actor", "unknown")["tail->head"].history.length, 0);
  create("revoked");
  await env.host.tick("actor", "revoked");
  assert.equal((await env.host.tick("actor", "revoked")).state, "unknown");
  assert.equal(env.host.originalRecipeLoopState("actor", "revoked")["tail->head"].history.length, 0);
  assert.equal(effects, 5);
});

test("Original feedback snapshots preserve unselected paths without inventing effects or results", async t => {
  const executed = [];
  const env = await setup(t, async invocation => {
    executed.push(invocation.node.nodeId);
    return { status: "succeeded", outputs: { value: 1 },
      ...(invocation.node.nodeId === "head" ? { branch: "left" }
        : invocation.node.nodeId === "tail" ? { branch: invocation.loopContext[0].iteration === 1 ? "again" : "done" } : {}) };
  });

  const value = fixture([
    node("head", [{ from: "tail", accept: ["again"], loop: { termination: { condition: "until done", maxIterations: 2 } } }],
      { control: { mode: "branch", kind: "switch", cases: ["left", "right"] } }),
    node("left", [{ from: "head", accept: ["left"] }]),
    node("right", [{ from: "head", accept: ["right"] }]),
    node("tail", [{ from: "left", accept: ["succeeded"] }, { from: "right", accept: ["skipped"] }],
      { control: { mode: "branch", kind: "switch", cases: ["again", "done"] } }),
  ]);
  env.db.exec("BEGIN IMMEDIATE");
  env.host.createInTransaction("actor", args(value), { dispatchMode: "explicit", originalRecipeMetadata: true });
  env.db.exec("COMMIT");
  assert.equal((await drain(env.host)).state, "succeeded");
  assert.deepEqual(executed, ["head", "left", "tail", "head", "left", "tail"]);
  const loop = env.host.originalRecipeLoopState("actor", "test-run")["tail->head"];
  assert.equal(loop.history.length, 2);
  for (const snapshot of loop.history)
    assert.deepEqual(snapshot.nodes.right, { state: "skipped", outcome: "skipped", result: null,
      error: "Dependency outcome did not select this path." });
});

test("Original reported branches retain authored order, wait for settled dependencies and stop at required-node exclusion", async t => {
  const executed = [];
  const env = await setup(t, async invocation => {
    executed.push(invocation.node.nodeId);
    return { status: "succeeded", outputs: { value: 1 }, ...(invocation.node.nodeId === "head" ? { branch: "left" } : {}) };
  });
  const value = fixture([
    node("head", [], { control: { mode: "branch", kind: "switch", cases: ["left", "right"], dynamicCases: true } }),
    node("wait", [{ from: "head", accept: ["left"] }]),
    node("required", [{ from: "head", accept: ["right"] }, { from: "wait", accept: ["succeeded"] }]),
    node("optional"),
  ], ["required"]);
  env.db.exec("BEGIN IMMEDIATE");
  env.host.createInTransaction("actor", args(value), { dispatchMode: "explicit", originalRecipeMetadata: true });
  env.db.exec("COMMIT");
  const final = await drain(env.host);
  assert.equal(final.state, "failed");
  assert.deepEqual(executed, ["head", "wait"]);
  assert.equal(final.nodes.find(item => item.nodeId === "optional").state, "pending");
});

test("declared Original inputs_json control envelope opts into native controls without changing the public signature or defaulting missing values", async t => {
  const definition = fixture([node("one", [], { control: { mode: "repeat", count: { kind: "dynamic" } } })]).definition;
  definition.spec.inputs = {
    count: { type: "int64", required: true, nullable: false, schema: {} },
    workflowControls: { type: "string", required: true, nullable: false, schema: {} },
  };
  definition.spec.outputs.count = { type: "int64", required: true, nullable: false, schema: {} };
  const bindings = { nodes: { one: { repeat: { source: { kind: "input", name: "count" }, semantics: "count" } } },
    outputs: { count: { kind: "input", name: "count" } } };
  const inputs = { count: "3", workflowControls: JSON.stringify({ schema: "pkm.workflow.runtime-controls/v1", bindings }) };
  const resolved = workflowRuntimeBindingsFromOriginalInputs(definition, inputs);
  assert.deepEqual(resolved, bindings);
  assert.equal(workflowRuntimeBindingsFromOriginalInputs(definition, { ...inputs, workflowControls: "ordinary user input" }), undefined);
  const undeclared = structuredClone(definition); delete undeclared.spec.inputs.workflowControls;
  assert.equal(workflowRuntimeBindingsFromOriginalInputs(undeclared, inputs), undefined);
  assert.throws(() => workflowRuntimeBindingsFromOriginalInputs(definition, {
    ...inputs, workflowControls: JSON.stringify({ schema: "pkm.workflow.runtime-controls/v1", bindings: { ...bindings, unexpected: true } }),
  }));
  const env = await setup(t);
  const compiled = compileWorkflowDefinitionV1(definition);
  const request = args({ definition, executableDigest: compiled.executableDigest }, "test-run", { inputs, runtimeBindings: resolved });
  env.db.exec("BEGIN IMMEDIATE");
  const { runtimeBindings: _runtimeBindings, ...unboundRequest } = request;
  assert.throws(() => env.host.createInTransaction("actor", unboundRequest,
    { dispatchMode: "explicit", originalRecipeMetadata: true }), /Explicit native controls/);
  env.host.createInTransaction("actor", request, { dispatchMode: "explicit" });
  env.db.exec("COMMIT");
  assert.equal((await drain(env.host)).steps, 3);
  assert.deepEqual(env.host.outputs("actor", "test-run"), { count: "3" });
});

test("original-valid inline controls require explicit bindings and execute through the composed public Core", async t => {
  const { initialize, Storage } = await import("../dist/storage.js");
  const { createNativeRuntime } = await import("../dist/native-runtime.js");
  const root = resolve(`.workflow-public-${randomUUID()}`);
  await initialize(root);
  const storage = await Storage.open(root);
  let effects = 0, now = Date.now(), futureConsent = true;
  const runtime = await createNativeRuntime({ storage, workspaceId: await storage.workspaceId(),
    workflow: { clock: () => now, authorizeTrigger: binding => futureConsent && binding.actorId === "public-owner",
      adapters: { [key]: adapter(async invocation => {
      effects++;
      return { status: "succeeded", outputs: { value: 1 }, ...(invocation.node.control?.mode === "branch" ? { branch: invocation.runtimeControl.cases[0] } : {}) };
    }) } } });
  t.after(async () => { await runtime.close(); await storage.close(); await rm(root, { recursive: true, force: true }); });
  const call = (operation, arguments_) => runtime.core.dispatch("capability_call",
    { operation, version: 1, arguments: arguments_ }, { id: "public-owner", canWrite: true });
  const outcomes = [];
  for (const [name, extra] of [
    ["positive", {}],
    ["outputs", { outputs: { value: { type: "int64", required: true, nullable: false, schema: {} } } }],
    ["repeat", { nodes: [node("one", [], { control: { mode: "repeat", count: { kind: "dynamic" } } })] }],
    ["branch", { nodes: [node("one", [], { control: { mode: "branch", kind: "switch", cases: ["left", "right"], dynamicCases: true } })] }],
    ["cron", { trigger: { kind: "cron", expression: "* * * * *", timezone: "UTC" } }],
  ]) {
    const definition = fixture([node("one")]).definition;
    Object.assign(definition.spec, extra);
    const runtimeBindings = { nodes: {}, outputs: {} };
    const inputs = {};
    if (name === "outputs" || name === "repeat") {
      definition.spec.inputs.count = { type: "int64", required: true, nullable: false, schema: {} };
      inputs.count = "2";
      if (name === "outputs") runtimeBindings.outputs.value = { kind: "input", name: "count" };
      else runtimeBindings.nodes.one = { repeat: { source: { kind: "input", name: "count" }, semantics: "count" } };
    }
    if (name === "branch") {
      definition.spec.inputs.cases = { type: "array", required: true, nullable: false,
        schema: { items: { type: "string", required: true, nullable: false, schema: {} } } };
      inputs.cases = ["right"];
      runtimeBindings.nodes.one = { cases: { kind: "input", name: "cases" } };
    }
    if (name === "cron") runtimeBindings.trigger = { mode: "manual" };
    const compiled = compileWorkflowDefinitionV1(definition);
    assert.equal(compiled.ok, true);
    for (const operation of ["workflow.definition.validate", "workflow.definition.compile"]) {
      const checked = await runtime.core.dispatch("capability_read", { operation, version: 1,
        arguments: { source: { kind: "inline", definition } } }, { id: "public-owner", canWrite: true });
      assert.equal(checked.result.status, "valid", JSON.stringify(checked));
    }
    const result = await call("workflow.executor.create", args({ definition, executableDigest: compiled.executableDigest }, name,
      { deadline: Date.now() + 10000, inputs, ...(name !== "positive" ? { runtimeBindings } : {}) }));
    outcomes.push({ name, error: result.error });
    if (!result.error) {
      let finished;
      for (let i = 0; i < 100; i++) {
        const read = await runtime.core.dispatch("capability_read", { operation: "workflow.executor.get", version: 1, arguments: { runId: name } },
          { id: "public-owner", canWrite: true });
        finished = read.result;
        if (!["ready", "running"].includes(finished.state)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(finished.state, "succeeded", name);
      assert.equal(finished.steps, name === "repeat" ? 2 : 1);
      if (name === "branch") assert.equal(finished.nodes[0].branch, "right");
      if (name === "outputs") {
        const read = await runtime.core.dispatch("capability_read", { operation: "workflow.executor.outputs", version: 1, arguments: { runId: name } },
          { id: "public-owner", canWrite: true });
        assert.deepEqual(read.result, { value: "2" });
      }
    }
  }
  assert.deepEqual(outcomes.filter(item => item.error), []);
  assert.equal(effects, 6);
  const scheduledDefinition = fixture([node("one")]).definition;
  scheduledDefinition.spec.trigger = { kind: "cron", expression: "* * * * *", timezone: "UTC" };
  const scheduled = compileWorkflowDefinitionV1(scheduledDefinition);
  const dueAt = Math.ceil((now + 1) / 60000) * 60000;
  const runtimeBindings = { trigger: { mode: "automation", consentId: randomUUID(), dueAt,
    expiresAt: dueAt + 30000, maxLatenessMs: 1000 } };
  const scheduledArgs = args({ definition: scheduledDefinition, executableDigest: scheduled.executableDigest }, "scheduled",
    { deadline: dueAt + 50000, runtimeBindings });
  futureConsent = false;
  assert.equal((await call("workflow.executor.create", scheduledArgs)).error.code, "FORBIDDEN");
  futureConsent = true;
  const created = await call("workflow.executor.create", scheduledArgs);
  assert.equal(created.error, undefined);
  assert.equal(effects, 6);
  now = dueAt;
  for (let i = 0; i < 150 && effects === 6; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(effects, 7, "the composed native scheduler actually fires the consented due slot");
});

test("bound upstream collections repeat exact items; dynamic cases and typed output use authoritative producers", async t => {
  const seen = [];
  const execute = async invocation => {
    seen.push([invocation.node.nodeId, invocation.inputs.item]);
    if (invocation.node.nodeId === "produce")
      return { status: "succeeded", outputs: { items: ["A", "B"], cases: ["right"] } };
    if (invocation.node.nodeId === "choose")
      return { status: "succeeded", outputs: { value: "2", left: null, right: null }, branch: invocation.runtimeControl.cases[0] };
    return { status: "succeeded", outputs: { value: invocation.inputs.item } };
  };
  const custom = { ...adapter(execute), validateOutput: outputs => Object.keys(outputs).every(key => ["items", "cases", "value", "left", "right"].includes(key)) };
  const env = await setup(t, execute, 100, { adapters: { [key]: custom } });
  const definition = fixture([
    node("produce", [], { ports: { inputs: [], outputs: ["items", "cases"] } }),
    node("repeat", [{ from: "produce", accept: ["succeeded"], required: true }],
      { ports: { inputs: ["item"], outputs: ["value"] }, control: { mode: "repeat", count: { kind: "dynamic" } } }),
    node("choose", [{ from: "produce", accept: ["succeeded"], required: true },
      { from: "repeat", accept: ["succeeded"], required: true }],
      { ports: { inputs: [], outputs: ["value", "left", "right"] }, control: { mode: "branch", kind: "switch", cases: ["left", "right"], dynamicCases: true } }),
  ]).definition;
  definition.spec.outputs.answer = { type: "int64", required: true, nullable: false, schema: {} };
  const compiled = compileWorkflowDefinitionV1(definition);
  const runtimeBindings = { nodes: {
    repeat: { repeat: { source: { kind: "node-output", nodeId: "produce", output: "items" }, semantics: "collection", itemInput: "item" } },
    choose: { cases: { kind: "node-output", nodeId: "produce", output: "cases" } },
  }, outputs: { answer: { kind: "node-output", nodeId: "choose", output: "value" } } };
  env.host.create("actor", args({ definition, executableDigest: compiled.executableDigest }, "test-run", { runtimeBindings }));
  assert.throws(() => env.host.outputs("actor", "test-run"), /successful completion/);
  const final = await drain(env.host);
  assert.equal(final.state, "succeeded");
  assert.deepEqual(seen, [["produce", undefined], ["repeat", "A"], ["repeat", "B"], ["choose", undefined]]);
  assert.deepEqual(env.host.outputs("actor", "test-run"), { answer: "2" });
  const restarted = env.other();
  assert.deepEqual(restarted.outputs("actor", "test-run"), { answer: "2" });
  await restarted.tick("actor", "test-run");
  assert.equal(seen.length, 4);
});

test("missing, forged and over-budget dynamic bindings deny before any effect; old views stay readable and old host cannot auto-dispatch", async t => {
  let effects = 0;
  const env = await setup(t, async () => { effects++; return { status: "succeeded", outputs: { value: 1 } }; });
  const definition = fixture([node("one", [], { control: { mode: "repeat", count: { kind: "dynamic" } } })]).definition;
  definition.spec.inputs.count = { type: "int64", required: false, nullable: false, schema: {} };
  const compiled = compileWorkflowDefinitionV1(definition);
  const value = { definition, executableDigest: compiled.executableDigest };
  assert.throws(() => env.host.create("actor", args(value)), /explicit binding/);
  const runtimeBindings = { nodes: { one: { repeat: { source: { kind: "input", name: "count" }, semantics: "count" } } } };
  for (const count of [undefined, "0", "65", "-1"])
    assert.throws(() => env.host.create("actor", args(value, "bad", { runtimeBindings, inputs: count === undefined ? {} : { count } })), /authoritative value|1–64/);
  const denied = env.other({ adapters: { [key]: { ...adapter(), authorizeDefinition: binding => binding.runtimeBindings === undefined } } });
  assert.throws(() => denied.create("actor", args(value, "binding-denied", { runtimeBindings, inputs: { count: "2" } })), /denied/);
  const created = env.host.create("actor", args(value, "test-run", { runtimeBindings, inputs: { count: "2" } }));
  assert.equal(created.dispatchMode, "explicit");
  assert.equal(env.host.autoDispatchAllowed("actor", "test-run"), true);
  assert.equal(effects, 0);
  const oldSchema = (await import("../dist/workflow-executor-contracts.js")).workflowExecutorView;
  assert.deepEqual(oldSchema.parse(created), created);
  assert.equal((await drain(env.host)).steps, 2);
});

test("cron delivery claims one consented due slot, respects timezone, revocation/cancellation and never replays unknown effects", async t => {
  let effects = 0, allowed = true;
  const env = await setup(t, async () => { effects++; return { status: "succeeded", outputs: { value: 1 } }; },
    100, { authorizeTrigger: () => allowed });
  const definition = fixture([node("one")]).definition;
  definition.spec.trigger = { kind: "cron", expression: "0 19 * * *", timezone: "America/New_York" };
  const compiled = compileWorkflowDefinitionV1(definition);
  const dueAt = Date.UTC(2026, 0, 2, 0), deadline = dueAt + 100000;
  env.now(dueAt - 1000);
  const runtimeBindings = { trigger: { mode: "automation", consentId: randomUUID(), dueAt, expiresAt: dueAt + 50000, maxLatenessMs: 1000 } };
  const request = args({ definition, executableDigest: compiled.executableDigest }, "test-run", { deadline, runtimeBindings });
  const created = env.host.create("actor", request);
  assert.deepEqual(env.host.create("actor", request), created);
  assert.throws(() => env.host.create("actor", { ...request, operationId: randomUUID(), runId: "duplicate" }), /due slot already/);
  await env.host.tick("actor", "test-run"); assert.equal(effects, 0);
  env.now(dueAt);
  assert.equal((await drain(env.host)).state, "succeeded");
  const restarted = env.other();
  await restarted.tick("actor", "test-run"); assert.equal(effects, 1);
  for (const [index, mode] of ["cancel", "revoke", "missed"].entries()) {
    const nextDue = dueAt + (index + 1) * 86400000;
    const nextDefinition = { ...definition, spec: { ...definition.spec, trigger: { kind: "cron", expression: "* * * * *", timezone: "UTC" } } };
    const next = compileWorkflowDefinitionV1(nextDefinition);
    const bindings = { trigger: { ...runtimeBindings.trigger, dueAt: nextDue, expiresAt: nextDue + 50000, consentId: randomUUID() } };
    env.now(nextDue - 1000); allowed = true;
    env.host.create("actor", args({ definition: nextDefinition, executableDigest: next.executableDigest }, mode,
      { deadline: nextDue + 100000, runtimeBindings: bindings }));
    if (mode === "cancel") env.host.cancel("actor", { runId: mode, operationId: randomUUID(), expectedVersion: 1 });
    if (mode === "revoke") allowed = false;
    env.now(nextDue + (mode === "missed" ? 1001 : 0));
    assert.equal((await env.host.tick("actor", mode)).state, "cancelled");
  }
  assert.equal(effects, 1);
});

test("cron restart preserves unknown effects and changed source or revoked post-effect authority cannot publish outputs", async t => {
  const entered = deferred(), release = deferred();
  let effects = 0, current = true;
  const definition = fixture([node("one")]).definition;
  definition.spec.trigger = { kind: "cron", expression: "* * * * *", timezone: "UTC" };
  const compiled = compileWorkflowDefinitionV1(definition);
  const env = await setup(t, async () => { effects++; entered.resolve(); return release.promise; }, 100,
    { authorizeTrigger: () => current });
  env.now(59000);
  env.host.create("actor", args({ definition, executableDigest: compiled.executableDigest }, "test-run", {
    deadline: 100000, runtimeBindings: { trigger: { mode: "automation", consentId: randomUUID(), dueAt: 60000,
      expiresAt: 90000, maxLatenessMs: 1000 } },
  }));
  env.now(60000);
  const pending = env.host.tick("actor", "test-run"); await entered.promise;
  const restarted = env.other(); env.now(60101);
  assert.equal(restarted.recover("actor", "test-run").state, "unknown");
  current = false; release.resolve({ status: "succeeded", outputs: { value: 1 } });
  assert.equal((await pending).state, "unknown");
  await restarted.tick("actor", "test-run");
  assert.equal(effects, 1);
  assert.deepEqual(restarted.get("actor", "test-run").nodes[0].outputs, {});

  const simple = fixture([node("one")]);
  let sourceCurrent = true, allowed = true;
  const nativeAdapter = { ...adapter(), authorizeDefinition: () => allowed };
  const pinned = await setup(t, undefined, 100, {
    adapters: { [key]: nativeAdapter },
    resolveRecipe: () => ({ status: sourceCurrent ? "valid" : "invalid", executableDigest: simple.executableDigest,
      definition: simple.definition, source: { kind: "recipe", recipeId: "source_recipe", revision: 1 } }),
  });
  const request = args(simple, "test-run", { source: { kind: "recipe", recipeId: "source_recipe",
    expectedRevision: 1, expectedExecutableDigest: simple.executableDigest }, runtimeBindings: {} });
  pinned.host.create("actor", request); sourceCurrent = false;
  assert.equal((await pinned.host.tick("actor", "test-run")).state, "failed");
  assert.equal(pinned.host.get("actor", "test-run").steps, 0);
  sourceCurrent = true; allowed = false;
  assert.throws(() => pinned.host.create("actor", { ...request, operationId: randomUUID(), runId: "denied" }), /denied/);
});

test("run-output type failures do not become success and the total dynamic node budget is checked before dispatch", async t => {
  const env = await setup(t);
  const definition = fixture([node("one", [], { ports: { inputs: [], outputs: ["value"] } })]).definition;
  definition.spec.outputs.result = { type: "int64", required: true, nullable: false, schema: {} };
  const compiled = compileWorkflowDefinitionV1(definition);
  env.host.create("actor", args({ definition, executableDigest: compiled.executableDigest }, "test-run", {
    runtimeBindings: { outputs: { result: { kind: "node-output", nodeId: "one", output: "value" } } },
  }));
  assert.equal((await drain(env.host)).state, "failed");
  assert.throws(() => env.host.outputs("actor", "test-run"), /successful completion/);
  const large = fixture(Array.from({ length: 17 }, (_, index) => node(`n${index}`,
    [], { control: { mode: "repeat", count: { kind: "dynamic" } } })));
  assert.throws(() => env.host.create("actor", args(large, "budget")), /unqualified/);
});

test("Recipe native-effect custody is exact, bounded, idempotent and cannot revive completed or unowned invocations", async t => {
  let invocationId;
  const metadata = { decisionId: randomUUID(), requestDigest: "a".repeat(64), selectedExecutableDigest: "b".repeat(64) };
  const env = await setup(t, async invocation => {
    invocationId = invocation.invocationId;
    env.db.exec("BEGIN IMMEDIATE");
    try {
      const first = env.host.recordNativeEffectApprovalInTransaction("actor", "test-run", invocationId, metadata);
      assert.deepEqual(env.host.recordNativeEffectApprovalInTransaction("actor", "test-run", invocationId, metadata), first);
      assert.throws(() => env.host.recordNativeEffectApprovalInTransaction("actor", "test-run", invocationId, { ...metadata, decisionId: randomUUID() }), /reused/);
      assert.throws(() => env.host.recordNativeEffectApprovalInTransaction("actor", "test-run", randomUUID(), metadata), /Exact running invocation/);
      assert.throws(() => env.host.recordNativeEffectApprovalInTransaction("actor", "test-run", invocationId, { excess: "x".repeat(25000) }), /byte limit/);
      env.db.exec("COMMIT");
    } catch (error) { env.db.exec("ROLLBACK"); throw error; }
    return { status: "succeeded", outputs: { value: 1 } };
  });
  env.db.exec("BEGIN IMMEDIATE");
  env.host.createInTransaction("actor", args(fixture([node("one")])), { dispatchMode: "explicit" });
  env.db.exec("COMMIT");
  assert.equal((await drain(env.host)).state, "succeeded");
  assert.equal(env.host.events("actor", "test-run").filter(event => event.kind === "legacy-recipe-native-effect").length, 1);
  env.db.exec("BEGIN IMMEDIATE");
  assert.throws(() => env.host.recordNativeEffectApprovalInTransaction("actor", "test-run", invocationId, metadata), /Exact running invocation/);
  env.db.exec("ROLLBACK");
});

test("native DAG commits offer/claim/start before dispatch, persists authoritative outputs, isolates actors", async t => {
  const seen = [];
  const env = await setup(t, async invocation => {
    assert.equal(env.db.isTransaction, false);
    const independent = new DatabaseSync(env.file);
    try {
      const snapshot = JSON.parse(independent.prepare("SELECT snapshot FROM workflow_executor_runs").get().snapshot);
      assert.equal(snapshot.nodes.find(item => item.nodeId === invocation.node.nodeId).state, "running");
      assert.equal(independent.prepare("SELECT count(*) AS n FROM workflow_executor_events WHERE kind='start-intent'").get().n, seen.length + 1);
    } finally { independent.close(); }
    assert(Object.isFrozen(invocation.node.config));
    seen.push(invocation.node.nodeId);
    return { status: "succeeded", outputs: { value: seen.length } };
  });
  const request = args();
  const created = env.host.create("actor", request);
  assert.equal(created.state, "ready");
  assert.deepEqual(env.host.create("actor", request), created);
  assert.throws(() => env.host.create("actor", { ...request, deadline: 11_000 }), /reused/);
  assert.throws(() => env.host.get("other", "test-run"), /not found/);
  const final = await drain(env.host);
  assert.equal(final.state, "succeeded"); assert.equal(final.steps, 2);
  assert.deepEqual(seen, ["first", "second"]);
  assert.equal(final.nodes[1].outputs.value, 2);
  assert.deepEqual(env.host.events("actor", "test-run").map(event => event.kind),
    ["created", "offered", "claimed", "start-intent", "completion", "offered", "claimed", "start-intent", "completion"]);
  await env.host.tick("actor", "test-run");
  assert.equal(seen.length, 2);
});

test("declared branch verdicts select dependency paths and close non-selected paths", async t => {
  const calls = [];
  const env = await setup(t, async invocation => {
    calls.push(invocation.node.nodeId);
    return { status: "succeeded", outputs: { value: 1 }, ...(invocation.node.nodeId === "choose" ? { branch: "left" } : {}) };
  });
  const value = fixture([
    node("choose", [], { control: { mode: "branch", kind: "switch", cases: ["left", "right"] } }),
    node("left", [{ from: "choose", accept: ["left"], required: true }]),
    node("right", [{ from: "choose", accept: ["right"], required: true }]),
    node("finish", [{ from: "left", accept: ["succeeded"], required: true }]),
  ], ["finish"]);
  env.host.create("actor", args(value));
  const result = await drain(env.host);
  assert.equal(result.state, "succeeded");
  assert.deepEqual(calls, ["choose", "left", "finish"]);
  assert.equal(result.nodes.find(item => item.nodeId === "right").state, "skipped");
});

test("fixed repeat and bounded self-loop use per-iteration intent and previous output, never implicit retries", async t => {
  const calls = [];
  const env = await setup(t, async invocation => {
    calls.push([invocation.node.nodeId, invocation.iteration]);
    assert.equal(invocation.previousOutputs.value ?? 0, invocation.iteration);
    return { status: "succeeded", outputs: { value: invocation.iteration + 1 },
      ...(invocation.node.nodeId === "loop" ? { termination: { done: invocation.iteration === 1 } } : {}) };
  });
  const value = fixture([
    node("repeat", [], { control: { mode: "repeat", count: { kind: "fixed", value: 3 } } }),
    node("loop", [
      { from: "repeat", accept: ["succeeded"], required: true },
      { from: "loop", accept: ["succeeded"], required: true, loop: { termination: { condition: "done", maxIterations: 4 } } },
    ]),
  ]);
  env.host.create("actor", args(value));
  const result = await drain(env.host);
  assert.equal(result.state, "succeeded"); assert.equal(result.steps, 5);
  assert.deepEqual(calls, [["repeat", 0], ["repeat", 1], ["repeat", 2], ["loop", 0], ["loop", 1]]);
});

test("loop limit and explicit failure close required dependencies; accepted failures can run recovery nodes", async t => {
  const env = await setup(t, async invocation => ({
    status: invocation.node.nodeId === "fail" ? "failed" : "succeeded", outputs: { value: 1 }, termination: { done: false },
  }));
  const loop = fixture([node("loop", [
    { from: "loop", accept: ["succeeded"], required: true, loop: { termination: { condition: "done", maxIterations: 2 } } },
  ])]);
  env.host.create("actor", args(loop, "limit-run"));
  const limited = await drain(env.host, "limit-run");
  assert.equal(limited.state, "failed"); assert.equal(limited.steps, 2);
  const failure = fixture([
    node("fail"), node("blocked", [{ from: "fail", accept: ["succeeded"], required: true }]),
    node("recover", [{ from: "fail", accept: ["failed"], required: true }]),
  ], ["recover"]);
  env.host.create("actor", args(failure));
  const recovered = await drain(env.host);
  assert.equal(recovered.state, "succeeded");
  assert.equal(recovered.nodes.find(item => item.nodeId === "blocked").state, "skipped");
});

test("cancel CAS fences a running effect and rejects its late output; no forged completion contract", async t => {
  const started = deferred(), release = deferred();
  let effects = 0;
  const env = await setup(t, async () => { effects++; started.resolve(); return release.promise; });
  env.host.create("actor", args());
  const running = env.host.tick("actor", "test-run");
  await started.promise;
  const current = env.host.get("actor", "test-run");
  assert.throws(() => env.host.cancel("actor", { operationId: randomUUID(), runId: "test-run", expectedVersion: 1 }), /version changed/);
  const cancel = { operationId: randomUUID(), runId: "test-run", expectedVersion: current.version };
  const cancelled = env.host.cancel("actor", cancel);
  assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.nodes[0].effect, "unknown");
  assert.deepEqual(env.host.cancel("actor", cancel), cancelled);
  release.resolve({ status: "succeeded", outputs: { value: 99 } });
  assert.equal((await running).state, "cancelled");
  assert.deepEqual(env.host.get("actor", "test-run").nodes[0].outputs, {});
  await env.host.tick("actor", "test-run"); assert.equal(effects, 1);
  assert.deepEqual(workflowExecutorDefinitions.map(item => item.id),
    ["workflow.executor.create", "workflow.executor.get", "workflow.executor.cancel", "workflow.executor.outputs"]);
  assert.equal(workflowExecutorDefinitions[2].input.safeParse({ ...cancel, outputs: {} }).success, false);
});

test("expired running lease is unknown across DB connections and cannot duplicate or accept late side effects", async t => {
  const started = deferred(), release = deferred();
  let effects = 0;
  const env = await setup(t, async () => { effects++; started.resolve(); return release.promise; });
  env.host.create("actor", args());
  const pending = env.host.tick("actor", "test-run");
  await started.promise;
  const second = env.other();
  assert.equal((await second.tick("actor", "test-run")).steps, 1);
  env.now(1101);
  assert.equal(second.recover("actor", "test-run").state, "unknown");
  release.resolve({ status: "succeeded", outputs: { value: 1 } });
  assert.equal((await pending).state, "unknown");
  assert.equal((await second.tick("actor", "test-run")).state, "unknown");
  assert.equal(effects, 1);
  assert.equal(JSON.parse(env.db.prepare("SELECT record FROM workflow_executor_assignments").get().record).scheduler.state, "expired");
});

for (const stage of ["claimed", "running"]) test(`interrupted ${stage} transaction leaves only safe pre-dispatch intent to reclaim`, async t => {
  let effects = 0;
  const env = await setup(t, async () => { effects++; return { status: "succeeded", outputs: { value: 1 } }; });
  env.host.create("actor", args(fixture([node("one")])));
  env.db.exec(`CREATE TRIGGER stop_stage BEFORE UPDATE ON workflow_executor_runs
    WHEN json_extract(NEW.snapshot,'$.nodes[0].state')='${stage}'
    BEGIN SELECT RAISE(ABORT,'synthetic crash before commit'); END;`);
  await assert.rejects(env.host.tick("actor", "test-run"), /synthetic crash/);
  assert.equal(effects, 0);
  assert.equal(env.host.get("actor", "test-run").nodes[0].state, stage === "claimed" ? "offered" : "claimed");
  env.db.exec("DROP TRIGGER stop_stage");
  env.now(1101);
  const restarted = env.other();
  assert.equal(restarted.recover("actor", "test-run").nodes[0].state, "pending");
  assert.equal((await drain(restarted)).state, "succeeded"); assert.equal(effects, 1);
});

test("real child process crash after a durable synthetic side effect never replays running work on restart", async t => {
  const env = await setup(t);
  env.db.exec("CREATE TABLE synthetic_effects (id TEXT PRIMARY KEY)");
  env.host.create("actor", args(fixture([node("one")]), "restart-run"));
  const child = fork(new URL("./workflow-executor-restart-child.mjs", import.meta.url), [env.file, env.root], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [],
  });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const started = await Promise.race([
    once(child, "message"), once(child, "exit").then(([code]) => { throw new Error(`child exited ${code}: ${stderr}`); }),
  ]);
  assert.equal(started[0].started, true);
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  env.now(1101);
  const restart = env.other();
  assert.equal(restart.recover("actor", "restart-run").state, "unknown");
  await restart.tick("actor", "restart-run");
  assert.equal(env.db.prepare("SELECT count(*) AS n FROM synthetic_effects").get().n, 1);
});

test("invalid outputs, thrown adapters and undeclared branch verdicts become unknown without propagation", async t => {
  for (const [name, execute] of [
    ["invalid", async () => ({ status: "succeeded", outputs: { forged: true } })],
    ["throws", async () => { throw new Error("may already have committed"); }],
    ["branch", async () => ({ status: "succeeded", outputs: { value: 1 }, branch: "forged" })],
  ]) {
    const env = await setup(t, execute);
    env.host.create("actor", args(dag, name));
    const result = await env.host.tick("actor", name);
    assert.equal(result.state, "unknown");
    assert.deepEqual(result.nodes[0].outputs, {});
    assert.equal(result.nodes[1].state, "skipped");
  }
});

test("native registration and exact adapter pins deny absent process/tool configuration or replacements", async t => {
  const env = await setup(t);
  const missing = env.other({ adapters: {} });
  assert.throws(() => missing.create("actor", args()), /configuration required/);
  env.host.create("actor", args());
  const changed = env.other({ adapters: { [key]: { ...adapter(), version: 2 } } });
  await assert.rejects(changed.tick("actor", "test-run"), /pinned native adapter/);
  const command = fixture([{ nodeId: "process", kind: "pkm.step.command/v1", config: {
    program: "never-execute", args: [], timeoutSeconds: 1, maxOutputBytes: 1024,
  }, dependsOn: [] }]);
  assert.throws(() => env.host.create("actor", args(command, "process-run")), /configuration required/);
  assert.throws(() => env.host.create("actor", args(dag, "bad-digest", { expectedExecutableDigest: "0".repeat(64) })), /digest changed/);
});

test("shared transaction integration rolls back intents/receipts together and rejects dispatch in transaction", async t => {
  const env = await setup(t);
  const request = args();
  env.db.exec("BEGIN IMMEDIATE");
  const result = mutateWorkflowExecutor(env.host, { operation: "workflow.executor.create", actorId: "actor", args: request });
  assert.equal(result.state, "ready");
  await assert.rejects(env.host.tick("actor", "test-run"), /outside caller transactions/);
  env.db.exec("ROLLBACK");
  assert.throws(() => env.host.get("actor", "test-run"), /not found/);
  assert.equal(env.db.prepare("SELECT count(*) AS n FROM workflow_executor_receipts").get().n, 0);
  env.host.create("actor", request);
  assert.equal((await drain(env.host)).state, "succeeded");
});

test("failed shared mutation restores its savepoint without discarding unrelated caller writes", async t => {
  const env = await setup(t);
  env.db.exec(`CREATE TABLE caller_records(value TEXT);
    CREATE TRIGGER fail_receipt BEFORE INSERT ON workflow_executor_receipts
    BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END; BEGIN IMMEDIATE;
    INSERT INTO caller_records VALUES('keep');`);
  assert.throws(() => mutateWorkflowExecutor(env.host, { operation: "workflow.executor.create", actorId: "actor", args: args() }), /receipt unavailable/);
  assert.equal(env.db.prepare("SELECT count(*) AS n FROM workflow_executor_runs").get().n, 0);
  assert.equal(env.db.prepare("SELECT count(*) AS n FROM workflow_executor_events").get().n, 0);
  env.db.exec("COMMIT");
  assert.equal(env.db.prepare("SELECT value FROM caller_records").get().value, "keep");
});

test("two native hosts execute independent ready nodes once and retain each authoritative result across run CAS advances", async t => {
  const firstStarted = deferred(), secondStarted = deferred(), releaseFirst = deferred(), releaseSecond = deferred();
  const calls = [];
  const execute = async invocation => {
    calls.push(invocation.node.nodeId);
    if (invocation.node.nodeId === "first") { firstStarted.resolve(); return releaseFirst.promise; }
    if (invocation.node.nodeId === "second") { secondStarted.resolve(); return releaseSecond.promise; }
    return { status: "succeeded", outputs: { value: 3 } };
  };
  const env = await setup(t, execute, 1000), other = env.other();
  const value = fixture([
    node("first"), node("second"), node("join", [
      { from: "first", accept: ["succeeded"], required: true },
      { from: "second", accept: ["succeeded"], required: true },
    ]),
  ]);
  env.host.create("actor", args(value));
  const first = env.host.tick("actor", "test-run"); await firstStarted.promise;
  const second = other.tick("actor", "test-run"); await secondStarted.promise;
  releaseSecond.resolve({ status: "succeeded", outputs: { value: 2 } }); await second;
  releaseFirst.resolve({ status: "succeeded", outputs: { value: 1 } }); await first;
  assert.equal((await drain(other)).state, "succeeded");
  assert.deepEqual(calls, ["first", "second", "join"]);
  assert.deepEqual(other.get("actor", "test-run").nodes.map(item => item.outputs.value), [1, 3, 2]);
});

test("native authorization binds actor, executable digest and exact Recipe source; pinned definitions survive source edits", async t => {
  const env = await setup(t);
  const policy = { ...adapter(), authorizeDefinition: binding => binding.actorId === "actor"
    && binding.executableDigest === dag.executableDigest && binding.source.kind === "recipe"
    && binding.source.recipeId === "fixture_recipe" && binding.source.revision === 3 };
  const host = env.other({ adapters: { [key]: policy } });
  assert.throws(() => host.create("actor", args()), /exact actor\/definition\/source/);
  const recipe = {
    schema: "pkm.knowledge/v1",
    knowledgeId: `knowledge_${createHash("sha256").update("fixture_recipe").digest("hex").slice(0, 24)}`,
    aliases: ["recipe:fixture_recipe"], recipeId: "fixture_recipe", scope: "global", name: "Fixture",
    description: "", revision: 3, definition: dag.definition, executableDigest: dag.executableDigest, category: "",
  };
  const directory = resolve(env.root, "recipes", "Uncategorized");
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, "Fixture.fixture_recipe.json");
  await writeFile(file, JSON.stringify(recipe));
  const source = { kind: "recipe", recipeId: recipe.recipeId, expectedRevision: 3, expectedExecutableDigest: dag.executableDigest };
  const request = args(dag, "pinned-recipe", { source });
  const created = host.create("actor", request);
  assert.equal(created.source.revision, 3);
  assert.match(created.source.snapshotRevision, /^[a-f0-9]{64}$/);
  assert.throws(() => host.create("intruder", { ...request, operationId: randomUUID(), runId: "intruder-run" }), /exact actor\/definition\/source/);
  await writeFile(file, JSON.stringify({ ...recipe, revision: 4, definition: { broken: true } }));
  assert.equal((await drain(host, "pinned-recipe")).state, "succeeded");
});

test("dependency output ports and native output contracts remain pinned end to end", async t => {
  const observed = [];
  const env = await setup(t, async invocation => {
    observed.push(invocation.inputs);
    return { status: "succeeded", outputs: { value: 7 } };
  });
  const value = fixture([
    node("producer", [], { ports: { inputs: [], outputs: ["value"] } }),
    node("consumer", [{ from: "producer", accept: ["succeeded"], required: true, fromOutput: "value", toInput: "payload" }],
      { ports: { inputs: ["payload"], outputs: ["value"] } }),
  ]);
  env.host.create("actor", args(value));
  assert.equal((await drain(env.host)).state, "succeeded");
  assert.deepEqual(observed, [{}, { payload: 7 }]);
});

test("closed host fences in-flight work durably and never closes the caller's database", async t => {
  const started = deferred(), release = deferred();
  const env = await setup(t, async () => { started.resolve(); return release.promise; });
  env.host.create("actor", args());
  const pending = env.host.tick("actor", "test-run"); await started.promise;
  env.host.close();
  await pending;
  release.resolve({ status: "succeeded", outputs: { value: 1 } });
  const second = env.other();
  assert.equal(second.get("actor", "test-run").state, "unknown");
  assert.equal(env.db.prepare("SELECT 1 AS n").get().n, 1);
  assert.throws(() => env.host.get("actor", "test-run"), /closed/);
});

test("adapter timeout closes unknown even when native work ignores abort; late work is never replayed", async t => {
  const release = deferred();
  let effects = 0;
  const env = await setup(t, async () => { effects++; return release.promise; }, 10);
  env.host.create("actor", args());
  const result = await env.host.tick("actor", "test-run");
  assert.equal(result.state, "unknown");
  release.resolve({ status: "succeeded", outputs: { value: 1 } });
  assert.equal((await env.host.tick("actor", "test-run")).state, "unknown");
  assert.equal(effects, 1);
});

test("unsupported controls and oversized outputs fail closed, deadline prevents dispatch", async t => {
  const env = await setup(t, async () => ({ status: "succeeded", outputs: { value: "x".repeat(70_000) } }));
  env.host.create("actor", args());
  assert.equal((await env.host.tick("actor", "test-run")).state, "unknown");
  const tooMany = fixture([node("repeat", [], { control: { mode: "repeat", count: { kind: "fixed", value: 65 } } })]);
  assert.throws(() => env.host.create("actor", args(tooMany, "too-many")), /unqualified/);
  env.host.create("actor", args(dag, "expired"));
  env.now(10_001);
  const expired = await env.host.tick("actor", "expired");
  assert.equal(expired.state, "failed"); assert.equal(expired.steps, 0);
});

test("source capture records real original source and regression roots, exact hashes and limited qualification", async () => {
  const { checkNativeRecords, readOriginalSource } = await import("../scripts/migration.mjs");
  const server = resolve(import.meta.dirname, ".."), root = resolve(server, "legacy");
  const provenance = JSON.parse(await readFile(resolve(server, "migration/workflow-executor-provenance.json"), "utf8"));
  const hash = value => createHash("sha256").update(value).digest("hex");
  assert.equal(provenance.qualification, "bounded-native-injected-executor-not-full-scheduler-parity");
  for (const file of provenance.files) {
    assert.equal(hash(await readOriginalSource(file.source, {
      sha256: file.sourceSha256, dataset: "runtime-workflow-executor-historical",
    })), file.sourceSha256);
    assert.equal(hash(await readFile(resolve(server, file.captured))), file.capturedSha256);
  }
  for (const file of provenance.dependencies) assert.equal(hash(await readFile(resolve(root, file.source))), file.sourceSha256);
  assert.deepEqual(await checkNativeRecords(provenance.native), []);
  const capture = spawnSync(process.execPath, ["scripts/capture-workflow-executor.mjs", "--check"], {
    cwd: server, encoding: "utf8",
  });
  assert.equal(capture.status, 0, capture.stderr || capture.stdout);
});
