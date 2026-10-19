const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const { createNativeHarnessServer } = require("../dist/runtime/native-harness-server");
const { fixture, sessionId } = require("./native-harness-fixture");

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
  await page.waitForFunction(() => document.querySelector('[data-node-id="a2"] strong')?.textContent === "complete");
  await expand("Attempt 1");
  await expand("1 recorded calls");
  await expand("run_process");
  await page.getByRole("button", { name:"Recorded arguments", exact:true }).click();
  assert.match(await page.locator(".pkm-harness-inspector pre").innerText(), /<script>not code<\/script>/);
  assert.equal(await page.locator(".pkm-harness script").count(), 0);
  await page.getByRole("button", { name:"Preview (2000/2001 characters)", exact:true }).click();
  await page.getByRole("button", { name:"Load full recorded result", exact:true }).click();
  await page.waitForFunction(() => document.querySelector(".pkm-harness-inspector pre")?.textContent.length === 2001);
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
