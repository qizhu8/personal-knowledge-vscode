import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile, writeFile, readdir, mkdir, rename, symlink, lstat, stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { encodeMarkdown, decodeMarkdown, scanMarkdown, sha256 } from "../dist/markdown.js";

const actor = { id: "local:owner", canWrite: true };
const invocation = (operation, args) => ({ operation, version: 1, arguments: args });
async function fixture(t) {
  const parent = join(dirname(fileURLToPath(import.meta.url)), `.markdown-${randomUUID()}`);
  await mkdir(parent, { recursive: true });
  const directory = join(parent, "workspace");
  await initialize(directory);
  const stores = [];
  t.after(async () => {
    try { for (const store of stores) await store.close(); }
    finally { await rm(parent, { recursive: true, force: true }); }
  });
  async function open() {
    const storage = await Storage.open(directory); stores.push(storage);
    return { storage, call: (method, operation, args) => new Core(storage).dispatch(method, invocation(operation, args), actor) };
  }
  return { directory, open };
}
test("Markdown scanning preserves unchanged records and detects same-size edits with restored mtime", async t => {
  const { directory } = await fixture(t);
  const path = join(directory, "notes/cached.md");
  const original = encodeMarkdown("cached", "Cached", "before", 1, false);
  await writeFile(path, original);
  const first = scanMarkdown(directory);
  const second = scanMarkdown(directory);
  assert.deepEqual(second[0].record, first[0].record);

  const before = await stat(path);
  await writeFile(path, original.replace("before", "after!"));
  await utimes(path, before.atime, before.mtime);
  const third = scanMarkdown(directory);
  assert.notEqual(second[0], third[0]);
  assert.equal(third[0].record.content, "after!");
});

test("Markdown documents can be read and written above the former size limits", async t => {
  const { directory, open } = await fixture(t);
  const { storage, call } = await open();
  const content = "x".repeat(1_100_000);
  const created = await call("capability_call", "knowledge.document.create", {
    id: "large", operationId: randomUUID(), title: "Large", content,
  });
  assert.equal(created.error, undefined);
  const read = await call("capability_read", "knowledge.document.get", { id: "large" });
  assert.equal(read.result.content.length, content.length);
  assert.equal(scanMarkdown(directory)[0].record.content.length, content.length);
  await storage.close();
});

test("unchanged scans skip SQL index rebuilds while external same-size edits reindex", async t => {
  const { directory, open } = await fixture(t);
  const { storage, call } = await open();
  await call("capability_call", "knowledge.document.create", {
    id: "indexed", operationId: randomUUID(), title: "Indexed", content: "before",
  });
  let db = new DatabaseSync(join(directory, "core.sqlite"));
  db.exec(`CREATE TABLE index_rebuilds(count INTEGER);
    INSERT INTO index_rebuilds VALUES(0);
    CREATE TRIGGER count_index_rebuild AFTER DELETE ON documents
    BEGIN UPDATE index_rebuilds SET count=count+1; END;`);
  db.close();

  await call("capability_read", "knowledge.document.get", { id: "indexed" });
  db = new DatabaseSync(join(directory, "core.sqlite"));
  assert.equal(db.prepare("SELECT count FROM index_rebuilds").get().count, 0);
  db.close();

  const path = join(directory, "notes/indexed.md");
  const before = await stat(path);
  const original = await readFile(path, "utf8");
  await writeFile(path, original.replace("before", "after!"));
  await utimes(path, before.atime, before.mtime);
  const updated = await call("capability_read", "knowledge.document.get", { id: "indexed" });
  assert.equal(updated.result.content, "after!");
  db = new DatabaseSync(join(directory, "core.sqlite"));
  assert.equal(db.prepare("SELECT count FROM index_rebuilds").get().count, 1);
  db.close();
  await storage.close();
});

test("Markdown is authoritative: unknown YAML metadata/comments/identity survive edits; external edits invalidate digest CAS", async t => {
  const { directory, open } = await fixture(t);
  const { storage, call } = await open();
  const created = await call("capability_call", "knowledge.document.create", { id: "a", operationId: randomUUID(), title: "A", content: "original" });
  assert.equal(created.result.sha256, sha256(await readFile(join(directory, "notes/a.md"), "utf8")));
  const path = join(directory, "notes/a.md");
  const raw = await readFile(path, "utf8");
  const original = decodeMarkdown("a", raw);
  const enriched = raw.replace("title:", "# Keep this comment\ncustom:\n  nested:\n    - first\n    - second\ncreatedAt: '2021-01-01'\ntitle:");
  await writeFile(path, enriched);
  const stale = await call("capability_call", "knowledge.document.update", {
    id: "a", operationId: randomUUID(), expectedRevision: 1, expectedSha256: created.result.sha256, title: "No overwrite", content: "must not commit",
  });
  assert.equal(stale.error.code, "CONFLICT");
  assert.equal(await readFile(path, "utf8"), enriched);
  const current = (await call("capability_read", "knowledge.document.get", { id: "a" })).result;
  assert.equal(current.revision, 1, "reading/indexing must not rewrite authoritative metadata");
  const updated = await call("capability_call", "knowledge.document.update", {
    id: "a", operationId: randomUUID(), expectedRevision: current.revision, expectedSha256: current.sha256, title: "Edited", content: "edited",
  });
  assert.equal(updated.result.revision, 2);
  const after = await readFile(path, "utf8");
  assert(after.includes("# Keep this comment"));
  const metadata = decodeMarkdown("a", after).metadata.toJS();
  assert.deepEqual(metadata.custom, { nested: ["first", "second"] });
  assert.equal(metadata.createdAt, "2021-01-01");
  assert.equal(metadata.knowledgeId, original.metadata.get("knowledgeId"));
  assert.deepEqual(metadata.aliases, original.metadata.get("aliases").toJSON());
  await writeFile(path, after.replace("edited", "external body"));
  assert.equal((await call("capability_read", "knowledge.document.get", { id: "a" })).result.content, "external body");
  await storage.close();
});

