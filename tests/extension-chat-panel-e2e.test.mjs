import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { managerActor, nativeWorkspace, until } from "./batch06-manager-fixtures.mjs";
import { createSyntheticProvider } from "./chat-turn-native-fixtures.mjs";

test("experimental extension Chat panel reattaches after reload and cancels actual native work without history writes or replay", { timeout: 45_000 }, async t => {
  let release;
  const gate = new Promise(ready => { release = ready; });
  const provider = createSyntheticProvider({ onOpen: () => gate });
  const f = await nativeWorkspace(t, { ...provider,
    toolCatalog: [{ name: "create_document", operation: "knowledge.document.create" }],
    reviewer: async request => ({ actorId: request.actorId, decisionId: randomUUID(), decision: "reject" }),
  });
  f.addCleanup(() => release());
  const origin = await f.listen(managerActor), require = createRequire(import.meta.url);
  const bundle = join(f.root, "experimental-panel-test.cjs");
  require("esbuild").buildSync({ stdin: { contents: `
    export { VscodeClient, bindWebview } from "./clients/vscode/index.ts";
    export { experimentalPanelHtml } from "./clients/vscode-host/chat-panel.ts";`,
    resolveDir: resolve(import.meta.dirname, ".."), loader: "ts" },
    outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
  const { VscodeClient, bindWebview, experimentalPanelHtml } = require(bundle);
  const client = new VscodeClient({
    secrets: { get: async () => f.bearer },
    attestServer: async () => ({ serverId: "pkm-v5", workspaceId: await f.storage.workspaceId(),
      actorId: managerActor.id, protocolVersion: "v1" }),
  }, { origin, secretKey: "test-only-business-token", expectedWorkspaceId: await f.storage.workspaceId() });
  await client.connect();
  f.addCleanup(() => client.dispose());
  let listener;
  const channel = {}, responses = new Map(), calls = [];
  const binding = bindWebview(client, {
    onMessage(callback) { listener = callback; return { dispose() { listener = undefined; } }; },
    async postMessage(value) {
      const response = responses.get(value.requestId);
      if (response) { responses.delete(value.requestId); response.end(JSON.stringify(value)); }
    },
  }, channel);
  const panel = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.setHeader("Content-Type", "text/html"); res.end(experimentalPanelHtml("native-panel-test")); return;
    }
    if (req.method !== "POST" || req.url !== "/channel") { res.writeHead(404); res.end(); return; }
    let text = "";
    for await (const chunk of req) text += chunk;
    const message = JSON.parse(text);
    calls.push(message); responses.set(message.requestId, res);
    listener({ source: channel, message });
  });
  await new Promise(ready => panel.listen(0, "127.0.0.1", ready));
  f.addCleanup(async () => { binding.dispose(); panel.closeAllConnections(); await new Promise(ready => panel.close(ready)); });
  const url = `http://127.0.0.1:${panel.address().port}`;
  const child = spawn(process.env.PYTHON ?? "python3", [resolve(import.meta.dirname, "extension-chat-panel-e2e.py")],
    { stdio: ["pipe", "pipe", "pipe"] });
  let diagnostics = "", output = "", report;
  child.stderr.on("data", bytes => { diagnostics += bytes; });
  child.stdout.on("data", bytes => { output += bytes; });
  const handling = (async () => {
    for await (const line of createInterface({ input: child.stdout })) {
      const value = JSON.parse(line);
      if (value.checkpoint === "running") {
        assert.equal(provider.counts().modelCalls, 1);
        assert.equal(f.runtime.services.chatTurns.activity().active, 1);
        child.stdin.write('{"ready":true}\n');
      } else if (value.checkpoint === "cancelled") {
        release(); await until(() => f.runtime.services.chatTurns.activity().active === 0);
        child.stdin.write('{"ready":true}\n');
      } else report = value;
    }
  })();
  const closed = new Promise((ready, reject) => { child.once("error", reject); child.once("close", ready); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
  f.addCleanup(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  child.stdin.write(JSON.stringify({ url }) + "\n");
  const exit = await closed; clearTimeout(timer); await handling;
  assert.equal(exit, 0, `${output}\n${diagnostics}`);
  assert.deepEqual(report.errors, []);
  const starts = calls.filter(call => call.action === "chatStart");
  assert.equal(starts.length, 1);
  assert(starts[0].input.expectedSessionRevision > 0);
  assert.deepEqual(starts[0].input.messages, [{ role: "user", content: "One experimental extension input" }]);
  assert.equal(provider.counts().modelCalls, 1);
  assert.equal(calls.some(call => call.action === "chatAppend"), false);
  assert(calls.filter(call => call.action === "chatTurns").length >= 3);
  assert(calls.some(call => call.action === "chatArchive"));
  assert(calls.some(call => call.action === "chatEvents"));
  assert(calls.some(call => call.action === "retrievalAvailability"));
  const transcript = await f.runtime.core.dispatch("capability_read", { operation: "chat.session.messages", version: 1,
    arguments: { id: starts[0].input.sessionId } }, managerActor);
  assert.deepEqual(transcript.result.items.map(item => [item.role, item.status]), [["user", "complete"], ["assistant", "cancelled"]]);
});
