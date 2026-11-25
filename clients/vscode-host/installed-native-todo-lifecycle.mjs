import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pinnedOriginalKnowledgeWriterFixture } from "../../tests/original-knowledge-writer-fixture.mjs";
import { prepareInstalledNativeTodoGenesisFixture, installedNativeTodoGenesisPrivacyPolicy } from "./installed-native-todo-genesis.mjs";
import { installedKnowledgeMoveFixtureUtilities as u, assertInstalledKnowledgeMoveComponentBinding,
  readInstalledKnowledgeMoveRetirementReceipt, readInstalledKnowledgeMoveRestoredReceipt } from "./installed-native-knowledge-move.mjs";
import { installedNativeTodoLifecycleStages, startInstalledNativeTodoLifecycleUi } from "./installed-native-todo-lifecycle-ui.mjs";

const states = new WeakMap();
export { installedNativeTodoLifecycleStages };
export const installedNativeTodoLifecyclePrivacyPolicy = installedNativeTodoGenesisPrivacyPolicy;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value, phase) {
  const state = states.get(value);
  if (!state || state.phase !== phase) fail("INSTALLED_TODO_LIFECYCLE_PREPARED_PHASE_REQUIRED");
  return state;
}
function result(response) {
  assert(!JSON.stringify(response).includes("PRIVATE_TODO_GENESIS_CONTROL"));
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return response.structuredContent ?? JSON.parse(response.content.filter(part => part.type === "text").map(part => part.text).join(""));
}
function ledger(component) {
  const db = component.storage.connectNative();
  try {
    return Object.fromEntries([
      ["sources", "SELECT * FROM original_todo_genesis_sources ORDER BY board_slug"],
      ["pending", "SELECT * FROM original_todo_genesis_pending ORDER BY operation_id"],
      ["receipts", "SELECT operation_id,operation,actor_id,fingerprint,result FROM receipts ORDER BY rowid"],
      ["intents", "SELECT * FROM migration_runtime_intents ORDER BY operation_id"],
    ].map(([key, sql]) => [key, db.prepare(sql).all().map(row => ({ ...row }))]));
  } finally { db.close(); }
}
async function tree(root) {
  const rows = [];
  async function walk(path) {
    let stat;
    try { stat = await lstat(join(root, path)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!stat) { rows.push({ path, absent: true }); return; }
    assert(!stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o7002));
    const identity = [stat.dev, stat.ino, stat.mode].join(":");
    if (stat.isDirectory()) {
      rows.push({ path, identity, directory: true });
      for (const name of (await readdir(join(root, path))).sort()) await walk(`${path}/${name}`);
    } else {
      assert(stat.isFile() && stat.nlink === 1 && stat.size <= 16777216);
      rows.push({ path, identity, sha256: u.hash(await readFile(join(root, path))) });
    }
  }
  for (const path of ["notes", "skills", "papers", ".pkm-next-todo", ".pkm/content-privacy.json"]) await walk(path);
  return rows;
}
async function snapshot(component) { return { files: await tree(component.root), ledger: ledger(component) }; }
async function waitJson(root, name, runId, timeoutMs, check = () => {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    check();
    try { const value = JSON.parse(await readFile(join(root, name))); assert.equal(value.runId, runId); return value; }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  fail("INSTALLED_TODO_LIFECYCLE_OBSERVER_HANDSHAKE_TIMEOUT");
}

export async function prepareInstalledNativeTodoLifecycleFixture(options) {
  if (states.has(options.componentFixture)) fail("INSTALLED_TODO_LIFECYCLE_ALREADY_PREPARED");
  const base = await prepareInstalledNativeTodoGenesisFixture(options);
  const releaseDirectory = join(options.componentFixture.directory, "todo-lifecycle-original-release");
  await mkdir(releaseDirectory, { mode: 0o700 });
  const oracleRoot = join(releaseDirectory, "oracle");
  await mkdir(oracleRoot, { mode: 0o700 });
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: releaseDirectory,
    legacyVsix: options.legacyVsix, python: options.python });
  writer.run(oracleRoot, "return store.todoBoardCreate(input.slug,input.title,input.category);",
    { slug: base.boardSlug, ...base.creationArguments });
  const value = Object.freeze({ ...base, kind: "pkm.installed-native-todo-lifecycle-fixture/v1" });
  const state = { value, installed: options.installed, componentFixture: options.componentFixture,
    baseline: await u.files(base.root), writer, oracleRoot, phase: "prepared" };
  states.set(value, state); states.set(options.componentFixture, state);
  return value;
}

