"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { pathToFileURL } = require("node:url");
async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Native Room client timeout: ${label}`);
}
exports.run = async ({ fixture, root, extension, runtime, node = process.execPath, call, restart, identitySuffix = "" }) => {
  const descriptor = JSON.parse(fs.readFileSync(path.join(fixture, "chatroom-live-fixture.json"), "utf8"));
  assert.equal(descriptor.root, root);
  const db = path.join(root, "chatrooms", descriptor.roomId, "chatroom.db");
  const sha = () => createHash("sha256").update(fs.readFileSync(db)).digest("hex");
  assert.equal(sha(), descriptor.dbSha256);
  const { createLegacyChatroomClient } = await import(pathToFileURL(path.join(runtime, "dist/legacy-chatroom-runtime.js")).href);
  const { ChatClient } = require(path.join(extension, "dist/chatroom/chatroom-client.js"));
  const clients = [];
  let opened;
  const disconnect = () => { for (const entry of clients) entry.client.disconnect(); };
  const reopen = async () => { opened = await call("legacy_chatroom_reopen", { roomId: descriptor.roomId }); };
  async function connect(alias, kind = "human") {
    const entry = { history: [], messages: [], presence: [], files: [], errors: [] };
    entry.client = createLegacyChatroomClient(ChatClient, {
      onStatus() {}, onMessage: message => entry.messages.push(message),
      onHistory: messages => { entry.history = messages; }, onPresence: members => { entry.presence = members; },
      onFileComplete: (metadata, from, bytes) => entry.files.push({ metadata, from, bytes }),
      onRejected: (code, message) => entry.errors.push({ code, message }),
    });
    clients.push(entry);
    entry.client.connect({ url: opened.url, room: opened.roomName, roomId: descriptor.roomId,
      user: alias, kind, cid: alias, token: opened.secret, hostToken: alias === "Native Host" ? opened.hostToken : undefined });
    await until(() => entry.client.isConnected, `${alias}: ${JSON.stringify(entry.errors)}`);
    return entry;
  }
  try {
    await reopen();
    const host = await connect("Native Host"), peer = await connect(`Native Peer${identitySuffix}`, "agent");
    assert.deepEqual(host.history.slice(0, descriptor.messages.length).map(message => message.id), descriptor.messages.map(message => message.id));
    assert.deepEqual(host.history.slice(0, descriptor.messages.length).map(message => message.from), descriptor.messages.map(message => message.aliasAtSend));
    await until(() => host.presence.some(member => member.participantId === "historic-human"), "historical participant roster");
    assert.equal((await fetch(opened.downloadBase + descriptor.file.fileId, {
      headers: { "X-PKM-Room-Secret": opened.secret },
    })).status, 404, "Historical attachment metadata must not invent missing payload bytes.");
    assert.equal(host.client.sendText("Human continues in the same root.", undefined, "none", undefined, [`Native Peer${identitySuffix}`]), true);
    assert.equal(peer.client.sendText("Agent continues in the same root.", undefined, "none", undefined, ["Native Host"]), true);
    await until(() => host.messages.some(message => message.text === "Agent continues in the same root."), "live agent reply");
    const bytes = Buffer.from("Actual isolated same-root attachment.\0".repeat(5000));
    const sent = await host.client.sendFile("same-root.bin", "application/octet-stream", bytes);
    assert.equal(sent.ok, true);
    await until(() => peer.files.some(file => file.metadata.fileId === sent.file.fileId), "real live attachment");
    assert.deepEqual(peer.files.find(file => file.metadata.fileId === sent.file.fileId).bytes, bytes);
    const request = { t: "msg", room: descriptor.roomId, text: "One same-root native Room request.",
      recipients: ["all"], replyPolicy: "none", clientRequestId: "same-root-room-request-1" };
    host.client.ws.send(JSON.stringify(request));
    await until(() => host.messages.some(message => message.text === request.text), "durable Room message");
    const identity = host.client.participantId;
    disconnect(); await restart(); await reopen();
    const resumed = await connect("Native Host"), observer = await connect(`Native Observer${identitySuffix}`);
    assert.equal(resumed.client.participantId, identity);
    await until(() => observer.files.some(file => file.metadata.fileId === sent.file.fileId), "persisted file into real client after restart");
    assert.deepEqual(observer.files.find(file => file.metadata.fileId === sent.file.fileId).bytes, bytes);
    assert.equal(observer.messages.filter(message => message.file?.fileId === sent.file.fileId).length, 0,
      "Byte replay must not duplicate the file's existing history note.");
    resumed.client.ws.send(JSON.stringify(request));
    const download = await fetch(opened.downloadBase + sent.file.fileId, { headers: { "X-PKM-Room-Secret": opened.secret } });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    disconnect(); const child = await restart(true); await reopen();
    const exited = once(child, "exit"), crashing = await connect("Native Host");
    let offer;
    const send = crashing.client.ws.send.bind(crashing.client.ws);
    crashing.client.ws.send = (raw, ...args) => {
      const frame = JSON.parse(String(raw));
      if (frame.t === "file.offer" && frame.file.name === "fixture-crash.bin") offer = frame;
      return send(raw, ...args);
    };
    const pending = Buffer.from("Recover actual file bytes after durable note and process failure.");
    await crashing.client.sendFile("fixture-crash.bin", "application/octet-stream", pending).catch(() => {});
    assert.deepEqual(await exited, [77, null]);
    assert(offer);
    disconnect(); await restart(); await reopen();
    const recovered = await connect("Native Host"), receiver = await connect(`Recovered Observer${identitySuffix}`);
    assert.equal((await fetch(opened.downloadBase + offer.file.fileId, {
      headers: { "X-PKM-Room-Secret": opened.secret },
    })).status, 404);
    const chunk = { t: "file.chunk", room: descriptor.roomId, fileId: offer.file.fileId, seq: 0,
      data: pending.toString("base64"), last: true };
    for (const frame of [offer, chunk, offer, chunk]) recovered.client.ws.send(JSON.stringify(frame));
    await until(() => receiver.files.some(file => file.metadata.fileId === offer.file.fileId), "interrupted file resumed");
    assert.deepEqual(receiver.files.find(file => file.metadata.fileId === offer.file.fileId).bytes, pending);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(receiver.files.filter(file => file.metadata.fileId === offer.file.fileId).length, 1);
    assert.equal(receiver.history.filter(message => message.file?.fileId === offer.file.fileId).length, 1);
    assert.equal(receiver.messages.filter(message => message.file?.fileId === offer.file.fileId).length, 0);
    disconnect(); await restart(); await reopen();
    const final = await connect("Native Host");
    await until(() => final.files.some(file => file.metadata.fileId === offer.file.fileId), "recovered payload survives another process");
    assert.deepEqual(final.files.find(file => file.metadata.fileId === offer.file.fileId).bytes, pending);
    assert.equal(final.history.filter(message => message.text === request.text).length, 1);
    assert.equal(final.history.filter(message => message.file?.fileId === offer.file.fileId).length, 1);
    assert.equal(sha(), descriptor.dbSha256);
    const apiChat = await require("./api-chat-fixture.cjs").runUpgrade({
      extension, runtime, node, root: path.join(fixture, "ordinary-api-upgrade", "knowledge"),
    });
    console.log("PASS: legacy multi-participant archive reopens on the same root; real retained clients read history/roster, exchange human/agent messages and bytes; native file replay, child-exit recovery and duplicate requests preserve one durable effect. Old metadata-only payload remains explicitly unavailable.");
    return { sameRoot: true, multiParticipant: true, reopened: true, actualClients: true, attachmentBytes: true,
      crashRecoveredWithoutDuplicateEffect: true, originalArchiveUnchanged: true, missingHistoricalPayload: "unrecoverable-never-persisted", apiChat };
  } finally { disconnect(); }
};
