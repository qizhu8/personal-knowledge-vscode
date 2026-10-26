let portalConnectionSnapshot = null;

function portalConnectionTime(value, now = Date.now()) {
  if (!Number.isFinite(value)) return '';
  const minutes = Math.round((now - value) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(value).toLocaleDateString();
}

function portalConnectionAttribute(value) {
  return esc(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function portalConnectionButton(command, key, value, label, title) {
  return `<button type="button" class="pk-button" data-portal-command="${command}" data-portal-key="${key}" data-portal-value="${portalConnectionAttribute(value)}" title="${portalConnectionAttribute(title)}">${esc(label)}</button>`;
}

function portalConnectionGroups(connections) {
  const groups = new Map();
  for (const item of connections) {
    const group = groups.get(item.pairId);
    if (!group) groups.set(item.pairId, { ...item, members:[item] });
    else {
      group.members.push(item);
      group.lastSeenAt = Math.max(group.lastSeenAt, item.lastSeenAt);
    }
  }
  return [...groups.values()];
}

function portalConnectionSide(role, local, peer) {
  const machine = local?.localMachine || peer?.peerMachine || peer?.peerName || '';
  const label = local?.chatLabel || peer?.peerChatName || peer?.peerName || '';
  return `<span class="portal-connection-side" data-portal-role="${role}"><small>${role === 'controlled' ? 'Controlled' : 'Controller'}</small><strong>${esc(machine || (local ? 'This machine' : 'Awaiting peer'))}</strong><span>${esc(label)}${local?.external ? ' · external' : ''}</span>${local && !local.external ? portalConnectionButton('portalConnectionOpenChat', 'chatId', local.chatId, 'Open Chat', 'Open this local Chat') : ''}</span>`;
}

function portalConnectionRow(item) {
  const controlled = item.members.find(member => member.role === 'controlled');
  const controller = item.members.find(member => member.role === 'controller');
  const left = portalConnectionSide('controlled', controlled, controller);
  const right = portalConnectionSide('controller', controller, controlled);
  const arrow = '<span class="portal-connection-arrow" title="Controller controls the left side"><span class="codicon codicon-arrow-left" aria-hidden="true"></span></span>';
  const times = `Paired ${esc(portalConnectionTime(item.connectedAt))} · seen ${esc(portalConnectionTime(item.lastSeenAt))}`;
  return `<article class="portal-connection-row ${esc(item.state)}" role="listitem" data-pair-id="${portalConnectionAttribute(item.pairId)}">
    <span class="portal-connection-icon codicon codicon-remote" aria-hidden="true"></span>
    <div class="portal-connection-copy">
      <div class="portal-connection-title">${left}${arrow}${right}</div>
      <span class="portal-connection-status"><i></i>Active</span>
      <div class="portal-connection-detail">${times}${item.endpoint ? ` · ${esc(item.endpoint)}` : ''}</div>
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
  const connections = portalConnectionGroups((portalConnectionSnapshot?.connections || []).filter(item => item.state === 'active'));
  const live = connections;
  const pending = (portalConnectionSnapshot?.pendingInvitations || []).filter(item => item.expiresAt > Date.now());
  detail.style.padding = '0';
  detail.style.overflow = 'auto';
  const list = (items, empty) => items.length
    ? `<div class="portal-connection-list" role="list">${items.map(portalConnectionRow).join('')}</div>`
    : `<div class="portal-connection-empty">${esc(empty)}</div>`;
  detail.innerHTML = `<section class="portal-connections-workspace">
    <header class="portal-connections-head">
      <div><h2>Portal Connections</h2><p>Temporary connections in this window. Disconnect or restart ends the pairing; task history stays in the Chats.</p></div>
      <div class="portal-connections-head-actions"><span class="portal-connection-total">${live.filter(item => item.state === 'active').length} active</span>
      <button type="button" class="pk-button" data-portal-command="portalConnections" title="Refresh Portal connections" aria-label="Refresh Portal connections"><span class="codicon codicon-refresh" aria-hidden="true"></span></button></div>
    </header>
    ${pending.length ? `<h3 class="portal-connections-section">Awaiting peer</h3><div class="portal-connection-list" role="list">${pending.map(portalPendingInvitationRow).join('')}</div>` : ''}
    <h3 class="portal-connections-section">Live</h3>
    ${list(live, 'No Portal is connected right now. Open a Portal from a PKM Chat toolbar or the portal_control MCP tool.')}
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