/** Installed-only leaf: Parent owns package selection, cold admission and stopped B1/B0. */
export async function verifyInstalledNativeTodoLifecycle({ root, installed, component, sourceFixture, payloadBuildId,
  python, env, port, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture, "prepared");
  if (state.installed !== installed || component?.fixture !== state.componentFixture || component.root !== sourceFixture.root
    || typeof component.invoke !== "function" || typeof component.activateTodoGenesisSource !== "function"
    || typeof component.revokeTodoGenesisSource !== "function") fail("INSTALLED_TODO_LIFECYCLE_REAL_COMPONENT_REQUIRED");
  const { host, full } = await assertInstalledKnowledgeMoveComponentBinding({
    root, installed, component, componentFixture: state.componentFixture, payloadBuildId,
  });
  assert.equal(full.storage, component.storage); assert.equal(full.runtime.services.modelProvider, undefined);
  assert.equal(host.nativeChat, undefined);
  const native = await u.load(installed, "original-mcp-todo-genesis-native");
  const contracts = await u.load(installed, "original-mcp-todo-genesis-contracts");
  const catalog = (await u.load(installed, "native-public-original-mcp-contracts")).originalPublicMcpContracts();
  assert.equal(catalog.provenance.metadataSha256, host.receipt.sourceCatalogSha256);
  const argsFor = (tool, input) => {
    const contract = catalog.contracts.find(contract => contract.id === `mcp.tool.${tool}`);
    assert(contract && contract.transportName === tool);
    const args = structuredClone(input);
    for (const [key, property] of Object.entries(contract.inputSchema.properties))
      if (!Object.hasOwn(args, key) && Object.hasOwn(property, "default")) args[key] = structuredClone(property.default);
    if (args.worker_token === null || args.worker_token === undefined) delete args.worker_token;
    return args;
  };
  const lease = { ...component.owner.workspaceLease() }, abort = new AbortController(), runId = randomUUID();
  const binding = { root: component.root, workspaceId: component.workspaceId, profileSha256: host.receipt.profileSha256,
    custodyPlanSha256: component.custody.planSha256, catalogSha256: host.receipt.sourceCatalogSha256,
    privacySha256: sourceFixture.privacySha256, nativeEpoch: host.receipt.epoch, nativeHostReceiptSha256: host.receipt.receiptSha256 };
  await writeFile(join(root, "native-todo-lifecycle-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-todo-lifecycle-ui/v1", runId, binding, stages: installedNativeTodoLifecycleStages,
    boardSlug: sourceFixture.boardSlug, creationArguments: sourceFixture.creationArguments, paths: sourceFixture.paths,
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativeTodoLifecycleUi({ root, python, env, port, runId, timeoutMs });
  void ui.done.catch(error => abort.abort(error));
  const check = () => {
    if (ui.error) throw ui.error;
    abort.signal.throwIfAborted(); host.assertCurrent(); component.storage.assertWorkspaceLease();
    assert.deepEqual(component.owner.workspaceLease(), lease);
  };
  const call = (tool, args, signal = abort.signal) => component.invoke(tool, argsFor(tool, args), signal);
  async function refuse(invoke, code) {
    const before = await snapshot(component); let failure;
    try { const response = await invoke(); if (response.isError) failure = { code: response.structuredContent?.code, response }; }
    catch (error) { failure = error; }
    assert(failure, "The exact request must refuse without retrying.");
    if (code) assert.equal(failure.code, code, failure.message ?? JSON.stringify(failure));
    assert.deepEqual(await snapshot(component), before);
    return failure;
  }
  async function stage(name, tool, args, work) {
    const step = installedNativeTodoLifecycleStages.find(step => step.stage === name); assert(step); check();
    await writeFile(join(root, "native-todo-lifecycle-ui-step.json"), JSON.stringify({
      runId, ...step, tool, approvalArguments: tool ? argsFor(tool, args) : {},
    }), { mode: 0o600 });
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: name }), { mode: 0o600 });
    const value = await work(step); check();
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: `${name}-done` }), { mode: 0o600 });
    const ack = await waitJson(root, `native-todo-lifecycle-ui-ack-${name}.json`, runId, timeoutMs, check);
    assert.equal(ack.stage, name); assert.equal(ack.complete, true);
    return value;
  }
  const cancelled = [];
  async function lateChoice(step, invoke) {
    const before = await snapshot(component), controller = new AbortController();
    const pending = invoke(AbortSignal.any([abort.signal, controller.signal])).then(value => ({ value }), error => ({ error }));
    const ready = await waitJson(root, `native-todo-lifecycle-abort-ready-${step.phase}.json`, runId, timeoutMs, check);
    assert.equal(ready.stage, step.stage); assert.equal(ready.actualRenderedDom, true);
    const request = contracts.originalMcpTodoGenesisRequestSchema.parse(ready.request);
    assert.equal(contracts.originalMcpTodoGenesisRequestDigest(request), ready.requestSha256);
    for (const [key, value] of Object.entries(binding)) assert.equal(request[key], value);
    assert.equal(request.phase, step.phase); assert.equal(request.selection.boardSlug, sourceFixture.boardSlug);
    controller.abort();
    const settled = await pending;
    assert(settled.error); assert.equal(settled.error.code, "NATIVE_REQUEST_CANCELLED");
    assert.deepEqual(await snapshot(component), before);
    await writeFile(join(root, `native-todo-lifecycle-abort-settled-${step.phase}.json`), JSON.stringify({
      runId, stage: step.stage, operationId: request.operationId, requestSha256: ready.requestSha256,
      code: settled.error.code, settledBeforeLateClick: true,
    }), { mode: 0o600, flag: "wx" });
    const clicked = await waitJson(root, `native-todo-lifecycle-late-click-${step.phase}.json`, runId, timeoutMs, check);
    assert.equal(clicked.stage, step.stage); assert.equal(clicked.operationId, request.operationId);
    assert.equal(clicked.requestSha256, ready.requestSha256); assert.equal(clicked.sameRenderedModal, true);
    assert.deepEqual(await snapshot(component), before);
    cancelled.push({ phase: step.phase, operationId: request.operationId, requestSha256: ready.requestSha256,
      code: settled.error.code, settledBeforeLateClick: true, sameRenderedModal: true });
  }
  state.b0Sha256 = component.b0.sha256;
  const initial = await snapshot(component), board = { board_slug: sourceFixture.boardSlug };
  const protectedBefore = await Promise.all(state.baseline.map(file => readFile(join(component.root, file.path))));
  assert.equal(initial.ledger.sources.length, 0); assert.equal(initial.ledger.pending.length, 0);
  assert.equal(initial.ledger.receipts.filter(row => row.operation === "todo.board.create").length, 0);
  const task = { ...board, id: "installed-lifecycle-task" };
  try {
    await ui.ready;
    await stage("native-todo-lifecycle-cancel-create", "todo_board_create", sourceFixture.creationArguments,
      step => lateChoice(step, signal => call("todo_board_create", sourceFixture.creationArguments, signal)));
    assert.equal(native.getOriginalMcpTodoGenesisSourceScope(component.storage, host, sourceFixture.boardSlug), undefined);
    const created = await stage("native-todo-lifecycle-create", "todo_board_create", sourceFixture.creationArguments,
      async () => result(await call("todo_board_create", sourceFixture.creationArguments)));
    assert.equal(created.slug, sourceFixture.boardSlug); assert.equal(created.ok, true);
    assert.notEqual(ledger(component).sources[0].operation_id, cancelled[0].operationId);
    const oldCapsule = native.getOriginalMcpTodoGenesisSourceScope(component.storage, host, sourceFixture.boardSlug);
    assert(oldCapsule);
    const oldControl = native.originalMcpTodoGenesisSourceControlForStorage(component.storage, oldCapsule);
    assert.equal(Atomics.load(new Int32Array(oldControl.revocation), 0), 0);
    const pair = await Promise.all([sourceFixture.paths.notePath, sourceFixture.paths.backingPath].map(path => readFile(join(component.root, path))));
    const empty = await stage("native-todo-lifecycle-get", undefined, {}, async () => result(await call("get_board", board)));
    assert.equal(empty.digest, created.digest);
    const addArgs = { ...board, expected_digest: empty.digest, item: {
      id: task.id, title: "Installed lifecycle task", goal: "Renew only this exact source", scope: "Owned synthetic fixture",
      acceptance: ["No effects after transport cancellation"], plannedStart: "2026-11-22", plannedEnd: "2026-11-23",
    } };
    const added = await stage("native-todo-lifecycle-add", "add_workitem", addArgs, async () => result(await call("add_workitem", addArgs)));
    const edit = { ...task, expected_digest: added.digest, patch: { title: "Before exact-source revocation" }, reason: "Bounded planning edit" };
    const edited = await stage("native-todo-lifecycle-update", "update_workitem", edit, async () => result(await call("update_workitem", edit)));
    const revokedEdit = { ...edit, expected_digest: edited.digest, patch: { title: "Must not apply while revoked" } };
    await stage("native-todo-lifecycle-revoke-get", undefined, {}, async () => {
      const before = await snapshot(component);
      component.revokeTodoGenesisSource(sourceFixture.boardSlug);
      assert.equal(Atomics.load(new Int32Array(oldControl.revocation), 0), 1);
      assert.deepEqual(await snapshot(component), before);
      await refuse(() => call("get_board", board));
      await assert.rejects(component.storage.adoptOriginalMcpTodoGenesisSource(oldCapsule), { code: "NATIVE_AUTHORITY_REQUIRED" });
    });
    await stage("native-todo-lifecycle-revoked-update", "update_workitem", revokedEdit, () => refuse(() => call("update_workitem", revokedEdit)));
    await stage("native-todo-lifecycle-activate-deny", undefined, {}, () =>
      refuse(() => component.activateTodoGenesisSource(sourceFixture.boardSlug, { signal: abort.signal }), "TODO_GENESIS_DENIED"));
    await stage("native-todo-lifecycle-denied-get", undefined, {}, () => refuse(() => call("get_board", board)));
    await stage("native-todo-lifecycle-cancel-activate", undefined, {},
      step => lateChoice(step, signal => component.activateTodoGenesisSource(sourceFixture.boardSlug, { signal })));
    await stage("native-todo-lifecycle-cancelled-get", undefined, {}, () => refuse(() => call("get_board", board)));
    const beforeActivation = await snapshot(component);
    const renewed = await stage("native-todo-lifecycle-activate", undefined, {},
      () => component.activateTodoGenesisSource(sourceFixture.boardSlug, { signal: abort.signal }));
    assert.notEqual(renewed, oldCapsule); assert.deepEqual(await snapshot(component), beforeActivation);
    await stage("native-todo-lifecycle-renewed-get", undefined, {}, async () => {
      assert.deepEqual(result(await call("get_workitem", task)), edited);
      const history = result(await call("list_workitem_history", { ...task, expected_digest: edited.digest }));
      assert.deepEqual(history.items.map(row => row.action), ["create", "edit"]);
      await assert.rejects(component.storage.adoptOriginalMcpTodoGenesisSource(oldCapsule), { code: "NATIVE_AUTHORITY_REQUIRED" });
      await assert.rejects(component.storage.adoptOriginalMcpTodoGenesisSource(structuredClone(renewed)), { code: "NATIVE_AUTHORITY_REQUIRED" });
      await refuse(() => call("get_board", { board_slug: "Team/NotGranted" }));
      await refuse(() => component.activateTodoGenesisSource("Team/NotGranted", { signal: abort.signal }), "NOT_AVAILABLE");
    });
    const renewedEdit = { ...edit, expected_digest: edited.digest, patch: { title: "After exact-source renewal" }, reason: "Same canonical identity and history" };
    const final = await stage("native-todo-lifecycle-renewed-update", "update_workitem", renewedEdit,
      async () => result(await call("update_workitem", renewedEdit)));
    const history = await stage("native-todo-lifecycle-final-read", undefined, {}, async () => {
      assert.deepEqual(result(await call("get_workitem", task)), final);
      return result(await call("list_workitem_history", { ...task, expected_digest: final.digest }));
    });
    assert.deepEqual(history.items.map(row => row.action), ["create", "edit", "edit"]);
    assert(history.items.every(row => row.actorId === "mcp:external"));
    assert.deepEqual(await Promise.all([sourceFixture.paths.notePath, sourceFixture.paths.backingPath]
      .map(path => readFile(join(component.root, path)))), pair);
    const canonical = await readFile(join(component.root, sourceFixture.paths.canonicalBoardPath));
    assert.equal(u.hash(canonical), final.digest);
    const finalLedger = ledger(component), source = JSON.parse(finalLedger.sources[0].payload).creation.request;
    assert.equal(finalLedger.sources.length, 1); assert.equal(finalLedger.pending.length, 0);
    const receipts = finalLedger.receipts.filter(row => JSON.parse(row.result).board_slug === sourceFixture.boardSlug);
    assert.deepEqual(receipts.map(row => row.operation), ["todo.board.create", "todo.workitem.create", "todo.workitem.update", "todo.workitem.update"]);
    assert.equal(source.selection.knowledgeId, oldControl.provenance.request.selection.knowledgeId);
    const newControl = native.originalMcpTodoGenesisSourceControlForStorage(component.storage, renewed);
    assert.equal(newControl.provenance.request.phase, "activate-source");
    assert.notEqual(newControl.provenance.decision.decisionId, oldControl.provenance.decision.decisionId);
    assert.equal(newControl.provenance.request.operationId, source.operationId);
    assert.equal(newControl.provenance.request.selection.sourceId, source.selection.sourceId);
    await writeFile(join(state.oracleRoot, sourceFixture.paths.notePath), pair[0], { mode: 0o600 });
    await writeFile(join(state.oracleRoot, sourceFixture.paths.backingPath), canonical, { mode: 0o600 });
    const original = state.writer.run(state.oracleRoot, "return {note:store.noteGet(input.slug),board:store.noteWorkItemsRead(input.slug)};",
      { slug: sourceFixture.boardSlug });
    assert.equal(original.note.knowledgeId, source.selection.knowledgeId); assert.equal(original.board.digest, final.digest);
    assert.deepEqual(original.board.items[0].history, history.items);
    for (const [index, file] of state.baseline.entries())
      assert.deepEqual(await readFile(join(component.root, file.path)), protectedBefore[index]);
    const current = await component.owner.ensureFull(); assert.equal(current.runtime.core, full.runtime.core); check();
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: "native-todo-lifecycle-complete" }), { mode: 0o600 });
    await ui.done; check();
    const proof = await waitJson(root, "native-todo-lifecycle-ui-passed.json", runId, timeoutMs, check);
    assert.equal(proof.passed, true); assert.equal(proof.actualRenderedDom, true);
    for (const entry of cancelled) assert(proof.dialogs.some(row => row.requestSha256 === entry.requestSha256 && row.lateClickSameModal));
    const affirmed = proof.dialogs.filter(row => row.kind === "genesis" && !row.lateClickSameModal && row.choice !== "Deny");
    assert.deepEqual(affirmed.map(row => row.phase), ["create", "activate-source"]);
    assert.equal(affirmed[0].operationId, source.operationId); assert.equal(affirmed[1].sourceId, source.selection.sourceId);
    state.phase = "verified"; state.pair = pair; state.canonical = canonical; state.ledger = finalLedger;
    state.component = component;
    state.evidence = { passed: true, scope: "actual installed exact Todo source lifecycle only", runId,
      boardSlug: sourceFixture.boardSlug, binding, originalPackageSha256: sourceFixture.originalPackageSha256,
      operationId: source.operationId, sourceId: source.selection.sourceId, knowledgeId: source.selection.knowledgeId,
      sameCoreOwnerLease: true, oneBoardOneCreationReceipt: true, durableReceiptsDoNotGrantLiveAuthority: true,
      exactSourceRevocationRenewal: true, defaultFocusedEnterDenial: true, transportCancelLateChoice: cancelled,
      noHistoricalManifestOrRecoveryPolicyChanges: true, actualDialogs: proof.dialogs, readStages: proof.readStages,
      canonicalReceipts: receipts, finalBoardSha256: final.digest, sourceLedgerSha256: u.hash(JSON.stringify(finalLedger.sources)),
      b1AndRestoredQualified: false, humanWorkerReviewerRecoveryPerformed: false, fullCutoverQualified: false };
    await writeFile(join(root, "native-todo-lifecycle-passed.json"), JSON.stringify(state.evidence), { mode: 0o600, flag: "wx" });
    return state.evidence;
  } finally {
    if (state.phase !== "verified") state.phase = "failed";
    abort.abort(); await ui.stop();
  }
}

