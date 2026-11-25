import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { startInstalledNativeManagedTaskAdoptionUi } from "./installed-native-managed-task-adoption-ui.mjs";
import { installedNativeManagedTaskAdoptionProposals } from "./installed-native-managed-task-adoption-provider.mjs";

// Real Chromium/CDP/DOM only. This synthetic workbench and its JSON are not VS Code/Core authority proof.
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
  throw new Error(`Adoption DOM fixture timeout: ${path}`);
}
async function endpoint() {
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function fixture(root) {
  const runId = randomUUID(), c = { schema: "pkm.installed-native-managed-task-adoption-ui/v1", runId, sourceRoot: `${root}/library`,
    workspaceId: randomUUID(), nativeEpoch: randomUUID(), profileSha256: "a".repeat(64), sourcePlanSha256: "b".repeat(64),
    nativeHostReceiptSha256: "c".repeat(64), providerVendor: "pkm-native-managed-task-adoption-fixture",
    modelLabel: "Synthetic installed original Task adoption model", modelId: "vscode:pkm-native-managed-task-adoption-fixture:fixture",
    wireModelId: "fixture", cases: {}, requests: {} };
  const files = {};
  for (const name of ["main", "collision"]) {
    const chatId = randomUUID(), taskId = `agent_session_${randomUUID().replaceAll("-", "")}`, goalId = randomUUID(), originalInputId = randomUUID();
    c.cases[name] = { chatId, chatUrl: `pkm://chats/0123456789abcdef/${chatId}`, taskId, goalId, originalInputId,
      objective: "Start a new task: preserve exact original fixture objective.", historicalEvidenceId: `old-${name}` };
    files[`native-task-adoption-source-${name}.json`] = { sourceSha256: digest({ name }), original: {
      chatId, namespace: "0123456789abcdef", taskId, sourceInputIds: [originalInputId], sessionStatus: "paused",
      goal: { id: goalId, inputId: originalInputId, executionDigest: "d".repeat(64), objective: c.cases[name].objective,
        acceptance: [{ criterion: "The original user objective and all subsequent requirements are satisfied.", verified: true, evidenceCallIds: [`old-${name}`] }] },
    } };
  }
  for (const name of ["adoptDeny", "sendDeny", "positive", "collision"]) {
    const original = c.cases[name === "collision" ? "collision" : "main"], commandId = `installed-task-adoption-${name}-${runId}`;
    const q = { name, commandId, requestId: hash(JSON.stringify([c.workspaceId, commandId]).replace(",", ", ")),
      chatId: original.chatId, chatUrl: original.chatUrl, prompt: `Continue the exact original ${name} fixture.`, hardToolRoundLimit: 7 };
    q.argumentsSha256 = digest({ chatId: q.chatId, prompt: q.prompt, hardToolRoundLimit: 7 }); c.requests[name] = q;
  }
  const original = c.cases.main, binding = { schema: "pkm.original-native-task-execution/v1", taskId: original.taskId,
    chatId: original.chatId, attemptId: randomUUID(), inputId: randomUUID(), requestId: c.requests.positive.requestId,
    sourcePlanSha256: c.sourcePlanSha256, nativeEpoch: c.nativeEpoch };
  const goal = { id: original.goalId, inputId: original.originalInputId, attemptInputId: binding.inputId, objective: original.objective,
    sourceInputIds: [original.originalInputId, binding.inputId], acceptance: [{
      criterion: "The original user objective and all subsequent requirements are satisfied.", verified: false, evidenceCallIds: [],
    }] };
  const b = { managedTask: binding, goal, planSha256: digest({ native: "plan" }),
    tools: ["get_document", "session_info", "report_work", "record_harness"],
    proposals: installedNativeManagedTaskAdoptionProposals(binding, goal, original.historicalEvidenceId) };
  files["native-task-adoption-positive-binding.json"] = b;
  const actions = [], allow = "Allow this native model request", owner = { root: c.sourceRoot, workspaceId: c.workspaceId, profileSha256: c.profileSha256 };
  const selection = { protocol: "pkm.original-api-chat-execution/v1", provider: "vscode", epoch: c.nativeEpoch,
    modelId: c.modelId, wireModelId: c.wireModelId, permissionMode: "protective", outputTokenCap: 8192,
    budget: { maxInputTokens: 200000, maxTotalOutputTokens: 32768, deadlineMs: 300000 } };
  let stage;
  const modal = (title, data, button = allow) => actions.push({ stage, type: "modal", title, data, button });
  const public_ = q => {
    const args = { host_id: c.workspaceId, chat_id: q.chatId, prompt: q.prompt, command_id: q.commandId, hard_tool_round_limit: 7 };
    modal("Allow PKM v5 api_chat_send for this exact request?", { ...owner, operation: "mcp.tool.api_chat_send", tool: "api_chat_send",
      version: 1, readOnly: false, arguments: args, argumentsDigest: digest(args) }, "Approve this request");
  };
  function send(name) {
    const q = c.requests[name], source = files[`native-task-adoption-source-${name === "collision" ? "collision" : "main"}.json`];
    public_(q); public_(q);
    actions.push({ stage, type: "pick", title: "Choose an exact native model for this PKM Chat", label: c.modelLabel, detail: c.modelId });
    modal("Bind this exact native VS Code model to this PKM Chat?", { ...owner, requestId: q.requestId, chatUrl: q.chatUrl,
      sourcePlanSha256: c.sourcePlanSha256, model: { id: c.modelId, nativeModelId: c.wireModelId }, selection });
    modal("Select this exact native VS Code model?", { ...owner, modelId: c.modelId, catalogueSha256: "e".repeat(64) });
    modal("Adopt this exact original PKM Task and revalidate its Goal?", { ...owner, schema: "pkm.chat.original-task-adoption-review/v1",
      requestId: q.requestId, commandId: q.commandId, chatUrl: q.chatUrl, prompt: q.prompt, argumentsSha256: q.argumentsSha256,
      sourcePlanSha256: c.sourcePlanSha256, sourceSha256: source.sourceSha256, original: source.original, selection,
      previousExecutionDigest: source.original.goal.executionDigest,
      nextExecutionDigest: digest({ root: c.sourceRoot, workspaceId: c.workspaceId, actorId: "mcp:external", chatId: q.chatId,
        nativeHostReceiptSha256: c.nativeHostReceiptSha256, sourcePlanSha256: c.sourcePlanSha256, model: selection }),
      resetCurrentAcceptance: true, importOldPermissions: false, historicalEvidenceOnly: true, taskCompletion: "not-claimed",
      permission: "The old model, permissions, verified acceptance and tool/Harness evidence are not current authority.",
    }, name === "adoptDeny" ? "Deny" : "Adopt this exact goal and reset acceptance");
    if (name === "adoptDeny") return;
    modal("Send this exact request to the bound native PKM Chat?", { ...owner, operation: "send", requestId: q.requestId,
      commandId: q.commandId, chatUrl: q.chatUrl, sourcePlanSha256: c.sourcePlanSha256, selection, argumentsSha256: q.argumentsSha256,
      sourceUncertain: false }, name === "sendDeny" ? "Deny" : allow);
    if (name !== "positive") return;
    modal("Run this native PKM Chat request with the displayed limits?", { ...owner, requestId: q.requestId, chatUrl: q.chatUrl,
      sourcePlanSha256: c.sourcePlanSha256, planSha256: b.planSha256, managedTask: b.managedTask, tools: b.tools,
      hardToolRoundLimit: 7, outputTokenCap: 8192, budget: selection.budget });
  }
  const inference = () => modal(`Send this inference to native VS Code model ${c.wireModelId}?`,
    { root: c.sourceRoot, model: c.wireModelId, requestSha256: digest({ unique: randomUUID() }) }, "Approve this request");
  stage = "native-task-adoption-source";
  modal("Admit this exact original API Chat source?", { noExecution: true, session: { epoch: c.nativeEpoch,
    binding: { root: c.sourceRoot, workspaceId: c.workspaceId, profileSha256: c.profileSha256 } },
    request: { sourcePlanSha256: c.sourcePlanSha256 }, permission: "No old worker, Engine, queued execution authority is inherited." }, "Admit this exact source only");
  stage = "native-task-adoption-deny-review"; send("adoptDeny");
  stage = "native-task-adoption-deny-send"; send("sendDeny");
  stage = "native-task-adoption-positive"; send("positive");
  for (const proposal of b.proposals) {
    inference();
    const readOnly = ["knowledge.document.get", "chat.task.get"].includes(proposal.operation);
    const args = { ...proposal.arguments, ...(!readOnly ? { operationId: randomUUID() } : {}) };
    modal(`Review native PKM execution ${proposal.operation}`, { root: c.sourceRoot, workspaceId: c.workspaceId, actorId: "mcp:external",
      context: { turnId: c.requests.positive.requestId, contextDigest: b.planSha256, readOnly },
      record: { tool: proposal.operation, arguments: args, status: "pending" }, argumentsDigest: digest(args) }, "Approve this request");
    modal(`Allow native PKM tool ${proposal.operation}?`, { root: c.sourceRoot, workspaceId: c.workspaceId, actorId: "mcp:external",
      operation: proposal.operation, version: 1, arguments: args, argumentsDigest: digest(args), readOnly,
      turnId: c.requests.positive.requestId, contextDigest: b.planSha256 }, "Approve this request");
  }
  inference(); stage = "native-task-adoption-replay"; public_(c.requests.positive);
  stage = "native-task-adoption-collision"; send("collision");
  return { c, files, actions, collisionIndex: actions.findIndex(action => action.stage === stage && action.title.startsWith("Adopt this exact")) };
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
            stage=f["actions"][index]["stage"] if index<len(f["actions"]) else "native-task-adoption-source-revoke"
            (root/"progress.json").write_text(json.dumps({"stage":stage}));last=index
            (root/"dom-events.json").write_text(json.dumps(page.evaluate("window.events")))
        if (root/"native-task-adoption-collision-visible.json").exists() and not (root/"native-task-adoption-collision-committed.json").exists():
            assert index==f["collisionIndex"]
            time.sleep(.15);assert page.evaluate("window.index")==index
            if f["replacePending"]:page.evaluate("window.render()")
            (root/"native-task-adoption-collision-committed.json").write_text(json.dumps(f["committed"]))
        if (root/"native-task-adoption-revoke-visible.json").exists():
            (root/"progress.json").write_text('{"stage":"native-task-adoption-complete"}')
        time.sleep(.015)
    context.close()
`;
async function run(t, mutate, replacePending = false) {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`), artifacts = resolve(`.mab-${randomUUID().slice(0, 5)}`);
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(artifacts, { mode: 0o700 });
  const value = fixture(root); mutate?.(value);
  for (const [name, data] of Object.entries(value.files)) await writeFile(join(root, name), JSON.stringify(data));
  await writeFile(join(root, "native-task-adoption-ui-contract.json"), JSON.stringify(value.c));
  await writeFile(join(root, "workbench.html"), html);
  const port = await endpoint(), env = { ...process.env, TMPDIR: artifacts, TMP: artifacts, TEMP: artifacts, PYTHONDONTWRITEBYTECODE: "1" };
  const child = spawn(python, ["-B", "-c", browserProgram, JSON.stringify({ root, artifacts, port, actions: value.actions,
    replacePending, collisionIndex: value.collisionIndex,
    committed: { committed: true, operationId: randomUUID(), inputOperationId: randomUUID(), messageId: randomUUID(),
      chatId: value.c.cases.collision.chatId, revision: 2 } })], { env, stdio: "inherit" });
  const childDone = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Adoption DOM browser exited ${code}`)));
  });
  void childDone.catch(() => {}); let observer;
  t.after(async () => {
    try { await observer?.stop(); await writeFile(join(root, "browser-stop.json"), "{}"); await childDone; }
    finally { await rm(root, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); }
  });
  await wait(join(root, "browser-ready.json"));
  observer = await startInstalledNativeManagedTaskAdoptionUi({ root, python, env, port, runId: value.c.runId, timeoutMs: 4000 });
  return { root, value, observer };
}
test("adoption renderer handles distinct adoption/send denials, exact Core evidence/Harness, replay approval and captured collision review", { timeout: 45000 }, async t => {
  const f = await run(t); await f.observer.done;
  const proof = await wait(join(f.root, "native-task-adoption-ui-passed.json"));
  assert.equal(proof.actualRenderedDom, true); assert.equal(proof.sameCollisionReviewClickedAfterCommit, true);
  const events = await wait(join(f.root, "dom-events.json"));
  assert.equal(events.length, f.value.actions.length);
  assert.equal(events.filter(event => event.value === "Deny").length, 2);
  assert.equal(events.filter(event => event.value === "Adopt this exact goal and reset acceptance").length, 3);
});
test("adoption renderer refuses another signed Root before source approval", { timeout: 45000 }, async t => {
  const f = await run(t, value => { value.actions[0].data.session.binding.root = "/another-root"; });
  await assert.rejects(f.observer.done);
  assert.match((await wait(join(f.root, "native-task-adoption-ui-passed.json"))).error, /Wrong signed original source owner/);
  assert.deepEqual(await wait(join(f.root, "dom-events.json")), []);
});
test("adoption renderer refuses an identical-text replacement instead of approving a different pending Goal review", { timeout: 45000 }, async t => {
  const f = await run(t, undefined, true);
  await assert.rejects(f.observer.done);
  assert.match((await wait(join(f.root, "native-task-adoption-ui-passed.json"))).error, /original pending adoption modal node was replaced/);
  assert.equal((await wait(join(f.root, "dom-events.json"))).length, f.value.collisionIndex);
});
