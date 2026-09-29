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
    intervalMinutes: 7,
    syncOnChange: true,
    lastSuccessAt: "2026-09-24T19:58:00.000Z"
  }]);
  assert.strictEqual(scheduler.snapshot().primary.nextSyncAt, "2026-09-24T20:05:00.000Z");
  assert.strictEqual([...timers.values()][0].delay, 5 * 60_000, "the persisted per-target interval determines the first due time");

  const [startupTimerId, startupTimer] = [...timers.entries()][0];
  timers.delete(startupTimerId);
  now += 5 * 60_000;
  startupTimer.callback();
  await flush();
  await flush();
  assert.deepStrictEqual(checks, [["primary", "startup"]]);
  assert.deepStrictEqual(calls, [], "an unchanged scheduled check must not enter the Git sync operation");
  assert.strictEqual([...timers.values()][0].delay, 7 * 60_000, "an unchanged check schedules the next configured interval");
  assert.strictEqual(scheduler.snapshot().primary.nextSyncAt, "2026-09-24T20:12:00.000Z");

  dirty = true;
  scheduler.notifyContentChanged();
  scheduler.notifyContentChanged();
  assert.strictEqual([...timers.values()].filter(timer => timer.delay === 25).length, 1, "rapid content changes share one debounce timer");
  const [changeTimerId, changeTimer] = [...timers.entries()].find(([, timer]) => timer.delay === 25);
  timers.delete(changeTimerId);
  changeTimer.callback();
  await flush();
  await flush();
  assert.deepStrictEqual(calls, [["primary", "change"]]);
  assert.strictEqual(timers.size, 0, "sync-on-change runs immediately after its debounce instead of waiting for the interval");
  assert.strictEqual(scheduler.snapshot().primary.status, "syncing");

  dirty = true;
  scheduler.request("primary", "change");
  scheduler.request("primary", "change");
  assert.strictEqual(timers.size, 0, "scheduler requests during a run remain immediately eligible");
  release();
  await flush();
  await flush();
  assert.deepStrictEqual(calls, [["primary", "change"], ["primary", "change"]],
    "content changes during a run coalesce into one immediate follow-up");
  release();
  await flush();
  await flush();
  assert.strictEqual([...timers.values()][0].delay, 7 * 60_000, "successful runs continue the periodic schedule");
  scheduler.dispose();

  const fanoutTimers = new Map();
  const fanoutCalls = [];
  const fanout = new GitHubSyncScheduler({
    setTimeout: (callback, delay) => {
      const timer = { id: nextTimer++, unref() {} };
      fanoutTimers.set(timer.id, { callback, delay });
      return timer;
    },
    clearTimeout: timer => fanoutTimers.delete(timer.id),
    changeDebounceMs: 25,
    execute: async (targetId, reason) => fanoutCalls.push([targetId, reason]),
  });
  fanout.configure([
    { id: "creative", enabled: true, intervalMinutes: 5, syncOnChange: true, lastSuccessAt: new Date().toISOString() },
    { id: "backup", enabled: true, intervalMinutes: 5, syncOnChange: true, lastSuccessAt: new Date().toISOString() },
  ]);
  fanout.notifyContentChanged("creative");
  const fanoutChangeTimers = [...fanoutTimers.entries()].filter(([, timer]) => timer.delay === 25);
  assert.strictEqual(fanoutChangeTimers.length, 1, "a pulled change schedules other targets only");
  const [fanoutTimerId, fanoutTimer] = fanoutChangeTimers[0];
  fanoutTimers.delete(fanoutTimerId);
  fanoutTimer.callback();
  await flush();
  await flush();
  assert.deepStrictEqual(fanoutCalls, [["backup", "change"]],
    "a source target pull fans out immediately to the other sync-on-change target");
  fanout.dispose();

  const manualTimers = new Map();
  const manualCalls = [];
  let releaseManual;
  const manual = new GitHubSyncScheduler({
    now: () => now,
    setTimeout: (callback, delay) => {
      const timer = { id: nextTimer++, unref() {} };
      manualTimers.set(timer.id, { callback, delay });
      return timer;
    },
    clearTimeout: timer => manualTimers.delete(timer.id),
    execute: async (targetId, reason) => {
      manualCalls.push([targetId, reason]);
      await new Promise(resolve => { releaseManual = resolve; });
    }
  });
  manual.configure([{ id: "manual", enabled: true, intervalMinutes: 11, syncOnChange: true, lastSuccessAt: new Date(now).toISOString() }]);
  assert.strictEqual(manual.request("manual", "manual"), true);
  assert.strictEqual(manual.request("manual", "manual"), false, "a second force request is rejected while the first is active");
  assert.deepStrictEqual(manualCalls, [["manual", "manual"]], "rapid force requests execute at most once");
  assert.strictEqual(manual.snapshot().manual.phase, "waiting-for-lock");
  manual.report("manual", "fetch", "Fetching origin/main");
  assert.strictEqual(manual.snapshot().manual.phase, "fetch");
  assert.strictEqual(manual.snapshot().manual.detail, "Fetching origin/main");
  releaseManual();
  await flush();
  await flush();
  assert.strictEqual(manual.snapshot().manual.phase, "scheduled");
  assert.strictEqual([...manualTimers.values()][0].delay, 11 * 60_000);
  manual.dispose();

  const pausedCalls = [];
  const pausedManual = new GitHubSyncScheduler({ execute: async (targetId, reason) => pausedCalls.push([targetId, reason]) });
  pausedManual.configure([{ id: "paused-manual", enabled: false, intervalMinutes: 5, syncOnChange: false }]);
  assert.strictEqual(pausedManual.request("paused-manual", "manual"), true, "Force Sync remains available when automatic backup is paused");
  await flush();
  assert.deepStrictEqual(pausedCalls, [["paused-manual", "manual"]]);
  assert.strictEqual(pausedManual.snapshot()["paused-manual"].status, "paused");
  pausedManual.dispose();

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
    { id: "retry", enabled: true, intervalMinutes: 9, syncOnChange: true }
  ]);
  assert.strictEqual(failing.snapshot().paused.status, "paused");
  await flush();
  await flush();
  assert.strictEqual(failing.snapshot().retry.status, "error");
  assert([...failureTimers.values()].some(timer => timer.delay === 9 * 60_000), "a failed backup retries after that target's configured interval");
  failing.dispose();

  const persistedStateOptions = {
    now: () => Date.parse("2026-09-24T20:00:00.000Z"),
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    execute: async () => {}
  };
  const recovered = new GitHubSyncScheduler(persistedStateOptions);
  recovered.configure([{
    id: "recovered",
    enabled: true,
    intervalMinutes: 5,
    syncOnChange: true,
    lastSuccessAt: "2026-09-24T19:59:00.000Z",
    lastFailure: {
      at: "2026-09-24T19:58:00.000Z",
      error: "old authentication failure",
      reason: "interval"
    }
  }]);
  assert.strictEqual(recovered.snapshot().recovered.status, "scheduled");
  assert.strictEqual(recovered.snapshot().recovered.lastError, undefined, "a newer success suppresses a stale persisted failure");
  recovered.dispose();

  const currentlyFailing = new GitHubSyncScheduler(persistedStateOptions);
  currentlyFailing.configure([{
    id: "currently-failing",
    enabled: true,
    intervalMinutes: 5,
    syncOnChange: true,
    lastSuccessAt: "2026-09-24T19:58:00.000Z",
    lastFailure: {
      at: "2026-09-24T19:59:00.000Z",
      error: "current authentication failure",
      reason: "interval"
    }
  }]);
  assert.strictEqual(currentlyFailing.snapshot()["currently-failing"].status, "error");
  assert.strictEqual(currentlyFailing.snapshot()["currently-failing"].lastError, "current authentication failure");
  currentlyFailing.dispose();

  const deletionTimers = new Map();
  let releaseDeleted;
  const deleted = new GitHubSyncScheduler({
    now: () => now,
    setTimeout: (callback, delay) => {
      const timer = { id: nextTimer++, unref() {} };
      deletionTimers.set(timer.id, { callback, delay });
      return timer;
    },
    clearTimeout: timer => deletionTimers.delete(timer.id),
    execute: async () => new Promise(resolve => { releaseDeleted = resolve; }),
  });
  deleted.configure([{ id: "delete-during-sync", enabled: true, intervalMinutes: 5, syncOnChange: true }]);
  await flush();
  assert.strictEqual(deleted.snapshot()["delete-during-sync"].status, "syncing");
  deleted.configure([]);
  assert.deepStrictEqual(deleted.snapshot(), {}, "deleting an active target removes its runtime state immediately");
  releaseDeleted();
  await flush();
  await flush();
  assert.deepStrictEqual(deleted.snapshot(), {}, "a completed in-flight operation cannot resurrect a deleted target");
  assert.strictEqual(deleted.request("delete-during-sync", "manual"), false);
  assert.strictEqual(deletionTimers.size, 0, "a deleted target cannot schedule a ghost retry");
  deleted.dispose();

  console.log("github-sync scheduler tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
