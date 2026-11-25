import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DeploymentIntegrity } from "../dist/deployment-integrity.js";
import { auditDeployment, buildDeploymentCore, readStartupReceipt, stagedValidationMode,
  startupCodeFiles, startupControlFiles } from "../dist/deployment-integrity-worker.js";
import { isolatedManagedLaunch, verifyIsolatedManagedGeneration } from "../experimental/managed-launch-client.mjs";
import { startNativePublicOwnerMcp } from "../dist/native-public-mcp-owner.js";
import { RootOwner } from "../dist/root-owner.js";
import { initialize } from "../dist/storage.js";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const launcher = await fs.readFile(new URL("../experimental/managed-launcher.py", import.meta.url));
const python = spawnSync("python3", ["-I", "-S", "-c", "import pathlib,sys; print(pathlib.Path(sys.executable).resolve())"],
  { encoding: "utf8", timeout: 10000 });
assert.equal(python.status, 0, python.stderr);
const realPython = python.stdout.trim();
let pythonHash;
let nodeHash;
async function fixture(t, { actualPython = false, actualData = false, actualNode = false } = {}) {
  const parent = resolve("tests", `.deployment-integrity-${randomUUID()}`);
  await fs.mkdir(parent, { mode: 0o700 });
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = join(parent, "managed"), generation = randomUUID();
  const directory = join(root, "generations", generation), runtime = join(directory, "runtime/next-server");
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  for (const name of startupCodeFiles) {
    const target = join(runtime, name);
    await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(resolve("dist", name.slice(5)), target);
  }
  await fs.writeFile(join(runtime, "package.json"), '{"type":"module","runtimeMcpFacade":"native-v1"}');
  await fs.writeFile(join(runtime, "deployment-core.json"), JSON.stringify(buildDeploymentCore(runtime)));
  await fs.mkdir(join(runtime, "browser"));
  await fs.writeFile(join(runtime, "browser/bootstrap.mjs"), "// Unused native-MCP browser resource.\n");
  await fs.mkdir(join(runtime, "node_modules"));
  await fs.writeFile(join(runtime, "node_modules/pending.bin"), Buffer.alloc(512 * 1024, 17));
  const fakeNode = join(parent, "node-observer");
  await fs.writeFile(fakeNode, `#!${realPython}\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n`, { mode: 0o700 });
  const fakePython = join(parent, "python-identity");
  await fs.writeFile(fakePython, "Unit fixture interpreter identity; never executed.\n", { mode: 0o700 });
  const interpreters = {
    node: { path: actualNode ? process.execPath : fakeNode,
      sha256: actualNode ? await (nodeHash ??= fs.readFile(process.execPath).then(hash)) : hash(await fs.readFile(fakeNode)) },
    python: { path: actualPython ? realPython : fakePython,
      sha256: actualPython ? await (pythonHash ??= fs.readFile(realPython).then(hash)) : hash(await fs.readFile(fakePython)) },
  };
  const data = actualData ? await initialize(join(parent, "workspace")) : join(parent, "workspace");
  if (!actualData) {
    await fs.mkdir(data);
    await fs.writeFile(join(data, ".pkm-next-workspace"), '{"schema":"pkm.next-workspace/v2"}');
  }
  const platform = { interpreters, launcherSha256: hash(launcher), pythonDistributions: [], pythonDependencyProfile: "fastmcp" };
  await fs.writeFile(join(directory, "launch.json"), JSON.stringify({ data, allowWrites: false }));
  await fs.writeFile(join(directory, "platform.json"), JSON.stringify(platform));
  await fs.writeFile(join(directory, "python-dependencies.json"), '{"profile":"fastmcp","distributions":{}}');
  await fs.mkdir(join(runtime, "compat"));
  await fs.writeFile(join(runtime, "compat/legacy-compact-mcp.py"), 'print("unit legacy compatibility")\n');
  const files = {};
  async function inventory(path, prefix = "") {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      const local = prefix + entry.name, full = join(path, entry.name);
      if (entry.isDirectory()) await inventory(full, local + "/");
      else files[local] = hash(await fs.readFile(full));
    }
  }
  await inventory(directory);
  const runtimeBuild = hash(Object.keys(files).sort().map(name => `${name}\0${files[name]}\0`).join(""));
  const identity = {
    schema: "pkm.mcp.lifecycle/v1", managedRoot: root, generation, version: "0.1.0", extensionVersion: "0.1.0",
    experimental: true, components: { knowledge: "0.1.0", chat: "0.1.0", recipes: "0.1.0", agent_sessions: "0.1.0" },
    enabledFeatureDomains: [], runtimeBuild, node: interpreters.node.path, ...platform,
    startupValidation: stagedValidationMode,
    compatibility: { protocol: "pkm.mcp.api/1", components: { knowledge: "0", chat: "0", recipes: "0", agent_sessions: "0" } },
  };
  const manifest = Buffer.from(JSON.stringify({ ...identity, files }));
  await fs.writeFile(join(directory, "manifest.json"), manifest);
  const core = Object.fromEntries([...startupCodeFiles.map(name => "runtime/next-server/" + name), ...startupControlFiles]
    .map(name => [name, files[name]]));
  const coreBytes = (await Promise.all(Object.keys(core).map(name => fs.stat(join(directory, name))))).reduce((sum, stat) => sum + stat.size, 0);
  const receipt = { schema: "pkm.deployment-startup/v2", mode: stagedValidationMode,
    manifest: identity, manifestSha256: hash(manifest), core, coreBytes };
  await fs.mkdir(join(root, "startup-v2"));
  const receiptPath = join(root, "startup-v2", generation + ".json");
  const rawReceipt = Buffer.from(JSON.stringify(receipt));
  await fs.writeFile(receiptPath, rawReceipt);
  await fs.writeFile(join(root, "launch.py"), launcher);
  await fs.writeFile(join(root, ".pkm-isolated-migration"), JSON.stringify({
    schema: "pkm.isolated-managed-migration/v1", startupValidation: stagedValidationMode,
  }));
  const pointer = { schema: identity.schema, generation, startupValidation: stagedValidationMode, startupReceiptSha256: hash(rawReceipt) };
  await fs.writeFile(join(root, "active-generation.json"), JSON.stringify({ ...pointer, compatibilityBaseline: true }));
  await fs.writeFile(join(root, "latest-generation.json"), JSON.stringify(pointer));
  return { parent, root, directory, runtime, data, receipt, receiptPath, pointer };
}
async function until(predicate, description) {
  for (let index = 0; index < 500; index++) { if (predicate()) return; await sleep(5); }
  assert.fail(description);
}

