const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const vm = require("node:vm");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");

const root = process.env.PKM_ACTION_ICON_EXTENSION_ROOT || path.resolve(__dirname, "..");
const exportsObject = {};
vm.runInNewContext(fs.readFileSync(path.join(root, "dist/ui/action-browser.js"), "utf8"), {
  exports:exportsObject, process, console, URL,
  require(name) {
    if (name === "vscode") return { workspace:{ isTrusted:true } };
    if (name === "../mcp/mcp") return { configuredMcpFeatureDomains:() => ["automation"] };
    if (name.startsWith("../")) return {};
    return require(name);
  },
});

(async () => {
  const css = fs.readFileSync(path.join(root, "dist/webview/codicon.css"), "utf8");
  const font = fs.readFileSync(path.join(root, "dist/webview/codicon.ttf"));
  const server = http.createServer((request, response) => {
    if (request.url.startsWith("/codicon.ttf")) {
      response.writeHead(200, { "Content-Type":"font/ttf" }); response.end(font);
    } else if (request.url === "/codicon.css") {
      response.writeHead(200, { "Content-Type":"text/css" }); response.end(css);
    } else {
      const policy = fs.readFileSync(path.join(root, "src/webview/panel.html"), "utf8")
        .match(/<meta http-equiv="Content-Security-Policy"[^>]+>/)[0].replaceAll("%%CSP_SOURCE%%", "'self'");
      response.end(`<html><head>${policy}</head><body><iframe sandbox="allow-scripts"></iframe></body></html>`);
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless:true,
      ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath:process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
    const page = await browser.newPage();
    await page.goto(origin);
    const load = async html => {
      await page.locator("iframe").evaluate((frame, document) => { frame.srcdoc = document; }, html);
      const frame = page.frames().find(item => item.parentFrame());
      await frame.waitForSelector("#refresh");
      await frame.evaluate(() => document.fonts.ready);
      return frame;
    };
    // The sandbox's opaque origin makes the old external font a cross-origin request.
    const old = `<head><link rel="stylesheet" href="${origin}/codicon.css"></head>
      <button id="refresh"><i class="codicon codicon-refresh"></i></button>`;
    const broken = await load(old);
    assert.equal(await broken.evaluate(() => document.fonts.check("16px codicon")), false,
      "the regression fixture must reproduce the old blank icon font");
    const html = exportsObject.renderEmbeddedActionWorkbench({ cspSource:"'self'" },
      { extensionPath:root }, { libraryOpen:false });
    const frame = await load(html);
    await frame.waitForFunction(() => document.getElementById("cancel-run"));
    assert.equal(await frame.evaluate(() => document.fonts.check("16px codicon")), true,
      "the actual sandboxed Workbench must load its icon font");
    const buttons = ["workspace", "open-browser", "refresh", "add-group", "import", "export", "toggle-tree", "cancel-run", "delete-wire"];
    for (const id of buttons) {
      const icon = frame.locator(`#${id} .codicon`);
      assert.equal(await icon.count(), 1, `${id} has an icon`);
      const glyph = await icon.evaluate(element => ({
        content:getComputedStyle(element, "::before").content,
        font:getComputedStyle(element).fontFamily,
      }));
      assert.notEqual(glyph.content, "none", `${id} has a glyph`);
      assert.match(glyph.font, /codicon/);
      assert(await frame.locator(`#${id}`).getAttribute("aria-label"), `${id} keeps its accessible name`);
    }
    assert.equal(await frame.locator("#refresh").isVisible(), true);
    console.log(`Action buttons: reproduced blocked legacy font; ${buttons.length} actual sandboxed button glyphs load with accessible names.`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
