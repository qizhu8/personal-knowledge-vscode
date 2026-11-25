import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url), preparations = new WeakMap();
const hash = value => createHash("sha256").update(value).digest("hex");
const load = (installed, name) => import(pathToFileURL(join(installed, "next-runtime/server/dist", `${name}.js`)).href);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(code) { throw Object.assign(new Error(code), { code }); }
function frozen(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function stateFor(value) {
  const state = preparations.get(value);
  if (!state) fail("INSTALLED_TODO_WORKER_ACTUAL_PREPARATION_REQUIRED");
  return state;
}
async function absent(path, code) {
  try { await lstat(path); fail(code); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function sourceUnchanged(state, root = state.value.root) {
  assert.deepEqual(await readFile(join(root, state.value.boardPath)), state.board);
  assert.deepEqual(await readFile(join(root, state.value.notePath)), state.note);
}
async function waitJson(path, timeoutMs, check = () => {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    check();
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.failed) throw new Error(`Installed worker UI failed: ${value.error}`);
      return value;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await delay(50);
  }
  throw new Error(`Installed worker evidence timed out: ${path}`);
}

/** Before B0/custody, with the whole editor stopped. No existing library/profile can enter this branded fixture. */
export async function prepareInstalledNativeTodoWorkerFixture({ installed, componentFixture, legacyWriter }) {
  const recovery = await load(installed, "original-mcp-component-recovery");
  await recovery.assertOriginalMcpColdComponentFixture(componentFixture);
  if (preparations.has(componentFixture)) fail("INSTALLED_TODO_WORKER_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    join(componentFixture.root, ".pkm-next-original-mcp.json")])
    await absent(path, "INSTALLED_TODO_WORKER_PRESEAL_PREPARATION_REQUIRED");
  if (!legacyWriter || typeof legacyWriter.path !== "string" || !isAbsolute(legacyWriter.path)
    || resolve(legacyWriter.path) !== legacyWriter.path || !/^[a-f0-9]{64}$/.test(legacyWriter.sha256))
    fail("INSTALLED_TODO_WORKER_PINNED_ORIGINAL_WRITER_REQUIRED");
  const writerPath = legacyWriter.path, stat = await lstat(writerPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8_388_608
    || await realpath(writerPath) !== writerPath || hash(await readFile(writerPath)) !== legacyWriter.sha256)
    fail("INSTALLED_TODO_WORKER_ORIGINAL_WRITER_CHANGED");
  const boardSlug = "Team/WorkerBoard", itemId = "original-installed-worker-task";
  const workerActorId = "external:copilot:installed-board-worker";
  const boardPath = `notes/${boardSlug}.assets/pkm-todo-board.json`, notePath = `notes/${boardSlug}.md`;
  for (const path of [join(componentFixture.root, boardPath), join(componentFixture.root, notePath)])
    await absent(path, "INSTALLED_TODO_WORKER_SOURCE_ALREADY_EXISTS");
  const store = require(writerPath), mask = process.umask(0o077);
  let oldToken;
  try {
    store.setStorePath(componentFixture.root);
    store.todoBoardCreate(boardSlug, "WorkerBoard", "Team");
    store.noteWorkItemCommand(boardSlug, store.noteWorkItemsRead(boardSlug).digest, { action: "create", item: {
      id: itemId, title: "Keep exact installed worker task", goal: "Use fresh native Board worker consent",
      scope: "Disposable installed native worker experiment", acceptance: ["Canonical worker comment and actual revocation"],
      state: "Planning", evidence: [],
    } }, { id: "user:local", role: "user" });
    store.noteWorkItemCommand(boardSlug, store.noteWorkItemsRead(boardSlug).digest,
      { action: "assign", id: itemId, ownerId: workerActorId, reason: "Historical assignment; not current worker authority" },
      { id: "user:local", role: "user" });
    oldToken = store.todoBoardGrantWorker(boardSlug, store.noteWorkItemsRead(boardSlug).digest, workerActorId);
  } finally { process.umask(mask); }
  if (hash(await readFile(writerPath)) !== legacyWriter.sha256) fail("INSTALLED_TODO_WORKER_ORIGINAL_WRITER_CHANGED");
  const board = await readFile(join(componentFixture.root, boardPath)), note = await readFile(join(componentFixture.root, notePath));
  const rootIdentity = await lstat(componentFixture.root, { bigint: true });
  const value = Object.freeze({ kind: "pkm.installed-native-todo-worker-fixture/v1", root: componentFixture.root,
    boardSlug, itemId, workerActorId, boardPath, notePath, boardSha256: hash(board), noteSha256: hash(note),
    legacyWriterSha256: legacyWriter.sha256 });
  const state = { value, componentFixture, board, note, oldToken,
    rootIdentity: `${rootIdentity.dev}:${rootIdentity.ino}`, phase: "prepared" };
  preparations.set(componentFixture, state); preparations.set(value, state);
  return value;
}

/** Dialog choices are fixed native producer labels, not approval DTOs or mocked UI callbacks. */
export const installedNativeTodoWorkerUiStages = Object.freeze([
  Object.freeze({ stage: "native-todo-worker-source-admit", choice: "Admit this exact source only" }),
  Object.freeze({ stage: "native-todo-worker-deny", choice: "Deny" }),
  Object.freeze({ stage: "native-todo-worker-enroll", choice: "Enroll this exact Board worker" }),
  Object.freeze({ stage: "native-todo-worker-revoke", statusBarText: "PKM Board worker", action: "inspect-only" }),
  Object.freeze({ stage: "native-todo-worker-revoked", action: "logical-revocation-complete" }),
]);

const workerUi = String.raw`
import hashlib,json,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"])
def wait_stage(name):
    deadline=time.monotonic()+f["timeoutMs"]/1000
    while time.monotonic()<deadline:
        try:
            progress=json.loads((root/"progress.json").read_text())
            if progress.get("stage")=="failed":raise RuntimeError(str(progress))
            if progress.get("stage")==name:return
        except (FileNotFoundError,json.JSONDecodeError):pass
        time.sleep(.05)
    raise RuntimeError("Worker UI stage timed out: "+name)
try:
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]))
        pages=[page for context in browser.contexts for page in context.pages]
        page=next(page for page in pages if "workbench" in page.url)
        (root/"native-todo-worker-ui-ready.json").write_text(json.dumps({"ready":True,"actualRenderer":True,"runId":f["runId"]}))
        dialogs=[]
        for stage,choice in [(x["stage"],x["choice"]) for x in f["stages"] if "choice" in x]:
            wait_stage(stage)
            dialog=page.locator(".monaco-dialog-box")
            dialog.get_by_role("button",name=choice,exact=True).wait_for(state="visible",timeout=f["timeoutMs"])
            text=dialog.inner_text()
            for identity in [f["sourceRoot"],f["profileSha256"],f["boardSlug"]]:
                assert identity in text,"Native worker/source modal omitted exact identity: "+identity
            assert '"noExecution": true' in text
            if stage=="native-todo-worker-source-admit":
                for identity in [f["boardPath"],f["notePath"],f["boardSha256"],f["noteSha256"]]:
                    assert identity in text,"Source modal omitted pinned original identity: "+identity
                assert "No old worker, Engine, queued execution" in text
            else:
                for identity in [f["workerActorId"],'"tokenSha256"',f["custodyPlanSha256"],f["nativeEpoch"]]:
                    assert identity in text,"Worker modal omitted exact enrollment identity: "+identity
                assert '"noLegacyTokenInheritance": true' in text
                assert "original Chat ownership" in text and "not granted" in text
                assert "No task, prompt or queue starts" in text
            dialogs.append({"stage":stage,"choice":choice,"textSha256":hashlib.sha256(text.encode()).hexdigest(),
                "exactSourceAndProfileVisible":True,"independentWorkerConsentVisible":stage!="native-todo-worker-source-admit"})
            dialog.get_by_role("button",name=choice,exact=True).click()
        wait_stage("native-todo-worker-revoke")
        worker=page.locator(".statusbar-item").filter(has_text="PKM Board worker")
        assert worker.count()==1,"Exactly one native Board-worker status control is required"
        source=page.locator(".statusbar-item").filter(has_text="PKM todo source")
        assert source.count()==1,"The independent Todo source control must still be present"
        worker.hover()
        hover=page.locator(".monaco-hover").filter(has_text="Click to revoke the signed session and all its grants.")
        hover.wait_for(state="visible",timeout=f["timeoutMs"])
        tooltip=hover.inner_text()
        for identity in [f["sourceRoot"],f["boardSlug"],f["workerActorId"]]:
            assert identity in tooltip,"Worker revoke tooltip omitted exact identity: "+identity
        (root/"native-todo-worker-ui-revoke-ready.json").write_text(json.dumps({"ready":True,"runId":f["runId"],
            "workerStatusBarInspected":True,"workerStatusBarNotClicked":True,"sourceStatusBarNotClicked":True}))
        wait_stage("native-todo-worker-revoked")
        (root/"native-todo-worker-ui-passed.json").write_text(json.dumps({"passed":True,"actualNativeUi":True,"runId":f["runId"],
            "dialogs":dialogs,"workerStatusBarInspected":True,"workerStatusBarNotClicked":True,
            "sourceStatusBarNotClicked":True,"exactWorkerTooltipVisible":True,"logicalRevocationStageObserved":True,
            "granularPerWorkerRevocationClaimed":False}))
except Exception as error:
    (root/"native-todo-worker-ui-passed.json").write_text(json.dumps({"failed":True,"runId":f["runId"],"error":str(error)}))
    raise
`;

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await done; } finally { clearTimeout(timer); }
}
async function enrolledIdentity(root, installed, component, host, payloadBuildId) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077) fail("INSTALLED_TODO_WORKER_PRIVATE_DRIVER_REQUIRED");
  const first = JSON.parse(await readFile(join(root, "native-identity-first.json"), "utf8"));
  const proof = JSON.parse(await readFile(join(root, "native-identity-passed.json"), "utf8"));
  const member = typeof first.result?.path === "string" ? relative(root, first.result.path) : "";
  if (!member || member === ".." || member.startsWith(`..${sep}`) || isAbsolute(member)
    || await realpath(first.result.path) !== first.result.path) fail("INSTALLED_TODO_WORKER_ENROLLED_PROFILE_REQUIRED");
  const identity = await load(installed, "original-mcp-native-identity");
  identity.verifyOriginalMcpNativeIdentity(JSON.parse(first.publicRecord), first.result.sha256, first.result.profileSha256);
  assert.equal(await readFile(first.result.path, "utf8"), first.publicRecord);
  assert.equal(proof.passed, true); assert.equal(proof.realInstalledExtension, true);
  assert.equal(proof.identitySha256, first.result.sha256);
  const descriptor = JSON.parse(await readFile(component.attachmentDescriptorPath, "utf8"));
  assert.equal(hash(await readFile(component.attachmentDescriptorPath)), component.attachmentDescriptorSha256);
  assert.equal(descriptor.identitySha256, first.result.sha256);
  assert.equal(descriptor.binding.root, component.root);
  assert.equal(descriptor.binding.workspaceId, component.workspaceId);
  assert.equal(descriptor.binding.planSha256, component.custody.planSha256);
  assert.equal(descriptor.binding.profileSha256, first.result.profileSha256);
  assert.equal(component.custody.profileSha256, first.result.profileSha256, "The enrolled profile must precede custody; repinning is forbidden.");
  assert.equal(descriptor.binding.payloadBuildId, payloadBuildId);
  assert.equal(descriptor.binding.hostEntrySha256, hash(await readFile(join(installed, "dist/extension.cjs"))));
  assert.equal(host.receipt.profileSha256, component.custody.profileSha256);
  return first;
}

