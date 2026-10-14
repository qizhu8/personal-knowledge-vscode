// ── GitHub Sync ───────────────────────────────────────────────────────────
let githubSyncData = { targets:[], catalog:{}, shields:{}, folderShields:{}, fileShields:{}, runtime:{}, migrations:{}, connected:{}, authenticationOptions:{ accounts:[], identities:[] } };
let githubSyncEditing = '';
let githubSyncEditorTab = 'general';
let githubSyncSaving = false;
let githubSyncAuthenticationResult = null;
let githubSyncUpdatedAt = 0;
let githubSyncStatusRequested = false;
let githubSyncRefreshError = '';
const githubSyncDrafts = new Map();
const githubSyncForcePending = new Set();
const githubSyncAutomationPending = new Map();
const githubSyncPendingAfter = new Map();
const githubSyncResolvedExpanded = new Set();
const githubSyncTypes = ['skills','notes','papers','prompts','scripts','packages','servers','recipes','agentSnapshots'];
const githubSyncLabels = { skills:'Skills', notes:'Notes', papers:'Research', prompts:'Prompts', scripts:'Scripts', packages:'Packages', servers:'Servers', recipes:'Recipes', agentSnapshots:'Agent Snapshots' };

function renderGitHubSyncLoading() {
  renderGitHubSyncPane();
}

function showGitHubSyncTab() {
  if (githubSyncUpdatedAt) renderGitHubSyncPane(); else renderGitHubSyncLoading();
  ask('githubSyncRuntimeSnapshot', {}, null, true);
  ensureGitHubSyncStatus();
}

function githubSyncDefaultSelection() {
  const publicScope = {};
  const privateScope = {};
  for (const type of githubSyncTypes) {
    publicScope[type] = { items:[], folders:['packages','servers','agentSnapshots'].includes(type) ? [] : [''] };
    privateScope[type] = { items:[], folders:[] };
  }
  return { public:publicScope, private:privateScope };
}

function githubSyncRuntimeIsOlder(previous, current) {
  if (!previous) return false;
  const version = runtime => Math.max(...['activityAt', 'lastAttemptAt', 'lastSuccessAt']
    .map(key => Date.parse(runtime[key] || '') || 0));
  return version(previous) > version(current);
}

function githubSyncOnState(data) {
  githubSyncStatusRequested = !!data?.fingerprintsDeferred;
  githubSyncRefreshError = '';
  if (githubSyncEditing) githubSyncCaptureDraft();
  const previousRuntime = githubSyncData.runtime || {};
  githubSyncData = { ...githubSyncData, ...(data || {}) };
  githubSyncData.runtime = { ...previousRuntime, ...(data?.runtime || {}) };
  for (const [targetId, runtime] of Object.entries(githubSyncData.runtime || {})) {
    const previous = previousRuntime[targetId];
    if (githubSyncRuntimeIsOlder(previous, runtime)) {
      githubSyncData.runtime[targetId] = previous;
      continue;
    }
    if (githubSyncForcePending.has(targetId) && githubSyncPendingAfter.has(targetId)
      && runtime.lastAttemptAt && runtime.lastAttemptAt !== githubSyncPendingAfter.get(targetId)
      && ['syncing', 'queued', 'error', 'conflicts', 'needs-attention'].includes(runtime.status)) {
      githubSyncForcePending.delete(targetId);
      githubSyncPendingAfter.delete(targetId);
    }
  }
  githubSyncUpdatedAt = Date.now();
  if (githubSyncSaving) {
    githubSyncDrafts.delete(githubSyncEditing);
    githubSyncEditing = '';
    githubSyncSaving = false;
  }
  if (githubSyncEditing && githubSyncEditing !== 'new' && !githubSyncData.targets.some(target => target.id === githubSyncEditing)) githubSyncEditing = '';
  updateGitHubSyncShields();
  updateGitHubSyncFolderShields();
  updateGitHubSyncFileShields();
  if (state.tab === 'githubSync') renderGitHubSyncPane();
}

function updateGitHubSyncShields() {
  for (const type of githubSyncTypes) {
    const tab = document.querySelector(`.tab[data-tab="${type}"]`);
    if (!tab) continue;
    let shield = tab.querySelector('.github-sync-shield');
    if (!shield) {
      shield = document.createElement('span');
      shield.className = 'github-sync-shield codicon codicon-shield';
      shield.setAttribute('aria-hidden', 'true');
      tab.appendChild(shield);
    }
    if (githubSyncData.fingerprintsDeferred && shield.dataset.status) continue;
    const status = githubSyncData.shields?.[type] || 'outline';
    shield.dataset.status = status;
    shield.title = githubSyncStatusTitle(status);
  }
}

function githubSyncStatusTitle(status, folder = '') {
  const subject = folder ? `Folder ${folder}` : 'Content';
  return status === 'green'
    ? `${subject} matches the last successful GitHub Sync`
    : status === 'yellow'
      ? `${subject} differs from at least one selected target's last successful snapshot, or its baseline is unavailable. Names alone do not prove matching bytes. Yellow is pending or unverified, not a sync failure; Refresh is read-only and does not sync.`
      : `${subject} is not included in GitHub Sync`;
}

