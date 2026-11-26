const { join } = require("node:path");
const { once } = require("node:events");

async function main(fixture) {
  if (fixture.revoke) {
    const { revokeBrowserHttps } = require(join(fixture.installed, "dist/runtime/pkm-browser-https-provision"));
    await revokeBrowserHttps(fixture.revoke);
    return;
  }
  if (fixture.drain) {
    const { PkmServiceClient } = require(join(fixture.installed, "dist/runtime/pkm-service"));
    const client = await PkmServiceClient.connect({ ...fixture.drain, execute: async () => { throw Error("Unexpected sync"); } });
    try { await client.drain(); } finally { client.dispose(); }
    return;
  }
  const { grant, namespace, installed } = fixture;
  const { ApiChatStore } = require(join(installed, "dist/chat/api-chat-store"));
  const { bindNativeBrowserChatTranscriptConsent } = require(join(installed, "dist/chat/detached-browser-chat-transcript"));
  const authority = { grant, namespace, assertCurrent() {} };
  const store = new ApiChatStore(join(grant.workspaceRoot, ".pkm", "state"), namespace);
  const chat = store.create();
  chat.messages.push({ id: "q", role: "user", status: "complete", content: "same Original Chat question" },
    { id: "a", role: "assistant", status: "complete", content: "same Original Chat answer",
      toolCalls: [{ id: "secret", name: "private", arguments: "{}", result: "not browser-visible".repeat(34_000), status: "complete" }] });
  for (let n = 2; n < 21; n++) chat.messages.push({ id: `m${n}`, role: "user", status: "complete", content: `message ${n}` });
  store.save(chat);
  let approval;
  if (fixture.turn) {
    const { captureExecutionContext } = require(join(installed, "dist/chat/execution-context"));
    const { approveDetachedOriginalTextTurn, approveDetachedOriginalConversation } =
      require(join(installed, "dist/chat/detached-original-text-turn"));
    const { pathToFileURL } = require("node:url");
    const root = grant.workspaceRoot;
    Object.assign(chat, { permissionMode: "read-only", includeHistory: false, builtinTools: [], vscodeTools: [],
      activityCreditLimit: -1, modelProvider: "openai-compatible", modelProfileId: "fixture" });
    store.save(chat);
    store.startTask(chat, "Original detached task");
    const execution = captureExecutionContext(grant.chatHostId, [{ uri: {
      scheme: "file", fsPath: root, toString: () => pathToFileURL(root).href,
    } }], root, true, "read-only");
    const options = { grant, namespace, chatId: chat.id, execution, model: fixture.turn.model, assertNativeOwner() {},
      async confirm() { return true; } };
    approval = fixture.turn.conversation ? await approveDetachedOriginalConversation(options)
      : await approveDetachedOriginalTextTurn({ ...options, text: fixture.turn.text });
  }
  const other = store.create();
  const native = bindNativeBrowserChatTranscriptConsent(authority, async () => true);
  if (!await native.allow(chat.id)) throw new Error("Fixture native approval did not persist.");
  if (!await native.allow(other.id)) throw new Error("Second fixture native approval did not persist.");
  process.send({ chatId: chat.id, otherId: other.id, approval });
  const [{ service, provision }] = await once(process, "message");
  if (provision) {
    const { provisionBrowserHttps } = require(join(installed, "dist/runtime/pkm-browser-https-provision"));
    await provisionBrowserHttps(service, provision, () => {
      if (!process.connected) throw Error("The native fixture lost its setup authority.");
    });
  } else {
    const { PkmServiceClient } = require(join(installed, "dist/runtime/pkm-service"));
    const client = await PkmServiceClient.connect({ ...service, execute: async () => { throw Error("Unexpected sync"); } });
    client.dispose();
  }
  process.disconnect();
}

main(JSON.parse(process.argv[2])).catch(error => {
  console.error(error);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
