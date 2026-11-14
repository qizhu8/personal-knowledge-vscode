"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { test } = require("node:test"), { randomUUID } = require("node:crypto");
const project = path.resolve(__dirname, "..");

function fixture(t) {
  const directory = path.join(project, ".migration-test-work", `note-content-alias-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  require("esbuild").buildSync({
    entryPoints: [process.env.PKM_NOTE_FILESTORE_SOURCE || path.join(project, "src/knowledge/filestore.ts")], bundle: true,
    platform: "node", format: "cjs", packages: "external", outfile: path.join(directory, "filestore.cjs"), logLevel: "silent",
  });
  const store = require(path.join(directory, "filestore.cjs")), root = path.join(directory, "root");
  store.setStorePath(root);
  fs.mkdirSync(path.join(root, "notes/Chatroom Meetings/Room"), { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const slug = "Chatroom Meetings/Room/timestamp", titleSlug = "Chatroom Meetings/Room/Actual title";
  const original = path.join(root, "notes", slug + ".md");
  fs.writeFileSync(original, '---\ntitle: "Actual title"\ntype: "meeting"\n---\nOriginal body.\n');
  return { store, root, slug, titleSlug, original };
}

test("ordinary Note save keeps the old content URI readable after title rename and a second edit", t => {
  const f = fixture(t), initial = f.store.noteGet(f.slug);
  f.store.noteUpsert({ ...initial, tags: [], content: "First actual edit.\n" });
  assert.equal(fs.existsSync(f.original), false);
  const saved = f.store.noteGet(f.slug);
  assert.equal(saved.content, "First actual edit.\n");
  assert.equal(saved.slug, f.titleSlug);
  f.store.noteUpsert({ ...saved, tags: [], content: "Second actual edit.\n" });
  assert.equal(f.store.noteGet(f.slug).content, "Second actual edit.\n");
});

test("direct Note upsert through the old alias updates and then renames the resolved physical Note", t => {
  const f = fixture(t), initial = f.store.noteGet(f.slug);
  f.store.noteUpsert({ ...initial, tags: [], content: "First edit.\n" });
  const saved = f.store.noteGet(f.slug);
  assert.equal(f.store.noteUpsert({ slug: f.slug, title: saved.title, type: saved.type,
    tags: [], content: "Direct alias edit.\n" }), false);
  assert.equal(f.store.noteGet(f.slug).content, "Direct alias edit.\n");
  assert.equal(f.store.noteGet(f.slug).knowledgeId, saved.knowledgeId);
  assert.equal(f.store.noteGet(f.slug).revision, saved.revision + 1);
  f.store.noteUpsert({ slug: f.slug, title: "Renamed again", type: saved.type, tags: [], content: "Renamed via alias.\n" });
  assert.equal(fs.existsSync(path.join(f.root, "notes", f.titleSlug + ".md")), false);
  assert.equal(f.store.noteGet(f.slug).slug, "Chatroom Meetings/Room/Renamed again");
  assert.equal(f.store.noteGet(f.slug).content, "Renamed via alias.\n");
  assert.equal(f.store.noteGet(f.slug).knowledgeId, saved.knowledgeId);
});

test("direct alias upsert cannot overwrite an unrelated existing move destination", t => {
  const f = fixture(t), initial = f.store.noteGet(f.slug);
  f.store.noteUpsert({ ...initial, tags: [], content: "Owned content.\n" });
  const destination = path.join(f.root, "notes/Chatroom Meetings/Room/Unrelated.md");
  fs.writeFileSync(destination, "Unrelated bytes.\n");
  assert.throws(() => f.store.noteUpsert({ slug: f.slug, title: "Unrelated", type: "meeting",
    tags: [], content: "Must not overwrite.\n" }), /Move target already exists/);
  assert.equal(fs.readFileSync(destination, "utf8"), "Unrelated bytes.\n");
  assert.equal(f.store.noteGet(f.slug).content, "Owned content.\n");
});

test("direct canonical Note wins over an alias copy; a missing unrelated slug stays missing", t => {
  const f = fixture(t), initial = f.store.noteGet(f.slug);
  f.store.noteUpsert({ ...initial, tags: [], content: "Renamed body." });
  fs.writeFileSync(f.original, "Authoritative direct Note.");
  assert.equal(f.store.noteGet(f.slug).content, "Authoritative direct Note.");
  assert.equal(f.store.noteGet("Chatroom Meetings/Room/Unrelated"), null);
});

test("ambiguous, linked or escaping aliases never substitute a saved Note", t => {
  const f = fixture(t), initial = f.store.noteGet(f.slug);
  f.store.noteUpsert({ ...initial, tags: [], content: "Saved body." });
  const saved = path.join(f.root, "notes", f.titleSlug + ".md"), duplicate = path.join(path.dirname(saved), "Duplicate.md");
  fs.copyFileSync(saved, duplicate);
  assert.throws(() => f.store.noteGet(f.slug), /ambiguous/i);
  fs.unlinkSync(duplicate);
  fs.symlinkSync(saved, f.original);
  assert.throws(() => f.store.noteGet(f.slug), /link/i);
  fs.unlinkSync(f.original);
  fs.renameSync(saved, path.join(f.root, "outside.md"));
  fs.symlinkSync(path.join(f.root, "outside.md"), saved);
  assert.throws(() => f.store.noteGet(f.slug), /link|regular/i);
  assert.throws(() => f.store.noteGet("../outside"), /path|relative/i);
});
