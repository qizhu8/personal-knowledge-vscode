import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startOriginalMcpNativeAttachmentServer } from "../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import {
  createOriginalMcpNativeChatRpcPort, assertOriginalMcpNativeChatRpcPort,
  createOriginalMcpNativeChatProducerChannel, waitForOriginalMcpNativeChatSupport,
  bindOriginalMcpNativeChatTransport, originalMcpNativeChatLimits,
} from "../dist/original-mcp-native-chat-rpc.js";
import {
  originalNativeChatDigest, originalNativeChatInferenceDigest, originalVscodeModelRequestDigest,
} from "../dist/original-mcp-api-chat-contracts.js";
import { prepareWorkGoal } from "../dist/managed-chat-task-original.js";

assert(process.env.PKM_TEST_WORKSPACE, "Run in private Linux framework fixtures.");
process.umask(0o077);
const hash = value => createHash("sha256").update(value).digest("hex");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function until(check) {
  for (let n = 0; n < 1000; n++) { if (await check()) return; await wait(5); }
  throw new Error("Owned model RPC fixture timeout.");
}
async function fixture(t, { advertise = true, apiChat = false, memory = false, adoption = false } = {}) {
  const directory = join(homedir(), ".local/state/pkm-v5-recovery", `m-${randomBytes(4).toString("hex")}`);
  await mkdir(directory, { mode: 0o700 });
  const owned = await lstat(directory, { bigint: true }), keys = generateKeyPairSync("ed25519");
  const profileSha256 = hash("chat-rpc-fixture-profile"), activationId = randomUUID();
  const identity = originalMcpNativeIdentity(keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  const binding = { root: join(process.env.PKM_TEST_WORKSPACE, "original-root"), workspaceId: randomUUID(),
    planSha256: hash("fixture-root-plan"), catalogSha256: hash("fixture-catalogue"), profileSha256,
    payloadBuildId: hash("fixture-build"), hostEntrySha256: hash("fixture-host") };
  const server = await startOriginalMcpNativeAttachmentServer({
    directory, identity, identitySha256: identity.sha256, binding,
    heartbeatIntervalMs: 200, heartbeatTimeoutMs: 3000,
  });
  const socket = connect(join(directory, "n")), lifetime = new AbortController();
  const descriptor = { modelId: "vscode:fixture:model", nativeModelId: "model" };
  const selectionId = randomUUID(), frames = [], outbound = [], attached = deferred();
  const state = { counts: 0, produced: 0, dispatches: 0, toolEffects: 0, cancelled: 0,
    sessionCalls: [], authorized: true };
  let producer, session, peerSession, input = "", holdAck, mutate, closeFailure, support;
  const catalogue = { source: "vscode.lm", epoch: activationId, registryRevision: "fixture-registry-one",
    models: [{ id: descriptor.modelId, nativeModelId: descriptor.nativeModelId, label: "Fixture model",
      vendor: "fixture", family: "unit", version: "one", maxInputTokens: 262144, maxOutputTokens: null,
      imageInput: true, toolCalling: true }] };
  const modelMethods = {
    async catalogue() { return catalogue; },
    async select(value) {
      assert.equal(value.catalogueSha256, originalNativeChatDigest(catalogue));
      return { selectionId: randomUUID(), modelId: value.modelId, epoch: activationId, maxInputTokens: 262144 };
    },
    async count(value) {
      state.counts++;
      return { selectionId: value.selectionId, requestSha256: value.requestSha256, inputTokens: 42,
        countingMethod: "vscode-countTokens-plus-tool-overhead" };
    },
    async *stream(_value, signal) {
      state.dispatches++;
      try {
        state.produced++; yield { type: "text", text: "One" };
        state.produced++; yield { type: "text", text: "Two" };
        yield { type: "usage", inputTokens: 42, outputTokens: 2 };
        yield { type: "finish", reason: "stop" };
      } finally { if (signal.aborted) state.cancelled++; }
    },
  };
  let execute = async (plan, ports, signal) => {
    const receipts = [], rounds = plan.hardToolRoundLimit ?? 0;
    for (let round = 0; round <= rounds; round++) {
      if (signal.aborted) return { status: "unknown", toolRoundLimit: null };
      const inferenceId = originalNativeChatDigest({ requestId: plan.requestId, sourcePlanSha256: plan.sourcePlanSha256, round, receipts });
      const before = { inferenceId, round, planSha256: originalNativeChatDigest(plan),
        sourcePlanSha256: plan.sourcePlanSha256, selectionId: plan.selectionId,
        nativeRequest: { messages: [{ role: "user", content: "Portable actual request fixture." }],
          options: round < rounds ? { tools: plan.tools.map(tool => ({
            name: tool.name, description: tool.description, inputSchema: tool.parameters,
          })) } : {} },
        inputTokens: 42, countingMethod: "vscode-countTokens-plus-overhead" };
      await ports.beforeInference({ ...before, requestSha256: originalNativeChatInferenceDigest(before) });
      state.dispatches++;
      if (round < rounds) {
        const args = { round };
        const result = await ports.tool({ inferenceId, round, callId: `call-${round}`, name: plan.tools[0].name,
          arguments: args, argumentsSha256: originalNativeChatDigest(args) });
        if (result.effect === "unknown") return { status: "unknown", toolRoundLimit: null };
        receipts.push(result.receiptSha256);
      }
      await ports.text({ inferenceId, text: `Round ${round}` });
      await ports.usage({ inferenceId, usage: { inputTokens: 42, outputTokens: 2 }, source: "native-counted" });
    }
    return { status: "complete", toolRoundLimit: plan.hardToolRoundLimit === null ? null
      : { limit: rounds, rounds, reached: true } };
  };
  const execution = { run: (...args) => execute(...args) };
  let sessionAuthorize = async () => state.authorized;
  const nativeSelection = {
    protocol: "pkm.original-api-chat-execution/v1", epoch: activationId, modelId: descriptor.modelId,
    wireModelId: descriptor.nativeModelId, provider: "vscode", permissionMode: "protective",
    outputTokenCap: 128, budget: { maxInputTokens: 262144, maxTotalOutputTokens: 32768, deadlineMs: 30000 },
  };
  let memorySelect = async input => ({ mode: "off", requestId: input.requestId, epoch: activationId,
    bindingSha256: originalNativeChatDigest(input) });
  let sessionAdopt = async input => ({ decision: "adopt-and-revalidate", actorId: "mcp:external",
    decisionId: randomUUID(), expiresAtMs: Date.now() + 300000, requestId: input.requestId,
    epoch: activationId, bindingSha256: originalNativeChatDigest(input) });
  const highLevel = {
    ...(adoption ? { async adopt(input, signal) { state.sessionCalls.push(["adopt", input]); return sessionAdopt(input, signal); } } : {}),
    ...(memory ? { memory: { async select(input, signal) {
      state.sessionCalls.push(["memory", input]); return memorySelect(input, signal);
    } } } : {}),
    async resolve(input, signal) { state.sessionCalls.push(["resolve", input]); assert(!signal.aborted); return nativeSelection; },
    async authorize(input, signal) { state.sessionCalls.push(["authorize", input]); return sessionAuthorize(input, signal); },
    async present(input, signal) { state.sessionCalls.push(["present", input]); assert(!signal.aborted); },
  };
  const send = async value => {
    outbound.push(value);
    if (holdAck && value.type === "native-chat-ack" && value.nextSequence === 1) {
      const held = holdAck; holdAck = undefined; await held.promise;
    }
    const frame = mutate ? mutate(value) : value;
    await new Promise((resolve, reject) => socket.write(JSON.stringify(frame) + "\n", error => error ? reject(error) : resolve()));
  };
  socket.on("error", () => {});
  socket.on("close", () => lifetime.abort());
  socket.on("data", chunk => {
    input += chunk.toString("utf8");
    for (let end; (end = input.indexOf("\n")) !== -1;) {
      const frame = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, activationId);
        void send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") {
        peerSession = { brokerId: frame.brokerId, activationId, identitySha256: identity.sha256, epoch: activationId, binding };
        if (advertise) {
          producer = createOriginalMcpNativeChatProducerChannel({
            session: peerSession, models: modelMethods, execution, signal: lifetime.signal,
            ...(apiChat ? { apiChat: highLevel } : {}),
            assertCurrent() { if (lifetime.signal.aborted) throw new Error("Fixture signer revoked."); },
            send, close() { socket.destroy(); if (closeFailure) throw closeFailure; },
          });
          support = producer.support(); void support.catch(() => {});
        }
        attached.resolve();
      } else if (frame.type === "ping") void send({ type: "pong", nonce: frame.nonce });
      else if (frame.type.startsWith("native-chat-")) {
        frames.push(frame);
        try { producer.receive(frame); } catch { socket.destroy(); }
      }
    }
  });
  await attached.promise; session = await server.waitForSession({ timeoutMs: 2000 });
  if (advertise) { await waitForOriginalMcpNativeChatSupport(session, { timeoutMs: 2000 }); await support; }
  t.after(async () => {
    lifetime.abort();
    let cleanup;
    try { await producer?.dispose(); } catch (error) { cleanup = error; }
    socket.destroy(); await server.close();
    const current = await lstat(directory, { bigint: true });
    assert.equal(current.ino, owned.ino); assert.equal(current.dev, owned.dev); assert.equal(current.uid, owned.uid);
    await rm(directory, { recursive: true });
    if (cleanup) assert.equal(cleanup, state.expectedCleanupError);
  });
  return { server, socket, session, state, frames, outbound, modelMethods, execution, nativeSelection,
    authorize(value) { sessionAuthorize = value; },
    memorySelect(value) { memorySelect = value; },
    adopt(value) { sessionAdopt = value; },
    get peerSession() { return peerSession; }, get producer() { return producer; },
    execute(value) { execute = value; }, holdAck(value) { holdAck = value; }, mutate(value) { mutate = value; },
    closeFailure(value) { closeFailure = value; },
    async select() {
      const resource = createOriginalMcpNativeChatRpcPort(session), signal = new AbortController().signal;
      const catalogue = await resource.models.catalogue(signal);
      const selection = await resource.models.select({ modelId: descriptor.modelId, catalogueSha256: originalNativeChatDigest(catalogue) }, signal);
      return { resource, selection, signal };
    } };
}
function adoptionRequest(f) {
  const chatId = randomUUID(), inputId = randomUUID(), taskId = `agent_session_${randomUUID().replaceAll("-", "")}`;
  const chat = { id: chatId, sessionId: taskId, includeHistory: true, messages: [{
    id: inputId, taskId, role: "user", content: "Start a new task: preserve the actual original Goal.", status: "complete",
  }] };
  prepareWorkGoal(chat, inputId, chat.messages[0].content, hash("original-context"));
  return { schema: "pkm.chat.original-task-adoption-review/v1", requestId: hash(randomUUID()), commandId: randomUUID(),
    chatUrl: `pkm://chats/0123456789abcdef/${chatId}`, sourcePlanSha256: hash("source-plan"), sourceSha256: hash("source-projection"),
    original: { schema: "pkm.chat.original-task-adoption-source/v1", chatId, namespace: "0123456789abcdef",
      taskId, chatTitle: "Original Chat", taskTitle: "Original Task", sessionStatus: "paused",
      metadataSha256: hash("metadata"), sessionSha256: hash("session"), historySha256: hash("history"),
      goal: chat.workGoal, sourceInputIds: [inputId] },
    selection: f.nativeSelection, prompt: "Continue the same exact original objective.", argumentsSha256: hash("whole-continuation"),
    previousExecutionDigest: chat.workGoal.executionDigest, nextExecutionDigest: hash("fresh-native-context"),
    resetCurrentAcceptance: true, importOldPermissions: false, historicalEvidenceOnly: true, taskCompletion: "not-claimed" };
}
test("signed adoption is optional and available only for an actual fixed producer handler; source data alone never executes a model", async t => {
  // Signed transport with explicit fixture decisions, not native UI or Core adoption-authority qualification.
  const absent = await fixture(t, { apiChat: true });
  assert.equal(createOriginalMcpNativeChatRpcPort(absent.session).apiChat.adopt, undefined);
  const f = await fixture(t, { apiChat: true, adoption: true }), resource = createOriginalMcpNativeChatRpcPort(f.session);
  assert.equal(typeof resource.apiChat.adopt, "function"); assert(Object.isFrozen(resource.apiChat));
  const request = adoptionRequest(f), decision = await resource.apiChat.adopt(request, new AbortController().signal);
  assert.equal(decision.decision, "adopt-and-revalidate");
  assert.equal(decision.bindingSha256, originalNativeChatDigest(request));
  assert.deepEqual(f.state.sessionCalls, [["adopt", request]]);
  f.adopt(async input => ({ ...decision, decision: "deny", decisionId: randomUUID(), requestId: input.requestId,
    bindingSha256: originalNativeChatDigest(input) }));
  assert.equal((await resource.apiChat.adopt(adoptionRequest(f), new AbortController().signal)).decision, "deny");
  assert.equal(f.state.dispatches, 0); assert.equal(f.state.toolEffects, 0);
});
test("signed adoption refuses mismatched request/epoch/digest, expired affirmative decisions and retargeted selection", async t => {
  for (const mismatch of ["requestId", "epoch", "bindingSha256", "expiry"]) await t.test(mismatch, async t => {
    const f = await fixture(t, { apiChat: true, adoption: true }), resource = createOriginalMcpNativeChatRpcPort(f.session);
    f.adopt(async input => ({ decision: "adopt-and-revalidate", actorId: "mcp:external", decisionId: randomUUID(),
      expiresAtMs: mismatch === "expiry" ? Date.now() - 1 : Date.now() + 300000,
      requestId: mismatch === "requestId" ? hash("wrong-request") : input.requestId,
      epoch: mismatch === "epoch" ? randomUUID() : f.nativeSelection.epoch,
      bindingSha256: mismatch === "bindingSha256" ? hash("wrong-binding") : originalNativeChatDigest(input) }));
    await assert.rejects(resource.apiChat.adopt(adoptionRequest(f), new AbortController().signal));
    assert.equal(f.state.dispatches, 0);
  });
  const f = await fixture(t, { apiChat: true, adoption: true }), resource = createOriginalMcpNativeChatRpcPort(f.session);
  const input = adoptionRequest(f);
  await assert.rejects(resource.apiChat.adopt({ ...input, selection: { ...input.selection, epoch: randomUUID() } }, new AbortController().signal));
  assert.equal(f.state.sessionCalls.length, 0);
});
test("cancelled signed adoption discards a late affirmative decision without granting send or model authority", async t => {
  const f = await fixture(t, { apiChat: true, adoption: true }), resource = createOriginalMcpNativeChatRpcPort(f.session);
  const held = deferred(), controller = new AbortController(), request = adoptionRequest(f);
  f.adopt(async input => {
    await held.promise;
    return { decision: "adopt-and-revalidate", actorId: "mcp:external", decisionId: randomUUID(),
      expiresAtMs: Date.now() + 300000, requestId: input.requestId,
      epoch: f.nativeSelection.epoch, bindingSha256: originalNativeChatDigest(input) };
  });
  const pending = resource.apiChat.adopt(request, controller.signal); void pending.catch(() => {});
  await until(() => f.state.sessionCalls.length === 1); controller.abort();
  await assert.rejects(pending); held.resolve(); await wait(20);
  assert.equal(f.state.dispatches, 0); assert.equal(f.state.toolEffects, 0);
  assert.equal(f.state.sessionCalls.filter(([method]) => method === "authorize").length, 0);
});
function request(selectionId, messages = [{ role: "user", content: "Fixture prompt." }]) {
  const body = { selectionId, requestId: randomUUID(), messages, tools: [], outputTokenCap: 128 };
  return { ...body, requestSha256: originalVscodeModelRequestDigest(body) };
}
function plan(selectionId, hardToolRoundLimit = 1) {
  return { schema: "pkm.original-api-chat-execution/v1", requestId: hash(randomUUID()), chatUrl: "api-chat://fixture/one",
    selectionId, sourcePlanSha256: hash("source-plan"), messages: [{ role: "user", content: "Fixture execution." }],
    tools: [{ name: "fixture_canonical_tool", description: "Core-only fixture", parameters: { type: "object" } }],
    hardToolRoundLimit, outputTokenCap: 128, budget: { maxInputTokens: 262144, maxTotalOutputTokens: 32768, deadlineMs: 30000 } };
}
function callbacks(trace = []) {
  return {
    async beforeInference(value) { trace.push(["before", value.round]); },
    async tool(value) { trace.push(["tool", value.round]); return { receiptSha256: hash(`actual-fixture-receipt-${value.round}`),
      content: "Canonical fixture result.", effect: "committed" }; },
    async text(value) { trace.push(["text", value.inferenceId]); },
    async usage(value) { trace.push(["usage", value.source]); },
  };
}

