import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export const installedNativeTrashUiProgram = String.raw`
import hashlib,json,re,sys,time
from datetime import datetime
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000;until=time.monotonic()+min(seconds*8,900)
proof={"schema":"pkm.installed-native-trash-ui-evidence/v1","runId":f["runId"],"dialogs":[]}
def check(ok,message):
 if not ok:raise AssertionError(message)
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def rawdigest(value):return hashlib.sha256((json.dumps(value,ensure_ascii=False,indent=2)+"\n").encode()).hexdigest()
def publish(name,value):
 with (root/name).open("x") as output:json.dump(value,output)
def stage(name):
 stop=min(until,time.monotonic()+seconds)
 while time.monotonic()<stop:
  try:
   current=json.loads((root/"progress.json").read_text()).get("stage");check(current!="failed","Parent workflow failed")
   if current==name:
    value=json.loads((root/"native-trash-ui-next.json").read_text())
    if value["stage"]==name:return value
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Trash UI stage timed out: "+name)
def modal(page,title):
 dialog=page.locator(".monaco-dialog-box:visible")
 dialog.get_by_text(title,exact=True).wait_for(state="visible")
 check(dialog.count()==1,"Exactly one native modal is required")
 handle=dialog.element_handle();text=dialog.inner_text().replace("\u00a0"," ");start=text.find("{")
 check(start>=0,"Native Trash dialog omitted its exact descriptor")
 data,_=json.JSONDecoder().raw_decode(text[start:])
 return dialog,handle,text,data
def choose(page,dialog,handle,text,choice,default=False):
 check(dialog.evaluate("(node,original)=>node===original",handle) and handle.evaluate("(node)=>node.isConnected"),"Native modal replaced")
 check(dialog.inner_text().replace("\u00a0"," ")==text,"Native descriptor changed before choice")
 if choice=="Escape":page.keyboard.press("Escape")
 else:
  button=dialog.get_by_role("button",name=choice,exact=True)
  check(button.count()==1 and button.is_visible() and button.is_enabled(),"Unique enabled choice required")
  if choice=="Deny":
   if not default:button.focus()
   check(button.evaluate("(node)=>node===document.activeElement"),"Deny must have focus before Enter")
   page.keyboard.press("Enter")
  else:button.click()
 page.wait_for_function("(old)=>!old.node.isConnected||old.node.offsetParent===null||old.node.innerText.replaceAll('\\u00a0',' ')!==old.text",arg={"node":handle,"text":text})
try:
 check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Not a private installed fixture driver")
 c=json.loads((root/"native-trash-ui-contract.json").read_text())
 check(c["schema"]=="pkm.installed-native-trash-ui/v1" and c["runId"]==f["runId"],"Wrong Trash UI contract/run")
 check(len(c["stages"])==11,"Only the exact bounded Trash profile qualifies")
 seen=set()
 labels={"move":("Move this exact Note to Trash once","Move this exact public Note and paired assets to Trash?"),
  "list":("Read these exact Trash entries once","Read these exact public Note Trash entries?"),
  "restore":("Restore this exact Note once","Restore this exact public Note and paired assets?")}
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
  pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
  check(len(pages)==1,"Exactly one installed workbench is required")
  page=pages[0];page.set_default_timeout(f["timeoutMs"]);page.wait_for_load_state("networkidle")
  publish("native-trash-ui-ready.json",{"ready":True,"actualRenderedDom":True,"runId":f["runId"]})
  for step in c["stages"]:
   if step.get("noReview"):continue
   expected=stage(step["stage"])
   if step.get("publicChoice"):
    dialog,handle,text,data=modal(page,"Allow PKM v5 delete_note for this exact request?")
    check(data["root"]==c["binding"]["root"] and data["workspaceId"]==c["binding"]["workspaceId"],"Wrong public Root/workspace")
    check(data["tool"]=="delete_note" and data["operation"]=="mcp.tool.delete_note" and data["version"]==1 and data["readOnly"] is False,"Wrong public operation")
    check(data["arguments"]==c["publicRequest"]["arguments"] and data["argumentsDigest"]==digest(data["arguments"]),"Wrong public arguments")
    proof["dialogs"].append({"stage":step["stage"],"type":"public","choice":step["publicChoice"],"argumentsDigest":data["argumentsDigest"],
      "focusedEnterDenial":step["publicChoice"]=="Deny","defaultEnterDenial":False})
    choose(page,dialog,handle,text,step["publicChoice"])
   if not step.get("action"):continue
   action=step["action"];affirmative,title=labels[action]
   dialog,handle,text,data=modal(page,title)
   buttons=dialog.get_by_role("button").all_text_contents()
   deny=dialog.get_by_role("button",name="Deny",exact=True)
   yes=dialog.get_by_role("button",name=affirmative,exact=True)
   check(data["defaultDecision"]=="deny" and deny.count()==1 and yes.count()==1,"Action-specific default denial required")
   check(deny.evaluate("(node)=>node===document.activeElement"),"Trash Deny must be focused by default")
   check("Approve this request" not in buttons,"Generic approval must not grant Trash")
   request={key:data[key] for key in ["schema","phase","subject","nativeHostReceiptSha256","nativeEpoch"]}
   check(request["schema"]=="pkm.original-native-trash-request/v1" and request["phase"]=="execute","Wrong Trash protocol/phase")
   check(data["requestSha256"]==digest(request),"Wrong whole Trash request digest")
   s=request["subject"];b=c["binding"]
   for key in ["root","workspaceId","catalogSha256","profileSha256","custodyPlanSha256","privacySha256"]:
    check(s[key]==b[key],"Wrong Trash root/profile/source/custody binding: "+key)
   check(request["nativeEpoch"]==b["epoch"] and request["nativeHostReceiptSha256"]==b["nativeHostReceiptSha256"],"Wrong current native epoch/receipt")
   check(s["action"]==action and s["operation"]=="knowledge.trash."+action and s["actorId"]=="mcp:external","Wrong Trash operation/actor")
   check(s["sourceOriginalSha256"]=="1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27","Wrong pinned original producer")
   check(re.fullmatch(r"[a-f0-9-]{36}",s["operationId"]) and s["operationId"] not in seen,"Missing/fresh one-use operation ID required");seen.add(s["operationId"])
   for key in ["canonicalArgumentsDigest","custodyPredecessorSha256","transitionSha256"]:
    check(re.fullmatch(r"[a-f0-9]{64}",s[key]),"Missing exact Trash digest: "+key)
   check("DISPOSABLE_PRIVATE_TRASH_SENTINEL" not in text and "/Private/" not in text,"Private resource published in Trash descriptor")
   for item in s["selection"]:
    check(item["area"]=="notes" and item["treeSha256"]==digest(item["inventory"]),"Wrong selected area/tree digest")
   if action=="move":
    check(len(s["selection"])==1,"Only one public Note/pair may move")
    item=s["selection"][0];owner=c["owner"]
    check(item["path"]==owner["path"] and item["document"]=={k:owner[k] for k in ["id","knowledgeId","revision","sha256"]},"Wrong original Note identity/revision/raw CAS")
    check(item["inventory"]==c["inventory"] and item["readOnlyOriginalBucket"] is False,"Wrong exclusively owned pair inventory")
    m=item["metadata"]
    check(re.fullmatch(r"[0-9]+-[a-f0-9]{10}",item["entryId"]) and item["entryId"]==m["id"],"Wrong original bucket identity")
    check(int(item["entryId"].split("-")[0])==round(datetime.fromisoformat(m["deletedAt"].replace("Z","+00:00")).timestamp()*1000),"Bucket timestamp does not bind the original deletion time")
    check(m["kind"]=="item" and m["name"]=="Owner.md" and m["originalPath"]==owner["path"] and m["assetsPath"]=="TrashFixture/Owner.assets","Wrong original bucket metadata")
    check(item["metadataSha256"]==rawdigest(m),"Wrong exact original metadata bytes")
    check(s["custodyPredecessorSha256"]==expected["predecessorSha256"] and s["historyBeforeSha256"]==expected["historyBeforeSha256"],"Wrong predecessor/history before image")
    history={"schema":1,"records":c["originalHistory"]["records"]+[{"path":path,"deletedAt":m["deletedAt"]} for path in c["removedPaths"]]}
    check(s["historyAfterSha256"]==rawdigest(history),"Wrong ordered document+pair deletion image")
    check(s["publicRequest"]=={"tool":"delete_note","version":1,"argumentsDigest":digest(c["publicRequest"]["arguments"])},"Wrong approved original delete binding")
   else:
    check(s==expected["subject"],"Wrong exact selected bucket/history/source/target scope")
    check(s["canonicalArgumentsDigest"]==digest(expected["arguments"]) and s["operationId"]==expected["arguments"]["operationId"],"Wrong canonical invocation")
   proof["dialogs"].append({"stage":step["stage"],"type":"trash","choice":step["choice"],"request":request,
    "requestSha256":data["requestSha256"],"defaultDenyFocused":True,"renderedButtons":buttons,
    "defaultEnterDenial":step["choice"]=="Deny","modalDismissal":step["choice"]=="Escape"})
   choose(page,dialog,handle,text,step["choice"],default=True)
  stop=min(until,time.monotonic()+seconds)
  while time.monotonic()<stop:
   try:
    current=json.loads((root/"progress.json").read_text()).get("stage");check(current!="failed","Parent workflow failed")
    if current=="native-trash-complete":break
   except (FileNotFoundError,json.JSONDecodeError):pass
   time.sleep(.025)
  else:raise RuntimeError("Trash completion timed out")
  check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected extra/replay native modal")
  check(len(proof["dialogs"])==11,"Missing bounded public/Trash choices")
  proof.update(passed=True,actualRenderedDom=True)
  publish("native-trash-ui-passed.json",proof)
except Exception as error:
 try:publish("native-trash-ui-passed.json",{"failed":True,"runId":f["runId"],"error":str(error),"observed":proof})
 except Exception:pass
 raise
`;

export async function startInstalledNativeTrashUi({ root, python, env, port, runId, timeoutMs = 120000 }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !isAbsolute(python ?? "")
    || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9-]{36}$/.test(runId)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw Object.assign(new Error("INSTALLED_TRASH_PRIVATE_UI_REQUIRED"), { code: "INSTALLED_TRASH_PRIVATE_UI_REQUIRED" });
  const child = spawn(python, ["-B", "-c", installedNativeTrashUiProgram, JSON.stringify({ root, port, runId, timeoutMs })],
    { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Trash observer exited ${code}/${signal}`)));
  });
  void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (error) throw error;
      try {
        const value = JSON.parse(await readFile(join(root, "native-trash-ui-ready.json")));
        if (value.ready !== true || value.actualRenderedDom !== true || value.runId !== runId) throw new Error("Wrong Trash observer readiness");
        return value;
      } catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Trash observer readiness timed out");
  })();
  void ready.catch(() => {});
  return { ready, done, get error() { return error; }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  } };
}
