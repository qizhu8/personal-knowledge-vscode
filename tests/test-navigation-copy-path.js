#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { navigationItemPath } = require("../dist/navigation-path.js");

const cases = [
  ["root-skills", {}, "skills/"],
  ["skill-folder", { relPath: "Coding/Python" }, "skills/Coding/Python/"],
  ["skill-folder", { relPath: "(uncategorized)" }, "skills/"],
  ["skill", { relPath: "Coding/Python/testing.md" }, "skills/Coding/Python/testing.md"],
  ["root-notes", {}, "notes/"],
  ["note-folder", { relPath: "Research/RAG" }, "notes/Research/RAG/"],
  ["note", { relPath: "Research/RAG/index.md" }, "notes/Research/RAG/index.md"],
  ["root-papers", {}, "papers/"],
  ["paper-folder", { relPath: "Generative Retrieval" }, "papers/Generative Retrieval/"],
  ["paper", { relPath: "Generative Retrieval/DSI.md" }, "papers/Generative Retrieval/DSI.md"],
  ["root-prompts", {}, "prompts/"],
  ["prompt-project", { project: "Ads" }, "prompts/Ads/"],
  ["prompt-task", { project: "Ads", task: "Review" }, "prompts/Ads/Review/"],
  ["prompt-version", { project: "Ads", task: "Review", version: "v2" }, "prompts/Ads/Review/v2/"],
  ["prompt-file", { project: "Ads", task: "Review", version: "v2", file: "prompt.md" }, "prompts/Ads/Review/v2/prompt.md"],
  ["root-packages", {}, "packages/"],
  ["package", { key: "my-package" }, "packages/my-package/"],
  ["root-scripts", {}, "scripts/"],
  ["script-folder", { relPath: "Scope/Checks" }, "scripts/Scope/Checks/"],
  ["script-file", { key: "Scope/Checks/query.script" }, "scripts/Scope/Checks/query.script"],
  ["root-servers", {}, "servers/"],
  ["server-group", { path: ["Research", "Vision"] }, "pkm://servers/subgroups/Research%2FVision"],
  ["server-ungrouped-group", {}, "pkm://servers/subgroups/ungrouped"],
  ["server-item", { slug: "asset-quality" }, "servers/asset-quality/server.json"],
  ["root-environments", {}, "pkm://environments"],
  ["environment-group", { path: ["conda", "miniconda3"] }, "pkm://environments/groups/conda%2Fminiconda3"],
  ["environment-item", { id: "env id" }, "pkm://environments/env%20id"],
  ["root-chatroom", {}, "pkm://chatroom"],
  ["chat-hosted-group", {}, "pkm://chatroom/hosted"],
  ["chat-joined-group", {}, "pkm://chatroom/joined"],
  ["chat-hosted-room", { roomId: "room/id" }, "pkm://chatroom/rooms/room%2Fid"],
  ["chat-room", { id: "recent room" }, "pkm://chatroom/rooms/recent%20room"],
  ["root-mcp", {}, "pkm://config"],
];

for (const [nodeType, nodeData, expected] of cases) {
  assert.strictEqual(navigationItemPath({ nodeType, nodeData, label: nodeType }), expected, nodeType);
}
assert.strictEqual(navigationItemPath({ nodeType: "future-node", label: "Future Item" }), "pkm://navigation/future-node/Future%20Item");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const command = manifest.contributes.commands.find(row => row.command === "personalKnowledge.copyNavigationPath");
assert.strictEqual(command.title, "Copy Path");
const menu = manifest.contributes.menus["view/item/context"].find(row => row.command === "personalKnowledge.copyNavigationPath");
assert.strictEqual(menu.when, "view == personalKnowledge.sidebarView");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
assert.match(extension, /clipboard\.writeText\(locator\)/);
assert.match(extension, /Copied PKM path:/);

console.log(`navigation copy path test: ${cases.length} node types plus fallback and global context menu OK`);
