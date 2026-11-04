export const browserPrivacyLock = '<svg class="reader-private-lock" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" role="img" aria-label="Private"><title>Private: excluded from Subscription sharing</title><path d="M13 7h-1V5a4 4 0 1 0-8 0v2H3L2 8v6l1 1h10l1-1V8l-1-1zM5 5a3 3 0 1 1 6 0v2H5V5zm8 9H3V8h10v6z"/></svg>';

/** Only this allowlisted projection may cross the standalone reader boundary. */
export function browserResearchGraph(graph: any, visible: (key: string) => boolean): any {
  const nodes = (graph.nodes || []).filter((node: any) => visible(node.key)).map((node: any) => ({
    key: String(node.key), title: String(node.title || node.key), topic: String(node.topic || ""),
    year: node.year, kind: node.kind === "idea" ? "idea" : "paper", citationCount: 0,
  })).sort((left: any, right: any) => left.key.localeCompare(right.key));
  const keys = new Set(nodes.map((node: any) => node.key));
  const byKey = new Map<string, any>(nodes.map((node: any) => [node.key, node]));
  const edges = (graph.edges || []).filter((edge: any) => keys.has(edge.from) && keys.has(edge.to))
    .map((edge: any) => ({ from: edge.from, to: edge.to }));
  for (const edge of edges) byKey.get(edge.from).citationCount++;
  return { nodes, edges };
}

