import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

export const installedNativeManagedTaskAdoptionUiProgram = String.raw`
import hashlib,json,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000
until=time.monotonic()+min(seconds*8,900);proof={"dialogs":[],"choices":[],"runId":f["runId"]}
def check(ok,message):
    if not ok:raise AssertionError(message)
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def norm(value):return " ".join(value.replace("\u00a0"," ").split())
def bounded():check(time.monotonic()<until,"Installed adoption renderer exceeded bounded lifetime")
def read(name):return json.loads((root/name).read_text())
def wait_file(name):
    stop=min(until,time.monotonic()+seconds)
    while time.monotonic()<stop:
        bounded()
        try:return read(name)
        except (FileNotFoundError,json.JSONDecodeError):time.sleep(.025)
    raise RuntimeError("Adoption renderer file timeout: "+name)
def stage(name):
    stop=min(until,time.monotonic()+seconds)
    while time.monotonic()<stop:
        bounded()
        try:
            current=read("progress.json").get("stage")
            check(current!="failed","Parent installed workflow failed")
            if current==name:return
        except (FileNotFoundError,json.JSONDecodeError):pass
        time.sleep(.025)
    raise RuntimeError("Adoption renderer stage timeout: "+name)
def publish(name,value):
    with (root/name).open("x") as output:json.dump(value,output)
def sha(value):check(isinstance(value,str) and re.fullmatch("[a-f0-9]{64}",value),"Expected exact SHA-256 identity");return value
def uuid(value):check(isinstance(value,str) and re.fullmatch("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}",value),"Expected exact UUID");return value
try:
    c=wait_file("native-task-adoption-ui-contract.json")
    check(c["schema"]=="pkm.installed-native-managed-task-adoption-ui/v1" and c["runId"]==f["runId"],"Wrong installed adoption contract")
    check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Not a disposable installed driver")
    check(c["providerVendor"]=="pkm-native-managed-task-adoption-fixture","Wrong actual adoption provider")
    check(c["modelLabel"]=="Synthetic installed original Task adoption model","Wrong actual adoption model")
    check(c["modelId"].startswith("vscode:pkm-native-managed-task-adoption-fixture:"),"Wrong exact registered model identity")
    for key in ["profileSha256","sourcePlanSha256","nativeHostReceiptSha256"]:sha(c[key])
    uuid(c["workspaceId"]);uuid(c["nativeEpoch"])
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
        pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
        check(len(pages)==1,"Exactly one installed workbench renderer is required")
        page=pages[0];page.wait_for_load_state("domcontentloaded",timeout=f["timeoutMs"]);page.set_default_timeout(f["timeoutMs"])
        publish("native-task-adoption-ui-ready.json",{"ready":True,"actualRenderer":True,"runId":f["runId"]})
        def exact(locator,text):
            item=locator.get_by_text(text,exact=True);item.wait_for(state="visible")
            check(item.count()==1 and item.is_visible(),"Expected unique exact visible text: "+text);return item
        def modal(title,button,validate,click=True):
            bounded();dialog=page.locator(".monaco-dialog-box:visible");dialog.wait_for(state="visible")
            check(dialog.count()==1,"Multiple native adoption modals");exact(dialog,title)
            text=dialog.inner_text().replace("\u00a0"," ");start=text.find("{")
            check(start>=0,"Native adoption modal omitted structured details")
            data,_=json.JSONDecoder().raw_decode(text[start:]);validate(data)
            selected=dialog.get_by_role("button",name=button,exact=True)
            check(selected.count()==1 and selected.is_visible(),"Expected one exact native adoption choice")
            check(dialog.get_by_role("button",name="Deny",exact=True).count()==1,"Native Deny option is missing")
            proof["dialogs"].append({"title":title,"choice":button,"visibleTextSha256":hashlib.sha256(norm(text).encode()).hexdigest()})
            saved=(dialog.element_handle(),selected.element_handle(),hashlib.sha256(text.encode()).hexdigest()) if not click else None
            if click:selected.click()
            return data,saved
        def owner(data,profile=True):
            check(data.get("root")==c["sourceRoot"] and data.get("workspaceId")==c["workspaceId"],"Wrong native adoption Root/workspace")
            if profile:check(data.get("profileSha256")==c["profileSha256"],"Wrong native adoption profile")
        def request(name):
            q=c["requests"][name];original=c["cases"]["collision" if name=="collision" else "main"]
            check(q["commandId"]=="installed-task-adoption-"+name+"-"+c["runId"],"Wrong exact adoption command")
            check(q["chatId"]==original["chatId"] and q["chatUrl"]==original["chatUrl"],"Original UUID/URL was replaced")
            check(q["requestId"]==hashlib.sha256(json.dumps([c["workspaceId"],q["commandId"]]).encode()).hexdigest(),"Wrong original request identity")
            check(q["hardToolRoundLimit"]==7 and q["argumentsSha256"]==digest({"chatId":q["chatId"],"prompt":q["prompt"],"hardToolRoundLimit":7}),"Wrong complete continuation digest")
            return q,original
        def public(q):
            def validate(data):
                owner(data,False)
                expected={"host_id":c["workspaceId"],"chat_id":q["chatId"],"prompt":q["prompt"],"command_id":q["commandId"],"hard_tool_round_limit":7}
                check(data["operation"]=="mcp.tool.api_chat_send" and data["tool"]=="api_chat_send" and data["version"]==1 and data["readOnly"] is False,"Unexpected public operation")
                check(data["arguments"]==expected and data["argumentsDigest"]==digest(expected),"Unexpected exact public continuation")
            modal("Allow PKM v5 api_chat_send for this exact request?","Approve this request",validate)
        def send(name):
            q,original=request(name);public(q);public(q)
            widget=page.locator(".quick-input-widget:visible");widget.wait_for(state="visible")
            check(widget.count()==1,"Multiple model Quick Picks");exact(widget,"Choose an exact native model for this PKM Chat")
            row=widget.locator(".monaco-list-row").filter(has=page.get_by_text(c["modelLabel"],exact=True))
            check(row.count()==1 and c["modelId"] in norm(row.inner_text()),"Wrong exact registered adoption model row");row.click()
            proof["choices"].append({"phase":name,"modelId":c["modelId"]})
            selection={}
            def bind(data):
                owner(data)
                check(data["requestId"]==q["requestId"] and data["chatUrl"]==original["chatUrl"] and data["sourcePlanSha256"]==c["sourcePlanSha256"],"Wrong original source/model binding")
                check(data["model"]["id"]==c["modelId"] and data["model"]["nativeModelId"]==c["wireModelId"],"Historical/default model was selected")
                value=data["selection"]
                check(value["protocol"]=="pkm.original-api-chat-execution/v1" and value["provider"]=="vscode" and value["epoch"]==c["nativeEpoch"],"Wrong native execution authority")
                check(value["modelId"]==c["modelId"] and value["wireModelId"]==c["wireModelId"] and value["permissionMode"]=="protective","Wrong current model/permission binding")
                check(0<value["outputTokenCap"]<=8192 and 0<value["budget"]["maxInputTokens"]<=200000 and value["budget"]["maxTotalOutputTokens"]<=32768,"Unbounded adoption model selection")
                selection.update(value)
            modal("Bind this exact native VS Code model to this PKM Chat?","Allow this native model request",bind)
            def select(data):owner(data);check(data["modelId"]==c["modelId"],"Wrong actual native model selection");sha(data["catalogueSha256"])
            modal("Select this exact native VS Code model?","Allow this native model request",select)
            selected=wait_file("native-task-adoption-source-"+("collision" if name=="collision" else "main")+".json")
            def adoption(data):
                owner(data)
                check(data["schema"]=="pkm.chat.original-task-adoption-review/v1","Wrong adoption protocol")
                for key in ["requestId","commandId","chatUrl","prompt","argumentsSha256"]:check(data[key]==q[key],"Wrong exact adoption request "+key)
                check(data["sourcePlanSha256"]==c["sourcePlanSha256"] and data["sourceSha256"]==selected["sourceSha256"],"Wrong independently reconstructed source")
                check(data["original"]==selected["original"] and data["selection"]==selection,"Changed source/Goal/model before adoption")
                check(data["original"]["taskId"]==original["taskId"] and data["original"]["goal"]["id"]==original["goalId"]
                    and data["original"]["goal"]["inputId"]==original["originalInputId"],"Original Task/Goal/input identity was replaced")
                check(data["previousExecutionDigest"]==selected["original"]["goal"]["executionDigest"],"Wrong historical execution context")
                context={"root":c["sourceRoot"],"workspaceId":c["workspaceId"],"actorId":"mcp:external","chatId":q["chatId"],
                    "nativeHostReceiptSha256":c["nativeHostReceiptSha256"],"sourcePlanSha256":c["sourcePlanSha256"],"model":selection}
                check(data["nextExecutionDigest"]==digest(context),"Wrong proposed canonical context")
                check(data["resetCurrentAcceptance"] is True and data["importOldPermissions"] is False and data["historicalEvidenceOnly"] is True
                    and data["taskCompletion"]=="not-claimed","Old acceptance/permission became current authority")
                check("old model, permissions, verified acceptance" in data["permission"],"Native adoption disclosure changed")
            _,saved=modal("Adopt this exact original PKM Task and revalidate its Goal?",
                "Deny" if name=="adoptDeny" else "Adopt this exact goal and reset acceptance",adoption,name!="collision")
            if name=="adoptDeny":return q,None
            if name=="collision":
                publish("native-task-adoption-collision-visible.json",{"visible":True,"actualNativeModal":True,"requestId":q["requestId"]})
                committed=wait_file("native-task-adoption-collision-committed.json")
                check(committed["committed"] is True and committed["chatId"]==q["chatId"] and committed["revision"]==2,"No real concurrent canonical input")
                uuid(committed["operationId"]);uuid(committed["inputOperationId"]);uuid(committed["messageId"]);dialog,button,pin=saved
                check(dialog.evaluate("(node)=>node.isConnected"),"The original pending adoption modal node was replaced")
                check(button.evaluate("(node)=>node.isConnected"),"The original pending adoption button was replaced")
                check(hashlib.sha256(dialog.inner_text().replace("\u00a0"," ").encode()).hexdigest()==pin,"The pending adoption modal changed")
                button.click();publish("native-task-adoption-collision-clicked.json",{"clicked":True,"samePendingModal":True})
            def authorize(data):
                owner(data)
                check(data["operation"]=="send" and data["requestId"]==q["requestId"] and data["commandId"]==q["commandId"],"Wrong separate send identity")
                check(data["chatUrl"]==q["chatUrl"] and data["sourcePlanSha256"]==c["sourcePlanSha256"] and data["selection"]==selection,"Wrong separate send binding")
                check(data["sourceUncertain"] is False and data["argumentsSha256"]==q["argumentsSha256"],"Wrong send/prompt authority")
                check("liveMemory" not in data,"Unqualified live Memory entered adoption")
            modal("Send this exact request to the bound native PKM Chat?",
                "Deny" if name=="sendDeny" else "Allow this native model request",authorize)
            if name in ["sendDeny","collision"]:return q,None
            b=wait_file("native-task-adoption-positive-binding.json");binding=b["managedTask"]
            check(binding["taskId"]==original["taskId"] and binding["chatId"]==original["chatId"]
                and binding["requestId"]==q["requestId"] and binding["sourcePlanSha256"]==c["sourcePlanSha256"],"Wrong actual same-Core adoption binding")
            check(b["goal"]["id"]==original["goalId"] and b["goal"]["inputId"]==original["originalInputId"],"Goal/input was manufactured")
            check(all(item["verified"] is False and not item["evidenceCallIds"] for item in b["goal"]["acceptance"]),"Historical acceptance was not reset")
            check(sorted(b["tools"])==sorted(["get_document","session_info","report_work","record_harness"]),"Unexpected scoped tool authority")
            def execution(data):
                owner(data)
                for key in ["requestId","chatUrl"]:check(data[key]==q[key],"Wrong native run identity")
                check(data["sourcePlanSha256"]==c["sourcePlanSha256"] and data["planSha256"]==b["planSha256"] and data["managedTask"]==binding,"Wrong actual adopted plan")
                check(data["tools"]==b["tools"] and data["hardToolRoundLimit"]==7,"Unexpected tool/round authority")
                check(data["outputTokenCap"]==selection["outputTokenCap"] and 0<data["budget"]["deadlineMs"]<=selection["budget"]["deadlineMs"],"Wrong execution limit")
                for key in ["maxInputTokens","maxTotalOutputTokens"]:check(data["budget"][key]==selection["budget"][key],"Execution budget changed")
            modal("Run this native PKM Chat request with the displayed limits?","Allow this native model request",execution)
            return q,b
        def tool(q,b,proposal):
            captured={};readonly=proposal["operation"] in ["knowledge.document.get","chat.task.get"]
            def review(data):
                check(data["root"]==c["sourceRoot"] and data["workspaceId"]==c["workspaceId"] and data["actorId"]=="mcp:external","Wrong Core review owner")
                check(data["context"]=={"turnId":q["requestId"],"contextDigest":b["planSha256"],"readOnly":readonly},"Wrong Core review context")
                check(data["record"]["tool"]==proposal["operation"] and data["record"]["status"] in ["pending","awaiting_approval"],"Wrong exact Core record")
                args=dict(data["record"]["arguments"])
                if not readonly:uuid(args.pop("operationId",None))
                check(args==proposal["arguments"],"Wrong expected Core tool arguments")
                check(data["argumentsDigest"]==digest(data["record"]["arguments"]),"Wrong Core review digest")
                captured.update(data["record"]["arguments"])
            modal("Review native PKM execution "+proposal["operation"],"Approve this request",review)
            def approve(data):
                check(data["root"]==c["sourceRoot"] and data["workspaceId"]==c["workspaceId"] and data["actorId"]=="mcp:external","Wrong tool effect owner")
                check(data["operation"]==proposal["operation"] and data["version"]==1 and data["arguments"]==captured,"Tool changed after review")
                check(data["turnId"]==q["requestId"] and data["contextDigest"]==b["planSha256"] and data["readOnly"] is readonly,"Wrong tool effect scope")
                check(data["argumentsDigest"]==digest(captured),"Wrong effect digest")
            modal("Allow native PKM tool "+proposal["operation"]+"?","Approve this request",approve)
        inference_pins=set()
        def inference():
            def validate(data):
                check(data["root"]==c["sourceRoot"] and data["model"]==c["wireModelId"],"Wrong native inference target")
                pin=sha(data["requestSha256"]);check(pin not in inference_pins,"A native inference approval was replayed");inference_pins.add(pin)
            modal("Send this inference to native VS Code model "+c["wireModelId"]+"?","Approve this request",validate)
        stage("native-task-adoption-source")
        def source(data):
            check(data["noExecution"] is True,"Source review granted execution")
            signed=data["session"]
            check(signed["epoch"]==c["nativeEpoch"] and signed["binding"]["root"]==c["sourceRoot"]
                and signed["binding"]["workspaceId"]==c["workspaceId"] and signed["binding"]["profileSha256"]==c["profileSha256"],"Wrong signed original source owner")
            check(c["sourcePlanSha256"] in json.dumps(data["request"]),"Wrong exact original source plan")
            check("No old worker, Engine, queued execution" in data["permission"],"Source scope changed")
        modal("Admit this exact original API Chat source?","Admit this exact source only",source)
        stage("native-task-adoption-deny-review");send("adoptDeny")
        stage("native-task-adoption-deny-send");send("sendDeny")
        stage("native-task-adoption-positive");q,b=send("positive")
        check(len(b["proposals"])==7,"Wrong exact current-Core/Harness fixture program")
        for proposal in b["proposals"]:inference();tool(q,b,proposal)
        inference()
        stage("native-task-adoption-replay");public(request("positive")[0])
        stage("native-task-adoption-collision");send("collision")
        stage("native-task-adoption-source-revoke");publish("native-task-adoption-revoke-visible.json",{"observed":True})
        stage("native-task-adoption-complete")
        check(page.locator(".monaco-dialog-box:visible").count()==0 and page.locator(".quick-input-widget:visible").count()==0,"Unexpected extra approval after adoption")
        proof.update({"passed":True,"actualRenderedDom":True,"sameCollisionReviewClickedAfterCommit":True,
            "separateAdoptionAndSendDenials":True,"publicReplaySeparateApproval":True,"sourceRoot":c["sourceRoot"],
            "profileSha256":c["profileSha256"],"humanTaskAcceptanceClaimed":False})
        publish("native-task-adoption-ui-passed.json",proof)
except Exception as error:
    try:publish("native-task-adoption-ui-passed.json",{"failed":True,"runId":f["runId"],"error":str(error),"observed":proof})
    except Exception:pass
    raise
`;

export async function startInstalledNativeManagedTaskAdoptionUi({ root, python, env, port, runId, timeoutMs = 120000 }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root))
    || !isAbsolute(python ?? "") || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !/^[a-f0-9-]{36}$/.test(runId ?? ""))
    throw Object.assign(new Error("INSTALLED_TASK_ADOPTION_PRIVATE_UI_REQUIRED"), { code: "INSTALLED_TASK_ADOPTION_PRIVATE_UI_REQUIRED" });
  const child = spawn(python, ["-B", "-c", installedNativeManagedTaskAdoptionUiProgram, JSON.stringify({ root, port, runId, timeoutMs })], {
    env: { ...process.env, ...env, TMPDIR: root, TMP: root, TEMP: root, PYTHONDONTWRITEBYTECODE: "1" }, stdio: "inherit",
  });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Installed adoption renderer exited ${code}/${signal}`)));
  });
  void done.catch(value => { error = value; });
  let closing;
  return Object.freeze({ done, get error() { return error; }, stop() {
    return closing ??= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await stopped; } finally { clearTimeout(timer); }
    })();
  } });
}