test("auth-only sessions expose no model methods or caller transport binding", async t => {
  const f = await fixture(t, { advertise: false });
  assert.throws(() => createOriginalMcpNativeChatRpcPort(f.session), { code: "MISSING_NATIVE_METHOD" });
  assert.throws(() => createOriginalMcpNativeChatRpcPort({ ...f.session }), { code: "NATIVE_ATTACHMENT_SESSION_UNAUTHENTICATED" });
  assert.throws(() => bindOriginalMcpNativeChatTransport(f.session, { maximumBytes: 16384, send() {}, revoke() {} }),
    { code: "NATIVE_CHAT_CHANNEL_ALREADY_BOUND" });
  assert.equal(f.frames.length, 0); f.session.assertCurrent();
});

test("high-level Chat availability is separate from the model-only authenticated lane", async t => {
  const f = await fixture(t);
  const resource = createOriginalMcpNativeChatRpcPort(f.session);
  assert.equal(resource.apiChat, undefined);
  assert.equal(f.state.sessionCalls.length, 0);
});

test("authenticated high-level Chat resolve, consent and presentation round-trip exact bindings without executing a model", async t => {
  const f = await fixture(t, { apiChat: true }), resource = createOriginalMcpNativeChatRpcPort(f.session);
  assert(resource.apiChat && Object.isFrozen(resource.apiChat));
  assert.equal(resource.apiChat.memory, undefined, "Older high-level producers do not invent live Memory support.");
  const signal = new AbortController().signal;
  const input = { requestId: hash("native-create"), requestedModelId: f.nativeSelection.modelId, chatUrl: null,
    sourcePlanSha256: hash("native-source"), expectedSelection: null };
  const selection = await resource.apiChat.resolve(input, signal);
  assert.deepEqual(selection, f.nativeSelection);
  const consent = { operation: "create", requestId: input.requestId, commandId: "fixed-create",
    chatUrl: null, sourcePlanSha256: input.sourcePlanSha256, sourceUncertain: false,
    argumentsSha256: hash("create-fields"), selection };
  f.state.authorized = false;
  assert.equal(await resource.apiChat.authorize(consent, signal), false);
  f.state.authorized = true;
  assert.equal(await resource.apiChat.authorize(consent, signal), true);
  const presentation = { requestId: input.requestId, chatUrl: `pkm://chats/0123456789abcdef/${randomUUID()}`,
    sourcePlanSha256: input.sourcePlanSha256, selection };
  await resource.apiChat.present(presentation, signal);
  assert.deepEqual(f.state.sessionCalls, [["resolve", input], ["authorize", consent],
    ["authorize", consent], ["present", presentation]]);
  assert.equal(f.state.dispatches, 0);
  assert.equal(f.state.toolEffects, 0);
});

