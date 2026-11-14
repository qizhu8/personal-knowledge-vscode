import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runtimeFixture } from "./runtime-process-fixtures.mjs";

test("real SQLite reopen interrupts stale running/queued identities without PID signal or effect replay", { timeout: 5000 }, async t => {
  const f = runtimeFixture();
  t.after(() => f.cleanup());
  const first = f.service();
  const operationId = randomUUID();
  const path = resolve(f.directory, "effect-once");
  const receipt = await f.launch(first, "mark", path, { operationId });
  const completed = await first.wait("alice", receipt.jobId);
  assert.equal(existsSync(path), true);
  rmSync(path);
  const queued = await f.launch(first);
  const queuedCompleted = await first.wait("alice", queued.jobId);
  await first.close();
  const stale = { ...completed, state: "RUNNING", pid: 2_000_000_001, effect: "unknown", finishedAt: null, reason: null };
  const notStarted = { ...queuedCompleted, state: "QUEUED", pid: null, startedAt: null, finishedAt: null, effect: "not-started", reason: null };
  for (const job of [stale, notStarted]) {
    f.database.prepare("UPDATE runtime_process_jobs SET state=?,record_json=? WHERE job_id=?").run(job.state, JSON.stringify(job), job.jobId);
  }
  f.database.prepare("UPDATE runtime_process_owner SET closed=0").run();
  f.reopenDatabase();
  assert.throws(() => f.service(), { code: "OWNERSHIP_CONFLICT" });
  const recovered = f.service({ previousOwnerId: first.ownerId });
  const job = recovered.status("alice", receipt.jobId);
  assert.equal(job.state, "INTERRUPTED");
  assert.equal(job.effect, "unknown");
  assert.equal(job.reason, "restart");
  assert.equal(job.pid, stale.pid);
  assert.equal(job.ownerId, first.ownerId);
  assert.equal(job.attemptId, completed.attemptId);
  assert.notEqual(recovered.ownerId, first.ownerId);
  assert.equal(recovered.status("alice", queued.jobId).effect, "not-started");
  const replay = await f.launch(recovered, "mark", path, { operationId });
  assert.equal(replay.jobId, receipt.jobId);
  assert.equal(replay.state, "INTERRUPTED");
  assert.equal((await recovered.cancel("alice", receipt.jobId)).state, "INTERRUPTED");
  assert.equal(existsSync(path), false);
  const events = await recovered.request("alice", { operation: "runtime.process.events", args: { jobId: receipt.jobId } });
  assert.equal(events.items.at(-1).kind, "interrupted");
  await recovered.close();
  assert.equal(existsSync(path), false);
});
