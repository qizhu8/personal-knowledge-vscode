import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { initializeWorkflowRuntime, mutateWorkflowRuntime, readWorkflowRuntime, advanceWorkflowNoop } from "../dist/workflow-runtime.js";
import { workflowRuntimeDefinitions } from "../dist/workflow-runtime-contracts.js";
import { readWorkflowCompiler } from "../dist/workflow-compiler.js";
import { decideBranch, createLoop, beginLoopIteration, recordLoopOutput, resolveMerge } from "../dist/domain/workflow-runtime-control.js";
import { workflowRuntimeTransportFixtures } from "./workflow-runtime-fixtures.mjs";

const noop = (nodeId, from) => ({ nodeId, kind: "pkm.step.noop/v1", config: {},
  dependsOn: from ? [{ from, accept: ["succeeded"], required: true }] : [] });
const definition = (nodes = [noop("first"), noop("second", "first")]) => ({
  schema: "pkm.workflow.definition/v1",
  spec: { inputs: {}, outputs: {}, nodes, completion: { requiredNodes: nodes.map(node => node.nodeId) } },
});
const error = (action, code) => assert.throws(action, value => value.code === code);
function fixture(t) {
  const directory = resolve("tests", `.workflow-runtime-${randomUUID()}`);
  mkdirSync(directory);
  let db = new DatabaseSync(resolve(directory, "state.sqlite"));
  initializeWorkflowRuntime(db);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const tx = action => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const request = (operation, args, actorId = "alice") => ({ operation, args, actorId });
  const mutation = (operation, args, actorId) => tx(() =>
    mutateWorkflowRuntime(directory, db, request(operation, args, actorId)));
  const read = (operation, args, actorId) => readWorkflowRuntime(db, request(operation, args, actorId));
  const create = (model = definition(), runId = "run-one", actorId = "alice") => {
    const source = { kind: "inline", definition: model };
    const compiled = readWorkflowCompiler(directory, { operation: "workflow.definition.compile", args: { source } });
    assert.equal(compiled.status, "valid");
    const args = { operationId: randomUUID(), runId, source, expectedExecutableDigest: compiled.executableDigest, deadline: 100 };
    return { args, run: mutation("workflow.run.create", args, actorId) };
  };
  const step = (run, nodeId, overrides = {}) => {
    const input = { actorId: "alice", operationId: randomUUID(), runId: run.runId,
      expectedVersion: run.version, nodeId, now: 50, ...overrides };
    return { input, run: tx(() => advanceWorkflowNoop(db, input)) };
  };
  return { directory, tx, create, mutation, read, step, get db() { return db; },
    reopen() { db.close(); db = new DatabaseSync(resolve(directory, "state.sqlite")); initializeWorkflowRuntime(db); } };
}
test("durable pinning, dependency order, atomic step receipts, actor scope, terminal recovery", t => {
  const f = fixture(t);
  const created = f.create();
  assert.equal(created.run.state, "ready");
  assert.equal(created.run.execution, "host-only-noop");
  assert.deepEqual(f.mutation("workflow.run.create", created.args), created.run);
  assert.deepEqual(f.mutation("workflow.run.create", created.args, "charlie"), created.run);
  const changed = structuredClone(created.args);
  changed.source.definition.spec.nodes[0].generalInstruction = "changed";
  error(() => f.mutation("workflow.run.create", changed), "CONFLICT");
  error(() => f.read("workflow.run.get", { runId: created.run.runId }, "bob"), "NOT_FOUND");
  f.create(definition(), "run-one", "bob");
  assert.deepEqual(f.read("workflow.run.ready-nodes", { runId: "run-one", expectedVersion: created.run.version }).nodes, ["first"]);
  error(() => f.step(created.run, "second"), "CONFLICT");
  const first = f.step(created.run, "first");
  assert.equal(first.run.nodes[0].state, "succeeded");
  f.reopen();
  assert.deepEqual(f.tx(() => advanceWorkflowNoop(f.db, first.input)), first.run);
  assert.deepEqual(f.read("workflow.run.ready-nodes", { runId: "run-one", expectedVersion: first.run.version }).nodes, ["second"]);
  error(() => f.step(created.run, "second"), "CONFLICT");
  error(() => f.step(first.run, "first"), "CONFLICT");
  const second = f.step(first.run, "second");
  assert.equal(second.run.state, "succeeded");
  f.reopen();
  assert.deepEqual(f.read("workflow.run.get", { runId: "run-one" }), second.run);
  error(() => f.mutation("workflow.run.cancel", {
    runId: "run-one", operationId: randomUUID(), expectedVersion: second.run.version,
  }), "CONFLICT");
  assert.equal(f.read("workflow.run.get", { runId: "run-one" }, "bob").state, "ready");
  const page = f.read("workflow.run.events", { runId: "run-one", expectedVersion: second.run.version, after: 0, limit: 2 });
  assert.deepEqual(page.items.map(item => item.kind), ["created", "step-result"]);
  assert.equal(page.nextAfter, 2);
  const next = f.read("workflow.run.events", { runId: "run-one", expectedVersion: second.run.version, after: 2, limit: 2 });
  assert.deepEqual(next.items.map(item => item.sequence), [3]);
  assert.equal(next.nextAfter, null);
});
test("cancelled and failed runs reopen; rollback includes events and both receipts", t => {
  const f = fixture(t);
  let { run } = f.create();
  const args = { runId: run.runId, operationId: randomUUID(), expectedVersion: run.version };
  run = f.mutation("workflow.run.cancel", args);
  f.reopen();
  assert.deepEqual(f.mutation("workflow.run.cancel", args), run);
  assert.equal(run.state, "cancelled");
  assert.ok(run.nodes.every(node => node.state === "cancelled"));
  error(() => f.step(run, "first"), "CONFLICT");
  const expired = f.create(definition(), "expired");
  const failed = f.step(expired.run, "first", { now: 101 }).run;
  assert.equal(failed.state, "failed");
  f.reopen();
  assert.equal(f.read("workflow.run.get", { runId: "expired" }).state, "failed");
  const before = f.db.prepare("SELECT count(*) AS n FROM workflow_runtime_receipts").get().n;
  const rolled = f.create(definition(), "rolled");
  f.db.exec("CREATE TABLE parent_operation_receipts (operation_id TEXT PRIMARY KEY)");
  const input = { actorId: "alice", operationId: randomUUID(), runId: "rolled",
    expectedVersion: rolled.run.version, nodeId: "first", now: 50 };
  assert.throws(() => f.tx(() => {
    advanceWorkflowNoop(f.db, input);
    f.db.prepare("INSERT INTO parent_operation_receipts VALUES(?)").run(input.operationId);
    throw new Error("simulate parent receipt/commit failure");
  }));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM parent_operation_receipts").get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM workflow_runtime_receipts").get().n, before + 1);
  assert.deepEqual(f.read("workflow.run.get", { runId: "rolled" }), rolled.run);
  assert.equal(f.tx(() => advanceWorkflowNoop(f.db, input)).nodes[0].state, "succeeded");
});
test("non-noop/control definitions never execute, exact digests checked, no public forged results", t => {
  const f = fixture(t);
  const branch = definition([{ ...noop("branch"), ports: { inputs: [], outputs: ["yes", "no"] },
    control: { mode: "branch", kind: "if", cases: ["yes", "no"] } }]);
  const blocked = f.create(branch);
  assert.equal(blocked.run.state, "blocked");
  assert.deepEqual(f.read("workflow.run.ready-nodes", { runId: blocked.run.runId, expectedVersion: blocked.run.version }).nodes, []);
  error(() => f.step(blocked.run, "branch"), "CONFLICT");
  assert.equal(f.mutation("workflow.run.cancel", { runId: blocked.run.runId,
    operationId: randomUUID(), expectedVersion: blocked.run.version }).state, "cancelled");
  const wrong = { ...blocked.args, runId: "wrong", operationId: randomUUID(), expectedExecutableDigest: "0".repeat(64) };
  error(() => f.mutation("workflow.run.create", wrong), "CONFLICT");
  assert.ok(!workflowRuntimeDefinitions.some(item => /step|result|resume|execute/.test(item.id)));
  error(() => mutateWorkflowRuntime(f.directory, f.db, { actorId: "alice", operation: "workflow.run.create", args: wrong }), "INVALID_ARGUMENT");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM workflow_runtime_runs WHERE run_id='wrong'").get().n, 0);
  const loop = definition([{ ...noop("loop"), dependsOn: [{
    from: "loop", accept: ["succeeded"], required: true,
    loop: { termination: { condition: "done", maxIterations: 2 } },
  }] }]);
  const loopRun = f.create(loop, "bounded-loop").run;
  assert.equal(loopRun.state, "blocked");
  assert.deepEqual(f.read("workflow.run.ready-nodes", { runId: loopRun.runId, expectedVersion: loopRun.version }).nodes, []);
  const before = f.read("workflow.run.get", { runId: "bounded-loop" });
  loop.spec.nodes[0].dependsOn[0].loop.termination.maxIterations = 3;
  assert.deepEqual(f.read("workflow.run.get", { runId: "bounded-loop" }), before);
});
test("separate SQLite handles enforce shared CAS and no duplicate completion", t => {
  const f = fixture(t), { run } = f.create();
  const other = new DatabaseSync(resolve(f.directory, "state.sqlite"));
  try {
    const stale = readWorkflowRuntime(other, { actorId: "alice", operation: "workflow.run.get", args: { runId: run.runId } });
    const first = f.step(run, "first");
    other.exec("BEGIN IMMEDIATE");
    error(() => advanceWorkflowNoop(other, { actorId: "alice", operationId: randomUUID(),
      runId: run.runId, expectedVersion: stale.version, nodeId: "first", now: 50 }), "CONFLICT");
    other.exec("ROLLBACK");
    assert.equal(first.run.nodes.filter(node => node.attemptId).length, 1);
  } finally { other.close(); }
});
test("original branch priority/default/merge and transactional loop budgets remain pure", () => {
  const paths = [
    { id: "z", priority: 1, when: { kind: "literal", value: true } },
    { id: "a", priority: 1, when: { kind: "literal", value: true } },
  ];
  assert.deepEqual(decideBranch("exclusive", paths, "fallback", {}, { commandId: "c", fingerprint: "f" }).selected, ["a"]);
  assert.deepEqual(decideBranch("multi", paths, undefined, {}, { commandId: "c", fingerprint: "f" }).selected, ["a", "z"]);
  assert.equal(decideBranch("exclusive", [], "fallback", {}, { commandId: "c", fingerprint: "f" }).defaultSelected, true);
  assert.equal(resolveMerge("exclusive", [{ pathId: "a", state: "completed" }, { pathId: "z", state: "not-selected" }]).ready, true);
  let loop = createLoop(2, "fail");
  const command = (commandId, expectedVersion = loop.version) => ({ commandId, expectedVersion, fingerprint: commandId });
  const firstCommand = command("first");
  let result = beginLoopIteration(loop, firstCommand);
  loop = result.loop;
  assert.equal(result.index, 0);
  assert.equal(beginLoopIteration(loop, firstCommand).replayed, true);
  loop = recordLoopOutput(loop, command("output"), 0, "value").loop;
  error(() => recordLoopOutput(loop, command("duplicate"), 0, "again"), "loop-output-duplicate");
  loop = beginLoopIteration(loop, command("second")).loop;
  result = beginLoopIteration(loop, command("limit"));
  assert.equal(result.loop.limitResult, "failed");
  error(() => beginLoopIteration(result.loop, command("closed", result.loop.version)), "loop-closed");
});
test("capture provenance points at actual reproducible files", () => {
  const manifest = JSON.parse(readFileSync(new URL("../migration/workflow-runtime-provenance.json", import.meta.url)));
  for (const file of manifest.files) {
    const hash = data => createHash("sha256").update(data).digest("hex");
    assert.equal(hash(readFileSync(new URL(`../../${file.source}`, import.meta.url))), file.sourceSha256);
    assert.equal(hash(readFileSync(new URL(`../${file.captured}`, import.meta.url))), file.capturedSha256);
  }
});
test("literal HTTP/MCP fixture sequence matches schemas and actual database dispatch", t => {
  const f = fixture(t);
  for (const fixture of workflowRuntimeTransportFixtures) {
    const descriptor = workflowRuntimeDefinitions.find(item => item.id === fixture.operation);
    descriptor.input.parse(fixture.args);
    descriptor.output.parse(fixture.result);
    const result = descriptor.readOnly ? f.read(fixture.operation, fixture.args)
      : f.mutation(fixture.operation, fixture.args);
    assert.deepEqual(result, fixture.result);
  }
});
