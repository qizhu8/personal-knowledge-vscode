import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export const installedNativeTodoLifecycleStages = Object.freeze([
  { stage: "native-todo-lifecycle-cancel-create", phase: "create", transportAbort: true },
  { stage: "native-todo-lifecycle-create", phase: "create", choice: "Create this exact Board once" },
  { stage: "native-todo-lifecycle-get" },
  { stage: "native-todo-lifecycle-add" },
  { stage: "native-todo-lifecycle-update" },
  { stage: "native-todo-lifecycle-revoke-get" },
  { stage: "native-todo-lifecycle-revoked-update" },
  { stage: "native-todo-lifecycle-activate-deny", phase: "activate-source", choice: "Deny" },
  { stage: "native-todo-lifecycle-denied-get" },
  { stage: "native-todo-lifecycle-cancel-activate", phase: "activate-source", transportAbort: true },
  { stage: "native-todo-lifecycle-cancelled-get" },
  { stage: "native-todo-lifecycle-activate", phase: "activate-source", choice: "Activate this exact Board source" },
  { stage: "native-todo-lifecycle-renewed-get" },
  { stage: "native-todo-lifecycle-renewed-update" },
  { stage: "native-todo-lifecycle-final-read" },
].map(Object.freeze));

export const installedNativeTodoLifecycleUiProgram = String.raw`
import hashlib,json,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000;until=time.monotonic()+min(seconds*8,900)
proof={"schema":"pkm.installed-native-todo-lifecycle-ui-evidence/v1","runId":f["runId"],"dialogs":[],"readStages":[]}
def check(ok,message):
 if not ok:raise AssertionError(message)
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(",",":")).encode()).hexdigest()
def publish(name,value):
 with (root/name).open("x") as output:json.dump(value,output)
def waitjson(name):
 stop=min(until,time.monotonic()+seconds)
 while time.monotonic()<stop:
  try:return json.loads((root/name).read_text())
  except (FileNotFoundError,json.JSONDecodeError):time.sleep(.025)
 raise RuntimeError("Todo lifecycle evidence timed out: "+name)
def stage(name):
 stop=min(until,time.monotonic()+seconds)
 while time.monotonic()<stop:
  try:
   value=json.loads((root/"progress.json").read_text());check(value.get("stage")!="failed","Parent lifecycle workflow failed")
   if value.get("stage")==name:
    step=json.loads((root/"native-todo-lifecycle-ui-step.json").read_text())
    check(step["runId"]==f["runId"] and step["stage"]==name,"Wrong lifecycle stage/run")
    return step
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Todo lifecycle stage timed out: "+name)
def modal(page,title):
 dialog=page.locator(".monaco-dialog-box:visible");dialog.get_by_text(title,exact=True).wait_for(state="visible")
 check(dialog.count()==1,"Exactly one native Todo lifecycle modal required")
 handle=dialog.element_handle();text=dialog.inner_text().replace("\u00a0"," ");start=text.find("{")
 check(start>=0,"Exact native Todo descriptor required")
 data,_=json.JSONDecoder().raw_decode(text[start:])
 return dialog,handle,text,data
def stable(dialog,handle,text):
 check(dialog.evaluate("(node,original)=>node===original",handle) and handle.evaluate("(node)=>node.isConnected"),"Native Todo modal replaced")
 check(dialog.inner_text().replace("\u00a0"," ")==text,"Exact native descriptor changed before choice")
def choose(page,dialog,handle,text,choice):
 stable(dialog,handle,text);button=dialog.get_by_role("button",name=choice,exact=True)
 check(button.count()==1 and button.is_visible() and button.is_enabled(),"Exact enabled native choice required")
 if choice=="Deny":
  check(button.evaluate("(node)=>node===document.activeElement"),"Default-focused Deny required");page.keyboard.press("Enter")
 else:button.click()
 page.wait_for_function("(old)=>!old.node.isConnected||old.node.offsetParent===null||old.node.innerText.replaceAll('\\u00a0',' ')!==old.text",arg={"node":handle,"text":text})
try:
 check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Owned installed driver required")
 c=waitjson("native-todo-lifecycle-ui-contract.json")
 check(c["schema"]=="pkm.installed-native-todo-lifecycle-ui/v1" and c["runId"]==f["runId"],"Wrong Todo lifecycle contract/run")
 labels={"create":("Create this exact Board once","Create this exact public Todo Board and paired Note?"),
  "activate-source":("Activate this exact Board source","Activate this exact public Todo Board source for this session?")}
 source=None
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
  pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
  check(len(pages)==1,"Exactly one installed workbench required")
  page=pages[0];page.set_default_timeout(f["timeoutMs"]);page.wait_for_load_state("networkidle")
  publish("native-todo-lifecycle-ui-ready.json",{"ready":True,"runId":f["runId"],"actualRenderedDom":True})
  for declared in c["stages"]:
   step=stage(declared["stage"])
   for key,value in declared.items():check(step[key]==value,"Changed declared lifecycle action")
   if step.get("tool"):
    dialog,handle,text,data=modal(page,"Allow PKM v5 "+step["tool"]+" for this exact request?")
    check(data["root"]==c["binding"]["root"] and data["workspaceId"]==c["binding"]["workspaceId"],"Wrong PUBLIC Root/workspace")
    check(data["tool"]==step["tool"] and data["operation"]=="mcp.tool."+step["tool"] and data["readOnly"] is False and data["version"]==1,"Wrong PUBLIC operation")
    check(data["arguments"]==step["approvalArguments"] and data["argumentsDigest"]==digest(step["approvalArguments"]),"Wrong exact PUBLIC arguments")
    check("worker_token" not in data["arguments"],"PUBLIC credentials are forbidden")
    proof["dialogs"].append({"stage":step["stage"],"kind":"public","choice":"Approve this request","argumentsDigest":data["argumentsDigest"]})
    choose(page,dialog,handle,text,"Approve this request")
   if step.get("phase"):
    phase=step["phase"];yes,title=labels[phase];dialog,handle,text,data=modal(page,title)
    deny=dialog.get_by_role("button",name="Deny",exact=True)
    check(data["defaultDecision"]=="deny" and deny.count()==1 and deny.evaluate("(node)=>node===document.activeElement"),"Native Todo Deny must be default focused")
    check(dialog.get_by_role("button",name=yes,exact=True).count()==1,"Phase-specific affirmative choice required")
    check(dialog.get_by_role("button",name="Approve this request",exact=True).count()==0,"PUBLIC decision cannot grant source authority")
    request={key:value for key,value in data.items() if key not in ["requestSha256","defaultDecision","permission"]}
    check(request["schema"]=="pkm.original-mcp-todo-genesis-request/v1" and request["phase"]==phase,"Wrong native lifecycle phase")
    check(data["requestSha256"]==digest(request),"Wrong exact native lifecycle request hash")
    for key,value in c["binding"].items():check(request[key]==value,"Wrong native Root/Host/profile/epoch binding: "+key)
    check(request["actorId"]=="mcp:external" and request["operation"]=="mcp.tool.todo_board_create","Wrong native actor/operation")
    check(request["arguments"]==c["creationArguments"] and request["argumentsSha256"]==digest(c["creationArguments"]),"Wrong source creation arguments")
    s=request["selection"];check(s["boardSlug"]==c["boardSlug"],"Wrong exact source Board")
    for key,value in c["paths"].items():check(s[key]==value,"Wrong paired source path")
    check(re.fullmatch(r"[a-f0-9-]{36}",request["operationId"]) and s["documentId"]=="board-"+request["operationId"],"Wrong source operation/document identity")
    check(re.fullmatch(r"[a-f0-9-]{36}",s["sourceId"]) and re.fullmatch(r"knowledge_[a-f0-9]{24}",s["knowledgeId"]),"Wrong source/Knowledge identity")
    state="absent" if phase=="create" else "present"
    for key in ["note","pair","backing","canonicalBoard","canonicalDirectory"]:check(s["expectedBefore"][key]["state"]==state,"Wrong current-file source snapshot")
    check(s["expectedBefore"]["sourceIndex"]==state,"Wrong durable source-index state")
    check(request["noExecution"] is True and request["noWorkerEnrollment"] is True and request["noReviewerDelegation"] is True,"Source review grants no worker/execution/reviewer")
    check("PRIVATE_TODO_GENESIS_CONTROL" not in text and "/Private/" not in text,"Private control leaked into source review")
    if phase=="activate-source":
     check(source is not None,"Activation cannot precede actual creation")
     check({key:s[key] for key in ["sourceId","documentId","knowledgeId","descriptorSha256","backingSha256"]}==source["selection"],"Activation changed exact source identity")
     check(request["operationId"]==source["operationId"],"Activation must keep existing canonical creation ID")
    row={"stage":step["stage"],"kind":"genesis","phase":phase,"choice":step.get("choice",yes),"operationId":request["operationId"],
     "sourceId":s["sourceId"],"knowledgeId":s["knowledgeId"],"requestSha256":data["requestSha256"],"request":request,"defaultDenyFocused":True}
    proof["dialogs"].append(row)
    if step.get("transportAbort"):
     stable(dialog,handle,text)
     publish("native-todo-lifecycle-abort-ready-"+phase+".json",{"runId":f["runId"],"stage":step["stage"],
      "request":request,"requestSha256":data["requestSha256"],"actualRenderedDom":True})
     settled=waitjson("native-todo-lifecycle-abort-settled-"+phase+".json")
     check(settled["runId"]==f["runId"] and settled["stage"]==step["stage"] and settled["operationId"]==request["operationId"]
      and settled["requestSha256"]==data["requestSha256"] and settled["code"]=="NATIVE_REQUEST_CANCELLED"
      and settled["settledBeforeLateClick"] is True,"Actual transport must settle before late choice")
     stable(dialog,handle,text);choose(page,dialog,handle,text,yes)
     publish("native-todo-lifecycle-late-click-"+phase+".json",{"runId":f["runId"],"stage":step["stage"],
      "operationId":request["operationId"],"requestSha256":data["requestSha256"],"sameRenderedModal":True})
     row.update(lateClickSameModal=True,transportSettledBeforeClick=True)
    else:
     choose(page,dialog,handle,text,step["choice"])
     if step["choice"]=="Deny":row.update(defaultEnterDenial=True)
     elif phase=="create":source={"operationId":request["operationId"],"selection":{key:s[key] for key in ["sourceId","documentId","knowledgeId","descriptorSha256","backingSha256"]}}
   stop=min(until,time.monotonic()+seconds)
   while time.monotonic()<stop:
    current=waitjson("progress.json").get("stage");check(current!="failed","Parent lifecycle workflow failed")
    check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected extra/read modal")
    if current==step["stage"]+"-done":break
    time.sleep(.025)
   else:raise RuntimeError("Todo lifecycle stage did not finish")
   if not step.get("tool") and not step.get("phase"):proof["readStages"].append({"stage":step["stage"],"noNamedReadModal":True})
   publish("native-todo-lifecycle-ui-ack-"+step["stage"]+".json",{"runId":f["runId"],"stage":step["stage"],"complete":True})
  stop=min(until,time.monotonic()+seconds)
  while time.monotonic()<stop:
   current=waitjson("progress.json").get("stage");check(current!="failed","Parent lifecycle workflow failed")
   check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected modal after lifecycle")
   if current=="native-todo-lifecycle-complete":break
   time.sleep(.025)
  else:raise RuntimeError("Todo lifecycle completion timed out")
  proof.update(passed=True,actualRenderedDom=True)
  publish("native-todo-lifecycle-ui-passed.json",proof)
except Exception as error:
 try:publish("native-todo-lifecycle-ui-passed.json",{"failed":True,"runId":f["runId"],"error":str(error),"observed":proof})
 except Exception:pass
 raise
`;

export async function startInstalledNativeTodoLifecycleUi({ root, python, env, port, runId, timeoutMs = 120000 }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !isAbsolute(python ?? "")
    || !/^[a-f0-9-]{36}$/.test(runId ?? "") || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw Object.assign(new Error("INSTALLED_TODO_LIFECYCLE_PRIVATE_UI_REQUIRED"), { code: "INSTALLED_TODO_LIFECYCLE_PRIVATE_UI_REQUIRED" });
  const child = spawn(python, ["-B", "-c", installedNativeTodoLifecycleUiProgram, JSON.stringify({ root, port, runId, timeoutMs })],
    { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Todo lifecycle observer exited ${code}/${signal}`)));
  });
  void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (error) throw error;
      try {
        const value = JSON.parse(await readFile(join(root, "native-todo-lifecycle-ui-ready.json")));
        if (value.ready !== true || value.actualRenderedDom !== true || value.runId !== runId) throw new Error("Wrong lifecycle readiness");
        return value;
      } catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Todo lifecycle observer readiness timed out");
  })();
  void ready.catch(() => {});
  return { ready, done, get error() { return error; }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  } };
}
