import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, link, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createNativeLegacyTodoBoard, prepareLegacyTodoBoardCreate, legacyTodoBoardCreateFingerprint, LEGACY_TODO_BOARD_CREATE_PENDING_OPERATION } from "../dist/legacy-todo-board-create.js";
import { planTodo } from "../dist/boards.js";
import { readTodoBoard } from "../dist/domain/todo-board.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const actor = { id: "mcp:external", canWrite: true };
const authorize = (who, operation) => who.id === actor.id && operation === "todo.board.create";
const policy = { authorize: who => who.id === actor.id, recoveryActor: () => actor };
async function fixture(t) {
  const root = resolve(`.legacy-board-create-${randomUUID()}`);
  await mkdir(root);
  const data = join(root, "data");
  await initialize(data);
  const stores = [], runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    for (const storage of stores) await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  const open = async (directory = data) => {
    const storage = await Storage.open(directory); stores.push(storage);
    return storage;
  };
  const runtime = async storage => {
    const native = await createNativeRuntime({ storage, legacyNoteWorkItems: policy });
    runtimes.push(native);
    return native;
  };
  return { root, data, open, runtime };
}
async function call(native, operation, args, who = actor) {
  const response = await native.core.dispatch(operation.endsWith(".command") ? "capability_call" : "capability_read",
    { operation, version: 1, arguments: args }, who);
  if (response.error) throw Object.assign(new Error(response.error.message), response.error);
  return response.result;
}

test("host creation atomically publishes a discoverable original Note and native Board with live actor-bound command authority, replay and relocation", async t => {
  const f = await fixture(t), storage = await f.open(), native = await f.runtime(storage);
  const input = { title: "Board", category: "Team", operationId: randomUUID() };
  const created = await createNativeLegacyTodoBoard(storage, actor, input, authorize);
  const checkVersion = async store => {
    const db = store.connectNative();
    try { assert.equal(db.prepare("PRAGMA user_version").get().user_version, 24); } finally { db.close(); }
  };
  await checkVersion(storage);
  assert.deepEqual(Object.keys(created), ["ok", "slug", "items", "digest"]);
  assert.deepEqual(created, { ok: true, slug: "Team/Board", items: [], digest: readTodoBoard(await readFile(join(f.data, "boards/Team/Board/pkm-todo-board.json"), "utf8")).digest });
  const descriptor = await readFile(join(f.data, "notes/Team/Board.md"), "utf8");
  assert.match(descriptor, /documentKind: todo-board/);
  assert.match(descriptor, /type: todo/);
  assert.deepEqual(await readdir(join(f.data, "notes/Team")), ["Board.md"]);
  const notes = await call(native, "legacy.note.workitems.notes", { query: "Board", limit: 20 });
  assert(notes.notes.some(note => note.slug === created.slug && note.digest === created.digest));
  const changed = await call(native, "legacy.note.workitems.command", { slug: created.slug,
    expected_digest: created.digest, operationId: randomUUID(), command: { action: "create", item: {
      id: "first", title: "First", goal: "Verify creation", scope: "native", acceptance: ["Proven"],
      kind: "Task", state: "Planning", evidence: [],
    } } });
  assert.equal(changed.items.length, 1);
  assert.deepEqual(await createNativeLegacyTodoBoard(storage, actor, input, authorize), created);
  await assert.rejects(createNativeLegacyTodoBoard(storage, actor, { ...input, title: "Other" }, authorize), /different request/);
  const backup = join(f.root, "backup"), relocated = join(f.root, "relocated");
  await createWorkspaceBackup(storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence });
  assert.equal(JSON.parse(await readFile(join(backup, ".pkm-workspace-backup.json"), "utf8")).databaseUserVersion, 24);
  await native.close(); await storage.close();
  const restarted = await f.open(), restartedRuntime = await f.runtime(restarted);
  await checkVersion(restarted);
  assert.equal((await call(restartedRuntime, "legacy.note.workitems.read", { slug: created.slug })).items.length, 1);
  assert.deepEqual(await createNativeLegacyTodoBoard(restarted, actor, input, authorize), created);
  await restartedRuntime.close(); await restarted.close();
  await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
  const restored = await f.open(relocated), restoredRuntime = await f.runtime(restored);
  await checkVersion(restored);
  assert.equal((await call(restoredRuntime, "legacy.note.workitems.read", { slug: created.slug })).items.length, 1);
  assert.deepEqual(await createNativeLegacyTodoBoard(restored, actor, input, authorize), created);
  assert.deepEqual(await readFile(join(relocated, "notes/Team/Board.md"), "utf8"), descriptor);
});

