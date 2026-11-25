import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

function fail(code) { throw Object.assign(new Error(code), { code }); }
export const installedNativeRoomLiveUiProgram = String.raw`
import hashlib,json,os,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
os.umask(0o077)
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000;until=time.monotonic()+min(seconds*5,480)
def check(condition,message):
 if not condition:raise AssertionError(message)
def read(name):return json.loads((root/name).read_text())
def write(name,value):
 with (root/name).open("x") as output:json.dump(value,output)
def canonical(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def stage(name):
 end=min(until,time.monotonic()+seconds)
 while time.monotonic()<end:
  try:
   current=read("progress.json").get("stage");check(current!="failed","Parent installed workflow failed")
   if current==name:return
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.02)
 raise RuntimeError("Room live stage timeout: "+name)
def file(name):
 end=min(until,time.monotonic()+seconds)
 while time.monotonic()<end:
  try:return read(name)
  except (FileNotFoundError,json.JSONDecodeError):time.sleep(.02)
 raise RuntimeError("Room live evidence timeout")
def modal(page,title):
 box=page.locator(".monaco-dialog-box:visible");box.wait_for(state="visible")
 check(box.count()==1,"Exactly one actual native modal is required")
 item=box.get_by_text(title,exact=True);item.wait_for(state="visible")
 check(item.count()==1 and item.is_visible(),"Wrong exact native title")
 text=box.inner_text().replace("\u00a0"," ");start=text.find("{");check(start>=0,"Exact native JSON detail missing")
 body,_=json.JSONDecoder().raw_decode(text[start:])
 check("pkchat:v1:" not in text,"An invite reached native modal/evidence")
 return box,body,text
proof={"schema":"pkm.installed-native-room-live-ui/v1","dialogs":[],"effects":{}}
output="native-room-live-credential-ui-passed.json" if f["mode"]=="credentials" else "native-room-live-ui-passed.json"
try:
 check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Not a disposable installed driver")
 with sync_playwright() as p:
  browser=None
  while browser is None and time.monotonic()<until:
   try:browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=1500)
   except Exception:time.sleep(.05)
  check(browser is not None,"No actual renderer")
  pages=[]
  while len(pages)!=1 and time.monotonic()<until:
   pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
   if len(pages)!=1:time.sleep(.05)
  check(len(pages)==1,"Exactly one installed workbench renderer is required")
  page=pages[0];page.set_default_timeout(f["timeoutMs"]);page.wait_for_load_state("networkidle")
  if f["mode"]=="credentials":
   c=read("native-room-credential-intent.json");file("native-room-credential-modal.json")
   box,body,text=modal(page,c["title"])
   check(body["extensionMode"]=="Production" and body["extensionId"]=="pkm-nonproduction.pkm-v5","Not actual Production activation")
   for key in ["roomId","fixtureNonce","installedEntrySha256","originalPackageSha256","credentialProducerSha256","requestedJoinSecretSha256"]:
    check(body[key]==c[key],"Wrong credential origin binding")
   for key in ["newSyntheticCredentialsOnly","noOldKeyringMigration","noNetwork","noRehost"]:
    check(body[key] is True,"Missing credential boundary")
   check(body["joinSecretOrigin"]=="caller-generated-synthetic-requested-input","Not a caller-originated synthetic join secret")
   box.get_by_role("button",name=c["choice"],exact=True).click()
   hashes=file("native-room-created-credentials.json")
   check(set(hashes)=={"roomId","hostCredentialHash","joinSecretHash"},"Credential record is not hash-only")
   check(hashes["joinSecretHash"]==c["requestedJoinSecretSha256"],"Original requested join input was not honored")
   evidence={"passed":True,"actualNativeUi":True,"fixtureNonce":c["fixtureNonce"],"roomId":c["roomId"],"choice":c["choice"],
    "callerGeneratedRequestedJoinSecretVisibleByHashOnly":True,"textSha256":hashlib.sha256(text.encode()).hexdigest()}
   write("native-room-credential-ui-passed.json",evidence)
   write(output,evidence)
  else:
   c=read("native-room-live-ui-contract.json")
   check(c["schema"]=="pkm.installed-native-room-live-ui-contract/v1","Wrong live UI contract")
   write("native-room-live-ui-ready.json",{"ready":True,"actualRenderer":True})
   for step in c["steps"]:
    stage(step["stage"])
    if step.get("kind")=="quiet":
     end=time.monotonic()+.2
     while time.monotonic()<end:
      check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected modal/fallback/Host reproof during a live effect")
      time.sleep(.02)
     write(step["ack"],{"observed":True,"noNewModal":True})
     continue
    if step.get("kind")=="revoke":
     item=page.locator(".statusbar-item").filter(has_text="PKM private Room")
     check(item.count()==1,"Exactly one actual Room source control is required")
     item.hover();hover=page.locator(".monaco-hover").filter(has_text="Private source only; click to revoke the signed session.")
     hover.wait_for(state="visible");tooltip=hover.inner_text()
     check(c["source"]["root"] in tooltip and c["source"]["roomName"] in tooltip,"Wrong exact Room source")
     item.click();proof["actualRoomSourceControlClicked"]=True
     write(step["ack"],{"clicked":True,"actualNativeUi":True})
     continue
    for action in step["dialogs"]:
     box,body,text=modal(page,action["title"])
     kind=action["kind"]
     if kind in ("source","host"):
      check(body["source"]==c["source"] and body["session"]["binding"]==c["binding"],"Changed exact source/profile/build")
      check(body["session"]["activationId"]==c["nativeEpoch"] and body["noExecution"] is True,"Custody is not effect authority")
      if kind=="host":
       check(step["stage"].startswith("native-room-live-open-"),"Host was reproved during a current live effect")
       check("Secrets remain in native SecretStorage" in text,"Host custody boundary omitted")
     elif kind in ("effect","network"):
      effect=body["arguments"]["effect"] if kind=="effect" else body["effect"]
      check(effect["root"]==c["source"]["root"] and effect["workspaceId"]==c["binding"]["workspaceId"],"Wrong Core effect owner")
      check(effect["profileSha256"]==c["binding"]["profileSha256"] and effect["nativeEpoch"]==c["nativeEpoch"],"Wrong effect profile/epoch")
      check(effect["sourceSha256"]==c["source"]["sourceSha256"],"Wrong exact Room source effect")
      check(effect["endpoint"]==c["endpoint"] and effect["selection"]==c["selections"][step["session"]],"Wrong explicit loopback/client/post effect")
      check(effect["maxClients"]==1 and effect["maxPosts"]==1 and effect["temporaryParticipant"] is True,"Unbounded client/participant effect")
      check(effect["participantPolicy"]=="new-agent-only-no-rebind" and effect["noHostReassignment"] is True,"Old identity/Host reassignment granted")
      check(effect["noRemote"] is True and effect["noCredentialExport"] is True,"Unexpected remote/key authority")
      if kind=="effect":
       check(body["readOnly"] is False and body["operation"]=="room.session.loopback.open","Not separate actual effect approval")
       check(body["argumentsDigest"]==canonical(body["arguments"]),"Effect arguments changed")
       proof["effects"][step["session"]]={"effectSha256":canonical(effect),"sessionId":effect["sessionId"],"expiresAtMs":effect["expiresAtMs"]}
      else:
       check(body["session"]["binding"]==c["binding"],"Native effect changed actual attachment")
       check(proof["effects"][step["session"]]["effectSha256"]==canonical(effect),"Network did not consume the exact current effect")
       check("Source and Host custody alone did not authorize" in text,"Network effect inherited custody incorrectly")
     else:
      req=read("native-room-live-public-request.json")
      check(req["stage"]==step["stage"],"Wrong current original public call")
      check(body["operation"]=="mcp.tool."+req["tool"] and body["tool"]==req["tool"] and body["readOnly"] is False,"Wrong public authority")
      check(body["workspaceId"]==c["binding"]["workspaceId"] and body["root"]==c["source"]["root"],"Wrong public Core")
      if req["tool"]=="chat_join":
       args=body["arguments"];intent=args["user_link"]
       check("magic_link" not in args and args["name"]==c["selections"][step["session"]]["alias"],"Join lost original contract/redaction")
       for key in ["argumentsSha256","magicLinkSha256","suppliedNameSha256"]:check(intent[key]==req[key],"Wrong exact user-input digest")
       check(intent["endpoint"]==c["endpoint"] and intent["requestedEndpoint"]==c["endpoint"],"Join endpoint not currently approved")
       check(intent["requestedRoomId"]==c["source"]["roomId"],"Join source was changed")
      else:check(body["arguments"]==req["arguments"],"Original public arguments were coerced")
      check(body["argumentsDigest"]==canonical(body["arguments"]),"Public approval digest changed")
     proof["dialogs"].append({"stage":step["stage"],"kind":kind,"choice":action["choice"],"textSha256":hashlib.sha256(text.encode()).hexdigest()})
     box.get_by_role("button",name=action["choice"],exact=True).click()
   stage("native-room-live-complete")
   proof.update({"passed":True,"actualNativeUi":True,"exactCurrentEffectVisible":True,
    "noExtraHostProofWithinLiveEffect":True,"noPlaintextInviteEvidence":True})
   write(output,proof)
  browser.close()
except Exception:
 try:write(output,{"failed":True,"code":"INSTALLED_ROOM_LIVE_UI_FAILED"})
 except FileExistsError:pass
 raise
`;

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 5000); force.unref();
  try { await done; } finally { clearTimeout(force); }
}
export async function startInstalledNativeRoomLiveUi({ root, python, env, port, timeoutMs = 120000, mode = "live" }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077) fail("INSTALLED_ROOM_LIVE_PRIVATE_DRIVER_REQUIRED");
  if (typeof python !== "string" || !isAbsolute(python) || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !["live","credentials"].includes(mode))
    fail("INSTALLED_ROOM_LIVE_BOUNDED_UI_REQUIRED");
  let error;
  const uiEnvironment = { ...env };
  delete uiEnvironment.PKM_INSTALLED_ROOM_LIVE_REQUESTED_JOIN_SECRET;
  const child = spawn(python, ["-I", "-B", "-c", installedNativeRoomLiveUiProgram, JSON.stringify({ root, port, timeoutMs, mode })],
    { env: uiEnvironment, stdio: "inherit" });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(Object.assign(new Error("INSTALLED_ROOM_LIVE_UI_FAILED"),
      { code: "INSTALLED_ROOM_LIVE_UI_FAILED" })));
  });
  void done.catch(failure => { error = failure; });
  return Object.freeze({ done, get error() { return error; }, stop: () => stopChild(child) });
}
