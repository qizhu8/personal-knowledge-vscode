import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u,
  assertInstalledKnowledgeMoveComponentBinding, readInstalledKnowledgeMoveRetirementReceipt, readInstalledKnowledgeMoveRestoredReceipt,
} from "./installed-native-knowledge-move.mjs";
import { pinnedOriginalKnowledgeWriterFixture, moveOriginalKnowledge } from "../../tests/original-knowledge-writer-fixture.mjs";
import { startInstalledNativePrivateResourceLifecycleUi } from "./installed-native-private-resource-lifecycle-ui.mjs";

const states = new WeakMap(), names = ["life-A.PNG", "life-B.BIN", "life-C.BIN"];
const bytes = Object.fromEntries(names.map((name, index) => [name, Buffer.from(`PRIVATE_LIFECYCLE_BYTES_${index}`)]));
const target = name => `${u.hash(bytes[name]).slice(0, 16)}${name.slice(name.lastIndexOf(".")).toLowerCase()}`;
const id = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
const sorted = files => [...files].sort((a, b) => a.path.localeCompare(b.path));
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value) { const state = states.get(value); if (!state) fail("INSTALLED_PRIVATE_LIFECYCLE_ACTUAL_PREPARATION_REQUIRED"); return state; }
function noPrivate(value) {
  u.noPrivatePublication(value);
  assert(!/PRIVATE_LIFECYCLE_(BYTES_|REFERRER)/.test(JSON.stringify(value)), "Private plaintext cannot enter public evidence/replies.");
}
export const seedOriginalPrivateResourceLifecycle = `
  const content="Original lifecycle owner\\n![A](../Private/_assets/life-A.PNG?q=1#view)\\n"
    +"[B](../Private/_assets/life-B.BIN)\\n[C](../Private/_assets/life-C.BIN)\\n";
  store.noteUpsert({slug:"Old/Before",title:"Before",category:"Old",type:"general",content});
  for(const [index,name] of ["life-A.PNG","life-B.BIN","life-C.BIN"].entries()){
    const bytes=Buffer.from("PRIVATE_LIFECYCLE_BYTES_"+index);
    assets.importMarkdownAssetBundle(root,[{type:"notes",path:"Private/_assets/"+name,data:bytes.toString("base64"),
      digest:"sha256:"+require("node:crypto").createHash("sha256").update(bytes).digest("hex")}],
      [{area:"notes",path:"Old/Before.md",content}]);
  }
  store.noteUpsert({slug:"Private/Secret",title:"Secret",category:"Private",type:"general",
    content:"PRIVATE_LIFECYCLE_REFERRER\\n![A](_assets/life-A.PNG)\\n"});
  return store.noteGet("Old/Before");
`;
async function folders(root) {
  const result = [];
  async function walk(path, relative) {
    const stat = await lstat(path); assert(stat.isDirectory() && !stat.isSymbolicLink());
    result.push({ path: relative, identity: id(stat) });
    for (const name of (await readdir(path)).sort()) if ((await lstat(join(path, name))).isDirectory()) await walk(join(path, name), `${relative}/${name}`);
  }
  await walk(join(root, "notes/Private"), "notes/Private"); return result;
}
/** Separate job only; native move/pending recovery APIs and existing 21-choice helper are unchanged. */
export async function prepareInstalledNativePrivateResourceLifecycleFixture({ installed, componentFixture, legacyVsix, python }) {
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (states.has(componentFixture)) fail("INSTALLED_PRIVATE_LIFECYCLE_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    join(componentFixture.root, "core.sqlite"), join(componentFixture.root, ".pkm-next-original-mcp.json")])
    await u.absent(path, "INSTALLED_PRIVATE_LIFECYCLE_PRESEAL_REQUIRED");
  if (!isAbsolute(python ?? "")) fail("INSTALLED_PRIVATE_LIFECYCLE_EXPLICIT_PYTHON_REQUIRED");
  const policyPath = join(componentFixture.root, ".pkm/content-privacy.json"), stat = await lstat(policyPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077)
    fail("INSTALLED_PRIVATE_LIFECYCLE_INDEPENDENT_POLICY_REQUIRED");
  const privacyBytes = await readFile(policyPath);
  assert.deepEqual(JSON.parse(privacyBytes), installedNativeKnowledgeMovePrivacyPolicy, "Independently configure all three Private areas.");
  for (const area of Object.values(u.areas)) await mkdir(join(componentFixture.root, area), { recursive: true, mode: 0o700 });
  for (const path of ["Old", "New", "Private"]) await u.absent(join(componentFixture.root, "notes", path), "INSTALLED_PRIVATE_LIFECYCLE_DISJOINT_SEED_REQUIRED");
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: componentFixture.directory, legacyVsix, python });
  const row = writer.run(componentFixture.root, seedOriginalPrivateResourceLifecycle), baseline = await u.files(componentFixture.root);
  const oracle = join(componentFixture.directory, "original-private-lifecycle-oracle");
  await cp(componentFixture.root, oracle, { recursive: true, force: false, errorOnExist: true });
  const expected = writer.run(oracle, moveOriginalKnowledge, { kind: "note", content: row.content });
  for (const name of names) assert.deepEqual(await readFile(join(oracle, "notes/New/After.assets", target(name))), bytes[name]);
  await u.absent(join(oracle, "notes/Private/_assets/life-B.BIN"), "INSTALLED_PRIVATE_LIFECYCLE_ORIGINAL_POLICY_DIFFERENCE_REQUIRED");
  assert.deepEqual(await readFile(policyPath), privacyBytes);
  const value = Object.freeze({ kind: "pkm.installed-private-resource-lifecycle-fixture/v1", root: componentFixture.root,
    originalPackageSha256: writer.originalPackageSha256, privacySha256: u.hash(privacyBytes), threeStoredPrivateResources: true,
    intentionalPrivateAlwaysRetainPolicyDifference: true, files: Object.freeze(u.hashes(baseline).map(Object.freeze)) });
  const state = { installed, componentFixture, baseline, privacyBytes, row, expected, folders: await folders(componentFixture.root), phase: "prepared" };
  states.set(componentFixture, state); states.set(value, state); return value;
}
async function unchanged(state, root) {
  assert.deepEqual(sorted((await u.files(root, true)).filter(file => file.path.includes("/Private/"))), state.privateBefore);
  assert.deepEqual(await folders(root), state.folders);
  for (const file of state.before.filter(file => file.path !== "notes/Old/Before.md"))
    assert.deepEqual(await readFile(join(root, file.path)), file.bytes);
  await u.unchangedOriginalControls(state, root);
}
async function waitMarker(root, name, runId, check, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    check();
    try {
      const value = JSON.parse(await readFile(join(root, name)));
      assert.equal(value.runId, runId); return value;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Private lifecycle handshake timed out");
}
function decodeFailure(settled) {
  if (settled.error) return settled.error;
  if (settled.value?.isError) return Object.assign(new Error(JSON.stringify(settled.value)), { code: settled.value.structuredContent?.code });
  throw new Error("Cancellation/expired resource operation unexpectedly succeeded");
}
function committed(database, operationId, workspaceId) {
  const raw = database.prepare("SELECT * FROM migration_runtime_knowledge_commits WHERE operation_id=?").get(operationId); assert(raw);
  const row = { ...raw };
  assert.equal(row.workspace_id, workspaceId);
  assert.equal(row.digest, u.hash(JSON.stringify([row.sequence, row.workspace_id, row.operation_id, row.request_json, row.plan_json, row.result_json])));
  return row;
}
/** Real wall-clock waits and public AbortSignal only; never manufactures a pending private intent. */
export async function verifyInstalledNativePrivateResourceLifecycle({ root, installed, component, sourceFixture, payloadBuildId,
  python, env, port, timeoutMs = 240000 }) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "prepared") fail("INSTALLED_PRIVATE_LIFECYCLE_VERIFY_ORDER_REQUIRED");
  if (state.installed !== installed || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_PRIVATE_LIFECYCLE_SAME_COMPONENT_REQUIRED");
  const { host } = await assertInstalledKnowledgeMoveComponentBinding({ root, installed, component, componentFixture: state.componentFixture, payloadBuildId });
  assert.equal(host.nativeChat, undefined);
  for (const provider of ["vscode", "openai-compatible", "azure-openai"]) assert.equal(host.options.providerTransport.supports(provider), false);
  const markdown = await u.load(installed, "markdown"), contracts = await u.load(installed, "private-resource-publication-contracts");
  const mutations = await u.load(installed, "knowledge-mutations"), lease = { ...component.owner.workspaceLease() }, runId = randomUUID();
  state.before = await u.files(component.root, true);
  state.privateBefore = sorted(state.before.filter(file => file.path.includes("/Private/")));
  assert.deepEqual(state.privateBefore, sorted(state.baseline.filter(file => file.path.includes("/Private/"))));
  state.b0Sha256 = component.b0.sha256; state.workspaceId = component.workspaceId;
  const selected = markdown.scanMarkdown(component.root).find(row => row.record.area === "notes" && row.record.path === "Old/Before.md"); assert(selected);
  const owner = { area: "notes", id: selected.record.id, beforePath: "Old/Before.md", afterPath: "New/After.md",
    revision: selected.record.revision, sha256: selected.record.sha256 };
  const resources = await Promise.all(names.map(async name => ({
    sourcePath: `Private/_assets/${name}`, sha256: u.hash(bytes[name]), size: bytes[name].length,
    sourceIdentity: id(await lstat(join(component.root, "notes/Private/_assets", name))), targetPath: `New/After.assets/${target(name)}`,
  })));
  const args = { slug: "Old/Before", title: "After", category: "New" }, steps = ["cancel", "expiry", "publish"].map(mode =>
    ({ mode, stage: `native-private-resource-lifecycle-${mode}` }));
  const binding = { root: component.root, workspaceId: component.workspaceId, catalogSha256: host.receipt.sourceCatalogSha256,
    profileSha256: host.receipt.profileSha256, custodyPlanSha256: component.custody.planSha256, privacySha256: component.custody.privacySha256,
    epoch: host.receipt.epoch, nativeHostReceiptSha256: host.receipt.receiptSha256 };
  assert.equal(binding.privacySha256, sourceFixture.privacySha256);
  await writeFile(join(root, "native-private-resource-lifecycle-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-private-resource-lifecycle-ui/v1", runId, binding, owner, resources, arguments: args, steps,
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativePrivateResourceLifecycleUi({ root, python, env, port, runId, timeoutMs });
  let active; void ui.done.catch(error => active?.abort(error));
  const check = () => { if (ui.error) throw ui.error; host.assertCurrent(); component.storage.assertWorkspaceLease();
    assert.deepEqual({ ...component.owner.workspaceLease() }, lease); };
  const outcomes = [];
  try {
    await ui.ready; check(); await unchanged(state, component.root);
    for (const step of steps) {
      const before = u.hashes(await u.files(component.root, true)), journal = u.liveJournal(component);
      assert.equal(journal.intents.length, 0); active = new AbortController();
      await writeFile(join(root, "progress.json"), JSON.stringify({ stage: step.stage }), { mode: 0o600 });
      const promise = component.invoke("update_note", args, active.signal).then(value => ({ value }), error => ({ error }));
      if (step.mode === "cancel") {
        const ready = await waitMarker(root, "native-private-resource-lifecycle-cancel-ready.json", runId, check);
        assert.equal(ready.actualRenderedDom, true); assert.equal(ready.requestSha256, contracts.privateResourcePublicationDigest(ready.request));
        const subject = contracts.validatePrivateResourcePublicationSubject(ready.request.subject);
        assert.deepEqual(subject.owner, owner); assert.deepEqual(subject.resource, resources[1]);
        assert.equal(subject.root, component.root); assert.equal(subject.publicRequest.argumentsDigest, contracts.privateResourcePublicationDigest(args));
        active.abort();
        const failure = decodeFailure(await promise); noPrivate({ message: failure.message }); assert.equal(failure.code, "NATIVE_REQUEST_CANCELLED");
        assert.deepEqual(u.hashes(await u.files(component.root, true)), before); assert.deepEqual(u.liveJournal(component), journal);
        await writeFile(join(root, "native-private-resource-lifecycle-cancel-observed.json"), JSON.stringify({
          runId, operationId: subject.operationId, code: failure.code,
        }), { mode: 0o600, flag: "wx" });
        const closed = await waitMarker(root, "native-private-resource-lifecycle-cancel-closed.json", runId, check);
        assert.equal(closed.operationId, subject.operationId); assert.equal(closed.lateModalAction, true);
        assert.deepEqual(u.hashes(await u.files(component.root, true)), before); assert.deepEqual(u.liveJournal(component), journal);
        outcomes.push({ mode: step.mode, code: failure.code, lateNativeActionNoEffect: true });
      } else if (step.mode === "expiry") {
        const failure = decodeFailure(await promise); noPrivate({ message: failure.message });
        const code = failure.code ?? /\b(PRIVATE_RESOURCE_PUBLICATION_EXPIRED):/.exec(failure.message)?.[1];
        assert.equal(code, "PRIVATE_RESOURCE_PUBLICATION_EXPIRED", "Request timeout/cancellation is not grant-expiry evidence.");
        assert.deepEqual(u.hashes(await u.files(component.root, true)), before); assert.deepEqual(u.liveJournal(component), journal);
        outcomes.push({ mode: step.mode, code });
      } else {
        const settled = await promise; if (settled.error) throw settled.error;
        noPrivate(settled.value); assert.notEqual(settled.value.isError, true);
        assert.deepEqual(settled.value.structuredContent ?? JSON.parse(settled.value.content[0].text), { ok: true, slug: "New/After" });
        const document = markdown.scanMarkdown(component.root).find(row => row.record.area === "notes" && row.record.path === "New/After.md"); assert(document);
        assert.equal(document.record.id, state.expected.knowledgeId); assert.equal(document.record.revision, state.expected.revision);
        assert.equal(document.record.content, state.expected.content);
        assert.equal(document.metadata.get("knowledgeId"), state.expected.knowledgeId); assert.equal(document.metadata.get("title"), "After");
        assert.deepEqual([...document.metadata.toJS().aliases].sort(), [...state.expected.aliases].sort());
        for (const name of names) assert.deepEqual(await readFile(join(component.root, "notes/New/After.assets", target(name))), bytes[name]);
        await u.absent(join(component.root, "notes/Old/Before.md"), "INSTALLED_PRIVATE_LIFECYCLE_OLD_OWNER_REMAINED");
        const current = u.liveJournal(component), prior = new Set(journal.receipts.map(row => row.operation_id));
        const added = current.receipts.filter(row => !prior.has(row.operation_id)); assert.equal(added.length, 1); assert.equal(current.intents.length, 0);
        state.receipt = { ...added[0] }; const result = JSON.parse(state.receipt.result); noPrivate(result);
        assert.equal(state.receipt.actor_id, "mcp:external"); assert.equal(result.sha256, document.record.sha256); assert.equal(result.id, document.record.id);
        assert.equal(state.receipt.operation, "knowledge.note.update"); assert.equal(result.operationId, state.receipt.operation_id);
        assert.equal(result.path, "New/After.md"); assert.equal(result.revision, document.record.revision);
        const database = component.storage.connectNative();
        try { state.commit = committed(database, state.receipt.operation_id, component.workspaceId); } finally { database.close(); }
        assert.equal(state.commit.result_json, state.receipt.result);
        const request = JSON.parse(state.commit.request_json), plan = JSON.parse(state.commit.plan_json), relocation = JSON.parse(plan.relocation);
        assert.equal(request.actorId, "mcp:external"); assert.equal(request.args.operationId, state.receipt.operation_id);
        assert.equal(request.operation, "knowledge.note.update");
        assert.equal(relocation.legacyAssets.protocol, "pkm.document-private-resource-publication/v1"); assert.equal(relocation.legacyAssets.copies.length, 3);
        for (const copy of relocation.legacyAssets.copies) {
          assert.equal(copy.visibility, "private"); assert.equal(copy.disposition, "retain");
          const provenance = contracts.validatePrivateResourcePublicationProvenance(copy.publication);
          assert.equal(provenance.subject.canonicalArgumentsDigest, contracts.privateResourcePublicationDigest(request.args));
          assert.equal(provenance.subject.operationId, state.receipt.operation_id); assert.equal(provenance.decision.epoch, host.receipt.epoch);
        }
        await component.storage.withWorkspaceExclusive(() => mutations.assertKnowledgeMutationRequestPlan(component.root,
          mutations.deserializeKnowledgeMutationPlan(state.commit.plan_json), request));
        const read = await component.invoke("get_note", { slug: "New/After" }); noPrivate(read); assert.notEqual(read.isError, true);
        assert.equal((read.structuredContent ?? JSON.parse(read.content[0].text)).content, document.record.content);
        outcomes.push({ mode: step.mode, operationId: state.receipt.operation_id });
      }
      await unchanged(state, component.root); check(); active = undefined;
    }
    noPrivate(markdown.scanMarkdown(component.root).map(row => ({ ...row.record })));
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: "native-private-resource-lifecycle-complete" }), { mode: 0o600 });
    await ui.done; check();
    const proof = JSON.parse(await readFile(join(root, "native-private-resource-lifecycle-ui-passed.json")));
    assert.equal(proof.passed, true); assert.equal(proof.actualRenderedDom, true); assert.equal(proof.runId, runId); assert.equal(proof.dialogs.length, 11);
    const aged = proof.dialogs.filter(row => row.mode === "expiry" && row.type === "resource");
    assert.equal(aged.length, 3); assert(aged[1].actualWaitMs >= 65000 && aged[2].actualWaitMs >= 65000 && aged[2].elapsedSinceFirstMs >= 130000);
    const relocation = JSON.parse(JSON.parse(state.commit.plan_json).relocation);
    for (const copy of relocation.legacyAssets.copies) {
      const dialog = proof.dialogs.find(row => row.mode === "publish" && row.type === "resource" && row.request.subject.resource.sourcePath === copy.source);
      assert(dialog); assert.deepEqual(dialog.request.subject, copy.publication.subject); assert.equal(dialog.requestSha256, copy.publication.decision.requestSha256);
    }
    state.b1Knowledge = u.hashes(await u.files(component.root, true));
    const evidence = { passed: true, scope: "synthetic move-only private cancel/expiry then fresh publication", actualNativeUi: true,
      publicNativeChoices: proof.dialogs.filter(row => row.type === "public").length,
      separateResourceNativeChoices: proof.dialogs.filter(row => row.type === "resource").length,
      actualCallerAbortAndLateModalActionNoEffects: true, actualExpiredFirstGrantNotRpcTimeout: true, real65SecondReviewWaits: true,
      actualReviewWaitMs: aged.slice(1).map(row => row.actualWaitMs),
      elapsedSinceFirstResourceChoiceMs: aged[2].elapsedSinceFirstMs,
      allResourceReviewsBeforeIntentOrCopy: true, freshCurrentThreeResourcePublicationReceipt: true, privateSourcesFoldersControlsUnchanged: true,
      modelChannelUnavailable: true, clockMocked: false, sourcePerturbationUsed: false, fsMonkeypatchUsed: false,
      internalCoreMutationReplayAttempted: false, installedPendingPrivateRecoveryQualified: false, fullCutoverQualified: false,
      originalPackageSha256: sourceFixture.originalPackageSha256, outcomes };
    await writeFile(join(root, "native-private-resource-lifecycle-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
    state.phase = "verified"; return evidence;
  } finally { active?.abort(); if (state.phase !== "verified") state.phase = "failed"; await ui.stop(); }
}
function verified(value) { const state = stateFor(value); if (state.phase !== "verified") fail("INSTALLED_PRIVATE_LIFECYCLE_VERIFIED_EFFECTS_REQUIRED"); return state; }
export async function verifyInstalledNativePrivateResourceLifecycleB1(sourceFixture, { retirement }) {
  const state = verified(sourceFixture);
  await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 }, retirement);
  assert.deepEqual(u.hashes(await u.files(retirement.archive, true)), state.b1Knowledge); await unchanged(state, retirement.archive);
  const database = new DatabaseSync(join(retirement.archive, "core.sqlite"), { readOnly: true });
  try {
    const journal = u.readJournal(database); assert.equal(journal.intents.length, 0);
    assert.deepEqual({ ...journal.receipts.find(row => row.operation_id === state.receipt.operation_id) }, state.receipt);
    assert.deepEqual(committed(database, state.receipt.operation_id, state.workspaceId), state.commit);
  } finally { database.close(); }
  return { lifecycleB1PublishedPairRetainedPrivateControlsAndHistoricalProvenancePreserved: true, installedPendingPrivateRecoveryQualified: false };
}
export async function verifyInstalledNativePrivateResourceLifecycleRestored(sourceFixture, { retirement, restored }) {
  const state = verified(sourceFixture), b1 = await verifyInstalledNativePrivateResourceLifecycleB1(sourceFixture, { retirement });
  const expected = { componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 };
  const retired = await readInstalledKnowledgeMoveRetirementReceipt(expected, retirement);
  await readInstalledKnowledgeMoveRestoredReceipt(expected, retirement, restored, retired);
  assert.deepEqual(u.hashes(await u.files(restored.root)), u.hashes(state.baseline));
  for (const path of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-workspace", ".pkm-next-original-mcp.json", ".pkm-native"])
    await u.absent(join(restored.root, path), "INSTALLED_PRIVATE_LIFECYCLE_B0_NATIVE_STATE_OR_GRANT");
  return { ...b1, allOriginalLifecycleB0BytesRestored: true, freshB0NoNativeDatabaseOrGrant: true, originalRootOverwritten: false, fullCutoverQualified: false };
}
