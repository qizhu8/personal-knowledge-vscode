import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { httpCall, invocation, managerActor, nativeWorkspace, syntheticManager, until } from "./batch06-manager-fixtures.mjs";

test("actual native HTTP Manager k=20 publishes while active, targets feedback, repairs frozen owner and automatically accepts E2E", async t => {
  const manager = syntheticManager("migration", 20, { hold: true, publish: true, failIntegration: true });
  const f = await nativeWorkspace(t, { manager: manager.config });
  f.addCleanup(manager.release);
  const url = await f.listen();
  const input = manager.start("manager-live");
  const started = await httpCall(url, f.bearer, "capability_call", invocation("manager.runtime.start", input));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual((await httpCall(url, f.bearer, "capability_call", invocation("manager.runtime.start", input))).body.result, started.body.result);
  await until(() => manager.calls.worker.length === 20 && manager.calls.published === 1, "live worker publications");
  const read = operation => httpCall(url, f.bearer, "capability_read", invocation(operation, { runId: input.runId }));
  const active = await until(async () => {
    const run = (await read("manager.runtime.get")).body.result;
    return run.tasks.filter(task => task.definition.phase === "worker" && task.state === "accepted").length === 19 && run;
  }, "other workers accepted independently");
  assert.equal(active.state, "active");
  assert.equal(active.tasks.find(task => task.definition.taskId === "worker-1").state, "running");
  assert.equal(manager.calls.freeze.length, 0);
  assert.equal(manager.calls.verify.length, 0, "worker reports cannot complete parent instruction");
  const feed = (await httpCall(url, f.bearer, "capability_read",
    invocation("manager.progress.events", { runId: input.runId, afterSeq: 0, limit: 100 }))).body.result;
  const intermediate = feed.events.find(event => event.kind === "result" && event.taskId === "worker-1");
  assert.ok(intermediate, JSON.stringify(feed));
  assert.equal(intermediate.result.verificationStatus, "pending");
  assert.equal(intermediate.result.verificationGrade, "delivery");
  const overview = (await read("manager.progress.get")).body.result;
  assert(overview.doing.some(task => task.taskId === "worker-1"));
  assert.equal(overview.completed.some(task => task.taskId === "worker-1"), false);
  const feedback = await httpCall(url, f.bearer, "capability_call", invocation("manager.progress.feedback", {
    operationId: randomUUID(), runId: input.runId, expectedVersion: active.version,
    target: { kind: "task", taskId: "worker-1" }, message: "Keep only this worker's revised acceptance detail.",
  }));
  assert.equal(feedback.status, 200, JSON.stringify(feedback.body));
  assert.equal(manager.calls.worker.filter(call => call.taskId !== "worker-1").length, 19);
  manager.release();
  const completed = await until(async () => {
    const state = (await read("manager.runtime.get")).body.result;
    return state.state === "succeeded" && state;
  }, "automatic native E2E completion");
  assert.equal(manager.calls.peak, 4);
  assert.equal(manager.calls.freeze.length, 2);
  assert.equal(manager.calls.integrate.length, 2);
  assert.equal(manager.calls.verify.length, 1);
  assert.deepEqual(manager.calls.worker.filter(call => call.repairReason && !call.feedback.length).map(call => call.taskId), ["worker-2"]);
  assert.deepEqual(manager.calls.worker.filter(call => call.feedback.length).map(call => call.taskId), ["worker-1"]);
  assert.equal(manager.calls.worker.filter(call => call.taskId === "worker-3").length, 1);
  assert(completed.checks.some(check => check.kind === "e2e" && check.result.ok));
  assert.equal((await f.call("manager.runtime.get", { runId: input.runId }, { ...managerActor, id: "native:unrelated" })).error.code, "NOT_FOUND");
  assert.equal((await httpCall(url, f.bearer, "capability_call",
    invocation("manager.runtime.start", { ...manager.start("forged"), actorId: "forged" }))).body.error.code, "INVALID_ARGUMENT");
  assert.equal((await httpCall(url, f.bearer, "capabilities_describe", { operation: "execution.approve" })).body.error.code, "NOT_FOUND");
});

