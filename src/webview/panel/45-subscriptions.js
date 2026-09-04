// ── Shared Market subscriptions ────────────────────────────────────────────
let subscriptionData = { enabled:false, port:19877, advertisedHost:'', displayName:'', shares:[], subscriptions:[], catalog:{}, networkAddresses:[] };
let subscriptionEditingShare = '';
let subscriptionEditorTab = 'general';
let subscriptionExpandedId = '';
const subscriptionSelectionDrafts = new Map();

function renderSubscriptionLoading() {
  document.getElementById('detail').innerHTML = '<div class="empty">Loading subscriptions…</div>';
}

function subscriptionOnState(data) {
  if (subscriptionSelectionDrafts.has(subscriptionEditingShare)) subscriptionCaptureSelectionDraft();
  subscriptionData = { ...subscriptionData, ...(data || {}) };
  if (subscriptionEditingShare && subscriptionEditingShare !== 'new' && !(subscriptionData.shares || []).some(share => share.shareId === subscriptionEditingShare)) subscriptionEditingShare = '';
  if (state.tab === 'subscriptions') renderSubscriptionPane();
}

function subscriptionHostOptions() {
  const current = subscriptionData.advertisedHost || '';
  const options = subscriptionData.networkAddresses || [];
  const values = new Set(options.map(item => item.address));
  return `${current && !values.has(current) ? `<option value="${esc(current)}" selected>Unavailable · ${esc(current)}</option>` : ''}${options.map(item => `<option value="${esc(item.address)}" ${item.address === current ? 'selected' : ''}>${esc(item.kind === 'hostname' ? `Hostname · ${item.address}` : `${item.interface} · ${item.address}`)}</option>`).join('')}`;
}

function subscriptionShareRows() {
  const shares = subscriptionData.shares || [];
  const cards = shares.map(share => {
    const counts = Object.entries(share.summary?.counts || {}).map(([type,count]) => `${count} ${type}`).join(' · ');
    const abnormal = (share.subscribers || []).filter(item => (item.abnormal || []).length).length + (share.securityEvents || []).length;
    const expanded = subscriptionEditingShare === share.shareId;
    return `<article class="pk-card sub-broker-card ${expanded ? 'active' : ''}"><div class="sub-broker-row" role="button" tabindex="0" aria-expanded="${expanded}" onclick="subscriptionEditShare('${esc(share.shareId)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();subscriptionEditShare('${esc(share.shareId)}')}">
      <span><span class="sub-broker-title"><strong>${esc(share.name)}</strong><span class="sub-broker-actions"><button class="pk-button" onclick="event.stopPropagation();ask('subscriptionCopyLink',{shareId:'${esc(share.shareId)}'},this)" data-pending-label="Copying…" title="Copy Link">Copy Link</button><button class="pk-button danger" onclick="event.stopPropagation();subscriptionDeleteShare('${esc(share.shareId)}','${esc(share.name)}')" title="Delete Broker">Delete</button></span></span><small>${esc(counts || 'Empty')} · ${(share.subscribers || []).length} subscribers${abnormal ? ` · ${abnormal} alerts` : ''}</small></span>
      <span class="sub-broker-meta"><b>r${Number(share.revision)||0}</b><small>${esc(share.visibility === 'public' ? 'Discoverable' : 'Unlisted')}</small><i>›</i></span>
    </div>${expanded ? `<div class="sub-broker-expanded">${subscriptionShareEditor()}</div>` : ''}</article>`;
  }).join('');
  const createCard = subscriptionEditingShare === 'new' ? `<article class="pk-card sub-broker-card active sub-broker-new"><div class="sub-broker-expanded">${subscriptionShareEditor()}</div></article>` : '';
  return cards + createCard || '<div class="sub-empty">No Share Brokers.</div>';
}

