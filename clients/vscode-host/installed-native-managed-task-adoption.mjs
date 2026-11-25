import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import * as fresh from "./installed-native-managed-task.mjs";
import { installedNativeManagedTaskAdoptionVendor, installedNativeManagedTaskAdoptionLabel,
  installedNativeManagedTaskAdoptionMarkers, installedNativeManagedTaskAdoptionReply,
  installedNativeManagedTaskAdoptionProposals } from "./installed-native-managed-task-adoption-provider.mjs";
import { startInstalledNativeManagedTaskAdoptionUi } from "./installed-native-managed-task-adoption-ui.mjs";

const require = createRequire(import.meta.url), preparations = new WeakMap();
const hash = value => createHash("sha256").update(value).digest("hex");
const load = (installed, name) => import(pathToFileURL(join(installed, "next-runtime/server/dist", `${name}.js`)).href);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value) {
  const state = preparations.get(value);
  if (!state) fail("INSTALLED_TASK_ADOPTION_ACTUAL_PREPARATION_REQUIRED"); return state;
}
async function absent(path, code) {
  try { await lstat(path); fail(code); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function pinned(value, code) {
  if (!value || !isAbsolute(value.path ?? "") || resolve(value.path) !== value.path || !/^[a-f0-9]{64}$/.test(value.sha256)) fail(code);
  const stat = await lstat(value.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8388608
    || await realpath(value.path) !== value.path || hash(await readFile(value.path)) !== value.sha256) fail(code);
  return value.path;
}
const originalDirectories = [".pkm/state/api-chats", ".pkm/state/api-chat-history", ".pkm/state/agent-groups", ".pkm/state/agent-sessions"];
async function originalFiles(root) {
  const found = []; let bytes = 0;
  async function visit(member) {
    const path = join(root, member), stat = await lstat(path);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail("INSTALLED_TASK_ADOPTION_PRIVATE_SOURCE_REQUIRED");
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(`${member}/${name}`);
    else {
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16777216 || found.length >= 4096 || (bytes += stat.size) > 33554432)
        fail("INSTALLED_TASK_ADOPTION_SOURCE_LIMIT");
      found.push({ path: member, bytes: await readFile(path) });
    }
  }
  for (const member of originalDirectories) {
    try { await visit(member); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return found;
}
async function unchanged(state, root = state.value.root) {
  const actual = await originalFiles(root);
  assert.deepEqual(actual.map(file => file.path), state.files.map(file => file.path));
  for (const [index, file] of actual.entries()) assert.deepEqual(file.bytes, state.files[index].bytes);
}
async function waitJson(path, timeoutMs, check = () => {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    check();
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.failed) throw new Error(`Installed adoption renderer failed: ${value.error}`);
      return value;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await delay(25);
  }
  throw new Error(`Installed adoption evidence timed out: ${path}`);
}
function shared() {
  if (typeof fresh.assertInstalledManagedTaskEnrollment !== "function" || typeof fresh.snapshotInstalledManagedTaskTables !== "function")
    fail("INSTALLED_TASK_ADOPTION_SHARED_FIXTURE_UTILITIES_REQUIRED");
  return { enrolled: fresh.assertInstalledManagedTaskEnrollment, tables: fresh.snapshotInstalledManagedTaskTables };
}

/** Parent calls only after actual whole first-editor exit, before B0/custody. No source Runtime is started here. */
export async function prepareInstalledNativeManagedTaskAdoptionFixture({ installed, componentFixture, legacyChatStore, legacyGoal }) {
  await (await load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (preparations.has(componentFixture)) fail("INSTALLED_TASK_ADOPTION_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    join(componentFixture.root, ".pkm-next-original-mcp.json")]) await absent(path, "INSTALLED_TASK_ADOPTION_PRESEAL_REQUIRED");
  const storePath = await pinned(legacyChatStore, "INSTALLED_TASK_ADOPTION_PINNED_CHAT_WRITER_REQUIRED");
  const goalPath = await pinned(legacyGoal, "INSTALLED_TASK_ADOPTION_PINNED_GOAL_WRITER_REQUIRED");
  for (const member of originalDirectories) await absent(join(componentFixture.root, member), "INSTALLED_TASK_ADOPTION_SEPARATE_SOURCE_REQUIRED");
  const { ApiChatStore } = require(storePath), goalWriter = require(goalPath), mask = process.umask(0o077);
  assert.equal(typeof goalWriter.prepareWorkGoal, "function"); assert.equal(typeof goalWriter.reportWork, "function");
  const namespace = "0123456789abcdef", cases = {};
  try {
    const store = new ApiChatStore(join(componentFixture.root, ".pkm/state"), namespace);
    for (const name of ["main", "collision"]) {
      const chat = store.create(); chat.title = `Original managed adoption ${name}`;
      chat.includeHistory = true; store.startTask(chat, `Original preserved Task ${name}`);
      const inputId = randomUUID(), replyId = randomUUID(), historicalEvidenceId = `historical-adoption-read-${randomUUID()}`;
      const objective = `Start a new task: preserve the exact original ${name} fixture Note objective and every subsequent requirement.`;
      chat.messages.push({ id: inputId, taskId: chat.sessionId, role: "user", content: objective, status: "complete" });
      goalWriter.prepareWorkGoal(chat, inputId, objective, hash(`original-installed-adoption-context:${name}`));
      const reply = { id: replyId, inputId, taskId: chat.sessionId, role: "assistant", content: "Historical fixture agent claim, not current verification.",
        status: "complete", toolCalls: [{ id: historicalEvidenceId, name: "get_document", arguments: '{"id":"Entry"}',
          status: "complete", result: "Seeded historical fixture read record; not an actual current Core execution receipt." }] };
      chat.messages.push(reply);
      goalWriter.reportWork(chat, reply, { status: "resolved", reason: "Historical fixture-only agent claim retained for acceptance-reset testing.",
        sourceInputIds: [inputId], acceptance: [{ criterion: goalWriter.rootWorkCriterion, verified: true, evidenceCallIds: [historicalEvidenceId] }] });
      chat.paused = true; chat.permissionMode = "ask"; chat.modelProvider = "openai-compatible";
      chat.modelProfileId = "historical-model-must-not-be-selected"; store.save(chat);
      cases[name] = Object.freeze({ chatId: chat.id, chatUrl: `pkm://chats/${namespace}/${chat.id}`, taskId: chat.sessionId,
        goalId: chat.workGoal.id, originalInputId: inputId, historicalReplyId: replyId, objective, historicalEvidenceId,
        chatTitle: chat.title, taskTitle: `Original preserved Task ${name}`,
        metadataPath: `.pkm/state/api-chats/${namespace}/${chat.id}.json`, sessionPath: `.pkm/state/agent-sessions/${chat.sessionId}.json` });
    }
  } finally { process.umask(mask); }
  await pinned(legacyChatStore, "INSTALLED_TASK_ADOPTION_PINNED_CHAT_WRITER_REQUIRED");
  await pinned(legacyGoal, "INSTALLED_TASK_ADOPTION_PINNED_GOAL_WRITER_REQUIRED");
  const files = await originalFiles(componentFixture.root), identity = await lstat(componentFixture.root, { bigint: true });
  const value = Object.freeze({ kind: "pkm.installed-native-managed-task-adoption-fixture/v1", root: componentFixture.root,
    namespace, cases: Object.freeze(cases), legacyChatWriterSha256: legacyChatStore.sha256, legacyGoalWriterSha256: legacyGoal.sha256,
    sourceFiles: Object.freeze(files.map(file => Object.freeze({ path: file.path, sha256: hash(file.bytes) }))) });
  const state = { value, componentFixture, files, phase: "prepared", rootIdentity: `${identity.dev}:${identity.ino}` };
  preparations.set(value, state); preparations.set(componentFixture, state); return value;
}
export const installedNativeManagedTaskAdoptionModelFixture = Object.freeze({
  vendor: installedNativeManagedTaskAdoptionVendor, label: installedNativeManagedTaskAdoptionLabel,
  evidenceFile: "native-managed-task-adoption-provider.json", toolCatalog: Object.freeze([
    Object.freeze({ name: "get_document", operation: "knowledge.document.get", approvalRequired: true }),
  ]),
});
export function installedNativeManagedTaskAdoptionProviderOptions(fixture, root) {
  stateFor(fixture); const original = fixture.cases.main;
  return Object.freeze({ evidencePath: join(root, installedNativeManagedTaskAdoptionModelFixture.evidenceFile),
    expectedToolText: "Approved genuine cold Note mutation.", originalTaskId: original.taskId, originalGoalId: original.goalId,
    originalInputId: original.originalInputId, originalObjective: original.objective, historicalEvidenceId: original.historicalEvidenceId });
}
export const installedNativeManagedTaskAdoptionUiStages = Object.freeze([
  "native-task-adoption-source", "native-task-adoption-deny-review", "native-task-adoption-deny-send",
  "native-task-adoption-positive", "native-task-adoption-replay", "native-task-adoption-collision",
  "native-task-adoption-source-revoke", "native-task-adoption-complete",
]);

/** Requires genuine installed signed model 11/source/owner; no native policy or approval-result injection. */
export async function verifyInstalledNativeManagedTaskAdoption({ root, installed, component, adoptionFixture,
  payloadBuildId, python, env, port, timeoutMs = 120000, signal }) {
  const state = stateFor(adoptionFixture);
  if (state.phase !== "prepared" || component?.fixture !== state.componentFixture || component?.root !== adoptionFixture.root)
    fail("INSTALLED_TASK_ADOPTION_SAME_COLD_FIXTURE_REQUIRED");
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail("INSTALLED_TASK_ADOPTION_PRIVATE_DRIVER_REQUIRED");
  await (await load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(component.fixture);
  const common = shared(), host = await component.complete(), full = await component.owner.ensureFull();
  (await load(installed, "root-owner")).assertRootOwner(component.owner);
  (await load(installed, "original-mcp-native-host")).assertOriginalMcpNativeHost(host, component.storage);
  const rpc = await load(installed, "original-mcp-native-chat-rpc");
  if (!host.nativeChat?.apiChat?.adopt || !rpc.originalMcpNativeChatSupportedMethods(host.nativeChat.session).includes("chat.task.adopt")
    || !rpc.originalMcpNativeChatSupportedMethods(host.nativeChat.session).includes("execution.task.run"))
    fail("INSTALLED_TASK_ADOPTION_ACTUAL_MODEL11_REQUIRED");
  rpc.assertOriginalMcpNativeChatRpcPort(host.nativeChat);
  await common.enrolled(root, installed, component, host, payloadBuildId);
  assert.equal(full.storage, component.storage); assert.equal(host.receipt.actorId, "mcp:external");
  assert.equal(host.options.providerTransport.supports("openai-compatible"), false);
  assert.equal(host.options.providerTransport.supports("azure-openai"), false);
  const lease = { ...component.owner.workspaceLease() }, actor = Object.freeze({ id: host.receipt.actorId, canWrite: true });
  const query = work => { const db = component.storage.connectNative(); try { return work(db); } finally { db.close(); } };
  assert.equal(query(db => db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n), 0);
  const source = await load(installed, "original-mcp-api-chat-source"), policies = component.sourcePolicies();
  (await load(installed, "original-mcp-native-source-policy")).assertOriginalMcpNativeSourcePolicy(policies.chat, component.storage, host, "chat");
  assert.equal(source.originalMcpApiChatSourceActive(component.storage, host), false);
  const stagingDirectory = join(component.fixture.directory, "installed-task-adoption-source");
  await mkdir(stagingDirectory, { mode: 0o700 });
  const plan = await source.planOriginalMcpApiChatSource(component.storage, host,
    { stagingDirectory, limits: { maxChats: 4, maxMessagesPerChat: 16, maxMessages: 32 } });
  assert.equal(plan.chats, 2);
  const { originalNativeChatDigest } = await load(installed, "original-mcp-api-chat-contracts");
  const catalogue = await host.nativeChat.models.catalogue(new AbortController().signal);
  const model = catalogue.models.find(item => item.vendor === installedNativeManagedTaskAdoptionVendor && item.label === installedNativeManagedTaskAdoptionLabel);
  if (!model) fail("INSTALLED_TASK_ADOPTION_REGISTERED_PROVIDER_REQUIRED");
  const runId = randomUUID(), requestId = commandId => hash(JSON.stringify([component.workspaceId, commandId]).replace(",", ", "));
  const requests = Object.fromEntries(["adoptDeny", "sendDeny", "positive", "collision"].map(name => {
    const original = adoptionFixture.cases[name === "collision" ? "collision" : "main"], commandId = `installed-task-adoption-${name}-${runId}`;
    const prompt = `Continue ${installedNativeManagedTaskAdoptionMarkers[name]}: preserve the full original objective and revalidate current acceptance.`;
    return [name, { name, commandId, requestId: requestId(commandId), chatId: original.chatId, chatUrl: original.chatUrl, prompt,
      argumentsSha256: originalNativeChatDigest({ chatId: original.chatId, prompt, hardToolRoundLimit: 7 }), hardToolRoundLimit: 7 }];
  }));
  for (const name of ["native-task-adoption-ui-contract.json", "native-task-adoption-ui-ready.json",
    "native-task-adoption-ui-passed.json", "native-task-adoption-passed.json"]) await absent(join(root, name), "INSTALLED_TASK_ADOPTION_EVIDENCE_REPLAY");
  await writeFile(join(root, "native-task-adoption-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-managed-task-adoption-ui/v1", runId, sourceRoot: component.root, workspaceId: component.workspaceId,
    profileSha256: component.custody.profileSha256, nativeEpoch: host.receipt.epoch, sourcePlanSha256: plan.planSha256,
    nativeHostReceiptSha256: host.receipt.receiptSha256, cases: adoptionFixture.cases, requests,
    modelId: model.id, wireModelId: model.nativeModelId, providerVendor: installedNativeManagedTaskAdoptionVendor, modelLabel: model.label,
    stages: installedNativeManagedTaskAdoptionUiStages,
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativeManagedTaskAdoptionUi({ root, python, env, port, runId, timeoutMs }), abort = new AbortController();
  void ui.done.catch(error => abort.abort(error));
  const check = () => { signal?.throwIfAborted(); if (ui.error) throw ui.error; };
  const progress = async stage => { check(); await writeFile(join(root, "progress.json"), JSON.stringify({ stage }), { mode: 0o600 }); };
  const provider = () => waitJson(join(root, installedNativeManagedTaskAdoptionModelFixture.evidenceFile), timeoutMs, check);
  const core = async (operation, arguments_, write = false) => {
    check(); const reply = await full.runtime.core.dispatch(write ? "capability_call" : "capability_read", { operation, version: 1, arguments: arguments_ }, actor);
    if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code }); return reply.result;
  };
  let runtime;
  state.phase = "verifying"; state.component = component;
  try {
    await waitJson(join(root, "native-task-adoption-ui-ready.json"), timeoutMs, check);
    await progress("native-task-adoption-source");
    await source.admitOriginalMcpApiChatSource(component.storage, host, plan, policies.chat);
    const sourceGrant = source.readOriginalMcpApiChatSourceSession(component.storage, host);
    const sourceApi = await load(installed, "managed-chat-task-adoption-source-native");
    for (const [name, original] of Object.entries(adoptionFixture.cases)) {
      const selected = await sourceApi.readOriginalManagedTaskAdoptionSource(component.storage, host, original.chatId);
      assert.equal(selected.taskId, original.taskId); assert.equal(selected.goal.id, original.goalId);
      assert.equal(selected.goal.inputId, original.originalInputId); assert.equal(selected.goal.acceptance[0].verified, true);
      const { messages: _messages, pins: _pins, messageHashes: _hashes, ...publicSource } = selected;
      await writeFile(join(root, `native-task-adoption-source-${name}.json`), JSON.stringify({
        sourceSha256: originalNativeChatDigest(selected), original: publicSource,
      }), { mode: 0o600, flag: "wx" });
    }
    runtime = await (await load(installed, "original-mcp-api-chat")).createOriginalMcpApiChatRuntime(component.owner, actor, host);
    const invoke = async (tool, args) => {
      check(); const result = await runtime.invoke(tool, args, AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]));
      assert(!result.isError && result.structuredContent, JSON.stringify(result)); return result.structuredContent;
    };
    const settle = async submitted => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const result = await invoke("api_chat_request_get", { host_id: component.workspaceId, request_id: submitted.request_id });
        if (!["queued", "running"].includes(result.status)) return result; await delay(25);
      }
      throw new Error(`Installed adoption command did not settle: ${submitted.request_id}`);
    };
    const get = async id => {
      const result = await settle(await invoke("api_chat_get", { host_id: component.workspaceId, chat_id: id }));
      assert.equal(result.status, "succeeded", result.error); return result.result;
    };
    const submit = name => invoke("api_chat_send", { host_id: component.workspaceId, chat_id: requests[name].chatId,
      command_id: requests[name].commandId, prompt: requests[name].prompt, hard_tool_round_limit: 7 });
    const none = () => query(db => {
      for (const table of ["managed_chat_tasks", "managed_chat_task_attempts", "chat_sessions", "chat_session_messages", "original_api_chat_current_chats"])
        assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `Denied adoption published ${table}`);
      assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation='chat.task.adopt'").get().n, 0);
    });
    assert.equal((await provider()).nativeCalls, 0);
    const archived = await get(adoptionFixture.cases.main.chatId);
    assert.equal(archived.sessionId, adoptionFixture.cases.main.taskId); assert.equal(archived.sessionAuthority, "archive_only");
    assert.equal(archived.managedTask, undefined); none();
    for (const [name, stage] of [["adoptDeny", "native-task-adoption-deny-review"], ["sendDeny", "native-task-adoption-deny-send"]]) {
      await progress(stage); const denied = await settle(await submit(name)); assert.equal(denied.status, "failed", denied.error);
      none(); assert.equal((await provider()).nativeCalls, 0);
      assert.equal((await get(adoptionFixture.cases.main.chatId)).sessionAuthority, "archive_only");
    }
    await progress("native-task-adoption-positive");
    const submitted = await submit("positive"), until = Date.now() + timeoutMs;
    let actual;
    while (Date.now() < until) {
      check();
      const row = query(db => db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_native_chat_executions'").get()
        ? db.prepare("SELECT plan,plan_sha256 FROM original_native_chat_executions WHERE request_id=?").get(requests.positive.requestId) : undefined);
      if (row) { actual = { plan: JSON.parse(row.plan), planSha256: row.plan_sha256 }; break; } await delay(25);
    }
    assert(actual, "No actual canonical adoption/native execution appeared.");
    assert.equal(originalNativeChatDigest(actual.plan), actual.planSha256);
    assert.equal(actual.plan.managedTask.taskId, adoptionFixture.cases.main.taskId);
    const task = query(db => db.prepare("SELECT * FROM managed_chat_tasks WHERE task_id=?").get(adoptionFixture.cases.main.taskId));
    const goal = JSON.parse(actual.plan.messages.find(message => message.content.startsWith("Current native Task binding"))
      .content.split("User work objective (not a permission grant or a managed Task completion certificate):\n")[1].split("\n")[0]);
    assert.equal(goal.id, adoptionFixture.cases.main.goalId); assert(goal.acceptance.every(item => !item.verified && !item.evidenceCallIds.length));
    const binding = { managedTask: actual.plan.managedTask, planSha256: actual.planSha256, goal, tools: actual.plan.tools.map(tool => tool.name),
      proposals: installedNativeManagedTaskAdoptionProposals(actual.plan.managedTask, goal, adoptionFixture.cases.main.historicalEvidenceId) };
    await writeFile(join(root, "native-task-adoption-positive-binding.json"), JSON.stringify(binding), { mode: 0o600, flag: "wx" });
    const done = await settle(submitted); assert.equal(done.status, "succeeded", done.error);
    const managed = done.result.managedTask, original = adoptionFixture.cases.main;
    assert.equal(done.result.chatId, original.chatId); assert.equal(done.result.chatUrl, original.chatUrl);
    assert.equal(done.result.sessionId, original.taskId); assert.equal(done.result.sessionAuthority, "native_core");
    assert.equal(done.result.reply.content, installedNativeManagedTaskAdoptionReply);
    assert.equal(managed.taskId, original.taskId); assert.equal(managed.goal.id, original.goalId);
    assert.equal(managed.goal.inputId, original.originalInputId); assert.equal(managed.goal.objective, original.objective);
    assert.equal(managed.status, "active"); assert.equal(managed.taskCompletion, "not-claimed"); assert.equal(managed.goal.status, "resolved");
    assert.equal(managed.adoption.oldAcceptanceImported, false); assert.equal(managed.adoption.oldPermissionsImported, false);
    assert.equal(managed.harnessReports.length, 3); assert.equal(managed.sourceInputIds.length, 2);
    assert.deepEqual(managed.goal.acceptance[0].evidenceCallIds, [binding.proposals[2].callId]);
    const validation = managed.harnessReports.filter(report => report.kind === "validation");
    assert.deepEqual(validation.map(report => report.status), ["start", "complete"]);
    assert.equal(validation[0].sourceInputDigest, validation[1].sourceInputDigest);
    const execution = (await load(installed, "original-mcp-api-chat-execution")).readOriginalMcpNativeExecution(component.storage, host, requests.positive.requestId);
    assert.equal(execution.status, "complete"); assert.equal(execution.context.roundCount, 8);
    assert.deepEqual(execution.tools.map(tool => tool.status), ["complete", "failed", "complete", "complete", "complete", "complete", "complete"]);
    assert.equal(execution.toolRoundLimit.reached, true);
    const history = await core("chat.session.messages", { id: original.chatId, afterSequence: 0, limit: 100 });
    assert.deepEqual(history.items.slice(0, 2).map(message => message.id), [original.originalInputId, original.historicalReplyId]);
    assert.equal(history.items.length, 4); assert.equal(history.items.at(-1).id, managed.attempt.replyId);
    assert.equal(task.owner_id, lease.ownerId); assert.equal(task.owner_fence, lease.fence);
    assert.equal((await provider()).nativeCalls, 8);
    assert((await provider()).requests.some(request => request.historicalEvidenceRefused === true));
    await progress("native-task-adoption-replay");
    assert.equal((await submit("positive")).request_id, submitted.request_id);
    assert.equal((await provider()).nativeCalls, 8);
    await progress("native-task-adoption-collision");
    const collision = await submit("collision");
    await waitJson(join(root, "native-task-adoption-collision-visible.json"), timeoutMs, check);
    const operationId = randomUUID(), reserved = await core("chat.session.create", { id: adoptionFixture.cases.collision.chatId,
      title: "Concurrent installed fixture operator reservation", operationId, expectedRevision: 0 }, true);
    assert.equal(reserved.revision, 1);
    const inputOperationId = randomUUID(), concurrentInputId = randomUUID();
    const concurrentInput = await core("chat.session.append", { id: reserved.id, expectedRevision: reserved.revision,
      operationId: inputOperationId, message: { id: concurrentInputId, role: "user", status: "complete",
        content: "Concurrent installed fixture operator input; never overwrite during original adoption." } }, true);
    assert.equal(concurrentInput.session.revision, 2);
    await writeFile(join(root, "native-task-adoption-collision-committed.json"), JSON.stringify({
      committed: true, operationId, inputOperationId, messageId: concurrentInputId, chatId: reserved.id, revision: concurrentInput.session.revision,
    }), { mode: 0o600, flag: "wx" });
    const collided = await settle(collision); assert.equal(collided.status, "failed", collided.error);
    await waitJson(join(root, "native-task-adoption-collision-clicked.json"), timeoutMs, check);
    assert.equal((await provider()).nativeCalls, 8);
    query(db => {
      assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_task_attempts").get().n, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation='chat.task.adopt'").get().n, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM original_api_chat_current_chats WHERE id=?").get(reserved.id).n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM original_native_chat_executions WHERE request_id=?").get(requests.collision.requestId).n, 0);
    });
    const concurrentHistory = await core("chat.session.messages", { id: reserved.id, afterSequence: 0, limit: 100 });
    assert.equal(concurrentHistory.items.length, 1); assert.equal(concurrentHistory.items[0].id, concurrentInputId);
    assert.equal((await get(reserved.id)).sessionAuthority, "archive_only");
    assert.deepEqual(component.owner.workspaceLease(), lease); assert.equal((await component.owner.ensureFull()).runtime.core, full.runtime.core);
    await unchanged(state);
    await progress("native-task-adoption-source-revoke");
    await waitJson(join(root, "native-task-adoption-revoke-visible.json"), timeoutMs, check);
    const stored = query(common.tables); policies.revoke("chat");
    assert.equal(Atomics.load(new Int32Array(sourceGrant.revocation), 0), 1); assert.equal(host.signal.aborted, false);
    await assert.rejects(runtime.invoke("api_chat_send", { host_id: component.workspaceId, chat_id: original.chatId,
      command_id: `revoked-adoption-${runId}`, prompt: `Continue ${installedNativeManagedTaskAdoptionMarkers.revoked}` }));
    assert.deepEqual(query(common.tables), stored); assert.equal((await provider()).nativeCalls, 8);
    assert.equal((await host.nativeChat.models.catalogue(new AbortController().signal)).source, "vscode.lm");
    await progress("native-task-adoption-complete"); await ui.done;
    const uiProof = await waitJson(join(root, "native-task-adoption-ui-passed.json"), timeoutMs, check);
    assert.equal(uiProof.actualRenderedDom, true); assert.equal(uiProof.sameCollisionReviewClickedAfterCommit, true);
    const evidence = { schema: "pkm.installed-native-managed-task-adoption-evidence/v1", passed: true, payloadBuildId,
      deterministicProvider: true, commercialProviderQualified: false, actualProfileOrKeyringQualified: false, fullCutoverQualified: false,
      humanTaskAcceptanceClaimed: false, b1PreservationVerified: false, b0RestorationVerified: false,
      profileSha256: component.custody.profileSha256, custodyPlanSha256: component.custody.planSha256,
      sourcePlanSha256: plan.planSha256, nativeHostReceiptSha256: host.receipt.receiptSha256, sameOwnerAndCachedCore: true,
      originalIdentities: original, deniedAdoptionNoCanonicalState: true, deniedSendAfterAdoptionNoCanonicalState: true,
      historicalEvidenceRefusedAsCurrent: true, actualCurrentCoreReadAndHarness: true, originalSourcesUnchanged: true,
      exactGoalAndHistoryIdsPreserved: true, publicReplayNoInference: true, canonicalCollisionNoAdoptedAuthority: true,
      concurrentCanonicalInputPreserved: true,
      independentSourceRevokeNoNewEffect: true, actualProviderCalls: 8, actualAdoptedTasks: 1, actualAttempts: 1,
      taskCompletion: managed.taskCompletion, taskStatus: managed.status, goalStatus: managed.goal.status, requests, actualNativeUi: uiProof };
    await writeFile(join(root, "native-task-adoption-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
    state.phase = "verified"; state.stored = stored; state.evidence = evidence; return evidence;
  } finally {
    abort.abort(); try { await runtime?.close(); } finally { await ui.stop(); }
  }
}

