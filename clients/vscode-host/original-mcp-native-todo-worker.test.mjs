import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url)), require = createRequire(import.meta.url);
const { build } = require("esbuild");
const built = await build({
  entryPoints: [join(root, "clients/vscode-host/original-mcp-native-todo-worker.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, metafile: true, logLevel: "silent",
  plugins: [{ name: "fixture-signer", setup(plugin) {
    plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ }, () => ({ path: "worker-fixture-signer", external: true }));
  } }],
});
assert(!Object.keys(built.metafile.inputs).some(path =>
  /(?:storage|original-mcp-native-host|original-mcp-native-todo-worker-policy)\.ts$/.test(path)),
"Native worker consent must not import Node/Core authority.");
const { originalNativeTodoWorkerDigest: digest, parseOriginalNativeTodoWorkerDecision } =
  await import("../../dist/original-mcp-native-todo-worker-contracts.js");
const yes = "Enroll this exact Board worker";
async function fixture(t) {
  const choices = [], prompts = [], bars = [], commands = new Map(), attachment = new AbortController(), signed = new AbortController();
  const epoch = randomUUID(), session = {
    brokerId: randomUUID(), activationId: epoch, epoch, identitySha256: "a".repeat(64),
    binding: { root: "/fixture/original-worker", workspaceId: randomUUID(), planSha256: "b".repeat(64),
      catalogSha256: "c".repeat(64), profileSha256: "d".repeat(64), payloadBuildId: "e".repeat(64), hostEntrySha256: "f".repeat(64) },
  };
  let alive = true, trusted = true, changed, closes = 0;
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root: session.binding.root,
    workspaceId: session.binding.workspaceId, planSha256: session.binding.planSha256, profileSha256: session.binding.profileSha256,
    sourceCatalogSha256: session.binding.catalogSha256, authorityId: `native-rpc:${session.brokerId}`,
    epoch, actorId: "mcp:external", domains: ["model-provider", "mcp-public"], configurationSha256: "1".repeat(64) };
  const payload = {
    binding, request: { schema: "pkm.original-mcp-todo-worker-request/v1", root: binding.root, workspaceId: binding.workspaceId,
      nativeHostReceiptSha256: digest(binding), intentSha256: "2".repeat(64), boardSlug: "Team/Board",
      actorId: "external:copilot:fresh-worker", tokenSha256: "3".repeat(64), boardDigest: "4".repeat(64) },
    custodyPlanSha256: binding.planSha256, profileSha256: binding.profileSha256, epoch,
    sourceSha256: "5".repeat(64), sessionDecisionId: randomUUID(), sessionExpiresAtMs: Date.now() + 180_000,
    noExecution: true, noLegacyTokenInheritance: true,
  };
  const signer = { activationId: epoch, identity: { sha256: session.identitySha256, profileSha256: session.binding.profileSha256 },
    payloadBuildId: session.binding.payloadBuildId, hostEntrySha256: session.binding.hostEntrySha256, signal: signed.signal,
    assertCurrent() { if (!alive) throw new Error("Native signed owner changed."); } };
  const load = Module._load, context = { subscriptions: [] };
  let api;
  try {
    Module._load = function (id, ...args) {
      if (id === "worker-fixture-signer") return { originalMcpNativeSigner: async () => signer };
      if (id === "vscode") return {
        StatusBarAlignment: { Left: 1 }, commands: { registerCommand(name, callback) {
          commands.set(name, callback); return { dispose() { commands.delete(name); } };
        } },
        workspace: { get isTrusted() { return trusted; }, onDidChangeWorkspaceFolders(callback) {
          changed = callback; return { dispose() {} };
        } },
        window: {
          showWarningMessage(title, options) { prompts.push({ title, detail: JSON.parse(options.detail) }); return choices.shift(); },
          showErrorMessage() {},
          createStatusBarItem() { const bar = { show() {}, dispose() { bar.disposed = true; } }; bars.push(bar); return bar; },
        },
      };
      return load.call(this, id, ...args);
    };
    const name = join(root, "clients/vscode-host", `.worker-producer-memory-${randomUUID()}.cjs`), compiled = new Module(name);
    compiled.filename = name; compiled.paths = Module._nodeModulePaths(join(root, "clients/vscode-host"));
    compiled._compile(built.outputFiles[0].text, name); api = compiled.exports;
  } finally { Module._load = load; }
  const producer = await api.createOriginalMcpNativeTodoWorkerProducer(context, { session, signal: attachment.signal,
    assertCurrent() { if (!alive) throw new Error("Native signed attachment changed."); },
    async close() { closes++; attachment.abort(); },
  });
  t.after(() => producer.dispose());
  const handle = (input = payload, requestId = randomUUID(), signal = new AbortController().signal) =>
    producer.handle("todo.worker.enroll", input, requestId, signal);
  return { producer, payload, session, handle, choices, prompts, bars, commands, signed, attachment,
    closes: () => closes, invalidate: () => { alive = false; }, untrust: () => { trusted = false; }, changed: () => changed() };
}

