import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OriginalPortalBusiness } from "../dist/original-mcp-portal-business.js";
import { originalPortalInput } from "../dist/original-mcp-portal-contracts.js";
import { createOriginalMcpNativePortalSource } from "../dist/original-mcp-portal-source.js";
import { RuntimeProcessService, RuntimeProcessStore } from "../dist/runtime-process.js";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { createOriginalMcpPortalRuntime } from "../dist/original-mcp-portal.js";
import { pythonMetadataJson, createNativePublicFacade } from "../dist/native-public-mcp.js";
import { startOriginalMcpNativeAttachmentServer } from "../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import { createOriginalMcpNativeChatProducerChannel, createOriginalMcpNativeChatRpcPort,
  waitForOriginalMcpNativeChatSupport } from "../dist/original-mcp-native-chat-rpc.js";
import { createOriginalMcpNativeRequestPolicy, parseOriginalMcpNativeRequest, originalMcpNativeRequestSession,
  originalMcpNativeRequestProtocol, originalMcpNativeResult, waitForOriginalMcpNativeSupport } from "../dist/original-mcp-native-request.js";

const hash = value => createHash("sha256").update(value).digest("hex");
let socketSequence = 0;
const input = (operation, values = {}) => originalPortalInput.parse({
  host_id: randomUUID(), command_id: randomUUID(), operation, ...values,
});
const until = async check => {
  for (let count = 0; count < 500; count++) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Owned Portal fixture deadline exceeded.");
};

