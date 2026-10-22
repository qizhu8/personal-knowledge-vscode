const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compileRetrievalQueryV1, compileRetrievalResultV1 } = require('../dist/retrieval/retrieval-contracts');
const { RetrievalWorkerManager } = require('../dist/retrieval/retrieval-worker');

test('BR-13: normalized worker contract preserves dual evidence and rejects raw-score addition or false labels', async () => {
  const query = { schema: 'pkm.retrieval.query/v1', requestId: 'dual-test', text: 'networks', route: 'dual',
    scope: { capabilityId: 'test' }, topK: 10, generation: { mode: 'latest-ready' }, diagnostics: 'summary' };
  assert(compileRetrievalQueryV1(query).ok);
  const manager = new RetrievalWorkerManager('/unused-br13-state', '/unused-script', '/unused-python', 'test');
  manager.status = async () => ({ ready_generation: 1, engine_version: 'test' });
  manager.ensure = async () => ({});
  manager.request = async () => ({ ok: true, request_id: query.requestId, ready_generation: 1, corpus_revision: 'rev', route: 'dual',
    search_mode: 'dual', semantic_status: 'ready', semantic_reason: '', skill_serving: { used: true, release_id: 'existing-model' },
    solution: { package_id: 'existing-model', reason: 'served' },
    hits: [{ source_id: 'pkm://notes/networks', source_revision: 'r1', content_hash: 'a'.repeat(64), content_type: 'note',
      source_uri: 'pkm://notes/networks', rank: 1, score: 1 / 61 + 1 / 62, score_semantics: 'rrf',
      sources: ['lexical', 'semantic'], source_label: 'both', contributing_routes: ['lexical', 'semantic'],
      path_evidence: [
        { path: 'lexical', rank: 1, score: 500, match: 'keyword', matched_field: 'title', matched_path: 'pkm://notes/networks' },
        { path: 'semantic', rank: 2, score: .0001, match: 'semantic', matched_field: 'embedding-index', matched_path: 'pkm://notes/networks' },
      ], score_components: { lexical: 500, semantic: .0001, graph: 0, priority: 1 },
      title: 'Networks', description: '', metadata: {}, provenance: {} }] });
  const result = await manager.query(query);
  assert.equal(result.hits[0].serving.scoreSemantics, 'rrf');
  assert.equal(result.hits[0].source_label, 'both');
  assert.equal(result.hits[0].path_evidence[1].score, .0001);
  assert(compileRetrievalResultV1(result).ok);
  for (const patch of [ { score: 500.0001 }, { source_label: 'from keyword search' },
    { path_evidence: [{ ...result.hits[0].path_evidence[0], score: Infinity }, result.hits[0].path_evidence[1]] },
    { sources: ['lexical', 'lexical'] } ]) {
    assert.equal(compileRetrievalResultV1({ ...result, hits: [{ ...result.hits[0], ...patch }] }).ok, false);
  }
  assert.equal(compileRetrievalResultV1({ ...result, semantic_status: 'silently-degraded' }).ok, false);
  assert.equal(compileRetrievalResultV1({ ...result, search_mode: 'lexical' }).ok, false);
});
