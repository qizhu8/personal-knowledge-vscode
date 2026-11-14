import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { prepareNativeBoardLifecycle, recoverNativeBoardLifecycle } from "../dist/native-board-lifecycle.js";
import {
  nativeBoardLifecycleCatalog, nativeBoardLifecycleDdl, readNativeBoardGenesisSource,
} from "../dist/native-board-lifecycle-state.js";
import {
  planLegacyTodoRootProjection, publishLegacyTodoRootProjection,
} from "../dist/legacy-todo-root-projection.js";
import { readDocumentLifecycle, deserializeDocumentLifecyclePlan } from "../dist/document-lifecycle.js";
import { previewTrashLifecycle } from "../dist/trash-lifecycle.js";
import { scanMarkdown, sha256 } from "../dist/markdown.js";

const require = createRequire(import.meta.url);
const project = resolve(new URL("../legacy", import.meta.url).pathname);
const denied = error => ["ACCESS_DENIED", "CONFLICT", "RECOVERY_CONFLICT"].includes(error.code);
async function fixture(t) {
  const mask = process.umask(0o077), directory = join(project, ".migration-test-work", `board-file-unit-${randomUUID()}`);
  const root = join(directory, "knowledge");
  let descriptor, db;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const extension = process.env.PKM_TODO_LEGACY_EXTENSION ?? project;
    descriptor = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs").create({ extension, root });
    descriptor.text = descriptor.inline;
    require("../legacy/tests/next-trial-electron/todo-board-fixture.cjs").create({ extension, root, descriptor });
    const key = descriptor.todoBoards[0], markdown = readFileSync(join(root, "notes", `${key}.md`), "utf8");
    const backing = readFileSync(join(root, "notes", `${key}.assets/pkm-todo-board.json`), "utf8");
    const projection = await planLegacyTodoRootProjection(root, { entries: [
      { kind: "board-backing", source: `notes/${key}.assets/pkm-todo-board.json`,
        destination: `boards/${key}/pkm-todo-board.json`, boardSlug: key, sha256: sha256(backing), size: Buffer.byteLength(backing) },
      { source: `notes/${key}.md`, sha256: sha256(markdown) },
    ] });
    await publishLegacyTodoRootProjection(root, projection, randomUUID());
    // This unit journal exercises projection provenance only, not a qualified root adoption.
    const journal = { schema: "pkm.legacy-root-adoption-journal/v1", sourceRoot: root, todoProjection: projection };
    writeFileSync(join(root, ".pkm-next-root-adoption.json"), JSON.stringify({ ...journal, journalSha256: sha256(JSON.stringify(journal)) }), { mode: 0o600 });
    writeFileSync(join(root, ".pkm-next-workspace"), JSON.stringify({ id: randomUUID() }), { mode: 0o600 });
    db = new DatabaseSync(join(root, "core.sqlite"));
    db.exec(`CREATE TABLE receipts(operation_id TEXT PRIMARY KEY,fingerprint TEXT,result TEXT,actor_id TEXT,operation TEXT,created_at TEXT);
      CREATE TABLE pending_document_lifecycle(singleton INTEGER PRIMARY KEY,operation_id TEXT,fingerprint TEXT,actor_id TEXT,operation TEXT,plan TEXT);`);
    db.exec(nativeBoardLifecycleDdl);
    const native = join(root, "boards", key, "pkm-todo-board.json");
    t.after(() => { try { db.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
    function current() {
      const state = nativeBoardLifecycleCatalog(root, db).get(key);
      const path = state?.path ?? `${key}.md`;
      return { kind: "move", boardSlug: key, operationId: randomUUID(),
        expectedDigest: sha256(readFileSync(native)), expectedDocumentDigest: state?.documentSha256 ?? sha256(readFileSync(join(root, "notes", path))),
        destinationPath: "Moved/Renamed Board.md" };
    }
    function atomic(work) {
      db.exec("BEGIN IMMEDIATE");
      try { const result = work(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    function prepare(input = current()) { return atomic(() => prepareNativeBoardLifecycle(db, root, input)); }
    function recover() { return atomic(() => recoverNativeBoardLifecycle(db, root)); }
    return { root, directory, db, key, markdown, backing, native, current, atomic, prepare, recover };
  } finally { process.umask(mask); }
}
test("dedicated old-code Board file move preserves stable identity, raw task audit/grants, and generic denial", async t => {
  const f = await fixture(t), document = scanMarkdown(f.root).find(doc => doc.record.path === `${f.key}.md`);
  const args = { id: document.record.id, area: "notes", path: document.record.path,
    destinationPath: "Moved/Renamed Board.md", expectedRevision: document.record.revision, expectedSha256: document.record.sha256 };
  assert.throws(() => readDocumentLifecycle(f.root, scanMarkdown(f.root),
    { operation: "knowledge.document.lifecycle.preview", actorId: "user:local", args }), denied);
  assert.throws(() => previewTrashLifecycle(f.root, { area: "notes", path: document.record.path, kind: "document" }), denied);
  const plan = f.prepare({ ...f.current(), title: "Renamed Board" }), native = readFileSync(f.native);
  const result = f.recover();
  assert.equal(result.noteId, document.record.id);
  assert.equal(result.boardSlug, f.key);
  assert.equal(result.title, "Renamed Board");
  assert.deepEqual(readFileSync(f.native), native);
  const moved = scanMarkdown(f.root).find(doc => doc.record.id === document.record.id);
  assert.equal(moved.record.path, result.path);
  assert.equal(moved.metadata.get("knowledgeId"), document.metadata.get("knowledgeId"));
  assert.equal(moved.metadata.get("title"), "Renamed Board");
  assert.equal(moved.record.revision, document.record.revision + 1);
  assert.equal(readFileSync(join(f.root, "notes", "Moved/Renamed Board.assets/pkm-todo-board.json"), "utf8"), f.backing);
  assert.equal(plan.event.input.operationId, result.operationId);
  assert.deepEqual(readNativeBoardGenesisSource(f.root, `notes/${f.key}.md`, sha256(f.markdown), f.db), Buffer.from(f.markdown));
  assert.equal(f.recover(), undefined);
});
test("changed lifecycle receipt result cannot redirect replay or original genesis reads", async t => {
  const f = await fixture(t);
  f.prepare();
  const result = f.recover();
  const row = f.db.prepare("SELECT result FROM receipts WHERE operation_id=?").get(result.operationId);
  f.db.prepare("UPDATE receipts SET result=? WHERE operation_id=?")
    .run(JSON.stringify({ ...JSON.parse(row.result), path: "Unrelated/Note.md" }), result.operationId);
  assert.throws(() => nativeBoardLifecycleCatalog(f.root, f.db), /receipt|transition/);
  assert.throws(() => readNativeBoardGenesisSource(f.root, `notes/${f.key}.md`, sha256(f.markdown), f.db), /receipt|transition/);
});
test("Board target/stale conflicts are rejected before intent or file effects", async t => {
  const f = await fixture(t), raw = readFileSync(f.native), old = readFileSync(join(f.root, "notes", `${f.key}.md`));
  const occupied = join(f.root, "notes", "Occupied.md");
  writeFileSync(occupied, "---\nknowledgeId: occupied\n---\nExisting\n", { mode: 0o600 });
  assert.throws(() => f.prepare({ ...f.current(), destinationPath: "Occupied.md" }), denied);
  assert.throws(() => f.prepare({ ...f.current(), expectedDigest: "0".repeat(64) }), denied);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pending_document_lifecycle").get().n, 0);
  assert.deepEqual(readFileSync(f.native), raw);
  assert.deepEqual(readFileSync(join(f.root, "notes", `${f.key}.md`)), old);
});
test("Board original metadata fields update in place without rewriting content, identity or task history", async t => {
  const f = await fixture(t), input = { ...f.current(), destinationPath: `${f.key}.md`,
    description: "Updated through the original metadata workflow", tags: ["alpha", "beta"] };
  const before = scanMarkdown(f.root).find(doc => doc.record.path === `${f.key}.md`), raw = readFileSync(f.native);
  f.prepare(input); f.recover();
  const after = scanMarkdown(f.root).find(doc => doc.record.path === `${f.key}.md`);
  assert.equal(after.record.id, before.record.id);
  assert.equal(after.record.content, before.record.content);
  assert.equal(after.metadata.get("description"), input.description);
  assert.deepEqual(after.metadata.toJS().tags, input.tags);
  assert.deepEqual(readFileSync(f.native), raw);
});
for (const phase of [0, 1, 2, 3]) test(`Board move durable prefix ${phase} recovers across a real Node process`, async t => {
  const f = await fixture(t), plan = f.prepare(), move = deserializeDocumentLifecyclePlan(plan.movePlan);
  if (phase >= 1) {
    mkdirSync(dirname(join(f.root, "notes", move.pairedTree.afterPath)), { recursive: true, mode: 0o700 });
    renameSync(join(f.root, "notes", move.pairedTree.beforePath), join(f.root, "notes", move.pairedTree.afterPath));
  }
  if (phase >= 2) {
    const { rebaseMarkdownAssets } = await import("../dist/domain/document-lifecycle-original.js");
    const after = rebaseMarkdownAssets(join(f.root, "notes"), plan.event.beforePath, plan.event.path, plan.updatedSource);
    writeFileSync(join(f.root, "notes", plan.event.path), after, { mode: 0o600 });
  }
  if (phase >= 3) unlinkSync(join(f.root, "notes", plan.event.beforePath));
  const entry = new URL("../dist/native-board-lifecycle.js", import.meta.url).href;
  const source = `import {DatabaseSync} from "node:sqlite";import {recoverNativeBoardLifecycle} from ${JSON.stringify(entry)};
    const db=new DatabaseSync(process.argv[1]+"/core.sqlite");db.exec("BEGIN IMMEDIATE");
    recoverNativeBoardLifecycle(db,process.argv[1]);db.exec("COMMIT");db.close();`;
  const child = spawnSync(process.execPath, [...process.execArgv.filter(arg => arg !== "--test"), "--input-type=module", "-e", source, f.root],
    { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  const state = nativeBoardLifecycleCatalog(f.root, f.db).get(f.key);
  assert.equal(state.path, "Moved/Renamed Board.md");
  assert.equal(readFileSync(join(f.root, "notes", "Moved/Renamed Board.assets/pkm-todo-board.json"), "utf8"), f.backing);
  assert.equal(f.recover(), undefined);
});
test("Board Trash preserves full payload; occupied restore and unknown partial bytes preserve intent", async t => {
  const f = await fixture(t);
  f.prepare(); f.recover();
  const moved = f.current(), trashInput = { ...moved, kind: "trash" };
  delete trashInput.destinationPath;
  f.prepare(trashInput); const trashed = f.recover();
  assert.equal(trashed.status, "trashed");
  const state = nativeBoardLifecycleCatalog(f.root, f.db).get(f.key);
  const trashPlan = JSON.parse(state.trashPlan), bucket = join(f.root, "notes/.trash", trashPlan.entryId);
  const payload = readFileSync(join(bucket, "payload"));
  assert.equal(sha256(payload), state.documentSha256);
  assert.equal(readFileSync(join(bucket, "assets/pkm-todo-board.json"), "utf8"), f.backing);
  writeFileSync(join(f.root, "notes", state.path), "---\nknowledgeId: occupied\n---\nForeign\n", { mode: 0o600 });
  const restore = { ...trashInput, kind: "restore", operationId: randomUUID(), expectedDocumentDigest: state.documentSha256 };
  assert.throws(() => f.prepare(restore), denied);
  assert.deepEqual(readFileSync(join(bucket, "payload")), payload);
  unlinkSync(join(f.root, "notes", state.path));
  f.prepare(restore); const result = f.recover();
  assert.equal(result.status, "active");
  assert.deepEqual(readFileSync(join(f.root, "notes", state.path)), payload);
  const next = { ...f.current(), destinationPath: "Elsewhere/Final.md" };
  const pending = f.prepare(next);
  writeFileSync(join(f.root, "notes", pending.event.beforePath), "foreign unjournaled bytes\n", { mode: 0o600 });
  assert.throws(() => f.recover(), denied);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pending_document_lifecycle").get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM native_board_lifecycle_event").get().n, 3);
});
