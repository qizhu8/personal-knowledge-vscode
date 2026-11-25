import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export const installedNativePrivateResourceLifecycleUiProgram = String.raw`
import hashlib,json,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);until=time.monotonic()+f["timeoutMs"]/1000
proof={"schema":"pkm.installed-private-resource-lifecycle-ui-evidence/v1","runId":f["runId"],"dialogs":[]}
def check(ok,message):
 if not ok:raise AssertionError(message)
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def save(name,value):
 with (root/name).open("x") as out:json.dump(value,out)
def wait_file(name):
 while time.monotonic()<until:
  try:return json.loads((root/name).read_text())
  except (FileNotFoundError,json.JSONDecodeError):time.sleep(.025)
 raise RuntimeError("Lifecycle driver handshake timed out")
def stage(name):
 while time.monotonic()<until:
  try:
   value=json.loads((root/"progress.json").read_text()).get("stage");check(value!="failed","Parent workflow failed")
   if value==name:return
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Lifecycle stage timed out")
def modal(page,title):
 dialog=page.locator(".monaco-dialog-box:visible");dialog.get_by_text(title,exact=True).wait_for(state="visible")
 check(dialog.count()==1,"Exactly one native dialog required")
 handle=dialog.element_handle();text=dialog.inner_text().replace("\u00a0"," ")
 check(text.find("{")>=0,"Missing exact native descriptor")
 data,_=json.JSONDecoder().raw_decode(text[text.find("{"):]);return dialog,handle,text,data
def action(page,dialog,handle,text,name):
 button=dialog.get_by_role("button",name=name,exact=True)
 check(button.count()==1 and button.is_visible() and button.is_enabled(),"Missing unique enabled native action")
 check(dialog.evaluate("(n,old)=>n===old",handle) and handle.evaluate("(n)=>n.isConnected"),"Native dialog replaced")
 check(dialog.inner_text().replace("\u00a0"," ")==text,"Native descriptor changed")
 button.click()
 page.wait_for_function("(v)=>!v.node.isConnected||v.node.offsetParent===null||v.node.innerText.replaceAll('\\u00a0',' ')!==v.text",
  arg={"node":handle,"text":text})
try:
 c=json.loads((root/"native-private-resource-lifecycle-ui-contract.json").read_text())
 check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name) and c["runId"]==f["runId"],"Wrong private fixture/run")
 check(c["schema"]=="pkm.installed-private-resource-lifecycle-ui/v1" and [s["mode"] for s in c["steps"]]==["cancel","expiry","publish"],"Wrong bounded profile")
 check(len(c["resources"])==3,"Expiry requires three checked stored resources")
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=30000)
  pages=[q for x in browser.contexts for q in x.pages if "workbench" in q.url]
  check(len(pages)==1,"Exactly one installed renderer required")
  page=pages[0];page.set_default_timeout(120000);page.wait_for_load_state("networkidle")
  save("native-private-resource-lifecycle-ui-ready.json",{"ready":True,"actualRenderedDom":True,"runId":f["runId"]})
  seen=set()
  for step in c["steps"]:
   stage(step["stage"]);dialog,handle,text,data=modal(page,"Allow PKM v5 update_note for this exact request?")
   check(data["tool"]=="update_note" and data["operation"]=="mcp.tool.update_note" and data["version"]==1 and data["readOnly"] is False,"Wrong public operation")
   check(data["root"]==c["binding"]["root"] and data["workspaceId"]==c["binding"]["workspaceId"],"Wrong public root/workspace")
   check(data["arguments"]==c["arguments"] and data["argumentsDigest"]==digest(c["arguments"]),"Wrong public arguments")
   check(dialog.get_by_role("button",name="Deny",exact=True).count()==1,"Missing public Deny")
   proof["dialogs"].append({"mode":step["mode"],"type":"public","choice":"Approve this request"})
   action(page,dialog,handle,text,"Approve this request");operation=None;canonical=None;first=None
   for index in range(2 if step["mode"]=="cancel" else 3):
    dialog,handle,text,data=modal(page,"Publish this exact private resource into public document assets?")
    deny=dialog.get_by_role("button",name="Deny",exact=True)
    check(deny.count()==1 and deny.is_visible() and deny.is_enabled() and deny.evaluate("(n)=>n===document.activeElement"),"Private Deny must be genuinely focused")
    check(dialog.get_by_role("button",name="Approve this request",exact=True).count()==0,"Generic approval cannot publish")
    request={key:data[key] for key in ["schema","phase","subject","nativeHostReceiptSha256","nativeEpoch"]}
    check(data["defaultDecision"]=="deny" and data["requestSha256"]==digest(request),"Wrong private default/request digest")
    check(request["schema"]=="pkm.private-resource-publication/v1" and request["phase"]=="publish","Wrong private phase")
    subject=request["subject"];binding=c["binding"]
    for key in ["root","workspaceId","catalogSha256","profileSha256","custodyPlanSha256","privacySha256"]:
     check(subject[key]==binding[key],"Wrong native custody/profile/privacy binding")
    check(request["nativeEpoch"]==binding["epoch"] and request["nativeHostReceiptSha256"]==binding["nativeHostReceiptSha256"],"Wrong native epoch/receipt")
    check(subject["owner"]==c["owner"] and subject["resource"]==c["resources"][index],"Wrong exact source/owner/target")
    check(subject["operation"]=="knowledge.note.update" and subject["actorId"]=="mcp:external","Wrong private actor/operation")
    check(subject["publicRequest"]=={"tool":"update_note","version":1,"argumentsDigest":digest(c["arguments"])},"Wrong public-request binding")
    check(subject["preservePrivateSource"] is True and subject["oneResourceOneOperation"] is True,"Missing private scope invariants")
    check(re.fullmatch(r"[a-f0-9-]{36}",subject["operationId"]) and re.fullmatch(r"[a-f0-9]{64}",subject["canonicalArgumentsDigest"]),"Missing operation/canonical digest")
    if operation is None:
     operation=subject["operationId"];canonical=subject["canonicalArgumentsDigest"]
     check(operation not in seen,"Prior operation cannot confer authority");seen.add(operation)
    check(operation==subject["operationId"] and canonical==subject["canonicalArgumentsDigest"],"Mixed resource operations")
    check("PRIVATE_LIFECYCLE_BYTES_" not in text and "PRIVATE_LIFECYCLE_REFERRER" not in text,"Private plaintext leaked")
    row={"mode":step["mode"],"type":"resource","index":index,"request":request,"requestSha256":data["requestSha256"],"defaultDenyFocused":True}
    if step["mode"]=="cancel" and index==1:
     save("native-private-resource-lifecycle-cancel-ready.json",{"runId":f["runId"],"request":request,"requestSha256":data["requestSha256"],"actualRenderedDom":True})
     observed=wait_file("native-private-resource-lifecycle-cancel-observed.json")
     check(observed["runId"]==f["runId"] and observed["operationId"]==operation and observed["code"]=="NATIVE_REQUEST_CANCELLED","Missing genuine current-request cancellation result")
     row.update(choice="Publish this exact resource once",afterCancellation=True)
     action(page,dialog,handle,text,"Publish this exact resource once")
     save("native-private-resource-lifecycle-cancel-closed.json",{"runId":f["runId"],"operationId":operation,"lateModalAction":True})
    else:
     if step["mode"]=="expiry" and index>0:
      start=time.monotonic()
      while time.monotonic()-start<65:
       check(time.monotonic()<until,"Lifecycle overall deadline exceeded")
       page.wait_for_timeout(100)
      row["actualWaitMs"]=(time.monotonic()-start)*1000
      check(deny.evaluate("(n)=>n===document.activeElement"),"Default Deny changed during real wait")
     if index==0:first=time.monotonic()
     row.update(choice="Publish this exact resource once",elapsedSinceFirstMs=(time.monotonic()-first)*1000)
     action(page,dialog,handle,text,"Publish this exact resource once")
    proof["dialogs"].append(row)
   if step["mode"]=="expiry":check(proof["dialogs"][-1]["elapsedSinceFirstMs"]>=130000,"Genuine grant ageing was not observed")
  stage("native-private-resource-lifecycle-complete")
  check(page.locator(".monaco-dialog-box:visible").count()==0 and len(proof["dialogs"])==11,"Unexpected or missing native dialogs")
  proof.update(passed=True,actualRenderedDom=True,clockMocked=False,installedPendingRecoveryQualified=False)
  save("native-private-resource-lifecycle-ui-passed.json",proof)
except Exception as error:
 try:save("native-private-resource-lifecycle-ui-passed.json",{"failed":True,"runId":f["runId"],"error":str(error),"observed":proof})
 except Exception:pass
 raise
`;

