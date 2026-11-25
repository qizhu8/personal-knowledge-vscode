import assert from "node:assert/strict";
import { readFile, stat, mkdir, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { nativeTodoSourceFixture, value, hash } from "./native-todo-source-fixture.mjs";
import { readOriginalMcpDomain, readOriginalMcpTodoManifest, readOriginalMcpTodoAuthority,
  verifyOriginalMcpDomainFiles } from "../dist/original-mcp-domain-state.js";
import { getOriginalMcpTodoGenesisSourceScope, originalMcpTodoGenesisSourceControlForStorage,
  revokeOriginalMcpTodoGenesisSource, withOriginalMcpTodoGenesisSourceActivation,
  activateOriginalMcpTodoGenesisSource } from "../dist/original-mcp-todo-genesis-native.js";
import { readOriginalMcpTodoGenesisSources, readOriginalMcpTodoGenesisCustodyTransitions,
  originalMcpTodoGenesisCustodyExceptions, prepareOriginalMcpTodoGenesisSourceActivation,
  prepareOriginalMcpTodoGenesis, prepareOriginalMcpTodoGenesisIntent } from "../dist/original-mcp-todo-genesis.js";
import { withOriginalMcpPublicRequest, originalMcpRequestDigest as digest } from "../dist/original-mcp-native-host.js";
import { withOriginalMcpTodoGenesisContext, withApprovedOriginalMcpTodoGenesis,
  originalMcpTodoGenesisStorageAdmission } from "../dist/original-mcp-todo-genesis-native.js";

async function lifecycle(f, slug) {
  const board = { board_slug: slug }, id = "source-task", task = { ...board, id };
  const empty = await f.ok("get_board", board);
  const pair = await f.snapshot(slug);
  const added = await f.ok("add_workitem", { ...board, expected_digest: empty.digest, item: {
    id, title: "Bounded Source task", goal: "Keep exact original Todo semantics", scope: "Owned Source-only fixture",
    acceptance: ["CAS and generated durable audit"], plannedStart: "2026-11-22", plannedEnd: "2026-11-23",
  } });
  assert.equal(added.actorId, "mcp:external"); assert.equal(added.item.ownerId, undefined);
  const edited = await f.ok("update_workitem", { ...task, expected_digest: added.digest,
    patch: { title: "Bounded Source task edited" }, reason: "Clarify the planning contract" });
  assert.equal(edited.item.plannedStart, added.item.plannedStart);
  const stale = await f.call("update_workitem", { ...task, expected_digest: added.digest,
    patch: { title: "Stale write must not apply" }, reason: "Negative CAS" });
  assert.equal(stale.isError, true); assert.match(JSON.stringify(stale), /changed|CONFLICT/);
  const claimed = await f.ok("claim_workitem", { ...task, expected_digest: edited.digest });
  assert.equal(claimed.item.ownerId, "mcp:external");
  const held = await f.ok("change_workitem_state", { ...task, expected_digest: claimed.digest,
    state: "on-hold", reason: "Pause this synthetic record; execute nothing" });
  assert.equal(held.item.state, "OnHold"); assert.equal(held.item.acceptanceDecision, undefined);
  assert.equal(held.item.outcome, undefined);
  assert.deepEqual(await f.ok("get_workitem", task), held);
  const listed = await f.ok("list_workitems", { ...board, states: ["on-hold"], expected_digest: held.digest, query: "edited" });
  assert.equal(listed.total, 1); assert.equal(listed.items[0].id, id);
  const history = await f.ok("list_workitem_history", { ...task, expected_digest: held.digest });
  assert.deepEqual(history.items.map(item => item.action), ["create", "edit", "claim", "transition"]);
  assert(history.items.every(item => item.actorId === "mcp:external"));
  const changes = await f.ok("list_board_changes", { ...board, expected_digest: held.digest });
  assert.deepEqual(changes.items.map(item => item.event_id), [`${id}:0`, `${id}:1`, `${id}:2`, `${id}:3`]);
  const full = await f.ok("note_work_items", { slug });
  assert.equal(full.digest, held.digest); assert.deepEqual(full.items[0].history, history.items);
  assert.deepEqual(await f.snapshot(slug), pair, "Genesis Note and original pair remain immutable while the canonical Board changes.");
  assert.equal(hash(await readFile(join(f.root, `.pkm-next-todo/${slug}/pkm-todo-board.json`))), held.digest);
  return { task, held, history };
}

test("Todo first public Board uses genuine signed PUBLIC and genesis approval, settles one-use creation, then exact source GET UPDATE history and revocation without an imported domain", { timeout: 150000 }, async t => {
  const f = await nativeTodoSourceFixture(t);
  assert.equal(readOriginalMcpDomain(f.root, "todo"), undefined);
  await assert.rejects(stat(join(f.root, ".pkm-next-todo")), { code: "ENOENT" });
  const created = await f.ok("todo_board_create", { title: "FirstBoard" });
  assert.equal(created.ok, true); assert.equal(created.slug, "FirstBoard"); assert.deepEqual(created.items, []);
  assert.equal(readOriginalMcpDomain(f.root, "todo"), undefined, "Genesis never fabricates or mutates an import manifest.");
  const capsule = getOriginalMcpTodoGenesisSourceScope(f.storage, f.host, created.slug);
  const sourceControl = originalMcpTodoGenesisSourceControlForStorage(f.storage, capsule);
  assert.equal(Atomics.load(new Int32Array(sourceControl.revocation), 0), 0,
    "Settled creation's finally must not revoke the independently branded source lifetime.");
  const defaultRead = await f.ok("get_board", { board_slug: created.slug });
  assert.deepEqual(await f.ok("get_board", { board_slug: created.slug, worker_token: null }), defaultRead);
  const approvals = f.frames.filter(frame => frame.method === "public.approve"
    && frame.payload.request.operation === "mcp.tool.get_board");
  assert.equal(approvals.length, 2);
  for (const frame of approvals) {
    assert.deepEqual(frame.payload.request.arguments, { board_slug: created.slug });
    assert.equal(frame.payload.request.argumentsDigest, hash(JSON.stringify({ board_slug: created.slug })));
  }
  const result = await lifecycle(f, created.slug);
  const db = f.storage.connectNative();
  try {
    assert.deepEqual(verifyOriginalMcpDomainFiles(f.root, "todo", db), []);
    const source = readOriginalMcpTodoGenesisSources(f.root, db);
    assert.equal(source.length, 1);
    assert.equal(readOriginalMcpTodoManifest(f.root, db)[0].key, created.slug);
    assert.equal(readOriginalMcpTodoAuthority(f.root, "mcp:external", created.slug, db).sessionDecisionId, sourceControl.provenance.decision.decisionId);
    const transition = readOriginalMcpTodoGenesisCustodyTransitions(f.root, db)[0];
    assert.equal(transition.status, "committed");
    assert(transition.before.some(item => item.path === ".pkm-next-todo" && item.state === "absent"));
    assert(transition.after.some(item => item.path === ".pkm-next-todo" && item.identity?.kind === "directory"));
    assert.equal(transition.temporary.length, 0);
    assert.equal(originalMcpTodoGenesisCustodyExceptions(f.root, db).temporaries.size, 0);
    assert.equal(Number(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation='todo.board.create'").get().n), 1);
  } finally { db.close(); }
  await assert.rejects(f.storage.adoptOriginalMcpTodoGenesisSource(structuredClone(capsule)), { code: "NATIVE_AUTHORITY_REQUIRED" });
  assert.deepEqual(await f.ok("get_workitem", result.task), result.held);
  revokeOriginalMcpTodoGenesisSource(f.storage, f.host, created.slug);
  assert.equal(Atomics.load(new Int32Array(sourceControl.revocation), 0), 1);
  assert.equal((await f.call("get_workitem", result.task)).isError, true);
  const activation = await prepareOriginalMcpTodoGenesisSourceActivation(f.storage, f.host, created.slug);
  await withOriginalMcpTodoGenesisSourceActivation(f.port, activation, () => activateOriginalMcpTodoGenesisSource(f.storage, activation));
  assert.deepEqual(await f.ok("get_workitem", result.task), result.held);
  await assert.rejects(f.storage.adoptOriginalMcpTodoGenesisSource(capsule), { code: "NATIVE_AUTHORITY_REQUIRED" });
  assert.equal((await f.call("get_board", { board_slug: "AnotherBoard" })).isError, true);
  await f.session.close();
  assert.equal((await f.call("get_workitem", result.task)).isError, true);
  t.diagnostic(JSON.stringify({ profile: "signed-source-socket-not-installed", originalIds: f.trace,
    creation: f.frames.filter(frame => frame.method === "todo.board.create.approve").map(frame => ({
      phase: frame.payload.request.phase, operationId: frame.payload.request.operationId, requestSha256: frame.payload.requestSha256,
    })), receipt: "Original-shaped responses plus actual canonical/source receipts; no human acceptance, worker or model execution." }));
});

test("Todo genesis in an admitted imported Root preserves the historical manifest and keeps exact genesis revocation independent", { timeout: 150000 }, async t => {
  const f = await nativeTodoSourceFixture(t, { imported: true });
  const before = readOriginalMcpDomain(f.root, "todo");
  const originalPair = await f.snapshot("Team/Imported");
  const created = await f.ok("todo_board_create", { title: "NewBoard", category: "Team" });
  assert.equal(created.slug, "Team/NewBoard");
  const result = await lifecycle(f, created.slug);
  assert.deepEqual(readOriginalMcpDomain(f.root, "todo"), before);
  assert.deepEqual(await f.snapshot("Team/Imported"), originalPair);
  const boards = await f.ok("list_boards", {});
  assert.deepEqual(boards.items.map(item => item.slug).sort(), ["Team/Imported", "Team/NewBoard"]);
  revokeOriginalMcpTodoGenesisSource(f.storage, f.host, created.slug);
  assert.equal((await f.call("get_workitem", result.task)).isError, true, "The import session must not authorize a revoked genesis Board.");
  assert.equal((await f.ok("get_board", { board_slug: "Team/Imported" })).actorId, "mcp:external");
  assert.deepEqual(readOriginalMcpDomain(f.root, "todo"), before);
});

test("Todo genesis denied PUBLIC or exact review, occupied private and new-category targets, expired decisions and old tokens have no effects", { timeout: 150000 }, async t => {
  const f = await nativeTodoSourceFixture(t), args = { title: "DeniedBoard" };
  f.controls.denyPublic.add("mcp.tool.todo_board_create");
  assert.equal((await f.call("todo_board_create", args)).isError, true);
  assert.equal(f.frames.filter(frame => frame.method === "todo.board.create.approve").length, 0);
  f.controls.denyPublic.clear(); f.controls.denyGenesis = true;
  assert.equal((await f.call("todo_board_create", args)).isError, true);
  f.controls.denyGenesis = false; f.controls.genesisTtlMs = -1;
  assert.equal((await f.call("todo_board_create", args)).isError, true);
  f.controls.genesisTtlMs = 60000;
  for (const rejected of [{ title: "Secret", category: "Private" }, { title: "Board", category: "AbsentCategory" }, { title: "Entry" }])
    assert.equal((await f.call("todo_board_create", rejected)).isError, true);
  await assert.rejects(stat(join(f.root, "notes/DeniedBoard.md")), { code: "ENOENT" });
  await assert.rejects(stat(join(f.root, ".pkm-next-todo")), { code: "ENOENT" });
  const created = await f.ok("todo_board_create", { title: "RealBoard" });
  const before = await f.snapshot(created.slug), current = await f.ok("get_board", { board_slug: created.slug });
  assert.equal((await f.call("todo_board_create", { title: "RealBoard" })).isError, true);
  const beforeTokenProbe = f.frames.filter(frame => frame.method === "public.approve").length;
  for (const worker_token of ["", "0".repeat(64)]) {
    const refused = await f.call("get_board", { board_slug: created.slug, worker_token });
    assert.equal(refused.isError, true); assert.match(JSON.stringify(refused), /ACCESS_DENIED|supplied Board worker token/);
  }
  assert.equal(f.frames.filter(frame => frame.method === "public.approve").length, beforeTokenProbe,
    "Explicit empty strings are invalid in the actual original actor resolver; supplied tokens never reach the producer.");
  assert.equal((await f.call("accept_workitem", { board_slug: created.slug, id: "not-created",
    expected_digest: current.digest, reason: "Refusal-only probe; no review delegation" })).isError, true);
  assert.deepEqual(await f.snapshot(created.slug), before);
  f.controls.genesisTtlMs = 1000;
  const plan = await prepareOriginalMcpTodoGenesisSourceActivation(f.storage, f.host, created.slug);
  await withOriginalMcpTodoGenesisSourceActivation(f.port, plan, () => activateOriginalMcpTodoGenesisSource(f.storage, plan));
  const capsule = getOriginalMcpTodoGenesisSourceScope(f.storage, f.host, created.slug);
  await new Promise(resolve => setTimeout(resolve, 1100));
  await assert.rejects(f.storage.adoptOriginalMcpTodoGenesisSource(capsule), { code: "NATIVE_AUTHORITY_REQUIRED" });
  const expired = await f.call("get_board", { board_slug: created.slug });
  assert.equal(expired.isError, true, JSON.stringify(expired));
  assert.deepEqual(await f.snapshot(created.slug), before);
});

test("Todo pending custody transitions accept only genuine exact partial publication and reject altered Note backing canonical bytes or unknown temporaries", { timeout: 150000 }, async t => {
  const f = await nativeTodoSourceFixture(t), arguments_ = { title: "PendingBoard" };
  const plan = await prepareOriginalMcpTodoGenesis(f.storage, f.host, arguments_, randomUUID());
  const request = { operation: "todo.board.create", actorId: "mcp:external",
    args: { board_slug: plan.request.selection.boardSlug, operationId: plan.request.operationId } };
  await withOriginalMcpPublicRequest(f.storage, f.host, { operation: "mcp.tool.todo_board_create",
    tool: "todo_board_create", version: 1, readOnly: false, arguments: arguments_, argumentsDigest: digest(arguments_) },
  () => withOriginalMcpTodoGenesisContext(f.port, arguments_, () => withApprovedOriginalMcpTodoGenesis(f.storage, plan, async () => {
    const admission = originalMcpTodoGenesisStorageAdmission(f.storage, request);
    assert(admission, "Use the actual consumed signed review, never a JSON fixture decision.");
    await f.storage.withWorkspaceExclusive(async () => {
      const db = f.storage.connectNative();
      try {
        db.exec("BEGIN IMMEDIATE");
        prepareOriginalMcpTodoGenesisIntent(f.root, db, request, admission);
        db.exec("COMMIT");
      } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
      finally { db.close(); }
      for (const directory of [".pkm-next-todo", ".pkm-next-todo/PendingBoard", "notes/PendingBoard.assets"])
        await mkdir(join(f.root, directory), { mode: 0o700 });
      await writeFile(join(f.root, plan.request.selection.notePath), plan.descriptor, { mode: 0o600 });
      await writeFile(join(f.root, plan.request.selection.backingPath), plan.backing, { mode: 0o600 });
      await writeFile(join(f.root, `.pkm-next-todo/PendingBoard/.pkm-write-${plan.request.operationId}`),
        plan.backing.slice(0, 12), { mode: 0o600 });
    });
  })));
  const db = f.storage.connectNative();
  try {
    const read = () => readOriginalMcpTodoGenesisCustodyTransitions(f.root, db)[0];
    const pending = read();
    assert.equal(pending.status, "pending");
    assert.equal(pending.temporary.length, 1);
    assert(pending.after.some(item => item.path === plan.request.selection.notePath
      && item.identity?.sha256 === plan.request.selection.descriptorSha256));
    assert(pending.after.some(item => item.path === plan.request.selection.canonicalBoardPath && item.state === "absent"));
    for (const [path, original] of [[plan.request.selection.notePath, plan.descriptor],
      [plan.request.selection.backingPath, plan.backing], [plan.request.selection.canonicalBoardPath, undefined]]) {
      await writeFile(join(f.root, path), "ALTERED_PENDING_GENESIS_BYTES", { mode: 0o600 });
      assert.throws(read, { code: "RECOVERY_CONFLICT" }, path);
      if (original === undefined) await unlink(join(f.root, path));
      else await writeFile(join(f.root, path), original, { mode: 0o600 });
    }
    const unknown = join(f.root, `notes/PendingBoard.assets/.pkm-write-${randomUUID()}`);
    await writeFile(unknown, "UNKNOWN_TEMPORARY", { mode: 0o600 });
    assert.throws(read, { code: "RECOVERY_CONFLICT" });
    await unlink(unknown);
    assert.equal(read().temporary.length, 1);
    assert.equal(Number(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation='todo.board.create'").get().n), 0,
      "A legitimate pending control is not a successful Board creation or source activation.");
  } finally { db.close(); }
});
