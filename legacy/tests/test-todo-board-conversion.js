const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
function compile(source, dependencies) {
  const module = { exports:{} };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions:{ module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports:module.exports, require:name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return module.exports;
}
const navigation = compile(fs.readFileSync(path.join(root, "src/ui/navigation-path.ts"), "utf8"), {});
const source = fs.readFileSync(path.join(root, "src/ui/todo-board-conversion.ts"), "utf8");
function workflow() {
  const calls = [], choices = [];
  const state = { root:"/knowledge", note:{ slug:"Project/Agent Plan", title:"Agent Plan", content:"- [ ] Free-form task" }, trusted:true };
  const api = compile(source, {
    vscode:{
      workspace:{ get isTrusted() { return state.trusted; } },
      window:{
        showQuickPick:async (items, options) => { calls.push({type:"pick", items, options}); return choices.shift()?.(items); },
        showInformationMessage:message => calls.push({type:"info", message}),
      },
      env:{ clipboard:{ writeText:async text => {
        if (state.clipboardError) throw new Error(state.clipboardError);
        calls.push({type:"copy", text});
      } } },
    },
    "../knowledge/filestore":{ getStorePath:() => state.root, noteGet:() => state.note },
    "./navigation-path":navigation,
  });
  return { ...api, calls, choices, state,
    run:() => api.requestTodoBoardConversion("Project/Agent Plan", async (prompt, title) => calls.push({type:"chat", prompt, title})) };
}

test("conversion prompt references the exact source and requires real Board APIs and readback", () => {
  const flow = workflow();
  const prompt = flow.todoBoardConversionPrompt({slug:"Project/Space & 中文/Plan #1", title:"Agent's plan"});
  assert.match(prompt, /pkm:\/\/notes\/Project\/Space%20%26%20%E4%B8%AD%E6%96%87\/Plan%20%231.md/);
  for (const required of ["get_note", "todo_board_create", "get_board", "add_userstory", "add_workitem",
    "expected_digest", "parentId", "dependsOn", "source-to-item mapping", "partial failures"]) assert(prompt.includes(required), required);
  assert.match(prompt, /Keep the original Markdown Note unchanged/);
  assert.match(prompt, /Stories as draft and tasks as Planning\/todo, unassigned/);
  assert.match(prompt, /do not auto-complete, accept, assign, claim or execute/);
  assert.match(prompt, /If there are no actionable items/);
  assert.match(prompt, /normal.*permissions/i);
  assert(prompt.length < 16000, "prompt fits the existing Chat send contract without embedding arbitrarily large Markdown");
});

test("copy path works for plain Markdown, without a Chat or a conversion", async () => {
  const flow = workflow();
  flow.choices.push(items => items.find(item => item.action === "copy"));
  await flow.run();
  assert.deepEqual(flow.calls.map(call => call.type), ["pick", "copy", "info"]);
  assert.equal(flow.calls[0].items.length, 2);
  assert.match(flow.calls[1].text, /Project\/Agent Plan/);
  assert.match(flow.calls[2].message, /No conversion has run/);
  assert.equal(flow.state.note.content, "- [ ] Free-form task");
});

test("PKM Chat path receives exactly the same prompt; cancellation has no side effects", async () => {
  const flow = workflow();
  await flow.run();
  assert.deepEqual(flow.calls.map(call => call.type), ["pick"]);
  flow.choices.push(items => items.find(item => item.action === "chat"));
  await flow.run();
  const sent = flow.calls.at(-1);
  assert.equal(sent.type, "chat");
  assert.equal(sent.title, "Agent Plan");
  assert.equal(sent.prompt, flow.todoBoardConversionPrompt(flow.state.note));
  assert.equal(flow.calls.some(call => call.type === "copy"), false);
});

test("missing/Board/system Notes, untrusted workspaces and root changes fail explicitly", async () => {
  for (const [change, error] of [
    [flow => { flow.state.note = null; }, /no longer available/],
    [flow => { flow.state.note.documentKind = "todo-board"; }, /already/],
    [flow => { flow.state.trusted = false; }, /trusted/],
  ]) {
    const flow = workflow(); change(flow);
    await assert.rejects(flow.run(), error);
    assert.equal(flow.calls.length, 0);
  }
  const system = workflow();
  await assert.rejects(system.requestTodoBoardConversion("system/Guide", async () => {}), /read-only/);
  for (const slug of ["", "../outside", "/absolute", "Team/../outside", "Team\\outside"]) {
    await assert.rejects(system.requestTodoBoardConversion(slug, async () => {}), /valid relative path/);
  }
  const changed = workflow();
  changed.choices.push(items => { changed.state.root = "/other"; return items[0]; });
  await assert.rejects(changed.run(), /Knowledge Root changed/);
  assert.deepEqual(changed.calls.map(call => call.type), ["pick"]);
});

test("clipboard and Chat failures propagate instead of reporting conversion success", async () => {
  const flow = workflow();
  flow.choices.push(items => items.find(item => item.action === "chat"));
  await assert.rejects(flow.requestTodoBoardConversion("Project/Agent Plan", async () => { throw new Error("Chat busy"); }), /Chat busy/);
  assert.equal(flow.calls.some(call => call.type === "info"), false);
  const clipboard = workflow();
  clipboard.state.clipboardError = "Clipboard unavailable";
  clipboard.choices.push(items => items[0]);
  await assert.rejects(clipboard.run(), /Clipboard unavailable/);
  assert.equal(clipboard.calls.some(call => call.type === "info"), false);
});

const chatSource = fs.readFileSync(path.join(root, "src/chat/api-chat-view.ts"), "utf8");
const methodStart = chatSource.indexOf("  async runNoteBoardConversion(");
const methodEnd = chatSource.indexOf("  async requestPortalInteraction(", methodStart);
assert(methodStart >= 0 && methodEnd > methodStart);
function chatFlow(chats = [{id:"existing-chat", title:"Existing Chat"}]) {
  const calls = [], choices = [], confirmations = [];
  const state = { root:"/knowledge", trusted:true };
  const lexical = compile(`import * as vscode from "vscode";
    import {getStorePath} from "store";
    export class Host { ${chatSource.slice(methodStart, methodEnd)} }`, {
    vscode:{
      workspace:{ get isTrusted() { return state.trusted; } },
      window:{
        showQuickPick:async (items, options) => { calls.push({type:"pick", items, options}); return choices.shift()?.(items); },
        showWarningMessage:async (...args) => { calls.push({type:"confirm", args}); return confirmations.shift()?.(); },
      },
    },
    store:{getStorePath:() => state.root},
  });
  const host = new lexical.Host();
  host.openStore = () => { host.store = {list:() => chats}; };
  host.openPkmChat = async id => calls.push({type:"open", id});
  host.agentControl = async (operation, args) => { calls.push({type:operation, args}); return {chatId:"new-chat"}; };
  return {host, calls, choices, confirmations, state};
}

test("existing Chat is opened and sent the prompt without creating/reconfiguring it", async () => {
  const flow = chatFlow();
  flow.choices.push(items => items.find(item => item.id === "existing-chat"));
  flow.confirmations.push(() => "Start conversion");
  await flow.host.runNoteBoardConversion("conversion prompt", "Agent Plan");
  assert.deepEqual(flow.calls.map(call => call.type), ["pick", "confirm", "open", "send"]);
  assert.deepEqual(JSON.parse(JSON.stringify(flow.calls.at(-1).args)), {chatId:"existing-chat", prompt:"conversion prompt"});
});

test("empty Chat library still offers creation; created Chat is opened before sending", async () => {
  const flow = chatFlow([]);
  flow.choices.push(items => { assert.equal(items.length, 1); return items[0]; });
  flow.confirmations.push(() => "Start conversion");
  await flow.host.runNoteBoardConversion("conversion prompt", "Agent Plan");
  assert.deepEqual(flow.calls.map(call => call.type), ["pick", "confirm", "create", "open", "send"]);
  assert.deepEqual(JSON.parse(JSON.stringify(flow.calls[2].args)), {title:"Todo Board: Agent Plan"});
  assert.equal(flow.calls[3].id, "new-chat");
  assert.equal(flow.calls[4].args.chatId, "new-chat");
});

test("cancelling picker or confirmation creates/sends nothing", async () => {
  const picker = chatFlow();
  await picker.host.runNoteBoardConversion("prompt", "title");
  assert.deepEqual(picker.calls.map(call => call.type), ["pick"]);
  const confirmation = chatFlow([]);
  confirmation.choices.push(items => items[0]);
  await confirmation.host.runNoteBoardConversion("prompt", "title");
  assert.deepEqual(confirmation.calls.map(call => call.type), ["pick", "confirm"]);
});

test("Chat root changes and failed creates/sends are not silently retried", async () => {
  const changed = chatFlow();
  changed.choices.push(items => { changed.state.root = "/other"; return items[0]; });
  await assert.rejects(changed.host.runNoteBoardConversion("prompt", "title"), /Knowledge Root changed/);
  const failed = chatFlow([]);
  failed.choices.push(items => items[0]);
  failed.confirmations.push(() => "Start conversion");
  failed.host.agentControl = async () => ({});
  await assert.rejects(failed.host.runNoteBoardConversion("prompt", "title"), /no Chat identity/);
  assert.equal(failed.calls.some(call => call.type === "open"), false);
  const busy = chatFlow();
  busy.choices.push(items => items[1]);
  busy.confirmations.push(() => "Start conversion");
  let sends = 0;
  busy.host.agentControl = async () => { sends++; throw new Error("This Chat is busy"); };
  await assert.rejects(busy.host.runNoteBoardConversion("prompt", "title"), /busy/);
  assert.equal(sends, 1);
});
