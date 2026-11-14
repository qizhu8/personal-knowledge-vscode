const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const { themes, applyTheme } = require("./ui-theme-fixtures");

const webview = path.join(process.env.PKM_ACTIVITY_EXTENSION_ROOT || path.join(__dirname, ".."), "dist", "webview");
test("Chat group menus copy paths without selecting a Chat or collapsing the group", async t => {
  const {page, errors} = await open(t, 390);
  const id = "chat_group_" + "a".repeat(32);
  await page.evaluate(id => {
    __state.library.groups = [{id, name:"Lead candidates"}];
    window.dispatchEvent(new MessageEvent("message", {data:__state}));
    document.getElementById("back").click();
  }, id);
  for (const groupId of [id, "ungroup"]) {
    const group = page.locator(`[data-group-id="${groupId}"]`);
    const wasOpen = await group.evaluate(node => node.open);
    await group.getByRole("button", {name:"Group actions", exact:true}).click();
    await page.getByRole("menuitem", {name:"Copy Path", exact:true}).click();
    const copied = await page.evaluate(() => __posts.filter(post => post.type === "copyChatGroupPath").at(-1));
    assert.equal(copied.id, groupId);
    assert.equal(await group.evaluate(node => node.open), wasOpen);
    await group.locator(":scope > summary").click({button:"right"});
    assert(await page.getByRole("menuitem", {name:"Copy Path", exact:true}).isVisible());
    await page.keyboard.press("Escape");
  }
  assert.deepEqual(errors, []);
});

