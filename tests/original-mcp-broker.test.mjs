import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startOriginalMcpBroker, startOriginalMcpNativeBroker } from "../dist/original-mcp-broker.js";
import { verifyOriginalMcpBrokerDescriptor } from "../dist/original-mcp-broker-descriptor.js";
import {
  originalMcpRelayLaunch, pinOriginalMcpBrokerFile, readOriginalMcpBrokerDescriptor, originalMcpBrokerAuthLine,
} from "../dist/original-mcp-relay.js";
import { acquireOriginalMcpRootFence, captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { inspectLinuxLegacyWriterQuiescence } from "../dist/linux-legacy-writer-quiescence.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { NativePublicMcpLifecycle } from "../dist/native-public-mcp-lifecycle.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const result = value => value.structuredContent ?? JSON.parse(value.content[0].text);
const readNote = client => client.callTool({ name: "capability_read",
  arguments: { operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Entry" } } });
async function serverStatus(f, broker, pin = broker.descriptorSha256) {
  const { stdout } = await promisify(execFile)(f.runtime.node.path, [
    f.runtime.relay.path, "status", "--descriptor", broker.descriptorPath, "--pin", pin,
  ], { timeout: 10_000, maxBuffer: 16_384, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  return JSON.parse(stdout);
}
async function until(check) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) { if (await check()) return; await sleep(20); }
  throw new Error("Bounded broker condition did not complete.");
}
async function fixture(t, writable = false) {
  const directory = resolve("tests", `.broker-${randomUUID()}`);
  const socketDirectory = resolve(`.b-${randomBytes(4).toString("hex")}`);
  await mkdir(directory, { mode: 0o700 }); await mkdir(socketDirectory, { mode: 0o700 });
  const root = join(directory, "root"), cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close().catch(() => {});
    await rm(directory, { recursive: true, force: true }); await rm(socketDirectory, { recursive: true, force: true });
  });
  for (const path of ["notes/Private", "skills", "papers", ".pkm/state/actions"])
    await mkdir(join(root, path), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nOriginal public content.\n", { mode: 0o600 });
  await writeFile(join(root, "notes/Private/Secret.md"), "Never granted.", { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"),
    JSON.stringify({ schema: 1, private: { notes: ["Private"] } }), { mode: 0o600 });
  await writeFile(join(root, ".pkm/state/actions/settings.json"), '{"configured":"not activated"}', { mode: 0o600 });
  const node = pinOriginalMcpBrokerFile(await realpath(process.execPath));
  const relay = pinOriginalMcpBrokerFile(resolve("dist/original-mcp-relay-cli.js"));
  const buildSha256 = hash("source-controlled synthetic runtime identity");
  const runtime = { node: { path: node.path, sha256: node.sha256 },
    relay: { path: relay.path, sha256: relay.sha256 }, buildSha256 };
  const manifest = { schema: "pkm.mcp.lifecycle/v1", managedRoot: directory, generation: "fixture",
    version: "0.1.0", runtimeBuild: buildSha256,
    components: { knowledge: "0.1.0", chat: "0.1.0", recipes: "0.1.0", agent_sessions: "0.1.0" },
    enabledFeatureDomains: [] };
  await writeFile(join(directory, "active-generation.json"), JSON.stringify({ schema: manifest.schema, generation: "fixture" }), { mode: 0o600 });
  const writerFence = await acquireOriginalMcpRootFence(root);
  cleanup.push(() => writerFence.release());
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "synthetic-operator", profileSha256: hash("native-profile-fixture"),
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608 } }, { writerFence });
  const authorization = { schema: "pkm.original-mcp-broker-authorization/v1", operatorId: plan.operatorId,
    profileSha256: plan.profileSha256, planSha256: plan.planSha256,
    acceptedScope: "knowledge-content-only/v1", writable };
  return { directory, socketDirectory, root, writerFence, plan, runtime, manifest, authorization, cleanup,
    options: { plan, writerFence, directory: socketDirectory, runtime, manifest, authorization } };
}
async function sdkClient(f, broker) {
  const launch = originalMcpRelayLaunch(broker.descriptorPath, broker.descriptorSha256);
  const transport = new StdioClientTransport({ ...launch, stderr: "pipe" });
  const client = new Client({ name: "isolated-broker-client", version: "1" });
  f.cleanup.push(() => client.close());
  await client.connect(transport);
  return { client, transport };
}
async function nativeFixture(t, writable = true) {
  const f = await fixture(t, writable);
  const opened = await openOriginalMcpRoot(f.plan, { writerFence: f.writerFence });
  f.cleanup.push(() => opened.owner.close());
  const lifetime = new AbortController(), approvals = [];
  let allowed = true, approvalHook = async () => {};
  const policy = {
    profileSha256: f.plan.profileSha256, sourceCatalogSha256: originalPublicMcpContracts().provenance.metadataSha256,
    authorityId: "synthetic-native-profile", epoch: "synthetic-native-epoch", signal: lifetime.signal,
    assertCurrent() {}, async authorizeAdmission() { return true; },
    async authorizePublic(binding) { approvals.push(binding); await approvalHook(); return allowed; },
    models: {
      configuration: {}, registryAvailability: {}, async credentialAvailable() { return false; },
      async authorizeRequest() { return false; },
      transport: { supports: () => false, async open() { throw new Error("No synthetic model execution."); } },
    },
  };
  const nativeHost = await createOriginalMcpNativeHost(opened.storage, policy);
  f.cleanup.push(() => nativeHost.close());
  return { ...f, ...opened, nativeHost, policy, lifetime, approvals,
    setAllowed: value => { allowed = value; }, setApprovalHook: value => { approvalHook = value; },
    options: { ...f.options, owner: opened.owner, storage: opened.storage, nativeHost,
      authorization: { ...f.authorization, acceptedScope: "native-dogfood/v1" } } };
}
async function rawClient(f, broker) {
  const launch = originalMcpRelayLaunch(broker.descriptorPath, broker.descriptorSha256);
  const child = spawn(launch.command, launch.args, { stdio: ["pipe", "pipe", "pipe"] });
  f.cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "close"); child.stdin.end(); await closed;
  });
  let pending = "";
  const values = new Map(), waiting = new Map();
  child.stdout.on("data", chunk => {
    pending += chunk.toString();
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      const value = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      if (value.id !== undefined) {
        const resolve = waiting.get(value.id);
        if (resolve) { waiting.delete(value.id); resolve(value); }
        else values.set(value.id, [...(values.get(value.id) ?? []), value]);
      }
    }
  });
  const wait = id => values.get(id)?.length ? Promise.resolve(values.get(id).shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Raw MCP response timeout.")), 10_000);
    waiting.set(id, value => { clearTimeout(timer); resolve(value); });
  });
  const send = value => child.stdin.write(typeof value === "string" ? value + "\n" : JSON.stringify(value) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "raw-fixture", version: "1" } } });
  await wait(1); send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { child, send, wait };
}

