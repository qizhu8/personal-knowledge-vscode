import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { startInstalledNativeMemoryUi } from "./installed-native-memory-ui.mjs";
import { installedNativeMemoryMarkers } from "./installed-native-memory-provider.mjs";

// Real Chromium/CDP/DOM regression only. This synthetic workbench is not VS Code or native authority proof.
assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Run DOM observer tests in the existing private Linux framework.");
const python = execFileSync(process.env.PKM_TEST_PYTHON ?? process.env.PYTHON ?? "python3",
  ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const hash = value => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = value => hash(canonical(value));
const wait = async (path, timeoutMs = 20000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`DOM fixture timed out: ${path}`);
};
async function port() {
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
function contract(root) {
  const value = { schema: "pkm.installed-native-memory-ui/v1", sourceRoot: `${root}/fixture-library`,
    workspaceId: randomUUID(), nativeEpoch: randomUUID(), profileSha256: "a".repeat(64), sourcePlanSha256: "b".repeat(64),
    sourceDatabaseSha256: "c".repeat(64), scope: '{"account":"synthetic-dom-fixture"}',
    query: "EXACT_FIXTURE_QUERY", modelLabel: "Synthetic installed Memory evidence model",
    modelId: "vscode:pkm-native-memory-fixture:memory-fixture", wireModelId: "memory-fixture",
    providerVendor: "pkm-native-memory-fixture", requests: {} };
  value.sourceScopeSha256 = hash(value.scope);
  for (const phase of ["off", "missing", "positive", "revoke"]) {
    const commandId = `installed-native-memory-${phase}`, chatId = randomUUID();
    const prompt = `${installedNativeMemoryMarkers[phase]}: use only explicitly selected current evidence.`;
    value.requests[phase] = { commandId, chatId, prompt, chatUrl: `pkm://chats/0123456789abcdef/${chatId}`,
      requestId: hash(JSON.stringify([value.workspaceId, commandId]).replace(",", ", ")),
      argumentsSha256: digest({ chatId, prompt, hardToolRoundLimit: 1 }) };
  }
  return value;
}
function actions(c) {
  const list = [], allow = "Allow this native model request";
  const owner = { root: c.sourceRoot, workspaceId: c.workspaceId, profileSha256: c.profileSha256 };
  const source = domain => ({ type: "modal", title: `Admit this exact original ${domain === "chat" ? "API Chat" : "Memory"} source?`,
    button: "Admit this exact source only", data: {
      session: { epoch: c.nativeEpoch, binding: { root: c.sourceRoot, workspaceId: c.workspaceId, profileSha256: c.profileSha256 } },
      noExecution: true, request: domain === "chat" ? { sourcePlanSha256: c.sourcePlanSha256 }
        : { sourceDatabaseSha256: c.sourceDatabaseSha256, sourceScopeSha256: c.sourceScopeSha256 },
      permission: "No old worker, Engine, queued execution authority is inherited.",
    } });
  list.push({ ...source("chat"), stage: "native-memory-chat-source-admit" });
  for (const phase of ["off", "missing", "positive", "revoke"]) {
    if (phase === "positive") list.push({ ...source("memory"), stage: "native-memory-source-admit" });
    const stage = { off: "native-memory-default-off", missing: "native-memory-missing-grant",
      positive: "native-memory-positive", revoke: "native-memory-revoke-pending" }[phase];
    const q = c.requests[phase], selection = { protocol: "pkm.original-api-chat-execution/v1", provider: "vscode",
      modelId: c.modelId, wireModelId: c.wireModelId, epoch: c.nativeEpoch, outputTokenCap: 8192 };
    const binding = { requestId: q.requestId, chatUrl: q.chatUrl, sourcePlanSha256: c.sourcePlanSha256,
      argumentsSha256: q.argumentsSha256, selection, draftSha256: null, scope: phase === "off" ? null : c.scope, proposedQuery: q.prompt };
    const add = (title, data, button = allow) => list.push({ stage, type: "modal", title, data, button });
    const args = { host_id: c.workspaceId, chat_id: q.chatId, prompt: q.prompt, command_id: q.commandId, hard_tool_round_limit: 1 };
    add("Allow PKM v5 api_chat_send for this exact request?", { ...owner, operation: "mcp.tool.api_chat_send",
      tool: "api_chat_send", version: 1, readOnly: false, arguments: args, argumentsDigest: digest(args) }, "Approve this request");
    list.push({ stage, type: "pick", title: "Choose an exact native model for this PKM Chat",
      rows: [{ label: c.modelLabel, detail: c.modelId }] });
    add("Bind this exact native VS Code model to this PKM Chat?", { ...owner, requestId: q.requestId,
      chatUrl: q.chatUrl, sourcePlanSha256: c.sourcePlanSha256,
      model: { id: c.modelId, nativeModelId: c.wireModelId }, selection });
    list.push({ stage, type: "pick", title: "Native PKM Chat: explicitly select live Memory?", rows: [
      { label: "No live Memory recall (default)", detail: "off" },
      { label: "Select live Memory for this exact request", detail: phase === "missing"
        ? "Independent same-owner Memory source admission is not available." : c.scope },
    ] });
    if (phase === "missing") continue;
    if (phase !== "off") {
      list.push({ stage, type: "input", title: "Exact native Memory query",
        detail: `Scope ${c.scope}. Literal query, 1–512 UTF-8 bytes; at most 3 full confirmed records.` });
      add("Use this independently admitted live Memory scope for this exact native Chat request?",
        { ...owner, ...binding, proposedQuery: undefined, query: c.query, limit: 3, bindingSha256: digest(binding) });
    }
    add("Select this exact native VS Code model?", { ...owner, modelId: c.modelId, catalogueSha256: "d".repeat(64) });
    add("Send this exact request to the bound native PKM Chat?", { ...owner, operation: "send", requestId: q.requestId,
      commandId: q.commandId, chatUrl: q.chatUrl, sourcePlanSha256: c.sourcePlanSha256, selection,
      argumentsSha256: q.argumentsSha256, sourceUncertain: false, liveMemory: {
        requestId: q.requestId, epoch: c.nativeEpoch, bindingSha256: digest(binding), mode: phase === "off" ? "off" : "live",
        ...(phase === "off" ? {} : { scope: c.scope, query: c.query, limit: 3 }),
      } });
    const planSha256 = digest({ fixture: phase }), context = { turnId: q.requestId, contextDigest: planSha256, readOnly: true };
    add("Run this native PKM Chat request with the displayed limits?", { ...owner, requestId: q.requestId, chatUrl: q.chatUrl,
      sourcePlanSha256: c.sourcePlanSha256, selectionId: randomUUID(), planSha256, hardToolRoundLimit: 1,
      tools: ["get_document"], outputTokenCap: 8192, budget: { deadlineMs: 120000 } });
    add(`Send this inference to native VS Code model ${c.wireModelId}?`,
      { root: c.sourceRoot, model: c.wireModelId, requestSha256: digest({ phase, inference: 0 }) }, "Approve this request");
    if (phase === "positive") {
      add("Review native PKM execution knowledge.document.get", { root: c.sourceRoot, workspaceId: c.workspaceId,
        actorId: "mcp:external", context, argumentsDigest: digest({ id: "Entry" }),
        record: { tool: "knowledge.document.get", arguments: { id: "Entry" }, status: "pending" } }, "Approve this request");
      add("Allow native PKM tool knowledge.document.get?", { root: c.sourceRoot, workspaceId: c.workspaceId,
        actorId: "mcp:external", operation: "knowledge.document.get", version: 1, arguments: { id: "Entry" },
        argumentsDigest: digest({ id: "Entry" }), ...context }, "Approve this request");
      add(`Send this inference to native VS Code model ${c.wireModelId}?`,
        { root: c.sourceRoot, model: c.wireModelId, requestSha256: digest({ phase, inference: 1 }) }, "Approve this request");
    }
  }
  return list;
}
const html = `<!doctype html><meta charset="utf-8"><body><script>
window.actions=[];window.index=0;window.events=[];
function text(tag,value){const e=document.createElement(tag);e.textContent=value;return e;}
function advance(value){events.push({index,title:actions[index].title,value});index++;render();}
function render(){document.body.replaceChildren();const a=actions[index];if(!a)return;
const box=document.createElement("div");box.className=a.type==="modal"?"monaco-dialog-box":"quick-input-widget";
box.append(text("div",a.title));document.body.append(box);
if(a.type==="modal"){box.append(text("pre",JSON.stringify(a.data,null,2)));for(const name of [a.button,"Deny"]){
const b=text("button",name);b.onclick=()=>advance(name);box.append(b);}}
else if(a.type==="pick"){for(const row of a.rows){const e=document.createElement("div");e.className="monaco-list-row";
e.append(text("div",row.label),text("div",row.detail));e.onclick=()=>advance(row.label);box.append(e);}}
else{box.append(text("div",a.detail));const input=document.createElement("input");input.type="text";
input.onkeydown=e=>{if(e.key==="Enter")advance(input.value);};box.append(input);}}
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
    (root/"browser-ready.json").write_text('{"ready":true}')
    last=-1;until=time.monotonic()+35
    while time.monotonic()<until and not (root/"browser-stop.json").exists():
        index=page.evaluate("window.index")
        if index!=last:
            stage=f["actions"][index]["stage"] if index<len(f["actions"]) else "native-memory-complete"
            (root/"progress.json").write_text(json.dumps({"stage":stage}));last=index
            (root/"dom-events.json").write_text(json.dumps(page.evaluate("window.events")))
        if (root/"native-memory-revoke-model-visible.json").exists() and not (root/"native-memory-revoked-before-click.json").exists():
            assert index==len(f["actions"])-1,"Observer clicked a different modal before revocation"
            time.sleep(.15);assert page.evaluate("window.index")==index,"Observer approved before the revocation handshake"
            if f.get("replacePending"):page.evaluate("window.render()")
            (root/"native-memory-revoked-before-click.json").write_text('{"revoked":true}')
        time.sleep(.015)
    context.close()
`;
async function run(t, mutate, replacePending = false) {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`);
  const temporary = resolve(`.mb-${randomUUID().slice(0, 5)}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  const value = contract(root), steps = actions(value); mutate?.(steps);
  await writeFile(join(root, "native-memory-ui-contract.json"), JSON.stringify(value));
  await writeFile(join(root, "workbench.html"), html);
  const endpoint = await port();
  const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, PYTHONDONTWRITEBYTECODE: "1" };
  const child = spawn(python, ["-B", "-c", browserProgram,
    JSON.stringify({ root, artifacts: temporary, port: endpoint, actions: steps, replacePending })], { env, stdio: "inherit" });
  const childDone = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`DOM browser failed ${code}`)));
  });
  void childDone.catch(() => {});
  let observer;
  t.after(async () => {
    try {
      await observer?.stop();
      await writeFile(join(root, "browser-stop.json"), "{}");
      await childDone;
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(temporary, { recursive: true, force: true });
    }
  });
  await wait(join(root, "browser-ready.json"));
  observer = await startInstalledNativeMemoryUi({ root, python, env, port: endpoint, timeoutMs: 4000 });
  return { root, value, steps, observer };
}
test("Memory CDP observer handles exact rendered stages and clicks the same inference only after revocation", { timeout: 45000 }, async t => {
  const f = await run(t);
  await f.observer.done;
  const proof = await wait(join(f.root, "native-memory-ui-passed.json"));
  assert.equal(proof.passed, true); assert.equal(proof.samePendingInferenceApprovedOnlyAfterRevocation, true);
  assert.equal(proof.choices.length, 4);
  assert(proof.dialogs.some(dialog => dialog.title === "Review native PKM execution knowledge.document.get"));
  const events = await wait(join(f.root, "dom-events.json"));
  assert.equal(events.length, f.steps.length);
  assert(events.every(event => event.value !== "Deny"));
});
test("Memory CDP observer refuses a different Root instead of approving a familiar native title", { timeout: 45000 }, async t => {
  const f = await run(t, steps => { steps[0].data.session.binding.root = "/another-library"; });
  await assert.rejects(f.observer.done);
  const proof = await wait(join(f.root, "native-memory-ui-passed.json"));
  assert.match(proof.error, /Wrong signed source Root/);
  assert.deepEqual(await wait(join(f.root, "dom-events.json")), []);
});
test("Memory CDP observer rejects unknown Memory choices without selecting the known-looking live row", { timeout: 45000 }, async t => {
  const f = await run(t, steps => {
    const choice = steps.find(step => step.title === "Native PKM Chat: explicitly select live Memory?");
    choice.rows.push({ label: "Allow all Memory permanently", detail: "not admissible" });
  });
  await assert.rejects(f.observer.done);
  const proof = await wait(join(f.root, "native-memory-ui-passed.json"));
  assert.match(proof.error, /Unknown native Memory choice/);
});
test("Memory CDP observer refuses a replaced pending modal even when its exact rendered text is unchanged", { timeout: 45000 }, async t => {
  const f = await run(t, undefined, true);
  await assert.rejects(f.observer.done);
  const proof = await wait(join(f.root, "native-memory-ui-passed.json"));
  assert.match(proof.error, /original pending modal node was replaced/);
  const events = await wait(join(f.root, "dom-events.json"));
  assert.equal(events.length, f.steps.length - 1);
});
