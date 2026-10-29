#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const assets = require("../dist/knowledge/markdown-assets");
const store = require("../dist/knowledge/filestore");
const { attachMarkdownAssetsToSyncBundle } = require("../dist/sync/sync-server");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-owned-assets-"));
const extension = path.resolve(__dirname, "..");
try {
  store.setStorePath(root);
  for (const area of ["skills", "notes", "papers"]) {
    const areaRoot = path.join(root, area);
    const write = (key, title, content, category) => {
      if (area === "skills") store.skillUpsert({ name: title, previousName: key.split("/").pop(), content, category });
      else if (area === "notes") store.noteUpsert({ slug: key, title, content, category, type: "general", tags: [] });
      else store.paperUpsert({ slug: key, title, content, category });
    };
    write("Team/Design", "Design", "Original", "Team");
    const relative = assets.saveMarkdownAsset(root, area, "Team/Design.md", "plot one.png", Buffer.from("image"));
    assert.equal(relative, "Design.assets/plot%20one.png");
    assert.throws(() => assets.saveMarkdownAsset(root, area, "Team/Design.md", "plot one.png", Buffer.from("overwrite")), /already exists/);
    assert.throws(() => assets.saveMarkdownAsset(root, area, "../escape.md", "x.png", Buffer.from("x")), /Invalid/);
    const special = assets.saveMarkdownAsset(root, area, "Team/Design.md", "plot(1)#one.png", Buffer.from("special"));
    assert.equal(special, "Design.assets/plot%281%29%23one.png");
    fs.appendFileSync(path.join(areaRoot, "Team", "Design.md"), "\n![nested [label]](Design.assets/plot(1)%23one.png)");
    assert.throws(() => assets.editMarkdownAsset(root, area, "Team/Design.md", "Team/Design.assets/plot(1)#one.png"), /referenced/);
    fs.writeFileSync(path.join(areaRoot, "Team", "Design.assets", "dangling"), "");
    fs.unlinkSync(path.join(areaRoot, "Team", "Design.assets", "dangling"));
    fs.symlinkSync(path.join(root, "missing-outside"), path.join(areaRoot, "Team", "Design.assets", "dangling"));
    assert.throws(() => assets.saveMarkdownAsset(root, area, "Team/Design.md", "dangling", Buffer.from("escape")), /Symbolic links/);
    fs.unlinkSync(path.join(areaRoot, "Team", "Design.assets", "dangling"));
    fs.unlinkSync(path.join(areaRoot, "Team", "Design.assets", "plot(1)#one.png"));
    fs.mkdirSync(path.join(areaRoot, "Team", "_assets"), { recursive: true });
    fs.writeFileSync(path.join(areaRoot, "Team", "_assets", "legacy.png"), "old-shared");
    const content = `![plot](${relative})\n![old](_assets/legacy.png)\n\`![code](${relative})\``;
    write("Team/Design", "Design", content, "Team");
    assets.saveMarkdownAsset(root, area, "Team/Design.md", "diagram.mmd", Buffer.from("graph LR\nA-->B"));
    assert(!store.folderList(area).some(folder => folder.includes(".assets")), "Resources are not content categories");
    assert.equal(assets.referencedMarkdownAssets(root, area, "Team/Design.md", content).length, 3, "Unreferenced owned diagrams travel with their document");

    store.knowledgeMarkdownCopy(area, "Team/Design.md", "Team/Copy.md");
    const copy = fs.readFileSync(path.join(areaRoot, "Team", "Copy.md"), "utf8");
    assert(copy.includes("Copy.assets/plot%20one.png"));
    assert(!copy.includes("_assets/legacy.png"), "A copied document owns its legacy attachments without rewriting the source");
    assert(fs.readFileSync(path.join(areaRoot, "Team", "Design.md"), "utf8").includes("_assets/legacy.png"));
    assert.equal(fs.readFileSync(path.join(areaRoot, "Team", "Copy.assets", "diagram.mmd"), "utf8"), "graph LR\nA-->B");
    assert.notEqual(store.parseStoreFrontmatter(copy).fm.knowledgeId,
      store.parseStoreFrontmatter(fs.readFileSync(path.join(areaRoot, "Team", "Design.md"), "utf8")).fm.knowledgeId);
    assert.throws(() => store.knowledgeMarkdownCopy(area, "Team/Design.md", "Team/Copy.md"), /already exist/);

    write("Team/Design", "Renamed", content, "Moved");
    const movedPath = path.join(areaRoot, "Moved", "Renamed.md");
    const moved = fs.readFileSync(movedPath, "utf8");
    assert(moved.includes("Renamed.assets/plot%20one.png"));
    assert(!moved.includes("../Team/_assets/legacy.png"), "Legacy resources migrate into the document's owned directory on move");
    assert.equal(assets.referencedMarkdownAssets(root, area, "Moved/Renamed.md", moved).filter(asset =>
      fs.readFileSync(asset.fullPath, "utf8") === "old-shared").length, 1);
    assert(!fs.existsSync(path.join(areaRoot, "Team", "_assets", "legacy.png")), "Both the copied and moved documents now own their attachment bytes");
    assert(moved.includes("`![code](Design.assets/plot%20one.png)`"));
    assert(fs.existsSync(path.join(areaRoot, "Moved", "Renamed.assets", "plot one.png")));
    assert(!fs.existsSync(path.join(areaRoot, "Team", "Design.assets")));

    fs.writeFileSync(path.join(areaRoot, "Other.md"), "![shared](Moved/Renamed.assets/plot%20one.png)");
    assert.throws(() => store.knowledgePathMoveToTrash(area, "Moved/Renamed.md"), /shared/);
    assert.throws(() => assets.editMarkdownAsset(root, area, "Moved/Renamed.md", "Moved/Renamed.assets/plot one.png", "new.png"), /shared/);
    fs.unlinkSync(path.join(areaRoot, "Other.md"));
    assets.editMarkdownAsset(root, area, "Moved/Renamed.md", "Moved/Renamed.assets/plot one.png", "new.png");
    assert(fs.readFileSync(movedPath, "utf8").includes("Renamed.assets/new.png"));
    assert.throws(() => assets.editMarkdownAsset(root, area, "Moved/Renamed.md", "Moved/Renamed.assets/new.png"), /referenced/);
    assets.editMarkdownAsset(root, area, "Moved/Renamed.md", "Moved/Renamed.assets/diagram.mmd");
    assert(!fs.existsSync(path.join(areaRoot, "Moved", "Renamed.assets", "diagram.mmd")));
    store.writeKnowledgeMarkdown(area, "Moved/Renamed.md", undefined, fs.readFileSync(movedPath, "utf8"));
    assert(store.knowledgeSyncDeletionRecords().some(record => record.path === `${area}/Moved/Renamed.assets/diagram.mmd`),
      "Saving the parent does not erase an earlier resource deletion intent");
    assert(store.knowledgeSyncDeletionRecords().some(record => record.path === `${area}/Moved/Renamed.assets/plot one.png`),
      "Resource rename records deletion of its previous path");

    const before = fs.readFileSync(movedPath);
    const entry = store.knowledgePathMoveToTrash(area, "Moved/Renamed.md");
    assert.equal(entry.assetsPath, "Moved/Renamed.assets");
    assert(!fs.existsSync(movedPath));
    assert(!fs.existsSync(path.join(areaRoot, "Moved", "Renamed.assets")));
    assert(store.knowledgeSyncDeletionRecords().some(record => record.path === `${area}/Moved/Renamed.assets/new.png`));
    const restore = () => area === "skills" ? store.skillTrashRestore(entry.id) : store.knowledgeTrashRestore(area, entry.id);
    const metadataPath = path.join(areaRoot, ".trash", entry.id, "metadata.json");
    const metadata = fs.readFileSync(metadataPath, "utf8");
    fs.writeFileSync(metadataPath, JSON.stringify({ ...JSON.parse(metadata), assetsPath: "Unrelated.assets" }));
    assert.equal(restore().ok, false, "Inconsistent resource ownership metadata cannot restore into an unrelated directory");
    assert(!fs.existsSync(movedPath), "Invalid metadata is rejected before restoring any document");
    fs.writeFileSync(metadataPath, metadata);
    fs.mkdirSync(path.join(areaRoot, "Moved", "Renamed.assets"), { recursive: true });
    assert.equal(restore().ok, false, "Resource collision does not partially restore a document");
    assert(!fs.existsSync(movedPath));
    fs.rmdirSync(path.join(areaRoot, "Moved", "Renamed.assets"));
    assert.equal(restore().ok, true);
    assert.deepEqual(fs.readFileSync(movedPath), before);
    assert(!store.knowledgeSyncDeletionRecords().some(record => record.path === `${area}/Moved/Renamed.assets/new.png`));
    assert(store.knowledgeSyncDeletionRecords().some(record => record.path === `${area}/Moved/Renamed.assets/diagram.mmd`),
      "Restoring the parent only restores resources in its payload, not previously deleted diagrams");
    assert(store.knowledgeSyncDeletionRecords().some(record => record.path === `${area}/Moved/Renamed.assets/plot one.png`));
    assets.saveMarkdownAsset(root, area, "Moved/Renamed.md", "diagram.mmd", Buffer.from("explicitly restored diagram"));
    assert(!store.knowledgeSyncDeletionRecords().some(record => record.path === `${area}/Moved/Renamed.assets/diagram.mmd`),
      "Explicit recreation cancels deletion intent for that resource");
    assert(store.knowledgeSyncDeletionRecords().some(record => record.path === `${area}/Moved/Renamed.assets/plot one.png`),
      "Recreating one resource does not cancel another resource's deletion intent");
    assets.editMarkdownAsset(root, area, "Moved/Renamed.md", "Moved/Renamed.assets/diagram.mmd");

    fs.writeFileSync(path.join(areaRoot, "Team", "_assets", "manual.png"), "manual migration");
    fs.appendFileSync(movedPath, "\n![manual](../Team/_assets/manual.png)");
    const preview = assets.previewMarkdownAssetMigration(root, area, "Moved/Renamed.md");
    assert.equal(preview.copies.length, 1);
    fs.appendFileSync(movedPath, "\nNew edit");
    assert.throws(() => assets.applyMarkdownAssetMigration(root, preview), /changed after/);
    const fresh = assets.previewMarkdownAssetMigration(root, area, "Moved/Renamed.md");
    assets.applyMarkdownAssetMigration(root, fresh);
    assert(!fs.existsSync(path.join(areaRoot, "Team", "_assets", "legacy.png")), "Later migration does not resurrect an earlier orphan");
    assert(!fs.existsSync(path.join(areaRoot, "Team", "_assets", "manual.png")), "Migration removes an original once its last reference is owned");
    assert(store.knowledgeSyncDeletionRecords().some(record => record.path === `${area}/Team/_assets/manual.png`));
    assert(!fs.readFileSync(movedPath, "utf8").includes("../Team/_assets/legacy.png"));

    const result = store.storeEntryMove(area, "Moved/Renamed.md", "Final");
    assert.equal(result.ok, true, result.error);
    assert(fs.existsSync(path.join(areaRoot, "Final", "Renamed.assets", "new.png")));
    assert(fs.readFileSync(path.join(areaRoot, "Final", "Renamed.md"), "utf8").includes("Renamed.assets/new.png"));
    const bridge = execFileSync(process.execPath,
      [path.join(extension, "resources/knowledge_mutations.js"), extension, root],
      { input: JSON.stringify({ operation: "write-markdown", area, path: "Bridge/Renamed.md", previous: "Final/Renamed.md",
        content: fs.readFileSync(path.join(areaRoot, "Final", "Renamed.md"), "utf8") }), encoding: "utf8" });
    assert.equal(JSON.parse(bridge).ok, true);
    assert(fs.existsSync(path.join(areaRoot, "Bridge", "Renamed.assets", "new.png")), "MCP and UI share the resource move implementation");
    fs.symlinkSync(path.join(root, "outside"), path.join(areaRoot, "Bridge", "Renamed.assets", "linked"));
    assert.throws(() => assets.referencedMarkdownAssets(root, area, "Bridge/Renamed.md", ""), /Symbolic links/);
    fs.unlinkSync(path.join(areaRoot, "Bridge", "Renamed.assets", "linked"));
    const bundle = attachMarkdownAssetsToSyncBundle(area === "skills"
      ? { skills: [{ name: "Renamed", metadata: { category: "Bridge" }, content: fs.readFileSync(path.join(areaRoot, "Bridge", "Renamed.md"), "utf8") }] }
      : { [area]: [{ slug: "Bridge/Renamed", title: "Renamed", category: "Bridge", content: fs.readFileSync(path.join(areaRoot, "Bridge", "Renamed.md"), "utf8") }] });
    assert(bundle.assets.some(asset => asset.path === "Bridge/Renamed.assets/new.png"), "All types export the exact document path, without duplicating Research categories");
    const importRoot = path.join(root, "isolated-import");
    assets.importMarkdownAssetBundle(importRoot, bundle.assets, assets.markdownBundleDocuments(bundle), "Incoming");
    assert.equal(fs.readFileSync(path.join(importRoot, area, "Incoming", "Bridge", "Renamed.assets", "new.png"), "utf8"), "image");
    const invalid = JSON.parse(JSON.stringify(bundle.assets)); invalid[0].digest = "sha256:invalid";
    assert.throws(() => assets.importMarkdownAssetBundle(importRoot, invalid, assets.markdownBundleDocuments(bundle)), /checksum/);
    const foreign = JSON.parse(JSON.stringify(bundle.assets)); foreign[0].path = "Other.assets/private.png";
    assert.throws(() => assets.importMarkdownAssetBundle(importRoot, foreign, assets.markdownBundleDocuments(bundle)), /not owned/);
    const removed = store.knowledgePathMoveToTrash(area, "Bridge/Renamed.md");
    const deletion = area === "skills" ? store.skillTrashDelete(removed.id) : store.knowledgeTrashDelete(area, removed.id);
    assert.equal(deletion.ok, true);
    assert(!fs.existsSync(path.join(areaRoot, ".trash", removed.id)));
    const folder = store.storeEntryMove(area, "Team", "Archive");
    assert.equal(folder.ok, true, folder.error);
    assert(fs.existsSync(path.join(areaRoot, "Archive", "Team", "Copy.assets", "plot one.png")));
    assert(fs.readFileSync(path.join(areaRoot, "Archive", "Team", "Copy.md"), "utf8").includes("Copy.assets/"));
    assert(!fs.existsSync(path.join(areaRoot, "Archive", "Team", "_assets", "legacy.png")));
    const promotion = store.folderDeletePromote(area, "Archive/Team");
    assert.equal(promotion.ok, true, promotion.error);
    assert(fs.existsSync(path.join(areaRoot, "Archive", "Copy.assets", "plot one.png")));
    assert(!fs.existsSync(path.join(areaRoot, "Archive", "_assets", "legacy.png")));
    assert(fs.readFileSync(path.join(areaRoot, "Archive", "Copy.md"), "utf8").includes("Copy.assets/"));
  }
  const bundle = attachMarkdownAssetsToSyncBundle({ notes: [{ slug: "Archive/Copy", content: "![plot](Copy.assets/plot%20one.png)" }] });
  assert(bundle.assets.some(asset => asset.path === "Archive/Copy.assets/diagram.mmd"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("Owned Markdown resources: all three content types, copy/move/rename, shared guards, Trash/restore, preview/apply, MCP bridge and bundle transport OK");
