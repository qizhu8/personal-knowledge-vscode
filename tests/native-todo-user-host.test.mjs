import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental } from "../dist/legacy-root-adoption.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { Storage } from "../dist/storage.js";
import { startLegacyApiChatUiHost } from "../dist/legacy-api-chat-ui-host.js";
import { createLegacyApiChatLocalProvider } from "../dist/legacy-api-chat-local-provider.js";
import { admitNativeTodoUserAuthority, NATIVE_TODO_USER_OPERATION } from "../dist/native-todo-user-ui.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const require = createRequire(import.meta.url), project = resolve(new URL("../legacy", import.meta.url).pathname);
test("authenticated private host preserves old-layout Todo, user edits and original worker tokens through stdio MCP and restart", async t => {
  const fixture = join(project, ".migration-test-work", `todo-user-host-${randomUUID()}`), root = join(fixture, "knowledge");
  let storage, runtime, ui;
  const nonce = randomUUID(), actorId = randomUUID(), oldEnvironment = process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE;
  t.after(async () => {
    try { await ui?.close(); } finally { try { await runtime?.close(); } finally { await storage?.close(); } }
    if (oldEnvironment === undefined) delete process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE;
    else process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE = oldEnvironment;
    rmSync(fixture, { recursive: true, force: true });
  });
  process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE = nonce;
  let descriptor, oldWorkerToken;
  const oldWorkerActor = "external:copilot:legacy-worker";
  const legacyExtension = process.env.PKM_TODO_LEGACY_EXTENSION ?? project;
  const mask = process.umask(0o077);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    descriptor = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs").create({ extension: legacyExtension, root });
    descriptor.text = descriptor.inline;
    require("../legacy/tests/next-trial-electron/todo-board-fixture.cjs").create({ extension: legacyExtension, root, descriptor });
    const oldStore = require(join(legacyExtension, "dist/knowledge/filestore.js")), slug = descriptor.todoBoards[0];
    oldStore.noteWorkItemCommand(slug, oldStore.noteWorkItemsRead(slug).digest, {
      action: "create", item: { id: "old-external", title: "Original external worker", goal: "Keep the original token",
        scope: "Synthetic legacy worker", acceptance: ["Same worker identity after user writes"], state: "Planning",
        evidence: [], ownerId: oldWorkerActor },
    }, { id: "user:local", role: "user" });
    oldWorkerToken = oldStore.todoBoardGrantWorker(slug, oldStore.noteWorkItemsRead(slug).digest, oldWorkerActor);
    writeFileSync(join(fixture, "in-place-fixture-token"), nonce, { mode: 0o600 });
    writeFileSync(join(fixture, "native-ui-fixture-token"), nonce, { mode: 0o600 });
  } finally { process.umask(mask); }
  const sources = Object.fromEntries(descriptor.todoBoards.flatMap(slug => [
    [`notes/${slug}.md`, readFileSync(join(root, "notes", `${slug}.md`))],
    [`notes/${slug}.assets/pkm-todo-board.json`, readFileSync(join(root, "notes", `${slug}.assets/pkm-todo-board.json`))],
  ]));
  const options = require("../legacy/tests/next-trial-electron/in-place-options.cjs").options;
  const prepared = await prepareLegacyRootAdoptionExperimental(root, options({ fixture, root, nonce }));
  storage = (await resumeLegacyRootAdoptionExperimental(root, options({ fixture, root, nonce, workspaceId: prepared.workspaceId }))).storage;
  const start = async () => {
    runtime = await createNativeRuntime({ storage, workspaceId: prepared.workspaceId });
    ui = await startLegacyApiChatUiHost({ storage, actorId,
      chats: [{ namespace: descriptor.namespace, chatId: descriptor.inline }], todoBoards: descriptor.todoBoards,
      todoAuthority: admitNativeTodoUserAuthority({ root, fixture, nonce, workspaceId: prepared.workspaceId, boards: descriptor.todoBoards }),
      authorizeTodo: async binding => binding.actorId === actorId && binding.workspaceId === prepared.workspaceId,
      authorizeTodoCreate: async binding => binding.actorId === actorId && binding.workspaceId === prepared.workspaceId,
      authorize: async binding => binding.actorId === actorId && binding.workspaceId === prepared.workspaceId,
      provider: createLegacyApiChatLocalProvider({ endpoint: "http://127.0.0.1:1/v1", apiKey: "unused-synthetic", model: "synthetic" }),
    });
  };
  await start();
  const rawRpc = async payload => {
    const response = await fetch(`${ui.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${ui.bearer}`, "x-pkm-native-actor": actorId, "content-type": "application/json" },
      body: JSON.stringify(payload) });
    return { status: response.status, ...await response.json() };
  };
  const creation = { title: "Native user created", category: "Team", operationId: randomUUID() };
  await assert.rejects(storage.createNativeTodoUserBoard(creation), /unforgeable/);
  await assert.rejects(storage.request({ operation: "todo.board.create", actorId: "user:local",
    args: { board_slug: "forged", operationId: randomUUID() } }), /trusted fixture/);
  const created = await rawRpc({ method: "todo-create", input: creation });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.equal(created.value.slug, "Team/Native user created");
  assert.deepEqual(await rawRpc({ method: "todo-create", input: creation }), created);
  assert.equal((await rawRpc({ method: "todo-create", input: { ...creation, title: "Different" } })).status, 409);
  assert.equal((await rawRpc({ method: "todo-create", input: { ...creation, operationId: randomUUID() } })).status, 409);
  assert((await rawRpc({ method: "todo-boards" })).value.includes(created.value.slug));
  const rpc = async (input, actor = actorId) => {
    const response = await fetch(`${ui.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${ui.bearer}`, "x-pkm-native-actor": actor, "content-type": "application/json" },
      body: JSON.stringify({ method: "todo", input }) });
    return { status: response.status, ...(response.status === 403 ? {} : await response.json()) };
  };
  const boardSlug = descriptor.todoBoards[0], read = { kind: "read", boardSlug };
  assert.equal((await rpc(read, randomUUID())).status, 403);
  assert.equal((await rpc({ ...read, boardSlug: "not-admitted" })).status, 409);
  const before = (await rpc(read)).value;
  const newBoard = await rpc({ kind: "read", boardSlug: created.value.slug });
  assert.equal(newBoard.status, 200, JSON.stringify(newBoard));
  assert.deepEqual(newBoard.value.snapshot.items, []);
  const newNoteId = newBoard.value.note.knowledgeId;
  assert.equal(typeof newNoteId, "string");
  assert(newNoteId.length > 0);
  const newItem = { kind: "command", boardSlug: created.value.slug, expectedDigest: created.value.digest, operationId: randomUUID(),
    command: { action: "create", item: { id: "created-task", title: "Created Board task", goal: "Keep real user authority",
      scope: "Synthetic only", acceptance: ["Restart identity"], state: "Planning", evidence: [] } } };
  const added = await rpc(newItem);
  assert.equal(added.status, 200);
  const deleted = await rpc({ ...newItem, operationId: randomUUID(), expectedDigest: added.value.snapshot.digest,
    command: { action: "delete", id: "created-task", reason: "Authenticated user deletes a task" } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted));
  assert(deleted.value.snapshot.items[0].deletedAt);
  const restored = await rpc({ ...newItem, operationId: randomUUID(), expectedDigest: deleted.value.snapshot.digest,
    command: { action: "restore", id: "created-task", reason: "Preserve exact user task identity" } });
  assert.equal(restored.status, 200, JSON.stringify(restored));
  assert(!restored.value.snapshot.items[0].deletedAt);
  assert.deepEqual(restored.value.snapshot.items[0].history.map(entry => entry.action), ["create", "delete", "restore"]);
  assert.equal(before.chats[0].id, descriptor.inline);
  const item = before.snapshot.items.find(item => item.id === "old-task");
  const input = { kind: "command", boardSlug, expectedDigest: before.snapshot.digest, operationId: randomUUID(),
    command: { action: "edit", item: { ...item, title: "Native actual host user edit", reviewerIds: ["user:local"] },
      reason: "Exact authenticated user continuation" } };
  const saved = await rpc(input);
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.equal(saved.value.snapshot.items.find(item => item.id === "old-task").title, "Native actual host user edit");
  assert.equal(saved.value.note.boardDigest, saved.value.snapshot.digest);
  assert.deepEqual((await rpc(input)).value.snapshot, saved.value.snapshot);
  assert.equal((await rpc({ ...input, operationId: randomUUID() })).status, 409);
  await assert.rejects(storage.request({ operation: NATIVE_TODO_USER_OPERATION, actorId: "user:local", args: input }), /Unknown|not found|operation/i);
  await assert.rejects(async () => storage.requestNativeTodoUser(input, []), /unforgeable/);
  await ui.close(); ui = undefined; await runtime.close(); runtime = undefined; await storage.close();
  storage = undefined;
  const client = new Client({ name: "original-worker-token-continuity", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: "python3",
    args: [join(project, "../compat/legacy-compact-mcp.py"), "--data", root, "--node", process.execPath, "--allow-writes"],
    env: { ...process.env, PKM_CAPABILITY_PROFILE: "legacy" }, stderr: "pipe" });
  let afterWorkerDigest;
  try {
    await client.connect(transport);
    const workerRead = await client.callTool({ name: "get_board", arguments: { board_slug: boardSlug, worker_token: oldWorkerToken } });
    assert.notEqual(workerRead.isError, true, JSON.stringify(workerRead));
    assert.equal(workerRead.structuredContent.actorId, oldWorkerActor);
    const claim = await client.callTool({ name: "claim_workitem", arguments: { board_slug: boardSlug, id: "old-external",
      expected_digest: workerRead.structuredContent.digest, worker_token: oldWorkerToken } });
    assert.notEqual(claim.isError, true, JSON.stringify(claim));
    assert.equal(claim.structuredContent.item.ownerId, oldWorkerActor);
    const submitted = await client.callTool({ name: "submit_workitem_result", arguments: { board_slug: boardSlug, id: "old-external",
      expected_digest: claim.structuredContent.digest, worker_token: oldWorkerToken, outcome: "Success",
      evidence: ["fixture://original-worker-native-stdio"] } });
    assert.notEqual(submitted.isError, true, JSON.stringify(submitted));
    afterWorkerDigest = submitted.structuredContent.digest;
    const forbidden = await client.callTool({ name: "accept_workitem", arguments: { board_slug: boardSlug, id: "old-external",
      expected_digest: afterWorkerDigest, worker_token: oldWorkerToken, reason: "A worker must not gain user approval authority" } });
    assert.equal(forbidden.isError, true);
    assert.match(JSON.stringify(forbidden), /user.*delegated reviewer/i);
  } finally { await client.close(); }
  storage = await Storage.open(root, { deferRecovery: true });
  await start();
  const reopened = await rpc(read);
  assert((await rawRpc({ method: "todo-boards" })).value.includes(created.value.slug));
  const reopenedCreated = await rpc({ kind: "read", boardSlug: created.value.slug });
  assert.equal(reopenedCreated.status, 200, JSON.stringify(reopenedCreated));
  assert.equal(reopenedCreated.value.note.knowledgeId, newNoteId);
  assert.equal(reopenedCreated.value.snapshot.items[0].id, "created-task");
  assert.equal(reopenedCreated.value.snapshot.items[0].history.at(-1).actorId, "user:local");
  assert.equal(reopened.status, 200, JSON.stringify(reopened));
  assert.equal(reopened.value.snapshot.digest, afterWorkerDigest);
  assert.equal(reopened.value.snapshot.items.find(item => item.id === "old-external").ownerId, oldWorkerActor);
  assert.equal(reopened.value.note.knowledgeId, before.note.knowledgeId);
  assert.deepEqual(reopened.value.note.aliases, before.note.aliases);
  for (const [source, bytes] of Object.entries(sources)) assert.deepEqual(readFileSync(join(root, source)), bytes);
});
