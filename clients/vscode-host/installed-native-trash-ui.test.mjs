import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { installedNativeTrashStages, installedNativeTrashPublicRequest } from "./installed-native-trash.mjs";
import { startInstalledNativeTrashUi } from "./installed-native-trash-ui.mjs";

// Actual Chromium mechanics only; synthetic descriptors never enter a native port, Core or installed qualification.
assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the existing real private framework.");
const python = execFileSync(process.env.PKM_TEST_PYTHON ?? "/home/yuwang8/pkm-envs/personal-knowledge-vscode-dev/bin/python",
  ["-I", "-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => value && typeof value === "object"
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
async function wait(path) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    try { return JSON.parse(await readFile(path)); } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Trash DOM evidence timed out.");
}
const html = `<!doctype html><body><script>
window.actions=[];window.index=0;window.events=[];
window.advance=choice=>{events.push({index,choice});index++;render();};
window.render=()=>{document.body.replaceChildren();const a=actions[index];if(!a)return;
const box=document.createElement("div");box.className="monaco-dialog-box";
const title=document.createElement("div");title.textContent=a.title;box.append(title);
const pre=document.createElement("pre");pre.textContent=JSON.stringify(a.data,null,2);box.append(pre);
for(const name of a.buttons){const b=document.createElement("button");b.textContent=name;b.onclick=()=>advance(name);box.append(b);}
document.body.append(box);[...box.querySelectorAll("button")].find(b=>b.textContent===a.focus).focus();};
document.addEventListener("keydown",event=>{if(event.key==="Escape"){event.preventDefault();advance("Escape");}});
</script>`;
const browserProgram = String.raw`
import json,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);last=-1
with sync_playwright() as p:
 context=p.chromium.launch_persistent_context(str(Path(f["artifacts"])/"profile"),headless=True,
  args=["--remote-debugging-port="+str(f["port"]),"--remote-debugging-address=127.0.0.1",
        "--proxy-server=http://127.0.0.1:1","--proxy-bypass-list=127.0.0.1"])
 page=context.pages[0];page.goto((root/"workbench.html").as_uri());page.wait_for_load_state("networkidle")
 page.evaluate("value=>{window.actions=value;window.render();}",f["actions"])
 (root/"browser-ready.json").write_text('{"ready":true}');until=time.monotonic()+40
 while time.monotonic()<until and not (root/"browser-stop.json").exists():
  index=page.evaluate("window.index")
  if index!=last:
   a=f["actions"][index] if index<len(f["actions"]) else {"stage":"native-trash-complete","expected":{}}
   (root/"native-trash-ui-next.json").write_text(json.dumps({"stage":a["stage"],**a["expected"]}))
   (root/"progress.json").write_text(json.dumps({"stage":a["stage"]}));last=index
   (root/"events.json").write_text(json.dumps(page.evaluate("window.events")))
  time.sleep(.015)
 context.close()
`;
async function run(t, corrupt) {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`), artifacts = resolve(".pkm-test-evidence", `.trash-browser-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(artifacts, { mode: 0o700 });
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const sha = hash("synthetic-DOM-only"), runId = randomUUID(), binding = { root: `${root}/library`, workspaceId: randomUUID(),
    catalogSha256: sha, profileSha256: sha, custodyPlanSha256: sha, privacySha256: sha, epoch: randomUUID(), nativeHostReceiptSha256: sha };
  const owner = { id: "knowledge_0123456789abcdef01234567", knowledgeId: "knowledge_0123456789abcdef01234567",
    revision: 2, sha256: sha, path: "TrashFixture/Owner.md", area: "notes" };
  const inventory = ["notes/TrashFixture/Owner.assets", "notes/TrashFixture/Owner.assets/opaque.bin", "notes/TrashFixture/Owner.md"]
    .map((path, index) => ({ path, kind: index === 0 ? "directory" : "file", device: "1", inode: String(index + 1),
      mode: index === 0 ? 448 : 384, uid: "0", gid: "0", size: index === 0 ? "4096" : "4", mtime: "1", ctime: "1",
      sha256: index === 0 ? null : sha }));
  const originalHistory = { schema: 1, records: [{ path: "notes/TrashFixture/Archived.md", deletedAt: "2026-11-21T00:00:00.000Z" }] };
  const removedPaths = ["notes/TrashFixture/Owner.md", "notes/TrashFixture/Owner.assets/opaque.bin"];
  const beforeSha = hash(JSON.stringify(originalHistory, null, 2) + "\n"), actions = [];
  for (const step of installedNativeTrashStages) {
    if (step.noReview) continue;
    const expected = { predecessorSha256: sha, historyBeforeSha256: beforeSha };
    if (step.publicChoice) actions.push({ stage: step.stage, expected, title: "Allow PKM v5 delete_note for this exact request?",
      buttons: ["Approve this request", "Deny", "Cancel"], focus: "Approve this request",
      data: { root: binding.root, workspaceId: binding.workspaceId, tool: "delete_note", operation: "mcp.tool.delete_note",
        version: 1, readOnly: false, arguments: installedNativeTrashPublicRequest.arguments,
        argumentsDigest: digest(installedNativeTrashPublicRequest.arguments) } });
    if (!step.action) continue;
    const operationId = randomUUID(), id = `1795219200000-${hash(operationId).slice(0, 10)}`;
    const metadata = { id, kind: "item", name: "Owner.md", originalPath: owner.path,
      deletedAt: "2026-11-21T00:00:00.000Z", assetsPath: "TrashFixture/Owner.assets" };
    const selection = { area: "notes", path: owner.path, document: Object.fromEntries(["id", "knowledgeId", "revision", "sha256"].map(key => [key, owner[key]])),
      entryId: id, metadata, metadataSha256: hash(JSON.stringify(metadata, null, 2) + "\n"),
      inventory, treeSha256: digest(inventory), scanRevision: sha, readOnlyOriginalBucket: false };
    const args = step.action === "list" ? { area: "notes", entryIds: [id], operationId }
      : { operationId, entryId: id, expectedScanRevision: sha };
    const subject = { root: binding.root, workspaceId: binding.workspaceId, custodyPlanSha256: sha,
      catalogSha256: sha, profileSha256: sha, privacySha256: sha, actorId: "mcp:external", operationId,
      canonicalArgumentsDigest: digest(args), sourceOriginalSha256: "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27",
      custodyPredecessorSha256: sha, transitionSha256: sha, historyBeforeSha256: beforeSha,
      historyAfterSha256: step.action === "move" ? hash(JSON.stringify({ schema: 1, records: [...originalHistory.records,
        ...removedPaths.map(path => ({ path, deletedAt: metadata.deletedAt }))] }, null, 2) + "\n") : beforeSha,
      action: step.action, operation: `knowledge.trash.${step.action}`, selection: [selection],
      ...(step.action === "move" ? { publicRequest: { tool: "delete_note", version: 1,
        argumentsDigest: digest(installedNativeTrashPublicRequest.arguments) } } : {}) };
    if (step.action !== "move") Object.assign(expected, { subject: structuredClone(subject), arguments: args });
    const request = { schema: "pkm.original-native-trash-request/v1", phase: "execute", subject,
      nativeHostReceiptSha256: sha, nativeEpoch: binding.epoch };
    const labels = { move: ["Move this exact Note to Trash once", "Move this exact public Note and paired assets to Trash?"],
      list: ["Read these exact Trash entries once", "Read these exact public Note Trash entries?"],
      restore: ["Restore this exact Note once", "Restore this exact public Note and paired assets?"] };
    actions.push({ stage: step.stage, expected, title: labels[step.action][1], buttons: [labels[step.action][0], "Cancel", "Deny"],
      focus: "Deny", data: { ...request, defaultDecision: "deny", requestSha256: digest(request) } });
  }
  if (corrupt === "focus") actions.find(action => action.data.subject).focus = "Move this exact Note to Trash once";
  if (corrupt === "scope") {
    const action = actions.find(action => action.data.subject?.action === "list");
    action.data.subject.selection[0].document.revision = 99;
    const { defaultDecision, requestSha256, ...request } = action.data; action.data.requestSha256 = digest(request);
  }
  await writeFile(join(root, "native-trash-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-trash-ui/v1", runId, binding, stages: installedNativeTrashStages,
    publicRequest: installedNativeTrashPublicRequest, owner, inventory, removedPaths, originalHistory, originalHistorySha256: beforeSha,
  }));
  await writeFile(join(root, "workbench.html"), html);
  const env = { ...process.env, TMPDIR: artifacts, TMP: artifacts, TEMP: artifacts, PYTHONDONTWRITEBYTECODE: "1" };
  const browser = spawn(python, ["-B", "-c", browserProgram, JSON.stringify({ root, artifacts, port, actions })], { env, stdio: "inherit" });
  const browserDone = new Promise((resolve, reject) => {
    browser.once("error", reject); browser.once("exit", code => code === 0 ? resolve() : reject(new Error(`Browser exited ${code}`)));
  });
  void browserDone.catch(() => {}); let observer;
  t.after(async () => {
    try { await observer?.stop(); await writeFile(join(root, "browser-stop.json"), "{}"); await browserDone; }
    finally { await rm(root, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); }
  });
  await wait(join(root, "browser-ready.json"));
  observer = await startInstalledNativeTrashUi({ root, python, env, port, runId, timeoutMs: 5000 });
  return { root, observer };
}
test("eleven rendered public/Trash choices enforce default-focused native denial and honest Escape mechanics without installed authority", {
  timeout: 55000,
}, async t => {
  const f = await run(t); await f.observer.done;
  const proof = await wait(join(f.root, "native-trash-ui-passed.json"));
  assert.equal(proof.actualRenderedDom, true); assert.equal(proof.actualNativeUi, undefined);
  assert.equal(proof.dialogs.length, 11);
  assert.equal(proof.dialogs.filter(row => row.type === "trash").length, 8);
  assert.equal(proof.dialogs.filter(row => row.defaultEnterDenial).length, 3);
  assert.equal(proof.dialogs.filter(row => row.modalDismissal).length, 1);
  assert.equal((await wait(join(f.root, "events.json"))).length, 11);
});
test("a rehashed but different selected Note revision refuses before a scoped list choice", { timeout: 55000 }, async t => {
  const f = await run(t, "scope"); await assert.rejects(f.observer.done);
  const proof = await wait(join(f.root, "native-trash-ui-passed.json"));
  assert.match(proof.error, /Wrong exact selected bucket\/history\/source\/target scope/);
  assert.equal((await wait(join(f.root, "events.json"))).length, 5);
});
test("a modal default-focused on movement refuses before the first Trash action", { timeout: 55000 }, async t => {
  const f = await run(t, "focus"); await assert.rejects(f.observer.done);
  const proof = await wait(join(f.root, "native-trash-ui-passed.json"));
  assert.match(proof.error, /Trash Deny must be focused by default/);
  assert.equal((await wait(join(f.root, "events.json"))).length, 2);
});
