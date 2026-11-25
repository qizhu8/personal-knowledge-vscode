import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url), { build } = require("esbuild");
const built = await build({
  entryPoints: [join(root, "clients/vscode-host/original-mcp-native-action.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, logLevel: "silent",
  plugins: [{ name: "test-native-signer", setup(plugin) {
    plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ },
      () => ({ path: "native-action-test-signer", external: true }));
  } }],
});
const [{ originalDigest }] = await Promise.all([import("../../dist/domain/action-compiler-validation.js")]);
const yes = "Approve this exact Action request";

// Native UI/signer doubles exercise the production producer, not installed-platform qualification.
async function fixture(t) {
  const choices = [], prompts = [], commands = new Map(), bars = [];
  const signed = new AbortController(), attachment = new AbortController();
  let alive = true, trusted = true, workspaceChanged;
  const epoch = randomUUID(), session = {
    brokerId: randomUUID(), activationId: epoch, epoch, identitySha256: "d".repeat(64),
    binding: { root: "/isolated-action-fixture/library", workspaceId: randomUUID(), planSha256: "e".repeat(64),
      catalogSha256: "f".repeat(64), profileSha256: "a".repeat(64), payloadBuildId: "b".repeat(64), hostEntrySha256: "c".repeat(64) },
  };
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root: session.binding.root,
    workspaceId: session.binding.workspaceId, planSha256: session.binding.planSha256,
    profileSha256: session.binding.profileSha256, sourceCatalogSha256: session.binding.catalogSha256,
    authorityId: `native-rpc:${session.brokerId}`, epoch, actorId: "mcp:external",
    domains: ["model-provider", "mcp-public"], configurationSha256: "1".repeat(64) };
  const signer = { activationId: epoch, identity: { sha256: session.identitySha256, profileSha256: session.binding.profileSha256 },
    payloadBuildId: session.binding.payloadBuildId, hostEntrySha256: session.binding.hostEntrySha256, signal: signed.signal,
    assertCurrent() { if (!alive) throw new Error("Native signed profile changed."); } };
  const context = { subscriptions: [] };
  const load = Module._load;
  let api;
  try {
    Module._load = function (id, ...args) {
      if (id === "vscode") return {
        StatusBarAlignment: { Left: 1 },
        workspace: { get isTrusted() { return trusted; },
          onDidChangeWorkspaceFolders(callback) { workspaceChanged = callback; return { dispose() {} }; } },
        commands: { registerCommand(name, callback) {
          commands.set(name, callback); return { dispose() { commands.delete(name); } };
        } },
        window: {
          async showWarningMessage(title, options) { prompts.push({ title, detail: JSON.parse(options.detail) }); return choices.shift(); },
          createStatusBarItem() { const bar = { show() {}, dispose() { bar.disposed = true; } }; bars.push(bar); return bar; },
        },
      };
      if (id === "native-action-test-signer") return { originalMcpNativeSigner: async () => signer };
      return load.call(this, id, ...args);
    };
    const filename = join(root, "clients/vscode-host", `.action-producer-memory-${randomUUID()}.cjs`);
    const compiled = new Module(filename);
    compiled.filename = filename; compiled.paths = Module._nodeModulePaths(join(root, "clients/vscode-host"));
    compiled._compile(built.outputFiles[0].text, filename);
    api = compiled.exports;
  } finally { Module._load = load; }
  const producer = await api.createOriginalMcpNativeActionProducer(context, {
    session, signal: attachment.signal, assertCurrent() { if (!alive) throw new Error("Signed attachment revoked."); },
  });
  t.after(() => producer.dispose());
  const capsuleSha256 = "2".repeat(64), source = { actionId: "fixture.native.action", contentHash: "3".repeat(64),
    implementationSha256: "4".repeat(64), effects: ["pure", "human-input"] };
  const request = { schema: "pkm.native-action-source-request/v1", root: binding.root, workspaceId: binding.workspaceId,
    actorId: "mcp:external", profileSha256: binding.profileSha256, epoch, capsuleSha256,
    requestSha256: "5".repeat(64), operation: "Admit exact selected source/state", sources: [source], noExecution: true };
  const consent = { schema: "pkm.original-action-invocation-consent/v1", operation: "action_call",
    run_id: `action_run_${randomUUID().replaceAll("-", "")}`,
    request: { action_id: source.actionId, content_hash: source.contentHash, inputs: { proposal: "exact isolated fixture" },
      idempotency_key: "native-fixture", trigger: null, project_id: null },
    sourceReceiptSha256: "6".repeat(64), capsuleSha256, implementationSha256: source.implementationSha256,
    deadline: Date.now() + 300000, automaticReplay: false };
  const invoke = () => ({ binding, capsuleSha256, actionId: source.actionId, contentHash: source.contentHash, trustEpoch: epoch,
    effectContext: { kind: "pipeline", components: ["core.checkpoint"], stepCount: 1, effects: source.effects,
      inputDigest: originalDigest(consent), inputPreview: JSON.stringify(consent) } });
  const handle = (method, payload, id = randomUUID()) => producer.handle(method, payload, id, new AbortController().signal);
  const prepare = async () => {
    choices.push(yes); assert.equal(await producer.enable(), true);
    assert.equal((await handle("action.authorize", { binding, capsuleSha256, actionId: source.actionId,
      contentHash: source.contentHash, trustEpoch: epoch })).decision, "approve");
    choices.push(yes); return handle("action.source.approve", { binding, request });
  };
  return { producer, choices, prompts, commands, bars, binding, capsuleSha256, source, request, consent,
    invoke, handle, prepare, session, signed, attachment,
    setTrusted(value) { trusted = value; }, invalidate() { alive = false; }, workspaceChange() { workspaceChanged(); } };
}

