const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const { fixture, actionId, runId, childId } = require("./native-harness-fixture");

const webview = path.join(__dirname, "..", "src", "webview");
const managerId = "11111111-1111-4111-8111-111111111111";
const workerId = "22222222-2222-4222-8222-222222222222";
const plainId = "33333333-3333-4333-8333-333333333333";

function library() {
  return { groups:[{ id:"research", name:"Research" }], chats:[
    { id:managerId, title:"Manager chat", groupId:"research", status:"running", updatedAt:"2026-10-20T10:00:00Z", workerTreeId:"tree", workerManager:true },
    { id:workerId, title:"Worker chat", groupId:"ungroup", status:"awaiting-result", updatedAt:"2026-10-20T10:01:00Z", workerParentChatId:managerId, workerTreeId:"tree" },
    { id:plainId, title:"Plain chat", groupId:"ungroup", status:"completed", updatedAt:"2026-10-20T09:00:00Z" },
  ] };
}
function snapshot(title) {
  const data = fixture();
  data.task = title;
  const attempt = data.harness.attempts[1];
  const start = Date.now() - 60_000;
  attempt.progress = { status:"running", startedAt:start, droppedSteps:0, transitions:[
    { label:"Retrieving context", at:start, status:"complete" },
    { label:"Waiting for approval", at:start + 10_000, status:"waiting" },
    { label:"Calling tool", at:start + 30_000, status:"running" }] };
  attempt.toolCalls[0].startedAt = start + 31_000; attempt.toolCalls[0].finishedAt = start + 40_000;
  attempt.toolCalls.push({ id:"call3", name:"search_knowledge", status:"failed", arguments:'{"query":"aml retry"}', resultPreview:"timeout",
    startedAt:start + 41_000, finishedAt:start + 45_000, actionRunIds:[] });
  attempt.budgetReceipts = [{ at:start + 5_000, round:0, status:"sent" }];
  attempt.retrieval = [{ kind:"selection", at:start + 1_000, receipt:{ query:"aml retry policy", selectedCount:1, model:"fixture-model", phase:"sent",
    candidates:[{ id:"n1", label:"Retry note", kind:"note", method:"lexical", score:2, selected:true, evidenceState:"sent" },
      { id:"n2", label:"Old memo", kind:"note", method:"lexical", score:1, selected:false, reason:"below threshold" }] } }];
  attempt.memory = { turn:"t2", model:"memory-model", durationMs:850, blocks:[
    { kind:"focus-topic", piece:"topic:aml", characters:420 }, { kind:"earlier-message", piece:"m|m1", characters:900 }] };
  return data;
}

async function open(t, viewport, mutate = () => {}) {
  const browser = await chromium.launch({ headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport, reducedMotion:"reduce" });
  const errors = [], posted = [], held = [];
  let hold = false;
  page.on("pageerror", error => errors.push(error.message));
  const reply = message => page.evaluate(value => window.postMessage(value, "*"), message);
  await page.exposeFunction("hostPost", async message => {
    posted.push(message);
    if (message.type === "ready") await reply({ type:"library", library:library() });
    if (message.type === "request") {
      const chat = library().chats.find(item => item.id === message.chatId);
      const data = message.method === "result" ? JSON.stringify({ results:[{ id:"a" }, { id:"b" }, { id:"c" }], pad:"y".repeat(2500) })
        : (() => { const value = snapshot(chat.title); mutate(value); return value; })();
      if (message.method === "snapshot") data.updatedAt = `snapshot-${posted.filter(item => item.type === "request").length}`;
      const response = { type:"result", requestId:message.requestId, chatId:message.chatId, data };
      if (hold) held.push(response); else await reply(response);
    }
  });
  const html = fs.readFileSync(path.join(webview, "visualization-window.html"), "utf8")
    .replace(/<meta http-equiv[^>]*>/, "").replace(/<link[^>]*>/g, "").replace(/<script[^>]*><\/script>/g, "");
  await page.setContent(html);
  await page.evaluate(() => {
    let state;
    window.acquireVsCodeApi = () => ({ postMessage:message => window.hostPost(message), getState:() => state, setState:value => { state = value; } });
  });
  await page.addStyleTag({ path:path.join(webview, "agent-harness.css") });
  await page.addStyleTag({ path:path.join(webview, "visualization-window.css") });
  await page.addScriptTag({ path:path.join(webview, "agent-harness.js") });
  await page.addScriptTag({ path:path.join(__dirname, "..", "dist", "webview", "chat-retrieval-flow.js") });
  await page.addScriptTag({ path:path.join(webview, "visualization-window.js") });
  return { page, errors, posted, held, reply, holdResults(value) { hold = value; } };
}

