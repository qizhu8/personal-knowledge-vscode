// ── Servers dashboard ────────────────────────────────────────────────────────
let serverCache = [];
let _srvPoll = null;
function renderServerDashboard(servers) {
  serverCache = servers || [];
  const dot = s => s === 'running' ? '#3fb950' : s === 'starting' ? '#e5c07b' : '#8b949e';
  const cards = serverCache.map(s => {
    const links = s.networkLinks || [];
    let saved = ''; try { saved = localStorage.getItem('pkm-server-network-' + s.slug) || ''; } catch {}
    const selected = links.find(link => link.address === saved) || links[0];
    const stableLink = selected?.url || '';
    const options = links.map(link => `<option value="${esc(link.address)}" ${link.address === selected?.address ? 'selected' : ''}>${esc(link.interface)} · ${esc(link.address)}</option>`).join('');
    return `
    <div class="srv-card">
      <div class="ec-row">
        <span class="srv-dot" style="background:${dot(s.status)}"></span>
        <b>${esc(s.name)}</b><span class="cat">${esc(s.slug)}</span>
        <span style="font-size:11px;color:var(--muted)">:${s.activePort} · ${esc(s.status)}${s.pid ? ' · pid ' + s.pid : ''}</span>
        <span style="flex:1"></span>
      </div>
      <div class="srv-actions" role="toolbar" aria-label="Actions for ${esc(s.name)}">
        <span class="srv-lifecycle-actions">${s.status === 'stopped'
          ? `<button class="tbtn" onclick="ask('serverStart',{slug:'${esc(s.slug)}'})" title="Start ${esc(s.name)} with its configured command and port">▶ Start</button>`
          : `<button class="tbtn" onclick="ask('serverStop',{slug:'${esc(s.slug)}'})" title="Stop the detached ${esc(s.name)} process">■ Stop</button><button class="tbtn" onclick="ask('serverRestart',{slug:'${esc(s.slug)}'})" title="Restart ${esc(s.name)} with its saved settings">↻ Restart</button>`}</span>
        <span class="srv-management-actions"><button class="tbtn" onclick="ask('serverOpenFolder',{slug:'${esc(s.slug)}'})" title="Open the server folder (code + any data it writes)">📂 Folder</button>
        <button class="tbtn" onclick="editServer('${esc(s.slug)}')" title="Edit server settings: command, port, and Python">⚙ Settings</button>
        <button class="tbtn" onclick="serverLogView('${esc(s.slug)}')" title="Open the latest managed process log">📜 Log</button>
        <button class="tbtn srv-danger" onclick="deleteServer('${esc(s.slug)}',${JSON.stringify(s.name).replace(/"/g,'&quot;')})" title="Permanently delete this managed server folder and settings">🗑 Delete</button>
        <label class="srv-forward-toggle" title="Request VS Code Remote-SSH port forwarding for Server Link. Disable prevents new forwarding; close an existing tunnel in the Ports view."><input type="checkbox" ${s.autoForward ? 'checked' : ''} ${s.remoteName ? '' : 'disabled'} onchange="serverForwardChanged('${esc(s.slug)}',this.checked)"> ↔ Port Forward</label></span>
      </div>
      <div class="ec-path"><code>${esc(s.command)}</code> · env: ${esc(s.python || 'python3')}</div>
      <div class="srv-link-block srv-stable-link">
        <div class="srv-link-head"><strong>Stable Link</strong>
          <select onchange="serverNetworkChanged('${esc(s.slug)}',this.value)" title="Select the network interface/IP for Stable Link" ${links.length ? '' : 'disabled'}>${options || '<option>No network IPv4 found</option>'}</select>
        </div>
        <div class="srv-link-main">
          <code id="srv-network-link-${esc(s.slug)}" title="${esc(stableLink || 'Unavailable')}">${esc(stableLink || 'Unavailable')}</code>
          <span class="srv-link-actions"><button class="tbtn" onclick="openServerLink('${esc(s.slug)}','network')" title="Open Stable Link with the selected IP" ${stableLink ? '' : 'disabled'}>Open</button><button class="tbtn" onclick="copyServerLink('${esc(s.slug)}','network')" title="Copy Stable Link" ${stableLink ? '' : 'disabled'}>Copy</button></span>
        </div>
      </div>
      <details class="srv-link-block srv-local-link">
        <summary title="Show the localhost Server Link and forwarding controls">Server Local Link <span>${esc(s.localUrl)}</span></summary>
        <div class="srv-link-main">
          <code title="${esc(s.localUrl)}">${esc(s.localUrl)}</code>
          <span class="srv-link-actions"><button class="tbtn" onclick="openServerLink('${esc(s.slug)}','local')" title="Open localhost Server Link; Remote SSH requires Port Forward">Open</button><button class="tbtn" onclick="copyServerLink('${esc(s.slug)}','local')" title="Copy localhost Server Link">Copy</button></span>
        </div>
      </details>
      <div class="srv-card-output" id="srv-out-${esc(s.slug)}"></div>
    </div>`;
  }).join('');
  document.getElementById('detail').innerHTML = `
    <div class="dash">
      <div class="dash-hd">
        <span class="dash-title">🖥 Servers</span>
        <span style="font-size:11px;color:var(--muted)">select a network interface for LAN/global access</span>
        <span style="flex:1"></span>
        <button class="tbtn" onclick="importServer()" title="Move an existing server folder into the PKM store">＋ Import folder</button>
        <button class="tbtn" onclick="createServer()" title="Create a new managed server package">＋ New</button>
        <button class="tbtn" onclick="ask('serverList',{})" title="Force-refresh server process, port, and link status">↻ Refresh</button>
      </div>
      ${cards || '<div class="empty">No servers yet — import a folder (moves it into the store) or create a new one.</div>'}
    </div>`;
  ask('envList', {}); // cache envs for the edit form's interpreter picker
  // A server that just started shows "starting" until its port is up — auto-poll
  // until every server has settled (running/stopped) so the light turns green.
  if (_srvPoll) { clearTimeout(_srvPoll); _srvPoll = null; }
  if (serverCache.some(s => s.status === 'starting')) {
    _srvPoll = setTimeout(() => { if (state.tab === 'servers') ask('serverList', {}); }, 1200);
  }
}
function openServer(url) { ask('serverOpenUrl', { url }); }
function selectedServerLink(slug, kind) {
  const server = serverCache.find(item => item.slug === slug); if (!server) return '';
  if (kind === 'local') return server.localUrl || '';
  let saved = ''; try { saved = localStorage.getItem('pkm-server-network-' + slug) || ''; } catch {}
  return (server.networkLinks || []).find(link => link.address === saved)?.url || server.networkLinks?.[0]?.url || '';
}
function serverNetworkChanged(slug, address) {
  try { localStorage.setItem('pkm-server-network-' + slug, address); } catch {}
  const element = document.getElementById('srv-network-link-' + slug);
  if (element) element.textContent = selectedServerLink(slug, 'network') || 'Unavailable';
}
function openServerLink(slug, kind) {
  const server = serverCache.find(item => item.slug === slug);
  const url = selectedServerLink(slug, kind);
  if (server && url) ask('serverOpenUrl', { url, requiresForward: kind === 'local', forwardEnabled: !!server.autoForward });
}
function copyServerLink(slug, kind) { const url = selectedServerLink(slug, kind); if (url) ask('serverCopy', { text: url }); }
function serverForwardChanged(slug, enabled) { ask('serverSetForward', { slug, enabled }); }
function importServer() { ask('serverPickFolder', {}); }
function onServerPickFolder(dir) {
  if (!dir) return;
  const base = dir.split('/').pop();
  pkModal({ title: 'Import server', message: 'Moves “' + dir + '” into the store as a managed server.', input: true, defaultValue: base, okLabel: 'Import',
    onOk: v => ask('serverImport', { sourceDir: dir, name: v.trim() || base }) });
}
function createServer() { pkModal({ title: 'New server', input: true, okLabel: 'Create', onOk: v => { if (v.trim()) ask('serverCreate', { name: v.trim() }); } }); }
function serverOutput(slug) { return document.getElementById('srv-out-' + slug); }
function closeServerOutput(slug) { const out = serverOutput(slug); if (out) out.innerHTML = ''; }
function editServer(slug) {
  const s = serverCache.find(x => x.slug === slug); if (!s) return;
  const envOpts = envCache.map(e => `<option value="${esc(e.python)}">${esc(e.name)} (${esc(e.python)})</option>`).join('');
  const out = serverOutput(slug); if (!out) return;
  out.innerHTML = `<div class="srv-edit">
      <div class="ec-row"><b>Server Settings · ${esc(s.name)}</b><span style="flex:1"></span><button class="tbtn" onclick="closeServerOutput('${esc(slug)}')" title="Cancel editing and close this panel">Close</button></div>
      <label>Display name <input id="se-name-${esc(slug)}" value="${esc(s.name)}" title="Rename the displayed server name; folder slug and links stay unchanged"></label>
      <label>Command <input id="se-cmd-${esc(slug)}" value="${esc(s.command)}"></label>
      <label>Port <input id="se-port-${esc(slug)}" type="number" value="${s.port}"></label>
      <label>Python interpreter (blank = python3)
        <input id="se-py-${esc(slug)}" list="se-envs-${esc(slug)}" value="${esc(s.python || '')}" placeholder="python3 or /path/to/env/bin/python">
        <datalist id="se-envs-${esc(slug)}">${envOpts}</datalist></label>
      <div><button class="tbtn" onclick="saveServer('${esc(s.slug)}')" title="Save settings and restart a running server">Save & restart</button>
        <button class="tbtn" onclick="closeServerOutput('${esc(slug)}')" title="Discard unsaved settings and close">Cancel</button></div>
    </div>`;
}
function saveServer(slug) {
  const patch = {
    name: document.getElementById('se-name-' + slug).value,
    command: document.getElementById('se-cmd-' + slug).value,
    port: +document.getElementById('se-port-' + slug).value,
    python: document.getElementById('se-py-' + slug).value,
  };
  ask('serverUpdate', { slug, patch });
  closeServerOutput(slug);
}
function serverLogView(slug) {
  const out = serverOutput(slug); if (!out) return;
  out.innerHTML = `<div class="ec-row srv-output-head"><div class="empty">Loading log…</div><span style="flex:1"></span><button class="tbtn" onclick="closeServerOutput('${esc(slug)}')" title="Close log panel">Close</button></div>`;
  ask('serverLog', { slug });
}
function onServerLog(slug, text) {
  const out = serverOutput(slug); if (!out) return;
  out.innerHTML = '<div class="ec-row srv-output-head"><b>Log · ' + esc(slug) + '</b><span style="flex:1"></span><button class="tbtn" style="font-size:11px" onclick="serverLogView(\'' + esc(slug) + '\')" title="Refresh this log output">↻ Refresh</button><button class="tbtn" style="font-size:11px" onclick="closeServerOutput(\'' + esc(slug) + '\')" title="Close log panel">Close</button></div>' +
    '<pre class="srv-log">' + esc(text) + '</pre>';
}
function deleteServer(slug, name) {
  pkModal({ title: 'Delete server “' + name + '”?', message: 'Removes “' + slug + '” and its code from the store.', okLabel: 'Delete', danger: true, onOk: () => ask('serverDelete', { slug }) });
}