async function pairFixture(t, { native = false } = {}) {
  const directory = resolve("tests", `.portal-${randomUUID()}`), root = join(directory, "root");
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".pkm"), { mode: 0o700 });
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nPortal fixture.\n", { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const destination = join(directory, "incoming");
  await mkdir(destination, { mode: 0o700 });
  const controls = { allowCommands: true, allowFiles: true, approvals: [], executions: 0, link: undefined, changed: undefined,
    role: "controller", saved: false, permissionGrant: { mode: "scoped", permissions: ["progress-read"], durationMs: 1000 } };
  const processDb = new DatabaseSync(":memory:");
  const processRuntime = new RuntimeProcessService({
    repositoryFactory: (owner, capacity) => new RuntimeProcessStore(processDb, owner, capacity),
    adapters: [{ id: "fixture-print", executable: "/usr/bin/printf", cwd: root, env: {},
      arguments(value) { assert.deepEqual(value, ["portal-owned-loopback"]); return value; } },
      { id: "fixture-hold", executable: process.execPath, cwd: root, env: {},
        arguments(value) { assert.deepEqual(value, ["-e", "setInterval(()=>{},1000)"]); return value; } }],
    authorizeLaunch: async () => true,
  });
  const executeCommand = async (command, signal, requestId) => {
    const hold = command.program === process.execPath;
    assert.equal(command.program, hold ? process.execPath : "/usr/bin/printf");
    assert.deepEqual(command.arguments, hold ? ["-e", "setInterval(()=>{},1000)"] : ["portal-owned-loopback"]);
    controls.executions++;
    const job = await processRuntime.launch({ actorId: "portal:fixture", adapterId: hold ? "fixture-hold" : "fixture-print",
      operationId: requestId, input: command.arguments, deadlineMs: hold ? 10000 : 1000 });
    const cancel = () => void processRuntime.cancel("portal:fixture", job.jobId);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const ended = await processRuntime.wait("portal:fixture", job.jobId);
      return { execution: "direct-command", modelCalls: 0,
        state: ended.state === "SUCCEEDED" ? "complete" : ended.state === "CANCELLED" ? "cancelled" : "failed", exitCode: ended.exitCode,
        stdout: Buffer.from(ended.stdout, "base64").toString("utf8") };
    } finally { signal.removeEventListener("abort", cancel); }
  };
  const consent = async request => {
    controls.approvals.push(structuredClone(request));
    if (request.phase === "pair-code") controls.link = request.detail.privateLink;
    if (request.phase === "command" && !controls.allowCommands || request.phase === "files" && !controls.allowFiles)
      return { decision: "deny" };
    await controls.changed?.(request);
    return { decision: "approve", ...(request.phase === "open" ? { role: controls.role,
      ...(controls.role === "controlled" ? { privateLink: controls.link } : {}) } : {}),
      ...(request.phase === "open" && controls.saved ? { name: `owned-${controls.role}`, localMachine: "owned-fixture" } : {}),
      ...(request.phase === "permissions" ? { grant: controls.permissionGrant } : {}) };
  };
  const options = { root, assertCurrent() {}, consent, executeCommand, destination: () => destination,
    commandCapabilities: ["platform:linux", "program:printf"], executeTask: async () => { throw new Error("No model/task fixture selected."); },
    taskAttempts: async () => { throw new Error("No manual-rerun fixture selected."); } };
  const remote = new OriginalPortalBusiness({ ...options, consent: async request => {
    if (request.phase === "open") return { decision: "approve", role: "controlled", privateLink: controls.link };
    return consent(request);
  } });
  const closes = [async () => { await processRuntime.close(); processDb.close(); }, () => remote.close()];
  t.after(async () => {
    for (const close of closes.reverse()) await close();
    await rm(directory, { recursive: true, force: true });
  });
  if (!native) {
    const local = new OriginalPortalBusiness(options); closes.push(() => local.close());
    const opening = local.invoke(input("open"));
    await until(() => controls.link);
    const other = await remote.invoke(input("open"));
    const opened = await opening;
    assert.equal(opened.connected, true); assert.equal(other.connected, true);
    return { local, remote, opened, other, controls, root, directory, destination };
  }
  const custody = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "portal-fixture", profileSha256: hash("portal-current-native-profile"),
    limits: { maxEntries: 100, maxDepth: 16, maxBytes: 1048576, maxFileBytes: 1048576 } });
  const opened = await openOriginalMcpRoot(custody); closes.push(() => opened.owner.close());
  const socketDirectory = resolve(`.p${++socketSequence}`);
  await mkdir(socketDirectory, { mode: 0o700 });
  const keys = generateKeyPairSync("ed25519"), identity = originalMcpNativeIdentity(
    keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), custody.profileSha256);
  const activationId = randomUUID();
  const binding = { root, workspaceId: opened.workspaceId, planSha256: custody.planSha256,
    profileSha256: custody.profileSha256, catalogSha256: originalPublicMcpContracts().provenance.metadataSha256,
    payloadBuildId: hash("portal-fixture-build"), hostEntrySha256: hash("portal-fixture-host") };
  const server = await startOriginalMcpNativeAttachmentServer({
    directory: socketDirectory, identity, identitySha256: identity.sha256, binding,
    heartbeatIntervalMs: 200, heartbeatTimeoutMs: 3000,
  });
  const lifetime = new AbortController(), socket = connect(join(socketDirectory, "n"));
  const state = new Map(), secrets = new Map();
  const { PortalEndpointStore } = createRequire(import.meta.url)("../dist/legacy-chatroom-retained.cjs");
  const sourceStore = new PortalEndpointStore({
    get(key) { return state.get(key); }, async update(key, value) { state.set(key, structuredClone(value)); },
  }, { async get(key) { return secrets.get(key); }, async store(key, value) { secrets.set(key, value); },
    async delete(key) { secrets.delete(key); } });
  const portalSource = createOriginalMcpNativePortalSource({
    assertCurrent() { assert(!lifetime.signal.aborted); }, store: () => sourceStore,
    decide: request => consent(request),
  });
  let buffer = "", producer, sessionView, host;
  socket.on("error", () => {});
  socket.on("close", () => lifetime.abort());
  const send = frame => new Promise((resolve, reject) =>
    socket.write(JSON.stringify(frame) + "\n", error => error ? reject(error) : resolve()));
  socket.on("data", chunk => {
    buffer += chunk.toString("utf8");
    for (let end; (end = buffer.indexOf("\n")) !== -1;) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, activationId);
        void send({ type: "attestation", attestation: { ...body,
          signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") {
        sessionView = { brokerId: frame.brokerId, activationId, epoch: activationId, identitySha256: identity.sha256, binding };
        producer = createOriginalMcpNativeChatProducerChannel({
          session: sessionView, signal: lifetime.signal, assertCurrent() { assert(!lifetime.signal.aborted); }, send,
          close() { socket.destroy(); },
          models: { async catalogue() { return { source: "vscode.lm", epoch: activationId, models: [] }; },
            async select() { throw new Error("No model selected."); }, async count() { throw new Error("No model selected."); },
            async *stream() { throw new Error("No model selected."); } },
          execution: { async run() { throw new Error("No model selected."); } },
        });
        void producer.support();
        void send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session: sessionView,
          methods: ["admission.approve", "public.approve", "credential.present", "portal.local.approve"], maxPacketBytes: 65536 });
      } else if (frame.type === "ping") void send({ type: "pong", nonce: frame.nonce });
      else if (frame.type.startsWith("native-chat-")) producer.receive(frame);
      else if (frame.type === "native-request") {
        const request = parseOriginalMcpNativeRequest(frame, sessionView);
        void (async () => {
          const value = request.method === "portal.local.approve"
            ? await portalSource.handle(request, lifetime.signal)
            : request.method === "credential.present" ? { present: false } : { decision: "approve" };
          await send(originalMcpNativeResult(request, value));
        })().catch(error => { console.error(error); socket.destroy(); });
      }
    }
  });
  const session = await server.waitForSession({ timeoutMs: 2000 });
  await waitForOriginalMcpNativeChatSupport(session, { timeoutMs: 2000 });
  await waitForOriginalMcpNativeSupport(session, { timeoutMs: 2000 });
  assert.deepEqual(originalMcpNativeRequestSession(session), sessionView);
  host = await createOriginalMcpNativeHost(opened.storage, createOriginalMcpNativeRequestPolicy(session),
    { nativeChat: createOriginalMcpNativeChatRpcPort(session) });
  closes.push(async () => {
    await host.close(); lifetime.abort(); await producer.dispose(); socket.destroy(); await server.close();
    await rm(socketDirectory, { recursive: true });
  });
  const backend = createNativePublicOwnerBackend(opened.owner, { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: host });
  closes.push(() => backend.close());
  await writeFile(join(directory, "active-generation.json"), '{"schema":"pkm.mcp.lifecycle/v1","generation":"portal-fixture"}', { mode: 0o600 });
  const facade = createNativePublicFacade(backend, { writable: true, catalogProfile: "original-full",
    manifest: { managedRoot: directory, generation: "portal-fixture", version: "0.1.0", components: {} }, closeBackend: async () => {} });
  const call = async (operation, values = {}) => (await facade.invoke("capability_call", {
    operation: "mcp.tool.portal_control", version: 1,
    arguments: { host_id: opened.workspaceId, operation, command_id: randomUUID(), ...values },
  })).structuredContent;
  const receipt = id => until(async () => {
    const value = (await facade.invoke("capability_read", { operation: "mcp.tool.api_chat_request_get", version: 1,
      arguments: { host_id: opened.workspaceId, request_id: id } })).structuredContent;
    return ["queued", "running"].includes(value.status) ? undefined : value;
  });
  return { remote, controls, opened, host, backend, call, receipt, directory, closes, sourceStore };
}

