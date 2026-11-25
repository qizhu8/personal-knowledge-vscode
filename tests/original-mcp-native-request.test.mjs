import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startOriginalMcpNativeAttachmentServer } from "../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import {
  originalMcpNativeRequestProtocol, originalMcpNativeRequestMethods, originalMcpNativeRequestSession,
  parseOriginalMcpNativeRequest, originalMcpNativeResult, originalMcpNativeErrorResult,
  requestOriginalMcpNative, createOriginalMcpNativeRequestPolicy, waitForOriginalMcpNativeSupport,
  bindOriginalMcpNativeRequestTransport,
} from "../dist/original-mcp-native-request.js";
import { originalMcpRequestDigest, createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { approvalBridgeDigest, approvalBridgeRecordDigest } from "../dist/domain/approval-bridge-digest.js";
import { originalDigest } from "../dist/domain/action-compiler-validation.js";
import { acquireOriginalMcpRootFence, captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";

assert(process.env.PKM_TEST_WORKSPACE, "Use private Linux framework fixtures.");
process.umask(0o077);
const work = process.env.PKM_TEST_WORKSPACE, hash = value => createHash("sha256").update(value).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let count = 0; count < 500; count++) { if (await check()) return; await delay(5); }
  throw new Error("Owned RPC fixture timeout.");
}
async function fixture(t, { advertise = true, methods = [...originalMcpNativeRequestMethods], binding: changes = {} } = {}) {
  const directory = join(homedir(), ".local/state/pkm-v5-recovery", `r-${randomBytes(4).toString("hex")}`);
  await mkdir(directory, { mode: 0o700 });
  const owned = await lstat(directory, { bigint: true }), keys = generateKeyPairSync("ed25519");
  const profileSha256 = hash("rpc-profile");
  const identity = originalMcpNativeIdentity(keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  const binding = { root: join(work, `rpc-root-${randomUUID()}`), workspaceId: randomUUID(), planSha256: hash("rpc-plan"),
    catalogSha256: hash("rpc-catalog"), profileSha256, payloadBuildId: hash("rpc-build"), hostEntrySha256: hash("rpc-host"), ...changes };
  const server = await startOriginalMcpNativeAttachmentServer({ directory, identity, identitySha256: identity.sha256, binding,
    maxPacketBytes: 65536, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000 });
  const socket = connect(join(directory, "n"));
  let pending = "", attachedResolve, session, handler;
  const attached = new Promise(resolve => { attachedResolve = resolve; });
  const requests = [], cancels = [];
  socket.on("error", () => { socket.destroy(); });
  const send = value => socket.write(JSON.stringify(value) + "\n");
  socket.on("data", chunk => {
    pending += chunk.toString("utf8");
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      const frame = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") attachedResolve(frame);
      else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-request") {
        const validated = parseOriginalMcpNativeRequest(frame, originalMcpNativeRequestSession(session));
        requests.push(validated);
        if (handler) handler(validated);
      } else if (frame.type === "native-cancel") cancels.push(frame);
    }
  });
  await attached;
  session = await server.waitForSession({ timeoutMs: 1000 });
  const advertiseMethods = async () => {
    send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol,
      session: originalMcpNativeRequestSession(session), methods, maxPacketBytes: 65536 });
    await waitForOriginalMcpNativeSupport(session, { timeoutMs: 1000 });
  };
  if (advertise) await advertiseMethods();
  t.after(async () => {
    socket.destroy(); await server.close();
    const now = await lstat(directory, { bigint: true });
    assert.equal(now.ino, owned.ino); assert.equal(now.dev, owned.dev); assert.equal(now.uid, owned.uid);
    await rm(directory, { recursive: true });
  });
  const host = { schema: "pkm.original-mcp-native-host-admission/v1", root: binding.root, workspaceId: binding.workspaceId,
    planSha256: binding.planSha256, profileSha256: binding.profileSha256, sourceCatalogSha256: binding.catalogSha256,
    authorityId: `native-rpc:${session.brokerId}`, epoch: session.activationId, actorId: "mcp:external",
    domains: ["model-provider", "tool-approval", "mcp-public"], configurationSha256: hash("explicit-unavailable-model-config") };
  return { server, socket, session, binding, host, requests, cancels, send, advertiseMethods,
    handle(value) { handler = value; }, reply(request, value) { send(originalMcpNativeResult(request, value)); } };
}
function publicRequest(content = "Entry") {
  const args = { slug: content };
  return { operation: "mcp.tool.get_note", version: 1, tool: "get_note", readOnly: true,
    arguments: args, argumentsDigest: originalMcpRequestDigest(args) };
}
function actionRequests(f) {
  const capsuleSha256 = hash("selected-action-capsule"), actionId = "fixture.signed.request";
  const contentHash = hash("exact-source"), implementationSha256 = hash("exact-implementation");
  const source = {
    schema: "pkm.native-action-source-request/v1", root: f.binding.root, workspaceId: f.binding.workspaceId,
    actorId: "mcp:external", profileSha256: f.binding.profileSha256, epoch: f.session.activationId,
    capsuleSha256, requestSha256: hash("exact-source-import"),
    operation: "hydrate-selected-original-action-domain",
    sources: [{ actionId, contentHash, implementationSha256, effects: ["pure"] }], noExecution: true,
  };
  const consent = {
    schema: "pkm.original-action-invocation-consent/v1", operation: "action_call",
    run_id: `action_run_${randomUUID().replaceAll("-", "")}`,
    request: { action_id: actionId, content_hash: contentHash, inputs: { value: "fixture only" },
      idempotency_key: "signed-action-request", trigger: null, project_id: null },
    sourceReceiptSha256: hash("source-receipt"), capsuleSha256, implementationSha256,
    deadline: Date.now() + 60000, automaticReplay: false,
  };
  const common = { binding: f.host, capsuleSha256 };
  return {
    source,
    payloads: {
      "action.status": common,
      "action.authorize": { ...common, actionId, contentHash, trustEpoch: f.session.activationId },
      "action.source.approve": { binding: f.host, request: source },
      "action.invocation.approve": { ...common, actionId, contentHash, trustEpoch: f.session.activationId,
        effectContext: { kind: "pipeline", components: ["core.constant"], stepCount: 1, effects: ["pure"],
          inputDigest: originalDigest(consent), inputPreview: JSON.stringify(consent) } },
    },
    decision: {
      schema: "pkm.native-action-source-decision/v1", scope: "original-action-source-state/v1",
      root: source.root, workspaceId: source.workspaceId, actorId: source.actorId,
      profileSha256: source.profileSha256, epoch: source.epoch, capsuleSha256,
      requestSha256: source.requestSha256, decisionId: randomUUID(), expiresAtMs: Date.now() + 60000, noExecution: true,
    },
  };
}

