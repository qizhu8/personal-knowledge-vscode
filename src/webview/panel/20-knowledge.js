// ── Tabs ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => {
    if (state.tab === 'servers' && t.dataset.tab !== 'servers') stopSubscribedServerMonitoring();
    state.tab = t.dataset.tab; state.filter = 'all'; state.search = '';
    currentDetail = null;
    currentDetailRequest = null;
    vscode.setState({ ...(vscode.getState() || {}), tab: state.tab });
    document.getElementById('searchbox').value = '';
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === state.tab));
    const _detail = document.getElementById('detail');
    _detail.style.padding = ''; _detail.style.overflow = '';   // reset chatroom overrides
    renderEmptyDetail();
    closePaperViews();
    updatePaperChrome();
    const fullWidthTab = ['mcp', 'environments', 'servers', 'subscriptions', 'chatroom'].includes(state.tab);
    document.getElementById('layout-resizer').style.display = fullWidthTab ? 'none' : '';
    document.getElementById('sidebar-toggle').style.display = fullWidthTab ? 'none' : '';
    document.getElementById('content-toolbar').style.display = fullWidthTab ? 'none' : '';
    if (state.tab === 'mcp') {
      // Hide sidebar for MCP full-width pane
      document.getElementById('sidebar').style.display = 'none';
      document.getElementById('searchbox').style.display = 'none';
      renderMcpLoading();
      ask('checkMcp', {});
    } else if (state.tab === 'environments') {
      document.getElementById('sidebar').style.display = 'none';
      document.getElementById('searchbox').style.display = 'none';
      document.getElementById('detail').innerHTML = '<div class="empty">Loading environments…</div>';
      ask('envList', {});
    } else if (state.tab === 'servers') {
      document.getElementById('sidebar').style.display = 'none';
      document.getElementById('searchbox').style.display = 'none';
      document.getElementById('detail').innerHTML = '<div class="empty">Loading servers…</div>';
      ask('serverList', {});
      ask('serverGroupList', {});
    } else if (state.tab === 'subscriptions') {
      document.getElementById('sidebar').style.display = 'none';
      document.getElementById('searchbox').style.display = 'none';
      renderSubscriptionLoading();
      ask('subscriptionState', {});
    } else if (state.tab === 'chatroom') {
      document.getElementById('sidebar').style.display = 'none';
      document.getElementById('searchbox').style.display = 'none';
      renderChatroom();
      ask('chatState', {});
    } else {
      document.getElementById('sidebar').style.display = '';
      document.getElementById('searchbox').style.display = '';
      applyMainSidebarState();
      if (state.tab === 'papers') { ask('paperFacets', {}); ask('paperGroups', {}); }
      if (state.tab === 'notes') { ask('noteFolderPins', {}); }
      ask('list', { tab: state.tab, filter: 'all', q: '' });
    }
  })
);

// Show/hide the Papers-specific topbar buttons.
function updatePaperChrome() {
  const on = state.tab === 'papers';
  document.getElementById('btn-add-paper').style.display = on ? '' : 'none';
  document.getElementById('btn-paper-graph').style.display = on ? '' : 'none';
  relayoutTopbar();
}
// Return to the plain list/detail view (hide paper form + graph).
function closePaperViews() {
  document.getElementById('paper-form').classList.add('hidden');
  document.getElementById('paper-graph-view').classList.add('hidden');
  document.getElementById('note-form').classList.add('hidden');
  document.getElementById('detail').style.display = '';
  paperGraphOpen = false;
  const gb = document.getElementById('btn-paper-graph');
  if (gb) gb.textContent = '🕸 Graph';
}

function contentSearchChanged(requestList = true) {
  const input = document.getElementById('searchbox');
  const options = findOptions('content');
  state.search = input.value.trim();
  highlightDetailMatches(document.getElementById('layout'), state.search);
  if (!requestList) return;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    if (compileFindPattern(state.search, options.regex, options.caseSensitive) !== false)
      ask('list', { tab: state.tab, filter: state.filter, q: state.search, regex: options.regex, caseSensitive: options.caseSensitive });
  }, 250);
}
document.getElementById('searchbox').addEventListener('input', e => {
  contentSearchChanged(true);
});

function folkDisplayName(value) {
  const raw = String(value || '');
  if (!raw.startsWith('_folk_') || raw.length === 6) return esc(raw);
  const displayName = raw.slice(6).replace(/--[a-f0-9]{12}$/i, '');
  return `<span class="folk-source-name">${esc(displayName)}</span><span class="folk-badge" title="Forked content awaiting organization">folk</span>`;
}

function folkDisplayPath(value) {
  const parts = String(value || '').replace(/\\/g, '/').split('/');
  if (!parts[0].startsWith('_folk_')) return esc(value);
  return [folkDisplayName(parts[0]), ...parts.slice(1).map(esc)].join('<span class="folk-path-separator"> / </span>');
}

function packageSourceTag(source) {
  if (!source) return '';
  return `<span class="pkg-source-tag" title="Original package ${esc(source.originalName)} from ${esc(source.brokerName)} published by ${esc(source.publisherUser)} on ${esc(source.publisherHost)}">original: ${esc(source.originalName)} · ${esc(source.brokerName)} - ${esc(source.publisherUser)} - ${esc(source.publisherHost)}</span>`;
}

function privacyInherited(path) {
  const top = String(Array.isArray(path) ? path[0] || '' : path || '').replace(/\\/g, '/').split('/').filter(Boolean)[0] || '';
  return !!top && (state.privateTopLevels || []).includes(top);
}
function privacyLock(isPrivate) { return isPrivate ? '<span class="content-private-lock" title="Private: excluded from Subscription sharing" aria-label="Private">🔒</span>' : ''; }
function appendPrivacyMenu(items, type, path) {
  const parts = String(path || '').split('/').filter(Boolean);
  if (parts.length !== 1) return;
  const isPrivate = privacyInherited(parts);
  items.push({ sep: true });
  items.push({ label: isPrivate ? '🔓 Set as Public' : '🔒 Set as Private', onClick: () => ask('contentSetPrivacy', { type, topLevel: parts[0], isPrivate: !isPrivate }) });
}

// ── Render list ────────────────────────────────────────────────────────────
function renderList() {
  const { tab, items, filter } = state;
  const el = document.getElementById('item-list');
  const fEl = document.getElementById('sidebar-filters');

  if (tab === 'skills') {
    fEl.innerHTML = '';
    const q = state.search;
    // Recursive N-level tree by category path; leaf = skill (shows skill name)
    const root = buildCatTree(items, r => r.category, '(uncategorized)');
    seedFolders(root, state.folders);
    // Right-click a folder to rename it (re-paths all skills under it).
    const folderAttr = (child, name, fullPath) => {
      const prefix = fullPath.join('/');
      if (prefix === '(uncategorized)' || fullPath[0] === '(uncategorized)') return '';
      const b64 = btoa(unescape(encodeURIComponent(prefix)));
      return ` oncontextmenu="skillFolderMenu(event,'${b64}',${JSON.stringify(name).replace(/"/g, '&quot;')})"`;
    };
    const html = renderCatTree(root, [], 0, (r, depth) =>
      skillLi(r, r.name, q, 8 + (depth + 1) * 12), q, folderAttr, { isLeafPinned: it => !!it.pinned });
    el.innerHTML = html || '<div class="empty">No skills</div>';

  } else if (tab === 'notes') {
    // Recursive N-level tree by category path. Pinned notes sort to the top of
    // their own folder; pinned folders sort before sibling folders (same level).
    fEl.innerHTML = '';
    const q = state.search;
    const folderAttr = (child, name, fullPath) => {
      const prefix = fullPath.join('/');
      if (prefix === '(uncategorized)' || fullPath[0] === '(uncategorized)') return '';
      const b64 = btoa(unescape(encodeURIComponent(prefix)));
      return ` oncontextmenu="noteFolderMenu(event,'${b64}',${JSON.stringify(name).replace(/"/g, '&quot;')})"`;
    };
    const root = buildCatTree(items, r => r.category, '(uncategorized)');
    seedFolders(root, state.folders);
    const order = {
      isFolderPinned: (arr) => notePinnedFolders.includes(arr.join('/')),
      isLeafPinned: (it) => !!it.pinned,
    };
    const html = renderCatTree(root, [], 0, (r, depth) => noteLi(r, q, 8 + (depth + 1) * 12), q, folderAttr, order);
    el.innerHTML = html || '<div class="empty">No notes</div>';

  } else if (tab === 'papers') {
    renderPaperFilters(fEl);
    const q = state.search;
    let list = items.slice();
    if (paperTopicFilter) list = list.filter(p => p.topic === paperTopicFilter);
    const pinned = list.filter(p => p.pinned);
    const rest = list.filter(p => !p.pinned);
    // Right-click a topic folder -> move all papers under it to a group.
    const folderAttr = (child, name, fullPath) => {
      const slugs = collectLeafSlugs(child);
      const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(slugs))));
      return ` oncontextmenu="paperFolderMenu(event,'${b64}',${JSON.stringify(name).replace(/"/g, '&quot;')},${JSON.stringify(fullPath.join('/')).replace(/"/g, '&quot;')})"`;
    };
    let html = '';
    if (pinned.length) {
      html += '<div class="pk-group pk-group-pinned"><div class="pk-group-hdr">' +
        '<span class="pk-group-arrow">★</span><span class="pk-group-name">Pinned</span>' +
        '<span class="pk-group-count">' + pinned.length + '</span></div><div class="pk-group-body">' +
        pinned.sort((a, b) => (b.citationCount - a.citationCount) || a.title.localeCompare(b.title)).map(p => paperCard(p, q, 8)).join('') +
        '</div></div>';
    }
    // Top-level = user-assigned group; custom groups pinned above the default "Papers".
    const groups = {};
    for (const p of rest) { const g = p.group || 'Papers'; (groups[g] = groups[g] || []).push(p); }
    const names = Object.keys(groups).sort((a, b) => a === 'Papers' ? 1 : b === 'Papers' ? -1 : a.localeCompare(b));
    for (const g of names) {
      const expanded = paperGroupExpanded[g] !== false;
      const custom = g !== 'Papers';
      html += '<div class="pk-group' + (custom ? ' pk-group-custom' : '') + '">' +
        '<div class="pk-group-hdr" onclick="togglePaperGroup(' + JSON.stringify(g).replace(/"/g, '&quot;') + ')" ' +
        'oncontextmenu="paperGroupMenu(event,' + JSON.stringify(g).replace(/"/g, '&quot;') + ')">' +
        '<span class="pk-group-arrow">' + (expanded ? '▼' : '▶') + '</span>' +
        '<span class="pk-group-name">' + (custom ? '📁' : '📄') + ' ' + esc(g) + '</span>' +
        '<span class="pk-group-count">' + groups[g].length + '</span></div>' +
        '<div class="pk-group-body" style="display:' + (expanded ? '' : 'none') + '">';
      const root = buildCatTree(groups[g], r => r.category || '(uncategorized)', '(uncategorized)');
      html += renderCatTree(root, [], 0, (r, depth) => paperCard(r, q, 8 + (depth + 1) * 12), q, folderAttr);
      html += '</div></div>';
    }
    el.innerHTML = html || '<div class="empty">No papers yet — click “+ Paper”.</div>';

  } else if (tab === 'prompts') {
    // Tree: project → task → versions → files
    const projs = [...new Set(items.map(r => r.project))].sort();
    fEl.innerHTML = ['all',...projs].map(p =>
      `<span class="chip ${filter===p?'active':''}" onclick="setFilter('${p}')">${folkDisplayPath(p)}</span>`).join('');
    const shown = filter==='all' ? items : items.filter(r => r.project===filter);
    // Group by project
    const byProj = {};
    shown.forEach(r => { (byProj[r.project]||(byProj[r.project]=[])).push(r); });
    el.innerHTML = Object.entries(byProj).map(([proj, tasks]) =>
      `<div class="tree-proj">
        <div class="tree-proj-hdr" onclick="toggleTree(this)" oncontextmenu="promptFolderMenu(event,${JSON.stringify(proj).replace(/"/g,'&quot;')},'','')">▶ ${privacyLock(privacyInherited([proj]))}${folkDisplayPath(proj)}</div>
        <div class="tree-proj-body collapsed">${tasks.map(r =>
          `<div class="tree-task">
            <div class="tree-task-hdr" onclick="toggleTree(this)" oncontextmenu="promptFolderMenu(event,${JSON.stringify(proj).replace(/"/g,'&quot;')},${JSON.stringify(r.task).replace(/"/g,'&quot;')},'')">▷ ${privacyLock(r.isPrivate)}${esc(r.task)}</div>
            <div class="tree-task-body collapsed">${(r.versions||[]).map(v =>
              `<div class="tree-ver">
                <div class="tree-ver-hdr" onclick="toggleTree(this)" oncontextmenu="promptFolderMenu(event,${JSON.stringify(proj).replace(/"/g,'&quot;')},${JSON.stringify(r.task).replace(/"/g,'&quot;')},${JSON.stringify(v.version).replace(/"/g,'&quot;')})">📁 ${privacyLock(r.isPrivate)}${esc(v.version)}</div>
                <div class="tree-ver-body collapsed">${(v.files||[]).map(f =>
                  `<div class="tree-file" data-prompt-project="${esc(proj)}" data-prompt-task="${esc(r.task)}" data-prompt-version="${esc(v.version)}" data-prompt-file="${esc(f.name)}" onclick="openPromptFile('${esc(proj)}','${esc(r.task)}','${esc(v.version)}','${esc(f.name)}')" oncontextmenu="promptItemTrashMenu(event,${JSON.stringify(`${proj}/${r.task}/${v.version}/${f.name}`).replace(/"/g,'&quot;')},${JSON.stringify(f.name).replace(/"/g,'&quot;')},${JSON.stringify(proj).replace(/"/g,'&quot;')},${JSON.stringify(r.task).replace(/"/g,'&quot;')},${JSON.stringify(v.version).replace(/"/g,'&quot;')})">📄 ${privacyLock(r.isPrivate)}${esc(f.name)}</div>`
                ).join('')}</div>
              </div>`
            ).join('')}</div>
          </div>`
        ).join('')}</div>
      </div>`
    ).join('') || '<div class="empty">No prompts</div>';
    if (currentDetail?.type === 'prompt') highlightSelectedPromptTree(currentDetail);

  } else if (tab === 'packages') {
    const langs = [...new Set(items.map(r => r.lang))].sort();
    fEl.innerHTML = ['all',...langs].map(l =>
      `<span class="chip ${filter===l?'active':''}" onclick="setFilter('${l}')">${l}</span>`).join('');
    const shown = filter==='all' ? items : items.filter(r => r.lang===filter);
    el.innerHTML = `<div class="sub-virtual-divider local-packages"><span>Local Packages</span></div>` + (shown.map(r => {
      const gitTag = r.gitRepo
        ? '<span class="pkg-git repo" title="Has its own .git repository">git repo</span>'
        : r.gitTracked
          ? '<span class="pkg-git tracked" title="Tracked in the knowledge store\'s git">git</span>'
          : '<span class="pkg-git untracked" title="Not tracked by git yet (uncommitted)">untracked</span>';
          const sourceTag = packageSourceTag(r.source);
      return `<div class="li" onclick="openItem('package','${esc(r.name)}')" oncontextmenu="packageItemMenu(event,${JSON.stringify(r.name).replace(/"/g,'&quot;')})">
      <div class="li-name">${privacyLock(r.isPrivate)}${folkDisplayPath(r.name)} ${gitTag}</div>
          <div class="li-meta">${esc(r.lang)} · ${esc((r.description||'').slice(0,50))}${sourceTag}</div>
    </div>`;
    }).join('') || '<div class="empty">No local packages</div>');

  } else if (tab === 'scripts') {
    // Recursive N-level tree by folder path; leaf = script file with language tag
    fEl.innerHTML = '';
    const q = state.search;
    const root = buildCatTree(items, r => (r.category === '(root)' ? '' : r.category), '(root)');
    const folderAttr = (child, name, fullPath) => {
      const prefix = fullPath.join('/');
      if (prefix === '(root)' || fullPath[0] === '(root)') return '';
      const b64 = btoa(unescape(encodeURIComponent(prefix)));
      return ` oncontextmenu="scriptFolderMenu(event,'${b64}',${JSON.stringify(name).replace(/"/g, '&quot;')})"`;
    };
    const html = renderCatTree(root, [], 0, (r, depth) => {
      const pad = 8 + (depth + 1) * 12;
      const cat = r.category === '(root)' ? '' : r.category;
      return `<div class="li" style="padding-left:${pad}px" onclick="openItem('script','${esc(r.path)}')" oncontextmenu="scriptItemMenu(event,'${esc(r.path)}',${JSON.stringify(cat).replace(/"/g, '&quot;')})">
        <div class="li-name">📄 ${privacyLock(r.isPrivate)}${hl(r.file, q)}</div>
        <div class="li-meta">${cat ? `<span style="margin-right:5px">${hl(cat, q)}</span>` : ''}${(r.langs||(r.lang?r.lang.split(' + '):[])).map(l=>`<span class="cat" style="font-size:9px;margin-right:3px">${hl(l, q)}</span>`).join('')}</div>
      </div>`;
    }, q, folderAttr);
    el.innerHTML = html || '<div class="empty">No scripts</div>';
  }
  renderSubscribedGroups(el);
  renderKnowledgeTrashDock(tab);
}

function renderSubscribedGroups(container) {
  const groups = state.subscriptionGroups || [];
  if (!groups.length) return;
  const html = groups.map(group => {
    const groupPayload = subscriptionEncodeForkPayload({ name:group.alias, keys:group.items.map(item => item.key) });
    return `<div class="pk-group sub-virtual-group">
    <div class="pk-group-hdr" onclick="this.nextElementSibling.classList.toggle('collapsed')" oncontextmenu="subscriptionGroupForkMenu(event,'${groupPayload}')">
      <span class="pk-group-arrow">◈</span><span class="pk-group-name">${esc(group.alias)}</span><span class="pk-group-count">${group.items.length}</span>${state.tab === 'skills' ? `<button class="sub-fork-btn" data-pending-label="Forking…" onclick="event.stopPropagation();subscriptionForkAll('${groupPayload}',this)">Fork All</button>` : ''}
    </div>
    <div class="pk-group-body collapsed">${subscriptionRenderItemTree(subscriptionBuildItemTree(group.items), 0, group.revision)}</div>
  </div>`;
  }).join('');
  container.insertAdjacentHTML('beforeend', `<div class="sub-virtual-divider"><span>${state.tab === 'packages' ? 'Subscribed Packages' : 'Subscriptions'}</span></div>${html}`);
}

function subscriptionBuildItemTree(items) {
  const root = { folders:{}, items:[] };
  for (const item of items) {
    const parts = String(item.path || item.title || '').replace(/\\/g, '/').split('/').filter(Boolean);
    let node = root;
    for (const folder of parts.slice(0, -1)) node = node.folders[folder] ||= { folders:{}, items:[] };
    node.items.push(item);
  }
  return root;
}

function subscriptionRenderItemTree(node, depth, revision, parentPath = []) {
  const folders = Object.entries(node.folders).sort(([left],[right]) => left.localeCompare(right)).map(([name,child]) => {
    const folderPath = [...parentPath, name];
    const payload = subscriptionEncodeForkPayload({ path:folderPath.join('/'), keys:subscriptionCachedTreeItems(child).map(item => item.key) });
    return `<details class="sub-cache-folder"><summary style="padding-left:${8 + depth * 12}px" oncontextmenu="subscriptionFolderForkMenu(event,'${payload}')"><span class="sub-cache-arrow">›</span><span class="sub-cache-name">${esc(name)}</span><small>${subscriptionTreeCount(child)}</small></summary><div>${subscriptionRenderItemTree(child, depth + 1, revision, folderPath)}</div></details>`;
  }
  ).join('');
  const leaves = node.items.sort((left,right) => left.title.localeCompare(right.title)).map(item => `<div class="li sub-virtual-item" style="padding-left:${8 + depth * 12}px" onclick="openItem('subscriptionItem','${esc(item.key)}')" oncontextmenu="subscriptionItemForkMenu(event,'${subscriptionEncodeForkPayload({key:item.key,title:item.title})}')" title="${esc(item.path)}">
    <div class="li-name"><span>${esc(item.title)}</span><button class="sub-fork-btn" data-pending-label="Forking…" onclick="event.stopPropagation();subscriptionFork('${esc(item.key)}',this)" title="Create an independent local copy">Fork</button></div><div class="li-meta">${esc(item.path)} · revision ${Number(revision)||0}</div>
  </div>`).join('');
  return folders + leaves;
}

function subscriptionCachedTreeItems(node) { return [...node.items, ...Object.values(node.folders).flatMap(subscriptionCachedTreeItems)]; }
function subscriptionEncodeForkPayload(value) { return btoa(unescape(encodeURIComponent(JSON.stringify(value)))); }
function subscriptionDecodeForkPayload(value) { return JSON.parse(decodeURIComponent(escape(atob(value)))); }

