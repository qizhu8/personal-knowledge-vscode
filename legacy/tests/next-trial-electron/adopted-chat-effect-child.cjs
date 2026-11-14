"use strict";
const fs = require("node:fs"), ts = require("typescript"), { spawn } = require("node:child_process");
const source = fs.readFileSync("next-server/src/legacy-api-chat-effect-child.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
new Function("require", "module", "exports", js)(require, mod, mod.exports);
const scope = new AbortController();
let gate, release, environment = true, descendant, heldRevoke, running = false, early = false;
function acknowledge(message) {
  process.send({ type: "pkm.owner-scope-revoked/v1", sessionId: message.sessionId,
    scope: message.scope, id: message.id, drained: true });
}
process.on("message", async message => {
  if (message?.type === "init") {
    early = message.early === true;
    gate = mod.exports.createAdoptedChatEffectChild({ sessionId: message.sessionId, chat: message.chat,
      scopeSignal: scope.signal, assertLocalCurrent() {},
      executors: {
        async history() { return "history"; },
        async continue() {
          descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
          process.send({ type: "effect-started", pid: descendant.pid });
          await new Promise(resolve => { release = resolve; });
          const exited = new Promise(resolve => descendant.once("exit", resolve));
          descendant.kill("SIGTERM");
          await exited;
          process.send({ type: "effect-ended" });
          return "continued";
        },
      } });
    process.send({ type: "initialized" });
  } else if (message?.type === "run") {
    running = true;
    try { process.send({ type: "result", tag: message.tag, value: await gate.run(message.effect) }); }
    catch (error) { process.send({ type: "result", tag: message.tag, error: error.message }); }
    finally {
      running = false;
      if (heldRevoke) { acknowledge(heldRevoke); heldRevoke = undefined; }
    }
  } else if (message?.type === "release") {
    release?.();
  } else if (message?.type === "invalidate-local") {
    scope.abort();
  } else if (message?.type === "env") {
    process.send({ type: "env-result", active: environment });
  } else if (message?.type === "pkm.owner-scope-revoke/v1") {
    if (message.scope === "chat") scope.abort();
    if (message.scope === "environment") environment = false;
    if (message.scope === "chat" && running && !early) heldRevoke = message;
    else acknowledge(message);
  } else if (message?.type === "replay") {
    process.send({ protocol: "pkm.experimental-chat-effect/v1", sessionId: message.sessionId,
      kind: "request", id: message.id, effect: message.effect });
    process.send({ protocol: "pkm.experimental-chat-effect/v1", sessionId: message.sessionId,
      kind: "request", id: message.id, effect: message.effect });
  }
});
process.send({ type: "ready" });
