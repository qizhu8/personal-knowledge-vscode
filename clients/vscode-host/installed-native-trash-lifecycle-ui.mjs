import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export const installedNativeTrashLifecycleUiProgram = String.raw`
import hashlib,json,re,sys,time
from datetime import datetime
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000;until=time.monotonic()+min(seconds*8,900)
proof={"schema":"pkm.installed-native-trash-lifecycle-ui-evidence/v1","runId":f["runId"],"dialogs":[]}
def check(ok,message):
 if not ok:raise AssertionError(message)
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(",",":")).encode()).hexdigest()
def rawdigest(value):return hashlib.sha256((json.dumps(value,ensure_ascii=False,indent=2)+"\n").encode()).hexdigest()
def publish(name,value):
 with (root/name).open("x") as output:json.dump(value,output)
def waitjson(name):
 stop=min(until,time.monotonic()+seconds)
 while time.monotonic()<stop:
  try:return json.loads((root/name).read_text())
  except (FileNotFoundError,json.JSONDecodeError):time.sleep(.025)
 raise RuntimeError("Lifecycle evidence timed out: "+name)
def stage(name):
 stop=min(until,time.monotonic()+seconds)
 while time.monotonic()<stop:
  try:
   value=json.loads((root/"progress.json").read_text());check(value.get("stage")!="failed","Parent workflow failed")
   if value.get("stage")==name:
    expected=json.loads((root/"native-trash-lifecycle-ui-next.json").read_text())
    if expected["stage"]==name:return expected
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Lifecycle stage timed out: "+name)
def modal(page,title):
 dialog=page.locator(".monaco-dialog-box:visible");dialog.get_by_text(title,exact=True).wait_for(state="visible")
 check(dialog.count()==1,"Exactly one native lifecycle modal required")
 handle=dialog.element_handle();text=dialog.inner_text().replace("\u00a0"," ");start=text.find("{")
 check(start>=0,"Exact native descriptor required")
 data,_=json.JSONDecoder().raw_decode(text[start:])
 return dialog,handle,text,data
def stable(dialog,handle,text):
 check(dialog.evaluate("(node,original)=>node===original",handle) and handle.evaluate("(node)=>node.isConnected"),"Native modal replaced")
 check(dialog.inner_text().replace("\u00a0"," ")==text,"Native descriptor changed before action")
def choose(page,dialog,handle,text,choice):
 stable(dialog,handle,text);button=dialog.get_by_role("button",name=choice,exact=True)
 check(button.count()==1 and button.is_visible() and button.is_enabled(),"Exact enabled native choice required")
 if choice=="Deny":
  check(button.evaluate("(node)=>node===document.activeElement"),"Default-focused Deny required");page.keyboard.press("Enter")
 else:button.click()
 page.wait_for_function("(old)=>!old.node.isConnected||old.node.offsetParent===null||old.node.innerText.replaceAll('\\u00a0',' ')!==old.text",arg={"node":handle,"text":text})
try:
 check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Owned installed driver required")
 c=waitjson("native-trash-lifecycle-ui-contract.json")
 check(c["schema"]=="pkm.installed-native-trash-lifecycle-ui/v1" and c["runId"]==f["runId"],"Wrong lifecycle contract/run")
 check(len(c["stages"])==11,"Only exact bounded lifecycle stages qualify")
 seen=set();labels={"move":("Move this exact Note to Trash once","Move this exact public Note and paired assets to Trash?"),
  "restore":("Restore this exact Note once","Restore this exact public Note and paired assets?"),
  "list":("Read these exact Trash entries once","Read these exact public Note Trash entries?")}
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
  pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
  check(len(pages)==1,"Exactly one installed workbench required")
  page=pages[0];page.set_default_timeout(f["timeoutMs"]);page.wait_for_load_state("networkidle")
  publish("native-trash-lifecycle-ui-ready.json",{"ready":True,"runId":f["runId"],"actualRenderedDom":True})
  for step in c["stages"]:
   if step.get("noReview"):continue
   expected=stage(step["stage"])
   if step.get("tool"):
    dialog,handle,text,data=modal(page,"Allow PKM v5 "+step["tool"]+" for this exact request?")
    check(data["root"]==c["binding"]["root"] and data["workspaceId"]==c["binding"]["workspaceId"],"Wrong public root/workspace")
    check(data["tool"]==step["tool"] and data["operation"]=="mcp.tool."+step["tool"] and data["version"]==1 and data["readOnly"] is False,"Wrong public operation")
    check(data["arguments"]==step["arguments"] and data["argumentsDigest"]==digest(step["arguments"]),"Wrong public arguments")
    proof["dialogs"].append({"stage":step["stage"],"type":"public","choice":step["publicChoice"],"argumentsDigest":data["argumentsDigest"]})
    choose(page,dialog,handle,text,step["publicChoice"])
   if not step.get("action"):continue
   action=step["action"];yes,title=labels[action];dialog,handle,text,data=modal(page,title)
   buttons=dialog.get_by_role("button").all_text_contents();deny=dialog.get_by_role("button",name="Deny",exact=True)
   check(data["defaultDecision"]=="deny" and deny.count()==1 and deny.evaluate("(node)=>node===document.activeElement"),"Native lifecycle Deny must remain default focused")
   check(dialog.get_by_role("button",name=yes,exact=True).count()==1 and "Approve this request" not in buttons,"Exact action-specific choice required")
   request={key:data[key] for key in ["schema","phase","subject","nativeHostReceiptSha256","nativeEpoch"]}
   check(request["schema"]=="pkm.original-native-trash-request/v1" and request["phase"]=="execute","Wrong lifecycle protocol/phase")
   check(data["requestSha256"]==digest(request),"Wrong whole native request hash")
   s=request["subject"];b=c["binding"]
   for key in ["root","workspaceId","catalogSha256","profileSha256","custodyPlanSha256","privacySha256"]:check(s[key]==b[key],"Wrong current root/profile/custody binding")
   check(request["nativeEpoch"]==b["epoch"] and request["nativeHostReceiptSha256"]==b["nativeHostReceiptSha256"],"Wrong current native epoch/receipt")
   check(s["action"]==action and s["operation"]=="knowledge.trash."+action and s["actorId"]=="mcp:external","Wrong native operation/actor")
   check(s["sourceOriginalSha256"]=="1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27","Wrong original source pin")
   check(re.fullmatch(r"[a-f0-9-]{36}",s["operationId"]) and s["operationId"] not in seen,"Fresh one-use operation required");seen.add(s["operationId"])
   check("DISPOSABLE_PRIVATE_LIFECYCLE_REFERRER" not in text and "/Private/" not in text,"Private source leaked into native descriptor")
   if action=="move":
    check(len(s["selection"])==1,"Exact single Note selection required");item=s["selection"][0];m=item["metadata"]
    check(item["path"]==expected["path"] and item["document"]==expected["document"] and item["inventory"]==expected["inventory"],"Wrong exact source/identity/inventory")
    check(item["treeSha256"]==digest(item["inventory"]) and item["readOnlyOriginalBucket"] is False,"Wrong selected tree/source authority")
    check(m["id"]==item["entryId"] and re.fullmatch(r"[0-9]+-[a-f0-9]{10}",m["id"]) and m["kind"]=="item" and m["originalPath"]==expected["path"],"Wrong original metadata/bucket")
    check(int(m["id"].split("-")[0])==round(datetime.fromisoformat(m["deletedAt"].replace("Z","+00:00")).timestamp()*1000),"Wrong original deletion timestamp")
    check(item["metadataSha256"]==rawdigest(m),"Wrong exact original metadata bytes")
    check(("assetsPath" in m)==expected["paired"],"Wrong owned pair mapping")
    if expected["paired"]:check(m["assetsPath"]==expected["path"].replace(".md",".assets"),"Wrong paired destination")
    check(s["custodyPredecessorSha256"]==expected["predecessorSha256"] and s["historyBeforeSha256"]==expected["historyBeforeSha256"],"Wrong custody predecessor/history")
    paths=sorted(["notes/"+expected["path"]]+[row["path"] for row in expected["inventory"] if row["kind"]=="file" and row["path"]!="notes/"+expected["path"]])
    paths=["notes/"+expected["path"]]+[path for path in paths if path!="notes/"+expected["path"]]
    history={"schema":1,"records":[row for row in expected["history"]["records"] if row["path"] not in paths]+[{"path":path,"deletedAt":m["deletedAt"]} for path in paths]}
    check(s["historyAfterSha256"]==rawdigest(history),"Wrong exact ordered deletion history")
    check(s["publicRequest"]=={"tool":step["tool"],"version":1,"argumentsDigest":digest(step["arguments"])},"Wrong public/native request pairing")
   else:
    check(s==expected["subject"] and s["operationId"]==expected["arguments"]["operationId"],"Wrong exact canonical subject/request")
    check(s["canonicalArgumentsDigest"]==digest(expected["arguments"]),"Wrong canonical arguments hash")
   proof["dialogs"].append({"stage":step["stage"],"type":"trash","choice":step["choice"],"request":request,
    "requestSha256":data["requestSha256"],"defaultDenyFocused":True,"defaultEnterDenial":step["choice"]=="Deny"})
   if step.get("transportAbort"):
    stable(dialog,handle,text)
    publish("native-trash-lifecycle-abort-ready.json",{"runId":f["runId"],"stage":step["stage"],"operationId":s["operationId"],
     "requestSha256":data["requestSha256"],"request":request,"actualRenderedDom":True})
    settled=waitjson("native-trash-lifecycle-abort-settled.json")
    check(settled["runId"]==f["runId"] and settled["stage"]==step["stage"] and settled["operationId"]==s["operationId"]
     and settled["requestSha256"]==data["requestSha256"] and settled["code"]=="NATIVE_REQUEST_CANCELLED" and settled["settledBeforeLateClick"] is True,"Actual transport cancellation must settle before late click")
    stable(dialog,handle,text);choose(page,dialog,handle,text,yes)
    publish("native-trash-lifecycle-late-click.json",{"runId":f["runId"],"stage":step["stage"],"operationId":s["operationId"],
     "requestSha256":data["requestSha256"],"sameRenderedModal":True})
    proof.update(transportAbortedBeforeLateClick=True,lateClickSameModal=True)
   else:choose(page,dialog,handle,text,step["choice"])
  stop=min(until,time.monotonic()+seconds)
  while time.monotonic()<stop:
   try:
    current=json.loads((root/"progress.json").read_text()).get("stage");check(current!="failed","Parent workflow failed")
    if current=="native-trash-lifecycle-complete":break
   except (FileNotFoundError,json.JSONDecodeError):pass
   time.sleep(.025)
  else:raise RuntimeError("Lifecycle completion timed out")
  check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected extra/replay modal")
  check(len(proof["dialogs"])==11,"Missing exact lifecycle dialogs")
  proof.update(passed=True,actualRenderedDom=True)
  publish("native-trash-lifecycle-ui-passed.json",proof)
except Exception as error:
 try:publish("native-trash-lifecycle-ui-passed.json",{"failed":True,"runId":f["runId"],"error":str(error),"observed":proof})
 except Exception:pass
 raise
`;

export async function startInstalledNativeTrashLifecycleUi({ root, python, env, port, runId, timeoutMs = 120000 }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !isAbsolute(python ?? "") || !/^[a-f0-9-]{36}$/.test(runId)
    || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw Object.assign(new Error("INSTALLED_TRASH_LIFECYCLE_PRIVATE_UI_REQUIRED"), { code: "INSTALLED_TRASH_LIFECYCLE_PRIVATE_UI_REQUIRED" });
  const child = spawn(python, ["-B", "-c", installedNativeTrashLifecycleUiProgram, JSON.stringify({ root, port, runId, timeoutMs })],
    { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) =>
    code === 0 ? resolve() : reject(new Error(`Lifecycle observer exited ${code}/${signal}`))); });
  void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (error) throw error;
      try { const value = JSON.parse(await readFile(join(root, "native-trash-lifecycle-ui-ready.json")));
        if (value.ready !== true || value.actualRenderedDom !== true || value.runId !== runId) throw new Error("Wrong lifecycle readiness"); return value; }
      catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Lifecycle observer readiness timed out");
  })();
  void ready.catch(() => {});
  return { ready, done, get error() { return error; }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  } };
}
