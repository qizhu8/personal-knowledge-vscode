import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  installedNativeSkillPaperTrashPrivacyPolicy, prepareInstalledNativeSkillPaperTrashFixture,
  verifyInstalledNativeSkillPaperTrash, verifyInstalledNativeSkillPaperTrashB1, verifyInstalledNativeSkillPaperTrashRestored,
  installedNativeSkillPaperTrashStages,
} from "./installed-native-skill-paper-trash.mjs";
import { createInstalledNativeSkillPaperTrashStageProtocol, installedNativeSkillPaperTrashUiProgram,
  startInstalledNativeSkillPaperTrashUi } from "./installed-native-skill-paper-trash-ui.mjs";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the mandatory private framework.");
assert(process.env.PKM_TEST_PYTHON); assert(process.env.PKM_LEGACY_VSIX);
const installed = resolve("clients/vscode-host"), python = process.env.PKM_TEST_PYTHON;
const recovery = await u.load(installed, "original-mcp-component-recovery");
async function fixture(t, privacy = installedNativeSkillPaperTrashPrivacyPolicy) {
  const directory = resolve("tests", `.skill-paper-trash-helper-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, ".local/state/pkm-v5-recovery"), { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.HOME;
  let componentFixture;
  try {
    process.env.HOME = directory;
    componentFixture = await recovery.createOriginalMcpColdComponentFixture(join(directory, ".local/state/pkm-v5-recovery", `pair-${randomUUID()}`));
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
  }
  for (const area of ["notes", "skills", "papers", ".pkm"]) await mkdir(join(componentFixture.root, area), { mode: 0o700 });
  await writeFile(join(componentFixture.root, "notes/Common.md"), "Original common Note.\n", { mode: 0o600 });
  await writeFile(join(componentFixture.root, ".pkm/content-privacy.json"), JSON.stringify(privacy), { mode: 0o600 });
  return componentFixture;
}
test("Skill/Paper preparation rejects DTO copies, wrong independently configured privacy and presealed roots before Original writes", async t => {
  const componentFixture = await fixture(t, { schema: 1, private: {} });
  const args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  await assert.rejects(prepareInstalledNativeSkillPaperTrashFixture({ ...args, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(prepareInstalledNativeSkillPaperTrashFixture(args), /independently configure/);
  assert.deepEqual(await readdir(join(componentFixture.root, "skills")), []);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeSkillPaperTrashFixture(args), { code: "INSTALLED_SKILL_PAPER_TRASH_PRE_B0_REQUIRED" });
});
test("closed Original-only pre-B0 Skill/Paper pairs preserve exact metadata/revision and cannot fabricate installed/B1/B0 evidence", {
  timeout: 90000,
}, async t => {
  const componentFixture = await fixture(t);
  const prepared = await prepareInstalledNativeSkillPaperTrashFixture({ installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX });
  assert.equal(prepared.passed, undefined); assert.equal(prepared.oldReadonlyBucketRestoreQualified, false);
  for (const owner of prepared.owners) {
    assert.equal(owner.revision, 2);
    assert.deepEqual(await readFile(join(componentFixture.root, owner.area, owner.pairPath, "opaque.bin")), Buffer.from([255, 0, 128, 9]));
    const prior = prepared.priorEntries.find(row => row.area === owner.area);
    const metadata = JSON.parse(await readFile(join(componentFixture.root, owner.area, ".trash", prior.id, "metadata.json")));
    assert.equal(metadata.kind, owner.kind === "skill" ? "skill" : "item");
  }
  assert.equal(await readFile(join(componentFixture.root, "notes/Common.md"), "utf8"), "Original common Note.\n");
  const args = { installed, sourceFixture: prepared, component: { fixture: componentFixture, root: componentFixture.root } };
  await assert.rejects(verifyInstalledNativeSkillPaperTrash(args), { code: "INSTALLED_SKILL_PAPER_TRASH_ACTUAL_CANONICAL_COMPONENT_REQUIRED" });
  await assert.rejects(verifyInstalledNativeSkillPaperTrash({ ...args, sourceFixture: { ...prepared } }),
    { code: "INSTALLED_SKILL_PAPER_TRASH_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeSkillPaperTrashB1(prepared, {}), { code: "INSTALLED_SKILL_PAPER_TRASH_VERIFIED_PHASE_REQUIRED" });
  await assert.rejects(verifyInstalledNativeSkillPaperTrashRestored(prepared, {}), { code: "INSTALLED_SKILL_PAPER_TRASH_VERIFIED_PHASE_REQUIRED" });
});
test("new Skill/Paper observer compiles and refuses unbranded startup without rendered evidence", async () => {
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<skill-paper-trash-ui>','exec')"],
    { input: installedNativeSkillPaperTrashUiProgram, timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
  await assert.rejects(startInstalledNativeSkillPaperTrashUi({ root: resolve("."), python, port: 9222, runId: randomUUID() }),
    { code: "INSTALLED_SKILL_PAPER_TRASH_PRIVATE_UI_REQUIRED" });
});

async function driver(t) {
  const root = resolve("tests", `.installed-host-${randomUUID()}`), cleanups = [];
  await mkdir(root, { mode: 0o700 });
  t.after(async () => { try { for (const close of cleanups) await close(); } finally { await rm(root, { recursive: true, force: true }); } });
  return { root, runId: randomUUID(), retain: close => cleanups.push(close) };
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
test("real observer protocol cannot miss fast no-review stages while delayed after the preceding modal phase", { timeout: 10000 }, async t => {
  const f = await driver(t), stages = ["native-skill-trash-stale", "native-skill-trash-missing"];
  const protocol = await createInstalledNativeSkillPaperTrashStageProtocol({ ...f, stages, timeoutMs: 3000 });
  // Execute the production filesystem protocol only; the empty page is not rendered UI evidence.
  const prefix = installedNativeSkillPaperTrashUiProgram.slice(0, installedNativeSkillPaperTrashUiProgram.indexOf("\ntry:\n"))
    .replace("from playwright.sync_api import sync_playwright\n", "");
  const program = prefix + `
class Empty:
 def count(self):return 0
class Page:
 def locator(self,_selector):return Empty()
for name in f["stages"]:
 time.sleep(.15)
 stage(name)
 complete_stage(Page(),{"stage":name,"noReview":True})
print(json.dumps({"observedStages":f["stages"]}))
`;
  let stdout = "", stderr = "";
  const child = spawn(python, ["-I", "-B", "-c", program, JSON.stringify({ ...f, timeoutMs: 3000, stages })]);
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  void done.catch(() => {});
  f.retain(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    try { await ended; } finally { clearTimeout(timer); }
  });
  await protocol.begin(stages[0]);
  const first = protocol.complete(stages[0]);
  await waitJson(f.root, "native-skill-paper-trash-ui-phase.json", value => value.phase === "work-complete");
  await assert.rejects(protocol.begin(stages[1]), { code: "INSTALLED_SKILL_PAPER_TRASH_STAGE_PENDING_ACK" });
  await first;
  await waitJson(f.root, "native-skill-paper-trash-ui-status.json", value => value.lastCompletedStage === stages[0]);
  await protocol.begin(stages[1]); await protocol.complete(stages[1]); await protocol.finish(); await done;
  assert.deepEqual(JSON.parse(stdout).observedStages, stages);
  for (const stage of stages) {
    const ack = JSON.parse(await readFile(join(f.root, `native-skill-paper-trash-ui-ack-${stage}.json`)));
    assert.equal(ack.runId, f.runId); assert.equal(ack.stage, stage); assert.equal(ack.noUnexpectedModal, true);
  }
  await assert.rejects(readFile(join(f.root, "native-skill-paper-trash-ui-passed.json")), { code: "ENOENT" });
});
test("wrong-run acknowledgements and observer failures refuse with bound stage/status evidence before advancement", async t => {
  for (const mode of ["wrong-ack", "failed-observer"]) {
    const f = await driver(t), stage = "native-paper-trash-stale";
    const protocol = await createInstalledNativeSkillPaperTrashStageProtocol({ ...f, stages: [stage], timeoutMs: 3000 });
    await protocol.begin(stage);
    const observer = { schema: "pkm.installed-native-skill-paper-trash-ui-status/v1", runId: f.runId,
      currentStage: stage, phase: "waiting-work-complete", failed: mode === "failed-observer" };
    await writeFile(join(f.root, "native-skill-paper-trash-ui-status.json"), JSON.stringify(observer), { mode: 0o600 });
    if (mode === "wrong-ack") await writeFile(join(f.root, `native-skill-paper-trash-ui-ack-${stage}.json`), JSON.stringify({
      schema: "pkm.installed-native-skill-paper-trash-ui-ack/v1", runId: randomUUID(), stage, phase: "complete", noUnexpectedModal: true,
    }), { mode: 0o600 });
    await assert.rejects(protocol.complete(stage), { code: mode === "wrong-ack"
      ? "INSTALLED_SKILL_PAPER_TRASH_ACK_BINDING_MISMATCH" : "INSTALLED_SKILL_PAPER_TRASH_OBSERVER_FAILED" });
    const failure = JSON.parse(await readFile(join(f.root, "native-skill-paper-trash-failure.json")));
    assert.equal(failure.runId, f.runId); assert.equal(failure.stage, stage); assert.deepEqual(failure.observer, observer);
    await assert.rejects(protocol.finish(), { code: "INSTALLED_SKILL_PAPER_TRASH_STAGE_PENDING_ACK" });
  }
});
test("catalog-mutating Paper listing needs its separate PUBLIC choice before the observer can acknowledge completion", { timeout: 10000 }, async t => {
  const f = await driver(t), step = installedNativeSkillPaperTrashStages.find(stage => stage.tool === "list_papers");
  const catalog = (await u.load(installed, "native-public-original-mcp-contracts")).originalPublicMcpContracts();
  const contract = catalog.contracts.find(contract => contract.transportName === step.tool);
  const protocol = await createInstalledNativeSkillPaperTrashStageProtocol({ ...f, stages: [step.stage], timeoutMs: 3000 });
  const prefix = installedNativeSkillPaperTrashUiProgram.slice(0, installedNativeSkillPaperTrashUiProgram.indexOf("\ntry:\n"))
    .replace("from playwright.sync_api import sync_playwright\n", "");
  const program = prefix + `
step=f["step"];c=f["contract"];opened=True;choices=[]
class Dialog:
 def count(self):return int(opened)
class Page:
 def locator(self,_selector):return Dialog()
page=Page();stage(step["stage"])
try:complete_stage(page,step)
except AssertionError as error:check("Unexpected modal" in str(error),"Wrong unobserved-list refusal")
else:raise AssertionError("A list PUBLIC modal must not be acknowledged without a contracted choice")
publish("mechanics-list-blocked.json",{"blockedBeforeChoice":True})
while not (root/"mechanics-list-choice.json").exists():time.sleep(.01)
data={"root":c["binding"]["root"],"workspaceId":c["binding"]["workspaceId"],"tool":step["tool"],
 "operation":c["publicContracts"][0]["operation"],"version":c["publicContracts"][0]["version"],
 "readOnly":True,"arguments":step["arguments"],"argumentsDigest":digest(step["arguments"])}
def modal(_page,title):
 check(title=="Allow PKM v5 list_papers for this exact request?","Wrong separate list title")
 return None,None,"synthetic mechanics modal",data
def choose(_page,_dialog,_handle,_text,choice,default=False):
 global opened
 choices.append(choice);opened=False
try:review_public(page,step,c)
except AssertionError:pass
else:raise AssertionError("Catalog-mutating listing cannot be downgraded to readonly")
check(opened and not choices,"Wrong hint must not authorize a choice")
data["readOnly"]=c["publicContracts"][0]["readOnly"]
review_public(page,step,c)
complete_stage(page,step)
print(json.dumps({"choices":choices,"publicDialogs":len(proof["dialogs"]),"renderedUiQualified":False}))
`;
  const input = { root: f.root, runId: f.runId, timeoutMs: 3000, step,
    contract: { binding: { root: f.root, workspaceId: randomUUID() }, publicContracts: [
      { tool: step.tool, operation: contract.id, version: contract.version, readOnly: contract.readOnly },
    ] } };
  let stdout = "", stderr = "";
  const child = spawn(python, ["-I", "-B", "-c", program, JSON.stringify(input)]);
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  void done.catch(() => {});
  f.retain(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    try { await ended; } finally { clearTimeout(timer); }
  });
  await protocol.begin(step.stage);
  let acknowledged = false;
  const complete = protocol.complete(step.stage).then(value => { acknowledged = true; return value; });
  await waitJson(f.root, "mechanics-list-blocked.json", value => value.blockedBeforeChoice);
  assert.equal(acknowledged, false);
  await assert.rejects(readFile(join(f.root, `native-skill-paper-trash-ui-ack-${step.stage}.json`)), { code: "ENOENT" });
  await writeFile(join(f.root, "mechanics-list-choice.json"), "{}", { mode: 0o600 });
  await complete; await done;
  assert.deepEqual(JSON.parse(stdout), { choices: ["Approve this request"], publicDialogs: 1, renderedUiQualified: false });
});
