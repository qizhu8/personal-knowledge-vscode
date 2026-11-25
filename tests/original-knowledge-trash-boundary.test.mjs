import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { nativePublicFullOptions, createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { verifyOriginalMcpImplementationReadiness } from "../dist/original-mcp-public.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { originalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";

const actor = Object.freeze({ id: "mcp:external", canWrite: true });
const hash = value => createHash("sha256").update(value).digest("hex");
const bytes = Buffer.from([255, 0, 128, 9]);
const documentPath = "Public/Lifecycle.md";
const seed = `
  store.noteUpsert({ slug: "Public/Lifecycle", title: "Lifecycle", category: "Public", type: "general",
    tags: ["retained"], content: "Original body\\n![pair](Lifecycle.assets/opaque.bin?q=1#view)\\n"
      + '<img src="Lifecycle.assets/opaque.bin?html=1#image">\\n'
      + "[pair]: <Lifecycle.assets/opaque.bin?definition=1#doc>\\n" });
  assets.saveMarkdownAsset(root, "notes", "Public/Lifecycle.md", "opaque.bin", Buffer.from([255,0,128,9]));
  const before = store.noteGet("Public/Lifecycle");
  store.noteUpsert({ ...before, tags: JSON.parse(before.tags), content: before.content + "Revision two.\\n" });
  store.noteUpsert({ slug: "Private/Secret", title: "Secret", category: "Private", type: "general",
    content: "Private marker\\n" + (input.shared ? "![shared](../Public/Lifecycle.assets/opaque.bin)\\n" : "") });
  privacy.setTopLevelPrivacy("notes", "Private", true);
  if (input.archived) {
    store.noteUpsert({ slug: "Public/Archived", title: "Archived", category: "Public", type: "general",
      content: "Prior disposable Trash entry.\\n" });
    store.knowledgePathMoveToTrash("notes", "Public/Archived.md");
  }
  return store.noteGet("Public/Lifecycle");
`;

async function fixture(t, input = {}) {
  assert(process.env.PKM_TEST_WORKSPACE, "Use the existing private Linux test framework.");
  const directory = resolve("tests", `.original-trash-boundary-${randomUUID()}`);
  const root = join(directory, "root");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const original = originalKnowledgeWriterFixture(directory);
  const before = original.run(root, seed, input);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, root, original, before };
}

async function knowledgeSnapshot(root) {
  const rows = [];
  async function walk(path, relative) {
    let stat;
    try { stat = await lstat(path); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    rows.push([relative, stat.ino, stat.isDirectory() ? null : hash(await readFile(path))]);
    if (stat.isDirectory())
      for (const name of (await readdir(path)).sort()) await walk(join(path, name), `${relative}/${name}`);
  }
  for (const area of ["notes", "skills", "papers"]) await walk(join(root, area), area);
  await walk(join(root, ".pkm/state/knowledge-deletions.json"), ".pkm/state/knowledge-deletions.json");
  return rows;
}

test("SHA-pinned original public Note Trash/restore preserves exact paired bytes, identity and revision without tombstoning",
  { timeout: 120000 }, async t => {
    const f = await fixture(t);
    const raw = await readFile(join(f.root, "notes", documentPath));
    const entry = f.original.run(f.root, `return store.knowledgePathMoveToTrash("notes", input.path);`,
      { path: documentPath });
    assert.match(entry.id, /^[0-9]+-[a-f0-9]{10}$/);
    assert.deepEqual(entry, { id: entry.id, kind: "item", name: "Lifecycle.md", originalPath: documentPath,
      deletedAt: entry.deletedAt, assetsPath: "Public/Lifecycle.assets" });
    assert.equal(f.original.run(f.root, `return store.noteGet("Public/Lifecycle") || null;`), null);
    const bucket = join(f.root, "notes/.trash", entry.id);
    assert.deepEqual(await readFile(join(bucket, "payload")), raw);
    assert.deepEqual(await readFile(join(bucket, "assets/opaque.bin")), bytes);
    assert.deepEqual(JSON.parse(await readFile(join(bucket, "metadata.json"), "utf8")), entry);
    const history = JSON.parse(await readFile(join(f.root, ".pkm/state/knowledge-deletions.json"), "utf8"));
    assert.deepEqual(history, { schema: 1, records: [
      { path: `notes/${documentPath}`, deletedAt: entry.deletedAt },
      { path: "notes/Public/Lifecycle.assets/opaque.bin", deletedAt: entry.deletedAt },
    ] });
    assert.deepEqual(f.original.run(f.root, `return store.knowledgeTrashList("notes");`), [entry]);
    assert.equal(f.original.run(f.root,
      `return store.knowledgePathMoveToTrash("notes", input.path) || null;`, { path: documentPath }), null);
    assert.deepEqual(f.original.run(f.root, `return store.knowledgeTrashRestore("notes", input.id);`,
      { id: entry.id }), { ok: true, path: documentPath });
    assert.deepEqual(await readFile(join(f.root, "notes", documentPath)), raw);
    assert.deepEqual(await readFile(join(f.root, "notes/Public/Lifecycle.assets/opaque.bin")), bytes);
    assert.deepEqual(f.original.run(f.root, `return store.noteGet("Public/Lifecycle");`), f.before);
    assert.equal(f.before.revision, 2);
    assert.doesNotMatch(raw.toString("utf8"), /^deleted:/m);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, ".pkm/state/knowledge-deletions.json"), "utf8")),
      { schema: 1, records: [] });
    assert.deepEqual(f.original.run(f.root, `return store.knowledgeTrashRestore("notes", input.id);`,
      { id: entry.id }), { ok: false, error: "Trash item was not found." });
  });

