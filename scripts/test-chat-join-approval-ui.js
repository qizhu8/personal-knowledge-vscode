#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const panelJs = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
const match = panelJs.match(/function chatPaintPendingJoins\(\)\s*\{[\s\S]*?\n\}\n\nfunction chatPaintRecents/);
assert(match, "chatPaintPendingJoins must be present in the bundled panel script");
const functionSource = match[0].replace(/\n\nfunction chatPaintRecents$/, "");

function element() {
  const value = { innerHTML: "", hidden: false };
  value.classList = { toggle(_name, hidden) { value.hidden = hidden; } };
  return value;
}

const wrap = element(), box = element();
const context = {
  chat: { pendingApprovals: [] },
  document: { getElementById: id => id === "chat-pending-wrap" ? wrap : id === "chat-pending-joins" ? box : null },
  esc: value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;").replace(/"/g, "&quot;"),
  Date,
};
vm.createContext(context);
new vm.Script(`${functionSource}; this.paint = chatPaintPendingJoins;`).runInContext(context);

context.paint();
assert.strictEqual(wrap.hidden, true);

context.chat.pendingApprovals = [{
  requestId: "request-'unsafe", alias: "Agent <One>", kind: "agent",
  expiresAt: Date.now() + 60_000,
  reusableParticipants: [],
}];
context.paint();
assert.strictEqual(wrap.hidden, false);
assert.match(box.innerHTML, /Agent &lt;One&gt;/);
assert.match(box.innerHTML, /chatApproveJoinNew/);
assert.match(box.innerHTML, /chatRejectJoin/);
assert.match(box.innerHTML, /Reuse<\/button>/);
assert.match(box.innerHTML, /disabled/);
assert.doesNotMatch(box.innerHTML, /request-'unsafe/);

context.chat.pendingApprovals[0].reusableParticipants = [{ participantId: "participant-1", previousAlias: "Old", kind: "agent" }];
context.paint();
assert.match(box.innerHTML, /chatApproveJoinReuse/);
assert.match(box.innerHTML, /1 offline identity option/);
console.log("join approval UI test: empty, escaped alias, New, Reuse, Reject, and disabled states OK");