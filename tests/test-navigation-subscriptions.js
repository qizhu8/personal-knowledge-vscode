#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { subscriptionNavigationRoot } = require("../dist/ui/navigation-subscriptions.js");
const { SHARED_CONTENT_TYPES } = require("../dist/subscriptions/subscriptions.js");

const root = path.join(__dirname, "..");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const webview = fs.readFileSync(path.join(root, "src", "webview", "panel", "00-core.js"), "utf8");
const types = [...SHARED_CONTENT_TYPES];
const ts = require("typescript");
const methodStart = extension.indexOf("  private _withSubscribedContent(");
const methodEnd = extension.indexOf("  private _subscribedContentItem(", methodStart);
const compiled = ts.transpileModule(`class Navigation { ${extension.slice(methodStart, methodEnd)} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const navigation = new Function("sharedMarket", "subscriptionNavigationRoot", `${compiled}; return new Navigation();`);
for (const type of types) {
  const local = [
    { nodeType:"folder", nodeData:{isPrivate:true}, label:"A private" },
    { nodeType:"folder", nodeData:{isPrivate:false}, label:"Z public" },
    { nodeType:"knowledge-trash", nodeData:{}, label:"Trash" },
    { nodeType:"folder", nodeData:{isPrivate:false}, label:"Pinned public" },
    { nodeType:"folder", nodeData:{isPrivate:true}, label:"B private" },
  ];
  const plain = navigation(undefined, subscriptionNavigationRoot);
  assert.deepStrictEqual(plain._withSubscribedContent(type, local).map(item => item.label),
    ["Z public", "Pinned public", "A private", "B private", "Trash"], `${type}: privacy grouping preserves existing order inside each section`);
  const subscribed = navigation({ cachedGroups:() => [group(type)] }, subscriptionNavigationRoot);
  subscribed._subscribedContentItem = model => ({ label:model.label, nodeType:"subscribed-content-root" });
  assert.deepStrictEqual(subscribed._withSubscribedContent(type, local).map(item => item.label),
    ["Z public", "Pinned public", "From Brokers", "A private", "B private", "Trash"]);
  assert.strictEqual(local[0].label, "A private", "Sorting must not mutate caller arrays");
}

function group(type) {
  const itemPath = type === "packages" ? "asset-tool"
    : type === "servers" ? "sample-api/server.link.json"
    : type === "recipes" ? "Operations/Sharing/shared-release-recipe.json"
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

console.log(`navigation subscriptions test: From Brokers covers all ${types.length} shared content types with collapsed Broker trees OK`);