function memoryRequest(f, requestId = hash("explicit-native-memory")) {
  return { requestId, chatUrl: `pkm://chats/0123456789abcdef/${randomUUID()}`,
    sourcePlanSha256: hash("memory-chat-source"), argumentsSha256: hash("memory-send-arguments"),
    selection: f.nativeSelection, draftSha256: null, scope: "workspace:fixture", proposedQuery: "Literal fixture" };
}

test("optional frozen Memory selection preserves exact scope/request/epoch/digest without invoking a reader or model", async t => {
  const f = await fixture(t, { apiChat: true, memory: true }), resource = createOriginalMcpNativeChatRpcPort(f.session);
  assert(resource.apiChat.memory && Object.isFrozen(resource.apiChat.memory));
  f.memorySelect(async input => ({ mode: "live", requestId: input.requestId, epoch: f.nativeSelection.epoch,
    bindingSha256: originalNativeChatDigest(input), scope: input.scope, query: "Exact approved query", limit: 2 }));
  const input = memoryRequest(f);
  assert.deepEqual(await resource.apiChat.memory.select(input, new AbortController().signal), {
    mode: "live", requestId: input.requestId, epoch: f.nativeSelection.epoch,
    bindingSha256: originalNativeChatDigest(input), scope: input.scope, query: "Exact approved query", limit: 2,
  });
  assert.equal(f.state.dispatches, 0);
  assert.equal(f.state.toolEffects, 0);
});

