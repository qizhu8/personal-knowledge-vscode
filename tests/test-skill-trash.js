#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require("../dist/filestore");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-skill-trash-"));
try {
  store.setStorePath(root);
  store.skillUpsert({ name: "Keep", category: "Team/One", content: "keep" });
  store.skillUpsert({ name: "Nested", category: "Team/One/Deep", content: "nested" });
  store.skillUpsert({ name: "Single", category: "Other", content: "single" });

  const folderEntry = store.skillFolderMoveToTrash("Team/One");
  assert(folderEntry && folderEntry.kind === "folder");
  assert.strictEqual(store.skillList().some(item => item.category.startsWith("Team/One")), false);
  assert.strictEqual(store.skillTrashList().length, 1);
  assert(fs.existsSync(path.join(root, "skills", ".trash", folderEntry.id, "payload", "Deep")));

  assert.deepStrictEqual(store.skillTrashRestore(folderEntry.id), { ok: true, path: "Team/One" });
  assert(store.skillList().some(item => item.name === "Keep"));
  assert(store.skillList().some(item => item.name === "Nested"));

  const skillEntry = store.skillMoveToTrash("Single");
  assert(skillEntry && skillEntry.kind === "skill");
  store.skillUpsert({ name: "Single", category: "Other", content: "replacement" });
  assert.match(store.skillTrashRestore(skillEntry.id).error, /already exists/);
  assert.strictEqual(store.skillTrashList().length, 1);
  assert.deepStrictEqual(store.skillTrashDelete(skillEntry.id), { ok: true, name: "Single" });
  assert.deepStrictEqual(store.skillTrashList(), []);
  const deleteFolder = store.skillFolderMoveToTrash("Team/One");
  assert(deleteFolder);
  assert.deepStrictEqual(store.skillTrashDelete(deleteFolder.id), { ok: true, name: "One" });
  assert.strictEqual(store.skillTrashEmpty(), 0);
  assert.deepStrictEqual(store.skillTrashList(), []);
  assert.strictEqual(fs.existsSync(path.join(root, "skills", ".trash")), false);

  console.log("Skill Trash test: folder/skill move, path-preserving restore, conflict rejection, and explicit empty OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
