(() => {
  const host = acquireVsCodeApi();
  const saved = host.getState() || {};
  const treeRoot = document.getElementById('pkm-vis-tree');
  const dashboard = document.getElementById('pkm-vis-dashboard');
  const libraryError = document.getElementById('pkm-vis-library-error');
  const collapsed = new Set(saved.collapsed || []), expanded = new Set(saved.expanded || []);
  const requests = new Map();
  const PANELS = [
    ['lifecycle', 'Lifecycle'], ['execution', 'Execution graph'], ['retrieval', 'Retrieval / Search'],
    ['recipeAction', 'Recipe / Action'], ['memory', 'Memory'], ['timeline', 'Timeline'],
  ];
  const DETAIL = new Set(['retrieval', 'memory', 'timeline']);
  const ACTIVE = new Set(['running', 'awaiting-input', 'awaiting-result']);
  const ACTIVE_BINDING = new Set([...ACTIVE, 'waiting', 'blocked', 'paused', 'awaiting-approval']);
  let library, selected = saved.chatId, panel = PANELS.some(([id]) => id === saved.panel) ? saved.panel : 'lifecycle';
  let view, ui, generation = 0, sequence = 0, attemptChoice, retrievalChoice = 0, retrievalFilter = 'all';
  const fullResults = new Map();
  const memoryObservations = new Map();
  const expandedMemoryPieces = new Set();
  const expandedMemoryInventories = new Set();
  const memoryPiecePages = new Map();
  const panelGraphs = new Map();
  const list = value => Array.isArray(value) ? value : [];
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, action, label) => {
    const node = el('button', text); node.type = 'button';
    if (label) node.setAttribute('aria-label', label);
    node.addEventListener('click', action); return node;
  };
  const save = () => host.setState({ chatId: selected, panel, collapsed: [...collapsed], expanded: [...expanded] });
  const duration = ms => !Number.isFinite(ms) || ms < 0 ? 'unknown' : ms < 1000 ? `${Math.round(ms)} ms`
    : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3600000 ? `${Math.floor(ms / 60000)} min ${Math.round(ms % 60000 / 1000)} s`
    : `${Math.floor(ms / 3600000)} h ${Math.round(ms % 3600000 / 60000)} min`;
  const time = at => Number.isFinite(at) ? new Date(at).toLocaleTimeString() : 'unknown';

  function request(method, params) {
    const chatId = selected;
    return new Promise((resolve, reject) => {
      const requestId = `vis-window-${++sequence}`;
      const timer = setTimeout(() => { requests.delete(requestId); reject(new Error('Visualization request timed out. Select the Chat again to retry.')); }, 30000);
      requests.set(requestId, { resolve, reject, timer, chatId });
      host.postMessage({ type: 'request', requestId, chatId, method, params });
    });
  }
  function cancelRequests() {
    for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('Visualization switched Chat.')); }
    requests.clear();
  }

  // Tree mirrors the Chat List: Ungroup, user folders, workers nested under their manager. Trash is not readable here.
  function renderTree() {
    const focusedId = document.activeElement?.dataset?.treeId;
    treeRoot.replaceChildren();
    if (!library) return;
    const byId = new Map(library.chats.map(chat => [chat.id, chat]));
    const parentOf = chat => {
      const candidate = byId.get(chat.workerParentChatId);
      if (!candidate || candidate.id === chat.id || candidate.workerTreeId !== chat.workerTreeId) return undefined;
      for (let cursor = candidate, seen = new Set([chat.id]); cursor; cursor = byId.get(cursor.workerParentChatId)) {
        if (seen.has(cursor.id)) return undefined;
        seen.add(cursor.id);
      }
      return candidate;
    };
    const children = new Map();
    for (const chat of library.chats) {
      const manager = parentOf(chat);
      if (manager) { if (!children.has(manager.id)) children.set(manager.id, []); children.get(manager.id).push(chat); }
    }
    const busy = chat => ACTIVE.has(chat.status) || list(children.get(chat.id)).some(busy);
    const sorted = chats => [...chats].sort((left, right) => Number(busy(right)) - Number(busy(left)) || String(right.updatedAt).localeCompare(String(left.updatedAt)));
    const item = (id, level, expandable, open) => {
      const node = el('div', undefined, 'pkm-vis-treeitem');
      node.setAttribute('role', 'treeitem'); node.setAttribute('aria-level', String(level));
      node.dataset.treeId = id; node.tabIndex = -1;
      if (expandable) node.setAttribute('aria-expanded', String(open));
      node.style.setProperty('--level', String(level - 1));
      return node;
    };
    const chatNode = (chat, level) => {
      const kids = sorted(children.get(chat.id) || []), open = expanded.has(chat.id) || kids.some(kid => kid.id === selected);
      const node = item(`chat:${chat.id}`, level, kids.length > 0, open);
      node.dataset.chatId = chat.id;
      node.setAttribute('aria-selected', String(chat.id === selected));
      const row = el('div', undefined, 'pkm-vis-treerow');
      if (kids.length) row.append(button(open ? '▾' : '▸', event => { event.stopPropagation(); toggle(chat.id, !open, true); }, `${open ? 'Collapse' : 'Expand'} workers of ${chat.title}`));
      else row.append(el('span', '', 'pkm-vis-twisty'));
      const dot = el('span', undefined, 'pkm-vis-status'); dot.dataset.state = chat.status || 'idle';
      dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', chat.status || 'idle'); dot.title = chat.status || 'idle';
      row.append(dot, el('span', chat.title || 'Untitled Chat', 'pkm-vis-treelabel'));
      if (chat.workerManager || kids.length) row.append(el('small', 'manager'));
      node.append(row);
      node.addEventListener('click', event => { event.stopPropagation(); select(chat.id); });
      if (kids.length && open) {
        const group = el('div'); group.setAttribute('role', 'group');
        kids.forEach(kid => group.append(chatNode(kid, level + 1)));
        node.append(group);
      }
      return node;
    };
    const groups = [{ id: 'ungroup', name: 'Ungroup' }, ...library.groups];
    for (const group of groups) {
      const chats = sorted(library.chats.filter(chat => !parentOf(chat) && (chat.groupId === group.id || group.id === 'ungroup' && !groups.some(other => other.id === chat.groupId))));
      const open = !collapsed.has(group.id) || chats.some(chat => chat.id === selected);
      const node = item(`group:${group.id}`, 1, true, open);
      const row = el('div', undefined, 'pkm-vis-treerow pkm-vis-group');
      row.append(el('span', open ? '▾' : '▸', 'pkm-vis-twisty'), el('span', undefined, `codicon codicon-folder${open ? '-opened' : ''}`),
        el('span', group.name, 'pkm-vis-treelabel'), el('small', String(chats.length)));
      node.append(row);
      node.addEventListener('click', event => { event.stopPropagation(); toggle(group.id, !open, false); });
      if (open) {
        const children = el('div'); children.setAttribute('role', 'group');
        chats.forEach(chat => children.append(chatNode(chat, 2)));
        node.append(children);
      }
      treeRoot.append(node);
    }
    const items = [...treeRoot.querySelectorAll('[role="treeitem"]')];
    const target = items.find(node => node.dataset.treeId === focusedId) || items.find(node => node.dataset.chatId === selected) || items[0];
    if (target) target.tabIndex = 0;
    if (focusedId && target) target.focus({ preventScroll: true });
  }
  function toggle(id, open, chat) {
    if (chat) { if (open) expanded.add(id); else expanded.delete(id); }
    else if (open) collapsed.delete(id); else collapsed.add(id);
    save(); renderTree();
  }
  treeRoot.addEventListener('keydown', event => {
    const items = [...treeRoot.querySelectorAll('[role="treeitem"]')];
    const current = event.target.closest?.('[role="treeitem"]');
    const index = items.indexOf(current);
    if (index < 0) return;
    const move = next => { if (!next) return; items.forEach(node => { node.tabIndex = -1; }); next.tabIndex = 0; next.focus(); };
    const id = current.dataset.treeId, isChat = id.startsWith('chat:'), raw = id.slice(id.indexOf(':') + 1);
    const open = current.getAttribute('aria-expanded') === 'true';
    if (event.key === 'ArrowDown') move(items[index + 1]);
    else if (event.key === 'ArrowUp') move(items[index - 1]);
    else if (event.key === 'Home') move(items[0]);
    else if (event.key === 'End') move(items.at(-1));
    else if (event.key === 'ArrowRight' && current.hasAttribute('aria-expanded') && !open) toggle(raw, true, isChat);
    else if (event.key === 'ArrowLeft' && open) toggle(raw, false, isChat);
    else if (event.key === 'ArrowLeft') move(current.parentElement?.closest('[role="treeitem"]'));
    else if (event.key === 'Enter' || event.key === ' ') { if (isChat) select(raw); else toggle(raw, !open, false); }
    else return;
    event.preventDefault();
  });

  function shell(chat) {
    const head = el('header', undefined, 'pkm-vis-head');
    const title = el('h1', chat?.title || 'PKM Chat'), status = el('span', '', 'pkm-vis-head-status');
    head.append(title, status, button('Open Chat', () => host.postMessage({ type: 'openChat', chatId: selected }), 'Open this Chat in PKM Chat'));
    const error = el('p', '', 'pkm-vis-error'); error.setAttribute('role', 'alert'); error.hidden = true;
    const grid = el('div', undefined, 'pkm-vis-grid');
    const main = el('section', undefined, 'pkm-vis-main');
    const mainTitle = el('h2'); mainTitle.id = 'pkm-vis-main-title';
    main.setAttribute('aria-labelledby', mainTitle.id);
    const harness = el('div', undefined, 'pkm-vis-main-harness'), detail = el('div', undefined, 'pkm-vis-main-detail');
    const bindings = el('nav', undefined, 'pkm-vis-bindings');
    bindings.setAttribute('aria-label', 'Recorded Recipe and Action bindings');
    bindings.hidden = true;
    main.append(mainTitle, bindings, harness, detail);
    const tiles = el('nav', undefined, 'pkm-vis-tiles'); tiles.setAttribute('aria-label', 'Dashboard views');
    const tileMap = new Map();
    for (const [id, label] of PANELS) {
      const tile = el('button', undefined, 'pkm-vis-tile'); tile.type = 'button'; tile.dataset.panel = id;
      const name = el('strong', label);
      tile.append(name);
      tile.addEventListener('click', () => enlarge(id));
      tiles.append(tile); tileMap.set(id, { tile, label });
    }
    grid.append(tiles, main);
    dashboard.replaceChildren(head, error, grid);
    return { title, status, error, mainTitle, bindings, harness, detail, tileMap };
  }
  function showError(message) { if (!ui) return; ui.error.textContent = message; ui.error.hidden = !message; }

  async function select(chatId) {
    if (!library?.chats.some(chat => chat.id === chatId)) return;
    if (chatId === selected && view) return;
    selected = chatId; attemptChoice = undefined; retrievalChoice = 0; retrievalFilter = 'all'; fullResults.clear(); panelGraphs.clear(); save(); renderTree();
    const current = ++generation;
    cancelRequests(); view?.dispose(); view = undefined;
    const chat = library.chats.find(item => item.id === chatId);
    ui = shell(chat);
    ui.mainTitle.textContent = 'Loading execution records...';
    try {
      const initial = await request('snapshot', {});
      if (current !== generation) return;
      view = globalThis.PkmAgentHarness.mount(ui.harness, { initial, request, onUpdate: () => { if (current === generation) refreshTiles(); } });
      enlarge(panel, false);
    } catch (error) {
      if (current !== generation) return;
      ui.mainTitle.textContent = 'Execution records unavailable';
      showError(error.message);
    }
  }

  function enlarge(id, remember = true) {
    if (remember && view && !DETAIL.has(panel) && !ui.harness.hidden) panelGraphs.set(panel, view.graphId);
    panel = id; save();
    if (!view || !ui) return;
    const label = PANELS.find(([key]) => key === id)[1];
    ui.mainTitle.textContent = label;
    const detail = DETAIL.has(id);
    let fallback;
    const restored = panelGraphs.has(id) && view.restoreGraph(panelGraphs.get(id));
    if (!restored) {
      if (id === 'lifecycle') view.showLifecycle();
      else if (id === 'execution') view.focusCurrent();
      else if (id === 'recipeAction') {
        const bindings = [...view.model.overview.recipes, ...view.model.overview.actions].filter(item => item.available && item.graphId);
        const binding = bindings.find(item => item.nodeId && ACTIVE_BINDING.has(item.status || item.state))
          || bindings.find(item => ACTIVE_BINDING.has(item.status || item.state)) || bindings[0];
        if (binding) view.locate(binding.graphId, binding.nodeId); else fallback = true;
      }
    }
    ui.harness.hidden = detail || !!fallback;
    ui.detail.hidden = !detail && !fallback;
    for (const [key, { tile }] of ui.tileMap) tile.setAttribute('aria-pressed', String(key === id));
    if (ui.detail.hidden) ui.detail.replaceChildren();
    refreshTiles();
  }

  function renderBindings() {
    const nav = ui.bindings, focused = document.activeElement?.dataset?.bindingId;
    nav.hidden = panel !== 'recipeAction';
    if (nav.hidden) return;
    nav.replaceChildren();
    const overview = view.model.overview;
    nav.append(el('small', `Attempt ${overview.attempt?.number || overview.attempt?.id || 'unavailable'} / explicit recorded bindings only`));
    for (const [kind, items] of [['Recipe', overview.recipes], ['Action', overview.actions]]) for (const item of items) {
      const label = `${kind}: ${item.name || item.actionId || item.runId}${item.nodeId ? ` / ${item.nodeId}` : ''}`;
      const identity = `${kind}:${item.runId}:${item.nodeId || ''}`;
      const available = item.available && item.graphId;
      const node = button(`${label} / ${item.status || item.state || 'unknown'}${available ? '' : ' (record unavailable)'}`, () => {
        view.locate(item.graphId, item.nodeId);
        panelGraphs.set(panel, view.graphId);
        ui.harness.hidden = false; ui.detail.hidden = true;
      }, `Open recorded ${label}`);
      node.dataset.bindingId = identity;
      node.disabled = !available;
      nav.append(node);
    }
    nav.append(el('small', 'A completed tool call or submission is not evidence that a remote job completed.'));
    if (focused) [...nav.querySelectorAll('[data-binding-id]')].find(node => node.dataset.bindingId === focused)?.focus({ preventScroll:true });
  }

  function attempts() { return list(view?.session?.harness?.attempts); }
  function chosenAttempt() {
    const all = attempts();
    return all.find(item => item.messageId === attemptChoice) || all.at(-1);
  }
  function attemptPicker() {
    const all = attempts(), wrap = el('label', 'Attempt ', 'pkm-vis-picker'), pick = el('select');
    all.forEach((attempt, index) => {
      const option = el('option', `#${attempt.attempt || index + 1} ${attempt.status}${attempt.model ? ` / ${attempt.model}` : ''}${attempt.progress?.startedAt ? ` / ${time(attempt.progress.startedAt)}` : ''}`);
      option.value = attempt.messageId; pick.append(option);
    });
    pick.value = chosenAttempt()?.messageId || '';
    pick.addEventListener('change', () => { attemptChoice = pick.value; retrievalChoice = 0; renderDetail(); refreshTiles(); });
    wrap.append(pick);
    return wrap;
  }

  function renderDetail() {
    if (!ui || !view) return;
    const detail = ui.detail;
    if (detail.hidden) { detail.replaceChildren(); return; }
    const focusKey = document.activeElement?.dataset?.visFocus, scroller = detail.parentElement, top = scroller.scrollTop;
    detail.replaceChildren();
    if (panel === 'recipeAction') {
      const recorded = view.model.overview.recipes.length + view.model.overview.actions.length;
      detail.append(el('p', recorded
        ? 'Explicit bindings are recorded, but their execution records are unavailable. Missing records are not replaced by a current library definition or guessed from tool names.'
        : 'No explicit Recipe Run or Action Run binding is recorded for the current attempt. Bindings are never inferred from tool names.', 'pkm-vis-muted'));
      const back = button('Open execution graph', () => enlarge('execution')); detail.append(back);
      scroller.scrollTop = top; return;
    }
    const attempt = chosenAttempt();
    if (!attempt && panel === 'memory') { renderMemory(detail); scroller.scrollTop = top; return; }
    if (!attempt) { detail.append(el('p', 'No Harness attempt recorded yet.', 'pkm-vis-muted')); scroller.scrollTop = top; return; }
    detail.append(attemptPicker());
    if (panel === 'retrieval') renderRetrieval(detail, attempt);
    else if (panel === 'memory') renderMemory(detail, attempt);
    else if (panel === 'timeline') renderTimeline(detail, attempt);
    if (focusKey) detail.querySelector(`[data-vis-focus="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
    scroller.scrollTop = top;
  }

  function table(headers, rows) {
    const node = el('table', undefined, 'pkm-vis-table'), head = el('tr');
    headers.forEach(text => head.append(el('th', text)));
    const thead = el('thead'); thead.append(head); node.append(thead);
    const body = el('tbody');
    rows.forEach(cells => { const row = el('tr'); cells.forEach(cell => row.append(cell instanceof Node ? (() => { const td = el('td'); td.append(cell); return td; })() : el('td', String(cell ?? '')))); body.append(row); });
    node.append(body);
    return node;
  }

  const STAGE_MEANING = {
    recalled: 'Shortlist: candidates recalled and ranked. Not necessarily sent to the model.',
    prepared: 'Prepared: chosen for the next request but not yet transmitted.',
    sent: 'Sent: included in a request PKM transmitted. Sizes are PKM estimates, not a provider confirmation of what the model read.',
  };
  const navigable = uri => /^pkm:\/\//i.test(String(uri || ''));
  function stageLabel(step) {
    const receipt = step.receipt || {};
    if (step.kind === 'sent-round') return `Sent / model round ${Number.isInteger(step.round) ? step.round + 1 : '?'}`;
    if (step.kind === 'selection') return `Selection / ${receipt.phase || 'recalled'}`;
    return `${step.kind.replace(/-recall$/, '')} recall / ${receipt.phase || 'recalled'}`;
  }
  function stateOf(item) { return item.evidenceState || (item.selected ? 'selected' : item.reason && /exclu|disabl|denied|stale|missing|budget|limit/i.test(item.reason) ? 'excluded' : 'not selected'); }
  function parseArguments(text) {
    try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; } catch { return undefined; }
  }
  function hitCount(text) {
    try {
      const value = JSON.parse(text);
      const items = Array.isArray(value) ? value : ['results', 'hits', 'items', 'matches', 'candidates'].map(key => value?.[key]).find(Array.isArray);
      return items ? items.length : undefined;
    } catch { return undefined; }
  }

  function renderRetrieval(detail, attempt) {
    const steps = list(attempt.retrieval);
    const searches = list(attempt.toolCalls).filter(call => /search|retriev|recall|grep|find|query/i.test(call.name || ''));
    const overview = view.model.overview, latest = attempts().at(-1);
    if (attempt === latest && overview.phase?.kind === 'retrieval') {
      const live = el('p', undefined, 'pkm-vis-live'); live.setAttribute('role', 'status');
      live.append(el('span', undefined, 'pkm-vis-live-dot'), el('span', `Retrieval running: ${overview.phase.label}. Receipts appear when each stage is recorded.`));
      detail.append(live);
    }
    if (!steps.length) detail.append(el('p', 'No retrieval receipt recorded for this attempt.', 'pkm-vis-muted'));
    else {
      const strip = el('div', undefined, 'pkm-vis-steps'); strip.setAttribute('role', 'tablist'); strip.setAttribute('aria-label', 'Retrieval receipts');
      if (retrievalChoice >= steps.length) retrievalChoice = 0;
      steps.forEach((step, index) => {
        const receipt = step.receipt || {};
        const tab = button(`${stageLabel(step)}: ${receipt.selectedCount ?? 0}/${list(receipt.candidates).length}`, () => { retrievalChoice = index; renderDetail(); });
        tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(index === retrievalChoice)); tab.dataset.visFocus = `retrieval-${index}`;
        tab.dataset.phase = step.kind === 'sent-round' ? 'sent' : receipt.phase || 'recalled';
        strip.append(tab);
      });
      detail.append(strip);
      const step = steps[retrievalChoice], receipt = step.receipt || {}, candidates = list(receipt.candidates);
      const phase = step.kind === 'sent-round' ? 'sent' : receipt.phase || 'recalled';
      detail.append(el('p', STAGE_MEANING[phase] || '', 'pkm-vis-muted'));
      const facts = el('dl', undefined, 'pkm-vis-facts');
      for (const [term, value] of [
        ['Stage', stageLabel(step)], ['Query', receipt.query || 'not recorded'],
        ['Selected', `${receipt.selectedCount ?? candidates.filter(item => item.selected).length} of ${candidates.length} candidates`],
        ['Model', receipt.model || 'not recorded'], ['Recorded at', time(step.at)],
        ...(Number.isFinite(step.durationMs) ? [['Duration', duration(step.durationMs)]] : []),
        ...(Number.isFinite(step.inputTokens) ? [['Input tokens (PKM estimate / budget)', `${step.inputTokens} / ${step.inputBudget}`]] : []),
        ...(receipt.warning ? [['Warning', receipt.warning]] : []),
      ]) facts.append(el('dt', term), el('dd', value));
      detail.append(facts);
      const flow = el('div', undefined, 'pkm-vis-flow');
      detail.append(flow);
      const evidence = el('section'); evidence.setAttribute('aria-label','Retrieval candidate evidence');
      if (globalThis.PkmRetrievalFlow && candidates.length) {
        try { globalThis.PkmRetrievalFlow(flow, { ...receipt, model: receipt.model || attempt.model || 'model' }, 20, 'all', item => {
          evidence.replaceChildren(el('h4',item.label || item.id || 'Unnamed candidate'));
          evidence.append(table(['Field','Recorded value'],[
            ['Kind',item.kind || 'not recorded'],['Source',item.sourceUri || 'not recorded'],
            ['Method',item.method || 'not recorded'],['Score',item.score ?? 'not recorded'],
            ['State',stateOf(item)],['Reason',item.reason || 'not recorded'],
          ]));
          if (navigable(item.sourceUri)) evidence.append(button('Open source',() => host.postMessage({
            type:'openSource',chatId:selected,sourceUri:item.sourceUri,
          })));
        }); }
        catch (error) { flow.replaceChildren(el('p', `Flow view unavailable: ${error.message}`, 'pkm-vis-muted')); }
      }
      detail.append(evidence);
      const counts = candidates.reduce((map, item) => map.set(stateOf(item), (map.get(stateOf(item)) || 0) + 1), new Map());
      const filter = el('label', 'Show ', 'pkm-vis-picker'), pick = el('select'); pick.dataset.visFocus = 'retrieval-filter'; pick.setAttribute('aria-label', 'Filter candidates');
      for (const value of ['all', ...counts.keys()]) {
        const option = el('option', value === 'all' ? `all (${candidates.length})` : `${value} (${counts.get(value)})`); option.value = value; pick.append(option);
      }
      if (retrievalFilter !== 'all' && !counts.has(retrievalFilter)) retrievalFilter = 'all';
      pick.value = retrievalFilter;
      pick.addEventListener('change', () => { retrievalFilter = pick.value; renderDetail(); });
      filter.append(pick); detail.append(filter);
      const shown = candidates.filter(item => retrievalFilter === 'all' || stateOf(item) === retrievalFilter);
      detail.append(table(['Candidate', 'Kind', 'Method', 'Score', 'State', 'Reason', 'Source'], shown.map(item => {
        const source = navigable(item.sourceUri)
          ? button('Open', () => host.postMessage({ type: 'openSource', chatId: selected, sourceUri: item.sourceUri }), `Open source of ${item.label || item.id}`)
          : el('span', item.sourceUri ? 'not navigable' : 'not recorded', 'pkm-vis-muted');
        if (source.tagName === 'BUTTON') { source.title = item.sourceUri; source.dataset.visFocus = `source-${item.id}`; }
        const range = item.range ? ` [${item.range.start}, ${item.range.end}) ${item.range.unit}` : '';
        return [item.label || item.id || '', `${item.kind || ''}${item.level ? ` / ${item.level}` : ''}`, item.method || '',
          Number.isFinite(item.score) ? item.score.toFixed(3) : '', stateOf(item) + range, item.reason || '', source];
      })));
    }
    detail.append(el('h3', 'Search-type tool calls'));
    if (!searches.length) { detail.append(el('p', 'No tool call with a search/retrieve/query name was recorded. External engines\' internal steps are not observable.', 'pkm-vis-muted')); return; }
    detail.append(el('p', 'Inputs are the recorded arguments; hits are counted only when the result is structured JSON. Internal steps of external search engines are not observable.', 'pkm-vis-muted'));
    for (const call of searches) {
      const section = el('section', undefined, 'pkm-vis-call'); section.dataset.status = call.status;
      const heading = el('h4', `${call.name} / ${call.status}`);
      const parameters = parseArguments(call.arguments), facts = el('dl', undefined, 'pkm-vis-facts');
      if (parameters) for (const [key, value] of Object.entries(parameters).slice(0, 12))
        facts.append(el('dt', key), el('dd', typeof value === 'string' ? value.slice(0, 600) : JSON.stringify(value).slice(0, 600)));
      else facts.append(el('dt', 'Arguments'), el('dd', String(call.arguments || '').slice(0, 600) || 'none recorded'));
      const key = `${attempt.messageId}|${call.id}`, full = fullResults.get(key);
      const result = full?.text ?? String(call.resultPreview || '');
      const hits = hitCount(result);
      facts.append(el('dt', 'Result'), el('dd', `${call.resultCharacters ?? result.length} characters${hits === undefined ? '' : ` / ${hits} hit(s)`}${Number.isFinite(call.startedAt) && Number.isFinite(call.finishedAt) ? ` / ${duration(call.finishedAt - call.startedAt)}` : ''}`));
      const pre = el('pre', result || 'No result recorded.', 'pkm-vis-result');
      section.append(heading, facts, pre);
      if (full?.error) section.append(el('p', full.error, 'pkm-vis-error'));
      if (call.resultTruncated && !full?.text) {
        const load = button(full?.loading ? 'Loading full result...' : 'Load full result', () => loadFullResult(attempt.messageId, call.id), `Load full result of ${call.name}`);
        load.disabled = Boolean(full?.loading); load.dataset.visFocus = `full-${call.id}`; section.append(load);
      }
      detail.append(section);
    }
  }
  function loadFullResult(messageId, callId) {
    const key = `${messageId}|${callId}`, chatId = selected, current = generation;
    fullResults.set(key, { loading: true }); renderDetail();
    request('result', { messageId, callId }).then(
      text => { if (current === generation && chatId === selected) { fullResults.set(key, { text: String(text) }); renderDetail(); } },
      error => { if (current === generation && chatId === selected) { fullResults.set(key, { error: error.message }); renderDetail(); } });
  }

  function memoryObservation(method, params = {}, refresh = false) {
    const key = JSON.stringify([selected, method, params]);
    if (refresh) memoryObservations.delete(key);
    if (!memoryObservations.has(key)) {
      if (memoryObservations.size >= 200) memoryObservations.delete(memoryObservations.keys().next().value);
      const state = { loading:true }, chatId = selected, current = generation;
      memoryObservations.set(key, state);
      request(method, params).then(data => { state.data = data; }, error => { state.error = error.message; }).finally(() => {
        state.loading = false;
        if (current === generation && chatId === selected && panel === 'memory') {
          if (method === 'memoryPiece') state.render?.();
          else renderDetail();
        }
      });
    }
    return memoryObservations.get(key);
  }
  function memoryReadState(host, state) {
    if (state.loading) host.append(el('p', 'Reading stored Memory…', 'pkm-vis-muted'));
    else if (state.error) host.append(el('p', state.error, 'pkm-vis-error'));
    return !state.loading && !state.error;
  }
  function renderStoredMemory(detail, attempt) {
    detail.append(el('h3', '1. Stored Memory — live Chat scope'));
    if (!view.session.memoryStoreReader) {
      detail.append(globalThis.PkmAgentHarness.memoryPyramid(undefined,attempt));
      detail.append(el('p', 'This Host does not provide scoped stored-Memory inspection. Load a compatible Host to inspect it.', 'pkm-vis-muted')); return;
    }
    const refresh = button('Refresh stored Memory', () => { memoryObservations.clear(); renderDetail(); });
    detail.append(refresh);
    const state = memoryObservation('memoryOverview');
    if (!memoryReadState(detail, state)) {
      detail.append(globalThis.PkmAgentHarness.memoryPyramid(undefined,attempt)); return;
    }
    const data = state.data, pieces = list(data.pieces);
    detail.append(el('p', `${data.usage?.pieces ?? 'unknown'} live piece(s), ${data.usage?.bytes ?? 'unknown'} logical bytes. Observed ${new Date(data.observedAt).toLocaleString()}.`));
    detail.append(el('p', data.note, 'pkm-vis-muted'));
    if (data.recallPolicy) detail.append(el('p', `History ${data.recallPolicy.historyEnabled ? 'on' : 'off'} · recall window: ${data.recallPolicy.recallDays === null ? 'unlimited' : `${data.recallPolicy.recallDays} days`}${data.recallPolicy.clearedAt ? ` · derived recall cleared through ${new Date(data.recallPolicy.clearedAt).toLocaleString()}` : ''}. Stored pieces are not proof of eligibility for automatic recall.`));
    if (data.possiblyTruncated) detail.append(el('p', `Bounded view: at most ${data.pieceLimitPerKind} pieces per kind and ${data.edgeLimitPerPiece} edges per topic. Totals and displayed counts differ.`, 'pkm-vis-muted'));
    const pyramid = el('div', undefined, 'pkm-vis-memory-pyramid');
    pyramid.setAttribute('role', 'list'); pyramid.setAttribute('aria-label', 'Stored Memory abstraction levels');
    const inventory = el('details'), pieceItems = new Map();
    const inventoryChat = selected;
    inventory.open = expandedMemoryInventories.has(inventoryChat);
    inventory.addEventListener('toggle',() => {
      if (inventory.open) expandedMemoryInventories.add(inventoryChat); else expandedMemoryInventories.delete(inventoryChat);
    });
    inventory.append(el('summary','Stored piece inventory and provenance'));
    detail.append(globalThis.PkmAgentHarness.memoryPyramid(data,attempt,piece => {
      const item = pieceItems.get(piece.id);
      if (item) { inventory.open = true; item.open = true; item.scrollIntoView({block:'nearest'}); }
    }),el('small','Blue: prepared reference. Green: recorded sent reference, not proof the current stored revision was sent. Click a block to inspect its source.'));
    const levels = [...new Set(pieces.map(piece => piece.level))].sort((a, b) => b - a);
    for (const level of levels) {
      const members = pieces.filter(piece => piece.level === level);
      const row = el('section', undefined, 'pkm-vis-memory-level'); row.setAttribute('role', 'listitem');
      row.style.marginInline = `${Math.min(15, (levels.length - levels.indexOf(level) - 1) * 3)}%`;
      row.append(el('h4', `Level ${level} · ${members.length} displayed piece(s) · ${members.reduce((sum, p) => sum + p.bytes, 0)} logical bytes`));
      for (const piece of members) {
        const item = el('details'), title = el('summary', `${piece.label} · ${piece.kind} · r${piece.revision} · ${piece.summary_current ? 'summary current' : piece.summary ? 'summary stale' : 'no summary'}`);
        pieceItems.set(piece.id,item);
        const body = el('div');
        item.append(title, body);
        const key = `${selected}:${piece.id}`;
        item.addEventListener('toggle', () => {
          if (item.open) {
            expandedMemoryPieces.add(key);
            if (!body.childNodes.length) renderMemoryPiece(body, piece.id);
          } else expandedMemoryPieces.delete(key);
        });
        if (expandedMemoryPieces.has(key)) { item.open = true; renderMemoryPiece(body, piece.id, memoryPiecePages.get(key) || 0); }
        row.append(item);
      }
      pyramid.append(row);
    }
    if (!pieces.length) pyramid.append(el('p', 'No live stored pieces in this Chat. This does not mean its original history was deleted.'));
    inventory.append(pyramid);
    detail.append(inventory, el('small', 'Levels come from stored abstraction edges. Shape is schematic; width is not tokens, capacity or compression.'));
    if (list(data.edges).length) {
      const labels = new Map(pieces.map(p => [p.id, p.label]));
      inventory.append(table(['Parent', 'Relation', 'Child'], data.edges.map(edge => [labels.get(edge.parent), edge.relation, labels.get(edge.child)])));
    }
  }
  function renderMemoryPiece(host, piece, after = 0) {
    host.replaceChildren();
    memoryPiecePages.set(`${selected}:${piece}`, after);
    const state = memoryObservation('memoryPiece', { piece, after });
    state.render = () => { if (host.isConnected) renderMemoryPiece(host, piece, after); };
    if (state.loading) {
      host.append(el('p', 'Loading piece…'));
      return;
    }
    if (!memoryReadState(host, state)) return;
    const data = state.data;
    host.append(el('p', `${data.status} · revision ${data.piece.revision} · ${data.summary_current ? 'current summary' : 'summary unavailable or stale'}`));
    if (data.summary) host.append(el('pre', data.summary.body));
    for (const statement of list(data.statements)) {
      const section = el('section');
      section.append(el('strong', `Statement ${statement.sequence} · ${statement.status}`), el('pre', statement.body ?? 'Content unavailable'));
      for (const source of list(statement.sources)) {
        const sourceView = el('div');
        section.append(el('p', `${source.locator} · revision ${source.revision}`),
          button('Read original source', async () => {
            sourceView.replaceChildren(el('p', 'Reading original revision…'));
            try {
              const match = /^message:([a-f0-9-]{36})$/.exec(source.locator);
              if (!match) throw new Error('This source locator is not supported by the Chat reader.');
              const result = await request('memorySource', { messageId:match[1], revision:source.revision });
              sourceView.replaceChildren(el('pre', result.content));
              if (result.truncated) sourceView.append(el('p', `Preview limited to 12,000 of ${result.characters} characters. Open the Chat for the full original.`));
            } catch (error) { sourceView.replaceChildren(el('p', error.message, 'pkm-vis-error')); }
          }), sourceView);
      }
      section.append(el('small', `Up to ${statement.sourceLimit} source references shown; absence is not proof of verification.`));
      host.append(section);
    }
    if (data.next !== null) host.append(button('Next statement page', () => renderMemoryPiece(host, piece, data.next)));
    if (after) host.append(button('First statement page', () => renderMemoryPiece(host, piece)));
  }
  function renderMemory(detail, attempt) {
    detail.append(el('h3', 'Collaboration Profiles'));
    const profiles = attempt?.profileContext;
    const profileRows = [];
    for (const kind of ['user', 'agent']) {
      const profile = profiles?.[kind];
      const sent = list(attempt?.budgetReceipts).filter(receipt => receipt.status === 'sent' &&
        list(receipt.contextPlan?.manifest).some(message => message.hash === profiles?.messageHash));
      profileRows.push([kind === 'user' ? 'User Profile' : 'Agent Profile',
        profile ? `${profile.name} · r${profile.revision}` : 'Not recorded',
        profile ? sent.length ? `Sent in ${sent.length} recorded round(s)` : 'Snapshot recorded; transmission not established' : '—']);
    }
    detail.append(table(['Persistent context', 'Attempt snapshot', 'Transmission'], profileRows));
    if (profiles) {
      const card = el('details'); card.open = true; card.append(el('summary', 'Inspect recorded Profile fields'));
      const rows = [];
      for (const kind of ['user', 'agent']) for (const field of ['role','focus','preferences','boundaries']) {
        if (profiles[kind]?.[field]) rows.push([kind, field, profiles[kind][field]]);
      }
      card.append(table(['Profile', 'Field', 'Value'], rows));
      card.append(el('small', 'Explicit private Profiles, separate from learned Chat topics. Historical snapshot; not the current editable card.'));
      detail.append(card);
    }
    renderStoredMemory(detail,attempt);
    const memory = attempt?.memory;
    detail.append(el('h3', '2. This attempt — prepared versus sent'));
    if (!memory) { detail.append(el('p', 'No memory receipt recorded for this attempt.', 'pkm-vis-muted')); return; }
    const blocks = list(memory.blocks), facts = [];
    const byKind = blocks.reduce((map, block) => map.set(block.kind, (map.get(block.kind) || 0) + 1), new Map());
    for (const [term, value] of [
      ['Turn', memory.turn || 'not recorded'], ['Memory model', memory.model || 'not recorded'], ['Duration', duration(memory.durationMs)],
      ['Blocks', blocks.length ? [...byKind].map(([kind, count]) => `${kind}: ${count}`).join(', ') : 'none'],
      ['Characters prepared', String(blocks.reduce((sum, block) => sum + (block.characters || 0), 0))],
      ...(memory.error ? [['Error', memory.error]] : []),
    ]) facts.push([term, value]);
    const preparation = el('details'); preparation.append(el('summary', 'Preparation metadata'), table(['Field', 'Recorded value'], facts));
    detail.append(preparation);
    if (blocks.length) detail.append(table(['Kind', 'Piece', 'Characters prepared', 'Budget-admitted plans', 'Sent-round membership'], blocks.map(block => {
      const plans = list(attempt.budgetReceipts).filter(receipt => receipt.contextPlan?.manifest);
      const includes = receipt => receipt.contextPlan.manifest.some(message => list(message.referenceIds).includes(`memory:${block.piece}`));
      const admitted = plans.filter(includes), rounds = plans.filter(receipt => receipt.status === 'sent'), sent = rounds.filter(includes);
      return [block.kind, block.piece, block.characters,
        !plans.length ? 'Not recorded' : admitted.length ? admitted.map(receipt => `#${receipt.round} (${receipt.status})`).join(', ') : 'Not in recorded plans',
        !rounds.length ? 'Not recorded' : sent.length ? sent.map(receipt => `#${receipt.round}`).join(', ') : 'Not in recorded sent manifests'];
    })));
    if (view.session.memoryStoreReader) for (const block of blocks.filter(block => block.piece)) {
      const item = el('details'), body = el('div');
      item.append(el('summary', `Inspect current stored piece: ${block.kind} / ${block.piece}`), body);
      item.addEventListener('toggle', () => { if (item.open && !body.childNodes.length) renderMemoryPiece(body, block.piece); });
      detail.append(item);
    }
    detail.append(el('h3', '3. Post-reply organization — durable receipt'));
    if (!view.session.memoryReceiptReader) { detail.append(el('p', 'Durable receipt reader unavailable on this Host.')); return; }
    const state = memoryObservation('memoryReceipt', { messageId:attempt.messageId });
    if (memoryReadState(detail, state)) {
      const receipt = state.data;
      detail.append(el('p', `Phase: ${receipt.phase || 'not recorded'} · extraction: ${receipt.extract?.status || 'not recorded'} · model calls: ${receipt.accounting?.calls ?? receipt.calls?.length ?? 'not recorded'}`));
      if (receipt.extract?.error) detail.append(el('p', receipt.extract.error, 'pkm-vis-error'));
      const accounting = receipt.accounting;
      if (accounting) detail.append(table(['Independent Memory accounting', 'Recorded value'], [
        ...(accounting.reportedUsage ? [['Reported input / output tokens', `${accounting.reportedUsage.inputTokens} / ${accounting.reportedUsage.outputTokens}`]] : []),
        ...(globalThis.PkmAgentHarness.creditLabel(accounting.credits) ? [['Provider-reported Memory credits', globalThis.PkmAgentHarness.creditLabel(accounting.credits)]] : []),
        ['Usage coverage: reported / unreported calls', `${accounting.reportedCalls ?? 'unknown'} / ${accounting.unreportedCalls ?? 'unknown'}`],
        ['Observed local model-call time', duration(accounting.observedDurationMs)],
      ]), el('p', 'Memory inference is separate from main Chat usage. Missing usage is not zero; local duration is not CPU time or a bill.', 'pkm-vis-muted'));
      detail.append(el('p', 'This is the latest organization receipt, not the preparation snapshot or a guarantee of semantic truth.', 'pkm-vis-muted'));
      const raw = el('details'); raw.append(el('summary', 'Inspect durable receipt'), el('pre', JSON.stringify(receipt, null, 2))); detail.append(raw);
    }
  }

  function timelineData(attempt) {
    const progress = attempt.progress || {}, transitions = list(progress.transitions);
    const start = Math.min(...[progress.startedAt, ...transitions.map(item => item.at), ...list(attempt.toolCalls).map(call => call.startedAt)].filter(Number.isFinite));
    const live = ['running', 'streaming'].includes(attempt.status) || progress.status === 'running';
    const end = Math.max(...[progress.finishedAt, ...transitions.map(item => item.at), ...list(attempt.toolCalls).map(call => call.finishedAt), ...(live ? [Date.now()] : [])].filter(Number.isFinite));
    if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
    const stages = transitions.map((item, index) => ({ label: item.label, status: item.status, from: item.at,
      to: transitions[index + 1]?.at ?? (progress.finishedAt || (live ? Date.now() : item.at)) }));
    const calls = list(attempt.toolCalls).filter(call => Number.isFinite(call.startedAt)).map(call => ({ label: call.name, status: call.status,
      from: call.startedAt, to: call.finishedAt ?? (call.status === 'running' ? Date.now() : call.startedAt) }));
    const rounds = list(attempt.budgetReceipts).filter(item => Number.isFinite(item.at)).map(item => ({ at: item.at, label: `model round ${item.round} (${item.status})` }));
    return { start, end: Math.max(end, start + 1), stages, calls, rounds, live, dropped: progress.droppedSteps || 0 };
  }
  function renderTimeline(detail, attempt) {
    const data = timelineData(attempt);
    if (!data) { detail.append(el('p', 'No timed progress recorded for this attempt.', 'pkm-vis-muted')); return; }
    const span = data.end - data.start;
    detail.append(el('p', `${time(data.start)} to ${data.live ? 'now (running)' : time(data.end)} / ${duration(span)}${data.dropped ? ` / ${data.dropped} earlier step(s) were not retained` : ''}`));
    const chart = el('div', undefined, 'pkm-vis-gantt'); chart.setAttribute('role', 'list');
    const lane = (label, bars, markers = []) => {
      const row = el('div', undefined, 'pkm-vis-lane'); row.setAttribute('role', 'listitem');
      const track = el('div', undefined, 'pkm-vis-track');
      row.append(el('span', label, 'pkm-vis-lane-label'), track);
      for (const bar of bars) {
        const node = el('span', undefined, 'pkm-vis-bar'); node.dataset.status = bar.status || 'recorded';
        node.style.left = `${(bar.from - data.start) / span * 100}%`;
        node.style.width = `${Math.max(0.4, (bar.to - bar.from) / span * 100)}%`;
        node.title = `${bar.label}: ${bar.status || 'recorded'} / ${duration(bar.to - bar.from)}`;
        node.setAttribute('aria-label', node.title);
        track.append(node);
      }
      for (const marker of markers) {
        const node = el('span', undefined, 'pkm-vis-marker'); node.style.left = `${(marker.at - data.start) / span * 100}%`;
        node.title = `${marker.label} at ${time(marker.at)}`; node.setAttribute('aria-label', node.title); track.append(node);
      }
      chart.append(row);
    };
    lane('Stages', data.stages, data.rounds);
    data.calls.forEach(call => lane(call.label, [call]));
    detail.append(chart);
    const waits = data.stages.filter(stage => stage.status === 'waiting');
    const failures = [...data.stages, ...data.calls].filter(item => item.status === 'failed');
    detail.append(el('h3', 'Waits and blockers'));
    if (!waits.length && !failures.length) detail.append(el('p', 'No waiting or failed step recorded.', 'pkm-vis-muted'));
    else detail.append(table(['Item', 'Status', 'From', 'Duration'], [...waits, ...failures].map(item => [item.label, item.status, time(item.from), duration(item.to - item.from)])));
    detail.append(el('h3', 'Longest stages'));
    detail.append(table(['Stage', 'Status', 'Duration'], [...data.stages].sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, 8)
      .map(item => [item.label, item.status, duration(item.to - item.from)])));
  }

  function refreshTiles() {
    if (!ui || !view) return;
    renderBindings();
    const session = view.session, overview = view.model.overview;
    const chat = library?.chats.find(item => item.id === selected);
    ui.title.textContent = session.task || chat?.title || 'PKM Chat';
    ui.status.textContent = `${overview.state}${overview.phase?.label ? ` / ${overview.phase.label}` : ''}`;
    ui.status.dataset.state = overview.waiting ? 'waiting' : overview.phase?.kind || overview.state;
    if (!ui.detail.hidden) renderDetail();
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'result') {
      const pending = requests.get(message.requestId);
      if (!pending || message.chatId !== pending.chatId) return;
      clearTimeout(pending.timer); requests.delete(message.requestId);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.data);
    } else if (message.type === 'library') {
      library = { groups: list(message.library?.groups), chats: list(message.library?.chats) };
      libraryError.hidden = true;
      if (selected && !library.chats.some(chat => chat.id === selected)) {
        generation++; cancelRequests(); view?.dispose(); view = undefined; ui = undefined; selected = undefined; save();
        dashboard.replaceChildren(el('p', 'The selected Chat is no longer available (deleted or moved to Trash). Choose another Chat.', 'pkm-vis-empty'));
      }
      renderTree();
      const target = message.select || (!view && selected);
      if (target) void select(target);
      else if (message.changed) view?.notify();
    } else if (message.type === 'select') void select(message.chatId);
    else if (message.type === 'notice') { if (ui) showError(message.message); else { libraryError.textContent = message.message; libraryError.hidden = false; } }
    else if (message.type === 'libraryError') { libraryError.textContent = message.message; libraryError.hidden = false; }
  });
  host.postMessage({ type: 'ready' });
})();