for (const width of [1280, 700, 390]) test(`visualization bindings: nested receipts and preserved graph view (${width}px)`, { timeout:60000 }, async t => {
  const missing = "action_run_missing";
  const { page, errors, posted, reply } = await open(t, { width, height:900 }, data => {
    if (data.task === "Manager chat") data.task = "VIS complete runtime chain with recorded nested execution";
    data.harness.attempts[1].toolCalls[0].actionRunIds.push(missing);
    data.actionRuns[0].state = "awaiting-result";
    data.actionRuns[0].execution = { phase:"waiting", receipts:[{ operation:"submitted", remoteJobId:"job-fixture", at:1 }] };
  });
  await page.locator(`[data-chat-id="${managerId}"] > .pkm-vis-treerow`).click();
  const heading = await page.locator(".pkm-vis-head h1").boundingBox();
  assert(heading.width >= 220 && heading.height < 120, "dashboard title must wrap by words, not collapse to a one-character column");
  const grid = await page.locator(".pkm-vis-grid").evaluate(node => ({
    columns:getComputedStyle(node).gridTemplateColumns.split(" ").length,
    width:node.getBoundingClientRect().width,
  }));
  if (grid.width <= 900) assert.equal(grid.columns, 1, "the dashboard's own width, not the whole window, controls stacking");
  const tile = name => page.getByRole("navigation", { name:"Dashboard views" }).getByRole("button", { name:new RegExp(`^${name}`) });
  await tile("Recipe \\/ Action").click();
  const bindings = page.getByRole("navigation", { name:"Recorded Recipe and Action bindings" });
  await bindings.getByRole("button", { name:"Open recorded Recipe: Development", exact:true }).waitFor();
  assert.equal(await bindings.getByRole("button", { name:`Open recorded Action: ${missing}`, exact:true }).isDisabled(), true);
  assert.match(await bindings.innerText(), /Attempt 2[\s\S]*explicit recorded bindings only[\s\S]*not evidence that a remote job completed/);
  const graph = page.locator(".pkm-vis-main-harness");
  await graph.getByRole("button", { name:"Open subgraph: Debug", exact:true }).click();
  await graph.getByRole("button", { name:"Inspect evidence", exact:true }).click();
  const zoom = graph.getByRole("slider", { name:"Graph zoom" });
  await zoom.fill("150");
  await zoom.dispatchEvent("input");
  const viewport = graph.locator(".pkm-harness-viewport");
  await viewport.evaluate(node => { node.scrollTop = 60; node.scrollLeft = 80; });
  const scroll = await viewport.evaluate(node => ({ left:node.scrollLeft, top:node.scrollTop }));
  await tile("Memory").click();
  await tile("Recipe \\/ Action").click();
  assert.equal(await zoom.inputValue(), "150");
  assert.deepEqual(await viewport.evaluate(node => ({ left:node.scrollLeft, top:node.scrollTop })), scroll);
  assert.equal(await graph.locator(".pkm-harness-node.selected").getAttribute("data-node-id"), "inspect");
  await graph.getByRole("button", { name:"Back to parent", exact:true }).click();
  await graph.getByRole("button", { name:"Debug", exact:true }).waitFor();

  await bindings.getByRole("button", { name:"Open recorded Action: fixture.script", exact:true }).click();
  await graph.getByRole("button", { name:"Durable Action receipts", exact:true }).click();
  assert.match(await graph.locator(".pkm-harness-inspector").innerText(), /waiting[\s\S]*submitted[\s\S]*job-fixture/);
  assert.match(await bindings.innerText(), /Action: fixture.script \/ awaiting-result/);
  await graph.getByRole("button", { name:"Open subgraph: branch", exact:true }).click();
  await graph.getByRole("button", { name:"branch/then/skipped", exact:true }).click();
  assert.match(await graph.locator(".pkm-harness-inspector").innerText(), /unnecessary component[\s\S]*component-receipt/);
  assert.match(await graph.locator(".pkm-harness-inspector").innerText(), new RegExp(actionId));
  await tile("Execution graph").click();
  await tile("Recipe \\/ Action").click();
  assert.equal(await graph.locator(".pkm-harness-node.selected").getAttribute("data-node-id"), "branch/then/skipped");
  const before = posted.filter(item => item.type === "request").length;
  await reply({ type:"library", library:library(), changed:true });
  await page.waitForFunction(count => document.querySelector(".pkm-harness > header span")?.textContent.includes(`record: snapshot-${count}`), before + 1);
  assert.equal(posted.filter(item => item.type === "request").length, before + 1);
  assert.equal(await graph.locator(".pkm-harness-node.selected").getAttribute("data-node-id"), "branch/then/skipped");
  const overflow = await page.locator(".pkm-vis-dashboard").evaluate(node => ({ width:node.clientWidth, content:node.scrollWidth, left:node.scrollLeft }));
  assert(overflow.content <= overflow.width + 1, `long binding summaries must not widen the dashboard: ${JSON.stringify(overflow)}`);
  assert.equal(overflow.left, 0, "navigation must not scroll the dashboard horizontally and clip the graph");
  if (process.env.PKM_VIS_WINDOW_SCREENSHOT) {
    await page.screenshot({ path:`${process.env.PKM_VIS_WINDOW_SCREENSHOT}-bindings-${width}.png`, fullPage:true });
  }

  // The graph state belongs to this Chat, not to another Chat with identical fixture run IDs.
  await page.locator(`[data-chat-id="${plainId}"] > .pkm-vis-treerow`).click();
  await page.getByRole("heading", { name:"Plain chat", level:1 }).waitFor();
  await graph.getByRole("button", { name:"Debug", exact:true }).waitFor();
  assert.equal(await zoom.inputValue(), "100");
  assert.equal(await graph.locator(".pkm-harness-node.selected").count(), 0);
  assert(posted.filter(item => item.type === "request").every(item => item.method === "snapshot"), "drilldown only reads snapshots; it never executes a Recipe or Action");
  assert.deepEqual(errors, []);
});

