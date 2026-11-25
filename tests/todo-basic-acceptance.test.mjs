import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { todoBasicFixture, value, hash, shape } from "./todo-basic-fixture.mjs";

test("Todo actual original MCP Board and Workitem planning/state CAS preserve generated audit, metadata, refusal no-effect and gateway reconnect", { timeout: 150000 }, async t => {
  const f = await todoBasicFixture(t), { client, transport } = await f.connect(), { client: original } = await f.connect(true);
  const version = value(await client.callTool({ name: "check_version", arguments: {} }));
  assert.equal(version.backend.storageEngine, "original");
  assert.equal(version.backend.storageMigrated, false);
  assert.equal(version.backend.version, "2.19.0");
  assert.equal(version.backend.operations, 151);
  assert.equal(version.runtime.runtimeBuild, f.frozen.runtimeBuild);
  assert.equal((await client.listTools()).tools.length, 27);
  const leaves = ["todo_board_create", "get_board", "add_workitem", "get_workitem", "update_workitem",
    "claim_workitem", "change_workitem_state", "list_boards", "list_workitems", "list_workitem_history",
    "list_board_changes", "note_work_items", "note_work_item_command", "accept_workitem"];
  await f.discover(client, leaves);
  for (const leaf of leaves) {
    const direct = value(await original.callTool({ name: "capabilities_describe",
      arguments: { operation: f.contracts.get(leaf).id } }));
    const { revision: originalRevision, ...originalContract } = direct;
    const { revision: gatewayRevision, ...gatewayContract } = f.contracts.get(leaf);
    assert.deepEqual(originalContract, gatewayContract, "The gateway owns its catalog revision, not original tool semantics.");
    assert.match(originalRevision, /^[a-f0-9]{64}$/);
    assert.match(gatewayRevision, /^[a-f0-9]{64}$/);
  }
  const board = { board_slug: f.slug }, id = "bounded-task", task = { ...board, id };
  const created = await f.successful(client, "create-board", "todo_board_create", { title: f.title, category: "Acceptance" });
  assert.equal(created.slug, f.slug);
  assert.equal(created.items.length, 0);
  let disk = await f.snapshot();
  assert.equal(created.digest, disk.original.snapshot.digest);
  const descriptor = disk.note, initialDisk = disk;
  const initial = await f.readParity(client, original, "get-empty-board", "get_board", board);
  assert.equal(initial.actorId, "mcp:external");
  assert.equal(initial.counts.workitems, 0);
  const added = await f.successful(client, "add-planning-workitem", "add_workitem", {
    ...board, expected_digest: initial.digest, item: {
      id, title: "Todo basic standalone sentinel", goal: "Preserve actual original planning contract",
      scope: "Disposable compatibility-A only", acceptance: ["Original CAS, audit and durable read are verified"],
      plannedStart: "2026-11-21", plannedEnd: "2026-11-22", description: "Unchanged presentation metadata",
      icon: "eye", links: ["fixture://todo-basic/planning"],
      monitoring: { endCondition: "One bounded read; no scheduler or model" },
    },
  });
  assert.equal(added.item.kind, "Task");
  assert.equal(added.item.state, "Planning");
  assert.equal(added.item.status, "todo");
  assert.equal(added.item.ownerId, undefined);
  assert.equal(added.item.acceptanceDecision, undefined);
  assert.equal(added.item.history_count, 1);
  assert.equal(added.actorId, "mcp:external");
  const read = await f.readParity(client, original, "get-created-workitem", "get_workitem", task);
  assert.deepEqual(read, added);
  const edit = await f.successful(client, "edit-planning-cas", "update_workitem", {
    ...task, expected_digest: read.digest, patch: { title: "Todo basic sentinel edited", plannedEnd: "2026-11-23" },
    reason: "Clarify the bounded planning contract",
  });
  assert.notEqual(edit.digest, read.digest);
  assert.equal(edit.item.state, "Planning");
  assert.equal(edit.item.ownerId, undefined);
  assert.equal(edit.item.history_count, 2);
  for (const field of ["goal", "scope", "acceptance", "plannedStart", "description", "icon", "links", "monitoring"])
    assert.deepEqual(edit.item[field], added.item[field]);
  await f.readParity(client, original, "get-edited-workitem", "get_workitem", task);

  async function refusal(stage, leaf, args, expected) {
    const before = await f.snapshot();
    const response = await f.call(client, stage, leaf, args);
    assert.equal(response.isError, true, JSON.stringify(response));
    assert.match(JSON.stringify(response), expected);
    const after = await f.snapshot();
    assert.deepEqual(after, before, `${stage} must change neither Note, pair, metadata nor generated audit.`);
    const errorText = response.content.filter(part => part.type === "text").map(part => part.text).join("");
    t.diagnostic(JSON.stringify({ stage, operation: f.contracts.get(leaf).id, isError: response.isError,
      refusal: errorText.split("\n")[0], originalReceiptSha256: hash(JSON.stringify(response)),
      effect: "no-change", digest: hash(after.board) }));
  }
  await refusal("wrong-digest-no-effect", "update_workitem", { ...task, expected_digest: read.digest,
    patch: { title: "Stale sentinel must not appear" }, reason: "Reject stale CAS" }, /Todo Board changed/);
  await refusal("default-external-nonowner-no-effect", "change_workitem_state", {
    ...task, expected_digest: edit.digest, state: "active",
  }, /Work Item must be owned by this actor/);
  await refusal("legacy-worker-contract-edit-no-effect", "note_work_item_command", {
    slug: f.slug, expected_digest: edit.digest,
    command: { action: "edit", item: (await f.snapshot()).original.snapshot.items[0],
      reason: "Do not elevate the restrictive compatibility worker endpoint" },
  }, /Work Item must be owned by this actor/);
  await refusal("default-external-acceptance-denied-no-effect", "accept_workitem", {
    ...task, expected_digest: edit.digest, reason: "Negative permission probe, never human acceptance",
  }, /Only a user or explicitly delegated reviewer can accept Work Items/);

  const claimed = await f.successful(client, "claim-authenticated-cas", "claim_workitem", { ...task, expected_digest: edit.digest });
  assert.equal(claimed.actorId, "mcp:external");
  assert.equal(claimed.item.ownerId, "mcp:external");
  assert.equal(claimed.item.state, "WIP");
  assert.equal(claimed.item.status, "active");
  await refusal("legacy-worker-protected-planning-no-effect", "note_work_item_command", {
    slug: f.slug, expected_digest: claimed.digest,
    command: { action: "edit", item: { ...(await f.snapshot()).original.snapshot.items[0],
      title: "Worker must not override planning contract" }, reason: "Require the genuine named Board management interface" },
  }, /Worker cannot edit protected field: title/);
  const held = await f.successful(client, "state-on-hold-cas", "change_workitem_state", {
    ...task, expected_digest: claimed.digest, state: "on-hold", reason: "Explicitly pause this synthetic contract; execute nothing",
  });
  assert.equal(held.item.state, "OnHold");
  assert.equal(held.item.status, "on-hold");
  assert.equal(held.item.ownerId, "mcp:external");
  assert.equal(held.item.acceptanceDecision, undefined);
  assert.equal(held.item.outcome, undefined);
  assert.equal(held.item.history_count, 4);
  const finalRead = await f.readParity(client, original, "get-state-workitem", "get_workitem", task);
  assert.deepEqual(finalRead, held);
  const finalBoard = await f.readParity(client, original, "get-state-board", "get_board", board);
  assert.equal(finalBoard.counts["on-hold"], 1);
  assert.equal(finalBoard.counts.accepted, 0);
  const listed = await f.readParity(client, original, "list-filtered-workitems", "list_workitems", {
    ...board, states: ["on-hold"], query: "sentinel edited", expected_digest: held.digest, limit: 1,
  });
  assert.equal(listed.total, 1);
  assert.deepEqual(listed.items, [held.item]);
  assert.equal(listed.next_offset, null);
  const boards = await f.readParity(client, original, "list-board-retrieval", "list_boards", { query: f.title, limit: 1 });
  assert.equal(boards.total, 1);
  assert.equal(boards.items[0].slug, f.slug);
  const history = await f.readParity(client, original, "history-first-page", "list_workitem_history", {
    ...task, expected_digest: held.digest, limit: 2,
  });
  assert.equal(history.total, 4);
  assert.equal(history.next_offset, 2);
  const next = await f.readParity(client, original, "history-second-page", "list_workitem_history", {
    ...task, expected_digest: held.digest, offset: history.next_offset, limit: 2,
  });
  assert.equal(next.next_offset, null);
  const events = [...history.items, ...next.items];
  assert.deepEqual(events.map(event => event.action), ["create", "edit", "claim", "transition"]);
  assert(events.every(event => event.actorId === "mcp:external" && Number.isFinite(Date.parse(event.at))));
  assert.deepEqual(events[1].changes.find(change => change.field === "title"), {
    field: "title", before: '"Todo basic standalone sentinel"', after: '"Todo basic sentinel edited"',
  });
  assert.equal(events[3].from, "WIP");
  assert.equal(events[3].to, "OnHold");
  const changes = await f.readParity(client, original, "board-changes-retrieval", "list_board_changes", {
    ...board, expected_digest: held.digest, since: events[0].at, limit: 10,
  });
  assert.equal(changes.total, 4);
  assert.deepEqual(changes.items.map(event => event.event_id), [`${id}:0`, `${id}:1`, `${id}:2`, `${id}:3`]);
  assert.deepEqual(changes.items.map(({ item_id, event_id, ...event }) => {
    assert.equal(item_id, id); return event;
  }), events);
  disk = await f.snapshot();
  assert.deepEqual(disk.note, descriptor);
  f.assertMetadata(initialDisk, disk);
  assert.deepEqual(disk.original.snapshot.items[0].history, events);
  const snapshot = await f.successful(client, "original-note-pair-snapshot", "note_work_items", { slug: f.slug });
  assert.deepEqual(snapshot, { ok: true, ...disk.original.snapshot });
  await refusal("stale-query-digest-no-effect", "list_workitem_history", {
    ...task, expected_digest: read.digest, offset: 2, limit: 2,
  }, /Todo Board changed/);
  await f.assertOriginalOwnership();
  const oldPid = transport.pid;
  assert(Number.isSafeInteger(oldPid) && oldPid > 0);
  await f.close(original); await f.close(client);
  const reopened = await f.connect();
  const newPid = reopened.transport.pid;
  assert(Number.isSafeInteger(newPid) && newPid > 0);
  assert.notEqual(newPid, oldPid);
  const persisted = await f.successful(reopened.client, "gateway-reconnect-durable-workitem", "get_workitem", task);
  assert.deepEqual(persisted, held);
  assert.deepEqual(await f.successful(reopened.client, "gateway-reconnect-durable-history", "list_workitem_history", {
    ...task, expected_digest: held.digest, limit: 10,
  }), { ...history, items: events, limit: 10, next_offset: null });
  assert.deepEqual(await f.snapshot(), disk);
  await f.assertOriginalOwnership();
  await f.close(reopened.client);
  t.diagnostic(JSON.stringify({ profile: "compatibility-a-isolated", originalPackageSha256: f.oracle.originalPackageSha256,
    backend: version.backend, stages: f.trace, reconnect: { oldPid, newPid },
    shapes: { create: shape(created), mutation: shape(held), board: shape(finalBoard), item: shape(held.item),
      history: shape(history), event: shape(events[0]), changes: shape(changes) },
    receipt: "Original generated digest/item/history results; not Core operationId/revision receipts, execution or human acceptance.",
    operatorInterface: "Actual named original Board APIs use callTodoApi; the restrictive note_work_item_command worker endpoint is not elevated.",
  }));
});

