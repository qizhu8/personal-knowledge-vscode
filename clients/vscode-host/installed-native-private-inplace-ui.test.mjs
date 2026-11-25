import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import test from "node:test";
import { privateResourcePublicationDigest as digest } from "../../dist/private-resource-publication-contracts.js";
import { installedNativePrivateInplaceSteps } from "./installed-native-private-inplace.mjs";
import { startInstalledNativePrivateInplaceUi } from "./installed-native-private-inplace-ui.mjs";

// Actual Chromium mechanics only; no installed producer/private grant authority is fabricated.
assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1");
const python = execFileSync(process.env.PKM_TEST_PYTHON ?? "python3", ["-I", "-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
async function wait(path) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    try { return JSON.parse(await readFile(path)); } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("In-place DOM evidence timed out");
}
const html = `<!doctype html><body><script>
window.actions=[];window.index=0;window.events=[];
window.render=()=>{document.body.replaceChildren();const a=actions[index];if(!a)return;
const box=document.createElement("div");box.className="monaco-dialog-box";
const title=document.createElement("div");title.textContent=a.title;box.append(title);
const pre=document.createElement("pre");pre.textContent=JSON.stringify(a.data,null,2);box.append(pre);
for(const name of ["Deny","Approve this request"]){const b=document.createElement("button");b.textContent=name;
b.onclick=()=>{events.push(name);index++;render();};box.append(b);}document.body.append(box);};
</script>`;
const browserProgram = String.raw`
import json,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);last=-1
with sync_playwright() as p:
 context=p.chromium.launch_persistent_context(str(Path(f["artifacts"])/"profile"),headless=True,
  args=["--remote-debugging-port="+str(f["port"]),"--remote-debugging-address=127.0.0.1","--proxy-server=http://127.0.0.1:1","--proxy-bypass-list=127.0.0.1"])
 page=context.pages[0];page.goto((root/"workbench.html").as_uri());page.wait_for_load_state("networkidle")
 page.evaluate("v=>{window.actions=v;window.render();}",f["actions"]);(root/"browser-ready.json").write_text('{"ready":true}')
 until=time.monotonic()+30
 while time.monotonic()<until and not (root/"browser-stop.json").exists():
  index=page.evaluate("window.index")
  if index!=last:
   stage=f["actions"][index]["stage"] if index<len(f["actions"]) else "native-private-inplace-complete"
   (root/"progress.json").write_text(json.dumps({"stage":stage}));last=index
   (root/"events.json").write_text(json.dumps(page.evaluate("window.events")))
  time.sleep(.025)
 context.close()
`;
async function run(t, privateDialog) {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`), artifacts = resolve(".pkm-test-evidence", `.inplace-browser-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(artifacts, { mode: 0o700 });
  const server = createServer(); await new Promise(r => server.listen(0, "127.0.0.1", r)); const port = server.address().port; await new Promise(r => server.close(r));
  const runId = randomUUID(), binding = { root: `${root}/library`, workspaceId: randomUUID() };
  const contents = Object.fromEntries(["note", "skill", "paper"].map(kind => [kind, `Stored public ${kind}\n![existing](../Private/_assets/a.PNG)\n`]));
  const steps = installedNativePrivateInplaceSteps(contents);
  const actions = steps.map(step => ({ stage: step.stage, title: `Allow PKM v5 ${step.tool} for this exact request?`,
    data: { ...binding, tool: step.tool, operation: `mcp.tool.${step.tool}`, readOnly: false, version: 1,
      arguments: step.arguments, argumentsDigest: digest(step.arguments) } }));
  if (privateDialog) actions[1].title = "Publish this exact private resource into public document assets?";
  await writeFile(join(root, "native-private-inplace-ui-contract.json"), JSON.stringify({ schema: "pkm.installed-native-private-inplace-ui/v1", runId, binding, steps }));
  await writeFile(join(root, "workbench.html"), html);
  const env = { ...process.env, TMPDIR: artifacts, TMP: artifacts, TEMP: artifacts, PYTHONDONTWRITEBYTECODE: "1" };
  const browser = spawn(python, ["-B", "-c", browserProgram, JSON.stringify({ root, artifacts, port, actions })], { env, stdio: "inherit" });
  const browserDone = new Promise((r, j) => { browser.once("error", j); browser.once("exit", c => c === 0 ? r() : j(new Error(`Browser exit ${c}`))); }); void browserDone.catch(() => {});
  let ui;
  t.after(async () => { try { await ui?.stop(); await writeFile(join(root, "browser-stop.json"), "{}"); await browserDone; }
    finally { await rm(root, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); } });
  await wait(join(root, "browser-ready.json")); ui = await startInstalledNativePrivateInplaceUi({ root, python, env, port, runId, timeoutMs: 5000 });
  return { root, ui, steps };
}
test("eleven rendered public choices accept stored private link text without any private publication modal or installed-consent claim", { timeout: 45000 }, async t => {
  const f = await run(t, false); await f.ui.done;
  const proof = await wait(join(f.root, "native-private-inplace-ui-passed.json"));
  assert.equal(proof.actualRenderedDom, true); assert.equal(proof.actualNativeUi, undefined); assert.equal(proof.observedPrivateResourceDialogs, 0);
  assert.deepEqual(await wait(join(f.root, "events.json")), f.steps.map(step => step.choice));
});
test("unexpected private resource dialog is refused before its choice in the public-only in-place profile", { timeout: 45000 }, async t => {
  const f = await run(t, true); await assert.rejects(f.ui.done);
  assert.match((await wait(join(f.root, "native-private-inplace-ui-passed.json"))).error, /Wrong exact Knowledge move modal title/);
  assert.deepEqual(await wait(join(f.root, "events.json")), ["Deny"]);
});
