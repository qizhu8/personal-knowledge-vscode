import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInstalledNotePaperBasicOracle } from "../../tests/installed-note-paper-basic-oracle.mjs";
import {
  installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u,
  assertInstalledKnowledgeMoveComponentBinding, readInstalledKnowledgeMoveRetirementReceipt,
  readInstalledKnowledgeMoveRestoredReceipt,
} from "./installed-native-knowledge-move.mjs";
import {
  createInstalledNativeNotePaperBasicStageProtocol, startInstalledNativeNotePaperBasicUi,
} from "./installed-native-note-paper-basic-ui.mjs";

const states = new WeakMap(), category = "BasicPublic";
export const installedNativeNotePaperBasicPrivacyPolicy = installedNativeKnowledgeMovePrivacyPolicy;
export const installedNativeNotePaperBasicOwners = Object.freeze([
  { kind: "note", area: "notes", title: "BasicCreatedNote", slug: `${category}/BasicCreatedNote`,
    occupied: `${category}/BasicOccupiedNote`, oldMarker: "basicnotebodyoldunique", newMarker: "basicnotebodynewunique",
    create: { title: "BasicCreatedNote", category, content: "basicnotebodyoldunique\n" },
    update: { slug: `${category}/BasicCreatedNote`, content: "basicnotebodynewunique\n", tags: ["basicnotemetadatanewunique"] } },
  { kind: "paper", area: "papers", title: "BasicCreatedPaper", slug: `${category}/BasicCreatedPaper`,
    occupied: `${category}/BasicOccupiedPaper`, oldMarker: "basicpapermetadataoldunique", newMarker: "basicpapermetadatanewunique",
    bodyMarker: "basicpaperbodyonlyunique",
    create: { title: "BasicCreatedPaper", category, topic: "basicpapermetadataoldunique", content: "basicpaperbodyonlyunique\n" },
    update: { slug: `${category}/BasicCreatedPaper`, topic: "basicpapermetadatanewunique", content: "Updated Paper body.\n",
      authors: ["Bounded Original Author"], tags: ["basicpapermetadatanewunique"] } },
].map(owner => Object.freeze({ ...owner, create: Object.freeze(owner.create), update: Object.freeze(owner.update) })));
export const installedNativeNotePaperBasicStages = Object.freeze(installedNativeNotePaperBasicOwners.flatMap(owner => {
  const { kind, slug } = owner, prefix = `native-note-paper-basic-${kind}`;
  const get = { slug }, list = kind === "note" ? { directory: category } : {};
  return [
    { suffix: "create", tool: `add_${kind}`, arguments: owner.create, publicChoice: "Approve this request", effect: "create" },
    { suffix: "get-created", tool: `get_${kind}`, arguments: get },
    { suffix: "list-created", tool: `list_${kind}s`, arguments: list },
    ...(kind === "note" ? [{ suffix: "list-public-filter", tool: "list_notes", arguments: {} }] : []),
    { suffix: "search-created", tool: `search_${kind}s`, arguments: { query: owner.oldMarker } },
    ...(kind === "paper" ? [{ suffix: "body-only-control", tool: "search_papers", arguments: { query: owner.bodyMarker } }] : []),
    { suffix: "duplicate-create", tool: `add_${kind}`, arguments: owner.create, publicChoice: "Approve this request", refusal: "duplicate" },
    { suffix: "deny-update", tool: `update_${kind}`, arguments: { slug, content: "Independent denial must not apply.\n" },
      publicChoice: "Deny", refusal: "denied" },
    { suffix: "update", tool: `update_${kind}`, arguments: owner.update, publicChoice: "Approve this request", effect: "update" },
    { suffix: "get-updated", tool: `get_${kind}`, arguments: get },
    { suffix: "list-updated", tool: `list_${kind}s`, arguments: list },
    { suffix: "search-updated", tool: `search_${kind}s`, arguments: { query: owner.newMarker } },
    { suffix: "old-search-empty", tool: `search_${kind}s`, arguments: { query: owner.oldMarker } },
    { suffix: "private-filter", tool: `search_${kind}s`, arguments: { query: "basicprivatesentinel" } },
    { suffix: "occupied-identity", tool: `update_${kind}`, arguments: { slug, title: owner.occupied.split("/").at(-1),
      content: "Must not overwrite an occupied Original identity.\n" }, publicChoice: "Approve this request", refusal: "occupied" },
    ...(kind === "note" ? [{ suffix: "private-uri", tool: "update_note",
      arguments: { slug, content: "[private](../Private/BasicPrivateNote.md)\n" },
      publicChoice: "Approve this request", refusal: "private-uri" }] : []),
  ].map(step => {
    const { suffix, ...rest } = step;
    const publicChoice = rest.publicChoice ?? (rest.tool === "list_papers" ? "Approve this request" : undefined);
    return Object.freeze({ ...rest, stage: `${prefix}-${suffix}`, kind, arguments: Object.freeze(rest.arguments),
      ...(publicChoice ? { publicChoice } : { noReview: true }) });
  });
}));
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value, phase) {
  const state = states.get(value);
  if (!state) fail("INSTALLED_NOTE_PAPER_BASIC_ACTUAL_PREPARATION_REQUIRED");
  if (phase && state.phase !== phase) fail("INSTALLED_NOTE_PAPER_BASIC_VERIFIED_PHASE_REQUIRED");
  return state;
}
export function assertInstalledNativeNotePaperBasicCatalog(catalog, receipt) {
  assert.equal(catalog.provenance.metadataSha256, receipt.sourceCatalogSha256);
  const names = [...new Set(installedNativeNotePaperBasicStages.map(stage => stage.tool))];
  assert.equal(names.length, 10, "Bound this leaf to ten exact Original IDs.");
  return names.map(tool => {
    const contract = catalog.contracts.find(item => item.transportName === tool);
    assert(contract, `Missing actual Original contract ${tool}`);
    assert.equal(contract.id, `mcp.tool.${tool}`); assert.equal(contract.version, 1);
    assert.equal(contract.readOnly, !tool.startsWith("add_") && !tool.startsWith("update_") && tool !== "list_papers",
      "list_papers is not catalog-readonly; it must keep its ordinary independent PUBLIC approval.");
    for (const step of installedNativeNotePaperBasicStages.filter(step => step.tool === tool)) {
      assert.equal(!!step.publicChoice, !contract.readOnly);
      for (const key of Object.keys(step.arguments)) assert(key in contract.inputSchema.properties,
        "Never invent an expected_revision or worker_token field absent from this Original schema.");
    }
    return { tool, operation: contract.id, version: contract.version, readOnly: contract.readOnly };
  });
}
const seed = `
  const rows={};
  for(const [kind,label] of [["note","Note"],["paper","Paper"]]){
    for(const role of ["Seed","Occupied"]){
      const title="Basic"+role+label;
      store[kind+"Upsert"]({slug:"BasicPublic/"+title,title,category:"BasicPublic",
        type:"general",topic:"basicpubliccontrol",content:"Original bounded control "+role+"\\n"});
    }
    store[kind+"Upsert"]({slug:"Private/BasicPrivate"+label,title:"BasicPrivate"+label,category:"Private",
      type:"general",topic:"basicprivatesentinel",tags:["basicprivatesentinel"],content:"basicprivatesentinel private body\\n"});
    rows[kind]=store[kind+"Get"]("BasicPublic/BasicSeed"+label);
  }
  return rows;
`;
async function closedCopy(state, root) {
  const timestamps = [], files = await u.files(root, true);
  for (const owner of installedNativeNotePaperBasicOwners) {
    const destination = join(state.oracle.root, owner.area, category);
    await rm(destination, { recursive: true, force: true });
    await cp(join(root, owner.area, category), destination, { recursive: true,
      force: false, errorOnExist: true, preserveTimestamps: true });
    for (const file of files) {
      if (!file.path.startsWith(`${owner.area}/${category}/`)) continue;
      const stat = await lstat(join(root, file.path), { bigint: true });
      timestamps.push({ path: file.path, atimeNs: String(stat.atimeNs), mtimeNs: String(stat.mtimeNs) });
    }
  }
  // Node cp uses millisecond Date values. Restore exact owned nanoseconds on the closed copy only.
  execFileSync(state.python, ["-I", "-B", "-c", `
import json,os,sys
from pathlib import Path
root=Path(sys.argv[1])
for row in json.load(sys.stdin):
 path=root/row["path"]
 path.resolve().relative_to(root)
 os.utime(path,ns=(int(row["atimeNs"]),int(row["mtimeNs"])),follow_symlinks=False)
`, state.oracle.root], { input: JSON.stringify(timestamps), cwd: state.componentFixture.directory,
    env: { ...process.env, TMPDIR: join(state.componentFixture.directory, "scratch"), PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "pipe", timeout: 10000 });
}
function publication(value) {
  u.noPrivatePublication(value);
  assert(!JSON.stringify(value).includes("basicprivatesentinel"), "Private title/body/metadata must never enter PUBLIC results.");
}
function valueOf(response) {
  publication(response); assert.notEqual(response.isError, true, JSON.stringify(response));
  return response.structuredContent ?? JSON.parse(response.content[0].text);
}
function live(component) {
  const database = component.storage.connectNative();
  try {
    return {
      intents: database.prepare("SELECT * FROM migration_runtime_intents ORDER BY operation_id").all().map(row => ({ ...row })),
      receipts: database.prepare("SELECT * FROM receipts WHERE operation GLOB 'knowledge.*.create' OR operation GLOB 'knowledge.*.update' ORDER BY operation_id")
        .all().map(row => ({ ...row })),
    };
  } finally { database.close(); }
}
async function preservation(state, root) {
  assert(state.protectedFiles, "Capture controls after Parent's common prelude, not from stale B0 public bytes.");
  for (const file of state.protectedFiles) assert.deepEqual(await readFile(join(root, file.path)), file.bytes);
}
async function ownedRow(state, owner, root) {
  const rows = await u.load(state.installed, "markdown");
  const document = rows.scanMarkdown(root).find(row => row.record.area === owner.area && row.record.path === `${owner.slug}.md`);
  assert(document, "Created native PUBLIC Markdown must exist in the real producer projection.");
  assert.equal(document.record.id, document.metadata.get("knowledgeId"));
  assert.match(document.record.id, /^knowledge_[a-f0-9]{24}$/);
  return { id: document.record.id, revision: document.record.revision, sha256: document.record.sha256,
    path: document.record.path, raw: await readFile(join(root, owner.area, document.record.path)) };
}
/** Call once while the branded parent fixture is cold, before B0/custody/native Root publication. */
export async function prepareInstalledNativeNotePaperBasicFixture({ installed, componentFixture, legacyVsix, python }) {
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (states.has(componentFixture)) fail("INSTALLED_NOTE_PAPER_BASIC_ALREADY_PREPARED");
  for (const path of ["core.sqlite", ".pkm-next-original-mcp.json"])
    await u.absent(join(componentFixture.root, path), "INSTALLED_NOTE_PAPER_BASIC_PRE_B0_REQUIRED");
  for (const path of ["b0", "custody"]) await u.absent(join(componentFixture.directory, path), "INSTALLED_NOTE_PAPER_BASIC_PRE_B0_REQUIRED");
  if (!isAbsolute(python ?? "")) fail("INSTALLED_NOTE_PAPER_BASIC_EXPLICIT_PYTHON_REQUIRED");
  await u.privateDirectory(componentFixture.root, "INSTALLED_NOTE_PAPER_BASIC_PRIVATE_ROOT_REQUIRED");
  const privacyPath = join(componentFixture.root, ".pkm/content-privacy.json"), stat = await lstat(privacyPath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077));
  const privacy = await readFile(privacyPath);
  assert.deepEqual(JSON.parse(privacy), installedNativeNotePaperBasicPrivacyPolicy,
    "Parent must independently configure the exact Original Private top-level policy.");
  for (const area of ["notes", "skills", "papers"]) await mkdir(join(componentFixture.root, area), { recursive: true, mode: 0o700 });
  for (const owner of installedNativeNotePaperBasicOwners) {
    await u.absent(join(componentFixture.root, owner.area, category), "INSTALLED_NOTE_PAPER_BASIC_DISJOINT_SEED_REQUIRED");
    await u.absent(join(componentFixture.root, owner.area, "Private"), "INSTALLED_NOTE_PAPER_BASIC_DISJOINT_SEED_REQUIRED");
  }
  for (const owner of installedNativeNotePaperBasicOwners) for (const folder of [category, "Private"])
    await mkdir(join(componentFixture.root, owner.area, folder), { mode: 0o700 });
  const oracle = await createInstalledNotePaperBasicOracle({ directory: componentFixture.directory, legacyVsix, python });
  oracle.writer.run(componentFixture.root, seed);
  assert.deepEqual(await readFile(privacyPath), privacy);
  const baseline = await u.files(componentFixture.root);
  const state = { installed, componentFixture, oracle, python, privacy, baseline, phase: "prepared" };
  await closedCopy(state, componentFixture.root);
  const expected = {};
  for (const owner of installedNativeNotePaperBasicOwners) {
    const create = await oracle.invoke(`add_${owner.kind}`, owner.create);
    assert.deepEqual(create, { ok: true, slug: owner.slug });
    const created = oracle.writer.run(oracle.root, `return store[input.kind+"Get"](input.slug);`, owner);
    assert.equal(created.revision, undefined);
    assert.equal(created.knowledgeId, undefined);
    assert.equal(created.category, category);
    const duplicate = await oracle.invoke(`add_${owner.kind}`, owner.create);
    assert.equal(typeof duplicate.error, "string");
    const beforeOccupied = u.hashes(await u.files(oracle.root));
    let occupiedFailure;
    try { await oracle.invoke(`update_${owner.kind}`, { slug: owner.slug, title: owner.occupied.split("/").at(-1),
      content: "Must not overwrite an occupied Original identity.\n" }); } catch (error) { occupiedFailure = error; }
    assert(occupiedFailure, "Only require occupied identity refusal when the actual Original writer does refuse it.");
    assert.deepEqual(u.hashes(await u.files(oracle.root)), beforeOccupied);
    const search = await oracle.invoke(`search_${owner.kind}s`, { query: owner.oldMarker });
    assert(search.some(row => row.slug === owner.slug), "Original lexical oracle must locate its unique public marker.");
    if (owner.kind === "paper") assert.deepEqual(await oracle.invoke("search_papers", { query: owner.bodyMarker }), []);
    const update = await oracle.invoke(`update_${owner.kind}`, owner.update);
    assert.deepEqual(update, create);
    const updated = oracle.writer.run(oracle.root, `return store[input.kind+"Get"](input.slug);`, owner);
    assert.equal(updated.knowledgeId, undefined); assert.equal(updated.revision, undefined);
    expected[owner.kind] = { create, duplicate, update, created, updated };
  }
  const value = Object.freeze({ kind: "pkm.installed-native-note-paper-basic-fixture/v1", root: componentFixture.root,
    originalPackageSha256: oracle.writer.originalPackageSha256, originalMcpSourceSha256: oracle.sourceSha256,
    privacySha256: u.hash(privacy), owners: installedNativeNotePaperBasicOwners,
    files: Object.freeze(u.hashes(baseline).map(Object.freeze)) });
  state.value = value; state.expected = expected;
  states.set(componentFixture, state); states.set(value, state); return value;
}

