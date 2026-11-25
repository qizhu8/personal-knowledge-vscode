import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { originalApiChatContextSummary, originalApiChatCreditUsage } from "../dist/domain/original-api-chat-projection.js";
import { createOriginalMcpNativeExecution, readOriginalMcpNativeExecution } from "../dist/original-mcp-api-chat-execution.js";
import { originalNativeChatDigest, originalNativeChatInferenceDigest } from "../dist/original-mcp-api-chat-contracts.js";
import { OriginalApiChatContextAssembler } from "../src/domain/original-api-chat-context.ts";
import { createOriginalApiChatInputImageStore } from "../dist/original-mcp-api-chat-input-images.js";
import { readOriginalMcpMemoryContext } from "../dist/original-mcp-memory-context.js";
import { hydrateOriginalMcpMemory } from "../dist/original-mcp-domains.js";
import { createOriginalMcpNativeChatSessionFixture } from "./fixtures/original-mcp-native-chat-session.mjs";
import { originalSdkProtocolFixture, unavailableNativeModelFixture } from "./fixtures/original-mcp-sdk-ports.mjs";
import { originalSdkDigest } from "../dist/original-mcp-sdk-model-contracts.js";
import { estimateChatPromptTokens } from "../dist/domain/chat-prompt-budget.js";
import { sdkConsumerPlan, inspectSdkConsumerJournal, sdkConsumerUntil } from "./fixtures/original-mcp-sdk-consumer-cases.mjs";
import { inspectLegacyApiChatArchive } from "../dist/legacy-api-chat-archive.js";
import { planOriginalMcpApiChatSource, admitOriginalMcpApiChatSource, originalMcpApiChatSource,
  readOriginalMcpApiChatMessage, activateOriginalMcpApiChatSource, originalMcpApiChatSourceActive,
  readOriginalMcpApiChatSourceSession } from "../dist/original-mcp-api-chat-source.js";

