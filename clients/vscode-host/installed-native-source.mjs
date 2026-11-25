import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url), prepared = new WeakMap();
const hash = value => createHash("sha256").update(value).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const load = (installed, name) => import(pathToFileURL(join(installed, "next-runtime/server/dist", `${name}.js`)).href);
function fail(code) { throw Object.assign(new Error(code), { code }); }

async function waitJson(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.failed) throw new Error(`Installed source UI failed: ${value.error}`);
      return value;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(50);
  }
  throw new Error(`Installed source evidence timed out: ${path}`);
}

/** Called after the whole editor exits, before the existing cold-component B0/custody capture. */
export async function prepareInstalledNativeTodoSourceFixture({ installed, componentFixture, legacyWriter }) {
  const recovery = await load(installed, "original-mcp-component-recovery");
  await recovery.assertOriginalMcpColdComponentFixture(componentFixture);
  if (prepared.has(componentFixture)) fail("INSTALLED_SOURCE_FIXTURE_ALREADY_PREPARED");
  if (!legacyWriter || typeof legacyWriter.path !== "string" || !isAbsolute(legacyWriter.path) || resolve(legacyWriter.path) !== legacyWriter.path
    || !/^[a-f0-9]{64}$/.test(legacyWriter.sha256)) fail("INSTALLED_SOURCE_PINNED_ORIGINAL_WRITER_REQUIRED");
  const writerPath = legacyWriter.path, writerStat = await lstat(writerPath);
  if (!writerStat.isFile() || writerStat.isSymbolicLink() || writerStat.nlink !== 1
    || writerStat.size > 8_388_608 || await realpath(writerPath) !== writerPath
    || hash(await readFile(writerPath)) !== legacyWriter.sha256)
    fail("INSTALLED_SOURCE_ORIGINAL_WRITER_CHANGED");
  const store = require(writerPath), boardSlug = "Team/Board", itemId = "original-source-task";
  store.setStorePath(componentFixture.root);
  store.todoBoardCreate(boardSlug, "Board", "Team");
  store.noteWorkItemCommand(boardSlug, store.noteWorkItemsRead(boardSlug).digest, { action: "create", item: {
    id: itemId, title: "Keep exact installed Todo task", goal: "Preserve original identity and history",
    scope: "Disposable installed native source experiment", acceptance: ["Exact source admission and revocation"],
    state: "Planning", evidence: [],
  } }, { id: "user:local", role: "user" });
  store.noteWorkItemCommand(boardSlug, store.noteWorkItemsRead(boardSlug).digest,
    { action: "assign", id: itemId, ownerId: "external:copilot:historical-source-worker", reason: "Historical only" },
    { id: "user:local", role: "user" });
  const oldToken = store.todoBoardGrantWorker(boardSlug, store.noteWorkItemsRead(boardSlug).digest,
    "external:copilot:historical-source-worker");
  const boardPath = `notes/${boardSlug}.assets/pkm-todo-board.json`, notePath = `notes/${boardSlug}.md`;
  const board = await readFile(join(componentFixture.root, boardPath)), note = await readFile(join(componentFixture.root, notePath));
  if (hash(await readFile(writerPath)) !== legacyWriter.sha256) fail("INSTALLED_SOURCE_ORIGINAL_WRITER_CHANGED");
  const value = Object.freeze({ kind: "pkm.installed-native-todo-source-fixture/v1", root: componentFixture.root,
    boardSlug, itemId, boardPath, notePath, boardSha256: hash(board), noteSha256: hash(note),
    legacyWriterSha256: legacyWriter.sha256 });
  const state = { componentFixture, value, board, note, oldToken };
  prepared.set(componentFixture, state); prepared.set(value, state);
  return value;
}

const sourceUi = String.raw`
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
    raise RuntimeError("Source UI stage timed out: "+name)
try:
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]))
        pages=[page for context in browser.contexts for page in context.pages]
        page=next(page for page in pages if "workbench" in page.url)
        (root/"native-source-ui-ready.json").write_text('{"ready":true,"actualRenderer":true}')
        dialogs=[]
        for phase,choice in [("native-source-todo-deny","Deny"),("native-source-todo-admit","Admit this exact source only")]:
            wait_stage(phase)
            dialog=page.locator(".monaco-dialog-box")
            dialog.get_by_role("button",name=choice,exact=True).wait_for(state="visible",timeout=f["timeoutMs"])
            text=dialog.inner_text()
            for identity in [f["sourceRoot"],f["profileSha256"],f["boardPath"],f["notePath"],f["boardSha256"],f["noteSha256"]]:
                assert identity in text,"Native source modal omitted exact identity: "+identity
            assert '"noExecution": true' in text
            assert "No old worker, Engine, queued execution" in text
            dialogs.append({"stage":phase,"choice":choice,"textSha256":hashlib.sha256(text.encode()).hexdigest(),
                            "exactSourceAndProfileVisible":True,"noExecutionVisible":True})
            dialog.get_by_role("button",name=choice,exact=True).click()
        wait_stage("native-source-todo-revoke")
        item=page.locator(".statusbar-item").filter(has_text="PKM todo source")
        assert item.count()==1,"Exactly one native Todo-source status indicator is required"
        item.hover()
        hover=page.locator(".monaco-hover").filter(has_text="Revocation closes the full signed session.")
        hover.wait_for(state="visible",timeout=f["timeoutMs"])
        tooltip=hover.inner_text()
        assert f["sourceRoot"] in tooltip and f["profileSha256"] in tooltip
        item.click()
        (root/"native-source-ui-passed.json").write_text(json.dumps({"passed":True,"actualNativeUi":True,
            "dialogs":dialogs,"statusBarClicked":True,"exactRootProfileTooltipVisible":True}))
except Exception as error:
    (root/"native-source-ui-passed.json").write_text(json.dumps({"failed":True,"error":str(error)}))
    raise
`;

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await done; } finally { clearTimeout(timer); }
}

