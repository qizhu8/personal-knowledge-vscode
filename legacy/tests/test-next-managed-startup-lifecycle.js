"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter, once } = require("node:events");
const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const scratch = process.env.PKM_TRIAL_TEST_ROOT;
const extension = process.env.PKM_TRIAL_EXTENSION_DIST;
const server = process.env.PKM_TRIAL_SERVER_DIST;
if (!scratch || !extension || !server) throw Error("Run with isolated compiled trial fixtures.");
const fixture = () => {
  const directory = path.join(scratch, `lifecycle-${randomUUID()}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  return directory;
};

class FakeChild extends EventEmitter {
  connected = true;
  sent = [];
  send(message, callback) { this.sent.push(message); callback?.(null); return true; }
  disconnect() { throw new Error("Child must not be disconnected before drain."); }
  finish(code = 0) { this.connected = false; this.emit("close", code, null); }
}

test("parent selection revocation waits for child ACK and can retry a failed drain", async t => {
  const directory = fixture(), legacy = fixture(), fake = new FakeChild();
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });
  const Client = loadClient(fake), client = new Client(), workspaceId = randomUUID();
  const starting = client.start(scratch, directory, fs.realpathSync(process.execPath), legacy);
  fake.emit("message", { type: "ready", workspaceId });
  await starting;
  const controller = new AbortController(), failures = [];
  const profile = { id: randomUUID(), workspaceId, actorId: "local:owner", signal: controller.signal,
    assertCurrent() { if (controller.signal.aborted) throw new Error("profile revoked"); } };
  const selecting = client.selectChatOwner(profile, error => failures.push(error));
  const opening = fake.sent.at(-1);
  assert.equal(opening.type, "selected-owner-open");
  fake.emit("message", { type: "result", id: opening.id,
    result: { session: opening.session, workspaceId, actorId: "local:owner" } });
  const selected = await selecting;
  selected.assertCurrent();
  controller.abort();
  assert.throws(() => selected.assertCurrent(), /unavailable/);
  await new Promise(resolve => setImmediate(resolve));
  let revoke = fake.sent.at(-1);
  assert.equal(revoke.type, "selected-owner-revoke");
  fake.emit("message", { type: "result", id: revoke.id, error: "SELECTED_OWNER_DRAIN_UNKNOWN" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failures.length, 1);
  const retry = selected.revoke();
  await new Promise(resolve => setImmediate(resolve));
  revoke = fake.sent.at(-1);
  assert.equal(revoke.type, "selected-owner-revoke");
  let acknowledged = false;
  void retry.then(() => { acknowledged = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, false);
  fake.emit("message", { type: "result", id: revoke.id, result: { revoked: true } });
  await retry;
  const closing = client.close();
  fake.emit("message", { type: "closed" });
  fake.finish();
  await closing;
});

test("failed owner opening retains a reachable drain until child acknowledgement", async t => {
  const directory = fixture(), legacy = fixture(), fake = new FakeChild();
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });
  const client = new (loadClient(fake))(), workspaceId = randomUUID();
  const starting = client.start(scratch, directory, fs.realpathSync(process.execPath), legacy);
  fake.emit("message", { type: "ready", workspaceId });
  await starting;
  const controller = new AbortController(), failures = [];
  const profile = { id: randomUUID(), workspaceId, actorId: "local:owner", signal: controller.signal, assertCurrent() {} };
  const selecting = client.selectChatOwner(profile, error => failures.push(error));
  const open = fake.sent.at(-1);
  fake.emit("message", { type: "result", id: open.id, error: "BUSY_OR_INVALID" });
  await new Promise(resolve => setImmediate(resolve));
  const first = fake.sent.at(-1);
  assert.equal(first.type, "selected-owner-revoke");
  assert.equal(first.session, open.session);
  fake.emit("message", { type: "result", id: first.id, error: "SELECTED_OWNER_DRAIN_UNKNOWN" });
  await assert.rejects(selecting, /rejected before admission/);
  assert.equal(failures.length, 1);
  const retry = client.revokeSelectedChatOwner();
  await new Promise(resolve => setImmediate(resolve));
  const second = fake.sent.at(-1);
  assert.equal(second.type, "selected-owner-revoke");
  assert.equal(second.session, open.session);
  fake.emit("message", { type: "result", id: second.id, result: { revoked: true } });
  await retry;
  const closing = client.close();
  fake.emit("message", { type: "closed" });
  fake.finish();
  await closing;
});

test("compiled parent selects and revokes an owner over its real fork IPC", { timeout: 30000 }, async t => {
  const directory = fixture(), legacy = fixture();
  let client;
  t.after(async () => {
    if (client && !client.isStopped()) await client.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true });
  });
  const file = path.join(extension, "runtime/next-managed-client.js");
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  let Client;
  try {
    Module._load = function (name, ...args) {
      if (name === "./next-payload-verifier") return {
        verifyNextPayload: () => ({ root: server, entry: path.join(server, "managed-client-child.js") }),
      };
      return original.call(this, name, ...args);
    };
    Client = require(file).NextManagedClient;
  } finally { Module._load = original; }
  client = new Client();
  const workspaceId = await client.start(scratch, directory, fs.realpathSync(process.execPath), legacy);
  const controller = new AbortController();
  const profile = { id: randomUUID(), workspaceId, actorId: "local:owner", signal: controller.signal,
    assertCurrent() { if (controller.signal.aborted) throw new Error("profile revoked"); } };
  const selected = await client.selectChatOwner(profile, () => assert.fail("Unexpected revocation failure"));
  selected.assertCurrent();
  await selected.revoke();
  assert.throws(() => selected.assertCurrent(), /unavailable/);
  assert.equal(client.ownsWorkspace(workspaceId), true);
  await client.close();
});

function loadClient(fake) {
  const file = path.join(extension, "runtime/next-managed-client.js");
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  try {
    Module._load = function (name, ...args) {
      if (name === "child_process") return { fork: () => fake, execFileSync: () => Buffer.alloc(0) };
      if (name === "./next-payload-verifier") return { verifyNextPayload: () => ({ root: scratch, entry: path.join(scratch, "child.js") }) };
      return original.call(this, name, ...args);
    };
    return require(file).NextManagedClient;
  } finally { Module._load = original; }
}

test("startup timeout retains child and does not report drain until delayed process exit", async t => {
  const directory = fixture(), legacy = fixture(), fake = new FakeChild();
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const Client = loadClient(fake), client = new Client();
  const starting = client.start(scratch, directory, fs.realpathSync(process.execPath), legacy);
  t.mock.timers.tick(30000);
  await assert.rejects(starting, /timed out.*unknown/);
  assert.equal(client.isStopped(), false);
  assert.deepEqual(fake.sent.map(message => message.type), ["start", "close"]);
  const draining = client.close();
  t.mock.timers.tick(30000);
  await assert.rejects(draining, /timed out.*not terminated/);
  assert.equal(client.isStopped(), false);
  fake.emit("message", { type: "ready", workspaceId: "12345678-1234-1234-1234-123456789abc" });
  await assert.rejects(client.invoke("list", {}), /not connected/);
  const retry = client.close();
  fake.emit("message", { type: "closed" });
  assert.equal(client.isStopped(), false);
  fake.finish();
  await retry;
  assert.equal(client.isStopped(), true);
});

test("close while starting cancels admission; close errors remain tracked until actual exit", async t => {
  const directory = fixture(), legacy = fixture(), fake = new FakeChild();
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });
  const Client = loadClient(fake), client = new Client();
  const starting = client.start(scratch, directory, fs.realpathSync(process.execPath), legacy);
  const draining = client.close();
  await assert.rejects(starting, /cancelled/);
  fake.emit("message", { type: "close-error" });
  assert.equal(client.isStopped(), false);
  fake.finish(1);
  await assert.rejects(draining, /drain failed.*unknown/);
  assert.equal(client.isStopped(), true);
});

test("retryable drain failure keeps the child tracked and retries before acknowledging close", async t => {
  const directory = fixture(), legacy = fixture(), fake = new FakeChild();
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });
  const Client = loadClient(fake), client = new Client();
  const starting = client.start(scratch, directory, fs.realpathSync(process.execPath), legacy);
  fake.emit("message", { type: "ready", workspaceId: "12345678-1234-1234-1234-123456789abc" });
  await starting;
  const first = client.close();
  fake.emit("message", { type: "close-retryable-error" });
  await assert.rejects(first, /drain failed.*unknown/);
  assert.equal(client.isStopped(), false);
  await assert.rejects(client.invoke("list", {}), /not connected/);
  const retry = client.close();
  assert.deepEqual(fake.sent.map(message => message.type), ["start", "close", "close"]);
  fake.emit("message", { type: "closed" });
  assert.equal(client.isStopped(), false);
  fake.finish();
  await retry;
});

test("startup error leaves drain to child without writing to a closing IPC pipe and tracks actual exit", async t => {
  const directory = fixture(), legacy = fixture(), fake = new FakeChild();
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });
  const Client = loadClient(fake), client = new Client();
  const starting = client.start(scratch, directory, fs.realpathSync(process.execPath), legacy);
  fake.emit("message", { type: "startup-error" });
  await assert.rejects(starting, /startup failed.*unknown/);
  assert.deepEqual(fake.sent.map(message => message.type), ["start"]);
  const draining = client.close();
  assert.deepEqual(fake.sent.map(message => message.type), ["start"], "connected may stay true after the peer has begun shutdown");
  assert.equal(client.isStopped(), false);
  fake.emit("message", { type: "close-error" });
  fake.finish(1);
  await assert.rejects(draining, /drain failed.*unknown/);
  assert.equal(client.isStopped(), true);
});

test("real rejecting child drains its own IPC; parent sends no close and waits for delayed failed exit", { timeout: 10000 }, async t => {
  const directory = fixture(), legacy = fixture();
  const child = fork(path.resolve("tests/fixtures/next-managed-startup-reject.cjs"), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"], env: { PATH: process.env.PATH || "" },
  });
  const sent = [], original = child.send;
  child.send = function (message, ...args) { sent.push(message.type); return original.call(this, message, ...args); };
  t.after(() => cleanupChildFixture(child, directory));
  t.after(() => fs.rmSync(legacy, { recursive: true, force: true }));
  const Client = loadClient(child), client = new Client();
  const starting = client.start(scratch, directory, fs.realpathSync(process.execPath), legacy);
  await assert.rejects(starting, /Synthetic rejected restart/);
  assert.equal(client.isStopped(), false);
  await assert.rejects(client.close(), /unknown/);
  assert.equal(client.isStopped(), true);
  assert.deepEqual(sent, ["start"], "No parent write after the child's terminal startup response");
  assert.equal(child.exitCode, 1);
});

test("close racing the ready response cannot report a successfully opened trial", async t => {
  const directory = fixture(), legacy = fixture(), fake = new FakeChild();
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });
  const Client = loadClient(fake), client = new Client();
  const starting = client.start(scratch, directory, fs.realpathSync(process.execPath), legacy);
  fake.emit("message", { type: "ready", workspaceId: "12345678-1234-1234-1234-123456789abc" });
  const draining = client.close();
  await assert.rejects(starting, /cancelled/);
  fake.emit("message", { type: "closed" });
  fake.finish();
  await draining;
});

test("import IPC binds exact plan, sends one confirmation and enforces read-only attach", async t => {
  const directory = fixture(), legacy = fixture(), fake = new FakeChild();
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });
  const Client = loadClient(fake), client = new Client();
  const starting = client.planImport(scratch, directory, fs.realpathSync(process.execPath), legacy, "/synthetic/copy", "/synthetic/python");
  assert.deepEqual(fake.sent[0], { type: "start-import", source: "/synthetic/copy", parent: directory,
    python: "/synthetic/python", legacyRoot: legacy, acknowledge: true });
  fake.emit("message", { type: "import-plan", ready: true, planSha256: "a".repeat(64), fingerprint: null,
    blockers: [], target: path.join(directory, "workspace") });
  const plan = await starting;
  await assert.rejects(client.confirmImport("wrong"), /rejected before admission/);
  const imported = client.confirmImport(plan.planSha256);
  const confirmation = fake.sent.at(-1);
  assert.equal(confirmation.type, "confirm-import");
  assert.match(confirmation.id, /^[a-f0-9-]{36}$/);
  fake.emit("message", { type: "result", id: confirmation.id, result: { receipt: {}, outcome: { status: "published" } } });
  await imported;
  await assert.rejects(client.confirmImport(plan.planSha256), /rejected before admission/);
  const status = client.importStatus();
  fake.emit("message", { type: "result", id: fake.sent.at(-1).id, result: { outcome: { status: "published" } } });
  await status;
  await assert.rejects(client.invoke("list", {}), /read-only/);
  const attach = client.attachImport();
  assert.equal(fake.sent.at(-1).type, "attach-import");
  fake.emit("message", { type: "result", id: fake.sent.at(-1).id, result: { workspaceId: "12345678-1234-1234-1234-123456789abc", readOnly: true } });
  await attach;
  await assert.rejects(client.invoke("create", {}), /read-only/);
  await assert.rejects(client.invoke("update", {}), /read-only/);
  const read = client.invoke("list", {});
  fake.emit("message", { type: "result", id: fake.sent.at(-1).id, result: { result: { items: [] } } });
  await read;
  const closed = client.close();
  fake.emit("message", { type: "closed" }); fake.finish();
  await closed;
});

test("import request timeout closes admission, retains handle and never resends confirmation", async t => {
  const directory = fixture(), legacy = fixture(), fake = new FakeChild();
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const Client = loadClient(fake), client = new Client();
  const starting = client.planImport(scratch, directory, fs.realpathSync(process.execPath), legacy, "/copy", "/python");
  fake.emit("message", { type: "import-plan", ready: true, planSha256: "b".repeat(64), fingerprint: null,
    blockers: [], target: path.join(directory, "workspace") });
  await starting;
  const importing = client.confirmImport("b".repeat(64));
  t.mock.timers.tick(30000);
  await assert.rejects(importing, /timed out.*unknown.*operation ID/);
  assert.equal(client.isStopped(), false);
  await assert.rejects(client.confirmImport("b".repeat(64)), /rejected/);
  assert.equal(fake.sent.filter(message => message.type === "confirm-import").length, 1);
  const closed = client.close();
  fake.emit("message", { type: "closed" }); fake.finish();
  await closed;
});

test("isolated experiment validates scope/digest, refuses default writes and resumes only bound credentials", async t => {
  const directory = fixture(), legacy = fixture(), fake = new FakeChild();
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });
  const Client = loadClient(fake), client = new Client();
  const workspaceId = "12345678-1234-1234-1234-123456789abc", digest = "d".repeat(64);
  const starting = client.planImport(scratch, directory, fs.realpathSync(process.execPath), legacy, "/copy", "/python");
  fake.emit("message", { type: "import-plan", ready: true, planSha256: digest, fingerprint: null,
    blockers: [], target: path.join(directory, "workspace") });
  await starting;
  const reply = result => fake.emit("message", { type: "result", id: fake.sent.at(-1).id, result });
  const confirming = client.confirmImport(digest); reply({ outcome: { status: "published" } }); await confirming;
  const attaching = client.attachImport(); reply({ workspaceId, readOnly: true }); await attaching;
  await assert.rejects(client.invoke("update", {}), /read-only/);
  const preparing = client.prepareImportWrite();
  const writerCoverage = { inProcessCalls: "tracked", cooperatingHosts: "native-lease", external: "unknown" };
  reply({ workspaceId, planSha256: digest, target: path.join(directory, "workspace"), authorizationDigest: digest,
    scope: "isolated_experiment", writerCoverage, blockers: [] });
  await preparing;
  await assert.rejects(client.enableImportWrite(digest, "/wrong"), /rejected/);
  const enabling = client.enableImportWrite(digest, path.join(directory, "workspace"));
  const approval = fake.sent.at(-1);
  assert.equal(approval.acknowledgeIsolatedExperiment, true);
  reply({ workspaceId, readOnly: false, scope: "isolated_experiment", credential: { parent: directory, capability: digest } });
  const credential = await enabling;
  const writing = client.invoke("update", {});
  reply({ result: { revision: 3 } }); await writing;
  const stopped = client.close(); fake.emit("message", { type: "closed" }); fake.finish(); await stopped;
  const resumedChild = new FakeChild(), ResumedClient = loadClient(resumedChild), resumed = new ResumedClient();
  fs.writeFileSync(path.join(directory, "existing"), "credential-bound existing directory");
  const boot = resumed.resumeImport(scratch, credential, fs.realpathSync(process.execPath), legacy);
  assert.deepEqual(resumedChild.sent[0], { type: "start-import-write", parent: directory, capability: digest, acknowledgeIsolatedExperiment: true });
  resumedChild.emit("message", { type: "ready", workspaceId, readOnly: false, scope: "isolated_experiment", writerCoverage });
  await boot;
  const done = resumed.close(); resumedChild.emit("message", { type: "closed" }); resumedChild.finish(); await done;
});

test("UI keeps a failed startup bound until child exit, and blocks another start", async t => {
  const directory = fixture(), legacy = fixture(), fake = new FakeChild();
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const Client = loadClient(fake), commands = new Map(), errors = [];
  const vscode = {
    commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; } },
    window: {
      showOpenDialog: async options => [{ fsPath: options.canSelectFolders ? directory : fs.realpathSync(process.execPath) }],
      showWarningMessage: async () => "Create Trial",
      showErrorMessage: async message => errors.push(message),
    },
  };
  const file = path.join(extension, "ui/next-managed-trial.js");
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  let adapter;
  try {
    Module._load = function (name, ...args) {
      if (name === "vscode") return vscode;
      if (name === "../runtime/next-managed-client") return { NextManagedClient: Client };
      if (name === "./next-python-environment") return { registerNextPythonEnvironment() {} };
      return original.call(this, name, ...args);
    };
    adapter = require(file);
  } finally { Module._load = original; }
  adapter.registerNextManagedTrial({ extensionPath: scratch, subscriptions: [], secrets: { async get() {} } }, () => legacy);
  const starting = commands.get("personalKnowledge.nextTrialStart")();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(30000);
  await starting;
  await commands.get("personalKnowledge.nextTrialStart")();
  assert.match(errors[0], /timed out.*unknown/);
  assert.match(errors[1], /Close the current trial/);
  const closing = commands.get("personalKnowledge.nextTrialClose")();
  fake.emit("message", { type: "closed" });
  fake.finish();
  await closing;
  assert.equal(errors.length, 2);
});

for (const scenario of ["blocked", "cancel", "success", "unknown"]) {
  test(`import UI ${scenario}: explicit static assertion, blockers/digest and no replay`, async t => {
    const directory = fixture(), legacy = fixture(), fake = new FakeChild();
    t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });
    const Client = loadClient(fake), commands = new Map(), warnings = [], errors = [], previews = [];
    const dialogs = ["/synthetic/copy", directory, fs.realpathSync(process.execPath), "/synthetic/python"];
    const reply = (id, result) => queueMicrotask(() => fake.emit("message", { type: "result", id, result }));
    fake.send = function (message, callback) {
      this.sent.push(message); callback?.(null);
      if (message.type === "start-import") queueMicrotask(() => fake.emit("message", {
        type: "import-plan", ready: scenario !== "blocked", planSha256: "c".repeat(64), fingerprint: null,
        blockers: scenario === "blocked" ? [{ code: "BLOCK", path: "copy", message: "Synthetic blocker" }] : [],
        target: path.join(directory, "workspace"),
      }));
      if (message.type === "confirm-import") {
        if (scenario === "unknown") queueMicrotask(() => fake.emit("message", {
          type: "result", id: message.id, error: "OUTCOME_UNKNOWN",
          message: "Synthetic stale plan; no automatic retry.",
          blockers: [{ code: "CHANGED", path: "copy", message: "Copy changed" }],
        }));
        else reply(message.id, { receipt: {}, outcome: { status: "published" } });
      }
      if (message.type === "import-status") reply(message.id, { outcome: { status: "published" } });
      if (message.type === "attach-import") reply(message.id, { readOnly: true, workspaceId: "12345678-1234-1234-1234-123456789abc" });
      if (message.type === "invoke") reply(message.id, { result: message.operation === "list"
        ? { items: [{ id: "doc", title: "Imported" }] } : { content: "Synthetic imported content" } });
      if (message.type === "close") queueMicrotask(() => { fake.emit("message", { type: "closed" }); fake.finish(); });
      return true;
    };
    const vscode = {
      commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; } },
      workspace: { openTextDocument: async options => { previews.push(options); return options; } },
      window: {
        showOpenDialog: async () => [{ fsPath: dialogs.shift() }],
        showWarningMessage: async (message, options) => {
          warnings.push({ message, detail: options.detail });
          if (warnings.length === 1) return "I Assert Static Copy";
          return scenario === "cancel" ? undefined : "Import Exact Plan";
        },
        showInformationMessage: async () => {},
        showErrorMessage: async message => errors.push(message),
        showQuickPick: async choices => choices[0],
        showTextDocument: async () => {},
      },
    };
    const file = path.join(extension, "ui/next-managed-trial.js");
    delete require.cache[require.resolve(file)];
    const original = Module._load;
    let adapter;
    try {
      Module._load = function (name, ...args) {
        if (name === "vscode") return vscode;
        if (name === "../runtime/next-managed-client") return { NextManagedClient: Client };
        if (name === "./next-python-environment") return { registerNextPythonEnvironment() {} };
        return original.call(this, name, ...args);
      };
      adapter = require(file);
    } finally { Module._load = original; }
    adapter.registerNextManagedTrial({ extensionPath: scratch, subscriptions: [] }, () => legacy);
    await commands.get("personalKnowledge.nextTrialImport")();
    assert.match(warnings[0].detail, /assertion, not a writer fence/);
    assert.match(warnings[1].detail, /Plan digest: c{64}/);
    if (scenario === "blocked") assert.match(warnings[1].detail, /BLOCK: copy: Synthetic blocker/);
    assert.equal(fake.sent.filter(message => message.type === "confirm-import").length,
      ["success", "unknown"].includes(scenario) ? 1 : 0);
    if (scenario === "unknown") {
      assert.match(errors[0], /unknown.*operation ID/s);
      assert.match(errors[0], /CHANGED: copy: Copy changed/);
      assert.match(errors[0], /Synthetic stale plan/);
    } else assert.deepEqual(errors, []);
    assert.equal(previews.length, scenario === "success" ? 1 : 0);
    if (scenario === "success") {
      assert.deepEqual(fake.sent.filter(message => message.type === "invoke").map(message => message.operation), ["list", "get"]);
      assert.equal(previews[0].content, "Synthetic imported content");
    }
    await commands.get("personalKnowledge.nextTrialClose")();
  });
}

function nextMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}`)); }, 5000);
    const message = value => { if (value?.type === type) { cleanup(); resolve(value); } };
    const exit = () => { cleanup(); reject(new Error(`Child exited before ${type}`)); };
    function cleanup() { clearTimeout(timer); child.off("message", message); child.off("exit", exit); }
    child.on("message", message); child.once("exit", exit);
  });
}

