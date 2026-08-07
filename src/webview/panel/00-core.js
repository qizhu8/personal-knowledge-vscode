const vscode = acquireVsCodeApi();
// CDN libs may be unavailable in offline/remote environments — use safe fallbacks
try { if (typeof marked !== 'undefined') marked.setOptions({ breaks: true }); } catch(e) {}
// KaTeX math support for marked: $$...$$ (block) and $...$ (inline). marked
// tokenizes code fences/spans first, so `$` inside code is left untouched.
function renderMath(tex, display) {
  try { return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: false }); }
  catch (e) { return '<code class="math-error">' + String(tex).replace(/</g,'&lt;') + '</code>'; }
}
try {
  if (typeof marked !== 'undefined' && typeof katex !== 'undefined') {
    marked.use({ extensions: [
      { name: 'blockMath', level: 'block',
        start(src) { const i = src.indexOf('$$'); return i < 0 ? undefined : i; },
        tokenizer(src) { const m = /^\$\$([\s\S]+?)\$\$/.exec(src); if (m) return { type: 'blockMath', raw: m[0], text: m[1].trim() }; },
        renderer(t) { return '<div class="math-block">' + renderMath(t.text, true) + '</div>'; } },
      { name: 'inlineMath', level: 'inline',
        start(src) { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
        tokenizer(src) { const m = /^\$(?!\$)((?:\\.|[^$\\])+?)\$(?!\d)/.exec(src); if (m && m[1].trim()) return { type: 'inlineMath', raw: m[0], text: m[1].trim() }; },
        renderer(t) { return renderMath(t.text, false); } },
    ] });
  }
} catch(e) {}
// Wiki links [[Title]] / [[Title|alias]] as a marked INLINE extension. Because
// marked tokenizes code fences/spans first, [[...]] inside code (e.g. a mermaid
// `[[Kafka]]` subroutine node) is left untouched instead of being rewritten to
// an <a> tag, which previously corrupted diagrams and code blocks.
try {
  if (typeof marked !== 'undefined') {
    marked.use({ extensions: [
      { name: 'wikiLink', level: 'inline',
        start(src) { const i = src.indexOf('[['); return i < 0 ? undefined : i; },
        tokenizer(src) { const m = /^\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/.exec(src); if (m) return { type: 'wikiLink', raw: m[0], target: m[1].trim(), label: (m[2] || m[1]).trim() }; },
        renderer(t) { const e = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); return '<a href="#" class="wikilink" data-note="' + e(t.target) + '">' + e(t.label) + '</a>'; } },
    ] });
  }
} catch(e) {}
// Base URI for note image assets; `_assets/...` refs are rewritten relative to
// the note's OWN folder (its category path), matching the on-disk convention
// notes/<category>/_assets/<file> so links stay portable (Obsidian-style).
const NOTES_BASE = document.querySelector('meta[name="pkm-notes-base"]')?.content || '';
// Cache-buster for note/paper `_assets/` images. Seeded uniquely and bumped on
// every detail render + Refresh, so a newly-added image is never blocked by a
// stale (or negative/404) webview resource cache entry from an earlier render.
let renderNonce = Date.now();
function assetBase(category) {
  const cat = String(category || '').split('/').map(s => s.trim()).filter(Boolean).map(encodeURIComponent).join('/');
  return cat ? NOTES_BASE + '/' + cat : NOTES_BASE;
}
function fixAssets(html, category) {
  const base = assetBase(category);
  return String(html).replace(/(src|href)=("|')_assets\/([^"']+)\2/g, function(m, attr, q, file) {
    const sep = file.indexOf('?') < 0 ? '?_r=' : '&_r=';
    return attr + '=' + q + base + '/_assets/' + file + sep + renderNonce + q;
  });
}
// Wiki links are handled by the `wikiLink` marked extension above (code-safe).
function safeMarked(text, category) {
  try { return styleTasks(fixAssets(typeof marked !== 'undefined' ? marked.parse(text||'') : '<pre>' + esc(text||'') + '</pre>', category)); }
  catch(e) { return '<pre>' + esc(text||'') + '</pre>'; }
}
// Turn task-list markers into clearly-coloured status badges so checked/unchecked
// and the custom [~]/[!] states are distinguishable in any theme. marked emits
// disabled checkboxes for [ ]/[x]; [~]/[!] arrive as literal text at li start.
function styleTasks(html) {
  return String(html)
    .replace(/<li>\s*<input(?=[^>]*\bchecked\b)[^>]*type="checkbox"[^>]*>\s*/g, '<li class="tk tk-done"><span class="tkm">\u2713</span>')
    .replace(/<li>\s*<input(?![^>]*\bchecked\b)[^>]*type="checkbox"[^>]*>\s*/g, '<li class="tk tk-todo"><span class="tkm"></span>')
    .replace(/<li>\s*\[~\]\s*/g, '<li class="tk tk-prog"><span class="tkm">~</span>')
    .replace(/<li>\s*\[!\]\s*/g, '<li class="tk tk-block"><span class="tkm">!</span>');
}
function safeHljs(el) { try { if (typeof hljs !== 'undefined') hljs.highlightElement(el); } catch(e) {} }
// ── Mermaid diagrams (```mermaid fenced blocks) ─────────────────────────────
let _mermaidReady = false;
function initMermaidOnce() {
  if (_mermaidReady || typeof mermaid === 'undefined') return _mermaidReady;
  try {
    const light = /vscode-light|vscode-high-contrast-light/.test(document.body.className || '');
    // 'antiscript' keeps <b>/<br/> HTML labels working while stripping <script>.
    mermaid.initialize({ startOnLoad: false, suppressErrorRendering: true, securityLevel: 'antiscript', theme: light ? 'default' : 'dark', fontFamily: 'inherit' });
    _mermaidReady = true;
  } catch (e) {}
  return _mermaidReady;
}
let _mmSeq = 0;
// Replace each mermaid code block inside `root` with a rendered SVG diagram.
// Returns a promise that resolves once every diagram in `root` has rendered,
// so callers (e.g. HTML export) can await fully-inlined SVGs.
function renderMermaid(root) {
  if (!root || typeof mermaid === 'undefined' || !initMermaidOnce()) return Promise.resolve();
  const jobs = [];
  root.querySelectorAll('code.language-mermaid').forEach(code => {
    const pre = code.closest('pre') || code;
    const src = code.textContent || '';
    const holder = document.createElement('div');
    holder.className = 'mermaid-diagram';
    pre.replaceWith(holder);
    const id = 'mmd-' + (++_mmSeq);
    const cleanupTemporaryNodes = () => {
      Array.from(document.body.children).forEach(el => {
        if (el !== root && (el.id === id || el.id === 'd' + id || el.id === 'i' + id || el.querySelector('[id="' + id + '"]'))) el.remove();
      });
    };
    jobs.push(Promise.resolve().then(() => mermaid.render(id, src)).then(res => {
      cleanupTemporaryNodes();
      holder.innerHTML = res.svg;
      if (res.bindFunctions) res.bindFunctions(holder);
    }).catch(err => {
      cleanupTemporaryNodes();
      holder.className = 'mermaid-diagram mermaid-error';
      const message = String(err && err.message ? err.message : err || 'Invalid diagram').split('\n')[0].slice(0, 500);
      holder.textContent = 'Mermaid syntax error: ' + message;
    }));
  });
  return Promise.all(jobs);
}
const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const ICON = {todo:'☐',done:'✓','data-path':'📂',observation:'👁',general:'📝'};