/**
 * Run between the existing cold component's final public Skill write and its close/B1 capture.
 * The parent must expose sourcePolicies() from the real private session, not accept a supplied policy callback.
 */
export async function verifyInstalledNativeTodoSource({ root, installed, component, host, sourceFixture,
  python, env, port, payloadBuildId, timeoutMs = 120000 }) {
  const state = prepared.get(sourceFixture);
  if (!state || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_SOURCE_ACTUAL_COLD_FIXTURE_REQUIRED");
  if (typeof component.sourcePolicies !== "function") fail("INSTALLED_SOURCE_COMPONENT_ADAPTER_REQUIRED");
  assert.equal(host, await component.complete(), "The source scenario must use the actual cold component's native host.");
  const policies = component.sourcePolicies();
  const source = await load(installed, "original-mcp-native-source-policy");
  source.assertOriginalMcpNativeSourcePolicy(policies.todo, component.storage, host, "todo");
  const owner = await load(installed, "root-owner");
  owner.assertRootOwner(component.owner);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 120000) fail("INSTALLED_SOURCE_DRIVER_LIMITS_REQUIRED");
  const rootStat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !rootStat.isDirectory() || rootStat.isSymbolicLink()
    || rootStat.uid !== process.getuid() || (rootStat.mode & 0o077) !== 0)
    fail("INSTALLED_SOURCE_PRIVATE_DRIVER_REQUIRED");
  const first = JSON.parse(await readFile(join(root, "native-identity-first.json"), "utf8"));
  const identityProof = JSON.parse(await readFile(join(root, "native-identity-passed.json"), "utf8"));
  const member = typeof first.result?.path === "string" ? relative(root, first.result.path) : "";
  if (!member || member === ".." || member.startsWith(`..${sep}`) || isAbsolute(member)
    || await realpath(first.result.path) !== first.result.path) fail("INSTALLED_SOURCE_ENROLLED_PROFILE_REQUIRED");
  const identity = await load(installed, "original-mcp-native-identity");
  identity.verifyOriginalMcpNativeIdentity(JSON.parse(first.publicRecord), first.result.sha256, first.result.profileSha256);
  assert.equal(await readFile(first.result.path, "utf8"), first.publicRecord);
  assert.equal(identityProof.passed, true);
  assert.equal(identityProof.realInstalledExtension, true);
  assert.equal(identityProof.identitySha256, first.result.sha256);
  const domains = await load(installed, "original-mcp-domains");
  const domainState = await load(installed, "original-mcp-domain-state");
  const { authenticateBoardWorker } = await load(installed, "boards");
  const descriptor = JSON.parse(await readFile(component.attachmentDescriptorPath, "utf8"));
  assert.equal(hash(await readFile(component.attachmentDescriptorPath)), component.attachmentDescriptorSha256);
  assert.equal(descriptor.binding.root, sourceFixture.root);
  assert.equal(descriptor.binding.planSha256, component.custody.planSha256);
  assert.equal(descriptor.binding.profileSha256, component.custody.profileSha256,
    "The already enrolled profile must be pinned before custody; sealed profiles cannot be replaced.");
  assert.equal(descriptor.binding.payloadBuildId, payloadBuildId);
  assert.equal(descriptor.binding.hostEntrySha256, hash(await readFile(join(installed, "dist/extension.cjs"))));
  assert.equal(host.receipt.profileSha256, component.custody.profileSha256);
  assert.equal(component.custody.profileSha256, first.result.profileSha256);
  assert.equal(descriptor.identitySha256, first.result.sha256);
  const full = await component.owner.ensureFull(), lease = { ...component.owner.workspaceLease() };
  assert.equal(full.storage, component.storage);
  const actor = Object.freeze({ id: "mcp:external", canWrite: true });
  const read = () => full.runtime.core.dispatch("capability_read", { operation: "todo.workitem.get", version: 1,
    arguments: { board_slug: sourceFixture.boardSlug, id: sourceFixture.itemId } }, actor);
  const unchanged = async () => {
    assert.deepEqual(await readFile(join(component.root, sourceFixture.boardPath)), state.board);
    assert.deepEqual(await readFile(join(component.root, sourceFixture.notePath)), state.note);
  };
  const hydrate = () => domains.hydrateOriginalMcpTodo(component.storage, host, [sourceFixture.boardSlug], policies.todo);
  assert.equal((await read()).error?.code, "NATIVE_AUTHORITY_REQUIRED", "Native identity/public admission is not Todo source consent.");
  await unchanged();
  const fixture = { root, port, timeoutMs, sourceRoot: sourceFixture.root, profileSha256: component.custody.profileSha256,
    boardPath: sourceFixture.boardPath, notePath: sourceFixture.notePath,
    boardSha256: sourceFixture.boardSha256, noteSha256: sourceFixture.noteSha256 };
  const ui = spawn(python, ["-B", "-c", sourceUi, JSON.stringify(fixture)], { env, stdio: "inherit" });
  let uiError;
  const uiDone = new Promise((resolve, reject) => {
    ui.once("error", reject);
    ui.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Installed source UI exited ${code}/${signal}`)));
  });
  void uiDone.catch(error => { uiError = error; });
  const progress = stage => writeFile(join(root, "progress.json"), JSON.stringify({ stage }), { mode: 0o600 });
  try {
    await waitJson(join(root, "native-source-ui-ready.json"), timeoutMs);
    await progress("native-source-todo-deny");
    await assert.rejects(hydrate(), /fresh bounded native UI decision/i);
    assert.equal(domainState.readOriginalMcpDomain(component.root, "todo"), undefined);
    assert.equal((await read()).error?.code, "NATIVE_AUTHORITY_REQUIRED");
    await unchanged();
    await progress("native-source-todo-admit");
    const admitted = await hydrate();
    assert.equal(admitted.domain, "todo");
    const grant = domainState.originalMcpTodoSession(component.root), flag = new Int32Array(grant.revocation);
    assert.equal(Atomics.load(flag, 0), 0);
    assert(grant.expiresAtMs > Date.now() && grant.expiresAtMs <= Date.now() + 300000);
    const actual = await read();
    assert.equal(actual.error, undefined, JSON.stringify(actual));
    assert.match(JSON.stringify(actual), /Keep exact installed Todo task/);
    assert.match(JSON.stringify(actual), /historical-source-worker/);
    assert.throws(() => authenticateBoardWorker(component.root, sourceFixture.boardSlug, state.oldToken), /never inherited/);
    await unchanged();
    assert.deepEqual(component.owner.workspaceLease(), lease);
    await progress("native-source-todo-revoke");
    const uiProof = await waitJson(join(root, "native-source-ui-passed.json"), timeoutMs);
    assert.equal(uiProof.actualNativeUi, true); assert.equal(uiProof.statusBarClicked, true);
    const deadline = Date.now() + timeoutMs;
    while (Atomics.load(flag, 0) === 0 && Date.now() < deadline) {
      if (uiError) throw uiError;
      await delay(25);
    }
    assert.equal(Atomics.load(flag, 0), 1, "The real native revoke must invalidate the actual cached Core source resource.");
    assert.equal(host.signal.aborted, true);
    assert.equal(policies.signal.aborted, true);
    assert.throws(() => domainState.originalMcpTodoSession(component.root));
    assert.equal((await read()).error?.code, "NATIVE_AUTHORITY_REQUIRED",
      "The still-owned, same cached Core must deny source access after native UI revocation.");
    component.owner.assertWorkspaceLease();
    assert.deepEqual(component.owner.workspaceLease(), lease);
    assert.equal((await component.owner.ensureFull()).runtime.core, full.runtime.core);
    await unchanged(); await uiDone;
    const evidence = { passed: true, scope: "disposable installed Todo source admission only; not production/profile cutover",
      originalWriterSha256: sourceFixture.legacyWriterSha256, originalBoardSha256: sourceFixture.boardSha256,
      originalNoteSha256: sourceFixture.noteSha256, profileSha256: component.custody.profileSha256,
      custodyPlanSha256: component.custody.planSha256, nativeHostReceiptSha256: host.receipt.receiptSha256,
      nativeEpoch: host.receipt.epoch, domainIntentSha256: admitted.intentSha256,
      installedPayloadBuildId: payloadBuildId, actualNativeSourceUi: uiProof, sameRootOwnerAndCachedCore: true,
      denialNoDomainIntent: true, actualSourceAdmission: true, originalSourceBytesUnchanged: true,
      oldWorkerTokenRejected: true, cachedCoreSourceRevoked: true, signedSessionClosedByNativeRevoke: true,
      sourceTransportBudget: 65536, memoryOrChatSourceQualified: false, fullCutoverQualified: false,
      actualProfileOrKeyringQualified: false };
    await writeFile(join(root, "native-source-todo-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
    return evidence;
  } finally { await stopChild(ui); }
}

export async function verifyInstalledNativeTodoSourceRestored(sourceFixture, root) {
  const state = prepared.get(sourceFixture);
  if (!state) fail("INSTALLED_SOURCE_ACTUAL_COLD_FIXTURE_REQUIRED");
  assert.deepEqual(await readFile(join(root, sourceFixture.boardPath)), state.board);
  assert.deepEqual(await readFile(join(root, sourceFixture.notePath)), state.note);
  return { originalTodoB0BytesRestored: true };
}
