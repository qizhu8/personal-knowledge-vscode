#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const panelJs = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
const panelCss = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.css"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

assert(manifest.activationEvents.includes("onWebviewPanel:personalKnowledge"),
  "restoring a Personal Knowledge Manager tab must activate the extension before its serializer is needed");
const panelHtml = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.html"), "utf8");

const topbarHtml = panelHtml.slice(panelHtml.indexOf('<div id="topbar">'), panelHtml.indexOf('<div id="mcp-global-warning"'));
const mainHtml = panelHtml.slice(panelHtml.indexOf('<div id="main">'), panelHtml.indexOf('<div id="note-form"'));
assert.doesNotMatch(topbarHtml, /id="searchbox"|id="toolbar"|id="more-wrap"/);
assert.match(mainHtml, /<div id="content-toolbar">[\s\S]*id="searchbox"[\s\S]*id="toolbar"[\s\S]*id="more-wrap"/);
assert(mainHtml.indexOf('id="content-toolbar"') < mainHtml.indexOf('id="detail"'));
assert(panelJs.includes("document.getElementById('content-toolbar')"));
assert(panelJs.includes("actionbar.scrollWidth > actionbar.clientWidth"));
assert(panelJs.includes("document.getElementById('content-toolbar').style.display = fullWidthTab ? 'none' : ''"));
assert(panelCss.includes("#content-toolbar{display:flex"));