test("authenticated SDK relays share the actual cold owner while client quiesce/close and warm VS Code hosts stay isolated", async t => {
  const f = await fixture(t);
  await assert.rejects(startOriginalMcpBroker({ ...f.options,
    authorization: { ...f.authorization, acceptedScope: "full-original-mcp-parity" } }));
  f.writerFence.assertHeld();
  const broker = await startOriginalMcpBroker(f.options); f.cleanup.push(() => broker.stop());
  const verified = await verifyOriginalMcpBrokerDescriptor(broker.descriptorPath, broker.descriptorSha256, f.plan.profileSha256);
  assert.equal(verified.root, f.root);
  assert.equal(verified.scope, "knowledge-content-only/v1");
  assert(!("token" in verified)); assert(!("socket" in verified));
  assert(verified.disabledOperationIds.includes("mcp.tool.get_script"));
  assert.equal((await lstat(f.socketDirectory)).mode & 0o777, 0o700);
  const descriptor = readOriginalMcpBrokerDescriptor(broker.descriptorPath, broker.descriptorSha256).descriptor;
  assert.equal((await lstat(descriptor.socket.path)).mode & 0o777, 0o600);
  const lease = { ...broker.owner.workspaceLease() };
  const host = spawn(process.execPath, ["-e", "process.stdout.write('ready');process.stdin.resume();", "--", "--type=extensionHost"],
    { stdio: ["pipe", "pipe", "pipe"] });
  f.cleanup.push(async () => { const closed = once(host, "close"); host.stdin.end(); await closed; });
  await once(host.stdout, "data");
  assert((await inspectLinuxLegacyWriterQuiescence(f.root)).blockers.some(item => item.pid === host.pid));
  const [a, b] = await Promise.all([sdkClient(f, broker), sdkClient(f, broker)]);
  const versions = await Promise.all([a.client, b.client].map(client => client.callTool({ name: "check_version", arguments: {} })));
  assert.notEqual(result(versions[0]).runtime.instanceId, result(versions[1]).runtime.instanceId);
  assert(result(versions[0]).availability.disabledOperationIds.includes("mcp.tool.get_script"));
  assert.equal((await readNote(a.client)).isError, false);
  const denied = await b.client.callTool({ name: "capability_read",
    arguments: { operation: "mcp.tool.get_script", version: 1, arguments: { name: "anything" } } });
  assert.equal(denied.isError, true);
  const notWritable = await b.client.callTool({ name: "capability_call",
    arguments: { operation: "mcp.tool.add_note", version: 1, arguments: { title: "Not granted", content: "unchanged" } } });
  assert.equal(notWritable.isError, true);
  assert.equal(result(await a.client.callTool({ name: "mcp_lifecycle_quiesce", arguments: {} })).phase, "drained");
  assert.equal((await readNote(a.client)).isError, true);
  assert.equal((await readNote(b.client)).isError, false);
  await a.client.close();
  const c = await sdkClient(f, broker);
  assert.match(JSON.stringify(await readNote(c.client)), /Original public content/);
  assert.deepEqual(broker.owner.workspaceLease(), lease);
  f.writerFence.assertHeld();
  await broker.stop();
  assert.throws(() => f.writerFence.assertHeld(), { code: "STORAGE_UNAVAILABLE" });
});

