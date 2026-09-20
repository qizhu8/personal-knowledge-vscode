#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const panelJs = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
const panelCss = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.css"), "utf8");
const extensionTs = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
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
assert.match(panelJs, /id="chat-add-agent-btn"[^>]*data-pending-label="Detecting models…"[^>]*onclick="ask\('chatAddManagedAgent',\{\},this\)"/,
  "+ Agent must enter a visible pending state in the same click frame");
assert.match(panelJs, /chatAddManagedAgent:180000/,
  "managed-Agent discovery must have an explicit timeout and pending lifecycle");
assert.match(panelJs, /command === 'chatAddManagedAgentProgress'/);
assert.match(panelJs, /command === 'chatAddManagedAgentResult'[\s\S]{0,180}finishAction\('chatAddManagedAgent'\)/);
assert.match(extensionTs, /case "chatAddManagedAgent"[\s\S]{0,300}chatAddManagedAgentProgress[\s\S]{0,500}chatAddManagedAgentResult/,
  "the Extension must report model detection progress and always complete the pending action");
assert(!extensionTs.includes("Role and background for ${name}"),
  "adding a managed Agent should not ask for a role");
assert.match(extensionTs, /const target = agent\.client\.participantId[\s\S]{0,160}`participant:\$\{agent\.client\.participantId\}`/,
  "managed Agent removal must target the approved participant identity on the first click");
assert.match(extensionTs, /room\?\.selfHost\) room\.client\.sendAdmin\("kick", target\);[\s\S]{0,100}agent\.client\.disconnect\(\)/,
  "managed Agent removal must always stop its local client after requesting durable Room removal");
