import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u,
  assertInstalledKnowledgeMoveComponentBinding, readInstalledKnowledgeMoveRetirementReceipt,
  readInstalledKnowledgeMoveRestoredReceipt,
} from "./installed-native-knowledge-move.mjs";
import { startInstalledNativeLegacyAssetsMoveUi } from "./installed-native-legacy-assets-move-ui.mjs";
import {
  pinnedOriginalKnowledgeWriterFixture, seedOriginalLegacyKnowledge, seedOriginalPublicLegacyCompanion, moveOriginalKnowledge,
} from "../../tests/original-knowledge-writer-fixture.mjs";

const preparations = new WeakMap(), areas = u.areas;
const sourceBytes = Object.freeze({ "a.PNG": Buffer.from([255, 0, 128, 9]), "b.BIN": Buffer.from([1, 2, 3, 4, 5]),
  "shared.PNG": Buffer.from([70, 71, 72, 73]) });
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(sourceFixture) {
  const state = preparations.get(sourceFixture);
  if (!state) fail("INSTALLED_LEGACY_ASSETS_ACTUAL_PREPARATION_REQUIRED");
  return state;
}
function noPrivate(value) {
  u.noPrivatePublication(value);
  assert(!JSON.stringify(value).includes("Retained private legacy marker"), "Private legacy Markdown must not enter public results.");
}
export function installedLegacyAssetsMoveSteps({ note, skill, paper }) {
  const step = (stage, tool, arguments_, outcome, code) => Object.freeze({
    stage: `native-legacy-assets-move-${stage}`, tool, arguments: Object.freeze(arguments_), outcome,
    choice: outcome === "deny" ? "Deny" : "Approve this request", ...(code ? { code } : {}),
  });
  return Object.freeze([
    step("deny", "update_note", { slug: "Old/Before", title: "NotApplied", category: "Denied", content: "Denied legacy move." }, "deny", "ACCESS_DENIED"),
    step("note", "update_note", { slug: "Old/Before", title: "After", category: "New", content: note }, "move"),
    step("skill", "update_skill", { name: "Before", category: "New", content: skill }, "move"),
    step("paper", "update_paper", { slug: "Old/Before", title: "After", category: "New", content: paper }, "move"),
    step("shared-public-conflict", "update_note", { slug: "Old/Shared", title: "SharedAfter", category: "New",
      content: "Changed public shared owner\n![shared](../_assets/shared.PNG?shared=1#view)\n" }, "refuse", "CONFLICT"),
    step("private-destination", "update_note", { slug: "New/After", title: "NotApplied", category: "Private" }, "refuse", "ACCESS_DENIED"),
    step("unreviewed-reference", "update_note", { slug: "New/After", title: "NotApplied", category: "Denied",
      content: "![unreviewed](../_assets/unreviewed.PNG)\n" }, "refuse", "UNSUPPORTED_OPERATION"),
  ]);
}
function target(name) { return `${u.hash(sourceBytes[name]).slice(0, 16)}${name.endsWith("PNG") ? ".png" : ".bin"}`; }
function knowledgeFileHashes(value) { return u.hashes(value); }