test("rebuildable SQL index cannot override Markdown; index reconstruction preserves durable receipts", async t => {
  const { directory, open } = await fixture(t);
  const first = await open();
  const args = { id: "a", operationId: randomUUID(), title: "Truth", content: "Markdown body" };
  const created = (await first.call("capability_call", "knowledge.document.create", args)).result;
  await first.storage.close();
  const db = new DatabaseSync(join(directory, "core.sqlite"));
  db.exec("DROP TABLE documents");
  db.close();
  const second = await open();
  assert.deepEqual((await second.call("capability_read", "knowledge.document.get", { id: "a" })).result, created);
  assert.deepEqual((await second.call("capability_call", "knowledge.document.create", args)).result, created);
  await second.storage.close();
  const check = new DatabaseSync(join(directory, "core.sqlite"));
  assert(!check.prepare("PRAGMA table_info(documents)").all().some(column => column.name === "content"));
  assert.equal(check.prepare("SELECT title FROM documents WHERE id='a'").get().title, "Truth");
  check.close();
});

for (const stage of ["intent-committed", "temporary-written", "markdown-replaced"]) {
  test(`journal recovery at ${stage} finalizes exactly one result and keeps stable identity`, async t => {
    const { directory, open } = await fixture(t);
    const initial = await open(); await initial.storage.close();
    const args = { operationId: randomUUID(), id: "recover", title: "Recovery", content: "journaled" };
    const request = { operation: "knowledge.document.create", actorId: actor.id, args };
    const raw = encodeMarkdown(args.id, args.title, args.content, 1, false);
    const result = decodeMarkdown(args.id, raw).record;
    const db = new DatabaseSync(join(directory, "core.sqlite"));
    db.prepare("INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,document_id,before_sha256,after_markdown) VALUES(1,?,?,?,?,?,?,?)").run(
      args.operationId, sha256(JSON.stringify(request)), actor.id, request.operation, args.id, null, raw,
    );
    db.close();
    if (stage === "temporary-written") await writeFile(join(directory, `notes/.pkm-write-${args.operationId}`), "partial interrupted bytes");
    if (stage === "markdown-replaced") await writeFile(join(directory, `notes/${args.id}.md`), raw);
    const recovered = await open();
    assert.deepEqual((await recovered.call("capability_read", "knowledge.document.get", { id: args.id })).result, result);
    assert.deepEqual((await recovered.call("capability_call", request.operation, args)).result, result);
    assert.equal(await readFile(join(directory, `notes/${args.id}.md`), "utf8"), raw);
    assert.deepEqual(await readdir(join(directory, "notes")), [`${args.id}.md`]);
    await recovered.storage.close();
    const check = new DatabaseSync(join(directory, "core.sqlite"));
    assert.equal(check.prepare("SELECT count(*) AS total FROM pending_write").get().total, 0);
    assert.equal(check.prepare("SELECT count(*) AS total FROM receipts").get().total, 1);
    check.close();
  });
}

test("recovery never overwrites an external edit and retains its pending intent for reconciliation", async t => {
  const { directory, open } = await fixture(t);
  const initial = await open(); await initial.storage.close();
  const pending = encodeMarkdown("conflict", "Pending", "pending body", 1, false);
  const external = encodeMarkdown("conflict", "External", "keep me", 1, false);
  const db = new DatabaseSync(join(directory, "core.sqlite"));
  db.prepare("INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,document_id,before_sha256,after_markdown) VALUES(1,?,?,?,?,?,?,?)").run(
    randomUUID(), "a".repeat(64), actor.id, "knowledge.document.create", "conflict", null, pending,
  );
  db.close();
  await writeFile(join(directory, "notes/conflict.md"), external);
  await assert.rejects(Storage.open(directory), /changed outside the server/);
  assert.equal(await readFile(join(directory, "notes/conflict.md"), "utf8"), external);
  const check = new DatabaseSync(join(directory, "core.sqlite"));
  assert.equal(check.prepare("SELECT count(*) AS total FROM pending_write").get().total, 1);
  check.close();
});

test("invalid Markdown is reported, not silently replaced or served from a stale SQL cache", async t => {
  const { directory, open } = await fixture(t);
  const { call } = await open();
  await call("capability_call", "knowledge.document.create", { id: "a", operationId: randomUUID(), title: "A", content: "valid" });
  const path = join(directory, "notes/a.md");
  await writeFile(path, "---\ntitle: [broken\n---\ninvalid");
  const result = await call("capability_read", "knowledge.document.get", { id: "a" });
  assert.equal(result.error.code, "INVALID_DOCUMENT");
  assert.equal(await readFile(path, "utf8"), "---\ntitle: [broken\n---\ninvalid");
});

test("database-only v1 workspaces are refused without modifying or discarding their files", async t => {
  const { directory } = await fixture(t);
  const marker = join(directory, ".pkm-next-workspace");
  const identity = { schema: "pkm.next-workspace/v1", id: randomUUID() };
  await writeFile(marker, JSON.stringify(identity));
  const before = (await readdir(directory)).sort();
  await assert.rejects(Storage.open(directory), /not automatically adopted/);
  assert.deepEqual((await readdir(directory)).sort(), before);
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), identity);
});

test("external file creation/deletion changes workspace page revision without rewriting metadata", async t => {
  const { directory, open } = await fixture(t);
  const { call } = await open();
  const first = (await call("capability_read", "knowledge.document.list", {})).result;
  const raw = encodeMarkdown("external", "Editor", "created outside server", 1, false);
  const path = join(directory, "notes/external.md");
  await writeFile(path, raw);
  const changed = await call("capability_read", "knowledge.document.list", { workspaceRevision: first.workspaceRevision });
  assert.equal(changed.error.code, "CONFLICT");
  const current = (await call("capability_read", "knowledge.document.list", {})).result;
  assert.equal(current.total, 1);
  assert.equal(await readFile(path, "utf8"), raw);
  await rm(path);
  assert.equal((await call("capability_read", "knowledge.document.list", { workspaceRevision: current.workspaceRevision })).error.code, "CONFLICT");
  assert.equal((await call("capability_read", "knowledge.document.get", { id: "external" })).error.code, "NOT_FOUND");
});