test("signed program lane preserves exact one-run process scope and typed denial/decision without admitting altered bindings", async t => {
  const f = await fixture(t), action = actionRequests(f);
  const consent = JSON.parse(action.payloads["action.invocation.approve"].effectContext.inputPreview);
  const request = {
    schema: "pkm.original-mcp-local-program-request/v1",
    root: f.binding.root, workspaceId: f.binding.workspaceId, actorId: "mcp:external",
    profileSha256: f.binding.profileSha256, epoch: f.session.activationId,
    capsuleSha256: action.source.capsuleSha256, sourceReceiptSha256: consent.sourceReceiptSha256,
    nativeHostReceiptSha256: hash("transport fixture host receipt"), runId: consent.run_id,
    request: consent.request, implementationSha256: consent.implementationSha256,
    inputSha256: originalDigest(consent.request.inputs), deadline: consent.deadline,
    executable: { path: process.execPath, sha256: hash("transport fixture executable"), bytes: 1, identity: "transport-only-fixture" },
    cwd: { path: join(f.binding.root, "action-sources"), device: "0", inode: "1" },
    arguments: ["-e", "process.stdout.write('{}')"], sources: [], effects: ["pure"],
    authority: { scope: "exact-local-direct-child/v1", shell: false, inheritedEnvironment: false,
      credentials: false, network: false, descendants: false, build: false, automaticReplay: false },
  };
  const payload = { binding: f.host, request }, method = "action.program.approve";
  f.handle(frame => f.reply(frame, null));
  assert.equal(await requestOriginalMcpNative(f.session, method, payload), null);
  assert.deepEqual(f.requests[0].payload, payload);
  const decision = {
    schema: "pkm.original-mcp-local-program-decision/v1", scope: "exact-local-direct-child/v1",
    root: request.root, workspaceId: request.workspaceId, actorId: request.actorId,
    profileSha256: request.profileSha256, epoch: request.epoch, capsuleSha256: request.capsuleSha256,
    runId: request.runId, requestSha256: originalDigest(request), executableSha256: request.executable.sha256,
    decisionId: randomUUID(), expiresAtMs: Date.now() + 30000, automaticReplay: false,
  };
  f.handle(frame => f.reply(frame, decision));
  assert.deepEqual(await requestOriginalMcpNative(f.session, method, payload), decision);
  assert.throws(() => originalMcpNativeResult(f.requests.at(-1), true));
  await assert.rejects(requestOriginalMcpNative(f.session, method, {
    ...payload, request: { ...request, epoch: randomUUID() },
  }), /NATIVE_ACTION_PROGRAM_BINDING_MISMATCH/);
  const inputs = { password: "forbidden-fixture-field" };
  await assert.rejects(requestOriginalMcpNative(f.session, method, {
    ...payload, request: { ...request, request: { ...request.request, inputs }, inputSha256: originalDigest(inputs) },
  }), error => error.name === "ZodError"
    && error.issues.some(issue => issue.code === "custom" && issue.path.join(".") === "request"));
  assert.equal(f.requests.length, 2, "Invalid process authority must never reach the native producer.");
});

