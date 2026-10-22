const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const { createNativeHarnessServer } = require("../dist/runtime/native-harness-server");
const { fixture, sessionId } = require("./native-harness-fixture");
const { createChatBudgetLedger, recordChatBudgetUsage, recordChatBudgetRuntime } = require("../dist/chat/chat-budget-ledger");

test("Run uses a rounded rectangle, displays only live activity, and distinguishes missing records from zero", { timeout:30000 }, async t => {
  const browser = await chromium.launch({ headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1100, height:900 } });
  await page.setContent('<main id="host"></main>');
  await page.addStyleTag({ path:path.join(__dirname, "../src/webview/agent-harness.css") });
  await page.addScriptTag({ path:path.join(__dirname, "../src/webview/agent-harness.js") });
  const data = fixture();
  Object.assign(data, { todos:[], runs:[], actionRuns:[] });
  data.harness = { state:"running", currentPhase:{ kind:"tool", label:"Calling read_file" }, attempts:[
    { messageId:"earlier", status:"complete", memory:{ blocks:[{kind:"focus-topic"}] }, toolCalls:[],
      retrieval:[{kind:"selection",receipt:{candidates:[{id:"n",label:"Recorded evidence",selected:true}]}}] },
    { messageId:"latest", status:"running", toolCalls:[{name:"read_file",status:"running"}] }
  ] };
  await page.evaluate(initial => {
    window.controller = PkmAgentHarness.mount(document.getElementById("host"), { initial, request:() => new Promise(() => {}) });
    window.controller.showLifecycle();
  }, data);
  const run = page.locator('.pkm-harness-stage[data-stage=run]');
  assert.equal(await run.locator(".pkm-harness-current-activity").innerText(), "read_file");
  const shape = await run.evaluate(node => ({ radius:getComputedStyle(node).borderRadius, width:node.clientWidth, height:node.clientHeight }));
  assert.equal(shape.radius, "12px");
  assert(shape.width > shape.height, "Run is a rectangle, not a circle");
  const failed = JSON.parse(JSON.stringify(data));
  failed.harness.state = "failed";
  Object.assign(failed.harness.attempts[1], { status:"failed", toolCalls:undefined, validation:{error:"Failed before model output"} });
  await page.evaluate(value => window.controller.update(value, true), failed);
  assert.equal(await run.locator(".pkm-harness-current-activity").count(), 0, "past activities disappear");
  assert.match(await page.locator(".pkm-harness-inspector").innerText(), /Run \(last recorded\)/);
  assert.match(await page.locator(".pkm-harness-inspector").innerText(), /not recorded/);
  assert.match(await page.locator(".pkm-harness-inspector").innerText(), /Failed before model output/);
  assert.match(await page.locator(".pkm-harness-ring-summary").innerText(), /Last recorded/);
  const dashboard = page.getByRole("region", { name:"Agent runtime dashboard" });
  assert.match(await dashboard.locator('[data-diagram=memory]').innerText(), /No Memory preparation receipt/);
  const recorded = JSON.parse(JSON.stringify(failed));
  Object.assign(recorded.harness.attempts[1], {
    toolCalls:[{id:"r1",name:"read_chat_result",status:"complete"},{id:"r2",name:"read_chat_result",status:"complete"}],
    memory:{blocks:Array.from({length:4},()=>({kind:"earlier-message"}))},
    retrieval:Array.from({length:6},()=>({kind:"sent-round",receipt:{candidates:[{id:"r",selected:true}]}}))
  });
  await page.evaluate(value => { window.controller.update(value, true); window.controller.showLifecycle(); }, recorded);
  assert.match(await page.locator(".pkm-harness-inspector").innerText(), /2 \(0 running, 0 failed\)/);
  assert.match(await dashboard.locator('[data-diagram=memory]').innerText(), /earlier-message: 4 block/);
  assert(await dashboard.locator('[data-diagram=retrieval] svg').count() > 0);
  await page.getByRole("combobox", {name:"Attempt records"}).selectOption("earlier");
  assert.match(await dashboard.locator('[data-diagram=memory]').innerText(), /focus-topic: 1 block/);
  assert(await dashboard.locator('[data-diagram=retrieval] svg').count() > 0, "recorded historical retrieval renders a graph");
  assert.match(await dashboard.locator('[data-diagram=recipes]').innerText(), /No available explicit Recipe/);
});

