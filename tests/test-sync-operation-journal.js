const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const store = require("../dist/knowledge/filestore.js");
const sync = require("../dist/sync/github-sync.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-operation-journal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.setStorePath(root);
  return root;
}

function records(root) {
  return store.knowledgeSyncDeletionRecords(root).map(record => record.path).sort();
}

test("Skill deletion intent survives restart, empty Trash, restore and recreation", t => {
  const root = fixture(t);
  store.skillUpsert({ name: "Delete", category: "Nested", content: "original" });
  const entry = store.skillMoveToTrash("Delete");
  assert(entry);
  assert.deepEqual(records(root), ["skills/Nested/Delete.md"]);
  const reloaded = JSON.parse(execFileSync(process.execPath, ["-e",
    "console.log(JSON.stringify(require(process.argv[1]).knowledgeSyncDeletionRecords(process.argv[2])))",
    require.resolve("../dist/knowledge/filestore.js"), root], { encoding: "utf8" }));
  assert.equal(reloaded[0].path, "skills/Nested/Delete.md");
  assert.equal(store.skillTrashRestore(entry.id).ok, true);
  assert.deepEqual(records(root), []);
  store.skillMoveToTrash("Delete");
  store.skillTrashEmpty();
  assert.deepEqual(records(root), ["skills/Nested/Delete.md"]);
  store.skillUpsert({ name: "Delete", category: "Nested", content: "recreated" });
  assert.deepEqual(records(root), []);
  assert.equal(store.skillDelete("Delete"), true);
  assert.deepEqual(records(root), ["skills/Nested/Delete.md"]);
});

test("Skill folder deletion records every member and restore clears descendants", t => {
  const root = fixture(t);
  store.skillUpsert({ name: "One", category: "Bundle", content: "one" });
  store.skillUpsert({ name: "Two", category: "Bundle/Nested", content: "two" });
  const asset = path.join(root, "skills/Bundle/_assets/proof.bin");
  fs.mkdirSync(path.dirname(asset), { recursive: true });
  fs.writeFileSync(asset, Buffer.from([0, 255, 1]));
  const entry = store.skillFolderMoveToTrash("Bundle");
  assert(entry);
  assert.deepEqual(records(root), ["skills/Bundle/Nested/Two.md", "skills/Bundle/One.md", "skills/Bundle/_assets/proof.bin"]);
  assert.equal(store.skillTrashRestore(entry.id).ok, true);
  assert.deepEqual(records(root), []);
  assert.deepEqual(fs.readFileSync(asset), Buffer.from([0, 255, 1]));
});

test("Note, Skill and Research moves preserve identity and journal old paths", t => {
  const root = fixture(t);
  store.noteUpsert({ slug: "Old/Note", title: "Note", category: "Old", content: "note", type: "general", tags: [] });
  store.skillUpsert({ name: "Skill", category: "Old", content: "skill" });
  store.paperUpsert({ slug: "Old/Paper", title: "Paper", category: "Old", content: "paper" });
  const identities = [store.noteGet("Old/Note").knowledgeId, store.skillGet("Skill").knowledgeId, store.paperGet("Old/Paper").knowledgeId];
  assert(store.noteMove("Old/Note", "New"));
  assert(store.skillMove("Skill", "New"));
  store.paperUpsert({ slug: "Old/Paper", title: "Paper", category: "New", content: "paper" });
  assert.deepEqual([store.noteGet("New/Note").knowledgeId, store.skillGet("Skill").knowledgeId, store.paperGet("New/Paper").knowledgeId], identities);
  assert.deepEqual(records(root), ["notes/Old/Note.md", "papers/Old/Paper.md", "skills/Old/Skill.md"]);
  assert(store.noteMove("New/Note", "Old"));
  assert(!records(root).includes("notes/Old/Note.md"), "moving back clears destination deletion intent");
  assert(records(root).includes("notes/New/Note.md"));
  store.noteDelete("Old/Note");
  store.paperDelete("New/Paper");
  assert(records(root).includes("notes/Old/Note.md"));
  assert(records(root).includes("papers/New/Paper.md"));
  store.paperUpsert({ slug: "New/Paper", title: "Paper", category: "New", content: "restored" });
  assert(!records(root).includes("papers/New/Paper.md"));
});