test("exact Original Portal validator preserves handles, command bounds and explicit requirements", () => {
  assert.throws(() => input("status"));
  assert.throws(() => input("command", { context_id: randomUUID(), request_id: randomUUID(), command: {
    program: "printf", arguments: Array(33).fill("x") } }));
  assert.throws(() => input("route", { request_id: randomUUID(), command: { program: "printf", arguments: [] }, requirements: {} }));
  assert.throws(() => input("connections", { file_paths: ["/owned"] }));
});

test("actual Original Portal peer/relay runs one approved allowlisted command, denies code under read-only consent and never repeats request UUID", async t => {
  const f = await pairFixture(t), requestId = randomUUID(), command = { program: "/usr/bin/printf", arguments: ["portal-owned-loopback"] };
  f.controls.allowCommands = false;
  await f.local.invoke(input("command", { context_id: f.opened.contextId, request_id: requestId, command }));
  const denied = await until(async () => {
    const value = await f.local.invoke(input("get", { context_id: f.opened.contextId, request_id: requestId }));
    return value.receipt.state === "denied" ? value : undefined;
  });
  assert.equal(denied.receipt.state, "denied"); assert.equal(f.controls.executions, 0);
  f.controls.allowCommands = true;
  const nextId = randomUUID();
  await f.local.invoke(input("route", { context_id: f.opened.contextId, request_id: nextId, command,
    requirements: { platform: "linux", programs: ["printf"] } }));
  const complete = await until(async () => {
    const value = await f.local.invoke(input("get", { context_id: f.opened.contextId, request_id: nextId }));
    return ["completed", "failed", "denied", "cancelled"].includes(value.receipt.state) ? value : undefined;
  });
  assert.equal(complete.receipt.state, "completed", JSON.stringify(complete));
  assert.equal(complete.receipt.result.stdout, "portal-owned-loopback");
  assert.equal(complete.receipt.result.modelCalls, 0);
  await f.local.invoke(input("command", { context_id: f.opened.contextId, request_id: nextId, command }));
  assert.equal(f.controls.executions, 1);
  await assert.rejects(f.local.invoke(input("command", { context_id: f.opened.contextId, request_id: nextId,
    command: { ...command, arguments: ["changed"] } })));
  await f.local.invoke(input("disconnect", { context_id: f.opened.contextId }));
  await assert.rejects(f.local.invoke(input("route", { request_id: randomUUID(), command,
    requirements: { platform: "linux" } })), /No connected Portal/);
});