test("native Memory choices cannot change the signed epoch or selected scope", async t => {
  for (const mismatch of ["epoch", "scope"]) await t.test(mismatch, async t => {
    const f = await fixture(t, { apiChat: true, memory: true }), resource = createOriginalMcpNativeChatRpcPort(f.session);
    f.memorySelect(async input => ({ mode: "live", requestId: input.requestId,
      epoch: mismatch === "epoch" ? randomUUID() : f.nativeSelection.epoch,
      bindingSha256: originalNativeChatDigest(input), scope: mismatch === "scope" ? "foreign:scope" : input.scope,
      query: "Exact query", limit: 1 }));
    await assert.rejects(resource.apiChat.memory.select(memoryRequest(f), new AbortController().signal),
      { code: "NATIVE_CHAT_MEMORY_BINDING" });
    assert.equal(f.state.dispatches, 0);
  });
});

test("cancelled native Memory selection ignores a late choice without authorizing the next request", async t => {
  const f = await fixture(t, { apiChat: true, memory: true }), resource = createOriginalMcpNativeChatRpcPort(f.session);
  const gate = deferred(), started = deferred(), controller = new AbortController();
  let nativeSignal;
  f.memorySelect(async (input, signal) => {
    nativeSignal = signal; started.resolve(); await gate.promise;
    return { mode: "off", requestId: input.requestId, epoch: f.nativeSelection.epoch,
      bindingSha256: originalNativeChatDigest(input) };
  });
  const pending = resource.apiChat.memory.select(memoryRequest(f), controller.signal);
  const rejected = assert.rejects(pending, { code: "NATIVE_CHAT_CANCELLED" });
  await started.promise; controller.abort(); await rejected;
  await until(() => nativeSignal.aborted); gate.resolve(); await wait(20);
  f.memorySelect(async input => ({ mode: "off", requestId: input.requestId, epoch: f.nativeSelection.epoch,
    bindingSha256: originalNativeChatDigest(input) }));
  assert.equal((await resource.apiChat.memory.select(memoryRequest(f, hash("next-memory-request")),
    new AbortController().signal)).mode, "off");
  assert.equal(f.state.dispatches, 0);
});