const require = createRequire(import.meta.url), extension = resolve(process.env.PKM_TEST_LEGACY_CHAT_EXTENSION ?? "legacy");
const originalFixture = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs");
const { ApiChatStore } = require(join(extension, "dist/chat/api-chat-store.js"));
const { WorkerTreeStore } = require(join(extension, "dist/chat/worker-tree.js"));
const originalProjections = require(join(extension, "dist/chat/api-chat-store.js"));
const hash = value => createHash("sha256").update(value).digest("hex");
function assertColdNativeChatReopen(root) {
  assert.deepEqual(readdirSync(root).filter(name => name.startsWith("core.sqlite-")), [],
    "Restart regression requires initially absent SQLite auxiliary metadata, not a warmed read path.");
}
async function fixture(t, large = false, nativeChat = false, modelMode = undefined, managed = false,
  retainedContext = false, draftImages = false, liveMemory = false) {
  const directory = resolve("tests", `.original-chat-source-${randomUUID()}`), root = join(directory, "root"), closes = [];
  mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(async () => { for (const close of closes.reverse()) await close(); rmSync(directory, { recursive: true, force: true }); });
  const mask = process.umask(0o077);
  let descriptor;
  try {
    descriptor = originalFixture.create({ extension, root });
    if (retainedContext) {
      const store = new ApiChatStore(descriptor.state, originalFixture.namespace), chat = store.load(descriptor.inline, false);
      chat.context = [{ id: "note:retained-context", label: "Retained Note snapshot", content: "Exact retained inline Note context." }];
      chat.agentContext = {
        memory: [{ id: "memory:retained", label: "Retained memory snapshot", content: "Historical memory, not a fresh grant." }],
        pkmSkills: [{ id: "skill:retained", label: "Retained PKM Skill snapshot", content: "Historical Skill reference only." }],
        externalSkills: [{ id: "file:///not-opened/retained.md", label: "Retained external Skill snapshot", content: "Do not dereference this file." }],
      };
      chat.messages.push({ id: "retained-tool-message", role: "assistant", content: "Historical tool answer.", status: "complete",
        toolCalls: [{ id: "retained-tool-call", name: "write_document", arguments: '{"id":"Never-replay"}',
          status: "complete", result: "Recorded old result, not current disk verification." }] });
      store.save(chat);
    }
    if (draftImages) {
      const store = new ApiChatStore(descriptor.state, originalFixture.namespace), chat = store.load(descriptor.inline, false);
      chat.images = [{ ...sourceImage, label: "retained-draft.png" }];
      store.save(chat);
    }
    if (managed) {
      const store = new ApiChatStore(descriptor.state, originalFixture.namespace), chat = store.load(descriptor.inline, false);
      store.startTask(chat, "Historical managed goal");
      chat.workerState = { treeId: new WorkerTreeStore(join(descriptor.state, "api-chat-worker-trees")).create(chat.id),
        sleeping: false, stopped: false, events: [] };
      chat.permissionMode = "allow-all"; chat.permissionGrants = ["historical-unqualified-grant"];
      chat.queuedInputs = [{ id: randomUUID(), text: "Unknown old queued input; never execute", mode: "task" }];
      store.save(chat);
    }
    if (large) {
      const store = new ApiChatStore(descriptor.state, originalFixture.namespace), chat = store.load(descriptor.segmented, false);
      for (let index = 0; index < 4100; index++) chat.messages.push({
        id: `preserved-${index}`, role: index % 2 ? "assistant" : "user",
        content: `Original paged message ${index}. ${"bounded-history".repeat(4)}`, status: "complete",
      });
      store.save(chat);
    }
  } finally { process.umask(mask); }
  mkdirSync(join(root, "notes"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nAuthoritative source fixture.\n", { mode: 0o600 });
  writeFileSync(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const oldHost = randomUUID(), request = hash("unknown historical source request");
  mkdirSync(join(descriptor.state, "api-chat-control/requests", oldHost), { recursive: true, mode: 0o700 });
  const control = join(descriptor.state, "api-chat-control/requests", oldHost, `${request}.json`);
  writeFileSync(control, JSON.stringify({ schema: "pkm.api-chat.request/v1", hostId: oldHost, requestId: request,
    operation: "send", status: "running", arguments: { chatId: descriptor.segmented, prompt: "Unknown old send; never replay" } }), { mode: 0o600 });
  const controlBefore = readFileSync(control);
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "chat-source-fixture", profileSha256: hash("native-separate-profile"),
    limits: { maxEntries: 30_000, maxDepth: 32, maxBytes: 64 * 1024 * 1024, maxFileBytes: 16 * 1024 * 1024 } });
  const lifetime = new AbortController();
  let modelCalls = 0, host, blockCatalogue = false, allowTools = false, fullNative = false, failPresentation = false,
    selectionProvider = modelMode ? "openai-compatible" : "vscode", modelApprovalHook, toolApprovalHook;
  const presented = [], modelPayloads = [], nativeEpoch = randomUUID();
  const prepareHost = (storage, epoch = nativeEpoch, nativeChatResource = undefined) => createOriginalMcpNativeHost(storage, {
    profileSha256: plan.profileSha256, sourceCatalogSha256: originalPublicMcpContracts().provenance.metadataSha256,
    authorityId: "trusted-chat-source-fixture-only", epoch, signal: lifetime.signal,
    assertCurrent() {}, async authorizeAdmission() { return true; }, async authorizePublic() { return true; },
    models: { configuration: modelMode ? { apiChatProvider: "openai-compatible", aiEndpoint: "https://fresh-fixture.invalid/v1",
      aiModel: "fixture-http-profile", apiChatModelProfiles: [{ id: "fixture-http-profile", model: "fixture-http-model",
        contextWindow: 8192, maxOutputTokens: 1024, status: "active" }] }
      : { aiEndpoint: "https://not-called.invalid", aiModel: "not-used" },
      registryAvailability: modelMode ? { "openai-compatible": true } : {},
      async credentialAvailable() { return !!modelMode; }, async authorizeRequest() {
        if (modelApprovalHook) await modelApprovalHook();
        return !!modelMode;
      },
      transport: { supports: provider => !!modelMode && provider === "openai-compatible", async open(request) {
        modelCalls++;
        modelPayloads.push(structuredClone(request.payload));
        if (!modelMode) throw new Error("Historical sources cannot send models.");
        const encoder = new TextEncoder();
        return new ReadableStream({ start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Actual owned native response."},"finish_reason":null}]}\n\n'));
          if (modelMode !== "wait") {
            controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
            controller.close();
          }
        } });
      } } },
    ...(modelMode ? { toolCatalog: [{ name: "get_document", operation: "knowledge.document.get", approvalRequired: true }],
      async approveTool() { if (toolApprovalHook) await toolApprovalHook(); return allowTools; }, async reviewTool(binding) {
        return { actorId: binding.actorId, decisionId: randomUUID(), decision: allowTools ? "approve" : "reject" };
      } } : {}),
      ...(liveMemory ? { async authorizeMemoryDecision() {
        return { actorId: "human:chat-memory-fixture", decisionId: randomUUID() };
      } } : {}),
    ...(nativeChat ? { apiChat: {
      async catalogue(_binding, signal) {
        if (blockCatalogue) await new Promise((_resolve, reject) => {
          if (signal.aborted) reject(new Error("Native catalogue cancelled."));
          else signal.addEventListener("abort", () => reject(new Error("Native catalogue cancelled.")), { once: true });
        });
        return { source: "vscode.lm", epoch, models: [{
        id: "fixture-native-model", nativeModelId: "fixture-native-wire-id", label: "Fixture native model", vendor: "fixture", family: "fixture", version: "fixture",
        maxInputTokens: 8192, maxOutputTokens: null,
      }] }; },
      async resolve() {
        if (fullNative) return { protocol: "pkm.original-api-chat-execution/v1", epoch,
          modelId: "fixture-native-model", wireModelId: "fixture-native-wire-id", provider: "vscode", permissionMode: "protective",
          outputTokenCap: 128, budget: { maxInputTokens: 8192, maxTotalOutputTokens: 2048, deadlineMs: 120000 } };
        return { protocol: "pkm.native-bounded-chat/v1", epoch,
        modelId: selectionProvider === "vscode" ? "fixture-native-model" : "fixture-http-profile",
        wireModelId: selectionProvider === "vscode" ? "fixture-native-wire-id" : "fixture-http-model",
        profileId: selectionProvider === "vscode" ? "fixture-native-profile" : "fixture-http-profile",
        provider: selectionProvider, permissionMode: "protective",
        budget: { maxSteps: 4, maxInputTokens: 8192, maxOutputTokens: 1024, maxTotalOutputTokens: 4096, deadlineMs: 120000 } }; },
      async authorize(request) { assert.equal(request.actorId, "mcp:external"); return true; },
      async present(request) {
        presented.push(request.chatUrl);
        if (failPresentation) throw new Error("Native presentation was revoked after canonical create.");
      },
    } } : {}),
  }, nativeChatResource ? { nativeChat: nativeChatResource } : undefined);
  const opened = await openOriginalMcpRoot(plan, modelMode ? { prepareNative: async storage => {
    host = await prepareHost(storage); return host.options;
  } } : {});
  closes.push(() => opened.owner.close());
  if (modelMode) await opened.owner.ensureFull();
  else host = await prepareHost(opened.storage);
  const stage = join(directory, "source-stage"); mkdirSync(stage, { mode: 0o700 });
  const policy = { async authorize() { return { actorId: "mcp:external", decisionId: randomUUID(), expiresAtMs: Date.now() + 300_000 }; } };
  return { directory, root, descriptor, stage, plan, opened, host, policy, control, controlBefore, oldHost, request,
    modelCalls: () => modelCalls, modelPayloads, presented, closes, prepareHost,
    allowTools: value => { allowTools = value; },
    fullNative: value => { fullNative = value; },
    failPresentation: value => { failPresentation = value; },
    modelApprovalHook: value => { modelApprovalHook = value; },
    toolApprovalHook: value => { toolApprovalHook = value; },
    blockCatalogue: value => { blockCatalogue = value; }, selectProvider: value => { selectionProvider = value; } };
}
const bounds = { maxChats: 100, maxMessagesPerChat: 20_000, maxMessages: 30_000 };
async function appendNativeHistory(f, chatId, count = 102) {
  const { runtime } = await f.opened.owner.ensureFull(), actor = { id: "mcp:external", canWrite: true };
  const dispatch = async (operation, args, write = false) => {
    const response = await runtime.core.dispatch(write ? "capability_call" : "capability_read",
      { operation, version: 1, arguments: args }, actor);
    assert.equal(response.error, undefined);
    return response.result;
  };
  let session = await dispatch("chat.session.get", { id: chatId });
  const messages = [];
  for (let index = 0; index < count; index++) {
    const message = { id: randomUUID(), role: index % 2 ? "assistant" : "user",
      content: `Ordered native history ${index}.`, status: "complete" };
    session = (await dispatch("chat.session.append", { id: chatId, expectedRevision: session.revision,
      operationId: randomUUID(), message }, true)).session;
    messages.push({ role: message.role, content: message.content });
  }
  assert(messages.length + 1 < 126);
  assert(Buffer.byteLength(JSON.stringify(messages)) < 240_000);
  assert(estimateChatPromptTokens(messages) < 8192);
  return messages;
}
async function verifyNativePagingRefusals(t, f, backend, chatId, executions) {
  const { runtime } = await f.opened.owner.ensureFull(), dispatch = runtime.core.dispatch;
  for (const fault of ["revision", "cursor"]) await t.test(`native transcript refuses inconsistent ${fault} between pages`, async () => {
    let pages = 0, firstCursor;
    const before = executions();
    runtime.core.dispatch = async function(method, input, actor) {
      const response = await dispatch.call(this, method, input, actor);
      if (input.operation !== "chat.session.messages" || input.arguments.id !== chatId || response.error) return response;
      pages++;
      if (pages === 1) {
        assert.equal(response.result.hasMore, true);
        firstCursor = response.result.nextCursor;
        if (fault === "revision") {
          const session = await dispatch.call(this, "capability_read",
            { operation: "chat.session.get", version: 1, arguments: { id: chatId } }, actor);
          const changed = await dispatch.call(this, "capability_call", { operation: "chat.session.append", version: 1,
            arguments: { id: chatId, expectedRevision: session.result.revision, operationId: randomUUID(),
              message: { id: randomUUID(), role: "user", content: "Concurrent native revision.", status: "complete" } } }, actor);
          assert.equal(changed.error, undefined);
        }
      } else if (fault === "cursor") response.result.nextCursor = firstCursor;
      return response;
    };
    try {
      const args = { host_id: f.opened.workspaceId, chat_id: chatId, prompt: "Refuse mixed native context.",
        command_id: `paged-${fault}-${randomUUID()}` };
      const failed = await settled(backend, await invoke(backend, "api_chat_send", args));
      assert.equal(failed.status, "failed");
      assert.match(failed.error, fault === "revision" ? /NATIVE_CHAT_CONTEXT_SESSION_CHANGED/ : /inconsistent native transcript cursor/);
      assert.equal(pages, 2);
      assert.equal(executions(), before, "Invalid context cannot reach a provider or native execution.");
      const readPages = pages;
      assert.deepEqual(await invoke(backend, "api_chat_send", args), failed);
      assert.equal(pages, readPages, "Receipt replay never reconstructs or automatically retries context.");
    } finally { runtime.core.dispatch = dispatch; }
  });
}
async function signedSdkConsumerFixture(t) {
  const f = await fixture(t, false, true, "respond");
  let wire;
  const sdkFixture = originalSdkProtocolFixture(() => wire.activationId);
  wire = await createOriginalMcpNativeChatSessionFixture(t, {
    binding: { root: f.root, workspaceId: f.opened.workspaceId, planSha256: f.plan.planSha256,
      catalogSha256: originalPublicMcpContracts().provenance.metadataSha256, profileSha256: f.plan.profileSha256 },
    ...unavailableNativeModelFixture(() => wire.activationId), sdk: sdkFixture.sdk,
  });
  f.allowTools(true);
  const host = await f.prepareHost(f.opened.storage, wire.activationId, wire.resource);
  const source = await planOriginalMcpApiChatSource(f.opened.storage, host, { stagingDirectory: f.stage, limits: bounds });
  await admitOriginalMcpApiChatSource(f.opened.storage, host, source, f.policy);
  const signal = new AbortController().signal;
  const catalogue = await wire.resource.sdk.catalogue(signal);
  const selection = await wire.resource.sdk.select({
    modelId: sdkFixture.model.id, catalogueSha256: originalSdkDigest(catalogue),
  }, signal);
  const consumer = await createOriginalMcpNativeExecution(f.opened.owner,
    { id: "mcp:external", canWrite: true }, host, wire.resource.execution, wire.resource.sdk);
  f.closes.push(() => consumer.close());
  const plan = sdkConsumerPlan({ host, source, selection,
    chatUrl: `pkm://chats/${originalFixture.namespace}/${f.descriptor.inline}` });
  plan.tools = await consumer.modelTools(plan);
  return { ...f, host, wire, sdkFixture, consumer, plan };
}