test("visualization bindings: current Recipe stage wins over completed bindings; missing records are explicit", { timeout:60000 }, async t => {
  const { page, errors } = await open(t, { width:1280, height:900 }, data => {
    if (data.task === "Plain chat") { data.runs = []; data.actionRuns = []; return; }
    data.runs[0].status = "completed";
    data.todos[0].recipeRunIds = [runId, childId];
    data.harness.attempts[1].planning = { recipeRunId:childId, recipeStageId:"inspect" };
  });
  await page.locator(`[data-chat-id="${managerId}"] > .pkm-vis-treerow`).click();
  await page.getByRole("navigation", { name:"Dashboard views" }).getByRole("button", { name:/^Recipe \/ Action/ }).click();
  const graph = page.locator(".pkm-vis-main-harness");
  await graph.getByRole("button", { name:"Inspect evidence", exact:true }).waitFor();
  const bindings = page.getByRole("navigation", { name:"Recorded Recipe and Action bindings" });
  await bindings.getByRole("button", { name:"Open recorded Recipe: Nested debug / inspect", exact:true }).click();
  assert.equal(await graph.locator(".pkm-harness-node.selected").getAttribute("data-node-id"), "inspect");

  await page.locator(`[data-chat-id="${plainId}"] > .pkm-vis-treerow`).click();
  await page.getByText("Explicit bindings are recorded, but their execution records are unavailable.", { exact:false }).waitFor();
  assert.equal(await graph.isHidden(), true);
  assert.equal(await bindings.getByRole("button").count(), 2);
  for (const node of await bindings.getByRole("button").all()) assert.equal(await node.isDisabled(), true);
  assert.deepEqual(errors, []);
});

