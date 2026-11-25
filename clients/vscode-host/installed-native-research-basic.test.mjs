import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createInstalledResearchBasicOracle, inspectSealedResearchRelease } from "../../tests/installed-research-basic-oracle.mjs";
import {
  installedNativeResearchBasicDocuments as documents, researchBasicRaw, installedNativeResearchBasicPrivacyPolicy,
  installedNativeResearchBasicStages, assertInstalledNativeResearchBasicCatalog, normalizeResearchGraph, assertResearchStableResult,
  prepareInstalledNativeResearchBasicFixture, verifyInstalledNativeResearchBasic, verifyInstalledNativeResearchBasicB1,
  verifyInstalledNativeResearchBasicRestored,
} from "./installed-native-research-basic.mjs";
import {
  installedNativeResearchBasicUiProgram, createInstalledNativeResearchBasicStageProtocol, startInstalledNativeResearchBasicUi,
} from "./installed-native-research-basic-ui.mjs";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the mandatory private Linux framework; no uncontained fallback.");
assert(process.env.PKM_TEST_PYTHON); assert(process.env.PKM_LEGACY_VSIX);
const python = process.env.PKM_TEST_PYTHON, installed = resolve("clients/vscode-host");
async function owned(t, prefix) {
  const root = resolve("tests", `.${prefix}-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function closed(t) {
  const directory = await owned(t, "research-closed-oracle");
  const oracle = await createInstalledResearchBasicOracle({ directory, legacyVsix: process.env.PKM_LEGACY_VSIX, python });
  for (const row of documents) {
    await mkdir(join(oracle.root, "papers", row.slug, ".."), { recursive: true, mode: 0o700 });
    await writeFile(join(oracle.root, "papers", `${row.slug}.md`), researchBasicRaw(row), { mode: 0o600 });
  }
  return { directory, oracle };
}
test("sealed Original22 genuinely contains all four Research aliases; observed27 preserves their exact function contracts", async () => {
  const original22 = await inspectSealedResearchRelease({ legacyVsix: process.env.PKM_LEGACY_VSIX, version: "4.0.22", python });
  const original27 = await inspectSealedResearchRelease({
    legacyVsix: resolve("../personal-knowledge-vscode/personal-knowledge-4.0.27.vsix"), version: "4.0.27", python,
  });
  assert.deepEqual(original22.contracts, original27.contracts);
  assert.deepEqual(original22.contracts.list_research.arguments, ["topic"]);
  assert.deepEqual(original22.contracts.paper_graph.arguments, ["topic", "limit", "neighbors"]);
  assert.notEqual(original22.packageSha256, original27.packageSha256);
});
test("closed Original Research slug and stable source_id retrieval retain different genuine envelopes and raw revisions", async t => {
  const { directory, oracle } = await closed(t), row = documents[0], id = `pkm://knowledge/${row.id}`;
  const slug = await oracle.invoke("get_research", { slug: row.slug });
  assert.equal(slug.slug, row.slug); assert.equal(slug.content, row.content); assert.equal(slug.citation_count, 2);
  assert.equal(slug.source_id, undefined); assert.equal(slug.revision, undefined);
  const stable = await oracle.invoke("get_research", { id });
  assertResearchStableResult(stable, stable);
  assert.deepEqual(await oracle.invoke("get_research", { id: row.id }), stable);
  assert.match(stable.source_revision, /^7:[a-f0-9]{64}$/);
  assert(stable.content.includes(row.content.trim()));
  assert.deepEqual(await oracle.invoke("get_research", { id, slug: row.slug }),
    { ok: false, error: "id and legacy name/slug must identify the same item" });
  assert.deepEqual(await oracle.invoke("get_research", {}), { ok: false, error: "id is required" });
  assert.equal(await oracle.invoke("get_research", { slug: "ResearchPublic/Missing" }),
    "Paper 'ResearchPublic/Missing' not found. Use list_research or search_research to find it.");
  const bytes = await readFile(join(oracle.root, "papers", `${row.slug}.md`));
  await rename(join(oracle.root, "papers", `${row.slug}.md`), join(oracle.root, "papers/ResearchPublic/Moved.md"));
  const moved = await oracle.invoke("get_research", { id });
  assert.equal(moved.source_id, stable.source_id); assert.match(moved.source_revision, /^7:/);
  assert.notEqual(moved.source_revision, stable.source_revision, "Path metadata participates in genuine indexed content hash.");
  assert.deepEqual(await readFile(join(oracle.root, "papers/ResearchPublic/Moved.md")), bytes);
  const foreign = join(directory, "foreign"); await mkdir(foreign, { mode: 0o700 });
  await assert.rejects(oracle.invoke("get_research", { slug: row.slug }, foreign), { code: "INSTALLED_RESEARCH_CLOSED_ORACLE_ROOT_REQUIRED" });
  await assert.rejects(oracle.invoke("get_paper", { slug: row.slug }), { code: "INSTALLED_RESEARCH_CLOSED_ORACLE_ROOT_REQUIRED" });
});
test("real Original Research listing is exact ordered metadata array/topic filter, never invented pagination", async t => {
  const { oracle } = await closed(t);
  const all = await oracle.invoke("list_research", {});
  assert.deepEqual(all.map(row => row.slug), ["ResearchPublic/Root", "ResearchPublic/Child", "ResearchPublic/Grandchild", "ResearchPublic/Other"]);
  assert.deepEqual(Object.keys(all[0]), ["slug", "title", "year", "authors", "topic", "publisher", "tags", "citation_count"]);
  assert.equal(all[0].citation_count, 2); assert.equal(all[1].citation_count, 1);
  assert.deepEqual(await oracle.invoke("list_research", { topic: "researchfixturetopic" }), all.slice(0, 3));
  assert.deepEqual(await oracle.invoke("list_research", { topic: "ResearchFixtureTopic" }), []);
  await assert.rejects(oracle.invoke("list_research", { offset: 1 }), /unexpected keyword argument 'offset'/);
  await assert.rejects(oracle.invoke("list_research", { limit: 1 }), /unexpected keyword argument 'limit'/);
});
test("Original offline Research lexical fallback is case-insensitive metadata substring, not body/FTS/OR syntax", async t => {
  const { oracle } = await closed(t);
  const hit = await oracle.invoke("search_research", { query: "RESEARCHMETADATANEEDLE", limit: 1 });
  assert.deepEqual(hit, [{ slug: documents[0].slug, title: "Research Root", year: 2020, topic: "researchfixturetopic", citation_count: 2 }]);
  for (const query of ["researchbodyonlyneedle", "researchmetadataneedle OR impossible", "researchprivatesentinel", "absent"])
    assert.deepEqual(await oracle.invoke("search_research", { query }), []);
  assert.equal((await oracle.invoke("search_research", { query: "Ada Research" }))[0].slug, documents[0].slug);
  assert.equal((await oracle.invoke("search_research", { query: "2020" }))[0].slug, documents[0].slug);
  assert.equal((await oracle.invoke("search_research", { query: "", limit: 0 })).length, 4, "Genuine fallback preserves empty-query metadata matches.");
});
test("genuine paper_graph has real citation nodes/duplicate directed edges, bounded one-hop neighbors and separately empty topic", async t => {
  const { oracle } = await closed(t);
  const top = await oracle.invoke("paper_graph", { topic: "researchfixturetopic", limit: 1 });
  assert.deepEqual(Object.keys(top), ["nodes", "edges", "total", "shown"]);
  assert.equal(top.total, 3); assert.equal(top.shown, 1);
  assert.deepEqual(top.nodes.map(row => row.key), [documents[0].slug]); assert.deepEqual(top.edges, []);
  const expanded = normalizeResearchGraph(await oracle.invoke("paper_graph", { topic: "researchfixturetopic", limit: 1, neighbors: true }));
  assert.deepEqual(expanded.nodes.map(row => row.key), ["ResearchPublic/Child", "ResearchPublic/Root"]);
  assert.deepEqual(Object.keys(expanded.nodes[0]), ["key", "title", "year", "topic", "citation_count", "conclusions"]);
  assert.deepEqual(expanded.edges, [
    { from: documents[0].slug, to: documents[1].slug, note: "" },
    { from: documents[0].slug, to: documents[1].slug, note: "second independent citation" },
  ]);
  assert.equal(expanded.shown, 2); assert.equal(expanded.total, 3);
  assert.deepEqual(await oracle.invoke("paper_graph", { topic: "missing" }), { nodes: [], edges: [], total: 0, shown: 0 });
});
test("existing Source executors, not Paper receipts, match actual sealed Research reads/lexical/graph and exclude a real private sentinel", async t => {
  const { oracle } = await closed(t);
  const { captureOriginalMcpCustody, openOriginalMcpRoot } = await u.load(installed, "original-mcp-root");
  const { createNativePublicOwnerBackend } = await u.load(installed, "native-public-mcp-owner");
  const { createOriginalMcpNativeHost } = await u.load(installed, "original-mcp-native-host");
  const { originalPublicMcpContracts } = await u.load(installed, "native-public-original-mcp-contracts");
  const root = await owned(t, "research-source"), workspace = join(root, "workspace");
  for (const area of ["notes", "skills", "papers", ".pkm"]) await mkdir(join(workspace, area), { recursive: true, mode: 0o700 });
  for (const row of documents) {
    await mkdir(join(workspace, "papers", row.slug, ".."), { recursive: true, mode: 0o700 });
    const file = `${row.slug}.md`;
    await writeFile(join(workspace, "papers", file), await readFile(join(oracle.root, "papers", file)), { mode: 0o600 });
  }
  await mkdir(join(workspace, "papers/Private"), { mode: 0o700 });
  await writeFile(join(workspace, "papers/Private/Secret.md"), researchBasicRaw({
    id: "knowledge_000000000000000000000075", revision: 1,
    fields: { title: "researchprivatesentinel", topic: "researchprivatesentinel", cites: [documents[0].slug] },
    content: "researchprivatesentinel",
  }), { mode: 0o600 });
  await mkdir(join(workspace, ".pkm"), { recursive: true, mode: 0o700 });
  await writeFile(join(workspace, ".pkm/content-privacy.json"), JSON.stringify(installedNativeResearchBasicPrivacyPolicy), { mode: 0o600 });
  execFileSync(python, ["-I", "-B", "-c", String.raw`
import os,sys
from pathlib import Path
source=Path(sys.argv[1]);closed=Path(sys.argv[2])
for file in (source/"papers/ResearchPublic").glob("*.md"):
 stat=file.stat();os.utime(closed/"papers/ResearchPublic"/file.name,ns=(stat.st_atime_ns,stat.st_mtime_ns))
`, workspace, oracle.root], { stdio: "pipe" });
  const profileSha256 = createHash("sha256").update("research-source-only-callback-fixture").digest("hex");
  const custody = await captureOriginalMcpCustody({ root: workspace, backup: join(root, "custody"),
    operatorId: "research-source-only-callback-fixture", profileSha256,
    limits: { maxEntries: 1000, maxDepth: 16, maxBytes: 16_777_216, maxFileBytes: 1_048_576 } });
  const opened = await openOriginalMcpRoot(custody);
  const host = await createOriginalMcpNativeHost(opened.storage, {
    profileSha256, sourceCatalogSha256: originalPublicMcpContracts().provenance.metadataSha256,
    authorityId: "research-source-only-callback-fixture", epoch: "source-test", signal: new AbortController().signal,
    assertCurrent() {}, async authorizeAdmission() { return true; }, async authorizePublic() { return true; },
    models: { configuration: { aiEndpoint: "https://not-called.invalid/v1", aiModel: "not-called" },
      registryAvailability: {}, async credentialAvailable() { return false; }, async authorizeRequest() { return false; },
      transport: { supports: () => false, async open() { throw new Error("No model/network authority in Research Source fixture."); } } },
  });
  const backend = createNativePublicOwnerBackend(opened.owner, { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: host });
  t.after(async () => { await backend.close(); await host.close(); await opened.owner.close(); });
  const valueOf = response => {
    if (response.structuredContent !== undefined) return response.structuredContent;
    const text = response.content[0].text; try { return JSON.parse(text); } catch { return text; }
  };
  for (const step of installedNativeResearchBasicStages.filter(row => !row.refusal)) {
    const response = await backend.invoke("original_mcp_public", { tool: step.tool, arguments: step.arguments });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const actual = valueOf(response), expected = await oracle.invoke(step.tool, step.arguments);
    if (step.tool === "paper_graph") assert.deepEqual(normalizeResearchGraph(actual), normalizeResearchGraph(expected));
    else if (step.stage.endsWith("get-stable") || step.stage.endsWith("get-raw-id")) assertResearchStableResult(actual, expected);
    else assert.deepEqual(actual, expected);
    assert(!JSON.stringify(response).includes("researchprivatesentinel"));
  }
  const privateGet = await backend.invoke("original_mcp_public", {
    tool: "get_research", arguments: { id: "pkm://knowledge/knowledge_000000000000000000000075" },
  });
  assert.deepEqual(valueOf(privateGet), { ok: false, code: "not-found", error: "Knowledge source not found" });
  await assert.rejects(backend.invoke("original_mcp_public", { tool: "list_research", arguments: { offset: 1 } }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(backend.invoke("original_mcp_public", { tool: "list_research", arguments: { limit: 1 } }), { code: "INVALID_ARGUMENT" });
  const originalRaw = await readFile(join(workspace, "papers", `${documents[0].slug}.md`));
  for (const root of [workspace, oracle.root])
    await rename(join(root, "papers", `${documents[0].slug}.md`), join(root, "papers/ResearchPublic/Moved.md"));
  const movedId = `pkm://knowledge/${documents[0].id}`, moved = valueOf(await backend.invoke("original_mcp_public", {
    tool: "get_research", arguments: { id: movedId },
  }));
  assertResearchStableResult(moved, await oracle.invoke("get_research", { id: movedId }));
  assert.equal(moved.ready_generation, 2);
  assert.deepEqual(await readFile(join(workspace, "papers/ResearchPublic/Moved.md")), originalRaw);
  const oldSlug = valueOf(await backend.invoke("original_mcp_public", { tool: "get_research", arguments: { slug: documents[0].slug } }));
  assert.equal(oldSlug, await oracle.invoke("get_research", { slug: documents[0].slug }));
  t.diagnostic("15 exact Research PUBLIC callback Source cases plus private get, two invalid pagination controls and stable-ID rename delta; no genuine native UI/installed acceptance claimed.");
});
async function componentFixture(t) {
  const directory = await owned(t, "research-cold-helper"), previous = process.env.HOME;
  await mkdir(join(directory, ".local/state/pkm-v5-recovery"), { mode: 0o700, recursive: true });
  const recovery = await u.load(installed, "original-mcp-component-recovery");
  let fixture;
  try {
    process.env.HOME = directory;
    fixture = await recovery.createOriginalMcpColdComponentFixture(join(directory, ".local/state/pkm-v5-recovery", `research-${randomUUID()}`));
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
  for (const area of ["notes", "skills", "papers", ".pkm"]) await mkdir(join(fixture.root, area), { mode: 0o700 });
  await writeFile(join(fixture.root, ".pkm/content-privacy.json"), JSON.stringify(installedNativeResearchBasicPrivacyPolicy), { mode: 0o600 });
  return fixture;
}
test("real branded cold Research preparation owns no installed/B1 success; forged component and wrong phase fail closed", async t => {
  const component = await componentFixture(t), args = { installed, componentFixture: component, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  await assert.rejects(prepareInstalledNativeResearchBasicFixture({ ...args, componentFixture: { ...component } }), { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  const prepared = await prepareInstalledNativeResearchBasicFixture(args);
  assert.equal(prepared.passed, undefined);
  assert.equal((await readdir(join(component.root, "papers/ResearchPublic"))).length, 4);
  await assert.rejects(verifyInstalledNativeResearchBasic({ installed, sourceFixture: prepared, component: { fixture: component, root: component.root } }),
    { code: "INSTALLED_KNOWLEDGE_MOVE_ACTUAL_PUBLIC_COMPONENT_REQUIRED" });
  await assert.rejects(verifyInstalledNativeResearchBasicB1(prepared, {}), { code: "INSTALLED_RESEARCH_VERIFIED_PHASE_REQUIRED" });
  await assert.rejects(verifyInstalledNativeResearchBasicRestored(prepared, {}), { code: "INSTALLED_RESEARCH_VERIFIED_PHASE_REQUIRED" });
  await assert.rejects(prepareInstalledNativeResearchBasicFixture(args), { code: "INSTALLED_RESEARCH_ALREADY_PREPARED" });
});
test("Research observer rejects forged/delayed ACKs; PUBLIC graph hint cannot be downgraded or widened to imaginary pagination", async t => {
  const catalog = (await u.load(installed, "native-public-original-mcp-contracts")).originalPublicMcpContracts();
  const receipt = { sourceCatalogSha256: catalog.provenance.metadataSha256 };
  assertInstalledNativeResearchBasicCatalog(catalog, receipt);
  const downgraded = structuredClone(catalog);
  downgraded.contracts.find(row => row.transportName === "paper_graph").readOnly = true;
  assert.throws(() => assertInstalledNativeResearchBasicCatalog(downgraded, receipt), /Never downgrade/);
  const widened = structuredClone(catalog);
  widened.contracts.find(row => row.transportName === "list_research").inputSchema.properties.offset = { type: "integer" };
  assert.throws(() => assertInstalledNativeResearchBasicCatalog(widened, receipt), /Exact Research contract boundary/);
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<research-observer>','exec')"],
    { input: installedNativeResearchBasicUiProgram, stdio: "pipe" });
  await assert.rejects(startInstalledNativeResearchBasicUi({ root: resolve("."), python, runId: randomUUID(), port: 9222 }),
    { code: "INSTALLED_RESEARCH_PRIVATE_DRIVER_REQUIRED" });
  const root = await owned(t, "installed-host"), runId = randomUUID(), stages = ["native-research-basic-get-slug", "native-research-basic-search-private"];
  const protocol = await createInstalledNativeResearchBasicStageProtocol({ root, runId, stages, timeoutMs: 3000 });
  const prefix = installedNativeResearchBasicUiProgram.slice(0, installedNativeResearchBasicUiProgram.indexOf("\ntry:\n"))
    .replace("from playwright.sync_api import sync_playwright\n", "");
  const code = prefix + `
class Empty:
 def count(self):return 0
class Page:
 def locator(self,_selector):return Empty()
for name in f["stages"]:
 time.sleep(.1);stage(name);complete_stage(Page(),{"stage":name,"noReview":True})
`;
  let stderr = "";
  const child = spawn(python, ["-I", "-B", "-c", code, JSON.stringify({ root, runId, stages, timeoutMs: 3000 })]);
  child.stderr.on("data", bytes => { stderr += bytes; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  void done.catch(() => {});
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await ended;
  });
  await protocol.begin(stages[0]);
  const completing = protocol.complete(stages[0]);
  await assert.rejects(protocol.begin(stages[1]), { code: "INSTALLED_RESEARCH_STAGE_PENDING_ACK" });
  await completing; await protocol.begin(stages[1]); await protocol.complete(stages[1]); await protocol.finish(); await done;
  const wrongRoot = await owned(t, "installed-host"), wrong = await createInstalledNativeResearchBasicStageProtocol({
    root: wrongRoot, runId, stages, timeoutMs: 3000,
  });
  await wrong.begin(stages[0]);
  await writeFile(join(wrongRoot, `native-research-basic-ui-ack-${stages[0]}.json`), JSON.stringify({
    schema: "pkm.installed-native-research-basic-ui-ack/v1", runId: randomUUID(), stage: stages[0], phase: "complete", noUnexpectedModal: true,
  }), { mode: 0o600 });
  await assert.rejects(wrong.complete(stages[0]), { code: "INSTALLED_RESEARCH_ACK_BINDING_MISMATCH" });
  await assert.rejects(wrong.finish(), { code: "INSTALLED_RESEARCH_STAGE_PENDING_ACK" });
});
