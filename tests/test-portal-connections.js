const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { PortalConnectionJournal, endpointLabel, endpointScope } = require("../dist/chatroom/portal-connections");
const root=path.join(__dirname,".."),journal=new PortalConnectionJournal();
const owner={chatId:"chat-a",chatLabel:"Local Chat",external:false,localMachine:"Linux"};
const binding={pairId:"pair-a",role:"controller",peerName:"Windows",peerChatName:"Remote Chat",peerEndpoint:"ws://10.0.0.5:7345/path?secret=PRIVATE"};
journal.observe(owner,binding);
const live=new Map([[owner.chatId,{pairId:binding.pairId,connected:true}]]);
let snapshot=journal.snapshot(live);
assert.equal(snapshot.active,1);
assert.equal(snapshot.connections[0].endpoint,"ws://10.0.0.5:7345");
assert(!JSON.stringify(snapshot).includes("PRIVATE"));
assert.equal(snapshot.connections[0].resumable,false);
assert.equal(journal.snapshot(new Map()).connections.length,0,"only live bindings are visible");
assert.equal(new PortalConnectionJournal().snapshot(live).connections.length,0,"a new window restores no connection history");
journal.observe(owner,undefined);
assert.equal(journal.snapshot(live).connections.length,0,"disconnect immediately removes the pairing");
journal.observe(owner,binding);
journal.observe({...owner,chatId:"chat-b",chatLabel:"Controlled Chat"},{...binding,role:"controlled"});
assert.equal(journal.snapshot(new Map([...live,["chat-b",{pairId:"pair-a",connected:true}]])).connections.length,2);
assert(journal.forget("pair-a"));
assert.equal(journal.snapshot(live).connections.length,0);

const detail={style:{},innerHTML:"",querySelectorAll:()=>[]},asks=[];
const source=fs.readFileSync(path.join(root,"src/webview/panel/16-portal-connections.js"),"utf8");
const ui={document:{getElementById:()=>detail},state:{tab:"portalConnections"},
  esc:value=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"),ask:(...args)=>asks.push(args)};
vm.createContext(ui);
vm.runInContext(`${source};this.onSnapshot=portalConnectionsOnSnapshot;this.show=showPortalConnectionsTab`,ui);
ui.show();assert.match(detail.innerHTML,/Loading Portal connections/);
journal.observe(owner,binding);snapshot=journal.snapshot(live);
ui.onSnapshot(snapshot);
assert.match(detail.innerHTML,/1 active/);
assert.match(detail.innerHTML,/Linux[\s\S]*Local Chat/);
assert.doesNotMatch(detail.innerHTML,/History|re-attach|>Remove</);
ui.onSnapshot({connections:[{...snapshot.connections[0],external:true}]});
assert.doesNotMatch(detail.innerHTML,/>Open Chat</,"an external context is not a PKM Chat");
ui.onSnapshot({connections:[{...snapshot.connections[0],state:"ended"}]});
assert.match(detail.innerHTML,/No Portal is connected/);
assert.doesNotMatch(detail.innerHTML,/Local Chat/);
ui.onSnapshot({connections:[],pendingInvitations:[{...owner,role:"controller",expiresAt:Date.now()+60000,endpoint:"ws://localhost:7345"}]});
assert.match(detail.innerHTML,/Copy magic code/);
assert.doesNotMatch(detail.innerHTML,/pkmportal:/);

for(const [endpoint,scope] of [["ws://127.0.0.1:7345","forwarded-localhost"],["ws://[::1]:9","forwarded-localhost"],
  ["wss://10.1.2.3:443","lan"],["wss://172.20.0.1","lan"],["wss://box.local","lan"],["wss://pkm.example.com","remote"],["not a url","unknown"]]){
  assert.equal(endpointScope(endpoint),scope);
}
assert.equal(endpointLabel("bad?secret=private"),"bad");
const extension=fs.readFileSync(path.join(root,"src/extension.ts"),"utf8");
assert.match(extension,/new PortalConnectionJournal\(\)/);
assert.doesNotMatch(extension,/persistPortalResume|readPortalResume|loadPortalResumeIndex|portalWindowBeat/);
assert.match(extension,/operation === "reattach".*temporary/);
assert.match(extension,/await this\.cleanupPortalPersistence\(context\)/);
assert.match(extension,/state !== announced && current\?\.external\) void this\.offerExternalAuthorization/);
assert.match(extension,/binding\.pairId !== grant\.pairId \|\| binding\.role !== grant\.role/);
console.log("Temporary Portal connections: live-only display, no restoration/history, external identity and endpoint privacy passed");
