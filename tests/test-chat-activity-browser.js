const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const { themes, applyTheme } = require("./ui-theme-fixtures");

const webview = path.join(process.env.PKM_ACTIVITY_EXTENSION_ROOT || path.join(__dirname, ".."), "dist", "webview");
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
      adaptive:{reason:"insufficient-feedback",returned_count:2,original_count:2}};
    __state.chat.messages=[{id:"review-reply",role:"assistant",status:"complete",content:"Recorded",
      retrieval:{schema:"pkm.chat.retrieval/v1",chatId:__state.chat.id,query:"query",model:"fixture",selectedCount:0,candidates:[],invocation}}];
    window.dispatchEvent(new MessageEvent("message",{data:__state}));
  });
  await page.locator("#memory").click();
  const evidence=page.locator("#retrieval-evidence");
  assert.match(await evidence.innerText(),/dual \/ lexical\+semantic/);
  await evidence.getByRole("button",{name:"Review relevance",exact:true}).click();
  assert(await page.evaluate(()=>__posts.some(message=>message.type==="reviewRetrieval"&&message.id==="review-reply")));
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
test("Chat shows tokens and exact provider credits independently, including zero, partial coverage and localized narrow layouts", async t => {
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
  assert.equal(await message.locator(".message-credits").innerText(), "1.000000001 credits");
  assert.match(await message.locator(".message-credits").getAttribute("title"), /Memory and workers are accounted separately/);
  await message.locator(".activity > summary").click();
  assert.match(await message.locator(".activity-usage").innerText(), /123 in \/ 45 out.*1\.000000001 credits/);
  assert.match(await message.locator(".activity-usage").innerText(), /Cache usage not reported/);
  for (const cached of [0, 100]) {
    await page.evaluate(cached => {
      window.__state.chat.messages[0].budgetReceipts[0].ledger.providerUsage.cachedInputTokens = cached;
      window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
    }, cached);
    assert.match(await message.locator(".activity-usage").textContent(), new RegExp(`${cached} cached input`));
    assert.equal(await message.locator(".message-credits").innerText(), "1.000000001 credits");
  }
  await page.evaluate(() => {
    window.__state.chat.messages[0].budgetReceipts[0].ledger.providerUsage.cachedInputTokens = 124;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.match(await message.locator(".activity-usage").textContent(), /Cache usage not reported/);
  await page.evaluate(() => {
    Object.assign(window.__state.chat.messages[0].creditUsage, { status:"partial", reportedCalls:1, totalCalls:2, credits:"0", totalNanoAiu:"0" });
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.equal(await message.locator(".message-credits").innerText(), "0 credits (partial: 1/2 calls)");
  await page.evaluate(localization => {
    window.__state.localization = localization;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  }, { locale:"zh-hans", english:JSON.parse(fs.readFileSync(path.join(__dirname, "../resources/locales/en.json"))).strings,
    strings:JSON.parse(fs.readFileSync(path.join(__dirname, "../resources/locales/zh-hans.json"))).strings });
  assert.equal(await message.locator(".message-credits").innerText(), "0 Credit（不完整：1/2 次调用）");
  assert.match(await message.locator(".activity-usage").textContent(), /未报告缓存用量/);
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
  assert.equal(await message.locator(".message-credits").innerText(), "0 Credit");
  assert.equal(await message.locator(".activity-usage").textContent(), "0 Credit");
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
test("Profiles action fits its button without spilling into adjacent toolbar controls", async t => {
  const { page } = await open(t);
  for (const width of [320, 360, 1280]) {
    await page.setViewportSize({ width, height:900 });
    const size = await page.getByRole("button", { name:"User / Agent Profiles", exact:true }).evaluate(element => ({
      client:element.clientWidth, content:element.scrollWidth,
    }));
    assert(size.content <= size.client, `Profiles label overflows at ${width}px: ${JSON.stringify(size)}`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
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
  await page.mouse.wheel(0, -40);
  await page.waitForFunction(top => document.getElementById("messages").scrollTop < top - 10, bottom);
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

test("Chat List has no global Portal entry and keeps the draft without submitting", async t => {
  const { page, errors } = await open(t);
  await page.locator("#prompt").fill("Keep my unsent draft");
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
  assert.match(await page.locator("#chat-status").innerText(), /Controlling DESKTOP-56TITCC · Windows Sync/);
  assert.equal(await page.locator("#chat-portal .portal-open").count(), 1);
  assert.equal(await page.locator("#chat-portal .portal-side-wizard, #chat-portal .pixel-wizard-frame").count(), 0);
  assert.equal(await page.locator("#chat-portal .portal-ring").getAttribute("cx"), "12");
  const openButton = await page.locator("#chat-portal").innerHTML();
  assert.equal(await page.locator("#portal-details").isVisible(),false);
  assert.equal(await page.locator("#portal-state").innerText(),"Portal Connected - Permission scoped");
  assert(await page.locator("#portal-state").evaluate(node=>node.getBoundingClientRect().height<=34),"connection summary must occupy one line");
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
  assert.equal(await page.locator("#chat-status .portal-open .portal-side-wizard").count(), 1, "top-left status shows the wizard beside the open Portal");
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

test("terminal wizards sleep side-on at a desk with animated zZZ; failures keep a red light", async t => {
    const { page } = await open(t);
    const results = await page.evaluate(() => {
      const results = [];
      for (const role of [undefined, "manager", "worker", "controller", "controlled"]) for (const state of ["completed", "new-result", "failed", "running", "paused", "stopped"]) {
        const node = window.PkmChatStatusIndicator(state, role);
        document.body.append(node);
        results.push({ state, role, label:node.getAttribute("aria-label"), stateAttr:node.dataset.state,
          sleeping:node.classList.contains("wizard-sleeping"), sooty:node.classList.contains("wizard-sooty"),
          onBreak:node.classList.contains("wizard-on-break"), cup:!!node.querySelector(".wizard-break-cup"),
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
      if (["completed", "new-result"].includes(result.state)) {
        assert.equal(result.sleeping, true); assert.equal(result.zzz, "zZZ"); assert.equal(result.light, "rgb(82, 187, 128)");
        assert.equal(result.facing, "side"); assert.equal(result.desk, true); assert(result.face <= 24);
        assert.equal(result.snores.length, 3); assert(result.snores.every(letter => letter.name === "wizard-snore"));
        assert.equal(new Set(result.snores.map(letter => letter.delay)).size, 3);
      } else if (result.state === "failed") {
        assert.equal(result.sooty, true); assert.equal(result.eyes, 2); assert(result.face <= 42);
        assert.equal(result.light, "rgb(239, 108, 108)"); assert.notEqual(result.lightDisplay, "none");
        assert.deepEqual(result.lightPosition, ["0px", "0px"]); assert.equal(result.lightShape, "50%");
      } else if (["paused", "stopped"].includes(result.state)) {
        assert.equal(result.onBreak, true); assert.equal(result.cup, true); assert.equal(result.steam, 2);
        assert.equal(result.sleeping, false); assert.equal(result.sooty, false); assert.equal(result.zzz, undefined);
        assert.equal(result.stateAttr, result.state, "Paused and Stopped remain distinct states");
        assert.equal(result.light, result.state === "paused" ? "rgb(227, 179, 65)" : "rgb(157, 163, 168)");
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

test("paused wizards take a tea break, animate gently, honor reduced motion and appear in Portal status", async t => {
  const { page, errors } = await open(t, 390);
  await page.evaluate(() => {
    window.__state.chat.paused = true;
    window.__state.chats[0].status = window.__state.library.chats[0].status = "paused";
    window.dispatchEvent(new MessageEvent("message", {data:window.__state}));
  });
  assert.equal(await page.locator('#chat-status .wizard-on-break[data-state="paused"]').count(), 1);
  assert.equal(await page.locator('.chat-list-open .wizard-on-break[data-state="paused"]').count(), 1);
  assert.equal(await page.locator("#send").getAttribute("aria-label"), "Resume Chat");
  await page.locator("#send").click();
  assert.equal(await page.evaluate(() => __posts.filter(item => item.type === "resume").length), 1,
    "the new status animation does not change resume behavior");
  const frames = () => page.locator("#chat-status .wizard-break-breathe, #chat-status .wizard-break-steam")
    .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).transform));
  const before = await frames();
  await page.waitForTimeout(260);
  const after = await frames();
  assert.equal(before.length, 3);
  assert(before.every((value, index) => value !== after[index]), "body and both steam wisps actually animate");
  await page.evaluate(async () => {
    document.body.classList.add("chat-backgrounded");
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const frozen = await frames();
  await page.waitForTimeout(180);
  assert.deepEqual(await frames(), frozen, "tea-break animation freezes in background views");
  await page.evaluate(() => document.body.classList.remove("chat-backgrounded"));
  await page.emulateMedia({reducedMotion:"reduce"});
  assert.deepEqual(await page.locator("#chat-status .wizard-break-breathe, #chat-status .wizard-break-steam, #chat-status .wizard-eye")
    .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationName)), ["none", "none", "none", "none", "none"]);
  await page.emulateMedia({reducedMotion:"no-preference"});
  for (const role of ["controller", "controlled"]) {
    await page.evaluate(role => {
      window.__state.portal = {connected:true, binding:{role, peerName:"Fixture peer"}};
      window.dispatchEvent(new MessageEvent("message", {data:window.__state}));
    }, role);
    const indicator = page.locator("#chat-status .wizard-on-break");
    assert.equal(await indicator.getAttribute("data-state"), "paused");
    assert.match(await indicator.getAttribute("aria-label"), new RegExp(`${role}.*Paused`, "i"));
    assert.equal(await page.locator("#chat-portal .portal-open").count(), 1,
      "pausing changes the Chat status, not the Portal connection");
  }
  await page.evaluate(() => {
    window.__state.chat.paused = false;
    window.__state.chats[0].status = window.__state.library.chats[0].status = "running";
    window.dispatchEvent(new MessageEvent("message", {data:window.__state}));
  });
  assert.equal(await page.locator("#chat-status .wizard-on-break").count(), 0);
  assert.equal(await page.locator("#chat-status .portal-open").count(), 1, "resuming restores the Portal status scene");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1));
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

test("an over-budget composer explains why Send is disabled and clears the warning after correction", async t => {
  const { page, errors } = await open(t);
  await page.evaluate(() => {
    window.__state.settings.inputBaseTokens = 17000;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  await page.locator("#prompt").fill("Small request");
  assert.equal(await page.locator("#send").isDisabled(), true);
  assert.match(await page.locator("#composer-budget-warning").innerText(), /exceeds this context budget/);
  await page.evaluate(() => {
    window.__state.settings.inputBaseTokens = 100;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  });
  assert.equal(await page.locator("#composer-budget-warning").isVisible(), false);
  assert.equal(await page.locator("#send").isEnabled(), true);
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

test("model activity distinguishes rounds and reserves waiting labels for the current round", async t => {
  const { page, errors } = await open(t, 390);
  await page.evaluate(() => {
    const now = Date.now() - 3000;
    const progress = { attemptId:"round-labels", startedAt:now, status:"running", steps:[
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
  assert.match(await rows.nth(0).innerText(), /Model round 1: Model response received/);
  assert.match(await rows.nth(1).innerText(), /Model round 2: Waiting for model response/);
  assert.match(await activity.locator(":scope > summary").innerText(), /Model round 2: Waiting for model response/);
  assert.doesNotMatch(await activity.innerText(), /Waiting for first output/);
  await page.evaluate(localization => {
    window.__state.localization = localization;
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
  }, { locale:"zh-hans", english:JSON.parse(fs.readFileSync(path.join(__dirname, "../resources/locales/en.json"))).strings,
    strings:JSON.parse(fs.readFileSync(path.join(__dirname, "../resources/locales/zh-hans.json"))).strings });
  assert.match(await rows.nth(0).innerText(), /第 1 轮模型交互: 已收到模型响应/);
  assert.match(await rows.nth(1).innerText(), /第 2 轮模型交互: 等待模型响应/);
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
  assert.match(await rows.last().innerText(), /Model round 2: Waiting for model response \(the model may be reasoning\) · running/);
  const dot = await rows.last().locator(".workflow-dot").evaluate(node => getComputedStyle(node).backgroundColor);
  assert.equal(dot, "rgb(55, 148, 255)", "running dot uses the theme's chart blue");
  assert.match(await rows.last().locator(".activity-thinking").innerText(), /Thinking: …Compare both files first\./);
  assert.deepEqual(errors, []);
});

test("live activity starts readable and expanded, preserves collapse and separates reported reasoning usage", async t => {
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
  const model = activity.locator(".activity-event").filter({ hasText:"Model round 1: Model response received" });
  assert.equal(await model.locator(".activity-usage").innerText(), "100 in / 20 out · 7 reasoning · Cache usage not reported");
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
  const tool = details.filter({ hasText:"Read fixture · complete" });
  assert.equal(await tool.getAttribute("open"), null);
  await tool.locator("summary").click();
  assert.match(await tool.innerText(), /"path":"fixture"/);
  assert.equal(await tool.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.__unsafe)), false);
  const model = details.filter({ hasText:"Model round 1: Model response received" });
  assert.equal(await model.locator(".activity-usage").innerText(), "100 in / 20 out · Cache usage not reported");
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
    const portal = { connected:true, binding:{ role:"controlled", pairId:"pair", peerName:"linux-controller", peerMachine:"br1u42", peerChatName:"Portal: windows debug", peerCapabilities:["observations-v1", "files-v1", "resume-v1"] } };
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
  assert.match(await page.locator("#chat-status").innerText(), /Controlled by br1u42 · Portal: windows debug/);
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