test("nested Unicode Markdown paths keep stable identities across external moves and preserve path aliases", async t => {
  const { directory, open } = await fixture(t);
  const { call } = await open();
  const path = "Research/Architecture/\u8bbe\u8ba1\u7b14\u8bb0.md";
  const created = (await call("capability_call", "knowledge.document.create", {
    id: "stable-note", path, operationId: randomUUID(), title: "Nested note", content: "Authoritative body",
  })).result;
  assert.equal(created.path, path);
  const original = decodeMarkdown(created.id, await readFile(join(directory, "notes", path), "utf8"), path);
  assert(original.metadata.toJS().aliases.includes(`note:${path.slice(0, -3)}`));
  const before = (await call("capability_read", "knowledge.document.list", {})).result;
  await mkdir(join(directory, "notes/Archive"), { recursive: true });
  const nextPath = "Archive/Renamed.md";
  await rename(join(directory, "notes", path), join(directory, "notes", nextPath));
  assert.equal((await call("capability_read", "knowledge.document.list", { workspaceRevision: before.workspaceRevision })).error.code, "CONFLICT");
  const moved = (await call("capability_read", "knowledge.document.get", { id: created.id })).result;
  assert.equal(moved.id, created.id);
  assert.equal(moved.path, nextPath);
  const updated = (await call("capability_call", "knowledge.document.update", {
    id: moved.id, operationId: randomUUID(), expectedRevision: moved.revision, expectedSha256: moved.sha256,
    title: "Still same identity", content: "Updated",
  })).result;
  assert.equal(updated.path, nextPath);
  const after = decodeMarkdown(updated.id, await readFile(join(directory, "notes", nextPath), "utf8"), nextPath);
  assert.equal(after.metadata.get("knowledgeId"), original.metadata.get("knowledgeId"));
  assert(after.metadata.toJS().aliases.includes(`note:${path.slice(0, -3)}`));
  assert(after.metadata.toJS().aliases.includes("note:Archive/Renamed"));
});

test("legacy nested Notes and plain Markdown are indexed without being silently rewritten", async t => {
  const { directory, open } = await fixture(t);
  await mkdir(join(directory, "notes/Research/PKM"), { recursive: true });
  const legacy = "---\ntitle: Existing\nknowledgeId: knowledge_0123456789abcdef01234567\ntags: [architecture]\ncustom:\n  preserve: true\n---\nLegacy body";
  await writeFile(join(directory, "notes/Research/PKM/Existing.md"), legacy);
  const plain = "# Plain Note\nNo frontmatter";
  await writeFile(join(directory, "notes/Research/PKM/Plain note.md"), plain);
  const { call } = await open();
  const listing = (await call("capability_read", "knowledge.document.list", {})).result;
  assert.equal(listing.total, 2);
  const record = (await call("capability_read", "knowledge.document.get", { id: "knowledge_0123456789abcdef01234567" })).result;
  assert.equal(record.path, "Research/PKM/Existing.md");
  assert.equal(record.revision, 1);
  assert.equal(record.deleted, false);
  assert.equal(await readFile(join(directory, "notes/Research/PKM/Existing.md"), "utf8"), legacy);
  const plainRecord = listing.items.find(item => item.path.endsWith("Plain note.md"));
  assert(plainRecord.id.startsWith("legacy_"));
  assert.equal((await call("capability_read", "knowledge.document.get", { id: plainRecord.id })).result.content, plain);
  assert.equal(await readFile(join(directory, "notes/Research/PKM/Plain note.md"), "utf8"), plain);
  const updated = await call("capability_call", "knowledge.document.update", {
    id: record.id, expectedRevision: record.revision, expectedSha256: record.sha256,
    operationId: randomUUID(), title: "Existing", content: "Explicit edit",
  });
  assert.equal(updated.result.revision, 2);
  const metadata = decodeMarkdown(record.id, await readFile(join(directory, "notes", record.path), "utf8"), record.path).metadata.toJS();
  assert.deepEqual(metadata.tags, ["architecture"]);
  assert.deepEqual(metadata.custom, { preserve: true });
  assert.equal(metadata.knowledgeId, record.id);
});

test("nested document creation validates path contracts, ownership and System protection before dispatching a write", async t => {
  const { directory, open } = await fixture(t); const { call } = await open();
  for (const path of ["../escape.md", "/absolute.md", "a//b.md", "a\\b.md", "a/.hidden.md", "CON.md", "a/nul.md", "a.assets/escape.md", "a./b.md"]) {
    const result = await call("capability_call", "knowledge.document.create", {
      id: "rejected", path, operationId: randomUUID(), title: "No", content: "must not write",
    });
    assert.equal(result.error.code, "INVALID_ARGUMENT", path);
  }
  const system = await call("capability_call", "knowledge.document.create", {
    id: "system", path: "System/Protected.md", operationId: randomUUID(), title: "No", content: "must not write",
  });
  assert.equal(system.error.code, "ACCESS_DENIED");
  await call("capability_call", "knowledge.document.create", {
    id: "one", path: "Folder/Existing.md", operationId: randomUUID(), title: "One", content: "keep me",
  });
  assert.equal((await call("capability_call", "knowledge.document.create", {
    id: "two", path: "Folder/Existing.md", operationId: randomUUID(), title: "Two", content: "overwrite",
  })).error.code, "CONFLICT");
  await symlink(join(directory, "notes/Folder"), join(directory, "notes/linked"), "dir");
  assert.equal((await call("capability_read", "knowledge.document.list", {})).error.code, "INVALID_DOCUMENT");
});

test("duplicate knowledge/document identities fail closed rather than selecting a filename arbitrarily", async t => {
  const { directory, open } = await fixture(t);
  const { call } = await open();
  await call("capability_call", "knowledge.document.create", { id: "a", operationId: randomUUID(), title: "A", content: "original" });
  const raw = await readFile(join(directory, "notes/a.md"), "utf8");
  await mkdir(join(directory, "notes/Copy"), { recursive: true });
  await writeFile(join(directory, "notes/Copy/Duplicate.md"), raw);
  const result = await call("capability_read", "knowledge.document.get", { id: "a" });
  assert.equal(result.error.code, "CONFLICT");
  assert.equal(await readFile(join(directory, "notes/a.md"), "utf8"), raw);
  assert.equal(await readFile(join(directory, "notes/Copy/Duplicate.md"), "utf8"), raw);
});

