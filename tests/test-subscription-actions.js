#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const panel = fs.readFileSync(path.join(root, "dist", "webview", "panel.js"), "utf8");
const source = fs.readFileSync(path.join(root, "src", "webview", "panel", "45-subscriptions.js"), "utf8");
const core = fs.readFileSync(path.join(root, "src", "webview", "panel", "00-core.js"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");

function functionSource(name) {
  const match = new RegExp(`^function ${name}\\([^\\n]+$`, "m").exec(panel);
  assert(match, `missing executable Subscription action: ${name}`);
  return match[0];
}

const calls = [];
const context = vm.createContext({ ask: (command, payload, button) => calls.push({ command, payload, button }) });
new vm.Script(`${functionSource("subscriptionDeleteShare")};${functionSource("subscriptionSetSharePublished")};this.remove=subscriptionDeleteShare;this.publish=subscriptionSetSharePublished;`).runInContext(context);
const button = { id: "delete-button" };
context.remove("share-id", button);
context.publish("share-id", false);
assert.strictEqual(JSON.stringify(calls), JSON.stringify([
  { command: "subscriptionDeleteShare", payload: { shareId: "share-id" }, button },
  { command: "subscriptionSetSharePublished", payload: { shareId: "share-id", published: false } },
]));

const inlineHandlers = [...source.matchAll(/on(?:click|change|keydown)="([^"]+)"/g)]
  .flatMap(match => [...match[1].matchAll(/\b(subscription[A-Z][A-Za-z0-9_]*)\s*\(/g)].map(item => item[1]));
for (const name of new Set(inlineHandlers)) {
  assert(new RegExp(`function ${name}\\s*\\(`).test(source), `inline Subscription action has no function: ${name}`);
}
for (const command of ["subscriptionDeleteShare", "subscriptionSetSharePublished"]) {
  assert(extension.includes(`case "${command}"`), `${command} has no Extension handler`);
}
assert.match(extension, /case "subscriptionDeleteShare"[\s\S]{0,1000}showWarningMessage\([\s\S]{0,400}"Delete Broker"/,
  "Delete must use a visible native confirmation");
assert.match(extension, /brokerDeleteCancelled/, "cancel must produce a completion response");
assert.match(core, /brokerDeleted:'subscriptionDeleteShare', brokerDeleteCancelled:'subscriptionDeleteShare'/,
  "confirm and cancel must both restore the pending Delete button");
assert.match(core, /brokerPaused:'subscriptionSetSharePublished', brokerPublished:'subscriptionSetSharePublished'/,
  "pause and resume must both restore the pending Publish control");
assert.doesNotMatch(source, /subscriptionDeleteShare\([^)]*share\.name/,
  "Broker display names must never be embedded in Delete JavaScript");

console.log(`subscription action test: executed destructive/toggle dispatch and validated ${new Set(inlineHandlers).size} inline handlers plus completion recovery OK`);
