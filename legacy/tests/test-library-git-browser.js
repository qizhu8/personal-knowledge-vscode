const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const webview = path.join(__dirname, "..", "dist", "webview");

test("actual Server Git and Action privacy controls require explicit user dispatch and preserve escaped source names", async t => {
  const browser = await chromium.launch({ headless:true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:390, height:900 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("http://localhost/library-fixture", route => route.fulfill({ contentType:"text/html", body:'<!doctype html><div id="detail"></div><div id="selection"></div>' }));
  await page.goto("http://localhost/library-fixture");
  await page.evaluate(() => {
    window.state = { tab:"other" }; window.__commands = [];
    window.ask = (command, payload) => window.__commands.push({ command, payload });
    window.esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
    window.uiIcon = (_name, label) => label || ""; window.t = text => text;
    window.captureRefreshView = () => ({}); window.restoreRefreshView = () => {};
    window.brokerShareMarker = () => ""; window.mergeBrokerShares = (...shares) => shares.flat();
  });
  await page.addStyleTag({ path:path.join(webview, "panel.css") });
  const bundle = fs.readFileSync(path.join(webview, "panel.js"), "utf8");
  for (const name of ["40-servers.js", "46-github-sync.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "src/webview/panel", name), "utf8");
    const start = bundle.indexOf(source);
    assert(start >= 0, `${name} must be present verbatim in the built panel`);
    await page.addScriptTag({ content:bundle.slice(start, start + source.length) });
  }
  await page.evaluate(() => renderServerDashboard([{ slug:"fixture", name:"Git fixture", port:8000, command:"npm start", status:"stopped",
    tags:[], git:{ url:"https://example.test/repository", branch:"feature/source", revision:"a".repeat(40) } }]));
  await page.getByRole("button", { name:"Import Git", exact:true }).click();
  await page.getByRole("button", { name:"Update branch", exact:true }).click();
  let commands = await page.evaluate(() => window.__commands);
  assert(commands.some(item => item.command === "serverImportGit"));
  assert(commands.some(item => item.command === "serverUpdateGit" && item.payload.slug === "fixture"));
  assert(!commands.some(item => ["serverStart", "run", "install"].includes(item.command)));
  await page.evaluate(() => {
    document.getElementById("selection").innerHTML = githubSyncRenderTree("public", "actions",
      { folders:{}, items:[{ id:"test.fixture", label:'<img src=x onerror="window.__injected=true">', cat:"", isPrivate:false, meta:"definition only" }] },
      [], new Set(), new Set(), new Set());
  });
  assert.equal(await page.locator("#selection img").count(), 0);
  await page.getByRole("button", { name:"Make Private", exact:true }).click();
  commands = await page.evaluate(() => window.__commands);
  assert.deepEqual(commands.at(-1), { command:"contentSetPrivacy", payload:{ type:"actions", topLevel:"test.fixture", isPrivate:true } });
  assert.equal(await page.locator("#selection input").isChecked(), false, "privacy button must not toggle Sync selection");
  assert.deepEqual(errors, []);
});
