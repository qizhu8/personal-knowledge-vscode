import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  prepareInstalledNativeKnowledgeRecovery, verifyInstalledNativeKnowledgeRecovery,
  verifyInstalledNativeKnowledgeRecoveryB1, verifyInstalledNativeKnowledgeRecoveryRestored,
  assertInstalledNativeKnowledgeRecoverySchemaPreserved,
} from "./installed-native-knowledge-recovery-normal.mjs";
import {
  installedNativeKnowledgeRecoveryStageNames as stages, installedNativeKnowledgeRecoveryUiProgram,
  createInstalledNativeKnowledgeRecoveryStageProtocol, startInstalledNativeKnowledgeRecoveryUi,
} from "./installed-native-knowledge-recovery-ui.mjs";
import {
  installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u,
} from "./installed-native-knowledge-move.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Run through the mandatory private Linux framework.");
assert(process.env.PKM_TEST_PYTHON); assert(process.env.PKM_LEGACY_VSIX);
const installed = resolve("clients/vscode-host"), python = process.env.PKM_TEST_PYTHON;
const recovery = await u.load(installed, "original-mcp-component-recovery");
async function fixture(t) {
  const directory = resolve("tests", `.recovery-normal-helper-${randomUUID()}`);
  await mkdir(join(directory, ".local/state/pkm-v5-recovery"), { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.HOME;
  let componentFixture;
  try {
    process.env.HOME = directory;
    componentFixture = await recovery.createOriginalMcpColdComponentFixture(
      join(directory, ".local/state/pkm-v5-recovery", `recovery-${randomUUID()}`));
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
  }
  for (const area of ["notes", "skills", "papers", ".pkm"]) await mkdir(join(componentFixture.root, area), { mode: 0o700 });
  await writeFile(join(componentFixture.root, "notes/Entry.md"), "Original pre-B0 Entry.\n", { mode: 0o600 });
  await writeFile(join(componentFixture.root, "skills/Base.md"), "Original pre-B0 Base.\n", { mode: 0o600 });
  await writeFile(join(componentFixture.root, ".pkm/content-privacy.json"), JSON.stringify(installedNativeKnowledgeMovePrivacyPolicy), { mode: 0o600 });
  return componentFixture;
}
async function driver(t) {
  const root = resolve("tests", `.installed-host-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 }); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, runId: randomUUID(), timeoutMs: 3000, stages };
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
test("branded pre-B0 recovery uses real sealed22 preview/apply and refuses copies, physical private namespaces and unverified B1", {
  timeout: 120000,
}, async t => {
  const componentFixture = await fixture(t), args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  await assert.rejects(prepareInstalledNativeKnowledgeRecovery({ ...args, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await mkdir(join(componentFixture.root, "skills/Private"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeKnowledgeRecovery(args));
  assert.deepEqual(await readdir(join(componentFixture.root, "notes")), ["Entry.md"]);
  await rm(join(componentFixture.root, "skills/Private"), { recursive: true });
  const preparation = await prepareInstalledNativeKnowledgeRecovery(args);
  assert.equal(preparation.passed, undefined);
  assert.equal(await readFile(join(componentFixture.root, "notes/Entry.md"), "utf8"), "Original pre-B0 Entry.\n");
  const oracle = join(componentFixture.directory, "recovery-original22-oracle");
  assert.deepEqual(await readFile(join(oracle, preparation.ownerPath)), await readFile(join(componentFixture.root, preparation.ownerPath)));
  const options = { installed, sourceFixture: preparation, component: { fixture: componentFixture, root: componentFixture.root } };
  await assert.rejects(verifyInstalledNativeKnowledgeRecovery(options), { code: "INSTALLED_KNOWLEDGE_MOVE_ACTUAL_PUBLIC_COMPONENT_REQUIRED" });
  await assert.rejects(verifyInstalledNativeKnowledgeRecovery({ ...options, sourceFixture: { ...preparation } }),
    { code: "INSTALLED_RECOVERY_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeKnowledgeRecoveryB1(preparation, {}), { code: "INSTALLED_RECOVERY_VERIFIED_PHASE_REQUIRED" });
  await assert.rejects(verifyInstalledNativeKnowledgeRecoveryRestored(preparation, {}), { code: "INSTALLED_RECOVERY_VERIFIED_PHASE_REQUIRED" });
  await assert.rejects(prepareInstalledNativeKnowledgeRecovery(args), { code: "INSTALLED_RECOVERY_ALREADY_PREPARED" });
});
test("Recovery observer mechanics ACK all seven stages, including wronghash and occupied refusal, before advancement", {
  timeout: 15000,
}, async t => {
  const f = await driver(t), protocol = await createInstalledNativeKnowledgeRecoveryStageProtocol(f);
  const prefix = installedNativeKnowledgeRecoveryUiProgram.slice(0, installedNativeKnowledgeRecoveryUiProgram.indexOf("\ntry:\n"))
    .replace("from playwright.sync_api import sync_playwright,expect\n", "");
  const program = prefix + `
class Empty:
 def count(self):return 0
class Page:
 def locator(self,_):return Empty()
for name in f["stages"]:
 time.sleep(.05);stage(name);complete_stage(Page(),{"stage":name})
print(json.dumps({"acknowledged":len(f["stages"]),"genuineUiOrSourceQualified":False}))
`;
  let stdout = "", stderr = "";
  const child = spawn(python, ["-I", "-B", "-c", program, JSON.stringify(f)]);
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
  for (const [i, name] of stages.entries()) {
    await protocol.begin(name); const completing = protocol.complete(name);
    await waitJson(f.root, "native-knowledge-recovery-ui-phase.json", value => value.stage === name && value.phase === "work-complete");
    if (i + 1 < stages.length)
      await assert.rejects(protocol.begin(stages[i + 1]), { code: "INSTALLED_RECOVERY_STAGE_PENDING_ACK" });
    await completing;
  }
  await protocol.finish(); await done;
  assert.deepEqual(JSON.parse(stdout), { acknowledged: 7, genuineUiOrSourceQualified: false });
});
test("failed observer is rejected before invocation and forged run/picker ACK cannot advance or finish", async t => {
  for (const mode of ["failed-before-begin", "wrong-run", "missing-picker-witness", "failed-before-complete"]) {
    const f = await driver(t), protocol = await createInstalledNativeKnowledgeRecoveryStageProtocol(f);
    const failed = mode.startsWith("failed");
    const status = { schema: "pkm.installed-native-knowledge-recovery-ui-status/v1", runId: f.runId, failed, phase: "test-only" };
    if (mode !== "failed-before-begin") await protocol.begin(stages[0]);
    await writeFile(join(f.root, "native-knowledge-recovery-ui-status.json"), JSON.stringify(status), { mode: 0o600 });
    if (!failed) await writeFile(join(f.root, `native-knowledge-recovery-ui-ack-${stages[0]}.json`), JSON.stringify({
      schema: "pkm.installed-native-knowledge-recovery-ui-ack/v1", runId: mode === "wrong-run" ? randomUUID() : f.runId,
      stage: stages[0], phase: "complete", noUnexpectedModal: true, noUnexpectedPicker: mode !== "missing-picker-witness",
    }), { mode: 0o600 });
    await assert.rejects(mode === "failed-before-begin" ? protocol.begin(stages[0]) : protocol.complete(stages[0]),
      { code: failed ? "INSTALLED_RECOVERY_OBSERVER_FAILED" : "INSTALLED_RECOVERY_ACK_BINDING_MISMATCH" });
    const failure = JSON.parse(await readFile(join(f.root, "native-knowledge-recovery-failure.json")));
    assert.deepEqual(failure.observer, status); assert.equal(failure.runId, f.runId);
    await assert.rejects(protocol.finish(), { code: "INSTALLED_RECOVERY_STAGE_PENDING_ACK" });
  }
});
test("Deny Enter witnesses the actual activeElement, independent of button order; unsafe UI contracts never start", async t => {
  const f = await driver(t);
  await assert.rejects(createInstalledNativeKnowledgeRecoveryStageProtocol({ ...f, stages: stages.slice(0, -1) }),
    { code: "INSTALLED_RECOVERY_SEVEN_STAGES_REQUIRED" });
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<recovery-ui>','exec')"],
    { input: installedNativeKnowledgeRecoveryUiProgram, stdio: "pipe", timeout: 10000 });
  await assert.rejects(startInstalledNativeKnowledgeRecoveryUi({ root: resolve("."), runId: randomUUID(), python, port: 9222 }),
    { code: "INSTALLED_RECOVERY_PRIVATE_DRIVER_REQUIRED" });
  const prefix = installedNativeKnowledgeRecoveryUiProgram.slice(0, installedNativeKnowledgeRecoveryUiProgram.indexOf("\ntry:\n"))
    .replace("from playwright.sync_api import sync_playwright,expect\n", "");
  const mechanics = prefix + `
class Handle:
 def evaluate(self,_):return True
class Text:
 def wait_for(self,**_):pass
class Button:
 def __init__(self,page,name):self.page=page;self.name=name
 def count(self):return 1
 def is_visible(self):return True
 def is_enabled(self):return True
 def focus(self):
  if self.page.focusWorks:self.page.active=self
 def evaluate(self,code):
  check("document.activeElement" in code,"Focus must use actual activeElement")
  return self.page.active is self
class Dialog:
 def __init__(self,page):
  self.page=page
  self.buttons={"Read selected evidence only":Button(page,"Read selected evidence only"),"Deny":Button(page,"Deny")}
 def get_by_text(self,*_,**__):return Text()
 def count(self):return 1
 def element_handle(self):return Handle()
 def evaluate(self,*_):return True
 def inner_text(self):return "Synthetic UI mechanics only\\n"+json.dumps(data)
 def get_by_role(self,role,name,exact):
  check(role=="button" and exact,"Only exact named choice allowed");return self.buttons[name]
class Page:
 def __init__(self,works):
  self.focusWorks=works;self.active=None;self.pressed=False;self.keyboard=self;self.dialog=Dialog(self)
 def locator(self,_):return self.dialog
 def press(self,key):
  check(key=="Enter" and self.active is self.dialog.buttons["Deny"],"Enter must target actual Deny")
  self.pressed=True
 def wait_for_function(self,*_,**__):check(self.pressed,"No Enter denial observed")
c={"binding":{"root":"/synthetic/knowledge"},"evidence":"/synthetic/evidence","directoryIdentity":{"synthetic":True}}
data={"directory":c["evidence"],"directoryIdentity":c["directoryIdentity"],"requestSha256":"a"*64,
 "scope":"One Note/Skill Markdown plan only. No Knowledge writes, audit writes, private/Paper/assets/fullRoot or repair authority."}
step={"tool":"knowledge_recovery_preview","stage":"recovery-deny-source","sourceChoice":"Deny"}
broken=Page(False)
try:review(broken,step,c,"source");raise RuntimeError("Unfocused Enter guard absent")
except AssertionError as error:check("actually own focus" in str(error),"Unexpected failure")
check(not broken.pressed,"Unfocused Enter must never fire")
working=Page(True);review(working,step,c,"source")
check(working.pressed and proof["dialogs"][-1]["focusedEnterDenial"],"Missing focus witness")
print(json.dumps({"activeElementGuard":True,"genuineUiOrSourceQualified":False}))
`;
  const result = JSON.parse(execFileSync(python, ["-I", "-B", "-c", mechanics, JSON.stringify(f)],
    { encoding: "utf8", stdio: "pipe", timeout: 10000 }));
  assert.deepEqual(result, { activeElementGuard: true, genuineUiOrSourceQualified: false });
});
test("real SQLite Recovery autoindexes are scoped to exact declared tables; unknown objects and control-index changes stay visible", () => {
  const recoveryStatePromise = u.load(installed, "original-knowledge-recovery-state");
  return recoveryStatePromise.then(recoveryState => {
    const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all().map(row => ({ ...row }));
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE control(id INTEGER PRIMARY KEY,label TEXT UNIQUE); CREATE INDEX control_label ON control(label);");
      const before = schema(db);
      db.exec(recoveryState.ORIGINAL_RECOVERY_PHASE1_DDL);
      const after = schema(db);
      assert(after.some(row => row.type === "index" && row.sql === null && row.tbl_name === "original_native_recovery_commits"),
        "Exercise actual SQLite-created indexes, not hand-authored expected schema rows.");
      assertInstalledNativeKnowledgeRecoverySchemaPreserved(before, after, recoveryState.ORIGINAL_RECOVERY_PHASE1_DDL);
      assertInstalledNativeKnowledgeRecoverySchemaPreserved(after, after, recoveryState.ORIGINAL_RECOVERY_PHASE1_DDL);
      db.exec("DROP INDEX control_label");
      assert.throws(() => assertInstalledNativeKnowledgeRecoverySchemaPreserved(before, schema(db), recoveryState.ORIGINAL_RECOVERY_PHASE1_DDL),
        /non-Recovery schema object/);
      db.exec("CREATE INDEX control_label ON control(label)");
      for (const [add, remove] of [
        ["CREATE INDEX unrelated_recovery_index ON original_native_recovery_commits(workspace_id)", "DROP INDEX unrelated_recovery_index"],
        ["CREATE TRIGGER unrelated_recovery_trigger AFTER INSERT ON original_native_recovery_intents BEGIN SELECT 1; END", "DROP TRIGGER unrelated_recovery_trigger"],
        ["CREATE TABLE original_native_recovery_unknown(id INTEGER PRIMARY KEY)", "DROP TABLE original_native_recovery_unknown"],
        ["CREATE TABLE unrelated_control(id INTEGER PRIMARY KEY)", "DROP TABLE unrelated_control"],
      ]) {
        db.exec(add);
        assert.throws(() => assertInstalledNativeKnowledgeRecoverySchemaPreserved(before, schema(db), recoveryState.ORIGINAL_RECOVERY_PHASE1_DDL));
        db.exec(remove);
      }
      db.exec("PRAGMA user_version=23");
      assert.throws(() => recoveryState.verifyOriginalRecoveryState(db, "/synthetic-schema-only-no-custody"),
        { code: "RECOVERY_REQUIRED" }, "Schema equality alone must never authorize an orphan Recovery domain.");
    } finally { db.close(); }
  });
});
