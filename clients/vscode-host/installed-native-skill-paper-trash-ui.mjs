import { spawn } from "node:child_process";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export const installedNativeSkillPaperTrashUiProgram = String.raw`
import hashlib,json,re,sys,time
from datetime import datetime
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000;until=time.monotonic()+min(seconds*20,1800)
proof={"schema":"pkm.installed-native-skill-paper-trash-ui-evidence/v1","runId":f["runId"],"dialogs":[]}
observer={"schema":"pkm.installed-native-skill-paper-trash-ui-status/v1","runId":f["runId"],"currentStage":None,"phase":"starting","failed":False}
def check(ok,message):
 if not ok:raise AssertionError(message)
def digest(v):return hashlib.sha256(json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def rawdigest(v):return hashlib.sha256((json.dumps(v,ensure_ascii=False,indent=2)+"\n").encode()).hexdigest()
def publish(name,value):
 with (root/name).open("x") as out:json.dump(value,out)
def status(phase,**fields):
 observer.update(phase=phase,updatedAtMs=round(time.time()*1000),**fields)
 pending=root/"native-skill-paper-trash-ui-status.next.json"
 with pending.open("w") as out:json.dump(observer,out)
 pending.replace(root/"native-skill-paper-trash-ui-status.json")
def stage(name):
 status("waiting-stage",currentStage=name)
 stop=min(until,time.monotonic()+seconds)
 while time.monotonic()<stop:
  try:
   current=json.loads((root/"progress.json").read_text()).get("stage");check(current!="failed","Parent failed")
   if current==name:
    value=json.loads((root/"native-skill-paper-trash-ui-next.json").read_text())
    if value["stage"]==name:
     check(value["runId"]==f["runId"],"Wrong stage run");status("stage-observed");return value
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Skill/Paper Trash stage timed out: "+name)
def modal(page,title):
 status("waiting-modal",expectedTitle=title)
 dialog=page.locator(".monaco-dialog-box:visible");dialog.get_by_text(title,exact=True).wait_for(state="visible")
 check(dialog.count()==1,"Exactly one actual native modal required")
 handle=dialog.element_handle();text=dialog.inner_text().replace("\u00a0"," ");start=text.find("{")
 check(start>=0,"Exact native descriptor missing")
 data,_=json.JSONDecoder().raw_decode(text[start:]);return dialog,handle,text,data
def choose(page,dialog,handle,text,choice,default=False):
 status("choosing",choice=choice)
 check(dialog.evaluate("(node,original)=>node===original",handle) and handle.evaluate("(node)=>node.isConnected"),"Modal replaced")
 check(dialog.inner_text().replace("\u00a0"," ")==text,"Descriptor changed")
 button=dialog.get_by_role("button",name=choice,exact=True)
 check(button.count()==1 and button.is_visible() and button.is_enabled(),"Unique exact enabled choice required")
 if choice=="Deny":
  if not default:button.focus()
  check(button.evaluate("(node)=>node===document.activeElement"),"Focused Deny required before Enter");page.keyboard.press("Enter")
 else:button.click()
 page.wait_for_function("(old)=>!old.node.isConnected||old.node.offsetParent===null||old.node.innerText.replaceAll('\\u00a0',' ')!==old.text",arg={"node":handle,"text":text})
 status("modal-handled")
def complete_stage(page,step):
 status("waiting-work-complete")
 stop=min(until,time.monotonic()+seconds)
 while time.monotonic()<stop:
  check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected modal after the contracted stage choices")
  try:
   current=json.loads((root/"progress.json").read_text());check(current.get("stage")!="failed","Parent failed")
   check(current.get("stage")==step["stage"],"Main advanced before observer acknowledgement")
   phase=json.loads((root/"native-skill-paper-trash-ui-phase.json").read_text())
   check(phase["runId"]==f["runId"] and phase["stage"]==step["stage"],"Wrong stage completion binding")
   if phase["phase"]=="work-complete":
    check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected modal at stage completion")
    publish("native-skill-paper-trash-ui-ack-"+step["stage"]+".json",{
     "schema":"pkm.installed-native-skill-paper-trash-ui-ack/v1","runId":f["runId"],"stage":step["stage"],
     "phase":"complete","noUnexpectedModal":True})
    status("stage-acknowledged",lastCompletedStage=step["stage"]);return
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Skill/Paper Trash work completion timed out: "+step["stage"])
def review_public(page,step,c):
 tool=step["tool"];dialog,handle,text,data=modal(page,"Allow PKM v5 "+tool+" for this exact request?")
 b=c["binding"];contracts=[item for item in c["publicContracts"] if item["tool"]==tool]
 check(len(contracts)==1,"One exact installed public contract required");contract=contracts[0]
 check(data["root"]==b["root"] and data["workspaceId"]==b["workspaceId"],"Wrong public root/workspace")
 check(data["tool"]==tool and data["operation"]==contract["operation"] and data["version"]==contract["version"]
  and data["readOnly"]==contract["readOnly"] and contract["readOnly"] is False,"Wrong exact Original operation")
 check(data["arguments"]==step["arguments"] and data["argumentsDigest"]==digest(step["arguments"]),"Wrong exact public arguments")
 proof["dialogs"].append({"stage":step["stage"],"type":"public","choice":step["publicChoice"],"argumentsDigest":data["argumentsDigest"],"focusedEnterDenial":step["publicChoice"]=="Deny"})
 choose(page,dialog,handle,text,step["publicChoice"])
try:
 check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Private branded driver required")
 c=json.loads((root/"native-skill-paper-trash-ui-contract.json").read_text())
 check(c["schema"]=="pkm.installed-native-skill-paper-trash-ui/v1" and c["runId"]==f["runId"],"Wrong contract/run")
 check([v["area"] for v in c["owners"]]==["skills","papers"],"Only exact Skill/Paper gate allowed")
 seen=set()
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
  pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
  check(len(pages)==1,"Exactly one actual installed workbench required")
  page=pages[0];page.set_default_timeout(f["timeoutMs"]);page.wait_for_load_state("networkidle")
  publish("native-skill-paper-trash-ui-ready.json",{"ready":True,"actualRenderedDom":True,"runId":f["runId"]})
  for step in c["stages"]:
   expected=stage(step["stage"]);area=step["area"];name="Skill" if area=="skills" else "Paper"
   if step.get("noReview"):complete_stage(page,step);continue
   if step.get("publicChoice"):
    review_public(page,step,c)
   if not step.get("action"):complete_stage(page,step);continue
   action=step["action"]
   if action=="move":yes="Move this exact "+name+" to Trash once";title="Move this exact public "+name+" and paired assets to Trash?"
   elif action=="restore":yes="Restore this exact "+name+" once";title="Restore this exact public "+name+" and paired assets?"
   else:yes="Read these exact "+name+" Trash entries once";title="Read these exact public "+name+" Trash entries?"
   dialog,handle,text,data=modal(page,title);buttons=dialog.get_by_role("button").all_text_contents()
   deny=dialog.get_by_role("button",name="Deny",exact=True)
   check(data["defaultDecision"]=="deny" and deny.count()==1 and deny.evaluate("(node)=>node===document.activeElement"),"Actual default-focused Deny is required")
   check(dialog.get_by_role("button",name=yes,exact=True).count()==1 and "Approve this request" not in buttons,"No generic Trash grant")
   request={k:data[k] for k in ["schema","phase","subject","nativeHostReceiptSha256","nativeEpoch"]};s=request["subject"];b=c["binding"]
   check(request["schema"]=="pkm.original-native-trash-request/v2" and request["phase"]=="execute","Wrong strict v2 request")
   check(data["requestSha256"]==digest(request),"Wrong whole request digest")
   for key in ["root","workspaceId","catalogSha256","profileSha256","custodyPlanSha256","privacySha256"]:check(s[key]==b[key],"Wrong native binding: "+key)
   check(request["nativeEpoch"]==b["epoch"] and request["nativeHostReceiptSha256"]==b["nativeHostReceiptSha256"],"Wrong signed epoch/receipt")
   check(s["area"]==area and s["actorId"]=="mcp:external" and s["action"]==action and s["operation"]=="knowledge.trash."+action,"Wrong area/actor/operation")
   check(s["sourceOriginalSha256"]==c["originalPackageSha256"],"Wrong Original source")
   check(re.fullmatch(r"[a-f0-9-]{36}",s["operationId"]) and s["operationId"] not in seen,"Fresh exact operation UUID required");seen.add(s["operationId"])
   check("DISPOSABLE_PRIVATE_SKILL_PAPER" not in text and "/Private/" not in text,"Private bytes or paths published")
   for item in s["selection"]:
    check(item["area"]==area and item["readOnlyOriginalBucket"] is False and item["treeSha256"]==digest(item["inventory"]),"Wrong receipt-owned area/tree")
   if action=="move":
    check(len(s["selection"])==1,"Exactly one public owned pair required");item=s["selection"][0];m=item["metadata"];owner=expected["owner"]
    check(item["path"]==owner["path"] and item["document"]=={k:owner[k] for k in ["id","knowledgeId","revision","sha256"]},"Wrong raw Original identity/revision")
    check(item["inventory"]==expected["inventory"],"Wrong physical pair inventory")
    check(m["kind"]==("skill" if area=="skills" else "item") and m["name"]==owner["metadataName"] and m["originalPath"]==owner["path"] and m["assetsPath"]==owner["pairPath"],"Wrong exact Original bucket metadata")
    check(m["id"]==item["entryId"] and re.fullmatch(r"[0-9]+-[a-f0-9]{10}",m["id"]),"Wrong bucket ID")
    check(int(m["id"].split("-")[0])==round(datetime.fromisoformat(m["deletedAt"].replace("Z","+00:00")).timestamp()*1000),"Wrong bucket timestamp")
    check(item["metadataSha256"]==rawdigest(m),"Wrong raw bucket metadata")
    check(s["publicRequest"]=={"tool":step["tool"],"version":1,"argumentsDigest":digest(step["arguments"])},"Wrong public predecessor request")
    check(s["custodyPredecessorSha256"]==expected["predecessorSha256"] and s["historyBeforeSha256"]==rawdigest(expected["history"]),"Wrong B0/receipt predecessor")
    after={"schema":1,"records":expected["history"]["records"]+[{"path":path,"deletedAt":m["deletedAt"]} for path in expected["removedPaths"]]}
    check(s["historyAfterSha256"]==rawdigest(after),"Wrong ordered Original document/pair history")
   else:
    check(s==expected["subject"],"Wrong exact bucket/CAS/history/custody selection")
    check(s["canonicalArgumentsDigest"]==digest(expected["arguments"]) and s["operationId"]==expected["arguments"]["operationId"],"Wrong canonical arguments")
   proof["dialogs"].append({"stage":step["stage"],"type":"trash","choice":step["choice"],"request":request,"requestSha256":data["requestSha256"],"defaultDenyFocused":True,"defaultEnterDenial":step["choice"]=="Deny"})
   choose(page,dialog,handle,text,step["choice"],default=True)
   complete_stage(page,step)
  stage("native-skill-paper-trash-complete")
  check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected replay modal")
  proof.update(passed=True,actualRenderedDom=True);status("complete");publish("native-skill-paper-trash-ui-passed.json",proof)
except Exception as error:
 try:status("failed",failed=True,error=str(error))
 except Exception:pass
 try:publish("native-skill-paper-trash-ui-passed.json",{"failed":True,"runId":f["runId"],"error":str(error),"observed":proof})
 except Exception:pass
 raise
`;

