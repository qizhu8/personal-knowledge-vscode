import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u,
  assertInstalledKnowledgeMoveComponentBinding, readInstalledKnowledgeMoveRetirementReceipt, readInstalledKnowledgeMoveRestoredReceipt,
} from "./installed-native-knowledge-move.mjs";
import { installedLegacyAssetsFixtureFacts as facts } from "./installed-native-legacy-assets-move.mjs";
import { startInstalledNativeSharedLegacyAssetsMoveUi } from "./installed-native-shared-legacy-assets-move-ui.mjs";
import { prepareInstalledHeldOldLegacyParser, verifyInstalledHeldOldLegacyParser } from "./installed-held-legacy-assets-parser.mjs";
import {
  pinnedOriginalKnowledgeWriterFixture, seedOriginalLegacyKnowledge, seedOriginalPublicLegacyCompanion, moveOriginalKnowledge,
} from "../../tests/original-knowledge-writer-fixture.mjs";
import { seedOriginalPrivateNoteLegacyReferrer } from "../../tests/original-shared-legacy-fixture.mjs";

const preparations = new WeakMap(), protocol = "pkm.document-legacy-assets.dispositions/v2";
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(sourceFixture) {
  const state = preparations.get(sourceFixture);
  if (!state) fail("INSTALLED_SHARED_LEGACY_ACTUAL_PREPARATION_REQUIRED");
  return state;
}
function noPrivate(value) {
  u.noPrivatePublication(value);
  assert(!JSON.stringify(value).includes("Retained private legacy marker"), "Private referrer contents cannot be published.");
}
export function installedSharedLegacyMoveSteps(contents) {
  const step = (stage, tool, args, kind, expectedCode) => Object.freeze({ stage: `native-shared-legacy-assets-move-${stage}`,
    tool, arguments: Object.freeze(args), kind, ...(expectedCode ? { code: expectedCode } : {}),
    outcome: kind === "deny" ? "deny" : kind === "refuse" ? "refuse" : "move",
    choice: kind === "deny" ? "Deny" : "Approve this request" });
  const shared = { slug: "Old/Shared", title: "SharedAfter", category: "New",
    content: "Changed public shared owner\n![shared](../_assets/shared.PNG?shared=1#view)\n" };
  return Object.freeze([
    step("deny-before", "update_note", shared, "deny", "ACCESS_DENIED"),
    step("note", "update_note", { slug: "Old/Before", title: "After", category: "New", content: contents.note }, "unshared"),
    step("skill", "update_skill", { name: "Before", category: "New", content: contents.skill }, "unshared"),
    step("paper", "update_paper", { slug: "Old/Before", title: "After", category: "New", content: contents.paper }, "unshared"),
    step("shared-copy-retain", "update_note", shared, "shared"),
    step("deny-after", "update_note", { slug: "New/SharedAfter", title: "NotApplied", category: "Denied" }, "deny", "ACCESS_DENIED"),
    step("private-destination", "update_note", { slug: "New/SharedAfter", title: "NotApplied", category: "Private" }, "refuse", "ACCESS_DENIED"),
    step("unreviewed-reference", "update_note", { slug: "New/SharedAfter", title: "NotApplied", category: "Denied",
      content: "![unreviewed](../_assets/unreviewed.PNG)\n" }, "refuse", "UNSUPPORTED_OPERATION"),
  ]);
}

