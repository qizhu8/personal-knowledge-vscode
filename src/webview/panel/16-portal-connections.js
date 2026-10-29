let portalConnectionSnapshot = null;
let portalConnectionTimer = null;

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
      if (item.state === 'reconnecting') { group.state = 'reconnecting'; group.reconnecting = item.reconnecting || group.reconnecting; }
      group.lastSeenAt = Math.max(group.lastSeenAt, item.lastSeenAt);
    }
  }
  return [...groups.values()];
}

function portalConnectionSide(role, local, peer) {
  const machine = local?.localMachine || peer?.peerMachine || peer?.peerName || '';
  const label = local?.chatLabel || peer?.peerChatName || peer?.peerName || '';
  return `<span class="portal-connection-side" data-portal-role="${role}"><small>${local ? 'Local' : 'Remote'} · ${role === 'controlled' ? 'Controlled' : 'Controller'}</small><strong>${esc(machine || (local ? 'This machine' : 'Awaiting peer'))}</strong><span>${esc(label)}${local?.external ? ' · external' : ''}</span>${local && !local.external ? portalConnectionButton('portalConnectionOpenChat', 'chatId', local.chatId, 'Open Chat', 'Open this local Chat') : ''}</span>`;
}

function portalConnectionUntil(expiresAt) {
  return expiresAt === null || expiresAt === undefined ? 'until disconnected' : `until ${new Date(expiresAt).toLocaleTimeString()}`;
}

function portalConnectionLive(expiresAt, now = Date.now()) {
  return expiresAt === null || expiresAt === undefined || expiresAt > now;
}

// Display only: granting and revoking go through the standard local Portal permissions prompt.
function portalConnectionAccess(item, now = Date.now()) {
  const lines = [];
  let manage = '';
  for (const member of item.members) {
    const access = member.access || {};
    if (member.role === 'controlled') {
      const permissions = access.permissions && portalConnectionLive(access.permissions.expiresAt, now) ? access.permissions : undefined;
      const dimensions = permissions?.dimensions || [];
      const granted = !permissions ? 'none · each controller request asks'
        : `${permissions.mode === 'all' ? 'Allow All' : dimensions.join(', ')}${permissions.mode === 'once' ? ' · once' : ''}${permissions.scoped ? ' · scoped folders' : ''} · ${portalConnectionUntil(permissions.expiresAt)}`;
      const warning = permissions && (permissions.mode === 'all' || dimensions.includes('code-execute'))
        ? ' <strong title="Code execution can access the operating system and network; PKM cannot sandbox it.">code-execute</strong>' : '';
      lines.push(`<div class="portal-connection-detail" data-portal-access="permissions">Permissions: ${esc(granted)}${warning}</div>`);
      if (item.state === 'active' && member.chatId) manage = portalConnectionButton('portalConnectionPermissions', 'chatId', member.chatId, 'Permissions…', 'Grant or revoke this Portal\'s permissions on this machine');
    }
    if (member.external) {
      const external = access.externalAuthorization && portalConnectionLive(access.externalAuthorization.expiresAt, now) ? access.externalAuthorization : undefined;
      lines.push(`<div class="portal-connection-detail" data-portal-access="external">External access: ${esc(external ? `remembered ${portalConnectionUntil(external.expiresAt)}` : 'each request asks')}</div>`);
    }
  }
  return { lines: lines.join(''), manage };
}

