import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  RetrievalRuntime, retrievalCosine, retrievalDigest, retrievalRank, retrievalSections,
} from "../dist/retrieval-runtime.js";
import { retrievalRuntimeDefinitions } from "../dist/retrieval-runtime-contracts.js";

const scope = { namespace: "notes", workspace: "workspace-1", actor: "alice" };
const pin = { id: "injected-synthetic-test-vectors", revision: "fixed-1", dimensions: 3, architecture: "dense-section" };
const source = (id, body, revision = "r1") => ({
  id, revision, sha256: retrievalDigest([id, body, revision]), title: id, description: "", body,
});
function fixture(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS fixture_sources(id TEXT PRIMARY KEY,payload TEXT NOT NULL)");
  const set = values => {
    db.exec("DELETE FROM fixture_sources");
    for (const value of values) db.prepare("INSERT INTO fixture_sources VALUES(?,?)").run(value.id, JSON.stringify(value));
  };
  const state = { allowed: true, hidden: new Set(), afterDocuments: null, afterQuery: null, vector: null, queries: 0 };
  const embedder = {
    model: { ...pin },
    async encodeDocuments(texts) {
      state.afterDocuments?.();
      return texts.map(text => state.vector ?? (text.includes("north") ? [2, 0, 0] : text.includes("east") ? [0, 4, 0] : [0, 0, 0]));
    },
    async encodeQueries() { state.queries++; state.afterQuery?.(); return [[10, 0, 0]]; },
  };
  const options = {
    database: db, embedder,
    readSources: () => db.prepare("SELECT payload FROM fixture_sources ORDER BY id").all().map(row => JSON.parse(row.payload)),
    authorize: (s, item, action) => state.allowed && (action === "index" || !state.hidden.has(`${s.actor}:${item.id}`)),
  };
  const runtime = new RetrievalRuntime(options);
  return { db, set, state, embedder, options, runtime };
}
async function activate(f, s = scope, expected = null) {
  const staged = await f.runtime.stage(s);
  assert.equal(staged.state, "staged");
  assert.equal(f.runtime.qualify(s, staged.indexId).state, "qualified");
  assert.equal(f.runtime.activate(s, staged.indexId, expected).state, "active");
  return staged;
}
const error = code => value => value.code === code;

test("real section cosine, max pool, source ties, zero and negative vectors", () => {
  const body = "preamble omitted\n# one\nnorth\n## two\neast";
  assert.deepEqual(retrievalSections(source("id", body)), ["id\n# one\nnorth", "id\n## two\neast"]);
  assert.equal(retrievalCosine([1, 0], [4, 0]), 1);
  assert.equal(retrievalCosine([1, 0], [-4, 0]), -1);
  assert.equal(retrievalCosine([0, 0], [4, 0]), 0);
  assert.equal(retrievalCosine([1e308, 0], [1e-308, 0]), 1);
  const chunks = [["b", [2, 0]], ["a", [1, 0]], ["a", [0, 1]], ["z", [0, 0]]]
    .map(([sourceId, vector], ordinal) => ({ id: `${ordinal}`, sourceId, vector, ordinal, text: sourceId }));
  const hits = retrievalRank(chunks, [1, 0]);
  assert.deepEqual(hits.map(hit => [hit.sourceId, hit.score, hit.similarity]), [["a", 1, 1], ["b", .5, 1], ["z", 1 / 3, 0]]);
  assert.deepEqual(retrievalRank(["😀", "\uffff"].map(sourceId => ({
    id: sourceId, sourceId, vector: [1, 0], ordinal: 0, text: sourceId,
  })), [1, 0]).map(hit => hit.sourceId), ["\uffff", "😀"]);
  for (const invalid of [[], [1], [NaN, 0], [Infinity, 0]]) assert.throws(() => retrievalCosine([1, 0], invalid), error("INVALID_ARGUMENT"));
  for (const limit of [0, -1, 101, 1.5, NaN]) assert.throws(() => retrievalRank(chunks, [1, 0], limit), error("LIMIT"));
});

