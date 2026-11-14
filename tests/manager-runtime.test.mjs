import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createManagerRuntime, initializeManagerRuntimeSchema } from "../dist/manager-runtime.js";
import { createManagerRuntimeDefinitions } from "../dist/manager-runtime-contracts.js";
import { validateManagerPlan } from "../dist/manager-plan.js";

const pin = character => character.repeat(64);
const contract = {
  schema: "pkm.manager.completion/v1", goalId: "goal", revision: 1, objective: "Complete the whole project",
  scope: ["workspace"], nonGoals: ["production"], acceptance: [{ id: "whole", criterion: "End to end works", verification: "Run the suite", e2e: true }],
  outputs: ["result"], invariants: ["safe"], stopConditions: ["unsafe"],
};
function fixture(count = 3, maxConcurrentWorkers = count) {
  const budget = { maxWorkers: count, maxConcurrentWorkers, maxTasks: count + 3, maxAttemptsPerTask: 3 };
  const workerIds = Array.from({ length: count }, (_, i) => `task${i}`);
  const task = (taskId, phase, dependsOn, writeScope, trigger = "always") => ({
    taskId, title: taskId, objective: `Complete ${taskId}`, phase, dependsOn,
    readScope: [], writeScope, resources: [], acceptanceIds: ["whole"], verification: "Run checks",
    independence: { traceId: taskId, rationale: "Independent work" }, trigger,
  });
  const plan = {
    schema: "pkm.manager.plan/v1", planId: "plan", revision: 1, contract, budget,
    assessment: { kind: count > 1 ? "parallel" : "serial", rationale: "Independent work", independentTaskCount: count },
    tasks: [
      ...workerIds.map(id => task(id, "worker", [], [`work/${id}`])),
      task("integrator", "integrator", workerIds, ["integration"]),
      task("verifier", "verifier", ["integrator"], []),
      task("repair", "repair", ["verifier"], ["repair"], "verification-failed"),
    ],
  };
  const result = validateManagerPlan(plan);
  assert.equal(result.status, "ready", JSON.stringify(result));
  return { budget, result };
}
function setup(hostOptions = {}, count = 3, concurrency = count) {
  const database = new DatabaseSync(":memory:");
  database.exec("BEGIN"); initializeManagerRuntimeSchema(database); database.exec("COMMIT");
  const token = {}, other = {}, { budget, result } = fixture(count, concurrency);
  const calls = { worker: [], freeze: 0, integrate: 0, verify: 0 };
  const host = {
    resolveOwner: value => value === token ? { actorId: "actor", nativeOwnerId: "owner" } : value === other ? { actorId: "other", nativeOwnerId: "owner" } : undefined,
    authorizeTask: () => true,
    plan: async () => result,
    worker: async ({ task, attemptId, repairReason }) => {
      calls.worker.push({ taskId: task.taskId, attemptId, repairReason });
      return { artifact: `artifact:${task.taskId}`, pin: pin(repairReason ? "b" : "a"), workerId: `owner_${task.taskId}`, paths: [`work/${task.taskId}/file`] };
    },
    validate: async ({ delivery }) => ({ ok: true, pin: delivery.pin }),
    freeze: async () => { calls.freeze++; return { pin: pin(calls.freeze === 1 ? "c" : "d") }; },
    integrate: async () => { calls.integrate++; return calls.integrate === 1
      ? { ok: false, taskId: "task1", reason: "Repair exact owner" } : { ok: true, pin: pin("e") }; },
    verify: async () => { calls.verify++; return { ok: true, pin: pin("f") }; },
    ...hostOptions,
  };
  const runtime = createManagerRuntime(database, { host, leaseMs: 2000 });
  const start = () => runtime.start(token, { operationId: randomUUID(), runId: "run", projectId: "project", contract, budget });
  return { database, runtime, token, other, budget, calls, host, start };
}
async function waitFor(fn) {
  for (let i = 0; i < 500; i++) {
    const result = fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("Manager did not reach expected state");
}

test("native Manager runs workers, freezes, repairs exact owner, refreezes and verifies E2E", async () => {
  const x = setup(); x.start();
  const run = await waitFor(() => { const r = x.runtime.get(x.token, { runId: "run" }); return r.state === "succeeded" && r; });
  assert.equal(x.calls.worker.length, 4);
  assert.deepEqual(x.calls.worker.filter(w => w.repairReason).map(w => w.taskId), ["task1"]);
  assert.equal(x.calls.freeze, 2); assert.equal(x.calls.integrate, 2); assert.equal(x.calls.verify, 1);
  assert.equal(run.checks.filter(c => c.kind === "e2e" && c.result.ok).length, 1);
  const events = x.runtime.events(x.token, { runId: "run", afterSeq: 0, limit: 100 });
  assert.ok(events.items.some(e => e.type === "worker.delivery" && e.data.taskId === "task1" && e.data.attemptId && e.data.pin));
  assert.equal(events.items.at(-1).type, "e2e.checked");
  assert.throws(() => x.runtime.get(x.other, { runId: "run" }), { code: "NOT_FOUND" });
  x.database.close();
});

test("twenty independent workers respect concurrent quota and do not spawn indefinitely", async () => {
  let running = 0, peak = 0;
  const x = setup({ worker: async ({ task }) => {
    running++; peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 2)); running--;
    return { artifact: task.taskId, pin: pin("a"), workerId: `owner_${task.taskId}`, paths: [`work/${task.taskId}/file`] };
  }, integrate: async () => ({ ok: true, pin: pin("e") }) }, 20, 4);
  x.start();
  await waitFor(() => x.runtime.get(x.token, { runId: "run" }).state === "succeeded");
  assert.equal(peak, 4);
  const run = x.runtime.get(x.token, { runId: "run" });
  assert.equal(run.tasks.filter(t => t.definition.phase === "worker").reduce((n, t) => n + t.attempts.length, 0), 20);
  x.database.close();
});

