const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");

test("Chatroom clipboard images stay local until Send, retain failed drafts and render received previews", async () => {
  const browser = await chromium.launch({ headless:true,
    ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath:process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const root = path.resolve(__dirname, "..");
    const panel = fs.readFileSync(path.join(root,"dist/webview/panel.js"),"utf8");
    const source = fs.readFileSync(path.join(root,"src/webview/panel/10-chatroom.js"),"utf8");
    assert(panel.includes(source));
    await page.setContent(`<textarea id="chat-input"></textarea><button id="chat-send-btn" onclick="chatSend()">Send</button>
      <div id="chat-image-drafts"></div><div id="chat-image-status"></div><div id="chat-log"></div>`);
    await page.addStyleTag({path:path.join(root,"dist/webview/panel.css")});
    await page.addScriptTag({content:`${panel.match(/^const esc = .*$/m)[0]}\n${panel.match(/^const uiIcon = .*$/m)[0]}
      const requests=[];const vscode={postMessage:message=>requests.push(message)};
      function ask(command,payload){vscode.postMessage({command,...payload})}`});
    await page.addScriptTag({content:source});
    await page.evaluate(() => {
      chat.activeKey = "a"; chat.active = {status:"connected",selfHost:false,members:[]}; chat.followLatest = false;
      chatPaintActive = () => { document.getElementById("chat-send-btn").disabled = !!chat.imageSends[chat.activeKey]; };
      chatStructuredReceipt = () => undefined;
      chatComposerRecipientNames = () => [];
      chatPreserveReadingLayout = callback => callback();
      chatUpdateDefaultRecipient = chatClearQuote = chatHideMentionPop = () => {};
      const input = document.getElementById("chat-input");
      input.addEventListener("paste",chatPasteImages); input.addEventListener("keydown",chatInputKeydown);
      window.paste = (mime = "image/png", size = 0) => {
        const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="),char => char.charCodeAt(0));
        const transfer = new DataTransfer(); transfer.items.add(new File([size ? new Uint8Array(size) : bytes],"clipboard.png",{type:mime}));
        return input.dispatchEvent(new ClipboardEvent("paste",{clipboardData:transfer,bubbles:true,cancelable:true}));
      };
      const transfer = new DataTransfer(); transfer.setData("text/plain","Ordinary text");
      window.textPasteDefault = input.dispatchEvent(new ClipboardEvent("paste",{clipboardData:transfer,bubbles:true,cancelable:true}));
      paste();
    });
    await page.waitForFunction(() => chat.imageDrafts.a?.length === 1);
    await page.waitForFunction(() => document.querySelector("#chat-image-drafts img")?.naturalWidth === 1);
    assert.equal(await page.evaluate(() => requests.length),0,"paste must not publish files");
    assert.equal(await page.evaluate(() => textPasteDefault),true,"ordinary text paste retains native browser behavior");
    await page.getByRole("button",{name:"Remove pasted image 1"}).click();
    assert.equal(await page.locator("#chat-image-drafts img").count(),0);
    await page.evaluate(() => paste("image/svg+xml"));
    await page.waitForFunction(() => document.getElementById("chat-image-status").textContent.includes("PNG"));
    await page.evaluate(() => paste("image/png",5*1024*1024+1));
    await page.waitForFunction(() => document.getElementById("chat-image-status").textContent.includes("5 MB"));
    await page.evaluate(() => paste());
    await page.waitForFunction(() => chat.imageDrafts.a?.length === 1);
    await page.locator("#chat-input").fill("Review this screenshot");
    await page.locator("#chat-input").press("Enter");
    assert.equal(await page.evaluate(() => requests.length),1);
    assert.equal(await page.evaluate(() => requests[0].images.length),1);
    assert.equal(await page.evaluate(() => requests[0].key),"a");
    assert.equal(await page.locator("#chat-input").inputValue(),"Review this screenshot","retain text pending Host response");
    await page.evaluate(() => chatOnSendImagesResult({...requests[0],ok:false,error:"Disconnected"}));
    assert.equal(await page.locator("#chat-input").inputValue(),"Review this screenshot");
    assert.equal(await page.locator("#chat-image-drafts img").count(),1);
    assert.match(await page.locator("#chat-image-status").innerText(),/Disconnected/);
    await page.getByRole("button",{name:"Send",exact:true}).click();
    await page.evaluate(() => chatOnSendImagesResult({...requests[1],ok:true}));
    assert.equal(await page.locator("#chat-input").inputValue(),"");
    assert.equal(await page.locator("#chat-image-drafts img").count(),0);
    await page.evaluate(() => paste());
    await page.waitForFunction(() => chat.imageDrafts.a?.length === 1);
    await page.getByRole("button",{name:"Send",exact:true}).click();
    assert.equal(await page.evaluate(() => requests[2].text),"","image-only messages are supported");
    await page.evaluate(() => {
      chat.activeKey = "b";
      document.getElementById("chat-input").value = "Other room draft";
      chatPaintImageDrafts();
      chatOnSendImagesResult({...requests[2],ok:true});
    });
    assert.equal(await page.locator("#chat-input").inputValue(),"Other room draft");
    assert.equal(await page.evaluate(() => chat.imageDrafts.a.length),0,"reply is applied only to the originating Room");
    await page.evaluate(() => {
      const file = {key:"b",fileId:"f1",name:"Clipboard screenshot",from:"Host",size:68,mime:"image/png"};
      chatAppendFileRow("b",file); chatAppendFileRow("b",file);
    });
    assert.equal(await page.locator(".chat-file").count(),1,"live events and snapshots do not duplicate attachments");
    const previewRequest = await page.evaluate(() => requests.at(-1));
    assert.equal(previewRequest.command,"chatImagePreview");
    await page.evaluate(() => chatOnImagePreview({
      key:"b",fileId:"f1",src:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    }));
    await page.waitForFunction(() => document.querySelector(".chat-file-image")?.naturalWidth === 1);
    await page.evaluate(() => {
      document.getElementById("chat-log").replaceChildren();
      chatAppendFileRow("b",{fileId:"f1",name:"Screenshot",from:"Host",size:68,mime:"image/png"});
    });
    assert.equal(await page.locator(".chat-file-image").count(),1,"cached previews survive snapshot repaint without another binary request");
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
