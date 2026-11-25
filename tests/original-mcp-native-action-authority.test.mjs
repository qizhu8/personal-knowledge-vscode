import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { lstat, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createOriginalMcpActionCustodyFixture } from "./original-mcp-action-domain-fixture.mjs";
import { startOriginalMcpNativeAttachmentServer } from "../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import { createOriginalMcpNativeRequestPolicy, originalMcpNativeRequestProtocol, originalMcpNativeRequestSession,
  parseOriginalMcpNativeRequest, originalMcpNativeResult, originalMcpNativeErrorResult,
  waitForOriginalMcpNativeSupport } from "../dist/original-mcp-native-request.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { startOriginalMcpNativeActionAuthority, assertOriginalMcpNativeActionAuthority } from "../dist/original-mcp-native-action-authority.js";
import { isOriginalNativeActionMethod } from "../dist/original-mcp-native-action-contracts.js";
import { createVscodeActionTrustBridge } from "../dist/vscode-action-trust-bridge.js";
import { openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { createOriginalMcpActionNativePolicy, declareOriginalMcpActionNativeFootprint,
  admitOriginalMcpActionDomain } from "../dist/original-mcp-action-domain.js";
import { createOriginalMcpActionRuntime } from "../dist/original-mcp-action-runtime.js";
import { originalDigest } from "../dist/domain/action-compiler-validation.js";

assert(process.env.PKM_TEST_WORKSPACE, "Use the existing private Linux framework for cold writer fixtures.");
const require = createRequire(import.meta.url), { build } = require("esbuild"), actor = { id: "mcp:external", canWrite: true };
const oracle = JSON.parse(await readFile(new URL("./fixtures/original-public-mcp-discovery.json", import.meta.url), "utf8"));
const uiSource = await build({
  entryPoints: [resolve("clients/vscode-host/original-mcp-native-action.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, logLevel: "silent",
  plugins: [{ name: "explicit-signer-double", setup(plugin) {
    plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ },
      () => ({ path: "action-authority-signer-double", external: true }));
  } }],
});
const allow = "Approve this exact Action request", pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const args = (definition, key) => ({ action_id: definition.action_id, content_hash: definition.content_hash, inputs: {}, idempotency_key: key });
async function settled(running, id, state) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const run = await running.call("action_run_get", { run_id: id });
    if (run.state === state) return run;
    await pause(10);
  }
  throw new Error(`Signed native Action ${id} did not reach ${state}.`);
}
async function until(check) {
  for (let attempt = 0; attempt < 300; attempt++) { if (check()) return; await pause(10); }
  throw new Error("Signed Action UI did not receive its exact consent request.");
}
function continuation(f, waiting, key, receipt) {
  const checkpoint = waiting.checkpoint;
  const consent = { schema: "pkm.original-action-invocation-consent/v1", operation: "action_checkpoint_respond",
    run_id: waiting.run_id, request: { ...args(f.old.review, key), trigger: null, project_id: null },
    sourceReceiptSha256: receipt, capsuleSha256: f.custody.capsuleSha256,
    implementationSha256: originalDigest(f.old.review.implementations[0]), automaticReplay: false, expected_version: waiting.version,
    response: { run_id: waiting.run_id, checkpoint_id: checkpoint.checkpoint_id, resume_token: checkpoint.resume_token,
      proposal_digest: checkpoint.proposal_digest, answer: {}, event_key: "exact signed continuation" } };
  return { consent, context: value => ({ kind: "pipeline", components: ["core.checkpoint", "core.checkpoint"], stepCount: 2,
    effects: f.old.review.effects, inputDigest: originalDigest(value), inputPreview: JSON.stringify(value) }) };
}
function counts(running) {
  const db = running.storage.connectNative();
  try { return { runs: db.prepare("SELECT count(*) n FROM action_runtime_runs").get().n,
    processes: db.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n }; }
  finally { db.close(); }
}
// Only native UI/signing-environment APIs are doubled. The socket signature, session,
// Core-owned writer, concrete bridge, production producer and Action effects are real.
async function signedProducer(storage, fixture) {
  const directory = join(homedir(), ".local/state/pkm-v5-recovery", `a-${randomBytes(4).toString("hex")}`);
  await mkdir(directory, { mode: 0o700 });
  const keys = generateKeyPairSync("ed25519"), identity = originalMcpNativeIdentity(
    keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), fixture.plan.profileSha256);
  const binding = { root: fixture.root, workspaceId: await storage.workspaceId(), planSha256: fixture.plan.planSha256,
    catalogSha256: oracle.metadataSha256, profileSha256: fixture.plan.profileSha256,
    payloadBuildId: "b".repeat(64), hostEntrySha256: "c".repeat(64) };
  const server = await startOriginalMcpNativeAttachmentServer({ directory, identity, identitySha256: identity.sha256,
    binding, maxPacketBytes: 65536, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 3000 });
  const socket = connect(join(directory, "n")), requests = [], prompts = [], commands = new Map();
  let input = "", session, producer, attachedResolve, chooser = () => allow;
  let closing;
  const close = () => closing ??= (async () => { producer?.dispose(); socket.destroy(); await server.close(); await rm(directory, { recursive: true }); })();
  storage.retainNativeCleanup({ release: close });
  const attached = new Promise(resolve => { attachedResolve = resolve; });
  const controllers = new Map(), send = frame => socket.write(JSON.stringify(frame) + "\n");
  socket.on("error", () => socket.destroy());
  socket.on("data", bytes => {
    input += bytes.toString("utf8");
    for (let boundary; (boundary = input.indexOf("\n")) >= 0;) {
      const frame = JSON.parse(input.slice(0, boundary)); input = input.slice(boundary + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") attachedResolve();
      else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-cancel") controllers.get(frame.requestId)?.abort();
      else if (frame.type === "native-request") {
        const request = parseOriginalMcpNativeRequest(frame, originalMcpNativeRequestSession(session));
        requests.push(request);
        const controller = new AbortController(); controllers.set(request.requestId, controller);
        void Promise.resolve().then(() => isOriginalNativeActionMethod(request.method)
          ? producer.handle(request.method, request.payload, request.requestId, controller.signal)
          : { decision: "approve" }).then(result => send(originalMcpNativeResult(request, result)),
          () => send(originalMcpNativeErrorResult(request, controller.signal.aborted ? "NATIVE_REQUEST_CANCELLED" : "NATIVE_DENIED")))
          .finally(() => controllers.delete(request.requestId));
      }
    }
  });
  await attached; session = await server.waitForSession({ timeoutMs: 3000 });
  const signer = { activationId: session.activationId, identity, payloadBuildId: binding.payloadBuildId,
    hostEntrySha256: binding.hostEntrySha256, signal: session.signal, assertCurrent: () => session.assertCurrent() };
  const load = Module._load;
  let api;
  try {
    Module._load = function (id, ...rest) {
      if (id === "action-authority-signer-double") return { originalMcpNativeSigner: async () => signer };
      if (id === "vscode") return {
        StatusBarAlignment: { Left: 1 },
        commands: { registerCommand(id, callback) { commands.set(id, callback); return { dispose() { commands.delete(id); } }; } },
        workspace: { isTrusted: true, onDidChangeWorkspaceFolders() { return { dispose() {} }; } },
        window: { async showWarningMessage(title, options) {
          const prompt = { title, detail: JSON.parse(options.detail) }; prompts.push(prompt); return chooser(prompt);
        }, createStatusBarItem() { return { show() {}, dispose() {} }; } },
      };
      return load.call(this, id, ...rest);
    };
    const filename = resolve("tests", `.signed-action-producer-memory-${randomUUID()}.cjs`), compiled = new Module(filename);
    compiled.filename = filename; compiled.paths = Module._nodeModulePaths(resolve("tests"));
    compiled._compile(uiSource.outputFiles[0].text, filename); api = compiled.exports;
  } finally { Module._load = load; }
  producer = await api.createOriginalMcpNativeActionProducer({ subscriptions: [] }, {
    session: originalMcpNativeRequestSession(session), signal: session.signal, assertCurrent: () => session.assertCurrent(),
  });
  assert.equal(await producer.enable(), true);
  send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session: originalMcpNativeRequestSession(session),
    methods: ["admission.approve", "public.approve", ...producer.methods], maxPacketBytes: 65536 });
  await waitForOriginalMcpNativeSupport(session, { timeoutMs: 3000 });
  return { session, requests, prompts, commands, producer, choose(value) { chooser = value; }, close };
}
async function fixture(t) {
  const base = await createOriginalMcpActionCustodyFixture(t);
  return { ...base, async start() {
    let signed, host, authority, policy;
    const opened = await openOriginalMcpRoot(base.plan, { prepareNative: async storage => {
      signed = await signedProducer(storage, base);
      host = await createOriginalMcpNativeHost(storage, createOriginalMcpNativeRequestPolicy(signed.session));
      await declareOriginalMcpActionNativeFootprint(storage, base.custody);
      authority = await startOriginalMcpNativeActionAuthority(storage, host, signed.session, base.custody);
      policy = await createOriginalMcpActionNativePolicy(storage, host, base.custody, { nativeAuthority: authority });
      return policy.options;
    } });
    base.cleanup.push(() => opened.owner.close());
    const full = await opened.owner.ensureFull(), adapter = await createOriginalMcpActionRuntime(opened.owner, actor, host);
    base.cleanup.push(() => adapter.close());
    return { ...opened, full, adapter, host, authority, policy, signed,
      call: async (tool, input = {}) => (await adapter.invoke(tool, input)).structuredContent,
      admit: () => admitOriginalMcpActionDomain(opened.owner, actor, host, policy) };
  } };
}

