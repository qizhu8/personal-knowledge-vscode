import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { hydrateOriginalMcpTodo, activateOriginalMcpDomain, enrollOriginalMcpTodoWorker } from "../dist/original-mcp-domains.js";
import { planOriginalMcpApiChatSource, admitOriginalMcpApiChatSource, activateOriginalMcpApiChatSource } from "../dist/original-mcp-api-chat-source.js";
import { createOriginalMcpTodoChatDirectoryPort, assertOriginalMcpTodoChatDirectoryPort,
  readOriginalMcpTodoAgentList } from "../dist/original-mcp-todo-chat.js";
import { authenticateBoardWorker } from "../dist/boards.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";

const require = createRequire(import.meta.url), extension = resolve("legacy");
const originalChatFixture = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs");
const { ApiChatStore } = require("../legacy/dist/chat/api-chat-store.js");
const store = require("../legacy/dist/knowledge/filestore.js");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const actor = { id: "mcp:external", canWrite: true };
const workerId = "external:copilot:retained-worker";
const boardSlug = "Team/Board";
const policy = { async authorize() {
  return { actorId: "mcp:external", decisionId: randomUUID(), expiresAtMs: Date.now() + 300_000 };
} };
const deniedPolicy = { async authorize() { return null; } };
async function fixture(t) {
  const directory = resolve("tests", `.original-todo-chat-${randomUUID()}`), root = join(directory, "root"), closes = [];
  await mkdir(root, { recursive: true, mode: 0o700 });
  t.after(async () => { for (const close of closes.reverse()) await close(); await rm(directory, { recursive: true, force: true }); });
  let descriptor, oldToken, trashedId;
  const mask = process.umask(0o077);
  try {
    descriptor = originalChatFixture.create({ extension, root });
    const chats = new ApiChatStore(descriptor.state, descriptor.namespace), trashed = chats.create();
    trashed.title = "Trashed original Chat"; chats.save(trashed); chats.library.trash(trashed.id); trashedId = trashed.id;
    store.setStorePath(root);
    store.todoBoardCreate(boardSlug, "Board", "Team");
    for (const [id, ownerId] of [["source-task", `chat:${descriptor.inline}`], ["worker-task", workerId]]) {
      store.noteWorkItemCommand(boardSlug, store.noteWorkItemsRead(boardSlug).digest, { action: "create", item: {
        id, title: id, goal: "Preserve original identity", scope: "Todo fixture", acceptance: ["No historical authority replay"],
        state: "Planning", evidence: [],
      } }, { id: "user:local", role: "user" });
      store.noteWorkItemCommand(boardSlug, store.noteWorkItemsRead(boardSlug).digest,
        { action: "assign", id, ownerId, reason: "Historical assignment" }, { id: "user:local", role: "user" });
    }
    oldToken = store.todoBoardGrantWorker(boardSlug, store.noteWorkItemsRead(boardSlug).digest, workerId);
  } finally { process.umask(mask); }
  const originalBoard = await readFile(join(root, "notes/Team/Board.assets/pkm-todo-board.json"));
  const sourceMetadata = join(descriptor.state, "api-chats", descriptor.namespace, `${descriptor.inline}.json`);
  const originalMetadata = await readFile(sourceMetadata);
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"), operatorId: "todo-chat-fixture",
    profileSha256: hash("separate-native-todo-chat-profile"),
    limits: { maxEntries: 10_000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608 } });
  async function open() {
    const lifetime = new AbortController();
    let host;
    const opened = await openOriginalMcpRoot(plan, { prepareNative: async storage => {
      host = await createOriginalMcpNativeHost(storage, {
        profileSha256: plan.profileSha256, sourceCatalogSha256: originalPublicMcpContracts().provenance.metadataSha256,
        authorityId: "trusted-todo-chat-embedding-fixture-only", epoch: randomUUID(), signal: lifetime.signal,
        assertCurrent() {}, async authorizeAdmission() { return true; }, async authorizePublic() { return true; },
        models: { configuration: { aiEndpoint: "https://not-called.invalid", aiModel: "not-used" }, registryAvailability: {},
          async credentialAvailable() { return false; }, async authorizeRequest() { return false; },
          transport: { supports: () => false, async open() { throw new Error("Discovery must never infer or start a model."); } } },
      });
      return {};
    } });
    closes.push(() => opened.owner.close());
    const { runtime } = await opened.owner.ensureFull();
    const backend = createNativePublicOwnerBackend(opened.owner, { actor, originalMcpHost: host });
    closes.push(() => backend.close());
    const call = async (operation, arguments_, who = actor) => {
      const response = await runtime.core.dispatch(operation === "todo.workitem.assign" || operation === "todo.workitem.comment"
        || operation === "chat.session.create" ? "capability_call" : "capability_read",
      { operation, version: 1, arguments: arguments_ }, who);
      if (response.error) throw Object.assign(new Error(response.error.message), response.error);
      return response.result;
    };
    return { opened, host, lifetime, call, backend };
  }
  async function admit(running, sourcePolicy = policy) {
    const stagingDirectory = join(directory, `source-${randomUUID()}`); await mkdir(stagingDirectory, { mode: 0o700 });
    const source = await planOriginalMcpApiChatSource(running.opened.storage, running.host, { stagingDirectory,
      limits: { maxChats: 10, maxMessagesPerChat: 100, maxMessages: 100 } });
    return admitOriginalMcpApiChatSource(running.opened.storage, running.host, source, sourcePolicy);
  }
  return { root, descriptor, oldToken, trashedId, sourceMetadata, originalMetadata, originalBoard, open, admit };
}