test("signed Room session methods bind private effect/descriptor and permit transient user-link forwarding plus cleanup metadata only", async t => {
  const f = await fixture(t);
  const effect = {
    schema: "pkm.original-native-room-loopback-effect/v1", sessionId: randomUUID(),
    root: f.host.root, workspaceId: f.host.workspaceId, profileSha256: f.host.profileSha256,
    custodyPlanSha256: f.host.planSha256, nativeEpoch: f.host.epoch, nativeHostReceiptSha256: originalMcpRequestDigest(f.host),
    roomId: randomUUID(), sourceSha256: hash("transport source"), sourceFingerprint: hash("transport fingerprint"),
    hostParticipantId: "offline-source-human", hostCredentialHash: hash("fixture host hash"), joinSecretHash: hash("fixture join hash"),
    currentHostProofExpiresAtMs: Date.now() + 20000, endpoint: "ws://127.0.0.1:32123",
    selection: { port: 32123, alias: "Fresh transport fixture", postText: "Exact approved progress" },
    maxClients: 1, maxPosts: 1, temporaryParticipant: true, participantPolicy: "new-agent-only-no-rebind",
    clientPolicy: "original-producer-progress-post-no-commands", noRemote: true, noHostReassignment: true,
    noCredentialExport: true, expiresAtMs: Date.now() + 10000,
  };
  const effectSha256 = originalMcpRequestDigest(effect), open = { binding: f.host, effect, persistence: {
    schema: "pkm.original-native-room-persistence/v1", sessionId: effect.sessionId, socketPath: "/fixture-room/n",
    transportToken: "a".repeat(64), effectSha256,
  } };
  const common = { binding: f.host, sessionId: effect.sessionId, effectSha256 };
  f.handle(frame => f.reply(frame, frame.method === "room.session.open"
    ? { sessionId: effect.sessionId, effectSha256, endpoint: effect.endpoint, alias: effect.selection.alias, expiresAtMs: effect.expiresAtMs }
    : frame.method === "room.session.close" ? { closed: true } : { result: "original-format transport fixture" }));
  assert.equal((await requestOriginalMcpNative(f.session, "room.session.open", open)).sessionId, effect.sessionId);
  const args = { magic_link: "pkchat:v1:explicitly-synthetic-transport-input", name: effect.selection.alias };
  const intent = { schema: "pkm.original-room-user-link/v1", argumentsSha256: originalMcpRequestDigest(args),
    magicLinkSha256: hash(args.magic_link), suppliedNameSha256: hash(args.name),
    endpoint: effect.endpoint, requestedEndpoint: null, requestedRoomId: null, parseStatus: "unresolved" };
  assert.deepEqual(await requestOriginalMcpNative(f.session, "room.session.join", {
    ...common, callId: randomUUID(), arguments: args, intent,
  }), { result: "original-format transport fixture" });
  assert.equal(f.requests.at(-1).payload.arguments.magic_link, args.magic_link);
  assert.deepEqual(await requestOriginalMcpNative(f.session, "room.session.invoke", {
    ...common, callId: randomUUID(), call: { tool: "chat_status", arguments: {} },
  }), { result: "original-format transport fixture" });
  await assert.rejects(requestOriginalMcpNative(f.session, "room.session.open", {
    ...open, persistence: { ...open.persistence, effectSha256: hash("wrong effect") },
  }), /EFFECT_BINDING_REQUIRED/);
  assert.deepEqual(await requestOriginalMcpNative(f.session, "room.session.close", common), { closed: true });
  assert.throws(() => originalMcpNativeResult(f.requests.at(-1), { closed: true, joinSecret: "forbidden-fixture-output" }));
  assert.equal(f.requests.length, 4);
});