function subscriptionCategoryTree(items) {
  const root = { folders:{}, items:[] };
  for (const item of items) {
    const parts = String(item.treePath ?? item.cat ?? '').split('/').map(part => part.trim()).filter(Boolean);
    let node = root;
    for (const part of parts) node = node.folders[part] ||= { folders:{}, items:[] };
    node.items.push(item);
  }
  return root;
}
function subscriptionTreeCount(node) { return node.items.length + Object.values(node.folders).reduce((total,child) => total + subscriptionTreeCount(child), 0); }
function subscriptionRenderTree(type, node, path, picked, folders, openFolders) {
  const folderRows = Object.entries(node.folders).sort(([a],[b]) => {
    const aSynthetic = a === '(uncategorized)' || a === 'Ungrouped', bSynthetic = b === '(uncategorized)' || b === 'Ungrouped';
    return aSynthetic === bSynthetic ? a.localeCompare(b) : aSynthetic ? 1 : -1;
  }).map(([name,child]) => {
    const fullPath = [...path,name].join('/');
    const inherited = folders.has('') || [...folders].some(folder => folder && (fullPath === folder || fullPath.startsWith(folder + '/')));
    const actualPaths = subscriptionTreeItems(child).map(item => String(item.cat || ''));
    const canShareFolder = actualPaths.length > 0 && actualPaths.every(actual => actual === fullPath || actual.startsWith(fullPath + '/'));
    const checkbox = canShareFolder ? `<input type="checkbox" data-sub-folder="${type}" value="${esc(fullPath)}" ${inherited ? 'checked' : ''} onclick="event.stopPropagation()" onchange="subscriptionFolderToggle(this)" title="Include this folder and future files">` : '<span class="sub-tree-folder-spacer"></span>';
    return `<details class="sub-tree-folder" data-sub-tree-type="${type}" data-sub-tree-path="${esc(fullPath)}" ${openFolders.has(fullPath) ? 'open' : ''}><summary>${checkbox}<span>${esc(name)}</span><small>${subscriptionTreeCount(child)}</small></summary><div>${subscriptionRenderTree(type,child,[...path,name],picked,folders,openFolders)}</div></details>`;
  }).join('');
  const leaves = node.items.sort((a,b) => a.label.localeCompare(b.label)).map(item => {
    const itemFolder = String(item.cat || '');
    const inherited = folders.has('') || [...folders].some(folder => folder && (itemFolder === folder || itemFolder.startsWith(folder + '/')));
    return `<label class="sub-tree-leaf" title="${esc([item.cat,item.meta].filter(Boolean).join(' · '))}"><input type="checkbox" data-sub-item="${type}" data-sub-cat="${esc(itemFolder)}" value="${esc(item.id)}" ${(inherited || picked.has(item.id)) ? 'checked' : ''} onchange="subscriptionItemToggle(this)"><span>${esc(item.label)}</span><small>${esc(item.meta || '')}</small></label>`;
  }).join('');
  return folderRows + leaves;
}
function subscriptionTreeItems(node) { return [...node.items, ...Object.values(node.folders).flatMap(subscriptionTreeItems)]; }

