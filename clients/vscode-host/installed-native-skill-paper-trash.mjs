import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { pinnedOriginalKnowledgeWriterFixture } from "../../tests/original-knowledge-writer-fixture.mjs";
import {
  installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u,
  assertInstalledKnowledgeMoveComponentBinding, readInstalledKnowledgeMoveRetirementReceipt,
  readInstalledKnowledgeMoveRestoredReceipt,
} from "./installed-native-knowledge-move.mjs";
import { installedNativeTrashCanonicalRequest } from "./installed-native-trash.mjs";
import { createInstalledNativeSkillPaperTrashStageProtocol, startInstalledNativeSkillPaperTrashUi } from "./installed-native-skill-paper-trash-ui.mjs";

const states = new WeakMap(), pairBytes = Buffer.from([255, 0, 128, 9]);
export const installedNativeSkillPaperTrashPrivacyPolicy = installedNativeKnowledgeMovePrivacyPolicy;
export const installedNativeSkillPaperTrashOwners = Object.freeze([
  { area: "skills", kind: "skill", name: "SkillTrashOwner", path: "SkillPaperTrash/SkillTrashOwner.md",
    pairPath: "SkillPaperTrash/SkillTrashOwner.assets", metadataName: "SkillTrashOwner",
    arguments: { name: "SkillTrashOwner" } },
  { area: "papers", kind: "paper", name: "PaperTrashOwner", path: "SkillPaperTrash/PaperTrashOwner.md",
    pairPath: "SkillPaperTrash/PaperTrashOwner.assets", metadataName: "PaperTrashOwner.md",
    arguments: { slug: "SkillPaperTrash/PaperTrashOwner" } },
].map(row => Object.freeze({ ...row, arguments: Object.freeze(row.arguments) })));
export const installedNativeSkillPaperTrashStages = Object.freeze(installedNativeSkillPaperTrashOwners.flatMap(owner => {
  const { area, kind, arguments: args } = owner, prefix = `native-${kind}-trash`;
  const shared = kind === "skill" ? { name: "SkillTrashShared" } : { slug: "SkillPaperTrash/PaperTrashShared" };
  return [
    { stage: `${prefix}-public-deny`, publicChoice: "Deny", code: "ACCESS_DENIED" },
    { stage: `${prefix}-target-deny`, publicChoice: "Approve this request", action: "move", choice: "Deny", code: "ORIGINAL_TRASH_DENIED" },
    { stage: `${prefix}-shared`, publicChoice: "Approve this request", arguments: shared, code: "CONFLICT" },
    { stage: `${prefix}-delete`, publicChoice: "Approve this request", action: "move", choice: `Move this exact ${kind === "skill" ? "Skill" : "Paper"} to Trash once` },
    ...(kind === "paper" ? [{ stage: `${prefix}-list-papers`, tool: "list_papers", arguments: Object.freeze({}),
      publicChoice: "Approve this request" }] : []),
    { stage: `${prefix}-list`, action: "list", choice: `Read these exact ${kind === "skill" ? "Skill" : "Paper"} Trash entries once` },
    { stage: `${prefix}-restore-deny`, action: "restore", choice: "Deny", code: "ORIGINAL_TRASH_DENIED" },
    { stage: `${prefix}-stale`, noReview: true, code: "CONFLICT" },
    { stage: `${prefix}-restore`, action: "restore", choice: `Restore this exact ${kind === "skill" ? "Skill" : "Paper"} once` },
    { stage: `${prefix}-replay`, noReview: true },
    { stage: `${prefix}-missing`, noReview: true, code: "NOT_FOUND" },
    { stage: `${prefix}-restored-list`, action: "list", choice: `Read these exact ${kind === "skill" ? "Skill" : "Paper"} Trash entries once` },
  ].map(step => Object.freeze({ area, ...(step.publicChoice ? { tool: `delete_${kind}`, arguments: args } : {}), ...step }));
}));
const seed = `
  const rows=[];
  for(const [kind,area,label] of [["skill","skills","Skill"],["paper","papers","Paper"]]){
    for(const role of ["Owner","Shared","Archived"]){
      const name=label+"Trash"+role,slug="SkillPaperTrash/"+name;
      store[kind+"Upsert"]({slug,name,title:name,category:"SkillPaperTrash",type:"general",tags:["trash-fixture"],
        content:"DISPOSABLE_PUBLIC_SKILL_PAPER_"+role+"\\r\\n![pair]("+name+".assets/opaque.bin?q=1#view)\\r\\n"});
      assets.saveMarkdownAsset(root,area,slug+".md","opaque.bin",Buffer.from([255,0,128,9]));
      if(role==="Owner"){
        const key=kind==="skill"?name:slug,first=store[kind+"Get"](key);
        store[kind+"Upsert"]({...first,tags:first.tags,content:first.content+"Revision two.\\r\\n"});
      }
    }
    store[kind+"Upsert"]({slug:"Private/"+label+"TrashSentinel",name:label+"TrashSentinel",title:label+"TrashSentinel",
      category:"Private",type:"general",content:"DISPOSABLE_PRIVATE_SKILL_PAPER\\n![shared](../SkillPaperTrash/"+label+"TrashShared.assets/opaque.bin)\\n"});
    const prior=store.knowledgePathMoveToTrash(area,"SkillPaperTrash/"+label+"TrashArchived.md");
    rows.push({kind,area,owner:store[kind+"Get"](kind==="skill"?label+"TrashOwner":"SkillPaperTrash/"+label+"TrashOwner"),prior});
  }
  return rows;
`;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value, phase) {
  const state = states.get(value);
  if (!state) fail("INSTALLED_SKILL_PAPER_TRASH_ACTUAL_PREPARATION_REQUIRED");
  if (phase && state.phase !== phase) fail("INSTALLED_SKILL_PAPER_TRASH_VERIFIED_PHASE_REQUIRED");
  return state;
}
function result(response) {
  u.noPrivatePublication(response);
  assert(!JSON.stringify(response).includes("DISPOSABLE_PRIVATE_SKILL_PAPER"));
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return response.structuredContent ?? JSON.parse(response.content[0].text);
}
function live(component) {
  const database = component.storage.connectNative();
  try {
    return Object.fromEntries([
      ["intents", "SELECT * FROM migration_runtime_intents ORDER BY operation_id"],
      ["receipts", "SELECT * FROM receipts WHERE operation GLOB 'knowledge.trash.*' ORDER BY operation_id"],
      ["successors", "SELECT * FROM original_native_trash_commits ORDER BY sequence"],
    ].map(([key, sql]) => [key, database.prepare(sql).all().map(row => ({ ...row }))]));
  } finally { database.close(); }
}
async function snapshot(component, custody) {
  const files = await u.files(component.root, true), dirs = new Set(["notes", "skills", "papers", ".pkm", ".pkm/state"]);
  const walk = async path => {
    dirs.add(path);
    for (const name of (await readdir(join(component.root, path))).sort())
      if ((await lstat(join(component.root, path, name))).isDirectory()) await walk(`${path}/${name}`);
  };
  for (const area of ["notes", "skills", "papers"]) await walk(area);
  return { files, directories: [...dirs].sort().map(path => custody.originalTrashIdentity(component.root, path)),
    history: custody.originalTrashIdentity(component.root, ".pkm/state/knowledge-deletions.json"), journal: live(component) };
}
export async function prepareInstalledNativeSkillPaperTrashFixture({ installed, componentFixture, legacyVsix, python }) {
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (states.has(componentFixture)) fail("INSTALLED_SKILL_PAPER_TRASH_ALREADY_PREPARED");
  for (const path of ["core.sqlite", ".pkm-next-original-mcp.json"])
    await u.absent(join(componentFixture.root, path), "INSTALLED_SKILL_PAPER_TRASH_PRE_B0_REQUIRED");
  for (const path of ["b0", "custody"])
    await u.absent(join(componentFixture.directory, path), "INSTALLED_SKILL_PAPER_TRASH_PRE_B0_REQUIRED");
  if (!isAbsolute(python ?? "")) fail("INSTALLED_SKILL_PAPER_TRASH_EXPLICIT_PYTHON_REQUIRED");
  const privacyPath = join(componentFixture.root, ".pkm/content-privacy.json"), stat = await lstat(privacyPath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077));
  const privacy = await readFile(privacyPath);
  assert.deepEqual(JSON.parse(privacy), installedNativeSkillPaperTrashPrivacyPolicy, "Parent must independently configure exact Private top levels.");
  for (const area of ["notes", "skills", "papers"]) await mkdir(join(componentFixture.root, area), { recursive: true, mode: 0o700 });
  for (const owner of installedNativeSkillPaperTrashOwners) {
    await u.absent(join(componentFixture.root, owner.area, "SkillPaperTrash"), "INSTALLED_SKILL_PAPER_TRASH_DISJOINT_SEED_REQUIRED");
    await u.absent(join(componentFixture.root, owner.area, `Private/${owner.kind === "skill" ? "Skill" : "Paper"}TrashSentinel.md`),
      "INSTALLED_SKILL_PAPER_TRASH_DISJOINT_SEED_REQUIRED");
  }
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: componentFixture.directory, legacyVsix, python });
  const rows = writer.run(componentFixture.root, seed);
  assert.deepEqual(await readFile(privacyPath), privacy);
  const baseline = await u.files(componentFixture.root);
  const history = await readFile(join(componentFixture.root, ".pkm/state/knowledge-deletions.json"));
  const oracleRoot = join(componentFixture.directory, "skill-paper-trash-oracle");
  await cp(componentFixture.root, oracleRoot, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  const owners = [];
  for (const [index, owner] of installedNativeSkillPaperTrashOwners.entries()) {
    const raw = await readFile(join(componentFixture.root, owner.area, owner.path)), row = rows[index].owner;
    const key = owner.kind === "skill" ? owner.name : owner.path.slice(0, -3);
    const original = writer.run(oracleRoot, `const before=store[input.kind+"Get"](input.key);
      const entry=store.knowledgePathMoveToTrash(input.area,input.path);
      const restored=input.kind==="skill"?store.skillTrashRestore(entry.id):store.knowledgeTrashRestore(input.area,entry.id);
      return {before,entry,restored,after:store[input.kind+"Get"](input.key)};`, { ...owner, key });
    assert.deepEqual(original.before, original.after); assert.deepEqual(original.restored, { ok: true, path: owner.path });
    assert.equal(original.entry.kind, owner.kind === "skill" ? "skill" : "item");
    assert.equal(original.entry.name, owner.metadataName); assert.equal(row.revision, 2);
    assert.deepEqual(await readFile(join(oracleRoot, owner.area, owner.path)), raw);
    owners.push(Object.freeze({ ...owner, id: row.knowledgeId, knowledgeId: row.knowledgeId,
      revision: row.revision, sha256: u.hash(raw), original: Object.freeze({ ...row }) }));
  }
  assert.deepEqual(await readFile(join(oracleRoot, ".pkm/state/knowledge-deletions.json")), history);
  const value = Object.freeze({ kind: "pkm.installed-native-skill-paper-trash-fixture/v1", root: componentFixture.root,
    originalPackageSha256: writer.originalPackageSha256, privacySha256: u.hash(privacy), owners: Object.freeze(owners),
    priorEntries: Object.freeze(rows.map(row => Object.freeze({ area: row.area, id: row.prior.id }))),
    oldReadonlyBucketRestoreQualified: false, files: Object.freeze(u.hashes(baseline).map(Object.freeze)) });
  const state = { installed, componentFixture, value, baseline, history, privacy, phase: "prepared" };
  states.set(componentFixture, state); states.set(value, state); return value;
}
async function preservation(state, root) {
  assert(state.protectedFiles, "Lifecycle controls must be captured after the Parent's verified prelude.");
  for (const file of state.protectedFiles) {
    if (file.path === ".pkm/state/knowledge-deletions.json"
      || state.value.owners.some(owner => file.path === `${owner.area}/${owner.path}` || file.path.startsWith(`${owner.area}/${owner.pairPath}/`))) continue;
    assert.deepEqual(await readFile(join(root, file.path)), file.bytes);
  }
}
export async function verifyInstalledNativeSkillPaperTrash({ root, installed, component, sourceFixture, payloadBuildId,
  python, env, port, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture, "prepared");
  if (state.installed !== installed || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_SKILL_PAPER_TRASH_SAME_COMPONENT_REQUIRED");
  if (typeof component.invokeCanonical !== "function") fail("INSTALLED_SKILL_PAPER_TRASH_ACTUAL_CANONICAL_COMPONENT_REQUIRED");
  const { host, full } = await assertInstalledKnowledgeMoveComponentBinding({ root, installed, component,
    componentFixture: state.componentFixture, payloadBuildId });
  assert.equal(full.runtime.services.modelProvider, undefined); assert.equal(host.nativeChat, undefined);
  for (const provider of ["vscode", "openai-compatible", "azure-openai"]) assert.equal(host.options.providerTransport.supports(provider), false);
  const contracts = await u.load(installed, "original-native-trash-contracts");
  const catalog = (await u.load(installed, "native-public-original-mcp-contracts")).originalPublicMcpContracts();
  assert.equal(catalog.provenance.metadataSha256, host.receipt.sourceCatalogSha256);
  for (const [tool, readOnly] of [["get_skill", true], ["get_paper", true], ["list_skills", true], ["list_papers", false]])
    assert.equal(catalog.contracts.find(contract => contract.transportName === tool)?.readOnly, readOnly,
      "This exact installed catalog determines the separate public approval stages.");
  const publicContracts = [...new Set(installedNativeSkillPaperTrashStages.filter(step => step.publicChoice).map(step => step.tool))]
    .map(tool => {
      const contract = catalog.contracts.find(contract => contract.transportName === tool); assert(contract);
      return { tool, operation: contract.id, version: contract.version, readOnly: contract.readOnly };
    });
  const native = await u.load(installed, "original-native-trash-native");
  const planning = await u.load(installed, "original-native-trash-planning");
  const lifecycle = await u.load(installed, "trash-lifecycle");
  const markdown = await u.load(installed, "markdown");
  const custody = await u.load(installed, "original-native-trash-custody");
  const rootApi = await u.load(installed, "original-mcp-root");
  assert(native.getNativeOriginalTrashPort(component.storage, host));
  const knowledge = await u.files(component.root, true);
  for (const file of state.baseline.filter(file => file.path.includes("/Private/")
    || file.path.includes("/SkillPaperTrash/") || sourceFixture.priorEntries.some(entry => file.path.startsWith(`${entry.area}/.trash/${entry.id}/`))))
    assert.deepEqual(await readFile(join(component.root, file.path)), file.bytes);
  const originalControls = state.baseline.filter(file => !["notes", "skills", "papers"].includes(file.path.split("/")[0]));
  for (const file of originalControls) assert.deepEqual(await readFile(join(component.root, file.path)), file.bytes);
  // Prelude-owned public changes are protected from this phase onward; B0 remains the original image.
  state.protectedFiles = [...knowledge, ...originalControls];
  const binding = { root: component.root, workspaceId: component.workspaceId, catalogSha256: host.receipt.sourceCatalogSha256,
    profileSha256: host.receipt.profileSha256, custodyPlanSha256: component.custody.planSha256,
    privacySha256: component.custody.privacySha256, epoch: host.receipt.epoch, nativeHostReceiptSha256: host.receipt.receiptSha256 };
  const lease = { ...component.owner.workspaceLease() }, runId = randomUUID(), abort = new AbortController();
  state.b0Sha256 = component.b0.sha256;
  assert.deepEqual(live(component), { intents: [], receipts: [], successors: [] });
  await writeFile(join(root, "native-skill-paper-trash-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-skill-paper-trash-ui/v1", runId, binding,
    originalPackageSha256: sourceFixture.originalPackageSha256, owners: sourceFixture.owners, stages: installedNativeSkillPaperTrashStages,
    publicContracts,
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativeSkillPaperTrashUi({ root, python, env, port, runId, timeoutMs });
  void ui.done.catch(error => abort.abort(error));
  const check = async () => {
    if (ui.error) throw ui.error;
    host.assertCurrent(); component.storage.assertWorkspaceLease();
    assert.deepEqual({ ...component.owner.workspaceLease() }, lease);
    const current = await component.owner.ensureFull(); assert.equal(current.runtime.core, full.runtime.core);
    await preservation(state, component.root);
    await component.storage.withWorkspaceExclusive(() => rootApi.validateOriginalMcpWorkspace(component.root));
  };
  const protocol = await createInstalledNativeSkillPaperTrashStageProtocol({ root, runId, timeoutMs,
    stages: installedNativeSkillPaperTrashStages.map(step => step.stage), check() {
      if (ui.error) throw ui.error;
      abort.signal.throwIfAborted(); host.assertCurrent(); component.storage.assertWorkspaceLease();
    } });
  const progress = (stage, data = {}) => protocol.begin(stage, data);
  const complete = async stage => { await check(); await protocol.complete(stage); };
  const canonical = (operation, args) => {
    const request = installedNativeTrashCanonicalRequest(operation, args);
    return component.invokeCanonical(request.name, request.input, abort.signal);
  };
  const noEffects = async (step, invoke) => {
    const before = await snapshot(component, custody); let error;
    try {
      const response = await invoke(); u.noPrivatePublication(response);
      assert(!JSON.stringify(response).includes("DISPOSABLE_PRIVATE_SKILL_PAPER"));
      if (response.isError) error = { code: response.structuredContent?.code };
    }
    catch (value) { error = value; }
    assert.equal(error?.code, step.code);
    assert.deepEqual(await snapshot(component, custody), before); await check();
    return { stage: step.stage, code: error.code, noEffects: true };
  };
  const outcomes = [], entries = new Map(), restores = new Map();
  try {
    await ui.ready; await check();
    for (const step of installedNativeSkillPaperTrashStages) {
      const owner = sourceFixture.owners.find(row => row.area === step.area);
      await check();
      if (step.tool === "list_papers") {
        await progress(step.stage);
        const listed = result(await component.invoke(step.tool, step.arguments, abort.signal));
        assert(!JSON.stringify(listed).includes(owner.name));
        outcomes.push({ stage: step.stage, separateCatalogMutatingPublicListApproved: true });
        await complete(step.stage); continue;
      }
      if (step.publicChoice) {
        const db = component.storage.connectNative(); let predecessor;
        try { predecessor = custody.originalTrashPredecessor(db, component.custody.planSha256); } finally { db.close(); }
        await progress(step.stage, { owner, inventory: [
          ...custody.originalTrashTree(component.root, `${owner.area}/${owner.pairPath}`),
          ...custody.originalTrashTree(component.root, `${owner.area}/${owner.path}`),
        ], predecessorSha256: predecessor, history: JSON.parse(await readFile(join(component.root, ".pkm/state/knowledge-deletions.json"))),
        removedPaths: [`${owner.area}/${owner.path}`, `${owner.area}/${owner.pairPath}/opaque.bin`] });
        const invoke = () => component.invoke(step.tool, step.arguments, abort.signal);
        if (step.code) { outcomes.push(await noEffects(step, invoke)); await complete(step.stage); continue; }
        const deleted = result(await invoke()), entry = deleted.trash; assert.equal(deleted.ok, true);
        const raw = state.baseline.find(file => file.path === `${owner.area}/${owner.path}`).bytes;
        assert.equal(entry.kind, owner.kind === "skill" ? "skill" : "item"); assert.equal(entry.name, owner.metadataName);
        assert.deepEqual(await readFile(join(component.root, owner.area, ".trash", entry.id, "payload")), raw);
        assert.deepEqual(await readFile(join(component.root, owner.area, ".trash", entry.id, "assets/opaque.bin")), pairBytes);
        await u.absent(join(component.root, owner.area, owner.path), "INSTALLED_SKILL_PAPER_TRASH_SOURCE_REMAINED");
        await u.absent(join(component.root, owner.area, owner.pairPath), "INSTALLED_SKILL_PAPER_TRASH_PAIR_REMAINED");
        const missing = await component.invoke(`get_${owner.kind}`, owner.arguments, abort.signal);
        assert.match(missing.content.filter(row => row.type === "text").map(row => row.text).join(""), /not found/i);
        if (owner.kind === "skill")
          assert(!JSON.stringify(result(await component.invoke("list_skills", {}, abort.signal))).includes(owner.name));
        entries.set(owner.area, entry); outcomes.push({ stage: step.stage, entryId: entry.id }); await complete(step.stage); continue;
      }
      const entry = entries.get(owner.area);
      if (step.noReview) {
        await progress(step.stage);
        const args = restores.get(owner.area) ?? { operationId: randomUUID(), entryId: entry.id,
          expectedScanRevision: lifecycle.previewTrashRestoreRevision(component.root) };
        if (step.stage.endsWith("-stale")) {
          outcomes.push(await noEffects(step, () => canonical("knowledge.trash.restore", {
            ...args, expectedScanRevision: u.hash(`stale:${args.expectedScanRevision}`),
          }))); await complete(step.stage); continue;
        }
        if (step.stage.endsWith("-missing")) {
          outcomes.push(await noEffects(step, () => canonical("knowledge.trash.restore", { ...args, operationId: randomUUID() })));
          await complete(step.stage); continue;
        }
        const before = await snapshot(component, custody), replay = result(await canonical("knowledge.trash.restore", args));
        assert.equal(replay.operationId, args.operationId); assert.deepEqual(await snapshot(component, custody), before);
        outcomes.push({ stage: step.stage, replayNoEffects: true }); await complete(step.stage); continue;
      }
      const operation = `knowledge.trash.${step.action}`, args = step.action === "list"
        ? { area: owner.area, entryIds: step.stage.endsWith("-restored-list") ? [] : [entry.id], operationId: randomUUID() }
        : { entryId: entry.id, operationId: randomUUID(), expectedScanRevision: lifecycle.previewTrashRestoreRevision(component.root) };
      const prepared = await planning.prepareOriginalTrashOperation(component.storage, host, { operation, actorId: "mcp:external", args });
      await progress(step.stage, { subject: prepared.subject, arguments: args });
      if (step.code) { outcomes.push(await noEffects(step, () => canonical(operation, args))); await complete(step.stage); continue; }
      const response = result(await canonical(operation, args));
      if (step.action === "list") assert.deepEqual(response.items.map(row => row.id), args.entryIds);
      else {
        restores.set(owner.area, args);
        assert.equal(response.action, "restore"); assert.equal(response.area, owner.area); assert.equal(response.entryId, entry.id);
        const raw = await readFile(join(component.root, owner.area, owner.path));
        assert.equal(u.hash(raw), owner.sha256);
        assert.deepEqual(await readFile(join(component.root, owner.area, owner.pairPath, "opaque.bin")), pairBytes);
        const decoded = markdown.decodeMarkdown(owner.id, raw.toString("utf8"), owner.path, owner.area);
        assert.equal(decoded.metadata.get("knowledgeId"), owner.knowledgeId); assert.equal(decoded.record.revision, owner.revision);
        const read = result(await component.invoke(`get_${owner.kind}`, owner.arguments, abort.signal));
        assert.equal(read.content, owner.original.content.replaceAll("\r\n", "\n"));
        assert.deepEqual(await readFile(join(component.root, ".pkm/state/knowledge-deletions.json")), state.history);
      }
      outcomes.push({ stage: step.stage, operationId: args.operationId });
      await complete(step.stage);
    }
    await check();
    const final = live(component); assert.equal(final.intents.length, 0); assert.equal(final.receipts.length, 4); assert.equal(final.successors.length, 4);
    const db = component.storage.connectNative();
    try {
      state.transitions = custody.readOriginalTrashSuccessors(db, component.workspaceId, component.root, component.custody.planSha256).transitions;
      assert.equal(state.transitions.length, 4);
    } finally { db.close(); }
    await protocol.finish(); await ui.done; await check();
    const proof = JSON.parse(await readFile(join(root, "native-skill-paper-trash-ui-passed.json")));
    assert.equal(proof.passed, true); assert.equal(proof.actualRenderedDom, true); assert.equal(proof.runId, runId);
    assert.deepEqual(proof.dialogs.map(row => ({ stage: row.stage, type: row.type, choice: row.choice })),
      installedNativeSkillPaperTrashStages.flatMap(step => [
        ...(step.publicChoice ? [{ stage: step.stage, type: "public", choice: step.publicChoice }] : []),
        ...(step.action ? [{ stage: step.stage, type: "trash", choice: step.choice }] : []),
      ]));
    assert(proof.dialogs.filter(row => row.type === "trash").every(row => row.defaultDenyFocused));
    for (const transition of state.transitions) {
      const observed = proof.dialogs.find(row => row.request?.subject.operationId === transition.operationId);
      assert(observed); assert.deepEqual(observed.request, transition.provenance.request);
      contracts.validateOriginalNativeTrashProvenance(transition.provenance);
      assert.equal(observed.requestSha256, transition.provenance.decision.requestSha256);
    }
    const attachment = await u.load(installed, "original-mcp-native-attachment");
    const descriptor = await attachment.verifyOriginalMcpNativeAttachmentDescriptor(component.attachmentDescriptorPath,
      component.attachmentDescriptorSha256, host.receipt.profileSha256);
    const session = { brokerId: descriptor.brokerId, activationId: host.receipt.epoch, epoch: host.receipt.epoch,
      identitySha256: descriptor.identitySha256, binding: { ...descriptor.binding } };
    const { receiptSha256: _receipt, ...nativeBinding } = host.receipt;
    state.parserPackets = state.transitions.filter(transition => transition.action === "move").map(transition => {
      const request = transition.provenance.request;
      return { payload: contracts.parseOriginalNativeTrashPayload({
        binding: nativeBinding, defaultDecision: "deny", request, requestSha256: contracts.originalNativeTrashDigest(request),
      }, session), session: structuredClone(session) };
    });
    assert.deepEqual(state.parserPackets.map(packet => packet.payload.request.subject.area), ["skills", "papers"]);
    const note = await planning.prepareOriginalTrashOperation(component.storage, host, {
      operation: "knowledge.trash.list", actorId: "mcp:external",
      args: { area: "notes", entryIds: [], operationId: randomUUID() },
    });
    const noteRequest = { schema: "pkm.original-native-trash-request/v1", phase: "execute", subject: note.subject,
      nativeHostReceiptSha256: host.receipt.receiptSha256, nativeEpoch: host.receipt.epoch };
    state.noteSchemaControl = { payload: contracts.parseOriginalNativeTrashPayload({
      binding: nativeBinding, defaultDecision: "deny", request: noteRequest, requestSha256: contracts.originalNativeTrashDigest(noteRequest),
    }, session), session: structuredClone(session) };
    state.finalKnowledge = u.hashes(await u.files(component.root, true));
    const receipts = live(component).receipts;
    const evidence = { passed: true, actualNativeUi: true, publicDeleteOperations: ["mcp.tool.delete_skill", "mcp.tool.delete_paper"],
      binding, originalPackageSha256: sourceFixture.originalPackageSha256,
      owners: sourceFixture.owners.map(owner => ({
        area: owner.area, path: owner.path, pairPath: owner.pairPath, knowledgeId: owner.knowledgeId,
        revision: owner.revision, rawSha256: owner.sha256,
      })),
      canonicalReceipts: receipts.map(receipt => ({
        operationId: receipt.operation_id, operation: receipt.operation, actorId: receipt.actor_id,
        fingerprint: receipt.fingerprint, resultSha256: u.hash(receipt.result),
      })),
      custodyTransitions: state.transitions.map(transition => ({
        operationId: transition.operationId, action: transition.action,
        area: transition.provenance.request.subject.selection[0].area,
        requestSha256: transition.provenance.decision.requestSha256,
      })),
      actualDialogs: proof.dialogs,
      publicDialogCount: proof.dialogs.filter(row => row.type === "public").length,
      targetDialogCount: proof.dialogs.filter(row => row.type === "trash").length,
      supplementalCanonicalOperations: ["knowledge.trash.list", "knowledge.trash.restore"],
      exactOriginalRawKnowledgeIdRevisionPairHistory: true, separateDefaultDenyNativeTargetChoices: true,
      allStagesObserverAcknowledged: true, observerStageAcknowledgements: installedNativeSkillPaperTrashStages.length,
      paperListValidationRequiredSeparatePublicApproval: true, paperListOperationParityQualified: false,
      sameOwnerLeaseAndCoreDatabase: true, privateAndSharedPairRefusedOrPreserved: true,
      staleRestoreAndMissingReplayRefused: true, exactUuidReplayNoEffectsOrReview: true, trashReceipts: 4, custodySuccessors: 4,
      oldReadonlyBucketRestoreQualified: false, genericKnowledgeFileTrashQualified: false, installedDestinationCollisionQualified: false,
      installedPendingRecoveryQualified: false, sealedV1ReceiverRefusalQualified: false,
      b1AndB0Qualified: false, fullTrashParityQualified: false, fullCutoverQualified: false, outcomes };
    await writeFile(join(root, "native-skill-paper-trash-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
    state.phase = "verified"; return evidence;
  } catch (error) { await protocol.fail(error); throw error; }
  finally { if (state.phase !== "verified") state.phase = "failed"; abort.abort(); await ui.stop(); }
}
/** Pure copies of observed UI/receipt-linked requests; these DTOs are not native authority. */
export function installedNativeSkillPaperTrashParserPackets(sourceFixture) {
  return structuredClone(stateFor(sourceFixture, "verified").parserPackets);
}
/** Current read-only planner DTO for the old parser's Note-v1 schema control, not a list grant. */
export function installedNativeSkillPaperTrashNoteSchemaControl(sourceFixture) {
  return structuredClone(stateFor(sourceFixture, "verified").noteSchemaControl);
}
export async function verifyInstalledNativeSkillPaperTrashB1(sourceFixture, { retirement, b1, stoppedCoreSha256 }) {
  const state = stateFor(sourceFixture, "verified");
  const receipt = await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture,
    sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 }, retirement);
  if (b1?.kind !== "pkm.original-mcp-component-b1/v1" || b1.b1Sha256 !== receipt.b1Sha256
    || relative(state.componentFixture.directory, b1.b1Path).includes(sep) || !/b1-[a-f0-9-]{36}$/.test(b1.b1Path)
    || !/^[a-f0-9]{64}$/.test(stoppedCoreSha256 ?? "")) fail("INSTALLED_SKILL_PAPER_TRASH_STOPPED_B1_REQUIRED");
  await u.privateDirectory(b1.b1Path, "INSTALLED_SKILL_PAPER_TRASH_PRIVATE_B1_REQUIRED");
  const bytes = await readFile(join(b1.b1Path, "manifest.json")), image = JSON.parse(bytes);
  assert.equal(u.hash(bytes), receipt.b1Sha256); assert.equal(image.root, sourceFixture.root);
  assert.equal(image.schema, "pkm.original-mcp-component-image/v1");
  const complete = JSON.parse(await readFile(join(b1.b1Path, "complete.json")));
  assert.equal(complete.sha256, receipt.b1Sha256); assert(complete.sqliteChecks >= 1);
  assert.deepEqual(u.hashes(await u.files(retirement.archive, true)), state.finalKnowledge);
  await preservation(state, retirement.archive);
  assert.deepEqual(await readFile(join(retirement.archive, ".pkm/state/knowledge-deletions.json")), state.history);
  for (const name of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm"]) {
    const row = image.rows.find(row => row.path === name);
    if (!row) { assert.notEqual(name, "core.sqlite"); await u.absent(join(retirement.archive, name), "INSTALLED_SKILL_PAPER_TRASH_NEW_SIDECAR"); continue; }
    const bytes = await readFile(join(retirement.archive, name));
    assert.equal(bytes.length, row.size); assert.equal(u.hash(bytes), row.sha256);
    assert.equal(u.hash(await readFile(join(b1.b1Path, "payload", name))), row.sha256);
    if (name === "core.sqlite") assert.equal(row.sha256, stoppedCoreSha256);
    if (name === "core.sqlite-wal") assert.equal(bytes.length, 0);
  }
  return { skillPaperPairHistoryB1Preserved: true, exactStoppedCoreAndSidecarImagesPreserved: true,
    stoppedImagePreservedWithoutSqliteReopen: true, b1Sha256: receipt.b1Sha256, stoppedCoreSha256 };
}
export async function verifyInstalledNativeSkillPaperTrashRestored(sourceFixture, options) {
  const state = stateFor(sourceFixture, "verified"), b1 = await verifyInstalledNativeSkillPaperTrashB1(sourceFixture, options);
  const expected = { componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 };
  const retired = await readInstalledKnowledgeMoveRetirementReceipt(expected, options.retirement);
  await readInstalledKnowledgeMoveRestoredReceipt(expected, options.retirement, options.restored, retired);
  assert.deepEqual(u.hashes(await u.files(options.restored.root)), u.hashes(state.baseline));
  for (const path of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-workspace", ".pkm-next-original-mcp.json", ".pkm-native"])
    await u.absent(join(options.restored.root, path), "INSTALLED_SKILL_PAPER_TRASH_B0_NATIVE_STATE");
  return { ...b1, originalB0BytesRestored: true, freshB0NoNativeDatabaseOrGrant: true,
    originalRootOverwritten: false, fullTrashParityQualified: false, fullCutoverQualified: false };
}
