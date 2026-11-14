import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { serializeTodoBoard, readTodoBoard } from "../dist/domain/todo-board.js";
import {
  initializeLegacyNoteWorkItemsSchema, verifyLegacyNoteWorkItemsWorkspace,
} from "../dist/host-composition-legacy-note-workitems.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const actor = { id: "mcp:external", canWrite: true, collaborationKind: "agent" };
const note = "---\r\ntitle: Board\r\ndocumentKind: todo-board\r\nunknown: {retain: exact}\r\n---\r\nOriginal descriptor.\r\n";
const first = { id: "first", title: "Keep original authority", goal: "Preserve exact pins", scope: "Migration",
  acceptance: ["One authenticated receipt"], kind: "Task", state: "Planning", evidence: [] };
const second = { ...first, id: "second", title: "Continue after old backup restore" };
const board = serializeTodoBoard([first], {});
const sourcePath = root => join(root, "notes/Board.assets/pkm-todo-board.json");
const quiescence = { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) };
const call = (runtime, method, operation, args) =>
  runtime.core.dispatch(method, { operation, version: 1, arguments: args }, actor);
const originalPins = database => database.prepare(`SELECT slug,source_markdown_sha256,source_board_sha256,
  native_board_sha256,admitted_at FROM legacy_note_workitems_admission ORDER BY slug`).all();

function oldSchema(database) {
  database.exec(`BEGIN IMMEDIATE;
    DROP TABLE legacy_note_workitems_canonical_source;
    ALTER TABLE legacy_note_workitems_admission DROP COLUMN source_kind;
    COMMIT`);
}

