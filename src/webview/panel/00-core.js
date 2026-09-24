const vscode = acquireVsCodeApi();
window.addEventListener('error', event => vscode.postMessage({
  command: 'webviewDiagnostic', kind: 'error', message: `${event.message || 'window error'} @ ${event.filename || '?'}:${event.lineno || 0}`,
}));
window.addEventListener('unhandledrejection', event => vscode.postMessage({
  command: 'webviewDiagnostic', kind: 'unhandledrejection', message: String(event.reason?.stack || event.reason || 'unknown rejection'),
}));
setInterval(() => { if (document.visibilityState === 'visible') vscode.postMessage({ command: 'webviewDiagnostic', kind: 'heartbeat' }); }, 120000);
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
function fileSelectorCategoryTree(items) {
  const root = { folders:{}, items:[] };
  for (const item of items) {
    const parts = String(item.treePath ?? item.cat ?? '').split('/').map(part => part.trim()).filter(Boolean);
    let node = root;
    for (const part of parts) node = node.folders[part] ||= { folders:{}, items:[] };
    node.items.push(item);
  }
  return root;
}
function fileSelectorTreeItems(node) { return [...node.items, ...Object.values(node.folders).flatMap(fileSelectorTreeItems)]; }
const uiIcon = (name, label = '') => `<span class="codicon codicon-${name}" aria-hidden="true"></span>${label ? `<span>${esc(label)}</span>` : ''}`;
const ICON = {todo:uiIcon('circle-outline'),done:uiIcon('pass-filled'),'data-path':uiIcon('folder'),observation:uiIcon('eye'),general:uiIcon('note')};
const surfacePanelTitles = { skills:'Skills', notes:'Notes', papers:'Research', agentSessions:'Agent Sessions', recipes:'Recipe Library', prompts:'Prompts', scripts:'Scripts', packages:'Packages', environments:'Environments', servers:'Servers', projects:'Projects', chatroom:'Threads', subscriptions:'Network & Sharing', githubSync:'GitHub Sync', mcp:'General & MCP', skillRouter:'Skill Router' };
let lastPanelTitle = '';
function setPanelTitle(title) {
  const next = String(title || 'Personal Knowledge Manager').trim();
  if (!next || next === lastPanelTitle) return;
  lastPanelTitle = next;
  document.title = next;
  vscode.postMessage({ command:'setPanelTitle', title:next });
}
function detailPanelTitle(data) {
  if (!data) return surfacePanelTitles[state.tab] || 'Personal Knowledge Manager';
  if (data.type === 'skill') return data.name;
  if (data.type === 'note' || data.type === 'paper' || data.type === 'subscription') return data.title;
  if (data.type === 'prompt') return data.meta?.title || data.file || data.task;
  if (data.type === 'promptDiff') return `${data.file || data.task || 'Prompt'} · Compare`;
  if (data.type === 'package') return data.name;
  if (data.type === 'script') return data.file || String(data.path || '').split('/').pop();
  return surfacePanelTitles[state.tab] || 'Personal Knowledge Manager';
}

let uiI18n = (() => {
  try {
    const encoded = atob(document.querySelector('meta[name="pkm-i18n"]')?.content || '');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(encoded, character => character.charCodeAt(0))));
  }
  catch { return { setting: 'en', resolved: 'en', catalogs: { en: { strings: {} } } }; }
})();
const i18nOriginalText = new WeakMap();
const i18nOriginalAttrs = new WeakMap();
let i18nScheduled = false;

function i18nStrings(locale = uiI18n.resolved) { return uiI18n.catalogs?.[locale]?.strings || {}; }
function t(key, params = {}) {
  let value = i18nStrings()[key] || i18nStrings('en')[key] || key;
  Object.entries(params).forEach(([name, replacement]) => { value = value.replaceAll(`{${name}}`, String(replacement)); });
  return value;
}
function i18nEnglishLookup() {
  return new Map(Object.entries(i18nStrings('en')).map(([key, value]) => [value, key]));
}
function i18nElementParams(element) {
  const params = {};
  for (const attribute of element.attributes || []) {
    if (attribute.name.startsWith('data-i18n-param-')) params[attribute.name.slice(16)] = attribute.value;
  }
  return params;
}
function translateUiNode(node, lookup) {
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentElement;
    if (!parent || parent.closest('script,style,code,pre,textarea,option[data-i18n-skip]')) return;
    if (!i18nOriginalText.has(node)) i18nOriginalText.set(node, node.nodeValue || '');
    const original = i18nOriginalText.get(node) || '';
    const trimmed = original.trim();
    const key = lookup.get(trimmed);
    if (!key) return;
    const translated = t(key);
    const next = original.replace(trimmed, translated);
    if (node.nodeValue !== next) node.nodeValue = next;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node;
  const explicitKey = element.getAttribute('data-i18n');
  if (explicitKey) {
    const translated = t(explicitKey, i18nElementParams(element));
    if (element.textContent !== translated) element.textContent = translated;
  }
  for (const attribute of ['title','placeholder','aria-label']) {
    const key = element.getAttribute(`data-i18n-${attribute}`);
    if (key && element.getAttribute(attribute) !== t(key)) element.setAttribute(attribute, t(key));
  }
  let originals = i18nOriginalAttrs.get(element);
  if (!originals) { originals = {}; i18nOriginalAttrs.set(element, originals); }
  for (const attribute of ['title','placeholder','aria-label']) {
    if (!element.hasAttribute(attribute)) continue;
    if (!(attribute in originals)) originals[attribute] = element.getAttribute(attribute) || '';
    const key = lookup.get(originals[attribute]);
    if (key && element.getAttribute(attribute) !== t(key)) element.setAttribute(attribute, t(key));
  }
}
function translateUi(root = document.body) {
  if (!root) return;
  const lookup = i18nEnglishLookup();
  translateUiNode(root, lookup);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) translateUiNode(walker.currentNode, lookup);
  document.documentElement.lang = uiI18n.resolved;
}
function scheduleUiTranslation() {
  if (i18nScheduled) return;
  i18nScheduled = true;
  requestAnimationFrame(() => { i18nScheduled = false; translateUi(); });
}
function applyUiLanguage(payload) {
  uiI18n = Object.assign({}, uiI18n, payload || {});
  refreshEmptyDetailHint();
  translateUi();
  const locale = (uiI18n.locales || []).find(item => item.id === uiI18n.resolved);
  document.documentElement.dir = locale?.direction || 'ltr';
  const selector = document.getElementById('pkm-language-select');
  if (selector) selector.value = uiI18n.setting || 'auto';
}
function changeUiLanguage(setting) {
  if (uiI18n.catalogs?.[setting]) applyUiLanguage({ setting, resolved: setting });
  ask('setUiLanguage', { language: setting });
}
function languageOptionsHtml() {
  const options = [`<option value="auto" data-i18n="language.auto" ${uiI18n.setting === 'auto' ? 'selected' : ''}>${esc(t('language.auto'))}</option>`];
  for (const locale of uiI18n.locales || []) options.push(`<option value="${esc(locale.id)}" ${uiI18n.setting === locale.id ? 'selected' : ''}>${esc(locale.label)}</option>`);
  return options.join('');
}
new MutationObserver(scheduleUiTranslation).observe(document.body, { childList: true, subtree: true });
scheduleUiTranslation();