/**
 * Same retained cold component, before any source/attachment-closing scenario.
 * The helper drives its own actual-renderer UI child; parent still owns editor, packaging and cold recovery.
 */
export async function verifyInstalledNativeTodoWorker({ root, installed, component, host, workerFixture,
  python, env, port, payloadBuildId, timeoutMs = 120000, signal }) {
  const state = stateFor(workerFixture);
  if (state.phase !== "prepared" || component?.fixture !== state.componentFixture || component?.root !== workerFixture.root)
    fail("INSTALLED_TODO_WORKER_SAME_COLD_FIXTURE_REQUIRED");
  if (typeof component.sourcePolicies !== "function" || typeof component.enrollTodoWorker !== "function"
    || typeof component.revokeTodoWorkers !== "function")
    fail("INSTALLED_TODO_WORKER_COMPONENT_ADAPTER_REQUIRED");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 120000 || typeof python !== "string" || !python)
    fail("INSTALLED_TODO_WORKER_DRIVER_LIMITS_REQUIRED");
  assert.equal(host, await component.complete());
  const { assertRootOwner } = await load(installed, "root-owner"), hostApi = await load(installed, "original-mcp-native-host");
  assertRootOwner(component.owner); hostApi.assertOriginalMcpNativeHost(host, component.storage);
  await enrolledIdentity(root, installed, component, host, payloadBuildId);
  for (const name of ["native-todo-worker-ui-ready.json", "native-todo-worker-ui-revoke-ready.json",
    "native-todo-worker-ui-passed.json", "native-todo-worker-passed.json"])
    await absent(join(root, name), "INSTALLED_TODO_WORKER_EVIDENCE_REPLAY");
  const policies = component.sourcePolicies(), sourceApi = await load(installed, "original-mcp-native-source-policy");
  sourceApi.assertOriginalMcpNativeSourcePolicy(policies.todo, component.storage, host, "todo");
  const full = await component.owner.ensureFull(), lease = { ...component.owner.workspaceLease() };
  assert.equal(full.storage, component.storage);
  const domains = await load(installed, "original-mcp-domains"), domainState = await load(installed, "original-mcp-domain-state");
  const { authenticateBoardWorker } = await load(installed, "boards");
  const { createLegacyCapabilityDispatcher } = await load(installed, "legacy-capability-mcp");
  const actor = Object.freeze({ id: "mcp:external", canWrite: true });
  const dispatch = createLegacyCapabilityDispatcher(full.runtime.core, actor, component.storage);
  const call = (operation, args, token) => dispatch({
    action: operation.endsWith(".get") ? "read" : "call",
    args: { operation, version: 1, arguments: args }, ...(token ? { workerToken: token } : {}),
  });
  const nativePath = `.pkm-next-todo/${workerFixture.boardSlug}/pkm-todo-board.json`;
  const workerCount = () => {
    const db = component.storage.connectNative();
    try { return Number(db.prepare("SELECT count(*) AS n FROM original_mcp_domain_workers WHERE json_extract(payload,'$.actorId')=? AND json_extract(payload,'$.boardSlug')=?")
      .get(workerFixture.workerActorId, workerFixture.boardSlug).n); } finally { db.close(); }
  };
  const coreRead = principal => full.runtime.core.dispatch("capability_read", { operation: "todo.workitem.get", version: 1,
    arguments: { board_slug: workerFixture.boardSlug, id: workerFixture.itemId } }, principal);
  assert.equal((await coreRead(actor)).error?.code, "NATIVE_AUTHORITY_REQUIRED", "Public/model admission cannot stand in for Todo source consent.");
  await sourceUnchanged(state);
  const runId = randomUUID(), uiFixture = {
    root, port, timeoutMs, runId, sourceRoot: component.root, profileSha256: component.custody.profileSha256,
    custodyPlanSha256: component.custody.planSha256, nativeEpoch: host.receipt.epoch,
    boardSlug: workerFixture.boardSlug, workerActorId: workerFixture.workerActorId,
    boardPath: workerFixture.boardPath, notePath: workerFixture.notePath,
    boardSha256: workerFixture.boardSha256, noteSha256: workerFixture.noteSha256, stages: installedNativeTodoWorkerUiStages,
  };
  state.phase = "verifying"; state.component = component;
  const ui = spawn(python, ["-B", "-c", workerUi, JSON.stringify(uiFixture)], { env, stdio: "inherit" });
  let uiError;
  const uiDone = new Promise((resolve, reject) => {
    ui.once("error", reject);
    ui.once("exit", (code, ended) => code === 0 ? resolve() : reject(new Error(`Installed worker UI exited ${code}/${ended}`)));
  });
  void uiDone.catch(error => { uiError = error; });
  const check = () => { signal?.throwIfAborted(); if (uiError) throw uiError; };
  const progress = async stage => { check(); await writeFile(join(root, "progress.json"), JSON.stringify({ stage }), { mode: 0o600 }); };
  try {
    const ready = await waitJson(join(root, "native-todo-worker-ui-ready.json"), timeoutMs, check);
    assert.equal(ready.runId, runId); assert.equal(ready.actualRenderer, true);
    await progress("native-todo-worker-source-admit");
    const admitted = await domains.hydrateOriginalMcpTodo(component.storage, host, [workerFixture.boardSlug], policies.todo);
    const todo = domainState.originalMcpTodoSession(component.root), flag = new Int32Array(todo.revocation);
    assert.equal(Atomics.load(flag, 0), 0);
    assert.equal((await coreRead(actor)).error, undefined);
    assert.equal(workerCount(), 0);
    assert.throws(() => authenticateBoardWorker(component.root, workerFixture.boardSlug, state.oldToken), /never inherited/);
    assert.throws(() => domainState.readOriginalMcpTodoAuthority(component.root, workerFixture.workerActorId, workerFixture.boardSlug), /fresh native grant/);
    const enroll = () => component.enrollTodoWorker({ boardSlug: workerFixture.boardSlug, actorId: workerFixture.workerActorId });
    await progress("native-todo-worker-deny");
    await assert.rejects(enroll(), /typed native worker decision/i);
    assert.equal(workerCount(), 0);
    assert.equal(Atomics.load(flag, 0), 0, "A fresh worker denial must not invent enrollment or source revocation.");
    assert.deepEqual(await readFile(join(component.root, nativePath)), state.board);
    await progress("native-todo-worker-enroll");
    const enrolled = await enroll();
    assert.match(enrolled.token, /^[a-f0-9]{64}$/); assert.notEqual(enrolled.token, state.oldToken);
    assert.equal(workerCount(), 1);
    const tokenSha256 = hash(enrolled.token);
    assert.throws(() => authenticateBoardWorker(component.root, workerFixture.boardSlug, state.oldToken), /never inherited/);
    const authority = domainState.readOriginalMcpTodoAuthority(component.root, workerFixture.workerActorId, workerFixture.boardSlug);
    assert.equal(authority.workerReceiptSha256, enrolled.receiptSha256);
    assert.equal(authority.revocation, todo.revocation);
    assert(enrolled.expiresAtMs > Date.now() && enrolled.expiresAtMs <= todo.expiresAtMs);
    const first = await call("todo.workitem.get", { board_slug: workerFixture.boardSlug, id: workerFixture.itemId }, enrolled.token);
    assert.equal(first.schema, "pkm.capability-result/v1"); assert.equal(first.result.actorId, workerFixture.workerActorId);
    const comment = "Actual installed fresh native Board worker comment.";
    const written = await call("todo.workitem.comment", { board_slug: workerFixture.boardSlug, id: workerFixture.itemId,
      text: comment, expected_digest: first.result.digest }, enrolled.token);
    assert.equal(written.result.actorId, workerFixture.workerActorId);
    assert.equal(written.result.item.comments.at(-1).actorId, workerFixture.workerActorId);
    assert.equal(written.result.item.comments.at(-1).text, comment);
    const readback = await call("todo.workitem.get", { board_slug: workerFixture.boardSlug, id: workerFixture.itemId }, enrolled.token);
    assert.equal(readback.result.digest, written.result.digest);
    const cachedWorker = await component.storage.withWorkspaceExclusive(() => authenticateBoardWorker(component.root, workerFixture.boardSlug, enrolled.token));
    assert.equal(cachedWorker.id, workerFixture.workerActorId);
    assert.equal(cachedWorker.boardWorker.digest, written.result.digest);
    const deniedChat = await full.runtime.core.dispatch("capability_read", { operation: "chat.session.list", version: 1,
      arguments: { limit: 1, includeArchived: false } }, { ...cachedWorker, canWrite: true });
    assert.equal(deniedChat.error?.code, "ACCESS_DENIED", "Board authority must not expand into manager Chat privileges.");
    const nativeBoard = await readFile(join(component.root, nativePath));
    assert.equal(hash(nativeBoard), written.result.digest);
    const originalItem = JSON.parse(state.board.toString("utf8")).items.find(item => item.id === workerFixture.itemId);
    const nativeItem = JSON.parse(nativeBoard.toString("utf8")).items.find(item => item.id === workerFixture.itemId);
    assert.deepEqual(nativeItem.history.slice(0, originalItem.history.length), originalItem.history);
    assert.notEqual(JSON.parse(nativeBoard.toString("utf8")).workers[workerFixture.workerActorId], tokenSha256,
      "The retained original Board token hash must not become the freshly issued native token.");
    let workerReceipt, commentReceipt;
    const db = component.storage.connectNative();
    try {
      const row = db.prepare("SELECT payload FROM original_mcp_domain_workers WHERE receipt_sha256=?").get(enrolled.receiptSha256);
      assert(row); workerReceipt = JSON.parse(row.payload);
      assert.equal(workerReceipt.actorId, workerFixture.workerActorId);
      assert.equal(workerReceipt.tokenSha256, tokenSha256);
      assert.equal(workerReceipt.intentSha256, admitted.intentSha256);
      assert.equal(workerReceipt.nativeHostReceiptSha256, host.receipt.receiptSha256);
      assert.equal(workerReceipt.sessionDecisionId, todo.decisionId);
      assert.equal(workerReceipt.expiresAtMs, enrolled.expiresAtMs);
      commentReceipt = db.prepare(`SELECT * FROM receipts WHERE operation='todo.workitem.comment' AND actor_id=?
        AND json_extract(result,'$.board_slug')=? AND json_extract(result,'$.digest')=?`).get(
        workerFixture.workerActorId, workerFixture.boardSlug, written.result.digest);
      assert(commentReceipt);
      assert.equal(JSON.parse(commentReceipt.result).item.comments.at(-1).text, comment);
      assert.equal(db.prepare("SELECT count(*) AS n FROM pending_todo").get().n, 0);
    } finally { db.close(); }
    await sourceUnchanged(state);
    assert.deepEqual(component.owner.workspaceLease(), lease);
    await progress("native-todo-worker-revoke");
    const revokeReady = await waitJson(join(root, "native-todo-worker-ui-revoke-ready.json"), timeoutMs, check);
    assert.equal(revokeReady.runId, runId); assert.equal(revokeReady.workerStatusBarNotClicked, true);
    assert.equal(revokeReady.sourceStatusBarNotClicked, true);
    await component.revokeTodoWorkers();
    const deadline = Date.now() + timeoutMs;
    while (Atomics.load(flag, 0) === 0 && Date.now() < deadline) { check(); await delay(25); }
    assert.equal(Atomics.load(flag, 0), 1);
    assert.equal(host.signal.aborted, false, "Logical worker-policy revocation must preserve the common signed attachment.");
    assert.equal(policies.signal.aborted, false);
    hostApi.assertOriginalMcpNativeHost(host, component.storage);
    assert.throws(() => authenticateBoardWorker(component.root, workerFixture.boardSlug, enrolled.token));
    assert.throws(() => authenticateBoardWorker(component.root, workerFixture.boardSlug, state.oldToken));
    await assert.rejects(call("todo.workitem.get", { board_slug: workerFixture.boardSlug, id: workerFixture.itemId }, enrolled.token));
    assert.equal((await coreRead({ ...cachedWorker, canWrite: true })).error?.code, "NATIVE_AUTHORITY_REQUIRED");
    const rejectedOperationId = randomUUID();
    const rejectedWrite = await full.runtime.core.dispatch("capability_call", { operation: "todo.workitem.comment", version: 1,
      arguments: { board_slug: workerFixture.boardSlug, id: workerFixture.itemId, expected_digest: written.result.digest,
        operationId: rejectedOperationId, text: "Revoked installed worker must never publish this." } }, { ...cachedWorker, canWrite: true });
    assert(rejectedWrite.error);
    assert.deepEqual(await readFile(join(component.root, nativePath)), nativeBoard);
    const after = component.storage.connectNative();
    try {
      assert.equal(after.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(rejectedOperationId).n, 0);
      assert.equal(after.prepare("SELECT count(*) AS n FROM pending_todo").get().n, 0);
    } finally { after.close(); }
    assert.equal((await component.owner.ensureFull()).runtime.core, full.runtime.core);
    assert.deepEqual(component.owner.workspaceLease(), lease);
    const managerChatRead = await full.runtime.core.dispatch("capability_read", { operation: "chat.session.list", version: 1,
      arguments: { limit: 1, includeArchived: false } }, actor);
    assert.equal(managerChatRead.error, undefined, "A worker-policy revoke does not close independent manager-native Chat access.");
    await sourceUnchanged(state);
    await progress("native-todo-worker-revoked");
    const uiProof = await waitJson(join(root, "native-todo-worker-ui-passed.json"), timeoutMs, check);
    assert.equal(uiProof.runId, runId); assert.equal(uiProof.actualNativeUi, true);
    assert.equal(uiProof.workerStatusBarNotClicked, true); assert.equal(uiProof.sourceStatusBarNotClicked, true);
    await uiDone;
    const evidence = frozen({
      schema: "pkm.installed-native-todo-worker-evidence/v1", passed: true,
      scope: "disposable installed native worker/source UI and actual same-owner Core only", payloadBuildId,
      profileSha256: component.custody.profileSha256, custodyPlanSha256: component.custody.planSha256,
      nativeHostReceiptSha256: host.receipt.receiptSha256, nativeEpoch: host.receipt.epoch,
      originalWriterSha256: workerFixture.legacyWriterSha256, originalBoardSha256: workerFixture.boardSha256,
      originalNoteSha256: workerFixture.noteSha256, domainIntentSha256: admitted.intentSha256,
      workerActorId: workerFixture.workerActorId, workerReceiptSha256: enrolled.receiptSha256,
      workerDecisionId: workerReceipt.decisionId, tokenSha256, tokenExpiresAtMs: enrolled.expiresAtMs,
      commentOperationId: commentReceipt.operation_id, commentFingerprint: commentReceipt.fingerprint,
      nativeBoardSha256: written.result.digest, nativeUi: uiProof,
      separateWorkerDenialNoEnrollment: true, freshTokenAuthenticatedAndReadBack: true, canonicalWorkerCommentPublished: true,
      oldTokenNeverInherited: true, noManagerChatPrivilegeExpansion: true, cachedPrincipalAndTokenRevoked: true,
      sameRootOwnerAndCachedCore: true, originalSourcesUnchanged: true, workerControlInspectedNotClicked: true,
      workerPolicyLogicalRevoked: true, wholeTodoSessionRevoked: true, signedSessionPreserved: true,
      nativeWorkerRevokeUiQualified: false, granularPerWorkerRevocationQualified: false, installedOriginalChatAssignmentQualified: false,
      b1PreservationVerified: false, b0RestorationVerified: false, fullCutoverQualified: false, actualProfileOrKeyringQualified: false,
    });
    assert(!JSON.stringify(evidence).includes(enrolled.token), "Raw worker tokens are not evidence artifacts.");
    await writeFile(join(root, "native-todo-worker-passed.json"), JSON.stringify(evidence), { flag: "wx", mode: 0o600 });
    state.phase = "verified"; state.evidence = evidence; state.nativeBoard = nativeBoard;
    state.workerReceipt = workerReceipt; state.commentReceipt = commentReceipt;
    return evidence;
  } finally { await stopChild(ui); }
}