test("actual Original Portal file engine requires controlled consent for every batch and verifies delivery", async t => {
  const f = await pairFixture(t), file = join(f.directory, "offered.txt");
  await writeFile(file, "owned-file-bytes", { mode: 0o600 });
  f.controls.allowFiles = false;
  f.controls.permissionGrant = { mode: "all", durationMs: 1000 };
  const permissions = await f.remote.invoke(input("permissions", { context_id: f.other.contextId }));
  assert.equal(permissions.access.permissions.mode, "all");
  const denied = await f.local.invoke(input("files", { context_id: f.opened.contextId, file_paths: [file] }));
  await until(async () => {
    const value = await f.local.invoke(input("status", { context_id: f.opened.contextId }));
    return value.transfers.some(item => item.transferId === denied.transferId && item.state === "cancelled");
  });

  await assert.rejects(readFile(join(f.destination, "offered.txt")), { code: "ENOENT" });
  f.controls.allowFiles = true;
  await f.local.invoke(input("files", { context_id: f.opened.contextId, file_paths: [file] }));
  await until(async () => { try { return await readFile(join(f.destination, "offered.txt"), "utf8") === "owned-file-bytes"; } catch { return false; } });
  assert(f.controls.approvals.filter(item => item.phase === "files").length >= 2);
});

test("actual Portal cancellation targets only the original attempt and does not launch a replacement", async t => {
  const f = await pairFixture(t), requestId = randomUUID();
  await f.local.invoke(input("command", { context_id: f.opened.contextId, request_id: requestId,
    command: { program: process.execPath, arguments: ["-e", "setInterval(()=>{},1000)"] } }));
  await until(() => f.controls.executions === 1);
  await f.local.invoke(input("cancel", { context_id: f.opened.contextId, request_id: requestId }));
  const cancelled = await until(async () => {
    const value = await f.local.invoke(input("get", { context_id: f.opened.contextId, request_id: requestId }));
    return ["cancelled", "unknown"].includes(value.receipt.state) ? value : undefined;
  });
  assert(["cancelled", "unknown"].includes(cancelled.receipt.state));
  assert.equal(f.controls.executions, 1);
});

test("context changed concurrently during independent approval invalidates that approval before dispatch", async t => {
  const f = await pairFixture(t);
  f.controls.changed = async request => {
    if (request.phase !== "external") return;
    f.controls.changed = undefined;
    await f.local.invoke(input("disconnect", { context_id: f.opened.contextId }));
  };
  await assert.rejects(f.local.invoke(input("command", { context_id: f.opened.contextId, request_id: randomUUID(),
    command: { program: "/usr/bin/printf", arguments: ["portal-owned-loopback"] } })), /CONTEXT_CHANGED/);
  assert.equal(f.controls.executions, 0);
});