test("editing identity-less plain Markdown establishes persistent identity without changing its body on reads", async t => {
  const { directory, open } = await fixture(t);
  await mkdir(join(directory, "notes/Legacy"), { recursive: true });
  const path = "Legacy/Plain.md", raw = "# Original\nContent without metadata";
  await writeFile(join(directory, "notes", path), raw);
  const first = await open();
  const record = (await first.call("capability_read", "knowledge.document.list", {})).result.items[0];
  const updated = (await first.call("capability_call", "knowledge.document.update", {
    operationId: randomUUID(), id: record.id, expectedRevision: record.revision, expectedSha256: record.sha256,
    title: "Now explicit", content: raw,
  })).result;
  assert.equal(updated.content, raw);
  const persisted = decodeMarkdown(record.id, await readFile(join(directory, "notes", path), "utf8"), path);
  assert.match(persisted.metadata.get("knowledgeId"), /^knowledge_[a-f0-9]{24}$/);
  assert.equal(persisted.metadata.get("documentId"), record.id);
  assert.deepEqual(persisted.metadata.toJS().aliases, ["note:Legacy/Plain", `note:${record.id}`].sort());
  await first.storage.close();
  await rename(join(directory, "notes", path), join(directory, "notes/Legacy/Moved.md"));
  const second = await open();
  const moved = (await second.call("capability_read", "knowledge.document.get", { id: record.id })).result;
  assert.equal(moved.id, record.id);
  assert.equal(moved.path, "Legacy/Moved.md");
  assert.equal(moved.sha256, updated.sha256);
});

test("invalid legacy aliases are reported before committing an intent or replacing metadata", async t => {
  const { directory, open } = await fixture(t);
  const { call, storage } = await open();
  const raw = "---\ntitle: Legacy\naliases: [valid, 42]\ncustom: preserve\n---\nBody";
  await writeFile(join(directory, "notes/legacy.md"), raw);
  const current = (await call("capability_read", "knowledge.document.get", { id: "legacy" })).result;
  const result = await call("capability_call", "knowledge.document.update", {
    operationId: randomUUID(), id: current.id, expectedRevision: current.revision, expectedSha256: current.sha256,
    title: "Do not replace", content: "No",
  });
  assert.equal(result.error.code, "INVALID_DOCUMENT");
  assert.equal(result.error.effect, "not-committed");
  assert.equal(await readFile(join(directory, "notes/legacy.md"), "utf8"), raw);
  await storage.close();
  const check = new DatabaseSync(join(directory, "core.sqlite"));
  try { assert.equal(check.prepare("SELECT count(*) AS total FROM pending_write").get().total, 0); }
  finally { check.close(); }
});

for (const stage of ["intent-committed", "temporary-written", "markdown-replaced"]) {
  test(`nested journal recovery at ${stage} restores the intended path and exact retry receipt`, async t => {
    const { directory, open } = await fixture(t);
    const first = await open(); await first.storage.close();
    const args = { operationId: randomUUID(), id: "nested-recovery", path: "Research/Deep/Recovered.md", title: "Recovery", content: "journaled" };
    const request = { operation: "knowledge.document.create", actorId: actor.id, args };
    const raw = encodeMarkdown(args.id, args.title, args.content, 1, false, undefined, args.path);
    const db = new DatabaseSync(join(directory, "core.sqlite"));
    try {
      db.prepare("INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,document_id,before_sha256,after_markdown,document_path) VALUES(1,?,?,?,?,?,?,?,?)").run(
        args.operationId, sha256(JSON.stringify(request)), actor.id, request.operation, args.id, null, raw, args.path,
      );
    } finally { db.close(); }
    if (stage === "markdown-replaced" || stage === "temporary-written") {
      await mkdir(join(directory, "notes/Research/Deep"), { recursive: true });
      await writeFile(join(directory, "notes/Research/Deep", stage === "temporary-written" ? `.pkm-write-${args.operationId}` : "Recovered.md"), stage === "temporary-written" ? "partial bytes" : raw);
    }
    const recovered = await open();
    const expected = decodeMarkdown(args.id, raw, args.path).record;
    assert.deepEqual((await recovered.call("capability_read", "knowledge.document.get", { id: args.id })).result, expected);
    assert.deepEqual((await recovered.call("capability_call", request.operation, args)).result, expected);
    assert.equal(await readFile(join(directory, "notes", args.path), "utf8"), raw);
    assert.deepEqual(await readdir(join(directory, "notes")), ["Research"]);
    assert.deepEqual(await readdir(join(directory, "notes/Research/Deep")), ["Recovered.md"]);
    await recovered.storage.close();
    const check = new DatabaseSync(join(directory, "core.sqlite"));
    try {
      assert.equal(check.prepare("SELECT count(*) AS total FROM pending_write").get().total, 0);
      assert.equal(check.prepare("SELECT count(*) AS total FROM receipts").get().total, 1);
    } finally { check.close(); }
  });
}

test("database v2 upgrade preserves prototype IDs, authoritative bytes and historical receipts", async t => {
  const { directory, open } = await fixture(t);
  const first = await open(); await first.storage.close();
  const args = { operationId: randomUUID(), id: "prototype", title: "Original", content: "Keep it" };
  const raw = encodeMarkdown(args.id, args.title, args.content, 1, false).replace(/^documentId:.*\n/m, "");
  const { path: _path, area: _area, ...historicalResult } = decodeMarkdown(args.id, raw).record;
  await writeFile(join(directory, "notes/prototype.md"), raw);
  const db = new DatabaseSync(join(directory, "core.sqlite"));
  try {
    db.exec("ALTER TABLE documents DROP COLUMN path; ALTER TABLE documents DROP COLUMN area; ALTER TABLE pending_write DROP COLUMN document_path; ALTER TABLE pending_write DROP COLUMN document_area; PRAGMA user_version=2;");
    db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(
      args.operationId, sha256(JSON.stringify({ operation: "knowledge.document.create", actorId: actor.id, args })),
      JSON.stringify(historicalResult), actor.id, "knowledge.document.create", new Date().toISOString(),
    );
  } finally { db.close(); }
  const second = await open();
  assert.deepEqual((await second.call("capability_call", "knowledge.document.create", args)).result, historicalResult);
  const listing = (await second.call("capability_read", "knowledge.document.list", {})).result;
  assert.equal(listing.items[0].id, args.id);
  assert.equal(listing.items[0].path, "prototype.md");
  assert.equal(await readFile(join(directory, "notes/prototype.md"), "utf8"), raw);
  const knowledgeId = decodeMarkdown(args.id, raw).metadata.get("knowledgeId");
  const current = (await second.call("capability_read", "knowledge.document.get", { id: knowledgeId })).result;
  assert.equal(current.id, args.id);
  const updated = (await second.call("capability_call", "knowledge.document.update", {
    operationId: randomUUID(), id: knowledgeId, expectedRevision: current.revision, expectedSha256: current.sha256,
    title: current.title, content: "Explicit canonical-ID update",
  })).result;
  assert.equal(updated.id, args.id);
  assert.equal(decodeMarkdown(args.id, await readFile(join(directory, "notes/prototype.md"), "utf8")).metadata.get("knowledgeId"), knowledgeId);
  await second.storage.close();
  const check = new DatabaseSync(join(directory, "core.sqlite"));
  try {
    assert.equal(check.prepare("PRAGMA user_version").get().user_version, 23);
    assert(check.prepare("PRAGMA table_info(documents)").all().some(column => column.name === "path"));
    assert.equal(check.prepare("SELECT result FROM receipts WHERE operation_id=?").get(args.operationId).result, JSON.stringify(historicalResult));
  } finally { check.close(); }
});

