import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { originalRoomSessionDigest } from "../../dist/original-mcp-room-session-contracts.js";

const root = fileURLToPath(new URL("../../", import.meta.url)), require = createRequire(import.meta.url);
const built = await require("esbuild").build({
  entryPoints: [join(root, "clients/vscode-host/original-mcp-native-room-sessions.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, logLevel: "silent",
  plugins: [{ name: "explicit-network-resource-double", setup(plugin) {
    plugin.onResolve({ filter: /original-mcp-native-room-session\.js$/ },
      () => ({ path: "native-room-resource-test-double", external: true }));
  } }],
});

// These resource doubles test attachment/RPC lifetime, not native authorization or installed networking.
async function fixture(t) {
  const controller = new AbortController(), resources = [];
  let release;
  const load = Module._load;
  let factory;
  try {
    Module._load = function (id, ...args) {
      if (id === "native-room-resource-test-double") return {
        async createOriginalMcpNativeRoomSessionProducer(_context, options) {
          if (release) await release;
          const resource = { effect: options.effect, endpoint: options.effect.endpoint, signal: options.signal,
            closes: 0, calls: [],
            async invoke(...args) { this.calls.push(args); return { result: "original result fixture" }; },
            async invokeUserJoin(...args) { this.calls.push(args); return { result: "original join fixture" }; },
            async close() { this.closes++; } };
          resources.push(resource); return resource;
        },
      };
      return load.call(this, id, ...args);
    };
    const module = new Module(join(root, "clients/vscode-host", `.room-router-${randomUUID()}.cjs`));
    module.filename = module.id; module.paths = Module._nodeModulePaths(join(root, "clients/vscode-host"));
    module._compile(built.outputFiles[0].text, module.filename);
    factory = module.exports.createOriginalMcpNativeRoomSessionsProducer;
  } finally { Module._load = load; }
  const epoch = randomUUID(), session = {
    brokerId: randomUUID(), activationId: epoch, epoch, identitySha256: "a".repeat(64),
    binding: { root: "/isolated-room-resource/library", workspaceId: randomUUID(), planSha256: "b".repeat(64),
      catalogSha256: "c".repeat(64), profileSha256: "d".repeat(64), payloadBuildId: "e".repeat(64), hostEntrySha256: "f".repeat(64) },
  };
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root: session.binding.root,
    workspaceId: session.binding.workspaceId, planSha256: session.binding.planSha256, profileSha256: session.binding.profileSha256,
    sourceCatalogSha256: session.binding.catalogSha256, authorityId: `native-rpc:${session.brokerId}`, epoch,
    actorId: "mcp:external", domains: ["mcp-public"], configurationSha256: "1".repeat(64) };
  const effect = { schema: "pkm.original-native-room-loopback-effect/v1", sessionId: randomUUID(),
    root: binding.root, workspaceId: binding.workspaceId, profileSha256: binding.profileSha256,
    custodyPlanSha256: binding.planSha256, nativeEpoch: epoch, nativeHostReceiptSha256: originalRoomSessionDigest(binding),
    roomId: randomUUID(), sourceSha256: "2".repeat(64), sourceFingerprint: "3".repeat(64),
    hostParticipantId: "original-offline-human", hostCredentialHash: "4".repeat(64), joinSecretHash: "5".repeat(64),
    currentHostProofExpiresAtMs: Date.now() + 20000, endpoint: "ws://127.0.0.1:32123",
    selection: { port: 32123, alias: "Fresh native test agent", postText: "Exact approved fixture progress" },
    maxClients: 1, maxPosts: 1, temporaryParticipant: true, participantPolicy: "new-agent-only-no-rebind",
    clientPolicy: "original-producer-progress-post-no-commands", noRemote: true, noHostReassignment: true,
    noCredentialExport: true, expiresAtMs: Date.now() + 10000 };
  const effectSha256 = originalRoomSessionDigest(effect), input = { binding, effect, persistence: {
    schema: "pkm.original-native-room-persistence/v1", sessionId: effect.sessionId, socketPath: "/isolated-room-resource/n",
    transportToken: "6".repeat(64), effectSha256,
  } };
  const router = factory({}, { session, signal: controller.signal, assertCurrent() {
    if (controller.signal.aborted) throw new Error("Attachment retired");
  } });
  t.after(() => router.dispose());
  return { router, controller, resources, input, common: { binding, sessionId: effect.sessionId, effectSha256 },
    handle(method, payload, signal = new AbortController().signal) { return router.handle(method, payload, randomUUID(), signal); },
    block() { let done; release = new Promise(resolve => { done = resolve; }); return done; } };
}

test("native Room lives beyond its open RPC and closes only its exact retained effect, including explicit cleanup after expiry", async t => {
  const f = await fixture(t), rpc = new AbortController();
  const opened = await f.handle("room.session.open", f.input, rpc.signal);
  rpc.abort();
  assert.equal(f.resources[0].signal.aborted, false, "Completing/cancelling the finished open RPC must not close the live Room.");
  assert.equal(opened.sessionId, f.common.sessionId);
  await assert.rejects(f.handle("room.session.close", { ...f.common, effectSha256: "9".repeat(64) }), /CURRENT_RESOURCE_REQUIRED/);
  f.resources[0].effect.expiresAtMs = 0;
  assert.deepEqual(await f.handle("room.session.close", f.common), { closed: true });
  assert.equal(f.resources[0].closes, 1);
  assert.equal(f.resources[0].signal.aborted, true);
  assert.deepEqual(await f.handle("room.session.close", f.common), { closed: true });
});

test("cancelled native Room opening drains a late resource and cannot silently retry the same effect", async t => {
  const f = await fixture(t), release = f.block(), rpc = new AbortController();
  const pending = f.handle("room.session.open", f.input, rpc.signal);
  rpc.abort(); release();
  await assert.rejects(pending, /CANCELLED/);
  assert.equal(f.resources[0].closes, 1);
  await assert.rejects(f.handle("room.session.open", f.input), /ALREADY_OPENED/);
});

test("attachment disposal drains the retained native listener/client resource rather than treating an RPC reply as cleanup", async t => {
  const f = await fixture(t);
  await f.handle("room.session.open", f.input);
  f.controller.abort();
  await f.router.dispose();
  assert.equal(f.resources[0].signal.aborted, true);
  assert.equal(f.resources[0].closes, 1);
});
