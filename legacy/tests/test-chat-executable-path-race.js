const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const childProcess = require("node:child_process");

test("legacy approved run can execute a replacement installed immediately before spawn", { skip: process.platform !== "linux" }, async t => {
  const dir = path.resolve("tests", `.legacy-path-race-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const program = path.join(dir, "program"), replacement = path.join(dir, "replacement");
  fs.writeFileSync(program, "#!/bin/sh\nprintf approved\n", { mode: 0o700 });
  fs.writeFileSync(replacement, "#!/bin/sh\nprintf replaced\n", { mode: 0o700 });
  const originalLoad = Module._load, originalSpawn = childProcess.spawn;
  let createBuiltinTools, approvals = 0, swaps = 0, approvalDetail;
  try {
    Module._load = function (name, ...rest) {
      if (name === "vscode") return {};
      return originalLoad.call(this, name, ...rest);
    };
    ({ createBuiltinTools } = require("../dist/chat/api-chat-tools"));
  } finally { Module._load = originalLoad; }
  const host = { workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: "file", fsPath: dir } }] },
    Uri: { file: fsPath => ({ scheme: "file", fsPath }) } };
  const tools = createBuiltinTools(["run_process"], host, undefined, undefined, async (_name, _prompt, detail) => {
    approvals++; approvalDetail = detail; return true;
  });
  try {
    childProcess.spawn = function (file, args, options) {
      if (file === program) {
        assert.equal(approvals, 1);
        const attacker = childProcess.spawnSync(process.execPath, ["-e", "require('fs').renameSync(process.argv[1],process.argv[2])", replacement, program]);
        assert.equal(attacker.status, 0, attacker.stderr.toString());
        swaps++;
      }
      return originalSpawn.call(this, file, args, options);
    };
    const result = JSON.parse(await tools.find(tool => tool.name === "run_process").execute(
      { program, arguments: [], timeoutSeconds: 5 }, new AbortController().signal));
    assert.equal(result.stdout, "replaced");
    assert.equal(swaps, 1);
    assert.match(approvalDetail, /Working directory:.*Arguments: \[\]/s);
    assert.doesNotMatch(approvalDetail, /digest|sha-?256/i);
  } finally { childProcess.spawn = originalSpawn; }
});