test("paired resource ownership recognizes uppercase Markdown extensions and rejects orphans", async t => {
  const { directory, open } = await fixture(t);
  await mkdir(join(directory, "notes/Legacy/Owner.assets"), { recursive: true });
  await writeFile(join(directory, "notes/Legacy/Owner.MD"), "# Owner");
  await writeFile(join(directory, "notes/Legacy/Owner.assets/image.bin"), Buffer.from([0, 1, 2, 255]));
  const { call } = await open();
  assert.equal((await call("capability_read", "knowledge.document.list", {})).result.total, 1);
  assert.deepEqual(await readFile(join(directory, "notes/Legacy/Owner.assets/image.bin")), Buffer.from([0, 1, 2, 255]));
  await mkdir(join(directory, "notes/Legacy/Orphan.assets"));
  assert.equal((await call("capability_read", "knowledge.document.list", {})).error.code, "INVALID_DOCUMENT");
});

test("canonical knowledge IDs cannot ambiguously shadow another document ID", async t => {
  const { directory, open } = await fixture(t);
  const { call } = await open();
  const first = encodeMarkdown("first", "First", "A", 1, false);
  const knowledgeId = decodeMarkdown("first", first).metadata.get("knowledgeId");
  await writeFile(join(directory, "notes/first.md"), first);
  await writeFile(join(directory, "notes/second.md"), encodeMarkdown(knowledgeId, "Second", "B", 1, false));
  assert.equal((await call("capability_read", "knowledge.document.get", { id: knowledgeId })).error.code, "CONFLICT");
});

test("Notes, Skills and Papers share identity/CAS while retaining separate Markdown files and typed aliases", async t => {
  const { directory, open } = await fixture(t);
  const first = await open(), records = [];
  for (const [area, kind] of [["notes", "note"], ["skills", "skill"], ["papers", "research"]]) {
    const created = await first.call("capability_call", "knowledge.document.create", {
      operationId: randomUUID(), id: `${area}-entry`, area, path: "Library/Entry.md",
      title: area, content: `# ${area}\nOriginal body`,
    });
    assert(!created.error, JSON.stringify(created.error));
    const record = created.result;
    records.push(record);
    assert.equal(record.area, area);
    const file = join(directory, area, record.path);
    const raw = await readFile(file, "utf8");
    const metadata = decodeMarkdown(record.id, raw, record.path, area).metadata.toJS();
    assert(metadata.aliases.includes(`${kind}:Library/Entry`));
    assert(metadata.aliases.includes(`${kind}:${record.id}`));
    await writeFile(file, raw.replace("title:", 'category: "Library"\ntags: ["preserve"]\npriority: "high"\nauthors: ["Original author"]\ntitle:'));
    const current = (await first.call("capability_read", "knowledge.document.get", { id: record.id })).result;
    const stale = await first.call("capability_call", "knowledge.document.update", {
      operationId: randomUUID(), id: record.id, expectedRevision: record.revision, expectedSha256: record.sha256,
      title: area, content: "Stale overwrite",
    });
    assert.equal(stale.error.code, "CONFLICT");
    const edited = (await first.call("capability_call", "knowledge.document.update", {
      operationId: randomUUID(), id: record.id, expectedRevision: current.revision, expectedSha256: current.sha256,
      title: area, content: "Explicit edit",
    })).result;
    assert.equal(edited.area, area);
    const after = decodeMarkdown(record.id, await readFile(file, "utf8"), record.path, area).metadata.toJS();
    assert.equal(after.knowledgeId, metadata.knowledgeId);
    assert.deepEqual(after.tags, ["preserve"]);
    assert.deepEqual(after.authors, ["Original author"]);
    assert.equal(after.priority, "high");
    const filtered = (await first.call("capability_read", "knowledge.document.list", { area })).result;
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].area, area);
    const trashed = (await first.call("capability_call", "knowledge.document.trash", {
      operationId: randomUUID(), id: record.id, expectedRevision: edited.revision, expectedSha256: edited.sha256,
    })).result;
    assert.equal(trashed.area, area);
    assert.equal((await first.call("capability_read", "knowledge.document.list", { area })).result.total, 0);
    assert.equal((await first.call("capability_read", "knowledge.document.list", { area, includeDeleted: true })).result.total, 1);
    const restored = await first.call("capability_call", "knowledge.document.restore", {
      operationId: randomUUID(), id: record.id, expectedRevision: trashed.revision, expectedSha256: trashed.sha256,
    });
    assert.equal(restored.result.area, area);
  }
  assert.equal((await first.call("capability_read", "knowledge.document.list", {})).result.total, 3);
  const duplicate = await first.call("capability_call", "knowledge.document.create", {
    operationId: randomUUID(), id: records[0].id, area: "skills", path: "Other.md", title: "Collision", content: "No",
  });
  assert.equal(duplicate.error.code, "CONFLICT");
  await assert.rejects(readFile(join(directory, "skills/Other.md")), { code: "ENOENT" });
  await first.storage.close();
  const second = await open();
  for (const record of records) assert.equal((await second.call("capability_read", "knowledge.document.get", { id: record.id })).result.area, record.area);
});