function subscriptionFolderForkMenu(ev, payload) {
  ev.preventDefault(); ev.stopPropagation();
  let folderPath = '', keys = [];
  try { ({ path:folderPath, keys } = subscriptionDecodeForkPayload(payload)); } catch { return; }
  showPaperMenu(ev.clientX, ev.clientY, [
    { label:'Folder · ' + folderPath, header:true },
    { label: 'Fork to Local', onClick: () => ask('subscriptionFork', { keys, path: folderPath }) },
  ]);
}

function subscriptionItemForkMenu(ev, payload) {
  ev.preventDefault(); ev.stopPropagation();
  let key = '', title = '';
  try { ({ key, title } = subscriptionDecodeForkPayload(payload)); } catch { return; }
  showPaperMenu(ev.clientX, ev.clientY, [
    { label:'Subscribed · ' + title, header:true },
    { label:'Fork to Local', onClick:() => subscriptionFork(key) },
  ]);
}

function subscriptionGroupForkMenu(ev, payload) {
  if (state.tab !== 'skills') return;
  ev.preventDefault(); ev.stopPropagation();
  let group;
  try { group = subscriptionDecodeForkPayload(payload); } catch { return; }
  showPaperMenu(ev.clientX, ev.clientY, [
    { label:'Subscribed Skills · ' + group.name, header:true },
    { label:'Fork entire Broker to Local', onClick:() => ask('subscriptionFork',{keys:group.keys,path:''}) },
  ]);
}

function subscriptionForkAll(payload, button) {
  let group;
  try { group = subscriptionDecodeForkPayload(payload); } catch { return; }
  ask('subscriptionFork',{keys:group.keys,path:''},button);
}

function subscriptionFork(key, button) { ask('subscriptionFork', { key }, button); }

function renderKnowledgeTrashDock(area) {
  const dock = document.getElementById('knowledge-trash-dock');
  if (!dock) return;
  const visible = ['skills','notes','papers','prompts','scripts'].includes(area);
  dock.classList.toggle('hidden', !visible);
  if (!visible) { dock.replaceChildren(); return; }
  const entries = state.knowledgeTrash || [];
  dock.innerHTML = `<div class="knowledge-trash-popover hidden">${entries.length ? entries.map(entry => `<div class="li knowledge-trash-item"><div class="li-name"><span>${entry.kind === 'folder' ? '📁' : '📄'} ${esc(entry.name)}</span><span class="knowledge-trash-actions"><button class="sub-fork-btn" data-pending-label="Restoring…" onclick="restoreKnowledgeTrash('${area}','${esc(entry.id)}',this)">Restore</button><button class="sub-fork-btn danger" onclick="deleteKnowledgeTrashEntry('${area}','${esc(entry.id)}','${esc(entry.name)}','${esc(entry.kind)}')">Delete Permanently</button></span></div><div class="li-meta">${esc(entry.originalPath)} · ${entry.deletedAt ? new Date(entry.deletedAt).toLocaleString() : ''}</div></div>`).join('') : '<div class="empty">Trash is empty</div>'}</div><div class="knowledge-trash-dock-row" role="button" tabindex="0" aria-expanded="false" onclick="toggleKnowledgeTrashDock()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleKnowledgeTrashDock()}"><span>Trash</span><span class="pk-group-count">${entries.length}</span><button class="knowledge-trash-empty" onclick="event.stopPropagation();emptyKnowledgeTrash('${area}')" title="Permanently delete everything in ${area} Trash" ${entries.length ? '' : 'disabled'}>Empty Trash</button><i>▴</i></div>`;
}

function toggleKnowledgeTrashDock() {
  const dock = document.getElementById('knowledge-trash-dock');
  const popover = dock?.querySelector('.knowledge-trash-popover');
  const row = dock?.querySelector('.knowledge-trash-dock-row');
  if (!popover || !row) return;
  const open = !popover.classList.toggle('hidden');
  row.classList.toggle('active', open);
  row.setAttribute('aria-expanded', String(open));
}

function emptySkillTrash() {
  pkModal({ title:'Empty Skills Trash?', message:'Permanently delete every Skill and folder in Trash? This cannot be undone.', okLabel:'Empty Trash', danger:true, onOk:()=>ask('skillTrashEmpty',{}) });
}

function restoreKnowledgeTrash(area, id, button) {
  if (area === 'skills') ask('skillTrashRestore',{id},button); else ask('knowledgeTrashRestore',{area,id},button);
}

function emptyKnowledgeTrash(area) {
  pkModal({ title:`Empty ${area} Trash?`, message:`Permanently delete every item and folder in ${area} Trash? This cannot be undone.`, okLabel:'Empty Trash', danger:true, onOk:()=>ask(area === 'skills' ? 'skillTrashEmpty' : 'knowledgeTrashEmpty', area === 'skills' ? {} : {area}) });
}

function deleteKnowledgeTrashEntry(area, id, name, kind) {
  pkModal({ title:`Permanently delete ${kind} "${name}"?`, message:'This removes only this Trash entry and cannot be undone.', okLabel:'Delete Permanently', danger:true, onOk:()=>ask(area === 'skills' ? 'skillTrashDelete' : 'knowledgeTrashDelete', area === 'skills' ? {id} : {area,id}) });
}

function deleteSkillTrashEntry(id, name, kind) {
  pkModal({ title:`Permanently delete ${kind} "${name}"?`, message:'This removes only this Trash entry and cannot be undone.', okLabel:'Delete Permanently', danger:true, onOk:()=>ask('skillTrashDelete',{id}) });
}

function skillLi(r, displayName, q, indent) {
  return `<div class="li${r.pinned ? ' nt-pinned' : ''}" data-skill-name="${esc(r.name)}" onclick="openItem('skill','${esc(r.name)}')" oncontextmenu="skillItemMenu(event,'${esc(r.name)}',${JSON.stringify(r.category || '').replace(/"/g, '&quot;')})" style="padding-left:${indent}px">
    <div class="li-name"><span class="pc-star${r.pinned ? ' on' : ''}" onclick="event.stopPropagation();toggleSkillPin('${esc(r.name)}',${r.pinned ? 'false' : 'true'})" title="${r.pinned ? 'Unpin' : 'Pin to top of folder'}">${r.pinned ? '★' : '☆'}</span> ${privacyLock(r.isPrivate)}${hl(displayName||r.name, q)}</div>
    <div class="li-meta">${r.description ? hl(r.description.slice(0,50), q) : ''}</div>
  </div>`;
}

function toggleSkillPin(name, pinned) {
  ask('skillSetPinned', { name, pinned });
  if (currentDetail && currentDetail.type === 'skill' && currentDetail.name === name) {
    currentDetail.pinned = pinned; renderDetail(currentDetail);
  }
}

// A note row in the sidebar tree (with a ★ pin toggle). Right-click uses #ctx-menu.
function noteLi(r, q, indent) {
  return `<div class="li nt-${r.type}${r.pinned ? ' nt-pinned' : ''}" data-note-slug="${esc(r.slug)}" data-note-pinned="${r.pinned ? '1' : ''}" style="padding-left:${indent}px" onclick="openItem('note','${esc(r.slug)}')">
    <div class="li-name"><span class="pc-star${r.pinned ? ' on' : ''}" onclick="event.stopPropagation();toggleNotePin('${esc(r.slug)}',${r.pinned ? 'false' : 'true'})" title="${r.pinned ? 'Unpin' : 'Pin to top of folder'}">${r.pinned ? '★' : '☆'}</span> ${ICON[r.type]||'📝'} ${privacyLock(r.isPrivate)}${hl(r.title, q)}</div>
    <div class="li-meta">${(r.updated_at||'').slice(0,10)}</div>
  </div>`;
}
function toggleNotePin(slug, pinned) {
  ask('noteSetPinned', { slug, pinned });
  if (currentDetail && currentDetail.type === 'note' && currentDetail.slug === slug) {
    currentDetail.pinned = pinned; renderDetail(currentDetail);
  }
}

// ── Recursive category tree (shared by Skills & Notes panels) ───────────────
function buildCatTree(items, getCat, fallback) {
  const root = { folders: {}, items: [] };
  (items || []).forEach(it => {
    const cat = (getCat(it) || '').trim();
    const segs = cat ? cat.split('/').map(s => s.trim()).filter(Boolean) : [fallback];
    let node = root;
    for (const seg of segs) {
      node.folders[seg] = node.folders[seg] || { folders: {}, items: [] };
      node = node.folders[seg];
    }
    node.items.push(it);
  });
  return root;
}

// Ensure each given folder path exists as a (possibly empty) branch in the tree,
// so user-created empty folders render even with no items yet.
function seedFolders(root, folders) {
  for (const f of (folders || [])) {
    const segs = String(f).split('/').map(s => s.trim()).filter(Boolean);
    let node = root;
    for (const seg of segs) { node.folders[seg] = node.folders[seg] || { folders: {}, items: [] }; node = node.folders[seg]; }
  }
}

function countTreeLeaves(node) {
  let n = node.items.length;
  for (const k in node.folders) n += countTreeLeaves(node.folders[k]);
  return n;
}

function renderCatTree(node, path, depth, renderLeaf, q, folderAttr, order) {
  const isFP = (order && order.isFolderPinned) ? order.isFolderPinned : null;
  const folderKeys = Object.keys(node.folders).sort((a, b) => {
    if (a === '(uncategorized)') return 1;
    if (b === '(uncategorized)') return -1;
    if (isFP) { const pa = isFP(path.concat(a)) ? 0 : 1, pb = isFP(path.concat(b)) ? 0 : 1; if (pa !== pb) return pa - pb; }
    return a.localeCompare(b);
  });
  let html = '';
  for (const name of folderKeys) {
    const child = node.folders[name];
    if (q && countTreeLeaves(child) === 0) continue;
    // Base64 key: safe inside HTML attrs and JS strings (no quotes/null/unicode issues)
    const key = btoa(unescape(encodeURIComponent(JSON.stringify(path.concat(name)))));
    const open = !!catExpanded[key];
    const pad = 8 + depth * 12;
    const pinnedFolder = isFP && name !== '(uncategorized)' && isFP(path.concat(name));
    html += `<div class="tree-cat">
      <div class="tree-cat-hdr${pinnedFolder ? ' cat-pinned' : ''}" style="padding-left:${pad}px" onclick="toggleCat('${key}')" title="${esc(name)}"${folderAttr ? folderAttr(child, name, path.concat(name)) : ''}>
        <span class="tree-cat-arrow">${open ? '▾' : '▸'}</span>
        <span class="tree-cat-label">${pinnedFolder ? '★ ' : ''}${privacyLock(privacyInherited(path.concat(name)))}${name === '(uncategorized)' ? '<em style="opacity:.6">(uncategorized)</em>' : path.length === 0 ? folkDisplayName(name) : esc(name)}</span>
        <span class="tree-cat-count">${countTreeLeaves(child)}</span>
      </div>
      <div class="tree-cat-body" style="${open ? '' : 'display:none'}">${renderCatTree(child, path.concat(name), depth + 1, renderLeaf, q, folderAttr, order)}</div>
    </div>`;
  }
  let leaves = node.items;
  if (order && order.isLeafPinned) leaves = [...leaves].sort((a, b) => (order.isLeafPinned(b) ? 1 : 0) - (order.isLeafPinned(a) ? 1 : 0));
  for (const it of leaves) html += renderLeaf(it, depth, q);
  return html;
}
// Collect all leaf slugs under a cat-tree folder (papers only).
function collectLeafSlugs(node) {
  let out = (node.items || []).map(it => it.slug).filter(Boolean);
  for (const k in node.folders) out = out.concat(collectLeafSlugs(node.folders[k]));
  return out;
}

function setFilter(f) { state.filter = f; renderList(); }
function setNoteFilter(f) { state.filter = f; renderList(); }

// ── Open detail ────────────────────────────────────────────────────────────
function requestDetail(type, key) {
  currentDetailRequest = { type, key };
  ask('detail', currentDetailRequest);
}
function openItem(type, key) {
  document.querySelectorAll('.li').forEach(l => l.classList.remove('active'));
  event?.currentTarget?.classList?.add('active');
  requestDetail(type, key);
}

function openPromptFile(proj, task, ver, fname) {
  requestDetail('prompt', proj+'|'+task+'|'+ver+'|'+fname);
}

function highlightSelectedPromptTree(data) {
  document.querySelectorAll('.tree-file.prompt-selected,.tree-file.prompt-related').forEach(node => node.classList.remove('prompt-selected','prompt-related'));
  if (!data || data.type !== 'prompt') return;
  const related = new Set(data.analysis?.relatedFiles || []);
  document.querySelectorAll('.tree-file[data-prompt-file]').forEach(node => {
    const sameVersion = node.dataset.promptProject === data.project && node.dataset.promptTask === data.task && node.dataset.promptVersion === data.version;
    if (!sameVersion) return;
    if (node.dataset.promptFile === data.file) node.classList.add('prompt-selected');
    else if (related.has(node.dataset.promptFile)) node.classList.add('prompt-related');
    if (!node.classList.contains('prompt-selected') && !node.classList.contains('prompt-related')) return;
    const versionBody = node.closest('.tree-ver-body');
    const taskBody = node.closest('.tree-task-body');
    const projectBody = node.closest('.tree-proj-body');
    [versionBody,taskBody,projectBody].forEach(body => body?.classList.remove('collapsed'));
    const taskHeader = node.closest('.tree-task')?.querySelector('.tree-task-hdr');
    const projectHeader = node.closest('.tree-proj')?.querySelector('.tree-proj-hdr');
    if (taskHeader) taskHeader.innerHTML = taskHeader.innerHTML.replace(/^▷/, '▽');
    if (projectHeader) projectHeader.innerHTML = projectHeader.innerHTML.replace(/^▶/, '▼');
  });
}

function promptOpenInheritanceFile(button) {
  if (!currentDetail || currentDetail.type !== 'prompt' || button.dataset.missing === 'true') return;
  openPromptFile(currentDetail.project, currentDetail.task, currentDetail.version, button.dataset.file);
}

function promptInheritanceTreeHtml(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return '<div class="prompt-inheritance-empty">Standalone template · no inheritance chain</div>';
  const chips = values => values.length ? values.map(value => `<span>${esc(value)}</span>`).join('') : '<em>none</em>';
  const render = (node, depth) => `<li class="prompt-inheritance-node${node.selected?' selected':''}${node.exists===false?' missing':''}" style="--depth:${depth}">
    <button type="button" data-file="${esc(node.file)}" data-missing="${node.exists===false}" onclick="promptOpenInheritanceFile(this)" ${node.exists===false?'disabled':''}><strong>${esc(node.file)}</strong>${node.selected?'<b>Selected</b>':''}${node.exists===false?'<b>Missing</b>':''}</button>
    ${node.extends?`<div class="prompt-inheritance-edge">extends from <code>${esc(node.extends)}</code></div>`:''}
    <div class="prompt-inheritance-vars"><label>inherits</label><div>${chips(node.inheritedPlaceholders||[])}</div><label>introduces</label><div>${chips(node.introducedVariables||[])}</div></div>
    ${(node.children||[]).length?`<ol>${node.children.map(child=>render(child,depth+1)).join('')}</ol>`:''}
  </li>`;
  return `<ol class="prompt-inheritance-tree">${nodes.map(node=>render(node,0)).join('')}</ol>`;
}

function openPromptDiff(proj, task, fname) {
  requestDetail('promptDiff', proj+'|'+task+'|'+fname);
}

function toggleTree(hdr) {
  const body = hdr.nextElementSibling;
  if (!body) return;
  const collapsed = body.classList.toggle('collapsed');
  const arrow = hdr.textContent[0];
  if (arrow === '▶') hdr.textContent = '▼' + hdr.textContent.slice(1);
  else if (arrow === '▼') hdr.textContent = '▶' + hdr.textContent.slice(1);
  else if (arrow === '▷') hdr.textContent = '▽' + hdr.textContent.slice(1);
  else if (arrow === '▽') hdr.textContent = '▷' + hdr.textContent.slice(1);
}

function openPrompt(proj, task, ver) {
  requestDetail('prompt', proj+'|'+task+'|'+ver);
}

let promptWorkspaceTab = 'source';
let promptRenderMode = 'completion';
const promptVersionStatuses = new Map();
const promptDatasets = new Map();
const promptTaskVariableSets = new Map();
const promptRenderDrafts = new Map();

function promptDatasetKey() {
  return currentDetail?.type === 'prompt' ? [currentDetail.project,currentDetail.task].join('|') : '';
}

function promptRenderDraftKey() {
  return currentDetail?.type === 'prompt' ? [currentDetail.project,currentDetail.task,currentDetail.version,currentDetail.file].join('|') : '';
}

function promptVersionCompare(left, right) {
  const parse = value => String(value).replace(/^v/i, '').split('.').map(part => Number(part) || 0);
  const a = parse(left), b = parse(right), length = Math.max(a.length,b.length);
  for (let index=0; index<length; index++) { const delta=(a[index]||0)-(b[index]||0); if (delta) return delta; }
  return String(left).localeCompare(String(right));
}

function promptVariableRanges(versions, present) {
  const ranges = [];
  let start = -1;
  for (let index=0; index<=versions.length; index++) {
    const included = index < versions.length && present.has(versions[index]);
    if (included && start < 0) start = index;
    if (!included && start >= 0) { ranges.push(`[${versions[start]}, ${versions[index-1]}]`); start = -1; }
  }
  return ranges.join(' ∪ ');
}

function promptOnTaskVariables(data) {
  promptTaskVariableSets.set([data.project,data.task,data.version].join('|'), new Set(data.variables || []));
  if (currentDetail?.type === 'prompt' && currentDetail.project === data.project && currentDetail.task === data.task) {
    promptRefreshVariableCoverage();
    promptRenderDatasetTable();
  }
}

function promptRefreshVariableCoverage() {
  const target = document.getElementById('prompt-variable-coverage');
  if (!target || !currentDetail || currentDetail.type !== 'prompt') return;
  const versions = [...(currentDetail.taskVersions || currentDetail.allVersions?.map(item => item.version) || [])].sort(promptVersionCompare);
  const analyzed = versions.filter(version => promptTaskVariableSets.has([currentDetail.project,currentDetail.task,version].join('|')));
  const variables = new Set();
  analyzed.forEach(version => promptTaskVariableSets.get([currentDetail.project,currentDetail.task,version].join('|'))?.forEach(variable => variables.add(variable)));
  promptRenderDatasetTable([...variables].sort());
  if (!variables.size) { target.innerHTML = `<div class="prompt-variable-empty">${analyzed.length < versions.length ? `Analyzing task variables… ${analyzed.length}/${versions.length} versions` : 'No Jinja variables found.'}</div>`; return; }
  target.innerHTML = [...variables].sort().map(variable => {
    const present = new Set(versions.filter(version => promptTaskVariableSets.get([currentDetail.project,currentDetail.task,version].join('|'))?.has(variable)));
    const all = present.size === versions.length && analyzed.length === versions.length;
    const range = promptVariableRanges(versions, present);
    const pending = analyzed.length < versions.length ? ` · analysis ${analyzed.length}/${versions.length}` : '';
    const title = `${variable}: ${range || 'not found'} · ${present.size}/${versions.length} versions${pending}`;
    return `<span class="prompt-variable-coverage ${all?'all':'partial'}" title="${esc(title)}"><strong>${esc(variable)}</strong><small>${all?'all':`${present.size}/${versions.length}`}</small></span>`;
  }).join('');
}

function promptParseDataset(text) {
  const source = String(text || '').trim();
  if (!source) throw new Error('Dataset is empty.');
  let value;
  try { value = JSON.parse(source); }
  catch {
    try { value = source.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
    catch (error) { throw new Error(`Use a JSON array/object or JSONL rows. ${error.message || error}`); }
  }
  const rows = Array.isArray(value) ? value : [value];
  if (!rows.length) throw new Error('Dataset has no rows.');
  if (rows.some(row => !row || Array.isArray(row) || typeof row !== 'object')) throw new Error('Every Dataset row must be a JSON object.');
  return rows;
}

function promptLoadDatasetText(text, name = 'Pasted Dataset') {
  const status = document.getElementById('prompt-dataset-status');
  try {
    promptDatasets.set(promptDatasetKey(), { name, rows:promptParseDataset(text), index:0 });
    promptRefreshDataset();
    promptRenderDatasetTable();
    promptLoadDatasetRowIntoDraft();
  } catch (error) {
    if (status) { status.textContent = error.message || String(error); status.classList.add('error'); }
  }
}

function promptLoadDatasetFile(input) {
  const file = input.files?.[0]; input.value = '';
  if (!file) return;
  const status = document.getElementById('prompt-dataset-status');
  if (file.size > 5 * 1024 * 1024) { if (status) { status.textContent = 'Dataset must be 5 MB or smaller.'; status.classList.add('error'); } return; }
  const reader = new FileReader();
  reader.onload = () => promptLoadDatasetText(String(reader.result || ''), file.name);
  reader.onerror = () => { if (status) { status.textContent = 'Could not read Dataset file.'; status.classList.add('error'); } };
  reader.readAsText(file);
}

function promptToggleDatasetPaste() {
  const panel = document.getElementById('prompt-dataset-paste');
  if (!panel) return;
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) panel.querySelector('textarea')?.focus();
}