test("cancelled high-level native consent never accepts the late reply as execution authority", async t => {
  const f = await fixture(t, { apiChat: true }), resource = createOriginalMcpNativeChatRpcPort(f.session);
  const gate = deferred(), started = deferred(), controller = new AbortController();
  let nativeSignal;
  f.authorize(async (_input, signal) => { nativeSignal = signal; started.resolve(); await gate.promise; return true; });
  const request = { operation: "cancel", requestId: hash("native-cancel"), commandId: "fixed-cancel",
    chatUrl: `pkm://chats/0123456789abcdef/${randomUUID()}`, sourcePlanSha256: hash("native-source"),
    sourceUncertain: false, argumentsSha256: hash("cancel-fields"), selection: null };
  const pending = resource.apiChat.authorize(request, controller.signal);
  const rejected = assert.rejects(pending, { code: "NATIVE_CHAT_CANCELLED" });
  await started.promise; controller.abort(); await rejected;
  await until(() => nativeSignal.aborted); gate.resolve();
  await wait(20);
  assert.equal(f.state.dispatches, 0);
  const selected = await resource.apiChat.resolve({ requestId: hash("next-create"),
    requestedModelId: f.nativeSelection.modelId, chatUrl: null,
    sourcePlanSha256: hash("native-source"), expectedSelection: null }, new AbortController().signal);
  assert.deepEqual(selected, f.nativeSelection);
});