test("identity-less legacy documents with matching filenames remain distinguishable across knowledge areas", async t => {
  const { directory, open } = await fixture(t);
  for (const area of ["notes", "skills", "papers"]) {
    await mkdir(join(directory, area), { recursive: true });
    await writeFile(join(directory, area, "Same.md"), "# Same filename");
  }
  const { call } = await open();
  const listing = (await call("capability_read", "knowledge.document.list", {})).result;
  assert.equal(listing.total, 3);
  assert.equal(new Set(listing.items.map(item => item.id)).size, 3);
  for (const record of listing.items) {
    assert.equal(record.path, "Same.md");
    assert.equal((await call("capability_read", "knowledge.document.get", { id: record.id })).result.content, "# Same filename");
    assert.equal(await readFile(join(directory, record.area, record.path), "utf8"), "# Same filename");
  }
});

test("knowledge areas reject unknown roots, System mutations and symlink adoption without creating data", async t => {
  const { directory, open } = await fixture(t);
  const { call, storage } = await open();
  for (const area of ["../escape", "/tmp", "prompts", "scripts", "Skills"]) {
    assert.equal((await call("capability_call", "knowledge.document.create", {
      operationId: randomUUID(), id: "invalid", area, title: "No", content: "No",
    })).error.code, "INVALID_ARGUMENT");
  }
  for (const area of ["skills", "papers"]) {
    assert.equal((await call("capability_call", "knowledge.document.create", {
      operationId: randomUUID(), id: `${area}-system`, area, path: "System/Protected.md", title: "No", content: "No",
    })).error.code, "ACCESS_DENIED");
    await assert.rejects(readdir(join(directory, area)), { code: "ENOENT" });
  }
  await storage.close();
  await symlink(join(directory, "notes"), join(directory, "skills"), "dir");
  await assert.rejects(Storage.open(directory), /regular files or knowledge\/boards directories/);
});

for (const area of ["skills", "papers"]) for (const stage of ["intent-committed", "temporary-written", "markdown-replaced"]) {
  test(`${area} journal recovery at ${stage} never routes content into Notes`, async t => {
    const { directory, open } = await fixture(t);
    const first = await open(); await first.storage.close();
    const args = { operationId: randomUUID(), id: `${area}-recovery`, area, path: "Deep/Recovered.md", title: "Recovery", content: `${area} journaled` };
    const request = { operation: "knowledge.document.create", actorId: actor.id, args };
    const raw = encodeMarkdown(args.id, args.title, args.content, 1, false, undefined, args.path, area);
    const db = new DatabaseSync(join(directory, "core.sqlite"));
    try {
      db.prepare("INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,document_id,before_sha256,after_markdown,document_path,document_area) VALUES(1,?,?,?,?,?,?,?,?,?)").run(
        args.operationId, sha256(JSON.stringify(request)), actor.id, request.operation, args.id, null, raw, args.path, area,
      );
    } finally { db.close(); }
    if (stage === "markdown-replaced" || stage === "temporary-written") {
      await mkdir(join(directory, area, "Deep"), { recursive: true });
      await writeFile(join(directory, area, "Deep", stage === "temporary-written" ? `.pkm-write-${args.operationId}` : "Recovered.md"), stage === "temporary-written" ? "partial bytes" : raw);
    }
    const recovered = await open();
    const expected = decodeMarkdown(args.id, raw, args.path, area).record;
    assert.deepEqual((await recovered.call("capability_read", "knowledge.document.get", { id: args.id })).result, expected);
    assert.deepEqual((await recovered.call("capability_call", request.operation, args)).result, expected);
    assert.equal(await readFile(join(directory, area, args.path), "utf8"), raw);
    assert.deepEqual(await readdir(join(directory, "notes")), []);
    assert.deepEqual(await readdir(join(directory, area, "Deep")), ["Recovered.md"]);
    await recovered.storage.close();
    const check = new DatabaseSync(join(directory, "core.sqlite"));
    try {
      assert.equal(check.prepare("SELECT count(*) AS total FROM pending_write").get().total, 0);
      assert.equal(check.prepare("SELECT count(*) AS total FROM receipts").get().total, 1);
    } finally { check.close(); }
  });
}

test("database v3 nested intents retain their Notes area when upgrading the recovery journal", async t => {
  const { directory, open } = await fixture(t);
  const first = await open(); await first.storage.close();
  const args = { operationId: randomUUID(), id: "v3-nested", path: "Deep/Original.md", title: "Original", content: "No area column" };
  const raw = encodeMarkdown(args.id, args.title, args.content, 1, false, undefined, args.path);
  const db = new DatabaseSync(join(directory, "core.sqlite"));
  try {
    db.exec("ALTER TABLE documents DROP COLUMN area; ALTER TABLE pending_write DROP COLUMN document_area; PRAGMA user_version=3;");
    db.prepare("INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,document_id,before_sha256,after_markdown,document_path) VALUES(1,?,?,?,?,?,?,?,?)").run(
      args.operationId, sha256(JSON.stringify({ operation: "knowledge.document.create", actorId: actor.id, args })),
      actor.id, "knowledge.document.create", args.id, null, raw, args.path,
    );
  } finally { db.close(); }
  const recovered = await open();
  const result = await recovered.call("capability_call", "knowledge.document.create", args);
  assert.deepEqual(result.result, decodeMarkdown(args.id, raw, args.path).record);
  assert.equal(await readFile(join(directory, "notes", args.path), "utf8"), raw);
  await recovered.storage.close();
  const check = new DatabaseSync(join(directory, "core.sqlite"));
  try { assert.equal(check.prepare("PRAGMA user_version").get().user_version, 23); }
  finally { check.close(); }
});

