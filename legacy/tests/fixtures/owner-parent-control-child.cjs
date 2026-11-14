"use strict";
const { randomUUID } = require("node:crypto");
let count = 0;
process.on("message", message => {
  if (message?.type !== "pkm.owner-scope-revoke/v1") return;
  process.send({ type: "pkm.owner-scope-revoked/v1", id: message.id,
    sessionId: randomUUID(), scope: message.scope, drained: true });
  const delay = ++count === 1 ? 200 : 10;
  setTimeout(() => {
    if (process.connected) process.send({ type: "pkm.owner-scope-revoked/v1",
      id: message.id, sessionId: message.sessionId, scope: message.scope, drained: true });
  }, delay);
});
process.send({ type: "ready" });
