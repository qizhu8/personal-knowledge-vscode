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

test("medium-sized sources are structurally refined before materialization", () => {
  const body = "# Benchmark\n\nConditions: CPU-only; not approved.\n\n## Background\n\n"
    + "Unrelated material.\n\n".repeat(300)
    + "## Results\n\nDo not deploy: p99 latency is 125 ms.\n";
  assert(body.length > 4_000 && body.length < 160_000);
  const source = document(body), indexed = indexedRetrievalDocument(source), parent = candidate(indexed);
  const candidates = materializeRetrievalCandidates([parent], { documents:[source] }, "latency deploy");
  assert.equal(candidates[0].content, undefined, "The complete source is not sent just because it is below the transport ceiling");
  const evidence = candidates.find(item => item.content?.includes("125 ms"));
  assert(evidence);
  assert(evidence.range.start > 4_000);
  assert.equal(evidence.content, body.slice(evidence.range.start, evidence.range.end));
  assert(passageReferenceGroup(evidence, candidates).some(item => item.content.includes("CPU-only; not approved.")));
  const materialized = candidates.filter(item => item.content);
  assert(materialized.every(item => item.content.length <= 4_000), "Each materialized range stays within the structural-unit bound");
  const injectedUtf8ByteUpperBound = materialized.reduce((total, item) => total + Buffer.byteLength(item.content, "utf8"), 0);
  assert(injectedUtf8ByteUpperBound < 8_000, `Fixture evidence must fit below the 8,000-byte token upper bound; got ${injectedUtf8ByteUpperBound}`);
  assert(materialized.length <= 16, "Candidate count remains below the per-source structural candidate boundary");
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

test("large declared JSON materialization uses current source metadata and fails closed on malformed bodies", () => {
  for (const [title, sourceUri] of [
    ["policy.json", "pkm://knowledge/research"],
    ["Policy", "file:///policy.json?revision=7"],
  ]) {
    const body = '{invalid JSON\n\n' + "Unrelated explanation.\n\n".repeat(10000) + "latency must not exceed 125 ms.\n";
    const source = { ...document(body), title, source_uri:sourceUri };
    const indexed = indexedRetrievalDocument(source), hit = { ...candidate(indexed), label:"misleading.md" };
    const result = materializeRetrievalCandidates([hit], { documents:[source] }, "latency");
    assert.equal(result.length, 1);
    assert.equal(result[0].content, undefined);
    assert.equal(result[0].label, title, "Verified document metadata determines the source format");
    assert.match(result[0].reason, /invalid JSON/);
    assert(!result[0].reason.includes("falling back"));
  }
});

test("large valid JSON sources retain exact tail records and current shared conditions despite stale provider labels", () => {
  const body = JSON.stringify({ approved:false, unit:"ms", records:[
    ...Array.from({length:12000}, () => ({unrelated:"background"})),
    {latency:125, policy:"never deploy"},
  ] });
  let snapshot = { documents:[{ ...document(body), title:"policy.json", content_type:"script" }] };
  const indexed = indexedRetrievalDocument(snapshot.documents[0]), hit = { ...candidate(indexed), label:"misleading.csv" };
  const result = materializeRetrievalCandidates([hit], snapshot, "latency");
  const evidence = result.find(item => item.content?.includes('"latency":125'));
  assert(evidence && evidence.range.start > 160000);
  const group = passageReferenceGroup(evidence, result);
  assert(group.some(item => item.content === '"approved":false'));
  assert(group.some(item => item.content === '"unit":"ms"'));
  for (const item of group) assert.equal(item.content, body.slice(item.range.start, item.range.end));
  const validation = retrievalSourceValidation(() => snapshot);
  validation.admit(hit, indexed); validation.refreshSourceValidation();
  assert(validation.sourceIsCurrent(evidence));
  snapshot = { documents:[{ ...snapshot.documents[0], title:"policy.md" }] };
  validation.refreshSourceValidation();
  assert.equal(validation.sourceIsCurrent(evidence), false, "A source format change invalidates the old passage");
  assert.equal(sanitizeRetrievalCandidatesV1(result).incomplete, false);
});

test("source metadata outside label boundaries fails explicitly without injecting invalid candidates", () => {
  for (const title of ["", "x".repeat(513)]) {
    const source = { ...document("latency must not exceed 125 ms."), title };
    const indexed = indexedRetrievalDocument(source), hit = { ...candidate(indexed), label:"Provider display title" };
    const result = materializeRetrievalCandidates([hit], { documents:[source] }, "latency");
    assert.equal(result[0].content, undefined);
    assert.match(result[0].reason, /source title.*boundary|source title.*empty/);
    assert.equal(sanitizeRetrievalCandidatesV1(result).incomplete, false);
  }
});

test("large JSON with multiple shared arrays never materializes an unqualified record", () => {
  const body = JSON.stringify({ conditions:["never deploy", "all latency in ms"], records:[
    { unrelated:"background".repeat(17000) }, { latency:125 },
  ] });
  const source = { ...document(body), title:"policy.json" };
  const indexed = indexedRetrievalDocument(source), hit = candidate(indexed);
  const result = materializeRetrievalCandidates([hit], { documents:[source] }, "latency");
  assert.equal(result.length, 1);
  assert.equal(result[0].content, undefined);
  assert.match(result[0].reason, /not truncated/);
});

test("large code materialization keeps module preamble dependencies and invalidates changed conditions", () => {
  const preamble = '"""Only CPU; do not deploy. All measurements in ms."""\r\nfrom settings import UNIT\r\nMAXIMUM = 125\r\n\r\n';
  const body = preamble + "def other():\n    return 0\n".repeat(10000) + "def p99_latency():\n    return MAXIMUM\n";
  let snapshot = { documents:[{ ...document(body), title:"benchmark.py", content_type:"script" }] };
  const indexed = indexedRetrievalDocument(snapshot.documents[0]), hit = { ...candidate(indexed), label:"misleading.csv" };
  const result = materializeRetrievalCandidates([hit], snapshot, "p99_latency");
  const evidence = result.find(item => item.content?.includes("def p99_latency"));
  assert(evidence && evidence.range.start > 160000);
  const group = passageReferenceGroup(evidence, result);
  assert(group.some(item => item.content === preamble));
  const validation = retrievalSourceValidation(() => snapshot);
  validation.admit(hit, indexed); validation.refreshSourceValidation();
  for (const item of group) {
    assert.equal(item.content, body.slice(item.range.start, item.range.end));
    assert.equal(validation.sourceIsCurrent(item), true);
  }
  snapshot = { documents:[{ ...snapshot.documents[0], body:body.replace("measurements in ms", "measurements in seconds") }] };
  validation.refreshSourceValidation();
  assert.equal(validation.sourceIsCurrent(evidence), false);
  assert.equal(sanitizeRetrievalCandidatesV1(result).incomplete, false);
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

test("large CSV/TSV materialization reaches original tail records with current mandatory headers", () => {
  for (const [extension, delimiter] of [["csv", ","], ["tsv", "\t"]]) {
    const header = `entity${delimiter}p99 limit (ms)\r\n`;
    const tail = `"latency\r\nnot approved"${delimiter}125\r\n`;
    const body = header + `unrelated${delimiter}0\r\n`.repeat(20000) + tail;
    const source = { ...document(body), title:`benchmarks.${extension}`, content_type:"script" };
    let snapshot = { corpus_revision:"table", documents:[source] };
    const indexed = indexedRetrievalDocument(source), hit = candidate(indexed);
    const result = materializeRetrievalCandidates([hit], snapshot, "latency");
    assert.equal(result[0].content, undefined);
    const evidence = result.find(item => item.content === tail);
    assert(evidence && evidence.range.start > 160000);
    const group = passageReferenceGroup(evidence, result);
    assert(group.some(item => item.content === header));
    const validation = retrievalSourceValidation(() => snapshot);
    validation.admit(hit, indexed); validation.refreshSourceValidation();
    for (const item of group) {
      assert.equal(item.content, body.slice(item.range.start, item.range.end));
      assert.equal(validation.sourceIsCurrent(item), true);
    }
    assert.equal(sanitizeRetrievalCandidatesV1(result).incomplete, false);
    snapshot = { ...snapshot, documents:[{ ...source, body:body.replace("limit (ms)", "limit (seconds)") }] };
    validation.refreshSourceValidation();
    for (const item of group) assert.equal(validation.sourceIsCurrent(item), false);
  }
});
