#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const panelJs = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
const panelCss = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.css"), "utf8");
const match = panelJs.match(/function chatParseMentions\(text\)\s*\{[\s\S]*?function chatCollapseFullAudience\(names\)\s*\{[\s\S]*?\n\}/);
assert(match, "Chatroom recipient materializer must be present in the bundled panel script");

const context = { chat: { active: null, manualRecipients: [], bodyRecipients: [], removedRecipients: [] }, String };
vm.createContext(context);
new vm.Script(`${match[0]}; this.materialize = chatMaterializeRecipient; this.structured = chatStructuredRecipientNames; this.syncBody = chatSyncBodyRecipients; this.recipients = chatComposerRecipientNames; this.extractLeading = chatExtractLeadingRecipients;`).runInContext(context);

context.chat.active = { selfHost: true, self: "Host", members: [{ user: "Host", host: true, present: true }], messages: [] };
assert.strictEqual(context.materialize("broadcast"), "broadcast");
assert.deepStrictEqual(Array.from(context.recipients("broadcast")), ["all"]);

context.chat.active = { selfHost: true, self: "Host", members: [
	{ user: "Host", host: true, present: true }, { user: "Agent A", present: true },
	{ user: "Agent B", present: true }, { user: "Gone Agent", present: false },
], messages: [{ from: "Host", text: '@"Agent A" @"Agent B" @"Gone Agent" discuss' }] };
assert.strictEqual(context.materialize("continue"), "continue");
assert.deepStrictEqual(Array.from(context.recipients("continue")), ["Agent A", "Agent B"],
	"carrying only the previous online audience must not collapse to @all while another member remains in the roster");
assert.strictEqual(context.materialize('@"Agent B" explicit'), '@"Agent B" explicit',
	"authored body must remain unchanged");
assert.deepStrictEqual(Array.from(context.recipients('@"Agent B" explicit')), ["Agent A", "Agent B"],
	"new mentions must be added to the inherited audience rather than replacing it");
assert.deepStrictEqual(Array.from(context.recipients("@Someone unknown")), ["Agent A", "Agent B"],
	"an unknown mention must not suppress inferred To recipients");
assert.deepStrictEqual(Array.from(context.recipients("discuss @Agent B inline")), ["Agent A", "Agent B"]);
assert.deepStrictEqual(Array.from(context.recipients("```\n@Agent B\n```")), ["Agent A", "Agent B"]);
assert.deepStrictEqual(Array.from(context.structured('@Host report\n\n@"Agent A" @"Agent B" review')), ["Host", "Agent A", "Agent B"]);
assert.deepStrictEqual(Array.from(context.structured('@Host report `@"Agent B"`\n```\n@"Agent A"\n```')), ["Host", "Agent B", "Agent A"],
	"all valid mentions anywhere in the message must become recipients");

context.chat.active = { selfHost: false, members: [{ user: "Room Host", host: true, present: true }, { user: "Guest", present: true }] };
context.chat.manualRecipients = [];
assert.strictEqual(context.materialize("reply"), "reply");
assert.deepStrictEqual(Array.from(context.recipients("reply")), ["Room Host"]);
assert.strictEqual(context.materialize('@"Room Host" explicit'), '@"Room Host" explicit');
assert.strictEqual(context.materialize("/help"), "/help");
context.chat.active = { selfHost: true, self: "Host", members: [{ user: "Host", host: true, present: true }, { user: "Agent A", present: true }, { user: "Agent B", present: true }], messages: [] };
context.chat.manualRecipients = ["Agent A"];
assert.deepStrictEqual(Array.from(context.recipients('@"Agent B" @"Agent B" review')), ["all"],
	"manual To recipients and body mentions must merge and normalize a complete Host audience to @all");

context.chat.active = { selfHost: true, self: "Host", members: [
	{ user: "Host", host: true, present: true }, { user: "Agent A", present: true },
	{ user: "Agent B", present: true }, { user: "Agent C", present: true }, { user: "Gone Agent", present: false },
], messages: [{ from: "Host", text: '@"Agent A" @"Agent B" @"Gone Agent" previous' }] };
context.chat.manualRecipients = [];
context.chat.removedRecipients = [];
assert.deepStrictEqual(Array.from(context.recipients('@"Agent C" new')), ["Agent A", "Agent B", "Agent C"],
	"To must inherit the previous live audience and add new mentions without treating an offline roster member as removed");
assert.deepStrictEqual(Array.from(context.recipients("new")), ["Agent A", "Agent B"],
	"deleting a body mention must remove mention-only Agent C while inherited recipients remain");
assert.deepStrictEqual(Array.from(context.structured('notify @"Gone Agent"')), ["Gone Agent"],
	"an offline participant must remain explicitly mentionable while present in the roster");
context.chat.removedRecipients = ["Agent B"];
assert.deepStrictEqual(Array.from(context.recipients('@"Agent B" new')), ["Agent A"],
	"an explicitly removed inherited recipient must remain suppressed for this draft even if its mention remains in the body");

context.chat.active = { selfHost: true, self: "Host", members: [
	{ user: "Host", host: true, present: true }, { user: "Agent A", present: true }, { user: "Agent B", present: true },
], messages: [{ from: "Host", text: "## Markdown body", recipients: ["Agent A", "Agent B"] }] };
context.chat.manualRecipients = [];
context.chat.removedRecipients = [];
assert.deepStrictEqual(Array.from(context.recipients("## Next report")), ["all"],
	"To inheritance must use structured metadata when the prior Markdown body has no recipient prefix");
assert.strictEqual(context.materialize("## Next report"), "## Next report");

context.chat.active = { selfHost: true, self: "Host", members: [
	{ user: "Host", host: true, present: true }, { user: "Agent A", present: true },
	{ user: "Agent B", present: true }, { user: "Agent C", present: false },
], messages: [] };
context.chat.manualRecipients = [];
context.chat.removedRecipients = ["all"];
assert.deepStrictEqual(Array.from(context.recipients('@"Agent A" draft')), ["Agent A"]);
assert.deepStrictEqual(Array.from(context.recipients('@"Agent A" @"Agent B" draft')), ["Agent A", "Agent B"]);
assert.deepStrictEqual(Array.from(context.recipients('@"Agent A" @"Agent B" @"Agent C" draft')), ["all"],
	"mentioning every roster participant except the Host must collapse To to @all in real time, including offline members");
assert.deepStrictEqual(Array.from(context.recipients('@"Agent A" @"Agent C" draft')), ["Agent A", "Agent C"],
	"deleting one body mention must immediately expand @all back to the remaining roster recipients");

context.chat.active = { selfHost: false, self: "Guest", members: [
	{ user: "Guest", present: true }, { user: "Agent A", present: true }, { user: "Agent B", present: true },
], messages: [] };
context.chat.removedRecipients = [];
assert.deepStrictEqual(Array.from(context.recipients('@"Agent A" @"Agent B" draft')), ["Agent A", "Agent B"],
	"non-Host clients must not normalize a complete audience to forbidden @all");

context.chat.active = { selfHost: true, self: "Host", members: [
	{ user: "Host", host: true, present: true }, { user: "Agent A", present: true }, { user: "Agent B", present: true },
], messages: [] };
context.chat.manualRecipients = [];
context.chat.removedRecipients = [];
assert.deepStrictEqual(Array.from(context.recipients("draft")), ["all"]);
context.chat.removedRecipients = ["all"];
assert.deepStrictEqual(Array.from(context.recipients("draft")), [], "removing inherited @all must leave this draft with no recipients");
assert.deepStrictEqual(Array.from(context.recipients('@"Agent A" draft')), ["Agent A"],
	"a new body mention must populate the edited empty To list without restoring @all");
let leading = context.extractLeading('@"Agent A" @"Agent B" ## Report');
assert.deepStrictEqual(Array.from(leading.names), ["Agent A", "Agent B"]);
assert.strictEqual(leading.text, "## Report", "valid leading mentions must move to To without occupying Markdown body space");
leading = context.extractLeading('@Unknown ## Report');
assert.deepStrictEqual(Array.from(leading.names), []);
assert.strictEqual(leading.text, '@Unknown ## Report', "unknown @words must remain literal body text");
leading = context.extractLeading('Context for @"Agent A" in the middle');
assert.deepStrictEqual(Array.from(leading.names), []);
assert.strictEqual(leading.text, 'Context for @"Agent A" in the middle', "middle mentions must remain in the body");

context.chat.active = { selfHost: true, self: "Host", members: [
	{ user: "Host", host: true, present: true }, { user: "Amy", present: true },
	{ user: "Asset Dev", present: true }, { user: "Agent With Spaces", present: true }, { user: "Agent With", present: true },
], messages: [] };
context.chat.manualRecipients = [];
context.chat.removedRecipients = ["all"];
leading = context.extractLeading('@"Agent With Spaces" ## Report');
assert.deepStrictEqual(Array.from(leading.names), ["Agent With Spaces"]);
assert.strictEqual(leading.text, "## Report");
assert.deepStrictEqual(Array.from(context.recipients('Context @"Agent With Spaces"')), ["Agent With Spaces"]);
assert.deepStrictEqual(Array.from(context.structured('Context @Amy')), ["Amy"]);
assert.deepStrictEqual(Array.from(context.structured('Context @"Amy"')), ["Amy"]);
assert.deepStrictEqual(Array.from(context.structured('Context @"Asset Dev"')), ["Asset Dev"]);
assert.deepStrictEqual(Array.from(context.structured('Context @Asset Dev')), [],
	"an unquoted spaced alias must not resolve when no participant has the first-word alias");
assert.deepStrictEqual(Array.from(context.recipients('Context @Agent With Spaces')), [],
	"spaced roster aliases must always use quoted mention syntax");

context.chat.active = { selfHost: false, self: "Guest", members: [
	{ user: "Room Host", host: true, present: true }, { user: "Guest", present: true }, { user: "LP Extractor Dev", present: true },
], messages: [] };
context.chat.manualRecipients = [];
context.chat.bodyRecipients = [];
context.chat.removedRecipients = ["LP Extractor Dev"];
let body = "";
for (const character of 'Hi @"LP Extr') {
	body += character;
	context.syncBody(body);
}
assert.deepStrictEqual(Array.from(context.recipients(body)), ["Room Host"],
	"an unfinished quoted alias must not be guessed from a unique prefix");
for (const character of 'actor Dev"  How are you?') {
	body += character;
	context.syncBody(body);
}
assert.deepStrictEqual(Array.from(context.recipients(body)), ["Room Host", "LP Extractor Dev"],
	"autocomplete-style insertion of a complete quoted alias must add it to To immediately");
body = 'Hi @"LP Extractor Dev  How are you?';
context.syncBody(body);
assert.deepStrictEqual(Array.from(context.recipients(body)), ["Room Host"],
	"backspacing the closing quote must immediately remove the incomplete quoted alias from To");
body = "Hi @LP Extractor Dev";
context.syncBody(body);
assert.deepStrictEqual(Array.from(context.recipients(body)), ["Room Host"],
	"a fully typed but unquoted spaced roster alias must remain literal text");
body = "Hi  How are you?";
context.syncBody(body);
assert.deepStrictEqual(Array.from(context.recipients(body)), ["Room Host"],
	"deleting the quoted body mention must immediately remove its mention-only To token");
body = 'Hi @"LP Extractor Dev"  How are you?';
context.syncBody(body);
assert.deepStrictEqual(Array.from(context.recipients(body)), ["Room Host", "LP Extractor Dev"],
	"retyping a previously removed body mention must reactivate its To token");

assert.match(panelJs, /title="Notify the selected recipients without requesting an acknowledgement or reply\."/);
assert.match(panelJs, /title="Ask each selected recipient for one required response\."/);
assert.match(panelJs, /title="Invite the selected recipients into a shared peer discussion\."/);

const modeMatch = panelJs.match(/function chatSetMode\(mode\)\s*\{[\s\S]*?\n\}/);
assert(modeMatch, "chatSetMode must be present in the bundled panel script");
const buttons = ["announce", "ask", "discuss"].map(mode => ({
	dataset: { mode }, active: false,
	classList: { toggle(_name, active) { this.owner.active = active; }, owner: null },
}));
buttons.forEach(button => { button.classList.owner = button; });
const notice = {
	textContent: "", hidden: true,
	classList: {
		remove(name) { if (name === "hidden") notice.hidden = false; },
		add(name) { if (name === "hidden") notice.hidden = true; },
	},
};
let hideNotice;
const modeContext = {
	chat: { mode: "ask", modeNoticeTimer: null },
	document: {
		querySelectorAll: selector => selector === "#chat-mode-control button" ? buttons : [],
		getElementById: id => id === "chat-mode-notice" ? notice : null,
	},
	setTimeout: callback => { hideNotice = callback; return 1; },
	clearTimeout: () => {},
};
vm.createContext(modeContext);
new vm.Script(`${modeMatch[0]}; this.setMode = chatSetMode;`).runInContext(modeContext);
modeContext.setMode("announce");
assert.strictEqual(modeContext.chat.mode, "announce");
assert.strictEqual(buttons.find(button => button.dataset.mode === "announce").active, true);
assert.match(notice.textContent, /no acknowledgement or reply is requested/);
assert.strictEqual(notice.hidden, false);
hideNotice();
assert.strictEqual(notice.hidden, true);
modeContext.setMode("discuss");
assert.match(notice.textContent, /shared peer discussion/);
assert.doesNotMatch(panelJs, /input\.style\.paddingLeft/);
assert.match(panelJs, /id="chat-composer"/);
assert.match(panelJs, /id="chat-recipient-row"/);
assert.match(panelJs, /id="chat-recipient-chips"/);
assert.match(panelJs, /id="chat-recipient-input"/);
assert.doesNotMatch(panelJs, /id="chat-at-btn"/);
assert.match(panelJs, /function chatRecipientInputKeydown/);
assert.match(panelJs, /function chatExtractLeadingRecipients/);
assert.match(panelJs, /event\.key === 'ArrowLeft'/);
assert.match(panelJs, /event\.key === 'ArrowRight'/);
assert.match(panelJs, /event\.key === 'Backspace' \|\| event\.key === 'Delete'/);
assert.match(panelJs, /Remove \$\{esc\(name\)\} from this message/);
assert.doesNotMatch(panelJs, /chat\.toEdited/);
assert.match(panelJs, /chat\.removedRecipients = \[\]/);
assert.match(panelJs, /Recipient: \$\{esc\(name\)\} · \$\{esc\(sources\)\}/);
assert.match(panelJs, /function chatCollapseFullAudience/);
assert.match(panelCss, /#chat-composer\{[^}]*border:1px solid var\(--border\)/);
assert.match(panelCss, /#chat-input\{[^}]*border-top:1px solid var\(--border\)/);
assert.match(panelCss, /\.chat-recipient-chip/);
assert.match(panelCss, /\.chat-recipient-chip\.selected/);
assert.match(panelCss, /#chat-recipient-input/);
assert.match(panelJs, /\(message\.recipients \|\| \[\]\)\.length/);

console.log("chat default recipient UI test: unified To composer, manual selection, mention sync, mode tooltips, and switch notices OK");
