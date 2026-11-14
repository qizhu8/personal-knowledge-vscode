import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental } from "../dist/legacy-root-adoption.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { LegacyApiChatRuntime } from "../dist/legacy-api-chat-runtime.js";
const require = createRequire(import.meta.url), project = resolve(new URL("../legacy", import.meta.url).pathname);
const fixture = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs");
test("native API Chat keeps legacy authority inert, serializes competing providers and rejects stale/conflicting/denied/fenced operations", async t => {
  const directory = join(project, ".migration-test-work", `api-runtime-${randomUUID()}`), root = join(directory, "knowledge");
  let storage, native, ports = [], release;
  t.after(async () => {
    release?.("released during cleanup");
    try { for (const port of ports) await port.drain(); }
    finally { try { await native?.close(); } finally { await storage?.close(); rmSync(directory, { recursive: true, force: true }); } }
  });
  let descriptor;
  const originalGroup = `chat_group_${randomUUID().replace(/-/g, "")}`;
  const mask = process.umask(0o077);
  try {
    descriptor = fixture.create({ extension: project, root });
    mkdirSync(join(root, "notes"), { mode: 0o700 });
    writeFileSync(join(root, "notes/Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nSynthetic.\n", { mode: 0o600 });
    const file = join(descriptor.state, "api-chats", fixture.namespace, `${descriptor.inline}.json`);
    const metadata = JSON.parse(readFileSync(file));
    metadata.permissionMode = "allow-all"; metadata.builtinTools = ["run_command"];
    metadata.mcpServers = [{ name: "INERT NEVER START", command: "this-must-never-execute", args: [] }];
    writeFileSync(file, JSON.stringify(metadata));
    writeFileSync(join(descriptor.state, "api-chats/library.json"), JSON.stringify({
      version: 1, groups: [{ id: originalGroup, name: "Original synthetic group" }],
      placements: { [descriptor.inline]: { groupId: originalGroup } },
    }));
  } finally { process.umask(mask); }
  const source = join(descriptor.state, "api-chats", fixture.namespace, `${descriptor.inline}.json`);
  const originalHash = createHash("sha256").update(readFileSync(source)).digest("hex");
  const librarySource = join(descriptor.state, "api-chats/library.json"), originalLibraryBytes = readFileSync(librarySource);
  const nonce = randomUUID();
  writeFileSync(join(directory, "in-place-fixture-token"), nonce, { mode: 0o600 });
  const options = require("../legacy/tests/next-trial-electron/in-place-options.cjs").options;
  const prepared = await prepareLegacyRootAdoptionExperimental(root, options({ fixture: directory, root, nonce }));
  storage = (await resumeLegacyRootAdoptionExperimental(root, options({ fixture: directory, root, nonce, workspaceId: prepared.workspaceId }))).storage;
  native = await createNativeRuntime({ storage, workspaceId: await storage.workspaceId() });
  const identity = { namespace: fixture.namespace, chatId: descriptor.inline };
  let calls = 0, entered;
  const called = new Promise(resolve => { entered = resolve; });
  const provider = async messages => {
    calls++;
    assert(messages.every(message => Object.keys(message).every(key => ["role","content","images"].includes(key))));
    entered();
    return new Promise(resolve => { release = resolve; });
  };
  const authority = { storage, actorId: "fresh-api-actor", authorize: async () => true, provider,
    authorizeLibrary: async binding => binding.actorId === "fresh-api-actor" && binding.root === root };
  const port = new LegacyApiChatRuntime(authority);
  const competing = new LegacyApiChatRuntime(authority);
  const denied = new LegacyApiChatRuntime({ storage, actorId: "unapproved-api-actor", authorize: async () => false,
    provider: async () => { throw new Error("Unapproved provider must never run."); } });
  ports.push(port, competing, denied);
  await assert.rejects(denied.history(identity), /admission denied/);
  const history = await port.history(identity);
  assert.equal(history.metadata.permissionMode, "allow-all");
  assert.equal(history.metadataAuthority, "archive_only");
  assert.deepEqual(history.messages[0].images, [fixture.image]);
  const request = { ...identity, operationId: "one", expectedRevision: 0, text: "Fresh native continuation." };
  const pending = port.continue(request);
  await called;
  await assert.rejects(competing.mutateLibrary({ kind: "trash", chatId: identity.chatId,
    operationId: randomUUID(), expectedRevision: 0 }), /unfinished Chat operation/);
  await assert.rejects(competing.continue({ ...request, operationId: "two" }), /unfinished operation owns this Chat/);
  assert.equal(calls, 1);
  release("A single native response.");
  const result = await pending;
  assert.deepEqual(await competing.continue(request), result);
  assert.equal(calls, 1);
  await assert.rejects(port.continue({ ...request, text: "Different operation payload." }), /conflicts with its original request/);
  await assert.rejects(port.continue({ ...request, operationId: "stale" }), /changed; reopen/);
  assert.equal((await competing.history(identity)).messages.length, history.messages.length + 2);
  await assert.rejects(denied.library(), /Fresh native Chat Library authority/);
  assert.equal((await port.library()).state.placements[identity.chatId].groupId, originalGroup);
  const create = { kind: "create", operationId: randomUUID(), expectedRevision: 0, name: "Native group" };
  const created = await port.mutateLibrary(create);
  assert.deepEqual(await competing.mutateLibrary(create), created);
  const newGroup = created.state.groups.find(group => group.name === "Native group").id;
  await assert.rejects(competing.mutateLibrary({ ...create, name: "Conflicting name" }), /conflicts/);
  await assert.rejects(competing.mutateLibrary({ kind: "rename", groupId: newGroup, name: "Stale",
    operationId: randomUUID(), expectedRevision: 0 }), /changed; reopen/);
  let library = await competing.mutateLibrary({ kind: "move", chatId: identity.chatId,
    groupId: newGroup, operationId: randomUUID(), expectedRevision: 1 });
  library = await port.mutateLibrary({ kind: "trash", chatId: identity.chatId,
    operationId: randomUUID(), expectedRevision: library.revision });
  assert(library.state.placements[identity.chatId].trashedAt);
  await assert.rejects(competing.continue({ ...request, operationId: "trashed", expectedRevision: 1 }), /Restore this Chat/);
  assert.equal(calls, 1);
  library = await competing.mutateLibrary({ kind: "restore", chatId: identity.chatId,
    operationId: randomUUID(), expectedRevision: library.revision });
  assert.equal(library.state.placements[identity.chatId].trashedAt, undefined);
  library = await port.mutateLibrary({ kind: "rename", groupId: newGroup, name: "Renamed native group",
    operationId: randomUUID(), expectedRevision: library.revision });
  await assert.rejects(port.mutateLibrary({ kind: "create", name: "renamed NATIVE group",
    operationId: randomUUID(), expectedRevision: library.revision }), /unique Chat Library/);
  const restricted = new LegacyApiChatRuntime({ ...authority, libraryChatIds: [descriptor.segmented] });
  ports.push(restricted);
  await assert.rejects(restricted.mutateLibrary({ kind: "delete-group", groupId: newGroup,
    operationId: randomUUID(), expectedRevision: library.revision }), /outside its fresh host grant/);
  library = await port.mutateLibrary({ kind: "delete-group", groupId: newGroup,
    operationId: randomUUID(), expectedRevision: library.revision });
  assert.equal(library.state.placements[identity.chatId].groupId, "ungroup");
  assert.deepEqual(await competing.library(), library);
  assert.deepEqual(readFileSync(librarySource), originalLibraryBytes);
  const db = storage.connectNative();
  try { db.prepare("UPDATE native_runtime_owner SET fence=fence+1 WHERE singleton=1").run(); } finally { db.close(); }
  await assert.rejects(port.history(identity), /fenced|ownership lease was lost/);
  assert.equal(calls, 1);
  assert.equal(createHash("sha256").update(readFileSync(source)).digest("hex"), originalHash);
  await assert.rejects(native.close(), error => error.code === "STORAGE_UNAVAILABLE");
  native = undefined;
});