function subscriptionContentPicker(share) {
  const labels = { skills:'Skills', notes:'Notes', papers:'Papers', prompts:'Prompts', scripts:'Scripts', packages:'Packages', servers:'Servers' };
  const draft = subscriptionSelectionDrafts.get(subscriptionEditingShare);
  return Object.entries(labels).map(([type,label]) => {
    const items = subscriptionData.catalog?.[type] || [];
    const picked = new Set(draft?.selected?.[type] ?? share?.selected?.[type] ?? []);
    const folders = new Set(draft?.folders?.[type] ?? share?.folders?.[type] ?? []);
    const openFolders = new Set(draft?.openFolders?.[type] || []);
    const tree = subscriptionCategoryTree(items);
    const selectedCount = items.filter(item => folders.has('') || picked.has(item.id) || [...folders].some(folder => folder && (item.cat === folder || item.cat.startsWith(folder + '/')))).length;
    const publishedCount = Number(share?.summary?.counts?.[type]) || 0;
    const countLabel = draft ? `${selectedCount} selected · draft` : `${publishedCount} selected`;
    return `<details class="sub-picker" data-sub-picker="${type}" ${draft?.openTypes?.includes(type) ? 'open' : ''}>
      <summary><strong>${label}</strong><span>${countLabel} · ${items.length} available</span></summary>
      <div class="sub-picker-items"><label class="sub-folder-rule"><input type="checkbox" data-sub-folder="${type}" value="" ${folders.has('') ? 'checked' : ''} onchange="subscriptionFolderToggle(this)"> <span>Entire ${label}</span><small>include future items</small></label>
      ${subscriptionRenderTree(type,tree,[],picked,folders,openFolders) || '<span class="sub-empty">No items</span>'}</div>
    </details>`;
  }).join('');
}

function subscriptionShareEditor() {
  const share = (subscriptionData.shares || []).find(item => item.shareId === subscriptionEditingShare);
  if (!subscriptionEditingShare && subscriptionEditingShare !== 'new') return '<div class="sub-broker-placeholder"><strong>Broker Settings</strong><span>Select a Broker to configure its audience and shared content tree.</span></div>';
  return `<div class="sub-editor sub-broker-settings">
    <div class="sub-editor-head"><div><strong>Broker Settings</strong><small>${share ? esc(share.shareId) : 'New Share Broker'}</small></div><button class="icon-btn" onclick="subscriptionCancelShare()" title="Close">✕</button></div>
    <div class="sub-editor-tabs" role="tablist"><button class="${subscriptionEditorTab === 'general' ? 'active' : ''}" onclick="subscriptionSetEditorTab('general')">General</button><button class="${subscriptionEditorTab === 'acl' ? 'active' : ''}" onclick="subscriptionSetEditorTab('acl')">ACL</button><button class="${subscriptionEditorTab === 'content' ? 'active' : ''}" onclick="subscriptionSetEditorTab('content')">Shared Content</button></div>
    <div class="sub-editor-pane ${subscriptionEditorTab === 'general' ? 'active' : ''}">
    <div class="sub-form-line"><label>Broker name<input id="sub-share-name" value="${esc(share?.name || '')}" placeholder="AAGL Working Set"></label><label>Audience<select id="sub-share-visibility"><option value="public" ${share?.visibility !== 'unlisted' ? 'selected' : ''}>Discoverable · Gateway catalog</option><option value="unlisted" ${share?.visibility === 'unlisted' ? 'selected' : ''}>Unlisted · Magic Link only</option></select><small>Discovery requires Account policy Open. Network ACL, Account ACL, and Protection still control access.</small></label></div>
    <div class="sub-form-line sub-protection-line"><label>Protection<select id="sub-share-protection" onchange="subscriptionProtectionChanged()"><option value="open" ${share?.protection !== 'secret-protected' ? 'selected' : ''}>Open Broker</option><option value="secret-protected" ${share?.protection === 'secret-protected' ? 'selected' : ''}>Secret Protected Broker</option></select></label><label class="sub-secret-control ${share?.protection === 'secret-protected' ? '' : 'hidden'}">Secret Control Port<input id="sub-share-control-port" type="number" min="1024" max="65535" value="${share?.protection === 'secret-protected' ? Number(share.controlPort)||'' : ''}" placeholder="19891"></label><label>Data Port<input id="sub-share-data-port" type="number" min="0" max="65535" value="${Number(share?.dataPort)||0}"><small>0 = random per Sync</small></label></div>
    <div class="sub-secret-actions ${share?.protection === 'secret-protected' ? '' : 'hidden'}">${share ? `<button class="tbtn" onclick="ask('subscriptionRevealSecret',{shareId:'${esc(share.shareId)}'})">Reveal Secret</button><button class="tbtn" onclick="subscriptionRotateSecret('${esc(share.shareId)}')">Rotate Secret</button>` : '<label>Initial Broker Secret<input id="sub-share-secret" type="password" placeholder="Enter separate secret material"></label>'}<span>Magic Link never contains the protected Control Port or secret.</span></div></div>
    <div class="sub-editor-pane ${subscriptionEditorTab === 'acl' ? 'active' : ''}">
    <div class="sub-access-policy"><label>Network policy<select id="sub-share-access-mode"><option value="block-list" ${share?.accessMode !== 'white-list' ? 'selected' : ''}>Blocklist · allow by default</option><option value="white-list" ${share?.accessMode === 'white-list' ? 'selected' : ''}>Whitelist · deny by default</option></select></label><label>IP rules<textarea id="sub-share-ip-rules" rows="2" placeholder="10.20.*.*&#10;192.168.50.0/24">${esc((share?.ipRules || []).join('\n'))}</textarea><small>Exact IPv4/IPv6, CIDR, or IPv4 wildcard.</small></label></div>
    <div class="sub-account-policy"><label>Account policy<select id="sub-share-account-mode"><option value="open" ${share?.accountMode === 'open' || !share?.accountMode ? 'selected' : ''}>Open · any signed account</option><option value="block-list" ${share?.accountMode === 'block-list' ? 'selected' : ''}>Account Blocklist</option><option value="white-list" ${share?.accountMode === 'white-list' ? 'selected' : ''}>Account Whitelist</option></select></label><div><strong>Known accounts</strong>${(share?.subscribers || []).map(account => `<label><input type="checkbox" data-sub-account="${esc(account.nodeId)}" ${(share?.accountRules || []).includes(account.nodeId) ? 'checked' : ''}><span>${esc(account.name || account.nodeId)}</span><small>${esc(account.nodeId.slice(0,12))}</small></label>`).join('') || '<small>No authenticated Subscribers yet.</small>'}</div></div>
    ${subscriptionAudienceView(share)}</div>
    <div class="sub-editor-pane ${subscriptionEditorTab === 'content' ? 'active' : ''}">
    <div class="sub-tree-heading"><strong>Shared Content</strong><span>Folder rules include future files; individual selections do not.</span></div>
    <div class="sub-picker-grid">${subscriptionContentPicker(share)}</div>
    </div>
    <div class="sub-editor-actions"><span class="sub-action-spacer"></span><button class="pk-button" onclick="subscriptionCancelShare()">Cancel</button><button class="pk-button primary" data-pending-label="${share ? 'Publishing…' : 'Creating…'}" onclick="subscriptionSaveShare('${esc(share?.shareId || '')}',this)">${share ? 'Publish Revision' : 'Create Broker'}</button></div>
  </div>`;
}