test("staged core and managed descriptor do not enumerate or read the full manifest", async t => {
  const f = await fixture(t);
  await fs.rename(join(f.directory, "manifest.json"), join(f.directory, "manifest.held"));
  const names = ["readdirSync", "opendirSync"], old = names.map(name => syncFs[name]);
  // Named ESM bindings are synchronized to a temporary module-namespace guard.
  const mutableFs = (await import("node:fs")).default;
  for (const name of names) mutableFs[name] = () => { throw new Error("forbidden foreground enumeration"); };
  syncBuiltinESMExports();
  try {
    assert.equal(readStartupReceipt(f.directory).mode, stagedValidationMode);
    const descriptor = await isolatedManagedLaunch(f.root);
    assert.deepEqual(descriptor.args, ["-I", "-S", join(f.root, "launch.py")]);
  } finally {
    names.forEach((name, index) => { mutableFs[name] = old[index]; });
    syncBuiltinESMExports();
    await fs.rename(join(f.directory, "manifest.held"), join(f.directory, "manifest.json"));
  }
});

test("staged core rejects content, links, membership and explicit unknown or null policy", async t => {
  for (const kind of ["content", "storage-paths-content", "link", "membership", "unknown", "null"]) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === "content") await fs.appendFile(join(f.runtime, "dist/native-public-mcp.js"), "\nchanged\n");
    if (kind === "storage-paths-content") await fs.appendFile(join(f.runtime, "dist/workspace-storage-paths.js"), "\nchanged\n");
    if (kind === "link") {
      const path = join(f.runtime, "dist/native-public-mcp.js");
      await fs.unlink(path); await fs.symlink(join(f.root, "launch.py"), path);
    }
    if (kind === "membership") {
      delete f.receipt.core["runtime/next-server/dist/native-public-mcp.js"];
      const raw = Buffer.from(JSON.stringify(f.receipt));
      await fs.writeFile(f.receiptPath, raw);
      await fs.writeFile(join(f.root, "latest-generation.json"), JSON.stringify({ ...f.pointer, startupReceiptSha256: hash(raw) }));
    }
    if (kind === "unknown" || kind === "null")
      await fs.writeFile(join(f.root, ".pkm-isolated-migration"), JSON.stringify({
        schema: "pkm.isolated-managed-migration/v1", startupValidation: kind === "null" ? null : "future",
      }));
    assert.throws(() => readStartupReceipt(f.directory), /core|Linked|startup validation/i);
  });
});