test("fixed real-socket catalogue/select/count/stream are exact epoch-bound handles; raw tool proposals never execute", async t => {
  const f = await fixture(t), { resource, selection, signal } = await f.select();
  assert.equal(resource.session, f.session); assertOriginalMcpNativeChatRpcPort(resource, f.session);
  assert.throws(() => assertOriginalMcpNativeChatRpcPort({ ...resource }), { code: "NATIVE_CHAT_RESOURCE_UNAUTHENTICATED" });
  const input = request(selection.selectionId);
  assert.equal((await resource.models.count(input, signal)).requestSha256, input.requestSha256);
  await resource.models.catalogue(signal);
  assert.equal((await resource.models.count(input, signal)).requestSha256, input.requestSha256,
    "An unchanged catalogue read does not revoke a real selection.");
  assert.equal(createOriginalMcpNativeChatRpcPort(f.session), resource);
  assert.deepEqual((await Array.fromAsync(resource.models.stream(input, signal))).map(event => event.type),
    ["text", "text", "usage", "finish"]);
  assert.equal(f.state.toolEffects, 0);
  await assert.rejects(resource.models.count({ ...input, requestSha256: "0".repeat(64) }, signal), { code: "NATIVE_CHAT_REQUEST_DIGEST" });
  await resource.dispose();
  assert.equal(resource.signal.aborted, true);
  assert.throws(() => resource.assertCurrent(), { code: "NATIVE_CHAT_RESOURCE_UNAUTHENTICATED" });
  f.session.assertCurrent();
});

test("15MiB native request/images use bounded hashed sequenced chunks and explicit ACK backpressure", { timeout: 120000 }, async t => {
  const f = await fixture(t), { resource, selection, signal } = await f.select(), hold = deferred();
  const input = request(selection.selectionId, [{ role: "user", content: "x".repeat(15 * 1024 * 1024),
    images: [{ label: "Fixture image", mimeType: "image/png", dataBase64: Buffer.alloc(1024).toString("base64") }] }]);
  const start = f.frames.length; f.holdAck(hold);
  const pending = resource.models.count(input, signal);
  await until(() => f.outbound.some(frame => frame.type === "native-chat-ack" && frame.nextSequence === 1
    && f.frames.slice(start).some(incoming => incoming.transferId === frame.transferId)));
  const chunks = f.frames.slice(start).filter(frame => frame.type === "native-chat-chunk");
  assert.equal(chunks.length, 1); await wait(30);
  assert.equal(f.frames.slice(start).filter(frame => frame.type === "native-chat-chunk").length, 1);
  hold.resolve(); await pending;
  assert.equal(f.state.counts, 1);
  assert(f.frames.every(frame => Buffer.byteLength(JSON.stringify(frame) + "\n") <= 16384));
  assert(f.frames.filter(frame => frame.type === "native-chat-chunk")
    .every(frame => Buffer.from(frame.data, "base64").length <= originalMcpNativeChatLimits.chunkBytes));
  const tooLarge = request(selection.selectionId, [{ role: "user", content: "x".repeat(16 * 1024 * 1024) }]);
  await assert.rejects(resource.models.count(tooLarge, signal), { code: "NATIVE_CHAT_PAYLOAD_LIMIT" });
  assert.equal(f.state.counts, 1);
});

test("single-inference event consumption applies backpressure instead of accumulating an unbounded stream", async t => {
  const f = await fixture(t), { resource, selection, signal } = await f.select(), iterator = resource.models.stream(request(selection.selectionId), signal);
  assert.equal((await iterator.next()).value.text, "One"); await wait(30);
  assert.equal(f.state.produced, 1);
  assert.equal((await iterator.next()).value.text, "Two");
  await iterator.return(); await until(() => f.state.cancelled === 1); f.session.assertCurrent();
});

