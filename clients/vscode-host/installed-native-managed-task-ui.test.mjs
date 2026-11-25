import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { startInstalledNativeManagedTaskUi } from "./installed-native-managed-task-ui.mjs";
import { installedNativeManagedTaskProposals } from "./installed-native-managed-task-provider.mjs";

// Real Chromium/CDP/DOM mechanics only; this deliberately synthetic workbench is not VS Code/native qualification.
assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1");
const python = execFileSync(process.env.PKM_TEST_PYTHON ?? "python", ["-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const hash = value => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = value => hash(canonical(value));
async function wait(path) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    try { return JSON.parse(await readFile(path)); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Managed Task DOM fixture timed out: ${path}`);
}
async function endpoint() {
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function fixture(root) {
  const runId = randomUUID(), c = { schema: "pkm.installed-native-managed-task-ui/v1", runId, sourceRoot: `${root}/library`,
    workspaceId: randomUUID(), nativeEpoch: randomUUID(), profileSha256: "a".repeat(64), sourcePlanSha256: "b".repeat(64),
    providerVendor: "pkm-native-managed-task-fixture", modelLabel: "Synthetic installed managed Task evidence model",
    modelId: "vscode:pkm-native-managed-task-fixture:managed-task-fixture", wireModelId: "managed-task-fixture", creations: {} };
  const requestId = commandId => hash(JSON.stringify([c.workspaceId, commandId]).replace(",", ", "));
  for (const name of ["main", "cancel", "stale"]) {
    const commandId = `installed-managed-task-create-${name}-${runId}`;
    c.creations[name] = { commandId, requestId: requestId(commandId), title: `Installed native managed Task ${name}` };
  }
  const files = {}, ids = Object.fromEntries(["main", "cancel", "stale", "archive"].map(name => [name, randomUUID()]));
  for (const name of ["archive", "deny", "plain", "followup", "cancel", "stale"]) {
    const chatId = ids[["deny", "plain", "followup"].includes(name) ? "main" : name], commandId = `installed-managed-task-${name}-${runId}`;
    const prompt = `${name === "followup" ? "Continue" : "Start a new task:"} exact synthetic DOM ${name}`;
    const q = { name, commandId, requestId: requestId(commandId), chatId, chatUrl: `pkm://chats/0123456789abcdef/${chatId}`, prompt, hardToolRoundLimit: 5 };
    q.argumentsSha256 = digest({ chatId, prompt, hardToolRoundLimit: 5 });
    files[`native-managed-task-request-${name}.json`] = q;
    if (!["archive", "deny"].includes(name)) {
      const binding = { schema: "pkm.original-native-task-execution/v1", taskId: `agent_session_${randomUUID().replaceAll("-", "")}`,
        attemptId: randomUUID(), inputId: randomUUID(), replyId: randomUUID(), requestId: q.requestId, chatId,
        sourcePlanSha256: c.sourcePlanSha256, nativeEpoch: c.nativeEpoch };
      const goal = { objective: "Start a new task: exact synthetic DOM plain", attemptInputId: binding.inputId,
        sourceInputIds: [...(name === "followup" ? [randomUUID()] : []), binding.inputId],
        acceptance: [{ criterion: "The original user objective and all subsequent requirements are satisfied." }] };
      files[`native-managed-task-binding-${name}.json`] = { managedTask: binding, goal, chatRevision: 2, planSha256: digest({ name }),
        tools: ["get_document", "session_info", "report_work", "record_harness"], proposals: installedNativeManagedTaskProposals(binding, goal) };
    }
  }
  const commandId = `installed-managed-task-cancel-owned-${runId}`;
  files["native-managed-task-cancel-command.json"] = { commandId, requestId: requestId(commandId), chatId: ids.cancel,
    chatUrl: `pkm://chats/0123456789abcdef/${ids.cancel}`, argumentsSha256: digest({ chatId: ids.cancel }) };
  const list = [], allow = "Allow this native model request", owner = { root: c.sourceRoot, workspaceId: c.workspaceId, profileSha256: c.profileSha256 };
  let stage;
  const modal = (title, data, button = allow) => list.push({ stage, type: "modal", title, data, button });
  const public_ = (tool, args) => modal(`Allow PKM v5 ${tool} for this exact request?`,
    { ...owner, operation: `mcp.tool.${tool}`, tool, version: 1, readOnly: false, arguments: args, argumentsDigest: digest(args) }, "Approve this request");
  const selection = { protocol: "pkm.original-api-chat-execution/v1", provider: "vscode", epoch: c.nativeEpoch,
    modelId: c.modelId, wireModelId: c.wireModelId, permissionMode: "protective", outputTokenCap: 8192,
    budget: { maxInputTokens: 200000, maxTotalOutputTokens: 32768, deadlineMs: 300000 } };
  const bind = (q, chatUrl) => modal("Bind this exact native VS Code model to this PKM Chat?", { ...owner,
    requestId: q.requestId, chatUrl, sourcePlanSha256: c.sourcePlanSha256,
    model: { id: c.modelId, nativeModelId: c.wireModelId }, selection });
  const sendPublic = q => public_("api_chat_send", { host_id: c.workspaceId, chat_id: q.chatId, prompt: q.prompt,
    command_id: q.commandId, hard_tool_round_limit: 5 });
  function create(name) {
    stage = `native-managed-task-create-${name}`; const q = c.creations[name];
    public_("api_chat_create", { host_id: c.workspaceId, title: q.title, command_id: q.commandId, model_id: "" });
    list.push({ stage, type: "pick", title: "Choose an exact model for this PKM Chat", label: c.modelLabel, detail: c.modelId });
    bind(q, null);
    modal("Create this native PKM Chat with the selected model?", { ...owner, operation: "create", requestId: q.requestId,
      commandId: q.commandId, chatUrl: null, selection, sourcePlanSha256: c.sourcePlanSha256, sourceUncertain: false,
      argumentsSha256: digest({ title: q.title, modelId: "" }) });
  }
  function send(name) {
    const q = files[`native-managed-task-request-${name}.json`]; sendPublic(q);
    modal("Select this exact native VS Code model?", { ...owner, modelId: c.modelId, catalogueSha256: "c".repeat(64) });
    sendPublic(q); bind(q, q.chatUrl);
    modal("Send this exact request to the bound native PKM Chat?", { ...owner, operation: "send", requestId: q.requestId,
      commandId: q.commandId, chatUrl: q.chatUrl, sourcePlanSha256: c.sourcePlanSha256, selection, sourceUncertain: false,
      argumentsSha256: q.argumentsSha256 }, name === "deny" ? "Deny" : allow);
    if (name !== "deny") {
      const b = files[`native-managed-task-binding-${name}.json`];
      modal("Run this native PKM Chat request with the displayed limits?", { ...owner, requestId: q.requestId, chatUrl: q.chatUrl,
        sourcePlanSha256: c.sourcePlanSha256, planSha256: b.planSha256, tools: b.tools, hardToolRoundLimit: 5,
        outputTokenCap: 8192, budget: selection.budget, managedTask: b.managedTask });
    }
  }
  const inference = () => modal(`Send this inference to native VS Code model ${c.wireModelId}?`,
    { root: c.sourceRoot, model: c.wireModelId, requestSha256: digest({ unique: randomUUID() }) }, "Approve this request");
  stage = "native-managed-task-chat-source";
  modal("Admit this exact original API Chat source?", { noExecution: true, session: { epoch: c.nativeEpoch,
    binding: { root: c.sourceRoot, workspaceId: c.workspaceId, profileSha256: c.profileSha256 } },
    request: { sourcePlanSha256: c.sourcePlanSha256 }, permission: "No old worker, Engine, queued execution authority is inherited." }, "Admit this exact source only");
  stage = "native-managed-task-archive-refuse"; sendPublic(files["native-managed-task-request-archive.json"]);
  create("main");
  stage = "native-managed-task-start-deny"; send("deny");
  stage = "native-managed-task-start-plain"; send("plain"); inference(); inference();
  stage = "native-managed-task-followup"; send("followup");
  const q = files["native-managed-task-request-followup.json"], b = files["native-managed-task-binding-followup.json"];
  for (const proposal of b.proposals) {
    inference();
    const readOnly = proposal.operation === "knowledge.document.get", args = { ...proposal.arguments, ...(!readOnly ? { operationId: randomUUID() } : {}) };
    modal(`Review native PKM execution ${proposal.operation}`, { root: c.sourceRoot, workspaceId: c.workspaceId, actorId: "mcp:external",
      context: { turnId: q.requestId, contextDigest: b.planSha256, readOnly }, record: { tool: proposal.operation, arguments: args, status: "pending" },
      argumentsDigest: digest(args) }, "Approve this request");
    modal(`Allow native PKM tool ${proposal.operation}?`, { root: c.sourceRoot, workspaceId: c.workspaceId, actorId: "mcp:external",
      operation: proposal.operation, version: 1, arguments: args, argumentsDigest: digest(args),
      turnId: q.requestId, contextDigest: b.planSha256, readOnly }, "Approve this request");
  }
  inference(); stage = "native-managed-task-followup-replay"; sendPublic(q);
  create("cancel");
  stage = "native-managed-task-run-cancel"; send("cancel"); inference();
  stage = "native-managed-task-cancel-owned";
  const cancel = files["native-managed-task-cancel-command.json"];
  public_("api_chat_cancel", { host_id: c.workspaceId, chat_id: cancel.chatId, command_id: cancel.commandId });
  modal("Cancel this exact owned native PKM Chat request?", { ...owner, operation: "cancel", requestId: cancel.requestId,
    commandId: cancel.commandId, chatUrl: cancel.chatUrl, selection: null, sourcePlanSha256: c.sourcePlanSha256,
    argumentsSha256: cancel.argumentsSha256, sourceUncertain: false });
  create("stale"); stage = "native-managed-task-stale-pending"; send("stale"); inference();
  return { c, files, actions: list };
}
const html = `<!doctype html><meta charset="utf-8"><body><script>
window.actions=[];window.index=0;window.events=[];
function text(tag,value){const e=document.createElement(tag);e.textContent=value;return e;}
function advance(value){events.push({index,title:actions[index].title,value});index++;render();}
function render(){document.body.replaceChildren();const a=actions[index];if(!a)return;
const box=document.createElement("div");box.className=a.type==="modal"?"monaco-dialog-box":"quick-input-widget";
box.append(text("div",a.title));document.body.append(box);
if(a.type==="modal"){box.append(text("pre",JSON.stringify(a.data,null,2)));
for(const name of [a.button==="Deny"?"Allow this native model request":a.button,"Deny"]){const b=text("button",name);b.onclick=()=>advance(name);box.append(b);}}
else{const row=document.createElement("div");row.className="monaco-list-row";
row.append(text("div",a.label),text("div",a.detail));row.onclick=()=>advance(a.label);box.append(row);}}
</script>`;
const browserProgram = String.raw`
import json,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"])
with sync_playwright() as p:
    context=p.chromium.launch_persistent_context(str(Path(f["artifacts"])/"profile"),headless=True,
        args=["--remote-debugging-port="+str(f["port"]),"--remote-debugging-address=127.0.0.1",
              "--proxy-server=http://127.0.0.1:1","--proxy-bypass-list=127.0.0.1"])
    page=context.pages[0];page.goto((root/"workbench.html").as_uri());page.wait_for_load_state("networkidle")
    page.evaluate("value=>{window.actions=value;window.render();}",f["actions"])
    (root/"browser-ready.json").write_text('{"ready":true}');last=-1;until=time.monotonic()+35
    while time.monotonic()<until and not (root/"browser-stop.json").exists():
        index=page.evaluate("window.index")
        if index!=last:
            stage=f["actions"][index]["stage"] if index<len(f["actions"]) else "native-managed-task-source-revoke"
            (root/"progress.json").write_text(json.dumps({"stage":stage}));last=index
            (root/"dom-events.json").write_text(json.dumps(page.evaluate("window.events")))
        if (root/"native-managed-task-stale-visible.json").exists() and not (root/"native-managed-task-stale-committed.json").exists():
            assert index==len(f["actions"])-1
            time.sleep(.15);assert page.evaluate("window.index")==index
            if f["replacePending"]:page.evaluate("window.render()")
            (root/"native-managed-task-stale-committed.json").write_text(json.dumps(f["committed"]))
        if (root/"native-managed-task-source-revoke-visible.json").exists():
            (root/"progress.json").write_text('{"stage":"native-managed-task-complete"}')
        time.sleep(.015)
    context.close()
`;
async function run(t, mutate, replacePending = false) {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`), artifacts = resolve(`.mtb-${randomUUID().slice(0, 5)}`);
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(artifacts, { mode: 0o700 });
  const value = fixture(root); mutate?.(value);
  for (const [name, contents] of Object.entries(value.files)) await writeFile(join(root, name), JSON.stringify(contents));
  await writeFile(join(root, "native-managed-task-ui-contract.json"), JSON.stringify(value.c));
  await writeFile(join(root, "workbench.html"), html);
  const port = await endpoint(), env = { ...process.env, TMPDIR: artifacts, TMP: artifacts, TEMP: artifacts, PYTHONDONTWRITEBYTECODE: "1" };
  const child = spawn(python, ["-B", "-c", browserProgram, JSON.stringify({ root, artifacts, port, actions: value.actions, replacePending,
    committed: { committed: true, beforeRevision: 2, afterRevision: 3, operationId: randomUUID(), messageId: randomUUID() } })], { env, stdio: "inherit" });
  const childDone = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Task DOM browser exited ${code}`)));
  });
  void childDone.catch(() => {});
  let observer;
  t.after(async () => {
    try { await observer?.stop(); await writeFile(join(root, "browser-stop.json"), "{}"); await childDone; }
    finally { await rm(root, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); }
  });
  await wait(join(root, "browser-ready.json"));
  observer = await startInstalledNativeManagedTaskUi({ root, python, env, port, runId: value.c.runId, timeoutMs: 4000 });
  return { root, value, observer };
}
test("Task renderer handles exact fresh-create/start/Harness/cancel stages and the same pending stale-inference node", { timeout: 45000 }, async t => {
  const f = await run(t); await f.observer.done;
  const proof = await wait(join(f.root, "native-managed-task-ui-passed.json"));
  assert.equal(proof.actualRenderedDom, true); assert.equal(proof.sameStaleModalClickedAfterCommit, true);
  assert.equal(proof.choices.length, 3);
  const events = await wait(join(f.root, "dom-events.json"));
  assert.equal(events.length, f.value.actions.length);
  assert.equal(events.filter(event => event.value === "Deny").length, 1);
});
test("Task renderer refuses a familiar model label with another native ID under the provider-neutral picker", { timeout: 45000 }, async t => {
  const f = await run(t, value => {
    value.actions.find(action => action.type === "pick").detail = "vscode:another-provider:unapproved-model";
  });
  await assert.rejects(f.observer.done);
  const proof = await wait(join(f.root, "native-managed-task-ui-passed.json"));
  assert.match(proof.error, /Wrong exact registered Task model row/);
  assert.equal(proof.observed.choices.length, 0);
  const events = await wait(join(f.root, "dom-events.json"));
  assert.equal(events.length, f.value.actions.findIndex(action => action.type === "pick"));
});
test("Task renderer refuses a familiar source modal for another Root before any click", { timeout: 45000 }, async t => {
  const f = await run(t, value => { value.actions[0].data.session.binding.root = "/another-library"; });
  await assert.rejects(f.observer.done);
  assert.match((await wait(join(f.root, "native-managed-task-ui-passed.json"))).error, /Wrong signed source Root/);
  assert.deepEqual(await wait(join(f.root, "dom-events.json")), []);
});
test("Task renderer rejects an identical-text replacement of the pending inference instead of approving it", { timeout: 45000 }, async t => {
  const f = await run(t, undefined, true);
  await assert.rejects(f.observer.done);
  assert.match((await wait(join(f.root, "native-managed-task-ui-passed.json"))).error, /original pending modal node was replaced/);
  assert.equal((await wait(join(f.root, "dom-events.json"))).length, f.value.actions.length - 1);
});
