const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const Module = require("node:module");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const { PersonaProfileStore } = require("../dist/chat/persona-profiles");
const host = {
  commands:{}, env:{ language:"en" }, window:{},
  workspace:{ isTrusted:true, workspaceFolders:[], getConfiguration:() => ({ get:(_key, fallback) => fallback }) },
  lm:{ tools:[] },
};
const originalLoad = Module._load;
let ApiChatView, configureUserProfile;
try {
  Module._load = function(name, ...args) { return name === "vscode" ? host : originalLoad.call(this, name, ...args); };
  ({ ApiChatView } = require("../dist/chat/api-chat-view"));
  ({ configureUserProfile } = require("../dist/chat/persona-profile-ui"));
} finally { Module._load = originalLoad; }
const { ApiChatStore } = require("../dist/chat/api-chat-store");
const root = path.join(__dirname, ".."), assets = path.join(root, "dist", "webview");
const source = fs.readFileSync(path.join(root, "src/webview/panel/15-projects.js"), "utf8");
const architecture = source.slice(source.indexOf("function renderNativeAgentArchitecture("), source.indexOf("function agentHarnessJson("));
assert(fs.readFileSync(path.join(assets, "panel.js"), "utf8").includes(architecture), "Run the full build before exercising the production renderer");
const chatTokens = {
  styles:"api-chat.css", script:"api-chat.js", icons:"codicon.css", marked:"marked.umd.js", purify:"purify.min.js",
  libraryScript:"api-chat-library.js", retrievalScript:"chat-retrieval-flow.js", hostHealthScript:"host-health.js",
  hostHealthStyles:"host-health.css", harnessScript:"agent-harness.js", harnessStyles:"agent-harness.css",
  visualizationScript:"chat-visualization.js", katex:"katex.js", katexStyles:"katex.css", mermaid:"mermaid.js",
};
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Profile browser/Host bridge timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("built Projects/Agent and Chat/Automation Profile entries reach native cards, explicit assignment and persistent edits without inference", async t => {
  const directory = path.join(__dirname, `.profile-browser-${randomUUID()}`);
  fs.mkdirSync(directory, { mode:0o700 });
  const chats = new ApiChatStore(path.join(directory, "state"), "b".repeat(16));
  const chat = chats.create();
  chats.startTask(chat, "Existing native Task");
  const profiles = new PersonaProfileStore(path.join(directory, "host"), path.join(directory, "knowledge"));
  const card = { name:"Browser user", role:"", focus:"", preferences:"BROWSER_USER_ONE", boundaries:"" };
  profiles.save("user", card);
  const agent = profiles.save("agent", { ...card, name:"Explicit browser Agent", role:"SDE" });
  let uiAction = "inspect", inspections = 0, modelCalls = 0, inputs = [];
  host.lm.selectChatModels = async () => { modelCalls++; throw new Error("Opening a card must not discover/invoke models"); };
  host.window.showQuickPick = async items => {
    if (items.some(item => item.action)) return items.find(item => item.action === (uiAction === "assign" ? "assign" : "user"));
    return items.find(item => item.id === agent.id);
  };
  host.window.showInformationMessage = async (_title, options) => {
    if (options?.modal) { inspections++; return uiAction === "edit" ? "Edit" : undefined; }
  };
  host.window.showInputBox = async () => inputs.shift();
  const provider = new ApiChatView({ globalStorageUri:{ fsPath:path.join(directory, "host") }, subscriptions:[] });
  provider.store = chats; provider.chat = chat; provider.chats.set(chat.id, chat);
  provider.personaStore = () => profiles; provider.publish = () => {};
  let currentCards = await provider.readVisualization(chat.id,"profiles",{});
  assert.equal(currentCards.user.name,"Browser user");
  assert.equal(currentCards.agentAssigned,false);
  assert.equal(currentCards.agent,undefined);
  assert.equal(modelCalls,0,"Read-only current Profile inspection never discovers or invokes a model");
  const taskFiles = () => fs.readdirSync(path.join(directory, "state", "agent-sessions")).sort();
  const originalTasks = taskFiles(), calls = [], errors = [], failures = [];
  const browser = await chromium.launch({ headless:true, args:["--no-sandbox"] });
  t.after(async () => { provider.dispose(); await browser.close(); fs.rmSync(directory, { recursive:true, force:true }); });
  const page = await browser.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.exposeFunction("profileHost", async (command, params) => {
    calls.push({ command, params });
    try { await provider.configureAgent(params.sessionId, params.section); }
    catch (error) { failures.push(error.message); }
  });

  await page.setContent('<main id="projects"></main><main id="agent-sessions"></main>');
  await page.addScriptTag({ content: `
    const esc = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const ask = (command, params) => window.profileHost(command, params);
    ${architecture}
    const session = ${JSON.stringify({ sessionId:chat.sessionId, origin:"pkm-native", nativeAgent:{ model:"Fixture", includeHistory:false } })};
    document.getElementById('projects').innerHTML = renderNativeAgentArchitecture(session);
    document.getElementById('agent-sessions').innerHTML = renderNativeAgentArchitecture(session);
  ` });
  await page.locator("#projects").getByRole("button", { name:"Configure User / Agent Profiles", exact:true }).click();
  await until(() => inspections === 1);
  uiAction = "assign";
  await page.locator("#agent-sessions").getByRole("button", { name:"Configure User / Agent Profiles", exact:true }).press("Enter");
  await until(() => chats.load(chat.id, false).agentProfileId === agent.id);
  currentCards = await provider.readVisualization(chat.id,"profiles",{});
  assert.equal(currentCards.agent.id,agent.id);
  assert(calls.every(call => call.command === "agentSessionConfigure"
    && call.params.sessionId === chat.sessionId && call.params.section === "profiles"));
  assert.equal(provider.running.size, 0);
  assert.deepEqual(taskFiles(), originalTasks);

  const chatPage = await browser.newPage({ viewport:{ width:1280, height:900 } });
  chatPage.on("pageerror", error => errors.push(error.message));
  await chatPage.addInitScript(() => {
    const saved = {};
    window.acquireVsCodeApi = () => ({
      getState:() => saved, setState:value => Object.assign(saved, value),
      postMessage:message => window.profileChatHost(message),
    });
  });
  let chatClicks = 0;
  await chatPage.exposeFunction("profileChatHost", async message => {
    if (message.type === "personaProfiles") {
      const data = await provider.readVisualization(chat.id,"profiles",{});
      await chatPage.evaluate(data=>window.dispatchEvent(new MessageEvent("message",{data})),{type:"personaProfiles",chatId:chat.id,data});
      return;
    }
    if (message.type !== "agentConfig") return;
    chatClicks++;
    try { await provider.handle(message); } catch (error) { failures.push(error.message); }
  });
  await chatPage.route("http://profile-ui.test/**", route => {
    const file = path.basename(new URL(route.request().url()).pathname);
    if (file === "index.html") {
      const html = fs.readFileSync(path.join(assets, "api-chat.html"), "utf8")
        .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
        .replace(/\{\{(\w+)\}\}/g, (_match, token) => chatTokens[token] || "");
      return route.fulfill({ body:html, contentType:"text/html" });
    }
    if (fs.existsSync(path.join(assets, file))) return route.fulfill({ path:path.join(assets, file) });
    return route.fulfill({ status:404, body:"" });
  });
  await chatPage.goto("http://profile-ui.test/index.html");
  const selectedProfile = { id:"fixture", model:"fixture", label:"Fixture", status:"active", contextWindow:8192, maxOutputTokens:1024 };
  await chatPage.evaluate(message => window.dispatchEvent(new MessageEvent("message", { data:message })), {
    type:"state", busy:true, approvals:[], decisions:[], chats:[{ id:chat.id, title:chat.title }],
    toolGroups:[], chat:{ ...chat, context:[], messages:[], includeHistory:false },
    library:{ groups:[], chats:[] }, settings:{ provider:"vscode", maxToolRounds:30, inputBaseTokens:0,
      contextWindow:8192, maxOutputTokens:1024, selectedProfile, profiles:[selectedProfile] },
  });
  await chatPage.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data:{ type:"showChat" } })));
  uiAction = "edit";
  inputs = ["Browser user", "", "", "BROWSER_USER_EDITED_DURING_BUSY_UI", ""];
  await chatPage.getByRole("button", { name:"User / Agent Profiles", exact:true }).click();
  const profileDialog=chatPage.getByRole("dialog",{name:"Current User / Agent Profiles",exact:true});
  await profileDialog.getByText("BROWSER_USER_ONE",{exact:true}).first().waitFor();
  assert.match(await profileDialog.innerText(),/Browser user.*revision 1/s);
  assert.equal(profiles.user().revision,1,"opening current cards is read-only");
  await chatPage.evaluate(chatId=>window.dispatchEvent(new MessageEvent("message",{data:{
    type:"error",profileError:true,chatId,message:"Profile read failed"
  }})),"other-chat");
  assert(!await profileDialog.getByRole("button",{name:"Retry",exact:true}).count());
  await chatPage.evaluate(chatId=>window.dispatchEvent(new MessageEvent("message",{data:{
    type:"error",profileError:true,chatId,message:"Profile read failed"
  }})),chat.id);
  await profileDialog.getByRole("button",{name:"Retry",exact:true}).click();
  await profileDialog.getByText("BROWSER_USER_ONE",{exact:true}).first().waitFor();
  await profileDialog.getByRole("button",{name:"Edit / manage Profiles",exact:true}).click();
  await until(() => profiles.user().revision === 2);
  assert.equal(profiles.user().preferences, "BROWSER_USER_EDITED_DURING_BUSY_UI");
  uiAction = "inspect";
  await chatPage.locator("#options").click();
  await chatPage.locator('#advanced-budget [data-agent-config="profiles"]').click();
  await until(() => chatClicks === 2);
  await chatPage.locator("#agent-config").click();
  await chatPage.locator('#agent-config-panel [data-agent-config="profiles"]').click();
  await until(() => chatClicks === 3 && inspections >= 4);
  assert.equal(chats.load(chat.id, false).agentProfileId, agent.id);
  assert.deepEqual(taskFiles(), originalTasks);
  assert.equal(modelCalls, 0);
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, []);
});

