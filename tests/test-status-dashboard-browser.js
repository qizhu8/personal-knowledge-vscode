const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const webview = path.resolve(__dirname, "../src/webview");

function snapshot() {
  return { updatedAt: new Date().toISOString(),
    host: { version: "3.2.75", build: "a".repeat(64), installedVersion: "3.2.74", installedBuild: "b".repeat(64),
      pid: 123, vscode: "fixture", node: "fixture", hosts: 2, busy: true, integration: "ready" },
    retrieval: { observedAt: new Date().toISOString(), lifecycle: { state: "working", detail: "Indexing documents", progress: { current: 25, total: 100, unit: "documents" } },
      status: { ready: true, document_count: 701, ready_generation: 3, building_generation: 4 } },
    sync: [{ id: "primary", name: "Primary backup", status: "needs-attention", detail: "Local content needs repair. Remote has not been fetched.",
      lastSuccessAt: new Date(Date.now() - 90 * 60000).toISOString() }],
    tasks: { revision: 1, updatedAt: new Date().toISOString(), tasks: [{ id: "build", kind: "retrieval", label: "Build retrieval index", status: "running" }] },
  };
}

for (const width of [1280, 390, 320]) test(`Dashboard CSP, real progress, read-only navigation and responsive layout (${width}px)`, { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [], posted = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.exposeFunction("hostPost", message => posted.push(message));
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage: message => window.hostPost(message) }); });
  await page.route("http://pkm-dashboard.test/**", async route => {
    const name = new URL(route.request().url()).pathname.slice(1) || "status-dashboard.html";
    assert(["status-dashboard.html", "status-dashboard.css", "status-dashboard.js"].includes(name));
    let body = fs.readFileSync(path.join(webview, name), "utf8");
    if (name.endsWith(".html")) body = body.replace(/\{\{nonce\}\}/g, "fixture-nonce")
      .replace(/\{\{cspSource\}\}/g, "http://pkm-dashboard.test")
      .replace(/\{\{styles\}\}/g, "/status-dashboard.css").replace(/\{\{script\}\}/g, "/status-dashboard.js");
    await route.fulfill({ body, contentType: name.endsWith(".css") ? "text/css" : name.endsWith(".js") ? "application/javascript" : "text/html" });
  });
  await page.goto("http://pkm-dashboard.test/");
  const send = value => page.evaluate(data => window.postMessage(data, "*"), value);
  await send({ type: "snapshot", snapshot: snapshot() });
  await page.getByRole("heading", { name: "Retrieval index", exact: true }).waitFor();
  assert.match(await page.locator("#dashboard").innerText(), /25 \/ 100 \(25%\)/);
  assert.match(await page.locator("#dashboard").innerText(), /1 h 30 min ago/);
  assert.match(await page.locator("#dashboard").innerText(), /needs-attention/);
  assert.equal(await page.getByRole("progressbar", { name: "Index build progress" }).getAttribute("value"), "25");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const unknown = snapshot();
  unknown.retrieval.lifecycle.progress.total = null;
  unknown.retrieval.lifecycle.detail = '<img src=x onerror="window.evil=true">';
  await send({ type: "snapshot", snapshot: unknown });
  assert.equal(await page.getByRole("progressbar", { name: "Index build progress" }).getAttribute("value"), null);
  assert.equal(await page.locator("#dashboard img").count(), 0, "external status strings are escaped, never executable HTML");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Host log", exact: true }).click();
  await page.getByRole("button", { name: "Host diagnostics JSON", exact: true }).click();
  await page.getByRole("button", { name: "GitHub Sync", exact: true }).click();
  assert.deepEqual(posted.map(message => message.type), ["ready", "refresh", "logs", "diagnostics", "sync"],
    "renderer stays responsive without waiting for a host refresh, and exposes no write/run action");
  await send({ type: "error", message: "Worker observation unavailable" });
  await page.getByRole("alert").waitFor();
  assert.match(await page.locator("#notice").innerText(), /unavailable/);
  await send({ type: "snapshot", snapshot: snapshot() });
  assert.equal(await page.locator("#notice").isHidden(), true);
  assert.deepEqual(errors, []);
});
