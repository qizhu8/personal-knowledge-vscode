import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runtimeFixture, until } from "./runtime-process-fixtures.mjs";
import { runtimeProcessDefinitions, RuntimeProcessService } from "../dist/runtime-process.js";
import { runtimeProcessJob } from "../dist/runtime-process-contracts.js";

async function fixture(t, options) {
  const f = runtimeFixture(options);
  t.after(() => f.cleanup());
  return f;
}
const request = (operation, args = {}) => ({ operation: `runtime.process.${operation}`, args });
test("queued process is never spawned after its synchronous native fence is revoked", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let current = true;
  const script = resolve(f.directory, "synthetic.mjs");
  const runtime = f.service({ adapters: [{
    id: "synthetic", executable: process.execPath, cwd: f.directory,
    arguments: input => [script, input.mode, String(input.parameter ?? "")],
    assertCurrent(args) { if (!current && args[1] === "mark") throw new Error("revoked"); },
  }] });
  const running = await f.launch(runtime, "delay", 300);
  await until(() => runtime.status("alice", running.jobId).pid !== null);
  const marker = resolve(f.directory, "revoked-marker");
  const queued = await f.launch(runtime, "mark", marker);
  assert.equal(queued.state, "QUEUED");
  current = false;
  const result = await runtime.wait("alice", queued.jobId);
  assert.equal(result.state, "FAILED");
  assert.equal(result.effect, "not-started");
  assert.equal(result.reason, "spawn-error");
  assert.equal(result.pid, null);
  assert.equal(existsSync(marker), false);
});
test("exact binary stdout/stderr, durable receipt, direct-child reaping and no environment inheritance", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const runtime = f.service();
  const receipt = await f.launch(runtime);
  const job = await runtime.wait("alice", receipt.jobId);
  assert.equal(job.state, "SUCCEEDED");
  assert.equal(job.effect, "completed");
  assert.equal(job.exitCode, 0);
  assert.deepEqual([...Buffer.from(job.stdout, "base64")], [0, 255, 195, 169, 10]);
  assert.deepEqual([...Buffer.from(job.stderr, "base64")], [254, 0, 65]);
  assert.equal(job.stdoutBytes, 5);
  assert.equal(job.stderrBytes, 3);
  assert.equal(job.stdoutDroppedBytes + job.stderrDroppedBytes, 0);
  assert.equal(runtimeProcessJob.safeParse(job).success, true);
  const env = await f.launch(runtime, "env");
  const done = await runtime.wait("alice", env.jobId);
  assert.deepEqual(JSON.parse(Buffer.from(done.stdout, "base64")), []);
  await runtime.close();
  assert.equal(f.database.prepare("SELECT closed FROM runtime_process_owner").get().closed, 1);
  await assert.rejects(f.launch(runtime), { code: "CLOSED" });
});
test("per-stream byte caps discard exact excess; durable ring gaps and scoped pagination", { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: {
    concurrency: 1, queue: 2, events: 3, stdoutBytes: 11, stderrBytes: 5,
    deadlineMs: 2000, graceMs: 60, closeDrainMs: 200,
  } });
  const runtime = f.service();
  const receipt = await f.launch(runtime, "bulk", 200_000);
  const job = await runtime.wait("alice", receipt.jobId);
  assert.equal(Buffer.from(job.stdout, "base64").length, 11);
  assert.equal(Buffer.from(job.stderr, "base64").length, 5);
  assert.equal(job.stdoutBytes, 200_000);
  assert.equal(job.stderrBytes, 200_007);
  assert.equal(job.stdoutDroppedBytes, 199_989);
  assert.equal(job.stderrDroppedBytes, 200_002);
  const events = await runtime.request("alice", request("events", { jobId: job.jobId }));
  assert.equal(events.items.length, 3);
  assert.equal(events.gap, true);
  assert.equal(events.items.at(-1).kind, "finished");
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM runtime_process_events").get().n, 3);
  const page = await runtime.request("alice", request("events", { jobId: job.jobId, after: events.oldestSequence - 1, limit: 1 }));
  assert.equal(page.gap, false);
  assert.equal(page.items.length, 1);
  const list = await runtime.request("alice", request("list", { limit: 1 }));
  assert.equal(list.total, 1);
  assert.equal(list.items.length, 1);
  assert.equal((await runtime.request("bob", request("list"))).total, 0);
  for (const operation of ["status", "events", "cancel"]) {
    await assert.rejects(runtime.request("bob", request(operation, { jobId: job.jobId })), { code: "NOT_FOUND" });
  }
});
test("bounded running plus queue, queued cancel never launches, admission receipts deduplicate", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const runtime = f.service();
  const running = await f.launch(runtime, "delay", 250);
  await until(() => runtime.status("alice", running.jobId).pid !== null);
  const marker = resolve(f.directory, "must-not-exist");
  const operationId = randomUUID();
  const queued = await f.launch(runtime, "mark", marker, { operationId });
  const duplicate = await f.launch(runtime, "mark", marker, { operationId });
  assert.equal(duplicate.jobId, queued.jobId);
  const third = await f.launch(runtime, "io");
  assert.equal(third.state, "QUEUED");
  await assert.rejects(f.launch(runtime), { code: "BUSY" });
  await assert.rejects(f.launch(runtime, "io", undefined, { operationId }), { code: "OPERATION_CONFLICT" });
  const cancelled = await runtime.cancel("alice", queued.jobId);
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(cancelled.effect, "not-started");
  assert.equal(cancelled.pid, null);
  assert.equal(existsSync(marker), false);
  await runtime.wait("alice", running.jobId);
  assert.equal((await runtime.wait("alice", third.jobId)).state, "SUCCEEDED");
  assert.equal(existsSync(marker), false);
  assert.equal((await runtime.cancel("alice", queued.jobId)).state, "CANCELLED");
});
test("diagnostics expose bounded resource pressure without authority-bearing or sensitive state", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const runtime = f.service();
  const running = await f.launch(runtime, "delay", 250);
  const queued = await f.launch(runtime, "mark", resolve(f.directory, "diagnostic-marker"));
  await until(() => runtime.diagnostics().running === 1);
  const diagnostics = runtime.diagnostics();
  assert.deepEqual(diagnostics, {
    activeAdmissions: 0, queued: 1, running: 1, unconsumedCaptures: 0,
    activeJobs: 2, closed: false, persistenceUnavailable: false,
  });
  const encoded = JSON.stringify(diagnostics);
  for (const sensitive of ["alice", running.jobId, queued.jobId, f.directory, process.execPath]) {
    assert.equal(encoded.includes(sensitive), false);
  }
  assert.throws(() => { diagnostics.closed = true; }, TypeError);
  await runtime.close({ drainMs: 200 });
  assert.deepEqual(runtime.diagnostics(), {
    activeAdmissions: 0, queued: 0, running: 0, unconsumedCaptures: 0,
    activeJobs: 0, closed: true, persistenceUnavailable: false,
  });
});
test("queued deadline is absolute and never executes; running deadline escalates ignored TERM", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const runtime = f.service();
  const live = await f.launch(runtime, "ignore", undefined, { deadlineMs: 300 });
  await until(() => Buffer.from(runtime.status("alice", live.jobId).stdout, "base64").toString() === "ready");
  const marker = resolve(f.directory, "deadline-must-not-exist");
  const queued = await f.launch(runtime, "mark", marker, { deadlineMs: 30 });
  const queuedDone = await runtime.wait("alice", queued.jobId);
  assert.equal(queuedDone.state, "TIMED_OUT");
  assert.equal(queuedDone.effect, "not-started");
  assert.equal(existsSync(marker), false);
  const done = await runtime.wait("alice", live.jobId);
  assert.equal(done.state, "TIMED_OUT");
  assert.equal(done.reason, "deadline");
  assert.equal(done.effect, "unknown");
  if (process.platform !== "win32") assert.equal(done.signal, "SIGKILL");
});
test("running cancel escalates/reaps; close drains short work then cancels/reaps long work", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const runtime = f.service();
  const live = await f.launch(runtime, "ignore");
  await until(() => Buffer.from(runtime.status("alice", live.jobId).stdout, "base64").toString() === "ready");
  await runtime.cancel("alice", live.jobId);
  const cancelled = await runtime.wait("alice", live.jobId);
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(cancelled.effect, "unknown");
  const short = await f.launch(runtime, "delay", 10);
  await runtime.close({ drainMs: 200 });
  assert.equal(runtime.status("alice", short.jobId).state, "SUCCEEDED");
  const second = f.service();
  const long = await f.launch(second, "ignore");
  await until(() => second.status("alice", long.jobId).stdoutBytes > 0);
  const marker = resolve(f.directory, "shutdown-must-not-exist");
  const queue = await f.launch(second, "mark", marker);
  const closing = second.close({ drainMs: 0 });
  assert.strictEqual(second.close(), closing);
  await closing;
  assert.equal(second.status("alice", long.jobId).reason, "shutdown");
  assert.equal(second.status("alice", queue.jobId).effect, "not-started");
  assert.equal(existsSync(marker), false);
});
test("nonzero and launch failure receipts; public schemas never accept command launch or actor override", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const runtime = f.service();
  const failed = await f.launch(runtime, "exit", 7);
  const done = await runtime.wait("alice", failed.jobId);
  assert.equal(done.state, "FAILED");
  assert.equal(done.exitCode, 7);
  assert.equal(done.effect, "completed");
  await assert.rejects(runtime.request("alice", { operation: "runtime.process.launch", args: { command: "anything" } }), { code: "NOT_FOUND" });
  for (const definition of runtimeProcessDefinitions) {
    assert.equal(definition.input.safeParse({ actorId: "bob", command: "anything" }).success, false);
  }
  await runtime.close();
  const missing = f.service({ adapters: [{
    id: "synthetic", executable: process.execPath, cwd: resolve(f.directory, "absent-cwd"), arguments: () => [],
  }] });
  const spawn = await f.launch(missing);
  const spawnDone = await missing.wait("alice", spawn.jobId);
  assert.equal(spawnDone.state, "FAILED");
  assert.equal(spawnDone.reason, "spawn-error");
  assert.equal(spawnDone.effect, "not-started");
});
test("trusted authorization and explicit adapter IDs fail closed; arguments and inputs bounded", { timeout: 5000 }, async t => {
  const f = await fixture(t, { authorizeLaunch: async () => false });
  const runtime = f.service();
  await assert.rejects(f.launch(runtime), { code: "FORBIDDEN" });
  await assert.rejects(f.launch(runtime, "io", undefined, { adapterId: "unconfigured" }), { code: "ADAPTER_UNAVAILABLE" });
  await assert.rejects(f.launch(runtime, "io", "x".repeat(20_000)), { code: "INPUT_LIMIT" });
  assert.equal((await runtime.request("alice", request("list"))).total, 0);
  await runtime.close();
  const bad = f.service({ authorizeLaunch: async () => true, adapters: [{
    id: "synthetic", executable: process.execPath, cwd: f.directory, arguments: () => ["bad\0arg"],
  }] });
  await assert.rejects(f.launch(bad), { code: "ARGUMENT_LIMIT" });
});
test("async admission is bounded, deduplicated and cannot launch after shutdown", { timeout: 5000 }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { authorizeLaunch: async () => { await gate; return true; } });
  const runtime = f.service();
  const operationId = randomUUID();
  const pending = f.launch(runtime, "io", undefined, { operationId });
  const duplicate = f.launch(runtime, "io", undefined, { operationId });
  const second = f.launch(runtime);
  const third = f.launch(runtime);
  const rejected = Promise.allSettled([pending, duplicate, second, third]);
  await assert.rejects(f.launch(runtime), { code: "BUSY" });
  await runtime.close({ drainMs: 0 });
  release();
  for (const result of await rejected) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason.code, "CLOSED");
  }
  assert.equal((await runtime.request("alice", request("list"))).total, 0);
});
test("store calls reject outer transactions; duplicate ownership and stale takeover CAS rejected", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const runtime = f.service();
  assert.throws(() => f.service(), { code: "OWNERSHIP_CONFLICT" });
  assert.throws(() => f.service({ previousOwnerId: randomUUID() }), { code: "OWNERSHIP_CONFLICT" });
  f.database.exec("BEGIN");
  await assert.rejects(f.launch(runtime), { code: "TRANSACTION_BOUNDARY" });
  await assert.rejects(runtime.request("alice", request("list")), { code: "TRANSACTION_BOUNDARY" });
  f.database.exec("ROLLBACK");
  assert.equal((await runtime.request("alice", request("list"))).total, 0);
});
test("configuration caps cannot be raised or bypass trusted authorization", () => {
  const base = { repositoryFactory: () => { throw new Error("must not reach repository"); }, adapters: [], authorizeLaunch: async () => true };
  assert.throws(() => new RuntimeProcessService({ ...base, limits: { queue: 33 } }), { code: "INVALID_LIMIT" });
  assert.throws(() => new RuntimeProcessService({ ...base, authorizeLaunch: undefined }), { code: "INVALID_ADAPTER" });
  assert.throws(() => new RuntimeProcessService({ ...base, adapters: [{ id: "bad", executable: "relative", arguments: () => [] }] }), { code: "INVALID_ADAPTER" });
});
test("durable receipt capacity fails before effects and survives closed-owner reopen", { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: {
    concurrency: 1, queue: 1, jobs: 1, events: 4, deadlineMs: 2000, graceMs: 60, closeDrainMs: 200,
  } });
  const runtime = f.service();
  const operationId = randomUUID();
  const first = await f.launch(runtime, "io", undefined, { operationId });
  await runtime.wait("alice", first.jobId);
  const marker = resolve(f.directory, "capacity-must-not-exist");
  await assert.rejects(f.launch(runtime, "mark", marker), { code: "JOB_CAPACITY" });
  assert.equal(existsSync(marker), false);
  await runtime.close();
  f.reopenDatabase();
  const second = f.service();
  const replay = await f.launch(second, "io", undefined, { operationId });
  assert.equal(replay.jobId, first.jobId);
  assert.equal(replay.state, "SUCCEEDED");
  assert.equal(replay.ownerId, first.ownerId);
  assert.equal((await second.request("alice", request("list"))).total, 1);
});
test("persistence failure fails closed, reaps owned handles and never admits later work", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const runtime = f.service();
  const first = await f.launch(runtime, "ticks");
  await until(() => runtime.status("alice", first.jobId).stdoutBytes >= 3);
  f.database.exec(`CREATE TRIGGER runtime_process_fixture_failure BEFORE UPDATE ON runtime_process_jobs
    BEGIN SELECT RAISE(ABORT, 'synthetic persistence failure'); END`);
  const result = await runtime.wait("alice", first.jobId);
  assert.equal(result.state, "INTERRUPTED");
  assert.equal(result.reason, "persistence-error");
  assert.equal(result.effect, "unknown");
  await assert.rejects(f.launch(runtime), { code: "PERSISTENCE_UNAVAILABLE" });
  await assert.rejects(runtime.close({ drainMs: 0 }), { code: "PERSISTENCE_UNAVAILABLE" });
  f.database.exec("DROP TRIGGER runtime_process_fixture_failure");
  const second = f.service({ previousOwnerId: runtime.ownerId });
  assert.equal(second.status("alice", first.jobId).state, "INTERRUPTED");
});
