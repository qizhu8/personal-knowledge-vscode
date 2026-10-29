// UI snapshots contain data only; restoration never dispatches clicks or submits operations.
let panelSnapshotRestoring = true;
let panelRestoreActive = true;
const panelRestoreState = vscode.getState() || {};
const panelRestoreNavigation = panelRestoreState.navigation || {};
if (panelRestoreNavigation.projectRoute) projectRoute = { ...panelRestoreNavigation.projectRoute };
selectedAgentSessionId = panelRestoreNavigation.selectedAgentSessionId || selectedAgentSessionId;
selectedAgentSnapshotId = panelRestoreNavigation.selectedAgentSnapshotId || selectedAgentSnapshotId;
selectedRecipeId = panelRestoreNavigation.selectedRecipeId || selectedRecipeId;
recipeSearchQuery = panelRestoreNavigation.recipeSearchQuery || recipeSearchQuery;
recipeEditorMode = panelRestoreNavigation.recipeEditorMode || recipeEditorMode;
recipeDraft = panelRestoreNavigation.recipeDraft || recipeDraft;
recipeDraftRecipeId = panelRestoreNavigation.recipeDraftRecipeId || recipeDraftRecipeId;
recipeDraftBaseline = panelRestoreNavigation.recipeDraftBaseline || recipeDraftBaseline;
if (panelRestoreNavigation.chat) Object.assign(chat, panelRestoreNavigation.chat);
let panelRecipeBaseline = panelRestoreNavigation.recipeBaseline || null;
function panelRecipeRevision(recipeId) {
  if (!panelRecipeBaseline || panelRecipeBaseline.recipeId !== recipeDraftRecipeId) {
    const recipe = projectSnapshot?.recipes?.find(item => item.recipeId === recipeDraftRecipeId);
    panelRecipeBaseline = recipe ? { recipeId:recipe.recipeId, revision:recipe.revision } : null;
  }
  return panelRecipeBaseline?.recipeId === recipeId ? panelRecipeBaseline.revision : undefined;
}
const embeddedActionViews = { actions:{ frame:null, pending:false }, actionLibrary:{ frame:null, pending:false } };
let actionsSnapshotResolve;
let panelSnapshotLast = '';
let restoreDetailRequested = false;
const panelRestoredElements = new WeakSet();
function panelFormSnapshot() {
  const values = {};
  document.querySelectorAll('#detail input[id], #detail textarea[id], #detail select[id], #detail [contenteditable][id], #note-form input[id], #note-form textarea[id], #note-form select[id], #paper-form input[id], #paper-form textarea[id], #paper-form select[id]').forEach(element => {
    if (['password','file','button','submit'].includes(element.type)) return;
    values[element.id] = { value: element.isContentEditable ? element.textContent : element.value, checked: element.checked };
  });
  return values;
}
function capturePanelViewState() {
  if (panelSnapshotRestoring) return vscode.getState() || {};
  if (state.tab === 'chatroom') chatCaptureDraft();
  panelRecipeRevision(recipeDraftRecipeId);
  const snapshot = { ...(vscode.getState() || {}), tab:state.tab, workspace:state.workspace,
    navigation:{ projectRoute:{ ...projectRoute }, selectedAgentSessionId, selectedAgentSnapshotId, selectedRecipeId,
      recipeSearchQuery, recipeEditorMode, recipeDraft, recipeDraftRecipeId, recipeDraftBaseline,
      recipeBaseline:panelRecipeBaseline,
      chat:{ drafts:chat.drafts, activeKey:chat.activeKey, mode:chat.mode, discussionLead:chat.discussionLead,
        quote:chat.quote, manualRecipients:chat.manualRecipients, removedRecipients:chat.removedRecipients,
        followLatest:chat.followLatest, scrollPositions:chat.scrollPositions, scrollAnchors:chat.scrollAnchors } },
    view:{ filter:state.filter, search:state.search, selection:currentDetailRequest,
      active:state.active, selectedAgentSessionId,
      forms:panelFormSnapshot(), openForms:['note-form','paper-form'].filter(id=>!document.getElementById(id)?.classList.contains('hidden')),
      scroll:Object.fromEntries(['detail','item-list','sidebar'].map(id=>[id,document.getElementById(id)?.scrollTop || 0])) } };
  const serialized = JSON.stringify(snapshot);
  if (serialized !== panelSnapshotLast) { panelSnapshotLast = serialized; vscode.setState(snapshot); }
  return snapshot;
}
async function duplicatePkmTab() {
  const actionsFrame = embeddedActionViews[state.tab]?.frame;
  if (actionsFrame?.srcdoc) await new Promise(resolve => {
    actionsSnapshotResolve = resolve;
    setTimeout(() => { if (actionsSnapshotResolve === resolve) actionsSnapshotResolve = null; resolve(); }, 1000);
    actionsFrame.contentWindow.postMessage({ channel:'pkm-actions-control', command:'snapshot' }, '*');
  });
  vscode.postMessage({ command:'duplicatePanel', state:capturePanelViewState() });
}
function setEmbeddedActionsVisible(tab) { for (const [surface,view] of Object.entries(embeddedActionViews)) if (view.frame) view.frame.hidden = surface !== tab; }
function syncActionLibraryTheme() {
  const frame = embeddedActionViews.actionLibrary.frame;
  if (!frame?.contentWindow) return;
  const style = getComputedStyle(document.documentElement), variables = {};
  for (const name of ['editor-background','editor-foreground','sideBar-background','descriptionForeground','panel-border','focusBorder','font-size','font-family','input-background','input-foreground','list-hoverBackground','list-activeSelectionBackground','list-activeSelectionForeground','icon-foreground','editorWarning-foreground','testing-iconPassed','errorForeground']) {
    const key = '--vscode-' + name, value = style.getPropertyValue(key).trim();
    if (value) variables[key] = value;
  }
  frame.contentWindow.postMessage({ channel:'pkm-actions-theme', variables,
    colorScheme:document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light') ? 'light' : 'dark' }, '*');
}
const actionLibraryThemeObserver = new MutationObserver(syncActionLibraryTheme);
actionLibraryThemeObserver.observe(document.body, { attributes:true, attributeFilter:['class','style'] });
actionLibraryThemeObserver.observe(document.documentElement, { attributes:true, attributeFilter:['class','style'] });
function showEmbeddedActions() {
  const surface = state.tab === 'actionLibrary' ? 'actionLibrary' : 'actions', view = embeddedActionViews[surface];
  let actionsFrame = view.frame;
  if (!actionsFrame) {
    actionsFrame = document.createElement('iframe');
    actionsFrame.id = surface === 'actions' ? 'embedded-action-workbench' : 'embedded-action-library';
    actionsFrame.title = surface === 'actions' ? 'Action Workbench' : 'Action Library';
    // The renderer is isolated; only messages from this exact frame can reach its host bridge.
    actionsFrame.setAttribute('sandbox', 'allow-scripts allow-forms');
    actionsFrame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;z-index:5;background:var(--vscode-editor-background)';
    const layout = document.getElementById('layout');
    layout.style.position = 'relative';
    layout.appendChild(actionsFrame);
    view.frame = actionsFrame;
    if (surface === 'actionLibrary') actionsFrame.onload = syncActionLibraryTheme;
  }
  setEmbeddedActionsVisible(surface);
  if ((!actionsFrame.srcdoc || actionsFrame.dataset.unavailable) && !view.pending) {
    view.pending = true;
    ask('actionWorkbenchDocument', { surface, state:vscode.getState()?.[surface] || {} });
  }
  finishLoadingProgress();
}
window.addEventListener('message', event => {
  const message = event.data || {};
  if (message.channel === 'pkm-actions') {
    const surface = Object.keys(embeddedActionViews).find(key => embeddedActionViews[key].frame?.contentWindow === event.source);
    if (!surface) return;
    if (message.type === 'snapshot') {
      vscode.setState({ ...(vscode.getState() || {}), [surface]:message.state });
      actionsSnapshotResolve?.(); actionsSnapshotResolve = null;
    } else if (message.type === 'state') vscode.setState({ ...(vscode.getState() || {}), [surface]:message.state });
    else if (message.type === 'request') vscode.postMessage({ command:'actionWorkbenchRequest', surface, message:message.message });
    return;
  }
  if (message.command === 'panelEditBaseline') {
    const snapshot = vscode.getState() || {};
    vscode.setState({ ...snapshot, editRevisions:{ ...(snapshot.editRevisions || {}), [message.identity]:message.revision } });
  } else if (message.command === 'actionWorkbenchDocument' && embeddedActionViews[message.surface || 'actions']?.frame) {
    const view = embeddedActionViews[message.surface || 'actions'], actionsFrame = view.frame;
    view.pending = false;
    if (message.html) { delete actionsFrame.dataset.unavailable; actionsFrame.srcdoc = message.html; }
    else {
      actionsFrame.dataset.unavailable = '1';
      actionsFrame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none';"><p>${esc(message.error || 'Actions are unavailable.')}</p>`;
    }
  } else if (message.command === 'actionWorkbenchReply') embeddedActionViews[message.surface || 'actions']?.frame?.contentWindow.postMessage(message.message, '*');
  else if (message.command === 'duplicatePanelSnapshot') duplicatePkmTab();
  else if (message.command === 'openEmbeddedActionLibrary') {
    if (embeddedActionViews.actionLibrary.frame) embeddedActionViews.actionLibrary.frame.srcdoc = '';
    document.querySelector('.tab[data-tab="actionLibrary"]')?.click();
  }
  else if (message.command === 'openEmbeddedActions') {
    vscode.setState({ ...(vscode.getState() || {}), actions:message.state });
    // An explicit Run/Action link replaces only this instance's renderer; ordinary view switching retains it.
    if (embeddedActionViews.actions.frame) embeddedActionViews.actions.frame.srcdoc = '';
    document.querySelector('.tab[data-tab="actions"]')?.click();
  } else if (message.command === 'panelVisible') {
    // Keep the live DOM and drafts; fetch missed changes silently after the existing view is visible.
    if (cachedKnowledgeTabs.has(state.tab)) ask('list', { tab:state.tab, filter:state.filter, q:state.search }, null, true);
    else if (['projects','agentSessions','agentSnapshots','recipes'].includes(state.tab)) ask('projectState', {}, null, true);
    else if (state.tab === 'githubSync') {
      ask('githubSyncRuntimeSnapshot', {}, null, true);
      ask('githubSyncState', {}, null, true);
    } else {
      const command = { subscriptions:'subscriptionState', servers:'serverList', environments:'envList', mcp:'checkMcp',
        userProfile:'userProfile', skillRouter:'skillRouterStatus', backgroundTasks:'backgroundTasks', portalConnections:'portalConnections', chatroom:'chatState' }[state.tab];
      if (command) ask(command, {}, null, true);
    }
  } else if (message.command === 'sharedDataChanged') {
    cachedKnowledgeTabs.forEach(invalidateKnowledgeTabView);
    projectSnapshotDirty = true;
    if (['projects','agentSessions','agentSnapshots','recipes'].includes(state.tab)) ask('projectState', {}, null, true);
    // Keep open editors/drafts intact. Refresh lists; stale saves are rejected by the host.
    if (cachedKnowledgeTabs.has(state.tab)) ask('list', { tab:state.tab, filter:state.filter, q:state.search }, null, true);
  }
  if (panelRestoreActive && ['detail','list','projectState'].includes(message.command)) setTimeout(() => {
    if (!panelRestoreActive) return;
    if (message.command === 'detail') {
      const forms = panelRestoreState.view?.forms || {};
      if (forms['se-content']) startEditSkill();
      else if (forms['se-script']) startEditScript();
    }
    restorePanelViewState();
  }, 0);
});
function restorePanelViewState() {
  const view = panelRestoreState.view;
  if (!panelRestoreActive || !view || state.tab !== panelRestoreState.tab) return;
  state.filter = view.filter || 'all'; state.search = view.search || ''; state.active = view.active;
  document.getElementById('searchbox').value = state.search;
  if (view.selectedAgentSessionId) selectedAgentSessionId = view.selectedAgentSessionId;
  if (view.selection && !restoreDetailRequested) {
    restoreDetailRequested = true;
    ask('detail', { ...view.selection });
  }
  for (const id of view.openForms || []) document.getElementById(id)?.classList.remove('hidden');
  for (const [id, value] of Object.entries(view.forms || {})) {
    const element = document.getElementById(id);
    if (!element || panelRestoredElements.has(element)) continue;
    if (element.isContentEditable) element.textContent = value.value;
    else element.value = value.value;
    if (typeof value.checked === 'boolean') element.checked = value.checked;
    panelRestoredElements.add(element);
  }
  for (const [id, top] of Object.entries(view.scroll || {})) {
    const element = document.getElementById(id); if (element) element.scrollTop = top;
  }
}
setInterval(capturePanelViewState, 1000);
window.addEventListener('pagehide', capturePanelViewState);
document.addEventListener('input', () => { panelRestoreActive = false; if (!panelSnapshotRestoring) capturePanelViewState(); });
document.addEventListener('scroll', () => { if (!panelSnapshotRestoring) capturePanelViewState(); }, true);

document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', event => { if (event.isTrusted) panelRestoreActive = false; }));
document.addEventListener('pointerdown', event => { if (event.isTrusted) panelRestoreActive = false; }, true);
