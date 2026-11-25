import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { createOriginalMcpNativeRequestPolicy, originalMcpNativeRequestProtocol,
  originalMcpNativeRequestSession, parseOriginalMcpNativeRequest, originalMcpNativeResult,
  waitForOriginalMcpNativeSupport } from "../dist/original-mcp-native-request.js";
import { createOriginalMcpNativeSourcePolicies } from "../dist/original-mcp-native-source-policy.js";
import { planOriginalMcpApiChatSource, admitOriginalMcpApiChatSource } from "../dist/original-mcp-api-chat-source.js";
import { createOriginalMcpApiChatRuntime } from "../dist/original-mcp-api-chat.js";
import { createNativeManagedChatTasks } from "../dist/managed-chat-task-native.js";
import { originalNativeChatDigest, originalNativeChatInferenceDigest } from "../dist/original-mcp-api-chat-contracts.js";
import { createOriginalMcpNativeChatSessionFixture } from "./fixtures/original-mcp-native-chat-session.mjs";

/** Actual crypto socket + RootOwner/Core; Native UI/model decisions are labelled deterministic fixture doubles. */
export async function managedTaskFixture(t) {
  const directory = resolve(".pkm-test-evidence", `canonical-task-${randomUUID()}`), root = join(directory, "root");
  const oldMask = process.umask(0o077), closes = [];
  t.after(async () => {
    try { for (const close of closes.reverse()) await close(); }
    finally { process.umask(oldMask); await rm(directory, { recursive: true, force: true }); }
  });
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".pkm"), { mode: 0o700 });
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nReal canonical Task evidence fixture.\n", { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "canonical-task-foundation-fixture", profileSha256: "a".repeat(64),
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 1_048_576 } });
  const opened = await openOriginalMcpRoot(plan); closes.push(() => opened.owner.close());
  const actor = { id: "mcp:external", canWrite: true }, nativeRequests = [], highLevelRequests = [];
  let wire, allowTask = true, taskApproval, modelApproval, toolApproval, run;
  const metadata = { id: "fixture-native-model", nativeModelId: "fixture-native-wire-id", label: "Canonical Task model fixture",
    vendor: "fixture", family: "fixture", version: "1", maxInputTokens: 8192, maxOutputTokens: 128, imageInput: false };
  const selection = () => ({ protocol: "pkm.original-api-chat-execution/v1", epoch: wire.activationId,
    modelId: metadata.id, wireModelId: metadata.nativeModelId, provider: "vscode", permissionMode: "protective",
    outputTokenCap: 128, budget: { maxInputTokens: 8192, maxTotalOutputTokens: 2048, deadlineMs: 120000 } });
  wire = await createOriginalMcpNativeChatSessionFixture(t, {
    binding: { root, workspaceId: opened.workspaceId, planSha256: plan.planSha256, profileSha256: plan.profileSha256,
      catalogSha256: originalPublicMcpContracts().provenance.metadataSha256 },
    models: {
      async catalogue() { return { source: "vscode.lm", epoch: wire.activationId, models: [metadata] }; },
      async select(input) { return { selectionId: randomUUID(), modelId: input.modelId, epoch: wire.activationId, maxInputTokens: 8192 }; },
      async count(input) { return { selectionId: input.selectionId, requestSha256: input.requestSha256,
        inputTokens: 10, countingMethod: "vscode-countTokens-plus-tool-overhead" }; },
      async *stream() { throw new Error("Task requests must not use a bounded/HTTP fallback."); },
    },
    execution: { async run(...args) { assert(run, "Choose an explicit fixture execution."); return run(...args); } },
    apiChat: {
      async resolve(request) { highLevelRequests.push(["resolve", structuredClone(request)]); return selection(); },
      async authorize(request) {
        highLevelRequests.push(["authorize", structuredClone(request)]);
        if (request.operation === "send") { if (taskApproval) await taskApproval(request); return allowTask; }
        return request.operation === "create";
      },
      async present(request) { highLevelRequests.push(["present", structuredClone(request)]); },
    },
  });
  closes.push(() => wire.close());
  const session = originalMcpNativeRequestSession(wire.session);
  let buffered = "";
  wire.socket.on("data", chunk => {
    buffered += chunk.toString("utf8");
    for (let end; (end = buffered.indexOf("\n")) !== -1;) {
      const frame = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
      if (frame.type !== "native-request") continue;
      const request = parseOriginalMcpNativeRequest(frame, session);
      nativeRequests.push(request);
      void (async () => {
        let result;
        if (request.method === "credential.present") result = { present: false };
        else if (request.method === "chat.source.approve") {
          assert.equal(request.payload.noExecution, true);
          result = { actorId: "mcp:external", decisionId: randomUUID(), expiresAtMs: Date.now() + 300000 };
        } else if (request.method === "tool.review") result = { actorId: "mcp:external", decisionId: randomUUID(), decision: "approve" };
        else {
          if (request.method === "model.approve" && modelApproval) await modelApproval(request.payload);
          if (request.method === "tool.approve" && toolApproval) await toolApproval(request.payload);
          result = { decision: "approve" };
        }
        wire.socket.write(JSON.stringify(originalMcpNativeResult(request, result)) + "\n");
      })().catch(error => { console.error(error); wire.socket.destroy(); });
    }
  });
  wire.socket.write(JSON.stringify({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session,
    methods: ["admission.approve", "public.approve", "model.approve", "tool.approve", "tool.review", "credential.present", "chat.source.approve"],
    maxPacketBytes: 16384 }) + "\n");
  await waitForOriginalMcpNativeSupport(wire.session, { timeoutMs: 2000 });
  const host = await createOriginalMcpNativeHost(opened.storage, createOriginalMcpNativeRequestPolicy(wire.session, {
    toolCatalog: [
      { name: "get_document", operation: "knowledge.document.get", approvalRequired: true },
      { name: "session_info", operation: "chat.task.get", approvalRequired: true },
      { name: "report_work", operation: "chat.task.report_work", approvalRequired: true },
      { name: "record_harness", operation: "chat.task.record_harness", approvalRequired: true },
    ],
  }), { nativeChat: wire.resource });
  const policies = createOriginalMcpNativeSourcePolicies(opened.storage, host, wire.session);
  const stage = join(directory, "source-stage"); await mkdir(stage, { mode: 0o700 });
  const source = await planOriginalMcpApiChatSource(opened.storage, host,
    { stagingDirectory: stage, limits: { maxChats: 100, maxMessagesPerChat: 1000, maxMessages: 4000 } });
  await admitOriginalMcpApiChatSource(opened.storage, host, source, policies.chat);
  const api = await createOriginalMcpApiChatRuntime(opened.owner, actor, host);
  closes.push(() => api.close());
  const callApi = async (tool, args) => {
    const result = await api.invoke(tool, args);
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  };
  const pending = await callApi("api_chat_create", { host_id: opened.workspaceId, title: "Fresh native canonical Task fixture",
    model_id: metadata.id, command_id: "canonical-task-chat-create" });
  let created;
  for (let attempt = 0; attempt < 200; attempt++) {
    const receipt = await callApi("api_chat_request_get", { host_id: opened.workspaceId, request_id: pending.request_id });
    if (!["queued", "running"].includes(receipt.status)) { assert.equal(receipt.status, "succeeded", receipt.error); created = receipt.result; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(created);
  const { runtime } = await opened.owner.ensureFull();
  const core = async (operation, args, identity = actor) => runtime.core.dispatch(
    ["chat.session.get", "chat.session.messages", "chat.task.get"].includes(operation) ? "capability_read" : "capability_call",
    { operation, version: 1, arguments: args }, identity);
  const foundation = await createNativeManagedChatTasks(opened.owner, host, actor);
  const preparation = (patch = {}) => ({ chatId: created.chatId, expectedChatRevision: 1, operationId: randomUUID(),
    commandId: `task-${randomUUID()}`, prompt: "Start a new task: verify the exact canonical Note and preserve acceptance.",
    hardToolRoundLimit: 6, ...patch });
  const inference = async (plan, ports, round, receipts, tools = plan.tools) => {
    const body = { inferenceId: originalNativeChatDigest({ requestId: plan.requestId,
      sourcePlanSha256: plan.sourcePlanSha256, round, receipts }), round,
      planSha256: originalNativeChatDigest(plan), sourcePlanSha256: plan.sourcePlanSha256, selectionId: plan.selectionId,
      nativeRequest: { messages: plan.messages, options: { ...(tools.length ? {
        tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
      } : {}) } }, inputTokens: 10, countingMethod: "vscode-countTokens-plus-overhead" };
    await ports.beforeInference({ ...body, requestSha256: originalNativeChatInferenceDigest(body) });
    return body.inferenceId;
  };
  return { ...opened, actor, host, policies, wire, source, api, foundation, created, runtime, core, preparation,
    selection, nativeRequests, highLevelRequests, inference,
    denyTask(value) { allowTask = !value; }, onTaskApproval(value) { taskApproval = value; },
    onModelApproval(value) { modelApproval = value; }, onToolApproval(value) { toolApproval = value; },
    modelRun(value) { run = value; } };
}