/** All original input preparation stays before B0/custody, after the entire first editor exits. */
export async function prepareInstalledNativeSharedLegacyAssetsMoveFixture({ installed, componentFixture, legacyVsix, python, heldOldParser }) {
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (preparations.has(componentFixture)) fail("INSTALLED_SHARED_LEGACY_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    join(componentFixture.root, ".pkm-next-original-mcp.json"), join(componentFixture.root, "core.sqlite")])
    await u.absent(path, "INSTALLED_SHARED_LEGACY_PRESEAL_REQUIRED");
  if (typeof python !== "string" || !isAbsolute(python)) fail("INSTALLED_SHARED_LEGACY_EXPLICIT_PYTHON_REQUIRED");
  const policyPath = join(componentFixture.root, ".pkm/content-privacy.json"), stat = await lstat(policyPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
    || stat.mode & 0o077 || stat.size > 2_097_152) fail("INSTALLED_SHARED_LEGACY_PRIVATE_POLICY_REQUIRED");
  const privacyBytes = await readFile(policyPath);
  assert.deepEqual(JSON.parse(privacyBytes), installedNativeKnowledgeMovePrivacyPolicy,
    "Parent must independently configure exact Private top levels in all three areas.");
  for (const area of Object.values(u.areas)) {
    await mkdir(join(componentFixture.root, area), { recursive: true, mode: 0o700 });
    for (const path of ["Old", "New", "Private", "Denied", "_assets"])
      await u.absent(join(componentFixture.root, area, path), "INSTALLED_SHARED_LEGACY_DISJOINT_SEED_REQUIRED");
  }
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: componentFixture.directory, legacyVsix, python });
  const rows = writer.run(componentFixture.root, seedOriginalLegacyKnowledge, { paired: true, parserForms: true, configurePrivacy: false });
  const sharedRows = writer.run(componentFixture.root, seedOriginalPublicLegacyCompanion);
  writer.run(componentFixture.root, seedOriginalPrivateNoteLegacyReferrer);
  assert.deepEqual(await readFile(policyPath), privacyBytes);
  const contents = Object.fromEntries(Object.entries(rows).map(([kind, row]) => [kind, row.content.replace("Original legacy body", "Changed legacy body")]));
  const steps = installedSharedLegacyMoveSteps(contents), baseline = await u.files(componentFixture.root);
  const oracle = join(componentFixture.directory, "original-shared-legacy-oracle");
  await cp(componentFixture.root, oracle, { recursive: true, errorOnExist: true, force: false });
  const expected = {};
  for (const kind of Object.keys(u.areas)) expected[kind] = writer.run(oracle, moveOriginalKnowledge, { kind, content: contents[kind] });
  const witnesses = baseline.filter(file => file.path === "notes/Private/Secret.md" || file.path === "notes/Old/Referrer.md"
    || file.path === "notes/_assets/shared.PNG");
  const sharedStep = steps.find(step => step.kind === "shared");
  expected.shared = writer.run(oracle, moveOriginalKnowledge, { kind: "note", key: "Old/Shared", name: "SharedAfter",
    content: sharedStep.arguments.content });
  assert.equal(expected.shared.knowledgeId, sharedRows.note.knowledgeId);
  assert.equal(expected.shared.revision, sharedRows.note.revision + 1);
  for (const file of witnesses) assert.deepEqual(await readFile(join(oracle, file.path)), file.bytes);
  assert.deepEqual(await readFile(join(oracle, "notes/New/SharedAfter.assets", facts.target("shared.PNG"))), facts.bytes("shared.PNG"));
  const oldParser = await prepareInstalledHeldOldLegacyParser({ directory: componentFixture.directory, heldOldParser, python });
  const value = Object.freeze({ kind: "pkm.installed-native-shared-legacy-fixture/v1", root: componentFixture.root,
    originalPackageSha256: writer.originalPackageSha256, privacySha256: u.hash(privacyBytes),
    originalSharedCopyAndRetainObserved: true, sharedPublicAndPrivateReferrers: true,
    files: Object.freeze(u.hashes(baseline).map(Object.freeze)), heldOldParserPrepared: !!oldParser });
  const state = { installed, componentFixture, value, baseline, privacyBytes, rows, sharedRows, expected, steps, oldParser, phase: "prepared" };
  preparations.set(componentFixture, state); preparations.set(value, state);
  return value;
}

