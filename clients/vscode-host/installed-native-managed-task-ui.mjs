import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

export const installedNativeManagedTaskUiProgram = String.raw`
import hashlib,json,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000
until=time.monotonic()+min(seconds*8,900);proof={"dialogs":[],"choices":[],"runId":f["runId"]}
def check(ok,message):
    if not ok:raise AssertionError(message)
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def norm(value):return " ".join(value.replace("\u00a0"," ").split())
def bounded():check(time.monotonic()<until,"Managed Task renderer exceeded bounded lifetime")
def read(name):return json.loads((root/name).read_text())
def wait_file(name):
    stop=min(until,time.monotonic()+seconds)
    while time.monotonic()<stop:
        bounded()
        try:return read(name)
        except (FileNotFoundError,json.JSONDecodeError):time.sleep(.025)
    raise RuntimeError("Managed Task renderer file timeout: "+name)
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
    raise RuntimeError("Managed Task renderer stage timeout: "+name)
def publish(name,value):
    with (root/name).open("x") as output:json.dump(value,output)
def sha(value):check(isinstance(value,str) and re.fullmatch("[a-f0-9]{64}",value),"Expected exact SHA-256 identity");return value
def uuid(value):check(isinstance(value,str) and re.fullmatch("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}",value),"Expected exact UUID");return value
try:
    c=wait_file("native-managed-task-ui-contract.json")
    check(c["schema"]=="pkm.installed-native-managed-task-ui/v1" and c["runId"]==f["runId"],"Wrong managed Task UI contract")
    check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Not a disposable installed driver")
    check(c["providerVendor"]=="pkm-native-managed-task-fixture","Wrong native Task fixture provider")
    check(c["modelLabel"]=="Synthetic installed managed Task evidence model","Wrong native Task fixture model")
    check(c["modelId"].startswith("vscode:pkm-native-managed-task-fixture:"),"Wrong actual native model identity")
    for key in ["profileSha256","sourcePlanSha256"]:sha(c[key])
    uuid(c["workspaceId"]);uuid(c["nativeEpoch"])
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
        pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
        check(len(pages)==1,"Exactly one installed workbench renderer is required")
        page=pages[0];page.wait_for_load_state("domcontentloaded",timeout=f["timeoutMs"]);page.set_default_timeout(f["timeoutMs"])
        publish("native-managed-task-ui-ready.json",{"ready":True,"actualRenderer":True,"runId":f["runId"]})
        def exact(locator,text):
            item=locator.get_by_text(text,exact=True);item.wait_for(state="visible")
            check(item.count()==1 and item.is_visible(),"Expected unique exact visible text: "+text)
            return item
        def modal(title,button,validate,click=True):
            bounded();dialog=page.locator(".monaco-dialog-box:visible");dialog.wait_for(state="visible")
            check(dialog.count()==1,"Multiple native Task modals");exact(dialog,title)
            text=dialog.inner_text().replace("\u00a0"," ");start=text.find("{")
            check(start>=0,"Native modal omitted structured exact-request details")
            data,_=json.JSONDecoder().raw_decode(text[start:]);validate(data)
            selected=dialog.get_by_role("button",name=button,exact=True)
            check(selected.count()==1 and selected.is_visible(),"Expected one exact native choice")
            check(dialog.get_by_role("button",name="Deny",exact=True).count()==1,"Native Deny option is missing")
            proof["dialogs"].append({"title":title,"choice":button,"visibleTextSha256":hashlib.sha256(norm(text).encode()).hexdigest()})
            saved=(dialog.element_handle(),selected.element_handle(),hashlib.sha256(text.encode()).hexdigest()) if not click else None
            if click:selected.click()
            return data,saved
        def owner(data,profile=True):
            check(data.get("root")==c["sourceRoot"] and data.get("workspaceId")==c["workspaceId"],"Wrong native Task Root/workspace")
            if profile:check(data.get("profileSha256")==c["profileSha256"],"Wrong native Task profile")
        def request(name):
            q=wait_file("native-managed-task-request-"+name+".json")
            check(q["name"]==name and q["commandId"]=="installed-managed-task-"+name+"-"+c["runId"],"Wrong exact Task command")
            check(q["requestId"]==hashlib.sha256(json.dumps([c["workspaceId"],q["commandId"]]).encode()).hexdigest(),"Wrong original request identity")
            check(q["hardToolRoundLimit"]==5 and q["argumentsSha256"]==digest({"chatId":q["chatId"],"prompt":q["prompt"],"hardToolRoundLimit":5}),"Wrong whole-prompt Task pin")
            check(re.fullmatch(r"pkm://chats/[a-f0-9]{16}/"+uuid(q["chatId"]),q["chatUrl"]),"Wrong exact Chat locator")
            return q
        def public(tool,arguments):
            def validate(data):
                owner(data,False)
                check(data["operation"]=="mcp.tool."+tool and data["tool"]==tool and data["version"]==1 and data["readOnly"] is False,"Unexpected public Task operation")
                check(data["arguments"]==arguments and data["argumentsDigest"]==digest(arguments),"Wrong exact public Task arguments")
            modal("Allow PKM v5 "+tool+" for this exact request?","Approve this request",validate)
        def bind(q,chat):
            selection={}
            def validate(data):
                owner(data)
                check(data["requestId"]==q["requestId"] and data["chatUrl"]==chat and data["sourcePlanSha256"]==c["sourcePlanSha256"],"Wrong native Task/model binding")
                check(data["model"]["id"]==c["modelId"] and data["model"]["nativeModelId"]==c["wireModelId"],"Wrong exact native Task model")
                value=data["selection"]
                check(value["protocol"]=="pkm.original-api-chat-execution/v1" and value["provider"]=="vscode" and value["epoch"]==c["nativeEpoch"],"Wrong Task native authority")
                check(value["modelId"]==c["modelId"] and value["wireModelId"]==c["wireModelId"] and value["permissionMode"]=="protective","Wrong model/permission binding")
                check(0<value["outputTokenCap"]<=8192 and 0<value["budget"]["maxInputTokens"]<=200000 and value["budget"]["maxTotalOutputTokens"]<=32768,"Unbounded Task selection")
                selection.update(value)
            modal("Bind this exact native VS Code model to this PKM Chat?","Allow this native model request",validate)
            return selection
        def create(name):
            stage("native-managed-task-create-"+name);q=c["creations"][name]
            check(q["commandId"]=="installed-managed-task-create-"+name+"-"+c["runId"],"Wrong create command identity")
            public("api_chat_create",{"host_id":c["workspaceId"],"title":q["title"],"command_id":q["commandId"],"model_id":""})
            widget=page.locator(".quick-input-widget:visible");widget.wait_for(state="visible");check(widget.count()==1,"Multiple native model choices")
            exact(widget,"Choose an exact model for this PKM Chat")
            row=widget.locator(".monaco-list-row").filter(has=page.get_by_text(c["modelLabel"],exact=True))
            check(row.count()==1 and c["modelId"] in norm(row.inner_text()),"Wrong exact registered Task model row");row.click()
            proof["choices"].append({"modelId":c["modelId"],"creation":name})
            selection=bind(q,None)
            def validate(data):
                owner(data)
                check(data["operation"]=="create" and data["requestId"]==q["requestId"] and data["commandId"]==q["commandId"],"Wrong native create identity")
                check(data["chatUrl"] is None and data["selection"]==selection and data["sourcePlanSha256"]==c["sourcePlanSha256"],"Wrong native create binding")
                check(data["sourceUncertain"] is False and data["argumentsSha256"]==digest({"title":q["title"],"modelId":""}),"Wrong native create arguments")
            modal("Create this native PKM Chat with the selected model?","Allow this native model request",validate)
        def public_send(q):
            public("api_chat_send",{"host_id":c["workspaceId"],"chat_id":q["chatId"],"prompt":q["prompt"],"command_id":q["commandId"],"hard_tool_round_limit":5})
        def send(name):
            q=request(name);public_send(q)
            def select(data):owner(data);check(data["modelId"]==c["modelId"],"Wrong preselected native Task model");sha(data["catalogueSha256"])
            modal("Select this exact native VS Code model?","Allow this native model request",select)
            public_send(q)
            selection=bind(q,q["chatUrl"])
            def validate(data):
                owner(data)
                check(data["operation"]=="send" and data["requestId"]==q["requestId"] and data["commandId"]==q["commandId"],"Wrong exact Task send")
                check(data["chatUrl"]==q["chatUrl"] and data["sourcePlanSha256"]==c["sourcePlanSha256"] and data["selection"]==selection,"Wrong Task send context")
                check(data["argumentsSha256"]==q["argumentsSha256"] and data["sourceUncertain"] is False,"Whole Task prefix/prompt was not consent-bound")
                check("liveMemory" not in data,"Unqualified Task Memory composition appeared")
            modal("Send this exact request to the bound native PKM Chat?",
                "Deny" if name=="deny" else "Allow this native model request",validate)
            if name=="deny":return q,None
            b=wait_file("native-managed-task-binding-"+name+".json");binding=b["managedTask"]
            check(binding["requestId"]==q["requestId"] and binding["chatId"]==q["chatId"] and binding["sourcePlanSha256"]==c["sourcePlanSha256"],"Wrong actual Core Task binding")
            check(binding["schema"]=="pkm.original-native-task-execution/v1" and binding["nativeEpoch"]==c["nativeEpoch"],"Wrong Task execution protocol")
            check(re.fullmatch("agent_session_[a-f0-9]{32}",binding["taskId"]),"Wrong canonical Task identity")
            for key in ["attemptId","inputId","replyId"]:uuid(binding[key])
            check(sorted(b["tools"])==sorted(["get_document","session_info","report_work","record_harness"]),"Unexpected scoped Task tool catalog")
            def execution(data):
                owner(data)
                for key in ["requestId","chatUrl","sourcePlanSha256"]:check(data[key]==q[key] if key!="sourcePlanSha256" else data[key]==c[key],"Wrong Task execution pin")
                check(data["planSha256"]==b["planSha256"] and data["hardToolRoundLimit"]==5 and data["tools"]==b["tools"],"Wrong canonical execution-plan/tool budget")
                check(data["outputTokenCap"]==selection["outputTokenCap"] and 0<data["budget"]["deadlineMs"]<=300000,"Wrong Task execution bounds")
                check(data["budget"]["maxInputTokens"]==selection["budget"]["maxInputTokens"]
                    and data["budget"]["maxTotalOutputTokens"]==selection["budget"]["maxTotalOutputTokens"]
                    and data["budget"]["deadlineMs"]<=selection["budget"]["deadlineMs"],"Execution budget differs from native selection")
                check(data["managedTask"]==binding,"Wrong displayed managed Task metadata")
            modal("Run this native PKM Chat request with the displayed limits?","Allow this native model request",execution)
            return q,b
        inference_pins=set()
        def inference(click=True):
            def validate(data):
                check(data["root"]==c["sourceRoot"] and data["model"]==c["wireModelId"],"Wrong native Task inference")
                pin=sha(data["requestSha256"]);check(pin not in inference_pins,"A native inference approval was replayed");inference_pins.add(pin)
            return modal("Send this inference to native VS Code model "+c["wireModelId"]+"?","Approve this request",validate,click)
        def tool(q,b,proposal):
            captured={};read_only=proposal["operation"]=="knowledge.document.get"
            def arguments(value):
                actual=dict(value)
                if not read_only:uuid(actual.pop("operationId",None))
                check(actual==proposal["arguments"],"Wrong actual Core Task tool proposal")
            def review(data):
                check(data["root"]==c["sourceRoot"] and data["workspaceId"]==c["workspaceId"] and data["actorId"]=="mcp:external","Wrong Core Task reviewer")
                check(data["context"]=={"turnId":q["requestId"],"contextDigest":b["planSha256"],"readOnly":read_only},"Wrong Core Task review context")
                check(data["record"]["tool"]==proposal["operation"] and data["record"]["status"] in ["pending","awaiting_approval"],"Wrong current Core tool record")
                arguments(data["record"]["arguments"]);check(data["argumentsDigest"]==digest(data["record"]["arguments"]),"Wrong Core review argument digest")
                captured.update(data["record"]["arguments"])
            modal("Review native PKM execution "+proposal["operation"],"Approve this request",review)
            def approve(data):
                check(data["root"]==c["sourceRoot"] and data["workspaceId"]==c["workspaceId"] and data["actorId"]=="mcp:external","Wrong native Task tool actor")
                check(data["operation"]==proposal["operation"] and data["version"]==1 and data["arguments"]==captured,"Changed Task tool after review")
                check(data["turnId"]==q["requestId"] and data["contextDigest"]==b["planSha256"] and data["readOnly"] is read_only,"Wrong Task tool effect context")
                check(data["argumentsDigest"]==digest(captured),"Wrong Task effect arguments")
            modal("Allow native PKM tool "+proposal["operation"]+"?","Approve this request",approve)
        stage("native-managed-task-chat-source")
        def source(data):
            check(data["noExecution"] is True,"Source-only admission granted execution")
            signed=data["session"];check(signed["epoch"]==c["nativeEpoch"],"Wrong signed source epoch")
            check(signed["binding"]["root"]==c["sourceRoot"] and signed["binding"]["workspaceId"]==c["workspaceId"]
                and signed["binding"]["profileSha256"]==c["profileSha256"],"Wrong signed source Root/workspace/profile")
            check(c["sourcePlanSha256"] in json.dumps(data["request"]),"Wrong exact ordinary source plan")
            check("No old worker, Engine, queued execution" in data["permission"],"Source permission changed")
        modal("Admit this exact original API Chat source?","Admit this exact source only",source)
        stage("native-managed-task-archive-refuse");public_send(request("archive"))
        create("main")
        stage("native-managed-task-start-deny");send("deny")
        stage("native-managed-task-start-plain");send("plain");inference();inference()
        stage("native-managed-task-followup");q,b=send("followup")
        check(len(b["proposals"])==5 and len(b["goal"]["sourceInputIds"])==2,"Wrong real Core follow-up/Harness program")
        for proposal in b["proposals"]:inference();tool(q,b,proposal)
        inference()
        stage("native-managed-task-followup-replay");public_send(q)
        create("cancel")
        stage("native-managed-task-run-cancel");send("cancel");inference()
        stage("native-managed-task-cancel-owned");q=wait_file("native-managed-task-cancel-command.json")
        public("api_chat_cancel",{"host_id":c["workspaceId"],"chat_id":q["chatId"],"command_id":q["commandId"]})
        def cancel(data):
            owner(data)
            check(data["operation"]=="cancel" and data["requestId"]==q["requestId"] and data["commandId"]==q["commandId"],"Wrong actual owned cancel identity")
            check(data["chatUrl"]==q["chatUrl"] and data["selection"] is None and data["sourcePlanSha256"]==c["sourcePlanSha256"],"Wrong owned Task cancel scope")
            check(data["argumentsSha256"]==q["argumentsSha256"] and data["sourceUncertain"] is False,"Wrong exact cancel arguments")
        modal("Cancel this exact owned native PKM Chat request?","Allow this native model request",cancel)
        create("stale")
        stage("native-managed-task-stale-pending");q,b=send("stale")
        data,saved=inference(False)
        publish("native-managed-task-stale-visible.json",{"visible":True,"actualNativeModal":True,"requestId":q["requestId"],"requestSha256":data["requestSha256"]})
        committed=wait_file("native-managed-task-stale-committed.json")
        check(committed["committed"] is True and committed["beforeRevision"]==b["chatRevision"] and committed["afterRevision"]==b["chatRevision"]+1,"No actual newer canonical Chat input")
        uuid(committed["operationId"]);uuid(committed["messageId"])
        dialog_node,button_node,text_pin=saved
        check(dialog_node.evaluate("(node)=>node.isConnected"),"The original pending modal node was replaced")
        check(button_node.evaluate("(node)=>node.isConnected"),"The original pending approval button was replaced")
        check(hashlib.sha256(dialog_node.inner_text().replace("\u00a0"," ").encode()).hexdigest()==text_pin,"The pending inference modal changed")
        button_node.click()
        publish("native-managed-task-stale-clicked.json",{"clicked":True,"samePendingModal":True})
        stage("native-managed-task-source-revoke")
        publish("native-managed-task-source-revoke-visible.json",{"observed":True})
        stage("native-managed-task-complete")
        check(page.locator(".monaco-dialog-box:visible").count()==0 and page.locator(".quick-input-widget:visible").count()==0,"Unexpected extra approval after the bounded Task workflow")
        proof.update({"passed":True,"actualRenderedDom":True,"sameStaleModalClickedAfterCommit":True,"exactTaskSendDeniedThenApproved":True,
            "actualOwnedCancellationChoices":True,"sourceRoot":c["sourceRoot"],"profileSha256":c["profileSha256"],"commercialProviderQualified":False})
        publish("native-managed-task-ui-passed.json",proof)
except Exception as error:
    try:publish("native-managed-task-ui-passed.json",{"failed":True,"runId":f["runId"],"error":str(error),"observed":proof})
    except Exception:pass
    raise
`;

/** Targets only the declared private installed fixture; never owns or changes the editor. */
export async function startInstalledNativeManagedTaskUi({ root, python, env, port, runId, timeoutMs = 120000 }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root))
    || !isAbsolute(python ?? "") || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !/^[a-f0-9-]{36}$/.test(runId ?? ""))
    throw Object.assign(new Error("INSTALLED_MANAGED_TASK_PRIVATE_UI_REQUIRED"), { code: "INSTALLED_MANAGED_TASK_PRIVATE_UI_REQUIRED" });
  const child = spawn(python, ["-B", "-c", installedNativeManagedTaskUiProgram, JSON.stringify({ root, port, runId, timeoutMs })], {
    env: { ...process.env, ...env, TMPDIR: root, TMP: root, TEMP: root, PYTHONDONTWRITEBYTECODE: "1" }, stdio: "inherit",
  });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Managed Task renderer exited ${code}/${signal}`)));
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
