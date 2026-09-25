#!/usr/bin/env node
const assert = require("assert");
const { GitHubSyncScheduler } = require("../dist/github-sync-scheduler.js");

const flush = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  let now = Date.parse("2026-09-24T20:00:00.000Z");
  let nextTimer = 1;
  const timers = new Map();
  const calls = [];
  const checks = [];
  let dirty = false;
  let release;
  const scheduler = new GitHubSyncScheduler({
    now: () => now,
    setTimeout: (callback, delay) => {
      const timer = { id: nextTimer++, unref() {} };
      timers.set(timer.id, { callback, delay });
      return timer;
    },
    clearTimeout: timer => timers.delete(timer.id),
    changeDebounceMs: 25,
    shouldExecute: async (targetId, reason) => {
      checks.push([targetId, reason]);
      return dirty;
    },
    execute: async (targetId, reason) => {
      calls.push([targetId, reason]);
      dirty = false;
      await new Promise(resolve => { release = resolve; });
    }
  });

  scheduler.configure([{
  id: "primary",
  enabled: true,
  intervalMinutes: 5,
  syncOnChange: true,
  lastSuccessAt: "2026-09-24T19:59:00.000Z"
  }]);
  assert.strictEqual(Object.values(scheduler.snapshot())[0].nextSyncAt, "2026-09-24T20:04:00.000Z");
  assert.strictEqual(calls.length, 0, "configuration must not start a periodic sync before the throttle window");

  const [startupTimerId, startupTimer] = [...timers.entries()].find(([, timer]) => timer.delay === 4 * 60_000);
  timers.delete(startupTimerId);
  now += 4 * 60_000;
  startupTimer.callback();
  await flush();
  await flush();
  assert.deepStrictEqual(checks, [["primary", "startup"]]);
  assert.deepStrictEqual(calls, [], "an unchanged startup check must not enter the Git sync operation");
  assert.strictEqual(timers.size, 0, "a clean check must not schedule periodic work");

  dirty = true;
  scheduler.notifyContentChanged();
  scheduler.notifyContentChanged();
  assert.strictEqual(timers.size, 1, "rapid content changes must share one debounce timer");
  const [changeTimerId, changeTimer] = [...timers.entries()].find(([, timer]) => timer.delay === 25);
  timers.delete(changeTimerId);
  changeTimer.callback();
  await flush();
  assert.deepStrictEqual(calls, [["primary", "change"]]);
  assert.strictEqual(scheduler.snapshot().primary.status, "syncing");

  dirty = true;
  scheduler.request("primary", "change");
  scheduler.request("primary", "change");
  assert.strictEqual(timers.size, 1, "changes during a sync must coalesce behind the minimum interval");
  assert.strictEqual([...timers.values()][0].delay, 5 * 60_000);
  release();
  await flush();
  await flush();
  assert.deepStrictEqual(calls, [["primary", "change"]], "a queued change must not bypass the minimum interval");

  const [throttleTimerId, throttleTimer] = [...timers.entries()][0];
  timers.delete(throttleTimerId);
  now += 5 * 60_000;
  throttleTimer.callback();
  await flush();
  await flush();
  assert.deepStrictEqual(calls, [["primary", "change"], ["primary", "change"]], "coalesced changes run once when the throttle window expires");
  release();
  await flush();
  await flush();
  assert.strictEqual(scheduler.snapshot().primary.status, "scheduled");
  assert.strictEqual(timers.size, 0, "a successful sync with no later changes must not schedule another sync");

  scheduler.dispose();
  assert.strictEqual(timers.size, 0);

  const failureTimers = new Map();
  const failing = new GitHubSyncScheduler({
    now: () => now,
    setTimeout: (callback, delay) => {
      const timer = { id: nextTimer++, unref() {} };
      failureTimers.set(timer.id, { callback, delay });
      return timer;
    },
    clearTimeout: timer => failureTimers.delete(timer.id),
    shouldExecute: async () => true,
    execute: async () => { throw new Error("authentication expired"); }
  });
  failing.configure([
    { id: "paused", enabled: false, intervalMinutes: 5, syncOnChange: true },
    { id: "retry", enabled: true, intervalMinutes: 5, syncOnChange: true }
  ]);
  assert.strictEqual(failing.snapshot().paused.status, "paused");
  await flush();
  await flush();
  assert.strictEqual(failing.snapshot().retry.status, "error");
  assert([...failureTimers.values()].some(timer => timer.delay === 5 * 60_000), "a failed backup waits for the configured interval before retrying");
  failing.dispose();

  console.log("github-sync scheduler tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