test("metadata reads expose original YAML and original identity/link diagnostics without rewriting legacy content", async t => {
  const { directory, open } = await fixture(t);
  const raw = "---\ntitle: Legacy\ncustom:\n  keep: [one, two]\nlinks:\n  - relation: supports\n    target: notes/relative\n    mode: pinned\n    required: true\n---\n# Original body";
  await writeFile(join(directory, "notes/legacy.md"), raw);
  const { call } = await open();
  const result = await call("capability_read", "knowledge.metadata.get", { id: "legacy" });
  assert(!result.error, JSON.stringify(result.error));
  assert.deepEqual(result.result.metadata.custom, { keep: ["one", "two"] });
  assert(result.result.diagnostics.some(item => item.code === "knowledge-id"));
  assert(result.result.diagnostics.some(item => item.pointer === "/links/0/target"));
  assert(result.result.diagnostics.some(item => item.pointer === "/links/0/targetRevision"));
  assert(!Object.hasOwn(result.result, "content"));
  assert.equal(await readFile(join(directory, "notes/legacy.md"), "utf8"), raw);
  const repaired = await call("capability_call", "knowledge.metadata.update", {
    operationId: randomUUID(), id: "legacy", expectedRevision: result.result.revision, expectedSha256: result.result.sha256,
    set: { links: [] },
  });
  assert.equal(repaired.result.revision, 2);
  assert.equal(repaired.result.content, "# Original body");
  assert.deepEqual((await call("capability_read", "knowledge.metadata.get", { id: "legacy" })).result.diagnostics, []);
});

test("metadata patch preserves body/comments, untouched fields and identity in every storage area and replays its exact receipt", async t => {
  const { directory, open } = await fixture(t);
  const first = await open(), replays = [];
  for (const area of ["notes", "skills", "papers"]) {
    const record = (await first.call("capability_call", "knowledge.document.create", {
      operationId: randomUUID(), id: `${area}-metadata`, area, path: "Folder/Metadata.md", title: area, content: "# Body\nKeep verbatim\n",
    })).result;
    const file = join(directory, area, record.path);
    await writeFile(file, (await readFile(file, "utf8")).replace("title:", "# Preserve my comment\nuntouched:\n  value: true\nobsolete: remove\ntitle:"));
    const current = (await first.call("capability_read", "knowledge.metadata.get", { id: record.id })).result;
    const links = [
      { relation: "supports", target: "pkm://knowledge/knowledge_0123456789abcdef01234567", mode: "floating", required: false },
      { relation: "depends-on", target: "pkm://script/script_example", mode: "pinned", required: true, targetRevision: "7" },
    ];
    const args = {
      operationId: randomUUID(), id: record.id, expectedRevision: current.revision, expectedSha256: current.sha256,
      set: { tags: ["architecture"], nested: { explicit: [1, null, true] }, links }, remove: ["obsolete"],
    };
    const patched = await first.call("capability_call", "knowledge.metadata.update", args);
    assert(!patched.error, JSON.stringify(patched.error));
    assert.equal(patched.result.revision, 2);
    assert.equal(patched.result.content, record.content);
    const metadata = (await first.call("capability_read", "knowledge.metadata.get", { id: current.metadata.knowledgeId })).result;
    assert.equal(metadata.id, record.id);
    assert.equal(metadata.metadata.knowledgeId, current.metadata.knowledgeId);
    assert.deepEqual(metadata.metadata.aliases, current.metadata.aliases);
    assert.deepEqual(metadata.metadata.untouched, { value: true });
    assert.deepEqual(metadata.metadata.links, links);
    assert.deepEqual(metadata.metadata.nested, { explicit: [1, null, true] });
    assert(!Object.hasOwn(metadata.metadata, "obsolete"));
    assert.deepEqual(metadata.diagnostics, []);
    assert((await readFile(file, "utf8")).includes("# Preserve my comment"));
    const later = await first.call("capability_call", "knowledge.document.update", {
      operationId: randomUUID(), id: record.id, expectedRevision: patched.result.revision, expectedSha256: patched.result.sha256,
      title: area, content: "Later edit",
    });
    assert.equal(later.result.revision, 3);
    assert.deepEqual((await first.call("capability_call", "knowledge.metadata.update", args)).result, patched.result);
    assert.equal((await first.call("capability_call", "knowledge.metadata.update", { ...args, operationId: randomUUID() })).error.code, "CONFLICT");
    replays.push({ args, result: patched.result });
  }
  await first.storage.close();
  const second = await open();
  for (const { args, result } of replays) {
    assert.deepEqual((await second.call("capability_call", "knowledge.metadata.update", args)).result, result);
    assert.equal((await second.call("capability_read", "knowledge.document.get", { id: args.id })).result.content, "Later edit");
  }
});

test("metadata mutations reject protected identities, ambiguous patches, invalid original link contracts and spoofed authority", async t => {
  const { directory, open } = await fixture(t);
  const { call, storage } = await open();
  const record = (await call("capability_call", "knowledge.document.create", {
    operationId: randomUUID(), id: "metadata-guards", title: "Protected", content: "Original",
  })).result;
  const file = join(directory, "notes/metadata-guards.md"), raw = await readFile(file, "utf8");
  const base = { id: record.id, expectedRevision: record.revision, expectedSha256: record.sha256 };
  for (const field of ["schema", "knowledgeId", "documentId", "revision", "deleted", "aliases", "title", "documentKind", "workItems"]) {
    for (const change of [{ set: { [field]: "spoof" } }, { remove: [field] }]) {
      const result = await call("capability_call", "knowledge.metadata.update", { ...base, operationId: randomUUID(), ...change });
      assert.equal(result.error.code, "ACCESS_DENIED", field);
      assert.equal(result.error.effect, "not-committed");
    }
  }
  for (const change of [
    {}, { set: { key: true }, remove: ["key"] },
    { set: { links: [{ relation: "supports", target: "notes/relative", mode: "floating", required: true }] } },
    { set: { links: [{ relation: "supports", target: "pkm://knowledge/knowledge_0123456789abcdef01234567", mode: "pinned", required: true }] } },
    { set: { links: [{ relation: "supports", target: "pkm://knowledge/knowledge_0123456789abcdef01234567", mode: "floating", required: true, targetRevision: "1" }] } },
  ]) {
    assert.equal((await call("capability_call", "knowledge.metadata.update", { ...base, operationId: randomUUID(), ...change })).error.code, "INVALID_ARGUMENT");
  }
  const denied = await new Core(storage).dispatch("capability_call", invocation("knowledge.metadata.update", {
    ...base, operationId: randomUUID(), set: { tags: [] },
  }), { id: "local:reader", canWrite: false });
  assert.equal(denied.error.code, "ACCESS_DENIED");
  assert.equal(await readFile(file, "utf8"), raw);
  const trashed = (await call("capability_call", "knowledge.document.trash", { ...base, operationId: randomUUID() })).result;
  assert.equal((await call("capability_call", "knowledge.metadata.update", {
    id: record.id, operationId: randomUUID(), expectedRevision: trashed.revision, expectedSha256: trashed.sha256, set: { tags: [] },
  })).error.code, "CONFLICT");
});

