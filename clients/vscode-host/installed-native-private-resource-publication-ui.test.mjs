import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { installedPrivateResourcePublicationSteps } from "./installed-native-private-resource-publication.mjs";
import { startInstalledNativePrivateResourcePublicationUi } from "./installed-native-private-resource-publication-ui.mjs";
import { privateResourcePublicationDigest as digest } from "../../dist/private-resource-publication-contracts.js";

// Synthetic actual Chromium mechanics only: these descriptors never enter native authority/Core.
assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the real isolated framework.");
const python = execFileSync(process.env.PKM_TEST_PYTHON ?? "python3", ["-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
async function wait(path) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    try { return JSON.parse(await readFile(path)); } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("DOM evidence timed out.");
}
const html = `<!doctype html><body><script>
window.actions=[];window.index=0;window.events=[];
window.render=()=>{document.body.replaceChildren();const a=actions[index];if(!a)return;
const box=document.createElement("div");box.className="monaco-dialog-box";
const title=document.createElement("div");title.textContent=a.title;box.append(title);
const pre=document.createElement("pre");pre.textContent=JSON.stringify(a.data,null,2);box.append(pre);
for(const name of a.buttons){const b=document.createElement("button");b.textContent=name;
b.onclick=()=>{events.push({index,choice:name});index++;render();};box.append(b);}document.body.append(box);
[...box.querySelectorAll("button")].find(b=>b.textContent===(a.defaultFocus??a.buttons[0])).focus();};
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
 (root/"browser-ready.json").write_text('{"ready":true}');until=time.monotonic()+35
 while time.monotonic()<until and not (root/"browser-stop.json").exists():
  index=page.evaluate("window.index")
  if index!=last:
   stage=f["actions"][index]["stage"] if index<len(f["actions"]) else "native-private-resource-publication-complete"
   (root/"progress.json").write_text(json.dumps({"stage":stage}));last=index
   (root/"events.json").write_text(json.dumps(page.evaluate("window.events")))
  time.sleep(.015)
 context.close()
`;
async function run(t, corrupt) {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`), artifacts = resolve(".pkm-test-evidence", `.private-browser-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(artifacts, { mode: 0o700 });
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const runId = randomUUID(), sha = digest("mechanics-only"), binding = { root: `${root}/library`, workspaceId: randomUUID(),
    catalogSha256: sha, profileSha256: sha, custodyPlanSha256: sha, privacySha256: sha, epoch: randomUUID(), nativeHostReceiptSha256: sha };
  const areas = { note: "notes", skill: "skills", paper: "papers" };
  const steps = installedPrivateResourcePublicationSteps().map(step => ({
    ...step, operation: `knowledge.${step.kind === "paper" ? "research" : step.kind}.update`,
    owner: { area: areas[step.kind], id: "knowledge_0123456789abcdef01234567", beforePath: "Old/Before.md",
      afterPath: `New/${step.kind === "skill" ? "Before" : "After"}.md`, revision: 1, sha256: sha },
    resources: step.resources.map(resource => ({ choice: resource.choice, resource: {
      sourcePath: `Private/_assets/${resource.source}`, sha256: sha, size: 1, sourceIdentity: `synthetic-DOM-${resource.source}`,
      targetPath: `New/${step.kind === "skill" ? "Before" : "After"}.assets/${sha.slice(0, 16)}${resource.source.endsWith("PNG") ? ".png" : ".bin"}`,
    } })),
  }));
  const actions = [];
  for (const step of steps) {
    actions.push({ stage: step.stage, title: `Allow PKM v5 ${step.tool} for this exact request?`, buttons: ["Approve this request", "Deny"],
      data: { root: binding.root, workspaceId: binding.workspaceId, tool: step.tool, operation: `mcp.tool.${step.tool}`, version: 1,
        readOnly: false, arguments: step.arguments, argumentsDigest: digest(step.arguments) } });
    const operationId = randomUUID();
    for (const resource of step.resources) {
      const request = { schema: "pkm.private-resource-publication/v1", phase: "publish", nativeHostReceiptSha256: sha, nativeEpoch: binding.epoch,
        subject: { root: binding.root, workspaceId: binding.workspaceId, custodyPlanSha256: sha, catalogSha256: sha, profileSha256: sha,
          actorId: "mcp:external", operationId, operation: step.operation, owner: step.owner, resource: resource.resource,
          publicRequest: { tool: step.tool, version: 1, argumentsDigest: digest(step.arguments) }, canonicalArgumentsDigest: sha,
          privacySha256: sha, preservePrivateSource: true, oneResourceOneOperation: true } };
      actions.push({ stage: step.stage, title: "Publish this exact private resource into public document assets?",
        buttons: ["Publish this exact resource once", "Cancel", "Deny"], defaultFocus: "Deny",
        data: { ...request, requestSha256: digest(request), defaultDecision: "deny" } });
    }
  }
  if (corrupt === "target") {
    const action = actions.find(action => action.data.subject); action.data.subject.resource = { ...action.data.subject.resource, targetPath: "Other/Unapproved.assets/file.png" };
    const { requestSha256, defaultDecision, ...request } = action.data; action.data.requestSha256 = digest(request);
  }
  if (corrupt === "focus") actions.find(action => action.data.subject).defaultFocus = "Publish this exact resource once";
  await writeFile(join(root, "native-private-resource-publication-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-private-resource-publication-ui/v1", runId, binding, steps,
  }));
  await writeFile(join(root, "workbench.html"), html);
  const env = { ...process.env, TMPDIR: artifacts, TMP: artifacts, TEMP: artifacts, PYTHONDONTWRITEBYTECODE: "1" };
  const browser = spawn(python, ["-B", "-c", browserProgram, JSON.stringify({ root, artifacts, port, actions })], { env, stdio: "inherit" });
  const browserDone = new Promise((resolve, reject) => { browser.once("error", reject); browser.once("exit", code => code === 0 ? resolve() : reject(new Error(`Browser exited ${code}`))); });
  void browserDone.catch(() => {}); let observer;
  t.after(async () => {
    try { await observer?.stop(); await writeFile(join(root, "browser-stop.json"), "{}"); await browserDone; }
    finally { await rm(root, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); }
  });
  await wait(join(root, "browser-ready.json"));
  observer = await startInstalledNativePrivateResourcePublicationUi({ root, python, env, port, runId, timeoutMs: 5000 });
  return { root, observer };
}
test("21 rendered choices enforce default-focused Deny despite reordered controls and exact scopes without installed authority", { timeout: 50000 }, async t => {
  const f = await run(t, false); await f.observer.done;
  const proof = await wait(join(f.root, "native-private-resource-publication-ui-passed.json"));
  assert.equal(proof.actualRenderedDom, true); assert.equal(proof.actualNativeUi, undefined);
  assert.equal(proof.dialogs.filter(row => row.type === "resource").length, 11);
  assert(proof.dialogs.filter(row => row.type === "resource").every(row => row.defaultDenyFocused));
  assert.equal(proof.dialogs.filter(row => row.defaultEnterDenial).length, 4);
  assert.equal((await wait(join(f.root, "events.json"))).length, 21);
});
test("same private publication title with a rehashed but different target refuses before the first resource click", { timeout: 50000 }, async t => {
  const f = await run(t, "target"); await assert.rejects(f.observer.done);
  const proof = await wait(join(f.root, "native-private-resource-publication-ui-passed.json"));
  assert.match(proof.error, /Wrong private owner\/source\/target CAS/);
  assert.equal((await wait(join(f.root, "events.json"))).length, 3);
});
test("a private modal focused on publication refuses before the first resource action", { timeout: 50000 }, async t => {
  const f = await run(t, "focus"); await assert.rejects(f.observer.done);
  const proof = await wait(join(f.root, "native-private-resource-publication-ui-passed.json"));
  assert.match(proof.error, /Private Deny must be focused by default/);
  assert.equal((await wait(join(f.root, "events.json"))).length, 3);
});
