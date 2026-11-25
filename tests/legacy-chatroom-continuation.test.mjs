import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { LegacyChatroomContinuation, inspectLegacyChatroomArchive } from "../dist/legacy-chatroom-continuation.js";
import { adoptLegacyRootInPlaceExperimental } from "../dist/legacy-root-adoption.js";
const require = createRequire(import.meta.url);
const fixture = require("../legacy/tests/next-trial-electron/chatroom-fixture.cjs");
const project = resolve(new URL("../legacy", import.meta.url).pathname);
const load = name => import(pathToFileURL(join(project, "../dist", `${name}.js`)).href);
const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");

async function harness(t, adoptArchive = false) {
  const directory = join(project, ".migration-test-work", `chatroom-focused-${randomUUID()}`);
  const root = join(directory, "knowledge"), extension = join(directory, "old-source");
  mkdirSync(join(extension, "dist"), { recursive: true });
  let storage, native, provider;
  t.after(async () => {
    try { await native?.close(); await storage?.close(); await provider?.close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  const ts = require("typescript");
  // Use the real legacy writer/schema, not a hand-crafted SQLite facsimile.
  for (const name of ["chat-persistence", "chat-persistence-worker"]) {
    const source = readFileSync(join(project, "src/chatroom", `${name}.ts`), "utf8");
    writeFileSync(join(extension, name === "chat-persistence" ? "dist" : "", `${name}.js`), ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText);
  }
  for (const name of ["sql-wasm.js", "sql-wasm.wasm"])
    copyFileSync(join(project, "node_modules/sql.js/dist", name), join(directory, name));
  if (adoptArchive) {
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes/Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nSynthetic.\n");
    await fixture.create({ extension, root });
    storage = (await adoptLegacyRootInPlaceExperimental(root, {})).storage;
  } else {
    await initialize(root);
    storage = await Storage.open(root, { deferRecovery: true });
    await fixture.create({ extension, root });
  }
  const archive = inspectLegacyChatroomArchive(root, fixture.roomId);
  provider = await fixture.localProvider();
  const actor = { id: "synthetic-chat-owner", canWrite: true };
  const workspaceId = await storage.workspaceId();
  const bindings = [];
  let intercept;
  async function open() {
    native = await createNativeRuntime({ storage, workspaceId, ...await fixture.nativeOptions(load, provider.endpoint) });
  }
  await open();
  const service = new LegacyChatroomContinuation({
    root, workspaceId, actor,
    core: { async dispatch(...args) { await intercept?.(args[1].operation, args[1].arguments); return native.core.dispatch(...args); } },
    async authorize(binding) {
      bindings.push(binding);
      return binding.workspaceRoot === root && binding.workspaceId === workspaceId
        && binding.actorId === actor.id && binding.roomId === fixture.roomId
        && binding.sourceFingerprint === archive.sourceFingerprint
        && ["history", "migrate", "continue"].includes(binding.operation);
    },
  });
  return {
    root, storage, archive, provider, service, bindings, actor, workspaceId,
    get native() { return native; },
    setIntercept(fn) { intercept = fn; },
    async reopen() { await native.close(); await open(); },
    async withoutProvider() { await native.close(); native = await createNativeRuntime({ storage, workspaceId }); },
    db: join(root, "chatrooms", fixture.roomId, "chatroom.db"),
  };
}

test("real legacy history, interrupted resumable projection, real local HTTP continuation, durable retry without duplicate provider calls", async t => {
  const h = await harness(t);
  const original = sha(h.db);
  assert.deepEqual((await h.service.list()).items.map(item => item.roomId), [fixture.roomId]);
  const history = await h.service.history(fixture.roomId, 0, 2);
  assert.equal(history.total, fixture.messages.length);
  assert.equal(history.nextOffset, 2);
  assert.deepEqual(history.items.map(message => message.message_id), fixture.messages.slice(0, 2).map(message => message.id));
  assert.deepEqual(JSON.parse(history.items[0].metadata_json), fixture.messages[0].metadata);
  let injected = false;
  h.setIntercept((operation, args) => {
    if (!injected && operation === "chat.session.append" && args.expectedRevision === 2) {
      injected = true; throw new Error("synthetic importer interruption");
    }
  });
  await assert.rejects(h.service.migrate(fixture.roomId), /synthetic importer interruption/);
  h.setIntercept(undefined);
  await h.reopen();
  const imported = await h.service.migrate(fixture.roomId);
  assert.equal(imported.importedMessages, fixture.messages.length);
  assert.equal(imported.session.messageCount, fixture.messages.length);
  const projected = await h.service.messages(imported.session.id);
  assert.deepEqual(projected.map(message => message.content), fixture.messages.map(message => message.content));
  assert.equal(projected[0].metadata.retrieval.messageId, fixture.messages[0].id);
  assert.equal(projected[0].metadata.retrieval.aliasAtSend, fixture.messages[0].aliasAtSend);
  assert.deepEqual(projected[0].metadata.retrieval.originalMetadata, fixture.messages[0].metadata);
  assert.equal(projected.at(-1).role, "user", "Historical notices must never become privileged model system instructions.");
  assert.equal(projected.at(-1).metadata.retrieval.messageType, "system");
  const request = { roomId: fixture.roomId, operationId: randomUUID(), expectedRevision: imported.session.revision, text: "Continue the ORCHID-47 discussion after the upgrade." };
  let failedAppend = false;
  h.setIntercept((operation, args) => {
    if (!failedAppend && operation === "chat.turn.get"
      && h.native.services.chatTurns.get(h.actor.id, args.id).status === "completed") {
      failedAppend = true; throw new Error("synthetic interruption after provider success");
    }
  });
  await assert.rejects(h.service.continue(request), /synthetic interruption after provider success/);
  assert.equal(h.provider.calls.length, 1);
  h.setIntercept(undefined);
  await h.reopen();
  const continued = await h.service.continue(request);
  assert.match(continued.output, /LOCAL_FIXTURE_CONTINUATION ORCHID-47/);
  assert.equal(continued.session.messageCount, fixture.messages.length + 2);
  assert.equal(h.provider.calls.length, 1, "Recovery must not replay a successful provider request.");
  await h.reopen();
  await h.service.continue(request);
  assert.equal(h.provider.calls.length, 1);
  assert.equal((await h.service.messages(imported.session.id)).length, fixture.messages.length + 2);
  const reimported = await h.service.migrate(fixture.roomId);
  assert.equal(reimported.session.messageCount, fixture.messages.length + 2);
  assert.equal(sha(h.db), original, "Original DB bytes must remain intact.");
  assert.equal((await h.service.history(fixture.roomId)).items.length, fixture.messages.length);
  assert(h.bindings.some(binding => binding.operation === "continue"));
});

test("archive authority, active/recovery/link/schema hazards and lossy continuation fail closed", async t => {
  const h = await harness(t);
  const denied = new LegacyChatroomContinuation({
    root: h.root, workspaceId: h.workspaceId, core: h.native.core, actor: h.actor, authorize: async () => false,
  });
  await assert.rejects(denied.history(fixture.roomId), /AUTHORITY_REQUIRED/);
  await assert.rejects(denied.migrate(fixture.roomId), /AUTHORITY_REQUIRED/);
  assert.deepEqual((await denied.list()).items, []);
  const imported = await h.service.migrate(fixture.roomId);
  await h.withoutProvider();
  await assert.rejects(h.service.continue({ roomId: fixture.roomId, operationId: randomUUID(),
    expectedRevision: imported.session.revision, text: "Cannot start an unavailable provider." }), /PROVIDER_UNAVAILABLE/);
  assert.equal((await h.service.messages(imported.session.id)).length, fixture.messages.length);
  const room = resolve(h.db, "..");
  writeFileSync(join(room, "chatroom.lock"), "{}");
  assert.throws(() => inspectLegacyChatroomArchive(h.root, fixture.roomId), /live lock/);
  unlinkSync(join(room, "chatroom.lock"));
  const journal = join(room, "chatroom.journal");
  writeFileSync(journal, '{"op":"append"}\n');
  assert.throws(() => inspectLegacyChatroomArchive(h.root, fixture.roomId), /Nonempty legacy journal/);
  writeFileSync(journal, "");
  const saved = readFileSync(h.db);
  const mutate = sql => {
    const db = new DatabaseSync(h.db); try { db.exec(sql); } finally { db.close(); }
  };
  mutate("UPDATE room_metadata SET state='active'");
  assert.throws(() => inspectLegacyChatroomArchive(h.root, fixture.roomId), /closed schema-2/);
  writeFileSync(h.db, saved);
  mutate("CREATE VIEW surprise AS SELECT * FROM messages");
  assert.throws(() => inspectLegacyChatroomArchive(h.root, fixture.roomId), /Unexpected database schema/);
  writeFileSync(h.db, saved);
  unlinkSync(journal); symlinkSync(h.db, journal);
  assert.throws(() => inspectLegacyChatroomArchive(h.root, fixture.roomId), /ordinary unlinked files/);
  unlinkSync(journal); writeFileSync(journal, "");
  mutate("UPDATE messages SET message_type='file' WHERE sequence=1");
  const archive = inspectLegacyChatroomArchive(h.root, fixture.roomId);
  const fileOnly = new LegacyChatroomContinuation({
    root: h.root, workspaceId: h.workspaceId, core: h.native.core, actor: h.actor,
    authorize: async binding => binding.sourceFingerprint === archive.sourceFingerprint,
  });
  assert.equal((await fileOnly.history(fixture.roomId)).items[0].message_type, "file");
  await assert.rejects(fileOnly.migrate(fixture.roomId), /without lossy conversion/);
  assert.equal(h.provider.calls.length, 0);
});

test("real MCP child process death after provider success recovers from disk without replay", async t => {
  const h = await harness(t, true);
  await h.native.close();
  await h.storage.close();
  const directory = resolve(h.root, ".."), nonce = randomUUID();
  writeFileSync(join(directory, "in-place-fixture-token"), nonce);
  writeFileSync(join(directory, "chatroom-host-grant.json"), JSON.stringify({
    root: h.root, nonce, roomId: fixture.roomId, workspaceId: h.workspaceId,
    sourceFingerprint: h.archive.sourceFingerprint, endpoint: h.provider.endpoint,
  }));
  let client, transport, stderr = "";
  const close = async () => { try { await client?.close(); } finally { await transport?.close(); } };
  const connect = async interrupt => {
    stderr = "";
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(import.meta.dirname, "legacy-chatroom-continuation-mcp-child.mjs"), directory, h.root, join(project, "../"), nonce],
      cwd: directory, stderr: "pipe", env: { ...process.env, PKM_IN_PLACE_PRIVATE_FIXTURE: nonce,
        ...(interrupt ? { PKM_CHAT_INTERRUPT_AFTER_PROVIDER: nonce } : {}) },
    });
    transport.stderr.on("data", bytes => { stderr += bytes.toString(); });
    client = new Client({ name: "synthetic-crash-recovery", version: "1" });
    await client.connect(transport);
  };
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  try {
    await connect(true);
    const imported = await call("legacy_chatroom_migrate", { roomId: fixture.roomId });
    const request = { roomId: fixture.roomId, expectedRevision: imported.session.revision, operationId: randomUUID(), text: "Continue from the real child process." };
    await assert.rejects(call("legacy_chatroom_continue", request));
    assert.match(stderr, /INJECTED_PRIVATE_FIXTURE_EXIT_AFTER_PROVIDER_SUCCESS/);
    assert.equal(h.provider.calls.length, 1);
    await close();
    await connect(false);
    await call("legacy_chatroom_continue", request);
    assert.equal(h.provider.calls.length, 1);
    const transcript = await call("legacy_chatroom_session", { roomId: fixture.roomId });
    assert.equal(transcript.page.items.length, fixture.messages.length + 2);
    assert.match(transcript.page.items.at(-1).content, /LOCAL_FIXTURE_CONTINUATION/);
  } catch (error) {
    error.message += `\nPrivate MCP child stderr:\n${stderr}`;
    throw error;
  } finally { await close(); }
});