for (const authority of ["descriptor", "backing-file"]) {
  test(`generic Markdown mutations cannot overwrite original Todo ${authority} authority`, async t => {
    const { directory, open } = await fixture(t);
    let raw = encodeMarkdown("board", "Board", "# Descriptor", 1, false);
    if (authority === "descriptor") raw = raw.replace("title:", "documentKind: todo-board\ntitle:");
    else {
      await mkdir(join(directory, "notes/board.assets"));
      await writeFile(join(directory, "notes/board.assets/pkm-todo-board.json"), '{"schema":"pkm.todo-board/v1","items":[]}');
    }
    await writeFile(join(directory, "notes/board.md"), raw);
    const { call } = await open();
    const current = (await call("capability_read", "knowledge.document.get", { id: "board" })).result;
    for (const operation of ["knowledge.document.update", "knowledge.document.trash", "knowledge.document.restore", "knowledge.metadata.update"]) {
      const extra = operation === "knowledge.document.update" ? { title: "Overwrite", content: "No" }
        : operation === "knowledge.metadata.update" ? { set: { tags: [] } } : {};
      const result = await call("capability_call", operation, {
        operationId: randomUUID(), id: current.id, expectedRevision: current.revision, expectedSha256: current.sha256, ...extra,
      });
      assert.equal(result.error.code, "ACCESS_DENIED", operation);
      assert.equal(result.error.effect, "not-committed");
    }
    assert.equal(await readFile(join(directory, "notes/board.md"), "utf8"), raw);
  });
}

test("an existing durable receipt remains replayable when a later external edit makes Markdown invalid", async t => {
  const { directory, open } = await fixture(t); const { call } = await open();
  const args = { operationId: randomUUID(), id: "receipt", title: "Original", content: "Committed" };
  const committed = (await call("capability_call", "knowledge.document.create", args)).result;
  const invalid = "---\ntitle: [broken\n---\nExternal invalid content";
  await writeFile(join(directory, "notes/receipt.md"), invalid);
  assert.deepEqual((await call("capability_call", "knowledge.document.create", args)).result, committed);
  assert.equal(await readFile(join(directory, "notes/receipt.md"), "utf8"), invalid);
  assert.equal((await call("capability_read", "knowledge.metadata.get", { id: "receipt" })).error.code, "INVALID_DOCUMENT");
});

test("explicit invalid identities and zero revisions are not regenerated or silently defaulted", async t => {
  const { directory, open } = await fixture(t);
  const { call } = await open();
  const raw = encodeMarkdown("identity", "Identity", "Original", 1, false).replace(/^knowledgeId:.*$/m, "knowledgeId: invalid");
  await writeFile(join(directory, "notes/identity.md"), raw);
  const current = (await call("capability_read", "knowledge.document.get", { id: "identity" })).result;
  const result = await call("capability_call", "knowledge.document.update", {
    operationId: randomUUID(), id: current.id, expectedRevision: current.revision, expectedSha256: current.sha256,
    title: "No identity replacement", content: "No",
  });
  assert.equal(result.error.code, "INVALID_DOCUMENT");
  assert.equal(result.error.effect, "not-committed");
  assert.equal(await readFile(join(directory, "notes/identity.md"), "utf8"), raw);
  await writeFile(join(directory, "notes/identity.md"), raw.replace(/^revision:.*$/m, "revision: 0"));
  assert.equal((await call("capability_read", "knowledge.document.get", { id: "identity" })).error.code, "INVALID_DOCUMENT");
});

test("invalid UTF-8 Markdown is reported without replacing authoritative bytes or committing an intent", async t => {
  const { directory, open } = await fixture(t); const { call } = await open();
  const path = join(directory, "notes/invalid.md"), bytes = Buffer.from([35, 32, 0xff, 0xfe, 10]);
  await writeFile(path, bytes);
  assert.equal((await call("capability_read", "knowledge.document.get", { id: "invalid" })).error.code, "INVALID_DOCUMENT");
  assert.deepEqual(await readFile(path), bytes);
});

for (const kind of ["symlink", "directory"]) {
  test(`recovery refuses a ${kind} at the committed operation's temporary path without deleting it`, async t => {
    const { directory, open } = await fixture(t);
    const first = await open(); await first.storage.close();
    const operationId = randomUUID(), raw = encodeMarkdown("recovery", "Recovery", "Pending", 1, false);
    const temporary = join(directory, `notes/.pkm-write-${operationId}`);
    const sentinel = encodeMarkdown("sentinel", "Sentinel", "Preserve these bytes", 1, false);
    await writeFile(join(directory, "notes/sentinel.md"), sentinel);
    if (kind === "symlink") await symlink(join(directory, "notes/sentinel.md"), temporary);
    else await mkdir(temporary);
    const db = new DatabaseSync(join(directory, "core.sqlite"));
    try {
      db.prepare("INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,document_id,before_sha256,after_markdown) VALUES(1,?,?,?,?,?,?,?)").run(
        operationId, "f".repeat(64), actor.id, "knowledge.document.create", "recovery", null, raw,
      );
    } finally { db.close(); }
    await assert.rejects(Storage.open(directory), /temporary path is not a regular file/);
    assert.equal((await lstat(temporary)).isSymbolicLink(), kind === "symlink");
    assert.equal(await readFile(join(directory, "notes/sentinel.md"), "utf8"), sentinel);
    await assert.rejects(readFile(join(directory, "notes/recovery.md")), { code: "ENOENT" });
    const check = new DatabaseSync(join(directory, "core.sqlite"));
    try {
      assert.equal(check.prepare("SELECT count(*) AS total FROM pending_write").get().total, 1);
      assert.equal(check.prepare("SELECT count(*) AS total FROM receipts").get().total, 0);
    } finally { check.close(); }
  });
}