/** Parent must first stop the real editor, close the owner, retire typed B1 and restore a disjoint B0. */
export async function verifyInstalledNativeManagedTaskAdoptionRestored(adoptionFixture, { restoredRoot, archive }) {
  const state = stateFor(adoptionFixture);
  if (state.phase !== "verified") fail("INSTALLED_TASK_ADOPTION_VERIFIED_EFFECT_REQUIRED");
  assert.throws(() => state.component.owner.assertWorkspaceLease());
  if (restoredRoot !== join(state.componentFixture.directory, "restored-b0") || typeof archive !== "string"
    || !/^\.pkm-next-component-retired-[a-f0-9-]{36}$/.test(relative(adoptionFixture.root, archive))
    || await realpath(restoredRoot) !== restoredRoot || await realpath(archive) !== archive)
    fail("INSTALLED_TASK_ADOPTION_ACTUAL_RESTORE_REQUIRED");
  const original = await lstat(adoptionFixture.root, { bigint: true }), freshRoot = await lstat(restoredRoot, { bigint: true });
  assert.equal(`${original.dev}:${original.ino}`, state.rootIdentity); assert.notEqual(`${freshRoot.dev}:${freshRoot.ino}`, state.rootIdentity);
  const retirementBytes = await readFile(join(state.componentFixture.directory, "retirement-complete.json"));
  const retirement = JSON.parse(retirementBytes), restored = JSON.parse(await readFile(join(state.componentFixture.directory, "b0-restored.json")));
  assert.equal(retirement.schema, "pkm.original-mcp-component-retirement/v1");
  assert.equal(retirement.root, adoptionFixture.root); assert.equal(retirement.archive, archive); assert.equal(retirement.enginesStopped, true);
  assert.equal(restored.schema, "pkm.original-mcp-component-b0-restored/v1");
  assert.equal(restored.root, restoredRoot); assert.equal(restored.originalRoot, adoptionFixture.root); assert.equal(restored.originalRootOverwritten, false);
  assert.equal(restored.retirementSha256, hash(retirementBytes)); assert.equal(restored.b0Sha256, retirement.b0Sha256); assert.equal(restored.b1Sha256, retirement.b1Sha256);
  const b0 = await readFile(join(state.componentFixture.directory, "b0/manifest.json")); assert.equal(hash(b0), restored.b0Sha256);
  let b1;
  for (const name of (await readdir(state.componentFixture.directory)).filter(name => /^b1-[a-f0-9-]{36}$/.test(name))) {
    const bytes = await readFile(join(state.componentFixture.directory, name, "manifest.json"));
    if (hash(bytes) === restored.b1Sha256) b1 = JSON.parse(bytes);
  }
  assert(b1);
  for (const file of state.files) {
    assert.equal(JSON.parse(b0).rows.find(row => row.path === file.path)?.sha256, hash(file.bytes));
    assert.equal(b1.rows.find(row => row.path === file.path)?.sha256, hash(file.bytes));
  }
  await unchanged(state, restoredRoot); await unchanged(state, archive);
  for (const member of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-original-mcp.json"])
    await absent(join(restoredRoot, member), "INSTALLED_TASK_ADOPTION_B0_NATIVE_STATE");
  assert.equal(b1.rows.find(row => row.path === "core.sqlite")?.sha256, hash(await readFile(join(archive, "core.sqlite"))));
  const db = new DatabaseSync(join(archive, "core.sqlite"), { readOnly: true });
  try {
    assert.equal(Object.values(db.prepare("PRAGMA integrity_check").get())[0], "ok");
    assert.deepEqual(shared().tables(db), state.stored, "B1 must preserve actual adoption proof/Goal/Harness/receipts/transcript, not inventory only.");
  } finally { db.close(); }
  state.phase = "restored";
  return { originalChatGroupSessionGoalHistoryB0Restored: true, canonicalAdoptionGoalHarnessAndNativeReceiptsB1Preserved: true,
    noNativeStateInheritedByB0: true, originalRootNotOverwritten: true, freshDisjointB0: true,
    humanTaskAcceptanceClaimed: false, fullCutoverQualified: false };
}
