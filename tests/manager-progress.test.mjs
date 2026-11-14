import assert from "node:assert/strict";
import test from "node:test";
import {
  coalesceManagerProgressEvents,
  managerProgressDefinitions,
  managerProgressFreshness,
  ManagerProgressService,
} from "../dist/manager-progress.js";

const runId = "manager-run-1";
const projectId = "project-1";
const taskId = "task-worker";
const attemptId = "attempt-1";
const pin = "a".repeat(64);
const ownerToken = Object.freeze({ owner: "native" });

function fixture(overrides = {}) {
  const run = {
    schema: "pkm.manager.runtime/v1",
    runId,
    projectId,
    version: 4,
    state: "active",
    phase: "working",
    contract: {},
    budget: { maxWorkers: 2, maxConcurrentWorkers: 2, maxTasks: 5, maxAttemptsPerTask: 2 },
    plan: null,
    planHash: null,
    tasks: [{
      definition: { taskId, title: "Build module", objective: "Private objective", phase: "worker" },
      definitionHash: "b".repeat(64),
      state: "running",
      attempts: [{
        attemptId,
        number: 1,
        state: "running",
        effect: { id: "effect-1", kind: "worker", leaseUntil: 100_000 },
        delivery: { artifact: "/private/workspace/secret-result.bin", pin, paths: ["/private/workspace/secret-result.bin"] },
      }],
    }],
    checks: [],
    feedback: [],
    effect: null,
    freeze: null,
    integration: null,
    lastSequence: 2,
    createdAt: 1_000,
    updatedAt: 4_000,
    reason: null,
    ...overrides,
  };
  const events = [
    { seq: 1, runId, version: 3, type: "worker.delivery", time: 3_000, data: { taskId, attemptId, artifact: "/private/workspace/secret-result.bin", pin } },
    { seq: 2, runId, version: 4, type: "worker.checked", time: 4_000, data: { taskId, attemptId, ok: true, pin } },
  ];
  const state = { run, events, calls: [], workerCalls: 0 };
  const runtime = {
    get(token, input) {
      state.calls.push({ method: "get", token, input });
      return state.run;
    },
    events(token, input) {
      state.calls.push({ method: "events", token, input });
      const items = state.events.filter(event => event.seq > input.afterSeq).slice(0, input.limit);
      return { items, nextSeq: Math.max(input.afterSeq, ...items.map(event => event.seq)) };
    },
    feedback(token, input) {
      state.calls.push({ method: "feedback", token, input });
      state.run = {
        ...state.run,
        version: state.run.version + 1,
        updatedAt: state.run.updatedAt + 1,
        feedback: [...state.run.feedback, { id: input.operationId, taskId: input.taskId, message: input.message, urgent: input.urgent, state: "queued" }],
      };
      return state.run;
    },
  };
  return { runtime, state };
}

test("active worker delivery is readable without completing its instruction", async () => {
  const { runtime, state } = fixture();
  const service = new ManagerProgressService(runtime, { now: () => 10_000 });
  const overview = await service.overview(ownerToken, { runId });
  const feed = await service.events(ownerToken, { runId, afterSeq: 0 });

  assert.equal(overview.doing[0].taskId, taskId);
  assert.equal(overview.completed.length, 0);
  assert.equal(overview.updatedAt, new Date(4_000).toISOString());
  assert.equal("percentComplete" in overview, false);
  assert.equal(feed.events[0].result.verificationGrade, "delivery");
  assert.equal(feed.events[0].result.verificationStatus, "pending");
  assert.equal(feed.events[0].taskId, taskId);
  assert.equal(feed.events[0].attemptId, attemptId);
  assert.equal(feed.events[0].result.artifact.sourcePin.value, pin);
  assert.equal(state.calls.every(call => call.token === ownerToken), true);
  assert.equal(JSON.stringify(feed).includes("/private/workspace"), false);
  assert.equal(JSON.stringify(feed).includes("Private objective"), false);
});

