"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const dist = path.resolve(process.env.PKM_TEST_DIST || "dist");
const source = process.env.PKM_LEGACY_GENERATED_FIXTURE;
const python = process.env.PKM_LEGACY_PYTHON;
const { retireOwnedLegacyMcpClient } = require(path.join(dist, "runtime/legacy-mcp-owned-client"));
const session = require(path.join(dist, "runtime/managed-writer-session"));
const { managedMcpLauncher } = require(path.join(dist, "mcp/mcp-lifecycle"));
const { withCrossProcessLock } = require(path.join(dist, "runtime/cross-process-lock"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const compatible of [false, true]) test(`already-running original clients cooperate with ${compatible ? "compatible" : "legacy"} session`, {
  skip: process.platform !== "linux" || !source || !python || compatible && !process.env.PKM_TEST_OLD_MCP_DIST, timeout: 90000,
}, async t => {
  const project = path.resolve("."), original = fs.realpathSync(source);
  assert(original.startsWith(fs.realpathSync(".migration-test-work") + path.sep));
  const fixture = path.resolve(".migration-test-work", `cooperative-old-mcp-${randomUUID()}`);
  const root = path.join(fixture, "knowledge"), home = path.join(fixture, "home"), local = path.join(fixture, "local");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(local, { mode: 0o700 });
  const managed = path.join(fixture, "legacy-mcp-server");
  fs.cpSync(path.join(original, "legacy-mcp-server"), managed, { recursive: true });
  fs.rmSync(path.join(managed, "instances"), { recursive: true, force: true });
  const active = JSON.parse(fs.readFileSync(path.join(managed, "active-generation.json"), "utf8"));
  const generation = path.join(managed, "generations", active.generation);
  const manifestPath = path.join(generation, "manifest.json"), manifest = JSON.parse(fs.readFileSync(manifestPath));
  const digest = value => createHash("sha256").update(value).digest("hex");
  assert.equal(manifest.extensionVersion, "4.0.22");
  for (const [file, hash] of Object.entries(manifest.files)) {
    const target = path.resolve(generation, file);
    assert(target.startsWith(generation + path.sep));
    const bytes = fs.readFileSync(target);
    assert.equal(digest(bytes), hash);
    if (bytes.includes(Buffer.from(original))) {
      assert(["server.py", "recipe_compiler_config.json"].includes(file));
      const rebound = bytes.toString("utf8").replaceAll(path.join(original, "knowledge"), root).replaceAll(original, fixture);
      fs.writeFileSync(target, rebound);
      manifest.files[file] = digest(rebound);
    }
  }
  const server = path.join(generation, "server.py");
  const rebound = fs.readFileSync(server, "utf8").replace(/^_KNOWLEDGE_NODE = .+$/m, `_KNOWLEDGE_NODE = ${JSON.stringify(process.execPath)}`);
  fs.writeFileSync(server, rebound); manifest.files["server.py"] = digest(rebound);
  manifest.managedRoot = managed; manifest.runtimeMaintenance = path.join(fixture, "runtime-maintenance.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const launcher = path.join(managed, "server.py"), supervisor = path.join(project, "resources/next_mcp_subreaper.py");
  const env = { PATH: process.env.PATH || "", HOME: home, TMPDIR: local, PYTHONDONTWRITEBYTECODE: "1",
    PKM_NODE_EXECUTABLE: process.execPath, HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1" };
  const clients = [], processes = [];
  t.after(async () => {
    for (const { client } of clients.reverse()) await client.close().catch(() => {});
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  const start = async (supervised = true, extra = {}) => {
    const client = new Client({ name: "isolated-existing-client", version: "1" });
    const args = supervised ? ["-B", supervisor, python, "-B", launcher] : ["-B", launcher];
    const transport = new StdioClientTransport({ command: python, args, cwd: fixture, env: { ...env, ...extra }, stderr: "pipe" });
    clients.push({ client, transport });
    await client.connect(transport);
    processes.push(transport._process);
    return { client, transport };
  };
  const call = (client, name, arguments_ = {}) => client.callTool({ name, arguments: arguments_ });
  const unpack = result => {
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent || JSON.parse(result.content.map(part => part.text || "").join(""));
  };
  const first = await start(), other = await start();
  const firstStatus = unpack(await call(first.client, "mcp_lifecycle_status"));
  const otherStatus = unpack(await call(other.client, "mcp_lifecycle_status"));
  assert.notEqual(firstStatus.instanceId, otherStatus.instanceId);
  const enrollment = (compatible ? session.bootstrapCompatibleManagedProfile : session.bootstrapManagedProfile)(root, "a".repeat(64), true);
  const previousSession = process.env.PKM_MANAGED_WRITER_SESSION;
  process.env.PKM_MANAGED_WRITER_SESSION = enrollment.registration.sessionId;
  t.after(() => {
    if (previousSession === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION;
    else process.env.PKM_MANAGED_WRITER_SESSION = previousSession;
  });
  const managedSession = { root, sessionId: enrollment.registration.sessionId };
  const operationDir = path.join(root, ".pkm/state", compatible ? "managed-writer-session-compatible" : "managed-writer-session", "operations");
  assert.deepEqual(fs.readdirSync(operationDir), [`${enrollment.registration.operationId}.pending`]);
  const verifier = async child => {
    assert.equal(child.exitCode, 0);
    assert.equal(child.signalCode, null);
  };
  let notifications = 0;
  assert.equal((await retireOwnedLegacyMcpClient({ ...first, notifyAndApprove: async () => { notifications++; return false; },
    verifyOwnedDescendantsExited: verifier })).state, "declined");
  assert.equal(unpack(await call(first.client, "mcp_lifecycle_status")).phase, "accepting");
  let lateApproval;
  assert.equal((await retireOwnedLegacyMcpClient({ ...first,
    notifyAndApprove: () => new Promise(resolve => { lateApproval = resolve; }),
    verifyOwnedDescendantsExited: verifier, timeoutMs: 200 })).state, "unknown");
  lateApproval(true);
  await pause(50);
  assert.equal(unpack(await call(first.client, "mcp_lifecycle_status")).phase, "accepting");
  await assert.rejects(retireOwnedLegacyMcpClient({ client: first.client, transport: other.transport,
    notifyAndApprove: async () => true, verifyOwnedDescendantsExited: verifier }), /exact live client-owned/);

  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const lock = withCrossProcessLock(path.join(root, ".pkm/state/markdown-assets.lock"), "cooperative old MCP", 2000, async () => {
    entered(); await new Promise(resolve => { release = resolve; });
  });
  await ready;
  let handoff, writing;
  try {
    writing = call(first.client, "add_note", { title: "Existing in-flight", content: "finished before exit" });
    for (let i = 0; i < 200; i++) {
      if (unpack(await call(first.client, "mcp_lifecycle_status")).inFlight === 1) break;
      await pause(20);
    }
    assert.equal(unpack(await call(first.client, "mcp_lifecycle_status")).inFlight, 1);
    handoff = retireOwnedLegacyMcpClient({ ...first, managedSession, notifyAndApprove: async () => { notifications++; return true; },
      verifyOwnedDescendantsExited: verifier });
    for (let i = 0; i < 200; i++) {
      if (unpack(await call(first.client, "mcp_lifecycle_status")).phase === "draining") break;
      await pause(20);
    }
    assert.equal(unpack(await call(first.client, "mcp_lifecycle_status")).phase, "draining");
    assert.equal(unpack(await call(other.client, "mcp_lifecycle_status")).phase, "accepting");
    await assert.rejects(retireOwnedLegacyMcpClient({ ...first, managedSession, notifyAndApprove: async () => true,
      verifyOwnedDescendantsExited: verifier }), /active or uncertain/);
  } finally { release(); await lock; }
  assert.equal(unpack(await writing).ok, true);
  assert.equal((await handoff).state, "drained-and-stopped");
  assert.equal(notifications, 2);
  assert.equal(unpack(await call(other.client, "add_note", { title: "Other still works", content: "unregistered" })).ok, true);
  const existing = () => fs.readdirSync(operationDir).map(name => JSON.parse(fs.readFileSync(path.join(operationDir, name), "utf8")))
    .filter(record => record.kind === "mcp-existing");
  assert.deepEqual(existing().map(record => record.phase).sort(), ["complete", "pending"]);
  assert(existing().every(record => record.instanceId === firstStatus.instanceId));

  const crashed = await start(false);
  const crashedIdentity = unpack(await call(crashed.client, "mcp_lifecycle_status")).instanceId;
  const crashedChild = crashed.transport._process;
  const crashedExit = new Promise(resolve => crashedChild.once("close", (_code, signal) => resolve(signal)));
  crashedChild.kill("SIGKILL");
  assert.equal(await crashedExit, "SIGKILL");
  await assert.rejects(retireOwnedLegacyMcpClient({ ...crashed, notifyAndApprove: async () => true,
    verifyOwnedDescendantsExited: verifier }), /exact live client-owned/);
  const oldRestart = await start();
  assert.notEqual(unpack(await call(oldRestart.client, "mcp_lifecycle_status")).instanceId, crashedIdentity);
  assert.equal(unpack(await call(oldRestart.client, "add_note", { title: "Old crash restart", content: "still operational" })).ok, true);
  assert.equal((await retireOwnedLegacyMcpClient({ ...oldRestart, notifyAndApprove: async () => true,
    verifyOwnedDescendantsExited: verifier })).state, "drained-and-stopped");
  assert.equal(existing().length, 2);

  const slow = await start();
  const slowIdentity = unpack(await call(slow.client, "mcp_lifecycle_status")).instanceId;
  let releaseVerification;
  const timedOut = await retireOwnedLegacyMcpClient({ ...slow, managedSession, notifyAndApprove: async () => true,
    verifyOwnedDescendantsExited: () => new Promise(resolve => { releaseVerification = resolve; }), timeoutMs: 1000 });
  assert.equal(timedOut.state, "unknown");
  assert.equal(typeof releaseVerification, "function");
  releaseVerification();
  await pause(100);
  assert.deepEqual(existing().filter(record => record.instanceId === slowIdentity).map(record => record.phase), ["pending"]);

  const interrupted = await start();
  const interruptedStatus = unpack(await call(interrupted.client, "mcp_lifecycle_status"));
  let releaseCrash, enteredCrash;
  const crashReady = new Promise(resolve => { enteredCrash = resolve; });
  const crashLock = withCrossProcessLock(path.join(root, ".pkm/state/markdown-assets.lock"), "old MCP crash", 2000, async () => {
    enteredCrash(); await new Promise(resolve => { releaseCrash = resolve; });
  });
  await crashReady;
  let interruptedWrite, interruptedHandoff;
  try {
    interruptedWrite = call(interrupted.client, "add_note", { title: "Unknown crash write", content: "do not replay" });
    void interruptedWrite.catch(() => {});
    for (let i = 0; i < 200; i++) {
      if (unpack(await call(interrupted.client, "mcp_lifecycle_status")).inFlight === 1) break;
      await pause(20);
    }
    assert.equal(unpack(await call(interrupted.client, "mcp_lifecycle_status")).inFlight, 1);
    interruptedHandoff = retireOwnedLegacyMcpClient({ ...interrupted, managedSession, notifyAndApprove: async () => true,
      verifyOwnedDescendantsExited: verifier, timeoutMs: 10000 });
    for (let i = 0; i < 200; i++) {
      if (unpack(await call(interrupted.client, "mcp_lifecycle_status")).phase === "draining") break;
      await pause(20);
    }
    assert.equal(unpack(await call(interrupted.client, "mcp_lifecycle_status")).phase, "draining");
    process.kill(interruptedStatus.pid, "SIGKILL");
  } finally { releaseCrash(); await crashLock; }
  assert.equal((await interruptedHandoff).state, "unknown");
  await interruptedWrite.catch(() => {});
  assert.deepEqual(existing().filter(record => record.instanceId === interruptedStatus.instanceId).map(record => record.phase), ["pending"]);
  assert.equal(unpack(await call(other.client, "mcp_lifecycle_status")).phase, "accepting");

  const fence = fs.readFileSync(path.join(project, "resources/root_writer_fence.py"));
  fs.writeFileSync(path.join(generation, "root_writer_fence.py"), fence);
  manifest.files["root_writer_fence.py"] = digest(fence);
  const runtime = path.join(generation, "runtime/dist/runtime");
  fs.cpSync(path.join(dist, "runtime"), runtime, { recursive: true, force: true });
  for (const file of fs.readdirSync(runtime))
    manifest.files[`runtime/dist/runtime/${file}`] = digest(fs.readFileSync(path.join(runtime, file)));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  if (compatible) {
    const previousLauncher = require(path.join(process.env.PKM_TEST_OLD_MCP_DIST, "mcp/mcp-lifecycle.js")).managedMcpLauncher;
    fs.writeFileSync(launcher, previousLauncher(manifest, root));
    const previous = await start();
    assert.equal(unpack(await call(previous.client, "add_note", {
      title: "Previous launcher", content: "unchanged unbound reconnect",
    })).ok, true);
    assert.equal((await retireOwnedLegacyMcpClient({ ...previous, notifyAndApprove: async () => true,
      verifyOwnedDescendantsExited: verifier })).state, "drained-and-stopped");
  }
  fs.writeFileSync(launcher, managedMcpLauncher(manifest, root));
  const launchId = randomUUID(), successor = await start(true, { PKM_MANAGED_WRITER_LAUNCH_ID: launchId });
  session.assertManagedMcpLaunchRegistered(root, enrollment.registration.sessionId, launchId);
  assert.notEqual(unpack(await call(successor.client, "mcp_lifecycle_status")).instanceId, firstStatus.instanceId);
  assert.match(JSON.stringify(await call(successor.client, "get_note", { slug: "Existing in-flight" })), /finished before exit/);
  assert.equal(unpack(await call(other.client, "add_note", { title: "Old alongside successor", content: "still operational" })).ok, true);
  assert.equal((await retireOwnedLegacyMcpClient({ ...successor, notifyAndApprove: async () => true,
    verifyOwnedDescendantsExited: verifier })).state, "drained-and-stopped");
  assert.equal((await retireOwnedLegacyMcpClient({ ...other, notifyAndApprove: async () => true,
    verifyOwnedDescendantsExited: verifier })).state, "drained-and-stopped");
});
