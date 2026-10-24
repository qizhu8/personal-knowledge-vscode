const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");

test("real HTTP worker history and learned parameters render in Router without fabricated Recall", async t => {
  const root = path.resolve(__dirname, "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-learning-browser-"));
  t.after(() => fs.rmSync(temporary, { recursive:true, force:true }));
  const fixturePath = path.join(temporary, "worker-snapshot.json");
  const managedPython = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  execFileSync(process.env.PKM_RETRIEVAL_TEST_PYTHON || process.env.PYTHON || (fs.existsSync(managedPython) ? managedPython : "python"),
    ["-B", path.join(root, "tests/test-retrieval-learning.py")],
    { env:{ ...process.env, PKM_RETRIEVAL_LEARNING_FIXTURE:fixturePath }, timeout:60000, stdio:["ignore","pipe","pipe"] });
  const { catalog, runtime } = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const browser = await chromium.launch({ headless:true, ...(process.env.PKM_CHROMIUM_EXECUTABLE
    ? { executablePath:process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1000, height:1000 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent('<style>:root{--vscode-editor-background:#181818;--vscode-sideBar-background:#202020;--vscode-foreground:#ddd;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#444;--vscode-focusBorder:#4daafc;--vscode-font-family:Arial;--vscode-font-size:13px}</style><main id="detail"></main>');
  await page.addStyleTag({ path:path.join(root, "dist/webview/panel.css") });
  await page.evaluate(() => Object.assign(window, {
    state:{ tab:"skillRouter" }, __posts:[], uiIcon:() => "", updateTabNav() {},
    esc:value => String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"),
    ask:(command, data) => __posts.push({ command, ...data }),
    vscode:{ getState:() => ({ settingsSubtabs:{ router:"models" } }), setState() {} },
  }));
  await page.evaluate(() => {
    window.__visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable:true, get:() => __visibility });
    window.__timers = new Map();
    let sequence = 0;
    const nativeSet = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
      if (delay !== 10000) return nativeSet(callback, delay, ...args);
      const id = --sequence;
      __timers.set(id, () => callback(...args));
      return id;
    };
    window.clearTimeout = id => { if (!__timers.delete(id)) nativeClear(id); };
    window.__tick = () => {
      const [id, callback] = __timers.entries().next().value;
      __timers.delete(id);
      callback();
    };
  });
  const panel = fs.readFileSync(path.join(root, "dist/webview/panel.js"), "utf8");
  await page.addScriptTag({ content:panel.slice(panel.indexOf("const settingsSubtabs ="), panel.indexOf("function initColumnResizer(")) });
  await page.addScriptTag({ path:path.join(root, "src/webview/panel/51-skill-router.js") });
  await page.evaluate(({ catalog, runtime }) => {
    skillRouterOnStatus({ activeProfile:"l1_online", sources:[], sourcePriority:[], runtime:{
      semanticStatus:runtime.semantic_status, skillServing:runtime.skill_serving },
      solutions:{ copilot_default:{ externallyServed:true }, l1_online:{ available:true, mature:true, enabled:true } } });
    skillRouterSolutionsOnSnapshot(catalog);
  }, { catalog, runtime });
  assert.equal(await page.getByRole("tab").count(), 3);
  const tabs = ["Skill Sources","Retrieval & Performance","Collector & Privacy"];
  assert.equal(await page.getByRole("tab", { name:tabs[1], exact:true }).getAttribute("aria-selected"), "true", "old Models state migrates");
  const performance = page.locator("#sr-performance");
  const chart = performance.getByRole("img", { name:"Runtime (ms) by Model Call", exact:true });
  assert.equal(await chart.locator("circle").count(), 13);
  assert.equal(await chart.locator(".sr-chart-failed").count(), 1);
  assert.match(await chart.textContent(), /Model Call Sequence/);
  const curves = performance.getByRole("img", { name:"Original and Current Calibration Functions", exact:true });
  assert.equal(await curves.locator("polyline").count(), 2);
  assert.equal(await curves.locator("polyline").nth(1).evaluate(node => getComputedStyle(node).stroke), "rgb(77, 170, 252)");
  assert.notEqual(await curves.locator("polyline").nth(0).getAttribute("points"), await curves.locator("polyline").nth(1).getAttribute("points"));
  assert.match(await performance.innerText(), /9 Judged Calls/);
  await page.getByLabel("Performance Metric", { exact:true }).selectOption("recall");
  const recall = performance.getByRole("img", { name:"Recall by Model Call", exact:true });
  assert.equal(await recall.locator("circle").count(), 9, "unjudged calls must not appear as zero");
  assert.match(await recall.locator("circle").last().textContent(), /50%/);
  for (const width of [320,360,1000]) {
    await page.setViewportSize({ width, height:1000 });
    for (const name of tabs) {
      const bounds = await page.getByRole("tab", { name, exact:true }).boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await page.getByLabel("Performance Metric", { exact:true }).focus();
  await page.evaluate(data => skillRouterSolutionsOnSnapshot(data), catalog);
  assert.equal(await page.evaluate(() => document.activeElement.id), "sr-metric");
  assert.equal(await page.getByLabel("Performance Metric", { exact:true }).inputValue(), "recall");
  await page.getByRole("tab", { name:"Skill Sources", exact:true }).click();
  assert.equal(await page.evaluate(() => __timers.size), 0, "source browsing must not poll model history");
  await page.getByRole("tab", { name:"Retrieval & Performance", exact:true }).click();
  assert.equal(await page.evaluate(() => __timers.size), 1);
  await page.evaluate(() => { __visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); });
  assert.equal(await page.evaluate(() => __timers.size), 0, "hidden windows must not poll");
  await page.evaluate(() => { __visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
  assert.equal(await page.evaluate(() => __timers.size), 1);
  await page.getByRole("button", { name:"Refresh Performance", exact:true }).click();
  const refresh = await page.evaluate(() => __posts.at(-1));
  assert.equal(refresh.command, "retrievalPerformance");
  assert.equal(await page.getByRole("button", { name:"Refresh Performance", exact:true }).isDisabled(), true);
  const deadline = await page.evaluate(() => skillRouterPerformanceTimer);
  await page.evaluate(() => skillRouterRequestPerformance());
  assert.equal(await page.evaluate(() => skillRouterPerformanceTimer), deadline, "duplicate requests must retain their deadline");
  assert.equal(await page.evaluate(() => __timers.size), 1, "only one refresh may be in flight");
  await page.evaluate(data => skillRouterPerformanceOnSnapshot(data), { requestId:"another-window", learning:{ ...catalog.learning, calls:[] } });
  assert.equal(await page.getByRole("img", { name:"Recall by Model Call" }).locator("circle").count(), 9);
  await page.evaluate(data => skillRouterPerformanceOnSnapshot(data), { requestId:refresh.requestId, learning:catalog.learning });
  await page.evaluate(() => __tick());
  const timedOut = await page.evaluate(() => __posts.at(-1));
  await page.evaluate(() => __tick());
  assert.match(await performance.innerText(), /Performance refresh timed out/);
  assert.equal(await page.evaluate(() => __timers.size), 0, "a timed-out poll must not retry automatically");
  await page.evaluate(data => skillRouterPerformanceOnSnapshot(data), { requestId:timedOut.requestId, learning:{ ...catalog.learning, calls:[] } });
  assert.match(await performance.innerText(), /Performance refresh timed out/);
  await page.getByRole("button", { name:"Refresh Performance", exact:true }).click();
  const recovered = await page.evaluate(() => __posts.at(-1));
  await page.evaluate(data => skillRouterPerformanceOnSnapshot(data), { requestId:recovered.requestId, learning:catalog.learning });
  await page.getByLabel("Performance Metric", { exact:true }).selectOption("results");
  assert.match(await performance.getByRole("img", { name:"Returned Results by Model Call" }).textContent(), /Returned Results/);
  const unjudged = structuredClone(catalog);
  unjudged.learning.calls.forEach(call => { call.recall = null; });
  await page.evaluate(data => skillRouterSolutionsOnSnapshot(data), unjudged);
  await page.getByLabel("Performance Metric", { exact:true }).selectOption("recall");
  assert.match(await performance.innerText(), /Recall unavailable/);
  assert.equal(await performance.getByRole("img", { name:"Recall by Model Call" }).count(), 0);
  await page.evaluate(data => skillRouterSolutionsOnSnapshot(data), catalog);
  await page.getByLabel("Performance Metric", { exact:true }).selectOption("runtime");
  if (process.env.PKM_FEATURE_ROUTER_SCREENSHOT) {
    await page.setViewportSize({ width:1000, height:1000 });
    await page.locator("#sr-performance").screenshot({ path:process.env.PKM_FEATURE_ROUTER_SCREENSHOT });
  }
  await page.getByLabel("Adaptive Result Count", { exact:true }).uncheck();
  const post = await page.evaluate(() => __posts.at(-1));
  assert.equal(post.command, "retrievalAdaptiveCount");
  assert.equal(post.enabled, false);
  assert(post.requestId);
  assert.equal(await page.getByLabel("Adaptive Result Count", { exact:true }).isChecked(), false);
  assert.match(await performance.innerText(), /Applying Adaptive Result Count/);
  await page.evaluate(data => skillRouterSolutionsOnSnapshot(data), {
    ...catalog, learning:{ ...catalog.learning, enabled:false }, actionCompleted:true, operationId:post.requestId,
  });
  assert.equal(await page.getByLabel("Adaptive Result Count", { exact:true }).isEnabled(), true);
  const legacy = { ...catalog };
  delete legacy.learning;
  const posts = await page.evaluate(() => __posts.length);
  await page.evaluate(data => skillRouterSolutionsOnSnapshot(data), legacy);
  assert.equal(await page.evaluate(() => __timers.size), 0, "old workers must not receive repeated unsupported requests");
  assert.equal(await page.evaluate(() => __posts.length), posts);
  assert.deepEqual(errors, []);
});
