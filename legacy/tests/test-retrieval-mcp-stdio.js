"use strict";
// PKM_TEST_COMPILED_DIR and PKM_TEST_PYTHON select an isolated compiled runtime.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, spawnSync, fork } = require("node:child_process");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const work = path.join(root, ".migration-test-work/root-upgrade-validation");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(probe, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
}

function host(state) {
  const child = fork(path.join(root, "tests/test-retrieval-managed-hosts.js"), ["--host", state],
    { env: process.env, cwd: root, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  let next = 0;
  const calls = new Map();
  const ready = new Promise((resolve, reject) => {
    child.on("message", msg => {
      if (msg.event === "ready") resolve(msg);
      else if (calls.has(msg.id)) { calls.get(msg.id)(msg); calls.delete(msg.id); }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`Host exited: ${code ?? signal}`));
      for (const resolve of calls.values()) resolve({ error: `Host exited: ${code ?? signal}` });
    });
  });
  return { child, ready, call: command => new Promise(resolve => {
    const id = ++next;
    calls.set(id, resolve);
    child.send({ id, command });
  }) };
}

function generate(fixture, extensionOverride) {
  const store = path.join(fixture, "root"), storage = path.join(fixture, "storage");
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  const mcpRoot = path.join(fixture, "mcp");
  const generation = crypto.randomUUID();
  const directory = path.join(mcpRoot, "generations", generation);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const packaged = extensionOverride || process.env.PKM_TEST_PACKAGED_EXTENSION;
  const source = fs.readFileSync(packaged ? path.join(packaged, "dist/mcp/mcp.js") : path.join(root, "src/mcp/mcp.ts"), "utf8");
  const compiled = packaged ? source.slice(source.indexOf("function generateMcpServerFiles("))
    : ts.transpileModule(source.slice(source.indexOf("export async function generateMcpServer(")), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText;
  const compiler = require(path.join(extensionOverride ? path.join(extensionOverride, "dist") : process.env.PKM_TEST_COMPILED_DIR,
    "mcp/recipe-compiler.js")).ensureRecipeCompiler;
  const scope = {
    exports: { UNIFIED_MCP_VERSION: "1.0.0" }, fs, path, require, process, __dirname: path.join(process.env.PKM_TEST_COMPILED_DIR, "mcp"),
    createHash: crypto.createHash, crypto_1: crypto,
    ensureRecipeCompiler: compiler, recipe_compiler_1: { ensureRecipeCompiler: compiler },
    getStorePath: () => store, filestore_1: { getStorePath: () => store }, managedMcpServerDirectory: () => mcpRoot,
    mcpStatus: () => ({ newerThanExpected: false }),
    configuredMcpFeatureDomains: () => ["knowledge", "automation", "skillRouter"],
    writeMcpFeatureDomainConfig() {}, writeActionWorkspaceConfig() {},
    resolveMcpPython: () => process.env.PKM_TEST_PYTHON,
    mcpStdioCommand: (command, args) => ({ command, args }),
    mcp_stdio_command_1: { mcpStdioCommand: (command, args) => ({ command, args }) },
    UNIFIED_MCP_VERSION: "1.0.0", KNOWLEDGE_MCP_VERSION: "1.0.0", CHAT_MCP_VERSION: "1.0.0",
    RECIPE_MCP_VERSION: "1.0.0", AGENT_SESSION_MCP_VERSION: "1.0.0",
  };
  vm.runInNewContext(compiled, scope);
  scope.generateMcpServerFiles({ extensionPath: packaged || root, globalStorageUri: { fsPath: storage } }, directory);
  const manifest = { schema: "pkm.mcp.lifecycle/v1", generation, managedRoot: mcpRoot,
    version: "1.0.0", components: { knowledge: "1.0.0", chat: "1.0.0", recipes: "1.0.0", agent_sessions: "1.0.0" },
    enabledFeatureDomains: ["knowledge", "automation", "skillRouter"] };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  fs.writeFileSync(path.join(mcpRoot, "active-generation.json"),
    JSON.stringify({ schema: manifest.schema, generation }), { mode: 0o600 });
  const identity = crypto.createHash("sha256").update(path.resolve(store)).digest("hex").slice(0, 16);
  return { server: path.join(directory, "server.py"), state: path.join(storage, "retrieval", identity) };
}

function stdio(server) {
  const child = spawn(process.env.PKM_TEST_PYTHON, [server], { cwd: root,
    env: { ...process.env, PKM_EXPERIMENTAL_RETRIEVAL_OWNER_PROTOCOL: "1", PKM_NODE_EXECUTABLE: process.execPath },
    stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let id = 0;
  const finished = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const msg = JSON.parse(line);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 15000);
      pending.set(requestId, value => { clearTimeout(timer); resolve(value); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
    });
  }
  return { child, finished, call, notify: (method, params = {}) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n") };
}

async function main() {
  if (process.argv[2] !== "--inside") {
    assert(process.env.PKM_TEST_COMPILED_DIR && process.env.PKM_TEST_PYTHON);
    const args = require(path.join(root, "scripts/run-next-trial-private-display")).privateNamespaceArgs(
      [process.execPath, __filename, "--inside"]);
    const result = spawnSync("unshare", args, { cwd: root, env: { ...process.env, TMPDIR: work },
      stdio: "inherit", timeout: 240000 });
    assert.equal(result.status, 0, String(result.error || result.signal));
    return;
  }
  assert.equal(spawnSync("ip", ["link", "set", "lo", "up"]).status, 0);
  const fixture = path.join(work, "retrieval-mcp-stdio-" + crypto.randomUUID());
  fs.mkdirSync(fixture, { recursive: true, mode: 0o700 });
  const generated = generate(fixture);
  fs.mkdirSync(generated.state, { recursive: true, mode: 0o700 });
  const a = host(generated.state), ar = await a.ready;
  const b = host(generated.state), br = await b.ready;
  assert.equal(ar.pid, br.pid);
  const client = stdio(generated.server);
  const initialization = await client.call("initialize", { protocolVersion: "2024-11-05",
    capabilities: {}, clientInfo: { name: "private-fixture", version: "1.0.0" } });
  assert(!initialization.error, JSON.stringify(initialization.error));
  client.notify("notifications/initialized");
  const check = () => client.call("tools/call", { name: "retrieval_status", arguments: {} });
  assert(!(await check()).error);
  assert.equal((await b.call("index")).value.building_revision, "managed-host-test");
  let ready = false;
  for (let n = 0; n < 1200 && !ready; n++) {
    const status = await b.call("status");
    if (status.error) throw new Error(status.error);
    ready = status.value.ready && status.value.corpus_revision === "managed-host-test";
    if (!ready) await pause(100);
  }
  assert(ready, "actual worker index did not finish");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(generated.state, "solution-metrics.sqlite3"));
  db.exec("BEGIN EXCLUSIVE");
  let finishedRead = false;
  try {
    const read = client.call("tools/call", { name: "search_knowledge",
      arguments: { query: "retrieval safety", deadline_ms: 10000 } }).then(value => {
        finishedRead = true;
        return value;
      });
    const instances = path.join(fixture, "mcp", "instances");
    let active = false;
    for (let n = 0; n < 200 && !active; n++) {
      active = fs.existsSync(instances) && fs.readdirSync(instances).filter(name => name.endsWith(".json"))
        .some(name => JSON.parse(fs.readFileSync(path.join(instances, name))).inFlight > 0);
      if (!active) await pause(10);
    }
    assert(active, "MCP did not admit its real retrieval call");
    await pause(100);
    assert.equal((await a.call("close")).value, "shared");
    assert.equal((await b.call("close")).value, "shared");
    assert.equal(finishedRead, false, "retrieval call must still be in flight when both hosts close");
    db.exec("ROLLBACK");
    const result = await read;
    assert(!result.error && !result.result.isError, JSON.stringify(result));
    assert.equal((result.result.structuredContent || JSON.parse(result.result.content[0].text)).ok, true);
  } finally { db.close(); }
  const after = await check();
  assert(!after.error && !after.result.isError, JSON.stringify(after));
  const status = after.result.structuredContent || JSON.parse(after.result.content[0].text);
  assert.equal(status.ok, true, JSON.stringify(status));
  client.child.stdin.end();
  const exit = await Promise.race([client.finished, pause(30000).then(() => ({ timeout: true }))]);
  assert.deepEqual(exit, { code: 0, signal: null });
  let stopped = false;
  for (let i = 0; i < 200; i++) {
    try {
      const stat = fs.readFileSync(`/proc/${ar.pid}/stat`, "utf8");
      if (["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0])) { stopped = true; break; }
    } catch (error) {
      if (error.code === "ENOENT") { stopped = true; break; }
      throw error;
    }
    await pause(25);
  }
  assert(stopped, "last MCP owner must drain and stop the worker");
  const owners = path.join(generated.state, "owners");
  const names = fs.readdirSync(owners);
  assert.equal(names.filter(name => name.endsWith(".open")).length, 3);
  assert.equal(names.filter(name => name.endsWith(".close")).length, 3);
  const second = generate(path.join(fixture, "mcp-crash"));
  fs.mkdirSync(second.state, { recursive: true, mode: 0o700 });
  const crashedHost = host(second.state), crashedEndpoint = await crashedHost.ready;
  const crashed = stdio(second.server);
  const firstInit = await crashed.call("initialize", { protocolVersion: "2024-11-05",
    capabilities: {}, clientInfo: { name: "private-fixture", version: "1.0.0" } });
  assert(!firstInit.error);
  crashed.notify("notifications/initialized");
  assert(!(await crashed.call("tools/call", { name: "retrieval_status", arguments: {} })).error);
  crashed.child.kill("SIGKILL");
  assert.equal((await crashed.finished).signal, "SIGKILL");
  assert.match((await crashedHost.call("close")).error, /unknown/i);
  const restartedHost = host(second.state), restartedEndpoint = await restartedHost.ready;
  assert.equal(restartedEndpoint.pid, crashedEndpoint.pid);
  const restarted = stdio(second.server);
  const secondInit = await restarted.call("initialize", { protocolVersion: "2024-11-05",
    capabilities: {}, clientInfo: { name: "private-fixture", version: "1.0.0" } });
  assert(!secondInit.error);
  restarted.notify("notifications/initialized");
  const restartStatus = await restarted.call("tools/call", { name: "retrieval_status", arguments: {} });
  assert(!restartStatus.error && !restartStatus.result.isError);
  assert.equal((restartStatus.result.structuredContent || JSON.parse(restartStatus.result.content[0].text)).ok, true);
  assert.match((await restartedHost.call("close")).error, /unknown/i);
  restarted.child.stdin.end();
  assert.deepEqual(await Promise.race([restarted.finished, pause(30000).then(() => ({ timeout: true }))]),
    { code: 0, signal: null });
  assert(fs.existsSync(`/proc/${crashedEndpoint.pid}/stat`), "crashed owner must retain the worker");
  if (process.env.PKM_TEST_LEGACY_EXTENSION) {
    const legacy = process.env.PKM_TEST_LEGACY_EXTENSION;
    const original = generate(path.join(fixture, "original-stdio"), legacy);
    fs.mkdirSync(original.state, { recursive: true, mode: 0o700 });
    const OldManager = require(path.join(legacy, "dist/retrieval/retrieval-worker.js")).RetrievalWorkerManager;
    const NewManager = require(process.env.PKM_TEST_COMPILED).RetrievalWorkerManager;
    const oldWorker = new OldManager(original.state, path.join(legacy, "resources/retrieval_worker.py"),
      process.env.PKM_TEST_PYTHON, "0.3.0.dev2026100504");
    const oldEndpoint = await oldWorker.ensure();
    const snapshot = { corpus_revision: "old-mcp-index", documents: [{
      skill_id: "note:legacy", source_id: "note:legacy", title: "Original fixture",
      body: "Distinct legacy retrieval content", content_type: "note", source_uri: "pkm://notes/legacy",
      metadata: {}, provenance: { provider: "pkm" },
    }] };
    await oldWorker.index(snapshot);
    await waitFor(async () => (await oldWorker.status()).corpus_revision === snapshot.corpus_revision,
      "original worker index");
    const oldClient = stdio(original.server);
    const originalInit = await oldClient.call("initialize", { protocolVersion: "2024-11-05",
      capabilities: {}, clientInfo: { name: "original-client-fixture", version: "1.0.0" } });
    assert(!originalInit.error);
    oldClient.notify("notifications/initialized");
    const originalSearch = () => oldClient.call("tools/call", {
      name: "search_knowledge", arguments: { query: "distinct legacy retrieval" },
    });
    const before = await originalSearch();
    assert.equal((before.result.structuredContent || JSON.parse(before.result.content[0].text)).ok, true);
    let ordinaryNotices = 0;
    const ordinary = new NewManager(original.state, path.join(process.env.PKM_TEST_RESOURCES, "retrieval_worker.py"),
      process.env.PKM_TEST_PYTHON, "0.3.0.dev2026100504", undefined, undefined, undefined,
      () => { ordinaryNotices++; });
    assert.equal((await ordinary.ensure()).pid, oldEndpoint.pid);
    assert.equal((await ordinary.search("distinct legacy retrieval")).ok, true);
    await assert.rejects(ordinary.index(snapshot), /read-only/i);
    assert(ordinaryNotices > 0, "ordinary activation must explain the preserved legacy worker");
    const ordinaryAfter = await originalSearch();
    assert(!ordinaryAfter.error && !ordinaryAfter.result.isError, JSON.stringify(ordinaryAfter));
    assert.equal((await oldWorker.ensure()).pid, oldEndpoint.pid);
    const stat = fs.readFileSync("/proc/self/stat", "utf8");
    const next = new NewManager(original.state, path.join(process.env.PKM_TEST_RESOURCES, "retrieval_worker.py"),
      process.env.PKM_TEST_PYTHON, "0.3.0.dev2026100504", undefined, undefined,
      { hostId: crypto.randomUUID(), pid: process.pid, startTimeTicks: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] });
    assert.equal((await next.ensure()).pid, oldEndpoint.pid);
    assert.equal((await next.search("distinct legacy retrieval")).ok, true);
    await assert.rejects(next.index(snapshot), /read-only/i);
    assert.equal(await next.closeOwned(), "unused");
    const after = await originalSearch();
    assert.equal((after.result.structuredContent || JSON.parse(after.result.content[0].text)).ok, true);
    oldClient.child.stdin.end();
    assert.deepEqual(await Promise.race([oldClient.finished, pause(30000).then(() => ({ timeout: true }))]),
      { code: 0, signal: null });
    assert.equal((await oldWorker.ensure()).pid, oldEndpoint.pid);
  }
  console.log(JSON.stringify({ fixture, generatedStdioMcp: true, twoHostProcesses: true,
    bothHostsClosedShared: true, realMcpReadInFlightAtHostExit: true,
    mcpRetrievalAfterHostExit: true, stdioEof: "clean", workerExited: true,
    killedMcpOwner: "unknown", reconnectedMcpReads: true, crashWorkerRetainedUntilNamespaceExit: true,
    original4022StdioContinuesWithReadOnlyCandidate: !!process.env.PKM_TEST_LEGACY_EXTENSION,
    ordinaryHostPreservesOriginalWorker: !!process.env.PKM_TEST_LEGACY_EXTENSION }));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
