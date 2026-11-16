"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWorkspace, executeSuite } = require("./workspace.cjs");
const { fileSuite } = require("./suites.cjs");
const { fixtureRequirements } = require("./fixtures.cjs");

const repositoryRoot = path.resolve(__dirname, "../..");
const fixture = path.join(__dirname, "fixture.cjs");
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function context(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-framework-check-"));
  t.after(() => fs.rmSync(root, { recursive: true }));
  return { root, repositoryRoot, temporaryParent: root, reportDirectory: path.join(root, "reports") };
}

test("success isolates checkout writes, repairs only retired permission fixtures and removes all scratch data", async t => {
  const options = context(t);
  const manifest = fs.readFileSync(path.join(repositoryRoot, "package.json"));
  const testEntries = fs.readdirSync(path.join(repositoryRoot, "tests")).sort();
  const result = await executeSuite({ name: "success", command: [process.execPath, fixture, "success"] }, options);
  assert.equal(result.status, "passed", result.stderr || result.error);
  assert.equal(result.cleaned, true);
  assert.equal(fs.existsSync(result.workspace), false);
  assert(fs.readFileSync(path.join(repositoryRoot, "package.json")).equals(manifest));
  assert.deepEqual(fs.readdirSync(path.join(repositoryRoot, "tests")).sort(), testEntries);
  assert.equal(fs.existsSync(options.reportDirectory), false);
});

test("failure keeps one bounded summary and removes fixtures even for escape-heavy output", async t => {
  const options = context(t);
  const suite = { name: "failure", command: [process.execPath, fixture, "failure"] };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await executeSuite(suite, options);
    assert.equal(result.status, "failed");
    assert.equal(result.code, 7, result.stderr || result.error);
    assert.equal(result.cleaned, true);
    assert.equal(fs.existsSync(result.workspace), false);
    assert(fs.statSync(result.report).size <= 64 * 1024);
    assert.equal(JSON.parse(fs.readFileSync(result.report)).code, 7);
  }
  assert.deepEqual(fs.readdirSync(options.reportDirectory), ["last-failure.json"]);
});

test("private subscription fixtures receive namespace-local RAM without checkout writes", async t => {
  const options = context(t), ram = path.join(repositoryRoot, "legacy/.pkm-test-subscription-ram");
  const existed = fs.existsSync(ram);
  const invokingNetwork = fs.readlinkSync("/proc/self/ns/net");
  const source = `
    const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
    const root=process.env.PKM_SUBSCRIPTION_TEST_RAM_ROOT;
    assert.equal(root,path.resolve("legacy/.pkm-test-subscription-ram"));
    assert.equal(fs.realpathSync(root),root);
    assert.equal(fs.statfsSync(root).type,0x01021994);
    assert.equal(fs.statSync(root).mode&0o777,0o700);
    assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK,"1");
    assert.notEqual(fs.readlinkSync("/proc/self/ns/net"),${JSON.stringify(invokingNetwork)});
    fs.writeFileSync(path.join(root,"synthetic-private-fixture"),"synthetic",{mode:0o600});
  `;
  const result = await executeSuite({ name: "private-subscription-ram",
    command: [process.execPath, "-e", source],
    fixtures: fixtureRequirements({ environments: ["PKM_SUBSCRIPTION_TEST_RAM_ROOT"] }),
  }, options);
  assert.equal(result.status, "passed", result.stderr || result.error);
  assert.equal(result.cleaned, true);
  assert.equal(fs.existsSync(path.join(ram, "synthetic-private-fixture")), false);
  assert.equal(fs.existsSync(ram), existed);
});

test("detached fixture processes stop before workspace removal", async t => {
  const options = context(t), observer = path.join(options.root, "ticks");
  const result = await executeSuite({ name: "orphan", command: [process.execPath, fixture, "orphan", observer] }, options);
  assert.equal(result.status, "passed", result.stderr || result.error);
  assert.equal(result.cleaned, true);
  assert.equal(fs.existsSync(result.workspace), false);
  const before = fs.readFileSync(observer, "utf8");
  assert(before.includes("tick"));
  await delay(150);
  assert.equal(fs.readFileSync(observer, "utf8"), before);
});

test("timeout and cancellation terminate the private namespace and reclaim its workspace", async t => {
  const options = context(t);
  for (const cancelled of [false, true]) {
    const controller = new AbortController(), observer = path.join(options.root, `ticks-${cancelled}`);
    const timer = cancelled ? setTimeout(() => controller.abort(), 800) : undefined;
    try {
      const result = await executeSuite({ name: "deadline", command: [process.execPath, fixture, "timeout", observer] },
        { ...options, timeoutMs: cancelled ? 10000 : 800, signal: controller.signal });
      assert.equal(result.status, "failed");
      assert.equal(result.timedOut, !cancelled);
      assert.equal(result.cleaned, true, result.cleanupError);
      assert.equal(fs.existsSync(result.workspace), false);
      const before = fs.readFileSync(observer, "utf8");
      await delay(100);
      assert.equal(fs.readFileSync(observer, "utf8"), before);
    } finally { clearTimeout(timer); }
  }
});

test("active or replaced workspaces cannot be recursively removed", t => {
  const options = context(t), workspace = createWorkspace(repositoryRoot, options.root);
  workspace.start();
  assert.throws(() => workspace.cleanup(), /active test workspace/);
  workspace.stopped();
  const held = `${workspace.directory}-held`, external = path.join(options.root, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "keep"), "original");
  fs.renameSync(workspace.directory, held);
  fs.symlinkSync(external, workspace.directory);
  assert.throws(() => workspace.cleanup(), /ownership changed/);
  assert.equal(fs.readFileSync(path.join(external, "keep"), "utf8"), "original");
  fs.unlinkSync(workspace.directory);
  fs.renameSync(held, workspace.directory);
  workspace.cleanup();
  assert.throws(() => createWorkspace(repositoryRoot, path.join(repositoryRoot, "tests")), /outside the checkout/);
  assert.throws(() => fileSuite(repositoryRoot, "tests/framework/fixture.cjs"), /fixture or controller/);
});

test("missing prerequisites fail explicitly without leaving a workspace", async t => {
  const options = context(t);
  const result = await executeSuite({ name: "missing", requires: ["dist/not-a-real-prerequisite"],
    command: [process.execPath, fixture, "success"] }, options);
  assert.equal(result.status, "failed");
  assert.match(result.error, /Missing prerequisite/);
  assert.equal(result.cleaned, true);
  assert.equal(fs.existsSync(result.workspace), false);
});

test("cleanup errors cannot turn a zero exit code into a passing result", async t => {
  const options = context(t);
  const result = await executeSuite({ name: "changed-owner", command: [process.execPath, "-e",
    "require('fs').writeFileSync(require('path').join(process.env.PKM_TEST_WORKSPACE,'owner.json'),'{\"token\":\"changed\"}')"] }, options);
  assert.equal(result.code, 0);
  assert.equal(result.status, "failed");
  assert.equal(result.cleaned, false);
  assert.match(result.cleanupError, /ownership changed/);
  assert(fs.existsSync(result.workspace));
  assert.equal(JSON.parse(fs.readFileSync(result.report)).cleaned, false);
});
