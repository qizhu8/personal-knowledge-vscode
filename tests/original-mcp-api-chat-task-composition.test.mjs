import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { managedTaskFixture } from "./managed-chat-task-fixture.mjs";
import { originalNativeChatDigest } from "../dist/original-mcp-api-chat-contracts.js";
import { originalMcpManagedTaskGoalContext, originalMcpApiChatTaskToolCatalog,
  dispatchOriginalMcpApiChatTaskContext } from "../dist/original-mcp-api-chat-task-adapter.js";
import { OriginalNativeTaskSemanticError } from "../dist/original-mcp-api-chat-task-execution-contracts.js";
const { build } = createRequire(import.meta.url)("esbuild");
const hooks = await build({
  entryPoints: [resolve("clients/vscode-host/original-mcp-native-task-hooks.ts")],
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
  plugins: [{ name: "same-emitted-task-contracts", setup(plugin) {
    plugin.onResolve({ filter: /\/src\/original-mcp-api-chat(?:-task-execution)?-contracts\.js$/ }, args => ({
      path: new URL(`../dist/${args.path.split("/").at(-1)}`, import.meta.url).href, external: true,
    }));
  } }],
});
const { createOriginalNativeTaskRetainedHooks } = await import(
  `data:text/javascript;base64,${Buffer.from(hooks.outputFiles[0].text).toString("base64")}`);

test("Task hooks preserve retained finish/after-tools boundaries, source binding and known semantic stops without a driver", async () => {
  const body = { schema: "pkm.original-native-task-execution/v1", taskId: `agent_session_${randomUUID().replaceAll("-", "")}`,
    attemptId: randomUUID(), inputId: randomUUID(), replyId: randomUUID(), requestId: "a".repeat(64), chatId: randomUUID(),
    sourcePlanSha256: "b".repeat(64), nativeEpoch: randomUUID(), initialTaskRevision: 1, contextSha256: "c".repeat(64) };
  const plan = { schema: "pkm.original-api-chat-execution/v1", requestId: body.requestId,
    chatUrl: `pkm://chats/0123456789abcdef/${body.chatId}`, selectionId: randomUUID(), sourcePlanSha256: body.sourcePlanSha256,
    messages: [{ role: "user", content: "Start a new task: preserve the entire objective." }], tools: [],
    hardToolRoundLimit: 1, outputTokenCap: 128,
    budget: { maxInputTokens: 8192, maxTotalOutputTokens: 256, deadlineMs: 120000 },
    managedTask: { ...body, bindingSha256: originalNativeChatDigest(body) } };
  let state = { decision: "continue", continuation: "The original objective is still open.", goalStatus: "active", errorCode: null };
  const requests = [];
  const callback = async request => {
    requests.push(request);
    return { schema: "pkm.original-native-task-context/v1", requestId: plan.requestId,
      bindingSha256: plan.managedTask.bindingSha256, planSha256: originalNativeChatDigest(plan),
      taskRevision: 1, evidenceSha256: "d".repeat(64), stopAfterTools: false, ...state };
  };
  const hooks = createOriginalNativeTaskRetainedHooks(plan, callback);
  assert.throws(() => hooks.beforeFinish(), /ORDER/);
  hooks.beginRound({ round: 0, inferenceId: "e".repeat(64), hasToolCalls: true, finalSummary: false });
  await hooks.afterRound();
  assert.throws(() => hooks.stopAfterTools(), /ORDER/);
  await hooks.afterTools(); assert.equal(hooks.stopAfterTools(), false,
    "A Goal report is not an unsupported worker/plan handoff or a separate driver stop.");
  assert.throws(() => hooks.beforeFinish(), /ORDER/);
  hooks.beginRound({ round: 1, inferenceId: "f".repeat(64), hasToolCalls: false, finalSummary: true });
  await hooks.afterRound();
  assert.throws(() => hooks.beforeFinish(), /ORDER/, "The hard-budget summary must not inject another inference.");
  await assert.rejects(hooks.settled(), error => error instanceof OriginalNativeTaskSemanticError && error.reason === "GOAL_UNFINISHED");
  assert.throws(() => hooks.beginRound({ round: 2, inferenceId: "1".repeat(64), hasToolCalls: false, finalSummary: false }), /ORDER/);
  state = { decision: "reject", continuation: null, goalStatus: "active", errorCode: "GOAL_STALE_ENDINGS" };
  const staleEnding = createOriginalNativeTaskRetainedHooks(plan, callback);
  staleEnding.beginRound({ round: 0, inferenceId: "1".repeat(64), hasToolCalls: false, finalSummary: false });
  await staleEnding.afterRound();
  assert.throws(() => staleEnding.beforeFinish(), error => error instanceof OriginalNativeTaskSemanticError && error.reason === "GOAL_STALE_ENDINGS");
  state = { decision: "finish", continuation: null, goalStatus: "resolved", errorCode: null };
  const resolved = createOriginalNativeTaskRetainedHooks(plan, callback);
  resolved.beginRound({ round: 0, inferenceId: "2".repeat(64), hasToolCalls: false, finalSummary: false });
  await resolved.afterRound(); assert.equal(resolved.beforeFinish(), undefined); await resolved.settled();
  assert.deepEqual(requests.map(request => request.phase),
    ["after-round", "after-tools", "after-round", "settled", "after-round", "after-round", "settled"]);
  const stale = createOriginalNativeTaskRetainedHooks(plan, async () => ({
    schema: "pkm.original-native-task-context/v1", requestId: plan.requestId, bindingSha256: "0".repeat(64),
    planSha256: originalNativeChatDigest(plan), taskRevision: 1, evidenceSha256: "d".repeat(64), stopAfterTools: false, ...state,
  }));
  stale.beginRound({ round: 0, inferenceId: "3".repeat(64), hasToolCalls: false, finalSummary: false });
  await assert.rejects(stale.afterRound(), /BINDING/);
  assert.throws(() => createOriginalNativeTaskRetainedHooks({ ...plan,
    managedTask: { ...plan.managedTask, inputId: randomUUID() } }, async () => assert.fail()), /BINDING/);
});