assert.match(extensionTs, /interface ManagedChatAgent \{[\s\S]{0,120}icon: string;/,
  "managed Agents must carry an editable profile icon");
assert.match(extensionTs, /Profile icon for managed agent[\s\S]{0,900}editManagedAgent\(id, name, role, icon\)/,
  "managed Agent editing must persist the chosen profile icon");
assert.match(panelJs, /chat-avatar">\$\{esc\(agent\.icon \|\| '🤖'\)\}/,
  "managed Agent rows must render their selected profile icon");
assert.match(panelJs, /agent\.busy \|\| detail\.startsWith\('queued'\) \? 'thinking' : agent\.active \? 'standby' : 'idle'/,
  "managed Agent rows must use the shared runtime-state model");
assert.doesNotMatch(panelJs, /agent\.busy \? `⚙️/,
  "managed Agent working state must not use the legacy gear label");

for (const name of ["toggleMainSidebar", "applyMainSidebarState", "renderEmptyDetail", "refreshEmptyDetailHint", "chatToggleHubPanel", "chatApplyHubPanelState", "chatToggleMemberPane", "chatApplyMemberPaneState", "chatTrackScroll", "chatPinLatest", "chatScrollLatest", "chatIsNearBottom", "chatCaptureScrollAnchor", "chatRestoreScrollAnchor", "chatPreserveReadingLayout", "chatCaptureDraft", "chatRestoreDraft", "chatPaintQuote", "chatPaintMode", "chatMeetingSummaryHtml", "chatHistoricalMeetingSummaryHtml", "chatSelectMeetingSummary", "chatPaintMeetingSummary", "chatToggleMeetingSummary"]) {
  assert(panelJs.includes(`function ${name}`), `missing ${name}`);
}
assert(panelJs.includes("function chatResizeInput(input)"));
assert(panelJs.includes("position: 'fixed', left: '-10000px'"));
assert(panelJs.includes("chatInputMeasure.rows = 1"));
assert(panelJs.includes("if (Math.abs(input.getBoundingClientRect().height - height) >= 1)"));
assert(panelJs.includes("const bottomGap = log ? Math.max(0, log.scrollHeight - log.scrollTop - log.clientHeight) : 0"));
assert(panelJs.includes("log.scrollTop = Math.max(0, log.scrollHeight - log.clientHeight - bottomGap)"));
const chatBodyInputSource = panelJs.match(/function chatBodyInput\(\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
assert.doesNotMatch(chatBodyInputSource, /style\.height = 'auto'/);
assert.match(panelHtml, /id="layout-resizer"[^>]*><button id="sidebar-toggle"/);
assert(panelHtml.includes('>◀</button>'));
assert(panelJs.includes("pk-main-sidebar-collapsed"));
assert(panelJs.includes("collapsed ? '▶' : '◀'"));
assert(panelJs.includes("pk-chat-side-collapsed"));
assert(panelJs.includes("pk-chat-rail-collapsed"));
assert(panelCss.includes("#layout.main-sidebar-collapsed #sidebar"));
assert(panelJs.includes("t('content.selectItem')"));
assert(panelJs.includes("t('content.restoreSidebar')"));
assert(panelJs.includes("refreshEmptyDetailHint();\n  translateUi();"));
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
assert(panelJs.includes("chat.followLatest = chatIsNearBottom(log)"));
assert.doesNotMatch(panelJs, /const shouldFollow = chat\.followLatest && chatIsNearBottom\(log\)/);
assert(panelJs.includes("void renderDone.finally(() => chatScrollLatest(log))"));
assert(panelJs.includes("Show the latest message and keep following new messages"));
assert.doesNotMatch(panelJs, /function chatSetTurn\(/);
assert.doesNotMatch(panelHtml, /id="chat-turn-banner"/);
assert.match(panelJs, /function chatSend\(\)[\s\S]{0,1400}chatPreserveReadingLayout/);
assert.match(panelJs, /drafts: \{\}/);
assert.match(panelJs, /state\.tab === 'chatroom' && t\.dataset\.tab !== 'chatroom'\) chatCaptureDraft\(\)/,
  "leaving Chatroom must capture the composer before its DOM is replaced");
assert.match(panelJs, /function renderChatroom\(\)[\s\S]*?chatRestoreDraft\(\);\n\}/,
  "re-entering Chatroom must restore the active Room draft");
assert.match(panelJs, /function chatCaptureDraft[\s\S]{0,700}manualRecipients[\s\S]{0,250}removedRecipients[\s\S]{0,250}quote/);
assert.match(panelJs, /recipientText: recipientInput \? recipientInput\.value/);
assert.match(panelJs, /selectionStart: input \? input\.selectionStart/);
assert.match(panelJs, /input\.selectionStart = Math\.min\(draft\.selectionStart/);
assert.match(panelJs, /function chatSend\(\)[\s\S]{0,1400}delete chat\.drafts\[chatDraftKey\(\)\]/,
  "sending must clear the submitted Room draft");
assert(panelJs.includes("chat-jump-latest"));
assert.match(panelJs, /id="chat-meeting-summary-btn"[^>]*onclick="chatToggleMeetingSummary\(\)"/);
assert.match(panelJs, /id="chat-meeting-summary" class="chat-meeting-summary hidden"/);
assert(panelJs.includes("function chatMeetingTopicHtml(topic, activeTopicId, depth = 0)"));
assert(panelCss.includes(".chat-meeting-summary{position:absolute;inset:0"));
assert(panelCss.includes(".chat-meeting-subtopics"));
assert(panelJs.includes("chat.active?.meetings || { current: null, history: [] }"));
assert(panelJs.includes("function chatStartMeeting()"));
assert(panelJs.includes("command:'chatMeetingStart'"));
assert(panelJs.includes("function chatAdjournMeeting(meetingId, expectedRevision)"));
assert(panelJs.includes("command:'chatMeetingAdjourn'"));
assert(panelJs.includes("function chatMeetingContextMenu(event, meetingId)"));
assert(panelJs.includes('id="chat-discussion-lead"'));
assert(panelJs.includes("discussionLead: chatSelectedDiscussionLead()") || panelJs.includes("discussionLead, replyToMessageId"));
assert(extensionTs.includes("lead: trigger.discussionLead || room.user"));
assert(extensionTs.includes("private async updateMeetingFromMessage(room: RoomConn, message: ChatMessage)"));
assert(extensionTs.includes('requestId: `auto-start:${message.id}`'));
assert(extensionTs.includes("await this.meetingStore.recordDiscussionMessage"));
assert(extensionTs.includes("void this.updateMeetingFromMessage(rc, m)"));
assert(extensionTs.includes("private async syncMeetingFromHistory(room: RoomConn)"));
assert(extensionTs.includes("requestId: `history-start:${trigger.id}`"));
assert(extensionTs.includes("if (rc!.selfHost) void this.syncMeetingFromHistory(rc!)"));
assert(panelJs.includes("command:'chatMeetingTrash'"));
assert(panelJs.includes("function chatRestoreMeeting(meetingId, expectedRevision)"));
assert(panelJs.includes("command:'chatMeetingRestore'"));
assert(panelJs.includes("function chatDeleteMeeting(meetingId, expectedRevision)"));
assert(panelJs.includes("command:'chatMeetingDelete'"));
assert(panelJs.includes("command:'chatMeetingOpenNote'"));
assert(panelJs.includes("Open detailed Note"));
for (const label of ["Participants", "Lead", "Recorder", "Started", "Ended"]) assert(panelJs.includes(label));
assert(panelJs.includes("Send a Discuss message to start a continuously updated Meeting Summary"));
assert(panelCss.includes(".chat-meeting-trash"));
assert(panelCss.includes(".chat-meeting-minutes-meta"));
assert.doesNotMatch(panelJs, /Managed Agent reconnect reliability|Recipient routing reliability/,
  "Meeting Summary must not ship preview fixtures");
assert(panelJs.includes("meetingSummarySelections: {}"));
assert(panelJs.includes("chat.meetingSummarySelections[chat.activeKey || ''] = meetingId"));
assert(panelCss.includes(".chat-meeting-list"));
assert.match(panelJs, /chatCopyInvite',\{roomId:/);
assert.match(panelJs, /chatRotateSecret',\{roomId:/);
const extensionSource = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
assert.match(extensionSource, /hasKey: this\.hostedKeys\.has\(r\.roomId\)/,
  "Rooms on my hub must reveal Magic Link actions from the UUID-keyed Host secret");
assert.doesNotMatch(extensionSource, /hasKey: this\.hostedKeys\.has\(r\.room\)/);
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