test("background audit keeps optional failure scoped but inventory additions are critical", async t => {
  const f = await fixture(t);
  await fs.appendFile(join(f.runtime, "browser/bootstrap.mjs"), "changed");
  const partial = await auditDeployment(f.directory, f.receipt, async () => {});
  assert.equal(partial.state, "partial-failure");
  assert.deepEqual([...new Set(partial.failures.map(item => item.group))], ["browser-ui"]);
  const coordinator = new DeploymentIntegrity(f.directory, f.receipt);
  t.after(() => coordinator.close());
  await coordinator.ensureCapabilities();
  assert.equal(coordinator.status().phase, "partial-failure");
  coordinator.assertAdmitted();
  assert.throws(() => coordinator.assertAdmitted("browser-ui"), /DEPLOYMENT_INTEGRITY/);
  await fs.writeFile(join(f.directory, "unexpected"), "not in the publication inventory");
  const critical = await auditDeployment(f.directory, f.receipt, async () => {});
  assert.equal(critical.state, "critical-failure");
  assert(critical.failures.some(item => item.code === "unexpected-member"));
});

test("background audit rechecks generation links instead of following a replaced root", async t => {
  const f = await fixture(t);
  const moved = join(f.root, "saved-generation");
  await fs.rename(f.directory, moved);
  await fs.symlink(moved, f.directory, "dir");
  const result = await auditDeployment(f.directory, f.receipt, async () => {});
  assert.equal(result.state, "critical-failure");
});

test("worker yields to foreground and close cancels without a persistent progress file", async t => {
  const f = await fixture(t), coordinator = new DeploymentIntegrity(f.directory, f.receipt);
  t.after(() => coordinator.close());
  const before = (await fs.readdir(f.root)).sort();
  coordinator.initialized();
  await until(() => coordinator.status().phase === "verifying", "background worker did not start");
  await until(() => coordinator.status().backgroundQuanta >= 2, "background worker did not begin its bounded work");
  await coordinator.foreground(async () => {
    const before = coordinator.status().backgroundQuanta;
    await sleep(40);
    assert(coordinator.status().backgroundQuanta <= before + 1, "background work ignored foreground priority");
    assert.equal(coordinator.status().fullVerified, false);
  });
  await coordinator.close();
  assert.equal(coordinator.status().fullVerified, false);
  assert.deepEqual((await fs.readdir(f.root)).sort(), before);
});

test("the Python staged launcher skips deployment inventory but explicit audit and legacy remain full", async t => {
  const f = await fixture(t, { actualPython: true });
  await fs.appendFile(join(f.runtime, "node_modules/pending.bin"), "deferred content mismatch");
  const invoke = (args = [], profile = "compact") => spawnSync(realPython,
    ["-I", "-S", join(f.root, "launch.py"), ...args], {
      encoding: "utf8", timeout: 15000, env: { ...process.env, PKM_CAPABILITY_PROFILE: profile },
    });
  const compact = invoke();
  assert.equal(compact.status, 0, compact.stderr);
  assert(JSON.parse(compact.stdout).includes("--native-public-mcp"));
  const paths = join(f.runtime, "dist/workspace-storage-paths.js"), pathsBytes = await fs.readFile(paths);
  await fs.appendFile(paths, "\nchanged\n");
  const changedPaths = invoke();
  assert.notEqual(changedPaths.status, 0);
  assert.match(changedPaths.stderr, /startup core content mismatch/);
  await fs.writeFile(paths, pathsBytes);
  const audit = invoke(["--verify-generation", f.pointer.generation]);
  assert.notEqual(audit.status, 0);
  assert.match(audit.stderr, /exact dependency inventory/);
  assert.notEqual(invoke([], "legacy").status, 0);
  await assert.rejects(verifyIsolatedManagedGeneration(f.root, f.pointer.generation), /generation rejected/i);
  await fs.truncate(join(f.runtime, "node_modules/pending.bin"), 512 * 1024);
  const legacy = invoke([], "legacy");
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stdout, /unit legacy compatibility/);
});