test("full31-round execution plus summary awaits durable inference/tool/text/usage callbacks on the same bound request", { timeout: 120000 }, async t => {
  const f = await fixture(t), { resource, selection, signal } = await f.select(), trace = [], gate = deferred();
  const handlers = callbacks(trace), original = handlers.beforeInference;
  handlers.beforeInference = async value => { await original(value); if (value.round === 0) await gate.promise; };
  const pending = resource.execution.run(plan(selection.selectionId, 31), handlers, signal);
  await until(() => trace.length === 1); assert.equal(f.state.dispatches, 0);
  gate.resolve(); const result = await pending;
  assert.equal(result.status, "complete"); assert.equal(result.toolRoundLimit.rounds, 31);
  assert.equal(trace.filter(([kind]) => kind === "before").length, 32);
  assert.equal(trace.filter(([kind]) => kind === "tool").length, 31);
  assert.equal(trace.filter(([kind]) => kind === "text").length, 32);
  assert.equal(trace.filter(([kind]) => kind === "usage").length, 32);
  assert.equal(f.state.dispatches, 32);
});

test("unknown canonical tool effect stops continuation; no successful client receipt can replace a Node callback", async t => {
  const f = await fixture(t), { resource, selection, signal } = await f.select(), trace = [], handlers = callbacks(trace);
  handlers.tool = async () => ({ receiptSha256: hash("unknown"), content: "Reconcile.", effect: "unknown" });
  const result = await resource.execution.run(plan(selection.selectionId, 3), handlers, signal);
  assert.equal(result.status, "unknown"); assert.equal(f.state.dispatches, 1);
  assert.equal(trace.filter(([kind]) => kind === "before").length, 1);
});

test("cancel/disconnect abort native work, reject pending requests as uncertain and never replay", async t => {
  const f = await fixture(t), { resource, selection } = await f.select();
  const invoked = deferred(), stopped = deferred();
  f.modelMethods.stream = async function* (_input, signal) {
    f.state.dispatches++; invoked.resolve();
    await new Promise(resolve => { signal.addEventListener("abort", resolve, { once: true }); if (signal.aborted) resolve(); });
    stopped.resolve();
  };
  const controller = new AbortController(), iterator = resource.models.stream(request(selection.selectionId), controller.signal);
  const pending = iterator.next(); const rejected = assert.rejects(pending, { code: "NATIVE_CHAT_CANCELLED", dispatch: "uncertain" });
  await invoked.promise; controller.abort(); await rejected; await stopped.promise;
  assert.equal(f.state.dispatches, 1);
  const again = resource.models.catalogue(new AbortController().signal);
  await again;
  f.modelMethods.count = async (_input, signal) => {
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    throw new Error("Fixture cancelled.");
  };
  await resource.models.select({ modelId: "vscode:fixture:model",
    catalogueSha256: originalNativeChatDigest(await resource.models.catalogue(new AbortController().signal)) },
  new AbortController().signal);
  const requestId = request(selection.selectionId);
  const lost = resource.models.count(requestId, new AbortController().signal);
  const loss = assert.rejects(lost, error => {
    assert.equal(error.dispatch, "uncertain");
    assert.equal(error.code, "NATIVE_CHAT_SESSION_REVOKED");
    assert.equal(error.cause, f.session.signal.reason);
    assert.equal(error.cause.code, "NATIVE_ATTACHMENT_SESSION_REVOKED");
    return true;
  });
  await wait(10); f.socket.destroy(); await loss;
  assert.equal(resource.signal.aborted, true);
});

test("sequence corruption revokes the authenticated lane and all pending model requests", async t => {
  const f = await fixture(t), { resource, selection, signal } = await f.select();
  let changed = false;
  f.mutate(frame => {
    if (!changed && frame.type === "native-chat-chunk") { changed = true; return { ...frame, sequence: frame.sequence + 1 }; }
    return frame;
  });
  await assert.rejects(resource.models.count(request(selection.selectionId), signal), { dispatch: "uncertain" });
  await until(() => f.session.signal.aborted);
  assert.equal(f.state.dispatches, 0);
});

test("native proposals cannot choose an undeclared canonical tool or bypass durable inference admission", async t => {
  const f = await fixture(t), { resource, selection, signal } = await f.select();
  let effects = 0;
  f.execute(async (_plan, ports) => {
    await ports.tool({ inferenceId: hash("not-admitted"), round: 0, callId: "unbound-tool",
      name: "arbitrary_execute", arguments: {}, argumentsSha256: originalNativeChatDigest({}) });
    return { status: "complete", toolRoundLimit: null };
  });
  const handlers = callbacks(); handlers.tool = async () => { effects++; throw new Error("Must never dispatch."); };
  await assert.rejects(resource.execution.run(plan(selection.selectionId), handlers, signal),
    { code: "NATIVE_CHAT_INFERENCE_NOT_DURABLE", dispatch: "uncertain" });
  assert.equal(effects, 0); assert.equal(f.state.dispatches, 0);
});

