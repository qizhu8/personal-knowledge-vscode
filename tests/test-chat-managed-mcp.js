const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
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
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const legacy = process.argv[3] === "legacy";
const identityMismatch = process.argv[3] === "wrongbuild";
let fenced = false;
let inFlight = 0;
let quiesceCalls = 0;
let discoveryPages = 0;
const status = () => ({ ...manifest, phase: fenced ? (inFlight ? "draining" : "drained") : "accepting",
  runtimeBuild: identityMismatch ? "b".repeat(64) : manifest.runtimeBuild,
  acceptingNewCalls: !fenced, inFlight, uncertainCalls: 0 });
const server = new Server({ name: "pkm-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
if (process.argv[3] === "slow-discovery") {
  fs.writeFileSync(process.argv[1] + ".discovery-pages", String(++discoveryPages));
  await new Promise(resolve => setTimeout(resolve, 120));
  return { tools: [], nextCursor: String(discoveryPages) };
}
return { tools: [
  { name: "check_version", inputSchema: { type: "object" } },
  ...(!legacy ? ["mcp_lifecycle_status", "mcp_lifecycle_quiesce"].map(name => ({ name, inputSchema: { type: "object" } })) : []),
  { name: "list_notes", description: "List notes", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "update_note", description: "Update a note", inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "wait", description: "Wait", inputSchema: { type: "object" } },
  { name: "fail", description: "Fail", inputSchema: { type: "object" } }
] }; });
server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
  const result = value => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  if (params.name === "check_version") return result({ version: manifest.version, components: manifest.components,
    enabled_feature_domains: [], capabilities: legacy ? [] : ["managed-lifecycle-v1"] });
  if (params.name === "mcp_lifecycle_status") return result(status());
  if (params.name === "mcp_lifecycle_quiesce") {
    fenced = true;
    if (process.argv[3] === "slow-quiesce" && quiesceCalls++ === 0) {
      extra.signal.addEventListener("abort", () => fs.writeFileSync(process.argv[1] + ".control-cancelled", ""));
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return result(status());
  }
  if (fenced) return { isError: true, content: [{ type: "text", text: "runtime superseded" }] };
  inFlight++;
  try {
    if (params.name === "wait") { await new Promise(resolve => setTimeout(resolve, 100)); return result({ ok: true }); }
    if (params.name === "fail") return { isError: true, content: [{ type: "text", text: "fixture failure" }] };
    if (params.name === "update_note") fs.writeFileSync(process.argv[1], params.arguments.content);
    return { content: [{ type: "text", text: fs.readFileSync(process.argv[1], "utf8") }] };
  } finally { inFlight--; }
});
server.connect(new StdioServerTransport());
`;

const pythonService = `
import asyncio, json, sys, time
from pathlib import Path
from fastmcp import FastMCP
sys.path.insert(0, sys.argv[2])
from mcp_call_guard import ManagedMcpLifecycle
manifest = json.loads(Path(sys.argv[1]).read_text())
root = Path(manifest["managedRoot"])
(root / "pid").write_text(str(__import__("os").getpid()))
lifecycle = ManagedMcpLifecycle(manifest, drain_seconds=0.15, poll_seconds=0.02)
server = FastMCP("actual-chat-lifecycle")
server.add_middleware(lifecycle)
@server.tool()
def check_version() -> dict:
    return {"version": manifest["version"], "components": manifest["components"],
        "enabled_feature_domains": [], "capabilities": ["managed-lifecycle-v1"]}
@server.tool()
def mcp_lifecycle_status() -> dict:
    return lifecycle.status()
@server.tool()
def mcp_lifecycle_quiesce() -> dict:
    return lifecycle.quiesce()
@server.tool()
async def list_notes() -> dict:
    return {"ok": True}
@server.tool()
def write(key: str) -> dict:
    (root / (key + ".started")).write_text("started")
    while not (root / (key + ".release")).exists():
        time.sleep(0.01)
    with (root / "writes").open("a") as stream:
        stream.write(key + "\\n")
    return {"ok": True}
