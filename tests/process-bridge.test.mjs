import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createProcessBridge } from "../dist/process-bridge.js";
import { WorkflowExecutor, mutateWorkflowExecutor } from "../dist/workflow-executor.js";
import { compileWorkflowDefinitionV1 } from "../dist/domain/project-recipes-workflow-contracts.js";

const hash = text => createHash("sha256").update(text).digest("hex");
const key = "pkm.step.command/v1";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await delay(5); }
  throw new Error("Timed out waiting for fixture.");
}
function setup(t, overrides = {}) {
  const { group = false, leaseMs = 5000, ...policy } = overrides;
  const baseline = process.getActiveResourcesInfo().filter(value => value === "ProcessWrap").length;
  const root = resolve("tests", `.process-bridge-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const script = resolve(root, "fixture.mjs");
  writeFileSync(script, `
const mode = process.argv[2];
if (mode === "ok") console.log(JSON.stringify({ value: 42 }));
if (mode === "bad") console.log(JSON.stringify({ value: "invalid" }));
if (mode === "fail") process.exitCode = 4;
if (mode === "hang") { process.stdout.write("started"); setInterval(() => {}, 1000); }
if (mode === "stderr") { process.stderr.write("not-public"); console.log(JSON.stringify({value: 42})); }
if (mode === "stdin") { let s = ""; for await (const chunk of process.stdin) s += chunk; console.log(JSON.stringify({value: 42, secret:s})); }
if (mode === "bulk") console.log(JSON.stringify({value: 42, data:"a".repeat(2000)}));
if (mode === "tree" || mode === "tree-finish") {
  const { spawn } = await import("node:child_process");
  const { appendFileSync } = await import("node:fs");
  spawn(process.execPath, ["-e", "setInterval(()=>require('fs').appendFileSync('ticks-child','x'),20)"], {stdio:"ignore"});
  setInterval(() => appendFileSync("ticks-parent", "x"), 20);
  if (mode === "tree-finish") setTimeout(() => { console.log(JSON.stringify({ value: 42 })); process.exit(0); }, 800);
}
`);
  const database = new DatabaseSync(resolve(root, "store.sqlite"));
  const approvals = [];
  const options = {
    database, workspaceRoot: root, adapterId: "command-bridge", version: 1,
    outputContractDigest: hash("number output"), authorizationDigest: hash("policy"),
    commands: [{ id: "fixture", executable: process.execPath, cwd: root, directChildOnly: !group,
      ...(group ? { processScope: "linux-process-group" } : {}),
      arguments: [{ literal: script }, { pattern: /^(ok|bad|fail|hang|stderr|stdin|bulk|tree|tree-finish)$/, maxBytes: 16 }],
      output: z.strictObject({ value: z.number().int() }) }],
    authorizeDefinition: binding => binding.actorId === "alice" && binding.source.kind === "inline",
    authorizeData: ({ inputs, source }) => !JSON.stringify({ inputs, source }).includes("sensitive-example"),
    redactOutput: output => ({ value: output.value }),
    resolveStdin: async () => undefined,
    approve: async request => { approvals.push(request); return true; },
    limits: { graceMs: 30, closeDrainMs: 100 },
    ...policy,
  };
  const bridge = createProcessBridge(options);
  const executor = new WorkflowExecutor(database, { workspaceRoot: root, ownerId: "test-owner", adapters: { [key]: bridge.adapter }, leaseMs });
  t.after(async () => {
    executor.close();
    await bridge.close();
    await until(() => process.getActiveResourcesInfo().filter(value => value === "ProcessWrap").length <= baseline);
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  function create(mode, extra = {}, inputs = {}, descriptors = {}) {
    const node = { nodeId: "step", kind: key, config: { program: "fixture", args: [script, mode],
      timeoutSeconds: 1, maxOutputBytes: 1024, ...extra }, dependsOn: [] };
    const definition = { schema: "pkm.workflow.definition/v1", spec: { inputs: descriptors, outputs: {}, nodes: [node], completion: { requiredNodes: ["step"] } } };
    const compiled = compileWorkflowDefinitionV1(definition);
    assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
    const runId = `run-${randomUUID()}`;
    executor.create("alice", { operationId: randomUUID(), runId, source: { kind: "inline", definition },
      expectedExecutableDigest: compiled.executableDigest, deadline: Date.now() + 10_000, inputs });
    return { runId, digest: compiled.executableDigest, node };
  }
  return { root, script, database, bridge, executor, approvals, create };
}

test("configured command executes through durable workflow and validates output", async t => {
  const f = setup(t), run = f.create("ok");
  const result = await f.executor.tick("alice", run.runId);
  assert.equal(result.state, "succeeded");
  assert.deepEqual(result.nodes[0].outputs, { value: 42 });
  assert.equal(f.approvals.length, 1);
  assert.deepEqual({ ...f.approvals[0], invocationId: undefined }, {
    actorId: "alice", executableDigest: run.digest, nodeId: "step", invocationId: undefined,
    commandId: "fixture", arguments: [f.script, "ok"],
  });
  const job = JSON.parse(f.database.prepare("SELECT record_json FROM runtime_process_jobs").get().record_json);
  assert.equal(job.state, "SUCCEEDED"); assert.equal(job.effect, "completed");
  assert.equal(f.database.prepare("SELECT count(*) n FROM workflow_executor_events WHERE kind='start-intent'").get().n, 1);
  assert.equal((await f.executor.tick("alice", run.runId)).state, "succeeded");
  assert.equal(f.approvals.length, 1);
});

test("invalid outputs are unknown; nonzero exit is failed; stderr is never retained", async t => {
  const f = setup(t);
  for (const [mode, state] of [["bad", "unknown"], ["fail", "failed"], ["stderr", "succeeded"]]) {
    const run = f.create(mode);
    const result = await f.executor.tick("alice", run.runId);
    assert.equal(result.state, state);
  }
  const records = f.database.prepare("SELECT record_json FROM runtime_process_jobs").all().map(row => JSON.parse(row.record_json));
  assert(records.every(record => record.stderr === ""));
  assert.equal(records.find(record => record.stderrBytes > 0).stderrDroppedBytes, 10);
});

test("arguments and working directory cannot escape host configuration", async t => {
  const f = setup(t);
  assert.throws(() => f.create("ok\n"), /denied/);
  assert.throws(() => f.create("ok", { cwd: f.root }), /denied/);
  assert.equal(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 0);
});

test("timeout and cancellation stop the owned child; effects remain unknown", async t => {
  const f = setup(t);
  const timeout = f.create("hang");
  const timed = await f.executor.tick("alice", timeout.runId);
  assert.equal(timed.state, "unknown");
  await until(() => f.database.prepare("SELECT state FROM runtime_process_jobs").get().state !== "RUNNING");
  assert.equal(JSON.parse(f.database.prepare("SELECT record_json FROM runtime_process_jobs").get().record_json).state, "TIMED_OUT");
  const cancelled = f.create("hang");
  const tick = f.executor.tick("alice", cancelled.runId);
  await until(() => Number(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs WHERE state='RUNNING'").get().n) === 1);
  const current = f.executor.get("alice", cancelled.runId);
  f.executor.cancel("alice", { runId: cancelled.runId, expectedVersion: current.version, operationId: randomUUID() });
  assert.equal((await tick).state, "cancelled");
  await until(() => Number(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs WHERE state='RUNNING'").get().n) === 0);
  const job = JSON.parse(f.database.prepare("SELECT record_json FROM runtime_process_jobs ORDER BY rowid DESC").get().record_json);
  assert.equal(job.state, "CANCELLED"); assert.equal(job.effect, "unknown");
});

test("native workflow bridge controls only its actor's opted-in Linux process group", { skip: process.platform !== "linux" }, async t => {
  const f = setup(t, { group: true }), run = f.create("tree", { timeoutSeconds: 3 });
  const tick = f.executor.tick("alice", run.runId);
  const parent = resolve(f.root, "ticks-parent"), child = resolve(f.root, "ticks-child");
  await until(() => existsSync(parent) && existsSync(child));
  assert.equal(f.approvals[0].processScope, "linux-process-group");
  await assert.rejects(f.bridge.pause("bob", run.runId), /owned process/);
  await f.bridge.pause("alice", run.runId);
  await delay(50);
  const before = [readFileSync(parent).length, readFileSync(child).length];
  await delay(150);
  assert.deepEqual([readFileSync(parent).length, readFileSync(child).length], before);
  await f.bridge.resume("alice", run.runId);
  await until(() => readFileSync(parent).length > before[0] && readFileSync(child).length > before[1]);
  const current = f.executor.get("alice", run.runId);
  f.executor.cancel("alice", { runId: run.runId, expectedVersion: current.version, operationId: randomUUID() });
  assert.equal((await tick).state, "cancelled");
  await until(() => ["CANCELLED", "INTERRUPTED"].includes(f.database.prepare("SELECT state FROM runtime_process_jobs").get().state));
  const after = [readFileSync(parent).length, readFileSync(child).length];
  await delay(80);
  assert.deepEqual([readFileSync(parent).length, readFileSync(child).length], after);
});

test("workflow process active timeout excludes a group pause while its absolute lease remains valid", { skip: process.platform !== "linux" }, async t => {
  const f = setup(t, { group: true }), run = f.create("tree-finish");
  const tick = f.executor.tick("alice", run.runId);
  await until(() => existsSync(resolve(f.root, "ticks-child")));
  await f.bridge.pause("alice", run.runId);
  await delay(1200);
  assert.equal(f.database.prepare("SELECT state FROM runtime_process_jobs").get().state, "PAUSED");
  await f.bridge.resume("alice", run.runId);
  const result = await tick;
  assert.equal(result.state, "succeeded");
  assert.deepEqual(result.nodes[0].outputs, { value: 42 });
});

test("paused process cannot outlive an absolute workflow lease or report success", { skip: process.platform !== "linux" }, async t => {
  const f = setup(t, { group: true, leaseMs: 1000 }), run = f.create("tree", { timeoutSeconds: 3 });
  const tick = f.executor.tick("alice", run.runId);
  await until(() => existsSync(resolve(f.root, "ticks-child")));
  await f.bridge.pause("alice", run.runId);
  assert.equal((await tick).state, "unknown");
  await until(() => ["CANCELLED", "TIMED_OUT", "INTERRUPTED"].includes(f.database.prepare("SELECT state FROM runtime_process_jobs").get().state));
});

test("approval denial cannot launch; persisted output and events omit stderr", async t => {
  const f = setup(t, { approve: async () => false });
  const run = f.create("ok");
  assert.equal((await f.executor.tick("alice", run.runId)).state, "unknown");
  assert.equal(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 0);
});

test("cancellation during asynchronous approval prevents later admission", async t => {
  let release, requested = false;
  const approval = new Promise(resolve => { release = resolve; });
  const f = setup(t, { approve: async () => { requested = true; return approval; } });
  const run = f.create("ok");
  const tick = f.executor.tick("alice", run.runId);
  await until(() => requested);
  const current = f.executor.get("alice", run.runId);
  f.executor.cancel("alice", { runId: run.runId, expectedVersion: current.version, operationId: randomUUID() });
  assert.equal((await tick).state, "cancelled");
  release(true);
  await delay(30);
  assert.equal(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 0);
});

test("shutdown does not wait indefinitely for an unresolved approval", async t => {
  let requested = false;
  const f = setup(t, { approve: async () => { requested = true; return new Promise(() => {}); } });
  const run = f.create("ok");
  const tick = f.executor.tick("alice", run.runId);
  await until(() => requested);
  await f.bridge.close();
  assert.equal((await tick).state, "unknown");
  assert.equal(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 0);
});

test("native stdin and raw process output stay out of durable stores; only policy-redacted outputs persist", async t => {
  const secret = "sensitive-example";
  const f = setup(t, { resolveStdin: async () => Buffer.from(secret) });
  const run = f.create("stdin");
  assert.equal((await f.executor.tick("alice", run.runId)).state, "succeeded");
  const job = JSON.parse(f.database.prepare("SELECT record_json FROM runtime_process_jobs").get().record_json);
  assert.equal(job.stdout, "");
  const tables = ["runtime_process_jobs", "runtime_process_events", "workflow_executor_runs", "workflow_executor_events", "workflow_executor_assignments", "workflow_executor_receipts"];
  for (const table of tables) for (const row of f.database.prepare(`SELECT * FROM ${table}`).all()) {
    assert(!JSON.stringify(row).includes(secret), table);
    assert(!JSON.stringify(row).includes(Buffer.from(secret).toString("base64")), table);
  }
});

test("bridge denies workflow data unless explicit policy permits persistence", async t => {
  const f = setup(t, { authorizeData: () => false });
  assert.throws(() => f.create("ok"), /denied/i);
  assert.equal(f.database.prepare("SELECT count(*) n FROM workflow_executor_runs").get().n, 0);
  assert.equal(f.database.prepare("SELECT count(*) n FROM workflow_executor_receipts").get().n, 0);
});

test("missing data or output policy is denied before repository ownership", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const config = { database, workspaceRoot: process.cwd(), commands: [], adapterId: "bridge", version: 1,
      outputContractDigest: hash("out"), authorizationDigest: hash("auth"), authorizeDefinition: () => true, approve: async () => true };
    assert.throws(() => createProcessBridge(config), /data policies/i);
    assert.throws(() => createProcessBridge({ ...config, authorizeData: () => true }), /data policies/i);
  } finally { database.close(); }
});

test("sensitive workflow input is denied before snapshots and receipts", async t => {
  const f = setup(t);
  assert.throws(() => f.create("ok", {}, { token: "sensitive-example" },
    { token: { type: "string", required: true, nullable: false, schema: {} } }), /denied/i);
  assert.equal(f.database.prepare("SELECT count(*) n FROM workflow_executor_runs").get().n, 0);
  assert.equal(f.database.prepare("SELECT count(*) n FROM workflow_executor_receipts").get().n, 0);
});

test("policy can reject a candidate output before any workflow record retains it", async t => {
  const f = setup(t, { authorizeData: binding => !binding.candidate || binding.candidate.outputs.value !== 42 });
  const run = f.create("ok");
  assert.equal((await f.executor.tick("alice", run.runId)).state, "unknown");
  assert.deepEqual(f.executor.get("alice", run.runId).nodes[0].outputs, {});
  const snapshots = f.database.prepare("SELECT snapshot FROM workflow_executor_runs").all();
  assert(!JSON.stringify(snapshots).includes('\\"value\\":42'));
});

test("oversized stdin and redacted or truncated outputs cannot produce success", async t => {
  const f = setup(t, { resolveStdin: async request => request.arguments.at(-1) === "stdin" ? Buffer.alloc(20_000) : undefined });
  let run = f.create("stdin");
  assert.equal((await f.executor.tick("alice", run.runId)).state, "unknown");
  assert.equal(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 0);
  run = f.create("bulk");
  assert.equal((await f.executor.tick("alice", run.runId)).state, "unknown");
  assert.deepEqual(f.executor.get("alice", run.runId).nodes[0].outputs, {});
});

test("cancellation during stdin resolution prevents launch", async t => {
  let requested = false;
  const f = setup(t, { resolveStdin: async () => { requested = true; return new Promise(() => {}); } });
  const run = f.create("stdin");
  const tick = f.executor.tick("alice", run.runId);
  await until(() => requested);
  const current = f.executor.get("alice", run.runId);
  f.executor.cancel("alice", { runId: run.runId, expectedVersion: current.version, operationId: randomUUID() });
  assert.equal((await tick).state, "cancelled");
  assert.equal(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 0);
});

test("cancellation reaps a child that does not consume bounded stdin", async t => {
  const f = setup(t, { resolveStdin: async () => Buffer.alloc(16_384, 120) });
  const run = f.create("hang");
  const tick = f.executor.tick("alice", run.runId);
  await until(() => Number(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs WHERE state='RUNNING'").get().n) === 1);
  const current = f.executor.get("alice", run.runId);
  f.executor.cancel("alice", { runId: run.runId, expectedVersion: current.version, operationId: randomUUID() });
  assert.equal((await tick).state, "cancelled");
  await until(() => f.database.prepare("SELECT state FROM runtime_process_jobs").get().state === "CANCELLED");
});

test("transactional cancel aborts only after commit and reaps live child", async t => {
  const f = setup(t);
  const run = f.create("hang");
  const tick = f.executor.tick("alice", run.runId);
  await until(() => Number(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs WHERE state='RUNNING'").get().n) === 1);
  const current = f.executor.get("alice", run.runId);
  const args = { runId: run.runId, expectedVersion: current.version, operationId: randomUUID() };
  f.database.exec("BEGIN IMMEDIATE");
  mutateWorkflowExecutor(f.executor, { operation: "workflow.executor.cancel", actorId: "alice", args });
  f.database.exec("ROLLBACK");
  await delay(60);
  assert.equal(f.database.prepare("SELECT state FROM runtime_process_jobs").get().state, "RUNNING");
  f.database.exec("BEGIN IMMEDIATE");
  mutateWorkflowExecutor(f.executor, { operation: "workflow.executor.cancel", actorId: "alice", args });
  f.database.exec("COMMIT");
  assert.equal((await tick).state, "cancelled");
  await until(() => f.database.prepare("SELECT state FROM runtime_process_jobs").get().state === "CANCELLED");
});

test("failed command with declared output ports remains deterministically failed", async t => {
  const f = setup(t);
  const node = { nodeId: "step", kind: key, config: { program: "fixture", args: [f.script, "fail"], timeoutSeconds: 1, maxOutputBytes: 1024 }, dependsOn: [], ports: { inputs: [], outputs: ["value"] } };
  const definition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {}, nodes: [node], completion: { requiredNodes: ["step"] } } };
  const compiled = compileWorkflowDefinitionV1(definition);
  f.executor.create("alice", { operationId: randomUUID(), runId: "ports", source: { kind: "inline", definition }, expectedExecutableDigest: compiled.executableDigest, deadline: Date.now() + 10000, inputs: {} });
  assert.equal((await f.executor.tick("alice", "ports")).state, "failed");
});

test("crashed host recovers running intent as unknown without replay or PID signaling", async t => {
  const root = resolve(import.meta.dirname, `.process-bridge-crash-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = resolve(root, "completed"), script = resolve(root, "child.mjs");
  writeFileSync(script, `
import { writeFileSync } from "node:fs";
setTimeout(() => { writeFileSync(process.argv[2], "finished", {flag:"wx"}); }, 300);
`);
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "process-bridge-crash.mjs"), root], {
    stdio: ["ignore", "ignore", "pipe"], env: {},
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { if (stderr.length < 65536) stderr += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 0, `Crash fixture exited ${code}; stderr: ${stderr || "(empty)"}`);
  const database = new DatabaseSync(resolve(root, "db.sqlite"));
  const previousOwnerId = database.prepare("SELECT owner_id FROM runtime_process_owner").get().owner_id;
  const bridge = createProcessBridge({
    database, workspaceRoot: root, previousOwnerId, adapterId: "bridge", version: 1,
    outputContractDigest: hash("out"), authorizationDigest: hash("auth"),
    commands: [{ id: "fixture", executable: process.execPath, cwd: root, directChildOnly: true,
      arguments: [{ literal: script }, { literal: marker }], output: z.strictObject({ value: z.number() }) }],
    authorizeDefinition: () => true, authorizeData: () => true, redactOutput: value => value,
    approve: async () => { throw new Error("replay attempted"); },
  });
  const executor = new WorkflowExecutor(database, { workspaceRoot: root, ownerId: "new-host", adapters: { [key]: bridge.adapter }, clock: () => Date.now() + 10_000 });
  try {
    const job = JSON.parse(database.prepare("SELECT record_json FROM runtime_process_jobs").get().record_json);
    assert.equal(job.state, "INTERRUPTED"); assert.equal(job.effect, "unknown");
    const run = executor.recover("alice", "crash-run");
    assert.equal(run.state, "unknown");
    assert.equal((await executor.tick("alice", "crash-run")).state, "unknown");
    assert.equal(database.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 1);
    await until(() => existsSync(marker));
  } finally {
    executor.close(); await bridge.close(); database.close();
  }
});
