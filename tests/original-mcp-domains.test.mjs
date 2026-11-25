import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { hydrateOriginalMcpTodo, hydrateOriginalMcpMemory, activateOriginalMcpDomain,
  enrollOriginalMcpTodoWorker } from "../dist/original-mcp-domains.js";
import { originalMcpDomainTemporary, readOriginalMcpDomain } from "../dist/original-mcp-domain-state.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { readTodoBoard } from "../dist/domain/todo-board.js";
import { authenticateBoardWorker } from "../dist/boards.js";

const require = createRequire(import.meta.url), store = require("../legacy/dist/knowledge/filestore.js");
const hash = value => createHash("sha256").update(value).digest("hex");
const actor = { id: "mcp:external", canWrite: true };
const catalog = originalPublicMcpContracts();
const engine = String.raw`
import hashlib,json,sys
from pkm_memory_engine import Engine
database,scope=sys.argv[1:3]
e=Engine(database,"old-native-profile")
sources=[{"id":"fixture-source","chat":"fixture-chat","revision":"turn-1","locator":"message/1"}]
id="explicit-"+hashlib.sha256((scope+"\0old-proposal").encode()).hexdigest()
e.mutate("old-proposal","explicit_propose",{"id":id,"scope":scope,"content":"Private original remembered fact.","sources":sources})
e.mutate("old-confirm","explicit_confirm",{"id":id,"scope":scope,"expected_revision":1,
  "host_authorization":{"decision_id":"old-human-decision","actor_id":"human:old-profile"}})
e.close()
print(id)
`;
async function fixture(t, { large = false } = {}) {
  const directory = resolve("tests", `.original-domains-${randomUUID()}`), root = join(directory, "root"), closes = [];
  await mkdir(directory, { mode: 0o700 });
  await mkdir(root, { mode: 0o775 });
  t.after(async () => { for (const close of closes.reverse()) await close(); await rm(directory, { recursive: true, force: true }); });
  const mask = process.umask(0o002);
  let oldToken;
  try {
    store.setStorePath(root);
    store.todoBoardCreate("Team/Board", "Board", "Team");
    const board = store.noteWorkItemsRead("Team/Board");
    store.noteWorkItemCommand("Team/Board", board.digest, { action: "create", item: {
      id: "old-task", title: "Keep exact task identity", goal: "Keep its audit history", scope: "Fixture",
      acceptance: ["Canonical reads and explicit mutations"], state: "Planning", evidence: [],
    } }, { id: "user:local", role: "user" });
    store.noteWorkItemCommand("Team/Board", store.noteWorkItemsRead("Team/Board").digest,
      { action: "assign", id: "old-task", ownerId: "external:copilot:old-worker", reason: "Historical assignment" },
      { id: "user:local", role: "user" });
    oldToken = store.todoBoardGrantWorker("Team/Board", store.noteWorkItemsRead("Team/Board").digest, "external:copilot:old-worker");
    store.noteWorkItemExternalCommand("Team/Board", store.noteWorkItemsRead("Team/Board").digest,
      { action: "claim", id: "old-task" }, oldToken);
  } finally { process.umask(mask); }
  await mkdir(join(root, ".pkm/state/api-chat-history"), { recursive: true });
  await mkdir(join(root, ".pkm/state/actions"), { recursive: true });
  await writeFile(join(root, ".pkm/state/actions/settings.json"), '{"configured":"historical-not-active"}', { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{"notes":["Private"]}}', { mode: 0o600 });
  if (large) for (let offset = 0; offset < 4100; offset += 100)
    await Promise.all(Array.from({ length: 100 }, (_, index) =>
      writeFile(join(root, ".pkm/state/api-chat-history", `${offset + index}.json`), '{"archive":"not activated"}', { mode: 0o600 })));
  const sourceBoard = join(root, "notes/Team/Board.assets/pkm-todo-board.json"), oldBoard = await readFile(sourceBoard);
  const scope = JSON.stringify({ account: "local-owner", project: hash(root), repository: hash(root) });
  const sourceMemory = join(directory, "old-memory-snapshot.sqlite3");
  const id = execFileSync("python3", ["-c", engine, sourceMemory, scope],
    { env: { ...process.env, PYTHONPATH: resolve("compute"), PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" }).trim();
  await chmod(sourceMemory, 0o600);
  const memoryBefore = await readFile(sourceMemory);
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"), operatorId: "domain-fixture",
    profileSha256: hash("separate-native-profile"), limits: {
      maxEntries: 10_000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608,
    } });
  let host, decisions = 0, allow = true, expiry = Date.now() + 300_000;
  const policy = { async authorize() {
    decisions++; return allow ? { actorId: "mcp:external", decisionId: `fixture-native-decision-${decisions}`, expiresAtMs: expiry } : null;
  } };
  const open = async setup => {
    const lifetime = new AbortController();
    const opened = await openOriginalMcpRoot(plan, { prepareNative: async storage => {
      host = await createOriginalMcpNativeHost(storage, {
        profileSha256: plan.profileSha256, sourceCatalogSha256: catalog.provenance.metadataSha256,
        authorityId: "trusted-embedding-fixture-only", epoch: randomUUID(), signal: lifetime.signal,
        assertCurrent() {}, async authorizeAdmission() { return true; }, async authorizePublic() { return true; },
        async authorizeMemoryDecision() {
          return { actorId: "human:new-native-profile", decisionId: `fresh-human-${randomUUID()}` };
        },
        models: { configuration: { aiEndpoint: "https://not-called.invalid", aiModel: "not-used" }, registryAvailability: {},
          async credentialAvailable() { return false; }, async authorizeRequest() { return false; },
          transport: { supports: () => false, async open() { throw new Error("No model call is allowed."); } } },
      });
      if (setup) await setup(storage, host);
      return { authorizeMemoryDecision: host.options.authorizeMemoryDecision };
    } });
    closes.push(() => opened.owner.close());
    try { await opened.owner.ensureFull(); }
    catch (error) { await opened.owner.close(); throw error; }
    const backend = createNativePublicOwnerBackend(opened.owner, { actor, originalMcpHost: host });
    closes.push(() => backend.close());
    return { opened, backend, host, lifetime };
  };
  return { directory, root, plan, sourceBoard, oldBoard, oldToken, sourceMemory, scope, id, memoryBefore, open, policy,
    setAllowed: value => { allow = value; }, setExpiry: value => { expiry = value; } };
}
const call = (backend, action, operation, args) => backend.invoke(action === "read" ? "legacy_capability_read" : "legacy_capability_call",
  { action, args: { operation, version: 1, arguments: args } });

test("large original archive hydrates nonempty legacy Board through the same canonical owner without activating old workers/actions", { timeout: 120_000 }, async t => {
  const f = await fixture(t, { large: true }), { opened, backend, host } = await f.open();
  const lease = opened.owner.workspaceLease();
  await assert.rejects(call(backend, "read", "todo.board.get", { board_slug: "Team/Board" }), /ORIGINAL_BOARD/);
  await hydrateOriginalMcpTodo(opened.storage, host, ["Team/Board"], f.policy);
  const board = await call(backend, "read", "todo.board.get", { board_slug: "Team/Board" });
  assert.match(JSON.stringify(board), /Team\/Board/);
  const loaded = await call(backend, "read", "todo.workitem.get", { board_slug: "Team/Board", id: "old-task" });
  assert.match(JSON.stringify(loaded), /Keep exact task identity/);
  await call(backend, "call", "todo.workitem.comment", {
    board_slug: "Team/Board", id: "old-task", text: "Fresh native continuation", expected_digest: readTodoBoard(f.oldBoard.toString()).digest,
  });
  const current = await readFile(join(f.root, ".pkm-next-todo/Team/Board/pkm-todo-board.json"), "utf8");
  assert.match(current, /Fresh native continuation/);
  assert.deepEqual(await readFile(f.sourceBoard), f.oldBoard);
  assert.equal(await readFile(join(f.root, ".pkm/state/actions/settings.json"), "utf8"), '{"configured":"historical-not-active"}');
  assert.throws(() => authenticateBoardWorker(f.root, "Team/Board", f.oldToken), /never inherited/);
  const workerInput = { boardSlug: "Team/Board", actorId: "external:copilot:old-worker" };
  const fresh = await enrollOriginalMcpTodoWorker(opened.storage, host, workerInput, {
    async authorize(request) {
      workerInput.boardSlug = "Caller-mutation-after-native-review";
      return { actorId: request.actorId, decisionId: "fresh-exact-worker-native-fixture", expiresAtMs: Date.now() + 60_000 };
    },
  });
  assert.notEqual(fresh.token, f.oldToken);
  const worker = await backend.invoke("legacy_capability_read", { action: "read", workerToken: fresh.token,
    args: { operation: "todo.workitem.get", version: 1, arguments: { board_slug: "Team/Board", id: "old-task" } } });
  assert.match(JSON.stringify(worker), /external:copilot:old-worker/);
  await backend.invoke("legacy_capability_call", { action: "call", workerToken: fresh.token,
    args: { operation: "todo.workitem.comment", version: 1, arguments: {
      board_slug: "Team/Board", id: "old-task", text: "Explicitly reenrolled worker continuation",
      expected_digest: readTodoBoard(current).digest,
    } } });
  assert.match(await readFile(join(f.root, ".pkm-next-todo/Team/Board/pkm-todo-board.json"), "utf8"), /Explicitly reenrolled/);
  assert.throws(() => authenticateBoardWorker(f.root, "Team/Board", f.oldToken), /never inherited/);
  assert.deepEqual(opened.owner.workspaceLease(), lease);
});

test("original Memory preserves same-root scoped IDs/history/receipts and performs real canonical writes in a private namespace", { timeout: 120_000 }, async t => {
  const f = await fixture(t), running = await f.open(), { opened, backend, host } = running;
  const stage = join(f.directory, "memory-stage"); await mkdir(stage, { mode: 0o700 });
  await hydrateOriginalMcpMemory(opened.storage, host, { sourceSnapshot: f.sourceMemory,
    sourceScopeSha256: hash(f.scope), stagingDirectory: stage }, f.policy);
  const old = await call(backend, "read", "memory.record.get", { id: f.id });
  assert.match(JSON.stringify(old), /Private original remembered fact/);
  assert.match(JSON.stringify(old), /old-human-decision|confirmed/);
  assert.match(JSON.stringify(await call(backend, "read", "memory.record.audit", { id: f.id, after: 0, limit: 10 })), /old-human-decision/);
  assert.match(JSON.stringify(await call(backend, "read", "memory.record.search", { query: "Private original", limit: 3 })), /Private original/);
  const proposed = await call(backend, "call", "memory.record.propose", { operation_id: "new-proposal",
    content: "Fresh pending native fact", sources: [{ id: "new-source", chat: "fixture-chat", revision: "turn-2", locator: "message/2" }] });
  const proposal = proposed.structuredContent?.result ?? JSON.parse(proposed.content[0].text).result;
  assert.equal(proposal.status, "pending");
  await assert.rejects(call(backend, "call", "memory.record.confirm",
    { id: proposal.id, expected_revision: 1, operation_id: "new-confirm" }), /not available in this authorized catalog/);
  const native = await opened.owner.ensureFull();
  const confirmed = await native.runtime.core.dispatch("capability_call", { operation: "memory.record.confirm", version: 1,
    arguments: { id: proposal.id, expected_revision: 1, operation_id: "new-confirm" } }, actor);
  assert.equal(confirmed.error, undefined, JSON.stringify(confirmed));
  assert.match(JSON.stringify(await call(backend, "read", "memory.record.get", { id: proposal.id })), /confirmed/);
  assert.deepEqual(await readFile(f.sourceMemory), f.memoryBefore);
  await assert.rejects(readFile(join(f.root, "notes/System/Memory", `${f.id}.md`)), { code: "ENOENT" });
  assert.match(await readFile(join(f.root, ".pkm-next-memory", `${f.id}.md`), "utf8"), /old-human-decision/);
  const hidden = await backend.invoke("original_mcp_public", { tool: "search_notes", arguments: { query: "Private original remembered fact" } });
  assert.doesNotMatch(JSON.stringify(hidden), /Private original remembered fact/);
  await backend.close(); await opened.owner.close();
  const restarted = await f.open();
  await assert.rejects(call(restarted.backend, "read", "memory.record.get", { id: f.id }), /ORIGINAL_MEMORY_SCOPE/);
  await activateOriginalMcpDomain(restarted.opened.storage, restarted.host, "memory", f.policy);
  assert.match(JSON.stringify(await call(restarted.backend, "read", "memory.record.get", { id: proposal.id })), /confirmed/);
  const other = await (await restarted.opened.owner.ensureFull()).runtime.core.dispatch("capability_read",
    { operation: "memory.record.get", version: 1, arguments: { id: proposal.id } }, { id: "foreign:actor", canWrite: false });
  assert.equal(other.error?.code, "NOT_AVAILABLE");
  await rm(join(f.root, ".pkm-next-memory", `${proposal.id}.md`));
  await assert.rejects(call(restarted.backend, "read", "memory.record.get", { id: proposal.id }),
    /custody, native domain receipt or publication changed/);
});

test("durable domain intent and known publication prefix resume only under fresh native approval", { timeout: 120_000 }, async t => {
  const f = await fixture(t), running = await f.open();
  await assert.rejects(hydrateOriginalMcpTodo(running.opened.storage, running.host, ["Team/Board"], {
    ...f.policy, checkpoint(point) { if (point === "intent-durable") throw new Error("owned-interruption"); },
  }), /owned-interruption/);
  const state = readOriginalMcpDomain(f.root, "todo");
  assert.equal(state.committed, false);
  const directory = join(f.root, ".pkm-next-todo/Team/Board"); await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, `.pkm-write-${originalMcpDomainTemporary(state.intent.intentSha256)}`), f.oldBoard.subarray(0, 111), { mode: 0o600 });
  await running.backend.close(); await running.opened.owner.close();
  await assert.rejects(f.open(), /hydration|source-domain|native reconciliation/);
  const resumed = await f.open((storage, host) => hydrateOriginalMcpTodo(storage, host, ["Team/Board"], f.policy));
  assert.equal(readOriginalMcpDomain(f.root, "todo").committed, true);
  assert.match(JSON.stringify(await call(resumed.backend, "read", "todo.workitem.get",
    { board_slug: "Team/Board", id: "old-task" })), /Keep exact task identity/);
  assert.deepEqual(await readFile(f.sourceBoard), f.oldBoard);
});