export async function startInstalledNativePrivateResourceLifecycleUi({ root, python, env, port, runId, timeoutMs = 240000 }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root))
    || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077
    || !isAbsolute(python ?? "") || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 240000 || timeoutMs > 360000 || !/^[a-f0-9-]{36}$/.test(runId))
    throw Object.assign(new Error("INSTALLED_PRIVATE_LIFECYCLE_PRIVATE_UI_REQUIRED"), { code: "INSTALLED_PRIVATE_LIFECYCLE_PRIVATE_UI_REQUIRED" });
  const child = spawn(python, ["-B", "-c", installedNativePrivateResourceLifecycleUiProgram, JSON.stringify({ root, port, runId, timeoutMs })], { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) =>
    code === 0 ? resolve() : reject(new Error(`Private lifecycle UI exited ${code}/${signal}`))); });
  void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      if (error) throw error;
      try {
        const value = JSON.parse(await readFile(join(root, "native-private-resource-lifecycle-ui-ready.json")));
        if (value.ready !== true || value.actualRenderedDom !== true || value.runId !== runId) throw new Error("Wrong lifecycle observer readiness");
        return value;
      } catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Lifecycle observer startup timed out");
  })();
  void ready.catch(() => {});
  return { ready, done, get error() { return error; }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  } };
}