const workspaceSurfaces = Object.freeze({
  knowledge:['skills','notes','papers'],
  tools:['prompts','scripts','packages','environments','servers'],
  automation:['agentSessions','agentSnapshots','recipes'],
  projects:['projects','chatroom'],
  settings:['mcp','skillRouter','subscriptions','githubSync']
});
const workspaceDefaultSurface = Object.freeze({ knowledge:'skills', tools:'prompts', automation:'agentSessions', projects:'projects', settings:'mcp' });
function workspaceForTab(tab) {
  return Object.keys(workspaceSurfaces).find(workspace => workspaceSurfaces[workspace].includes(tab)) || 'projects';
}
let state = { workspace:'knowledge', tab:'skills', filter:'all', search:'', items:[], folders:[], subscriptionGroups:[], knowledgeTrash:[], privateTopLevels:[], brokerSharedFolders:{}, active:null };
let initialLoadComplete = false;
let loadingProgressTimer = null;
let loadingRevealTimer = null;
let latestLoadingProgress = null;
let loadingProgressVisible = false;
const pendingActionButtons = new Map();
const actionTimeouts = {
  subscriptionCopyLink:10000, subscriptionConfigure:15000, subscriptionSetOnline:30000, subscriptionSetSharePublished:30000,
  subscriptionUpsertShare:30000, subscriptionDeleteShare:30000, subscriptionAdd:60000,
  subscriptionRename:10000, subscriptionRefresh:60000, subscriptionRemove:30000,
  subscriptionRevealSecret:10000, subscriptionRotateSecret:30000, subscriptionUnblockIp:15000, subscriptionFork:30000, subscriptionOpenServerLink:15000,
  skillTrashRestore:15000, skillTrashDelete:15000, skillTrashEmpty:30000,
  knowledgeTrashMove:15000, knowledgeTrashRestore:15000, knowledgeTrashDelete:15000, knowledgeTrashEmpty:30000,
  serverSubscriptionStatus:15000,
  serverSubscriptionRefresh:60000,
  chatAddManagedAgent:180000,
  agentSnapshotCreate:30000, agentSnapshotDelete:15000,
  recipeOpenBrowser:30000,
  githubSyncSave:30000, githubSyncRun:120000, githubSyncCreateIdentity:30000, githubSyncTestAuthentication:30000,
  mcpRepairRuntime:600000, mcpSetPython:600000, generateMcp:90000,
  checkMcp:15000, mcpDetectPython:60000, refreshMcpPathSizes:30000,
};

function restoreActionButton(entry) {
  clearTimeout(entry.timer);
  if (!entry.button.isConnected) return;
  entry.button.disabled = false;
  entry.button.removeAttribute('aria-busy');
  entry.button.classList.remove('action-pending');
  entry.button.innerHTML = entry.html;
}

function actionMessageHost(button) {
  return button.closest('.sub-editor-actions,.sub-gateway-actions,.sub-add,.sub-row-actions,.pkm-config-actions,.mcp-row-action,.mcp-running') || button.parentElement;
}

function clearActionError(button) {
  actionMessageHost(button)?.parentElement?.querySelectorAll(':scope > .pk-action-error').forEach(error => error.remove());
}

function showActionError(button, message) {
  const host = actionMessageHost(button);
  if (!host?.parentElement) return;
  host.parentElement.querySelectorAll(':scope > .pk-action-error').forEach(error => error.remove());
  const error = document.createElement('div');
  error.className = 'pk-action-error';
  error.setAttribute('role','alert');
  const text = document.createElement('span');
  text.textContent = message;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'pk-action-error-dismiss';
  dismiss.textContent = '×';
  dismiss.title = 'Dismiss error';
  dismiss.setAttribute('aria-label','Dismiss error');
  dismiss.onclick = () => error.remove();
  error.append(text, dismiss);
  host.insertAdjacentElement('afterend', error);
}

function showViewActionError(message) {
  const host = document.querySelector('.d-title,.sub-head,#item-list');
  if (!host) return;
  host.parentElement?.querySelectorAll(':scope > .pk-action-error').forEach(error => error.remove());
  const error = document.createElement('div');
  error.className = 'pk-action-error'; error.setAttribute('role','alert');
  const text = document.createElement('span'); text.textContent = message;
  const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'pk-action-error-dismiss'; dismiss.textContent = '×'; dismiss.title = 'Dismiss error'; dismiss.setAttribute('aria-label','Dismiss error'); dismiss.onclick = () => error.remove();
  error.append(text, dismiss); host.insertAdjacentElement('afterend', error);
}

