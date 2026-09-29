#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { withCrossProcessLockSync } = require("../dist/cross-process-lock.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-cross-process-lock-"));
const lockPath = path.join(root, "projects.lock");
const waitArray = new Int32Array(new SharedArrayBuffer(4));

function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    Atomics.wait(waitArray, 0, 0, 20);
  }
}

try {
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    nonce: "stale-same-process",
    acquiredAt: Date.now() - 60_000,
    owner: "Project store",
  }));
  assert.strictEqual(
    withCrossProcessLockSync(lockPath, "Project store", () => "recovered"),
    "recovered",
    "an expired lock whose Extension Host PID is still alive must be recoverable",
  );

  const child = spawn(process.execPath, ["-e", `
    const fs = require("fs");
    const lock = process.argv[1];
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: "child", acquiredAt: Date.now(), owner: "Project store" }));
    setTimeout(() => { fs.unlinkSync(lock); process.exit(0); }, 300);
  `, lockPath], { stdio: "ignore" });
  waitForFile(lockPath);
  const startedAt = Date.now();
  assert.strictEqual(withCrossProcessLockSync(lockPath, "Project store", () => "waited"), "waited");
  assert(Date.now() - startedAt >= 200, "a live competing window should receive a brief chance to release the lock");
  assert(Date.now() - startedAt < 2000, "lock acquisition should continue as soon as the other window releases it");
  child.unref();

  console.log("cross-process lock tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
