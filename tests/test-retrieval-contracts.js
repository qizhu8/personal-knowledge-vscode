#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  RETRIEVAL_QUERY_SCHEMA_V1,
  compileRetrievalQueryV1,
  compileRetrievalResultV1,
  assertRetrievalIndexEventV1,
} = require("../dist/retrieval-contracts.js");
const { RetrievalIndexEventStore } = require("../dist/retrieval-index-events.js");

const valid = {
  schema: RETRIEVAL_QUERY_SCHEMA_V1,
  requestId: "request-1",
  text: "检索 RetrievalWorkerManager exact-id",
  contentTypeFilter: ["skill", "research", "recipe"],
  scope: { capabilityId: "test", sourceIds: ["pkm://knowledge/knowledge_0123456789abcdef01234567"] },
  topK: 20,
  route: "hybrid",
  generation: { mode: "minimum", generation: 3 },
  graph: { maxDepth: 3, maxNodes: 40, maxEdges: 80, relations: ["cites"], direction: "both" },
  deadlineMs: 2500,
  diagnostics: "debug",
};
assert.deepStrictEqual(compileRetrievalQueryV1(valid), { ok: true, value: valid, diagnostics: [] });
for (const [field, replacement] of [
  ["schema", "v0"],
  ["requestId", ""],
  ["text", ""],
  ["topK", 0],
  ["route", "magic"],
  ["generation", { mode: "exact", generation: 0 }],
  ["deadlineMs", 0],
  ["diagnostics", "verbose"],
]) {
  const result = compileRetrievalQueryV1({ ...valid, [field]: replacement });
  assert.strictEqual(result.ok, false, `${field} must be validated`);
  assert(result.diagnostics.some(item => item.pointer === `/${field}`));
}
assert.strictEqual(compileRetrievalQueryV1({ ...valid, surprise: true }).ok, false);
for (let seed = 1; seed <= 100; seed++) {
  const topK = (seed % 100) + 1;
  const compiled = compileRetrievalQueryV1({ ...valid, requestId: `property-${seed}`, topK });
  assert.strictEqual(compiled.ok, true, `bounded property case ${seed}`);
}
const validResult = {
  schema: "pkm.retrieval.result/v1",
  ok: true,
  requestId: "request-1",
  readyGeneration: 3,
  corpusRevision: "revision-3",
  route: "hybrid",
  intent: "mixed",
  hits: [{
    rank: 1,
    score: 4.2,
    scoreComponents: { lexical: 4, semantic: 0, graph: 0.2, priority: 1 },
    sourceId: "pkm://knowledge/knowledge_0123456789abcdef01234567",
    sourceRevision: "7",
    contentHash: "a".repeat(64),
    contentType: "research",
    sourceUri: "pkm://knowledge/knowledge_0123456789abcdef01234567",
    title: "Result",
    description: "typed",
    readOnly: false,
    route: "hybrid",
    metadata: {},
    provenance: {},
  }],
  diagnostics: [],
  stale: false,
  incomplete: false,
  timingsMs: { wait: 0, search: 2.5, total: 2.5 },
};
assert.deepStrictEqual(compileRetrievalResultV1(validResult), { ok: true, value: validResult, diagnostics: [] });
assert.strictEqual(compileRetrievalResultV1({ ...validResult, readyGeneration: 0 }).ok, false);
assert.strictEqual(compileRetrievalResultV1({ ...validResult, hits: [{ ...validResult.hits[0], sourceRevision: "" }] }).ok, false);

const source = {
  sourceId: "pkm://knowledge/knowledge_0123456789abcdef01234567",
  sourceRevision: "1",
  contentHash: "a".repeat(64),
  contentType: "research",
  sourceUri: "pkm://knowledge/knowledge_0123456789abcdef01234567",
  title: "Research",
  description: "Paper",
  body: "body",
  metadata: {},
  provenance: { provider: "pkm" },
  readOnly: false,
  links: [],
};
const upsert = {
  schema: "pkm.retrieval.index-event/v1",
  eventId: "event-1",
  sourceId: source.sourceId,
  sourceRevision: "1",
  kind: "upsert",
  source,
};
assert.strictEqual(assertRetrievalIndexEventV1(upsert), upsert);
assert.throws(() => assertRetrievalIndexEventV1({ ...upsert, kind: "unknown" }), /Unsupported/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-index-events-"));
try {
  const store = new RetrievalIndexEventStore(path.join(root, "state.json"));
  assert.deepStrictEqual(store.apply([upsert]), { generation: 1, applied: 1, reused: 0, sources: [source] });
  assert.deepStrictEqual(store.apply([upsert]), { generation: 1, applied: 0, reused: 1, sources: [source] });
  assert.throws(() => store.apply([{ ...upsert, eventId: "event-stale", sourceRevision: "0", source: { ...source, sourceRevision: "0" } }]), /Stale source revision/);
  const target = "pkm://knowledge/knowledge_aaaaaaaaaaaaaaaaaaaaaaaa";
  const linked = store.apply([{
    schema: "pkm.retrieval.index-event/v1",
    eventId: "link-2",
    sourceId: source.sourceId,
    sourceRevision: "2",
    kind: "link-upsert",
    link: { relation: "supports", target, mode: "floating", required: true },
  }]);
  assert.strictEqual(linked.sources[0].links[0].target, target);
  const unlinked = store.apply([{
    schema: "pkm.retrieval.index-event/v1",
    eventId: "unlink-3",
    sourceId: source.sourceId,
    sourceRevision: "3",
    kind: "link-delete",
    link: { relation: "supports", target },
  }]);
  assert.deepStrictEqual(unlinked.sources[0].links, []);
  assert.throws(() => store.apply([{
    schema: "pkm.retrieval.index-event/v1",
    eventId: "bad-link-4",
    sourceId: source.sourceId,
    sourceRevision: "4",
    kind: "link-upsert",
    link: { relation: "supports", target: "relative/path", mode: "floating", required: true },
  }]), /Invalid link-upsert/);
  const barrier = {
    schema: "pkm.retrieval.index-event/v1",
    eventId: "barrier-4",
    sourceId: "__barrier__",
    sourceRevision: "4",
    kind: "rebuild-barrier",
    generation: 4,
  };
  assert.strictEqual(store.apply([barrier]).generation, 4);
  assert.throws(() => store.apply([{ ...barrier, eventId: "barrier-3", sourceRevision: "3", generation: 3 }]), /Stale source revision|not newer/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("retrieval contracts test: schemas, bounded query properties, idempotent events, and stale revisions OK");