for (const name of ["toggleMainSidebar", "applyMainSidebarState", "renderEmptyDetail", "refreshEmptyDetailHint", "chatToggleHubPanel", "chatApplyHubPanelState", "chatToggleMemberPane", "chatApplyMemberPaneState", "chatTrackScroll", "chatPinLatest", "chatIsNearBottom", "chatCaptureScrollAnchor", "chatRestoreScrollAnchor"]) {
  assert(panelJs.includes(`function ${name}`), `missing ${name}`);
}
assert.match(panelHtml, /id="layout-resizer"[^>]*><button id="sidebar-toggle"/);
assert(panelHtml.includes('>◀</button>'));
assert(panelJs.includes("pk-main-sidebar-collapsed"));
assert(panelJs.includes("collapsed ? '▶' : '◀'"));
assert(panelJs.includes("pk-chat-side-collapsed"));
assert(panelJs.includes("pk-chat-rail-collapsed"));
assert(panelCss.includes("#layout.main-sidebar-collapsed #sidebar"));
assert(panelJs.includes("Select an item from the sidebar."));
assert(panelJs.includes("Please click the &gt; button to see the sidebar."));
assert(panelHtml.includes('class="empty empty-select-item"'));
assert(panelCss.includes(".empty-select-hint"));
assert(panelCss.includes("width:14px;height:72px"));
assert(panelCss.includes("position:absolute;top:50%;left:50%"));
assert(panelCss.includes("#chat-body.chat-side-collapsed #chat-side"));
assert.doesNotMatch(panelCss, /chat-side-collapsed #chat-side-resizer\{display:none/);
assert.doesNotMatch(panelCss, /main-sidebar-collapsed #layout-resizer\{display:none/);
assert.doesNotMatch(panelJs, /You host this room/);
assert.match(panelJs, /chat-legend-dot standby/);
assert.match(panelJs, /chat-legend-dot working/);
assert.match(panelJs, /chat-legend-dot engaged/);
assert.match(panelCss, /\.chat-proto-legend\{[^}]*flex-direction:column/);
assert.match(panelJs, /let html = '<div class="chat-proto-legend">/);
const compactRule = panelCss.match(/#chat-body\.chat-side-collapsed \.chat-side-hdr[^}]+/g)?.join("\n") || "";
assert.doesNotMatch(compactRule, /chat-proto-legend|chat-proto(?:,|\{)/);
assert.match(compactRule, /chat-ago/);
assert.match(compactRule, /chat-mod-actions/);
assert(panelCss.includes("#chat-root.chat-rail-collapsed #chat-rail"));
assert.match(panelJs, /id="chat-rail-resizer"[^>]*><button id="chat-rail-toggle"/);
assert.match(panelJs, /id="chat-side-resizer"[^>]*><button id="chat-side-toggle"/);
assert(panelJs.includes("function chatInitMemberResizer"));
assert(panelJs.includes("Math.max(54, Math.min(500"));
assert(panelJs.includes("pk-chat-side-compact"));
assert(panelJs.includes("const collapsed = chatMemberPaneCollapsed();\n  let width = collapsed ? 86 : 170;"));
assert(panelJs.includes('class="chat-avatar"'));
assert(panelJs.includes('class="chat-member-name-text"'));
assert(panelJs.includes("chat.scrollPositions[previousKey] = existingLog.scrollTop"));
assert(panelJs.includes("else chatRestoreScrollAnchor(log, restoreAnchor, restoreTop)"));
assert(panelJs.includes("if (chat.logSnapshotKey === logSnapshotKey)"));
assert(panelJs.includes("chat.scrollAnchors[chat.activeKey] = chatCaptureScrollAnchor(log)"));
assert(panelJs.includes("chat.followLatest && chatIsNearBottom(log)"));
assert(panelJs.includes("chat-jump-latest"));
for (const id of ["search-count", "search-prev", "search-next", "search-case", "search-regex"]) {
  assert(panelHtml.includes(`id="${id}"`), `missing global search control ${id}`);
}
for (const id of ["chat-searchbox", "chat-search-count", "chat-search-case", "chat-search-regex"]) {
  assert(panelJs.includes(`id="${id}"`), `missing Chatroom search control ${id}`);
}
for (const name of ["compileFindPattern", "markFindMatches", "navigateFind", "preservedFindIndex", "toggleFindOption", "chatRefreshSearch", "chatSearchKeydown"]) {
  assert(panelJs.includes(`function ${name}`), `missing search behavior ${name}`);
}
assert(panelJs.includes("new RegExp(source, caseSensitive ? 'g' : 'gi')"));
assert(panelJs.includes("new Set(marks.map(mark => mark.closest('.chat-msg,.chat-sys'))"));
assert(panelJs.includes("chatRefreshSearch(true)"));
assert(panelJs.includes("chatAppend(message, false)"));
assert(panelCss.includes("mark.search-match.search-current"));
assert(panelCss.includes(".chat-msg.search-current"));
assert(panelCss.includes("overflow-anchor:none"));
assert.doesNotMatch(panelJs, /function chatOnFileReady[\s\S]{0,300}scrollTop = log\.scrollHeight/);

const nearBottomSource = panelJs.match(/function chatIsNearBottom\(log\)\s*\{[^}]+\}/);
assert(nearBottomSource);
const context = {};
vm.createContext(context);
new vm.Script(`${nearBottomSource[0]}; this.near = chatIsNearBottom;`).runInContext(context);
assert.strictEqual(context.near({ scrollHeight: 1000, scrollTop: 760, clientHeight: 200 }), true);
assert.strictEqual(context.near({ scrollHeight: 1000, scrollTop: 500, clientHeight: 200 }), false);

const preserveSource = panelJs.match(/function preservedFindIndex\(targets, messageId, previousIndex\)\s*\{[\s\S]*?\n\}/);
assert(preserveSource);
const preserveContext = {};
vm.createContext(preserveContext);
new vm.Script(`${preserveSource[0]}; this.preserve = preservedFindIndex;`).runInContext(preserveContext);
const targets = Array.from({ length: 15 }, (_, index) => ({ dataset: { messageId: `m${index + 1}` } }));
assert.strictEqual(preserveContext.preserve(targets, "m11", 10), 10, "repaint must preserve the current message instead of resetting to result 1");
assert.strictEqual(preserveContext.preserve(targets.slice(0, 8), "missing", 10), 7, "missing results must clamp the previous index");

console.log("Chat layout/scroll UI test: persistent sidebars, history focus, bottom pin, and Jump to latest behavior OK");
