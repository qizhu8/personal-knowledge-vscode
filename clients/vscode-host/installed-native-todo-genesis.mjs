import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pinnedOriginalKnowledgeWriterFixture } from "../../tests/original-knowledge-writer-fixture.mjs";
import { installedKnowledgeMoveFixtureUtilities as utilities, assertInstalledKnowledgeMoveComponentBinding,
  readInstalledKnowledgeMoveRetirementReceipt, readInstalledKnowledgeMoveRestoredReceipt } from "./installed-native-knowledge-move.mjs";
import { installedNativeTodoGenesisStages, startInstalledNativeTodoGenesisUi } from "./installed-native-todo-genesis-ui.mjs";

const { hash, load, absent, privateDirectory, files, hashes } = utilities;
const preparations = new WeakMap();
const creationArguments = Object.freeze({ title: "InstalledFirstBoard", category: "Team" });
export const installedNativeTodoGenesisPrivacyPolicy = Object.freeze({ schema: 1, private: Object.freeze({ notes: Object.freeze(["Private"]) }) });
export const installedNativeTodoGenesisFacadeAliases = Object.freeze([
  ["todo_board_create", false], ["get_board", true], ["list_boards", true], ["add_workitem", false],
  ["get_workitem", true], ["update_workitem", false], ["claim_workitem", false], ["change_workitem_state", false],
  ["list_workitems", true], ["list_workitem_history", true], ["list_board_changes", true], ["note_work_items", true],
].map(([name, readOnly]) => Object.freeze({ name, operation: `mcp.tool.${name}`, version: 1, readOnly })));
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value) {
  const state = preparations.get(value);
  if (!state) fail("INSTALLED_TODO_GENESIS_ACTUAL_PREPARATION_REQUIRED");
  return state;
}
function result(response) {
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return response.structuredContent ?? JSON.parse(response.content.filter(part => part.type === "text").map(part => part.text).join(""));
}
function noPrivate(value) { assert(!JSON.stringify(value).includes("PRIVATE_TODO_GENESIS_CONTROL")); }
function journal(db, slug) {
  return {
    sources: db.prepare("SELECT * FROM original_todo_genesis_sources WHERE board_slug=?").all(slug),
    pending: db.prepare("SELECT * FROM original_todo_genesis_pending WHERE json_extract(creation_plan,'$.request.selection.boardSlug')=?").all(slug),
    receipts: db.prepare("SELECT operation_id,fingerprint,result,actor_id,operation FROM receipts WHERE json_extract(result,'$.board_slug')=? ORDER BY rowid").all(slug),
    creationCount: Number(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation='todo.board.create'").get().n),
    sourceCount: Number(db.prepare("SELECT count(*) AS n FROM original_todo_genesis_sources").get().n),
  };
}
function liveJournal(component, slug) {
  const db = component.storage.connectNative();
  try { return journal(db, slug); } finally { db.close(); }
}

export async function prepareInstalledNativeTodoGenesisFixture({ installed, componentFixture, legacyVsix, python }) {
  await (await load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (preparations.has(componentFixture)) fail("INSTALLED_TODO_GENESIS_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    ...["core.sqlite", ".pkm-next-original-mcp.json", ".pkm-next-todo", "boards"].map(path => join(componentFixture.root, path))])
    await absent(path, "INSTALLED_TODO_GENESIS_PRE_B0_REQUIRED");
  const privacyPath = join(componentFixture.root, ".pkm/content-privacy.json"), privacyStat = await lstat(privacyPath);
  if (!privacyStat.isFile() || privacyStat.isSymbolicLink() || privacyStat.nlink !== 1
    || privacyStat.uid !== process.getuid() || privacyStat.mode & 0o077 || privacyStat.size > 2097152)
    fail("INSTALLED_TODO_GENESIS_PRIVATE_PRIVACY_REQUIRED");
  const privacy = await readFile(privacyPath);
  assert.deepEqual(JSON.parse(privacy), installedNativeTodoGenesisPrivacyPolicy, "Parent must configure independent Todo privacy before preparation.");
  const common = await Promise.all(["notes/Entry.md", "skills/Base.md"].map(path => readFile(join(componentFixture.root, path))));
  for (const path of ["notes/Team/TodoGenesisCategoryEntry.md", "notes/Private/TodoGenesisControl.md"])
    await absent(join(componentFixture.root, path), "INSTALLED_TODO_GENESIS_DISJOINT_PREPARATION_REQUIRED");
  for (const category of ["Team", "Private"]) {
    const path = join(componentFixture.root, "notes", category);
    await mkdir(path, { mode: 0o700, recursive: true });
    await privateDirectory(path, "INSTALLED_TODO_GENESIS_OWNED_CATEGORY_REQUIRED");
  }
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: componentFixture.directory, legacyVsix, python });
  writer.run(componentFixture.root, `
    store.noteUpsert({slug:"Team/TodoGenesisCategoryEntry",title:"TodoGenesisCategoryEntry",category:"Team",
      content:"PUBLIC_TODO_GENESIS_CATEGORY",tags:[],type:"general"});
    store.noteUpsert({slug:"Private/TodoGenesisControl",title:"TodoGenesisControl",category:"Private",
      content:"PRIVATE_TODO_GENESIS_CONTROL",tags:[],type:"general"});
    return store.noteWorkItemNotes("",100);
  `);
  assert.deepEqual(await readFile(privacyPath), privacy);
  assert.deepEqual(await Promise.all(["notes/Entry.md", "skills/Base.md"].map(path => readFile(join(componentFixture.root, path)))), common);
  const boardSlug = `${creationArguments.category}/${creationArguments.title}`;
  const paths = Object.freeze({ notePath: `notes/${boardSlug}.md`, pairPath: `notes/${boardSlug}.assets`,
    backingPath: `notes/${boardSlug}.assets/pkm-todo-board.json`,
    canonicalBoardPath: `.pkm-next-todo/${boardSlug}/pkm-todo-board.json` });
  for (const path of Object.values(paths)) await absent(join(componentFixture.root, path), "INSTALLED_TODO_GENESIS_BOARD_BEFORE_B0");
  const oracleRoot = join(componentFixture.directory, "todo-genesis-original-oracle"); await mkdir(oracleRoot, { mode: 0o700 });
  const originalCreate = writer.run(oracleRoot, `
    const snapshot=store.todoBoardCreate(input.slug,input.title,input.category);
    return {snapshot,note:store.noteGet(input.slug)};
  `, { slug: boardSlug, ...creationArguments });
  assert.deepEqual(originalCreate.snapshot.items, []);
  const baseline = await files(componentFixture.root);
  const value = Object.freeze({ kind: "pkm.installed-native-todo-genesis-fixture/v1", root: componentFixture.root,
    boardSlug, creationArguments, paths, originalPackageSha256: writer.originalPackageSha256,
    privacySha256: hash(privacy), noBoardBeforeB0: true });
  const state = { installed, componentFixture, writer, oracleRoot, originalCreate, baseline, privacy, value, phase: "prepared" };
  preparations.set(componentFixture, state); preparations.set(value, state); return value;
}

async function waitJson(path, timeoutMs, check) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    check();
    try { return JSON.parse(await readFile(path)); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Exact Todo observer stage acknowledgement timed out.");
}
export async function verifyInstalledNativeTodoGenesis({ root, installed, component, sourceFixture, payloadBuildId,
  python, env, port, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "prepared" || state.installed !== installed || component?.fixture !== state.componentFixture
    || component.root !== sourceFixture.root) fail("INSTALLED_TODO_GENESIS_SAME_PREPARED_COMPONENT_REQUIRED");
  if (typeof component.invoke !== "function" || typeof component.invokeCanonical !== "function")
    fail("INSTALLED_TODO_GENESIS_REAL_ALIAS_FACADE_REQUIRED");
  const { host, full, first } = await assertInstalledKnowledgeMoveComponentBinding({
    root, installed, component, componentFixture: state.componentFixture, payloadBuildId,
  });
  const lease = { ...component.owner.workspaceLease() }, runId = randomUUID(), observerAbort = new AbortController();
  const check = () => {
    observerAbort.signal.throwIfAborted();
    host.assertCurrent(); component.storage.assertWorkspaceLease(); assert.deepEqual(component.owner.workspaceLease(), lease);
  };
  const catalog = (await load(installed, "native-public-original-mcp-contracts")).originalPublicMcpContracts();
  assert.equal(catalog.provenance.metadataSha256, host.receipt.sourceCatalogSha256);
  const contracts = new Map();
  for (const alias of installedNativeTodoGenesisFacadeAliases) {
    const contract = catalog.contracts.find(contract => contract.id === alias.operation);
    assert(contract); assert.equal(contract.transportName, alias.name);
    assert.equal(contract.readOnly, alias.readOnly); contracts.set(alias.name, contract);
  }
  const approvalArguments = (tool, args) => {
    const output = structuredClone(args);
    for (const [key, schema] of Object.entries(contracts.get(tool).inputSchema.properties))
      if (!(key in output) && Object.hasOwn(schema, "default")) output[key] = structuredClone(schema.default);
    if (output.worker_token === null || output.worker_token === undefined) delete output.worker_token;
    return output;
  };
  const call = async (tool, args) => {
    check();
    const response = tool === "capability_read"
      ? await component.invokeCanonical("legacy_capability_read", { action: "read", args }, observerAbort.signal)
      : await component.invoke(tool, approvalArguments(tool, args), observerAbort.signal);
    noPrivate(response); return response;
  };
  const protectedPaths = [".pkm/content-privacy.json", "notes/Team/TodoGenesisCategoryEntry.md", "notes/Private/TodoGenesisControl.md"];
  const protectedBefore = await Promise.all(protectedPaths.map(path => readFile(join(component.root, path))));
  const unchanged = async () => assert.deepEqual(await Promise.all(protectedPaths.map(path => readFile(join(component.root, path)))), protectedBefore);
  const journalBefore = liveJournal(component, sourceFixture.boardSlug);
  assert.equal(journalBefore.creationCount, 0); assert.equal(journalBefore.sourceCount, 0);
  for (const path of Object.values(sourceFixture.paths)) await absent(join(component.root, path), "INSTALLED_TODO_GENESIS_B0_BOARD_REQUIRED_ABSENT");
  state.b0Sha256 = component.b0.sha256;
  await writeFile(join(root, "native-todo-genesis-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-todo-genesis-ui/v1", runId, stages: installedNativeTodoGenesisStages,
    binding: { root: component.root, workspaceId: component.workspaceId, profileSha256: first.result.profileSha256 },
    nativeEpoch: host.receipt.epoch, nativeHostReceiptSha256: host.receipt.receiptSha256,
    custodyPlanSha256: component.custody.planSha256, catalogSha256: host.receipt.sourceCatalogSha256,
    privacySha256: sourceFixture.privacySha256, creationArguments, boardSlug: sourceFixture.boardSlug, paths: sourceFixture.paths,
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativeTodoGenesisUi({ root, python, env, port, runId, timeoutMs });
  void ui.done.catch(error => observerAbort.abort(error));
  const progress = stage => writeFile(join(root, "progress.json"), JSON.stringify({ stage }), { mode: 0o600 });
  async function stage(name, tool, args, dialogs, work) {
    if (ui.error) throw ui.error;
    await writeFile(join(root, "native-todo-genesis-ui-step.json"), JSON.stringify({
      runId, stage: name, tool, approvalArguments: tool ? approvalArguments(tool, args) : {}, dialogs,
    }), { mode: 0o600 });
    await progress(name);
    const value = await work(); check(); await progress(`${name}-done`);
    const ack = await waitJson(join(root, `native-todo-genesis-ui-ack-${name}.json`), timeoutMs, check);
    assert.equal(ack.runId, runId); assert.equal(ack.stage, name); assert.equal(ack.complete, true); return value;
  }
  async function refused(tool, args, expectedCode) {
    let error;
    try { const response = await call(tool, args); if (response.isError) error = response; }
    catch (value) { error = value; }
    assert(error, "Exact denial must not return success or trigger a retry.");
    if (expectedCode) assert.equal(error.code, expectedCode, error.message ?? JSON.stringify(error));
    return error;
  }
  const writeDialog = [{ kind: "public", choice: "Approve this request" }];
  try {
    await ui.ready;
    for (const [name, dialogs] of [
      ["native-todo-genesis-public-deny", [{ kind: "public", choice: "Deny" }]],
      ["native-todo-genesis-create-deny", [...writeDialog, { kind: "genesis", choice: "Deny" }]],
    ]) {
      await stage(name, "todo_board_create", creationArguments, dialogs, () => refused("todo_board_create", creationArguments,
        name === "native-todo-genesis-create-deny" ? "TODO_GENESIS_DENIED" : undefined));
      assert.deepEqual(liveJournal(component, sourceFixture.boardSlug), journalBefore);
      for (const path of Object.values(sourceFixture.paths)) await absent(join(component.root, path), "INSTALLED_TODO_GENESIS_DENIAL_HAD_EFFECT");
      await unchanged();
    }
    const created = await stage("native-todo-genesis-create", "todo_board_create", creationArguments,
      [...writeDialog, { kind: "genesis", choice: "Create this exact Board once" }], async () => result(await call("todo_board_create", creationArguments)));
    assert.deepEqual(Object.keys(created).sort(), ["digest", "items", "ok", "slug"]);
    assert.equal(created.ok, true); assert.equal(created.slug, sourceFixture.boardSlug); assert.deepEqual(created.items, []);
    const pair = await Promise.all([readFile(join(component.root, sourceFixture.paths.notePath)), readFile(join(component.root, sourceFixture.paths.backingPath))]);
    const board = { board_slug: sourceFixture.boardSlug }, id = "installed-basic-task", task = { ...board, id };
    const empty = await stage("native-todo-genesis-read-empty", undefined, {}, [], async () => {
      const read = result(await call("get_board", { ...board, worker_token: null }));
      assert.equal(read.digest, created.digest); assert.equal(read.actorId, "mcp:external");
      assert.equal(result(await call("list_boards", { query: creationArguments.title })).total, 1);
      return read;
    });
    const item = { id, title: "Installed basic Todo task", goal: "Preserve actual original Todo basic semantics",
      scope: "Owned installed fixture only", acceptance: ["CAS, audit and paired source are exact"],
      plannedStart: "2026-11-22", plannedEnd: "2026-11-23" };
    const addArgs = { ...board, expected_digest: empty.digest, item };
    const added = await stage("native-todo-genesis-add", "add_workitem", addArgs, writeDialog,
      async () => result(await call("add_workitem", addArgs)));
    assert.equal(added.item.state, "Planning"); assert.equal(added.item.ownerId, undefined);
    await stage("native-todo-genesis-read-created", undefined, {}, [], async () => {
      assert.deepEqual(result(await call("get_workitem", task)), added);
    });
    const editArgs = { ...task, expected_digest: added.digest, patch: { title: "Installed basic Todo task edited" }, reason: "Clarify exact planning" };
    const edited = await stage("native-todo-genesis-update", "update_workitem", editArgs, writeDialog,
      async () => result(await call("update_workitem", editArgs)));
    assert.notEqual(edited.digest, added.digest); assert.equal(edited.item.plannedEnd, item.plannedEnd);
    const stale = { ...editArgs, patch: { title: "Never applied stale mutation" } }, beforeStale = liveJournal(component, sourceFixture.boardSlug);
    await stage("native-todo-genesis-stale-cas", "update_workitem", stale, writeDialog, () => refused("update_workitem", stale));
    assert.deepEqual(liveJournal(component, sourceFixture.boardSlug), beforeStale);
    const claimArgs = { ...task, expected_digest: edited.digest };
    const claimed = await stage("native-todo-genesis-claim", "claim_workitem", claimArgs, writeDialog,
      async () => result(await call("claim_workitem", claimArgs)));
    assert.equal(claimed.item.ownerId, "mcp:external"); assert.equal(claimed.item.state, "WIP");
    const holdArgs = { ...task, expected_digest: claimed.digest, state: "on-hold", reason: "Pause the synthetic record; execute nothing" };
    const held = await stage("native-todo-genesis-on-hold", "change_workitem_state", holdArgs, writeDialog,
      async () => result(await call("change_workitem_state", holdArgs)));
    assert.equal(held.item.state, "OnHold"); assert.equal(held.item.acceptanceDecision, undefined); assert.equal(held.item.outcome, undefined);
    let history;
    await stage("native-todo-genesis-retrieve", undefined, {}, [], async () => {
      assert.deepEqual(result(await call("get_workitem", task)), held);
      const listed = result(await call("list_workitems", { ...board, states: ["on-hold"], expected_digest: held.digest }));
      assert.equal(listed.total, 1); assert.equal(listed.items[0].id, id);
      history = result(await call("list_workitem_history", { ...task, expected_digest: held.digest }));
      assert.deepEqual(history.items.map(event => event.action), ["create", "edit", "claim", "transition"]);
      assert(history.items.every(event => event.actorId === "mcp:external"));
      const changes = result(await call("list_board_changes", { ...board, expected_digest: held.digest }));
      assert.deepEqual(changes.items.map(event => event.event_id), [`${id}:0`, `${id}:1`, `${id}:2`, `${id}:3`]);
      const snapshot = result(await call("note_work_items", { slug: sourceFixture.boardSlug }));
      assert.equal(snapshot.digest, held.digest); assert.deepEqual(snapshot.items[0].history, history.items);
    });
    await stage("native-todo-genesis-token-refusal", undefined, {}, [], async () => {
      await refused("get_board", { ...board, worker_token: "0".repeat(64) });
      await refused("capability_read", { operation: "mcp.tool.accept_workitem", version: 1,
        arguments: { ...task, expected_digest: held.digest, reason: "Wrong-lane refusal only, never human review" } });
    });
    assert.deepEqual(await Promise.all([readFile(join(component.root, sourceFixture.paths.notePath)), readFile(join(component.root, sourceFixture.paths.backingPath))]), pair);
    const canonical = await readFile(join(component.root, sourceFixture.paths.canonicalBoardPath));
    assert.equal(hash(canonical), held.digest);
    const sourceLedger = liveJournal(component, sourceFixture.boardSlug);
    assert.equal(sourceLedger.sourceCount, 1); assert.equal(sourceLedger.creationCount, 1); assert.equal(sourceLedger.pending.length, 0);
    const payload = JSON.parse(sourceLedger.sources[0].payload), sourceRequest = payload.creation.request;
    assert.equal(sourceRequest.selection.boardSlug, sourceFixture.boardSlug); assert.equal(sourceRequest.selection.descriptorSha256, hash(pair[0]));
    assert.equal(sourceRequest.selection.backingSha256, hash(pair[1])); assert.equal(sourceRequest.operationId, sourceLedger.sources[0].operation_id);
    await mkdir(join(state.oracleRoot, "notes/Team", `${creationArguments.title}.assets`), { recursive: true, mode: 0o700 });
    await writeFile(join(state.oracleRoot, sourceFixture.paths.notePath), pair[0]);
    await writeFile(join(state.oracleRoot, sourceFixture.paths.backingPath), canonical);
    const originalNote = state.writer.run(state.oracleRoot, `return store.noteGet(input.slug);`, { slug: sourceFixture.boardSlug });
    assert.equal(originalNote.knowledgeId, sourceRequest.selection.knowledgeId); assert.equal(originalNote.documentKind, "todo-board");
    assert.equal(originalNote.type, "todo"); assert.equal(originalNote.revision, 1);
    const originalSnapshot = state.writer.run(state.oracleRoot, `return store.noteWorkItemsRead(input.slug);`, { slug: sourceFixture.boardSlug });
    assert.equal(originalSnapshot.digest, held.digest); assert.deepEqual(originalSnapshot.items[0].history, history.items);
    await unchanged(); await progress("native-todo-genesis-complete"); await ui.done; check();
    const proof = JSON.parse(await readFile(join(root, "native-todo-genesis-ui-passed.json")));
    assert.equal(proof.passed, true); assert.equal(proof.runId, runId); assert.equal(proof.actualRenderedDom, true);
    const creationProof = proof.dialogs.filter(dialog => dialog.kind === "genesis" && dialog.choice === "Create this exact Board once");
    assert.equal(creationProof.length, 1); assert.equal(creationProof[0].operationId, sourceRequest.operationId);
    assert.equal(creationProof[0].sourceId, sourceRequest.selection.sourceId);
    state.phase = "verified"; state.journal = sourceLedger; state.pair = pair; state.canonical = canonical;
    state.evidence = { passed: true, scope: "isolated installed first-Board basic slice only", actualRenderedDom: true,
      originalPackageSha256: sourceFixture.originalPackageSha256, boardSlug: sourceFixture.boardSlug,
      sameOwnerLease: true, oneCreationReceipt: true, originalIds: installedNativeTodoGenesisFacadeAliases.map(alias => alias.operation),
      creationOperationId: sourceRequest.operationId, sourceId: sourceRequest.selection.sourceId,
      knowledgeId: sourceRequest.selection.knowledgeId, nativeEpoch: host.receipt.epoch,
      custodyPlanSha256: component.custody.planSha256, catalogSha256: host.receipt.sourceCatalogSha256,
      noteSha256: hash(pair[0]), backingSha256: hash(pair[1]), finalBoardSha256: hash(canonical),
      sourceLedgerSha256: hash(JSON.stringify(sourceLedger.sources)),
      canonicalReceipts: sourceLedger.receipts.map(receipt => ({
        operationId: receipt.operation_id, operation: receipt.operation, actorId: receipt.actor_id,
        fingerprint: receipt.fingerprint, resultSha256: hash(receipt.result),
      })),
      actualDialogs: proof.dialogs, readStages: proof.readStages,
      publicDialogCount: proof.dialogs.filter(dialog => dialog.kind === "public").length,
      genesisDialogCount: proof.dialogs.filter(dialog => dialog.kind === "genesis").length,
      sourceRevocationRenewal: "unperformed-no-branded-component-source-control", transportCancelRecovery: "unperformed",
      humanAcceptance: "unperformed-unavailable-operation-refusal-only", workerEnrollment: "unperformed-token-refusal-only",
      b1AndRestoredQualified: false, fullCutoverQualified: false };
    await writeFile(join(root, "native-todo-genesis-passed.json"), JSON.stringify(state.evidence), { mode: 0o600, flag: "wx" });
    return state.evidence;
  } finally {
    if (state.phase !== "verified") state.phase = "failed";
    observerAbort.abort(); await ui.stop();
  }
}

export async function verifyInstalledNativeTodoGenesisB1(sourceFixture, { retirement, b1 }) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "verified") fail("INSTALLED_TODO_GENESIS_VERIFIED_EFFECTS_REQUIRED");
  const receipt = await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture,
    sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 }, retirement);
  assert.deepEqual(await readFile(join(retirement.archive, sourceFixture.paths.notePath)), state.pair[0]);
  assert.deepEqual(await readFile(join(retirement.archive, sourceFixture.paths.backingPath)), state.pair[1]);
  assert.deepEqual(await readFile(join(retirement.archive, sourceFixture.paths.canonicalBoardPath)), state.canonical);
  if (b1?.kind !== "pkm.original-mcp-component-b1/v1"
    || relative(state.componentFixture.directory, b1.b1Path).includes("/")
    || !/b1-[a-f0-9-]{36}$/.test(b1.b1Path) || b1.b1Sha256 !== receipt.b1Sha256)
    fail("INSTALLED_TODO_GENESIS_ACTUAL_B1_IMAGE_REQUIRED");
  await privateDirectory(b1.b1Path, "INSTALLED_TODO_GENESIS_ACTUAL_B1_IMAGE_REQUIRED");
  const manifestBytes = await readFile(join(b1.b1Path, "manifest.json")), image = JSON.parse(manifestBytes);
  assert.equal(hash(manifestBytes), receipt.b1Sha256);
  assert.equal(image.schema, "pkm.original-mcp-component-image/v1"); assert.equal(image.root, sourceFixture.root);
  const complete = JSON.parse(await readFile(join(b1.b1Path, "complete.json")));
  assert.equal(complete.sha256, receipt.b1Sha256); assert(complete.sqliteChecks >= 1);
  const archivedCore = await readFile(join(retirement.archive, "core.sqlite"));
  assert.equal(hash(archivedCore), image.rows.find(row => row.path === "core.sqlite")?.sha256);
  return { oneBoardB1BytesAndReceiptsPreserved: true, b1Sha256: receipt.b1Sha256 };
}
export async function verifyInstalledNativeTodoGenesisRestored(sourceFixture, { retirement, b1, restored }) {
  const state = stateFor(sourceFixture), preserved = await verifyInstalledNativeTodoGenesisB1(sourceFixture, { retirement, b1 });
  const retiredReceipt = await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture,
    sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 }, retirement);
  await readInstalledKnowledgeMoveRestoredReceipt({ componentFixture: state.componentFixture,
    sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 }, retirement, restored, retiredReceipt);
  assert.deepEqual(hashes(await files(restored.root)), hashes(state.baseline));
  for (const path of ["core.sqlite", ".pkm-next-workspace", ".pkm-next-original-mcp.json", ".pkm-next-todo",
    ".pkm-native", ...Object.values(sourceFixture.paths)]) await absent(join(restored.root, path), "INSTALLED_TODO_GENESIS_B0_NATIVE_STATE_OR_BOARD");
  return { ...preserved, originalB0BytesRestored: true, noBoardOrNativeAuthorityRestored: true, originalRootOverwritten: false };
}