test("creation refuses missing/revoked host authority, worker grants, unsafe raw original names and every existing source collision", async t => {
  const f = await fixture(t), storage = await f.open();
  const input = { title: "Board", category: "", operationId: randomUUID() };
  for (const who of [{ id: actor.id, canWrite: false }, { id: "other", canWrite: true },
    { ...actor, boardWorker: { boardSlug: "Board", digest: "a".repeat(64) } }]) {
    await assert.rejects(createNativeLegacyTodoBoard(storage, who, input, () => true), /host-authorized/);
  }
  await assert.rejects(createNativeLegacyTodoBoard(storage, actor, input, () => false), /host-authorized/);
  let decisions = 0;
  await assert.rejects(createNativeLegacyTodoBoard(storage, actor, input, () => ++decisions === 1), /revoked/);
  for (const [title, category] of [[" spaced ", ""], ["x/y", ""], ["Board", "../x"], ["Board", "System"], ["CON", ""]]) {
    await assert.rejects(createNativeLegacyTodoBoard(storage, actor, { title, category, operationId: randomUUID() }, authorize));
  }
  assert.deepEqual(await readdir(join(f.data, "notes")), []);
  await writeFile(join(f.data, "notes/Board.md"), "# Do not replace\n");
  await assert.rejects(createNativeLegacyTodoBoard(storage, actor, input, authorize), /already exists/);
  assert.equal(await readFile(join(f.data, "notes/Board.md"), "utf8"), "# Do not replace\n");
  await rm(join(f.data, "notes/Board.md"));
  await mkdir(join(f.data, "notes/Board.assets"));
  await writeFile(join(f.data, "notes/Board.assets/pkm-todo-board.json"), "{}");
  await assert.rejects(createNativeLegacyTodoBoard(storage, actor, input, authorize));
});

async function seedIntent(f, storage) {
  await storage.close();
  const input = { title: "Board", category: "Team", operationId: randomUUID() };
  const request = { operation: "todo.board.create", args: { board_slug: "Team/Board", operationId: input.operationId }, actorId: actor.id };
  const db = new DatabaseSync(join(f.data, "core.sqlite"));
  let plan;
  try {
    const native = planTodo(f.data, request), fingerprint = legacyTodoBoardCreateFingerprint(request, input);
    db.exec("BEGIN IMMEDIATE");
    prepareLegacyTodoBoardCreate(db, f.data, request, input, native.write.raw, fingerprint);
    db.prepare("INSERT INTO pending_todo VALUES(1,?,?,?,?,?,?,?,?)").run(input.operationId, fingerprint, actor.id,
      LEGACY_TODO_BOARD_CREATE_PENDING_OPERATION, native.write.slug, null, native.write.raw, JSON.stringify(native.result));
    plan = JSON.parse(db.prepare("SELECT plan_json FROM legacy_todo_board_create_intent").get().plan_json);
    db.exec("COMMIT");
  } finally { db.close(); }
  return { input, plan };
}

