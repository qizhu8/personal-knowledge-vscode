import { spawn } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";
import { assertInstalledNativeScriptPriorDenial } from "./installed-native-script.mjs";

const observers = new WeakMap();

export const installedNativeScriptUiStages = Object.freeze([
  Object.freeze({ stage: "native-script-host-deny", choice: "Deny" }),
  Object.freeze({ stage: "native-script-host-approve", choice: "Approve this request" }),
]);
export const installedNativeScriptUiProgram = String.raw`
import json,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000
proof={"schema":"pkm.installed-native-script-ui-evidence/v1","runId":f["runId"],"mode":f["mode"],"dialogs":[]}
def check(ok,message):
 if not ok:raise AssertionError(message)
def publish(name,value):
 with (root/name).open("x") as output:json.dump(value,output)
def stage(name):
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  try:
   progress=json.loads((root/"progress.json").read_text()).get("stage");check(progress!="failed","Parent workflow failed")
   if progress==name:
    expected=json.loads((root/("native-script-ui-"+f["runId"]+"-next.json")).read_text())
    if expected.get("stage")==name and expected.get("runId")==f["runId"]:return expected
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Script Host stage timed out: "+name)
try:
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
  pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
  check(len(pages)==1,"Exactly one actual installed workbench is required")
  page=pages[0];page.set_default_timeout(f["timeoutMs"]);page.wait_for_load_state("networkidle")
  publish("native-script-ui-"+f["runId"]+"-ready.json",{"ready":True,"actualRenderedDom":True,"runId":f["runId"],"mode":f["mode"]})
  for step in f["stages"]:
   expected=stage(step["stage"]);binding=expected["binding"]
   dialog=page.locator(".monaco-dialog-box:visible")
   dialog.get_by_text("Allow this PKM v5 native session to read public content from the selected library?",exact=True).wait_for(state="visible")
   check(dialog.count()==1,"Exactly one native Host admission modal is required")
   handle=dialog.element_handle();text=dialog.inner_text().replace("\u00a0"," ");start=text.find("{")
   check(start>=0,"Host modal omitted its actual scope")
   data,_=json.JSONDecoder().raw_decode(text[start:])
   check(data["schema"]=="pkm.original-mcp-native-host-admission/v1","Wrong native Host admission schema")
   for key in ["root","workspaceId","planSha256","profileSha256"]:
    check(data[key]==binding[key],"Wrong actual Host binding: "+key)
   check(data["sourceCatalogSha256"]==binding["catalogSha256"],"Wrong actual catalog")
   check(data["authorityId"]=="native-rpc:"+binding["brokerId"],"Wrong signed native broker")
   check(data["actorId"]=="mcp:external" and "mcp-public" in data["domains"],"Wrong public actor/domain")
   check(data["permission"]=="Public reads only. Writes, tools and native model requests require separate approval.","Wrong Host disclosure")
   check(isinstance(data["epoch"],str) and len(data["epoch"])==36,"Missing actual signed epoch")
   if f["mode"]=="approve":
    check(data["epoch"]!=f["prior"]["epoch"],"A new editor activation epoch is required before approval")
    check(data["root"]!=f["prior"]["root"] and data["workspaceId"]!=f["prior"]["workspaceId"],"Approved context must use a fresh fixture")
   check(dialog.evaluate("(node,old)=>node===old",handle) and handle.evaluate("(node)=>node.isConnected"),"Host modal replaced")
   check(dialog.inner_text().replace("\u00a0"," ")==text,"Host scope changed before decision")
   button=dialog.get_by_role("button",name=step["choice"],exact=True)
   check(button.count()==1 and button.is_visible() and button.is_enabled(),"Unique enabled Host choice required")
   if step["choice"]=="Deny":
    button.focus();check(button.evaluate("(node)=>node===document.activeElement"),"Explicit Host Deny focus required")
    page.keyboard.press("Enter")
   else:button.click()
   original={key:value for key,value in data.items() if key!="permission"}
   proof["dialogs"].append({"stage":step["stage"],"choice":step["choice"],"binding":original,
    "focusedEnterDenial":step["choice"]=="Deny","observedActualHostModal":True})
   page.wait_for_function("(old)=>!old.node.isConnected||old.node.offsetParent===null||old.node.innerText.replaceAll('\\u00a0',' ')!==old.text",arg={"node":handle,"text":text})
   publish("native-script-ui-"+f["runId"]+"-host-"+f["mode"]+".json",{"runId":f["runId"],"mode":f["mode"],"dialog":proof["dialogs"][-1]})
  if f["mode"]=="deny":
   check(len(proof["dialogs"])==1,"Deny segment requires one actual Host modal")
   proof.update(passed=True,actualRenderedDom=True,readonlyReadPhasePerformed=False)
   publish("native-script-ui-"+f["runId"]+"-passed.json",proof)
   sys.exit(0)
  stage("native-script-reads-start")
  publish("native-script-ui-"+f["runId"]+"-reads-ready.json",{"runId":f["runId"],"mode":f["mode"],"observedReadonlyStart":True})
  until=time.monotonic()+seconds
  while time.monotonic()<until:
   check(page.locator(".monaco-dialog-box:visible").count()==0,"Readonly Script reads must not request named/model/private modals")
   try:
    progress=json.loads((root/"progress.json").read_text()).get("stage");check(progress!="failed","Parent workflow failed")
    if progress=="native-script-complete":break
   except (FileNotFoundError,json.JSONDecodeError):pass
   time.sleep(.025)
  else:raise RuntimeError("Script read completion timed out")
  proof.update(passed=True,actualRenderedDom=True,readonlyReadPhasePerformed=True,observedReadonlyModals=0)
  publish("native-script-ui-"+f["runId"]+"-passed.json",proof)
except Exception as error:
 try:publish("native-script-ui-"+f["runId"]+"-passed.json",{"failed":True,"runId":f["runId"],"mode":f["mode"],"error":str(error),"observed":proof})
 except Exception:pass
 raise
`;

