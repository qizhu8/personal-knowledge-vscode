// ── Init ───────────────────────────────────────────────────────────────────
ask('ready', {});                              // tell the extension the webview is loaded
const restoredUiState = vscode.getState() || {};
const restoredWorkspace = workspaceSurfaces[restoredUiState.workspace] ? restoredUiState.workspace : workspaceForTab(restoredUiState.tab);
const restoredTab = workspaceSurfaces[restoredWorkspace]?.includes(restoredUiState.tab)
  ? restoredUiState.tab
  : workspaceDefaultSurface[restoredWorkspace] || 'skills';
const restoredButton = document.querySelector(`.tab[data-tab="${restoredTab}"]`);
if (restoredButton) restoredButton.dispatchEvent(new MouseEvent('click'));
else ask('list', { tab:'skills', filter:'all', q:'' });
if (restoredTab !== 'githubSync') ask('githubSyncState', {}, null, true);

function retryInitialViewRequest() {
  if (['agentSessions','agentSnapshots','projects','recipes'].includes(state.tab)) ask('projectState', {});
  else if (state.tab === 'environments') ask('envList', {});
  else if (state.tab === 'servers') ask('serverList', {});
  else if (state.tab === 'subscriptions') ask('subscriptionState', {});
  else if (state.tab === 'githubSync') ask('githubSyncState', {});
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
