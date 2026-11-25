import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { privateResourcePublicationDigest as digest } from "../../dist/private-resource-publication-contracts.js";
import { startInstalledNativePrivateResourceLifecycleUi } from "./installed-native-private-resource-lifecycle-ui.mjs";

// Actual Chromium/wall-clock mechanics, not installed producer consent or Core cancellation.
assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1");
const python = execFileSync(process.env.PKM_TEST_PYTHON ?? "python3", ["-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
async function wait(path, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { return JSON.parse(await readFile(path)); } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Lifecycle mechanics handshake timed out");
}
const html = `<!doctype html><body><script>
window.actions=[];window.index=0;window.events=[];
window.render=()=>{document.body.replaceChildren();const a=actions[index];if(!a)return;
const box=document.createElement("div");box.className="monaco-dialog-box";
const title=document.createElement("div");title.textContent=a.title;box.append(title);
const pre=document.createElement("pre");pre.textContent=JSON.stringify(a.data,null,2);box.append(pre);
for(const name of a.buttons){const b=document.createElement("button");b.textContent=name;
b.onclick=()=>{events.push({index,choice:name});index++;render();};box.append(b);}document.body.append(box);
[...box.querySelectorAll("button")].find(b=>b.textContent===a.defaultFocus).focus();};
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
 (root/"browser-ready.json").write_text('{"ready":true}');until=time.monotonic()+210
 while time.monotonic()<until and not (root/"browser-stop.json").exists():
  index=page.evaluate("window.index")
  if index!=last:
   stage=f["actions"][index]["stage"] if index<len(f["actions"]) else "native-private-resource-lifecycle-complete"
   (root/"progress.json").write_text(json.dumps({"stage":stage}));last=index
   (root/"events.json").write_text(json.dumps(page.evaluate("window.events")))
  time.sleep(.025)
 context.close()
`;
async function run(t, dangerous) {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`), artifacts = resolve(".pkm-test-evidence", `.lifecycle-browser-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(artifacts, { mode: 0o700 });
  const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve)); const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const runId = randomUUID(), sha = digest("synthetic-DOM-only");
  const binding = { root: `${root}/library`, workspaceId: randomUUID(), catalogSha256: sha, profileSha256: sha,
    custodyPlanSha256: sha, privacySha256: sha, epoch: randomUUID(), nativeHostReceiptSha256: sha };
  const owner = { area: "notes", id: "knowledge_0123456789abcdef01234567", beforePath: "Old/Before.md", afterPath: "New/After.md", revision: 1, sha256: sha };
  const resources = ["a.PNG","b.BIN","c.BIN"].map(name => ({ sourcePath: `Private/_assets/${name}`, sha256: sha, size: 1,
    sourceIdentity: `DOM-only-${name}`, targetPath: `New/After.assets/${sha.slice(0,16)}${name.endsWith("PNG") ? ".png" : ".bin"}` }));
  const args = { slug: "Old/Before", title: "After", category: "New" }, steps = ["cancel","expiry","publish"].map(mode => ({ mode, stage: `native-private-resource-lifecycle-${mode}` }));
  const actions = [];
  for (const step of steps) {
    actions.push({ stage: step.stage, title: "Allow PKM v5 update_note for this exact request?", buttons: ["Approve this request","Deny"], defaultFocus: "Deny",
      data: { root: binding.root, workspaceId: binding.workspaceId, tool: "update_note", operation: "mcp.tool.update_note", version: 1, readOnly: false,
        arguments: args, argumentsDigest: digest(args) } });
    const operationId = randomUUID();
    for (let index = 0; index < (step.mode === "cancel" ? 2 : 3); index++) {
      const request = { schema: "pkm.private-resource-publication/v1", phase: "publish", nativeEpoch: binding.epoch, nativeHostReceiptSha256: sha,
        subject: { root: binding.root, workspaceId: binding.workspaceId, catalogSha256: sha, profileSha256: sha, custodyPlanSha256: sha, privacySha256: sha,
          operationId, canonicalArgumentsDigest: sha, actorId: "mcp:external", operation: "knowledge.note.update", owner, resource: resources[index],
          publicRequest: { tool: "update_note", version: 1, argumentsDigest: digest(args) }, preservePrivateSource: true, oneResourceOneOperation: true } };
      actions.push({ stage: step.stage, title: "Publish this exact private resource into public document assets?",
        buttons: ["Publish this exact resource once","Cancel","Deny"], defaultFocus: dangerous ? "Publish this exact resource once" : "Deny",
        data: { ...request, defaultDecision: "deny", requestSha256: digest(request) } });
    }
  }
  await writeFile(join(root, "native-private-resource-lifecycle-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-private-resource-lifecycle-ui/v1", runId, binding, owner, resources, arguments: args, steps,
  }));
  await writeFile(join(root, "workbench.html"), html);
  const env = { ...process.env, TMPDIR: artifacts, TMP: artifacts, TEMP: artifacts, PYTHONDONTWRITEBYTECODE: "1" };
  const browser = spawn(python, ["-B","-c",browserProgram,JSON.stringify({ root, artifacts, port, actions })], { env, stdio: "inherit" });
  const browserDone = new Promise((resolve, reject) => { browser.once("error", reject); browser.once("exit", code => code === 0 ? resolve() : reject(new Error(`Browser exited ${code}`))); });
  void browserDone.catch(() => {}); let observer;
  t.after(async () => { try { await observer?.stop(); await writeFile(join(root, "browser-stop.json"), "{}"); await browserDone; }
    finally { await rm(root, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); } });
  await wait(join(root, "browser-ready.json"));
  observer = await startInstalledNativePrivateResourceLifecycleUi({ root, python, env, port, runId, timeoutMs: 240000 });
  return { root, observer, runId };
}
test("real Chromium performs cancel handshake and two genuine 65-second review waits with no mocked clock or installed-consent claim", { timeout: 220000 }, async t => {
  const f = await run(t, false), ready = await wait(join(f.root, "native-private-resource-lifecycle-cancel-ready.json"));
  // This acknowledges synthetic DOM mechanics only; production helper instead requires the actual component's cancellation error.
  await writeFile(join(f.root, "native-private-resource-lifecycle-cancel-observed.json"), JSON.stringify({
    runId: f.runId, operationId: ready.request.subject.operationId, code: "NATIVE_REQUEST_CANCELLED",
  }));
  await f.observer.done;
  const proof = await wait(join(f.root, "native-private-resource-lifecycle-ui-passed.json"));
  assert.equal(proof.actualRenderedDom, true); assert.equal(proof.actualNativeUi, undefined); assert.equal(proof.clockMocked, false);
  assert.equal(proof.dialogs.length, 11); assert(proof.dialogs.find(row => row.afterCancellation));
  const aged = proof.dialogs.filter(row => row.mode === "expiry" && row.type === "resource");
  assert(aged[1].actualWaitMs >= 65000 && aged[2].actualWaitMs >= 65000 && aged[2].elapsedSinceFirstMs >= 130000);
});
test("publication-focused native-shaped dialog is refused before any private action even with reordered controls", { timeout: 45000 }, async t => {
  const f = await run(t, true); await assert.rejects(f.observer.done);
  assert.match((await wait(join(f.root, "native-private-resource-lifecycle-ui-passed.json"))).error, /Private Deny must be genuinely focused/);
  assert.equal((await wait(join(f.root, "events.json"))).length, 1);
});
