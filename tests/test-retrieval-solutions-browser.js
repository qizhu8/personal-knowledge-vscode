const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");

test("Router model lifecycle preserves focus, budgets and truthful progress on narrow screens", async t => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent(`<style>:root{--vscode-editor-background:#181818;--vscode-sideBar-background:#202020;
    --vscode-panel-border:#383838;--vscode-focusBorder:#3794ff;--vscode-foreground:#ddd;
    --vscode-descriptionForeground:#999;--vscode-list-hoverBackground:#292929;--vscode-input-background:#111;
    --vscode-list-activeSelectionBackground:#263b52;--vscode-list-activeSelectionForeground:#fff;
    --vscode-font-family:Arial,sans-serif;--vscode-font-size:13px}</style><main id="detail"></main>`);
  const root = process.env.PKM_RETRIEVAL_SETUP_EXTENSION_ROOT || path.resolve(__dirname, "..");
  await page.addStyleTag({ path: path.join(root, "dist/webview/panel.css") });
  await page.evaluate(() => Object.assign(window, {
    state: { tab: "skillRouter" }, __posts: [],
    esc: value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
    ask: (command, payload) => window.__posts.push({ command, ...payload }),
    uiIcon: () => "", updateTabNav() {},
    vscode:{ getState:() => ({}), setState() {} },
  }));
  const panel = fs.readFileSync(path.join(root, "dist/webview/panel.js"), "utf8");
  await page.addScriptTag({ content:panel.slice(panel.indexOf("const settingsSubtabs ="), panel.indexOf("function initColumnResizer(")) });
  await page.addScriptTag({ path: path.join(root, "src/webview/panel/51-skill-router.js") });
  await page.evaluate(() => {
    skillRouterOnStatus({ activeProfile:"l1_online",
      sourcePriority:["pkm-personal", "agent-native"],
      sources:[{ id:"pkm-personal", label:"PKM Personal", kind:"personal", detail:"Local personal Skills" },
        { id:"agent-native", label:"Agent Native", kind:"native", detail:"Skills discovered by the active host" }],
      solutions:{
      copilot_default:{ externallyServed:true },
      l1_online:{ available:true, mature:true, enabled:true },
    } });
    skillRouterSolutionsOnSnapshot({ state: "idle", packages: [] });
  });
  assert.match(await page.locator("#sr-text-solutions").innerText(), /Current model: Not enabled/);
  assert.equal(await page.getByRole("tab", { name:"Skill Sources", exact:true }).getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#sr-text-solutions").isVisible(), false);
  assert.match(await page.locator('[data-sr-profile="model_based"]').innerText(), /Not enabled/);
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.deepEqual(await page.evaluate(() => __posts), [], "unconfigured models must not trigger setup or notifications");
  await page.locator('[data-sr-solution="l1_online"]').focus();
  for (let i = 0; i < 3; i++) await page.evaluate(() => skillRouterSolutionsOnSnapshot({
    state:"disabled", packages:[],
    runtimeStatus:{ semanticStatus:"off", solution:{ state:"disabled", requested_package_id:null, active_package_id:null },
      skillServing:{ enabled:false, ready:false, error:"No optional model configured" } },
  }));
  assert.equal(await page.getByRole("tab", { name:"Skill Sources", exact:true }).getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#sr-text-solutions").isVisible(), false);
  assert.equal(await page.getByRole("alert").count(), 0, "an unused optional model is not an error");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.srSolution), "l1_online");
  assert.deepEqual(await page.evaluate(() => __posts), []);
  assert((await page.locator("#detail").innerText()).length < 900, "the default Router view must stay compact");
  assert.doesNotMatch(await page.locator("#detail").innerText(), /Worker readiness only proves|Raw query and task text|Source validation/);
  await page.getByRole("tab", { name:"Collector & Privacy", exact:true }).click();
  const privacy = page.locator(".sr-privacy-declaration");
  assert.equal(await privacy.isVisible(), true);
  assert.equal(await privacy.locator(".sr-hover-panel").count(), 0, "privacy disclosures must never require hover");
  assert.match(await privacy.innerText(), /Raw query and task text/);
  assert.match(await privacy.innerText(), /PKM_COLLECTOR_URL/);
  assert.match(await privacy.innerText(), /hostname/);
  assert.match(await privacy.innerText(), /512/);
  assert.match(await privacy.innerText(), /not anonymous/);
  assert.match(await privacy.innerText(), /not a general privacy policy/);
  for (const width of [320, 360, 1280]) {
    await page.setViewportSize({ width, height:1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await page.getByRole("tab", { name:"Skill Sources", exact:true }).click();
  if (process.env.PKM_ROUTER_SCREENSHOT) {
    await page.screenshot({ path:process.env.PKM_ROUTER_SCREENSHOT.replace(/\.png$/, "-sources.png"), fullPage:true });
  }
  await page.getByRole("tab", { name:"Retrieval & Performance", exact:true }).click();
  assert.match(await page.locator("#sr-performance").innerText(), /Model retrieval is not enabled/);
  const packageId = "a".repeat(64);
  const catalog = {
    state: "building", requested_package_id: packageId, active_package_id: null,
    runtimeStatus: { semanticStatus: "unavailable", solution: { state:"building", requested_package_id: packageId, active_package_id: null } },
    modelRuntime: { configured: true, python: "/local/model-runtime/bin/python" },
    progress: { phase: "encoding", current: 16, total: 32 },
    observed: { elapsed_seconds: 4.5, rss_bytes: 1048576, cpu_core_equivalents: 1 },
    packages: [{ package_id: packageId, name: 'Offline <model> "package"', architecture: "dense-section",
      license: "MIT", bytes: 492795290, validation: { success_at_5: 0.8 },
      resources: { document_count: 989, unit_count: 3200, content_type_counts: { skill: 181, note: 308 },
        index_bytes_estimate: 1048576, build_ram_bytes_estimate: 2000000000 } }],
  };
  await page.evaluate(data => skillRouterSolutionsOnSnapshot(data), catalog);
  const section = page.locator("#sr-text-solutions");
  assert.match(await section.innerText(), /Requested: building/);
  assert.match(await page.locator('[data-sr-profile="model_based"]').textContent(), /Preparing/);
  assert.doesNotMatch(await section.innerText(), /Ready \/ active/);
  assert.match(await page.locator("#sr-model-readiness").locator("..").textContent(), /unavailable/);
  assert.equal(await section.locator("progress").getAttribute("value"), "16");
  assert(await section.getByRole("button", { name: "Enable & build", exact: true }).isDisabled());
  assert.doesNotMatch(await section.innerText(), /a{64}|Index estimate|model-runtime\/bin\/python|Source validation/);
  const modelDetails = section.getByRole("button", { name:'Offline <model> "package" details', exact:true });
  await modelDetails.hover();
  const modelPopover = section.getByRole("dialog", { name:'Offline <model> "package" details', exact:true });
  assert.match(await modelPopover.innerText(), /not a quality score for this local corpus/);
  assert.match(await modelPopover.innerText(), new RegExp(packageId));
  await modelPopover.hover();
  assert(await modelPopover.isVisible(), "details remain open while the pointer moves into the floating panel");
  await page.setViewportSize({ width:320, height:1000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.sr-hover.open .sr-hover-panel')]
    .every(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1; }));
  await section.getByRole("button", { name: "Refresh models" }).focus();
  for (const width of [320, 360, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(data => skillRouterSolutionsOnSnapshot(data), catalog);
    assert(await modelPopover.isVisible());
    const bounds = await modelPopover.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `floating details overflow at ${width}px`);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Refresh models");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      `Router overflows at ${width}px`);
  }
  await page.evaluate(data => skillRouterSolutionsOnSnapshot(data), {
    ...catalog, state: "ready", active_package_id: packageId, progress: null, index: { bytes: 1048576, reused: true },
    runtimeStatus: { semanticStatus: "ready", solution: { requested_package_id: packageId, active_package_id: packageId } },
  });
  assert.match(await section.innerText(), /Ready \/ active/);
  assert.match(await page.locator('[data-sr-profile="model_based"]').textContent(), /Available/);
  assert.doesNotMatch(await page.locator('[data-sr-profile="model_based"]').textContent(), /Serving|System disabled/);
  assert.match(await page.locator("#sr-model-readiness").locator("..").textContent(), /Semantic path\s*ready/);
  const runtimeDetails = section.getByRole("button", { name:"Embedding retrieval details", exact:true });
  await runtimeDetails.focus();
  const runtimePopover = section.getByRole("dialog", { name:"Embedding retrieval details", exact:true });
  assert.match(await runtimePopover.innerText(), /reused/);
  await runtimeDetails.press("Escape");
  assert.equal(await runtimePopover.isVisible(), false, "Escape dismisses details without moving focus");
  assert.equal(await runtimeDetails.evaluate(node => document.activeElement === node), true);
  await section.getByRole("button", { name: "Rebuild", exact: true }).click();
  const action = await page.evaluate(() => __posts.at(-1));
  assert.equal(action.command, "retrievalSolutionRebuild");
  assert.equal(action.packageId, packageId);
  await section.getByRole("button", { name: "Refresh models" }).click();
  await page.evaluate(data => skillRouterSolutionsOnSnapshot(data), { ...catalog, actionCompleted: false });
  assert.match(await section.innerText(), /Applying model configuration/);
  await page.evaluate(data => skillRouterSolutionsOnSnapshot(data), {
    ...catalog, state: "blocked", error: "Cache corrupt; use Rebuild <not hidden>",
    runtimeStatus:{ semanticStatus:"unavailable", solution:{ state:"blocked",
      requested_package_id:packageId, active_package_id:null, error:"Cache corrupt; use Rebuild <not hidden>" } },
    actionCompleted: true, operationId: action.requestId,
  });
  assert.match(await section.getByRole("alert").innerText(), /Cache corrupt; use Rebuild <not hidden>/);
  assert.match(await page.locator('[data-sr-profile="model_based"]').textContent(), /Unavailable/);
  assert.doesNotMatch(await section.innerText(), /Applying model configuration/);
  await page.evaluate(() => skillRouterSolutionsOnSnapshot({
    state: "disabled", packages: [], error: "Runtime probe failed: missing torch",
  }));
  assert.match(await section.getByRole("alert").innerText(), /missing torch/);
  await page.evaluate(() => skillRouterSolutionsOnSnapshot({ state:"disabled", packages:[], error:"" }));
  await page.evaluate(() => skillRouterSolutionsOnSnapshot({ state:"disabled", packages:[], error:"",
    runtimeStatus:{ semanticStatus:"off", solution:{ state:"disabled", requested_package_id:null, active_package_id:null } } }));
  assert.match(await page.locator('[data-sr-profile="model_based"]').textContent(), /Not enabled/);
  assert.equal(await section.getByRole("alert").count(), 0);
  await section.getByRole("button", { name:"Download from Hugging Face", exact:true }).click();
  const download = await page.evaluate(() => __posts.at(-1));
  assert.equal(download.command, "retrievalModelDownload");
  await page.evaluate(operationId => skillRouterModelSetupOnProgress({
    operationId, source:"huggingface", phase:"acquire", current:123456, total:492795290,
  }), download.requestId);
  assert.equal(await section.locator(".sr-setup-steps li").count(), 6);
  assert.equal(await section.locator('[aria-current="step"]').getAttribute("data-step"), "acquire");
  assert.equal(await section.locator(".sr-setup-circle").first().evaluate(node => getComputedStyle(node).borderRadius), "50%");
  assert(await section.locator(".sr-setup-steps li").first().evaluate(node => parseFloat(getComputedStyle(node, "::after").width) > 0));
  assert.equal(await section.getByRole("progressbar", { name:"Model download" }).getAttribute("value"), "123456");
  for (const width of [320, 360, 1280]) {
    await page.setViewportSize({ width, height:1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await page.evaluate(operationId => skillRouterSolutionsOnSnapshot({
    actionCompleted:true, operationId, state:"disabled", packages:[], error:"Checksum mismatch. Model was not enabled.",
    setup:{ operationId, source:"huggingface", phase:"failed", failedPhase:"verify", error:"Checksum mismatch. Model was not enabled." },
  }), download.requestId);
  assert.match(await section.getByRole("alert").innerText(), /Checksum mismatch/);
  assert.equal(await section.locator(".failed").getAttribute("data-step"), "verify");
  await section.getByRole("button", { name:"Import model directory", exact:true }).click();
  const local = await page.evaluate(() => __posts.at(-1));
  assert.equal(local.command, "retrievalModelDirectory");
  await page.evaluate(({ operationId, packageId }) => skillRouterSolutionsOnSnapshot({
    operationId, actionCompleted:true, state:"ready", error:"", packages:[], active_package_id:packageId,
    setup:{ operationId, source:"directory", phase:"index", packageId },
  }), { operationId:local.requestId, packageId });
  assert.equal(await section.locator('[aria-current="step"]').getAttribute("data-step"), "ready");
  await page.getByRole("tab", { name:"Skill Sources", exact:true }).click();
  assert.equal(await section.isVisible(), false);
  await page.evaluate(() => skillRouterModelSetupOnProgress({ operationId:"other-window", source:"directory", phase:"verify" }));
  assert.equal(await section.isVisible(), false, "background progress must not reopen Models on other tabs");
  await page.getByRole("tab", { name:"Retrieval & Performance", exact:true }).click();
  assert.equal(await section.isVisible(), true);
  if (process.env.PKM_ROUTER_SCREENSHOT) {
    await page.evaluate(() => {
      skillRouterSolutionsOnSnapshot({ state:"disabled", packages:[], progress:null, observed:{}, index:{},
        active_package_id:null, requested_package_id:null, setup:{ operationId:"visual-fixture", source:"huggingface",
          phase:"acquire", current:211000000, total:492795290 } });
      document.querySelectorAll("details").forEach(node => { node.open = false; });
    });
    await page.screenshot({ path:process.env.PKM_ROUTER_SCREENSHOT, fullPage:true });
  }
  assert.deepEqual(errors, []);
});
