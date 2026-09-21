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

// Safety: if no response after 8 s, DB is still initializing — retry automatically
setTimeout(() => {
  const banner = document.getElementById('loading-banner');
  if (banner && !initialLoadComplete) {
    // Update the subtitle to tell user what's happening
    const sub = document.querySelector('.loading-sub');
    if (sub) sub.textContent = 'Database is initializing, retrying…';
    // Retry the list request after another 3 s
    setTimeout(() => state.tab === 'agentSessions' ? renderAgentSessions() : ['projects','recipes'].includes(state.tab) ? ask('projectState', {}) : ask('list', { tab:state.tab, filter:'all', q:'' }), 3000);
  }
}, 8000);
