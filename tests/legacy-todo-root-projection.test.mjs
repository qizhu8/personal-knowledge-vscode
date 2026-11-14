import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { planLegacyImport } from "../dist/legacy-import.js";
import {
  planLegacyTodoRootProjection, publishLegacyTodoRootProjection, recordLegacyTodoProjection,
  verifyLegacyTodoProjectionReceipt,
} from "../dist/legacy-todo-root-projection.js";
import { commandTodoBoard, readTodoBoard } from "../dist/domain/todo-board.js";
import { nativeTodoUserDdl, prepareNativeTodoUserIntent, NATIVE_TODO_USER_OPERATION } from "../dist/native-todo-user-ui.js";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const store = require("../legacy/dist/knowledge/filestore.js");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const directory = resolve("../.migration-test-work", `todo-projection-${randomUUID()}`), root = join(directory, "knowledge");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const mask = process.umask(0o077);
  try {
    store.setStorePath(root);
    store.todoBoardCreate("Team/Board", "Board", "Team");
    let snapshot = store.noteWorkItemsRead("Team/Board");
    snapshot = store.noteWorkItemCommand("Team/Board", snapshot.digest, { action: "create", item: {
      id: "legacy-task", title: "Original task", goal: "Retain identity", scope: "Private fixture",
      acceptance: ["Preserve history"], state: "Planning", evidence: [],
    } }, { id: "user:local", role: "user" });
    store.noteWorkItemCommand("Team/Board", snapshot.digest, { action: "comment", id: "legacy-task", text: "Original audit comment" },
      { id: "user:local", role: "user" });
  } finally { process.umask(mask); }
  return { directory, root, source: join(root, "notes/Team/Board.assets/pkm-todo-board.json") };
}
test("old FileStore layout publishes exact bytes, retains identities/history and permits native user edits after receipt", async t => {
  const { directory, root, source } = fixture(t);
  const before = readFileSync(source);
  const plan = await planLegacyTodoRootProjection(root, await planLegacyImport(root));
  assert.equal(plan.boards.length, 1);
  await publishLegacyTodoRootProjection(root, plan, randomUUID());
  const target = join(root, plan.boards[0].destination);
  assert.deepEqual(readFileSync(target), before);
  const db = new DatabaseSync(join(directory, "receipt.sqlite")), workspace = randomUUID();
  try {
    db.exec("BEGIN IMMEDIATE"); recordLegacyTodoProjection(db, root, workspace, plan); db.exec("COMMIT");
    verifyLegacyTodoProjectionReceipt(db, root, workspace, plan);
    const current = readFileSync(target, "utf8"), snapshot = readTodoBoard(current);
    const changed = commandTodoBoard(current, snapshot.digest, { action: "edit",
      item: { ...snapshot.items[0], title: "Native user edit" }, reason: "Actual writable continuation" },
      { id: "user:local", role: "user" });
    const operationId = randomUUID();
    db.exec(nativeTodoUserDdl + `CREATE TABLE receipts(operation_id TEXT PRIMARY KEY,fingerprint TEXT,result TEXT,actor_id TEXT,operation TEXT,committed_at TEXT);`);
    db.exec("BEGIN IMMEDIATE");
    prepareNativeTodoUserIntent(db, { kind: "command", boardSlug: plan.boards[0].slug, expectedDigest: snapshot.digest,
      operationId, command: { action: "edit", item: { ...snapshot.items[0], title: "Native user edit" }, reason: "Actual writable continuation" } }, changed);
    db.exec("COMMIT");
    writeFileSync(target, changed, { mode: 0o600 });
    const intent = db.prepare("SELECT * FROM native_todo_user_intent WHERE operation_id=?").get(operationId);
    db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(operationId, intent.fingerprint, intent.result_json, "user:local", NATIVE_TODO_USER_OPERATION, new Date().toISOString());
    verifyLegacyTodoProjectionReceipt(db, root, workspace, plan);
    assert.deepEqual(readFileSync(source), before);
    const corrupt = JSON.parse(changed); corrupt.items[0].history = [];
    writeFileSync(target, JSON.stringify(corrupt), { mode: 0o600 });
    assert.throws(() => verifyLegacyTodoProjectionReceipt(db, root, workspace, plan), /history|receipt/);
  } finally { db.close(); }
});
test("journal-owned source-prefix interruption resumes without overwriting a conflicting staging file", async t => {
  const { root, source } = fixture(t), token = randomUUID();
  const plan = await planLegacyTodoRootProjection(root, await planLegacyImport(root));
  const directory = join(root, "boards/Team/Board"), temporary = join(directory, `.pkm-write-${token}`);
  mkdirSync(join(root, "boards"), { mode: 0o700 });
  mkdirSync(join(root, "boards/Team"), { mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const bytes = readFileSync(source);
  writeFileSync(temporary, bytes.subarray(0, 113), { mode: 0o600 });
  await publishLegacyTodoRootProjection(root, plan, token);
  assert.deepEqual(readFileSync(join(directory, "pkm-todo-board.json")), bytes);
  assert.equal(existsSync(temporary), false);
  writeFileSync(temporary, "unexpected user bytes", { mode: 0o600 });
  await assert.rejects(publishLegacyTodoRootProjection(root, plan, token), /Unexpected bytes/);
  assert.equal(readFileSync(temporary, "utf8"), "unexpected user bytes");
});
test("existing native target and changed original Note refuse projection with original bytes intact", async t => {
  const { root, source } = fixture(t), input = await planLegacyImport(root);
  const plan = await planLegacyTodoRootProjection(root, input), before = hash(readFileSync(source));
  mkdirSync(join(root, "boards/Team/Board"), { recursive: true, mode: 0o700 });
  const target = join(root, "boards/Team/Board/pkm-todo-board.json");
  writeFileSync(target, "unowned target", { mode: 0o600 });
  await assert.rejects(planLegacyTodoRootProjection(root, input), /never overwrites/);
  await assert.rejects(publishLegacyTodoRootProjection(root, plan, randomUUID()), /migration|source|publication/);
  assert.equal(readFileSync(target, "utf8"), "unowned target");
  assert.equal(hash(readFileSync(source)), before);
});