test("Agent runtime dashboard has a full-width diagnostic log, recorded parameters and simultaneous two-column diagrams", { timeout:30000 }, async t => {
  const data = fixture(), attempt = data.harness.attempts[1], methods = [];
  attempt.model = "fixture-model";
  attempt.validation = { reportedUsage:{ inputTokens:100, outputTokens:20, reasoningTokens:5 } };
  attempt.memory = { blocks:[{ kind:"focus-topic", piece:"topic", characters:400 }, { kind:"earlier-message", piece:"message", characters:900 }] };
  attempt.retrieval = [{ kind:"selection", receipt:{ phase:"prepared", candidates:[{ id:"n1", selected:true }, { id:"n2", selected:false }] } }];
  attempt.progress = { transitions:[{ label:'<script>window.__unsafe=true</script>', status:"failed", at:1 }] };
  attempt.budgetReceipts = [{ round:0, transport:{ provider:"http" }, requested:{ contextWindow:4096 },
    effective:{ outputTokens:512 }, ledger:{ thinkingPolicy:"provider-default", entries:[] } }];
  const server = await createNativeHarnessServer({ extensionPath:path.join(__dirname, ".."), sessionId,
    access() {}, async request(method) { methods.push(method); return data; } });
  t.after(() => server.dispose());
  const browser = await chromium.launch({ headless:true });
  t.after(() => browser.close());
  for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport:{ width, height:900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url);
    const dashboard = page.getByRole("region", { name:"Agent runtime dashboard" });
    const log = page.getByRole("log", { name:"Latest runtime diagnostics" });
    await log.waitFor();
    assert.match(await log.innerText(), /ERROR \/.*<script>/);
    assert.equal(await page.evaluate(() => Boolean(window.__unsafe)), false);
    const parameters = page.getByRole("table", { name:"Recorded runtime parameters" });
    assert.match(await parameters.innerText(), /fixture-model/);
    assert.match(await parameters.innerText(), /100 \/ 20/);
    assert.match(await parameters.innerText(), /Provider default \(no override\)/);
    const geometry = await dashboard.evaluate(node => {
      const grid = node.querySelector(".pkm-harness-diagram-grid");
      return { width:node.clientWidth, columns:getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        log:node.querySelector('[role="log"]').getBoundingClientRect().width };
    });
    assert.equal(geometry.columns, geometry.width > 540 ? 2 : 1);
    assert(geometry.log >= geometry.width - 2, "diagnostics span the entire dashboard");
    assert.equal(await dashboard.locator(".pkm-harness-diagram-card").count(), 4);
    assert.match(await dashboard.locator('[data-diagram="memory"]').innerText(), /focus-topic: 1 block/);
    assert.match(await dashboard.locator('[data-diagram="retrieval"]').innerText(), /Selected: 1/);
    await dashboard.getByRole("button", { name:"Inspect Harness flow", exact:true }).click();
    await page.locator('.pkm-harness-node').first().waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
    await page.close();
  }
  assert(methods.every(method => method === "snapshot"), "dashboard never dispatches execution or summary calls");
});

