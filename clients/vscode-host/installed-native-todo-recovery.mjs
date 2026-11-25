import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pinnedOriginalKnowledgeWriterFixture } from "../../tests/original-knowledge-writer-fixture.mjs";
import { installedKnowledgeMoveFixtureUtilities as u, assertInstalledKnowledgeMoveComponentBinding,
  readInstalledKnowledgeMoveRetirementReceipt, readInstalledKnowledgeMoveRestoredReceipt } from "./installed-native-knowledge-move.mjs";
import { startInstalledNativeTodoRecoveryUi, installedNativeTodoRecoveryStages } from "./installed-native-todo-recovery-ui.mjs";

const preparations = new WeakMap(), controllers = new WeakMap(), epochs = new WeakMap();
const creationArguments = Object.freeze({ title: "InstalledPendingGenesis", category: "Team" });
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value) {
  const state = preparations.get(value);
  if (!state) fail("INSTALLED_TODO_RECOVERY_ACTUAL_PREPARATION_REQUIRED");
  return state;
}
function journal(db) {
  return { pending: db.prepare("SELECT * FROM original_todo_genesis_pending ORDER BY operation_id").all(),
    compound: db.prepare("SELECT * FROM pending_todo").all(),
    sources: db.prepare("SELECT * FROM original_todo_genesis_sources ORDER BY board_slug").all(),
    receipts: db.prepare("SELECT * FROM receipts WHERE operation LIKE 'todo.%' ORDER BY rowid").all(),
    documents: db.prepare("SELECT * FROM documents ORDER BY id").all(),
    importManifests: Object.fromEntries(["original_mcp_domain_intents", "original_mcp_domain_commits", "original_mcp_domain_workers"].map(table =>
      [table, db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
        ? db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() : []])) };
}
function live(component) {
  const db = component.storage.connectNative();
  try { return journal(db); } finally { db.close(); }
}
async function protectedImage(state, root) {
  return Promise.all(state.protectedPaths.map(async path => ({ path, sha256: u.hash(await readFile(join(root, path))) })));
}
async function snapshot(state, root) {
  return { knowledge: u.hashes(await u.files(root, true)),
    canonical: await Promise.all([state.value.paths.canonicalBoardPath].map(async path => {
      try { return { path, sha256: u.hash(await readFile(join(root, path))) }; }
      catch (error) { if (error.code !== "ENOENT") throw error; return { path, absent: true }; }
    })), controls: await protectedImage(state, root) };
}
async function waitJson(path, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { return JSON.parse(await readFile(path)); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  fail("INSTALLED_TODO_RECOVERY_EVIDENCE_TIMEOUT");
}
async function directoryIdentity(root, path) {
  const stat = await lstat(join(root, path), { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid()) || Number(stat.mode) & 0o7077)
    fail("INSTALLED_TODO_RECOVERY_CURRENT_DIRECTORY_REQUIRED");
  return { path, device: String(stat.dev), inode: String(stat.ino), uid: String(stat.uid), mode: Number(stat.mode) & 0o777 };
}
async function recoverySelection(state) {
  const plan = state.plan, root = state.value.root, s = structuredClone(plan.request.selection);
  s.ancestors = await Promise.all(s.ancestors.map(item => directoryIdentity(root, item.path)));
  s.managedAncestors = await Promise.all(s.managedAncestors.map(async item =>
    ({ path: item.path, state: "present", identity: await directoryIdentity(root, item.path) })));
  const pair = await directoryIdentity(root, s.pairPath), canonical = await directoryIdentity(root, dirname(s.canonicalBoardPath));
  s.expectedBefore = { note: { state: "present", sha256: s.descriptorSha256 },
    backing: { state: "present", sha256: s.backingSha256 },
    pair: { state: "present", sha256: state.digest({ identity: pair, files: [{ name: "pkm-todo-board.json", sha256: s.backingSha256 }] }) },
    canonicalBoard: { state: "absent" }, canonicalDirectory: { state: "present", sha256: state.digest({ identity: canonical, files: [] }) },
    sourceIndex: "absent" };
  return s;
}

/** Parent's original common seed remains untouched; this oracle has its own extraction and Root. */
export async function prepareInstalledNativeTodoRecoveryFixture({ installed, componentFixture, legacyVsix, python }) {
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (preparations.has(componentFixture)) fail("INSTALLED_TODO_RECOVERY_ALREADY_PREPARED");
  for (const path of ["core.sqlite", ".pkm-next-workspace", ".pkm-next-original-mcp.json", ".pkm-next-todo", "boards"])
    await u.absent(join(componentFixture.root, path), "INSTALLED_TODO_RECOVERY_PRE_B0_REQUIRED");
  for (const path of ["b0", "custody"]) await u.absent(join(componentFixture.directory, path), "INSTALLED_TODO_RECOVERY_PRE_B0_REQUIRED");
  await mkdir(join(componentFixture.root, "papers"), { recursive: true, mode: 0o700 });
  await mkdir(join(componentFixture.root, "notes/Team"), { recursive: true, mode: 0o700 });
  await u.privateDirectory(join(componentFixture.root, "notes/Team"), "INSTALLED_TODO_RECOVERY_PUBLIC_CATEGORY_REQUIRED");
  const boardSlug = `${creationArguments.category}/${creationArguments.title}`;
  const paths = Object.freeze({ notePath: `notes/${boardSlug}.md`, pairPath: `notes/${boardSlug}.assets`,
    backingPath: `notes/${boardSlug}.assets/pkm-todo-board.json`,
    canonicalBoardPath: `.pkm-next-todo/${boardSlug}/pkm-todo-board.json` });
  for (const path of Object.values(paths)) await u.absent(join(componentFixture.root, path), "INSTALLED_TODO_RECOVERY_DISJOINT_BOARD_REQUIRED");
  const oracleDirectory = join(componentFixture.directory, "todo-recovery-oracle-fixture");
  await mkdir(oracleDirectory, { mode: 0o700 });
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: oracleDirectory, legacyVsix, python });
  const oracleRoot = join(oracleDirectory, "root"); await mkdir(oracleRoot, { mode: 0o700 });
  const original = writer.run(oracleRoot,
    "return store.todoBoardCreate(input.slug,input.title,input.category);", { slug: boardSlug, ...creationArguments });
  assert.deepEqual(original.items, []);
  const protectedPaths = ["notes/Entry.md", "skills/Base.md", ".pkm/content-privacy.json"];
  const privacy = await readFile(join(componentFixture.root, ".pkm/content-privacy.json"));
  assert.deepEqual(JSON.parse(privacy), { schema: 1, private: { notes: ["Private"] } });
  const baseline = await u.files(componentFixture.root);
  const value = Object.freeze({ kind: "pkm.installed-native-todo-recovery-fixture/v1",
    root: componentFixture.root, boardSlug, creationArguments, paths,
    privacySha256: u.hash(privacy), originalPackageSha256: writer.originalPackageSha256 });
  const state = { value, installed, componentFixture, baseline, protectedPaths, writer, oracleRoot, oracleDirectory, python,
    phase: "prepared", priorEpochs: [] };
  preparations.set(value, state); preparations.set(componentFixture, state); return value;
}
export function createInstalledNativeTodoRecoveryFaultController(sourceFixture) {
  const state = stateFor(sourceFixture);
  if (state.controller || state.phase !== "prepared") fail("INSTALLED_TODO_RECOVERY_CONTROLLER_ORDER_REQUIRED");
  const value = Object.freeze({ kind: "pkm.installed-native-todo-recovery-controller/v1" });
  const controller = { state, armed: false, used: false, callback(checkpoint) {
    if (!controller.armed || controller.used || state.oldComponent?.root !== checkpoint.root)
      fail("INSTALLED_TODO_RECOVERY_UNARMED_CHECKPOINT");
    state.oldComponent.storage.assertWorkspaceLease();
    const image = live(state.oldComponent);
    assert.equal(image.pending.length, 1); assert.equal(image.compound.length, 1);
    const plan = JSON.parse(image.pending[0].creation_plan), r = plan.request, s = r.selection;
    assert.equal(r.phase, "create"); assert.equal(r.root, sourceFixture.root); assert.equal(r.workspaceId, state.workspaceId);
    assert.equal(r.operationId, checkpoint.operationId); assert.equal(plan.planSha256, checkpoint.planSha256);
    assert.equal(state.digest(r), checkpoint.requestSha256);
    assert.equal(checkpoint.point, "durable-note-and-backing-before-canonical");
    assert.equal(s.boardSlug, sourceFixture.boardSlug); assert.deepEqual(r.arguments, sourceFixture.creationArguments);
    assert.equal(image.compound[0].operation_id, r.operationId); assert.equal(image.compound[0].operation, "todo.board.create+signed-genesis");
    assert.equal(u.hash(readFileSync(join(sourceFixture.root, s.notePath))), s.descriptorSha256);
    assert.equal(u.hash(readFileSync(join(sourceFixture.root, s.backingPath))), s.backingSha256);
    assert.equal(existsSync(join(sourceFixture.root, s.canonicalBoardPath)), false);
    assert.deepEqual(image.sources, state.before.sources); assert.deepEqual(image.receipts, state.before.receipts);
    assert.deepEqual(image.documents, state.before.documents); assert.deepEqual(image.importManifests, state.before.importManifests);
    controller.used = true; controller.armed = false; controller.checkpoint = checkpoint; state.plan = plan;
  } };
  controllers.set(value, controller); state.controller = value; return value;
}
export function installedNativeTodoRecoveryFaultInjector(value) {
  const controller = controllers.get(value);
  if (!controller) fail("INSTALLED_TODO_RECOVERY_ACTUAL_CONTROLLER_REQUIRED");
  return controller.callback;
}
async function observer(state, options, decision, runId) {
  const contract = { schema: "pkm.installed-native-todo-recovery-ui/v1", runId, decision,
    binding: { root: state.value.root, workspaceId: state.workspaceId, profileSha256: state.custody.profileSha256,
      custodyPlanSha256: state.custody.planSha256, catalogSha256: state.catalogSha256, privacySha256: state.value.privacySha256 },
    creationArguments: state.value.creationArguments, boardSlug: state.value.boardSlug, paths: state.value.paths,
    ...(decision === "create" ? {} : { operationId: state.plan.request.operationId, selection: await recoverySelection(state) }) };
  await writeFile(join(options.root, `native-todo-recovery-${runId}-ui-contract.json`), JSON.stringify(contract), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativeTodoRecoveryUi({ ...options, decision, runId });
  return ui;
}
async function hostWitness(state, root, target, runId, timeoutMs) {
  const descriptorBytes = await readFile(target.attachmentDescriptorPath), descriptor = JSON.parse(descriptorBytes);
  assert.equal(u.hash(descriptorBytes), target.attachmentDescriptorSha256);
  for (const [key, value] of Object.entries({ root: state.value.root, workspaceId: state.workspaceId,
    planSha256: state.custody.planSha256, profileSha256: state.custody.profileSha256,
    payloadBuildId: state.payloadBuildId, hostEntrySha256: state.hostEntrySha256, catalogSha256: state.catalogSha256 }))
    assert.equal(descriptor.binding[key], value);
  assert.equal(descriptor.identitySha256, state.identitySha256);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const db = target.storage.connectNative();
    let rows;
    try { rows = db.prepare("SELECT payload FROM original_mcp_native_host_admissions WHERE json_extract(payload,'$.authorityId')=?")
      .all(`native-rpc:${descriptor.brokerId}`); } finally { db.close(); }
    if (rows.length) {
      assert.equal(rows.length, 1);
      const receipt = JSON.parse(rows[0].payload), { receiptSha256, ...binding } = receipt;
      assert.equal(state.digest(binding), receiptSha256);
      assert(!state.priorEpochs.includes(receipt.epoch), "Fresh whole-editor epoch must never reuse a previous authority.");
      const value = { runId, epoch: receipt.epoch, receiptSha256, authorityId: receipt.authorityId };
      await writeFile(join(root, `native-todo-recovery-${runId}-host.json`), JSON.stringify(value), { mode: 0o600, flag: "wx" });
      return value;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  fail("INSTALLED_TODO_RECOVERY_ACTUAL_HOST_TIMEOUT");
}
export async function verifyInstalledNativeTodoRecoveryPending(options) {
  const { installed, sourceFixture, component, payloadBuildId, faultController, root, timeoutMs = 120000 } = options;
  const state = stateFor(sourceFixture), controller = controllers.get(faultController);
  if (state.phase !== "prepared" || !controller || controller.state !== state || controller.used || installed !== state.installed)
    fail("INSTALLED_TODO_RECOVERY_PENDING_ORDER_REQUIRED");
  const { host, first } = await assertInstalledKnowledgeMoveComponentBinding({ ...options, componentFixture: state.componentFixture });
  state.digest = (await u.load(installed, "original-mcp-todo-genesis-contracts")).originalMcpTodoGenesisRequestDigest;
  state.oldComponent = component; state.custody = component.custody; state.workspaceId = component.workspaceId;
  state.catalogSha256 = host.receipt.sourceCatalogSha256; state.payloadBuildId = payloadBuildId;
  state.hostEntrySha256 = u.hash(await readFile(join(installed, "dist/extension.cjs")));
  state.identitySha256 = first.result.sha256; state.b0Sha256 = component.b0.sha256;
  state.before = live(component); state.leafControls = await protectedImage(state, sourceFixture.root);
  assert.equal(state.before.pending.length, 0); assert.equal(state.before.sources.length, 0); assert.equal(state.before.receipts.length, 0);
  const runId = randomUUID(), ui = await observer(state, options, "create", runId);
  const abort = new AbortController(); void ui.done.catch(error => abort.abort(error));
  try {
    await ui.ready;
    const witness = await hostWitness(state, root, component, runId, timeoutMs);
    controller.armed = true;
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: installedNativeTodoRecoveryStages.create }), { mode: 0o600 });
    let failure;
    try { await component.invoke("todo_board_create", creationArguments, abort.signal); } catch (error) { failure = error; }
    assert.equal(failure?.code, "TODO_GENESIS_EXPERIMENTAL_FAULT"); assert.equal(failure.effect, "unknown"); assert(controller.used);
    assert.deepEqual(failure.experimentalTodoGenesisCheckpoint, controller.checkpoint);
    const current = live(component);
    assert.deepEqual(current.documents, state.before.documents); assert.deepEqual(current.receipts, state.before.receipts);
    assert.deepEqual(current.sources, state.before.sources); assert.deepEqual(current.importManifests, state.before.importManifests);
    const db = component.storage.connectNative();
    try {
      const transitions = (await u.load(installed, "original-mcp-todo-genesis")).readOriginalMcpTodoGenesisCustodyTransitions(component.root, db);
      assert.equal(transitions.length, 1); assert.equal(transitions[0].status, "pending"); assert.equal(transitions[0].temporary.length, 0);
    } finally { db.close(); }
    await ui.done;
    const proof = await waitJson(join(root, `native-todo-recovery-${runId}-ui-passed.json`));
    assert.equal(proof.passed, true); assert.equal(proof.defaultDenyFocused, true); assert.deepEqual(proof.request, state.plan.request);
    assert.equal(proof.request.nativeEpoch, witness.epoch); assert.equal(proof.request.nativeHostReceiptSha256, witness.receiptSha256);
    state.priorEpochs.push(witness.epoch); state.pendingJournal = current; state.pendingImage = await snapshot(state, component.root);
    assert.deepEqual(state.pendingImage.controls, state.leafControls); state.phase = "pending";
    return { passed: true, runId, sourceRoot: component.root, operationId: state.plan.request.operationId,
      sourceId: state.plan.request.selection.sourceId, actualWorkerConfirmedCheckpoint: controller.checkpoint,
      failure: { code: failure.code, effect: failure.effect },
      noteSha256: state.plan.request.selection.descriptorSha256,
      backingSha256: state.plan.request.selection.backingSha256,
      pendingLedgerSha256: u.hash(JSON.stringify(current.pending)),
      pendingIntentCount: current.pending.length, compoundIntentCount: current.compound.length,
      creationReceiptCount: current.receipts.length, sourceLedgerCount: current.sources.length,
      partialPhysicalPrefix: ["note", "backing"], noCanonicalOrDocumentOrSourceOrCreationReceipt: true,
      actualRenderedDom: true, runtimePendingEffectsQualified: true, installedRecoveryQualified: false,
      b1AndRestoredQualified: false, fullCutoverQualified: false };
  } finally {
    if (state.phase !== "pending") state.phase = "failed";
    controller.armed = false; abort.abort(); await ui.stop();
  }
}
/** Requires the original component closed plus the unchanged strict Linux writer guard; never captures B0 again. */
export async function reopenInstalledNativeTodoRecovery({ installed, sourceFixture, attachment }) {
  const state = stateFor(sourceFixture);
  if (!["pending", "denied"].includes(state.phase) || state.activeEpoch || installed !== state.installed
    || attachment.payloadBuildId !== state.payloadBuildId || attachment.hostEntrySha256 !== state.hostEntrySha256
    || attachment.identitySha256 !== state.identitySha256) fail("INSTALLED_TODO_RECOVERY_SAME_CANDIDATE_REQUIRED");
  assert.throws(() => state.oldComponent.owner.workspaceLease(), "Old component and all its readers must actually be closed.");
  assert.deepEqual(await snapshot(state, sourceFixture.root), state.pendingImage);
  const roots = await u.load(installed, "original-mcp-root"), native = await u.load(installed, "original-mcp-native-bootstrap");
  const fence = await roots.acquireOriginalMcpRootFence(sourceFixture.root);
  let bootstrap;
  try { bootstrap = await native.bootstrapOriginalMcpNativeRuntime({ plan: state.custody, writerFence: fence, attachment }); }
  catch (error) { await fence.release(); throw error; }
  const value = Object.freeze({ kind: "pkm.installed-native-todo-recovery-epoch/v1", bootstrap });
  epochs.set(value, { state, bootstrap, closed: false }); state.activeEpoch = value; return value;
}
export async function verifyInstalledNativeTodoRecoveryEpoch(options) {
  const { installed, sourceFixture, epoch, decision, root, runId = randomUUID(), timeoutMs = 120000 } = options;
  const state = stateFor(sourceFixture), entry = epochs.get(epoch);
  if (!entry || entry.state !== state || entry.closed || state.activeEpoch !== epoch || installed !== state.installed
    || decision === "deny" && state.phase !== "pending" || decision === "approve" && state.phase !== "denied"
    || !["deny", "approve"].includes(decision)) fail("INSTALLED_TODO_RECOVERY_ACTUAL_EPOCH_REQUIRED");
  const native = await u.load(installed, "original-mcp-native-bootstrap");
  native.assertOriginalMcpNativeRuntimeBootstrap(entry.bootstrap);
  const ui = await observer(state, options, decision, runId);
  let verified = false;
  try {
    await ui.ready;
    const completion = entry.bootstrap.complete({ enableModels: false }).then(host => ({ host }), error => ({ error }));
    const witness = await hostWitness(state, root, entry.bootstrap, runId, timeoutMs);
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: installedNativeTodoRecoveryStages[decision] }), { mode: 0o600 });
    const settled = await completion;
    if (decision === "deny") assert.equal(settled.error?.code, "TODO_GENESIS_DENIED");
    else if (settled.error) throw settled.error;
    await ui.done;
    const proof = await waitJson(join(root, `native-todo-recovery-${runId}-ui-passed.json`));
    assert.equal(proof.passed, true); assert.equal(proof.defaultDenyFocused, true);
    assert.equal(proof.defaultEnterDenial, decision === "deny");
    assert.equal(proof.request.phase, "recover"); assert.equal(proof.request.operationId, state.plan.request.operationId);
    assert.equal(proof.request.nativeEpoch, witness.epoch); assert.equal(proof.request.nativeHostReceiptSha256, witness.receiptSha256);
    state.priorEpochs.push(witness.epoch);
    const current = live(entry.bootstrap);
    if (decision === "deny") {
      assert.deepEqual(current, state.pendingJournal); assert.deepEqual(await snapshot(state, sourceFixture.root), state.pendingImage);
      state.phase = "denied";
    } else {
      native.assertOriginalMcpNativeRuntimeBootstrap(entry.bootstrap, true);
      assert.equal(settled.host.receipt.epoch, witness.epoch); assert.equal(settled.host.receipt.receiptSha256, witness.receiptSha256);
      assert.equal(settled.host.nativeChat, undefined); assert.equal(current.pending.length, 0); assert.equal(current.compound.length, 0);
      assert.equal(current.sources.length, 1); assert.equal(current.receipts.length, 1);
      assert.equal(current.sources[0].operation_id, state.plan.request.operationId); assert.equal(current.receipts[0].operation_id, state.plan.request.operationId);
      assert.equal(current.receipts[0].operation, "todo.board.create");
      assert.equal(current.receipts[0].fingerprint, state.pendingJournal.pending[0].fingerprint);
      const source = JSON.parse(current.sources[0].payload);
      assert.deepEqual(source.creation, state.plan); assert.deepEqual(source.finalReview.request, proof.request);
      assert.equal(source.creation.request.selection.sourceId, state.plan.request.selection.sourceId);
      assert.deepEqual(current.importManifests, state.before.importManifests);
      const db = entry.bootstrap.storage.connectNative();
      try {
        assert.equal((await u.load(installed, "original-mcp-todo-genesis")).readOriginalMcpTodoGenesisSources(sourceFixture.root, db).length, 1);
      } finally { db.close(); }
      const genesis = await u.load(installed, "original-mcp-todo-genesis-native");
      const active = genesis.getOriginalMcpTodoGenesisSourceScope(entry.bootstrap.storage, settled.host, sourceFixture.boardSlug); assert(active);
      await assert.rejects(entry.bootstrap.storage.adoptOriginalMcpTodoGenesisSource(structuredClone(active)), { code: "NATIVE_AUTHORITY_REQUIRED" });
      assert.deepEqual(live(entry.bootstrap), current);
      assert.deepEqual(await protectedImage(state, sourceFixture.root), state.leafControls);
      state.finalJournal = current; state.finalImage = await snapshot(state, sourceFixture.root); state.phase = "recovered";
      state.pair = await Promise.all([sourceFixture.paths.notePath, sourceFixture.paths.backingPath, sourceFixture.paths.canonicalBoardPath]
        .map(path => readFile(join(sourceFixture.root, path))));
    }
    verified = true;
    return { passed: true, runId, decision, sourceRoot: sourceFixture.root, actualRenderedDom: true,
      freshRecoveryEpoch: witness.epoch, operationId: state.plan.request.operationId, sourceId: state.plan.request.selection.sourceId,
      review: { requestSha256: proof.requestSha256, defaultDenyFocused: proof.defaultDenyFocused,
        defaultEnterDenial: proof.defaultEnterDenial, phase: proof.request.phase },
      pendingIntentCount: current.pending.length, compoundIntentCount: current.compound.length,
      sourceLedgerCount: current.sources.length, creationReceiptCount: current.receipts.length,
      sourceLedgerSha256: u.hash(JSON.stringify(current.sources)),
      ...(decision === "approve" ? { creationReceipt: {
        operationId: current.receipts[0].operation_id, operation: current.receipts[0].operation,
        actorId: current.receipts[0].actor_id, fingerprint: current.receipts[0].fingerprint,
        resultSha256: u.hash(current.receipts[0].result),
      } } : {}),
      noBlindReplay: true, originalUuidSingleReceipt: decision === "approve",
      installedRecoveryQualified: decision === "approve", b1AndRestoredQualified: false, fullCutoverQualified: false };
  } finally { if (!verified) state.phase = "failed"; await ui.stop(); }
}
export async function closeInstalledNativeTodoRecoveryEpoch(epoch) {
  const entry = epochs.get(epoch);
  if (!entry || entry.closed) fail("INSTALLED_TODO_RECOVERY_ACTUAL_EPOCH_REQUIRED");
  await entry.bootstrap.close(); entry.closed = true; entry.state.activeEpoch = undefined;
}
export async function verifyInstalledNativeTodoRecoveryB1(sourceFixture, { retirement, b1, stoppedCoreSha256 }) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "recovered" || state.activeEpoch) fail("INSTALLED_TODO_RECOVERY_CLOSED_RECOVERY_REQUIRED");
  const receipt = await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture,
    sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 }, retirement);
  if (b1?.kind !== "pkm.original-mcp-component-b1/v1" || b1.b1Sha256 !== receipt.b1Sha256
    || relative(state.componentFixture.directory, b1.b1Path).includes(sep)
    || !/b1-[a-f0-9-]{36}$/.test(b1.b1Path) || !/^[a-f0-9]{64}$/.test(stoppedCoreSha256 ?? ""))
    fail("INSTALLED_TODO_RECOVERY_ACTUAL_STOPPED_B1_REQUIRED");
  await u.privateDirectory(b1.b1Path, "INSTALLED_TODO_RECOVERY_PRIVATE_B1_REQUIRED");
  const bytes = await readFile(join(b1.b1Path, "manifest.json")), image = JSON.parse(bytes);
  assert.equal(u.hash(bytes), receipt.b1Sha256); assert.equal(image.root, sourceFixture.root);
  assert.equal(image.schema, "pkm.original-mcp-component-image/v1");
  const complete = JSON.parse(await readFile(join(b1.b1Path, "complete.json")));
  assert.equal(complete.sha256, receipt.b1Sha256); assert(complete.sqliteChecks >= 1);
  assert.equal(u.hash(await readFile(join(retirement.archive, "core.sqlite"))), stoppedCoreSha256);
  assert.equal(image.rows.find(row => row.path === "core.sqlite")?.sha256, stoppedCoreSha256);
  assert.deepEqual(await snapshot(state, retirement.archive), state.finalImage);
  for (const [index, path] of [sourceFixture.paths.notePath, sourceFixture.paths.backingPath, sourceFixture.paths.canonicalBoardPath].entries())
    assert.deepEqual(await readFile(join(retirement.archive, path)), state.pair[index]);
  assert.equal(u.hash(await readFile(join(b1.b1Path, "payload/core.sqlite"))), stoppedCoreSha256);
  for (const suffix of ["-wal", "-shm"]) {
    const path = `core.sqlite${suffix}`, row = image.rows.find(row => row.path === path);
    if (!row) await u.absent(join(retirement.archive, path), "INSTALLED_TODO_RECOVERY_ARCHIVE_SIDECAR_CREATED");
    else {
      assert.equal(row.directory, false);
      const bytes = await readFile(join(retirement.archive, path));
      assert.equal(bytes.length, row.size); assert.equal(u.hash(bytes), row.sha256);
      assert.equal(u.hash(await readFile(join(b1.b1Path, "payload", path))), row.sha256);
      if (suffix === "-wal") assert.equal(bytes.length, 0, "A stopped recovery image cannot hide uncheckpointed business writes.");
    }
  }
  // The Original oracle is invoked only after the native Root is closed, on copied bytes in its own Root.
  await writeFile(join(state.oracleRoot, sourceFixture.paths.notePath), state.pair[0], { mode: 0o600 });
  await writeFile(join(state.oracleRoot, sourceFixture.paths.backingPath), state.pair[1], { mode: 0o600 });
  const original = state.writer.run(state.oracleRoot, "return {note:store.noteGet(input.slug),board:store.noteWorkItemsRead(input.slug)};",
    { slug: sourceFixture.boardSlug });
  assert.equal(original.note.knowledgeId, state.plan.request.selection.knowledgeId);
  assert.equal(original.board.digest, state.plan.request.selection.backingSha256); assert.deepEqual(original.board.items, []);
  return { installedPendingRecoveryB1Qualified: true, originalUuidAndSourceLedgerPreserved: true,
    stoppedCoreSha256, b1Sha256: receipt.b1Sha256, stoppedImagePreservedWithoutSqliteReopen: true };
}
export async function verifyInstalledNativeTodoRecoveryRestored(sourceFixture, options) {
  const state = stateFor(sourceFixture), preserved = await verifyInstalledNativeTodoRecoveryB1(sourceFixture, options);
  const expected = { componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 };
  const retired = await readInstalledKnowledgeMoveRetirementReceipt(expected, options.retirement);
  await readInstalledKnowledgeMoveRestoredReceipt(expected, options.retirement, options.restored, retired);
  assert.deepEqual(u.hashes(await u.files(options.restored.root)), u.hashes(state.baseline));
  for (const path of ["core.sqlite", ".pkm-next-workspace", ".pkm-next-original-mcp.json", ".pkm-next-todo", ".pkm-native", ...Object.values(sourceFixture.paths)])
    await u.absent(join(options.restored.root, path), "INSTALLED_TODO_RECOVERY_B0_NATIVE_OR_BOARD_STATE");
  return { ...preserved, originalB0BytesRestored: true, originalRootOverwritten: false, noBoardOrNativeGrantRestored: true };
}