test("completion events refill capacity without waiting for a slow sibling", async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const started = [];
  const x = setup({
    worker: async ({ task }) => {
      started.push(task.taskId);
      if (task.taskId === "task0") await barrier;
      return { artifact: task.taskId, pin: pin("a"), workerId: `owner_${task.taskId}`, paths: [`work/${task.taskId}/file`] };
    },
    integrate: async () => ({ ok: true, pin: pin("e") }),
  }, 4, 2);
  x.start();
  await waitFor(() => started.length === 4);
  assert.equal(x.runtime.get(x.token, { runId: "run" }).state, "active");
  release();
  await waitFor(() => x.runtime.get(x.token, { runId: "run" }).state === "succeeded");
  x.database.close();
});

test("ordinary feedback reaches target at checkpoint while other worker continues", async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const seen = [];
  const x = setup({ worker: async ({ task, feedback }) => {
    seen.push({ taskId: task.taskId, feedback });
    if (task.taskId === "task0" && seen.filter(s => s.taskId === "task0").length === 1) await barrier;
    return { artifact: task.taskId, pin: pin("a"), workerId: `owner_${task.taskId}`, paths: [`work/${task.taskId}/file`] };
  }, integrate: async () => ({ ok: true, pin: pin("e") }) }, 2, 2);
  x.start();
  await waitFor(() => seen.length === 2);
  const before = x.runtime.get(x.token, { runId: "run" });
  const receipt = x.runtime.feedback(x.token, { operationId: randomUUID(), runId: "run", expectedVersion: before.version, taskId: "task0", message: "Correct this" });
  assert.equal(receipt.feedback[0].state, "queued");
  release();
  await waitFor(() => x.runtime.get(x.token, { runId: "run" }).state === "succeeded");
  assert.equal(seen.filter(s => s.taskId === "task1").length, 1);
  assert.deepEqual(seen.filter(s => s.taskId === "task0").at(-1).feedback, ["Correct this"]);
  x.database.close();
});

test("restart fences interrupted native effect; no automatic respawn and stale result cannot finish", async () => {
  let release, spawned = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const x = setup({ worker: async ({ task }) => {
    spawned++; await barrier;
    return { artifact: task.taskId, pin: pin("a"), workerId: `owner_${task.taskId}`, paths: [`work/${task.taskId}/file`] };
  } }, 1, 1);
  x.start(); await waitFor(() => spawned === 1);
  const restarted = createManagerRuntime(x.database, { host: x.host, leaseMs: 2000 });
  assert.equal(restarted.recover(x.token, { runId: "run" }).state, "unknown");
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(restarted.get(x.token, { runId: "run" }).state, "unknown");
  assert.equal(spawned, 1);
  x.database.close();
});

