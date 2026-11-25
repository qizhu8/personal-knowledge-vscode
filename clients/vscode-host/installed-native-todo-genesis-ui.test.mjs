import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { startInstalledNativeTodoGenesisUi } from "./installed-native-todo-genesis-ui.mjs";

assert(process.env.PKM_TEST_WORKSPACE);
const python = process.env.PKM_TEST_PYTHON;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
const html = `<!doctype html><script>
window.actions=[];window.index=0;window.events=[];
window.render=()=>{document.body.replaceChildren();const a=actions[index];if(!a)return;
const box=document.createElement("div");box.className="monaco-dialog-box";
const title=document.createElement("div");title.textContent=a.title;box.append(title);
const pre=document.createElement("pre");pre.textContent=JSON.stringify(a.data,null,2);box.append(pre);
for(const name of a.choices){const button=document.createElement("button");button.textContent=name;
button.onclick=()=>{events.push({index,choice:name});index++;render();};box.append(button);}document.body.append(box);};
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
 last=-1;until=time.monotonic()+30
 while time.monotonic()<until and not(root/"browser-stop.json").exists():
  if (root/"native-todo-genesis-ui-ready.json").exists() and last==-1:
   (root/"progress.json").write_text(json.dumps({"stage":"native-todo-genesis-create"}))
   page.evaluate("a=>{window.actions=a;window.render();}",f["actions"]);last=0
  if last>=0:
   index=page.evaluate("window.index")
   (root/"dom-events.json").write_text(json.dumps(page.evaluate("window.events")))
   if index==2:
    (root/"progress.json").write_text(json.dumps({"stage":"native-todo-genesis-create-done"}))
    if (root/"native-todo-genesis-ui-ack-native-todo-genesis-create.json").exists():
     (root/"progress.json").write_text(json.dumps({"stage":"native-todo-genesis-complete"}))
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
  throw new Error("Synthetic Todo observer evidence timed out.");
}
async function run(t, corrupt = false) {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`);
  const artifacts = resolve(".pkm-test-evidence", `todo-ui-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(artifacts, { mode: 0o700 });
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const runId = randomUUID(), epoch = randomUUID(), operationId = randomUUID();
  const creationArguments = { title: "InstalledFirstBoard", category: "Team" }, boardSlug = "Team/InstalledFirstBoard";
  const binding = { root: `${root}/library`, workspaceId: randomUUID(), profileSha256: "a".repeat(64) };
  const paths = { notePath: `notes/${boardSlug}.md`, pairPath: `notes/${boardSlug}.assets`,
    backingPath: `notes/${boardSlug}.assets/pkm-todo-board.json`, canonicalBoardPath: `.pkm-next-todo/${boardSlug}/pkm-todo-board.json` };
  const contract = { schema: "pkm.installed-native-todo-genesis-ui/v1", runId, binding, nativeEpoch: epoch,
    custodyPlanSha256: "b".repeat(64), catalogSha256: "c".repeat(64), nativeHostReceiptSha256: "d".repeat(64),
    privacySha256: "e".repeat(64), creationArguments, boardSlug, paths,
    stages: ["native-todo-genesis-create", "native-todo-genesis-complete"] };
  const request = { schema: "pkm.original-mcp-todo-genesis-request/v1", phase: "create", root: binding.root,
    workspaceId: binding.workspaceId, nativeEpoch: epoch, profileSha256: binding.profileSha256,
    custodyPlanSha256: contract.custodyPlanSha256, catalogSha256: contract.catalogSha256,
    nativeHostReceiptSha256: contract.nativeHostReceiptSha256, privacySha256: contract.privacySha256,
    actorId: "mcp:external", operation: "mcp.tool.todo_board_create", operationId,
    arguments: creationArguments, argumentsSha256: hash(creationArguments),
    selection: { ...paths, boardSlug, documentId: `board-${operationId}`, knowledgeId: `knowledge_${"f".repeat(24)}`, sourceId: randomUUID(),
      expectedBefore: Object.fromEntries(["note", "pair", "backing", "canonicalBoard", "canonicalDirectory"].map(key => [key, { state: "absent" }])) },
    noExecution: true, noWorkerEnrollment: true, noReviewerDelegation: true };
  request.selection.expectedBefore.sourceIndex = "absent";
  const actions = [
    { title: "Allow PKM v5 todo_board_create for this exact request?", choices: ["Approve this request", "Deny"],
      data: { ...binding, operation: "mcp.tool.todo_board_create", tool: "todo_board_create", version: 1, readOnly: false,
        arguments: creationArguments, argumentsDigest: hash(creationArguments) } },
    { title: "Create this exact public Todo Board and paired Note?", choices: ["Deny", "Create this exact Board once"],
      data: { ...request, requestSha256: hash(request), defaultDecision: "deny", permission: "Synthetic DOM mechanics only" } },
  ];
  if (corrupt) actions[1].data.selection = { ...request.selection, notePath: "notes/AnotherBoard.md" };
  await writeFile(join(root, "native-todo-genesis-ui-contract.json"), JSON.stringify(contract));
  await writeFile(join(root, "native-todo-genesis-ui-step.json"), JSON.stringify({ runId, stage: "native-todo-genesis-create",
    tool: "todo_board_create", approvalArguments: creationArguments,
    dialogs: [{ kind: "public", choice: "Approve this request" }, { kind: "genesis", choice: "Create this exact Board once" }] }));
  await writeFile(join(root, "workbench.html"), html);
  const env = { ...process.env, TMPDIR: artifacts, TMP: artifacts, TEMP: artifacts, PYTHONDONTWRITEBYTECODE: "1" };
  const browser = spawn(python, ["-B", "-c", browserProgram, JSON.stringify({ root, artifacts, port, actions })], { env, stdio: "inherit" });
  const browserDone = new Promise((resolve, reject) => {
    browser.once("error", reject); browser.once("exit", code => code === 0 ? resolve() : reject(new Error(`Synthetic Todo browser exited ${code}`)));
  });
  void browserDone.catch(() => {});
  let observer;
  t.after(async () => {
    try { await observer?.stop(); await writeFile(join(root, "browser-stop.json"), "{}"); await browserDone; }
    finally { await rm(root, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); }
  });
  await wait(join(root, "browser-ready.json"));
  observer = await startInstalledNativeTodoGenesisUi({ root, python, env, port, runId, timeoutMs: 5000 });
  return { root, observer };
}
test("Todo observer validates and chooses distinct rendered PUBLIC and genesis dialogs without manufacturing installed authority", { timeout: 45000 }, async t => {
  const f = await run(t); await f.observer.done;
  const proof = await wait(join(f.root, "native-todo-genesis-ui-passed.json"));
  assert.equal(proof.actualRenderedDom, true); assert.equal(proof.actualNativeUi, undefined);
  assert.deepEqual(proof.dialogs.map(row => row.choice), ["Approve this request", "Create this exact Board once"]);
  assert.equal((await wait(join(f.root, "dom-events.json"))).length, 2);
});
test("Todo observer rejects a changed paired destination before clicking the genesis affirmative choice", { timeout: 45000 }, async t => {
  const f = await run(t, true); await assert.rejects(f.observer.done);
  const proof = await wait(join(f.root, "native-todo-genesis-ui-passed.json"));
  assert.match(proof.error, /Wrong paired genesis path/);
  assert.deepEqual((await wait(join(f.root, "dom-events.json"))).map(row => row.choice), ["Approve this request"]);
});