async function atomicJson(root, name, value) {
  const pending = join(root, `${name}.next`);
  await writeFile(pending, JSON.stringify(value), { mode: 0o600 });
  await rename(pending, join(root, name));
}
export async function readInstalledNativeSkillPaperTrashObserverStatus(root, runId) {
  try {
    const value = JSON.parse(await readFile(join(root, "native-skill-paper-trash-ui-status.json")));
    if (value.schema !== "pkm.installed-native-skill-paper-trash-ui-status/v1" || value.runId !== runId)
      throw new Error("Wrong observer status binding");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { runId, phase: "not-recorded", failed: false };
    throw error;
  }
}
/** Test/controller synchronization only; stage acknowledgements never grant a native operation. */
export async function createInstalledNativeSkillPaperTrashStageProtocol({ root, runId, timeoutMs, stages, check = () => {} }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !/^[a-f0-9-]{36}$/.test(runId)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || !Array.isArray(stages) || !stages.length || new Set(stages).size !== stages.length
    || stages.some(stage => typeof stage !== "string" || !/^native-(skill|paper)-trash-[a-z-]+$/.test(stage)))
    throw Object.assign(new Error("INSTALLED_SKILL_PAPER_TRASH_STAGE_PROTOCOL_REQUIRED"), { code: "INSTALLED_SKILL_PAPER_TRASH_STAGE_PROTOCOL_REQUIRED" });
  let active, index = 0, failed = false;
  const fail = async (error) => {
    failed = true;
    const observer = await readInstalledNativeSkillPaperTrashObserverStatus(root, runId).catch(value => ({ error: String(value) }));
    const failure = { schema: "pkm.installed-native-skill-paper-trash-failure/v1", runId,
      stage: active ?? null, error: String(error), code: error.code ?? null, observer };
    await atomicJson(root, "native-skill-paper-trash-failure.json", failure);
    return failure;
  };
  const error = code => Object.assign(new Error(code), { code });
  return {
    async begin(stage, data = {}) {
      if (failed || active || stage !== stages[index]) throw error("INSTALLED_SKILL_PAPER_TRASH_STAGE_PENDING_ACK");
      await check(); active = stage;
      await atomicJson(root, "native-skill-paper-trash-ui-phase.json", { runId, stage, phase: "work-started" });
      await atomicJson(root, "native-skill-paper-trash-ui-next.json", { ...data, runId, stage });
      await atomicJson(root, "progress.json", { runId, stage });
    },
    async complete(stage) {
      if (failed || active !== stage) throw error("INSTALLED_SKILL_PAPER_TRASH_STAGE_BINDING_REQUIRED");
      try {
        await check();
        await atomicJson(root, "native-skill-paper-trash-ui-phase.json", { runId, stage, phase: "work-complete" });
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
          await check();
          const observer = await readInstalledNativeSkillPaperTrashObserverStatus(root, runId);
          if (observer.failed) throw error("INSTALLED_SKILL_PAPER_TRASH_OBSERVER_FAILED");
          try {
            const ack = JSON.parse(await readFile(join(root, `native-skill-paper-trash-ui-ack-${stage}.json`)));
            if (ack.schema !== "pkm.installed-native-skill-paper-trash-ui-ack/v1" || ack.runId !== runId
              || ack.stage !== stage || ack.phase !== "complete" || ack.noUnexpectedModal !== true)
              throw error("INSTALLED_SKILL_PAPER_TRASH_ACK_BINDING_MISMATCH");
            active = undefined; index++; return ack;
          } catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw error("INSTALLED_SKILL_PAPER_TRASH_ACK_TIMEOUT");
      } catch (value) { await fail(value); throw value; }
    },
    async finish() {
      if (failed || active || index !== stages.length) throw error("INSTALLED_SKILL_PAPER_TRASH_STAGE_PENDING_ACK");
      const stage = "native-skill-paper-trash-complete";
      await atomicJson(root, "native-skill-paper-trash-ui-next.json", { runId, stage });
      await atomicJson(root, "progress.json", { runId, stage });
    },
    fail,
  };
}

export async function startInstalledNativeSkillPaperTrashUi({ root, python, env, port, runId, timeoutMs = 120000 }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !isAbsolute(python ?? "")
    || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9-]{36}$/.test(runId)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw Object.assign(new Error("INSTALLED_SKILL_PAPER_TRASH_PRIVATE_UI_REQUIRED"), { code: "INSTALLED_SKILL_PAPER_TRASH_PRIVATE_UI_REQUIRED" });
  const child = spawn(python, ["-B", "-c", installedNativeSkillPaperTrashUiProgram, JSON.stringify({ root, port, runId, timeoutMs })],
    { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Skill/Paper Trash observer exited ${code}/${signal}`)));
  });
  void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (error) throw error;
      try {
        const value = JSON.parse(await readFile(join(root, "native-skill-paper-trash-ui-ready.json")));
        if (value.ready !== true || value.actualRenderedDom !== true || value.runId !== runId) throw new Error("Wrong observer readiness");
        return value;
      } catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Skill/Paper Trash observer readiness timed out");
  })();
  void ready.catch(() => {});
  return { ready, done, get error() { return error; },
    status: () => readInstalledNativeSkillPaperTrashObserverStatus(root, runId), async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  } };
}