function readCommit(database, operationId, workspaceId, receipt) {
  const raw = database.prepare("SELECT * FROM migration_runtime_knowledge_commits WHERE operation_id=?").get(operationId);
  assert(raw, "Actual immutable native Knowledge commitment is required.");
  const row = { ...raw };
  assert.equal(row.workspace_id, workspaceId); assert.equal(row.operation_id, operationId);
  assert.equal(row.digest, u.hash(JSON.stringify([row.sequence, row.workspace_id, row.operation_id, row.request_json, row.plan_json, row.result_json])));
  assert.equal(row.result_json, receipt.result);
  const request = JSON.parse(row.request_json), plan = JSON.parse(row.plan_json);
  assert.equal(request.actorId, "mcp:external"); assert.equal(request.operation, receipt.operation);
  assert.equal(request.args.operationId, operationId); assert.equal(plan.operationId, operationId);
  const relocation = JSON.parse(plan.relocation);
  return { row, request, plan, relocation };
}
async function validateCurrentCommit(component, installed, receipt, step) {
  const database = component.storage.connectNative();
  let committed;
  try { committed = readCommit(database, receipt.operation_id, component.workspaceId, receipt); } finally { database.close(); }
  const legacy = committed.relocation.legacyAssets;
  assert(legacy && legacy.copies.length);
  if (step.kind === "shared") {
    assert.equal(legacy.protocol, protocol);
    assert.deepEqual(legacy.copies.map(copy => ({ source: copy.source, disposition: copy.disposition })),
      [{ source: "_assets/shared.PNG", disposition: "retain" }]);
  } else {
    assert.equal(legacy.protocol, undefined);
    assert(legacy.copies.every(copy => (copy.disposition ?? "remove") === "remove"));
  }
  const mutations = await u.load(installed, "knowledge-mutations");
  await component.storage.withWorkspaceExclusive(() => {
    component.storage.assertWorkspaceLease();
    mutations.assertKnowledgeMutationRequestPlan(component.root, mutations.deserializeKnowledgeMutationPlan(committed.row.plan_json), committed.request);
  });
  return committed;
}

