import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

export const installedNativeTodoRoleObserverProgram = String.raw`
import hashlib,json,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);deadline=time.monotonic()+min(f["timeoutMs"]/1000*5,600)
def check(value,message):
    if not value:raise AssertionError(message)
def read(name):return json.loads((root/name).read_text())
def publish(name,value):
    with (root/name).open("x") as output:json.dump(value,output)
def alive():check(time.monotonic()<deadline,"Todo role observer exceeded its bounded lifetime")
try:
    while True:
        alive()
        try:c=read("native-todo-role-ui-contract.json");break
        except (FileNotFoundError,json.JSONDecodeError):time.sleep(.025)
    check(c["schema"]=="pkm.installed-native-todo-role-ui/v1" and c["noAutomaticHumanApproval"] is True,"Wrong role UI contract")
    stages=["native-todo-role-worker-deny","native-todo-role-worker-grant","native-todo-role-reviewer-grant",
            "native-todo-role-human-deny","native-todo-role-human-accept"]
    proof={"runId":c["runId"],"actualRenderedDom":True,"observerOnly":True,"clickedOrAnswered":False,"dialogs":[]}
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
        pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
        check(len(pages)==1,"Exactly one private workbench renderer is required")
        page=pages[0]
        publish("native-todo-role-ui-ready.json",{"runId":c["runId"],"ready":True,"actualRenderer":True,"observerOnly":True})
        seen=set()
        while len(seen)<len(stages):
            alive()
            try:stage=read("progress.json")["stage"]
            except (FileNotFoundError,json.JSONDecodeError):time.sleep(.025);continue
            check(stage!="failed","Parent role workflow failed")
            if stage not in stages or stage in seen:time.sleep(.025);continue
            dialog=page.locator(".monaco-dialog-box:visible")
            if dialog.count()!=1:time.sleep(.025);continue
            text=dialog.inner_text().replace("\u00a0"," ")
            human="human-" in stage
            title="Accept this exact completed workitem as the human?" if human else "Run this exact timed Chat role for this Todo workitem?"
            if title not in text:time.sleep(.025);continue
            start=text.find("{");check(start>=0,"Todo native modal omitted structured identity")
            data,_=json.JSONDecoder().raw_decode(text[start:])
            for key,expected in [("root",c["sourceRoot"]),("workspaceId",c["workspaceId"]),("profileSha256",c["profileSha256"]),
                                 ("nativeEpoch",c["nativeEpoch"]),("boardSlug",c["boardSlug"]),("workItemId",c["workItemId"])]:
                check(data[key]==expected,"Wrong rendered role binding: "+key)
            check(data["defaultDecision"]=="deny","Native role/human modal must default Deny")
            buttons=dialog.get_by_role("button").all_text_contents()
            check(buttons and buttons[0].strip()=="Deny","Deny must be the first native decision")
            if human:
                check(data["actorId"]=="user:local" and data["item"]["state"]=="Done" and "acceptanceDecision" not in data["item"],"Wrong human target")
                check(data["worker"]["actorId"]=="chat:"+c["workerChatId"] and data["reviewer"]["actorId"]=="chat:"+c["reviewerChatId"],"Wrong actual worker/reviewer principals")
                check("not this human decision" in data["permission"],"Task grant silently became acceptance")
            else:
                role="reviewer" if "reviewer-" in stage else "worker"
                check(data["role"]==role and data["actorId"]=="chat:"+c[role+"ChatId"],"Wrong rendered Chat role")
                check(data["modelId"]==c["wireModelId"],"Wrong actual role model")
                check("No reviewerIds delegation" in data["permission"] and "comment only" in data["permission"],"Role gained reviewer/user authority")
            record={"stage":stage,"requestSha256":data["requestSha256"],"defaultDenyVisible":True,
                    "actorId":data["actorId"],"visibleTextSha256":hashlib.sha256(text.encode()).hexdigest()}
            proof["dialogs"].append(record);seen.add(stage)
            publish("native-todo-role-modal-"+stage+".json",{"runId":c["runId"],"observed":True,"observerOnly":True,**record})
        while True:
            alive()
            try:stage=read("progress.json")["stage"]
            except (FileNotFoundError,json.JSONDecodeError):time.sleep(.025);continue
            check(stage!="failed","Parent role workflow failed")
            if stage=="native-todo-role-human-accept-done":break
            time.sleep(.025)
        proof["passed"]=True
        publish("native-todo-role-ui-passed.json",proof)
except Exception as error:
    try:publish("native-todo-role-ui-failed.json",{"failed":True,"error":str(error)})
    except FileExistsError:pass
    raise
`;

/** Read-only DOM observer. Parent owns real choices; this program never clicks or supplies human/model answers. */
export async function startInstalledNativeTodoRoleObserver({ root, python, env, port, timeoutMs = 120000 }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root || !stat.isDirectory()
    || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root))
    || typeof python !== "string" || !python || !Number.isInteger(port) || port < 1 || port > 65535
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new Error("INSTALLED_TODO_ROLE_PRIVATE_OBSERVER_REQUIRED");
  const child = spawn(python, ["-I", "-B", "-c", installedNativeTodoRoleObserverProgram,
    JSON.stringify({ root, port, timeoutMs })], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let error, output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output = (output + bytes).slice(-16384); });
  const done = new Promise((resolve, reject) => {
    child.once("error", failure => { error = failure; reject(failure); });
    child.once("exit", code => {
      if (code === 0) resolve();
      else { error = new Error(`Actual Todo role observer failed (${code}): ${output}`); reject(error); }
    });
  });
  void done.catch(() => {});
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
