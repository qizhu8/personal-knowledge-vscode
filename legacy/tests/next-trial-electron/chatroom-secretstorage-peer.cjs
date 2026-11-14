"use strict";
const fs = require("node:fs");
const { ChatClient, NextRoomResumeStore } = require(process.argv[2]);
const filename = process.argv[3];
const read = () => fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : {};
const secrets = {
  async get(key) { return read()[key]; },
  async store(key, value) { const data = read(); data[key] = value; fs.writeFileSync(filename, JSON.stringify(data), { mode: 0o600 }); },
  async delete(key) { const data = read(); delete data[key]; fs.writeFileSync(filename, JSON.stringify(data), { mode: 0o600 }); },
};
const store = new NextRoomResumeStore(secrets);
let client;
process.on("message", message => {
  if (message.type === "connect") {
    client = new ChatClient({
      onStatus(status) { if (status === "connected") process.send({ type: "connected", participantId: client.participantId }); },
      onMessage(value) { if (value.text === "@all real isolated peer message") process.send({ type: "message" }); },
      onHistory(values) { process.send({ type: "history", ids: values.map(value => value.id) }); },
      onPresence() {}, onFileComplete() {},
      onJoinPending() { process.send({ type: "pending" }); },
      onRejected(code) { process.send({ type: "rejected", code }); },
      loadResumeCredential(roomId, url, cid, room) {
        return roomId ? store.load(roomId, url, cid) : store.loadByName(room, url, cid);
      },
      async onResumeCredential(value, room) { await store.save(value, room); process.send({ type: "saved" }); },
    });
    client.connect({ ...message.options, user: "Historic Agent", cid: "historic-client-1", kind: "agent" });
  } else if (message.type === "stop") {
    client?.disconnect();
    setTimeout(() => process.disconnect(), 100);
  }
});
