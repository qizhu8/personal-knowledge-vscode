"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const { runPlan } = require("./engine.cjs");
const { cleanupRegistered } = require("./recover.cjs");
const { createWorkspace } = require("./workspace.cjs");
const { fixtureRequirements, preparationCommand } = require("./fixtures.cjs");

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-engine-"));
  const root = path.join(parent, "project"), scratch = path.join(parent, "scratch");
  fs.mkdirSync(root); fs.mkdirSync(scratch);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  t.after(() => fs.rmSync(parent, { recursive: true }));
  return { parent, root, scratch, options: { repositoryRoot: root, temporaryParent: scratch, reportDirectory: path.join(parent, "reports") } };
}

function entry(name, source, extras = {}) {
  return { id: name, name, role: "test", layer: "component", language: "node", capabilities: [],
    command: [process.execPath, "-e", source], timeoutMs: 10000, ...extras };
}

function plan(entries) { return { profile: "fixture", fingerprint: "fixture-source", entries }; }

test("one build is reused without leaking checkout writes between suites; deleting old artifacts and readonly prepared ownership both survive layering", async t => {
  const context = fixture(t), counter = path.join(context.parent, "build-count");
  fs.writeFileSync(path.join(context.root, "obsolete"), "stale");
  const read = 'const fs=require("node:fs"),a=require("node:assert/strict");a.equal(fs.readFileSync("built","utf8"),"prepared");a.equal(fs.existsSync("obsolete"),false);';
  const result = await runPlan(plan([
    entry("first", `${read}a.throws(()=>fs.writeFileSync(process.env.PKM_TEST_PREPARED_ROOT+"/owner.json","{}"),/EROFS|EACCES/);fs.writeFileSync("built","poison");`, { resources: ["same-layer"] }),
    entry("second", read, { resources: ["same-layer"] }),
  ]), { ...context.options, buildCommand: [process.execPath, "-e",
    'const fs=require("node:fs");fs.writeFileSync("built","prepared");fs.rmSync("obsolete");fs.appendFileSync(process.argv[1],"1");', counter] });
  assert.equal(result.summary.successful, true, JSON.stringify(result.results));
  assert.equal(fs.readFileSync(counter, "utf8"), "1");
  assert.equal(fs.readFileSync(path.join(context.root, "obsolete"), "utf8"), "stale");
  assert.equal(fs.existsSync(path.join(context.root, "built")), false);
  assert.deepEqual(fs.readdirSync(context.scratch), []);
});

test("selected host preparation replaces stale Core, retained modules and host payload in the disposable layer", async t => {
  const context = fixture(t), host = "clients/vscode-host";
  const files = {
    "package.json": JSON.stringify({ scripts: { build: "node build.cjs", "build:compat": "node compat.cjs" } }),
    "build.cjs": 'require("node:fs").copyFileSync("source.cjs","dist/source.cjs");',
    "compat.cjs": 'require("node:fs").copyFileSync("retained.cjs","legacy/dist/retained.cjs");',
    "source.cjs": 'module.exports = "current-core";',
    "retained.cjs": 'module.exports = "current-retained";',
    "dist/source.cjs": 'module.exports = "stale-core";',
    "legacy/dist/retained.cjs": 'module.exports = "stale-retained";',
    [`${host}/package.json`]: JSON.stringify({ scripts: { build: "node build.cjs" } }),
    [`${host}/build.cjs`]: 'const fs=require("node:fs");fs.copyFileSync("../../dist/source.cjs","next-runtime/server/dist/source.cjs");fs.copyFileSync("../../legacy/dist/retained.cjs","next-runtime/legacy/dist/retained.cjs");fs.writeFileSync("dist/extension.cjs",\'module.exports = "current-host";\');',
    [`${host}/dist/extension.cjs`]: 'module.exports = "stale-host";',
    [`${host}/next-runtime/server/dist/source.cjs`]: 'module.exports = "stale-payload";',
    [`${host}/next-runtime/legacy/dist/retained.cjs`]: 'module.exports = "stale-payload-retained";',
  };
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(context.root, file)), { recursive: true });
    fs.writeFileSync(path.join(context.root, file), contents);
  }
  const prepare = path.join(context.root, "tests/framework/fixtures.cjs");
  fs.mkdirSync(path.dirname(prepare), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "fixtures.cjs"), prepare);
  const entries = [entry("host-source", `
    const assert=require("node:assert/strict");
    assert.equal(require("./${host}/dist/extension.cjs"),"current-host");
    assert.equal(require("./${host}/next-runtime/server/dist/source.cjs"),"current-core");
    assert.equal(require("./${host}/next-runtime/legacy/dist/retained.cjs"),"current-retained");
  `, { fixtures: fixtureRequirements({ hostBuild: true }) })];
  const result = await runPlan(plan(entries), { ...context.options,
    buildCommand: [process.execPath, prepare, ...preparationCommand(entries).slice(2)],
  });
  assert.equal(result.summary.successful, true, JSON.stringify(result.results));
  for (const [file, contents] of Object.entries(files))
    assert.equal(fs.readFileSync(path.join(context.root, file), "utf8"), contents, file);
  assert.deepEqual(fs.readdirSync(context.scratch), []);
});