let state = { tab:'skills', filter:'all', search:'', items:[], folders:[], active:null };
let ctxTarget = null; // slug of note under right-click
let ctxPinned = false; // pinned state of the note under right-click
let notePinnedFolders = []; // note folder paths pinned to the top of their level
let currentDetail = null; // current detail item for edit/delete actions
let catExpanded = {}; // expanded state per folder key (default: collapsed)
let pendingEditSlug = null; // note slug awaiting detail load for edit
let pendingEditType = null; // item type awaiting detail load to enter edit mode (from tree right-click)
let searchDebounce = null; // debounce timer for search

// ── Context menu ──────────────────────────────────────────────────────────
const ctxMenu = document.getElementById('ctx-menu');

document.getElementById('item-list').addEventListener('contextmenu', e => {
  const li = e.target.closest('.li[data-note-slug]');
  if (!li) return;
  e.preventDefault();
  ctxTarget = li.dataset.noteSlug;
  ctxPinned = li.dataset.notePinned === '1';
  const pinItem = document.getElementById('ctx-pin');
  if (pinItem) pinItem.textContent = ctxPinned ? '★ Unpin' : '☆ Pin';
  ctxMenu.style.left = e.clientX + 'px';
  ctxMenu.style.top  = e.clientY + 'px';
  ctxMenu.classList.add('open');
});