test("Failed Markdown moves preserve source bytes and roll back deletion intent", t => {
  const root = fixture(t);
  store.noteUpsert({ slug: "Old/Note", title: "Note", category: "Old", content: "original", type: "general", tags: [] });
  const source = path.join(root, "notes/Old/Note.md");
  const destination = path.join(root, "notes/New/Note.md");
  const before = fs.readFileSync(source);
  const write = fs.writeFileSync;
  try {
    fs.writeFileSync = (file, ...args) => {
      if (file === destination) throw new Error("injected disk failure");
      return write(file, ...args);
    };
    assert.throws(() => store.noteMove("Old/Note", "New"), /injected disk failure/);
  } finally { fs.writeFileSync = write; }
  assert.deepEqual(fs.readFileSync(source), before);
  assert(!fs.existsSync(destination));
  assert.deepEqual(records(root), []);
  store.noteUpsert({ slug: "New/Note", title: "Note", category: "New", content: "other", type: "general", tags: [] });
  assert.throws(() => store.noteMove("Old/Note", "New"), /Move target already exists/);
  assert.equal(store.noteGet("New/Note").content, "other");
  assert.deepEqual(fs.readFileSync(source), before);
});

test("Folder rename, drag move and container promotion journal nested paths and rollback", t => {
  const root = fixture(t);
  const file = path.join(root, "scripts/Group/Nested/run.py");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "print(1)");
  assert.equal(store.folderRename("scripts", "Group", "Renamed").ok, true);
  assert(records(root).includes("scripts/Group/Nested/run.py"));
  assert.equal(store.storeEntryMove("scripts", "Renamed/Nested", "Destination").ok, true);
  assert(records(root).includes("scripts/Renamed/Nested/run.py"));
  assert.equal(store.folderDeletePromote("scripts", "Destination").ok, true);
  assert(records(root).includes("scripts/Destination/Nested/run.py"));
  assert.equal(fs.readFileSync(path.join(root, "scripts/Nested/run.py"), "utf8"), "print(1)");

  for (const name of ["a.py", "b.py"]) fs.writeFileSync(path.join(root, "scripts/Nested", name), name);
  const before = records(root);
  const result = store.folderDeletePromote("scripts", "Nested", "", {
    rename(from, to) {
      if (path.basename(from) === "b.py" && path.dirname(from).endsWith("Nested")) throw new Error("injected rename failure");
      fs.renameSync(from, to);
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /injected rename failure/);
  assert(fs.existsSync(path.join(root, "scripts/Nested/a.py")));
  assert(!records(root).includes("scripts/Nested/a.py"), "rolled-back move is not a deletion");
  assert(before.every(record => records(root).includes(record)));
});

test("Skill Trash failure leaves no durable deletion, and direct delete failures are explicit", t => {
  const root = fixture(t);
  store.skillUpsert({ name: "Keep", content: "keep" });
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => {
      if (path.basename(to) === "payload") throw new Error("injected Trash failure");
      return rename(from, to);
    };
    assert.equal(store.skillMoveToTrash("Keep"), undefined);
  } finally { fs.renameSync = rename; }
  assert.equal(store.skillGet("Keep").content, "keep");
  assert.deepEqual(records(root), []);
  const remove = fs.rmSync;
  try {
    fs.rmSync = (file, ...args) => {
      if (file === path.join(root, "skills/Keep.md")) throw new Error("injected delete failure");
      return remove(file, ...args);
    };
    assert.throws(() => store.skillDelete("Keep"), /injected delete failure/);
  } finally { fs.rmSync = remove; }
  assert.deepEqual(records(root), []);
});