test("bounded scheduler admits two jobs but never overlaps users of one resource", async t => {
  const context = fixture(t);
  let active = 0, maximum = 0, shared = 0, sharedMaximum = 0;
  const results = await runPlan(plan([
    entry("locked-a", "setTimeout(()=>{},100)", { resources: ["shared"] }),
    entry("locked-b", "setTimeout(()=>{},100)", { resources: ["shared"] }),
    entry("independent", "setTimeout(()=>{},100)"),
  ]), { ...context.options, noBuild: true, jobs: 2, onEvent(event) {
    if (event.type === "start") { maximum = Math.max(maximum, ++active); if (event.name.startsWith("locked")) sharedMaximum = Math.max(sharedMaximum, ++shared); }
    if (event.type === "complete") { active--; if (event.name.startsWith("locked")) shared--; }
  } });
  assert.equal(results.summary.successful, true);
  assert.equal(maximum, 2); assert.equal(sharedMaximum, 1);
  assert.deepEqual(fs.readdirSync(context.scratch), []);
});

test("compatibility fixture parents and temporary work remain private and are reclaimed after execution", async t => {
  const context = fixture(t);
  const result = await runPlan(plan([entry("fixture-contract",
    'const fs=require("node:fs");fs.mkdirSync(".migration-test-work/fixture");fs.writeFileSync(process.env.TMPDIR+"/fixture","owned");')]),
  { ...context.options, noBuild: true });
  assert.equal(result.summary.successful, true, JSON.stringify(result.results));
  assert.equal(fs.existsSync(path.join(context.root, ".migration-test-work")), false);
  assert.deepEqual(fs.readdirSync(context.scratch), []);
});

test("v5 tests consume their current readonly source build without old branch environment bindings", async t => {
  const context = fixture(t);
  fs.mkdirSync(path.join(context.root, "dist"));
  fs.writeFileSync(path.join(context.root, "dist", "fixture.cjs"), 'module.exports = "current-source";');
  const result = await runPlan(plan([entry("source-bindings",
    'const a=require("node:assert/strict");a.equal(require("./dist/fixture.cjs"),"current-source");require("node:fs").writeFileSync(process.env.TMPDIR+"/owned","fixture");')]),
  { ...context.options, noBuild: true });
  assert.equal(result.summary.successful, true, JSON.stringify(result.results));
  assert.deepEqual(fs.readdirSync(context.scratch), []);
});

test("build failure blocks assertions and cancellation never starts queued jobs", async t => {
  const context = fixture(t), executions = [];
  const entries = [entry("one", "setTimeout(()=>{},5000)"), entry("two", "process.exit(0)"), entry("three", "process.exit(0)")];
  const setup = await runPlan(plan(entries), { ...context.options, buildCommand: [process.execPath, "-e", "process.exit(1)"] });
  assert.equal(setup.summary.counts.blocked, 3);
  const controller = new AbortController();
  const cancelled = await runPlan(plan(entries), { ...context.options, noBuild: true, jobs: 1, signal: controller.signal,
    onEvent(event) { if (event.type === "start") { executions.push(event.name); setTimeout(() => controller.abort(), 100); } } });
  assert.deepEqual(executions, ["one"]);
  assert.equal(cancelled.summary.counts.cancelled, 3);
  assert.deepEqual(fs.readdirSync(context.scratch), []);
});

test("all-skipped Node cases and unmatched selectors cannot produce successful tests", async t => {
  const context = fixture(t);
  await assert.rejects(runPlan(plan([]), context.options), /non-empty/);
  fs.writeFileSync(path.join(context.root, "test.cjs"), 'require("node:test").skip("absent runtime",()=>{});');
  const result = await runPlan(plan([entry("skip", "", { command: [process.execPath, "--test", "test.cjs"] })]), { ...context.options, noBuild: true });
  assert.equal(result.summary.successful, false);
  assert.match(result.results[0].error, /no passing tests/);
  assert.equal(result.results[0].cleaned, true);
});

