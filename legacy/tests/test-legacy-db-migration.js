const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const initSqlJs = require("sql.js");
const { migrateDbToFiles } = require("../dist/knowledge/migrate");
const { setStorePath } = require("../dist/knowledge/filestore");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-legacy-db-"));
  try {
    const SQL = await initSqlJs();
    function database(directory) {
      fs.mkdirSync(directory, { recursive: true });
      const db = new SQL.Database();
      db.run("CREATE TABLE skills(name,content,description,category,tags,source_project)");
      db.run("CREATE TABLE notes(slug,title,content,type,category,tags)");
      db.run("INSERT INTO skills VALUES ('Old','legacy body','','General','[]',NULL)");
      db.run("INSERT INTO notes VALUES ('Old note','Old note','legacy note','general','','[]')");
      fs.writeFileSync(path.join(directory, "knowledge.db"), db.export());
      db.close();
    }
    const populated = path.join(root, "populated");
    database(populated);
    fs.mkdirSync(path.join(populated, "skills", "Research"), { recursive: true });
    const existing = path.join(populated, "skills", "Research", "Important.md");
    fs.writeFileSync(existing, "Private current skill\n");
    setStorePath(populated);
    assert.deepEqual(await migrateDbToFiles(path.resolve(__dirname, "..")), { migrated: false, skills: 0, notes: 0 });
    assert.equal(fs.readFileSync(existing, "utf8"), "Private current skill\n");
    assert(!fs.existsSync(path.join(populated, "skills", "General", "Old.md")));
    assert(!fs.readdirSync(populated).some(name => name.startsWith("_pre-files-backup-")));
    const notesOnly = path.join(root, "notes-only");
    database(notesOnly);
    fs.mkdirSync(path.join(notesOnly, "notes"), { recursive: true });
    fs.writeFileSync(path.join(notesOnly, "notes", "Private.md"), "Keep private notes\n");
    setStorePath(notesOnly);
    assert.equal((await migrateDbToFiles(path.resolve(__dirname, ".."))).migrated, false);
    assert.equal(fs.readFileSync(path.join(notesOnly, "notes", "Private.md"), "utf8"), "Keep private notes\n");
    const hidden = path.join(root, "hidden-content");
    database(hidden);
    fs.mkdirSync(path.join(hidden, "notes", ".private"), { recursive: true });
    fs.writeFileSync(path.join(hidden, "notes", ".private", "Keep.md"), "Hidden content\n");
    setStorePath(hidden);
    assert.equal((await migrateDbToFiles(path.resolve(__dirname, ".."))).migrated, false);
    assert.equal(fs.readFileSync(path.join(hidden, "notes", ".private", "Keep.md"), "utf8"), "Hidden content\n");
    const linked = path.join(root, "linked-content");
    database(linked);
    fs.symlinkSync(path.join(hidden, "notes"), path.join(linked, "notes"), "junction");
    setStorePath(linked);
    assert.equal((await migrateDbToFiles(path.resolve(__dirname, ".."))).migrated, false);
    const empty = path.join(root, "empty");
    database(empty);
    setStorePath(empty);
    assert.deepEqual(await migrateDbToFiles(path.resolve(__dirname, "..")), { migrated: true, skills: 1, notes: 1 });
    assert(fs.existsSync(path.join(empty, "knowledge.db")), "legacy database remains intact");
    assert.equal((await migrateDbToFiles(path.resolve(__dirname, ".."))).migrated, false);
    console.log("Legacy DB migration: existing Skills/Notes are never renamed or replaced; empty-store migration and repeat activation pass");
  } finally {
    setStorePath("");
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
