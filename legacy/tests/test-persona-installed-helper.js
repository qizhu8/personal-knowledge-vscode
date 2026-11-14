const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");

test("installed Profile helper self-check prepares real local HTTP requests and verifies retained history in a fresh process", t => {
  const root = path.join(__dirname, `.profile-installed-helper-${randomUUID()}`);
  fs.mkdirSync(path.join(root, "knowledge"), { recursive:true, mode:0o700 });
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const program = `
    const path = require("node:path"), Module = require("node:module");
    const root = process.argv[1], phase = process.argv[2], extensionPath = process.cwd();
    const original = Module._load;
    const host = {
      env:{ language:"en" }, commands:{}, window:{
        showInformationMessage:async () => undefined,
        showWarningMessage:async () => undefined,
        showErrorMessage:async () => undefined
      },
      Uri:{ file:fsPath => ({ fsPath }) },
      workspace:{ isTrusted:true, workspaceFolders:[], getConfiguration:() => ({
        get:(key, fallback) => key === "storePath" ? path.join(root, "knowledge") : fallback
      }) },
      lm:{ tools:[] },
    };
    Module._load = function(name, ...args) { return name === "vscode" ? host : original.call(this, name, ...args); };
    require(path.join(extensionPath, "dist/knowledge/filestore")).getStorePath = () => path.join(root, "knowledge");
    const helper = require(path.join(extensionPath, "tests/ctx-host/persona"));
    helper.run({ extensionPath }, root, phase)
      .then(result => console.log("PERSONA_RESULT=" + JSON.stringify(result)))
      .catch(error => { console.error(error.stack); process.exitCode = 1; });
  `;
  const results = ["initial", "restart"].map(phase => {
    const child = spawnSync(process.execPath, ["-e", program, root, phase], {
      cwd:path.join(__dirname, ".."), encoding:"utf8", timeout:20000, maxBuffer:256 * 1024,
    });
    assert.equal(child.status, 0, `${phase}: ${child.error?.message || ""}\n${child.stderr}\n${child.stdout}`);
    const line = child.stdout.split("\n").find(value => value.startsWith("PERSONA_RESULT="));
    assert(line, `Missing ${phase} helper result`);
    return JSON.parse(line.slice("PERSONA_RESULT=".length));
  });
  const [initial, restart] = results;
  assert.equal(initial.actualPreparedAndSent, true);
  assert.equal(initial.immutableAfterEditAndDelete, true);
  assert.equal(initial.requests, 2);
  assert.equal(restart.requests, 0);
  assert.equal(restart.restartRetained, true);
  assert.notEqual(initial.pid, restart.pid);
  assert.equal(restart.initialPid, initial.pid);
  for (const result of results) {
    assert.equal(result.historicalSnapshots, 2);
    assert.equal(result.historicalEvidenceRetained, true);
    assert.equal(result.deletedProfilesNotReused, true);
  }
  assert.equal(initial.firstEvidenceHash, restart.firstEvidenceHash);
  assert.equal(initial.secondEvidenceHash, restart.secondEvidenceHash);
});
