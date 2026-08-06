// ── Servers dashboard ────────────────────────────────────────────────────────
let serverCache = [];
let _srvPoll = null;
function renderServerDashboard(servers) {
  serverCache = servers || [];
  const dot = s => s === 'running' ? '#3fb950' : s === 'starting' ? '#e5c07b' : '#8b949e';
  const cards = serverCache.map(s => `
    <div class="srv-card">
      <div class="ec-row">
        <span class="srv-dot" style="background:${dot(s.status)}"></span>
        <b>${esc(s.name)}</b><span class="cat">${esc(s.slug)}</span>
        <span style="font-size:11px;color:var(--muted)">:${s.activePort} · ${esc(s.status)}${s.pid ? ' · pid ' + s.pid : ''}</span>
        <span style="flex:1"></span>
        ${s.status === 'stopped'
          ? `<button class="tbtn" onclick="ask('serverStart',{slug:'${esc(s.slug)}'})">▶ Start</button>`
          : `<button class="tbtn" onclick="ask('serverStop',{slug:'${esc(s.slug)}'})">■ Stop</button><button class="tbtn" onclick="ask('serverRestart',{slug:'${esc(s.slug)}'})">↻</button>`}
        <button class="tbtn" onclick="openServer('${esc(s.stableUrl)}')" title="Open the stable URL">🌐</button>
        <button class="tbtn" onclick="ask('serverOpenFolder',{slug:'${esc(s.slug)}'})" title="Open the server folder (code + any data it writes)">📂</button>
        <button class="tbtn" onclick="editServer('${esc(s.slug)}')">✏</button>
        <button class="tbtn" onclick="serverLogView('${esc(s.slug)}')" title="Log">📜</button>
        <button class="tbtn" onclick="deleteServer('${esc(s.slug)}',${JSON.stringify(s.name).replace(/"/g,'&quot;')})">🗑</button>
      </div>
      <div class="ec-path"><code>${esc(s.command)}</code> · env: ${esc(s.python || 'python3')}</div>
      <div class="ec-path">stable: <a href="#" onclick="openServer('${esc(s.stableUrl)}');return false">${esc(s.stableUrl)}</a>
        <button class="tbtn" style="font-size:10px;padding:1px 6px" onclick="ask('serverCopy',{text:'${esc(s.stableUrl)}'})">copy</button></div>
    </div>`).join('');
  document.getElementById('detail').innerHTML = `
    <div class="dash">
      <div class="dash-hd">
        <span class="dash-title">🖥 Servers</span>
        <span style="font-size:11px;color:var(--muted)">stable URLs via the built-in proxy</span>
        <span style="flex:1"></span>
        <button class="tbtn" onclick="importServer()">＋ Import folder</button>
        <button class="tbtn" onclick="createServer()">＋ New</button>
        <button class="tbtn" onclick="ask('serverList',{})">↻</button>
      </div>
      ${cards || '<div class="empty">No servers yet — import a folder (moves it into the store) or create a new one.</div>'}
      <div id="srv-out"></div>
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
function importServer() { ask('serverPickFolder', {}); }
function onServerPickFolder(dir) {
  if (!dir) return;
  const base = dir.split('/').pop();
  pkModal({ title: 'Import server', message: 'Moves “' + dir + '” into the store as a managed server.', input: true, defaultValue: base, okLabel: 'Import',
    onOk: v => ask('serverImport', { sourceDir: dir, name: v.trim() || base }) });
}
function createServer() { pkModal({ title: 'New server', input: true, okLabel: 'Create', onOk: v => { if (v.trim()) ask('serverCreate', { name: v.trim() }); } }); }
function editServer(slug) {
  const s = serverCache.find(x => x.slug === slug); if (!s) return;
  const envOpts = envCache.map(e => `<option value="${esc(e.python)}">${esc(e.name)} (${esc(e.python)})</option>`).join('');
  const out = document.getElementById('srv-out');
  out.innerHTML = `<div class="srv-edit">
      <b>Edit ${esc(s.name)}</b>
      <label>Command <input id="se-cmd" value="${esc(s.command)}"></label>
      <label>Port <input id="se-port" type="number" value="${s.port}"></label>
      <label>Python interpreter (blank = python3)
        <input id="se-py" list="se-envs" value="${esc(s.python || '')}" placeholder="python3 or /path/to/env/bin/python">
        <datalist id="se-envs">${envOpts}</datalist></label>
      <div><button class="tbtn" onclick="saveServer('${esc(s.slug)}')">Save & restart</button>
        <button class="tbtn" onclick="document.getElementById('srv-out').innerHTML=''">Cancel</button></div>
    </div>`;
}
function saveServer(slug) {
  const patch = {
    command: document.getElementById('se-cmd').value,
    port: +document.getElementById('se-port').value,
    python: document.getElementById('se-py').value,
  };
  ask('serverUpdate', { slug, patch });
  document.getElementById('srv-out').innerHTML = '';
}
function serverLogView(slug) { document.getElementById('srv-out').innerHTML = '<div class="empty">Loading log…</div>'; ask('serverLog', { slug }); }
function onServerLog(slug, text) {
  const out = document.getElementById('srv-out'); if (!out) return;
  out.innerHTML = '<div class="ec-row" style="margin:8px 0"><b>Log · ' + esc(slug) + '</b><span style="flex:1"></span><button class="tbtn" style="font-size:11px" onclick="serverLogView(\'' + esc(slug) + '\')">↻</button></div>' +
    '<pre class="srv-log">' + esc(text) + '</pre>';
}
function deleteServer(slug, name) {
  pkModal({ title: 'Delete server “' + name + '”?', message: 'Removes “' + slug + '” and its code from the store.', okLabel: 'Delete', danger: true, onOk: () => ask('serverDelete', { slug }) });
}

