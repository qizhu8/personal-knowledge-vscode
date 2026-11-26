const { createServer } = require("node:http");
const { startPkmService } = require("../dist/runtime/pkm-service");
const { ApiChatStore } = require("../dist/chat/api-chat-store");
const { bindDetachedBrowserChatTranscript, bindNativeBrowserChatTranscriptConsent } =
  require("../dist/chat/detached-browser-chat-transcript");
const { join } = require("node:path");

async function main(mode, fixture) {
  const { grant, namespace, token, globalStoragePath } = fixture;
  const authority = { grant, namespace, assertCurrent() {} };
  if (mode === "native") {
    const store = new ApiChatStore(join(grant.workspaceRoot, ".pkm", "state"), namespace);
    const chat = store.create();
    chat.messages.push({ id: "q", role: "user", status: "complete", content: "same Original Chat question" },
      { id: "a", role: "assistant", status: "complete", content: "same Original Chat answer",
        toolCalls: [{ id: "secret", name: "private", arguments: "{}", result: "not browser-visible".repeat(34_000), status: "complete" }] });
    store.save(chat);
    const native = bindNativeBrowserChatTranscriptConsent(authority, async () => true);
    if (!await native.allow(chat.id)) throw new Error("Fixture native approval did not persist.");
    process.send(chat.id);
    process.disconnect();
    return;
  }
  const runtime = await startPkmService({
    knowledgeRoot: grant.workspaceRoot, globalStoragePath, extensionVersion: "1.0.0", serviceEntryPath: __filename,
  });
  const read = bindDetachedBrowserChatTranscript(authority);
  // Fixture adapter only. The production gateway must provision this same trusted grant.
  const http = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
    try {
      const { searchParams } = new URL(req.url, "http://127.0.0.1");
      const page = await read(grant, { chatId: searchParams.get("chatId"), cursor: searchParams.get("cursor") ?? undefined, limit: 1 });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(page));
    } catch { res.writeHead(404).end(); }
  });
  http.listen(0, "127.0.0.1", () => process.send(http.address().port));
  await runtime.stopped;
  http.close();
}

main(process.argv[2], JSON.parse(process.argv[3])).catch(error => {
  console.error(error);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