test("signed Action methods preserve exact source/invocation previews and typed decisions, independently of public admission", async t => {
  const f = await fixture(t), action = actionRequests(f);
  const replies = {
    "action.status": { trusted: false, trustEpoch: f.session.activationId },
    "action.authorize": { decision: "approve", trustEpoch: f.session.activationId },
    "action.source.approve": action.decision,
    "action.invocation.approve": { decision: "deny", trustEpoch: f.session.activationId },
  };
  f.handle(request => f.reply(request, replies[request.method]));
  for (const [method, payload] of Object.entries(action.payloads))
    assert.deepEqual(await requestOriginalMcpNative(f.session, method, payload), replies[method]);
  assert.equal(f.requests.length, 4);
  assert.deepEqual(f.requests[3].payload, action.payloads["action.invocation.approve"]);
  assert.throws(() => originalMcpNativeResult(f.requests[2], { decision: "approve" }),
    "A model/public approval is not a typed source-state decision.");
  await assert.rejects(requestOriginalMcpNative(f.session, "action.authorize", {
    ...action.payloads["action.authorize"], trustEpoch: randomUUID(),
  }), { code: "NATIVE_ACTION_EPOCH_MISMATCH" });
  const incomplete = structuredClone(action.payloads["action.invocation.approve"]);
  incomplete.effectContext.inputPreview = '{"schema":';
  await assert.rejects(requestOriginalMcpNative(f.session, "action.invocation.approve", incomplete),
    { code: "NATIVE_ACTION_EXACT_PREVIEW_REQUIRED" });
  assert.equal(f.requests.length, 4);
  f.session.assertCurrent();
});

test("cancelled signed Action source approval ignores late typed consent and does not grant later Action status", async t => {
  const f = await fixture(t), action = actionRequests(f), controller = new AbortController();
  const pending = requestOriginalMcpNative(f.session, "action.source.approve", action.payloads["action.source.approve"],
    { signal: controller.signal, timeoutMs: 2000 });
  const cancelled = assert.rejects(pending, { code: "NATIVE_REQUEST_CANCELLED" });
  await until(() => f.requests.length === 1); controller.abort(); await cancelled;
  await until(() => f.cancels.length === 1);
  f.reply(f.requests[0], action.decision);
  await delay(10);
  f.handle(request => f.reply(request, { trusted: false, trustEpoch: f.session.activationId }));
  assert.equal((await requestOriginalMcpNative(f.session, "action.status", action.payloads["action.status"])).trusted, false);
  f.session.assertCurrent();
});

