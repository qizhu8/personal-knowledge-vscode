"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const ts = require("typescript");

test("private host binds credential requests, rejects replay and cleans up children", async t => {
  const fixture = path.resolve(".migration-test-work", `pkm-sync-fixture-${randomUUID()}`);
  const extension = path.join(fixture, "x/target"), profile = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge");
  for (const dir of ["native-root", "legacy-root", "provider", "remote.git", "t", "x/target/next-runtime/server/dist"])
    fs.mkdirSync(path.join(fixture, dir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(extension, "next-runtime/server/dist/legacy-github-sync-vscode-child.js"), "");
  const previous = process.env.PKM_PRIVATE_SYNC_FIXTURE;
  process.env.PKM_PRIVATE_SYNC_FIXTURE = fixture;
  t.after(() => {
    if (previous === undefined) delete process.env.PKM_PRIVATE_SYNC_FIXTURE;
    else process.env.PKM_PRIVATE_SYNC_FIXTURE = previous;
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  let child, launch, reads = 0;
  class Child extends EventEmitter {
    exitCode = null;
    signalCode = null;
    connected = true;
    sends = [];
    send(value, callback) { this.sends.push(value); callback?.(); }
    kill(signal) { this.signalCode = signal; this.connected = false; queueMicrotask(() => this.emit("exit", null, signal)); }
  }
  const source = fs.readFileSync(path.resolve("src/runtime/next-sync-fixture-client.ts"), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const injectedRequire = name => {
    if (name === "child_process") return { fork: (entry, args, options) => {
      child = new Child(); launch = { entry, args, options }; return child;
    } };
    if (name === "./next-payload-verifier") return { verifyNextPayload: () => ({ root: path.join(extension, "next-runtime") }) };
    return require(name);
  };
  new Function("require", "exports", js)(injectedRequire, exports);
  const context = { extensionPath: extension, globalStorageUri: { fsPath: profile }, subscriptions: [],
    secrets: { get: async key => {
      reads++; assert.equal(key, "personalKnowledge.githubSync.vscode.fixture-target");
      return JSON.stringify({ accountLabel: "fixture", accessToken: "fixture-token" });
    } } };
  const run = action => exports.runNextSyncFixture(context, path.join(fixture, "legacy-root"), { fixture, action, policy: {} });
  const emitRequest = (session, requestId, key = "personalKnowledge.githubSync.vscode.fixture-target") =>
    child.emit("message", { type: "credential-request", session, requestId, key });
  let promise = run("sync"), session = child.sends[0].session, requestId = randomUUID();
  assert.deepEqual(launch.args, []);
  assert(!JSON.stringify(launch.options).includes("fixture-token"));
  emitRequest(session, requestId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); assert.equal(child.sends[1].requestId, requestId);
  assert.equal(JSON.parse(child.sends[1].value).accessToken, "fixture-token");
  child.emit("message", { type: "result", session, result: { state: "published" }, pushes: 1 });
  child.emit("exit", 0, null);
  const result = await promise;
  assert.equal(result.credentialReads, 1); assert(!JSON.stringify(result).includes("fixture-token"));
  assert.equal(context.subscriptions.length, 0);

  promise = run("sync"); session = child.sends[0].session; requestId = randomUUID();
  emitRequest(session, requestId); emitRequest(session, requestId);
  await assert.rejects(promise, /No automatic retry/);
  assert.equal(child.signalCode, "SIGKILL");
  promise = run("sync"); emitRequest(randomUUID(), randomUUID());
  await assert.rejects(promise, /No automatic retry/);
  promise = run("sync"); emitRequest(child.sends[0].session, randomUUID(), "wrong-key");
  await assert.rejects(promise, /No automatic retry/);
  promise = run("sync"); child.emit("error", new Error("secret must not leak"));
  await assert.rejects(promise, error => /spawn-error/.test(error.message) && !error.message.includes("secret"));
  promise = run("sync"); session = child.sends[0].session;
  child.emit("message", { type: "error", session, code: "LEGACY_WRITERS_ACTIVE" });
  child.emit("exit", 1, null);
  await assert.rejects(promise, /LEGACY_WRITERS_ACTIVE/);
  promise = run("sync"); session = child.sends[0].session;
  child.emit("message", { type: "error", session, code: "fixture-token" });
  await assert.rejects(promise, error => !error.message.includes("fixture-token"));
  promise = run("sync"); context.subscriptions[0].dispose();
  await assert.rejects(promise, /disposed/);
  assert.equal(context.subscriptions.length, 0);
  promise = run("resume"); session = child.sends[0].session;
  child.emit("message", { type: "result", session, result: { state: "conflict" }, pushes: 0 });
  child.emit("exit", 0, null);
  assert.equal((await promise).credentialReads, 0);
});