/** Eight exact native modals; no blind MCP or internal Core mutation replay, perturbation, or injection. */
export async function verifyInstalledNativeSharedLegacyAssetsMove({ root, installed, component, sourceFixture, payloadBuildId,
  python, env, port, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "prepared") fail("INSTALLED_SHARED_LEGACY_VERIFY_ORDER_REQUIRED");
  if (state.installed !== installed || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_SHARED_LEGACY_SAME_COMPONENT_REQUIRED");
  const { host, full, first } = await assertInstalledKnowledgeMoveComponentBinding({
    root, installed, component, componentFixture: state.componentFixture, payloadBuildId,
  });
  assert.equal(full.storage, component.storage);
  const markdown = await u.load(installed, "markdown"), assets = await u.load(installed, "document-legacy-assets");
  const lease = { ...component.owner.workspaceLease() }, runId = randomUUID(), abort = new AbortController();
  const untouched = (await u.files(component.root, true)).filter(file => file.path.includes("/Private/")
    || /\/Old\/Referrer\.md$|\/_assets\/shared\.PNG$/.test(file.path));
  noPrivate(markdown.scanMarkdown(component.root).map(row => ({ ...row.record })));
  await u.unchangedOriginalControls(state, component.root); assert.equal(u.liveJournal(component).intents.length, 0);
  state.b0Sha256 = component.b0.sha256;
  await writeFile(join(root, "native-shared-legacy-assets-move-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-shared-legacy-assets-move-ui/v1", runId, nativeEpoch: host.receipt.epoch,
    binding: { root: component.root, workspaceId: component.workspaceId, profileSha256: first.result.profileSha256 }, steps: state.steps,
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativeSharedLegacyAssetsMoveUi({ root, python, env, port, runId, timeoutMs });
  void ui.done.catch(error => abort.abort(error));
  const check = () => {
    if (ui.error) throw ui.error;
    host.assertCurrent(); component.storage.assertWorkspaceLease(); assert.deepEqual({ ...component.owner.workspaceLease() }, lease);
  };
  const invoke = async (tool, arguments_) => {
    check(); const response = await component.invoke(tool, arguments_, abort.signal);
    noPrivate(response); assert.notEqual(response.isError, true, JSON.stringify(response));
    const value = response.structuredContent ?? JSON.parse(response.content[0].text);
    noPrivate(value); return value;
  };
  try {
    await ui.ready; check();
    for (const kind of Object.keys(u.areas)) {
      const value = await invoke(`get_${kind}`, kind === "skill" ? { name: "Before" } : { slug: "Old/Before" });
      assert.equal(value.content, state.rows[kind].content);
    }
    const receipts = [], commitments = [], outcomes = [];
    let retainedCopy, oldParserEvidence;
    for (const step of state.steps) {
      check(); const before = u.hashes(await u.files(component.root, true)), journal = u.liveJournal(component);
      await writeFile(join(root, "progress.json"), JSON.stringify({ stage: step.stage }), { mode: 0o600 });
      if (step.outcome !== "move") {
        outcomes.push(await facts.assertRefusal(component, step, abort.signal));
        assert.deepEqual(u.hashes(await u.files(component.root, true)), before); assert.deepEqual(u.liveJournal(component), journal);
        await u.unchangedOriginalControls(state, component.root);
        continue;
      }
      const result = await invoke(step.tool, step.arguments), kind = step.tool.slice(7);
      let document, readArgs;
      if (step.kind === "unshared") {
        document = await facts.verifyMoved(component.root, kind, state, markdown);
        readArgs = kind === "skill" ? { name: "Before" } : { slug: "New/After" };
        assert.deepEqual(result, kind === "skill" ? { ok: true, name: "Before" } : { ok: true, slug: "New/After" });
      } else {
        assert.deepEqual(result, { ok: true, slug: "New/SharedAfter" });
        document = markdown.scanMarkdown(component.root).find(row => row.record.area === "notes" && row.record.path === "New/SharedAfter.md");
        assert(document); assert.equal(document.record.id, state.sharedRows.note.knowledgeId);
        assert.equal(document.metadata.get("title"), state.expected.shared.title);
        assert.equal(document.record.revision, state.expected.shared.revision);
        assert.equal(document.record.content, state.expected.shared.content);
        assert.deepEqual([...document.metadata.toJS().aliases].sort(), [...state.expected.shared.aliases].sort());
        assert.deepEqual(await readFile(join(component.root, "notes/New/SharedAfter.assets", facts.target("shared.PNG"))), facts.bytes("shared.PNG"));
        await u.absent(join(component.root, "notes/Old/Shared.md"), "INSTALLED_SHARED_LEGACY_OLD_OWNER_REMAINED");
        readArgs = { slug: "New/SharedAfter" };
      }
      const current = u.liveJournal(component), oldIds = new Set(journal.receipts.map(row => row.operation_id));
      const added = current.receipts.filter(row => !oldIds.has(row.operation_id));
      assert.equal(current.intents.length, 0); assert.equal(added.length, 1);
      const receipt = { ...added[0] }, value = JSON.parse(receipt.result);
      assert.equal(receipt.actor_id, "mcp:external"); assert.equal(value.id, document.record.id);
      assert.equal(value.path, document.record.path); assert.equal(value.revision, document.record.revision);
      assert.equal(value.sha256, document.record.sha256); assert.equal(value.operationId, receipt.operation_id);
      noPrivate(value);
      const committed = await validateCurrentCommit(component, installed, receipt, step);
      if (step.kind === "shared") {
        retainedCopy = committed.relocation.legacyAssets.copies[0];
        assert.deepEqual(assets.readPinnedLegacyAsset(component.root, "notes", retainedCopy), facts.bytes("shared.PNG"));
        if (state.oldParser) oldParserEvidence = await verifyInstalledHeldOldLegacyParser(state.oldParser, JSON.stringify(committed.relocation));
      }
      commitments.push(committed.row); receipts.push(receipt); outcomes.push({ stage: step.stage, operationId: receipt.operation_id });
      const read = await invoke(step.tool === "update_note" ? "get_note" : `get_${kind}`, readArgs);
      assert.equal(read.content, document.record.content);
    }
    assert(retainedCopy); assert.equal(receipts.length, 4);
    assert.deepEqual(assets.readPinnedLegacyAsset(component.root, "notes", retainedCopy), facts.bytes("shared.PNG"));
    assert.deepEqual((await u.files(component.root, true)).filter(file => file.path.includes("/Private/")
      || /\/Old\/Referrer\.md$|\/_assets\/shared\.PNG$/.test(file.path)), untouched);
    await u.unchangedOriginalControls(state, component.root); noPrivate(markdown.scanMarkdown(component.root).map(row => ({ ...row.record }))); check();
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: "native-shared-legacy-assets-move-complete" }), { mode: 0o600 });
    await ui.done; check();
    const proof = JSON.parse(await readFile(join(root, "native-shared-legacy-assets-move-ui-passed.json")));
    assert.equal(proof.passed, true); assert.equal(proof.actualRenderedDom, true); assert.equal(proof.runId, runId);
    assert.deepEqual(proof.dialogs.map(row => ({ stage: row.stage, choice: row.choice })), state.steps.map(row => ({ stage: row.stage, choice: row.choice })));
    state.receipts = receipts; state.commitments = commitments; state.retainedCopy = retainedCopy; state.untouched = untouched;
    state.workspaceId = component.workspaceId; state.b1Knowledge = u.hashes(await u.files(component.root, true)); state.phase = "verified";
    const evidence = { passed: true, scope: "checked PUBLIC shared legacy copy-retain only", actualNativeUi: true,
      originalPackageSha256: sourceFixture.originalPackageSha256, originalSharedCopyRetainObserved: true, sameOwnerLease: true,
      freshDenialBeforeAndAfterSharedCopy: true, publicAndPrivateReferrersUnchanged: true, retainedPublicBytesAndIdentityUnchanged: true,
      fourActualMoveReceipts: true, exactVersionedImmutableCommitPlanProof: true, trustedCoreReadOnlyDispositionValidation: true,
      originalHashParserSuffixAndPairedByteProof: true, completePairedTreeProofValidated: true,
      privateEndpointAndUnreviewedReferencesRefused: true, privateResourcePublicationQualified: false,
      publicMutationReplayAttempted: false, internalCoreMutationReplayAttempted: false, sourcePerturbationUsed: false,
      interruptionInjectionUsed: false, attachmentRevoked: false, outcomes,
      oldParserProbe: oldParserEvidence ?? { performed: false, reason: "No explicit held old VSIX/full SHA pin supplied." },
      b1AndB0Qualified: false, fullCutoverQualified: false };
    await writeFile(join(root, "native-shared-legacy-assets-move-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
    return evidence;
  } finally { if (state.phase !== "verified") state.phase = "failed"; abort.abort(); await ui.stop(); }
}

function recoveryState(sourceFixture) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "verified" || !state.commitments || !state.retainedCopy) fail("INSTALLED_SHARED_LEGACY_VERIFIED_EFFECTS_REQUIRED");
  return state;
}
export async function verifyInstalledNativeSharedLegacyAssetsMoveB1(sourceFixture, { retirement }) {
  const state = recoveryState(sourceFixture);
  await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture, sourceRoot: sourceFixture.root,
    b0Sha256: state.b0Sha256 }, retirement);
  assert.deepEqual(u.hashes(await u.files(retirement.archive, true)), state.b1Knowledge);
  assert.deepEqual((await u.files(retirement.archive, true)).filter(file => file.path.includes("/Private/")
    || /\/Old\/Referrer\.md$|\/_assets\/shared\.PNG$/.test(file.path)), state.untouched);
  await u.unchangedOriginalControls(state, retirement.archive);
  const assets = await u.load(state.installed, "document-legacy-assets");
  assert.deepEqual(assets.readPinnedLegacyAsset(retirement.archive, "notes", state.retainedCopy), facts.bytes("shared.PNG"));
  const database = new DatabaseSync(join(retirement.archive, "core.sqlite"), { readOnly: true });
  try {
    const journal = u.readJournal(database); assert.equal(journal.intents.length, 0);
    for (const receipt of state.receipts) {
      const stored = journal.receipts.find(row => row.operation_id === receipt.operation_id);
      assert(stored); assert.deepEqual({ ...stored }, receipt);
      const committed = readCommit(database, receipt.operation_id, state.workspaceId, receipt);
      assert.deepEqual(committed.row, state.commitments.find(row => row.operation_id === receipt.operation_id));
    }
  } finally { database.close(); }
  return { sharedLegacyB1SourcePairPrivateReferrersAndV2CommitReceiptsPreserved: true };
}
export async function verifyInstalledNativeSharedLegacyAssetsMoveRestored(sourceFixture, { retirement, restored }) {
  const state = recoveryState(sourceFixture), b1 = await verifyInstalledNativeSharedLegacyAssetsMoveB1(sourceFixture, { retirement });
  const expected = { componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 };
  const retired = await readInstalledKnowledgeMoveRetirementReceipt(expected, retirement);
  await readInstalledKnowledgeMoveRestoredReceipt(expected, retirement, restored, retired);
  assert.deepEqual(u.hashes(await u.files(restored.root)), u.hashes(state.baseline));
  for (const path of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-workspace", ".pkm-next-original-mcp.json", ".pkm-native"])
    await u.absent(join(restored.root, path), "INSTALLED_SHARED_LEGACY_B0_NATIVE_STATE_OR_GRANT");
  return { ...b1, allOriginalSharedLegacyB0BytesRestored: true, freshB0NoNativeDatabaseOrGrant: true,
    originalRootOverwritten: false, privateResourcePublicationQualified: false, fullCutoverQualified: false };
}
