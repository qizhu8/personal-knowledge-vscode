const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PeerSession } = require("../dist/chatroom/peer-session");
const { executePortalCommand, parsePortalCommand, portalCommandCapabilities } = require("../dist/chatroom/portal-command");
const { selectPortalRoute } = require("../dist/chatroom/portal-routing");

async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Portal direct command timed out in test");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function pair(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-portal-command-"));
  const errors = [], reviews = [];
  let a, b, runs = 0, approvals = 0, models = 0;
  const common = {
    roomId: "commands", connected: () => true, changed() {}, error: error => errors.push(error.message),
    approvePair: async () => true, approveSwap: async () => false,
    approveTask: async () => { models++; throw new Error("Must not use model task approval"); },
    execute: async () => { models++; throw new Error("Must not call a model"); },
  };
  a = new PeerSession({ ...common, ...overrides.controller, reviewNeeded: review => reviews.push(review),
    send: (_target, packet) => { void b.receive({ from: "a", fromName: "Controller", packet }); } });
  b = new PeerSession({ ...common, commandCapabilities: [`platform:${process.platform}`],
    approveCommand: async () => { approvals++; return overrides.approve !== false; },
    executeCommand: async (command, signal, requestId) => {
      runs++;
      return executePortalCommand(root, requestId, command, root, signal);
    }, ...overrides.controlled,
    send: (_target, packet) => { void a.receive({ from: "b", fromName: "Controlled", packet }); } });
  a.pair("b", b.invite());
  await until(() => a.binding && b.binding);
  t.after(async () => { a.dispose(); b.dispose(); await until(() => b.active.size === 0); await fs.rm(root, { recursive: true, force: true }); });
  return { a, b, root, errors, reviews, get runs() { return runs; }, get approvals() { return approvals; }, get models() { return models; } };
}

const command = script => ({ program: process.execPath, arguments: ["-e", script], timeoutSeconds: 10 });

test("Portal commands execute with real stdout/stderr/exit code, no model/review, no replay", async t => {
  const f = await pair(t);
  const spec = command("console.log('PKM_PORTAL_CMD_TEST'); console.error('stderr evidence')");
  const id = f.a.submitCommand(spec);
  await until(() => f.a.receipts.get(id)?.state === "completed");
  const result = f.a.receipts.get(id).result;
  assert.equal(result.modelCalls, 0);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /PKM_PORTAL_CMD_TEST/);
  assert.match(result.stderr, /stderr evidence/);
  f.a.submitCommand(spec, id);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.runs, 1);
  assert.equal(f.approvals, 1);
  assert.equal(f.models, 0);
  assert.deepEqual(f.reviews, []);
  assert.throws(() => f.a.submitCommand(command("console.log('different')"), id), /different content/);
  assert.throws(() => f.b.submitCommand(spec), /controller/);
  assert.deepEqual(f.errors, []);
});

test("Direct commands denied at executing end cannot launch", async t => {
  const f = await pair(t, { approve: false });
  const id = f.a.submitCommand(command("throw new Error('must not launch')"));
  await until(() => f.a.receipts.get(id)?.state === "denied");
  assert.equal(f.runs, 0);
  assert.equal(f.models, 0);
});

test("Long direct command stays running until process exits; cancellation is acknowledged", async t => {
  const f = await pair(t);
  const id = f.a.submitCommand(command("console.log('started'); setInterval(() => {}, 1000)"));
  await until(() => f.a.receipts.get(id)?.state === "running");
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(f.a.receipts.get(id).state, "running");
  f.a.cancel(id);
  await until(() => f.a.receipts.get(id)?.state === "cancelled");
  assert.equal(f.a.receipts.get(id).result.state, "cancelled");
  assert.equal(f.runs, 1);
});

test("Nonzero exit and timeout are not success-shaped command results", async t => {
  const f = await pair(t);
  const id = f.a.submitCommand(command("process.exitCode = 7"));
  await until(() => f.a.receipts.get(id)?.state === "failed");
  assert.equal(f.a.receipts.get(id).result.exitCode, 7);
  const timed = f.a.submitCommand({ ...command("setInterval(() => {}, 1000)"), timeoutSeconds: 1 });
  await until(() => f.a.receipts.get(timed)?.state === "failed");
  assert.equal(f.a.receipts.get(timed).result.state, "timed-out");
});

test("Old peers cannot accidentally route direct commands through their model", async t => {
  const f = await pair(t, { controlled: { executeCommand: undefined } });
  assert.throws(() => f.a.submitCommand(command("console.log('no')")), /upgrade both Hosts/);
  assert.equal(f.runs, 0);
  assert.equal(f.models, 0);
});

test("Explicit capabilities route to one eligible Host; missing/ambiguous never execute", async () => {
  const routes = [
    { contextId: randomUUID(), connected: true, role: "controller", capabilities: ["commands-v1", "platform:win32", "program:cmd"] },
    { contextId: randomUUID(), connected: true, role: "controller", capabilities: ["commands-v1", "platform:linux", "program:bash"] },
  ];
  assert.equal(selectPortalRoute(routes, { platform: "win32", programs: ["cmd"] }).contextId, routes[0].contextId);
  assert.throws(() => selectPortalRoute(routes, { programs: ["aether"] }), /No connected/);
  assert.throws(() => selectPortalRoute([routes[0], { ...routes[0], contextId: randomUUID() }], { platform: "win32" }), /Multiple/);
  assert.throws(() => selectPortalRoute([{ ...routes[0], role: "controlled" }], { platform: "win32" }), /No connected/);
  assert.throws(() => selectPortalRoute([{ ...routes[0], connected: false }], { platform: "win32" }), /No connected/);
  assert.throws(() => selectPortalRoute(routes, {}), /Specify/);
  assert.throws(() => parsePortalCommand({ program: "cmd.exe", arguments: ["\0"] }), /Invalid/);
  assert.throws(() => parsePortalCommand({ program: "cmd.exe", arguments: [], timeoutSeconds: 0 }), /timeout/);
  assert((await portalCommandCapabilities()).includes(`platform:${process.platform}`));
});

test("Both sides observe the direct-command lifecycle for a visible Chat trace; observer failures never break execution", async t => {
  const sent = [], received = [];
  const f = await pair(t, {
    controller: { commandActivity: activity => { sent.push(activity); throw new Error("trace sink unavailable"); } },
    controlled: { commandActivity: activity => received.push(activity) },
  });
  const spec = command("console.log('VISIBLE_TRACE')");
  const id = f.a.submitCommand(spec);
  await until(() => f.a.receipts.get(id)?.state === "completed" && sent.some(item => item.state === "completed"));
  assert(sent.every(item => item.role === "controller" && item.peerName === "Controlled" && item.requestId === id && item.command.program === spec.program));
  assert.deepEqual(received.map(item => item.state), ["awaiting-approval", "running", "completed"]);
  assert(received.every(item => item.role === "controlled" && item.peerName === "Controller"));
  assert.match(received.at(-1).result.stdout, /VISIBLE_TRACE/);
  assert.match(sent.at(-1).result.stdout, /VISIBLE_TRACE/);
  assert.equal(f.models, 0);
  assert.deepEqual(f.errors, []);
});
