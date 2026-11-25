import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { originalMcpApiChatRequestsNewTask } from "../src/original-mcp-api-chat-task.ts";
import { RootOwner } from "../dist/root-owner.js";
import { initialize } from "../dist/storage.js";
import { agentRuntimeDefinitions } from "../dist/agent-runtime-contracts.js";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { planOriginalMcpApiChatSource, admitOriginalMcpApiChatSource,
  activateOriginalMcpApiChatSource } from "../dist/original-mcp-api-chat-source.js";
import { createOriginalMcpApiChatRuntime } from "../dist/original-mcp-api-chat.js";
import { createOriginalMcpNativeChatSessionFixture } from "./fixtures/original-mcp-native-chat-session.mjs";

const require = createRequire(import.meta.url), originalArchive = process.env.PKM_LEGACY_VSIX;
const releaseSha256 = "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27";
const newTasks = [
  "Start a new task: implement the exact requested repair.",
  " \nSTART A NEW TASK : retain the entire prompt and its consent identity.",
  "Start a new task：verify the required acceptance.",
  "开始新任务：保持原始目标和权限。",
  "  开始新任务 : 不得把任务完成当作回复完成。",
];
test("explicit new-Task recognition closes all original language/colon variants rather than falling through to ordinary inference", () => {
  for (const prompt of [...newTasks, "Start a new task:", "开始新任务："])
    assert.equal(originalMcpApiChatRequestsNewTask(prompt), true, prompt);
  for (const prompt of ["Explain 'Start a new task:'", "Start a new task without a colon", "Continue this ordinary Chat."])
    assert.equal(originalMcpApiChatRequestsNewTask(prompt), false, prompt);
});