function timeoutAction(command, entry) {
  const remaining = (pendingActionButtons.get(command) || []).filter(candidate => candidate !== entry);
  if (remaining.length) pendingActionButtons.set(command, remaining); else pendingActionButtons.delete(command);
  restoreActionButton(entry);
  showActionError(entry.button, `${entry.label} timed out. The background operation may still be running; check PKM logs before retrying.`);
}

function beginAction(command, button) {
  const timeout = actionTimeouts[command];
  if (!timeout || !(button instanceof HTMLButtonElement)) return true;
  if (button.disabled || pendingActionButtons.has(command)) return false;
  clearActionError(button);
  const entries = pendingActionButtons.get(command) || [];
  const entry = { button, html:button.innerHTML, label:(button.textContent || command).trim(), timer:0 };
  entry.timer = setTimeout(() => timeoutAction(command, entry), timeout);
  entries.push(entry);
  pendingActionButtons.set(command, entries);
  button.disabled = true;
  button.setAttribute('aria-busy','true');
  button.classList.add('action-pending');
  button.textContent = button.dataset.pendingLabel || 'Working…';
  return true;
}

function finishAction(...commands) {
  for (const command of commands) {
    for (const entry of pendingActionButtons.get(command) || []) {
      restoreActionButton(entry);
    }
    pendingActionButtons.delete(command);
  }
}

function hasPendingActionPrefix(prefix) { return [...pendingActionButtons.keys()].some(command => command.startsWith(prefix)); }

function failAction(message, ...commands) {
  for (const command of commands) {
    for (const entry of pendingActionButtons.get(command) || []) {
      restoreActionButton(entry);
      showActionError(entry.button, message);
    }
    pendingActionButtons.delete(command);
  }
}
let ctxTarget = null; // slug of note under right-click
let ctxPinned = false; // pinned state of the note under right-click
let notePinnedFolders = []; // note folder paths pinned to the top of their level
let currentDetail = null; // current detail item for edit/delete actions
let currentDetailRequest = null; // authoritative {type,key}, including packageFile/prompt variants
let catExpanded = {}; // expanded state per folder key (default: collapsed)
let pendingTreeRefresh = null; // identifies disk changes whose category path should be revealed
let pendingEditSlug = null; // note slug awaiting detail load for edit
let pendingEditType = null; // item type awaiting detail load to enter edit mode (from tree right-click)
let searchDebounce = null; // debounce timer for search
const findState = { content: { index: -1, targets: [] }, chat: { index: -1, targets: [] } };

function compileFindPattern(query, regex, caseSensitive) {
  if (!query) return null;
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try { return new RegExp(source, caseSensitive ? 'g' : 'gi'); } catch { return false; }
}
function findOptions(scope) {
  return {
    query: document.getElementById(scope === 'chat' ? 'chat-searchbox' : 'searchbox')?.value || '',
    regex: !!document.getElementById(scope === 'chat' ? 'chat-search-regex' : 'search-regex')?.classList.contains('active'),
    caseSensitive: !!document.getElementById(scope === 'chat' ? 'chat-search-case' : 'search-case')?.classList.contains('active'),
  };
}
function clearFindMarks(root) {
  root?.querySelectorAll('mark.search-match').forEach(mark => mark.replaceWith(document.createTextNode(mark.textContent || '')));
  root?.normalize();
}
function markFindMatches(root, pattern) {
  clearFindMarks(root);
  if (!root || !pattern) return [];
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode(node) {
    const parent = node.parentElement;
    if (!node.nodeValue || !parent || parent.closest('button,input,textarea,select,option,script,style,svg,mark,.mermaid-diagram')) return NodeFilter.FILTER_REJECT;
    pattern.lastIndex = 0;
    return pattern.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
  }});
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const marks = [];
  for (const textNode of nodes) {
    const text = textNode.nodeValue || '';
    const fragment = document.createDocumentFragment();
    let last = 0; pattern.lastIndex = 0; let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
      const mark = document.createElement('mark'); mark.className = 'search-match'; mark.textContent = match[0];
      fragment.appendChild(mark); marks.push(mark); last = match.index + match[0].length;
      if (!match[0].length) pattern.lastIndex += 1;
    }
    if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
    textNode.replaceWith(fragment);
  }
  return marks;
}
function updateFindStatus(scope, error) {
  const current = findState[scope];
  const count = document.getElementById(scope === 'chat' ? 'chat-search-count' : 'search-count');
  if (count) count.textContent = error ? 'Invalid regex' : current.targets.length ? `${current.index + 1}/${current.targets.length}` : '0/0';
}
function navigateFind(scope, delta) {
  const current = findState[scope];
  if (!current.targets.length) return;
  current.targets[current.index]?.classList.remove('search-current');
  current.index = (current.index + delta + current.targets.length) % current.targets.length;
  const target = current.targets[current.index];
  target.classList.add('search-current');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  updateFindStatus(scope, false);
}
function preservedFindIndex(targets, messageId, previousIndex) {
  if (!targets.length) return -1;
  if (messageId) {
    const matched = targets.findIndex(target => target.dataset?.messageId === messageId);
    if (matched >= 0) return matched;
  }
  return Math.max(0, Math.min(previousIndex, targets.length - 1));
}
function toggleFindOption(scope, option) {
  const id = scope === 'chat' ? `chat-search-${option}` : `search-${option}`;
  document.getElementById(id)?.classList.toggle('active');
  if (scope === 'chat') chatRefreshSearch(); else contentSearchChanged(true);
}

// ── Context menu ──────────────────────────────────────────────────────────
const ctxMenu = document.getElementById('ctx-menu');

document.getElementById('item-list').addEventListener('contextmenu', e => {
  const li = e.target.closest('.li[data-note-slug]');
  if (!li) return;
  e.preventDefault();
  ctxTarget = li.dataset.noteSlug;
  ctxPinned = li.dataset.notePinned === '1';
  showPaperMenu(e.clientX, e.clientY, noteContextMenuItems(ctxTarget, ctxPinned));
});

