import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export const installedNativeKnowledgeMoveUiProgram = String.raw`
import hashlib,json,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000
until=time.monotonic()+min(seconds*4,360)
proof={"schema":"pkm.installed-native-knowledge-move-ui-evidence/v1","runId":f["runId"],"dialogs":[]}
def check(ok,message):
 if not ok:raise AssertionError(message)
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def stage(name):
 stop=min(until,time.monotonic()+seconds)
 while time.monotonic()<stop:
  try:
   current=json.loads((root/"progress.json").read_text()).get("stage")
   check(current!="failed","Parent installed workflow failed")
   if current==name:return
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Knowledge move UI stage timed out: "+name)
def publish(name,value):
 with (root/name).open("x") as output:json.dump(value,output)
try:
 check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Not a private disposable installed driver")
 c=json.loads((root/"native-knowledge-move-ui-contract.json").read_text())
 check(c["schema"]=="pkm.installed-native-knowledge-move-ui/v1" and c["runId"]==f["runId"],"Wrong Knowledge move UI contract/run")
 check(len(c["steps"])==6,"Only the bounded six mutation dialogs are supported")
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
  pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
  check(len(pages)==1,"Exactly one installed workbench renderer is required")
  page=pages[0];page.set_default_timeout(f["timeoutMs"]);page.wait_for_load_state("networkidle")
  publish("native-knowledge-move-ui-ready.json",{"ready":True,"actualRenderedDom":True,"runId":f["runId"]})
  for step in c["steps"]:
   stage(step["stage"])
   dialog=page.locator(".monaco-dialog-box:visible");dialog.wait_for(state="visible")
   check(dialog.count()==1,"Multiple native modals cannot qualify exact request consent")
   title="Allow PKM v5 "+step["tool"]+" for this exact request?"
   exact=dialog.get_by_text(title,exact=True)
   check(exact.count()==1 and exact.is_visible(),"Wrong exact Knowledge move modal title")
   handle=dialog.element_handle();text=dialog.inner_text().replace("\u00a0"," ");start=text.find("{")
   check(start>=0,"Mutation dialog omitted exact structured request")
   data,_=json.JSONDecoder().raw_decode(text[start:])
   check(data["root"]==c["binding"]["root"] and data["workspaceId"]==c["binding"]["workspaceId"],"Wrong native source Root/workspace")
   check(data["tool"]==step["tool"] and data["operation"]=="mcp.tool."+step["tool"]
     and data["version"]==1 and data["readOnly"] is False,"Wrong captured mutation classification")
   check(data["arguments"]==step["arguments"] and data["argumentsDigest"]==digest(step["arguments"]),"Wrong exact move arguments/digest")
   check("Private marker" not in text and "Private/Secret" not in text,"Private referrers leaked into public approval")
   button=dialog.get_by_role("button",name=step["choice"],exact=True)
   check(button.count()==1 and button.is_visible() and button.is_enabled(),"Missing unique enabled native choice")
   check(dialog.get_by_role("button",name="Deny",exact=True).count()==1,"Native Deny choice is absent")
   check(handle.evaluate("(node)=>node.isConnected"),"Validated native modal was replaced")
   check(dialog.evaluate("(node,original)=>node===original",handle),"Validated native modal node changed")
   check(dialog.inner_text().replace("\u00a0"," ")==text,"Validated native request changed before its choice")
   proof["dialogs"].append({"stage":step["stage"],"choice":step["choice"],"title":title,
     "argumentsDigest":data["argumentsDigest"],"visibleTextSha256":hashlib.sha256(text.encode()).hexdigest(),"exactRequestVisible":True})
   button.click()
  stage("native-knowledge-move-complete")
  check(page.locator(".monaco-dialog-box:visible").count()==0,"Unexpected extra modal after bounded Knowledge moves")
  proof.update(passed=True,actualRenderedDom=True,attachmentRevoked=False)
  publish("native-knowledge-move-ui-passed.json",proof)
except Exception as error:
 try:publish("native-knowledge-move-ui-passed.json",{"failed":True,"runId":f["runId"],"error":str(error),"observed":proof})
 except Exception:pass
 raise
`;

export function installedKnowledgeMoveUiProgramFor(profile) {
  if (profile === "paired") return installedNativeKnowledgeMoveUiProgram;
  if (profile !== "legacy-unshared") throw new Error("Unsupported installed Knowledge move observer profile.");
  return installedNativeKnowledgeMoveUiProgram.replaceAll("native-knowledge-move", "native-legacy-assets-move")
    .replace('len(c["steps"])==6', 'len(c["steps"])==7').replace("bounded six mutation dialogs", "bounded seven mutation dialogs");
}
export async function startInstalledNativeKnowledgeMoveUi(args) {
  return startInstalledKnowledgeMoveUiProfile({ ...args, profile: "paired" });
}
export async function startInstalledKnowledgeMoveUiProfile({ root, python, env, port, runId, timeoutMs = 120000, profile }) {
  const program = installedKnowledgeMoveUiProgramFor(profile);
  const prefix = profile === "paired" ? "native-knowledge-move" : "native-legacy-assets-move";
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || typeof python !== "string" || !isAbsolute(python) || !/^[a-f0-9-]{36}$/.test(runId))
    throw Object.assign(new Error("INSTALLED_KNOWLEDGE_MOVE_PRIVATE_UI_REQUIRED"), { code: "INSTALLED_KNOWLEDGE_MOVE_PRIVATE_UI_REQUIRED" });
  const child = spawn(python, ["-B", "-c", program, JSON.stringify({ root, port, runId, timeoutMs })],
    { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Installed Knowledge move UI exited ${code}/${signal}`)));
  });
  void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (error) throw error;
      try {
        const value = JSON.parse(await readFile(join(root, `${prefix}-ui-ready.json`)));
        if (value.ready !== true || value.runId !== runId || value.actualRenderedDom !== true)
          throw new Error("Wrong Knowledge move renderer readiness.");
        return value;
      } catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Knowledge move renderer readiness timed out.");
  })();
  void ready.catch(() => {});
  return { done, ready, get error() { return error; },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await ended; } finally { clearTimeout(timer); }
    },
  };
}
