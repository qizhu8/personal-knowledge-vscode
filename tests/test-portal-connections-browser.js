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
      lastSeenAt:Date.now(), state:"active", chatId:"controlled-id", chatLabel:"Controlled Chat", role:"controlled" };
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
      await right.getByRole("button", {name:"Open Chat"}).click();
      const sent = await page.evaluate(() => requests.slice(-2));
      assert.deepEqual(sent, [
        { command:"portalConnectionOpenChat", payload:{chatId:"controlled-id"} },
        { command:"portalConnectionOpenChat", payload:{chatId:"controller-id"} },
      ]);
      assert.equal(await page.locator(`[data-pair-id="${pairId.replace(/"/g, '\\"')}"]`).count(), 1, "pair id survives attribute escaping");
      assert.equal(await page.getByRole("button", {name:"Remove", exact:true}).count(), 0, "live pairs end by disconnecting, not by removal");
      const colors = await left.getByRole("button", {name:"Open Chat"}).evaluate(element => ({
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
    assert.equal(await page.locator("[data-pair-id]").count(), 1, "ended pairs are hidden");
    await page.evaluate(({base}) => portalConnectionsOnSnapshot({connections:[
      {...base, chatId:"0000000a-0000-0000-0000-000000000000", access:{permissions:{mode:"scoped", dimensions:["files-read"], scoped:true, expiresAt:Date.now()+400}}},
      {...base, chatId:"controller-id", role:"controller"},
    ]}), {base});
    assert.match(await page.locator('[data-portal-access="permissions"]').innerText(), /files-read · scoped folders/);
    await page.getByRole("button", { name:"Permissions…", exact:true }).click();
    assert.deepEqual(await page.evaluate(() => requests.at(-1)),
      {command:"portalConnectionPermissions", payload:{chatId:"0000000a-0000-0000-0000-000000000000"}});
    await page.waitForFunction(() => /Permissions: none/.test(document.querySelector('[data-portal-access="permissions"]')?.textContent || ""), null, { timeout:3000 });
    await page.evaluate(({base}) => { const reconnecting={since:Date.now(), deadline:Date.now()+400}; portalConnectionsOnSnapshot({connections:[
      {...base, state:"reconnecting", reconnecting},
      {...base, chatId:"controller-id", role:"controller", state:"active"},
      {...base, pairId:"lapsing", chatId:"other", state:"reconnecting", reconnecting},
    ]}); }, {base});
    assert.match(await page.locator(".portal-connection-status").first().innerText(), /reconnecting/i, "either side reconnecting marks the pair");
    assert.match(await page.locator(".portal-connection-total").innerText(), /0 active · 2 reconnecting/);
    await page.waitForFunction(() => !document.querySelector('[data-pair-id="lapsing"]'), null, { timeout:3000 });
    await page.evaluate(() => portalConnectionsOnSnapshot({ connections:[], pendingInvitations:[
      { chatId:"short", chatLabel:"Short Link", localMachine:"linux", role:"controller", expiresAt:Date.now()+400, endpoint:"ws://localhost:7345" },
    ] }));
    assert.equal(await page.getByRole("button", { name:"Copy magic code", exact:true }).count(), 1);
    await page.waitForFunction(() => !document.body.innerText.includes("Copy magic code"), null, { timeout:3000 });
    await page.evaluate(({base}) => portalConnectionsOnSnapshot({connections:[
      {...base, state:"ended"}, {...base, chatId:"live", role:"controller",state:"active"},
    ]}), {base});
    assert.match(await page.locator(".portal-connection-total").innerText(), /^1 active$/);
    for (const width of [320, 760, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => portalConnectionsOnSnapshot({ connections: [], endpoints: [{
        id: "00000000-0000-4000-8000-000000000001", name: "<b>Linux endpoint</b>", localMachine: "linux-host",
        chatId: "old-chat", chatName: "Old session", deleted: true, acceptsIncoming: false, permissions: [],
        paired: true, state: "connected",
        peer: { name: "Windows endpoint", machine: "windows-host", chatName: "Windows Chat", acceptsIncoming: true, confirmed: true },
      }] }));
      const endpoint = page.locator("[data-endpoint-id]");
      assert.match(await endpoint.innerText(), /Local · this machine/);
      assert.match(await endpoint.innerText(), /PKM Chat: deleted/);
      assert.match(await endpoint.innerText(), /Remote/);
      assert.match(await endpoint.innerText(), /Accept remote control: Disabled/);
      assert.match(await endpoint.innerText(), /Accept local control: Enabled/);
      assert.equal(await endpoint.locator("b").count(), 0, "endpoint identity is always text");
      assert.equal(await endpoint.getByRole("button", { name: "Open Chat", exact: true }).count(), 0);
      const buttons = await endpoint.locator(".portal-connection-actions button").evaluateAll(nodes =>
        nodes.map(node => { const rect = node.getBoundingClientRect(); return { x:rect.x, y:rect.y, width:rect.width }; }));
      assert.equal(buttons.length, 4);
      if (width <= 600) {
        assert(buttons.every(button => Math.abs(button.x - buttons[0].x) < 1), "narrow panel uses one button column");
        assert(buttons.every((button, index) => !index || button.y > buttons[index - 1].y), "narrow panel uses four rows");
      } else {
        assert(Math.abs(buttons[0].y - buttons[1].y) < 1 && Math.abs(buttons[2].y - buttons[3].y) < 1,
          "wide panel uses two button rows");
        assert(buttons[2].y > buttons[0].y && buttons[1].x > buttons[0].x, "wide panel uses a two-by-two grid");
      }
      await endpoint.getByRole("button", { name: "Replace Chat…", exact: true }).click();
      assert.deepEqual(await page.evaluate(() => requests.at(-1)), { command: "portalEndpointBind",
        payload: { endpointId: "00000000-0000-4000-8000-000000000001" } });
      await endpoint.getByRole("button", { name: "Local permissions…", exact: true }).click();
      assert.equal((await page.evaluate(() => requests.at(-1))).command, "portalEndpointPermissions");
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "saved endpoint fits narrow panels");
    }
    await page.evaluate(() => portalConnectionsOnSnapshot({ connections: [], endpoints: [{
      id: "offline", name: "Linux", localMachine: "linux", deleted: false, acceptsIncoming: false, permissions: [],
      paired: true, state: "disconnected", peer: { name: "Windows", chatName: "Old Chat", confirmed: false },
    }] }));
    assert.match(await page.locator("[data-endpoint-id]").innerText(), /not synchronized/);
    assert.match(await page.locator("[data-endpoint-id]").innerText(), /Accept local control: Unknown/);
    await page.evaluate(() => portalConnectionsOnSnapshot({ connections: [], hubPort: {
      requestedPort: 37009, actualPort: 42137, state: "ready", reason: "in-use", at: Date.now(),
    } }));
    const portNotice = page.locator("[data-portal-hub-port]");
    assert.match(await portNotice.innerText(), /37009 → Actual: 42137 · Port changed/);
    assert.match(await portNotice.innerText(), /existing listener was not stopped/);
    assert.match(await portNotice.innerText(), /saved remote addresses were not updated/);
    await page.evaluate(() => portalConnectionsOnSnapshot({ connections: [], hubPort: {
      requestedPort: 37009, state: "failed", reason: "in-use", at: Date.now(), error: "<b>Bind failed</b>",
    } }));
    assert.equal(await portNotice.getAttribute("role"), "alert");
    assert.match(await portNotice.innerText(), /Not listening/);
    assert.equal(await portNotice.locator("b").count(), 0);
    assert.deepEqual(errors, [], "all fixed buttons must execute without interface syntax failures");
    console.log("Portal browser: exact legacy Remove error reproduced; one pair/row, left Controlled/right Controller, 3 viewport Open Chat clicks/colors, pending copy, ended-pair filtering, reconnecting display, permission display/command and local expiry re-render passed.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