server.run(show_banner=False)
`;

function managedFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(__dirname, ".chat-managed-"));
  const connections = [];
  const note = path.join(directory, "note.txt");
  fs.writeFileSync(note, "Original note");
  const publish = (overrides = {}) => {
    const generation = randomUUID();
    const manifest = {
      schema: "pkm.mcp.lifecycle/v1", generation, managedRoot: directory,
      version: "2.18.0", extensionVersion: "3.2.87", runtimeBuild: "a".repeat(64),
      components: { knowledge: "1.6.0", chat: "2.3.6", recipes: "1.8.2", agent_sessions: "2.0.0" },
      node: process.execPath, enabledFeatureDomains: [], files: {},
      ...overrides,
    };
    const generationDirectory = path.join(directory, "generations", generation);
    fs.mkdirSync(generationDirectory, { recursive: true });
    const manifestPath = path.join(generationDirectory, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const pending = path.join(directory, "active.pending");
    fs.writeFileSync(pending, JSON.stringify({ schema: manifest.schema, generation }));
    fs.renameSync(pending, path.join(directory, "active-generation.json"));
    return { manifest, manifestPath };
  };
  let active = publish();
  t.after(async () => {
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".started"))) {
      fs.writeFileSync(path.join(directory, name.replace(/\.started$/, ".release")), "");
    }
    for (const connection of connections.reverse()) await connection.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory, note, get active() { return active; },
    publish(overrides) { active = publish(overrides); return active; },
    async connect(signal = new AbortController().signal, closeOptions) {
      const launch = options.python ? {
        command: require("./dev-paths").testPython,
        args: ["-c", pythonService, active.manifestPath, path.resolve(__dirname, "../resources")],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      } : { command: process.execPath, args: ["-e", service, note, active.manifestPath,
        options.legacy ? "legacy" : options.identityMismatch ? "wrongbuild" : options.slowQuiesce ? "slow-quiesce" : options.slowDiscovery ? "slow-discovery" : ""] };
      const connection = await connectManagedChatMcp({ ...launch, cwd: path.resolve(__dirname, "..") },
        signal, directory, closeOptions);
      connections.push(connection);
      return connection;
    },
  };
}

test("managed discovery has one total deadline across unique empty pages", async t => {
  const fixture = managedFixture(t, { slowDiscovery: true });
  const startedAt = Date.now();
  await assert.rejects(fixture.connect(undefined, { discoveryTimeoutMs: 1500 }), /discovery deadline exceeded/);
  assert(Date.now() - startedAt < 3000, "per-page SDK timeouts cannot multiply the total discovery budget");
  assert(Number(fs.readFileSync(fixture.note + ".discovery-pages", "utf8")) >= 2);
  assert.equal(fs.readFileSync(fixture.note, "utf8"), "Original note", "timed-out discovery invokes no content tools");
});

async function waitForFile(filename) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(filename)) {
    if (Date.now() >= deadline) throw new Error(`Fixture did not produce ${path.basename(filename)}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("managed PKM list/update execute through MCP without native confirmations, retain approvals and reject replay", async t => {
  const fixture = managedFixture(t);
  const note = fixture.note;
  const lifetime = new AbortController();
  const connection = await fixture.connect(lifetime.signal);
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

test("PKM tool discovery is local, selected-only and cancellable without native search or embeddings", async () => {
  const unexpected = [];
  const forbidden = name => async () => { unexpected.push(name); throw new Error(`Unexpected ${name}`); };
  const host = {
    workspace: { isTrusted: true },
    LanguageModelTextPart: class {},
    commands: { executeCommand: forbidden("command/server start") },
    lm: {
      tools: [{ name: "unselected_native_tool", description: "List notes" }],
      invokeTool: forbidden("native invocation"),
      computeEmbeddings: forbidden("native embeddings"),
    },
  };
  const managed = {
    catalog: Array.from({ length: 8 }, (_, index) => ({
      name: `mcp_pkm_note_${index}`, description: "List notes",
      inputSchema: { type: "object", properties: { category: { type: "string" } } },
    })),
    invoke: forbidden("managed invocation"),
  };
  const tools = createVscodeTools(managed.catalog.slice(0, 7).map(tool => tool.name), host,
    forbidden("permission prompt"), undefined, managed);
  const signal = new AbortController().signal;
  const first = JSON.parse(await tools[0].execute({ query: "notes" }, signal));
  assert.equal(first.total, 7);
  assert.equal(first.nextOffset, 6);
  assert.deepEqual(first.tools.map(tool => tool.name), managed.catalog.slice(0, 6).map(tool => tool.name));
  assert.deepEqual(first.tools[0].inputSchema, managed.catalog[0].inputSchema);
  const last = JSON.parse(await tools[0].execute({ query: "notes", offset: first.nextOffset }, signal));
  assert.deepEqual(last.tools.map(tool => tool.name), ["mcp_pkm_note_6"]);
  assert.equal(last.nextOffset, null);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(tools[0].execute({ query: "notes" }, cancelled.signal), /cancelled/);
  assert.deepEqual(unexpected, [], "Discovery must not invoke tools, request embeddings, start servers or prompt.");
});

test("cancelling a managed MCP wait returns promptly without replaying or hanging on close", async t => {
  const fixture = managedFixture(t);
  const lifetime = new AbortController();
  const connection = await fixture.connect(lifetime.signal);
  const controller = new AbortController();
  const pending = connection.invoke("mcp_pkm_wait", {}, controller.signal);
  const started = Date.now();
  controller.abort();
  await assert.rejects(pending, /cancelled|aborted/i);
  assert(Date.now() - started < 250);
});

test("managed Chat verifies the actual connected production generation and hides its private quiesce control", async t => {
  const fixture = managedFixture(t, { python: true });
  const connection = await fixture.connect();
  assert.equal(connection.generation, fixture.active.manifest.generation);
  assert(connection.catalog.some(tool => tool.name === "mcp_pkm_check_version"));
  assert(!connection.catalog.some(tool => tool.name === "mcp_pkm_mcp_lifecycle_quiesce"));
  await connection.invoke("mcp_pkm_list_notes", {}, new AbortController().signal);
});

test("same-version legacy runtime is rejected before any content tool can execute", async t => {
  const fixture = managedFixture(t, { legacy: true });
  await assert.rejects(fixture.connect(), /verification|lifecycle|reconnect/i);
  assert.equal(fs.readFileSync(fixture.note, "utf8"), "Original note");
});

test("same-version same-generation runtime with a different actual build is rejected", async t => {
  const fixture = managedFixture(t, { identityMismatch: true });
  await assert.rejects(fixture.connect(), /differs|incompatible/i);
  assert.equal(fs.readFileSync(fixture.note, "utf8"), "Original note");
});

test("compatible generation update keeps the old Chat catalog usable without reconnect or replay", async t => {
  const fixture = managedFixture(t);
  const old = await fixture.connect();
  const previous = old.generation;
  fixture.publish();
  assert.notEqual(fixture.active.manifest.generation, previous);
  await old.invoke("mcp_pkm_update_note", { content: "Compatible old session" }, new AbortController().signal);
  assert.equal(fs.readFileSync(fixture.note, "utf8"), "Compatible old session");
  await old.close();
  const successor = await fixture.connect();
  assert.equal(successor.generation, fixture.active.manifest.generation);
  await successor.invoke("mcp_pkm_update_note", { content: "Explicit successor call" }, new AbortController().signal);
  assert.equal(fs.readFileSync(fixture.note, "utf8"), "Explicit successor call");
});

test("incompatible component API still fences the old Chat before sending a write", async t => {
  const fixture = managedFixture(t);
  const old = await fixture.connect();
  fixture.publish({ components:{ ...fixture.active.manifest.components, knowledge:"2.0.0" } });
  await assert.rejects(old.invoke("mcp_pkm_update_note", { content:"Must not be sent" },
    new AbortController().signal), /incompatible|reconnect/);
  assert.equal(fs.readFileSync(fixture.note, "utf8"), "Original note");
  await old.close();
});

test("lifetime cancellation fences local admission and drains an actual FastMCP threaded write before close", async t => {
  const fixture = managedFixture(t, { python: true });
  const lifetime = new AbortController();
  const connection = await fixture.connect(lifetime.signal);
  const request = new AbortController();
  const pending = connection.invoke("mcp_pkm_write", { key: "uncertain" }, request.signal);
  await waitForFile(path.join(fixture.directory, "uncertain.started"));
  request.abort();
  await assert.rejects(pending, /cancelled|aborted|Do not retry/);
  lifetime.abort();
  await assert.rejects(connection.invoke("mcp_pkm_list_notes", {}, new AbortController().signal), /closing/);
  let closed = false;
  const closing = connection.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(closed, false, "A cancelled caller does not prove a threaded write finished.");
  const pid = Number(fs.readFileSync(path.join(fixture.directory, "pid"), "utf8"));
  assert.doesNotThrow(() => process.kill(pid, 0), "Owned child must remain alive during actual drain.");
  fs.writeFileSync(path.join(fixture.directory, "uncertain.release"), "");
  await closing;
  assert.equal(fs.readFileSync(path.join(fixture.directory, "writes"), "utf8"), "uncertain\n");
});

test("bounded close timeout leaves uncertain writes alive and action-required, then allows explicit drain retry", async t => {
  const fixture = managedFixture(t, { python: true });
  const connection = await fixture.connect(undefined, { drainTimeoutMs: 100 });
  const pending = connection.invoke("mcp_pkm_write", { key: "bounded" }, new AbortController().signal);
  await waitForFile(path.join(fixture.directory, "bounded.started"));
  await assert.rejects(connection.close(), /action-required|expired|unknown/i);
  const pid = Number(fs.readFileSync(path.join(fixture.directory, "pid"), "utf8"));
  assert.doesNotThrow(() => process.kill(pid, 0));
  await assert.rejects(connection.invoke("mcp_pkm_write", { key: "replayed" }, new AbortController().signal), /closing/);
  fs.writeFileSync(path.join(fixture.directory, "bounded.release"), "");
  await pending;
  await connection.close();
  assert.equal(fs.readFileSync(path.join(fixture.directory, "writes"), "utf8"), "bounded\n");
  assert(!fs.existsSync(path.join(fixture.directory, "replayed.started")));
});

test("drain observation deadline does not send cancellation to a delayed lifecycle control", async t => {
  const fixture = managedFixture(t, { slowQuiesce:true });
  const connection = await fixture.connect(undefined, { drainTimeoutMs:100 });
  const started = Date.now();
  await assert.rejects(connection.close(), /action-required|expired|timed out/i);
  assert(Date.now() - started < 1000, "Observation must return without waiting for remote control completion");
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(fs.existsSync(fixture.note + ".control-cancelled"), false,
    "An observation deadline is not permission to cancel the server's lifecycle request");
  await assert.rejects(connection.invoke("mcp_pkm_update_note", { content:"Must remain fenced" },
    new AbortController().signal), /closing/);
  assert.equal(fs.readFileSync(fixture.note, "utf8"), "Original note");
  await connection.close();
});

test("Chat managed discovery keys its reuse boundary by generation and disposes through safe close", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/chat/api-chat-view.ts"), "utf8");
  assert.match(source, /connection\.generation === generation/);
  assert.match(source, /connectManagedChatMcp\(launch, controller\.signal, managedMcpServerDirectory\(\)\)/);
  assert.match(source, /await old\.connection\.close\(\);\s*old\.controller\.abort\(\)/);
  assert.match(source, /managed\.connection\.close\(\)\.then\(\(\) => managed\.controller\.abort\(\)\)/);
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
