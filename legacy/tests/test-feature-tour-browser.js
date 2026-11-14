const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const { FEATURE_TOUR_MODULES, decideInitialExperience } = require("../dist/ui/onboarding-experience");

test("built-panel feature introduction covers five capabilities without enabling models, sync or Portal", async t => {
  const root = path.resolve(__dirname, ".."), version = require("../package.json").version;
  const browser = await chromium.launch({ headless:true, ...(process.env.PKM_CHROMIUM_EXECUTABLE
    ? { executablePath:process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1100, height:1000 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.abort());
  const html = fs.readFileSync(path.join(root, "dist/webview/panel.html"), "utf8")
    .replace(/<meta http-equiv[^>]*>/g, "").replace(/<link[^>]*>/g, "").replace(/<script[^>]*>[\s\S]*?<\/script>/g, "")
    .replaceAll("%%PKM_VERSION%%", version);
  await page.setContent(html);
  await page.addStyleTag({ path:path.join(root, "dist/webview/panel.css") });
  await page.addStyleTag({ content:fs.readFileSync(path.join(root, "dist/webview/codicon.css"), "utf8")
    + `\n@font-face{font-family:codicon;src:url(data:font/ttf;base64,${fs.readFileSync(path.join(root, "dist/webview/codicon.ttf")).toString("base64")})}` });
  await page.addStyleTag({ content:":root{--vscode-editor-background:#181818;--vscode-sideBar-background:#202020;--vscode-foreground:#ddd;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#444;--vscode-focusBorder:#4daafc;--vscode-font-family:Arial;--vscode-font-size:13px}" });
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "resources/locales/en.json"), "utf8")).strings;
  await page.evaluate(catalog => {
    window.__posts = [];
    window.vscode = { postMessage:message => __posts.push(message) };
    window.ask = (command, data) => __posts.push({ command, ...data });
    window.initialLoadComplete = true;
    window.esc = value => String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
    window.t = (key, values = {}) => Object.entries(values).reduce((text,[name,value]) => text.replaceAll(`{${name}}`,value),catalog[key] || key);
    for (const id of ["topbar","workspace-shell"]) document.getElementById(id).hidden = false;
    document.getElementById("loading-banner").classList.add("hidden");
    for (const button of document.querySelectorAll(".workspace-button")) button.addEventListener("click", () => {
      document.querySelectorAll("[data-workspace-group]").forEach(group =>
        group.classList.toggle("active", group.dataset.workspaceGroup === button.dataset.workspace));
    });
  }, catalog);
  await page.addScriptTag({ path:path.join(root, "src/webview/panel/05-onboarding.js") });
  await page.evaluate(({ version, modules }) => updateFeatureTourCatalog({ version, modules }), { version, modules:FEATURE_TOUR_MODULES });
  await page.getByRole("button", { name:"What's new", exact:true }).click();
  assert.equal(await page.locator("#coachmark-highlights article").count(), 5);
  for (const title of ["PKM Chat","Retrieval System","GitHub Sync","Router","Portal"]) {
    assert((await page.locator("#coachmark-highlights").innerText()).includes(title));
  }
  assert.match(await page.locator("#coachmark-title").innerText(), new RegExp(version.replaceAll(".","\\.")));
  for (const width of [320,1100]) {
    await page.setViewportSize({ width, height:1000 });
    await page.waitForFunction(() => {
      const box = document.getElementById("coachmark").getBoundingClientRect();
      return box.x >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
    });
  }
  if (process.env.PKM_FEATURE_TOUR_SCREENSHOT) await page.screenshot({ path:process.env.PKM_FEATURE_TOUR_SCREENSHOT });
  await page.keyboard.press("Escape");
  assert.deepEqual(await page.evaluate(() => __posts), [], "manual dismissal is not automatic completion");
  const initial = decideInitialExperience({ version, onboardingPending:true, onboardingCompleted:false, seenModuleIds:[] });
  await page.evaluate(initial => queueInitialExperience(initial), initial);
  const expectedTitles = FEATURE_TOUR_MODULES.flatMap(module => module.steps.map(step => catalog[step.titleKey]));
  for (const title of expectedTitles) {
    assert.equal(await page.locator("#coachmark-title").innerText(), title);
    await page.locator("#coachmark-next").click();
  }
  assert.equal(await page.locator("#experience-layer").isVisible(), false);
  assert.deepEqual(await page.evaluate(() => __posts), [{
    command:"completeTourModules", audience:"new", moduleIds:FEATURE_TOUR_MODULES.map(module => module.id),
  }], "tour navigation must not download models, start Chat requests, publish Sync or connect Portal");
  assert.deepEqual(errors, []);
});
