import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startMcp } from "../dist/mcp.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actor = { id: "reader", canWrite: false };
const chatId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("original API Chat source oracle declares the bounded read-only family", async () => {
  const source = await readFile(resolve(root, "../resources/api_chat_control.py"), "utf8");
  for (const name of ["api_chat_capabilities", "api_chat_models", "api_chat_list", "api_chat_get", "api_chat_request_get"]) {
    assert.match(source, new RegExp(`def ${name}\\(`));
    const declaration = source.slice(source.indexOf(`def ${name}(`) - 100, source.indexOf(`def ${name}(`));
    assert.match(declaration, /@mcp\.tool\(annotations=\{"readOnlyHint": True\}\)/);
  }
  assert.match(source, /def api_chat_list\(host_id: str, command_id: str = "", group_path: str = "", offset: int = 0, limit: int = 100\)/);
  assert.match(source, /def api_chat_request_get\(host_id: str, request_id: str\)/);
});

test("API Chat read tools use the local native Chat and model read APIs only", async t => {
  const calls = [];
  const session = {
    schema: "pkm.chat.session/v1", id: chatId, title: "Native chat", revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z",
    archivedAt: null, messageCount: 1, lastSequence: 1,
    metadata: { schema: "pkm.chat.session-metadata/v1", sessionId: "native-session" },
    generation: "unavailable", replay: "never",
  };
  const message = {
    schema: "pkm.chat.message/v1", id: "answer", sequence: 1, receivedAt: "2026-01-01T00:01:00.000Z",
    role: "assistant", content: "Safe answer", status: "complete", model: "configured-model",
    replay: "never", toolCalls: [{ id: "tool-1", name: "read_file", arguments: "secret payload", status: "complete", result: "secret result" }],
  };
  const data = {
    "chat.session.capabilities": { schema: "pkm.chat.session.capabilities/v1", generation: "unavailable", replay: "never" },
    "chat.session.list": { items: [session], nextCursor: null },
    "chat.session.get": session,
    "chat.session.messages": { id: chatId, revision: 1, items: [message], nextCursor: "cursor", hasMore: false, lastSequence: 1, replay: "never" },
    "model.config.catalog": {
      schema: "pkm.model-config.catalog/v1",
      providers: [
        { provider: "vscode", status: "configured", profiles: [{ id: "vscode:model", label: "Local model", status: "active", contextWindow: 8192, maxOutputTokens: 1024 }] },
        { provider: "openai-compatible", status: "configured", profiles: [{ id: "sk-secret", label: "secret", status: "active", contextWindow: 8192, maxOutputTokens: 1024 }] },
      ],
    },
  };
  const core = {
    async dispatch(method, input) {
      if (method === "server_info") return { result: { workspaceId } };
      assert.equal(method, "capability_read");
      calls.push(input.operation);
      if (!(input.operation in data)) return { error: { code: "NOT_FOUND", message: "Unavailable." } };
      return { result: data[input.operation] };
    },
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startMcp(core, actor, serverTransport);
  const client = new Client({ name: "api-chat-read-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await server.close(); });
  await client.connect(clientTransport);

  const catalog = await client.listTools();
  const names = catalog.tools.map(tool => tool.name);
  for (const name of ["api_chat_capabilities", "api_chat_models", "api_chat_list", "api_chat_get", "api_chat_request_get"])
    assert(names.includes(name));
  for (const name of ["api_chat_create", "api_chat_send", "api_chat_cancel"])
    assert(!names.includes(name));
  for (const name of ["api_chat_capabilities", "api_chat_models", "api_chat_list", "api_chat_get", "api_chat_request_get"]) {
    const tool = catalog.tools.find(item => item.name === name);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, false);
  }

  const capabilities = await client.callTool({ name: "api_chat_capabilities", arguments: {} });
  const hostId = capabilities.structuredContent.hosts[0].host_id;
  assert.equal(hostId, workspaceId);
  assert.deepEqual(capabilities.structuredContent.hosts[0].workspace_paths, []);
  assert.match(capabilities.structuredContent.policy, /No external provider/);

  const modelResult = await client.callTool({ name: "api_chat_models", arguments: { host_id: hostId } });
  assert.deepEqual(modelResult.structuredContent.models, [{
    id: "vscode:model", label: "Local model", contextWindow: 8192, maxOutputTokens: 1024,
  }]);

  const listResult = await client.callTool({ name: "api_chat_list", arguments: { host_id: hostId } });
  assert.equal(listResult.structuredContent.total, 1);
  assert.equal(listResult.structuredContent.chats[0].chatUrl, `pkm://chats/${workspaceId.replaceAll("-", "").slice(0, 16)}/${chatId}`);

  const getResult = await client.callTool({ name: "api_chat_get", arguments: {
    host_id: hostId, chat_id: listResult.structuredContent.chats[0].chatUrl,
  } });
  assert.equal(getResult.structuredContent.reply.content, "Safe answer");
  assert.deepEqual(getResult.structuredContent.reply.tools, [{ name: "read_file", status: "complete" }]);
  assert.equal(JSON.stringify(getResult.structuredContent).includes("secret payload"), false);
  assert.equal(JSON.stringify(getResult.structuredContent).includes("secret result"), false);

  const requestResult = await client.callTool({ name: "api_chat_request_get", arguments: {
    host_id: hostId, request_id: "c".repeat(64),
  } });
  assert.equal(requestResult.isError, true);
  assert.match(requestResult.content[0].text, /No native original API Chat request-receipt store/);

  const wrongHost = await client.callTool({ name: "api_chat_list", arguments: {
    host_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  } });
  assert.equal(wrongHost.isError, true);
  const unsupportedGroup = await client.callTool({ name: "api_chat_list", arguments: {
    host_id: hostId, group_path: "chat_group_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  } });
  assert.equal(unsupportedGroup.isError, true);
  assert(!calls.some(operation => ["chat.session.create", "chat.session.append", "chat.session.archive", "chat.turn.start"].includes(operation)));
});
