import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u,
  assertInstalledKnowledgeMoveComponentBinding, readInstalledKnowledgeMoveRetirementReceipt, readInstalledKnowledgeMoveRestoredReceipt,
} from "./installed-native-knowledge-move.mjs";
import { pinnedOriginalKnowledgeWriterFixture, seedOriginalPublicLegacyCompanion, moveOriginalKnowledge } from "../../tests/original-knowledge-writer-fixture.mjs";
import { seedOriginalPrivateNoteLegacyReferrer } from "../../tests/original-shared-legacy-fixture.mjs";
import { privatePublicationFixtureBytes as bytes, seedOriginalPrivateResourcePublication } from "../../tests/original-private-resource-publication-fixture.mjs";
import { startInstalledNativePrivateResourcePublicationUi } from "./installed-native-private-resource-publication-ui.mjs";
import { prepareInstalledHeldPrivateResourceParser, verifyInstalledHeldPrivateResourceParser } from "./installed-held-private-resource-parser.mjs";

const preparations = new WeakMap(), privateProtocol = "pkm.document-private-resource-publication/v1";
const target = name => `${u.hash(bytes[name]).slice(0, 16)}${name.slice(name.lastIndexOf(".")).toLowerCase()}`;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value) {
  const state = preparations.get(value);
  if (!state) fail("INSTALLED_PRIVATE_PUBLICATION_ACTUAL_PREPARATION_REQUIRED");
  return state;
}
function noPrivate(value) {
  u.noPrivatePublication(value);
  const text = JSON.stringify(value);
  assert(!text.includes("SYNTHETIC_PRIVATE_RESOURCE_") && !text.includes("SYNTHETIC_PRIVATE_REFERRER"), "Private plaintext cannot enter public descriptors/replies.");
}
function identity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
async function privateDirectories(root) {
  const result = [];
  async function walk(path, relative) {
    const stat = await lstat(path);
    assert(stat.isDirectory() && !stat.isSymbolicLink());
    result.push({ path: relative, identity: identity(stat) });
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), value = await lstat(child);
      if (value.isDirectory()) await walk(child, `${relative}/${name}`);
    }
  }
  for (const area of Object.values(u.areas)) await walk(join(root, area, "Private"), `${area}/Private`);
  return result;
}
export function installedPrivateResourcePublicationSteps() {
  const resources = choices => choices.map((choice, index) => ({ source: ["a.PNG", "b.BIN"][index], choice }));
  const step = (name, kind, outcome, choices = [], code) => ({
    stage: `native-private-resource-publication-${name}`, kind, tool: `update_${kind}`, outcome,
    choice: outcome === "public-deny" ? "Deny" : "Approve this request",
    arguments: { ...(kind === "skill" ? { name: "Before" } : { slug: "Old/Before", title: "After" }), category: "New" },
    resources: resources(choices), ...(code ? { code } : {}),
  });
  const yes = "Publish this exact resource once", no = "Deny";
  return [
    { ...step("public-v2-baseline", "note", "public-baseline"), arguments: { slug: "Old/Shared", title: "SharedAfter", category: "New" } },
    step("public-deny", "note", "public-deny", [], "ACCESS_DENIED"),
    step("note-resource-deny", "note", "resource-deny", [no], "PRIVATE_RESOURCE_PUBLICATION_DENIED"),
    step("note-partial-deny", "note", "resource-deny", [yes, no], "PRIVATE_RESOURCE_PUBLICATION_DENIED"),
    step("note-publish", "note", "publish", [yes, yes]),
    step("skill-resource-deny", "skill", "resource-deny", [no], "PRIVATE_RESOURCE_PUBLICATION_DENIED"),
    step("skill-publish", "skill", "publish", [yes, yes]),
    step("paper-resource-deny", "paper", "resource-deny", [no], "PRIVATE_RESOURCE_PUBLICATION_DENIED"),
    step("paper-publish", "paper", "publish", [yes, yes]),
    { ...step("public-deny-after", "note", "public-deny", [], "ACCESS_DENIED"),
      arguments: { slug: "New/After", title: "NotApplied", category: "Denied" } },
  ];
}
/** Original-only seeding before B0/custody, after the complete first editor has exited. */
export async function prepareInstalledNativePrivateResourcePublicationFixture({ installed, componentFixture, legacyVsix, python, heldOldPrivateParser }) {
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (preparations.has(componentFixture)) fail("INSTALLED_PRIVATE_PUBLICATION_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    join(componentFixture.root, "core.sqlite"), join(componentFixture.root, ".pkm-next-original-mcp.json")])
    await u.absent(path, "INSTALLED_PRIVATE_PUBLICATION_PRESEAL_REQUIRED");
  if (!isAbsolute(python ?? "")) fail("INSTALLED_PRIVATE_PUBLICATION_EXPLICIT_PYTHON_REQUIRED");
  const policyPath = join(componentFixture.root, ".pkm/content-privacy.json"), stat = await lstat(policyPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077)
    fail("INSTALLED_PRIVATE_PUBLICATION_INDEPENDENT_PRIVACY_REQUIRED");
  const privacyBytes = await readFile(policyPath);
  assert.deepEqual(JSON.parse(privacyBytes), installedNativeKnowledgeMovePrivacyPolicy, "Parent must independently configure exact Private top levels.");
  for (const area of Object.values(u.areas)) {
    await mkdir(join(componentFixture.root, area), { recursive: true, mode: 0o700 });
    for (const path of ["Old", "New", "Private", "Denied", "_assets"])
      await u.absent(join(componentFixture.root, area, path), "INSTALLED_PRIVATE_PUBLICATION_DISJOINT_SEED_REQUIRED");
  }
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: componentFixture.directory, legacyVsix, python });
  const rows = writer.run(componentFixture.root, seedOriginalPrivateResourcePublication);
  const sharedRows = writer.run(componentFixture.root, seedOriginalPublicLegacyCompanion);
  writer.run(componentFixture.root, seedOriginalPrivateNoteLegacyReferrer);
  assert.deepEqual(await readFile(policyPath), privacyBytes);
  const baseline = await u.files(componentFixture.root), directories = await privateDirectories(componentFixture.root);
  const oracle = join(componentFixture.directory, "original-private-resource-oracle");
  await cp(componentFixture.root, oracle, { recursive: true, errorOnExist: true, force: false });
  const expected = {};
  for (const kind of Object.keys(u.areas)) {
    expected[kind] = writer.run(oracle, moveOriginalKnowledge, { kind, content: rows[kind].content });
    assert.deepEqual(await readFile(join(oracle, u.areas[kind], "Private/_assets/a.PNG")), bytes["a.PNG"]);
    await u.absent(join(oracle, u.areas[kind], "Private/_assets/b.BIN"), "INSTALLED_PRIVATE_PUBLICATION_ORIGINAL_UNSHARED_REMOVAL_NOT_OBSERVED");
    for (const name of Object.keys(bytes))
      assert.deepEqual(await readFile(join(oracle, u.areas[kind], `New/${kind === "skill" ? "Before" : "After"}.assets`, target(name))), bytes[name]);
  }
  expected.shared = writer.run(oracle, moveOriginalKnowledge, { kind: "note", key: "Old/Shared", name: "SharedAfter", content: sharedRows.note.content });
  const oldParser = await prepareInstalledHeldPrivateResourceParser({ directory: componentFixture.directory, python, heldOldPrivateParser });
  const value = Object.freeze({ kind: "pkm.installed-private-resource-publication-fixture/v1", root: componentFixture.root,
    originalPackageSha256: writer.originalPackageSha256, privacySha256: u.hash(privacyBytes),
    originalPrivateCopyObserved: true, intentionalPrivateAlwaysRetainPolicyDifference: true, heldOldPrivateParserPrepared: !!oldParser,
    files: Object.freeze(u.hashes(baseline).map(Object.freeze)) });
  const state = { installed, componentFixture, baseline, directories, rows, sharedRows, expected, oldParser,
    privacyBytes, steps: installedPrivateResourcePublicationSteps(), phase: "prepared" };
  preparations.set(value, state); preparations.set(componentFixture, state); return value;
}
function commitment(database, receipt, workspaceId) {
  const raw = database.prepare("SELECT * FROM migration_runtime_knowledge_commits WHERE operation_id=?").get(receipt.operation_id);
  assert(raw, "Actual immutable Core commitment required.");
  const row = { ...raw }, request = JSON.parse(row.request_json), plan = JSON.parse(row.plan_json);
  assert.equal(row.workspace_id, workspaceId); assert.equal(row.operation_id, receipt.operation_id);
  assert.equal(row.digest, u.hash(JSON.stringify([row.sequence, row.workspace_id, row.operation_id, row.request_json, row.plan_json, row.result_json])));
  assert.equal(row.result_json, receipt.result); assert.equal(request.actorId, "mcp:external");
  assert.equal(request.operation, receipt.operation); assert.equal(request.args.operationId, receipt.operation_id);
  assert.equal(plan.operationId, receipt.operation_id); assert.equal(plan.actorId, receipt.actor_id);
  return { row, request, plan, relocation: JSON.parse(plan.relocation) };
}
async function unchangedPrivate(state, root) {
  assert.deepEqual((await u.files(root, true)).filter(file => file.path.includes("/Private/")), state.privateBefore);
  assert.deepEqual(await privateDirectories(root), state.directories);
  for (const file of state.libraryBefore.filter(file => Object.values(u.areas).includes(file.path.split("/")[0])
    && !/\/Old\/(?:Before|Shared)\.md$|\/Old\/Before\.assets\//.test(file.path)))
    assert.deepEqual(await readFile(join(root, file.path)), file.bytes, "Common documents/referrers and readonly source controls must remain unchanged.");
  await u.unchangedOriginalControls(state, root);
}
/** Owns its observer only. Every effect uses actual public MCP and separate genuine native choices. */
export async function verifyInstalledNativePrivateResourcePublication({ root, installed, component, sourceFixture, payloadBuildId,
  python, env, port, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "prepared") fail("INSTALLED_PRIVATE_PUBLICATION_VERIFY_ORDER_REQUIRED");
  if (state.installed !== installed || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_PRIVATE_PUBLICATION_SAME_COMPONENT_REQUIRED");
  const { host } = await assertInstalledKnowledgeMoveComponentBinding({ root, installed, component, componentFixture: state.componentFixture, payloadBuildId });
  const markdown = await u.load(installed, "markdown"), contracts = await u.load(installed, "private-resource-publication-contracts");
  const mutations = await u.load(installed, "knowledge-mutations"), lease = { ...component.owner.workspaceLease() };
  const runId = randomUUID(), abort = new AbortController();
  state.libraryBefore = await u.files(component.root, true);
  state.privateBefore = state.libraryBefore.filter(file => file.path.includes("/Private/"));
  assert.deepEqual([...state.privateBefore].sort((a, b) => a.path.localeCompare(b.path)),
    state.baseline.filter(file => file.path.includes("/Private/")).sort((a, b) => a.path.localeCompare(b.path)));
  state.b0Sha256 = component.b0.sha256; state.workspaceId = component.workspaceId;
  const steps = [];
  for (const step of state.steps) {
    const area = u.areas[step.kind], path = step.outcome === "public-baseline" ? "Old/Shared.md" : "Old/Before.md";
    const before = markdown.scanMarkdown(component.root).find(row => row.record.area === area && row.record.path === path);
    const owner = { area, id: before.record.id, beforePath: path, afterPath: `New/${step.kind === "skill" ? "Before" : "After"}.md`,
      revision: before.record.revision, sha256: before.record.sha256 };
    steps.push({ ...step, owner, operation: `knowledge.${step.kind === "paper" ? "research" : step.kind}.update`,
      resources: await Promise.all(step.resources.map(async resource => ({
        choice: resource.choice, resource: { sourcePath: `Private/_assets/${resource.source}`, sha256: u.hash(bytes[resource.source]),
          size: bytes[resource.source].length, sourceIdentity: identity(await lstat(join(component.root, area, "Private/_assets", resource.source))),
          targetPath: `${owner.afterPath.replace(/\.md$/i, ".assets")}/${target(resource.source)}` },
      }))) });
  }
  const binding = { root: component.root, workspaceId: component.workspaceId, catalogSha256: host.receipt.sourceCatalogSha256,
    profileSha256: host.receipt.profileSha256, custodyPlanSha256: component.custody.planSha256,
    privacySha256: component.custody.privacySha256, epoch: host.receipt.epoch, nativeHostReceiptSha256: host.receipt.receiptSha256 };
  assert.equal(binding.privacySha256, sourceFixture.privacySha256);
  await writeFile(join(root, "native-private-resource-publication-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-private-resource-publication-ui/v1", runId, binding, steps,
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativePrivateResourcePublicationUi({ root, python, env, port, runId, timeoutMs });
  void ui.done.catch(error => abort.abort(error));
  const check = () => { if (ui.error) throw ui.error; host.assertCurrent(); component.storage.assertWorkspaceLease();
    assert.deepEqual({ ...component.owner.workspaceLease() }, lease); };
  const receipts = [], commits = [], outcomes = [];
  try {
    await ui.ready; check(); await unchangedPrivate(state, component.root);
    assert.equal(u.liveJournal(component).intents.length, 0);
    for (const step of steps) {
      check(); const before = u.hashes(await u.files(component.root, true)), journal = u.liveJournal(component);
      await writeFile(join(root, "progress.json"), JSON.stringify({ stage: step.stage }), { mode: 0o600 });
      if (step.outcome === "public-deny" || step.outcome === "resource-deny") {
        let failure;
        try { const response = await component.invoke(step.tool, step.arguments, abort.signal); noPrivate(response);
          if (response.isError) failure = Object.assign(new Error(JSON.stringify(response)), { code: response.structuredContent?.code }); }
        catch (error) { failure = error; }
        assert(failure, "Exact denial must not succeed.");
        noPrivate({ message: failure.message });
        const code = step.outcome === "public-deny" ? failure.code
          : failure.code ?? /\b(PRIVATE_RESOURCE_PUBLICATION_DENIED):/.exec(failure.message)?.[1];
        assert.equal(code, step.code);
        assert.deepEqual(u.hashes(await u.files(component.root, true)), before); assert.deepEqual(u.liveJournal(component), journal);
        await unchangedPrivate(state, component.root); outcomes.push({ stage: step.stage, code }); continue;
      }
      const response = await component.invoke(step.tool, step.arguments, abort.signal); noPrivate(response);
      assert.notEqual(response.isError, true, JSON.stringify(response));
      const result = response.structuredContent ?? JSON.parse(response.content[0].text);
      const name = step.outcome === "public-baseline" ? "SharedAfter" : step.kind === "skill" ? "Before" : "After";
      assert.deepEqual(result, step.kind === "skill" ? { ok: true, name } : { ok: true, slug: `New/${name}` });
      const document = markdown.scanMarkdown(component.root).find(row => row.record.area === u.areas[step.kind] && row.record.path === `New/${name}.md`);
      const expected = step.outcome === "public-baseline" ? state.expected.shared : state.expected[step.kind];
      assert(document); assert.equal(document.record.id, expected.knowledgeId); assert.equal(document.record.revision, expected.revision);
      assert.equal(document.record.content, expected.content); assert.equal(document.metadata.get("knowledgeId"), expected.knowledgeId);
      assert.equal(document.metadata.get(step.kind === "skill" ? "name" : "title"), name);
      assert.deepEqual([...document.metadata.toJS().aliases].sort(), [...expected.aliases].sort());
      if (step.kind === "paper") assert.equal(document.metadata.get("file"), expected.file);
      if (step.outcome === "publish") {
        for (const source of Object.keys(bytes))
          assert.deepEqual(await readFile(join(component.root, u.areas[step.kind], `New/${name}.assets`, target(source))), bytes[source]);
        if (step.kind === "note") assert.deepEqual(await readFile(join(component.root, "notes/New/After.assets/existing.bin")), Buffer.from([9,8,7]));
        await u.absent(join(component.root, u.areas[step.kind], "Old/Before.md"), "INSTALLED_PRIVATE_PUBLICATION_OLD_OWNER_REMAINED");
        await u.absent(join(component.root, u.areas[step.kind], "Old/Before.assets"), "INSTALLED_PRIVATE_PUBLICATION_OLD_PAIR_REMAINED");
      }
      const current = u.liveJournal(component), prior = new Set(journal.receipts.map(row => row.operation_id));
      const added = current.receipts.filter(row => !prior.has(row.operation_id));
      assert.equal(current.intents.length, 0); assert.equal(added.length, 1);
      const receipt = { ...added[0] }, value = JSON.parse(receipt.result);
      assert.equal(receipt.actor_id, "mcp:external"); assert.equal(value.id, document.record.id);
      assert.equal(value.revision, document.record.revision); assert.equal(value.sha256, document.record.sha256); noPrivate(value);
      const database = component.storage.connectNative(); let committed;
      try { committed = commitment(database, receipt, component.workspaceId); } finally { database.close(); }
      const legacy = committed.relocation.legacyAssets;
      assert.equal(legacy.protocol, step.outcome === "publish" ? privateProtocol : "pkm.document-legacy-assets.dispositions/v2");
      if (step.outcome === "publish") {
        assert.equal(legacy.copies.length, 2);
        for (const copy of legacy.copies) {
          assert.equal(copy.visibility, "private"); assert.equal(copy.disposition, "retain");
          const provenance = contracts.validatePrivateResourcePublicationProvenance(copy.publication);
          assert.equal(provenance.subject.canonicalArgumentsDigest, contracts.privateResourcePublicationDigest(committed.request.args));
          assert.equal(provenance.subject.publicRequest.argumentsDigest, contracts.privateResourcePublicationDigest(step.arguments));
          assert.equal(provenance.subject.root, component.root); assert.equal(provenance.subject.operationId, receipt.operation_id);
          assert.equal(provenance.nativeHostReceiptSha256, host.receipt.receiptSha256); assert.equal(provenance.decision.epoch, host.receipt.epoch);
        }
      }
      await component.storage.withWorkspaceExclusive(() => mutations.assertKnowledgeMutationRequestPlan(component.root,
        mutations.deserializeKnowledgeMutationPlan(committed.row.plan_json), committed.request));
      receipts.push(receipt); commits.push({ ...committed, stage: step.stage, outcome: step.outcome });
      await unchangedPrivate(state, component.root);
      const read = await component.invoke(`get_${step.kind}`, step.kind === "skill" ? { name: "Before" } : { slug: `New/${name}` }, abort.signal);
      noPrivate(read); assert.notEqual(read.isError, true);
      assert.equal((read.structuredContent ?? JSON.parse(read.content[0].text)).content, document.record.content);
      outcomes.push({ stage: step.stage, operationId: receipt.operation_id });
    }
    assert.equal(receipts.length, 4); check(); noPrivate(markdown.scanMarkdown(component.root).map(row => ({ ...row.record })));
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: "native-private-resource-publication-complete" }), { mode: 0o600 });
    await ui.done; check();
    const proof = JSON.parse(await readFile(join(root, "native-private-resource-publication-ui-passed.json")));
    assert.equal(proof.passed, true); assert.equal(proof.actualRenderedDom, true); assert.equal(proof.runId, runId);
    const choices = steps.flatMap(step => [{ stage: step.stage, type: "public", choice: step.choice },
      ...step.resources.map(resource => ({ stage: step.stage, type: "resource", choice: resource.choice }))]);
    assert.deepEqual(proof.dialogs.map(({ stage, type, choice }) => ({ stage, type, choice })), choices);
    for (const dialog of proof.dialogs.filter(row => row.type === "resource")) {
      assert.equal(dialog.defaultDenyFocused, true);
      assert.equal(dialog.defaultEnterDenial, dialog.choice === "Deny");
    }
    for (const committed of commits.filter(row => row.outcome === "publish")) {
      const observed = proof.dialogs.filter(row => row.stage === committed.stage && row.type === "resource");
      for (const copy of committed.relocation.legacyAssets.copies) {
        const dialog = observed.find(row => row.request.subject.resource.sourcePath === copy.source); assert(dialog);
        assert.deepEqual(dialog.request.subject, copy.publication.subject);
        assert.equal(dialog.requestSha256, copy.publication.decision.requestSha256);
      }
    }
    let oldParserProof = { performed: false, reason: "No explicit shared-v2-capable old archive/full SHA pin." };
    if (state.oldParser) oldParserProof = await verifyInstalledHeldPrivateResourceParser(state.oldParser,
      JSON.stringify(commits.find(row => row.outcome === "public-baseline").relocation),
      JSON.stringify(commits.find(row => row.outcome === "publish").relocation));
    check(); await unchangedPrivate(state, component.root);
    state.receipts = receipts; state.commits = commits; state.b1Knowledge = u.hashes(await u.files(component.root, true));
    const evidence = { passed: true, scope: "synthetic checked stored-private legacy publication only", actualNativeUi: true,
      publicNativeChoices: 10, separateResourceNativeChoices: 11, allRequiredDecisionsBeforeEffects: true, publicAndResourceDenialsNoEffects: true,
      privateDenialFocusedByDefault: true, defaultEnterResourceDenials: 4,
      partialResourceDenialNoIntentOrCopy: true, threePrivatePublicationReceipts: true, independentPublicV2BaselineReceipt: true,
      currentSourceTargetOwnerRequestProfileEpochBound: true, privateSourcesAndFoldersReadonlyNoUnlock: true,
      exactOriginalParserDigestBytesIdentityRevision: true, intentionalPrivateAlwaysRetainPolicyDifference: true,
      historicalProvenanceNotRenewableGrant: true, publicMutationReplayAttempted: false, internalCoreMutationReplayAttempted: false,
      providerRequestsInitiatedByHelper: 0, syntheticFixturePublicationOnly: true,
      sourcePerturbationUsed: false, interruptionInjectionUsed: false, installedPendingPublicationRecoveryQualified: false,
      installedExpiryOrCancellationQualified: false, originalPackageSha256: sourceFixture.originalPackageSha256, oldParserProof,
      b1AndB0Qualified: false, fullCutoverQualified: false, outcomes };
    await writeFile(join(root, "native-private-resource-publication-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
    state.phase = "verified";
    return evidence;
  } finally { if (state.phase !== "verified") state.phase = "failed"; abort.abort(); await ui.stop(); }
}
function verified(sourceFixture) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "verified") fail("INSTALLED_PRIVATE_PUBLICATION_VERIFIED_EFFECTS_REQUIRED");
  return state;
}
export async function verifyInstalledNativePrivateResourcePublicationB1(sourceFixture, { retirement }) {
  const state = verified(sourceFixture);
  await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 }, retirement);
  assert.deepEqual(u.hashes(await u.files(retirement.archive, true)), state.b1Knowledge);
  await unchangedPrivate(state, retirement.archive);
  const database = new DatabaseSync(join(retirement.archive, "core.sqlite"), { readOnly: true });
  try {
    const journal = u.readJournal(database); assert.equal(journal.intents.length, 0);
    for (const receipt of state.receipts) {
      assert.deepEqual({ ...journal.receipts.find(row => row.operation_id === receipt.operation_id) }, receipt);
      assert.deepEqual(commitment(database, receipt, state.workspaceId).row, state.commits.find(row => row.row.operation_id === receipt.operation_id).row);
    }
  } finally { database.close(); }
  return { privatePublicationB1PairsPrivateSourcesReferrersFoldersAndHistoricalProvenancePreserved: true,
    historicalDecisionsNotCurrentGrant: true, installedPendingPublicationRecoveryQualified: false };
}
export async function verifyInstalledNativePrivateResourcePublicationRestored(sourceFixture, { retirement, restored }) {
  const state = verified(sourceFixture), b1 = await verifyInstalledNativePrivateResourcePublicationB1(sourceFixture, { retirement });
  const expected = { componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 };
  const retired = await readInstalledKnowledgeMoveRetirementReceipt(expected, retirement);
  await readInstalledKnowledgeMoveRestoredReceipt(expected, retirement, restored, retired);
  assert.deepEqual(u.hashes(await u.files(restored.root)), u.hashes(state.baseline));
  for (const path of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-workspace", ".pkm-next-original-mcp.json", ".pkm-native"])
    await u.absent(join(restored.root, path), "INSTALLED_PRIVATE_PUBLICATION_B0_NATIVE_STATE_OR_GRANT");
  return { ...b1, allOriginalPrivatePublicationB0BytesRestored: true, freshB0NoNativeDatabaseOrGrant: true,
    originalRootOverwritten: false, fullCutoverQualified: false };
}
