#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const timers = [], exportsObject = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../dist/runtime/action-background-tasks.js"), "utf8"), {
  exports: exportsObject, require, console,
  setInterval(callback, delay) { const timer = { callback, delay, unref() {}, cleared: false }; timers.push(timer); return timer; },
  clearInterval(timer) { timer.cleared = true; },
});
(async () => {
  const registry = { set() {}, remove() {} };
  const inert = new exportsObject.ActionBackgroundTasks(registry, () => "");
  assert.strictEqual(timers.length, 1, "Existing tests/default dependencies never scan automatically");
  inert.dispose();
  let enabled = false, calls = 0, finish;
  const errors = [];
  const monitor = new exportsObject.ActionBackgroundTasks(registry, () => "/fixture/no-live-store", {
    enabled: () => enabled,
    scan: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    report: error => errors.push(error.message),
  });
  assert.strictEqual(calls, 0);
  assert(timers.some(timer => timer.delay === 30000));
  enabled = true;
  timers.find(timer => !timer.cleared && timer.delay === 2000).callback();
  assert.strictEqual(calls, 1, "Initial scan waits for trusted/configured dependencies");
  await monitor.scan(); assert.strictEqual(calls, 1, "No overlapping calls");
  finish(); await Promise.resolve(); await Promise.resolve();
  monitor.safety.scan = async () => { calls++; throw Error("diagnostic scan failure"); };
  await monitor.scan();
  assert.deepStrictEqual(errors, ["diagnostic scan failure"]);
  enabled = false; await monitor.scan(); assert.strictEqual(calls, 2);
  monitor.dispose(); enabled = true; await monitor.scan(); assert.strictEqual(calls, 2);
  assert(timers.every(timer => timer.cleared));
  console.log("P3 TS lifecycle integration: opt-in dependencies, initial/30s scans, no overlap, diagnostics and disposal passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