test("explicit dependencies, index availability and schema-only public input", async () => {
  assert.throws(() => new RetrievalRuntime({}), error("UNAVAILABLE"));
  const f = fixture();
  try {
    assert.deepEqual(f.runtime.availability(scope), { available: false });
    await assert.rejects(f.runtime.search(scope, { query: "north" }), error("UNAVAILABLE"));
    assert.equal(f.state.queries, 0);
    const schema = retrievalRuntimeDefinitions[0].input;
    for (const extra of [{ root: "/private" }, { actor: "other" }, { embedder: {} }, { database: "sql" }, { namespace: "x" }]) {
      assert.equal(schema.safeParse({ query: "north", ...extra }).success, false);
    }
    assert.equal(schema.safeParse({ query: "\ud800" }).success, false);
    assert.equal(schema.safeParse({ query: "north" }).data.limit, 5);
    for (const dimensions of [0, -1, 4097, 1.5, NaN]) {
      assert.throws(() => new RetrievalRuntime({ ...f.options, embedder: { ...f.embedder, model: { ...pin, dimensions } } }), error("INVALID_ARGUMENT"));
    }
    f.embedder.model.architecture = "pca-dense-section";
    await assert.rejects(f.runtime.stage(scope), error("INVALID_ARGUMENT"));
  } finally { f.db.close(); }
});

test("persisted activation, query pins, auth before top-k and scope partition", async () => {
  const f = fixture();
  try {
    f.set([source("a", "# both\nnorth\n# other\neast"), source("b", "north"), source("z", "east")]);
    const index = await activate(f);
    const result = await f.runtime.search(scope, { query: "query text need not match documents", expectedIndexId: index.indexId });
    assert.deepEqual(result.hits.map(hit => hit.sourceId), ["a", "b", "z"]);
    assert.deepEqual(result.hits.map(hit => hit.similarity), [1, 1, 0]);
    assert.equal(result.hits[0].sourceSha256, source("a", "# both\nnorth\n# other\neast").sha256);
    assert.deepEqual(result.model, pin);
    assert.equal(retrievalRuntimeDefinitions[0].output.safeParse(result).success, true);
    f.state.hidden.add("alice:a");
    assert.deepEqual((await f.runtime.search(scope, { query: "north", limit: 1 })).hits.map(hit => hit.sourceId), ["b"]);
    assert.deepEqual((await f.runtime.search(scope, { query: "north", limit: 1, sourceIds: ["z"] })).hits.map(hit => hit.sourceId), ["z"]);
    assert.deepEqual((await f.runtime.search(scope, { query: "north", sourceIds: ["a"] })).hits, []);
    assert.deepEqual((await f.runtime.search(scope, { query: "north", sourceIds: [] })).hits, []);
    assert.deepEqual((await f.runtime.search(scope, { query: "north", sourceIds: ["missing"] })).hits, []);
    await assert.rejects(f.runtime.search(scope, { query: "north", sourceIds: ["a", "a"] }), error("INVALID_ARGUMENT"));
    await assert.rejects(f.runtime.search(scope, { query: "north", sourceIds: Array.from({ length: 129 }, (_, i) => `${i}`) }), error("LIMIT"));
    f.state.allowed = false;
    assert.deepEqual((await f.runtime.search(scope, { query: "north" })).hits, []);
    f.state.allowed = true;
    for (const alternate of [{ ...scope, actor: "bob" }, { ...scope, workspace: "workspace-2" }, { ...scope, namespace: "papers" }]) {
      await assert.rejects(f.runtime.search(alternate, { query: "north" }), error("UNAVAILABLE"));
      assert.throws(() => f.runtime.qualify(alternate, index.indexId), error("UNAVAILABLE"));
    }
    const bob = { ...scope, actor: "bob" }, bobIndex = await activate(f, bob);
    assert.notEqual(bobIndex.indexId, index.indexId);
    assert.equal((await f.runtime.search(bob, { query: "north", limit: 1 })).hits[0].sourceId, "a");
    assert.equal((await f.runtime.search(scope, { query: "north", limit: 1 })).hits[0].sourceId, "b");
    await assert.rejects(f.runtime.search(scope, { query: "north", expectedIndexId: "stale" }), error("CONFLICT"));
    assert.throws(() => f.runtime.discard(scope, index.indexId), error("CONFLICT"));
  } finally { f.db.close(); }
});

test("qualification validates persisted vector digest rather than trusting a staging receipt", async () => {
  const f = fixture();
  try {
    f.set([source("a", "north")]);
    const staged = await f.runtime.stage(scope);
    const row = f.db.prepare("SELECT payload FROM retrieval_runtime_indexes WHERE id=?").get(staged.indexId);
    const payload = JSON.parse(row.payload);
    payload.chunks[0].vector = [0, 1, 0];
    f.db.prepare("UPDATE retrieval_runtime_indexes SET payload=?,digest=? WHERE id=?")
      .run(JSON.stringify(payload), retrievalDigest(payload), staged.indexId);
    assert.throws(() => f.runtime.qualify(scope, staged.indexId), error("INTEGRITY"));
    assert.deepEqual(f.runtime.availability(scope), { available: false });
  } finally { f.db.close(); }
});

