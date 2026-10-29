#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { withCrossProcessLockSync } = require("../dist/runtime/cross-process-lock.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-cross-process-lock-"));
const lockPath = path.join(root, "projects.lock");
const releasedPath = path.join(root, "released");
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
    pid: 2147483647,
    nonce: "dead-process",
    acquiredAt: Date.now() - 60_000,
    owner: "Project store",
  }));
  assert.strictEqual(
    withCrossProcessLockSync(lockPath, "Project store", () => "recovered"),
    "recovered",
    "a dead legacy lock owner must be recoverable",
  );

  const child = spawn(process.execPath, ["-e", `
    const fs = require("fs");
    const path = require("path");
    const lock = process.argv[1];
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: "child", acquiredAt: Date.now(), owner: "Project store" }));
    const timeout = setTimeout(() => { throw new Error("No competing lock attempt"); }, 3000);
    const waiting = setInterval(() => {
      if (!fs.readdirSync(path.dirname(lock)).some(name => name.startsWith(path.basename(lock) + ".") && name.endsWith(".pending"))) return;
      clearInterval(waiting);
      clearTimeout(timeout);
      setTimeout(() => {
        fs.writeFileSync(process.argv[2], "released");
        fs.unlinkSync(lock);
        process.exit(0);
      }, 100);
    }, 10);
  `, lockPath, releasedPath], { stdio: "ignore" });
  waitForFile(lockPath);
  const startedAt = Date.now();
  assert.strictEqual(withCrossProcessLockSync(lockPath, "Project store", () => {
    assert(fs.existsSync(releasedPath), "a live competing window must release its lock before another writer enters");
    return "waited";
  }), "waited");
  assert(Date.now() - startedAt < 2000, "lock acquisition should continue as soon as the other window releases it");
  child.unref();

  console.log("cross-process lock tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
