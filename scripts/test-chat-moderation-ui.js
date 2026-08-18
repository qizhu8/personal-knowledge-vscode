#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const panelJs = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
assert(panelJs.includes("function chatEnsureControlComments(root)"));
assert(panelJs.includes("Standby: the Agent has an active blocking wait for directed messages."));
assert(panelJs.includes("Working: the Agent is processing a delivered message or task."));
assert(panelJs.includes("In session: the Agent is participating in a coordinated multi-step exchange."));
for (const field of ["Full name:", "Participant ID:", "Connection ID:", "Client identity ID:", "Presence:"]) {
  assert(panelJs.includes(field), `member tooltip must include ${field}`);
}
const match = panelJs.match(/function chatModerate\(action, btn\)\s*\{[\s\S]*?\n\}/);
assert(match, "chatModerate must be present in the bundled panel script");

let posted;
const context = {
  ask(command, data) { posted = { command, data }; },
};
vm.createContext(context);
new vm.Script(`${match[0]}; this.moderate = chatModerate;`).runInContext(context);

const row = {
  dataset: {
    participantId: "participant-123",
    sid: "legacy-cid",
    user: "Agent One",
    role: "Reviewer",
  },
};
context.moderate("edit", { closest: selector => selector === ".chat-member" ? row : null });
assert.deepStrictEqual(JSON.parse(JSON.stringify(posted)), {
  command: "chatModerate",
  data: {
    action: "edit",
    participantId: "participant-123",
    sid: "legacy-cid",
    user: "Agent One",
    role: "Reviewer",
  },
});
console.log("chat moderation UI test: durable identity, status explanations, and hover comments OK");