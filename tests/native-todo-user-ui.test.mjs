import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serializeTodoBoard, readTodoBoard } from "../dist/domain/todo-board.js";
import { planTodo, authenticateBoardWorker } from "../dist/boards.js";
import { planNativeTodoUser, nativeTodoUserDdl, prepareNativeTodoUserIntent, assertNativeTodoUserPending,
  nativeTodoUserFingerprint, NATIVE_TODO_USER_OPERATION, admitNativeTodoUserAuthority,
  assertNativeTodoUserAuthority } from "../dist/native-todo-user-ui.js";

const task = (id, extra = {}) => ({ id, title: id, goal: "User continuation", scope: "Synthetic Board",
  acceptance: ["Preserve original audit"], state: "Planning", evidence: [], ...extra });
function fixture(t) {
  const root = resolve("../.migration-test-work", `todo-user-${randomUUID()}`);
  mkdirSync(join(root, "boards/Board"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "boards/Board/pkm-todo-board.json"), serializeTodoBoard([task("old")]), { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function command(root, snapshot, operation, chats = []) {
  return planNativeTodoUser(root, { kind: "command", boardSlug: "Board", expectedDigest: snapshot.digest,
    operationId: randomUUID(), command: operation }, chats);
}
test("trusted original user can delegate reviewers/edit full drafts/delete/restore; generic Board API cannot gain user role", t => {
  const root = fixture(t);
  let snapshot = planNativeTodoUser(root, { kind: "read", boardSlug: "Board" }, []).result;
  const changed = command(root, snapshot, { action: "edit", item: { ...snapshot.items[0],
    reviewerIds: ["external:copilot:reviewer"], title: "Actual user edit" }, reason: "Delegate explicit review" });
  assert.deepEqual(changed.result.items[0].reviewerIds, ["external:copilot:reviewer"]);
  writeFileSync(join(root, "boards/Board/pkm-todo-board.json"), changed.write.raw);
  assert.throws(() => planTodo(root, { operation: "todo.workitem.update", actorId: "user:local", args: {
    board_slug: "Board", id: "old", expected_digest: changed.result.digest, operationId: randomUUID(),
    patch: { reviewerIds: ["external:copilot:second-reviewer"] }, reason: "Attempt generic escalation",
  } }), /reviewer|Invalid|Unknown|argument/i);
  const deleted = command(root, changed.result, { action: "delete", id: "old", reason: "Explicit deletion" });
  assert(deleted.result.items[0].deletedAt);
  writeFileSync(join(root, "boards/Board/pkm-todo-board.json"), deleted.write.raw);
  const restored = command(root, deleted.result, { action: "restore", id: "old", reason: "Explicit restore" });
  assert.equal(restored.result.items[0].deletedAt, undefined);
  assert.equal(restored.result.items[0].id, "old");
  assert.throws(() => command(root, snapshot, { action: "comment", id: "old", text: "Stale draft" }), error => error.code === "CONFLICT");
});
test("original Chat identity and cross-Board focus are validated, worker token grants retain only hashes", t => {
  const root = fixture(t), id = randomUUID(), chats = [{ id: `chat:${id}`, title: "Original Chat",
    chatUrl: `pkm://chats/0123456789abcdef/${id}` }];
  const snapshot = planNativeTodoUser(root, { kind: "read", boardSlug: "Board" }, []).result;
  assert.throws(() => command(root, snapshot, { action: "assign", id: "old", ownerId: `chat:${id}` }),
    /exact admitted original Chat/);
  const assigned = command(root, snapshot, { action: "assign", id: "old", ownerId: `chat:${id}` }, chats);
  assert.equal(assigned.result.items[0].ownerId, chats[0].id);
  mkdirSync(join(root, "boards/Other"), { mode: 0o700 });
  writeFileSync(join(root, "boards/Other/pkm-todo-board.json"),
    serializeTodoBoard([task("active", { state: "WIP", ownerId: chats[0].id })]), { mode: 0o600 });
  assert.throws(() => command(root, snapshot, { action: "edit", item: { ...snapshot.items[0],
    state: "WIP", ownerId: chats[0].id }, reason: "Conflicting focus" }, chats), error => error.code === "WORKITEM_FOCUS_CONFLICT");
  const token = "ab".repeat(32), actorId = "external:copilot:fixture";
  const grant = planNativeTodoUser(root, { kind: "worker-grant", boardSlug: "Board", expectedDigest: snapshot.digest,
    operationId: randomUUID(), actorId, tokenHash: createHash("sha256").update(token).digest("hex") }, chats);
  assert(!grant.write.raw.includes(token));
  writeFileSync(join(root, "boards/Board/pkm-todo-board.json"), grant.write.raw);
  assert.equal(authenticateBoardWorker(root, "Board", token).id, actorId);
});
test("durable private user pending requires the exact actor, request, effect and full snapshot receipt", t => {
  const root = fixture(t), db = new DatabaseSync(join(root, "user.sqlite"));
  try {
    db.exec(nativeTodoUserDdl);
    const snapshot = planNativeTodoUser(root, { kind: "read", boardSlug: "Board" }, []).result;
    const input = { kind: "command", boardSlug: "Board", expectedDigest: snapshot.digest,
      operationId: randomUUID(), command: { action: "comment", id: "old", text: "Durable new audit" } };
    const plan = planNativeTodoUser(root, input, []);
    db.exec("BEGIN IMMEDIATE"); prepareNativeTodoUserIntent(db, input, plan.write.raw); db.exec("COMMIT");
    const row = db.prepare("SELECT * FROM native_todo_user_intent").get();
    const pending = { operation: NATIVE_TODO_USER_OPERATION, operation_id: input.operationId,
      actor_id: "user:local", board_slug: "Board", fingerprint: nativeTodoUserFingerprint(input),
      before_sha256: input.expectedDigest, after_json: plan.write.raw, result: row.result_json };
    assertNativeTodoUserPending(db, pending);
    assert.throws(() => assertNativeTodoUserPending(db, { ...pending, actor_id: "mcp:external" }), /changed/);
    assert.throws(() => assertNativeTodoUserPending(db, { ...pending, result: "{}" }), /changed/);
    db.prepare("UPDATE native_todo_user_intent SET after_json=?").run(serializeTodoBoard([]));
    assert.throws(() => assertNativeTodoUserPending(db, pending), /changed/);
    assert.equal(readTodoBoard(plan.write.raw).items[0].comments[0].text, "Durable new audit");
  } finally { db.close(); }
});
test("user dispatch requires the exact Linux fixture approval, unforgeable capability and unchanged marker inode", t => {
  const fixture = resolve("../.migration-test-work", `todo-authority-${randomUUID()}`), root = join(fixture, "knowledge");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const nonce = randomUUID(), workspaceId = randomUUID(), marker = join(fixture, "native-ui-fixture-token");
  writeFileSync(marker, nonce, { mode: 0o600 });
  writeFileSync(join(root, ".pkm-next-workspace"), JSON.stringify({ id: workspaceId }), { mode: 0o600 });
  const previous = process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE;
  t.after(() => { if (previous === undefined) delete process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE;
    else process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE = previous; });
  delete process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE;
  assert.throws(() => admitNativeTodoUserAuthority({ root, fixture, nonce, workspaceId, boards: ["Board"] }), /synthetic-fixture-only/);
  process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE = nonce;
  const authority = admitNativeTodoUserAuthority({ root, fixture, nonce, workspaceId, boards: ["Board"] });
  assertNativeTodoUserAuthority(root, "Board", authority);
  assert.throws(() => assertNativeTodoUserAuthority(root, "Board", { kind: "synthetic-only" }), /unforgeable/);
  assert.throws(() => assertNativeTodoUserAuthority(root, "Other", authority), error => error.code === "ACCESS_DENIED");
  writeFileSync(marker + ".next", nonce, { mode: 0o600 });
  renameSync(marker + ".next", marker);
  assert.throws(() => assertNativeTodoUserAuthority(root, "Board", authority), /no longer current/);
});
