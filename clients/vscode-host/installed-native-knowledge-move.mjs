import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  pinnedOriginalKnowledgeWriterFixture, seedOriginalKnowledge, moveOriginalKnowledge,
} from "../../tests/original-knowledge-writer-fixture.mjs";
import { startInstalledNativeKnowledgeMoveUi } from "./installed-native-knowledge-move-ui.mjs";

const preparations = new WeakMap(), hash = value => createHash("sha256").update(value).digest("hex");
const load = (installed, name) => import(pathToFileURL(join(installed, "next-runtime/server/dist", `${name}.js`)).href);
const areas = { note: "notes", skill: "skills", paper: "papers" };
const content = "Changed body\n![paired](Before.assets/opaque.bin?q=1#view)\n";
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value) {
  const state = preparations.get(value);
  if (!state) fail("INSTALLED_KNOWLEDGE_MOVE_ACTUAL_PREPARATION_REQUIRED");
  return state;
}
export const installedNativeKnowledgeMovePrivacyPolicy = Object.freeze({ schema: 1, private: Object.freeze({
  notes: Object.freeze(["Private"]), skills: Object.freeze(["Private"]), papers: Object.freeze(["Private"]),
}) });
export const installedNativeKnowledgeMoveRequests = Object.freeze([
  { stage: "native-knowledge-move-deny", tool: "update_note", choice: "Deny",
    arguments: { slug: "Old/Before", title: "NotApplied", category: "Denied", content: "Denied first move." } },
  { stage: "native-knowledge-move-note", tool: "update_note", choice: "Approve this request",
    arguments: { slug: "Old/Before", title: "After", category: "New", content } },
  { stage: "native-knowledge-move-skill", tool: "update_skill", choice: "Approve this request",
    arguments: { name: "Before", category: "New", content } },
  { stage: "native-knowledge-move-paper", tool: "update_paper", choice: "Approve this request",
    arguments: { slug: "Old/Before", title: "After", category: "New", content } },
  { stage: "native-knowledge-move-deny-after-approval", tool: "update_note", choice: "Deny",
    arguments: { slug: "New/After", title: "NotApplied", category: "Denied", content: "Prior approval grants nothing." } },
  { stage: "native-knowledge-move-shared-conflict", tool: "update_note", choice: "Approve this request",
    arguments: { slug: "Old/Shared", title: "Blocked", category: "New", content: "Must not replace shared resources." } },
].map(step => Object.freeze({ ...step, arguments: Object.freeze(step.arguments) })));
async function absent(path, code) {
  try { await lstat(path); fail(code); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function privateDirectory(path, code) {
  const stat = await lstat(path);
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path || !stat.isDirectory()
    || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail(code);
}
async function files(root, knowledgeOnly = false) {
  const result = [];
  async function walk(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const member = prefix ? `${prefix}/${name}` : name, path = join(directory, name), stat = await lstat(path);
      if (stat.isSymbolicLink() || stat.uid !== process.getuid() || !stat.isDirectory() && !stat.isFile())
        fail("INSTALLED_KNOWLEDGE_MOVE_ORIGINAL_ENTITY_REQUIRED");
      if (stat.isDirectory()) await walk(path, member);
      else {
        if (stat.nlink !== 1 || stat.size > 16_777_216) fail("INSTALLED_KNOWLEDGE_MOVE_BOUNDED_SINGLE_LINK_FILE_REQUIRED");
        const bytes = await readFile(path);
        result.push({ path: member, bytes, sha256: hash(bytes),
          identity: [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":") });
      }
    }
  }
  if (knowledgeOnly) for (const area of Object.values(areas)) await walk(join(root, area), area);
  else await walk(root);
  return result;
}
function hashes(value) { return value.map(file => ({ path: file.path, sha256: file.sha256 })); }
async function unchangedOriginalControls(state, root) {
  for (const file of state.baseline.filter(file => !Object.values(areas).includes(file.path.split("/")[0])))
    assert.deepEqual(await readFile(join(root, file.path)), file.bytes);
}
function noPrivatePublication(value) {
  const text = JSON.stringify(value);
  assert(!text.includes("Private marker") && !text.includes("Private/Secret")
    && !text.includes('"Private') && !text.includes("/Private/"), "Private reference evidence must not enter public replies or snapshots.");
}
function readJournal(database) {
  return {
    intents: database.prepare("SELECT * FROM migration_runtime_intents ORDER BY operation_id").all(),
    receipts: database.prepare("SELECT * FROM receipts WHERE operation GLOB 'knowledge.*.update' ORDER BY operation_id").all(),
  };
}
function liveJournal(component) {
  const database = component.storage.connectNative();
  try { return readJournal(database); } finally { database.close(); }
}

/** Parent configures privacy independently and stops the complete editor before this pre-B0 call. */
export async function prepareInstalledNativeKnowledgeMoveFixture({ installed, componentFixture, legacyVsix, python }) {
  await (await load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (preparations.has(componentFixture)) fail("INSTALLED_KNOWLEDGE_MOVE_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    join(componentFixture.root, ".pkm-next-original-mcp.json"), join(componentFixture.root, "core.sqlite")])
    await absent(path, "INSTALLED_KNOWLEDGE_MOVE_PRESEAL_PREPARATION_REQUIRED");
  if (typeof python !== "string" || !isAbsolute(python)) fail("INSTALLED_KNOWLEDGE_MOVE_EXPLICIT_PYTHON_REQUIRED");
  const privacyPath = join(componentFixture.root, ".pkm/content-privacy.json"), privacyStat = await lstat(privacyPath);
  if (!privacyStat.isFile() || privacyStat.isSymbolicLink() || privacyStat.nlink !== 1 || privacyStat.uid !== process.getuid()
    || privacyStat.mode & 0o077 || privacyStat.size > 2_097_152) fail("INSTALLED_KNOWLEDGE_MOVE_PRIVATE_PRIVACY_CONFIGURATION_REQUIRED");
  const privacyBytes = await readFile(privacyPath);
  assert.deepEqual(JSON.parse(privacyBytes), installedNativeKnowledgeMovePrivacyPolicy,
    "Parent must independently configure the exact standalone Knowledge-move privacy policy before seeding.");
  for (const area of Object.values(areas)) {
    await mkdir(join(componentFixture.root, area), { recursive: true, mode: 0o700 });
    for (const path of ["Old", "New", "Denied", "Private"])
      await absent(join(componentFixture.root, area, path), "INSTALLED_KNOWLEDGE_MOVE_DISJOINT_ORIGINAL_PATHS_REQUIRED");
  }
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: componentFixture.directory, legacyVsix, python });
  const rows = writer.run(componentFixture.root, seedOriginalKnowledge, { sharedCompanion: true, configurePrivacy: false });
  assert.deepEqual(await readFile(privacyPath), privacyBytes, "The leaf must not mutate independent privacy configuration.");
  const oracle = join(componentFixture.directory, "original-knowledge-move-oracle");
  await cp(componentFixture.root, oracle, { recursive: true, errorOnExist: true, force: false });
  const expected = {};
  for (const kind of Object.keys(areas)) expected[kind] = writer.run(oracle, moveOriginalKnowledge, { kind });
  const oracleBefore = hashes(await files(oracle));
  assert.throws(() => writer.run(oracle, moveOriginalKnowledge, { kind: "note", key: "Old/Shared", name: "Blocked",
    content: "Must not replace shared resources." }), /Resource is shared by Private/);
  assert.deepEqual(hashes(await files(oracle)), oracleBefore, "Original shared-resource refusal must be failure-atomic.");
  const baseline = await files(componentFixture.root);
  const value = Object.freeze({ kind: "pkm.installed-native-knowledge-move-fixture/v1", root: componentFixture.root,
    originalPackageSha256: writer.originalPackageSha256, privacySha256: hash(privacyBytes),
    originals: Object.freeze(Object.fromEntries(Object.entries(rows).map(([kind, row]) => [kind, Object.freeze({
      id: row.knowledgeId, revision: row.revision, area: areas[kind], path: "Old/Before.md",
    })]))), files: Object.freeze(hashes(baseline).map(Object.freeze)) });
  const state = { installed, componentFixture, value, baseline, rows, expected, privacyBytes, phase: "prepared" };
  preparations.set(componentFixture, state); preparations.set(value, state);
  return value;
}

async function actualInstalledBinding({ root, installed, component, sourceFixture, payloadBuildId }) {
  const state = stateFor(sourceFixture);
  if (state.installed !== installed || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_KNOWLEDGE_MOVE_SAME_COMPONENT_REQUIRED");
  return { state, ...await assertInstalledKnowledgeMoveComponentBinding({
    root, installed, component, componentFixture: state.componentFixture, payloadBuildId,
  }) };
}
/** Shared fact checks only; no source registration, approval factory or supplied success policy. */
export async function assertInstalledKnowledgeMoveComponentBinding({ root, installed, component, componentFixture, payloadBuildId }) {
  if (component.fixture !== componentFixture || component.root !== componentFixture.root)
    fail("INSTALLED_KNOWLEDGE_MOVE_SAME_COMPONENT_REQUIRED");
  if (typeof component.invoke !== "function" || typeof component.complete !== "function" || !component.owner || !component.storage)
    fail("INSTALLED_KNOWLEDGE_MOVE_ACTUAL_PUBLIC_COMPONENT_REQUIRED");
  await privateDirectory(root, "INSTALLED_KNOWLEDGE_MOVE_PRIVATE_DRIVER_REQUIRED");
  if (!/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root))) fail("INSTALLED_KNOWLEDGE_MOVE_PRIVATE_DRIVER_REQUIRED");
  await (await load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(component.fixture);
  const first = JSON.parse(await readFile(join(root, "native-identity-first.json")));
  const proof = JSON.parse(await readFile(join(root, "native-identity-passed.json")));
  const member = typeof first.result?.path === "string" ? relative(root, first.result.path) : "";
  if (!member || member === ".." || member.startsWith(`..${sep}`) || isAbsolute(member)
    || await realpath(first.result.path) !== first.result.path) fail("INSTALLED_KNOWLEDGE_MOVE_ENROLLED_PROFILE_REQUIRED");
  (await load(installed, "original-mcp-native-identity")).verifyOriginalMcpNativeIdentity(
    JSON.parse(first.publicRecord), first.result.sha256, first.result.profileSha256);
  assert.equal(await readFile(first.result.path, "utf8"), first.publicRecord);
  assert.equal(proof.passed, true); assert.equal(proof.realInstalledExtension, true);
  assert.equal(proof.identitySha256, first.result.sha256);
  const host = await component.complete(), full = await component.owner.ensureFull();
  (await load(installed, "root-owner")).assertRootOwner(component.owner);
  (await load(installed, "original-mcp-native-host")).assertOriginalMcpNativeHost(host, component.storage);
  assert.equal(full.storage, component.storage);
  const descriptorBytes = await readFile(component.attachmentDescriptorPath), descriptor = JSON.parse(descriptorBytes);
  assert.equal(hash(descriptorBytes), component.attachmentDescriptorSha256);
  assert.equal(descriptor.identitySha256, first.result.sha256);
  for (const [key, value] of Object.entries({ root: component.root, workspaceId: component.workspaceId,
    planSha256: component.custody.planSha256, profileSha256: first.result.profileSha256, payloadBuildId,
    hostEntrySha256: hash(await readFile(join(installed, "dist/extension.cjs"))) })) assert.equal(descriptor.binding[key], value);
  assert.equal(component.custody.profileSha256, first.result.profileSha256);
  assert.equal(host.receipt.authorityId, `native-rpc:${descriptor.brokerId}`);
  assert.equal(host.receipt.profileSha256, first.result.profileSha256);
  if (!/^[a-f0-9]{64}$/.test(component.b0?.sha256)) fail("INSTALLED_KNOWLEDGE_MOVE_ACTUAL_B0_REQUIRED");
  return { host, full, first };
}

/** Owns only its renderer observer; leaves the parent's component/attachment/model/source lifetimes intact. */
export async function verifyInstalledNativeKnowledgeMove({ root, installed, component, sourceFixture, payloadBuildId,
  python, env, port, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "prepared") fail("INSTALLED_KNOWLEDGE_MOVE_VERIFY_ORDER_REQUIRED");
  const { host, full, first } = await actualInstalledBinding({ root, installed, component, sourceFixture, payloadBuildId });
  const markdown = await load(installed, "markdown"), mutations = await load(installed, "knowledge-mutations");
  const lease = { ...component.owner.workspaceLease() }, runId = randomUUID(), observerAbort = new AbortController();
  const publicSnapshot = () => markdown.scanMarkdown(component.root).map(item => ({ ...item.record }));
  const initialSnapshot = publicSnapshot();
  noPrivatePublication(initialSnapshot);
  const privateBefore = (await files(component.root, true)).filter(file => file.path.includes("/Private/"));
  const initialJournal = liveJournal(component);
  assert.equal(initialJournal.intents.length, 0);
  await unchangedOriginalControls(state, component.root);
  state.b0Sha256 = component.b0.sha256;
  await writeFile(join(root, "native-knowledge-move-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-knowledge-move-ui/v1", runId,
    binding: { root: component.root, workspaceId: component.workspaceId, profileSha256: first.result.profileSha256 },
    nativeEpoch: host.receipt.epoch, steps: installedNativeKnowledgeMoveRequests,
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativeKnowledgeMoveUi({ root, python, env, port, runId, timeoutMs });
  void ui.done.catch(error => observerAbort.abort(error));
  const progress = stage => writeFile(join(root, "progress.json"), JSON.stringify({ stage }), { mode: 0o600 });
  const check = () => {
    if (ui.error) throw ui.error;
    host.assertCurrent(); component.storage.assertWorkspaceLease();
    assert.deepEqual({ ...component.owner.workspaceLease() }, lease);
  };
  const publicCall = async (tool, args) => {
    check();
    const response = await component.invoke(tool, args, observerAbort.signal);
    noPrivatePublication(response);
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const value = response.structuredContent ?? JSON.parse(response.content[0].text);
    noPrivatePublication(value); return value;
  };
  try {
    await ui.ready; check();
    for (const kind of Object.keys(areas)) {
      const read = await publicCall(`get_${kind}`, kind === "skill" ? { name: "Before" } : { slug: "Old/Before" });
      assert.equal(read.content, state.rows[kind].content); assert.equal(read.category, "Old");
      assert.equal(read[kind === "skill" ? "skill_id" : "slug"], "Old/Before");
    }
    const receipts = [], outcomes = [];
    for (const step of installedNativeKnowledgeMoveRequests) {
      check();
      const beforeFiles = hashes(await files(component.root, true)), beforeJournal = liveJournal(component);
      await progress(step.stage);
      if (step.choice === "Deny" || step.stage.endsWith("shared-conflict")) {
        let failure;
        try {
          const response = await component.invoke(step.tool, step.arguments, observerAbort.signal);
          noPrivatePublication(response);
          if (response.isError) failure = new Error(JSON.stringify(response));
        } catch (error) { failure = error; }
        assert(failure, "Denial/conflict must refuse; never retry or accept a success-like response.");
        noPrivatePublication({ message: failure.message });
        if (step.choice === "Deny") assert.equal(failure.code, "ACCESS_DENIED");
        else assert.match(failure.message, /CONFLICT.*shared/i);
        assert.deepEqual(hashes(await files(component.root, true)), beforeFiles);
        assert.deepEqual(liveJournal(component), beforeJournal);
        await unchangedOriginalControls(state, component.root);
        outcomes.push({ stage: step.stage, refused: true, noChanges: true });
        continue;
      }
      const result = await publicCall(step.tool, step.arguments), kind = step.tool.slice(7), area = areas[kind];
      const name = kind === "skill" ? "Before" : "After", destination = `New/${name}.md`;
      assert.deepEqual(result, kind === "skill" ? { ok: true, name } : { ok: true, slug: "New/After" });
      const document = markdown.scanMarkdown(component.root).find(item => item.record.area === area && item.record.path === destination);
      assert(document); const expected = state.expected[kind];
      assert.equal(document.record.id, state.rows[kind].knowledgeId);
      assert.equal(document.metadata.get("knowledgeId"), expected.knowledgeId);
      assert.equal(document.record.revision, expected.revision);
      assert.deepEqual([...document.metadata.toJS().aliases].sort(), [...expected.aliases].sort());
      assert.equal(document.record.content, expected.content);
      assert(document.record.content.includes(`${name}.assets/opaque.bin?q=1#view`));
      await absent(join(component.root, area, "Old/Before.md"), "INSTALLED_KNOWLEDGE_MOVE_OLD_POSITION_REMAINED");
      await absent(join(component.root, area, "Old/Before.assets"), "INSTALLED_KNOWLEDGE_MOVE_OLD_ASSETS_REMAINED");
      assert.deepEqual(await readFile(join(component.root, area, `New/${name}.assets/opaque.bin`)), Buffer.from([255, 0, 128, 9]));
      const afterJournal = liveJournal(component), previousIds = new Set(beforeJournal.receipts.map(row => row.operation_id));
      const added = afterJournal.receipts.filter(row => !previousIds.has(row.operation_id));
      assert.equal(afterJournal.intents.length, 0); assert.equal(added.length, 1);
      const receipt = added[0], value = JSON.parse(receipt.result);
      assert.equal(receipt.actor_id, "mcp:external");
      assert.equal(receipt.operation, `knowledge.${kind === "paper" ? "research" : kind}.update`);
      assert.equal(value.operationId, receipt.operation_id); assert.equal(value.id, document.record.id);
      assert.equal(value.path, destination); assert.equal(value.revision, document.record.revision);
      assert.equal(value.sha256, document.record.sha256);
      noPrivatePublication(value); receipts.push({ ...receipt }); outcomes.push({ stage: step.stage, receiptOperationId: receipt.operation_id });
      const read = await publicCall(`get_${kind}`, kind === "skill" ? { name } : { slug: "New/After" });
      assert.equal(read.content, expected.content); assert.equal(read.category, "New");
      assert.equal(read[kind === "skill" ? "name" : "title"], name);
      assert.equal(read[kind === "skill" ? "skill_id" : "slug"], `New/${name}`);
    }
    const records = markdown.scanMarkdown(component.root), old = sourceFixture.originals.note;
    const beforeStale = hashes(await files(component.root, true)), journalBeforeStale = liveJournal(component);
    const stale = await full.runtime.core.dispatch("capability_call", { operation: "knowledge.note.update", version: 1,
      arguments: { operationId: randomUUID(), id: old.id, expectedRevision: old.revision,
        expectedSha256: initialSnapshot.find(row => row.id === old.id).sha256,
        expectedScanRevision: mutations.knowledgeMutationScanRevision(records), preserveIdentity: true,
        title: "StaleNotApplied", category: "Denied", moveTo: "Denied/StaleNotApplied.md" } },
      { id: "mcp:external", canWrite: true });
    assert.equal(stale.error.code, "CONFLICT"); noPrivatePublication(stale);
    assert.deepEqual(hashes(await files(component.root, true)), beforeStale);
    assert.deepEqual(liveJournal(component), journalBeforeStale);
    const privateAfter = (await files(component.root, true)).filter(file => file.path.includes("/Private/"));
    assert.deepEqual(privateAfter, privateBefore);
    assert.deepEqual(await readFile(join(component.root, ".pkm/content-privacy.json")), state.privacyBytes);
    await unchangedOriginalControls(state, component.root);
    const finalSnapshot = publicSnapshot(); noPrivatePublication(finalSnapshot); check();
    assert.equal(receipts.length, 3);
    await progress("native-knowledge-move-complete"); await ui.done; check();
    const uiProof = JSON.parse(await readFile(join(root, "native-knowledge-move-ui-passed.json")));
    assert.equal(uiProof.passed, true); assert.equal(uiProof.runId, runId);
    assert.equal(uiProof.actualRenderedDom, true); assert.equal(uiProof.dialogs.length, 6);
    assert.deepEqual(uiProof.dialogs.map(row => ({ stage: row.stage, choice: row.choice })),
      installedNativeKnowledgeMoveRequests.map(row => ({ stage: row.stage, choice: row.choice })));
    state.receipts = receipts; state.b1Knowledge = hashes(await files(component.root, true));
    state.evidence = { passed: true, scope: "bounded disposable original Knowledge moves only",
      actualNativeUi: true, originalPackageSha256: sourceFixture.originalPackageSha256,
      sameOwnerLease: true, freshDenialBeforeAndAfterApproval: true, approvedSharedConflictNoChanges: true,
      privateReferencesReadOnly: true, publicProjectionNoPrivateContent: true, threeIdentityPreservingMoves: true,
      internalCoreStaleSourceCasRefused: true, blindPublicMutationReplayAttempted: false,
      attachmentRevoked: false, interruptionInjectionUsed: false, outcomes,
      nativeReceiptSha256: hash(JSON.stringify(receipts)), b1AndB0Qualified: false, fullCutoverQualified: false };
    state.phase = "verified";
    await writeFile(join(root, "native-knowledge-move-passed.json"), JSON.stringify(state.evidence), { mode: 0o600, flag: "wx" });
    return state.evidence;
  } finally {
    if (state.phase !== "verified") state.phase = "failed";
    observerAbort.abort(); await ui.stop();
  }
}

async function parentRetirement(state, retirement) {
  if (state.phase !== "verified" || !state.receipts) fail("INSTALLED_KNOWLEDGE_MOVE_VERIFIED_EFFECTS_REQUIRED");
  return readInstalledKnowledgeMoveRetirementReceipt({
    componentFixture: state.componentFixture, sourceRoot: state.value.root, b0Sha256: state.b0Sha256,
  }, retirement);
}
export async function readInstalledKnowledgeMoveRetirementReceipt({ componentFixture, sourceRoot, b0Sha256 }, retirement) {
  if (retirement?.kind !== "pkm.original-mcp-component-retirement/v1" || retirement.root !== sourceRoot
    || retirement.receiptPath !== join(componentFixture.directory, "retirement-complete.json")
    || typeof retirement.archive !== "string" || relative(sourceRoot, retirement.archive) !== basename(retirement.archive)
    || !/^\.pkm-next-component-retired-[a-f0-9-]{36}$/.test(basename(retirement.archive)))
    fail("INSTALLED_KNOWLEDGE_MOVE_PARENT_RETIREMENT_REQUIRED");
  await privateDirectory(retirement.archive, "INSTALLED_KNOWLEDGE_MOVE_PRIVATE_ARCHIVE_REQUIRED");
  const bytes = await readFile(retirement.receiptPath), receipt = JSON.parse(bytes);
  assert.equal(hash(bytes), retirement.receiptSha256); assert.equal(receipt.schema, retirement.kind);
  assert.equal(receipt.root, sourceRoot); assert.equal(receipt.archive, retirement.archive);
  assert.equal(receipt.enginesStopped, true); assert.equal(receipt.originalPathRetired, true);
  assert.equal(receipt.b0Sha256, b0Sha256);
  return receipt;
}
export async function verifyInstalledNativeKnowledgeMoveB1(sourceFixture, { retirement }) {
  const state = stateFor(sourceFixture);
  await parentRetirement(state, retirement);
  assert.deepEqual(hashes(await files(retirement.archive, true)), state.b1Knowledge);
  assert.deepEqual(await readFile(join(retirement.archive, ".pkm/content-privacy.json")), state.privacyBytes);
  await unchangedOriginalControls(state, retirement.archive);
  const database = new DatabaseSync(join(retirement.archive, "core.sqlite"), { readOnly: true });
  try {
    const journal = readJournal(database);
    assert.equal(journal.intents.length, 0);
    for (const receipt of state.receipts) {
      const stored = journal.receipts.find(row => row.operation_id === receipt.operation_id);
      assert(stored, "The archived B1 database must retain each exact native move receipt.");
      assert.deepEqual({ ...stored }, receipt);
    }
  } finally { database.close(); }
  return { movedB1PositionsAndAssetsPreserved: true, privateB1BytesPreserved: true, nativeMoveReceiptsPreserved: true };
}
export async function verifyInstalledNativeKnowledgeMoveRestored(sourceFixture, { retirement, restored }) {
  const state = stateFor(sourceFixture), b1 = await verifyInstalledNativeKnowledgeMoveB1(sourceFixture, { retirement });
  const retiredReceipt = await parentRetirement(state, retirement);
  await readInstalledKnowledgeMoveRestoredReceipt({
    componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256,
  }, retirement, restored, retiredReceipt);
  assert.deepEqual(hashes(await files(restored.root)), hashes(state.baseline));
  for (const path of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-workspace",
    ".pkm-next-original-mcp.json", ".pkm-native"]) await absent(join(restored.root, path), "INSTALLED_KNOWLEDGE_MOVE_B0_NATIVE_STATE_OR_GRANT");
  return { ...b1, allOriginalB0BytesRestored: true, freshB0NoNativeDatabaseOrGrants: true,
    originalRootOverwritten: false, fullCutoverQualified: false };
}
export async function readInstalledKnowledgeMoveRestoredReceipt({ componentFixture, sourceRoot, b0Sha256 },
  retirement, restored, retiredReceipt) {
  if (restored?.root !== join(componentFixture.directory, "restored-b0")
    || restored.receiptPath !== join(componentFixture.directory, "b0-restored.json")
    || restored.originalRootOverwritten !== false || restored.newRootIdentity !== true)
    fail("INSTALLED_KNOWLEDGE_MOVE_FRESH_PARENT_B0_REQUIRED");
  await privateDirectory(restored.root, "INSTALLED_KNOWLEDGE_MOVE_PRIVATE_B0_REQUIRED");
  const bytes = await readFile(restored.receiptPath), receipt = JSON.parse(bytes);
  assert.equal(hash(bytes), restored.receiptSha256);
  assert.equal(receipt.schema, "pkm.original-mcp-component-b0-restored/v1");
  assert.equal(receipt.root, restored.root); assert.equal(receipt.originalRoot, sourceRoot);
  assert.equal(receipt.retirementSha256, retirement.receiptSha256); assert.equal(receipt.b0Sha256, b0Sha256);
  assert.equal(receipt.b1Sha256, retiredReceipt.b1Sha256);
  assert.equal(receipt.nativeIdentityOrProfileRestored, false);
  return receipt;
}

export const installedKnowledgeMoveFixtureUtilities = Object.freeze({
  hash, load, areas: Object.freeze({ ...areas }), absent, privateDirectory, files, hashes,
  unchangedOriginalControls, noPrivatePublication, readJournal, liveJournal,
});
