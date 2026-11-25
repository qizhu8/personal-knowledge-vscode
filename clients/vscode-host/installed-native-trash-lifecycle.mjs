import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pinnedOriginalKnowledgeWriterFixture } from "../../tests/original-knowledge-writer-fixture.mjs";
import {
  installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u,
  assertInstalledKnowledgeMoveComponentBinding, readInstalledKnowledgeMoveRetirementReceipt,
  readInstalledKnowledgeMoveRestoredReceipt,
} from "./installed-native-knowledge-move.mjs";
import { installedNativeTrashCanonicalRequest } from "./installed-native-trash.mjs";
import { startInstalledNativeTrashLifecycleUi } from "./installed-native-trash-lifecycle-ui.mjs";
import { startInstalledNativeTrashLifecycleRecoveryUi } from "./installed-native-trash-lifecycle-recovery-ui.mjs";

const states = new WeakMap(), ownerPath = "TrashLifecycle/Owner.md", pairPath = "TrashLifecycle/Owner.assets";
const faultControllers = new WeakMap(), recoveryEpochs = new WeakMap();
const deleteOwner = Object.freeze({ slug: "TrashLifecycle/Owner" });
const collisionArguments = Object.freeze({ title: "Owner", category: "TrashLifecycle",
  content: "DISPOSABLE_CANONICAL_TRASH_COLLISION\n" });