test("actual get, list, search and Skill discovery do not await full audit and keep one real owner", async t => {
  const f = await fixture(t, { actualData: true });
  await fs.writeFile(join(f.data, "notes/Entry.md"), "---\ndocumentId: entry\ntitle: Entry\n---\nBasic retrieval body.\n");
  await fs.mkdir(join(f.data, "skills"), { recursive: true });
  await fs.writeFile(join(f.data, "skills/Demo.md"), "---\nname: Demo\ndescription: Basic discovery fixture\n---\nDemo skill.\n");
  const deployment = new DeploymentIntegrity(f.directory, f.receipt);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const serving = await startNativePublicOwnerMcp(f.data, {
    actor: { id: "mcp:external", canWrite: false }, manifest: f.receipt.manifest, deployment,
  }, serverTransport);
  const client = new Client({ name: "staged-basic-read", version: "1" });
  t.after(async () => { try { await client.close(); } finally { await serving.close(); } });
  await client.connect(clientTransport);
  assert.equal((await client.listTools()).tools.length, 9);
  const lease = serving.owner.workspaceLease();
  await until(() => deployment.status().phase === "verifying", "deferred verifier did not start");
  for (const [tool, arguments_] of [
    ["get_note", { slug: "Entry" }], ["list_notes", {}], ["search_notes", { query: "Basic" }],
    ["search_skills", { query: "Demo" }],
  ]) {
    const response = await client.callTool({ name: "capability_read",
      arguments: { operation: "mcp.tool." + tool, version: 1, arguments: arguments_ } });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    if (tool === "search_skills")
      assert(JSON.parse(response.content[0].text).some(item => item.name === "Demo"), JSON.stringify(response));
    assert.equal(deployment.status().fullVerified, false, "basic read waited for the whole deployment audit");
    assert.deepEqual(serving.owner.workspaceLease(), lease);
  }
  const attached = await serving.owner.ensureFull();
  assert.deepEqual(attached.storage.workspaceLease(), lease);
  await client.close(); await serving.close();
  const reopened = await RootOwner.open(f.data);
  await reopened.close();
});

test("transport close during connect releases the actual owner without starting background audit", async t => {
  const f = await fixture(t, { actualData: true }), deployment = new DeploymentIntegrity(f.directory, f.receipt);
  const transport = {
    async start() { this.onclose?.(); }, async send() {}, async close() { this.onclose?.(); },
  };
  await assert.rejects(startNativePublicOwnerMcp(f.data, {
    actor: { id: "mcp:external", canWrite: false }, manifest: f.receipt.manifest, deployment,
  }, transport), /closed during startup/);
  assert.equal(deployment.status().phase, "cancelled");
  const reopened = await RootOwner.open(f.data);
  await reopened.close();
});

test("critical background failure fences real requests but keeps lifecycle diagnostics available", async t => {
  const f = await fixture(t, { actualData: true });
  await fs.appendFile(join(f.runtime, "node_modules/pending.bin"), "critical deployment change");
  const deployment = new DeploymentIntegrity(f.directory, f.receipt);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const serving = await startNativePublicOwnerMcp(f.data, {
    actor: { id: "mcp:external", canWrite: false }, manifest: f.receipt.manifest, deployment,
  }, serverTransport);
  const client = new Client({ name: "critical-deployment", version: "1" });
  t.after(async () => { try { await client.close(); } finally { await serving.close(); } });
  await client.connect(clientTransport);
  await until(() => deployment.status().phase === "critical-failure", "critical failure was not latched");
  const denied = await client.callTool({ name: "capability_read",
    arguments: { operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Missing" } } });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /DEPLOYMENT_INTEGRITY/);
  const diagnostic = await client.callTool({ name: "mcp_lifecycle_status", arguments: {} });
  assert.notEqual(diagnostic.isError, true, JSON.stringify(diagnostic));
  assert.equal(diagnostic.structuredContent.deploymentIntegrity.phase, "critical-failure");
  assert.equal(diagnostic.structuredContent.acceptingNewCalls, false);
  const reopened = await RootOwner.open(f.data);
  await reopened.close();
});

test("actual stdio EOF before initialization and after initialized audit both release ownership", async t => {
  for (const initialized of [false, true]) await t.test(initialized ? "initialized" : "early", async t => {
    const f = await fixture(t, { actualData: true, actualNode: true, actualPython: true });
    const child = spawn(process.execPath, [resolve("dist/cli.js"), "mcp", "--data", f.data,
      "--experimental-legacy-mcp", "--native-public-mcp", "--managed-generation", f.directory, "--read-only"],
    { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
    if (initialized) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "EOF-fixture", version: "1" } } }) + "\n");
      await until(() => stdout.includes('"id":1'), "stdio initialize did not reply: " + stderr);
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      await sleep(180);
    }
    child.stdin.end();
    const deadline = new AbortController();
    let result;
    try {
      result = await Promise.race([exited, sleep(5000, undefined, { signal: deadline.signal })
        .then(() => { throw new Error("stdio EOF did not stop: " + stderr); })]);
    } finally { deadline.abort(); }
    assert.equal(result.code, 0, stderr);
    const reopened = await RootOwner.open(f.data);
    await reopened.close();
  });
});