function promptCommitPastedDataset() {
  promptLoadDatasetText(document.getElementById('prompt-dataset-text')?.value || '');
  if (promptDatasets.has(promptDatasetKey())) document.getElementById('prompt-dataset-paste')?.classList.add('hidden');
}

function promptDatasetMove(step) {
  const dataset = promptDatasets.get(promptDatasetKey());
  if (!dataset) return;
  dataset.index = Math.max(0, Math.min(dataset.rows.length - 1, dataset.index + step));
  promptRefreshDataset();
  promptRenderDatasetTable();
  promptLoadDatasetRowIntoDraft();
}

function promptDatasetSelect(index) {
  const dataset = promptDatasets.get(promptDatasetKey());
  if (!dataset || index < 0 || index >= dataset.rows.length) return;
  dataset.index = index;
  promptRefreshDataset(false);
  document.querySelectorAll('.prompt-dataset-table tbody tr').forEach((row,rowIndex) => {
    row.classList.toggle('selected', rowIndex === index);
    row.setAttribute('aria-selected', String(rowIndex === index));
  });
  promptLoadDatasetRowIntoDraft();
}

function promptDatasetDelete(index, event) {
  event?.stopPropagation();
  const dataset = promptDatasets.get(promptDatasetKey());
  if (!dataset || index < 0 || index >= dataset.rows.length) return;
  dataset.rows.splice(index, 1);
  if (!dataset.rows.length) promptDatasets.delete(promptDatasetKey());
  else dataset.index = Math.min(dataset.index > index ? dataset.index - 1 : dataset.index, dataset.rows.length - 1);
  promptRefreshDataset();
  promptRenderDatasetTable();
  if (dataset.rows.length) promptLoadDatasetRowIntoDraft();
}

function promptDatasetAddRow() {
  let dataset = promptDatasets.get(promptDatasetKey());
  if (!dataset) {
    dataset = { name:'Untitled Dataset', rows:[], index:0 };
    promptDatasets.set(promptDatasetKey(), dataset);
  }
  const row = {};
  promptDatasetVariables().forEach(variable => { row[variable] = ''; });
  dataset.rows.push(row);
  dataset.index = dataset.rows.length - 1;
  promptRefreshDataset();
  promptRenderDatasetTable();
  promptLoadDatasetRowIntoDraft();
  requestAnimationFrame(() => document.querySelector(`.prompt-dataset-table tbody tr:nth-child(${dataset.index + 1}) input`)?.focus());
}

function promptDatasetEdit(index, key, input) {
  const dataset = promptDatasets.get(promptDatasetKey());
  if (!dataset || !dataset.rows[index]) return;
  dataset.rows[index][key] = promptContextValue(input.value);
  dataset.index = index;
  promptRenderDrafts.set(promptRenderDraftKey(), { ...dataset.rows[index] });
  promptRefreshDataset(false);
  document.querySelectorAll('.prompt-dataset-table tbody tr').forEach((row,rowIndex) => {
    row.classList.toggle('selected', rowIndex === index);
    row.setAttribute('aria-selected', String(rowIndex === index));
  });
}

function promptClearDataset() { promptDatasets.delete(promptDatasetKey()); promptRefreshDataset(); promptRenderDatasetTable(); }

function promptStableValue(value) {
  if (Array.isArray(value)) return value.map(promptStableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key,promptStableValue(value[key])]));
  return value;
}

function promptDatasetFingerprint(row) {
  return JSON.stringify(promptStableValue(row));
}

function promptLoadDatasetRowIntoDraft() {
  const dataset = promptDatasets.get(promptDatasetKey());
  if (!dataset || !currentDetail || currentDetail.type !== 'prompt') return;
  promptRenderDrafts.set(promptRenderDraftKey(), { ...dataset.rows[dataset.index] });
  promptRefreshRenderForm();
}

function promptRenderDatasetSelect(value) {
  const dataset = promptDatasets.get(promptDatasetKey());
  const index = Number(value);
  if (!dataset || !Number.isInteger(index) || index < 0 || index >= dataset.rows.length) return;
  dataset.index = index;
  promptLoadDatasetRowIntoDraft();
}

function promptRefreshRenderDatasetSelector() {
  const select = document.getElementById('prompt-render-dataset-row');
  if (!select) return;
  const dataset = promptDatasets.get(promptDatasetKey());
  if (!dataset?.rows.length) {
    select.innerHTML = '<option value="">No Dataset rows</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = dataset.rows.map((row,index) => {
    const preview = Object.values(row).map(value => typeof value === 'string' ? value : JSON.stringify(value)).find(value => value)?.slice(0,40) || 'Empty row';
    return `<option value="${index}">Row ${index + 1} · ${esc(preview)}</option>`;
  }).join('');
  select.value = String(dataset.index);
}

function promptRenderDraftEdit(variable, input) {
  const draft = { ...(promptRenderDrafts.get(promptRenderDraftKey()) || {}) };
  draft[variable] = promptContextValue(input.value);
  promptRenderDrafts.set(promptRenderDraftKey(), draft);
  promptRefreshAddToDatasetState();
}

function promptRefreshRenderForm() {
  const target = document.getElementById('prompt-render-inputs');
  if (!target || !currentDetail || currentDetail.type !== 'prompt') return;
  const variables = Array.isArray(currentDetail.analysis?.variables) ? currentDetail.analysis.variables : [];
  const dataset = promptDatasets.get(promptDatasetKey());
  const source = promptRenderDrafts.get(promptRenderDraftKey()) || (dataset ? dataset.rows[dataset.index] : {});
  const draft = Object.fromEntries(variables.map(variable => [variable,Object.prototype.hasOwnProperty.call(source,variable) ? source[variable] : '']));
  if (variables.length) promptRenderDrafts.set(promptRenderDraftKey(), draft);
  target.innerHTML = variables.length ? variables.map(variable => `<label><span>${esc(variable)}</span><input class="prompt-render-input" data-variable="${esc(variable)}" placeholder="Text or JSON value" oninput="promptRenderDraftEdit(${JSON.stringify(variable).replace(/"/g,'&quot;')},this)"></label>`).join('') : '<div class="prompt-render-empty">Variables appear when analysis completes.</div>';
  target.querySelectorAll('.prompt-render-input').forEach(input => {
    if (!Object.prototype.hasOwnProperty.call(draft,input.dataset.variable)) return;
    const value = draft[input.dataset.variable];
    input.value = typeof value === 'string' ? value : JSON.stringify(value);
  });
  promptRefreshRenderDatasetSelector();
  promptRefreshAddToDatasetState();
}

function promptRefreshAddToDatasetState() {
  const button = document.getElementById('prompt-add-to-dataset');
  if (!button) return;
  const context = promptCurrentContext();
  button.disabled = !Object.keys(context).length;
}

function promptAddCurrentToDataset() {
  const row = promptCurrentContext();
  if (!Object.keys(row).length) return;
  let dataset = promptDatasets.get(promptDatasetKey());
  if (!dataset) {
    dataset = { name:'Render snapshots', rows:[], index:0 };
    promptDatasets.set(promptDatasetKey(), dataset);
  }
  const fingerprint = promptDatasetFingerprint(row);
  const existing = dataset.rows.findIndex(candidate => promptDatasetFingerprint(candidate) === fingerprint);
  if (existing >= 0) dataset.index = existing;
  else { dataset.rows.push(promptStableValue(row)); dataset.index = dataset.rows.length - 1; }
  promptRefreshDataset();
  promptRefreshAddToDatasetState();
  const button = document.getElementById('prompt-add-to-dataset');
  if (button) { button.textContent = existing >= 0 ? 'Already in Dataset' : 'Added to Dataset'; setTimeout(() => { if (button.isConnected) button.textContent = '＋ Add to Dataset'; },1200); }
}

function promptDatasetVariables() {
  if (!currentDetail || currentDetail.type !== 'prompt') return [];
  const variables = new Set();
  const versions = currentDetail.taskVersions || currentDetail.allVersions?.map(item => item.version) || [];
  versions.forEach(version => promptTaskVariableSets.get([currentDetail.project,currentDetail.task,version].join('|'))?.forEach(variable => variables.add(variable)));
  return [...variables].sort();
}

function promptDatasetCell(value, rowIndex, key) {
  if (value === undefined) return `<input value="" placeholder="—" aria-label="Row ${rowIndex + 1}, ${esc(key)}" onfocus="promptDatasetSelect(${rowIndex})" onchange="promptDatasetEdit(${rowIndex},${JSON.stringify(key).replace(/"/g,'&quot;')},this)">`;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `<input value="${esc(text).replace(/"/g,'&quot;')}" title="${esc(text)}" aria-label="Row ${rowIndex + 1}, ${esc(key)}" onfocus="promptDatasetSelect(${rowIndex})" onchange="promptDatasetEdit(${rowIndex},${JSON.stringify(key).replace(/"/g,'&quot;')},this)">`;
}

function promptRenderDatasetTable(variables = promptDatasetVariables()) {
  const target = document.getElementById('prompt-dataset-table');
  if (!target) return;
  const dataset = promptDatasets.get(promptDatasetKey());
  if (!dataset) { target.innerHTML = '<div class="prompt-dataset-empty">Load or paste JSON/JSONL to create Dataset rows.</div>'; return; }
  const extra = [...new Set(dataset.rows.flatMap(row => Object.keys(row)).filter(key => !variables.includes(key)))].sort();
  const columns = [...variables, ...extra];
  target.innerHTML = `<div class="prompt-dataset-table-wrap"><table><thead><tr><th class="prompt-dataset-index">#</th>${columns.map(column => `<th title="${esc(column)}">${esc(column)}${extra.includes(column)?'<small>extra</small>':''}</th>`).join('')}<th class="prompt-dataset-delete-column"><span class="sr-only">Actions</span></th></tr></thead><tbody>${dataset.rows.map((row,index)=>`<tr class="${index===dataset.index?'selected':''}" tabindex="0" onclick="promptDatasetSelect(${index})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();promptDatasetSelect(${index})}" aria-selected="${index===dataset.index}"><td class="prompt-dataset-index">${index+1}</td>${columns.map(column=>`<td>${promptDatasetCell(row[column],index,column)}</td>`).join('')}<td class="prompt-dataset-delete-column"><button type="button" onclick="promptDatasetDelete(${index},event)" title="Delete Dataset row ${index+1}" aria-label="Delete Dataset row ${index+1}">×</button></td></tr>`).join('')}</tbody></table></div>`;
}

function promptRefreshDataset(renderTable = true) {
  const dataset = promptDatasets.get(promptDatasetKey());
  const status = document.getElementById('prompt-dataset-status');
  const controls = document.getElementById('prompt-dataset-controls');
  if (!status || !controls) return;
  status.classList.remove('error'); controls.classList.toggle('hidden', !dataset);
  if (!dataset) { status.textContent = 'No Dataset'; return; }
  const row = dataset.rows[dataset.index];
  const variables = promptDatasetVariables();
  const matched = variables.filter(variable => Object.prototype.hasOwnProperty.call(row, variable)).length;
  status.textContent = `${dataset.name} · ${dataset.rows.length} row${dataset.rows.length === 1 ? '' : 's'} · ${matched}/${variables.length} inputs matched`;
  document.getElementById('prompt-dataset-position').textContent = `${dataset.index + 1} / ${dataset.rows.length}`;
  document.getElementById('prompt-dataset-prev').disabled = dataset.index === 0;
  document.getElementById('prompt-dataset-next').disabled = dataset.index === dataset.rows.length - 1;
  promptRefreshRenderDatasetSelector();
  if (renderTable) promptRenderDatasetTable(variables);
}

function promptVersionStatusKey(project, task, file, version) {
  return [project,task,file,version].join('|');
}

function promptOnVersionAnalysis(data) {
  if (!data?.analysis) return;
  const status = data.analysis.syntaxValid === true ? 'valid' : data.analysis.syntaxValid === false ? 'invalid' : 'unknown';
  promptVersionStatuses.set(promptVersionStatusKey(data.project,data.task,data.file,data.version), { status, error:data.analysis.syntaxError || '' });
  document.querySelectorAll(`#paper-ctx .pctx-item[data-prompt-version="${CSS.escape(data.version)}"]`).forEach(item => {
    item.classList.remove('prompt-version-valid','prompt-version-invalid','prompt-version-unknown');
    item.classList.add(`prompt-version-${status}`);
    item.title = data.analysis.syntaxError || (status === 'valid' ? 'Syntax valid' : 'Analyzing');
  });
  if (!currentDetail || currentDetail.type !== 'prompt') return;
  if ([data.project,data.task,data.version,data.file].join('|') !== [currentDetail.project,currentDetail.task,currentDetail.version,currentDetail.file].join('|')) return;
  renderDetail({ ...currentDetail, analysis:data.analysis });
}

