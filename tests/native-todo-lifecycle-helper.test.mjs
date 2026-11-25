import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { installedNativeTodoLifecycleUiProgram, startInstalledNativeTodoLifecycleUi } from "../clients/vscode-host/installed-native-todo-lifecycle-ui.mjs";
import { installedNativeTodoLifecyclePrivacyPolicy, prepareInstalledNativeTodoLifecycleFixture,
  verifyInstalledNativeTodoLifecycle } from "../clients/vscode-host/installed-native-todo-lifecycle.mjs";

const run = promisify(execFile);
const mechanics = String.raw`
import ast,hashlib,json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);module=ast.parse(f["program"])
functions=ast.Module(body=[node for node in module.body if isinstance(node,ast.FunctionDef) and node.name in ["check","digest","modal","stable","choose"]],type_ignores=[])
exec(compile(functions,"todo-lifecycle-observer-functions","exec"))
with sync_playwright() as p:
 context=p.chromium.launch_persistent_context(f["profile"],headless=True)
 try:
  page=context.pages[0];page.set_default_timeout(1000)
  page.set_content("<html><body><script>window.choices=[];window.show=(denyFirst,focus)=>{document.querySelectorAll('.monaco-dialog-box').forEach(n=>n.remove());const node=document.createElement('section');node.className='monaco-dialog-box';const title=document.createElement('h1');title.textContent='Exact source phase';node.append(title);const pre=document.createElement('pre');pre.textContent=JSON.stringify({phase:'activate-source',defaultDecision:'deny'});node.append(pre);for(const name of denyFirst?['Deny','Activate this exact Board source']:['Activate this exact Board source','Deny']){const button=document.createElement('button');button.textContent=name;button.onclick=()=>{window.choices.push(name);node.remove()};node.append(button)}document.body.append(node);Array.from(node.querySelectorAll('button')).find(b=>b.textContent===focus).focus()}</script></body></html>")
  page.wait_for_load_state("networkidle")
  page.evaluate("show(false,'Deny')")
  dialog,handle,text,data=modal(page,"Exact source phase")
  choose(page,dialog,handle,text,"Deny")
  assert page.evaluate("choices")==["Deny"],"Focused second-button Deny must work with Enter independently of DOM order"
  page.evaluate("show(true,'Activate this exact Board source')")
  dialog,handle,text,data=modal(page,"Exact source phase")
  try:choose(page,dialog,handle,text,"Deny")
  except AssertionError as error:assert "Default-focused" in str(error)
  else:raise AssertionError("DOM-first unfocused Deny must not qualify")
  assert page.evaluate("choices")==["Deny"]
  page.evaluate("show(false,'Deny')")
  dialog,handle,text,data=modal(page,"Exact source phase")
  page.evaluate("window.transportSettled={code:'NATIVE_REQUEST_CANCELLED'}")
  stable(dialog,handle,text)
  choose(page,dialog,handle,text,"Activate this exact Board source")
  assert page.evaluate("choices")==["Deny","Activate this exact Board source"]
  page.evaluate("show(false,'Deny')")
  dialog,handle,text,data=modal(page,"Exact source phase")
  page.evaluate("show(false,'Deny')")
  try:choose(page,dialog,handle,text,"Activate this exact Board source")
  except AssertionError as error:assert "replaced" in str(error)
  else:raise AssertionError("Replacement modal cannot qualify as retained late-choice DOM")
  assert page.evaluate("choices")==["Deny","Activate this exact Board source"]
  page.evaluate("show(false,'Deny')")
  dialog,handle,text,data=modal(page,"Exact source phase")
  page.evaluate("document.querySelector('pre').textContent=JSON.stringify({phase:'recover',defaultDecision:'deny'})")
  try:choose(page,dialog,handle,text,"Activate this exact Board source")
  except AssertionError as error:assert "changed" in str(error)
  else:raise AssertionError("Changed descriptor cannot qualify as the original source request")
  print(json.dumps({"passed":True,"scope":"headless observer mechanics only, NOT installed acceptance","focusedDenyIndependentOfDomOrder":True,"retainedNodeRequired":True,"descriptorStableRequired":True}))
 finally:context.close()
`;