test("an early TAP assertion remains visible after later output evicts it from bounded tails", async t => {
  const context = fixture(t);
  fs.writeFileSync(path.join(context.root, "test.cjs"), `
    const test = require("node:test"), assert = require("node:assert/strict");
    test("early failure", () => assert.equal(1, 2, "original assertion must survive"));
    test("later noise", async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      console.log("later output".repeat(5000));
    });
  `);
  const result = await runPlan(plan([entry("noisy-failure", "", {
    command: [process.execPath, "--test", "test.cjs"],
  })]), { ...context.options, noBuild: true });
  assert.equal(result.summary.counts.failed, 1);
  assert(!result.results[0].stdout.includes("original assertion must survive"));
  const report = JSON.parse(fs.readFileSync(result.report, "utf8"));
  assert.match(report.details[0].tapFailures, /original assertion must survive/);
  assert(Buffer.byteLength(report.details[0].tapFailures) <= 4096);
  assert(fs.statSync(result.report).size <= 64 * 1024);
  assert.deepEqual(fs.readdirSync(context.scratch), []);
});

test("packaging runs only after passing prerequisites and exports only its generated artifact", async t => {
  const context = fixture(t);
  const finalizer = entry("package", 'require("node:fs").writeFileSync("fixture.vsix","verified fixture archive")', {
    role: "artifact", finalizer: true, exportVsix: "fixture.vsix",
  });
  const failed = await runPlan(plan([entry("test", "process.exit(1)"), finalizer]), { ...context.options, noBuild: true });
  assert.equal(failed.results[1].outcome, "blocked");
  assert.equal(fs.existsSync(path.join(context.root, "fixture.vsix")), false);
  const success = await runPlan(plan([entry("test", "process.exit(0)"), finalizer]), { ...context.options, noBuild: true });
  assert.equal(success.summary.successful, true);
  assert.equal(fs.readFileSync(path.join(context.root, "fixture.vsix"), "utf8"), "verified fixture archive");
  assert.deepEqual(fs.readdirSync(context.scratch), []);
});

test("crash recovery never erases a changed child's owner through parent cleanup", t => {
  const context = fixture(t), root = createWorkspace(context.root, context.scratch);
  const child = createWorkspace(context.root, path.join(root.directory, "tmp"));
  fs.writeFileSync(path.join(child.directory, "owner.json"), '{"token":"changed"}');
  assert.throws(() => cleanupRegistered(context.root, [root.record, child.record]), /ownership changed/);
  assert(fs.existsSync(child.directory));
  fs.writeFileSync(path.join(child.directory, "owner.json"), JSON.stringify({ token: child.token }));
  cleanupRegistered(context.root, [root.record, child.record]);
  assert.deepEqual(fs.readdirSync(context.scratch), []);
});

test("forced coordinator death releases a detached fixture's external lock before supervised workspace removal", async t => {
  const context = fixture(t), ready = path.join(context.parent, "ready"), lease = path.join(context.parent, "lease");
  const actor = `require("node:child_process").spawn("/usr/bin/python3",["-B","-c",${JSON.stringify(
    `import fcntl,time\nfrom pathlib import Path\nf=open(${JSON.stringify(lease)},"w")\nfcntl.flock(f,fcntl.LOCK_EX)\nPath(${JSON.stringify(ready)}).write_text("ready")\ntime.sleep(120)`)}],{detached:true,stdio:"ignore"}).unref();setInterval(()=>{},1000);`;
  const source = `const {runSupervised}=require(${JSON.stringify(path.join(__dirname, "supervised.cjs"))});runSupervised(${JSON.stringify(plan([entry("orphan", actor)]))},${JSON.stringify({ ...context.options, noBuild: true })}).catch(e=>{console.error(e.message);process.exitCode=1});`;
  const child = spawn(process.execPath, ["-e", source], { stdio: "ignore" });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert(fs.existsSync(ready), "managed detached fixture did not acquire its lease");
  const closed = new Promise(resolve => child.once("close", resolve));
  child.kill("SIGKILL");
  await closed;
  while (fs.readdirSync(context.scratch).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(fs.readdirSync(context.scratch), [], "crashed coordinator left live workspaces");
  const probe = spawnSync("/usr/bin/python3", ["-B", "-c",
    `import fcntl\nf=open(${JSON.stringify(lease)},"r")\nfcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)`], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(context.parent, "reports", "last-failure.json"))).interrupted, true);
});
