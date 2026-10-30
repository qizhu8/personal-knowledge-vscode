const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const definition = { action_id: "test.echo", display_name: "Echo", version: 1, content_hash: "admitted",
      availability: { state: "ready" }, input_schema: { properties: {} }, output_schema: { properties: {} }, effects: ["pure"] };
    const proposal = { action_id: "test.echo", proposal_id: "proposal_new", content_hash: "pending-new",
      definition: { ...definition, display_name: 'Pending <img src=x onerror="throw Error(1)">', version: 3, effects: ["remote-write"] } };
    const catalog = { ok: true, actions: [definition],
      proposals: [proposal, { ...proposal, proposal_id: "proposal_old", content_hash: "pending-old",
        definition: { ...definition, version: 2 } }],
      pending_admissions: [{ ...definition, action_id: "test.imported", display_name: "Imported", content_hash: "unapproved" }] };
    await page.addInitScript(catalog => {
      window.__catalog = catalog;
      window.__calls = [];
      window.__state = {};
      window.acquireVsCodeApi = () => ({
        getState: () => window.__state,
        setState: state => { window.__state = state; },
        postMessage: message => {
          window.__calls.push(message);
          const result = message.method === "catalog" ? window.__catalog : message.method === "library_get"
            ? { ok: true, action: window.__catalog.actions.find(action => action.action_id === message.params.action_id) } : { ok: true };
          queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", { data: { requestId: message.requestId, result } })));
        },
      });
    }, catalog);
    await page.route("https://action.test/**", route => route.fulfill({ contentType: "text/html",
      body: fs.readFileSync(path.join(__dirname, "../resources/action-library.html"), "utf8") }));
    await page.goto("https://action.test/");
    await page.waitForLoadState("networkidle");
    const pending = page.getByRole("region", { name: "Preparing Actions" });
    await page.waitForFunction(() => document.querySelectorAll("[data-pending]").length === 2);
    assert.equal(await page.locator("#list [data-action]").count(), 1);
    assert.equal(await pending.locator("[data-pending]").count(), 2);
    await page.locator('[data-pending="test.echo"]').click();
    assert.equal(await page.locator("#run-form").count(), 0);
    assert.equal(await page.locator("#detail img").count(), 0);
    assert.match(await page.locator("#detail").textContent(), /pending-new/);
    assert.match(await page.locator("#detail").textContent(), /automatically in the background/);
    await page.getByRole("button", { name: "View preparation details", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => __calls.at(-1).params), { action_id: "test.echo" });
    assert.equal(await page.evaluate(() => __calls.at(-1).method), "open_workbench");
    assert.equal(await page.evaluate(() => __state.reviewSelection), "test.echo");
    await page.locator("#search").fill("imported");
    assert.equal(await pending.locator("[data-pending]").count(), 1);
    assert.equal(await page.locator("#list [data-action]").count(), 0);
    await page.locator('[data-pending="test.imported"]').click();
    assert.match(await page.locator("#detail").textContent(), /No validation action is required/);
    await page.locator("#search").fill("");
    await page.locator('[data-action="test.echo"]').click();
    await page.waitForSelector("#run-form");
    assert.equal(await page.locator("#run").isEnabled(), true);
    assert.equal(await page.evaluate(() => __state.reviewSelection), null);
    await page.locator('[data-pending="test.imported"]').click();
    await page.evaluate(() => { __catalog.pending_admissions = []; __catalog.proposals = []; });
    await page.locator("#refresh").click();
    await page.waitForFunction(() => document.querySelector("#pending-review").hidden);
    assert.match(await page.locator("#detail").textContent(), /no longer available/);
    assert.equal(await page.locator("#run-form").count(), 0);
    assert.equal(await page.evaluate(() => __calls.some(call => ["call", "validate", "proposal_decide", "qualification_admit"].includes(call.method))), false);
    for (const width of [420, 800]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(catalog => { __catalog = catalog; }, catalog);
      await page.locator("#refresh").click();
      await page.waitForSelector('[data-pending="test.echo"]');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    assert.deepEqual(errors, []);
    console.log("Action Library review: isolated pending revisions, search, escaping, navigation, refresh and responsive layout passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