test("host revocation reaches the actual worker and blocks direct canonical domain access", { timeout: 120_000 }, async t => {
  const f = await fixture(t), { opened, host, lifetime } = await f.open();
  await hydrateOriginalMcpTodo(opened.storage, host, ["Team/Board"], f.policy);
  const stage = join(f.directory, "private-stage"); await mkdir(stage, { mode: 0o700 });
  await hydrateOriginalMcpMemory(opened.storage, host, { sourceSnapshot: f.sourceMemory,
    sourceScopeSha256: hash(f.scope), stagingDirectory: stage }, f.policy);
  lifetime.abort();
  const { runtime } = await opened.owner.ensureFull();
  for (const [operation, args] of [
    ["todo.board.get", { board_slug: "Team/Board" }], ["memory.record.get", { id: f.id }],
  ]) {
    const response = await runtime.core.dispatch("capability_read", { operation, version: 1, arguments: args }, actor);
    assert(response.error, `${operation} cannot use historical approval after native producer revocation.`);
  }
});

test("Memory import resumes a journal-owned prefix without replaying old human decisions", { timeout: 120_000 }, async t => {
  const f = await fixture(t), running = await f.open();
  const stage = join(f.directory, "interrupted-stage"); await mkdir(stage, { mode: 0o700 });
  const request = { sourceSnapshot: f.sourceMemory, sourceScopeSha256: hash(f.scope), stagingDirectory: stage };
  await assert.rejects(hydrateOriginalMcpMemory(running.opened.storage, running.host, request, {
    ...f.policy, checkpoint(point) { if (point === "intent-durable") throw new Error("owned-memory-interruption"); },
  }), /owned-memory-interruption/);
  const state = readOriginalMcpDomain(f.root, "memory"), directory = join(f.root, ".pkm-next-memory");
  await mkdir(directory, { mode: 0o700 });
  const bytes = await readFile(state.intent.files[0].stagedPath);
  await writeFile(join(directory, `.pkm-write-${originalMcpDomainTemporary(state.intent.intentSha256)}`), bytes.subarray(0, 100), { mode: 0o600 });
  await running.backend.close(); await running.opened.owner.close();
  const nextStage = join(f.directory, "resumed-stage"); await mkdir(nextStage, { mode: 0o700 });
  const resumed = await f.open((storage, host) => hydrateOriginalMcpMemory(storage, host,
    { ...request, stagingDirectory: nextStage }, f.policy));
  assert.match(JSON.stringify(await call(resumed.backend, "read", "memory.record.get", { id: f.id })), /confirmed/);
  assert.deepEqual(await readFile(f.sourceMemory), f.memoryBefore);
});