function portalConnectionRow(item) {
  const controlled = item.members.find(member => member.role === 'controlled');
  const controller = item.members.find(member => member.role === 'controller');
  const left = portalConnectionSide('controlled', controlled, controller);
  const right = portalConnectionSide('controller', controller, controlled);
  const arrow = '<span class="portal-connection-arrow" title="Controller controls the left side"><span class="codicon codicon-arrow-left" aria-hidden="true"></span></span>';
  const times = `Paired ${esc(portalConnectionTime(item.connectedAt))} · seen ${esc(portalConnectionTime(item.lastSeenAt))}`;
  const access = portalConnectionAccess(item);
  return `<article class="portal-connection-row ${esc(item.state)}" role="listitem" data-pair-id="${portalConnectionAttribute(item.pairId)}">
    <span class="portal-connection-icon codicon codicon-remote" aria-hidden="true"></span>
    <div class="portal-connection-copy">
      <div class="portal-connection-title">${left}${arrow}${right}</div>
      <span class="portal-connection-status"><i></i>${item.state === 'reconnecting' ? 'Reconnecting' : 'Active'}</span>
      <div class="portal-connection-detail">${item.state === 'reconnecting' && Number.isFinite(item.reconnecting?.deadline) ? `Pairing kept until ${esc(new Date(item.reconnecting.deadline).toLocaleTimeString())} · ` : ''}${times}${item.endpoint ? ` · ${esc(item.endpoint)}` : ''}</div>
      ${access.lines}
    </div>${access.manage ? `<div class="portal-connection-actions">${access.manage}</div>` : ''}
  </article>`;
}

function portalEndpointRow(item) {
  const peer = item.peer;
  const localChat = item.deleted ? 'deleted' : item.chatName || 'General Enteray';
  const remoteChat = peer?.deleted ? 'deleted' : peer?.chatName || (peer ? 'General Enteray' : 'Not paired');
  const button = (operation, label, title = label) => portalConnectionButton(`portalEndpoint${operation}`, 'endpointId', item.id, label, title);
  return `<article class="portal-connection-row ${esc(item.state)}" role="listitem" data-endpoint-id="${portalConnectionAttribute(item.id)}">
    <span class="portal-connection-icon codicon codicon-plug" aria-hidden="true"></span>
    <div class="portal-connection-copy">
      <div class="portal-connection-title">
        <span class="portal-connection-side"><small>Local · this machine</small><strong>${esc(item.name)}</strong><span>${esc(item.localMachine)}</span>
          <span>PKM Chat: ${esc(localChat)}</span>
          <span>Accept remote control: ${item.acceptsIncoming && !item.deleted ? 'Enabled' : 'Disabled'}</span>
        </span>
        <span class="portal-connection-arrow" aria-label="Independent control in both directions">⇄</span>
        <span class="portal-connection-side"><small>Remote${peer && !peer.confirmed ? ' · not synchronized' : ''}</small>
          <strong>${esc(peer?.name || 'Not paired')}</strong><span>${esc(peer?.machine || '')}</span><span>PKM Chat: ${esc(remoteChat)}</span>
          <span>Accept local control: ${!peer?.confirmed ? 'Unknown' : peer.acceptsIncoming && !peer.deleted ? 'Enabled' : 'Disabled'}</span>
        </span>
      </div>
      <span class="portal-connection-status" role="status">${esc(item.state)}</span>
      <div class="portal-connection-detail">Local long-term permissions: ${esc(item.permissions.join(', ') || 'None · requests still need approval')}</div>
      <div class="portal-connection-detail">Saved pairing · automatic reconnection · no task replay${item.deleted ? ' · Bind another Chat and authorize again' : ''}</div>
      ${item.error ? `<div class="portal-connection-detail" role="alert">${esc(item.error)}</div>` : ''}
    </div>
    <div class="portal-connection-actions">
      ${!item.paired && item.state === 'disconnected' ? button('Pair', 'Pair…') : item.state === 'disconnected' ? button('Connect', 'Connect') : button('Disconnect', 'Disconnect')}
      ${button('Bind', 'Replace Chat…')}${button('Permissions', 'Local permissions…')}
      ${item.chatId && !item.deleted ? portalConnectionButton('portalConnectionOpenChat', 'chatId', item.chatId, 'Open Chat', 'Open the bound local Chat') : ''}
      ${button('Remove', 'Remove…')}
    </div>
  </article>`;
}

