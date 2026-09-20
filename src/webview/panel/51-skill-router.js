const skillRouterBenchmarks = [
  { profile: 'copilot_default', name: 'Copilot default search', detail: 'Comparison baseline · benchmark adapter not implemented', state: 'Not measured' },
  { profile: 'l1_exact', name: 'Exact only', detail: 'Evaluation candidate · separate serving path not implemented', state: 'Not measured' },
  { profile: 'l1_online', name: 'Exact + BM25', detail: 'Current production engine', state: 'Serving' },
  { profile: 'l1_weighted', name: 'Hybrid', detail: 'Model-based path temporarily disabled', state: 'Disabled' },
];

const skillRouterParameterDetails = {
  embedding: ['Embedding', 'Frozen local model', 'Model tensors are never trained by PKM.'],
  retrieval: ['Retrieval', 'Trainable coordination', 'Coordinates the importance of Exact, BM25, and optional embedding sources.'],
  calibration: ['Calibration', 'Trainable coordination', 'Calibrates source confidence and the serving decision threshold.'],
  ranker: ['Ranker', 'Trainable coordination', 'Coordinates source and result ordering after calibration.'],
  results: ['Results', 'Derived output', 'The ranked result set returned by the active engine.'],
};

function renderSkillRouterLoading() {
  document.getElementById('detail').innerHTML = '<div class="empty">Loading Skill Router…</div>';
}

function skillRouterStatusBadge(label, tone) {
  return `<span class="sr-status sr-status-${tone}"><i></i>${esc(label)}</span>`;
}

