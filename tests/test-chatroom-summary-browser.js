const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");

test("Meeting Summary retains live DOM, focus, selection, scroll and disclosures across status and content updates", async () => {
  const browser = await chromium.launch({ headless:true,
    ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath:process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport:{ width:1100, height:700 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const root = path.resolve(__dirname, "..");
    const panel = fs.readFileSync(path.join(root, "dist/webview/panel.js"), "utf8");
    await page.setContent(`<style>:root{--border:#444;--muted:#aaa;--panel:#222;--text:#ddd;--bg:#181818;--input:#333;--accent:#59f}
      #chat-main{width:100%;height:600px}#chat-meeting-document .chat-meeting-minutes-meta{min-width:1200px}</style>
      <div id="chat-main"><button id="chat-meeting-summary-btn"></button><section id="chat-meeting-summary" class="chat-meeting-summary">
      <header class="chat-meeting-summary-head"><span id="chat-meeting-summary-meta"></span></header>
      <div id="chat-meeting-summary-body" class="chat-meeting-summary-body"></div></section></div><textarea id="outside"></textarea>`);
    await page.addStyleTag({ path:path.join(root, "dist/webview/panel.css") });
    await page.addScriptTag({ content:`${panel.match(/^const esc = .*$/m)[0]}\n${panel.match(/^const uiIcon = .*$/m)[0]}` });
    const source = fs.readFileSync(path.join(root, "src/webview/panel/10-chatroom.js"), "utf8");
    assert(panel.includes(source), "test must run the built Chatroom code");
    await page.addScriptTag({ content:source });
    await page.evaluate(() => {
      const topic = index => ({
        id:`topic-${index}`, title:`Topic ${index}`, owner:"Helper", round:1, status:"discussing",
        problemStatement:"Problem ".repeat(100), rounds:[{ number:1, status:"open", opinions:[{participant:"Host",text:"Evidence ".repeat(90)}] }],
        subtopics:index === 0 ? [{ id:"child", title:"Child", owner:"Helper", round:1, status:"queued", problemStatement:"Detail" }] : [],
      });

      const meeting = { id:"live", title:"Live meeting", revision:1, status:"active", startedAt:"2026-11-03T14:00:00Z",
        participants:["Host","Helper"], lead:"Helper", recorder:"Host", topics:Array.from({length:8},(_,index) => topic(index)), activeTopicId:"topic-0" };
      chat.activeKey = "room-a";
      chat.active = { selfHost:true, meetings:{ current:meeting,
        history:Array.from({length:30},(_,index) => ({...meeting,id:`archive-${index}`,status:"adjourned",title:`Archived ${index}`})), trash:[] } };
      chatPaintMeetingSummary();
      const body = document.getElementById("chat-meeting-summary-body");
      window.liveBody = body;
      window.liveTopic = body.querySelector('[data-topic-id="topic-0"]');
      liveTopic.open = false;
      body.querySelector('[data-topic-id="child"]').open = true;
      body.querySelector('.chat-meeting-trash').open = true;
      window.liveButton = body.querySelector(".chat-meeting-adjourn");
      liveButton.focus();
      const text = body.querySelector('[data-topic-id="topic-1"] .chat-meeting-branch p').firstChild;
      const range = document.createRange(); range.setStart(text,0); range.setEnd(text,7);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      const doc = document.getElementById("chat-meeting-document"), list = body.querySelector(".chat-meeting-list");
      doc.scrollTop = 320; doc.scrollLeft = 25; list.scrollTop = 160;
      window.scrollBefore = [doc.scrollTop, doc.scrollLeft, list.scrollTop];
      window.mutations = 0;
      window.observer = new MutationObserver(records => { mutations += records.length; });
      observer.observe(body, { subtree:true, childList:true, attributes:true, characterData:true });
    });
    await page.evaluate(() => new Promise(resolve => {
      let ticks = 0;
      const timer = setInterval(() => {
        chatPaintMeetingSummary();
        if (++ticks === 12) { clearInterval(timer); resolve(); }
      }, 5);
    }));
    assert.deepEqual(await page.evaluate(() => ({
      focus:document.activeElement === liveButton, topic:liveTopic === liveBody.querySelector('[data-topic-id="topic-0"]'),
      open:liveTopic.open, child:liveBody.querySelector('[data-topic-id="child"]').open,
      trash:liveBody.querySelector('.chat-meeting-trash').open, text:getSelection().toString(), mutations,
      scroll:[document.getElementById("chat-meeting-document").scrollTop,document.getElementById("chat-meeting-document").scrollLeft,liveBody.querySelector(".chat-meeting-list").scrollTop],
      expected:scrollBefore,
    })), { focus:true, topic:true, open:false, child:true, trash:true, text:"Problem", mutations:0,
      scroll:[320,25,160], expected:[320,25,160] });
    await page.evaluate(() => {
      chat.active.meetings.current.revision = 2;
      chat.active.meetings.current.topics[7].rounds[0].conclusion = "New conclusion";
      chatPaintMeetingSummary();
    });
    assert.equal(await page.evaluate(() => document.activeElement === liveButton && liveTopic.isConnected && !liveTopic.open), true);
    assert.equal(await page.evaluate(() => getSelection().toString()), "Problem");
    assert.match(await page.locator(".chat-meeting-adjourn").getAttribute("onclick"), /'live',2/);
    assert.match(await page.locator("#chat-meeting-document").innerText(), /New conclusion/);
    assert.deepEqual(await page.evaluate(() => [document.getElementById("chat-meeting-document").scrollTop,
      document.getElementById("chat-meeting-document").scrollLeft,liveBody.querySelector(".chat-meeting-list").scrollTop]), [320,25,160]);
    await page.evaluate(() => {
      const current = chat.active.meetings.current;
      current.topics.unshift({...current.topics[1],id:"new-topic",title:"New topic"});
      chat.active.meetings.history.unshift({...chat.active.meetings.history[0],id:"new-archive"});
      chatPaintMeetingSummary();
    });
    assert.equal(await page.evaluate(() => liveTopic.isConnected && !liveTopic.open && document.activeElement === liveButton
      && document.querySelector(".chat-meeting-trash").open),true,"inserting keyed topics/history keeps existing controls and disclosures");
    await page.evaluate(() => {
      document.getElementById("outside").focus();
      chat.active.meetings.current.revision++;
      chatPaintMeetingSummary();
    });
    assert.equal(await page.locator("#outside").evaluate(node => document.activeElement === node), true, "background updates never steal outside focus");
    await page.evaluate(() => {
      chatSelectMeetingSummary("archive-3");
      chat.active.meetings.current.revision++;
      chatPaintMeetingSummary();
      chatToggleMeetingSummary(false); chatToggleMeetingSummary(true);
    });
    assert.match(await page.locator("#chat-meeting-document h2").innerText(), /Archived 3/);
    assert.equal(await page.locator(".chat-meeting-adjourn").count(), 0);
    await page.evaluate(() => {
      chat.activeKey = "room-b";
      chat.active.meetings = { current:null, history:[], trash:[] };
      chatPaintMeetingSummary();
    });
    assert.match(await page.locator("#chat-meeting-document").innerText(), /No Meeting yet/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
