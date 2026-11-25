import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import Module, { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import "../../tests/original-knowledge-recovery-source-loader.mjs";
const { originalRecoveryDigest: digest } = await import("../../src/original-knowledge-recovery-contracts.ts");

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Run this UI lifecycle test through private framework isolation.");
const root = fileURLToPath(new URL("../../", import.meta.url)), require = createRequire(import.meta.url);
const built = await require("esbuild").build({
  entryPoints: [join(root, "clients/vscode-host/original-knowledge-recovery-producer.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, metafile: true, logLevel: "silent",
  plugins: [{ name: "lifecycle-only-signer-double", setup(plugin) {
    plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ }, () => ({ path: "recovery-lifecycle-signer", external: true }));
  } }],
});
assert(!Object.keys(built.metafile.inputs).some(path => /(?:storage|root-owner|original-knowledge-recovery-native)\.ts$/.test(path)),
  "The UI lifecycle double must not load or manufacture Core/private source authority.");

test("repeated attachment teardown and failed initialization release every recovery UI listener without granting evidence", async t => {
  const epoch = randomUUID(), signed = new AbortController(), listeners = new Set(), pickers = [];
  const context = { subscriptions: [{ dispose() { assert.fail("Producer teardown must not dispose unrelated context resources."); } }] };
  const session = {
    brokerId: randomUUID(), activationId: epoch, identitySha256: "a".repeat(64), epoch,
    binding: { root: "/synthetic-lifecycle/root", workspaceId: randomUUID(), planSha256: "b".repeat(64),
      catalogSha256: "c".repeat(64), profileSha256: "d".repeat(64), payloadBuildId: "e".repeat(64), hostEntrySha256: "f".repeat(64) },
  };
  const signer = { activationId: epoch, identity: { sha256: session.identitySha256, profileSha256: session.binding.profileSha256 },
    payloadBuildId: session.binding.payloadBuildId, hostEntrySha256: session.binding.hostEntrySha256,
    signal: signed.signal, assertCurrent() {} };
  let subscriptionsDisposed = 0, api;
  const originalLoad = Module._load;
  try {
    Module._load = function (id, ...args) {
      if (id === "recovery-lifecycle-signer") return { originalMcpNativeSigner: async () => signer };
      if (id === "vscode") return {
        workspace: { isTrusted: true, onDidChangeWorkspaceFolders(callback) {
          listeners.add(callback);
          return { dispose() { assert(listeners.delete(callback), "A workspace subscription must be disposed exactly once."); subscriptionsDisposed++; } };
        } },
        window: {
          showOpenDialog() { return new Promise(resolve => { pickers.push(resolve); }); },
          showWarningMessage() { assert.fail("Lifecycle controls must never approve evidence or owner repair."); },
        },
      };
      return originalLoad.call(this, id, ...args);
    };
    const filename = join(root, "clients/vscode-host", `.recovery-lifecycle-memory-${randomUUID()}.cjs`);
    const compiled = new Module(filename);
    compiled.filename = filename; compiled.paths = Module._nodeModulePaths(join(root, "clients/vscode-host"));
    compiled._compile(built.outputFiles[0].text, filename); api = compiled.exports;
  } finally { Module._load = originalLoad; }
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root: session.binding.root,
    workspaceId: session.binding.workspaceId, planSha256: session.binding.planSha256, profileSha256: session.binding.profileSha256,
    sourceCatalogSha256: session.binding.catalogSha256, authorityId: `native-rpc:${session.brokerId}`,
    epoch, actorId: "mcp:external", domains: ["mcp-public"], configurationSha256: "1".repeat(64) };
  const arguments_ = { evidence_directory: "/synthetic-lifecycle/evidence-never-read" };
  const request = { schema: "pkm.original-recovery-source-request/v1", operationId: randomUUID(),
    nativeHostReceiptSha256: digest(binding), publicRequest: { tool: "knowledge_recovery_preview", version: 1,
      arguments: arguments_, argumentsDigest: digest(arguments_) } };
  const payload = { binding, defaultDecision: "deny", request, requestSha256: digest(request) };
  const assertReleased = attachment => {
    assert.equal(listeners.size, 0);
    assert.equal(getEventListeners(attachment.signal, "abort").length, 0);
    assert.equal(getEventListeners(signed.signal, "abort").length, 0);
    assert.equal(context.subscriptions.length, 1, "Closed attachments must not accumulate context teardown closures.");
  };
  for (const route of ["dispose", "attachment", "workspace", "dispose", "attachment", "workspace"]) {
    const attachment = new AbortController();
    const producer = await api.createOriginalKnowledgeRecoveryProducer(context, {
      session, signal: attachment.signal, assertCurrent() {},
    });
    t.after(() => producer.dispose());
    assert.equal(listeners.size, 1); assert.equal(getEventListeners(signed.signal, "abort").length, 1);
    const pending = producer.handle("knowledge.recovery.evidence.approve", payload, randomUUID(), new AbortController().signal);
    const cancelled = assert.rejects(pending, { code: "RECOVERY_NATIVE_CANCELLED" });
    if (route === "dispose") producer.dispose();
    else if (route === "attachment") attachment.abort();
    else for (const callback of [...listeners]) callback();
    await cancelled;
    pickers.shift()(undefined);
    assertReleased(attachment); assert.equal(producer.signal.aborted, true);
    producer.dispose(); assertReleased(attachment);
    await assert.rejects(producer.handle("knowledge.recovery.evidence.approve", payload, randomUUID(), attachment.signal),
      { code: "RECOVERY_NATIVE_CANCELLED" });
  }
  const failed = new AbortController(), initializationError = new Error("Same signed attachment changed during initialization.");
  await assert.rejects(api.createOriginalKnowledgeRecoveryProducer(context, {
    session, signal: failed.signal, assertCurrent() { throw initializationError; },
  }), error => error === initializationError);
  assertReleased(failed);
  const last = new AbortController();
  const producer = await api.createOriginalKnowledgeRecoveryProducer(context, { session, signal: last.signal, assertCurrent() {} });
  t.after(() => producer.dispose());
  signed.abort(); producer.dispose(); assertReleased(last);
  assert.equal(subscriptionsDisposed, 8, "Each connection, including failed initialization, releases its workspace subscription once.");
  assert.equal(pickers.length, 0);
});