test("ordered cursor pages deduplicate, report sequence gaps and reject cross-run cursors", async () => {
  const { runtime, state } = fixture();
  state.events = [
    { seq: 5, runId, version: 4, type: "workers.ready", time: 5_000, data: {} },
    { seq: 3, runId, version: 4, type: "worker.intent", time: 4_000, data: { taskId, attemptId } },
    { seq: 1, runId, version: 2, type: "run.started", time: 2_000, data: {} },
    { seq: 1, runId, version: 2, type: "run.started", time: 2_000, data: {} },
  ];
  state.run.lastSequence = 5;
  const service = new ManagerProgressService(runtime, { now: () => 5_000 });
  const page = await service.events(ownerToken, { runId, afterSeq: 0 });

  assert.deepEqual(page.events.map(event => event.sequence), [1, 3, 5]);
  assert.deepEqual(page.gaps, [{ fromSeq: 2, toSeq: 2 }, { fromSeq: 4, toSeq: 4 }]);
  assert.equal(page.nextSeq, 5);
  assert.equal(page.hasMore, false);
  const resumed = await service.events(ownerToken, { runId, cursor: page.nextCursor });
  assert.equal(resumed.events.length, 0);
  await assert.rejects(service.events(ownerToken, { runId: "other-run", cursor: page.nextCursor }), /different run/);
});

test("event reads reconcile a commit that lands between the run and event snapshots", async () => {
  const { runtime, state } = fixture();
  const originalGet = runtime.get;
  const originalEvents = runtime.events;
  let gets = 0;
  runtime.get = (...args) => {
    gets++;
    return originalGet(...args);
  };
  runtime.events = (token, input) => {
    state.run = { ...state.run, version: 5, lastSequence: 3, updatedAt: 5_000 };
    state.events.push({ seq: 3, runId, version: 5, type: "worker.delivery", time: 5_000,
      data: { taskId, attemptId, artifact: "/private/workspace/secret-result.bin", pin } });
    return originalEvents(token, input);
  };
  const service = new ManagerProgressService(runtime, { now: () => 6_000 });
  const page = await service.events(ownerToken, { runId, afterSeq: 2 });

  assert.equal(gets, 2);
  assert.equal(page.events[0].sequence, 3);
  assert.equal(page.events[0].kind, "result");
});

test("tampered actors and artifact pins are rejected or redacted", async () => {
  const { runtime, state } = fixture();
  const service = new ManagerProgressService(runtime, { now: () => 5_000 });
  await assert.rejects(service.feedback(ownerToken, {
    operationId: "2afca2d6-a62d-4fac-ae6d-81fc06478df1",
    runId,
    expectedVersion: 4,
    target: { kind: "task", taskId },
    message: "please keep going",
    actorId: "attacker",
  }));
  assert.equal(state.calls.some(call => call.method === "feedback"), false);

  state.events[0].data = {
    taskId,
    attemptId,
    artifact: "/attacker/private/secret",
    pin: "c".repeat(64),
  };
  const page = await service.events(ownerToken, { runId, afterSeq: 0 });
  assert.equal(page.events[0].kind, "status");
  assert.equal(JSON.stringify(page).includes("/attacker/private"), false);
  assert.equal(JSON.stringify(page).includes("secret"), false);
});

test("self-reported evidence never changes instruction completion", async () => {
  const { runtime, state } = fixture();
  state.events = [{
    seq: 1,
    runId,
    version: 4,
    type: "worker.self-report",
    time: 4_000,
    data: { taskId, attemptId, pin },
  }];
  state.run.lastSequence = 1;
  const service = new ManagerProgressService(runtime, { now: () => 5_000 });
  const feed = await service.events(ownerToken, { runId, afterSeq: 0 });
  const overview = await service.overview(ownerToken, { runId });

  assert.equal(feed.events[0].result.verificationGrade, "selfReport");
  assert.equal(feed.events[0].result.verificationStatus, "pending");
  assert.deepEqual(overview.doing.map(task => task.taskId), [taskId]);
  assert.equal(overview.completed.length, 0);
});

test("live result subscription emits while the worker is still running", async () => {
  const { runtime, state } = fixture();
  state.run.lastSequence = 2;
  let publish;
  runtime.subscribeEvents = (token, input, listener) => {
    state.calls.push({ method: "subscribe", token, input });
    publish = listener;
    return () => { publish = undefined; };
  };
  const service = new ManagerProgressService(runtime, { now: () => 5_000 });
  const received = [];
  const unsubscribe = await service.subscribeEvents(ownerToken, { runId, afterSeq: 2 }, event => received.push(event));
  state.run.lastSequence = 3;
  publish({ seq: 3, runId, version: 5, type: "worker.delivery", time: 5_000,
    data: { taskId, attemptId, artifact: "/private/workspace/secret-result.bin", pin } });
  await new Promise(resolve => setImmediate(resolve));
  unsubscribe();

  assert.equal(received[0].kind, "result");
  assert.equal(received[0].result.verificationGrade, "delivery");
  assert.equal(state.run.tasks[0].state, "running");
});