function noteContextMenuItems(slug, pinned) {
  const note = state.items.find(item => item.slug === slug);
  return [
    { label: 'Open', onClick: () => openItem('note', slug) },
    { label: 'Copy Path', onClick: () => copyContextPath('notes/' + slug + '.md') },
    { sep: true },
    { label: pinned ? 'Unpin' : 'Pin', onClick: () => ask('noteSetPinned', { slug, pinned: !pinned }) },
    { label: 'Edit Content', onClick: () => openMarkdownItem('notes', '', slug) },
    { label: 'Edit Metadata', onClick: () => editMarkdownMetadataItem('notes', note?.category || '', slug) },
    { label: 'Move', onClick: () => pkModal({ title:'Move note', message:'Target folder path (blank = root; missing parents are created).', input:true, defaultValue:note?.category||'', okLabel:'Move', onOk:value=>ask('noteMove',{slug,category:value.trim()}) }) },
    { label: 'Mark as Done', onClick: () => ask('markDone', { slug }) },
    { sep: true },
    { label: 'Move to Trash…', danger: true, onClick: () => pkModal({ title:'Move Note to Trash?', message:slug+'\n\nThe Note remains recoverable from Trash.', okLabel:'Move to Trash', danger:true, onOk:()=>ask('knowledgeTrashMove',{area:'notes',path:slug+'.md',kind:'item',name:slug}) }) },
  ];
}

// Right-click blank space in a content list -> create a top-level item/folder.
document.getElementById('item-list').addEventListener('contextmenu', e => {
  if (!['skills', 'notes', 'papers', 'prompts', 'scripts'].includes(state.tab)) return;
  if (e.target.closest('.li') || e.target.closest('.tree-cat-hdr')) return;  // items/folders have their own menus
  e.preventDefault();
  showPaperMenu(e.clientX, e.clientY, blankContextMenuItems(state.tab));
});