test("auth-only clients grant nothing; explicit actual-method support enables fresh exact request roundtrips", async t => {
  const f = await fixture(t, { advertise: false }), policy = createOriginalMcpNativeRequestPolicy(f.session);
  await assert.rejects(policy.authorizePublic({ ...f.host, request: publicRequest() }, new AbortController().signal), { code: "MISSING_NATIVE_METHOD" });
  assert.equal(f.requests.length, 0); f.session.assertCurrent();
  await f.advertiseMethods();
  f.handle(request => f.reply(request, request.method === "credential.present" ? { present: false } : { decision: "approve" }));
  assert.equal(await policy.authorizeAdmission(f.host), true);
  assert.equal(await policy.authorizeAdmission({ ...f.host, domains: [...f.host.domains, "api-chat-native"] }), true,
    "An actual branded chat resource adds its typed host domain without inventing model transport or permission.");
  assert.equal(await policy.authorizePublic({ ...f.host, request: publicRequest() }, new AbortController().signal), true);
  assert.equal(await policy.models.credentialAvailable({ ...f.host, secretId: "personalKnowledge.aiApiKey" }), false);
  assert.equal(await policy.models.authorizeRequest({ ...f.host, provider: "vscode", model: "selected-native-model", requestSha256: hash("exact-model-request") }), true);
  assert.equal(f.requests.length, 5);
  assert(f.requests.every(request => request.session.epoch === f.session.activationId));
  assert.equal(policy.signal, f.session.signal);
  policy.assertCurrent(f.host);
  assert.throws(() => policy.assertCurrent({ ...f.host, profileSha256: "0".repeat(64) }), { code: "NATIVE_REQUEST_BINDING_MISMATCH" });
  assert.equal(policy.models.transport.supports("vscode"), false);
  await assert.rejects(policy.models.transport.open({}), { code: "MISSING_NATIVE_METHOD" });
});

test("default semantic review uses fresh signed decisions without declaring general tools or admitting other operations", async t => {
  const f = await fixture(t), policy = createOriginalMcpNativeRequestPolicy(f.session);
  assert.equal(policy.toolCatalog, undefined);
  let decision = "reject";
  f.handle(request => f.reply(request, { decision, decisionId: randomUUID(), actorId: f.host.actorId }));
  const args = {}, context = { turnId: "actual-task-request", contextDigest: hash("task-plan"), readOnly: true };
  const record = { id: randomUUID(), actor: f.host.actorId, revision: 1, status: "awaiting_approval",
    tool: "chat.task.get", arguments: args, approvalRequired: true, approvalDecisionId: null, createdAt: 1, updatedAt: 1 };
  const executionOperationId = randomUUID();
  const review = { workspaceId: f.binding.workspaceId, actorId: f.host.actorId, operationId: randomUUID(), executionOperationId,
    argumentsDigest: approvalBridgeDigest(args), recordDigest: approvalBridgeRecordDigest(f.binding.workspaceId, record, context, executionOperationId),
    context, record };
  assert.equal((await policy.reviewTool({ ...f.host, review })).decision, "reject");
  decision = "approve";
  assert.equal((await policy.reviewTool({ ...f.host, review })).decision, "approve");
  assert.equal(f.requests.length, 2);
  assert.notEqual(f.requests[0].requestId, f.requests[1].requestId);
  await assert.rejects(policy.reviewTool({ ...f.host, review: { ...review, record: { ...record, tool: "knowledge.document.get" } } }),
    { code: "NATIVE_REQUEST_TOOL_NOT_AVAILABLE" });
  assert.equal(f.requests.length, 2);
});

test("public and tool denial/review are actual per-request responses, not signer enrollment permission", async t => {
  const f = await fixture(t), catalog = [{ name: "echo", operation: "synthetic.echo", approvalRequired: true }];
  const policy = createOriginalMcpNativeRequestPolicy(f.session, { toolCatalog: catalog });
  f.handle(request => f.reply(request, request.method === "tool.review"
    ? { decision: "reject", decisionId: randomUUID(), actorId: "mcp:external" } : { decision: "deny" }));
  assert.equal(await policy.authorizePublic({ ...f.host, request: publicRequest() }, new AbortController().signal), false);
  const args = { input: "synthetic" }, context = { turnId: "turn", contextDigest: hash("ctx"), readOnly: false };
  const tool = { operation: "synthetic.echo", version: 1, arguments: args, argumentsDigest: originalMcpRequestDigest(args),
    actorId: "mcp:external", workspaceId: f.binding.workspaceId, ...context };
  assert.equal(await policy.approveTool({ ...f.host, request: tool }, new AbortController().signal), false);
  const record = { id: randomUUID(), actor: "mcp:external", revision: 1, status: "awaiting_approval",
    tool: "synthetic.echo", arguments: args, approvalRequired: true, approvalDecisionId: null, createdAt: 1, updatedAt: 1 };
  const executionOperationId = randomUUID();
  const review = { workspaceId: f.binding.workspaceId, actorId: "mcp:external", operationId: randomUUID(), executionOperationId,
    argumentsDigest: approvalBridgeDigest(args), recordDigest: approvalBridgeRecordDigest(f.binding.workspaceId, record, context, executionOperationId),
    context, record };
  assert.equal((await policy.reviewTool({ ...f.host, review })).decision, "reject");
  assert.equal(f.requests.length, 3);
  await assert.rejects(policy.authorizePublic({ ...f.host, request: { ...publicRequest(), arguments: { slug: "changed" } } },
    new AbortController().signal), { code: "NATIVE_REQUEST_ARGUMENTS_CHANGED" });
  await assert.rejects(policy.reviewTool({ ...f.host, review: { ...review, recordDigest: "0".repeat(64) } }),
    { code: "NATIVE_REQUEST_ARGUMENTS_CHANGED" });
  assert.equal(f.requests.length, 3);
});