for (const state of ["absent", "descriptor", "board", "both", "linked-publication", "partial-temporary"]) {
  test(`committed original Board creation recovers ${state} publication once without rebinding authority`, async t => {
    const f = await fixture(t), storage = await f.open();
    const { input, plan } = await seedIntent(f, storage);
    const note = join(f.data, "notes/Team/Board.md"), board = join(f.data, "boards/Team/Board/pkm-todo-board.json");
    for (const path of [note, board]) await mkdir(dirname(path), { recursive: true });
    if (["descriptor", "both"].includes(state)) await writeFile(note, plan.descriptor);
    if (["board", "both"].includes(state)) await writeFile(board, plan.board);
    if (state === "linked-publication") {
      const temporary = join(dirname(note), `.pkm-write-${input.operationId}`);
      await writeFile(temporary, plan.descriptor); await link(temporary, note);
    }
    if (state === "partial-temporary") await writeFile(join(dirname(note), `.pkm-write-${input.operationId}`), "partial");
    const recovered = await f.open(), native = await f.runtime(recovered);
    const result = await createNativeLegacyTodoBoard(recovered, actor, input, authorize);
    assert.deepEqual((await call(native, "legacy.note.workitems.read", { slug: result.slug })).items, []);
    assert.equal(await readFile(note, "utf8"), plan.descriptor);
    assert.equal(await readFile(board, "utf8"), plan.board);
    const db = recovered.connectNative();
    try {
      assert.equal(db.prepare("SELECT count(*) n FROM legacy_todo_board_create_intent").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM receipts WHERE operation_id=?").get(input.operationId).n, 1);
      assert.equal(db.prepare("SELECT actor_id FROM legacy_note_workitems_canonical_source").get().actor_id, actor.id);
    } finally { db.close(); }
  });
}

for (const attack of ["foreign-note", "foreign-board", "symlink-parent", "board-temporary-symlink", "orphan", "changed-actor", "missing-companion", "downgraded-schema"]) {
  test(`startup detects ${attack} original Board intent before any publication`, async t => {
    const f = await fixture(t), storage = await f.open(), { plan } = await seedIntent(f, storage);
    if (attack === "foreign-note") { await mkdir(join(f.data, "notes/Team")); await writeFile(join(f.data, "notes/Team/Board.md"), "foreign"); }
    if (attack === "foreign-board") { await mkdir(join(f.data, "boards/Team/Board"), { recursive: true }); await writeFile(join(f.data, "boards/Team/Board/pkm-todo-board.json"), "foreign"); }
    if (attack === "symlink-parent") { await mkdir(join(f.root, "external")); await symlink(join(f.root, "external"), join(f.data, "notes/Team")); }
    if (attack === "board-temporary-symlink") {
      await mkdir(join(f.data, "boards/Team/Board"), { recursive: true });
      await writeFile(join(f.root, "external-temporary"), "preserve");
      await symlink(join(f.root, "external-temporary"), join(f.data, "boards/Team/Board", `.pkm-write-${plan.input.operationId}`));
    }
    if (["orphan", "changed-actor", "missing-companion", "downgraded-schema"].includes(attack)) {
      const db = new DatabaseSync(join(f.data, "core.sqlite"));
      try { db.exec(attack === "orphan" ? "DELETE FROM pending_todo" : attack === "missing-companion"
        ? "DELETE FROM legacy_todo_board_create_intent" : attack === "downgraded-schema"
          ? "PRAGMA user_version=23" : "UPDATE pending_todo SET actor_id='foreign'"); } finally { db.close(); }
    }
    await assert.rejects(Storage.open(f.data));
    if (attack !== "foreign-note" && attack !== "symlink-parent") await assert.rejects(readFile(join(f.data, "notes/Team/Board.md")), { code: "ENOENT" });
    const db = new DatabaseSync(join(f.data, "core.sqlite"));
    try {
      assert.equal(db.prepare("SELECT count(*) n FROM receipts").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM legacy_note_workitems_canonical_source").get().n, 0);
      if (attack !== "missing-companion") assert.equal(db.prepare("SELECT plan_json FROM legacy_todo_board_create_intent").get().plan_json, JSON.stringify(plan));
    } finally { db.close(); }
  });
}
