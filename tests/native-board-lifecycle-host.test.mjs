import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental } from "../dist/legacy-root-adoption.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { Storage } from "../dist/storage.js";
import { startLegacyApiChatUiHost } from "../dist/legacy-api-chat-ui-host.js";
import { createLegacyApiChatLocalProvider } from "../dist/legacy-api-chat-local-provider.js";
import { admitNativeTodoUserAuthority } from "../dist/native-todo-user-ui.js";
import { authenticateBoardWorker, scanBoards } from "../dist/boards.js";

const require = createRequire(import.meta.url), project = resolve(new URL("../legacy", import.meta.url).pathname);
test("real adopted private host moves/renames/Trashes/restores old-code Board with Note/Chat identity, tokens and restart continuity", async t => {
  const fixture = join(project, ".migration-test-work", `board-file-host-${randomUUID()}`), root = join(fixture, "knowledge");
  const nonce = randomUUID(), actorId = randomUUID(), oldEnvironment = process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE;
  const options = require("../legacy/tests/next-trial-electron/in-place-options.cjs").options;
  let descriptor, storage, runtime, ui, authority;
  t.after(async () => {
    try { await ui?.close(); } finally { try { await runtime?.close(); } finally { await storage?.close(); } }
    if (oldEnvironment === undefined) delete process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE;
    else process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE = oldEnvironment;
    rmSync(fixture, { recursive: true, force: true });
  });
  process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE = nonce;
  const mask = process.umask(0o077);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const extension = process.env.PKM_TODO_LEGACY_EXTENSION ?? project;
    descriptor = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs").create({ extension, root });
    descriptor.text = descriptor.inline;
    require("../legacy/tests/next-trial-electron/todo-board-fixture.cjs").create({ extension, root, descriptor });
    const oldStore = require(join(extension, "dist/knowledge/filestore.js")), boardSlug = descriptor.todoBoards[0];
    const related = oldStore.noteGet(descriptor.todoBoards[1]);
    descriptor.relatedNoteId = related.knowledgeId;
    oldStore.noteWorkItemCommand(boardSlug, oldStore.noteWorkItemsRead(boardSlug).digest, {
      action: "create", item: { id: "old-linked-note", title: "Original identity-linked Note",
        goal: "Keep real old Note/Chat relationships through Board file lifecycle", scope: "Synthetic private root",
        acceptance: ["Canonical Note identity and original Chat owner remain"], state: "Planning", evidence: [],
        ownerId: `chat:${descriptor.inline}`, links: [`pkm://knowledge/${related.knowledgeId}`] },
    }, { id: "user:local", role: "user" });
    writeFileSync(join(fixture, "in-place-fixture-token"), nonce, { mode: 0o600 });
    writeFileSync(join(fixture, "native-ui-fixture-token"), nonce, { mode: 0o600 });
  } finally { process.umask(mask); }
  const key = descriptor.todoBoards[0], backing = readFileSync(join(root, "notes", `${key}.assets/pkm-todo-board.json`));
  const prepared = await prepareLegacyRootAdoptionExperimental(root, options({ fixture, root, nonce }));
  storage = (await resumeLegacyRootAdoptionExperimental(root, options({ fixture, root, nonce, workspaceId: prepared.workspaceId }))).storage;
  const start = async () => {
    authority = admitNativeTodoUserAuthority({ root, fixture, nonce, workspaceId: prepared.workspaceId, boards: descriptor.todoBoards });
    runtime = await createNativeRuntime({ storage, workspaceId: prepared.workspaceId });
    ui = await startLegacyApiChatUiHost({ storage, actorId,
      chats: [{ namespace: descriptor.namespace, chatId: descriptor.inline }],
      todoBoards: descriptor.todoBoards, todoAuthority: authority,
      authorizeTodo: async binding => binding.actorId === actorId && binding.workspaceId === prepared.workspaceId,
      authorizeTodoCreate: async binding => binding.actorId === actorId && binding.workspaceId === prepared.workspaceId,
      authorizeTodoLifecycle: async binding => binding.actorId === actorId && binding.workspaceId === prepared.workspaceId,
      authorize: async binding => binding.actorId === actorId && binding.workspaceId === prepared.workspaceId,
      provider: createLegacyApiChatLocalProvider({ endpoint: "http://127.0.0.1:1/v1", apiKey: "unused-synthetic", model: "synthetic" }),
    });
  };
  await start();
  const rpc = async payload => {
    const response = await fetch(`${ui.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${ui.bearer}`, "x-pkm-native-actor": actorId, "content-type": "application/json" },
      body: JSON.stringify(payload) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.value;
  };
  const read = () => rpc({ method: "todo", input: { kind: "read", boardSlug: key } });
  const before = await read();
  const initialChats = await rpc({ method: "list" });
  const initialHistory = await rpc({ method: "history", namespace: descriptor.namespace, chatId: descriptor.inline });
  const workerActor = "external:copilot:file-lifecycle", token = "ab".repeat(32);
  const { createHash } = await import("node:crypto");
  await rpc({ method: "todo", input: { kind: "worker-grant", boardSlug: key, operationId: randomUUID(),
    expectedDigest: before.snapshot.digest, actorId: workerActor, tokenHash: createHash("sha256").update(token).digest("hex") } });
  const first = await read(), stableNative = readFileSync(join(root, "boards", key, "pkm-todo-board.json"));
  const move = { kind: "move", boardSlug: key, operationId: randomUUID(), expectedDigest: first.snapshot.digest,
    expectedDocumentDigest: first.note.documentSha256, destinationPath: "File lifecycle/Moved Board.md", title: "Moved Board" };
  await assert.rejects(storage.requestNativeBoardLifecycle(move), /unforgeable/);
  await assert.rejects(storage.request({ operation: "private.native-board-lifecycle", actorId: "user:local", args: move }));
  const result = await rpc({ method: "todo-lifecycle", input: move });
  assert.deepEqual(await rpc({ method: "todo-lifecycle", input: move }), result);
  assert.equal(result.noteId, first.note.documentId);
  assert.deepEqual((await read()).snapshot.items, first.snapshot.items);
  assert.deepEqual(readFileSync(join(root, "boards", key, "pkm-todo-board.json")), stableNative);
  assert.deepEqual(readFileSync(join(root, "notes", "File lifecycle/Moved Board.assets/pkm-todo-board.json")), backing);
  const moved = await read();
  assert.deepEqual(moved.snapshot, first.snapshot);
  await assert.rejects(rpc({ method: "todo-link", boardSlug: key, uri: `pkm://knowledge/${randomUUID()}` }), /exact identity link/);
  const linked = await rpc({ method: "todo-link", boardSlug: key, uri: `pkm://knowledge/${descriptor.relatedNoteId}` });
  assert.equal(linked.note.knowledgeId, descriptor.relatedNoteId);
  assert.equal(linked.boardSlug, descriptor.todoBoards[1]);
  assert.equal(moved.note.slug, "File lifecycle/Moved Board");
  assert.equal(moved.note.knowledgeId, before.note.knowledgeId);
  assert.equal(authenticateBoardWorker(root, "File lifecycle/Moved Board", token).id, workerActor);
  assert.equal(authenticateBoardWorker(root, key, token).id, workerActor);
  const oldAlias = await storage.request({ operation: "knowledge.note.get", actorId, args: { path: `${key}.md` } });
  assert.equal(oldAlias.item.documentId, first.note.documentId);
  await assert.rejects(storage.createNativeTodoUserBoard({ title: key.split("/").at(-1),
    category: key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "", operationId: randomUUID() }, authority), /reserved|exists/);
  const trashInput = { kind: "trash", boardSlug: key, operationId: randomUUID(),
    expectedDigest: moved.snapshot.digest, expectedDocumentDigest: moved.note.documentSha256 };
  await rpc({ method: "todo-lifecycle", input: trashInput });
  assert(!(await rpc({ method: "todo-boards" })).includes(key));
  assert.equal(scanBoards(root).has(key), false);
  assert.throws(() => authenticateBoardWorker(root, key, token), /Trash|available/);
  const entries = await rpc({ method: "todo-trash" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].noteId, first.note.documentId);
  await ui.close(); ui = undefined; await runtime.close(); runtime = undefined; await storage.close();
  storage = await Storage.open(root);
  await start();
  assert(!(await rpc({ method: "todo-boards" })).includes(key));
  const entry = (await rpc({ method: "todo-trash" }))[0];
  await rpc({ method: "todo-lifecycle", input: { kind: "restore", boardSlug: key, operationId: randomUUID(),
    expectedDigest: entry.digest, expectedDocumentDigest: entry.documentDigest } });
  const restored = await read();
  assert.equal(restored.note.knowledgeId, before.note.knowledgeId);
  assert.equal(restored.note.documentId, before.note.documentId);
  assert.equal(restored.note.path, moved.note.path);
  assert.equal((await rpc({ method: "todo-link", boardSlug: key, uri: `pkm://knowledge/${descriptor.relatedNoteId}` })).note.knowledgeId, descriptor.relatedNoteId);
  assert.deepEqual(restored.snapshot.items, first.snapshot.items);
  assert.equal(authenticateBoardWorker(root, "File lifecycle/Moved Board", token).id, workerActor);
  assert.deepEqual((await rpc({ method: "list" })).map(chat => chat.id), initialChats.map(chat => chat.id));
  assert.deepEqual(await rpc({ method: "history", namespace: descriptor.namespace, chatId: descriptor.inline }), initialHistory);
  await ui.close(); ui = undefined; await runtime.close(); runtime = undefined; await storage.close();
  storage = await Storage.open(root);
  await start();
  assert.deepEqual((await read()).snapshot.items, first.snapshot.items);
  const created = await storage.createNativeTodoUserBoard({ title: "Native dual backing", category: "", operationId: randomUUID() }, authority);
  const nativeCreated = await rpc({ method: "todo", input: { kind: "read", boardSlug: created.slug } });
  const shadow = join(root, "notes", `${created.slug}.assets`);
  mkdirSync(shadow, { mode: 0o700 });
  writeFileSync(join(shadow, "pkm-todo-board.json"), backing, { mode: 0o600 });
  await assert.rejects(storage.requestNativeBoardLifecycle({ kind: "move", boardSlug: created.slug,
    operationId: randomUUID(), expectedDigest: nativeCreated.snapshot.digest,
    expectedDocumentDigest: nativeCreated.note.documentSha256, destinationPath: "Native moved.md" }, authority), /backing|authority/);
  rmSync(shadow, { recursive: true });
});
