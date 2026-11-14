import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const dist = process.env.PKM_TEST_NEXT_SERVER_DIST;
const oldExtension = process.env.PKM_TEST_LEGACY_CHAT_EXTENSION;
const parentControlDist = process.env.PKM_TEST_PARENT_CONTROL_DIST;
const load = name => import(pathToFileURL(join(dist, `${name}.js`)).href);
const { create: createLegacyFixture } = createRequire(import.meta.url)("./next-trial-electron/api-chat-fixture.cjs");
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

test("session refuses asynchronous authority fences and closes on disconnected admission", { skip: !dist }, async () => {
  const { createOwnerHostSessions } = await load("owner-host-sessions");
  let barrier;
  const owner = { workspaceId: "workspace", assertCurrent() {}, registerChildClose(close) {
    barrier = close; return () => { barrier = undefined; };
  } };
  const sessions = createOwnerHostSessions(owner, "workspace");
  assert.throws(() => sessions.open({ hostKey: "bad", connection: new AbortController().signal,
    assertHostCurrent: async () => {}, assertScopeCurrent() {}, onCloseError() {} }), /synchronously/);
  const connection = new AbortController();
  const session = sessions.open({ hostKey: "host", connection: connection.signal,
    assertHostCurrent() {}, assertScopeCurrent: async () => {}, onCloseError() {} });
  assert.throws(() => session.assertCurrent("mcp"), /synchronously/);
  assert.throws(() => sessions.open({ hostKey: "host", connection: connection.signal,
    assertHostCurrent() {}, assertScopeCurrent() {}, onCloseError() {} }), /admission/);
  let reentrant;
  session.signal.addEventListener("abort", () => { reentrant = session.revoke(); });
  connection.abort();
  assert.equal(session.signal.aborted, true);
  await reentrant;
  assert.equal(barrier, undefined);
  assert.throws(() => session.assertCurrent("chat"), /unavailable/);
  const replacement = sessions.open({ hostKey: "host", connection: new AbortController().signal,
    assertHostCurrent() {}, assertScopeCurrent() {}, onCloseError() {} });
  replacement.assertCurrent("chat");
  await session.revoke();
  replacement.assertCurrent("chat");
  let release, closes = 0;
  const held = new Promise(resolveWork => { release = resolveWork; });
  const mcpSignal = replacement.signalFor("mcp");
  replacement.registerChildClose("mcp", async () => { closes++; await held; });
  const scopeDrain = replacement.revokeScope("mcp");
  assert.equal(mcpSignal.aborted, true);
  assert.throws(() => replacement.assertCurrent("mcp"), /unavailable/);
  replacement.assertCurrent("chat");
  const fullDrain = replacement.revoke();
  await sleep(10);
  assert.equal(closes, 1);
  release();
  await Promise.all([scopeDrain, fullDrain]);
  assert.equal(closes, 1);
  let fails = true, attempts = 0;
  const retry = sessions.open({ hostKey: "retry", connection: new AbortController().signal,
    assertHostCurrent() {}, assertScopeCurrent() {}, onCloseError() {} });
  retry.registerChildClose("environment", async () => {
    attempts++;
    if (fails) throw new Error("unconfirmed close");
  });
  await assert.rejects(retry.revokeScope("environment"), /did not drain/);
  assert.throws(() => retry.assertCurrent("environment"), /unavailable/);
  retry.assertCurrent("chat");
  fails = false;
  await retry.revokeScope("environment");
  assert.equal(attempts, 2);
  await retry.revoke();
  await sessions.close();
  assert.throws(() => replacement.assertCurrent("chat"), /unavailable/);
});

