import { spawn } from "node:child_process";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

const prefix = "native-knowledge-recovery";
const error = code => Object.assign(new Error(code), { code });
export const installedNativeKnowledgeRecoveryStageNames = Object.freeze([
  "recovery-deny-source", "recovery-preview", "recovery-deny-repair", "recovery-wrong-hash",
  "recovery-apply", "recovery-after-preview", "recovery-occupied",
]);
export const installedNativeKnowledgeRecoveryUiProgram = String.raw`
import hashlib,json,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000
proof={"schema":"pkm.installed-native-knowledge-recovery-ui-evidence/v1","runId":f["runId"],"dialogs":[],"pickers":[]}
observer={"schema":"pkm.installed-native-knowledge-recovery-ui-status/v1","runId":f["runId"],"phase":"starting","failed":False}
def check(ok,message):
 if not ok:raise AssertionError(message)
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def publish(name,value):
 with (root/name).open("x") as out:json.dump(value,out)
def status(phase,**fields):
 observer.update(phase=phase,updatedAtMs=round(time.time()*1000),**fields)
 pending=root/"native-knowledge-recovery-ui-status.next.json"
 with pending.open("w") as out:json.dump(observer,out)
 pending.replace(root/"native-knowledge-recovery-ui-status.json")
def stage(name):
 status("waiting-stage",currentStage=name);until=time.monotonic()+seconds
 while time.monotonic()<until:
  try:
   progress=json.loads((root/"progress.json").read_text());check(progress.get("stage")!="failed","Parent failed")
   value=json.loads((root/"native-knowledge-recovery-ui-next.json").read_text())
   if progress.get("stage")==name and value.get("stage")==name:
    check(progress["runId"]==f["runId"] and value["runId"]==f["runId"],"Wrong stage run")
    status("stage-observed");return
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Recovery stage timed out: "+name)
def empty(page):
 check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected Recovery modal")
 check(page.locator(".quick-input-widget:visible").count()==0,"Unexpected Recovery picker")
def complete_stage(page,step):
 status("waiting-work-complete");until=time.monotonic()+seconds
 while time.monotonic()<until:
  empty(page)
  try:
   progress=json.loads((root/"progress.json").read_text());check(progress.get("stage")!="failed","Parent failed")
   check(progress.get("stage")==step["stage"] and progress["runId"]==f["runId"],"Advanced before acknowledgement")
   phase=json.loads((root/"native-knowledge-recovery-ui-phase.json").read_text())
   check(phase["runId"]==f["runId"] and phase["stage"]==step["stage"],"Wrong work-complete binding")
   if phase["phase"]=="work-complete":
    empty(page)
    publish("native-knowledge-recovery-ui-ack-"+step["stage"]+".json",{
     "schema":"pkm.installed-native-knowledge-recovery-ui-ack/v1","runId":f["runId"],"stage":step["stage"],
     "phase":"complete","noUnexpectedModal":True,"noUnexpectedPicker":True})
    status("stage-acknowledged",lastCompletedStage=step["stage"]);return
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Recovery completion timed out: "+step["stage"])
def picker(page,step,c):
 title="Select external PKM recovery evidence (read-only; no Knowledge repair)"
 path=step["evidencePicker"];check(path==c["evidence"] and str(Path(path).resolve(strict=True))==path,"Wrong synthetic evidence path")
 check(path!=c["binding"]["root"] and not path.startswith(c["binding"]["root"]+"/"),"Evidence is not external")
 status("waiting-picker",expectedTitle=title)
 widget=page.locator(".quick-input-widget:visible");widget.get_by_text(title,exact=True).wait_for(state="visible")
 check(widget.count()==1,"One actual native folder picker required")
 field=widget.locator("input");check(field.count()==1,"One native picker field required")
 expect(widget.locator(".quick-input-progress")).to_have_attribute("aria-hidden","true")
 field.fill(path+"/");expect(field).to_have_value(path+"/")
 expect(widget.locator(".quick-input-progress")).to_have_attribute("aria-hidden","true")
 expect(widget.locator(".monaco-list-row").filter(has=page.get_by_text("blobs",exact=True))).to_have_count(1)
 expect(widget.locator(".monaco-list-row.focused, .monaco-list-row[aria-selected='true']")).to_have_count(0)
 check(widget.get_by_text(title,exact=True).is_visible() and field.input_value()==path+"/","Picker changed before selection")
 handle=widget.element_handle();field.press("Enter")
 page.wait_for_function("(node)=>!node.isConnected||node.offsetParent===null",arg=handle)
 proof["pickers"].append({"stage":step["stage"],"directory":path,"actualFolderPicker":True,"noActiveNavigationRow":True})
def review(page,step,c,kind):
 title={"public":"Allow PKM v5 "+step["tool"]+" for this exact request?",
  "source":"Allow bounded read of this native-selected external recovery evidence only?",
  "repair":"Repair ONE registered PUBLIC, unshared, asset-free missing Note/Skill owner?"}[kind]
 choice=step[kind+"Choice"];status("waiting-modal",expectedTitle=title)
 dialog=page.locator(".monaco-dialog-box:visible");dialog.get_by_text(title,exact=True).wait_for(state="visible")
 check(dialog.count()==1,"One actual native modal required")
 handle=dialog.element_handle();text=dialog.inner_text().replace("\u00a0"," ")
 start=text.find("{");check(start>=0,"Missing native descriptor")
 data,_=json.JSONDecoder().raw_decode(text[start:]);b=c["binding"]
 if kind=="public":
  contracts=[item for item in c["publicContracts"] if item["tool"]==step["tool"]];check(len(contracts)==1,"Missing exact catalog contract")
  contract=contracts[0]
  check(data["root"]==b["root"] and data["workspaceId"]==b["workspaceId"],"Wrong PUBLIC Root")
  check(data["tool"]==step["tool"] and data["operation"]==contract["operation"] and data["version"]==contract["version"]
   and data["readOnly"]==contract["readOnly"] and contract["readOnly"] is False,"Mutating catalog authority cannot be downgraded")
  check(data["arguments"]==step["arguments"] and data["argumentsDigest"]==digest(step["arguments"]),"Wrong PUBLIC arguments")
  for key in ["custodyPlanSha256","catalogSha256","profileSha256","privacySha256","epoch"]:
   if key in data:check(data[key]==b[key],"Wrong PUBLIC binding: "+key)
 elif kind=="source":
  check(data["directory"]==c["evidence"],"Source modal did not bind selected folder")
  check(data["directoryIdentity"]==c["directoryIdentity"],"Selected source directory identity changed")
  check(data["scope"]=="One Note/Skill Markdown plan only. No Knowledge writes, audit writes, private/Paper/assets/fullRoot or repair authority.","Source scope widened")
 else:
  check(data["owner"]==c["owner"],"Repair owner differs from retained Original registration")
  check(data["evidence"]["directory"]==c["evidence"] and data["evidence"]["knowledgeRoot"]==b["root"]
   and data["evidence"]["planSha256"]==c["planSha256"],"Wrong repair evidence")
  check(data["evidence"]["files"]==c["evidenceFiles"] and data["evidence"]["directoryIdentity"]==c["directoryIdentity"],"Repair evidence changed")
  check(re.fullmatch("[a-f0-9]{64}",data["repairPlanSha256"]) is not None,"Missing exact repair fingerprint")
  check(data["scope"]=="Exact retained hash/raw ID/revision/mode only; exclusive no-overwrite publication, external evidence audit and same-owner custody/index/receipt successor. No unknown owner, private/Paper/assets/fullRoot or arbitrary crash recovery.","Repair scope widened")
 if kind!="public":check(re.fullmatch("[a-f0-9]{64}",data["requestSha256"]) is not None,"Missing native request digest")
 deny=dialog.get_by_role("button",name="Deny",exact=True);check(deny.count()==1,"One Deny required")
 button=dialog.get_by_role("button",name=choice,exact=True)
 check(button.count()==1 and button.is_visible() and button.is_enabled(),"Exact enabled choice required")
 check(dialog.evaluate("(node,old)=>node===old",handle) and handle.evaluate("(node)=>node.isConnected"),"Modal replaced")
 check(dialog.inner_text().replace("\u00a0"," ")==text,"Descriptor changed")
 focused=False
 if choice=="Deny":
  button.focus();focused=button.evaluate("(node)=>node===document.activeElement")
  check(focused,"Deny must actually own focus before Enter");page.keyboard.press("Enter")
 else:button.click()
 page.wait_for_function("(old)=>!old.node.isConnected||old.node.offsetParent===null||old.node.innerText.replaceAll('\\u00a0',' ')!==old.text",arg={"node":handle,"text":text})
 proof["dialogs"].append({"stage":step["stage"],"kind":kind,"choice":choice,"descriptor":data,"focusedEnterDenial":focused})
try:
 check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Private branded driver required")
 c=json.loads((root/"native-knowledge-recovery-ui-contract.json").read_text())
 check(c["schema"]=="pkm.installed-native-knowledge-recovery-ui/v1" and c["runId"]==f["runId"],"Wrong UI contract/run")
 names=["recovery-deny-source","recovery-preview","recovery-deny-repair","recovery-wrong-hash","recovery-apply","recovery-after-preview","recovery-occupied"]
 check([s["stage"] for s in c["stages"]]==names,"Exact seven-stage Recovery contract required")
 check(all(s["tool"] in ["knowledge_recovery_preview","knowledge_recovery_apply"] for s in c["stages"]),"Out-of-scope tool")
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
  pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
  check(len(pages)==1,"One installed workbench required")
  page=pages[0];page.set_default_timeout(f["timeoutMs"]);page.wait_for_load_state("networkidle")
  publish("native-knowledge-recovery-ui-ready.json",{"runId":f["runId"],"ready":True,"actualRenderedDom":True})
  for step in c["stages"]:
   stage(step["stage"])
   source=json.loads((root/("native-knowledge-recovery-ui-source-"+step["stage"]+".json")).read_text())
   check(source["runId"]==f["runId"] and source["stage"]==step["stage"],"Wrong stage source observation")
   c["directoryIdentity"]=source["directoryIdentity"]
   if step.get("publicChoice"):review(page,step,c,"public")
   picker(page,step,c);review(page,step,c,"source")
   if step.get("repairChoice"):review(page,step,c,"repair")
   complete_stage(page,step)
  stage("native-knowledge-recovery-complete");empty(page)
  proof.update(passed=True,actualRenderedDom=True);status("complete")
  publish("native-knowledge-recovery-ui-passed.json",proof)
except Exception as failure:
 try:status("failed",failed=True,error=str(failure))
 except Exception:pass
 try:publish("native-knowledge-recovery-ui-passed.json",{"runId":f["runId"],"failed":True,"error":str(failure),"observed":proof})
 except Exception:pass
 raise
`;