test("native Action producer is disabled until explicit installed UI enable; signed bindings and typed noExecution remain mandatory", async t => {
  const f = await fixture(t);
  assert.equal((await f.handle("action.status", { binding: f.binding, capsuleSha256: f.capsuleSha256 })).trusted, false);
  assert.equal(await f.handle("action.source.approve", { binding: f.binding, request: f.request }), null);
  assert.equal(f.prompts.length, 0);
  f.choices.push("Deny"); assert.equal(await f.producer.enable(), false);
  await assert.rejects(f.handle("action.source.approve", { binding: f.binding, request: { ...f.request, noExecution: false } }));
  await assert.rejects(f.handle("action.status", { binding: { ...f.binding, profileSha256: "9".repeat(64) },
    capsuleSha256: f.capsuleSha256 }), /BINDING_MISMATCH/);
  f.setTrusted(false);
  await assert.rejects(f.producer.enable(), /BINDING_MISMATCH/);
});

test("typed source review and every exact invocation use separate genuine producer UI decisions; candidate probes grant no execution", async t => {
  const f = await fixture(t), decision = await f.prepare();
  assert.equal(decision.noExecution, true); assert.equal(decision.scope, "original-action-source-state/v1");
  assert.equal(decision.root, f.binding.root); assert.equal(decision.epoch, f.binding.epoch);
  assert.equal(decision.capsuleSha256, f.capsuleSha256); assert.equal(decision.requestSha256, f.request.requestSha256);
  assert.equal(f.prompts.length, 2, "Fast source candidates are not a substitute for the typed aggregate UI review.");
  f.choices.push("Deny"); assert.equal((await f.handle("action.invocation.approve", f.invoke())).decision, "deny");
  f.choices.push(yes); assert.equal((await f.handle("action.invocation.approve", f.invoke())).decision, "approve");
  assert.deepEqual(f.prompts.at(-1).detail.consent, f.consent);
  assert.equal(f.prompts.at(-1).detail.profileSha256, f.binding.profileSha256);
  assert.equal(f.bars[0].command, f.commands.keys().next().value);
  const id = randomUUID();
  f.choices.push(yes); await f.handle("action.invocation.approve", f.invoke(), id);
  await assert.rejects(f.handle("action.invocation.approve", f.invoke(), id), /REQUEST_REPLAY/);
});

test("composed program approval uses the producer's actual source admission and Action revocation lifetime", async t => {
  const f = await fixture(t);
  f.source.effects = ["pure"];
  const request = {
    schema: "pkm.original-mcp-local-program-request/v1",
    root: f.binding.root, workspaceId: f.binding.workspaceId, actorId: "mcp:external",
    profileSha256: f.binding.profileSha256, epoch: f.session.epoch,
    capsuleSha256: f.capsuleSha256, sourceReceiptSha256: f.consent.sourceReceiptSha256,
    nativeHostReceiptSha256: "7".repeat(64), runId: f.consent.run_id, request: f.consent.request,
    implementationSha256: f.source.implementationSha256, inputSha256: originalDigest(f.consent.request.inputs),
    deadline: f.consent.deadline,
    executable: { path: process.execPath, sha256: "8".repeat(64), bytes: 1, identity: "native-producer-fixture-only" },
    cwd: { path: `${f.binding.root}/action-sources`, device: "0", inode: "1" },
    arguments: ["-e", "process.stdout.write('{}')"], sources: [], effects: ["pure"],
    authority: { scope: "exact-local-direct-child/v1", shell: false, inheritedEnvironment: false,
      credentials: false, network: false, descendants: false, build: false, automaticReplay: false },
  };
  const payload = { binding: f.binding, request }, method = "action.program.approve";
  assert.equal(await f.handle(method, payload), null);
  await assert.rejects(f.handle(method, { ...payload, request: { ...request, epoch: randomUUID() } }), /BINDING_MISMATCH/);
  await f.prepare();
  f.choices.push("Deny");
  assert.equal(await f.handle(method, payload), null);
  f.choices.push("Run this exact local program");
  const decision = await f.handle(method, payload);
  assert.equal(decision.runId, request.runId);
  assert.equal(decision.requestSha256, originalDigest(request));
  assert.deepEqual(f.prompts.at(-1).detail.request, request);
  let answer;
  f.choices.push(new Promise(resolve => { answer = resolve; }));
  const pending = f.handle(method, payload);
  f.commands.values().next().value();
  await assert.rejects(pending, /CANCELLED|REVOKED/);
  answer("Run this exact local program");
  assert.equal(await f.handle(method, payload), null);
});

