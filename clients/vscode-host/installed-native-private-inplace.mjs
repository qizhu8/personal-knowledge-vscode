import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u,
  assertInstalledKnowledgeMoveComponentBinding, readInstalledKnowledgeMoveRetirementReceipt, readInstalledKnowledgeMoveRestoredReceipt,
} from "./installed-native-knowledge-move.mjs";
import { pinnedOriginalKnowledgeWriterFixture } from "../../tests/original-knowledge-writer-fixture.mjs";
import { seedOriginalPrivateResourcePublication } from "../../tests/original-private-resource-publication-fixture.mjs";
import { startInstalledNativePrivateInplaceUi } from "./installed-native-private-inplace-ui.mjs";

const states = new WeakMap(), sorted = values => [...values].sort((a, b) => a.path.localeCompare(b.path));
const identity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value) { const state = states.get(value); if (!state) fail("PRIVATE_INPLACE_ACTUAL_PREPARATION_REQUIRED"); return state; }
function noPrivateBytes(value) {
  const text = JSON.stringify(value);
  assert(!/SYNTHETIC_PRIVATE_RESOURCE_|SYNTHETIC_PRIVATE_REFERRER|PRIVATE_INPLACE_UNREVIEWED_BYTES/.test(text), "Private plaintext is not public.");
}
export function installedNativePrivateInplaceSteps(contents) {
  const step = (stage, kind, outcome, args) => ({
    stage: `native-private-inplace-${stage}`, kind, tool: `update_${kind}`, outcome,
    choice: outcome === "deny" ? "Deny" : "Approve this request",
    arguments: { ...(kind === "skill" ? { name: "Before" } : { slug: "Old/Before" }), ...args },
  });
  const steps = [step("deny-before", "note", "deny", { tags: ["denied-first"] })];
  for (const kind of Object.keys(u.areas)) {
    steps.push(step(`${kind}-content`, kind, "update", { content: contents[kind] }));
    steps.push(step(`${kind}-metadata`, kind, "update", { tags: ["inplace-verified"] }));
  }
  for (const [kind, reference] of Object.entries({
    note: '<img src="../Private/_assets/unreviewed.BIN?html=1#refused">',
    skill: "[unreviewed]: <../Private/_assets/unreviewed.BIN?definition=1#refused>",
    paper: 'file: "../Private/_assets/unreviewed.BIN?file=1#refused"',
  })) steps.push(step(`${kind}-new-uri`, kind, "refuse", { content: contents[kind] + "\n" + reference + "\n" }));
  steps.push(step("deny-after", "note", "deny", { tags: ["denied-after"] }));
  return steps;
}
async function directories(root) {
  const result = [];
  async function walk(path, relative) {
    const stat = await lstat(path); assert(stat.isDirectory() && !stat.isSymbolicLink());
    result.push({ path: relative, identity: identity(stat) });
    for (const name of (await readdir(path)).sort()) if ((await lstat(join(path, name))).isDirectory()) await walk(join(path, name), `${relative}/${name}`);
  }
  for (const area of Object.values(u.areas)) await walk(join(root, area, "Private"), `${area}/Private`);
  return result;
}
/** Same-path Upsert oracle increments revisions; raw shared writer's supplied revision is not Native canonical semantics. */
export async function prepareInstalledNativePrivateInplaceFixture({ installed, componentFixture, legacyVsix, python }) {
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (states.has(componentFixture)) fail("PRIVATE_INPLACE_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    join(componentFixture.root, "core.sqlite"), join(componentFixture.root, ".pkm-next-original-mcp.json")])
    await u.absent(path, "PRIVATE_INPLACE_PRESEAL_REQUIRED");
  if (!isAbsolute(python ?? "")) fail("PRIVATE_INPLACE_EXPLICIT_PYTHON_REQUIRED");
  const policyPath = join(componentFixture.root, ".pkm/content-privacy.json"), stat = await lstat(policyPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077)
    fail("PRIVATE_INPLACE_INDEPENDENT_PRIVACY_REQUIRED");
  const privacyBytes = await readFile(policyPath);
  assert.deepEqual(JSON.parse(privacyBytes), installedNativeKnowledgeMovePrivacyPolicy, "Independently configure exact Private areas.");
  for (const area of Object.values(u.areas)) {
    await mkdir(join(componentFixture.root, area), { recursive: true, mode: 0o700 });
    for (const path of ["Old", "New", "Private"]) await u.absent(join(componentFixture.root, area, path), "PRIVATE_INPLACE_DISJOINT_SEED_REQUIRED");
  }
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: componentFixture.directory, legacyVsix, python });
  const rows = writer.run(componentFixture.root, seedOriginalPrivateResourcePublication);
  writer.run(componentFixture.root, `
    for(const [kind,area] of [["note","notes"],["skill","skills"],["paper","papers"]]){
      const content="Private unreviewed owner\\n![owned](_assets/unreviewed.BIN)\\n";
      store[kind+"Upsert"]({slug:"Private/Unreviewed",title:"Unreviewed",name:"Unreviewed",category:"Private",type:"general",content});
      const bytes=Buffer.from("PRIVATE_INPLACE_UNREVIEWED_BYTES");
      assets.importMarkdownAssetBundle(root,[{type:area,path:"Private/_assets/unreviewed.BIN",data:bytes.toString("base64"),
        digest:"sha256:"+require("node:crypto").createHash("sha256").update(bytes).digest("hex")}],
        [{area,path:"Private/Unreviewed.md",content}]);
    }
    return true;
  `);
  assert.deepEqual(await readFile(policyPath), privacyBytes);
  const baseline = await u.files(componentFixture.root), privateDirectories = await directories(componentFixture.root);
  const contents = Object.fromEntries(Object.entries(rows).map(([kind, row]) => [kind,
    row.content.replace("Original private-resource owner", "Installed same-path body")
      .replace("../Private/_assets/a.PNG?q=1#view", "../%50rivate/_assets/./a.PNG?inplace=1#same")
      + "\nPrivate is ordinary prose.\n`![ignored](../Private/_assets/unreviewed.BIN)`\n"
      + "~~~md\nfile: ../Private/_assets/unreviewed.BIN\n~~~\n"]));
  const steps = installedNativePrivateInplaceSteps(contents), oracle = join(componentFixture.directory, "original-private-inplace-oracle");
  await cp(componentFixture.root, oracle, { recursive: true, force: false, errorOnExist: true });
  const expected = {};
  for (const step of steps.filter(step => step.outcome === "update")) expected[step.stage] = writer.run(oracle, `
    const before=store[input.kind+"Get"](input.kind==="skill"?"Before":"Old/Before");
    store[input.kind+"Upsert"]({...before,tags:input.args.tags??(typeof before.tags==="string"?JSON.parse(before.tags):before.tags),
      content:input.args.content??before.content});
    return store[input.kind+"Get"](input.kind==="skill"?"Before":"Old/Before");
  `, { kind: step.kind, args: step.arguments });
  for (const file of baseline.filter(file => !/^(notes|skills|papers)\/Old\/Before\.md$/.test(file.path)))
    assert.deepEqual(await readFile(join(oracle, file.path)), file.bytes);
  const value = Object.freeze({ kind: "pkm.installed-native-private-inplace-fixture/v1", root: componentFixture.root,
    originalPackageSha256: writer.originalPackageSha256, privacySha256: u.hash(privacyBytes),
    originalSamePathDoesNotPublish: true, originalUpsertRevisionIncrementObserved: true, files: Object.freeze(u.hashes(baseline).map(Object.freeze)) });
  const state = { installed, componentFixture, baseline, privacyBytes, privateDirectories, rows, expected, steps, phase: "prepared" };
  states.set(componentFixture, state); states.set(value, state); return value;
}
async function unchanged(state, root) {
  assert.deepEqual(sorted((await u.files(root, true)).filter(file => !/^(notes|skills|papers)\/Old\/Before\.md$/.test(file.path))), state.controls);
  assert.deepEqual(await directories(root), state.privateDirectories);
  await u.unchangedOriginalControls(state, root);
}
function commitment(db, receipt, workspaceId) {
  const raw = db.prepare("SELECT * FROM migration_runtime_knowledge_commits WHERE operation_id=?").get(receipt.operation_id); assert(raw);
  const row = { ...raw }, request = JSON.parse(row.request_json), plan = JSON.parse(row.plan_json);
  assert.equal(row.workspace_id, workspaceId); assert.equal(row.operation_id, receipt.operation_id);
  assert.equal(row.digest, u.hash(JSON.stringify([row.sequence, row.workspace_id, row.operation_id, row.request_json, row.plan_json, row.result_json])));
  assert.equal(row.result_json, receipt.result); assert.equal(request.actorId, "mcp:external"); assert.equal(request.operation, receipt.operation);
  assert.equal(request.args.operationId, receipt.operation_id); assert.equal(plan.operationId, receipt.operation_id);
  assert.equal(plan.relocation, undefined, "A regular in-place receipt cannot carry private publication or a move.");
  assert.equal(request.args.moveTo, undefined);
  return { row, request, plan };
}
/** Public-only observer; unchanged resources and publication-free actual commit plans corroborate zero method-24 activity. */
export async function verifyInstalledNativePrivateInplace({ root, installed, component, sourceFixture, payloadBuildId, python, env, port, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "prepared") fail("PRIVATE_INPLACE_VERIFY_ORDER_REQUIRED");
  if (state.installed !== installed || component.fixture !== state.componentFixture) fail("PRIVATE_INPLACE_SAME_COMPONENT_REQUIRED");
  const { host } = await assertInstalledKnowledgeMoveComponentBinding({ root, installed, component, componentFixture: state.componentFixture, payloadBuildId });
  assert.equal(host.nativeChat, undefined);
  for (const provider of ["vscode", "openai-compatible", "azure-openai"]) assert.equal(host.options.providerTransport.supports(provider), false);
  const markdown = await u.load(installed, "markdown"), mutations = await u.load(installed, "knowledge-mutations");
  const initial = await u.files(component.root, true);
  state.controls = sorted(initial.filter(file => !/^(notes|skills|papers)\/Old\/Before\.md$/.test(file.path)));
  assert.deepEqual(sorted(initial.filter(file => file.path.includes("/Private/"))), sorted(state.baseline.filter(file => file.path.includes("/Private/"))));
  state.b0Sha256 = component.b0.sha256; state.workspaceId = component.workspaceId;
  const lease = { ...component.owner.workspaceLease() }, abort = new AbortController(), runId = randomUUID();
  await writeFile(join(root, "native-private-inplace-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-private-inplace-ui/v1", runId, binding: { root: component.root, workspaceId: component.workspaceId }, steps: state.steps,
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativePrivateInplaceUi({ root, python, env, port, runId, timeoutMs }); void ui.done.catch(error => abort.abort(error));
  const check = () => { if (ui.error) throw ui.error; host.assertCurrent(); component.storage.assertWorkspaceLease(); assert.deepEqual({ ...component.owner.workspaceLease() }, lease); };
  const receipts = [], commits = [], outcomes = [];
  try {
    await ui.ready; check(); await unchanged(state, component.root);
    for (const step of state.steps) {
      const before = u.hashes(await u.files(component.root, true)), journal = u.liveJournal(component); assert.equal(journal.intents.length, 0);
      await writeFile(join(root, "progress.json"), JSON.stringify({ stage: step.stage }), { mode: 0o600 });
      if (step.outcome !== "update") {
        let failure;
        try { const response = await component.invoke(step.tool, step.arguments, abort.signal); noPrivateBytes(response);
          if (response.isError) failure = Object.assign(new Error(JSON.stringify(response)), { code: response.structuredContent?.code }); }
        catch (error) { failure = error; }
        assert(failure, "Expected public denial/new URI refusal.");
        assert.equal(failure.code, "ACCESS_DENIED"); noPrivateBytes({ message: failure.message });
        if (step.outcome === "refuse") assert(!failure.message.includes("Private/_assets") && !failure.message.includes(component.root), "New-private-source denial must remain generic.");
        assert.deepEqual(u.hashes(await u.files(component.root, true)), before); assert.deepEqual(u.liveJournal(component), journal);
        outcomes.push({ stage: step.stage, code: failure.code }); await unchanged(state, component.root); continue;
      }
      const response = await component.invoke(step.tool, step.arguments, abort.signal); noPrivateBytes(response); assert.notEqual(response.isError, true);
      assert.deepEqual(response.structuredContent ?? JSON.parse(response.content[0].text),
        step.kind === "skill" ? { ok: true, name: "Before" } : { ok: true, slug: "Old/Before" });
      const document = markdown.scanMarkdown(component.root).find(row => row.record.area === u.areas[step.kind] && row.record.path === "Old/Before.md"); assert(document);
      const expected = state.expected[step.stage];
      assert.equal(document.record.id, state.rows[step.kind].knowledgeId); assert.equal(document.record.revision, expected.revision);
      assert.equal(document.record.content, expected.content); assert.equal(document.metadata.get("knowledgeId"), expected.knowledgeId);
      assert.deepEqual([...document.metadata.toJS().aliases].sort(), [...expected.aliases].sort());
      if (step.kind === "paper") assert.equal(document.metadata.get("file"), expected.file);
      const current = u.liveJournal(component), ids = new Set(journal.receipts.map(row => row.operation_id));
      const added = current.receipts.filter(row => !ids.has(row.operation_id)); assert.equal(added.length, 1); assert.equal(current.intents.length, 0);
      const receipt = { ...added[0] }, value = JSON.parse(receipt.result);
      assert.equal(receipt.actor_id, "mcp:external"); assert.equal(value.path, "Old/Before.md"); assert.equal(value.id, document.record.id);
      assert.equal(value.operationId, receipt.operation_id); assert.equal(value.sha256, document.record.sha256); assert.equal(value.revision, document.record.revision);
      noPrivateBytes(value);
      const db = component.storage.connectNative(); let committed;
      try { committed = commitment(db, receipt, component.workspaceId); } finally { db.close(); }
      await component.storage.withWorkspaceExclusive(() => mutations.assertKnowledgeMutationRequestPlan(component.root,
        mutations.deserializeKnowledgeMutationPlan(committed.row.plan_json), committed.request));
      receipts.push(receipt); commits.push(committed.row); outcomes.push({ stage: step.stage, operationId: receipt.operation_id });
      const read = await component.invoke(`get_${step.kind}`, step.kind === "skill" ? { name: "Before" } : { slug: "Old/Before" }, abort.signal);
      noPrivateBytes(read); assert.notEqual(read.isError, true);
      assert.equal((read.structuredContent ?? JSON.parse(read.content[0].text)).content, document.record.content);
      await unchanged(state, component.root); check();
    }
    assert.equal(receipts.length, 6); noPrivateBytes(markdown.scanMarkdown(component.root).map(row => ({ ...row.record })));
    for (const area of Object.values(u.areas)) await u.absent(join(component.root, area, "New"), "PRIVATE_INPLACE_UNEXPECTED_MOVE_OR_RESOURCE_COPY");
    await writeFile(join(root, "progress.json"), JSON.stringify({ stage: "native-private-inplace-complete" }), { mode: 0o600 });
    await ui.done; check();
    const proof = JSON.parse(await readFile(join(root, "native-private-inplace-ui-passed.json")));
    assert.equal(proof.passed, true); assert.equal(proof.actualRenderedDom, true); assert.equal(proof.runId, runId);
    assert.equal(proof.observedPrivateResourceDialogs, 0);
    assert.deepEqual(proof.dialogs.map(({ stage, choice }) => ({ stage, choice })), state.steps.map(({ stage, choice }) => ({ stage, choice })));
    state.receipts = receipts; state.commits = commits; state.b1Knowledge = u.hashes(await u.files(component.root, true));
    const evidence = { passed: true, scope: "regular synthetic same-path updates only; no private publication",
      actualNativeUi: true, publicDialogCount: 11, observedPrivateResourceDialogs: 0, privatePublicationPlansOrGrantsAdopted: 0,
      resourceCopies: 0, sixCanonicalInplaceReceipts: true, newPrivateUriDeniedBeforeIntent: true, storedPrivateLinkTextPermitted: true,
      privateBytesReferrersFoldersPairsPolicyUnchanged: true, originalUpsertAndNativeRevisionIncrement: true, rawWriterRevisionRuleNotAdopted: true,
      ignoredParserTextAndNormalizedExistingRefsPreserved: true, modelChannelUnavailable: true, sourcePerturbationUsed: false,
      mutationReplayAttempted: false, fullCutoverQualified: false, b1AndB0Qualified: false, originalPackageSha256: sourceFixture.originalPackageSha256, outcomes };
    await writeFile(join(root, "native-private-inplace-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
    state.phase = "verified"; return evidence;
  } finally { abort.abort(); await ui.stop(); if (state.phase !== "verified") state.phase = "failed"; }
}
function verified(value) { const state = stateFor(value); if (state.phase !== "verified") fail("PRIVATE_INPLACE_VERIFIED_EFFECTS_REQUIRED"); return state; }
export async function verifyInstalledNativePrivateInplaceB1(sourceFixture, { retirement }) {
  const state = verified(sourceFixture);
  await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 }, retirement);
  assert.deepEqual(u.hashes(await u.files(retirement.archive, true)), state.b1Knowledge); await unchanged(state, retirement.archive);
  const db = new DatabaseSync(join(retirement.archive, "core.sqlite"), { readOnly: true });
  try {
    const journal = u.readJournal(db); assert.equal(journal.intents.length, 0);
    for (const receipt of state.receipts) {
      assert.deepEqual({ ...journal.receipts.find(row => row.operation_id === receipt.operation_id) }, receipt);
      assert.deepEqual(commitment(db, receipt, state.workspaceId).row, state.commits.find(row => row.operation_id === receipt.operation_id));
    }
  } finally { db.close(); }
  return { regularInplaceB1PrivateControlsAndSixNonpublicationReceiptsPreserved: true };
}
export async function verifyInstalledNativePrivateInplaceRestored(sourceFixture, { retirement, restored }) {
  const state = verified(sourceFixture), b1 = await verifyInstalledNativePrivateInplaceB1(sourceFixture, { retirement });
  const expected = { componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 };
  const retired = await readInstalledKnowledgeMoveRetirementReceipt(expected, retirement);
  await readInstalledKnowledgeMoveRestoredReceipt(expected, retirement, restored, retired);
  assert.deepEqual(u.hashes(await u.files(restored.root)), u.hashes(state.baseline));
  for (const path of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-workspace", ".pkm-next-original-mcp.json", ".pkm-native"])
    await u.absent(join(restored.root, path), "PRIVATE_INPLACE_B0_NATIVE_STATE_OR_GRANT");
  return { ...b1, allOriginalInplaceB0BytesRestored: true, freshB0NoNativeDatabaseOrGrant: true, originalRootOverwritten: false, fullCutoverQualified: false };
}