/** Arm before Parent calls complete(); no Owner, Host or renderer lifetime is transferred. */
export async function startInstalledNativeScriptUi({ root, python, env, port, timeoutMs = 120000, runId, mode, priorDenied }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !isAbsolute(python ?? "")
    || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9-]{36}$/.test(runId ?? "")
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw Object.assign(new Error("INSTALLED_SCRIPT_PRIVATE_UI_REQUIRED"), { code: "INSTALLED_SCRIPT_PRIVATE_UI_REQUIRED" });
  if (!["deny", "approve"].includes(mode))
    throw Object.assign(new Error("INSTALLED_SCRIPT_UI_MODE_REQUIRED"), { code: "INSTALLED_SCRIPT_UI_MODE_REQUIRED" });
  const prior = mode === "approve" ? assertInstalledNativeScriptPriorDenial(priorDenied) : undefined;
  const child = spawn(python, ["-B", "-c", installedNativeScriptUiProgram, JSON.stringify({
    root, port, runId, timeoutMs, mode, ...(prior ? { prior: { root: prior.root, workspaceId: prior.workspaceId,
      epoch: prior.epoch, runId: prior.runId } } : {}), stages: installedNativeScriptUiStages.filter(step =>
      step.stage === `native-script-host-${mode}`),
  })], { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Script observer exited ${code}/${signal}`)));
  });
  void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (error) throw error;
      try {
        const proof = JSON.parse(await readFile(join(root, `native-script-ui-${runId}-ready.json`)));
        if (proof.ready !== true || proof.actualRenderedDom !== true || proof.runId !== runId || proof.mode !== mode) throw new Error("Wrong Script UI readiness");
        return proof;
      } catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Script UI readiness timed out");
  })();
  void ready.catch(() => {});
  const observer = Object.freeze({ runId, root, mode, priorDenied, ready, done, get error() { return error; }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  } });
  observers.set(observer, { root, runId, mode });
  return observer;
}

export function assertInstalledNativeScriptUi(ui, root) {
  if (!observers.has(ui) || observers.get(ui).root !== root)
    throw Object.assign(new Error("INSTALLED_SCRIPT_ACTUAL_OBSERVER_REQUIRED"), { code: "INSTALLED_SCRIPT_ACTUAL_OBSERVER_REQUIRED" });
}

export function installedNativeScriptUiFile(ui, suffix) {
  assertInstalledNativeScriptUi(ui, ui?.root);
  if (!["next", "ready", "host-deny", "host-approve", "reads-ready", "passed"].includes(suffix))
    throw Object.assign(new Error("INSTALLED_SCRIPT_UI_FILE_REQUIRED"), { code: "INSTALLED_SCRIPT_UI_FILE_REQUIRED" });
  return join(ui.root, `native-script-ui-${ui.runId}-${suffix}.json`);
}

export async function waitInstalledNativeScriptUi(ui, suffix, timeoutMs = 120000) {
  const filename = installedNativeScriptUiFile(ui, suffix);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (ui.error) throw ui.error;
    try {
      const proof = JSON.parse(await readFile(filename));
      if (proof.runId !== ui.runId || proof.mode !== ui.mode || proof.failed) throw new Error("Wrong or failed Script UI evidence");
      return proof;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Script UI evidence timed out: ${filename}`);
}

/** Parent supplies the real descriptor binding for each distinct denied/approved activation. */
export async function stageInstalledNativeScriptHost(ui, { stage, installed, component }) {
  assertInstalledNativeScriptUi(ui, ui?.root);
  if (stage !== `native-script-host-${ui.mode}`
    || !component?.owner || !component?.fixture || component.root !== component.fixture.root)
    throw Object.assign(new Error("INSTALLED_SCRIPT_ACTUAL_HOST_STAGE_REQUIRED"), { code: "INSTALLED_SCRIPT_ACTUAL_HOST_STAGE_REQUIRED" });
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(component.fixture);
  (await u.load(installed, "root-owner")).assertRootOwner(component.owner);
  if (component.owner.workspaceRoot() !== component.root)
    throw Object.assign(new Error("INSTALLED_SCRIPT_ACTUAL_HOST_STAGE_REQUIRED"), { code: "INSTALLED_SCRIPT_ACTUAL_HOST_STAGE_REQUIRED" });
  const bytes = await readFile(component.attachmentDescriptorPath), descriptor = JSON.parse(bytes);
  if (u.hash(bytes) !== component.attachmentDescriptorSha256 || descriptor.binding.root !== component.root
    || descriptor.binding.workspaceId !== component.workspaceId || descriptor.binding.planSha256 !== component.custody.planSha256)
    throw Object.assign(new Error("INSTALLED_SCRIPT_ACTUAL_HOST_STAGE_REQUIRED"), { code: "INSTALLED_SCRIPT_ACTUAL_HOST_STAGE_REQUIRED" });
  const binding = { ...descriptor.binding, brokerId: descriptor.brokerId };
  if (ui.error) throw ui.error;
  await writeFile(installedNativeScriptUiFile(ui, "next"), JSON.stringify({ stage, binding, runId: ui.runId }), { mode: 0o600 });
  await writeFile(join(ui.root, "progress.json"), JSON.stringify({ stage }), { mode: 0o600 });
}