test("source-only approval never accepts a changed implementation, incomplete exact preview, epoch, capsule or hash", async t => {
  const f = await fixture(t); await f.prepare();
  const before = f.prompts.length;
  const mismatch = f.invoke();
  mismatch.effectContext.inputPreview = JSON.stringify({ ...f.consent, implementationSha256: "9".repeat(64) });
  mismatch.effectContext.inputDigest = originalDigest(JSON.parse(mismatch.effectContext.inputPreview));
  await assert.rejects(f.handle("action.invocation.approve", mismatch), /EXACT_SOURCE_REVIEW_REQUIRED/);
  const truncated = f.invoke(); truncated.effectContext.inputPreview = '{"schema":';
  await assert.rejects(f.handle("action.invocation.approve", truncated), /EXACT_PREVIEW_REQUIRED/);
  await assert.rejects(f.handle("action.invocation.approve", { ...f.invoke(), trustEpoch: randomUUID() }), /EPOCH_MISMATCH/);
  const hash = f.invoke(); hash.effectContext.inputDigest = "9".repeat(64);
  await assert.rejects(f.handle("action.invocation.approve", hash), /INVOCATION_BINDING_MISMATCH/);
  await assert.rejects(f.handle("action.authorize", { binding: f.binding, capsuleSha256: "9".repeat(64),
    actionId: f.source.actionId, contentHash: f.source.contentHash, trustEpoch: f.binding.epoch }), /CAPSULE_CHANGED/);
  assert.equal(f.prompts.length, before);
});

test("status-bar revocation aborts pending native approval and permanently retires this producer without resurrecting old decisions", async t => {
  const f = await fixture(t); await f.prepare();
  let answer;
  f.choices.push(new Promise(resolve => { answer = resolve; }));
  const pending = f.handle("action.invocation.approve", f.invoke());
  f.commands.values().next().value();
  await assert.rejects(pending, /CANCELLED|REVOKED/);
  answer(yes);
  assert.equal((await f.handle("action.status", { binding: f.binding, capsuleSha256: f.capsuleSha256 })).trusted, false);
  assert.equal((await f.handle("action.invocation.approve", f.invoke())).decision, "deny");
  await assert.rejects(f.producer.enable(), /REVOKED/);
  assert.equal(f.bars[0].disposed, true);
});

test("source revocation or signed-profile change during a native invocation dialog discards late approval", async t => {
  const f = await fixture(t); await f.prepare();
  let answer;
  f.choices.push(new Promise(resolve => { answer = resolve; }));
  const pending = f.handle("action.invocation.approve", f.invoke());
  f.choices.push("Deny"); assert.equal(await f.handle("action.source.approve", { binding: f.binding, request: f.request }), null);
  answer(yes); await assert.rejects(pending, /SOURCE_REVIEW_EXPIRED/);
  const other = await fixture(t); await other.prepare();
  let late;
  other.choices.push(new Promise(resolve => { late = resolve; }));
  const changed = other.handle("action.invocation.approve", other.invoke());
  other.invalidate(); late(yes);
  await assert.rejects(changed, /profile changed|attachment revoked/i);
});

test("native continuation UI binds the exact waiting Run version, token, proposal and response, not another invocation", async t => {
  const f = await fixture(t); await f.prepare();
  const consent = { ...f.consent, operation: "action_checkpoint_respond", expected_version: 12,
    response: { run_id: f.consent.run_id, checkpoint_id: `checkpoint_${randomUUID().replaceAll("-", "")}`,
      resume_token: "a".repeat(48), proposal_digest: "b".repeat(64), answer: { approved: true }, event_key: "native-review" } };
  delete consent.deadline;
  const input = f.invoke();
  input.effectContext.inputPreview = JSON.stringify(consent); input.effectContext.inputDigest = originalDigest(consent);
  f.choices.push(yes);
  assert.equal((await f.handle("action.invocation.approve", input)).decision, "approve");
  assert.equal(f.prompts.at(-1).detail.consent.expected_version, 12);
  assert.deepEqual(f.prompts.at(-1).detail.consent.response, consent.response);
  consent.response.run_id = `action_run_${randomUUID().replaceAll("-", "")}`;
  input.effectContext.inputPreview = JSON.stringify(consent); input.effectContext.inputDigest = originalDigest(consent);
  await assert.rejects(f.handle("action.invocation.approve", input), /INVOCATION_BINDING_MISMATCH/);
});
