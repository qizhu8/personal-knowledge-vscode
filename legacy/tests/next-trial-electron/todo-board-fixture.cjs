"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const task = (id, extra = {}) => ({ id, title: id, goal: "Preserve genuine old Todo workflows",
  scope: "Synthetic installed private profile", acceptance: ["Original identities and audit remain"],
  state: "Planning", evidence: [], ...extra });
function create({ extension, root, descriptor }) {
  const store = require(path.join(extension, "dist/knowledge/filestore.js"));
  store.setStorePath(root);
  const primary = "Team/Board", converted = "History/Converted";
  store.todoBoardCreate(primary, "Board", "Team");
  const mutate = (slug, operation) => {
    const snapshot = store.noteWorkItemsRead(slug);
    return store.noteWorkItemCommand(slug, snapshot.digest, operation, { id: "user:local", role: "user" });
  };
  mutate(primary, { action: "create", item: task("old-story", { kind: "UserStory", storyStatus: "draft" }) });
  mutate(primary, { action: "create", item: task("old-task", { parentId: "old-story", ownerId: `chat:${descriptor.text}`,
    owner: "Original ordinary API conversation for real UI sending" }) });
  mutate(primary, { action: "comment", id: "old-task", text: "OLD_INSTALLED_TODO_AUDIT" });
  mutate(primary, { action: "create", item: task("old-done", { ownerId: "user:local" }) });
  mutate(primary, { action: "claim", id: "old-done" });
  mutate(primary, { action: "transition", id: "old-done", state: "Done", outcome: "Success",
    evidence: ["fixture://old-installed/result"], verification: [
      { layer: "unit", status: "passed", evidence: ["fixture://old-installed/unit"] },
      { layer: "functional", status: "passed", evidence: ["fixture://old-installed/functional"] },
      { layer: "e2e", status: "not-applicable", evidence: [], reason: "Historical synthetic record, not a production test" },
    ] });
  mutate(primary, { action: "accept", id: "old-done", reason: "OLD_INSTALLED_USER_ACCEPTANCE" });
  store.noteUpsert({ slug: converted, category: "History", title: "Converted", type: "general", tags: [],
    content: "ORIGINAL_INLINE_PROSE_AND_CONVERSION_HISTORY\n" });
  const identity = store.noteGet(converted).knowledgeId;
  mutate(converted, { action: "create", item: task("old-inline") });
  mutate(converted, { action: "comment", id: "old-inline", text: "OLD_INLINE_AUDIT_BEFORE_CONVERSION" });
  const beforeConversion = store.todoBoardConversionPreview(converted);
  store.todoBoardConvert(converted, beforeConversion.digest);
  assert.equal(store.noteGet(converted).knowledgeId, identity);
  assert.equal(store.noteGet(converted).documentKind, "todo-board");
  assert(store.noteGet(converted).content.includes("ORIGINAL_INLINE_PROSE_AND_CONVERSION_HISTORY"));
  const boards = [primary, converted].map(slug => {
    const note = store.noteGet(slug), snapshot = store.noteWorkItemsRead(slug);
    assert(fs.existsSync(path.join(root, "notes", `${slug}.assets/pkm-todo-board.json`)));
    assert(!fs.existsSync(path.join(root, "boards", slug, "pkm-todo-board.json")));
    return { slug, note, snapshot, raw: fs.readFileSync(path.join(root, "notes", `${slug}.assets/pkm-todo-board.json`), "utf8") };
  });
  fs.writeFileSync(path.join(path.dirname(root), "todo-board-fixture.json"), JSON.stringify({
    primary, converted, boards, namespace: descriptor.namespace, chatId: descriptor.text,
  }), { mode: 0o600, flag: "wx" });
  descriptor.todoBoards = boards.map(board => board.slug);
  console.log("PASS OLD TODO FIXTURE: supplied FileStore codec generated assets-layout Boards, accepted history, original Chat ownership and actual inline conversion.");
}
function refresh({ extension, root, descriptor }) {
  const store = require(path.join(extension, "dist/knowledge/filestore.js")), file = path.join(path.dirname(root), "todo-board-fixture.json");
  store.setStorePath(root);
  const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
  const createdFile = path.join(path.dirname(root), "old-ui-created-board.json");
  if (fs.existsSync(createdFile)) {
    const created = JSON.parse(fs.readFileSync(createdFile, "utf8"));
    assert.equal(created.slug, "OLD_UI_CREATED_BOARD");
    const note = store.noteGet(created.slug);
    assert.equal(note.documentKind, "todo-board");
    if (!descriptor.todoBoards.includes(created.slug)) descriptor.todoBoards.push(created.slug);
  }
  fixture.boards = descriptor.todoBoards.map(slug => ({
    slug, note: store.noteGet(slug), snapshot: store.noteWorkItemsRead(slug),
    raw: fs.readFileSync(path.join(root, "notes", `${slug}.assets/pkm-todo-board.json`), "utf8"),
  }));
  fs.writeFileSync(file, JSON.stringify(fixture), { mode: 0o600 });
}
module.exports = { create, refresh };
