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

function portalConnectionAttribute(value) {
  return esc(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function portalConnectionButton(command, key, value, label, title) {
  return `<button type="button" class="pk-button" data-portal-command="${command}" data-portal-key="${key}" data-portal-value="${portalConnectionAttribute(value)}" title="${portalConnectionAttribute(title)}">${esc(label)}</button>`;
}

function portalConnectionGroups(connections) {
  const groups = new Map();
  const priority = { active:0, reconnecting:1, elsewhere:2, ended:3 };
  for (const item of connections) {
    const group = groups.get(item.pairId);
    if (!group) groups.set(item.pairId, { ...item, members:[item] });
    else {
      group.members.push(item);
      group.resumable ||= item.resumable;
      if (priority[item.state] < priority[group.state]) group.state = item.state;
      group.lastSeenAt = Math.max(group.lastSeenAt, item.lastSeenAt);
    }
  }
  return [...groups.values()];
}

function portalConnectionSide(role, local, peer) {
  const machine = local?.localMachine || peer?.peerMachine || peer?.peerName || '';
  const label = local?.chatLabel || peer?.peerChatName || peer?.peerName || '';
  return `<span class="portal-connection-side" data-portal-role="${role}"><small>${role === 'controlled' ? 'Controlled' : 'Controller'}</small><strong>${esc(machine || (local ? 'This machine' : 'Awaiting peer'))}</strong><span>${esc(label)}${local?.external ? ' · external' : ''}</span>${local ? portalConnectionButton('portalConnectionOpenChat', 'chatId', local.chatId, 'Open Chat', 'Open this local Chat') : ''}</span>`;
}

function portalConnectionRow(item) {
  const controlled = item.members.find(member => member.role === 'controlled');
  const controller = item.members.find(member => member.role === 'controller');
  const left = portalConnectionSide('controlled', controlled, controller);
  const right = portalConnectionSide('controller', controller, controlled);
  const arrow = '<span class="portal-connection-arrow" title="Controller controls the left side"><span class="codicon codicon-arrow-left" aria-hidden="true"></span></span>';
  const times = item.state === 'ended'
    ? `Paired ${esc(portalConnectionTime(item.connectedAt))} · ended ${esc(portalConnectionTime(item.endedAt || item.lastSeenAt))}`
    : `Paired ${esc(portalConnectionTime(item.connectedAt))} · seen ${esc(portalConnectionTime(item.lastSeenAt))}`;
  return `<article class="portal-connection-row ${esc(item.state)}" role="listitem" data-pair-id="${portalConnectionAttribute(item.pairId)}">
    <span class="portal-connection-icon codicon codicon-${item.state === 'ended' ? 'debug-disconnect' : 'remote'}" aria-hidden="true"></span>
    <div class="portal-connection-copy">
      <div class="portal-connection-title">${left}${arrow}${right}</div>
      <span class="portal-connection-status"><i></i>${esc(portalConnectionStateLabel(item))}</span>
      <div class="portal-connection-detail">${times}${item.endpoint ? ` · ${esc(item.endpoint)}` : ''}</div>
    </div>
    <div class="portal-connection-actions">
      ${item.state === 'ended' ? portalConnectionButton('portalConnectionForget', 'pairId', item.pairId, 'Remove', 'Remove this ended pairing from history') : ''}
    </div>
  </article>`;
}

function portalPendingInvitationRow(item) {
  return `<article class="portal-connection-row" role="listitem">
    <span class="portal-connection-icon codicon codicon-link" aria-hidden="true"></span>
    <div class="portal-connection-copy"><div class="portal-connection-title">${portalConnectionSide('controlled', item.role === 'controlled' ? item : undefined)}<span class="portal-connection-arrow">←</span>${portalConnectionSide('controller', item.role === 'controller' ? item : undefined)}</div>
      <div class="portal-connection-detail">Awaiting peer · expires ${esc(new Date(item.expiresAt).toLocaleTimeString())} · ${esc(item.endpoint)}</div>
    </div>
    <div class="portal-connection-actions">${portalConnectionButton('portalConnectionCopyMagicLink', 'chatId', item.chatId, 'Copy magic code', 'Copy the unredeemed one-time Portal magic code')}</div>
  </article>`;
}

function renderPortalConnections() {
  const detail = document.getElementById('detail');
  if (!detail) return;
  const connections = portalConnectionGroups(Array.isArray(portalConnectionSnapshot?.connections) ? portalConnectionSnapshot.connections : []);
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
      <button type="button" class="pk-button" data-portal-command="portalConnections" title="Refresh Portal connections" aria-label="Refresh Portal connections"><span class="codicon codicon-refresh" aria-hidden="true"></span></button></div>
    </header>
    ${pending.length ? `<h3 class="portal-connections-section">Awaiting peer</h3><div class="portal-connection-list" role="list">${pending.map(portalPendingInvitationRow).join('')}</div>` : ''}
    <h3 class="portal-connections-section">Live</h3>
    ${list(live, 'No Portal is connected right now. Open a Portal from a PKM Chat toolbar or the portal_control MCP tool.')}
    <h3 class="portal-connections-section">History</h3>
    ${list(past, 'No past Portal connections are recorded.')}
  </section>`;
  detail.querySelectorAll('[data-portal-command]').forEach(button => {
    button.addEventListener('click', () => {
      const { portalCommand, portalKey, portalValue } = button.dataset;
      ask(portalCommand, portalKey ? { [portalKey]:portalValue } : {});
    });
  });
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
