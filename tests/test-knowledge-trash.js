#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require("../dist/filestore");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-knowledge-trash-"));
try {
  store.setStorePath(root);
  const fixtures = [
    ["notes", "Project/Note.md"],
    ["papers", "Research/Paper.md"],
    ["prompts", "Project/Task/v1/prompt.txt"],
    ["scripts", "Tools/check.py"],
  ];
  for (const [area, relativePath] of fixtures) {
    const full = path.join(root, area, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, area);
    const entry = store.knowledgeMoveToTrash(area, relativePath, "item", path.basename(relativePath));
    assert(entry, `${area} item must move to Trash`);
    assert.strictEqual(fs.existsSync(full), false);
    assert.strictEqual(store.knowledgeTrashList(area).length, 1);
    assert.deepStrictEqual(store.knowledgeTrashRestore(area, entry.id), { ok: true, path: relativePath });
    assert.strictEqual(fs.readFileSync(full, "utf8"), area);
    const second = store.knowledgeMoveToTrash(area, relativePath, "item", path.basename(relativePath));
    assert.deepStrictEqual(store.knowledgeTrashDelete(area, second.id), { ok: true, name: path.basename(relativePath), path: relativePath, kind: "item" });
    assert.deepStrictEqual(store.knowledgeTrashList(area), []);
  }

  const folder = path.join(root, "prompts", "Project", "Task");
  fs.mkdirSync(path.join(folder, "v2"), { recursive: true });
  fs.writeFileSync(path.join(folder, "v2", "prompt.txt"), "prompt");
  const folderEntry = store.knowledgeMoveToTrash("prompts", "Project/Task", "folder", "Task");
  assert(folderEntry);
  assert.deepStrictEqual(store.knowledgeTrashDelete("prompts", folderEntry.id), { ok: true, name: "Task", path: "Project/Task", kind: "folder" });
  assert.strictEqual(store.knowledgeTrashEmpty("prompts"), 0);

  console.log("Knowledge Trash test: Notes, Papers, Prompts, and Scripts share item/folder restore and permanent deletion semantics OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
