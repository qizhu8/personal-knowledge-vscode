const { test } = require("node:test");
const assert = require("node:assert/strict");
const { compileRetrievalQueryV1, compileRetrievalResultV1, compileRetrievalCapabilitiesV1,
  assertRetrievalResultForQuery } = require("../dist/retrieval/retrieval-contracts");
const { RetrievalWorkerManager } = require("../dist/retrieval/retrieval-worker");
const { indexedRetrievalDocument, retrievalDocumentContentHash, retrievalSourceValidation } = require("../dist/retrieval/retrieval-snapshot");
const { ruleSourcePassages } = require("../dist/retrieval/retrieval-passages");

const query = () => ({
  schema: "pkm.retrieval.query/v1", requestId: "request", text: "latency", level: "l1-source",
  scope: { capabilityId: "authorized", sourceIds: ["source"], includeReadOnly: false },
  contentTypeFilter: ["note"], topK: 2, route: "lexical",
  generation: { mode: "exact", generation: 3 }, deadlineMs: 1000, diagnostics: "summary",
});
const hit = () => ({
  rank: 1, score: 2, scoreComponents: { lexical: 2, semantic: 0, graph: 0, priority: 1 },
  sourceId: "source", sourceRevision: "r1", contentHash: "a".repeat(64), sourceUri: "pkm://notes/source",
  contentType: "note", title: "Source", description: "", readOnly: false, route: "lexical", metadata: {}, provenance: {},
});
const result = () => ({
  schema: "pkm.retrieval.result/v1", ok: true, requestId: "request", readyGeneration: 3,
  corpusRevision: "corpus", route: "lexical", intent: "latency", hits: [hit()], diagnostics: [],
  stale: false, incomplete: false, timingsMs: { wait: 0, search: 1, total: 1 },
});

test("retrieval compiler rejects coercion, duplicate identities/ranks and nonfinite timing", () => {
  for (const patch of [
    { requestId: 42 }, { text: {} }, { scope: { capabilityId: "scope", includeReadOnly: "false" } },
    { scope: { capabilityId: "scope", sourceIds: ["source", "source"] } }, { graph: null }, { graph: "all" },
    { scope: { capabilityId: "scope", sourceIds: [""] } }, { contentTypeFilter: ["note", "note"] },
  ]) assert.equal(compileRetrievalQueryV1({ ...query(), ...patch }).ok, false, JSON.stringify(patch));
  for (const patch of [
    { requestId: 42 }, { hits: [hit(), hit()] }, { hits: [hit(), { ...hit(), sourceId: "second" }] },
    { hits: [{ ...hit(), readOnly: "false" }] }, { hits: [{ ...hit(), sourceId: {} }] },
    { hits: [{ ...hit(), contentHash: "not-a-hash" }] }, { timingsMs: { wait: NaN, search: 1, total: 1 } },
    { timingsMs: { wait: 0, search: Infinity, total: Infinity } },
  ]) assert.equal(compileRetrievalResultV1({ ...result(), ...patch }).ok, false, JSON.stringify(patch));
});

test("result admission binds request, level, scope, generation, types and requested route", () => {
  assert.deepEqual(assertRetrievalResultForQuery(query(), result()), result());
  for (const patch of [
    { requestId: "other" }, { readyGeneration: 4 }, { stale: true }, { route: "semantic" },
    { hits: [{ ...hit(), sourceId: "outside" }] }, { hits: [{ ...hit(), contentType: "action" }] },
    { hits: [{ ...hit(), readOnly: true }] },
    { hits: [hit(), { ...hit(), sourceId: "second", rank: 2 }, { ...hit(), sourceId: "third", rank: 3 }] },
  ]) assert.throws(() => assertRetrievalResultForQuery(query(), { ...result(), ...patch }), /retrieval/i);
  assert.throws(() => assertRetrievalResultForQuery({ ...query(), level: "l2-passage" }, result()), /L1|l1|passage/);
  assert.throws(() => assertRetrievalResultForQuery({ ...query(), scope: { capabilityId: "none", sourceIds: [] } }, result()), /scope/i);
  assert.throws(() => assertRetrievalResultForQuery({ ...query(), generation: { mode: "minimum", generation: 4 } }, result()), /generation/i);
  assert.equal(assertRetrievalResultForQuery({ ...query(), generation: { mode: "minimum", generation: 2 } }, result()).readyGeneration, 3);
});

