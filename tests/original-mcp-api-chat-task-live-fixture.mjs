import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquireOriginalMcpRootFence, captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { bootstrapOriginalMcpNativeRuntime } from "../dist/original-mcp-native-bootstrap.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { createOriginalMcpNativeRequestPolicy, originalMcpNativeRequestProtocol, originalMcpNativeRequestSession,
  parseOriginalMcpNativeRequest, originalMcpNativeResult, waitForOriginalMcpNativeSupport } from "../dist/original-mcp-native-request.js";
import { createOriginalMcpNativeSourcePolicies } from "../dist/original-mcp-native-source-policy.js";
import { planOriginalMcpApiChatSource, admitOriginalMcpApiChatSource } from "../dist/original-mcp-api-chat-source.js";
import { createOriginalMcpApiChatRuntime } from "../dist/original-mcp-api-chat.js";
import { originalNativeChatDigest, originalNativeChatInferenceDigest } from "../dist/original-mcp-api-chat-contracts.js";
import { originalMcpNativeChatSupportedMethods } from "../dist/original-mcp-native-chat-rpc.js";
import { createOriginalMcpNativeChatSessionFixture } from "./fixtures/original-mcp-native-chat-session.mjs";

/** Actual crypto socket/Core with explicitly synthetic fixed model/UI decisions, NOT an installed/native-provider qualification. */
export async function originalApiTaskLiveFixture(t, options = {}) {
  const directory = resolve(".pkm-test-evidence", `api-task-live-${randomUUID()}`), root = join(directory, "root"), closes = [];
  const mask = process.umask(0o077);
  t.after(async () => {
    try { for (const close of closes.reverse()) await close(); }
    finally { process.umask(mask); await rm(directory, { recursive: true, force: true }); }
  });
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".pkm"), { mode: 0o700 });
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nCanonical Task API fixture evidence.\n", { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const custody = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "native-task-api-composition-fixture", profileSha256: "a".repeat(64),
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 1_048_576 } });
  let opened = await openOriginalMcpRoot(custody);
  const initialOwner = opened.owner; closes.push(() => initialOwner.close());
  if (options.defaultPolicy) await initialOwner.close();
  const actor = { id: "mcp:external", canWrite: true }, highLevel = [];
  let wire, allow = true, taskRun, modelReview;
  const model = { id: "task-api-fixture", nativeModelId: "task-api-fixture-wire", label: "Deterministic Task API test fixture",
    vendor: "fixture", family: "fixture", version: "1", maxInputTokens: 16384, maxOutputTokens: 128, imageInput: false, toolCalling: true };
  const selection = () => ({ protocol: "pkm.original-api-chat-execution/v1", epoch: wire.activationId, modelId: model.id,
    wireModelId: model.nativeModelId, provider: "vscode", permissionMode: "protective", outputTokenCap: 128,
    budget: { maxInputTokens: 16384, maxTotalOutputTokens: 2048, deadlineMs: 120000 } });
  const execution = {
    async run() { throw new Error("Managed Task must not use the ordinary execution lane."); },
    managedTask: { async run(...args) { assert(taskRun, "Select an explicit deterministic fixture plan."); return taskRun(...args); } },
  };
  const nativeMethods = ["admission.approve", "public.approve", "model.approve", "tool.approve",
    ...(options.reviewSupport === false ? [] : ["tool.review"]), "credential.present", "chat.source.approve",
    ...(options.portalSource ? ["portal.local.approve"] : [])];
  const nativeRequests = [];
  const nativeRequest = async (request, signal) => {
    nativeRequests.push(request);
    if (request.method === "portal.local.approve" && options.portalSource)
      return options.portalSource.handle(request, signal);
    if (request.method === "model.approve") await modelReview?.(request.payload);
    return request.method === "credential.present" ? { present: false }
      : request.method === "chat.source.approve" ? { actorId: actor.id, decisionId: randomUUID(), expiresAtMs: Date.now() + 300000 }
        : request.method === "tool.review" ? { actorId: actor.id, decisionId: randomUUID(), decision: "approve" } : { decision: "approve" };
  };
  wire = await createOriginalMcpNativeChatSessionFixture(t, {
    ...(options.defaultPolicy ? { nativeMethods, nativeRequest, bootstrap: async ({ directory, identity, binding }) =>
      bootstrapOriginalMcpNativeRuntime({ plan: custody, writerFence: await acquireOriginalMcpRootFence(root),
        attachment: { directory, identity, identitySha256: identity.sha256,
          payloadBuildId: binding.payloadBuildId, hostEntrySha256: binding.hostEntrySha256 } }) } : {}),
    binding: { root, workspaceId: opened.workspaceId, planSha256: custody.planSha256, profileSha256: custody.profileSha256,
      catalogSha256: originalPublicMcpContracts().provenance.metadataSha256 },
    models: {
      async catalogue() { return { source: "vscode.lm", epoch: wire.activationId, models: [model] }; },
      async select(input) { return { selectionId: randomUUID(), modelId: input.modelId, epoch: wire.activationId, maxInputTokens: model.maxInputTokens }; },
      async count(input) { return { selectionId: input.selectionId, requestSha256: input.requestSha256, inputTokens: 10,
        countingMethod: "vscode-countTokens-plus-tool-overhead" }; },
      async *stream() { throw new Error("No bounded/HTTP fallback is allowed."); },
    }, execution,
    apiChat: {
      async resolve(request) { highLevel.push(["resolve", structuredClone(request)]); return selection(); },
      async authorize(request) { highLevel.push(["authorize", structuredClone(request)]); return request.operation !== "send" || allow; },
      async present(request) { highLevel.push(["present", structuredClone(request)]); },
    },
  });
  closes.push(() => wire.close());
  assert(originalMcpNativeChatSupportedMethods(wire.session).some(method => method === "execution.task.run"),
    "Mandatory shared execution.task.run producer/resource/callback route is missing. This fixture must not qualify a plain execution callback.");
  const session = originalMcpNativeRequestSession(wire.session);
  let buffer = "";
  if (!options.defaultPolicy) wire.socket.on("data", chunk => {
    buffer += chunk.toString("utf8");
    for (let end; (end = buffer.indexOf("\n")) !== -1;) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (frame.type !== "native-request") continue;
      const request = parseOriginalMcpNativeRequest(frame, session);
      void (async () => {
        const result = await nativeRequest(request, wire.resource.signal);
        wire.socket.write(JSON.stringify(originalMcpNativeResult(request, result)) + "\n");
      })().catch(error => { console.error(error); wire.socket.destroy(); });
    }
  });
  if (!options.defaultPolicy) wire.socket.write(JSON.stringify({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session,
    methods: nativeMethods,
    maxPacketBytes: 16384 }) + "\n");
  await waitForOriginalMcpNativeSupport(wire.session, { timeoutMs: 2000 });
  if (options.defaultPolicy) opened = wire.bootstrap;
  const host = wire.host ?? await createOriginalMcpNativeHost(opened.storage, createOriginalMcpNativeRequestPolicy(wire.session, {
    toolCatalog: [
      { name: "get_document", operation: "knowledge.document.get", approvalRequired: true },
      { name: "spawn_workers", operation: "agent.runtime.spawn", approvalRequired: true },
      { name: "start_recipe", operation: "project.recipe.run.start", approvalRequired: true },
      { name: "dispatch_any", operation: "mcp.tool.capability_call", approvalRequired: true },
      ...(options.tools ?? []),
    ],
  }), { nativeChat: wire.resource });
  const policies = createOriginalMcpNativeSourcePolicies(opened.storage, host, wire.session), stage = join(directory, "stage");
  await mkdir(stage, { mode: 0o700 });
  const source = await planOriginalMcpApiChatSource(opened.storage, host,
    { stagingDirectory: stage, limits: { maxChats: 100, maxMessagesPerChat: 1000, maxMessages: 4000 } });
  await admitOriginalMcpApiChatSource(opened.storage, host, source, policies.chat);
  const api = await createOriginalMcpApiChatRuntime(opened.owner, actor, host);
  closes.push(() => api.close());
  const call = async (tool, args) => (await api.invoke(tool, args)).structuredContent;
  const receipt = async requestId => {
    for (let count = 0; count < 500; count++) {
      const value = await call("api_chat_request_get", { host_id: opened.workspaceId, request_id: requestId });
      if (!["queued", "running"].includes(value.status)) return value;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Task API receipt did not settle.");
  };
  const create = await call("api_chat_create", { host_id: opened.workspaceId, title: "Native Task API fixture",
    model_id: model.id, command_id: "native-task-api-create" });
  const created = await receipt(create.request_id); assert.equal(created.status, "succeeded", created.error);
  const infer = async (plan, ports, round, receipts, tools = plan.tools) => {
    const body = { inferenceId: originalNativeChatDigest({ requestId: plan.requestId, sourcePlanSha256: plan.sourcePlanSha256, round, receipts }),
      round, planSha256: originalNativeChatDigest(plan), sourcePlanSha256: plan.sourcePlanSha256, selectionId: plan.selectionId,
      nativeRequest: { messages: plan.messages, options: { ...(tools.length ? {
        tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
      } : {}) } }, inputTokens: 10, countingMethod: "vscode-countTokens-plus-overhead" };
    await ports.beforeInference({ ...body, requestSha256: originalNativeChatInferenceDigest(body) });
    return body.inferenceId;
  };
  const context = (plan, ports, inferenceId, round, phase, hasToolCalls, finalSummary = false) => ports.taskContext({
    phase, inferenceId, round, planSha256: originalNativeChatDigest(plan), bindingSha256: plan.managedTask.bindingSha256,
    sourcePlanSha256: plan.sourcePlanSha256, hasToolCalls, finalSummary,
  });
  return { ...opened, actor, host, wire, api, policies, source, call, receipt, created: created.result, highLevel, infer, context, nativeRequests,
    retain(close) { closes.push(close); },
    allow(value) { allow = value; }, run(value) { taskRun = value; }, onModelReview(value) { modelReview = value; } };
}