// Right-click blank space in a content list -> create a top-level item/folder.
document.getElementById('item-list').addEventListener('contextmenu', e => {
  if (!['skills', 'notes', 'papers', 'prompts', 'scripts'].includes(state.tab)) return;
  if (e.target.closest('.li') || e.target.closest('.tree-cat-hdr')) return;  // items/folders have their own menus
  e.preventDefault();
  const area = state.tab;
  const items = [];
  if (area === 'skills') items.push({ label: '＋ New Skill…', onClick: () => ask('createKnowledgeItem', { area: 'skills', category: '' }) });
  if (area === 'notes') items.push({ label: '＋ New Note…', onClick: () => ask('createKnowledgeItem', { area: 'notes', category: '' }) });
  if (area === 'papers') {
    items.push({ label: '＋ New Paper…', onClick: () => ask('createKnowledgeItem', { area: 'papers', kind: 'paper', category: '' }) });
    items.push({ label: '💡 New Idea…', onClick: () => ask('createKnowledgeItem', { area: 'papers', kind: 'idea', category: '' }) });
  }
  if (area === 'prompts') items.push({ label: '＋ New Prompt…', onClick: () => ask('createPromptItem', {}) });
  if (area === 'scripts') items.push({ label: '＋ New Script…', onClick: () => ask('createScript', { folder: '' }) });
  if (area === 'skills' || area === 'notes') items.push({ label: '➕ Create Folder…', onClick: () => pkModal({
      title: 'Create folder', message: 'New top-level folder in ' + area + '.',
      input: true, okLabel: 'Create', onOk: v => { const n = v.trim(); if (n) ask('folderCreate', { area, parent: '', name: n }); } }) }
  );
  showPaperMenu(e.clientX, e.clientY, items);
});

document.addEventListener('click', () => ctxMenu.classList.remove('open'));
document.addEventListener('contextmenu', e => {
  if (!e.target.closest('#item-list .li[data-note-slug]')) ctxMenu.classList.remove('open');
});

// Cross-note links: [[Title]] (data-note) and relative/absolute .md links open the target note
document.getElementById('detail').addEventListener('click', e => {
  const a = e.target.closest('a');
  if (!a) return;
  const from = (currentDetail && currentDetail.type === 'note') ? currentDetail.slug : '';
  const wiki = a.getAttribute('data-note');
  if (wiki) { e.preventDefault(); ask('resolveNoteLink', { target: wiki, from, wiki: true }); return; }
  const href = a.getAttribute('href') || '';
  // Skip real URL schemes (http:, mailto:, vscode-webview:, …); allow bare
  // relative paths and absolute filesystem paths that point at a .md note.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && /\.md($|[?#])/i.test(href)) {
    e.preventDefault();
    ask('resolveNoteLink', { target: href, from });
  }
});

document.getElementById('ctx-open').addEventListener('click', () => {
  if (ctxTarget) openItem('note', ctxTarget);
});
document.getElementById('ctx-pin').addEventListener('click', () => {
  if (ctxTarget) { ask('noteSetPinned', { slug: ctxTarget, pinned: !ctxPinned }); ctxTarget = null; }
});
document.getElementById('ctx-mark-done').addEventListener('click', () => {
  if (ctxTarget) { ask('markDone', { slug: ctxTarget }); ctxTarget = null; }
});
document.getElementById('ctx-delete').addEventListener('click', () => {
  if (ctxTarget) { ask('deleteNote', { slug: ctxTarget }); ctxTarget = null; }
});
document.getElementById('ctx-edit').addEventListener('click', () => {
  if (ctxTarget) { openMarkdownItem('notes', '', ctxTarget); ctxTarget = null; }
});
document.getElementById('ctx-move').addEventListener('click', () => {
  if (!ctxTarget) return;
  const slug = ctxTarget; ctxTarget = null;
  const cat = slug.includes('/') ? slug.slice(0, slug.lastIndexOf('/')) : '';
  pkModal({ title: 'Move note', message: 'Target folder path (blank = root; missing parents are created).', input: true, defaultValue: cat, okLabel: 'Move', onOk: v => ask('noteMove', { slug, category: v.trim() }) });
});

