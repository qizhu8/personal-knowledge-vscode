import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { legacyMcpNotePolicy } from "../dist/legacy-mcp-note-policy.js";
import { serializeTodoBoard, readTodoBoard } from "../dist/domain/todo-board.js";
import { CoreError } from "../dist/contracts.js";

const actor = { id: "mcp:external", canWrite: true };
const pythonExecutable = execFileSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const note = "---\ntitle: Board\ndocumentKind: todo-board\n---\nOriginal descriptor.\n";
const board = serializeTodoBoard([], {});

for (const tamper of ["descriptor", "source-bytes", "missing-table", "dual-source", "workspace", "actor"])
test(`native-backed imported Note admission fails closed after ${tamper} tampering`, async t => {
  const parent = resolve("tests", `.note-policy-${randomUUID()}`);
  const source = join(parent, "source"), target = join(parent, "target");
  await mkdir(join(source, "notes/Board.assets"), { recursive: true, mode: 0o700 });
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeFile(join(source, "notes/Board.md"), note);
  await writeFile(join(source, "notes/Board.assets/pkm-todo-board.json"), board);
  const plan = await planLegacyImport(source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  await importLegacyWorkspace(plan, target, { pythonExecutable });
  const storage = await Storage.open(target);
  const policy = await legacyMcpNotePolicy(storage, actor);
  assert.equal(policy.canonicalSources.length, 1);
  const runtime = await createNativeRuntime({ storage, legacyNoteWorkItems: policy });
  await runtime.close(); await storage.close();
  const database = new DatabaseSync(join(target, "core.sqlite"));
  try {
    const row = database.prepare("SELECT * FROM legacy_note_workitems_canonical_source").get();
    assert.equal(row.source_board, board);
    assert.equal(row.actor_id, actor.id);
    assert.equal(database.prepare("SELECT source_kind FROM legacy_note_workitems_admission").get().source_kind, "native-board");
    assert.throws(() => database.prepare("UPDATE legacy_note_workitems_canonical_source SET source_board='{}'").run(), /immutable/);
    assert.throws(() => database.prepare("DELETE FROM legacy_note_workitems_canonical_source").run(), /immutable/);
    if (tamper === "source-bytes" || tamper === "actor") {
      database.exec("DROP TRIGGER legacy_note_workitems_canonical_source_no_update");
      database.prepare(tamper === "source-bytes"
        ? "UPDATE legacy_note_workitems_canonical_source SET source_board='{}'"
        : "UPDATE legacy_note_workitems_canonical_source SET actor_id='user:local'").run();
    }
    if (tamper === "missing-table") database.exec("DROP TABLE legacy_note_workitems_canonical_source");
  } finally { database.close(); }
  if (tamper === "descriptor") await writeFile(join(target, "notes/Board.md"), note.replace("title: Board", "title: Changed"));
  if (tamper === "dual-source") await writeFile(join(target, "notes/Board.assets/pkm-todo-board.json"), board);
  if (tamper === "workspace") {
    const marker = JSON.parse(await readFile(join(target, ".pkm-next-workspace"), "utf8"));
    await writeFile(join(target, ".pkm-next-workspace"), JSON.stringify({ ...marker, id: randomUUID() }));
  }
  await assert.rejects(async () => {
    let reopened, native;
    try {
      reopened = await Storage.open(target);
      native = await createNativeRuntime({ storage: reopened, legacyNoteWorkItems: await legacyMcpNotePolicy(reopened, actor) });
    } finally { await native?.close(); await reopened?.close(); }
  });

  assert.equal(await readFile(join(source, "notes/Board.md"), "utf8"), note);
  assert.equal(await readFile(join(source, "notes/Board.assets/pkm-todo-board.json"), "utf8"), board);
});

test("native-backed imported Note recovers a committed native worker effect into one historical full-snapshot receipt", async t => {
    const parent = resolve("tests", `.note-policy-recover-${randomUUID()}`);
    const source = join(parent, "source"), target = join(parent, "target");
    await mkdir(join(source, "notes/Board.assets"), { recursive: true, mode: 0o700 });
    let storage, runtime;
    const close = async () => { await runtime?.close(); runtime = undefined; await storage?.close(); storage = undefined; };
    t.after(async () => { try { await close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    await writeFile(join(source, "notes/Board.md"), note);
    await writeFile(join(source, "notes/Board.assets/pkm-todo-board.json"), board);
    const plan = await planLegacyImport(source);
    await importLegacyWorkspace(plan, target, { pythonExecutable });
    storage = await Storage.open(target);
    runtime = await createNativeRuntime({ storage, legacyNoteWorkItems: await legacyMcpNotePolicy(storage, actor) });
    const args = { slug: "Board", expected_digest: readTodoBoard(board).digest, operationId: randomUUID(),
      item: { id: "created", title: "Recover exactly once", goal: "Keep one native effect", scope: "Migration",
        acceptance: ["One receipt"], kind: "Task", state: "Planning", evidence: [] } };
    const request = { operation: "legacy.note.workitems.upsert", version: 1, arguments: args };
    const nativeCall = storage.requestLegacyNoteWorkItems.bind(storage);
    storage.requestLegacyNoteWorkItems = async (...values) => {
      await nativeCall(...values);
      throw new CoreError("RECOVERY_CONFLICT", "Injected after canonical receipt publication.", "unknown");
    };
    const interrupted = await runtime.core.dispatch("capability_call", request, actor);
    assert.equal(interrupted.error?.effect, "unknown");
    storage.requestLegacyNoteWorkItems = nativeCall;
    await close();
    const database = new DatabaseSync(join(target, "core.sqlite"), { readOnly: true });
    try {
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM legacy_note_workitems_intent").get().count, 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM receipts WHERE operation_id=?").get(args.operationId).count, 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM legacy_note_workitems_receipt").get().count, 0);
    } finally { database.close(); }
    storage = await Storage.open(target, { deferRecovery: true });
    await assert.rejects(createNativeRuntime({ storage,
      legacyNoteWorkItems: await legacyMcpNotePolicy(storage, { ...actor, canWrite: false }) }), /recovery|authority|policy/i);
    await close();
    storage = await Storage.open(target, { deferRecovery: true });
    runtime = await createNativeRuntime({ storage, legacyNoteWorkItems: await legacyMcpNotePolicy(storage, actor) });
    const replay = await runtime.core.dispatch("capability_call", request, actor);
    assert.equal(replay.error, undefined, JSON.stringify(replay));
    assert.equal(replay.result.items.length, 1);
    const current = await runtime.core.dispatch("capability_read", {
      operation: "legacy.note.workitems.read", version: 1, arguments: { slug: "Board" },
    }, actor);
    assert.deepEqual(current.result, replay.result);
    const foreign = await runtime.core.dispatch("capability_call", request, { id: "other:actor", canWrite: true });
    assert(foreign.error);
    const recovered = new DatabaseSync(join(target, "core.sqlite"), { readOnly: true });
    try {
      assert.equal(recovered.prepare("SELECT COUNT(*) AS count FROM legacy_note_workitems_intent").get().count, 0);
      assert.equal(recovered.prepare("SELECT COUNT(*) AS count FROM legacy_note_workitems_receipt").get().count, 1);
      assert.equal(recovered.prepare("SELECT COUNT(*) AS count FROM receipts WHERE operation_id=?").get(args.operationId).count, 1);
      assert.equal(recovered.prepare("SELECT source_board FROM legacy_note_workitems_canonical_source").get().source_board, board);
    } finally { recovered.close(); }
  });
