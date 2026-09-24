// ── GitHub Sync ───────────────────────────────────────────────────────────
let githubSyncData = { targets:[], catalog:{}, shields:{}, authenticationOptions:{ accounts:[], identities:[] } };
let githubSyncEditing = '';
let githubSyncEditorTab = 'general';
let githubSyncSaving = false;
let githubSyncAuthenticationResult = null;
const githubSyncDrafts = new Map();
const githubSyncTypes = ['skills','notes','papers','prompts','scripts','packages','servers','recipes'];
const githubSyncLabels = { skills:'Skills', notes:'Notes', papers:'Research', prompts:'Prompts', scripts:'Scripts', packages:'Packages', servers:'Servers', recipes:'Recipes' };

function renderGitHubSyncLoading() {
  document.getElementById('detail').innerHTML = '<div class="empty">Loading GitHub Sync…</div>';
}

function githubSyncDefaultSelection() {
  const publicScope = {};
  const privateScope = {};
  for (const type of githubSyncTypes) {
    publicScope[type] = { items:[], folders:['packages','servers'].includes(type) ? [] : [''] };
    privateScope[type] = { items:[], folders:[] };
  }
  return { public:publicScope, private:privateScope };
}

function githubSyncOnState(data) {
  if (githubSyncEditing) githubSyncCaptureDraft();
  githubSyncData = { ...githubSyncData, ...(data || {}) };
  if (githubSyncSaving) {
    githubSyncDrafts.delete(githubSyncEditing);
    githubSyncEditing = '';
    githubSyncSaving = false;
  }
  if (githubSyncEditing && githubSyncEditing !== 'new' && !githubSyncData.targets.some(target => target.id === githubSyncEditing)) githubSyncEditing = '';
  updateGitHubSyncShields();
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
    const status = githubSyncData.shields?.[type] || 'outline';
    shield.dataset.status = status;
    shield.title = status === 'green' ? 'GitHub synchronized' : status === 'yellow' ? 'Local content differs from GitHub' : 'No GitHub target configured';
  }
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
  const authenticationStatus = githubSyncAuthenticationResult
    ? `<div class="github-sync-auth-status success"><span class="codicon codicon-verified-filled"></span><span><strong>${esc(githubSyncAuthenticationResult.login)}</strong><small>${esc(githubSyncAuthenticationResult.fingerprint)}</small></span></div>`
    : '<div class="github-sync-auth-status"><span class="codicon codicon-key"></span><span>Account not tested</span></div>';
  if (!githubSyncEditing) return '';
  return `<div class="sub-editor sub-broker-settings github-sync-editor"><div class="sub-editor-head"><div><strong>GitHub Target</strong><small>${target ? esc(target.id) : 'New target'}</small></div><button class="icon-btn" onclick="githubSyncClose()" title="Close" aria-label="Close">${uiIcon('close')}</button></div><div class="sub-editor-tabs"><button class="${githubSyncEditorTab === 'general' ? 'active' : ''}" onclick="githubSyncSetEditorTab('general')">General</button><button class="${githubSyncEditorTab === 'content' ? 'active' : ''}" onclick="githubSyncSetEditorTab('content')">Content</button></div><div class="sub-editor-pane ${githubSyncEditorTab === 'general' ? 'active' : ''}"><div class="github-sync-general"><label>Target name<input id="github-sync-name" value="${esc(draft?.name ?? target?.name ?? '')}" placeholder="Primary backup"></label><label>Repository<input id="github-sync-repository" value="${esc(draft?.repository ?? target?.repository ?? '')}" placeholder="git@github.com:owner/repository.git" oninput="githubSyncAuthenticationChanged()"></label><label>Branch<input id="github-sync-branch" value="${esc(draft?.branch ?? target?.branch ?? 'main')}" placeholder="main"></label><section class="github-sync-auth"><div class="github-sync-auth-grid"><label>GitHub account<input id="github-sync-expected-login" value="${esc(authentication.expectedLogin || '')}" placeholder="Auto-detect" oninput="githubSyncAuthenticationChanged()"></label><label>SSH identity<div class="github-sync-identity-control"><input id="github-sync-identity-file" value="${esc(authentication.identityFile || '')}" placeholder="~/.ssh/id_ed25519" oninput="githubSyncAuthenticationChanged()"><button class="icon-btn" onclick="githubSyncPickIdentity(this)" title="Select SSH key" aria-label="Select SSH key">${uiIcon('folder-opened')}</button><button class="icon-btn" data-pending-label="…" onclick="githubSyncCreateIdentity(this)" title="Create dedicated SSH key" aria-label="Create dedicated SSH key">${uiIcon('add')}</button></div></label><button class="pk-button github-sync-test-auth" data-pending-label="Testing…" onclick="githubSyncTestAuthentication(this)">${uiIcon('verified','Test Account')}</button></div>${authenticationStatus}</section></div></div><div class="sub-editor-pane ${githubSyncEditorTab === 'content' ? 'active' : ''}"><div class="github-sync-privacy-grid"><section><div class="github-sync-privacy-head public"><span class="codicon codicon-globe"></span><strong>Public</strong></div>${githubSyncPrivacyTree(target, 'public')}</section><section><div class="github-sync-privacy-head private"><span class="codicon codicon-lock"></span><strong>Private</strong></div>${githubSyncPrivacyTree(target, 'private')}</section></div></div><div class="sub-editor-actions"><span class="sub-action-spacer"></span><button class="pk-button" onclick="githubSyncClose()">Cancel</button><button class="pk-button primary" data-pending-label="Saving…" onclick="githubSyncSave(this)">Save Target</button></div></div>`;
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
  select.innerHTML = '<option value="https">HTTPS / Credential Manager</option><option value="ssh">SSH key</option>';
  select.value = method;
  select.addEventListener('change', githubSyncAuthenticationMethodChanged);
  label.appendChild(select);
  grid.prepend(label);
  identity.closest('label').hidden = method !== 'ssh';
  account.placeholder = method === 'https' ? 'Required for GCM account selection' : 'Auto-detect';
}

