const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");

const webview = path.join(__dirname, "..", "dist", "webview");
const chatId = "11111111-1111-4111-8111-111111111111";
async function open(t, width = 1280) {
  const browser = await chromium.launch({ headless:true, ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath:process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width, height:900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const html = fs.readFileSync(path.join(webview, "api-chat.html"), "utf8")
    .replace(/<meta http-equiv[^>]*>/, "").replace(/<link[^>]*>/g, "").replace(/<script[^>]*><\/script>/g, "");
  await page.route("http://localhost/pkm-chat-fixture", route => route.fulfill({ contentType:"text/html", body:html }));
  await page.goto("http://localhost/pkm-chat-fixture");
  await page.evaluate(id => {
    window.__posts = [];
    window.acquireVsCodeApi = () => ({ getState:() => ({ screen:"chat" }), setState:value => { window.__saved = value; }, postMessage:value => window.__posts.push(value) });
    const profile = { id:"fixture", label:"Fixture", status:"active", contextWindow:16384, maxOutputTokens:4096 };
    window.__state = { type:"state", busy:false, chat:{ id, title:"Activity fixture", includeHistory:true, context:[], permissionMode:"ask", messages:[] },
      settings:{ model:"fixture", models:[], provider:"openai-compatible", endpoint:"https://example.test/v1", contextWindow:16384, maxOutputTokens:2048,
        maxToolRounds:30, inputBaseTokens:100, profiles:[profile], selectedProfile:profile },
      chats:[{ id, title:"Activity fixture", groupId:"ungroup", status:"idle" }],
      library:{ groups:[], chats:[{ id, title:"Activity fixture", groupId:"ungroup", status:"idle" }] } };
  }, chatId);
  await page.addStyleTag({ path:path.join(webview, "api-chat.css") });
  await page.addScriptTag({ path:path.join(webview, "marked.umd.js") });
  await page.addScriptTag({ path:path.join(webview, "purify.min.js") });
  await page.addScriptTag({ path:path.join(webview, "api-chat-library.js") });
  await page.addScriptTag({ path:path.join(webview, "chat-visualization.js") });
  await page.addScriptTag({ path:path.join(webview, "api-chat.js") });
  assert(await page.evaluate(() => window.__posts.some(item => item.type === "ready")), "Chat renderer initialized");
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", { data:window.__state }));
    window.dispatchEvent(new MessageEvent("message", { data:{ type:"showChat" } }));
  });
  await page.waitForTimeout(30);
  assert.deepEqual(errors, []);
  await page.locator("#prompt").waitFor({ state:"visible" });
  return { page, errors };
}

test("Chat history pages automatically without a load button and preserves the visible message", async t => {
  const { page, errors } = await open(t);
  await page.evaluate(() => {
    window.__state.history = { start: 40 };
    window.__state.chat.messages = Array.from({ length: 20 }, (_, index) => ({
      id: `recent-${index}`, role: "user", content: `Recent ${index}\n${"History content\n".repeat(12)}`,
    }));
    window.dispatchEvent(new MessageEvent("message", { data: window.__state }));
  });
  assert.equal(await page.getByRole("button", { name: /Load older messages/ }).count(), 0);
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
  await page.locator("#chat-portal").click();
  assert.deepEqual(await page.evaluate(() => window.__posts.filter(item => item.type === "peerCollaboration")), [{ type: "peerCollaboration", chatId }],
    "clicking an open Portal opens its controls rather than immediately disconnecting");
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
      for (const role of [undefined, "manager", "worker", "controller", "controlled"]) for (const state of ["completed", "new-result", "failed", "running", "stopped"]) {
        const node = window.PkmChatStatusIndicator(state, role);
        document.body.append(node);
        results.push({ state, role, label:node.getAttribute("aria-label"), stateAttr:node.dataset.state,
          sleeping:node.classList.contains("wizard-sleeping"), sooty:node.classList.contains("wizard-sooty"),
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
    return { label:node.getAttribute("aria-label"), fill:getComputedStyle(node, "::before").backgroundImage };
  });
  assert.equal(indicator.label, "Stopped"); assert.match(indicator.fill, /linear-gradient/);
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
  const tool = details.filter({ hasText:"read_file · complete" });
  assert.equal(await tool.getAttribute("open"), null);
  await tool.locator("summary").click();
  assert.match(await tool.innerText(), /"path":"fixture"/);
  assert.equal(await tool.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.__unsafe)), false);
  const model = details.filter({ hasText:"Generating response" });
  assert.equal(await model.locator(".activity-usage").innerText(), "100 in / 20 out");
  const order = await model.locator("summary").evaluate(node => [...node.children].map(child => child.className));
  assert(order.indexOf("activity-usage") < order.indexOf("elapsed"));
  await model.locator("summary").click();
  assert.match(await model.innerText(), /Check input boundaries/);
  assert.match(await tool.locator(".activity-usage").innerText(), /n\/a/);
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
    return page.locator("#portal-state strong").innerText();
  };
  const binding = role => ({ role, pairId:"p", peerName:"peer", peerMachine:"DESKTOP-56TITCC", peerChatName:"Diagnose" });
  assert.equal(await headline({ connected:true, reviewMode:"manual", binding:binding("controlled") }), "Controlled by DESKTOP-56TITCC · Diagnose · controller checks status manually");
  assert.equal(await headline({ connected:true, reviewMode:"auto", binding:binding("controlled") }), "Controlled by DESKTOP-56TITCC · Diagnose · progress auto-sent to controller");
  assert.equal(await headline({ connected:true, reviewMode:"auto", binding:binding("controller") }), "Controlling DESKTOP-56TITCC · Diagnose · auto-review on remote progress");
  assert.equal(await headline({ connected:false, binding:binding("controller") }), "Controlling DESKTOP-56TITCC · Diagnose · reconnecting…");
  assert.equal(await headline({ connected:false }), "Portal open · waiting for a peer to pair");
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