test("visualization window: Chat tree mirrors groups and workers, dashboard enlarges each recorded view", { timeout:60000 }, async t => {
  const { page, errors, posted } = await open(t, { width:1280, height:900 });
  const tree = page.getByRole("tree", { name:"Chats by group" });
  await tree.getByRole("treeitem", { name:/Research/ }).waitFor();
  assert.equal(await tree.locator('[role="treeitem"][aria-level="1"]').count(), 2, "Ungroup + one user folder, no Trash");
  const manager = tree.locator(`[data-chat-id="${managerId}"]`);
  assert.equal(await manager.getAttribute("aria-expanded"), "false");
  assert.equal(await tree.locator(`[data-chat-id="${workerId}"]`).count(), 0, "Workers nest under their manager, not in Ungroup");
  await manager.getByRole("button", { name:"Expand workers of Manager chat" }).click();
  await tree.locator(`[data-chat-id="${workerId}"][aria-level="3"]`).waitFor();

  await manager.locator(":scope > .pkm-vis-treerow").click();
  await page.getByRole("heading", { name:"Manager chat", level:1 }).waitFor();
  const tiles = page.getByRole("navigation", { name:"Dashboard views" }).getByRole("button");
  const tile = name => page.getByRole("navigation", { name:"Dashboard views" }).getByRole("button", { name:new RegExp(`^${name}`) });
  assert.equal(await tiles.count(), 6);
  assert.equal(await tiles.first().getAttribute("aria-pressed"), "true");
  await page.getByRole("group", { name:"Harness lifecycle" }).waitFor();
  assert.equal(await page.locator(".pkm-vis-mini-ring [aria-current='step']").count(), 1);
  assert.equal(await page.getByRole("button", { name:/C R M/ }).count(), 0, "decorative mini ring is not announced");

  await tile("Timeline").click();
  await page.getByRole("heading", { name:"Timeline", level:2 }).waitFor();
  assert(await page.locator(".pkm-vis-main-harness").isHidden());
  assert.equal(await page.locator(".pkm-vis-lane").count(), 3, "stage lane + one lane per timed call");
  assert.match(await page.locator(".pkm-vis-main-detail").innerText(), /Waits and blockers[\s\S]*Waiting for approval[\s\S]*search_knowledge/);

  await tile("Memory").click();
  assert.match(await page.locator(".pkm-vis-main-detail").innerText(), /memory-model[\s\S]*focus-topic: 1, earlier-message: 1[\s\S]*1320/);

  await tile("Retrieval \\/ Search").click();
  const detail = page.locator(".pkm-vis-main-detail");
  assert.match(await detail.innerText(), /aml retry policy[\s\S]*1 of 2 candidates[\s\S]*below threshold/);
  assert.equal(await detail.locator(".pkm-vis-flow svg").count(), 1, "Reuses the candidate to model Sankey");
  assert.match(await detail.innerText(), /Search-type tool calls[\s\S]*search_knowledge/);

  await tile("Recipe \\/ Action").click();
  assert(await page.locator(".pkm-vis-main-harness").isVisible());
  await page.getByRole("navigation", { name:"Graph ancestors" }).getByRole("button", { name:"Development", exact:true }).waitFor();

  await tile("Execution graph").click();
  await page.locator(".pkm-harness-node.selected").waitFor();
  if (process.env.PKM_VIS_WINDOW_SCREENSHOT) {
    await tile("Lifecycle").click();
    await page.screenshot({ path:`${process.env.PKM_VIS_WINDOW_SCREENSHOT}-desktop.png`, fullPage:true });
    await tile("Timeline").click();
    await page.screenshot({ path:`${process.env.PKM_VIS_WINDOW_SCREENSHOT}-timeline.png`, fullPage:true });
  }
  assert(posted.filter(item => item.type === "request").every(item => item.method === "snapshot" && item.chatId === managerId));
  assert.deepEqual(errors, []);
});

test("visualization window: keyboard tree, late results stay with their Chat, removed Chat clears the dashboard", { timeout:60000 }, async t => {
  const { page, errors, held, reply, holdResults } = await open(t, { width:390, height:900 });
  const tree = page.getByRole("tree", { name:"Chats by group" });
  await tree.getByRole("treeitem", { name:/Research/ }).waitFor();
  assert.equal(await page.locator(".pkm-vis-tree-pane").evaluate(node => getComputedStyle(node.parentElement).gridTemplateColumns.split(" ").length), 1);
  holdResults(true);
  await tree.locator(`[data-chat-id="${managerId}"] > .pkm-vis-treerow`).click();
  await page.waitForFunction(() => document.querySelector('[aria-selected="true"]'));
  const first = tree.locator('[role="treeitem"][tabindex="0"]');
  await first.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.chatId), plainId, "Ungroup holds only the non-worker Chat");
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name:"Plain chat", level:1 }).waitFor();
  const selectedTitle = await page.locator("h1").innerText();
  for (let i = 0; held.length < 2 && i < 250; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(held.length, 2, "both selections requested a snapshot");
  holdResults(false);
  await reply(held[1]);
  await page.locator(".pkm-harness").waitFor();
  await reply(held[0]);
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".pkm-harness").count(), 1, "the late first result does not mount a second renderer");
  assert.equal(await page.locator("h1").innerText(), selectedTitle);
  if (process.env.PKM_VIS_WINDOW_SCREENSHOT) await page.screenshot({ path:`${process.env.PKM_VIS_WINDOW_SCREENSHOT}-narrow.png`, fullPage:true });

  const remaining = library(); remaining.chats = remaining.chats.filter(chat => chat.title !== selectedTitle);
  await reply({ type:"library", library:remaining, changed:true });
  await page.getByText("The selected Chat is no longer available").waitFor();
  assert.equal(await page.locator(".pkm-harness").count(), 0, "renderer disposed with the removed Chat");
  assert.deepEqual(errors, []);
});

