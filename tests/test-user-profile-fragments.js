const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const Module = require("node:module");
const { ApiChatStore } = require("../dist/chat/api-chat-store");
const { PersonaProfileStore } = require("../dist/chat/persona-profiles");
const { UserProfileFragmentStore, userProfileSources, profileExtractionRequest, parseProfileFragments,
  profileRequirementRequest, parseProfileRequirementMatches, recallProfileRequirements, ProfileRequirementRecallError } = require("../dist/chat/user-profile-fragments");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
let knowledgeRoot, trusted = true;
const host = { workspace:{ get isTrusted() { return trusted; }, getConfiguration:()=>({get:(_key,value)=>value}), workspaceFolders:[] }, window:{} };
const originalLoad = Module._load;
let ApiChatView;
try {
  Module._load = function(name,...args) {
    if (name === "vscode") return host;
    if (name === "../knowledge/filestore") return { getStorePath:()=>knowledgeRoot };
    return originalLoad.call(this,name,...args);
  };
  ({ ApiChatView } = require("../dist/chat/api-chat-view"));
} finally { Module._load = originalLoad; }
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),"pkm-profile-fragments-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  knowledgeRoot = path.join(directory,"knowledge");
  const chats = new ApiChatStore(path.join(knowledgeRoot,".pkm","state"),"a".repeat(16));
  const chat = chats.create(); chat.includeHistory = true;
  chat.messages.push({id:randomUUID(),role:"user",status:"complete",recordedAt:new Date().toISOString(),content:"Always verify changes with focused tests. I prefer a category tree."});
  chats.save(chat);
  const store = new UserProfileFragmentStore(path.join(directory,"host"),knowledgeRoot);
  const provider = new ApiChatView({globalStorageUri:{fsPath:path.join(directory,"host")},subscriptions:[]});
  provider.captureExecution = ()=>({digest:"fixture"});
  provider.assertExecution = ()=>{};
  const errors = []; provider.notify = error=>errors.push(String(error.message||error));
  t.after(()=>provider.dispose());
  return {directory,chats,chat,store,provider,errors};
}
function output(sources) {
  return JSON.stringify({fragments:[{kind:"habit",text:"Verify changes with focused tests.",tags:["testing","verification"],
    evidence:[{source_id:sources[0].id,quote:"Always verify changes with focused tests."}]}]});
}
const amlRequirement = "For AML tasks, avoid the Azure ML ml CLI extension while it cannot be installed.";
const amlSource = "Across chats, for AML tasks, ignore the ml extension because we cannot install it.";
function requirementOutput(sources) {
  return JSON.stringify({fragments:[{kind:"requirement",text:amlRequirement,tags:["AML","ml extension"],
    evidence:[{source_id:sources[0].id,quote:amlSource}]}]});
}
function seedRequirement({store,chat,chats}) {
  chat.messages[0].content=amlSource;chats.save(chat);
  const sources=userProfileSources(chat);
  store.apply(sources,parseProfileFragments(requirementOutput(sources),sources));
  return store.snapshot().fragments.find(fragment=>fragment.kind==="requirement");
}
test("source segmentation preserves all text and excludes agent, Portal, worker and Memory-off traffic",t=>{
  const {chat}=fixture(t), first=chat.messages[0];
  chat.messages.push({ ...first,id:randomUUID(),inputOrigin:"agent" },{...first,id:randomUUID(),role:"assistant"},
    {...first,id:randomUUID(),workerEventIds:["event"]},{...first,id:randomUUID(),portalReview:{id:"review"}},
    {...first,id:randomUUID(),portalSource:{peerId:"remote"}});
  assert.equal(userProfileSources(chat).length,1);
  const long={...first,content:"abcdef ".repeat(1100)};
  const sources=userProfileSources({...chat,messages:[long]});
  assert.equal(sources.map(source=>source.text).join(""),long.content);
  assert.equal(sources.at(-1).end,long.content.length);
  assert.equal(new Set(sources.map(source=>source.id)).size,sources.length);
  const unicode={...first,content:"x".repeat(2999)+"\u{1f9d9}"+"y".repeat(3500)};
  const unicodeSources=userProfileSources({...chat,messages:[unicode]});
  assert.equal(unicodeSources.map(source=>source.text).join(""),unicode.content);
  assert(unicodeSources.every(source=>source.text.length<=3000&&source.text.isWellFormed()));
  assert.deepEqual(userProfileSources({...chat,includeHistory:false}),[]);
  assert.deepEqual(userProfileSources({...chat,workerState:{}}),[]);
});
test("structured fragments require exact evidence, stable IDs, private Root scope, durable dedup and deletion suppression",t=>{
  const {chat,store,directory}=fixture(t), sources=userProfileSources(chat);
  const request=profileExtractionRequest(sources,[]);
  assert.equal(request.purpose,"extract");assert.equal(request.messages.length,2);
  assert.match(request.messages[0].content,/UNTRUSTED DATA/);
  assert.match(request.messages[0].content,/sensitive/);
  const fragments=parseProfileFragments(output(sources),sources);
  store.apply(sources,fragments);store.apply(sources,fragments);
  assert.equal(store.snapshot().fragments.length,1);assert.equal(store.snapshot().processedSources,1);
  assert.equal(store.snapshot().storageTier,"memory");
  assert.equal(JSON.parse(fs.readFileSync(store.filename,"utf8")).storageTier,undefined,"tier metadata does not rewrite existing v1 records");
  assert.deepEqual(store.pending(sources),[]);
  assert.equal(store.snapshot().fragments[0].revision,1);
  assert.equal(store.snapshot().keywords[0].count,1);
  assert.equal(new UserProfileFragmentStore(path.join(directory,"host"),path.join(directory,"other")).snapshot().fragments.length,0);
  assert(!store.filename.startsWith(knowledgeRoot));
  assert.equal(fs.statSync(store.filename).mode&0o777,0o600);
  assert.throws(()=>parseProfileFragments(output(sources).replace("Always verify","Never verify"),sources),/original user message/);
  assert.throws(()=>parseProfileFragments('{"fragments":[{}]}',sources),/Invalid/);
  assert.throws(()=>parseProfileFragments('{"fragments":"text"}',sources),/bounded/);
  assert.deepEqual(parseProfileFragments('{"fragments":[]}',sources),[]);
  const fragment=store.snapshot().fragments[0];
  assert.throws(()=>store.remove(fragment.id,99),/changed/);
  store.remove(fragment.id,fragment.revision);
  assert.equal(store.snapshot().fragments.length,0);
  const again=userProfileSources({...chat,messages:[{...chat.messages[0],id:randomUUID()}]});
  store.apply(again,parseProfileFragments(output(again),again));
  assert.equal(store.snapshot().fragments.length,0,"a removed stable fragment identity must not be silently recreated");
});
test("reusable requirements persist across Chats and Host restarts without becoming habits or accepted preferences",async t=>{
  const fixtureData=fixture(t),{store,chat,chats,provider}=fixtureData;
  const first=seedRequirement(fixtureData);
  const other=chats.create();other.includeHistory=true;
  other.messages.push({...chat.messages[0],id:randomUUID()});chats.save(other);
  const sources=userProfileSources(other);
  store.apply(sources,parseProfileFragments(requirementOutput(sources),sources));
  const restarted=new ApiChatView(provider.extension);t.after(()=>restarted.dispose());
  restarted.runMemoryModel=async()=>assert.fail("reading requirements must not invoke a model");
  const snapshot=await restarted.userProfileFragments("read"),fragment=snapshot.fragments.find(item=>item.id===first.id);
  assert.equal(snapshot.fragments.length,1);assert.equal(fragment.kind,"requirement");
  assert.equal(fragment.text,amlRequirement);assert.equal(fragment.revision,2);
  assert.deepEqual(new Set(fragment.evidence.map(item=>item.chatId)),new Set([chat.id,other.id]));
  const request=profileExtractionRequest(sources,snapshot.fragments);
  assert.match(request.messages[0].content,/applicability conditions/);
  assert.match(request.messages[0].content,/NOT a ban on all AML/);
  assert.equal(JSON.parse(request.messages[1].content).existing[0].kind,"requirement");
});
test("requirement applicability has explicit negative cases, current-input priority and strict source revision/identity checks",async t=>{
  const fixtureData=fixture(t),{store}=fixtureData,fragment=seedRequirement(fixtureData);
  const cases=[
    ["Inspect my AML pipeline run.",true],["Write an AML document.",true],
    ["Help me write a document.",false],["Test PKM.",false],["Improve HTML output.",false],
    ["Ignore the old AML topic and test PKM instead.",false],
    ["The ml extension can now be installed; use it for AML.",false],
  ];
  for (const [query,applicable] of cases) {
    let calls=0;
    const result=await recallProfileRequirements(store,query,async request=>{
      calls++;assert.equal(request.purpose,"intent");
      assert.match(request.messages[0].content,/CURRENT request takes precedence/);
      assert.match(request.messages[0].content,/NOT generic document writing, HTML work, or testing PKM/);
      const input=JSON.parse(request.messages[1].content);
      assert.equal(input.current_request,query);
      assert(input.requirements.every(item=>item.id===fragment.id));
      return {text:JSON.stringify({matches:applicable ? [{id:fragment.id,revision:fragment.revision,request_quote:query}] : []}),
        usage:{inputTokens:40,outputTokens:20}};
    },()=>{},new AbortController().signal,[{role:"user",text:"Earlier AML work"}]);
    assert.equal(calls,1);assert.equal(result.fragments.length,applicable ? 1 : 0,query);
    assert.equal(result.receipt.considered,1);assert.equal(result.receipt.calls[0].usage.inputTokens,40);
  }
  const query="Inspect AML.";
  const match={id:fragment.id,revision:fragment.revision,request_quote:query};
  assert.throws(()=>parseProfileRequirementMatches("not JSON",query,[fragment]),/invalid JSON/);
  for (const invalid of [{...match,id:"unknown"},{...match,revision:99},{...match,request_quote:"unrelated"}]) {
    assert.throws(()=>parseProfileRequirementMatches(JSON.stringify({matches:[invalid]}),query,[fragment]));
  }
  assert.throws(()=>parseProfileRequirementMatches(JSON.stringify({matches:[match,match]}),query,[fragment]),/duplicate/);
  assert.throws(()=>profileRequirementRequest(query,Array(17).fill(fragment)),/sixteen/);
  await assert.rejects(recallProfileRequirements(store,query,async()=>({text:"bad"}),()=>{},new AbortController().signal),error=>{
    assert(error instanceof ProfileRequirementRecallError);
    assert.equal(error.receipt.status,"failed");assert.equal(error.receipt.matches.length,0);
    assert.equal(error.receipt.calls[0].status,"failed");return true;
  });
  await assert.rejects(recallProfileRequirements(store,query,async()=>{
    store.remove(fragment.id,fragment.revision);
    return {text:JSON.stringify({matches:[match]})};
  },()=>{},new AbortController().signal),/changed during selection/);
});
test("requirement selection checks beyond the first batch without dropping older requirements",async t=>{
  const {store,chat,chats}=fixture(t),base=chat.messages[0];
  chat.messages=Array.from({length:17},(_,index)=>({...base,id:randomUUID(),
    content:`Across chats, for project Topic${index}, do not use its unavailable CLI extension.`}));
  chats.save(chat);
  for (const source of userProfileSources(chat)) store.apply([source],parseProfileFragments(JSON.stringify({fragments:[{
    kind:"requirement",text:source.text,tags:["CLI"],evidence:[{source_id:source.id,quote:source.text}],
  }]}),[source]));
  const query="Work on Topic0 and Topic16.",sizes=[];
  const result=await recallProfileRequirements(store,query,async request=>{
    const candidates=JSON.parse(request.messages[1].content).requirements;sizes.push(candidates.length);
    return {text:JSON.stringify({matches:candidates.filter(item=>/Topic(?:0|16),/.test(item.text))
      .map(item=>({id:item.id,revision:item.revision,request_quote:query}))})};
  },()=>{},new AbortController().signal);
  assert.deepEqual(sizes,[16,1]);assert.equal(result.fragments.length,2);
  assert.equal(result.receipt.considered,17);assert.equal(result.receipt.calls.length,2);
});
test("history is background, restartable and model-backed without touching accepted cards or Chat revisions",async t=>{
  const {directory,chats,chat,store,provider}=fixture(t);
  const cards=new PersonaProfileStore(path.join(directory,"host"),knowledgeRoot);
  const card=cards.save("user",{name:"User",role:"",focus:"",preferences:"Accepted preference",boundaries:""});
  let release, calls=0;
  provider.runMemoryModel=async(_chat,request,_signal,used)=>{
    calls++;used.model="fixture-memory-model";
    await new Promise(resolve=>release=resolve);
    return {text:output(JSON.parse(request.messages[1].content).sources),usage:{inputTokens:80,outputTokens:20}};
  };
  assert.equal((await provider.userProfileFragments("read")).fragments.length,0);assert.equal(calls,0);
  const receipt=await provider.userProfileFragments("backfill");
  assert.equal(receipt.queued,true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);
  assert.equal((await provider.userProfileFragments("read")).fragments.length,0,"inspection must not await the model");
  release();await provider.profileLearningTail;
  assert.equal(store.snapshot().fragments.length,1);assert.equal(store.snapshot().activity.status,"complete");
  assert.equal(store.snapshot().activity.model,"fixture-memory-model");
  assert.deepEqual(store.snapshot().activity.usage,{inputTokens:80,outputTokens:20});
  assert.equal(chats.load(chat.id,false).revision,chat.revision,"background learning must not stale a Chat");
  assert.deepEqual(cards.user(),card);
  await provider.userProfileFragments("backfill");await provider.profileLearningTail;
  assert.equal(calls,1,"already inspected source revisions do not call the model again");
  const restarted=new ApiChatView(provider.extension);t.after(()=>restarted.dispose());
  restarted.runMemoryModel=async()=>assert.fail("restart replay invoked the model");
  await restarted.userProfileFragments("backfill");await restarted.profileLearningTail;
  assert.equal(store.snapshot().fragments.length,1);
  trusted=false;
  try { await assert.rejects(provider.userProfileFragments("backfill"),/Trust/); } finally {trusted=true;}
});
test("automatic learning can be disabled; malformed output, cancellation and edited sources never become success",async t=>{
  const {provider,store,chat,chats,errors}=fixture(t);
  let calls=0;
  provider.runMemoryModel=async()=>{calls++;return {text:"not JSON"};};
  await provider.userProfileFragments("automatic",{enabled:false});
  provider.queueProfileLearning(store,"automatic",{chat,inputs:chat.messages});
  await provider.profileLearningTail;
  assert.equal(calls,0);
  await provider.userProfileFragments("backfill");await provider.profileLearningTail;
  assert.equal(store.snapshot().activity.status,"failed");assert.equal(store.snapshot().processedSources,0);
  assert(errors.length);
  provider.runMemoryModel=async(_chat,request)=>{
    const changed=chats.load(chat.id,false);changed.messages[0].content="A corrected statement";chats.save(changed);
    return {text:output(JSON.parse(request.messages[1].content).sources)};
  };
  await provider.userProfileFragments("backfill");await provider.profileLearningTail;
  assert.match(store.snapshot().activity.error,/source changed/);assert.equal(store.snapshot().fragments.length,0);
  provider.runMemoryModel=async(_chat,_request,signal)=>new Promise((_resolve,reject)=>{
    signal.addEventListener("abort",()=>reject(new Error("cancelled")),{once:true});
  });
  await provider.userProfileFragments("backfill");await new Promise(resolve=>setImmediate(resolve));
  await provider.userProfileFragments("cancel");await provider.profileLearningTail;
  assert.equal(store.snapshot().activity.status,"cancelled");assert.equal(store.snapshot().processedSources,0);
  assert.equal(store.snapshot().fragments.length,0);
});
test("production fragment and keyword-cloud renderer filters, links sources, confirms removal and fits narrow themes",async t=>{
  const {store,chat,directory}=fixture(t),sources=userProfileSources(chat);
  store.apply(sources,parseProfileFragments(output(sources),sources));
  const snapshot=store.snapshot(), second=structuredClone(snapshot.fragments[0]);
  second.id="profile_fragment_"+"b".repeat(32);second.kind="caution";second.text="<img src=x>Never deploy automatically.";
  second.tags=["deployment"];snapshot.fragments.push(second);snapshot.keywords.push({term:"deployment",count:1});
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.setContent('<main id="detail"></main>');
  await page.addStyleTag({path:path.join(root,"dist/webview/panel.css")});
  await page.addStyleTag({path:path.join(root,"src/webview/agent-harness.css")});
  await page.addScriptTag({path:path.join(root,"src/webview/agent-harness.js")});
  const script=fs.readFileSync(path.join(root,"src/webview/panel/54-persona-profiles.js"),"utf8");
  await page.addScriptTag({content:`const state={tab:'userProfile'},__calls=[];const ask=(command,params)=>__calls.push({command,params});${script}`});
  await page.evaluate(snapshot=>userProfileOnSnapshot({scope:"Private",fragments:snapshot}),snapshot);
  const tiers=page.getByRole("group",{name:"Cache / Memory / Disk tiers",exact:true});
  assert.equal(await tiers.locator("[data-memory-tier]").count(),3);
  assert.equal(await page.locator('[data-memory-tier-section=memory] .profile-fragment').count(),2);
  assert.match(await page.locator('[data-memory-tier-section=cache]').innerText(),/no selected model context/);
  assert.match(await tiers.locator('[data-memory-tier=disk]').getAttribute("aria-label"),/No accepted Profile card/);
  await tiers.getByRole("button",{name:/^Disk \/ Long-term/}).press("Enter");
  assert.equal(await page.locator('[data-memory-tier-section=disk] > h3').evaluate(node=>node===document.activeElement),true);
  assert.equal(await page.evaluate("__calls.length"),0,"tier navigation is read-only and model-free");
  assert.equal(await page.locator(".profile-fragment").count(),2);
  assert.equal(await page.getByRole("button",{name:"Requirements",exact:true}).count(),1);
  assert.equal(await page.locator("img").count(),0);
  await page.getByRole("button",{name:"deployment",exact:true}).first().click();
  assert.equal(await page.locator(".profile-fragment").count(),1);
  assert.match(await page.locator(".profile-fragment").innerText(),/Never deploy/);
  await page.getByRole("button",{name:"Clear filters",exact:true}).click();
  await page.getByRole("button",{name:"Habits",exact:true}).click();
  assert.equal(await page.locator(".profile-fragment").count(),1);
  await page.getByRole("searchbox",{name:"Search Profile fragments"}).fill("focused");
  await page.locator(".profile-evidence summary").click();
  await page.getByRole("button",{name:"Open source Chat",exact:true}).click();
  assert.equal(await page.evaluate("__calls.at(-1).params.operation"),"source");
  await page.getByRole("button",{name:"Remove fragment",exact:true}).click();
  assert.equal(await page.evaluate("__calls.filter(call=>call.params?.operation==='remove').length"),0);
  await page.getByRole("button",{name:"Confirm remove",exact:true}).click();
  assert.equal(await page.evaluate("__calls.at(-1).params.operation"),"remove");
  await page.getByRole("button",{name:"Backfill history",exact:true}).click();
  assert.equal(await page.evaluate("__calls.at(-1).params.operation"),"backfill");
  await page.getByRole("checkbox").uncheck();
  assert.deepEqual(await page.evaluate("__calls.at(-1).params"),{operation:"automatic",params:{enabled:false},knowledgeRoot:snapshot.knowledgeRoot});
  const search=page.getByRole("searchbox",{name:"Search Profile fragments"});
  await search.focus();
  snapshot.revision++;
  await page.evaluate(snapshot=>userProfileOnSnapshot({scope:"Private",fragments:snapshot}),snapshot);
  await search.waitFor();assert.equal(await search.inputValue(),"focused");
  assert.equal(await search.evaluate(node=>document.activeElement===node),true);
  for (const width of [1100,600,390]) {
    await page.setViewportSize({width,height:850});
    for (const theme of ["vscode-dark","vscode-light","vscode-high-contrast"]) {
      await page.evaluate(theme=>document.body.className=theme,theme);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      assert(await tiers.locator('[data-memory-tier] > span').evaluateAll(nodes=>nodes.every(node=>parseFloat(getComputedStyle(node).fontSize)>=12)));
    }
  }
  const user=new PersonaProfileStore(path.join(directory,"host"),knowledgeRoot).save("user",
    {name:"Accepted user",role:"",focus:"",preferences:"Explicitly accepted preference",boundaries:""});
  await page.evaluate(({snapshot,user})=>userProfileOnSnapshot({scope:"Private",fragments:snapshot,user}),{snapshot,user});
  assert.match(await tiers.locator('[data-memory-tier=disk]').getAttribute("aria-label"),/1 accepted Profile card/);
  assert.equal(await page.locator('[data-memory-tier-section=memory] .profile-fragment').count(),1,"accepted preferences do not reclassify observed fragments");
  await page.locator('.profile-configured-card > summary').click();
  assert.match(await page.locator('[data-memory-tier-section=disk]').innerText(),/Explicitly accepted preference/);
  assert.deepEqual(errors,[]);
});