test("production browser: round ledger distinguishes provider usage, estimates and unknown thinking without model requests", { timeout:60000 }, async t => {
  const data = fixture(), methods = [];
  const receipt = {
    schema:"pkm.chat.budget/v1", at:1, round:0, modelId:"fixture", countingMethod:"utf8-byte-estimate",
    requested:{ contextWindow:4096, outputTokens:512, modelTimeoutMs:1800000, activeReviewMs:1800000, toolRoundReview:30 },
    effective:{ inputBudget:3584, outputTokens:512 }, consumed:{ estimatedInputTokens:1000, activeMs:50 },
    selectedReferenceIds:[], status:"sent"
  };
  receipt.ledger = createChatBudgetLedger(receipt, { currency:"USD" });
  recordChatBudgetUsage(receipt.ledger, { inputTokens:100, outputTokens:10 });
  recordChatBudgetRuntime(receipt.ledger, 50, 45050, 1);
  data.harness.attempts[1].budgetReceipts = [receipt];
  const server = await createNativeHarnessServer({ extensionPath:path.join(__dirname, ".."), sessionId,
    access() {}, async request(method) { methods.push(method); assert.equal(method, "snapshot"); return data; } });
  t.after(() => server.dispose());
  const browser = await chromium.launch({ headless:true });
  t.after(() => browser.close());
  for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport:{ width, height:900 } });
    await page.goto(server.url);
    await page.getByRole("button", { name:"Full execution graph", exact:true }).click();
    const expand = title => page.getByRole("button", { name:`Open subgraph: ${title}`, exact:true }).click();
    await expand("Implement and validate"); await expand("Fix the failing test"); await expand("Attempt 2");
    await expand("1 prepared rounds"); await expand("Round 0");
    await page.getByRole("button", { name:"Provider input (tokens)", exact:true }).click();
    assert.match(await page.locator(".pkm-harness-inspector").innerText(), /provider-reported/);
    await page.getByRole("button", { name:"Planned input (tokens)", exact:true }).click();
    assert.match(await page.locator(".pkm-harness-inspector").innerText(), /estimated/);
    await page.getByRole("button", { name:"Thinking (Provider default) (tokens)", exact:true }).click();
    assert.match(await page.locator(".pkm-harness-inspector").innerText(), /not report this quantity separately/);
    await page.getByRole("button", { name:"User/approval/continuation wait (milliseconds)", exact:true }).click();
    assert.match(await page.locator(".pkm-harness-inspector").innerText(), /45000/);
    assert.equal(await page.locator(".pkm-harness-node .pkm-harness-port").count(), 0, "Accounting is not executable");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No page overflow at ${width}px`);
    await page.close();
  }
  assert(methods.length > 0 && methods.every(method => method === "snapshot"));
});

test("production browser: invocation accounting remains navigable before any model round and never becomes executable", { timeout:60000 }, async t => {
  const data = fixture(), methods = [], attempt = data.harness.attempts[1];
  delete attempt.budgetReceipts;
  attempt.invocationBudgets = [{
    schema: "pkm.chat.invocation-budget/v1", id: "retrieval:knowledge-provider", owner: "retrieval",
    label: "Knowledge provider guard (not materialization)", status: "unavailable",
    startedAt: 1000, finishedAt: 6010, elapsedMs: 5010, activeMs: 5010, userWaitMs: 0,
    timingSource: "pkm.invocation-clock-excluding-tracked-user-wait",
    deadlineMs: { value: 5000, source: "retrieval.guard.deadlineMs", method: "configured" }, detail: "Retrieval exceeded its deadline.",
  }, {
    schema: "pkm.chat.invocation-budget/v1", id: "tool:original-call", owner: "tool", label: "run_process", status: "interrupted",
    startedAt: 7000, elapsedMs: 1200, activeMs: 200, userWaitMs: 1000,
    timingSource: "pkm.invocation-clock-excluding-tracked-user-wait",
    detail: "Completion and termination are unknown; no tool-wide deadline was instrumented.",
  }];
  const server = await createNativeHarnessServer({ extensionPath:path.join(__dirname, ".."), sessionId,
    access() {}, async request(method) { methods.push(method); assert.equal(method, "snapshot"); return data; } });
  t.after(() => server.dispose());
  const browser = await chromium.launch({ headless:true });
  t.after(() => browser.close());
  for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport:{ width, height:900 } });
    await page.goto(server.url);
    await page.getByRole("button", { name:"Full execution graph", exact:true }).click();
    const expand = title => page.getByRole("button", { name:`Open subgraph: ${title}`, exact:true }).click();
    await expand("Implement and validate"); await expand("Fix the failing test"); await expand("Attempt 2");
    await expand("2 observed invocations");
    await page.getByRole("button", { name:"Knowledge provider guard (not materialization)", exact:true }).click();
    const retrieval = await page.locator(".pkm-harness-inspector").innerText();
    assert.match(retrieval, /unavailable/);
    assert.match(retrieval, /5010/);
    assert.match(retrieval, /configured/);
    await page.getByRole("button", { name:"run_process", exact:true }).click();
    const tool = await page.locator(".pkm-harness-inspector").innerText();
    assert.match(tool, /interrupted/);
    assert.match(tool, /userWaitMs/);
    assert.match(tool, /1000/);
    assert.match(tool, /termination are unknown/);
    assert.equal(await page.locator(".pkm-harness-node .pkm-harness-port").count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No page overflow at ${width}px`);
    await page.close();
  }
  assert(methods.length > 0 && methods.every(method => method === "snapshot"));
});

