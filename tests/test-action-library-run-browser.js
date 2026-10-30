const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const root = path.resolve(__dirname, "..");

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const action = { action_id: "test.download", display_name: "Download file", description: "Manual download fixture",
      content_hash: "pinned-download-revision", category: "Files", effects: ["remote-read", "local-write"],
      availability: { state: "ready" },
      input_schema: { type: "object", required: ["source", "destination", "count", "format"], properties: {
        source: { type: "object", description: "Managed artifact reference", required: ["artifact_id"] },
        destination: { type: "string", description: "Local destination filename", minLength: 2 },
        count: { type: "integer", minimum: 1, maximum: 3, default: 1 },
        format: { type: "string", enum: ["raw", "text"] },
        tags: { type: "array", description: "Optional labels" },
        overwrite: { type: "boolean", default: false },
      } },
      output_schema: { properties: {
        artifact_id: { type: "string", description: "Downloaded managed artifact" },
        bytes: { type: "integer", description: "Bytes received" },
      } },
      examples: [{ inputs: { source: { artifact_id: "example-artifact" } } }],
    };
    await page.addInitScript(action => {
      window.__action = action; window.__calls = []; window.__state = {};
      window.acquireVsCodeApi = () => ({
        getState: () => window.__state, setState: value => { window.__state = value; },
        postMessage: message => {
          window.__calls.push(message);
          let result = { ok: true };
          if (message.method === "catalog") result.actions = [window.__action];
          if (message.method === "library_get") result.action = window.__action;
          if (message.method === "call") result = { ok: true, run_id: "action_run_" + "a".repeat(32), state: "running" };
          if (message.method === "run") result = { ok: true, run_id: "action_run_" + "a".repeat(32), state: "succeeded",
            outputs: { artifact_id: "downloaded-file", bytes: 42 } };
          queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", { data: { requestId: message.requestId, result } })));
        },
      });
    }, action);
    await page.route("https://action.test/**", route => route.fulfill({ contentType: "text/html",
      body: fs.readFileSync(path.join(root, "resources/action-library.html"), "utf8") }));
    await page.goto("https://action.test/");
    await page.waitForLoadState("networkidle");
    await page.locator('[data-action="test.download"]').click();
    await page.waitForSelector("#run-form");
    assert.equal(await page.getByRole("region", { name: "Inputs", exact: true }).count(), 1);
    assert.equal(await page.getByRole("region", { name: "Outputs", exact: true }).count(), 1);
    assert.equal(await page.locator("#output-fields .output-field").count(), 2);
    assert.match(await page.locator("#fields").textContent(), /Managed artifact reference/);
    assert.match(await page.locator("#fields").textContent(), /Required fields: artifact_id/);
    assert.match(await page.locator('[data-field="source"]').getAttribute("placeholder"), /example-artifact/);

    const panelSource = fs.readFileSync(path.join(root, "src/webview/panel/53-panel-instances.js"), "utf8");
    const themeFunction = panelSource.slice(panelSource.indexOf("function syncActionLibraryTheme()"),
      panelSource.indexOf("const actionLibraryThemeObserver"));
    await page.addScriptTag({ content: `window.__themePosts=[];const embeddedActionViews={actionLibrary:{frame:{contentWindow:{postMessage:message=>__themePosts.push(message)}}}};${themeFunction}` });
    for (const [scheme, background, foreground, border, button] of [
      ["dark", "#253344", "#f0f3f6", "#7799aa", "#1266aa"],
      ["light", "#ffffff", "#18202a", "#687788", "#0055aa"],
    ]) {
      await page.evaluate(({ scheme, background, foreground, border, button }) => {
        document.documentElement.style.colorScheme = scheme;
        const values = { "input-background": background, "input-foreground": foreground, "input-border": border,
          "button-background": button, "button-foreground": "#ffffff", "button-hoverBackground": "#2277bb" };
        for (const [name, value] of Object.entries(values)) document.documentElement.style.setProperty("--vscode-" + name, value);
        syncActionLibraryTheme();
      }, { scheme, background, foreground, border, button });
      const actual = await page.locator('[data-field="destination"]').evaluate(input => ({
        background: getComputedStyle(input).backgroundColor, foreground: getComputedStyle(input).color,
        border: getComputedStyle(input).borderTopColor,
      }));
      const rgb = hex => `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(", ")})`;
      assert.deepEqual(actual, { background: rgb(background), foreground: rgb(foreground), border: rgb(border) });
      assert.equal(await page.locator("#run").evaluate(button => getComputedStyle(button).backgroundColor), rgb(button));
      assert.equal(await page.evaluate(() => __themePosts.at(-1).variables["--vscode-input-border"]), border);
      assert.equal(await page.evaluate(() => __themePosts.at(-1).variables["--vscode-button-background"]), button);
      assert.equal(await page.locator(".action-section").first().evaluate(node => getComputedStyle(node).borderTopWidth), "1px");
    }

    const source = page.locator('[data-field="source"]'), destination = page.locator('[data-field="destination"]');
    await source.fill("{invalid");
    await destination.fill("file.bin");
    await page.locator('[data-field="format"]').selectOption('"raw"');
    await page.locator("#approve").check();
    await page.locator("#run").click();
    assert.match(await page.locator("#error").textContent(), /source: Enter valid JSON/);
    assert.equal(await page.evaluate(() => __calls.filter(call => call.method === "call").length), 0);
    await source.fill('{"artifact_id":"source-file"}');
    assert.equal(await page.locator("#approve").isChecked(), false);
    await page.evaluate(() => refresh(true));
    assert.equal(await page.locator('[data-field="source"]').inputValue(), '{"artifact_id":"source-file"}',
      "background catalog refresh must preserve a manual invocation draft");
    await page.locator('[data-field="tags"]').fill('["manual"]');
    await page.locator("#approve").check();
    await page.locator("#run").click();
    await page.waitForFunction(() => document.getElementById("run-status").textContent.includes("succeeded"));
    const calls = await page.evaluate(() => __calls.filter(call => call.method === "call"));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params.inputs, { source: { artifact_id: "source-file" }, destination: "file.bin",
      count: 1, format: "raw", tags: ["manual"], overwrite: false });
    assert.equal(calls[0].params.content_hash, action.content_hash);
    assert.match(calls[0].params.key, /^[a-f0-9-]{36}$/);
    assert.match(await page.locator("#run-result").textContent(), /downloaded-file/);
    assert.equal(await page.locator("#approve").isChecked(), false);

    await page.evaluate(() => { __action.availability = { state: "stale" }; });
    await page.locator("#refresh").click();
    await page.waitForFunction(() => document.getElementById("run").disabled);
    assert.match(await page.locator("#run-blocked").textContent(), /checked automatically/);
    await page.locator("#validate-workbench").click();
    assert.deepEqual(await page.evaluate(() => __calls.at(-1).params), { action_id: "test.download" });
    assert.equal(await page.evaluate(() => __calls.at(-1).method), "open_workbench");
    for (const width of [420, 800]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    assert.deepEqual(errors, []);
    console.log("Action Library manual run: themed I/O sections, typed parameters, pinned single submission, results and readiness gates passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