test("authenticated server status observes all clients without creating a business session or granting handoff authority", async t => {
  const f = await fixture(t);
  const broker = await startOriginalMcpBroker(f.options); f.cleanup.push(() => broker.stop());
  const initial = await serverStatus(f, broker);
  assert.equal(initial.schema, "pkm.server-status/v1");
  assert.equal(initial.workspaceId, broker.status().workspaceId);
  assert.equal(initial.instanceId, broker.status().brokerId);
  assert.equal(initial.runtimeBuild, f.runtime.buildSha256);
  assert.equal(initial.phase, "accepting");
  assert.equal(initial.clients, 0);
  assert.equal(initial.inFlight, 0);
  assert.equal(initial.uncertainCalls, 0);
  assert.equal(initial.writable, false);
  assert.deepEqual(initial.handoff, { available: false,
    blockers: ["shared-routing-not-implemented", "unmanaged-writer-coverage-unverified"] });
  const [a, b] = await Promise.all([sdkClient(f, broker), sdkClient(f, broker)]);
  const lease = { ...broker.owner.workspaceLease() };
  const before = await readFile(join(f.root, "notes/Entry.md"));
  const current = await serverStatus(f, broker);
  assert.equal(current.clients, 2);
  assert.equal(current.instanceId, initial.instanceId);
  assert.equal(current.scope, "knowledge-content-only/v1");
  assert.equal(broker.status().clients, 2);
  const { descriptor } = readOriginalMcpBrokerDescriptor(broker.descriptorPath, broker.descriptorSha256);
  assert(!JSON.stringify(current).includes(descriptor.token));
  const statusSocket = connect(descriptor.socket.path);
  f.cleanup.push(async () => statusSocket.destroy());
  const statusClosed = once(statusSocket, "close"), messages = [];
  statusSocket.on("data", bytes => messages.push(bytes));
  await once(statusSocket, "connect");
  statusSocket.write(originalMcpBrokerAuthLine(descriptor, broker.descriptorSha256, true));
  await statusClosed;
  assert.equal(JSON.parse(Buffer.concat(messages).toString()).serverStatus.clients, 2);
  await assert.rejects(serverStatus(f, broker, "0".repeat(64)), error => {
    assert.equal(error.stdout, "");
    assert.match(error.stderr, /broker unavailable/);
    return true;
  });
  assert.equal((await readNote(b.client)).isError, false);
  await a.client.callTool({ name: "mcp_lifecycle_quiesce", arguments: {} });
  assert.equal((await serverStatus(f, broker)).phase, "accepting");
  assert.equal((await readNote(b.client)).isError, false);
  await a.client.close();
  await until(() => broker.status().clients === 1);
  assert.equal((await serverStatus(f, broker)).clients, 1);
  assert.deepEqual(await readFile(join(f.root, "notes/Entry.md")), before);
  assert.deepEqual(broker.owner.workspaceLease(), lease);
  await broker.stop();
  assert.equal(broker.serverStatus().phase, "closed");
  await assert.rejects(serverStatus(f, broker));
});

