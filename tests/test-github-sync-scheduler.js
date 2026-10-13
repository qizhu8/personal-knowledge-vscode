#!/usr/bin/env node
const assert = require("assert");
const { GitHubSyncScheduler } = require("../dist/sync/github-sync-scheduler.js");

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

  for (let event = 0; event < 3; event++) {
    now += 1_000;
    scheduler.notifyContentChanged();
    const [id, timer] = [...timers.entries()].find(([, timer]) => timer.delay === 25);
    timers.delete(id);
    timer.callback();
    await flush();
    await flush();
    assert.strictEqual(calls.length, 0, "unchanged watcher events never enter Git");
    assert.strictEqual(scheduler.snapshot().primary.nextSyncAt, "2026-09-24T20:12:00.000Z",
      "skipped change events must not postpone the periodic remote fetch");
  }

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
  const autoPaused = [];
  const failingTargets = [
    { id: "paused", enabled: false, intervalMinutes: 5, syncOnChange: true },
    { id: "retry", enabled: true, intervalMinutes: 9, syncOnChange: true }
  ];
  const failing = new GitHubSyncScheduler({
    now: () => now,
    setTimeout: (callback, delay) => {
      const timer = { id: nextTimer++, unref() {} };
      failureTimers.set(timer.id, { callback, delay });
      return timer;
    },
    clearTimeout: timer => failureTimers.delete(timer.id),
    onAutoPaused: targetId => autoPaused.push(targetId),
    shouldExecute: async () => true,
    execute: async () => { throw new Error("authentication expired"); }
  });
  failing.configure(failingTargets);
  assert.strictEqual(failing.snapshot().paused.status, "paused");
  assert.strictEqual(failing.request("paused", "manual"), true);
  await flush();
  await flush();
  assert.strictEqual(failing.snapshot().paused.status, "error", "manual failures remain visible when Auto Sync is off");
  assert.strictEqual(failing.snapshot().paused.lastError, "authentication expired");
  assert.strictEqual(failing.snapshot().retry.status, "error");
  assert([...failureTimers.values()].some(timer => timer.delay === 9 * 60_000), "a transient failure retries after the configured interval");
  assert.strictEqual(failing.request("retry", "change"), false, "file changes cannot revive a failed backup");
  for (let attempt = 2; attempt <= 3; attempt++) {
    const [timerId, timer] = [...failureTimers.entries()][0];
    failureTimers.delete(timerId);
    now += 9 * 60_000;
    timer.callback();
    await flush();
    await flush();
  }
  assert.strictEqual(failureTimers.size, 0, "automatic retries stop after three consecutive failures");
  assert.strictEqual(failingTargets[1].enabled, false, "exhausting automatic retries turns Auto Sync off for the failing target");
  assert.deepStrictEqual(autoPaused, ["retry"], "manual failures do not invoke automatic-pause persistence");
  assert.strictEqual(failing.snapshot().retry.lastError, "authentication expired", "auto-pause retains the actual failure");
  assert.strictEqual(failing.request("retry", "interval"), false, "the exhausted retry budget survives new automatic requests");
  assert.strictEqual(failing.request("retry", "manual"), true, "ordinary manual Sync remains available after auto-pause");
  await flush();
  failing.dispose();

  const toggleTimers = new Map();
  let failActiveSync;
  const toggledOff = new GitHubSyncScheduler({
    now: () => now,
    setTimeout: (callback, delay) => {
      const timer = { id: nextTimer++, unref() {} };
      toggleTimers.set(timer.id, { callback, delay });
      return timer;
    },
    clearTimeout: timer => toggleTimers.delete(timer.id),
    shouldExecute: async () => true,
    execute: () => new Promise((_resolve, reject) => { failActiveSync = reject; })
  });
  toggledOff.configure([{ id: "toggled-off", enabled: true, intervalMinutes: 5, syncOnChange: true }]);
  await flush();
  assert.strictEqual(toggledOff.snapshot()["toggled-off"].status, "syncing");
  toggledOff.configure([{ id: "toggled-off", enabled: false, intervalMinutes: 5, syncOnChange: true }]);
  failActiveSync(new Error("network unavailable"));
  await flush();
  assert.strictEqual(toggledOff.snapshot()["toggled-off"].status, "error");
  assert.strictEqual(toggleTimers.size, 0, "turning off Auto during an active failure must not schedule another attempt");
  assert.strictEqual(toggledOff.request("toggled-off", "interval"), false);
  toggledOff.dispose();

  const offSuccessTimers = new Map();
  let completeActive;
  let offSuccessCalls = 0;
  const offSuccess = new GitHubSyncScheduler({
    now: () => now,
    setTimeout: (callback, delay) => {
      const timer = { id: nextTimer++, unref() {} };
      offSuccessTimers.set(timer.id, { callback, delay });
      return timer;
    },
    clearTimeout: timer => offSuccessTimers.delete(timer.id),
    execute: async () => { offSuccessCalls++; await new Promise(resolve => { completeActive = resolve; }); },
  });
  offSuccess.configure([{ id: "off-success", enabled: true, intervalMinutes: 5, syncOnChange: true }]);
  await flush();
  offSuccess.request("off-success", "change");
  offSuccess.configure([{ id: "off-success", enabled: false, intervalMinutes: 5, syncOnChange: true }]);
  completeActive();
  await flush();
  await flush();
  assert.strictEqual(offSuccessCalls, 1, "disabling Auto cancels queued changes without aborting the active operation");
  assert.strictEqual(offSuccess.snapshot()["off-success"].status, "paused");
  assert.strictEqual(offSuccessTimers.size, 0, "finishing an active success after Auto is disabled cannot restart scheduling");
  offSuccess.dispose();

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

  const exhaustedPauses = [];
  const exhaustedTargets = [
    { id: "exhausted", enabled: true, intervalMinutes: 5, syncOnChange: true,
      lastFailure: { at: "2026-09-24T19:59:00.000Z", error: "network unavailable", reason: "interval", attempts: 3 } },
    { id: "healthy", enabled: true, intervalMinutes: 5, syncOnChange: true, lastSuccessAt: "2026-09-24T19:59:00.000Z" }
  ];
  const exhausted = new GitHubSyncScheduler({ ...persistedStateOptions, onAutoPaused: targetId => exhaustedPauses.push(targetId) });
  exhausted.configure(exhaustedTargets);
  assert.strictEqual(exhaustedTargets[0].enabled, false, "persisted exhausted failures reconcile Auto Sync on restart");
  assert.strictEqual(exhaustedTargets[1].enabled, true, "other targets retain their automation setting");
  assert.deepStrictEqual(exhaustedPauses, ["exhausted"]);
  assert.strictEqual(exhausted.snapshot().exhausted.lastError, "network unavailable");
  exhausted.dispose();

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
  assert.strictEqual(currentlyFailing.request("currently-failing", "change"), false);
  currentlyFailing.dispose();

  const pausedFailure = new GitHubSyncScheduler(persistedStateOptions);
  pausedFailure.configure([{
    id: "paused-failure", enabled: false, intervalMinutes: 5, syncOnChange: false,
    lastFailure: { at: "2026-09-24T19:59:00.000Z", error: "authentication expired", reason: "manual" }
  }]);
  assert.strictEqual(pausedFailure.snapshot()["paused-failure"].status, "error", "manual failures survive reloading the target");
  assert.strictEqual(pausedFailure.snapshot()["paused-failure"].lastError, "authentication expired");
  assert.strictEqual(pausedFailure.request("paused-failure", "manual"), true);
  await flush();
  await flush();
  assert.strictEqual(pausedFailure.snapshot()["paused-failure"].status, "paused", "a successful manual retry clears the failure");
  assert.strictEqual(pausedFailure.snapshot()["paused-failure"].lastError, undefined);
  pausedFailure.dispose();

  const skippedFailure = new GitHubSyncScheduler({ ...persistedStateOptions, shouldExecute: async () => false });
  skippedFailure.configure([{
    id: "skip-failure", enabled: false, intervalMinutes: 5, syncOnChange: false,
    lastFailure: { at: "2026-09-24T19:59:00.000Z", error: "failed before skip", reason: "manual" },
  }]);
  assert(skippedFailure.request("skip-failure", "manual"));
  await flush();
  await flush();
  assert.strictEqual(skippedFailure.snapshot()["skip-failure"].status, "error");
  assert.strictEqual(skippedFailure.snapshot()["skip-failure"].lastError, "failed before skip");
  assert(skippedFailure.snapshot()["skip-failure"].activityAt, "all visible scheduler transitions have a freshness timestamp");
  skippedFailure.dispose();

  let unchanged;
  unchanged = new GitHubSyncScheduler({
    ...persistedStateOptions,
    execute: async () => unchanged.report("no-change", "no-change", "No changes on this machine or GitHub"),
  });
  unchanged.configure([{ id: "no-change", enabled: false, intervalMinutes: 5, syncOnChange: false }]);
  assert(unchanged.request("no-change", "manual"));
  await flush();
  await flush();
  assert.strictEqual(unchanged.snapshot()["no-change"].phase, "no-change",
    "settling a successful execution must retain the actual No Change branch");
  unchanged.configure([{
    id: "no-change", enabled: false, intervalMinutes: 5, syncOnChange: false,
    lastSuccessAt: unchanged.snapshot()["no-change"].lastSuccessAt,
  }]);
  assert.strictEqual(unchanged.snapshot()["no-change"].phase, "no-change",
    "reconfiguring the same completed outcome must not erase its branch");
  unchanged.dispose();

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
