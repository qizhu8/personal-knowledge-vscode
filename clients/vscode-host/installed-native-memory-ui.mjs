import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

export const installedNativeMemoryUiProgram = String.raw`
import hashlib,json,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000
until=time.monotonic()+min(seconds*4,360);proof={"schema":"pkm.installed-native-memory-ui-evidence/v1","dialogs":[],"choices":[]}
def norm(text):return " ".join(text.replace("\u00a0"," ").split())
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def check(condition,message):
    if not condition:raise AssertionError(message)
def bounded():
    check(time.monotonic()<until,"Installed Memory UI exceeded its bounded lifetime")
def read(name):return json.loads((root/name).read_text())
def wait_file(name):
    stop=min(until,time.monotonic()+seconds)
    while time.monotonic()<stop:
        bounded()
        try:return read(name)
        except (FileNotFoundError,json.JSONDecodeError):time.sleep(.025)
    raise RuntimeError("Installed Memory UI file timed out: "+name)
def stage(name):
    stop=min(until,time.monotonic()+seconds)
    while time.monotonic()<stop:
        try:
            current=read("progress.json").get("stage")
            check(current!="failed","Parent installed workflow failed")
            if current==name:return
        except (FileNotFoundError,json.JSONDecodeError):pass
        time.sleep(.025);bounded()
    raise RuntimeError("Installed Memory UI stage timed out: "+name)
def publish(name,value):
    with (root/name).open("x") as output:json.dump(value,output)
def sha(value):check(isinstance(value,str) and re.fullmatch("[a-f0-9]{64}",value),"Expected exact SHA-256 identity");return value
try:
    c=wait_file("native-memory-ui-contract.json")
    check(c["schema"]=="pkm.installed-native-memory-ui/v1","Wrong installed Memory UI contract")
    check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Not a disposable installed driver")
    for key in ["profileSha256","sourcePlanSha256","sourceDatabaseSha256","sourceScopeSha256"]:sha(c[key])
    check(c["providerVendor"]=="pkm-native-memory-fixture","Wrong native fixture provider")
    check(c["modelLabel"]=="Synthetic installed Memory evidence model","Wrong native fixture model")
    check(c["modelId"].startswith("vscode:pkm-native-memory-fixture:"),"Wrong exact model ID")
    check(len(c["query"].encode())<=512 and len(c["query"])>0,"Invalid exact Memory query")
    check(hashlib.sha256(c["scope"].encode()).hexdigest()==c["sourceScopeSha256"],"Wrong exact Memory scope")
    for phase in ["off","missing","positive","revoke"]:
        q=c["requests"][phase]
        check(q["commandId"]=="installed-native-memory-"+phase,"Unexpected command identity")
        expected=hashlib.sha256(json.dumps([c["workspaceId"],q["commandId"]]).encode()).hexdigest()
        check(q["requestId"]==expected,"Wrong actual original request identity")
        check(re.fullmatch(r"pkm://chats/0123456789abcdef/[a-f0-9-]{36}",q["chatUrl"]),"Wrong original Chat locator")
        check(q["argumentsSha256"]==digest({"chatId":q["chatId"],"prompt":q["prompt"],"hardToolRoundLimit":1}),"Wrong request argument pin")
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
        pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
        check(len(pages)==1,"Exactly one installed workbench renderer is required")
        page=pages[0];page.wait_for_load_state("domcontentloaded",timeout=f["timeoutMs"])
        page.set_default_timeout(f["timeoutMs"])
        publish("native-memory-ui-ready.json",{"ready":True,"actualRenderer":True})
        def exact(locator,text):
            item=locator.get_by_text(text,exact=True)
            item.wait_for(state="visible",timeout=f["timeoutMs"])
            check(item.count()==1,"Expected unique normalized exact text: "+text)
            check(item.is_visible(),"Expected visible exact text: "+text)
            return item
        def modal(title,button,validate,click=True):
            bounded()
            dialogs=page.locator(".monaco-dialog-box:visible")
            dialogs.wait_for(state="visible",timeout=f["timeoutMs"])
            check(dialogs.count()==1,"Multiple native modals are not admissible")
            exact(dialogs,title)
            text=dialogs.inner_text().replace("\u00a0"," ")
            decoder=json.JSONDecoder();start=text.find("{")
            check(start>=0,"Native modal omitted structured exact-request details")
            data,_=decoder.raw_decode(text[start:])
            validate(data)
            selected=dialogs.get_by_role("button",name=button,exact=True)
            check(selected.count()==1 and selected.is_visible(),"Expected one exact native approval button")
            check(dialogs.get_by_role("button",name="Deny",exact=True).count()==1,"Native Deny option is missing")
            proof["dialogs"].append({"title":title,"button":button,"visibleTextSha256":hashlib.sha256(norm(text).encode()).hexdigest()})
            nodes=(dialogs.element_handle(),selected.element_handle()) if not click else (None,None)
            if click:selected.click()
            return dialogs,selected,data,hashlib.sha256(text.encode()).hexdigest(),nodes[0],nodes[1]
        def owner(data,profile=True):
            check(data.get("root")==c["sourceRoot"],"Native modal belongs to another Root")
            check(data.get("workspaceId")==c["workspaceId"],"Native modal belongs to another workspace")
            if profile:check(data.get("profileSha256")==c["profileSha256"],"Native modal belongs to another profile")
        def model_choice():
            widget=page.locator(".quick-input-widget:visible")
            widget.wait_for(state="visible")
            check(widget.count()==1,"Multiple native Quick Picks")
            exact(widget,"Choose an exact native model for this PKM Chat")
            row=widget.locator(".monaco-list-row").filter(has_text=c["modelLabel"])
            check(row.count()==1,"Exactly one synthetic native model row is required")
            exact(row,c["modelLabel"])
            check(c["modelId"] in norm(row.inner_text()),"Native model row omitted exact model identity")
            row.click()
        def memory_choice(phase):
            widget=page.locator(".quick-input-widget:visible");widget.wait_for(state="visible")
            check(widget.count()==1,"Multiple native Memory Quick Picks")
            exact(widget,"Native PKM Chat: explicitly select live Memory?")
            rows=widget.locator(".monaco-list-row")
            check(rows.count()==2,"Unknown native Memory choice")
            off="No live Memory recall (default)";live="Select live Memory for this exact request"
            exact(widget,off);exact(widget,live)
            label=off if phase=="off" else live
            row=rows.filter(has=page.get_by_text(label,exact=True))
            check(row.count()==1,"Memory selection is not unique")
            if phase=="missing":
                check("Independent same-owner Memory source admission is not available." in norm(row.inner_text()),"Missing-grant choice was not disclosed")
            elif phase!="off":check(norm(c["scope"]) in norm(row.inner_text()),"Wrong selected Memory scope")
            row.click();proof["choices"].append({"phase":phase,"label":label})
        def query():
            widget=page.locator(".quick-input-widget:visible");widget.wait_for(state="visible")
            check(widget.count()==1,"Multiple native query inputs")
            exact(widget,"Exact native Memory query")
            text=norm(widget.inner_text())
            check(norm(c["scope"]) in text and "1–512 UTF-8 bytes" in text and "at most 3 full confirmed records" in text,"Wrong bounded Memory query/scope prompt")
            field=widget.locator("input:visible")
            check(field.count()==1,"Expected one native Memory query input")
            field.fill(c["query"]);check(field.input_value()==c["query"],"Memory query was modified")
            field.press("Enter")
        def source(domain):
            def validate(data):
                check(data.get("noExecution") is True,"Source consent was not source-only")
                session=data["session"];binding=session["binding"]
                check(binding["root"]==c["sourceRoot"] and binding["workspaceId"]==c["workspaceId"],"Wrong signed source Root/workspace")
                check(binding["profileSha256"]==c["profileSha256"] and session["epoch"]==c["nativeEpoch"],"Wrong signed source profile/epoch")
                text=json.dumps(data,ensure_ascii=False)
                pins=[c["sourcePlanSha256"]] if domain=="chat" else [c["sourceDatabaseSha256"],c["sourceScopeSha256"]]
                for pin in pins:check(pin in text,"Native source modal omitted exact source digest")
                check("No old worker, Engine, queued execution" in data["permission"],"Native source permission changed")
            modal("Admit this exact original "+("API Chat" if domain=="chat" else "Memory")+" source?",
                "Admit this exact source only",validate)
        stage("native-memory-chat-source-admit");source("chat")
        inference_digests=set()
        for phase,phase_stage in [("off","native-memory-default-off"),("missing","native-memory-missing-grant"),
                                   ("positive","native-memory-positive"),("revoke","native-memory-revoke-pending")]:
            if phase=="positive":stage("native-memory-source-admit");source("memory")
            stage(phase_stage);q=c["requests"][phase];selection={};run={}
            def public(data):
                owner(data,False)
                check(data["operation"]=="mcp.tool.api_chat_send" and data["tool"]=="api_chat_send" and data["version"]==1 and data["readOnly"] is False,"Unexpected public operation")
                expected={"host_id":c["workspaceId"],"chat_id":q["chatId"],"prompt":q["prompt"],
                          "command_id":q["commandId"],"hard_tool_round_limit":1}
                check(data["arguments"]==expected and data["argumentsDigest"]==digest(expected),"Unexpected public Chat request")
            modal("Allow PKM v5 api_chat_send for this exact request?","Approve this request",public)
            model_choice()
            def bind(data):
                owner(data)
                check(data["requestId"]==q["requestId"] and data["chatUrl"]==q["chatUrl"] and data["sourcePlanSha256"]==c["sourcePlanSha256"],"Wrong Chat/model binding")
                check(data["model"]["id"]==c["modelId"] and data["model"]["nativeModelId"]==c["wireModelId"],"Wrong native model")
                value=data["selection"]
                check(value["protocol"]=="pkm.original-api-chat-execution/v1" and value["provider"]=="vscode" and value["epoch"]==c["nativeEpoch"],"Wrong native selection authority")
                check(value["modelId"]==c["modelId"] and value["wireModelId"]==c["wireModelId"],"Wrong selected model")
                selection.update(value)
            modal("Bind this exact native VS Code model to this PKM Chat?","Allow this native model request",bind)
            memory_choice(phase)
            if phase=="missing":continue
            memory_binding={"requestId":q["requestId"],"chatUrl":q["chatUrl"],"sourcePlanSha256":c["sourcePlanSha256"],
                "argumentsSha256":q["argumentsSha256"],"selection":selection,"draftSha256":None,
                "scope":None if phase=="off" else c["scope"],"proposedQuery":q["prompt"]}
            if phase!="off":
                query()
                def memory(data):
                    owner(data)
                    for key in ["requestId","chatUrl","sourcePlanSha256","argumentsSha256","selection","draftSha256","scope"]:
                        check(data.get(key)==memory_binding[key],"Wrong exact Memory binding: "+key)
                    check(data["query"]==c["query"] and data["limit"]==3 and data["bindingSha256"]==digest(memory_binding),"Wrong Memory query/limit/digest")
                modal("Use this independently admitted live Memory scope for this exact native Chat request?",
                    "Allow this native model request",memory)
            def select(data):
                owner(data);check(data["modelId"]==c["modelId"],"Wrong exact native selection");sha(data["catalogueSha256"])
            modal("Select this exact native VS Code model?","Allow this native model request",select)
            def send(data):
                owner(data)
                check(data["operation"]=="send" and data["requestId"]==q["requestId"] and data["commandId"]==q["commandId"],"Wrong native send identity")
                check(data["chatUrl"]==q["chatUrl"] and data["sourcePlanSha256"]==c["sourcePlanSha256"] and data["selection"]==selection,"Wrong native send binding")
                check(data["argumentsSha256"]==q["argumentsSha256"] and data["sourceUncertain"] is False,"Wrong native send arguments")
                live=data["liveMemory"]
                check(live["mode"]==("off" if phase=="off" else "live") and live["requestId"]==q["requestId"] and live["epoch"]==c["nativeEpoch"],"Wrong native Memory selection mode")
                check(live["bindingSha256"]==digest(memory_binding),"Wrong native Memory choice digest")
                if phase!="off":check(live["scope"]==c["scope"] and live["query"]==c["query"] and live["limit"]==3,"Wrong native Memory selection")
            modal("Send this exact request to the bound native PKM Chat?","Allow this native model request",send)
            def execution(data):
                owner(data)
                check(data["requestId"]==q["requestId"] and data["chatUrl"]==q["chatUrl"] and data["sourcePlanSha256"]==c["sourcePlanSha256"],"Wrong execution request")
                check(data["hardToolRoundLimit"]==1 and data["tools"]==["get_document"],"Unexpected tool/round authority")
                check(data["outputTokenCap"]==selection["outputTokenCap"] and data["budget"]["deadlineMs"]<=300000,"Unexpected execution policy")
                check(isinstance(data["selectionId"],str) and 0<len(data["selectionId"])<=512,"Missing native selection")
                sha(data["planSha256"]);run.update(data)
            modal("Run this native PKM Chat request with the displayed limits?","Allow this native model request",execution)
            def inference(data):
                check(data["root"]==c["sourceRoot"] and data["model"]==c["wireModelId"],"Wrong pending native inference")
                value=sha(data["requestSha256"])
                check(value not in inference_digests,"An inference modal was replayed")
                inference_digests.add(value)
            title="Send this inference to native VS Code model "+c["wireModelId"]+"?"
            dialog,button,data,text_pin,dialog_node,button_node=modal(title,"Approve this request",inference,phase!="revoke")
            if phase=="revoke":
                publish("native-memory-revoke-model-visible.json",{"visible":True,"actualNativeModal":True,
                    "requestSha256":data["requestSha256"],"requestId":q["requestId"]})
                revoked=wait_file("native-memory-revoked-before-click.json")
                check(revoked.get("revoked") is True,"No actual Memory revocation handshake")
                check(dialog_node.evaluate("(node)=>node.isConnected"),"The original pending modal node was replaced")
                check(button_node.evaluate("(node)=>node.isConnected"),"The original pending approval button was replaced")
                check(dialog.count()==1 and dialog.is_visible(),"The original pending modal disappeared")
                check(hashlib.sha256(dialog.inner_text().replace("\u00a0"," ").encode()).hexdigest()==text_pin,"The pending modal was replaced after revocation")
                exact(dialog,title);button_node.click()
                publish("native-memory-revoke-clicked.json",{"clicked":True,"samePendingModal":True})
            elif phase=="positive":
                def review(data):
                    check(data["root"]==c["sourceRoot"] and data["workspaceId"]==c["workspaceId"] and data["actorId"]=="mcp:external","Wrong Core tool-review actor")
                    check(data["context"]=={"turnId":q["requestId"],"contextDigest":run["planSha256"],"readOnly":True},"Wrong Core tool-review context")
                    check(data["record"]["tool"]=="knowledge.document.get" and data["record"]["arguments"]=={"id":"Entry"},"Unexpected Core tool proposal")
                    check(data["record"]["status"] in ["pending","awaiting_approval"] and data["argumentsDigest"]==digest({"id":"Entry"}),"Wrong Core tool review state")
                modal("Review native PKM execution knowledge.document.get","Approve this request",review)
                def tool(data):
                    check(data["root"]==c["sourceRoot"] and data["workspaceId"]==c["workspaceId"] and data["actorId"]=="mcp:external","Wrong native Core tool actor")
                    check(data["operation"]=="knowledge.document.get" and data["version"]==1 and data["arguments"]=={"id":"Entry"},"Unexpected native tool")
                    check(data["turnId"]==q["requestId"] and data["contextDigest"]==run["planSha256"] and data["readOnly"] is True,"Wrong native tool binding")
                    check(data["argumentsDigest"]==digest({"id":"Entry"}),"Wrong native tool arguments")
                modal("Allow native PKM tool knowledge.document.get?","Approve this request",tool)
                modal(title,"Approve this request",inference)
        stage("native-memory-complete")
        proof.update({"passed":True,"actualRenderedDom":True,"defaultOffExplicit":True,"missingSourceExplicitLiveChoice":True,
            "exactLiveScopeQuery":True,"samePendingInferenceApprovedOnlyAfterRevocation":True,
            "sourceRoot":c["sourceRoot"],"profileSha256":c["profileSha256"]})
        publish("native-memory-ui-passed.json",proof)
except Exception as error:
    try:publish("native-memory-ui-passed.json",{"failed":True,"error":str(error),"observed":proof})
    except Exception:pass
    raise
`;

/** The observer only targets a private installed fixture and never owns the editor. */
export async function startInstalledNativeMemoryUi({ root, python, env, port, timeoutMs = 120000 }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || !isAbsolute(python ?? "")
    || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw Object.assign(new Error("INSTALLED_MEMORY_UI_PRIVATE_LIMITS_REQUIRED"), { code: "INSTALLED_MEMORY_UI_PRIVATE_LIMITS_REQUIRED" });
  const child = spawn(python, ["-B", "-c", installedNativeMemoryUiProgram, JSON.stringify({ root, port, timeoutMs })],
    { env: { ...process.env, ...env, TMPDIR: root, TMP: root, TEMP: root, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Installed Memory UI exited ${code}/${signal}`)));
  });
  void done.catch(value => { error = value; });
  let closing;
  return Object.freeze({ done, get error() { return error; }, stop() {
    return closing ??= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await stopped; } finally { clearTimeout(timer); }
    })();
  } });
}