async function fixture(t) {
  const parent = resolve("next-server/tests", `.note-old-schema-${randomUUID()}`);
  const root = join(parent, "workspace");
  await mkdir(parent);
  await initialize(root);
  await mkdir(join(root, "notes/Board.assets"), { recursive: true });
  await mkdir(join(root, "boards/Board"), { recursive: true });
  await writeFile(join(root, "notes/Board.md"), note);
  await writeFile(sourcePath(root), board);
  await writeFile(join(root, "boards/Board/pkm-todo-board.json"), board);
  const policy = {
    admissions: [{ slug: "Board", sourceMarkdownDigest: hash(note), sourceBoardDigest: hash(board), nativeBoardDigest: hash(board) }],
    authorize: (who, operation) => who.id === actor.id
      && (who.canWrite || operation === "legacy.note.workitems.read" || operation === "legacy.note.workitems.notes"),
    recoveryActor: request => request.actorId === actor.id ? actor : undefined,
  };
  const storage = await Storage.open(root);
  const runtime = await createNativeRuntime({ storage, legacyNoteWorkItems: policy });
  let closed = false;
  const close = async () => {
    if (!closed) { closed = true; await runtime.close(); await storage.close(); }
  };
  t.after(async () => { try { await close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  return { parent, root, storage, runtime, policy, close };
}

test("actual old-schema dual-source backup restores, migrates, reads and replays immutable native-bound writes", async t => {
  const f = await fixture(t);
  const request = { slug: "Board", expected_digest: readTodoBoard(board).digest,
    command: { action: "claim", id: first.id }, operationId: randomUUID() };
  const claimed = await call(f.runtime, "capability_call", "legacy.note.workitems.command", request);
  assert.equal(claimed.error, undefined, JSON.stringify(claimed));
  await f.runtime.close();
  let pins, receipt;
  await f.storage.withWorkspaceExclusive(async () => {
    const database = new DatabaseSync(join(f.root, "core.sqlite"));
    try {
      pins = originalPins(database);
      receipt = database.prepare("SELECT * FROM legacy_note_workitems_receipt").get();
      oldSchema(database);
      verifyLegacyNoteWorkItemsWorkspace(database, f.root);
    } finally { database.close(); }
  });
  const backup = join(f.parent, "old-backup"), restored = join(f.parent, "relocated");
  await createWorkspaceBackup(f.storage, backup, quiescence);
  await f.close();
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority });
  const beforeMigration = new DatabaseSync(join(restored, "core.sqlite"), { readOnly: true });
  try {
    assert(!beforeMigration.prepare("PRAGMA table_info(legacy_note_workitems_admission)").all()
      .some(column => column.name === "source_kind"));
    assert.equal(beforeMigration.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_note_workitems_canonical_source'").get(), undefined);
    assert.deepEqual(originalPins(beforeMigration), pins);
    assert.deepEqual(beforeMigration.prepare("SELECT * FROM legacy_note_workitems_receipt").get(), receipt);
  } finally { beforeMigration.close(); }

  const storage = await Storage.open(restored);
  let runtime;
  try {
    runtime = await createNativeRuntime({ storage, legacyNoteWorkItems: f.policy });
    const migrated = new DatabaseSync(join(restored, "core.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(originalPins(migrated), pins);
      assert.equal(migrated.prepare("SELECT source_kind FROM legacy_note_workitems_admission").get().source_kind, "original-pair");
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM legacy_note_workitems_canonical_source").get().count, 0);
    } finally { migrated.close(); }
    const replay = await call(runtime, "capability_call", "legacy.note.workitems.command", request);
    assert.deepEqual(replay.result, claimed.result);
    assert.deepEqual((await call(runtime, "capability_read", "legacy.note.workitems.read", { slug: "Board" })).result, claimed.result);
    const upsert = { slug: "Board", expected_digest: claimed.result.digest, item: second, operationId: randomUUID() };
    const updated = await call(runtime, "capability_call", "legacy.note.workitems.upsert", upsert);
    assert.equal(updated.error, undefined, JSON.stringify(updated));
    assert.equal(updated.result.items.length, 2);
    assert.deepEqual((await call(runtime, "capability_call", "legacy.note.workitems.upsert", upsert)).result, updated.result);
    assert.deepEqual((await call(runtime, "capability_call", "legacy.note.workitems.command", request)).result, claimed.result);
    assert.deepEqual((await call(runtime, "capability_read", "legacy.note.workitems.read", { slug: "Board" })).result, updated.result);
    const foreign = await runtime.core.dispatch("capability_call",
      { operation: "legacy.note.workitems.command", version: 1, arguments: request }, { ...actor, id: "other:actor" });
    assert(foreign.error);
    const database = new DatabaseSync(join(restored, "core.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(originalPins(database), pins);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM legacy_note_workitems_receipt").get().count, 2);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM receipts WHERE operation_id IN (?,?)")
        .get(request.operationId, upsert.operationId).count, 2);
      verifyLegacyNoteWorkItemsWorkspace(database, restored);
    } finally { database.close(); }
    assert.equal(await readFile(join(restored, "notes/Board.md"), "utf8"), note);
    assert.equal(await readFile(sourcePath(restored), "utf8"), board);
  } finally { await runtime?.close(); await storage.close(); }
});

for (const missing of ["source-table", "source-kind"])
test(`mixed ${missing} dual-source schema denies backup and startup without repairing missing trust data`, async t => {
  const f = await fixture(t);
  await f.runtime.close();
  const database = new DatabaseSync(join(f.root, "core.sqlite"));
  try {
    database.exec(missing === "source-table" ? "DROP TABLE legacy_note_workitems_canonical_source"
      : "ALTER TABLE legacy_note_workitems_admission DROP COLUMN source_kind");
    assert.throws(() => verifyLegacyNoteWorkItemsWorkspace(database, f.root), /incomplete/);
  } finally { database.close(); }
  await assert.rejects(createWorkspaceBackup(f.storage, join(f.parent, "denied-backup"), quiescence), /incomplete/);
  await f.close();
  await assert.rejects(Storage.open(f.root), /incomplete/);
  const unchanged = new DatabaseSync(join(f.root, "core.sqlite"), { readOnly: true });
  try {
    assert.equal(unchanged.prepare("PRAGMA table_info(legacy_note_workitems_admission)").all()
      .some(column => column.name === "source_kind"), missing === "source-table");
    assert.equal(!!unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_note_workitems_canonical_source'").get(),
      missing === "source-kind");
  } finally { unchanged.close(); }
});

for (const changed of ["descriptor", "source-board"])
test(`old-schema dual-source admission still refuses changed original ${changed} during backup and migrated startup`, async t => {
  const f = await fixture(t);
  await f.runtime.close();
  const database = new DatabaseSync(join(f.root, "core.sqlite"));
  let pins;
  try { pins = originalPins(database); oldSchema(database); } finally { database.close(); }
  await writeFile(changed === "descriptor" ? join(f.root, "notes/Board.md") : sourcePath(f.root),
    changed === "descriptor" ? `${note}Changed original descriptor.\r\n` : serializeTodoBoard([], {}));
  await assert.rejects(createWorkspaceBackup(f.storage, join(f.parent, "denied-backup"), quiescence), /changed|admission|pin/i);
  await f.close();
  const reopened = await Storage.open(f.root);
  try {
    await assert.rejects(createNativeRuntime({ storage: reopened, legacyNoteWorkItems: f.policy }), /changed|admission|pin/i);
    const verified = new DatabaseSync(join(f.root, "core.sqlite"), { readOnly: true });
    try { assert.deepEqual(originalPins(verified), pins); } finally { verified.close(); }
  } finally { await reopened.close(); }
});

test("old-source schema migration rolls back both additions together on interruption", async t => {
  const f = await fixture(t);
  await f.runtime.close(); await f.close();
  const database = new DatabaseSync(join(f.root, "core.sqlite"));
  try {
    oldSchema(database);
    const pins = originalPins(database), originalExec = database.exec.bind(database);
    database.exec = sql => {
      if (sql === "RELEASE legacy_note_source_schema") throw new Error("Injected schema interruption");
      return originalExec(sql);
    };
    assert.throws(() => initializeLegacyNoteWorkItemsSchema(database), /Injected schema interruption/);
    database.exec = originalExec;
    assert(!database.prepare("PRAGMA table_info(legacy_note_workitems_admission)").all()
      .some(column => column.name === "source_kind"));
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_note_workitems_canonical_source'").get(), undefined);
    assert.deepEqual(originalPins(database), pins);
    verifyLegacyNoteWorkItemsWorkspace(database, f.root);
    initializeLegacyNoteWorkItemsSchema(database);
    verifyLegacyNoteWorkItemsWorkspace(database, f.root);
    assert.deepEqual(originalPins(database), pins);
  } finally { database.close(); }
});

for (const state of ["empty", "nonempty", "missing-trigger", "missing-column", "existing-journal", "current-version"])
test(`pre-17 Note initialization admits only an empty exact source schema without any journal (${state})`, async t => {
  const f = await fixture(t);
  await f.close();
  const database = new DatabaseSync(join(f.root, "core.sqlite"));
  try {
    database.exec(`DROP TABLE legacy_note_workitems_receipt;
      DROP TABLE legacy_note_workitems_intent;
      ${state === "existing-journal" ? "" : "DROP TABLE legacy_note_workitems_admission;"}
      DROP TABLE legacy_note_workitems_native_binding;
      PRAGMA user_version=${state === "current-version" ? 23 : 16}`);
    if (state === "nonempty") database.prepare(`INSERT INTO legacy_note_workitems_canonical_source
      VALUES(?,?,?,?,?,?,?)`).run("Board", hash(note), hash(board), board, "unknown-workspace", actor.id, "unknown-binding");
    if (state === "missing-trigger") database.exec("DROP TRIGGER legacy_note_workitems_canonical_source_no_update");
    if (state === "missing-column") database.exec("ALTER TABLE legacy_note_workitems_canonical_source DROP COLUMN actor_id");
    if (state === "existing-journal") database.exec("ALTER TABLE legacy_note_workitems_admission DROP COLUMN source_kind");
    const before = database.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    if (state === "empty") {
      initializeLegacyNoteWorkItemsSchema(database);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM legacy_note_workitems_canonical_source").get().count, 0);
      assert(database.prepare("PRAGMA table_info(legacy_note_workitems_admission)").all().some(row => row.name === "source_kind"));
      verifyLegacyNoteWorkItemsWorkspace(database, f.root);
    } else {
      assert.throws(() => initializeLegacyNoteWorkItemsSchema(database), /incomplete|unknown authority/);
      assert.deepEqual(database.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), before);
      if (state === "nonempty")
        assert.equal(database.prepare("SELECT COUNT(*) AS count FROM legacy_note_workitems_canonical_source").get().count, 1);
    }
  } finally { database.close(); }
});