export const installedNativeTrashLifecyclePrivacyPolicy = installedNativeKnowledgeMovePrivacyPolicy;
export const installedNativeTrashLifecycleStages = Object.freeze([
  { stage: "native-trash-lifecycle-late-click", tool: "delete_note", arguments: deleteOwner, publicChoice: "Approve this request",
    action: "move", choice: "Move this exact Note to Trash once", transportAbort: true, code: "NATIVE_REQUEST_CANCELLED" },
  { stage: "native-trash-lifecycle-shared", tool: "delete_note", arguments: Object.freeze({ slug: "TrashLifecycle/Shared" }),
    publicChoice: "Approve this request", code: "CONFLICT" },
  { stage: "native-trash-lifecycle-owner-delete", tool: "delete_note", arguments: deleteOwner, publicChoice: "Approve this request",
    action: "move", choice: "Move this exact Note to Trash once" },
  { stage: "native-trash-lifecycle-restore-deny", action: "restore", choice: "Deny", code: "ORIGINAL_TRASH_DENIED" },
  { stage: "native-trash-lifecycle-stale", noReview: true, code: "CONFLICT" },
  { stage: "native-trash-lifecycle-create-collision", tool: "add_note", arguments: collisionArguments, publicChoice: "Approve this request" },
  { stage: "native-trash-lifecycle-collision", noReview: true, code: "CONFLICT" },
  { stage: "native-trash-lifecycle-collision-delete", tool: "delete_note", arguments: deleteOwner, publicChoice: "Approve this request",
    action: "move", choice: "Move this exact Note to Trash once" },
  { stage: "native-trash-lifecycle-restore", action: "restore", choice: "Restore this exact Note once" },
  { stage: "native-trash-lifecycle-replay", noReview: true },
  { stage: "native-trash-lifecycle-list", action: "list", choice: "Read these exact Trash entries once" },
].map(Object.freeze));
/** Specification only: no injection, source override, owner factory or historical grant is supplied here. */
export const installedNativeTrashLifecycleRecoveryPlan = Object.freeze({
  qualified: false, requiredParentSeam: "genuine branded disposable fixture + one-shot NativeRuntimeOptions.trash.faultInjector",
  faultPoint: "move-0", expectedPrefix: 1, retainedImagesRequired: Object.freeze(["original B0", "original custody plan"]),
  epochs: Object.freeze([
    Object.freeze({ epoch: 1, phase: "execute", publicDecision: "approve", trashDecision: "approve",
      expectedPending: 1, expectedNewOperationReceipts: 0, parentClosesOwnerAndEditor: true }),
    Object.freeze({ epoch: 2, phase: "recover", trashDecision: "deny",
      expectedPending: 1, expectedNewOperationReceipts: 0, parentClosesOwnerAndEditor: true }),
    Object.freeze({ epoch: 3, phase: "recover", trashDecision: "approve",
      expectedPending: 0, expectedNewOperationReceipts: 1, verifyRestartDoesNotReviewAgain: true }),
  ]),
  oldParserGate: "run independently SHA-pinned pre-Trash v5 deserializeTrashLifecyclePlan on the real new pending plan; require strict rejection",
  coldBootstrapRecapturePermitted: false,
});
const seed = `
  for(const name of ["Owner","Shared"]){
    store.noteUpsert({slug:"TrashLifecycle/"+name,title:name,category:"TrashLifecycle",type:"general",
      content:"DISPOSABLE_PUBLIC_LIFECYCLE_"+name+"\\n![pair]("+name+".assets/opaque.bin?q=1#view)\\n"});
    assets.saveMarkdownAsset(root,"notes","TrashLifecycle/"+name+".md","opaque.bin",Buffer.from([255,0,128,9]));
  }
  const first=store.noteGet("TrashLifecycle/Owner");
  store.noteUpsert({...first,tags:JSON.parse(first.tags),content:first.content+"Revision two.\\n"});
  store.noteUpsert({slug:"Private/TrashLifecycleReferrer",title:"TrashLifecycleReferrer",category:"Private",type:"general",
    content:"DISPOSABLE_PRIVATE_LIFECYCLE_REFERRER\\n![shared](../TrashLifecycle/Shared.assets/opaque.bin)\\n"});
  store.noteUpsert({slug:"TrashLifecycle/Archived",title:"Archived",category:"TrashLifecycle",type:"general",
    content:"DISPOSABLE_READONLY_LIFECYCLE_BUCKET\\n"});
  const prior=store.knowledgePathMoveToTrash("notes","TrashLifecycle/Archived.md");
  return {owner:store.noteGet("TrashLifecycle/Owner"),prior};
`;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value, phase) {
  const state = states.get(value);
  if (!state) fail("INSTALLED_TRASH_LIFECYCLE_ACTUAL_PREPARATION_REQUIRED");
  if (phase && state.phase !== phase) fail("INSTALLED_TRASH_LIFECYCLE_VERIFIED_PHASE_REQUIRED");
  return state;
}
function noPrivate(value) {
  u.noPrivatePublication(value);
  assert(!JSON.stringify(value).includes("DISPOSABLE_PRIVATE_LIFECYCLE_REFERRER"));
}
function result(response) {
  noPrivate(response); assert.notEqual(response.isError, true, JSON.stringify(response));
  return response.structuredContent ?? JSON.parse(response.content[0].text);
}
function journal(db) {
  return Object.fromEntries([
    ["intents", "SELECT * FROM migration_runtime_intents ORDER BY operation_id"],
    ["trashReceipts", "SELECT * FROM receipts WHERE operation GLOB 'knowledge.trash.*' ORDER BY operation_id"],
    ["noteReceipts", "SELECT * FROM receipts WHERE operation='knowledge.note.create' ORDER BY operation_id"],
    ["successors", "SELECT * FROM original_native_trash_commits ORDER BY sequence"],
  ].map(([key, sql]) => [key, db.prepare(sql).all().map(row => ({ ...row }))]));
}
function live(component) { const db = component.storage.connectNative(); try { return journal(db); } finally { db.close(); } }
async function snapshot(component, custody) {
  const files = await u.files(component.root, true), dirs = new Set(["notes", "skills", "papers", ".pkm", ".pkm/state"]);
  for (const file of files) for (let index = 1; index < file.path.split("/").length; index++)
    dirs.add(file.path.split("/").slice(0, index).join("/"));
  return { files, directories: [...dirs].sort().map(path => custody.originalTrashIdentity(component.root, path)),
    history: custody.originalTrashIdentity(component.root, ".pkm/state/knowledge-deletions.json"), journal: live(component) };
}
export async function prepareInstalledNativeTrashLifecycleFixture({ installed, componentFixture, legacyVsix, python }) {
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (states.has(componentFixture)) fail("INSTALLED_TRASH_LIFECYCLE_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    join(componentFixture.root, "core.sqlite"), join(componentFixture.root, ".pkm-next-original-mcp.json")])
    await u.absent(path, "INSTALLED_TRASH_LIFECYCLE_PRE_B0_REQUIRED");
  if (!isAbsolute(python ?? "")) fail("INSTALLED_TRASH_LIFECYCLE_EXPLICIT_PYTHON_REQUIRED");
  const privacyPath = join(componentFixture.root, ".pkm/content-privacy.json"), stat = await lstat(privacyPath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077));
  const privacyBytes = await readFile(privacyPath);
  assert.deepEqual(JSON.parse(privacyBytes), installedNativeTrashLifecyclePrivacyPolicy, "Parent must independently configure exact Private top levels.");
  for (const area of ["notes", "skills", "papers"]) await mkdir(join(componentFixture.root, area), { recursive: true, mode: 0o700 });
  for (const path of ["notes/TrashLifecycle", "notes/Private/TrashLifecycleReferrer.md"])
    await u.absent(join(componentFixture.root, path), "INSTALLED_TRASH_LIFECYCLE_DISJOINT_SEED_REQUIRED");
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: componentFixture.directory, legacyVsix, python });
  const rows = writer.run(componentFixture.root, seed);
  assert.deepEqual(await readFile(privacyPath), privacyBytes);
  const baseline = await u.files(componentFixture.root), raw = await readFile(join(componentFixture.root, "notes", ownerPath));
  const history = await readFile(join(componentFixture.root, ".pkm/state/knowledge-deletions.json"));
  const value = Object.freeze({ kind: "pkm.installed-native-trash-lifecycle-fixture/v1", root: componentFixture.root,
    originalPackageSha256: writer.originalPackageSha256, privacySha256: u.hash(privacyBytes), priorEntryId: rows.prior.id,
    owner: Object.freeze({ id: rows.owner.knowledgeId, revision: rows.owner.revision, sha256: u.hash(raw), path: ownerPath }),
    pendingRecoveryQualified: false, oldReadonlyBucketRestoreQualified: false,
    files: Object.freeze(u.hashes(baseline).map(Object.freeze)) });
  const state = { installed, componentFixture, baseline, raw, history, privacyBytes, rows, value, phase: "prepared" };
  states.set(value, state); states.set(componentFixture, state); return value;
}
async function preservation(state, root) {
  const current = await u.files(root, true), prior = `notes/.trash/${state.rows.prior.id}/`;
  const untouched = file => file.path.includes("/Private/") || file.path.startsWith(prior)
    || file.path.startsWith("notes/TrashLifecycle/Shared.");
  assert.deepEqual(current.filter(untouched), state.baseline.filter(untouched));
  for (const file of state.baseline.filter(file => !["notes", "skills", "papers"].includes(file.path.split("/")[0])
    && file.path !== ".pkm/state/knowledge-deletions.json"))
    assert.deepEqual(await readFile(join(root, file.path)), file.bytes);
  if (state.beforeKnowledge) for (const file of state.beforeKnowledge.filter(file =>
    file.path !== `notes/${ownerPath}` && !file.path.startsWith(`notes/${pairPath}/`)))
    assert.deepEqual(await readFile(join(root, file.path)), file.bytes);
}
async function waitEvidence(root, name, runId, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const value = JSON.parse(await readFile(join(root, name)));
      assert.equal(value.runId, runId); return value;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  fail("INSTALLED_TRASH_LIFECYCLE_OBSERVER_HANDSHAKE_TIMEOUT");
}
/** Actual AbortSignal and rendered late choice; no filesystem injection or native response factory. */
export async function verifyInstalledNativeTrashLifecycle({ root, installed, component, sourceFixture, payloadBuildId,
  python, env, port, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture, "prepared");
  if (state.installed !== installed || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_TRASH_LIFECYCLE_SAME_COMPONENT_REQUIRED");
  if (typeof component.invokeCanonical !== "function") fail("INSTALLED_TRASH_LIFECYCLE_ACTUAL_CANONICAL_COMPONENT_REQUIRED");
  const { host, full } = await assertInstalledKnowledgeMoveComponentBinding({ root, installed, component,
    componentFixture: state.componentFixture, payloadBuildId });
  assert.equal(full.runtime.services.modelProvider, undefined); assert.equal(host.nativeChat, undefined);
  for (const provider of ["vscode", "openai-compatible", "azure-openai"]) assert.equal(host.options.providerTransport.supports(provider), false);
  const contracts = await u.load(installed, "original-native-trash-contracts"), custody = await u.load(installed, "original-native-trash-custody");
  const planning = await u.load(installed, "original-native-trash-planning"), lifecycle = await u.load(installed, "trash-lifecycle");
  const markdown = await u.load(installed, "markdown"), native = await u.load(installed, "original-native-trash-native");
  const rootApi = await u.load(installed, "original-mcp-root");
  assert(native.getNativeOriginalTrashPort(component.storage, host));
  const lease = { ...component.owner.workspaceLease() }, runId = randomUUID(), abort = new AbortController();
  state.beforeKnowledge = await u.files(component.root, true); state.b0Sha256 = component.b0.sha256; state.workspaceId = component.workspaceId;
  const initial = live(component);
  assert.equal(initial.intents.length, 0); assert.equal(initial.trashReceipts.length, 0); assert.equal(initial.successors.length, 0);
  state.initialNoteReceipts = initial.noteReceipts;
  const binding = { root: component.root, workspaceId: component.workspaceId, catalogSha256: host.receipt.sourceCatalogSha256,
    profileSha256: host.receipt.profileSha256, custodyPlanSha256: component.custody.planSha256,
    privacySha256: component.custody.privacySha256, epoch: host.receipt.epoch, nativeHostReceiptSha256: host.receipt.receiptSha256 };
  await writeFile(join(root, "native-trash-lifecycle-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-trash-lifecycle-ui/v1", runId, binding, stages: installedNativeTrashLifecycleStages,
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativeTrashLifecycleUi({ root, python, env, port, runId, timeoutMs });
  void ui.done.catch(error => abort.abort(error));
  const check = async () => {
    if (ui.error) throw ui.error;
    host.assertCurrent(); component.storage.assertWorkspaceLease(); assert.deepEqual({ ...component.owner.workspaceLease() }, lease);
    const current = await component.owner.ensureFull(); assert.equal(current.runtime.core, full.runtime.core); assert.equal(current.storage, component.storage);
    const db = component.storage.connectNative();
    try { const names = db.prepare("PRAGMA database_list").all().filter(row => row.name !== "temp");
      assert.equal(names.length, 1); assert.equal(names[0].file, join(component.root, "core.sqlite")); }
    finally { db.close(); }
    await preservation(state, component.root);
    await component.storage.withWorkspaceExclusive(() => rootApi.validateOriginalMcpWorkspace(component.root));
  };
  const progress = async (step, expected = {}) => {
    await writeFile(join(root, "native-trash-lifecycle-ui-next.json"), JSON.stringify({ stage: step.stage, ...expected }), { mode: 0o600 });
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: step.stage }), { mode: 0o600 });
  };
  const canonical = (operation, args) => {
    const request = installedNativeTrashCanonicalRequest(operation, args);
    return component.invokeCanonical(request.name, request.input, abort.signal);
  };
  const refusal = async (step, invoke) => {
    const before = await snapshot(component, custody); let failure;
    try { const response = await invoke(); noPrivate(response); if (response.isError)
      failure = Object.assign(new Error("Native request refused"), { code: response.structuredContent?.code }); }
    catch (error) { failure = error; }
    assert(failure); assert.equal(failure.code, step.code); assert.deepEqual(await snapshot(component, custody), before);
    await check(); return { stage: step.stage, code: failure.code };
  };
  const moveExpected = () => {
    const record = markdown.scanMarkdown(component.root).find(row => row.record.area === "notes" && row.record.path === ownerPath);
    assert(record);
    const inventory = [...(custody.originalTrashIdentity(component.root, `notes/${pairPath}`)
      ? custody.originalTrashTree(component.root, `notes/${pairPath}`) : []), ...custody.originalTrashTree(component.root, `notes/${ownerPath}`)];
    const historyBytes = custody.originalTrashHistoryImage(component.root);
    const db = component.storage.connectNative(); let predecessor;
    try { predecessor = custody.originalTrashPredecessor(db, component.custody.planSha256); } finally { db.close(); }
    return { document: { id: record.record.id, knowledgeId: record.metadata.get("knowledgeId"), revision: record.record.revision, sha256: record.record.sha256 },
      path: ownerPath, inventory, paired: inventory.some(row => row.kind === "directory"), history: JSON.parse(historyBytes),
      historyBeforeSha256: u.hash(historyBytes), predecessorSha256: predecessor };
  };
  const outcomes = []; let originalEntry, collisionEntry, restoreArgs;
  try {
    await ui.ready; await check();
    for (const step of installedNativeTrashLifecycleStages) {
      await check();
      if (step.transportAbort) {
        const before = await snapshot(component, custody), controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, abort.signal]);
        await progress(step, moveExpected());
        const pending = component.invoke(step.tool, step.arguments, signal).then(value => ({ value }), error => ({ error }));
        const observed = await waitEvidence(root, "native-trash-lifecycle-abort-ready.json", runId, timeoutMs);
        assert.equal(observed.stage, step.stage); assert.equal(observed.actualRenderedDom, true);
        const observedRequest = contracts.originalNativeTrashRequestSchema.parse(observed.request);
        assert.equal(contracts.originalNativeTrashDigest(observedRequest), observed.requestSha256);
        assert.equal(observedRequest.nativeEpoch, binding.epoch);
        assert.equal(observedRequest.nativeHostReceiptSha256, binding.nativeHostReceiptSha256);
        assert.equal(observedRequest.subject.root, component.root); assert.equal(observedRequest.subject.workspaceId, component.workspaceId);
        assert.equal(observedRequest.subject.operationId, observed.operationId);
        assert.equal(observedRequest.subject.action, "move"); assert.equal(observedRequest.phase, "execute");
        state.cancelledOperationId = observed.operationId;
        controller.abort();
        const settled = await pending; assert(settled.error); assert.equal(settled.error.code, "NATIVE_REQUEST_CANCELLED");
        assert.deepEqual(await snapshot(component, custody), before);
        await writeFile(join(root, "native-trash-lifecycle-abort-settled.json"), JSON.stringify({
          runId, stage: step.stage, operationId: observed.operationId, requestSha256: observed.requestSha256,
          code: settled.error.code, settledBeforeLateClick: true,
        }), { mode: 0o600, flag: "wx" });
        const clicked = await waitEvidence(root, "native-trash-lifecycle-late-click.json", runId, timeoutMs);
        assert.equal(clicked.operationId, observed.operationId); assert.equal(clicked.requestSha256, observed.requestSha256);
        assert.equal(clicked.sameRenderedModal, true); assert.deepEqual(await snapshot(component, custody), before);
        await check(); outcomes.push({ stage: step.stage, code: settled.error.code, lateChoiceNoEffects: true }); continue;
      }
      if (step.tool) {
        await progress(step, step.action ? moveExpected() : {});
        if (step.code) { outcomes.push(await refusal(step, () => component.invoke(step.tool, step.arguments, abort.signal))); continue; }
        const before = live(component), value = result(await component.invoke(step.tool, step.arguments, abort.signal));
        assert.equal(value.ok, true);
        if (step.tool === "add_note") {
          assert.equal(value.slug, "TrashLifecycle/Owner");
          const after = live(component), old = new Set(before.noteReceipts.map(row => row.operation_id));
          const added = after.noteReceipts.filter(row => !old.has(row.operation_id));
          assert.equal(added.length, 1); state.collisionReceipt = added[0];
          const db = component.storage.connectNative();
          try {
            const commit = db.prepare("SELECT * FROM migration_runtime_knowledge_commits WHERE operation_id=?").get(added[0].operation_id);
            const request = JSON.parse(commit.request_json);
            assert.equal(request.actorId, "mcp:external"); assert.equal(request.operation, "knowledge.note.create");
            assert.equal(commit.workspace_id, component.workspaceId); assert.equal(commit.result_json, added[0].result);
            assert.equal(commit.digest, u.hash(JSON.stringify([commit.sequence, commit.workspace_id, commit.operation_id,
              commit.request_json, commit.plan_json, commit.result_json])));
            assert.equal(added[0].fingerprint, u.hash(JSON.stringify(request)));
          } finally { db.close(); }
        } else {
          contracts.originalNativeTrashMetadataSchema.parse(value.trash);
          if (!originalEntry) {
            originalEntry = value.trash;
            assert.deepEqual(await readFile(join(component.root, "notes/.trash", originalEntry.id, "payload")), state.raw);
            assert.deepEqual(await readFile(join(component.root, "notes/.trash", originalEntry.id, "assets/opaque.bin")), Buffer.from([255, 0, 128, 9]));
          } else collisionEntry = value.trash;
          assert.equal(live(component).trashReceipts.length, before.trashReceipts.length + 1);
        }
        outcomes.push({ stage: step.stage, ...(value.trash ? { entryId: value.trash.id } : { operationId: state.collisionReceipt.operation_id }) });
        continue;
      }
      if (step.stage === "native-trash-lifecycle-replay") {
        await progress(step); const before = await snapshot(component, custody);
        assert.equal(result(await canonical("knowledge.trash.restore", restoreArgs)).operationId, restoreArgs.operationId);
        assert.deepEqual(await snapshot(component, custody), before); outcomes.push({ stage: step.stage, replayNoEffects: true }); continue;
      }
      const operation = step.action === "list" ? "knowledge.trash.list" : "knowledge.trash.restore";
      const args = step.action === "list" ? { area: "notes", entryIds: [collisionEntry.id, state.rows.prior.id], operationId: randomUUID() }
        : { operationId: randomUUID(), entryId: originalEntry.id, expectedScanRevision: step.stage === "native-trash-lifecycle-stale"
          ? u.hash(`not-current:${lifecycle.previewTrashRestoreRevision(component.root)}`) : lifecycle.previewTrashRestoreRevision(component.root) };
      if (step.noReview) { await progress(step); outcomes.push(await refusal(step, () => canonical(operation, args))); continue; }
      const prepared = await planning.prepareOriginalTrashOperation(component.storage, host, { operation, actorId: "mcp:external", args });
      await progress(step, { subject: prepared.subject, arguments: args });
      if (step.code) { outcomes.push(await refusal(step, () => canonical(operation, args))); continue; }
      const value = result(await canonical(operation, args));
      if (step.action === "restore") {
        restoreArgs = args; assert.equal(value.action, "restore");
        const raw = await readFile(join(component.root, "notes", ownerPath)); assert.deepEqual(raw, state.raw);
        const decoded = markdown.decodeMarkdown(sourceFixture.owner.id, raw.toString("utf8"), ownerPath, "notes");
        assert.equal(decoded.metadata.get("knowledgeId"), state.rows.owner.knowledgeId); assert.equal(decoded.record.revision, state.rows.owner.revision);
        assert.deepEqual(await readFile(join(component.root, "notes", pairPath, "opaque.bin")), Buffer.from([255, 0, 128, 9]));
        assert.deepEqual(await readFile(join(component.root, ".pkm/state/knowledge-deletions.json")), state.history);
      } else assert.deepEqual(value.items.map(row => row.id).sort(), [...args.entryIds].sort());
      outcomes.push({ stage: step.stage, operationId: args.operationId });
    }
    await check(); const final = live(component);
    assert.equal(final.intents.length, 0); assert.equal(final.trashReceipts.length, 3); assert.equal(final.successors.length, 3);
    assert.equal(final.noteReceipts.length, state.initialNoteReceipts.length + 1);
    assert(!final.trashReceipts.some(row => row.operation_id === state.cancelledOperationId));
    const db = component.storage.connectNative();
    try {
      assert.equal(custody.readOriginalTrashSuccessors(db, component.workspaceId, component.root, component.custody.planSha256).transitions.length, 3);
      const active = db.prepare("SELECT entry_id FROM migration_runtime_trash WHERE workspace_id=?").all(component.workspaceId);
      assert.deepEqual(active.map(row => row.entry_id), [collisionEntry.id]);
      const indexed = db.prepare("SELECT id,revision,sha256,deleted FROM documents WHERE area='notes' AND path=?").get(ownerPath);
      assert.equal(indexed.id, sourceFixture.owner.id); assert.equal(indexed.revision, sourceFixture.owner.revision);
      assert.equal(indexed.sha256, sourceFixture.owner.sha256); assert.equal(indexed.deleted, 0);
    }
    finally { db.close(); }
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: "native-trash-lifecycle-complete" }), { mode: 0o600 });
    await ui.done; await check();
    const proof = JSON.parse(await readFile(join(root, "native-trash-lifecycle-ui-passed.json")));
    assert.equal(proof.passed, true); assert.equal(proof.runId, runId); assert.equal(proof.actualRenderedDom, true);
    assert.equal(proof.dialogs.length, 11); assert.equal(proof.transportAbortedBeforeLateClick, true);
    assert.equal(proof.lateClickSameModal, true);
    assert.deepEqual(proof.dialogs.map(row => ({ stage: row.stage, type: row.type, choice: row.choice })),
      installedNativeTrashLifecycleStages.flatMap(step => [
        ...(step.tool ? [{ stage: step.stage, type: "public", choice: step.publicChoice }] : []),
        ...(step.action ? [{ stage: step.stage, type: "trash", choice: step.choice }] : []),
      ]));
    assert(proof.dialogs.filter(row => row.type === "trash").every(row => row.defaultDenyFocused === true));
    for (const row of final.successors) {
      const transition = contracts.validateOriginalNativeTrashProvenance(JSON.parse(row.transition_json).provenance);
      const observed = proof.dialogs.find(dialog => dialog.type === "trash" && dialog.request.subject.operationId === transition.request.subject.operationId);
      assert(observed); assert.deepEqual(observed.request, transition.request); assert.equal(observed.requestSha256, transition.decision.requestSha256);
    }
    state.finalJournal = final; state.b1Knowledge = u.hashes(await u.files(component.root, true));
    state.oldComponent = component; state.custody = component.custody; state.binding = binding;
    state.payloadBuildId = payloadBuildId; state.hostEntrySha256 = u.hash(await readFile(join(installed, "dist/extension.cjs")));
    state.priorEpochs = [host.receipt.epoch];
    const evidence = { passed: true, actualNativeUi: true, scope: "disposable late native transport cancellation and canonical restore collision",
      actualTransportAbortBeforeLateNativeClick: true, lateNativeChoiceNoIntentReceiptOrEffect: true,
      sameCoreCanonicalCollisionCreateReceipt: true, destinationCollisionRefused: true, sharedPrivateReferrerRefused: true,
      staleSourceRefused: true, defaultEnterRestoreDenial: true, exactUuidReplayNoEffectsOrReview: true,
      trashMutationReceipts: 3, custodySuccessors: 3, canonicalCollisionCreateReceipts: 1, nativeModelRequestsInitiated: 0,
      collisionBucketRetainedForRecovery: true, priorReadonlyBucketAndPrivateStatePreserved: true,
      oldReadonlyBucketRestoreQualified: false, deleteSkillPaperQualified: false, installedPendingRecoveryQualified: false,
      faultInjectionUsed: false, b1AndB0Qualified: false, fullTrashParityQualified: false, fullCutoverQualified: false, outcomes };
    await writeFile(join(root, "native-trash-lifecycle-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
    state.phase = "verified"; return evidence;
  } finally { if (state.phase !== "verified") state.phase = "failed"; abort.abort(); await ui.stop(); }
}
/** Install this inert callback before bootstrap; only the explicit pending helper may arm it after verified lifecycle effects. */
export async function createInstalledNativeTrashLifecycleFaultController(sourceFixture) {
  const state = stateFor(sourceFixture);
  if (state.faultController) fail("INSTALLED_TRASH_FAULT_CONTROLLER_ALREADY_CREATED");
  const lifecycle = await u.load(state.installed, "trash-lifecycle");
  const value = Object.freeze({ kind: "pkm.installed-native-trash-fault-controller/v1" });
  const controller = { state, armed: false, used: false, operationId: undefined, component: undefined, faultInjector(point) {
    if (!controller.armed || controller.used) return;
    controller.component.storage.assertWorkspaceLease();
    const db = controller.component.storage.connectNative();
    let row;
    try {
      const rows = db.prepare("SELECT * FROM migration_runtime_intents").all();
      if (rows.length !== 1) fail("INSTALLED_TRASH_FAULT_EXACT_INTENT_REQUIRED");
      row = { ...rows[0] };
    } finally { db.close(); }
    const plan = lifecycle.deserializeTrashLifecyclePlan(row.plan_json);
    if (!plan.originalTrash || plan.actorId !== "mcp:external" || plan.area !== "notes" || plan.path !== ownerPath
      || plan.action !== "trash" || plan.documentPins[0]?.id !== sourceFixture.owner.id
      || plan.documentPins[0]?.sha256 !== sourceFixture.owner.sha256 || plan.moves[0]?.slot !== "assets"
      || plan.moves.length !== 2 || state.finalJournal.trashReceipts.some(receipt => receipt.operation_id === plan.operationId)
      || plan.operationId === state.cancelledOperationId)
      return;
    if (point === "intent") controller.operationId = plan.operationId;
    if (point !== "move-0") return;
    if (controller.operationId !== plan.operationId || lifecycle.inspectTrashLifecycleRecovery(state.componentFixture.root, plan) !== 1)
      fail("INSTALLED_TRASH_FAULT_PHYSICAL_PREFIX_REQUIRED");
    controller.used = true; controller.armed = false; controller.intent = row; controller.plan = plan;
    throw Object.assign(new Error("Owned disposable Trash paired-move interruption"), { code: "INSTALLED_TRASH_PAIRED_MOVE_INTERRUPTION" });
  } };
  faultControllers.set(value, controller); state.faultController = value; return value;
}
export function installedNativeTrashLifecycleFaultInjector(value) {
  const controller = faultControllers.get(value);
  if (!controller) fail("INSTALLED_TRASH_ACTUAL_FAULT_CONTROLLER_REQUIRED");
  return controller.faultInjector;
}
async function recoveryObserver(state, options, phase, choice) {
  const runId = randomUUID(), request = state.pendingPlan?.originalTrash.provenance.request;
  const binding = phase === "execute" ? state.binding : {
    ...state.binding, epoch: undefined, nativeHostReceiptSha256: undefined,
  };
  await writeFile(join(options.root, `native-trash-lifecycle-recovery-${runId}-ui-contract.json`), JSON.stringify({
    schema: "pkm.installed-native-trash-recovery-ui/v1", runId, phase, choice, binding,
    ...(request ? { subject: request.subject } : {}), original: options.sourceFixture.owner,
  }), { mode: 0o600, flag: "w" });
  const ui = await startInstalledNativeTrashLifecycleRecoveryUi({ ...options, runId });
  return { runId, ui };
}
export async function verifyInstalledNativeTrashLifecyclePending(options) {
  const { installed, component, sourceFixture, faultController } = options, state = stateFor(sourceFixture, "verified");
  const controller = faultControllers.get(faultController);
  if (!controller || controller.state !== state || controller.used || state.oldComponent !== component || state.installed !== installed)
    fail("INSTALLED_TRASH_PENDING_ACTUAL_FAULT_AND_COMPONENT_REQUIRED");
  const before = live(component), custody = await u.load(installed, "original-native-trash-custody");
  const lifecycle = await u.load(installed, "trash-lifecycle");
  const { ui, runId } = await recoveryObserver(state, options, "execute", "Move this exact Note to Trash once");
  const abort = new AbortController(); void ui.done.catch(error => abort.abort(error));
  try {
    await ui.ready; component.storage.assertWorkspaceLease(); controller.component = component; controller.armed = true;
    let failure;
    try { result(await component.invoke("delete_note", deleteOwner, abort.signal)); } catch (error) { failure = error; }
    assert(failure && controller.used, "Actual installed canonical callback must interrupt after the physical paired move.");
    const after = live(component);
    assert.equal(after.intents.length, 1); assert.deepEqual(after.trashReceipts, before.trashReceipts);
    assert.deepEqual(after.successors, before.successors);
    const intent = after.intents[0], plan = lifecycle.deserializeTrashLifecyclePlan(intent.plan_json);
    assert.equal(intent.operation_id, controller.operationId); assert.equal(lifecycle.inspectTrashLifecycleRecovery(component.root, plan), 1);
    assert.deepEqual(await readFile(join(component.root, "notes", ownerPath)), state.raw);
    assert.deepEqual(await readFile(join(component.root, "notes/.trash", plan.entryId, "assets/opaque.bin")), Buffer.from([255, 0, 128, 9]));
    await u.absent(join(component.root, "notes", pairPath), "INSTALLED_TRASH_PENDING_PAIR_STILL_ORIGINAL");
    assert.deepEqual(custody.originalTrashHistoryImage(component.root), state.history);
    await preservation(state, component.root); await ui.done;
    const proof = JSON.parse(await readFile(join(options.root, `native-trash-lifecycle-recovery-${runId}-ui-passed.json`)));
    assert.equal(proof.runId, runId); assert.equal(proof.passed, true);
    assert.equal(proof.defaultDenyFocused, true);
    assert.equal(proof.request.subject.operationId, intent.operation_id);
    assert.deepEqual(proof.request, plan.originalTrash.provenance.request);
    state.pendingIntent = intent; state.pendingPlan = plan; state.pendingKnowledge = await u.files(component.root, true);
    state.pendingHistory = custody.originalTrashHistoryImage(component.root); state.pendingJournal = after;
    state.phase = "pending";
    return { passed: true, actualInstalledFaultCallback: true, actualPhysicalMovePrefix: 1, operationId: intent.operation_id,
      noNewSuccessReceipt: true, noNewCustodySuccessor: true, installedRecoveryQualified: false };
  } finally { controller.armed = false; abort.abort(); await ui.stop(); }
}
/** Parent closes the complete previous editor before this same-plan reopen; no B0 recapture or fixture rebranding. */
export async function reopenInstalledNativeTrashLifecycleRecovery({ installed, sourceFixture, attachment }) {
  const state = stateFor(sourceFixture);
  if (!["pending", "denied"].includes(state.phase) || state.activeRecoveryEpoch || installed !== state.installed
    || attachment?.payloadBuildId !== state.payloadBuildId || attachment?.hostEntrySha256 !== state.hostEntrySha256)
    fail("INSTALLED_TRASH_RECOVERY_SAME_CANDIDATE_ORDER_REQUIRED");
  await state.oldComponent.close();
  assert.deepEqual(await u.files(state.componentFixture.root, true), state.pendingKnowledge);
  const roots = await u.load(installed, "original-mcp-root"), native = await u.load(installed, "original-mcp-native-bootstrap");
  const fence = await roots.acquireOriginalMcpRootFence(state.componentFixture.root);
  let bootstrap;
  try { bootstrap = await native.bootstrapOriginalMcpNativeRuntime({ plan: state.custody, writerFence: fence, attachment }); }
  catch (error) { await fence.release(); throw error; }
  const value = Object.freeze({ kind: "pkm.installed-native-trash-recovery-epoch/v1", bootstrap });
  recoveryEpochs.set(value, { state, bootstrap, closed: false }); state.activeRecoveryEpoch = value; return value;
}
export async function verifyInstalledNativeTrashLifecycleRecoveryEpoch(options) {
  const { installed, sourceFixture, epoch, decision } = options, state = stateFor(sourceFixture), entry = recoveryEpochs.get(epoch);
  if (!entry || entry.state !== state || entry.closed || state.activeRecoveryEpoch !== epoch || installed !== state.installed
    || decision === "deny" && state.phase !== "pending" || decision === "approve" && state.phase !== "denied"
    || !["deny", "approve"].includes(decision)) fail("INSTALLED_TRASH_ACTUAL_RECOVERY_EPOCH_REQUIRED");
  const native = await u.load(installed, "original-mcp-native-bootstrap"), custody = await u.load(installed, "original-native-trash-custody");
  native.assertOriginalMcpNativeRuntimeBootstrap(entry.bootstrap);
  assert.equal(entry.bootstrap.root, state.componentFixture.root); assert.equal(entry.bootstrap.workspaceId, state.workspaceId);
  assert.equal(entry.bootstrap.planSha256, state.custody.planSha256);
  const { ui, runId } = await recoveryObserver(state, options, "recover", decision === "deny" ? "Deny" : "Move this exact Note to Trash once");
  try {
    await ui.ready; let host, failure;
    try { host = await entry.bootstrap.complete({ enableModels: false }); } catch (error) { failure = error; }
    if (decision === "deny") { assert(failure); assert.equal(failure.code, "ORIGINAL_TRASH_DENIED"); }
    else if (failure) throw failure;
    await ui.done;
    const proof = JSON.parse(await readFile(join(options.root, `native-trash-lifecycle-recovery-${runId}-ui-passed.json`)));
    assert.equal(proof.runId, runId); assert.equal(proof.passed, true);
    assert.equal(proof.defaultDenyFocused, true);
    assert.equal(proof.defaultEnterDenial, decision === "deny");
    assert.equal(proof.request.phase, "recover"); assert.deepEqual(proof.request.subject, state.pendingPlan.originalTrash.provenance.request.subject);
    assert(!state.priorEpochs.includes(proof.request.nativeEpoch)); state.priorEpochs.push(proof.request.nativeEpoch);
    const current = live(entry.bootstrap);
    if (decision === "deny") {
      assert.deepEqual(current, state.pendingJournal); assert.deepEqual(await u.files(entry.bootstrap.root, true), state.pendingKnowledge);
      assert.deepEqual(custody.originalTrashHistoryImage(entry.bootstrap.root), state.pendingHistory);
      await preservation(state, entry.bootstrap.root); state.phase = "denied";
    } else {
      native.assertOriginalMcpNativeRuntimeBootstrap(entry.bootstrap, true);
      assert.equal(host.receipt.epoch, proof.request.nativeEpoch); assert.equal(host.receipt.receiptSha256, proof.request.nativeHostReceiptSha256);
      assert.equal(host.nativeChat, undefined); assert.equal(current.intents.length, 0);
      for (const provider of ["vscode", "openai-compatible", "azure-openai"])
        assert.equal(host.options.providerTransport.supports(provider), false);
      const receipts = current.trashReceipts.filter(row => row.operation_id === state.pendingIntent.operation_id);
      assert.equal(receipts.length, 1); assert.equal(receipts[0].fingerprint, state.pendingIntent.fingerprint);
      assert.equal(current.trashReceipts.length, state.pendingJournal.trashReceipts.length + 1);
      assert.equal(current.successors.length, state.pendingJournal.successors.length + 1);
      const transition = JSON.parse(current.successors.find(row => row.operation_id === state.pendingIntent.operation_id).transition_json);
      assert.deepEqual(transition.provenance.request, proof.request);
      assert.deepEqual(await readFile(join(entry.bootstrap.root, "notes/.trash", state.pendingPlan.entryId, "payload")), state.raw);
      assert.deepEqual(await readFile(join(entry.bootstrap.root, "notes/.trash", state.pendingPlan.entryId, "assets/opaque.bin")), Buffer.from([255, 0, 128, 9]));
      const db = entry.bootstrap.storage.connectNative();
      try { custody.readOriginalTrashSuccessors(db, state.workspaceId, entry.bootstrap.root, state.custody.planSha256); } finally { db.close(); }
      const full = await entry.bootstrap.owner.ensureFull(), recorded = JSON.parse(state.pendingIntent.request_json);
      const beforeReplay = live(entry.bootstrap);
      const replay = await full.runtime.core.dispatch("capability_call", {
        operation: recorded.operation, version: 1, arguments: recorded.args,
      }, { id: recorded.actorId, canWrite: true });
      assert.equal(replay.error, undefined, JSON.stringify(replay));
      assert.equal(replay.result.operationId, state.pendingIntent.operation_id);
      assert.deepEqual(live(entry.bootstrap), beforeReplay);
      state.finalJournal = current; state.b1Knowledge = u.hashes(await u.files(entry.bootstrap.root, true));
      state.b1History = custody.originalTrashHistoryImage(entry.bootstrap.root);
      await preservation(state, entry.bootstrap.root); state.recoveryVerified = true; state.phase = "verified";
    }
    return { passed: true, actualNativeUi: true, freshRecoveryEpoch: true, decision,
      operationId: state.pendingIntent.operation_id, originalUuidSingleReceipt: decision === "approve",
      installedRecoveryQualified: decision === "approve", fullTrashParityQualified: false };
  } finally { await ui.stop(); }
}
export async function closeInstalledNativeTrashLifecycleRecoveryEpoch(epoch) {
  const entry = recoveryEpochs.get(epoch);
  if (!entry || entry.closed) fail("INSTALLED_TRASH_ACTUAL_RECOVERY_EPOCH_REQUIRED");
  await entry.bootstrap.close(); entry.closed = true; entry.state.activeRecoveryEpoch = undefined;
}
export async function verifyInstalledNativeTrashLifecycleB1(sourceFixture, { retirement }) {
  const state = stateFor(sourceFixture, "verified");
  await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture, sourceRoot: sourceFixture.root,
    b0Sha256: state.b0Sha256 }, retirement);
  assert.deepEqual(u.hashes(await u.files(retirement.archive, true)), state.b1Knowledge); await preservation(state, retirement.archive);
  assert.deepEqual(await readFile(join(retirement.archive, ".pkm/state/knowledge-deletions.json")), state.b1History ?? state.history);
  const db = new DatabaseSync(join(retirement.archive, "core.sqlite"), { readOnly: true });
  try { assert.deepEqual(journal(db), state.finalJournal); } finally { db.close(); }
  return { originalNotePairAndCollisionBucketB1PositionsPreserved: true, exactCanonicalAndTrashReceiptsPreserved: true,
    historicalDecisionsNotCurrentGrants: true, installedPendingRecoveryQualified: state.recoveryVerified === true };
}
export async function verifyInstalledNativeTrashLifecycleRestored(sourceFixture, { retirement, restored }) {
  const state = stateFor(sourceFixture, "verified"), b1 = await verifyInstalledNativeTrashLifecycleB1(sourceFixture, { retirement });
  const expected = { componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 };
  const retired = await readInstalledKnowledgeMoveRetirementReceipt(expected, retirement);
  await readInstalledKnowledgeMoveRestoredReceipt(expected, retirement, restored, retired);
  assert.deepEqual(u.hashes(await u.files(restored.root)), u.hashes(state.baseline));
  for (const name of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-workspace", ".pkm-next-original-mcp.json", ".pkm-native"])
    await u.absent(join(restored.root, name), "INSTALLED_TRASH_LIFECYCLE_FRESH_B0_NATIVE_STATE_OR_GRANT");
  return { ...b1, freshB0OriginalBytesAndNoNativeGrant: true, originalRootOverwritten: false, fullTrashParityQualified: false };
}
