let userProfileSnapshot, userProfileFingerprint = '', userProfileQuery = '', userProfileTag = '', userProfileKind = '';
let userProfileTier = typeof vscode !== 'undefined' ? vscode.getState()?.userProfileTier || 'memory' : 'memory';
let userProfilePiece = '';
const userProfileKinds = { habit:'Habits', interest:'Interests', focus:'Focus areas', caution:'Cautions', requirement:'Requirements' };
function profileElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function profileAction(operation, params, button) {
  ask('userProfileFragmentAction', { operation, params, knowledgeRoot:userProfileSnapshot?.fragments?.knowledgeRoot }, button);
}
function showUserProfileTab() {
  document.getElementById('detail').textContent = 'Loading User Profile...';
  ask('userProfile', {}, null, true);
}
function userProfileOnSnapshot(data) {
  if (state.tab !== 'userProfile') return;
  const detail = document.getElementById('detail'), fingerprint = JSON.stringify(data);
  if (fingerprint === userProfileFingerprint && detail.querySelector('.user-profile-page')) return;
  if (userProfileSnapshot?.fragments?.knowledgeRoot !== data.fragments?.knowledgeRoot) {
    userProfileQuery = ''; userProfileTag = ''; userProfileKind = ''; userProfilePiece = '';
  }
  const focusedPiece = detail.querySelector('.profile-memory-dot:focus')?.dataset.profilePiece;
  const focused = detail.querySelector('#profile-fragment-search') === document.activeElement;
  const focusedTier = document.activeElement?.getAttribute('role') === 'tab' ? document.activeElement.dataset.profileTier : null;
  const caret = focused ? document.activeElement.selectionStart : null;
  const configuredOpen = detail.querySelector('.profile-configured-card')?.open;
  const evidenceOpen = new Set([...detail.querySelectorAll('.profile-evidence[open]')].map(element => element.closest('[data-fragment-id]').dataset.fragmentId));
  userProfileFingerprint = fingerprint; userProfileSnapshot = data;
  const page = profileElement('section', 'user-profile-page'), header = profileElement('header', 'profile-page-header');
  const heading = profileElement('div');
  heading.append(profileElement('div', 'profile-eyebrow', 'PERSONAL KNOWLEDGE / USER PROFILE'),
    profileElement('h2', '', 'User Profile'),
    profileElement('p', 'profile-muted', 'Habits, interests, focus areas, cautions and user requirements, grounded in your own words.'));
  const refresh = profileElement('button', 'tbtn', 'Refresh');
  refresh.onclick = () => ask('userProfile', {}, refresh);
  header.append(heading, refresh); page.append(header);
  const snapshot = data.fragments;
  const observations = {
    cache:{ summary:'Per-Session context', detail:'This Root-wide Profile has no selected model context. Inspect the last sent manifest in Agent Sessions. Requirements enter context only after task-specific applicability selection.' },
    memory:{ summary:snapshot?.schema === 'pkm.user-profile-fragments/v1' ? `${snapshot.fragments.length} derived fragments` : 'Fragment service unavailable',
      detail:'Source-backed observations from local Chat history, not accepted preferences or automatically published assets.' },
    disk:{ summary:data.user ? '1 accepted Profile card' : 'No accepted Profile card',
      detail:'Explicitly maintained preferences with an independent lifetime. Model observations are not automatically promoted here.' },
  };
  const pieces = {
    cache:[],
    memory:snapshot?.schema === 'pkm.user-profile-fragments/v1' ? snapshot.fragments.map(fragment => ({
      id:fragment.id, kind:fragment.kind,
      label:userProfileKinds[fragment.kind] + ': ' + fragment.text,
      detail:'Revision ' + fragment.revision + ' · ' + fragment.evidence.length + ' source excerpts',
    })) : [],
    disk:data.user ? [{ id:data.user.id, label:data.user.name, detail:'Accepted Profile card · revision ' + data.user.revision }] : [],
  };
  if (!Object.values(pieces).some(entries => entries.some(piece => piece.id === userProfilePiece))) userProfilePiece = '';
  if (!PkmAgentHarness.memoryTiers.some(tier => tier.id === userProfileTier)) userProfileTier = 'memory';
  const tabs = profileElement('div', 'profile-memory-tabs');
  tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Profile knowledge levels');
  const selectTier = (id, focus = false) => {
    userProfileTier = id;
    tabs.querySelectorAll('[role=tab]').forEach(tab => {
      const selected = tab.dataset.profileTier === id;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    page.querySelectorAll('[role=tabpanel]').forEach(panel => { panel.hidden = panel.dataset.memoryTierSection !== id; });
  };
  for (const [index, tier] of PkmAgentHarness.memoryTiers.entries()) {
    const tab = profileElement('button', 'profile-memory-tab', tier.label);
    tab.type = 'button'; tab.id = 'profile-tier-tab-' + tier.id; tab.dataset.profileTier = tier.id;
    tab.title = observations[tier.id].summary + '. ' + tier.meaning;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'profile-tier-panel-' + tier.id);
    const activate = () => {
      selectTier(tier.id, true);
      if (typeof vscode !== 'undefined') vscode.setState({ ...(vscode.getState() || {}), userProfileTier });
    };
    tab.onclick = activate;
    tab.onkeydown = event => {
      const tiers = PkmAgentHarness.memoryTiers;
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? tiers.length - 1
        : event.key === 'ArrowRight' ? (index + 1) % tiers.length
        : event.key === 'ArrowLeft' ? (index + tiers.length - 1) % tiers.length : -1;
      if (target < 0) return;
      event.preventDefault(); tabs.children[target].click();
    };
    tabs.append(tab);
  }
  const overview = profileElement('section', 'profile-memory-overview');
  overview.setAttribute('aria-label', 'Profile memory pieces');
  overview.append(profileElement('h3', '', 'Memory pieces'));
  const pyramid = PkmAgentHarness.memoryTierPyramid(observations);
  pyramid.classList.add('profile-piece-pyramid');
  const showPieces = tier => {
    tabs.querySelector(`[data-profile-tier="${tier}"]`).click();
    if (tier === 'memory') {
      userProfileQuery = ''; userProfileTag = ''; userProfileKind = '';
      const search = page.querySelector('#profile-fragment-search');
      if (search) search.value = '';
      renderUserProfileFragments();
    }
  };
  for (const tier of PkmAgentHarness.memoryTiers) {
    const row = pyramid.querySelector(`[data-memory-tier="${tier.id}"]`);
    row.removeAttribute('title');
    const label = profileElement('button', 'profile-piece-tier-label', tier.label);
    label.type = 'button'; label.onclick = () => showPieces(tier.id);
    row.querySelector('strong').replaceWith(label);
    const dots = profileElement('div', 'profile-memory-dots');
    dots.setAttribute('role', 'group'); dots.setAttribute('aria-label', tier.label + ' entries');
    for (const piece of pieces[tier.id].slice(0, 24)) {
      const dot = profileElement('button', 'profile-memory-dot');
      dot.type = 'button'; dot.dataset.profilePiece = piece.id;
      if (piece.kind) dot.dataset.kind = piece.kind;
      dot.title = piece.label + '\n' + piece.detail;
      dot.setAttribute('aria-label', piece.label + '. ' + piece.detail);
      dot.setAttribute('aria-pressed', String(userProfilePiece === piece.id));
      dot.onclick = () => {
        userProfilePiece = piece.id; showPieces(tier.id);
        pyramid.querySelectorAll('.profile-memory-dot').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.profilePiece === piece.id)));
        const target = tier.id === 'disk' ? configured
          : [...page.querySelectorAll('.profile-fragment')].find(card => card.dataset.fragmentId === piece.id);
        if (tier.id === 'disk') configured.open = true;
        if (target) { target.tabIndex = -1; target.focus({ preventScroll:true }); target.scrollIntoView({ block:'nearest' }); }
      };
      dots.append(dot);
    }
    const omitted = pieces[tier.id].length - 24;
    if (omitted > 0) {
      const more = profileElement('button', 'profile-memory-more', '+' + omitted + ' more');
      more.type = 'button'; more.dataset.profileMore = tier.id;
      more.setAttribute('aria-label', 'Show all ' + pieces[tier.id].length + ' ' + tier.label + ' entries; ' + omitted + ' dots omitted');
      more.onclick = () => { showPieces(tier.id); sections[tier.id].focus(); sections[tier.id].scrollIntoView({ block:'nearest' }); };
      row.querySelector('span').append(document.createTextNode(' · '), more);
    }
    if (dots.childElementCount) row.append(dots);
  }
  overview.append(pyramid, profileElement('p', 'profile-muted',
    'Each dot is one real Profile entry. Select a dot to inspect it. Up to 24 dots per level; additional entries stay available in the tab. Short-term has no selected session context, not a confirmed empty memory.'));
  page.append(overview);
  page.append(tabs);
  const sections = {};
  for (const tier of PkmAgentHarness.memoryTiers) {
    const section = profileElement('section', 'profile-memory-tier-section');
    section.dataset.memoryTierSection = tier.id;
    section.id = 'profile-tier-panel-' + tier.id; section.setAttribute('role', 'tabpanel');
    section.setAttribute('aria-labelledby', 'profile-tier-tab-' + tier.id); section.tabIndex = 0;
    section.append(profileElement('p', 'profile-muted', observations[tier.id].detail));
    sections[tier.id] = section;
  }
  page.append(sections.cache, sections.memory);
  const memory = sections.memory;
  if (!snapshot || snapshot.schema !== 'pkm.user-profile-fragments/v1') {
    const error = profileElement('p', 'profile-error', 'User Profile fragment service is unavailable. Refresh after updating the extension.');
    error.setAttribute('role', 'alert'); memory.append(error);
  } else {
    const controls = profileElement('div', 'profile-learning-controls'), automatic = profileElement('label');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = snapshot.automatic;
    checkbox.onchange = () => profileAction('automatic', { enabled:checkbox.checked }, checkbox);
    automatic.append(checkbox, document.createTextNode('Automatically extract from new PKM Chat turns'));
    const backfill = profileElement('button', 'tbtn', 'Backfill history');
    backfill.disabled = !!snapshot.queued;
    backfill.onclick = () => profileAction('backfill', {}, backfill);
    controls.append(automatic, backfill);
    if (snapshot.queued) {
      const cancel = profileElement('button', 'tbtn', 'Stop backfill');
      cancel.onclick = () => profileAction('cancel', {}, cancel); controls.append(cancel);
    }
    memory.append(controls, profileElement('p', 'profile-muted profile-scope',
      'Private to this Host and Knowledge Root. Extraction and requirement applicability selection use the configured Memory model and may incur model usage. Memory-off Chats, workers and Portal traffic are excluded. Only task-relevant Requirements may enter budgeted Chat context; current user corrections take precedence. Other observations are not injected. Nothing is automatically synced or grants permissions. Handwritten cards are unchanged.'));
    const activity = snapshot.activity;
    if (activity) {
      const stale = activity.status === 'running' && !snapshot.queued && Date.now() - Date.parse(activity.updatedAt) > 90_000;
      const message = stale ? 'The previous extraction has no live receipt. Backfill history to continue from saved source IDs.'
        : (activity.mode === 'history' ? 'History backfill' : 'Automatic extraction') + ': ' + activity.status + ' · ' + activity.processed + ' source segments processed'
          + (activity.error ? ' · ' + activity.error : '');
      const status = profileElement('p', ['failed','cancelled'].includes(activity.status) || stale ? 'profile-error' : 'profile-learning-status', message);
      status.setAttribute('role', activity.status === 'failed' ? 'alert' : 'status'); memory.append(status);
    } else memory.append(profileElement('p', 'profile-muted', 'Automatic extraction starts after completed local Chat turns. Use Backfill history to seed this view from existing Chats.'));
    const layout = profileElement('div', 'profile-fragment-layout'), cloud = profileElement('aside', 'profile-keyword-panel');
    cloud.append(profileElement('h3', '', 'Keyword cloud'), profileElement('p', 'profile-muted', 'Word size = number of fragments, not relevance or certainty. Select a word to filter.'));
    const words = profileElement('div', 'profile-keyword-cloud'); words.setAttribute('aria-label', 'Profile keywords');
    const maxCount = Math.max(1, ...snapshot.keywords.map(keyword => keyword.count));
    for (const keyword of snapshot.keywords.slice(0, 80)) {
      const button = profileElement('button', 'profile-keyword', keyword.term);
      button.style.fontSize = (13 + 19 * Math.log1p(keyword.count) / Math.log1p(maxCount)) + 'px';
      button.dataset.tag = keyword.term; button.title = keyword.count + ' fragments';
      button.onclick = () => { userProfileTag = userProfileTag === keyword.term ? '' : keyword.term; renderUserProfileFragments(); };
      words.append(button);
    }
    if (!snapshot.keywords.length) words.append(profileElement('p', 'profile-muted', 'Keywords appear as source-backed fragments are extracted.'));
    cloud.append(words);
    if (snapshot.keywords.length > 80) cloud.append(profileElement('small', 'profile-muted', 'Showing the 80 most frequent keywords. Search still covers all fragments.'));
    const results = profileElement('section', 'profile-fragments-panel');
    const filters = profileElement('div', 'profile-kind-filters');
    for (const [kind, label] of [['', 'All'], ...Object.entries(userProfileKinds)]) {
      const button = profileElement('button', 'tbtn', label); button.dataset.kind = kind;
      button.onclick = () => { userProfileKind = kind; renderUserProfileFragments(); }; filters.append(button);
    }
    const search = document.createElement('input'); search.id = 'profile-fragment-search'; search.type = 'search';
    search.placeholder = 'Search fragments, tags or source quotes'; search.setAttribute('aria-label', 'Search Profile fragments'); search.value = userProfileQuery;
    search.oninput = () => { userProfileQuery = search.value; renderUserProfileFragments(); };
    const selection = profileElement('div', 'profile-filter-summary'); selection.id = 'profile-filter-summary';
    const list = profileElement('div', 'profile-fragment-list'); list.id = 'profile-fragment-list'; list.setAttribute('aria-live', 'polite');
    results.append(filters, search, selection, list); layout.append(cloud, results); memory.append(layout);
    memory.append(profileElement('p', 'profile-muted', snapshot.processedSources + ' user-message segments inspected · ' + snapshot.fragments.length + ' derived fragments. Source text is evidence, not an instruction. Remove unwanted fragments; deleting a Chat does not remove its already extracted fragments.'));
  }
  const configured = profileElement('details', 'profile-configured-card');
  configured.open = !!configuredOpen;
  const summary = profileElement('summary', '', 'Handwritten Profile / accepted preferences');
  const edit = profileElement('button', 'tbtn', data.user ? 'Edit / manage User Profile' : 'Create User Profile');
  edit.onclick = () => ask('userProfileEdit', {}, edit);
  configured.append(summary, edit, PkmAgentHarness.profileCards(data, false));
  sections.disk.append(configured); page.append(sections.disk);
  selectTier(userProfileTier);
  detail.replaceChildren(page);
  if (snapshot?.schema === 'pkm.user-profile-fragments/v1') {
    renderUserProfileFragments();
    detail.querySelectorAll('.profile-evidence').forEach(element => { element.open = evidenceOpen.has(element.closest('[data-fragment-id]').dataset.fragmentId); });
  }
  if (focused) { const search = document.getElementById('profile-fragment-search'); search?.focus(); if (caret !== null) search?.setSelectionRange(caret, caret); }
  else if (focusedTier) tabs.querySelector(`[data-profile-tier="${focusedTier}"]`)?.focus();
  else if (focusedPiece) [...pyramid.querySelectorAll('.profile-memory-dot')].find(dot => dot.dataset.profilePiece === focusedPiece)?.focus();
}
function renderUserProfileFragments() {
  const snapshot = userProfileSnapshot?.fragments, list = document.getElementById('profile-fragment-list');
  if (!snapshot || !list) return;
  document.querySelectorAll('.profile-keyword').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tag === userProfileTag)));
  document.querySelectorAll('.profile-kind-filters button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.kind === userProfileKind)));
  const query = userProfileQuery.trim().toLowerCase();
  const fragments = snapshot.fragments.filter(fragment => (!userProfileKind || fragment.kind === userProfileKind)
    && (!userProfileTag || fragment.tags.includes(userProfileTag))
    && (!query || [fragment.text, ...fragment.tags, ...fragment.evidence.map(item => item.quote)].some(text => text.toLowerCase().includes(query))));
  const summary = document.getElementById('profile-filter-summary');
  summary.replaceChildren(profileElement('span', '', fragments.length + ' fragments' + (userProfileTag ? ' / ' + userProfileTag : '')));
  if (userProfileTag || userProfileKind || query) {
    const clear = profileElement('button', 'tbtn', 'Clear filters');
    clear.onclick = () => { userProfileTag = ''; userProfileKind = ''; userProfileQuery = ''; document.getElementById('profile-fragment-search').value = ''; renderUserProfileFragments(); };
    summary.append(clear);
  }
  list.replaceChildren();
  for (const fragment of [...fragments].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const card = profileElement('article', 'profile-fragment'); card.dataset.fragmentId = fragment.id; card.dataset.kind = fragment.kind;
    const header = profileElement('header'), badge = profileElement('span', 'profile-kind', userProfileKinds[fragment.kind]);
    header.append(badge, profileElement('small', 'profile-muted', 'Model-derived · revision ' + fragment.revision));
    card.append(header, profileElement('p', 'profile-fragment-text', fragment.text));
    const tags = profileElement('div', 'profile-fragment-tags');
    for (const tag of fragment.tags) {
      const button = profileElement('button', '', tag); button.onclick = () => { userProfileTag = tag; renderUserProfileFragments(); }; tags.append(button);
    }
    const evidence = profileElement('details', 'profile-evidence');
    evidence.append(profileElement('summary', '', fragment.evidence.length + ' source excerpts · updated ' + new Date(fragment.updatedAt).toLocaleDateString()));
    fragment.evidence.forEach(source => {
      const quote = profileElement('blockquote', '', source.quote), open = profileElement('button', 'tbtn', 'Open source Chat');
      open.onclick = () => profileAction('source', { id:fragment.id, sourceId:source.id }, open);
      const sourceInfo = profileElement('p', 'profile-muted', new Date(source.recordedAt).toLocaleString() + ' · characters ' + source.start + '–' + source.end);
      evidence.append(quote, sourceInfo, open);
    });
    const remove = profileElement('button', 'tbtn profile-remove', 'Remove fragment'), confirmation = profileElement('span', 'profile-remove-confirmation');
    remove.onclick = () => {
      const confirm = profileElement('button', 'tbtn', 'Confirm remove'), cancel = profileElement('button', 'tbtn', 'Cancel');
      confirm.onclick = () => profileAction('remove', { id:fragment.id, revision:fragment.revision }, confirm);
      cancel.onclick = () => { confirmation.replaceChildren(); remove.hidden = false; };
      confirmation.replaceChildren(confirm, cancel); remove.hidden = true; confirm.focus();
    };
    card.append(tags, evidence, remove, confirmation); list.append(card);
  }
  if (!fragments.length) list.append(profileElement('p', 'profile-fragment-empty',
    snapshot.fragments.length ? 'No fragments match these filters.' : 'No source-backed fragments yet. Backfill existing Chat history or continue using PKM Chat; no habits or interests will be invented to fill this page.'));
}
setInterval(() => {
  if (state.tab === 'userProfile' && !document.hidden) ask('userProfile', {}, null, true);
}, 5000);