function promptWorkspaceSetTab(tab) {
  promptWorkspaceTab = tab;
  document.querySelectorAll('.prompt-workspace-tab').forEach(button => {
    const active = button.dataset.promptTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.prompt-workspace-panel').forEach(panel => panel.classList.toggle('active', panel.dataset.promptPanel === tab));
  if (tab === 'compare') promptRenderComparison();
  if (tab === 'dataset') { promptRefreshVariableCoverage(); promptRefreshDataset(); }
  if (tab === 'render') promptRefreshRenderForm();
}

function promptSetRenderMode(mode) {
  promptRenderMode = mode === 'chat' ? 'chat' : 'completion';
  document.querySelectorAll('.prompt-mode-button').forEach(button => {
    const active = button.dataset.mode === promptRenderMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function promptContextValue(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try { return JSON.parse(value); } catch { return value; }
}

function promptCurrentContext() {
  const dataset = promptDatasets.get(promptDatasetKey());
  const source = promptRenderDrafts.get(promptRenderDraftKey()) || (dataset ? dataset.rows[dataset.index] : {});
  const variables = Array.isArray(currentDetail?.analysis?.variables) ? currentDetail.analysis.variables : [];
  return variables.length ? Object.fromEntries(variables.map(variable => [variable,Object.prototype.hasOwnProperty.call(source,variable) ? source[variable] : ''])) : { ...source };
}

function promptRunRender(button) {
  if (!currentDetail || currentDetail.type !== 'prompt') return;
  const output = document.getElementById('prompt-render-output');
  if (output) output.innerHTML = '<div class="prompt-render-empty">Rendering with uone-prompt-manager…</div>';
  button.disabled = true; button.setAttribute('aria-busy', 'true');
  ask('promptRender', { project:currentDetail.project, task:currentDetail.task, version:currentDetail.version, file:currentDetail.file, context:promptCurrentContext(), mode:promptRenderMode });
}

function promptRunInference(button) {
  if (!currentDetail || currentDetail.type !== 'prompt') return;
  const backend = document.getElementById('prompt-inference-backend');
  const output = document.getElementById('prompt-inference-output');
  if (!backend?.value || !output) return;
  button.disabled = true; button.setAttribute('aria-busy', 'true');
  output.classList.remove('hidden');
  output.innerHTML = `<div class="prompt-render-empty">Running inference with ${esc(backend.options[backend.selectedIndex]?.text || 'selected model')}…</div>`;
  ask('promptInference', { project:currentDetail.project, task:currentDetail.task, version:currentDetail.version, file:currentDetail.file, context:promptCurrentContext(), mode:promptRenderMode, backend:backend.value });
}

function promptInferenceResult(data) {
  if (!currentDetail || currentDetail.type !== 'prompt') return;
  if ([data.project,data.task,data.version,data.file].join('|') !== [currentDetail.project,currentDetail.task,currentDetail.version,currentDetail.file].join('|')) return;
  const button = document.getElementById('prompt-inference-button');
  if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
  if (!data.error && data.rendered !== undefined) promptRendered({ ...data, result:data.rendered });
  const output = document.getElementById('prompt-inference-output');
  if (!output) return;
  output.classList.remove('hidden');
  output.innerHTML = data.error
    ? `<div class="prompt-render-error">${esc(data.error)}</div>`
    : `<div class="prompt-inference-head"><strong>Model response</strong><span>${esc(data.backend || data.model || '')}</span></div><div class="prompt-inference-result">${safeMarked(String(data.result || ''))}</div>`;
  postProcess();
}

function promptRendered(data) {
  if (!currentDetail || currentDetail.type !== 'prompt') return;
  if ([data.project,data.task,data.version,data.file].join('|') !== [currentDetail.project,currentDetail.task,currentDetail.version,currentDetail.file].join('|')) return;
  const button = document.getElementById('prompt-render-button');
  if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
  const output = document.getElementById('prompt-render-output');
  if (!output) return;
  if (data.error) { output.innerHTML = `<div class="prompt-render-error">${esc(data.error)}</div>`; return; }
  if (data.mode === 'chat' && Array.isArray(data.result)) {
    output.innerHTML = `<div class="prompt-chat-preview">${data.result.map(message => `<section class="prompt-chat-message"><span>${esc(message[0] || 'message')}</span><div>${esc(message[1] || '')}</div></section>`).join('')}</div>`;
  } else {
    output.innerHTML = `<pre class="prompt-completion-preview">${esc(String(data.result ?? ''))}</pre>`;
  }
}

function promptEditVersionNote() {
  const editor = document.getElementById('prompt-note-editor');
  const textarea = document.getElementById('prompt-note-input');
  if (!editor || !textarea || !currentDetail) return;
  textarea.value = currentDetail.meta?.note || '';
  editor.classList.remove('hidden');
  textarea.focus();
}

function promptCancelVersionNote() {
  document.getElementById('prompt-note-editor')?.classList.add('hidden');
}

function promptSaveVersionNote(button) {
  if (!currentDetail || currentDetail.type !== 'prompt') return;
  const note = document.getElementById('prompt-note-input')?.value || '';
  button.disabled = true; button.setAttribute('aria-busy', 'true');
  ask('promptSaveVersionNote', { project:currentDetail.project, task:currentDetail.task, version:currentDetail.version, file:currentDetail.file, note });
}

function promptVersionNoteSaved(data) {
  const button = document.getElementById('prompt-note-save');
  if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
  if (data?.cancelled) return;
  const error = document.getElementById('prompt-note-error');
  if (data?.error) { if (error) error.textContent = data.error; return; }
  if (!data?.ok) return;
  ask('list', { tab:'prompts', filter:state.filter, q:state.search });
  requestDetail('prompt', [data.project,data.task,data.version,data.file].join('|'));
}

function promptOpenTextEditor() {
  if (!currentDetail || currentDetail.type !== 'prompt') return;
  ask('promptOpenTextEditor', { project:currentDetail.project, task:currentDetail.task, version:currentDetail.version, file:currentDetail.file });
}

let promptVersionChanging = false;
function promptChangeVersion(step) {
  if (promptVersionChanging || !currentDetail || currentDetail.type !== 'prompt') return;
  const versions = (currentDetail.allVersions || []).map(item => item.version);
  const index = versions.indexOf(currentDetail.version);
  const next = index + step;
  if (index < 0 || next < 0 || next >= versions.length) return;
  promptVersionChanging = true;
  const clock = document.querySelector('.prompt-version-clock');
  clock?.classList.add(step > 0 ? 'flip-next' : 'flip-previous');
  setTimeout(() => {
    promptVersionChanging = false;
    openPromptFile(currentDetail.project, currentDetail.task, versions[next], currentDetail.file);
  }, 130);
}

function promptVersionWheel(event) {
  event.preventDefault();
  if (Math.abs(event.deltaY) < 2) return;
  promptChangeVersion(event.deltaY > 0 ? 1 : -1);
}

function promptVersionMenu(event) {
  event.preventDefault(); event.stopPropagation();
  if (!currentDetail || currentDetail.type !== 'prompt') return;
  const items = (currentDetail.allVersions || []).map(item => ({
    label:item.version, active:item.version === currentDetail.version,
    version:item.version,
    status:(promptVersionStatuses.get(promptVersionStatusKey(currentDetail.project,currentDetail.task,currentDetail.file,item.version)) || {status:'unknown'}).status,
    onClick:()=>openPromptFile(currentDetail.project,currentDetail.task,item.version,currentDetail.file),
  }));
  showPaperMenu(event.clientX, event.clientY, items);
}

function promptRenderComparison() {
  if (!currentDetail || currentDetail.type !== 'prompt') return;
  const left = document.getElementById('prompt-compare-from'), right = document.getElementById('prompt-compare-to'), target = document.getElementById('prompt-inline-diff');
  if (!left || !right || !target) return;
  const versions = Object.fromEntries((currentDetail.allVersions || []).map(item => [item.version, item.content || '']));
  const fromLines = (versions[left.value] || '').split('\n'), toLines = (versions[right.value] || '').split('\n');
  const fromSet = new Set(fromLines), toSet = new Set(toLines);
  let removed = 0, added = 0;
  const before = fromLines.map((line, index) => { const changed = !toSet.has(line); if (changed) removed++; return `<div class="diff-line${changed?' diff-rem':''}"><span class="diff-no">${index+1}</span><span>${esc(line)||'&nbsp;'}</span></div>`; }).join('');
  const after = toLines.map((line, index) => { const changed = !fromSet.has(line); if (changed) added++; return `<div class="diff-line${changed?' diff-add':''}"><span class="diff-no">${index+1}</span><span>${esc(line)||'&nbsp;'}</span></div>`; }).join('');
  target.innerHTML = `<div class="prompt-diff-stat"><span class="removed">−${removed}</span><span class="added">+${added}</span></div><div class="diff-wrap"><div class="diff-panel"><div class="diff-hdr">${esc(left.value)}</div>${before}</div><div class="diff-panel"><div class="diff-hdr">${esc(right.value)}</div>${after}</div></div>`;
}

// ── Render detail ──────────────────────────────────────────────────────────
function markdownToolbar(data) {
  const type = data.type;
  const pin = type === 'note'
    ? `toggleNotePin('${esc(data.slug)}',${data.pinned ? 'false' : 'true'})`
    : type === 'skill'
      ? `toggleSkillPin('${esc(data.name)}',${data.pinned ? 'false' : 'true'})`
      : `togglePin('${esc(data.slug)}',${data.pinned ? 'false' : 'true'})`;
  const area = type + 's';
  const key = type === 'skill' ? data.name : data.slug;
  const category = type === 'skill' ? data.category || '' : '';
  return `
    <button class="tbtn" style="font-size:11px" onclick="${pin}" title="${data.pinned ? 'Unpin' : 'Pin to top'}">${data.pinned ? '★ Pinned' : '☆ Pin'}</button>
    <button class="tbtn" style="font-size:11px" onclick="exportMarkdown('browser')" title="Open a live Markdown preview in your browser">🌐 Browser</button>
    ${type === 'note' ? '<button class="tbtn" style="font-size:11px" onclick="exportMarkdown(\'linkedSave\')" title="Save this Note and its linked Notes as a shareable site">📦 Site</button>' : ''}
    <button class="tbtn" style="font-size:11px" onclick="exportMarkdown('file')" title="Download as a self-contained HTML file">⬇ Download</button>
    <button class="tbtn" style="font-size:11px" onclick="openMarkdownItem('${area}', '${esc(category)}', '${esc(key)}')">✏ Edit Content</button>
    <button class="tbtn" style="font-size:11px" onclick="editMarkdownMetadataItem('${area}', '${esc(category)}', '${esc(key)}')">⚙ Edit Metadata</button>`;
}

function detailContentPath(data) {
  if (data.type === 'skill') return `skills/${data._key || [data.category, data.name].filter(Boolean).join('/')}.md`;
  if (data.type === 'note') return `notes/${data.slug}.md`;
  if (data.type === 'paper') return `papers/${data.slug}.md`;
  if (data.type === 'prompt') return `prompts/${data.project}/${data.task}/${data.version}/${data.file}`;
  if (data.type === 'script') return data.pkmPath || `scripts/${data.path || data.file}`;
  return '';
}
function detailPathHtml(data) {
  const value = detailContentPath(data);
  return value ? `<div class="d-path" title="PKM relative path">${esc(value)}</div>` : '';
}

function renderDetail(data) {
  renderNonce++; // fresh asset URLs each open so late-added images bypass stale cache
  const el = document.getElementById('detail');
  if (!data) { currentDetail = null; currentDetailRequest = null; el.innerHTML = '<div class="empty">Not found.</div>'; return; }
  const previousDetailType = currentDetail?.type;
  currentDetail = data;

  if (data.type === 'subscription') {
    const source = data.provenance || {};
    let serverLinkData = null;
    if (data.contentType === 'servers') { try { serverLinkData = JSON.parse(data.content || '{}'); } catch {} }
    const rendered = data.contentType === 'servers'
      ? `<div class="subscribed-server-links">${(serverLinkData?.links || []).map((link,index) => `<div><span>${esc(link.label || link.url)}</span><button class="pk-button" data-pending-label="Opening…" onclick="ask('subscriptionOpenServerLink',{key:'${esc(currentDetailRequest?.key || '')}',index:${index}},this)">Open</button></div>`).join('') || '<div class="empty">No network link is available from this Server.</div>'}</div>`
      : ['skills','notes','papers'].includes(data.contentType) ? safeMarked(data.content || '') : `<pre><code>${esc(data.content || '')}</code></pre>`;
    const forkAction = data.contentType === 'servers' ? '<span class="tag">Link only</span>' : `<button class="pk-button" data-pending-label="Forking…" onclick="subscriptionFork('${esc(currentDetailRequest?.key || '')}',this)">Fork to Local</button>`;
    el.innerHTML = `<div class="d-title"><span>${esc(serverLinkData?.name || data.title)}</span><span class="tag">Read-only subscription</span><span style="flex:1"></span>${forkAction}</div>
      <div class="d-path" title="Remote path">${esc(data.path)}</div>
      <div class="meta-grid">
        <span class="ml">Alias</span><span class="mv">${esc(source.subscriptionAlias || '—')}</span>
        <span class="ml">Publisher</span><span class="mv">${esc(source.publisher || '—')}</span>
        <span class="ml">Type</span><span class="mv">${esc(data.contentType || '')}</span>
        <span class="ml">Share</span><span class="mv">${esc(source.shareId || '—')}</span>
        <span class="ml">Revision</span><span class="mv">${Number(source.revision)||0}</span>
        <span class="ml">Synced</span><span class="mv">${source.syncedAt ? new Date(source.syncedAt).toLocaleString() : '—'}</span>
        <span class="ml">Content hash</span><span class="mv"><code>${esc(source.contentHash || '—')}</code></span>
      </div><hr class="div"><div class="prose">${rendered}</div>`;
  } else if (data.type === 'skill') {
    currentDetail = data;
    const tags = JSON.parse(data.tags||'[]');
    const toc = buildToc(data.content||'');
    el.innerHTML = `
      <div class="d-title"><span>${esc(data.name)}</span>${privacyLock(data.isPrivate)}<button class="meta-edit" onclick="editCurrentMetadata('title')" title="Edit name">✎</button></div>
      ${detailPathHtml(data)}
      <div class="d-meta">
        ${data.category?`<span class="cat">${esc(data.category)}</span>`:''}
        ${tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}
        <button class="meta-edit" onclick="editCurrentMetadata('tags')" title="Edit tags">✎</button>
        <span>${wordCount(data.content||'')}</span>
        <span>Updated ${(data.updated_at||'').slice(0,10)}</span>
        <span style="flex:1"></span>
        ${markdownToolbar(data)}
        <button class="tbtn" style="font-size:11px" onclick="confirmDeleteSkill(this)">🗑 Move to Trash</button>
      </div>
      <div class="meta-grid">
        <span class="ml">Source</span><span class="mv meta-value"><span>${esc(data.source_project||'—')}</span><button class="meta-edit" onclick="editCurrentMetadata('source_project')" title="Edit source">✎</button></span>
        <span class="ml">Created</span><span class="mv">${(data.created_at||'').slice(0,10)}</span>
        <span class="ml">Description</span><span class="mv meta-value"><span>${esc(data.description||'—')}</span><button class="meta-edit" onclick="editCurrentMetadata('description')" title="Edit description">✎</button></span>
      </div>
      <hr class="div">${toc}<div class="prose">${safeMarked(data.content||'')}</div>`;

  } else if (data.type === 'note') {
    currentDetail = data;
    const tags = JSON.parse(data.tags||'[]');
    el.innerHTML = `
      <div class="d-title"><span>${ICON[data.note_type]||'📝'} ${esc(data.title)}</span>${privacyLock(data.isPrivate)}<button class="meta-edit" onclick="editCurrentMetadata('title')" title="Edit title">✎</button></div>
      ${detailPathHtml(data)}
      <div class="d-meta">
        <span>${esc(data.note_type)}</span>
        ${data.category?`<span class="cat">${esc(data.category)}</span>`:''}
        ${tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}
        <button class="meta-edit" onclick="editCurrentMetadata('tags')" title="Edit tags">✎</button>
        <span>Updated ${(data.updated_at||'').slice(0,10)}</span>
        <span style="flex:1"></span>
        ${markdownToolbar(data)}
      </div>
      <div class="meta-grid">
        <span class="ml">Description</span><span class="mv meta-value"><span>${esc(data.description||'—')}</span><button class="meta-edit" onclick="editCurrentMetadata('description')" title="Edit description">✎</button></span>
      </div>
      <hr class="div"><div class="prose">${safeMarked(data.content||'', data.category)}</div>`;

  } else if (data.type === 'paper') {
    currentDetail = data;
    // A paper detail always returns to the plain detail pane (closes form/graph)
    document.getElementById('paper-form').classList.add('hidden');
    document.getElementById('paper-graph-view').classList.add('hidden');
    document.getElementById('detail').style.display = '';
    paperGraphOpen = false;
    const gb = document.getElementById('btn-paper-graph'); if (gb) gb.textContent = '🕸 Graph';
    el.innerHTML = paperDetailHtml(data);

  } else if (data.type === 'prompt') {
    currentDetail = data;
    const { project, task, version, file, content, meta, allVersions, analysis = {} } = data;
    const ext  = (file||'').split('.').pop()||'';
    const lang = {jinja2:'jinja',jinja:'jinja',txt:'text',json:'json',yaml:'yaml',py:'python',sh:'bash'}[ext]||'text';
    const versions = (allVersions||[]);
    const variables = Array.isArray(analysis.variables) ? analysis.variables : [];
    if (analysis.pending !== true && variables.length) promptTaskVariableSets.set([project,task,version].join('|'), new Set(variables));
    const format = String(analysis.format || ext || 'prompt').toUpperCase();
    const syntaxHtml = analysis.pending || analysis.syntaxValid === null
      ? '<span class="prompt-health pending">Analyzing…</span>'
      : analysis.available === false
      ? `<span class="prompt-health unavailable">Manager unavailable</span>`
      : analysis.syntaxValid
        ? '<span class="prompt-health valid">Syntax valid</span>'
        : `<span class="prompt-health invalid" title="${esc(analysis.syntaxError || 'Invalid template')}">Syntax invalid</span>`;
    const mode = analysis.chatTemplate ? 'chat' : 'completion';
    promptRenderMode = mode;
    if (previousDetailType !== 'prompt') promptWorkspaceTab = 'source';
    if (promptWorkspaceTab === 'compare' && versions.length < 2) promptWorkspaceTab = 'source';
    const versionOptions = versions.map(v => `<option value="${esc(v.version)}">${esc(v.version)}</option>`).join('');
    const fromVersion = versions[0]?.version || version;
    const toVersion = versions[versions.length-1]?.version || version;
    const versionIndex = Math.max(0, versions.findIndex(item => item.version === version));
    versions.forEach(item => {
      const key = promptVersionStatusKey(project,task,file,item.version);
      if (!promptVersionStatuses.has(key)) promptVersionStatuses.set(key, {status:'unknown',error:''});
    });
    if (analysis.syntaxValid === true || analysis.syntaxValid === false) promptVersionStatuses.set(promptVersionStatusKey(project,task,file,version), {status:analysis.syntaxValid?'valid':'invalid',error:analysis.syntaxError||''});
    const syntaxState = analysis.syntaxValid === true ? 'syntax-valid' : analysis.syntaxValid === false ? 'syntax-invalid' : 'syntax-unknown';
    el.innerHTML = `
      <div class="prompt-workbench">
        <header class="prompt-workbench-head">
          <div><div class="prompt-title-line"><div class="d-title">${esc(meta?.title || task)} ${privacyLock(data.isPrivate)}</div><div class="prompt-version-clock ${syntaxState}" role="spinbutton" tabindex="0" aria-label="Prompt version ${esc(version)}, ${syntaxState==='syntax-valid'?'syntax valid':syntaxState==='syntax-invalid'?'syntax invalid':'analyzing'}" aria-valuemin="1" aria-valuemax="${versions.length}" aria-valuenow="${versionIndex+1}" aria-valuetext="${esc(version)}" onwheel="promptVersionWheel(event)" onkeydown="if(event.key==='ArrowUp'){event.preventDefault();promptChangeVersion(-1)}else if(event.key==='ArrowDown'){event.preventDefault();promptChangeVersion(1)}"><button type="button" class="prompt-version-face" onclick="promptVersionMenu(event)" title="Choose Prompt version">${esc(version)}</button><span class="prompt-version-steppers"><button type="button" onclick="event.stopPropagation();promptChangeVersion(-1)" title="Previous Prompt version" aria-label="Previous Prompt version" ${versionIndex===0?'disabled':''}>▴</button><button type="button" onclick="event.stopPropagation();promptChangeVersion(1)" title="Next Prompt version" aria-label="Next Prompt version" ${versionIndex===versions.length-1?'disabled':''}>▾</button></span></div></div>${detailPathHtml(data)}</div>
          <div class="prompt-health-row"><span class="prompt-format">${esc(format)}</span>${syntaxHtml}</div>
        </header>
        <nav class="prompt-workspace-tabs" role="tablist">
          <button class="prompt-workspace-tab ${promptWorkspaceTab==='source'?'active':''}" data-prompt-tab="source" role="tab" aria-selected="${promptWorkspaceTab==='source'}" onclick="promptWorkspaceSetTab('source')">Source</button>
          <button class="prompt-workspace-tab ${promptWorkspaceTab==='render'?'active':''}" data-prompt-tab="render" role="tab" aria-selected="${promptWorkspaceTab==='render'}" onclick="promptWorkspaceSetTab('render')">Render</button>
          <button class="prompt-workspace-tab ${promptWorkspaceTab==='compare'?'active':''}" data-prompt-tab="compare" role="tab" aria-selected="${promptWorkspaceTab==='compare'}" onclick="promptWorkspaceSetTab('compare')" ${versions.length < 2 ? 'disabled' : ''}>Compare</button>
          <button class="prompt-workspace-tab ${promptWorkspaceTab==='metadata'?'active':''}" data-prompt-tab="metadata" role="tab" aria-selected="${promptWorkspaceTab==='metadata'}" onclick="promptWorkspaceSetTab('metadata')">Metadata</button>
          <button class="prompt-workspace-tab ${promptWorkspaceTab==='dataset'?'active':''}" data-prompt-tab="dataset" role="tab" aria-selected="${promptWorkspaceTab==='dataset'}" onclick="promptWorkspaceSetTab('dataset')">Dataset</button>
        </nav>
        <section class="prompt-workspace-panel ${promptWorkspaceTab==='source'?'active':''}" data-prompt-panel="source">
          <div class="prompt-source-toolbar"><span>${Number(analysis.lineCount)||0} lines · ${Number(analysis.charCount)||0} chars</span><button type="button" class="tbtn" onclick="promptOpenTextEditor()" title="Open this Prompt in the VS Code Text Editor">↗ Open in Text Editor</button></div>
          <pre class="prompt-source"><code class="language-${lang}">${esc(content||'')}</code></pre>${!analysis.syntaxValid && analysis.syntaxError ? `<div class="prompt-render-error">${esc(analysis.syntaxError)}</div>` : ''}
        </section>
        <section class="prompt-workspace-panel ${promptWorkspaceTab==='render'?'active':''}" data-prompt-panel="render">
          <div class="prompt-render-toolbar"><div class="prompt-mode" aria-label="Output mode"><button class="prompt-mode-button ${mode==='completion'?'active':''}" data-mode="completion" aria-pressed="${mode==='completion'}" onclick="promptSetRenderMode('completion')">Completion</button><button class="prompt-mode-button ${mode==='chat'?'active':''}" data-mode="chat" aria-pressed="${mode==='chat'}" onclick="promptSetRenderMode('chat')">Chat</button></div><button id="prompt-render-button" class="tbtn primary" onclick="promptRunRender(this)" ${analysis.syntaxValid !== true ? 'disabled' : ''}>▶ Render</button><span class="prompt-render-spacer"></span><select id="prompt-inference-backend" title="Model for Prompt inference"><option value="">Loading models…</option></select><button id="prompt-inference-button" type="button" class="tbtn" onclick="promptRunInference(this)" disabled>Run Inference</button></div>
          <div class="prompt-render-form-head"><div><strong>Render inputs</strong><span>Enter values directly or populate the form from a Dataset row.</span></div><label class="prompt-render-dataset-picker"><span>Dataset row</span><select id="prompt-render-dataset-row" onchange="promptRenderDatasetSelect(this.value)" disabled><option value="">No Dataset rows</option></select></label><button id="prompt-add-to-dataset" type="button" class="tbtn" onclick="promptAddCurrentToDataset()" disabled>＋ Add to Dataset</button></div>
          <div id="prompt-render-inputs" class="prompt-context-grid"></div>
          <div id="prompt-render-output" class="prompt-render-output"><div class="prompt-render-empty">Enter sample values, then render the final prompt.</div></div>
          <div id="prompt-inference-output" class="prompt-inference-output hidden"></div>
        </section>
        <section class="prompt-workspace-panel ${promptWorkspaceTab==='compare'?'active':''}" data-prompt-panel="compare">
          <div class="prompt-compare-toolbar"><label>From<select id="prompt-compare-from" onchange="promptRenderComparison()">${versionOptions}</select></label><span>→</span><label>To<select id="prompt-compare-to" onchange="promptRenderComparison()">${versionOptions}</select></label></div>
          <div id="prompt-inline-diff"></div>
        </section>
        <section class="prompt-workspace-panel prompt-metadata-panel ${promptWorkspaceTab==='metadata'?'active':''}" data-prompt-panel="metadata">
          <div class="prompt-note"><strong>Version note</strong><span>${esc(meta?.note || 'No version note')}</span><button type="button" class="prompt-note-edit" onclick="promptEditVersionNote()" title="Edit Version note" aria-label="Edit Version note">✎</button></div>
          <div id="prompt-note-editor" class="prompt-note-editor hidden"><textarea id="prompt-note-input" rows="4" aria-label="Version note"></textarea><div><span id="prompt-note-error"></span><button type="button" class="tbtn" onclick="promptCancelVersionNote()">Cancel</button><button type="button" id="prompt-note-save" class="tbtn primary" onclick="promptSaveVersionNote(this)">Save…</button></div></div>
          <section class="prompt-inheritance"><div class="prompt-inheritance-title"><strong>Template inheritance</strong><span>base → extender</span></div>${promptInheritanceTreeHtml(analysis.templateTree)}</section>
          <section class="prompt-flow" aria-label="Prompt flow">
            <div class="prompt-flow-stage"><small>Inputs</small><strong>${variables.length}</strong></div>
            <span class="prompt-flow-arrow">→</span>
            <div class="prompt-flow-stage template"><small>Template</small><strong title="${esc(file)}">${esc(file)}</strong></div>
            <span class="prompt-flow-arrow">→</span>
            <div class="prompt-flow-stage output"><small>Output</small><strong title="${mode === 'chat' ? 'Chat messages' : 'Completion text'}">${mode === 'chat' ? 'Chat' : 'Completion'}</strong></div>
          </section>
          <div class="meta-grid prompt-template-facts"><span class="ml">Engine</span><span class="mv">uone-prompt-manager</span><span class="ml">Format</span><span class="mv">${esc(format)}</span><span class="ml">Template size</span><span class="mv">${Number(analysis.lineCount)||0} lines · ${Number(analysis.charCount)||0} chars</span><span class="ml">Input count</span><span class="mv">${variables.length}</span></div>
        </section>
        <section class="prompt-workspace-panel prompt-dataset-panel ${promptWorkspaceTab==='dataset'?'active':''}" data-prompt-panel="dataset">
          <div class="prompt-variable-summary"><div><strong>Jinja variables</strong><span>Hover a variable to inspect its closed version ranges.</span></div><div id="prompt-variable-coverage"></div></div>
          <div class="prompt-dataset-bar"><strong>Test Dataset</strong><span id="prompt-dataset-status">No Dataset</span><span class="prompt-dataset-spacer"></span><input id="prompt-dataset-file" type="file" accept=".json,.jsonl,.ndjson,application/json" onchange="promptLoadDatasetFile(this)"><button type="button" class="tbtn" onclick="promptDatasetAddRow()">＋ Add Row</button><button type="button" class="tbtn" onclick="document.getElementById('prompt-dataset-file').click()">↥ Load</button><button type="button" class="tbtn" onclick="promptToggleDatasetPaste()">Paste</button><div id="prompt-dataset-controls" class="prompt-dataset-controls hidden"><button id="prompt-dataset-prev" type="button" onclick="promptDatasetMove(-1)" title="Previous Dataset row" aria-label="Previous Dataset row">‹</button><span id="prompt-dataset-position"></span><button id="prompt-dataset-next" type="button" onclick="promptDatasetMove(1)" title="Next Dataset row" aria-label="Next Dataset row">›</button><button type="button" onclick="promptClearDataset()" title="Clear Dataset" aria-label="Clear Dataset">×</button></div></div>
          <div id="prompt-dataset-paste" class="prompt-dataset-paste hidden"><textarea id="prompt-dataset-text" rows="5" placeholder='[{"AdAsset":"Example ad","Src":"Landing page text"}]' aria-label="JSON or JSONL Dataset"></textarea><div><button type="button" class="tbtn" onclick="promptToggleDatasetPaste()">Cancel</button><button type="button" class="tbtn primary" onclick="promptCommitPastedDataset()">Use Dataset</button></div></div>
          <div id="prompt-dataset-table" class="prompt-dataset-table"><div class="prompt-dataset-empty">Load or paste JSON/JSONL to create Dataset rows.</div></div>
        </section>
      </div>`;
    const fromSelect = document.getElementById('prompt-compare-from'), toSelect = document.getElementById('prompt-compare-to');
    if (fromSelect) fromSelect.value = fromVersion;
    if (toSelect) toSelect.value = toVersion;
    if (promptWorkspaceTab === 'compare') promptRenderComparison();
    if (promptWorkspaceTab === 'dataset') { promptRefreshVariableCoverage(); promptRefreshDataset(); }
    if (promptWorkspaceTab === 'render') promptRefreshRenderForm();
    ask('listAiBackends', {});
    highlightSelectedPromptTree(data);
    if (window.innerWidth <= 760) setMainSidebarCollapsed(true, false);

  } else if (data.type === 'promptDiff') {
    const { project, task, file, allVersions } = data;
    if (!allVersions?.length) { el.innerHTML = '<div class="empty">No versions.</div>'; return; }
    const versions = allVersions.map(v => v.version);
    const verA = versions[0];
    const verB = versions[versions.length - 1];
    const opts = versions.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    el.innerHTML = `
      <div class="d-title">${esc(project)} / ${esc(task)} / ${esc(file)} ${privacyLock(data.isPrivate)}</div>
      <div class="diff-controls">
        <span style="font-size:12px;color:var(--muted)">Compare:</span>
        <select id="diff-ver-a">${opts}</select>
        <span style="color:var(--muted)">→</span>
        <select id="diff-ver-b">${opts}</select>
        <span id="diff-stats"></span>
      </div>
      <hr class="div">
      <div class="diff-wrap" id="diff-panels"></div>`;
    // Set defaults and wire selectors
    const selA = document.getElementById('diff-ver-a');
    const selB = document.getElementById('diff-ver-b');
    selA.value = verA; selB.value = verB;
    const verMap = {};
    allVersions.forEach(v => verMap[v.version] = v.content || '');
    function renderDiff() {
      const a = verMap[selA.value] || '', b = verMap[selB.value] || '';
      const la = a.split('\n'), lb = b.split('\n');
      const setA = new Set(la), setB = new Set(lb);
      let added = 0, removed = 0;
      const leftLines = la.map((line, i) => {
        const gone = !setB.has(line);
        if (gone) removed++;
        return `<div class="diff-line${gone?' diff-rem':''}"><span class="diff-no">${i+1}</span><span>${esc(line)||'&nbsp;'}</span></div>`;
      }).join('');
      const rightLines = lb.map((line, i) => {
        const isNew = !setA.has(line);
        if (isNew) added++;
        return `<div class="diff-line${isNew?' diff-add':''}"><span class="diff-no">${i+1}</span><span>${esc(line)||'&nbsp;'}</span></div>`;
      }).join('');
      document.getElementById('diff-panels').innerHTML =
        `<div class="diff-panel"><div class="diff-ver-label">${esc(selA.value)}</div><div class="diff-lines">${leftLines}</div></div>` +
        `<div class="diff-panel"><div class="diff-ver-label">${esc(selB.value)}</div><div class="diff-lines">${rightLines}</div></div>`;
      document.getElementById('diff-stats').innerHTML =
        `<span class="diff-stat stat-add">+${added} added</span>&nbsp;<span class="diff-stat stat-rem">-${removed} removed</span>`;
    }
    selA.addEventListener('change', renderDiff);
    selB.addEventListener('change', renderDiff);
    renderDiff();
    return;

  } else if (data.type === 'package') {
    function renderTree(nodes, depth=0) {
      return (nodes||[]).map(n => {
        const pad = '&nbsp;'.repeat(depth*3);
        if (n.type==='dir') return `<div>${pad}<span class="ft-dir">📁 ${esc(n.name)}/</span></div>${renderTree(n.children,depth+1)}`;
        return `<div>${pad}<span class="ft-file" onclick="loadPkgFile('${esc(data.name)}','${esc(n.name)}')">📄 ${esc(n.name)}</span></div>`;
      }).join('');
    }
    const toc = buildToc(data.readme||'');
    el.innerHTML = `
      <div class="d-title"><span>${esc(data.name)}</span>${privacyLock(data.isPrivate)}${packageSourceTag(data.source)}</div>
      <hr class="div">
      <details style="margin-bottom:12px">
        <summary style="cursor:pointer;color:var(--muted);font-size:11px">File tree</summary>
        <div class="ftree" style="margin-top:6px">${renderTree(data.tree)}</div>
      </details>
      <hr class="div">${toc}<div class="prose">${safeMarked(data.readme||'')}</div>`;

  } else if (data.type === 'script') {
    currentDetail = data;
    const ext = (data.file||'').split('.').pop()||'';
    const lang = {sh:'bash',py:'python',js:'javascript',ts:'typescript',r:'r',sql:'sql',cs:'csharp',ps1:'powershell',script:'scope',usql:'sql'}[ext]||'text';
    el.innerHTML = `
      <div class="d-title">${esc(data.file||'')} ${privacyLock(data.isPrivate)}</div>
      ${detailPathHtml(data)}
      <div class="d-meta">
        ${(data.langs||(data.lang?data.lang.split(' + '):[])).map(l=>`<span class="tag" style="background:var(--panel)">🏷 ${esc(l)}</span>`).join('')}
        <span>${wordCount(data.content||'')}</span>
        <span style="flex:1"></span>
        <button class="tbtn" style="font-size:11px" onclick="startEditScript()">✏ Edit</button>
        <select id="ai-backend-select" title="AI backend for summarization"
          style="font-size:11px;background:var(--input);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:3px 6px;outline:none;max-width:200px">
          <option value="">Loading backends…</option>
        </select>
        <button class="tbtn" style="font-size:11px;border-color:var(--accent)" onclick="doAiSummary()">✨ AI Summary</button>
      </div>
      <div id="ai-summary"></div>
      <hr class="div">
      <div class="prose"><pre><code class="language-${lang}">${esc(data.content||'')}</code></pre></div>`;
    ask('listAiBackends', {}); // populate the backend dropdown
  }

  postProcess();
}

function openMarkdownItem(area, category, key) {
  const itemKey = area === 'skills' && category ? category + '/' + key : key;
  ask('openKnowledgeContent', { area, key: itemKey });
}
function editMarkdownMetadataItem(area, category, key) {
  const itemKey = area === 'skills' && category ? category + '/' + key : key;
  ask('editKnowledgeMetadata', { area, key: itemKey });
}
function editCurrentMetadata(field) {
  const data = currentDetail;
  if (!data || !['skill','note','paper'].includes(data.type)) return;
  const area = data.type === 'skill' ? 'skills' : data.type === 'note' ? 'notes' : 'papers';
  const key = data.type === 'skill' ? (data.category ? data.category + '/' + data.name : data.name) : data.slug;
  const values = {
    title: data.type === 'skill' ? data.name : data.title,
    tags: Array.isArray(data.tags) ? data.tags.join(', ') : JSON.parse(data.tags || '[]').join(', '),
    description: data.description || '',
    source_project: data.source_project || '',
  };
  const labels = { title: data.type === 'skill' ? 'Name' : 'Title', tags: 'Tags (comma-separated)', description: 'Description', source_project: 'Source' };
  pkModal({
    title: 'Edit ' + labels[field], input: true, defaultValue: values[field] || '', okLabel: 'Save',
    onOk: value => ask('updateKnowledgeMetadataField', { area, key, field, value }),
  });
}

// ── Script edit ─────────────────────────────────────────────────────────────
function startEditScript() {
  const d = currentDetail;
  if (!d || d.type !== 'script') return;
  document.getElementById('detail').innerHTML = `
    <div class="d-title">✏ Edit: <span style="color:var(--accent)">${esc(d.file)}</span></div>
    ${detailPathHtml(d)}
    <textarea id="se-script" style="width:100%;height:calc(100vh - 200px);background:var(--input);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:10px;font-size:12px;font-family:var(--vscode-editor-font-family);resize:none;outline:none;line-height:1.5">${esc(d.content||'')}</textarea>
    <div class="form-actions" style="margin-top:8px">
      <button class="tbtn" onclick="ask('detail',{type:'script',key:currentDetail.path})">Cancel</button>
      <button class="tbtn" style="border-color:var(--accent)" onclick="submitScriptEdit()">💾 Save</button>
    </div>`;
  document.getElementById('se-script').focus();
}

function submitScriptEdit() {
  const d = currentDetail; if (!d) return;
  const content = document.getElementById('se-script').value;
  ask('saveScript', { path: d.path, content });
}

// ── AI Summary (script) ─────────────────────────────────────────────────────
function doAiSummary() {
  const d = currentDetail;
  if (!d || d.type !== 'script') return;
  const sel = document.getElementById('ai-backend-select');
  const backend = sel ? sel.value : '';
  const box = document.getElementById('ai-summary');
  if (box) box.innerHTML = `<div style="padding:12px 14px;margin:12px 0;border:1px solid var(--border);border-radius:8px;background:var(--panel)">
    <span style="color:var(--muted);font-size:12px">✨ Generating AI summary${backend?' via '+esc(sel.options[sel.selectedIndex]?.text||''):''}… (this may take a few seconds)</span></div>`;
  ask('aiSummary', { path: d.path, backend });
}

// Populate the AI backend dropdown from the scan result
function renderAiBackends(backends) {
  const sel = document.getElementById('ai-backend-select');
  if (sel) {
    if (!backends || !backends.length) sel.innerHTML = '<option value="">No backend available</option>';
    else {
      const prev = sel.dataset.chosen || '';
      sel.innerHTML = backends.map(b => `<option value="${esc(b.id)}">${esc(b.label)}</option>`).join('');
      if (prev && backends.some(b => b.id === prev)) sel.value = prev;
      sel.onchange = () => { sel.dataset.chosen = sel.value; peekCachedSummary(); };
      peekCachedSummary();
    }
  }
  const promptSelect = document.getElementById('prompt-inference-backend');
  const promptButton = document.getElementById('prompt-inference-button');
  if (!promptSelect || !promptButton) return;
  const usable = (backends || []).filter(backend => !backend.id.endsWith(':needkey'));
  promptSelect.innerHTML = usable.length ? usable.map(backend => `<option value="${esc(backend.id)}">${esc(backend.label)}</option>`).join('') : '<option value="">No model available</option>';
  promptButton.disabled = !usable.length || currentDetail?.analysis?.syntaxValid !== true;
}

// Ask for a cached summary only (never triggers a new AI call)
function peekCachedSummary() {
  const d = currentDetail;
  const sel = document.getElementById('ai-backend-select');
  if (!d || d.type !== 'script' || !sel) return;
  ask('aiSummary', { path: d.path, backend: sel.value, cacheOnly: true });
}

function loadPkgFile(pkg, file) { requestDetail('packageFile', pkg+'|'+file); }

// ── Helpers ────────────────────────────────────────────────────────────────
function buildToc(md) {
  const hdgs = [...md.matchAll(/^(#{1,3})\s+(.+)$/gm)];
  if (hdgs.length < 3) return '';
  const items = hdgs.map(([,h,t]) =>
    `<a href="#" style="--d:${h.length-1}" onclick="scrollHd('${t.replace(/'/g,"\\'")}');return false">${esc(t)}</a>`
  ).join('');
  return `<div class="toc-wrap"><h4>Contents</h4><div class="toc">${items}</div></div>`;
}

function scrollHd(title) {
  for (const el of document.querySelectorAll('#detail h1,#detail h2,#detail h3'))
    if (el.textContent.trim()===title) { el.scrollIntoView({behavior:'smooth'}); break; }
}

function wordCount(text) {
  const w = text.trim().split(/\s+/).length;
  return `${w.toLocaleString()} words · ~${Math.max(1,Math.round(w/200))} min`;
}

function postProcess() {
  renderMermaid(document.getElementById('detail'));
  document.querySelectorAll('#detail pre code').forEach(el => safeHljs(el));
  document.querySelectorAll('#detail pre').forEach(pre => {
    if (pre.querySelector('.copy-btn')) return;
    const btn = document.createElement('button'); btn.className='copy-btn'; btn.textContent='Copy';
    btn.onclick = () => { navigator.clipboard.writeText(pre.querySelector('code')?.textContent||''); btn.textContent='✓'; setTimeout(()=>btn.textContent='Copy',1500); };
    pre.appendChild(btn);
  });
  highlightDetailMatches(document.getElementById('layout'), state.search);
}

function highlightDetailMatches(root, query) {
  const options = findOptions('content');
  const pattern = compileFindPattern(query, options.regex, options.caseSensitive);
  const current = findState.content;
  current.targets.forEach(target => target.classList.remove('search-current'));
  current.index = -1; current.targets = [];
  if (pattern === false) { clearFindMarks(root); updateFindStatus('content', true); return; }
  current.targets = markFindMatches(root, pattern);
  if (current.targets.length) { current.index = 0; current.targets[0].classList.add('search-current'); }
  updateFindStatus('content', false);
}

// ── Export a note to standalone HTML (open in browser / save to file) ────────
// Apply `fn` only OUTSIDE fenced/inline code so replacements never touch code
// (e.g. a mermaid `[[Kafka]]` node) — mirrors how marked tokenizes code first.
function outsideCode(md, fn) {
  return String(md).split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((p, i) => (i % 2 === 0) ? fn(p) : p).join('');
}
// Wiki links become plain styled spans (no target outside the panel).
function linkifyWikiExport(md) {
  return outsideCode(md, seg => seg.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, function(m, t, a) {
    return '<span class="wikilink">' + esc((a || t).trim()) + '</span>';
  }));
}
async function exportMarkdown(mode) {
  const d = currentDetail;
  if (!d || !['note', 'skill', 'paper'].includes(d.type)) return;
  // Linked exports: this note plus every note it links to (transitive closure).
  //   'browser'    -> temporary preview served in the browser (clickable links)
  //   'linkedSave' -> saved to a folder you pick (portable, shareable, offline)
  if (mode === 'linkedSave') {
    if (d.type === 'note') ask('collectLinkedNotes', { slug: d.slug, exportMode: 'save' });
    return;
  }
  if (mode === 'browser') {
    if (d.type === 'note') ask('collectLinkedNotes', { slug: d.slug, exportMode: 'browser' });
    else ask('openMarkdownPreview', {
      kind: d.type,
      key: d.type === 'skill' ? ((d.category ? d.category + '/' : '') + d.name) : d.slug,
    });
    return;
  }
  // Render markdown + highlight code, keeping _assets/ refs relative so the
  // extension can inline the images as data URIs for a self-contained file.
  let inner;
  try { inner = styleTasks((typeof marked !== 'undefined') ? marked.parse(linkifyWikiExport(d.content || '')) : '<pre>' + esc(d.content || '') + '</pre>'); }
  catch (e) { inner = '<pre>' + esc(d.content || '') + '</pre>'; }
  const tmp = document.createElement('div');
  tmp.innerHTML = inner;
  // Inline mermaid diagrams as self-contained SVG so the exported file needs no
  // runtime. Use the light theme to match the export page's white background.
  if (typeof mermaid !== 'undefined') {
    try { mermaid.initialize({ startOnLoad: false, suppressErrorRendering: true, securityLevel: 'antiscript', theme: 'default', fontFamily: 'inherit' }); _mermaidReady = true; } catch (e) {}
    try { await renderMermaid(tmp); } catch (e) {}
    _mermaidReady = false; initMermaidOnce(); // restore the panel's theme
  }
  tmp.querySelectorAll('pre code').forEach(el => safeHljs(el));
  ask('exportNoteHtml', {
    mode: mode,
    area: d.type + 's',
    slug: d.slug || d.name,
    title: d.title || d.name || '',
    category: d.category || '',
    tags: Array.isArray(d.tags) ? JSON.stringify(d.tags) : d.tags || '[]',
    noteType: d.note_type || d.type,
    updatedAt: d.updated_at || '',
    description: d.description || '',
    sourceProject: d.source_project || '',
    authors: d.authors || [],
    year: d.year || '',
    publisher: d.publisher || '',
    url: d.url || '',
    bodyHtml: tmp.innerHTML,
  });
}

// Render the linked-note closure (from collectLinkedNotes) into standalone HTML
// bodies and hand them to the extension to write + open in the browser. Each
// note's cross-note links have already been rewritten to sibling .html files.
async function renderLinkedExport(data) {
  const notes = (data && data.notes) || [];
  if (!notes.length) { vscode.postMessage({ command: 'toast', text: 'Nothing to export' }); return; }
  const useMermaid = (typeof mermaid !== 'undefined');
  if (useMermaid) { try { mermaid.initialize({ startOnLoad: false, suppressErrorRendering: true, securityLevel: 'antiscript', theme: 'default', fontFamily: 'inherit' }); _mermaidReady = true; } catch (e) {} }
  const files = [];
  for (const n of notes) {
    let inner;
    try { inner = styleTasks((typeof marked !== 'undefined') ? marked.parse(n.content || '') : '<pre>' + esc(n.content || '') + '</pre>'); }
    catch (e) { inner = '<pre>' + esc(n.content || '') + '</pre>'; }
    const tmp = document.createElement('div');
    tmp.innerHTML = inner;
    try { await renderMermaid(tmp); } catch (e) {}
    tmp.querySelectorAll('pre code').forEach(el => safeHljs(el));
    files.push({ filename: n.filename, slug: n.slug, bodyHtml: tmp.innerHTML });
  }
  if (useMermaid) { _mermaidReady = false; initMermaidOnce(); }
  ask('writeLinkedExport', { entryFilename: data.entryFilename, files, mode: data.mode || 'browser' });
}

// ── Note form ──────────────────────────────────────────────────────────────
function toggleNoteForm() {
  const nf = document.getElementById('note-form');
  if (!nf.classList.contains('hidden')) {
    document.getElementById('note-form-title').textContent = 'Quick Note';
    document.getElementById('note-edit-slug').value = '';
    document.getElementById('note-category').value = '';
  }
  nf.classList.toggle('hidden');
  if (!nf.classList.contains('hidden')) updateNotePreview();
}

function saveNote() {
  const title    = document.getElementById('note-title').value.trim();
  const content  = document.getElementById('note-content').value.trim();
  const type     = document.getElementById('note-type').value;
  const category = document.getElementById('note-category').value.trim();
  const tags     = document.getElementById('note-tags').value.split(',').map(t=>t.trim()).filter(Boolean);
  const editSlug = document.getElementById('note-edit-slug').value.trim();
  if (!content) return;
  ask('saveNote', { title: title || content.slice(0,60), content, type, category, tags, ...(editSlug ? { slug: editSlug } : {}) });
  if (editSlug) ask('detail', { type:'note', key: editSlug });
  document.getElementById('note-title').value   = '';
  document.getElementById('note-content').value  = '';
  document.getElementById('note-tags').value    = '';
  document.getElementById('note-category').value = '';
  document.getElementById('note-edit-slug').value = '';
  updateNotePreview();
  toggleNoteForm();
}

// ── Import / Export ────────────────────────────────────────────────────────
function doExport() { ask('export', {}); }

// Reload the DB from disk (picks up external / MCP changes), then re-render current tab
function doReload() {
  const btn = document.querySelector('#topbar .tbtn[onclick="doReload()"]');
  if (btn) { btn.disabled = true; btn.textContent = '↻ …'; }
  if (state.tab === 'environments') { ask('envList', {}); return; }
  ask('reload', {});
}
function triggerImport() { document.getElementById('import-file').click(); }
function doImport(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => { try { ask('import', { bundle: JSON.parse(e.target.result) }); } catch { alert('Invalid JSON file'); } };
  reader.readAsText(file);
  input.value = '';
}

// ── Sync modal ─────────────────────────────────────────────────────────────
let smCurrentTab = 'host';
let syncContent = {}; // loaded content lists per type

function openSyncModal() {
  document.getElementById('sync-modal-bg').classList.add('open');
  ask('getSyncContentList', {});
  ask('getSyncSessions', {});
}
function closeSyncModal() { document.getElementById('sync-modal-bg').classList.remove('open'); }
document.getElementById('sync-modal-bg').addEventListener('click', e => {
  if (e.target === document.getElementById('sync-modal-bg')) closeSyncModal();
});

function switchSmTab(tab) {
  smCurrentTab = tab;
  ['host','sessions','join'].forEach(t => {
    document.getElementById('sm-tab-'+t).classList.toggle('active', t===tab);
    document.getElementById('sm-pane-'+t).style.display = t===tab ? '' : 'none';
  });
}

function toggleAllSkills() {
  const boxes = document.querySelectorAll('#sync-type-sections input[type=checkbox][data-item]');
  const anyChecked = [...boxes].some(b => b.checked);
  boxes.forEach(b => b.checked = !anyChecked);
}

function buildTypeSections(content) {
  syncContent = content;
  const TYPES = [
    { id: 'skills',   label: 'Skills',   icon: '🧠', items: content.skills   || [] },
    { id: 'notes',    label: 'Notes',    icon: '📝', items: content.notes    || [] },
    { id: 'papers',   label: 'Papers',   icon: '📄', items: content.papers   || [] },
    { id: 'prompts',  label: 'Prompts',  icon: '💬', items: content.prompts  || [] },
    { id: 'scripts',  label: 'Scripts',  icon: '⚙️', items: content.scripts  || [] },
    { id: 'packages', label: 'Packages', icon: '📦', items: content.packages || [] },
  ];
  const wrap = document.getElementById('sync-type-sections');
  wrap.innerHTML = TYPES.map(t => {
    const open = t.id === 'skills';
    const body = t.items.length
      ? synRenderNode(t.id, synBuildTree(t.items), [], 0)
      : `<div style="color:var(--muted);font-size:11px;padding:6px">No ${t.label.toLowerCase()} found.</div>`;
    return `
    <div class="syn-sec">
      <div class="syn-sec-hd" onclick="toggleSyncType('${t.id}')">
        <input type="checkbox" id="ct-${t.id}" onclick="event.stopPropagation();syncTypeCheck('${t.id}')">
        <span style="font-size:12px;font-weight:600">${t.icon} ${t.label}</span>
        <span style="font-size:11px;color:var(--muted);margin-left:auto">${t.items.length} items</span>
        <span id="ct-arrow-${t.id}" style="font-size:10px;color:var(--muted)">${open?'▼':'▶'}</span>
      </div>
      <div id="ct-list-${t.id}" style="display:${open?'':'none'};max-height:220px;overflow-y:auto;padding:4px">${body}</div>
    </div>`;
  }).join('');
}

// Build a nested folder tree from flat items using their `cat` (slash path).
function synBuildTree(items) {
  const root = { folders: {}, items: [] };
  for (const it of items) {
    const segs = String(it.cat || '').split('/').map(s => s.trim()).filter(Boolean);
    let node = root;
    for (const s of segs) { node.folders[s] = node.folders[s] || { folders: {}, items: [] }; node = node.folders[s]; }
    node.items.push(it);
  }
  return root;
}
function synCountLeaves(node) {
  let n = node.items.length;
  for (const k in node.folders) n += synCountLeaves(node.folders[k]);
  return n;
}
function synRenderNode(type, node, path, depth) {
  let html = '';
  for (const name of Object.keys(node.folders).sort((a, b) => a.localeCompare(b))) {
    const child = node.folders[name];
    const fpath = path.concat(name);
    const fid = 'synf-' + type + '-' + btoa(unescape(encodeURIComponent(fpath.join('/')))).replace(/[^a-zA-Z0-9]/g, '');
    const pad = 6 + depth * 14;
    html += `<div class="syn-folder">
      <div class="syn-frow" style="padding-left:${pad}px">
        <input type="checkbox" class="syn-fchk" data-type="${type}" onchange="synFolderToggle(this)" title="Select everything in this folder">
        <span class="syn-farrow" onclick="synToggleFolder('${fid}',this)">▶</span>
        <span class="syn-fname" onclick="synToggleFolder('${fid}',this.parentElement.querySelector('.syn-farrow'))">📁 ${esc(name)}</span>
        <span class="syn-fcount">${synCountLeaves(child)}</span>
      </div>
      <div id="${fid}" class="syn-fbody" style="display:none">${synRenderNode(type, child, fpath, depth + 1)}</div>
    </div>`;
  }
  for (const it of node.items) {
    const pad = 6 + depth * 14 + 20;
    html += `<label class="syn-leaf" style="padding-left:${pad}px">
      <input type="checkbox" data-type="${type}" data-item="${esc(it.id)}" onchange="synLeafToggle('${type}')">
      <span class="syn-lname">${esc(it.label)}</span>${it.meta ? `<span class="cat">${esc(it.meta)}</span>` : ''}
    </label>`;
  }
  return html;
}
function synToggleFolder(fid, arrowEl) {
  const el = document.getElementById(fid); if (!el) return;
  const open = el.style.display === 'none';
  el.style.display = open ? '' : 'none';
  if (arrowEl && arrowEl.classList.contains('syn-farrow')) arrowEl.textContent = open ? '▼' : '▶';
}
// Recompute every folder + type header tri-state from the leaf checkboxes.
function synRefresh(type) {
  const listEl = document.getElementById('ct-list-' + type); if (!listEl) return;
  listEl.querySelectorAll('.syn-folder').forEach(folder => {
    const chk = folder.querySelector(':scope > .syn-frow > .syn-fchk');
    const leaves = [...folder.querySelectorAll('input[data-item]')];
    const c = leaves.filter(b => b.checked).length;
    if (chk) { chk.checked = c > 0 && c === leaves.length; chk.indeterminate = c > 0 && c < leaves.length; }
  });
  const header = document.getElementById('ct-' + type);
  const all = [...listEl.querySelectorAll('input[data-item]')];
  const c = all.filter(b => b.checked).length;
  if (header) { header.checked = c > 0 && c === all.length; header.indeterminate = c > 0 && c < all.length; }
}
function synFolderToggle(chk) {
  const folder = chk.closest('.syn-folder');
  folder.querySelectorAll('input[data-item]').forEach(b => b.checked = chk.checked);
  synRefresh(chk.dataset.type);
}
function synLeafToggle(type) { synRefresh(type); }

function toggleSyncType(id) {
  const list = document.getElementById('ct-list-'+id);
  const arrow = document.getElementById('ct-arrow-'+id);
  const hidden = list.style.display === 'none';
  list.style.display = hidden ? '' : 'none';
  arrow.textContent = hidden ? '▼' : '▶';
}

function syncTypeCheck(id) {
  // Header checkbox cascades to every item in this type (select-all / deselect-all)
  const header = document.getElementById('ct-'+id);
  document.querySelectorAll(`#ct-list-${id} input[data-item]`).forEach(b => b.checked = header.checked);
  synRefresh(id);
}

function renderSyncSessions(sessions) {
  const el = document.getElementById('sm-session-list');
  const now = new Date();
  if (!sessions?.length) { el.innerHTML = '<div style="color:var(--muted);font-size:12px">No sessions yet.</div>'; return; }
  el.innerHTML = sessions.map(s => {
    const active  = s.enabled && new Date(s.expires) > now;
    const expires = new Date(s.expires).toLocaleString();
    return `<div class="session-item ${active?'':'expired'}">
      <div class="session-info">
        <div class="session-name">Magic Code <span class="session-badge ${active?'badge-active':'badge-expired'}">${active?'Active':'Expired'}</span></div>
        <div class="session-meta">${esc(s.summary || ('Skills: ' + (s.skillCount === 'all' ? 'all' : s.skillCount)))} · Expires: ${expires}</div>
      </div>
      ${active ? `<button class="tbtn" style="color:#f87171;border-color:#f87171;font-size:11px" onclick="ask('revokeSync',{id:'${esc(s.id)}'})">Revoke</button>` : ''}
    </div>`;
  }).join('');
}

function doCreateSync() {
  const getSelected = (type) => {
    const checked = [...document.querySelectorAll(`#ct-list-${type} input[data-item]:checked`)];
    const all     = [...document.querySelectorAll(`#ct-list-${type} input[data-item]`)];
    return checked.length === all.length ? [] : checked.map(b => b.dataset.item);
  };
  const contentTypes = ['skills','notes','papers','prompts','scripts','packages']
    .filter(t => document.querySelectorAll(`#ct-list-${t} input[data-item]:checked`).length > 0);
  if (!contentTypes.length) {
    document.getElementById('sm-cred-result').innerHTML = '<span style="color:#f87171;font-size:12px">Select at least one item to share (check items under a section).</span>';
    return;
  }
  const selected = {
    skills:   getSelected('skills'),
    notes:    getSelected('notes'),
    papers:   getSelected('papers'),
    prompts:  getSelected('prompts'),
    scripts:  getSelected('scripts'),
    packages: getSelected('packages'),
  };
  const expiry = parseInt(document.getElementById('sm-expiry').value);
  const port   = parseInt(document.getElementById('sm-port').value) || 19878;
  document.getElementById('sm-cred-result').innerHTML = '<span style="color:var(--muted);font-size:12px">Generating…</span>';
  ask('startSync', { selected, contentTypes, expiresMinutes: expiry, port });
}

function doJoinSync() {
  const magicCode = document.getElementById('join-code').value.trim();
  if (!magicCode) { document.getElementById('join-result').innerHTML = '<span style="color:#f87171">Magic Code is required.</span>'; return; }
  if (document.getElementById('join-code').dataset.verifiedValue !== magicCode) {
    document.getElementById('join-result').innerHTML = '<span style="color:#f87171">Verify the current Magic Code before downloading.</span>';
    return;
  }
  const mode = (document.querySelector('input[name="join-mode"]:checked') || {}).value || 'overwrite';
  const groupLabel = (document.getElementById('join-group').value || '').trim();
  const button = document.getElementById('join-download');
  button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Downloading…';
  document.getElementById('join-result').innerHTML = '<span style="color:var(--muted)">Connecting…</span>';
  ask('joinSync', { magicCode, mode, groupLabel });
}
let magicCodeVerificationTimer = null;
let magicCodeVerificationRequest = 0;
function scheduleMagicCodeVerification() {
  const input = document.getElementById('join-code');
  const status = document.getElementById('join-code-verification');
  const button = document.getElementById('join-download');
  delete input.dataset.verifiedValue;
  button.disabled = true;
  clearTimeout(magicCodeVerificationTimer);
  const magicCode = input.value.trim();
  if (!magicCode) { status.textContent = 'Paste a Magic Code to verify it.'; return; }
  status.textContent = 'Checking checksum and encryption authentication…';
  const requestId = ++magicCodeVerificationRequest;
  magicCodeVerificationTimer = setTimeout(() => ask('verifySyncMagicCode', { magicCode, requestId }), 250);
}
function toggleJoinGroup() {
  const mode = (document.querySelector('input[name="join-mode"]:checked') || {}).value;
  document.getElementById('join-group-row').style.display = mode === 'group' ? '' : 'none';
}

// ── Category tree ─────────────────────────────────────────────────────────
function toggleCat(cat) {
  catExpanded[cat] = !catExpanded[cat];
  if (state.tab === 'environments') renderEnvTree();
  else renderList();
}

// ── Search highlight ──────────────────────────────────────────────────────
function hl(text, q) {
  if (!q) return esc(text);
  try {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi');
    let result='',last=0,m;
    while((m=re.exec(text))!==null){result+=esc(text.slice(last,m.index));result+=`<mark class="search-match">${esc(m[0])}</mark>`;last=re.lastIndex;}
    return result+esc(text.slice(last));
  } catch { return esc(text); }
}

// ── Skill edit / delete ───────────────────────────────────────────────────
function startEditSkill() {
  const d = currentDetail; if (!d) return;
  const tags = JSON.parse(d.tags||'[]');
  document.getElementById('detail').innerHTML = `
    <div class="d-title">✏ Edit: <span style="color:var(--accent)">${esc(d.name)}</span></div>
    <div class="form-row" style="gap:8px;margin-bottom:8px">
      <input id="se-desc" value="${esc(d.description||'')}" placeholder="Description" style="flex:2;background:var(--input);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px 8px;font-size:12px;outline:none">
      <input id="se-cat" value="${esc(d.category||'')}" placeholder="Category" style="flex:1;background:var(--input);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px 8px;font-size:12px;outline:none">
      <input id="se-tags" value="${esc(tags.join(', '))}" placeholder="tags, comma-sep" style="flex:1.5;background:var(--input);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px 8px;font-size:12px;outline:none">
    </div>
    <textarea id="se-content" style="width:100%;height:calc(100vh - 250px);background:var(--input);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:8px;font-size:12px;font-family:var(--vscode-editor-font-family);resize:none;outline:none;line-height:1.5">${esc(d.content||'')}</textarea>
    <div class="form-actions" style="margin-top:8px">
      <button class="tbtn" onclick="ask('detail',{type:'skill',key:currentDetail.name})">Cancel</button>
      <button class="tbtn" style="border-color:var(--accent)" onclick="submitSkillEdit()">💾 Save</button>
    </div>`;
  document.getElementById('se-content').focus();
}

function submitSkillEdit() {
  const d = currentDetail; if (!d) return;
  ask('saveSkill', { name: d.name,
    content:     document.getElementById('se-content').value,
    description: document.getElementById('se-desc').value.trim(),
    category:    document.getElementById('se-cat').value.trim(),
    tags:        document.getElementById('se-tags').value.split(',').map(t=>t.trim()).filter(Boolean) });
  ask('detail', { type:'skill', key: d.name });
}

function confirmDeleteSkill(btn) {
  const name = currentDetail?.name;
  if (!name) return;
  pkModal({ title:'Move Skill to Trash?', message:`${name}\n\nThe Skill remains recoverable until Empty Trash is used.`, okLabel:'Move to Trash', danger:true, onOk:()=>ask('deleteSkill',{name}) });
}

// ── Note edit ─────────────────────────────────────────────────────────────
function editNote(data) {
  document.getElementById('note-form-title').textContent = '✏ Edit Note';
  document.getElementById('note-title').value   = data.title || '';
  document.getElementById('note-content').value  = data.content || '';
  document.getElementById('note-type').value    = data.note_type || data.type || 'general';
  document.getElementById('note-category').value = data.category || '';
  document.getElementById('note-tags').value    = JSON.parse(data.tags||'[]').join(', ');
  document.getElementById('note-edit-slug').value = data.slug;
  const nf = document.getElementById('note-form');
  if (nf.classList.contains('hidden')) nf.classList.remove('hidden');
  updateNotePreview();
  nf.scrollIntoView({ behavior:'smooth' });
  setTimeout(() => document.getElementById('note-content').focus(), 100);
}

// Live Markdown preview for the note editor
function updateNotePreview() {
  const src = document.getElementById('note-content').value;
  const catEl = document.getElementById('note-category');
  const cat = catEl ? catEl.value : '';
  const el = document.getElementById('note-preview');
  if (el) { el.innerHTML = safeMarked(src, cat); renderMermaid(el); }
}

// ── Paste images into the note editor ────────────────────────────────────────
const pendingAssets = {};
function insertAtCursor(ta, text) {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  const pos = start + text.length;
  ta.selectionStart = ta.selectionEnd = pos;
  ta.focus();
}
(function initNotePaste() {
  const ta = document.getElementById('note-content');
  if (!ta) return;
  ta.addEventListener('paste', ev => {
    const items = (ev.clipboardData && ev.clipboardData.items) || [];
    let handled = false;
    for (const it of items) {
      if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
        const file = it.getAsFile();
        if (!file) continue;
        handled = true;
        const ext = (it.type.split('/')[1] || 'png').split('+')[0];
        const reader = new FileReader();
        reader.onload = () => {
          const b64 = String(reader.result || '').split(',')[1] || '';
          const reqId = 'a' + Date.now() + Math.random().toString(36).slice(2, 7);
          const placeholder = '![uploading…]()';
          insertAtCursor(ta, placeholder);
          updateNotePreview();
          pendingAssets[reqId] = (markdown, error) => {
            ta.value = ta.value.replace(placeholder, error ? '![paste failed]()' : markdown);
            updateNotePreview();
          };
          const catEl = document.getElementById('note-category');
          ask('saveAsset', { data: b64, ext, reqId, category: catEl ? catEl.value : '' });
        };
        reader.readAsDataURL(file);
      }
    }
    if (handled) ev.preventDefault();
  });
})();

// ── Papers ──────────────────────────────────────────────────────────────────
let paperTopicFilter = '';
let paperFacetsData = { topics: [], tags: [], years: [] };
let paperPickerItems = [];
let paperGraphOpen = false;
let cy = null;                 // cytoscape instance
let fg3d = null;               // 3d-force-graph instance
let paper3d = false;           // 2D (Cytoscape) vs 3D (three.js/WebGL) renderer
let _fg3dResize = null;        // ResizeObserver for the 3D canvas
let currentGraphData = null;
let currentGraphSig = '';      // signature of the currently rendered node/edge set
let pendingPaperFile = null;
let paperGroupsList = [{ name: 'Papers', count: 0 }];
let paperGroupExpanded = {};   // group name -> expanded (default true)

function togglePaperGroup(g) { paperGroupExpanded[g] = (paperGroupExpanded[g] === false); renderList(); }

// Floating context menu (built dynamically)
function showPaperMenu(x, y, items) {
  closePaperMenu();
  const m = document.createElement('div');
  m.id = 'paper-ctx';
  for (const it of items) {
    if (it.sep) { const d = document.createElement('div'); d.className = 'pctx-sep'; m.appendChild(d); continue; }
    const el = document.createElement('div');
    el.className = 'pctx-item' + (it.header ? ' pctx-header' : '') + (it.danger ? ' pctx-danger' : '') + (it.active ? ' pctx-active' : '') + (it.status ? ` prompt-version-${it.status}` : '') + (it.children ? ' pctx-has-submenu' : '');
    if (it.version) el.dataset.promptVersion = it.version;
    el.textContent = it.label;
    if (it.children) {
      const arrow = document.createElement('span'); arrow.className = 'pctx-arrow'; arrow.textContent = '›'; el.appendChild(arrow);
      const submenu = document.createElement('div'); submenu.className = 'pctx-submenu';
      for (const child of it.children) {
        if (child.sep) { const separator = document.createElement('div'); separator.className = 'pctx-sep'; submenu.appendChild(separator); continue; }
        const childElement = document.createElement('div');
        childElement.className = 'pctx-item' + (child.active ? ' pctx-active' : ''); childElement.textContent = child.label;
        childElement.onclick = ev => { ev.stopPropagation(); closePaperMenu(); child.onClick(); };
        submenu.appendChild(childElement);
      }
      el.appendChild(submenu);
      el.onclick = ev => ev.stopPropagation();
    } else if (!it.header) el.onclick = ev => { ev.stopPropagation(); closePaperMenu(); it.onClick(); };
    m.appendChild(el);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}
function closePaperMenu() { const m = document.getElementById('paper-ctx'); if (m) m.remove(); }
document.addEventListener('click', closePaperMenu);

// In-webview prompt/confirm (native prompt()/confirm() are blocked in VS Code webviews).
function pkModal(opts) {
  closePkModal();
  const bg = document.createElement('div');
  bg.id = 'pk-modal-bg';
  bg.innerHTML = '<div id="pk-modal">' +
    '<div class="pk-modal-title">' + esc(opts.title || '') + '</div>' +
    (opts.message ? '<div class="pk-modal-msg">' + esc(opts.message) + '</div>' : '') +
    (opts.input ? '<input id="pk-modal-input" type="text">' : '') +
    (opts.textarea ? '<textarea id="pk-modal-textarea" rows="3" placeholder="' + esc(opts.textareaPlaceholder || '') + '" style="width:100%;box-sizing:border-box;margin-top:8px;background:var(--input);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:6px;font-size:12px;resize:vertical;outline:none"></textarea>' : '') +
    (opts.checkbox ? '<label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;cursor:pointer"><input type="checkbox" id="pk-modal-check"> ' + esc(opts.checkbox.label || '') + '</label>' : '') +
    '<div class="pk-modal-actions">' +
      '<button class="tbtn" id="pk-modal-cancel">Cancel</button>' +
      '<button class="tbtn" id="pk-modal-ok" style="border-color:var(--accent)' + (opts.danger ? ';color:#f87171' : '') + '">' + esc(opts.okLabel || 'OK') + '</button>' +
    '</div></div>';
  document.body.appendChild(bg);
  const input = document.getElementById('pk-modal-input');
  if (input) input.value = opts.defaultValue || '';
  const ta = document.getElementById('pk-modal-textarea');
  if (ta) ta.value = opts.textareaValue || '';
  const chk = document.getElementById('pk-modal-check');
  if (chk && opts.checkbox && opts.checkbox.checked) chk.checked = true;
  const done = ok => { const v = input ? input.value : ''; const tv = ta ? ta.value : ''; const cv = chk ? chk.checked : false; closePkModal(); if (ok && opts.onOk) opts.onOk(v, tv, cv); };
  document.getElementById('pk-modal-ok').onclick = () => done(true);
  document.getElementById('pk-modal-cancel').onclick = () => done(false);
  bg.onclick = e => { if (e.target === bg) done(false); };
  if (input) { input.focus(); input.select(); input.onkeydown = e => { if (e.key === 'Enter' && !ta) done(true); else if (e.key === 'Escape') done(false); }; }
  else document.getElementById('pk-modal-ok').focus();
}
function closePkModal() { const m = document.getElementById('pk-modal-bg'); if (m) m.remove(); }

function paperCardMenu(ev, slug, group, pinned, topic) {
  ev.preventDefault(); ev.stopPropagation();
  const items = [];
  items.push({ label: pinned ? '★ Unpin' : '☆ Pin', onClick: () => ask('paperSetPinned', { slug, pinned: !pinned }) });
  items.push({ sep: true });
  items.push({ label: 'Move to group', header: true });
  for (const g of paperGroupsList) {
    items.push({ label: (g.name === group ? '● ' : '   ') + g.name, active: g.name === group, onClick: () => ask('paperSetGroup', { slug, group: g.name }) });
  }
  items.push({ label: '＋ New group…', onClick: () => pkModal({ title: 'New group', input: true, okLabel: 'Create', onOk: v => { if (v.trim()) ask('paperSetGroup', { slug, group: v.trim() }); } }) });
  items.push({ sep: true });
  items.push({ label: '↪ Change topic…', onClick: () => pkModal({ title: 'Change topic', message: 'Moves this paper to a different topic folder.', input: true, defaultValue: topic || '', okLabel: 'Move', onOk: v => ask('paperSetTopic', { slug, topic: v.trim() }) }) });
  items.push({ sep: true });
  items.push({ label: '✏ Edit Content', onClick: () => openMarkdownItem('papers', '', slug) });
  items.push({ label: '⚙ Edit Metadata', onClick: () => editMarkdownMetadataItem('papers', '', slug) });
  items.push({ label: '🗑 Move to Trash…', danger: true, onClick: () => pkModal({ title: 'Move this Paper to Trash?', message:'The Paper remains recoverable until permanently deleted.', okLabel: 'Move to Trash', danger: true, onOk: () => ask('deletePaper', { slug }) }) });
  showPaperMenu(ev.clientX, ev.clientY, items);
}

function paperGroupMenu(ev, group) {
  ev.preventDefault(); ev.stopPropagation();
  const items = [{ label: '📁 ' + group, header: true }];
  items.push({ label: '＋ New Paper…', onClick: () => ask('createKnowledgeItem', { area: 'papers', kind: 'paper', group }) });
  items.push({ label: '💡 New Idea…', onClick: () => ask('createKnowledgeItem', { area: 'papers', kind: 'idea', group }) });
  items.push({ sep: true });
  if (group !== 'Papers') {
    items.push({ label: '✏ Rename group…', onClick: () => pkModal({ title: 'Rename group', input: true, defaultValue: group, okLabel: 'Rename', onOk: v => { if (v.trim() && v.trim() !== group) ask('paperGroupRename', { oldName: group, newName: v.trim() }); } }) });
    items.push({ label: '🗑 Delete group', danger: true, onClick: () => pkModal({ title: 'Delete group “' + group + '”?', message: 'Its items move back to “Papers”.', okLabel: 'Delete', danger: true, onOk: () => ask('paperGroupDelete', { name: group }) }) });
  } else {
    items.push({ label: 'Default group (can’t rename/delete)', header: true });
  }
  showPaperMenu(ev.clientX, ev.clientY, items);
}

// Right-click a physical Paper folder -> create content, set top-level privacy, or move its papers to a display group.
function paperFolderMenu(ev, b64, name, path) {
  ev.preventDefault(); ev.stopPropagation();
  let slugs = [];
  try { slugs = JSON.parse(decodeURIComponent(escape(atob(b64)))); } catch (e) {}
  if (!slugs.length) return;
  const items = [{ label: 'Folder: ' + name, header: true }];
  appendPrivacyMenu(items, 'papers', path);
  items.push({ label: '＋ New Paper…', onClick: () => ask('createKnowledgeItem', { area: 'papers', kind: 'paper', category: path }) });
  items.push({ label: '💡 New Idea…', onClick: () => ask('createKnowledgeItem', { area: 'papers', kind: 'idea', category: path }) });
  items.push({ sep: true });
  items.push({ label: 'Move folder contents (' + slugs.length + ') to group', header: true });
  for (const g of paperGroupsList) {
    items.push({ label: '   ' + g.name, onClick: () => ask('paperSetGroupMany', { slugs, group: g.name }) });
  }
  items.push({ label: '＋ New group…', onClick: () => pkModal({ title: 'Move folder “' + name + '” to a new group', input: true, okLabel: 'Create & move', onOk: v => { if (v.trim()) ask('paperSetGroupMany', { slugs, group: v.trim() }); } }) });
  showPaperMenu(ev.clientX, ev.clientY, items);
}

function promptFolderMenu(ev, project, task, version) {
  ev.preventDefault(); ev.stopPropagation();
  const scope = [project, task, version].filter(Boolean).join(' / ');
  const items = [
    { label: scope, header: true },
    { label: '＋ New Prompt…', onClick: () => ask('createPromptItem', { project, task, version }) },
  ];
  if (!task && !version) appendPrivacyMenu(items, 'prompts', project);
  items.push({ sep:true });
  items.push({ label:'🗑 Move folder to Trash…', danger:true, onClick:()=>moveKnowledgeFolderToTrash('prompts',[project,task,version].filter(Boolean).join('/'),scope) });
  showPaperMenu(ev.clientX, ev.clientY, items);
}

function promptItemTrashMenu(ev, path, name, project, task, version) {
  ev.preventDefault(); ev.stopPropagation();
  showPaperMenu(ev.clientX, ev.clientY, [{label:name,header:true},{label:'↗ Open in Text Editor',onClick:()=>ask('promptOpenTextEditor',{project,task,version,file:name})},{sep:true},{label:'🗑 Move to Trash…',danger:true,onClick:()=>moveKnowledgeItemToTrash('prompts',path,name)}]);
}

function moveKnowledgeFolderToTrash(area, path, name) {
  pkModal({ title:`Move ${name} to Trash?`, message:'The folder and all its contents remain recoverable until permanently deleted.', okLabel:'Move to Trash', danger:true, onOk:()=>ask('knowledgeTrashMove',{area,path,kind:'folder',name}) });
}

function moveKnowledgeItemToTrash(area, path, name) {
  pkModal({ title:`Move ${name} to Trash?`, message:'The item remains recoverable until permanently deleted.', okLabel:'Move to Trash', danger:true, onOk:()=>ask('knowledgeTrashMove',{area,path,kind:'item',name}) });
}

// Right-click a Skills category folder -> rename it (re-paths all skills under it).
function skillFolderMenu(ev, b64, name) {
  ev.preventDefault(); ev.stopPropagation();
  let prefix = '';
  try { prefix = decodeURIComponent(escape(atob(b64))); } catch (e) {}
  if (!prefix) return;
  const items = [{ label: '📁 ' + name, header: true }];
  appendPrivacyMenu(items, 'skills', prefix);
  items.push({ label: '＋ New Skill…', onClick: () => ask('createKnowledgeItem', { area: 'skills', category: prefix }) });
  items.push({ label: '＋ Create Subfolder…', onClick: () => pkModal({
    title: 'Create sub-folder', message: 'New folder under “' + prefix + '”.',
    input: true, okLabel: 'Create', onOk: v => { const n = v.trim(); if (n) ask('folderCreate', { area: 'skills', parent: prefix, name: n }); } }) });
  items.push({ sep: true });
  items.push({ label: '✏ Rename folder…', onClick: () => pkModal({
    title: 'Rename folder', message: 'Renames “' + prefix + '” and re-paths every skill under it.',
    input: true, defaultValue: name, okLabel: 'Rename', onOk: v => {
      const nn = v.trim();
      if (!nn || nn === name) return;
      const segs = prefix.split('/'); segs[segs.length - 1] = nn;
      ask('skillRenameFolder', { oldPrefix: prefix, newPrefix: segs.join('/') });
    } }) });
  items.push({ label: '↪ Move folder…', onClick: () => pkModal({
    title: 'Move folder', message: 'New full path for “' + prefix + '” (missing parents are created).',
    input: true, defaultValue: prefix, okLabel: 'Move', onOk: v => {
      const np = v.trim().replace(/^\/+|\/+$/g, '');
      if (np && np !== prefix) ask('skillRenameFolder', { oldPrefix: prefix, newPrefix: np });
    } }) });
  items.push({ sep: true });
  items.push({ label: '🗑 Move folder to Trash…', danger: true, onClick: () => pkModal({ title:'Move Skill folder to Trash?', message:`${prefix}\n\nAll Skills and subfolders will remain recoverable from Trash.`, okLabel:'Move to Trash', danger:true, onOk:()=>ask('skillTrashFolder',{path:prefix}) }) });
  showPaperMenu(ev.clientX, ev.clientY, items);
}

// Right-click a Skills leaf -> Move / Edit.
function skillItemMenu(ev, name, category) {
  ev.preventDefault(); ev.stopPropagation();
  const items = [{ label: '📄 ' + name, header: true }];
  items.push({ label: '↪ Move…', onClick: () => pkModal({
    title: 'Move skill', message: 'Target folder path (blank = root; missing parents are created).',
    input: true, defaultValue: category || '', okLabel: 'Move', onOk: v => ask('skillMove', { name, category: v.trim() }) }) });
  items.push({ sep: true });
  items.push({ label: '✏ Edit Content', onClick: () => openMarkdownItem('skills', category, name) });
  items.push({ label: '⚙ Edit Metadata', onClick: () => editMarkdownMetadataItem('skills', category, name) });
  items.push({ sep: true });
  items.push({ label: '🗑 Move to Trash…', danger: true, onClick: () => pkModal({ title:'Move Skill to Trash?', message:`${name}\n\nThe Skill remains recoverable from Trash.`, okLabel:'Move to Trash', danger:true, onOk:()=>ask('deleteSkill',{name}) }) });
  showPaperMenu(ev.clientX, ev.clientY, items);
}

// Right-click a Notes category folder -> Rename / Move.
function noteFolderMenu(ev, b64, name) {
  ev.preventDefault(); ev.stopPropagation();
  let prefix = '';
  try { prefix = decodeURIComponent(escape(atob(b64))); } catch (e) {}
  if (!prefix) return;
  const items = [{ label: '📁 ' + name, header: true }];
  appendPrivacyMenu(items, 'notes', prefix);
  items.push({ label: '＋ New Note…', onClick: () => ask('createKnowledgeItem', { area: 'notes', category: prefix }) });
  items.push({ label: '＋ Create Subfolder…', onClick: () => pkModal({
    title: 'Create sub-folder', message: 'New folder under “' + prefix + '”.',
    input: true, okLabel: 'Create', onOk: v => { const n = v.trim(); if (n) ask('folderCreate', { area: 'notes', parent: prefix, name: n }); } }) });
  const fpinned = notePinnedFolders.includes(prefix);
  items.push({ label: fpinned ? '★ Unpin folder' : '☆ Pin folder', onClick: () => ask('noteSetFolderPinned', { prefix, pinned: !fpinned }) });
  items.push({ label: '✏ Rename folder…', onClick: () => pkModal({
    title: 'Rename folder', message: 'Renames “' + prefix + '” and re-paths every note under it.',
    input: true, defaultValue: name, okLabel: 'Rename', onOk: v => {
      const nn = v.trim();
      if (!nn || nn === name) return;
      const segs = prefix.split('/'); segs[segs.length - 1] = nn;
      ask('noteMoveFolder', { oldPrefix: prefix, newPrefix: segs.join('/') });
    } }) });
  items.push({ label: '↪ Move folder…', onClick: () => pkModal({
    title: 'Move folder', message: 'New full path for “' + prefix + '” (missing parents are created).',
    input: true, defaultValue: prefix, okLabel: 'Move', onOk: v => {
      const np = v.trim().replace(/^\/+|\/+$/g, '');
      if (np && np !== prefix) ask('noteMoveFolder', { oldPrefix: prefix, newPrefix: np });
    } }) });
  items.push({ sep:true });
  items.push({ label:'🗑 Move folder to Trash…',danger:true,onClick:()=>moveKnowledgeFolderToTrash('notes',prefix,name) });
  showPaperMenu(ev.clientX, ev.clientY, items);
}

// Right-click a Scripts category folder -> Rename / Move (re-paths every script under it).
function scriptFolderMenu(ev, b64, name) {
  ev.preventDefault(); ev.stopPropagation();
  let prefix = '';
  try { prefix = decodeURIComponent(escape(atob(b64))); } catch (e) {}
  if (!prefix) return;
  const items = [{ label: '📁 ' + name, header: true }];
  appendPrivacyMenu(items, 'scripts', prefix);
  items.push({ label: '＋ New Script…', onClick: () => ask('createScript', { folder: prefix }) });
  items.push({ label: '📂 Open Folder (new window)', onClick: () => ask('openStoreFolder', { area: 'scripts', rel: prefix }) });
  items.push({ sep: true });
  items.push({ label: '✏ Rename folder…', onClick: () => pkModal({
    title: 'Rename folder', message: 'Renames “' + prefix + '” and re-paths every script under it.',
    input: true, defaultValue: name, okLabel: 'Rename', onOk: v => {
      const nn = v.trim();
      if (!nn || nn === name) return;
      const segs = prefix.split('/'); segs[segs.length - 1] = nn;
      ask('scriptMoveFolder', { oldPrefix: prefix, newPrefix: segs.join('/') });
    } }) });
  items.push({ label: '↪ Move folder…', onClick: () => pkModal({
    title: 'Move folder', message: 'New full path for “' + prefix + '” (missing parents are created).',
    input: true, defaultValue: prefix, okLabel: 'Move', onOk: v => {
      const np = v.trim().replace(/^\/+|\/+$/g, '');
      if (np && np !== prefix) ask('scriptMoveFolder', { oldPrefix: prefix, newPrefix: np });
    } }) });
  items.push({ sep:true });
  items.push({ label:'🗑 Move folder to Trash…',danger:true,onClick:()=>moveKnowledgeFolderToTrash('scripts',prefix,name) });
  showPaperMenu(ev.clientX, ev.clientY, items);
}

// Right-click a Scripts leaf -> Move / Edit.
function scriptItemMenu(ev, relPath, category) {
  ev.preventDefault(); ev.stopPropagation();
  const file = String(relPath).split('/').pop();
  const items = [{ label: '📄 ' + file, header: true }];
  items.push({ label: '✏ Edit', onClick: () => ask('openStoreFile', { area: 'scripts', rel: relPath }) });
  items.push({ sep: true });
  items.push({ label: '↪ Move…', onClick: () => pkModal({
    title: 'Move script', message: 'Target folder path (blank = root; missing parents are created).',
    input: true, defaultValue: category || '', okLabel: 'Move', onOk: v => ask('scriptMove', { relPath, category: v.trim() }) }) });
  items.push({ label: '🗑 Move to Trash…', danger: true, onClick: () => moveKnowledgeItemToTrash('scripts',relPath,relPath.split('/').pop()) });
  showPaperMenu(ev.clientX, ev.clientY, items);
}

// Right-click a Package -> open its folder in a new window.
function packageItemMenu(ev, name) {
  ev.preventDefault(); ev.stopPropagation();
  const items = [
    { label: '📦 ' + name, header: true },
    { label: '📂 Open Folder (new window)', onClick: () => ask('openStoreFolder', { area: 'packages', rel: name }) },
    { sep: true },
    { label: '🗑 Delete Package…', danger: true, onClick: () => confirmDeletePackage(name) },
  ];
  appendPrivacyMenu(items, 'packages', name);
  showPaperMenu(ev.clientX, ev.clientY, items);
}

// First confirmation: require the user to type the exact package name.
// A second (native modal) confirmation happens in the extension host.
function confirmDeletePackage(name) {
  pkModal({
    title: 'Delete package “' + name + '”?',
    message: 'This permanently removes the entire package folder. Type the package name below to confirm.',
    input: true,
    okLabel: 'Delete',
    danger: true,
    onOk: v => {
      if ((v || '').trim() !== name) {
        pkModal({ title: 'Name did not match', message: 'Deletion cancelled — the text you typed did not match “' + name + '”.', okLabel: 'OK' });
        return;
      }
      ask('packageDelete', { name });
    }
  });
}


// List view
function renderPaperFilters(fEl) {
  const opts = ['<option value="">All topics</option>'].concat(
    paperFacetsData.topics.map(t => `<option value="${esc(t.name)}"${t.name === paperTopicFilter ? ' selected' : ''}>${esc(t.name)} (${t.count})</option>`)).join('');
  fEl.innerHTML = `<div style="padding:6px 8px"><select id="paper-topic-filter" style="width:100%" onchange="setPaperTopic(this.value)">${opts}</select></div>`;
}
function setPaperTopic(v) { paperTopicFilter = v; renderList(); }
function paperCard(p, q, pad) {
  const authors = (p.authors || []).slice(0, 3).join(', ') + ((p.authors || []).length > 3 ? ' et al.' : '');
  const tags = (p.tags || []).map(t => `<span class="pc-tag">${esc(t)}</span>`).join('');
  const grp = JSON.stringify(p.group || 'Papers').replace(/"/g, '&quot;');
  const tpc = JSON.stringify(p.topic || '').replace(/"/g, '&quot;');
  return `<div class="paper-card${p.pinned ? ' pc-pinned' : ''}" style="margin-left:${pad}px" onclick="openItem('paper','${esc(p.slug)}')" oncontextmenu="paperCardMenu(event,'${esc(p.slug)}',${grp},${p.pinned ? 'true' : 'false'},${tpc})">
    <div class="pc-title"><span class="pc-star${p.pinned ? ' on' : ''}" onclick="event.stopPropagation();togglePin('${esc(p.slug)}',${p.pinned ? 'false' : 'true'})" title="${p.pinned ? 'Unpin' : 'Pin'}">${p.pinned ? '★' : '☆'}</span> ${privacyLock(p.isPrivate)}${hl(p.title, q)}</div>
    <div class="pc-meta">
      ${p.citationCount ? `<span class="pc-cite" title="cited by ${p.citationCount} paper(s)">${p.citationCount}★</span>` : ''}
      ${p.year ? `<span>${p.year}</span>` : ''}
      ${authors ? `<span>${esc(authors)}</span>` : ''}
      ${p.publisher ? `<span>${esc(p.publisher)}</span>` : ''}
      ${tags}
    </div>
  </div>`;
}
function togglePin(slug, pinned) {
  ask('paperSetPinned', { slug, pinned });
  if (currentDetail && currentDetail.type === 'paper' && currentDetail.slug === slug) {
    currentDetail.pinned = pinned; renderDetail(currentDetail);
  }
}

// Detail view
function paperDetailHtml(d) {
  const authors = (d.authors || []).join(', ');
  const tags = (d.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const concl = d.conclusions || [];
  const cites = d.resolvedCites || d.cites || [];
  return `
    <div class="d-title"><span>${esc(d.title)}</span>${privacyLock(d.isPrivate)}<button class="meta-edit" onclick="editCurrentMetadata('title')" title="Edit title">✎</button></div>
    ${detailPathHtml(d)}
    <div class="d-meta">
      ${d.kind === 'idea' ? '<span class="pc-cite" style="background:#f4b400;color:#1a1200">Idea</span>' : ''}
      ${d.group && d.group !== 'Papers' ? `<span class="pc-tag">📁 ${esc(d.group)}</span>` : ''}
      ${d.citationCount ? `<span class="pc-cite">${d.citationCount}★ cited</span>` : ''}
      ${d.year ? `<span>${d.year}</span>` : ''}
      ${d.topic ? `<span class="cat">${esc(d.topic)}</span>` : ''}
      ${d.publisher ? `<span>${esc(d.publisher)}</span>` : ''}
      ${tags}
      <button class="meta-edit" onclick="editCurrentMetadata('tags')" title="Edit tags">✎</button>
      <span style="flex:1"></span>
      ${d.url ? `<button class="tbtn" style="font-size:11px" onclick="openPaperLink('${esc(d.url)}','','')">🔗 Link</button>` : ''}
      ${d.file ? `<button class="tbtn" style="font-size:11px" onclick="openPaperLink('','${esc(d.file)}','${esc(d.category)}')">📄 File</button>` : ''}
      <button class="tbtn" style="font-size:11px" onclick="openPaperForm(currentDetail)">✎ Edit Fields</button>
      ${markdownToolbar(d)}
      <button class="tbtn" style="font-size:11px" onclick="confirmDeletePaper()">🗑 Move to Trash</button>
    </div>
    <div class="meta-grid">
      <span class="ml">Description</span><span class="mv meta-value"><span>${esc(d.description || '—')}</span><button class="meta-edit" onclick="editCurrentMetadata('description')" title="Edit description">✎</button></span>
      <span class="ml">Authors</span><span class="mv">${esc(authors || '—')}</span>
      ${d.url ? `<span class="ml">URL</span><span class="mv">${esc(d.url)}</span>` : ''}
      ${d.file ? `<span class="ml">File</span><span class="mv">${esc(d.file.split('/').pop())}</span>` : ''}
    </div>
    ${paperListSection('Conclusions', concl)}
    ${paperListSection('Implementation', d.implementation || [])}
    ${paperListSection('Assumptions', d.assumptions || [])}
    ${paperLinksSection('Cites', cites, 'No citations.')}
    ${paperLinksSection('Cited by', d.citedBy || [], 'Not cited by another paper.')}
    ${paperContentSection(d.content || '', d.category)}`;
}
function paperSection(title, count, body, open) {
  return `<details class="paper-section"${open ? ' open' : ''}><summary>${esc(title)}<span class="paper-section-count">${count ? count : 'empty'}</span></summary><div class="paper-section-body">${body}</div></details>`;
}
function paperListSection(title, items) {
  const values = (items || []).filter(Boolean);
  const body = values.length ? `<ul class="prose">${values.map(value => `<li>${esc(value)}</li>`).join('')}</ul>` : '<div class="paper-section-empty">No entries.</div>';
  return paperSection(title, values.length, body, values.length > 0);
}
function paperLinksSection(title, papers, emptyText) {
  const values = papers || [];
  const body = values.length ? `<ul class="prose">${values.map(cite => {
    const title = cite.title || cite.paper;
    const target = cite.slug || '';
    const link = target ? `<a class="paper-cite-link" onclick="openItem('paper','${esc(target)}')">${esc(title)}</a>` : `<span>${esc(title)}</span>`;
    return `<li>${link}${cite.note ? ' — ' + esc(cite.note) : ''}</li>`;
  }).join('')}</ul>` : `<div class="paper-section-empty">${esc(emptyText)}</div>`;
  return paperSection(title, values.length, body, values.length > 0);
}
function paperContentSection(content, category) {
  const value = String(content || '');
  const body = value.trim() ? `<div class="prose">${safeMarked(value, category)}</div>` : '<div class="paper-section-empty">No content.</div>';
  return paperSection('Content', value.trim() ? wordCount(value) : 0, body, !!value.trim());
}
function openPaperLink(url, file, category) { ask('openPaperLink', { url, file, category }); }
function confirmDeletePaper() { if (currentDetail) pkModal({ title: 'Move this Paper to Trash?', message:'The Paper remains recoverable until permanently deleted.', okLabel: 'Move to Trash', danger: true, onOk: () => ask('deletePaper', { slug: currentDetail.slug }) }); }

// Add / edit form
function openPaperForm(paper) {
  const isEdit = !!(paper && paper.slug);
  document.getElementById('paper-form-title').textContent = isEdit ? 'Edit Paper' : 'New Paper';
  const set = (id, v) => { document.getElementById(id).value = v; };
  set('pf-title', paper?.title || ''); set('pf-year', paper?.year || '');
  set('pf-authors', (paper?.authors || []).join(', ')); set('pf-topic', paper?.topic || '');
  set('pf-publisher', paper?.publisher || ''); set('pf-category', paper?.category || '');
  set('pf-tags', (paper?.tags || []).join(', ')); set('pf-url', paper?.url || '');
  set('pf-file', paper?.file || '');
  document.getElementById('pf-file-label').textContent = paper?.file ? paper.file.split('/').pop() : '';
  set('pf-conclusions', (paper?.conclusions || []).join('\n'));
  set('pf-implementation', (paper?.implementation || []).join('\n'));
  set('pf-assumptions', (paper?.assumptions || []).join('\n'));
  set('pf-content', paper?.content || ''); set('pf-slug', paper?.slug || '');
  if (!paperPickerItems.length) paperPickerItems = (state.items || []).map(item => ({ slug: item.slug, title: item.title }));
  renderPaperCites(paper?.cites || []);
  ask('paperPicker', {});
  set('pf-group', (paper?.group && paper.group !== 'Papers') ? paper.group : '');
  document.getElementById('pf-group-list').innerHTML = paperGroupsList.map(g => `<option value="${esc(g.name)}"></option>`).join('');
  document.getElementById('pf-kind-idea').checked = paper?.kind === 'idea';
  updatePaperPreview();
  document.getElementById('detail').style.display = 'none';
  document.getElementById('paper-graph-view').classList.add('hidden');
  document.getElementById('paper-form').classList.remove('hidden');
}
function closePaperForm() {
  document.getElementById('paper-form').classList.add('hidden');
  document.getElementById('detail').style.display = '';
}
function editPaper(p) { openPaperForm(p); }
function updatePaperPreview() {
  const el = document.getElementById('pf-preview');
  if (el) { el.innerHTML = safeMarked(document.getElementById('pf-content').value, document.getElementById('pf-category').value); renderMermaid(el); }
}
function readPaperCites() {
  return Array.from(document.querySelectorAll('#pf-cites .paper-cite-row')).map(row => ({
    paper: row.querySelector('select').value,
    note: row.querySelector('input').value.trim(),
  })).filter(cite => cite.paper);
}
function renderPaperCites(cites) {
  const host = document.getElementById('pf-cites');
  if (!host) return;
  const currentSlug = document.getElementById('pf-slug').value;
  const papers = paperPickerItems.filter(paper => paper.slug !== currentSlug).sort((a, b) => a.title.localeCompare(b.title));
  host.innerHTML = (cites || []).map((cite, index) => {
    const match = papers.find(paper => paper.slug === cite.paper || paper.title === cite.paper);
    const selected = match ? match.slug : cite.paper;
    const missing = selected && !match ? `<option value="${esc(selected)}" selected disabled>Missing: ${esc(selected)}</option>` : '';
    const options = papers.map(paper => `<option value="${esc(paper.slug)}"${paper.slug === selected ? ' selected' : ''}>${esc(paper.title)}</option>`).join('');
    return `<div class="paper-cite-row"><select aria-label="Cited paper">${missing}${options}</select><input aria-label="Citation note" value="${esc(cite.note || '')}" placeholder="How this paper builds on it"><button type="button" class="tbtn" onclick="removePaperCite(${index})" title="Remove citation">✕</button></div>`;
  }).join('') || '<div class="paper-section-empty">No citations selected.</div>';
}
function addPaperCite() {
  const cites = readPaperCites();
  const currentSlug = document.getElementById('pf-slug').value;
  const used = new Set(cites.map(cite => cite.paper));
  const next = paperPickerItems.find(paper => paper.slug !== currentSlug && !used.has(paper.slug));
  if (!next) { ask('toast', { text: 'No more papers are available to cite' }); return; }
  cites.push({ paper: next.slug, note: '' });
  renderPaperCites(cites);
}
function removePaperCite(index) {
  const cites = readPaperCites();
  cites.splice(index, 1);
  renderPaperCites(cites);
}
function uploadPaperFile(input) {
  const file = input.files[0]; if (!file) return;
  const ext = (file.name.split('.').pop() || 'pdf').toLowerCase();
  const reader = new FileReader();
  reader.onload = () => {
    const b64 = String(reader.result || '').split(',')[1] || '';
    pendingPaperFile = (rel, err) => {
      if (!err && rel) { document.getElementById('pf-file').value = rel; document.getElementById('pf-file-label').textContent = file.name; }
    };
    ask('savePaperFile', { data: b64, ext, category: document.getElementById('pf-category').value, reqId: 'pf' + Date.now() });
  };
  reader.readAsDataURL(file);
}
function savePaper() {
  const val = id => document.getElementById(id).value;
  const splitLines = v => v.split(/\n/).map(s => s.trim()).filter(Boolean);
  const cites = readPaperCites().filter((cite, index, all) => all.findIndex(item => item.paper === cite.paper) === index);
  const title = val('pf-title').trim();
  if (!title) { ask('toast', { text: 'Paper title is required' }); document.getElementById('pf-title').focus(); return; }
  const paper = {
    slug: val('pf-slug') || '', title,
    year: val('pf-year') ? parseInt(val('pf-year'), 10) : null,
    authors: val('pf-authors').split(',').map(s => s.trim()).filter(Boolean),
    topic: val('pf-topic').trim(), publisher: val('pf-publisher').trim(),
    category: val('pf-category').trim(),
    tags: val('pf-tags').split(',').map(s => s.trim()).filter(Boolean),
    url: val('pf-url').trim(), file: val('pf-file').trim(),
    conclusions: splitLines(val('pf-conclusions')),
    implementation: splitLines(val('pf-implementation')),
    assumptions: splitLines(val('pf-assumptions')), cites,
    kind: document.getElementById('pf-kind-idea').checked ? 'idea' : 'paper',
    group: val('pf-group').trim() || 'Papers',
    content: document.getElementById('pf-content').value,
  };
  ask('savePaper', { paper });
  closePaperForm();
}

// Graph view
function togglePaperGraph() {
  paperGraphOpen = !paperGraphOpen;
  const gb = document.getElementById('btn-paper-graph');
  if (paperGraphOpen) {
    document.getElementById('detail').style.display = 'none';
    document.getElementById('paper-form').classList.add('hidden');
    document.getElementById('paper-graph-view').classList.remove('hidden');
    gb.textContent = '📋 List';
    populatePaperTopicSelect();
    loadPaperGraph();
  } else {
    document.getElementById('paper-graph-view').classList.add('hidden');
    document.getElementById('detail').style.display = '';
    gb.textContent = '🕸 Graph';
  }
}
function populatePaperTopicSelect() {
  const sel = document.getElementById('pg-topic');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All topics</option>' +
    paperFacetsData.topics.map(t => `<option value="${esc(t.name)}">${esc(t.name)} (${t.count})</option>`).join('');
  sel.value = cur;
}
function loadPaperGraph() {
  const opts = {
    topic: document.getElementById('pg-topic').value || undefined,
    limit: parseInt(document.getElementById('pg-limit').value, 10) || 10,
    neighbors: document.getElementById('pg-neighbors').checked,
    q: state.search || undefined,
  };
  ask('paperGraph', { opts });
}
function topicColor(topic) {
  let h = 0; const s = String(topic || 'x');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return 'hsl(' + h + ',58%,55%)';
}
function currentPaperLayout() {
  const hier = document.getElementById('pg-layout').checked;
  if (hier) {
    const hasIncoming = new Set((currentGraphData?.edges || []).map(e => e.to));
    const roots = (currentGraphData?.nodes || []).map(n => n.key).filter(k => !hasIncoming.has(k));
    return { name: 'breadthfirst', directed: true, spacingFactor: 1.1, padding: 24, roots: roots.length ? roots : undefined };
  }
  return { name: 'cose', animate: false, padding: 24, nodeRepulsion: 9000, idealEdgeLength: 95, edgeElasticity: 120, nestingFactor: 1.1 };
}
function applyPaperLayout() { if (cy) cy.layout(currentPaperLayout()).run(); }
function graphSignature(data) {
  if (!data || !data.nodes) return '';
  const ns = data.nodes.map(n => n.key).sort().join('|');
  const es = (data.edges || []).map(e => e.from + '>' + e.to).sort().join('|');
  return ns + '#' + es;
}
function destroyCy() { if (cy) { try { cy.destroy(); } catch (e) {} cy = null; } }
function destroyFg3d() {
  if (fg3d) { try { fg3d._destructor && fg3d._destructor(); } catch (e) {} fg3d = null; }
  if (_fg3dResize) { try { _fg3dResize.disconnect(); } catch (e) {} _fg3dResize = null; }
}
// Toggle between the 2D (Cytoscape) and 3D (three.js/WebGL) renderers.
function togglePaper3d() {
  paper3d = document.getElementById('pg-3d').checked;
  const hl = document.getElementById('pg-layout-lbl');
  if (hl) hl.style.opacity = paper3d ? '.4' : ''; // Hierarchical layout is 2D-only
  hideTooltip();
  currentGraphSig = ''; // force a full re-render with the other renderer
  if (currentGraphData) renderPaperGraph(currentGraphData);
}
function renderPaperGraph(data) {
  const el = document.getElementById('pg-canvas');
  document.getElementById('pg-count').textContent = data ? `${data.shown} of ${data.total} papers` : '';
  // Skip re-layout only when the SAME renderer already shows the SAME node set
  // (e.g. raising the Top-N limit added no new nodes).
  const sig = graphSignature(data);
  const liveSameRenderer = paper3d ? !!fg3d : !!cy;
  if (data && data.nodes && data.nodes.length && sig === currentGraphSig && liveSameRenderer) {
    currentGraphData = data;
    return;
  }
  currentGraphData = data;
  currentGraphSig = sig;
  if (!data || !data.nodes || !data.nodes.length) {
    destroyCy(); destroyFg3d();
    el.innerHTML = '<div class="empty" style="padding:24px">No papers match — add papers or widen the filter.</div>';
    return;
  }
  if (paper3d) { destroyCy(); render3dGraph(el, data); }
  else { destroyFg3d(); render2dGraph(el, data); }
}
function render2dGraph(el, data) {
  if (typeof cytoscape === 'undefined') { el.innerHTML = '<div class="empty" style="padding:24px">Graph library unavailable.</div>'; return; }
  el.innerHTML = '';
  const cssv = getComputedStyle(document.body);
  const txt = (cssv.getPropertyValue('--text') || '#ddd').trim();
  const edgeCol = (cssv.getPropertyValue('--muted') || '#888').trim();
  const maxCC = Math.max(1, ...data.nodes.map(n => n.citationCount || 0));
  const elements = [];
  const ideaKeys = new Set(data.nodes.filter(n => n.kind === 'idea').map(n => n.key));
  for (const n of data.nodes) {
    const isIdea = n.kind === 'idea';
    elements.push({ data: {
      id: n.key, label: n.title, display: (isIdea ? '💡 ' : '') + n.title, cc: n.citationCount || 0,
      year: n.year || '', topic: n.topic || '', color: isIdea ? '#f4b400' : topicColor(n.topic),
      kind: n.kind || 'paper', conclusions: (n.conclusions || []).join('\n'),
    } });
  }
  for (const e of data.edges) elements.push({ data: {
    id: 'e_' + e.from + '__' + e.to, source: e.from, target: e.to, note: e.note || '',
    ideaEdge: (ideaKeys.has(e.from) || ideaKeys.has(e.to)) ? 1 : 0,
  } });
  cy = cytoscape({
    container: el, elements, wheelSensitivity: 0.2,
    style: [
      { selector: 'node', style: {
        'label': 'data(display)', 'font-size': 9, 'text-wrap': 'wrap', 'text-max-width': 120,
        'text-valign': 'bottom', 'text-margin-y': 3, 'color': txt, 'background-color': 'data(color)',
        'width': 'mapData(cc,0,' + maxCC + ',18,66)', 'height': 'mapData(cc,0,' + maxCC + ',18,66)',
        'border-width': 1, 'border-color': '#0008',
      } },
      { selector: 'node[kind = "idea"]', style: {
        'shape': 'round-rectangle', 'background-color': '#f4b400', 'background-opacity': 0.95,
        'border-color': '#8a5a00', 'border-width': 2.5, 'border-style': 'dashed',
        'width': 44, 'height': 34,
        'color': txt, 'font-weight': 'bold', 'font-size': 9,
        'text-valign': 'bottom', 'text-halign': 'center', 'text-margin-y': 4,
        'text-wrap': 'wrap', 'text-max-width': 150,
      } },
      { selector: 'edge', style: {
        'width': 1.4, 'line-color': edgeCol, 'target-arrow-color': edgeCol,
        'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.9,
      } },
      { selector: 'edge[ideaEdge = 1]', style: { 'line-style': 'dashed', 'line-color': '#c8941a', 'target-arrow-color': '#c8941a', 'width': 2 } },
      { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#ffd166' } },
    ],
    layout: currentPaperLayout(),
  });
  cy.on('mouseover', 'node', evt => showNodeTooltip(evt.target));
  cy.on('mouseout', 'node', hideTooltip);
  cy.on('tap', 'node', evt => openItem('paper', evt.target.id()));
  // Click empty canvas background -> conceal the conclusions tooltip.
  cy.on('tap', evt => { if (evt.target === cy) hideTooltip(); });
  if (document.getElementById('pg-allconc').checked) toggleAllConclusions();
}
function render3dGraph(el, data) {
  if (typeof ForceGraph3D === 'undefined') { el.innerHTML = '<div class="empty" style="padding:24px">3D graph library unavailable.</div>'; return; }
  el.innerHTML = '';
  const cssv = getComputedStyle(document.body);
  const bg = (cssv.getPropertyValue('--bg') || '#1e1e1e').trim();
  const edgeCol = (cssv.getPropertyValue('--muted') || '#888').trim();
  const ideaKeys = new Set(data.nodes.filter(n => n.kind === 'idea').map(n => n.key));
  const nodes = data.nodes.map(n => ({
    id: n.key, name: n.title, cc: n.citationCount || 0, year: n.year || '',
    topic: n.topic || '', kind: n.kind || 'paper',
    color: n.kind === 'idea' ? '#f4b400' : topicColor(n.topic),
    conclusions: (n.conclusions || []).join('\n'),
  }));
  const links = data.edges.map(e => ({ source: e.from, target: e.to, ideaEdge: (ideaKeys.has(e.from) || ideaKeys.has(e.to)) ? 1 : 0 }));
  const rect = el.getBoundingClientRect();
  fg3d = ForceGraph3D()(el)
    .backgroundColor(bg)
    .width(rect.width || 600).height(rect.height || 400)
    .graphData({ nodes, links })
    .nodeRelSize(4)
    .nodeVal(n => n.kind === 'idea' ? 6 : 2 + (n.cc || 0))
    .nodeColor(n => n.color)
    .nodeOpacity(0.92)
    .nodeLabel(n => {
      const c = (n.conclusions || '').split('\n').filter(Boolean);
      return '<div style="max-width:240px;padding:6px 8px;background:#000a;border:1px solid #444;border-radius:6px;color:#eee;font-size:11px">' +
        '<b>' + esc(n.name) + '</b><br><span style="color:#aaa">' + esc(n.topic) +
        (n.year ? ' · ' + n.year : '') + ' · ' + n.cc + ' cite(s)</span>' +
        (c.length ? '<ul style="margin:4px 0 0 14px;padding:0">' + c.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') + '</div>';
    })
    .linkColor(l => l.ideaEdge ? '#c8941a' : edgeCol)
    .linkOpacity(0.55)
    .linkWidth(l => l.ideaEdge ? 1.2 : 0.6)
    .linkDirectionalArrowLength(3.5).linkDirectionalArrowRelPos(1)
    .onNodeClick(n => openItem('paper', n.id));
  // Keep the WebGL canvas sized to its container.
  if (typeof ResizeObserver !== 'undefined') {
    _fg3dResize = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (fg3d && r.width && r.height) { fg3d.width(r.width); fg3d.height(r.height); }
    });
    _fg3dResize.observe(el);
  }
}
function showNodeTooltip(node) {
  const tt = document.getElementById('pg-tooltip');
  const concl = (node.data('conclusions') || '').split('\n').filter(Boolean);
  tt.innerHTML = '<div class="tt-title">' + esc(node.data('label')) + '</div>' +
    '<div style="color:var(--muted);font-size:10px">' + esc(node.data('topic')) +
    (node.data('year') ? ' · ' + node.data('year') : '') + ' · ' + node.data('cc') + ' citations</div>' +
    (concl.length ? '<ul>' + concl.map(c => '<li>' + esc(c) + '</li>').join('') + '</ul>' : '<div style="color:var(--muted)">(no conclusions)</div>');
  const canvas = document.getElementById('pg-canvas').getBoundingClientRect();
  tt.style.left = (canvas.left + node.renderedPosition('x') + 14) + 'px';
  tt.style.top = (canvas.top + node.renderedPosition('y') + 14) + 'px';
  tt.classList.remove('hidden');
}
function hideTooltip() { document.getElementById('pg-tooltip').classList.add('hidden'); }
function toggleAllConclusions() {
  if (!cy) return;
  const all = document.getElementById('pg-allconc').checked;
  cy.batch(() => {
    cy.nodes().forEach(n => {
      if (all) {
        const c = (n.data('conclusions') || '').split('\n').filter(Boolean);
        n.data('display', n.data('label') + (c.length ? '\n— ' + c.join('\n— ') : ''));
      } else n.data('display', n.data('label'));
    });
  });
}

