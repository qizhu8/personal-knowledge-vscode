const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const root = process.env.PKM_PORTAL_TEST_EXTENSION_ROOT || path.resolve(__dirname, "..");

(async () => {
  const browser = await chromium.launch({ headless:true,
    ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath:process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent(`<style>:root{--vscode-editor-background:#181818;--vscode-sideBar-background:#202020;--vscode-input-background:#111;--vscode-foreground:#fff;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#444;--vscode-focusBorder:#4daafc;--vscode-list-hoverBackground:#111;--vscode-font-family:Arial;--vscode-font-size:13px}</style>
      <style>${fs.readFileSync(path.join(root, "src/webview/panel.css"), "utf8")}</style><main id="detail"></main>`);
    await page.addStyleTag({ content:fs.readFileSync(path.join(root, "dist/webview/codicon.css"), "utf8")
      + `\n@font-face{font-family:codicon;src:url(data:font/ttf;base64,${fs.readFileSync(path.join(root, "dist/webview/codicon.ttf")).toString("base64")})}` });
    const core = fs.readFileSync(path.join(root, "src/webview/panel/00-core.js"), "utf8");
    const esc = core.match(/^const esc = .*$/m)[0];
    await page.addScriptTag({ content:`${esc}
      const state={tab:'portalConnections'};const requests=[];
      function ask(command, payload) { requests.push({ command, payload }); }` });
    // Match the actual shared esc helper: it escapes text, not HTML attribute quotes.
    await page.evaluate(() => {
      document.getElementById("detail").innerHTML = `<button id="legacy" onclick="ask('portalConnectionForget', { pairId:${esc(JSON.stringify('fixture-pair'))} })">Remove</button>`;
    });
    await page.locator("#legacy").click();
    assert(errors.some(error => /Unexpected end of input/.test(error)), "reproduce the user's exact Remove syntax error");
    errors.length = 0;
    await page.addScriptTag({ content:fs.readFileSync(path.join(root, "src/webview/panel/16-portal-connections.js"), "utf8") });
    const pairId = `fixture-"pair'&<end>`;
    const base = { pairId, localMachine:"linux", peerMachine:"remote", peerName:"Peer", connectedAt:Date.now()-1000,
      lastSeenAt:Date.now(), state:"ended", chatId:"controlled-id", chatLabel:"Controlled Chat", role:"controlled" };
    for (const width of [320, 760, 1280]) {
      await page.setViewportSize({ width, height:900 });
      await page.evaluate(({base}) => portalConnectionsOnSnapshot({ connections:[
        base, {...base, chatId:"controller-id", chatLabel:"Controller Chat", role:"controller"},
      ] }), { base });
      assert.equal(await page.locator("[data-pair-id]").count(), 1);
      const left = page.locator('[data-portal-role="controlled"]');
      const right = page.locator('[data-portal-role="controller"]');
      assert((await left.boundingBox()).x < (await right.boundingBox()).x);
      assert.equal(await page.getByRole("button", { name:"Open Chat", exact:true }).count(), 2);
      await left.getByRole("button", {name:"Open Chat"}).click();
      await page.getByRole("button", {name:"Remove", exact:true}).click();
      const sent = await page.evaluate(() => requests.slice(-2));
      assert.deepEqual(sent, [
        { command:"portalConnectionOpenChat", payload:{chatId:"controlled-id"} },
        { command:"portalConnectionForget", payload:{pairId} },
      ]);
      const colors = await page.getByRole("button", {name:"Remove", exact:true}).evaluate(element => ({
        background:getComputedStyle(element).backgroundColor, color:getComputedStyle(element).color,
      }));
      assert.deepEqual(colors, { background:"rgb(17, 17, 17)", color:"rgb(255, 255, 255)" });
      if (width === 1280 && process.env.PKM_FEATURE_PORTAL_SCREENSHOT) {
        await page.locator("#detail").screenshot({ path:process.env.PKM_FEATURE_PORTAL_SCREENSHOT });
      }
    }
    await page.evaluate(() => portalConnectionsOnSnapshot({ connections:[], pendingInvitations:[
      { chatId:"new-controller", chatLabel:"New Controller", localMachine:"linux", role:"controller",
        expiresAt:Date.now()+60000, endpoint:"ws://localhost:7345" },
    ] }));
    assert.match(await page.locator('[data-portal-role="controlled"]').innerText(), /Awaiting peer/);
    assert.match(await page.locator('[data-portal-role="controller"]').innerText(), /New Controller/);
    await page.getByRole("button", { name:"Copy magic code", exact:true }).click();
    assert.deepEqual(await page.evaluate(() => requests.at(-1)),
      {command:"portalConnectionCopyMagicLink",payload:{chatId:"new-controller"}});
    assert(!await page.locator("#detail").innerHTML().then(html => html.includes("pkmportal:")));
    await page.evaluate(({base}) => portalConnectionsOnSnapshot({connections:[
      {...base, state:"ended"}, {...base, chatId:"live", role:"controller",state:"active"},
    ]}), {base});
    assert.equal(await page.getByRole("button", {name:"Remove",exact:true}).count(), 0);
    assert.deepEqual(errors, [], "all fixed buttons must execute without interface syntax failures");
    console.log("Portal browser: exact legacy Remove error reproduced; one pair/row, left Controlled/right Controller, 3 viewport clicks/colors, pending copy and live removal guard passed.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
