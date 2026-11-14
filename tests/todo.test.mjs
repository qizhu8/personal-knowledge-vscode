import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { todoDefinitions } from "../dist/todo-definitions.js";
import { todoApiDefinitions } from "../dist/domain/todo-api-contract.js";
import { readTodoBoard, serializeTodoBoard } from "../dist/domain/todo-board.js";
import { sha256 } from "../dist/markdown.js";

const actor = { id: "external:claude:one", canWrite: true };
const other = { id: "external:copilot:two", canWrite: true };
const item = (id, extra = {}) => ({ id, title: id, goal: "Solve a problem", scope: "API contract", acceptance: ["Verified result"], ...extra });
const operation = name => todoDefinitions.find(definition => definition.transportName === name).id;
const coverage = new Set();
async function fixture(t) {
  const parent = join(dirname(fileURLToPath(import.meta.url)), `.todo-${randomUUID()}`);
  await mkdir(parent, { recursive: true });
  const directory = join(parent, "workspace"); await initialize(directory);
  const stores = [];
  t.after(async () => {
    try { for (const storage of stores) await storage.close(); }
    finally { await rm(parent, { recursive: true, force: true }); }
  });
  async function open() {
    const storage = await Storage.open(directory); stores.push(storage);
    const core = new Core(storage);
    async function raw(name, args, who = actor) {
      const definition = todoDefinitions.find(definition => definition.transportName === name);
      coverage.add(name);
      return core.dispatch(definition.readOnly ? "capability_read" : "capability_call",
        { operation: definition.id, version: 1, arguments: args }, who);
    }
    async function call(name, args, who = actor) {
      const result = await raw(name, args, who);
      if (result.error) throw Object.assign(new Error(result.error.message), result.error);
      return result.result;
    }
    async function create(slug = "Team/Board") {
      return call("create_board", { board_slug: slug, operationId: randomUUID() });
    }
    const read = (name, args = {}, who = actor, slug = "Team/Board") => call(name, { board_slug: slug, ...args }, who);
    const write = async (name, args, who = actor, slug = "Team/Board") => {
      const board = await read("get_board", {}, who, slug);
      return call(name, { board_slug: slug, expected_digest: board.digest, ...args, operationId: randomUUID() }, who);
    };
    return { storage, core, raw, call, create, read, write };
  }
  return { directory, open };
}
test("captured Todo domain is self-contained and business files match provenance; all legacy operations have canonical schemas", async () => {
  const provenance = JSON.parse(await readFile(new URL("../migration/todo-provenance.json", import.meta.url), "utf8"));
  for (const file of provenance.files) {
    const source = await readFile(new URL(`../${file.captured}`, import.meta.url));
    assert.equal(createHash("sha256").update(source).digest("hex"), file.capturedSha256);
    assert(!source.toString().includes('from "vscode"'));
    assert(!source.toString().includes('from "./filestore"'));
  }
  assert.equal(todoDefinitions.length, todoApiDefinitions.length + 1);
  assert.equal(new Set(todoDefinitions.map(item => item.id)).size, todoDefinitions.length);
  for (const legacy of todoApiDefinitions) {
    const definition = todoDefinitions.find(item => item.transportName === legacy.name);
    assert.equal(definition.readOnly, legacy.readOnly);
    if (!legacy.readOnly) assert.equal(definition.input.safeParse({}).success, false);
  }
});

