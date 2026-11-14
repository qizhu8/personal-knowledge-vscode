const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const root = process.env.PKM_CHATROOM_TEST_EXTENSION_ROOT || path.resolve(__dirname, "..");

(async () => {
  const browser = await chromium.launch({ headless:true,
    ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath:process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport:{ width:800, height:800 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const panel = fs.readFileSync(path.join(root, "dist/webview/panel.js"), "utf8");
    const functions = panel.slice(panel.indexOf("function chatPaintMembers()"), panel.indexOf("function chatPaintHub()"));
    await page.setContent(`<style>:root{--border:#444;--muted:#aaa;--panel:#111;--text:#fff;--input:#222}body{background:#111;color:#fff}</style>
      <style>${fs.readFileSync(path.join(root, "dist/webview/panel.css"), "utf8")}</style>
      <div id="chat-body"><div id="chat-side"><div id="chat-members"></div></div></div>`);
    await page.addScriptTag({ content:`
      ${panel.match(/^const esc = .*$/m)[0]}
      const requests=[];function ask(command,payload){requests.push({command,payload})}
      function uiIcon(){return '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 6h10"/></svg>'}
      function chatEnsureControlComments(){} function chatProtoBadge(){return ''}
      Date.now=()=>100000000;
      const chat={activeKey:'room', active:{selfHost:true,members:[
        {user:'Consumer Chat',kind:'agent',present:true,participantId:'consumer',sid:'long-stable-id',lastSeen:99994000,role:'Researcher'},
        {user:'PKM Chat',kind:'agent',present:true,participantId:'pkm',lastSeen:99820000},
        {user:'Host Name',kind:'extension',host:true,present:true,lastSeen:13600000},
        {user:'Earlier Guest',kind:'browser',present:false,lastSeen:99940000}
      ]}, proto:{}, managedAgents:[{id:'managed',name:'Managed Agent',roomKey:'room',backend:'test'}]};
      ${functions}
      chatPaintMembers();` });
    assert.equal(await page.evaluate(() => chatElapsedSeconds(99994000)), "6 sec");
    assert.equal(await page.evaluate(() => chatElapsedSeconds(99820000)), "180 sec");
    assert.equal(await page.evaluate(() => chatElapsedSeconds(0)), "unknown");
    assert.equal(await page.evaluate(() => chatElapsedSeconds(100001000)), "0 sec");
    assert.deepEqual(await page.locator(".chat-ago").allTextContents(), ["6 sec", "180 sec", "86400 sec", "60 sec"]);
    for (const width of [140, 170, 220, 340]) {
      await page.locator("#chat-side").evaluate((element, width) => { element.style.width = width + "px"; }, width);
      const measurements = await page.locator(".chat-member").evaluateAll(rows => rows.map(row => {
        const name = row.querySelector(".chat-mname"), text = row.querySelector(".chat-member-name-text");
        const range = document.createRange();
        range.setStart(text.firstChild, 0); range.setEnd(text.firstChild, 4);
        const controls = row.querySelector(".chat-mod-actions");
        return { user:text.textContent, firstFourFit:range.getBoundingClientRect().right <= name.getBoundingClientRect().right + 1,
          controlsBelow:!controls || controls.getBoundingClientRect().top >= name.getBoundingClientRect().bottom - 1,
          fits:row.scrollWidth <= row.clientWidth + 1 };
      }));
      for (const result of measurements) {
        assert(result.firstFourFit, `${width}px must show the name of ${result.user}`);
        assert(result.controlsBelow, "moderation controls cannot compete with the primary name row");
        assert(result.fits, `${width}px row must not overflow`);
      }
    }
    const consumer = page.locator('[data-participant-id="consumer"]');
    await consumer.getByRole("button", { name:"Can speak — click to mute", exact:true }).click();
    assert.deepEqual(await page.evaluate(() => requests.at(-1)), {
      command:"chatModerate", payload:{ action:"mute", participantId:"consumer", sid:"long-stable-id", user:"Consumer Chat", role:"Researcher" },
    });
    await consumer.getByRole("button", { name:"Edit name and role", exact:true }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => requests.at(-1).payload.action), "edit");
    await page.evaluate(() => document.getElementById("chat-body").classList.add("chat-side-collapsed"));
    assert.equal(await consumer.locator(".chat-mod-actions").isVisible(), false);
    assert.equal(await consumer.locator(".chat-ago").isVisible(), false);
    assert.equal(await consumer.locator(".chat-member-name-text").isVisible(), true);
    assert.deepEqual(errors, []);
    console.log("Chat member names remain visible at 140/170/220/340px; elapsed times use seconds; host, managed, earlier and keyboard moderation work.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