test("new Todo observer uses actual headless DOM focus and retained-node checks, never DOM-order Deny or a replacement late-choice modal", { timeout: 60000 }, async t => {
  assert(process.env.PKM_TEST_WORKSPACE, "Run through the private test framework.");
  assert(process.env.PKM_TEST_PYTHON);
  const directory = resolve(".pkm-test-evidence", `todo-lifecycle-browser-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { stdout } = await run(process.env.PKM_TEST_PYTHON, ["-B", "-c", mechanics, JSON.stringify({
    program: installedNativeTodoLifecycleUiProgram, profile: join(directory, "chromium"),
  })], { env: process.env, timeout: 50000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.equal(result.passed, true); assert.equal(result.retainedNodeRequired, true);
  t.diagnostic(result.scope);
});

test("new installed leaf refuses unbranded component/evidence and an unsafe observer directory before native execution", async t => {
  assert(process.env.PKM_TEST_WORKSPACE);
  const directory = resolve(".pkm-test-evidence", `todo-lifecycle-unbranded-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(verifyInstalledNativeTodoLifecycle({ root: directory, installed: directory,
    component: { root: directory, approved: true }, sourceFixture: { root: directory } }),
  { code: "INSTALLED_TODO_LIFECYCLE_PREPARED_PHASE_REQUIRED" });
  await assert.rejects(startInstalledNativeTodoLifecycleUi({ root: directory, python: process.env.PKM_TEST_PYTHON,
    port: 1, runId: randomUUID(), timeoutMs: 1000 }), { code: "INSTALLED_TODO_LIFECYCLE_PRIVATE_UI_REQUIRED" });
});

test("Original22 lifecycle preparation isolates its closed oracle writer, preserves 0664 controls in a private Root and leaves the native Board absent before B0", { timeout: 90000 }, async t => {
  assert(process.env.PKM_TEST_WORKSPACE, "Run through the existing private framework.");
  assert(process.env.PKM_TEST_PYTHON);
  assert(process.env.PKM_LEGACY_VSIX, "The pinned Original22 archive is mandatory; never skip.");
  const installed = resolve("clients/vscode-host");
  const recovery = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-component-recovery.js")).href);
  const parent = join(homedir(), ".local/state/pkm-v5-recovery");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const fixture = await recovery.createOriginalMcpColdComponentFixture(join(parent, `todo-lifecycle-prep-${randomUUID()}`));
  const identity = await lstat(fixture.directory, { bigint: true });
  t.after(async () => {
    const current = await lstat(fixture.directory, { bigint: true });
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino); assert.equal(current.uid, identity.uid);
    await rm(fixture.directory, { recursive: true });
  });
  for (const path of ["notes", "skills", ".pkm"]) await mkdir(join(fixture.root, path), { mode: 0o700 });
  const controls = [
    ["notes/Entry.md", "---\ntitle: Entry\n---\nCOMMON_LIFECYCLE_ENTRY_UNCHANGED\n"],
    ["skills/Base.md", "---\ntitle: Base\n---\nCOMMON_LIFECYCLE_SKILL_UNCHANGED\n"],
  ];
  for (const [path, bytes] of controls) {
    await writeFile(join(fixture.root, path), bytes, { mode: 0o664 });
    await chmod(join(fixture.root, path), 0o664);
  }
  const privacy = Buffer.from(JSON.stringify(installedNativeTodoLifecyclePrivacyPolicy));
  await writeFile(join(fixture.root, ".pkm/content-privacy.json"), privacy, { mode: 0o600 });
  const prepared = await prepareInstalledNativeTodoLifecycleFixture({
    installed, componentFixture: fixture, python: process.env.PKM_TEST_PYTHON, legacyVsix: process.env.PKM_LEGACY_VSIX,
  });
  assert.equal((await lstat(fixture.root)).mode & 0o777, 0o700);
  for (const [path, bytes] of controls) {
    assert.equal(await readFile(join(fixture.root, path), "utf8"), bytes);
    const stat = await lstat(join(fixture.root, path));
    assert.equal(stat.mode & 0o777, 0o664); assert.equal(stat.nlink, 1); assert.equal(stat.uid, process.getuid());
  }
  assert.deepEqual(await readFile(join(fixture.root, ".pkm/content-privacy.json")), privacy);
  assert.deepEqual(await readdir(join(fixture.root, "notes/Team")), ["TodoGenesisCategoryEntry.md"]);
  assert((await readFile(join(fixture.root, "notes/Private/TodoGenesisControl.md"), "utf8")).includes("PRIVATE_TODO_GENESIS_CONTROL"));
  for (const path of [join(fixture.directory, "b0"), join(fixture.directory, "custody"),
    ...["core.sqlite", ".pkm-next-original-mcp.json", ".pkm-next-todo", "boards", ...Object.values(prepared.paths)]
      .map(path => join(fixture.root, path))]) await assert.rejects(lstat(path), { code: "ENOENT" });
  const releaseDirectory = join(fixture.directory, "todo-lifecycle-original-release");
  const oracleRoot = join(releaseDirectory, "oracle");
  assert.equal((await lstat(releaseDirectory)).mode & 0o777, 0o700);
  assert.equal((await lstat(oracleRoot)).mode & 0o777, 0o700);
  const firstWriter = await readFile(join(fixture.directory, "release/dist/knowledge/filestore.js"));
  assert.deepEqual(await readFile(join(releaseDirectory, "release/dist/knowledge/filestore.js")), firstWriter);
  const oracleBoard = JSON.parse(await readFile(join(oracleRoot, prepared.paths.backingPath), "utf8"));
  assert.deepEqual(oracleBoard.items, []);
  assert((await readFile(join(oracleRoot, prepared.paths.notePath), "utf8")).includes("todo-board"));
  assert.equal(prepared.noBoardBeforeB0, true); assert.equal(prepared.passed, undefined);
  t.diagnostic("Preparation-only Original22 closed oracle; no B0 capture, Owner, native network or manufactured grant.");
});
