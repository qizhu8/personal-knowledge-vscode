import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { startInstalledNativeTodoAssignmentUi } from "./installed-native-todo-assignment-ui.mjs";

const require = createRequire(import.meta.url), preparations = new WeakMap();
const hash = value => createHash("sha256").update(value).digest("hex");
const load = (installed, name) => import(pathToFileURL(join(installed, "next-runtime/server/dist", `${name}.js`)).href);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value) {
  const state = preparations.get(value);
  if (!state) fail("INSTALLED_TODO_ASSIGNMENT_ACTUAL_PREPARATION_REQUIRED");
  return state;
}
async function absent(path, code) {
  try { await lstat(path); fail(code); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function writer(value) {
  if (!value || typeof value.path !== "string" || !isAbsolute(value.path) || resolve(value.path) !== value.path
    || !/^[a-f0-9]{64}$/.test(value.sha256)) fail("INSTALLED_TODO_ASSIGNMENT_PINNED_WRITER_REQUIRED");
  const stat = await lstat(value.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8_388_608
    || await realpath(value.path) !== value.path || hash(await readFile(value.path)) !== value.sha256)
    fail("INSTALLED_TODO_ASSIGNMENT_ORIGINAL_WRITER_CHANGED");
  return value.path;
}
async function originalFiles(root, boardPath, notePath) {
  const files = [];
  let bytes = 0;
  async function visit(path, member) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail("INSTALLED_TODO_ASSIGNMENT_PRIVATE_SOURCE_REQUIRED");
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${member}/${name}`);
    } else {
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_777_216 || files.length >= 4096
        || (bytes += stat.size) > 33_554_432) fail("INSTALLED_TODO_ASSIGNMENT_SOURCE_LIMIT");
      files.push({ path: member, bytes: await readFile(path) });
    }
  }
  for (const member of [boardPath, notePath, ".pkm/state/api-chats", ".pkm/state/api-chat-history", ".pkm/state/agent-groups"]) {
    try { await visit(join(root, member), member); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return files;
}
async function unchanged(state, root = state.value.root) {
  for (const file of state.files) assert.deepEqual(await readFile(join(root, file.path)), file.bytes);
}
async function waitJson(path, timeoutMs, check = () => {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    check();
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.failed) throw new Error(`Installed assignment UI failed: ${value.error}`);
      return value;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await delay(50);
  }
  throw new Error(`Installed assignment evidence timed out: ${path}`);
}

/** Separate disposable component only. Both independently pinned original writers run before B0/custody. */
export async function prepareInstalledNativeTodoAssignmentFixture({ installed, componentFixture, legacyWriter, legacyChatStore }) {
  const recovery = await load(installed, "original-mcp-component-recovery");
  await recovery.assertOriginalMcpColdComponentFixture(componentFixture);
  if (preparations.has(componentFixture)) fail("INSTALLED_TODO_ASSIGNMENT_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    join(componentFixture.root, ".pkm-next-original-mcp.json")])
    await absent(path, "INSTALLED_TODO_ASSIGNMENT_PRESEAL_PREPARATION_REQUIRED");
  const boardWriter = await writer(legacyWriter), chatWriter = await writer(legacyChatStore);
  const boardSlug = "Team/AssignmentBoard", itemId = "original-installed-assignment-task", namespace = "0123456789abcdef";
  const boardPath = `notes/${boardSlug}.assets/pkm-todo-board.json`, notePath = `notes/${boardSlug}.md`;
  for (const member of [boardPath, notePath, ".pkm/state/api-chats", ".pkm/state/api-chat-history", ".pkm/state/agent-groups"])
    await absent(join(componentFixture.root, member), "INSTALLED_TODO_ASSIGNMENT_SEPARATE_SOURCE_REQUIRED");
  const store = require(boardWriter), { ApiChatStore } = require(chatWriter), mask = process.umask(0o077);
  let chatId;
  try {
    store.setStorePath(componentFixture.root); store.todoBoardCreate(boardSlug, "AssignmentBoard", "Team");
    store.noteWorkItemCommand(boardSlug, store.noteWorkItemsRead(boardSlug).digest, { action: "create", item: {
      id: itemId, title: "Keep exact original Chat assignment", goal: "Assign only a genuinely current original Chat",
      scope: "Disposable installed native assignment experiment", acceptance: ["Current signed/native binding and atomic canonical assignment"],
      state: "Planning", evidence: [],
    } }, { id: "user:local", role: "user" });
    store.noteWorkItemCommand(boardSlug, store.noteWorkItemsRead(boardSlug).digest,
      { action: "assign", id: itemId, ownerId: "external:copilot:historical-assignment-owner", reason: "Historical assignment; no current grant" },
      { id: "user:local", role: "user" });
    const chats = new ApiChatStore(join(componentFixture.root, ".pkm/state"), namespace), chat = chats.create();
    chat.title = "Original installed Todo assignment Chat";
    chat.messages.push({ id: randomUUID(), role: "user", content: "Ordinary retained original assignment fixture history.", status: "complete" });
    chats.save(chat); chatId = chat.id;
  } finally { process.umask(mask); }
  await writer(legacyWriter); await writer(legacyChatStore);
  const files = await originalFiles(componentFixture.root, boardPath, notePath);
  const value = Object.freeze({ kind: "pkm.installed-native-todo-assignment-fixture/v1", root: componentFixture.root,
    boardSlug, itemId, boardPath, notePath, namespace, chatId, chatUrl: `pkm://chats/${namespace}/${chatId}`, ownerId: `chat:${chatId}`,
    boardSha256: hash(files.find(file => file.path === boardPath).bytes), noteSha256: hash(files.find(file => file.path === notePath).bytes),
    legacyWriterSha256: legacyWriter.sha256, legacyChatWriterSha256: legacyChatStore.sha256 });
  const rootIdentity = await lstat(componentFixture.root, { bigint: true });
  const state = { value, componentFixture, files, rootIdentity: `${rootIdentity.dev}:${rootIdentity.ino}`, phase: "prepared" };
  preparations.set(componentFixture, state); preparations.set(value, state);
  return value;
}

