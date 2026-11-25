import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  installedNativeNotePaperBasicPrivacyPolicy, prepareInstalledNativeNotePaperBasicFixture,
  verifyInstalledNativeNotePaperBasic, verifyInstalledNativeNotePaperBasicB1, verifyInstalledNativeNotePaperBasicRestored,
  assertInstalledNativeNotePaperBasicCatalog,
} from "./installed-native-note-paper-basic.mjs";
import {
  createInstalledNativeNotePaperBasicStageProtocol, installedNativeNotePaperBasicUiProgram,
  startInstalledNativeNotePaperBasicUi,
} from "./installed-native-note-paper-basic-ui.mjs";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";
import { createInstalledNotePaperBasicOracle } from "../../tests/installed-note-paper-basic-oracle.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the mandatory private Linux framework.");
assert(process.env.PKM_TEST_PYTHON); assert(process.env.PKM_LEGACY_VSIX);
const installed = resolve("clients/vscode-host"), python = process.env.PKM_TEST_PYTHON;
const recovery = await u.load(installed, "original-mcp-component-recovery");
async function fixture(t, privacy = installedNativeNotePaperBasicPrivacyPolicy) {
  const directory = resolve("tests", `.note-paper-basic-helper-${randomUUID()}`);
  await mkdir(join(directory, ".local/state/pkm-v5-recovery"), { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.HOME;
  let componentFixture;
  try {
    process.env.HOME = directory;
    componentFixture = await recovery.createOriginalMcpColdComponentFixture(
      join(directory, ".local/state/pkm-v5-recovery", `basic-${randomUUID()}`));
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
  }
  for (const area of ["notes", "skills", "papers", ".pkm"]) await mkdir(join(componentFixture.root, area), { mode: 0o700 });
  await writeFile(join(componentFixture.root, "notes/Entry.md"), "Common original Entry.\n", { mode: 0o600 });
  await writeFile(join(componentFixture.root, "skills/Base.md"), "Common original Base.\n", { mode: 0o600 });
  await writeFile(join(componentFixture.root, ".pkm/content-privacy.json"), JSON.stringify(privacy), { mode: 0o600 });
  return componentFixture;
}
test("cold Note/Paper preparation refuses foreign identities, wrong independent privacy and presealed Roots before Original writes", async t => {
  const componentFixture = await fixture(t, { schema: 1, private: {} });
  const args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  await assert.rejects(prepareInstalledNativeNotePaperBasicFixture({ ...args, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(prepareInstalledNativeNotePaperBasicFixture(args), /independently configure/);
  assert.deepEqual(await readdir(join(componentFixture.root, "notes")), ["Entry.md"]);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeNotePaperBasicFixture(args), { code: "INSTALLED_NOTE_PAPER_BASIC_PRE_B0_REQUIRED" });
});
test("pinned Original cold basic oracle executes real create/default/duplicate/occupied/lexical behavior without manufacturing installed/B1 proof", {
  timeout: 120000,
}, async t => {
  const componentFixture = await fixture(t), privacy = await readFile(join(componentFixture.root, ".pkm/content-privacy.json"));
  const args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  const prepared = await prepareInstalledNativeNotePaperBasicFixture(args);
  assert.equal(prepared.passed, undefined);
  assert.deepEqual(await readFile(join(componentFixture.root, ".pkm/content-privacy.json")), privacy);
  assert.equal(await readFile(join(componentFixture.root, "notes/Entry.md"), "utf8"), "Common original Entry.\n");
  for (const owner of prepared.owners) {
    await assert.rejects(readFile(join(componentFixture.root, owner.area, `${owner.slug}.md`)), { code: "ENOENT" });
    assert(prepared.files.some(file => file.path === `${owner.area}/Private/BasicPrivate${owner.kind === "note" ? "Note" : "Paper"}.md`));
  }
  const verify = { installed, sourceFixture: prepared, component: { fixture: componentFixture, root: componentFixture.root } };
  await assert.rejects(verifyInstalledNativeNotePaperBasic(verify), { code: "INSTALLED_KNOWLEDGE_MOVE_ACTUAL_PUBLIC_COMPONENT_REQUIRED" });
  await assert.rejects(verifyInstalledNativeNotePaperBasic({ ...verify, sourceFixture: { ...prepared } }),
    { code: "INSTALLED_NOTE_PAPER_BASIC_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeNotePaperBasicB1(prepared, {}), { code: "INSTALLED_NOTE_PAPER_BASIC_VERIFIED_PHASE_REQUIRED" });
  await assert.rejects(verifyInstalledNativeNotePaperBasicRestored(prepared, {}), { code: "INSTALLED_NOTE_PAPER_BASIC_VERIFIED_PHASE_REQUIRED" });
  await assert.rejects(prepareInstalledNativeNotePaperBasicFixture(args), { code: "INSTALLED_NOTE_PAPER_BASIC_ALREADY_PREPARED" });
});
test("closed Original executor rejects the admitted/foreign Root and preserves Original default lexical Paper metadata-only behavior", {
  timeout: 120000,
}, async t => {
  const directory = resolve("tests", `.note-paper-closed-oracle-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 }); t.after(() => rm(directory, { recursive: true, force: true }));
  const oracle = await createInstalledNotePaperBasicOracle({ directory, python, legacyVsix: process.env.PKM_LEGACY_VSIX });
  const foreign = join(directory, "foreign"); await mkdir(foreign, { mode: 0o700 });
  await assert.rejects(oracle.invoke("add_note", { title: "NotWritten", content: "No." }, foreign),
    { code: "INSTALLED_NOTE_PAPER_CLOSED_ORACLE_ROOT_REQUIRED" });
  assert.deepEqual(await readdir(foreign), []);
  assert.deepEqual(await oracle.invoke("add_paper", { title: "ClosedBasic", topic: "uniquemetadata", content: "uniquebodyonly\n" }),
    { ok: true, slug: "ClosedBasic" });
  assert.deepEqual(await oracle.invoke("search_papers", { query: "uniquebodyonly" }), []);
  assert.equal((await oracle.invoke("search_papers", { query: "uniquemetadata" }))[0].slug, "ClosedBasic");
  const read = await oracle.invoke("get_paper", { slug: "ClosedBasic" });
  assert.equal(read.category, ""); assert.deepEqual(read.authors, []); assert.equal(read.file, "");
});
async function driver(t) {
  const root = resolve("tests", `.installed-host-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 }); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, runId: randomUUID() };
}
async function waitJson(root, name, predicate) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    try { const value = JSON.parse(await readFile(join(root, name))); if (predicate(value)) return value; }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Mechanics did not reach ${name}`);
}
test("actual observer synchronization ACKs every delayed no-review stage and rejects forged runs/failure before advancement", {
  timeout: 15000,
}, async t => {
  const f = await driver(t), stages = ["native-note-paper-basic-note-get-created", "native-note-paper-basic-note-private-filter"];
  const protocol = await createInstalledNativeNotePaperBasicStageProtocol({ ...f, stages, timeoutMs: 3000 });
  const prefix = installedNativeNotePaperBasicUiProgram.slice(0, installedNativeNotePaperBasicUiProgram.indexOf("\ntry:\n"))
    .replace("from playwright.sync_api import sync_playwright\n", "");
  const program = prefix + `
class Empty:
 def count(self):return 0
class Page:
 def locator(self,_selector):return Empty()
for name in f["stages"]:
 time.sleep(.15);stage(name);complete_stage(Page(),{"stage":name,"noReview":True})
print(json.dumps({"stages":f["stages"],"renderedUiQualified":False}))
`;
  let stdout = "", stderr = "";
  const child = spawn(python, ["-I", "-B", "-c", program, JSON.stringify({ ...f, timeoutMs: 3000, stages })]);
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  void done.catch(() => {});
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    try { await ended; } finally { clearTimeout(timer); }
  });
  await protocol.begin(stages[0]);
  const completing = protocol.complete(stages[0]);
  await waitJson(f.root, "native-note-paper-basic-ui-phase.json", value => value.phase === "work-complete");
  await assert.rejects(protocol.begin(stages[1]), { code: "INSTALLED_NOTE_PAPER_BASIC_STAGE_PENDING_ACK" });
  await completing; await protocol.begin(stages[1]); await protocol.complete(stages[1]); await protocol.finish(); await done;
  assert.deepEqual(JSON.parse(stdout), { stages, renderedUiQualified: false });
  for (const mode of ["wrong-ack", "observer-failed"]) {
    const f = await driver(t), stage = stages[0];
    const protocol = await createInstalledNativeNotePaperBasicStageProtocol({ ...f, stages: [stage], timeoutMs: 3000 });
    await protocol.begin(stage);
    const observer = { schema: "pkm.installed-native-note-paper-basic-ui-status/v1", runId: f.runId,
      failed: mode === "observer-failed", phase: "waiting-work-complete" };
    await writeFile(join(f.root, "native-note-paper-basic-ui-status.json"), JSON.stringify(observer), { mode: 0o600 });
    if (mode === "wrong-ack") await writeFile(join(f.root, `native-note-paper-basic-ui-ack-${stage}.json`), JSON.stringify({
      schema: "pkm.installed-native-note-paper-basic-ui-ack/v1", runId: randomUUID(), stage, phase: "complete", noUnexpectedModal: true,
    }), { mode: 0o600 });
    await assert.rejects(protocol.complete(stage), { code: mode === "wrong-ack"
      ? "INSTALLED_NOTE_PAPER_BASIC_ACK_BINDING_MISMATCH" : "INSTALLED_NOTE_PAPER_BASIC_OBSERVER_FAILED" });
    const failure = JSON.parse(await readFile(join(f.root, "native-note-paper-basic-failure.json")));
    assert.deepEqual(failure.observer, observer); assert.equal(failure.runId, f.runId); assert.equal(failure.stage, stage);
    await assert.rejects(protocol.finish(), { code: "INSTALLED_NOTE_PAPER_BASIC_STAGE_PENDING_ACK" });
  }
});
test("exact installed catalog rejects Paper list hint downgrade and invented public CAS parameters; new UI compiles but unsafe drivers do not start", async () => {
  const catalog = (await u.load(installed, "native-public-original-mcp-contracts")).originalPublicMcpContracts();
  const receipt = { sourceCatalogSha256: catalog.provenance.metadataSha256 };
  assertInstalledNativeNotePaperBasicCatalog(catalog, receipt);
  const downgraded = structuredClone(catalog);
  downgraded.contracts.find(contract => contract.transportName === "list_papers").readOnly = true;
  assert.throws(() => assertInstalledNativeNotePaperBasicCatalog(downgraded, receipt), /not catalog-readonly/);
  const missing = structuredClone(catalog);
  delete missing.contracts.find(contract => contract.transportName === "update_note").inputSchema.properties.slug;
  assert.throws(() => assertInstalledNativeNotePaperBasicCatalog(missing, receipt), /Never invent/);
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<note-paper-basic-ui>','exec')"],
    { input: installedNativeNotePaperBasicUiProgram, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
  await assert.rejects(startInstalledNativeNotePaperBasicUi({ root: resolve("."), python, port: 9222, runId: randomUUID() }),
    { code: "INSTALLED_NOTE_PAPER_BASIC_PRIVATE_DRIVER_REQUIRED" });
});