async function cleanupChildFixture(child, directory) {
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    if (child.connected) {
      for (const type of ["close", "test-release-initialize", "test-release-host", "test-release-close"]) {
        child.send({ type }, () => {});
      }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`Fixture child still running; preserving ${directory}`);
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

test("real child close waits for initialization and delayed host drain before acknowledging", { timeout: 15000 }, async t => {
  const directory = fixture();
  const child = fork(path.join(server, "managed-client-child.js"), [], {
    execArgv: ["--require", path.resolve("tests/fixtures/next-managed-child-delays.cjs")],
    env: { PATH: process.env.PATH || "" }, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  t.after(() => cleanupChildFixture(child, directory));
  const messages = [];
  child.on("message", message => messages.push(message.type));
  const exited = once(child, "exit");
  let waiting = nextMessage(child, "test-initializing");
  child.send({ type: "start", directory });
  await waiting;
  child.send({ type: "close" });
  waiting = nextMessage(child, "test-starting-host");
  child.send({ type: "test-release-initialize" });
  await waiting;
  assert.equal(fs.readFileSync(path.join(directory, "workspace/initialized"), "utf8"), "finished");
  assert(!messages.includes("closed"));
  waiting = nextMessage(child, "test-closing-host");
  child.send({ type: "test-release-host" });
  await waiting;
  assert(!messages.includes("ready"));
  assert(!messages.includes("closed"));
  waiting = nextMessage(child, "closed");
  child.send({ type: "test-release-close" });
  await waiting;
  assert.deepEqual(await exited, [0, null]);
});

test("real child startup failure during close reports unknown rather than a false drain", { timeout: 15000 }, async t => {
  const directory = fixture();
  const child = fork(path.join(server, "managed-client-child.js"), [], {
    execArgv: ["--require", path.resolve("tests/fixtures/next-managed-child-delays.cjs")],
    env: { PATH: process.env.PATH || "", PKM_TEST_FAIL_INITIALIZE: "1" },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  t.after(() => cleanupChildFixture(child, directory));
  const messages = [];
  child.on("message", message => messages.push(message.type));
  const exited = once(child, "exit");
  let waiting = nextMessage(child, "test-initializing");
  child.send({ type: "start", directory });
  await waiting;
  child.send({ type: "close" });
  waiting = nextMessage(child, "close-error");
  child.send({ type: "test-release-initialize" });
  await waiting;
  assert.deepEqual(await exited, [1, null]);
  assert(messages.includes("startup-error"));
  assert(!messages.includes("closed"));
});

test("real child keeps its owner connected after failed drain and only ACKs a successful retry", { timeout: 15000 }, async t => {
  const directory = fixture();
  const child = fork(path.join(server, "managed-client-child.js"), [], {
    execArgv: ["--require", path.resolve("tests/fixtures/next-managed-child-delays.cjs")],
    env: { PATH: process.env.PATH || "", PKM_TEST_FAIL_FIRST_HOST_CLOSE: "1" },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  t.after(() => cleanupChildFixture(child, directory));
  const messages = [];
  child.on("message", message => messages.push(message.type));
  const exited = once(child, "exit");
  let waiting = nextMessage(child, "test-initializing");
  child.send({ type: "start", directory });
  await waiting;
  waiting = nextMessage(child, "test-starting-host");
  child.send({ type: "test-release-initialize" });
  await waiting;
  waiting = nextMessage(child, "ready");
  child.send({ type: "test-release-host" });
  await waiting;
  waiting = nextMessage(child, "test-closing-host");
  child.send({ type: "close" });
  await waiting;
  waiting = nextMessage(child, "close-retryable-error");
  child.send({ type: "test-release-close" });
  await waiting;
  assert.equal(child.connected, true);
  assert(!messages.includes("closed"));
  waiting = nextMessage(child, "test-closing-host");
  child.send({ type: "close" });
  await waiting;
  waiting = nextMessage(child, "closed");
  child.send({ type: "test-release-close" });
  await waiting;
  assert.deepEqual(await exited, [0, null]);
});

test("failed real Storage owner drain keeps its writer fence until the successful ACK", { timeout: 30000 }, async t => {
  if (process.platform !== "linux") return t.skip("Requires the Linux writer fence.");
  const directory = fixture();
  const child = fork(path.join(server, "managed-client-child.js"), [], {
    execArgv: ["--require", path.resolve("tests/fixtures/next-managed-child-real-owner.cjs")],
    env: { PATH: process.env.PATH || "", PKM_TEST_FAIL_FIRST_HOST_CLOSE: "1" },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  t.after(() => cleanupChildFixture(child, directory));
  const exited = once(child, "exit");
  let waiting = nextMessage(child, "ready");
  child.send({ type: "start", directory });
  await waiting;
  const workspace = path.join(directory, "workspace");
  const { acquireLinuxRootWriterFence } = await import(pathToFileURL(path.join(server, "linux-root-writer-fence.js")).href);
  await assert.rejects(acquireLinuxRootWriterFence(workspace, 150), /timed out|acquire.*fence/i);
  waiting = nextMessage(child, "close-retryable-error");
  child.send({ type: "close" });
  await waiting;
  assert.equal(child.connected, true);
  await assert.rejects(acquireLinuxRootWriterFence(workspace, 150), /timed out|acquire.*fence/i);
  waiting = nextMessage(child, "closed");
  child.send({ type: "close" });
  await waiting;
  assert.deepEqual(await exited, [0, null]);
  const fence = await acquireLinuxRootWriterFence(workspace, 2000);
  await fence.release();
});

test("disconnect with failed child drain retains the live Storage fence and has no ACK", { timeout: 30000 }, async t => {
  if (process.platform !== "linux") return t.skip("Requires the Linux writer fence.");
  const directory = fixture();
  const child = fork(path.join(server, "managed-client-child.js"), [], {
    execArgv: ["--require", path.resolve("tests/fixtures/next-managed-child-real-owner.cjs")],
    env: { PATH: process.env.PATH || "", PKM_TEST_FAIL_FIRST_HOST_CLOSE: "1" },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const messages = [];
  child.on("message", message => messages.push(message.type));
  const waiting = nextMessage(child, "ready");
  child.send({ type: "start", directory });
  await waiting;
  child.disconnect();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert(!messages.includes("closed"));
  const workspace = path.join(directory, "workspace");
  const { acquireLinuxRootWriterFence } = await import(pathToFileURL(path.join(server, "linux-root-writer-fence.js")).href);
  await assert.rejects(acquireLinuxRootWriterFence(workspace, 150), /timed out|acquire.*fence/i);
  assert(child.kill("SIGKILL"));
  assert.deepEqual(await exited, [null, "SIGKILL"]);
  const fence = await acquireLinuxRootWriterFence(workspace, 3000);
  await fence.release();
});

test("disconnect without an ACK drains a real Storage owner but is not parent-side proof", { timeout: 30000 }, async t => {
  if (process.platform !== "linux") return t.skip("Requires the Linux writer fence.");
  const directory = fixture();
  const child = fork(path.join(server, "managed-client-child.js"), [], {
    execArgv: ["--require", path.resolve("tests/fixtures/next-managed-child-real-owner.cjs")],
    env: { PATH: process.env.PATH || "" }, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  t.after(() => cleanupChildFixture(child, directory));
  const messages = [];
  child.on("message", message => messages.push(message.type));
  const exited = once(child, "exit");
  const waiting = nextMessage(child, "ready");
  child.send({ type: "start", directory });
  await waiting;
  child.disconnect();
  assert.deepEqual(await exited, [0, null]);
  assert(!messages.includes("closed"));
  const { acquireLinuxRootWriterFence } = await import(pathToFileURL(path.join(server, "linux-root-writer-fence.js")).href);
  const fence = await acquireLinuxRootWriterFence(path.join(directory, "workspace"), 3000);
  await fence.release();
});
