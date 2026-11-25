import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { createOriginalMcpApiChatRuntime } from "../dist/original-mcp-api-chat.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { createOriginalMcpNativeRequestPolicy, originalMcpNativeRequestProtocol, originalMcpNativeRequestSession,
  parseOriginalMcpNativeRequest, originalMcpNativeResult, waitForOriginalMcpNativeSupport } from "../dist/original-mcp-native-request.js";
import { createOriginalMcpNativeSourcePolicies } from "../dist/original-mcp-native-source-policy.js";
import { planOriginalMcpApiChatSource, admitOriginalMcpApiChatSource } from "../dist/original-mcp-api-chat-source.js";
import { readOriginalManagedTaskAdoptionSource } from "../dist/managed-chat-task-adoption-source-native.js";
import { assertOriginalManagedTaskAdoptionSource } from "../dist/managed-chat-task-adoption-source.js";
import { resumeReviewedOriginalManagedGoal } from "../dist/managed-chat-task-adoption-goal.js";
import { createNativeManagedChatTasks } from "../dist/managed-chat-task-native.js";
import { originalNativeChatDigest, originalNativeChatInferenceDigest } from "../dist/original-mcp-api-chat-contracts.js";
import { createOriginalMcpNativeChatSessionFixture } from "./fixtures/original-mcp-native-chat-session.mjs";

