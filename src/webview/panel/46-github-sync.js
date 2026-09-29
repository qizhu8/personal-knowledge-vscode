// ── GitHub Sync ───────────────────────────────────────────────────────────
let githubSyncData = { targets:[], catalog:{}, shields:{}, runtime:{}, migrations:{}, connected:{}, authenticationOptions:{ accounts:[], identities:[] } };
let githubSyncEditing = '';
let githubSyncEditorTab = 'general';
let githubSyncSaving = false;
let githubSyncAuthenticationResult = null;
let githubSyncUpdatedAt = 0;
const githubSyncDrafts = new Map();
const githubSyncForcePending = new Set();
const githubSyncTypes = ['skills','notes','papers','prompts','scripts','packages','servers','recipes','agentSnapshots'];
const githubSyncLabels = { skills:'Skills', notes:'Notes', papers:'Research', prompts:'Prompts', scripts:'Scripts', packages:'Packages', servers:'Servers', recipes:'Recipes', agentSnapshots:'Agent Snapshots' };

function renderGitHubSyncLoading() {
  document.getElementById('detail').innerHTML = '<div class="empty">Loading GitHub Sync…</div>';
}

function showGitHubSyncTab() {
  if (githubSyncUpdatedAt) renderGitHubSyncPane(); else renderGitHubSyncLoading();
  if (!tabCacheIsFresh(githubSyncUpdatedAt)) ask('githubSyncState', {}, null, Boolean(githubSyncUpdatedAt));
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

function githubSyncOnState(data) {
  if (githubSyncEditing) githubSyncCaptureDraft();
  githubSyncData = { ...githubSyncData, ...(data || {}) };
  githubSyncUpdatedAt = Date.now();
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
  return `<div class="sub-editor sub-broker-settings github-sync-editor"><div class="sub-editor-head"><div><strong>GitHub Target</strong><small>${target ? esc(target.id) : 'New target'}</small></div><button class="icon-btn" onclick="githubSyncClose()" title="Close" aria-label="Close">${uiIcon('close')}</button></div><div class="sub-editor-tabs"><button class="${githubSyncEditorTab === 'general' ? 'active' : ''}" onclick="githubSyncSetEditorTab('general')">General</button><button class="${githubSyncEditorTab === 'automation' ? 'active' : ''}" onclick="githubSyncSetEditorTab('automation')">Automation</button><button class="${githubSyncEditorTab === 'content' ? 'active' : ''}" onclick="githubSyncSetEditorTab('content')">Content</button></div><div class="sub-editor-pane ${githubSyncEditorTab === 'general' ? 'active' : ''}"><div class="github-sync-general"><label>Target name<input id="github-sync-name" value="${esc(draft?.name ?? target?.name ?? '')}" placeholder="Primary sync"></label><label>Repository<input id="github-sync-repository" value="${esc(draft?.repository ?? target?.repository ?? '')}" placeholder="https://github.com/owner/repository.git" oninput="githubSyncAuthenticationChanged()"></label><label>Branch<input id="github-sync-branch" value="${esc(draft?.branch ?? target?.branch ?? 'main')}" placeholder="main"></label><section class="github-sync-auth"><div class="github-sync-auth-grid"><label>GitHub account<input id="github-sync-expected-login" value="${esc(authentication.expectedLogin || '')}" placeholder="GitHub login" oninput="githubSyncAuthenticationChanged()"></label><label>SSH identity<div class="github-sync-identity-control"><input id="github-sync-identity-file" value="${esc(authentication.identityFile || '')}" placeholder="~/.ssh/id_ed25519" oninput="githubSyncAuthenticationChanged()"><button class="icon-btn" onclick="githubSyncPickIdentity(this)" title="Select SSH key" aria-label="Select SSH key">${uiIcon('folder-opened')}</button><button class="icon-btn" data-pending-label="…" onclick="githubSyncCreateIdentity(this)" title="Create dedicated SSH key" aria-label="Create dedicated SSH key">${uiIcon('add')}</button></div></label><button class="pk-button github-sync-test-auth" data-pending-label="Testing…" onclick="githubSyncTestAuthentication(this)">${uiIcon('verified','Test Account')}</button></div>${authenticationStatus}</section></div></div><div class="sub-editor-pane ${githubSyncEditorTab === 'automation' ? 'active' : ''}"><div class="github-sync-automation"><label class="github-sync-check"><input id="github-sync-automation-enabled" type="checkbox" ${automation.enabled ? 'checked' : ''} ${automaticReady ? '' : 'disabled'}><span><strong>Automatic synchronization</strong><small>${automaticReady ? 'Pull and push non-conflicting changes in the background.' : 'Run Initial Sync successfully, resolve every conflict, and finish the push before enabling this manually.'}</small></span></label><label>Sync interval (minutes)<input id="github-sync-interval-minutes" type="number" min="1" max="1440" step="1" required value="${esc(automation.intervalMinutes)}" oninput="this.setCustomValidity('')"><small>Check this Target on this schedule; changes inside the interval are coalesced.</small></label><label class="github-sync-check"><input id="github-sync-on-change" type="checkbox" ${automation.syncOnChange ? 'checked' : ''}><span><strong>Sync when selected content changes</strong><small>Changes inside the sync interval are coalesced. Unchanged checks do not create commits.</small></span></label><label>Conflict resolution<select id="github-sync-conflict-resolution"><option value="manual" ${conflictResolution === 'manual' ? 'selected' : ''}>Manual review · explicit choice for every file</option><option value="agent" ${conflictResolution === 'agent' ? 'selected' : ''}>Agent-assisted Skill/Recipe merge · review before push</option></select><small>Conflicts always stop the push. Choose this machine, choose GitHub, edit a combined copy, or ask the Agent; approval is still required.</small></label><p>VS Code GitHub Authentication is recommended for unattended HTTPS synchronization and keeps personal and EMU credentials separate per Target. Saving a new Target does not start synchronization. Run Initial Sync manually, resolve and push any conflicts, then return here to enable automation.</p></div></div><div class="sub-editor-pane ${githubSyncEditorTab === 'content' ? 'active' : ''}"><div class="github-sync-privacy-grid"><section><div class="github-sync-privacy-head public"><span class="codicon codicon-globe"></span><strong>Public</strong></div>${githubSyncPrivacyTree(target, 'public')}</section><section><div class="github-sync-privacy-head private"><span class="codicon codicon-lock"></span><strong>Private</strong></div>${githubSyncPrivacyTree(target, 'private')}</section></div></div><div class="sub-editor-actions"><span class="sub-action-spacer"></span><button class="pk-button" onclick="githubSyncClose()">Cancel</button><button class="pk-button primary" data-pending-label="Saving…" onclick="githubSyncSave(this)">Save Target</button></div></div>`;
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
  const labels = {
    'authoritative-migration':'Migration authority',
    'force-local-authority':'Force local authority',
    'built-in-authority':'Built-in authority',
    'identical-convergence':'Identical convergence',
    'move-edit':'Move + edit',
    'deterministic-three-way':'Three-way merge',
    'remote-only':'Remote-only pull',
    'local-only':'Local-only push',
    'unchanged':'Unchanged',
  };
  const rules = Object.entries(report?.rules || {})
    .filter(([rule, count]) => rule !== 'human-required' && count > 0)
    .map(([rule, count]) => ({ rule, label:labels[rule] || rule, count, kind:'automatic' }));
  const agent = files.filter(file => file.candidateSource === 'agent').length;
  const human = files.filter(file => file.candidateSource !== 'agent').length;
  if (agent) rules.push({ rule:'agent-prepared', label:'Agent prepared', count:agent, kind:'agent' });
  if (human) rules.push({ rule:'human-required', label:'Human decision', count:human, kind:'human' });
  const total = Math.max(report?.totalFiles || 0, rules.reduce((sum, item) => sum + item.count, 0));
  const automatic = rules.filter(item => item.kind === 'automatic').reduce((sum, item) => sum + item.count, 0);
  const humanRequired = agent + human;
  const detail = report?.generatedAt
    ? `${total} files · last reconciliation ${new Date(report.generatedAt).toLocaleString()}`
    : 'No reconciliation recorded yet';
  return `<section class="github-sync-resolution-diagram" onclick="event.stopPropagation()"><header><span><strong>Resolution flow</strong><small>${esc(detail)}</small></span></header><div class="github-sync-resolution-flow"><span><b>${total}</b><small>Observed</small></span><i>→</i><span class="automatic"><b>${automatic}</b><small>Rules resolved</small></span><i>→</i><span class="agent"><b>${agent}</b><small>Agent prepared</small></span><i>→</i><span class="human"><b>${humanRequired}</b><small>Human Final Review</small></span></div></section>`;
}

function githubSyncConflictPanel(targetId, conflict) {
  const sourceLabels = {
    unresolved:'Choice required',
    local:'This machine',
    remote:'GitHub',
    delete:'Delete GitHub',
    base:'Common base',
    manual:'Edited copy',
    agent:'Agent merge'
  };
  const conflictFiles = conflict.files || [];
  const files = conflictFiles.map(file => {
    const encodedPath = encodeURIComponent(file.path);
    const canAgent = file.type === 'skills' || file.type === 'recipes';
    const canDeleteRemote = file.hasBase && !file.hasLocal && file.hasRemote;
    const review = file.agentReview;
    const agentReview = review ? `<section class="github-sync-agent-review"><strong>${review.accuracyRisk ? 'Accuracy review required' : 'Human Final Review required'}</strong><p>Confidence ${Math.round(review.confidence * 100)}% · ${review.decisions.length} decisions · ${review.evidence.length} evidence items</p>${review.unresolvedConflicts.length ? `<p>Unresolved: ${esc(review.unresolvedConflicts.join(' · '))}</p>` : ''}${review.introducedContent.length ? `<p>Introduced content: ${esc(review.introducedContent.join(' · '))}</p>` : ''}</section>` : '';
    return `<article class="github-sync-conflict-file ${file.candidateSource === 'unresolved' ? 'unresolved' : 'resolved'}"><header><span><strong>${esc(file.path)}</strong><small>${esc(githubSyncLabels[file.type] || file.type)}</small></span><b>${esc(sourceLabels[file.candidateSource] || file.candidateSource)}</b></header>${file.rationale ? `<p>${esc(file.rationale)}</p>` : ''}${agentReview}<div><button class="pk-button" onclick="githubSyncConflictOpen('${esc(targetId)}',decodeURIComponent('${encodedPath}'),'compare',this)">Compare</button>${file.hasLocal ? `<button class="pk-button" onclick="githubSyncConflictChoose('${esc(targetId)}',decodeURIComponent('${encodedPath}'),'local',this)">Use this machine</button>` : ''}${file.hasRemote ? `<button class="pk-button" onclick="githubSyncConflictChoose('${esc(targetId)}',decodeURIComponent('${encodedPath}'),'remote',this)">Use GitHub</button>` : ''}${canDeleteRemote ? `<button class="pk-button danger" data-pending-label="Selecting…" onclick="githubSyncConflictDelete('${esc(targetId)}',decodeURIComponent('${encodedPath}'),this)">Delete GitHub</button>` : ''}${file.hasBase ? `<button class="pk-button" onclick="githubSyncConflictChoose('${esc(targetId)}',decodeURIComponent('${encodedPath}'),'base',this)">Use common base</button>` : ''}<button class="pk-button" onclick="githubSyncConflictOpen('${esc(targetId)}',decodeURIComponent('${encodedPath}'),'edit',this)">Edit combined copy</button><button class="pk-button" onclick="githubSyncConflictValidate('${esc(targetId)}',decodeURIComponent('${encodedPath}'),this)">Validate edited copy</button>${canAgent ? `<button class="pk-button" data-pending-label="Merging…" onclick="githubSyncConflictAgent('${esc(targetId)}',decodeURIComponent('${encodedPath}'),this)">Merge with Agent</button>` : ''}</div></article>`;
  }).join('');
  const unresolved = conflictFiles.filter(file => file.candidateSource === 'unresolved').length;
  const unresolvedWithLocal = conflictFiles.filter(file => file.candidateSource === 'unresolved' && file.hasLocal).length;
  const unresolvedWithRemote = conflictFiles.filter(file => file.candidateSource === 'unresolved' && file.hasRemote).length;
  const unresolvedDeletions = conflictFiles.filter(file => file.candidateSource === 'unresolved' && file.hasBase && !file.hasLocal && file.hasRemote).length;
  const missingLocal = conflictFiles.filter(file => file.hasBase && !file.hasLocal && file.hasRemote).length;
  const missingRemote = conflictFiles.filter(file => file.hasBase && file.hasLocal && !file.hasRemote).length;
  const changedBoth = conflictFiles.length - missingLocal - missingRemote;
  const supportedByAgent = conflictFiles.filter(file => file.type === 'skills' || file.type === 'recipes').length;
  const summary = [
    missingLocal ? `${missingLocal} missing on this machine` : '',
    missingRemote ? `${missingRemote} missing on GitHub` : '',
    changedBoth ? `${changedBoth} changed on both sides` : ''
  ].filter(Boolean).join(' · ');
  const deletionGuidance = missingLocal
    ? ` ${missingLocal} file${missingLocal === 1 ? '' : 's'} have no machine-local copy. All Use GitHub restores them; Delete GitHub confirms the local deletion and removes them from the remote repository only after Apply resolutions & Sync.`
    : '';
  return `<div class="github-sync-conflict-actions" onclick="event.stopPropagation()"><strong>${conflictFiles.length} conflicting file${conflictFiles.length === 1 ? '' : 's'}</strong><p>${esc(summary)}. A missing-file conflict is a deletion safeguard, not necessarily a text merge. Nothing is pushed until every file has an explicit resolution.${esc(deletionGuidance)}</p>${githubSyncResolutionDiagram(conflict.resolutionReport, conflictFiles)}<div class="github-sync-conflict-bulk">${unresolvedWithRemote ? `<button class="pk-button" data-pending-label="Selecting…" onclick="githubSyncConflictChooseAll('${esc(targetId)}','remote',${unresolvedWithRemote},this)">All Use GitHub</button>` : ''}${unresolvedDeletions ? `<button class="pk-button danger" data-pending-label="Selecting…" onclick="githubSyncConflictDeleteAll('${esc(targetId)}',${unresolvedDeletions},this)">Delete GitHub</button>` : ''}${unresolvedWithLocal ? `<button class="pk-button" data-pending-label="Selecting…" onclick="githubSyncConflictChooseAll('${esc(targetId)}','local',${unresolvedWithLocal},this)">All Use This Machine</button>` : ''}${supportedByAgent ? `<button class="pk-button" data-pending-label="Merging…" onclick="githubSyncConflictAgentAll('${esc(targetId)}',${supportedByAgent},this)">Ask Agent for ${supportedByAgent} supported</button>` : ''}</div><div class="github-sync-conflict-files">${files}</div><footer><span>${unresolved ? `${unresolved} still need a choice` : 'All files have a candidate ready for approval'}</span><button class="pk-button primary" data-pending-label="Applying…" onclick="githubSyncConflictAccept('${esc(targetId)}',this)" ${unresolved ? 'disabled' : ''}>Apply resolutions &amp; Sync</button><button class="pk-button" onclick="githubSyncConflictDiscard('${esc(targetId)}')">Cancel resolution workspace</button></footer></div>`;
}

function githubSyncCards() {
  const gitPhaseLabels = {
    'scheduled':'Scheduled',
    'waiting-for-lock':'Waiting for Git lock',
    'authenticating':'Authenticating',
    'fetch':'Fetch / Pull',
    'resolve-conflicts':'Resolve conflicts',
    'commit':'Commit',
    'push':'Push',
    'refresh-index':'Refresh PKM index',
  };
  const cards = githubSyncData.targets.map(target => {
    const expanded = githubSyncEditing === target.id;
    const last = target.lastSync?.at ? new Date(target.lastSync.at).toLocaleString() : 'Never synchronized';
    const runtime = githubSyncData.runtime?.[target.id] || {};
    const automaticReady = !!target.automation?.initialSyncCompleted;
    const conflict = githubSyncData.conflicts?.[target.id];
    const migration = githubSyncData.migrations?.[target.id];
    const phase = conflict ? 'resolve-conflicts' : runtime.phase || (runtime.status === 'scheduled' ? 'scheduled' : '');
    const status = conflict ? 'conflicts' : runtime.status || (target.lastFailure ? 'error' : target.automation?.enabled && automaticReady ? 'scheduled' : 'paused');
    const phaseLabel = gitPhaseLabels[phase] || (status === 'paused' ? 'Auto sync off' : status);
    const statusLabel = status === 'error' ? `${phaseLabel} failed` : phaseLabel;
    const next = conflict ? 'Pull completed · resolve conflicts before commit and push' : runtime.detail || (!automaticReady ? 'Initial manual sync required before automation can be enabled' : runtime.nextSyncAt ? `Next fetch after ${new Date(runtime.nextSyncAt).toLocaleString()}` : target.automation?.enabled ? 'Scheduled to fetch remote changes' : 'Automatic pull/push is off');
    const error = status === 'error' ? runtime.lastError || target.lastFailure?.error || '' : '';
    const conflictActions = conflict ? githubSyncConflictPanel(target.id, conflict) : '';
    const resolutionDiagram = !conflict ? githubSyncResolutionDiagram(target.lastResolutionReport) : '';
    const forcePending = githubSyncForcePending.has(target.id);
    const syncLabel = conflict ? 'Resolve conflicts below' : forcePending ? 'Sync queued' : 'Sync with Remote';
    const scheduleLabel = target.automation?.enabled && automaticReady ? `every ${target.automation?.intervalMinutes || 5} min` : 'manual only';
    const autoEnabled = !!target.automation?.enabled && automaticReady;
    const migrationReady = !target.publication || !!target.publication.manualVerificationCompleted;
    const autoDisabled = !automaticReady || !migrationReady || status === 'syncing' || !!conflict;
    const autoTitle = !automaticReady ? 'Run Initial Sync successfully before enabling Auto Sync'
      : !migrationReady ? 'Complete the required manual publication verification before enabling Auto Sync'
      : conflict ? 'Resolve every conflict before enabling Auto Sync'
      : status === 'syncing' ? 'Wait for the current synchronization to finish'
      : autoEnabled ? 'Turn off automatic synchronization' : 'Turn on automatic synchronization';
    const autoToggle = `<button class="github-sync-auto-toggle ${autoEnabled ? 'on' : ''}" role="switch" aria-checked="${autoEnabled}" aria-label="Auto Sync for ${esc(target.name)}" title="${esc(autoTitle)}" onclick="event.stopPropagation();githubSyncAutomationToggle('${esc(target.id)}',${autoEnabled ? 'false' : 'true'},this)" ${autoDisabled ? 'disabled' : ''}><span></span><em>Auto</em></button>`;
    const migrationCompleted = migration?.phase === 'cutover' && target.publication?.manualVerificationCompleted;
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
    return `<article class="pk-card sub-broker-card ${expanded ? 'active' : ''}"><div class="sub-broker-row" role="button" tabindex="0" aria-expanded="${expanded}" onclick="githubSyncEdit('${esc(target.id)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();githubSyncEdit('${esc(target.id)}')}"><span><span class="sub-broker-title"><strong>${esc(target.name)}</strong><span class="github-sync-status ${esc(status)}">${esc(statusLabel)}</span><span class="sub-broker-actions"><button class="pk-button" data-pending-label="Pulling…" onclick="event.stopPropagation();githubSyncForce('${esc(target.id)}',this)" ${status === 'syncing' || forcePending || conflict || (migration && !['cutover','rolled-back'].includes(migration.phase)) ? 'disabled' : ''}>${uiIcon('refresh',syncLabel)}</button><button class="pk-button danger" data-pending-label="Forcing…" onclick="event.stopPropagation();githubSyncForceUpdate('${esc(target.id)}',this)" ${status === 'syncing' || forcePending || (migration && !['cutover','rolled-back'].includes(migration.phase)) ? 'disabled' : ''}>Force Update</button><button class="pk-button" data-pending-label="Loading…" onclick="event.stopPropagation();githubSyncRestore('${esc(target.id)}',this)">${uiIcon('history','Restore snapshot…')}</button><button class="pk-button danger" onclick="event.stopPropagation();githubSyncDelete('${esc(target.id)}')" title="Delete target">${uiIcon('trash')}</button></span></span><small>${esc(target.repository)}</small>${error ? `<small class="github-sync-error" onclick="event.stopPropagation()" onpointerdown="event.stopPropagation()" title="Select and copy this error">${esc(error)}</small>` : ''}${conflictActions}${resolutionDiagram}${migrationPanel}</span><span class="sub-broker-meta"><span class="github-sync-meta-head"><b>${esc(target.branch)} · ${esc(scheduleLabel)}</b>${autoToggle}</span><small>Last ${esc(last)}</small><small>${esc(next)}</small><i>›</i></span></div>${expanded ? `<div class="sub-broker-expanded">${githubSyncEditor()}</div>` : ''}</article>`;
  }).join('');
  const create = githubSyncEditing === 'new' ? `<article class="pk-card sub-broker-card active"><div class="sub-broker-expanded">${githubSyncEditor()}</div></article>` : '';
  return cards + create || '<div class="sub-empty">No GitHub targets.</div>';
}

function renderGitHubSyncPane() {
  document.getElementById('detail').innerHTML = `<div class="sub-dashboard github-sync-dashboard"><header class="sub-head"><div><h2>GitHub Sync</h2><p>${githubSyncData.targets.length} configured targets</p></div><div class="project-header-actions"><button class="recipe-icon-button" title="Refresh GitHub Sync" aria-label="Refresh GitHub Sync" onclick="ask('githubSyncState',{})"><span class="codicon codicon-refresh"></span></button><button class="pk-button primary" onclick="githubSyncNew()">${uiIcon('add','Target')}</button></div></header><section class="sub-band"><div class="pk-list sub-broker-list">${githubSyncCards()}</div></section></div>`;
  githubSyncRenderAuthenticationMethod();
  githubSyncSyncFolderStates();
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
function githubSyncOnRuntimeState(data) { if (!data?.targetId) return; githubSyncData.runtime = { ...(githubSyncData.runtime || {}), [data.targetId]:data.state || {} }; if (data.state?.status !== 'syncing') githubSyncForcePending.delete(data.targetId); if (state.tab === 'githubSync') renderGitHubSyncPane(); }
function githubSyncOnRunQueued(data) { if (!data?.targetId) return; if (!data.queued) githubSyncForcePending.delete(data.targetId); if (state.tab === 'githubSync') renderGitHubSyncPane(); vscode.postMessage({ command:'toast', text:data.queued ? 'GitHub sync queued' : 'GitHub sync is already queued or running' }); }
function githubSyncDelete(targetId) { const target = githubSyncData.targets.find(item => item.id === targetId); pkModal({ title:'Delete GitHub Target?', message:`${target?.name || targetId}\n\nStops future pull/push operations and removes the local target configuration immediately. Local checkout cleanup continues in the background if Git still holds Windows file handles. The GitHub repository and Knowledge Root content are not deleted. An already-started push may still finish.`, okLabel:'Delete Target', danger:true, onOk:()=>ask('githubSyncDelete',{targetId}) }); }
function githubSyncForce(targetId, button) { if (githubSyncForcePending.has(targetId) || pendingActionButtons.has('githubSyncRun')) return; githubSyncForcePending.add(targetId); ask('githubSyncRun', { targetId }, button); }
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
function githubSyncAutomationToggle(targetId, enabled, button) { ask('githubSyncAutomationToggle', { targetId, enabled }, button); }
function githubSyncMigration(targetId, action, button) { ask('githubSyncMigration', { targetId, action }, button); }
function githubSyncRestore(targetId, button) { ask('githubSyncRestore', { targetId }, button); }
function githubSyncConflictOpen(targetId, path, mode, button) { ask('githubSyncConflictOpen', { targetId, path, mode }, button); }
function githubSyncConflictChoose(targetId, path, source, button) { ask('githubSyncConflictChoose', { targetId, path, source }, button); }
function githubSyncConflictChooseAll(targetId, source, count, button) {
  const label = source === 'remote' ? 'GitHub' : 'this machine';
  pkModal({ title:`Use ${label} for all conflicts?`, message:`Prepare the ${label} version for every conflict where it exists (${count} currently unresolved). This only stages candidates; review and Apply resolutions & Sync are still required.`, okLabel:`Use ${label} for all`, onOk:()=>ask('githubSyncConflictChooseAll',{targetId,source},button) });
}
function githubSyncConflictDelete(targetId, path, button) {
  pkModal({ title:'Delete this file from GitHub?', message:`The file is already missing on this machine. Confirm its deletion from GitHub when you later choose Apply resolutions & Sync.\n\n${path}`, okLabel:'Delete GitHub', danger:true, onOk:()=>ask('githubSyncConflictDelete',{targetId,path},button) });
}
function githubSyncConflictDeleteAll(targetId, count, button) {
  pkModal({ title:`Delete ${count} files from GitHub?`, message:'These files are already missing on this machine. Their deletion will be recorded explicitly and pushed to GitHub only after you choose Apply resolutions & Sync. This does not delete any additional local files.', okLabel:'Delete GitHub', danger:true, onOk:()=>ask('githubSyncConflictDeleteAll',{targetId},button) });
}
function githubSyncConflictValidate(targetId, path, button) { ask('githubSyncConflictValidate', { targetId, path }, button); }
function githubSyncConflictAgent(targetId, path, button) { ask('githubSyncConflictAgent', { targetId, path }, button); }
function githubSyncConflictAgentAll(targetId, count, button) { pkModal({ title:'Ask Agent to merge supported conflicts?', message:`Prepare Agent merge candidates for ${count} Skill/Recipe conflicts. Unsupported or unsafe conflicts remain unresolved for explicit review.`, okLabel:'Merge supported conflicts', onOk:()=>ask('githubSyncConflictAgentAll',{targetId},button) }); }
function githubSyncConflictAccept(targetId, button) { pkModal({ title:'Apply resolved files and sync?', message:'Each selected or edited candidate will replace the local file, pass structural validation, and then run a manual pull/push. Automatic synchronization remains off until that sync succeeds and you enable it yourself.', okLabel:'Apply & Sync', onOk:()=>ask('githubSyncConflictAccept',{targetId},button) }); }
function githubSyncConflictDiscard(targetId) { pkModal({ title:'Cancel this resolution workspace?', message:'Only the staged resolution choices are deleted. Files on this machine and GitHub are unchanged, and the same conflicts will be detected by the next manual sync.', okLabel:'Cancel workspace', danger:true, onOk:()=>ask('githubSyncConflictDiscard',{targetId}) }); }