test("real adopted owner keeps its lease until disconnected host resources drain", {
  timeout: 90000, skip: process.platform !== "linux" || !dist || !oldExtension,
}, async t => {
  const { adoptLegacyRootInPlaceExperimental } = await load("legacy-root-adoption");
  const { startAdoptedRootUnifiedHost } = await load("managed-client-host");
  const { createOwnerHostSessions } = await load("owner-host-sessions");
  const { attachAdoptedRootReadOnlyMcp } = await load("adopted-root-mcp");
  const { acquireLinuxRootWriterFence } = await load("linux-root-writer-fence");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const dir = resolve(".migration-test-work", `owner-session-${randomUUID()}`);
  const root = join(dir, "root"), config = join(dir, "host.json");
  mkdirSync(join(root, "notes"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "notes", "Existing.md"), "---\ntitle: Existing\n---\nOriginal note.\n", { mode: 0o600 });
  const mask = process.umask(0o077);
  try { createLegacyFixture({ extension: oldExtension, root }); } finally { process.umask(mask); }
  const endpoint = "http://127.0.0.1:12345/v1";
  writeFileSync(config, JSON.stringify({ schema: "pkm.native-host-config/v1", provider: "openai-compatible",
    endpoint, secretRef: "secret:fixture/model", model: "fixture", contextWindow: 16384, maxOutputTokens: 4096,
    outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.create"] }), { mode: 0o600 });
  const adopted = await adoptLegacyRootInPlaceExperimental(root, {
    snapshotAdmission: { authorityId: "private-session-test", allowedTools: ["knowledge_snapshot_status"], authorize: () => true },
  });
  const unified = await startAdoptedRootUnifiedHost({
    optIn: true, dataPath: root, configPath: config, expectedWorkspaceId: adopted.workspaceId,
    policy: { authorizedConfigPath: config, allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint],
      allowedModels: ["fixture"], allowedTools: ["knowledge.document.create"], allowInsecureLoopback: true },
    resolveSecret: async () => "fixture",
  }, adopted);
  const owner = unified.ownerResourceContext(), registry = createOwnerHostSessions(owner, adopted.workspaceId);
  const connection = new AbortController(), closeErrors = [];
  let mcpAllowed = true, failClose = true, attempts = 0, release;
  const work = new Promise(resolveWork => { release = resolveWork; });
  t.after(async () => {
    failClose = false;
    release();
    await unified.managed.close();
  });
  const session = registry.open({ hostKey: "trusted-transport-fixture", connection: connection.signal,
    assertHostCurrent() {},
    assertScopeCurrent(scope) { if (scope === "mcp" && !mcpAllowed) throw new Error("MCP revoked"); },
    onCloseError(error) { closeErrors.push(error); },
  });
  const secondHost = registry.open({ hostKey: "second-trusted-host", connection: new AbortController().signal,
    assertHostCurrent() {}, assertScopeCurrent() {}, onCloseError(error) { closeErrors.push(error); } });
  const socketDir = resolve(".migration-test-work", `s${randomUUID().replaceAll("-", "").slice(0, 10)}`);
  mkdirSync(socketDir, { mode: 0o700 });
  const server = createServer();
  await new Promise(resolveListen => server.listen(join(socketDir, "s"), resolveListen));
  const accepted = new Promise(resolveAccept => server.once("connection", resolveAccept));
  const clientSocket = connect(join(socketDir, "s")), serverSocket = await accepted;
  const client = new Client({ name: "private-host-session", version: "1.0.0" });
  t.after(async () => {
    clientSocket.destroy();
    serverSocket.destroy();
    await client.close();
    if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
  });
  const mcp = await attachAdoptedRootReadOnlyMcp({ owner,
    transport: new StdioServerTransport(serverSocket, serverSocket), connection: session.signalFor("mcp"),
    assertMcpAuthority() { session.assertCurrent("mcp"); },
    onCloseError(error) { closeErrors.push(error); },
    async closeConnection() {
      if (serverSocket.closed) return;
      const closed = new Promise(resolveClose => serverSocket.once("close", resolveClose));
      serverSocket.destroy();
      await closed;
    },
  });
  session.registerChildClose("mcp", mcp.close);
  await client.connect(new StdioServerTransport(clientSocket, clientSocket));
  const notes = await client.callTool({ name: "list_notes", arguments: {} });
  assert.notEqual(notes.isError, true);
  assert(JSON.stringify(notes).includes("Existing"));
  session.assertCurrent("chat");
  mcpAllowed = false;
  assert.throws(() => session.assertCurrent("mcp"), /MCP revoked/);
  const denied = client.callTool({ name: "list_notes", arguments: {} }, undefined, { timeout: 1000 })
    .catch(error => error);
  for (let i = 0; i < 200 && !mcp.disconnectTask; i++) await sleep(10);
  assert(mcp.disconnectTask, "revoked transport must initiate closure");
  await mcp.disconnectTask;
  assert(await denied instanceof Error);
  await session.revokeScope("mcp");
  mcpAllowed = true;
  assert.throws(() => session.assertCurrent("mcp"), /unavailable/);
  session.assertCurrent("environment");
  session.registerChildClose("chat", async () => { await work; });
  session.registerChildClose("environment", async () => {
    attempts++;
    if (failClose) throw new Error("still active");
  });
  connection.abort();
  assert.equal(session.signal.aborted, true);
  assert.throws(() => session.assertCurrent("chat"), /unavailable/);
  secondHost.assertCurrent("chat");
  const closing = unified.managed.close();
  await sleep(10);
  assert.equal(secondHost.signal.aborted, true);
  await assert.rejects(acquireLinuxRootWriterFence(root, 150), /timed out|acquire.*fence/i);
  release();
  await assert.rejects(closing, /child operations did not drain/);
  assert.equal(closeErrors.length, 1);
  assert.equal(attempts, 1);
  adopted.storage.assertWorkspaceLease();
  failClose = false;
  await unified.managed.close();
  assert.equal(attempts, 2);
  const fence = await acquireLinuxRootWriterFence(root, 500);
  await fence.release();
  await registry.close();
  console.log("ADOPTED_OWNER_SESSION_FIXTURE", dir);
});

test("direct parent IPC disconnect revokes a real adopted-owner session and waits for effects", {
  timeout: 90000, skip: process.platform !== "linux" || !dist || !oldExtension || !parentControlDist,
}, async t => {
  const { acquireLinuxRootWriterFence } = await load("linux-root-writer-fence");
  const { createOwnerParentControl } = createRequire(import.meta.url)(join(parentControlDist, "owner-parent-control.js"));
  const dir = resolve(".migration-test-work", `owner-parent-${randomUUID()}`);
  const root = join(dir, "root"), config = join(dir, "host.json"), control = join(dir, "control");
  mkdirSync(join(root, "notes"), { recursive: true, mode: 0o700 });
  mkdirSync(control, { mode: 0o700 });
  writeFileSync(join(root, "notes", "Existing.md"), "---\ntitle: Existing\n---\nOriginal note.\n", { mode: 0o600 });
  const mask = process.umask(0o077);
  try { createLegacyFixture({ extension: oldExtension, root }); } finally { process.umask(mask); }
  const endpoint = "http://127.0.0.1:12345/v1";
  writeFileSync(config, JSON.stringify({ schema: "pkm.native-host-config/v1", provider: "openai-compatible",
    endpoint, secretRef: "secret:fixture/model", model: "fixture", contextWindow: 16384, maxOutputTokens: 4096,
    outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.create"] }), { mode: 0o600 });
  const child = fork(resolve("tests/fixtures/owner-parent-session-child.mjs"), [], {
    env: { PATH: process.env.PATH || "", TMPDIR: process.env.TMPDIR || dir,
      PKM_TEST_NEXT_SERVER_DIST: dist, PKM_TEST_ROOT: root, PKM_TEST_CONFIG: config,
      PKM_TEST_PARENT: String(process.pid), PKM_TEST_CONTROL: control },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", bytes => { stderr += bytes.toString(); });
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  t.after(async () => {
    writeFileSync(join(control, "release"), "");
    writeFileSync(join(control, "release-scope"), "");
    if (child.connected) child.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      const done = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
      if (!done) child.kill("SIGKILL");
    }
    await exited;
  });
  const ready = await Promise.race([
    new Promise(resolveReady => child.once("message", resolveReady)),
    exited.then(result => { throw new Error(`owner exited before ready: ${JSON.stringify(result)} ${stderr}`); }),
  ]);
  assert.equal(ready.type, "ready");
  const rootIdentity = lstatSync(root, { bigint: true });
  const parentControl = createOwnerParentControl({ child, sessionId: ready.sessionId, timeoutMs: 10000,
    assertCurrent() {
      const current = lstatSync(root, { bigint: true });
      if (current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) throw new Error("Root changed.");
    },
  });
  assert.throws(() => createOwnerParentControl({ child, sessionId: ready.sessionId, assertCurrent() {} }),
    /connected owner child/);
  t.after(() => parentControl.dispose());
  const firstStatus = new Promise(resolveStatus => {
    child.on("message", function onMessage(message) {
      if (message?.type !== "private-session-status") return;
      child.removeListener("message", onMessage);
      resolveStatus(message);
    });
  });
  child.send({ type: "pkm.owner-scope-revoke/v1", sessionId: randomUUID(), id: randomUUID(), scope: "environment" });
  child.send({ type: "inspect-private-session" });
  assert.deepEqual(await firstStatus, { type: "private-session-status", chat: true, environment: true });
  let acknowledged = false;
  const acknowledgement = parentControl.revokeScope("environment").then(() => { acknowledged = true; });
  for (let i = 0; i < 500 && !existsSync(join(control, "scope-draining")); i++) await sleep(20);
  assert(existsSync(join(control, "scope-draining")), stderr);
  const statusPromise = new Promise(resolveStatus => {
    child.on("message", function onMessage(message) {
      if (message?.type !== "private-session-status") return;
      child.removeListener("message", onMessage);
      resolveStatus(message);
    });
  });
  child.send({ type: "inspect-private-session" });
  assert.deepEqual(await statusPromise, { type: "private-session-status", chat: true, environment: false });
  assert.equal(acknowledged, false);
  writeFileSync(join(control, "release-scope"), "");
  await acknowledgement;
  assert.equal(acknowledged, true);
  await assert.rejects(parentControl.revokeScope("environment"), /completed/);
  const unknown = parentControl.revokeScope("chat");
  void unknown.catch(() => {});
  for (let i = 0; i < 500 && !existsSync(join(control, "draining")); i++) await sleep(20);
  assert(existsSync(join(control, "draining")), stderr);
  child.disconnect();
  await assert.rejects(unknown, /unknown/);
  await assert.rejects(acquireLinuxRootWriterFence(root, 150), /timed out|acquire.*fence/i);
  assert.equal(existsSync(join(control, "drained")), false);
  writeFileSync(join(control, "release"), "");
  const result = await exited;
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  assert.equal(existsSync(join(control, "drained")), true);
  assert.equal(existsSync(join(control, "error")), false);
  const fence = await acquireLinuxRootWriterFence(root, 500);
  await fence.release();
  console.log("ADOPTED_PARENT_SESSION_FIXTURE", dir);
});

test("parent crash revokes a real adopted-owner session without releasing an in-flight child", {
  timeout: 90000, skip: process.platform !== "linux" || !dist || !oldExtension,
}, async t => {
  const { acquireLinuxRootWriterFence } = await load("linux-root-writer-fence");
  const dir = resolve(".migration-test-work", `owner-parent-crash-${randomUUID()}`);
  const root = join(dir, "root"), config = join(dir, "host.json"), control = join(dir, "control");
  mkdirSync(join(root, "notes"), { recursive: true, mode: 0o700 });
  mkdirSync(control, { mode: 0o700 });
  writeFileSync(join(root, "notes", "Existing.md"), "---\ntitle: Existing\n---\nOriginal note.\n", { mode: 0o600 });
  const mask = process.umask(0o077);
  try { createLegacyFixture({ extension: oldExtension, root }); } finally { process.umask(mask); }
  const endpoint = "http://127.0.0.1:12345/v1";
  writeFileSync(config, JSON.stringify({ schema: "pkm.native-host-config/v1", provider: "openai-compatible",
    endpoint, secretRef: "secret:fixture/model", model: "fixture", contextWindow: 16384, maxOutputTokens: 4096,
    outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.create"] }), { mode: 0o600 });
  const parent = fork(resolve("tests/fixtures/owner-parent-crash-harness.cjs"), [], {
    env: { PATH: process.env.PATH || "", TMPDIR: process.env.TMPDIR || dir,
      PKM_TEST_NEXT_SERVER_DIST: dist, PKM_TEST_ROOT: root, PKM_TEST_CONFIG: config, PKM_TEST_CONTROL: control,
      PKM_TEST_HOLD_IPC: "1" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "", owner;
  parent.stderr.on("data", bytes => { stderr += bytes.toString(); });
  const exited = new Promise((resolveExit, reject) => {
    parent.once("error", reject);
    parent.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const identityLive = (pid, start) => {
    if (!owner) return false;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return fields[19] === start && !["Z", "X"].includes(fields[0]);
    } catch { return false; }
  };
  const ownerLive = () => owner && identityLive(owner.ownerPid, owner.ownerStart);
  const holderLive = () => owner && identityLive(owner.holderPid, owner.holderStart);
  t.after(async () => {
    writeFileSync(join(control, "release"), "");
    writeFileSync(join(control, "release-scope"), "");
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGTERM");
    await exited;
    if (holderLive()) process.kill(owner.holderPid, "SIGTERM");
    for (let i = 0; i < 250 && ownerLive(); i++) await sleep(20);
    if (ownerLive()) {
      process.kill(owner.ownerPid, "SIGTERM");
      for (let i = 0; i < 100 && ownerLive(); i++) await sleep(20);
      if (ownerLive()) process.kill(owner.ownerPid, "SIGKILL");
    }
  });
  owner = await Promise.race([
    new Promise(resolveReady => parent.once("message", resolveReady)),
    exited.then(result => { throw new Error(`parent exited before ready: ${JSON.stringify(result)} ${stderr}`); }),
  ]);
  assert.equal(owner.type, "ready");
  assert(ownerLive());
  assert(holderLive());
  writeFileSync(join(control, "release-scope"), "");
  parent.kill("SIGKILL");
  assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
  for (let i = 0; i < 500 && !existsSync(join(control, "draining")); i++) await sleep(20);
  assert(existsSync(join(control, "draining")), stderr);
  await assert.rejects(acquireLinuxRootWriterFence(root, 150), /timed out|acquire.*fence/i);
  assert.equal(existsSync(join(control, "drained")), false);
  writeFileSync(join(control, "release"), "");
  for (let i = 0; i < 500 && !existsSync(join(control, "drained")); i++) await sleep(20);
  assert.equal(existsSync(join(control, "drained")), true);
  assert.equal(existsSync(join(control, "error")), false);
  assert(holderLive());
  assert.equal(readFileSync(join(control, "connected-after-drain"), "utf8"), "true");
  assert(ownerLive(), "the leaked IPC handle remains open until its fixture holder exits");
  const fence = await acquireLinuxRootWriterFence(root, 500);
  await fence.release();
  process.kill(owner.holderPid, "SIGTERM");
  for (let i = 0; i < 250 && holderLive(); i++) await sleep(20);
  assert.equal(!!holderLive(), false);
  for (let i = 0; i < 250 && ownerLive(); i++) await sleep(20);
  assert.equal(!!ownerLive(), false);
  console.log("ADOPTED_PARENT_CRASH_FIXTURE", dir);
});
