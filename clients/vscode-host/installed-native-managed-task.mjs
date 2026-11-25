import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { installedNativeManagedTaskVendor, installedNativeManagedTaskModelLabel, installedNativeManagedTaskMarkers,
  installedNativeManagedTaskReply, installedNativeManagedTaskProposals } from "./installed-native-managed-task-provider.mjs";
import { startInstalledNativeManagedTaskUi } from "./installed-native-managed-task-ui.mjs";

const require = createRequire(import.meta.url), preparations = new WeakMap();
export { enrolled as assertInstalledManagedTaskEnrollment, snapshotTables as snapshotInstalledManagedTaskTables };
const hash = value => createHash("sha256").update(value).digest("hex");
const load = (installed, name) => import(pathToFileURL(join(installed, "next-runtime/server/dist", `${name}.js`)).href);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value) {
  const state = preparations.get(value);
  if (!state) fail("INSTALLED_MANAGED_TASK_ACTUAL_PREPARATION_REQUIRED");
  return state;
}
async function absent(path, code) {
  try { await lstat(path); fail(code); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function writer(value) {
  if (!value || !isAbsolute(value.path ?? "") || resolve(value.path) !== value.path || !/^[a-f0-9]{64}$/.test(value.sha256))
    fail("INSTALLED_MANAGED_TASK_PINNED_WRITER_REQUIRED");
  const stat = await lstat(value.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8388608
    || await realpath(value.path) !== value.path || hash(await readFile(value.path)) !== value.sha256)
    fail("INSTALLED_MANAGED_TASK_PINNED_WRITER_REQUIRED");
  return value.path;
}
const originalDirectories = [".pkm/state/api-chats", ".pkm/state/api-chat-history", ".pkm/state/agent-groups"];
async function originalFiles(root) {
  const files = []; let bytes = 0;
  async function visit(member) {
    const path = join(root, member), stat = await lstat(path);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077)
      fail("INSTALLED_MANAGED_TASK_PRIVATE_SOURCE_REQUIRED");
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(`${member}/${name}`);
    else {
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16777216 || files.length >= 4096 || (bytes += stat.size) > 33554432)
        fail("INSTALLED_MANAGED_TASK_SOURCE_LIMIT");
      files.push({ path: member, bytes: await readFile(path) });
    }
  }
  for (const member of originalDirectories) {
    try { await visit(member); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return files;
}
async function unchanged(state, root = state.value.root) {
  const actual = await originalFiles(root);
  assert.deepEqual(actual.map(file => file.path), state.files.map(file => file.path), "Native Task execution added or removed original Chat bytes.");
  for (const [index, file] of actual.entries()) assert.deepEqual(file.bytes, state.files[index].bytes);
}
async function waitJson(path, timeoutMs, check = () => {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    check();
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.failed) throw new Error(`Managed Task renderer failed: ${value.error}`);
      return value;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await delay(25);
  }
  throw new Error(`Managed Task evidence timed out: ${path}`);
}

/** Separate disposable component, before B0/custody. Never creates an original managed Session. */
export async function prepareInstalledNativeManagedTaskFixture({ installed, componentFixture, legacyChatStore }) {
  await (await load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (preparations.has(componentFixture)) fail("INSTALLED_MANAGED_TASK_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    join(componentFixture.root, ".pkm-next-original-mcp.json")]) await absent(path, "INSTALLED_MANAGED_TASK_PRESEAL_REQUIRED");
  const path = await writer(legacyChatStore);
  for (const member of originalDirectories) await absent(join(componentFixture.root, member), "INSTALLED_MANAGED_TASK_SEPARATE_SOURCE_REQUIRED");
  const { ApiChatStore } = require(path), namespace = "0123456789abcdef", mask = process.umask(0o077);
  let originalChatId;
  try {
    const store = new ApiChatStore(join(componentFixture.root, ".pkm/state"), namespace), chat = store.create();
    chat.title = "Original ordinary Chat, never managed Task authority";
    chat.messages.push({ id: randomUUID(), role: "user", content: "Ordinary original source; no native managed Session.", status: "complete" });
    store.save(chat); originalChatId = chat.id;
  } finally { process.umask(mask); }
  await writer(legacyChatStore);
  const files = await originalFiles(componentFixture.root), identity = await lstat(componentFixture.root, { bigint: true });
  const value = Object.freeze({ kind: "pkm.installed-native-managed-task-fixture/v1", root: componentFixture.root,
    namespace, originalChatId, originalChatUrl: `pkm://chats/${namespace}/${originalChatId}`, legacyChatWriterSha256: legacyChatStore.sha256,
    sourceFiles: Object.freeze(files.map(file => Object.freeze({ path: file.path, sha256: hash(file.bytes) }))) });
  const state = { value, componentFixture, files, phase: "prepared", rootIdentity: `${identity.dev}:${identity.ino}` };
  preparations.set(value, state); preparations.set(componentFixture, state); return value;
}
export const installedNativeManagedTaskModelFixture = Object.freeze({
  vendor: installedNativeManagedTaskVendor, label: installedNativeManagedTaskModelLabel,
  evidenceFile: "native-managed-task-provider.json", toolCatalog: Object.freeze([
    Object.freeze({ name: "get_document", operation: "knowledge.document.get", approvalRequired: true }),
  ]),
});
export function installedNativeManagedTaskProviderOptions(fixture, root) {
  stateFor(fixture);
  return Object.freeze({ evidencePath: join(root, installedNativeManagedTaskModelFixture.evidenceFile),
    expectedToolText: "Approved genuine cold Note mutation." });
}
export const installedNativeManagedTaskUiStages = Object.freeze([
  "native-managed-task-chat-source", "native-managed-task-archive-refuse", "native-managed-task-create-main",
  "native-managed-task-start-deny", "native-managed-task-start-plain", "native-managed-task-followup",
  "native-managed-task-followup-replay",
  "native-managed-task-create-cancel", "native-managed-task-run-cancel", "native-managed-task-cancel-owned",
  "native-managed-task-create-stale", "native-managed-task-stale-pending", "native-managed-task-source-revoke", "native-managed-task-complete",
]);
const tables = ["managed_chat_tasks", "managed_chat_task_attempts", "managed_chat_task_harness",
  "original_api_chat_current_chats", "original_api_chat_requests", "original_api_chat_request_state", "original_api_chat_responses",
  "original_native_chat_executions", "original_native_chat_inferences", "original_native_chat_text", "original_native_chat_events",
  "approval_bridge_runs", "approval_bridge_bindings", "execution_records", "receipts", "chat_sessions", "chat_session_messages"];
function snapshotTables(db) {
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
}
async function enrolled(root, installed, component, host, payloadBuildId) {
  const first = JSON.parse(await readFile(join(root, "native-identity-first.json"), "utf8"));
  const proof = JSON.parse(await readFile(join(root, "native-identity-passed.json"), "utf8"));
  const member = typeof first.result?.path === "string" ? relative(root, first.result.path) : "";
  if (!member || member === ".." || member.startsWith(`..${sep}`) || isAbsolute(member)
    || await realpath(first.result.path) !== first.result.path) fail("INSTALLED_MANAGED_TASK_ENROLLED_IDENTITY_REQUIRED");
  assert.equal(await readFile(first.result.path, "utf8"), first.publicRecord);
  (await load(installed, "original-mcp-native-identity")).verifyOriginalMcpNativeIdentity(
    JSON.parse(first.publicRecord), first.result.sha256, first.result.profileSha256);
  assert.equal(proof.passed, true); assert.equal(proof.realInstalledExtension, true);
  assert.equal(proof.identitySha256, first.result.sha256);
  assert.equal(component.custody.profileSha256, first.result.profileSha256, "The enrolled profile must precede custody; no resealing.");
  const descriptor = JSON.parse(await readFile(component.attachmentDescriptorPath, "utf8"));
  assert.equal(hash(await readFile(component.attachmentDescriptorPath)), component.attachmentDescriptorSha256);
  assert.equal(descriptor.identitySha256, first.result.sha256);
  for (const [key, expected] of Object.entries({ root: component.root, workspaceId: component.workspaceId,
    planSha256: component.custody.planSha256, profileSha256: first.result.profileSha256, payloadBuildId,
    hostEntrySha256: hash(await readFile(join(installed, "dist/extension.cjs"))) })) assert.equal(descriptor.binding[key], expected);
  assert.equal(host.receipt.epoch, host.nativeChat.session.activationId);
  assert.equal(host.nativeChat.session.identitySha256, first.result.sha256);
}

/** Actual installed/source/native LM/Core path only. No injected native session, policy or success callback is accepted. */
export async function verifyInstalledNativeManagedTask({ root, installed, component, taskFixture, payloadBuildId,
  python, env, port, timeoutMs = 120000, signal }) {
  const state = stateFor(taskFixture);
  if (state.phase !== "prepared" || component?.fixture !== state.componentFixture || component?.root !== taskFixture.root)
    fail("INSTALLED_MANAGED_TASK_SAME_COLD_FIXTURE_REQUIRED");
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    fail("INSTALLED_MANAGED_TASK_PRIVATE_DRIVER_REQUIRED");
  const recovery = await load(installed, "original-mcp-component-recovery");
  await recovery.assertOriginalMcpColdComponentFixture(component.fixture);
  const host = await component.complete(), full = await component.owner.ensureFull();
  (await load(installed, "root-owner")).assertRootOwner(component.owner);
  (await load(installed, "original-mcp-native-host")).assertOriginalMcpNativeHost(host, component.storage);
  const rpc = await load(installed, "original-mcp-native-chat-rpc");
  if (!host.nativeChat?.apiChat || !rpc.originalMcpNativeChatSupportedMethods(host.nativeChat.session).includes("execution.task.run"))
    fail("INSTALLED_MANAGED_TASK_COMPOSED_NATIVE_METHOD_REQUIRED");
  rpc.assertOriginalMcpNativeChatRpcPort(host.nativeChat);
  await enrolled(root, installed, component, host, payloadBuildId);
  assert.equal(full.storage, component.storage);
  assert.equal(host.options.providerTransport.supports("openai-compatible"), false);
  assert.equal(host.options.providerTransport.supports("azure-openai"), false);
  const actor = Object.freeze({ id: host.receipt.actorId, canWrite: true }), lease = { ...component.owner.workspaceLease() };
  assert.equal(actor.id, "mcp:external");
  const query = work => { const db = component.storage.connectNative(); try { return work(db); } finally { db.close(); } };
  assert.equal(query(db => db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n), 0);
  const source = await load(installed, "original-mcp-api-chat-source"), policies = component.sourcePolicies();
  (await load(installed, "original-mcp-native-source-policy")).assertOriginalMcpNativeSourcePolicy(policies.chat, component.storage, host, "chat");
  assert.equal(source.originalMcpApiChatSourceActive(component.storage, host), false);
  const stagingDirectory = join(component.fixture.directory, "installed-managed-task-chat-source");
  await mkdir(stagingDirectory, { mode: 0o700 });
  const plan = await source.planOriginalMcpApiChatSource(component.storage, host,
    { stagingDirectory, limits: { maxChats: 4, maxMessagesPerChat: 16, maxMessages: 32 } });
  assert.equal(plan.chats, 1);
  const catalogue = await host.nativeChat.models.catalogue(new AbortController().signal);
  const model = catalogue.models.find(item => item.vendor === installedNativeManagedTaskVendor && item.label === installedNativeManagedTaskModelLabel);
  if (!model) fail("INSTALLED_MANAGED_TASK_REAL_REGISTERED_PROVIDER_REQUIRED");
  const { originalNativeChatDigest } = await load(installed, "original-mcp-api-chat-contracts");
  const execution = await load(installed, "original-mcp-api-chat-execution");
  const runId = randomUUID(), requestId = commandId => hash(JSON.stringify([component.workspaceId, commandId]).replace(",", ", "));
  const creations = Object.fromEntries(["main", "cancel", "stale"].map(name => {
    const commandId = `installed-managed-task-create-${name}-${runId}`;
    return [name, { commandId, requestId: requestId(commandId), title: `Installed native managed Task ${name}` }];
  }));
  for (const name of ["native-managed-task-ui-contract.json", "native-managed-task-ui-ready.json",
    "native-managed-task-ui-passed.json", "native-managed-task-passed.json"]) await absent(join(root, name), "INSTALLED_MANAGED_TASK_EVIDENCE_REPLAY");
  await writeFile(join(root, "native-managed-task-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-managed-task-ui/v1", runId, sourceRoot: component.root, workspaceId: component.workspaceId,
    profileSha256: component.custody.profileSha256, nativeEpoch: host.receipt.epoch, sourcePlanSha256: plan.planSha256,
    providerVendor: installedNativeManagedTaskVendor, modelLabel: model.label, modelId: model.id, wireModelId: model.nativeModelId,
    creations, stages: installedNativeManagedTaskUiStages,
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativeManagedTaskUi({ root, python, env, port, runId, timeoutMs }), abort = new AbortController();
  void ui.done.catch(error => abort.abort(error));
  const check = () => { signal?.throwIfAborted(); if (ui.error) throw ui.error; };
  const progress = async stage => { check(); await writeFile(join(root, "progress.json"), JSON.stringify({ stage }), { mode: 0o600 }); };
  const provider = () => waitJson(join(root, installedNativeManagedTaskModelFixture.evidenceFile), timeoutMs, check);
  const core = async (operation, arguments_, write = false) => {
    check();
    const reply = await full.runtime.core.dispatch(write ? "capability_call" : "capability_read", { operation, version: 1, arguments: arguments_ }, actor);
    if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.result;
  };
  let runtime;
  state.phase = "verifying"; state.component = component;
  try {
    await waitJson(join(root, "native-managed-task-ui-ready.json"), timeoutMs, check);
    await progress("native-managed-task-chat-source");
    await source.admitOriginalMcpApiChatSource(component.storage, host, plan, policies.chat);
    const sourceGrant = source.readOriginalMcpApiChatSourceSession(component.storage, host);
    assert.equal(Atomics.load(new Int32Array(sourceGrant.revocation), 0), 0);
    runtime = await (await load(installed, "original-mcp-api-chat")).createOriginalMcpApiChatRuntime(component.owner, actor, host);
    const invoke = async (tool, args) => {
      check(); const reply = await runtime.invoke(tool, args, AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]));
      assert(!reply.isError && reply.structuredContent, JSON.stringify(reply)); return reply.structuredContent;
    };
    const settle = async submitted => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const receipt = await invoke("api_chat_request_get", { host_id: component.workspaceId, request_id: submitted.request_id });
        if (!["queued", "running"].includes(receipt.status)) return receipt;
        await delay(25);
      }
      throw new Error(`Managed Task request did not settle: ${submitted.request_id}`);
    };
    const getChat = async chatId => {
      const receipt = await settle(await invoke("api_chat_get", { host_id: component.workspaceId, chat_id: chatId }));
      assert.equal(receipt.status, "succeeded", receipt.error); return receipt.result;
    };
    const created = {};
    const create = async name => {
      await progress(`native-managed-task-create-${name}`);
      const q = creations[name], receipt = await settle(await invoke("api_chat_create", {
        host_id: component.workspaceId, title: q.title, command_id: q.commandId, model_id: "",
      }));
      assert.equal(receipt.status, "succeeded", receipt.error);
      assert.notEqual(receipt.result.chatId, taskFixture.originalChatId);
      assert.equal(receipt.result.chatUrl, `pkm://chats/${hash(component.root).slice(0, 16)}/${receipt.result.chatId}`);
      assert.equal(receipt.result.sessionId, null); created[name] = receipt.result; return receipt.result;
    };
    const requests = {};
    const describe = async (name, chat, followup = false) => {
      const commandId = `installed-managed-task-${name}-${runId}`;
      const prompt = `${followup ? "继续刚才同一个任务。" : "Start a new task:"} ${installedNativeManagedTaskMarkers[name]}: read the exact fixture Note and preserve every original requirement.`;
      const q = { name, commandId, requestId: requestId(commandId), chatId: chat.chatId, chatUrl: chat.chatUrl, prompt, hardToolRoundLimit: 5 };
      q.argumentsSha256 = originalNativeChatDigest({ chatId: q.chatId, prompt, hardToolRoundLimit: 5 });
      requests[name] = q;
      await writeFile(join(root, `native-managed-task-request-${name}.json`), JSON.stringify(q), { mode: 0o600, flag: "wx" }); return q;
    };
    const submit = q => invoke("api_chat_send", { host_id: component.workspaceId, chat_id: q.chatId,
      prompt: q.prompt, command_id: q.commandId, hard_tool_round_limit: 5 });
    const publishBinding = async q => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        check();
        const row = query(db => {
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_native_chat_executions'").get()) return undefined;
          return db.prepare("SELECT plan,plan_sha256 FROM original_native_chat_executions WHERE request_id=?").get(q.requestId);
        });
        if (row) {
          const actual = JSON.parse(row.plan);
          assert.equal(originalNativeChatDigest(actual), row.plan_sha256);
          assert.equal(actual.managedTask.chatId, q.chatId);
          const task = query(db => db.prepare("SELECT * FROM managed_chat_tasks WHERE task_id=?").get(actual.managedTask.taskId));
          assert.equal(task.actor_id, actor.id); assert.equal(task.native_epoch, host.receipt.epoch);
          assert.equal(task.owner_id, lease.ownerId); assert.equal(task.owner_fence, lease.fence);
          const text = actual.messages.find(message => message.content.startsWith("Current native Task binding (not permissions or a Task completion certificate).")).content;
          const goal = JSON.parse(text.split("User work objective (not a permission grant or a managed Task completion certificate):\n")[1].split("\n")[0]);
          const binding = { managedTask: actual.managedTask, planSha256: row.plan_sha256, chatRevision: task.chat_revision,
            tools: actual.tools.map(tool => tool.name), goal, proposals: installedNativeManagedTaskProposals(actual.managedTask, goal) };
          await writeFile(join(root, `native-managed-task-binding-${q.name}.json`), JSON.stringify(binding), { mode: 0o600, flag: "wx" });
          return binding;
        }
        await delay(25);
      }
      throw new Error("No actual durable Task/native execution binding appeared.");
    };
    assert.equal((await provider()).nativeCalls, 0);
    const archive = await describe("archive", { chatId: taskFixture.originalChatId, chatUrl: taskFixture.originalChatUrl });
    await progress("native-managed-task-archive-refuse");
    const archived = await settle(await submit(archive)); assert.equal(archived.status, "failed");
    assert.match(archived.error, /fresh native-created|MANAGED_GOAL_COMPOSITION_REQUIRED/);
    await create("main");
    const deny = await describe("deny", created.main); await progress("native-managed-task-start-deny");
    const denied = await settle(await submit(deny)); assert.equal(denied.status, "failed");
    assert.equal(query(db => db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n), 0);
    assert.equal((await provider()).nativeCalls, 0);
    const plain = await describe("plain", created.main); await progress("native-managed-task-start-plain");
    const plainSubmitted = await submit(plain); await publishBinding(plain);
    const plainReceipt = await settle(plainSubmitted); assert.equal(plainReceipt.status, "outcome_unknown");
    const plainState = await getChat(plain.chatId);
    assert.equal(plainState.managedTask.goal.status, "interrupted");
    assert.equal(plainState.managedTask.taskCompletion, "not-claimed");
    assert.equal(execution.readOriginalMcpNativeExecution(component.storage, host, plain.requestId).status, "failed");
    assert.equal((await provider()).nativeCalls, 2);
    const followup = await describe("followup", created.main, true); await progress("native-managed-task-followup");
    assert.match(followup.prompt, /^继续刚才同一个任务。/);
    const followupSubmitted = await submit(followup); const followupBinding = await publishBinding(followup);
    const finished = await settle(followupSubmitted); assert.equal(finished.status, "succeeded", finished.error);
    assert.equal(finished.result.reply.content, installedNativeManagedTaskReply);
    const managed = finished.result.managedTask;
    assert.equal(managed.taskId, plainState.managedTask.taskId); assert.equal(managed.goal.id, plainState.managedTask.goal.id);
    assert.equal(managed.goal.objective, plain.prompt); assert.equal(managed.goal.status, "resolved");
    assert.equal(managed.status, "active"); assert.equal(managed.taskCompletion, "not-claimed"); assert.equal(managed.sourceInputIds.length, 2);
    assert.equal(managed.harnessReports.length, 3); assert.equal(finished.result.sessionAuthority, "native_core");
    const originalValidation = managed.harnessReports.filter(report => report.kind === "validation");
    assert.deepEqual(originalValidation.map(report => report.status), ["start", "complete"]);
    assert.equal(originalValidation[0].sourceInputDigest, originalValidation[1].sourceInputDigest);
    assert.deepEqual(originalValidation[1].sourceInputIds, managed.sourceInputIds);
    await progress("native-managed-task-followup-replay");
    assert.equal((await submit(followup)).request_id, followup.requestId);
    assert.equal((await provider()).nativeCalls, 8, "An idempotent send must not rerun inference.");
    const successful = execution.readOriginalMcpNativeExecution(component.storage, host, followup.requestId);
    assert.equal(successful.status, "complete"); assert.equal(successful.context.roundCount, 6);
    assert.equal(successful.toolRoundLimit.reached, true);
    assert.deepEqual(successful.tools.map(tool => tool.name), followupBinding.proposals.map(proposal => proposal.name));
    const transcript = await core("chat.session.messages", { id: plain.chatId, afterSequence: 0, limit: 100 });
    assert.equal(transcript.items.length, 4); assert.equal(transcript.items.at(-1).id, managed.attempt.replyId);
    assert(transcript.items.every(message => !message.id.startsWith("api-input:") && !message.id.startsWith("api-response:")));
    await create("cancel");
    const cancel = await describe("cancel", created.cancel); await progress("native-managed-task-run-cancel");
    const cancelSubmitted = await submit(cancel); await publishBinding(cancel);
    const until = Date.now() + timeoutMs;
    while (!(await provider()).requests.some(request => request.phase === "cancel" && request.pending)) {
      check(); assert(Date.now() < until, "The real registered provider never entered its cancellation wait."); await delay(25);
    }
    const cancelCommand = { commandId: `installed-managed-task-cancel-owned-${runId}` };
    cancelCommand.requestId = requestId(cancelCommand.commandId);
    await writeFile(join(root, "native-managed-task-cancel-command.json"), JSON.stringify({ ...cancelCommand, chatId: cancel.chatId,
      chatUrl: cancel.chatUrl, argumentsSha256: originalNativeChatDigest({ chatId: cancel.chatId }) }), { mode: 0o600, flag: "wx" });
    await progress("native-managed-task-cancel-owned");
    const cancellation = await settle(await invoke("api_chat_cancel", { host_id: component.workspaceId,
      chat_id: cancel.chatId, command_id: cancelCommand.commandId }));
    assert.equal(cancellation.status, "succeeded", cancellation.error); assert.equal(cancellation.result.cancellation.requested, true);
    const cancelled = await settle(cancelSubmitted);
    assert(["succeeded", "outcome_unknown"].includes(cancelled.status), JSON.stringify(cancelled));
    const cancelledTask = await getChat(cancel.chatId);
    assert.equal(cancelledTask.managedTask.goal.status, "paused");
    assert.equal(cancelledTask.managedTask.taskCompletion, "not-claimed");
    const cancellationDeadline = Date.now() + timeoutMs;
    while (!(await provider()).requests.some(request => request.phase === "cancel" && request.cancelled)) {
      check(); assert(Date.now() < cancellationDeadline, "The real provider cancellation token was not observed."); await delay(25);
    }
    const cancelledProvider = (await provider()).requests.find(request => request.phase === "cancel");
    assert.equal(cancelledProvider.cancelled, true); assert.equal(cancelledProvider.completed, false);
    await create("stale");
    const stale = await describe("stale", created.stale); await progress("native-managed-task-stale-pending");
    const staleSubmitted = await submit(stale); const staleBinding = await publishBinding(stale);
    await waitJson(join(root, "native-managed-task-stale-visible.json"), timeoutMs, check);
    const currentChat = await core("chat.session.get", { id: stale.chatId }), operationId = randomUUID(), messageId = randomUUID();
    const newer = await core("chat.session.append", { id: stale.chatId, expectedRevision: currentChat.revision, operationId,
      message: { id: messageId, role: "user", content: "Concurrent installed fixture operator input; preserve this newer canonical revision.", status: "complete" } }, true);
    assert.equal(currentChat.revision, staleBinding.chatRevision); assert.equal(newer.session.revision, currentChat.revision + 1);
    await writeFile(join(root, "native-managed-task-stale-committed.json"), JSON.stringify({
      committed: true, operationId, messageId, beforeRevision: currentChat.revision, afterRevision: newer.session.revision,
    }), { mode: 0o600, flag: "wx" });
    const staleReceipt = await settle(staleSubmitted); assert.equal(staleReceipt.status, "outcome_unknown");
    await waitJson(join(root, "native-managed-task-stale-clicked.json"), timeoutMs, check);
    assert.equal((await provider()).nativeCalls, 9, "A stale Chat reached the real provider.");
    assert.equal((await core("chat.session.messages", { id: stale.chatId, afterSequence: 0, limit: 100 })).items.at(-1).id, messageId);
    assert.equal(query(db => db.prepare("SELECT count(*) AS n FROM original_native_chat_inferences WHERE request_id=? AND authorized=1").get(stale.requestId).n), 0);
    assert.equal(query(db => db.prepare("SELECT count(*) AS n FROM original_native_chat_events WHERE request_id=? AND type='tool-intent'").get(cancel.requestId).n), 0);
    assert.equal(query(db => db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n), 3);
    assert.equal(query(db => db.prepare("SELECT count(*) AS n FROM managed_chat_task_attempts").get().n), 4);
    assert.equal(query(db => db.prepare("SELECT count(*) AS n FROM original_api_chat_current_chats WHERE id=?").get(taskFixture.originalChatId).n), 0);
    assert.deepEqual(component.owner.workspaceLease(), lease); assert.equal((await component.owner.ensureFull()).runtime.core, full.runtime.core);
    await unchanged(state);
    await progress("native-managed-task-source-revoke");
    await waitJson(join(root, "native-managed-task-source-revoke-visible.json"), timeoutMs, check);
    const before = query(snapshotTables);
    policies.revoke("chat");
    assert.equal(Atomics.load(new Int32Array(sourceGrant.revocation), 0), 1); assert.equal(host.signal.aborted, false);
    await assert.rejects(runtime.invoke("api_chat_send", { host_id: component.workspaceId, chat_id: plain.chatId,
      prompt: `${installedNativeManagedTaskMarkers.revoked}: no source authority.`, command_id: `revoked-${runId}` }));
    assert.deepEqual(query(snapshotTables), before, "Refused source work must not publish a command, goal or effect.");
    assert.equal((await provider()).nativeCalls, 9);
    assert.equal((await host.nativeChat.models.catalogue(new AbortController().signal)).source, "vscode.lm");
    await progress("native-managed-task-complete"); await ui.done;
    const uiProof = await waitJson(join(root, "native-managed-task-ui-passed.json"), timeoutMs, check);
    assert.equal(uiProof.actualRenderedDom, true); assert.equal(uiProof.sameStaleModalClickedAfterCommit, true);
    const evidence = { schema: "pkm.installed-native-managed-task-evidence/v1", passed: true,
      payloadBuildId, deterministicProvider: true, commercialProviderQualified: false, actualProfileOrKeyringQualified: false,
      fullCutoverQualified: false, humanTaskAcceptanceClaimed: false, b1PreservationVerified: false, b0RestorationVerified: false,
      profileSha256: component.custody.profileSha256, custodyPlanSha256: component.custody.planSha256,
      sourcePlanSha256: plan.planSha256, nativeHostReceiptSha256: host.receipt.receiptSha256, sameOwnerAndCachedCore: true,
      freshNativeChats: created, originalChatNeverPromoted: true, deniedNoDurableGoal: true, plainResponseNeverResolvedGoal: true,
      canonicalGoalId: managed.goal.id, canonicalTaskId: managed.taskId, actualHarnessAndCurrentToolEvidence: true,
      followupPreservedOriginalObjective: true, chineseSameGoalContinuation: true,
      commandReplayNoInference: true, actualProviderCancellationToken: true,
      lateApprovalStaleRevisionNoProvider: true, sourceRevocationNoNewRequestOrEffect: true,
      actualModelProviderCalls: 9, actualTaskCount: 3, actualAttemptCount: 4,
      taskCompletion: managed.taskCompletion, taskStatus: managed.status, goalStatus: managed.goal.status,
      replyId: managed.attempt.replyId, requests, actualNativeUi: uiProof };
    await writeFile(join(root, "native-managed-task-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
    state.phase = "verified"; state.evidence = evidence; state.stored = before;
    return evidence;
  } finally {
    abort.abort();
    try { await runtime?.close(); } finally { await ui.stop(); }
  }
}

/** Requires parent's actual editor exit, closed owner, typed B1 retirement and disjoint B0 restore first. */
export async function verifyInstalledNativeManagedTaskRestored(taskFixture, { restoredRoot, archive }) {
  const state = stateFor(taskFixture);
  if (state.phase !== "verified") fail("INSTALLED_MANAGED_TASK_VERIFIED_EFFECT_REQUIRED");
  assert.throws(() => state.component.owner.assertWorkspaceLease());
  if (restoredRoot !== join(state.componentFixture.directory, "restored-b0") || typeof archive !== "string"
    || !/^\.pkm-next-component-retired-[a-f0-9-]{36}$/.test(relative(taskFixture.root, archive))
    || await realpath(restoredRoot) !== restoredRoot || await realpath(archive) !== archive)
    fail("INSTALLED_MANAGED_TASK_ACTUAL_RESTORE_REQUIRED");
  const original = await lstat(taskFixture.root, { bigint: true }), fresh = await lstat(restoredRoot, { bigint: true });
  assert.equal(`${original.dev}:${original.ino}`, state.rootIdentity); assert.notEqual(`${fresh.dev}:${fresh.ino}`, state.rootIdentity);
  const retirementBytes = await readFile(join(state.componentFixture.directory, "retirement-complete.json"));
  const retirement = JSON.parse(retirementBytes), restored = JSON.parse(await readFile(join(state.componentFixture.directory, "b0-restored.json")));
  assert.equal(retirement.schema, "pkm.original-mcp-component-retirement/v1");
  assert.equal(retirement.root, taskFixture.root); assert.equal(retirement.archive, archive); assert.equal(retirement.enginesStopped, true);
  assert.equal(restored.schema, "pkm.original-mcp-component-b0-restored/v1");
  assert.equal(restored.root, restoredRoot); assert.equal(restored.originalRoot, taskFixture.root); assert.equal(restored.originalRootOverwritten, false);
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
  for (const file of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-original-mcp.json"])
    await absent(join(restoredRoot, file), "INSTALLED_MANAGED_TASK_B0_NATIVE_STATE");
  assert.equal(b1.rows.find(row => row.path === "core.sqlite")?.sha256, hash(await readFile(join(archive, "core.sqlite"))));
  const db = new DatabaseSync(join(archive, "core.sqlite"), { readOnly: true });
  try {
    assert.equal(Object.values(db.prepare("PRAGMA integrity_check").get())[0], "ok");
    assert.deepEqual(snapshotTables(db), state.stored, "B1 must preserve actual canonical Task/Harness/native receipts, not only inventory.");
  } finally { db.close(); }
  state.phase = "restored";
  return { originalChatB0BytesRestored: true, canonicalTaskGoalHarnessAndNativeReceiptsB1Preserved: true,
    noNativeStateInheritedByB0: true, freshDisjointB0: true, originalRootNotOverwritten: true,
    humanTaskAcceptanceClaimed: false, fullCutoverQualified: false };
}