test("Core-owned real signed bridge admits original source, computes pure Action output and answers native checkpoints", async t => {
  const f = await fixture(t), running = await f.start(), lease = { ...running.owner.workspaceLease() };
  const admitted = await running.admit();
  assert.equal(admitted.capsuleSha256, f.custody.capsuleSha256);
  const module = await running.call("action_get", { action_id: f.moduleRaw.action_id });
  const calculated = await running.call("action_call", args(module, "signed pure call"));
  assert.deepEqual((await settled(running, calculated.run_id, "succeeded")).output, { value: 7 });
  const reviewed = await running.call("action_call", args(f.old.review, "signed checkpoint call"));
  for (const answer of [{}, { approved: true }]) {
    const waiting = await settled(running, reviewed.run_id, "waiting"), checkpoint = waiting.checkpoint;
    await running.call("action_checkpoint_respond", { run_id: reviewed.run_id, checkpoint_id: checkpoint.checkpoint_id,
      resume_token: checkpoint.resume_token, proposal_digest: checkpoint.proposal_digest, answer, event_key: checkpoint.step });
  }
  assert.deepEqual((await settled(running, reviewed.run_id, "succeeded")).output, { value: { approved: true } });
  assert.equal((await running.call("action_call", args(module, "signed pure call"))).launch_reused, true);
  assert.deepEqual(counts(running), { runs: 5, processes: 0 });
  assert.equal(running.signed.prompts.filter(item => item.detail.request?.noExecution).length, 1);
  assert.equal(running.signed.prompts.filter(item => item.detail.consent?.operation === "action_call").length, 2);
  assert.deepEqual(running.owner.workspaceLease(), lease);
  assert.deepEqual(await readFile(join(f.root, ".pkm/state/actions/settings.json")), f.oldSettings);
});