export const installedNativeTodoAssignmentUiStages = Object.freeze([
  "native-todo-assignment-todo-source", "native-todo-assignment-chat-source",
  "native-todo-assignment-chat-deny", "native-todo-assignment-chat-bind", "native-todo-assignment-complete",
]);
export const installedNativeTodoAssignmentModelFixture = Object.freeze({
  vendor: "pkm-native-fixture", label: "Synthetic native protocol fixture", reply: "synthetic native streaming response",
  evidenceFile: "native-fixture-provider.json", toolCatalog: Object.freeze([
    Object.freeze({ name: "get_document", operation: "knowledge.document.get", approvalRequired: true }),
  ]),
});

async function identity(root, installed, component, host, payloadBuildId) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)))
    fail("INSTALLED_TODO_ASSIGNMENT_PRIVATE_DRIVER_REQUIRED");
  const first = JSON.parse(await readFile(join(root, "native-identity-first.json"), "utf8"));
  const proof = JSON.parse(await readFile(join(root, "native-identity-passed.json"), "utf8"));
  const member = typeof first.result?.path === "string" ? relative(root, first.result.path) : "";
  if (!member || member === ".." || member.startsWith(`..${sep}`) || isAbsolute(member)
    || await realpath(first.result.path) !== first.result.path) fail("INSTALLED_TODO_ASSIGNMENT_ENROLLED_PROFILE_REQUIRED");
  const api = await load(installed, "original-mcp-native-identity");
  api.verifyOriginalMcpNativeIdentity(JSON.parse(first.publicRecord), first.result.sha256, first.result.profileSha256);
  assert.equal(await readFile(first.result.path, "utf8"), first.publicRecord);
  assert.equal(proof.passed, true); assert.equal(proof.realInstalledExtension, true);
  assert.equal(proof.identitySha256, first.result.sha256);
  const descriptor = JSON.parse(await readFile(component.attachmentDescriptorPath, "utf8"));
  assert.equal(hash(await readFile(component.attachmentDescriptorPath)), component.attachmentDescriptorSha256);
  assert.equal(descriptor.identitySha256, first.result.sha256);
  for (const [field, expected] of Object.entries({ root: component.root, workspaceId: component.workspaceId,
    planSha256: component.custody.planSha256, profileSha256: first.result.profileSha256, payloadBuildId,
    hostEntrySha256: hash(await readFile(join(installed, "dist/extension.cjs"))) })) assert.equal(descriptor.binding[field], expected);
  assert.equal(host.receipt.profileSha256, first.result.profileSha256);
  assert.equal(component.custody.profileSha256, first.result.profileSha256, "The enrolled profile must precede custody, not be repinned.");
}
function content(response) {
  assert(!response.isError, JSON.stringify(response));
  assert(response.structuredContent && typeof response.structuredContent === "object", "The actual typed public envelope is required.");
  return response.structuredContent;
}

