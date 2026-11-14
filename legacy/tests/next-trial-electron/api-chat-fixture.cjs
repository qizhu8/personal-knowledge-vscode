"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const namespace = "0123456789abcdef";
const image = { label: "synthetic-pixel.png", mimeType: "image/png",
  dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5wAAAABJRU5ErkJggg==" };
function create({ extension, root, workspaceNamespace = namespace }) {
  const { ApiChatStore } = require(path.join(extension, "dist/chat/api-chat-store.js"));
  fs.mkdirSync(path.join(root, ".pkm"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, ".pkm/content-privacy.json"),
    JSON.stringify({ schema: 1, private: { notes: ["Chatroom Meetings"] } }), { mode: 0o600, flag: "wx" });
  const state = path.join(root, ".pkm/state"), store = new ApiChatStore(state, workspaceNamespace);
  const inline = store.create(), segmented = store.create();
  inline.title = "Ordinary API Chat with an actual inline PNG";
  inline.messages.push({ id: randomUUID(), role: "user", content: "Synthetic ordinary API Chat history.",
    status: "complete", images: [image] });
  store.save(inline);
  segmented.title = "Ordinary segmented API Chat";
  segmented.messages.push({ id: randomUUID(), role: "user", content: "Synthetic API history. ".repeat(30_000), status: "complete" },
    { id: randomUUID(), role: "assistant", content: "Historical ordinary API response.", status: "complete" });
  store.save(segmented);
  const descriptor = { root, state, namespace: workspaceNamespace, inline: inline.id, segmented: segmented.id };
  fs.writeFileSync(path.join(path.dirname(root), "api-chat-fixture.json"), JSON.stringify(descriptor), { mode: 0o600, flag: "wx" });
  return descriptor;
}
async function runUpgrade({ extension, root, runtime, node = process.execPath }) {
  fs.mkdirSync(path.join(root, "notes"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "notes/Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nSynthetic API root.\n", { mode: 0o600, flag: "wx" });
  let descriptor;
  const mask = process.umask(0o077);
  try { descriptor = create({ extension, root }); } finally { process.umask(mask); }
  const { ApiChatStore } = require(path.join(extension, "dist/chat/api-chat-store.js"));
  const { streamApiChat } = require(path.join(extension, "dist/chat/api-chat-client.js"));
  let store = new ApiChatStore(descriptor.state, namespace);
  assert.deepEqual(store.load(descriptor.inline, false).messages[0].images, [image]);
  const chat = store.load(descriptor.segmented, false);
  assert(chat.messages[0].content.length > 512 * 1024);
  const disk = JSON.parse(fs.readFileSync(path.join(descriptor.state, "api-chats", namespace, `${chat.id}.json`)));
  assert.equal(disk.version, 2);
  assert.equal(disk.messageHistory.schema, "pkm.chat.history/v1");
  let calls = 0;
  const provider = require("node:http").createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer isolated-api-only");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const last = body.messages.at(-1).content;
      if (Array.isArray(body.messages[0].content)) {
        assert(JSON.stringify(body.messages[0].content).includes(`data:image/png;base64,${image.dataBase64}`));
      } else assert.equal(body.messages[0].content, chat.messages[0].content);
      calls++;
      const answer = last === "Continue same-root segmented API Chat." ? "NATIVE_SEGMENTED_CONTINUATION"
        : last === "Continue original PNG API Chat." ? "NATIVE_PNG_CONTINUATION"
        : last === "Crash after durable provider result." ? "NATIVE_API_RECOVERED_ONCE"
        : last === "Crash before durable provider receipt." ? "NATIVE_API_UNKNOWN_OUTCOME"
        : "ACTUAL_INSTALLED_API_CONTINUATION";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: null }] })}\n\n`
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    let answer = "";
    await streamApiChat({ provider: "openai-compatible", endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
      apiKey: "isolated-api-only", model: "test-model", messages: chat.messages.map(({ role, content }) => ({ role, content })),
      signal: new AbortController().signal }, text => { answer += text; });
    assert.equal(answer, "ACTUAL_INSTALLED_API_CONTINUATION");
    chat.messages.push({ id: randomUUID(), role: "assistant", content: answer, status: "complete" });
    store.save(chat);
    store = new ApiChatStore(descriptor.state, namespace);
    assert.equal(store.load(chat.id, false).messages.at(-1).content, answer);
    const snapshot = () => {
      const entries = [];
      const visit = (directory, prefix = "") => {
        for (const name of fs.readdirSync(directory).sort()) {
          const file = path.join(directory, name), relative = prefix ? `${prefix}/${name}` : name;
          const stat = fs.lstatSync(file, { bigint: true });
          entries.push({ path: relative, ino: String(stat.ino), dev: String(stat.dev), mode: String(stat.mode),
            mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), size: String(stat.size),
            ...(stat.isFile() ? { sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") } : {}) });
          if (stat.isDirectory()) visit(file, relative);
        }
      };
      visit(root); return entries;
    };
    const before = snapshot(), rootInode = fs.statSync(root).ino;
    const { pathToFileURL } = require("node:url"), { once } = require("node:events");
    const load = name => import(pathToFileURL(path.join(runtime, "dist", `${name}.js`)).href);
    const { inspectLegacyApiChatArchive } = await load("legacy-api-chat-archive");
    const archive = inspectLegacyApiChatArchive(root);
    assert(archive.retainedBlobs.length > 0, "A genuine previous legacy save leaves older CAS generations.");
    const { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental } = await load("legacy-root-adoption");
    const fixture = path.dirname(root), nonce = randomUUID();
    fs.writeFileSync(path.join(fixture, "in-place-fixture-token"), nonce, { flag: "wx", mode: 0o600 });
    const options = require("./in-place-options.cjs").options;
    const prepared = await prepareLegacyRootAdoptionExperimental(root, options({ fixture, root, nonce }));
    assert.equal(prepared.sourceRoot, root);
    const adopted = await resumeLegacyRootAdoptionExperimental(root, options({ fixture, root, nonce, workspaceId: prepared.workspaceId }));
    assert.equal(adopted.storage.workspaceRoot(), root);
    const workspaceId = await adopted.storage.workspaceId();
    await adopted.storage.close();
    assert.equal(fs.statSync(root).ino, rootInode);
    fs.writeFileSync(path.join(fixture, "api-chat-host-grant.json"), JSON.stringify({
      root, nonce, workspaceId, extension, endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
      namespace, chatIds: [descriptor.inline, descriptor.segmented], sourceFingerprint: archive.sourceFingerprint,
    }), { flag: "wx", mode: 0o600 });
    const { Client } = await import(pathToFileURL(path.join(runtime, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")).href);
    const { StdioClientTransport } = await import(pathToFileURL(path.join(runtime, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js")).href);
    let client, transport, diagnostics = "";
    const close = async () => {
      try { await client?.close(); } finally { await transport?.close(); client = transport = undefined; }
    };
    async function start(crash = "") {
      await close(); diagnostics = "";
      const entry = fs.existsSync(path.join(extension, "in-place-server.cjs")) ? path.join(extension, "in-place-server.cjs")
        : path.join(__dirname, "in-place-server.cjs");
      transport = new StdioClientTransport({ command: node, args: [entry, fixture, root, runtime, nonce], cwd: fixture,
        env: { ...process.env, PKM_IN_PLACE_PRIVATE_FIXTURE: nonce,
          PKM_API_INTERRUPT_AFTER_PROVIDER: crash === "result" ? nonce : "",
          PKM_API_INTERRUPT_BEFORE_RECEIPT: crash === "unknown" ? nonce : "" }, stderr: "pipe" });
      transport.stderr.on("data", bytes => { diagnostics += String(bytes); });
      client = new Client({ name: "same-root-api-chat-upgrade", version: "1" });
      try { await client.connect(transport); } catch (error) { throw new Error(`${error.message}\n${diagnostics}`); }
      return transport._process;
    }
    async function call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      assert(!result.isError, JSON.stringify(result) + diagnostics);
      return JSON.parse(result.content[0].text);
    }
    const identity = chatId => ({ namespace, chatId });
    try {
      await start();
      const originalInline = await call("legacy_api_chat_history", identity(descriptor.inline));
      const { decodeChatImage } = require(path.join(extension, "dist/chat/api-chat-client.js"));
      assert.deepEqual(decodeChatImage(originalInline.messages[0].images[0]), Buffer.from(image.dataBase64, "base64"));
      const originalSegmented = await call("legacy_api_chat_history", identity(chat.id));
      assert.deepEqual(originalSegmented.messages, chat.messages);
      const segmentedRequest = { ...identity(chat.id), operationId: "private-segmented-continuation",
        expectedRevision: 0, text: "Continue same-root segmented API Chat." };
      const segmentedAnswer = await call("legacy_api_chat_continue", segmentedRequest);
      assert.equal(segmentedAnswer.text, "NATIVE_SEGMENTED_CONTINUATION");
      assert.deepEqual(await call("legacy_api_chat_continue", segmentedRequest), segmentedAnswer);
      const pngRequest = { ...identity(descriptor.inline), operationId: "private-png-continuation",
        expectedRevision: 0, text: "Continue original PNG API Chat." };
      assert.equal((await call("legacy_api_chat_continue", pngRequest)).text, "NATIVE_PNG_CONTINUATION");
      await start();
      assert.equal((await call("legacy_api_chat_history", identity(chat.id))).messages.at(-1).content, segmentedAnswer.text);
      assert.equal((await call("legacy_api_chat_history", identity(descriptor.inline))).messages.at(-1).content, "NATIVE_PNG_CONTINUATION");
      const crashed = await start("result"), exited = once(crashed, "exit");
      const request = { ...identity(chat.id), operationId: "private-crash-result",
        expectedRevision: 1, text: "Crash after durable provider result." };
      await assert.rejects(call("legacy_api_chat_continue", request));
      assert.deepEqual(await exited, [78, null]);
      assert.match(diagnostics, /PRIVATE_API_CHAT_EXIT_AFTER_DURABLE_PROVIDER_RESULT/);
      await start();
      const callsBefore = calls, recovered = await call("legacy_api_chat_continue", request);
      assert.equal(recovered.text, "NATIVE_API_RECOVERED_ONCE");
      assert.deepEqual(await call("legacy_api_chat_continue", request), recovered);
      assert.equal(calls, callsBefore, "Durable provider result recovery must not issue another HTTP request.");
      await start();
      const final = await call("legacy_api_chat_history", identity(chat.id));
      assert.equal(final.messages.filter(message => message.content === request.text).length, 1);
      assert.equal(final.messages.filter(message => message.content === recovered.text).length, 1);
      assert.deepEqual(final.messages.slice(0, chat.messages.length), chat.messages);
      assert.deepEqual((await call("legacy_api_chat_history", identity(descriptor.inline))).messages[0].images, [image]);
      const ambiguous = await start("unknown"), unknownExit = once(ambiguous, "exit");
      const unknownRequest = { ...identity(descriptor.inline), operationId: "private-unknown-provider",
        expectedRevision: 1, text: "Crash before durable provider receipt." };
      await assert.rejects(call("legacy_api_chat_continue", unknownRequest));
      assert.deepEqual(await unknownExit, [79, null]);
      await start();
      const unknownCalls = calls;
      const refused = await client.callTool({ name: "legacy_api_chat_continue", arguments: unknownRequest });
      assert.equal(refused.isError, true); assert.match(refused.content[0].text, /outcome is unknown/);
      assert.equal(calls, unknownCalls, "An uncertain HTTP effect is never silently repeated.");
      assert.equal((await call("legacy_api_chat_history", identity(descriptor.inline))).messages.length, originalInline.messages.length + 2);
      assert.equal(calls, 5);
      await close();
      const after = new Map(snapshot().map(entry => [entry.path, entry]));
      assert.deepEqual(before.map(entry => after.get(entry.path)), before,
        "All original JSON/segments/groups/privacy/Note identities and bytes remain unchanged on the SAME adopted root.");
      assert.equal(fs.statSync(root).ino, rootInode);
      console.log("PASS: ordinary API Chat adopts its original root with dedicated receipt, reads segmented history and PNG through real MCP client, continues via a real native multimodal HTTP/SSE port, reopens and recovers durable provider result after actual exit78 without duplicate effect; unknown provider receipt exit79 stays fail-closed.");
      return { inlineImagesReadable: true, segmentedHistoryReadable: true, legacyHttpContinuation: true,
        takeover: "EXPERIMENTAL_SAME_ROOT", nativeHttpContinuation: true, restarted: true,
        crashRecoveredWithoutDuplicateEffect: true, unknownProviderOutcome: "BLOCKED_NO_REISSUE", originalSourceUnchanged: true };
    } finally { await close(); }
  } finally { await new Promise(resolve => provider.close(resolve)); }
}
module.exports = { create, namespace, image, runUpgrade };
