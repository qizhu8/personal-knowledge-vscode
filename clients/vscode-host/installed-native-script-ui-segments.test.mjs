import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { startInstalledNativeScriptUi, installedNativeScriptUiFile, waitInstalledNativeScriptUi } from "./installed-native-script-ui.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(path) {
  for (let count = 0; count < 800; count++) {
    try { return JSON.parse(await readFile(path)); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await delay(25);
  }
  throw new Error("Segment browser readiness timed out");
}
const browserProgram = String.raw`
import json,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"])
with sync_playwright() as p:
 context=p.chromium.launch_persistent_context(str(Path(f["artifacts"])/"profile"),headless=True,
  args=["--remote-debugging-port="+str(f["port"]),"--remote-debugging-address=127.0.0.1","--proxy-server=http://127.0.0.1:1","--proxy-bypass-list=127.0.0.1"])
 page=context.pages[0];page.goto((root/"workbench.html").as_uri());page.wait_for_load_state("networkidle")
 (root/"browser-ready.json").write_text('{"ready":true}')
 until=time.monotonic()+30
 while time.monotonic()<until and not (root/"browser-stop.json").exists():time.sleep(.025)
 (root/"events.json").write_text(json.dumps(page.evaluate("window.events")))
 context.close()
`;

test("Script deny-only rendered segment completes after one choice without waiting for another editor or claiming installed authority", { timeout: 45000 }, async t => {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`);
  const artifacts = resolve(".pkm-test-evidence", `script-segment-browser-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(artifacts, { mode: 0o700 });
  const socket = createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root: join(root, "mechanics-only-not-native"),
    workspaceId: randomUUID(), planSha256: "a".repeat(64), profileSha256: "b".repeat(64), catalogSha256: "c".repeat(64),
    brokerId: randomUUID(), epoch: randomUUID(), actorId: "mcp:external", domains: ["mcp-public"], configurationSha256: "d".repeat(64) };
  const data = { ...binding, sourceCatalogSha256: binding.catalogSha256, authorityId: `native-rpc:${binding.brokerId}`,
    permission: "Public reads only. Writes, tools and native model requests require separate approval." };
  delete data.catalogSha256; delete data.brokerId;
  await writeFile(join(root, "workbench.html"), `<!doctype html><body><div class="monaco-dialog-box">
<div>Allow this PKM v5 native session to read public content from the selected library?</div>
<pre>${JSON.stringify(data, null, 2)}</pre><button>Deny</button><button>Approve this request</button></div>
<script>window.events=[];for(const b of document.querySelectorAll("button"))b.onclick=()=>{events.push(b.textContent);document.querySelector(".monaco-dialog-box").remove()};</script>`);
  const env = { ...process.env, TMPDIR: artifacts, TMP: artifacts, TEMP: artifacts, PYTHONDONTWRITEBYTECODE: "1" };
  const browser = spawn(process.env.PKM_TEST_PYTHON, ["-B", "-c", browserProgram, JSON.stringify({ root, artifacts, port })], { env, stdio: "inherit" });
  const ended = new Promise((resolve, reject) => {
    browser.once("error", reject); browser.once("exit", code => code === 0 ? resolve() : reject(new Error(`Mechanics browser exited ${code}`)));
  });
  void ended.catch(() => {});
  let ui;
  t.after(async () => {
    try { await ui?.stop(); await writeFile(join(root, "browser-stop.json"), "{}"); await ended; }
    finally { await rm(root, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); }
  });
  await wait(join(root, "browser-ready.json"));
  ui = await startInstalledNativeScriptUi({ root, python: process.env.PKM_TEST_PYTHON, env, port,
    mode: "deny", runId: randomUUID(), timeoutMs: 5000 });
  await ui.ready;
  await writeFile(installedNativeScriptUiFile(ui, "next"), JSON.stringify({ stage: "native-script-host-deny", runId: ui.runId, binding }));
  await writeFile(join(root, "progress.json"), '{"stage":"native-script-host-deny"}');
  await ui.done;
  const proof = await waitInstalledNativeScriptUi(ui, "passed");
  assert.equal(proof.mode, "deny"); assert.equal(proof.dialogs.length, 1); assert.equal(proof.readonlyReadPhasePerformed, false);
  assert.equal(proof.actualRenderedDom, true); assert.equal(proof.actualInstalledIdentityAndHost, undefined);
  await writeFile(join(root, "browser-stop.json"), "{}"); await ended;
  assert.deepEqual(await wait(join(root, "events.json")), ["Deny"]);
  t.diagnostic("Actual headless Chromium selector/lifecycle mechanics only; no Root/Host/installed denial witness or grant is fabricated.");
});
