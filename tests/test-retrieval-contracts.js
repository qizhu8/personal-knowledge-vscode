#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  RETRIEVAL_QUERY_SCHEMA_V1,
  RETRIEVAL_CAPABILITIES_SCHEMA_V1,
  compileRetrievalCapabilitiesV1,
  sanitizeRetrievalCandidatesV1,
  compileRetrievalQueryV1,
  compileRetrievalResultV1,
  assertRetrievalIndexEventV1,
} = require("../dist/retrieval/retrieval-contracts.js");
const { guardRetrievalCandidates } = require("../dist/retrieval/retrieval-provider.js");
const { RetrievalIndexEventStore } = require("../dist/retrieval/retrieval-index-events.js");

const valid = {
  schema: RETRIEVAL_QUERY_SCHEMA_V1,
  requestId: "request-1",
  text: "检索 RetrievalWorkerManager exact-id",
  level: "l1-source",
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
const capabilities = {
  schema: RETRIEVAL_CAPABILITIES_SCHEMA_V1,
  provider: {
    providerId: "pkm.local.hybrid",
    providerVersion: "1.0.0",
    route: "hybrid",
    scoreSemantics: "rrf",
  },
  querySchemas: ["pkm.retrieval.query/v1"],
  resultSchemas: ["pkm.retrieval.result/v1"],
  levels: ["l1-source", "l2-passage"],
  sourceKinds: ["skill", "note", "chat-memory"],
  routes: ["lexical", "semantic", "hybrid"],
  scoreSemantics: ["rrf", "similarity"],
  features: {
    filters: true, generations: true, graph: false,
    contentRanges: true, refinement: false, streaming: false,
  },
  limits: { maxTopK: 100, maxQueryCharacters: 8192, maxDeadlineMs: 300000 },
};
assert.deepStrictEqual(compileRetrievalCapabilitiesV1(capabilities), { ok: true, value: capabilities, diagnostics: [] });
assert.strictEqual(compileRetrievalCapabilitiesV1({
  ...capabilities,
  provider: { ...capabilities.provider, scoreSemantics: "mystery" },
}).ok, false);
const candidate = {
  id: "source-1", level: "l1-source", kind: "skill", label: "Skill",
  sourceUri: "pkm://skills/test", method: "fixture", score: 0.5,
  scoreSemantics: "similarity", selected: false, reason: "ranked",
  sourceId: "source-1", sourceRevision: "1", contentHash: "a".repeat(64),
};
assert.deepStrictEqual(sanitizeRetrievalCandidatesV1([candidate]).candidates, [candidate]);
const mixedCandidates = sanitizeRetrievalCandidatesV1([
  candidate,
  { ...candidate, id: "nan", score: Number.NaN },
  { ...candidate, id: "duplicate" },
  { ...candidate, id: "duplicate" },
  { ...candidate, id: "orphan", level: "l2-passage", range: { start: 0, end: 5, unit: "characters" } },
  { ...candidate, id: "reversed", range: { start: 9, end: 2, unit: "characters" } },
  { ...candidate, id: "stale", sourceRevision: "old" },
], { sourceIsCurrent: item => item.sourceRevision !== "old" });
assert.deepStrictEqual(mixedCandidates.candidates.map(item => item.id), ["source-1", "duplicate"]);
assert.strictEqual(mixedCandidates.incomplete, true);
assert.strictEqual(mixedCandidates.diagnostics.length, 5);
const oversizedCandidates = sanitizeRetrievalCandidatesV1(Array.from({ length: 101 }, (_, index) => ({
  ...candidate, id: `bounded-${index}`,
})));
assert.strictEqual(oversizedCandidates.candidates.length, 100);
assert.strictEqual(oversizedCandidates.incomplete, true);
assert.strictEqual(sanitizeRetrievalCandidatesV1([{ ...candidate, id: "huge", content: "x".repeat(160001) }]).candidates.length, 0);

async function testProviderGuard() {
  const active = new AbortController();
  const poor = await guardRetrievalCandidates(async () => [{ ...candidate, score: -1000 }], active.signal);
  assert.strictEqual(poor.status, "ok", "poor relevance is valid provider behavior, not a system failure");
  const partial = await guardRetrievalCandidates(async () => [candidate, { ...candidate, id: "bad", score: Infinity }], active.signal);
  assert.strictEqual(partial.status, "degraded");
  assert.deepStrictEqual(partial.candidates, [candidate]);
  const failed = await guardRetrievalCandidates(async () => { throw new Error("model crashed"); }, active.signal);
  assert.strictEqual(failed.status, "unavailable");
  assert.deepStrictEqual(failed.candidates, []);
  const timedOut = await guardRetrievalCandidates(() => new Promise(() => {}), active.signal, { deadlineMs: 5 });
  assert.strictEqual(timedOut.status, "unavailable");
  const cancelled = new AbortController();
  cancelled.abort(new Error("caller cancelled"));
  await assert.rejects(() => guardRetrievalCandidates(async () => [], cancelled.signal), /caller cancelled/);
}
assert.strictEqual(compileRetrievalCapabilitiesV1({
  ...capabilities,
  features: { ...capabilities.features, refinement: undefined },
}).ok, false);
assert.strictEqual(compileRetrievalCapabilitiesV1({
  ...capabilities,
  levels: ["l3-answer"],
}).ok, false);
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
assert.strictEqual(compileRetrievalResultV1({ ...validResult, hits: [{ ...validResult.hits[0], score: Number.NaN }] }).ok, false);
assert.strictEqual(compileRetrievalResultV1({ ...validResult, hits: Array.from({ length: 101 }, () => validResult.hits[0]) }).ok, false);

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
testProviderGuard().then(() => {
  console.log("retrieval contracts test: schemas, provider containment, bounded candidates, idempotent events, and stale revisions OK");
}, error => {
  console.error(error);
  process.exitCode = 1;
});
