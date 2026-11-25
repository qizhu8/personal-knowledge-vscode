import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export const installedNativePrivateResourcePublicationUiProgram = String.raw`
import hashlib,json,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000;until=time.monotonic()+min(seconds*6,720)
proof={"schema":"pkm.installed-native-private-resource-publication-ui-evidence/v1","runId":f["runId"],"dialogs":[]}
def check(ok,message):
 if not ok:raise AssertionError(message)
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def publish(name,value):
 with (root/name).open("x") as output:json.dump(value,output)
def stage(name):
 stop=min(until,time.monotonic()+seconds)
 while time.monotonic()<stop:
  try:
   current=json.loads((root/"progress.json").read_text()).get("stage");check(current!="failed","Parent workflow failed")
   if current==name:return
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Private-publication UI stage timed out")
def modal(page,title):
 dialog=page.locator(".monaco-dialog-box:visible")
 dialog.get_by_text(title,exact=True).wait_for(state="visible")
 check(dialog.count()==1,"Exactly one native modal is required")
 handle=dialog.element_handle();text=dialog.inner_text().replace("\u00a0"," ");start=text.find("{")
 check(start>=0,"Native dialog omitted bound descriptor")
 data,_=json.JSONDecoder().raw_decode(text[start:])
 return dialog,handle,text,data
def choose(page,dialog,handle,text,choice,use_default=False):
 button=dialog.get_by_role("button",name=choice,exact=True)
 check(button.count()==1 and button.is_visible() and button.is_enabled(),"Missing unique enabled native choice")
 check(dialog.evaluate("(node,original)=>node===original",handle) and handle.evaluate("(node)=>node.isConnected"),"Native modal replaced")
 check(dialog.inner_text().replace("\u00a0"," ")==text,"Native descriptor changed before choice")
 if use_default:
  check(choice=="Deny" and button.evaluate("(node)=>node===document.activeElement"),"Default action must remain Deny")
  page.keyboard.press("Enter")
 else:button.click()
 page.wait_for_function("(old)=>!old.node.isConnected||old.node.offsetParent===null||old.node.innerText.replaceAll('\\u00a0',' ')!==old.text",arg={"node":handle,"text":text})
try:
 check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Not a private installed fixture driver")
 c=json.loads((root/"native-private-resource-publication-ui-contract.json").read_text())
 check(c["schema"]=="pkm.installed-native-private-resource-publication-ui/v1" and c["runId"]==f["runId"],"Wrong UI contract/run")
 check(len(c["steps"])==10 and sum(len(s["resources"]) for s in c["steps"])==11,"Only the exact 21-choice profile qualifies")
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
  pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
  check(len(pages)==1,"Exactly one installed workbench is required")
  page=pages[0];page.set_default_timeout(f["timeoutMs"]);page.wait_for_load_state("networkidle")
  publish("native-private-resource-publication-ui-ready.json",{"ready":True,"actualRenderedDom":True,"runId":f["runId"]})
  seenoperations=set()
  for step in c["steps"]:
   stage(step["stage"]);title="Allow PKM v5 "+step["tool"]+" for this exact request?"
   dialog,handle,text,data=modal(page,title)
   check(data["root"]==c["binding"]["root"] and data["workspaceId"]==c["binding"]["workspaceId"],"Wrong public Root/workspace")
   check(data["tool"]==step["tool"] and data["operation"]=="mcp.tool."+step["tool"] and data["version"]==1 and data["readOnly"] is False,"Wrong public operation")
   check(data["arguments"]==step["arguments"] and data["argumentsDigest"]==digest(step["arguments"]),"Wrong public arguments")
   check(dialog.get_by_role("button",name="Deny",exact=True).count()==1,"Public Deny absent")
   proof["dialogs"].append({"stage":step["stage"],"type":"public","choice":step["choice"],"argumentsDigest":data["argumentsDigest"]})
   choose(page,dialog,handle,text,step["choice"])
   operation=None;canonical=None
   for expected in step["resources"]:
    title="Publish this exact private resource into public document assets?"
    dialog,handle,text,data=modal(page,title)
    check(data["defaultDecision"]=="deny","Private approval must default Deny")
    buttons=dialog.get_by_role("button").all_text_contents()
    focused=dialog.evaluate("(node)=>node.contains(document.activeElement)?document.activeElement.textContent:null")
    proof["privateModalControls"]={"buttons":buttons,"focused":focused}
    deny=dialog.get_by_role("button",name="Deny",exact=True)
    affirmative=dialog.get_by_role("button",name="Publish this exact resource once",exact=True)
    check(deny.count()==1 and affirmative.count()==1 and deny.evaluate("(node)=>node===document.activeElement"),"Private Deny must be focused by default: "+repr(proof["privateModalControls"]))
    check("Approve this request" not in buttons,"Generic approval must not publish private bytes")
    request={key:data[key] for key in ["schema","phase","subject","nativeHostReceiptSha256","nativeEpoch"]}
    check(request["schema"]=="pkm.private-resource-publication/v1" and request["phase"]=="publish","Wrong private request phase")
    check(data["requestSha256"]==digest(request),"Wrong private request digest")
    subject=request["subject"];binding=c["binding"]
    for key in ["root","workspaceId","catalogSha256","profileSha256","custodyPlanSha256","privacySha256"]:
     check(subject[key]==binding[key],"Wrong private Root/custody/catalog/profile/privacy binding")
    check(request["nativeEpoch"]==binding["epoch"] and request["nativeHostReceiptSha256"]==binding["nativeHostReceiptSha256"],"Wrong native epoch/receipt")
    check(subject["owner"]==step["owner"] and subject["resource"]==expected["resource"],"Wrong private owner/source/target CAS")
    check(subject["operation"]==step["operation"] and subject["actorId"]=="mcp:external","Wrong private operation/actor")
    check(subject["publicRequest"]=={"tool":step["tool"],"version":1,"argumentsDigest":digest(step["arguments"])},"Wrong original public request binding")
    check(subject["preservePrivateSource"] is True and subject["oneResourceOneOperation"] is True,"Private source retention/scope invariant missing")
    check(re.fullmatch(r"[a-f0-9-]{36}",subject["operationId"]) and re.fullmatch(r"[a-f0-9]{64}",subject["canonicalArgumentsDigest"]),"Missing operation/canonical digest")
    if operation is None:
     operation=subject["operationId"];canonical=subject["canonicalArgumentsDigest"]
     check(operation not in seenoperations,"A prior operation cannot inherit publication authority");seenoperations.add(operation)
    check(operation==subject["operationId"] and canonical==subject["canonicalArgumentsDigest"],"Resources belong to different operations")
    check("SYNTHETIC_PRIVATE_RESOURCE_" not in text and "SYNTHETIC_PRIVATE_REFERRER" not in text,"Private plaintext leaked into native descriptor")
    proof["dialogs"].append({"stage":step["stage"],"type":"resource","choice":expected["choice"],"request":request,
      "requestSha256":data["requestSha256"],"defaultDenyFocused":True,"renderedButtons":buttons,
      "defaultEnterDenial":expected["choice"]=="Deny"})
    choose(page,dialog,handle,text,expected["choice"],use_default=expected["choice"]=="Deny")
  stage("native-private-resource-publication-complete")
  check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected extra native modal")
  check(len(proof["dialogs"])==21,"Missing bounded native choices")
  proof.update(passed=True,actualRenderedDom=True)
  publish("native-private-resource-publication-ui-passed.json",proof)
except Exception as error:
 try:publish("native-private-resource-publication-ui-passed.json",{"failed":True,"runId":f["runId"],"error":str(error),"observed":proof})
 except Exception:pass
 raise
`;

export async function startInstalledNativePrivateResourcePublicationUi({ root, python, env, port, runId, timeoutMs = 120000 }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root))
    || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077
    || !isAbsolute(python ?? "") || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !/^[a-f0-9-]{36}$/.test(runId))
    throw Object.assign(new Error("INSTALLED_PRIVATE_PUBLICATION_PRIVATE_UI_REQUIRED"), { code: "INSTALLED_PRIVATE_PUBLICATION_PRIVATE_UI_REQUIRED" });
  const child = spawn(python, ["-B", "-c", installedNativePrivateResourcePublicationUiProgram, JSON.stringify({ root, port, runId, timeoutMs })],
    { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Private-publication UI exited ${code}/${signal}`)));
  });
  void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (error) throw error;
      try {
        const value = JSON.parse(await readFile(join(root, "native-private-resource-publication-ui-ready.json")));
        if (!value.ready || value.actualRenderedDom !== true || value.runId !== runId) throw new Error("Wrong private-publication UI readiness");
        return value;
      } catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Private-publication observer readiness timed out");
  })();
  void ready.catch(() => {});
  return { ready, done, get error() { return error; }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  } };
}
