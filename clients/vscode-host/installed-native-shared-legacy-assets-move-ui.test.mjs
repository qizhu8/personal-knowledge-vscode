import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { installedSharedLegacyMoveSteps } from "./installed-native-shared-legacy-assets-move.mjs";
import { startInstalledNativeSharedLegacyAssetsMoveUi } from "./installed-native-shared-legacy-assets-move-ui.mjs";

// Synthetic real Chromium/DOM mechanics only, not installed/native qualification.
assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1");
const python = execFileSync(process.env.PKM_TEST_PYTHON ?? "python3", ["-B", "-c", "import sys;print(sys.executable)"],
  { encoding: "utf8" }).trim();
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
async function wait(path) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    try { return JSON.parse(await readFile(path)); } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Shared DOM evidence timed out: ${path}`);
}
const html = `<!doctype html><body><script>
window.actions=[];window.index=0;window.events=[];
window.render=()=>{document.body.replaceChildren();const a=actions[index];if(!a)return;
const box=document.createElement("div");box.className="monaco-dialog-box";
const title=document.createElement("div");title.textContent=a.title;box.append(title);
const pre=document.createElement("pre");pre.textContent=JSON.stringify(a.data,null,2);box.append(pre);
for(const name of ["Approve this request","Deny"]){const b=document.createElement("button");b.textContent=name;
b.onclick=()=>{events.push({index,choice:name});index++;render();};box.append(b);}document.body.append(box);};
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
 (root/"browser-ready.json").write_text('{"ready":true}')
 until=time.monotonic()+30
 while time.monotonic()<until and not (root/"browser-stop.json").exists():
  index=page.evaluate("window.index")
  if index!=last:
   stage=f["actions"][index]["stage"] if index<len(f["actions"]) else "native-shared-legacy-assets-move-complete"
   (root/"progress.json").write_text(json.dumps({"stage":stage}));last=index
   (root/"events.json").write_text(json.dumps(page.evaluate("window.events")))
  time.sleep(.015)
 context.close()
`;
async function run(t, corrupt = false) {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`), artifacts = resolve(".pkm-test-evidence", `.shared-browser-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(artifacts, { mode: 0o700 });
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const steps = installedSharedLegacyMoveSteps({ note: "PUBLIC_NOTE", skill: "PUBLIC_SKILL", paper: "PUBLIC_PAPER" });
  const runId = randomUUID(), binding = { root: `${root}/library`, workspaceId: randomUUID() };
  const actions = steps.map(step => ({ stage: step.stage, title: `Allow PKM v5 ${step.tool} for this exact request?`,
    data: { ...binding, operation: `mcp.tool.${step.tool}`, tool: step.tool, version: 1, readOnly: false,
      arguments: { ...step.arguments }, argumentsDigest: digest(step.arguments) } }));
  if (corrupt) actions[4].data.arguments.slug = "Old/OtherSharedOwner";
  await writeFile(join(root, "native-shared-legacy-assets-move-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-shared-legacy-assets-move-ui/v1", runId, binding, steps,
  }));
  await writeFile(join(root, "workbench.html"), html);
  const env = { ...process.env, TMPDIR: artifacts, TMP: artifacts, TEMP: artifacts, PYTHONDONTWRITEBYTECODE: "1" };
  const browser = spawn(python, ["-B", "-c", browserProgram, JSON.stringify({ root, artifacts, port, actions })], { env, stdio: "inherit" });
  const browserDone = new Promise((resolve, reject) => {
    browser.once("error", reject); browser.once("exit", code => code === 0 ? resolve() : reject(new Error(`Shared browser exited ${code}`)));
  });
  void browserDone.catch(() => {});
  let observer;
  t.after(async () => {
    try { await observer?.stop(); await writeFile(join(root, "browser-stop.json"), "{}"); await browserDone; }
    finally { await rm(root, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); }
  });
  await wait(join(root, "browser-ready.json"));
  observer = await startInstalledNativeSharedLegacyAssetsMoveUi({ root, python, env, port, runId, timeoutMs: 5000 });
  return { root, observer, steps };
}
test("eight exact rendered choices distinguish shared success and both denials without manufacturing installed proof", { timeout: 45000 }, async t => {
  const f = await run(t); await f.observer.done;
  const proof = await wait(join(f.root, "native-shared-legacy-assets-move-ui-passed.json"));
  assert.equal(proof.actualRenderedDom, true); assert.equal(proof.actualNativeUi, undefined);
  assert.deepEqual(proof.dialogs.map(row => row.choice), f.steps.map(row => row.choice));
  assert.equal((await wait(join(f.root, "events.json"))).length, 8);
});
test("an identical shared-copy title with another owner is refused before the shared approval click", { timeout: 45000 }, async t => {
  const f = await run(t, true); await assert.rejects(f.observer.done);
  assert.match((await wait(join(f.root, "native-shared-legacy-assets-move-ui-passed.json"))).error, /Wrong exact move arguments/);
  assert.equal((await wait(join(f.root, "events.json"))).length, 4);
});
