const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const root = process.env.PKM_CHATROOM_TEST_EXTENSION_ROOT || path.resolve(__dirname, "..");

(async () => {
  const browser = await chromium.launch({ headless:true,
    ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath:process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const panel = fs.readFileSync(path.join(root, "dist/webview/panel.js"), "utf8");
    const component = panel.slice(0, panel.indexOf('const nativeInteractiveTags'));
    const cards = panel.slice(panel.indexOf("function chatRoomCard(room)"), panel.indexOf("function chatActiveRoomMenu("));
    const esc = panel.match(/^const esc = .*$/m)[0];
    await page.setContent(`<style>:root{--border:#444;--muted:#aaa;--panel:#111;--fg:#fff}</style>
      <style>${fs.readFileSync(path.join(root, "dist/webview/panel.css"), "utf8")}</style>
      <div id="chat-hosted-rooms"></div><div id="chat-joined-rooms"></div><span id="chat-hosted-count"></span><span id="chat-joined-count"></span>`);
    await page.addScriptTag({ content:component });
    await page.addScriptTag({ content:`${esc}
      const requests=[];function ask(command,payload){requests.push({command,payload})}
      function uiIcon(){return ''} function chatAgo(){return 'now'}
      const chatInactiveExpanded={hosted:false,joined:false};
      const chat={rooms:[],storedRooms:[],recents:[],activeKey:'',hubAdminRooms:[]};
      ${cards}` });
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height:800 });
      await page.evaluate(() => {
        chat.hubAdminRooms = [{ roomId:"11111111-1111-4111-8111-111111111111", room:"Room with spaces", members:1, hasKey:true }];
        chatPaintRoomCards();
      });
      const card = page.locator("uone-disclosure-card").first();
      await card.hover();
      const copy = page.getByRole("button", { name:"Copy magic link", exact:true });
      await copy.click();
      assert.deepEqual(await page.evaluate(() => requests.at(-1)), {
        command:"chatCopyInvite", payload:{ roomId:"11111111-1111-4111-8111-111111111111" },
      });
      assert.equal(await page.evaluate(() => requests.filter(item => item.command === "chatSetActive").length), 0,
        "copy must not activate or switch the Room");
    }
    await page.evaluate(() => { chat.hubAdminRooms[0].hasKey = false; chatPaintRoomCards(); });
    assert.equal(await page.getByRole("button", { name:"Copy magic link", exact:true }).count(), 0,
      "a missing Room secret cannot produce a fake invite");
    assert.deepEqual(errors, []);
    console.log("Chatroom Copy magic link: real disclosure-card actions at 360/1280px dispatch UUID copy without switching Rooms; missing credentials stay unavailable.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