test("signed authority refuses copied/old locators and restart restores receipts, not old invocation grants or endpoint tokens", async t => {
  const f = await fixture(t), first = await f.start(), admitted = await first.admit();
  assert.throws(() => assertOriginalMcpNativeActionAuthority({ ...first.authority }, first.storage, first.host),
    { code: "NATIVE_ACTION_PRODUCER_LOCATOR_REQUIRED" });
  const path = join(f.root, ".pkm-action-authority/host-authority.json"), initial = JSON.parse(await readFile(path, "utf8"));
  await assert.rejects(startOriginalMcpNativeActionAuthority(first.storage, first.host, first.signed.session, f.custody),
    { code: "NATIVE_ACTION_OLD_ENDPOINT_RECONCILIATION_REQUIRED" });
  assert.equal(JSON.parse(await readFile(path, "utf8")).token, initial.token);
  const callArgs = args(f.old.review, "signed restart"), created = await first.call("action_call", callArgs);
  const waiting = await settled(first, created.run_id, "waiting");
  const bridge = createVscodeActionTrustBridge({ workspaceRoot: f.root, workspaceId: first.workspaceId, actorId: actor.id, nativeEndpoint: true });
  t.after(() => bridge.close());
  const { consent, context } = continuation(f, waiting, "signed restart", admitted.receiptSha256);
  let late;
  first.signed.choose(prompt => prompt.detail.consent ? new Promise(resolve => { late = resolve; }) : allow);
  const before = first.signed.prompts.length;
  const pending = bridge.authorizeEffects(f.old.review.action_id, f.old.review.content_hash, first.host.receipt.epoch, context(consent));
  const refused = assert.rejects(pending, /NATIVE_ACTION_PRODUCER_REVOKED/);
  await until(() => first.signed.prompts.length > before);
  await first.adapter.close(); await first.owner.close();
  await refused; late(allow);
  assert.equal(await lstat(join(f.root, ".pkm-action-authority")).catch(error => error.code === "ENOENT" ? null : Promise.reject(error)), null);
  const second = await f.start(); await second.admit();
  assert.throws(() => assertOriginalMcpNativeActionAuthority(first.authority, second.storage, second.host),
    { code: "NATIVE_ACTION_PRODUCER_LOCATOR_REQUIRED" });
  const replacement = JSON.parse(await readFile(path, "utf8"));
  assert.notEqual(replacement.token, initial.token); assert.notEqual(replacement.trust_epoch, initial.trust_epoch);
  const repeated = await second.call("action_call", callArgs);
  assert.equal(repeated.run_id, created.run_id); assert.equal(repeated.state, "waiting");
  assert.equal(second.signed.prompts.filter(item => item.detail.consent).length, 0);
  const checkpoint = waiting.checkpoint;
  await second.call("action_checkpoint_respond", { run_id: created.run_id, checkpoint_id: checkpoint.checkpoint_id,
    resume_token: checkpoint.resume_token, proposal_digest: checkpoint.proposal_digest, answer: {}, event_key: "fresh signed continuation" });
  assert.equal(second.signed.prompts.at(-1).detail.consent.operation, "action_checkpoint_respond");
  await second.call("action_run_cancel", { run_id: created.run_id });
  assert.equal((await second.call("action_run_get", { run_id: created.run_id })).state, "cancelled");
  assert.deepEqual(counts(second), { runs: 4, processes: 0 });
});

