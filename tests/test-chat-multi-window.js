const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

test("Host, worker and managed runtime agree on the bundled retrieval version", () => {
  const root = path.resolve(__dirname, "..");
  const host = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
  const worker = fs.readFileSync(path.join(root, "resources/retrieval_worker.py"), "utf8");
  const runtime = fs.readFileSync(path.join(root, "src/mcp/mcp.ts"), "utf8");
  const version = /const RETRIEVAL_ENGINE_VERSION = "([^"]+)"/.exec(host)[1];
  assert.equal(/ENGINE_VERSION = "([^"]+)"/.exec(worker)[1], version,
    "a cold worker must not remain forever pending because the Host expects another build");
  assert(runtime.includes(`adaptive_skill_retrieval-${version}-py3-none-any.whl`));
});

test("four Chat Hosts serialize shared retrieval startup even if a creator is preempted", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-startup-"));
  const modulePath = path.resolve(__dirname, "../dist/retrieval/retrieval-worker.js");
  const children = [];
  t.after(() => {
    for (const child of children) child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const code = `
    const fs = require("node:fs"), path = require("node:path");
    const { RetrievalWorkerManager } = require(${JSON.stringify(modulePath)});
    const root = ${JSON.stringify(root)};
    const originalOpen = fs.openSync;
    fs.openSync = function(filename, flags, ...args) {
      const fd = originalOpen.call(this, filename, flags, ...args);
      if (path.basename(String(filename)) === "worker-transition.lock" && flags === "wx")
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      return fd;
    };
    const manager = new RetrievalWorkerManager(root, "unused.py", "unused", "test");
    process.once("message", async () => {
      try {
        for (let round = 0; round < 3; round++) {
          await manager.withTransitionLock(async () => {
            const marker = path.join(root, process.pid + ".active");
            fs.writeFileSync(marker, "");
            try {
              await new Promise(resolve => setTimeout(resolve, 50));
              if (fs.readdirSync(root).filter(name => name.endsWith(".active")).length !== 1)
                throw new Error("Multiple Hosts entered retrieval startup concurrently");
            } finally { fs.unlinkSync(marker); }
          }, 5000);
        }
        process.send({ ok: true });
      } catch (error) { process.send({ error: error.message }); process.exitCode = 1; }
      process.disconnect();
    });
    process.send({ ready: true });
  `;
  const ready = [], finished = [];
  for (let index = 0; index < 4; index++) {
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.push(child);
    let stderr = "", result;
    child.stderr.on("data", data => { stderr += data; });
    ready.push(new Promise((resolve, reject) => {
      child.on("message", message => { if (message.ready) resolve(); else result = message; });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Child exited before ready: " + stderr)));
    }));
    finished.push(new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => {
        if (code === 0 && result?.ok) resolve();
        else reject(new Error(result?.error || stderr || `Host exited ${code}`));
      });
    }));
  }
  await Promise.all(ready);
  for (const child of children) child.send({ start: true });
  await Promise.all(finished);
  assert.equal(fs.readdirSync(root).filter(name => name.endsWith(".active")).length, 0);
});
