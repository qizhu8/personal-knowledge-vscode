#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { subscriptionNavigationRoot } = require("../dist/navigation-subscriptions.js");

const root = path.join(__dirname, "..");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const webview = fs.readFileSync(path.join(root, "src", "webview", "panel", "00-core.js"), "utf8");
const types = ["skills", "notes", "papers", "prompts", "scripts", "packages", "servers"];

function group(type) {
  const itemPath = type === "packages" ? "asset-tool"
    : type === "servers" ? "sample-api/server.link.json"
    : type === "prompts" ? "Ads/Review/v1/prompt.md"
    : `Team/Nested/Remote ${type.slice(0, -1)}.md`;
  return {
    subscriptionId: `sub-${type}`,
    alias: "Creative Broker",
    publisher: "alice@host-a",
    nodeId: "node-1",
    shareId: `share-${type}`,
    revision: 4,
    syncedAt: "2026-09-16T00:00:00Z",
    items: [{
      key: `key-${type}`,
      title: type === "servers" ? "Sample API" : type === "packages" ? "asset-tool" : `Remote ${type.slice(0, -1)}`,
      path: itemPath,
      type,
      pkmPath: `pkm://subscriptions/node-1/share-${type}/${type}/${itemPath.split("/").map(encodeURIComponent).join("/")}`,
    }],
  };
}

for (const type of types) {
  const model = subscriptionNavigationRoot(type, [group(type)]);
  assert(model, `${type} must produce a subscribed Navigation root`);
  assert.strictEqual(model.label, "From Brokers");
  assert.strictEqual(model.kind, "root");
  assert.strictEqual(model.count, 1);
  assert.strictEqual(model.children.length, 1);
  const broker = model.children[0];
  assert.strictEqual(broker.kind, "broker");
  assert.strictEqual(broker.label, "Creative Broker");
  assert.strictEqual(broker.count, 1);
  assert.strictEqual(broker.pkmPath, `pkm://subscriptions/node-1/share-${type}/${type}`);

  let leaf = broker;
  while (leaf.children.length) leaf = leaf.children[0];
  assert.strictEqual(leaf.kind, "item", `${type} must expose a remote leaf`);
  assert.strictEqual(leaf.itemKey, `key-${type}`);
  assert.strictEqual(leaf.pkmPath, group(type).items[0].pkmPath);
  if (type === "packages" || type === "servers") {
    assert.strictEqual(broker.children[0].kind, "item", `${type} aggregate must not recreate internal cache folders`);
  } else {
    assert.strictEqual(broker.children[0].kind, "folder", `${type} must preserve its remote folder hierarchy`);
  }
}

assert.strictEqual(subscriptionNavigationRoot("skills", []), undefined, "empty subscriptions must not add an empty From Brokers folder");
for (const type of types) {
  assert.match(extension, new RegExp(`_withSubscribedContent\\(\\"${type}\\"`), `${type} root must attach From Brokers`);
}
assert.match(extension, /"subscribed-content-root": "cloud"/, "From Brokers must use the cloud ThemeIcon");
assert.match(extension, /model\.kind === "item" \? vscode\.TreeItemCollapsibleState\.None : vscode\.TreeItemCollapsibleState\.Collapsed/,
  "From Brokers, Broker, and remote folders must default to collapsed");
assert.match(extension, /openInPanel\(context, "subscriptionItem", String\(key \|\| ""\), false, type\)/,
  "remote Navigation items must open the existing read-only subscription detail");
assert.match(webview, /const tabName = e\.data\.tab \|\| TAB\[itemType\]/,
  "remote items must select their matching content tab");

console.log("navigation subscriptions test: From Brokers covers Skills, Notes, Papers, Prompts, Scripts, Packages, and Servers with collapsed Broker trees OK");