function renderSkillRouterPane(data) {
  const active = String(data?.activeProfile || 'l1_online');
  const runtime = data?.runtime || {};
  const corpus = data?.corpus || {};
  const collector = data?.collector || {};
  const solutions = data?.solutions || {};
  const rows = skillRouterBenchmarks.map(item => {
    const serving = item.profile === active;
    const solution = solutions[item.profile] || {};
    const toggle = solution.externallyServed
      ? `<span class="sr-status sr-status-good"><i></i>Required fallback</span>`
      : solution.available && solution.mature
      ? `<label class="sr-solution-toggle"><input type="checkbox" ${solution.enabled ? 'checked' : ''} onchange="skillRouterToggleSolution('${item.profile}',this.checked)"><span>${solution.enabled ? 'Enabled' : 'Disabled'}</span></label>`
      : skillRouterStatusBadge(solution.systemDisabled ? 'System disabled' : item.state, 'warn');
    return `<tr class="${serving ? 'selected' : ''}" data-sr-profile="${item.profile}">
      <td><span class="sr-route-name"><span><strong>${esc(item.name)}</strong><small>${esc(item.detail)}</small></span></span></td>
      <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
      <td><div class="sr-solution-state">${serving ? skillRouterStatusBadge('Serving', 'good') : ''}${toggle}</div></td>
    </tr>`;
  }).join('');
  document.getElementById('detail').innerHTML = `<div class="sr-dashboard">
    <header class="sr-head"><div><h2>Skill Router</h2><p>Inspect the implemented retrieval engine and the evaluation surfaces required before adding another path.</p></div><button class="tbtn" onclick="ask('skillRouterStatus',{})">Refresh</button></header>
    <div class="sr-contract current"><strong>Automatic fallback: ${active === 'l1_online' ? 'Exact + BM25 → Copilot default' : 'Copilot default'}.</strong><span>Disable or enable any mature solution below. If every PKM solution is disabled or unavailable, the router falls back automatically. Model-based Hybrid remains system-disabled until its engine matures.</span></div>
    <section class="sr-section"><div class="sr-section-head"><div><h3>Routing path performance</h3><p>No benchmark has been imported. Metrics remain empty until every path runs on the same judged set.</p></div><div><span>Active: <strong>${esc(active)}</strong></span></div></div><div class="sr-table-wrap"><table class="sr-table"><thead><tr><th>Routing path</th><th>Success rate</th><th>NDCG@5</th><th>Recall@1</th><th>Recall@5</th><th>Tokens saved</th><th>Latency</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></section>
    <section class="sr-section"><div class="sr-section-head"><div><h3>Proposed Parameter Map</h3><p>Planned coordination surface. Model-based routing and online learning are disabled.</p></div>${skillRouterStatusBadge('Disabled', 'warn')}</div><div class="sr-parameter-layout"><div class="sr-parameter-map">${['embedding','retrieval','calibration','ranker','results'].map((id, index) => `${index ? '<span aria-hidden="true">→</span>' : ''}<button class="sr-parameter-node ${id === 'embedding' ? 'frozen' : id === 'results' ? 'output' : 'trainable'}" onclick="skillRouterInspectParameter('${id}',this)"><strong>${skillRouterParameterDetails[id][0]}</strong><small>${id === 'embedding' ? 'Disabled model' : id === 'results' ? 'Derived output' : 'Proposed coordinator'}</small></button>`).join('')}</div><aside class="sr-inspector" id="sr-inspector"><h4>Retrieval</h4><span>Proposed coordinator</span><p>${skillRouterParameterDetails.retrieval[2]}</p></aside></div></section>
    <section class="sr-privacy-declaration" aria-labelledby="sr-privacy-title"><div class="sr-privacy-mark" aria-hidden="true">P</div><div><h3 id="sr-privacy-title">Skill Router privacy statement</h3><p>Raw query and task text, workspace paths, file names, diagnostics, and loaded knowledge content are excluded from collector events. Search events contain only the tool name, duration, success state, result count, hashed result identities, and active routes. PKM does not train or modify embedding-model weights.</p><p>When you explicitly call <code>skill_feedback</code>, the observations and evidence you provide are stored locally under <code>_feedback/skill-usage.jsonl</code>; that text is not forwarded to the collector. Your configured knowledge is indexed by the local retrieval worker.</p><p class="sr-privacy-proof">This implementation is open source and reviewable at <a href="https://github.com/qizhu8/personal-knowledge-vscode">github.com/qizhu8/personal-knowledge-vscode</a>.</p></div></section>
    <section class="sr-section"><div class="sr-section-head"><div><h3>Search data collector</h3><p>Collects search-function outcomes, never search text.</p></div>${skillRouterStatusBadge('Query-free', 'good')}</div><ul class="sr-boundary"><li><b>Collected</b><span>Tool name, duration, success, result count, hashed result identities, and active routes.</span></li><li><b>PKM tools</b><span>${(collector.collectedTools || []).map(esc).join(' · ') || 'Not reported'}</span></li><li><b>Unavailable</b><span>VS Code built-in tool_search and grep_search do not expose invocation events to this extension.</span></li></ul></section>
    <div class="sr-lower-grid"><section class="sr-section"><div class="sr-section-head"><div><h3>Runtime</h3><p>Current local retrieval worker and indexed corpus.</p></div>${skillRouterStatusBadge(runtime.ready ? 'Ready' : 'Unavailable', runtime.ready ? 'good' : 'warn')}</div><dl class="sr-facts"><div><dt>Documents</dt><dd>${Number(corpus.documentCount || runtime.documentCount || 0).toLocaleString()}</dd></div><div><dt>Corpus revision</dt><dd><code>${esc(String(corpus.revision || runtime.corpusRevision || 'Not ready').slice(0, 12))}</code></dd></div><div><dt>Engine</dt><dd>${esc(runtime.engineVersion || 'Not running')}</dd></div><div><dt>Configuration</dt><dd><code>${esc(String(runtime.configurationHash || '').slice(0, 12) || 'Not available')}</code></dd></div></dl>${runtime.error ? `<p class="sr-runtime-error">${esc(runtime.error)}</p>` : ''}</section>
      <section class="sr-section"><div class="sr-section-head"><div><h3>Privacy boundary</h3><p>Current retrieval behavior.</p></div>${skillRouterStatusBadge('Local index', 'good')}</div><ul class="sr-boundary"><li><b>Index</b><span>PKM builds a local Exact + BM25 index over configured knowledge.</span></li><li><b>Collector</b><span>Task identity is hashed; only aggregate retrieval and outcome fields are emitted.</span></li><li><b>Training</b><span>No parameter training or embedding-model modification is active.</span></li></ul></section></div>
  </div>`;
}

function skillRouterInspectParameter(id, button) {
  const detail = skillRouterParameterDetails[id];
  if (!detail) return;
  document.querySelectorAll('.sr-parameter-node').forEach(node => node.classList.toggle('active', node === button));
  document.getElementById('sr-inspector').innerHTML = `<h4>${esc(detail[0])}</h4><span>${esc(detail[1])}</span><p>${esc(detail[2])}</p>`;
}

function skillRouterToggleSolution(solution, enabled) {
  ask('setSkillRouterSolutionEnabled', { solution, enabled });
}
