import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export const installedNativeTodoRecoveryStages = Object.freeze({
  create: "native-todo-recovery-create-review-ready",
  deny: "native-todo-recovery-deny-review-ready",
  approve: "native-todo-recovery-approve-review-ready",
});
export const installedNativeTodoRecoveryUiProgram = String.raw`
import hashlib,json,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);until=time.monotonic()+f["timeoutMs"]/1000
proof={"schema":"pkm.installed-native-todo-recovery-ui-evidence/v1","runId":f["runId"],"decision":f["decision"],"dialogs":[]}
def check(ok,message):
 if not ok:raise AssertionError(message)
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(",",":")).encode()).hexdigest()
def publish(name,value):
 with (root/name).open("x") as output:json.dump(value,output)
def waitjson(name):
 while time.monotonic()<until:
  try:return json.loads((root/name).read_text())
  except (FileNotFoundError,json.JSONDecodeError):time.sleep(.025)
 raise RuntimeError("Todo recovery marker timed out: "+name)
def modal(page,title):
 dialog=page.locator(".monaco-dialog-box:visible");dialog.get_by_text(title,exact=True).wait_for(state="visible")
 check(dialog.count()==1,"Exactly one genuine native Todo modal required")
 handle=dialog.element_handle();text=dialog.inner_text().replace("\u00a0"," ");start=text.find("{")
 check(start>=0,"Exact rendered descriptor required");data,_=json.JSONDecoder().raw_decode(text[start:])
 return dialog,handle,text,data
def choose(page,dialog,handle,text,choice):
 check(handle.evaluate("(node)=>node.isConnected") and dialog.evaluate("(node,old)=>node===old",handle),"Native modal replaced")
 check(dialog.inner_text().replace("\u00a0"," ")==text,"Descriptor changed before decision")
 button=dialog.get_by_role("button",name=choice,exact=True)
 check(button.count()==1 and button.is_visible() and button.is_enabled(),"Exact enabled native choice required")
 if choice=="Deny":
  check(button.evaluate("(node)=>node===document.activeElement"),"Deny must actually own default focus");page.keyboard.press("Enter")
 else:button.click()
 page.wait_for_function("(old)=>!old.node.isConnected||old.node.offsetParent===null||old.node.innerText.replaceAll('\\u00a0',' ')!==old.text",arg={"node":handle,"text":text})
try:
 check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Owned installed driver required")
 c=waitjson("native-todo-recovery-"+f["runId"]+"-ui-contract.json")
 check(c["schema"]=="pkm.installed-native-todo-recovery-ui/v1" and c["runId"]==f["runId"] and c["decision"]==f["decision"],"Wrong recovery contract")
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
  pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
  check(len(pages)==1,"One actual workbench required");page=pages[0];page.set_default_timeout(f["timeoutMs"]);page.wait_for_load_state("networkidle")
  publish("native-todo-recovery-"+f["runId"]+"-ui-ready.json",{"ready":True,"runId":f["runId"],"actualRenderedDom":True})
  if f["decision"]=="create":
   dialog,handle,text,data=modal(page,"Allow PKM v5 todo_board_create for this exact request?")
   check(data["root"]==c["binding"]["root"] and data["workspaceId"]==c["binding"]["workspaceId"],"Wrong PUBLIC Root/workspace")
   check(data["operation"]=="mcp.tool.todo_board_create" and data["tool"]=="todo_board_create" and data["version"]==1 and data["readOnly"] is False,"Wrong PUBLIC operation")
   check(data["arguments"]==c["creationArguments"] and data["argumentsDigest"]==digest(c["creationArguments"]),"Wrong PUBLIC digest/arguments")
   choose(page,dialog,handle,text,"Approve this request")
   proof["dialogs"].append({"kind":"public","argumentsDigest":data["argumentsDigest"],"choice":"Approve this request"})
  host=waitjson("native-todo-recovery-"+f["runId"]+"-host.json")
  check(host["runId"]==f["runId"],"Wrong fresh Host witness")
  phase="create" if f["decision"]=="create" else "recover"
  title="Create this exact public Todo Board and paired Note?" if phase=="create" else "Recover this exact public Todo Board creation?"
  dialog,handle,text,data=modal(page,title)
  request={key:value for key,value in data.items() if key not in ["requestSha256","defaultDecision","permission"]}
  check(data["defaultDecision"]=="deny" and data["requestSha256"]==digest(request),"Wrong default or exact method26 request digest")
  check(request["schema"]=="pkm.original-mcp-todo-genesis-request/v1" and request["phase"]==phase,"Wrong recovery phase")
  for key,value in c["binding"].items():check(request[key]==value,"Wrong current Root/profile/source binding: "+key)
  check(request["nativeEpoch"]==host["epoch"] and request["nativeHostReceiptSha256"]==host["receiptSha256"],"Not the actual fresh current signed Host/epoch")
  check(request["actorId"]=="mcp:external" and request["operation"]=="mcp.tool.todo_board_create","Wrong actor/operation")
  check(request["arguments"]==c["creationArguments"] and request["argumentsSha256"]==digest(c["creationArguments"]),"Wrong original create arguments")
  s=request["selection"]
  for key,value in c["paths"].items():check(s[key]==value,"Wrong exact Note/backing/canonical path")
  check(s["boardSlug"]==c["boardSlug"] and s["documentId"]=="board-"+request["operationId"],"Wrong Board/document binding")
  check(re.fullmatch(r"[a-f0-9-]{36}",request["operationId"]) and re.fullmatch(r"[a-f0-9-]{36}",s["sourceId"]),"Wrong genuine UUIDs")
  if phase=="recover":
   check(request["operationId"]==c["operationId"] and s==c["selection"],"Recovery changed original operation/source or current partial snapshot")
   check(s["expectedBefore"]["note"]["state"]=="present" and s["expectedBefore"]["backing"]["state"]=="present" and s["expectedBefore"]["canonicalBoard"]["state"]=="absent","Not the actual Note/backing-only durable prefix")
  else:
   check(all(s["expectedBefore"][key]["state"]=="absent" for key in ["note","pair","backing","canonicalBoard","canonicalDirectory"]),"Creation targets were occupied")
  check(s["expectedBefore"]["sourceIndex"]=="absent","Pending creation is not a committed source")
  check(request["noExecution"] is True and request["noWorkerEnrollment"] is True and request["noReviewerDelegation"] is True,"Review granted unsupported execution")
  deny=dialog.get_by_role("button",name="Deny",exact=True)
  check(deny.count()==1 and deny.evaluate("(node)=>node===document.activeElement"),"Deny must be actually default focused")
  yes="Create this exact Board once" if phase=="create" else "Recover this exact Board once"
  check(dialog.get_by_role("button",name=yes,exact=True).count()==1 and dialog.get_by_role("button",name="Approve this request",exact=True).count()==0,"Recovery needs its phase-specific affirmative")
  choice="Deny" if f["decision"]=="deny" else yes
  proof.update(request=request,requestSha256=data["requestSha256"],defaultDenyFocused=True,defaultEnterDenial=choice=="Deny",actualRenderedDom=True)
  choose(page,dialog,handle,text,choice)
  proof["dialogs"].append({"kind":"genesis","phase":phase,"choice":choice,"operationId":request["operationId"],"requestSha256":data["requestSha256"]})
  proof.update(passed=True)
  publish("native-todo-recovery-"+f["runId"]+"-ui-passed.json",proof)
except Exception as error:
 try:publish("native-todo-recovery-"+f["runId"]+"-ui-passed.json",{"failed":True,"runId":f["runId"],"error":str(error),"observed":proof})
 except Exception:pass
 raise
`;

export async function startInstalledNativeTodoRecoveryUi({ root, python, env, port, runId, decision, timeoutMs = 120000 }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !isAbsolute(python ?? "")
    || !/^[a-f0-9-]{36}$/.test(runId ?? "") || !["create", "deny", "approve"].includes(decision)
    || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw Object.assign(new Error("INSTALLED_TODO_RECOVERY_PRIVATE_UI_REQUIRED"), { code: "INSTALLED_TODO_RECOVERY_PRIVATE_UI_REQUIRED" });
  const child = spawn(python, ["-B", "-c", installedNativeTodoRecoveryUiProgram, JSON.stringify({ root, port, runId, decision, timeoutMs })],
    { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Todo recovery observer exited ${code}/${signal}`)));
  });
  void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (error) throw error;
      try {
        const value = JSON.parse(await readFile(join(root, `native-todo-recovery-${runId}-ui-ready.json`)));
        if (!value.ready || !value.actualRenderedDom || value.runId !== runId) throw new Error("Wrong recovery observer readiness");
        return value;
      } catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Todo recovery observer readiness timed out");
  })();
  void ready.catch(() => {});
  return { ready, done, get error() { return error; }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  } };
}