test("unknown staged bytes and expired decisions never become successful native publication", { timeout: 120_000 }, async t => {
  const f = await fixture(t), running = await f.open();
  f.setExpiry(Date.now() - 1);
  await assert.rejects(hydrateOriginalMcpTodo(running.opened.storage, running.host, ["Team/Board"], f.policy), /fresh bounded native UI/);
  assert.equal(readOriginalMcpDomain(f.root, "todo"), undefined);
  f.setExpiry(Date.now() + 60_000);
  await assert.rejects(hydrateOriginalMcpTodo(running.opened.storage, running.host, ["Team/Board"], {
    ...f.policy, checkpoint(point) { if (point === "intent-durable") throw new Error("owned-interruption"); },
  }), /owned-interruption/);
  const state = readOriginalMcpDomain(f.root, "todo"), directory = join(f.root, ".pkm-next-todo/Team/Board");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staged = join(directory, `.pkm-write-${originalMcpDomainTemporary(state.intent.intentSha256)}`);
  await writeFile(staged, "unknown user bytes must be preserved", { mode: 0o600 });
  await assert.rejects(hydrateOriginalMcpTodo(running.opened.storage, running.host, ["Team/Board"], f.policy), /custody, native domain receipt or publication changed/);
  assert.equal(await readFile(staged, "utf8"), "unknown user bytes must be preserved");
  assert.equal(readOriginalMcpDomain(f.root, "todo").committed, false);
  assert.deepEqual(await readFile(f.sourceBoard), f.oldBoard);
});

test("native denial and selected source CAS refuse hydration before original/native domain publication", { timeout: 120_000 }, async t => {
  const f = await fixture(t), { opened, host } = await f.open();
  f.setAllowed(false);
  await assert.rejects(hydrateOriginalMcpTodo(opened.storage, host, ["Team/Board"], f.policy), /fresh bounded native UI/);
  await assert.rejects(readFile(join(f.root, ".pkm-next-todo/Team/Board/pkm-todo-board.json")), { code: "ENOENT" });
  f.setAllowed(true);
  await writeFile(f.sourceBoard, `${f.oldBoard.toString()}\n`, { mode: 0o664 });
  await assert.rejects(hydrateOriginalMcpTodo(opened.storage, host, ["Team/Board"], f.policy), /source or its preserved bytes changed/);
});
