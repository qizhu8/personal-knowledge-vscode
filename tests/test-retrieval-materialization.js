const { test } = require("node:test");
const assert = require("node:assert/strict");
const { indexedRetrievalDocument, retrievalDocumentForSource, materializeRetrievalCandidates,
  retrievalDocumentContentHash, retrievalSourceValidation } = require("../dist/retrieval/retrieval-snapshot");
const { passageReferenceGroup } = require("../dist/retrieval/retrieval-passages");
const { sanitizeRetrievalCandidatesV1 } = require("../dist/retrieval/retrieval-contracts");
const document = body => ({ skill_id:"note:research", source_id:"pkm://knowledge/research",
  source_revision:"7", title:"Research", body, description:"Evidence", content_type:"research",
  source_uri:"pkm://research/test", metadata:{}, provenance:{}, read_only:false, visibility:"available", links:[] });
const candidate = source => ({ id:source.source_id, sourceId:source.source_id,
  sourceRevision:source.source_revision, contentHash:retrievalDocumentContentHash(source), level:"l1-source",
  kind:source.content_type, label:source.title, sourceUri:source.source_uri,
  score:1, method:"lexical:unified-retrieval", reason:"Ranked source", selected:false });

test("worker-indexed revisions resolve to current physical sources and survive send-time validation", () => {
  let snapshot = { corpus_revision:"corpus", documents:[document("Do not deploy.")] };
  const indexed = indexedRetrievalDocument(snapshot.documents[0]), hit = candidate(indexed);
  assert.notEqual(hit.sourceRevision, snapshot.documents[0].source_revision);
  const resolved = retrievalDocumentForSource(snapshot, hit.sourceId, hit.sourceRevision, hit.contentHash);
  assert.deepEqual(resolved, indexed);
  const validation = retrievalSourceValidation(() => snapshot);
  validation.admit(hit, resolved);
  validation.refreshSourceValidation();
  assert(validation.sourceIsCurrent(hit));
  assert.equal(materializeRetrievalCandidates([hit], snapshot, "deploy")[0].content, "Do not deploy.");
  snapshot = { ...snapshot, documents:[{ ...snapshot.documents[0], body:"Changed without incrementing the display revision." }] };
  validation.refreshSourceValidation();
  assert.equal(validation.sourceIsCurrent(hit), false);
  assert.equal(retrievalDocumentForSource(snapshot, hit.sourceId, hit.sourceRevision, hit.contentHash), undefined);
  assert.equal(materializeRetrievalCandidates([hit], snapshot, "deploy")[0].content, undefined);
});

test("large sources reach tail passages without transporting or substituting their prefix", () => {
  const body = "# Research\n\nConditions: CPU-only; not approved.\n\n## Background\n\n"
    + "Unrelated material.\r\n\r\n".repeat(10000) + "## Results\n\nDo not deploy: p99 latency is 125 ms.\r\n";
  const snapshot = { corpus_revision:"large", documents:[document(body)] };
  const indexed = indexedRetrievalDocument(snapshot.documents[0]), parent = candidate(indexed);
  const candidates = materializeRetrievalCandidates([parent], snapshot, "p99 latency");
  assert.equal(candidates[0].content, undefined);
  const evidence = candidates.find(item => item.content?.includes("125 ms"));
  assert(evidence.range.start > 160000);
  assert.equal(evidence.content, body.slice(evidence.range.start, evidence.range.end));
  assert(passageReferenceGroup(evidence, candidates).some(item => item.content.includes("CPU-only; not approved.")));
  assert.equal(sanitizeRetrievalCandidatesV1(candidates).incomplete, false);
  const validation = retrievalSourceValidation(() => snapshot);
  validation.admit(parent, indexed);
  validation.refreshSourceValidation();
  assert(validation.sourceIsCurrent(evidence));
});

test("private, removed and content-hash-mismatched sources are not materialized", () => {
  const original = document("PRIVATE-RESEARCH"), indexed = indexedRetrievalDocument(original), parent = candidate(indexed);
  for (const documents of [[], [{ ...original, visibility:"private" }], [{ ...original, visibility:"trashed" }]]) {
    const result = materializeRetrievalCandidates([{ ...parent, content:"STALE-TRANSPORT-CONTENT" }],
      { corpus_revision:"changed", documents }, "research");
    assert(result.every(item => !item.content));
    assert(!JSON.stringify(result).includes("PRIVATE-RESEARCH"));
    assert(!JSON.stringify(result).includes("STALE-TRANSPORT-CONTENT"));
  }
  assert.equal(retrievalDocumentForSource({ documents:[original] }, parent.sourceId, parent.sourceRevision, "incorrect"), undefined);
});

test("candidate exhaustion never injects orphaned heading or shared-condition dependencies", () => {
  const body = "# Research\n\nConditions: not approved.\n\n## Background\n\n"
    + "Unrelated.\n\n".repeat(15000) + "## Configuration\n\nConcurrency 32; CPU-only.\n\n## Results\n\np99 latency 125 ms.\n\n## Additional results\n\np99 latency 126 ms.\n";
  const documents = Array.from({ length:20 }, (_, index) => ({ ...document(body), source_id:`source-${index}` }));
  const parents = documents.map(item => candidate(indexedRetrievalDocument(item)));
  const candidates = materializeRetrievalCandidates(parents, { documents }, "p99 latency");
  assert(candidates.length <= 100);
  assert(candidates.some(item => item.reason.includes("100-candidate")));
  for (const evidence of candidates.filter(item => item.content?.includes("125 ms"))) {
    assert(passageReferenceGroup(evidence, candidates).length > 1);
  }
});

test("large cached RST sources materialize tail evidence and retain validated parent dependencies", () => {
  const body = "==========\r\nExperiment\r\n==========\r\n\r\nOnly CPU; do not deploy.\r\n\r\n" +
    "Conditions\r\n----------\r\n\r\nConcurrency=32, version=v2; all latency in ms.\r\n\r\n" +
    "Background\r\n----------\r\n\r\n" + "Unrelated explanation.\r\n".repeat(10000) +
    "\r\nResults\r\n-------\r\n\r\nbeta p99 latency 125.\r\n";
  const source = { ...document(body), content_type:"subscription", title:"benchmark.rst",
    source_uri:"pkm://subscriptions/node/share/notes/benchmark.rst", read_only:true };
  const snapshot = { corpus_revision:"rst", documents:[source] };
  const indexed = indexedRetrievalDocument(source), hit = candidate(indexed);
  const result = materializeRetrievalCandidates([hit], snapshot, "beta p99");
  const evidence = result.find(item => item.content?.includes("beta p99"));
  assert(evidence && evidence.range.start > 160000);
  const group = passageReferenceGroup(evidence, result);
  assert(group.some(item => item.content.includes("Only CPU; do not deploy.")));
  assert(group.some(item => item.content.includes("Concurrency=32, version=v2; all latency in ms.")));
  const validation = retrievalSourceValidation(() => snapshot);
  validation.admit(hit, indexed); validation.refreshSourceValidation();
  for (const item of group) {
    assert.equal(item.content, body.slice(item.range.start, item.range.end));
    assert.equal(validation.sourceIsCurrent(item), true);
  }
  assert.equal(sanitizeRetrievalCandidatesV1(result).incomplete, false);
});
