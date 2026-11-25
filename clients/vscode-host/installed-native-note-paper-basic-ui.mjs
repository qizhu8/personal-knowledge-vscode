import { spawn } from "node:child_process";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

const prefix = "native-note-paper-basic";
const error = code => Object.assign(new Error(code), { code });
export const installedNativeNotePaperBasicUiProgram = String.raw`
import hashlib,json,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000
proof={"schema":"pkm.installed-native-note-paper-basic-ui-evidence/v1","runId":f["runId"],"dialogs":[]}
observer={"schema":"pkm.installed-native-note-paper-basic-ui-status/v1","runId":f["runId"],"phase":"starting","failed":False}
def check(ok,message):
 if not ok:raise AssertionError(message)
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def publish(name,value):
 with (root/name).open("x") as out:json.dump(value,out)
def status(phase,**fields):
 observer.update(phase=phase,updatedAtMs=round(time.time()*1000),**fields)
 pending=root/"native-note-paper-basic-ui-status.next.json"
 with pending.open("w") as out:json.dump(observer,out)
 pending.replace(root/"native-note-paper-basic-ui-status.json")
def stage(name):
 status("waiting-stage",currentStage=name);until=time.monotonic()+seconds
 while time.monotonic()<until:
  try:
   progress=json.loads((root/"progress.json").read_text());check(progress.get("stage")!="failed","Parent failed")
   value=json.loads((root/"native-note-paper-basic-ui-next.json").read_text())
   if progress.get("stage")==name and value.get("stage")==name:
    check(progress["runId"]==f["runId"] and value["runId"]==f["runId"],"Wrong stage run")
    status("stage-observed");return value
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Note/Paper basic stage timed out: "+name)
def complete_stage(page,step):
 status("waiting-work-complete");until=time.monotonic()+seconds
 while time.monotonic()<until:
  check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected modal after contracted choices")
  try:
   progress=json.loads((root/"progress.json").read_text())
   check(progress.get("stage")!="failed","Parent failed")
   check(progress.get("stage")==step["stage"] and progress["runId"]==f["runId"],"Advanced before stage acknowledgement")
   phase=json.loads((root/"native-note-paper-basic-ui-phase.json").read_text())
   check(phase["runId"]==f["runId"] and phase["stage"]==step["stage"],"Wrong work-complete binding")
   if phase["phase"]=="work-complete":
    check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected modal at completion")
    publish("native-note-paper-basic-ui-ack-"+step["stage"]+".json",{
     "schema":"pkm.installed-native-note-paper-basic-ui-ack/v1","runId":f["runId"],"stage":step["stage"],
     "phase":"complete","noUnexpectedModal":True})
    status("stage-acknowledged",lastCompletedStage=step["stage"]);return
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Note/Paper basic work completion timed out: "+step["stage"])
def review_public(page,step,c):
 tool=step["tool"];title="Allow PKM v5 "+tool+" for this exact request?"
 status("waiting-modal",expectedTitle=title)
 dialog=page.locator(".monaco-dialog-box:visible");dialog.get_by_text(title,exact=True).wait_for(state="visible")
 check(dialog.count()==1,"One actual native PUBLIC modal required")
 handle=dialog.element_handle();text=dialog.inner_text().replace("\u00a0"," ")
 start=text.find("{");check(start>=0,"Missing native descriptor")
 data,_=json.JSONDecoder().raw_decode(text[start:])
 contracts=[item for item in c["publicContracts"] if item["tool"]==tool];check(len(contracts)==1,"Missing exact catalog contract")
 contract=contracts[0];b=c["binding"]
 check(data["root"]==b["root"] and data["workspaceId"]==b["workspaceId"],"Wrong PUBLIC root/workspace")
 check(data["tool"]==tool and data["operation"]==contract["operation"] and data["version"]==contract["version"]
  and data["readOnly"]==contract["readOnly"] and contract["readOnly"] is False,"Cannot downgrade a catalog-mutating operation")
 check(data["arguments"]==step["arguments"] and data["argumentsDigest"]==digest(step["arguments"]),"Wrong exact PUBLIC arguments")
 for key in ["custodyPlanSha256","catalogSha256","profileSha256","privacySha256","epoch"]:
  if key in data:check(data[key]==b[key],"Wrong signed PUBLIC binding: "+key)
 check("basicprivatesentinel" not in text,"Private title/body/metadata published")
 check("/Private/" not in text or step.get("refusal")=="private-uri","Unexpected private path published")
 deny=dialog.get_by_role("button",name="Deny",exact=True)
 check(deny.count()==1,"One Deny choice required")
 choice=step["publicChoice"];button=dialog.get_by_role("button",name=choice,exact=True)
 check(button.count()==1 and button.is_visible() and button.is_enabled(),"Exact enabled PUBLIC choice required")
 check(dialog.evaluate("(node,old)=>node===old",handle) and handle.evaluate("(node)=>node.isConnected"),"Modal replaced")
 check(dialog.inner_text().replace("\u00a0"," ")==text,"Descriptor changed")
 if choice=="Deny":
  button.focus();check(button.evaluate("(node)=>node===document.activeElement"),"Focused Deny required")
  page.keyboard.press("Enter")
 else:button.click()
 page.wait_for_function("(old)=>!old.node.isConnected||old.node.offsetParent===null||old.node.innerText.replaceAll('\\u00a0',' ')!==old.text",arg={"node":handle,"text":text})
 proof["dialogs"].append({"stage":step["stage"],"tool":tool,"choice":choice,"argumentsDigest":data["argumentsDigest"],
  "readOnly":data["readOnly"],"focusedEnterDenial":choice=="Deny"})
 status("modal-handled")
try:
 check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Private branded driver required")
 c=json.loads((root/"native-note-paper-basic-ui-contract.json").read_text())
 check(c["schema"]=="pkm.installed-native-note-paper-basic-ui/v1" and c["runId"]==f["runId"],"Wrong UI contract/run")
 allowed={"add_note","get_note","update_note","list_notes","search_notes","add_paper","get_paper","update_paper","list_papers","search_papers"}
 check(all(step["tool"] in allowed for step in c["stages"]),"Out-of-scope Original tool")
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
  pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
  check(len(pages)==1,"One actual installed workbench required")
  page=pages[0];page.set_default_timeout(f["timeoutMs"]);page.wait_for_load_state("networkidle")
  publish("native-note-paper-basic-ui-ready.json",{"runId":f["runId"],"ready":True,"actualRenderedDom":True})
  for step in c["stages"]:
   stage(step["stage"])
   if step.get("publicChoice"):review_public(page,step,c)
   else:check(step["noReview"] is True,"An explicit no-review contract is required")
   complete_stage(page,step)
  stage("native-note-paper-basic-complete")
  check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected final modal")
  proof.update(passed=True,actualRenderedDom=True);status("complete")
  publish("native-note-paper-basic-ui-passed.json",proof)
except Exception as failure:
 try:status("failed",failed=True,error=str(failure))
 except Exception:pass
 try:publish("native-note-paper-basic-ui-passed.json",{"runId":f["runId"],"failed":True,"error":str(failure),"observed":proof})
 except Exception:pass
 raise
`;