function subscriptionAudienceView(share) {
  if (!share) return '';
  const subscribers = share.subscribers || [], events = share.securityEvents || [];
  const automaticBlocks = share.automaticBlocks || [];
  return `<div class="sub-audience"><div class="sub-tree-heading"><strong>Subscribers</strong><span>${subscribers.length} known nodes · signed identity</span></div>
    <div class="sub-audience-list">${subscribers.map(item => `<div class="sub-audience-row"><span><strong>${esc(item.name || item.nodeId)}</strong><small>${esc((item.names || []).join(' · '))}</small></span><span><b>${Number(item.syncCount)||0}</b> syncs<small>${esc(item.lastIp || '')} · ${item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : 'never'}</small></span>${(item.abnormal || []).length ? `<em>${esc(item.abnormal.join(', '))}</em>` : ''}</div>`).join('') || '<div class="sub-empty">No authenticated subscribers yet.</div>'}</div>
    ${automaticBlocks.length ? `<div class="sub-auto-blocks"><strong>Automatic blocks</strong>${automaticBlocks.map(block => `<div><code>${esc(block.ip)}</code><span>${esc(block.reason)} · ${Number(block.failedAttempts)||3} failures · ${new Date(block.blockedAt).toLocaleString()}</span><button class="tbtn" onclick="ask('subscriptionUnblockIp',{shareId:'${esc(share.shareId)}',ip:'${esc(block.ip)}'})">Unblock</button></div>`).join('')}</div>` : ''}
    ${events.length ? `<details class="sub-security-events"><summary>${events.length} recent access alerts</summary>${events.slice(0,20).map(event => `<div><time>${new Date(event.at).toLocaleString()}</time><code>${esc(event.ip)}</code><span>${esc(event.reason)}</span></div>`).join('')}</details>` : ''}
  </div>`;
}