const archive = process.env.PKM_LEGACY_VSIX, require = createRequire(import.meta.url);
const options = { timeout: 120000, skip: archive ? false : "Requires the actual SHA-pinned original VSIX." };
async function fixture(t, { adoption = false } = {}) {
  const hash = createHash("sha256"); for await (const bytes of createReadStream(archive)) hash.update(bytes);
  assert.equal(hash.digest("hex"), "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  const directory = resolve(".pkm-test-evidence", `archived-task-adoption-${randomUUID()}`), root = join(directory, "root"), closes = [];
  const mask = process.umask(0o077);
  t.after(async () => {
    try { for (const close of closes.reverse()) await close(); }
    finally { process.umask(mask); await rm(directory, { recursive: true, force: true }); }
  });
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 }); await mkdir(join(root, ".pkm"), { mode: 0o700 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nPinned original Task adoption fixture.\n", { mode: 0o600 });
  const oracle = join(directory, "oracle"); await mkdir(oracle, { mode: 0o700 });
  execFileSync("unzip", ["-q", archive, "extension/dist/*", "extension/resources/*", "extension/node_modules/*", "extension/package.json", "-d", oracle],
    { stdio: "pipe", timeout: 60000 });
  const base = join(oracle, "extension/dist/chat"), { ApiChatStore } = require(join(base, "api-chat-store.js"));
  const original = require(join(base, "chat-work-goal.js")), store = new ApiChatStore(join(root, ".pkm/state"), "0123456789abcdef");
  const chat = store.create(); store.startTask(chat, "Actual original managed Task");
  const inputId = randomUUID(), replyId = randomUUID(), prompt = "Start a new task: inspect the original Note without inventing authority.";
  chat.messages.push({ id: inputId, taskId: chat.sessionId, role: "user", content: prompt, status: "complete" });
  original.prepareWorkGoal(chat, inputId, prompt, "a".repeat(64));
  const reply = { id: replyId, inputId, taskId: chat.sessionId, role: "assistant", content: "Historical agent claim only.",
    status: "complete", toolCalls: [{ id: "original-read", name: "get_document", arguments: '{"id":"Entry"}',
      status: "complete", result: "An original historical read, never a current receipt." }] };
  chat.messages.push(reply);
  original.reportWork(chat, reply, { status: "resolved", reason: "Historical agent report.", sourceInputIds: [inputId],
    acceptance: [{ criterion: original.rootWorkCriterion, verified: true, evidenceCallIds: ["original-read"] }] });
  chat.permissionMode = "ask"; chat.modelProvider = "openai-compatible"; chat.modelProfileId = "historical-model-is-not-current";
  store.save(chat);
  const metadataPath = join(root, `.pkm/state/api-chats/0123456789abcdef/${chat.id}.json`);
  const sessionPath = join(root, `.pkm/state/agent-sessions/${chat.sessionId}.json`);
  const originalBytes = { metadata: await readFile(metadataPath), session: await readFile(sessionPath) };
  const custody = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"), operatorId: "actual-original-task-adoption-test",
    profileSha256: "b".repeat(64), limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16777216, maxFileBytes: 1048576 } });
  const opened = await openOriginalMcpRoot(custody); closes.push(() => opened.owner.close());
  const calls = [], actor = { id: "mcp:external", canWrite: true };
  const unavailable = () => { calls.push("model"); throw new Error("Unadopted original Tasks cannot reach a model."); };
  let wire, execute, review, allowAdoption = true;
  const model = { id: "vscode:adoption-fixture:model", nativeModelId: "adoption-fixture-model", label: "Explicit deterministic adoption fixture",
    vendor: "fixture", family: "unit", version: "1", maxInputTokens: 200000, maxOutputTokens: 8192 };
  const selection = () => ({ protocol: "pkm.original-api-chat-execution/v1", epoch: wire.activationId, modelId: model.id,
    wireModelId: model.nativeModelId, provider: "vscode", permissionMode: "protective", outputTokenCap: 8192,
    budget: { maxInputTokens: 200000, maxTotalOutputTokens: 32768, deadlineMs: 120000 } });
  wire = await createOriginalMcpNativeChatSessionFixture(t, {
    binding: { root, workspaceId: opened.workspaceId, planSha256: custody.planSha256, profileSha256: custody.profileSha256,
      catalogSha256: originalPublicMcpContracts().provenance.metadataSha256 },
    models: adoption ? {
      async catalogue() { return { source: "vscode.lm", epoch: wire.activationId, models: [model] }; },
      async select(input) { return { selectionId: randomUUID(), modelId: input.modelId, epoch: wire.activationId, maxInputTokens: 200000 }; },
      count: unavailable, async *stream() { unavailable(); },
    } : { catalogue: unavailable, select: unavailable, count: unavailable, async *stream() { unavailable(); } },
    execution: { run: unavailable, ...(adoption ? { managedTask: { async run(...args) {
      calls.push(["execution", args[0].requestId]); assert(execute); return execute(...args);
    } } } : {}) },
    apiChat: { resolve: adoption ? async input => { calls.push(["resolve", input]); return selection(); } : unavailable,
      authorize: adoption ? async input => { calls.push(["authorize", input]); return true; } : unavailable,
      ...(adoption ? { async adopt(input) {
        calls.push(["adopt", input]); await review?.(input);
        return { decision: allowAdoption ? "adopt-and-revalidate" : "deny", actorId: actor.id, decisionId: randomUUID(),
          expiresAtMs: Date.now() + 300000, requestId: input.requestId, epoch: wire.activationId,
          bindingSha256: originalNativeChatDigest(input) };
      } } : {}), present: unavailable },
  });
  closes.push(() => wire.close());
  const session = originalMcpNativeRequestSession(wire.session); let buffer = "";
  wire.socket.on("data", chunk => {
    buffer += chunk.toString("utf8");
    for (let end; (end = buffer.indexOf("\n")) !== -1;) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (frame.type !== "native-request") continue;
      const request = parseOriginalMcpNativeRequest(frame, session);
      const result = request.method === "chat.source.approve" ? { actorId: actor.id, decisionId: randomUUID(), expiresAtMs: Date.now() + 300000 }
        : request.method === "tool.review" ? { actorId: actor.id, decisionId: randomUUID(), decision: "approve" }
          : request.method === "credential.present" ? { present: false } : { decision: "approve" };
      wire.socket.write(JSON.stringify(originalMcpNativeResult(request, result)) + "\n");
    }
  });
  wire.socket.write(JSON.stringify({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session,
    methods: ["admission.approve", "public.approve", "model.approve", "tool.approve", "tool.review", "credential.present", "chat.source.approve"],
    maxPacketBytes: 16384 }) + "\n");
  await waitForOriginalMcpNativeSupport(wire.session, { timeoutMs: 2000 });
  const host = await createOriginalMcpNativeHost(opened.storage, createOriginalMcpNativeRequestPolicy(wire.session,
    adoption ? { toolCatalog: [{ name: "get_document", operation: "knowledge.document.get", approvalRequired: true }] } : {}),
  { nativeChat: wire.resource });
  const policies = createOriginalMcpNativeSourcePolicies(opened.storage, host, wire.session), stage = join(directory, "stage");
  await mkdir(stage, { mode: 0o700 });
  const plan = await planOriginalMcpApiChatSource(opened.storage, host,
    { stagingDirectory: stage, limits: { maxChats: 4, maxMessagesPerChat: 16, maxMessages: 32 } });
  await admitOriginalMcpApiChatSource(opened.storage, host, plan, policies.chat);
  const api = await createOriginalMcpApiChatRuntime(opened.owner, actor, host); closes.push(() => api.close());
  const call = async (tool, args) => (await api.invoke(tool, args)).structuredContent;
  const settle = async submitted => {
    for (let count = 0; count < 1000; count++) {
      const result = await call("api_chat_request_get", { host_id: opened.workspaceId, request_id: submitted.request_id });
      if (!["queued", "running"].includes(result.status)) return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Adoption command did not settle.");
  };
  return { ...opened, actor, host, wire, policies, chat, inputId, replyId, original, originalBytes, metadataPath, sessionPath, api, calls,
    call, settle, run(value) { execute = value; }, onReview(value) { review = value; }, allow(value) { allowAdoption = value; } };
}
test("SHA-pinned original managed source retains exact Task/Goal/input/history identities without a current grant", options, async t => {
  const f = await fixture(t), projection = await readOriginalManagedTaskAdoptionSource(f.storage, f.host, f.chat.id);
  assert.equal(projection.taskId, f.chat.sessionId); assert.equal(projection.goal.id, f.chat.workGoal.id);
  assert.equal(projection.goal.inputId, f.inputId); assert.deepEqual(projection.sourceInputIds, [f.inputId]);
  assert.deepEqual(projection.messages.map(message => message.id), [f.inputId, f.replyId]);
  assert.equal(projection.goal.acceptance[0].verified, true, "Source truth stays historical and is not rewritten.");
  assert.equal(projection.modelProvider, undefined); assert.equal(projection.permissionMode, undefined);
  const db = f.storage.connectNative();
  try {
    assert.deepEqual(assertOriginalManagedTaskAdoptionSource(db, f.host.receipt.root, projection), projection);
    assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM chat_sessions").get().n, 0);
  } finally { db.close(); }
  assert.deepEqual(await readFile(f.metadataPath), f.originalBytes.metadata);
  assert.deepEqual(await readFile(f.sessionPath), f.originalBytes.session);
});
test("reviewed rebinding preserves original identity and criterion text but resets every old acceptance claim; ordinary original resume still refuses context retargeting", options, async t => {
  const f = await fixture(t), projection = await readOriginalManagedTaskAdoptionSource(f.storage, f.host, f.chat.id);
  const old = structuredClone(projection), currentInput = randomUUID(), currentContext = "c".repeat(64);
  const unresolved = { id: f.chat.id, sessionId: projection.taskId, includeHistory: true, messages: structuredClone(projection.messages),
    workGoal: { ...structuredClone(projection.goal), status: "paused" } };
  assert.throws(() => f.original.prepareWorkGoal(unresolved, currentInput, "Continue this same objective.", currentContext), /another execution context/);
  const next = resumeReviewedOriginalManagedGoal(projection, { inputId: currentInput, prompt: "Continue this same objective.", contextDigest: currentContext });
  assert.equal(next.id, projection.goal.id); assert.equal(next.inputId, f.inputId);
  assert.equal(next.attemptInputId, currentInput); assert.equal(next.objective, projection.goal.objective);
  assert.equal(next.executionDigest, currentContext); assert.equal(next.status, "active");
  assert.deepEqual(next.acceptance, projection.goal.acceptance.map(item => ({ ...item, verified: false, evidenceCallIds: [] })));
  assert.deepEqual(projection, old, "The original source/acceptance record must remain byte-equivalent data.");
  assert.throws(() => resumeReviewedOriginalManagedGoal(projection,
    { inputId: randomUUID(), prompt: "Explain the original result.", contextDigest: currentContext }), /explicit continuation/);
});
test("actual authenticated Core/socket refuses missing adoption method and copied source data as authority", options, async t => {
  const f = await fixture(t), service = await createNativeManagedChatTasks(f.owner, f.host, f.actor);
  const args = { chatId: f.chat.id, expectedChatRevision: 0, operationId: randomUUID(),
    commandId: "original-task-adoption-no-method", prompt: "Continue this same exact original objective.", hardToolRoundLimit: 5 };
  await assert.rejects(service.prepareAdoption(args), /MISSING_NATIVE_METHOD chat.task.adopt/);
  const full = await f.owner.ensureFull();
  const result = await full.runtime.core.dispatch("capability_call", { operation: "chat.task.adopt", version: 1,
    arguments: { ...args, adoptionSha256: "a".repeat(64) } }, f.actor);
  assert.equal(result.error.code, "NOT_AVAILABLE");
  const db = f.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_task_attempts").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM chat_session_messages").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation='chat.task.adopt'").get().n, 0);
  } finally { db.close(); }
  assert.deepEqual(f.calls, []);
});
test("worker source recheck refuses copied Goal identities and changed immutable source without repinning", options, async t => {
  const f = await fixture(t), projection = await readOriginalManagedTaskAdoptionSource(f.storage, f.host, f.chat.id);
  const db = f.storage.connectNative();
  try {
    assert.throws(() => assertOriginalManagedTaskAdoptionSource(db, f.host.receipt.root,
      { ...projection, goal: { ...projection.goal, id: randomUUID() } }), /differs from actual original/);
    const changed = JSON.parse(f.originalBytes.metadata); changed.title = "Fixture-only concurrent source mutation";
    await writeFile(f.metadataPath, JSON.stringify(changed), { mode: 0o600 });
    assert.throws(() => assertOriginalManagedTaskAdoptionSource(db, f.host.receipt.root, projection), /source changed/);
  } finally { db.close(); }
  assert.deepEqual(f.calls, []);
});
const liveOptions = { ...options, skip: options.skip || (process.env.PKM_TEST_TASK_ADOPTION === "1" ? false
  : "Requires the genuinely routed optional model method 11; set PKM_TEST_TASK_ADOPTION=1.") };
