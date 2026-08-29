#!/usr/bin/env node
const assert = require("assert");
const vm = require("vm");
const { browserViewHtml } = require("../dist/chatroom-browser");

const html = browserViewHtml();
const match = html.match(/function browserRecipientNames\(text\)\{[\s\S]*?\n  \}/);
assert(match, "browser recipient parser must be present");
const context = { roster: [], me: "", String };
vm.createContext(context);
new vm.Script(`${match[0]}; this.recipients = browserRecipientNames;`).runInContext(context);

context.me = "Browser Guest";
context.roster = [
  { user: "Room Host", host: true, present: true },
  { user: "Browser Guest", present: true },
  { user: "Amy", present: true },
  { user: "Agent A", present: true },
  { user: "Offline Agent", present: false },
];
assert.deepStrictEqual(Array.from(context.recipients('@"Agent A" task for you; @"Offline Agent" review later')), ["Agent A", "Offline Agent"]);
assert.deepStrictEqual(Array.from(context.recipients("Context @Amy")), ["Amy"]);
assert.deepStrictEqual(Array.from(context.recipients("Context @Agent A")), [], "spaced aliases must remain quoted");
assert.deepStrictEqual(Array.from(context.recipients("literal @unknown")), []);
assert.deepStrictEqual(Array.from(context.recipients("@all forbidden for guests")), []);

context.me = "Room Host";
assert.deepStrictEqual(Array.from(context.recipients("@all broadcast")), ["all"]);
assert.match(html, /text:v,kind:"browser",recipients:recipients/);
assert.doesNotMatch(html, /v=\(quoted\?/);
assert.match(html, /var recipients=v\.charAt\(0\)==="\/"\?\[\]:browserRecipientNames\(v\)/);

console.log("chat browser UI test: body preservation, full-message recipients, offline aliases, and host-only @all OK");