function githubSyncFolderMarker(type, folder) {
  const normalized = String(folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const status = githubSyncData.folderShields?.[type]?.[normalized] || 'outline';
  const icon = status === 'outline' ? 'circle-outline' : 'circle-filled';
  return `<span class="github-sync-folder-status codicon codicon-${icon}" data-sync-type="${esc(type)}" data-sync-folder="${esc(normalized)}" data-status="${status}" title="${esc(githubSyncStatusTitle(status, normalized || '(uncategorized)'))}" aria-label="${esc(githubSyncStatusTitle(status, normalized || '(uncategorized)'))}"></span>`;
}

function updateGitHubSyncFolderShields() {
  document.querySelectorAll('.github-sync-folder-status').forEach(marker => {
    if (marker.classList.contains('github-sync-file-status')) return;
    if (githubSyncData.fingerprintsDeferred && marker.dataset.status) return;
    const type = marker.dataset.syncType;
    const folder = marker.dataset.syncFolder || '';
    const status = githubSyncData.folderShields?.[type]?.[folder] || 'outline';
    const title = githubSyncStatusTitle(status, folder || '(uncategorized)');
    marker.dataset.status = status;
    marker.classList.toggle('codicon-circle-filled', status !== 'outline');
    marker.classList.toggle('codicon-circle-outline', status === 'outline');
    marker.title = title;
    marker.setAttribute('aria-label', title);
  });
}

function githubSyncFileMarker(type, itemId, filePath = '') {
  const path = filePath || githubSyncData.catalog?.[type]?.find(item => item.id === itemId)?.syncPath || '';
  const status = githubSyncData.fileShields?.[type]?.[path] || 'outline';
  const title = githubSyncStatusTitle(status).replace(/^Content/, `File ${path || itemId}`);
  return `<span class="github-sync-folder-status github-sync-file-status codicon codicon-${status === 'outline' ? 'circle-outline' : 'circle-filled'}" data-sync-type="${esc(type)}" data-sync-item="${esc(itemId)}" data-sync-file="${esc(filePath)}" data-status="${status}" title="${esc(title)}" aria-label="${esc(title)}"></span>`;
}

function updateGitHubSyncFileShields() {
  document.querySelectorAll('.github-sync-file-status').forEach(marker => {
    if (githubSyncData.fingerprintsDeferred && marker.dataset.status) return;
    const type = marker.dataset.syncType;
    const path = marker.dataset.syncFile || githubSyncData.catalog?.[type]?.find(item => item.id === marker.dataset.syncItem)?.syncPath || '';
    const status = githubSyncData.fileShields?.[type]?.[path] || 'outline';
    const title = githubSyncStatusTitle(status).replace(/^Content/, `File ${path || marker.dataset.syncItem}`);
    marker.dataset.status = status;
    marker.classList.toggle('codicon-circle-filled', status !== 'outline');
    marker.classList.toggle('codicon-circle-outline', status === 'outline');
    marker.title = title;
    marker.setAttribute('aria-label', title);
  });
}

function ensureGitHubSyncStatus() {
  if (githubSyncStatusRequested || tabCacheIsFresh(githubSyncUpdatedAt)) return;
  githubSyncStatusRequested = true;
  ask('githubSyncState', {}, null, Boolean(githubSyncUpdatedAt));
}

function githubSyncOnRefreshError(message) {
  githubSyncStatusRequested = false;
  githubSyncRefreshError = message;
  if (state.tab === 'githubSync') renderGitHubSyncPane();
}

function githubSyncTarget() {
  return githubSyncData.targets.find(target => target.id === githubSyncEditing);
}

function githubSyncSelection(target, privacy, type) {
  const draft = githubSyncDrafts.get(githubSyncEditing);
  return draft?.selection?.[privacy]?.[type] || target?.selection?.[privacy]?.[type] || { items:[], folders:[] };
}

function githubSyncTreeCount(node) {
  return node.items.length + Object.values(node.folders).reduce((total, child) => total + githubSyncTreeCount(child), 0);
}

function githubSyncRenderTree(privacy, type, node, pathParts, picked, folders, openFolders) {
  const folderRows = Object.entries(node.folders).sort(([left],[right]) => left.localeCompare(right)).map(([name, child]) => {
    const fullPath = [...pathParts, name].join('/');
    const inherited = folders.has('') || [...folders].some(folder => folder && (fullPath === folder || fullPath.startsWith(folder + '/')));
    return `<details class="sub-tree-folder" data-gh-tree="${privacy}:${type}" data-gh-path="${esc(fullPath)}" ${openFolders.has(fullPath) ? 'open' : ''}><summary><input type="checkbox" data-gh-folder="${privacy}:${type}" value="${esc(fullPath)}" ${inherited ? 'checked' : ''} onclick="event.stopPropagation()" onchange="githubSyncFolderToggle(this)"><span>${esc(name)}</span><small>${githubSyncTreeCount(child)}</small></summary><div>${githubSyncRenderTree(privacy,type,child,[...pathParts,name],picked,folders,openFolders)}</div></details>`;
  }).join('');
  const leaves = node.items.sort((left,right) => left.label.localeCompare(right.label)).map(item => {
    const inherited = folders.has('') || [...folders].some(folder => folder && (item.cat === folder || item.cat.startsWith(folder + '/')));
    return `<label class="sub-tree-leaf"><input type="checkbox" data-gh-item="${privacy}:${type}" data-gh-cat="${esc(item.cat || '')}" value="${esc(item.id)}" ${(inherited || picked.has(item.id)) ? 'checked' : ''} onchange="githubSyncItemToggle(this)"><span>${esc(item.label)}</span><small>${esc(item.meta || '')}</small></label>`;
  }).join('');
  return folderRows + leaves;
}

function githubSyncPrivacyTree(target, privacy) {
  return githubSyncTypes.map(type => {
    const items = (githubSyncData.catalog?.[type] || []).filter(item => !!item.isPrivate === (privacy === 'private'));
    const selection = githubSyncSelection(target, privacy, type);
    const picked = new Set(selection.items || []);
    const folders = new Set(selection.folders || []);
    const draft = githubSyncDrafts.get(githubSyncEditing);
    const openFolders = new Set(draft?.openFolders?.[privacy]?.[type] || []);
    const selectedCount = items.filter(item => folders.has('') || picked.has(item.id) || [...folders].some(folder => folder && (item.cat === folder || item.cat.startsWith(folder + '/')))).length;
    return `<details class="sub-picker github-sync-picker" data-gh-picker="${privacy}:${type}" ${draft?.openTypes?.[privacy]?.includes(type) ? 'open' : ''}><summary><strong>${githubSyncLabels[type]}</strong><span>${selectedCount} selected · ${items.length} available</span></summary><div class="sub-picker-items"><label class="sub-folder-rule"><input type="checkbox" data-gh-folder="${privacy}:${type}" value="" ${folders.has('') ? 'checked' : ''} onchange="githubSyncFolderToggle(this)"><span>Entire ${githubSyncLabels[type]}</span><small>include future items</small></label>${githubSyncRenderTree(privacy,type,fileSelectorCategoryTree(items),[],picked,folders,openFolders) || '<span class="sub-empty">No items</span>'}</div></details>`;
  }).join('');
}

function githubSyncEditor() {
  const target = githubSyncTarget();
  const draft = githubSyncDrafts.get(githubSyncEditing);
  const authentication = draft?.authentication ?? target?.authentication ?? {};
  const automation = draft?.automation ?? target?.automation ?? { enabled:false, intervalMinutes:5, syncOnChange:true, initialSyncCompleted:false };
  const automaticReady = !!automation.initialSyncCompleted;
  const accountConnected = !!target && authentication.method === 'vscode' && githubSyncData.connected?.[target.id];
  const authenticationStatus = githubSyncAuthenticationResult
    ? `<div class="github-sync-auth-status success"><span class="codicon codicon-verified-filled"></span><span><strong>${esc(githubSyncAuthenticationResult.login)}</strong><small>${esc(githubSyncAuthenticationResult.fingerprint)}</small></span></div>`
    : accountConnected
      ? `<div class="github-sync-auth-status success"><span class="codicon codicon-verified-filled"></span><span><strong>${esc(authentication.expectedLogin)}</strong><small>Stored securely for automatic backup</small></span></div>`
      : '<div class="github-sync-auth-status"><span class="codicon codicon-key"></span><span>Connect and test this account before automatic backup</span></div>';
  if (!githubSyncEditing) return '';
  const conflictResolution = draft?.conflictResolution ?? target?.conflictResolution ?? 'manual';
  return `<div class="sub-editor sub-broker-settings github-sync-editor"><div class="sub-editor-head"><div><strong>GitHub Target</strong><small>${target ? esc(target.id) : 'New target'}</small></div><button class="icon-btn" onclick="githubSyncClose()" title="Close" aria-label="Close">${uiIcon('close')}</button></div><div class="sub-editor-tabs"><button class="${githubSyncEditorTab === 'general' ? 'active' : ''}" onclick="githubSyncSetEditorTab('general')">General</button><button class="${githubSyncEditorTab === 'automation' ? 'active' : ''}" onclick="githubSyncSetEditorTab('automation')">Automation</button><button class="${githubSyncEditorTab === 'content' ? 'active' : ''}" onclick="githubSyncSetEditorTab('content')">Content</button></div><div class="sub-editor-pane ${githubSyncEditorTab === 'general' ? 'active' : ''}"><div class="github-sync-general"><label>Target name<input id="github-sync-name" value="${esc(draft?.name ?? target?.name ?? '')}" placeholder="Primary sync"></label><label>Repository<input id="github-sync-repository" value="${esc(draft?.repository ?? target?.repository ?? '')}" placeholder="https://github.com/owner/repository.git" oninput="githubSyncAuthenticationChanged()"></label><label>Branch<input id="github-sync-branch" value="${esc(draft?.branch ?? target?.branch ?? 'main')}" placeholder="main"></label><section class="github-sync-auth"><div class="github-sync-auth-grid"><label>GitHub account<input id="github-sync-expected-login" value="${esc(authentication.expectedLogin || '')}" placeholder="GitHub login" oninput="githubSyncAuthenticationChanged()"></label><label>SSH identity<div class="github-sync-identity-control"><input id="github-sync-identity-file" value="${esc(authentication.identityFile || '')}" placeholder="~/.ssh/id_ed25519" oninput="githubSyncAuthenticationChanged()"><button class="icon-btn" onclick="githubSyncPickIdentity(this)" title="Select SSH key" aria-label="Select SSH key">${uiIcon('folder-opened')}</button><button class="icon-btn" data-pending-label="…" onclick="githubSyncCreateIdentity(this)" title="Create dedicated SSH key" aria-label="Create dedicated SSH key">${uiIcon('add')}</button></div></label><button class="pk-button github-sync-test-auth" data-pending-label="Testing…" onclick="githubSyncTestAuthentication(this)">${uiIcon('verified','Test Account')}</button></div>${authenticationStatus}</section></div></div><div class="sub-editor-pane ${githubSyncEditorTab === 'automation' ? 'active' : ''}"><div class="github-sync-automation"><label class="github-sync-check"><input id="github-sync-automation-enabled" type="checkbox" ${automation.enabled ? 'checked' : ''} ${automaticReady ? '' : 'disabled'}><span><strong>Automatic synchronization</strong><small>${automaticReady ? 'Pull and push non-conflicting changes in the background.' : 'Run Initial Sync successfully, resolve every conflict, and finish the push before enabling this manually.'}</small></span></label><label>Sync interval (minutes)<input id="github-sync-interval-minutes" type="number" min="1" max="1440" step="1" required value="${esc(automation.intervalMinutes)}" oninput="this.setCustomValidity('')"><small>Periodically fetch Remote changes, even when Local content is unchanged.</small></label><label class="github-sync-check"><input id="github-sync-on-change" type="checkbox" ${automation.syncOnChange ? 'checked' : ''}><span><strong>Sync when selected content changes</strong><small>Independent of the interval: selected changes sync after a two-second debounce. Unchanged file events do not start Git.</small></span></label><label>Conflict resolution<select id="github-sync-conflict-resolution"><option value="manual" ${conflictResolution === 'manual' ? 'selected' : ''}>Manual review · explicit choice for every file</option><option value="agent" ${conflictResolution === 'agent' ? 'selected' : ''}>Agent-assisted Skill/Recipe merge · review before push</option></select><small>Conflicts always stop the push. Choose this machine, choose GitHub, edit a combined copy, or ask the Agent; approval is still required.</small></label><p>VS Code GitHub Authentication is recommended for unattended HTTPS synchronization and keeps personal and EMU credentials separate per Target. Saving a new Target does not start synchronization. Run Initial Sync manually, resolve and push any conflicts, then return here to enable automation.</p></div></div><div class="sub-editor-pane ${githubSyncEditorTab === 'content' ? 'active' : ''}"><div class="github-sync-privacy-grid"><section><div class="github-sync-privacy-head public"><span class="codicon codicon-globe"></span><strong>Public</strong></div>${githubSyncPrivacyTree(target, 'public')}</section><section><div class="github-sync-privacy-head private"><span class="codicon codicon-lock"></span><strong>Private</strong></div>${githubSyncPrivacyTree(target, 'private')}</section></div></div><div class="sub-editor-actions"><span class="sub-action-spacer"></span><button class="pk-button" onclick="githubSyncClose()">Cancel</button><button class="pk-button primary" data-pending-label="Saving…" onclick="githubSyncSave(this)">Save Target</button></div></div>`;
}

function githubSyncRenderAuthenticationMethod() {
  const grid = document.querySelector('.github-sync-auth-grid');
  const identity = document.getElementById('github-sync-identity-file');
  const account = document.getElementById('github-sync-expected-login');
  if (!grid || !identity || !account) return;
  const draft = githubSyncDrafts.get(githubSyncEditing);
  const target = githubSyncTarget();
  const authentication = draft?.authentication ?? target?.authentication ?? {};
  const populateSuggestions = (input, id, values) => {
    const options = [...new Set((values || []).filter(Boolean))].sort((left,right) => left.localeCompare(right));
    let list = document.getElementById(id);
    if (!list) { list = document.createElement('datalist'); list.id = id; grid.appendChild(list); }
    list.innerHTML = options.map(value => `<option value="${esc(value)}"></option>`).join('');
    input.setAttribute('list', id);
    if (!input.value && options.length === 1) input.value = options[0];
  };
  populateSuggestions(account, 'github-sync-account-options', githubSyncData.authenticationOptions?.accounts);
  populateSuggestions(identity, 'github-sync-identity-options', githubSyncData.authenticationOptions?.identities);
  const method = authentication.method || (authentication.identityFile ? 'ssh' : 'https');
  const label = document.createElement('label');
  label.className = 'github-sync-auth-method';
  label.textContent = 'Authentication';
  const select = document.createElement('select');
  select.id = 'github-sync-auth-method';
  select.innerHTML = '<option value="vscode">VS Code GitHub Authentication (recommended)</option><option value="https">HTTPS / Credential Manager (legacy cache)</option><option value="ssh">SSH key</option>';
  select.value = method;
  select.addEventListener('change', githubSyncAuthenticationMethodChanged);
  label.appendChild(select);
  grid.prepend(label);
  identity.closest('label').hidden = method !== 'ssh';
  document.querySelector('.github-sync-test-auth').hidden = method === 'vscode';
  account.placeholder = method === 'https' ? 'Required for GCM account selection' : 'GitHub login';
}

function githubSyncAuthenticationMethodChanged() {
  githubSyncAuthenticationChanged();
  renderGitHubSyncPane();
}

function githubSyncResolutionDiagram(report, files = []) {
  const agent = files.filter(file => file.candidateSource === 'agent').length;
  const unchanged = report?.rules?.unchanged || 0;
  const automatic = Object.entries(report?.rules || {}).reduce((sum, [rule, count]) =>
    sum + (rule === 'unchanged' || rule === 'human-required' ? 0 : count), 0);
  const humanRequired = report ? report.rules?.['human-required'] || 0 : undefined;
  const detail = report?.generatedAt
    ? `${report.totalFiles} files assessed · last reconciliation ${new Date(report.generatedAt).toLocaleString()}`
    : 'No reconciliation recorded yet';
  const count = value => value === undefined ? '—' : value;
  return `<section class="github-sync-resolution-diagram" onclick="event.stopPropagation()"><header><span><strong>Resolution flow</strong><small>${esc(detail)}</small></span></header><div class="github-sync-resolution-flow"><span><b>${count(report?.localFiles)}</b><small>On this machine</small></span><span><b>${count(report?.remoteFiles)}</b><small>On GitHub</small></span><span><b>${count(report?.totalFiles)}</b><small>Assessed</small></span><span><b>${count(report && unchanged)}</b><small>Unchanged</small></span><span class="automatic"><b>${count(report && automatic)}</b><small>Rules resolved</small></span><span class="human"><b>${count(humanRequired)}</b><small>Conflicts</small></span></div>${files.length ? `<small class="github-sync-resolution-pending">${files.filter(file => file.candidateSource === 'unresolved').length} still need a choice${agent ? ` · ${agent} Agent prepared for review` : ''}</small>` : ''}</section>`;
}

function githubSyncResolvedGroupToggle(targetId, details) {
  const expanded = githubSyncResolvedExpanded.has(targetId);
  if (details.open === expanded) return;
  if (details.open) githubSyncResolvedExpanded.add(targetId);
  else githubSyncResolvedExpanded.delete(targetId);
  renderGitHubSyncPane();
}

function githubSyncDifferenceTree(targetId, entries) {
  const tree = items => {
    const root = { folders:new Map(), leaves:[] };
    for (const entry of items) {
      const parts = entry.path.split('/');
      entry.file = parts.pop();
      let node = root;
      for (const part of parts) {
        if (!node.folders.has(part)) node.folders.set(part, { folders:new Map(), leaves:[] });
        node = node.folders.get(part);
      }
      node.leaves.push(entry);
    }
    return root;
  };
  const count = node => node.leaves.length + [...node.folders.values()].reduce((sum, child) => sum + count(child), 0);
  const render = (node, expanded) => {
    const folders = [...node.folders.entries()].sort(([left],[right]) => left.localeCompare(right)).map(([name, child]) =>
      `<details class="github-sync-diff-folder" ${expanded ? 'open' : ''}><summary>${uiIcon('folder',name)}<small>${count(child)}</small></summary>${render(child, expanded)}</details>`
    ).join('');
    return folders + node.leaves.sort((left,right) => left.file.localeCompare(right.file)).map(entry => entry.html).join('');
  };
  const unresolved = entries.filter(entry => !entry.resolved);
  const resolved = entries.filter(entry => entry.resolved);
  const showResolved = githubSyncResolvedExpanded.has(targetId);
  return `<div class="github-sync-diff-tree">${render(tree(unresolved), true)}${resolved.length ? `<details class="github-sync-resolved-group" ${showResolved ? 'open' : ''} ontoggle="githubSyncResolvedGroupToggle('${esc(targetId)}',this)"><summary>${uiIcon('pass-filled','Resolved')}<small>${resolved.length} · ${showResolved ? 'hide completed' : 'show completed'}</small></summary>${showResolved ? render(tree(resolved), false) : ''}</details>` : ''}</div>`;
}

function githubSyncConflictPanel(targetId, conflict) {
  const sourceLabels = { unresolved:'Choice required', local:'This machine', remote:'GitHub', delete:'Delete GitHub', 'delete-local':'Delete this machine', base:'Common base', manual:'Manual merge', agent:'Agent merge' };
  const conflictFiles = conflict.files || [];
  const entries = conflictFiles.map(file => {
    const encodedPath = encodeURIComponent(file.path);
    const canAgent = file.type === 'skills' || file.type === 'recipes';
    const canDeleteRemote = file.hasBase && !file.hasLocal && file.hasRemote;
    const canDeleteLocal = file.hasLocal && !file.hasRemote;
    const review = file.agentReview;
    const agentReview = review ? `<section class="github-sync-agent-review"><strong>${review.accuracyRisk ? 'Accuracy review required' : 'Human Final Review required'}</strong><p>Confidence ${Math.round(review.confidence * 100)}% · ${review.decisions.length} decisions · ${review.evidence.length} evidence items</p>${review.unresolvedConflicts.length ? `<p>Unresolved: ${esc(review.unresolvedConflicts.join(' · '))}</p>` : ''}${review.introducedContent.length ? `<p>Introduced content: ${esc(review.introducedContent.join(' · '))}</p>` : ''}</section>` : '';
    const resolved = file.candidateSource !== 'unresolved';
    const html = `<details class="github-sync-conflict-file ${resolved ? 'resolved' : 'unresolved'}" ${resolved ? '' : 'open'}><summary><span><strong>${esc(file.path.split('/').pop())}</strong><small>${esc(githubSyncLabels[file.type] || file.type)} · ${esc(file.path)}</small></span><b>${esc(sourceLabels[file.candidateSource] || file.candidateSource)}</b></summary>${file.rationale ? `<p>${esc(file.rationale)}</p>` : ''}${agentReview}<div><button class="pk-button" onclick="githubSyncConflictOpen('${esc(targetId)}',decodeURIComponent('${encodedPath}'),'compare',this)">Compare</button>${file.hasLocal ? `<button class="pk-button" onclick="githubSyncConflictChoose('${esc(targetId)}',decodeURIComponent('${encodedPath}'),'local',this)">Use this machine</button>` : ''}${file.hasRemote ? `<button class="pk-button" onclick="githubSyncConflictChoose('${esc(targetId)}',decodeURIComponent('${encodedPath}'),'remote',this)">Use GitHub</button>` : ''}${canDeleteLocal ? `<button class="pk-button danger" data-pending-label="Selecting…" onclick="githubSyncConflictDeleteLocal('${esc(targetId)}',decodeURIComponent('${encodedPath}'),this)">Delete this machine</button>` : ''}${canDeleteRemote ? `<button class="pk-button danger" data-pending-label="Selecting…" onclick="githubSyncConflictDelete('${esc(targetId)}',decodeURIComponent('${encodedPath}'),this)">Delete GitHub</button>` : ''}${file.hasBase ? `<button class="pk-button" onclick="githubSyncConflictChoose('${esc(targetId)}',decodeURIComponent('${encodedPath}'),'base',this)">Use common base</button>` : ''}<button class="pk-button" onclick="githubSyncConflictOpen('${esc(targetId)}',decodeURIComponent('${encodedPath}'),'edit',this)">Merge manually</button><button class="pk-button" onclick="githubSyncConflictValidate('${esc(targetId)}',decodeURIComponent('${encodedPath}'),this)">Validate merge</button>${canAgent ? `<button class="pk-button" data-pending-label="Merging…" onclick="githubSyncConflictAgent('${esc(targetId)}',decodeURIComponent('${encodedPath}'),this)">Merge with Agent</button>` : ''}</div></details>`;
    return { path:file.path, resolved, html };
  });
  const unresolved = conflictFiles.filter(file => file.candidateSource === 'unresolved').length;
  const unresolvedWithLocal = conflictFiles.filter(file => file.candidateSource === 'unresolved' && file.hasLocal).length;
  const unresolvedWithRemote = conflictFiles.filter(file => file.candidateSource === 'unresolved' && file.hasRemote).length;
  const unresolvedDeletions = conflictFiles.filter(file => file.candidateSource === 'unresolved' && file.hasBase && !file.hasLocal && file.hasRemote).length;
  const localOnly = conflictFiles.filter(file => file.hasLocal && !file.hasRemote).length;
  const missingLocal = conflictFiles.filter(file => file.hasBase && !file.hasLocal && file.hasRemote).length;
  const missingRemote = conflictFiles.filter(file => file.hasBase && file.hasLocal && !file.hasRemote).length;
  const changedBoth = conflictFiles.length - missingLocal - missingRemote;
  const supportedByAgent = conflictFiles.filter(file => file.candidateSource === 'unresolved' && (file.type === 'skills' || file.type === 'recipes')).length;
  const initialPreview = conflict.purpose === 'initial-preview';
  const schemaReady = !initialPreview || conflict.remoteSchema === 3;
  const heading = initialPreview ? `${conflictFiles.length} differences found` : `${conflictFiles.length} conflicting file${conflictFiles.length === 1 ? '' : 's'}`;
  const guidance = conflict.appliedAt
    ? 'Resolutions are applied locally. GitHub sync is still pending or needs a retry; this is not confirmation of a successful push. The workspace is retained until Sync succeeds.'
    : initialPreview
    ? `Remote was fetched read-only. One-sided files are preserved automatically, but files found only on this machine can also be deleted if GitHub's absence is intentional. Nothing is written or pushed before approval.${schemaReady ? '' : ` Repository schema ${conflict.remoteSchema} must be migrated to schema 3 first.`}`
    : `${missingLocal} missing on this machine · ${missingRemote} missing on GitHub · ${changedBoth} changed on both sides or during sync. A missing-file conflict is a deletion safeguard, not necessarily a text merge. A file may have changed during sync, including after the latest push. No further changes are pushed until every file has an explicit resolution.${missingLocal ? ' Delete GitHub confirms the local deletion and stages remote removal.' : ''}${missingRemote ? ' Delete this machine accepts GitHub’s absence and removes the local copy.' : ''}`;
  return `<div class="github-sync-conflict-actions" onclick="event.stopPropagation()"><strong>${esc(heading)}</strong><p>${esc(guidance)}</p>${githubSyncResolutionDiagram(conflict.resolutionReport, conflictFiles)}<div class="github-sync-conflict-bulk">${unresolvedWithRemote ? `<button class="pk-button" data-pending-label="Selecting…" onclick="githubSyncConflictChooseAll('${esc(targetId)}','remote',${unresolvedWithRemote},this)">All Use GitHub</button>` : ''}${!initialPreview && unresolvedDeletions ? `<button class="pk-button danger" data-pending-label="Selecting…" onclick="githubSyncConflictDeleteAll('${esc(targetId)}',${unresolvedDeletions},this)">Delete GitHub</button>` : ''}${unresolvedWithLocal ? `<button class="pk-button" data-pending-label="Selecting…" onclick="githubSyncConflictChooseAll('${esc(targetId)}','local',${unresolvedWithLocal},this)">All Use This Machine</button>` : ''}${localOnly ? `<button class="pk-button danger" data-pending-label="Selecting…" onclick="githubSyncConflictDeleteLocalAll('${esc(targetId)}',${localOnly},this)">Delete This Machine (${localOnly})</button>` : ''}${supportedByAgent ? `<button class="pk-button" data-pending-label="Merging…" onclick="githubSyncConflictAgentAll('${esc(targetId)}',${supportedByAgent},this)">Ask Agent for ${supportedByAgent} unresolved</button>` : ''}</div>${githubSyncDifferenceTree(targetId, entries)}<footer><span>${!schemaReady ? 'Complete schema migration before applying' : unresolved ? `${unresolved} still need a choice` : 'All files have a candidate ready for approval'}</span><button class="pk-button primary" data-pending-label="${initialPreview ? 'Preparing Initial Sync…' : 'Applying resolutions…'}" onclick="githubSyncConflictAccept('${esc(targetId)}',this)" ${unresolved || !schemaReady ? 'disabled' : ''}>${initialPreview ? 'Apply choices &amp; Initial Sync' : 'Apply resolutions &amp; Sync'}</button><button class="pk-button" onclick="githubSyncConflictDiscard('${esc(targetId)}')">Cancel resolution workspace</button></footer></div>`;
}

function githubSyncPhaseDiagram(phase, status) {
  if (!phase && status === 'scheduled') phase = 'scheduled';
  const steps = [
    ['scheduled', 'Scheduled'], ['waiting-for-lock', 'Git lock'], ['authenticating', 'Authentication'],
    ['fetch', 'Fetch / Pull'], ['resolve-conflicts', 'Resolve conflicts'],
    ['commit', 'Commit'], ['push', 'Push'], ['refresh-index', 'Refresh index'],
  ];
  if (phase === 'initial-preview') steps.splice(4, 0, ['initial-preview', 'Compare files']);
  const noChange = phase === 'no-change';
  const currentIndex = noChange ? 3 : ['paused', 'blocked', 'needs-attention'].includes(status) ? -1 : steps.findIndex(([key]) => key === phase);
  const statusLabel = {
    scheduled:'Scheduled', syncing:'Synchronizing', queued:'Queued', paused:'Auto sync off',
    blocked:'Blocked', 'needs-attention':'Needs attention: local content validation',
    conflicts:'Resolve conflicts', error:'Sync failed',
  }[status] || 'Reading sync status…';
  const currentLabel = ['paused', 'blocked', 'needs-attention'].includes(status) ? statusLabel
    : noChange ? 'No Change' : currentIndex < 0 ? statusLabel : steps[currentIndex][1];
  const label = status === 'error' ? currentIndex < 0 ? 'Sync failed' : `${currentLabel} failed` : status === 'conflicts' ? `${currentLabel}: action required` : currentLabel;
  const nodes = steps.map(([key, text], index) => {
    const state = noChange ? index <= currentIndex ? 'done' : 'upcoming'
      : index === currentIndex ? status === 'error' ? 'error' : status === 'conflicts' ? 'conflicts' : 'current'
      : index < currentIndex && status !== 'scheduled' ? 'done' : 'upcoming';
    return `<span class="github-sync-flow-step ${state}" data-phase="${key}"><i aria-hidden="true"></i>${text}</span>`;
  }).join('');
  const branch = `<span class="github-sync-flow-step github-sync-no-change ${noChange ? 'current' : 'upcoming'}" data-phase="no-change"><i aria-hidden="true"></i>No Change</span>`;
  return `<span class="github-sync-phase"><span class="github-sync-phase-current ${status === 'error' ? 'error' : ['conflicts', 'needs-attention'].includes(status) ? 'conflicts' : ''}" aria-hidden="true">${esc(label)}</span><span class="github-sync-flow" role="img" aria-label="GitHub Sync: ${esc(label)}"><span class="github-sync-flow-main">${nodes}</span>${branch}</span></span>`;
}

function githubSyncEffectiveStatus(target, runtime, conflict, forcePending, repair) {
  if (forcePending || runtime.status === 'syncing' || runtime.status === 'queued') return 'syncing';
  if (repair) return 'needs-attention';
  if (conflict) return 'conflicts';
  const failure = target.lastFailure;
  const successAt = Math.max(Date.parse(target.lastSync?.at || '') || 0, Date.parse(runtime.lastSuccessAt || '') || 0);
  if (failure && (!successAt || !Number.isFinite(Date.parse(failure.at)) || Date.parse(failure.at) >= successAt)) return 'error';
  const attemptedAt = Date.parse(runtime.lastAttemptAt || '');
  if (runtime.lastError && (!successAt || !Number.isFinite(attemptedAt) || attemptedAt >= successAt)) return 'error';
  if (runtime.status === 'error' && successAt && attemptedAt < successAt) return 'scheduled';
  return runtime.status || (target.automation?.enabled && target.automation?.initialSyncCompleted ? 'scheduled' : 'paused');
}

function githubSyncContentRepairPanel(targetId, repair) {
  if (!repair) return '';
  const actions = (command, issuePath, label, reason) => {
    const handler = `ask(${JSON.stringify(command)},${JSON.stringify({ targetId, repairId:repair.id, path:issuePath, reason })},this)`;
    return `<button class="pk-button" onclick="${esc(handler).replace(/"/g, '&quot;')}">${label}</button>`;
  };
  const entries = repair.issues.map(issue => {
    const recipe = !!issue.recipeId;
    const reason = issue.reason || 'merge-conflict-markers';
    const action = (command, label) => actions(command, issue.path, label, reason);
    const diagnostics = [issue.error, issue.diagnostics ? JSON.stringify(issue.diagnostics) : ''].filter(Boolean).join('\n');
    const open = issue.canOpen ? action('githubSyncRepairOpen', recipe ? 'Open Recipe editor' : 'Open source')
      : '<p>Edit the generated content in its library editor.</p>';
    const repairActions = recipe && reason === 'recipe-digest'
      ? action('githubSyncRecipeRecompilePreview', 'Preview Recipe recompile') + action('githubSyncRecipeRecompileApply', 'Approve recompile…')
      : issue.hasCandidate ? action('githubSyncRepairPreview', 'Preview empty-block cleanup') + action('githubSyncRepairApply', 'Apply cleanup…')
      : '<p>No safe automatic candidate. Review the source and revalidate.</p>';
    return `<div><strong>${esc(issue.path)}</strong><small>Local · ${esc(reason)}${issue.lines?.length ? ` · lines ${issue.lines.map(line => esc(line)).join(', ')}` : ''}</small>${recipe ? `<p>Recipe store identity: ${esc(issue.recipeId)}. This is an export path, not necessarily a local source file.</p>` : ''}${issue.sourceLocator?.path ? `<p>Source: ${esc(issue.sourceLocator.path)}${issue.sourceLocator.jsonPointer ? ` · ${esc(issue.sourceLocator.jsonPointer)}` : ''}</p>` : ''}${diagnostics ? `<pre>${esc(diagnostics)}</pre>` : ''}${open}${repairActions}</div>`;
  }).join('');
  return `<div class="github-sync-conflict-actions"><strong>Needs attention: local content validation · ${repair.issues.length} issue(s)</strong><p>Sync is waiting for your repair. Remote has not been fetched for this attempt; Base and GitHub versions are unavailable. No source is changed without approval.</p>${entries}<footer>${actions('githubSyncRepairRevalidate', undefined, 'Revalidate &amp; Sync')}</footer></div>`;
}

function githubSyncEffectiveError(target, runtime) {
  return (runtime.status === 'error' ? runtime.lastError || target.lastFailure?.error : target.lastFailure?.error || runtime.lastError)
    || 'No error details were recorded. Open Sync Diagnostic Log for this attempt.';
}

function githubSyncCards() {
  const cards = githubSyncData.targets.map(storedTarget => {
    const automationPending = githubSyncAutomationPending.get(storedTarget.id);
    const target = automationPending
      ? { ...storedTarget, automation:{ ...storedTarget.automation, enabled:automationPending.enabled } }
      : storedTarget;
    const expanded = githubSyncEditing === target.id;
    const last = target.lastSync?.at ? new Date(target.lastSync.at).toLocaleString() : 'Never synchronized';
    const runtime = githubSyncData.runtime?.[target.id] || {};
    const automaticReady = !!target.automation?.initialSyncCompleted;
    const storedConflict = githubSyncData.conflicts?.[target.id];
    const migration = githubSyncData.migrations?.[target.id];
    const forcePending = githubSyncForcePending.has(target.id);
    const rechecking = forcePending || runtime.status === 'syncing' || runtime.status === 'queued';
    const repair = rechecking ? null : githubSyncData.contentRepairs?.[target.id];
    const conflict = rechecking || repair ? null : storedConflict;
    const initialPreview = conflict?.purpose === 'initial-preview';
    const status = githubSyncEffectiveStatus(target, runtime, conflict, forcePending, repair);
    const phase = forcePending ? 'waiting-for-lock' : initialPreview ? 'initial-preview' : conflict ? 'resolve-conflicts' : status === 'error' && ['scheduled', 'paused'].includes(runtime.phase) ? '' : runtime.phase || (runtime.status === 'scheduled' && status !== 'error' ? 'scheduled' : '');
    const retryWithPause = status === 'error' && !!target.automation?.enabled && automaticReady;
    const phaseDiagram = githubSyncPhaseDiagram(phase, status)
      + (runtime.service ? `<small class="github-sync-service">PKM service ${esc(runtime.service.version)} · PID ${esc(runtime.service.pid)}</small>` : '');
    const error = status === 'error' ? githubSyncEffectiveError(target, runtime) : '';
    const next = forcePending ? 'Waiting for Git lock' : repair ? 'Waiting for local content repair · Remote has not been fetched' : initialPreview ? 'Remote fetched read-only · review the file tree before applying' : conflict ? 'Choose a candidate for each file, then Apply resolutions & Sync' : status === 'error' ? error || 'Sync failed without an error message' : runtime.detail || (!automaticReady ? 'Initial manual sync required before automation can be enabled' : runtime.nextSyncAt ? `Next fetch after ${new Date(runtime.nextSyncAt).toLocaleString()}` : target.automation?.enabled ? 'Scheduled to fetch remote changes' : 'Automatic pull/push is off');
    const conflictActions = repair ? githubSyncContentRepairPanel(target.id, repair) : conflict ? githubSyncConflictPanel(target.id, conflict) : '';
    const resolutionDiagram = !conflict ? githubSyncResolutionDiagram(target.lastResolutionReport) : '';
    const syncLabel = repair ? 'Revalidate & Sync' : conflict ? 'Recheck with Remote' : forcePending ? 'Sync queued' : retryWithPause ? 'Pause Auto & Retry' : 'Sync with Remote';
    const scheduleLabel = target.automation?.enabled && automaticReady
      ? `every ${target.automation?.intervalMinutes || 5} min${target.automation?.syncOnChange ? ' + selected changes' : ''}` : 'manual only';
    const autoEnabled = !!target.automation?.enabled && automaticReady;
    const migrationReady = !target.publication || !!target.publication.manualVerificationCompleted;
    const autoDisabled = !!automationPending || (!autoEnabled && (!automaticReady || !migrationReady || status === 'syncing' || !!conflict || !!repair));
    const autoTitle = automationPending ? 'Saving Auto Sync setting'
      : autoEnabled ? 'Turn off automatic synchronization; an active sync will finish'
      : !automaticReady ? 'Run Initial Sync successfully before enabling Auto Sync'
      : !migrationReady ? 'Complete the required manual publication verification before enabling Auto Sync'
      : conflict ? 'Resolve every conflict before enabling Auto Sync'
      : status === 'syncing' ? 'Wait for the current synchronization to finish'
      : autoEnabled ? 'Turn off automatic synchronization' : 'Turn on automatic synchronization';
    const autoToggle = `<button class="github-sync-auto-toggle ${autoEnabled ? 'on' : ''}" role="switch" aria-checked="${autoEnabled}" aria-busy="${!!automationPending}" aria-label="Auto Sync for ${esc(target.name)}" title="${esc(autoTitle)}" onclick="event.stopPropagation();githubSyncAutomationToggle('${esc(target.id)}',${autoEnabled ? 'false' : 'true'},this)" ${autoDisabled ? 'disabled' : ''}><span></span><em>${automationPending ? 'Saving…' : 'Auto'}</em></button>`;
    const migrationCompleted = !!target.publication?.manualVerificationCompleted && (!migration || migration.phase === 'cutover');
    const migrationActions = !migration || migration.phase === 'rolled-back'
      ? `<button class="pk-button" data-pending-label="Checking…" onclick="event.stopPropagation();githubSyncMigration('${esc(target.id)}','preview',this)">Start read-only check</button>`
      : migration.phase === 'previewed'
        ? `<button class="pk-button" data-pending-label="Staging…" onclick="event.stopPropagation();githubSyncMigration('${esc(target.id)}','stage',this)">Stage migration</button>`
        : migration.phase === 'staged'
          ? `<button class="pk-button" data-pending-label="Verifying…" onclick="event.stopPropagation();githubSyncMigration('${esc(target.id)}','verify',this)">Verify staged data</button><button class="pk-button" data-pending-label="Rolling back…" onclick="event.stopPropagation();githubSyncMigration('${esc(target.id)}','rollback',this)">Rollback</button>`
          : migration.phase === 'verified'
            ? `<button class="pk-button primary" data-pending-label="Cutting over…" onclick="event.stopPropagation();githubSyncMigration('${esc(target.id)}','cutover',this)">Cut over</button><button class="pk-button" data-pending-label="Rolling back…" onclick="event.stopPropagation();githubSyncMigration('${esc(target.id)}','rollback',this)">Rollback</button>`
            : migration.phase === 'cutover' && !target.publication?.manualVerificationCompleted
              ? '<small>Cutover complete · run one manual Fetch/Pull → resolve → Commit → Push → inventory/retrieval refresh. Auto Sync remains off.</small>'
              : `<small>${migration.phase === 'cutover' ? 'Manual publication verification complete · Auto Sync may now be enabled manually.' : 'Migration rolled back.'}</small>`;
    const migrationPanel = migrationCompleted ? '' : `<div class="github-sync-migration" onclick="event.stopPropagation()"><span><strong>One-time GitHub publication upgrade</strong><small>${migration ? `${migration.phase} · ${migration.activeCount} managed · ${migration.folderCount} folders · ${migration.idCount} IDs · ${migration.collisions.length} collisions` : 'Required once for targets created before PKM 3.2.1. The read-only check finds stable-ID collisions; it does not change local files or GitHub. Follow Stage, Verify, and Cut over, then run one manual Sync. This panel disappears after that successful sync.'}</small></span><span class="sub-broker-actions">${migrationActions}</span></div>`;
    const migrationBusy = !!migration && !['cutover','rolled-back'].includes(migration.phase);
    const manualTitle = autoEnabled && !retryWithPause ? 'Turn off Auto Sync before using manual synchronization actions' : '';
    const syncDisabled = !!automationPending || (autoEnabled && !retryWithPause) || status === 'syncing' || forcePending || migrationBusy;
    const forceDisabled = !!automationPending || autoEnabled || status === 'syncing' || forcePending || !!conflict || migrationBusy;
    const restoreDisabled = !!automationPending || autoEnabled || status === 'syncing' || forcePending || migrationBusy || !!conflict;
    return `<article class="pk-card sub-broker-card ${expanded ? 'active' : ''}"><div class="sub-broker-row" role="button" tabindex="0" aria-expanded="${expanded}" onclick="githubSyncEdit('${esc(target.id)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();githubSyncEdit('${esc(target.id)}')}"><span><span class="sub-broker-title"><strong>${esc(target.name)}</strong><span class="sub-broker-actions"><button class="pk-button" title="${esc(manualTitle)}" data-pending-label="Pulling…" onclick="event.stopPropagation();githubSyncForce('${esc(target.id)}',this)" ${syncDisabled ? 'disabled' : ''}>${uiIcon('refresh',syncLabel)}</button><button class="pk-button danger" title="${esc(manualTitle)}" data-pending-label="Forcing…" onclick="event.stopPropagation();githubSyncForceUpdate('${esc(target.id)}',this)" ${forceDisabled ? 'disabled' : ''}>Force Update</button><button class="pk-button" title="${esc(manualTitle || (conflict ? 'Resolve or discard the current comparison before restoring a snapshot' : ''))}" data-pending-label="Loading…" onclick="event.stopPropagation();githubSyncRestore('${esc(target.id)}',this)" ${restoreDisabled ? 'disabled' : ''}>${uiIcon('history','Restore snapshot…')}</button><button class="pk-button danger" data-pending-label="Deleting…" onclick="event.stopPropagation();githubSyncDelete('${esc(target.id)}',this)" title="Delete target">${uiIcon('trash')}</button></span></span>${phaseDiagram}<small>${esc(target.repository)}</small>${error ? `<small class="github-sync-error" onclick="event.stopPropagation()" onpointerdown="event.stopPropagation()" title="Select and copy this error">${esc(error)}</small>` : ''}${conflictActions}${resolutionDiagram}${migrationPanel}</span><span class="sub-broker-meta"><span class="github-sync-meta-head"><b>${esc(target.branch)} · ${esc(scheduleLabel)}</b>${autoToggle}</span><small>Last ${esc(last)}</small><small>${esc(next)}</small><i>›</i></span></div>${expanded ? `<div class="sub-broker-expanded">${githubSyncEditor()}</div>` : ''}</article>`;
  }).join('');
  const create = githubSyncEditing === 'new' ? `<article class="pk-card sub-broker-card active"><div class="sub-broker-expanded">${githubSyncEditor()}</div></article>` : '';
  return cards + create || (githubSyncUpdatedAt ? '<div class="sub-empty">No GitHub targets.</div>' : '<div class="sub-empty" role="status">Reading local GitHub Sync settings…</div>');
}

function renderGitHubSyncPane() {
  const detail = document.getElementById('detail');
  const view = captureRefreshView(detail, ['.sub-picker-items','.github-sync-picker']);
  const previousScrollTop = detail?.scrollTop || 0;
  const status = githubSyncRefreshError ? `Content status unavailable: ${esc(githubSyncRefreshError)}` : !githubSyncUpdatedAt ? 'Reading local settings…' : githubSyncData.fingerprintsDeferred ? `${githubSyncData.targets.length} configured targets · Checking content status…` : `${githubSyncData.targets.length} configured targets`;
  detail.innerHTML = `<div class="sub-dashboard github-sync-dashboard"><header class="sub-head"><div><h2>GitHub Sync</h2><p role="${githubSyncRefreshError ? 'alert' : 'status'}">${status}</p></div><div class="project-header-actions github-sync-header-actions"><button class="recipe-icon-button" title="Open Sync Diagnostic Log" aria-label="Open Sync Diagnostic Log" onclick="ask('openGitHubSyncDiagnosticLog',{})">${uiIcon('file-text')}</button><button class="recipe-icon-button" title="Refresh GitHub Sync" aria-label="Refresh GitHub Sync" onclick="ask('githubSyncState',{})"><span class="codicon codicon-refresh"></span></button><button class="pk-button primary" onclick="githubSyncNew()">${uiIcon('add','Target')}</button></div></header><section class="sub-band github-sync-transfer"><strong>Local transfer</strong><div><button class="recipe-icon-button" title="Export Knowledge" aria-label="Export Knowledge" onclick="doExport()">${uiIcon('export')}</button><button class="recipe-icon-button" title="Import Knowledge" aria-label="Import Knowledge" onclick="triggerImport()">${uiIcon('arrow-down')}</button></div></section><section class="sub-band"><div class="pk-list sub-broker-list">${githubSyncCards()}</div></section></div>`;
  detail.scrollTop = Math.min(previousScrollTop, Math.max(0, detail.scrollHeight - detail.clientHeight));
  githubSyncRenderAuthenticationMethod();
  githubSyncSyncFolderStates();
  restoreRefreshView(detail, view);
}

function githubSyncNew() {
  githubSyncCaptureDraft();
  githubSyncEditing = 'new';
  githubSyncEditorTab = 'general';
  githubSyncAuthenticationResult = null;
  githubSyncDrafts.set('new', { name:'', repository:'', branch:'main', authentication:{method:'vscode',expectedLogin:''}, automation:{enabled:false,intervalMinutes:5,syncOnChange:true,initialSyncCompleted:false}, selection:githubSyncDefaultSelection(), openFolders:{public:{},private:{}}, openTypes:{public:[],private:[]} });
  renderGitHubSyncPane();
}
function githubSyncEdit(id) { githubSyncCaptureDraft(); githubSyncEditing = githubSyncEditing === id ? '' : id; githubSyncEditorTab = 'general'; githubSyncAuthenticationResult = null; renderGitHubSyncPane(); }
function githubSyncClose() { githubSyncDrafts.delete(githubSyncEditing); githubSyncEditing = ''; githubSyncAuthenticationResult = null; renderGitHubSyncPane(); }
function githubSyncSetEditorTab(tab) { githubSyncCaptureDraft(); githubSyncEditorTab = tab; renderGitHubSyncPane(); }

function githubSyncCaptureDraft() {
  if (!githubSyncEditing || !document.querySelector('.github-sync-editor')) return;
  const previous = githubSyncDrafts.get(githubSyncEditing) || {};
  const selection = { public:{}, private:{} }, openFolders = { public:{}, private:{} }, openTypes = { public:[], private:[] };
  for (const privacy of ['public','private']) for (const type of githubSyncTypes) {
    const key = `${privacy}:${type}`;
    const picker = document.querySelector(`.github-sync-picker[data-gh-picker="${key}"]`);
    if (picker) {
      selection[privacy][type] = {
        items:[...picker.querySelectorAll(`input[data-gh-item="${key}"]:checked`)].map(input => input.value),
        folders:[...picker.querySelectorAll(`input[data-gh-folder="${key}"]:checked`)].map(input => input.value)
      };
      openFolders[privacy][type] = [...picker.querySelectorAll(`.sub-tree-folder[open][data-gh-tree="${key}"]`)].map(folder => folder.dataset.ghPath);
      if (picker.open) openTypes[privacy].push(type);
    } else {
      selection[privacy][type] = previous.selection?.[privacy]?.[type] || githubSyncTarget()?.selection?.[privacy]?.[type] || { items:[], folders:[] };
      openFolders[privacy][type] = previous.openFolders?.[privacy]?.[type] || [];
      if (previous.openTypes?.[privacy]?.includes(type)) openTypes[privacy].push(type);
    }
  }
  const identityFile = document.getElementById('github-sync-identity-file')?.value.trim() ?? previous.authentication?.identityFile ?? '';
  const expectedLogin = document.getElementById('github-sync-expected-login')?.value.trim() ?? previous.authentication?.expectedLogin ?? '';
  const method = document.getElementById('github-sync-auth-method')?.value ?? previous.authentication?.method ?? (identityFile ? 'ssh' : 'https');
  const authentication = expectedLogin || (method === 'ssh' && identityFile)
    ? method === 'ssh' ? { method, identityFile, expectedLogin } : { method, expectedLogin }
    : undefined;
  const automation = {
    enabled:document.getElementById('github-sync-automation-enabled')?.checked ?? previous.automation?.enabled ?? githubSyncTarget()?.automation?.enabled ?? false,
    intervalMinutes:Number(document.getElementById('github-sync-interval-minutes')?.value ?? previous.automation?.intervalMinutes ?? githubSyncTarget()?.automation?.intervalMinutes ?? 5),
    syncOnChange:document.getElementById('github-sync-on-change')?.checked ?? previous.automation?.syncOnChange ?? githubSyncTarget()?.automation?.syncOnChange ?? true,
    initialSyncCompleted:previous.automation?.initialSyncCompleted ?? githubSyncTarget()?.automation?.initialSyncCompleted ?? false
  };
  const conflictResolution = document.getElementById('github-sync-conflict-resolution')?.value ?? previous.conflictResolution ?? githubSyncTarget()?.conflictResolution ?? 'manual';
  githubSyncDrafts.set(githubSyncEditing, { ...previous, name:document.getElementById('github-sync-name')?.value ?? previous.name, repository:document.getElementById('github-sync-repository')?.value ?? previous.repository, branch:document.getElementById('github-sync-branch')?.value ?? previous.branch, authentication, automation, conflictResolution, selection, openFolders, openTypes });
}

function githubSyncSyncFolderStates(key) {
  const pickers = key ? document.querySelectorAll(`.github-sync-picker[data-gh-picker="${key}"]`) : document.querySelectorAll('.github-sync-picker');
  pickers.forEach(picker => {
    const items = [...picker.querySelectorAll('input[data-gh-item]')];
    picker.querySelectorAll('input[data-gh-folder]').forEach(folder => {
      const descendants = items.filter(item => folder.value === '' || item.dataset.ghCat === folder.value || item.dataset.ghCat?.startsWith(folder.value + '/'));
      folder.indeterminate = !folder.checked && descendants.some(item => item.checked);
    });
  });
}
function githubSyncFolderToggle(input) {
  const key = input.dataset.ghFolder;
  const picker = input.closest('.github-sync-picker');
  if (!input.checked) githubSyncUncheckParents(key, input.value, input);
  picker.querySelectorAll('input[data-gh-item],input[data-gh-folder]').forEach(candidate => {
    const category = candidate.dataset.ghCat ?? candidate.value;
    if (candidate === input || input.value === '' || category === input.value || category.startsWith(input.value + '/')) candidate.checked = input.checked;
  });
  githubSyncSyncFolderStates(key); githubSyncCaptureDraft(); githubSyncUpdateCount(key);
}
function githubSyncItemToggle(input) { if (!input.checked) githubSyncUncheckParents(input.dataset.ghItem, input.dataset.ghCat || ''); githubSyncSyncFolderStates(input.dataset.ghItem); githubSyncCaptureDraft(); githubSyncUpdateCount(input.dataset.ghItem); }
function githubSyncUncheckParents(key, itemPath, except) { document.querySelectorAll(`input[data-gh-folder="${key}"]:checked`).forEach(folder => { if (folder !== except && (folder.value === '' || itemPath === folder.value || itemPath.startsWith(folder.value + '/'))) folder.checked = false; }); }
function githubSyncUpdateCount(key) { const picker = document.querySelector(`.github-sync-picker[data-gh-picker="${key}"]`); if (!picker) return; const selected = picker.querySelectorAll('input[data-gh-item]:checked').length, total = picker.querySelectorAll('input[data-gh-item]').length; const summary = picker.querySelector(':scope>summary span'); if (summary) summary.textContent = `${selected} selected · ${total} available`; }

function githubSyncSave(button) {
  githubSyncCaptureDraft();
  const draft = githubSyncDrafts.get(githubSyncEditing);
  const intervalInput = document.getElementById('github-sync-interval-minutes');
  const intervalMinutes = Number(draft?.automation?.intervalMinutes);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    githubSyncEditorTab = 'automation';
    if (!intervalInput) renderGitHubSyncPane();
    const visibleInput = document.getElementById('github-sync-interval-minutes');
    visibleInput?.setCustomValidity('Enter a whole number from 1 to 1440.');
    visibleInput?.reportValidity();
    visibleInput?.focus();
    return;
  }
  githubSyncSaving = true;
  ask('githubSyncSave', { target:{ id:githubSyncEditing === 'new' ? '' : githubSyncEditing, name:draft.name, repository:draft.repository, branch:draft.branch, authentication:draft.authentication, automation:draft.automation, conflictResolution:draft.conflictResolution, selection:draft.selection } }, button);
}
function githubSyncAuthenticationChanged() { githubSyncAuthenticationResult = null; githubSyncCaptureDraft(); const status = document.querySelector('.github-sync-auth-status'); if (status) status.outerHTML = '<div class="github-sync-auth-status"><span class="codicon codicon-key"></span><span>Account not tested</span></div>'; }
function githubSyncPickIdentity(button) { githubSyncCaptureDraft(); ask('githubSyncPickIdentity', {}, button); }
function githubSyncCreateIdentity(button) { githubSyncCaptureDraft(); const draft = githubSyncDrafts.get(githubSyncEditing); ask('githubSyncCreateIdentity', { expectedLogin:draft?.authentication?.expectedLogin || '' }, button); }
function githubSyncIdentityPicked(identityFile) { if (!identityFile) return; const input = document.getElementById('github-sync-identity-file'); if (input) input.value = identityFile; githubSyncAuthenticationChanged(); }
function githubSyncTestAuthentication(button) {
  githubSyncCaptureDraft();
  const draft = githubSyncDrafts.get(githubSyncEditing);
  ask('githubSyncTestAuthentication', { target:{ id:githubSyncEditing === 'new' ? '' : githubSyncEditing, name:draft.name || 'Authentication test', repository:draft.repository, branch:draft.branch, authentication:draft.authentication } }, button);
}
function githubSyncOnAuthenticationResult(data) { githubSyncCaptureDraft(); const draft = githubSyncDrafts.get(githubSyncEditing); if (draft?.authentication && !draft.authentication.expectedLogin) draft.authentication.expectedLogin = data?.login || ''; githubSyncAuthenticationResult = data || null; renderGitHubSyncPane(); }
function githubSyncOnRuntimeState(data) {
  if (!data?.targetId) return;
  const previous = githubSyncData.runtime?.[data.targetId];
  const runtime = data.state || {};
  if (githubSyncRuntimeIsOlder(previous, runtime)) return;
  githubSyncData.runtime = { ...(githubSyncData.runtime || {}), [data.targetId]:runtime };
  if (githubSyncForcePending.has(data.targetId) && runtime.lastAttemptAt
    && runtime.lastAttemptAt !== githubSyncPendingAfter.get(data.targetId)) {
    githubSyncForcePending.delete(data.targetId);
    githubSyncPendingAfter.delete(data.targetId);
  }
  if (state.tab === 'githubSync') { githubSyncCaptureDraft(); renderGitHubSyncPane(); }
}
function githubSyncOnRunQueued(data) { if (!data?.targetId) return; if (!data.queued) { githubSyncForcePending.delete(data.targetId); githubSyncPendingAfter.delete(data.targetId); } if (state.tab === 'githubSync') { githubSyncCaptureDraft(); renderGitHubSyncPane(); } vscode.postMessage({ command:'toast', text:data.queued ? 'GitHub sync queued' : 'GitHub sync is already queued or running' }); }
function githubSyncDelete(targetId, button) { const target = githubSyncData.targets.find(item => item.id === targetId); pkModal({ title:'Delete GitHub Target?', message:`${target?.name || targetId}\n\nStops future pull/push operations and removes the local target configuration immediately. Local checkout cleanup continues in the background if Git still holds Windows file handles. The GitHub repository and Knowledge Root content are not deleted. An already-started push may still finish.`, okLabel:'Delete Target', danger:true, onOk:()=>ask('githubSyncDelete',{targetId},button) }); }
function githubSyncForce(targetId, button) {
  if (githubSyncForcePending.has(targetId) || pendingActionButtons.has('githubSyncRun')) return;
  const target = githubSyncData.targets.find(item => item.id === targetId);
  const runtime = githubSyncData.runtime?.[targetId] || {};
  const pauseAutomation = !!target?.automation?.enabled && !githubSyncData.conflicts?.[targetId]
    && (runtime.status || (target?.lastFailure ? 'error' : '')) === 'error';
  githubSyncPendingAfter.set(targetId, githubSyncData.runtime?.[targetId]?.lastAttemptAt);
  githubSyncForcePending.add(targetId);
  const card = button?.closest?.('.sub-broker-card');
  const phase = card?.querySelector('.github-sync-phase');
  if (phase) phase.outerHTML = githubSyncPhaseDiagram('waiting-for-lock', 'syncing');
  card?.querySelector('.github-sync-error')?.remove();
  card?.querySelector('.github-sync-conflict-actions')?.remove();
  const detail = card?.querySelector('.sub-broker-meta > small:last-of-type');
  if (detail) detail.textContent = 'Waiting for Git lock';
  ask('githubSyncRun', { targetId, ...(pauseAutomation ? { pauseAutomation:true } : {}) }, button);
}
function githubSyncForceUpdate(targetId, button) {
  if (githubSyncForcePending.has(targetId)) return;
  const target = githubSyncData.targets.find(item => item.id === targetId);
  pkModal({
    title:'Force Update GitHub from this machine?',
    message:`${target?.name || targetId}\n\nDanger: the current machine-local selected projection becomes authoritative. Selected GitHub files missing locally will be deleted, and conflicting GitHub edits will be overwritten. Unselected GitHub content is preserved.\n\nThis disables Auto Sync, creates an attributed audit commit, and requires one more native confirmation.`,
    okLabel:'Continue to final confirmation',
    danger:true,
    onOk:()=>{
      githubSyncForcePending.add(targetId);
      ask('githubSyncForceUpdate', { targetId }, button);
    }
  });
}
function githubSyncAutomationToggle(targetId, enabled, button) {
  if (button?.disabled || githubSyncAutomationPending.has(targetId)) return;
  const timer = setTimeout(() => {
    githubSyncOnAutomationResult({ targetId });
    showViewActionError('Auto Sync setting timed out. Refresh the target state before retrying.');
    ask('githubSyncState', {}, null, true);
  }, 60_000);
  githubSyncAutomationPending.set(targetId, { enabled, timer });
  renderGitHubSyncPane();
  ask('githubSyncAutomationToggle', { targetId, enabled }, null, true);
}
function githubSyncOnAutomationResult(data) {
  const pending = githubSyncAutomationPending.get(data?.targetId);
  if (pending) clearTimeout(pending.timer);
  githubSyncAutomationPending.delete(data?.targetId);
  const target = githubSyncData.targets.find(item => item.id === data?.targetId);
  if (target && typeof data.enabled === 'boolean') target.automation.enabled = data.enabled;
  if (state.tab === 'githubSync') renderGitHubSyncPane();
}
function githubSyncMigration(targetId, action, button) { ask('githubSyncMigration', { targetId, action }, button); }
function githubSyncRestore(targetId, button) { ask('githubSyncRestore', { targetId }, button); }
function githubSyncConflictRequest(targetId, values = {}) {
  const conflict = githubSyncData.conflicts?.[targetId];
  return { targetId, conflictId:conflict?.id, revision:conflict?.revision || 0, ...values };
}
function githubSyncConflictOpen(targetId, path, mode, button) { ask('githubSyncConflictOpen', githubSyncConflictRequest(targetId, { path, mode }), button); }
function githubSyncConflictChoose(targetId, path, source, button) { ask('githubSyncConflictChoose', githubSyncConflictRequest(targetId, { path, source }), button); }
function githubSyncConflictChooseAll(targetId, source, count, button) {
  const label = source === 'remote' ? 'GitHub' : 'this machine';
  pkModal({ title:`Use ${label} for ${count} unresolved conflicts?`, message:`Prepare the ${label} version for unresolved conflicts where it exists. Previously selected, manual, and Agent candidates are preserved. This only stages candidates; review and Apply resolutions & Sync are still required.`, okLabel:`Use ${label} for unresolved`, onOk:()=>ask('githubSyncConflictChooseAll',githubSyncConflictRequest(targetId,{source}),button) });
}
function githubSyncConflictDelete(targetId, path, button) {
  pkModal({ title:'Delete this file from GitHub?', message:`The file is already missing on this machine. Confirm its deletion from GitHub when you later choose Apply resolutions & Sync.\n\n${path}`, okLabel:'Delete GitHub', danger:true, onOk:()=>ask('githubSyncConflictDelete',githubSyncConflictRequest(targetId,{path}),button) });
}
function githubSyncConflictDeleteAll(targetId, count, button) {
  pkModal({ title:`Delete ${count} files from GitHub?`, message:'These files are already missing on this machine. Their deletion will be recorded explicitly and pushed to GitHub only after you choose Apply resolutions & Sync. This does not delete any additional local files.', okLabel:'Delete GitHub', danger:true, onOk:()=>ask('githubSyncConflictDeleteAll',githubSyncConflictRequest(targetId),button) });
}
function githubSyncConflictDeleteLocal(targetId, path, button) {
  pkModal({ title:'Delete this file from this machine?', message:`GitHub does not contain this file. Accept GitHub's absence and delete the local copy when you later choose Apply resolutions & Sync.\n\n${path}`, okLabel:'Delete This Machine', danger:true, onOk:()=>ask('githubSyncConflictDeleteLocal',githubSyncConflictRequest(targetId,{path}),button) });
}
function githubSyncConflictDeleteLocalAll(targetId, count, button) {
  pkModal({ title:`Delete ${count} files from this machine?`, message:'GitHub does not contain these files. Accept GitHub’s absence and delete all listed local copies only after Apply resolutions & Sync. Files that change before Apply will be returned for review instead of deleted.', okLabel:'Delete This Machine', danger:true, onOk:()=>ask('githubSyncConflictDeleteLocalAll',githubSyncConflictRequest(targetId),button) });
}
function githubSyncConflictValidate(targetId, path, button) { ask('githubSyncConflictValidate', githubSyncConflictRequest(targetId, { path }), button); }
function githubSyncConflictAgent(targetId, path, button) { ask('githubSyncConflictAgent', githubSyncConflictRequest(targetId, { path }), button); }
function githubSyncConflictAgentAll(targetId, count, button) { pkModal({ title:'Ask Agent to merge supported conflicts?', message:`Prepare Agent merge candidates for ${count} unresolved Skill/Recipe conflicts. Existing decisions are preserved. Unsupported or unsafe conflicts remain unresolved for explicit review.`, okLabel:'Merge supported conflicts', onOk:()=>ask('githubSyncConflictAgentAll',githubSyncConflictRequest(targetId),button) }); }
function githubSyncConflictAccept(targetId, button) { pkModal({ title:'Apply resolved files and sync?', message:'Saved and validated candidates will replace the local files, then queue a manual pull/push. The resolution workspace is retained until Sync succeeds. Local application is not confirmation of a successful GitHub push. Automatic synchronization remains off until that sync succeeds and you enable it yourself.', okLabel:'Apply & Sync', onOk:()=>ask('githubSyncConflictAccept',githubSyncConflictRequest(targetId),button) }); }
function githubSyncConflictDiscard(targetId) { pkModal({ title:'Cancel this resolution workspace?', message:'Only the staged resolution choices are deleted. Files on this machine and GitHub are unchanged, and the same conflicts will be detected by the next manual sync.', okLabel:'Cancel workspace', danger:true, onOk:()=>ask('githubSyncConflictDiscard',githubSyncConflictRequest(targetId)) }); }