test("source edits, revision-only edits, additions and deletion fail closed", async () => {
  for (const change of [
    () => [source("a", "east")], () => [source("a", "north", "r2")],
    () => [source("a", "north"), source("new", "north")], () => [],
  ]) {
    const f = fixture();
    try {
      f.set([source("a", "north")]);
      const staged = await f.runtime.stage(scope);
      f.set(change());
      assert.throws(() => f.runtime.qualify(scope, staged.indexId), error("STALE_SOURCE"));
      f.set([source("a", "north")]); f.runtime.qualify(scope, staged.indexId);
      f.set(change());
      assert.throws(() => f.runtime.activate(scope, staged.indexId, null), error("STALE_SOURCE"));
      f.set([source("a", "north")]); f.runtime.activate(scope, staged.indexId, null);
      f.set(change());
      await assert.rejects(f.runtime.search(scope, { query: "north" }), error("STALE_SOURCE"));
      assert.throws(() => f.runtime.availability(scope), error("STALE_SOURCE"));
    } finally { f.db.close(); }
  }
});

test("async embedding source/model/authorization races and invalid vectors never publish", async () => {
  const f = fixture();
  try {
    f.set([source("a", "north")]);
    f.state.afterDocuments = () => f.set([]);
    await assert.rejects(f.runtime.stage(scope), error("STALE_SOURCE"));
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM retrieval_runtime_indexes").get().n, 0);
    f.state.afterDocuments = null; f.set([source("a", "north")]);
    for (const vector of [[1, 2], [1, NaN, 2], [1, Infinity, 2]]) {
      f.state.vector = vector;
      await assert.rejects(f.runtime.stage(scope), error("INVALID_ARGUMENT"));
    }
    f.state.vector = null;
    f.state.afterDocuments = () => { f.state.allowed = false; };
    await assert.rejects(f.runtime.stage(scope), error("FORBIDDEN"));
    f.state.afterDocuments = null; f.state.allowed = true;
    const index = await activate(f);
    f.state.afterQuery = () => f.set([]);
    await assert.rejects(f.runtime.search(scope, { query: "north" }), error("STALE_SOURCE"));
    f.set([source("a", "north")]); f.state.afterQuery = null;
    const next = await f.runtime.stage(scope); f.runtime.qualify(scope, next.indexId);
    f.state.afterQuery = () => f.runtime.activate(scope, next.indexId, index.indexId);
    await assert.rejects(f.runtime.search(scope, { query: "north" }), error("CONFLICT"));
    f.state.afterQuery = null;
    f.embedder.model.revision = "changed";
    await assert.rejects(f.runtime.search(scope, { query: "north" }), error("CONFLICT"));
  } finally { f.db.close(); }
});

test("limits, bounded checkpoints, qualification and activation CAS", async () => {
  const f = fixture();
  try {
    f.set(Array.from({ length: 129 }, (_, index) => source(`${index}`, "north")));
    await assert.rejects(f.runtime.stage(scope), error("LIMIT"));
    f.set([source("a", Array.from({ length: 2049 }, (_, i) => `# heading ${i}\nx`).join("\n"))]);
    await assert.rejects(f.runtime.stage(scope), error("LIMIT"));
    f.set([source("a", "north")]);
    const staged = await f.runtime.stage(scope);
    assert.throws(() => f.runtime.activate(scope, staged.indexId, null), error("CONFLICT"));
    f.runtime.qualify(scope, staged.indexId); f.runtime.activate(scope, staged.indexId, null);
    const next = await f.runtime.stage(scope); f.runtime.qualify(scope, next.indexId);
    assert.throws(() => f.runtime.activate(scope, next.indexId, null), error("CONFLICT"));
    assert.equal((await f.runtime.search(scope, { query: "north" })).indexId, staged.indexId);
    await f.runtime.stage(scope); const fourth = await f.runtime.stage(scope);
    await assert.rejects(f.runtime.stage(scope), error("LIMIT"));
    f.runtime.discard(scope, fourth.indexId);
    await f.runtime.stage(scope);
    for (const request of [{ query: "north", limit: 0 }, { query: "north", limit: 101 }, { query: "x".repeat(4097) }, { query: "\ud800" }]) {
      await assert.rejects(f.runtime.search(scope, request), error(request.limit !== undefined ? "LIMIT" : "INVALID_ARGUMENT"));
    }
  } finally { f.db.close(); }
});