/** After parent-confirmed full editor exit, closed component, real B1 retirement and fresh B0 restoration. */
export async function verifyInstalledNativeTodoWorkerRestored(workerFixture, { restoredRoot, archive }) {
  const state = stateFor(workerFixture);
  if (state.phase !== "verified" || !state.evidence || !state.component) fail("INSTALLED_TODO_WORKER_VERIFIED_EFFECT_REQUIRED");
  assert.throws(() => state.component.owner.assertWorkspaceLease(), "The canonical component must be closed before preservation verification.");
  const member = typeof archive === "string" ? relative(workerFixture.root, archive) : "";
  if (typeof restoredRoot !== "string" || resolve(restoredRoot) !== join(state.componentFixture.directory, "restored-b0")
    || typeof archive !== "string" || !isAbsolute(archive) || resolve(archive) !== archive || await realpath(archive) !== archive
    || !/^\.pkm-next-component-retired-[a-f0-9-]{36}$/.test(member))
    fail("INSTALLED_TODO_WORKER_ACTUAL_RESTORE_REQUIRED");
  const restored = await lstat(restoredRoot, { bigint: true }), originalRoot = await lstat(workerFixture.root, { bigint: true });
  assert.equal(await realpath(restoredRoot), restoredRoot);
  assert.equal(restored.isDirectory() && !restored.isSymbolicLink(), true);
  assert.notEqual(`${restored.dev}:${restored.ino}`, state.rootIdentity, "B0 must be materialized into a fresh root identity.");
  assert.equal(`${originalRoot.dev}:${originalRoot.ino}`, state.rootIdentity, "Cold restoration must not replace the original root.");
  const retirementBytes = await readFile(join(state.componentFixture.directory, "retirement-complete.json"));
  const retirement = JSON.parse(retirementBytes.toString("utf8"));
  const restoration = JSON.parse(await readFile(join(state.componentFixture.directory, "b0-restored.json"), "utf8"));
  assert.equal(retirement.schema, "pkm.original-mcp-component-retirement/v1");
  assert.equal(retirement.root, workerFixture.root); assert.equal(retirement.archive, archive);
  assert.equal(retirement.originalPathRetired, true); assert.equal(retirement.enginesStopped, true);
  assert.equal(restoration.schema, "pkm.original-mcp-component-b0-restored/v1");
  assert.equal(restoration.root, restoredRoot); assert.equal(restoration.originalRoot, workerFixture.root);
  assert.equal(restoration.retirementSha256, hash(retirementBytes));
  assert.equal(restoration.originalRootOverwritten, false);
  assert.equal(restoration.b0Sha256, retirement.b0Sha256); assert.equal(restoration.b1Sha256, retirement.b1Sha256);
  const baseline = await readFile(join(state.componentFixture.directory, "b0/manifest.json"));
  assert.equal(hash(baseline), retirement.b0Sha256);
  const baselineRows = JSON.parse(baseline.toString("utf8")).rows;
  assert.equal(baselineRows.find(row => row.path === workerFixture.boardPath)?.sha256, workerFixture.boardSha256);
  assert.equal(baselineRows.find(row => row.path === workerFixture.notePath)?.sha256, workerFixture.noteSha256);
  let preservedRows;
  for (const name of (await readdir(state.componentFixture.directory)).filter(name => /^b1-[a-f0-9-]{36}$/.test(name))) {
    const bytes = await readFile(join(state.componentFixture.directory, name, "manifest.json"));
    if (hash(bytes) === retirement.b1Sha256) preservedRows = JSON.parse(bytes.toString("utf8")).rows;
  }
  assert(preservedRows, "The parent must preserve a complete genuine B1 image before retirement.");
  await sourceUnchanged(state, restoredRoot); await sourceUnchanged(state, archive);
  await absent(join(restoredRoot, "core.sqlite"), "INSTALLED_TODO_WORKER_B0_CONTAINS_NATIVE_WORKER_STATE");
  await absent(join(restoredRoot, ".pkm-next-todo"), "INSTALLED_TODO_WORKER_B0_CONTAINS_NATIVE_WORKER_STATE");
  const nativePath = `.pkm-next-todo/${workerFixture.boardSlug}/pkm-todo-board.json`;
  assert.deepEqual(await readFile(join(archive, nativePath)), state.nativeBoard);
  assert.equal(preservedRows.find(row => row.path === nativePath)?.sha256, state.evidence.nativeBoardSha256);
  assert.equal(preservedRows.find(row => row.path === workerFixture.boardPath)?.sha256, workerFixture.boardSha256);
  assert.equal(preservedRows.find(row => row.path === workerFixture.notePath)?.sha256, workerFixture.noteSha256);
  assert.equal(preservedRows.find(row => row.path === "core.sqlite")?.sha256, hash(await readFile(join(archive, "core.sqlite"))));
  const db = new DatabaseSync(join(archive, "core.sqlite"), { readOnly: true });
  try {
    assert.equal(Object.values(db.prepare("PRAGMA integrity_check").get())[0], "ok");
    const row = db.prepare("SELECT payload FROM original_mcp_domain_workers WHERE receipt_sha256=?").get(state.evidence.workerReceiptSha256);
    assert(row); assert.deepEqual(JSON.parse(row.payload), state.workerReceipt);
    const receipt = db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(state.evidence.commentOperationId);
    assert(receipt); assert.deepEqual(receipt, state.commentReceipt);
    assert.equal(db.prepare("SELECT count(*) AS n FROM pending_todo").get().n, 0);
  } finally { db.close(); }
  state.phase = "restored";
  return { originalTodoWorkerB0BytesRestored: true, canonicalWorkerB1ReceiptAndCommentPreserved: true,
    freshRootIdentity: true, fullCutoverQualified: false, installedOriginalChatAssignmentQualified: false };
}