test("Todo cancelled gateway wait retains one real original CAS edit through EOF drain and durable reconnect without replay", { timeout: 150000 }, async t => {
  const f = await todoBasicFixture(t), { client, transport } = await f.connect();
  const oldPid = transport.pid;
  assert(Number.isSafeInteger(oldPid) && oldPid > 0);
  await f.discover(client, ["todo_board_create", "add_workitem", "update_workitem", "get_workitem", "list_workitem_history"]);
  const created = await f.successful(client, "create-board", "todo_board_create", { title: f.title, category: "Acceptance" });
  const task = { board_slug: f.slug, id: "cancelled-wait" };
  const added = await f.successful(client, "add-planning-workitem", "add_workitem", {
    board_slug: f.slug, expected_digest: created.digest,
    item: { id: task.id, title: "Before cancelled wait", goal: "Drain an actual original CAS write",
      scope: "No replay", acceptance: ["One generated edit only"] },
  });
  const before = await f.snapshot(), lock = await f.holdMutation();
  let exit;
  try {
    const controller = new AbortController();
    const writing = client.callTool({ name: "capability_call", arguments: {
      operation: f.contracts.get("update_workitem").id, version: 1, arguments: {
        ...task, expected_digest: added.digest, patch: { title: "One admitted original Todo edit" },
        reason: "Cancel caller wait only; never discard or replay admitted business work",
      },
    } }, undefined, { signal: controller.signal });
    const rejected = assert.rejects(writing);
    let status;
    for (let i = 0; i < 200; i++) {
      status = value(await client.callTool({ name: "mcp_lifecycle_status", arguments: {} }));
      if (status.inFlight > 0) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(status.inFlight, 1, "Prove gateway admission before cancelling the caller wait.");
    controller.abort(); await rejected;
    const draining = value(await client.callTool({ name: "mcp_lifecycle_quiesce", arguments: {} }));
    assert.equal(draining.phase, "draining");
    assert.equal(draining.inFlight, 1);
    assert.equal(draining.uncertainCalls, 1);
    assert.equal(draining.automaticReplay, false);
    f.trace.push({ stage: "cancelled-client-wait-original-edit-still-draining",
      operation: "mcp.tool.update_workitem", expectedDigest: added.digest, receipt: null,
      clientWait: "cancelled", originalInFlight: draining.inFlight, uncertainCalls: draining.uncertainCalls });
    assert.deepEqual(await readFile(f.boardPath), before.board);
    const child = transport._process;
    let exited = false;
    exit = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Todo gateway EOF drain did not finish.")), 15000);
      child.once("close", (code, signal) => { clearTimeout(timer); exited = true; resolve({ code, signal }); });
    });
    child.stdin.end();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(exited, false, "EOF cannot kill the original write while the mutation lock is held.");
    await lock.close();
    assert.deepEqual(await exit, { code: 0, signal: null });
    const reopened = await f.connect();
    const newPid = reopened.transport.pid;
    assert(Number.isSafeInteger(newPid) && newPid > 0);
    assert.notEqual(newPid, oldPid);
    const current = await f.successful(reopened.client, "cancelled-write-reconnect-read", "get_workitem", task);
    assert.equal(current.item.title, "One admitted original Todo edit");
    assert.notEqual(current.digest, added.digest);
    assert.equal(current.item.history_count, 2);
    assert.equal(current.item.ownerId, undefined);
    assert.equal(current.item.acceptanceDecision, undefined);
    const history = await f.successful(reopened.client, "cancelled-write-single-history", "list_workitem_history", {
      ...task, expected_digest: current.digest, limit: 10,
    });
    assert.equal(history.total, 2);
    assert.deepEqual(history.items.map(event => event.action), ["create", "edit"]);
    assert(history.items.every(event => event.actorId === "mcp:external"));
    const after = await f.snapshot();
    assert.deepEqual(after.note, before.note);
    f.assertMetadata(before, after);
    assert.equal(current.digest, hash(after.board));
    assert.deepEqual(after.original.snapshot.items[0].history, history.items);
    assert.deepEqual(f.currentRead("get_workitem", task), current);
    await f.assertOriginalOwnership();
    await f.close(reopened.client);
    t.diagnostic(JSON.stringify({ operation: "mcp.tool.update_workitem", stage: "cancelled-wait-drain-reconnect",
      draining, oldPid, newPid, outcome: await exit,
      originalDigest: added.digest, durableDigest: current.digest, generatedEvents: history.items,
      receipt: "Cancelled client wait is not a success receipt; one actual original persisted edit is independently read after drain. No retry, execution or acceptance.",
      stages: f.trace }));
  } finally { await lock.close(); }
});
