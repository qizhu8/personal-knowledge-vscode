"use strict";
const net = require("node:net");
const { randomUUID } = require("node:crypto");

/** JSON-RPC runtime fixture. It never contacts a model service or executes a tool. */
async function localSdkTransport({ rpc, program, args, cwd, mode = "normal" }) {
  const state = { creates: [], sends: [], aborts: [], detaches: [], deletes: [], callbacks: [], connections: 0 };
  const sockets = new Set(), connections = new Set();
  const server = net.createServer(socket => {
    state.connections++; sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    const connection = rpc.createMessageConnection(new rpc.StreamMessageReader(socket), new rpc.StreamMessageWriter(socket));
    connections.add(connection);
    connection.onClose(() => connections.delete(connection));
    const event = (sessionId, type, data = {}) => connection.sendNotification("session.event", {
      sessionId, event: { id: randomUUID(), timestamp: new Date().toISOString(), type, data },
    });
    connection.onRequest("connect", () => ({ protocolVersion: 3 }));
    connection.onRequest("models.list", input => {
      if (input.gitHubToken !== "fixture-only-token") throw new Error("SDK fixture model token mismatch.");
      return { models: [{ id: "local-sdk-fixture", name: "Local SDK fixture",
        capabilities: { family: "fixture", limits: { max_prompt_tokens: 16384, max_output_tokens: 1024 },
          supports: { tool_calls: true, vision: false } } }] };
    });
    connection.onRequest("session.create", input => {
      if (input.gitHubToken !== "fixture-only-token" || input.enableSessionStore !== false
        || input.enableConfigDiscovery !== false || input.enableSkills !== false || input.enableHostGitOperations !== false)
        throw new Error("SDK fixture configuration mismatch.");
      state.creates.push(input);
      return { sessionId: input.sessionId, capabilities: {} };
    });
    connection.onRequest("session.options.update", () => ({}));
    connection.onRequest("session.send", input => {
      state.sends.push(input);
      const sessionId = input.sessionId;
      if (mode === "cancel") return { messageId: randomUUID() };
      setTimeout(() => {
        if (socket.destroyed) return;
        if (mode === "disconnect") { socket.destroy(); return; }
        const messages = input.prompt.split("\n").map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean);
        const tool = messages.find(message => message.role === "tool");
        if (tool) {
          event(sessionId, "assistant.message", { messageId: randomUUID(), content: "SDK_FIXTURE_SUCCESS", toolRequests: [] });
          event(sessionId, "session.idle");
        } else {
          const call = { program, arguments: args, cwd, timeoutSeconds: 60,
            ...(mode === "foreground" ? { background: false } : { background: true, idempotency_key: "real-sdk-fixture" }) };
          event(sessionId, "external_tool.requested", { requestId: randomUUID(), toolName: "run_process", toolCallId: "real-sdk-tool", arguments: call });
          event(sessionId, "assistant.message", { messageId: randomUUID(), content: "",
            toolRequests: [{ toolCallId: "real-sdk-tool", name: "run_process", arguments: call }] });
        }
      }, 20);
      return { messageId: randomUUID() };
    });
    connection.onRequest("session.abort", input => { state.aborts.push(input); return {}; });
    connection.onRequest("session.detach", input => { state.detaches.push(input); return { success: true }; });
    connection.onRequest("session.delete", input => { state.deletes.push(input); return { success: true }; });
    connection.onRequest("session.tools.handlePendingToolCall", input => {
      state.callbacks.push({ ...input, afterAbort: state.aborts.some(item => item.sessionId === input.sessionId) });
      return { success: true };
    });
    connection.listen();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `127.0.0.1:${server.address().port}`, state,
    async close() {
      for (const connection of connections) connection.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
module.exports = { localSdkTransport };
