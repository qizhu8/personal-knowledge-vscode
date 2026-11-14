import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { WorkflowExecutor, mutateWorkflowExecutor } from "../dist/workflow-executor.js";
import { workflowExecutorDefinitions } from "../dist/workflow-executor-contracts.js";
import {
  workflowExecutorAdapterKey as key, workflowExecutorSyntheticAdapter as adapter,
  workflowExecutorNode as node, workflowExecutorFixture as fixture, workflowExecutorDAGFixture as dag,
} from "./workflow-executor-fixtures.mjs";

async function setup(t, execute, leaseMs = 100) {
  const root = resolve(`.workflow-executor-${randomUUID()}`);
  await mkdir(root);
  const file = resolve(root, "core.sqlite"), db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000");
  let now = 1000;
  const options = { workspaceRoot: root, ownerId: "host-one", adapters: { [key]: adapter(execute) }, clock: () => now, leaseMs };
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
    ["workflow.executor.create", "workflow.executor.get", "workflow.executor.cancel"]);
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
  const server = resolve(import.meta.dirname, ".."), root = resolve(server, "..");
  const provenance = JSON.parse(await readFile(resolve(server, "migration/workflow-executor-provenance.json"), "utf8"));
  const hash = value => createHash("sha256").update(value).digest("hex");
  assert.equal(provenance.qualification, "bounded-native-injected-executor-not-full-scheduler-parity");
  for (const file of provenance.files) {
    assert.equal(hash(await readFile(resolve(root, file.source))), file.sourceSha256);
    assert.equal(hash(await readFile(resolve(server, file.captured))), file.capturedSha256);
  }
  for (const file of provenance.dependencies) assert.equal(hash(await readFile(resolve(root, file.source))), file.sourceSha256);
  for (const file of provenance.native) assert.equal(hash(await readFile(resolve(server, file.file))), file.sha256);
  const capture = spawnSync(process.execPath, ["scripts/capture-workflow-executor.mjs", "--check"], {
    cwd: server, encoding: "utf8",
  });
  assert.equal(capture.status, 0, capture.stderr || capture.stdout);
});
