// BR-13 search begin
// L1 search uses the same worker contract as Chat/MCP, not a second model provider.
let knowledgeSearchSequence = 0;
let knowledgeSearchActive = false;
let knowledgeSearchText = '';
let knowledgeSearchRequestedMode = 'lexical';
const knowledgeSearchTypes = { skills: 'skill', notes: 'note', papers: 'research', scripts: 'script' };
const knowledgeSearchMode = document.createElement('select');
knowledgeSearchMode.id = 'knowledge-search-mode';
knowledgeSearchMode.setAttribute('aria-label', 'Search mode');
knowledgeSearchMode.title = 'Filter files: literal text, case and regex in the file tree. Keyword retrieval: ranked BM25 candidates. Semantic: configured model. Dual: rank fusion.';
knowledgeSearchMode.innerHTML = '<option value="filter">Filter files</option><option value="lexical">Keyword retrieval</option><option value="semantic">Semantic</option><option value="dual">Dual</option>';
document.getElementById('content-find-control').after(knowledgeSearchMode);
const knowledgeSearchResults = document.createElement('section');
knowledgeSearchResults.id = 'knowledge-search-results';
knowledgeSearchResults.hidden = true;
knowledgeSearchResults.style.cssText = 'overflow:auto;flex:1;padding:8px';
knowledgeSearchResults.setAttribute('aria-label', 'Search results and retrieval status');
document.getElementById('item-list').before(knowledgeSearchResults);
knowledgeSearchMode.addEventListener('change', () => contentSearchChanged(true));

function knowledgeSearchMarkup(result) {
  const status = result.semantic_status || 'unavailable';
  const reason = result.semantic_reason || '';
  const hits = (result.hits || []).map((hit, index) => ({ ...hit, searchIndex: index }));
  const tree = buildCatTree(hits, hit => hit.category, '(uncategorized)');
  const rows = renderCatTree(tree, [], 0, (hit, depth) => {
    const index = hit.searchIndex;
    const label = hit.source_label === 'both' ? 'both · keyword search + embedding retrieval'
      : hit.source_label || 'Source evidence unavailable';
    const evidence = (hit.path_evidence || []).map(entry =>
      `${entry.path}: rank ${entry.rank}, raw score ${entry.score}, ${entry.match} · ${entry.matched_field} · ${entry.matched_path}`).join('\n');
    return `<div class="li" style="padding-left:${8 + (depth + 1) * 12}px"><button class="tbtn knowledge-search-hit" type="button" data-search-hit="${index}" ${hit.openTarget ? '' : 'disabled'}>${esc(hit.title || hit.sourceId || hit.source_id)}</button>
      ${hit.openTarget ? '' : `<div role="alert">${esc(hit.open_error || 'Cannot open: source identity unavailable. Refresh the index.')}</div>`}
      <details><summary>Retrieval evidence</summary><div class="meta">${esc(label)}</div><div>${esc(hit.displayPath || '')}</div><pre style="white-space:pre-wrap">${esc(evidence)}</pre></details></div>`;
  }, state.search, null, null, { area: 'search', readOnly: true, githubSyncType: 'search' });
  return `<p role="status">Mode: ${esc(result.search_mode || knowledgeSearchMode.value)} · Semantic: ${esc(status)}${reason ? ` — ${esc(reason)}` : ''}</p>${result.ok === false ? '<p>Search unavailable. No results were substituted.</p>' : rows || '<p>No matching sources.</p>'}${result.incomplete ? '<p>Results are incomplete or capped at the retrieval limit.</p>' : ''}`;
}

function requestKnowledgeSearch(options) {
  const supported = !!knowledgeSearchTypes[state.tab];
  knowledgeSearchMode.hidden = !supported;
  knowledgeSearchSequence++;
  knowledgeSearchActive = supported && !!state.search && knowledgeSearchMode.value !== 'filter' && !options.regex && !options.caseSensitive;
  knowledgeSearchResults.hidden = !knowledgeSearchActive;
  document.getElementById('item-list').hidden = knowledgeSearchActive;
  if (!knowledgeSearchActive) return false;
  knowledgeSearchText = state.search;
  knowledgeSearchRequestedMode = knowledgeSearchMode.value;
  knowledgeSearchResults.textContent = `Searching (${knowledgeSearchMode.value})…`;
  ask('knowledgeSearch', { tab: state.tab, q: state.search, mode: knowledgeSearchMode.value,
    requestId: `panel-search-${knowledgeSearchSequence}` });
  return true;
}

window.addEventListener('message', event => {
  const message = event.data;
  if (message.command !== 'knowledgeSearch' || !knowledgeSearchActive || message.tab !== state.tab
    || state.search !== knowledgeSearchText || knowledgeSearchMode.value !== knowledgeSearchRequestedMode
    || message.requestId !== `panel-search-${knowledgeSearchSequence}`) return;
  knowledgeSearchResults.innerHTML = knowledgeSearchMarkup(message.data);
  knowledgeSearchResults.querySelectorAll('[data-search-hit]').forEach(button => {
    button.addEventListener('click', () => {
      const hit = message.data.hits[Number(button.dataset.searchHit)];
      if (!hit.openTarget) return;
      knowledgeSearchResults.querySelectorAll('.li.active').forEach(row => row.classList.remove('active'));
      button.closest('.li')?.classList.add('active');
      requestDetail(hit.openTarget.type, hit.openTarget.key);
    });
  });
});
// Tab changes invalidate pending results before the existing list machinery runs.
document.querySelectorAll('.tab[data-tab]').forEach(tab => tab.addEventListener('click', () => {
  knowledgeSearchSequence++;
  knowledgeSearchActive = false;
  knowledgeSearchResults.hidden = true;
  document.getElementById('item-list').hidden = false;
  knowledgeSearchMode.hidden = !knowledgeSearchTypes[tab.dataset.tab];
}));
// BR-13 search end