/** Exact original writers only, after complete editor exit and before the parent's B0/custody. */
export async function prepareInstalledNativeLegacyAssetsMoveFixture({ installed, componentFixture, legacyVsix, python }) {
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (preparations.has(componentFixture)) fail("INSTALLED_LEGACY_ASSETS_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    join(componentFixture.root, ".pkm-next-original-mcp.json"), join(componentFixture.root, "core.sqlite")])
    await u.absent(path, "INSTALLED_LEGACY_ASSETS_PRESEAL_REQUIRED");
  if (typeof python !== "string" || !isAbsolute(python)) fail("INSTALLED_LEGACY_ASSETS_EXPLICIT_PYTHON_REQUIRED");
  const policyPath = join(componentFixture.root, ".pkm/content-privacy.json"), stat = await lstat(policyPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
    || stat.mode & 0o077 || stat.size > 2_097_152) fail("INSTALLED_LEGACY_ASSETS_PRIVATE_POLICY_REQUIRED");
  const privacyBytes = await readFile(policyPath);
  assert.deepEqual(JSON.parse(privacyBytes), installedNativeKnowledgeMovePrivacyPolicy,
    "Parent must independently configure exact Private top levels in all three areas.");
  for (const area of Object.values(areas)) {
    await mkdir(join(componentFixture.root, area), { recursive: true, mode: 0o700 });
    for (const member of ["Old", "New", "Private", "Denied", "_assets"])
      await u.absent(join(componentFixture.root, area, member), "INSTALLED_LEGACY_ASSETS_DISJOINT_SEED_REQUIRED");
  }
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: componentFixture.directory, legacyVsix, python });
  const rows = writer.run(componentFixture.root, seedOriginalLegacyKnowledge, { paired: true, parserForms: true, configurePrivacy: false });
  const sharedRows = writer.run(componentFixture.root, seedOriginalPublicLegacyCompanion);
  assert.deepEqual(await readFile(policyPath), privacyBytes);
  const baseline = await u.files(componentFixture.root), oracle = join(componentFixture.directory, "original-legacy-assets-oracle");
  await cp(componentFixture.root, oracle, { recursive: true, errorOnExist: true, force: false });
  const contents = Object.fromEntries(Object.entries(rows).map(([kind, row]) => [kind, row.content.replace("Original legacy body", "Changed legacy body")]));
  const steps = installedLegacyAssetsMoveSteps(contents), expected = {};
  for (const kind of Object.keys(areas)) expected[kind] = writer.run(oracle, moveOriginalKnowledge, { kind, content: contents[kind] });
  const referrers = {};
  for (const area of Object.values(areas)) referrers[area] = await readFile(join(oracle, area, "Old/Referrer.md"));
  const shared = steps.find(step => step.stage.endsWith("shared-public-conflict"));
  const originalShared = writer.run(oracle, moveOriginalKnowledge, { kind: "note", key: "Old/Shared",
    name: "SharedAfter", content: shared.arguments.content });
  assert.equal(originalShared.knowledgeId, sharedRows.note.knowledgeId);
  assert.equal(originalShared.revision, sharedRows.note.revision + 1);
  assert(originalShared.content.includes(`SharedAfter.assets/${target("shared.PNG")}?shared=1#view`));
  assert.deepEqual(await readFile(join(oracle, "notes/_assets/shared.PNG")), sourceBytes["shared.PNG"]);
  assert.deepEqual(await readFile(join(oracle, "notes/New/SharedAfter.assets", target("shared.PNG"))), sourceBytes["shared.PNG"]);
  assert.deepEqual(await readFile(join(oracle, "notes/Old/Referrer.md")), referrers.notes);
  const value = Object.freeze({ kind: "pkm.installed-native-legacy-assets-fixture/v1", root: componentFixture.root,
    originalPackageSha256: writer.originalPackageSha256, privacySha256: u.hash(privacyBytes),
    originals: Object.freeze(Object.fromEntries(Object.entries(rows).map(([kind, row]) => [kind, Object.freeze({
      id: row.knowledgeId, revision: row.revision, path: "Old/Before.md", area: areas[kind],
    })]))), targets: Object.freeze({ png: target("a.PNG"), bin: target("b.BIN"), shared: target("shared.PNG") }),
    originalSharedCopyAndRetainObserved: true, files: Object.freeze(u.hashes(baseline).map(Object.freeze)) });
  const state = { installed, componentFixture, value, baseline, privacyBytes, rows, sharedRows, expected, steps, phase: "prepared" };
  preparations.set(componentFixture, state); preparations.set(value, state);
  return value;
}