test("cancellation/timeouts revoke pending decisions and late approval cannot authorize a different request", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const request = requestOriginalMcpNative(f.session, "public.approve", { binding: f.host, request: publicRequest() },
    { signal: controller.signal, timeoutMs: 2000 });
  const cancelled = assert.rejects(request, { code: "NATIVE_REQUEST_CANCELLED" });
  await until(() => f.requests.length === 1); controller.abort(); await cancelled;
  await until(() => f.cancels.length === 1);
  f.reply(f.requests[0], { decision: "approve" });
  await delay(10); f.session.assertCurrent();
  const timeout = requestOriginalMcpNative(f.session, "admission.approve", { binding: f.host }, { timeoutMs: 30 });
  await assert.rejects(timeout, { code: "NATIVE_REQUEST_TIMEOUT" });
  await until(() => f.cancels.length === 2);
  f.handle(frame => f.send(originalMcpNativeErrorResult(frame, "MISSING_NATIVE_METHOD")));
  await assert.rejects(requestOriginalMcpNative(f.session, "model.approve",
    { binding: f.host, provider: "vscode", model: "unimplemented", requestSha256: hash("new") }), { code: "MISSING_NATIVE_METHOD" });
  assert.notEqual(f.requests[0].requestId, f.requests[1].requestId);
});

test("cancelling native inference retires its outstanding model approval", async t => {
  const f = await fixture(t);
  const policy = createOriginalMcpNativeRequestPolicy(f.session);
  const controller = new AbortController();
  const pending = policy.models.authorizeRequest({ ...f.host, provider: "vscode",
    model: "selected-native-model", requestSha256: hash("cancelled-inference") }, controller.signal);
  const cancelled = assert.rejects(pending, { code: "NATIVE_REQUEST_CANCELLED" });
  await until(() => f.requests.length === 1);
  controller.abort();
  f.reply(f.requests[0], { decision: "approve" });
  await cancelled;
  assert.equal(f.session.signal.aborted, false);
});

test("binding or digest substitution revokes all pending requests instead of accepting a bool", async t => {
  const f = await fixture(t);
  const waiting = requestOriginalMcpNative(f.session, "admission.approve", { binding: f.host });
  const refused = assert.rejects(waiting, { code: "NATIVE_REQUEST_SESSION_REVOKED" });
  await until(() => f.requests.length === 1);
  const reply = originalMcpNativeResult(f.requests[0], { decision: "approve" });
  f.send({ ...reply, requestDigest: "0".repeat(64) });
  await refused;
  assert.equal(f.session.signal.aborted, true);
});

