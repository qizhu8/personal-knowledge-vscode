import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { validateManagerPlan } from "../dist/manager-plan.js";
import { startHttp } from "../dist/http.js";
import { initialize, Storage } from "../dist/storage.js";
import { managerPlanFixture } from "./manager-plan-fixtures.mjs";

export const managerActor = Object.freeze({ id: "native:batch06-owner", canWrite: true });
export const pin = letter => letter.repeat(64);
export const invocation = (operation, args) => ({ operation, version: 1, arguments: args });
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(read, label = "native state", timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
export function syntheticManager(kind = "migration", count = 20, options = {}) {
  const plan = managerPlanFixture(kind, count);
  plan.budget.maxConcurrentWorkers = Math.min(count, 4);
  const calls = { worker: [], freeze: [], integrate: [], verify: [], active: 0, peak: 0, published: 0 };
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const host = {
    authorizeTask: () => true,
    plan: async () => options.clarification
      ? { status: "needsClarification", questions: ["Specify objective-wide E2E acceptance."] }
      : validateManagerPlan(plan),
    worker: async (input, signal) => {
      calls.worker.push({ taskId: input.task.taskId, attemptId: input.attemptId,
        feedback: [...input.feedback], repairReason: input.repairReason });
      calls.active++; calls.peak = Math.max(calls.peak, calls.active);
      const delivery = { artifact: `synthetic:${input.task.taskId}`, pin: pin(input.repairReason ? "b" : "a"),
        workerId: `owner:${input.task.taskId}`, paths: [`deliverables/${input.task.taskId}/result.md`] };
      try {
        if (input.task.taskId === "worker-1" && options.hold && calls.worker.filter(call => call.taskId === "worker-1").length === 1) {
          if (options.publish) {
            input.publish({ grade: options.publishGrade ?? "delivery", delivery });
            calls.published++;
          }
          await Promise.race([barrier, new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }))]);
        }
        await sleep(2);
        return delivery;
      } finally { calls.active--; }
    },
    validate: async ({ delivery }) => ({ ok: true, pin: delivery.pin }),
    freeze: async input => {
      calls.freeze.push(input);
      return { pin: pin(calls.freeze.length === 1 ? "c" : "d") };
    },
    integrate: async input => {
      calls.integrate.push(input);
      return options.failIntegration && calls.integrate.length === 1
        ? { ok: false, taskId: "worker-2", reason: "Repair the exact frozen source owner." }
        : { ok: true, pin: pin("e") };
    },
    verify: async input => { calls.verify.push(input); return { ok: true, pin: pin("f") }; },
    ...options.host,
  };
  return {
    plan, calls, release, host,
    config: { ownerForActor: actorId => ({ actorId, nativeOwnerId: "batch06-native-owner" }), host, leaseMs: options.leaseMs ?? 5000 },
    start: runId => ({ operationId: randomUUID(), runId, projectId: `project-${kind}`, contract: plan.contract, budget: plan.budget }),
  };
}
export async function nativeWorkspace(t, nativeOptions = {}) {
  const root = resolve(import.meta.dirname, `.batch06-native-${randomUUID()}`);
  await initialize(root);
  let storage = await Storage.open(root);
  const configure = async options => typeof options === "function" ? options(root) : options;
  let runtime;
  try {
    runtime = await createNativeRuntime({ storage, ...await configure(nativeOptions) });
  } catch (error) {
    try { await storage.close(); } finally {
      storage = undefined;
      await rm(root, { recursive: true, force: true });
    }
    throw error;
  }
  const servers = new Set();
  const cleanup = [];
  const bearer = randomUUID() + randomUUID();
  const fixture = {
    root, bearer, get storage() { return storage; }, get runtime() { return runtime; },
    addCleanup(fn) { cleanup.push(fn); },
    async close() {
      for (const fn of cleanup.splice(0).reverse()) await fn();
      for (const server of servers) {
        await new Promise(resolve => server.close(resolve)); servers.delete(server);
      }
      if (runtime) { await runtime.close(); runtime = undefined; }
      if (storage) { await storage.close(); storage = undefined; }
    },
    async reopen(options = nativeOptions) {
      await fixture.close();
      storage = await Storage.open(root, { deferRecovery: true });
      runtime = await createNativeRuntime({ storage, ...await configure(options) });
    },
    async listen(actor = managerActor) {
      const listening = await startHttp(runtime.core, bearer, actor, 0);
      servers.add(listening.server);
      const ready = await fetch(`${listening.url}/v1/server_info`, {
        method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: "{}",
      });
      assert.equal(ready.status, 200, "bounded fixture server is responsive");
      return listening.url;
    },
    async call(operation, args, actor = managerActor) {
      return runtime.core.dispatch(operation.endsWith(".get") || operation.endsWith(".events") ? "capability_read" : "capability_call",
        invocation(operation, args), actor);
    },
  };
  t.after(async () => { try { await fixture.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  return fixture;
}
export async function httpCall(url, bearer, method, input, extraHeaders = {}, options = {}) {
  const response = await fetch(`${url}/v1/${method}`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(input), signal: options.signal,
  });
  return { status: response.status, body: await response.json() };
}