function subscriptionRows() {
  const rows = subscriptionData.subscriptions || [];
  if (!rows.length) return '<div class="sub-empty">No subscriptions.</div>';
  return rows.map(item => {
    const name = item.alias || item.brokerName || item.shareId;
    const counts = Object.entries(item.counts || {}).map(([type,count]) => `${count} ${type}`).join(' · ');
    const taxonomy = [...(item.topics || []), ...(item.tags || []).map(tag => `#${tag}`)].slice(0,12);
    const expanded = subscriptionExpandedId === item.id;
    const menuPayload = subscriptionMenuPayload({ id:item.id, alias:item.alias || '', name });
    return `<article class="pk-card sub-subscriber-card ${expanded ? 'active' : ''}" oncontextmenu="subscriptionBrokerMenu(event,'${menuPayload}')"><div class="sub-row" role="button" tabindex="0" aria-expanded="${expanded}" onclick="subscriptionToggleDetail('${esc(item.id)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();subscriptionToggleDetail('${esc(item.id)}')}">
      <div class="sub-status ${esc(item.status)}" title="${esc(item.error || item.status)}"></div>
      <div class="sub-row-main"><strong>${esc(name)}</strong><span>${esc(item.status || 'unknown')} · revision ${Number(item.revision)||0}</span><small>Last synced ${item.lastUpdated ? new Date(item.lastUpdated).toLocaleString() : 'never'}</small></div><i class="sub-card-arrow">›</i>
    </div>${expanded ? `<div class="sub-subscriber-detail"><div class="sub-subscriber-facts"><span>Host · ${esc(item.publisher || 'Unknown')}</span><span>${esc(item.endpoint || '')}</span><span>${Number(item.itemCount)||0} cached items</span></div>${counts ? `<div class="sub-content-counts">${esc(counts)}</div>` : ''}${taxonomy.length ? `<div class="sub-taxonomy">${taxonomy.map(value => `<span>${esc(value)}</span>`).join('')}</div>` : ''}${item.error ? `<div class="sub-warning">${esc(item.error)}</div>` : ''}<div class="sub-row-actions"><button class="tbtn" onclick="subscriptionRename('${esc(item.id)}','${esc(item.alias || '')}')">Rename</button><button class="tbtn" onclick="ask('subscriptionRefresh',{id:'${esc(item.id)}',force:true})">Refresh</button><button class="tbtn danger" onclick="subscriptionRemove('${esc(item.id)}','${esc(name)}')">Remove</button></div></div>` : ''}</article>`;
  }).join('');
}

function subscriptionToggleDetail(id) { subscriptionExpandedId = subscriptionExpandedId === id ? '' : id; renderSubscriptionPane(); }
function subscriptionMenuPayload(value) { return btoa(unescape(encodeURIComponent(JSON.stringify(value)))); }
function subscriptionBrokerMenu(ev, payload) {
  ev.preventDefault(); ev.stopPropagation();
  let item;
  try { item = JSON.parse(decodeURIComponent(escape(atob(payload)))); } catch { return; }
  showPaperMenu(ev.clientX, ev.clientY, [
    { label:item.name, header:true },
    { label:'Rename local display name…', onClick:() => subscriptionRename(item.id, item.alias) },
  ]);
}