async function inference(f, plan, ports, round, receipts, tools = plan.tools) {
  const body = { inferenceId: originalNativeChatDigest({ requestId: plan.requestId, sourcePlanSha256: plan.sourcePlanSha256, round, receipts }),
    round, planSha256: originalNativeChatDigest(plan), sourcePlanSha256: plan.sourcePlanSha256, selectionId: plan.selectionId,
    nativeRequest: { messages: plan.messages, options: { ...(tools.length ? {
      tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
    } : {}) } }, inputTokens: 10, countingMethod: "vscode-countTokens-plus-overhead" };
  await ports.beforeInference({ ...body, requestSha256: originalNativeChatInferenceDigest(body) });
  return body.inferenceId;
}
const taskContext = (plan, ports, inferenceId, round, phase, hasToolCalls, finalSummary = false) => ports.taskContext({
  phase, inferenceId, round, planSha256: originalNativeChatDigest(plan), sourcePlanSha256: plan.sourcePlanSha256,
  bindingSha256: plan.managedTask.bindingSha256, hasToolCalls, finalSummary,
});
test("actual socket/Core API adoption preserves original identities, resets old evidence and requires a fresh real tool receipt before resolution", liveOptions, async t => {
  // Deterministic peer model/review fixture, not installed/native-provider or human-approval qualification.
  const f = await fixture(t, { adoption: true });
  let executions = 0;
  f.run(async (plan, ports) => {
    executions++;
    assert.equal(plan.chatUrl, `pkm://chats/0123456789abcdef/${f.chat.id}`);
    assert.equal(plan.managedTask.taskId, f.chat.sessionId);
    assert.match(JSON.stringify(plan.messages), /historical tool evidence/);
    assert.match(JSON.stringify(plan.messages), /original-read/);
    assert(!JSON.stringify(plan.messages).includes("historical-model-is-not-current"));
    const receipts = [];
    async function tool(round, name, args, callId) {
      const id = await inference(f, plan, ports, round, receipts);
      await taskContext(plan, ports, id, round, "after-round", true);
      const result = await ports.tool({ inferenceId: id, round, callId, name, arguments: args, argumentsSha256: originalNativeChatDigest(args) });
      receipts.push(result.receiptSha256);
      await taskContext(plan, ports, id, round, "after-tools", true);
      return result;
    }
    const info = JSON.parse((await tool(0, "session_info", {}, "current-original-identity")).content);
    assert.equal(info.goal.id, f.chat.workGoal.id); assert.equal(info.goal.inputId, f.inputId);
    assert.notEqual(info.goal.executionDigest, f.chat.workGoal.executionDigest);
    assert.equal(info.goal.acceptance[0].verified, false); assert.deepEqual(info.goal.acceptance[0].evidenceCallIds, []);
    assert.deepEqual(info.sourceInputIds, [f.inputId, plan.managedTask.inputId]);
    assert.equal(info.adoption.oldPermissionsImported, false); assert.equal(info.adoption.oldAcceptanceImported, false);
    const report = { status: "resolved", reason: "Fresh canonical evidence is required.", sourceInputIds: info.sourceInputIds,
      acceptance: info.goal.acceptance.map(item => ({ ...item, verified: true, evidenceCallIds: ["original-read"] })) };
    const rejected = await tool(1, "report_work", report, "historical-evidence-refused");
    assert.match(rejected.content, /error/);
    const read = await tool(2, "get_document", { id: "Entry" }, "fresh-original-read");
    assert.match(read.content, /Pinned original Task adoption fixture/);
    const resolved = await tool(3, "report_work", { ...report,
      acceptance: report.acceptance.map(item => ({ ...item, evidenceCallIds: ["fresh-original-read"] })) }, "fresh-resolution");
    assert.equal(JSON.parse(resolved.content).goal.status, "resolved");
    const final = await inference(f, plan, ports, 4, receipts, []);
    await ports.text({ inferenceId: final, text: "Revalidated original Goal; no Task completion claimed." });
    await taskContext(plan, ports, final, 4, "after-round", false, true);
    assert.equal((await taskContext(plan, ports, final, 4, "settled", false, true)).decision, "finish");
    return { status: "complete", toolRoundLimit: { limit: 4, rounds: 4, reached: true } };
  });
  const args = { host_id: f.workspaceId, chat_id: f.chat.id, command_id: "adopt-exact-original",
    prompt: "Continue the same exact original objective.", hard_tool_round_limit: 4 };
  const submitted = await f.call("api_chat_send", args), receipt = await f.settle(submitted);
  assert.equal(receipt.status, "succeeded", receipt.error);
  assert.equal(receipt.result.chatId, f.chat.id); assert.equal(receipt.result.chatUrl, `pkm://chats/0123456789abcdef/${f.chat.id}`);
  assert.equal(receipt.result.sessionId, f.chat.sessionId); assert.equal(receipt.result.sessionAuthority, "native_core");
  assert.equal(receipt.result.managedTask.goal.id, f.chat.workGoal.id);
  assert.equal(receipt.result.managedTask.goal.objective, f.chat.workGoal.objective);
  assert.equal(receipt.result.managedTask.taskCompletion, "not-claimed");
  assert.equal((await f.call("api_chat_send", args)).request_id, submitted.request_id); assert.equal(executions, 1);
  const db = f.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation='chat.task.adopt'").get().n, 1);
    assert.deepEqual(db.prepare("SELECT id FROM chat_session_messages ORDER BY sequence").all().slice(0, 2).map(row => row.id), [f.inputId, f.replyId]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM chat_session_messages").get().n, 4);
  } finally { db.close(); }
  assert.deepEqual(await readFile(f.metadataPath), f.originalBytes.metadata);
  assert.deepEqual(await readFile(f.sessionPath), f.originalBytes.session);
});
test("actual socket/Core adoption denial and canonical identity collision publish no adopted Goal/input", liveOptions, async t => {
  for (const kind of ["deny", "collision"]) await t.test(kind, async t => {
    const f = await fixture(t, { adoption: true }); f.allow(kind !== "deny");
    if (kind === "collision") f.onReview(async () => {
      const { runtime } = await f.owner.ensureFull();
      const created = await runtime.core.dispatch("capability_call", { operation: "chat.session.create", version: 1,
        arguments: { id: f.chat.id, title: "Concurrent canonical owner", operationId: randomUUID(), expectedRevision: 0 } }, f.actor);
      assert.equal(created.error, undefined);
    });
    const request = await f.call("api_chat_send", { host_id: f.workspaceId, chat_id: f.chat.id,
      command_id: `adopt-${kind}`, prompt: "Continue the exact original objective.", hard_tool_round_limit: 4 });
    const result = await f.settle(request); assert.equal(result.status, "failed", result.error);
    const db = f.storage.connectNative();
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM chat_session_messages").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM original_api_chat_current_chats").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation='chat.task.adopt'").get().n, 0);
    } finally { db.close(); }
    assert(!f.calls.some(([kind]) => kind === "execution"));
  });
});
test("actual socket/Core rejects original source mutation during independent adoption review before send or publication", liveOptions, async t => {
  const f = await fixture(t, { adoption: true });
  f.onReview(async () => {
    const metadata = JSON.parse(f.originalBytes.metadata); metadata.title = "Fixture-only concurrent source change";
    await writeFile(f.metadataPath, JSON.stringify(metadata), { mode: 0o600 });
  });
  const result = await f.settle(await f.call("api_chat_send", { host_id: f.workspaceId, chat_id: f.chat.id,
    command_id: "adopt-source-race", prompt: "Continue the exact original objective.", hard_tool_round_limit: 4 }));
  assert.equal(result.status, "failed"); assert.match(result.error, /source changed/);
  assert(!f.calls.some(([kind]) => ["authorize", "execution"].includes(kind)));
  const db = f.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n, 0); }
  finally { db.close(); }
});