test("Two targets and bidirectional clients converge after normal trash, edits and moves but preserve real conflicts", async t => {
  const root = fixture(t);
  const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  fs.mkdirSync(seed);
  git(root, ["init", "--bare", remote]);
  git(seed, ["init"]);
  git(seed, ["config", "user.name", "Test"]);
  git(seed, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(seed, "README.md"), "fixture");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "seed"]);
  git(seed, ["push", remote, "HEAD:main"]);
  const writer = path.join(root, "writer");
  const reader = path.join(root, "reader");
  const checkouts = path.join(root, "checkouts");
  store.setStorePath(writer);
  store.skillUpsert({ name: "Delete", category: "Shared", content: "original" });
  store.skillUpsert({ name: "Keep", category: "Shared", content: "retained" });
  const catalog = local => {
    store.setStorePath(local);
    const result = Object.fromEntries(sync.GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
    result.skills = store.skillList().map(skill => {
      const relative = `skills/${skill.category}/${skill.name}.md`;
      return { id: skill.knowledgeId, label: skill.name, cat: skill.category, isPrivate: false,
        source: path.join(local, relative), destination: relative };
    });
    return result;
  };
  const targets = ["one", "two"].map(name => sync.normalizeGitHubSyncTarget({ name, repository: remote, branch: name }, () => name));
  const receiver = sync.normalizeGitHubSyncTarget({ name: "reader", repository: remote, branch: "one" }, () => "reader");
  const run = async (target, local) => {
    const result = await sync.syncGitHubTarget(target, catalog(local), checkouts, undefined, local);
    target.lastSync = { at: new Date().toISOString(), commit: result.commit, fingerprints: result.fingerprints };
    if (result.transactionId) sync.completeGitHubSyncTransaction(checkouts, target.id, result.transactionId);
    return result;
  };
  for (const target of targets) await run(target, writer);
  await run(receiver, reader);
  assert(fs.existsSync(path.join(reader, "skills/Shared/Delete.md")));
  store.setStorePath(writer);
  store.skillMoveToTrash("Delete");
  store.skillTrashEmpty();
  for (const target of targets) {
    await run(target, writer);
    const manifest = JSON.parse(git(root, ["--git-dir", remote, "show", `${target.branch}:.pkm-github-sync.json`]));
    assert(!manifest.files.some(file => file.path === "skills/Shared/Delete.md"));
    assert(manifest.deletions.some(file => file.type === "skills"));
    assert.equal((await run(target, writer)).changed, false, "repeated sync must not require conflict approval or create a commit");
  }
  await run(receiver, reader);
  assert(!fs.existsSync(path.join(reader, "skills/Shared/Delete.md")), "remote deletion reaches receiving client");
  assert(fs.existsSync(path.join(reader, "skills/Shared/Keep.md")));
  assert.equal((await run(receiver, reader)).changed, false);
  for (const target of targets) assert.equal((await run(target, writer)).changed, false, "receiving client must not resurrect writer deletions");

  store.setStorePath(reader);
  store.skillUpsert({ name: "Keep", category: "Shared", content: "edited by former receiving client" });
  await run(receiver, reader);
  await run(targets[0], writer);
  store.setStorePath(writer);
  assert.equal(store.skillGet("Keep").content, "edited by former receiving client");
  await run(targets[1], writer);
  assert.match(git(root, ["--git-dir", remote, "show", "two:skills/Shared/Keep.md"]), /edited by former receiving client/);

  store.setStorePath(writer);
  store.skillMove("Keep", "Archive");
  for (const target of targets) await run(target, writer);
  await run(receiver, reader);
  assert(!fs.existsSync(path.join(reader, "skills/Shared/Keep.md")));
  assert(fs.existsSync(path.join(reader, "skills/Archive/Keep.md")));
  for (const target of targets) assert.equal((await run(target, writer)).changed, false);

  store.setStorePath(writer);
  store.skillDelete("Keep");
  store.setStorePath(reader);
  store.skillUpsert({ name: "Keep", category: "Archive", content: "concurrent remote edit must not be deleted" });
  await run(receiver, reader);
  await assert.rejects(() => run(targets[0], writer), error => error instanceof sync.GitHubSyncConflictError,
    "delete-versus-edit still requires a real decision, not unconditional local authority");
  assert.match(git(root, ["--git-dir", remote, "show", "one:skills/Archive/Keep.md"]), /concurrent remote edit must not be deleted/);
});