test("real forwarding rejects wrong source receipts/checkpoint tokens before UI and retries teardown only after changed controls are reconciled", async t => {
  const f = await fixture(t), running = await f.start(); await running.admit();
  const created = await running.call("action_call", args(f.old.review, "signed denied continuation"));
  const waiting = await settled(running, created.run_id, "waiting"), checkpoint = waiting.checkpoint;
  const receipt = (await running.admit()).receiptSha256;
  const bridge = createVscodeActionTrustBridge({ workspaceRoot: f.root, workspaceId: running.workspaceId,
    actorId: actor.id, nativeEndpoint: true });
  t.after(() => bridge.close());
  const { consent, context } = continuation(f, waiting, "signed denied continuation", receipt);
  consent.response.resume_token = "a".repeat(48);
  const prompts = running.signed.prompts.length;
  await assert.rejects(bridge.authorizeEffects(f.old.review.action_id, f.old.review.content_hash,
    running.host.receipt.epoch, context(consent)), /NATIVE_ACTION_CONTINUATION_BINDING_MISMATCH/);
  await assert.rejects(bridge.authorizeEffects(f.old.review.action_id, f.old.review.content_hash, running.host.receipt.epoch,
    context({ ...consent, sourceReceiptSha256: "f".repeat(64) })), /NATIVE_ACTION_INVOCATION_BINDING_MISMATCH/);
  assert.equal(running.signed.prompts.length, prompts);
  consent.response.resume_token = checkpoint.resume_token;
  let late;
  running.signed.choose(prompt => prompt.detail.consent ? new Promise(resolve => { late = resolve; }) : allow);
  const pending = bridge.authorizeEffects(f.old.review.action_id, f.old.review.content_hash, running.host.receipt.epoch, context(consent));
  const refused = assert.rejects(pending, /NATIVE_ACTION_CONTINUATION_BINDING_MISMATCH/);
  await until(() => running.signed.prompts.length > prompts);
  await running.call("action_run_cancel", { run_id: created.run_id });
  late(allow); await refused;
  const extra = join(f.root, ".pkm-action-authority/foreign-control.json");
  await writeFile(extra, '{"must":"preserve"}', { mode: 0o600 });
  await assert.rejects(running.authority.close(), /NATIVE_ACTION_ENDPOINT_CHANGED/);
  assert.equal(running.authority.signal.aborted, true);
  assert.equal(await readFile(extra, "utf8"), '{"must":"preserve"}');
  // The fixture removes only the sidecar it created; the producer never deletes unknown controls.
  await unlink(extra); await running.authority.close();
  await running.adapter.close(); await running.owner.close();
  assert.equal(await lstat(join(f.root, ".pkm-action-authority")).catch(() => null), null);
});
