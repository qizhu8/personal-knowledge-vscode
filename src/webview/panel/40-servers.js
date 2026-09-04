// ── Servers dashboard ────────────────────────────────────────────────────────
let serverCache = [];
let serverGroupPaths = ['Hidden'];
let serverSubscriptionGroups = [];
let serverSubscriptionExpanded = '';
let serverSubscriptionMonitor = null;
let _srvPoll = null;
let serverSearchQuery = '';
function serverGroupTree(entries) {
  const root = { groups: new Map(), entries: [] };
  entries.forEach(entry => {
    let node = root;
    String(entry.server.category || '').split('/').map(part => part.trim()).filter(Boolean).forEach(part => {
      if (!node.groups.has(part)) node.groups.set(part, { groups: new Map(), entries: [] });
      node = node.groups.get(part);
    });
    node.entries.push(entry);
  });
  serverGroupPaths.forEach(category => {
    let node = root;
    String(category || '').split('/').map(part => part.trim()).filter(Boolean).forEach(part => {
      if (!node.groups.has(part)) node.groups.set(part, { groups: new Map(), entries: [] });
      node = node.groups.get(part);
    });
  });
  if (!root.groups.has('Hidden')) root.groups.set('Hidden', { groups: new Map(), entries: [] });
  return root;
}
function serverGroupOpen(path) {
  try { return localStorage.getItem('pkm-server-group-' + path) === '1'; } catch { return false; }
}
function serverGroupToggled(details, path) {
  if (serverSearchQuery) return;
  try { localStorage.setItem('pkm-server-group-' + path, details.open ? '1' : '0'); } catch {}
}
function toggleSubscribedServerBroker(subscriptionId) {
  serverSubscriptionExpanded = serverSubscriptionExpanded === subscriptionId ? '' : subscriptionId;
  stopSubscribedServerMonitoring();
  if (serverSubscriptionExpanded) {
    ask('serverSubscriptionStatus', { subscriptionId: serverSubscriptionExpanded });
    // Long-running monitoring stays well above the 10-second minimum period.
    serverSubscriptionMonitor = setInterval(() => {
      if (state.tab === 'servers' && serverSubscriptionExpanded) ask('serverSubscriptionStatus', { subscriptionId: serverSubscriptionExpanded });
    }, 60_000);
  }
  renderServerDashboard(serverCache);
}
function stopSubscribedServerMonitoring() {
  if (serverSubscriptionMonitor) clearInterval(serverSubscriptionMonitor);
  serverSubscriptionMonitor = null;
}
function renderSubscribedServerGroups() {
  if (!serverSubscriptionGroups.length) return '';
  return `<div class="srv-subscribed"><h3>Subscribed Server Links</h3><div class="pk-list">${serverSubscriptionGroups.map(group => {
    const expanded = serverSubscriptionExpanded === group.subscriptionId;
    return `<article class="pk-card srv-subscriber-card ${expanded ? 'active' : ''}"><div class="srv-subscriber-head" role="button" tabindex="0" aria-expanded="${expanded}" onclick="toggleSubscribedServerBroker('${esc(group.subscriptionId)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleSubscribedServerBroker('${esc(group.subscriptionId)}')}"><span><strong>${esc(group.alias)}</strong><small>${group.items.length} Servers · revision ${Number(group.revision)||0}</small></span><i>›</i></div>${expanded ? `<div class="srv-subscriber-detail"><div class="srv-subscriber-actions"><button class="pk-button" data-pending-label="Checking…" onclick="ask('serverSubscriptionStatus',{subscriptionId:'${esc(group.subscriptionId)}'},this)">Refresh Status</button></div><div class="srv-subscriber-table-wrap"><table class="pk-table srv-subscriber-table"><thead><tr><th>Server</th><th>Link</th><th>Status</th><th>Action</th></tr></thead><tbody>${group.items.map(item => { const status = item.status === 'running' ? ['running','Running'] : item.status === 'unavailable' ? ['unavailable','Unavailable'] : ['not-checked','Not checked']; return `<tr><td><strong>${esc(item.title)}</strong></td><td><code title="${esc(item.link || '')}">${esc(item.link || 'Unavailable')}</code></td><td><span class="srv-sub-status ${status[0]}"><i></i>${status[1]}</span></td><td><button class="pk-button" data-pending-label="Opening…" onclick="ask('subscriptionOpenServerLink',{key:'${esc(item.key)}',index:0},this)" ${item.link ? '' : 'disabled'}>Open</button></td></tr>`; }).join('')}</tbody></table></div></div>` : ''}</article>`;
  }).join('')}</div></div>`;
}
function serverDragStart(event, slug) {
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/pkm-server-slug', slug);
  event.currentTarget.classList.add('srv-dragging');
}
function serverDragEnd(event) {
  event.currentTarget.closest('.srv-card')?.classList.remove('srv-dragging');
  document.querySelectorAll('.srv-drop-active').forEach(element => element.classList.remove('srv-drop-active'));
}
function serverGroupDragOver(event) {
  if (!event.dataTransfer.types.includes('text/pkm-server-slug')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.classList.add('srv-drop-active');
}
function serverGroupDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove('srv-drop-active');
}
function serverGroupDrop(event, category) {
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.classList.remove('srv-drop-active');
  const slug = event.dataTransfer.getData('text/pkm-server-slug');
  const server = serverCache.find(item => item.slug === slug);
  if (server && String(server.category || '') !== category) ask('serverUpdate', { slug, patch: { category } });
}
function moveServerToGroup(slug, category) {
  const server = serverCache.find(item => item.slug === slug);
  if (server && String(server.category || '') !== category) ask('serverUpdate', { slug, patch: { category } });
}
function createAndMoveServerGroup(slug) {
  pkModal({ title: 'New Server subgroup', message: 'Enter a slash-separated subgroup path. The Server will be moved there after creation.', input: true, okLabel: 'Create & move', onOk: value => {
    const category = value.trim();
    if (category) ask('serverCreateGroup', { category, moveSlug: slug });
  } });
}
function serverCardMenu(event, slug) {
  event.preventDefault(); event.stopPropagation();
  const server = serverCache.find(item => item.slug === slug); if (!server) return;
  const groups = [...new Set(['', ...serverGroupPaths])];
  const children = groups.map(group => ({ label: `${String(server.category || '') === group ? '●' : '  '} ${group || 'Ungrouped'}`, active: String(server.category || '') === group, onClick: () => moveServerToGroup(slug, group) }));
  children.push({ sep: true });
  children.push({ label: '＋ New subgroup…', onClick: () => createAndMoveServerGroup(slug) });
  showPaperMenu(event.clientX, event.clientY, [{ label: 'Move to group', children }]);
}
function renameServerGroup(path) {
  const parts = path.split('/');
  const currentName = parts.pop() || '';
  const parent = parts.join('/');
  pkModal({ title: 'Rename subgroup', input: true, defaultValue: currentName, okLabel: 'Rename', onOk: value => {
    const name = value.trim().replace(/[\\/]+/g, ' ');
    if (name && name !== currentName) ask('serverMoveGroup', { oldPrefix: path, newPrefix: [parent, name].filter(Boolean).join('/') });
  } });
}
function deleteServerGroup(path) {
  const parts = path.split('/');
  const name = parts.pop() || path;
  const parent = parts.join('/');
  pkModal({ title: 'Delete subgroup “' + name + '”?', message: 'Servers and nested subgroups will move to ' + (parent ? '“' + parent + '”' : 'Ungrouped') + '. No servers or files will be deleted.', okLabel: 'Delete subgroup', danger: true, onOk: () => ask('serverMoveGroup', { oldPrefix: path, newPrefix: parent }) });
}
function renderServerGroupNode(node, parentPath = '') {
  const cards = node.entries.slice().sort((left, right) => Number(!!right.server.pinned) - Number(!!left.server.pinned)
    || left.server.name.localeCompare(right.server.name)).map(entry => entry.html).join('');
  const groups = [...node.groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, child]) => {
    const path = parentPath ? `${parentPath}/${name}` : name;
    const count = serverGroupCount(child);
    const hidden = path === 'Hidden';
    return `<details class="srv-group${hidden ? ' srv-hidden-group' : ''}" data-group-path="${encodeURIComponent(path)}" ${serverGroupOpen(path) ? 'open' : ''} ontoggle="serverGroupToggled(this,decodeURIComponent('${encodeURIComponent(path)}'))" ondragover="serverGroupDragOver(event)" ondragleave="serverGroupDragLeave(event)" ondrop="serverGroupDrop(event,decodeURIComponent('${encodeURIComponent(path)}'))"><summary><span>${hidden ? '🙈' : '📁'} ${esc(name)}</span>${hidden ? '<span class="srv-hidden-hint">excluded from Navigation</span>' : ''}<span class="srv-group-count">${count}</span>${hidden ? '' : `<span class="srv-group-actions"><button class="srv-group-action" onclick="event.preventDefault();event.stopPropagation();renameServerGroup(decodeURIComponent('${encodeURIComponent(path)}'))" title="Rename subgroup" aria-label="Rename ${esc(name)} subgroup">✎</button><button class="srv-group-action srv-group-delete" onclick="event.preventDefault();event.stopPropagation();deleteServerGroup(decodeURIComponent('${encodeURIComponent(path)}'))" title="Delete subgroup without deleting servers" aria-label="Delete ${esc(name)} subgroup">×</button></span>`}</summary><div class="srv-group-body">${renderServerGroupNode(child, path)}</div></details>`;
  }).join('');
  return cards + groups;
}
function serverGroupCount(node) {
  return node.entries.length + [...node.groups.values()].reduce((count, child) => count + serverGroupCount(child), 0);
}
function filterServerDashboard(value) {
  serverSearchQuery = String(value || '').trim().toLowerCase();
  const terms = serverSearchQuery.split(/\s+/).filter(Boolean);
  document.querySelectorAll('.srv-card[data-server-search]').forEach(card => {
    const haystack = decodeURIComponent(card.dataset.serverSearch || '');
    card.classList.toggle('srv-search-hidden', !!terms.length && !terms.every(term => haystack.includes(term)));
  });
  const groups = Array.from(document.querySelectorAll('.srv-group')).reverse();
  groups.forEach(group => {
    const body = group.querySelector(':scope > .srv-group-body');
    const visible = !!body?.querySelector(':scope > .srv-card:not(.srv-search-hidden), :scope > .srv-group:not(.srv-search-hidden)');
    group.classList.toggle('srv-search-hidden', !!serverSearchQuery && !visible);
    if (serverSearchQuery && visible) group.open = true;
    else if (!serverSearchQuery) group.open = serverGroupOpen(decodeURIComponent(group.dataset.groupPath || ''));
  });
}
function renderServerDashboard(servers) {
  const searchInput = document.getElementById('server-search');
  const restoreSearchFocus = document.activeElement === searchInput;
  const restoreSearchCaret = searchInput?.selectionStart ?? serverSearchQuery.length;
  serverCache = servers || [];
  const dot = s => s === 'running' ? '#3fb950' : s === 'external' ? '#4daafc' : s === 'starting' ? '#e5c07b' : '#8b949e';
  const networkLinks = serverCache[0]?.networkLinks || [];
  let savedNetwork = ''; try { savedNetwork = localStorage.getItem('pkm-server-network') || ''; } catch {}
  const selectedNetwork = networkLinks.find(link => link.address === savedNetwork) || networkLinks[0];
  const networkOptions = networkLinks.map(link => `<option value="${esc(link.address)}" ${link.address === selectedNetwork?.address ? 'selected' : ''}>${link.kind === 'hostname' ? esc(t('servers.hostname')) : esc(link.interface)} · ${esc(link.address)}</option>`).join('');
  const autoForward = serverCache[0]?.autoForward ?? true;
  const remoteName = serverCache.find(server => server.remoteName)?.remoteName || '';
  const suggestedPort = serverCache[0]?.suggestedPort || 8000;
  const portChips = serverCache.slice().sort((left, right) => left.port - right.port).map(server => `<span class="srv-port-chip${server.status === 'external' ? ' external' : ''}" title="${esc(server.name)}${server.status === 'external' ? ' · external listener detected' : ''}"><b>${server.port}</b> ${esc(server.name)}</span>`).join('');
  const cardEntries = serverCache.map(s => {
    const links = s.networkLinks || [];
    const selected = links.find(link => link.address === selectedNetwork?.address) || links[0];
    const stableLink = selected?.url || '';
    const searchText = [s.name, s.slug, s.category, ...(s.tags || []), s.command, s.python || 'python3', s.status].join(' ').toLowerCase();
    return { server: s, html: `
    <div class="srv-card" oncontextmenu="serverCardMenu(event,'${esc(s.slug)}')" title="Right-click for group actions" data-server-search="${encodeURIComponent(searchText)}">
      <div class="ec-row">
        <span class="srv-drag-handle" draggable="true" ondragstart="serverDragStart(event,'${esc(s.slug)}');this.closest('.srv-card').classList.add('srv-dragging')" ondragend="serverDragEnd(event)" title="Drag this Server to another group" aria-label="Drag ${esc(s.name)} to another group">⋮⋮</span>
        <span class="srv-dot" style="background:${dot(s.status)}"></span>
        <button class="srv-star ${s.pinned ? 'active' : ''}" onclick="serverPinChanged('${esc(s.slug)}',${s.pinned ? 'false' : 'true'})" title="${s.pinned ? 'Unstar this server' : 'Star and pin this server to the top of its group'}" aria-label="${s.pinned ? 'Unstar' : 'Star'} ${esc(s.name)}">${s.pinned ? '★' : '☆'}</button>
        <b>${esc(s.name)}</b><span class="cat">${esc(s.slug)}</span>
        ${s.category ? `<span class="srv-category">${esc(s.category)}</span>` : ''}
        ${(s.tags || []).map(tag => `<span class="srv-tag">${esc(tag)}</span>`).join('')}
        <span style="font-size:11px;color:var(--muted)">:${s.activePort} · ${esc(s.status)}${s.pid ? ' · pid ' + s.pid : ''}</span>
        <span style="flex:1"></span>
      </div>
      <div class="srv-actions" role="toolbar" aria-label="Actions for ${esc(s.name)}">
        <span class="srv-lifecycle-actions">${s.status === 'stopped'
          ? `<button class="tbtn" onclick="ask('serverStart',{slug:'${esc(s.slug)}'})" title="Start ${esc(s.name)} with its configured command and port">▶ Start</button>`
          : s.status === 'external'
            ? `<span class="srv-external" title="A listener exists on this port but was not started by PKM.">◉ External listener detected · ${(s.externalProcesses || []).map(process => `PID ${process.pid} · ${esc(process.name)}`).join(', ') || 'PID unavailable'}</span><button class="tbtn srv-force-stop" onclick="forceStopExternalServerUi('${esc(s.slug)}')" ${(s.externalProcesses || []).length ? '' : 'disabled'} title="Force-terminate the process listening on port ${s.port}">■ Force Stop</button>`
            : `<button class="tbtn" onclick="ask('serverStop',{slug:'${esc(s.slug)}'})" title="Stop the detached ${esc(s.name)} process">■ Stop</button><button class="tbtn" onclick="ask('serverRestart',{slug:'${esc(s.slug)}'})" title="Restart ${esc(s.name)} with its saved settings">↻ Restart</button>`}</span>
        <span class="srv-management-actions"><button class="tbtn" onclick="ask('serverOpenFolder',{slug:'${esc(s.slug)}'})" title="Open the server folder (code + any data it writes)">📂 Folder</button>
        <button class="tbtn" onclick="editServer('${esc(s.slug)}')" title="Edit server settings: command, port, and Python">⚙ Settings</button>
        <button class="tbtn" onclick="serverLogView('${esc(s.slug)}')" title="Open the latest managed process log">📜 Log</button>
        <button class="tbtn srv-danger" onclick="deleteServer('${esc(s.slug)}',${JSON.stringify(s.name).replace(/"/g,'&quot;')})" title="Permanently delete this managed server folder and settings">🗑 Delete</button></span>
      </div>
      <div class="ec-path"><code>${esc(s.command)}</code> · env: ${esc(s.python || 'python3')}</div>
      <div class="srv-link-block srv-stable-link">
        <div class="srv-link-head"><strong>Stable Link</strong></div>
        <div class="srv-link-main">
          <button class="srv-url-link" id="srv-network-link-${esc(s.slug)}" onclick="openServerLink('${esc(s.slug)}','network')" title="Open ${esc(stableLink || 'Unavailable')}" ${stableLink ? '' : 'disabled'}>${esc(stableLink || 'Unavailable')}</button>
          <span class="srv-link-actions"><button class="tbtn" onclick="openServerLink('${esc(s.slug)}','network')" title="Open Stable Link with the selected IP" ${stableLink ? '' : 'disabled'}>Open</button><button class="tbtn" onclick="copyServerLink('${esc(s.slug)}','network')" title="Copy Stable Link" ${stableLink ? '' : 'disabled'}>Copy</button></span>
        </div>
      </div>
      <details class="srv-link-block srv-local-link">
        <summary title="Show the localhost Server Link and forwarding controls">Server Local Link <span class="srv-summary-link" role="link" tabindex="0" onclick="event.stopPropagation();openServerLink('${esc(s.slug)}','local')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();openServerLink('${esc(s.slug)}','local')}">${esc(s.localUrl)}</span></summary>
        <div class="srv-link-main">
          <button class="srv-url-link" onclick="openServerLink('${esc(s.slug)}','local')" title="Open ${esc(s.localUrl)}">${esc(s.localUrl)}</button>
          <span class="srv-link-actions"><button class="tbtn" onclick="openServerLink('${esc(s.slug)}','local')" title="Open localhost Server Link; Remote SSH requires Port Forward">Open</button><button class="tbtn" onclick="copyServerLink('${esc(s.slug)}','local')" title="Copy localhost Server Link">Copy</button></span>
        </div>
      </details>
      <div class="srv-card-output" id="srv-out-${esc(s.slug)}"></div>
    </div>` };
  });
  const cards = renderServerGroupNode(serverGroupTree(cardEntries));
  const subscribedServers = renderSubscribedServerGroups();
  document.getElementById('detail').innerHTML = `
    <div class="dash">
      <div class="dash-hd">
        <span class="dash-title">🖥 Servers</span>
        <input id="server-search" oninput="filterServerDashboard(this.value)" placeholder="Search…" data-i18n-placeholder="search.placeholder" aria-label="Search servers" title="Search name, slug, group, tags, command, Python, and status">
        <span style="flex:1"></span>
        <button class="tbtn srv-new-group" onclick="createServerGroup()" title="Create an empty subgroup, then drag or right-click a Server to move it">＋ New subgroup</button>
        <button class="tbtn" onclick="importServer()" title="Move an existing server folder into the PKM store">＋ Import folder</button>
        <button class="tbtn" onclick="createServer()" title="Create a new managed server package">＋ New</button>
        <button class="tbtn" onclick="ask('serverList',{})" title="Force-refresh server process, port, and link status">↻ Refresh</button>
      </div>
      <div class="srv-global-controls">
        <label><span data-i18n="servers.networkInterface">Stable Link interface</span><select onchange="serverNetworkChanged(this.value)" title="Select a hostname or network interface/IP for every Stable Link" ${networkLinks.length ? '' : 'disabled'}>${networkOptions || '<option data-i18n="servers.noNetwork">No hostname or network IPv4 found</option>'}</select></label>
        <button class="tbtn srv-forward-toggle ${autoForward ? 'active' : ''}" aria-pressed="${autoForward}" onclick="serverForwardChanged(!${autoForward})" title="Request VS Code Remote-SSH port forwarding for all Server Local Links. Enabled by default." ${remoteName ? '' : 'disabled'}><span data-i18n="servers.portForward">↔ Port Forward</span>: <span data-i18n="${autoForward ? 'servers.on' : 'servers.off'}">${autoForward ? 'On' : 'Off'}</span></button>
        ${remoteName ? `<span class="srv-global-remote">Remote: ${esc(remoteName)}</span>` : '<span class="srv-global-remote">Local window · forwarding not required</span>'}
      </div>
      <div class="srv-port-registry"><strong>Managed ports</strong><span class="srv-port-list">${portChips || '<span class="empty">No ports reserved</span>'}</span><span class="srv-next-port">Next free: <b>${suggestedPort}</b></span></div>
      <div class="srv-root-drop" ondragover="serverGroupDragOver(event)" ondragleave="serverGroupDragLeave(event)" ondrop="serverGroupDrop(event,'')" title="Drag a server here to remove it from its group">Ungrouped</div>
      ${cards || '<div class="empty">No servers yet — import a folder (moves it into the store) or create a new one.</div>'}
      ${subscribedServers}
    </div>`;
  const nextSearchInput = document.getElementById('server-search');
  if (nextSearchInput) {
    nextSearchInput.value = serverSearchQuery;
    if (restoreSearchFocus) {
      nextSearchInput.focus();
      nextSearchInput.setSelectionRange(Math.min(restoreSearchCaret, serverSearchQuery.length), Math.min(restoreSearchCaret, serverSearchQuery.length));
    }
  }
  filterServerDashboard(serverSearchQuery);
  ask('envList', {}); // cache envs for the edit form's interpreter picker
  // This is a short-lived, user-visible active search while a local Server starts,
  // not a long-running background refresh. It stops as soon as status settles.
  if (_srvPoll) { clearTimeout(_srvPoll); _srvPoll = null; }
  if (serverCache.some(s => s.status === 'starting')) {
    _srvPoll = setTimeout(() => { if (state.tab === 'servers') ask('serverList', {}); }, 5000);
  }
}
function openServer(url) { ask('serverOpenUrl', { url }); }
function selectedServerLink(slug, kind) {
  const server = serverCache.find(item => item.slug === slug); if (!server) return '';
  if (kind === 'local') return server.localUrl || '';
  let saved = ''; try { saved = localStorage.getItem('pkm-server-network') || ''; } catch {}
  return (server.networkLinks || []).find(link => link.address === saved)?.url || server.networkLinks?.[0]?.url || '';
}
function serverNetworkChanged(address) {
  try { localStorage.setItem('pkm-server-network', address); } catch {}
  renderServerDashboard(serverCache);
}
function openServerLink(slug, kind) {
  const server = serverCache.find(item => item.slug === slug);
  const url = selectedServerLink(slug, kind);
  if (server && url) ask('serverOpenUrl', { url, requiresForward: kind === 'local', forwardEnabled: !!server.autoForward });
}
function copyServerLink(slug, kind) { const url = selectedServerLink(slug, kind); if (url) ask('serverCopy', { text: url }); }
function serverForwardChanged(enabled) { ask('serverSetForward', { enabled }); }
function serverPinChanged(slug, pinned) { ask('serverSetPinned', { slug, pinned }); }
function forceStopExternalServerUi(slug) {
  const server = serverCache.find(item => item.slug === slug); if (!server) return;
  const processes = server.externalProcesses || [];
  if (!processes.length) return;
  const details = processes.map(process => `PID ${process.pid} · ${process.command}`).join('\n');
  pkModal({ title: 'Force Stop external listener?', message: `This process was not started by PKM. Force Stop will terminate it and may interrupt other work.\n\nServer: ${server.name}\nPort: ${server.port}\n${details}`, okLabel: 'Force Stop', danger: true, onOk: () => ask('serverForceStopExternal', { slug, expectedPids: processes.map(process => process.pid) }) });
}
function importServer() { ask('serverPickFolder', {}); }
function onServerPickFolder(dir) {
  if (!dir) return;
  const base = dir.split('/').pop();
  pkModal({ title: 'Import server', message: 'Moves “' + dir + '” into the store as a managed server.', input: true, defaultValue: base, okLabel: 'Import',
    onOk: v => ask('serverImport', { sourceDir: dir, name: v.trim() || base }) });
}
function createServer() { pkModal({ title: 'New server', input: true, okLabel: 'Create', onOk: v => { if (v.trim()) ask('serverCreate', { name: v.trim() }); } }); }
function createServerGroup() { pkModal({ title: 'New Server subgroup', message: 'Enter a slash-separated path to create multiple levels. Then drag a Server by its ⋮⋮ handle or right-click it to move.', input: true, okLabel: 'Create subgroup', onOk: value => { if (value.trim()) ask('serverCreateGroup', { category: value.trim() }); } }); }
function serverOutput(slug) { return document.getElementById('srv-out-' + slug); }
function closeServerOutput(slug) { const out = serverOutput(slug); if (out) out.innerHTML = ''; }
function editServer(slug) {
  const s = serverCache.find(x => x.slug === slug); if (!s) return;
  const envOpts = envCache.map(e => `<option value="${esc(e.python)}">${esc(e.name)} (${esc(e.python)})</option>`).join('');
  const out = serverOutput(slug); if (!out) return;
  out.innerHTML = `<div class="srv-edit">
      <div class="ec-row"><b>Server Settings · ${esc(s.name)}</b><span style="flex:1"></span><button class="tbtn" onclick="closeServerOutput('${esc(slug)}')" title="Cancel editing and close this panel">Close</button></div>
      <label>Display name <input id="se-name-${esc(slug)}" value="${esc(s.name)}" title="Rename the displayed server name; folder slug and links stay unchanged"></label>
      <label><span data-i18n="servers.group">Group</span><input id="se-category-${esc(slug)}" value="${esc(s.category || '')}" placeholder="e.g. Research/Vision" title="Slash-separated group path; leave blank for the root group"></label>
      <label><span data-i18n="servers.tags">Tags</span><input id="se-tags-${esc(slug)}" value="${esc((s.tags || []).join(', '))}" placeholder="e.g. gpu, visualization" title="Comma-separated searchable tags"></label>
      <label>Command <input id="se-cmd-${esc(slug)}" value="${esc(s.command)}"></label>
      <label>Port <span class="srv-port-edit"><input id="se-port-${esc(slug)}" type="number" min="1" max="65535" value="${s.port}"><button class="tbtn" onclick="useSuggestedServerPort('${esc(slug)}',${s.suggestedPort || 8000})" title="Use the next port not reserved by another managed Server">Use next free · ${s.suggestedPort || 8000}</button></span></label>
      <label>Python interpreter (blank = python3)
        <input id="se-py-${esc(slug)}" list="se-envs-${esc(slug)}" value="${esc(s.python || '')}" placeholder="python3 or /path/to/env/bin/python">
        <datalist id="se-envs-${esc(slug)}">${envOpts}</datalist></label>
      <div><button class="tbtn" onclick="saveServer('${esc(s.slug)}')" title="Save settings and restart a running server">Save & restart</button>
        <button class="tbtn" onclick="closeServerOutput('${esc(slug)}')" title="Discard unsaved settings and close">Cancel</button></div>
    </div>`;
}
function useSuggestedServerPort(slug, port) {
  const input = document.getElementById('se-port-' + slug);
  if (input) { input.value = String(port); input.focus(); }
}
function saveServer(slug) {
  const patch = {
    name: document.getElementById('se-name-' + slug).value,
    category: document.getElementById('se-category-' + slug).value,
    tags: document.getElementById('se-tags-' + slug).value.split(',').map(tag => tag.trim()).filter(Boolean),
    command: document.getElementById('se-cmd-' + slug).value,
    port: +document.getElementById('se-port-' + slug).value,
    python: document.getElementById('se-py-' + slug).value,
  };
  ask('serverUpdate', { slug, patch });
  closeServerOutput(slug);
}
function serverLogView(slug) {
  const out = serverOutput(slug); if (!out) return;
  out.innerHTML = `<div class="ec-row srv-output-head"><div class="empty">Loading log…</div><span style="flex:1"></span><button class="tbtn" onclick="closeServerOutput('${esc(slug)}')" title="Close log panel">Close</button></div>`;
  ask('serverLog', { slug });
}
function onServerLog(slug, text) {
  const out = serverOutput(slug); if (!out) return;
  out.innerHTML = '<div class="ec-row srv-output-head"><b>Log · ' + esc(slug) + '</b><span style="flex:1"></span><button class="tbtn" style="font-size:11px" onclick="serverLogView(\'' + esc(slug) + '\')" title="Refresh this log output">↻ Refresh</button><button class="tbtn" style="font-size:11px" onclick="closeServerOutput(\'' + esc(slug) + '\')" title="Close log panel">Close</button></div>' +
    '<pre class="srv-log">' + esc(text) + '</pre>';
}
function deleteServer(slug, name) {
  pkModal({ title: 'Delete server “' + name + '”?', message: 'Removes “' + slug + '” and its code from the store.', okLabel: 'Delete', danger: true, onOk: () => ask('serverDelete', { slug }) });
}