test("urgent targeted feedback fences affected worker, not unrelated work", async () => {
  let release, cancelled = [];
  const barrier = new Promise(resolve => { release = resolve; });
  const x = setup({
    worker: async ({ task }) => {
      if (task.taskId === "task0") await barrier;
      return { artifact: task.taskId, pin: pin("a"), workerId: `owner_${task.taskId}`, paths: [`work/${task.taskId}/file`] };
    },
    cancel: async ({ effectId }) => { cancelled.push(effectId); },
  }, 2, 2);
  x.start();
  await waitFor(() => {
    const r = x.runtime.get(x.token, { runId: "run" });
    return r.tasks.find(t => t.definition.taskId === "task0")?.state === "running";
  });
  const before = x.runtime.get(x.token, { runId: "run" });
  const affected = before.tasks.find(t => t.definition.taskId === "task0").attempts[0].effect.id;
  x.runtime.feedback(x.token, { operationId: randomUUID(), runId: "run", expectedVersion: before.version, taskId: "task0", message: "Unsafe", urgent: true });
  release();
  const paused = await waitFor(() => { const r = x.runtime.get(x.token, { runId: "run" }); return r.state === "paused" && r; });
  assert.deepEqual(cancelled, [affected]);
  assert.equal(paused.tasks.find(t => t.definition.taskId === "task0").state, "unknown");
  assert.equal(paused.tasks.find(t => t.definition.taskId === "task1").state, "accepted");
  assert.notEqual(paused.state, "succeeded");
  x.database.close();
});

test("global mutation hook rolls back receipt and state; idempotency and CAS are enforced", async () => {
  const x = setup();
  const denied = createManagerRuntime(x.database, { host: x.host, onMutation: () => { throw new Error("global receipt collision"); } });
  const args = { operationId: randomUUID(), runId: "blocked", projectId: "project", contract, budget: x.budget };
  assert.throws(() => denied.start(x.token, args), /global receipt collision/);
  assert.throws(() => x.runtime.get(x.token, { runId: "blocked" }), { code: "NOT_FOUND" });
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const waiting = createManagerRuntime(x.database, { host: { ...x.host, plan: () => barrier } });
  const input = { ...args, operationId: randomUUID(), runId: "replay" };
  const first = waiting.start(x.token, input);
  assert.deepEqual(waiting.start(x.token, input), first);
  assert.throws(() => waiting.start(x.token, { ...input, projectId: "different" }), { code: "CONFLICT" });
  await waitFor(() => waiting.get(x.token, { runId: "replay" }).version > first.version);
  assert.throws(() => waiting.cancel(x.token, { operationId: randomUUID(), runId: "replay", expectedVersion: first.version }), { code: "REVISION_CONFLICT" });
  const latest = waiting.get(x.token, { runId: "replay" });
  waiting.cancel(x.token, { operationId: randomUUID(), runId: "replay", expectedVersion: latest.version });
  release(x.host.plan());
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(waiting.get(x.token, { runId: "replay" }).state, "cancelled");
  x.database.close();
});

test("native capability fixtures expose no public result acceptance and gate start", () => {
  const disabled = createManagerRuntimeDefinitions(false);
  const enabled = createManagerRuntimeDefinitions(true);
  assert.ok(!disabled.some(def => def.id === "manager.runtime.start"));
  assert.deepEqual(enabled.map(def => def.id), ["manager.runtime.start", "manager.runtime.get", "manager.runtime.events", "manager.runtime.feedback", "manager.runtime.cancel"]);
  const start = enabled.find(def => def.id === "manager.runtime.start");
  const input = { operationId: randomUUID(), runId: "run", projectId: "project", contract, budget: fixture().budget };
  assert.equal(start.input.safeParse(input).success, true);
  assert.equal(start.input.safeParse({ ...input, actorId: "forged" }).success, false);
  assert.equal(start.input.safeParse({ ...input, checks: [{ ok: true }] }).success, false);
});

test("planner clarification blocks dispatch, invalid cursor is rejected", async () => {
  let dispatches = 0;
  const x = setup({
    plan: async () => ({ status: "needsClarification", questions: ["What is the acceptance?"] }),
    worker: async () => { dispatches++; throw new Error("not reachable"); },
  });
  x.start();
  const run = await waitFor(() => { const r = x.runtime.get(x.token, { runId: "run" }); return r.state === "paused" && r; });
  assert.equal(dispatches, 0);
  assert.equal(x.runtime.events(x.token, { runId: "run", afterSeq: 0 }).items.at(-1).type, "plan.clarification");
  assert.throws(() => x.runtime.events(x.token, { runId: "run", afterSeq: run.lastSequence + 1 }), { code: "INVALID_CURSOR" });
  x.database.close();
});