test("live user blocks are immediate and are never coalesced with progress", async () => {
  const { runtime } = fixture();
  let publish;
  runtime.subscribeEvents = (_token, _input, listener) => {
    publish = listener;
    return () => {};
  };
  const service = new ManagerProgressService(runtime, { now: () => 5_000 });
  const received = [];
  const unsubscribe = await service.subscribeEvents(ownerToken, { runId, afterSeq: 2 }, event => received.push(event));
  publish({ seq: 3, runId, version: 5, type: "worker.intent", time: 5_000, data: { taskId, attemptId } });
  publish({ seq: 4, runId, version: 6, type: "run.paused", time: 5_001, data: { reason: "must not be exposed" } });

  assert.deepEqual(received.map(event => event.kind), ["progress", "blocker"]);
  assert.equal(received[1].critical, true);
  assert.equal(JSON.stringify(received).includes("must not be exposed"), false);
  unsubscribe();
});

test("critical blocks/errors bypass progress coalescing", () => {
  const progress = (sequence, task) => ({
    schema: "pkm.manager.progress.event/v1",
    eventId: `event-${sequence}`,
    sequence,
    cursor: "mpc1.eyJ4IjoxfQ",
    time: new Date(1_000 + sequence).toISOString(),
    kind: "progress",
    taskId: task,
    critical: false,
  });
  const blocked = {
    ...progress(3, taskId),
    kind: "blocker",
    critical: true,
    code: "run-paused",
  };
  const failed = {
    ...progress(4, taskId),
    kind: "error",
    critical: true,
    code: "task-check-failed",
  };
  const compact = coalesceManagerProgressEvents([progress(1, taskId), progress(2, taskId), blocked, failed]);
  assert.equal(compact.length, 3);
  assert.equal(compact.find(event => event.kind === "progress").coalescedFromSeq, 1);
  assert.equal(compact.filter(event => event.critical).length, 2);
});

test("last heartbeat freshness is explicit and stale when its timestamp ages out", () => {
  assert.deepEqual(managerProgressFreshness(1_000, 2_000, 500), {
    lastHeartbeatAt: new Date(1_000).toISOString(),
    freshness: "stale",
  });
  assert.equal(managerProgressFreshness(null, 2_000, 500).freshness, "stale");
});

test("ordinary feedback records a versioned receipt without mutating workers", async () => {
  const { runtime, state } = fixture();
  const service = new ManagerProgressService(runtime, { now: () => 5_000 });
  const receipt = await service.feedback(ownerToken, {
    operationId: "2afca2d6-a62d-4fac-ae6d-81fc06478df1",
    runId,
    expectedVersion: 4,
    target: { kind: "task", taskId },
    message: "Please preserve the current scope.",
  });

  assert.equal(receipt.status, "applied");
  assert.equal(receipt.version, 5);
  assert.equal(receipt.target.taskId, taskId);
  assert.equal(state.calls.at(-1).input.urgent, false);
  assert.equal(state.run.tasks[0].state, "running");
  assert.equal(state.workerCalls, 0);

  const resultPage = await service.events(ownerToken, { runId, afterSeq: 0 });
  const resultReceipt = await service.feedback(ownerToken, {
    operationId: "a0b41637-5ef9-4e8d-a6aa-72e21c94a3f8",
    runId,
    expectedVersion: 5,
    target: { kind: "result", taskId, attemptId, resultId: resultPage.events[0].result.id },
    message: "That pinned artifact is the correct handoff.",
  });
  assert.equal(resultReceipt.target.kind, "result");
  assert.equal(resultReceipt.version, 6);
  assert.equal(state.run.tasks[0].state, "running");
});

test("live subscription is explicit and never silently falls back to polling", async () => {
  const { runtime, state } = fixture();
  const service = new ManagerProgressService(runtime, { now: () => 5_000 });
  await assert.rejects(service.subscribeEvents(ownerToken, { runId, afterSeq: 0 }, () => {}), /no polling fallback/);
  assert.equal(state.calls.length, 0);
});

test("only the three intended schema-only progress operations are advertised", () => {
  assert.deepEqual(managerProgressDefinitions.map(definition => definition.id), [
    "manager.progress.get", "manager.progress.events", "manager.progress.feedback",
  ]);
});
