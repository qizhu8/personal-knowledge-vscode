import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { installedNativeTodoRecoveryUiProgram, startInstalledNativeTodoRecoveryUi } from "../clients/vscode-host/installed-native-todo-recovery-ui.mjs";
import { createInstalledNativeTodoRecoveryFaultController, installedNativeTodoRecoveryFaultInjector,
  prepareInstalledNativeTodoRecoveryFixture, reopenInstalledNativeTodoRecovery } from "../clients/vscode-host/installed-native-todo-recovery.mjs";
import { pinnedOriginalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";

assert(process.env.PKM_TEST_WORKSPACE, "Use the private framework.");
const python = process.env.PKM_TEST_PYTHON;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
const html = `<!doctype html><script>
window.events=[];window.render=a=>{document.body.replaceChildren();
const dialog=document.createElement("div");dialog.className="monaco-dialog-box";
const title=document.createElement("div");title.textContent=a.title;dialog.append(title);
const data=document.createElement("pre");data.textContent=JSON.stringify(a.data,null,2);dialog.append(data);
for(const name of ["Recover this exact Board once","Deny"]){const b=document.createElement("button");b.textContent=name;
b.onclick=()=>{events.push(name);dialog.remove();};dialog.append(b);}
document.body.append(dialog);dialog.querySelectorAll("button")[1].focus();};
</script>`;
const browserProgram = String.raw`
import json,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"])
with sync_playwright() as p:
 context=p.chromium.launch_persistent_context(str(Path(f["artifacts"])/"profile"),headless=True,
  args=["--remote-debugging-port="+str(f["port"]),"--remote-debugging-address=127.0.0.1",
   "--proxy-server=http://127.0.0.1:1","--proxy-bypass-list=127.0.0.1"])
 page=context.pages[0];page.goto((root/"workbench.html").as_uri());page.wait_for_load_state("networkidle")
 (root/"browser-ready.json").write_text('{"ready":true}')
 shown=False;until=time.monotonic()+30
 while time.monotonic()<until and not(root/"browser-stop.json").exists():
  if not shown and (root/("native-todo-recovery-"+f["runId"]+"-ui-ready.json")).exists():
   page.evaluate("action=>window.render(action)",f["action"]);shown=True
  if shown:(root/"dom-events.json").write_text(json.dumps(page.evaluate("window.events")))
  time.sleep(.015)
 context.close()
`;
async function wait(path) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    try { return JSON.parse(await readFile(path)); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Synthetic Todo recovery DOM evidence timed out.");
}
async function run(t, wrongEpoch = false) {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`);
  const artifacts = resolve(".pkm-test-evidence", `todo-recovery-dom-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(artifacts, { mode: 0o700 });
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const runId = randomUUID(), epoch = randomUUID(), operationId = randomUUID();
  const args = { title: "InstalledPendingGenesis", category: "Team" }, slug = "Team/InstalledPendingGenesis";
  const paths = { notePath: `notes/${slug}.md`, pairPath: `notes/${slug}.assets`,
    backingPath: `notes/${slug}.assets/pkm-todo-board.json`, canonicalBoardPath: `.pkm-next-todo/${slug}/pkm-todo-board.json` };
  const binding = { root: `${root}/library`, workspaceId: randomUUID(), profileSha256: "a".repeat(64),
    custodyPlanSha256: "b".repeat(64), catalogSha256: "c".repeat(64), privacySha256: "d".repeat(64) };
  const selection = { ...paths, boardSlug: slug, documentId: `board-${operationId}`, sourceId: randomUUID(),
    descriptorSha256: "e".repeat(64), backingSha256: "f".repeat(64),
    expectedBefore: { note: { state: "present", sha256: "e".repeat(64) }, backing: { state: "present", sha256: "f".repeat(64) },
      pair: { state: "present", sha256: "1".repeat(64) }, canonicalBoard: { state: "absent" },
      canonicalDirectory: { state: "present", sha256: "2".repeat(64) }, sourceIndex: "absent" } };
  const request = { ...binding, schema: "pkm.original-mcp-todo-genesis-request/v1", phase: "recover",
    nativeEpoch: wrongEpoch ? randomUUID() : epoch, nativeHostReceiptSha256: "3".repeat(64),
    operation: "mcp.tool.todo_board_create", actorId: "mcp:external", operationId, arguments: args,
    argumentsSha256: hash(args), selection, noExecution: true, noWorkerEnrollment: true, noReviewerDelegation: true };
  await writeFile(join(root, "workbench.html"), html);
  await writeFile(join(root, `native-todo-recovery-${runId}-ui-contract.json`), JSON.stringify({
    schema: "pkm.installed-native-todo-recovery-ui/v1", runId, decision: "deny", binding, creationArguments: args,
    boardSlug: slug, paths, operationId, selection,
  }));
  await writeFile(join(root, `native-todo-recovery-${runId}-host.json`), JSON.stringify({ runId, epoch, receiptSha256: "3".repeat(64) }));
  const action = { title: "Recover this exact public Todo Board creation?",
    data: { ...request, requestSha256: hash(request), defaultDecision: "deny" } };
  const env = { ...process.env, TMPDIR: artifacts, TMP: artifacts, TEMP: artifacts, PYTHONDONTWRITEBYTECODE: "1" };
  const browser = spawn(python, ["-B", "-c", browserProgram, JSON.stringify({ root, artifacts, port, runId, action })],
    { env, stdio: "inherit" });
  const done = new Promise((resolve, reject) => {
    browser.once("error", reject); browser.once("exit", code => code === 0 ? resolve() : reject(new Error(`Synthetic recovery browser exited ${code}`)));
  });
  void done.catch(() => {});
  let ui;
  t.after(async () => {
    try { await ui?.stop(); await writeFile(join(root, "browser-stop.json"), "{}"); await done; }
    finally { await rm(root, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); }
  });
  await wait(join(root, "browser-ready.json"));
  ui = await startInstalledNativeTodoRecoveryUi({ root, python, env, port, runId, decision: "deny", timeoutMs: 5000 });
  return { root, runId, ui };
}
test("recovery observer default Enter follows actual Deny focus despite affirmative-first DOM order", { timeout: 45000 }, async t => {
  const f = await run(t); await f.ui.done;
  const proof = await wait(join(f.root, `native-todo-recovery-${f.runId}-ui-passed.json`));
  assert.equal(proof.passed, true); assert.equal(proof.defaultDenyFocused, true); assert.equal(proof.defaultEnterDenial, true);
  assert.deepEqual(await wait(join(f.root, "dom-events.json")), ["Deny"]);
  assert.equal(proof.realInstalledExtension, undefined, "Synthetic DOM mechanics never manufacture installed proof.");
});
test("recovery observer refuses an old epoch before either native choice even with an otherwise exact signed-shape descriptor", { timeout: 45000 }, async t => {
  const f = await run(t, true); await assert.rejects(f.ui.done);
  const proof = await wait(join(f.root, `native-todo-recovery-${f.runId}-ui-passed.json`));
  assert.match(proof.error, /actual fresh current signed Host\/epoch/);
  assert.deepEqual(await wait(join(f.root, "dom-events.json")), []);
});
test("recovery helpers reject serialized preparations/controllers and embedded Python compiles without emission", async () => {
  assert.throws(() => createInstalledNativeTodoRecoveryFaultController({ kind: "pkm.installed-native-todo-recovery-fixture/v1" }),
    { code: "INSTALLED_TODO_RECOVERY_ACTUAL_PREPARATION_REQUIRED" });
  assert.throws(() => installedNativeTodoRecoveryFaultInjector({ kind: "pkm.installed-native-todo-recovery-controller/v1" }),
    { code: "INSTALLED_TODO_RECOVERY_ACTUAL_CONTROLLER_REQUIRED" });
  await assert.rejects(reopenInstalledNativeTodoRecovery({ sourceFixture: { approved: true }, installed: "/untrusted" }),
    { code: "INSTALLED_TODO_RECOVERY_ACTUAL_PREPARATION_REQUIRED" });
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<todo-recovery-ui>','exec')"],
    { input: installedNativeTodoRecoveryUiProgram, env: process.env });
});
test("recovery preparation uses a disjoint pinned Original extraction beneath a genuine branded fixture without touching common leaf controls", async t => {
  const directory = join(homedir(), ".local/state/pkm-v5-recovery", `rh-${randomUUID().slice(0, 8)}`);
  const installed = resolve("clients/vscode-host");
  const recovery = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-component-recovery.js")).href);
  const componentFixture = await recovery.createOriginalMcpColdComponentFixture(directory);
  t.after(() => rm(directory, { recursive: true }));
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory, legacyVsix: process.env.PKM_LEGACY_VSIX, python });
  writer.run(componentFixture.root, "store.noteUpsert({slug:'Entry',title:'Entry',content:'ACTUAL_POST_PRELUDE_CONTROL',tags:[],type:'general'});return store.noteGet('Entry');");
  await mkdir(join(componentFixture.root, "skills"), { mode: 0o700 });
  await writeFile(join(componentFixture.root, "skills/Base.md"), "---\ntitle: Base\n---\nACTUAL_POST_PRELUDE_SKILL", { mode: 0o600 });
  await writeFile(join(componentFixture.root, ".pkm/content-privacy.json"), '{"schema":1,"private":{"notes":["Private"]}}', { mode: 0o600 });
  const before = await Promise.all(["notes/Entry.md", "skills/Base.md", ".pkm/content-privacy.json"].map(path => readFile(join(componentFixture.root, path))));
  const f = await prepareInstalledNativeTodoRecoveryFixture({ installed, componentFixture, legacyVsix: process.env.PKM_LEGACY_VSIX, python });
  assert.deepEqual(await Promise.all(["notes/Entry.md", "skills/Base.md", ".pkm/content-privacy.json"].map(path => readFile(join(componentFixture.root, path)))), before);
  assert.equal(f.root, componentFixture.root);
  const controller = createInstalledNativeTodoRecoveryFaultController(f);
  assert.equal(typeof installedNativeTodoRecoveryFaultInjector(controller), "function");
  assert.throws(() => installedNativeTodoRecoveryFaultInjector(structuredClone(controller)), { code: "INSTALLED_TODO_RECOVERY_ACTUAL_CONTROLLER_REQUIRED" });
  await assert.rejects(prepareInstalledNativeTodoRecoveryFixture({ installed, componentFixture, legacyVsix: process.env.PKM_LEGACY_VSIX, python }),
    { code: "INSTALLED_TODO_RECOVERY_ALREADY_PREPARED" });
  assert.equal(await readFile(join(directory, "release/package.json"), "utf8"), await readFile(join(directory, "todo-recovery-oracle-fixture/release/package.json"), "utf8"));
});