test("actual native MCP Manager qualifies feature/research/cleanup and one-trace serial matrix", async t => {
  const f = await nativeWorkspace(t);
  await f.close();
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve(import.meta.dirname, "batch06-manager-mcp-child.mjs"), f.root], stderr: "pipe",
  });
  const client = new Client({ name: "batch06-native-manager", version: "1.0.0" });
  f.addCleanup(() => client.close());
  await client.connect(transport);
  const call = async (method, input) => {
    const response = await client.callTool({ name: method, arguments: input });
    return response.structuredContent ?? JSON.parse(response.content[0].text);
  };
  for (const kind of ["feature", "research", "cleanup", "small"]) {
    const manager = syntheticManager(kind, kind === "small" ? 1 : 3);
    const input = manager.start(`matrix-${kind}`);
    const started = await call("capability_call", invocation("manager.runtime.start", input));
    assert.ok(started.result, JSON.stringify(started));
    const completed = await until(async () => {
      const result = (await call("capability_read", invocation("manager.runtime.get", { runId: input.runId }))).result;
      return result.state === "succeeded" && result;
    }, `MCP ${kind} completion`);
    assert.equal(completed.plan.assessment.kind, kind === "small" ? "serial" : "parallel");
    assert.equal(completed.tasks.filter(task => task.definition.phase === "worker").length, kind === "small" ? 1 : 3);
    assert.equal(completed.checks.filter(check => check.kind === "e2e" && check.result.ok).length, 1);
  }
});

test("native defaults hide Manager; clarification pauses without dispatch and stale feedback is rejected", async t => {
  const manager = syntheticManager("feature", 2, { clarification: true });
  const f = await nativeWorkspace(t);
  assert.equal((await f.runtime.core.dispatch("capabilities_describe", { operation: "manager.runtime.start" }, managerActor)).error.code, "NOT_FOUND");
  await f.reopen({ manager: manager.config });
  const input = manager.start("clarification");
  assert.ok((await f.call("manager.runtime.start", input)).result);
  const paused = await until(async () => {
    const run = (await f.call("manager.runtime.get", { runId: input.runId })).result;
    return run.state === "paused" && run;
  });
  assert.equal(manager.calls.worker.length, 0);
  assert.equal(manager.calls.verify.length, 0);
  const response = await f.call("manager.progress.feedback", {
    operationId: randomUUID(), runId: input.runId, expectedVersion: paused.version - 1,
    target: { kind: "run" }, message: "Clarification with stale version.",
  });
  assert.equal(response.error.code, "CONFLICT");
});

test("actual native self-report stays active; cancellation fences late delivery and public owner claims", async t => {
  const manager = syntheticManager("small", 1, { hold: true, publish: true, publishGrade: "selfReport" });
  const f = await nativeWorkspace(t, { manager: manager.config });
  const input = manager.start("self-report");
  assert.ok((await f.call("manager.runtime.start", input)).result);
  await until(() => manager.calls.published === 1);
  const progress = (await f.call("manager.progress.events", { runId: input.runId, afterSeq: 0 })).result;
  assert.equal(progress.events.find(event => event.kind === "result").result.verificationGrade, "selfReport");
  const run = (await f.call("manager.runtime.get", { runId: input.runId })).result;
  assert.equal(run.state, "active");
  assert.equal(manager.calls.verify.length, 0);
  const forged = await f.call("manager.runtime.feedback", { operationId: randomUUID(), runId: input.runId,
    expectedVersion: run.version, taskId: "worker-1", message: "Forged owner", actorId: "forged" });
  assert.equal(forged.error.code, "INVALID_ARGUMENT");
  assert.ok((await f.call("manager.runtime.cancel", { operationId: randomUUID(), runId: input.runId, expectedVersion: run.version })).result);
  manager.release();
  await until(() => manager.calls.active === 0);
  const cancelled = (await f.call("manager.runtime.get", { runId: input.runId })).result;
  assert.equal(cancelled.state, "cancelled");
  assert.equal(manager.calls.freeze.length, 0);
  assert.equal(manager.calls.verify.length, 0);
});

test("actual native attempt budget exhaustion pauses rather than accepting or spawning indefinitely", async t => {
  const manager = syntheticManager("small", 1, { host: { validate: async () => ({ ok: false, reason: "Synthetic validation failure." }) } });
  manager.plan.budget.maxAttemptsPerTask = 2;
  const f = await nativeWorkspace(t, { manager: manager.config });
  const input = manager.start("bounded-attempts");
  assert.ok((await f.call("manager.runtime.start", input)).result);
  const paused = await until(async () => {
    const run = (await f.call("manager.runtime.get", { runId: input.runId })).result;
    return run.state === "paused" && run;
  });
  assert.equal(manager.calls.worker.length, 2);
  assert.equal(manager.calls.verify.length, 0);
  assert.equal(paused.tasks[0].attempts.length, 2);
  assert.match(paused.reason, /budget exhausted/i);
  assert.equal(paused.tasks[0].state, "blocked");
  const progress = (await f.call("manager.progress.events", { runId: input.runId, afterSeq: 0 })).result;
  assert(progress.events.some(event => event.critical && event.code === "budget-exhausted"));
});

