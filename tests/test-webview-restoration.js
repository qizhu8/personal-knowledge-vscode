#!/usr/bin/env node
const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-webview-restoration-"));
const compiled = path.join(fixture, "webview-restoration.js");
childProcess.execFileSync("npx", [
  "esbuild",
  path.join(root, "src", "webview-restoration.ts"),
  "--bundle",
  "--platform=node",
  "--format=cjs",
  `--outfile=${compiled}`,
], { cwd: root, stdio: "ignore" });

const { scheduleRestoredWebviewRecovery } = require(compiled);
const scheduled = [];
const schedule = (callback, delay) => {
  scheduled.push({ callback, delay });
  return { unref() {} };
};

let ready = false;
let current = true;
let recoveries = 0;
const timer = scheduleRestoredWebviewRecovery({
  restored: true,
  isReady: () => ready,
  isCurrent: () => current,
  recover: () => recoveries++,
  schedule,
});
assert(timer, "a restored webview must get a bounded readiness watchdog");
assert.strictEqual(scheduled[0].delay, 10_000);
scheduled[0].callback();
assert.strictEqual(recoveries, 1, "an unready restored webview must be recreated once");

ready = true;
scheduleRestoredWebviewRecovery({
  restored: true,
  isReady: () => ready,
  isCurrent: () => true,
  recover: () => recoveries++,
  schedule,
});
scheduled[1].callback();
assert.strictEqual(recoveries, 1, "a ready restored webview must not be recreated");

ready = false;
current = false;
scheduleRestoredWebviewRecovery({
  restored: true,
  isReady: () => ready,
  isCurrent: () => current,
  recover: () => recoveries++,
  schedule,
});
scheduled[2].callback();
assert.strictEqual(recoveries, 1, "a superseded restored webview must not affect the current panel");

const before = scheduled.length;
const newPanelTimer = scheduleRestoredWebviewRecovery({
  restored: false,
  isReady: () => false,
  isCurrent: () => true,
  recover: () => recoveries++,
  schedule,
});
assert.strictEqual(newPanelTimer, undefined);
assert.strictEqual(scheduled.length, before, "a newly created replacement must not start another recovery loop");

const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
assert.match(extensionSource, /restored panel did not become ready; recreating the webview/);
assert.match(extensionSource, /if \(_panelRestoredRecoveryTimer\) clearTimeout\(_panelRestoredRecoveryTimer\)/);

fs.rmSync(fixture, { recursive: true, force: true });
console.log("webview restoration tests passed");
