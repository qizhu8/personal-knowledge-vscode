"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const vm = require("node:vm");
const ts = require("typescript");
const dist = process.env.PKM_TEST_DIST || path.resolve("dist");
const { RetrievalWorkerManager } = require(path.join(dist, "retrieval/retrieval-worker"));
const { provisionManagedWriterSession, closeManagedWriterAdmission, orchestrateManagedWriterHandoff,
  rotateManagedWriterSession, enrollExistingManagedWriterSession, enrollExistingManagedProfile, registerManagedProfile, bootstrapManagedProfile,
  bootstrapCompatibleManagedProfile, beginUnboundManagedMcpLaunch, beginManagedWriterOperation, beginManagedRetrievalBuild, completeManagedRetrievalBuild,
  beginExistingManagedMcp, completeExistingManagedMcp,
  withManagedRetrievalOperation } = require(path.join(dist, "runtime/managed-writer-session"));
const { activateManagedProfileWriter } = require(path.join(dist, "runtime/managed-profile-activation"));

function fixture(t) {
  const root = path.resolve(".migration-test-work", `managed-retrieval-session-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const previous = process.env.PKM_MANAGED_WRITER_SESSION;
  t.after(() => {
    if (previous === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION;
    else process.env.PKM_MANAGED_WRITER_SESSION = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("ordinary retrieval without a session stays usable without creating session files", { skip: process.platform !== "linux" }, async t => {
  const root = fixture(t);
  delete process.env.PKM_MANAGED_WRITER_SESSION;
  assert.equal(enrollExistingManagedWriterSession(root), undefined);
  assert.equal(enrollExistingManagedProfile(root, "a".repeat(64)), undefined);
  assert.equal(await withManagedRetrievalOperation(root, async () => "available"), "available");
  assert.equal(fs.existsSync(path.join(root, ".pkm")), false);
});

test("isolated bootstrap atomically creates one session and enrolls concurrent hosts", { skip: process.platform !== "linux" }, async t => {
  const root = fixture(t), script = `
    const m = require(process.argv[1]);
    console.log(JSON.stringify(m.bootstrapManagedProfile(process.argv[2], process.argv[3])));
  `;
  const children = Array.from({ length: 5 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, path.join(dist, "runtime/managed-writer-session"), root,
      (i + 1).toString(16).repeat(64)], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { error += data; });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) return reject(new Error(error));
      try { resolve(JSON.parse(output)); } catch (reason) { reject(reason); }
    });
  }));
  const results = await Promise.all(children);
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(new Set(results.map(result => result.registration.sessionId)).size, 1);
  assert.equal(new Set(results.map(result => result.registration.operationId)).size, 5);
  assert.equal(fs.readdirSync(path.join(root, ".pkm/state/managed-writer-session/operations")).length, 5);
  delete process.env.PKM_MANAGED_WRITER_SESSION;
  assert.throws(() => beginManagedWriterOperation(root, "mcp-server", randomUUID()), /not enrolled/);
});

test("compatible bootstrap preserves previous unbound launcher behavior and rejects a conflicting session", {
  skip: process.platform !== "linux" || !process.env.PKM_TEST_OLD_MCP_DIST,
}, async t => {
  const root = fixture(t), registration = bootstrapCompatibleManagedProfile(root, "a".repeat(64));
  assert.equal(registration.created, true);
  assert.equal(fs.existsSync(path.join(root, ".pkm/state/managed-writer-session")), false);
  const old = require("node:child_process").spawnSync(process.execPath, ["-e", `
    const m=require(process.argv[1]);
    console.log(JSON.stringify({ operation: m.beginManagedWriterOperation(process.argv[2], "mcp-server", process.argv[3]) ?? null }));
  `, path.join(process.env.PKM_TEST_OLD_MCP_DIST, "runtime/managed-writer-session"), root, randomUUID()],
  { encoding: "utf8", env: { ...process.env, PKM_MANAGED_WRITER_SESSION: "" } });
  // An old launcher without a binding has no session variable, not an empty one.
  const oldEnv = { ...process.env }; delete oldEnv.PKM_MANAGED_WRITER_SESSION;
  const oldUnbound = require("node:child_process").spawnSync(process.execPath, ["-e", `
    const m=require(process.argv[1]);
    console.log(JSON.stringify({ operation: m.beginManagedWriterOperation(process.argv[2], "mcp-server", process.argv[3]) ?? null }));
  `, path.join(process.env.PKM_TEST_OLD_MCP_DIST, "runtime/managed-writer-session"), root, randomUUID()],
  { encoding: "utf8", env: oldEnv });
  assert.notEqual(old.status, 0);
  assert.equal(oldUnbound.status, 0, oldUnbound.stderr);
  assert.equal(JSON.parse(oldUnbound.stdout).operation, null);
  const joined = beginUnboundManagedMcpLaunch(root, randomUUID());
  assert.equal(joined.sessionId, registration.registration.sessionId);
  fs.mkdirSync(path.join(root, ".pkm/state/managed-writer-session"));
  assert.throws(() => bootstrapCompatibleManagedProfile(root, "b".repeat(64)), /multiple managed writer sessions/i);
});

test("a running compatible-aware unbound retrieval client is affected by later bootstrap", {
  skip: process.platform !== "linux",
}, async t => {
  const root = fixture(t), env = { ...process.env };
  delete env.PKM_MANAGED_WRITER_SESSION;
  const child = spawn(process.execPath, ["-e", `
    const m = require(process.argv[1]), readline = require("node:readline");
    readline.createInterface({input: process.stdin}).on("line", async () => {
      try { console.log(JSON.stringify({ value: await m.withManagedRetrievalOperation(process.argv[2], async () => "available") })); }
      catch (error) { console.log(JSON.stringify({ error: error.message })); }
    });
  `, path.join(dist, "runtime/managed-writer-session"), root], { env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const lines = require("node:readline").createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.write("before\n");
  assert.deepEqual(JSON.parse((await lines.next()).value), { value: "available" });
  bootstrapCompatibleManagedProfile(root, "a".repeat(64));
  child.stdin.write("after\n");
  assert.match(JSON.parse((await lines.next()).value).error, /not enrolled/);
  const closed = new Promise(resolve => child.once("close", resolve));
  child.stdin.end();
  await closed;
});

test("compatible session is not mistaken for a Next adoption receipt", {
  skip: process.platform !== "linux" || !process.env.PKM_TEST_NEXT_INSPECTOR,
}, async t => {
  const root = fixture(t);
  bootstrapCompatibleManagedProfile(root, "a".repeat(64));
  const { inspectLegacyManagedWriterSession } = await import(process.env.PKM_TEST_NEXT_INSPECTOR);
  assert.throws(() => inspectLegacyManagedWriterSession(root), /no Next adoption receipt/i);
});

test("killed initializer recovers its own staged session and preserves evidence", { skip: process.platform !== "linux" }, async t => {
  for (const point of ["before-link", "link", "before-rename", "after-rename"]) {
    const root = fixture(t), script = `
      const fs = require("fs"), link = fs.linkSync, rename = fs.renameSync;
      fs.linkSync = function(source, target) {
        if (process.argv[3] === "before-link" && String(target).endsWith("managed-writer-session.lock")) process.kill(process.pid, "SIGKILL");
        const result = link.apply(this, arguments);
        if (process.argv[3] === "link" && String(target).endsWith("managed-writer-session.lock")) process.kill(process.pid, "SIGKILL");
        return result;
      };
      fs.renameSync = function(source, target) {
        const session = String(source).includes("managed-writer-session-init.");
        if (session && process.argv[3] === "before-rename") process.kill(process.pid, "SIGKILL");
        const result = rename.apply(this, arguments);
        if (session && process.argv[3] === "after-rename") process.kill(process.pid, "SIGKILL");
        return result;
      };
      require(process.argv[1]).bootstrapManagedProfile(process.argv[2], "a".repeat(64));
    `;
    const child = spawn(process.execPath, ["-e", script, path.join(dist, "runtime/managed-writer-session"), root, point],
      { stdio: ["ignore", "pipe", "pipe"] });
    const signal = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (_code, killed) => resolve(killed));
    });
    assert.equal(signal, "SIGKILL");
    const result = bootstrapManagedProfile(root, "b".repeat(64));
    assert.equal(result.created, point !== "after-rename");
    const archive = path.join(root, ".pkm/state/managed-writer-session-recovery");
    const entries = fs.readdirSync(archive);
    assert.equal(entries.length, 1);
    assert(fs.existsSync(path.join(archive, entries[0], point === "before-link" ? "lock-entry" : "lock")));
    assert.equal(fs.existsSync(path.join(archive, entries[0], "staging")), point === "before-rename");
  }
});

test("concurrent recovery serializes and an incomplete record remains untouched", { skip: process.platform !== "linux" }, async t => {
  for (const point of ["staging", "partial-record"]) {
    const root = fixture(t), script = `
      const fs = require("fs"), rename = fs.renameSync, open = fs.openSync, write = fs.writeFileSync;
      let pending;
      fs.renameSync = function(source, target) {
        if (process.argv[3] === "staging" && String(source).includes("managed-writer-session-init.")) process.kill(process.pid, "SIGKILL");
        return rename.apply(this, arguments);
      };
      fs.openSync = function(file) {
        const fd = open.apply(this, arguments);
        if (process.argv[3] === "partial-record" && String(file).endsWith(".pending")) pending = fd;
        return fd;
      };
      fs.writeFileSync = function(file) {
        if (file === pending) { write.call(this, file, "{"); process.kill(process.pid, "SIGKILL"); }
        return write.apply(this, arguments);
      };
      require(process.argv[1]).bootstrapManagedProfile(process.argv[2], "a".repeat(64));
    `;
    const modulePath = path.join(dist, "runtime/managed-writer-session");
    const crash = spawn(process.execPath, ["-e", script, modulePath, root, point], { stdio: "ignore" });
    assert.equal(await new Promise(resolve => crash.once("close", (_code, signal) => resolve(signal))), "SIGKILL");
    if (point === "partial-record") {
      assert.throws(() => bootstrapManagedProfile(root, "b".repeat(64)));
      const operations = path.join(root, ".pkm/state/managed-writer-session/operations");
      assert.equal(fs.readFileSync(path.join(operations, fs.readdirSync(operations)[0]), "utf8"), "{");
      continue;
    }
    const retry = `console.log(JSON.stringify(require(process.argv[1]).bootstrapManagedProfile(process.argv[2], "b".repeat(64))))`;
    const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", retry, modulePath, root], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += data; });
      child.stderr.on("data", data => { stderr += data; });
      child.once("error", reject);
      child.once("close", code => code ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)));
    })));
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(new Set(results.map(result => result.registration.sessionId)).size, 1);
    assert.equal(fs.readdirSync(path.join(root, ".pkm/state/managed-writer-session/operations")).length, 4);
  }
});

test("legacy lock without verifiable owner identity is never reclaimed", { skip: process.platform !== "linux" }, t => {
  const root = fixture(t), state = path.join(root, ".pkm/state");
  fs.mkdirSync(state, { recursive: true });
  const lock = path.join(state, "managed-writer-session.lock");
  const value = JSON.stringify({ pid: 2147483647, nonce: randomUUID(), acquiredAt: Date.now(), owner: "Managed writer admission" });
  fs.writeFileSync(lock, value);
  assert.throws(() => bootstrapManagedProfile(root, "b".repeat(64)), /abandoned|unknown/i);
  assert.equal(fs.readFileSync(lock, "utf8"), value);
});

test("recovery itself can crash after preserving staged initialization", { skip: process.platform !== "linux" }, async t => {
  const root = fixture(t), modulePath = path.join(dist, "runtime/managed-writer-session");
  const script = `
    const fs = require("fs"), rename = fs.renameSync;
    fs.renameSync = function(source, target) {
      if (process.argv[3] === "initial" && String(source).includes("managed-writer-session-init.")) process.kill(process.pid, "SIGKILL");
      const result = rename.apply(this, arguments);
      if (process.argv[3] === "recovery" && String(target).endsWith("/staging")) process.kill(process.pid, "SIGKILL");
      return result;
    };
    require(process.argv[1]).bootstrapManagedProfile(process.argv[2], "a".repeat(64));
  `;
  for (const point of ["initial", "recovery"]) {
    const child = spawn(process.execPath, ["-e", script, modulePath, root, point], { stdio: "ignore" });
    assert.equal(await new Promise(resolve => child.once("close", (_code, signal) => resolve(signal))), "SIGKILL");
  }
  assert.equal(bootstrapManagedProfile(root, "b".repeat(64)).created, true);
  const archive = path.join(root, ".pkm/state/managed-writer-session-recovery");
  assert(fs.readdirSync(archive).some(name => fs.existsSync(path.join(archive, name, "staging"))));
});

test("default enrollment joins an existing session before fencing and cannot join afterward", { skip: process.platform !== "linux" }, async t => {
  const root = fixture(t), id = randomUUID();
  provisionManagedWriterSession(root, id);
  const profileId = "a".repeat(64), registration = enrollExistingManagedProfile(root, profileId);
  assert.equal(registration.sessionId, id);
  const controller = activateManagedProfileWriter(root, id, async () => {}, 50, () => true, profileId, undefined, registration);
  const result = await controller.handoff(1000);
  assert.equal(result.registeredWritersDrained, true);
  assert.equal(result.preexistingAndExternalWriters, "unknown");
  assert.throws(() => enrollExistingManagedWriterSession(root), /fenced/);
  assert.throws(() => enrollExistingManagedProfile(root, "b".repeat(64)), /fenced/);
  assert.throws(() => activateManagedProfileWriter(root, id, async () => {}, 50, () => true, "b".repeat(64)), /fenced/);
  controller.dispose();
});

test("fence racing profile registration rejects the late host", { skip: process.platform !== "linux" }, t => {
  const root = fixture(t), id = randomUUID();
  provisionManagedWriterSession(root, id);
  const joined = enrollExistingManagedWriterSession(root);
  closeManagedWriterAdmission(root, id);
  assert.throws(() => registerManagedProfile(root, joined, "c".repeat(64)), /fenced/);
  assert.deepEqual(fs.readdirSync(path.join(root, ".pkm/state/managed-writer-session/operations")), []);
});

test("a profile fenced between early enrollment and activation begins draining", { skip: process.platform !== "linux" }, async t => {
  const root = fixture(t), id = randomUUID(), profileId = "d".repeat(64);
  provisionManagedWriterSession(root, id);
  const registration = registerManagedProfile(root, id, profileId);
  closeManagedWriterAdmission(root, id);
  let release;
  const profile = activateManagedProfileWriter(root, id, () => new Promise(resolve => { release = resolve; }),
    50, () => true, profileId, undefined, registration);
  assert.equal(profile.status().state, "draining");
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release();
  while (profile.status().state === "draining") await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(profile.status().state, "drained");
  profile.dispose();
});

test("session fence prevents late retrieval hosts while a previously admitted request completes", { skip: process.platform !== "linux" }, async t => {
  const root = fixture(t), id = randomUUID();
  provisionManagedWriterSession(root, id);
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  let release;
  const active = withManagedRetrievalOperation(root, () => new Promise(resolve => { release = resolve; }));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  closeManagedWriterAdmission(root, id);
  await assert.rejects(withManagedRetrievalOperation(root, async () => "late"), /fenced/);
  delete process.env.PKM_MANAGED_WRITER_SESSION;
  await assert.rejects(withManagedRetrievalOperation(root, async () => "unbound late"), /not enrolled/);
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  release("finished");
  assert.equal(await active, "finished");
  const records = fs.readdirSync(path.join(root, ".pkm/state/managed-writer-session/operations"));
  assert.equal(records.filter(name => name.endsWith(".pending")).length, 1);
  assert.equal(records.filter(name => name.endsWith(".complete")).length, 1);
});

test("failed retrieval request remains pending and blocks session handoff", { skip: process.platform !== "linux" }, async t => {
  const root = fixture(t), id = randomUUID();
  provisionManagedWriterSession(root, id);
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  await assert.rejects(withManagedRetrievalOperation(root, async () => { throw new Error("uncertain request"); }), /uncertain request/);
  closeManagedWriterAdmission(root, id);
  await assert.rejects(orchestrateManagedWriterHandoff(root, id, [], 1000), /unknown|active/i);
});

test("Next inspector reports completed retrieval requests but not worker drain", {
  skip: process.platform !== "linux" || !process.env.PKM_TEST_NEXT_INSPECTOR,
}, async t => {
  const { inspectLegacyManagedWriterSession } = await import(process.env.PKM_TEST_NEXT_INSPECTOR);
  const root = fixture(t), id = randomUUID();
  provisionManagedWriterSession(root, id);
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  await withManagedRetrievalOperation(root, async () => {});
  closeManagedWriterAdmission(root, id);
  const successor = rotateManagedWriterSession(root, id).sessionId;
  closeManagedWriterAdmission(root, successor);
  assert.deepEqual(inspectLegacyManagedWriterSession(root).retrieval,
    { completedRequests: 1, workerDrain: "unknown" });
});

test("Next inspector rejects an interrupted retrieval request after rotation", {
  skip: process.platform !== "linux" || !process.env.PKM_TEST_NEXT_INSPECTOR,
}, async t => {
  const { inspectLegacyManagedWriterSession } = await import(process.env.PKM_TEST_NEXT_INSPECTOR);
  const root = fixture(t), id = randomUUID();
  provisionManagedWriterSession(root, id);
  closeManagedWriterAdmission(root, id);
  const successor = rotateManagedWriterSession(root, id).sessionId;
  process.env.PKM_MANAGED_WRITER_SESSION = successor;
  await assert.rejects(withManagedRetrievalOperation(root, async () => { throw new Error("lost"); }), /lost/);
  closeManagedWriterAdmission(root, successor);
  assert.throws(() => inspectLegacyManagedWriterSession(root), error =>
    error.code === "PKM_STATE_UNSUPPORTED" && /unknown outcome/i.test(error.message));
});

test("durable build completion is bound to the admitted request and Next still marks the worker unknown", {
  skip: process.platform !== "linux" || !process.env.PKM_TEST_NEXT_INSPECTOR,
}, async t => {
  const { inspectLegacyManagedWriterSession } = await import(process.env.PKM_TEST_NEXT_INSPECTOR);
  const root = fixture(t), id = randomUUID();
  provisionManagedWriterSession(root, id);
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  const build = await withManagedRetrievalOperation(root, async () =>
    beginManagedRetrievalBuild("a".repeat(64), "b".repeat(64)));
  assert(build);
  assert.throws(() => completeManagedRetrievalBuild({ ...build, workerHash: "c".repeat(64) }), /pending record is invalid/);
  completeManagedRetrievalBuild(build);
  closeManagedWriterAdmission(root, id);
  const successor = rotateManagedWriterSession(root, id).sessionId;
  closeManagedWriterAdmission(root, successor);
  assert.deepEqual(inspectLegacyManagedWriterSession(root).retrieval,
    { completedRequests: 1, completedBuilds: 1, workerDrain: "unknown" });
});

test("interrupted durable build stays unknown after its retrieval request completed", {
  skip: process.platform !== "linux" || !process.env.PKM_TEST_NEXT_INSPECTOR,
}, async t => {
  const { inspectLegacyManagedWriterSession } = await import(process.env.PKM_TEST_NEXT_INSPECTOR);
  const root = fixture(t), first = randomUUID();
  provisionManagedWriterSession(root, first);
  closeManagedWriterAdmission(root, first);
  const id = rotateManagedWriterSession(root, first).sessionId;
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  await withManagedRetrievalOperation(root, async () => beginManagedRetrievalBuild("a".repeat(64), "b".repeat(64)));
  closeManagedWriterAdmission(root, id);
  assert.throws(() => inspectLegacyManagedWriterSession(root), error =>
    error.code === "PKM_STATE_UNSUPPORTED" && /unknown outcome/i.test(error.message));
});

test("a request admitted before fencing may register and finish its nested build", { skip: process.platform !== "linux" }, async t => {
  const root = fixture(t), id = randomUUID();
  provisionManagedWriterSession(root, id);
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  let release, started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const active = withManagedRetrievalOperation(root, async () => {
    started();
    await new Promise(resolve => { release = resolve; });
    return beginManagedRetrievalBuild("a".repeat(64), "b".repeat(64));
  });
  await startedPromise;
  closeManagedWriterAdmission(root, id);
  release();
  const build = await active;
  completeManagedRetrievalBuild(build);
  assert.equal((await orchestrateManagedWriterHandoff(root, id, [], 1000)).registeredWritersDrained, true);
});

test("Next validates durable existing MCP identities and rejects incomplete registrations", {
  skip: process.platform !== "linux" || !process.env.PKM_TEST_NEXT_INSPECTOR,
}, async t => {
  const { inspectLegacyManagedWriterSession } = await import(process.env.PKM_TEST_NEXT_INSPECTOR);
  const root = fixture(t), first = randomUUID();
  provisionManagedWriterSession(root, first);
  closeManagedWriterAdmission(root, first);
  const id = rotateManagedWriterSession(root, first).sessionId;
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  const identity = { generation: randomUUID(), instanceId: "a".repeat(32), runtimeBuild: "b".repeat(64) };
  const existing = beginExistingManagedMcp(root, id, identity);
  assert.throws(() => completeExistingManagedMcp({ ...existing, instanceId: "c".repeat(32) }), /pending record is invalid/);
  closeManagedWriterAdmission(root, id);
  assert.throws(() => inspectLegacyManagedWriterSession(root), error =>
    error.code === "PKM_STATE_UNSUPPORTED" && /unknown outcome/i.test(error.message));
  completeExistingManagedMcp(existing);
  assert.equal(inspectLegacyManagedWriterSession(root).sessionId, id);
});

test("the ordinary manager uses the same session admission for its real top-level request", { skip: process.platform !== "linux" }, async t => {
  const root = fixture(t), id = randomUUID();
  provisionManagedWriterSession(root, id);
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  const manager = new RetrievalWorkerManager("/unused/state", "/unused/worker.py", "/unused/python", "fixture", undefined,
    undefined, undefined, undefined, work => withManagedRetrievalOperation(root, work));
  manager.ensureInner = async () => ({ pid: 123, port: 4321, token: "fixture" });
  await manager.ensure();
  closeManagedWriterAdmission(root, id);
  await assert.rejects(manager.ensure(), /fenced/);
  assert.equal(await manager.closeOwned(), "unused");
});

test("production retrieval paths preserve unmanaged root changes and reject managed rebinding", async () => {
  const text = fs.readFileSync(path.resolve("src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", text, ts.ScriptTarget.Latest, true);
  const admission = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "admitRetrievalRoot");
  assert(admission);
  const callbacks = [];
  const visit = node => {
    if (ts.isNewExpression(node) && node.expression.getText(ast) === "RetrievalWorkerManager")
      callbacks.push(node.arguments?.[8]);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(callbacks.length, 2);
  for (const callback of callbacks) {
    assert(callback && ts.isArrowFunction(callback));
    const calls = [];
    let currentRoot = "/captured/root";
    let managed = false;
    const sandbox = { root: currentRoot, path, process: { platform: "linux" },
      getStorePath: () => currentRoot, hasManagedRetrievalSession: () => managed,
      withManagedRetrievalOperation: async (root, action) => {
      calls.push(root);
      return action();
    } };
    vm.runInNewContext(ts.transpileModule(`${admission.getText(ast)}; globalThis.admit = ${callback.getText(ast)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, sandbox);
    assert.equal(await sandbox.admit(async () => "ran"), "ran");
    assert.deepEqual(calls, ["/captured/root"]);
    currentRoot = "/other/root";
    assert.equal(await sandbox.admit(async () => "ran after switch"), "ran after switch");
    assert.deepEqual(calls, ["/captured/root", "/other/root"]);
    managed = true;
    assert.throws(() => sandbox.admit(async () => "wrong root"), /different managed Knowledge Root/);
    assert.deepEqual(calls, ["/captured/root", "/other/root"]);
    currentRoot = "/captured/root";
    sandbox.withManagedRetrievalOperation = async (_root, action) => {
      currentRoot = "/other/root";
      return action();
    };
    let dispatched = false;
    await assert.rejects(sandbox.admit(async () => { dispatched = true; }), /Knowledge Root changed/);
    assert.equal(dispatched, false);
  }
});