test("explicit-transport raw version lexemes and cancellation/close never grant authority, close the shared owner or replay writes", async t => {
  const f = await fixture(t, true);
  const broker = await startOriginalMcpBroker(f.options); f.cleanup.push(() => broker.stop());
  const raw = await rawClient(f, broker);
  for (const [id, version] of [[2, "1.0"], [3, "1e0"], [4, "1"]]) {
    raw.send(`{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"capability_read","arguments":{"operation":"mcp.tool.get_note","version":${version},"arguments":{"slug":"Entry"}}}}`);
    const reply = (await raw.wait(id)).result;
    assert.equal(reply.isError, version !== "1", `Raw ${version} contract must survive relay/auth/framing.`);
  }
  const duplicate = version => `{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"capability_read","arguments":{"operation":"mcp.tool.get_note","version":${version},"arguments":{"slug":"Entry"}}}}`;
  raw.send(duplicate("1.0") + "\n" + duplicate("1e0"));
  assert.equal((await raw.wait(22)).result.isError, true);
  assert.equal((await raw.wait(22)).result.isError, true, "Repeated request IDs cannot consume a shared one-bit lexical rejection.");
  const b = await sdkClient(f, broker);
  let release, locked;
  const entered = new Promise(ready => { locked = ready; });
  const barrier = new Promise(ready => { release = ready; });
  const blocked = broker.storage.withWorkspaceExclusive(async () => { locked(); await barrier; });
  f.cleanup.push(async () => { release(); await blocked; });
  await entered;
  raw.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "capability_call",
    arguments: { operation: "mcp.tool.update_note", version: 1, arguments: { slug: "Entry", content: "One committed update." } } } });
  raw.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "mcp_lifecycle_status", arguments: {} } });
  assert(result((await raw.wait(6)).result).inFlight >= 1);
  raw.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5, reason: "Synthetic client cancellation" } });
  const ended = once(raw.child, "close"); raw.child.stdin.end(); await ended;
  release(); await blocked;
  await until(async () => /One committed update/.test(await readFile(join(f.root, "notes/Entry.md"), "utf8")));
  const bytes = await readFile(join(f.root, "notes/Entry.md"), "utf8");
  assert.match(bytes, /revision: 2/);
  assert.equal((await readNote(b.client)).isError, false);
  broker.owner.assertWorkspaceLease();
});

