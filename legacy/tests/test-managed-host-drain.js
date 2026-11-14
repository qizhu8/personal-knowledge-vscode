"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const vm = require("node:vm");
const ts = require("typescript");
const dist = process.env.PKM_TEST_DIST || path.resolve("dist");
const { HostWriterAdmission } = require(path.join(dist, "runtime/host-writer-admission"));
const { drainManagedHost } = require(path.join(dist, "runtime/managed-host-drain"));

function fixture(t) {
  const root = path.resolve(".migration-test-work", `managed-host-drain-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("managed host closes admission before waiting for its own UI and Chat work", async t => {
  const root = fixture(t), owner = new HostWriterAdmission(root, () => root);
  let releaseUi, releaseChat;
  const ui = owner.observe("ui", () => new Promise(resolve => { releaseUi = resolve; }));
  const draining = drainManagedHost(owner, () => new Promise(resolve => { releaseChat = resolve; }), undefined);
  await assert.rejects(owner.observe("ui", () => {}), /closed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(owner.status().state, "draining");
  releaseUi(); releaseChat();
  await ui;
  await draining;
  assert.equal(owner.status().state, "drained");
  assert.equal(owner.status().completeHostCoverage, false);
  assert.equal(owner.status().cutoverAuthorized, false);
});

test("managed drain quiesces local retrieval without stopping the shared worker", async t => {
  const root = fixture(t), owner = new HostWriterAdmission(root, () => root);
  let release, calls = 0, closed = false;
  const retrieval = {
    quiesceLocal() { calls++; closed = true; return new Promise(resolve => { release = resolve; }); },
    closeOwned() { throw new Error("Shared worker must not be stopped"); },
  };
  const draining = drainManagedHost(owner, async () => {}, retrieval);
  assert.equal(closed, true);
  assert.equal(calls, 1);
  release();
  await draining;
  assert.equal(owner.status().state, "drained");
  assert.equal(owner.status().cutoverAuthorized, false);
});

test("managed drain waits for all started resources and preserves failed outcomes", async t => {
  const root = fixture(t), owner = new HostWriterAdmission(root, () => root);
  let release;
  const retrieval = { quiesceLocal: () => new Promise(resolve => { release = resolve; }) };
  let completed = false;
  const draining = drainManagedHost(owner, async () => { throw new Error("Chat outcome unknown"); }, retrieval)
    .finally(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  release();
  await assert.rejects(draining, /Chat outcome unknown/);
  assert.equal(owner.status().cutoverAuthorized, false);
});

test("the actual activation callback closes retrieval admission before draining the host", async t => {
  const root = fixture(t), owner = new HostWriterAdmission(root, () => root);
  const text = fs.readFileSync(path.resolve("src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", text, ts.ScriptTarget.Latest, true);
  let callback;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "activateManagedProfileWriter")
      callback = node.arguments[2];
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert(callback && ts.isArrowFunction(callback));
  const sandbox = { hostWriterAdmission: owner, drainManagedHost, retrievalAdmissionClosed: false,
    apiChat: { drainManagedWriter: async () => {} }, retrievalWorker: {
      quiesceLocal: async () => { assert.equal(sandbox.retrievalAdmissionClosed, true); },
    } };
  vm.runInNewContext(ts.transpileModule(`globalThis.callback = ${callback.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, sandbox);
  await sandbox.callback();
  assert.equal(sandbox.retrievalAdmissionClosed, true);
  assert.equal(owner.status().state, "drained");
});

test("ordinary deactivation closes retrieval admission before its first asynchronous wait", () => {
  const text = fs.readFileSync(path.resolve("src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", text, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "deactivate");
  assert(declaration?.body);
  const firstAwait = declaration.body.statements.findIndex(statement => statement.getText(ast).includes("await "));
  const gate = declaration.body.statements.findIndex(statement => statement.getText(ast).includes("retrievalAdmissionClosed = true"));
  const close = declaration.body.statements.findIndex(statement => statement.getText(ast).includes("retrievalWorker?.closeOwned()"));
  assert(gate >= 0 && close > gate && firstAwait > close);
});

test("normal activation enrolls its profile before initializing the Chat shell", () => {
  const text = fs.readFileSync(path.resolve("src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", text, ts.ScriptTarget.Latest, true);
  const activation = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "activate");
  assert(activation?.body);
  const statements = activation.body.statements;
  const enroll = statements.findIndex(node => node.getText(ast).includes("registerManagedProfile("));
  const shell = statements.findIndex(node => node.getText(ast).includes("registerApiChatShell("));
  const initializeNormalHost = statements.findIndex(node => node.getText(ast).includes("registerNextManagedTrial("));
  assert(enroll >= 0 && initializeNormalHost > enroll && shell > enroll);
});