function blankContextMenuItems(area) {
  const items = [];
  if (area === 'skills') items.push({ label: 'New Skill…', onClick: () => ask('createKnowledgeItem', { area: 'skills', category: '' }) });
  if (area === 'notes') items.push({ label: 'New Note…', onClick: () => ask('createKnowledgeItem', { area: 'notes', category: '' }) });
  if (area === 'papers') {
    items.push({ label: 'New Paper…', onClick: () => ask('createKnowledgeItem', { area: 'papers', kind: 'paper', category: '' }) });
    items.push({ label: 'New Idea…', onClick: () => ask('createKnowledgeItem', { area: 'papers', kind: 'idea', category: '' }) });
  }
  if (area === 'prompts') items.push({ label: 'New Prompt…', onClick: () => ask('createPromptItem', {}) });
  if (area === 'scripts') items.push({ label: 'New Script…', onClick: () => ask('createScript', { folder: '' }) });
  if (area === 'skills' || area === 'notes') items.push({ label: 'Create Folder…', onClick: () => pkModal({
      title: 'Create folder', message: 'New top-level folder in ' + area + '.',
      input: true, okLabel: 'Create', onOk: v => { const n = v.trim(); if (n) ask('folderCreate', { area, parent: '', name: n }); } }) }
  );
  return items;
}

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
  if (ctxTarget) {
    const slug = ctxTarget; ctxTarget = null;
    pkModal({ title:'Move Note to Trash?', message:'The Note remains recoverable until permanently deleted.', okLabel:'Move to Trash', danger:true, onOk:()=>ask('deleteNote',{slug}) });
  }
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
  if (isInitialViewResponse(command, e.data)) finishLoadingProgress();
  if      (command === 'loadingProgress') { updateLoadingProgress(data); }
  else if (command === 'inventoryBatch') { /* progress only; refresh once when the inventory is ready */ }
  else if (command === 'inventoryReady') {
    ['skills','notes','scripts'].forEach(invalidateKnowledgeTabView);
    if (['skills','notes','scripts'].includes(state.tab)) ask('list', { tab: state.tab, filter: state.filter, q: state.search }, null, true);
  }
  else if (command === 'list')     { if (e.data.tab && e.data.tab !== state.tab) return; finishAction('list','deleteSkill','skillTrashFolder','skillTrashRestore','skillTrashDelete','skillTrashEmpty','knowledgeTrashMove','knowledgeTrashRestore','knowledgeTrashDelete','knowledgeTrashEmpty'); if (revealRefreshedTreeItems(state.tab, state.items, data, pendingTreeRefresh)) pendingTreeRefresh = null; state.items = data; state.folders = e.data.folders || []; state.subscriptionGroups = e.data.subscriptionGroups || []; state.knowledgeTrash = e.data.knowledgeTrash || []; state.brokerSharedFolders = e.data.brokerSharedFolders || {}; if (Array.isArray(e.data.privateTopLevels)) state.privateTopLevels = e.data.privateTopLevels; renderList(); highlightDetailMatches(document.getElementById('layout'), state.search); }
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
  else if (command === 'skillTrashResult') {
    if (!data?.ok) pkModal({ title:'Skills Trash', message:data?.error || 'Trash action failed.', okLabel:'OK' });
    else vscode.postMessage({ command:'toast', text:data.action === 'emptied' ? `Emptied ${Number(data.count)||0} Trash entries` : `${data.action === 'restored' ? 'Restored' : data.action === 'deleted' ? 'Permanently deleted' : 'Moved to Trash'}: ${data.path || ''}` });
    currentDetail = null; currentDetailRequest = null; renderEmptyDetail();
    ask('list', { tab:'skills', filter:'all', q:state.tab === 'skills' ? state.search : '' });
  }
  else if (command === 'knowledgeTrashResult') {
    if (!data?.ok) pkModal({ title:'Trash', message:data?.error || 'Trash action failed.', okLabel:'OK' });
    else vscode.postMessage({ command:'toast', text:data.action === 'emptied' ? `Emptied ${Number(data.count)||0} Trash entries` : `${data.action === 'restored' ? 'Restored' : data.action === 'deleted' ? 'Permanently deleted' : 'Moved to Trash'}: ${data.path || ''}` });
    currentDetail = null; currentDetailRequest = null; renderEmptyDetail();
    ask('list', { tab:data?.area || state.tab, filter:'all', q:data?.area === state.tab ? state.search : '' });
  }
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
    const refresh = document.querySelector('#content-toolbar .tbtn[onclick="doReload()"]');
    if (refresh) { refresh.disabled = false; refresh.innerHTML = uiIcon('refresh', 'Refresh'); }
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
  else if (command === 'serverGroupList') { serverGroupPaths = data || ['Hidden']; if (state.tab === 'servers') renderServerDashboard(serverCache); }
  else if (command === 'serverPrivacy') { serverPrivateTopLevels = data || []; if (state.tab === 'servers') renderServerDashboard(serverCache); }
  else if (command === 'serverSubscriptionGroups') { finishAction('serverSubscriptionStatus','serverSubscriptionRefresh'); serverSubscriptionGroups = data || []; if (state.tab === 'servers') renderServerDashboard(serverCache); }
  else if (command === 'privacyChanged') {
    if (state.tab === 'servers') { serverPrivateTopLevels = data?.type === 'servers' ? (data?.isPrivate ? [...new Set([...serverPrivateTopLevels, data.topLevel])] : serverPrivateTopLevels.filter(name => name !== data.topLevel)) : serverPrivateTopLevels; ask('serverList', {}); }
    else if (state.tab === 'recipes' && data?.type === 'recipes') ask('projectState', {});
    else if (['skills','notes','papers','prompts','packages','scripts'].includes(state.tab)) ask('list', { tab: state.tab, filter: state.filter, q: state.search });
    if (currentDetailRequest) requestDetail(currentDetailRequest.type, currentDetailRequest.key);
  }
  else if (command === 'serverLog') { onServerLog(e.data.slug, e.data.text); }
  else if (command === 'serverPickFolder') { onServerPickFolder(e.data.dir); }
  else if (command === 'subscriptionState') { finishAction('subscriptionState','subscriptionConfigure','subscriptionSetOnline','subscriptionUpsertShare','subscriptionDeleteShare','subscriptionAdd','subscriptionMountGitHub','subscriptionRename','subscriptionRefresh','subscriptionRemove','subscriptionUnblockIp','subscriptionRotateSecret'); subscriptionOnState(data); finishLoadingProgress(); }
  else if (command === 'githubSyncState') { finishAction('githubSyncState','githubSyncSave','githubSyncDelete','githubSyncRun'); githubSyncOnState(data); finishLoadingProgress(); }
  else if (command === 'githubSyncCompleted') { finishAction('githubSyncRun'); vscode.postMessage({ command:'toast', text:data?.changed ? 'GitHub target synchronized' : 'GitHub target is already current' }); }
  else if (command === 'githubSyncRestored') { finishAction('githubSyncRestore'); vscode.postMessage({ command:'toast', text:`Restored ${data?.restored?.length || 0} file(s) from GitHub` }); }
  else if (command === 'githubSyncRestoreCancelled') { finishAction('githubSyncRestore'); }
  else if (command === 'githubSyncIdentityPicked') { finishAction('githubSyncPickIdentity'); githubSyncIdentityPicked(data?.identityFile || ''); }
  else if (command === 'githubSyncIdentityCreated') { finishAction('githubSyncCreateIdentity'); githubSyncIdentityPicked(data?.identityFile || ''); vscode.postMessage({ command:'toast', text:'SSH public key copied; add it to GitHub, then test the account' }); }
  else if (command === 'githubSyncAuthenticationResult') { finishAction('githubSyncTestAuthentication'); githubSyncOnAuthenticationResult(data); vscode.postMessage({ command:'toast', text:`Authenticated as ${data?.login || 'unknown'}` }); }
  else if (command === 'githubSyncError') { githubSyncSaving = false; const action = String(data?.action || ''); if (action && pendingActionButtons.has(action)) failAction(data?.error || 'GitHub Sync failed.', action); else showViewActionError(data?.error || 'GitHub Sync failed.'); finishLoadingProgress(); }
  else if (command === 'subscriptionChanged') {
    if (state.tab === 'subscriptions' && !hasPendingActionPrefix('subscription')) ask('subscriptionState', {});
    else if (state.tab === 'servers') ask('serverList', {});
    else if (['skills','notes','papers','prompts','scripts','packages'].includes(state.tab)) ask('list', { tab: state.tab, filter: state.filter, q: state.search });
  }
  else if (command === 'subscriptionError') {
    const action = String(data?.action || '');
    const message = data?.error || 'Subscription action failed.';
    if (action && pendingActionButtons.has(action)) failAction(message, action); else showViewActionError(message);
    finishLoadingProgress();
  }
  else if (command === 'subscriptionSecret') { finishAction('subscriptionRevealSecret','subscriptionRotateSecret'); subscriptionShowSecret(data?.secret || ''); finishLoadingProgress(); }
  else if (command === 'subscriptionGitHubTestResult') { finishAction('subscriptionTestGitHubBranch'); subscriptionGitHubTestResult(data || {}); finishLoadingProgress(); }
  else if (command === 'subscriptionRenamed') {
    const subscription = (subscriptionData.subscriptions || []).find(item => item.id === data?.id);
    if (subscription) subscription.alias = data?.alias || '';
    const fallbackName = subscription?.brokerName || subscription?.shareId || '';
    for (const group of state.subscriptionGroups || []) if (group.subscriptionId === data?.id) group.alias = data?.alias || fallbackName;
    if (['skills','notes','papers','prompts','scripts','packages'].includes(state.tab)) renderList();
    vscode.postMessage({ command:'toast', text:data?.alias ? `Local name changed to ${data.alias}` : 'Using published Broker name' });
  }
  else if (command === 'subscriptionCompleted') {
    finishLoadingProgress();
    const completedCommands = {
      configured:'subscriptionConfigure', online:'subscriptionSetOnline', offline:'subscriptionSetOnline',
      published:'subscriptionUpsertShare', created:'subscriptionUpsertShare', copied:'subscriptionCopyLink',
      subscribed:'subscriptionAdd', githubMounted:'subscriptionMountGitHub', refreshed:'subscriptionRefresh', removed:'subscriptionRemove',
      brokerDeleted:'subscriptionDeleteShare', brokerDeleteCancelled:'subscriptionDeleteShare',
      brokerPaused:'subscriptionSetSharePublished', brokerPublished:'subscriptionSetSharePublished',
      unblocked:'subscriptionUnblockIp', serverOpened:'subscriptionOpenServerLink',
      serverContentRefreshed:'serverSubscriptionRefresh',
    };
    if (completedCommands[data?.action]) finishAction(completedCommands[data.action]);
    if (data?.action === 'published' || data?.action === 'created') {
      subscriptionSelectionDrafts.delete(subscriptionEditingShare);
      if (data.action === 'created') subscriptionEditingShare = String(data.shareId || '');
    }
    const messages = {
      configured:'Gateway settings applied', online:'Gateway is online', offline:'Gateway is offline', copied:'Magic Link copied',
      brokerDeleted:`Deleted ${data?.name || 'Broker'}`, brokerDeleteCancelled:`Kept ${data?.name || 'Broker'}`, brokerPaused:`Paused ${data?.name || 'Broker'}`, brokerPublished:`Publishing ${data?.name || 'Broker'}`, removed:'Subscription removed', unblocked:`Unblocked ${data?.ip || 'address'}`, serverOpened:`Opened ${data?.name || 'Server'}`, serverContentRefreshed:`Refreshed ${data?.name || 'Server subscription'} at revision ${data?.revision || 0}`,
    };
    const text = data?.action === 'published' ? `Published ${data.name} revision ${data.revision}` : data?.action === 'created' ? `Created Broker ${data.name}` : data?.action === 'subscribed' ? `Subscribed to ${data.name}` : data?.action === 'refreshed' ? `Refreshed ${data.name} at revision ${data.revision}` : messages[data?.action] || 'Subscription action completed';
    vscode.postMessage({ command:'toast', text });
  }
  else if (command === 'subscriptionForked') {
    finishAction('subscriptionFork');
    ask('list', { tab: state.tab, filter: state.filter, q: state.search });
    vscode.postMessage({ command: 'toast', text: `Forked to ${data?.path || 'local knowledge'}` });
  }
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
  else if (command === 'projectState') { projectOnState(data); }
  else if (command === 'projectStateChanged') {
    projectSnapshotDirty = true;
    const scope = String(data?.scope || 'all');
    const relevant = state.tab === 'recipes' ? scope === 'projects' || scope === 'all'
      : ['agentSessions','agentSnapshots'].includes(state.tab) ? scope !== 'projects' || scope === 'all'
      : state.tab === 'projects';
    if (relevant) ask('projectState', {});
  }
  else if (command === 'projectResult') { projectOnResult(data); }
  else if (command === 'agentSnapshotCreated') { finishAction('agentSnapshotCreate'); agentSnapshotOnCreated(data); }
  else if (command === 'recipeValidationResult') { recipeOnValidation(data); }
  else if (command === 'recipeIntentEdited') { recipeOnIntentEdited(data); }
  else if (command === 'projectError') { projectOnError(data); }
  else if (command === 'promptRendered') { promptRendered(data); }
  else if (command === 'promptInferenceResult') { promptInferenceResult(data); }
  else if (command === 'promptVersionAnalysis') { promptOnVersionAnalysis(data); }
  else if (command === 'promptTaskVariables') { promptOnTaskVariables(data); }
  else if (command === 'promptVersionNoteSaved') { promptVersionNoteSaved(data); }
  else if (command === 'paperFileSaved') {
    if (pendingPaperFile) { const cb = pendingPaperFile; pendingPaperFile = null; cb(e.data.file, e.data.error); }
  }
  else if (command === 'reloaded') {
    renderNonce++; // force cached note images to reload after external regeneration
    pendingTreeRefresh = data || {};
    const changedArea = String(data?.changedPath || '').split('/')[0];
    if (cachedKnowledgeTabs.has(changedArea)) invalidateKnowledgeTabView(changedArea);
    else cachedKnowledgeTabs.forEach(invalidateKnowledgeTabView);
    if (cachedKnowledgeTabs.has(state.tab) && (!changedArea || changedArea === state.tab)) {
      ask('list', { tab: state.tab, filter: state.filter, q: state.search }, null, true);
    }
    // Re-render the currently open note/skill so external edits and regenerated
    // images (same path) are picked up, not just the sidebar list.
    if (currentDetailRequest) ask('detail', currentDetailRequest);
    const btn = document.querySelector('#content-toolbar .tbtn[onclick="doReload()"]');
    if (btn) { btn.disabled = false; btn.innerHTML = uiIcon('refresh', 'Refresh'); }
  }
  else if (command === 'knowledgeFolderScanFailed') {
    vscode.postMessage({ command: 'toast', text: `Could not refresh ${data?.category || 'folder'}: ${data?.error || 'scan failed'}` });
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
      status.innerHTML = `<span style="color:#f87171">${uiIcon('error')} ${esc(data.error || 'Magic Code verification failed.')}</span>`;
      button.disabled = true;
    }
  }
  else if (command === 'syncJoined')   {
    document.getElementById('join-result').innerHTML =
      `<span style="color:#4ade80">✅ Synced from ${esc(data.from)}: ${esc(data.summary||data.count+' items')}${data.group ? ' → group “'+esc(data.group)+'” (review &amp; merge offline)' : ''}</span>`;
    const button = document.getElementById('join-download');
    if (button) { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = 'Download'; }
  }
  else if (command === 'syncProgress') {
    const progress = document.getElementById('join-result');
    if (progress) {
      const percent = Number.isFinite(data?.percent) ? Math.max(0, Math.min(100, data.percent)) : null;
      const amount = data?.stage === 'downloading' && data?.current
        ? `${mcpPathSizeText(Number(data.current))}${data.total ? ' / ' + mcpPathSizeText(Number(data.total)) : ''}`
        : data?.total ? `${data.current || 0} / ${data.total}${data.type ? ' ' + data.type : ''}` : '';
      progress.innerHTML = `<div class="sync-progress"><div><strong>${esc(data.message || 'Synchronizing…')}</strong><span>${percent === null ? '' : percent + '%'}${amount ? ' · ' + esc(amount) : ''}</span></div><progress ${percent === null ? '' : `value="${percent}" max="100"`}></progress></div>`;
    }
  }
  else if (command === 'mcpStatus')    { finishAction('checkMcp','reconfigureKnowledgeRoot','reconfigureEnvironmentsRoot'); updateGlobalMcpWarning(data); if (state.tab === 'mcp') renderMcpPane(data); }
  else if (command === 'skillRouterStatus') { if (state.tab === 'skillRouter') renderSkillRouterPane(data); }
  else if (command === 'pkmSkillUpdateComplete') { finishPkmSkillUpdates(); if (!data?.ok) ask('checkMcp', {}); }
  else if (command === 'uiLanguage')   { applyUiLanguage(data); }
  else if (command === 'mcpPathSize')  { finishAction('refreshMcpPathSizes'); renderMcpPathSize(data); }
  else if (command === 'chatReadReceipt') { chatUpdateReadReceipt(data); }
  else if (command === 'mcpPythonResult') { finishAction('mcpSetPython','mcpBrowsePython'); renderMcpPythonResult(data); }
  else if (command === 'mcpPythonCandidates') { renderMcpPythonCandidates(data); }
  else if (command === 'mcpPythonScanStarted') { startMcpPythonScan(data); }
  else if (command === 'mcpPythonCandidate') { appendMcpPythonCandidate(data); }
  else if (command === 'mcpPythonScanProgress') { updateMcpPythonScan(data); }
  else if (command === 'mcpPythonScanComplete') { finishAction('mcpDetectPython','mcpCancelPythonScan'); finishMcpPythonScan(data); }
  else if (command === 'mcpRuntimeProgress') { renderMcpRuntimeProgress(data); }
  else if (command === 'mcpRuntimeResult') { finishAction('mcpRepairRuntime','mcpSetPython','reconfigureMcpRuntimePath'); renderMcpRuntimeResult(data); }
  else if (command === 'mcpGenerated') { finishAction('generateMcp','reconfigureMcpServerPath'); renderMcpGenerated(data); }
  else if (command === 'mcpError')     {
    failAction(data?.error || 'The operation failed.','checkMcp','mcpRepairRuntime','mcpSetPython','generateMcp','mcpDetectPython','refreshMcpPathSizes','reconfigureKnowledgeRoot','reconfigureEnvironmentsRoot','reconfigureMcpRuntimePath','reconfigureMcpServerPath');
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
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--accent);margin-bottom:8px">${uiIcon('sparkle')} AI Summary${data.cached?' (cached)':''}${data.backend?' · '+esc(data.backend):''}</div>
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
    const tabName = e.data.tab || TAB[itemType] || 'skills';
    const btn = document.querySelector(`.tab[data-tab="${tabName}"]`);
    if (btn) btn.dispatchEvent(new MouseEvent('click'));
    pendingEditType = wantEdit ? itemType : null; // enter edit mode once detail loads
    setTimeout(() => ask('detail', { type: itemType, key: itemKey }), 150);
  }
  else if (command === 'openTab') {
    const btn = document.querySelector(`.tab[data-tab="${e.data.tab}"]`);
    if (btn) btn.dispatchEvent(new MouseEvent('click'));
  }
  else if (command === 'focusServer') { focusServerDashboard(String(e.data.slug || '')); }
  else if (command === 'openSubscription') { subscriptionOpen(String(e.data.shareId || '')); }
  else if (command === 'highlightMcpRegenerate') {
    const btn = document.querySelector('.tab[data-tab="mcp"]');
    if (btn) btn.dispatchEvent(new MouseEvent('click'));
    setTimeout(highlightMcpRegenerate, 250);
  }
  else if (command === 'chatConfig') { chatOnConfig(data); }
  else if (command === 'chatState')  { chatOnState(data); }
  else if (command === 'chatRecents'){ chatOnRecents(data); }
  else if (command === 'chatMessage'){ chatOnMessage(data); }
  else if (command === 'chatAgentState'){ chatOnAgentState(data); }
  else if (command === 'chatFileReady') { chatOnFileReady(data); }
  else if (command === 'chatToast')  { chatToast(data && data.error); }
  else if (command === 'chatAddManagedAgentProgress') { updateLoadingProgress({ stage:'agent', percent:data?.percent || 20, message:data?.message || 'Summoning a house-elf…' }); }
  else if (command === 'chatAddManagedAgentResult') { finishAction('chatAddManagedAgent'); finishLoadingProgress(); if (data?.error) chatToast(data.error); }
  else if (command === 'chatSecret') { chatOnSecret(data && data.secret); }
  else if (command === 'chatHubResult') { chatOnHubResult(data); }
  else if (command === 'syncError') {
    const errEl = smCurrentTab === 'join'
      ? document.getElementById('join-result')
      : document.getElementById('sm-cred-result');
    if (errEl) errEl.innerHTML = `<span style="color:#f87171">❌ ${esc(data.error)}</span>`;
    if (smCurrentTab === 'join') {
      const button = document.getElementById('join-download');
      if (button) { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = 'Download'; }
    }
  }
});

