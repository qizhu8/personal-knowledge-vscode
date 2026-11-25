import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

export const installedNativeTodoAssignmentUiProgram = String.raw`
import hashlib,json,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000
until=time.monotonic()+min(seconds*4,360);proof={"dialogs":[],"choices":[],"runId":f["runId"]}
def check(ok,message):
    if not ok:raise AssertionError(message)
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def bounded():check(time.monotonic()<until,"Installed assignment UI exceeded its bounded lifetime")
def read(name):return json.loads((root/name).read_text())
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
    raise RuntimeError("Installed assignment UI stage timed out: "+name)
def publish(name,value):
    with (root/name).open("x") as output:json.dump(value,output)
try:
    c=read("native-todo-assignment-ui-contract.json")
    check(c["runId"]==f["runId"],"Wrong assignment UI run")
    check(c["schema"]=="pkm.installed-native-todo-assignment-ui/v1","Wrong assignment UI contract")
    check(c["providerVendor"]=="pkm-native-fixture" and c["modelLabel"]=="Synthetic native protocol fixture","Wrong native fixture")
    check(c["modelId"].startswith("vscode:pkm-native-fixture:"),"Wrong exact registered model")
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
        pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
        check(len(pages)==1,"Exactly one installed workbench renderer is required")
        page=pages[0];page.set_default_timeout(f["timeoutMs"])
        publish("native-todo-assignment-ui-ready.json",{"ready":True,"actualRenderer":True,"runId":f["runId"]})
        def exact(locator,text):
            item=locator.get_by_text(text,exact=True);item.wait_for(state="visible")
            check(item.count()==1,"Expected unique exact visible text: "+text)
            return item
        def modal(title,button,validate):
            bounded();dialog=page.locator(".monaco-dialog-box:visible");dialog.wait_for(state="visible")
            check(dialog.count()==1,"Multiple native modals");exact(dialog,title)
            text=dialog.inner_text().replace("\u00a0"," ");start=text.find("{")
            check(start>=0,"Native modal omitted exact structured details")
            data,_=json.JSONDecoder().raw_decode(text[start:]);validate(data)
            selected=dialog.get_by_role("button",name=button,exact=True)
            check(selected.count()==1 and selected.is_visible(),"Expected exact native approval/denial choice")
            proof["dialogs"].append({"title":title,"choice":button,"visibleTextSha256":hashlib.sha256(text.encode()).hexdigest()})
            selected.click();return data
        def owner(data,profile=True):
            check(data["root"]==c["sourceRoot"] and data["workspaceId"]==c["workspaceId"],"Wrong native owner/workspace")
            if profile:check(data["profileSha256"]==c["profileSha256"],"Wrong native profile")
        def source(domain):
            def validate(data):
                check(data["noExecution"] is True,"Source admission granted execution")
                signed=data["session"]
                check(signed["epoch"]==c["nativeEpoch"] and signed["binding"]["root"]==c["sourceRoot"],"Wrong signed source owner/epoch")
                check(signed["binding"]["profileSha256"]==c["profileSha256"],"Wrong signed source profile")
                request=data["request"];owner(request)
                pins=[c["sourcePlanSha256"]] if domain=="chat" else [c["boardSha256"],c["noteSha256"]]
                for pin in pins:check(pin in json.dumps(request),"Source modal omitted pinned source identity")
                check("No old worker, Engine, queued execution" in data["permission"],"Source scope changed")
            modal("Admit this exact original "+("API Chat" if domain=="chat" else "Todo")+" source?",
                "Admit this exact source only",validate)
        stage("native-todo-assignment-todo-source");source("todo")
        stage("native-todo-assignment-chat-source");source("chat")
        for phase in ["deny","bind"]:
            stage("native-todo-assignment-chat-"+phase);q=c["requests"][phase];selection={}
            check(q["chatUrl"]==c["chatUrl"] and q["chatId"]==c["chatId"],"Replacement original UUID/URL")
            expected=hashlib.sha256(json.dumps([c["workspaceId"],q["commandId"]]).encode()).hexdigest()
            check(q["requestId"]==expected,"Wrong actual original command identity")
            def public(data):
                owner(data,False)
                expected={"host_id":c["workspaceId"],"chat_id":c["chatId"],"prompt":q["prompt"],
                          "command_id":q["commandId"],"hard_tool_round_limit":1}
                check(data["operation"]=="mcp.tool.api_chat_send" and data["tool"]=="api_chat_send" and data["readOnly"] is False,"Wrong public request")
                check(data["arguments"]==expected and data["argumentsDigest"]==digest(expected),"Wrong exact public arguments")
            modal("Allow PKM v5 api_chat_send for this exact request?","Approve this request",public)
            widget=page.locator(".quick-input-widget:visible");widget.wait_for(state="visible")
            exact(widget,"Choose an exact native model for this PKM Chat")
            row=widget.locator(".monaco-list-row").filter(has_text=c["modelLabel"])
            check(row.count()==1,"Exact fixture model row is not unique")
            check(c["modelId"] in row.inner_text(),"Model row omitted exact model ID")
            row.click()
            def bind(data):
                owner(data)
                check(data["requestId"]==q["requestId"] and data["chatUrl"]==c["chatUrl"]
                    and data["sourcePlanSha256"]==c["sourcePlanSha256"],"Wrong original source/Chat binding")
                check(data["model"]["id"]==c["modelId"] and data["model"]["nativeModelId"]==c["wireModelId"],"Wrong native model")
                value=data["selection"]
                check(value["protocol"]=="pkm.original-api-chat-execution/v1" and value["provider"]=="vscode"
                    and value["epoch"]==c["nativeEpoch"],"Wrong native selection authority")
                selection.update(value)
            modal("Bind this exact native VS Code model to this PKM Chat?",
                "Deny" if phase=="deny" else "Allow this native model request",bind)
            if phase=="deny":continue
            widget=page.locator(".quick-input-widget:visible");widget.wait_for(state="visible")
            exact(widget,"Native PKM Chat: explicitly select live Memory?")
            label="No live Memory recall (default)"
            row=widget.locator(".monaco-list-row").filter(has=page.get_by_text(label,exact=True))
            check(row.count()==1,"Default-off Memory choice is not unique");row.click()
            proof["choices"].append({"memory":"off","exactModelId":c["modelId"]})
            def selected(data):
                owner(data);check(data["modelId"]==c["modelId"],"Wrong selected native model")
            modal("Select this exact native VS Code model?","Allow this native model request",selected)
            def send(data):
                owner(data)
                check(data["operation"]=="send" and data["requestId"]==q["requestId"] and data["commandId"]==q["commandId"],"Wrong native send identity")
                check(data["chatUrl"]==c["chatUrl"] and data["sourcePlanSha256"]==c["sourcePlanSha256"]
                    and data["selection"]==selection and data["sourceUncertain"] is False,"Wrong native send binding")
                check(data["argumentsSha256"]==q["argumentsSha256"],"Wrong request argument digest")
                check(data["liveMemory"]["mode"]=="off","Assignment fixture must not admit or recall live Memory")
            modal("Send this exact request to the bound native PKM Chat?","Allow this native model request",send)
            def execution(data):
                owner(data)
                check(data["requestId"]==q["requestId"] and data["chatUrl"]==c["chatUrl"]
                    and data["sourcePlanSha256"]==c["sourcePlanSha256"],"Wrong exact native execution")
                check(data["tools"]==["get_document"] and data["hardToolRoundLimit"]==1,"Unexpected tool catalogue/round authority")
                check(data["outputTokenCap"]<=8192 and data["budget"]["deadlineMs"]<=300000,"Unbounded native execution")
            modal("Run this native PKM Chat request with the displayed limits?","Allow this native model request",execution)
            def inference(data):
                check(data["root"]==c["sourceRoot"] and data["model"]==c["wireModelId"],"Wrong native inference")
                check(len(data["requestSha256"])==64,"Missing exact inference pin")
            modal("Send this inference to native VS Code model "+c["wireModelId"]+"?","Approve this request",inference)
        stage("native-todo-assignment-complete")
        check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected extra approval after the bounded assignment path")
        proof.update({"passed":True,"actualNativeUi":True,"sourceRoot":c["sourceRoot"],"profileSha256":c["profileSha256"],
            "originalChatUrl":c["chatUrl"],"modelBindingDeniedThenApproved":True,"liveMemoryDefaultOff":True,
            "commercialProviderQualified":False,"separateAssignmentModalClaimed":False})
        publish("native-todo-assignment-ui-passed.json",proof)
except Exception as error:
    try:publish("native-todo-assignment-ui-passed.json",{"failed":True,"runId":f["runId"],"error":str(error),"observed":proof})
    except Exception:pass
    raise
`;

export async function startInstalledNativeTodoAssignmentUi({ root, python, env, port, runId, timeoutMs = 120000 }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !/^[a-f0-9-]{36}$/.test(runId)
    || typeof python !== "string" || !python)
    throw Object.assign(new Error("INSTALLED_TODO_ASSIGNMENT_PRIVATE_UI_REQUIRED"), { code: "INSTALLED_TODO_ASSIGNMENT_PRIVATE_UI_REQUIRED" });
  const child = spawn(python, ["-B", "-c", installedNativeTodoAssignmentUiProgram, JSON.stringify({ root, port, runId, timeoutMs })],
    { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Installed assignment UI exited ${code}/${signal}`)));
  });
  void done.catch(value => { error = value; });
  return {
    done, get error() { return error; },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await ended; } finally { clearTimeout(timer); }
    },
  };
}