test("existing Portal permission leases have a fixed deadline and expire without renewal from reads", async t => {
  const f = await pairFixture(t);
  const granted = await f.remote.invoke(input("permissions", { context_id: f.other.contextId }));
  assert.deepEqual(granted.access.permissions.dimensions, ["progress-read"]);
  const expiry = granted.access.permissions.expiresAt;
  const status = await f.remote.invoke(input("status", { context_id: f.other.contextId }));
  assert.equal(status.access.permissions.expiresAt, expiry);
  await new Promise(resolve => setTimeout(resolve, 1100));
  const expired = await f.remote.invoke(input("status", { context_id: f.other.contextId }));
  assert.equal(expired.access.permissions, undefined);
});

test("actual original public route uses authenticated native consent and owned loopback Portal business handler", async t => {
  const f = await pairFixture(t, { native: true });
  const submitted = await f.call("open", { command_id: "public-open-once" });
  assert.match(submitted.request_id, /^[a-f0-9]{64}$/);
  await until(() => f.controls.link);
  const peer = await f.remote.invoke(input("open"));
  assert.equal(peer.connected, true);
  const opened = await f.receipt(submitted.request_id);
  assert.equal(opened.status, "succeeded", opened.error);
  assert.equal(opened.result.connected, true);
  const context = opened.result.contextId;
  const connections = await f.receipt((await f.call("connections")).request_id);
  assert.equal(connections.result.active, 1);
  const requestId = randomUUID();
  await f.receipt((await f.call("command", { context_id: context, request_id: requestId,
    command: { program: "/usr/bin/printf", arguments: ["portal-owned-loopback"] } })).request_id);
  const completed = await until(async () => {
    const value = await f.receipt((await f.call("get", { context_id: context, request_id: requestId })).request_id);
    return value.result?.receipt?.state === "completed" ? value : undefined;
  });
  assert.equal(completed.result.receipt.result.stdout, "portal-owned-loopback");
  assert.equal(f.controls.executions, 1);
  const duplicate = await f.call("open", { command_id: "public-open-once" });
  assert.equal(duplicate.request_id, submitted.request_id);
  await assert.rejects(f.call("connections", { command_id: "public-open-once" }), /command_id/);
  await assert.rejects(f.call("status", { host_id: randomUUID(), context_id: context }), /exact current native Host/);
});

test("public runtime restarts fence pending effects without reconstructing remote results or replaying", async t => {
  const f = await pairFixture(t, { native: true });
  const submitted = await f.call("open", { command_id: "crash-owned" });
  const requestId = hash(pythonMetadataJson([f.opened.workspaceId, "crash-owned"]));
  assert.equal(submitted.request_id, requestId);
  await until(() => f.controls.link);
  const privateLink = f.controls.link, session = f.host.nativeChat.session;
  await f.host.close();
  const replacement = await createOriginalMcpNativeHost(f.opened.storage, createOriginalMcpNativeRequestPolicy(session),
    { nativeChat: createOriginalMcpNativeChatRpcPort(session) });
  f.closes.push(() => replacement.close());
  const runtime = await createOriginalMcpPortalRuntime(f.opened.owner, { id: "mcp:external", canWrite: true }, replacement);
  f.closes.push(() => runtime.close());
  const receipt = runtime.readReceipt(requestId);
  assert.equal(receipt.status, "outcome_unknown"); assert.equal(receipt.result, null);
  assert.equal(f.controls.executions, 0); assert.equal(f.controls.link, privateLink);
  const duplicate = (await runtime.invoke("portal_control", { host_id: f.opened.workspaceId,
    operation: "open", command_id: "crash-owned" })).structuredContent;
  assert.equal(duplicate.status, "outcome_unknown");
  assert.equal(f.controls.link, privateLink, "No replacement pairing code or task was produced.");
});

