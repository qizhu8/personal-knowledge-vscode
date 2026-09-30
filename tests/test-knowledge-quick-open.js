#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PkmLocatorError,
  parsePkmLocator,
  resolvePkmLocator,
} = require("../dist/knowledge-locator");

const inventory = [
  { area: "skills", relativePath: "Coding/Review.md", slug: "Coding/Review", title: "Review", knowledgeId: "knowledge_0123456789abcdef01234567" },
  { area: "notes", relativePath: "Team/Meeting Notes.md", slug: "Team/Meeting Notes", title: "Meeting Notes", knowledgeId: "knowledge_aaaaaaaaaaaaaaaaaaaaaaaa" },
  { area: "papers", relativePath: "Retrieval/Router.md", slug: "Retrieval/Router", title: "Router", knowledgeId: "knowledge_bbbbbbbbbbbbbbbbbbbbbbbb" },
  { area: "recipes", relativePath: "Operations/Create Snapshot.recipe_123.json", slug: "Operations/Create Snapshot.recipe_123", title: "Create Snapshot", knowledgeId: "knowledge_cccccccccccccccccccccccc" },
  { area: "scripts", relativePath: "tools/check.js", slug: "tools/check", title: "Check", knowledgeId: "knowledge_dddddddddddddddddddddddd" },
];
const subscriptionGroups = [{
  nodeId: "node/one",
  shareId: "share one",
  items: [
    {
      key: "note-key",
      title: "Remote Note",
      path: "Team/Remote Note.md",
      type: "notes",
      pkmPath: "pkm://subscriptions/node%2Fone/share%20one/notes/Team/Remote%20Note.md",
    },
    {
      key: "server-key",
      title: "Remote Dashboard",
      path: "Ops/server.link.json",
      type: "servers",
      pkmPath: "pkm://subscriptions/node%2Fone/share%20one/servers/Ops/server.link.json",
    },
  ],
}];

assert.deepStrictEqual(
  parsePkmLocator("`pkm://knowledge/knowledge_0123456789abcdef01234567`"),
  {
    kind: "knowledge",
    locator: "pkm://knowledge/knowledge_0123456789abcdef01234567",
    knowledgeId: "knowledge_0123456789abcdef01234567",
  },
);
assert.deepStrictEqual(
  resolvePkmLocator("pkm://knowledge/knowledge_0123456789abcdef01234567", inventory),
  {
    kind: "panel",
    locator: "pkm://knowledge/knowledge_0123456789abcdef01234567",
    type: "skill",
    key: "Coding/Review",
    tab: "skills",
    title: "Review",
  },
);
assert.strictEqual(resolvePkmLocator("pkm://knowledge/knowledge_aaaaaaaaaaaaaaaaaaaaaaaa", inventory).type, "note");
assert.strictEqual(resolvePkmLocator("pkm://knowledge/knowledge_bbbbbbbbbbbbbbbbbbbbbbbb", inventory).type, "paper");
assert.deepStrictEqual(
  resolvePkmLocator("pkm://knowledge/knowledge_cccccccccccccccccccccccc", inventory),
  {
    kind: "recipe",
    locator: "pkm://knowledge/knowledge_cccccccccccccccccccccccc",
    recipeId: "recipe_123",
    title: "Create Snapshot",
  },
);
assert.strictEqual(
  resolvePkmLocator("pkm://notes/Team/Meeting%20Notes.md", inventory).key,
  "Team/Meeting Notes",
);
assert.deepStrictEqual(
  resolvePkmLocator("pkm://subscriptions/node%2Fone/share%20one/notes/Team/Remote%20Note.md", inventory, subscriptionGroups),
  {
    kind: "panel",
    locator: "pkm://subscriptions/node%2Fone/share%20one/notes/Team/Remote%20Note.md",
    type: "subscriptionItem",
    key: "note-key",
    tab: "notes",
    title: "Remote Note",
  },
);
assert.strictEqual(
  resolvePkmLocator("pkm://subscriptions/node%2Fone/share%20one/servers/Ops/server.link.json", inventory, subscriptionGroups).kind,
  "subscribed-server",
);

function rejects(locator, code) {
  assert.throws(
    () => resolvePkmLocator(locator, inventory, subscriptionGroups),
    error => error instanceof PkmLocatorError && error.code === code,
    locator,
  );
}
rejects("", "invalid");
rejects("https://example.com", "invalid");
rejects("pkm://knowledge/not-an-id", "invalid");
rejects("pkm://notes/Team/", "invalid");
rejects("pkm://notes/Team/../Secret.md", "invalid");
rejects("pkm://notes/Team/%2e%2e/Secret.md", "invalid");
rejects("pkm://knowledge/knowledge_0123456789abcdef01234567?revision=2", "invalid");
rejects("pkm://chatroom", "unsupported");
rejects("pkm://knowledge/knowledge_eeeeeeeeeeeeeeeeeeeeeeee", "not-found");
rejects("pkm://knowledge/knowledge_dddddddddddddddddddddddd", "unsupported");
rejects("pkm://subscriptions/node%2Fone/share%20one/notes/Team/Missing.md", "not-found");
rejects("pkm://subscriptions/node%2Fone/share%20one/notes/Team/", "invalid");

const duplicate = [...inventory, { ...inventory[0], relativePath: "Coding/Duplicate.md", slug: "Coding/Duplicate" }];
assert.throws(
  () => resolvePkmLocator("pkm://knowledge/knowledge_0123456789abcdef01234567", duplicate),
  error => error instanceof PkmLocatorError && error.code === "duplicate",
);

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const command = manifest.contributes.commands.find(item => item.command === "personalKnowledge.goToPkmPath");
assert.strictEqual(command.title, "%command.goToPkmPath%");
assert.strictEqual(command.icon, "$(go-to-file)");
const titleMenu = manifest.contributes.menus["view/title"].find(item => item.command === "personalKnowledge.goToPkmPath");
assert.strictEqual(titleMenu.when, "view == personalKnowledge.sidebarView");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
assert.match(extension, /registerCommand\("personalKnowledge\.goToPkmPath"/);
assert.match(extension, /showInputBox\(\{\s*title: "Go to PKM Path"/);
assert.match(extension, /await refreshKnowledgeInventory\(context\)/);
assert.match(extension, /openInPanel\(context, target\.type, target\.key, false, target\.tab\)/);
const panel = fs.readFileSync(path.join(root, "src", "webview", "panel.html"), "utf8");
assert.match(panel, /id="go-to-pkm-path-button"[^>]+onclick="ask\('goToPkmPath'\)"/);

console.log("knowledge quick-open tests passed");
