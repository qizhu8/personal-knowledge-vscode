const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { options } = require("./next-trial-electron/in-place-options.cjs");

function fixture(t) {
  const directory = path.resolve(".migration-test-work", `upgrade-authority-${randomUUID()}`);
  const root = path.join(directory, "legacy"), nonce = randomUUID();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "in-place-fixture-token"), nonce, { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { fixture: directory, root, nonce, workspaceId: randomUUID() };
}

test("experimental fixture snapshot approval rejects another root, actor, workspace and tool scope", t => {
  const f = fixture(t), configured = options(f), admission = configured.snapshotAdmission;
  const stat = fs.statSync(f.root, { bigint: true });
  const binding = {
    workspaceId: f.workspaceId, workspaceRoot: f.root, actorId: "mcp:external",
    authorityId: admission.authorityId, privateGitRoot: path.join(f.root, "packages/knowledge-snapshots/repository.git"),
    allowedTools: admission.allowedTools, operation: "admit", rootPin: `${stat.dev}:${stat.ino}`,
  };
  assert.equal(admission.authorize(binding), true);
  for (const changed of [{ workspaceRoot: f.fixture }, { actorId: "local:owner" }, { workspaceId: randomUUID() },
    { authorityId: "other" }, { privateGitRoot: f.root }, { operation: "restore" }, { rootPin: "1:2" },
    { allowedTools: [...binding.allowedTools, "knowledge_snapshot_configure"] }])
    assert.equal(admission.authorize({ ...binding, ...changed }), false);
});

test("experimental fixture admission requires its token and a root directly inside the fixture", t => {
  const f = fixture(t);
  assert.throws(() => options({ ...f, nonce: "wrong" }));
  assert.throws(() => options({ ...f, fixture: path.dirname(f.fixture) }));
});

test("private Linux upgrade namespace reaps real orphan daemons instead of leaving apparently-live zombies",
  { skip: process.platform !== "linux" }, () => {
    const { privateNamespaceArgs } = require("../scripts/run-next-trial-private-display.js");
    const orphan = "const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),100)'],"
      + "{detached:true,stdio:'ignore'}); console.log(c.pid); c.unref();";
    const probe = `
      const assert=require('node:assert/strict');
      const {spawnSync}=require('node:child_process');
      const result=spawnSync(process.execPath,['-e',${JSON.stringify(orphan)}],{encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
      const pid=Number(result.stdout.trim());
      assert(pid>1);
      setTimeout(()=>{
        assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
        console.log('actual orphan reaped');
      },500);`;
    const result = spawnSync("unshare", privateNamespaceArgs([process.execPath, "-e", probe]), {
      encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 0, String(result.error || result.stderr));
    assert.match(result.stdout, /actual orphan reaped/);
  });

test("VSIX inventory excludes private upgrade fixtures and test-only lifecycle launchers", t => {
  const f = fixture(t), directory = f.fixture;
  fs.copyFileSync(path.resolve(".vscodeignore"), path.join(directory, ".vscodeignore"));
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
    name: "private-upgrade-inventory", publisher: "fixture", version: "0.0.1",
    engines: { vscode: "^1.90.0" }, main: "./dist/extension.js", activationEvents: ["onStartupFinished"],
  }));
  for (const [file, contents] of [
    ["README.md", "Synthetic packaging inventory"],
    ["dist/extension.js", "exports.activate = () => {};"],
    [".migration-test-work/private-fixture.json", '{"neverShip":true}'],
    ["scripts/run-next-trial-electron-test.js", "test-only"],
    ["scripts/run-next-trial-private-display.js", "test-only"],
    ["scripts/stop-fixture-services.js", "test-only"],
    ["tests/next-trial-electron/chatroom-fixture.cjs", "test-only controlled provider"],
    ["tests/next-trial-electron/chatroom-live-fixture.cjs", "test-only archive"],
    ["tests/next-trial-electron/chatroom-live-journey.cjs", "test-only retained clients"],
    ["tests/next-trial-electron/api-chat-fixture.cjs", "test-only API state"],
    ["tests/next-trial-electron/in-place-server.cjs", "test-only crash injector"],
  ]) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), contents);
  }
  const result = spawnSync(process.platform === "win32" ? "vsce.cmd" : "vsce", ["ls", "--no-dependencies"], {
    cwd: directory, encoding: "utf8", timeout: 30000,
    env: { ...process.env, HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory },
  });
  assert.equal(result.status, 0, String(result.error || result.stderr));
  assert.match(result.stdout, /dist\/extension\.js/);
  assert.doesNotMatch(result.stdout, /private-fixture|run-next-trial|stop-fixture-services|chatroom-fixture|chatroom-live|api-chat-fixture|in-place-server/);
});