test("two actual public native Hosts execute the approved command through the real controlled runtime process adapter", async t => {
  const controller = await pairFixture(t, { native: true }), controlled = await pairFixture(t, { native: true });
  const opening = await controller.call("open");
  await until(() => controller.controls.link);
  controlled.controls.role = "controlled";
  controlled.controls.link = controller.controls.link;
  const accepting = await controlled.call("open");
  const controllerOpen = await controller.receipt(opening.request_id), controlledOpen = await controlled.receipt(accepting.request_id);
  assert.equal(controllerOpen.result.connected, true); assert.equal(controlledOpen.result.connected, true);
  controlled.controls.allowCommands = false;
  const deniedId = randomUUID();
  await controller.receipt((await controller.call("command", { context_id: controllerOpen.result.contextId,
    request_id: deniedId, command: { program: "/usr/bin/printf", arguments: ["portal-owned-loopback"] } })).request_id);
  await until(async () => {
    const receipt = await controller.receipt((await controller.call("get", {
      context_id: controllerOpen.result.contextId, request_id: deniedId })).request_id);
    return receipt.result?.receipt?.state === "denied";
  });

  controlled.controls.allowCommands = true;
  const requestId = randomUUID();
  await controller.receipt((await controller.call("command", { context_id: controllerOpen.result.contextId,
    request_id: requestId, command: { program: "/usr/bin/printf", arguments: ["portal-owned-loopback"], timeoutSeconds: 86400 } })).request_id);
  const completed = await until(async () => {
    const receipt = await controller.receipt((await controller.call("get", {
      context_id: controllerOpen.result.contextId, request_id: requestId })).request_id);
    return ["completed", "failed", "unknown"].includes(receipt.result?.receipt?.state) ? receipt : undefined;
  });
  assert.equal(completed.result.receipt.state, "completed", JSON.stringify(completed));
  assert.equal(completed.result.receipt.result.stdout, "portal-owned-loopback");
  assert.equal(completed.result.receipt.result.modelCalls, 0);
  assert.equal(controlled.controls.executions, 0, "The fixture executeCommand callback must not execute this native-public command.");
});

test("registered native named-endpoint producer saves only a fresh pairing, explicitly reconnects and revokes changed source", async t => {
  const controller = await pairFixture(t, { native: true }), controlled = await pairFixture(t, { native: true });
  controller.controls.saved = true; controlled.controls.saved = true;
  controlled.controls.role = "controlled";
  const opening = await controller.call("open");
  await until(() => controller.controls.link);
  controlled.controls.link = controller.controls.link;
  const accepting = await controlled.call("open");
  const first = await controller.receipt(opening.request_id), second = await controlled.receipt(accepting.request_id);
  assert.equal(first.status, "succeeded", first.error); assert.equal(second.status, "succeeded", second.error);
  assert.equal(first.result.persistentEndpoint, true); assert.equal(second.result.connected, true);
  const endpointId = first.result.contextId, otherId = second.result.contextId;
  const nativeSaved = controller.sourceStore.get(endpointId);
  assert.equal(nativeSaved.root, controller.opened.storage.workspaceRoot());
  assert.equal(nativeSaved.paired.binding.pairId, first.result.binding.pairId);
  assert.equal(typeof await controller.sourceStore.credential(endpointId), "string");
  const inventory = await controller.receipt((await controller.call("connections")).request_id);
  assert.equal(inventory.result.endpoints[0].id, endpointId);
  assert.equal(inventory.result.endpoints[0].pairingStored, true);
  assert(!JSON.stringify(inventory).includes(await controller.sourceStore.credential(endpointId)));
  assert.equal((await controller.receipt((await controller.call("disconnect", { context_id: endpointId })).request_id)).status, "succeeded");
  assert.equal((await controlled.receipt((await controlled.call("disconnect", { context_id: otherId })).request_id)).status, "succeeded");
  const rehost = await controller.call("open", { context_id: endpointId });
  const reconnect = await controlled.call("open", { context_id: otherId });
  const reopened = await controller.receipt(rehost.request_id), rejoined = await controlled.receipt(reconnect.request_id);
  assert.equal(reopened.status, "succeeded", reopened.error); assert.equal(rejoined.status, "succeeded", rejoined.error);
  assert.equal(reopened.result.binding.pairId, first.result.binding.pairId);
  assert.equal(controller.controls.executions, 0);
  const current = controlled.sourceStore.get(otherId);
  await controlled.sourceStore.update(otherId, { deleted: true }, current.revision);
  await until(async () => {
    const status = await controller.receipt((await controller.call("status", { context_id: endpointId })).request_id);
    return status.result?.connected === false;
  });
  assert.equal(controlled.sourceStore.get(otherId).acceptsIncoming, false);
});