test("native owner explicitly approves exact new worker identity/Board/source, not source/public/model or old token access", async t => {
  const f = await fixture(t);
  assert.equal(f.prompts.length, 0);
  f.choices.push("Approve this request");
  assert.equal(await f.handle(), null, "a different global approval label grants nothing");
  f.choices.push(yes);
  const decision = await f.handle();
  assert.equal(decision.actorId, f.payload.request.actorId);
  assert.equal(decision.requestSha256, digest(f.payload));
  assert.equal(decision.sessionDecisionId, f.payload.sessionDecisionId);
  assert.equal(decision.epoch, f.session.epoch);
  assert(decision.expiresAtMs <= f.payload.sessionExpiresAtMs);
  assert.deepEqual(f.prompts.at(-1).detail.request, f.payload.request);
  assert.match(f.prompts.at(-1).detail.permission, /original Chat ownership.*not granted/);
  assert(!("token" in decision));
  assert.throws(() => parseOriginalNativeTodoWorkerDecision({ ...decision, actorId: "external:claude:other" }, f.payload), /MISMATCH/);
  await assert.rejects(f.handle(), /REPLACEMENT_REQUIRES_REVOCATION/);
});

test("worker requests reject wrong root/profile/epoch/token inputs and expired source before showing UI", async t => {
  const f = await fixture(t);
  for (const [field, value] of [["root", "/another/root"], ["workspaceId", randomUUID()], ["nativeHostReceiptSha256", "0".repeat(64)]]) {
    await assert.rejects(f.handle({ ...f.payload, request: { ...f.payload.request, [field]: value } }), /BINDING_MISMATCH/);
  }
  await assert.rejects(f.handle({ ...f.payload, profileSha256: "0".repeat(64) }), /BINDING_MISMATCH/);
  await assert.rejects(f.handle({ ...f.payload, epoch: randomUUID() }), /BINDING_MISMATCH/);
  await assert.rejects(f.handle({ ...f.payload, sessionExpiresAtMs: Date.now() - 1 }), /SOURCE_EXPIRED/);
  await assert.rejects(f.handle({ ...f.payload, request: { ...f.payload.request, token: "caller-supplied-token" } }));
  await assert.rejects(f.handle({ ...f.payload, request: { ...f.payload.request, actorId: "chat:" + randomUUID() } }));
  assert.equal(f.prompts.length, 0);
  f.untrust(); await assert.rejects(f.handle(), /BINDING_MISMATCH/);
});

test("late UI answers, replay, signer change and revocation never produce enrollment grants", async t => {
  const f = await fixture(t), cancelled = new AbortController();
  let answer; f.choices.push(new Promise(resolve => { answer = resolve; }));
  const waiting = f.handle(f.payload, randomUUID(), cancelled.signal), rejected = assert.rejects(waiting, /CANCELLED/);
  cancelled.abort(); await rejected; answer(yes);
  assert.equal(f.bars.length, 0);
  const id = randomUUID(); f.choices.push("Deny"); assert.equal(await f.handle(f.payload, id), null);
  await assert.rejects(f.handle(f.payload, id), /REQUEST_REPLAY/);
  let late; f.choices.push(new Promise(resolve => { late = resolve; }));
  const changed = f.handle(); f.invalidate(); late(yes);
  await assert.rejects(changed, /owner changed/);
  const g = await fixture(t); g.choices.push(yes); await g.handle();
  await g.commands.get(g.bars[0].command)();
  assert.equal(g.closes(), 1); assert.equal(g.attachment.signal.aborted, true);
  assert.equal(g.bars[0].disposed, true);
  await assert.rejects(g.handle(), /CANCELLED/);
  await g.producer.revoke(); assert.equal(g.closes(), 1);
});

test("worker decision expires within original source lifetime; status never extends or renews enrollment", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = await fixture(t); f.choices.push(yes); const decision = await f.handle();
  assert.equal(decision.expiresAtMs, f.payload.sessionExpiresAtMs);
  t.mock.timers.tick(decision.expiresAtMs - Date.now() + 1);
  assert.equal(f.bars[0].disposed, true); assert.equal(f.closes(), 0);
  assert.throws(() => parseOriginalNativeTodoWorkerDecision(decision, f.payload), /MISMATCH/);
  f.changed(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.closes(), 1);
});
