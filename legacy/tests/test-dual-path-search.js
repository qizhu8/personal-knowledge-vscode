const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compileRetrievalQueryV1, compileRetrievalResultV1 } = require('../dist/retrieval/retrieval-contracts');
const { RetrievalWorkerManager } = require('../dist/retrieval/retrieval-worker');
const { panelSearchTarget } = require('../dist/retrieval/panel-search');
const filestore = require('../dist/knowledge/filestore');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('panel search opens a categorized Skill by canonical name, never its retrieval path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkm-panel-search-'));
  const previousStore = filestore.getStorePath();
  try {
    filestore.setStorePath(root);
    filestore.skillUpsert({ name: 'dlis-falcon-deployment-automation',
      category: 'General/DLIS/Falcon/deployment', content: 'DLIS Falcon deployment procedure.' });
    filestore.skillUpsert({ name: 'unrelated', category: 'Elsewhere', content: 'Other DLIS material.' });
    const item = filestore.skillGet('dlis-falcon-deployment-automation');
    const inventory = [{ area: 'skills', relativePath: 'General/DLIS/Falcon/deployment/dlis-falcon-deployment-automation.md',
      slug: 'General/DLIS/Falcon/deployment/dlis-falcon-deployment-automation',
      name: item.name, title: item.name, knowledgeId: item.knowledgeId }];
    assert.equal(filestore.skillGet(inventory[0].slug), null, 'reproduce the old path/name mismatch');
    for (const uri of [`pkm://knowledge/${item.knowledgeId}`,
      'pkm://skills/General/DLIS/Falcon/deployment/dlis-falcon-deployment-automation']) {
      const target = panelSearchTarget(uri, inventory);
      assert.equal(target.openTarget.key, item.name);
      assert.equal(target.openTarget.type, 'skill');
      assert.equal(target.category, item.category);
      assert.equal(filestore.skillGet(target.openTarget.key).content, 'DLIS Falcon deployment procedure.');
    }
    assert.deepEqual(filestore.skillSearch('dlis falcon').map(row => row.name), [item.name],
      'default literal filtering excludes a source matching only one token');
    assert.throws(() => panelSearchTarget(`pkm://knowledge/${item.knowledgeId}`, []), /not found/);
    assert.throws(() => panelSearchTarget(`pkm://knowledge/${item.knowledgeId}`, [...inventory, ...inventory]), /duplicated/);
    assert.throws(() => panelSearchTarget(`pkm://knowledge/${item.knowledgeId}`,
      [...inventory, { ...inventory[0], knowledgeId: 'knowledge_ffffffffffffffffffffffff', relativePath: 'Other/duplicate.md' }]),
      /no unique target/, 'a duplicate public name cannot silently open a different Skill');
  } finally {
    filestore.setStorePath(previousStore);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('panel search uses current Notes, Scripts, Research and subscription identities', () => {
  const inventory = [
    { area: 'notes', relativePath: 'Moved/note.md', slug: 'Moved/note', title: 'Title',
      knowledgeId: 'knowledge_0123456789abcdef01234567' },
    { area: 'papers', relativePath: 'papers/paper.md', slug: 'papers/paper', title: 'Paper' },
    { area: 'scripts', relativePath: 'S/tool.py', slug: 'S/tool.py', title: 'tool.py',
      knowledgeId: 'script_test' },
  ];
  assert.deepEqual(panelSearchTarget('pkm://knowledge/knowledge_0123456789abcdef01234567', inventory).openTarget,
    { type: 'note', key: 'Moved/note' });
  assert.deepEqual(panelSearchTarget('pkm://papers/papers/paper', inventory).openTarget,
    { type: 'paper', key: 'papers/paper' });
  assert.deepEqual(panelSearchTarget('pkm://script/script_test', inventory).openTarget,
    { type: 'script', key: 'S/tool.py' });
  const groups = [{ nodeId: 'node', shareId: 'share', alias: 'Broker', items: [{
    key: 'cached-key', type: 'skills', title: 'Remote', path: 'DLIS/remote.md',
    pkmPath: 'pkm://subscriptions/node/share/skills/DLIS/remote.md',
  }] }];
  const remote = panelSearchTarget(groups[0].items[0].pkmPath, [], groups);
  assert.deepEqual(remote.openTarget, { type: 'subscriptionItem', key: 'cached-key' });
  assert.equal(remote.category, 'Subscriptions/Broker/DLIS');
});

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
