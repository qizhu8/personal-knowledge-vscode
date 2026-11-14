"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Test-only entry, copied beside a verified installed payload, never packaged.
async function main() {
  const [fixture, root, runtime, nonce, mode] = process.argv.slice(2);
  assert.equal(fs.realpathSync(root), root);
  assert.equal(path.dirname(root), fs.realpathSync(fixture));
  assert.equal(fs.readFileSync(path.join(fixture, "in-place-fixture-token"), "utf8"), nonce);
  assert(fs.statSync(path.join(root, "notes/Existing.md")).isFile());
  assert.equal(process.env.PKM_IN_PLACE_PRIVATE_FIXTURE, nonce);
  const load = name => import(pathToFileURL(path.join(runtime, "dist", `${name}.js`)).href);
  if (mode === "--interrupt-after-prepare") {
    const adoption = await load("legacy-root-adoption");
    const options = require("./in-place-options.cjs").options({ fixture, root, nonce });
    const prepared = await adoption.prepareLegacyRootAdoptionExperimental(root, options);
    console.log(JSON.stringify({ prepared, injectedInterruption: true }));
    process.exitCode = 75;
    return;
  }
  const { Storage } = await load("storage");
  const { createNativeRuntime } = await load("native-runtime");
  const { startLegacyNoteMcp } = await load("legacy-note-mcp");
  const storage = await Storage.open(root, { deferRecovery: true });
  let native, transport, stopping, chatroomRuntime, apiChatRuntime;
  const close = () => stopping ??= (async () => {
    try { await transport?.close(); }
    finally { try { await apiChatRuntime?.drain(); }
      finally { try { await chatroomRuntime?.drain(); } finally { try { await native?.close(); } finally { await storage.close(); } } } }
  })();
  try {
    const grantFile = path.join(fixture, "chatroom-host-grant.json");
    let chatroomContinuation, grant, chatOptions = {};
    if (fs.existsSync(grantFile)) {
      grant = JSON.parse(fs.readFileSync(grantFile, "utf8"));
      assert.equal(grant.root, root);
      assert.equal(grant.nonce, nonce);
      assert.equal(grant.workspaceId, await storage.workspaceId());
      if (grant.endpoint) chatOptions = await require("./chatroom-fixture.cjs").nativeOptions(load, grant.endpoint);
    }
    native = await createNativeRuntime({ storage, workspaceId: await storage.workspaceId(), ...chatOptions });
    const apiGrantFile = path.join(fixture, "api-chat-host-grant.json");
    if (fs.existsSync(apiGrantFile)) {
      const apiGrant = JSON.parse(fs.readFileSync(apiGrantFile, "utf8"));
      assert.equal(apiGrant.root, root); assert.equal(apiGrant.nonce, nonce);
      assert.equal(apiGrant.workspaceId, await storage.workspaceId());
      const apiExtension = fs.realpathSync(apiGrant.extension);
      assert([path.resolve(runtime, ".."), path.resolve(runtime, "../..")].includes(apiExtension));
      const endpoint = new URL(apiGrant.endpoint);
      assert.equal(endpoint.protocol, "http:"); assert.equal(endpoint.hostname, "127.0.0.1");
      assert(endpoint.port && !endpoint.username && !endpoint.password);
      const { createLegacyApiChatLocalProvider } = await load("legacy-api-chat-local-provider");
      const provider = createLegacyApiChatLocalProvider({ endpoint: apiGrant.endpoint, apiKey: "isolated-api-only", model: "test-model" });
      const { LegacyApiChatRuntime } = await load("legacy-api-chat-runtime");
      apiChatRuntime = new LegacyApiChatRuntime({ storage, actorId: "mcp:external",
        authorize: async binding => binding.root === root && binding.workspaceId === apiGrant.workspaceId
          && binding.actorId === "mcp:external" && binding.namespace === apiGrant.namespace
          && apiGrant.chatIds.includes(binding.chatId) && binding.sourceFingerprint === apiGrant.sourceFingerprint
          && ["history", "continue"].includes(binding.operation),
        async provider(messages, signal) {
          const answer = await provider(messages, signal);
          if (process.env.PKM_API_INTERRUPT_BEFORE_RECEIPT === nonce) {
            console.error("PRIVATE_API_CHAT_EXIT_BEFORE_DURABLE_PROVIDER_RECEIPT"); process.exit(79);
          }
          return answer;
        },
      });
      if (process.env.PKM_API_INTERRUPT_AFTER_PROVIDER === nonce)
        apiChatRuntime.publish = () => { console.error("PRIVATE_API_CHAT_EXIT_AFTER_DURABLE_PROVIDER_RESULT"); process.exit(78); };
    }
    if (grant) {
      const { LegacyChatroomContinuation } = await load("legacy-chatroom-continuation");
      chatroomContinuation = new LegacyChatroomContinuation({
        root, workspaceId: grant.workspaceId, actor: { id: "mcp:external", canWrite: true },
        core: { async dispatch(method, input, actor) {
          if (process.env.PKM_CHAT_INTERRUPT_AFTER_PROVIDER === nonce
              && input.operation === "chat.session.append"
              && input.arguments.message.role === "assistant"
              && input.arguments.message.content.startsWith("LOCAL_FIXTURE_CONTINUATION")) {
            console.error("INJECTED_PRIVATE_FIXTURE_EXIT_AFTER_PROVIDER_SUCCESS");
            process.exit(76);
          }
          return native.core.dispatch(method, input, actor);
        } },
        authorize: async binding => binding.workspaceRoot === root && binding.workspaceId === grant.workspaceId
          && binding.actorId === "mcp:external" && binding.roomId === grant.roomId
          && binding.sourceFingerprint === grant.sourceFingerprint
          && ["history", "migrate", "continue"].includes(binding.operation),
      });
      if (grant.roomRuntime) {
        const { LegacyChatroomRuntime } = await load("legacy-chatroom-runtime");
        let retained;
        if (grant.retainedFile) {
          assert.equal(fs.realpathSync(grant.retainedFile), path.join(fixture, "retained.cjs"));
          retained = require(grant.retainedFile);
        } else {
          const extension = path.resolve(runtime, "../..");
          const installedRequire = require("node:module").createRequire(path.join(extension, "package.json"));
          retained = {
            ChatHub: installedRequire("./dist/chatroom/chatroom-hub.js").ChatHub,
            ChatJoinApprovalManager: installedRequire("./dist/chatroom/chat-join-approval.js").ChatJoinApprovalManager,
            WebSocketServer: installedRequire("ws").WebSocketServer,
          };
        }
        chatroomRuntime = new LegacyChatroomRuntime({ storage, actorId: "mcp:external", retained,
          authorize: async binding => binding.root === root && binding.workspaceId === grant.workspaceId
            && binding.actorId === "mcp:external" && binding.roomId === grant.roomRuntime.roomId
            && binding.sourceFingerprint === grant.roomRuntime.sourceFingerprint && binding.operation === "reopen" });
        if (process.env.PKM_ROOM_INTERRUPT_AFTER_FILE === nonce) {
          const append = chatroomRuntime.hub.persistence.append.bind(chatroomRuntime.hub.persistence);
          chatroomRuntime.hub.persistence.append = async (id, message) => {
            await append(id, message);
            if (message.metadata?.file?.name === "fixture-crash.bin") process.exit(77);
          };
        }
      }
    }
    transport = await startLegacyNoteMcp(storage, undefined, {
      core: native.core, actor: { id: "mcp:external", canWrite: true }, chatroomContinuation, chatroomRuntime, apiChatRuntime,
    });
    process.once("SIGTERM", () => { void close(); });
    process.once("SIGINT", () => { void close(); });
    process.stdin.once("end", () => { void close(); });
  } catch (error) { await close(); throw error; }
}
main().catch(error => {
  console.error(JSON.stringify({ error: { code: error.code, message: error.message, blockers: error.blockers } }));
  process.exitCode = 1;
});