/** Observes/reads only; Parent owns the actual component, editors, RootOwner and retirement. */
export async function verifyInstalledNativeNotePaperBasic({ root, installed, component, sourceFixture, payloadBuildId,
  python, env, port, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture, "prepared");
  if (state.installed !== installed || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_NOTE_PAPER_BASIC_SAME_COMPONENT_REQUIRED");
  const { host, full } = await assertInstalledKnowledgeMoveComponentBinding({ root, installed, component,
    componentFixture: state.componentFixture, payloadBuildId });
  assert.equal(full.runtime.services.modelProvider, undefined); assert.equal(host.nativeChat, undefined);
  const catalog = (await u.load(installed, "native-public-original-mcp-contracts")).originalPublicMcpContracts();
  const publicContracts = assertInstalledNativeNotePaperBasicCatalog(catalog, host.receipt);
  for (const owner of sourceFixture.owners)
    await u.absent(join(component.root, owner.area, `${owner.slug}.md`), "INSTALLED_NOTE_PAPER_BASIC_REAL_CREATE_REQUIRED");
  for (const file of state.baseline.filter(file => file.path.includes("/Private/") || file.path.includes(`/${category}/`)))
    assert.deepEqual(await readFile(join(component.root, file.path)), file.bytes);
  state.protectedFiles = [...await u.files(component.root, true),
    ...state.baseline.filter(file => !["notes", "skills", "papers"].includes(file.path.split("/")[0]))];
  await preservation(state, component.root);
  state.b0Sha256 = component.b0.sha256;
  const binding = { root: component.root, workspaceId: component.workspaceId, custodyPlanSha256: component.custody.planSha256,
    catalogSha256: host.receipt.sourceCatalogSha256, profileSha256: host.receipt.profileSha256,
    privacySha256: component.custody.privacySha256, epoch: host.receipt.epoch,
    nativeHostReceiptSha256: host.receipt.receiptSha256 };
  const runId = randomUUID(), abort = new AbortController(), lease = { ...component.owner.workspaceLease() };
  await writeFile(join(root, "native-note-paper-basic-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-note-paper-basic-ui/v1", runId, binding, publicContracts, stages: installedNativeNotePaperBasicStages,
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativeNotePaperBasicUi({ root, python, env, port, runId, timeoutMs });
  void ui.done.catch(error => abort.abort(error));
  const check = async () => {
    if (ui.error) throw ui.error;
    abort.signal.throwIfAborted(); host.assertCurrent(); component.storage.assertWorkspaceLease();
    assert.deepEqual({ ...component.owner.workspaceLease() }, lease);
    assert.equal((await component.owner.ensureFull()).runtime.core, full.runtime.core);
    await preservation(state, component.root);
  };
  const protocol = await createInstalledNativeNotePaperBasicStageProtocol({ root, runId, timeoutMs,
    stages: installedNativeNotePaperBasicStages.map(step => step.stage), check });
  const outcomes = [], receipts = [], created = new Map();
  try {
    await ui.ready; await check();
    for (const step of installedNativeNotePaperBasicStages) {
      await protocol.begin(step.stage);
      const owner = sourceFixture.owners.find(owner => owner.kind === step.kind);
      const beforeFiles = await u.files(component.root, true), beforeJournal = live(component);
      await closedCopy(state, component.root);
      let response, failure;
      try { response = await component.invoke(step.tool, step.arguments, abort.signal); }
      catch (error) { failure = error; }
      if (response) publication(response);
      if (failure) publication({ message: failure.message });
      if (step.refusal) {
        if (step.refusal === "duplicate") {
          assert.equal(failure, undefined);
          assert.deepEqual(valueOf(response), state.expected[owner.kind].duplicate);
        } else {
          const refusal = failure ?? (response?.isError ? response.structuredContent : undefined);
          assert(refusal, "Refusals must not return a success-like result or be retried.");
          if (step.refusal === "denied") assert.equal(refusal.code, "ACCESS_DENIED");
          else if (step.refusal === "occupied") assert.match(refusal.message ?? JSON.stringify(response), /CONFLICT|occupied|collision|already exists/i);
          else assert.match(refusal.message ?? JSON.stringify(response), /PRIVATE_RESOURCE|private.*reference|private.*resource/i);
        }
        assert.deepEqual(await u.files(component.root, true), beforeFiles);
        assert.deepEqual(live(component), beforeJournal);
        outcomes.push({ stage: step.stage, noEffects: true, refusal: step.refusal });
      } else {
        if (failure) throw failure;
        const result = valueOf(response), expected = await state.oracle.invoke(step.tool, step.arguments);
        if (step.effect) {
          assert.deepEqual(result, state.expected[owner.kind][step.effect]);
          const row = await ownedRow(state, owner, component.root);
          if (step.effect === "create") { assert.equal(row.revision, 1); created.set(owner.kind, row); }
          else { assert.equal(row.id, created.get(owner.kind).id); assert.equal(row.revision, created.get(owner.kind).revision + 1); }
          await closedCopy(state, component.root);
          const originalRow = state.oracle.writer.run(state.oracle.root, `return store[input.kind+"Get"](input.slug);`, owner);
          assert.equal(originalRow.knowledgeId, row.id); assert.equal(originalRow.revision, row.revision);
          const semantic = state.expected[owner.kind][step.effect === "create" ? "created" : "updated"];
          for (const key of owner.kind === "note" ? ["title", "content", "category", "type", "tags"]
            : ["title", "content", "category", "authors", "year", "topic", "publisher", "tags", "url", "file", "conclusions", "cites"])
            assert.deepEqual(originalRow[key], semantic[key], `Actual Original ${key} default/update must match.`);
          const after = live(component), prior = new Set(beforeJournal.receipts.map(receipt => receipt.operation_id));
          const added = after.receipts.filter(receipt => !prior.has(receipt.operation_id));
          assert.equal(after.intents.length, 0); assert.equal(added.length, 1);
          const receipt = added[0], value = JSON.parse(receipt.result);
          assert.equal(receipt.actor_id, "mcp:external");
          assert.equal(receipt.operation, `knowledge.${owner.kind === "paper" ? "research" : owner.kind}.${step.effect}`);
          assert.equal(value.operationId, receipt.operation_id); assert.equal(value.id, row.id);
          assert.equal(value.path, row.path); assert.equal(value.revision, row.revision); assert.equal(value.sha256, row.sha256);
          publication(value); receipts.push(receipt);
          const changedPath = `${owner.area}/${owner.slug}.md`;
          assert.deepEqual((await u.files(component.root, true)).filter(file => file.path !== changedPath),
            beforeFiles.filter(file => file.path !== changedPath), "The PUBLIC write may change only its one owned Markdown document.");
          outcomes.push({ stage: step.stage, id: row.id, revision: row.revision, sha256: row.sha256,
            receiptOperationId: receipt.operation_id });
        } else if (step.tool === "list_notes") {
          assert.equal(result.schema, expected.schema);
          const originalItems = expected.items ?? expected.notes, actualItems = result.items ?? result.notes;
          assert(Array.isArray(originalItems) && Array.isArray(actualItems), "Actual Original Note inventory envelope required.");
          if (step.stage.endsWith("list-public-filter")) {
            assert.deepEqual(actualItems.filter(row => row.slug.startsWith(`${category}/`)), originalItems);
            assert(!actualItems.some(row => row.slug.startsWith("Private/")));
            assert.equal(result.directory, "");
          } else {
            assert.deepEqual(result, expected, "Exact bytes and nanosecond mtimes determine the Original inventory revision/envelope.");
          }
          assert.match(result.inventory_revision, /^[a-f0-9]{64}$/);
          outcomes.push({ stage: step.stage, originalInventoryEnvelope: true, count: actualItems.length });
        } else {
          if (step.tool === "list_papers") {
            const actual = result.filter(row => row.slug.startsWith(`${category}/`));
            assert.deepEqual(actual, expected);
          } else assert.deepEqual(result, expected);
          if (step.stage.endsWith("search-created") || step.stage.endsWith("search-updated"))
            assert(result.some(row => row.slug === owner.slug), "Unique lexical marker must identify the real created/updated document.");
          if (step.stage.endsWith("body-only-control") || step.stage.endsWith("old-search-empty") || step.stage.endsWith("private-filter"))
            assert.deepEqual(result, []);
          outcomes.push({ stage: step.stage, originalResponse: true });
        }
        if (!step.effect) {
          assert.deepEqual(await u.files(component.root, true), beforeFiles);
          assert.deepEqual(live(component), beforeJournal);
        }
      }
      await check(); await protocol.complete(step.stage);
    }
    assert.equal(receipts.length, 4);
    await protocol.finish(); await ui.done; await check();
    const proof = JSON.parse(await readFile(join(root, "native-note-paper-basic-ui-passed.json")));
    assert.equal(proof.passed, true); assert.equal(proof.actualRenderedDom, true); assert.equal(proof.runId, runId);
    assert.deepEqual(proof.dialogs.map(row => ({ stage: row.stage, choice: row.choice })),
      installedNativeNotePaperBasicStages.filter(step => step.publicChoice).map(step => ({ stage: step.stage, choice: step.publicChoice })));
    state.receipts = receipts; state.finalKnowledge = u.hashes(await u.files(component.root, true));
    state.finalRows = await Promise.all(sourceFixture.owners.map(owner => ownedRow(state, owner, component.root)));
    state.evidence = { passed: true, actualNativeUi: true, actualComponentInvoke: true, scope: "PUBLIC Note/Paper basic only",
      originalPackageSha256: sourceFixture.originalPackageSha256, originalMcpSourceSha256: sourceFixture.originalMcpSourceSha256,
      newlyExercisedOriginalIds: ["add_note", "list_notes", "search_notes", "add_paper", "list_papers", "search_papers"].map(name => `mcp.tool.${name}`),
      existingGetUpdateIdsNotNewCoverage: true, originalCreateIsNotUpsert: true, duplicateCreateNoEffects: true,
      sameIdentityRevisionIncrement: true, originalMcpRawWriteAssignsIdentity: false,
      independentDenialNoEffects: true, occupiedOtherIdentityNoEffects: true,
      privateRootFilterNoLeakage: true, paperOfflineMetadataOnly: true, publicCallerCasArgumentInvented: false,
      publicStaleCasPerformed: false,
      readOnlyActorLanePerformed: false, semanticOrNetworkPerformed: false, outcomes,
      liveReceiptsSha256: u.hash(JSON.stringify(receipts)), binding, payloadBuildId,
      canonicalReceipts: receipts.map(receipt => ({
        operationId: receipt.operation_id, operation: receipt.operation, actorId: receipt.actor_id,
        fingerprint: receipt.fingerprint, resultSha256: u.hash(receipt.result),
      })),
      createdDocumentRows: state.finalRows.map(row => ({
        id: row.id, path: row.path, revision: row.revision, rawSha256: row.sha256,
      })),
      actualDialogs: proof.dialogs,
      acknowledgedStageCount: installedNativeNotePaperBasicStages.length,
      publicDialogCount: proof.dialogs.length,
      installedHostEntrySha256: u.hash(await readFile(join(installed, "dist/extension.cjs"))),
      b1AndB0Qualified: false, fullCutoverQualified: false };
    state.phase = "verified";
    await writeFile(join(root, "native-note-paper-basic-passed.json"), JSON.stringify(state.evidence), { mode: 0o600, flag: "wx" });
    return state.evidence;
  } catch (error) { await protocol.fail(error); throw error; }
  finally { if (state.phase !== "verified") state.phase = "failed"; abort.abort(); await ui.stop(); }
}
export async function verifyInstalledNativeNotePaperBasicB1(sourceFixture, { retirement, b1, stoppedCoreSha256 }) {
  const state = stateFor(sourceFixture, "verified");
  const receipt = await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture,
    sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 }, retirement);
  if (b1?.kind !== "pkm.original-mcp-component-b1/v1" || b1.b1Sha256 !== receipt.b1Sha256
    || typeof b1.b1Path !== "string" || relative(state.componentFixture.directory, b1.b1Path).includes(sep)
    || !/b1-[a-f0-9-]{36}$/.test(b1.b1Path) || !/^[a-f0-9]{64}$/.test(stoppedCoreSha256 ?? ""))
    fail("INSTALLED_NOTE_PAPER_BASIC_STOPPED_B1_REQUIRED");
  await u.privateDirectory(b1.b1Path, "INSTALLED_NOTE_PAPER_BASIC_PRIVATE_B1_REQUIRED");
  const bytes = await readFile(join(b1.b1Path, "manifest.json")), image = JSON.parse(bytes);
  assert.equal(u.hash(bytes), receipt.b1Sha256); assert.equal(image.root, sourceFixture.root);
  assert.equal(image.schema, "pkm.original-mcp-component-image/v1");
  const complete = JSON.parse(await readFile(join(b1.b1Path, "complete.json")));
  assert.equal(complete.sha256, receipt.b1Sha256); assert(complete.sqliteChecks >= 1);
  const runtimeNames = ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm"];
  for (const name of (await readdir(retirement.archive)).filter(name => name.startsWith("core.sqlite")))
    assert(runtimeNames.includes(name), "Unknown new native sidecars must never be silently discarded or admitted.");
  for (const row of image.rows.filter(row => row.path.startsWith("core.sqlite")))
    assert(runtimeNames.includes(row.path) && row.directory === false, "B1 must capture only known exact native file images.");
  assert.deepEqual(u.hashes(await u.files(retirement.archive, true)), state.finalKnowledge);
  await preservation(state, retirement.archive);
  for (const row of state.finalRows)
    assert.deepEqual(await readFile(join(retirement.archive, sourceFixture.owners.find(owner => owner.slug + ".md" === row.path).area, row.path)), row.raw);
  for (const name of runtimeNames) {
    const row = image.rows.find(row => row.path === name);
    if (!row) { assert.notEqual(name, "core.sqlite"); await u.absent(join(retirement.archive, name), "INSTALLED_NOTE_PAPER_BASIC_NEW_SIDECAR"); continue; }
    const archived = await readFile(join(retirement.archive, name));
    const stat = await lstat(join(retirement.archive, name));
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid());
    assert.equal(stat.mode & 0o777, row.mode);
    assert.equal(archived.length, row.size); assert.equal(u.hash(archived), row.sha256);
    assert.equal(u.hash(await readFile(join(b1.b1Path, "payload", name))), row.sha256);
    if (name === "core.sqlite") assert.equal(row.sha256, stoppedCoreSha256);
    if (name === "core.sqlite-wal") assert.equal(archived.length, 0);
  }
  return { exactStoppedCoreAndCapturedSidecarsPreserved: true, createdUpdatedOriginalBytesPreserved: true,
    privateAndPreludeControlsPreserved: true, noArchivedSqliteReopen: true, b1Sha256: receipt.b1Sha256, stoppedCoreSha256 };
}
export async function verifyInstalledNativeNotePaperBasicRestored(sourceFixture, options) {
  const state = stateFor(sourceFixture, "verified"), b1 = await verifyInstalledNativeNotePaperBasicB1(sourceFixture, options);
  const expected = { componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 };
  const retired = await readInstalledKnowledgeMoveRetirementReceipt(expected, options.retirement);
  await readInstalledKnowledgeMoveRestoredReceipt(expected, options.retirement, options.restored, retired);
  assert.deepEqual(u.hashes(await u.files(options.restored.root)), u.hashes(state.baseline));
  for (const path of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-workspace", ".pkm-next-original-mcp.json", ".pkm-native"])
    await u.absent(join(options.restored.root, path), "INSTALLED_NOTE_PAPER_BASIC_B0_NATIVE_STATE");
  for (const owner of sourceFixture.owners)
    await u.absent(join(options.restored.root, owner.area, `${owner.slug}.md`), "INSTALLED_NOTE_PAPER_BASIC_B0_CREATED_DOC_REMAINED");
  return { ...b1, originalB0BytesRestored: true, freshB0NoCreatedDocsDatabaseOrGrants: true,
    originalRootOverwritten: false, fullCutoverQualified: false };
}