test("SHA-pinned original Trash refuses a paired resource shared by a private referrer without moving either owner",
  { timeout: 120000 }, async t => {
    const f = await fixture(t, { shared: true }), before = await knowledgeSnapshot(f.root);
    const result = f.original.run(f.root, `
      try { return { entry: store.knowledgePathMoveToTrash("notes", input.path) }; }
      catch (error) { return { error: error.message }; }
    `, { path: documentPath });
    assert.match(result.error, /Resource is shared by Private\/Secret\.md/);
    assert.deepEqual(await knowledgeSnapshot(f.root), before);
    assert.deepEqual(f.original.run(f.root, `return store.knowledgeTrashList("notes");`), []);
  });

test("SHA-pinned original restore collision preserves the exact recoverable bucket and deletion journal",
  { timeout: 120000 }, async t => {
    const f = await fixture(t);
    const entry = f.original.run(f.root, `return store.knowledgePathMoveToTrash("notes", input.path);`,
      { path: documentPath });
    f.original.run(f.root, `
      return store.noteUpsert({ slug: "Public/Lifecycle", title: "Lifecycle", category: "Public", type: "general",
        content: "A newly created destination must not be overwritten.\\n" });
    `);
    const before = await knowledgeSnapshot(f.root);
    assert.deepEqual(f.original.run(f.root, `return store.knowledgeTrashRestore("notes", input.id);`,
      { id: entry.id }), { ok: false, error: `Restore target already exists: ${documentPath}` });
    assert.deepEqual(await knowledgeSnapshot(f.root), before);
    assert.deepEqual(await readFile(join(f.root, "notes/.trash", entry.id, "assets/opaque.bin")), bytes);
  });

test("original same-owner admission refuses public/canonical Trash before intent and preserves pre-existing buckets across restart",
  { timeout: 120000 }, async t => {
    const f = await fixture(t, { archived: true }), before = await knowledgeSnapshot(f.root);
    const plan = await captureOriginalMcpCustody({ root: f.root, backup: join(f.directory, "custody"),
      operatorId: "original-trash-boundary-fixture", profileSha256: hash("isolated-trash-profile"),
      limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16 * 1024 * 1024, maxFileBytes: 1024 * 1024 } });
    let databaseIdentity;
    for (let epoch = 0; epoch < 2; epoch++) {
      const opened = await openOriginalMcpRoot(plan);
      const stat = await lstat(join(f.root, "core.sqlite"));
      const currentIdentity = [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink];
      if (databaseIdentity) assert.deepEqual(currentIdentity, databaseIdentity,
        "Unadmitted Trash must not alter standard Core database identity or permissions during restart.");
      else databaseIdentity = currentIdentity;
      const backend = createNativePublicOwnerBackend(opened.owner, { actor });
      try {
        const prepared = await nativePublicFullOptions(opened.storage, { actor });
        assert.equal(prepared.trash, undefined);
        const { runtime } = await opened.owner.ensureFull();
        const lease = { ...opened.owner.workspaceLease() };
        for (const [operation, arguments_, readOnly] of [
          ["knowledge.trash.lifecycle.preview", { area: "notes", path: documentPath, kind: "document" }, true],
          ["knowledge.trash.move", { area: "notes", path: documentPath, kind: "document",
            operationId: randomUUID(), expectedTreeSha256: hash("ungranted"), expectedScanRevision: hash("ungranted"),
            entryIdFormat: "original" }, false],
          ["knowledge.trash.restore", { operationId: randomUUID(), entryId: "1-0123456789",
            expectedScanRevision: hash("ungranted") }, false],
          ["knowledge.trash.list", {}, true],
        ]) {
          const response = await runtime.core.dispatch(readOnly ? "capability_read" : "capability_call",
            { operation, version: 1, arguments: arguments_ }, actor);
          assert.equal(response.error?.code, "NOT_AVAILABLE", JSON.stringify(response));
        }
        await assert.rejects(backend.invoke("legacy_knowledge_trash",
          { tool: "delete_note", arguments: { slug: "Public/Lifecycle" } }), { code: "NOT_AVAILABLE" });
        await assert.rejects(backend.invoke("original_mcp_public",
          { tool: "delete_note", arguments: { slug: "Public/Lifecycle" } }), { code: "ACCESS_DENIED" });
        const database = opened.storage.connectNative();
        try {
          assert.equal(database.prepare("SELECT COUNT(*) AS count FROM migration_runtime_intents").get().count, 0);
          assert.equal(database.prepare("SELECT COUNT(*) AS count FROM migration_runtime_trash").get().count, 0);
          assert.equal(database.prepare("SELECT COUNT(*) AS count FROM receipts WHERE operation GLOB 'knowledge.trash.*'").get().count, 0);
          assert.equal(database.prepare("SELECT COUNT(*) AS count FROM original_native_trash_commits").get().count, 0);
        } finally { database.close(); }
        assert.deepEqual(opened.owner.workspaceLease(), lease);
        assert.deepEqual(await knowledgeSnapshot(f.root), before);
      } finally { await backend.close(); await opened.owner.close(); }
    }
    const source = originalPublicMcpContracts();
    const readiness = verifyOriginalMcpImplementationReadiness({ acceptedScope: "preserve-existing-mcp/v1",
      catalogSha256: source.provenance.metadataSha256, catalogRevision: source.provenance.producer.revision });
    for (const tool of ["delete_note", "delete_skill", "delete_paper", "knowledge_file_trash"])
      assert(readiness.missingImplementations.some(item => item.operationId === `mcp.tool.${tool}`
        && item.code === "ORIGINAL_TRASH_CUSTODY_ADMISSION_REQUIRED"));
    assert.equal(readiness.ready, false);
  });
