import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";

export const installedNativePrivateResourceRecoveryUiProgram = String.raw`
import hashlib,json,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"])
def check(ok,msg):
 if not ok:raise AssertionError(msg)
def digest(v):return hashlib.sha256(json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
proof={"runId":f["runId"],"mode":f["mode"],"dialogs":[]}
def save(name,value):
 with (root/name).open("x") as out:json.dump(value,out)
def modal(page,title):
 d=page.locator(".monaco-dialog-box:visible");d.get_by_text(title,exact=True).wait_for(state="visible")
 check(d.count()==1,"Exactly one native modal required");h=d.element_handle();text=d.inner_text().replace("\u00a0"," ")
 check(text.find("{")>=0,"Missing native descriptor");data,_=json.JSONDecoder().raw_decode(text[text.find("{"):]);return d,h,text,data
def choose(page,d,h,text,name):
 b=d.get_by_role("button",name=name,exact=True)
 check(b.count()==1 and b.is_visible() and b.is_enabled(),"Missing unique native choice")
 check(d.evaluate("(n,o)=>n===o",h) and h.evaluate("(n)=>n.isConnected") and d.inner_text().replace("\u00a0"," ")==text,"Native dialog changed")
 if name=="Deny":
  check(b.evaluate("(n)=>n===document.activeElement"),"Deny must still be native default focus");page.keyboard.press("Enter")
 else:b.click()
 page.wait_for_function("(v)=>!v.n.isConnected||v.n.offsetParent===null||v.n.innerText.replaceAll('\\u00a0',' ')!==v.text",arg={"n":h,"text":text})
try:
 c=json.loads((root/("native-private-resource-recovery-"+f["mode"]+"-ui-contract.json")).read_text())
 check(c["runId"]==f["runId"] and c["schema"]=="pkm.installed-private-resource-recovery-ui/v1","Wrong recovery profile/run")
 check(f["mode"] in ["fault","deny","approve"],"Unsupported recovery UI mode")
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=30000)
  pages=[q for x in browser.contexts for q in x.pages if "workbench" in q.url];check(len(pages)==1,"One installed renderer required")
  page=pages[0];page.set_default_timeout(f["timeoutMs"]);page.wait_for_load_state("networkidle")
  save("native-private-resource-recovery-"+f["mode"]+"-ui-ready.json",{"ready":True,"runId":f["runId"],"actualRenderedDom":True})
  if f["mode"]=="fault":
   d,h,text,data=modal(page,"Allow PKM v5 update_note for this exact request?")
   check(data["root"]==c["root"] and data["workspaceId"]==c["workspaceId"],"Wrong public root/workspace")
   check(data["tool"]=="update_note" and data["operation"]=="mcp.tool.update_note" and data["readOnly"] is False and data["version"]==1,"Wrong public operation")
   check(data["arguments"]==c["arguments"] and data["argumentsDigest"]==digest(c["arguments"]),"Wrong public arguments")
   choose(page,d,h,text,"Approve this request");proof["publicApprovalObserved"]=True
  op=None;canonical=None
  for expected in c["resources"]:
   d,h,text,data=modal(page,"Publish this exact private resource into public document assets?")
   deny=d.get_by_role("button",name="Deny",exact=True)
   check(deny.count()==1 and deny.evaluate("(n)=>n===document.activeElement"),"Private default must focus Deny")
   check(d.get_by_role("button",name="Approve this request",exact=True).count()==0,"Generic approval is not publication")
   request={key:data[key] for key in ["schema","phase","subject","nativeHostReceiptSha256","nativeEpoch"]}
   subject=request["subject"]
   check("PRIVATE_RECOVERY_REFERRER" not in text and "a"*128 not in text and "b"*128 not in text,"Private plaintext leaked into native descriptor")
   check(data["defaultDecision"]=="deny" and data["requestSha256"]==digest(request),"Wrong native private descriptor digest")
   check(request["schema"]=="pkm.private-resource-publication/v1" and request["phase"]==("publish" if f["mode"]=="fault" else "recover"),"Wrong private phase")
   for key in ["root","workspaceId","custodyPlanSha256","catalogSha256","profileSha256","privacySha256"]:check(subject[key]==c[key],"Wrong custody/profile/privacy binding")
   check(subject["owner"]==c["owner"] and subject["resource"]==expected,"Wrong exact owner/source/target")
   check(subject["actorId"]=="mcp:external" and subject["operation"]=="knowledge.note.update","Wrong private actor/operation")
   check(subject["publicRequest"]=={"tool":"update_note","version":1,"argumentsDigest":digest(c["arguments"])},"Wrong immutable public request")
   check(subject["preservePrivateSource"] is True and subject["oneResourceOneOperation"] is True,"Missing retention/one-operation invariants")
   check(re.fullmatch(r"[a-f0-9-]{36}",subject["operationId"]) and re.fullmatch(r"[a-f0-9]{64}",subject["canonicalArgumentsDigest"]),"Missing operation/digest")
   if op is None:op=subject["operationId"];canonical=subject["canonicalArgumentsDigest"]
   check(op==subject["operationId"] and canonical==subject["canonicalArgumentsDigest"],"Mixed operations")
   if f["mode"]=="fault":check(request["nativeEpoch"]==c["oldEpoch"],"Wrong original epoch")
   else:
    check(subject["operationId"]==c["operationId"] and subject["canonicalArgumentsDigest"]==c["canonicalArgumentsDigest"],"Recovery changes immutable request")
    check(request["nativeEpoch"] not in c["priorEpochs"],"Recovery requires genuinely fresh epoch")
    check(request["nativeHostReceiptSha256"]!=c["oldHostReceiptSha256"],"Old admission receipt is not recovery authority")
   choice="Deny" if f["mode"]=="deny" else "Publish this exact resource once"
   proof["dialogs"].append({"request":request,"requestSha256":data["requestSha256"],"choice":choice,"defaultDenyFocused":True})
   choose(page,d,h,text,choice)
  proof.update(passed=True,actualRenderedDom=True)
  save("native-private-resource-recovery-"+f["mode"]+"-ui-passed.json",proof)
except Exception as error:
 try:save("native-private-resource-recovery-"+f["mode"]+"-ui-passed.json",{"failed":True,"runId":f["runId"],"error":str(error),"observed":proof})
 except Exception:pass
 raise
`;
export async function startInstalledNativePrivateResourceRecoveryUi({ root, mode, runId, python, env, port, timeoutMs = 120000 }) {
  await u.privateDirectory(root, "PRIVATE_RECOVERY_PRIVATE_DRIVER_REQUIRED");
  if (!/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !["fault","deny","approve"].includes(mode)
    || !/^[a-f0-9-]{36}$/.test(runId) || !isAbsolute(python ?? "") || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("PRIVATE_RECOVERY_UI_PROFILE_REQUIRED");
  const child = spawn(python, ["-B","-c",installedNativePrivateResourceRecoveryUiProgram,JSON.stringify({ root, mode, runId, port, timeoutMs })], { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) =>
    code === 0 ? resolve() : reject(new Error(`Private recovery UI exited ${code}/${signal}`))); }); void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now()+30000;
    while(Date.now()<until) {
      if(error)throw error;
      try {
        const value=JSON.parse(await readFile(join(root,`native-private-resource-recovery-${mode}-ui-ready.json`)));
        if(value.ready!==true||value.actualRenderedDom!==true||value.runId!==runId)throw new Error("Wrong recovery UI readiness");
        return value;
      } catch(value){if(value.code!=="ENOENT"&&!(value instanceof SyntaxError))throw value;}
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    throw new Error("Recovery UI startup timed out");
  })();void ready.catch(()=>{});
  return {ready,done,get error(){return error;},async stop(){
    if(child.exitCode!==null||child.signalCode!==null)return;
    const ended=new Promise(resolve=>child.once("exit",resolve));child.kill("SIGTERM");const timer=setTimeout(()=>child.kill("SIGKILL"),5000);
    try{await ended;}finally{clearTimeout(timer);}
  }};
}
