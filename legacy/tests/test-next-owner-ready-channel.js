"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const dist = process.env.PKM_TEST_NEXT_DIST;
test("private Next readiness is emitted only after the actual stdio server starts",
  { skip: !dist, timeout: 30000 }, async () => {
    const parent = path.resolve(".migration-test-work", `next-owner-ready-${randomUUID()}`);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const root = path.join(parent, "workspace"), cli = path.join(dist, "cli.js");
    const env = { ...process.env, TMPDIR: parent };
    const init = spawnSync(process.execPath, [cli, "init", "--data", root],
      { cwd: parent, env, encoding: "utf8", timeout: 30000 });
    assert.equal(init.status, 0, init.stderr);
    async function run(directory, nonce, closeAfterReady, readyPipe = true) {
      const child = spawn(process.execPath, [cli, "mcp", "--data", directory, "--experimental-legacy-mcp"],
        { cwd: parent, env: { ...env, PKM_NEXT_OWNER_READY_NONCE: nonce },
          stdio: readyPipe ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"] });
      let ready = "", stderr = "";
      child.stdout.resume();
      child.stderr.on("data", data => { stderr += data; });
      child.stdio[3]?.on("data", data => { ready += data; });
      if (closeAfterReady) child.stdio[3].once("end", () => child.stdin.end());
      const [code, signal] = await new Promise(resolve => child.once("close", (code, signal) => resolve([code, signal])));
      return { ready, stderr, code, signal };
    }
    const nonce = "a".repeat(64), live = await run(root, nonce, true);
    assert.equal(live.ready, `${nonce}\n`);
    assert.equal(live.code, 0, live.stderr);
    assert.equal(live.signal, null);
    const invalid = await run(root, "bad", false);
    assert.equal(invalid.ready, "");
    assert.notEqual(invalid.code, 0);
    const missing = await run(path.join(parent, "missing"), nonce, false);
    assert.equal(missing.ready, "");
    assert.notEqual(missing.code, 0);
    const disconnected = await run(root, nonce, false, false);
    assert.equal(disconnected.ready, "");
    assert.notEqual(disconnected.code, 0);
    if (process.platform === "linux") {
      const unlocked = spawnSync("flock", ["-n", root, "true"], { cwd: parent, env, timeout: 5000 });
      assert.equal(unlocked.status, 0, "Failed startup must release its root fence.");
    }
  });