// ── Message from extension ─────────────────────────────────────────────────
window.addEventListener('message', e => {
  const { command, data } = e.data;
  // Dismiss loading banner on first response
  if (command === 'list') {
    const banner = document.getElementById('loading-banner');
    if (banner && !banner.classList.contains('hidden')) {
      banner.classList.add('hidden');
      setTimeout(() => banner.remove(), 400);
    }
  }
  if      (command === 'list')     { state.items = data; state.folders = e.data.folders || []; renderList(); }
  else if (command === 'detail') {
    if (pendingEditSlug && data?.type === 'note' && data.slug === pendingEditSlug) {
      pendingEditSlug = null; editNote(data);
    } else {
      renderDetail(data);
      // Enter edit mode if this detail was opened via a tree "Edit" action
      if (pendingEditType && data && data.type === pendingEditType) {
        const t = pendingEditType; pendingEditType = null;
        setTimeout(() => {
          if (t === 'skill')  openMarkdownItem('skills', data.category, data.name);
          else if (t === 'note')   openMarkdownItem('notes', '', data.slug);
          else if (t === 'paper')  openMarkdownItem('papers', '', data.slug);
          else if (t === 'script') startEditScript();
        }, 30);
      }
    }
  }
  else if (command === 'saved')    { ask('list', { tab: state.tab, filter: state.filter, q: state.search }); if (state.tab === 'papers') { ask('paperGroups', {}); ask('paperFacets', {}); } }
  else if (command === 'noteFolderPins') {
    notePinnedFolders = e.data.data || [];
    if (state.tab === 'notes') renderList();
  }
  else if (command === 'assetSaved') {
    const cb = pendingAssets[e.data.reqId];
    if (cb) { delete pendingAssets[e.data.reqId]; cb(e.data.markdown, e.data.error); }
  }
  else if (command === 'noteLinkMissing') {
    vscode.postMessage({ command: 'toast', text: 'No note found for “' + (e.data.target || '') + '”' });
  }
  else if (command === 'linkedNotes') { renderLinkedExport(e.data); }
  else if (command === 'envList') {
    envCache = data || [];
    if (state.tab === 'environments') renderEnvDashboard(envCache);
    const refresh = document.querySelector('#topbar .tbtn[onclick="doReload()"]');
    if (refresh) { refresh.disabled = false; refresh.textContent = '↻ Refresh'; }
  }
  else if (command === 'envPackages') { onEnvPackages(e.data); }
  else if (command === 'envCompare') { renderEnvCompare(data); }
  else if (command === 'envSimilarity') { renderEnvSimilarity(data); }
  else if (command === 'envMergeScript') { onEnvMergeScript(e.data); }
  else if (command === 'envSize') { onEnvSize(e.data); }
  else if (command === 'envActivate') { onEnvActivate(e.data); }
  else if (command === 'envCreated') { onEnvCreated(e.data); }
  else if (command === 'envCreatePickDir') { onEnvCreatePickDir(e.data); }
  else if (command === 'envDeleteResult') { onEnvDeleteResult(e.data); }
  else if (command === 'envMigrated') { onEnvMigrated(e.data); }
  else if (command === 'envDeleteScript') { onEnvDeleteScript(e.data); }
  else if (command === 'envCondaList') { onCondaList(data); }
  else if (command === 'envDetectFolder') { onEnvFolderDetected(e.data.data); }
  else if (command === 'envPickFolder') { onEnvPickFolder(e.data.dir); }
  else if (command === 'serverList') { serverCache = data || []; if (state.tab === 'servers') renderServerDashboard(serverCache); }
  else if (command === 'serverLog') { onServerLog(e.data.slug, e.data.text); }
  else if (command === 'serverPickFolder') { onServerPickFolder(e.data.dir); }
  else if (command === 'paperFacets') {
    paperFacetsData = e.data.data || { topics: [], tags: [], years: [] };
    if (state.tab === 'papers' && !paperGraphOpen) renderPaperFilters(document.getElementById('sidebar-filters'));
    if (paperGraphOpen) populatePaperTopicSelect();
  }
  else if (command === 'paperGroups') {
    paperGroupsList = (e.data.data && e.data.data.length) ? e.data.data : [{ name: 'Papers', count: 0 }];
  }
  else if (command === 'paperPicker') {
    const draft = readPaperCites();
    paperPickerItems = e.data.data || [];
    if (!document.getElementById('paper-form').classList.contains('hidden')) renderPaperCites(draft);
  }
  else if (command === 'paperGraph') { renderPaperGraph(e.data.data); }
  else if (command === 'paperFileSaved') {
    if (pendingPaperFile) { const cb = pendingPaperFile; pendingPaperFile = null; cb(e.data.file, e.data.error); }
  }
  else if (command === 'reloaded') {
    renderNonce++; // force cached note images to reload after external regeneration
    ask('list', { tab: state.tab, filter: state.filter, q: state.search });
    // Re-render the currently open note/skill so external edits and regenerated
    // images (same path) are picked up, not just the sidebar list.
    if (currentDetail && currentDetail.type === 'note' && currentDetail.slug) {
      ask('detail', { type: 'note', key: currentDetail.slug });
    } else if (currentDetail && currentDetail.type === 'skill' && currentDetail.name) {
      ask('detail', { type: 'skill', key: currentDetail.name });
    }
    const btn = document.querySelector('#topbar .tbtn[onclick="doReload()"]');
    if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh'; }
  }
  else if (command === 'exported') {
    const a = document.createElement('a');
    a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data, null, 2));
    a.download = 'pkm-export-' + new Date().toISOString().slice(0,10) + '.json';
    a.click();
  }
  // ── Sync responses ──────────────────────────────────────────────────────
  else if (command === 'syncContentList') {
    buildTypeSections(data);
  }
  else if (command === 'syncSkillList') {
    // legacy fallback — ignored now
  }
  else if (command === 'syncStarted') {
    const s = data;
    const code = s.magicCode || '';
    document.getElementById('sm-cred-result').innerHTML = `
      <div class="cred-box">
        <div style="font-size:11px;color:#4ade80;margin-bottom:8px">✅ Magic Code active — share it with the recipient:</div>
        <div class="cred-row"><span class="cred-label">Magic Code</span><span class="cred-val" title="One-paste Magic Code">${esc(code)}</span><button class="cred-copy" onclick="navigator.clipboard.writeText('${esc(code)}')">Copy</button></div>
        <div style="font-size:10px;color:var(--muted);margin:2px 0 8px">This code grants temporary access to the selected content. Share it securely.</div>
        <div class="cred-row"><span class="cred-label">Expires</span><span class="cred-val">${new Date(s.expires).toLocaleTimeString()}</span></div>
        <div class="cred-row"><span class="cred-label">Shares</span><span class="cred-val">${esc(s.summary || 'nothing selected')}</span></div>
      </div>`;
  }
  else if (command === 'syncMagicCodeVerified') {
    const input = document.getElementById('join-code');
    const status = document.getElementById('join-code-verification');
    const button = document.getElementById('join-download');
    if (data.ok) {
      input.dataset.verifiedValue = input.value.trim();
      status.innerHTML = '<span style="color:#4ade80">✓ Checksum and encryption authentication verified.</span>';
      button.disabled = false;
    } else {
      delete input.dataset.verifiedValue;
      status.innerHTML = `<span style="color:#f87171">✕ ${esc(data.error || 'Magic Code verification failed.')}</span>`;
      button.disabled = true;
    }
  }
  else if (command === 'syncJoined')   {
    document.getElementById('join-result').innerHTML =
      `<span style="color:#4ade80">✅ Synced from ${esc(data.from)}: ${esc(data.summary||data.count+' items')}${data.group ? ' → group “'+esc(data.group)+'” (review &amp; merge offline)' : ''}</span>`;
  }
  else if (command === 'mcpStatus')    { renderMcpPane(data); }
  else if (command === 'chatReadReceipt') { chatUpdateReadReceipt(data); }
  else if (command === 'mcpPythonResult') { renderMcpPythonResult(data); }
  else if (command === 'mcpPythonCandidates') { renderMcpPythonCandidates(data); }
  else if (command === 'mcpPythonScanStarted') { startMcpPythonScan(data); }
  else if (command === 'mcpPythonCandidate') { appendMcpPythonCandidate(data); }
  else if (command === 'mcpPythonScanProgress') { updateMcpPythonScan(data); }
  else if (command === 'mcpPythonScanComplete') { finishMcpPythonScan(data); }
  else if (command === 'mcpRuntimeProgress') { renderMcpRuntimeProgress(data); }
  else if (command === 'mcpRuntimeResult') { renderMcpRuntimeResult(data); }
  else if (command === 'mcpGenerated') { renderMcpGenerated(data); }
  else if (command === 'mcpError')     {
    const el = document.getElementById('mcp-result');
    if (el) el.innerHTML = `<span style="color:#f87171">❌ ${esc(data.error)}</span>`;
  }
  else if (command === 'aiBackends') { renderAiBackends(data.backends); }
  else if (command === 'aiSummary') {
    if (data.miss) return; // cache-only peek with no cached summary — leave the panel as-is
    const box = document.getElementById('ai-summary');
    if (box) {
      if (data.error) {
        box.innerHTML = `<div style="padding:12px 14px;margin:12px 0;border:1px solid #f87171;border-radius:8px">
          <span style="color:#f87171;font-size:12px">❌ ${esc(data.error)}${data.backend?' ('+esc(data.backend)+')':''}</span></div>`;
      } else {
        // Strip the machine-readable header comment before rendering
        const body = (data.summary||'').replace(/^<!--[^>]*-->\s*/, '');
        box.innerHTML = `<div style="padding:14px 16px;margin:12px 0;border:1px solid var(--accent);border-radius:8px;background:var(--panel)">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--accent);margin-bottom:8px">✨ AI Summary${data.cached?' (cached)':''}${data.backend?' · '+esc(data.backend):''}</div>
          <div class="prose" style="font-size:13px">${safeMarked(body)}</div></div>`;
        postProcess();
      }
    }
  }
  else if (command === 'scriptSaved') {
    if (data.error) { alert('Save failed: ' + data.error); return; }
    if (data.cancelled) return; // user declined confirmation — stay in editor
    if (data.ok && data.path) ask('detail', { type: 'script', key: data.path }); // reload saved script
  }
  else if (command === 'metadataUpdateResult') {
    if (!data.ok) pkModal({ title: 'Duplicate name', message: data.error || 'Metadata could not be saved.', okLabel: 'OK' });
  }
  else if (command === 'openItem') {
    // Navigate to a specific item (triggered from sidebar tree view).
    // NOTE: type/key are top-level on the message, not under `data`.
    const itemType = e.data.type, itemKey = e.data.key, wantEdit = e.data.edit;
    const TAB = { note:'notes', skill:'skills', paper:'papers', prompt:'prompts', package:'packages', script:'scripts', packageFile:'packages' };
    const tabName = TAB[itemType] || 'skills';
    const btn = document.querySelector(`.tab[data-tab="${tabName}"]`);
    if (btn) btn.dispatchEvent(new MouseEvent('click'));
    pendingEditType = wantEdit ? itemType : null; // enter edit mode once detail loads
    setTimeout(() => ask('detail', { type: itemType, key: itemKey }), 150);
  }
  else if (command === 'openTab') {
    const btn = document.querySelector(`.tab[data-tab="${e.data.tab}"]`);
    if (btn) btn.dispatchEvent(new MouseEvent('click'));
  }
  else if (command === 'chatConfig') { chatOnConfig(data); }
  else if (command === 'chatState')  { chatOnState(data); }
  else if (command === 'chatRecents'){ chatOnRecents(data); }
  else if (command === 'chatMessage'){ chatOnMessage(data); }
  else if (command === 'chatAgentState'){ chatOnAgentState(data); }
  else if (command === 'chatFileReady') { chatOnFileReady(data); }
  else if (command === 'chatToast')  { chatToast(data && data.error); }
  else if (command === 'chatSecret') { chatOnSecret(data && data.secret); }
  else if (command === 'chatHubResult') { chatOnHubResult(data); }
  else if (command === 'syncError') {
    const errEl = smCurrentTab === 'join'
      ? document.getElementById('join-result')
      : document.getElementById('sm-cred-result');
    if (errEl) errEl.innerHTML = `<span style="color:#f87171">❌ ${esc(data.error)}</span>`;
  }
});