async function privateDriver(root, runId, timeoutMs) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !/^[a-f0-9-]{36}$/.test(runId)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw error("INSTALLED_NOTE_PAPER_BASIC_PRIVATE_DRIVER_REQUIRED");
}
async function atomicJson(root, name, value) {
  await writeFile(join(root, `${name}.next`), JSON.stringify(value), { mode: 0o600 });
  await rename(join(root, `${name}.next`), join(root, name));
}
export async function readInstalledNativeNotePaperBasicObserverStatus(root, runId) {
  try {
    const value = JSON.parse(await readFile(join(root, `${prefix}-ui-status.json`)));
    if (value.schema !== "pkm.installed-native-note-paper-basic-ui-status/v1" || value.runId !== runId)
      throw error("INSTALLED_NOTE_PAPER_BASIC_OBSERVER_BINDING_REQUIRED");
    return value;
  } catch (failure) {
    if (failure.code === "ENOENT") return { runId, phase: "not-recorded", failed: false };
    throw failure;
  }
}
/** ACKs are synchronization evidence, not operation grants. */
export async function createInstalledNativeNotePaperBasicStageProtocol({ root, runId, timeoutMs, stages, check = () => {} }) {
  await privateDriver(root, runId, timeoutMs);
  if (!Array.isArray(stages) || !stages.length || new Set(stages).size !== stages.length
    || stages.some(stage => typeof stage !== "string" || !/^native-note-paper-basic-(note|paper)-[a-z-]+$/.test(stage)))
    throw error("INSTALLED_NOTE_PAPER_BASIC_STAGE_PROTOCOL_REQUIRED");
  let active, index = 0, failed = false;
  const fail = async failure => {
    failed = true;
    const observer = await readInstalledNativeNotePaperBasicObserverStatus(root, runId)
      .catch(value => ({ error: String(value) }));
    const value = { schema: "pkm.installed-native-note-paper-basic-failure/v1", runId, stage: active ?? null,
      error: String(failure), code: failure.code ?? null, observer };
    await atomicJson(root, `${prefix}-failure.json`, value); return value;
  };
  return {
    async begin(stage) {
      if (failed || active || stage !== stages[index]) throw error("INSTALLED_NOTE_PAPER_BASIC_STAGE_PENDING_ACK");
      await check(); active = stage;
      await atomicJson(root, `${prefix}-ui-phase.json`, { runId, stage, phase: "work-started" });
      await atomicJson(root, `${prefix}-ui-next.json`, { runId, stage });
      await atomicJson(root, "progress.json", { runId, stage });
    },
    async complete(stage) {
      if (failed || stage !== active) throw error("INSTALLED_NOTE_PAPER_BASIC_STAGE_BINDING_REQUIRED");
      try {
        await check();
        await atomicJson(root, `${prefix}-ui-phase.json`, { runId, stage, phase: "work-complete" });
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
          await check();
          if ((await readInstalledNativeNotePaperBasicObserverStatus(root, runId)).failed)
            throw error("INSTALLED_NOTE_PAPER_BASIC_OBSERVER_FAILED");
          try {
            const ack = JSON.parse(await readFile(join(root, `${prefix}-ui-ack-${stage}.json`)));
            if (ack.schema !== "pkm.installed-native-note-paper-basic-ui-ack/v1" || ack.runId !== runId
              || ack.stage !== stage || ack.phase !== "complete" || ack.noUnexpectedModal !== true)
              throw error("INSTALLED_NOTE_PAPER_BASIC_ACK_BINDING_MISMATCH");
            active = undefined; index++; return ack;
          } catch (failure) { if (failure.code !== "ENOENT" && !(failure instanceof SyntaxError)) throw failure; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw error("INSTALLED_NOTE_PAPER_BASIC_ACK_TIMEOUT");
      } catch (failure) { await fail(failure); throw failure; }
    },
    async finish() {
      if (failed || active || index !== stages.length) throw error("INSTALLED_NOTE_PAPER_BASIC_STAGE_PENDING_ACK");
      const stage = `${prefix}-complete`;
      await atomicJson(root, `${prefix}-ui-next.json`, { runId, stage });
      await atomicJson(root, "progress.json", { runId, stage });
    },
    fail,
  };
}
export async function startInstalledNativeNotePaperBasicUi({ root, python, env, port, runId, timeoutMs = 120000 }) {
  await privateDriver(root, runId, timeoutMs);
  if (!isAbsolute(python ?? "") || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw error("INSTALLED_NOTE_PAPER_BASIC_PRIVATE_UI_REQUIRED");
  const child = spawn(python, ["-B", "-c", installedNativeNotePaperBasicUiProgram,
    JSON.stringify({ root, port, runId, timeoutMs })], { env, stdio: "inherit" });
  let failure;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Note/Paper observer exited ${code}/${signal}`)));
  });
  void done.catch(value => { failure = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (failure) throw failure;
      try {
        const value = JSON.parse(await readFile(join(root, `${prefix}-ui-ready.json`)));
        if (value.ready !== true || value.actualRenderedDom !== true || value.runId !== runId)
          throw error("INSTALLED_NOTE_PAPER_BASIC_READY_BINDING_REQUIRED");
        return value;
      } catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw error("INSTALLED_NOTE_PAPER_BASIC_UI_READY_TIMEOUT");
  })();
  void ready.catch(() => {});
  return { ready, done, get error() { return failure; }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  } };
}
