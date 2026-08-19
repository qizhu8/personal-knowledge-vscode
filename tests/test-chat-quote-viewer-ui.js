#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const panelJs = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
const panelCss = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.css"), "utf8");

for (const functionName of [
  "chatQuoteMessage", "chatClearQuote", "chatJumpToMessage", "chatOpenMessageViewer",
  "chatCloseMessageViewer", "chatToggleViewerFullscreen", "chatCopyViewedMessage",
  "chatMessageMenu",
]) {
  assert(panelJs.includes(`function ${functionName}`), `missing ${functionName}`);
}
assert(panelJs.includes("replyToMessageId: chat.quote?.id || ''"));
assert(panelJs.includes("m.replyToMessageId ?"));
assert(panelJs.includes("Quote this message"));
assert(panelJs.includes("{ label: 'Quote', onClick: () => chatQuoteMessage(messageId) }"));
assert(panelJs.includes("{ label: 'Open in viewer', onClick: () => chatOpenMessageViewer(messageId) }"));
assert(panelJs.includes("{ label: 'Copy text'"));
assert(panelJs.includes("addEventListener('contextmenu', event => chatMessageMenu(event, m.id))"));
assert(panelJs.includes("Open this message in a larger resizable viewer"));
assert(panelJs.includes("event.key === 'Escape'"));
assert(panelJs.includes("chatRenderMarkdown(body, message.text)"));
assert(panelJs.includes("navigator.clipboard.writeText"));
assert(panelCss.includes(".chat-message-viewer-panel"));
assert(panelCss.includes("resize:both"));
assert(panelCss.includes(".chat-message-viewer.fullscreen"));
assert(panelCss.includes(".chat-quote-bar"));
assert(panelCss.includes(".chat-message-focus"));

console.log("chat quote/viewer UI test: durable quote metadata, jump-back, Markdown viewer, resize, fullscreen, copy, and Esc close OK");