function ask(command, payload, button, silent = false) {
  if (!beginAction(command, button || window.event?.currentTarget)) return;
  const knowledgeLoadingLabels = {
    skills: 'Opening the spellbook…',
    notes: 'Opening the enchanted notebook…',
    papers: 'Consulting the ancient scrolls…',
    prompts: 'Preparing the incantations…',
    packages: 'Unlocking the supply chest…',
    scripts: 'Reading the runes…',
  };
  const loadingLabels = { list:knowledgeLoadingLabels[state.tab] || 'Brewing a potion…', subscriptionState:'Consulting the exchange ledger…', serverList:'Preparing the Muggle gateway…', envList:'Inspecting the alchemy instruments…', checkMcp:'Checking the protective wards…', chatAddManagedAgent:'Summoning a house-elf…', reload:'Reopening the archive…' };
  if (!silent && loadingLabels[command]) updateLoadingProgress({ stage:'request', percent:8, message:loadingLabels[command] });
  vscode.postMessage({ command, ...payload, ...(silent ? { silent:true } : {}) });
}

function updateLoadingProgress(progress = {}) {
  if (initialLoadComplete) return;
  latestLoadingProgress = progress;
  if (progress.stage === 'ready') { finishLoadingProgress(); return; }
  if (!loadingProgressVisible && !loadingRevealTimer) {
    loadingRevealTimer = setTimeout(() => {
      loadingRevealTimer = null;
      if (!latestLoadingProgress || latestLoadingProgress.stage === 'ready') return;
      loadingProgressVisible = true;
      renderLoadingProgress(latestLoadingProgress);
    }, 1000);
  }
  if (loadingProgressVisible) renderLoadingProgress(progress);
}