test("Automation User Profile page reads and edits the real current store without selecting a Chat or exposing raw IDs",async t=>{
  const directory=path.join(__dirname,`.profile-settings-${randomUUID()}`);
  fs.mkdirSync(directory,{mode:0o700});
  const store=new PersonaProfileStore(path.join(directory,"host"),path.join(directory,"knowledge"));
  store.save("user",{name:"Settings user",role:"Developer",focus:"Tests",preferences:"<img src=x>Preference text",boundaries:"No deployment"});
  const extension=fs.readFileSync(path.join(root,"src/extension.ts"),"utf8");
  const start=extension.indexOf('case "userProfile":'),end=extension.indexOf('case "backgroundTasks":',start);
  assert(start>=0&&end>start);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const dispatch=new AsyncFunction("msg","respond","vscode","PersonaProfileStore","configureUserProfile","context","getStorePath",`switch(msg.command){${extension.slice(start,end)}}`);
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();fs.rmSync(directory,{recursive:true,force:true});});
  const page=await browser.newPage({viewport:{width:390,height:900}}),errors=[],calls=[];
  page.on("pageerror",error=>errors.push(error.message));
  let input=["Settings user","Engineer","Validation","Updated settings preference","No deployment"];
  host.window.showQuickPick=async()=>assert.fail("Settings must not require Chat or Profile selection");
  host.window.showInformationMessage=async(_title,options)=>options?.modal?"Edit":undefined;
  host.window.showInputBox=async()=>input.shift();
  await page.exposeFunction("settingsHost",async command=>{
    calls.push(command);
    await dispatch({command},reply=>page.evaluate(reply=>userProfileOnSnapshot(reply.data),reply),host,PersonaProfileStore,configureUserProfile,
      {globalStorageUri:{fsPath:path.join(directory,"host")}},()=>path.join(directory,"knowledge"));
  });
  await page.setContent('<main id="detail"></main>');
  await page.addStyleTag({path:path.join(assets,"agent-harness.css")});
  await page.addScriptTag({path:path.join(assets,"agent-harness.js")});
  const script=fs.readFileSync(path.join(root,"src/webview/panel/54-persona-profiles.js"),"utf8");
  assert(fs.readFileSync(path.join(assets,"panel.js"),"utf8").includes(script));
  await page.addScriptTag({content:`const state={tab:'userProfile'};const ask=command=>settingsHost(command);${script};showUserProfileTab();`});
  await page.getByText("<img src=x>Preference text",{exact:true}).waitFor();
  assert.equal(await page.locator("img,script[src=x]").count(),0);
  assert.doesNotMatch(await page.locator("#detail").innerText(),new RegExp(store.user().id));
  await page.getByRole("button",{name:"Edit / manage User Profile",exact:true}).click();
  await page.getByText("Updated settings preference",{exact:true}).waitFor();
  assert.equal(store.user().revision,2);
  assert.deepEqual(calls,["userProfile","userProfileEdit"]);
  await page.getByRole("button",{name:"Refresh",exact:true}).click();
  await until(()=>calls.length===3);
  await page.evaluate(()=>{state.tab="mcp";userProfileOnSnapshot({user:{name:"Late Profile"}});});
  assert.equal(await page.getByText("Late Profile",{exact:true}).count(),0);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await assert.rejects(dispatch({command:"userProfile"},()=>{}, {...host,workspace:{isTrusted:false}},PersonaProfileStore,configureUserProfile,
    {},()=>store.knowledgeRoot),/Trust this workspace/);
  assert.deepEqual(errors,[]);
});