test("SDK authenticated durable consumer awaits exact sending ACK before canonical tool handler and provider-only usage", { timeout: 120000 }, async t => {
  // Real signed socket, Root/source journal and canonical read effect; explicit fixture SDK ports are not model/role/human proof.
  const f = await signedSdkConsumerFixture(t);
  let release, pendingBoundary;
  const hold = new Promise(resolve => { release = resolve; });
  f.sdkFixture.authorize(async boundary => {
    pendingBoundary = boundary;
    const snapshot = inspectSdkConsumerJournal(f.opened.storage, f.plan.requestId);
    assert(snapshot.events.some(event => event.type === "sdk-sending-intent" && event.payload.boundaryId === boundary.boundaryId));
    assert(!snapshot.events.some(event => event.type === "sdk-sending-approved"));
    await hold;
  });
  const run = f.consumer.run(f.plan, f.sdkFixture.model.id);
  await sdkConsumerUntil(() => pendingBoundary !== undefined);
  assert.equal(f.sdkFixture.state.sends, 0); assert.equal(f.sdkFixture.state.toolResults.length, 0);
  assert.equal(inspectSdkConsumerJournal(f.opened.storage, f.plan.requestId).canonicalTools.length, 0);
  release();
  const result = await run;
  assert.equal(result.status, "complete"); assert.equal(result.provider, "copilot-sdk");
  assert.equal(result.usageSource, "provider-reported"); assert.equal(result.context.providerTokenCount, null);
  assert.equal(result.context.cost, null); assert.equal(result.context.sendingBoundaryCount, 1);
  assert.equal(f.sdkFixture.state.sends, 1); assert.equal(f.sdkFixture.state.toolResults.length, 1);
  assert.match(f.sdkFixture.state.toolResults[0].content, /Authoritative source fixture/);
  assert.equal(f.sdkFixture.state.toolResults[0].effect, "not-committed");
  const journal = inspectSdkConsumerJournal(f.opened.storage, f.plan.requestId);
  assert.equal(journal.nativeInferences, 0);
  const admitted = journal.events.find(event => event.type === "sdk-sending-approved");
  const tool = journal.events.find(event => event.type === "sdk-tool-intent");
  const receipt = journal.events.find(event => event.type === "sdk-tool-result");
  assert(admitted.sequence < tool.sequence);
  assert.equal(tool.payload.sendingBoundaryId, admitted.payload.boundaryId);
  assert.equal(tool.payload.sdkSessionId, admitted.payload.binding.sdkSessionId);
  assert.equal(tool.payload.provenance, "sdk-session-tool-invocation");
  assert.equal(Object.hasOwn(tool.payload, "inferenceId"), false);
  assert.equal(journal.canonicalTools.length, 1);
  assert.equal(journal.canonicalTools[0].actor_id, "mcp:external");
  assert.equal(journal.canonicalTools[0].workspace_id, f.opened.workspaceId);
  assert.equal(receipt.payload.executionId, journal.canonicalTools[0].execution_id);
  assert.deepEqual(await f.consumer.run(f.plan, f.sdkFixture.model.id), result);
  assert.equal(f.sdkFixture.state.runs, 1, "Reading the exact durable execution never replays SDK work.");
  await f.wire.close();
  assert.throws(() => readOriginalMcpNativeExecution(f.opened.storage, f.host, f.plan.requestId));
  assert.equal(f.modelCalls(), 0, "No native LM or HTTP model fallback ran.");
});

test("SDK authenticated pending sending ACK cancellation discards late approval before canonical effects", { timeout: 120000 }, async t => {
  const f = await signedSdkConsumerFixture(t), controller = new AbortController();
  let release, requested = false;
  const hold = new Promise(resolve => { release = resolve; });
  f.sdkFixture.authorize(async () => { requested = true; await hold; });
  const run = f.consumer.run(f.plan, f.sdkFixture.model.id, controller.signal);
  void run.catch(() => {});
  await sdkConsumerUntil(() => requested);
  controller.abort();
  await assert.rejects(run);
  release(); await new Promise(resolve => setTimeout(resolve, 20));
  const journal = inspectSdkConsumerJournal(f.opened.storage, f.plan.requestId);
  assert.equal(f.sdkFixture.state.sends, 0); assert.equal(journal.canonicalTools.length, 0);
  assert(journal.events.some(event => event.type === "sdk-sending-intent"));
  assert(!journal.events.some(event => event.type === "sdk-sending-approved" || event.type === "sdk-tool-intent"));
  assert.equal(journal.execution.status, "failed"); assert.equal(journal.nativeInferences, 0);
  assert.equal(f.modelCalls(), 0);
});
const invoke = async (backend, tool, args = {}) => {
  const response = await backend.invoke("original_mcp_public", { tool, arguments: args });
  return response.structuredContent ?? JSON.parse(response.content[0].text);
};
async function settled(backend, request) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await invoke(backend, "api_chat_request_get", { host_id: request.host_id, request_id: request.request_id });
    if (!["queued", "running"].includes(state.status)) return state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Owned fixture request did not settle.");
}

test("large original v2 CAS history is indexed one message at a time without the small archive gate or old request replay", { timeout: 120_000 }, async t => {
  const f = await fixture(t, true);
  assert.throws(() => inspectLegacyApiChatArchive(f.root), /4096 entities/);
  const source = await planOriginalMcpApiChatSource(f.opened.storage, f.host, { stagingDirectory: f.stage, limits: bounds });
  assert(source.messages > 4100);
  assert.equal(source.controls, 1);
  await admitOriginalMcpApiChatSource(f.opened.storage, f.host, source, f.policy);
  const db = f.opened.storage.connectNative();
  let count;
  try {
    count = Number(db.prepare("SELECT message_count FROM original_api_chat_source_chats WHERE id=?").get(f.descriptor.segmented).message_count);
    assert.throws(() => db.prepare("DELETE FROM original_api_chat_source_messages").run(), /immutable/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM original_api_chat_source_controls").get().n, 1);
  } finally { db.close(); }
  const last = await readOriginalMcpApiChatMessage(f.opened.storage, f.host, f.descriptor.segmented, count);
  assert.equal(last.id, "preserved-4099");
  assert.match(last.content, /Original paged message 4099/);
  assert.equal(originalMcpApiChatSource(f.opened.storage, f.host).planSha256, source.planSha256);
  assert.deepEqual(readFileSync(f.control), f.controlBefore);
  assert.equal(f.modelCalls(), 0);
});

async function liveMemoryFixture(t) {
  const f = await fixture(t, false, true, "respond", false, false, false, true);
  const source = await planOriginalMcpApiChatSource(f.opened.storage, f.host,
    { stagingDirectory: f.stage, limits: bounds });
  await admitOriginalMcpApiChatSource(f.opened.storage, f.host, source, f.policy);
  const scope = JSON.stringify({ account: "local-owner", project: hash(f.root), repository: hash(f.root) });
  const id = `explicit-${hash(`${scope}\0memory-proposal`)}`, snapshot = join(f.directory, "memory-source.sqlite3");
  execFileSync("python3", ["-B", "-c", `
import sys
from pkm_memory_engine import Engine
e=Engine(sys.argv[1],"chat-memory-source-fixture")
e.mutate("memory-proposal","explicit_propose",{"id":sys.argv[3],"scope":sys.argv[2],
 "content":"SQLite memory fact with exact quoted sources.","sources":[{"id":"memory-source","chat":"memory-chat",
 "revision":"turn-1","locator":"message/1"}]})
e.mutate("memory-confirm","explicit_confirm",{"id":sys.argv[3],"scope":sys.argv[2],"expected_revision":1,
 "host_authorization":{"decision_id":"historical-decision","actor_id":"human:old-profile"}})
e.close()
`, snapshot, scope, id], { env: { ...process.env, PYTHONPATH: resolve("compute"), PYTHONDONTWRITEBYTECODE: "1" } });
  chmodSync(snapshot, 0o600);
  const memoryStage = join(f.directory, "memory-stage"); mkdirSync(memoryStage, { mode: 0o700 });
  const policy = { async authorize() {
    return { actorId: "mcp:external", decisionId: randomUUID(), expiresAtMs: Date.now() + 120_000 };
  } };
  await hydrateOriginalMcpMemory(f.opened.storage, f.host,
    { sourceSnapshot: snapshot, sourceScopeSha256: hash(scope), stagingDirectory: memoryStage }, policy);
  const { runtime } = await f.opened.owner.ensureFull(), actor = { id: "mcp:external", canWrite: true };
  const core = async (operation, args, write = false) => {
    const response = await runtime.core.dispatch(write ? "capability_call" : "capability_read",
      { operation, version: 1, arguments: args }, actor);
    assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result;
  };
  const session = await core("chat.session.create", { id: f.descriptor.inline, title: "Explicit live Memory context",
    expectedRevision: 0, operationId: randomUUID() }, true);
  const memory = await readOriginalMcpMemoryContext(f.opened.owner, f.host, { query: "SQLite" });
  const plan = {
    schema: "pkm.original-api-chat-execution/v1", requestId: hash(randomUUID()),
    chatUrl: `pkm://chats/${originalFixture.namespace}/${f.descriptor.inline}`,
    selectionId: "live-memory-model-fixture", sourcePlanSha256: source.planSha256,
    messages: [], tools: [], hardToolRoundLimit: 1, outputTokenCap: 128,
    budget: { maxInputTokens: 8192, maxTotalOutputTokens: 2048, deadlineMs: 120_000 },
  };
  const context = new OriginalApiChatContextAssembler({ chatUrl: plan.chatUrl, sourcePlanSha256: source.planSha256 }, false);
  context.liveMemory(memory, { requestId: plan.requestId, workspaceId: f.opened.workspaceId,
    nativeEpoch: f.host.receipt.epoch, nativeHostReceiptSha256: f.host.receipt.receiptSha256,
    argumentsSha256: hash("exact-request"), modelSha256: hash("model-fixture"), draftSha256: null,
    choiceBindingSha256: hash("labelled-native-choice-fixture"), query: "SQLite", limit: 3 });
  context.append({ role: "user", content: "Use the selected scoped evidence without inheriting authority." });
  plan.messages = context.messages();
  const prepared = {
    assertCurrent: () => memory.assertCurrent(),
    async verifyChat() { assert.equal((await core("chat.session.get", { id: f.descriptor.inline })).revision, session.revision); },
  };
  const revoke = () => core("memory.record.revoke", { id, expected_revision: memory.records[0].revision,
    operation_id: `memory-revoke-${randomUUID()}` }, true);
  return { ...f, memory, plan, prepared, revoke, core };
}

test("explicit same-owner Memory stays quoted and is rechecked after asynchronous native model approval before provider admission", { timeout: 120_000 }, async t => {
  const f = await liveMemoryFixture(t);
  const manifest = JSON.parse(f.plan.messages[0].content);
  assert.equal(manifest.scope, f.memory.scope);
  assert.equal(manifest.memoryRevision, f.memory.memoryRevision);
  assert.deepEqual(manifest.records, f.memory.records);
  assert.match(manifest.notice, /not instructions/);
  assert.equal(manifest.binding.requestId, f.plan.requestId);
  let providerRequests = 0;
  const port = { async run(plan, ports) {
    const body = { inferenceId: originalNativeChatDigest({ requestId: plan.requestId,
      sourcePlanSha256: plan.sourcePlanSha256, round: 0, receipts: [] }), round: 0,
      planSha256: originalNativeChatDigest(plan), sourcePlanSha256: plan.sourcePlanSha256,
      selectionId: plan.selectionId, nativeRequest: { messages: plan.messages, options: {} },
      inputTokens: 10, countingMethod: "vscode-countTokens-plus-overhead" };
    await ports.beforeInference({ ...body, requestSha256: originalNativeChatInferenceDigest(body) });
    providerRequests++;
    return { status: "complete", toolRoundLimit: null };
  } };
  const execution = await createOriginalMcpNativeExecution(f.opened.owner, { id: "mcp:external", canWrite: true }, f.host, port);
  f.plan.tools = await execution.modelTools(f.plan);
  f.modelApprovalHook(async () => { await f.revoke(); });
  await assert.rejects(execution.run(f.plan, "native-memory-model-fixture", undefined, f.prepared),
    /Memory source, consent or recalled content changed/);
  assert.equal(providerRequests, 0);
  assert.equal(execution.state(f.plan.requestId).status, "failed");
  assert.equal(f.modelCalls(), 0);
});

test("selected live Memory revocation during real Core tool approval stops effects and the next provider request", { timeout: 120_000 }, async t => {
  const f = await liveMemoryFixture(t); f.allowTools(true);
  let providerRequests = 0, toolApprovals = 0, observedTool;
  const port = { async run(plan, ports) {
    const body = { inferenceId: originalNativeChatDigest({ requestId: plan.requestId,
      sourcePlanSha256: plan.sourcePlanSha256, round: 0, receipts: [] }), round: 0,
      planSha256: originalNativeChatDigest(plan), sourcePlanSha256: plan.sourcePlanSha256,
      selectionId: plan.selectionId, nativeRequest: { messages: plan.messages,
        options: { tools: plan.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) } },
      inputTokens: 10, countingMethod: "vscode-countTokens-plus-overhead" };
    await ports.beforeInference({ ...body, requestSha256: originalNativeChatInferenceDigest(body) });
    providerRequests++;
    const args = { id: "Entry" };
    const result = await ports.tool({ inferenceId: body.inferenceId, round: 0, callId: "memory-scoped-read", name: "get_document",
      arguments: args, argumentsSha256: originalNativeChatDigest(args) });
    observedTool = result;
    const next = { ...body, inferenceId: originalNativeChatDigest({ requestId: plan.requestId,
      sourcePlanSha256: plan.sourcePlanSha256, round: 1, receipts: [result.receiptSha256] }), round: 1,
      nativeRequest: { messages: plan.messages, options: {} } };
    await ports.beforeInference({ ...next, requestSha256: originalNativeChatInferenceDigest(next) });
    providerRequests++;
    return { status: "complete", toolRoundLimit: null };
  } };
  const execution = await createOriginalMcpNativeExecution(f.opened.owner, { id: "mcp:external", canWrite: true }, f.host, port);
  f.plan.tools = await execution.modelTools(f.plan);
  f.toolApprovalHook(async () => { toolApprovals++; await f.revoke(); });
  await assert.rejects(execution.run(f.plan, "native-memory-model-fixture", undefined, f.prepared));
  assert.equal(toolApprovals, 1, JSON.stringify(observedTool));
  assert.equal(providerRequests, 1);
  assert.equal(execution.state(f.plan.requestId).status, "unknown");
  assert.equal(f.modelCalls(), 0);
});