test("authentication, independent pins, permissions and replaced descriptors fail closed without leaking tokens", async t => {
  const f = await fixture(t);
  const broker = await startOriginalMcpBroker(f.options); f.cleanup.push(() => broker.stop());
  const { descriptor } = readOriginalMcpBrokerDescriptor(broker.descriptorPath, broker.descriptorSha256);
  await assert.rejects(verifyOriginalMcpBrokerDescriptor(broker.descriptorPath, "0".repeat(64)), /BROKER_UNAVAILABLE/);
  await assert.rejects(verifyOriginalMcpBrokerDescriptor(broker.descriptorPath, broker.descriptorSha256, hash("wrong-profile")), /BROKER_UNAVAILABLE/);
  const alias = join(f.directory, "wrong-location.json");
  await writeFile(alias, await readFile(broker.descriptorPath), { mode: 0o600 });
  await assert.rejects(verifyOriginalMcpBrokerDescriptor(alias, broker.descriptorSha256), /BROKER_UNAVAILABLE/);
  const sameDirectoryAlias = join(f.socketDirectory, "not-the-published-descriptor.json");
  await writeFile(sameDirectoryAlias, await readFile(broker.descriptorPath), { mode: 0o600 });
  await assert.rejects(verifyOriginalMcpBrokerDescriptor(sameDirectoryAlias, broker.descriptorSha256), /BROKER_UNAVAILABLE/);
  for (const line of [originalMcpBrokerAuthLine({ ...descriptor, token: "0".repeat(64) }, broker.descriptorSha256),
    originalMcpBrokerAuthLine({ ...descriptor, token: "0".repeat(64) }, broker.descriptorSha256, true),
    originalMcpBrokerAuthLine(descriptor, broker.descriptorSha256, true) + '{"jsonrpc":"2.0"}\n',
    originalMcpBrokerAuthLine(descriptor, broker.descriptorSha256) + '{"jsonrpc":"2.0"}\n', "x".repeat(2049)]) {
    const socket = connect(descriptor.socket.path), responses = [];
    socket.on("data", value => responses.push(value)); socket.on("error", () => {});
    const closed = once(socket, "close"); await once(socket, "connect"); socket.write(line); await closed;
    assert.equal(Buffer.concat(responses).length, 0);
  }
  const { client } = await sdkClient(f, broker);
  assert.equal((await readNote(client)).isError, false);
  await chmod(broker.descriptorPath, 0o644);
  await assert.rejects(verifyOriginalMcpBrokerDescriptor(broker.descriptorPath, broker.descriptorSha256), /BROKER_UNAVAILABLE/);
  await until(() => broker.status().stopping);
  await broker.stop();
  assert.throws(() => broker.owner.assertWorkspaceLease(), { code: "STORAGE_UNAVAILABLE" });
  const g = await fixture(t);
  const other = await startOriginalMcpBroker(g.options); g.cleanup.push(() => other.stop());
  const original = await readFile(other.descriptorPath);
  await rename(other.descriptorPath, join(g.socketDirectory, "retained-descriptor.json"));
  await writeFile(other.descriptorPath, original, { mode: 0o600 });
  await until(() => other.status().stopping);
  await other.stop();
});

test("private cold broker CLI readiness and an actual SDK relay fail closed after unexpected broker death", async t => {
  const f = await fixture(t);
  await f.writerFence.release();
  const request = { schema: "pkm.original-mcp-broker-request/v1", plan: f.plan,
    directory: f.socketDirectory, runtime: f.runtime, manifest: f.manifest, authorization: f.authorization };
  const path = join(f.directory, "request.json"), bytes = Buffer.from(JSON.stringify(request));
  await writeFile(path, bytes, { mode: 0o600 });
  const child = spawn(process.execPath, [resolve("dist/original-mcp-broker-cli.js"), "serve", "--request", path, "--pin", hash(bytes)],
    { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const outputs = []; child.stdout.on("data", value => outputs.push(value));
  let errors = ""; child.stderr.on("data", value => { errors += value; });
  f.cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "close"); child.kill("SIGTERM"); await closed;
  });
  let ready = "";
  child.stdio[3].on("data", chunk => { ready += chunk; });
  await until(() => ready.includes("\n") || child.exitCode !== null);
  assert(ready.includes("\n"), errors);
  const info = JSON.parse(ready);
  assert.equal(info.schema, "pkm.original-mcp-broker-ready/v1");
  const { client } = await sdkClient(f, info);
  assert.equal((await readNote(client)).isError, false);
  const disconnected = new Promise(ready => { client.onclose = ready; });
  const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
  let deadline;
  try {
    await Promise.race([disconnected, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("Relay failed to terminate on broker exit.")), 10_000);
    })]);
  } finally { clearTimeout(deadline); }
  await assert.rejects(readNote(client));
  assert.equal(Buffer.concat(outputs).length, 0, "No descriptor token/readiness is emitted on stdout.");
  assert((await lstat(join(f.root, "core.sqlite"))).isFile(), "Uncertain native state is preserved after broker death.");
});

