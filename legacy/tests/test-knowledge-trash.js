#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require("../dist/knowledge/filestore");

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
    {
      assert(store.knowledgeSyncDeletionRecords(root).some(record => record.path === `${area}/${relativePath}`),
        "a successful deletion must be durable before a sync is triggered");
      const reloaded = JSON.parse(fs.readFileSync(path.join(root, ".pkm", "state", "knowledge-deletions.json"), "utf8"));
      assert(reloaded.records.some(record => record.path === `${area}/${relativePath}`));
    }
    assert.deepStrictEqual(store.knowledgeTrashRestore(area, entry.id), { ok: true, path: relativePath });
    assert(!store.knowledgeSyncDeletionRecords(root).some(record => record.path === `${area}/${relativePath}`),
      "restore must cancel pending deletion intent");
    assert.strictEqual(fs.readFileSync(full, "utf8"), area);
    const second = store.knowledgeMoveToTrash(area, relativePath, "item", path.basename(relativePath));
    assert.deepStrictEqual(store.knowledgeTrashDelete(area, second.id), { ok: true, name: path.basename(relativePath), path: relativePath, kind: "item" });
    assert.deepStrictEqual(store.knowledgeTrashList(area), []);
    assert(store.knowledgeSyncDeletionRecords(root).some(record => record.path === `${area}/${relativePath}`),
      "permanently deleting Trash must not discard an unsynchronized deletion");
  }

  for (const area of ["notes", "skills", "papers"]) {
    const areaRoot = path.join(root, area);
    const move = name => area === "skills" ? store.skillFolderMoveToTrash(name)
      : store.knowledgeMoveToTrash(area, name, "folder", name);
    const restore = entry => area === "skills" ? store.skillTrashRestore(entry.id)
      : store.knowledgeTrashRestore(area, entry.id);
    const discard = entry => area === "skills" ? store.skillTrashDelete(entry.id)
      : store.knowledgeTrashDelete(area, entry.id);
    for (const marker of [null, ".gitkeep", ".hidden"]) {
      const folder = `Empty-${marker || "plain"}`;
      const full = path.join(areaRoot, folder);
      fs.mkdirSync(full, { recursive: true });
      if (marker) fs.writeFileSync(path.join(full, marker), "");
      const reference = path.join(areaRoot, "Stale-reference.md");
      fs.writeFileSync(reference, `![missing](${folder}/missing.png)\n`);
      const entry = move(folder);
      assert(entry, `${area}: empty/hidden-only folders must not be blocked by dangling references`);
      assert(!fs.existsSync(full));
      assert.strictEqual(restore(entry).ok, true);
      assert.deepStrictEqual(fs.readdirSync(full), marker ? [marker] : []);
      fs.unlinkSync(reference);
      assert.strictEqual(discard(move(folder)).ok, true);
    }
    const shared = path.join(areaRoot, "Shared-folder");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "resource.png"), "preserve shared bytes");
    const referrer = path.join(areaRoot, "External-reference.md");
    fs.writeFileSync(referrer, "![shared](Shared-folder/resource.png)");
    const stat = fs.statSync;
    try {
      fs.statSync = (target, ...options) => {
        if (target === path.join(shared, "resource.png")) throw Object.assign(new Error("Cannot verify shared resource"), { code: "EACCES" });
        return stat(target, ...options);
      };
      assert.throws(() => move("Shared-folder"), /Cannot verify shared resource/,
        "unreadable targets must not be treated as dangling links");
    } finally { fs.statSync = stat; }
    assert.throws(() => move("Shared-folder"), /Resource is shared by External-reference.md/);
    assert.strictEqual(fs.readFileSync(path.join(shared, "resource.png"), "utf8"), "preserve shared bytes");
    fs.unlinkSync(referrer);
    const retried = move("Shared-folder");
    assert(retried, `${area}: removing the live external reference permits a fresh retry`);
    assert.strictEqual(discard(retried).ok, true);
    assert.strictEqual(move("Already-gone"), undefined);
  }

  const folder = path.join(root, "prompts", "Project", "Task");
  const meetingPath = "Chatroom Meetings/Planned/Only.md";
  const meetingFull = path.join(root, "notes", meetingPath);
  fs.mkdirSync(path.dirname(meetingFull), { recursive: true });
  fs.writeFileSync(meetingFull, "Keep my empty meeting folders");
  const meetingTrash = store.knowledgeMoveToTrash("notes", meetingPath, "item", "Only");
  assert(meetingTrash);
  assert(fs.existsSync(path.dirname(meetingFull)), "trashing the last Note must preserve its empty parent directory");
  assert(store.folderList("notes").includes("Chatroom Meetings/Planned"), "empty meeting directories remain listed without a marker");
  const meetingFolderTrash = store.knowledgeMoveToTrash("notes", "Chatroom Meetings/Planned", "folder", "Planned");
  assert(meetingFolderTrash, "explicitly trashing an empty directory still works");
  assert(fs.existsSync(path.join(root, "notes", "Chatroom Meetings")), "explicit child-folder deletion must preserve its empty parent");
  assert.strictEqual(store.knowledgeTrashRestore("notes", meetingFolderTrash.id).ok, true);
  assert.strictEqual(store.knowledgeTrashRestore("notes", meetingTrash.id).ok, true);
    store.noteUpsert({slug:"Project/Note",title:"Note",content:"new user content",type:"general",tags:[],category:"Project",pinned:true});
    assert.strictEqual(store.noteGet("Project/Note").pinned, true, "journal-aware writes must preserve existing Note metadata behavior");
    assert(!store.knowledgeSyncDeletionRecords(root).some(record => record.path === "notes/Project/Note.md"),
      "explicitly recreating a Note must cancel an earlier deletion of the same path");
    const failedNote = path.join(root, "notes", "Failed.md");
    fs.writeFileSync(failedNote, "keep on failure");
    const originalRename = fs.renameSync;
    try {
      fs.renameSync = (from, to) => {
        if (path.basename(to) === "payload") throw new Error("simulated move failure");
        return originalRename(from, to);
      };
      assert.throws(() => store.knowledgeMoveToTrash("notes", "Failed.md", "item", "Failed"), /simulated move failure/);
    } finally { fs.renameSync = originalRename; }
    assert.strictEqual(fs.readFileSync(failedNote, "utf8"), "keep on failure");
    assert(!store.knowledgeSyncDeletionRecords(root).some(record => record.path === "notes/Failed.md"),
      "a failed move must roll back deletion intent and preserve the original Note");
  fs.mkdirSync(path.join(folder, "v2"), { recursive: true });
  fs.writeFileSync(path.join(folder, "v2", "prompt.txt"), "prompt");
  const folderEntry = store.knowledgeMoveToTrash("prompts", "Project/Task", "folder", "Task");
  assert(folderEntry);
  assert(store.knowledgeSyncDeletionRecords(root).some(record => record.path === "prompts/Project/Task/v2/prompt.txt"), "Deleting a Prompt folder journals its nested members");
  assert.strictEqual(store.knowledgeTrashRestore("prompts", folderEntry.id).ok, true);
  assert(!store.knowledgeSyncDeletionRecords(root).some(record => record.path === "prompts/Project/Task/v2/prompt.txt"), "Restoring a folder cancels deletion records for its restored payload");
  assert(store.knowledgeSyncDeletionRecords(root).some(record => record.path === "prompts/Project/Task/v1/prompt.txt"),
    "Restoring a folder must not revive members permanently deleted before it entered Trash");
  const deletedFolderEntry = store.knowledgeMoveToTrash("prompts", "Project/Task", "folder", "Task");
  assert.deepStrictEqual(store.knowledgeTrashDelete("prompts", deletedFolderEntry.id), { ok: true, name: "Task", path: "Project/Task", kind: "folder" });
  assert.deepStrictEqual(store.knowledgeTrashEmpty("prompts"), { ok: true, count: 0 });

  const paperFixtures = [
    ["First.md", "First Paper"],
    ["Nested/Second.md", "Second Paper"],
    ["Ideas/Third.md", "Third Idea"],
  ];
  for (const [relativePath, title] of paperFixtures) {
    const full = path.join(root, "papers", relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `---\ntitle: ${title}\n---\n`);
  }
  assert.deepStrictEqual(store.paperMoveAllToTrash(), { ok: true, moved: 3 });
  assert.strictEqual(store.paperList().length, 0, "bulk delete must remove every Paper and Idea from Research");
  const paperTrash = store.knowledgeTrashList("papers");
  assert.strictEqual(paperTrash.length, 3, "bulk delete must keep each Paper independently recoverable");
  for (const entry of paperTrash) assert.strictEqual(store.knowledgeTrashRestore("papers", entry.id).ok, true);
  assert.strictEqual(store.paperList().length, 3, "every bulk-deleted Paper must restore to its original path");
  assert.deepStrictEqual(store.paperMoveAllToTrash(), { ok: true, moved: 3 });
  assert.deepStrictEqual(store.knowledgeTrashEmpty("papers"), { ok: true, count: 3 });
  assert.deepStrictEqual(store.paperMoveAllToTrash(), { ok: true, moved: 0 });

  const stalePaperFolder = path.join(root, "papers", "Stale", "Nested");
  fs.mkdirSync(stalePaperFolder, { recursive: true });
  assert.deepStrictEqual(store.folderList("papers"), [], "unmarked empty Research folders must not render");
  const intentionalPaperFolder = path.join(root, "papers", "Intentional");
  fs.mkdirSync(intentionalPaperFolder, { recursive: true });
  fs.writeFileSync(path.join(intentionalPaperFolder, ".gitkeep"), "");
  assert.deepStrictEqual(store.folderList("papers"), ["Intentional"], "explicit .gitkeep Research folders must remain visible");

  const transientPaper = path.join(root, "papers", "Retry", "Paper.md");
  fs.mkdirSync(path.dirname(transientPaper), { recursive: true });
  fs.writeFileSync(transientPaper, "---\ntitle: Retry Paper\n---\n");
  const transientEntry = store.knowledgeMoveToTrash("papers", "Retry/Paper.md", "item", "Retry Paper");
  assert(transientEntry);
  assert.strictEqual(fs.existsSync(path.dirname(transientPaper)), false, "moving the last Paper must prune its unmarked empty ancestors");
  let deleteAttempts = 0;
  const transientDelete = store.knowledgeTrashDelete("papers", transientEntry.id, {
    remove(target) {
      deleteAttempts++;
      if (deleteAttempts < 3) {
        const error = new Error("OneDrive is synchronizing Trash");
        error.code = "EPERM";
        throw error;
      }
      fs.rmSync(target, { recursive: true, force: true });
    },
    sleep() {},
  });
  assert.strictEqual(transientDelete.ok, true);
  assert.strictEqual(deleteAttempts, 3, "permanent Trash deletion must retry transient EPERM");

  const lockedPaper = path.join(root, "papers", "Locked.md");
  fs.writeFileSync(lockedPaper, "---\ntitle: Locked Paper\n---\n");
  const lockedEntry = store.knowledgeMoveToTrash("papers", "Locked.md", "item", "Locked Paper");
  assert(lockedEntry);
  let lockedDeleteAttempts = 0;
  const lockedDelete = store.knowledgeTrashDelete("papers", lockedEntry.id, {
    remove() {
      lockedDeleteAttempts++;
      const error = new Error("OneDrive still owns the Trash entry");
      error.code = "EPERM";
      throw error;
    },
    sleep() {},
  });
  assert.strictEqual(lockedDelete.ok, false);
  assert.strictEqual(lockedDeleteAttempts, 8, "single permanent deletion must use the bounded retry budget");
  assert.match(lockedDelete.error, /OneDrive still owns the Trash entry/);
  assert.strictEqual(store.knowledgeTrashList("papers").length, 1, "failed permanent deletion must keep the entry visible");
  let emptyAttempts = 0;
  const lockedEmpty = store.knowledgeTrashEmpty("papers", {
    remove() {
      emptyAttempts++;
      const error = new Error("OneDrive still owns Trash");
      error.code = "EPERM";
      throw error;
    },
    sleep() {},
  });
  assert.strictEqual(lockedEmpty.ok, false);
  assert.strictEqual(lockedEmpty.count, 0);
  assert.strictEqual(emptyAttempts, 8, "Empty Trash must use the bounded retry budget");
  assert.match(lockedEmpty.error, /OneDrive still owns Trash/);
  assert.strictEqual(store.knowledgeTrashList("papers").length, 1, "failed Empty Trash must keep the remaining entry visible");

  console.log("Knowledge Trash test: recovery, Research folder cleanup, and OneDrive-safe permanent deletion OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
