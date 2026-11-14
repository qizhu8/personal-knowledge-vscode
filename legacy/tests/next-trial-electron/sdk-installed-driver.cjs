"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const vscode = require("vscode");
const { localSdkTransport } = require("./sdk-local-transport.cjs");

exports.run = async () => {
  const root = process.env.PKM_SELECTED_FIXTURE;
  let extension;
  for (let i = 0; i < 100 && !extension; i++) {
    extension = vscode.extensions.getExtension("Uone.personal-knowledge");
    if (!extension) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(extension, "Installed extension missing");
  const asar = path.join(vscode.env.appRoot, "node_modules.asar");
  const sdk = require(path.join(asar, "@github/copilot-sdk"));
  const rpc = require(path.join(asar, "vscode-jsonrpc/node"));
  const createBridge = require(path.join(extension.extensionPath, "dist/runtime/next-copilot-sdk-bridge.js")).createNextCopilotSdkBridge;
  const model = { vendor: "copilot-sdk", id: "fixture-model", maxInputTokens: 32768, maxOutputTokens: 1024,
    capabilities: { toolCalling: true, imageInput: true }, copilotSdk: { routed: false } };
  const results = [];
  for (const mode of ["normal", "cancel", "disconnect"]) {
    const transport = await localSdkTransport({ rpc, program: "/synthetic/node", args: ["fixture"], cwd: "/synthetic", mode });
    const client = new sdk.CopilotClient({ connection: sdk.RuntimeConnection.forUri(transport.url), mode: "empty" });
    await client.start();
    const session = randomUUID(), pending = new Map(), controller = new AbortController();
    const bridge = createBridge({ model, session, contextWindow: 16384, maxOutputTokens: 1024,
      deps: { async token() { return "fixture-only-token"; }, async client() { return { sdk, client }; } },
      signal: controller.signal, assertCurrent() {}, send(message) { pending.get(message.id)?.(message); } });
    const request = (type, streamId, extra = {}) => new Promise(resolve => {
      const id = randomUUID(); pending.set(id, value => { pending.delete(id); resolve(value); });
      bridge.handle({ type, id, session, streamId, ...extra });
    });
    const open = (id, messages) => request("selected-lm-open", id, { messages, maxInputTokens: 10000, maxOutputTokens: 1024,
      tools: [{ name: "run_process", description: "approved command", parameters: { type: "object", properties: {} } }] });
    try {
      const stream = randomUUID();
      const messages = [{ role: "user", content: "Remember context: blue umbrella." }];
      const opening = open(stream, messages);
      if (mode === "normal") {
        assert.equal((await opening).result?.opened, true);
        const call = (await request("selected-lm-next", stream)).result.event;
        assert.equal(call.type, "tool");
        assert.equal(transport.state.aborts.length, 1);
        for (let i = 0; i < 200 && !transport.state.callbacks.length; i++)
          await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(transport.state.callbacks.length, 1);
        assert(transport.state.callbacks.every(callback => callback.afterAbort));
        assert.equal((await request("selected-lm-next", stream)).result.event.reason, "tool_calls");
        messages.push({ role: "assistant", content: "", tool_calls: [{ id: call.id, type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] },
        { role: "tool", tool_call_id: call.id, content: "fixture-result-123" });
        const next = randomUUID();
        assert.equal((await open(next, messages)).result?.opened, true);
        assert.equal((await request("selected-lm-next", next)).result.event.text, "SDK_FIXTURE_SUCCESS");
        assert.equal((await request("selected-lm-next", next)).result.event.reason, "stop");
        assert.notEqual(transport.state.sends[0].sessionId, transport.state.sends[1].sessionId);
        assert.match(transport.state.sends[1].prompt, /blue umbrella/);
        assert.match(transport.state.sends[1].prompt, /fixture-result-123/);
        assert.equal(transport.state.sends.length, 2);
      } else {
        while (!transport.state.sends.length) await new Promise(resolve => setTimeout(resolve, 10));
        if (mode === "disconnect") await new Promise(resolve => setTimeout(resolve, 150));
        await request("selected-lm-cancel", stream);
        assert.equal((await opening).error, "MODEL_PROVIDER_ERROR");
        if (mode === "disconnect") await assert.rejects(bridge.drain());
        else await bridge.drain();
        assert.equal(transport.state.sends.length, 1);
        assert.deepEqual(transport.state.callbacks, []);
      }
      results.push(mode);
    } finally {
      bridge.dispose();
      await bridge.drain().catch(() => {});
      await client.stop().catch(() => {});
      await transport.close();
    }
  }
  fs.writeFileSync(path.join(root, "sdk-installed-result.json"), JSON.stringify({
    results, installedBridge: true, sdk: "VS Code bundled SDK", transport: "isolated loopback fixture",
    approval: "not tested by this driver", paidService: false,
  }), { mode: 0o600 });
  console.log("PASS installed bridge + bundled SDK over isolated fixture; approval not exercised.");
};
