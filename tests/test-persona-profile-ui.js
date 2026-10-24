const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const Module = require("node:module");
const { PersonaProfileStore } = require("../dist/chat/persona-profiles");
const host = { window:{} };
const originalLoad = Module._load;
let configurePersonaProfiles;
try {
  Module._load = function(name, ...args) { return name === "vscode" ? host : originalLoad.call(this, name, ...args); };
  ({ configurePersonaProfiles } = require("../dist/chat/persona-profile-ui"));
} finally { Module._load = originalLoad; }
const card = { name:"User", role:"Developer", focus:"Correctness", preferences:"Concise", boundaries:"No authority" };
function fixture(t) {
  const directory = path.join(__dirname, `.profile-ui-${randomUUID()}`);
  fs.mkdirSync(directory, { mode:0o700 });
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  return new PersonaProfileStore(path.join(directory, "host"), path.join(directory, "knowledge"));
}
test("Current cards remain inspectable without a model, task or running-state dependency", async t => {
  const store = fixture(t), user = store.save("user", card), shown = [];
  host.window.showQuickPick = async items => items.find(item => item.action === "user");
  host.window.showInformationMessage = async (...args) => { shown.push(args); };
  await configurePersonaProfiles(store, { messages:[], progress:{ status:"running" } }, () => assert.fail("Inspection changed assignment"));
  assert(shown[0][1].detail.includes(`ID: ${user.id}`));
  assert(shown[0][1].detail.includes("revision") || shown[0][0].includes("revision 1"));
  assert(shown[0][1].detail.includes("no automatic cross-device sync"));
  assert.equal(store.user().revision, 1);
});
test("Explicit edits are atomic, cancel discards all fields, and stale editors cannot overwrite a newer revision", async t => {
  const store = fixture(t), original = store.save("user", card);
  host.window.showQuickPick = async items => items.find(item => item.action === "user");
  host.window.showInformationMessage = async () => "Edit";
  let inputs = ["Changed name", undefined];
  host.window.showInputBox = async () => inputs.shift();
  await configurePersonaProfiles(store, { messages:[] }, () => assert.fail("User edit changed assignment"));
  assert.deepEqual(store.user(), original);
  inputs = ["New user", "SDE", "Tests", "Verify first", "Bounded responsibility"];
  host.window.showInputBox = async () => inputs.shift();
  await configurePersonaProfiles(store, { messages:[] }, () => {});
  assert.equal(store.user().revision, 2); assert.equal(store.user().preferences, "Verify first");
  inputs = ["Stale editor", "DS", "Data", "Check data", "No authority"];
  let updated = false;
  host.window.showInputBox = async () => {
    if (!updated) { updated = true; store.save("user", { ...card, preferences:"Concurrent change" }, store.user()); }
    return inputs.shift();
  };
  await assert.rejects(configurePersonaProfiles(store, { messages:[] }, () => {}), /changed in another window/);
  assert.equal(store.user().preferences, "Concurrent change");
});
test("Agent identity requires explicit assignment and historical cards never substitute current profiles", async t => {
  const store = fixture(t), agent = store.save("agent", card), chat = { messages:[], agentProfileId:undefined };
  host.window.showQuickPick = async items => items.find(item => item.action === "assign") || items.find(item => item.id === agent.id);
  await configurePersonaProfiles(store, chat, id => { chat.agentProfileId = id; });
  assert.equal(chat.agentProfileId, agent.id);
  const snapshot = store.capture(agent.id);
  store.save("agent", { ...card, preferences:"New configured focus" }, agent);
  chat.messages = [{ id:"old-reply", role:"assistant", status:"complete", profileContext:snapshot }];
  host.window.showQuickPick = async items => items.find(item => item.action === "history") || items[0];
  let details;
  host.window.showInformationMessage = async (_message, options) => { details = options.detail; };
  await configurePersonaProfiles(store, chat, () => assert.fail("Historical inspection reassigned Agent"));
  assert(details.includes('"revision": 1'));
  assert(!details.includes("New configured focus"));
});
test("Repository Profiles require full preview and local confirmation; cancel, enable and return-private preserve cards",async t=>{
  const store=fixture(t),original=store.save("user",card),shown=[];
  host.window.showQuickPick=async items=>items.find(item=>item.action==="sync");
  host.window.showWarningMessage=async(...args)=>{shown.push(args);return undefined;};
  const assignment=()=>assert.fail("Changing storage implicitly reassigned this Chat");
  await configurePersonaProfiles(store,{messages:[]},assignment);
  assert.equal(store.syncEnabled,false);
  assert(shown[0][1].detail.includes(original.id));
  assert(shown[0][1].detail.includes("not Chat history, credentials or long-term Memory"));
  assert(shown[0][1].detail.includes("approve that repository/branch separately"));
  host.window.showWarningMessage=async()=>"Enable repository Profiles";
  host.window.showInformationMessage=async()=>{};
  await configurePersonaProfiles(store,{messages:[]},assignment);
  assert.equal(store.syncEnabled,true);assert.deepEqual(store.user(),original);
  store.save("user",{...card,preferences:"Root-only preference"},store.user());
  host.window.showWarningMessage=async(...args)=>{shown.push(args);return "Use private Profiles";};
  await configurePersonaProfiles(store,{messages:[]},assignment);
  assert.equal(store.syncEnabled,false);assert.deepEqual(store.user(),original);
  assert(shown.at(-1)[1].detail.includes("deselect Profiles in every GitHub Sync target"));
});
