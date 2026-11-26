const { join } = require("node:path");
const { once } = require("node:events");

async function main(fixture) {
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
  const other = store.create();
  const native = bindNativeBrowserChatTranscriptConsent(authority, async () => true);
  if (!await native.allow(chat.id)) throw new Error("Fixture native approval did not persist.");
  if (!await native.allow(other.id)) throw new Error("Second fixture native approval did not persist.");
  process.send({ chatId: chat.id, otherId: other.id });
  const [service] = await once(process, "message");
  const { PkmServiceClient } = require(join(installed, "dist/runtime/pkm-service"));
  const client = await PkmServiceClient.connect({ ...service, execute: async () => { throw Error("Unexpected sync"); } });
  client.dispose();
  process.disconnect();
}

main(JSON.parse(process.argv[2])).catch(error => {
  console.error(error);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
