const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { execFileSync } = require("node:child_process");

// Compile only the modules under test in memory; never overwrite shared dist.
function sourceModule(filename, replacements = {}) {
  const target = path.resolve(__dirname, "..", filename);
  const loaded = new Module(target, module);
  loaded.filename = target;
  loaded.paths = Module._nodeModulePaths(path.dirname(target));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => {
    if (Object.hasOwn(replacements, name)) return replacements[name];
    if (name.startsWith(".")) {
      const source = path.resolve(path.dirname(target), `${name}.ts`);
      if (fs.existsSync(source)) return sourceModule(path.relative(path.resolve(__dirname, ".."), source), replacements);
    }
    return originalRequire(name);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(target, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, target);
  return loaded.exports;
}
const lifecycle = sourceModule("src/mcp/mcp-lifecycle.ts");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(__dirname, ".mcp-generation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extension = path.join(root, "extension");
  fs.mkdirSync(path.join(extension, "dist", "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(extension, "resources"), { recursive: true });
  fs.writeFileSync(path.join(extension, "dist", "knowledge", "filestore.js"), 'module.exports = { build: "fixture-build" };');
  fs.writeFileSync(path.join(extension, "resources", "helper.js"), "module.exports = true;");
  fs.writeFileSync(path.join(extension, "package.json"), '{"version":"5.0.0"}');
  return { root, extension, managed: path.join(root, "managed") };
}
const versions = { version: "2.18.0", components: { knowledge: "1.6.0", chat: "2.3.6", recipes: "1.8.2", agent_sessions: "2.0.0" } };
function stage(managed, extension, fail = false) {
  return lifecycle.withManagedMcpGenerationLock(managed, () => lifecycle.stageManagedMcpGeneration(
    managed, extension, versions, directory => {
      fs.writeFileSync(path.join(directory, "feature-domains.json"), JSON.stringify({ enabled: ["knowledge", "automation"] }));
      fs.writeFileSync(path.join(directory, "server.py"), `
import json
from pathlib import Path
print(json.dumps({"generation": Path(__file__).parent.name, "runtime": (Path(__file__).parent / "runtime/dist/knowledge/filestore.js").read_text()}))
`);
      if (fail) throw new Error("generation failed");
    }));
}

test("immutable runtime survives extension removal and launcher follows only committed generation", t => {
  const { root, managed, extension } = fixture(t);
  const first = stage(managed, extension);
  assert.equal(first.runtimeBuild, lifecycle.bundledMcpBuildIdentity(extension));
  assert.equal(lifecycle.readManagedMcpManifest(managed), undefined);
  fs.writeFileSync(path.join(managed, "server.py"), lifecycle.managedMcpLauncher(first));
  lifecycle.publishManagedMcpGeneration(managed, first);
  const python = require("./dev-paths").testPython;
  const launch = () => JSON.parse(execFileSync(python, [path.join(managed, "server.py")], { encoding: "utf8" }));
  assert.equal(launch().generation, first.generation);
  fs.writeFileSync(path.join(managed, "runtime-maintenance.json"), "{}");
  assert.throws(launch, /maintenance/);
  fs.unlinkSync(path.join(managed, "runtime-maintenance.json"));
  assert.throws(() => stage(managed, extension, true), /generation failed/);
  assert.equal(launch().generation, first.generation, "failed generation must preserve predecessor");
  const second = stage(managed, extension);
  assert.equal(launch().generation, first.generation, "staging is not publication");
  lifecycle.publishManagedMcpGeneration(managed, second);
  fs.renameSync(extension, path.join(root, "removed-extension"));
  assert.equal(launch().generation, second.generation);
  assert.match(launch().runtime, /fixture-build/);
  assert(fs.existsSync(path.join(managed, "generations", first.generation, "runtime", "dist", "knowledge", "filestore.js")));
  const file = path.join(managed, "generations", second.generation, "runtime", "dist", "knowledge", "filestore.js");
  fs.appendFileSync(file, "\n// unexpected mutation");
  assert.throws(launch, /integrity mismatch/);
});

test("successor handshake requires actual version, schemas, generation and Skill/Chat tools", t => {
  const { managed, extension } = fixture(t);
  const manifest = stage(managed, extension);
  const tools = ["check_version", "mcp_lifecycle_status", "mcp_lifecycle_quiesce", "add_skill", "update_skill", "delete_skill",
    "knowledge_file_trash", "chat_capabilities", "chat_join", "chat_standby", "chat_post"];
  const version = { ...versions, capabilities: ["managed-lifecycle-v1"], enabled_feature_domains: ["knowledge", "automation"] };
  const runtime = { ...versions, schema: lifecycle.MCP_LIFECYCLE_SCHEMA, generation: manifest.generation, runtimeBuild: manifest.runtimeBuild, phase: "accepting", acceptingNewCalls: true };
  assert.equal(lifecycle.verifyManagedMcpHandshake(manifest, version, runtime, tools).state, "ready");
  for (const bad of [{ ...version, version: "2.17.0" }, { ...version, components: {} },
    { ...version, capabilities: [] }, { ...version, enabled_feature_domains: [] }]) {
    assert.equal(lifecycle.verifyManagedMcpHandshake(manifest, bad, runtime, tools).state, "incompatible");
  }
  for (const bad of [{ ...runtime, generation: "old" }, { ...runtime, phase: "draining" },
    { ...runtime, acceptingNewCalls: false }, { ...runtime, components: {} }, { ...runtime, runtimeBuild: "wrong-build" }]) {
    assert.equal(lifecycle.verifyManagedMcpHandshake(manifest, version, bad, tools).state, "incompatible");
  }
  assert.equal(lifecycle.verifyManagedMcpHandshake(manifest, version, runtime, tools.filter(name => name !== "update_skill")).state, "incompatible");
  assert.equal(lifecycle.verifyManagedMcpHandshake(manifest, version, undefined, tools).state, "reconnect-required");
});

test("connected handshake rejects control changes and discovery failure without replay", async t => {
  const { managed, extension } = fixture(t);
  const first = stage(managed, extension), second = stage(managed, extension);
  lifecycle.publishManagedMcpGeneration(managed, first);
  const tools = ["check_version", "mcp_lifecycle_status", "mcp_lifecycle_quiesce", "add_skill", "update_skill", "delete_skill",
    "knowledge_file_trash", "chat_capabilities", "chat_join", "chat_standby", "chat_post"];
  const version = { ...versions, capabilities: ["managed-lifecycle-v1"], enabled_feature_domains: ["knowledge", "automation"] };
  const runtime = { ...versions, schema: lifecycle.MCP_LIFECYCLE_SCHEMA, generation: first.generation,
    runtimeBuild: first.runtimeBuild, phase: "accepting", acceptingNewCalls: true };
  const calls = [];
  const result = await lifecycle.handshakeManagedMcpConnection(managed, async name => {
    calls.push(name);
    if (name === "check_version") return version;
    lifecycle.publishManagedMcpGeneration(managed, second);
    return runtime;
  }, tools);
  assert.equal(result.state, "incompatible");
  assert.match(result.reason, /changed during/);
  assert.deepEqual(calls.sort(), ["check_version", "mcp_lifecycle_status"]);
  assert.equal((await lifecycle.handshakeManagedMcpConnection(managed, async () => { throw new Error("connection lost"); }, tools)).state, "reconnect-required");
  assert.equal((await lifecycle.handshakeManagedMcpConnection(managed, () => new Promise(() => {}), tools, 10)).state, "reconnect-required");
});

test("compatible publication preserves legacy admission while new launchers select the latest runtime", t => {
  const { managed, extension } = fixture(t);
  const first = stage(managed, extension), second = stage(managed, extension);
  lifecycle.publishManagedMcpGeneration(managed, first);
  lifecycle.publishManagedMcpGeneration(managed, second);
  const baseline = JSON.parse(fs.readFileSync(path.join(managed, "active-generation.json"), "utf8"));
  assert.equal(baseline.generation, first.generation, "old lifecycle code must not see a superseding pointer for compatible APIs");
  assert.equal(baseline.compatibilityBaseline, true);
  assert.equal(lifecycle.readManagedMcpManifest(managed).generation, second.generation);
  assert(lifecycle.managedMcpApiCompatible(first, second));
  const incompatible = { ...second, components:{ ...second.components, knowledge:"2.0.0" },
    compatibility:{ protocol:"pkm.mcp.api/1", components:{ ...second.compatibility.components, knowledge:"2" } } };
  assert.equal(lifecycle.managedMcpApiCompatible(first, incompatible), false);
  lifecycle.publishManagedMcpGeneration(managed, incompatible);
  assert.equal(JSON.parse(fs.readFileSync(path.join(managed, "active-generation.json"), "utf8")).generation, second.generation);
});

test("bounded drain waits for real zero calls and never equates missing/uncertain state with completion", async () => {
  let calls = 2;
  const seen = [];
  const result = await lifecycle.waitForManagedMcpDrain(async name => {
    seen.push(name);
    const inFlight = calls--;
    return { schema: lifecycle.MCP_LIFECYCLE_SCHEMA, generation: "old", acceptingNewCalls: false,
      phase: inFlight ? "draining" : "drained", inFlight, uncertainCalls: 0 };
  }, 100, 1);
  assert.equal(result.state, "drained");
  assert.deepEqual(seen, ["mcp_lifecycle_status", "mcp_lifecycle_status", "mcp_lifecycle_status"]);
  assert.equal((await lifecycle.waitForManagedMcpDrain(async () => undefined, 10)).state, "action-required");
  assert.equal((await lifecycle.waitForManagedMcpDrain(() => new Promise(() => {}), 10)).state, "action-required");
  assert.equal((await lifecycle.waitForManagedMcpDrain(async () => ({
    schema: lifecycle.MCP_LIFECYCLE_SCHEMA, generation: "old", acceptingNewCalls: false,
    phase: "action-required", inFlight: 1, uncertainCalls: 1,
  }), 10, 1)).state, "action-required");
});

test("registry observations never claim a client is ready or stale writes drained", t => {
  const { managed, extension } = fixture(t);
  const manifest = stage(managed, extension);
  lifecycle.publishManagedMcpGeneration(managed, manifest);
  const directory = path.join(managed, "instances");
  fs.mkdirSync(directory);
  const write = record => fs.writeFileSync(path.join(directory, `${"a".repeat(32)}.json`), JSON.stringify({
    schema: lifecycle.MCP_LIFECYCLE_SCHEMA, phase: "drained", inFlight: 0, uncertainCalls:0, ...record,
  }));
  write({ heartbeatAt: 1 });
  let status = lifecycle.managedMcpLifecycleStatus(managed, 10000);
  assert.equal(status.connectionState, "unverified");
  write({ heartbeatAt:10, uncertainCalls:1 });
  assert.equal(lifecycle.managedMcpLifecycleStatus(managed, 10000).instances[0].completionVerified, false);
  assert.equal(status.instances[0].observedState, "unknown");
  assert.equal(status.instances[0].completionVerified, false);
  write({ heartbeatAt: 10 });
  status = lifecycle.managedMcpLifecycleStatus(managed, 10000);
  assert.equal(status.instances[0].completionVerified, true);
  assert.equal(status.connectionState, "unverified");
});

test("actual generated unified FastMCP performs Skill writes from owned runtime after extension removal", async t => {
  const { root, managed, extension } = fixture(t);
  const repository = path.resolve(__dirname, "..");
  // Use existing build outputs, never build or install dependencies from this test.
  fs.cpSync(path.join(repository, "dist"), path.join(extension, "dist"), { recursive: true });
  fs.cpSync(path.join(repository, "resources"), path.join(extension, "resources"), { recursive: true });
  const store = path.join(root, "store");
  fs.mkdirSync(store);
  const configuration = { mcpServerPath: managed, mcpRuntimePath: require("./dev-paths").testVenv };
  const mcp = sourceModule("src/mcp/mcp.ts", {
    vscode: { workspace: { getConfiguration: () => ({ get: (name, fallback) => configuration[name] ?? fallback }) } },
    "../knowledge/filestore": { getStorePath: () => store },
    "../servers/pyenvs": { pyenvList: () => [] },
  });
  const generated = mcp.generateMcpServer({ extensionPath: extension, globalStorageUri: { fsPath: path.join(root, "storage") } });
  const manifest = lifecycle.readManagedMcpManifest(path.dirname(generated.serverPath));
  assert(manifest.runtimeBuild);
  fs.writeFileSync(path.join(extension, "package.json"), '{"version":"4.0.0"}');
  assert.throws(() => mcp.generateMcpServer({ extensionPath: extension, globalStorageUri: { fsPath: path.join(root, "storage") } }), /Refusing to downgrade managed MCP generation/);
  fs.writeFileSync(path.join(extension, "package.json"), '{"version":"5.0.0"}');
  fs.renameSync(extension, path.join(root, "removed-extension"));
  const script = `
import asyncio, json, pathlib, sys
from fastmcp import Client
from fastmcp.client.transports import StdioTransport
async def main():
    async with Client(StdioTransport(sys.executable, [sys.argv[1]], cwd=str(pathlib.Path(sys.argv[1]).parent)), timeout=5) as client:
        tools = [tool.name for tool in await client.list_tools()]
        version = (await client.call_tool("check_version", {})).structured_content
        runtime = (await client.call_tool("mcp_lifecycle_status", {})).structured_content
        added = (await client.call_tool("add_skill", {"name":"owned-runtime", "content":"Original", "category":"Tests"})).structured_content
        updated = (await client.call_tool("update_skill", {"name":"owned-runtime", "content":"Updated through immutable runtime"})).structured_content
        assert added["ok"] and updated["ok"], (added, updated)
        print(json.dumps({"version":version,"runtime":runtime,"tools":tools}))
asyncio.run(main())
`;
  const result = JSON.parse(execFileSync(require("./dev-paths").testPython, ["-c", script, generated.serverPath], {
    encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  }));
  assert.equal(lifecycle.verifyManagedMcpHandshake(manifest, result.version, result.runtime, result.tools).state, "ready");
  let connectManagedChatMcp;
  const originalLoad = Module._load;
  try {
    Module._load = function(name, ...args) {
      return name === "vscode" ? {} : originalLoad.call(this, name, ...args);
    };
    ({ connectManagedChatMcp } = require("../dist/chat/api-chat-mcp"));
  } finally { Module._load = originalLoad; }
  const connection = await connectManagedChatMcp({
    command: require("./dev-paths").testPython, args: [generated.serverPath],
    cwd: path.dirname(generated.serverPath), env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  }, new AbortController().signal, path.dirname(generated.serverPath));
  try {
    assert.equal(connection.generation, manifest.generation);
    await connection.invoke("mcp_pkm_update_skill", { name: "owned-runtime", content: "Updated through Chat managed transport" },
      new AbortController().signal);
  } finally { await connection.close(); }
  const files = fs.readdirSync(path.join(store, "skills", "Tests"));
  assert(files.some(name => name.endsWith(".md") && fs.readFileSync(path.join(store, "skills", "Tests", name), "utf8").includes("Updated through Chat managed transport")));
});