for (const decision of ["unknown", "not-executed"]) {
  test(`actual native restart ${decision} reconciliation never replays uncertain effects`, async t => {
    const reconciliations = [];
    const manager = syntheticManager("small", 1, { hold: true, host: {
      reconcile: async binding => { reconciliations.push(binding); return { status: decision }; },
    } });
    const config = { manager: { ...manager.config, resumeInterrupted: true } };
    const f = await nativeWorkspace(t, config);
    const input = manager.start(`restart-${decision}`);
    assert.ok((await f.call("manager.runtime.start", input)).result);
    await until(() => manager.calls.worker.length === 1);
    const running = (await f.call("manager.runtime.get", { runId: input.runId })).result;
    const effectId = running.tasks[0].attempts[0].effect.id;
    await f.reopen(config);
    assert.equal(reconciliations.length, 1);
    assert.equal(reconciliations[0].effectId, effectId);
    if (decision === "unknown") {
      const unknown = (await f.call("manager.runtime.get", { runId: input.runId })).result;
      assert.equal(unknown.state, "unknown");
      assert.equal(manager.calls.worker.length, 1);
      const native = f.runtime.services.manager;
      assert.throws(() => native.resume(f.runtime.services.managerToken(managerActor.id),
        { runId: input.runId, expectedVersion: unknown.version }), { code: "INVALID_STATE" });
    } else {
      const succeeded = await until(async () => {
        const run = (await f.call("manager.runtime.get", { runId: input.runId })).result;
        return run.state === "succeeded" && run;
      }, "explicit never-executed native restart resume");
      assert.equal(manager.calls.worker.length, 2);
      assert.equal(succeeded.tasks[0].attempts[0].state, "not-executed");
      assert.equal(manager.calls.verify.length, 1);
    }
  });
}

test("actual native completion clarification feedback automatically replans and finishes without a continue command", async t => {
  const manager = syntheticManager("small", 1);
  const plan = manager.host.plan;
  let plans = 0;
  manager.host.plan = input => ++plans === 1
    ? Promise.resolve({ status: "needsClarification", questions: ["Confirm objective-wide acceptance."] }) : plan(input);
  const f = await nativeWorkspace(t, { manager: manager.config });
  const input = manager.start("clarified-completion");
  assert.ok((await f.call("manager.runtime.start", input)).result);
  const paused = await until(async () => {
    const run = (await f.call("manager.runtime.get", { runId: input.runId })).result;
    return run.state === "paused" && run;
  });
  assert.equal(manager.calls.worker.length, 0);
  const clarified = await f.call("manager.runtime.feedback", { operationId: randomUUID(), runId: input.runId,
    expectedVersion: paused.version, goal: manager.plan.contract, message: "Confirmed explicit full-goal acceptance; proceed." });
  assert.ok(clarified.result, JSON.stringify(clarified));
  await until(async () => (await f.call("manager.runtime.get", { runId: input.runId })).result.state === "succeeded");
  assert.equal(plans, 2);
  assert.equal(manager.calls.verify.length, 1);
});

test("native progress feedback validation fences a concurrent direct mutation borrowing the same global operation ID", async t => {
  const manager = syntheticManager("small", 1, { hold: true, publish: true });
  const f = await nativeWorkspace(t, { manager: manager.config });
  f.addCleanup(manager.release);
  const input = manager.start("feedback-race");
  assert.ok((await f.call("manager.runtime.start", input)).result);
  await until(() => manager.calls.published === 1);
  const active = (await f.call("manager.runtime.get", { runId: input.runId })).result;
  const operationId = randomUUID();
  const feedback = f.call("manager.progress.feedback", {
    operationId, runId: input.runId, expectedVersion: active.version, target: { kind: "task", taskId: "worker-1" }, message: "Exact target only.",
  });
  const direct = f.call("manager.runtime.cancel", { operationId, runId: input.runId, expectedVersion: active.version });
  const [queued, denied] = await Promise.all([feedback, direct]);
  assert.ok(queued.result, JSON.stringify(queued));
  assert.equal(denied.error.code, "BUSY", JSON.stringify(denied));
  assert.equal((await f.call("manager.runtime.get", { runId: input.runId })).result.state, "active");
  manager.release();
  await until(async () => (await f.call("manager.runtime.get", { runId: input.runId })).result.state === "succeeded");
});