test("visualization window: retrieval stages explain shortlist vs sent, filter candidates, open PKM sources, load full search results", { timeout:60000 }, async t => {
  const start = Date.now() - 5_000;
  const { page, errors, posted, reply } = await open(t, { width:1280, height:900 }, data => {
    const attempt = data.harness.attempts[1];
    const receipt = attempt.retrieval[0].receipt;
    receipt.candidates[0].sourceUri = `pkm://knowledge/knowledge_${"a".repeat(24)}`;
    receipt.candidates[0].range = { start:0, end:120, unit:"chars" };
    receipt.candidates[1].sourceUri = "https://example.com/not-pkm";
    receipt.phase = "recalled";
    attempt.retrieval.push({ kind:"sent-round", round:1, at:start, inputTokens:900, inputBudget:4000, receipt:{ ...receipt, phase:"sent" } });
    attempt.toolCalls.push({ id:"call4", name:"search_notes", status:"complete", arguments:'{"query":"retry","limit":5}',
      resultPreview:"{\"results\":[", resultCharacters:2600, resultTruncated:true, startedAt:start, finishedAt:start + 300, actionRunIds:[] });
    data.harness.attempts = data.harness.attempts.slice(0, 2);
    data.harness.currentPhase = { kind:"retrieval", label:"Retrieving knowledge" };
  });
  const tree = page.getByRole("tree", { name:"Chats by group" });
  await tree.locator(`[data-chat-id="${managerId}"] > .pkm-vis-treerow`).click();
  await page.getByRole("heading", { name:"Manager chat", level:1 }).waitFor();
  await page.getByRole("navigation", { name:"Dashboard views" }).getByRole("button", { name:/^Retrieval \/ Search/ }).click();
  const detail = page.locator(".pkm-vis-main-detail");
  await detail.getByRole("status").filter({ hasText:"Retrieval running" }).waitFor();
  const tabs = detail.getByRole("tablist", { name:"Retrieval receipts" }).getByRole("tab");
  assert.equal(await tabs.count(), 2);
  assert.match(await detail.innerText(), /Shortlist: .*Not necessarily sent/);
  await tabs.nth(1).click();
  assert.match(await tabs.nth(1).innerText(), /Sent \/ model round 2/);
  assert.match(await detail.innerText(), /PKM estimates, not a provider confirmation[\s\S]*900 \/ 4000/);

  const filter = detail.getByRole("combobox", { name:"Filter candidates" });
  assert.deepEqual(await filter.locator("option").allInnerTexts(), ["all (2)", "sent (1)", "not selected (1)"]);
  await filter.selectOption("not selected");
  assert.equal(await detail.locator("tbody tr").count(), 1);
  assert.match(await detail.locator("tbody").innerText(), /Old memo[\s\S]*not navigable/);
  await filter.selectOption("all");
  assert.match(await detail.locator("tbody").innerText(), /\[0, 120\) chars/);
  await detail.getByRole("button", { name:"Open source of Retry note" }).click();
  assert.deepEqual(posted.filter(item => item.type === "openSource"),
    [{ type:"openSource", chatId:managerId, sourceUri:`pkm://knowledge/knowledge_${"a".repeat(24)}` }]);
  await reply({ type:"notice", message:"This source has no navigable PKM path." });
  await page.getByText("This source has no navigable PKM path.").waitFor();

  const call = detail.locator(".pkm-vis-call").filter({ hasText:"search_notes" });
  assert.match(await call.innerText(), /query[\s\S]*retry[\s\S]*limit[\s\S]*5[\s\S]*2600 characters/);
  await call.getByRole("button", { name:"Load full result of search_notes" }).click();
  await call.getByText(/3 hit\(s\)/).waitFor();
  assert.equal(await call.getByRole("button", { name:/Load full result/ }).count(), 0);
  const loads = posted.filter(item => item.method === "result");
  assert.equal(loads.length, 1);
  assert.equal(loads[0].chatId, managerId);
  assert.equal(loads[0].params.callId, "call4");
  assert.equal(typeof loads[0].params.messageId, "string");
  if (process.env.PKM_VIS_WINDOW_SCREENSHOT) await page.screenshot({ path:`${process.env.PKM_VIS_WINDOW_SCREENSHOT}-retrieval.png`, fullPage:true });
  assert.match(await detail.locator(".pkm-vis-call").filter({ hasText:"search_knowledge" }).innerText(), /aml retry[\s\S]*7 characters|timeout/);
  assert.deepEqual(errors, []);
});
