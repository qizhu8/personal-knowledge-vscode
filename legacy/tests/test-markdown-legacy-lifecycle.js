const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assets = require("../dist/knowledge/markdown-assets");
const store = require("../dist/knowledge/filestore");

for (const area of ["notes", "papers", "skills"]) {
  test(`${area}: shared legacy assets become owned and follow Trash, restore and permanent deletion`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-legacy-lifecycle-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    store.setStorePath(root);
    const areaRoot = path.join(root, area);
    fs.mkdirSync(path.join(areaRoot, "Team", "_assets"), { recursive: true });
    const legacy = path.join(areaRoot, "Team", "_assets", "shared.png");
    const bytes = Buffer.from([137, 80, 78, 71, 9, 7]);
    fs.writeFileSync(legacy, bytes);
    for (const title of ["First", "Second"]) {
      fs.writeFileSync(path.join(areaRoot, "Team", `${title}.md`), `---\n${area === "skills" ? "name" : "title"}: ${title}\n---\n![plot](_assets/shared.png)\n`);
    }
    const first = store.knowledgePathMoveToTrash(area, "Team/First.md");
    assert(first, "Trash must return an actual entry");
    assert.equal(first.assetsPath, "Team/First.assets");
    assert(fs.existsSync(legacy), "The second document still needs the original");
    assert(!fs.existsSync(path.join(areaRoot, "Team", "First.assets")));
    const restore = entry => area === "skills" ? store.skillTrashRestore(entry.id) : store.knowledgeTrashRestore(area, entry.id);
    const remove = entry => area === "skills" ? store.skillTrashDelete(entry.id) : store.knowledgeTrashDelete(area, entry.id);
    assert.equal(restore(first).ok, true);
    const restored = fs.readFileSync(path.join(areaRoot, "Team", "First.md"), "utf8");
    assert(!restored.includes("_assets/shared.png"));
    const owned = assets.referencedMarkdownAssets(root, area, "Team/First.md", restored);
    assert.equal(owned.length, 1);
    assert.deepEqual(fs.readFileSync(owned[0].fullPath), bytes);
    const second = store.knowledgePathMoveToTrash(area, "Team/Second.md");
    assert(second);
    assert(!fs.existsSync(legacy), "The last legacy reference is now owned, so the old file is removed");
    assert(store.knowledgeSyncDeletionRecords().some(record => record.path === `${area}/Team/_assets/shared.png`));
    assert.equal(restore(second).ok, true);
    assert(!fs.existsSync(legacy), "Restore uses the owned payload, never resurrects the orphan legacy path");
    for (const title of ["First", "Second"]) {
      const entry = store.knowledgePathMoveToTrash(area, `Team/${title}.md`);
      assert.equal(remove(entry).ok, true);
      assert(!fs.existsSync(path.join(areaRoot, ".trash", entry.id)));
      assert(!fs.existsSync(path.join(areaRoot, "Team", `${title}.assets`)));
    }
  });
}

test("missing legacy sources and destination collisions fail before a move destroys data", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-legacy-preflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.setStorePath(root);
  const document = path.join(root, "notes", "Team", "Design.md");
  fs.mkdirSync(path.dirname(document), { recursive: true });
  fs.writeFileSync(document, "![plot](_assets/missing.png)\n");
  const before = fs.readFileSync(document);
  const missing = store.storeEntryMove("notes", "Team/Design.md", "Archive");
  assert.equal(missing.ok, false);
  assert.match(missing.error, /ENOENT/);
  assert.deepEqual(fs.readFileSync(document), before);
  assert(!fs.existsSync(path.join(root, "notes", "Archive", "Design.md")));
  fs.mkdirSync(path.join(root, "notes", "Team", "_assets"));
  fs.writeFileSync(path.join(root, "notes", "Team", "_assets", "missing.png"), "preserved");
  fs.mkdirSync(path.join(root, "notes", "Archive", "Design.assets"), { recursive: true });
  const collision = store.storeEntryMove("notes", "Team/Design.md", "Archive");
  assert.equal(collision.ok, false);
  assert.match(collision.error, /target already exists/);
  assert.deepEqual(fs.readFileSync(document), before);
  assert(!fs.existsSync(path.join(root, "notes", "Team", "Design.assets")));
});

test("historical broken references require an explicit hash-bound source and migrate the real asset", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-legacy-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const documentPath = "Archive/BrainStorm/Design.md";
  const document = path.join(root, "notes", documentPath);
  const sourcePath = "Original/_assets/plot.png";
  const source = path.join(root, "notes", sourcePath);
  fs.mkdirSync(path.dirname(document), { recursive: true });
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(document, "![plot](_assets/plot.png)\n");
  fs.writeFileSync(source, "known original image");
  const missing = assets.missingLegacyMarkdownAssets(root, "notes", documentPath, fs.readFileSync(document, "utf8"));
  assert.deepEqual(missing, ["Archive/BrainStorm/_assets/plot.png"]);
  assert.throws(() => assets.previewMarkdownAssetMigration(root, "notes", documentPath), /ENOENT/);
  assert.throws(() => assets.previewMarkdownAssetMigration(root, "notes", documentPath, { [missing[0]]: "Other.md" }), /resource directory/);
  const preview = assets.previewMarkdownAssetMigration(root, "notes", documentPath, { [missing[0]]: sourcePath });
  const before = fs.readFileSync(document);
  fs.appendFileSync(source, "changed");
  assert.throws(() => assets.applyMarkdownAssetMigration(root, preview), /changed after/);
  assert.deepEqual(fs.readFileSync(document), before);
  fs.writeFileSync(source, "known original image");
  assets.applyMarkdownAssetMigration(root, preview);
  assert(!fs.existsSync(source));
  assert(fs.readFileSync(document, "utf8").includes("Design.assets/"));
  const owned = assets.referencedMarkdownAssets(root, "notes", documentPath, fs.readFileSync(document, "utf8"));
  assert.equal(owned.length, 1);
  assert.equal(fs.readFileSync(owned[0].fullPath, "utf8"), "known original image");
  const { readKnowledgeSyncDeletions } = require("../dist/knowledge/knowledge-deletion-journal");
  assert(readKnowledgeSyncDeletions(root).some(item => item.path === `notes/${sourcePath}`));
  fs.writeFileSync(path.join(root, "notes", "Other.md"), "An owned, unattached source diagram must still be preserved.\n");
  const ownedSource = path.join(root, "notes", "Other.assets", "owned.png");
  fs.mkdirSync(path.dirname(ownedSource));
  fs.writeFileSync(ownedSource, "another document's owned source");
  fs.appendFileSync(document, "![second](_assets/owned.png)\n");
  const second = assets.previewMarkdownAssetMigration(root, "notes", documentPath, {
    "Archive/BrainStorm/_assets/owned.png": "Other.assets/owned.png",
  });
  assert.deepEqual(second.removals, [], "Implicit document ownership protects even an unattached resource");
  assets.applyMarkdownAssetMigration(root, second);
  assert.equal(fs.readFileSync(ownedSource, "utf8"), "another document's owned source");
});