function isInitialViewResponse(command, message = {}) {
  const responseByTab = {
    skills:'list', notes:'list', papers:'list', prompts:'list', packages:'list', scripts:'list',
    environments:'envList', servers:'serverList', agentSessions:'projectState', recipes:'projectState', projects:'projectState',
    chatroom:'chatState', mcp:'mcpStatus', skillRouter:'skillRouterStatus', subscriptions:'subscriptionState', githubSync:'githubSyncState',
  };
  return responseByTab[state.tab] === command && (command !== 'list' || message.tab === state.tab);
}

function finishLoadingProgress() {
  clearTimeout(loadingRevealTimer);
  loadingRevealTimer = null;
  latestLoadingProgress = { stage:'ready' };
  loadingProgressVisible = false;
  initialLoadComplete = true;
  const banner = document.getElementById('loading-banner');
  const strip = document.getElementById('view-loading-progress');
  if (banner) { banner.classList.add('hidden'); setTimeout(() => banner.remove(), 400); }
  if (strip) strip.classList.add('hidden');
}

function renderLoadingProgress(progress = {}) {
  const percent = Math.max(0, Math.min(100, Number(progress.percent ?? 0)));
  const message = String(progress.message || 'Brewing a potion…');
  const count = progress.total !== undefined
    ? `${Number(progress.current || 0).toLocaleString()} / ${Number(progress.total || 0).toLocaleString()}`
    : progress.current !== undefined ? `${Number(progress.current || 0).toLocaleString()} found` : '';
  const banner = document.getElementById('loading-banner');
  if (!initialLoadComplete && banner) {
    banner.classList.remove('hidden');
    const sub = banner.querySelector('.loading-sub');
    const amount = banner.querySelector('.loading-stage-count');
    const bar = banner.querySelector('progress');
    if (sub) sub.textContent = message;
    if (amount) amount.textContent = count;
    if (bar) bar.value = percent;
  }
  const strip = document.getElementById('view-loading-progress');
  if (strip) {
    clearTimeout(loadingProgressTimer);
    strip.classList.add('hidden');
    document.getElementById('view-loading-stage').textContent = message;
    document.getElementById('view-loading-detail').textContent = progress.detail || '';
    document.getElementById('view-loading-count').textContent = count;
    const bar = document.getElementById('view-loading-bar');
    if (bar) bar.value = percent;
  }
}

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
  const actionbar = document.getElementById('content-toolbar'), tb = document.getElementById('toolbar'),
        menu = document.getElementById('more-menu'), moreBtn = document.getElementById('more-btn');
  if (!actionbar || !tb || !menu || !moreBtn) return;
  while (menu.firstChild) tb.appendChild(menu.firstChild);
  sortToolbar();
  moreBtn.style.display = 'none';
  updateTabNav();
  let guard = 40;
  while (actionbar.scrollWidth > actionbar.clientWidth + 1 && guard-- > 0) {
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
  const topbar = document.getElementById('topbar'); if (topbar) ro.observe(topbar);
  const actionbar = document.getElementById('content-toolbar'); if (actionbar) ro.observe(actionbar);
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

function mainSidebarCollapsed() {
  try { return localStorage.getItem('pk-main-sidebar-collapsed') === '1'; } catch { return false; }
}
function renderEmptyDetail() {
  const detail = document.getElementById('detail');
  if (!detail) return;
  const collapsedHint = mainSidebarCollapsed() ? `<div class="empty-select-hint">${esc(t('content.restoreSidebar'))}</div>` : '';
  detail.innerHTML = `<div class="empty empty-select-item">${collapsedHint}<div>${esc(t('content.selectItem'))}</div></div>`;
}
function refreshEmptyDetailHint() {
  if (document.querySelector('#detail > .empty-select-item')) renderEmptyDetail();
}
function applyMainSidebarState(collapsed = mainSidebarCollapsed()) {
  const layout = document.getElementById('layout');
  const toggle = document.getElementById('sidebar-toggle');
  if (!layout || !toggle) return;
  layout.classList.toggle('main-sidebar-collapsed', collapsed);
  toggle.innerHTML = uiIcon(collapsed ? 'chevron-right' : 'chevron-left');
  toggle.title = collapsed ? 'Restore category tree' : 'Minimize category tree';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  refreshEmptyDetailHint();
}
function setMainSidebarCollapsed(collapsed, persist = true) {
  if (persist) { try { localStorage.setItem('pk-main-sidebar-collapsed', collapsed ? '1' : '0'); } catch {} }
  applyMainSidebarState(collapsed);
}
function toggleMainSidebar() {
  const layout = document.getElementById('layout');
  setMainSidebarCollapsed(!(layout && layout.classList.contains('main-sidebar-collapsed')));
}
applyMainSidebarState();

initColumnResizer('layout-resizer', 'sidebar', 'pk-main-sidebar', 150, 600, 1, false);
initColumnResizer('note-split-resizer', 'note-editor-pane', 'pk-note-editor', 140, 1000, 1, true);
initColumnResizer('paper-split-resizer', 'pf-content', 'pk-paper-editor', 140, 1000, 1, true);