test("same-owner Todo discovery preserves original Chat IDs/URLs, complete query/paging, and separates source from live assignment and worker authority", { timeout: 120_000 }, async t => {
  const f = await fixture(t), running = await f.open(), { opened, host, call } = running;
  const lease = opened.owner.workspaceLease();
  await hydrateOriginalMcpTodo(opened.storage, host, [boardSlug], policy);
  await assert.rejects(createOriginalMcpTodoChatDirectoryPort(opened.owner, host), /fresh source-domain/);
  await assert.rejects(f.admit(running, deniedPolicy), /Fresh exact native/);
  await f.admit(running);
  const ownChat = randomUUID(), foreignChat = randomUUID();
  for (const [id, title, who] of [[ownChat, "Fresh same-owner Chat", actor], [foreignChat, "Foreign Chat", { id: "foreign:actor", canWrite: true }]])
    await call("chat.session.create", { operationId: randomUUID(), id, expectedRevision: 0, title }, who);
  const before = await call("todo.agent.list", { board_slug: boardSlug });
  assert.equal(before.items.find(item => item.id === `chat:${f.descriptor.inline}`).kind, "missing-chat");
  const port = await createOriginalMcpTodoChatDirectoryPort(opened.owner, host);
  assertOriginalMcpTodoChatDirectoryPort(port);
  assert.throws(() => assertOriginalMcpTodoChatDirectoryPort({ ...port }), /genuine same-owner/);
  const result = await port.readAgentList(actor, { board_slug: boardSlug });
  const canonical = await running.backend.invoke("legacy_capability_read", {
    action: "read", args: { operation: "todo.agent.list", version: 1, arguments: { board_slug: boardSlug } },
  });
  assert.equal(canonical.structuredContent.schema, "pkm.capability-result/v1");
  assert.deepEqual(canonical.structuredContent.result, result);
  await assert.rejects(running.backend.invoke("legacy_capability_read", {
    action: "read", args: { operation: "todo.agent.list", version: 2, arguments: { board_slug: boardSlug } },
  }), /version|enum/i);
  await assert.rejects(running.backend.invoke("legacy_capability_call", {
    action: "read", args: { operation: "todo.agent.list", version: 1, arguments: { board_slug: boardSlug } },
  }), /matching read entry point/);
  const source = result.items.find(item => item.id === `chat:${f.descriptor.inline}`);
  assert.equal(source.kind, "pkm-chat");
  assert.equal(source.title, "Ordinary API Chat with an actual inline PNG");
  assert.equal(source.chatUrl, `pkm://chats/${f.descriptor.namespace}/${f.descriptor.inline}`);
  assert.equal(source.sourceAuthority, "archive_only");
  assert.equal(source.assignmentAvailable, false);
  assert(result.items.some(item => item.id === `chat:${f.descriptor.segmented}`));
  assert(result.items.some(item => item.id === `chat:${ownChat}` && item.kind === "pkm-chat"));
  assert(!result.items.some(item => [foreignChat, f.trashedId].some(id => item.id === `chat:${id}`)));
  assert.equal(result.items.filter(item => item.id === source.id).length, 1, "recorded owner and original Chat are one stable identity");
  const query = await port.readAgentList(actor, { board_slug: boardSlug, query: "Ordinary", limit: 1 });
  assert.equal(query.total, 2); assert.equal(query.next_offset, 1);
  const page = await readOriginalMcpTodoAgentList(opened.owner, host, actor, { board_slug: boardSlug, query: "Ordinary", offset: 1, limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.next_offset, null); assert.notEqual(page.items[0].id, query.items[0].id);
  const snapshot = await call("todo.board.get", { board_slug: boardSlug });
  await assert.rejects(call("todo.workitem.assign", { board_slug: boardSlug, id: "source-task", owner_id: source.id,
    reason: "A directory record cannot revive a live Chat", expected_digest: snapshot.digest, operationId: randomUUID() }), { code: "NATIVE_AUTHORITY_REQUIRED" });
  assert.equal((await call("todo.board.get", { board_slug: boardSlug })).digest, snapshot.digest);
  const assigned = await call("todo.workitem.assign", { board_slug: boardSlug, id: "source-task", owner_id: `chat:${ownChat}`,
    reason: "Actual same-owner native Chat", expected_digest: snapshot.digest, operationId: randomUUID() });
  assert.equal(assigned.item.ownerId, `chat:${ownChat}`);
  await assert.rejects(port.readAgentList({ id: "foreign:actor", canWrite: false }, { board_slug: boardSlug }), /exact native source owner/);
  assert.throws(() => authenticateBoardWorker(f.root, boardSlug, f.oldToken), /never inherited/);
  const fresh = await enrollOriginalMcpTodoWorker(opened.storage, host, { boardSlug, actorId: workerId }, {
    async authorize(request) { return { actorId: request.actorId, decisionId: randomUUID(), expiresAtMs: Date.now() + 60_000 }; },
  });
  const worker = authenticateBoardWorker(f.root, boardSlug, fresh.token);
  await assert.rejects(port.readAgentList({ ...worker, canWrite: true }, { board_slug: boardSlug }), /Board worker grant is not Chat authority/);
  await call("todo.workitem.comment", { board_slug: boardSlug, id: "worker-task", text: "Fresh worker, not retained authority",
    expected_digest: assigned.digest, operationId: randomUUID() }, { ...worker, canWrite: true });
  assert.throws(() => authenticateBoardWorker(f.root, boardSlug, f.oldToken), /never inherited/);
  assert.deepEqual(await readFile(join(f.root, "notes/Team/Board.assets/pkm-todo-board.json")), f.originalBoard);
  assert.deepEqual(await readFile(f.sourceMetadata), f.originalMetadata);
  assert.deepEqual(opened.owner.workspaceLease(), lease);
});

test("retained directory state does not replay after restart, native denial/revocation, expired source admission, or source mutation", { timeout: 120_000 }, async t => {
  const f = await fixture(t), first = await f.open();
  await hydrateOriginalMcpTodo(first.opened.storage, first.host, [boardSlug], policy);
  await f.admit(first);
  const oldPort = await createOriginalMcpTodoChatDirectoryPort(first.opened.owner, first.host);
  const old = await oldPort.readAgentList(actor, { board_slug: boardSlug });
  await first.opened.owner.close();
  await assert.rejects(oldPort.readAgentList(actor, { board_slug: boardSlug }));
  const next = await f.open();
  await activateOriginalMcpDomain(next.opened.storage, next.host, "todo", policy);
  await assert.rejects(activateOriginalMcpApiChatSource(next.opened.storage, next.host, deniedPolicy), /Fresh exact native/);
  await assert.rejects(createOriginalMcpTodoChatDirectoryPort(next.opened.owner, next.host), /fresh source-domain/);
  const expiry = Date.now() + 5_000;
  await activateOriginalMcpApiChatSource(next.opened.storage, next.host, {
    async authorize() { return { actorId: "mcp:external", decisionId: randomUUID(), expiresAtMs: expiry }; },
  });
  const port = await createOriginalMcpTodoChatDirectoryPort(next.opened.owner, next.host);
  assert.deepEqual((await port.readAgentList(actor, { board_slug: boardSlug })).items, old.items);
  assert.throws(() => authenticateBoardWorker(f.root, boardSlug, f.oldToken), /never inherited/);
  t.mock.method(Date, "now", () => expiry + 1);
  try { await assert.rejects(port.readAgentList(actor, { board_slug: boardSlug }), /fresh source-domain/); }
  finally { t.mock.restoreAll(); }
  await activateOriginalMcpApiChatSource(next.opened.storage, next.host, policy);
  const board = await next.call("todo.board.get", { board_slug: boardSlug });
  const nativeBoard = join(f.root, ".pkm-next-todo/Team/Board/pkm-todo-board.json"), boardBefore = await readFile(nativeBoard);
  await writeFile(f.sourceMetadata, Buffer.concat([f.originalMetadata, Buffer.from("\n")]), { mode: 0o600 });
  await assert.rejects(port.readAgentList(actor, { board_slug: boardSlug }), /changed|custody/i);
  await assert.rejects(port.readAgentList(actor, { board_slug: boardSlug }), /changed|custody/i);
  assert.deepEqual(await readFile(nativeBoard), boardBefore);
  assert.equal((await next.call("todo.board.get", { board_slug: boardSlug })).digest, board.digest);
  next.lifetime.abort();
  assert.throws(() => assertOriginalMcpTodoChatDirectoryPort(port));
  await assert.rejects(port.readAgentList(actor, { board_slug: boardSlug }));
});

test("a changed original Trash directory cannot replay an earlier admitted agent list", { timeout: 120_000 }, async t => {
  const f = await fixture(t), running = await f.open();
  await hydrateOriginalMcpTodo(running.opened.storage, running.host, [boardSlug], policy);
  await f.admit(running);
  const port = await createOriginalMcpTodoChatDirectoryPort(running.opened.owner, running.host);
  const before = await port.readAgentList(actor, { board_slug: boardSlug });
  assert(!before.items.some(item => item.id === `chat:${f.trashedId}`));
  const path = join(f.descriptor.state, "api-chats/library.json"), bytes = await readFile(path);
  await writeFile(path, Buffer.concat([bytes, Buffer.from("\n")]), { mode: 0o600 });
  await assert.rejects(port.readAgentList(actor, { board_slug: boardSlug }), /changed|custody/i);
  assert.deepEqual(await readFile(join(f.root, "notes/Team/Board.assets/pkm-todo-board.json")), f.originalBoard);
});