async function privateDriver(root, runId, timeoutMs) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !/^[a-f0-9-]{36}$/.test(runId)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw error("INSTALLED_RECOVERY_PRIVATE_DRIVER_REQUIRED");
}
async function atomicJson(root, name, value) {
  await writeFile(join(root, `${name}.next`), JSON.stringify(value), { mode: 0o600 });
  await rename(join(root, `${name}.next`), join(root, name));
}
export async function readInstalledNativeKnowledgeRecoveryObserverStatus(root, runId) {
  try {
    const value = JSON.parse(await readFile(join(root, `${prefix}-ui-status.json`)));
    if (value.schema !== "pkm.installed-native-knowledge-recovery-ui-status/v1" || value.runId !== runId)
      throw error("INSTALLED_RECOVERY_OBSERVER_BINDING_REQUIRED");
    return value;
  } catch (failure) {
    if (failure.code === "ENOENT") return { runId, phase: "not-recorded", failed: false };
    throw failure;
  }
}
/** Stage acknowledgements are synchronization evidence, never resource authority. */
export async function createInstalledNativeKnowledgeRecoveryStageProtocol({ root, runId, timeoutMs, stages, check = () => {} }) {
  await privateDriver(root, runId, timeoutMs);
  if (JSON.stringify(stages) !== JSON.stringify(installedNativeKnowledgeRecoveryStageNames))
    throw error("INSTALLED_RECOVERY_SEVEN_STAGES_REQUIRED");
  let active, index = 0, failed = false;
  const healthy = async () => {
    if ((await readInstalledNativeKnowledgeRecoveryObserverStatus(root, runId)).failed)
      throw error("INSTALLED_RECOVERY_OBSERVER_FAILED");
    await check();
  };
  const fail = async failure => {
    failed = true;
    const observer = await readInstalledNativeKnowledgeRecoveryObserverStatus(root, runId).catch(value => ({ error: String(value) }));
    await atomicJson(root, `${prefix}-failure.json`, { schema: "pkm.installed-native-knowledge-recovery-failure/v1",
      runId, stage: active ?? null, error: String(failure), code: failure.code ?? null, observer });
  };
  return {
    async begin(stage) {
      if (failed || active || stage !== stages[index]) throw error("INSTALLED_RECOVERY_STAGE_PENDING_ACK");
      try {
        await healthy(); active = stage;
        await atomicJson(root, `${prefix}-ui-phase.json`, { runId, stage, phase: "work-started" });
        await atomicJson(root, `${prefix}-ui-next.json`, { runId, stage });
        await atomicJson(root, "progress.json", { runId, stage });
      } catch (failure) { await fail(failure); throw failure; }
    },
    async complete(stage) {
      if (failed || stage !== active) throw error("INSTALLED_RECOVERY_STAGE_BINDING_REQUIRED");
      try {
        await healthy();
        await atomicJson(root, `${prefix}-ui-phase.json`, { runId, stage, phase: "work-complete" });
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
          await healthy();
          try {
            const ack = JSON.parse(await readFile(join(root, `${prefix}-ui-ack-${stage}.json`)));
            if (ack.schema !== "pkm.installed-native-knowledge-recovery-ui-ack/v1" || ack.runId !== runId
              || ack.stage !== stage || ack.phase !== "complete" || ack.noUnexpectedModal !== true || ack.noUnexpectedPicker !== true)
              throw error("INSTALLED_RECOVERY_ACK_BINDING_MISMATCH");
            active = undefined; index++; return ack;
          } catch (failure) { if (failure.code !== "ENOENT" && !(failure instanceof SyntaxError)) throw failure; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw error("INSTALLED_RECOVERY_ACK_TIMEOUT");
      } catch (failure) { await fail(failure); throw failure; }
    },
    async finish() {
      if (failed || active || index !== stages.length) throw error("INSTALLED_RECOVERY_STAGE_PENDING_ACK");
      try {
        await healthy();
        const stage = `${prefix}-complete`;
        await atomicJson(root, `${prefix}-ui-next.json`, { runId, stage });
        await atomicJson(root, "progress.json", { runId, stage });
      } catch (failure) { await fail(failure); throw failure; }
    },
    fail,
  };
}
export async function startInstalledNativeKnowledgeRecoveryUi({ root, python, env, port, runId, timeoutMs = 120000 }) {
  await privateDriver(root, runId, timeoutMs);
  if (!isAbsolute(python ?? "") || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw error("INSTALLED_RECOVERY_PRIVATE_UI_REQUIRED");
  const child = spawn(python, ["-B", "-c", installedNativeKnowledgeRecoveryUiProgram,
    JSON.stringify({ root, port, runId, timeoutMs })], { env, stdio: "inherit" });
  let failure;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Recovery observer exited ${code}/${signal}`)));
  });
  void done.catch(value => { failure = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (failure) throw failure;
      if ((await readInstalledNativeKnowledgeRecoveryObserverStatus(root, runId)).failed)
        throw error("INSTALLED_RECOVERY_OBSERVER_FAILED");
      try {
        const value = JSON.parse(await readFile(join(root, `${prefix}-ui-ready.json`)));
        if (value.ready !== true || value.actualRenderedDom !== true || value.runId !== runId)
          throw error("INSTALLED_RECOVERY_READY_BINDING_REQUIRED");
        return value;
      } catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw error("INSTALLED_RECOVERY_UI_READY_TIMEOUT");
  })();
  void ready.catch(() => {});
  return { ready, done, get error() { return failure; }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  } };
}
