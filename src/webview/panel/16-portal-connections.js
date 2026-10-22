let portalConnectionSnapshot = null;

function portalConnectionTime(value, now = Date.now()) {
  if (!Number.isFinite(value)) return '';
  const minutes = Math.round((now - value) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(value).toLocaleDateString();
}

function portalConnectionStateLabel(item) {
  if (item.state === 'active') return 'Active';
  if (item.state === 'reconnecting') return 'Reconnecting';
  if (item.state === 'elsewhere') return 'Open in another window (not verified here)';
  return item.resumable ? 'Ended · re-attach available' : 'Ended';
}

function portalConnectionRow(item) {
  const controller = item.role === 'controller';
  const peer = item.peerMachine || item.peerName || 'peer';
  const local = `<span class="portal-connection-side"><strong>${esc(item.localMachine || 'This machine')}</strong><span>${esc(item.chatLabel)}${item.external ? ' · external' : ''}</span></span>`;
  const remote = `<span class="portal-connection-side"><strong>${esc(peer)}</strong><span>${esc(item.peerChatName || item.peerName || '')}</span></span>`;
  const arrow = `<span class="portal-connection-arrow" title="${controller ? 'This Chat controls the peer' : 'The peer controls this Chat'}"><span class="codicon codicon-arrow-${controller ? 'right' : 'left'}" aria-hidden="true"></span><span>${controller ? 'controls' : 'controlled by'}</span></span>`;
  const times = item.state === 'ended'
    ? `Paired ${esc(portalConnectionTime(item.connectedAt))} · ended ${esc(portalConnectionTime(item.endedAt || item.lastSeenAt))}`
    : `Paired ${esc(portalConnectionTime(item.connectedAt))} · seen ${esc(portalConnectionTime(item.lastSeenAt))}`;
  return `<article class="portal-connection-row ${esc(item.state)}" role="listitem" data-pair-id="${esc(item.pairId)}">
    <span class="portal-connection-icon codicon codicon-${item.state === 'ended' ? 'debug-disconnect' : 'remote'}" aria-hidden="true"></span>
    <div class="portal-connection-copy">
      <div class="portal-connection-title">${local}${arrow}${remote}<span class="portal-connection-status"><i></i>${esc(portalConnectionStateLabel(item))}</span></div>
      <div class="portal-connection-detail">${times}${item.endpoint ? ` · ${esc(item.endpoint)}` : ''}</div>
    </div>
    <div class="portal-connection-actions">
      <button type="button" class="secondary" onclick="ask('portalConnectionOpenChat', { chatId:${esc(JSON.stringify(item.chatId))} })" title="Open the local Chat that owns this Portal">Open Chat</button>
      ${item.state === 'ended' ? `<button type="button" class="secondary" onclick="ask('portalConnectionForget', { pairId:${esc(JSON.stringify(item.pairId))} })" title="Remove this ended connection from the history">Remove</button>` : ''}
    </div>
  </article>`;
}

function portalPendingInvitationRow(item) {
  return `<article class="portal-connection-row" role="listitem">
    <span class="portal-connection-icon codicon codicon-link" aria-hidden="true"></span>
    <div class="portal-connection-copy"><strong>${esc(item.chatLabel)}</strong>
      <div class="portal-connection-detail">Awaiting peer · ${esc(item.role)} · expires ${esc(new Date(item.expiresAt).toLocaleTimeString())} · ${esc(item.endpoint)}</div>
    </div>
    <div class="portal-connection-actions"><button type="button" class="secondary" onclick="ask('portalConnectionCopyMagicLink', { chatId:${esc(JSON.stringify(item.chatId))} })" title="Copy the unredeemed one-time Portal magic link to the clipboard">Copy magic link</button></div>
  </article>`;
}

function renderPortalConnections() {
  const detail = document.getElementById('detail');
  if (!detail) return;
  const connections = Array.isArray(portalConnectionSnapshot?.connections) ? portalConnectionSnapshot.connections : [];
  const live = connections.filter(item => item.state !== 'ended');
  const past = connections.filter(item => item.state === 'ended');
  const pending = (portalConnectionSnapshot?.pendingInvitations || []).filter(item => item.expiresAt > Date.now());
  detail.style.padding = '0';
  detail.style.overflow = 'auto';
  const list = (items, empty) => items.length
    ? `<div class="portal-connection-list" role="list">${items.map(portalConnectionRow).join('')}</div>`
    : `<div class="portal-connection-empty">${esc(empty)}</div>`;
  detail.innerHTML = `<section class="portal-connections-workspace">
    <header class="portal-connections-head">
      <div><h2>Portal Connections</h2><p>Named PKM Portal pairings on this machine: who is connected to whom, and which are still live.</p></div>
      <div class="portal-connections-head-actions"><span class="portal-connection-total">${live.filter(item => item.state === 'active').length} active</span>
      <button type="button" class="secondary" onclick="ask('portalConnections', {})" title="Refresh Portal connections" aria-label="Refresh Portal connections"><span class="codicon codicon-refresh" aria-hidden="true"></span></button></div>
    </header>
    ${pending.length ? `<h3 class="portal-connections-section">Awaiting peer</h3><div class="portal-connection-list" role="list">${pending.map(portalPendingInvitationRow).join('')}</div>` : ''}
    <h3 class="portal-connections-section">Live</h3>
    ${list(live, 'No Portal is connected right now. Open a Portal from a PKM Chat toolbar or the portal_control MCP tool.')}
    <h3 class="portal-connections-section">History</h3>
    ${list(past, 'No past Portal connections are recorded.')}
  </section>`;
}

function showPortalConnectionsTab() {
  if (portalConnectionSnapshot) renderPortalConnections();
  else document.getElementById('detail').innerHTML = '<div class="empty">Loading Portal connections…</div>';
  ask('portalConnections', {});
}

function portalConnectionsOnSnapshot(snapshot) {
  portalConnectionSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : { updatedAt: 0, active: 0, connections: [] };
  if (state.tab === 'portalConnections') renderPortalConnections();
}