/** Uses actual source/model/Chat choices; no injectable policy, native session, manager principal, or approval result. */
export async function verifyInstalledNativeTodoAssignment({ root, installed, component, assignmentFixture,
  python, env, port, payloadBuildId, timeoutMs = 120000, signal }) {
  const state = stateFor(assignmentFixture);
  if (state.phase !== "prepared" || component?.fixture !== state.componentFixture || component?.root !== assignmentFixture.root)
    fail("INSTALLED_TODO_ASSIGNMENT_SAME_COLD_FIXTURE_REQUIRED");
  if (typeof component.sourcePolicies !== "function" || typeof component.invokeCanonical !== "function")
    fail("INSTALLED_TODO_ASSIGNMENT_COMPONENT_CANONICAL_REQUIRED");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    fail("INSTALLED_TODO_ASSIGNMENT_DRIVER_LIMITS_REQUIRED");
  const host = await component.complete();
  const hostApi = await load(installed, "original-mcp-native-host"), ownerApi = await load(installed, "root-owner");
  ownerApi.assertRootOwner(component.owner); hostApi.assertOriginalMcpNativeHost(host, component.storage);
  if (!host.nativeChat?.apiChat?.memory) fail("INSTALLED_TODO_ASSIGNMENT_GENUINE_NATIVE_CHAT_REQUIRED");
  host.nativeChat.assertCurrent();
  await identity(root, installed, component, host, payloadBuildId);
  for (const name of ["native-todo-assignment-ui-contract.json", "native-todo-assignment-ui-ready.json",
    "native-todo-assignment-ui-passed.json", "native-todo-assignment-passed.json"])
    await absent(join(root, name), "INSTALLED_TODO_ASSIGNMENT_EVIDENCE_REPLAY");
  const full = await component.owner.ensureFull(), lease = { ...component.owner.workspaceLease() };
  assert.equal(full.storage, component.storage);
  assert.equal(host.receipt.actorId, "mcp:external");
  const actor = Object.freeze({ id: host.receipt.actorId, canWrite: true });
  const policies = component.sourcePolicies(), sourcePolicy = await load(installed, "original-mcp-native-source-policy");
  for (const domain of ["todo", "chat"]) sourcePolicy.assertOriginalMcpNativeSourcePolicy(policies[domain], component.storage, host, domain);
  const domainState = await load(installed, "original-mcp-domain-state"), domains = await load(installed, "original-mcp-domains");
  const chatSource = await load(installed, "original-mcp-api-chat-source"), bindingApi = await load(installed, "original-mcp-api-chat-binding");
  const assignmentApi = await load(installed, "original-mcp-todo-assignment");
  assert.equal(domainState.readOriginalMcpDomain(component.root, "todo"), undefined, "Use a separate exact source selection for this leaf.");
  assert.equal(chatSource.originalMcpApiChatSourceActive(component.storage, host), false);
  const stageDirectory = join(component.fixture.directory, "installed-assignment-chat-source");
  await mkdir(stageDirectory, { mode: 0o700 });
  const plan = await chatSource.planOriginalMcpApiChatSource(component.storage, host, { stagingDirectory: stageDirectory,
    limits: { maxChats: 4, maxMessagesPerChat: 16, maxMessages: 32 } });
  assert.equal(plan.chats, 1);
  const catalogue = await host.nativeChat.models.catalogue(new AbortController().signal), fixture = installedNativeTodoAssignmentModelFixture;
  const model = catalogue.models.find(item => item.vendor === fixture.vendor && item.label === fixture.label);
  if (!model) fail("INSTALLED_TODO_ASSIGNMENT_EXACT_REGISTERED_PROVIDER_REQUIRED");
  const { originalNativeChatDigest } = await load(installed, "original-mcp-api-chat-contracts");
  const runId = randomUUID(), requests = Object.fromEntries(["deny", "bind"].map(phase => {
    const commandId = `installed-todo-assignment-${phase}-${runId}`, prompt = `Installed original Todo assignment ${phase}; plain bounded native response only.`;
    return [phase, { commandId, prompt, chatId: assignmentFixture.chatId, chatUrl: assignmentFixture.chatUrl,
      requestId: hash(JSON.stringify([component.workspaceId, commandId]).replace(",", ", ")),
      argumentsSha256: originalNativeChatDigest({ chatId: assignmentFixture.chatId, prompt, hardToolRoundLimit: 1 }) }];
  }));
  await writeFile(join(root, "native-todo-assignment-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-todo-assignment-ui/v1", runId, sourceRoot: component.root, workspaceId: component.workspaceId,
    profileSha256: component.custody.profileSha256, nativeEpoch: host.receipt.epoch, sourcePlanSha256: plan.planSha256,
    boardSha256: assignmentFixture.boardSha256, noteSha256: assignmentFixture.noteSha256, chatId: assignmentFixture.chatId,
    chatUrl: assignmentFixture.chatUrl, providerVendor: fixture.vendor, modelLabel: fixture.label, modelId: model.id, wireModelId: model.nativeModelId, requests,
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativeTodoAssignmentUi({ root, python, env, port, runId, timeoutMs });
  let runtime;
  state.phase = "verifying"; state.component = component;
  const check = () => { signal?.throwIfAborted(); if (ui.error) throw ui.error; };
  const progress = async stage => { check(); await writeFile(join(root, "progress.json"), JSON.stringify({ stage }), { mode: 0o600 }); };
  const provider = () => waitJson(join(root, fixture.evidenceFile), timeoutMs, check);
  const query = work => { const db = component.storage.connectNative(); try { return work(db); } finally { db.close(); } };
  const count = (db, table, where = "") => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
    ? Number(db.prepare(`SELECT count(*) AS n FROM ${table}${where}`).get().n) : 0;
  const effects = () => query(db => Object.fromEntries(["original_mcp_domain_workers", "original_api_chat_requests",
    "original_native_chat_executions", "original_native_chat_inferences", "original_native_chat_tools",
    "action_runtime_runs", "workflow_executor_runs", "runtime_process_records"].map(table => [table, count(db, table)])));
  const assignmentCount = () => query(db => ({ guards: count(db, "original_mcp_todo_assignments"),
    receipts: count(db, "receipts", " WHERE operation='todo.workitem.assign'"), pending: count(db, "pending_todo") }));
  const canonical = async (operation, arguments_) => content(await component.invokeCanonical(
    operation === "todo.workitem.assign" ? "legacy_capability_call" : "legacy_capability_read", {
      action: operation === "todo.workitem.assign" ? "call" : "read",
      args: { operation, version: 1, arguments: arguments_ },
    }));
  const assignment = digest => ({ board_slug: assignmentFixture.boardSlug, id: assignmentFixture.itemId,
    owner_id: assignmentFixture.ownerId, expected_digest: digest, reason: "Exact current original Chat under actual installed native authority" });
  const core = async (operation, arguments_, write = false) => {
    const response = await full.runtime.core.dispatch(write ? "capability_call" : "capability_read",
      { operation, version: 1, arguments: arguments_ }, actor);
    if (response.error) throw Object.assign(new Error(response.error.message), response.error);
    return response.result;
  };
  try {
    const ready = await waitJson(join(root, "native-todo-assignment-ui-ready.json"), timeoutMs, check);
    assert.equal(ready.runId, runId); assert.equal(ready.actualRenderer, true);
    await progress("native-todo-assignment-todo-source");
    const admitted = await domains.hydrateOriginalMcpTodo(component.storage, host, [assignmentFixture.boardSlug], policies.todo);
    await progress("native-todo-assignment-chat-source");
    await chatSource.admitOriginalMcpApiChatSource(component.storage, host, plan, policies.chat);
    const chatGrant = chatSource.readOriginalMcpApiChatSourceSession(component.storage, host);
    const board = (await canonical("todo.board.get", { board_slug: assignmentFixture.boardSlug })).result;
    assert.equal(board.digest, assignmentFixture.boardSha256);
    await assert.rejects(canonical("todo.workitem.assign", assignment(board.digest)), /CURRENT_BINDING|continuation|binding/i);
    assert.deepEqual(assignmentCount(), { guards: 0, receipts: 0, pending: 0 });
    const beforeProvider = await provider();
    runtime = await (await load(installed, "original-mcp-api-chat")).createOriginalMcpApiChatRuntime(component.owner, actor, host);
    const invoke = async (tool, args) => { check(); return content(await runtime.invoke(tool, args, signal)); };
    const send = async phase => {
      const request = requests[phase], submitted = await invoke("api_chat_send", {
        host_id: component.workspaceId, chat_id: request.chatId, prompt: request.prompt,
        command_id: request.commandId, hard_tool_round_limit: 1,
      });
      assert.equal(submitted.request_id, request.requestId);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const receipt = await invoke("api_chat_request_get", { host_id: component.workspaceId, request_id: submitted.request_id });
        if (!["queued", "running"].includes(receipt.status)) return receipt;
        await delay(50);
      }
      fail("INSTALLED_TODO_ASSIGNMENT_NATIVE_SEND_DID_NOT_SETTLE");
    };
    await progress("native-todo-assignment-chat-deny");
    const denied = await send("deny");
    assert.equal(denied.status, "failed");
    assert.equal((await provider()).nativeCalls, beforeProvider.nativeCalls);
    await assert.rejects(canonical("todo.workitem.assign", assignment(board.digest)), /CURRENT_BINDING|continuation|binding/i);
    assert.deepEqual(assignmentCount(), { guards: 0, receipts: 0, pending: 0 });
    assert.equal(query(db => count(db, "chat_sessions")), 0);
    await unchanged(state);
    await progress("native-todo-assignment-chat-bind");
    const bound = await send("bind");
    assert.equal(bound.status, "succeeded", bound.error);
    assert.equal(bound.result.chatId, assignmentFixture.chatId); assert.equal(bound.result.chatUrl, assignmentFixture.chatUrl);
    assert.equal(bound.result.reply.content, fixture.reply);
    assert.equal((await provider()).nativeCalls, beforeProvider.nativeCalls + 1);
    query(db => {
      assert.equal(db.prepare("SELECT count(*) AS n FROM original_native_chat_events WHERE type='tool-intent'").get().n, 0,
        "Catalogue availability is not actual native/Core tool execution.");
    });
    const target = await bindingApi.readOriginalMcpApiChatBinding(component.owner, host, actor, assignmentFixture.chatUrl);
    bindingApi.assertOriginalMcpApiChatBinding(target); await target.assertCurrent();
    assert.equal(target.coreSessionId, assignmentFixture.chatId); assert.equal(target.ownerId, assignmentFixture.ownerId);
    assert.equal(target.coreRevision, (await core("chat.session.get", { id: assignmentFixture.chatId })).revision);
    const beforeAssign = effects(), modelCalls = (await provider()).nativeCalls;
    assert.equal(beforeAssign.original_mcp_domain_workers, 0);
    const assigned = await canonical("todo.workitem.assign", assignment(board.digest));
    assert.equal(assigned.schema, "pkm.capability-result/v1"); assert.equal(assigned.operation, "todo.workitem.assign");
    assert.equal(assigned.result.item.ownerId, assignmentFixture.ownerId);
    assert.deepEqual(assignmentCount(), { guards: 1, receipts: 1, pending: 0 });
    await assert.rejects(canonical("todo.workitem.assign", assignment(board.digest)), /digest changed|changed|CONFLICT/i);
    assert.deepEqual(assignmentCount(), { guards: 1, receipts: 1, pending: 0 });
    assert.deepEqual(effects(), beforeAssign, "Assignment must not issue worker tokens, prompts, model requests, jobs or tool executions.");
    assert.equal((await provider()).nativeCalls, modelCalls);
    const readback = await canonical("todo.workitem.get", { board_slug: assignmentFixture.boardSlug, id: assignmentFixture.itemId });
    assert.equal(readback.result.item.ownerId, assignmentFixture.ownerId);
    assert.equal(readback.result.digest, assigned.result.digest);
    const stored = query(db => ({
      assignment: db.prepare("SELECT * FROM original_mcp_todo_assignments").get(),
      receipt: db.prepare("SELECT * FROM receipts WHERE operation='todo.workitem.assign'").get(),
      nativeBinding: db.prepare("SELECT * FROM original_api_chat_current_chats WHERE id=?").get(assignmentFixture.chatId),
      nativeResponse: db.prepare("SELECT * FROM original_api_chat_responses WHERE chat_id=?").get(assignmentFixture.chatId),
      nativeExecution: db.prepare("SELECT * FROM original_native_chat_executions WHERE request_id=?").get(bound.request_id),
      nativeRequest: db.prepare("SELECT * FROM original_api_chat_requests WHERE request_id=?").get(bound.request_id),
    }));
    const pins = JSON.parse(stored.assignment.guard_json), guard = pins.guard;
    assert.equal(guard.ownerId, assignmentFixture.ownerId); assert.equal(guard.chatUrl, assignmentFixture.chatUrl);
    assert.equal(guard.coreSessionId, assignmentFixture.chatId); assert.equal(guard.coreRevision, target.coreRevision);
    assert.equal(guard.nativeRequestId, bound.request_id); assert.equal(guard.nativeEpoch, host.receipt.epoch);
    assert.equal(guard.sourcePlanSha256, plan.planSha256); assert.equal(guard.chatSourceDecisionId, chatGrant.decisionId);
    assert.equal(guard.intentSha256, admitted.intentSha256); assert.deepEqual(guard.ownerLease, lease);
    assert.equal(guard.workerReceiptSha256, undefined);
    assert.equal(stored.assignment.after_sha256, assigned.result.digest);
    assert.equal(stored.receipt.actor_id, actor.id); assert.equal(stored.receipt.result, stored.assignment.result_json);
    const stale = await assignmentApi.prepareOriginalMcpTodoChatAssignment(component.owner, host, actor, {
      ...assignment(assigned.result.digest), operationId: randomUUID(),
    });
    // This is an actual same-actor Core lifecycle mutation in the private fixture, not a forged binding/approval.
    const archived = await core("chat.session.archive", { id: assignmentFixture.chatId, expectedRevision: target.coreRevision,
      operationId: randomUUID() }, true);
    assert(archived.archivedAt);
    await assert.rejects(component.storage.requestOriginalMcpTodoChatAssignment(stale), /CURRENT_BINDING|revision|binding|revok/i);
    await assert.rejects(canonical("todo.workitem.assign", assignment(assigned.result.digest)), /CURRENT_BINDING|revision|binding|revok/i);
    policies.revoke("chat");
    assert.equal(Atomics.load(new Int32Array(chatGrant.revocation), 0), 1);
    assert.equal(host.signal.aborted, false);
    await assert.rejects(canonical("todo.workitem.assign", assignment(assigned.result.digest)), /source|admission|SOURCE|binding/i);
    assert.deepEqual(assignmentCount(), { guards: 1, receipts: 1, pending: 0 });
    assert.equal((await provider()).nativeCalls, modelCalls);
    const nativePath = `.pkm-next-todo/${assignmentFixture.boardSlug}/pkm-todo-board.json`;
    const nativeBoard = await readFile(join(component.root, nativePath));
    assert.equal(hash(nativeBoard), assigned.result.digest);
    const originalItem = JSON.parse(state.files.find(file => file.path === assignmentFixture.boardPath).bytes.toString("utf8"))
      .items.find(item => item.id === assignmentFixture.itemId);
    const currentItem = JSON.parse(nativeBoard.toString("utf8")).items.find(item => item.id === assignmentFixture.itemId);
    assert.deepEqual(currentItem.history.slice(0, originalItem.history.length), originalItem.history);
    await unchanged(state);
    assert.equal((await component.owner.ensureFull()).runtime.core, full.runtime.core);
    assert.deepEqual(component.owner.workspaceLease(), lease);
    await progress("native-todo-assignment-complete");
    await ui.done;
    const proof = await waitJson(join(root, "native-todo-assignment-ui-passed.json"), timeoutMs, check);
    assert.equal(proof.runId, runId); assert.equal(proof.actualNativeUi, true);
    const evidence = Object.freeze({ schema: "pkm.installed-native-todo-assignment-evidence/v1", passed: true,
      scope: "disposable original Board/Chat; actual installed deterministic native LM and canonical atomic assignment",
      payloadBuildId, profileSha256: component.custody.profileSha256, custodyPlanSha256: component.custody.planSha256,
      nativeHostReceiptSha256: host.receipt.receiptSha256, nativeEpoch: host.receipt.epoch, sourcePlanSha256: plan.planSha256,
      domainIntentSha256: admitted.intentSha256, ownerId: assignmentFixture.ownerId, chatUrl: assignmentFixture.chatUrl,
      coreRevisionAtAssignment: target.coreRevision, nativeBindingRequestId: bound.request_id,
      assignmentOperationId: stored.receipt.operation_id, assignmentFingerprint: stored.receipt.fingerprint,
      nativeBoardSha256: assigned.result.digest, nativeUi: proof,
      deniedModelBindingNoAssignmentIntent: true, exactOriginalUuidAndUrlPreserved: true,
      actualCanonicalAtomicAssignment: true, repeatedStaleCasNoSecondIntent: true, noWorkerTokensOrAssignmentJobs: true,
      archiveAndStalePreparedTargetRefused: true, revokedActualChatSourceRefusedWithoutOrdinaryFallback: true,
      originalSourcesUnchanged: true, sameOwnerAndCachedCore: true, commercialProviderQualified: false,
      separateAssignmentModalQualified: false, full34TodoParityQualified: false, fullCutoverQualified: false,
      b1PreservationVerified: false, b0RestorationVerified: false, actualProfileOrKeyringQualified: false });
    await writeFile(join(root, "native-todo-assignment-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
    state.phase = "verified"; state.evidence = evidence; state.stored = stored; state.nativeBoard = nativeBoard;
    state.archived = archived; state.nativePath = nativePath;
    return evidence;
  } finally {
    try { await runtime?.close(); } finally { await ui.stop(); }
  }
}

/** Parent owns real editor exit, closed owner, typed B1 retirement and disjoint B0 restore before this check. */
export async function verifyInstalledNativeTodoAssignmentRestored(assignmentFixture, { restoredRoot, archive }) {
  const state = stateFor(assignmentFixture);
  if (state.phase !== "verified") fail("INSTALLED_TODO_ASSIGNMENT_VERIFIED_EFFECT_REQUIRED");
  assert.throws(() => state.component.owner.assertWorkspaceLease());
  if (restoredRoot !== join(state.componentFixture.directory, "restored-b0") || typeof archive !== "string"
    || !/^\.pkm-next-component-retired-[a-f0-9-]{36}$/.test(relative(assignmentFixture.root, archive))
    || await realpath(restoredRoot) !== restoredRoot || await realpath(archive) !== archive)
    fail("INSTALLED_TODO_ASSIGNMENT_ACTUAL_RESTORE_REQUIRED");
  const originalRoot = await lstat(assignmentFixture.root, { bigint: true }), freshRoot = await lstat(restoredRoot, { bigint: true });
  assert.equal(`${originalRoot.dev}:${originalRoot.ino}`, state.rootIdentity);
  assert.notEqual(`${freshRoot.dev}:${freshRoot.ino}`, state.rootIdentity);
  const retirementBytes = await readFile(join(state.componentFixture.directory, "retirement-complete.json"));
  const retirement = JSON.parse(retirementBytes.toString("utf8"));
  const restored = JSON.parse(await readFile(join(state.componentFixture.directory, "b0-restored.json"), "utf8"));
  assert.equal(retirement.schema, "pkm.original-mcp-component-retirement/v1");
  assert.equal(retirement.root, assignmentFixture.root); assert.equal(retirement.archive, archive); assert.equal(retirement.enginesStopped, true);
  assert.equal(restored.schema, "pkm.original-mcp-component-b0-restored/v1");
  assert.equal(restored.root, restoredRoot); assert.equal(restored.originalRoot, assignmentFixture.root);
  assert.equal(restored.retirementSha256, hash(retirementBytes)); assert.equal(restored.originalRootOverwritten, false);
  assert.equal(restored.b0Sha256, retirement.b0Sha256); assert.equal(restored.b1Sha256, retirement.b1Sha256);
  const b0 = await readFile(join(state.componentFixture.directory, "b0/manifest.json"));
  assert.equal(hash(b0), restored.b0Sha256);
  let b1;
  for (const name of (await readdir(state.componentFixture.directory)).filter(name => /^b1-[a-f0-9-]{36}$/.test(name))) {
    const bytes = await readFile(join(state.componentFixture.directory, name, "manifest.json"));
    if (hash(bytes) === restored.b1Sha256) b1 = JSON.parse(bytes.toString("utf8"));
  }
  assert(b1);
  for (const file of state.files) {
    assert.equal(JSON.parse(b0.toString("utf8")).rows.find(row => row.path === file.path)?.sha256, hash(file.bytes));
    assert.equal(b1.rows.find(row => row.path === file.path)?.sha256, hash(file.bytes));
  }
  await unchanged(state, restoredRoot); await unchanged(state, archive);
  await absent(join(restoredRoot, "core.sqlite"), "INSTALLED_TODO_ASSIGNMENT_B0_NATIVE_STATE");
  await absent(join(restoredRoot, ".pkm-next-todo"), "INSTALLED_TODO_ASSIGNMENT_B0_NATIVE_STATE");
  assert.deepEqual(await readFile(join(archive, state.nativePath)), state.nativeBoard);
  assert.equal(b1.rows.find(row => row.path === state.nativePath)?.sha256, state.evidence.nativeBoardSha256);
  assert.equal(b1.rows.find(row => row.path === "core.sqlite")?.sha256, hash(await readFile(join(archive, "core.sqlite"))));
  const db = new DatabaseSync(join(archive, "core.sqlite"), { readOnly: true });
  try {
    assert.equal(Object.values(db.prepare("PRAGMA integrity_check").get())[0], "ok");
    assert.deepEqual(db.prepare("SELECT * FROM original_mcp_todo_assignments WHERE operation_id=?").get(state.evidence.assignmentOperationId), state.stored.assignment);
    assert.deepEqual(db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(state.evidence.assignmentOperationId), state.stored.receipt);
    assert.deepEqual(db.prepare("SELECT * FROM original_api_chat_current_chats WHERE id=?").get(assignmentFixture.chatId), state.stored.nativeBinding);
    assert.deepEqual(db.prepare("SELECT * FROM original_api_chat_responses WHERE chat_id=?").get(assignmentFixture.chatId), state.stored.nativeResponse);
    assert.deepEqual(db.prepare("SELECT * FROM original_native_chat_executions WHERE request_id=?").get(state.evidence.nativeBindingRequestId), state.stored.nativeExecution);
    assert.deepEqual(db.prepare("SELECT * FROM original_api_chat_requests WHERE request_id=?").get(state.evidence.nativeBindingRequestId), state.stored.nativeRequest);
    assert.equal(db.prepare("SELECT count(*) AS n FROM original_native_chat_inferences WHERE request_id=? AND authorized=1")
      .get(state.evidence.nativeBindingRequestId).n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM original_native_chat_events WHERE type='tool-intent'").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM original_mcp_todo_assignments").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM original_mcp_domain_workers").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM pending_todo").get().n, 0);
    const target = JSON.parse(db.prepare("SELECT record FROM chat_sessions WHERE actor_id='mcp:external' AND id=?").get(assignmentFixture.chatId).record);
    assert.equal(target.id, assignmentFixture.chatId); assert.equal(target.revision, state.archived.revision); assert(target.archivedAt);
  } finally { db.close(); }
  state.phase = "restored";
  return { originalBoardAndChatB0Restored: true, canonicalAssignmentGuardReceiptAndNativeBindingB1Preserved: true,
    noNativeStateInheritedByB0: true, freshDisjointB0: true, originalRootNotOverwritten: true,
    full34TodoParityQualified: false, fullCutoverQualified: false };
}