test("native dogfood relays use the already-open same owner, exact native approvals and truthful hybrid availability", async t => {
  const f = await nativeFixture(t);
  const lease = { ...f.owner.workspaceLease() };
  const broker = await startOriginalMcpNativeBroker(f.options); f.cleanup.push(() => broker.stop());
  assert.equal(broker.owner, f.owner); assert.equal(broker.storage, f.storage);
  const { descriptor } = readOriginalMcpBrokerDescriptor(broker.descriptorPath, broker.descriptorSha256);
  assert.equal(descriptor.scope, "native-dogfood/v1");
  assert.equal(descriptor.nativeHost.receiptSha256, f.nativeHost.receipt.receiptSha256);
  assert.equal(descriptor.nativeHost.catalogSha256, f.policy.sourceCatalogSha256);
  assert.deepEqual([...descriptor.availability.unconditionalOperationIds].sort(), [
    "action_artifact_export", "action_artifact_import", "action_call", "action_capabilities",
    "action_checkpoint_respond", "action_cosmos_configure", "action_definition_check", "action_get",
    "action_graph_check", "action_graph_save", "action_implementation_select", "action_module_set_export",
    "action_module_set_import", "action_module_set_load", "action_module_set_remove", "action_module_sets",
    "action_proposals", "action_register", "action_retrieve", "action_run_cancel", "action_run_checkpoints",
    "action_run_events", "action_run_gc", "action_run_get", "action_run_reconcile", "action_run_recover",
    "action_run_safety_scan", "action_run_wait", "action_run_wake", "action_template_create", "action_templates",
    "action_validate", "action_validation_cancel", "action_validation_enqueue", "action_validation_resume",
    "action_validation_status", "add_note", "add_paper", "add_skill", "diagnostics_latest",
    "get_knowledge", "get_note", "get_paper", "get_research", "get_script", "get_skill",
    "get_subscribed_content", "get_subscribed_content_by_path", "list_notes", "list_papers", "list_research",
    "list_skills", "list_subscriptions", "paper_graph", "portal_control", "propose_skill_update",
    "recipe_capabilities", "recipe_create_from_skill", "recipe_run_get", "recipe_run_next",
    "recipe_run_progress", "recipe_run_report", "recipe_run_start", "recipe_run_start_adhoc",
    "recipe_run_submit_input", "recipe_search", "retrieval_feedback", "retrieval_status",
    "search_knowledge", "search_notes", "search_papers", "search_research", "search_scripts", "search_skills",
    "search_subscribed_content", "skill_capabilities", "skill_context", "skill_feedback",
  ].map(name => `mcp.tool.${name}`).sort());
  assert.deepEqual(descriptor.availability.conditionalOperationIds,
    ["mcp.tool.update_note", "mcp.tool.update_paper", "mcp.tool.update_skill"]);
  assert.equal(descriptor.availability.enabledOperationIds.length + descriptor.availability.disabledOperationIds.length, 151);
  assert(descriptor.availability.disabledOperationIds.includes("mcp.tool.api_chat_send"));
  const malformedPath = join(f.socketDirectory, "malformed-native-descriptor.json");
  for (const change of [
    { scope: "knowledge-content-only/v1" },
    { nativeHost: { ...descriptor.nativeHost, catalogSha256: "not-a-digest" } },
    { availability: { ...descriptor.availability,
      unconditionalOperationIds: [...descriptor.availability.unconditionalOperationIds, "mcp.tool.update_note"] } },
  ]) {
    const bytes = Buffer.from(JSON.stringify({ ...descriptor, ...change, descriptorPath: malformedPath }));
    await writeFile(malformedPath, bytes, { mode: 0o600 });
    assert.throws(() => readOriginalMcpBrokerDescriptor(malformedPath, hash(bytes)), /BROKER_UNAVAILABLE/);
  }
  const [a, b] = await Promise.all([sdkClient(f, broker), sdkClient(f, broker)]);
  const tools = (await a.client.listTools()).tools.map(item => item.name);
  assert(tools.includes("note_read")); assert(tools.includes("note_modify"));
  assert(tools.includes("skill_read")); assert(!tools.includes("api_chat_send"));
  const availability = result(await a.client.callTool({ name: "check_version", arguments: {} })).availability;
  assert.deepEqual(availability, descriptor.availability);
  const before = f.approvals.length;
  assert.match(JSON.stringify(await a.client.callTool({ name: "note_read", arguments: { slug: "Entry" } })),
    /Original public content/);
  assert.equal(f.approvals.length, before + 1);
  assert.equal(f.approvals.at(-1).request.operation, "mcp.tool.get_note");
  assert.doesNotMatch(JSON.stringify(await b.client.callTool({ name: "note_read", arguments: { slug: "Private/Secret" } })),
    /Never granted/);
  const updated = await a.client.callTool({ name: "note_modify",
    arguments: { slug: "Entry", content: "Committed through the actual native broker." } });
  assert.notEqual(updated.isError, true);
  assert.match(await readFile(join(f.root, "notes/Entry.md"), "utf8"), /actual native broker/);
  f.setAllowed(false);
  assert.equal((await b.client.callTool({ name: "note_modify",
    arguments: { slug: "Entry", content: "Denied native write." } })).isError, true);
  assert.doesNotMatch(await readFile(join(f.root, "notes/Entry.md"), "utf8"), /Denied native write/);
  f.setAllowed(true);
  assert.notEqual((await b.client.callTool({ name: "capability_read",
    arguments: { operation: "mcp.tool.action_capabilities", version: 1, arguments: {} } })).isError, true);
  assert.equal((await b.client.callTool({ name: "capability_read",
    arguments: { operation: "memory.record.search", version: 1, arguments: {} } })).isError, true);
  await a.client.callTool({ name: "mcp_lifecycle_quiesce", arguments: {} });
  await a.client.close();
  assert.match(JSON.stringify(await readNote(b.client)), /actual native broker/);
  assert.deepEqual(f.owner.workspaceLease(), lease);
  await broker.stop();
  assert.equal((await broker.closed).reason, "maintenance");
  f.writerFence.assertHeld(); f.owner.assertWorkspaceLease(); f.storage.assertWorkspaceLease();
  assert.deepEqual(f.owner.workspaceLease(), lease);
  f.nativeHost.assertCurrent();
});

