import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pinnedOriginalKnowledgeWriterFixture } from "../../tests/original-knowledge-writer-fixture.mjs";
import {
  installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u,
  assertInstalledKnowledgeMoveComponentBinding, readInstalledKnowledgeMoveRetirementReceipt,
  readInstalledKnowledgeMoveRestoredReceipt,
} from "./installed-native-knowledge-move.mjs";
import { startInstalledNativeTrashUi } from "./installed-native-trash-ui.mjs";

const preparations = new WeakMap(), ownerPath = "TrashFixture/Owner.md", assetPath = "TrashFixture/Owner.assets";
export const installedNativeTrashPrivacyPolicy = installedNativeKnowledgeMovePrivacyPolicy;
export const installedNativeTrashPublicRequest = Object.freeze({ tool: "delete_note",
  arguments: Object.freeze({ slug: "TrashFixture/Owner" }) });
export const installedNativeTrashStages = Object.freeze([
  { stage: "native-trash-public-deny", publicChoice: "Deny", code: "ACCESS_DENIED" },
  { stage: "native-trash-move-deny", action: "move", publicChoice: "Approve this request", choice: "Deny", code: "ORIGINAL_TRASH_DENIED" },
  { stage: "native-trash-move", action: "move", publicChoice: "Approve this request", choice: "Move this exact Note to Trash once" },
  { stage: "native-trash-list-deny", action: "list", choice: "Deny", code: "ORIGINAL_TRASH_DENIED" },
  { stage: "native-trash-list", action: "list", choice: "Read these exact Trash entries once" },
  { stage: "native-trash-restore-deny", action: "restore", choice: "Deny", code: "ORIGINAL_TRASH_DENIED" },
  { stage: "native-trash-restore-dismiss", action: "restore", choice: "Escape", code: "ORIGINAL_TRASH_DENIED" },
  { stage: "native-trash-stale-source", noReview: true, code: "CONFLICT" },
  { stage: "native-trash-restore", action: "restore", choice: "Restore this exact Note once" },
  { stage: "native-trash-replay", noReview: true },
  { stage: "native-trash-restored-list", action: "list", choice: "Read these exact Trash entries once" },
].map(Object.freeze));
const seed = `
  store.noteUpsert({slug:"TrashFixture/Owner",title:"Owner",category:"TrashFixture",type:"general",tags:["trash-fixture"],
    content:"DISPOSABLE_PUBLIC_TRASH_OWNER\\n![pair](Owner.assets/opaque.bin?q=1#view)\\n"
      +'<img src="Owner.assets/opaque.bin?html=1#image">\\n'
      +"[pair]: <Owner.assets/opaque.bin?definition=1#doc>\\n"});
  assets.saveMarkdownAsset(root,"notes","TrashFixture/Owner.md","opaque.bin",Buffer.from([255,0,128,9]));
  const first=store.noteGet("TrashFixture/Owner");
  store.noteUpsert({...first,tags:JSON.parse(first.tags),content:first.content+"Revision two.\\n"});
  store.noteUpsert({slug:"Private/TrashSentinel",title:"TrashSentinel",category:"Private",type:"general",
    content:"DISPOSABLE_PRIVATE_TRASH_SENTINEL\\n"});
  store.noteUpsert({slug:"TrashFixture/Archived",title:"Archived",category:"TrashFixture",type:"general",
    content:"DISPOSABLE_PREEXISTING_READONLY_TRASH\\n![prior](Archived.assets/prior.bin)\\n"});
  assets.saveMarkdownAsset(root,"notes","TrashFixture/Archived.md","prior.bin",Buffer.from([11,12,13]));
  const prior=store.knowledgePathMoveToTrash("notes","TrashFixture/Archived.md");
  return {owner:store.noteGet("TrashFixture/Owner"),prior};
`;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value, phase) {
  const state = preparations.get(value);
  if (!state) fail("INSTALLED_TRASH_ACTUAL_PREPARATION_REQUIRED");
  if (phase && state.phase !== phase) fail("INSTALLED_TRASH_VERIFIED_PHASE_REQUIRED");
  return state;
}
function noPrivate(value) {
  u.noPrivatePublication(value);
  assert(!JSON.stringify(value).includes("DISPOSABLE_PRIVATE_TRASH_SENTINEL"));
}
function reply(value) {
  noPrivate(value); assert.notEqual(value.isError, true, JSON.stringify(value));
  return value.structuredContent ?? JSON.parse(value.content[0].text);
}
function journal(database) {
  return {
    intents: database.prepare("SELECT * FROM migration_runtime_intents ORDER BY operation_id").all().map(row => ({ ...row })),
    receipts: database.prepare("SELECT * FROM receipts WHERE operation GLOB 'knowledge.trash.*' ORDER BY operation_id").all().map(row => ({ ...row })),
    successors: database.prepare("SELECT * FROM original_native_trash_commits ORDER BY sequence").all().map(row => ({ ...row })),
  };
}
function liveJournal(component) {
  const database = component.storage.connectNative();
  try { return journal(database); } finally { database.close(); }
}
export function installedNativeTrashCanonicalRequest(operation, arguments_) {
  const readOnly = operation === "knowledge.trash.list";
  if (!readOnly && operation !== "knowledge.trash.restore") fail("INSTALLED_TRASH_CANONICAL_OPERATION_REQUIRED");
  return { name: readOnly ? "legacy_capability_read" : "legacy_capability_call",
    input: { action: readOnly ? "read" : "call", args: { operation, version: 1, arguments: arguments_ } } };
}
/** The parent stops the complete editor and independently configures privacy before this pre-B0 seed. */
export async function prepareInstalledNativeTrashFixture({ installed, componentFixture, legacyVsix, python }) {
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (preparations.has(componentFixture)) fail("INSTALLED_TRASH_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    join(componentFixture.root, "core.sqlite"), join(componentFixture.root, ".pkm-next-original-mcp.json")])
    await u.absent(path, "INSTALLED_TRASH_PRE_B0_REQUIRED");
  if (!isAbsolute(python ?? "")) fail("INSTALLED_TRASH_EXPLICIT_PYTHON_REQUIRED");
  const privacyPath = join(componentFixture.root, ".pkm/content-privacy.json"), stat = await lstat(privacyPath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077));
  const privacyBytes = await readFile(privacyPath);
  assert.deepEqual(JSON.parse(privacyBytes), installedNativeTrashPrivacyPolicy, "Parent must independently configure exact Private top levels.");
  for (const area of ["notes", "skills", "papers"]) await mkdir(join(componentFixture.root, area), { recursive: true, mode: 0o700 });
  for (const path of ["notes/TrashFixture", "notes/Private/TrashSentinel.md", "notes/Private/TrashSentinel.assets"])
    await u.absent(join(componentFixture.root, path), "INSTALLED_TRASH_DISJOINT_SEED_REQUIRED");
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: componentFixture.directory, legacyVsix, python });
  const rows = writer.run(componentFixture.root, seed);
  assert.deepEqual(await readFile(privacyPath), privacyBytes);
  const baseline = await u.files(componentFixture.root);
  const raw = await readFile(join(componentFixture.root, "notes", ownerPath));
  const historyBytes = await readFile(join(componentFixture.root, ".pkm/state/knowledge-deletions.json"));
  const oracle = join(componentFixture.directory, "original-trash-oracle");
  // Original Note updated_at may derive from the file mtime; Trash must preserve it too.
  await cp(componentFixture.root, oracle, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  const oracleBefore = writer.run(oracle, `return store.noteGet("TrashFixture/Owner");`);
  assert.equal(oracleBefore.knowledgeId, rows.owner.knowledgeId); assert.equal(oracleBefore.revision, rows.owner.revision);
  const originalEntry = writer.run(oracle, `return store.knowledgePathMoveToTrash("notes","TrashFixture/Owner.md");`);
  assert.deepEqual(await readFile(join(oracle, "notes/.trash", originalEntry.id, "payload")), raw);
  assert.deepEqual(await readFile(join(oracle, "notes/.trash", originalEntry.id, "assets/opaque.bin")), Buffer.from([255, 0, 128, 9]));
  assert.deepEqual(writer.run(oracle, `return store.knowledgeTrashRestore("notes",input.id);`, { id: originalEntry.id }),
    { ok: true, path: ownerPath });
  assert.deepEqual(writer.run(oracle, `return store.noteGet("TrashFixture/Owner");`), oracleBefore);
  assert.deepEqual(await readFile(join(oracle, ".pkm/state/knowledge-deletions.json")), historyBytes);
  const value = Object.freeze({ kind: "pkm.installed-native-trash-fixture/v1", root: componentFixture.root,
    originalPackageSha256: writer.originalPackageSha256, privacySha256: u.hash(privacyBytes),
    original: Object.freeze({ id: rows.owner.knowledgeId, knowledgeId: rows.owner.knowledgeId, revision: rows.owner.revision,
      area: "notes", path: ownerPath, sha256: u.hash(raw) }),
    priorEntryId: rows.prior.id, originalReadonlyBucketRestoreQualified: false,
    files: Object.freeze(u.hashes(baseline).map(Object.freeze)) });
  const state = { installed, componentFixture, baseline, rows, raw, historyBytes, privacyBytes, value, phase: "prepared" };
  preparations.set(componentFixture, state); preparations.set(value, state); return value;
}
async function preservation(state, library) {
  const files = await u.files(library, true), prior = `notes/.trash/${state.rows.prior.id}/`;
  const protectedFiles = file => file.path.includes("/Private/") || file.path.startsWith(prior);
  assert.deepEqual(files.filter(protectedFiles), state.baseline.filter(protectedFiles));
  for (const file of state.baseline.filter(file => !["notes", "skills", "papers"].includes(file.path.split("/")[0])
    && file.path !== ".pkm/state/knowledge-deletions.json"))
    assert.deepEqual(await readFile(join(library, file.path)), file.bytes);
  if (state.beforeKnowledge) for (const file of state.beforeKnowledge.filter(file =>
    file.path !== `notes/${ownerPath}` && !file.path.startsWith(`notes/${assetPath}/`)))
    assert.deepEqual(await readFile(join(library, file.path)), file.bytes);
}
async function physical(component, custody) {
  const knowledge = await u.files(component.root, true), directories = new Set(["notes", "skills", "papers"]);
  for (const file of knowledge) {
    const parts = file.path.split("/");
    for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join("/"));
  }
  return { knowledge, directories: [...directories].sort().map(path => custody.originalTrashIdentity(component.root, path)),
    history: custody.originalTrashIdentity(component.root, ".pkm/state/knowledge-deletions.json") };
}
/** Owns the observer/reader only; never registers a producer, supplies a grant or closes the parent's owner. */
export async function verifyInstalledNativeTrash({ root, installed, component, sourceFixture, payloadBuildId,
  python, env, port, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture, "prepared");
  if (state.installed !== installed || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_TRASH_SAME_COMPONENT_REQUIRED");
  if (typeof component.invokeCanonical !== "function") fail("INSTALLED_TRASH_ACTUAL_CANONICAL_COMPONENT_REQUIRED");
  const { host, full } = await assertInstalledKnowledgeMoveComponentBinding({ root, installed, component,
    componentFixture: state.componentFixture, payloadBuildId });
  assert.equal(full.runtime.services.modelProvider, undefined, "This bounded Trash profile must keep native inference unavailable.");
  assert.equal(host.nativeChat, undefined);
  for (const provider of ["vscode", "openai-compatible", "azure-openai"])
    assert.equal(host.options.providerTransport.supports(provider), false);
  const contracts = await u.load(installed, "original-native-trash-contracts");
  const planning = await u.load(installed, "original-native-trash-planning");
  const native = await u.load(installed, "original-native-trash-native");
  const lifecycle = await u.load(installed, "trash-lifecycle");
  const markdown = await u.load(installed, "markdown");
  const custody = await u.load(installed, "original-native-trash-custody");
  const rootApi = await u.load(installed, "original-mcp-root");
  assert(native.getNativeOriginalTrashPort(component.storage, host), "Actual negotiated native method-25 port required.");
  const lease = { ...component.owner.workspaceLease() }, runId = randomUUID(), abort = new AbortController();
  state.beforeKnowledge = await u.files(component.root, true);
  state.b0Sha256 = component.b0.sha256; state.workspaceId = component.workspaceId;
  await preservation(state, component.root);
  const initial = liveJournal(component);
  assert.deepEqual(initial, { intents: [], receipts: [], successors: [] }, "Prelude must not create Trash effects or alter the fixture controls.");
  assert.deepEqual(await readFile(join(component.root, "notes", ownerPath)), state.raw);
  assert.deepEqual(await readFile(join(component.root, ".pkm/state/knowledge-deletions.json")), state.historyBytes);
  const binding = { root: component.root, workspaceId: component.workspaceId, catalogSha256: host.receipt.sourceCatalogSha256,
    profileSha256: host.receipt.profileSha256, custodyPlanSha256: component.custody.planSha256,
    privacySha256: component.custody.privacySha256, epoch: host.receipt.epoch,
    nativeHostReceiptSha256: host.receipt.receiptSha256 };
  const inventory = [
    ...custody.originalTrashTree(component.root, `notes/${assetPath}`),
    ...custody.originalTrashTree(component.root, `notes/${ownerPath}`),
  ];
  const removedPaths = [`notes/${ownerPath}`, `notes/${assetPath}/opaque.bin`];
  await writeFile(join(root, "native-trash-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-trash-ui/v1", runId, binding, stages: installedNativeTrashStages,
    publicRequest: installedNativeTrashPublicRequest, owner: sourceFixture.original, inventory, removedPaths,
    originalHistory: JSON.parse(state.historyBytes), originalHistorySha256: u.hash(state.historyBytes),
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativeTrashUi({ root, python, env, port, runId, timeoutMs });
  void ui.done.catch(error => abort.abort(error));
  const check = async () => {
    if (ui.error) throw ui.error;
    host.assertCurrent(); component.storage.assertWorkspaceLease();
    assert.deepEqual({ ...component.owner.workspaceLease() }, lease);
    const current = await component.owner.ensureFull();
    assert.equal(current.storage, component.storage); assert.equal(current.runtime.core, full.runtime.core);
    const database = component.storage.connectNative();
    try {
      const attached = database.prepare("PRAGMA database_list").all().filter(row => row.name !== "temp");
      assert.equal(attached.length, 1); assert.equal(attached[0].file, join(component.root, "core.sqlite"));
    } finally { database.close(); }
    await preservation(state, component.root);
    await component.storage.withWorkspaceExclusive(() => rootApi.validateOriginalMcpWorkspace(component.root));
  };
  const progress = async (step, next = {}) => {
    await writeFile(join(root, "native-trash-ui-next.json"), JSON.stringify({ stage: step.stage, ...next }), { mode: 0o600 });
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: step.stage }), { mode: 0o600 });
  };
  const canonical = (operation, args) => {
    const request = installedNativeTrashCanonicalRequest(operation, args);
    return component.invokeCanonical(request.name, request.input, abort.signal);
  };
  const noEffects = async (step, invoke) => {
    const before = await physical(component, custody), records = liveJournal(component);
    let error;
    try { const response = await invoke(); noPrivate(response);
      if (response.isError) error = Object.assign(new Error("Native operation refused"), { code: response.structuredContent?.code }); }
    catch (value) { error = value; }
    assert(error, "The exact native refusal must not report success.");
    assert.equal(error.code, step.code);
    assert.deepEqual(await physical(component, custody), before); assert.deepEqual(liveJournal(component), records);
    await check(); return { stage: step.stage, code: error.code };
  };
  const outcomes = [];
  let entry, restoreArgs;
  try {
    await ui.ready; await check();
    for (const step of installedNativeTrashStages) {
      await check();
      if (step.publicChoice) {
        await progress(step, { historyBeforeSha256: u.hash(state.historyBytes),
          predecessorSha256: component.custody.planSha256 });
        const invoke = () => component.invoke("delete_note", installedNativeTrashPublicRequest.arguments, abort.signal);
        if (step.code) { outcomes.push(await noEffects(step, invoke)); continue; }
        const result = reply(await invoke()); assert.equal(result.ok, true);
        entry = result.trash; contracts.originalNativeTrashMetadataSchema.parse(entry);
        assert.equal(entry.originalPath, ownerPath);
        assert.deepEqual(await readFile(join(component.root, "notes/.trash", entry.id, "payload")), state.raw);
        assert.deepEqual(await readFile(join(component.root, "notes/.trash", entry.id, "assets/opaque.bin")), Buffer.from([255, 0, 128, 9]));
        await u.absent(join(component.root, "notes", ownerPath), "INSTALLED_TRASH_SOURCE_REMAINED");
        await u.absent(join(component.root, "notes", assetPath), "INSTALLED_TRASH_PAIR_REMAINED");
        const history = JSON.parse(await readFile(join(component.root, ".pkm/state/knowledge-deletions.json")));
        assert.deepEqual(history.records, [...JSON.parse(state.historyBytes).records,
          ...removedPaths.map(path => ({ path, deletedAt: entry.deletedAt }))]);
        assert.equal(liveJournal(component).receipts.length, 1); assert.equal(liveJournal(component).successors.length, 1);
        outcomes.push({ stage: step.stage, entryId: entry.id }); continue;
      }
      if (step.stage === "native-trash-stale-source") {
        const args = { operationId: randomUUID(), entryId: entry.id,
          expectedScanRevision: u.hash(`not-current:${lifecycle.previewTrashRestoreRevision(component.root)}`) };
        await progress(step); outcomes.push(await noEffects(step, () => canonical("knowledge.trash.restore", args))); continue;
      }
      if (step.stage === "native-trash-replay") {
        await progress(step);
        const before = await physical(component, custody), records = liveJournal(component);
        const result = reply(await canonical("knowledge.trash.restore", restoreArgs));
        assert.equal(result.operationId, restoreArgs.operationId); assert.equal(result.action, "restore");
        assert.deepEqual(await physical(component, custody), before); assert.deepEqual(liveJournal(component), records);
        outcomes.push({ stage: step.stage, operationId: restoreArgs.operationId, replayNoEffects: true }); continue;
      }
      const operation = `knowledge.trash.${step.action}`;
      const args = step.action === "list" ? { area: "notes",
        entryIds: step.stage === "native-trash-restored-list" ? [state.rows.prior.id] : [entry.id, state.rows.prior.id],
        operationId: randomUUID() }
        : { operationId: randomUUID(), entryId: entry.id, expectedScanRevision: lifecycle.previewTrashRestoreRevision(component.root) };
      const request = { operation, actorId: "mcp:external", args };
      const prepared = await planning.prepareOriginalTrashOperation(component.storage, host, request);
      await progress(step, { arguments: args, subject: prepared.subject });
      if (step.code) { outcomes.push(await noEffects(step, () => canonical(operation, args))); continue; }
      const before = liveJournal(component), result = reply(await canonical(operation, args));
      if (step.action === "list") {
        assert.deepEqual(result.items.map(row => row.id).sort(), [...args.entryIds].sort());
        assert.deepEqual(liveJournal(component), before);
      } else {
        restoreArgs = args;
        assert.equal(result.action, "restore"); assert.equal(result.entryId, entry.id);
        assert.deepEqual(await readFile(join(component.root, "notes", ownerPath)), state.raw);
        assert.deepEqual(await readFile(join(component.root, "notes", assetPath, "opaque.bin")), Buffer.from([255, 0, 128, 9]));
        assert.deepEqual(await readFile(join(component.root, ".pkm/state/knowledge-deletions.json")), state.historyBytes);
        const read = reply(await component.invoke("get_note", installedNativeTrashPublicRequest.arguments, abort.signal));
        const restoredDocument = markdown.decodeMarkdown(state.rows.owner.knowledgeId,
          (await readFile(join(component.root, "notes", ownerPath))).toString("utf8"), ownerPath, "notes");
        assert.equal(restoredDocument.metadata.get("knowledgeId"), state.rows.owner.knowledgeId);
        assert.equal(restoredDocument.record.revision, state.rows.owner.revision);
        assert.equal(read.content, state.rows.owner.content);
        assert.equal(Date.parse(read.updated_at), Date.parse(state.rows.owner.updated_at));
      }
      outcomes.push({ stage: step.stage, operationId: args.operationId });
    }
    await check();
    const final = liveJournal(component);
    assert.equal(final.intents.length, 0); assert.equal(final.receipts.length, 2); assert.equal(final.successors.length, 2);
    const database = component.storage.connectNative();
    try {
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM migration_runtime_trash WHERE workspace_id=?").get(component.workspaceId).n, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM migration_runtime_trash_origins WHERE workspace_id=?").get(component.workspaceId).n, 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM migration_runtime_trash_restores WHERE workspace_id=?").get(component.workspaceId).n, 1);
      const successors = custody.readOriginalTrashSuccessors(database, component.workspaceId, component.root, component.custody.planSha256);
      assert.equal(successors.transitions.length, 2);
      state.transitions = successors.transitions;
    } finally { database.close(); }
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: "native-trash-complete" }), { mode: 0o600 });
    await ui.done; await check();
    const proof = JSON.parse(await readFile(join(root, "native-trash-ui-passed.json")));
    assert.equal(proof.passed, true); assert.equal(proof.actualRenderedDom, true); assert.equal(proof.runId, runId);
    assert.equal(proof.dialogs.length, 11);
    assert.deepEqual(proof.dialogs.map(row => ({ stage: row.stage, type: row.type, choice: row.choice })),
      installedNativeTrashStages.flatMap(step => [
        ...(step.publicChoice ? [{ stage: step.stage, type: "public", choice: step.publicChoice }] : []),
        ...(step.action ? [{ stage: step.stage, type: "trash", choice: step.choice }] : []),
      ]));
    assert(proof.dialogs.filter(row => row.type === "trash").every(row => row.defaultDenyFocused === true));
    for (const transition of state.transitions) {
      const observed = proof.dialogs.find(row => row.type === "trash" && row.request.subject.operationId === transition.operationId);
      assert(observed); assert.deepEqual(observed.request.subject, transition.provenance.request.subject);
      assert.equal(observed.requestSha256, transition.provenance.decision.requestSha256);
      const { provenance, ...body } = transition;
      assert.equal(contracts.originalNativeTrashDigest(body), provenance.request.subject.transitionSha256);
    }
    state.receipts = final.receipts.map(row => ({ ...row })); state.successors = final.successors.map(row => ({ ...row }));
    state.b1Knowledge = u.hashes(await u.files(component.root, true));
    const evidence = { passed: true, actualNativeUi: true, scope: "one disposable post-admission public Note/owned-pair Trash lifecycle",
      originalPackageSha256: sourceFixture.originalPackageSha256, publicNativeChoices: 3, separateTrashNativeChoices: 8,
      defaultEnterTrashDenials: 3, installedModalDismissalRefused: true, installedTransportCancellationQualified: false,
      sameOwnerLeaseAndCoreDatabase: true, exactOriginalRawKnowledgeIdRevisionPairHistory: true,
      originalReadonlyBucketPreserved: true, originalReadonlyBucketRestoreQualified: false,
      privateDataAndControlsPreserved: true, staleSourceCasRefused: true, installedDestinationCollisionQualified: false,
      exactCanonicalUuidReplayNoEffectsOrReview: true, trashMutationReceipts: 2, custodySuccessors: 2,
      mutationOperationIds: state.receipts.map(row => row.operation_id),
      custodySuccessorDigests: state.successors.map(row => row.digest),
      nativeModelChannelUnavailable: true,
      nativeModelRequestsInitiated: 0, installedPendingRecoveryQualified: false, interruptionInjectionUsed: false,
      b1AndB0Qualified: false, fullTrashParityQualified: false, fullCutoverQualified: false, outcomes };
    await writeFile(join(root, "native-trash-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
    state.phase = "verified";
    return evidence;
  } finally { if (state.phase !== "verified") state.phase = "failed"; abort.abort(); await ui.stop(); }
}
export async function verifyInstalledNativeTrashB1(sourceFixture, { retirement }) {
  const state = stateFor(sourceFixture, "verified");
  await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture, sourceRoot: sourceFixture.root,
    b0Sha256: state.b0Sha256 }, retirement);
  assert.deepEqual(u.hashes(await u.files(retirement.archive, true)), state.b1Knowledge);
  await preservation(state, retirement.archive);
  assert.deepEqual(await readFile(join(retirement.archive, ".pkm/state/knowledge-deletions.json")), state.historyBytes);
  const database = new DatabaseSync(join(retirement.archive, "core.sqlite"), { readOnly: true });
  try {
    const actual = journal(database);
    assert.equal(actual.intents.length, 0);
    assert.deepEqual(actual.receipts, state.receipts); assert.deepEqual(actual.successors, state.successors);
  } finally { database.close(); }
  return { restoredNotePairReadonlyBucketAndPrivateB1Preserved: true, exactTrashReceiptsAndSuccessorsPreserved: true,
    historicalDecisionsNotCurrentGrant: true, installedPendingRecoveryQualified: false };
}
export async function verifyInstalledNativeTrashRestored(sourceFixture, { retirement, restored }) {
  const state = stateFor(sourceFixture, "verified"), b1 = await verifyInstalledNativeTrashB1(sourceFixture, { retirement });
  const expected = { componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 };
  const retired = await readInstalledKnowledgeMoveRetirementReceipt(expected, retirement);
  await readInstalledKnowledgeMoveRestoredReceipt(expected, retirement, restored, retired);
  assert.deepEqual(u.hashes(await u.files(restored.root)), u.hashes(state.baseline));
  for (const path of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-workspace",
    ".pkm-next-original-mcp.json", ".pkm-native"])
    await u.absent(join(restored.root, path), "INSTALLED_TRASH_FRESH_B0_NATIVE_STATE_OR_GRANT");
  return { ...b1, allOriginalTrashB0BytesRestored: true, freshB0NoNativeDatabaseOrGrant: true,
    originalRootOverwritten: false, fullTrashParityQualified: false, fullCutoverQualified: false };
}