test("production browser: public progress and conclusion are original output, safely rendered and refreshed without summary calls", { timeout:30000 }, async t => {
  const data = fixture(), methods = [];
  const attempt = data.harness.attempts[1];
  attempt.status = "streaming";
  attempt.publicOutputs = [
    { round:0, start:0, end:16, hasToolCalls:true, text:"Inspect evidence" },
    { round:1, start:16, end:23, text:"Partial" },
  ];
  const server = await createNativeHarnessServer({ extensionPath:path.join(__dirname, ".."), sessionId,
    access() {}, async request(method) { methods.push(method); assert.equal(method, "snapshot"); return data; } });
  t.after(() => server.dispose());
  const browser = await chromium.launch({ headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.getByRole("button", { name:"Full execution graph", exact:true }).click();
  const expand = title => page.getByRole("button", { name:`Open subgraph: ${title}`, exact:true }).click();
  await expand("Implement and validate");
  await expand("Fix the failing test");
  await expand("Attempt 2");
  await expand("Agent explanation / response");
  await page.getByRole("button", { name:"Progress explanation / round 1", exact:true }).click();
  assert.equal(await page.locator(".pkm-harness-inspector pre").innerText(), "Inspect evidence");
  await page.getByRole("button", { name:"Live response", exact:true }).click();
  const original = '<img src=x onerror="window.unexpectedCode=true"> Conclusion: inspect only.';
  attempt.publicOutputs[1].text = original;
  attempt.publicOutputs[1].end = 16 + original.length;
  attempt.status = "complete";
  server.changed();
  await page.getByRole("button", { name:"Final response / conclusion", exact:true }).waitFor();
  await page.waitForFunction(text => document.querySelector(".pkm-harness-inspector pre")?.textContent === text, original);
  assert.equal(await page.locator(".pkm-harness-inspector img").count(), 0);
  assert.equal(await page.evaluate(() => window.unexpectedCode), undefined);
  assert.match(await page.locator(".pkm-harness-inspector").innerText(), /No extra summary\/model request/);
  assert.equal(await page.locator(".pkm-harness-port").count(), 0, "Public explanations do not invent execution ports");
  await page.getByRole("button", { name:"Back to parent", exact:true }).click();
  await page.locator(".pkm-harness-viewport").getByRole("button", { name:"Agent explanation / response", exact:true }).waitFor();
  assert(methods.length > 0 && methods.every(method => method === "snapshot"));
});

test("production browser: nested tabs, Recipe previews, retries, refresh and dual-window state", { timeout:60000 }, async t => {
  let data = fixture(), allowed = true, snapshots = 0;
  const originalFailure = JSON.stringify(data.harness.attempts[0]);
  const server = await createNativeHarnessServer({ extensionPath:path.join(__dirname, ".."), sessionId,
    access() { if (!allowed) throw new Error("The Session was deleted or moved."); },
    async request(method) { if (method === "snapshot") { snapshots++; return data; } return "x".repeat(2001); } });
  t.after(() => server.dispose());
  const browser = await chromium.launch({ headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1280, height:800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.url);
  await page.getByRole("button", { name:"Full execution graph", exact:true }).click();
  await page.getByRole("heading", { name:data.task }).waitFor();
  const expand = title => page.getByRole("button", { name:`Open subgraph: ${title}`, exact:true }).click();
  const parent = () => page.getByRole("button", { name:"Back to parent", exact:true }).click();
  await page.locator(".pkm-harness-node.ignored").getByText("IGNORED / not executed", { exact:true }).waitFor();
  await expand("Implement and validate");
  await page.getByRole("button", { name:"Recipe: Development", exact:true }).click();
  assert.match(await page.locator("dialog").innerText(), /Pinned development v7/);
  await page.keyboard.press("Escape");
  await expand("Development");
  await expand("Debug");
  await page.getByRole("button", { name:"Inspect evidence", exact:true }).waitFor();
  await parent();
  await page.getByRole("button", { name:"Debug", exact:true }).waitFor();
  await parent();
  await expand("Fix the failing test");
  await page.getByRole("button", { name:"Attempt 1", exact:true }).click();
  await page.getByRole("slider", { name:"Graph zoom" }).focus();
  await page.keyboard.press("End");
  await page.locator(".pkm-harness-viewport").evaluate(node => { node.scrollTop = 70; });
  await page.getByRole("button", { name:"Attempt 1", exact:true }).evaluate(node => node.focus({ preventScroll:true }));
  const tabs = await page.getByRole("navigation", { name:"Open subgraphs", exact:true }).getByRole("button").count();
  const beforeTop = await page.locator(".pkm-harness-viewport").evaluate(node => node.scrollTop);
  data.harness.attempts.push({ ...data.harness.attempts[1], messageId:"m3", attemptId:"a3", attempt:3, retryOf:"a2", status:"complete" });
  server.changed();
  await page.getByRole("button", { name:"Attempt 3", exact:true }).waitFor();
  assert.equal(await page.getByRole("navigation", { name:"Open subgraphs", exact:true }).getByRole("button").count(), tabs);
  assert.equal(await page.getByRole("slider", { name:"Graph zoom" }).inputValue(), "150");
  assert.equal(await page.locator(".pkm-harness-viewport").evaluate(node => node.scrollTop), beforeTop);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Attempt 1");
  assert.match(await page.locator(".pkm-harness-inspector").innerText(), /a1/);
  assert.equal(JSON.stringify(data.harness.attempts[0]), originalFailure);
  const auto = page.getByRole("checkbox");
  await auto.uncheck();
  const baseline = snapshots;
  data.harness.attempts[1].status = "complete";
  server.changed();
  await page.waitForTimeout(150);
  assert.equal(snapshots, baseline, "paused automatic mode does not issue a snapshot request on events");
  await page.getByRole("button", { name:"Refresh", exact:true }).click();
  await page.locator('[data-node-id="a2"] strong').filter({ hasText: /^complete$/ }).waitFor();
  await expand("Attempt 1");
  await expand("1 recorded calls");
  await expand("run_process");
  await page.getByRole("button", { name:"Recorded arguments", exact:true }).click();
  assert.match(await page.locator(".pkm-harness-inspector pre").innerText(), /<script>not code<\/script>/);
  assert.equal(await page.locator(".pkm-harness script").count(), 0);
  await page.getByRole("button", { name:"Preview (2000/2001 characters)", exact:true }).click();
  await page.getByRole("button", { name:"Load full recorded result", exact:true }).click();
  await page.locator(".pkm-harness-inspector pre").filter({ hasText: /^x{2001}$/ }).waitFor();
  await parent(); await parent(); await parent();
  await expand("Attempt 2");
  await expand("1 recorded calls");
  await expand("mcp_action_call");
  await expand("fixture.script");
  await expand("branch");
  await page.locator(".pkm-harness-node.ignored").getByText("IGNORED / not executed", { exact:true }).waitFor();
  await page.getByRole("button", { name:"branch/then/skipped", exact:true }).click();
  assert.match(await page.locator(".pkm-harness-inspector").innerText(), /unnecessary component/);
  const second = await browser.newPage();
  await second.goto(server.url);
  await second.getByRole("heading", { name:data.task }).waitFor();
  data.task = "Shared authoritative update";
  server.changed();
  await second.getByRole("heading", { name:data.task }).waitFor();
  assert.equal(await page.getByRole("heading", { name:data.task }).count(), 0);
  await page.getByRole("button", { name:"Refresh", exact:true }).click();
  await page.getByRole("heading", { name:data.task }).waitFor();
  allowed = false;
  server.changed();
  await page.getByRole("button", { name:"Refresh", exact:true }).click();
  await page.getByRole("alert").filter({ hasText:"deleted or moved" }).waitFor();
  allowed = true;
  await page.getByRole("button", { name:"Refresh", exact:true }).click();
  await page.waitForFunction(() => document.querySelector(".pkm-harness-error").textContent === "");
  assert.deepEqual(errors, []);
});

test("shared renderer: manual refresh survives an in-flight auto request and disposal", { timeout:30000 }, async t => {
  const browser = await chromium.launch({ headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<main id="host"></main>');
  await page.addScriptTag({ path:path.join(__dirname, "../src/webview/agent-harness.js") });
  await page.evaluate(initial => {
    window.requests = [];
    window.controller = PkmAgentHarness.mount(document.getElementById("host"), {
      initial, request() { return new Promise(resolve => window.requests.push(resolve)); }
    });

    void window.controller.refresh();
  }, fixture());
  await page.getByRole("checkbox").uncheck();
  await page.evaluate(() => void window.controller.refresh(true));
  await page.evaluate(data => window.requests[0](data), fixture());
  await page.waitForFunction(() => window.requests.length === 2);
  await page.evaluate(data => window.requests[1](data), { ...fixture(), task:"Manual result" });
  await page.getByRole("heading", { name:"Manual result", exact:true }).waitFor();
  await page.evaluate(() => { window.controller.dispose(); window.controller.notify(); });
  assert.equal(await page.evaluate(() => window.requests.length), 2);
  assert.equal(await page.locator(".pkm-harness").count(), 0);
});

test("shared renderer reconciles at 30 seconds, pauses while hidden, and releases detached views", { timeout:30000 }, async t => {
  const browser = await chromium.launch({ headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.clock.install({ time:new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  await page.setContent('<main id="host"></main>');
  await page.addScriptTag({ path:path.join(__dirname, "../src/webview/agent-harness.js") });
  await page.evaluate(initial => {
    window.requests = 0; window.hidden = false;
    Object.defineProperty(document, "visibilityState", { configurable:true, get:() => window.hidden ? "hidden" : "visible" });
    window.controller = PkmAgentHarness.mount(document.getElementById("host"), {
      initial, async request() { window.requests++; return initial; }
    });
  }, fixture());
  await page.clock.runFor(29999);
  assert.equal(await page.evaluate(() => window.requests), 0);
  await page.clock.runFor(1);
  assert.equal(await page.evaluate(() => window.requests), 1);
  await page.evaluate(() => { window.hidden = true; window.controller.notify(); });
  await page.clock.runFor(30000);
  assert.equal(await page.evaluate(() => window.requests), 1);
  await page.evaluate(() => { window.hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
  assert.equal(await page.evaluate(() => window.requests), 2);
  await page.evaluate(() => window.controller.root.remove());
  await page.clock.runFor(30000);
  assert.equal(await page.evaluate(() => window.requests), 2);
  await page.evaluate(() => { window.controller.attach(document.getElementById("host")); window.controller.notify(); });
  assert.equal(await page.evaluate(() => window.requests), 3);
  await page.evaluate(() => window.controller.dispose());
  await page.clock.runFor(30000);
  assert.equal(await page.evaluate(() => window.requests), 3);
});

test("production browser: explicit Step ownership, ignored reasons and prepared budget authority", { timeout:30000 }, async t => {
  const data = fixture(), attempt = data.harness.attempts[1];
  attempt.harnessReports = [
    { id:"step-start", kind:"step", binding:{ stepId:"inspect" }, summary:"Inspect owned evidence", status:"start", source:"agent-report" },
    { id:"child-first", kind:"step", binding:{ stepId:"read", parentStepId:"inspect", stepAttemptId:"child-first" }, summary:"Read source details", status:"start", source:"agent-report" },
    { id:"child-failed", kind:"step", binding:{ stepId:"read", parentStepId:"inspect", stepAttemptId:"child-first" }, summary:"Read source details", status:"failed", reason:"First read failed", source:"agent-report" },
    { id:"child-retry", kind:"step", binding:{ stepId:"read", parentStepId:"inspect", stepAttemptId:"child-retry" }, summary:"Read source details", status:"start", source:"agent-report" },
    { id:"child-complete", kind:"step", binding:{ stepId:"read", parentStepId:"inspect", stepAttemptId:"child-retry" }, summary:"Read source details", status:"complete", source:"agent-report", evidenceCallIds:["call2"] },
    { id:"step-end", kind:"step", binding:{ stepId:"inspect" }, summary:"Inspect owned evidence", status:"complete", source:"agent-report", evidenceCallIds:["call2"] },
    { id:"step-ignore", kind:"step", binding:{ stepId:"deploy" }, summary:"Do not deploy", status:"ignored", reason:"User prohibited deployment", source:"agent-report" }
  ];
  attempt.toolCalls[0].harnessBinding = { stepId:"read", stepAttemptId:"child-retry" };
  attempt.budgetReceipts = [{ round:1, status:"prepared", countingMethod:"utf8-byte-estimate", effective:{ inputBudget:4096 } }];
  const server = await createNativeHarnessServer({ extensionPath:path.join(__dirname, ".."), sessionId,
    access() {}, async request() { return data; } });
  t.after(() => server.dispose());
  const browser = await chromium.launch({ headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.getByRole("button", { name:"Full execution graph", exact:true }).click();
  const expand = title => page.getByRole("button", { name:`Open subgraph: ${title}`, exact:true }).click();
  await expand("Implement and validate"); await expand("Fix the failing test"); await expand("Attempt 2");
  await page.getByRole("button", { name:"Do not deploy", exact:true }).click();
  assert.match(await page.locator(".pkm-harness-inspector").innerText(), /User prohibited deployment/);
  await page.locator(".pkm-harness-node.ignored").getByText("IGNORED / not executed", { exact:true }).waitFor();
  await expand("Inspect owned evidence");
  await expand("Read source details");
  await page.getByRole("button", { name:"Step attempt 1", exact:true }).click();
  assert.match(await page.locator(".pkm-harness-inspector").innerText(), /First read failed/);
  await expand("Step attempt 2");
  await page.getByRole("button", { name:"mcp_action_call", exact:true }).waitFor();
  for (let index = 0; index < 3; index++) await page.getByRole("button", { name:"Back to parent", exact:true }).click();
  await expand("1 prepared rounds");
  await page.getByRole("button", { name:"Round 1", exact:true }).click();
  assert.match(await page.locator(".pkm-harness-inspector").innerText(), /utf8-byte-estimate/);
  assert.equal(await page.locator(".pkm-harness-node .pkm-harness-port").count(), 0,
    "Prepared budget observations never acquire execution ports");
});

test("shared renderer: live overview locates the current path, bindings and blocked state", { timeout:30000 }, async t => {
  const browser = await chromium.launch({ headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion:"reduce" });
  await page.setContent('<main id="host"></main>');
  await page.addStyleTag({ path:path.join(__dirname, "../src/webview/agent-harness.css") });
  await page.addScriptTag({ path:path.join(__dirname, "../src/webview/agent-harness.js") });
  await page.evaluate(initial => {
    window.controller = PkmAgentHarness.mount(document.getElementById("host"), { initial, request:() => new Promise(() => {}) });
  }, fixture());
  const overview = page.getByRole("region", { name:"Live execution overview" });
  await overview.getByRole("button", { name:"Locate Step Inspect evidence (running)" }).click();
  await page.getByRole("navigation", { name:"Graph ancestors" }).getByRole("button", { name:"Nested debug", exact:true }).waitFor();
  assert.equal(await page.locator(".pkm-harness-node.selected").getAttribute("data-node-id"), "inspect");
  await overview.getByRole("button", { name:/Open Action Run/ }).click();
  assert.equal(await page.locator(".pkm-harness-node", { hasText:"Durable Action receipts" }).count(), 1);
  assert.equal(await overview.locator(".pkm-harness-phase").evaluate(node => getComputedStyle(node.firstChild).animationName), "none");

  const waiting = fixture();
  Object.assign(waiting, { todos:[], runs:[], actionRuns:[] });
  waiting.harness = { ...waiting.harness, state:"awaiting-input", currentPhase:{ kind:"waiting", label:"Waiting for approval" },
    waiting:{ kind:"user", detail:"Waiting for approval" }, attempts:[{ ...waiting.harness.attempts[1], planning:undefined, toolCalls:[] }] };
  await page.evaluate(data => window.controller.update(data, true), waiting);
  await overview.getByText("Waiting for you: Waiting for approval").waitFor();
  assert.equal(await overview.locator(".pkm-harness-phase").getAttribute("data-phase"), "waiting");
  await overview.getByText("no explicit binding recorded").waitFor();
  await overview.getByText("no Action Run referenced").waitFor();
  await page.evaluate(() => window.controller.dispose());
});

test("shared renderer: lifecycle ring highlights the recorded stage and drills into evidence", { timeout:30000 }, async t => {
  const browser = await chromium.launch({ headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1100, height:900 } });
  await page.setContent('<main id="host"></main>');
  await page.addStyleTag({ path:path.join(__dirname, "../src/webview/agent-harness.css") });
  await page.addScriptTag({ path:path.join(__dirname, "../src/webview/agent-harness.js") });
  const data = fixture();
  data.harness.waiting = { kind:"dependency", detail:"Polling AML job" };
  data.harness.state = "awaiting-result";
  await page.evaluate(initial => {
    window.controller = PkmAgentHarness.mount(document.getElementById("host"), { initial, request:() => new Promise(() => {}) });
    window.controller.showLifecycle();
  }, data);
  const ring = page.getByRole("group", { name:"Harness lifecycle" });
  const current = ring.locator('[aria-current="step"]');
  assert.equal(await current.count(), 1);
  assert.equal(await current.getAttribute("data-stage"), "monitor");
  assert.equal(await current.getAttribute("data-status"), "waiting");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.stage), "monitor");
  await page.getByText("Polling AML job", { exact:false }).first().waitFor();
  if (process.env.PKM_RING_SCREENSHOT) await page.screenshot({ path:`${process.env.PKM_RING_SCREENSHOT}-desktop.png`, fullPage:true });
  await ring.getByRole("button", { name:/^Configure:/ }).click();
  assert.match(await page.locator(".pkm-harness-inspector").innerText(), /Task \/ goal[\s\S]*Debug without deployment/);
  await page.getByRole("button", { name:"Open recorded evidence for Configure" }).click();
  await page.getByRole("navigation", { name:"Graph ancestors" }).getByRole("button", { name:"Lifecycle", exact:true }).click();
  await ring.waitFor();
  await page.getByRole("button", { name:"Full execution graph", exact:true }).click();
  await page.getByRole("button", { name:"Back to parent", exact:true }).click();
  await ring.waitFor();
  await page.setViewportSize({ width:390, height:900 });
  await page.emulateMedia({ reducedMotion:"reduce" });
  assert.equal(await current.evaluate(node => getComputedStyle(node).position), "static");
  if (process.env.PKM_RING_SCREENSHOT) await page.screenshot({ path:`${process.env.PKM_RING_SCREENSHOT}-narrow.png`, fullPage:true });
  await page.evaluate(() => window.controller.dispose());
});