test("native broker refuses forged, foreign-root, catalog-mismatched and wrong-scope attachments without closing their owners", async t => {
  const f = await nativeFixture(t), g = await nativeFixture(t);
  const wrongCatalog = await createOriginalMcpNativeHost(f.storage, { ...f.policy, sourceCatalogSha256: hash("wrong catalog") });
  const withoutPublic = await createOriginalMcpNativeHost(f.storage, { ...f.policy, authorizePublic: undefined });
  f.cleanup.push(() => wrongCatalog.close(), () => withoutPublic.close());
  for (const change of [
    { owner: { ...f.owner } }, { storage: { ...f.storage } }, { nativeHost: { ...f.nativeHost } },
    { owner: g.owner }, { storage: g.storage }, { nativeHost: g.nativeHost },
    { nativeHost: wrongCatalog }, { nativeHost: withoutPublic },
    { writerFence: { assertHeld() {} } },
    { authorization: f.authorization },
    { authorization: { ...f.options.authorization, acceptedScope: "preserve-existing-mcp/v1" } },
  ]) {
    await assert.rejects(startOriginalMcpNativeBroker({ ...f.options, ...change }));
    f.owner.assertWorkspaceLease(); g.owner.assertWorkspaceLease(); f.writerFence.assertHeld();
  }
  await assert.rejects(startOriginalMcpBroker(f.options));
  const broker = await startOriginalMcpNativeBroker({ ...f.options,
    authorization: { ...f.options.authorization, writable: false } });
  f.cleanup.push(() => broker.stop());
  const { descriptor } = readOriginalMcpBrokerDescriptor(broker.descriptorPath, broker.descriptorSha256);
  assert(!descriptor.availability.enabledOperationIds.includes("mcp.tool.add_note"));
  assert.deepEqual(descriptor.availability.conditionalOperationIds, []);
  const { client } = await sdkClient(f, broker);
  assert.match(JSON.stringify(await readNote(client)), /Original public content/);
  assert.equal((await client.callTool({ name: "capability_call",
    arguments: { operation: "mcp.tool.add_note", version: 1, arguments: { title: "Not granted", content: "Not written" } } })).isError, true);
});

