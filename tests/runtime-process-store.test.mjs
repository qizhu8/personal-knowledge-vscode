import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RuntimeProcessStore } from "../dist/runtime-process-store.js";

test("failed event persistence does not advance the live receipt sequence and restart recovers the last committed state", { timeout: 5000 }, t => {
  const directory = resolve("tests", `.runtime-process-store-${randomUUID()}`);
  const databasePath = resolve(directory, "fixture.sqlite");
  mkdirSync(directory, { recursive: true });
  let database;
  t.after(() => {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const job = {
    schema: "pkm.runtime-process.job/v1", jobId: randomUUID(), operationId: randomUUID(),
    ownerId: randomUUID(), attemptId: randomUUID(), actorId: "alice", adapterId: "synthetic",
    state: "QUEUED", effect: "not-started", createdAt: 1, startedAt: null, finishedAt: null,
    deadlineAt: 2, pid: null, exitCode: null, signal: null, reason: null,
    stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0,
    stdoutDroppedBytes: 0, stderrDroppedBytes: 0, eventSequence: 0,
  };
  database = new DatabaseSync(databasePath);
  const store = new RuntimeProcessStore(database, job.ownerId, 2);
  store.insert(job, "f".repeat(64), 16);
  assert.equal(job.eventSequence, 1);

  database.exec(`CREATE TRIGGER fail_runtime_event BEFORE INSERT ON runtime_process_events
    WHEN NEW.sequence = 2 BEGIN SELECT RAISE(ABORT, 'synthetic event persistence failure'); END`);
  const running = { ...job, state: "RUNNING", effect: "unknown", startedAt: 2 };
  assert.throws(() => store.save(running, "running"), /synthetic event persistence failure/);
  assert.equal(running.eventSequence, 1);
  assert.equal(store.get("alice", job.jobId).eventSequence, 1);
  assert.equal(store.get("alice", job.jobId).state, "QUEUED");
  assert.equal(database.prepare("SELECT count(*) AS n FROM runtime_process_events").get().n, 1);

  database.exec("DROP TRIGGER fail_runtime_event");
  store.release();
  database.close();
  database = undefined;

  database = new DatabaseSync(databasePath);
  const recovered = new RuntimeProcessStore(database, randomUUID(), 2);
  const interrupted = recovered.get("alice", job.jobId);
  assert.equal(interrupted.state, "INTERRUPTED");
  assert.equal(interrupted.eventSequence, 2);
  const events = recovered.events("alice", job.jobId, 0, 10);
  assert.deepEqual(events.items.map(event => [event.sequence, event.kind]), [
    [1, "queued"], [2, "interrupted"],
  ]);
  recovered.release();
});
