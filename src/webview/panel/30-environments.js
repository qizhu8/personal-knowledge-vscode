// ── Python Environments dashboard ───────────────────────────────────────────
let envCache = [];
const ENV_MGR_COLOR = { conda: '#3fb950', venv: '#4daafc', uv: '#a371f7', other: '#8b949e' };
function renderEnvDashboard(envs) {
  envCache = envs || [];
  document.getElementById('detail').innerHTML = `
    <div class="dash">
      <div class="dash-hd">
        <span class="dash-title">🐍 Python Environments</span>
        <span style="flex:1"></span>
        <button class="tbtn" onclick="newEnvForm()">✨ New</button>
        <button class="tbtn" onclick="registerCondaEnv()">＋ conda</button>
        <button class="tbtn" onclick="registerFolderEnv()">＋ venv/uv folder</button>
        <button class="tbtn" onclick="startCompare()"${envCache.length < 2 ? ' disabled' : ''}>⇄ Compare</button>
        <button class="tbtn" onclick="findSimilar()"${envCache.length < 2 ? ' disabled' : ''} title="Find near-duplicate environments that could be merged">≈ Similar</button>
        <button class="tbtn" onclick="ask('envList',{})">↻</button>
      </div>
      <div id="env-tree"></div>
      <div id="env-out"></div>
    </div>`;
  renderEnvTree();
}
function renderEnvTree() {
  const el = document.getElementById('env-tree'); if (!el) return;
  if (!envCache.length) {
    el.innerHTML = '<div class="empty">No environments yet — register a conda env or a venv/uv folder.</div>';
    return;
  }
  // Group into a collapsible tree by manager (conda/venv/uv) then root folder.
  const root = buildCatTree(envCache, envCategory, 'other');
  el.innerHTML = renderCatTree(root, [], 0, (e, depth) => envCardHtml(e, 8 + depth * 12), '');
}
// Tree category: manager first, then the root install/parent folder it lives in.
function envCategory(e) {
  const m = e.manager || 'other';
  if (m === 'conda') {
    const p = e.path || '';
    const rootDir = p.includes('/envs/') ? p.slice(0, p.indexOf('/envs/')) : p;
    return 'conda/' + (rootDir.split('/').filter(Boolean).pop() || 'conda');
  }
  const parent = (e.path || e.python || '').replace(/\/[^/]*$/, '');
  return m + '/' + (parent.split('/').filter(Boolean).pop() || '(root)');
}
function envCardHtml(e, indent) {
  const size = typeof e.sizeBytes === 'number' ? humanSizeJs(e.sizeBytes) : '';
  const disabled = e.missing ? ' disabled' : '';
  return `<div class="env-card" style="margin-left:${indent}px;${e.missing ? 'border-color:#f8717166;opacity:.8' : ''}">
      <div class="ec-row">
        <span class="env-badge" style="background:${ENV_MGR_COLOR[e.manager] || '#8b949e'}">${esc(e.manager)}</span>
        <b>${esc(e.name)}</b>
        ${e.pyVersion ? `<span class="py-ver" title="Python version">py ${esc(e.pyVersion)}</span>` : ''}
        ${size ? `<span class="env-size" title="on-disk size">💾 ${esc(size)}</span>` : ''}
        ${e.managed ? `<span class="env-managed" title="Stored in the extension-managed location">📍 managed</span>` : ''}
        ${e.missing ? `<span style="font-size:10px;color:#f87171;border:1px solid #f8717166;border-radius:8px;padding:0 6px">Missing on disk</span>` : ''}
        <span style="flex:1"></span>
        <button class="tbtn" style="font-size:11px" onclick="viewEnvPackages('${esc(e.id)}',false)"${disabled}>📦 Packages</button>
        <button class="tbtn" style="font-size:11px" onclick="activateEnv('${esc(e.id)}')" title="Open a terminal with this environment activated (auto Windows/Linux)"${disabled}>⚡ Activate Env</button>
        <button class="tbtn" style="font-size:11px" onclick="refreshEnvSize('${esc(e.id)}')" title="Compute on-disk size"${disabled}>📐</button>
        ${e.managed ? '' : `<button class="tbtn" style="font-size:11px" onclick="migrateEnv('${esc(e.id)}',${JSON.stringify(e.name).replace(/"/g,'&quot;')})" title="Move this environment into the extension-managed location">🚚 Migrate</button>`}
        <button class="tbtn" style="font-size:11px" onclick="editEnv('${esc(e.id)}')" title="Edit name / description">✏</button>
        <button class="tbtn" style="font-size:11px" onclick="deleteEnvScript('${esc(e.id)}')" title="Generate a delete script for you to run manually">🧾 Del script</button>
        <button class="tbtn" style="font-size:11px" onclick="deleteEnv('${esc(e.id)}',${JSON.stringify(e.name).replace(/"/g,'&quot;')})" title="Unregister">🗑</button>
      </div>
      ${e.description ? `<div class="ec-desc">${renderEnvTags(e.description)}</div>` : ''}
      <div class="ec-path">${esc(e.python || e.path || '')}</div>
    </div>`;
}
function humanSizeJs(b) {
  if (!b || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 || n >= 100 ? 0 : 1) + ' ' + u[i];
}
function renderEnvTags(desc) {
  const parts = String(desc).split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) return parts.map(t => `<span class="env-tag">${esc(t)}</span>`).join('');
  return `<span class="env-desc-text">${esc(desc)}</span>`;
}
function activateEnv(id) { ask('envActivate', { id }); }
function onEnvActivate(d) {
  if (d.error) { envOut('<div style="color:#f87171">' + esc(d.error) + '</div>'); return; }
  envOut(`<div class="ec-row" style="margin:10px 0 6px"><b>⚡ Activated in terminal “${esc(d.termName || 'env')}”</b><span style="font-size:11px;color:var(--muted)">the environment is now active there — run <code>python</code> / <code>pip</code> as usual</span></div><pre class="env-activate">${esc(d.script)}</pre>`);
}
function refreshEnvSize(id) { envOut('<div class="empty">Computing on-disk size…</div>'); ask('envSize', { id, refresh: true }); }
function onEnvSize(d) {
  if (d.error) { envOut('<div style="color:#f87171">' + esc(d.error) + '</div>'); return; }
  envOut('');
  ask('envList', {}); // refresh cards with the persisted size
}
function migrateEnv(id, name) {
  pkModal({
    title: 'Migrate “' + name + '”?',
    message: 'Moves this environment into the extension-managed location (setting: personalKnowledge.environmentsPath, default ~/pkm-envs). Conda envs are cloned then the original is removed; venv/uv are moved and their paths fixed up. This can take a while.',
    okLabel: 'Migrate', danger: true,
    onOk: () => { envOut('<div class="empty">Migrating… this can take a while.</div>'); ask('envMigrate', { id }); }
  });
}
function onEnvMigrated(d) {
  if (d && d.ok) { envOut(''); return; }
  const err = '<span style="color:#f87171">' + esc((d && d.error) || 'migration failed') + '</span>' + (d && d.log ? '<pre class="env-activate" style="margin-top:6px;max-height:160px;overflow:auto">' + esc(d.log) + '</pre>' : '');
  envOut('<div>' + err + '</div>');
}
function envOut(html) { const o = document.getElementById('env-out'); if (o) o.innerHTML = html; }
function viewEnvPackages(id, refresh) {
  envOut('<div class="empty">' + (refresh ? 'Refreshing' : 'Loading') + ' packages…</div>');
  ask('envPackages', { id, refresh: !!refresh });
}
function onEnvPackages(d) {
  if (d.error) { envOut('<div style="color:#f87171">' + esc(d.error) + '</div>'); return; }
  const rows = (d.packages || []).map(p => `<tr><td>${esc(p.name)}</td><td class="pv">${esc(p.version)}</td></tr>`).join('');
  envOut(`<div class="ec-row" style="margin:10px 0 6px">
      <b>${(d.packages || []).length} packages</b>
      <span style="font-size:11px;color:var(--muted)">${d.cached ? 'cached' : 'captured'} ${(d.capturedAt || '').slice(0, 19).replace('T', ' ')}</span>
      <span style="flex:1"></span>
      <input id="pkg-filter" placeholder="filter…" style="font-size:11px;width:130px" oninput="filterPkgs()">
      <button class="tbtn" style="font-size:11px" onclick="viewEnvPackages('${esc(d.id)}',true)">↻ Refresh</button>
    </div>
    <table class="pkg-table"><tbody id="pkg-body">${rows}</tbody></table>`);
}
function filterPkgs() {
  const q = (document.getElementById('pkg-filter').value || '').toLowerCase();
  document.querySelectorAll('#pkg-body tr').forEach(tr => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; });
}
function startCompare() {
  const opts = envCache.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
  envOut(`<div class="ec-row" style="margin:10px 0">
      <select id="cmp-a">${opts}</select><span>vs</span><select id="cmp-b">${opts}</select>
      <button class="tbtn" onclick="runCompare()">Compare</button>
    </div><div id="cmp-out"></div>`);
  const b = document.getElementById('cmp-b'); if (b && b.options.length > 1) b.selectedIndex = 1;
}
function runCompare() {
  const a = document.getElementById('cmp-a').value, b = document.getElementById('cmp-b').value;
  document.getElementById('cmp-out').innerHTML = '<div class="empty">Comparing…</div>';
  ask('envCompare', { a, b });
}
// ── Similarity / merge candidates ────────────────────────────────────────────
function findSimilar() {
  envOut('<div class="empty">Analysing package overlap across all environments…</div>');
  ask('envSimilarity', {});
}
function renderEnvSimilarity(d) {
  const pairs = (d && d.pairs) || [];
  if (!pairs.length) { envOut('<div class="empty">Need at least two environments with captured packages.</div>'); return; }
  const tier = s => s >= 0.85 ? { c: '#3fb950', t: 'strong merge candidate' } : (s >= 0.7 ? { c: '#e5c07b', t: 'similar' } : { c: 'var(--muted)', t: 'low overlap' });
  const rows = pairs.map(p => {
    const pct = Math.round(p.score * 100), epct = Math.round(p.exactScore * 100), tg = tier(p.score);
    const save = p.saving ? humanSizeJs(p.saving) : '—';
    return `<div class="sim-card" style="border-left:3px solid ${tg.c}">
      <div class="ec-row">
        <span class="sim-pct" style="color:${tg.c}">${pct}%</span>
        <b>${esc(p.a.name)}</b> <span style="color:var(--muted)">${humanSizeJs(p.a.size)}</span>
        <span style="color:var(--muted)">≈</span>
        <b>${esc(p.b.name)}</b> <span style="color:var(--muted)">${humanSizeJs(p.b.size)}</span>
        ${p.py ? `<span class="py-ver" title="Python version">py ${esc(p.py)}</span>` : ''}
        <span style="flex:1"></span>
        <button class="tbtn" style="font-size:11px" onclick="comparePair('${esc(p.a.id)}','${esc(p.b.id)}')">⇄ Diff</button>
        <button class="tbtn" style="font-size:11px" onclick="mergeScript('${esc(p.a.id)}','${esc(p.b.id)}')" title="Generate a merge script for you to run manually">🧬 Merge script</button>
      </div>
      <div class="sim-meta">${tg.t} · ${p.shared} shared (${epct}% exact) · ${p.diffVer} version-diff · ${p.onlyA} only in ${esc(p.a.name)} / ${p.onlyB} only in ${esc(p.b.name)} · potential save <b style="color:${tg.c}">~${save}</b></div>
    </div>`;
  }).join('');
  const strong = pairs.filter(p => p.score >= 0.85).length;
  envOut(`<div class="ec-row" style="margin:10px 0 6px"><b>≈ Merge candidates</b>
      <span style="font-size:11px;color:var(--muted)">${pairs.length} pairs · ${strong} strong (≥85%)${d.skipped ? ' · ' + d.skipped + ' skipped (different Python)' : ''}</span></div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:6px">Estimated saving assumes the smaller env is merged into the larger. Verify with a full diff before deleting.</div>
    ${rows}`);
}
function comparePair(a, b) {
  startCompare();
  const sa = document.getElementById('cmp-a'), sb = document.getElementById('cmp-b');
  if (sa) sa.value = a; if (sb) sb.value = b;
  runCompare();
}
function mergeScript(a, b) { envOut('<div class="empty">Generating merge script…</div>'); ask('envMergeScript', { a, b }); }
function onEnvMergeScript(d) {
  if (d.error) { envOut('<div style="color:#f87171">' + esc(d.error) + '</div>'); return; }
  envOut(`<div class="ec-row" style="margin:10px 0 6px"><b>🧬 Merge script</b><span style="font-size:11px;color:var(--muted)">keep <b>${esc(d.keep)}</b>, drop <b>${esc(d.drop)}</b> — copied to clipboard; review and run it yourself, the extension will not execute it</span></div><pre class="env-activate">${esc(d.script)}</pre>`);
}
const CMP_ST = {
  same:      { s: '=', c: 'var(--muted)', label: 'same' },
  upgrade:   { s: '↑', c: '#3fb950', label: 'upgrade' },
  downgrade: { s: '↓', c: '#e5c07b', label: 'downgrade' },
  added:     { s: '＋', c: '#4daafc', label: 'added' },
  deleted:   { s: '－', c: '#f87171', label: 'deleted' },
};
const CMP_DELTA_ORDER = ['upgrade', 'downgrade', 'added', 'deleted', 'same'];
let _cmpData = null;
let _cmpSort = { col: 'status', dir: 1, deltaIdx: 0 };

function renderEnvCompare(d) {
  const out = document.getElementById('cmp-out'); if (!out) return;
  _cmpData = d;
  _cmpSort = { col: 'status', dir: 1, deltaIdx: 0 };
  const c = d.counts || {};
  const summary = CMP_DELTA_ORDER.filter(k => c[k])
    .map(k => `<span style="color:${CMP_ST[k].c}">${CMP_ST[k].s} ${c[k]} ${CMP_ST[k].label}</span>`).join(' · ');
  out.innerHTML = `
    <div class="ec-row" style="margin:8px 0;font-size:12px">
      <span style="color:var(--muted)">${esc(d.a.name)} (${d.a.count}) → ${esc(d.b.name)} (${d.b.count})</span>
      <span style="flex:1"></span>
      <label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="checkbox" id="cmp-hide-same" onchange="renderCmpBody()"> hide unchanged</label>
    </div>
    <div style="font-size:11px;margin-bottom:6px">${summary || '(no packages)'}</div>
    <table class="pkg-table cmp-table">
      <thead id="cmp-thead"></thead>
      <tbody id="cmp-tbody"></tbody>
    </table>`;
  renderCmpBody();
}

function cmpHeader() {
  const arrow = k => _cmpSort.col === k ? (_cmpSort.dir > 0 ? ' ▲' : ' ▼') : '';
  const dh = _cmpSort.col === 'status' ? ' ' + CMP_ST[CMP_DELTA_ORDER[_cmpSort.deltaIdx]].s : '';
  return `<tr>
    <th class="cmp-sort" onclick="sortCmp('name')">Package${arrow('name')}</th>
    <th class="cmp-sort" onclick="sortCmp('va')">${esc(_cmpData.a.name)}${arrow('va')}</th>
    <th class="cmp-sort" onclick="sortCmp('vb')">${esc(_cmpData.b.name)}${arrow('vb')}</th>
    <th class="cmp-sort cmp-delta" onclick="sortCmp('status')" title="click to cycle: prioritize upgrade / downgrade / added / deleted / same">Δ${dh}</th>
  </tr>`;
}

function cmpSortRows() {
  const rows = (_cmpData && _cmpData.rows) ? _cmpData.rows.slice() : [];
  if (_cmpSort.col === 'status') {
    const prio = CMP_DELTA_ORDER[_cmpSort.deltaIdx];
    const base = { added: 0, deleted: 1, upgrade: 2, downgrade: 3, same: 4 };
    const rank = s => s === prio ? -1 : base[s];
    rows.sort((a, b) => (rank(a.status) - rank(b.status)) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  } else {
    const k = _cmpSort.col;
    rows.sort((a, b) => _cmpSort.dir * String(a[k]).localeCompare(String(b[k]), undefined, { numeric: true, sensitivity: 'base' }));
  }
  return rows;
}

function sortCmp(col) {
  if (col === 'status') {
    if (_cmpSort.col === 'status') _cmpSort.deltaIdx = (_cmpSort.deltaIdx + 1) % CMP_DELTA_ORDER.length;
    else { _cmpSort.col = 'status'; _cmpSort.deltaIdx = 0; }
  } else if (_cmpSort.col === col) _cmpSort.dir *= -1;
  else { _cmpSort.col = col; _cmpSort.dir = 1; }
  renderCmpBody();
}

function renderCmpBody() {
  const tb = document.getElementById('cmp-tbody'); if (!tb) return;
  const th = document.getElementById('cmp-thead'); if (th) th.innerHTML = cmpHeader();
  const hide = (document.getElementById('cmp-hide-same') || {}).checked;
  tb.innerHTML = cmpSortRows().map(r => {
    const t = CMP_ST[r.status] || CMP_ST.same;
    const hidden = hide && r.status === 'same' ? ' style="display:none"' : '';
    return `<tr class="cmp-${r.status}"${hidden}><td>${esc(r.name)}</td><td class="pv">${esc(r.va) || '—'}</td><td class="pv">${esc(r.vb) || '—'}</td>` +
      `<td class="cmp-delta" style="color:${t.c}" title="${t.label}">${t.s}</td></tr>`;
  }).join('');
}
function registerCondaEnv() { envOut('<div class="empty">Listing conda envs…</div>'); ask('envCondaList', {}); }
let _condaEnvs = [];
function onCondaList(envs) {
  _condaEnvs = envs || [];
  if (!_condaEnvs.length) { envOut('<div class="empty">No conda envs found (is <code>conda</code> on PATH?).</div>'); return; }
  const opts = _condaEnvs.map((e, i) => `<option value="${i}">${esc(e.name)} — ${esc(e.prefix)}</option>`).join('');
  envOut(`<div class="ec-row" style="margin:10px 0"><select id="conda-pick">${opts}</select><button class="tbtn" onclick="addCondaEnv()">Register</button></div>`);
}
function addCondaEnv() {
  const e = _condaEnvs[+document.getElementById('conda-pick').value];
  if (e) ask('envAdd', { env: { name: e.name, manager: 'conda', python: e.python, path: e.prefix, condaName: e.name } });
}
let _envFolder = '';
function registerFolderEnv() { ask('envPickFolder', {}); }
function onEnvPickFolder(dir) { if (!dir) return; _envFolder = dir; ask('envDetectFolder', { dir }); }
function onEnvFolderDetected(d) {
  if (!d.ok) { vscode.postMessage({ command: 'toast', text: d.error || 'Not a venv/uv folder' }); return; }
  const base = _envFolder.split('/').pop();
  pkModal({ title: 'Register environment', message: `${d.manager} · ${d.python}`, input: true, defaultValue: base, okLabel: 'Register',
    onOk: v => { if (v.trim()) ask('envAdd', { env: { name: v.trim(), manager: d.manager, python: d.python, path: _envFolder } }); } });
}
function editEnv(id) {
  const e = envCache.find(x => x.id === id); if (!e) return;
  pkModal({
    title: 'Edit environment', input: true, defaultValue: e.name,
    textarea: true, textareaValue: e.description || '',
    textareaPlaceholder: 'Description — tags / crucial packages, e.g. torch 2.3, cuda12, vllm, training',
    okLabel: 'Save',
    onOk: (name, desc) => {
      const patch = { description: (desc || '').trim() };
      if (name.trim()) patch.name = name.trim();
      ask('envUpdate', { id, patch });
    }
  });
}
function deleteEnv(id, name) {
  const env = envCache.find(item => item.id === id);
  const isMcpRuntime = env && (env.name === 'PKM MCP Runtime' || /Managed runtime for pkm/.test(env.description || ''));
  pkModal({
    title: 'Delete “' + name + '”?',
    message: (isMcpRuntime ? 'Warning: deleting the PKM MCP Runtime will stop the unified pkm server until you Repair it in the MCP tab.\n\n' : '') + (env?.missing ? 'The environment is already missing on disk. This will clean its stale registration.' : 'Removes it from the tool. Optionally also delete the environment files from disk (irreversible).'),
    checkbox: { label: 'Also delete the environment files from disk', checked: false },
    okLabel: 'Delete', danger: true,
    onOk: (_v, _tv, removeFiles) => ask('envDelete', { id, removeFiles: !!removeFiles })
  });
}
// ── Create a new environment ─────────────────────────────────────────────────
function newEnvForm() {
  envOut(`
  <div class="srv-edit" style="margin-top:10px">
    <b>✨ Create a new environment</b>
    <div class="form-row"><label>Type</label>
      <select id="ne-mgr" onchange="updateNewEnvFields()">
        <option value="conda">conda</option>
        <option value="venv">venv (python -m venv)</option>
        <option value="uv">uv (uv venv)</option>
      </select>
    </div>
    <div class="form-row"><label>Name</label><input id="ne-name" placeholder="my-env"></div>
    <div class="form-row" id="ne-ver-row"><label>Python version</label><input id="ne-ver" placeholder="e.g. 3.11 (optional)"></div>
    <div class="form-row" id="ne-base-row" style="display:none"><label>Base interpreter</label><input id="ne-base" placeholder="python3"></div>
    <div class="form-row" id="ne-dir-row" style="display:none"><label>Parent folder</label>
      <span style="display:flex;gap:6px;flex:1"><input id="ne-dir" placeholder="/path/to/parent" style="flex:1"><button class="tbtn" onclick="ask('envCreatePickDir',{})" title="Browse">📁</button></span>
    </div>
    <div class="form-row"><label>Description</label><input id="ne-desc" placeholder="tags / crucial packages (optional)"></div>
    <div id="ne-msg" style="font-size:11px;color:var(--muted)"></div>
    <div class="ec-row"><span style="flex:1"></span>
      <button class="tbtn" onclick="envOut('')">Cancel</button>
      <button class="tbtn" style="border-color:var(--accent)" onclick="submitNewEnv()">Create</button>
    </div>
  </div>`);
  updateNewEnvFields();
}
function updateNewEnvFields() {
  const m = (document.getElementById('ne-mgr') || {}).value;
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
  show('ne-dir-row', m !== 'conda');       // venv/uv need a parent folder
  show('ne-base-row', m === 'venv');        // venv picks a base interpreter
  show('ne-ver-row', m !== 'venv');         // conda/uv accept a version string
}
function submitNewEnv() {
  const g = id => ((document.getElementById(id) || {}).value || '').trim();
  const input = { manager: (document.getElementById('ne-mgr') || {}).value, name: g('ne-name'), pythonVersion: g('ne-ver'), parentDir: g('ne-dir'), baseInterpreter: g('ne-base'), description: g('ne-desc') };
  const msg = document.getElementById('ne-msg');
  if (!input.name) { msg.innerHTML = '<span style="color:#f87171">Name is required.</span>'; return; }
  if ((input.manager === 'venv' || input.manager === 'uv') && !input.parentDir) { msg.innerHTML = '<span style="color:#f87171">Parent folder is required.</span>'; return; }
  msg.innerHTML = '<span style="color:var(--muted)">Creating… this can take a minute.</span>';
  ask('envCreate', { input });
}
function onEnvCreated(d) {
  if (d.ok) { envOut(''); return; }
  const el = document.getElementById('ne-msg');
  const err = '<span style="color:#f87171">' + esc(d.error || 'failed') + '</span>' + (d.log ? '<pre class="env-activate" style="margin-top:6px;max-height:160px;overflow:auto">' + esc(d.log) + '</pre>' : '');
  if (el) el.innerHTML = err; else envOut('<div>' + err + '</div>');
}
function onEnvCreatePickDir(d) { if (d && d.dir) { const el = document.getElementById('ne-dir'); if (el) el.value = d.dir; } }
function onEnvDeleteResult(d) {
  if (!d) return;
  if (!d.ok && d.stale) {
    pkModal({
      title: 'Environment is already missing',
      message: 'No environment exists at this disk path:\n\n' + (d.path || '(unknown path)') + '\n\nDelete only the stale PKM Envs registration?',
      okLabel: 'Delete Registration', danger: true,
      onOk: () => ask('envDelete', { id: d.id, removeFiles: false })
    });
    return;
  }
  if (!d.ok) {
    const action = d.filesRequested ? 'Deleting environment files and registration failed.' : 'Removing the environment registration failed.';
    envOut('<div style="color:#f87171"><b>✕ ' + esc(action) + '</b><br>' + esc(d.error || 'No error details were returned.') + (d.path ? '<br><span style="color:var(--muted)">Path:</span> <code>' + esc(d.path) + '</code>' : '') + '</div>');
    return;
  }
  let text = d.filesRequested
    ? (d.filesRemoved ? 'Environment registration and files were deleted.' : d.pathStillExists ? 'Registration removed, but the environment path still exists.' : 'Registration removed; no environment files remained.')
    : 'Environment was unregistered. Files were left on disk.';
  envOut('<div style="color:' + (d.pathStillExists && d.filesRequested ? '#f4b400' : '#4ade80') + '">✓ ' + esc(text) + (d.path ? '<br><code>' + esc(d.path) + '</code>' : '') + '</div>');
  if (d.path && /[\\/]pkm-mcp$/.test(d.path)) setTimeout(() => ask('checkMcp', {}), 100);
}
function deleteEnvScript(id) { ask('envDeleteScript', { id }); }
function onEnvDeleteScript(d) {
  if (d.error) { envOut('<div style="color:#f87171">' + esc(d.error) + '</div>'); return; }
  envOut(`<div class="ec-row" style="margin:10px 0 6px"><b>🧾 Delete script</b><span style="font-size:11px;color:var(--muted)">copied to clipboard — review and run it yourself; the extension will not execute it</span></div><pre class="env-activate">${esc(d.script)}</pre>`);
}

