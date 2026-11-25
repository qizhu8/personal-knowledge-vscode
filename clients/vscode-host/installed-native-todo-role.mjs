import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startInstalledNativeTodoRoleObserver } from "./installed-native-todo-role-ui.mjs";
import { pinnedOriginalKnowledgeWriterFixture } from "../../tests/original-knowledge-writer-fixture.mjs";
import { installedKnowledgeMoveFixtureUtilities as u, assertInstalledKnowledgeMoveComponentBinding,
  readInstalledKnowledgeMoveRetirementReceipt, readInstalledKnowledgeMoveRestoredReceipt } from "./installed-native-knowledge-move.mjs";

const states = new WeakMap();
export const installedNativeTodoRoleStages = Object.freeze([
  "native-todo-role-todo-source", "native-todo-role-chat-source",
  "native-todo-role-worker-bind", "native-todo-role-reviewer-bind",
  "native-todo-role-worker-deny", "native-todo-role-worker-grant", "native-todo-role-worker-run",
  "native-todo-role-reviewer-grant", "native-todo-role-reviewer-run",
  "native-todo-role-human-deny", "native-todo-role-human-accept",
]);
export const installedNativeTodoRoleModelContract = Object.freeze({
  provider: "actual-native-vscode", fixtureModelsForbidden: true, boundedOrHttpFallbackForbidden: true,
  workerTools: Object.freeze(["get_workitem", "claim_workitem", "submit_workitem_result"]),
  reviewerTools: Object.freeze(["get_workitem", "add_workitem_comment"]),
  human: "Real independent default-Deny native modal and typed human reason; no helper-generated decision",
});
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value, phase) {
  const state = states.get(value);
  if (!state || state.phase !== phase) fail("INSTALLED_TODO_ROLE_ACTUAL_PHASE_REQUIRED");
  return state;
}
function result(value) {
  assert.notEqual(value.isError, true, JSON.stringify(value));
  assert(value.structuredContent && typeof value.structuredContent === "object");
  return value.structuredContent;
}
async function originalChatWriter(input, archive, python) {
  if (!input || !isAbsolute(input.path) || resolve(input.path) !== input.path || !/^[a-f0-9]{64}$/.test(input.sha256))
    fail("INSTALLED_TODO_ROLE_PINNED_CHAT_WRITER_REQUIRED");
  const stat = await lstat(input.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2_097_152
    || await realpath(input.path) !== input.path || u.hash(await readFile(input.path)) !== input.sha256)
    fail("INSTALLED_TODO_ROLE_CHAT_WRITER_CHANGED");
  const expected = execFileSync(python, ["-I", "-B", "-c", `
import hashlib,io,sys,zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
 print(hashlib.sha256(archive.read("extension/dist/chat/api-chat-store.js")).hexdigest())
`,], { input: await readFile(archive), encoding: "utf8", timeout: 30000, maxBuffer: 1024 }).trim();
  if (expected !== input.sha256) fail("INSTALLED_TODO_ROLE_CHAT_WRITER_NOT_ORIGINAL22");
  return input.path;
}
/** Original22 genesis only, before B0. No worker result, reviewer result or human approval is seeded. */
export async function prepareInstalledNativeTodoRoleFixture({ installed, componentFixture, legacyVsix, legacyChatStore, python }) {
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (states.has(componentFixture)) fail("INSTALLED_TODO_ROLE_ALREADY_PREPARED");
  for (const member of ["b0", "custody"]) await u.absent(join(componentFixture.directory, member), "INSTALLED_TODO_ROLE_PRE_B0_REQUIRED");
  for (const member of ["core.sqlite", ".pkm-next-original-mcp.json", ".pkm/state/api-chats", ".pkm/state/api-chat-history"])
    await u.absent(join(componentFixture.root, member), "INSTALLED_TODO_ROLE_FRESH_SOURCE_REQUIRED");
  const oracleDirectory = join(componentFixture.directory, "native-todo-role-original22");
  await mkdir(oracleDirectory, { mode: 0o700 });
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: oracleDirectory, legacyVsix, python });
  const chatWriter = await originalChatWriter(legacyChatStore, legacyVsix, python);
  const boardSlug = "Team/NativeRoleBoard", privateBoardSlug = "Private/NativeRoleControl", workItemId = "native-role-read-task";
  const boardPath = `notes/${boardSlug}.assets/pkm-todo-board.json`, notePath = `notes/${boardSlug}.md`;
  for (const path of [boardPath, notePath, `notes/${privateBoardSlug}.assets/pkm-todo-board.json`])
    await u.absent(join(componentFixture.root, path), "INSTALLED_TODO_ROLE_SOURCE_EXISTS");
  const privacy = JSON.parse(await readFile(join(componentFixture.root, ".pkm/content-privacy.json")));
  assert(privacy.private?.notes?.includes("Private"), "Parent must independently configure private control before this preparation.");
  writer.run(componentFixture.root, `
    process.umask(0o077);
    store.todoBoardCreate(input.boardSlug,"NativeRoleBoard","Team");
    store.todoBoardCreate(input.privateBoardSlug,"NativeRoleControl","Private");
    store.noteWorkItemCommand(input.boardSlug,store.noteWorkItemsRead(input.boardSlug).digest,{action:"create",item:{
      id:input.workItemId,title:"Read and report exact native Todo ownership",goal:"Claim this exact task, read its current WIP contract and owner, and submit that actual observation.",
      scope:"One disposable native structured-read workitem; no files, commands, scheduler or private access.",
      acceptance:["The exact workitem is owned by this worker Chat and WIP in an actual native model get_workitem response."],
      state:"Planning",evidence:[]}}, {id:"user:local",role:"user"});
    return store.noteWorkItemsRead(input.boardSlug);
  `, { boardSlug, privateBoardSlug, workItemId });
  const home = join(oracleDirectory, "chat-home"), scratch = join(oracleDirectory, "chat-scratch");
  await mkdir(home, { mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
  const chats = JSON.parse(execFileSync(process.execPath, ["-e", `
    process.umask(0o077);
    const fs=require("node:fs"),path=require("node:path"),net=require("node:net");
    net.connect=net.createConnection=()=>{throw new Error("Original role fixture network access forbidden");};
    const {ApiChatStore}=require(process.argv[1]),root=process.argv[2],namespace="abcdef0123456789";
    const chats=new ApiChatStore(path.join(root,".pkm/state"),namespace),result=[];
    for(const role of ["worker","reviewer"]){const chat=chats.create();chat.title="Original22 native Todo "+role;
      chat.messages.push({id:require("node:crypto").randomUUID(),role:"user",content:"Retained Original22 plain Chat source. No role execution or acceptance has occurred.",status:"complete"});
      chats.save(chat);result.push({role,id:chat.id,url:"pkm://chats/"+namespace+"/"+chat.id});}
    const base=path.resolve(process.argv[1],"../../..");
    const members=Object.keys(require.cache).filter(p=>p.startsWith(base+path.sep)).map(p=>({
      member:path.relative(base,p).split(path.sep).join("/"),sha256:require("node:crypto").createHash("sha256").update(fs.readFileSync(p)).digest("hex")}));
    console.log(JSON.stringify({chats:result,members}));
  `, chatWriter, componentFixture.root], {
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
    cwd: oracleDirectory, encoding: "utf8", timeout: 30000, maxBuffer: 2_097_152,
  }));
  const pinnedMembers = execFileSync(python, ["-I", "-B", "-c", `
import hashlib,io,json,sys,zipfile
data=json.loads(sys.argv[1])
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
 for item in data:
  if item["sha256"]!=hashlib.sha256(archive.read("extension/"+item["member"])).hexdigest():raise ValueError("Unpinned Original Chat dependency")
print("pinned")
`, JSON.stringify(chats.members)], { input: await readFile(legacyVsix), encoding: "utf8", timeout: 30000, maxBuffer: 1024 }).trim();
  assert.equal(pinnedMembers, "pinned"); writer.assertPinned();
  const value = Object.freeze({ kind: "pkm.installed-native-todo-role-fixture/v1", root: componentFixture.root,
    boardSlug, privateBoardSlug, workItemId, boardPath, notePath,
    workerChatId: chats.chats.find(chat => chat.role === "worker").id,
    reviewerChatId: chats.chats.find(chat => chat.role === "reviewer").id,
    originalPackageSha256: writer.originalPackageSha256, legacyChatWriterSha256: legacyChatStore.sha256 });
  states.set(value, { value, componentFixture, installed, writer, baseline: await u.files(componentFixture.root), phase: "prepared" });
  states.set(componentFixture, states.get(value));
  return value;
}
function board(component, fixture) {
  const path = join(component.root, ".pkm-next-todo", fixture.boardSlug, "pkm-todo-board.json");
  return readFile(path).then(bytes => ({ sha256: u.hash(bytes), bytes, value: JSON.parse(bytes) }));
}
function ledger(component) {
  const db = component.storage.connectNative();
  try {
    return {
      receipts: db.prepare("SELECT operation_id,actor_id,operation,fingerprint,result FROM receipts ORDER BY rowid").all(),
      pending: db.prepare("SELECT * FROM pending_todo").all(),
      roles: db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_native_todo_role_effects'").get()
        ? db.prepare("SELECT * FROM original_native_todo_role_effects ORDER BY rowid").all() : [],
    };
  } finally { db.close(); }
}
async function unchangedSource(state) {
  const actual = await u.files(state.value.root);
  for (const entry of state.baseline) assert.equal(actual.find(item => item.path === entry.path)?.sha256, entry.sha256);
}
/** Parent owns actual-renderer interaction. This helper supplies no model, tool, reviewer or human result callback. */
export async function verifyInstalledNativeTodoRole({ root, installed, component, roleFixture, payloadBuildId,
  expectedModelId, python, env, port, timeoutMs = 120000, signal }) {
  const state = stateFor(roleFixture, "prepared");
  if (state.installed !== installed || component?.fixture !== state.componentFixture || component.root !== roleFixture.root
    || typeof component.todoRoles !== "function" || typeof component.invokeCanonical !== "function")
    fail("INSTALLED_TODO_ROLE_SAME_PRIVATE_COMPONENT_REQUIRED");
  await u.privateDirectory(root, "INSTALLED_TODO_ROLE_PRIVATE_DRIVER_REQUIRED");
  if (typeof expectedModelId !== "string" || !expectedModelId.length || expectedModelId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(expectedModelId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    fail("INSTALLED_TODO_ROLE_EXPLICIT_REAL_MODEL_AND_LIMIT_REQUIRED");
  const { host, full } = await assertInstalledKnowledgeMoveComponentBinding({
    root, installed, component, componentFixture: state.componentFixture, payloadBuildId,
  });
  assert.equal(full.storage, component.storage);
  if (!host.nativeChat?.apiChat) fail("INSTALLED_TODO_ROLE_ACTUAL_NATIVE_MODEL_REQUIRED");
  const catalogue = await host.nativeChat.models.catalogue(signal ?? new AbortController().signal);
  const model = catalogue.models.find(model => model.id === expectedModelId);
  if (!model || /fixture|synthetic|mock/i.test(`${model.id} ${model.nativeModelId} ${model.vendor} ${model.label}`))
    fail("INSTALLED_TODO_ROLE_ACTUAL_NONFIXTURE_PROVIDER_REQUIRED");
  for (const name of ["native-todo-role-ui-contract.json", "native-todo-role-passed.json"])
    await u.absent(join(root, name), "INSTALLED_TODO_ROLE_EVIDENCE_REPLAY");
  const runId = randomUUID(), lease = { ...component.owner.workspaceLease() };
  state.phase = "verifying";
  state.b0Sha256 = component.b0.sha256;
  const ui = await startInstalledNativeTodoRoleObserver({ root, python, env, port, timeoutMs });
  const check = () => {
    if (ui.error) throw ui.error;
    signal?.throwIfAborted(); host.assertCurrent(); component.storage.assertWorkspaceLease();
    assert.deepEqual(component.owner.workspaceLease(), lease);
  };
  await writeFile(join(root, "native-todo-role-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-todo-role-ui/v1", runId, sourceRoot: component.root, workspaceId: component.workspaceId,
    profileSha256: host.receipt.profileSha256, nativeEpoch: host.receipt.epoch, expectedModelId, wireModelId: model.nativeModelId,
    boardSlug: roleFixture.boardSlug, workItemId: roleFixture.workItemId, workerChatId: roleFixture.workerChatId,
    reviewerChatId: roleFixture.reviewerChatId, stages: installedNativeTodoRoleStages,
    humanDecisionSource: "actual-native-UI-only", noAutomaticHumanApproval: true,
  }), { mode: 0o600, flag: "wx" });
  let roleControl;
  try {
  const readyUntil = Date.now() + timeoutMs;
  while (true) {
    check();
    try {
      const ready = JSON.parse(await readFile(join(root, "native-todo-role-ui-ready.json")));
      assert.equal(ready.runId, runId); assert.equal(ready.actualRenderer, true); assert.equal(ready.observerOnly, true); break;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    if (Date.now() >= readyUntil) fail("INSTALLED_TODO_ROLE_OBSERVER_NOT_READY");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const stage = async (name, work) => {
    check();
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: name, runId }), { mode: 0o600 });
    const value = await work(); check();
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: `${name}-done`, runId }), { mode: 0o600 });
    return value;
  };
  const policies = component.sourcePolicies(), domains = await u.load(installed, "original-mcp-domains");
  const sourceApi = await u.load(installed, "original-mcp-api-chat-source");
  await stage("native-todo-role-todo-source", () => domains.hydrateOriginalMcpTodo(component.storage, host, [roleFixture.boardSlug], policies.todo));
  const directory = join(component.fixture.directory, "native-todo-role-chat-source"); await mkdir(directory, { mode: 0o700 });
  const chatPlan = await sourceApi.planOriginalMcpApiChatSource(component.storage, host, {
    stagingDirectory: directory, limits: { maxChats: 2, maxMessagesPerChat: 16, maxMessages: 32 },
  });
  assert.equal(chatPlan.chats, 2);
  await stage("native-todo-role-chat-source", () => sourceApi.admitOriginalMcpApiChatSource(component.storage, host, chatPlan, policies.chat));
  const canonical = async (tool, args, readOnly) => result(await component.invokeCanonical(
    readOnly ? "legacy_capability_read" : "legacy_capability_call", { operation: `mcp.tool.${tool}`, version: 1, arguments: args }, signal));
  for (const [role, chatId] of [["worker", roleFixture.workerChatId], ["reviewer", roleFixture.reviewerChatId]]) {
    await stage(`native-todo-role-${role}-bind`, async () => {
      const submitted = await canonical("api_chat_send", { host_id: component.workspaceId, chat_id: chatId,
        command_id: `native-todo-role-${role}-bind-${runId}`, hard_tool_round_limit: 1,
        prompt: "Establish this exact ordinary native Chat binding. Reply briefly without tools; no Todo result, reviewer recommendation or human approval is requested." }, false);
      const deadline = Date.now() + timeoutMs;
      let receipt;
      do {
        check();
        receipt = await canonical("api_chat_request_get", { host_id: component.workspaceId, request_id: submitted.request_id }, true);
        if (!["queued", "running"].includes(receipt.status)) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
      const db = component.storage.connectNative();
      try {
        assert.equal(JSON.parse(String(db.prepare("SELECT model_selection FROM original_api_chat_current_chats WHERE id=?").get(chatId).model_selection)).modelId, expectedModelId);
      } finally { db.close(); }
    });
  }
  const roles = roleControl = await component.todoRoles();
  const args = { boardSlug: roleFixture.boardSlug, workItemId: roleFixture.workItemId };
  const beforeDeny = await board(component, roleFixture), beforeDenyLedger = ledger(component);
  assert.equal(await stage("native-todo-role-worker-deny", () => roles.prepare({ ...args, role: "worker", chatId: roleFixture.workerChatId }, { signal })), null);
  assert.deepEqual(await board(component, roleFixture), beforeDeny); assert.deepEqual(ledger(component), beforeDenyLedger);
  const worker = await stage("native-todo-role-worker-grant", () => roles.prepare({ ...args, role: "worker", chatId: roleFixture.workerChatId }, { signal }));
  assert(worker, "A denied/unavailable role cannot count as a workflow pass.");
  const refusals = [];
  async function refused(name, work) {
    const before = await board(component, roleFixture), old = ledger(component);
    await assert.rejects(work);
    assert.deepEqual(await board(component, roleFixture), before); assert.deepEqual(ledger(component), old);
    refusals.push({ case: name, noCanonicalEffects: true });
  }
  await refused("copied-role", () => roles.run(JSON.parse(JSON.stringify(worker))));
  await refused("other-chat-copied-role", () => roles.run({ ...worker, actorId: `chat:${roleFixture.reviewerChatId}` }));
  await refused("private-board", () => roles.prepare({ ...args, boardSlug: roleFixture.privateBoardSlug, role: "worker", chatId: roleFixture.workerChatId }));
  const worked = await stage("native-todo-role-worker-run", () => roles.run(worker));
  assert.equal(worked.status, "complete"); assert.equal(worked.actorId, `chat:${roleFixture.workerChatId}`);
  assert.equal(worked.workitem.state, "Done"); assert(!worked.workitem.acceptanceDecision);
  assert(worked.workitem.evidence.length && worked.workitem.evidence.every(id => id.startsWith("native-todo-evidence:")));
  await refused("one-shot-worker-replay", () => roles.run(worker));
  const reviewer = await stage("native-todo-role-reviewer-grant", () => roles.prepare({ ...args, role: "reviewer", chatId: roleFixture.reviewerChatId }, { signal }));
  assert(reviewer);
  const reviewed = await stage("native-todo-role-reviewer-run", () => roles.run(reviewer));
  assert.equal(reviewed.status, "complete"); assert.equal(reviewed.actorId, `chat:${roleFixture.reviewerChatId}`);
  assert.equal(reviewed.workitem.state, "Done"); assert(!reviewed.workitem.acceptanceDecision);
  assert(reviewed.workitem.comments.some(comment => comment.actorId === reviewed.actorId && comment.text.trim()));
  {
    const db = component.storage.connectNative();
    try {
      for (const id of [worked.requestId, reviewed.requestId])
        assert.equal(db.prepare("SELECT native_model_id FROM original_native_chat_executions WHERE request_id=?").get(id).native_model_id, model.nativeModelId);
    } finally { db.close(); }
  }
  const beforeHuman = await board(component, roleFixture), beforeHumanLedger = ledger(component);
  const denied = await stage("native-todo-role-human-deny", () => roles.accept({ worker, reviewer }, { signal }));
  assert.equal(denied.decision, "denied"); assert.deepEqual(await board(component, roleFixture), beforeHuman);
  assert.deepEqual(ledger(component), beforeHumanLedger);
  const accepted = await stage("native-todo-role-human-accept", () => roles.accept({ worker, reviewer }, { signal }));
  assert.equal(accepted.actorId, "user:local"); assert.equal(accepted.item.acceptanceDecision.by, "user:local");
  assert.equal(accepted.item.acceptanceDecision.decision, "accepted");
  assert(accepted.item.history.some(event => event.action === "accept" && event.actorId === "user:local" && event.reason.trim()));
  assert(!accepted.item.reviewerIds?.length, "The model must never acquire acceptance delegation.");
  await ui.done;
  const observed = JSON.parse(await readFile(join(root, "native-todo-role-ui-passed.json")));
  assert.equal(observed.runId, runId); assert.equal(observed.passed, true); assert.equal(observed.actualRenderedDom, true);
  assert.equal(observed.clickedOrAnswered, false); assert.equal(observed.dialogs.length, 5);
  await refused("accepted-target-replay", () => roles.accept({ worker, reviewer }));
  worker.revoke(); await refused("cancelled-worker-grant", () => roles.run(worker));
  await unchangedSource(state);
  const after = ledger(component);
  assert.equal(after.pending.length, 0);
  const transitions = accepted.item.history.map(event => ({ action: event.action, actorId: event.actorId, from: event.from, to: event.to }));
  for (const [action, actorId] of [["claim", worked.actorId], ["transition", worked.actorId], ["comment", reviewed.actorId], ["accept", "user:local"]])
    assert(transitions.some(event => event.action === action && event.actorId === actorId));
  const evidence = {
    schema: "pkm.installed-native-todo-role-evidence/v1", passed: true, runId, actualNativeModel: true, actualNativeUi: true,
    actualRenderedDefaultDeny: true, fixtureModelUsed: false, nativeUi: observed,
    workerRequestId: worked.requestId, reviewerRequestId: reviewed.requestId, workerProof: worked.proof, reviewerProof: reviewed.proof,
    humanDeniedWithoutEffects: true, humanAcceptanceActor: "user:local", humanAcceptanceDefault: "deny",
    sourceRoot: component.root, workspaceId: component.workspaceId, profileSha256: host.receipt.profileSha256,
    nativeEpoch: host.receipt.epoch, boardSlug: roleFixture.boardSlug, workItemId: roleFixture.workItemId,
    transitions, refusals, originalPackageSha256: roleFixture.originalPackageSha256,
    noReviewerDelegation: true, noExecutionWorkerPolicyUnchanged: true, sourceBytesUnchanged: true,
    schedulerHistoryFileCheckpointQualified: false, chatPresentationQualified: false,
    b1FreshB0AndStoppedOwnerRequired: true,
  };
  await writeFile(join(root, "native-todo-role-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
  state.phase = "verified"; state.evidence = evidence; state.component = component;
  roles.close();
  return evidence;
  } finally {
    if (state.phase !== "verified") state.phase = "failed";
    roleControl?.close();
    await ui.stop();
  }
}
export async function verifyInstalledNativeTodoRoleClosedB1B0({ roleFixture, retirement, restoration }) {
  const state = stateFor(roleFixture, "verified");
  const binding = { componentFixture: state.componentFixture, sourceRoot: roleFixture.root, b0Sha256: state.b0Sha256 };
  const retired = await readInstalledKnowledgeMoveRetirementReceipt(binding, retirement);
  const archived = new DatabaseSync(join(retirement.archive, "core.sqlite"), { readOnly: true });
  try {
    for (const requestId of [state.evidence.workerRequestId, state.evidence.reviewerRequestId])
      assert.equal(archived.prepare("SELECT status FROM original_native_chat_executions WHERE request_id=?").get(requestId).status, "complete");
    assert.equal(archived.prepare("SELECT count(*) AS n FROM pending_todo").get().n, 0);
    assert.equal(archived.prepare("SELECT count(*) AS n FROM original_native_todo_role_effects WHERE json_extract(admission_json,'$.kind')='human'").get().n, 1);
  } finally { archived.close(); }
  await readInstalledKnowledgeMoveRestoredReceipt(binding, retirement, restoration, retired);
  const actual = await u.files(restoration.root);
  for (const entry of state.baseline) assert.equal(actual.find(item => item.path === entry.path)?.sha256, entry.sha256);
  for (const file of actual) assert(!file.path.startsWith(".pkm-next") && file.path !== "core.sqlite", "Fresh B0 cannot restore role/native authority.");
  const task = JSON.parse(await readFile(join(restoration.root, roleFixture.boardPath))).items.find(item => item.id === roleFixture.workItemId);
  assert.equal(task.state, "Planning"); assert(!task.ownerId && !task.acceptanceDecision && !task.evidence.length);
  state.phase = "restored";
  return { ...state.evidence, b1Retired: true, freshB0Restored: true, restoredHistoricalSourceGrantsNothing: true };
}