function renderSubscriptionPane() {
  const d = subscriptionData;
  document.getElementById('detail').innerHTML = `<div class="sub-dashboard">
    <header class="sub-head"><div><h2>Subscription</h2><p>PKM Shared Market · ${esc(d.displayName || 'This machine')}</p></div><span class="sub-node-state ${d.gatewayStatus === 'error' ? 'error' : d.gatewayStatus === 'running' ? 'running' : 'stopped'}" title="${esc(d.gatewayError || '')}"><i></i>${d.gatewayStatus === 'error' ? 'Gateway unavailable' : d.gatewayStatus === 'running' ? 'Broker online' : d.enabled ? 'Broker starting' : 'Broker stopped'}</span></header>
    ${d.gatewayStatus === 'error' ? `<div class="sub-warning">Common Communication Port ${Number(d.port)||19877} is unavailable · ${esc(d.gatewayError || 'Check the port and network listener.')}</div>` : ''}
    <section class="sub-band"><div class="sub-band-title"><div><h3>Node Gateway</h3><code>${esc((d.nodeId || '').slice(0,20))}</code></div><div class="sub-gateway-actions"><button class="pk-button" data-pending-label="Applying…" onclick="subscriptionSaveGateway(this)">Apply Settings</button>${d.enabled ? '<button class="pk-button danger" data-pending-label="Stopping…" onclick="subscriptionSetOnline(false,this)">Go Offline</button>' : '<button class="pk-button primary" data-pending-label="Starting…" onclick="subscriptionSetOnline(true,this)">Go Online</button>'}</div></div>
      <p class="sub-control-note">Online runs a detached machine daemon that survives VS Code and SSH disconnects. The Common Port carries discovery and metadata only; authorized Sync uses a separate Data Broker port.</p>
      <div class="sub-gateway-grid"><label>Service status<strong class="sub-service-status ${d.enabled ? 'online' : 'offline'}">${d.enabled ? 'Online · persistent daemon' : 'Offline'}</strong></label><label>Node label<input id="sub-display-name" value="${esc(d.displayName || '')}"></label><label>Invite interface<select id="sub-host">${subscriptionHostOptions()}</select></label><label>Port<input id="sub-port" type="number" min="1024" max="65535" value="${Number(d.port)||19877}"></label></div>
    </section>
    <section class="sub-band"><div class="sub-band-title"><div><h3>My Share Brokers</h3><span>${(d.shares || []).length} audiences</span></div><button class="pk-button primary" onclick="subscriptionNewShare()">+ Broker</button></div><div class="pk-list sub-broker-list">${subscriptionShareRows()}</div></section>
    <section class="sub-band"><div class="sub-band-title"><div><h3>Subscribed Brokers</h3><span>${(d.subscriptions || []).length} cached collections</span></div></div>
      <div class="sub-add"><input id="sub-alias" placeholder="Alias (optional)"><textarea id="sub-magic-link" rows="2" placeholder="Paste pkmshare:v1 Magic Link"></textarea><input id="sub-broker-secret" type="password" placeholder="Broker Secret (protected only)"><button class="pk-button primary" data-pending-label="Subscribing…" onclick="subscriptionAdd(this)">Subscribe</button></div>
      <div class="pk-list sub-list">${subscriptionRows()}</div>
    </section>
  </div>`;
}

