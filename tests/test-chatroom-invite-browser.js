const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const { themes, applyTheme } = require("./ui-theme-fixtures");
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
      ${panel.match(/^const uiIcon = .*$/m)[0]} function chatAgo(){return 'now'}
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
    const roster = panel.slice(panel.indexOf("function chatPaintMembers()"), panel.indexOf("function chatModerate("));
    await page.addStyleTag({ path:path.join(root, "dist/webview/codicon.css") });
    await page.addScriptTag({ content:`
      function chatProtoBadge(){return ''}
      function chatElapsedSeconds(){return '4 sec'}
      function chatEnsureControlComments(){}
      ${roster}
      document.body.insertAdjacentHTML('beforeend','<div id="chat-side"><div id="chat-members"></div></div>');
      chat.active={selfHost:true,members:[{user:'Consumer',kind:'agent',sid:'c6bd',present:true},
        {user:'Host',kind:'extension',host:true,sid:'host-id',present:true}]};
      chatPaintMembers();` });
    for (const selfHost of [true, false]) for (const present of [true, false]) {
      await page.evaluate(({ selfHost, present }) => {
        chat.active.selfHost = selfHost;
        chat.active.members.find(member => member.host).present = present;
        chatPaintMembers();
      }, { selfHost, present });
      assert.equal(await page.locator('#chat-members [data-user="Host"] .chat-ago').count(), 0,
        "Host has no timer in either the current or Earlier roster, for host and guest viewers");
      assert.equal(await page.locator('#chat-members [data-user="Consumer"] .chat-ago').innerText(), "4 sec",
        "Agent state timing remains unchanged");
    }
    await page.evaluate(() => { chat.active.selfHost = true; chatPaintMembers(); });
    for (const theme of Object.keys(themes)) {
      await applyTheme(page, theme);
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height:800 });
        const buttons = page.locator("#chat-members .chat-mod");
        assert.equal(await buttons.count(), 3);
        for (const button of await buttons.all()) {
          for (const interaction of ["normal", "hover", "focus"]) {
            await page.mouse.move(0, 0);
            if (interaction === "hover") await button.hover();
            if (interaction === "focus") {
              await button.focus();
              await page.keyboard.press("Tab");
              await page.keyboard.press("Shift+Tab");
            }
            const style = await button.evaluate(node => {
              const css = getComputedStyle(node), icon = getComputedStyle(node.querySelector(".codicon"));
              const luminance = color => {
                const rgb = color.match(/[\d.]+/g).slice(0,3).map(Number).map(value => {
                  const s = value / 255;
                  return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
                });
                return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
              };
              const fg = luminance(icon.color), bg = luminance(css.backgroundColor);
              const bounds = node.getBoundingClientRect();
              return { contrast:(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05),
                color:css.color, iconColor:icon.color, width:bounds.width, height:bounds.height,
                outline:css.outlineStyle };
            });
            assert(style.contrast >= 4.5, `${theme}/${width}/${interaction}: readable roster icons`);
            assert.equal(style.iconColor, style.color);
            assert(style.width >= 28 && style.height >= 28, "roster actions retain a usable click target");
            if (interaction === "focus") assert.equal(style.outline, "solid");
          }
        }
      }
    }
    await page.evaluate(() => {
      chat.active.meetings = { current:{ status:"active", lead:"Consumer" } };
      chatPaintMembers();
    });
    assert.equal(await page.getByRole("img", { name:"Discussion Lead", exact:true }).count(), 1);
    assert.match(await page.getByRole("img", { name:"Discussion Lead", exact:true }).getAttribute("title"), /background.*Meeting Summary/);
    await page.evaluate(() => {
      chat.managedAgents = [{ id:"helper", name:"Helper", backend:"fixture", roomKey:chat.activeKey, active:true }];
      chat.active.meetings.current.lead = "Helper";
      chatPaintMembers();
    });
    assert.equal(await page.getByRole("img", { name:"Discussion Lead", exact:true }).count(), 1);
    assert.match(await page.getByRole("img", { name:"Discussion Lead", exact:true }).locator("..").locator("..").innerText(), /Helper/);
    await page.evaluate(() => { chat.active.meetings.current.status = "adjourned"; chatPaintMembers(); });
    assert.equal(await page.getByRole("img", { name:"Discussion Lead", exact:true }).count(), 0,
      "historical meetings do not keep marking a current roster member as Lead");
    const header = panel.slice(panel.indexOf('<div id="chat-pane-bar">'), panel.indexOf('<div id="chat-body">'));
    await page.evaluate(source => {
      document.body.insertAdjacentHTML('beforeend', new Function('uiIcon', `return \`${source}\`;`)(uiIcon));
      window.chatRenameSelf = () => ask('chatRenameSelf', {});
    }, header);
    const rename = page.getByRole('button', { name:'Change your display name in this room', exact:true });
    assert.equal(await rename.innerText(), '', 'rename is icon-only, not a right-side text action');
    assert.equal(await rename.evaluate(node => node.previousElementSibling.id), 'chat-pane-title');
    assert.equal(await rename.locator('.codicon-edit').count(), 1);
    await rename.click();
    assert.equal(await page.evaluate(() => requests.at(-1).command), 'chatRenameSelf');
    await page.getByRole('button', { name:'Chat History', exact:true }).click();
    assert.equal(await page.evaluate(() => requests.at(-1).command), 'chatExport', 'history keeps its transcript export behavior');
    assert.equal(await page.getByRole('button', { name:'Share File', exact:true }).count(), 1);
    assert.deepEqual(errors, []);
    console.log("Chatroom Copy magic link: real disclosure-card actions at 360/1280px dispatch UUID copy without switching Rooms; missing credentials stay unavailable.");
    console.log("Chatroom roster: action icons exceed 4.5:1 contrast across four themes at 360/1280px in normal, hover and keyboard-focus states.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