test("categorized Todo CRUD preserves kinds, digest CAS, metadata, history and paginated queries", async t => {
  const { open } = await fixture(t);
  const { create, read, write, call, raw } = await open();
  await create();
  const discovery = await call("list_boards", { limit: 1 });
  assert.equal(discovery.items[0].slug, "Team/Board"); assert.equal(discovery.total, 1);
  await write("add_userstory", { item: item("story") });
  await write("add_userstory", { item: item("other-story") });
  await write("add_workitem", { item: item("task", { parentId: "story", plannedStart: "2026-11-01", plannedEnd: "2026-11-07" }) });
  await write("add_workitem", { item: item("dependent", { dependsOn: ["task"] }) });
  const old = (await read("get_board")).digest;
  await write("update_workitem", { id: "task", patch: { title: "Updated contract" }, reason: "Clarify" }, other);
  await assert.rejects(call("update_workitem", { board_slug: "Team/Board", expected_digest: old, id: "task", patch: { title: "Lost update" }, reason: "Stale", operationId: randomUUID() }), /changed/);
  await assert.rejects(read("list_workitems", { expected_digest: old, offset: 1 }), /changed/);
  await write("update_workitem", { id: "task", patch: {}, clear_fields: ["plannedStart", "plannedEnd"], reason: "Unscheduled" });
  assert.equal((await read("get_workitem", { id: "task" })).item.plannedStart, undefined);
  const history = await read("list_workitem_history", { id: "task", limit: 1 });
  assert.equal(history.total, 3); assert.equal(history.next_offset, 1);
  const changes = (await read("list_workitem_history", { id: "task", offset: 1, limit: 1 })).items[0];
  assert.equal(changes.actorId, other.id);
  assert.deepEqual(changes.changes.find(change => change.field === "title"), { field: "title", before: '"task"', after: '"Updated contract"' });
  await assert.rejects(write("update_workitem", { id: "task", patch: { reviewerIds: [actor.id] }, reason: "Self delegate" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(write("update_userstory", { id: "task", patch: { title: "Wrong" }, reason: "Wrong kind" }), /Work Item API/);
  await assert.rejects(write("add_userstory", { item: item("nested", { parentId: "story" }) }), /Only tasks/);
  await assert.rejects(write("update_workitem", { id: "task", patch: { dependsOn: ["dependent"] }, reason: "Cycle" }), /cycle/);
  await write("move_workitem", { id: "task", story_id: "other-story", reason: "Regroup" });
  assert.equal((await read("get_userstory", { id: "story" })).children.total, 0);
  assert.equal((await read("get_userstory", { id: "other-story" })).children.items[0].id, "task");
  await write("move_workitem", { id: "task", reason: "Unassign grouping" });
  assert.equal((await read("get_workitem", { id: "task" })).item.parentId, undefined);
  await write("update_userstory", { id: "story", patch: { goal: "Clearer", storyStatus: "confirmed" }, reason: "Clarify" }, other);
  assert.equal((await read("list_userstories")).total, 2);
  assert.equal((await read("list_workitems", { limit: 1 })).next_offset, 1);
  assert.equal((await read("list_workitems", { query: "Updated", story_id: "unassigned" })).total, 1);
  assert.equal((await read("get_board")).counts.todo, 2);
  assert.equal((await raw("get_board", { board_slug: "../escape" })).error.code, "INVALID_ARGUMENT");
  assert.equal((await raw("get_board", { board_slug: "Team/Board", actorId: "user:local" })).error.code, "INVALID_ARGUMENT");
});

test("Board reads accept backing files above the former 8-MiB limit", async t => {
  const { directory, open } = await fixture(t);
  const { create, read } = await open();
  await create();
  const path = join(directory, "boards/Team/Board/pkm-todo-board.json");
  const board = serializeTodoBoard([]);
  await writeFile(path, board + " ".repeat(8_388_609));
  assert.equal((await read("get_board")).digest, sha256(board + " ".repeat(8_388_609)));
});

test("Todo Chat directory and assignments use the authenticated actor's native sessions", async t => {
  const { directory, open } = await fixture(t);
  let api = await open();
  await api.create();
  await api.write("add_workitem", { item: item("chat-owned") });
  const createChat = async (who, title) => {
    const id = randomUUID();
    const response = await api.core.dispatch("capability_call", {
      operation: "chat.session.create", version: 1,
      arguments: { operationId: randomUUID(), id, expectedRevision: 0, title },
    }, who);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  const ownChat = await createChat(actor, "Owned Chat");
  const foreignChat = await createChat(other, "Other Actor Chat");
  const agents = await api.read("list_agents");
  const ownEntry = agents.items.find(agent => agent.id === `chat:${ownChat.id}`);
  assert.equal(ownEntry.kind, "pkm-chat");
  assert.equal(ownEntry.title, ownChat.title);
  const workspace = await api.core.dispatch("server_info", {}, actor);
  assert.equal(ownEntry.chatUrl, `pkm://chats/${workspace.result.workspaceId.replaceAll("-", "").slice(0, 16)}/${ownChat.id}`);
  assert(!agents.items.some(agent => agent.id === `chat:${foreignChat.id}`), "another actor's Chat is not discoverable");
  assert.equal(agents.chatDirectory.available, true);
  assert.match(agents.chatDirectory.reason, /authenticated actor/);

  const assigned = await api.write("assign_workitem", {
    id: "chat-owned", owner_id: `chat:${ownChat.id}`, reason: "Assign owned Chat",
  });
  assert.equal(assigned.item.ownerId, `chat:${ownChat.id}`);
  await assert.rejects(
    api.write("assign_workitem", { id: "chat-owned", owner_id: `chat:${foreignChat.id}`, reason: "Assign foreign Chat" }),
    /Chat no longer exists/,
  );

  const archived = await api.core.dispatch("capability_call", {
    operation: "chat.session.archive", version: 1,
    arguments: { operationId: randomUUID(), id: ownChat.id, expectedRevision: ownChat.revision },
  }, actor);
  assert.equal(archived.error, undefined);
  const afterArchive = await api.read("list_agents");
  assert(!afterArchive.items.some(agent => agent.id === `chat:${ownChat.id}` && agent.kind === "pkm-chat"));
  assert(afterArchive.items.some(agent => agent.id === `chat:${ownChat.id}` && agent.kind === "missing-chat"));
  await assert.rejects(
    api.write("assign_workitem", { id: "chat-owned", owner_id: `chat:${ownChat.id}`, reason: "Assign archived Chat" }),
    /Chat no longer exists/,
  );
});

test("execution is identity-bound, dependency-aware and never grants acceptance to the submitting agent", async t => {
  const { open } = await fixture(t); const { create, read, write } = await open();
  await create();
  await write("add_workitem", { item: item("first") });
  await write("add_workitem", { item: item("dependent", { dependsOn: ["first"] }) });
  assert.deepEqual((await read("list_workitems", { actionable: true })).items.map(item => item.id), ["first"]);
  await assert.rejects(write("claim_workitem", { id: "dependent" }), /dependencies/);
  assert.equal((await read("get_workitem", { id: "first" })).item.ownerId, undefined);
  await write("assign_workitem", { id: "first", owner_id: actor.id, reason: "Stable identity" }, other);
  await assert.rejects(write("claim_workitem", { id: "first" }, other), /another actor/);
  await write("claim_workitem", { id: "first" });
  await assert.rejects(write("change_workitem_state", { id: "first", state: "blocked" }), /reason/);
  await write("change_workitem_state", { id: "first", state: "blocked", blocked_reason: "Waiting for service" });
  await write("change_workitem_state", { id: "first", state: "active" });
  await assert.rejects(write("submit_workitem_result", { id: "first", outcome: "Success", evidence: [] }), /evidence/);
  const verification = [{ layer: "unit", status: "passed", evidence: ["test://unit"] }, { layer: "e2e", status: "blocked", evidence: [], reason: "Unavailable" }];
  const done = await write("submit_workitem_result", { id: "first", outcome: "Unsure", evidence: ["test://result"], verification });
  assert.equal(done.item.state, "Done"); assert.deepEqual(done.item.verification, verification);
  assert.equal(done.item.acceptanceDecision, undefined);
  await assert.rejects(write("accept_workitem", { id: "first", reason: "Self approve" }), /delegated reviewer/);
  await write("add_workitem_comment", { id: "first", text: "Recorded after result" });
  assert.equal((await read("get_workitem", { id: "first" })).item.comments[0].actorId, actor.id);
  assert((await read("list_board_changes", { limit: 100 })).total >= 7);
  await write("claim_workitem", { id: "dependent" });
  await write("release_workitem", { id: "dependent", reason: "Return to queue" });
  await write("reopen_workitem", { id: "first", reason: "New attempt" });
  assert.equal((await read("get_workitem", { id: "first" })).item.outcome, undefined);
});

test("single workspace owner serializes cross-board focus; receipts survive restart", async t => {
  const { open } = await fixture(t);
  const a = await open(), b = a;
  await a.create(); await a.create("Other/Board");
  await a.write("add_workitem", { item: item("a") });
  await b.write("add_workitem", { item: item("b") }, actor, "Other/Board");
  const boardA = await a.read("get_board"), boardB = await b.read("get_board", {}, actor, "Other/Board");
  const claims = await Promise.all([
    a.raw("claim_workitem", { board_slug: "Team/Board", id: "a", expected_digest: boardA.digest, operationId: randomUUID() }),
    b.raw("claim_workitem", { board_slug: "Other/Board", id: "b", expected_digest: boardB.digest, operationId: randomUUID() }),
  ]);
  assert.equal(claims.filter(result => result.result).length, 1);
  assert.equal(claims.find(result => result.error).error.code, "WORKITEM_FOCUS_CONFLICT");
  const board = claims[0].result ? "Team/Board" : "Other/Board";
  const id = claims[0].result ? "a" : "b";
  await a.write("change_workitem_state", { id, state: "on-hold", reason: "Explicitly pause" }, actor, board);
  const before = await a.read("get_board", {}, actor, board);
  const args = { board_slug: board, id, text: "durable comment", expected_digest: before.digest, operationId: randomUUID() };
  const first = await a.call("add_workitem_comment", args);
  await a.storage.close(); await b.storage.close();
  const restarted = await open();
  assert.deepEqual(await restarted.call("add_workitem_comment", args), first);
  await assert.rejects(restarted.call("add_workitem_comment", { ...args, text: "different" }), /different request/);
  await assert.rejects(restarted.call("add_workitem_comment", args, other), /different request/);
  const readOnly = await restarted.raw("delete_workitem", { board_slug: board, id, expected_digest: first.digest, reason: "No authority", operationId: randomUUID() }, { ...actor, canWrite: false });
  assert.equal(readOnly.error.code, "ACCESS_DENIED");
});

test("soft-delete/restore and Story parent/reviewer guards retain original semantics", async t => {
  const { directory, open } = await fixture(t);
  let api = await open(); await api.create();
  await api.write("add_userstory", { item: item("story") });
  await api.write("add_workitem", { item: item("task", { parentId: "story" }) });
  await assert.rejects(api.write("delete_userstory", { id: "story", reason: "Has child" }), /child/);
  await api.write("delete_workitem", { id: "task", reason: "Removed" });
  await api.write("delete_userstory", { id: "story", reason: "Removed" });
  await assert.rejects(api.write("restore_workitem", { id: "task", reason: "Parent gone" }), /parent/);
  await api.write("restore_userstory", { id: "story", reason: "Restore parent first" });
  await api.write("restore_workitem", { id: "task", reason: "Restore child" });
  await api.write("claim_workitem", { id: "task" });
  await api.write("submit_workitem_result", { id: "task", outcome: "Success", evidence: ["test://pass"] });
  await api.storage.close();
  const path = join(directory, "boards/Team/Board/pkm-todo-board.json");
  const model = JSON.parse(await readFile(path, "utf8"));
  model.items.find(item => item.id === "task").reviewerIds = [other.id];
  await writeFile(path, serializeTodoBoard(model.items));
  api = await open();
  await api.write("accept_workitem", { id: "task", reason: "Explicitly delegated review" }, other);
  await api.write("change_userstory_state", { id: "story", state: "active" });
  await api.write("change_userstory_state", { id: "story", state: "completed", outcome: "Success", evidence: ["test://story"] });
  await assert.rejects(api.write("reopen_workitem", { id: "task", reason: "Parent Done" }), /parent/);
  await assert.rejects(api.write("accept_userstory", { id: "story", reason: "Not delegated" }), /delegated reviewer/);
  await api.storage.close();
  const reviewed = JSON.parse(await readFile(path, "utf8"));
  reviewed.items.find(item => item.id === "story").reviewerIds = [other.id];
  await writeFile(path, serializeTodoBoard(reviewed.items));
  api = await open();
  await api.write("accept_userstory", { id: "story", reason: "Story review" }, other);
  await api.write("reopen_userstory", { id: "story", reason: "New Story attempt" });
  assert.equal((await api.read("get_userstory", { id: "story" })).story.acceptanceDecision, undefined);
  const agents = await api.read("list_agents");
  assert(agents.items.some(agent => agent.id === actor.id));
  assert.equal(agents.chatDirectory.available, true);
  assert.match(agents.chatDirectory.reason, /authenticated actor/);
  await assert.rejects(api.write("assign_workitem", { id: "task", owner_id: `chat:${randomUUID()}`, reason: "Missing Chat" }), /Chat no longer exists/);
});

test("pending Todo journal recovers a committed command exactly once", async t => {
  const { directory, open } = await fixture(t);
  const api = await open(); await api.create(); await api.storage.close();
  const before = await readFile(join(directory, "boards/Team/Board/pkm-todo-board.json"), "utf8");
  const after = serializeTodoBoard([{ ...item("recover"), kind: "Task", state: "Planning", evidence: [] }]);
  const args = { board_slug: "Team/Board", expected_digest: sha256(before), item: item("recover"), operationId: randomUUID() };
  const request = { operation: operation("add_workitem"), args, actorId: actor.id };
  const result = { actorId: actor.id, board_slug: "Team/Board", digest: sha256(after), item: readTodoBoard(after).items[0] };
  const db = new DatabaseSync(join(directory, "core.sqlite"));
  db.prepare("INSERT INTO pending_todo VALUES(1,?,?,?,?,?,?,?,?)").run(
    args.operationId, sha256(JSON.stringify(request)), actor.id, request.operation, "Team/Board", sha256(before), after, JSON.stringify(result),
  );
  db.close();
  const recovered = await open();
  assert.equal((await recovered.read("list_workitems")).items[0].id, "recover");
  assert.equal(await readFile(join(directory, "boards/Team/Board/pkm-todo-board.json"), "utf8"), after);
});

test("Todo journal recognizes an already-replaced file, retains receipt, and fails closed on external conflict", async t => {
  const { directory, open } = await fixture(t);
  const api = await open(); await api.create(); await api.storage.close();
  const path = join(directory, "boards/Team/Board/pkm-todo-board.json");
  const before = await readFile(path, "utf8");
  const after = serializeTodoBoard([{ ...item("recovered"), kind: "Task", state: "Planning", evidence: [] }]);
  const operationId = randomUUID();
  const expected = { actorId: actor.id, board_slug: "Team/Board", digest: sha256(after), item: readTodoBoard(after).items[0] };
  const db = new DatabaseSync(join(directory, "core.sqlite"));
  db.prepare("INSERT INTO pending_todo VALUES(1,?,?,?,?,?,?,?,?)").run(
    operationId, "a".repeat(64), actor.id, operation("add_workitem"), "Team/Board", sha256(before), after, JSON.stringify(expected),
  );
  db.close();
  await writeFile(path, after);
  const recovered = await open();
  assert.equal((await recovered.read("list_workitems")).items[0].id, "recovered");
  await recovered.storage.close();
  const check = new DatabaseSync(join(directory, "core.sqlite"));
  assert.deepEqual(JSON.parse(check.prepare("SELECT result FROM receipts WHERE operation_id=?").get(operationId).result), expected);
  assert.equal(check.prepare("SELECT count(*) AS total FROM pending_todo").get().total, 0);
  const next = serializeTodoBoard([{ ...item("other"), kind: "Task", state: "Planning", evidence: [] }]);
  check.prepare("INSERT INTO pending_todo VALUES(1,?,?,?,?,?,?,?,?)").run(
    randomUUID(), "b".repeat(64), actor.id, operation("add_workitem"), "Team/Board", sha256(before), next, JSON.stringify(expected),
  );
  check.close();
  await assert.rejects(Storage.open(directory), /changed outside the server/);
  assert.equal(await readFile(path, "utf8"), after);
  const pending = new DatabaseSync(join(directory, "core.sqlite"));
  assert.equal(pending.prepare("SELECT count(*) AS total FROM pending_todo").get().total, 1);
  pending.close();
});

test("Board paths reject traversal/symlinks and System mutations while preserving System reads", async t => {
  const { directory, open } = await fixture(t);
  const api = await open();
  for (const slug of ["../escape", "/absolute", "a//b", "hidden/.secret", "a\\b", "CON", "a/NUL.md"]) {
    const result = await api.raw("create_board", { board_slug: slug, operationId: randomUUID() });
    assert.equal(result.error.code, "INVALID_ARGUMENT", slug);
  }
  assert.equal((await api.raw("create_board", { board_slug: "System/Board", operationId: randomUUID() })).error.code, "ACCESS_DENIED");
  await mkdir(join(directory, "boards/System/Board"), { recursive: true });
  const board = serializeTodoBoard([]);
  await writeFile(join(directory, "boards/System/Board/pkm-todo-board.json"), board);
  assert.equal((await api.read("get_board", {}, actor, "System/Board")).digest, sha256(board));
  await assert.rejects(api.write("add_workitem", { item: item("denied") }, actor, "System/Board"), { code: "ACCESS_DENIED" });
  await api.storage.close();
  await symlink(join(directory, "boards/System"), join(directory, "boards/linked"), "dir");
  await assert.rejects(Storage.open(directory), /symlinks/);
});

test("every migrated legacy Todo API is exercised by the integration scenarios", () => {
  const missing = todoApiDefinitions.map(definition => definition.name).filter(name => !coverage.has(name));
  assert.deepEqual(missing, []);
});
