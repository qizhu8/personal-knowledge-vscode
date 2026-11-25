import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export const installedNativeTrashLifecycleRecoveryUiProgram = String.raw`
import hashlib,json,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);prefix="native-trash-lifecycle-recovery-"+f["runId"]
def check(ok,message):
 if not ok:raise AssertionError(message)
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def publish(suffix,value):
 with (root/(prefix+suffix)).open("x") as output:json.dump(value,output)
def modal(page,title):
 dialog=page.locator(".monaco-dialog-box:visible");dialog.get_by_text(title,exact=True).wait_for(state="visible")
 check(dialog.count()==1,"Exactly one genuine recovery modal required")
 handle=dialog.element_handle();text=dialog.inner_text().replace("\u00a0"," ");start=text.find("{")
 check(start>=0,"Exact recovery descriptor required");data,_=json.JSONDecoder().raw_decode(text[start:])
 return dialog,handle,text,data
def choose(page,dialog,handle,text,choice):
 check(dialog.evaluate("(node,old)=>node===old",handle) and handle.evaluate("(node)=>node.isConnected"),"Recovery modal replaced")
 check(dialog.inner_text().replace("\u00a0"," ")==text,"Recovery descriptor changed")
 button=dialog.get_by_role("button",name=choice,exact=True)
 check(button.count()==1 and button.is_visible() and button.is_enabled(),"Exact recovery choice required")
 if choice=="Deny":
  check(button.evaluate("(node)=>node===document.activeElement"),"Recovery Deny must remain default focused");page.keyboard.press("Enter")
 else:button.click()
 page.wait_for_function("(old)=>!old.node.isConnected||old.node.offsetParent===null||old.node.innerText.replaceAll('\\u00a0',' ')!==old.text",arg={"node":handle,"text":text})
try:
 c=json.loads((root/(prefix+"-ui-contract.json")).read_text())
 check(c["schema"]=="pkm.installed-native-trash-recovery-ui/v1" and c["runId"]==f["runId"],"Wrong exact recovery contract/run")
 check(c["phase"] in ["execute","recover"],"Wrong recovery phase")
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
  pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
  check(len(pages)==1,"Exactly one installed workbench required")
  page=pages[0];page.set_default_timeout(f["timeoutMs"]);page.wait_for_load_state("networkidle")
  publish("-ui-ready.json",{"ready":True,"runId":f["runId"],"actualRenderedDom":True})
  if c["phase"]=="execute":
   dialog,handle,text,data=modal(page,"Allow PKM v5 delete_note for this exact request?")
   check(data["root"]==c["binding"]["root"] and data["workspaceId"]==c["binding"]["workspaceId"],"Wrong public fault root")
   check(data["tool"]=="delete_note" and data["operation"]=="mcp.tool.delete_note" and data["readOnly"] is False
    and data["arguments"]=={"slug":"TrashLifecycle/Owner"} and data["argumentsDigest"]==digest(data["arguments"]),"Wrong public fault request")
   choose(page,dialog,handle,text,"Approve this request")
  dialog,handle,text,data=modal(page,"Move this exact public Note and paired assets to Trash?")
  deny=dialog.get_by_role("button",name="Deny",exact=True)
  check(data["defaultDecision"]=="deny" and deny.count()==1 and deny.evaluate("(node)=>node===document.activeElement"),"Fresh recovery default Deny required")
  check(dialog.get_by_role("button",name="Move this exact Note to Trash once",exact=True).count()==1
   and "Approve this request" not in dialog.get_by_role("button").all_text_contents(),"Only exact recovery action may approve")
  request={key:data[key] for key in ["schema","phase","subject","nativeHostReceiptSha256","nativeEpoch"]}
  check(request["schema"]=="pkm.original-native-trash-request/v1" and request["phase"]==c["phase"] and data["requestSha256"]==digest(request),"Wrong entire recovery request")
  s=request["subject"];b=c["binding"]
  for key in ["root","workspaceId","catalogSha256","profileSha256","custodyPlanSha256","privacySha256"]:check(s[key]==b[key],"Wrong recovery root/custody/profile")
  check(s["action"]=="move" and s["operation"]=="knowledge.trash.move" and s["actorId"]=="mcp:external","Wrong recovery original operation")
  check(s["selection"][0]["path"]==c["original"]["path"] and s["selection"][0]["document"]["id"]==c["original"]["id"]
   and s["selection"][0]["document"]["revision"]==c["original"]["revision"] and s["selection"][0]["document"]["sha256"]==c["original"]["sha256"],"Wrong exact original owner pin")
  check(re.fullmatch(r"[a-f0-9-]{36}",request["nativeEpoch"]) and re.fullmatch(r"[a-f0-9]{64}",request["nativeHostReceiptSha256"]),"Missing current native epoch/receipt")
  if c["phase"]=="execute":
   check(request["nativeEpoch"]==b["epoch"] and request["nativeHostReceiptSha256"]==b["nativeHostReceiptSha256"],"Wrong initial actual epoch")
  else:check(s==c["subject"],"Recovery must preserve the exact pending subject, not borrow old authority")
  check("DISPOSABLE_PRIVATE_LIFECYCLE_REFERRER" not in text and "/Private/" not in text,"Private source published in recovery descriptor")
  choose(page,dialog,handle,text,c["choice"])
  publish("-ui-passed.json",{"passed":True,"actualRenderedDom":True,"runId":f["runId"],"request":request,
   "requestSha256":data["requestSha256"],"choice":c["choice"],"defaultDenyFocused":True,
   "defaultEnterDenial":c["choice"]=="Deny"})
except Exception as error:
 try:publish("-ui-passed.json",{"failed":True,"runId":f["runId"],"error":str(error)})
 except Exception:pass
 raise
`;

export async function startInstalledNativeTrashLifecycleRecoveryUi({ root, python, env, port, runId, timeoutMs = 120000 }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root))
    || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077
    || !isAbsolute(python ?? "") || !/^[a-f0-9-]{36}$/.test(runId) || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw Object.assign(new Error("INSTALLED_TRASH_RECOVERY_PRIVATE_UI_REQUIRED"), { code: "INSTALLED_TRASH_RECOVERY_PRIVATE_UI_REQUIRED" });
  const prefix = `native-trash-lifecycle-recovery-${runId}`;
  const child = spawn(python, ["-B", "-c", installedNativeTrashLifecycleRecoveryUiProgram, JSON.stringify({ root, port, runId, timeoutMs })],
    { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) =>
    code === 0 ? resolve() : reject(new Error(`Trash recovery observer exited ${code}/${signal}`))); });
  void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (error) throw error;
      try { const value = JSON.parse(await readFile(join(root, `${prefix}-ui-ready.json`)));
        if (value.ready !== true || value.runId !== runId || value.actualRenderedDom !== true) throw new Error("Wrong recovery observer readiness"); return value; }
      catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Trash recovery observer readiness timed out");
  })();
  void ready.catch(() => {});
  return { ready, done, get error() { return error; }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000); try { await ended; } finally { clearTimeout(timer); }
  } };
}
