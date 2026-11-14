"use strict";
let held, old, attempts = 0, chatAttempts = 0;
process.on("message", message => {
  if (message?.type === "release") {
    if (held) { reply(held, true); held = undefined; }
    return;
  }
  if (message?.type === "release-old") {
    if (old) { reply(old, true); old = undefined; }
    return;
  }
  if (message?.type !== "pkm.owner-scope-revoke/v1") return;
  attempts++;
  if (message.scope === "chat") chatAttempts++;
  process.send({ type: "entered", attempts });
  if (process.argv[2] === "held") held = message;
  else if (process.argv[2] === "late-first") {
    if (attempts === 1) old = message; else held = message;
  }
  else if (process.argv[2] === "fail-first" && attempts === 1) reply(message, false);
  else if (process.argv[2] === "timeout-chat" && message.scope === "chat" && chatAttempts === 1) {}
  else if (process.argv[2] !== "timeout") reply(message, true);
});
function reply(message, drained) {
  process.send({ type: "pkm.owner-scope-revoked/v1", sessionId: message.sessionId,
    scope: message.scope, id: message.id, drained });
}
process.send({ type: "ready" });