function subscriptionSaveGateway(button) {
  ask('subscriptionConfigure', { enabled: subscriptionData.enabled, displayName: document.getElementById('sub-display-name').value, advertisedHost: document.getElementById('sub-host').value, port: Number(document.getElementById('sub-port').value) }, button);
}
function subscriptionSetOnline(online, button) { ask('subscriptionSetOnline', { online }, button); }
function subscriptionNewShare() { subscriptionCaptureSelectionDraft(); subscriptionEditingShare = 'new'; subscriptionEditorTab = 'general'; subscriptionSelectionDrafts.set('new',{selected:{},folders:{}}); renderSubscriptionPane(); }
function subscriptionOpen(shareId) {
  subscriptionCaptureSelectionDraft();
  subscriptionEditingShare = shareId;
  const tab = document.querySelector('.tab[data-tab="subscriptions"]');
  if (tab && state.tab !== 'subscriptions') tab.dispatchEvent(new MouseEvent('click'));
  else { renderSubscriptionPane(); ask('subscriptionState', {}); }
}
function subscriptionEditShare(id) { subscriptionCaptureSelectionDraft(); subscriptionEditingShare = subscriptionEditingShare === id ? '' : id; subscriptionEditorTab = 'general'; renderSubscriptionPane(); }
function subscriptionCancelShare() { subscriptionSelectionDrafts.delete(subscriptionEditingShare); subscriptionEditingShare = ''; renderSubscriptionPane(); }
function subscriptionSetEditorTab(tab) { subscriptionCaptureSelectionDraft(); subscriptionEditorTab = tab; renderSubscriptionPane(); }
function subscriptionProtectionChanged() {
  const protectedBroker = document.getElementById('sub-share-protection').value === 'secret-protected';
  document.querySelector('.sub-secret-control')?.classList.toggle('hidden', !protectedBroker);
  document.querySelector('.sub-secret-actions')?.classList.toggle('hidden', !protectedBroker);
}
function subscriptionShowSecret(secret) {
  if (!secret) return;
  pkModal({ title:'Secret Protected Broker', message:'Share this separately from the Magic Link. It contains the private Control Port and secret material.\n\n' + secret, okLabel:'Copy Secret', onOk:()=>navigator.clipboard.writeText(secret) });
}
function subscriptionRotateSecret(shareId) {
  const current = Number(document.getElementById('sub-share-control-port')?.value)||0;
  pkModal({ title:'Rotate Broker Secret', message:'The old secret stops authorizing new Sync transfers immediately. Existing caches remain readable.', input:true, defaultValue:String(current), okLabel:'Rotate', danger:true, onOk:value=>ask('subscriptionRotateSecret',{shareId,controlPort:Number(value)||current}) });
}
function subscriptionFolderToggle(input) {
  const details=input.closest('details'), type=input.dataset.subFolder, folder=input.value;
  if (!input.checked) subscriptionUncheckCoveringFolders(type, folder, input);
  const targets = folder === '' ? details.querySelectorAll(`input[data-sub-item="${type}"],input[data-sub-folder="${type}"]`) : [...details.querySelectorAll(`input[data-sub-item="${type}"],input[data-sub-folder="${type}"]`)].filter(item => item === input || item.dataset.subCat === folder || item.dataset.subCat?.startsWith(folder + '/') || item.dataset.subFolder === type && (item.value === folder || item.value.startsWith(folder + '/')));
  targets.forEach(item => item.checked=input.checked);
  subscriptionCaptureSelectionDraft();
  subscriptionUpdateSelectedCount(type);
}
function subscriptionItemToggle(input) {
  if (!input.checked) subscriptionUncheckCoveringFolders(input.dataset.subItem, input.dataset.subCat || '');
  subscriptionCaptureSelectionDraft(); subscriptionUpdateSelectedCount(input.dataset.subItem);
}
function subscriptionUncheckCoveringFolders(type, itemPath, except) {
  document.querySelectorAll(`input[data-sub-folder="${type}"]:checked`).forEach(folder => {
    if (folder !== except && (folder.value === '' || itemPath === folder.value || itemPath.startsWith(folder.value + '/'))) folder.checked = false;
  });
}
function subscriptionCaptureSelectionDraft() {
  if (!subscriptionEditingShare || !document.querySelector('.sub-broker-settings')) return;
  const selected = {}, folders = {}, openFolders = {};
  for (const type of ['skills','notes','papers','prompts','scripts','packages','servers']) {
    selected[type] = [...document.querySelectorAll(`input[data-sub-item="${type}"]:checked`)].map(input => input.value);
    folders[type] = [...document.querySelectorAll(`input[data-sub-folder="${type}"]:checked`)].map(input => input.value);
    openFolders[type] = [...document.querySelectorAll(`.sub-tree-folder[open][data-sub-tree-type="${type}"]`)].map(folder => folder.dataset.subTreePath);
  }
  const openTypes = [...document.querySelectorAll('.sub-picker[open]')].map(picker => picker.dataset.subPicker);
  subscriptionSelectionDrafts.set(subscriptionEditingShare,{selected,folders,openFolders,openTypes});
}
function subscriptionUpdateSelectedCount(type) {
  const picker = document.querySelector(`input[data-sub-folder="${type}"]`)?.closest('.sub-picker');
  if (!picker) return;
  const selected = picker.querySelectorAll(`input[data-sub-item="${type}"]:checked`).length;
  const total = picker.querySelectorAll(`input[data-sub-item="${type}"]`).length;
  const summary = picker.querySelector(':scope>summary span');
  if (summary) summary.textContent = `${selected} selected · ${total} total`;
}
function subscriptionSaveShare(shareId, button) {
  const selected = {}, folders = {}, contentTypes = [];
  for (const type of ['skills','notes','papers','prompts','scripts','packages','servers']) {
    folders[type] = [...document.querySelectorAll(`input[data-sub-folder="${type}"]:checked`)].map(input => input.value);
    const covers = folder => folders[type].includes('') || folders[type].includes(folder);
    selected[type] = [...document.querySelectorAll(`input[data-sub-item="${type}"]:checked`)].filter(input => !covers(input.dataset.subCat || '')).map(input => input.value);
    if (folders[type].length || selected[type].length) contentTypes.push(type);
  }
  const ipRules = document.getElementById('sub-share-ip-rules').value.split(/[\n,]+/).map(value => value.trim()).filter(Boolean);
  const accountRules = [...document.querySelectorAll('input[data-sub-account]:checked')].map(input => input.dataset.subAccount);
  ask('subscriptionUpsertShare', { shareId, name: document.getElementById('sub-share-name').value, visibility: document.getElementById('sub-share-visibility').value, contentTypes, selected, folders, accessMode:document.getElementById('sub-share-access-mode').value, ipRules, accountMode:document.getElementById('sub-share-account-mode').value, accountRules, protection:document.getElementById('sub-share-protection').value, secret:document.getElementById('sub-share-secret')?.value||'', controlPort:Number(document.getElementById('sub-share-control-port').value)||0, dataPort:Number(document.getElementById('sub-share-data-port').value)||0 }, button);
}
function subscriptionDeleteShare(shareId, name) {
  pkModal({ title:`Delete Broker "${name}"?`, message:'Subscriber caches are not deleted, but this Broker will stop publishing updates.', okLabel:'Delete Broker', danger:true, onOk:()=>ask('subscriptionDeleteShare',{shareId}) });
}
function subscriptionAdd(button) { ask('subscriptionAdd', { magicLink: document.getElementById('sub-magic-link').value.trim(), alias: document.getElementById('sub-alias').value.trim(), secret:document.getElementById('sub-broker-secret').value.trim() }, button); }
function subscriptionRename(id, alias) {
  pkModal({ title:'Rename subscribed Broker', message:'This display name is local to this Subscriber. Leave it blank to use the published Broker name.', input:true, defaultValue:alias || '', okLabel:'Rename', onOk:value=>ask('subscriptionRename',{id,alias:value.trim()}) });
}
function subscriptionRemove(id, name) {
  pkModal({ title:`Remove subscription "${name}"?`, message:'Stops future updates and deletes the local subscription cache. The remote Broker is not changed.', okLabel:'Remove', danger:true, onOk:()=>ask('subscriptionRemove',{id}) });
}