for (const width of [1280, 390]) test(`Chat navigation clears old history immediately and accepts only the latest target (${width}px)`, async t => {
  const { page, errors } = await open(t, width);
  await page.evaluate(() => {
    __state.chat.messages = [{ id:"old-history", role:"assistant", content:"PRIVATE OLD CHAT HISTORY", status:"complete" }];
    __state.library.groups = [{ id:"pkm", name:"PKM" }, { id:"empty", name:"Empty" }];
    __state.library.chats.push({ id:"other", title:"Other", groupId:"pkm", status:"idle" });
    __state.chats = structuredClone(__state.library.chats);
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
    document.getElementById("prompt").value = "Draft in original Chat";
    document.getElementById("prompt").dispatchEvent(new Event("input"));
    document.getElementById("back").click();
  });
  assert.equal(await page.locator(".chat-group-add").count(), 3, "Ungroup and empty user groups have add buttons, Trash does not");
  const empty = page.locator('[data-group-id="empty"]');
  await empty.locator(".chat-group-add").focus();
  await page.keyboard.press("Enter");
  const create = await page.evaluate(() => __posts.filter(post => post.type === "new").at(-1));
  assert.equal(create.groupId, "empty");
  assert(create.requestId);
  assert(await empty.evaluate(node => node.open), "Group add must not collapse its summary");
  assert.equal(await page.locator("#messages").textContent(), "");
  assert.equal(await page.locator("#messages").getAttribute("aria-busy"), "true");
  assert(await page.locator("#chat-navigation-status").isVisible());
  assert(await page.locator("#composer").isHidden());
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", { data:structuredClone(__state) }));
    window.dispatchEvent(new MessageEvent("message", { data:{ type:"delta", chatId:__state.chat.id, id:"old-history", text:"STALE DELTA" } }));
  });
  assert.equal(await page.locator("#messages").textContent(), "", "Uncorrelated old state/delta cannot restore old history");
  await page.evaluate(requestId => {
    const next = structuredClone(__state);
    next.navigationRequestId = requestId;
    next.chat = { ...next.chat, id:"created", title:"New chat", messages:[] };
    next.chats.push({ id:"created", title:"New chat", groupId:"empty", status:"idle" });
    next.library.chats = structuredClone(next.chats);
    window.__createdState = next;
    window.dispatchEvent(new MessageEvent("message", { data:next }));
  }, create.requestId);
  assert(await page.locator("#composer").isVisible());
  assert.equal(await page.locator("#prompt").inputValue(), "");
  assert.equal(await page.locator("#messages .message").count(), 0);
  await page.selectOption("#chats", "other");
  const first = await page.evaluate(() => __posts.filter(post => post.type === "select").at(-1));
  await page.selectOption("#chats", chatId);
  const latest = await page.evaluate(() => __posts.filter(post => post.type === "select").at(-1));
  assert.notEqual(first.requestId, latest.requestId);
  await page.evaluate(({ first, latest }) => {
    window.__oldTarget = { ...structuredClone(__createdState), navigationRequestId:first.requestId,
      chat:{ ...structuredClone(__createdState.chat), id:"other", messages:[{ id:"wrong", role:"assistant", status:"complete", content:"WRONG TARGET HISTORY" }] } };
    window.dispatchEvent(new MessageEvent("message", { data:__oldTarget }));
    window.dispatchEvent(new MessageEvent("message", { data:{ type:"error", requestId:first.requestId, message:"Stale failure" } }));
    window.dispatchEvent(new MessageEvent("message", { data:{ ...structuredClone(__state), navigationRequestId:latest.requestId } }));
  }, { first, latest });
  assert.match(await page.locator("#messages").textContent(), /PRIVATE OLD CHAT HISTORY/);
  assert.equal(await page.locator("#prompt").inputValue(), "Draft in original Chat");
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data:__oldTarget })));
  assert.doesNotMatch(await page.locator("#messages").textContent(), /WRONG TARGET HISTORY/);
  await page.selectOption("#chats", "other");
  const failed = await page.evaluate(() => __posts.filter(post => post.type === "select").at(-1));
  await page.evaluate(requestId => window.dispatchEvent(new MessageEvent("message", { data:{ type:"error", requestId, message:"Cannot load selected Chat" } })), failed.requestId);
  assert.match(await page.locator("#error").textContent(), /Cannot load selected Chat/);
  assert.equal(await page.locator("#messages").getAttribute("aria-busy"), "false");
  assert.equal(await page.locator("#prompt").inputValue(), "Draft in original Chat");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
});
test("Plan review is readable, context-bound, keyboard-accessible and safe on narrow themed views", async t => {
  const { page, errors } = await open(t, 320);
  await page.evaluate(() => {
    __state.chat.workflowMode = "plan";
    __state.chat.plans = [{ id:"22222222-2222-4222-8222-222222222222", revision:1, contentHash:"a".repeat(64),
      objective:"Inspect <script>untrusted plan text</script>", scope:["Focused endpoint only"], nonGoals:["Other endpoints"],
      facts:["Reproduction exists"], openQuestions:[], risks:["Compatibility"], context:{ cwd:"/workspace", permissionMode:"allow-all" },
      changeReason:"Initial investigated plan", steps:[{ id:"fix", title:"Fix endpoint", dependsOn:[], verification:"Assert HTTP 200 and exact response" }] }];
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
  });
  assert(await page.locator("#plan-review").isVisible());
  assert.match(await page.locator("#plan-body").textContent(), /HTTP 200 and exact response/);
  assert.equal(await page.locator("#plan-body script").count(), 0);
  await page.locator("#approve-plan").focus(); await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => __posts.find(post => post.type === "approvePlan")), {
    type:"approvePlan", chatId, id:"22222222-2222-4222-8222-222222222222", contentHash:"a".repeat(64),
  });
  await page.evaluate(() => {
    __state.busy = true;
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
  });
  assert(await page.locator("#workflow-mode").isDisabled());
  assert(await page.locator("#send").isDisabled());
  assert(await page.locator("#input-mode").isHidden());
  for (const theme of Object.keys(themes)) {
    await applyTheme(page, theme);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.evaluate(() => { document.documentElement.dir = "rtl"; });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => {
    __state.busy = false;
    __state.chat.id = "33333333-3333-4333-8333-333333333333";
    __state.chat.plans = []; __state.chat.workflowMode = undefined;
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
  });
  assert(await page.locator("#plan-review").isHidden());
  assert.equal(await page.locator("#workflow-mode").inputValue(), "chat");
  assert.deepEqual(errors, []);
});
test("message timestamps show persisted local dates and remain stable during streaming and refresh", async t => {
  const { page, errors } = await open(t, 390);
  const sent = "2026-10-29T23:59:58.000Z", replied = "2026-10-30T00:00:02.000Z";
  await page.evaluate(({ sent, replied }) => {
    __state.busy = true;
    __state.chat.messages = [
      { id:"timestamp-user", role:"user", content:"When was this sent?", recordedAt:sent },
      { id:"timestamp-reply", role:"assistant", content:"Streaming", recordedAt:replied, status:"streaming" },
      { id:"timestamp-legacy", role:"user", content:"Legacy message without a timestamp" },
      { id:"timestamp-invalid", role:"assistant", content:"Invalid legacy timestamp", recordedAt:"invalid" },
    ];
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
  }, { sent, replied });
  assert.equal(await page.locator(".message-time").count(), 2);
  for (const [id, at] of [["timestamp-user", sent], ["timestamp-reply", replied]]) {
    const time = page.locator(`[data-message-id="${id}"] > .message-header time`);
    assert.equal(await time.getAttribute("datetime"), at);
    const expected = await page.evaluate(at => ({
      text: new Intl.DateTimeFormat(document.documentElement.lang || "en", {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(new Date(at)),
      title: new Intl.DateTimeFormat(document.documentElement.lang || "en", {dateStyle:"full",timeStyle:"long"}).format(new Date(at)),
    }), at);
    assert.equal(await time.textContent(), expected.text);
    assert.equal(await time.getAttribute("title"), expected.title);
    assert.match(expected.title, /2026/);
    assert(await time.isVisible());
  }
  const before = await page.locator(".message-time").allTextContents();
  await page.evaluate(id => {
    window.dispatchEvent(new MessageEvent("message", { data:{type:"delta",chatId:id,id:"timestamp-reply",text:" more"} }));
    window.dispatchEvent(new MessageEvent("message", { data:structuredClone(__state) }));
  }, chatId);
  assert.deepEqual(await page.locator(".message-time").allTextContents(), before);
  for (const theme of Object.keys(themes)) {
    await applyTheme(page, theme);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  assert.deepEqual(errors, []);
});

test("Portal setup stays on one local Chat card, hides redundant direction and masks private links without saving them",async t=>{
  const {page,errors}=await open(t,390);
  await page.evaluate(()=>{
    __state.decisions=[{id:"portal-local",localOnly:true,title:"Portal setup",detail:"Private local controls",
      secretFields:["link"],fieldVisibility:{role:{field:"connection",values:["Create Portal"]},link:{field:"connection",values:["Accept Portal link"]}},
      choices:[{value:"submit",label:"Connect"},{value:"cancel",label:"Cancel"}],
      form:{type:"object",required:["connection","role"],properties:{
        connection:{type:"string",enum:["Create Portal","Accept Portal link"],default:"Create Portal"},
        role:{type:"string",enum:["Controller","Controlled"],default:"Controller"},
        link:{type:"string",maxLength:4000},
      }}}];
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  const form=page.locator(".chat-question-form");
  assert.equal(await form.locator('fieldset:visible').count(),2);
  await form.getByText("Accept Portal link",{exact:true}).click();
  assert.equal(await form.locator('fieldset:visible').count(),1,"accepting must not ask for direction again");
  const link=form.locator('input[name="link"]');
  assert.equal(await link.getAttribute("type"),"password");
  await link.fill("fixture-private-link");
  await page.getByRole("button",{name:"Connect",exact:true}).click();
  const posts=await page.evaluate(()=>__posts.filter(message=>message.type==="portalDecision"));
  assert.equal(posts.length,1);
  assert.equal(posts[0].answer.link,"fixture-private-link");
  assert.equal(await page.evaluate(()=>JSON.stringify(__saved).includes("fixture-private-link")),false);
  assert.equal(await page.evaluate(()=>__posts.some(message=>message.type==="send"||message.type==="decision")),false);
  await page.evaluate(()=>window.dispatchEvent(new MessageEvent("message",{data:{type:"error",confirmationId:"portal-local",message:"Invalid Portal link."}})));
  assert.equal(await page.getByRole("button",{name:"Connect",exact:true}).isDisabled(),false);
  assert.match(await form.getByRole("alert").textContent(),/Invalid Portal link/);
  assert.equal(await link.inputValue(),"fixture-private-link","rejected input stays available for local correction");
  await page.evaluate(()=>{__state.decisions=[];window.dispatchEvent(new MessageEvent("message",{data:__state}));});
  assert.equal(await page.locator('input[type="password"]').count(),0);
  await page.evaluate(()=>{
    __state.decisions=[{id:"portal-local",localOnly:true,title:"New local card",secretFields:["link"],choices:[{value:"cancel",label:"Cancel"}],
      form:{type:"object",properties:{link:{type:"string",maxLength:4000}}}}];
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  assert.equal(await page.locator('input[name="link"]').inputValue(),"","completed cards discard private drafts");
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);
});

test("retrieval inspector shows actual routing and only explicit reviews, with checkpoint/revocation controls", async t => {
  const {page,errors}=await open(t,390);
  await page.evaluate(()=>{
    __state.chat.sessionId="agent_session_"+"a".repeat(32);__state.chat.includeHistory=true;
    const invocation={requestId:"query",requestedRoute:"dual",servedRoute:"lexical+semantic",semanticStatus:"ready",
      modelInvoked:true,retrievalId:"explicit-receipt",readyGeneration:1,corpusRevision:"fixture",
      onlineLearning:{enabled:true,applied:false,revision:0,ranker_revision:0,calibrator_revision:0,embedding_updated:false},
      adaptive:{reason:"insufficient-feedback",returned_count:2,original_count:2}};
    __state.chat.messages=[{id:"review-reply",role:"assistant",status:"complete",content:"Recorded",
      retrievalLearning:{status:"learned",provenance:"model",judgedSources:1,unknownSources:1,
        selectionApplied:true,relevantSourceIds:["selected-reference"]},
      retrieval:{schema:"pkm.chat.retrieval/v1",chatId:__state.chat.id,query:"query",model:"fixture",selectedCount:0,candidates:[],invocation}}];
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  await page.locator("#memory").click();
  const evidence=page.locator("#retrieval-evidence");
  assert.match(await evidence.innerText(),/dual \/ lexical\+semantic/);
  assert.match(await evidence.innerText(),/Pre-answer model filter applied · 1 unknown/);
  assert.match(await evidence.innerText(),/Relevant sources: selected-reference/);
  await evidence.getByRole("button",{name:"Review relevance",exact:true}).click();
  assert(await page.evaluate(()=>__posts.some(message=>message.type==="reviewRetrieval"&&message.id==="review-reply")));
  await page.evaluate(()=>{
    __state.chat.messages[0].retrieval.invocation.onlineLearning.enabled=false;
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  assert.equal(await evidence.getByRole("button",{name:"Review relevance",exact:true}).count(),0,
    "manual relevance review is unavailable while feedback training is disabled");
  await page.evaluate(()=>{
    __state.chat.messages[0].retrieval.invocation.onlineLearning.enabled=true;
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  assert.equal(await evidence.getByRole("button",{name:"Review relevance",exact:true}).count(),1);
  await evidence.getByRole("button",{name:"Review Task checkpoint",exact:true}).click();
  assert(await page.evaluate(()=>__posts.some(message=>message.type==="taskCheckpoint")));
  await page.evaluate(()=>{
    __state.chat.taskContextCheckpoints=[{id:"checkpoint",taskId:__state.chat.sessionId,sourceInputIds:["old"],
      summary:"Never deploy. Keep the original evidence."}];
    Object.assign(__state.chat.messages[0].retrieval.invocation,{semanticStatus:"fallback",servedRoute:"lexical",reason:"Encoder unavailable"});
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  assert.match(await evidence.innerText(),/dual \/ lexical · semantic fallback/);
  assert.match(await evidence.innerText(),/Encoder unavailable/);
  assert.equal(await evidence.getByRole("button",{name:"Review relevance",exact:true}).count(),0);
  await evidence.locator("summary").click();
  assert.match(await evidence.locator("pre").innerText(),/Never deploy/);
  await evidence.getByRole("button",{name:"Revoke checkpoint",exact:true}).click();
  assert(await page.evaluate(()=>__posts.some(message=>message.type==="revokeTaskCheckpoint")));
  await page.evaluate(()=>{
    __state.busy=true;window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  assert(await evidence.getByRole("button",{name:"Review Task checkpoint",exact:true}).isDisabled());
  await page.evaluate(localization=>{
    __state.busy=false;__state.localization=localization;window.dispatchEvent(new MessageEvent("message",{data:__state}));
  },{locale:"zh-hans",english:JSON.parse(fs.readFileSync(path.join(__dirname,"../resources/locales/en.json"))).strings,
    strings:JSON.parse(fs.readFileSync(path.join(__dirname,"../resources/locales/zh-hans.json"))).strings});
  assert.equal(await evidence.getByRole("button",{name:"审阅 Task 上下文检查点",exact:true}).count(),1);
  await page.evaluate(()=>{
    __state.chat.includeHistory=false;window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  assert.equal(await evidence.getByRole("button",{name:"审阅 Task 上下文检查点",exact:true}).count(),0);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);
});
test("Chat shows credits to two decimal places with exact tooltip values, zero, partial coverage and localized narrow layouts", async t => {
  const { page, errors } = await open(t, 390);
  await page.evaluate(() => {
    const now = Date.now();
    const credits = { source:"provider.copilot_usage.total_nano_aiu", status:"reported", reportedCalls:1, totalCalls:1,
      totalNanoAiu:"1000000001", credits:"1.000000001" };
    window.__state.chat.messages = [{ id:"credit-message", role:"assistant", status:"complete", content:"Recorded",
      usage:{ inputTokens:123, outputTokens:45 }, creditUsage:credits,
      progress:{ attemptId:"credit-attempt", startedAt:now, finishedAt:now, status:"complete",
        steps:[{ label:"Generating response", kind:"model", round:0, at:now, status:"complete" }] },
      budgetReceipts:[{ round:0, ledger:{ providerUsage:{ inputTokens:123, outputTokens:45 }, credits } }],
    }];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  const message = page.locator('[data-message-id="credit-message"]');
  assert.match(await message.locator(":scope > .message-tokens:not(.message-credits)").innerText(), /123 in \/ 45 out tokens/);
  assert.equal(await message.locator(".message-credits").innerText(), "1.00 credits");
  assert.match(await message.locator(".message-credits").getAttribute("title"), /1\.000000001 credits/);
  assert.match(await message.locator(".message-credits").getAttribute("title"), /Memory and workers are accounted separately/);
  await message.locator(".activity > summary").click();
  assert.match(await message.locator(".activity-usage").innerText(), /123 in \/ 45 out.*1\.00 credits/);
  assert.match(await message.locator(".activity-usage").getAttribute("title"), /1\.000000001 credits/);
  assert.doesNotMatch(await message.locator(".activity-usage").innerText(), /Cache usage not reported/);
  assert.match(await message.locator(".activity-usage").getAttribute("title"), /Cache usage not reported/);
  for (const [raw, compact] of [["0.0259776", "0.03"], ["12.345678", "12.35"], ["0.000123456", "0.00"], ["0.72279315", "0.72"]]) {
    await page.evaluate(raw => {
      window.__state.chat.messages[0].budgetReceipts[0].ledger.credits = {
        ...window.__state.chat.messages[0].creditUsage, credits:raw,
      };
      window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
    }, raw);
    assert.match(await message.locator(".activity-usage").textContent(), new RegExp(`${compact.replace(".", "\\.")} credits$`));
    assert((await message.locator(".activity-usage").getAttribute("title")).includes(`${raw} credits`));
    assert.equal(await message.locator(".message-credits").innerText(), "1.00 credits");
    assert.equal(await page.evaluate(() => window.__state.chat.messages[0].budgetReceipts[0].ledger.credits.credits), raw);
  }
  await page.evaluate(() => {
    window.__state.chat.messages[0].budgetReceipts[0].ledger.credits = window.__state.chat.messages[0].creditUsage;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  for (const cached of [0, 100]) {
    await page.evaluate(cached => {
      window.__state.chat.messages[0].budgetReceipts[0].ledger.providerUsage.cachedInputTokens = cached;
      window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
    }, cached);
    const usageText = await message.locator(".activity-usage").textContent();
    if (cached > 0) assert.match(usageText, /123 in \(100 cached\) \/ 45 out/);
    else {
      assert.doesNotMatch(usageText, /cached input|Cache usage not reported/);
      assert.match(usageText, /123 in \/ 45 out.*1\.00 credits/);
    }
    assert.equal(await message.locator(".message-credits").innerText(), "1.00 credits");
  }
  await page.evaluate(() => {
    window.__state.chat.messages[0].budgetReceipts[0].ledger.providerUsage.cachedInputTokens = 124;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.doesNotMatch(await message.locator(".activity-usage").textContent(), /cached|Cache usage not reported/);
  assert.match(await message.locator(".activity-usage").getAttribute("title"), /Cache usage not reported/);
  await page.evaluate(() => {
    Object.assign(window.__state.chat.messages[0].creditUsage, { status:"partial", reportedCalls:1, totalCalls:2, credits:"0", totalNanoAiu:"0" });
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.equal(await message.locator(".message-credits").innerText(), "0.00 credits (partial: 1/2 calls)");
  await page.evaluate(localization => {
    window.__state.localization = localization;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  }, { locale:"zh-hans", english:JSON.parse(fs.readFileSync(path.join(__dirname, "../resources/locales/en.json"))).strings,
    strings:JSON.parse(fs.readFileSync(path.join(__dirname, "../resources/locales/zh-hans.json"))).strings });
  assert.equal(await message.locator(".message-credits").innerText(), "0.00 Credit（不完整：1/2 次调用）");
  assert.match(await message.locator(".activity-usage").getAttribute("title"), /未报告缓存用量/);
  await page.evaluate(() => {
    delete window.__state.chat.messages[0].creditUsage;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.equal(await message.locator(".message-credits").count(), 0);
  await page.evaluate(() => {
    const message = window.__state.chat.messages[0];
    delete message.usage;
    delete message.budgetReceipts;
    message.status = "streaming";
    message.progress.status = "running";
    window.__state.busy = true;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.equal(await message.locator(":scope > .message-tokens").count(), 0);
  assert.equal(await message.locator(".activity-usage:visible").count(), 0);
  assert.doesNotMatch(await message.innerText(), /Usage not reported|Credits not reported|Awaiting token usage/);
  await page.evaluate(() => {
    window.__state.chat.messages[0].creditUsage = { status:"reported", reportedCalls:1, totalCalls:1, credits:"0", totalNanoAiu:"0" };
    window.__state.chat.messages[0].budgetReceipts = [{ round:0, ledger:{ credits:window.__state.chat.messages[0].creditUsage } }];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.equal(await message.locator(".message-credits").innerText(), "0.00 Credit");
  assert.equal(await message.locator(".activity-usage").textContent(), "0.00 Credit");
  await page.evaluate(() => {
    const message = window.__state.chat.messages[0];
    message.usage = { inputTokens:0, outputTokens:0 };
    delete message.creditUsage;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.match(await message.locator(":scope > .message-tokens").innerText(), /0 in \/ 0 out/);
  assert.equal(await message.locator(".message-credits").count(), 0);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
});

test("Chat questions show all choices vertically, preserve typed answers/defaults/drafts and require a single answer", async t => {
  const { page, errors } = await open(t, 390);
  await page.evaluate(() => {
    window.__state.decisions = [{ id:"choices", title:"Choose validation", detail:"Fixture question",
      choices:[{value:"submit",label:"Submit"},{value:"cancel",label:"Cancel"}],
      form:{type:"object",required:["requiredChoice"],properties:{
        requiredChoice:{type:"string",title:"Required choice",enum:["A very long option that should wrap across lines rather than overflow the narrow window","Second option"]},
        single:{type:"integer",title:"One number",enum:[10,20],default:20},
        multi:{type:"array",title:"Several checks",items:{type:"string",enum:["Unit","Browser","Integration"]},default:["Browser"]},
        text:{type:"string",title:"Notes",default:"Keep this draft"},
      }} }];
    window.dispatchEvent(new MessageEvent("message",{data:window.__state}));
  });
  const form = page.locator(".chat-question-form");
  assert.equal(await form.locator("select").count(),0);
  assert.equal(await form.getByRole("radio").count(),4);
  assert.equal(await form.getByRole("checkbox").count(),3);
  for (const input of await form.getByRole("radio").all()) assert(await input.isVisible());
  assert(await form.getByRole("radio",{name:"20",exact:true}).isChecked());
  assert(await form.getByRole("checkbox",{name:"Browser",exact:true}).isChecked());
  await form.getByRole("button",{name:"Clear answer",exact:true}).click();
  await page.evaluate(() => {
    window.__state.decisions[0].detail = "Cleared optional default";
    window.dispatchEvent(new MessageEvent("message",{data:window.__state}));
  });
  assert.equal(await form.getByRole("radio",{name:"20",exact:true}).isChecked(),false,"An explicitly cleared optional answer does not restore its default");
  await page.getByRole("button",{name:"Submit",exact:true}).click();
  assert.equal(await page.evaluate(() => __posts.filter(post => post.type === "decision").length),0);
  await form.getByRole("radio",{name:"Second option",exact:true}).check();
  await form.getByRole("radio",{name:"10",exact:true}).check();
  await form.getByRole("checkbox",{name:"Unit",exact:true}).check();
  await form.getByRole("textbox",{name:"Notes",exact:true}).fill("Edited draft");
  await page.evaluate(() => {
    window.__state.decisions[0].detail = "Updated receipt";
    window.dispatchEvent(new MessageEvent("message",{data:window.__state}));
  });
  assert(await form.getByRole("radio",{name:"10",exact:true}).isChecked());
  assert(await form.getByRole("checkbox",{name:"Unit",exact:true}).isChecked());
  assert.equal(await form.getByRole("textbox",{name:"Notes",exact:true}).inputValue(),"Edited draft");
  const bounds = await form.locator(".chat-question-choice").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
  assert(bounds.every((top,index) => index === 0 || top > bounds[index-1]),"Every option occupies its own row");
  await page.getByRole("button",{name:"Submit",exact:true}).click();
  const result = await page.evaluate(() => __posts.find(post => post.type === "decision"));
  assert.deepEqual(result.answer,{requiredChoice:"Second option",single:10,multi:["Unit","Browser"],text:"Edited draft"});
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors,[]);
});
test("release themes keep Chat controls, settings and tool details readable and reachable", async t => {
  const { page, errors } = await open(t);
  for (const theme of Object.keys(themes)) for (const width of [280, 390, 1280]) {
    await page.setViewportSize({ width, height:720 });
    await applyTheme(page, theme);
    await page.evaluate(() => {
      window.__state.chat.messages = [{ id:"theme-message", role:"assistant", status:"complete", content:"Theme audit",
        toolCalls:[{ id:"theme-command", name:"run_process", status:"complete",
          arguments:JSON.stringify({ program:"python", arguments:["-m","pytest","tests/a_very_long_test_file_name.py"], cwd:"/work/long/project" }), result:"Tests passed" }] }];
      window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
    });
    const activity = page.locator('[data-message-id="theme-message"] > .activity');
    if (!await activity.evaluate(node => node.open)) await activity.locator(":scope > summary").click();
    const tool = activity.locator(".tool-call");
    if (!await tool.evaluate(node => node.open)) await tool.locator(":scope > summary").click();
    const code = tool.locator(".activity-command");
    assert.equal(await code.evaluate(node => getComputedStyle(node).color),
      await page.locator("body").evaluate(node => getComputedStyle(node).color), `${theme}: command text must use theme foreground, not status green`);
    const send = page.locator("#send");
    assert(await send.isVisible(), `${theme}/${width}: send button exists`);
    assert(await send.evaluate(node => {
      const box = node.getBoundingClientRect(), center = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && (center === node || node.contains(center));
    }), `${theme}/${width}: send must be on-screen and not covered`);
    await page.getByRole("button", { name:"Model settings", exact:true }).click();
    const settings = page.getByRole("region", { name:"Model settings", exact:true });
    const profile = settings.locator('[data-agent-config="profiles"]');
    assert(await profile.isVisible());
    assert.equal(await profile.evaluate(node => getComputedStyle(node).color),
      await page.evaluate(() => {
        const probe=document.createElement("span");probe.style.color="var(--vscode-button-secondaryForeground)";document.body.append(probe);
        const color=getComputedStyle(probe).color;probe.remove();return color;
      }), `${theme}: secondary button foreground`);
    assert.equal(await settings.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, `${theme}/${width}: settings containment`);
    await page.getByRole("button", { name:"Model settings", exact:true }).click();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme}/${width}: no horizontal page overflow`);
    assert.equal(await page.locator("#history").evaluate(node => getComputedStyle(node).colorScheme), theme.endsWith("light") ? "light" : "dark");
    if (process.env.PKM_RELEASE_UI_SCREENSHOT && width === 390) await page.screenshot({ path:`${process.env.PKM_RELEASE_UI_SCREENSHOT}-chat-${theme}.png`, fullPage:true });
  }
  assert.deepEqual(errors, []);
});

for (const width of [390, 1280]) test(`file chips and full command disclosures remain safe and readable at ${width}px`, async t => {
  const { page, errors } = await open(t, width);
  await page.evaluate(() => {
    const now = Date.now() - 5000;
    const calls = [
      { id:"read", name:"read_file", arguments:JSON.stringify({ path:"src/runtime.py", startLine:4, endLine:9 }) },
      { id:"edit", name:"replace_text", arguments:JSON.stringify({ path:"tests/test_runtime.py" }),
        result:JSON.stringify({ path:"tests/test_runtime.py", applied:true, attribution:"exact", added:8, removed:7 }) },
      { id:"patch", name:"invoke_vscode_tool", arguments:JSON.stringify({ name:"apply_patch", input:{ input:"*** Begin Patch\n*** Update File: src/a.py\n@@\n-a\n+b\n*** Add File: src/b.py\n+b\n*** End Patch" } }) },
      { id:"write", name:"invoke_vscode_tool", arguments:JSON.stringify({ name:"create_file", input:{ filePath:"src/new.py", content:"fixture" } }) },
      { id:"cmd", name:"run_process", arguments:JSON.stringify({ program:"python", arguments:["-m","pytest","tests/test_runtime.py","<img src=x onerror=window.__unsafe=true>"], cwd:"/work/project" }) },
      { id:"terminal", name:"invoke_vscode_tool", arguments:JSON.stringify({ name:"run_in_terminal", input:{ command:"cd /work/project && npm test\nprintf done" } }) },
    ].map(call => ({ ...call, status:"complete", startedAt:now, finishedAt:now + 100 }));
    window.__state.chat.messages = [{ id:"targets", role:"assistant", status:"complete", content:"Fixture only",
      toolCalls:calls, progress:{ attemptId:"targets", status:"complete", startedAt:now, finishedAt:now + 100,
        steps:calls.map(call => ({ label:`Completed tool: ${call.name}`, toolCallId:call.id, kind:"tool", at:now, status:"complete" })) } }];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  const activity = page.locator('[data-message-id="targets"] .workflow');
  await activity.locator(":scope > summary").click();
  assert.deepEqual(await activity.locator(".activity-file").allTextContents(), ["runtime.py","test_runtime.py","a.py","b.py","new.py"]);
  assert.equal(await activity.locator(".activity-file").first().getAttribute("title"), "src/runtime.py");
  assert.equal(await activity.locator(".activity-lines-added").innerText(), "+8");
  assert.equal(await activity.locator(".activity-lines-removed").innerText(), "-7");
  assert.equal(await activity.locator(".activity-command-preview").count(), 2);
  const command = activity.locator(".activity-event").filter({ has:page.locator(".activity-command-preview") }).first();
  assert.equal(await command.locator(".activity-command").isVisible(), false);
  await command.locator("summary").click();
  assert.match(await command.locator(".activity-command").innerText(), /Working directory: \/work\/project/);
  assert.match(await command.locator(".activity-command").innerText(), /python -m pytest/);
  assert.equal(await command.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.__unsafe)), false);
  assert(await activity.locator(".activity-targets").evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().right <= innerWidth)));
  if (process.env.PKM_ACTIVITY_TARGET_SCREENSHOT) await page.screenshot({ path:`${process.env.PKM_ACTIVITY_TARGET_SCREENSHOT}-${width}.png`, fullPage:true });
  await page.evaluate(() => {
    delete window.__state.chat.messages[0].progress;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  const fallback = page.locator('[data-message-id="targets"] .tool-call');
  assert.equal(await fallback.locator(".activity-file").count(), 5);
  const fallbackCommand = fallback.filter({ has:page.locator(".activity-command-preview") }).first();
  await page.locator('[data-message-id="targets"] details.activity').first().locator(":scope > summary").click();
  await fallbackCommand.locator(":scope > summary").click();
  assert.match(await fallbackCommand.locator(".activity-command").innerText(), /python -m pytest/);
  assert.deepEqual(errors, []);
});

test("feature introduction shows real Chat UI with synthetic messages and no model request", async t => {
  const { page, errors } = await open(t);
  await page.evaluate(() => {
    window.__state.chat.title = "PKM Chat: Daily Work";
    window.__state.chats[0].title = window.__state.chat.title;
    window.__state.library.chats[0].title = window.__state.chat.title;
    window.__state.chat.messages = [
      { id:"feature-user", role:"user", status:"complete", content:"Help me plan today's work and find the reusable Skills for it." },
      { id:"feature-assistant", role:"assistant", status:"complete",
        content:"Keep the work in one place:\n\n- Search your local Knowledge and reuse relevant Skills.\n- Track Tasks and inspect the Harness.\n- Ask for approval before tools change files or run commands.\n- Connect another machine through this Chat's Portal when needed.\n\n*Illustrative UI example; no model request was sent.*" },
    ];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.match(await page.locator("body").innerText(), /Illustrative UI example/);
  assert.equal(await page.evaluate(() => __posts.filter(item => item.type === "send").length), 0);
  if (process.env.PKM_FEATURE_CHAT_SCREENSHOT) await page.screenshot({ path:process.env.PKM_FEATURE_CHAT_SCREENSHOT, fullPage:false });
  assert.deepEqual(errors, []);
});
test("clipboard PNG/JPEG uses image drafts without changing text paste or sending a model request", async t => {
  const { page, errors } = await open(t);
  await page.evaluate(() => {
    window.__state.settings.provider = "vscode";
    window.__state.settings.selectedProfile.imageInput = true;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
    window.__pasteImage = (type = "image/png", size = 24) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([new Uint8Array(size)], "clipboard.png", { type }));
      const event = new ClipboardEvent("paste", { clipboardData, bubbles:true, cancelable:true });
      document.getElementById("prompt").dispatchEvent(event);
      return event.defaultPrevented;
    };
  });
  assert.equal(await page.evaluate(() => window.__pasteImage()), true);
  await page.waitForFunction(() => window.__posts.some(item => item.type === "pasteImages"));
  const pasted = await page.evaluate(() => window.__posts.find(item => item.type === "pasteImages"));
  assert.equal(pasted.chatId, chatId);
  assert.equal(pasted.images[0].mimeType, "image/png");
  assert.equal(pasted.images[0].dataBase64, Buffer.alloc(24).toString("base64"));
  await page.evaluate(image => {
    window.__state.chat.images = [image];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  }, { ...pasted.images[0], dataBase64:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQp8AAAAASUVORK5CYII=" });
  assert.equal(await page.locator("#images img").count(), 1);
  await page.getByRole("button", { name:"Remove image: Pasted image 1.png", exact:true }).click();
  assert(await page.evaluate(() => window.__posts.some(item => item.type === "removeImage" && item.value === 0)));
  const plain = await page.evaluate(() => {
    const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", "ordinary text");
    const event = new ClipboardEvent("paste", { clipboardData, bubbles:true, cancelable:true });
    document.getElementById("prompt").dispatchEvent(event); return event.defaultPrevented;
  });
  assert.equal(plain, false, "ordinary text retains native paste handling");
  await page.evaluate(() => window.__pasteImage("image/jpeg"));
  await page.waitForFunction(() => window.__posts.filter(item => item.type === "pasteImages").length === 2);
  assert.equal(await page.evaluate(() => window.__posts.filter(item => item.type === "pasteImages")[1].images[0].mimeType), "image/jpeg");
  await page.evaluate(() => {
    window.__NativeReader = FileReader;
    window.FileReader = class extends window.__NativeReader {
      readAsDataURL(file) { setTimeout(() => super.readAsDataURL(file), 30); }
    };
    window.__pasteImage();
    window.__state.chat.id = "different-chat";
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  await page.waitForFunction(() => document.getElementById("error").textContent.includes("selected Chat changed"));
  assert.equal(await page.evaluate(() => window.__posts.filter(item => item.type === "pasteImages").length), 2);
  await page.evaluate(id => {
    window.FileReader = window.__NativeReader;
    window.__state.chat.id = id;
    window.__state.chat.images = [window.__state.chat.images[0], window.__state.chat.images[0]];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
    window.__pasteImage();
  }, chatId);
  assert.match(await page.locator("#error").innerText(), /two images/);
  await page.evaluate(() => {
    window.__state.chat.images = [];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  for (const [type, size, expected] of [["image/gif", 24, "PNG/JPEG"], ["image/png", 600000, "512 KB"]]) {
    await page.evaluate(({ type, size }) => window.__pasteImage(type, size), { type, size });
    assert((await page.locator("#error").innerText()).includes(expected));
  }
  await page.evaluate(() => {
    window.__state.settings.provider = "openai-compatible";
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
    window.__pasteImage();
  });
  assert.match(await page.locator("#error").innerText(), /vision-capable/);
  assert.equal(await page.evaluate(() => window.__posts.filter(item => item.type === "pasteImages").length), 2);
  assert.equal(await page.evaluate(() => window.__posts.filter(item => item.type === "send").length), 0);
  assert.deepEqual(errors, []);
});
for (const width of [360, 1280]) test(`Activity categories preserve chronology, filtering and explicit completion at ${width}px`, async t => {
  const { page, errors } = await open(t, width);
  await page.evaluate(() => {
    const now = Date.now() - 10_000;
    window.__state.chat.messages = [{ id:"typed-activity", role:"assistant", status:"complete", content:"Fixture",
      progress:{ attemptId:"typed-attempt", startedAt:now, finishedAt:now + 9000, status:"complete", steps:[
        { label:"Preparing Memory context", category:"info", operation:"preparation", at:now, finishedAt:now + 100, status:"complete" },
        { label:"Memory: understanding the question", category:"llm", operation:"inference", at:now + 100, finishedAt:now + 400, status:"complete" },
        { label:"Counting input tokens with VS Code model", category:"llm", operation:"token-count", at:now + 2000, finishedAt:now + 2100, status:"complete" },
        { label:"Running tool: fixture", kind:"tool", at:now + 3000, status:"complete" },
        { label:"Historical local preparation", at:now + 4000, status:"complete" },
        { label:"Counting output tokens with VS Code model", category:"info", operation:"token-count", at:now + 8000, finishedAt:now + 8100, status:"complete" },
      ] } }];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  const activity = page.locator('[data-message-id="typed-activity"] .workflow');
  await activity.locator(":scope > summary").click();
  const rows = activity.locator("li[data-category]");
  assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.category)), ["info", "llm", "cmd", "info"]);
  const originalOrder = await rows.locator(".activity-label").allTextContents();
  const memoryTimer = rows.nth(1).locator(".elapsed");
  assert.equal(await memoryTimer.evaluate(node => Number(node.dataset.finished) - Number(node.dataset.started)), 300,
    "Memory completion does not include subsequent preparation/retrieval");
  assert.equal(await rows.nth(2).locator(".activity-usage").innerText(), "");
  assert.equal(await activity.getByText("Counting input tokens with VS Code model", { exact:true }).count(), 0);
  assert.equal(await activity.getByText("Counting output tokens with VS Code model", { exact:true }).count(), 0);
  const filter = activity.getByLabel("Activity type filter");
  for (const category of ["llm", "cmd", "info"]) {
    await filter.selectOption(category);
    assert.deepEqual(await rows.evaluateAll(nodes => nodes.filter(node => !node.hidden).map(node => node.dataset.category)),
      category === "llm" ? ["llm"] : category === "cmd" ? ["cmd"] : ["info", "info"]);
  }
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data:window.__state })));
  assert.equal(await filter.inputValue(), "info", "filter survives a live re-render");
  await filter.selectOption("all");
  assert.deepEqual(await rows.locator(".activity-label").allTextContents(), originalOrder);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
});

test("Activity waits with the input wizard and resumes its working wizard without a stale terminal pose", async t => {
  const { page, errors } = await open(t);
  await page.evaluate(() => {
    __state.busy = true;
    __state.chat.status = "completed";
    __state.chat.progress = { attemptId:"wizard-wait", startedAt:Date.now(), status:"running",
      steps:[{ label:"Approve tool", status:"waiting", at:Date.now() }] };
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
  });
  const icon = page.locator('.activity[data-attempt="wizard-wait"] > summary > .chat-status-indicator').first();
  assert.equal(await icon.getAttribute("data-state"), "waiting-input");
  assert.equal(await icon.locator(".wizard-wave").count(), 1);
  await page.evaluate(() => {
    __state.chat.progress.steps.push({ label:"Executing tool", status:"running", at:Date.now() });
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
  });
  assert.equal(await icon.getAttribute("data-state"), "running");
  assert.equal(await icon.locator(".wizard-wave,.wizard-sleeping").count(), 0);
  assert.equal(await icon.locator(".pixel-wizard-frame").count(), 4);
  assert.deepEqual(errors, []);
});

test("running activity is expanded and collapses once the run finishes", async t => {
  const { page, errors } = await open(t, 360);
  await page.evaluate(() => {
    const now = Date.now();
    window.__state.chat.progress = { attemptId:"fold-attempt", startedAt:now, status:"running", steps:[{ label:"Thinking", status:"running", startedAt:now }] };
    window.__state.busy = true;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  const live = page.locator('.activity[data-attempt="fold-attempt"]').first();
  assert.equal(await live.evaluate(node => node.open), true);
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    const now = Date.now();
    const progress = { attemptId:"fold-attempt", startedAt:now - 1000, finishedAt:now, status:"complete", steps:[{ label:"Thinking", status:"complete", startedAt:now - 1000 }] };
    window.__state.chat.progress = undefined;
    window.__state.chat.messages = [{ id:"fold-message", role:"assistant", status:"complete", content:"Done", progress }];
    window.__state.busy = false;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  const finished = page.locator('[data-message-id="fold-message"] .activity[data-attempt="fold-attempt"]');
  assert.equal(await finished.evaluate(node => node.open), false);
  await finished.locator(":scope > summary").click();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data:window.__state })));
  assert.equal(await finished.evaluate(node => node.open), true, "a finished activity the user expands stays expanded");
  assert.deepEqual(errors, []);
});

test("queued message editing preserves draft and focus across completion and requires host hold acknowledgement", async t => {
  const { page, errors } = await open(t, 360);
  await page.evaluate(() => {
    window.__state.chat.queuedInputs = [{ id:"queue-first", text:"First draft", mode:"task" }, { id:"queue-second", text:"Second draft", mode:"task" }];
    window.__state.busy = true;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  await page.getByRole("button", { name:"Edit queued message", exact:true }).first().click();
  const editor = page.getByRole("textbox", { name:"Edit queued message", exact:true });
  await editor.fill("Edited while running");
  assert.equal(await page.getByRole("button", { name:"Save queued message", exact:true }).isDisabled(), true);
  const begin = await page.evaluate(() => window.__posts.find(item => item.type === "beginQueuedEdit"));
  assert.equal(begin.id, "queue-first");
  await page.evaluate(begin => {
    window.__state.chat.queuedInputs[0].editToken = begin.editToken;
    window.__state.busy = false;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  }, begin);
  assert.equal(await editor.inputValue(), "Edited while running");
  assert.equal(await editor.evaluate(node => node === document.activeElement), true);
  assert.equal(await page.getByRole("button", { name:"Run queued inputs", exact:true }).isDisabled(), true);
  const restored = await open(t, 360, await page.evaluate(() => ({ saved:window.__saved, state:window.__state })));
  assert.equal(await restored.page.getByRole("textbox", { name:"Edit queued message", exact:true }).inputValue(), "Edited while running");
  assert.equal(await restored.page.getByRole("button", { name:"Save queued message", exact:true }).isEnabled(), true);
  assert.equal(await restored.page.getByRole("button", { name:"Run queued inputs", exact:true }).isDisabled(), true);
  await page.getByRole("button", { name:"Save queued message", exact:true }).click();
  const save = await page.evaluate(() => window.__posts.find(item => item.type === "saveQueuedEdit"));
  assert.equal(save.text, "Edited while running");
  assert.equal(save.editToken, begin.editToken);
  assert.equal(save.chatId, begin.chatId);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
    data:{ type:"queuedEditRejected", chatId:window.__state.chat.id, id:"queue-first", operation:"saveQueuedEdit" },
  })));
  assert.equal(await editor.inputValue(), "Edited while running", "failed save preserves the editable draft");
  assert.equal(await page.getByRole("button", { name:"Save queued message", exact:true }).isEnabled(), true);
  await page.getByRole("button", { name:"Cancel queued edit", exact:true }).click();
  assert.equal(await page.evaluate(() => window.__posts.find(item => item.type === "cancelQueuedEdit").editToken), begin.editToken);
  assert.equal(await page.evaluate(() => window.__posts.filter(item => item.type === "send" || item.type === "runQueued").length), 0);
  assert.deepEqual(errors, []);
});

test("historical retrieval inspector separates recall, prepared and accepted rounds across four Chat turns", async t => {
  const { page, errors } = await open(t, 360);
  await page.evaluate(() => {
    const receipt = (index, phase) => ({ schema:"pkm.chat.retrieval/v1", chatId:window.__state.chat.id,
      model:"fixture", query:`query-${index}`, phase, selectedCount:1, candidates:[{
        id:`source-${index}`, label:`Evidence ${index}`, kind:"note", method:"semantic", score:0.7,
        sourceUri:`pkm://notes/fixture-${index}`, sourceRevision:`revision-${index}`,
        contentHash:"a".repeat(64), range:{ start:5, end:15, unit:"characters" }, offsetEncoding:"utf16",
        selected:true, evidenceState:phase === "sent" ? "sent" : "selected", reason:"Exact fixture reference",
      }, {
        id:`stale-${index}`, label:"Excluded stale reference", kind:"note", method:"semantic", score:0.2,
        sourceUri:`pkm://notes/stale-${index}`, selected:false, evidenceState:"stale", reason:"Source revision changed",
      }] });
    window.__state.chat.messages = [0, 1, 2, 3].flatMap(index => {
      const sent = index === 0 || index === 3;
      const retrieval = receipt(index, sent ? "sent" : "prepared");
      const budget = { round:0, modelId:`model-${index}`, status:sent ? "sent" : "prepared",
        countingMethod:"utf8-byte-estimate", consumed:{ estimatedInputTokens:150 }, effective:{ inputBudget:1000, outputTokens:200 },
        selectedReferenceIds:[`source-${index}`],
        contextPlan:{ stopReason:"fits", manifest:[{ hash:"plan-hash", referenceIds:[`source-${index}`] }], omittedIds:[], unresolved:[] },
        ...(index !== 2 ? { transport:{ provider:index === 3 ? "vscode" : "http", inputTokens:155,
          countingMethod:index === 3 ? "vscode-countTokens-plus-overhead" : "utf8-byte-estimate", messageHashes:["plan-hash"] } } : {}) };
      return [{ id:`input-${index}`, role:"user", content:`Turn ${index + 1}` },
        { id:`reply-${index}`, role:"assistant", content:"Fixture response", progress:{ attemptId:`attempt-${index}`,
          startedAt:Date.now(), finishedAt:Date.now(), status:"complete", steps:[] },
          budgetReceipts:[budget], ...(index !== 2 ? { retrieval, retrievalActivity:{ attempts:[{ kind:"knowledge", durationMs:3,
            receipt:receipt(index, "recalled") }], rounds:[{ index:0, inputTokens:150, inputBudget:1000, receipt:retrieval }], droppedRounds:0 } } : {}) }];
    });
    const first = window.__state.chat.messages.find(message => message.id === "reply-0");
    first.budgetReceipts.push({ ...structuredClone(first.budgetReceipts[0]),
      round:1, modelId:"second-round-model", status:"prepared", transport:undefined });
    first.retrievalActivity.rounds.push({ index:1, inputTokens:150, inputBudget:1000,
      receipt:receipt(0, "prepared") });
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  await page.locator('[data-message-id="reply-0"] button[aria-label="Memory"]').click();
  const evidence = page.locator("#retrieval-evidence");
  await page.locator("#retrieval-step").selectOption("round-0");
  assert.match(await evidence.innerText(), /query-0/);
  assert.match(await evidence.innerText(), /Accepted transport; not proof of model completion/);
  assert.match(await evidence.innerText(), /HTTP message hash comparison: Match/);
  assert.match(await evidence.innerText(), /150 \/ 1000/);
  await page.evaluate(() => {
    window.__state.chat.messages.find(message => message.id === "reply-0").budgetReceipts[0].transport.messageHashes = ["different-hash"];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.match(await evidence.innerText(), /HTTP message hash comparison: Mismatch/);
  await page.locator("#retrieval-step").selectOption("round-1");
  assert.match(await evidence.innerText(), /second-round-model \/ 2/);
  assert.match(await evidence.innerText(), /Plan prepared; not confirmed sent/);
  await page.locator("#retrieval-step").selectOption("attempt-0");
  assert.match(await page.locator("#retrieval-status").innerText(), /Recall shortlist, not sent context/);
  assert(!/Dispatch evidence:/.test(await evidence.innerText()));
  await page.locator("#retrieval-activity").selectOption("reply-1");
  await page.locator("#retrieval-step").selectOption("round-0");
  assert.match(await evidence.innerText(), /Transport prepared; not confirmed sent/);
  assert.match(await page.locator("#retrieval-status").innerText(), /Prepared context; not confirmed sent/);
  assert(!/Sent context/.test(await page.locator("#retrieval-status").innerText()));
  await page.locator("#retrieval-activity").selectOption("reply-2");
  await page.locator("#retrieval-step").selectOption("round-0");
  assert.match(await evidence.innerText(), /Plan prepared; not confirmed sent/);
  assert.match(await evidence.innerText(), /Actual transport: Not recorded/);
  assert(!/query-1/.test(await evidence.innerText()));
  await page.locator("#retrieval-activity").selectOption("reply-3");
  await page.locator("#retrieval-step").selectOption("round-0");
  assert.match(await evidence.innerText(), /Native message conversion; raw plan hashes are not comparable/);
  await page.locator("#retrieval-candidates .memory-segment").first().click();
  assert.match(await page.locator("#retrieval-candidates").innerText(), /revision-3/);
  assert.match(await page.locator("#retrieval-candidates").innerText(), /\[5, 15\)/);
  await page.locator("#retrieval-candidates .memory-segment").nth(1).click();
  assert.match(await page.locator("#retrieval-candidates").innerText(), /Not selected · stale/);
  assert.match(await page.locator("#retrieval-candidates").innerText(), /Source revision changed/);
  const overflow = await page.locator("#memory-panel").evaluate(node => ({
    width:node.clientWidth, scroll:node.scrollWidth,
    children:[...node.querySelectorAll("*")].filter(child => child.scrollWidth > node.clientWidth)
      .map(child => ({ tag:child.tagName, id:child.id, class:child.className, width:child.scrollWidth })).slice(0, 12),
  }));
  assert(overflow.scroll <= overflow.width + 1, `Hashes and provenance must wrap: ${JSON.stringify(overflow)}`);
  assert.equal(await page.evaluate(() => window.__posts.some(item => item.type === "send")), false);
  assert.deepEqual(errors, []);
});
const chatId = "11111111-1111-4111-8111-111111111111";
for (const width of [1280, 390, 280]) test(`permanently deleted Chats show pending cleanup without restore or automatic replay (${width}px)`, async t => {
  const { page, errors } = await open(t, width);
  await page.evaluate(() => {
    __state = structuredClone(__state);
    __state.chat = null;
    __state.library.chats = [];
    __state.library.deletionCleanups = [{ id:"22222222-2222-4222-8222-222222222222", title:"Deleted fixture " + "x".repeat(150), createdAt:"2026-11-02T00:00:00Z" }];
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
  });
  const trash = page.locator('[data-group-id="trash"]');
  if (!await trash.evaluate(node => node.open)) await trash.locator("summary").click();
  assert.match(await trash.innerText(), /Permanently deleted; cleanup pending. Cannot restore./);
  assert.equal(await trash.locator(".chat-list-count").textContent(), "1");
  assert.equal(await trash.getByRole("button", { name:"Restore Chat", exact:true }).count(), 0);
  assert.equal(await trash.getByRole("button", { name:"Delete All", exact:true }).isDisabled(), false);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "pending cleanup and retry must fit narrow windows");
  assert.equal(await page.evaluate(() => __posts.filter(item => ["deleteChat","emptyTrash"].includes(item.type)).length), 0);
  await trash.getByRole("button", { name:"Retry deletion cleanup", exact:true }).click();
  assert.deepEqual(await page.evaluate(() => __posts.filter(item => item.type === "deleteChat")),
    [{ type:"deleteChat", id:"22222222-2222-4222-8222-222222222222" }]);
  assert.deepEqual(errors, []);
});

test("Profiles action fits its button without spilling into adjacent toolbar controls", async t => {
  const { page } = await open(t);
  for (const width of [320, 360, 1280]) {
    await page.setViewportSize({ width, height:900 });
    await page.locator("#chat-actions-toggle").hover();
    const size = await page.getByRole("button", { name:"User / Agent Profiles", exact:true }).evaluate(element => ({
      client:element.clientWidth, content:element.scrollWidth,
    }));
    assert(size.content <= size.client, `Profiles label overflows at ${width}px: ${JSON.stringify(size)}`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
});

test("Chat picker mirrors groups and nested workers, including collapsed groups and duplicate titles", async t => {
  const { page, errors } = await open(t, 390);
  await page.evaluate(id => {
    const chats = [
      { id, title:"Same title", groupId:"pkm", status:"idle" },
      { id:"worker", title:"Worker", groupId:"ungroup", status:"running", workerParentChatId:id, workerTreeId:"tree" },
      { id:"grandchild", title:"Nested worker", groupId:"ungroup", status:"idle", workerParentChatId:"worker", workerTreeId:"tree" },
      { id:"other", title:"Same title", groupId:"research", status:"idle" },
      { id:"ungrouped", title:"Ungrouped Chat", groupId:"ungroup", status:"idle" },
      { id:"deleted", title:"Deleted Chat", groupId:"pkm", status:"idle", trashedAt:"2026-11-04T00:00:00Z" },
    ];
    chats[0].workerTreeId = "tree";
    __state.chats = chats.filter(chat => !chat.trashedAt);
    __state.library = { groups:[{ id:"pkm", name:"PKM" },{ id:"research", name:"Research <script>" }], chats };
    __state.chat.title = "Same title";
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
  }, chatId);
  const groups = await page.locator("#chats").evaluate(node => [...node.children].map(group => ({
    label:group.label, options:[...group.children].map(option => ({ id:option.value, label:option.textContent, title:option.title })),
  })));
  assert.deepEqual(groups.map(group => group.label), ["Ungroup", "PKM", "Research <script>"]);
  assert.deepEqual(groups[1].options.map(option => option.id), [chatId, "worker", "grandchild"]);
  assert.equal(groups[1].options[1].label, "\u00a0\u00a0> Worker");
  assert.equal(groups[1].options[2].label, "\u00a0\u00a0\u00a0\u00a0> Nested worker");
  assert.match(groups[1].options[2].title, /PKM \/ Same title \/ Worker \/ Nested worker/);
  assert.equal(await page.locator("#chats").inputValue(), chatId);
  assert.match(await page.locator("#chats").getAttribute("title"), /PKM \/ Same title/);
  assert.equal(await page.locator("#chats script").count(), 0);
  assert.equal(await page.locator('#chats option[value="deleted"]').count(), 0);
  await page.locator("#chat-actions-toggle").hover();
  await page.locator("#back").click();
  await page.locator('[data-group-id="pkm"] > summary').click();
  await page.locator('[data-chat-id="other"]').click();
  await page.evaluate(() => {
    const request = __posts.filter(post => post.type === "select").at(-1);
    __state.chat = { ...__state.chat, id:request.id, title:"Other" };
    window.dispatchEvent(new MessageEvent("message", { data:{ ...__state, navigationRequestId:request.requestId } }));
  });
  assert.equal(await page.locator('#chats optgroup[label="PKM"] option').count(), 3, "collapsed groups remain switchable");
  await page.selectOption("#chats", "grandchild");
  const selected = await page.evaluate(() => __posts.filter(post => post.type === "select").at(-1));
  assert.equal(selected.id, "grandchild");
  assert(selected.requestId);
  await page.evaluate(() => {
    const request = __posts.filter(post => post.type === "select").at(-1);
    __state.chat = { ...__state.chat, id:request.id, title:"Nested worker" };
    __state.library.groups[0].name = "Renamed group";
    __state.library.chats.find(chat => chat.id === "other").groupId = "pkm";
    window.dispatchEvent(new MessageEvent("message", { data:{ ...__state, navigationRequestId:request.requestId } }));
  });
  assert.equal(await page.locator('#chats optgroup[label="Renamed group"] option[value="other"]').count(), 1);
  assert.equal(await page.evaluate(() => __posts.some(post => post.type === "send")), false);
  assert.deepEqual(errors, []);
});

for (const width of [280, 390, 1280]) test(`Chat header actions overlay leftward without shrinking the title (${width}px)`, async t => {
  const { page, errors } = await open(t, width);
  const toggle = page.locator("#chat-actions-toggle"), panel = page.locator("#chat-actions-panel");
  await page.evaluate(() => {
    __state.chat.title = __state.chats[0].title = __state.library.chats[0].title = "A long Chat name with important requirements";
    __state.chat.projection = { objectKind:"Run", state:"Completed", nextOwner:"user", reason:"Finished", resume:"Continue" };
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
  });
  assert(await panel.isHidden());
  assert.equal(await page.locator(".chat-toolbar > button").count(), 1, "Back navigation stays outside the action drawer");
  assert(await page.locator(".chat-toolbar > #back").isVisible());
  const before = await page.locator("#chats").boundingBox();
  const back = await page.locator("#back").boundingBox();
  const status = await page.locator("#chat-status > .chat-status-indicator").boundingBox();
  assert.equal(status.width, 28);
  assert(before.width >= width - 56 - status.width - back.width - 6, "Back and the uniform enlarged status slot have explicit width budgets");
  const header = await page.locator(".chat-toolbar").boundingBox();
  assert(header.height <= 44, "the header stays a single compact row");
  await toggle.hover();
  assert(await panel.isVisible());
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  assert.equal((await page.locator("#chats").boundingBox()).width, before.width);
  await panel.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  const bounds = await panel.boundingBox(), arrow = await toggle.boundingBox();
  assert(bounds.x >= 0 && bounds.x + bounds.width <= arrow.x + 1, "the drawer expands left within the viewport");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps:10 });
  assert(await panel.isVisible(), "moving from the arrow onto commands must not close the drawer");
  await page.mouse.move(10, 300);
  assert(await panel.isHidden());
  await toggle.focus();
  assert(await panel.isVisible(), "keyboard focus opens the commands");
  await page.keyboard.press("Tab");
  assert.equal(await page.locator("#persona-profiles").evaluate(node => node === document.activeElement), true);
  await page.keyboard.press("Escape");
  assert(await panel.isHidden());
  assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press("Enter");
  assert(await panel.isVisible(), "click/touch/Enter can open without hovering");
  await page.locator("#copy-chat-id").click();
  assert(await panel.isHidden());
  assert.equal(await page.evaluate(() => __posts.filter(post => post.type === "copyChatId").length), 1);
  await toggle.hover();
  await page.locator("#prompt").click();
  assert(await panel.isHidden(), "clicking outside collapses the drawer");
  if (process.env.PKM_HEADER_SCREENSHOT) {
    await page.screenshot({ path:`${process.env.PKM_HEADER_SCREENSHOT}-${width}-collapsed.png` });
    await toggle.hover();
    await panel.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
    await page.screenshot({ path:`${process.env.PKM_HEADER_SCREENSHOT}-${width}-expanded.png` });
  }
  await page.evaluate(() => {
    __state.portal = { connected:true, binding:{ role:"controlled", peerName:"A very long remote machine name" },
      execution:{ state:"running" } };
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
  });
  assert((await page.locator("#chats").boundingBox()).width >= width - 56 - status.width - back.width - 6, "remote execution uses the same status budget alongside persistent Back navigation");
  assert.match(await page.locator("#chat-status").getAttribute("title"), /Controlled execution/);
  for (const theme of Object.keys(themes)) {
    await applyTheme(page, theme);
    await toggle.hover();
    assert(await panel.isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.evaluate(() => { document.documentElement.dir = "rtl"; });
  await page.mouse.move(10, 300); await toggle.hover();
  await panel.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  const rtl = await panel.boundingBox(), rtlArrow = await toggle.boundingBox();
  assert(rtl.x >= rtlArrow.x + rtlArrow.width - 1 && rtl.x + rtl.width <= width + 1);
  await page.emulateMedia({ reducedMotion:"reduce" });
  assert.equal(await panel.evaluate(node => getComputedStyle(node).animationName), "none");
  assert.deepEqual(errors, []);
});

async function open(t, width = 1280, restored, fakeClock = false) {
  const browser = await chromium.launch({ headless:true, ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath:process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width, height:900 } });
  if (fakeClock) await page.clock.install();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const html = fs.readFileSync(path.join(webview, "api-chat.html"), "utf8")
    .replace(/<meta http-equiv[^>]*>/, "").replace(/<link[^>]*>/g, "").replace(/<script[^>]*><\/script>/g, "");
  await page.route("http://localhost/pkm-chat-fixture", route => route.fulfill({ contentType:"text/html", body:html }));
  await page.goto("http://localhost/pkm-chat-fixture");
  await page.evaluate(({ id, restored }) => {
    window.__posts = [];
    window.acquireVsCodeApi = () => ({ getState:() => restored?.saved || ({ screen:"chat" }), setState:value => { window.__saved = value; }, postMessage:value => window.__posts.push(value) });
    const profile = { id:"fixture", label:"Fixture", status:"active", contextWindow:16384, maxOutputTokens:4096 };
    window.__state = restored?.state || { type:"state", busy:false, chat:{ id, title:"Activity fixture", includeHistory:true, context:[], permissionMode:"ask", messages:[] },
      settings:{ model:"fixture", models:[], provider:"openai-compatible", endpoint:"https://example.test/v1", contextWindow:16384, maxOutputTokens:2048,
        maxToolRounds:30, inputBaseTokens:100, profiles:[profile], selectedProfile:profile },
      chats:[{ id, title:"Activity fixture", groupId:"ungroup", status:"idle" }],
      library:{ groups:[], chats:[{ id, title:"Activity fixture", groupId:"ungroup", status:"idle" }] } };
  }, { id:chatId, restored });
  await page.addStyleTag({ path:path.join(webview, "api-chat.css") });
  await page.route("**/codicon.ttf*", route => route.fulfill({
    body:fs.readFileSync(path.join(webview, "codicon.ttf")), contentType:"font/ttf",
  }));
  await page.addStyleTag({ path:path.join(webview, "codicon.css") });
  await page.addScriptTag({ path:path.join(webview, "marked.umd.js") });
  await page.addScriptTag({ path:path.join(webview, "purify.min.js") });
  await page.addScriptTag({ path:path.join(webview, "api-chat-library.js") });
  await page.addScriptTag({ path:path.join(webview, "agent-harness.js") });
  await page.addScriptTag({ path:path.join(webview, "chat-visualization.js") });
  await page.addScriptTag({ path:path.join(webview, "chat-retrieval-flow.js") });
  await page.addScriptTag({ path:path.join(webview, "api-chat.js") });
  assert(await page.evaluate(() => window.__posts.some(item => item.type === "ready")), "Chat renderer initialized");
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
    window.dispatchEvent(new MessageEvent("message", { data:{ type:"showChat" } }));
  });
  await page.waitForTimeout(30);
  await page.evaluate(() => document.fonts.ready);
  assert.deepEqual(errors, []);
  await page.locator("#prompt").waitFor({ state:"visible" });
  return { page, errors };
}

test("background-process controls follow the reported state and ignore results for another Chat", async t => {
  const { page, errors } = await open(t, 1280, undefined, true);
  const handle = `process_${"a".repeat(64)}`;
  await page.evaluate(handle => {
    window.__state.chat.messages = [{ id:"process-message", role:"assistant", status:"complete", content:"Started",
      toolCalls:[{ id:"process-call", name:"run_process", status:"complete", result:JSON.stringify({
        schema:"pkm.chat.process/v1", handle, state:"running",
      }) }] }];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  }, handle);
  const chatId = await page.evaluate(() => window.__state.chat.id);
  const activity = page.locator('[data-message-id="process-message"] > .activity');
  if (!await activity.evaluate(node => node.open)) await activity.locator(":scope > summary").click();
  const tool = activity.locator(".tool-call");
  if (!await tool.evaluate(node => node.open)) await tool.locator(":scope > summary").click();
  const controls = tool.locator(".process-controls");
  assert.match(await controls.innerText(), /Background process: running/);
  const pause = controls.getByRole("button", { name:"Pause process", exact:true });
  await pause.click();
  assert.equal(await pause.isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => __posts.at(-1)), { type:"processControl", chatId, handle, operation:"pause" });
  await page.clock.fastForward(2500);
  assert.equal(await pause.isDisabled(), false, "a missing or delayed host response must not permanently disable a control");
  await page.evaluate(({ handle, chatId }) => window.dispatchEvent(new MessageEvent("message", { data:{
    type:"processControlResult", chatId, operation:"pause",
    record:{ schema:"pkm.chat.process/v1", handle, state:"paused" },
  } })), { handle, chatId });
  assert.match(await controls.innerText(), /Background process: paused/);
  assert.equal(await controls.getByRole("button", { name:"Pause process", exact:true }).count(), 0);
  const resume = controls.getByRole("button", { name:"Resume process", exact:true });
  assert(await resume.isVisible());
  await page.evaluate(({ handle }) => window.dispatchEvent(new MessageEvent("message", { data:{
    type:"processControlResult", chatId:"another-chat", operation:"status",
    record:{ schema:"pkm.chat.process/v1", handle, state:"completed" },
  } })), { handle });
  assert.match(await controls.innerText(), /Background process: paused/, "another Chat cannot change this process display");
  await resume.click();
  assert.deepEqual(await page.evaluate(() => __posts.at(-1)), { type:"processControl", chatId, handle, operation:"resume" });
  assert(await controls.getByRole("button", { name:"Stop process", exact:true }).isVisible(),
    "the host owns the explicit confirmation before stopping");
  assert.deepEqual(errors, []);
});

for (const width of [1280,390,280]) test(`Model settings keep text and controls separate and explain History without changing its behavior (${width}px)`, async t=>{
  const {page,errors}=await open(t,width);
  await page.getByRole("button",{name:"Model settings",exact:true}).click();
  const settings=page.getByRole("region",{name:"Model settings",exact:true});
  await settings.waitFor();
  const collisions=await settings.evaluate(node=>{
    const button=node.querySelector('[data-agent-config="profiles"]'), heading=node.querySelector("strong");
    const range=document.createRange();range.selectNodeContents(button);
    const text=range.getBoundingClientRect(),box=button.getBoundingClientRect(),title=heading.getBoundingClientRect();
    const fields=[...node.querySelectorAll('label[for="output"],label[for="tool-rounds"],.history-setting')];
    const fieldTextFits=fields.every(label=>{
      const control=label.querySelector("input"),bounds=control.getBoundingClientRect();
      return [...label.childNodes].filter(child=>child.nodeType===Node.TEXT_NODE&&child.textContent.trim()).every(child=>{
        const range=document.createRange();range.selectNodeContents(child);
        return [...range.getClientRects()].every(rect=>rect.right<=bounds.left+1||rect.left>=bounds.right-1||rect.bottom<=bounds.top+1||rect.top>=bounds.bottom-1);
      });
    });
    return {buttonContainsText:text.right<=box.right+1&&text.bottom<=box.bottom+1,
      profileBeforeHeading:box.bottom<=title.top||title.bottom<=box.top||box.right<=title.left,
      contained:node.scrollWidth<=node.clientWidth+1,
      fieldTextFits,
      checkboxWidth:node.querySelector("#history").getBoundingClientRect().width};
  });
  assert.equal(collisions.buttonContainsText,true,"Profile text must fit its button rather than overlap other settings");
  assert.equal(collisions.profileBeforeHeading,true,"Profile button and settings heading must not overlap");
  assert.equal(collisions.contained,true,"settings must not overflow horizontally");
  assert.equal(collisions.fieldTextFits,true,"field label text must not overlap its input or checkbox");
  assert(collisions.checkboxWidth<=20,"History checkbox is not a full-width number input");
  assert.match(await settings.innerText(),/earlier Chat context[\s\S]*does not delete[\s\S]*Profiles/i);
  const history=settings.locator("#history");
  assert.equal(await history.isChecked(),true);
  await history.uncheck();
  assert.deepEqual(await page.evaluate(()=>window.__posts.filter(item=>item.type==="history").at(-1).value),false);
  assert.equal(await page.evaluate(()=>window.__posts.some(item=>["send","startTask"].includes(item.type))),false);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);
  if(process.env.PKM_SETTINGS_SCREENSHOT)await page.screenshot({path:`${process.env.PKM_SETTINGS_SCREENSHOT}-${width}.png`,fullPage:true});
});

test("Chat history pages automatically with an explicit earlier-message count and preserves the visible message", async t => {
  const { page, errors } = await open(t);
  await page.evaluate(() => {
    window.__state.history = { start: 40 };
    window.__state.chat.messages = Array.from({ length: 20 }, (_, index) => ({
      id: `recent-${index}`, role: "user", content: `Recent ${index}\n${"History content\n".repeat(12)}`,
    }));
    window.dispatchEvent(new MessageEvent("message", { data: window.__state }));
  });
  assert.equal(await page.getByRole("button", { name: "Load older messages (40)" }).count(), 1);
  const messages = page.locator("#messages");
  await messages.focus();
  await page.keyboard.press("Control+Home");
  await page.waitForFunction(() => window.__posts.some(item => item.type === "historyPage"));
  assert.deepEqual(await page.evaluate(() => window.__posts.filter(item => item.type === "historyPage")),
    [{ type: "historyPage", chatId, id: "recent-0" }]);
  await messages.evaluate(node => {
    node.dispatchEvent(new Event("scroll"));
    node.dispatchEvent(new Event("scroll"));
  });
  assert.equal(await page.evaluate(() => window.__posts.filter(item => item.type === "historyPage").length), 1);
  const before = await page.locator('[data-message-id="recent-0"]').evaluate(node => node.getBoundingClientRect().top);
  await page.evaluate(id => {
    const response = { type: "historyPage", chatId: id, beforeId: "recent-0", start: 20,
      messages: Array.from({ length: 20 }, (_, index) => ({
        id: `older-${index}`, role: "user", content: `Older ${index}\n${"Earlier content\n".repeat(12)}`,
      })) };
    window.dispatchEvent(new MessageEvent("message", { data: { ...response, chatId: "another-chat" } }));
    window.dispatchEvent(new MessageEvent("message", { data: response }));
  }, chatId);
  assert.equal(await page.locator(".message").count(), 40);
  const after = await page.locator('[data-message-id="recent-0"]').evaluate(node => node.getBoundingClientRect().top);
  assert(Math.abs(after - before) <= 2, `Prepending must preserve the viewport: ${before} -> ${after}`);
  await messages.focus();
  await page.keyboard.press("Control+Home");
  await page.waitForFunction(() => window.__posts.filter(item => item.type === "historyPage").length === 2);
  assert.deepEqual(await page.evaluate(() => window.__posts.filter(item => item.type === "historyPage").at(-1)),
    { type: "historyPage", chatId, id: "older-0" });
  await page.evaluate(id => {
    window.dispatchEvent(new MessageEvent("message", { data: {
      type: "historyPage", chatId: id, beforeId: "older-0", start: 0, messages: [],
    } }));
    document.getElementById("messages").dispatchEvent(new Event("scroll"));
  }, chatId);
  assert.equal(await page.evaluate(() => window.__posts.filter(item => item.type === "historyPage").length), 2);
  assert.deepEqual(errors, []);
});

test("short Chat pages expose earlier user messages without requiring a scroll event", async t => {
  const { page, errors } = await open(t);
  await page.evaluate(() => {
    window.__state.history = { start: 100, total: 102 };
    window.__state.chat.messages = [
      { id:"latest-user", role:"user", content:"Latest question" },
      { id:"latest-reply", role:"assistant", content:"Short visible answer", status:"complete" },
    ];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  const button = page.getByRole("button", { name:"Load older messages (100)" });
  await button.click();
  assert.equal(await page.getByRole("button", { name:"Loading older messages..." }).isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.__posts.filter(item => item.type === "historyPage")),
    [{ type:"historyPage", chatId, id:"latest-user" }]);
  await page.evaluate(id => window.dispatchEvent(new MessageEvent("message", { data:{
    type:"historyPage", chatId:id, beforeId:"latest-user", start:98,
    messages:[{ id:"prior-user", role:"user", content:"My previous sent message" },
      { id:"prior-reply", role:"assistant", content:"Prior reply" }],
  } })), chatId);
  assert.equal(await page.getByText("My previous sent message", { exact:true }).isVisible(), true);
  assert.equal(await page.getByRole("button", { name:"Load older messages (98)" }).count(), 1);
  assert.deepEqual(errors, []);
});

test("latest Chat follows layout growth and Portal updates only while the reader stays at the bottom", async t => {
  const { page, errors } = await open(t);
  const messages = page.locator("#messages");
  await page.evaluate(() => {
    __state.chat.messages = [{ id:"follow-reply", role:"assistant", content:"Latest output\n\n".repeat(100), status:"streaming" }];
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
  });
  const atBottom = () => page.waitForFunction(() => {
    const node = document.getElementById("messages");
    return node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
  }, undefined, { timeout: 3000 });
  await atBottom();
  await page.evaluate(() => {
    const content = document.querySelector("#messages .content");
    const delayed = document.createElement("div");
    delayed.id = "delayed-chat-layout"; delayed.style.height = "220px";
    content.append(delayed);
  });
  await atBottom();
  await page.setViewportSize({ width:390, height:550 });
  await atBottom();
  await page.setViewportSize({ width:900, height:900 });
  await atBottom();
  await page.waitForTimeout(60);
  await page.evaluate(id => window.dispatchEvent(new MessageEvent("message", { data:{
    type:"delta", chatId:id, id:"follow-reply", text:"Progress after enlarging the window\n\n".repeat(12),
  } })), chatId);
  await page.waitForFunction(() => document.getElementById("messages").textContent.includes("Progress after enlarging"));
  await atBottom();
  await page.evaluate(() => {
    if (document.getElementById("delayed-chat-layout")) return;
    const delayed = document.createElement("div");
    delayed.id = "delayed-chat-layout"; delayed.style.height = "220px";
    document.querySelector("#messages .content").append(delayed);
  });
  await atBottom();
  await messages.hover();
  await page.mouse.wheel(0, -180);
  await page.waitForFunction(() => {
    const node = document.getElementById("messages");
    return node.scrollHeight - node.clientHeight - node.scrollTop > 100;
  });
  const top = await messages.evaluate(node => node.scrollTop);
  await page.evaluate(() => { document.getElementById("delayed-chat-layout").style.height = "440px"; });
  await page.waitForTimeout(100);
  assert(Math.abs(await messages.evaluate(node => node.scrollTop) - top) <= 1, "Delayed layout must not move a history reader");
  await page.evaluate(() => {
    __state.chat.portalCommands = [{ requestId:"follow-command", role:"controlled", peerName:"Windows",
      command:{ program:"cmd", arguments:["/c","echo progress"], timeoutSeconds:30 }, startedAt:Date.now(), updatedAt:Date.now(), state:"running" }];
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
  });
  assert(Math.abs(await messages.evaluate(node => node.scrollTop) - top) <= 1, "Portal updates must preserve history position");
  await messages.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await atBottom();
  await page.waitForTimeout(60);
  await page.evaluate(() => {
    __state.chat.messages.push({ id:"follow-new", role:"assistant", content:"New progress\n\n".repeat(15), status:"complete" });
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
  });
  await atBottom();
  await page.evaluate(() => {
    Object.assign(__state.chat.portalCommands[0], { state:"completed",
      result:{ exitCode:0, stdout:"Portal task progress\n".repeat(60), stderr:"" }, updatedAt:Date.now() });
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
  });
  await atBottom();
  assert.match(await page.locator('[data-portal-command="follow-command"]').innerText(), /Completed/);
  assert.deepEqual(errors, []);
});

test("upward mouse wheel is not pulled back to the bottom by streaming updates", async t => {
  const { page, errors } = await open(t);
  await page.evaluate(() => {
    window.__state.busy = true;
    window.__state.chat.messages = [
      { id:"scroll-user", role:"user", content:"Review earlier messages" },
      { id:"scroll-reply", role:"assistant", content:"Streaming output\n\n".repeat(120), status:"streaming" },
    ];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  const messages = page.locator("#messages");
  const bottom = await messages.evaluate(node => node.scrollTop);
  assert(bottom > 200, "fixture must have a scrollable message area");
  await messages.hover();
  // Composer layout can settle after hover; measure from actual wheel delivery.
  await messages.evaluate(node => node.addEventListener("wheel", () => { window.__wheelTop = node.scrollTop; }, { once:true }));
  await page.mouse.wheel(0, -40);
  await page.waitForFunction(() => Number.isFinite(window.__wheelTop)
    && document.getElementById("messages").scrollTop < window.__wheelTop - 10);
  const before = await messages.evaluate(node => node.scrollTop);
  await page.evaluate(id => window.dispatchEvent(new MessageEvent("message", { data:{
    type:"delta", chatId:id, id:"scroll-reply", text:"Additional output",
  } })), chatId);
  await page.waitForTimeout(80);
  const after = await messages.evaluate(node => node.scrollTop);
  assert(Math.abs(after - before) < 2, `Streaming must not undo an upward wheel: ${before} -> ${after}`);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data:structuredClone(window.__state) })));
  assert(Math.abs(await messages.evaluate(node => node.scrollTop) - before) < 2, "Host refresh must preserve the upward scroll too");
  await page.mouse.wheel(0, 10000);
  await page.waitForFunction(() => {
    const node = document.getElementById("messages");
    return node.scrollHeight - node.scrollTop - node.clientHeight < 1;
  });
  await page.evaluate(id => window.dispatchEvent(new MessageEvent("message", { data:{
    type:"delta", chatId:id, id:"scroll-reply", text:"\n\nMore output after returning to the bottom",
  } })), chatId);
  await page.waitForTimeout(80);
  assert(await messages.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 1),
    "Returning to the bottom must resume following new output");
  assert.deepEqual(errors, []);
});

test("upward wheel retrieves earlier messages even when the current page cannot scroll", async t => {
  const { page, errors } = await open(t);
  await page.evaluate(() => {
    window.__state.history = { start:100, total:102 };
    window.__state.chat.messages = [{ id:"wheel-user", role:"user", content:"Latest question" },
      { id:"wheel-reply", role:"assistant", content:"Short reply", status:"complete" }];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  const messages = page.locator("#messages");
  assert.equal(await messages.evaluate(node => node.scrollHeight <= node.clientHeight), true);
  await messages.hover();
  await page.mouse.wheel(0, -100);
  await page.waitForFunction(() => window.__posts.some(item => item.type === "historyPage"));
  assert.deepEqual(await page.evaluate(() => window.__posts.filter(item => item.type === "historyPage")),
    [{ type:"historyPage", chatId, id:"wheel-user" }]);
  assert.deepEqual(errors, []);
});

test("token-counting implementation notices stay out of transcripts while actionable warnings remain visible", async t => {
  const { page, errors } = await open(t);
  const notices = [
    "Copilot SDK models do not expose output token counting. The separate 100,000-byte inference output limit remains active. Bytes are not tokens.",
    "Output token counting is unavailable. The per-inference token limit can only be checked from valid provider usage.",
  ];
  for (const notice of notices) {
    await page.evaluate(notice => {
      __state.chat.messages = [{ id:"technical-notice", role:"assistant", content:"Actual answer", status:"complete", outputBudgetWarning:notice }];
      window.dispatchEvent(new MessageEvent("message", { data:__state }));
    }, notice);
    assert.match(await page.locator("#messages").innerText(), /Actual answer/);
    assert(!(await page.locator("#messages").innerText()).includes(notice));
    assert.equal(await page.evaluate(() => __state.chat.messages[0].outputBudgetWarning), notice, "Diagnostic evidence is retained");
  }
  await page.evaluate(() => {
    __state.chat.messages[0].outputBudgetWarning = "Inference convergence stop: repeated-failure; round 3.";
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
  });
  assert.match(await page.locator("#messages").innerText(), /Inference convergence stop: repeated-failure/);
  assert.deepEqual(errors, []);
});

test("Chat List has no global Portal entry and keeps the draft without submitting", async t => {
  const { page, errors } = await open(t);
  await page.locator("#prompt").fill("Keep my unsent draft");
  assert.equal(await page.locator("#chat-actions-panel").isVisible(), false);
  assert.equal(await page.locator("#back").isVisible(), true);
  await page.getByRole("button", { name:"Back to Chat List", exact:true }).click();
  assert.equal(await page.locator("#peer-collaboration").count(), 0);
  const posts = await page.evaluate(() => window.__posts);
  assert.equal(posts.filter(item => item.type === "peerCollaboration").length, 0);
  assert.equal(posts.filter(item => item.type === "send").length, 0);
  assert(!JSON.stringify(posts).includes("pkmpeer:v1:"));
  assert.equal(await page.locator("#prompt").inputValue(), "Keep my unsent draft");
  assert.deepEqual(errors, []);
});

test("current Chat Portal keeps the draft and binds the exact Chat without opening another conversation", async t => {
  const { page, errors } = await open(t);
  await page.locator("#prompt").fill("Continue testing Windows");
  assert.equal(await page.locator("#chat-portal .portal-closed").count(), 1);
  assert.equal(await page.locator("#chat-portal .portal-side-wizard").count(), 0);
  await page.locator("#chat-actions-toggle").hover();
  await page.getByRole("button", { name: "Chat Portal", exact: true }).click();
  const posts = await page.evaluate(() => window.__posts);
  assert.deepEqual(posts.filter(item => item.type === "peerCollaboration"), [{ type: "peerCollaboration", chatId }]);
  assert.equal(posts.filter(item => ["send", "new", "select"].includes(item.type)).length, 0);
  assert.equal(await page.locator("#prompt").inputValue(), "Continue testing Windows");
  assert.deepEqual(errors, []);
});

test("Chat List hides chat-specific Portal details across updates and restores them only in the Chat", async t => {
  for (const width of [390, 1280]) {
    const { page, errors } = await open(t, width);
    await page.evaluate(() => {
      window.__state.portal = {
        connected: true,
        binding: { role: "controller", peerMachine: "fixture-peer", peerChatName: "Remote fixture" },
      };
      window.dispatchEvent(new MessageEvent("message", { data: window.__state }));
    });
    assert(await page.locator("#portal-state").isVisible());
    await page.locator("#chat-actions-toggle").hover();
    await page.locator("#back").click();
    assert(await page.locator("#library-view").isVisible());
    assert.equal(await page.locator("#portal-state").isVisible(), false);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: window.__state })));
    assert.equal(await page.locator("#portal-state").isVisible(), false, "A Portal refresh must not consume Chat List space.");
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "showChat" } })));
    assert(await page.locator("#portal-state").isVisible(), "Chat-specific connection evidence remains available in its Chat.");
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test("Portal permission labels stay stable across clock ticks and unchanged state refreshes preserve DOM and expanded details", async t => {
  const { page, errors } = await open(t, 390, undefined, true);
  await page.evaluate(() => {
    __state.portal = {connected:true,binding:{role:"controlled",peerName:"Controller fixture"},
      permissions:{active:true,mode:"all",expiresAt:null,now:Date.now(),effective:{"code-execute":true}},
      observations:[{requestId:"stable-task",at:Date.now(),receivedAt:Date.now(),state:"running",answer:"Working"}]};
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
    window.__portalLease=document.querySelector("[data-portal-clock]");
    window.__portalMatrix=document.querySelector("#portal-state details");
    __portalMatrix.open=true;
    document.querySelectorAll("#portal-state details")[1].open=false;
    window.__leaseMutations=0;
    new MutationObserver(records=>__leaseMutations+=records.length).observe(__portalLease,{childList:true,characterData:true,subtree:true});
  });
  const lease=page.locator("[data-portal-clock]");
  assert.equal(await lease.textContent(),"Permissions: all · Until disconnected");
  await page.clock.runFor(2100);
  assert.equal(await lease.textContent(),"Permissions: all · Until disconnected","timer must not remove the permission mode");
  assert.equal(await page.evaluate(()=>__leaseMutations),0,"unchanged leases must not trigger layout mutations every second");
  await page.evaluate(()=>{
    for(let i=0;i<12;i++){
      __state.portal.permissions.now=Date.now()+i;
      window.dispatchEvent(new MessageEvent("message",{data:__state}));
    }
  });
  assert(await page.evaluate(()=>__portalLease===document.querySelector("[data-portal-clock]")&&__portalMatrix===document.querySelector("#portal-state details")));
  assert(await page.locator("#portal-state details").first().evaluate(node=>node.open));
  await page.evaluate(()=>{
    __state.portal.observations[0].answer="Updated progress";
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  assert(await page.locator("#portal-state details").first().evaluate(node=>node.open),"real progress changes retain permission expansion");
  assert.equal(await page.locator("#portal-state details").nth(1).evaluate(node=>node.open),false);
  await page.evaluate(()=>{
    __state.portal.permissions.expiresAt=Date.now()+3000;
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  await page.clock.runFor(1100);
  assert.match(await lease.textContent(),/^Permissions: all · \d+s remaining · expires /);
  await page.clock.runFor(3100);
  assert.equal(await lease.textContent(),"No active reusable authorization");
  assert.match(await page.locator("#portal-state table").textContent(),/code-executeAsk \/ not granted/);
  assert.deepEqual(errors,[]);
});

test("unchanged pending Portal cards still update their visible invitation expiry clock",async t=>{
  const {page,errors}=await open(t,390,undefined,true);
  await page.evaluate(()=>{
    __state.portal={connected:false,pending:{role:"controller",expiresAt:Date.now()+120000,linkAvailable:true}};
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
    window.__pendingTitle=document.querySelector("[data-portal-headline]");
  });
  assert.match(await page.locator("[data-portal-headline]").textContent(),/expires in 2 min/);
  await page.clock.runFor(61000);
  assert.match(await page.locator("[data-portal-headline]").textContent(),/expires in 1 min/);
  assert(await page.evaluate(()=>__pendingTitle===document.querySelector("[data-portal-headline]")));
  assert.deepEqual(errors,[]);
});

test("Portal roles, permission matrix and truthful remote snapshots render without impersonating the user", async t => {
  const { page, errors } = await open(t, 390);
  assert.equal(await page.locator("#chat-portal .portal-closed .portal-ring").count(), 1);
  assert.equal(await page.locator("#pause, #new, #settings").count(), 0);
  await page.evaluate(() => {
    window.__state.portal = { connected:true, endpoint:"wss://DESKTOP-56TITCC:443", binding:{ role:"controller", peerMachine:"DESKTOP-56TITCC", peerChatName:"Windows Sync", peerCapabilities:["observations-v1", "files-v1"] },
      permissions:{ active:true, mode:"scoped", expiresAt:Date.now() + 900000, effective:{ "chat-read":false, "progress-read":true, "code-execute":false } },
      observations:[{ requestId:"remote-task", at:Date.now(), state:"waiting-approval", visibility:"task-only", stage:"Waiting for permission", approvals:[{ title:"Run powershell.exe" }], tools:[{ name:"run_process", status:"running" }] }] };
    window.__state.chat.messages = [{ id:"remote-source", role:"user", content:"Diagnose Sync", portalSource:{ hostname:"linux-controller", endpoint:"wss://linux-controller:7345", chatName:"Build and test", participantId:"peer" } }];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.doesNotMatch(await page.locator("#chat-status").innerText(), /Controlling|Controlled/);
  assert.equal(await page.locator("#chat-portal .portal-open").count(), 1);
  assert.equal(await page.locator("#chat-portal .portal-side-wizard, #chat-portal .pixel-wizard-frame").count(), 0);
  assert.equal(await page.locator("#chat-portal .portal-ring").getAttribute("cx"), "12");
  const openButton = await page.locator("#chat-portal").innerHTML();
  assert.equal(await page.locator("#portal-details").isVisible(),false);
  assert.equal(await page.locator("#portal-state").innerText(),"Portal Connected - Permission scoped");
  assert(await page.locator("#portal-state").evaluate(node=>node.getBoundingClientRect().height<=34),"connection summary must occupy one line");
  await page.locator("#chat-actions-toggle").hover();
  await page.locator("#chat-portal").click();
  assert.deepEqual(await page.evaluate(() => window.__posts.filter(item => item.type === "peerCollaboration")), [{ type: "peerCollaboration", chatId }],
    "clicking an open Portal opens its controls rather than immediately disconnecting");
  await page.locator(".portal-compact").hover();
  assert(await page.locator("#portal-details").isVisible());
  const scene = await page.locator("#portal-state .portal-scene-svg").first().evaluate(svg => {
    const wizard = svg.querySelector(".portal-side-wizard").getBBox(); const ring = svg.querySelector(".portal-ring");
    return { wizardLeft:wizard.x, ringRight:Number(ring.getAttribute("cx")) + Number(ring.getAttribute("rx")),
      facing:svg.querySelector(".portal-side-wizard").dataset.facing, stroke:getComputedStyle(ring).stroke };
  });
  assert(scene.wizardLeft >= scene.ringRight - 0.5, "the controller wizard stands right of the Portal ring");
  assert.equal(scene.facing, "toward-portal");
  assert.equal(scene.stroke, "rgb(62, 166, 255)", "the open Portal is a blue ring of light");
  assert.equal(await page.locator("#chat-status .portal-open .portal-side-wizard").count(), 0, "an outgoing task and historical incoming message must not replace local Chat status");
  assert.equal(await page.locator("#portal-state .portal-side-wizard").getAttribute("data-chat-role"), "controller");
  assert.match(await page.locator("#portal-state").innerText(), /Windows Sync/);
  assert.match(await page.locator("#portal-state").innerText(), /Waiting for remote authorization: Run powershell.exe/);
  assert.match(await page.locator(".portal-message").innerText(), /Controller.*linux-controller.*7345.*Build and test/s);
  assert.doesNotMatch(await page.locator(".portal-message strong").innerText(), /^You$/);
  await page.locator("#portal-state summary").first().click();
  assert.match(await page.locator("#portal-state table").innerText(), /code-execute.*Ask \/ not granted/s);
  assert.match(await page.locator("#portal-state table").innerText(), /file-transfer.*EACH batch/s);
  await page.evaluate(() => {
    window.__state.portal.binding.role = "controlled";
    window.__state.portal.execution = { requestId:"active-command", kind:"command", state:"running" };
    window.__state.portal.observations[0].visibility = "restricted";
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.match(await page.locator("#chat-status").innerText(), /Controlled/);
  assert.equal(await page.locator("#portal-state .portal-side-wizard").getAttribute("data-chat-role"), "controlled");
  assert.equal(await page.locator("#chat-portal").innerHTML(), openButton, "the button depends only on open/closed, not the Portal role");
  const controlledScene = await page.locator("#portal-state .portal-scene-svg").first().evaluate(svg => {
    const wizard = svg.querySelector(".portal-side-wizard").getBBox(); const ring = svg.querySelector(".portal-ring");
    return { wizardRight:wizard.x + wizard.width, ringLeft:Number(ring.getAttribute("cx")) - Number(ring.getAttribute("rx")), facing:svg.querySelector(".portal-side-wizard").dataset.facing };
  });
  assert(controlledScene.wizardRight <= controlledScene.ringLeft + 0.5, "the controlled wizard stands left of the ring");
  assert.equal(controlledScene.facing, "away-from-portal");
  assert.match(await page.locator("#portal-state").innerText(), /Not authorized to share remote progress/);
  await page.evaluate(() => {
    window.__state.portal.connected = false;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.equal(await page.locator("#chat-portal .portal-closed").count(), 1);
  assert.equal(await page.locator("#chat-portal .portal-side-wizard").count(), 0);
  assert.equal(await page.locator("#chat-status .portal-closed").count(), 1);
  assert.match(await page.locator("#portal-state").innerText(), /not live evidence/);
  await page.evaluate(() => {
    window.__state.chat.messages.push({ id:"pkm-review-event", role:"user", content:"Please check controlled chat status.", portalReview:{ id:"event", pairId:"pair", requestId:"request", state:"completed" } });
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.match(await page.locator("#messages").innerText(), /PKM · Portal status event/);
  assert.deepEqual(errors, []);
});

test("Portal connectivity stays independent of local wizard states and only live incoming execution overrides them", async t => {
  const { page, errors } = await open(t, 390);
  await page.evaluate(() => {
    __state.portal = { connected:true, binding:{role:"controlled",peerName:"Controller fixture"}, receipts:[] };
    __state.chat.portalCommands = [{requestId:"old",role:"controlled",state:"running",program:"cmd",arguments:[],peerName:"old peer"}];
    __state.chat.messages = [{id:"old-remote",role:"user",content:"Old remote task",portalSource:{hostname:"old-controller"}}];
  });
  for (const [status, indicator] of [["running","running"],["completed","completed"],["stopped","stopped"],["paused","paused"],["failed","failed"],["awaiting-input","waiting-input"]]) {
    await page.evaluate(status => {
      __state.chats[0].status = status;
      __state.chats[0].portal = __state.portal;
      __state.library.chats = __state.chats;
      window.dispatchEvent(new MessageEvent("message", {data:__state}));
    }, status);
    assert.equal(await page.locator("#chat-status > .chat-status-indicator").getAttribute("data-state"), indicator);
    assert.equal(await page.locator("#chat-status .portal-ring").count(), 1, "Portal role stays visible without changing the local execution state");
    assert.equal(await page.locator("#chat-portal .portal-open").count(), 1);
    assert.equal(await page.evaluate(() => PkmChatRole(__state.chats[0])), "controlled");
  }
  for (const [key, role] of [["workerManager","manager"],["workerParentChatId","worker"]]) {
    await page.evaluate(key => {
      __state.chat[key] = __state.chats[0][key] = "fixture";
      window.dispatchEvent(new MessageEvent("message", {data:__state}));
    }, key);
    assert.equal(await page.locator("#chat-status > .chat-status-indicator").getAttribute("data-chat-role"), role);
    assert.equal(await page.locator(".chat-list-open .chat-status-indicator").getAttribute("data-chat-role"), role);
    await page.evaluate(key => { delete __state.chat[key]; delete __state.chats[0][key]; }, key);
  }
  await page.evaluate(() => {
    __state.portal.binding.role = "controller";
    __state.portal.execution = {requestId:"live",kind:"task",state:"awaiting-approval"};
    window.dispatchEvent(new MessageEvent("message", {data:__state}));
  });
  assert.match(await page.locator("#chat-status").innerText(), /Remote request awaiting approval/);
  assert.equal(await page.locator("#chat-status .portal-side-wizard").getAttribute("data-chat-role"), "controlled", "duplex direction comes from execution, not saved pairing role");
  await page.evaluate(() => {
    __state.portal.execution.state = "running";
    __state.portal.execution.kind = "command";
    window.dispatchEvent(new MessageEvent("message", {data:__state}));
  });
  assert.match(await page.locator("#chat-status").innerText(), /Controlled execution/);
  assert.equal(await page.evaluate(() => PkmChatDisplayStatus(__state.chats[0])), "running");
  await page.evaluate(() => {
    __ownerChat = __state.chat;
    __ownerPortal = __state.portal;
    const portal = {connected:true,binding:{role:"controlled",peerName:"Other peer"}};
    __state.chat = {...__state.chat,id:"22222222-2222-4222-8222-222222222222",messages:[]};
    const item = {...__state.chats[0],id:__state.chat.id,status:"paused",portal};
    __state.chats.push(item);
    __state.portal = portal;
    window.dispatchEvent(new MessageEvent("message", {data:__state}));
  });
  assert.equal(await page.locator("#chat-status .portal-scene").count(), 0, "another connected Chat does not inherit incoming execution");
  assert.equal(await page.locator('#chat-status > [data-state="paused"]').count(), 1);
  assert.equal(await page.locator('.chat-list-open .chat-status-indicator[data-chat-role="controlled"]').count(), 2, "both paired Chats retain the role while only the execution owner is running");
  assert.equal(await page.locator('.chat-list-open .chat-status-indicator[data-chat-role="controlled"][data-state="running"]').count(), 1);
  await page.evaluate(() => {
    __state.chat = __ownerChat;
    __state.portal = __ownerPortal;
    delete __state.portal.execution;
    __state.chats[0].status = "paused";
    window.dispatchEvent(new MessageEvent("message", {data:__state}));
  });
  assert.equal(await page.locator("#chat-status > .chat-status-indicator").getAttribute("data-state"), "paused");
  assert.equal(await page.locator("#chat-status .portal-scene").count(), 0);
  assert.equal(await page.locator("#chat-portal .portal-open").count(), 1);
  for (const theme of Object.keys(themes)) {
    await applyTheme(page, theme);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  assert.deepEqual(errors, []);
});

test("composer clears before the sending bubble/Host dispatch; rejection preserves the submitted text and newer draft", async t => {
  const { page, errors } = await open(t);
  await page.locator("#prompt").fill("Original request");
  const immediate = await page.evaluate(() => {
    document.getElementById("composer").requestSubmit();
    return { draft:document.getElementById("prompt").value, bubble:document.querySelector("[data-submission-id] .content")?.textContent, saved:window.__saved.drafts,
      invalid:[...document.querySelectorAll(":invalid")].map(node => [node.id, node.value, node.validationMessage]), disabled:document.getElementById("send").disabled, posts:window.__posts };
  });
  assert.equal(immediate.draft, "", JSON.stringify(immediate));
  assert.equal(immediate.bubble, "Original request");
  assert.equal(immediate.saved[chatId], "");
  await page.waitForFunction(() => window.__posts.some(item => item.type === "send"));
  await page.locator("#prompt").fill("New draft");
  await page.evaluate(() => {
    const send = window.__posts.find(item => item.type === "send");
    window.dispatchEvent(new MessageEvent("message", { data:{ type:"error", message:"Preflight rejected", chatId:send.chatId, submissionId:send.submissionId } }));
  });
  assert.equal(await page.locator("#prompt").inputValue(), "Original request\n\nNew draft");
  assert.equal(await page.locator("[data-submission-id]").count(), 0);
  assert.match(await page.locator("#error").innerText(), /Preflight rejected/);
  assert.deepEqual(errors, []);
});

test("delayed acceptance does not clear an identical new draft", async t => {
  const { page, errors } = await open(t);
  await page.locator("#prompt").fill("Same text");
  await page.locator("#send").click();
  await page.waitForFunction(() => window.__posts.some(item => item.type === "send"));
  await page.locator("#prompt").fill("Same text");
  await page.evaluate(() => {
    const send = window.__posts.find(item => item.type === "send");
    window.dispatchEvent(new MessageEvent("message", { data:{ type:"sendAccepted", chatId:send.chatId, submissionId:send.submissionId } }));
    window.__state.chat.messages.push({ id:"u1", role:"user", content:send.text, status:"complete", submissionId:send.submissionId });
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.equal(await page.locator("#prompt").inputValue(), "Same text");
  assert.equal(await page.locator("[data-submission-id]").count(), 0);
  assert.deepEqual(errors, []);
});

test("all nine Chat states have wizard artwork, distinct waiting animations and accessible motion fallbacks", async t => {
  const { page, errors } = await open(t);
  const states = ["running", "idle", "awaiting-input", "awaiting-result", "completed", "new-result", "paused", "stopped", "failed"];
  const inspect = () => page.evaluate(states => {
    document.getElementById("wizard-matrix")?.remove();
    const root = document.createElement("section"); root.id = "wizard-matrix"; document.body.append(root);
    return states.flatMap(state => [undefined, "manager", "worker", "controller", "controlled"].map(role => {
      const icon = PkmChatStatusIndicator(state, role); root.append(icon);
      return { state, role, svg:!!icon.querySelector(".pixel-wizard,.portal-side-wizard"), label:icon.getAttribute("aria-label"),
        unread:icon.dataset.unread, wave:!!icon.querySelector(".wizard-wave"), glass:!!icon.querySelector(".wizard-hourglass"),
        cup:!!icon.querySelector(".wizard-break-cup"), idle:icon.classList.contains("wizard-idle"),
        sleeping:icon.classList.contains("wizard-sleeping"), snore:icon.querySelector(".wizard-zzz")?.textContent,
        size:[icon.getBoundingClientRect().width, icon.getBoundingClientRect().height],
        artworkSize:[icon.querySelector("svg").getBoundingClientRect().width, icon.querySelector("svg").getBoundingClientRect().height],
        sleepingArtwork:icon.classList.contains("wizard-sleeping") ? icon.querySelector("svg").innerHTML : undefined,
        artwork:icon.querySelector("svg").innerHTML,
        unreadEnvelope:!!icon.querySelector(".wizard-unread"),
        clothingColors:[...icon.querySelectorAll(".wizard-clothing")].map(part => getComputedStyle(part).fill),
        trimColors:[...icon.querySelectorAll(".wizard-clothing-trim")].map(part => getComputedStyle(part).fill),
        stateAttr:icon.dataset.state,
        portalCount:icon.querySelectorAll(".portal-ring").length,
        portalColor:icon.querySelector(".portal-ring") ? getComputedStyle(icon.querySelector(".portal-ring")).stroke : undefined,
        attention:icon.querySelectorAll(".wizard-attention").length,
        light:getComputedStyle(icon,"::before").backgroundColor,
        lightBorder:getComputedStyle(icon,"::before").borderColor,
        lightRadius:getComputedStyle(icon,"::before").borderRadius,
        motions:[...icon.querySelectorAll(".wizard-wave,.wizard-sand,.wizard-hourglass,.wizard-unread,.wizard-break-breathe,.pixel-wizard-frame,.wizard-snore,.wizard-eye")]
          .map(node => ({ name:getComputedStyle(node).animationName, play:getComputedStyle(node).animationPlayState })) };
    }));
  }, states);
  const normal = await inspect();
  for (const item of normal) {
    assert(item.svg && item.label, JSON.stringify(item));
    const clothing = item.role === "manager" ? "rgb(207, 98, 98)" : item.role === "worker" ? "rgb(84, 168, 108)" : "rgb(153, 131, 206)";
    const trim = item.role === "manager" ? "rgb(242, 177, 177)" : item.role === "worker" ? "rgb(181, 224, 192)" : "rgb(200, 180, 239)";
    assert(item.clothingColors.length && item.trimColors.length, "each pose exposes clothing, not skin or equipment, for role colors");
    assert(item.clothingColors.every(color => color === clothing), `${item.state}/${item.role}: consistent garment color`);
    assert(item.trimColors.every(color => color === trim), `${item.state}/${item.role}: matching garment trim`);
    assert.deepEqual(item.size, [28, 28], `${item.state}/${item.role}: uniform status slot`);
    assert.deepEqual(item.artworkSize, [28, 28], `${item.state}/${item.role}: enlarged artwork`);
    assert.equal(item.portalCount, ["controller","controlled"].includes(item.role) ? 1 : 0);
    if (item.portalCount) assert.equal(item.portalColor, "rgb(62, 166, 255)");
    if (item.state === "idle") assert.equal(item.sleepingArtwork,
      normal.find(other => other.state === "completed" && other.role === item.role).sleepingArtwork,
      "Idle and Completed use exactly the same desk-sleep artwork");
    if (item.state === "awaiting-input") {
      assert(item.wave); assert(!item.cup); assert.equal(item.attention,0);
      assert.equal(item.light,"rgb(227, 179, 65)");
    }
    if (item.state === "awaiting-result") { assert(item.glass); assert(!item.cup); }
    if (item.state === "idle") {
      assert(item.idle); assert(!item.cup); assert(item.sleeping); assert.equal(item.snore, "zZZ");
      assert.equal(item.stateAttr, "idle"); assert.match(item.label, /Idle/);
      assert.equal(item.light, "rgba(0, 0, 0, 0)", "idle status light is hollow");
      assert.equal(item.lightBorder, "rgb(82, 187, 128)", "idle status light uses completion green");
      assert.equal(item.lightRadius, "50%", "idle status light is circular");
    }
    if (item.state === "completed") assert.equal(item.light, "rgb(82, 187, 128)", "completed status remains solid green");
    assert.equal(item.unread === "true", item.state === "new-result");
    if (item.state === "new-result") {
      assert.equal(item.artwork, normal.find(other => other.state === "stopped" && other.role === item.role).artwork,
        "unread completion uses the stopped artwork, differing only in the green status light");
      assert.equal(item.light, "rgb(82, 187, 128)");
      assert.equal(item.stateAttr, "completed", "visual stopped pose does not change completion status");
      assert.match(item.label, /Completed: unread result/);
      assert.equal(item.unreadEnvelope, false);
    }
    assert(item.motions.length || item.state === "failed", JSON.stringify(item));
  }
  const poses = () => page.locator("#wizard-matrix .wizard-wave,#wizard-matrix .wizard-sand")
    .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).transform));
  const before = await poses();
  await page.waitForTimeout(380);
  assert.notDeepEqual(await poses(), before, "waiting poses actually move rather than only naming a keyframe");
  await page.evaluate(() => document.body.classList.add("chat-backgrounded"));
  for (const item of await inspect()) assert(item.motions.every(motion => motion.play === "paused"));
  await page.evaluate(() => document.body.classList.remove("chat-backgrounded"));
  await page.emulateMedia({ reducedMotion:"reduce" });
  for (const item of await inspect()) assert(item.motions.every(motion => motion.name === "none"));
  assert.deepEqual(errors, []);
});

test("waiting-result hourglass flips repeatedly around its center without rotating the wizard", async t => {
  const { page, errors } = await open(t);
  await page.evaluate(() => {
    const icon = PkmChatStatusIndicator("awaiting-result"); icon.id = "hourglass-flip-check"; document.body.append(icon);
    for (const animation of icon.getAnimations({ subtree:true })) animation.pause();
  });
  const frame = time => page.locator("#hourglass-flip-check").evaluate((icon, time) => {
    const glass = icon.querySelector(".wizard-hourglass");
    for (const animation of glass.getAnimations({ subtree:true })) animation.currentTime = time;
    return { glass:getComputedStyle(glass).transform, wizard:getComputedStyle(icon.querySelector(".wizard-break-breathe")).transform,
      sandY:glass.querySelector(".wizard-sand").getBoundingClientRect().y,
      sandBottom:glass.querySelector(".wizard-sand").getBoundingClientRect().bottom,
      floorY:Math.max(...[...glass.querySelectorAll(".wizard-hourglass-cap")].map(cap => cap.getBoundingClientRect().top)),
      iterations:getComputedStyle(glass).animationIterationCount, origin:getComputedStyle(glass).transformOrigin };
  }, time);
  const start = await frame(0), flipped = await frame(2000), repeated = await frame(6000);
  assert.equal(start.glass, "matrix(1, 0, 0, 1, 0, 0)");
  assert.equal(flipped.glass, "matrix(-1, 0, 0, -1, 0, 0)");
  assert.equal(repeated.glass, flipped.glass);
  assert.equal(flipped.iterations, "infinite");
  assert.equal(flipped.origin, "3px 5px");
  assert.equal(flipped.wizard, start.wizard);
  assert.notEqual((await frame(1800)).glass, start.glass, "the turn has intermediate frames");
  for (const [early,late] of [[0,1600],[2000,3600],[4000,5600],[6000,7600]]) {
    assert((await frame(late)).sandY > (await frame(early)).sandY, `sand falls downward at ${early}ms, even after inversion`);
  }
  assert.equal((await frame(1600)).sandY,(await frame(3600)).sandY, "both orientations drain to the same lower chamber");
  for (const time of [1600,3600,5600,7600]) {
    const drained = await frame(time);
    assert(Math.abs(drained.sandBottom - drained.floorY) < .01, `sand rests directly on the lower cap at ${time}ms`);
  }
  assert.deepEqual(errors, []);
});

test("Portal direction preserves ordinary, manager and worker clothes in every state", async t => {
  const {page, errors} = await open(t);
  const results = await page.evaluate(() => {
    return ["controller", "controlled"].flatMap(direction => [undefined, "manager", "worker"].flatMap(clothing => {
      const chat = {manager:clothing === "manager", workerParentChatId:clothing === "worker" ? "parent" : undefined,
        portal:{binding:{role:direction}}};
      return ["running", "idle", "awaiting-input", "awaiting-result", "completed", "new-result", "paused", "stopped", "failed"].map(status => {
        const icon = PkmChatStatusIndicator(status, PkmChatRole(chat), PkmChatClothingRole(chat));
        document.body.append(icon);
        const result = {direction, clothing, status, role:icon.dataset.chatRole,
          colors:[...icon.querySelectorAll(".wizard-clothing")].map(part => getComputedStyle(part).fill),
          rings:icon.querySelectorAll(".portal-ring").length};
        icon.remove(); return result;
      });
    }));
  });
  for (const result of results) {
    assert.equal(result.role, result.direction);
    assert.equal(result.rings, 1);
    const expected = result.clothing === "manager" ? "rgb(207, 98, 98)" : result.clothing === "worker" ? "rgb(84, 168, 108)" : "rgb(153, 131, 206)";
    assert(result.colors.length && result.colors.every(color => color === expected), JSON.stringify(result));
  }
  assert.deepEqual(errors, []);
});

test("Portal header, details and Chat List update clothes when the base role changes", async t => {
  const {page, errors} = await open(t);
  for (const direction of ["controller", "controlled"]) for (const baseRole of ["manager", "worker", "chat"]) {
    await page.evaluate(({direction, baseRole}) => {
      const portal = {connected:true, binding:{role:direction, peerName:"Peer"}, permissions:{grants:[], effective:{}}, observations:[], transfers:[], receipts:[]};
      Object.assign(__state.chat, {workerManager:baseRole === "manager", workerParentChatId:baseRole === "worker" ? "parent" : undefined, portal});
      __state.workerOverview = undefined;
      __state.portal = portal;
      const item = {id:__state.chat.id, title:__state.chat.title, status:"idle", groupId:"ungroup",
        manager:baseRole === "manager", workerParentChatId:baseRole === "worker" ? "parent" : undefined, portal};
      __state.chats = [item];
      __state.library.chats = [item];
      window.dispatchEvent(new MessageEvent("message", {data:__state}));
    }, {direction, baseRole});
    const expected = baseRole === "manager" ? "rgb(207, 98, 98)" : baseRole === "worker" ? "rgb(84, 168, 108)" : "rgb(153, 131, 206)";
    for (const selector of ["#chat-status", ".portal-details .portal-wizard", ".chat-list-open"]) {
      const colors = await page.locator(selector).locator(".wizard-clothing").evaluateAll(parts => parts.map(part => getComputedStyle(part).fill));
      assert(colors.length && colors.every(color => color === expected), `${selector}/${direction}/${baseRole}: ${colors}`);
    }
  }
  assert.deepEqual(errors, []);
});

test("sleeping ZZZ leaves clear space for the upper-right status dot", async t => {
  const { page, errors } = await open(t);
  const results = await page.evaluate(() => {
    return ["idle","completed"].flatMap(state => [undefined,"controller","controlled"].map(role => {
      const icon = PkmChatStatusIndicator(state,role); document.body.append(icon);
      const badge = getComputedStyle(icon,"::before"), bounds = icon.getBoundingClientRect();
      const badgeLeft = bounds.right - parseFloat(badge.width) - parseFloat(badge.borderLeftWidth) - parseFloat(badge.borderRightWidth);
      const snoreRight = Math.max(...[...icon.querySelectorAll(".wizard-snore")].map(letter => letter.getBoundingClientRect().right));
      icon.remove(); return {state,role,gap:badgeLeft-snoreRight};
    }));
  });
  for (const result of results) assert(result.gap >= 1, JSON.stringify(result));
  assert.deepEqual(errors,[]);
});

test("failed wizard stirs, explodes once, then keeps blinking while staying sooty", async t => {
  const { page, errors } = await open(t);
  await page.evaluate(() => {
    const icon = PkmChatStatusIndicator("failed", "manager"); icon.id = "failure-sequence"; document.body.append(icon);
    for (const animation of icon.getAnimations({ subtree:true })) animation.pause();
  });
  const frame = time => page.evaluate(time => {
    const icon = document.getElementById("failure-sequence");
    for (const animation of icon.getAnimations({ subtree:true })) animation.currentTime = time;
    const style = selector => getComputedStyle(icon.querySelector(selector));
    return { stir:Number(style(".wizard-failure-stir").opacity), blast:Number(style(".wizard-failure-blast").opacity),
      face:Number(style(".wizard-failure-aftermath").opacity), eyes:style(".wizard-eye").transform,
      iterations:style(".wizard-eye").animationIterationCount };
  }, time);
  assert.deepEqual(await frame(400), { stir:1, blast:0, face:0, eyes:"matrix(1, 0, 0, 1, 0, 0)", iterations:"infinite" });
  const blast = await frame(1440);
  assert.equal(blast.stir, 0); assert(blast.blast > .9);
  assert.equal((await frame(2000)).face, 1);
  for (const time of [2680, 3360, 6680, 7360, 10680, 11360]) {
    const blinking = await frame(time);
    assert.match(blinking.eyes, /0\.1,/);
    assert.equal(blinking.face, 1); assert.equal(blinking.blast, 0); assert.equal(blinking.stir, 0);
  }
  for (const time of [2400, 3000, 3600, 8000]) {
    const still = await frame(time);
    assert.equal(still.eyes, "matrix(1, 0, 0, 1, 0, 0)");
    assert.equal(still.face, 1); assert.equal(still.blast, 0); assert.equal(still.stir, 0);
  }
  await page.emulateMedia({ reducedMotion:"reduce" });
  assert.equal(await page.locator("#failure-sequence .wizard-failure-stir").evaluate(node => getComputedStyle(node).display), "none");
  assert.equal(await page.locator("#failure-sequence .wizard-failure-blast").evaluate(node => getComputedStyle(node).display), "none");
  assert.equal(await page.locator("#failure-sequence .wizard-failure-aftermath").evaluate(node => getComputedStyle(node).opacity), "1");
  await page.evaluate(() => {
    __state.chats.find(chat => chat.id === __state.chat.id).status = "failed";
    __state.chat.status = "failed";
    window.dispatchEvent(new MessageEvent("message", { data:__state }));
    window.__failureHeader = document.querySelector("#chat-status > .wizard-sooty");
    window.dispatchEvent(new MessageEvent("message", { data:structuredClone(__state) }));
  });
  assert.equal(await page.evaluate(() => !!__failureHeader && __failureHeader === document.querySelector("#chat-status > .wizard-sooty")), true,
    "unchanged state updates must not restart the one-shot failure sequence");
  assert.deepEqual(errors, []);
});

test("terminal wizards sleep side-on at a desk with animated zZZ; failures keep a red light", async t => {
    const { page } = await open(t);
    const results = await page.evaluate(() => {
      const results = [];
      for (const role of [undefined, "manager", "worker", "controller", "controlled"]) for (const state of ["completed", "new-result", "failed", "running", "paused", "stopped"]) {
        const node = window.PkmChatStatusIndicator(state, role);
        document.body.append(node);
        const pose = node.querySelector(".wizard-failure-aftermath") || node;
        const wand = pose.querySelector('.pixel-wizard-frame[data-frame="0"] .wizard-stirrer')?.getBoundingClientRect();
        const pot = pose.querySelector(".wizard-cauldron")?.getBoundingClientRect();
        const wandInPot = !!(wand && pot && wand.left < pot.right && wand.right > pot.left && wand.top < pot.bottom && wand.bottom > pot.top);
        results.push({ state, role, label:node.getAttribute("aria-label"), stateAttr:node.dataset.state,
          wandInPot,
          sleeping:node.classList.contains("wizard-sleeping"), sooty:node.classList.contains("wizard-sooty"),
          onBreak:node.classList.contains("wizard-on-break"), cup:!!node.querySelector(".wizard-break-cup"),
          held:node.classList.contains("wizard-held"), cauldron:!!node.querySelector(".wizard-cauldron"),
          stirrers:node.querySelectorAll('.pixel-wizard-frame[data-frame="0"] .wizard-stirrer').length,
          stirFrames:[...node.querySelectorAll(".pixel-wizard-frame")].map(frame => ({
            frame:frame.dataset.frame, opacity:getComputedStyle(frame).opacity, animation:getComputedStyle(frame).animationName,
          })),
          eyeAnimations:[...node.querySelectorAll(".wizard-eye")].map(eye => getComputedStyle(eye).animationName),
          sootyFace:node.querySelector(".wizard-failure-aftermath .wizard-face")?.getAttribute("fill"),
          aftermathStirrer:!!node.querySelector('.wizard-failure-aftermath .pixel-wizard-frame[data-frame="0"] .wizard-stirrer'),
          aftermathFrames:[...node.querySelectorAll(".wizard-failure-aftermath .pixel-wizard-frame")].map(frame => ({
            frame:frame.dataset.frame, opacity:getComputedStyle(frame).opacity, animation:getComputedStyle(frame).animationName,
          })),
          steam:node.querySelectorAll(".wizard-break-steam").length,
          zzz:node.querySelector(".wizard-zzz")?.textContent, eyes:node.querySelectorAll(".wizard-eye").length,
          facing:node.querySelector("svg")?.dataset.facing, desk:!!node.querySelector(".wizard-desk"),
          face:node.querySelector(".wizard-face") && Number(node.querySelector(".wizard-face").getAttribute("width")) * Number(node.querySelector(".wizard-face").getAttribute("height")),
          snores:[...node.querySelectorAll(".wizard-snore")].map(letter => ({ name:getComputedStyle(letter).animationName, delay:getComputedStyle(letter).animationDelay })),
          light:getComputedStyle(node, "::before").backgroundColor, lightDisplay:getComputedStyle(node, "::before").display,
          lightPosition:[getComputedStyle(node, "::before").top, getComputedStyle(node, "::before").right],
          lightShape:getComputedStyle(node, "::before").borderRadius });
        node.remove();
      }
      return results;
    });
    for (const result of results) {
      assert(result.label);
      if (result.role) assert.match(result.label, new RegExp(result.role, "i"));
      if (result.state === "completed") {
        assert.equal(result.sleeping, true); assert.equal(result.zzz, "zZZ"); assert.equal(result.light, "rgb(82, 187, 128)");
        assert.equal(result.facing, "side"); assert.equal(result.desk, true); assert(result.face <= 24);
        assert.equal(result.snores.length, 3); assert(result.snores.every(letter => letter.name === "wizard-snore"));
        assert.equal(new Set(result.snores.map(letter => letter.delay)).size, 3);
      } else if (result.state === "failed") {
        assert.equal(result.sooty, true); assert.equal(result.eyes, 2); assert(result.face <= 42);
        assert.equal(result.sootyFace, "#39333d"); assert.equal(result.aftermathStirrer, true);
        assert.equal(result.wandInPot, true, "the frozen stirrer still reaches into the cauldron");
        for (const frame of result.aftermathFrames) {
          assert.equal(frame.animation, "none", "hand remains still after the explosion");
          assert.equal(frame.opacity, frame.frame === "0" ? "1" : "0");
        }
        assert.equal(result.light, "rgb(239, 108, 108)"); assert.notEqual(result.lightDisplay, "none");
        assert.deepEqual(result.lightPosition, ["0px", "0px"]); assert.equal(result.lightShape, "50%");
      } else if (["paused", "stopped", "new-result"].includes(result.state)) {
        assert.equal(result.held, true); assert.equal(result.cauldron, true); assert.equal(result.stirrers, 1);
        assert.equal(result.wandInPot, true, "paused/stopped hands retain the active stirring position");
        assert.equal(result.onBreak, false); assert.equal(result.cup, false); assert.equal(result.steam, 0);
        assert.deepEqual(result.eyeAnimations, ["wizard-blink", "wizard-blink"]);
        for (const frame of result.stirFrames) {
          assert.equal(frame.animation, "none", "stirring is frozen, not merely slowed");
          assert.equal(frame.opacity, frame.frame === "0" ? "1" : "0");
        }
        assert.equal(result.sleeping, false); assert.equal(result.sooty, false); assert.equal(result.zzz, undefined);
        assert.equal(result.stateAttr, result.state === "new-result" ? "completed" : result.state, "Unread completion is not a stopped lifecycle");
        assert.equal(result.light, result.state === "new-result" ? "rgb(82, 187, 128)" : result.state === "paused" ? "rgb(227, 179, 65)" : "rgb(239, 108, 108)");
        assert.equal(result.lightShape, "50%");
      }
      else { assert.equal(result.sleeping, false); assert.equal(result.sooty, false); }
    }
    await page.evaluate(() => {
      const node = window.PkmChatStatusIndicator("completed"); node.id = "snore-motion-check"; document.body.append(node);
    });
    const frames = () => page.locator("#snore-motion-check .wizard-snore").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).transform));
    const before = await frames();
    await page.waitForTimeout(240);
    const after = await frames();
    assert(before.every((value, index) => value !== after[index]), "Every zZZ letter must actually move, not merely declare an animation");
    await page.evaluate(async () => {
      document.body.classList.add("chat-backgrounded");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const paused = await frames();
    await page.waitForTimeout(160);
    assert.deepEqual(await frames(), paused, "Hidden-view animations remain paused after the compositor commits the style change");
    await page.evaluate(() => { document.body.classList.remove("chat-backgrounded"); document.getElementById("snore-motion-check").remove(); });
    await page.emulateMedia({ reducedMotion:"reduce" });
    const animation = await page.evaluate(() => {
      const failed = window.PkmChatStatusIndicator("failed"), completed = window.PkmChatStatusIndicator("completed");
      document.body.append(failed, completed);
      return [getComputedStyle(failed.querySelector(".wizard-eye")).animationName, ...[...completed.querySelectorAll(".wizard-snore")].map(letter => getComputedStyle(letter).animationName)];
    });
    assert.deepEqual(animation, ["none", "none", "none", "none"]);
});

test("paused wizards freeze stirring, blink, honor reduced motion and appear in Portal status", async t => {
  const { page, errors } = await open(t, 390);
  await page.evaluate(() => {
    window.__state.chat.paused = true;
    window.__state.chats[0].status = window.__state.library.chats[0].status = "paused";
    window.dispatchEvent(new MessageEvent("message", {data:window.__state}));
  });
  assert.equal(await page.locator('#chat-status .wizard-held[data-state="paused"]').count(), 1);
  assert.equal(await page.locator('.chat-list-open .wizard-held[data-state="paused"]').count(), 1);
  assert.equal(await page.locator("#send").getAttribute("aria-label"), "Resume Chat");
  await page.locator("#send").click();
  assert.equal(await page.evaluate(() => __posts.filter(item => item.type === "resume").length), 1,
    "the new status animation does not change resume behavior");
  const frames = () => page.locator("#chat-status .pixel-wizard-frame")
    .evaluateAll(nodes => nodes.map(node => ({transform:getComputedStyle(node).transform, opacity:getComputedStyle(node).opacity})));
  const before = await frames();
  await page.waitForTimeout(260);
  const after = await frames();
  assert.equal(before.length, 4);
  assert.deepEqual(before, after, "body and stirring remain frozen");
  const eyes = time => page.locator("#chat-status .wizard-eye").evaluateAll((nodes, time) => nodes.map(node => {
    for (const animation of node.getAnimations()) { animation.pause(); animation.currentTime = time; }
    return getComputedStyle(node).transform;
  }), time);
  const openEyes = await eyes(4400);
  const closedEyes = await eyes(4500);
  assert(openEyes.every((value, index) => value !== closedEyes[index]), "only the eyes blink");
  await page.evaluate(async () => {
    document.body.classList.add("chat-backgrounded");
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const frozen = await page.locator("#chat-status .wizard-eye").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).transform));
  await page.waitForTimeout(180);
  assert.deepEqual(await page.locator("#chat-status .wizard-eye").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).transform)), frozen, "blinking freezes in background views");
  await page.evaluate(() => document.body.classList.remove("chat-backgrounded"));
  await page.emulateMedia({reducedMotion:"reduce"});
  assert.deepEqual(await page.locator("#chat-status .wizard-eye")
    .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationName)), ["none", "none"]);
  await page.emulateMedia({reducedMotion:"no-preference"});
  for (const role of ["controller", "controlled"]) {
    await page.evaluate(role => {
      window.__state.portal = {connected:true, binding:{role, peerName:"Fixture peer"}};
      window.dispatchEvent(new MessageEvent("message", {data:window.__state}));
    }, role);
    const indicator = page.locator("#chat-status .wizard-held");
    assert.equal(await indicator.getAttribute("data-state"), "paused");
    assert.equal(await indicator.getAttribute("aria-label"), "Paused", "a connected Portal does not change the local wizard role");
    assert.equal(await page.locator("#chat-portal .portal-open").count(), 1,
      "pausing changes the Chat status, not the Portal connection");
  }
  await page.evaluate(() => {
    window.__state.chat.paused = false;
    window.__state.chats[0].status = window.__state.library.chats[0].status = "running";
    window.dispatchEvent(new MessageEvent("message", {data:window.__state}));
  });
  assert.equal(await page.locator("#chat-status .wizard-held").count(), 0);
  assert.equal(await page.locator("#chat-status .portal-open").count(), 0, "resuming local work does not imply remote control");
  assert.equal(await page.locator('#chat-status > [data-state="running"]').count(), 1);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1));
  assert.deepEqual(errors, []);
});

for (const width of [1280, 390, 260]) test(`recovery guide text stays inside its button and above usage (${width}px)`, async t => {
  const { page, errors } = await open(t, width);
  for (const theme of Object.keys(themes)) {
    await applyTheme(page, theme);
    for (const fontSize of [13, 24]) {
      for (const status of ["error", "failed", "cancelled"]) {
        await page.evaluate(({ status, fontSize }) => {
          document.documentElement.style.setProperty("--vscode-font-size", `${fontSize}px`);
          __state.chat.messages = [{
            id:"recovery-layout", role:"assistant", status, content:"Retained answer",
            error:"The user objective remains open; the response or tool budget ended without verified acceptance or a concrete blocker.",
            elapsedMs:33000, usage:{inputTokens:27282,outputTokens:298},
          }];
          window.dispatchEvent(new MessageEvent("message", { data:__state }));
        }, { status, fontSize });
        const guide = page.getByRole("button", { name:"Review recovery steps before retrying", exact:true });
        const layout = await guide.evaluate(button => {
          const box = button.getBoundingClientRect();
          const message = button.closest(".message").getBoundingClientRect();
          const usage = button.closest(".message").querySelector(".message-tokens").getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(button);
          return {
            width:box.width, height:box.height,
            contained:[...range.getClientRects()].every(text => text.left >= box.left - 1
              && text.right <= box.right + 1 && text.top >= box.top - 1 && text.bottom <= box.bottom + 1),
            insideMessage:box.left >= message.left - 1 && box.right <= message.right + 1,
            usageBelow:usage.top >= box.bottom - 1,
            noOverflow:button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 1,
          };
        });
        assert(layout.width > 100 && layout.height >= 28, JSON.stringify({ width, theme, fontSize, status, layout }));
        assert(layout.contained && layout.insideMessage && layout.usageBelow && layout.noOverflow,
          JSON.stringify({ width, theme, fontSize, status, layout }));
      }
    }
  }
  const guide = page.getByRole("button", { name:"Review recovery steps before retrying", exact:true });
  await guide.focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => __posts.filter(post => post.type === "openHelp").at(-1)),
    { type:"openHelp", value:"agents" });
  assert.equal(await page.evaluate(() => __posts.filter(post => ["send", "retry"].includes(post.type)).length), 0);
  assert.deepEqual(errors, []);
});

test("Chat error actions use text-sized buttons that wrap within narrow views", async t => {
  const { page, errors } = await open(t, 260);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
    data:{type:"error",message:"Model request failed"},
  })));
  const buttons = page.locator(".chat-error-actions button");
  assert.equal(await buttons.count(), 3);
  for (const button of await buttons.all()) {
    const layout = await button.evaluate(node => {
      const box = node.getBoundingClientRect();
      const parent = node.parentElement.getBoundingClientRect();
      return { width:box.width, fits:box.right <= parent.right + 1,
        noOverflow:node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1 };
    });
    assert(layout.width > 28 && layout.fits && layout.noOverflow, JSON.stringify(layout));
  }
  await page.getByRole("button", { name:"View troubleshooting steps", exact:true }).click();
  assert.equal(await page.evaluate(() => __posts.filter(post => post.type === "openHelp").at(-1).value), "agents");
  assert.deepEqual(errors, []);
});

test("old cancelled responses show an understandable stopped notice, not an error or unexplained square", async t => {
  const { page, errors } = await open(t);
  await page.evaluate(() => {
    window.__state.chat.messages = [{ id:"stopped", role:"assistant", status:"cancelled", content:"Retained partial answer",
      error:"Request cancelled. In-flight tool execution may already have occurred." }];
    window.__state.chats[0].status = window.__state.library.chats[0].status = "stopped";
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.match(await page.locator('[data-message-id="stopped"] .message-status').innerText(), /Response stopped.*does not undo/);
  assert.equal(await page.locator('[data-message-id="stopped"] .message-error').count(), 0);
  assert.equal(await page.getByRole("button", { name:/Retry response in place/ }).count(), 1);
  const indicator = await page.evaluate(() => {
    const node = window.PkmChatStatusIndicator("stopped"); document.body.append(node);
    return { label:node.getAttribute("aria-label"), fill:getComputedStyle(node, "::before").backgroundImage,
      resting:node.classList.contains("wizard-on-break"), light:getComputedStyle(node, "::before").backgroundColor };
  });
  assert.equal(indicator.label, "Stopped"); assert.equal(indicator.fill, "none");
  assert.equal(indicator.resting, true); assert.equal(indicator.light, "rgb(157, 163, 168)");
  await page.evaluate(localization => {
    window.__state.localization = localization;
    window.__state.chat.messages[0].error = "Response stopped. Earlier tool actions were not undone. Review their results before retrying.";
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  }, { locale:"zh-hans", english:JSON.parse(fs.readFileSync(path.join(__dirname, "../resources/locales/en.json"))).strings,
    strings:JSON.parse(fs.readFileSync(path.join(__dirname, "../resources/locales/zh-hans.json"))).strings });
  assert.match(await page.locator('[data-message-id="stopped"] .message-status').innerText(), /回复已停止.*不会撤销/);
  assert.deepEqual(errors, []);
});

test("composer advice and budget details use compact hover/focus tooltips without reserving warning rows", async t => {
  const { page, errors } = await open(t, 320);
  const tooltip = page.locator("#composer-help-tooltip");
  const advice = page.locator("#planning-advice");
  const warning = page.locator("#composer-budget-warning");
  await page.locator("#prompt").fill("Small request");
  await page.mouse.move(0, 0);
  const before = await page.locator("#composer").boundingBox();
  assert.equal(await advice.innerText(), "");
  assert.equal(await tooltip.isVisible(), false);
  await advice.hover();
  await tooltip.waitFor({ state:"visible" });
  assert.match(await tooltip.innerText(), /Complex tasks benefit/);
  await page.keyboard.press("Escape");
  assert.equal(await tooltip.isVisible(), false);
  await page.evaluate(() => {
    window.__state.settings.inputBaseTokens = 17000;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.equal(await page.locator("#send").isDisabled(), true);
  assert.equal(await warning.innerText(), "");
  const after = await page.locator("#composer").boundingBox();
  assert.equal(after.height, before.height, "a persistent budget warning must not add composer height");
  await warning.hover();
  await tooltip.waitFor({ state:"visible" });
  assert.match(await tooltip.innerText(), /exceeds this context budget/);
  assert.equal(await page.locator("#composer").evaluate(node => node.innerText.includes("Estimated input plus")), false);
  await page.mouse.move(0, 0);
  await tooltip.waitFor({ state:"hidden" });
  await warning.focus();
  await tooltip.waitFor({ state:"visible" });
  await page.keyboard.press("Escape");
  assert.equal(await tooltip.isVisible(), false);
  await warning.blur();
  await warning.focus();
  await tooltip.waitFor({ state:"visible" });
  for (const theme of Object.keys(themes)) {
    await applyTheme(page, theme);
    const bounds = await tooltip.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 320, "hover details fit the narrow viewport");
  }
  await page.evaluate(() => { document.documentElement.dir = "rtl"; });
  await warning.focus();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => {
    window.__state.settings.inputBaseTokens = 100;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.equal(await page.locator("#composer-budget-warning").isVisible(), false);
  assert.equal(await tooltip.isVisible(), false, "correcting the budget dismisses stale open details");
  assert.equal(await page.locator("#send").isEnabled(), true);
  await page.evaluate(localization => {
    window.__state.localization = localization;
    window.__state.settings.inputBaseTokens = 17000;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  }, { locale:"zh-hans", english:JSON.parse(fs.readFileSync(path.join(__dirname, "../resources/locales/en.json"))).strings,
    strings:JSON.parse(fs.readFileSync(path.join(__dirname, "../resources/locales/zh-hans.json"))).strings });
  await warning.focus();
  await tooltip.waitFor({ state:"visible" });
  assert.equal(await tooltip.innerText(), await warning.getAttribute("aria-label"));
  assert(!/Estimated input/.test(await tooltip.innerText()), "the warning remains localized in hover details");
  assert.equal(await page.evaluate(() => window.__posts.filter(message => message.type === "send").length), 0);
  assert.deepEqual(errors, []);
});

test("readable search/edit activity stays safe, localized and inspectable without inferring external arguments", async t => {
  const { page, errors } = await open(t, 320);
  await page.evaluate(() => {
    const now = Date.now() - 1000;
    const calls = [
      { id:"find", name:"find_files", arguments:JSON.stringify({ glob:"**/*{harness,memory,retrieval}*" }) },
      { id:"search", name:"search_text", arguments:JSON.stringify({ query:'<img src=x onerror="window.__unsafe=true">', glob:"src/**/*.ts" }) },
      { id:"edit", name:"replace_text", arguments:JSON.stringify({ path:"next-step/todo.md", newText:"content stays in details" }) },
      { id:"external", name:"external_tool", arguments:'{"path":"not-our-schema","token":"do-not-promote-to-label"}' },
    ].map(call => ({ ...call, status:"complete", startedAt:now, finishedAt:now + 100 }));
    window.__state.chat.messages = [{ id:"operations", role:"assistant", status:"complete", content:"Recorded operations",
      progress:{ attemptId:"operations-attempt", startedAt:now, finishedAt:now + 100, status:"complete", steps:[] }, toolCalls:calls }];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  const activity = page.locator('[data-message-id="operations"] .workflow');
  await activity.locator(":scope > summary").click();
  const summaries = activity.locator(".activity-event > summary");
  assert.match(await summaries.nth(0).innerText(), /Find files matching \*\*\/\*\{harness,memory,retrieval\}\*/);
  assert.match(await summaries.nth(1).innerText(), /Search for.*<img.*in src\/\*\*\/\*\.ts/);
  assert.match(await summaries.nth(2).innerText(), /Edit next-step\/todo\.md/);
  assert.match(await summaries.nth(3).innerText(), /external_tool/);
  assert(!await summaries.nth(2).innerText().then(text => text.includes("content stays in details")));
  assert(!await summaries.nth(3).innerText().then(text => text.includes("do-not-promote-to-label")));
  assert.equal(await activity.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.__unsafe)), false);
  await page.evaluate(localization => {
    window.__state.localization = localization;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  }, { locale:"zh-hans", english:JSON.parse(fs.readFileSync(path.join(__dirname, "../resources/locales/en.json"))).strings,
    strings:JSON.parse(fs.readFileSync(path.join(__dirname, "../resources/locales/zh-hans.json"))).strings });
  assert.match(await summaries.nth(0).innerText(), /查找匹配/);
  assert.match(await summaries.nth(2).innerText(), /编辑 next-step\/todo\.md/);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
});

for (const width of [1280, 390, 320]) {
  test(`SDK Model Call contains chronological stages without duplicating usage (${width}px)`, async t => {
    const { page, errors } = await open(t, width);
    await page.evaluate(() => {
      const now = Date.now() - 3000;
      const progress = {attemptId:"sdk-hierarchy", model:"Auto", startedAt:now, status:"running", steps:[
        {label:"Retrieving knowledge", category:"info", operation:"retrieval", status:"complete", at:now},
        {label:"Connecting to model API", kind:"model", round:0, status:"complete", at:now + 10},
        {label:"Starting Copilot SDK session", category:"info", operation:"model-access", status:"complete", at:now + 20},
        {label:"Auto selected gpt-test", category:"info", operation:"model-access", status:"complete", at:now + 30},
        {label:"Waiting for first output", kind:"model", round:0, status:"complete", at:now + 40},
        {label:"Generating response", kind:"model", round:0, status:"complete", at:now + 50},
        {label:"Completed tool: read_file", kind:"tool", toolCallId:"sdk-read", round:0, status:"complete", at:now + 60},
        {label:"Generating response", kind:"model", round:1, status:"running", at:now + 70},
      ]};
      window.__state.busy = true;
      window.__state.chat.progress = progress;
      window.__state.chat.messages = [{id:"sdk-hierarchy", role:"assistant", status:"streaming", content:"", progress,
        reasoningSummaries:[{round:1, text:"Public SDK summary."}],
        budgetReceipts:[{round:0, ledger:{providerUsage:{inputTokens:100, outputTokens:20, cachedInputTokens:0}}}],
        toolCalls:[{id:"sdk-read", name:"read_file", arguments:'{"path":"fixture"}', status:"complete", result:"fixture"}],
      }];
      window.dispatchEvent(new MessageEvent("message", {data:window.__state}));
    });
    const activity = page.locator('[data-message-id="sdk-hierarchy"] .workflow');
    const call = activity.locator(".model-call");
    assert.equal(await call.count(), 1);
    assert.equal(await call.locator(":scope > summary").innerText(), "Model Call");
    assert.notEqual(await call.getAttribute("open"), null);
    const stages = await call.locator(".model-call-events > li > .workflow-event-line .activity-label, .model-call-events > li > details > summary .activity-label").allTextContents();
    assert.deepEqual(stages, ["Start Session", "Select Model · gpt-test", "Inference · Auto", "Read fixture", "Inference · Auto working..."]);
    assert.equal(await activity.locator(":scope > .workflow-events > li[data-operation='retrieval']").count(), 1);
    assert.equal(await call.locator('[data-operation="retrieval"]').count(), 0);
    assert.equal(await call.locator('.activity-usage:not([hidden])').count(), 1, "only the actual inference carries provider usage");
    assert.equal(await call.locator(".activity-thinking").isVisible(), true);
    const filter = activity.getByLabel("Activity type filter");
    await filter.selectOption("cmd");
    assert.equal(await call.isVisible(), true);
    assert.equal(await call.locator('.model-call-events > li:not([hidden])').count(), 1);
    await filter.selectOption("info");
    assert.equal(await call.locator('.model-call-events > li:not([hidden])').count(), 2);
    await filter.selectOption("all");
    await call.locator(":scope > summary").click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {data:window.__state})));
    assert.equal(await call.getAttribute("open"), null, "manual group collapse survives streaming");
    await call.locator(":scope > summary").click();
    await page.evaluate(() => {
      window.__state.busy = false;
      window.__state.chat.progress.status = "complete";
      window.__state.chat.progress.steps.at(-1).status = "complete";
      window.__state.chat.messages[0].status = "complete";
      window.dispatchEvent(new MessageEvent("message", {data:window.__state}));
    });
    assert.equal(await call.getAttribute("open"), null, "completed calls fold automatically");
    await activity.locator(":scope > summary").click();
    await call.locator(":scope > summary").click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {data:window.__state})));
    assert.notEqual(await call.getAttribute("open"), null, "historical call reopening survives refreshes");
    assert.equal(await call.locator(":scope > summary .workflow-dot").getAttribute("aria-label"), "complete");
    assert.equal(await call.locator(".activity-thinking").isVisible(), false, "completed inference details remain collapsed");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
  });
}

test("SDK calls stay separate and empty type-filter groups disappear", async t => {
  const { page, errors } = await open(t, 390);
  await page.evaluate(() => {
    const now = Date.now() - 3000;
    const progress = {attemptId:"sdk-separate", status:"failed", startedAt:now, finishedAt:now + 1000, steps:[
      {label:"Starting Copilot SDK session", status:"complete", at:now},
      {label:"Generating response", kind:"model", round:0, status:"complete", at:now + 10},
      {label:"Retrieving more knowledge", category:"info", operation:"retrieval", status:"complete", at:now + 20},
      {label:"Starting Copilot SDK session", category:"info", operation:"model-access", status:"failed", at:now + 30},
    ]};
    window.__state.busy = false;
    window.__state.chat.messages = [{id:"sdk-separate", role:"assistant", status:"failed", content:"", progress}];
    window.dispatchEvent(new MessageEvent("message", {data:window.__state}));
  });
  const activity = page.locator('[data-message-id="sdk-separate"] .workflow');
  await activity.locator(":scope > summary").click();
  const calls = activity.locator(".model-call");
  assert.equal(await calls.count(), 2);
  assert.equal(await calls.nth(0).locator(":scope > summary .workflow-dot").getAttribute("aria-label"), "complete");
  assert.equal(await calls.nth(1).locator(":scope > summary .workflow-dot").getAttribute("aria-label"), "failed");
  await calls.nth(0).locator(":scope > summary").click();
  await calls.nth(1).locator(":scope > summary").click();
  assert.equal(await calls.nth(0).locator(".model-call-events > li").count(), 2, "legacy setup without an operation still belongs to its call");
  assert.equal(await calls.nth(1).locator(".model-call-events > li").count(), 1);
  await activity.getByLabel("Activity type filter").selectOption("llm");
  assert.equal(await calls.nth(0).isVisible(), true);
  assert.equal(await calls.nth(1).isVisible(), false);
  await activity.getByLabel("Activity type filter").selectOption("cmd");
  assert.equal(await calls.nth(0).isVisible(), false);
  assert.equal(await calls.nth(1).isVisible(), false);
  assert.deepEqual(errors, []);
});

test("model activity uses compact model titles and keeps round details in tooltips", async t => {
  const { page, errors } = await open(t, 390);
  await page.evaluate(() => {
    const now = Date.now() - 3000;
    const progress = { attemptId:"round-labels", model:"gpt-test", startedAt:now, status:"running", steps:[
      { label:"Waiting for first output", kind:"model", round:0, at:now, status:"complete" },
      { label:"Generating response", kind:"model", round:0, at:now + 100, status:"complete" },
      { label:"Waiting for first output", kind:"model", round:1, at:now + 1000, status:"running" },
    ] };
    window.__state.busy = true;
    window.__state.chat.progress = progress;
    window.__state.chat.messages = [{ id:"round-labels", role:"assistant", status:"streaming", content:"", progress }];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  const activity = page.locator('[data-message-id="round-labels"] .workflow');
  const rows = activity.locator('.workflow-events > li[data-category="llm"]');
  assert.equal(await rows.count(), 2, "stages in one model round share one row");
  assert.equal(await rows.nth(0).locator(".activity-label").innerText(), "gpt-test");
  assert.equal(await rows.nth(1).locator(".activity-label").innerText(), "gpt-test working...");
  assert.match(await rows.nth(1).locator(".activity-label").getAttribute("title"), /Model round 2/);
  assert.match(await activity.locator(":scope > summary").innerText(), /gpt-test working/);
  assert.doesNotMatch(await activity.innerText(), /Waiting for first output/);
  await page.evaluate(localization => {
    window.__state.localization = localization;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  }, { locale:"zh-hans", english:JSON.parse(fs.readFileSync(path.join(__dirname, "../resources/locales/en.json"))).strings,
    strings:JSON.parse(fs.readFileSync(path.join(__dirname, "../resources/locales/zh-hans.json"))).strings });
  assert.equal(await rows.nth(0).locator(".activity-label").innerText(), "gpt-test");
  assert.equal(await rows.nth(1).locator(".activity-label").innerText(), "gpt-test working...");
  assert.match(await rows.nth(1).locator(".activity-label").getAttribute("title"), /第 2 轮模型交互/);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
});

test("advertised tools are listed first and the running event is last with a blue dot", async t => {
  const { page, errors } = await open(t, 600);
  await page.evaluate(() => {
    const now = Date.now() - 3000;
    const progress = { attemptId:"order-attempt", startedAt:now, status:"running", tools:["read_file", "run_process"], steps:[
      { label:"Generating response", kind:"model", round:0, at:now, status:"complete" },
      { label:"Waiting for first output", kind:"model", round:1, at:now + 1000, status:"running" },
    ] };
    window.__state.busy = true;
    window.__state.chat.progress = progress;
    window.__state.chat.messages = [{ id:"order", role:"assistant", status:"streaming", content:"", progress, reasoningSummaries:[{ round:1, text:"Compare both files first." }] }];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  const rows = page.locator('[data-message-id="order"] .workflow-events > li:not(.activity-availability):not(.activity-planned)');
  assert.match(await rows.first().innerText(), /Tools available to the model \(2\)/);
  assert.equal(await rows.first().getAttribute("data-status"), "context");
  assert.equal(await rows.last().locator(".activity-label").innerText(), "Model working...");
  const dot = await rows.last().locator(".workflow-dot").evaluate(node => getComputedStyle(node).backgroundColor);
  assert.equal(dot, "rgb(55, 148, 255)", "running dot uses the theme's chart blue");
  assert.match(await rows.last().locator(".activity-thinking").innerText(), /Compare both files first\./);
  assert.equal(await rows.last().locator(".activity-thinking").evaluate(node => getComputedStyle(node).maxHeight), "none",
    "expanded thinking is not clipped to the old live-preview height");
  const thinking = rows.last().locator(".activity-event");
  assert.notEqual(await thinking.getAttribute("open"), null, "running model expands reported thinking automatically");
  await thinking.locator("summary").click();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {data:window.__state})));
  assert.equal(await thinking.getAttribute("open"), null, "manual collapse survives streaming updates");
  await thinking.locator("summary").click();
  await page.evaluate(() => {
    window.__state.chat.progress.steps.at(-1).status = "complete";
    window.__state.chat.progress.steps.push({label:"Preparing tool", kind:"info", status:"running", at:Date.now()});
    window.dispatchEvent(new MessageEvent("message", {data:window.__state}));
  });
  const finished = rows.filter({has:page.locator(".activity-thinking")}).locator(".activity-event");
  assert.equal(await finished.getAttribute("open"), null, "model activity folds when its round ends even while the Chat is busy");
  await finished.locator("summary").click();
  assert.match(await finished.locator(".activity-thinking").innerText(), /Compare both files first/);
  assert.deepEqual(errors, []);
});

for (const status of ["complete", "failed", "cancelled"]) {
  test(`model thinking folds on ${status} and historical reopening survives rerenders`, async t => {
    const { page, errors } = await open(t, 390);
    await page.evaluate(() => {
      const progress = { attemptId:"thinking-lifecycle", model:"test-model", startedAt:Date.now(), status:"running",
        steps:[{kind:"model", round:0, label:"Generating response", status:"running", at:Date.now()}] };
      window.__state.busy = true;
      window.__state.chat.progress = progress;
      window.__state.chat.messages = [{id:"thinking-lifecycle", role:"assistant", status:"streaming", content:"", progress}];
      window.dispatchEvent(new MessageEvent("message", {data:window.__state}));
    });
    const activity = page.locator('[data-message-id="thinking-lifecycle"] .workflow');
    assert.equal(await activity.locator(".activity-event").count(), 0, "no thinking is fabricated when the provider reports none");
    await page.evaluate(() => {
      window.__state.chat.messages[0].reasoningSummaries = [{round:0, text:"A public summary."}];
      window.dispatchEvent(new MessageEvent("message", {data:window.__state}));
    });
    const detail = activity.locator('li[data-category="llm"] .activity-event');
    assert.notEqual(await detail.getAttribute("open"), null);
    await page.evaluate(status => {
      window.__state.chat.progress.steps[0].status = status;
      window.__state.chat.progress.steps.push({kind:"info", label:"Next activity", status:"running", at:Date.now()});
      window.dispatchEvent(new MessageEvent("message", {data:window.__state}));
    }, status);
    assert.equal(await detail.getAttribute("open"), null);
    await detail.locator("summary").click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {data:window.__state})));
    assert.notEqual(await detail.getAttribute("open"), null);
    assert.match(await detail.locator(".activity-thinking").innerText(), /A public summary/);
    assert.deepEqual(errors, []);
  });
}

test("live activity starts readable and expanded, preserves collapse and keeps reasoning counts out of the compact usage line", async t => {
  const { page, errors } = await open(t, 390);
  await page.evaluate(() => {
    const now = Date.now() - 3000;
    const progress = { attemptId:"live-attempt", startedAt:now, status:"running", steps:[
      { label:"Generating response", kind:"model", round:0, at:now, status:"complete" },
      { label:"Running tool: read_file", kind:"tool", toolCallId:"read", round:0, at:now + 1000, status:"running" },
    ] };
    Object.assign(window.__state, { busy:true });
    window.__state.chat.progress = progress;
    window.__state.chat.messages = [{ id:"live", role:"assistant", status:"streaming", content:"", progress,
      budgetReceipts:[{ round:0, ledger:{ providerUsage:{ inputTokens:100, outputTokens:20, reasoningTokens:7 } } }],
      reasoningSummaries:[{ round:0, text:"Check the requested range." }],
      toolCalls:[{ id:"read", name:"read_file", arguments:'{"path":"src/main.ts","startLine":94,"endLine":130}', status:"running", startedAt:now + 1000 }],
    }];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  const activity = page.locator('[data-message-id="live"] .workflow');
  assert.notEqual(await activity.getAttribute("open"), null);
  const tool = activity.locator(".activity-event").filter({ hasText:"Read src/main.ts, lines 94-130" });
  assert(await tool.locator("summary").isVisible(), "operation is readable without expanding its arguments");
  assert.equal(await tool.getAttribute("open"), null);
  assert.match(await activity.locator(":scope > summary").innerText(), /Read src\/main.ts, lines 94-130/);
  assert.equal(await tool.locator(".activity-usage").innerText(), "");
  const model = activity.locator('li[data-category="llm"] .activity-event');
  assert.equal(await model.locator(".activity-usage").innerText(), "100 in / 20 out");
  assert.equal(await page.evaluate(() => window.__state.chat.messages[0].budgetReceipts[0].ledger.providerUsage.reasoningTokens), 7);
  assert.match(await model.locator(".activity-usage").getAttribute("title"), /included in output/);
  await activity.locator(":scope > summary").click();
  await page.waitForTimeout(20);
  await page.evaluate(() => {
    window.__state.chat.messages[0].toolCalls[0].status = "complete";
    window.__state.chat.messages[0].toolCalls[0].finishedAt = Date.now();
    window.__state.chat.progress.steps.push({ label:"Completed tool: read_file", kind:"tool", toolCallId:"read", round:0, at:Date.now(), status:"complete" });
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.equal(await activity.getAttribute("open"), null, "manual collapse survives live updates");
  await page.evaluate(() => {
    window.__state.busy = false;
    window.__state.chat.progress.status = "complete";
    window.__state.chat.progress.finishedAt = Date.now();
    window.__state.chat.messages[0].status = "complete";
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.equal(await activity.getAttribute("open"), null, "manual collapse survives completion");
  await activity.locator(":scope > summary").click();
  await tool.locator("summary").click();
  assert.match(await tool.innerText(), /read_file/);
  assert.equal(await tool.locator(".elapsed").getAttribute("data-finished") !== null, true);
  await model.locator("summary").click();
  assert.match(await model.innerText(), /Check the requested range/);
  assert.deepEqual(errors, []);
});

for (const width of [1280, 390, 320]) test(`activity rows contain their own details, tools, public summaries, plan and truthful usage (${width}px)`, async t => {
  const { page, errors } = await open(t, width);
  await page.evaluate(() => {
    const now = Date.now() - 3000;
    window.__state.chat.messages = [{ id:"a1", role:"assistant", status:"complete", content:"Done", usage:{ inputTokens:100, outputTokens:20 },
      progress:{ attemptId:"attempt", startedAt:now, finishedAt:now + 2500, status:"complete", model:"fixture", tools:["read_file"], steps:[
        { label:"Connecting", kind:"model", round:0, at:now, status:"complete" },
        { label:"Generating response", kind:"model", round:0, at:now + 100, status:"complete" },
        { label:"Running tool: read_file", kind:"tool", toolCallId:"call", round:0, at:now + 1000, status:"complete" },
        { label:"Completed tool: read_file", kind:"tool", toolCallId:"call", round:0, at:now + 1500, status:"complete" },
      ] },
      budgetReceipts:[{ round:0, ledger:{ providerUsage:{ inputTokens:100, outputTokens:20 } } }],
      reasoningSummaries:[{ round:0, text:"Check input boundaries.\nThen verify the fixture." }],
      planning:{ possibilities:[{ id:"p", label:"Run integration checks", status:"candidate" }] },
      toolCalls:[{ id:"call", name:"read_file", status:"complete", startedAt:now + 1000, finishedAt:now + 1500,
        arguments:'{"path":"fixture"}', result:'<img src="bad" onerror="window.__unsafe=true">' }] }];
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  const activity = page.locator(".message.assistant .workflow");
  await page.waitForTimeout(30);
  assert.deepEqual(errors, []);
  assert.equal(await activity.getAttribute("open"), null);
  await activity.locator(":scope > summary").click();
  const details = activity.locator(".activity-event");
  assert.equal(await details.count(), 3, "one model, one tool and advertised tools; no duplicate grey tool list");
  assert.equal(await page.locator(".debug-information .tool-call").count(), 0);
  const tool = details.filter({ hasText:"Read fixture" });
  for (const row of await activity.locator('li[data-status="complete"]').all()) {
    assert.doesNotMatch(await row.locator(".activity-label").textContent(), /· complete/);
    assert.equal(await row.locator(".workflow-dot").getAttribute("aria-label"), "complete");
    assert.equal(await row.locator(".workflow-dot").getAttribute("title"), "complete");
  }
  assert.equal(await tool.getAttribute("open"), null);
  await tool.locator("summary").click();
  assert.match(await tool.innerText(), /"path":"fixture"/);
  assert.equal(await tool.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.__unsafe)), false);
  const model = activity.locator('li[data-category="llm"] .activity-event');
  assert.equal(await model.locator(".activity-usage").innerText(), "100 in / 20 out");
  assert.match(await model.locator(".activity-usage").getAttribute("title"), /Cache usage not reported/);
  const order = await model.locator("summary").evaluate(node => [...node.children].map(child => child.className));
  assert(order.indexOf("activity-usage") < order.indexOf("elapsed"));
  await model.locator("summary").click();
  assert.match(await model.innerText(), /Check input boundaries/);
  assert.equal(await tool.locator(".activity-usage").innerText(), "");
  assert.equal(await activity.locator('[data-status="planned"]').innerText(), "TODO · Run integration checks · candidate");
  await page.evaluate(() => {
    window.__state.chat.sessionId = "owned-task";
    window.__state.chat.messages[0].taskId = "owned-task";
    window.__state.taskPlan = { items:[{ todoId:"nested", title:"Nested Session task", status:"pending" }] };
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.equal(await activity.locator('[data-status="planned"]').innerText(), "TODO · Nested Session task · pending");
  await page.evaluate(() => {
    window.__state.chat.sessionId = "new-task";
    window.__state.taskPlan.items[0].title = "Different Task plan";
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.equal(await activity.locator('[data-status="planned"]').innerText(), "TODO · Run integration checks · candidate");
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data:window.__state })));
  assert.notEqual(await tool.getAttribute("open"), null);
  const overflow = await page.evaluate(() => ({
    width:innerWidth, scroll:document.documentElement.scrollWidth, x:scrollX,
    nodes:[...document.querySelectorAll("body *")].filter(node => node.getBoundingClientRect().width && (node.getBoundingClientRect().right + scrollX > innerWidth + 1 || node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === "visible"))
      .slice(0, 15).map(node => ({ tag:node.tagName, class:node.className, id:node.id, width:node.clientWidth, scroll:node.scrollWidth, right:node.getBoundingClientRect().right + scrollX }))
  }));
  assert(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow));
  assert.deepEqual(errors, []);
});

test("a bound, running controlled Chat with Portal list items opens the Portal in both corners", async t => {
  const { page, errors } = await open(t, 390);
  await page.evaluate(() => {
    const portal = { connected:true, execution:{requestId:"remote-task",kind:"task",state:"running"}, binding:{ role:"controlled", pairId:"pair", peerName:"linux-controller", peerMachine:"br1u42", peerChatName:"Portal: windows debug", peerCapabilities:["observations-v1", "files-v1", "resume-v1"] } };
    const item = { ...window.__state.chats[0], title:"Diagnose GitHub Sync failures on this Windows machine, read-only", status:"running", portal };
    Object.assign(window.__state, { busy:true, portal:{ ...portal, endpoint:"ws://localhost:37009", permissions:{ grants:[], effective:{} }, observations:[], transfers:[], receipts:[] },
      chats:[item], library:{ groups:[], chats:[item] } });
    window.__state.chat.title = item.title;
    window.__state.chat.messages = [{ id:"remote-task", role:"user", content:"Diagnose Sync", portalSource:{ hostname:"br1u42", endpoint:"ws://localhost:37009", chatName:"Portal: windows debug", participantId:"peer" } },
      { id:"reply", role:"assistant", content:"", status:"pending" }];
    window.__state.chat.progress = { attemptId:"attempt", startedAt:Date.now(), status:"running", steps:[{ label:"Waiting for first output", status:"running" }] };
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.deepEqual(errors, []);
  assert.equal(await page.locator("#chat-portal").getAttribute("data-connection"), "connected");
  assert.equal(await page.locator("#chat-portal .portal-open").count(), 1);
  assert.equal(await page.locator("#chat-status .portal-open .portal-side-wizard").count(), 1);
  assert.match(await page.locator("#chat-status").innerText(), /Controlled execution · br1u42/);
  assert.doesNotMatch(await page.locator("#portal-state").innerText(), /Disconnected \/ unknown|Awaiting peer/);
});

test("the Portal header states the peer and whether progress reaches the controller automatically", async t => {
  const { page, errors } = await open(t, 900);
  const headline = async (portal) => {
    await page.evaluate(value => {
      window.__state.portal = { endpoint:"ws://hub", permissions:{ grants:[], effective:{} }, observations:[], transfers:[], receipts:[], ...value };
      window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
    }, portal);
    return portal.binding || portal.pending ? page.locator("#portal-state strong").textContent() : undefined;
  };
  const binding = role => ({ role, pairId:"p", peerName:"peer", peerMachine:"DESKTOP-56TITCC", peerChatName:"Diagnose" });
  assert.equal(await headline({ connected:true, reviewMode:"manual", binding:binding("controlled") }), "Controlled by DESKTOP-56TITCC · Diagnose · controller checks status manually");
  assert.equal(await headline({ connected:true, reviewMode:"auto", binding:binding("controlled") }), "Controlled by DESKTOP-56TITCC · Diagnose · progress auto-sent to controller");
  assert.equal(await headline({ connected:true, reviewMode:"auto", binding:binding("controller") }), "Controlling DESKTOP-56TITCC · Diagnose · auto-review on remote progress");
  assert.equal(await headline({ connected:false, binding:binding("controller") }), "Controlling DESKTOP-56TITCC · Diagnose · reconnecting…");
  await headline({ connected:false });
  assert.equal(await page.locator("#portal-state").isVisible(),false);
  assert.deepEqual(errors, []);
});

test("a pending Portal link shows its deadline, endpoint reachability and re-copy/void actions", async t => {
  const { page, errors } = await open(t, 900);
  await page.evaluate(() => {
    window.__posted = [];
    window.__state.portal = { connected:false, state:"awaiting-peer", endpoint:"ws://127.0.0.1:7345", endpointScope:"forwarded-localhost",
      pending:{ role:"controller", expiresAt:Date.now() + 9.5 * 60000, linkAvailable:true, endpoint:"ws://127.0.0.1:7345", endpointScope:"forwarded-localhost" },
      permissions:{ grants:[], effective:{} }, observations:[], transfers:[], receipts:[] };
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.equal(await page.locator("#portal-state strong").innerText(), "Portal link sent · waiting for the other side to accept (expires in 10 min)");
  await page.locator(".portal-compact").hover();
  const text = await page.locator("#portal-state").innerText();
  assert.match(text, /ws:\/\/127\.0\.0\.1:7345 \(forwarded localhost: reachable only on the computer running the VS Code UI\)/);
  assert.match(text, /This Chat will control the peer/);
  await page.locator("[data-portal-pending] button", { hasText:"Copy link again" }).click();
  await page.locator("[data-portal-pending] button", { hasText:"Void link" }).click();
  const sent = await page.evaluate(() => window.__posts.filter(message => message.type === "portalPendingLink").map(message => message.value));
  assert.deepEqual(sent, ["copy", "void"]);
  await page.evaluate(() => {
    window.__state.portal = { ...window.__state.portal, pending:undefined, connected:true, state:"connected", peerEndpoint:"wss://10.0.0.5:7345", peerEndpointScope:"lan",
      externalAuthorization:{ expiresAt:Date.now() + 15 * 60000 }, binding:{ role:"controller", pairId:"p", peerName:"peer", peerMachine:"DESKTOP-56TITCC" } };
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  const live = await page.locator("#portal-state").innerText();
  assert.match(live, /peer endpoint wss:\/\/10\.0\.0\.5:7345 \(local network address\)/);
  assert.match(live, /External MCP access: until /);
  assert.equal(await page.locator("[data-portal-pending]").count(), 0);
  assert.deepEqual(errors, []);
});

test("disconnected Portal hides stale endpoint/receipts and connected details omit raw protocol identities",async t=>{
  const {page,errors}=await open(t,390);
  await page.evaluate(()=>{
    __state.portal={connected:true,binding:{role:"controlled",peerName:"Windows fixture",peerChatId:"fixture-chat-uuid"},
      permissions:{active:true,mode:"all",expiresAt:null},receipts:[{requestId:"fixture-request-uuid",state:"completed"}],
      transfers:[{transferId:"fixture-transfer-uuid",state:"completed",sha256:"fixture-hash"}]};
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  assert.equal(await page.locator("#portal-state").innerText(),"Portal Connected - Permission all · Until disconnected");
  await page.locator(".portal-compact").focus();
  assert(await page.locator("#portal-details").isVisible(),"keyboard focus exposes the same details as hover");
  assert.doesNotMatch(await page.locator("#portal-details").textContent(),/fixture-(chat|request|transfer)-uuid|fixture-hash/);
  await page.evaluate(()=>{
    __state.portal={connected:false,endpoint:"ws://old-endpoint",permissions:{active:false},receipts:[{requestId:"old",state:"completed"}]};
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  assert.equal(await page.locator("#portal-state").isVisible(),false);
  assert.equal(await page.locator("#portal-state").textContent(),"");
  assert.equal(await page.locator("#chat-portal").getAttribute("aria-pressed"),"false");
  assert.deepEqual(errors,[]);
});

test("Portal file transfers appear before folder selection, update in place and show verified receipt", async t => {
  const {page,errors}=await open(t,390);
  await page.evaluate(()=>{
    __state.chat.messages=[
      {id:"before",role:"user",status:"complete",content:"Transfer the package",recordedAt:"2026-01-01T00:00:00.000Z"},
      {id:"after",role:"assistant",status:"complete",content:"Offered",recordedAt:"2026-01-01T00:10:00.000Z"}];
    __state.chat.portalTransfers=[{transferId:"00000000-0000-4000-8000-000000000001",
      direction:"incoming",peerName:"Linux peer",state:"awaiting-approval",bytes:0,totalBytes:100,
      files:[{name:"<b>package</b>.vsix",size:100,sha256:"a".repeat(64)}],
      startedAt:"2026-01-01T00:05:00.000Z",updatedAt:"2026-01-01T00:05:00.000Z"}];
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  const card=page.locator("article.portal-transfer");
  assert.match(await card.innerText(),/Choose a destination folder, then approve/);
  assert.deepEqual(await page.$$eval("#messages > article",nodes=>nodes.map(node=>node.dataset.messageId||"transfer")),["before","transfer","after"]);
  assert.equal(await card.locator("b").count(),0);
  await page.evaluate(()=>{
    Object.assign(__state.chat.portalTransfers[0],{state:"transferring",bytes:50});
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  assert.equal(await card.count(),1);
  assert.equal(await card.locator("progress").getAttribute("value"),"50");
  await page.evaluate(()=>{
    Object.assign(__state.chat.portalTransfers[0],{state:"completed",bytes:100,savedPaths:["C:\\Received\\package.vsix"]});
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  assert.match(await card.innerText(),/Completed · receipt verified/);
  assert.match(await card.innerText(),/C:\\Received\\package.vsix/);
  assert.match(await card.innerText(),/No automatic installation or execution/);
  await page.evaluate(()=>{
    Object.assign(__state.chat.portalTransfers[0],{direction:"outgoing",state:"offered",bytes:0,savedPaths:undefined});
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  assert.match(await card.innerText(),/Waiting for receiver to choose a folder and approve/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);
});

test("Portal direct commands appear in the Chat timeline with status, command line and visible output", async t => {
  const {page,errors}=await open(t,390);
  await page.evaluate(()=>{
    __state.chat.messages=[
      {id:"before",role:"user",status:"complete",content:"Debug Windows",recordedAt:"2026-01-01T00:00:00.000Z"},
      {id:"after",role:"assistant",status:"complete",content:"Diagnosed",recordedAt:"2026-01-01T00:10:00.000Z"}];
    __state.chat.portalCommands=[{requestId:"00000000-0000-4000-8000-000000000001",role:"controlled",peerName:"yuwang8@linux",
      program:"C:\\Python\\python.exe",arguments:["-c","print('<b>hi</b>')"],timeoutSeconds:90,state:"failed",
      startedAt:"2026-01-01T00:05:00.000Z",updatedAt:"2026-01-01T00:05:09.000Z",exitCode:1,stdout:"<script>bad()</script>",stderr:"SSLError",truncated:true}];
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  const order=await page.$$eval("#messages > article",nodes=>nodes.map(node=>node.dataset.messageId||`cmd:${node.dataset.portalCommand}`));
  assert.deepEqual(order,["before","cmd:00000000-0000-4000-8000-000000000001","after"],"commands interleave by time");
  const card=page.locator("article.portal-command");
  assert.match(await card.innerText(),/Portal command ← yuwang8@linux/);
  assert.match(await card.innerText(),/Failed · exit 1/);
  assert.match(await card.locator(".portal-command-line").innerText(),/python\.exe -c "print\('<b>hi<\/b>'\)"/);
  assert.match(await card.locator(".portal-command-terminal").innerText(),/<script>bad\(\)<\/script>[\s\S]*SSLError/);
  assert.equal(await card.locator(".portal-command-terminal").isVisible(),true);
  assert.equal(await page.locator("article.portal-command script, article.portal-command b").count(),0,"output is text, never HTML");
  await page.evaluate(()=>{
    __state.chat.portalCommands.push({requestId:"00000000-0000-4000-8000-000000000002",role:"controller",peerName:"yuwang8@DESKTOP",
      program:"cmd.exe",arguments:["/c","ver"],timeoutSeconds:60,state:"unknown",detail:"Sent to transport; awaiting executing Host authorization.",
      startedAt:"2026-01-01T00:20:00.000Z",updatedAt:"2026-01-01T00:20:00.000Z"});
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  assert.match(await page.locator("#messages > article").last().innerText(),/Portal command → yuwang8@DESKTOP[\s\S]*Outcome unknown/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);
});

test("Portal command terminal cards distinguish every reported state without inferring completion from stderr", async t => {
  const {page,errors}=await open(t,360);
  const states=[
    ["awaiting-approval","Awaiting approval",undefined,undefined],
    ["running","Running",undefined,undefined],
    ["completed","Completed",0,"warning on stderr"],
    ["failed","Failed",1,"command failed"],
    ["denied","Declined",undefined,undefined],
    ["cancelled","Cancelled",undefined,undefined],
    ["unknown","Outcome unknown",0,"result not received"],
  ];
  await page.evaluate(states=>{
    __state.chat.portalCommands=states.map(([state,_label,exitCode,stderr],index)=>({
      requestId:`terminal-${index}`,role:"controller",peerName:"Windows peer",program:"pwsh.exe",
      arguments:["-NoProfile","<script>alert(1)</script>"],cwd:"C:\\Users\\Public\\work",timeoutSeconds:30,
      state,...(exitCode===undefined?{}:{exitCode}),...(stderr?{stderr}:{}),
      startedAt:new Date(Date.UTC(2026,0,1,0,index)).toISOString(),
      updatedAt:new Date(Date.UTC(2026,0,1,0,index)).toISOString(),
    }));
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  },states);
  const cards=page.locator("article.portal-command");
  assert.equal(await cards.count(),states.length);
  for(let index=0;index<states.length;index++){
    const [state,label,exitCode]=states[index];
    const card=cards.nth(index);
    assert.equal(await card.getAttribute("data-portal-command"),`terminal-${index}`);
    assert.equal(await card.getAttribute("aria-label"),`Portal command → Windows peer · ${label}`);
    assert.match(await card.locator(".portal-command-status").getAttribute("aria-label"),new RegExp(`Status: ${label}`));
    assert.match(await card.locator(".portal-command-status").innerText(),new RegExp(label));
    assert(await card.evaluate((node,state)=>node.classList.contains(`portal-command-${state}`),state));
    if(exitCode!==undefined) assert.match(await card.locator(".portal-command-status").innerText(),new RegExp(`exit ${exitCode}`));
    assert.match(await card.locator(".portal-command-line").innerText(),/^\$\s+pwsh\.exe/);
    assert.match(await card.locator(".portal-command-meta").innerText(),/C:\\Users\\Public\\work[\s\S]*30s/);
  }
  assert.match(await cards.nth(2).locator(".portal-command-status").innerText(),/Completed · exit 0/,
    "stderr does not override the explicit successful state");
  assert.equal(await cards.nth(2).locator(".portal-command-status").innerText().then(text=>/Failed/.test(text)),false);
  assert.match(await cards.nth(6).locator(".portal-command-status").innerText(),/Outcome unknown · exit 0/,
    "an exit code alone does not turn an unknown result into completion");
  assert.equal(await cards.nth(2).locator(".portal-command-terminal").isVisible(),true,
    "output is visible without expanding a disclosure");
  assert.equal(await page.locator("article.portal-command script").count(),0,"command text is rendered safely");
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);
});

test("Portal output uses one 20-percent viewport terminal and shows the latest results", async t => {
  const {page,errors}=await open(t,390);
  await page.evaluate(()=>{
    __state.chat.portalCommands=[{requestId:"bounded-terminal",role:"controlled",peerName:"Linux",
      program:"cmd",arguments:["/c","echo test"],timeoutSeconds:15,state:"running",
      startedAt:"2026-01-01T00:05:00.000Z",updatedAt:"2026-01-01T00:05:01.000Z",
      stdout:Array.from({length:200},(_,i)=>`stdout ${i}`).join("\n"),
      stderr:Array.from({length:100},(_,i)=>`stderr ${i}`).join("\n"),detail:"latest detail"}];
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  const terminal=page.locator(".portal-command-terminal");
  const check=async()=>{
    const metrics=await terminal.evaluate(node=>({
      height:node.getBoundingClientRect().height,viewport:innerHeight,
      overflow:node.scrollHeight>node.clientHeight,
      bottom:node.scrollHeight-node.clientHeight-node.scrollTop,
    }));
    assert(Math.abs(metrics.height-metrics.viewport*0.2)<=1,"one terminal is exactly 20% of the viewport");
    assert(metrics.overflow,"long output scrolls inside the terminal");
    assert(metrics.bottom<=1,"new output shows the latest result");
    assert.equal(await terminal.count(),1,"stdout, stderr and detail share one scrolling area");
  };
  await check();
  for(const height of [500,1000]){
    await page.setViewportSize({width:390,height});
    assert(Math.abs(await terminal.evaluate(node=>node.getBoundingClientRect().height-innerHeight*0.2))<=1);
    await page.evaluate(()=>{
      __state.chat.portalCommands[0].stdout+="\n"+Array(300).fill("more output").join("\n");
      __state.chat.portalCommands[0].detail="newest result";
      window.dispatchEvent(new MessageEvent("message",{data:__state}));
    });
    await check();
  }
  assert.match(await terminal.innerText(),/newest result/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);
});