test("bounded frames/queues reject without truncation; credential results cannot carry raw values", async t => {
  const f = await fixture(t);
  await assert.rejects(requestOriginalMcpNative(f.session, "public.approve",
    { binding: f.host, request: publicRequest("x".repeat(70000)) }), { code: "NATIVE_REQUEST_TOO_LARGE" });
  const credentialArgs = { api_key: "synthetic-value-must-not-cross" };
  await assert.rejects(requestOriginalMcpNative(f.session, "public.approve", { binding: f.host,
    request: { ...publicRequest(), arguments: credentialArgs, argumentsDigest: originalMcpRequestDigest(credentialArgs) } }),
  { code: "NATIVE_REQUEST_CREDENTIAL_FIELDS" });
  assert.equal(f.requests.length, 0);
  const active = [];
  for (let index = 0; index < 16; index++) {
    const controller = new AbortController();
    const rejected = assert.rejects(requestOriginalMcpNative(f.session, "admission.approve",
      { binding: f.host }, { signal: controller.signal }), { code: "NATIVE_REQUEST_CANCELLED" });
    active.push({ controller, rejected });
  }
  await until(() => f.requests.length === 16);
  await assert.rejects(requestOriginalMcpNative(f.session, "admission.approve", { binding: f.host }), { code: "NATIVE_REQUEST_BUSY" });
  for (const item of active) item.controller.abort();
  await Promise.all(active.map(item => item.rejected));
  const credential = requestOriginalMcpNative(f.session, "credential.present", { binding: f.host, secretId: "personalKnowledge.aiApiKey" });
  const denied = assert.rejects(credential, { code: "NATIVE_REQUEST_SESSION_REVOKED" });
  await until(() => f.requests.length === 17);
  const original = f.requests.at(-1);
  f.send({ type: "native-result", protocol: originalMcpNativeRequestProtocol, requestId: original.requestId,
    session: original.session, requestDigest: original.requestDigest, result: { present: true, apiKey: "never-accepted" } });
  await denied;
});

test("actual Storage/native host admission and public approval come only from the verified live socket", async t => {
  const directory = join(work, `rpc-host-${randomUUID()}`), root = join(directory, "root");
  for (const path of ["notes", "skills", "papers", ".pkm"])
    await mkdir(join(root, path), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nSynthetic original.\n", { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const writerFence = await acquireOriginalMcpRootFence(root);
  let opened, nativeHost;
  t.after(async () => { await nativeHost?.close(); await opened?.owner.close(); await writerFence.release(); await rm(directory, { recursive: true }); });
  const profileSha256 = hash("rpc-profile");
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"), operatorId: "rpc-native-fixture", profileSha256,
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 1048576, maxFileBytes: 1048576 } }, { writerFence });
  opened = await openOriginalMcpRoot(plan, { writerFence });
  const f = await fixture(t, { binding: { root, workspaceId: opened.workspaceId, planSha256: plan.planSha256 } });
  let approvePublic = false;
  f.handle(frame => f.reply(frame, { decision: frame.method === "admission.approve" || approvePublic ? "approve" : "deny" }));
  const policy = createOriginalMcpNativeRequestPolicy(f.session);
  nativeHost = await createOriginalMcpNativeHost(opened.storage, policy);
  assert.equal(nativeHost.receipt.epoch, f.session.activationId);
  await assert.rejects(nativeHost.authorizePublic(publicRequest()), { code: "ACCESS_DENIED" });
  approvePublic = true;
  await nativeHost.authorizePublic(publicRequest());
  assert.equal(f.requests.filter(frame => frame.method === "public.approve").length, 2);
  const pending = requestOriginalMcpNative(f.session, "admission.approve", { binding: f.requests[0].payload.binding });
  const cancelled = assert.rejects(pending, { code: "NATIVE_REQUEST_SESSION_REVOKED" });
  f.handle(undefined); f.socket.destroy(); await cancelled;
  assert.throws(() => nativeHost.assertCurrent());
});

test("a caller cannot replace a published session with a success callback or invoke an unlisted method", async t => {
  const f = await fixture(t);
  let invoked = false;
  assert.throws(() => bindOriginalMcpNativeRequestTransport(f.session,
    { maximumBytes: 65536, send() { invoked = true; }, revoke() {} }), { code: "NATIVE_REQUEST_CHANNEL_ALREADY_BOUND" });
  assert.throws(() => createOriginalMcpNativeRequestPolicy({ ...f.session }), { code: "NATIVE_ATTACHMENT_SESSION_UNAUTHENTICATED" });
  await assert.rejects(requestOriginalMcpNative(f.session, "model.open", {}), { code: "MISSING_NATIVE_METHOD" });
  assert.equal(invoked, false); assert.equal(f.requests.length, 0);
});
