import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { scanMarkdown, sha256 } from "../dist/markdown.js";
import { memoryScope, planMemory } from "../dist/memory.js";
import { memoryText } from "../dist/memory-contracts.js";

const sources = [{ id: "input-1", chat: "fixture-chat", revision: "turn-1", locator: "message/input-1" }];
const owner = { id: "local:owner", canWrite: true };
async function fixture(t, authorize = () => ({ decisionId: randomUUID(), actorId: "user:local" })) {
  const parent = join(dirname(fileURLToPath(import.meta.url)), `.memory-${randomUUID()}`);
  const directory = join(parent, "workspace");
  await mkdir(parent, { recursive: true });
  await initialize(directory);
  let storage = await Storage.open(directory);
  t.after(async () => { try { await storage.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  let core = new Core(storage, { authorizeMemoryDecision: authorize });
  const call = (operation, args, actor = owner, native = true) =>
    (native ? core : new Core(storage)).dispatch(["get", "search", "audit"].includes(operation) ? "capability_read" : "capability_call",
      { operation: `memory.record.${operation}`, version: 1, arguments: args }, actor);
  const propose = (operation_id = randomUUID(), content = "Use SQLite for durable memory.") => call("propose", { operation_id, content, sources });
  return {
    directory, call, propose, get storage() { return storage; }, get core() { return core; },
    async restart() { await storage.close(); storage = await Storage.open(directory); core = new Core(storage, { authorizeMemoryDecision: authorize }); },
  };
}

test("Node memory replays the original Python Engine's lifecycle/read/audit semantic oracle", async t => {
  const f = await fixture(t, request => ({ decisionId: `decision-${request.operationId}`, actorId: "user:local" }));
  const oracle = JSON.parse(await readFile(new URL("../migration/memory-oracle.json", import.meta.url), "utf8"));
  let id;
  function normalized(value) {
    if (Array.isArray(value)) return value.map(normalized);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !["created_at", "updated_at", "revision_created_at", "documentSha256"].includes(key))
      .map(([key, child]) => [key, key === "id" ? "record-1" : key === "scope" ? "fixture-scope" : normalized(child)]));
    return value;
  }
  for (const step of oracle.steps) {
    const args = { ...step.arguments, ...(step.arguments.id ? { id } : {}) };
    const response = await f.call(step.action, args);
    assert(!response.error, JSON.stringify(response.error));
    if (step.action === "propose") id = response.result.id;
    assert.deepEqual(normalized(response.result), step.expected, step.action);
  }
});

test("explicit-memory lifecycle preserves original revisions/status, scoped Markdown authority, audit and historical receipts", async t => {
  const f = await fixture(t);
  const proposed = await f.propose("proposal-1");
  assert(!proposed.error, JSON.stringify(proposed.error));
  const id = proposed.result.id;
  assert.equal(id, `explicit-${sha256(`${memoryScope(f.directory)}\0proposal-1`)}`);
  assert.equal(proposed.result.status, "pending");
  assert.deepEqual((await f.call("search", { query: "SQLite" })).result.records, []);
  assert.deepEqual((await f.propose("proposal-1")).result, proposed.result);
  const confirmed = await f.call("confirm", { id, expected_revision: 1, operation_id: "confirm-1" });
  assert.equal(confirmed.result.revision, 2);
  assert.equal(confirmed.result.status, "confirmed");
  assert.equal((await f.call("get", { id, revision: 1 })).result.status, "superseded");
  assert.equal((await f.call("revoke", { id, expected_revision: 1, operation_id: "stale" })).error.code, "CONFLICT");
  assert.equal((await f.call("search", { query: "SQLITE" })).result.records[0].id, id);
  const revised = await f.call("revise", { id, expected_revision: 2, operation_id: "revise-1", content: "Use SQLite WAL.", sources });
  assert.equal(revised.result.revision, 3);
  assert.equal(revised.result.status, "pending");
  assert.deepEqual((await f.call("search", { query: "SQLite" })).result.records, []);
  await f.call("confirm", { id, expected_revision: 3, operation_id: "confirm-2" });
  const revoked = await f.call("revoke", { id, expected_revision: 4, operation_id: "revoke-1" });
  assert.equal(revoked.result.revision, 5);
  assert.equal(revoked.result.status, "revoked");
  const audit = (await f.call("audit", { id })).result.events;
  assert.deepEqual(audit.map(event => event.action), ["proposed", "confirmed", "revised", "confirmed", "revoked"]);
  assert.equal(audit[0].actor, "caller");
  assert.equal(audit[1].actor, "user:local");
  assert.equal((await f.call("confirm", { id, expected_revision: 5, operation_id: "bad-reactivation" })).error.code, "CONFLICT");
  await f.restart();
  assert.equal((await f.call("get", { id })).result.current_status, "revoked");
  assert.deepEqual((await f.call("search", { query: "SQLite" })).result.records, []);
  assert.deepEqual((await f.call("confirm", { id, expected_revision: 1, operation_id: "confirm-1" })).result, confirmed.result);
  const raw = await readFile(join(f.directory, `notes/System/Memory/${id}.md`), "utf8");
  assert(raw.includes("Use SQLite WAL."));
  assert(raw.includes("superseded"), "Immutable historical contents stay in authoritative Markdown.");
  const db = new DatabaseSync(join(f.directory, "core.sqlite"));
  try {
    assert(!db.prepare("PRAGMA table_info(documents)").all().some(field => field.name === "content"));
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM pending_write").get().total, 0);
  } finally { db.close(); }
});

test("only injected native human decisions activate memory; external catalogs/inputs cannot forge authority", async t => {
  let decisions = 0, allow = false;
  const f = await fixture(t, request => {
    decisions++;
    assert(Object.isFrozen(request) && Object.isFrozen(request.record) && Object.isFrozen(request.record.sources));
    assert.equal(request.record.content, "Exact content");
    assert.equal(request.record.sources[0].locator, sources[0].locator);
    return allow ? { decisionId: "human-decision", actorId: "user:local" } : null;
  });
  const proposed = await f.propose("proposal", "Exact content"), id = proposed.result.id;
  const args = { id, expected_revision: 1, operation_id: "confirm" };
  assert.equal((await f.call("confirm", args, owner, false)).error.code, "NOT_AVAILABLE");
  assert.equal(decisions, 0);
  assert.equal((await f.call("confirm", args)).error.code, "ACCESS_DENIED");
  allow = true;
  assert.equal((await f.call("confirm", args)).result.status, "confirmed");
  assert.equal(decisions, 2);
  assert.equal((await f.call("confirm", args)).result.status, "confirmed");
  assert.equal(decisions, 2, "A durable authorized receipt never repeats the human decision.");
  const external = new Core(f.storage);
  const available = (await external.dispatch("capabilities_search", { query: "memory.record" }, owner)).result;
  assert.equal(available.total, 4);
  assert(available.items.every(item => !/confirm|revise|revoke/.test(item.operation)));
  assert.equal((await external.dispatch("capabilities_describe", { operation: "memory.record.confirm" }, owner)).error.code, "NOT_FOUND");
  for (const extra of [{ confirmed: true }, { host_authorization: { decision_id: "fake", actor_id: "user:local" } }, { scope: "foreign" }]) {
    assert.equal((await f.call("propose", { operation_id: randomUUID(), content: "Bad", sources, ...extra })).error.code, "INVALID_ARGUMENT");
  }
  assert.equal((await f.propose("proposal", "Different")).error.code, "CONFLICT");
  assert.equal((await f.call("propose", { operation_id: "reader", content: "No", sources }, { id: "reader", canWrite: false })).error.code, "ACCESS_DENIED");
});

test("memory exact-record approval CAS rejects concurrent/native changes and preserves the approved source snapshot", async t => {
  let blocked = false;
  const f = await fixture(t, async request => {
    if (!blocked) {
      blocked = true;
      const other = new Core(f.storage, { authorizeMemoryDecision: () => ({ decisionId: "other", actorId: "user:other" }) });
      const response = await other.dispatch("capability_call", {
        operation: "memory.record.revise", version: 1,
        arguments: { id: request.record.id, expected_revision: 1, operation_id: "other-revise", content: "Changed", sources },
      }, owner);
      assert.equal(response.result.revision, 2);
    }
    return { decisionId: "stale-human", actorId: "user:local" };
  });
  const id = (await f.propose()).result.id;
  const attempted = await f.call("confirm", { id, expected_revision: 1, operation_id: "stale-confirm" });
  assert.equal(attempted.error.code, "CONFLICT");
  assert.equal((await f.call("get", { id })).result.status, "pending");
  assert.equal((await f.call("get", { id })).result.content, "Changed");
});

test("memory UTF-8/source bounds preserve exact maximums and reject unpaired Unicode or forged fields", async t => {
  const f = await fixture(t);
  assert(memoryText(4096).safeParse("\u{1F600}".repeat(1024)).success);
  assert(!memoryText(4096).safeParse("\u{1F600}".repeat(1025)).success);
  assert(!memoryText(4096).safeParse("\ud800").success);
  const maximum = await f.propose("max", '"'.repeat(4096));
  assert.equal(maximum.result.content.length, 4096);
  for (const content of ["x".repeat(4097), "\u754c".repeat(2000), "\ud800", "bad\0"]) {
    assert.equal((await f.propose(randomUUID(), content)).error.code, "INVALID_ARGUMENT");
  }
  for (const invalid of [[], Array(33).fill(sources[0]), [null], [{ ...sources[0], role: "user" }],
    Array.from({ length: 3 }, (_, id) => ({ ...sources[0], id: String(id), locator: "x".repeat(1500) }))]) {
    assert.equal((await f.call("propose", { operation_id: randomUUID(), content: "Bounded", sources: invalid })).error.code, "INVALID_ARGUMENT");
  }
});

test("scoped memory search keeps SQLite ASCII matching, bounded previews and global audit cursors", async t => {
  const f = await fixture(t);
  const first = (await f.propose("ascii", "SQLite " + "x".repeat(900))).result;
  const second = (await f.propose("unicode", "\u00c9cole")).result;
  await f.call("confirm", { id: first.id, expected_revision: 1, operation_id: "ascii-confirm" });
  await f.call("confirm", { id: second.id, expected_revision: 1, operation_id: "unicode-confirm" });
  const found = (await f.call("search", { query: "SQLITE" })).result.records[0];
  assert.equal(found.preview.length, 800);
  assert.equal(found.truncated, true);
  assert.equal(found.contentCharacters, 907);
  assert.equal(found.sourceCount, 1);
  assert(!Object.hasOwn(found, "content"));
  assert.deepEqual((await f.call("search", { query: "\u00e9cole" })).result.records, []);
  assert.equal((await f.call("search", { query: "\u00c9cole" })).result.records[0].id, second.id);
  const page = (await f.call("audit", { id: first.id, limit: 1 })).result;
  const next = (await f.call("audit", { id: first.id, after: page.next, limit: 1 })).result;
  assert.equal(page.events[0].sequence, 1);
  assert.equal(next.events[0].sequence, 3);
  assert.deepEqual((await f.call("audit", { id: first.id, after: next.next })).result.events, []);
  const other = await fixture(t);
  assert.equal((await other.call("get", { id: first.id })).error.code, "NOT_AVAILABLE");
});

test("generic knowledge writes cannot bypass memory lifecycle, even after an external move", async t => {
  const f = await fixture(t);
  const proposed = (await f.propose()).result;
  for (const operation of ["knowledge.document.update", "knowledge.document.trash", "knowledge.metadata.update"]) {
    const args = { id: proposed.id, operationId: randomUUID(), expectedRevision: 1, expectedSha256: proposed.documentSha256,
      ...(operation.endsWith("metadata.update") ? { set: { memory: {} } } : operation.endsWith("document.update") ? { title: "Bad", content: "Bypass" } : {}) };
    const response = await f.core.dispatch("capability_call", { operation, version: 1, arguments: args }, owner);
    assert.equal(response.error.code, "ACCESS_DENIED");
  }
  await rename(join(f.directory, `notes/System/Memory/${proposed.id}.md`), join(f.directory, "notes/Moved.md"));
  const response = await f.core.dispatch("capability_call", {
    operation: "knowledge.document.update", version: 1,
    arguments: { id: proposed.id, operationId: randomUUID(), expectedRevision: 1, expectedSha256: proposed.documentSha256, title: "Bad", content: "Bypass" },
  }, owner);
  assert.equal(response.error.code, "ACCESS_DENIED");
});

for (const boundary of ["intent-only", "file-replaced", "corrupt-result", "wrong-action", "external-conflict"]) {
  test(`memory Markdown intent recovery is safe at ${boundary}`, async t => {
    const f = await fixture(t);
    const before = (await f.propose("before")).result;
    await f.storage.close();
    const request = {
      operation: "memory.record.confirm", actorId: owner.id,
      args: { id: before.id, expected_revision: 1, operation_id: "planned-confirm" },
      memoryDecision: { decisionId: "exact-human", actorId: "user:local", documentSha256: before.documentSha256 },
    };
    const plan = planMemory(f.directory, scanMarkdown(f.directory), request);
    assert(plan.write);
    const db = new DatabaseSync(join(f.directory, "core.sqlite"));
    try {
      db.prepare("INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,document_id,before_sha256,after_markdown,document_path,document_area,result) VALUES(1,?,?,?,?,?,?,?,?,?,?)").run(
        request.args.operation_id, sha256(JSON.stringify({ operation: request.operation, actorId: request.actorId, args: request.args })),
        request.actorId, boundary === "wrong-action" ? "memory.record.revoke" : request.operation,
        plan.write.id, plan.write.before, plan.write.raw, plan.write.path, "notes",
        JSON.stringify(boundary === "corrupt-result" ? { ...plan.result, content: "Forged" } : plan.result),
      );
    } finally { db.close(); }
    const path = join(f.directory, "notes", plan.write.path);
    if (boundary === "file-replaced") await writeFile(path, plan.write.raw);
    if (boundary === "external-conflict") await writeFile(path, (await readFile(path, "utf8")) + "\nExternal edit");
    const raw = await readFile(path, "utf8");
    if (boundary === "corrupt-result" || boundary === "wrong-action" || boundary === "external-conflict") {
      await assert.rejects(Storage.open(f.directory));
      assert.equal(await readFile(path, "utf8"), raw);
      const check = new DatabaseSync(join(f.directory, "core.sqlite"));
      try { assert.equal(check.prepare("SELECT COUNT(*) AS total FROM pending_write").get().total, 1); }
      finally { check.close(); }
    } else {
      await f.restart();
      assert.deepEqual((await f.call("confirm", request.args)).result, plan.result);
      assert.equal((await f.call("get", { id: before.id })).result.status, "confirmed");
    }
  });
}

test("v5 workspace upgrades memory receipt snapshots without changing old documents", async t => {
  const f = await fixture(t);
  await f.storage.close();
  const db = new DatabaseSync(join(f.directory, "core.sqlite"));
  try { db.exec("ALTER TABLE pending_write DROP COLUMN result; PRAGMA user_version=5;"); }
  finally { db.close(); }
  await f.restart();
  assert.equal((await f.propose()).result.status, "pending");
  const check = new DatabaseSync(join(f.directory, "core.sqlite"));
  try { assert.equal(check.prepare("PRAGMA user_version").get().user_version, 23); }
  finally { check.close(); }
});
