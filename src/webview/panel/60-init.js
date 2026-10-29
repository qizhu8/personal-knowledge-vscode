// ── Init ───────────────────────────────────────────────────────────────────
ask('ready', {});                              // tell the extension the webview is loaded
let lastMarkdownDraftOpen;
const markdownDraftObserver = new MutationObserver(() => {
  const busy = markdownAssetDraftOpen();
  if (busy !== lastMarkdownDraftOpen) {
    lastMarkdownDraftOpen = busy;
    ask('markdownDraftState', { busy }, null, true);
  }
});
markdownDraftObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
void loadMarkdownLibraries();                  // markdown assets are not on the first-paint critical path
const restoredUiState = vscode.getState() || {};
const restoredWorkspace = restoredUiState.tab === 'userProfile' ? 'automation'
  : workspaceSurfaces[restoredUiState.workspace] ? restoredUiState.workspace : workspaceForTab(restoredUiState.tab);
const restoredTab = workspaceSurfaces[restoredWorkspace]?.includes(restoredUiState.tab)
  ? restoredUiState.tab
  : workspaceDefaultSurface[restoredWorkspace] || 'skills';
const restoredButton = document.querySelector(`.tab[data-tab="${restoredTab}"]`);
if (restoredButton) restoredButton.dispatchEvent(new MouseEvent('click'));
else ask('list', { tab:'skills', filter:'all', q:'' });

function retryInitialViewRequest() {
  if (['actions','actionLibrary'].includes(state.tab)) { embeddedActionViews[state.tab].pending = false; showEmbeddedActions(); }
  else if (['agentSessions','agentSnapshots','projects','recipes'].includes(state.tab)) ask('projectState', {});
  else if (state.tab === 'environments') ask('envList', {});
  else if (state.tab === 'servers') ask('serverList', {});
  else if (state.tab === 'subscriptions') ask('subscriptionState', {});
  else if (state.tab === 'githubSync') ask('githubSyncState', {});
  else if (state.tab === 'backgroundTasks') ask('backgroundTasks', {});
  else if (state.tab === 'userProfile') ask('userProfile', {});
  else if (state.tab === 'portalConnections') ask('portalConnections', {});
  else if (state.tab === 'chatroom') ask('chatState', {});
  else if (state.tab === 'mcp') ask('checkMcp', {});
  else if (state.tab === 'skillRouter') ask('skillRouterStatus', {});
  else ask('list', { tab:state.tab, filter:'all', q:'' });
}

// Safety: if the initial view has not received data after 8 s, retry its request once.
setTimeout(() => {
  const banner = document.getElementById('loading-banner');
  if (banner && !initialLoadComplete) {
    const sub = document.querySelector('.loading-sub');
    if (sub) sub.textContent = 'Still waiting for data from the extension… Retrying this view.';
    retryInitialViewRequest();
  }
}, 8000);

restorePanelViewState();
panelSnapshotRestoring = false;
if (panelRestoreState.view && cachedKnowledgeTabs.has(state.tab)) ask('list', { tab:state.tab, filter:state.filter, q:state.search });
capturePanelViewState();
