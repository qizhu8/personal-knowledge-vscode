import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { Storage } from "../dist/storage.js";
import { createVscodeLegacyChatroomHost } from "../dist/legacy-chatroom-vscode-host.js";

const require = createRequire(import.meta.url);
const storage = await Storage.open(process.argv[2], { deferRecovery: true });
const retained = require(process.argv[3]);
let runtime, stopping, session, probeId;
const stop = () => stopping ??= (async () => {
  try { await runtime?.close(); } finally {
    await storage.close();
    if (process.connected) process.send({ type: "drained" }, () => process.disconnect());
  }
})();
process.once("disconnect", () => { void stop(); });
process.on("message", message => {
  if (message?.type === "configure" && !runtime) {
    session = message.session;
    void createVscodeLegacyChatroomHost({ storage, retained, binding: message.binding, session: message.session,
      legacyReconnect: message.legacyReconnect })
      .then(host => { runtime = host; process.send({ type: "configured" }); });
  } else if (message?.type === "reopen" && runtime) {
    void runtime.reopen(message.roomId).then(result => process.send({ type: "opened", result }),
      () => process.send({ type: "denied" }));
  } else if (message?.type === "probe" && session) {
    probeId = randomUUID();
    process.send({ type: "pkm.room.host-request/v1", session, id: probeId, operation: "load",
      binding: { ...message.binding, actorId: "mcp:external" } });
  } else if (message?.type === "pkm.room.host-response/v1" && message.id === probeId) {
    process.send({ type: "probe-result", allowed: message.ok, hasCredentials: !!message.result });
  } else if (message?.type === "pkm.room.host-revoked/v1" && message.session === session) {
    void stop();
  }
});
process.send({ type: "ready", workspaceId: await storage.workspaceId() });
