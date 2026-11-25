import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { installedNativeTrashLifecycleStages } from "./installed-native-trash-lifecycle.mjs";
import { startInstalledNativeTrashLifecycleUi } from "./installed-native-trash-lifecycle-ui.mjs";

// Chromium/handshake mechanics only. No real cancellation, native port, Core or installed authority is manufactured here.
assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the real private framework.");
const python = execFileSync(process.env.PKM_TEST_PYTHON ?? "/home/yuwang8/pkm-envs/personal-knowledge-vscode-dev/bin/python",
  ["-I", "-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const hash = value => createHash("sha256").update(value).digest("hex");
const sorted = value => value && typeof value === "object" ? Array.isArray(value) ? value.map(sorted)
  : Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const digest = value => hash(JSON.stringify(sorted(value)));
async function wait(path, ready = () => true) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    try {
      const value = JSON.parse(await readFile(path));
      if (ready(value)) return value;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Lifecycle DOM evidence timed out.");
}
const html = `<!doctype html><body><script>
window.actions=[];window.index=0;window.events=[];
window.render=()=>{document.body.replaceChildren();const a=actions[index];if(!a)return;
const box=document.createElement("div");box.className="monaco-dialog-box";
const title=document.createElement("div");title.textContent=a.title;box.append(title);
const pre=document.createElement("pre");pre.textContent=JSON.stringify(a.data,null,2);box.append(pre);
for(const name of a.buttons){const b=document.createElement("button");b.textContent=name;b.onclick=()=>{events.push({index,choice:name});index++;render();};box.append(b);}
document.body.append(box);[...box.querySelectorAll("button")].find(b=>b.textContent===a.focus).focus();};
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
   a=f["actions"][index] if index<len(f["actions"]) else {"stage":"native-trash-lifecycle-complete","expected":{}}
   (root/"native-trash-lifecycle-ui-next.json").write_text(json.dumps({"stage":a["stage"],**a["expected"]}))
   (root/"progress.json").write_text(json.dumps({"stage":a["stage"]}));last=index
   (root/"events.json").write_text(json.dumps(page.evaluate("window.events")))
  ready=root/"native-trash-lifecycle-abort-ready.json";settled=root/"native-trash-lifecycle-abort-settled.json"
  if ready.exists() and not settled.exists():
   data=json.loads(ready.read_text())
   data={"runId":data["runId"],"stage":data["stage"],"operationId":data["operationId"],"requestSha256":data["requestSha256"],
    "code":"NATIVE_REQUEST_CANCELLED","settledBeforeLateClick":True}
   if f["corrupt"]=="handshake":data["operationId"]="00000000-0000-4000-8000-000000000000"
   settled.write_text(json.dumps(data))
  time.sleep(.015)
 context.close()
`;
async function run(t, corrupt = false) {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`), artifacts = resolve(".pkm-test-evidence", `.lifecycle-browser-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(artifacts, { mode: 0o700 });
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const sha = hash("DOM-mechanics-only"), runId = randomUUID(), binding = { root: `${root}/library`, workspaceId: randomUUID(),
    catalogSha256: sha, profileSha256: sha, custodyPlanSha256: sha, privacySha256: sha, epoch: randomUUID(), nativeHostReceiptSha256: sha };
  const history = { schema: 1, records: [{ path: "notes/TrashLifecycle/Archived.md", deletedAt: "2026-11-21T00:00:00.000Z" }] };
  const actions = [];
  for (const step of installedNativeTrashLifecycleStages) {
    if (step.noReview) continue;
    const expected = {};
    if (step.tool) actions.push({ stage: step.stage, expected, title: `Allow PKM v5 ${step.tool} for this exact request?`,
      buttons: ["Approve this request", "Deny", "Cancel"], focus: "Approve this request",
      data: { root: binding.root, workspaceId: binding.workspaceId, tool: step.tool, operation: `mcp.tool.${step.tool}`,
        version: 1, readOnly: false, arguments: step.arguments, argumentsDigest: digest(step.arguments) } });
    if (!step.action) continue;
    const paired = step.stage !== "native-trash-lifecycle-collision-delete", path = "TrashLifecycle/Owner.md";
    const inventory = (paired ? ["notes/TrashLifecycle/Owner.assets", "notes/TrashLifecycle/Owner.assets/opaque.bin", `notes/${path}`] : [`notes/${path}`])
      .map((path, index) => ({ path, kind: paired && index === 0 ? "directory" : "file",
        device: "1", inode: String(index + 1), mode: 384, uid: "0", gid: "0", size: "4", mtime: "1", ctime: "1",
        sha256: paired && index === 0 ? null : sha }));
    const document = { id: paired ? "knowledge_original" : "knowledge_collision", knowledgeId: paired ? "knowledge_original" : "knowledge_collision",
      revision: paired ? 2 : 1, sha256: sha };
    const operationId = randomUUID(), id = `1795219200000-${hash(operationId).slice(0, 10)}`;
    const metadata = { id, kind: "item", name: "Owner.md", originalPath: path, deletedAt: "2026-11-21T00:00:00.000Z",
      ...(paired ? { assetsPath: "TrashLifecycle/Owner.assets" } : {}) };
    const selection = { area: "notes", path, document, entryId: id, metadata,
      metadataSha256: hash(JSON.stringify(metadata, null, 2) + "\n"), inventory, treeSha256: digest(inventory),
      scanRevision: sha, readOnlyOriginalBucket: false };
    const args = { operationId, entryId: id, expectedScanRevision: sha };
    const subject = { root: binding.root, workspaceId: binding.workspaceId, catalogSha256: sha, profileSha256: sha,
      custodyPlanSha256: sha, privacySha256: sha, actorId: "mcp:external", operationId, canonicalArgumentsDigest: digest(args),
      sourceOriginalSha256: "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27",
      custodyPredecessorSha256: sha, transitionSha256: sha, historyBeforeSha256: hash(JSON.stringify(history, null, 2) + "\n"),
      historyAfterSha256: step.action === "move" ? hash(JSON.stringify({ schema: 1, records: [...history.records,
        ...[`notes/${path}`, ...(paired ? ["notes/TrashLifecycle/Owner.assets/opaque.bin"] : [])]
          .map(path => ({ path, deletedAt: metadata.deletedAt }))] }, null, 2) + "\n") : sha,
      action: step.action, operation: `knowledge.trash.${step.action}`, selection: [selection],
      ...(step.action === "move" ? { publicRequest: { tool: step.tool, version: 1, argumentsDigest: digest(step.arguments) } } : {}) };
    Object.assign(expected, step.action === "move"
      ? { path, document, inventory, paired, history, historyBeforeSha256: subject.historyBeforeSha256, predecessorSha256: sha }
      : { subject: structuredClone(subject), arguments: args });
    const request = { schema: "pkm.original-native-trash-request/v1", phase: "execute", subject,
      nativeEpoch: binding.epoch, nativeHostReceiptSha256: sha };
    const labels = { move: ["Move this exact Note to Trash once", "Move this exact public Note and paired assets to Trash?"],
      restore: ["Restore this exact Note once", "Restore this exact public Note and paired assets?"],
      list: ["Read these exact Trash entries once", "Read these exact public Note Trash entries?"] };
    actions.push({ stage: step.stage, expected, title: labels[step.action][1],
      buttons: [labels[step.action][0], "Cancel", "Deny"], focus: "Deny",
      data: { ...request, defaultDecision: "deny", requestSha256: digest(request) } });
  }
  if (corrupt === "focus") actions.find(row => row.data.subject).focus = "Move this exact Note to Trash once";
  await writeFile(join(root, "native-trash-lifecycle-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-trash-lifecycle-ui/v1", runId, binding, stages: installedNativeTrashLifecycleStages,
  }));
  await writeFile(join(root, "workbench.html"), html);
  const env = { ...process.env, TMPDIR: artifacts, TMP: artifacts, TEMP: artifacts, PYTHONDONTWRITEBYTECODE: "1" };
  const browser = spawn(python, ["-B", "-c", browserProgram, JSON.stringify({ root, artifacts, port, actions, corrupt })], { env, stdio: "inherit" });
  const browserDone = new Promise((resolve, reject) => { browser.once("error", reject); browser.once("exit", code =>
    code === 0 ? resolve() : reject(new Error(`Lifecycle browser exited ${code}`))); });
  void browserDone.catch(() => {}); let observer;
  t.after(async () => {
    try { await observer?.stop(); await writeFile(join(root, "browser-stop.json"), "{}"); await browserDone; }
    finally { await rm(root, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); }
  });
  await wait(join(root, "browser-ready.json"));
  observer = await startInstalledNativeTrashLifecycleUi({ root, python, env, port, runId, timeoutMs: 5000 });
  return { root, observer };
}
test("rendered late-click handshake validates unchanged modal and default Deny without claiming real native cancellation", {
  timeout: 55000,
}, async t => {
  const f = await run(t); await f.observer.done;
  const proof = await wait(join(f.root, "native-trash-lifecycle-ui-passed.json"));
  assert.equal(proof.actualRenderedDom, true); assert.equal(proof.actualNativeUi, undefined);
  assert.equal(proof.transportAbortedBeforeLateClick, true); assert.equal(proof.lateClickSameModal, true);
  assert.equal(proof.dialogs.length, 11); assert.equal(proof.dialogs.filter(row => row.defaultEnterDenial).length, 1);
});
test("a different operation in the abort-settled handshake refuses before the late native choice", { timeout: 55000 }, async t => {
  const f = await run(t, "handshake"); await assert.rejects(f.observer.done);
  const proof = await wait(join(f.root, "native-trash-lifecycle-ui-passed.json"));
  assert.match(proof.error, /Actual transport cancellation must settle before late click/);
  assert.equal((await wait(join(f.root, "events.json"), events => events.length > 0)).length, 1);
});
test("default focus on the affirmative control refuses before publishing late-click readiness", { timeout: 55000 }, async t => {
  const f = await run(t, "focus"); await assert.rejects(f.observer.done);
  const proof = await wait(join(f.root, "native-trash-lifecycle-ui-passed.json"));
  assert.match(proof.error, /Deny must remain default focused/);
  assert.equal((await wait(join(f.root, "events.json"), events => events.length > 0)).length, 1);
});
