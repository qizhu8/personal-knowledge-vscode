import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export const installedNativeTodoGenesisStages = Object.freeze([
  "native-todo-genesis-public-deny", "native-todo-genesis-create-deny", "native-todo-genesis-create",
  "native-todo-genesis-read-empty", "native-todo-genesis-add", "native-todo-genesis-read-created",
  "native-todo-genesis-update", "native-todo-genesis-stale-cas", "native-todo-genesis-claim",
  "native-todo-genesis-on-hold", "native-todo-genesis-retrieve", "native-todo-genesis-token-refusal",
  "native-todo-genesis-complete",
]);
export const installedNativeTodoGenesisUiProgram = String.raw`
import hashlib,json,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000
until=time.monotonic()+min(seconds*6,540)
proof={"schema":"pkm.installed-native-todo-genesis-ui-evidence/v1","runId":f["runId"],"dialogs":[],"readStages":[]}
def check(ok,message):
 if not ok:raise AssertionError(message)
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def publish(name,value):
 with (root/name).open("x") as output:json.dump(value,output)
def wait_stage(page,name):
 stop=min(until,time.monotonic()+seconds)
 while time.monotonic()<stop:
  try:
   current=json.loads((root/"progress.json").read_text()).get("stage")
   check(current!="failed","Parent Todo workflow failed")
   if current==name:return
  except (FileNotFoundError,json.JSONDecodeError):pass
  if page.locator(".monaco-dialog-box:visible").count()!=0:
   current=json.loads((root/"progress.json").read_text()).get("stage")
   if current==name:return
   raise AssertionError("Unexpected modal outside this exact Todo write stage")
  time.sleep(.025)
 raise RuntimeError("Todo observer stage timed out: "+name)
def modal(page,c,step,kind,choice):
 dialog=page.locator(".monaco-dialog-box:visible");dialog.wait_for(state="visible")
 title="Allow PKM v5 "+step["tool"]+" for this exact request?" if kind=="public" else "Create this exact public Todo Board and paired Note?"
 dialog.get_by_text(title,exact=True).wait_for(state="visible")
 check(dialog.count()==1,"One exact native modal is required")
 check(dialog.get_by_text(title,exact=True).count()==1,"Wrong exact Todo modal title")
 handle=dialog.element_handle();text=dialog.inner_text().replace("\u00a0"," ");start=text.find("{")
 check(start>=0,"Native modal omitted structured binding")
 data,_=json.JSONDecoder().raw_decode(text[start:])
 check(data["root"]==c["binding"]["root"] and data["workspaceId"]==c["binding"]["workspaceId"],"Wrong Todo Root/workspace")
 check("PRIVATE_TODO_GENESIS_CONTROL" not in text,"Private control leaked into native public review")
 if kind=="public":
  check(data["tool"]==step["tool"] and data["operation"]=="mcp.tool."+step["tool"] and data["readOnly"] is False,"Wrong Original Todo operation")
  check(data["arguments"]==step["approvalArguments"] and data["argumentsDigest"]==digest(step["approvalArguments"]),"Changed Todo arguments/digest")
  check("worker_token" not in data["arguments"],"Worker credentials must not enter PUBLIC review")
 else:
  check(data["schema"]=="pkm.original-mcp-todo-genesis-request/v1" and data["phase"]=="create","Wrong genesis phase")
  check(data["nativeEpoch"]==c["nativeEpoch"] and data["profileSha256"]==c["binding"]["profileSha256"],"Wrong exact source epoch/profile")
  check(data["custodyPlanSha256"]==c["custodyPlanSha256"] and data["catalogSha256"]==c["catalogSha256"],"Wrong genesis custody/catalog")
  check(data["nativeHostReceiptSha256"]==c["nativeHostReceiptSha256"] and data["privacySha256"]==c["privacySha256"],"Wrong source/Host privacy binding")
  check(data["actorId"]=="mcp:external" and data["operation"]=="mcp.tool.todo_board_create","Wrong genesis actor/operation")
  check(data["arguments"]==c["creationArguments"] and data["argumentsSha256"]==digest(c["creationArguments"]),"Wrong creation arguments")
  s=data["selection"];check(s["boardSlug"]==c["boardSlug"],"Wrong exact Board")
  for key,value in c["paths"].items():check(s[key]==value,"Wrong paired genesis path: "+key)
  check(re.fullmatch(r"[a-f0-9-]{36}",data["operationId"]) and s["documentId"]=="board-"+data["operationId"],"Missing generated operation/document UUID")
  check(re.fullmatch(r"[a-f0-9-]{36}",s["sourceId"]) and re.fullmatch(r"knowledge_[a-f0-9]{24}",s["knowledgeId"]),"Missing actual source/Knowledge identity")
  for key in ["note","pair","backing","canonicalBoard","canonicalDirectory"]:check(s["expectedBefore"][key]["state"]=="absent","Genesis target was not absent")
  check(s["expectedBefore"]["sourceIndex"]=="absent" and data["defaultDecision"]=="deny","Genesis must be absent/Deny-first")
  check(data["noExecution"] is True and data["noWorkerEnrollment"] is True and data["noReviewerDelegation"] is True,"Genesis grants no execution/worker/reviewer")
  body={k:v for k,v in data.items() if k not in ["requestSha256","defaultDecision","permission"]}
  check(data["requestSha256"]==digest(body),"Changed complete genesis request")
 button=dialog.get_by_role("button",name=choice,exact=True)
 check(button.count()==1 and button.is_visible() and button.is_enabled(),"Missing exact enabled native choice")
 check(dialog.get_by_role("button",name="Deny",exact=True).count()==1,"Deny is absent")
 check(handle.evaluate("(n)=>n.isConnected") and dialog.evaluate("(n,old)=>n===old",handle),"Validated modal was replaced")
 check(dialog.inner_text().replace("\u00a0"," ")==text,"Validated Todo request changed before click")
 row={"stage":step["stage"],"kind":kind,"choice":choice,"title":title,"textSha256":hashlib.sha256(text.encode()).hexdigest(),"exactRequestVisible":True}
 if kind=="genesis":row.update(operationId=data["operationId"],sourceId=s["sourceId"],knowledgeId=s["knowledgeId"],requestSha256=data["requestSha256"])
 proof["dialogs"].append(row);button.click()
try:
 check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Owned disposable installed driver required")
 c=json.loads((root/"native-todo-genesis-ui-contract.json").read_text())
 check(c["schema"]=="pkm.installed-native-todo-genesis-ui/v1" and c["runId"]==f["runId"],"Wrong Todo observer contract/run")
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
  pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
  check(len(pages)==1,"Exactly one installed workbench renderer required")
  page=pages[0];page.set_default_timeout(f["timeoutMs"]);page.wait_for_load_state("networkidle")
  publish("native-todo-genesis-ui-ready.json",{"ready":True,"actualRenderedDom":True,"runId":f["runId"]})
  for name in c["stages"]:
   wait_stage(page,name)
   if name=="native-todo-genesis-complete":break
   step=json.loads((root/"native-todo-genesis-ui-step.json").read_text())
   check(step["runId"]==f["runId"] and step["stage"]==name,"Stale Todo stage contract")
   for item in step["dialogs"]:modal(page,c,step,item["kind"],item["choice"])
   stop=min(until,time.monotonic()+seconds)
   while time.monotonic()<stop:
    try:
     if json.loads((root/"progress.json").read_text()).get("stage")==name+"-done":break
    except (FileNotFoundError,json.JSONDecodeError):pass
    check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected extra/read modal in Todo stage")
    time.sleep(.025)
   else:raise RuntimeError("Todo stage did not finish: "+name)
   if not step["dialogs"]:proof["readStages"].append({"stage":name,"noNamedReadModal":True})
   publish("native-todo-genesis-ui-ack-"+name+".json",{"runId":f["runId"],"stage":name,"complete":True})
  check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected modal after bounded Todo slice")
  proof.update(passed=True,actualRenderedDom=True,sourceRenewalPerformed=False,defaultEnterTested=False)
  publish("native-todo-genesis-ui-passed.json",proof)
except Exception as error:
 try:publish("native-todo-genesis-ui-passed.json",{"failed":True,"runId":f["runId"],"error":str(error),"observed":proof})
 except Exception:pass
 raise
`;

export async function startInstalledNativeTodoGenesisUi({ root, python, env, port, runId, timeoutMs = 120000 }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !isAbsolute(python ?? "")
    || !/^[a-f0-9-]{36}$/.test(runId ?? "") || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw Object.assign(new Error("INSTALLED_TODO_GENESIS_PRIVATE_UI_REQUIRED"), { code: "INSTALLED_TODO_GENESIS_PRIVATE_UI_REQUIRED" });
  const child = spawn(python, ["-B", "-c", installedNativeTodoGenesisUiProgram,
    JSON.stringify({ root, port, runId, timeoutMs })], { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Todo observer exited ${code}/${signal}`)));
  });
  void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (error) throw error;
      try {
        const value = JSON.parse(await readFile(join(root, "native-todo-genesis-ui-ready.json")));
        if (value.ready !== true || value.runId !== runId || value.actualRenderedDom !== true) throw new Error("Wrong Todo observer readiness.");
        return value;
      } catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Todo observer readiness timed out.");
  })();
  void ready.catch(() => {});
  return { done, ready, get error() { return error; }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  } };
}
