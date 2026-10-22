const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const originalLoad = Module._load;
let connectManagedChatMcp, createVscodeTools;
try {
  Module._load = function(name, ...args) {
    return name === "vscode" ? {} : originalLoad.call(this, name, ...args);
  };
  ({ connectManagedChatMcp, createVscodeTools } = require("../dist/chat/api-chat-mcp"));
} finally { Module._load = originalLoad; }

const service = `
const fs = require("node:fs");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const server = new Server({ name: "pkm-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "list_notes", description: "List notes", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "update_note", description: "Update a note", inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "wait", description: "Wait", inputSchema: { type: "object" } },
  { name: "fail", description: "Fail", inputSchema: { type: "object" } }
] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name === "wait") return new Promise(() => {});
  if (params.name === "fail") return { isError: true, content: [{ type: "text", text: "fixture failure" }] };
  if (params.name === "update_note") fs.writeFileSync(process.argv[1], params.arguments.content);
  return { content: [{ type: "text", text: fs.readFileSync(process.argv[1], "utf8") }] };
});
server.connect(new StdioServerTransport());
`;

test("managed PKM list/update execute through MCP without native confirmations, retain approvals and reject replay", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-managed-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const note = path.join(directory, "note.txt");
  fs.writeFileSync(note, "Original note");
  const lifetime = new AbortController();
  const connection = await connectManagedChatMcp({
    command: process.execPath, args: ["-e", service, note], cwd: path.resolve(__dirname, ".."),
  }, lifetime.signal);
  t.after(() => connection.close());
  const calls = [];
  let permit = true;
  const nativeCalls = [];
  const host = { workspace: { isTrusted: true }, lm: {
    tools: [{ name: "mcp_pkm_list_notes", description: "Native entry must not be used" }],
    invokeTool: async (...args) => { nativeCalls.push(args); throw new Error("Native confirmation must not be reached"); },
  } };
  const signal = new AbortController().signal;
  const make = names => createVscodeTools(names, host, async (name, input, requestSignal, hints) => {
    calls.push({ name, input, hints });
    if (!permit) throw new Error("Inline permission denied");
  }, undefined, connection);
  const tools = make(["mcp_pkm_list_notes", "mcp_pkm_update_note", "mcp_pkm_fail"]);
  await tools[0].execute({ query: "notes" }, signal);
  await assert.rejects(tools[1].execute({ name: "mcp_pkm_update_note", input: { content: "Denied" } }, signal), /Find an enabled tool/);
  await tools[0].execute({ query: "update_note" }, signal);
  permit = false;
  await assert.rejects(tools[1].execute({ name: "mcp_pkm_update_note", input: { content: "Denied" } }, signal), /Inline permission denied/);
  assert.equal(fs.readFileSync(note, "utf8"), "Original note");
  permit = true;
  const read = await tools[1].execute({ name: "mcp_pkm_list_notes", input: {} }, signal);
  assert.match(read, /Original note/);
  assert.equal(calls.at(-1).hints.readOnlyHint, true);
  await tools[1].execute({ name: "mcp_pkm_update_note", input: { content: "Organized note" } }, signal);
  assert.equal(fs.readFileSync(note, "utf8"), "Organized note");
  await assert.rejects(tools[1].execute({ name: "mcp_pkm_update_note", input: { content: "Organized note" } }, signal), /Duplicate/);
  await tools[0].execute({ query: "fail" }, signal);
  await assert.rejects(tools[1].execute({ name: "mcp_pkm_fail", input: {} }, signal), /fixture failure/);
  host.workspace.isTrusted = false;
  await assert.rejects(make(["mcp_pkm_list_notes"])[1].execute({ name: "mcp_pkm_list_notes", input: {} }, signal), /trusted/);
  assert.equal(nativeCalls.length, 0);
  assert.throws(() => make(["mcp_pkm_missing"]), /unavailable/);
});

test("cancelling a managed MCP wait returns promptly without replaying or hanging on close", async t => {
  const lifetime = new AbortController();
  const connection = await connectManagedChatMcp({
    command: process.execPath, args: ["-e", service, "unused"], cwd: path.resolve(__dirname, ".."),
  }, lifetime.signal);
  t.after(() => connection.close());
  const controller = new AbortController();
  const pending = connection.invoke("mcp_pkm_wait", {}, controller.signal);
  const started = Date.now();
  controller.abort();
  await assert.rejects(pending, /cancelled|aborted/i);
  assert(Date.now() - started < 250);
});

test("directory reads use the builtin instead of exposing a duplicate native confirmation path", () => {
  const { chatToolGroups } = require("../dist/chat/tool-selection");
  const builtins = [{ name: "list_directory", label: "List directory", permission: "Chat permissions" }];
  const native = [{ name: "copilot_listDirectory", description: "Native directory tool" }, { name: "pylanceRunCodeSnippet", description: "Unrelated native tool" }];
  const chat = { permissionMode: "allow-all" };
  let groups = chatToolGroups(chat, builtins, native);
  assert(groups[0].tools[0].enabled);
  assert(!groups.some(group => group.tools.some(tool => tool.name === "copilot_listDirectory")));
  assert(groups.some(group => group.tools.some(tool => tool.name === "pylanceRunCodeSnippet")));
  chat.builtinTools = [];
  groups = chatToolGroups(chat, builtins, native);
  assert(groups.some(group => group.tools.some(tool => tool.name === "copilot_listDirectory" && tool.enabled)));
});