test("pinned original Task producer keeps source objective and semantic acceptance separate from a complete response", {
  timeout: 120000, skip: originalArchive ? false : "Set PKM_LEGACY_VSIX to the independently pinned original package.",
}, async t => {
  assert(isAbsolute(originalArchive));
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(originalArchive)) hash.update(bytes);
  assert.equal(hash.digest("hex"), releaseSha256);
  const directory = resolve(".pkm-test-evidence", `new-task-original-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("unzip", ["-q", originalArchive, "extension/dist/*", "extension/resources/*",
    "extension/node_modules/*", "extension/package.json", "-d", directory], { stdio: "pipe", timeout: 60000 });
  const extension = join(directory, "extension"), goal = require(join(extension, "dist/chat/chat-work-goal.js"));
  const { ApiChatStore } = require(join(extension, "dist/chat/api-chat-store.js"));
  const state = join(directory, "fixture-root/.pkm/state"), store = new ApiChatStore(state, "0123456789abcdef");
  const oldMask = process.umask(0o077);
  let chat;
  try { chat = store.create(); store.startTask(chat, "Fresh original Task oracle"); }
  finally { process.umask(oldMask); }
  assert.match(chat.sessionId, /^agent_session_[a-f0-9]{32}$/);
  const taskFile = join(state, "agent-sessions", `${chat.sessionId}.json`);
  assert.equal(JSON.parse(await readFile(taskFile, "utf8")).status, "paused",
    "Original Task creation is not itself a running inference.");
  for (const prompt of newTasks) assert.equal(originalMcpApiChatRequestsNewTask(prompt), goal.newWorkGoal.test(prompt));
  const inputId = randomUUID(), prompt = newTasks[0];
  chat.messages.push({ id: inputId, role: "user", content: prompt, taskId: chat.sessionId, status: "complete" });
  goal.prepareWorkGoal(chat, inputId, prompt, "a".repeat(64));
  const reply = { id: randomUUID(), inputId, role: "assistant", content: "The model says complete.",
    taskId: chat.sessionId, status: "complete", toolCalls: [] };
  chat.messages.push(reply);
  assert.equal(chat.workGoal.objective, prompt);
  assert.equal(chat.workGoal.status, "active");
  assert.equal(chat.workGoal.acceptance[0].verified, false);
  const before = structuredClone(chat.workGoal);
  assert.throws(() => goal.reportWork(chat, reply, { status: "resolved", reason: "A model reply completed.",
    sourceInputIds: [inputId], acceptance: [{ criterion: goal.rootWorkCriterion, verified: true, evidenceCallIds: [] }] }),
  /requires unique successful|No eligible current-reply|acceptance requires|call IDs/i);
  assert.deepEqual(chat.workGoal, before);
  store.save(chat);
  const persisted = JSON.parse(await readFile(taskFile, "utf8"));
  assert.notEqual(persisted.status, "completed");
  assert.equal(persisted.nativeChat.workGoal.status, "active");
});

test("actual same-owner Core transcript completion cannot activate an uncomposed native Task/Goal/Harness scope", { timeout: 120000 }, async t => {
  const directory = resolve(".pkm-test-evidence", `new-task-core-${randomUUID()}`);
  await initialize(directory);
  const owner = await RootOwner.open(directory);
  t.after(async () => { await owner.close(); await rm(directory, { recursive: true, force: true }); });
  const { runtime } = await owner.ensureFull(), actor = { id: "mcp:external", canWrite: true }, id = randomUUID();
  const invoke = async (operation, args, write = false) => runtime.core.dispatch(write ? "capability_call" : "capability_read",
    { operation, version: 1, arguments: args }, actor);
  const created = await invoke("chat.session.create", { id, title: "Native transcript is not a managed Task",
    expectedRevision: 0, operationId: randomUUID() }, true);
  assert.equal(created.error, undefined);
  const input = await invoke("chat.session.append", { id, expectedRevision: created.result.revision, operationId: randomUUID(),
    message: { id: "input", role: "user", content: newTasks[0], status: "complete" } }, true);
  const reply = await invoke("chat.session.append", { id, expectedRevision: input.result.session.revision, operationId: randomUUID(),
    message: { id: "reply", role: "assistant", content: "A complete response is not managed acceptance.", status: "complete" } }, true);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.session.metadata?.sessionId, undefined);
  assert.equal((await invoke("chat.task.start", { id, prompt: newTasks[0], operationId: randomUUID() }, true)).error.code, "NOT_AVAILABLE");
  for (const operation of ["chat.goal.start", "chat.harness.report"])
    assert.equal((await invoke(operation, { id, prompt: newTasks[0], operationId: randomUUID() }, true)).error.code, "NOT_FOUND");
  const start = agentRuntimeDefinitions.find(operation => operation.id === "agent.runtime.spawn");
  assert.equal(start.input.safeParse({ opId: randomUUID(), taskKey: "new-user-objective", prompt: newTasks[0] }).success, false,
    "Configured Agent task keys cannot safely be repurposed as an arbitrary consent-bound managed goal.");
  assert.equal(runtime.services.agentRuntime, undefined);
});

test("fresh native-owned Chat keeps new-Task requests closed, idempotent and inert after cancellation or source denial", { timeout: 120000 }, async t => {
  const directory = resolve(".pkm-test-evidence", `new-task-native-${randomUUID()}`), root = join(directory, "root");
  const previousMask = process.umask(0o077), closes = [];
  t.after(async () => {
    try { for (const close of closes.reverse()) await close(); }
    finally { process.umask(previousMask); await rm(directory, { recursive: true, force: true }); }
  });
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".pkm"), { mode: 0o700 });
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nPrivate new-Task boundary fixture.\n", { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "new-task-boundary-fixture", profileSha256: "a".repeat(64),
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 1_048_576 } });
  const opened = await openOriginalMcpRoot(plan); closes.push(() => opened.owner.close());
  let wire, modelCalls = 0;
  const calls = [];
  const unavailable = () => { modelCalls++; throw new Error("No goal/Task composition may reach a model."); };
  // Real socket/crypto and actual Core; explicit fixture UI doubles grant create only, never a Task or model request.
  wire = await createOriginalMcpNativeChatSessionFixture(t, {
    binding: { root, workspaceId: opened.workspaceId, planSha256: plan.planSha256, profileSha256: plan.profileSha256,
      catalogSha256: originalPublicMcpContracts().provenance.metadataSha256 },
    models: { catalogue: unavailable, select: unavailable, count: unavailable, async *stream() { unavailable(); } },
    execution: { run: unavailable },
    apiChat: {
      async resolve(request) {
        calls.push(["resolve", request]);
        assert.equal(request.chatUrl, null);
        return { protocol: "pkm.original-api-chat-execution/v1", epoch: wire.activationId, modelId: "task-boundary-fixture",
          wireModelId: "task-boundary-wire", provider: "vscode", permissionMode: "protective", outputTokenCap: 128,
          budget: { maxInputTokens: 8192, maxTotalOutputTokens: 2048, deadlineMs: 120000 } };
      },
      async authorize(request) { calls.push(["authorize", request]); assert.equal(request.operation, "create"); return true; },
      async present(request) { calls.push(["present", request]); },
    },
  });
  closes.push(() => wire.close());
  const lifetime = new AbortController();
  const host = await createOriginalMcpNativeHost(opened.storage, {
    profileSha256: plan.profileSha256, sourceCatalogSha256: originalPublicMcpContracts().provenance.metadataSha256,
    authorityId: "trusted-fixture-new-task-boundary", epoch: wire.activationId, signal: lifetime.signal,
    assertCurrent() {}, async authorizeAdmission() { return true; }, async authorizePublic() { return true; },
    models: { configuration: {}, registryAvailability: {}, async credentialAvailable() { return false; },
      async authorizeRequest() { throw new Error("No Task/model authority is composed."); },
      transport: { supports: () => false, async open() { unavailable(); } } },
  }, { nativeChat: wire.resource });
  const stagingDirectory = join(directory, "source-stage"); await mkdir(stagingDirectory, { mode: 0o700 });
  const source = await planOriginalMcpApiChatSource(opened.storage, host,
    { stagingDirectory, limits: { maxChats: 100, maxMessagesPerChat: 1000, maxMessages: 4000 } });
  await admitOriginalMcpApiChatSource(opened.storage, host, source, { async authorize() {
    return { actorId: "mcp:external", decisionId: randomUUID(), expiresAtMs: Date.now() + 120000 };
  } });
  const api = await createOriginalMcpApiChatRuntime(opened.owner, { id: "mcp:external", canWrite: true }, host);
  closes.push(() => api.close());
  const invoke = async (tool, args, signal) => {
    const result = await api.invoke(tool, args, signal);
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  };
  const settled = async request => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = await invoke("api_chat_request_get", { host_id: opened.workspaceId, request_id: request.request_id });
      if (!["queued", "running"].includes(current.status)) return current;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("New-Task boundary receipt did not settle.");
  };
  const created = await settled(await invoke("api_chat_create", {
    host_id: opened.workspaceId, title: "Fresh native-owned Chat", command_id: "new-task-create",
  }));
  assert.equal(created.status, "succeeded", created.error);
  const before = structuredClone(calls);
  for (const [index, prompt] of newTasks.entries()) {
    const args = { host_id: opened.workspaceId, chat_id: created.result.chatUrl, prompt, command_id: `new-task-${index}` };
    const refused = await settled(await invoke("api_chat_send", args));
    assert.equal(refused.status, "failed");
    assert.match(refused.error, /ORIGINAL_NATIVE_CHAT_MANAGED_GOAL_COMPOSITION_REQUIRED/);
    assert.deepEqual(await invoke("api_chat_send", args), refused);
  }
  assert.deepEqual(calls, before, "Task syntax is not silently delegated to ordinary native send consent.");
  assert.equal(modelCalls, 0);
  const { runtime } = await opened.owner.ensureFull();
  const session = await runtime.core.dispatch("capability_read", { operation: "chat.session.get", version: 1,
    arguments: { id: created.result.chatId } }, { id: "mcp:external", canWrite: true });
  assert.equal(session.result.messageCount, 0); assert.equal(session.result.metadata?.sessionId, undefined);
  const cancelled = { host_id: opened.workspaceId, chat_id: created.result.chatUrl,
    prompt: newTasks[0], command_id: "new-task-cancelled-before-submit" };
  const db = opened.storage.connectNative();
  try {
    const count = db.prepare("SELECT count(*) AS n FROM original_api_chat_requests").get().n;
    await assert.rejects(invoke("api_chat_send", cancelled, AbortSignal.abort()));
    assert.equal(db.prepare("SELECT count(*) AS n FROM original_api_chat_requests").get().n, count);
    await assert.rejects(activateOriginalMcpApiChatSource(opened.storage, host, { async authorize() { return null; } }));
    await assert.rejects(invoke("api_chat_send", { ...cancelled, command_id: "new-task-stale-source" }));
    assert.equal(db.prepare("SELECT count(*) AS n FROM original_api_chat_requests").get().n, count);
  } finally { db.close(); }
  assert.equal(host.signal.aborted, false);
  opened.owner.assertWorkspaceLease();
  assert.equal(modelCalls, 0);
});
