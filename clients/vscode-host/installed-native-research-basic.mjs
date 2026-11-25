import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInstalledResearchBasicOracle, researchOriginalTools } from "../../tests/installed-research-basic-oracle.mjs";
import {
  installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u,
  assertInstalledKnowledgeMoveComponentBinding, readInstalledKnowledgeMoveRetirementReceipt,
  readInstalledKnowledgeMoveRestoredReceipt,
} from "./installed-native-knowledge-move.mjs";
import { createInstalledNativeResearchBasicStageProtocol, startInstalledNativeResearchBasicUi } from "./installed-native-research-basic-ui.mjs";

const states = new WeakMap(), category = "ResearchPublic", topic = "researchfixturetopic";
export const installedNativeResearchBasicPrivacyPolicy = installedNativeKnowledgeMovePrivacyPolicy;
export const installedNativeResearchBasicDocuments = Object.freeze([
  { slug: `${category}/Root`, id: "knowledge_000000000000000000000071", revision: 7,
    fields: { title: "Research Root", year: 2020, topic, authors: ["Ada Research"], tags: ["researchmetadataneedle"],
      conclusions: ["Bounded synthetic result"], implementation: ["No external dependency"] },
    content: "researchbodyonlyneedle\n" },
  { slug: `${category}/Child`, id: "knowledge_000000000000000000000072", revision: 2,
    fields: { title: "Research Child", year: 2025, topic,
      cites: ["RESEARCH ROOT", { paper: `${category}/Root.md`, comment: "second independent citation" }] },
    content: "Synthetic citing result.\n" },
  { slug: `${category}/Grandchild`, id: "knowledge_000000000000000000000073", revision: 3,
    fields: { title: "Research Grandchild", year: 2026, topic, cites: [`${category}/Child`] },
    content: "One-hop graph must not pull this second-hop result.\n" },
  { slug: `${category}/Other`, id: "knowledge_000000000000000000000074", revision: 1,
    fields: { title: "Research Other", topic: "researchothertopic", year: 2018 }, content: "Other topic.\n" },
]);
export const researchBasicRaw = row => `---\nschema: pkm.knowledge/v1\nknowledgeId: ${row.id}\nrevision: ${row.revision}\n`
  + Object.entries(row.fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join("") + `---\n${row.content}`;
const canonicalId = `pkm://knowledge/${installedNativeResearchBasicDocuments[0].id}`;
const stage = (suffix, tool, arguments_, extra = {}) => Object.freeze({
  stage: `native-research-basic-${suffix}`, tool, arguments: Object.freeze(arguments_), ...extra,
  ...(tool === "paper_graph" ? { publicChoice: extra.publicChoice ?? "Approve this request" } : { noReview: true }),
});
export const installedNativeResearchBasicStages = Object.freeze([
  stage("get-slug", "get_research", { slug: `${category}/Root` }),
  stage("get-stable", "get_research", { id: canonicalId }),
  stage("get-raw-id", "get_research", { id: installedNativeResearchBasicDocuments[0].id }),
  stage("get-conflicting", "get_research", { id: canonicalId, slug: `${category}/Root` }),
  stage("get-missing", "get_research", { slug: `${category}/Missing` }),
  stage("list", "list_research", {}),
  stage("list-topic", "list_research", { topic }),
  stage("list-empty", "list_research", { topic: "researchmissingtopic" }),
  stage("search-metadata", "search_research", { query: "RESEARCHMETADATANEEDLE", limit: 1 }),
  stage("search-body-control", "search_research", { query: "researchbodyonlyneedle" }),
  stage("search-syntax-control", "search_research", { query: "researchmetadataneedle OR impossible" }),
  stage("search-private", "search_research", { query: "researchprivatesentinel" }),
  stage("graph-denied", "paper_graph", { topic, limit: 1, neighbors: true }, { publicChoice: "Deny", refusal: "denied" }),
  stage("graph-top", "paper_graph", { topic, limit: 1 }),
  stage("graph-neighbors", "paper_graph", { topic, limit: 1, neighbors: true }),
  stage("graph-empty", "paper_graph", { topic: "researchmissingtopic" }),
]);
export const installedNativeResearchBasicEffectCaseRefs = Object.freeze(researchOriginalTools.map(tool => `original-${tool}-basic`));
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value, phase) {
  const state = states.get(value);
  if (!state) fail("INSTALLED_RESEARCH_ACTUAL_PREPARATION_REQUIRED");
  if (phase && state.phase !== phase) fail("INSTALLED_RESEARCH_VERIFIED_PHASE_REQUIRED");
  return state;
}
export function assertInstalledNativeResearchBasicCatalog(catalog, receipt) {
  assert.equal(catalog.provenance.metadataSha256, receipt.sourceCatalogSha256);
  return researchOriginalTools.map(tool => {
    const contract = catalog.contracts.find(row => row.transportName === tool);
    assert(contract, `Exact Original Research contract absent: ${tool}`);
    assert.equal(contract.id, `mcp.tool.${tool}`); assert.equal(contract.version, 1);
    assert.equal(contract.readOnly, tool !== "paper_graph", "Never downgrade actual Original paper_graph readOnly:false.");
    const expected = { get_research: ["id", "slug"], list_research: ["topic"],
      search_research: ["query", "limit", "detail", "route"], paper_graph: ["topic", "limit", "neighbors"] }[tool];
    assert.deepEqual(Object.keys(contract.inputSchema.properties).sort(), [...expected].sort(),
      "Exact Research contract boundary: no invented pagination, revisions, graph model or semantic parameters.");
    assert.equal(contract.inputSchema.additionalProperties, false);
    for (const step of installedNativeResearchBasicStages.filter(step => step.tool === tool)) {
      assert.equal(!!step.publicChoice, !contract.readOnly);
      for (const key of Object.keys(step.arguments)) assert(expected.includes(key));
    }
    return { tool, operation: contract.id, version: 1, readOnly: contract.readOnly };
  });
}
export function normalizeResearchGraph(value) {
  return { ...value, nodes: [...value.nodes].sort((a, b) => a.key.localeCompare(b.key)) };
}
export function assertResearchStableResult(actual, expected) {
  assert.equal(actual.schema, "pkm.knowledge.read/v1"); assert.equal(actual.ok, true);
  assert.match(actual.corpus_revision, /^[a-f0-9]{64}$/);
  assert(Number.isSafeInteger(actual.ready_generation) && actual.ready_generation >= 1);
  // Parent's whole native corpus and generation history are not the closed public oracle corpus.
  const stable = ({ corpus_revision, ready_generation, ...value }) => value;
  assert.deepEqual(stable(actual), stable(expected));
  assert.equal(actual.source_id, canonicalId);
  assert.notEqual(actual.source_revision, String(installedNativeResearchBasicDocuments[0].revision));
  assert.match(actual.content_hash, /^[a-f0-9]{64}$/);
}
function publication(value) {
  u.noPrivatePublication(value);
  assert(!JSON.stringify(value).includes("researchprivatesentinel"), "Private Research metadata/body must not be published.");
}
function valueOf(response) {
  publication(response); assert.notEqual(response.isError, true, JSON.stringify(response));
  if (response.structuredContent !== undefined) return response.structuredContent;
  const text = response.content[0].text;
  try { return JSON.parse(text); } catch { return text; }
}
async function closedCopy(state, root) {
  const files = await u.files(root, true), timestamps = [];
  for (const area of ["notes", "skills", "papers"]) {
    await rm(join(state.oracle.root, area), { recursive: true, force: true });
    await mkdir(join(state.oracle.root, area), { mode: 0o700 });
  }
  for (const file of files) {
    if (!["notes", "skills", "papers"].includes(file.path.split("/")[0])
      || file.path.split("/")[1] === "Private" || file.path.split("/").some(part => part.toLowerCase() === "system")) continue;
    await mkdir(join(state.oracle.root, file.path, ".."), { mode: 0o700, recursive: true });
    await writeFile(join(state.oracle.root, file.path), file.bytes, { flag: "wx", mode: 0o600 });
    const stat = await lstat(join(root, file.path), { bigint: true });
    timestamps.push({ path: file.path, atimeNs: String(stat.atimeNs), mtimeNs: String(stat.mtimeNs) });
  }
  execFileSync(state.python, ["-I", "-B", "-c", String.raw`
import json,os,sys
from pathlib import Path
root=Path(sys.argv[1])
for row in json.load(sys.stdin):
 path=root/row["path"];path.resolve().relative_to(root)
 os.utime(path,ns=(int(row["atimeNs"]),int(row["mtimeNs"])),follow_symlinks=False)
`, state.oracle.root], { input: JSON.stringify(timestamps), cwd: state.oracleDirectory,
    env: { ...process.env, TMPDIR: join(state.oracleDirectory, "scratch"), PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "pipe", timeout: 10000 });
}
/** Pre-B0 only; no model, user Root, private permission or existing Paper/Note helper is changed. */
export async function prepareInstalledNativeResearchBasicFixture({ installed, componentFixture, legacyVsix, python }) {
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (states.has(componentFixture)) fail("INSTALLED_RESEARCH_ALREADY_PREPARED");
  for (const name of ["core.sqlite", ".pkm-next-original-mcp.json"])
    await u.absent(join(componentFixture.root, name), "INSTALLED_RESEARCH_PRE_B0_REQUIRED");
  for (const name of ["b0", "custody"]) await u.absent(join(componentFixture.directory, name), "INSTALLED_RESEARCH_PRE_B0_REQUIRED");
  if (!isAbsolute(python ?? "")) fail("INSTALLED_RESEARCH_EXPLICIT_PYTHON_REQUIRED");
  await u.privateDirectory(componentFixture.root, "INSTALLED_RESEARCH_PRIVATE_ROOT_REQUIRED");
  const privacyPath = join(componentFixture.root, ".pkm/content-privacy.json"), privacy = await readFile(privacyPath);
  const privacyStat = await lstat(privacyPath);
  assert(privacyStat.isFile() && !privacyStat.isSymbolicLink() && privacyStat.nlink === 1
    && privacyStat.uid === process.getuid() && !(privacyStat.mode & 0o077));
  assert.deepEqual(JSON.parse(privacy), installedNativeResearchBasicPrivacyPolicy, "Parent must independently configure exact Original privacy.");
  await u.absent(join(componentFixture.root, "papers", category), "INSTALLED_RESEARCH_DISJOINT_SEED_REQUIRED");
  await u.absent(join(componentFixture.root, "papers/Private/ResearchSentinel.md"), "INSTALLED_RESEARCH_DISJOINT_SEED_REQUIRED");
  const oracleDirectory = join(componentFixture.directory, "research-basic-oracle");
  await mkdir(oracleDirectory, { mode: 0o700 });
  const oracle = await createInstalledResearchBasicOracle({ directory: oracleDirectory, legacyVsix, python });
  await mkdir(join(componentFixture.root, "papers", category), { recursive: true, mode: 0o700 });
  await mkdir(join(componentFixture.root, "papers/Private"), { recursive: true, mode: 0o700 });
  for (const row of installedNativeResearchBasicDocuments)
    await writeFile(join(componentFixture.root, "papers", `${row.slug}.md`), researchBasicRaw(row), { flag: "wx", mode: 0o600 });
  await writeFile(join(componentFixture.root, "papers/Private/ResearchSentinel.md"), researchBasicRaw({
    id: "knowledge_000000000000000000000075", revision: 1, fields: { title: "researchprivatesentinel", tags: ["researchprivatesentinel"] },
    content: "researchprivatesentinel\n",
  }), { flag: "wx", mode: 0o600 });
  assert.deepEqual(await readFile(privacyPath), privacy);
  const baseline = await u.files(componentFixture.root);
  const state = { installed, componentFixture, oracle, oracleDirectory, python, privacy, baseline, phase: "prepared" };
  await closedCopy(state, componentFixture.root);
  const graph = await oracle.invoke("paper_graph", { topic, limit: 1, neighbors: true });
  assert.deepEqual(normalizeResearchGraph(graph).nodes.map(row => row.key), [`${category}/Child`, `${category}/Root`]);
  assert.deepEqual(graph.edges, [
    { from: `${category}/Root`, to: `${category}/Child`, note: "" },
    { from: `${category}/Root`, to: `${category}/Child`, note: "second independent citation" },
  ]);
  const stable = await oracle.invoke("get_research", { id: canonicalId });
  assert.equal(stable.ok, true); assert.equal(stable.source_id, canonicalId);
  const value = Object.freeze({ kind: "pkm.installed-native-research-basic-fixture/v1", root: componentFixture.root,
    originalPackageSha256: oracle.writer.originalPackageSha256, originalMcpMemberSha256: oracle.mcpMemberSha256,
    originalMcpProducerSha256: oracle.sourceSha256, files: Object.freeze(u.hashes(baseline).map(Object.freeze)),
    effectCaseRefs: installedNativeResearchBasicEffectCaseRefs });
  state.value = value; states.set(componentFixture, state); states.set(value, state); return value;
}
function journal(component) {
  const database = component.storage.connectNative();
  try { return {
    receipts: database.prepare("SELECT * FROM receipts ORDER BY operation_id").all().map(row => ({ ...row })),
    intents: database.prepare("SELECT * FROM migration_runtime_intents ORDER BY operation_id").all().map(row => ({ ...row })),
  }; } finally { database.close(); }
}
/** Genuine component.invoke and rendered PUBLIC decisions only; no mock can manufacture installed receipts. */
export async function verifyInstalledNativeResearchBasic({ root, installed, component, sourceFixture, payloadBuildId,
  python, env, port, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture, "prepared");
  if (state.installed !== installed || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_RESEARCH_SAME_COMPONENT_REQUIRED");
  const { host, full } = await assertInstalledKnowledgeMoveComponentBinding({ root, installed, component,
    componentFixture: state.componentFixture, payloadBuildId });
  assert.equal(full.runtime.services.modelProvider, undefined); assert.equal(host.nativeChat, undefined);
  const catalog = (await u.load(installed, "native-public-original-mcp-contracts")).originalPublicMcpContracts();
  const publicContracts = assertInstalledNativeResearchBasicCatalog(catalog, host.receipt);
  state.b0Sha256 = component.b0.sha256;
  const binding = { root: component.root, workspaceId: component.workspaceId, custodyPlanSha256: component.custody.planSha256,
    catalogSha256: host.receipt.sourceCatalogSha256, profileSha256: host.receipt.profileSha256,
    privacySha256: component.custody.privacySha256, epoch: host.receipt.epoch,
    nativeHostReceiptSha256: host.receipt.receiptSha256 };
  const beforeFiles = await u.files(component.root, true), beforeJournal = journal(component);
  for (const file of state.baseline.filter(file => file.path.startsWith(`papers/${category}/`) || file.path === "papers/Private/ResearchSentinel.md"))
    assert.deepEqual(await readFile(join(component.root, file.path)), file.bytes);
  const lease = { ...component.owner.workspaceLease() }, runId = randomUUID(), abort = new AbortController();
  await writeFile(join(root, "native-research-basic-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-research-basic-ui/v1", runId, binding, publicContracts, stages: installedNativeResearchBasicStages,
  }), { flag: "wx", mode: 0o600 });
  const ui = await startInstalledNativeResearchBasicUi({ root, runId, python, env, port, timeoutMs });
  void ui.done.catch(error => abort.abort(error));
  const check = async () => {
    if (ui.error) throw ui.error;
    abort.signal.throwIfAborted(); host.assertCurrent(); component.storage.assertWorkspaceLease();
    assert.deepEqual({ ...component.owner.workspaceLease() }, lease);
    assert.equal((await component.owner.ensureFull()).runtime.core, full.runtime.core);
    assert.deepEqual(await u.files(component.root, true), beforeFiles);
    assert.deepEqual(journal(component), beforeJournal);
    assert.deepEqual(await readFile(join(component.root, ".pkm/content-privacy.json")), state.privacy);
  };
  const protocol = await createInstalledNativeResearchBasicStageProtocol({ root, runId, timeoutMs,
    stages: installedNativeResearchBasicStages.map(row => row.stage), check });
  const outcomes = [];
  try {
    await ui.ready; await check();
    await closedCopy(state, component.root);
    for (const step of installedNativeResearchBasicStages) {
      await protocol.begin(step.stage);
      let response, error;
      try { response = await component.invoke(step.tool, step.arguments, abort.signal); } catch (failure) { error = failure; }
      if (response) publication(response);
      if (error) publication({ message: error.message });
      if (step.refusal) {
        const refused = error ?? (response?.isError ? response.structuredContent : undefined);
        assert(refused, "Independent Deny must actually refuse, not skip or return an empty graph.");
        assert.equal(refused.code, "ACCESS_DENIED");
        outcomes.push({ stage: step.stage, refused: true, noEffects: true });
      } else {
        if (error) throw error;
        const actual = valueOf(response), expected = await state.oracle.invoke(step.tool, step.arguments);
        if (step.stage.endsWith("get-stable") || step.stage.endsWith("get-raw-id")) assertResearchStableResult(actual, expected);
        else if (step.tool === "paper_graph") {
          assert.deepEqual(normalizeResearchGraph(actual), normalizeResearchGraph(expected));
          if (step.stage.endsWith("graph-neighbors")) {
            assert.equal(actual.nodes.length, 2); assert.equal(actual.edges.length, 2);
            assert(!actual.nodes.some(node => node.key.endsWith("/Grandchild")));
          }
        } else assert.deepEqual(actual, expected);
        outcomes.push({ stage: step.stage, originalResponse: true, noEffects: true,
          ...(step.tool === "paper_graph" ? { nodes: actual.nodes.length, edges: actual.edges.length, total: actual.total, shown: actual.shown } : {}) });
      }
      await check(); await protocol.complete(step.stage);
    }
    await protocol.finish(); await ui.done; await check();
    const proof = JSON.parse(await readFile(join(root, "native-research-basic-ui-passed.json")));
    assert.equal(proof.passed, true); assert.equal(proof.actualRenderedDom, true); assert.equal(proof.runId, runId);
    assert.deepEqual(proof.dialogs.map(row => ({ stage: row.stage, choice: row.choice })),
      installedNativeResearchBasicStages.filter(row => row.publicChoice).map(row => ({ stage: row.stage, choice: row.publicChoice })));
    state.finalKnowledge = u.hashes(beforeFiles);
    state.evidence = { schema: "pkm.installed-native-research-basic-evidence/v1", passed: true,
      actualNativeUi: true, actualComponentInvoke: true, exactOriginalIds: researchOriginalTools.map(tool => `mcp.tool.${tool}`),
      effectCaseRefs: installedNativeResearchBasicEffectCaseRefs, paperEvidenceBorrowed: false,
      originalPackageSha256: sourceFixture.originalPackageSha256, originalMcpMemberSha256: sourceFixture.originalMcpMemberSha256,
      originalMcpProducerSha256: sourceFixture.originalMcpProducerSha256,
      lexicalQualification: "genuine Original offline metadata substring fallback; body excluded; no semantic qualification",
      graphQualification: "genuine local citation graph; duplicate edges and one-hop neighbors; empty topic separately checked",
      listQualification: "legacy ordered metadata array, exact topic filter; no pagination parameters exist",
      stableQualification: "sealed Original get_source and snapshot; canonical source_id/source_revision/hash distinct from raw identity/revision",
      graphReadOnlyHint: false, independentGraphDenialNoEffects: true, outcomes, binding, payloadBuildId,
      semanticOrNetworkPerformed: false, sourceRawIdsRevisionsUnchanged: true,
      acknowledgedStageCount: outcomes.length, actualDialogs: proof.dialogs,
      installedHostEntrySha256: u.hash(await readFile(join(installed, "dist/extension.cjs"))),
      b1AndB0Qualified: false, fullCutoverQualified: false };
    state.phase = "verified";
    await writeFile(join(root, "native-research-basic-passed.json"), JSON.stringify(state.evidence), { flag: "wx", mode: 0o600 });
    return state.evidence;
  } catch (error) { await protocol.fail(error); throw error; }
  finally { if (state.phase !== "verified") state.phase = "failed"; abort.abort(); await ui.stop(); }
}
/** Parent supplies its actual stopped-core receipt after clean native/helper exits, never a replay. */
export async function verifyInstalledNativeResearchBasicB1(sourceFixture, { retirement, b1, stoppedCoreSha256 }) {
  const state = stateFor(sourceFixture, "verified");
  const receipt = await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture,
    sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 }, retirement);
  if (b1?.kind !== "pkm.original-mcp-component-b1/v1" || b1.b1Sha256 !== receipt.b1Sha256
    || typeof b1.b1Path !== "string" || relative(state.componentFixture.directory, b1.b1Path).includes(sep)
    || !/b1-[a-f0-9-]{36}$/.test(b1.b1Path) || !/^[a-f0-9]{64}$/.test(stoppedCoreSha256 ?? ""))
    fail("INSTALLED_RESEARCH_STOPPED_B1_REQUIRED");
  await u.privateDirectory(b1.b1Path, "INSTALLED_RESEARCH_PRIVATE_B1_REQUIRED");
  const bytes = await readFile(join(b1.b1Path, "manifest.json")), image = JSON.parse(bytes);
  assert.equal(u.hash(bytes), receipt.b1Sha256); assert.equal(image.root, sourceFixture.root);
  assert.equal(image.schema, "pkm.original-mcp-component-image/v1");
  const complete = JSON.parse(await readFile(join(b1.b1Path, "complete.json")));
  assert.equal(complete.sha256, receipt.b1Sha256); assert(complete.sqliteChecks >= 1);
  assert.deepEqual(u.hashes(await u.files(retirement.archive, true)), state.finalKnowledge);
  const runtimeNames = ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm"];
  for (const name of (await readdir(retirement.archive)).filter(name => name.startsWith("core.sqlite"))) assert(runtimeNames.includes(name));
  for (const row of image.rows.filter(row => row.path.startsWith("core.sqlite")))
    assert(runtimeNames.includes(row.path) && row.directory === false, "Never accept new native sidecars implicitly.");
  for (const name of runtimeNames) {
    const row = image.rows.find(row => row.path === name);
    if (!row) { assert.notEqual(name, "core.sqlite"); await u.absent(join(retirement.archive, name), "INSTALLED_RESEARCH_NEW_SIDECAR"); continue; }
    const bytes = await readFile(join(retirement.archive, name)), stat = await lstat(join(retirement.archive, name));
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid());
    assert.equal(stat.mode & 0o777, row.mode);
    assert.equal(row.directory, false); assert.equal(bytes.length, row.size); assert.equal(u.hash(bytes), row.sha256);
    assert.equal(u.hash(await readFile(join(b1.b1Path, "payload", name))), row.sha256);
    if (name === "core.sqlite") assert.equal(row.sha256, stoppedCoreSha256);
    if (name === "core.sqlite-wal") assert.equal(bytes.length, 0);
  }
  state.phase = "b1-verified"; state.retirement = retirement;
  return { passed: true, b1Sha256: receipt.b1Sha256, rawResearchIdsRevisionsUnchanged: true };
}
export async function verifyInstalledNativeResearchBasicRestored(sourceFixture, { freshB0, retirement }) {
  const state = stateFor(sourceFixture, "b1-verified");
  assert.equal(retirement, state.retirement);
  const expected = { componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 };
  const retired = await readInstalledKnowledgeMoveRetirementReceipt(expected, retirement);
  await readInstalledKnowledgeMoveRestoredReceipt(expected, retirement, freshB0, retired);
  assert.deepEqual(u.hashes(await u.files(freshB0.root)), u.hashes(state.baseline));
  for (const name of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-original-mcp.json", ".pkm-v5-migration-root.lock", ".pkm-cross-process.lock"])
    await u.absent(join(freshB0.root, name), "INSTALLED_RESEARCH_FRESH_B0_NATIVE_ARTIFACT");
  state.phase = "restored";
  return { passed: true, freshB0Verified: true, oldRootUntouched: true, exactBaseline: true, receiptSha256: freshB0.receiptSha256 };
}