function portalHubPortNotice(hub) {
  if (!hub) return '';
  const requested = hub.requestedPort === 0 ? 'Automatic' : String(hub.requestedPort);
  const actual = hub.actualPort === undefined ? 'Not listening' : String(hub.actualPort);
  const changed = hub.actualPort !== undefined && hub.requestedPort !== 0 && hub.actualPort !== hub.requestedPort;
  const reason = hub.reason === 'in-use' ? 'Requested port occupied; the existing listener was not stopped.'
    : hub.reason === 'system-selected' ? 'The operating system selected a free port.'
    : hub.reason === 'reused' ? 'Reusing this window\'s running Hub without restarting it.' : 'Using the configured port.';
  return `<section class="portal-connection-row" data-portal-hub-port role="${hub.state === 'failed' ? 'alert' : 'status'}">
    <span class="portal-connection-icon codicon codicon-radio-tower" aria-hidden="true"></span>
    <div class="portal-connection-copy"><strong>Local Hub port · ${esc(hub.state)}</strong>
      <div class="portal-connection-detail">Requested: ${esc(requested)} → Actual: ${esc(actual)}${changed ? ' · Port changed' : ''}</div>
      <div class="portal-connection-detail">${esc(reason)}</div>
      ${hub.reason === 'in-use' && hub.state === 'ready' ? '<div class="portal-connection-detail">New pairing codes use the new port. Forwarding is resolved during code creation; saved remote addresses were not updated.</div>' : ''}
      ${hub.error ? `<div class="portal-connection-detail">${esc(hub.error)}</div>` : ''}
    </div></section>`;
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
  const now = Date.now();
  const connections = portalConnectionGroups((portalConnectionSnapshot?.connections || [])
    .filter(item => item.state === 'active' || item.state === 'reconnecting' && !(item.reconnecting?.deadline <= now)));
  const live = connections;
  const pending = (portalConnectionSnapshot?.pendingInvitations || []).filter(item => item.expiresAt > now);
  const endpoints = portalConnectionSnapshot?.endpoints || [];
  const reconnecting = live.filter(item => item.state === 'reconnecting').length;
  portalConnectionScheduleExpiry([...pending.map(item => item.expiresAt), ...live.flatMap(item => [item.reconnecting?.deadline,
    ...item.members.flatMap(member => [member.access?.permissions?.expiresAt, member.access?.externalAuthorization?.expiresAt])])], now);
  detail.style.padding = '0';
  detail.style.overflow = 'auto';
  const list = (items, empty) => items.length
    ? `<div class="portal-connection-list" role="list">${items.map(portalConnectionRow).join('')}</div>`
    : `<div class="portal-connection-empty">${esc(empty)}</div>`;
  detail.innerHTML = `<section class="portal-connections-workspace">
    <header class="portal-connections-head">
      <div><h2>Portal Connections</h2><p>Named endpoints reconnect without replaying tasks. Each machine independently controls its local permissions. Temporary Portals remain available.</p></div>
      <div class="portal-connections-head-actions"><span class="portal-connection-total">${live.filter(item => item.state === 'active').length} active${reconnecting ? ` · ${reconnecting} reconnecting` : ''}</span>
      <button type="button" class="pk-button" data-portal-command="portalEndpointCreate">New endpoint…</button>
      <button type="button" class="pk-button" data-portal-command="portalConnections" title="Refresh Portal connections" aria-label="Refresh Portal connections"><span class="codicon codicon-refresh" aria-hidden="true"></span></button></div>
    </header>
    ${portalHubPortNotice(portalConnectionSnapshot?.hubPort)}
    <h3 class="portal-connections-section">Saved endpoints</h3>
    ${endpoints.length ? `<div class="portal-connection-list" role="list">${endpoints.map(portalEndpointRow).join('')}</div>` : '<div class="portal-connection-empty">Create a local endpoint on each machine, then explicitly pair them. Incoming control is disabled by default.</div>'}
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

// The host posts on state changes only; re-render locally when a pending link or reconnect grace lapses.
function portalConnectionScheduleExpiry(times, now) {
  if (portalConnectionTimer) { clearTimeout(portalConnectionTimer); portalConnectionTimer = null; }
  const next = Math.min(...times.filter(time => Number.isFinite(time) && time > now));
  if (!Number.isFinite(next)) return;
  portalConnectionTimer = setTimeout(() => {
    portalConnectionTimer = null;
    if (state.tab === 'portalConnections') renderPortalConnections();
  }, Math.min(next - now + 50, 2147483647));
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