function ask(command, payload) { vscode.postMessage({ command, ...payload }); }

// ── Topbar overflow: sliding tabs + collapsing action buttons ───────────
function scrollTabs(dir) { const t = document.getElementById('tabs'); if (t) t.scrollBy({ left: dir * 160, behavior: 'smooth' }); }
function updateTabNav() {
  const t = document.getElementById('tabs'); if (!t) return;
  const over = t.scrollWidth > t.clientWidth + 2;
  const l = document.getElementById('tab-left'), r = document.getElementById('tab-right');
  if (l) l.style.display = over ? '' : 'none';
  if (r) r.style.display = over ? '' : 'none';
}
function sortToolbar() {
  const tb = document.getElementById('toolbar'); if (!tb) return;
  [...tb.children].sort((a, b) => (+a.dataset.ord || 0) - (+b.dataset.ord || 0)).forEach(c => tb.appendChild(c));
}
function layoutTopbar() {
  const topbar = document.getElementById('topbar'), tb = document.getElementById('toolbar'),
        menu = document.getElementById('more-menu'), moreBtn = document.getElementById('more-btn');
  if (!topbar || !tb || !menu || !moreBtn) return;
  while (menu.firstChild) tb.appendChild(menu.firstChild);
  sortToolbar();
  moreBtn.style.display = 'none';
  updateTabNav();
  let guard = 40;
  while (topbar.scrollWidth > topbar.clientWidth + 1 && guard-- > 0) {
    const vis = [...tb.children].filter(b => b.offsetParent !== null);
    if (!vis.length) break;
    menu.insertBefore(vis[vis.length - 1], menu.firstChild);
    moreBtn.style.display = '';
  }
  updateTabNav();
}
function relayoutTopbar() { requestAnimationFrame(layoutTopbar); }
function toggleMoreMenu(e) { if (e) e.stopPropagation(); const m = document.getElementById('more-menu'); if (m) m.classList.toggle('open'); }
document.addEventListener('click', e => {
  const menu = document.getElementById('more-menu'); if (!menu || !menu.classList.contains('open')) return;
  const wrap = document.getElementById('more-wrap');
  if (!wrap) return;
  if (wrap.contains(e.target) && e.target.id !== 'more-btn') setTimeout(() => menu.classList.remove('open'), 0);
  else if (!wrap.contains(e.target)) menu.classList.remove('open');
});
if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => relayoutTopbar());
  const el = document.getElementById('topbar'); if (el) ro.observe(el);
}
(() => {
  const t = document.getElementById('tabs'); if (!t) return;
  t.addEventListener('scroll', updateTabNav, { passive: true });
  t.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { t.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
})();
relayoutTopbar();

function initColumnResizer(handleId, targetId, storageKey, minWidth, maxWidth, direction, useFlex) {
  const handle = document.getElementById(handleId);
  const target = document.getElementById(targetId);
  if (!handle || !target || handle.dataset.resizeBound) return;
  handle.dataset.resizeBound = '1';
  const applyWidth = width => {
    const value = Math.max(minWidth, Math.min(maxWidth, width));
    if (useFlex) target.style.flex = '0 0 ' + value + 'px';
    else target.style.width = value + 'px';
  };
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (saved) applyWidth(saved);
  } catch (e) {}
  handle.addEventListener('mousedown', e => {
    const startX = e.clientX;
    const startWidth = target.getBoundingClientRect().width;
    handle.classList.add('active');
    document.body.classList.add('column-resizing');
    const move = ev => {
      const parentLimit = Math.max(minWidth, (target.parentElement?.clientWidth || maxWidth) - 120);
      applyWidth(Math.min(parentLimit, startWidth + (ev.clientX - startX) * direction));
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      handle.classList.remove('active');
      document.body.classList.remove('column-resizing');
      try { localStorage.setItem(storageKey, String(Math.round(target.getBoundingClientRect().width))); } catch (e) {}
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    e.preventDefault();
  });
}

initColumnResizer('layout-resizer', 'sidebar', 'pk-main-sidebar', 150, 600, 1, false);
initColumnResizer('note-split-resizer', 'note-editor-pane', 'pk-note-editor', 140, 1000, 1, true);
initColumnResizer('paper-split-resizer', 'pf-content', 'pk-paper-editor', 140, 1000, 1, true);