test("native broker stop drains an admitted write before disconnecting clients but leaves owner lifetime to bootstrap", async t => {
  const f = await nativeFixture(t);
  const broker = await startOriginalMcpNativeBroker(f.options); f.cleanup.push(() => broker.stop());
  const { client } = await sdkClient(f, broker);
  let release, entered;
  const barrier = new Promise(ready => { release = ready; });
  const admission = new Promise(ready => { entered = ready; });
  f.cleanup.push(async () => release());
  f.setApprovalHook(async () => { entered(); await barrier; });
  const writing = client.callTool({ name: "note_modify", arguments: { slug: "Entry", content: "One drained native update." } });
  await admission;
  const active = await serverStatus(f, broker);
  assert.equal(active.clients, 1);
  assert.equal(active.inFlight, 1);
  assert.equal(active.phase, "accepting");
  let stopped = false;
  const closing = broker.stop().then(() => { stopped = true; });
  await sleep(50);
  assert.equal(stopped, false);
  const draining = await serverStatus(f, broker);
  assert.equal(draining.phase, "draining");
  assert.equal(draining.inFlight, 1);
  f.owner.assertWorkspaceLease();
  release();
  const [reply] = await Promise.all([writing, closing]);
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  assert.match(JSON.stringify(reply), /Entry/);
  assert.match(await readFile(join(f.root, "notes/Entry.md"), "utf8"), /One drained native update/);
  assert.match(await readFile(join(f.root, "notes/Entry.md"), "utf8"), /revision: 2/);
  f.owner.assertWorkspaceLease(); f.writerFence.assertHeld();
  assert.equal(broker.serverStatus().phase, "closed");
});

test("revoking a genuine native session closes its business broker, not the bootstrap owner", async t => {
  const f = await nativeFixture(t);
  const broker = await startOriginalMcpNativeBroker(f.options); f.cleanup.push(() => broker.stop());
  const { client } = await sdkClient(f, broker);
  assert.match(JSON.stringify(await readNote(client)), /Original public content/);
  const disconnected = new Promise(ready => { client.onclose = ready; });
  f.lifetime.abort();
  assert.equal((await broker.closed).reason, "critical-failure");
  await disconnected;
  await assert.rejects(readNote(client));
  f.owner.assertWorkspaceLease(); f.storage.assertWorkspaceLease(); f.writerFence.assertHeld();
});

test("native broker drain failures reject stop and closed visibly without closing the bootstrap owner", async t => {
  const f = await nativeFixture(t);
  const broker = await startOriginalMcpNativeBroker(f.options); f.cleanup.push(() => broker.stop());
  const { client } = await sdkClient(f, broker);
  assert.match(JSON.stringify(await readNote(client)), /Original public content/);
  const originalClose = NativePublicMcpLifecycle.prototype.close;
  const exitCode = process.exitCode;
  NativePublicMcpLifecycle.prototype.close = async function() {
    await originalClose.call(this);
    throw new Error("Synthetic client drain failure.");
  };
  try {
    await assert.rejects(broker.stop(), /broker drain failed/);
    await assert.rejects(broker.closed, /broker drain failed/);
  } finally {
    NativePublicMcpLifecycle.prototype.close = originalClose;
    await sleep(0);
    process.exitCode = exitCode;
  }
  assert.equal(broker.status().reason, "critical-failure");
  assert.equal(broker.serverStatus().phase, "action-required");
  f.owner.assertWorkspaceLease(); f.storage.assertWorkspaceLease(); f.writerFence.assertHeld();
});