test("Task goal context matches the SHA-pinned original context, including exact source identity and non-certification language", {
  timeout: 120000, skip: process.env.PKM_LEGACY_VSIX ? false : "Set PKM_LEGACY_VSIX to the pinned original package.",
}, async t => {
  const archive = process.env.PKM_LEGACY_VSIX, hash = createHash("sha256");
  for await (const bytes of createReadStream(archive)) hash.update(bytes);
  assert.equal(hash.digest("hex"), "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  const directory = resolve(".pkm-test-evidence", `api-task-context-oracle-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 }); t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("unzip", ["-q", archive, "extension/dist/*", "extension/package.json", "-d", directory], { stdio: "pipe" });
  const original = createRequire(import.meta.url)(join(directory, "extension/dist/chat/chat-work-goal.js"));
  const inputId = randomUUID(), taskId = `agent_session_${randomUUID().replaceAll("-", "")}`;
  const chat = { id: randomUUID(), sessionId: taskId, includeHistory: true,
    messages: [{ id: inputId, taskId, role: "user", content: "Start a new task：保留完整目标。", status: "complete" }] };
  original.prepareWorkGoal(chat, inputId, chat.messages[0].content, "a".repeat(64));
  assert.equal(originalMcpManagedTaskGoalContext({ goal: chat.workGoal, sourceInputIds: [inputId] }), original.workGoalContext(chat));
});

test("unnegotiated actual socket/Core API cannot create a Goal, duplicate input, expose semantic tools or supply a forged Task context", {
  timeout: 120000,
}, async t => {
  const f = await managedTaskFixture(t);
  const args = { host_id: f.workspaceId, chat_id: f.created.chatId, command_id: "missing-task-method",
    prompt: "Start a new task: do not infer managed authority from a plain native execution port." };
  const submitted = (await f.api.invoke("api_chat_send", args)).structuredContent;
  const replay = (await f.api.invoke("api_chat_send", args)).structuredContent;
  assert.equal(replay.request_id, submitted.request_id);
  let receipt;
  for (let count = 0; count < 200; count++) {
    receipt = (await f.api.invoke("api_chat_request_get", { host_id: f.workspaceId, request_id: submitted.request_id })).structuredContent;
    if (!["queued", "running"].includes(receipt.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(receipt.status, "failed");
  assert.match(receipt.error, /MISSING_NATIVE_METHOD execution\.task\.run/);
  const db = f.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_task_attempts").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM chat_session_messages").get().n, 0);
  } finally { db.close(); }
  assert.equal(f.highLevelRequests.filter(([kind, request]) => kind === "authorize" && request.operation === "send").length, 0);
  const fake = { requestId: "a".repeat(64), chatUrl: f.created.chatUrl, sourcePlanSha256: f.source.planSha256,
    managedTask: { schema: "pkm.original-native-task-execution/v1",
      taskId: `agent_session_${randomUUID().replaceAll("-", "")}`, attemptId: randomUUID(), inputId: randomUUID(), replyId: randomUUID(),
      requestId: "a".repeat(64), chatId: f.created.chatId, nativeEpoch: f.wire.activationId, initialTaskRevision: 1,
      sourcePlanSha256: f.source.planSha256, contextSha256: "b".repeat(64), bindingSha256: "c".repeat(64) } };
  assert.throws(() => originalMcpApiChatTaskToolCatalog(f.host, fake, []), /actual service-issued/);
  await assert.rejects(dispatchOriginalMcpApiChatTaskContext(f.wire.session, fake, {}), /actual service-issued/);
});