async function assertRefusal(component, step, signal) {
  let failure;
  try {
    const response = await component.invoke(step.tool, step.arguments, signal);
    noPrivate(response);
    if (response.isError) failure = new Error(JSON.stringify(response));
  } catch (error) { failure = error; }
  assert(failure, "The exact native request must refuse without retrying.");
  noPrivate({ message: failure.message });
  if (step.outcome === "deny") {
    assert.equal(failure.code, "ACCESS_DENIED", "Human denial must be the actual typed native authority refusal.");
  } else {
    const code = failure.code ?? /\b(CONFLICT|ACCESS_DENIED|UNSUPPORTED_OPERATION):/.exec(failure.message)?.[1];
    assert.equal(code, step.code, failure.message);
  }
  return { stage: step.stage, refused: true, code: step.code };
}
async function verifyMoved(root, kind, state, markdown) {
  const area = areas[kind], name = kind === "skill" ? "Before" : "After", expected = state.expected[kind];
  const document = markdown.scanMarkdown(root).find(row => row.record.area === area && row.record.path === `New/${name}.md`);
  assert(document); assert.equal(document.record.id, state.rows[kind].knowledgeId);
  assert.equal(document.metadata.get("knowledgeId"), expected.knowledgeId);
  assert.equal(document.metadata.get(kind === "skill" ? "name" : "title"), name);
  assert.equal(document.record.revision, expected.revision); assert.equal(document.record.content, expected.content);
  assert.deepEqual([...document.metadata.toJS().aliases].sort(), [...expected.aliases].sort());
  for (const source of ["a.PNG", "b.BIN"]) {
    assert.deepEqual(await readFile(join(root, area, `New/${name}.assets`, target(source))), sourceBytes[source]);
    await u.absent(join(root, area, "_assets", source), "INSTALLED_LEGACY_ASSETS_OLD_SOURCE_REMAINED");
  }
  assert(document.record.content.includes(`${name}.assets/${target("a.PNG")}?q=1#view`));
  assert(document.record.content.includes(`src="${name}.assets/${target("a.PNG")}?html=1#image"`));
  assert(document.record.content.includes(`[legacy]: <${name}.assets/${target("b.BIN")}?definition=1#doc>`));
  assert(document.record.content.includes("`![ignored](../_assets/a.PNG)`"));
  assert(document.record.content.includes("```md\n![example](../_assets/b.BIN)\n```"));
  if (kind === "note") assert.deepEqual(await readFile(join(root, area, "New/After.assets/existing.bin")), Buffer.from([9, 8, 7]));
  if (kind === "paper") assert.equal(document.metadata.get("file"), expected.file);
  await u.absent(join(root, area, "Old/Before.md"), "INSTALLED_LEGACY_ASSETS_OLD_OWNER_REMAINED");
  await u.absent(join(root, area, "Old/Before.assets"), "INSTALLED_LEGACY_ASSETS_OLD_PAIR_REMAINED");
  return document;
}