export async function verifyInstalledNativeTodoLifecycleB1(sourceFixture, { retirement, b1 }) {
  const state = stateFor(sourceFixture, "verified");
  const receipt = await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture,
    sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 }, retirement);
  if (b1?.kind !== "pkm.original-mcp-component-b1/v1" || b1.b1Sha256 !== receipt.b1Sha256
    || relative(state.componentFixture.directory, b1.b1Path).includes("/") || !/b1-[a-f0-9-]{36}$/.test(b1.b1Path))
    fail("INSTALLED_TODO_LIFECYCLE_ACTUAL_B1_REQUIRED");
  assert.throws(() => state.component.owner.workspaceLease());
  if (!state.stoppedCoreSha256) fail("INSTALLED_TODO_LIFECYCLE_STOPPED_CORE_PIN_REQUIRED");
  await u.privateDirectory(b1.b1Path, "INSTALLED_TODO_LIFECYCLE_ACTUAL_B1_REQUIRED");
  const manifestBytes = await readFile(join(b1.b1Path, "manifest.json")), manifest = JSON.parse(manifestBytes);
  assert.equal(u.hash(manifestBytes), receipt.b1Sha256); assert.equal(manifest.root, sourceFixture.root);
  assert.equal(manifest.schema, "pkm.original-mcp-component-image/v1");
  const complete = JSON.parse(await readFile(join(b1.b1Path, "complete.json")));
  assert.equal(complete.sha256, receipt.b1Sha256); assert(complete.sqliteChecks >= 1);
  const archivedCoreSha256 = u.hash(await readFile(join(retirement.archive, "core.sqlite")));
  assert.equal(archivedCoreSha256, state.stoppedCoreSha256);
  assert.equal(archivedCoreSha256, manifest.rows.find(row => row.path === "core.sqlite")?.sha256);
  assert.equal(u.hash(await readFile(join(b1.b1Path, "payload/core.sqlite"))), archivedCoreSha256);
  for (const [path, bytes] of [[sourceFixture.paths.notePath, state.pair[0]], [sourceFixture.paths.backingPath, state.pair[1]],
    [sourceFixture.paths.canonicalBoardPath, state.canonical]])
    assert.deepEqual(await readFile(join(retirement.archive, path)), bytes);
  return { exactBoardB1Preserved: true, b1Sha256: receipt.b1Sha256, stoppedCoreSha256: archivedCoreSha256 };
}
export async function pinInstalledNativeTodoLifecycleStopped(sourceFixture, component) {
  const state = stateFor(sourceFixture, "verified");
  if (component !== state.component) fail("INSTALLED_TODO_LIFECYCLE_SAME_STOPPED_COMPONENT_REQUIRED");
  assert.throws(() => component.owner.workspaceLease());
  const bytes = await readFile(join(component.root, "core.sqlite"));
  state.stoppedCoreSha256 = u.hash(bytes);
  return { stoppedCoreSha256: state.stoppedCoreSha256, observedLedgerSha256: u.hash(JSON.stringify(state.ledger)) };
}
export async function verifyInstalledNativeTodoLifecycleRestored(sourceFixture, { retirement, b1, restored }) {
  const state = stateFor(sourceFixture, "verified");
  const preserved = await verifyInstalledNativeTodoLifecycleB1(sourceFixture, { retirement, b1 });
  const receipt = await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture,
    sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 }, retirement);
  await readInstalledKnowledgeMoveRestoredReceipt({ componentFixture: state.componentFixture,
    sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 }, retirement, restored, receipt);
  assert.deepEqual(u.hashes(await u.files(restored.root)), u.hashes(state.baseline));
  for (const path of ["core.sqlite", ".pkm-next-workspace", ".pkm-next-original-mcp.json", ".pkm-next-todo", ".pkm-native",
    ...Object.values(sourceFixture.paths)]) await u.absent(join(restored.root, path), "INSTALLED_TODO_LIFECYCLE_FRESH_B0_REQUIRED");
  return { ...preserved, originalB0BytesRestored: true, noBoardOrAuthorityRestored: true, originalRootOverwritten: false };
}