test("source activation needs genuine parsed custody and fresh native source-domain approval", { timeout: 120_000 }, async t => {
  const f = await fixture(t), source = await planOriginalMcpApiChatSource(f.opened.storage, f.host,
    { stagingDirectory: f.stage, limits: bounds });
  await assert.rejects(admitOriginalMcpApiChatSource(f.opened.storage, f.host, source,
    { async authorize() { return null; } }), /Fresh exact native/);
  await assert.rejects(admitOriginalMcpApiChatSource(f.opened.storage, f.host, structuredClone(source), f.policy), /branded source plan/);
  const db = f.opened.storage.connectNative();
  try { assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='original_api_chat_source_admission'").get(), undefined); }
  finally { db.close(); }
  assert.equal(f.modelCalls(), 0);
  assert.deepEqual(readFileSync(f.control), f.controlBefore);
});

test("Chat source worker evidence has independent revocation on review, denial, replacement and host close", { timeout: 120_000 }, async t => {
  const f = await fixture(t), source = await planOriginalMcpApiChatSource(f.opened.storage, f.host,
    { stagingDirectory: f.stage, limits: bounds });
  assert.throws(() => readOriginalMcpApiChatSourceSession(f.opened.storage, f.host), /fresh source-domain session/);
  await admitOriginalMcpApiChatSource(f.opened.storage, f.host, source, f.policy);
  const prior = readOriginalMcpApiChatSourceSession(f.opened.storage, f.host), flag = new Int32Array(prior.revocation);
  assert.equal(Atomics.load(flag, 0), 0);
  assert.equal(prior.planSha256, source.planSha256);
  assert.equal(prior.nativeHostReceiptSha256, f.host.receipt.receiptSha256);
  assert.equal(prior.epoch, f.host.receipt.epoch);
  await assert.rejects(activateOriginalMcpApiChatSource(f.opened.storage, f.host, {
    async authorize() {
      assert.equal(Atomics.load(flag, 0), 1, "Worker source evidence is revoked before the review await.");
      f.host.assertCurrent();
      assert.equal(originalMcpApiChatSourceActive(f.opened.storage, f.host), false);
      return null;
    },
  }), /Fresh exact native/);
  assert.throws(() => readOriginalMcpApiChatSourceSession(f.opened.storage, f.host), /fresh source-domain session/);
  await activateOriginalMcpApiChatSource(f.opened.storage, f.host, f.policy);
  const next = readOriginalMcpApiChatSourceSession(f.opened.storage, f.host);
  assert.notEqual(next.revocation, prior.revocation);
  assert.notEqual(next.decisionId, prior.decisionId);
  assert.equal(Atomics.load(flag, 0), 1, "Re-admission must not resurrect an earlier worker resource.");
  assert.equal(Atomics.load(new Int32Array(next.revocation), 0), 0);
  await f.host.close();
  assert.equal(Atomics.load(new Int32Array(next.revocation), 0), 1);
  assert.equal(f.modelCalls(), 0);
  assert.deepEqual(readFileSync(f.control), f.controlBefore);
});

test("original Host/read/request protocol retains exact IDs, paging/idempotency and uncertain old receipts without old Host authority", { timeout: 120_000 }, async t => {
  const f = await fixture(t), source = await planOriginalMcpApiChatSource(f.opened.storage, f.host,
    { stagingDirectory: f.stage, limits: bounds });
  await admitOriginalMcpApiChatSource(f.opened.storage, f.host, source, f.policy);
  const backend = createNativePublicOwnerBackend(f.opened.owner, { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: f.host });
  f.closes.push(() => backend.close());
  const capabilities = await invoke(backend, "api_chat_capabilities");
  assert.equal(capabilities.hosts[0].host_id, f.opened.workspaceId);
  assert.notEqual(capabilities.hosts[0].host_id, f.oldHost);
  const historical = await invoke(backend, "api_chat_request_get", { host_id: f.oldHost, request_id: f.request });
  assert.equal(historical.status, "outcome_unknown");
  const args = { host_id: f.opened.workspaceId, command_id: "read-page-once", offset: 0, limit: 1 };
  const submitted = await invoke(backend, "api_chat_list", args), listed = await settled(backend, submitted);
  assert.equal(listed.status, "succeeded");
  assert.equal(listed.result.chats.length, 1);
  assert.equal(listed.result.total, 2);
  assert.notEqual(listed.result.nextOffset, null);
  assert.deepEqual(await invoke(backend, "api_chat_list", args), listed);
  await assert.rejects(invoke(backend, "api_chat_list", { ...args, limit: 2 }), /different request/);
  const read = await settled(backend, await invoke(backend, "api_chat_get",
    { host_id: f.opened.workspaceId, chat_id: f.descriptor.segmented, command_id: "get-original" }));
  assert.equal(read.status, "succeeded");
  assert.equal(read.result.chatId, f.descriptor.segmented);
  assert.match(read.result.chatUrl, new RegExp(originalFixture.namespace));
  const models = await settled(backend, await invoke(backend, "api_chat_models",
    { host_id: f.opened.workspaceId, command_id: "missing-native-catalogue" }));
  assert.equal(models.status, "failed");
  assert.match(models.error, /NATIVE_VSCODE_MODEL_CATALOGUE_REQUIRED/);
  assert.deepEqual(readFileSync(f.control), f.controlBefore);
  assert.equal(f.modelCalls(), 0);
});

test("typed native catalogue and Group-only create reach the actual canonical Core once, not remembered source permissions", { timeout: 120_000 }, async t => {
  const f = await fixture(t, false, true), source = await planOriginalMcpApiChatSource(f.opened.storage, f.host,
    { stagingDirectory: f.stage, limits: bounds });
  await admitOriginalMcpApiChatSource(f.opened.storage, f.host, source, f.policy);
  const backend = createNativePublicOwnerBackend(f.opened.owner, { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: f.host });
  f.closes.push(() => backend.close());
  const models = await settled(backend, await invoke(backend, "api_chat_models", { host_id: f.opened.workspaceId, command_id: "catalogue" }));
  assert.equal(models.result.models[0].maxOutputTokens, null);
  const args = { host_id: f.opened.workspaceId, title: "Native Group-only fixture", model_id: "fixture-native-model", command_id: "create-once" };
  const created = await settled(backend, await invoke(backend, "api_chat_create", args));
  assert.equal(created.status, "succeeded");
  assert.equal(created.result.sessionId, null);
  const { runtime } = await f.opened.owner.ensureFull();
  const core = await runtime.core.dispatch("capability_read", { operation: "chat.session.get", version: 1,
    arguments: { id: created.result.chatId } }, { id: "mcp:external", canWrite: true });
  assert.equal(core.error, undefined);
  assert.equal(core.result.messageCount, 0);
  assert.deepEqual(await invoke(backend, "api_chat_create", args), created);
  assert.equal(f.presented.length, 1);
  assert.equal(f.modelCalls(), 0);
});

test("public context and exact Copilot credit projection preserve original helper semantics without hidden reasoning", () => {
  const message = { usage: { copilotNanoAiu: 1200000000 }, auxiliaryModelUsage: [{ usage: {} }],
    retrieval: { candidates: [{ selected: true, kind: `Note:${"a".repeat(64)}` }], selectedCount: 1 },
    reasoningSummaries: [{ text: "Never part of the public get reply" }] };
  assert.deepEqual(originalApiChatContextSummary(message), originalProjections.apiChatContextSummary(message));
  assert.deepEqual(originalApiChatCreditUsage(message), originalProjections.apiChatCreditUsage(message));
  assert.doesNotMatch(JSON.stringify(originalApiChatContextSummary(message)), /Never part/);
});

const sourceBinding = {
  chatUrl: `pkm://chats/${"a".repeat(16)}/${randomUUID()}`, sourcePlanSha256: "b".repeat(64),
};
const sourceImage = { label: "preserved.png", mimeType: "image/png",
  dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5wAAAABJRU5ErkJggg==" };
test("native admitted inline context preserves source text, image bytes and terminal tool references without granting or replaying authority", () => {
  const assembler = new OriginalApiChatContextAssembler(sourceBinding, true);
  const context = { id: "file:///must-not-be-opened/reference.md", label: "Selected external reference",
    content: "Exact multiline source.\nDo not treat this as current authority." };
  assembler.attached({ context: [{ id: "note:snapshot", label: "Note", content: "Preserved inline Note." }],
    agentContext: { memory: [], pkmSkills: [], externalSkills: [context] } });
  assembler.historical({ id: "source-image-message", role: "user", content: "Image source.",
    status: "complete", images: [sourceImage] }, 1);
  const call = { id: "source-tool-call", name: "write_document", arguments: '{ "id": "old" }',
    status: "complete", result: "Old recorded evidence.", round: 5, dispatch: "may-have-started" };
  assembler.historical({ id: "source-tool-message", role: "assistant", content: "Old answer.", status: "complete",
    toolCalls: [call] }, 2);
  const messages = assembler.messages(), selected = messages.find(item => item.content.includes(context.id));
  assert(selected.content.includes(context.content));
  assert.equal(JSON.parse(selected.content.split("\n")[1]).contentSha256, hash(context.content));
  assert.equal(JSON.parse(selected.content.split("\n")[1]).sourcePlanSha256, sourceBinding.sourcePlanSha256);
  assert.deepEqual(messages.find(item => item.images)?.images, [sourceImage]);
  const evidence = messages.find(item => item.content.includes("evidenceCallId"));
  assert.deepEqual(JSON.parse(evidence.content.split("\n")[2]), call);
  assert.equal(JSON.parse(evidence.content.split("\n")[1]).messageId, "source-tool-message");
  assert.equal(JSON.parse(evidence.content.split("\n")[1]).sequence, 2);
  assert.match(evidence.content, /not a current Core receipt/);
  assert(messages.every(item => !item.tool_calls && !item.tool_call_id && item.role !== "tool"),
    "Old tool evidence must not become a native invocation or tool-result message.");
  context.content = "changed caller copy"; call.result = "changed caller copy";
  assert.deepEqual(assembler.messages(), messages);
});

test("native source context refuses unsupported, uncertain and oversized references instead of dropping them or resolving live files", () => {
  const assemble = () => new OriginalApiChatContextAssembler(sourceBinding, true);
  assert.throws(() => assemble().attached({ context: [{ id: "live-only", label: "Live", path: "/not-read" }] }),
    /live-reference resolution is not authorized/);
  assert.throws(() => assemble().attached({ context: [], agentContext: { newAuthority: [] } }), /explicit native source assembler/);
  assert.throws(() => assemble().attached({ context: [], images: [sourceImage] }), /durable single-consumption/);
  const imageMessage = { id: "image-source", role: "user", content: "Retained image", status: "complete", images: [sourceImage] };
  assert.throws(() => new OriginalApiChatContextAssembler(sourceBinding, false).historical(imageMessage, 1), /none were omitted/);
  const toolMessage = { id: "tool-source", role: "assistant", content: "Old answer", status: "complete",
    toolCalls: [{ id: "old-tool", name: "write_document", arguments: "{}", status: "running" }] };
  assert.throws(() => assemble().historical(toolMessage, 1), /uncertain work is never replayed/);
  const terminal = { ...toolMessage.toolCalls[0], status: "failed" };
  assert.throws(() => assemble().historical({ ...toolMessage, toolCalls: [terminal, terminal] }, 1), /uniquely identified/);
  assert.throws(() => new OriginalApiChatContextAssembler(sourceBinding, true, 300).attached({
    context: [{ id: "large", label: "Pinned", content: "required-content".repeat(100) }],
  }), /nothing was pruned/);
  assert.throws(() => assemble().historical({ ...imageMessage, delegations: [{ status: "complete" }] }, 1), /dedicated source authority/);
});

test("native draft image input custody consumes once transactionally and restores only its exact owning transcript input", () => {
  const db = new DatabaseSync(":memory:"), source = {
    chatId: randomUUID(), sourcePlanSha256: sourceBinding.sourcePlanSha256, images: [sourceImage],
  };
  try {
    const store = createOriginalApiChatInputImageStore(db), requestId = "c".repeat(64), prompt = "Owning draft input";
    assert.throws(() => store.claim({ ...source, requestId, prompt }), /actual owned response-intent transaction/);
    db.exec("BEGIN IMMEDIATE");
    const claim = store.claim({ ...source, requestId, prompt });
    db.exec("COMMIT");
    assert.deepEqual(store.restore(claim, { id: `api-input:${requestId}`, role: "user", content: prompt }),
      { role: "user", content: prompt, images: [sourceImage] });
    const reopened = createOriginalApiChatInputImageStore(db);
    assert.equal(reopened.read(source).requestId, requestId);
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => reopened.claim({ ...source, requestId: "d".repeat(64), prompt: "Cannot reassign an old draft" }),
      /including uncertain work/);
    db.exec("ROLLBACK");
    assert.throws(() => reopened.restore(claim, { id: `api-input:${requestId}`, role: "user", content: "Other input" }),
      /transcript input no longer matches/);
    assert.throws(() => reopened.read({ ...source, sourcePlanSha256: "e".repeat(64) }), /source identity changed/);
    assert.throws(() => reopened.read({ ...source, images: [{ ...sourceImage, label: "Other image" }] }), /source identity changed/);
    assert.throws(() => db.prepare("UPDATE original_api_chat_input_images SET images_json='[]'").run(), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM original_api_chat_input_images").run(), /immutable/);
  } finally { db.close(); }
});

test("native draft input images roll back with an uncommitted response intent and refuse altered custody schema", () => {
  const db = new DatabaseSync(":memory:"), source = {
    chatId: randomUUID(), sourcePlanSha256: sourceBinding.sourcePlanSha256, images: [sourceImage],
  };
  try {
    const store = createOriginalApiChatInputImageStore(db);
    db.exec("BEGIN IMMEDIATE");
    store.claim({ ...source, requestId: "f".repeat(64), prompt: "Rolled-back input" });
    db.exec("ROLLBACK");
    assert.equal(store.read(source), undefined);
    db.exec("DROP TRIGGER original_api_chat_input_images_no_update");
    assert.throws(() => createOriginalApiChatInputImageStore(db), /immutability guards changed/);
  } finally { db.close(); }
});

test("canonical create survives native presentation failure as an uncertain retained receipt, never a replayable failed create", { timeout: 120_000 }, async t => {
  const f = await fixture(t, false, true), source = await planOriginalMcpApiChatSource(f.opened.storage, f.host,
    { stagingDirectory: f.stage, limits: bounds });
  await admitOriginalMcpApiChatSource(f.opened.storage, f.host, source, f.policy);
  const backend = createNativePublicOwnerBackend(f.opened.owner, {
    actor: { id: "mcp:external", canWrite: true }, originalMcpHost: f.host,
  });
  f.closes.push(() => backend.close()); f.failPresentation(true);
  const args = { host_id: f.opened.workspaceId, title: "Retained native create", command_id: "presentation-uncertain" };
  const receipt = await settled(backend, await invoke(backend, "api_chat_create", args));
  assert.equal(receipt.status, "outcome_unknown");
  assert(receipt.result.chatId);
  assert.match(receipt.next_action, /never automatically replay/);
  const { runtime } = await f.opened.owner.ensureFull();
  const core = await runtime.core.dispatch("capability_read", { operation: "chat.session.get", version: 1,
    arguments: { id: receipt.result.chatId } }, { id: "mcp:external", canWrite: true });
  assert.equal(core.result.title, args.title);
  assert.deepEqual(await invoke(backend, "api_chat_create", args), receipt);
  assert.equal(f.presented.length, 1);
  assert.equal(f.modelCalls(), 0);
});

test("explicitly selected current HTTP native model sends once through the actual Core; VS Code and hard-round fallback are never fabricated", { timeout: 120_000 }, async t => {
  const f = await fixture(t, false, true, "respond"), source = await planOriginalMcpApiChatSource(f.opened.storage, f.host,
    { stagingDirectory: f.stage, limits: bounds });
  await admitOriginalMcpApiChatSource(f.opened.storage, f.host, source, f.policy);
  const backend = createNativePublicOwnerBackend(f.opened.owner, { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: f.host });
  f.closes.push(() => backend.close());
  const created = await settled(backend, await invoke(backend, "api_chat_create",
    { host_id: f.opened.workspaceId, title: "Native explicit HTTP fixture", command_id: "native-create" }));
  assert.equal(created.status, "succeeded");
  const preceding = await appendNativeHistory(f, created.result.chatId);
  const args = { host_id: f.opened.workspaceId, chat_id: created.result.chatUrl, prompt: "Explicit fresh request", command_id: "native-send" };
  await assert.rejects(invoke(backend, "api_chat_send", { ...args, hard_tool_round_limit: 1000 }), /hard-round-limit protocol/);
  assert.equal(f.modelCalls(), 0);
  const sent = await settled(backend, await invoke(backend, "api_chat_send", args));
  assert.equal(sent.status, "succeeded", sent.error);
  assert.match(sent.result.reply.content, /Actual owned native response/);
  assert.equal(sent.result.reply.status, "complete");
  assert.equal(f.modelCalls(), 1);
  assert.deepEqual(await invoke(backend, "api_chat_send", args), sent);
  assert.equal(f.modelCalls(), 1, "Reading/reissuing the same command receipt never replays model work.");
  const { runtime } = await f.opened.owner.ensureFull();
  const history = await runtime.core.dispatch("capability_read", { operation: "chat.session.messages", version: 1,
    arguments: { id: created.result.chatId, afterSequence: preceding.length } }, { id: "mcp:external", canWrite: true });
  assert.equal(history.error, undefined);
  assert.deepEqual(history.result.items.map(({ role, content }) => ({ role, content })),
    [{ role: "user", content: args.prompt }, { role: "assistant", content: sent.result.reply.content }]);
  assert.deepEqual(f.modelPayloads[0].messages.filter(message => message.role !== "system"),
    [...preceding, { role: "user", content: args.prompt }]);
  await verifyNativePagingRefusals(t, f, backend, created.result.chatId, f.modelCalls);
  await t.test("bounded multi-page transcript retains its original complete-context budget refusal", async () => {
    await appendNativeHistory(f, created.result.chatId, 22);
    const denied = await settled(backend, await invoke(backend, "api_chat_send", {
      host_id: f.opened.workspaceId, chat_id: created.result.chatId, prompt: "No context pruning.",
      command_id: "native-bounded-history-budget" }));
    assert.equal(denied.status, "failed");
    assert.match(denied.error, /no retained messages were silently omitted/);
    assert.equal(f.modelCalls(), 1);
  });
  const archived = await settled(backend, await invoke(backend, "api_chat_send",
    { host_id: f.opened.workspaceId, chat_id: f.descriptor.inline, prompt: "Preserve exact archived context",
      command_id: "native-bounded-archive-denied" }));
  assert.equal(archived.status, "failed");
  assert.match(archived.error, /ORIGINAL_CHAT_CONTEXT_PROTOCOL_REQUIRED/);
  assert.equal(f.modelCalls(), 1, "The bounded transport never omits archived context to dispatch a model.");
});

test("cancel controls only this adapter's actual live Core response and preserves partial output", { timeout: 120_000 }, async t => {
  const f = await fixture(t, false, true, "wait"), source = await planOriginalMcpApiChatSource(f.opened.storage, f.host,
    { stagingDirectory: f.stage, limits: bounds });
  await admitOriginalMcpApiChatSource(f.opened.storage, f.host, source, f.policy);
  const backend = createNativePublicOwnerBackend(f.opened.owner, { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: f.host });
  f.closes.push(() => backend.close());
  const created = await settled(backend, await invoke(backend, "api_chat_create",
    { host_id: f.opened.workspaceId, title: "Native cancel fixture", command_id: "cancel-create" }));
  const send = await invoke(backend, "api_chat_send",
    { host_id: f.opened.workspaceId, chat_id: created.result.chatUrl, prompt: "Wait for explicit cancellation", command_id: "cancel-send" });
  for (let attempt = 0; attempt < 100 && f.modelCalls() === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.modelCalls(), 1);
  const cancelled = await settled(backend, await invoke(backend, "api_chat_cancel",
    { host_id: f.opened.workspaceId, chat_id: created.result.chatUrl, command_id: "cancel-owned-response" }));
  assert.equal(cancelled.status, "succeeded", cancelled.error);
  assert.equal(cancelled.result.cancellation.requested, true);
  const sent = await settled(backend, send);
  assert.equal(sent.result.reply.status, "cancelled");
  assert.match(sent.result.reply.content, /Actual owned native response/);
  const { runtime } = await f.opened.owner.ensureFull();
  const history = await runtime.core.dispatch("capability_read", { operation: "chat.session.messages", version: 1,
    arguments: { id: created.result.chatId } }, { id: "mcp:external", canWrite: true });
  assert.equal(history.error, undefined);
  assert.deepEqual(history.result.items.map(({ role, status }) => ({ role, status })),
    [{ role: "user", status: "complete" }, { role: "assistant", status: "cancelled" }]);
  assert.equal(history.result.items[1].content, sent.result.reply.content);
  assert.deepEqual(readFileSync(f.control), f.controlBefore);
});

test("a native VS Code selection never falls back to the configured HTTP model", { timeout: 120_000 }, async t => {
  const f = await fixture(t, false, true, "respond"), source = await planOriginalMcpApiChatSource(f.opened.storage, f.host,
    { stagingDirectory: f.stage, limits: bounds });
  await admitOriginalMcpApiChatSource(f.opened.storage, f.host, source, f.policy);
  const backend = createNativePublicOwnerBackend(f.opened.owner, { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: f.host });
  f.closes.push(() => backend.close());
  const created = await settled(backend, await invoke(backend, "api_chat_create",
    { host_id: f.opened.workspaceId, title: "Native selection fence", command_id: "selection-create" }));
  f.selectProvider("vscode");
  const attempted = await settled(backend, await invoke(backend, "api_chat_send",
    { host_id: f.opened.workspaceId, chat_id: created.result.chatUrl, prompt: "No HTTP fallback", command_id: "selection-send" }));
  assert.equal(attempted.status, "failed");
  assert.match(attempted.error, /NATIVE_VSCODE_MODEL_TRANSPORT_REQUIRED/);
  assert.equal(f.modelCalls(), 0);
});

test("native restart retains uncertain pending requests without reissuing them, with fresh source identity admission", { timeout: 120_000 }, async t => {
  const f = await fixture(t, false, true), source = await planOriginalMcpApiChatSource(f.opened.storage, f.host,
    { stagingDirectory: f.stage, limits: bounds });
  await admitOriginalMcpApiChatSource(f.opened.storage, f.host, source, f.policy);
  const backend = createNativePublicOwnerBackend(f.opened.owner, { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: f.host });
  f.closes.push(() => backend.close());
  f.blockCatalogue(true);
  const pending = await invoke(backend, "api_chat_models", { host_id: f.opened.workspaceId, command_id: "interrupted-native-catalogue" });
  await new Promise(resolve => setTimeout(resolve, 20));
  await backend.close(); await f.opened.owner.close();
  rmSync(f.stage, { recursive: true });
  assertColdNativeChatReopen(f.root);
  const opened = await openOriginalMcpRoot(f.plan); f.closes.push(() => opened.owner.close());
  const host = await f.prepareHost(opened.storage, randomUUID());
  await activateOriginalMcpApiChatSource(opened.storage, host, f.policy);
  const next = createNativePublicOwnerBackend(opened.owner, { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: host });
  f.closes.push(() => next.close());
  const retained = await invoke(next, "api_chat_request_get", { host_id: pending.host_id, request_id: pending.request_id });
  assert.equal(retained.status, "outcome_unknown");
  assert.match(retained.next_action, /never automatically replay/);
  assert.equal(f.modelCalls(), 0);
  assert.deepEqual(readFileSync(f.control), f.controlBefore);
});

test("managed old Task/worker identities remain readable historical data, not permission or queued execution authority", { timeout: 120_000 }, async t => {
  const f = await fixture(t, false, true, "respond", true), source = await planOriginalMcpApiChatSource(f.opened.storage, f.host,
    { stagingDirectory: f.stage, limits: bounds });
  await admitOriginalMcpApiChatSource(f.opened.storage, f.host, source, f.policy);
  const backend = createNativePublicOwnerBackend(f.opened.owner, { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: f.host });
  f.closes.push(() => backend.close());
  const read = await settled(backend, await invoke(backend, "api_chat_get",
    { host_id: f.opened.workspaceId, chat_id: f.descriptor.inline, command_id: "managed-history-only" }));
  assert.equal(read.status, "succeeded");
  assert.match(read.result.sessionId, /^agent_session_/);
  assert.equal(read.result.sessionAuthority, "archive_only");
  assert.notEqual(read.result.permissionMode, "allow-all");
  const denied = await settled(backend, await invoke(backend, "api_chat_send",
    { host_id: f.opened.workspaceId, chat_id: f.descriptor.inline, prompt: "Do not replay old work", command_id: "managed-source-denied" }));
  assert.equal(denied.status, "failed");
  assert.match(denied.error, /dedicated native protocol/);
  assert.equal(f.modelCalls(), 0);
});

test("native execution callback adapter commits actual Core inference/tool receipts beyond eight rounds and never replays", { timeout: 120_000 }, async t => {
  const f = await fixture(t, false, true, "respond"), source = await planOriginalMcpApiChatSource(f.opened.storage, f.host,
    { stagingDirectory: f.stage, limits: bounds });
  await admitOriginalMcpApiChatSource(f.opened.storage, f.host, source, f.policy);
  f.allowTools(true);
  let nativeRuns = 0;
  const port = { async run(plan, callbacks) {
    nativeRuns++;
    const receipts = [];
    for (let round = 0; round < 11; round++) {
      const inferenceId = originalNativeChatDigest({ requestId: plan.requestId, sourcePlanSha256: plan.sourcePlanSha256, round, receipts }),
        body = { inferenceId, round, planSha256: originalNativeChatDigest(plan),
        sourcePlanSha256: plan.sourcePlanSha256, selectionId: plan.selectionId,
        nativeRequest: { messages: [{ role: 1, content: [{ value: "request" }] }],
          options: { justification: "Allow fixture native Chat.", ...(round === 10 ? {} : {
            tools: plan.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
          }) } },
        inputTokens: 10, countingMethod: "vscode-countTokens-plus-overhead" };
      await callbacks.beforeInference({ ...body, requestSha256: originalNativeChatInferenceDigest(body) });
      if (round === 0) {
        const args = { id: "Entry" };
        const result = await callbacks.tool({ inferenceId, round, callId: "actual-native-read", name: "get_document",
          arguments: args, argumentsSha256: originalNativeChatDigest(args) });
        assert.match(result.receiptSha256, /^[a-f0-9]{64}$/);
        assert.equal(result.effect, "not-committed");
        assert.match(result.content, /Authoritative source fixture/);
        receipts.push(result.receiptSha256);
      }
      await callbacks.text({ inferenceId, text: `Round ${round}. ` });
      await callbacks.usage({ inferenceId, usage: { inputTokens: 10, outputTokens: 2 }, source: "native-counted" });
    }
    return { status: "complete", toolRoundLimit: { limit: 10, rounds: 10, reached: true } };
  } };
  const consumer = await createOriginalMcpNativeExecution(f.opened.owner, { id: "mcp:external", canWrite: true }, f.host, port);
  const plan = { schema: "pkm.original-api-chat-execution/v1", requestId: hash("native-callback-request"),
    chatUrl: `pkm://chats/${originalFixture.namespace}/${f.descriptor.inline}`, selectionId: "native-fixture-selection",
    sourcePlanSha256: source.planSha256, messages: [{ role: "user", content: "Fixture durable native request" }],
    tools: [], hardToolRoundLimit: 10, outputTokenCap: 128,
    budget: { maxInputTokens: 8192, maxTotalOutputTokens: 1024, deadlineMs: 120000 } };
  plan.tools = await consumer.modelTools(plan);
  const completed = await consumer.run(plan, "fixture-native-wire-id");
  assert.equal(completed.status, "complete");
  assert.match(completed.output, /Round 10/);
  assert.equal(nativeRuns, 1);
  assert.deepEqual(await consumer.run(plan, "fixture-native-wire-id"), completed);
  assert.equal(nativeRuns, 1);
  const db = f.opened.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM original_native_chat_inferences WHERE authorized=1").get().n, 11);
    assert.equal(db.prepare("SELECT count(*) AS n FROM original_native_chat_events WHERE type='tool-result'").get().n, 1);
    assert.throws(() => db.prepare("DELETE FROM original_native_chat_events").run(), /immutable/);
  } finally { db.close(); }
});

test("authenticated native execution lane drives original API hard-round callbacks through one actual Core", { timeout: 120_000 }, async t => {
  const f = await fixture(t, false, true, "respond", false, true, true);
  let wire, executions = 0, authorizeAllowed = true;
  const progress = [], observedPlans = [];
  const models = {
    async catalogue() { return { source: "vscode.lm", epoch: wire.activationId, models: [{
      id: "fixture-native-model", nativeModelId: "fixture-native-wire-id", label: "Socket native fixture", vendor: "fixture",
      family: "fixture", version: "fixture", maxInputTokens: 8192, maxOutputTokens: null, imageInput: true,
    }] }; },
    async select(input) { return { selectionId: randomUUID(), modelId: input.modelId,
      epoch: wire.activationId, maxInputTokens: 8192 }; },
    async count(input) { return { selectionId: input.selectionId, requestSha256: input.requestSha256,
      inputTokens: 10, countingMethod: "vscode-countTokens-plus-tool-overhead" }; },
    async *stream() { throw new Error("Full execution must not fall through one-inference/HTTP."); },
  };
  const execution = { async run(plan, callbacks) {
    executions++;
    observedPlans.push(structuredClone(plan));
    progress.push(`wire-plan:${originalNativeChatDigest(plan)}`);
    const receipts = [];
    for (let round = 0; round < 11; round++) {
      const inferenceId = originalNativeChatDigest({ requestId: plan.requestId, sourcePlanSha256: plan.sourcePlanSha256, round, receipts }),
        body = { inferenceId, round, planSha256: originalNativeChatDigest(plan),
        sourcePlanSha256: plan.sourcePlanSha256, selectionId: plan.selectionId,
        nativeRequest: { messages: [{ role: 1, content: [{ value: "request" }] }],
          options: { justification: "Allow fixture native Chat.", ...(round === 10 ? {} : {
            tools: plan.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
          }) } },
        inputTokens: 10, countingMethod: "vscode-countTokens-plus-overhead" };
      progress.push(`before:${round}`);
      await callbacks.beforeInference({ ...body, requestSha256: originalNativeChatInferenceDigest(body) });
      progress.push(`authorized:${round}`);
      if (round === 0) {
        const args = { id: "Entry" };
        const tool = await callbacks.tool({ inferenceId, round, callId: "socket-core-read", name: "get_document",
          arguments: args, argumentsSha256: originalNativeChatDigest(args) });
        assert.match(tool.content, /Authoritative source fixture/);
        assert.equal(tool.effect, "not-committed");
        progress.push("tool-complete");
        receipts.push(tool.receiptSha256);
      }
      await callbacks.text({ inferenceId, text: `Native round ${round}. ` });
      await callbacks.usage({ inferenceId, usage: { inputTokens: 10, outputTokens: 2 }, source: "native-counted" });
    }
    return { status: "complete", toolRoundLimit: { limit: 10, rounds: 10, reached: true } };
  } };
  const sessionCalls = [];
  const apiChat = {
    async resolve(request) {
      sessionCalls.push(["resolve", request]);
      return { protocol: "pkm.original-api-chat-execution/v1", epoch: wire.activationId,
        modelId: "fixture-native-model", wireModelId: "fixture-native-wire-id", provider: "vscode",
        permissionMode: "protective", outputTokenCap: 128,
        budget: { maxInputTokens: 8192, maxTotalOutputTokens: 2048, deadlineMs: 120000 } };
    },
    async authorize(request) { sessionCalls.push(["authorize", request]); return authorizeAllowed; },
    async present(request) { sessionCalls.push(["present", request]); },
  };
  wire = await createOriginalMcpNativeChatSessionFixture(t, { binding: {
    root: f.root, workspaceId: f.opened.workspaceId, planSha256: f.plan.planSha256,
    catalogSha256: originalPublicMcpContracts().provenance.metadataSha256, profileSha256: f.plan.profileSha256,
  }, models, execution, apiChat });
  f.fullNative(true); f.selectProvider("vscode"); f.allowTools(true);
  const host = await f.prepareHost(f.opened.storage, wire.activationId, wire.resource);
  const source = await planOriginalMcpApiChatSource(f.opened.storage, host, { stagingDirectory: f.stage, limits: bounds });
  await admitOriginalMcpApiChatSource(f.opened.storage, host, source, f.policy);
  const backend = createNativePublicOwnerBackend(f.opened.owner, { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: host });
  f.closes.push(() => backend.close());
  const created = await settled(backend, await invoke(backend, "api_chat_create",
    { host_id: f.opened.workspaceId, title: "Native socket execution", model_id: "fixture-native-model", command_id: "socket-create" }));
  assert.equal(created.status, "succeeded", created.error);
  const preceding = await appendNativeHistory(f, created.result.chatId);
  assert.equal(sessionCalls[0][0], "resolve");
  assert.equal(sessionCalls[0][1].chatUrl, null);
  assert.equal(sessionCalls[1][1].operation, "create");
  assert.equal(sessionCalls[2][0], "present");
  assert.equal(sessionCalls[2][1].chatUrl, created.result.chatUrl);
  const args = { host_id: f.opened.workspaceId, chat_id: created.result.chatUrl, prompt: "Fresh native socket request",
    command_id: "socket-native-execute", hard_tool_round_limit: 10 };
  const completed = await settled(backend, await invoke(backend, "api_chat_send", args));
  const diagnostics = f.opened.storage.connectNative();
  let trace;
  try {
    trace = diagnostics.prepare("SELECT name FROM sqlite_master WHERE name='original_native_chat_executions'").get()
      ? diagnostics.prepare("SELECT status,failure,round,plan_sha256 FROM original_native_chat_executions").all() : [];
  } finally { diagnostics.close(); }
  assert.equal(completed.status, "succeeded", JSON.stringify({ error: completed.error, executions, progress, trace }));
  assert.deepEqual(observedPlans[0].messages, [...preceding, { role: "user", content: args.prompt }]);
  assert.match(completed.result.reply.content, /Native round 10/);
  assert.equal(completed.result.reply.context.roundCount, 11);
  assert.equal(completed.result.reply.creditUsage.status, "not-reported");
  assert.equal(completed.result.reply.tools[0].name, "get_document");
  assert.deepEqual(await invoke(backend, "api_chat_send", args), completed);
  assert.equal(executions, 1);
  assert.equal(sessionCalls[3][0], "resolve");
  assert.equal(sessionCalls[3][1].chatUrl, created.result.chatUrl);
  assert.equal(sessionCalls[3][1].expectedSelection.provider, "vscode");
  assert.equal(sessionCalls[4][1].operation, "send");
  const cancelled = await settled(backend, await invoke(backend, "api_chat_cancel", {
    host_id: f.opened.workspaceId, chat_id: created.result.chatUrl, command_id: "socket-native-cancel",
  }));
  assert.equal(cancelled.status, "succeeded", cancelled.error);
  assert.equal(sessionCalls.at(-1)[0], "authorize");
  assert.equal(sessionCalls.at(-1)[1].operation, "cancel");
  assert.equal(sessionCalls.at(-1)[1].selection, null);
  const sourceContinuation = await settled(backend, await invoke(backend, "api_chat_send", {
    host_id: f.opened.workspaceId, chat_id: f.descriptor.inline, prompt: "Continue admitted inline references without old tools.",
    command_id: "socket-retained-context", hard_tool_round_limit: 10,
  }));
  assert.equal(sourceContinuation.status, "succeeded", sourceContinuation.error);
  assert.equal(executions, 2);
  const plan = observedPlans[1], text = plan.messages.map(item => item.content).join("\n");
  assert.match(text, /Exact retained inline Note context/);
  assert.match(text, /Historical memory, not a fresh grant/);
  assert.match(text, /Historical Skill reference only/);
  assert.match(text, /file:\/\/\/not-opened\/retained.md/);
  assert.match(text, /retained-tool-call/);
  assert.match(text, /not a current Core receipt/);
  assert.deepEqual(plan.messages.find(item => item.images).images, [sourceImage].map(image => ({ ...image, label: "synthetic-pixel.png" })));
  assert(plan.messages.every(item => !item.tool_calls && !item.tool_call_id));
  assert.deepEqual(plan.tools.map(tool => tool.name), ["get_document"],
    "Historical write evidence never enables or invokes an old tool.");
  const draft = { ...sourceImage, label: "retained-draft.png" };
  assert.deepEqual(plan.messages.at(-1).images, [draft], "The admitted draft belongs to this fresh user input once.");
  const continuedHistory = await appendNativeHistory(f, f.descriptor.inline);
  const followupArgs = { host_id: f.opened.workspaceId, chat_id: f.descriptor.inline, prompt: "Follow up without reconsuming draft.",
    command_id: "socket-draft-followup", hard_tool_round_limit: 10 };
  const followup = await settled(backend, await invoke(backend, "api_chat_send", followupArgs));
  assert.equal(followup.status, "succeeded", followup.error);
  assert.equal(executions, 3);
  assert.equal(observedPlans.at(-1).messages.at(-1).images, undefined);
  assert.deepEqual(observedPlans.at(-1).messages.find(item =>
    item.content === "Continue admitted inline references without old tools.").images, [draft],
  "Native history restores the image-bearing input, not a new draft consumption.");
  assert.deepEqual(observedPlans.at(-1).messages.slice(-continuedHistory.length - 1, -1), continuedHistory);
  const imageDb = f.opened.storage.connectNative();
  const oldEpoch = wire.activationId;
  try {
    const image = imageDb.prepare("SELECT * FROM original_api_chat_input_images WHERE chat_id=?").get(f.descriptor.inline);
    assert.equal(image.request_id, sourceContinuation.request_id);
    assert.equal(image.message_id, `api-input:${sourceContinuation.request_id}`);
    assert.equal(imageDb.prepare("SELECT count(*) AS n FROM original_api_chat_input_images").get().n, 1);
    assert.equal(JSON.parse(imageDb.prepare("SELECT model_selection FROM original_api_chat_current_chats WHERE id=?")
      .get(f.descriptor.inline).model_selection).epoch, oldEpoch);
  } finally { imageDb.close(); }
  await verifyNativePagingRefusals(t, f, backend, created.result.chatId, () => executions);
  await backend.close(); await f.opened.owner.close(); await wire.close();
  assertColdNativeChatReopen(f.root);
  wire = await createOriginalMcpNativeChatSessionFixture(t, { binding: {
    root: f.root, workspaceId: f.opened.workspaceId, planSha256: f.plan.planSha256,
    catalogSha256: originalPublicMcpContracts().provenance.metadataSha256, profileSha256: f.plan.profileSha256,
  }, models, execution, apiChat });
  let restartedHost;
  const reopened = await openOriginalMcpRoot(f.plan, { prepareNative: async storage => {
    restartedHost = await f.prepareHost(storage, wire.activationId, wire.resource); return restartedHost.options;
  } });
  f.closes.push(() => reopened.owner.close());
  await reopened.owner.ensureFull();
  await activateOriginalMcpApiChatSource(reopened.storage, restartedHost, f.policy);
  const restarted = createNativePublicOwnerBackend(reopened.owner, {
    actor: { id: "mcp:external", canWrite: true }, originalMcpHost: restartedHost,
  });
  f.closes.push(() => restarted.close()); authorizeAllowed = false;
  const restartArgs = { host_id: reopened.workspaceId, chat_id: f.descriptor.inline,
    prompt: "Fresh epoch requires fresh consent.", command_id: "socket-restart-denied", hard_tool_round_limit: 10 };
  const denied = await settled(restarted, await invoke(restarted, "api_chat_send", restartArgs));
  assert.equal(denied.status, "failed");
  assert.equal(executions, 3, "An old selection/image record is not fresh model authorization.");
  assert.notEqual(wire.activationId, oldEpoch);
  assert.equal(sessionCalls.findLast(item => item[0] === "resolve")[1].expectedSelection.epoch, wire.activationId);
  authorizeAllowed = true;
  const resumed = await settled(restarted, await invoke(restarted, "api_chat_send",
    { ...restartArgs, command_id: "socket-restart-approved" }));
  assert.equal(resumed.status, "succeeded", resumed.error);
  assert.equal(executions, 4);
  assert.deepEqual(observedPlans.at(-1).messages.find(item =>
    item.content === "Continue admitted inline references without old tools.").images, [draft]);
  assert.equal(observedPlans.at(-1).messages.at(-1).images, undefined);
  assert.deepEqual(await invoke(restarted, "api_chat_send", followupArgs), followup);
  assert.equal(executions, 4, "Polling or reissuing an old command never replays its inference or draft consumption.");
  const restoredDb = reopened.storage.connectNative();
  try {
    assert.equal(restoredDb.prepare("SELECT request_id FROM original_api_chat_input_images WHERE chat_id=?")
      .get(f.descriptor.inline).request_id, sourceContinuation.request_id);
    assert.equal(JSON.parse(restoredDb.prepare("SELECT model_selection FROM original_api_chat_current_chats WHERE id=?")
      .get(f.descriptor.inline).model_selection).epoch, wire.activationId);
  } finally { restoredDb.close(); }
  assert.equal(f.modelCalls(), 0, "A genuine native lane never falls back to the configured HTTP model.");
  assert.deepEqual(readFileSync(f.control), f.controlBefore);
});
