#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const panel = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.css"), "utf8");
const start = panel.indexOf("function mergeBrokerShares(");
const end = panel.indexOf("function appendPrivacyMenu(", start);
assert(start >= 0 && end > start, "Broker marker UI helpers must be bundled");
const markerStyle = styles.match(/\.content-broker-cloud\{([^}]+)\}/)?.[1] || "";
assert.match(markerStyle, /border:0/, "Broker cloud must remain borderless");
assert.match(markerStyle, /background:transparent/, "Broker cloud must not use a badge background");
assert.match(markerStyle, /color:var\(--muted\)/, "Broker cloud must use the subdued UI color");
assert.match(markerStyle, /opacity:\.62/, "Broker cloud must remain visually secondary");

const context = {
  Map,
  state: { brokerSharedFolders: {} },
  esc: value => String(value).replace(/&/g, "&amp;").replace(/\"/g, "&quot;"),
  uiIcon: name => `<span class="codicon codicon-${name}"></span>`,
};
vm.createContext(context);
new vm.Script(`${panel.slice(start, end)};this.marker=brokerShareMarker;this.folderMarker=brokerFolderMarker;`).runInContext(context);

const active = { id: "a", name: "Active Broker", published: true };
const paused = { id: "p", name: "Paused Broker", published: false };
const marker = context.marker([active, paused, active]);
assert.match(marker, /content-broker-cloud/);
assert.match(marker, /codicon-cloud/);
assert.match(marker, /<small>2<\/small>/, "multiple Brokers must show a compact count");
assert.match(marker, /Paused Broker \(paused\)/);
assert.match(marker, /Subscribers may retain previously synchronized copies/);
assert.doesNotMatch(marker, /content-broker-cloud paused/, "an active Broker keeps the marker active even when another is paused");
assert.strictEqual(context.marker([]), "");

context.state.brokerSharedFolders.Team = { brokers: [paused] };
assert.match(context.folderMarker("Team"), /content-broker-cloud paused/, "paused-only folders remain visibly marked");

console.log("broker share marker UI test: cloud, multi-Broker count, folder state, and paused warning OK");