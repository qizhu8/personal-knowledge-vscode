const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");

const reviewPath = path.join(__dirname, "../tools/work-intent-review/index.html");
const reviewHtml = fs.readFileSync(reviewPath, "utf8");
const reviewData = JSON.parse(reviewHtml.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);

test("offline work-intent review captures labels, persists and exports them, and reveals comparison only after review", async t => {
  const browser = await chromium.launch({ headless:true, args:["--no-sandbox"] });
  t.after(() => browser.close());
  const context = await browser.newContext({ acceptDownloads:true });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  const externalRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (!request.url().startsWith("http://work-intent-review.test/")) externalRequests.push(request.url());
  });
  await page.route("http://work-intent-review.test/**", route => route.fulfill({
    body:reviewHtml, contentType:"text/html; charset=utf-8",
  }));
  await page.goto("http://work-intent-review.test/");

  assert.equal(await page.locator(".sample").count(), 33);
  assert.equal(await page.locator("#progress-value").innerText(), "0 / 33");
  assert.equal(await page.locator("#compare").isDisabled(), true);
  assert.equal(await page.locator(".sample[data-id='W01'] .outcome").isVisible(), false,
    "production outcomes remain hidden until the reviewer makes an independent judgment");

  await page.locator(".sample[data-id='W01'] [data-choice='execute']").click();
  assert.equal(await page.locator("#progress-value").innerText(), "1 / 33");
  assert.match(await page.locator(".sample[data-id='W01'] .outcome").innerText(), /starts a work goal/);
  await page.locator(".sample[data-id='W01'] .note-toggle").click();
  await page.locator(".sample[data-id='W01'] textarea").fill("Clear delegation.");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name:"Export labels" }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "work-intent-review.json");
  const exported = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  assert.deepEqual(exported.decisions.W01, { value:"execute", note:"Clear delegation." });
  assert.equal(await page.getByRole("button", { name:/Unreviewed/ }).innerText(), "Unreviewed 32");

  const importPayload = {
    schemaVersion:1,
    decisions:{ W02:{ value:"explore", note:"Question, not a delegation." } },
  };
  await page.locator("#import-file").setInputFiles({
    name:"review.json", mimeType:"application/json", buffer:Buffer.from(JSON.stringify(importPayload)),
  });
  assert.equal(await page.locator("#progress-value").innerText(), "1 / 33");
  assert.equal(await page.locator(".sample[data-id='W02'] [data-choice='explore']").getAttribute("aria-pressed"), "true");

  await page.locator("#import-file").setInputFiles({
    name:"invalid.json", mimeType:"application/json",
    buffer:Buffer.from(JSON.stringify({ schemaVersion:1, decisions:{ UNKNOWN:{ value:"execute" } } })),
  });
  assert.match(await page.locator("#status").innerText(), /Invalid annotation/);
  assert.equal(await page.locator(".sample[data-id='W02'] [data-choice='explore']").getAttribute("aria-pressed"), "true",
    "invalid imports do not partially replace existing labels");

  for (const sample of reviewData.samples) {
    await page.locator(`.sample[data-id='${sample.id}'] [data-choice='${sample.reference}']`).click();
  }
  assert.equal(await page.locator("#progress-value").innerText(), "33 / 33");
  assert.equal(await page.locator("#compare").isDisabled(), false);
  await page.getByRole("button", { name:"Reveal comparison" }).click();
  assert.match(await page.locator("#comparison-summary").innerText(), /33 of 33 decided labels agree/);
  assert.equal(await page.locator(".sample .outcome").count(), 66,
    "after a decision and explicit reveal, each row shows observed behavior and provisional reference");
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, [], "the review page makes no network requests");
});