/** Seven exact native dialogs; no source perturbation, injection, replay or attachment revocation. */
export async function verifyInstalledNativeLegacyAssetsMove({ root, installed, component, sourceFixture, payloadBuildId,
  python, env, port, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "prepared") fail("INSTALLED_LEGACY_ASSETS_VERIFY_ORDER_REQUIRED");
  if (state.installed !== installed || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_LEGACY_ASSETS_SAME_COMPONENT_REQUIRED");
  const { host, full, first } = await assertInstalledKnowledgeMoveComponentBinding({
    root, installed, component, componentFixture: state.componentFixture, payloadBuildId,
  });
  const markdown = await u.load(installed, "markdown"), lease = { ...component.owner.workspaceLease() }, runId = randomUUID();
  assert.equal(full.storage, component.storage);
  const privateBefore = (await u.files(component.root, true)).filter(file => file.path.includes("/Private/"));
  const sharedBefore = (await u.files(component.root, true)).filter(file => /\/Old\/(?:Shared|Referrer)\.md$|\/_assets\/shared\.PNG$/.test(file.path));
  noPrivate(markdown.scanMarkdown(component.root).map(row => ({ ...row.record })));
  await u.unchangedOriginalControls(state, component.root);
  assert.equal(u.liveJournal(component).intents.length, 0); state.b0Sha256 = component.b0.sha256;
  await writeFile(join(root, "native-legacy-assets-move-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-legacy-assets-move-ui/v1", runId, nativeEpoch: host.receipt.epoch,
    binding: { root: component.root, workspaceId: component.workspaceId, profileSha256: first.result.profileSha256 }, steps: state.steps,
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativeLegacyAssetsMoveUi({ root, python, env, port, runId, timeoutMs }), abort = new AbortController();
  void ui.done.catch(error => abort.abort(error));
  const check = () => {
    if (ui.error) throw ui.error;
    host.assertCurrent(); component.storage.assertWorkspaceLease();
    assert.deepEqual({ ...component.owner.workspaceLease() }, lease);
  };
  const invoke = async (tool, args) => {
    check(); const response = await component.invoke(tool, args, abort.signal);
    noPrivate(response); assert.notEqual(response.isError, true, JSON.stringify(response));
    const value = response.structuredContent ?? JSON.parse(response.content[0].text);
    noPrivate(value); return value;
  };
  try {
    await ui.ready; check();
    for (const kind of Object.keys(areas)) {
      const value = await invoke(`get_${kind}`, kind === "skill" ? { name: "Before" } : { slug: "Old/Before" });
      assert.equal(value.content, state.rows[kind].content);
      assert.equal(value[kind === "skill" ? "skill_id" : "slug"], "Old/Before");
    }
    const receipts = [], outcomes = [];
    for (const step of state.steps) {
      check(); const beforeFiles = knowledgeFileHashes(await u.files(component.root, true)), beforeJournal = u.liveJournal(component);
      await writeFile(join(root, "progress.json"), JSON.stringify({ stage: step.stage }), { mode: 0o600 });
      if (step.outcome !== "move") {
        outcomes.push(await assertRefusal(component, step, abort.signal));
        assert.deepEqual(knowledgeFileHashes(await u.files(component.root, true)), beforeFiles);
        assert.deepEqual(u.liveJournal(component), beforeJournal);
        await u.unchangedOriginalControls(state, component.root);
        continue;
      }
      const result = await invoke(step.tool, step.arguments), kind = step.tool.slice(7), name = kind === "skill" ? "Before" : "After";
      assert.deepEqual(result, kind === "skill" ? { ok: true, name } : { ok: true, slug: "New/After" });
      const document = await verifyMoved(component.root, kind, state, markdown);
      const after = u.liveJournal(component), beforeIds = new Set(beforeJournal.receipts.map(row => row.operation_id));
      const added = after.receipts.filter(row => !beforeIds.has(row.operation_id));
      assert.equal(after.intents.length, 0); assert.equal(added.length, 1);
      const receipt = { ...added[0] }, value = JSON.parse(receipt.result);
      assert.equal(receipt.actor_id, "mcp:external"); assert.equal(receipt.operation, `knowledge.${kind === "paper" ? "research" : kind}.update`);
      assert.equal(value.operationId, receipt.operation_id); assert.equal(value.id, document.record.id);
      assert.equal(value.path, document.record.path); assert.equal(value.revision, document.record.revision); assert.equal(value.sha256, document.record.sha256);
      noPrivate(value); receipts.push(receipt); outcomes.push({ stage: step.stage, operationId: receipt.operation_id });
      const read = await invoke(`get_${kind}`, kind === "skill" ? { name } : { slug: "New/After" });
      assert.equal(read.content, state.expected[kind].content); assert.equal(read.category, "New");
      assert.equal(read[kind === "skill" ? "skill_id" : "slug"], `New/${name}`);
      assert.equal(read[kind === "skill" ? "name" : "title"], name);
      if (kind === "paper") assert.equal(read.file, state.expected.paper.file);
    }
    assert.deepEqual((await u.files(component.root, true)).filter(file => file.path.includes("/Private/")), privateBefore);
    assert.deepEqual((await u.files(component.root, true)).filter(file => /\/Old\/(?:Shared|Referrer)\.md$|\/_assets\/shared\.PNG$/.test(file.path)), sharedBefore);
    await u.unchangedOriginalControls(state, component.root);
    noPrivate(markdown.scanMarkdown(component.root).map(row => ({ ...row.record }))); check();
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: "native-legacy-assets-move-complete" }), { mode: 0o600 });
    await ui.done; check();
    const proof = JSON.parse(await readFile(join(root, "native-legacy-assets-move-ui-passed.json")));
    assert.equal(proof.passed, true); assert.equal(proof.actualRenderedDom, true); assert.equal(proof.runId, runId);
    assert.deepEqual(proof.dialogs.map(row => ({ stage: row.stage, choice: row.choice })), state.steps.map(row => ({ stage: row.stage, choice: row.choice })));
    assert.equal(receipts.length, 3); state.receipts = receipts; state.b1Knowledge = u.hashes(await u.files(component.root, true));
    const evidence = { passed: true, scope: "public unshared original legacy assets only", actualNativeUi: true,
      sameOwnerLease: true, originalPackageSha256: sourceFixture.originalPackageSha256, originalSharedCopyAndRetainObserved: true,
      nativeSharedCopyAndRetainQualified: false, nativeSharedPublicRefusalNoChanges: true, typedFreshNativeDenial: true,
      privateDestinationAndUnreviewedReferencesRefused: true, threeStableIdentityRevisionMoves: true,
      exactDigestNamesBytesParserFormsAndSuffixes: true, unsharedSourcesRemoved: true, existingPairedBytesPreserved: true,
      privateMarkdownImmutableNoPublicLeak: true, interruptionInjectionUsed: false, sourcePerturbationUsed: false,
      publicMutationReplayAttempted: false, attachmentRevoked: false, outcomes, nativeReceiptSha256: u.hash(JSON.stringify(receipts)),
      privateResourcePublicationQualified: false, b1AndB0Qualified: false, fullCutoverQualified: false };
    state.phase = "verified";
    await writeFile(join(root, "native-legacy-assets-move-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
    return evidence;
  } finally { if (state.phase !== "verified") state.phase = "failed"; abort.abort(); await ui.stop(); }
}

function recoveryState(sourceFixture) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "verified" || !state.receipts) fail("INSTALLED_LEGACY_ASSETS_VERIFIED_EFFECTS_REQUIRED");
  return state;
}
export async function verifyInstalledNativeLegacyAssetsMoveB1(sourceFixture, { retirement }) {
  const state = recoveryState(sourceFixture);
  await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture, sourceRoot: sourceFixture.root,
    b0Sha256: state.b0Sha256 }, retirement);
  assert.deepEqual(u.hashes(await u.files(retirement.archive, true)), state.b1Knowledge);
  await u.unchangedOriginalControls(state, retirement.archive);
  const database = new DatabaseSync(join(retirement.archive, "core.sqlite"), { readOnly: true });
  try {
    const journal = u.readJournal(database); assert.equal(journal.intents.length, 0);
    for (const row of state.receipts) {
      const stored = journal.receipts.find(value => value.operation_id === row.operation_id);
      assert(stored); assert.deepEqual({ ...stored }, row);
    }
  } finally { database.close(); }
  return { legacyB1MovedBytesPositionsAndReceiptsPreserved: true, legacySharedAndPrivateB1SourcesUnchanged: true };
}
export async function verifyInstalledNativeLegacyAssetsMoveRestored(sourceFixture, { retirement, restored }) {
  const state = recoveryState(sourceFixture), b1 = await verifyInstalledNativeLegacyAssetsMoveB1(sourceFixture, { retirement });
  const expected = { componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 };
  const retired = await readInstalledKnowledgeMoveRetirementReceipt(expected, retirement);
  await readInstalledKnowledgeMoveRestoredReceipt(expected, retirement, restored, retired);
  assert.deepEqual(u.hashes(await u.files(restored.root)), u.hashes(state.baseline));
  for (const path of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-workspace", ".pkm-next-original-mcp.json", ".pkm-native"])
    await u.absent(join(restored.root, path), "INSTALLED_LEGACY_ASSETS_B0_NATIVE_STATE_OR_GRANT");
  return { ...b1, allOriginalLegacyB0BytesRestored: true, freshB0NoNativeDatabaseOrGrants: true,
    originalRootOverwritten: false, nativeSharedCopyAndRetainQualified: false, fullCutoverQualified: false };
}

export const installedLegacyAssetsFixtureFacts = Object.freeze({
  target, verifyMoved, assertRefusal,
  bytes(name) {
    assert(Object.hasOwn(sourceBytes, name), "Unknown legacy fixture source.");
    return Buffer.from(sourceBytes[name]);
  },
});