test("activation write failure rolls back pointer and both checkpoint states", async () => {
  const f = fixture();
  try {
    f.set([source("a", "north")]);
    const old = await activate(f), next = await f.runtime.stage(scope);
    f.runtime.qualify(scope, next.indexId);
    f.db.exec("CREATE TRIGGER fixture_abort BEFORE UPDATE ON retrieval_runtime_active BEGIN SELECT RAISE(ABORT,'activation crash'); END");
    assert.throws(() => f.runtime.activate(scope, next.indexId, old.indexId), /activation crash/);
    assert.equal((await f.runtime.search(scope, { query: "north" })).indexId, old.indexId);
    assert.deepEqual(f.db.prepare("SELECT id,state FROM retrieval_runtime_indexes ORDER BY id").all().map(row => [row.id, row.state]).sort(),
      [[old.indexId, "active"], [next.indexId, "qualified"]].sort());
  } finally { f.db.close(); }
});

test("explicit model upgrade rebuilds and CAS replaces old model without querying incompatible vectors", async () => {
  const f = fixture();
  try {
    f.set([source("a", "north")]);
    const old = await activate(f);
    const embedder = {
      model: { ...pin, revision: "fixed-2", dimensions: 2 },
      async encodeDocuments(texts) { return texts.map(() => [1, 0]); },
      async encodeQueries() { return [[1, 0]]; },
    };
    const nextRuntime = new RetrievalRuntime({ ...f.options, embedder });
    await assert.rejects(nextRuntime.search(scope, { query: "north" }), error("CONFLICT"));
    const next = await nextRuntime.stage(scope);
    nextRuntime.qualify(scope, next.indexId);
    nextRuntime.activate(scope, next.indexId, old.indexId);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM retrieval_runtime_indexes").get().n, 1);
    assert.equal(f.db.prepare("SELECT index_id FROM retrieval_runtime_retirements").get().index_id, old.indexId);
    const result = await nextRuntime.search(scope, { query: "north" });
    assert.equal(result.model.revision, "fixed-2");
    assert.equal(result.hits[0].similarity, 1);
    await assert.rejects(f.runtime.search(scope, { query: "north" }), error("CONFLICT"));
  } finally { f.db.close(); }
});

test("derived reset is scoped, CAS guarded and preserves immutable retirement receipts", async () => {
  const f = fixture();
  try {
    f.set([source("a", "north")]);
    const first = await activate(f);
    const otherScope = { ...scope, actor: "other" };
    const other = await activate(f, otherScope);
    assert.throws(() => f.runtime.resetDerived(scope, "stale"), error("CONFLICT"));
    f.runtime.resetDerived(scope, first.indexId);
    assert.deepEqual(f.runtime.availability(scope), { available: false });
    assert.equal((await f.runtime.search(otherScope, { query: "north" })).indexId, other.indexId);
    assert.equal(f.db.prepare("SELECT index_id FROM retrieval_runtime_retirements").get().index_id, first.indexId);
    assert.throws(() => f.db.exec("DELETE FROM retrieval_runtime_retirements"), /immutable/);
    const rebuilt = await activate(f);
    assert.notEqual(rebuilt.indexId, first.indexId);
  } finally { f.db.close(); }
});

test("restart and process crash preserve activated index; corrupt vector checkpoints fail closed", async () => {
  const directory = resolve("tests", `.retrieval-runtime-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, "shared.sqlite");
  let f = fixture(path);
  try {
    f.set([source("a", "north")]);
    const old = await activate(f);
    const pending = await f.runtime.stage(scope);
    f.db.close();
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {DatabaseSync} from "node:sqlite";
      const db=new DatabaseSync(process.argv[1]);
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE retrieval_runtime_active SET index_id=?").run("uncommitted-broken-pointer");
      process.exit(71);
    `, path], { encoding: "utf8" });
    assert.equal(child.status, 71, child.stderr);
    f = fixture(path);
    assert.equal((await f.runtime.search(scope, { query: "north" })).indexId, old.indexId);
    f.runtime.qualify(scope, pending.indexId);
    f.runtime.activate(scope, pending.indexId, old.indexId);
    f.db.prepare("UPDATE retrieval_runtime_indexes SET digest=? WHERE id=?").run("0".repeat(64), pending.indexId);
    await assert.rejects(f.runtime.search(scope, { query: "north" }), error("INTEGRITY"));
  } finally { f.db.close(); await rm(directory, { recursive: true, force: true }); }
});