test("canonical text/usage sink failure cannot become a successful execution or later inference", async t => {
  const f = await fixture(t), { resource, selection, signal } = await f.select(), trace = [];
  const handlers = callbacks(trace);
  handlers.text = async () => { throw new Error("Owned durable sink fixture failed."); };
  await assert.rejects(resource.execution.run(plan(selection.selectionId, 3), handlers, signal),
    { code: "NATIVE_CHAT_DISPATCH_UNCERTAIN", dispatch: "uncertain" });
  assert.equal(trace.filter(([kind]) => kind === "before").length, 1);
  assert.equal(f.state.dispatches, 1);
});

test("trusted callback table cannot be retargeted while native inference admission is awaited", async t => {
  const f = await fixture(t), { resource, selection, signal } = await f.select(), gate = deferred(), trace = [];
  const handlers = callbacks(trace), approved = handlers.beforeInference;
  handlers.beforeInference = async value => { await approved(value); if (value.round === 0) await gate.promise; };
  const pending = resource.execution.run(plan(selection.selectionId), handlers, signal);
  await until(() => trace.length === 1);
  handlers.tool = async () => { throw new Error("Caller changed the owned callback table."); };
  gate.resolve(); assert.equal((await pending).status, "complete");
  assert.equal(trace.filter(([kind]) => kind === "tool").length, 1);
});

test("actual uncertain native cancellation metadata is preserved without retry or HTTP fallback", async t => {
  const f = await fixture(t), { resource, selection, signal } = await f.select();
  f.modelMethods.stream = async function* () {
    f.state.dispatches++;
    throw Object.assign(new Error("Fixture native cancellation."), { code: "NATIVE_CHAT_CANCELLED", dispatch: "uncertain", cancelled: true });
  };
  await assert.rejects(Array.fromAsync(resource.models.stream(request(selection.selectionId), signal)),
    { code: "NATIVE_CHAT_CANCELLED", dispatch: "uncertain" });
  assert.equal(f.state.dispatches, 1); f.session.assertCurrent();
});

test("unfinished native stream cannot be reported as success; structured credential values never enter the lane", async t => {
  const f = await fixture(t), { resource, selection, signal } = await f.select();
  const input = request(selection.selectionId);
  await assert.rejects(resource.models.count({ ...input, apiKey: "fixture-value-not-to-be-transferred" }, signal),
    { code: "NATIVE_CHAT_CREDENTIAL_FIELD" });
  assert.equal(f.state.counts, 0);
  f.modelMethods.stream = async function* () { yield { type: "text", text: "Not terminated." }; };
  await assert.rejects(Array.fromAsync(resource.models.stream(input, signal)), { code: "NATIVE_CHAT_STREAM_UNFINISHED", dispatch: "uncertain" });
});

test("disposal drains/cancels pending work idempotently without closing the approval session", async t => {
  const f = await fixture(t), { resource, selection, signal } = await f.select(), invoked = deferred(), cancelled = deferred();
  f.modelMethods.count = async (_input, signal) => {
    invoked.resolve();
    await new Promise(resolve => { signal.addEventListener("abort", resolve, { once: true }); if (signal.aborted) resolve(); });
    cancelled.resolve(); throw new Error("Fixture disposed.");
  };
  const pending = resource.models.count(request(selection.selectionId), signal);
  const refusal = assert.rejects(pending, { code: "NATIVE_CHAT_CANCELLED", dispatch: "uncertain" });
  await invoked.promise;
  const first = resource.dispose(), second = resource.dispose();
  assert.equal(first, second); await first; await refusal; await cancelled.promise;
  await resource.closed; await wait(20); f.session.assertCurrent();
});

test("transport cleanup failure remains observable in closed and repeated disposal", async t => {
  const f = await fixture(t); f.closeFailure(new Error("Owned native fixture socket close failed."));
  assert.throws(() => f.producer.receive({ type: "native-chat-ready", protocol: "pkm.original-mcp-native-chat-rpc/v1",
    session: f.peerSession, methods: [], chunkBytes: 128, maxPayloadBytes: 16 * 1024 * 1024 }));
  await assert.rejects(f.producer.closed, error => {
    assert(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    f.state.expectedCleanupError = error; return true;
  });
  const first = f.producer.dispose(); assert.equal(first, f.producer.dispose());
  await assert.rejects(first, error => error === f.state.expectedCleanupError);
});

test("full1000-round boundary remains a bounded acknowledged execution, including the tool-free summary", { timeout: 180000 }, async t => {
  const f = await fixture(t), { resource, selection, signal } = await f.select(), trace = [];
  const execution = plan(selection.selectionId, 1000); execution.budget.deadlineMs = 180000;
  const result = await resource.execution.run(execution, callbacks(trace), signal);
  assert.equal(result.status, "complete"); assert.equal(result.toolRoundLimit.rounds, 1000);
  assert.equal(trace.filter(([kind]) => kind === "before").length, 1001);
  assert.equal(trace.filter(([kind]) => kind === "tool").length, 1000);
});