function githubSyncAuthenticationMethodChanged() {
  githubSyncAuthenticationChanged();
  renderGitHubSyncPane();
}

function githubSyncCards() {
  const cards = githubSyncData.targets.map(target => {
    const expanded = githubSyncEditing === target.id;
    const last = target.lastSync?.at ? new Date(target.lastSync.at).toLocaleString() : 'Never synchronized';
    return `<article class="pk-card sub-broker-card ${expanded ? 'active' : ''}"><div class="sub-broker-row" role="button" tabindex="0" aria-expanded="${expanded}" onclick="githubSyncEdit('${esc(target.id)}')"><span><span class="sub-broker-title"><strong>${esc(target.name)}</strong><span class="sub-broker-actions"><button class="pk-button" data-pending-label="Syncing…" onclick="event.stopPropagation();githubSyncRun('${esc(target.id)}',this)">${uiIcon('sync','Sync')}</button><button class="pk-button" data-pending-label="Loading…" onclick="event.stopPropagation();githubSyncRestore('${esc(target.id)}',this)">${uiIcon('history','Restore…')}</button><button class="pk-button danger" onclick="event.stopPropagation();githubSyncDelete('${esc(target.id)}')" title="Delete target">${uiIcon('trash')}</button></span></span><small>${esc(target.repository)}</small></span><span class="sub-broker-meta"><b>${esc(target.branch)}</b><small>${esc(last)}</small><i>›</i></span></div>${expanded ? `<div class="sub-broker-expanded">${githubSyncEditor()}</div>` : ''}</article>`;
  }).join('');
  const create = githubSyncEditing === 'new' ? `<article class="pk-card sub-broker-card active"><div class="sub-broker-expanded">${githubSyncEditor()}</div></article>` : '';
  return cards + create || '<div class="sub-empty">No GitHub targets.</div>';
}

function renderGitHubSyncPane() {
  document.getElementById('detail').innerHTML = `<div class="sub-dashboard github-sync-dashboard"><header class="sub-head"><div><h2>GitHub Sync</h2><p>${githubSyncData.targets.length} configured targets</p></div><button class="pk-button primary" onclick="githubSyncNew()">${uiIcon('add','Target')}</button></header><section class="sub-band"><div class="pk-list sub-broker-list">${githubSyncCards()}</div></section></div>`;
  githubSyncRenderAuthenticationMethod();
  githubSyncSyncFolderStates();
}

function githubSyncNew() {
  githubSyncCaptureDraft();
  githubSyncEditing = 'new';
  githubSyncEditorTab = 'general';
  githubSyncAuthenticationResult = null;
  githubSyncDrafts.set('new', { name:'', repository:'', branch:'main', selection:githubSyncDefaultSelection(), openFolders:{public:{},private:{}}, openTypes:{public:[],private:[]} });
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
  githubSyncDrafts.set(githubSyncEditing, { ...previous, name:document.getElementById('github-sync-name')?.value ?? previous.name, repository:document.getElementById('github-sync-repository')?.value ?? previous.repository, branch:document.getElementById('github-sync-branch')?.value ?? previous.branch, authentication, selection, openFolders, openTypes });
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
  githubSyncSaving = true;
  ask('githubSyncSave', { target:{ id:githubSyncEditing === 'new' ? '' : githubSyncEditing, name:draft.name, repository:draft.repository, branch:draft.branch, authentication:draft.authentication, selection:draft.selection } }, button);
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
function githubSyncRun(targetId, button) { ask('githubSyncRun', { targetId }, button); }
function githubSyncDelete(targetId) { const target = githubSyncData.targets.find(item => item.id === targetId); pkModal({ title:'Delete GitHub Target?', message:`${target?.name || targetId}\n\nThe remote repository is not changed.`, okLabel:'Delete Target', danger:true, onOk:()=>ask('githubSyncDelete',{targetId}) }); }
function githubSyncRestore(targetId, button) { ask('githubSyncRestore', { targetId }, button); }
