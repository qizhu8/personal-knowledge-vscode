"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");

exports.run = async ({ fixture, root, extension, node, adopt, requireChat = false }) => {
  const runtime = path.join(extension, "next-runtime/server");
  const yaml = require(path.join(runtime, "node_modules/yaml"));
  const documentIdentity = raw => yaml.parse(raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "")?.documentId;
  const nonce = randomUUID();
  const tokenFile = path.join(fixture, "in-place-fixture-token");
  fs.writeFileSync(tokenFile, nonce, { flag: "wx", mode: 0o600 });
  const { Client } = await import(pathToFileURL(path.join(runtime, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")).href);
  const { StdioClientTransport } = await import(pathToFileURL(path.join(runtime, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js")).href);
  const note = path.join(root, "notes/Existing.md");
  const before = fs.readFileSync(note, "utf8");
  assert.match(before, /Do not change this legacy fixture/);
  const originalDocumentId = documentIdentity(before);
  const rootIdentity = fs.statSync(root).ino;
  try { await adopt(root, nonce); }
  catch (error) { fs.unlinkSync(tokenFile); throw error; }
  assert.equal(fs.statSync(root).ino, rootIdentity, "Adoption replaced the root");
  assert.equal(fs.readFileSync(note, "utf8"), before, "Adoption rewrote the old Note");
  const server = path.join(extension, "in-place-server.cjs");
  fs.copyFileSync(path.join(__dirname, "in-place-server.cjs"), server);
  fs.copyFileSync(path.join(__dirname, "chatroom-fixture.cjs"), path.join(extension, "chatroom-fixture.cjs"));
  const descriptorFile = path.join(fixture, "chatroom-fixture.json");
  const descriptor = fs.existsSync(descriptorFile) ? JSON.parse(fs.readFileSync(descriptorFile, "utf8")) : undefined;
  const chatEnabled = descriptor?.root === root;
  assert(!requireChat || chatEnabled, "Same-root Chat acceptance requires history created by the actually installed old extension");
  let provider, chatRequest, chatResult, sourceDb;
  const hash = file => require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  let client, transport;
  let serverDiagnostics = "";
  const close = async () => {
    try { await client?.close(); }
    finally { await transport?.close(); client = transport = undefined; }
  };
  const connect = async (interruptAfterProvider = false, interruptRoom = false) => {
    serverDiagnostics = "";
    transport = new StdioClientTransport({
      command: node, args: [server, fixture, root, runtime, nonce], cwd: fixture,
      env: { ...process.env, PKM_IN_PLACE_PRIVATE_FIXTURE: nonce, PYTHONDONTWRITEBYTECODE: "1",
        ...(interruptAfterProvider ? { PKM_CHAT_INTERRUPT_AFTER_PROVIDER: nonce } : {}),
        PKM_ROOM_INTERRUPT_AFTER_FILE: interruptRoom ? nonce : "" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", bytes => { serverDiagnostics += bytes.toString(); });
    client = new Client({ name: "private-profile-in-place-journey", version: "1" });
    await client.connect(transport);
    const listed = await client.listTools();
    assert(listed.tools.some(tool => tool.name === "legacy_knowledge_write"));
  };
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result;
  };
  const chatCall = async (name, args) => JSON.parse((await call(name, args)).content[0].text);
  try {
    if (chatEnabled) {
      const load = name => import(pathToFileURL(path.join(runtime, "dist", `${name}.js`)).href);
      const { inspectLegacyChatroomArchive } = await load("legacy-chatroom-continuation");
      const archive = inspectLegacyChatroomArchive(root, descriptor.roomId);
      sourceDb = path.join(root, "chatrooms", descriptor.roomId, "chatroom.db");
      assert.equal(hash(sourceDb), descriptor.dbSha256);
      const { Storage } = await load("storage");
      const current = await Storage.open(root);
      let workspaceId;
      try { workspaceId = await current.workspaceId(); } finally { await current.close(); }
      provider = await require("./chatroom-fixture.cjs").localProvider();
      const liveFile = path.join(fixture, "chatroom-live-fixture.json");
      let roomRuntime;
      if (fs.existsSync(liveFile)) {
        const live = JSON.parse(fs.readFileSync(liveFile, "utf8"));
        assert.equal(live.root, root);
        assert.equal(hash(path.join(root, "chatrooms", live.roomId, "chatroom.db")), live.dbSha256);
        roomRuntime = { roomId: live.roomId, sourceFingerprint: inspectLegacyChatroomArchive(root, live.roomId).sourceFingerprint };
      }
      assert(!requireChat || roomRuntime, "Same-root Room acceptance requires the actually installed old multi-participant writer fixture");
      fs.writeFileSync(path.join(fixture, "chatroom-host-grant.json"), JSON.stringify({
        root, nonce, roomId: descriptor.roomId, workspaceId, sourceFingerprint: archive.sourceFingerprint, endpoint: provider.endpoint,
        ...(roomRuntime ? { roomRuntime } : {}),
      }), { flag: "wx", mode: 0o600 });
    }
    await connect(chatEnabled);
    const listed = await call("list_notes", {});
    assert.match(JSON.stringify(listed), /Existing/);
    const original = await call("legacy_knowledge_read", { tool: "get_note", arguments: { slug: "Existing" } });
    assert.match(JSON.stringify(original), /Do not change this legacy fixture/);
    const updated = "Written by the real Next MCP server on the original configured path.\n";
    await call("legacy_knowledge_write", { tool: "update_note", arguments: { slug: "Existing", content: updated } });
    assert.match(fs.readFileSync(note, "utf8"), /Written by the real Next MCP server/);
    if (originalDocumentId)
      assert.equal(documentIdentity(fs.readFileSync(note, "utf8")), originalDocumentId,
        "The original Note identity changed during same-path publication");
    if (chatEnabled) {
      const rooms = await chatCall("legacy_chatroom_list", {});
      assert.deepEqual(rooms.items.map(room => room.roomId), [descriptor.roomId]);
      const history = await chatCall("legacy_chatroom_history", { roomId: descriptor.roomId });
      assert.deepEqual(history.items.map(message => message.message_id), descriptor.messages.map(message => message.id));
      assert.deepEqual(history.items.map(message => message.content), descriptor.messages.map(message => message.content));
      assert.deepEqual(JSON.parse(history.items[0].metadata_json), descriptor.messages[0].metadata);
      const migrated = await chatCall("legacy_chatroom_migrate", { roomId: descriptor.roomId });
      assert.equal(migrated.importedMessages, descriptor.messages.length);
      assert.equal(migrated.session.messageCount, descriptor.messages.length);
      chatRequest = { roomId: descriptor.roomId, operationId: randomUUID(), expectedRevision: migrated.session.revision,
        text: "Continue the original ORCHID-47 discussion after this same-root upgrade." };
      await assert.rejects(chatCall("legacy_chatroom_continue", chatRequest),
        "The test-only server must actually terminate between committed provider success and assistant publication");
      assert.match(serverDiagnostics, /INJECTED_PRIVATE_FIXTURE_EXIT_AFTER_PROVIDER_SUCCESS/);
      assert.equal(provider.calls.length, 1);
    }
    await close();
    await connect();
    const restored = await call("list_notes", {});
    assert.match(JSON.stringify(restored), /Existing/);
    const reread = await call("legacy_knowledge_read", { tool: "get_note", arguments: { slug: "Existing" } });
    assert.match(JSON.stringify(reread), /Written by the real Next MCP server/);
    assert.match(fs.readFileSync(note, "utf8"), /Written by the real Next MCP server/);
    if (chatEnabled) {
      const continued = await chatCall("legacy_chatroom_continue", chatRequest);
      assert.match(continued.output, /LOCAL_FIXTURE_CONTINUATION ORCHID-47/);
      assert.equal(provider.calls.length, 1, "Restart recovery duplicated an already successful real HTTP provider request");
      await close();
      await connect();
      const transcript = await chatCall("legacy_chatroom_session", { roomId: descriptor.roomId, limit: 20 });
      assert.equal(transcript.page.items.length, descriptor.messages.length + 2);
      assert.deepEqual(transcript.page.items.slice(0, descriptor.messages.length).map(message => message.content), descriptor.messages.map(message => message.content));
      assert.deepEqual(transcript.page.items.slice(0, descriptor.messages.length).map(message => message.metadata.retrieval.messageId),
        descriptor.messages.map(message => message.id));
      assert.deepEqual(transcript.page.items[0].metadata.retrieval.originalMetadata, descriptor.messages[0].metadata);
      assert.equal(transcript.page.items.at(-2).content, chatRequest.text);
      assert.equal(transcript.page.items.at(-1).content, continued.output);
      await chatCall("legacy_chatroom_continue", chatRequest);
      assert.equal(provider.calls.length, 1);
      assert.equal(hash(sourceDb), descriptor.dbSha256, "Native continuation changed original legacy Chatroom bytes");
      const originalHistory = await chatCall("legacy_chatroom_history", { roomId: descriptor.roomId });
      assert.equal(originalHistory.total, descriptor.messages.length);
      chatResult = { history: true, continued: true, restarted: true, recoveredWithoutReplay: true, sourceUnchanged: true };
      if (fs.existsSync(path.join(fixture, "chatroom-live-fixture.json"))) {
        chatResult.room = await require("./chatroom-live-journey.cjs").run({
          fixture, root, extension, runtime, node, call: chatCall,
          restart: async interruptRoom => { await close(); await connect(false, interruptRoom); return transport._process; },
        });
        assert.equal(provider.calls.length, 1);
      }
      console.log("PASS: actual installed old nonempty Chatroom history read; same-root native Chat continued through real controlled local HTTP/SSE provider; process interruption/restarts recovered without duplicate request or original-data loss. qualification: experimental-unqualified.");
    }
    assert.equal(fs.statSync(root).ino, rootIdentity);
    const sentinel = path.join(root, "fixture-sentinel.txt");
    if (fs.existsSync(sentinel)) assert.equal(fs.readFileSync(sentinel, "utf8"), "untouched");
    console.log(`PASS: real Next MCP server read and updated the same Note path (${note}); a second process reopened it and retained the write.`);
    return { root, read: true, write: true, restarted: true, ...(chatResult ? { chat: chatResult } : {}) };
  } finally {
    try { await close(); } finally {
      await provider?.close();
      if (chatEnabled) fs.rmSync(path.join(fixture, "chatroom-host-grant.json"), { force: true });
      fs.unlinkSync(tokenFile);
    }
  }
};