test("capability admission requires typed stable identity rather than string-coercible values", () => {
  const capabilities = {
    schema: "pkm.retrieval.capabilities/v1",
    provider: { providerId: "provider", providerVersion: "1", route: "lexical", scoreSemantics: "rrf" },
    querySchemas: ["pkm.retrieval.query/v1"], resultSchemas: ["pkm.retrieval.result/v1"],
    levels: ["l1-source"], sourceKinds: ["note"], routes: ["lexical"], scoreSemantics: ["rrf"],
    features: { filters: true, generations: true, graph: false, contentRanges: false, refinement: false, streaming: false },
    limits: { maxTopK: 100, maxQueryCharacters: 8192, maxDeadlineMs: 300000 },
  };
  assert(compileRetrievalCapabilitiesV1(capabilities).ok);
  for (const patch of [{ providerId: 42 }, { providerVersion: {} }, { modelId: 42 }, { surprise: "unnegotiated" }]) {
    assert.equal(compileRetrievalCapabilitiesV1({ ...capabilities, provider: { ...capabilities.provider, ...patch } }).ok, false);
  }
});

test("subscription filtering preserves concrete upstream types without bypassing authorized scope", () => {
  const subscribed = { ...hit(), contentType: "skill", sourceUri: "pkm://subscriptions/typed-skill",
    readOnly: true, provenance: { provider: "broker" } };
  const request = { ...query(), scope: { capabilityId: "subscribed", sourceIds: ["source"], includeReadOnly: true },
    contentTypeFilter: ["subscription"] };
  assert.equal(assertRetrievalResultForQuery(request, { ...result(), hits: [subscribed] }).hits[0].contentType, "skill");
  assert.throws(() => assertRetrievalResultForQuery(request, { ...result(), hits: [hit()] }), /content type/);
  assert.throws(() => assertRetrievalResultForQuery({ ...request, scope: { ...request.scope, includeReadOnly: false } },
    { ...result(), hits: [subscribed] }), /scope/);
  assert.throws(() => assertRetrievalResultForQuery({ ...request, scope: { ...request.scope, sourceIds: [] } },
    { ...result(), hits: [subscribed] }), /scope/);
});

test("all worker consumers reject a response from another request or scope before accepting hits", async () => {
  const manager = new RetrievalWorkerManager("/unused", "/unused", "/unused", "1");
  let calls = 0, requestId = "other", sourceId = "source", readyGeneration = 3;
  manager.status = async () => ({ ready_generation: 3, engine_version: "1" });
  manager.ensure = async () => ({});
  manager.request = async () => {
    calls++;
    return {
      ok: true, request_id: requestId, ready_generation: readyGeneration, corpus_revision: "corpus", route: "lexical",
      solution: { reason: "default" }, skill_serving: { used: false },
      hits: [{ rank: 1, score: 1, source_id: sourceId, source_revision: "r1", content_hash: "a".repeat(64),
        content_type: "note", source_uri: "pkm://notes/source", title: "Source", description: "", metadata: {}, provenance: {},
        read_only: false, contributing_routes: ["bm25"] }],
    };
  };
  await assert.rejects(manager.query(query()), /request/i);
  requestId = "request"; sourceId = "outside";
  await assert.rejects(manager.query(query()), /scope/i);
  sourceId = "source"; readyGeneration = 4;
  await assert.rejects(manager.query(query()), /generation/i);
  readyGeneration = 3;
  await assert.rejects(manager.query({ ...query(), level: "l2-passage" }), /L1|l1|passage/);
  assert.equal(calls, 3, "An unsupported passage request must not be dispatched as source search");
  assert.equal((await manager.query(query())).hits[0].sourceId, "source");
});

test("freshness validation binds physical source type/URI, original span text and content hash", () => {
  const document = indexedRetrievalDocument({
    skill_id: "source", source_id: "source", source_revision: "r1", content_type: "note",
    title: "Source", description: "", source_uri: "pkm://notes/source", body: "# Results\n\nlatency must not exceed 125 ms.",
    metadata: {}, provenance: {}, read_only: false, visibility: "available", links: [],
  });
  const parent = { id: "source", level: "l1-source", sourceId: "source", sourceRevision: document.source_revision,
    contentHash: retrievalDocumentContentHash(document), sourceUri: document.source_uri, kind: "note", label: "Source",
    score: 1, selected: false, method: "fixture", reason: "fixture", content: document.body };
  const validation = retrievalSourceValidation(() => ({ corpus_revision: "corpus", documents: [document] }));
  validation.admit(parent, document);
  validation.refreshSourceValidation();
  assert(validation.sourceIsCurrent(parent));
  for (const patch of [{ kind: "action" }, { sourceUri: "pkm://notes/other" }, { content: "Approved for deployment." }]) {
    assert.equal(validation.sourceIsCurrent({ ...parent, ...patch }), false);
    assert.throws(() => validation.admit({ ...parent, ...patch }, document), /mismatch|invalid|materializ/i);
  }
  const passage = ruleSourcePassages(parent, document.body, "latency").candidates[0];
  assert(validation.sourceIsCurrent(passage));
  for (const patch of [
    { content: "Approved for deployment." }, { contentHash: "b".repeat(64) },
    { range: { start: 0, end: 999, unit: "characters" } }, { parentId: "other" }, { sourceUri: "pkm://notes/other" },
  ]) assert.equal(validation.sourceIsCurrent({ ...passage, ...patch }), false, JSON.stringify(patch));
});