export function browserNavigationRuntime(active: string, graph: any): string {
  const json = (value: any) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<script data-pkm-browser-navigation>
(() => {
  const sidebar = document.querySelector('.reader-sidebar');
  const libraryRoot = sidebar.querySelector(':scope > details');
  libraryRoot.id = 'reader-library';
  const libraryHeading = libraryRoot.querySelector(':scope > summary');
  libraryHeading.tabIndex = -1;
  libraryHeading.setAttribute('role', 'heading');
  libraryHeading.setAttribute('aria-level', '2');
  libraryHeading.addEventListener('click', event => event.preventDefault());
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'reader-sidebar-toggle';
  toggle.setAttribute('aria-controls', libraryRoot.id);
  toggle.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m10 3-5 5 5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  sidebar.parentElement.append(toggle);
  function syncToggle() {
    toggle.setAttribute('aria-expanded', String(libraryRoot.open));
    toggle.setAttribute('aria-label', libraryRoot.open ? 'Collapse navigation' : 'Expand navigation');
    toggle.title = libraryRoot.open ? 'Collapse navigation' : 'Expand navigation';
  }
  toggle.addEventListener('click', () => {
    libraryRoot.open = !libraryRoot.open;
    syncToggle();
  });
  libraryRoot.addEventListener('toggle', syncToggle);
  syncToggle();
  const menu = document.createElement('div');
  menu.className = 'reader-path-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Library actions');
  menu.hidden = true;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy path';
  copy.setAttribute('role', 'menuitem');
  menu.append(copy);
  const receipt = document.createElement('p');
  receipt.className = 'reader-path-receipt';
  receipt.setAttribute('role', 'status');
  receipt.hidden = true;
  document.body.append(menu, receipt);
  let pathTarget;
  const closeMenu = () => { menu.hidden = true; };
  function openMenu(target, x, y) {
    pathTarget = target;
    receipt.hidden = true;
    menu.hidden = false;
    menu.style.left = Math.max(0, Math.min(x, innerWidth-menu.offsetWidth-8)) + 'px';
    menu.style.top = Math.max(0, Math.min(y, innerHeight-menu.offsetHeight-8)) + 'px';
    copy.focus({preventScroll:true});
  }
  sidebar.addEventListener('contextmenu', event => {
    const target = event.target.closest('[data-pkm-path]');
    if (!target) return;
    event.preventDefault();
    openMenu(target, event.clientX, event.clientY);
  });
  sidebar.addEventListener('keydown', event => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    const target = event.target.closest('[data-pkm-path]');
    if (!target) return;
    event.preventDefault();
    const box = target.getBoundingClientRect();
    openMenu(target, box.left, box.bottom);
  });
  copy.addEventListener('click', async () => {
    const target = pathTarget;
    closeMenu();
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(target.dataset.pkmPath);
      else {
        const field = document.createElement('textarea');
        field.value = target.dataset.pkmPath;
        field.style.cssText = 'position:fixed;left:-10000px;top:0';
        document.body.append(field);
        try {
          field.select();
          if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
        } finally { field.remove(); }
      }
      receipt.textContent = 'PKM path copied';
    } catch (error) {
      receipt.textContent = 'Copy failed: ' + error.message + '. Path: ' + target.dataset.pkmPath;
    }
    receipt.hidden = false;
    target.focus({preventScroll:true});
  });
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) closeMenu(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) { closeMenu(); pathTarget?.focus({preventScroll:true}); }
    else if (event.key === 'Tab') closeMenu();
  });
  window.addEventListener('resize', closeMenu);
  const data = ${json(graph)};
  const panels = [...sidebar.querySelectorAll('[data-library-panel]')];
  const tabs = [...sidebar.querySelectorAll('[data-library-tab]')];
  const go = document.createElement('dialog');
  go.className = 'reader-path-dialog';
  go.setAttribute('aria-label', 'Go to PKM path');
  go.innerHTML = '<form><label>Go to PKM path<input name="path" spellcheck="false" aria-label="PKM URL" placeholder="pkm://notes/Folder/Note.md" required></label><p role="alert" hidden></p><footer><button type="button">Cancel</button><button type="submit">Go</button></footer></form>';
  document.body.append(go);
  const goInput = go.querySelector('input');
  const goError = go.querySelector('[role=alert]');
  go.querySelector('button[type=button]').onclick = () => go.close();
  function normalizePath(value) {
    const url = new URL(value.trim().replace(/^\\x60|\\x60$/g, ''));
    if (url.protocol !== 'pkm:' || !['notes','skills','papers'].includes(url.host) || url.search || url.hash
      || url.username || url.password || url.port) throw new Error('Use a PKM Library URL for Notes, Skills or Research.');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.some(part => part === '.' || part === '..' || /[\\\\/\\x00-\\x1f]/.test(part))) throw new Error('Invalid PKM path.');
    return 'pkm://' + url.host + '/' + parts.map(encodeURIComponent).join('/') + (url.pathname.endsWith('/') && parts.length ? '/' : '');
  }
  go.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const path = normalizePath(goInput.value);
      const target = [...sidebar.querySelectorAll('[data-pkm-path]')].find(node => normalizePath(node.dataset.pkmPath) === path);
      if (!target) throw new Error('Path is unavailable in this Library or you do not have access.');
      const panel = target.closest('[data-library-panel]');
      const search = sidebar.querySelector('.reader-search input');
      if (search?.value) { search.value = ''; search.dispatchEvent(new Event('input',{bubbles:true})); }
      select(panel.dataset.libraryPanel);
      if (panel.dataset.libraryPanel === 'papers') showGraph('directory');
      if (target.matches('a')) { location.assign(target.href); return; }
      for (let folder = target.closest('details'); folder && sidebar.contains(folder); folder = folder.parentElement.closest('details')) folder.open = true;
      go.close();
      target.scrollIntoView({block:'center'});
      target.focus({preventScroll:true});
    } catch (error) {
      goError.textContent = error.message;
      goError.hidden = false;
    }
  });
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'g') return;
    event.preventDefault();
    closeMenu();
    goError.hidden = true;
    if (!go.open) go.showModal();
    goInput.focus();
    goInput.select();
  });
  const storageKey = 'pkm-library-state:v1';
  let state = {};
  try { state = JSON.parse(sessionStorage.getItem(storageKey) || '{}') || {}; } catch {}
  let current = ${json(active)};
  let cy, fg, graphMode = state.papers?.view || 'directory', generation = 0;
  const canvas = sidebar.querySelector('.reader-graph-canvas');
  const status = sidebar.querySelector('.reader-graph-status');
  const save = () => { try { sessionStorage.setItem(storageKey, JSON.stringify(state)); } catch {} };
  function remember() {
    const panel = panels.find(panel => panel.dataset.libraryPanel === current);
    state[current] = { ...state[current], scroll:sidebar.scrollTop,
      folders:[...panel.querySelectorAll('.reader-nav-folder')].filter(folder => folder.open).map(folder => folder.dataset.folder) };
    save();
  }
  function restore(panel) {
    const saved = state[panel.dataset.libraryPanel];
    if (saved?.folders) panel.querySelectorAll('.reader-nav-folder').forEach(folder => folder.open = saved.folders.includes(folder.dataset.folder));
  }
  function select(type) {
    if (current !== type) remember();
    current = type;
    tabs.forEach(tab => { const selected = tab.dataset.libraryTab === type; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
    panels.forEach(panel => { panel.hidden = panel.dataset.libraryPanel !== type; });
    sidebar.scrollTop = state[type]?.scroll || 0;
    if (type === 'papers') showGraph(graphMode);
    else { generation++; fg?.pauseAnimation(); }
  }
  const libraries = {};
  function library(name, url) {
    if (globalThis[name]) return Promise.resolve();
    return libraries[name] ||= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => globalThis[name] ? resolve() : reject(new Error('Graph renderer unavailable'));
      script.onerror = () => { delete libraries[name]; reject(new Error('Graph library failed to load')); };
      document.head.append(script);
    });
  }
  const href = key => '/papers/' + key.split('/').map(encodeURIComponent).join('/') + '.html';
  const color = node => {
    if (node.kind === 'idea') return '#f4b400';
    let hash = 0; for (const letter of node.topic) hash = ((hash << 5) - hash + letter.charCodeAt(0)) | 0;
    return 'hsl(' + Math.abs(hash % 360) + ',48%,46%)';
  };
  function dispose() { cy?.destroy(); cy = undefined; fg?._destructor?.(); fg = undefined; canvas.replaceChildren(); }
  async function showGraph(mode) {
    graphMode = ['directory','2d','3d'].includes(mode) ? mode : 'directory';
    state.papers = { ...state.papers, view:graphMode }; save();
    sidebar.querySelectorAll('[data-graph-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.graphView === graphMode)));
    sidebar.querySelector('.reader-research-directory').hidden = graphMode !== 'directory';
    canvas.hidden = graphMode === 'directory';
    status.hidden = graphMode === 'directory';
    const ticket = ++generation;
    if (graphMode === 'directory') { fg?.pauseAnimation(); return; }
    if (canvas.dataset.mode === graphMode && (cy || fg)) { cy?.resize(); fg?.resumeAnimation(); return; }
    dispose();
    canvas.dataset.mode = '';
    status.textContent = 'Loading research graph…';
    if (!data.nodes.length) { status.textContent = 'No research papers available in this library.'; return; }
    try {
      await library(graphMode === '3d' ? 'ForceGraph3D' : 'cytoscape', '/_pkm/' + (graphMode === '3d' ? 'forcegraph3d' : 'cytoscape') + '.js');
      if (ticket !== generation || current !== 'papers') return;
      if (graphMode === '2d') {
        cy = globalThis.cytoscape({ container:canvas, wheelSensitivity:0.2,
          elements:[
            ...data.nodes.map(node => ({data:{id:node.key,label:node.title,kind:node.kind,color:color(node),size:18+Math.min(48,node.citationCount*5)}})),
            ...data.edges.map((edge,index) => ({data:{id:'edge:'+index,source:edge.from,target:edge.to}}))
          ],
          style:[
            {selector:'node',style:{label:'data(label)','font-size':9,'text-wrap':'wrap','text-max-width':100,'text-valign':'bottom','background-color':'data(color)',width:'data(size)',height:'data(size)'}},
            {selector:'node[kind = "idea"]',style:{shape:'round-rectangle','border-style':'dashed','border-width':2,'border-color':'#8a5a00'}},
            {selector:'edge',style:{'curve-style':'bezier','target-arrow-shape':'triangle','line-color':'#93a2a7','target-arrow-color':'#93a2a7',width:1.4}}
          ], layout:{name:'cose',animate:false,padding:24,nodeRepulsion:9000,idealEdgeLength:95}
        });
        cy.on('tap','node', event => location.assign(href(event.target.id())));
      } else {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2') || probe.getContext('webgl');
        if (!gl) throw new Error('WebGL is unavailable');
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        fg = globalThis.ForceGraph3D()(canvas).width(canvas.clientWidth || 260).height(380)
          .backgroundColor('#f6f7f9')
          .graphData({nodes:data.nodes.map(node => ({...node,id:node.key})),links:data.edges.map(edge => ({source:edge.from,target:edge.to}))})
          .nodeColor(color).nodeVal(node => node.kind === 'idea' ? 6 : 2+node.citationCount)
          .nodeLabel(node => { const label=document.createElement('span'); label.textContent=node.title; return label; })
          .linkDirectionalArrowLength(3.5).linkDirectionalArrowRelPos(1)
          .onNodeClick(node => location.assign(href(node.key)));
      }
      canvas.dataset.mode = graphMode;
      status.textContent = data.nodes.length + ' papers · ' + data.edges.length + ' citations · click a node to open';
    } catch (error) {
      dispose();
      status.textContent = (graphMode === '3d' ? '3D graph / WebGL unavailable: ' : '2D graph unavailable: ') + error.message + '. Use Directory or 2D instead.';
    }
  }
  panels.forEach(restore);
  tabs.forEach((tab,index) => {
    tab.addEventListener('click', () => select(tab.dataset.libraryTab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : (index+(event.key === 'ArrowRight' ? 1 : -1)+tabs.length)%tabs.length;
      tabs[next].click(); tabs[next].focus();
    });
  });
  sidebar.querySelectorAll('[data-graph-view]').forEach(button => button.addEventListener('click', () => showGraph(button.dataset.graphView)));
  window.addEventListener('pagehide', remember);
  sidebar.addEventListener('toggle', event => { if (event.target.matches('.reader-nav-folder')) remember(); }, true);
  new ResizeObserver(() => { cy?.resize(); if(fg) fg.width(canvas.clientWidth || 260); }).observe(canvas);
  select(current);
})();
</script>`;
}

export const browserNavigationStyles = `
.reader-private-lock{display:inline-block;flex-shrink:0;margin-left:4px;vertical-align:-1px;color:inherit}.reader-nav-item .reader-nav-title{display:inline}
.reader-layout{--reader-nav-width:260px;grid-template-columns:var(--reader-nav-width) minmax(0,1fr)}
.reader-layout:has(.reader-sidebar>details:not([open])){--reader-nav-width:40px}
.reader-sidebar>details>summary{display:block;cursor:default;list-style:none}.reader-sidebar>details>summary::-webkit-details-marker{display:none}
.reader-sidebar>details:not([open])>summary{visibility:hidden}
.reader-sidebar-toggle{position:fixed;left:calc(var(--reader-nav-width) - 12px);top:50vh;transform:translateY(-50%);z-index:1001;display:grid;place-items:center;width:24px;height:64px;padding:0;border:1px solid #cdd3da;border-radius:5px;background:#f6f7f9;color:#57606a;cursor:pointer;box-shadow:0 2px 6px #0001}
.reader-sidebar-toggle:hover{background:#dcebed;color:#145b60}.reader-sidebar-toggle:focus-visible{outline:2px solid #287f85;outline-offset:2px}
.reader-sidebar-toggle[aria-expanded=false] svg{transform:rotate(180deg)}
@media(max-width:700px){.reader-layout{--reader-nav-width:140px}}
@media print{.reader-sidebar-toggle{display:none}}
.reader-sidebar{display:flex;flex-direction:column}.reader-sidebar>details{flex-shrink:0}
.reader-access{position:sticky;bottom:0;flex-shrink:0;display:flex;align-items:center;gap:7px;margin-top:auto;padding:12px 8px 4px;min-height:36px;background:#f6f7f9;border-top:1px solid #d8dee4;color:#145b60;font-size:12px;font-weight:600;box-shadow:0 -8px 0 #f6f7f9}
.reader-access-dot{width:7px;height:7px;flex-shrink:0;border-radius:50%;background:currentColor}.reader-access[data-access=private]{color:#8a5a00}
.reader-sidebar:has(>details:not([open])) .reader-access{padding:10px 0 0;justify-content:center}.reader-sidebar:has(>details:not([open])) .reader-access-label{display:none}
.reader-tabs{position:sticky;top:0;z-index:2;display:flex;gap:3px;margin:12px 0;border-bottom:1px solid #d8dee4;padding:8px 0;background:#f6f7f9}
.reader-tabs button,.reader-graph-tools button{border:1px solid transparent;border-radius:4px;padding:6px 7px;background:transparent;color:#57606a;font:inherit;cursor:pointer}
.reader-tabs button[aria-selected=true],.reader-graph-tools button[aria-pressed=true]{background:#dcebed;border-color:#accdd0;color:#145b60;font-weight:650}
.reader-tabs button:focus-visible,.reader-graph-tools button:focus-visible{outline:2px solid #287f85}
.reader-nav-group[hidden],.reader-research-directory[hidden],.reader-graph-canvas[hidden],.reader-graph-status[hidden]{display:none!important}
.reader-graph-tools{display:flex;flex-wrap:wrap;gap:2px;margin:8px 0}
.reader-graph-canvas{position:relative;width:100%;height:380px;overflow:hidden;border:1px solid #d8dee4;border-radius:4px}
.reader-graph-status{font-size:11px;color:#57606a;overflow-wrap:anywhere;line-height:1.5}
.reader-path-menu{position:fixed;z-index:10000;min-width:140px;padding:4px;background:#fff;border:1px solid #d8dee4;border-radius:5px;box-shadow:0 4px 16px #0002}
.reader-path-menu button{display:block;width:100%;padding:7px 12px;border:0;border-radius:3px;background:transparent;color:#24292f;font:inherit;text-align:left;cursor:pointer}
.reader-path-menu button:hover,.reader-path-menu button:focus-visible{background:#dcebed;outline:2px solid #287f85;outline-offset:-2px}
.reader-path-receipt{position:fixed;bottom:16px;right:16px;z-index:10000;max-width:calc(100vw - 64px);padding:10px 14px;background:#fff;border:1px solid #accdd0;border-radius:5px;color:#145b60;overflow-wrap:anywhere}
.reader-path-menu[hidden],.reader-path-receipt[hidden]{display:none!important}
.reader-path-dialog{width:min(480px,calc(100vw - 48px));padding:20px;border:1px solid #accdd0;border-radius:6px;color:#24292f;background:#fff}
.reader-path-dialog::backdrop{background:#0005}.reader-path-dialog label{display:grid;gap:10px;font-weight:600}.reader-path-dialog input{box-sizing:border-box;width:100%;padding:8px;font:inherit;border:1px solid #8c959f;border-radius:4px}
.reader-path-dialog footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.reader-path-dialog button{padding:7px 12px;cursor:pointer}.reader-path-dialog [role=alert]{color:#a12727;overflow-wrap:anywhere}
@media(max-width:700px){.reader-tabs{flex-wrap:wrap}.reader-tabs button{padding:5px 3px;font-size:11px}}
`;
