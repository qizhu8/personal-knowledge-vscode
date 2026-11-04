// Views are projections of the Note; drafts and filters are local, never a second task store.
const noteTodo = { slug:'', view:'markdown', snapshot:null, projects:[], chats:[], error:'', stale:false, pending:null, editor:null, detailId:null, filter:'', story:'', showDone:true, request:0 };
const noteTodoStates = ['Planning','WIP','Blocked','OnHold','Done'];
const noteTodoStateLabel = state => state==='OnHold'?'On hold':state;
const noteTodoCollapsedStories = new Set();
const noteTodoAttr = value => esc(String(value ?? '')).replace(/"/g,'&quot;').replace(/'/g,'&#39;');

function noteTodoDetailRefresh(data) {
  if (data?.type !== 'note' || currentDetail?.type !== 'note' || data.slug !== currentDetail.slug
    || noteTodo.view === 'markdown' || !document.getElementById('note-todo')) return false;
  if ((data.content !== currentDetail.content || data.boardDigest !== currentDetail.boardDigest) && noteTodo.pending?.kind !== 'write') {
    noteTodo.stale = true;
    const status = document.getElementById('note-todo-external-status');
    if (status) status.textContent = 'The Note changed externally. Reload to reconcile before saving. Your draft is retained.';
  }
  currentDetail = data;
  return true;
}

function noteTodoMount(data) {
  if (noteTodo.slug !== data.slug) {
    noteTodo.slug = data.slug;
    noteTodo.snapshot = null;
    noteTodo.editor = null;
    noteTodo.detailId = null;
    noteTodo.view = data.documentKind==='todo-board'?'board':'markdown';
    noteTodo.story = '';
    noteTodo.pending = null;
    noteTodo.error = '';
    noteTodo.stale = false;
  }
  if (!noteTodo.pending) noteTodo.snapshot = null;
  noteTodoShow(noteTodo.view);
}

function noteTodoShow(view) {
  if (!['markdown','table','board','timeline'].includes(view) || currentDetail?.type !== 'note') return;
  if (view==='markdown' && currentDetail.documentKind==='todo-board') return;
  noteTodo.view = view;
  const prose = document.getElementById('note-markdown');
  const container = document.getElementById('note-todo');
  if (!container) return;
  prose?.classList.toggle('hidden',view !== 'markdown');
  container.classList.toggle('hidden',view === 'markdown');
  document.querySelectorAll('[data-note-view]').forEach(button => {
    button.classList.toggle('active',button.dataset.noteView === view);
    button.setAttribute('aria-pressed',String(button.dataset.noteView === view));
  });
  if (view === 'markdown') return;
  if (!noteTodo.snapshot && !noteTodo.pending) noteTodoLoad();
  else noteTodoPaint();
}

function noteTodoLoad() {
  if (currentDetail?.type !== 'note' || noteTodo.pending) return;
  const requestId = ++noteTodo.request;
  noteTodo.pending = { requestId, kind:'read' };
  noteTodo.error = '';
  noteTodo.stale = false;
  vscode.postMessage({ command:'noteTodoRead', slug:noteTodo.slug, requestId });
  noteTodoPaint();
}

function noteTodoResult(data) {
  if (!data || data.slug !== noteTodo.slug || data.requestId !== noteTodo.pending?.requestId) return;
  const pending = noteTodo.pending;
  noteTodo.pending = null;
  if (data.error) noteTodo.error = data.error;
  else {
    noteTodo.snapshot = { ...data.snapshot, items:data.snapshot.items.filter(item=>!item.deletedAt) };
    noteTodo.projects = data.projects || noteTodo.projects;
    noteTodo.chats = data.chats || noteTodo.chats;
    noteTodo.error = '';
    document.getElementById('note-todo-external-status')?.replaceChildren();
    if (pending.kind === 'write') noteTodo.editor = null;
    if (pending.kind === 'write') noteTodo.detailId = null;
    if (data.documentKind) currentDetail.documentKind = data.documentKind;
    if (currentDetail.documentKind==='todo-board') currentDetail.boardDigest=data.snapshot.digest;
    if (currentDetail?.type === 'note' && currentDetail.slug === data.slug && typeof data.content === 'string') {
      currentDetail.content = data.content;
      const prose = document.getElementById('note-markdown');
      if (prose) prose.innerHTML = safeMarked(data.content,currentDetail.category,'notes');
    }
  }
  noteTodoPaint();
}

function noteTodoCommand(command) {
  if (noteTodo.readOnly) return;
  if (!noteTodo.snapshot || noteTodo.pending) return;
  const requestId = ++noteTodo.request;
  noteTodo.pending = { requestId, kind:'write' };
  noteTodo.error = '';
  vscode.postMessage({ command:'noteTodoCommand', slug:noteTodo.slug, requestId, expectedDigest:noteTodo.snapshot.digest, operation:command });
  noteTodoPaint();
}

function noteTodoEdit(id,kind='Task') {
  if (noteTodo.readOnly) return;
  if (noteTodo.pending) return;
  const item = (noteTodo.snapshot?.items || []).find(item => item.id === id);
  noteTodo.detailId = id || null;
  noteTodo.editor = { item:item ? structuredClone(item) : {
    id:globalThis.crypto?.randomUUID?.() || `work-${Date.now()}`, title:'', goal:'', scope:'', acceptance:[],
    state:'Planning', evidence:[], verification:[],
    ...(kind==='UserStory'?{kind,storyStatus:'draft'}:noteTodo.story&&noteTodo.story!=='unassigned'?{parentId:noteTodo.story}:{}),
  }, existing:!!item };
  noteTodoPaint();
  document.querySelector('#note-todo-editor input[name=title]')?.focus();
}

function noteTodoOpen(id) {
  const item = noteTodo.snapshot?.items.find(record=>record.id===id);
  if (item?.kind!=='UserStory' && !noteTodo.readOnly && !/^system(?:\/|$)/i.test(noteTodo.slug)) { noteTodoEdit(id); return; }
  noteTodo.editor = null;
  noteTodo.detailId = id;
  noteTodoPaint();
}

function noteTodoClose() {
  const id=noteTodo.editor?.item.id||noteTodo.detailId;
  noteTodo.editor = null;
  noteTodo.detailId = null;
  noteTodoPaint();
  if(id)document.querySelector(`[data-todo-open="${CSS.escape(id)}"]`)?.focus();
}

function noteTodoAssignees(item) {
  const known = [
    { id:'', title:'Unassigned' },
    { id:'user:local', title:'Me · local user' },
    ...noteTodo.chats.map(chat=>({id:`chat:${chat.id}`,title:`PKM Agent · ${chat.title}`})),
    { id:'mcp:external', title:'External MCP · shared legacy identity' },
    { id:'external:copilot:', title:'Other Copilot Agent…' },
    { id:'external:claude:', title:'Claude Agent…' },
    { id:'external:other:', title:'Other external Agent…' },
  ];
  if (item.ownerId && !known.some(entry=>entry.id===item.ownerId)) known.splice(2,0,{id:item.ownerId,title:item.owner||item.ownerId});
  return `<label>Assign to<select name="assignee" aria-label="Assign to">${known.map(entry=>`<option value="${noteTodoAttr(entry.id)}" ${entry.id===(item.ownerId||'')?'selected':''}>${esc(entry.title)}</option>`).join('')}</select></label>`;
}

function noteTodoCapture(form) {
  const values = new FormData(form);
  const value = name => String(values.get(name) || '').trim();
  const lines = name => value(name).split('\n').map(line => line.trim()).filter(Boolean);
  const original = noteTodo.editor.item;
  const item = { ...original, title:value('title'), goal:value('goal'), scope:value('scope'), acceptance:lines('acceptance'),
    state:value('state'), evidence:lines('evidence'), dependsOn:lines('dependsOn'), links:lines('links'),
    verification:['unit','functional','e2e'].map(layer => ({
      layer, status:value(`verify-${layer}`), evidence:lines(`evidence-${layer}`),
      ...(value(`reason-${layer}`) ? { reason:value(`reason-${layer}`) } : {}),
    })) };
  for (const field of ['owner','ownerId','blockedReason','outcome','plannedStart','plannedEnd','projectId','parentId','storyStatus']) {
    if (value(field)) item[field] = value(field);
    else delete item[field];
  }
  item.reviewerIds = lines('reviewerIds');
  noteTodo.editor.item = item;
  noteTodo.editor.reason = value('reason');
}

function noteTodoSave(event) {
  event.preventDefault();
  noteTodoCapture(event.target);
  const { item, existing, reason } = noteTodo.editor;
  const persisted = existing ? noteTodo.snapshot.items.find(record=>record.id===item.id) : null;
  const commandItem = { ...item };
  for (const field of ['history','acceptanceDecision']) {
    if (persisted?.[field]) commandItem[field] = persisted[field];
    else delete commandItem[field];
  }
  noteTodoCommand({ action:existing ? 'edit' : 'create', item:commandItem, ...(reason ? { reason } : {}) });
}

function noteTodoAction(action,id) {
  if (noteTodo.readOnly) return;
  const item = noteTodo.snapshot?.items.find(candidate => candidate.id === id);
  if (!item || noteTodo.pending) return;
  if (action === 'accept' || action === 'reopen' || action === 'release') {
    pkModal({ title:`${action[0].toUpperCase()+action.slice(1)} Work Item`, message:action === 'accept'
      ? 'Record your explicit acceptance of this reported outcome. Inspect the criteria, verification and evidence first; this does not complete a managed Task.'
      : 'Record why this work is changing. Evidence and history are retained.',
    input:true, okLabel:action[0].toUpperCase()+action.slice(1), onOk:reason => {
      if (!reason.trim()) { noteTodo.error = 'A reason is required.'; noteTodoPaint(); return; }
      noteTodoCommand({ action, id, reason:reason.trim() });
    } });
  }
}

// Story headers classify only; state cells retain their explicit transition guards.
function noteTodoDrop(event,cell,parentOnly=false) {
  event.preventDefault();
  cell.classList.remove('note-todo-drop-target');
  if (noteTodo.readOnly || /^system(?:\/|$)/i.test(noteTodo.slug) || noteTodo.pending) return;
  const id = event.dataTransfer?.getData('application/x-pkm-work-item');
  const item = noteTodo.snapshot?.items.find(record=>record.id===id);
  if (!item || item.kind==='UserStory') return;
  const parentId = cell.closest('[data-story-row]')?.dataset.storyRow;
  if (!parentId || (parentId!=='unassigned' && !noteTodo.snapshot.items.some(record=>record.id===parentId&&record.kind==='UserStory'))) return;
  const state = parentOnly ? item.state : cell.dataset.state;
  if (!noteTodoStates.includes(state)) return;
  const parent = parentId==='unassigned'?undefined:parentId;
  if (item.state===state && item.parentId===parent) return;
  if (item.state==='Done') {
    noteTodo.error='Reopen this Work Item before moving it. Acceptance and evidence cannot be silently cleared.';
    noteTodoPaint(); return;
  }
  const next = structuredClone(item);
  if (parent) next.parentId=parent; else delete next.parentId;
  if (parentOnly) {
    noteTodoCommand({action:'edit',item:next,reason:`Classified on Board: User Story ${item.parentId||'Unassigned'} → ${parent||'Unassigned'}; state unchanged (${item.state})`});
    return;
  }
  next.state=state;
  if (state!=='Blocked') delete next.blockedReason;
  delete next.outcome;
  const reason=`Moved on Board: ${item.state} → ${state}; User Story ${item.parentId||'Unassigned'} → ${parent||'Unassigned'}`;
  if (state==='Blocked'||state==='OnHold'||state==='Done') {
    noteTodoEdit(id);
    noteTodo.editor.item=next;
    noteTodo.editor.reason=reason;
    noteTodoPaint();
    return;
  }
  noteTodoCommand({action:'edit',item:next,reason});
}

function noteTodoItemDetail(item) {
  const lines = entries => (entries || []).map(text => `<li>${esc(text)}</li>`).join('');
  const links = (item.links || []).concat(item.evidence || []).map(link => `<li>${/^pkm:\/\/|^https?:\/\//i.test(link)
    ? `<a href="${noteTodoAttr(link)}">${esc(link)}</a>` : esc(link)}</li>`).join('');
  return `<details class="note-todo-details"><summary>Contract, evidence & history</summary>
    <dl><dt>Type</dt><dd>${item.kind==='UserStory'?'User Story':'Task'}</dd>
    <dt>User Story</dt><dd>${esc(item.parentId ? noteTodo.snapshot?.items.find(parent=>parent.id===item.parentId)?.title || `Missing: ${item.parentId}` : item.kind==='UserStory'?'Top-level story':'Unassigned')}</dd>
    <dt>Goal</dt><dd>${esc(item.goal)}</dd><dt>Scope</dt><dd>${esc(item.scope)}</dd>
    <dt>Acceptance criteria</dt><dd><ul>${lines(item.acceptance)}</ul></dd>
    <dt>Owner identity</dt><dd>${esc(item.ownerId || 'Unclaimed — name alone is not a claim')}</dd>
    <dt>Reviewers</dt><dd>${esc((item.reviewerIds || []).join(', ') || 'User')}</dd>
    <dt>Dependencies</dt><dd>${esc((item.dependsOn || []).join(', ') || 'None')}</dd>
    <dt>Blocked</dt><dd>${esc(item.blockedReason || '—')}</dd>
    <dt>Evidence / related records</dt><dd><ul>${links || '<li>Not recorded</li>'}</ul></dd></dl>
    <table><caption>Verification — reported facts, not automatic acceptance</caption><thead><tr><th>Layer</th><th>Result</th><th>Evidence / reason</th></tr></thead><tbody>
      ${['unit','functional','e2e'].map(layer => {
        const verification = (item.verification || []).find(record => record.layer === layer);
        return `<tr><th>${layer}</th><td>${esc(verification?.status || 'not-run')}</td><td>${esc([...(verification?.evidence || []),verification?.reason || ''].filter(Boolean).join('\n') || 'Not recorded')}</td></tr>`;
      }).join('')}</tbody></table>
    <ol class="note-todo-history">${(item.history || []).map(event => `<li><time>${esc(event.at)}</time> · ${esc(event.actorId)} · ${esc(event.action)} ${esc(event.from || '')} ${event.to ? `→ ${esc(event.to)}` : ''}${event.reason ? `<p>${esc(event.reason)}</p>` : ''}</li>`).join('') || '<li>No structured history recorded; manual Markdown changes are not inferred.</li>'}</ol></details>`;
}

function noteTodoCard(item, table = false) {
  const state = `<span class="note-todo-state ${item.state.toLowerCase()}">${esc(noteTodoStateLabel(item.state))}</span>`;
  const decision = item.acceptanceDecision ? `Accepted by ${esc(item.acceptanceDecision.by)}` : item.state === 'Done' ? 'Reported · awaiting acceptance' : 'Not submitted';
  const parent = item.parentId ? noteTodo.snapshot?.items.find(candidate=>candidate.id===item.parentId) : null;
  const chat = item.ownerId?.startsWith('chat:') ? noteTodo.chats.find(chat=>`chat:${chat.id}`===item.ownerId) : null;
  const owner = item.ownerId ? chat ? `PKM Chat · ${chat.title} (${chat.id})` : item.ownerId : item.owner || 'Unassigned';
  const assignment = chat?.chatUrl
    ? `<button type="button" class="note-todo-open" data-todo-copy-chat="${noteTodoAttr(chat.chatUrl)}" title="Copy PKM Chat URL">${esc(owner)}</button>`
    : !noteTodo.readOnly && !/^system(?:\/|$)/i.test(noteTodo.slug)
      ? `<button type="button" class="note-todo-open" data-todo-assign="${noteTodoAttr(item.id)}" title="Assign Work Item">${esc(owner)}</button>` : esc(owner);
  const title = `<small class="note-todo-id">${esc(item.id)}</small><strong><button type="button" class="note-todo-open" data-todo-open="${noteTodoAttr(item.id)}">${esc(item.title)}</button></strong>
    <small class="note-todo-parent">${item.kind==='UserStory'?`User Story · ${esc(item.storyStatus || 'draft')}`:parent?`User Story: ${esc(parent.title)}`:item.parentId?`Missing User Story: ${esc(item.parentId)}`:'User Story: Unassigned'}</small>`;
  const actions = noteTodo.readOnly ? '' : `<button type="button" class="tbtn" data-todo-edit="${noteTodoAttr(item.id)}">Details / Edit</button>
    ${item.state === 'Done' ? `${!item.acceptanceDecision ? `<button type="button" class="tbtn" data-todo-action="accept" data-todo-id="${noteTodoAttr(item.id)}">Accept</button>` : ''}
      <button type="button" class="tbtn" data-todo-action="reopen" data-todo-id="${noteTodoAttr(item.id)}">Reopen</button>` : ''}`;
  if (table) return `<tr data-todo-card-id="${noteTodoAttr(item.id)}"><td>${title}${noteTodoItemDetail(item)}</td><td>${state}</td><td>${assignment}</td>
    <td>${esc(item.outcome || '—')}<small>${decision}</small></td><td>${esc((item.dependsOn || []).join(', ') || '—')}</td><td>${actions}</td></tr>`;
  return `<article class="note-todo-card" data-todo-card-id="${noteTodoAttr(item.id)}" ${!noteTodo.readOnly&&item.kind!=='UserStory'&&item.state!=='Done'?'draggable="true"':''}>${title}<div>${state}${item.outcome ? `<span class="note-todo-outcome">${esc(item.outcome)}</span>` : ''}</div>
    <p class="note-todo-assigned"><small>Assigned</small>${assignment}</p><small>${decision}</small>${item.blockedReason ? `<p class="note-todo-blocked">${esc(item.blockedReason)}</p>` : ''}<footer>${actions}</footer></article>`;
}

function noteTodoTimeline(records, compact = false) {
  const dated = records.flatMap(({item}) => [
    ...(item.plannedStart && item.plannedEnd ? [Date.parse(`${item.plannedStart}T00:00:00Z`),Date.parse(`${item.plannedEnd}T23:59:59Z`)] : []),
    ...(item.history || []).map(event => Date.parse(event.at)),
  ]).filter(Number.isFinite);
  const now = Date.now();
  const min = dated.length ? Math.min(...dated,now) : now;
  const max = dated.length ? Math.max(...dated,now) : now;
  const span = Math.max(86400000,max-min);
  const position = time => Math.max(0,Math.min(100,(time-min)*100/span));
  const bar = (start,end,label,kind) => `<span class="note-todo-time ${kind}" title="${noteTodoAttr(label)}" style="left:${position(start)}%;width:${Math.max(0,position(end)-position(start))}%"><span class="sr-only">${esc(label)}</span></span>`;
  return `<section class="note-todo-timeline"><p>Plan and recorded state intervals are separate. WIP is not measured model compute time; no inferred duration or completion percentage.</p>
    <header><time>${new Date(min).toISOString().slice(0,10)}</time><span>Now ${new Date(now).toISOString().slice(0,10)}</span><time>${new Date(max).toISOString().slice(0,10)}</time></header>
    ${records.map(({item,slug}) => {
      const events = (item.history || []).filter(event => event.to).map(event => ({...event,time:Date.parse(event.at)})).filter(event => Number.isFinite(event.time));
      const intervals = events.map((event,index) => {
        const end = events[index+1]?.time ?? (event.to === 'Done' ? event.time : now);
        return {event,end};
      });
      return `<article class="note-todo-timeline-row"><div><strong>${slug===noteTodo.slug?`<button type="button" class="note-todo-open" data-todo-open="${noteTodoAttr(item.id)}">${esc(item.title)}</button>`:esc(item.title)}</strong><small>${esc(slug || '')} · ${esc(item.owner || 'Unassigned')} · ${esc(noteTodoStateLabel(item.state))}${item.outcome ? ` / ${esc(item.outcome)}` : ''}</small>
        <small>Depends on: ${esc((item.dependsOn || []).join(', ') || 'None')}</small></div>
        <div class="note-todo-track"><i class="note-todo-now" style="left:${position(now)}%"></i>
          ${item.plannedStart ? bar(Date.parse(`${item.plannedStart}T00:00:00Z`),Date.parse(`${item.plannedEnd}T23:59:59Z`),`Plan: ${item.plannedStart} → ${item.plannedEnd}`,'plan') : '<small>Unscheduled</small>'}</div>
        <div class="note-todo-track"><i class="note-todo-now" style="left:${position(now)}%"></i>${intervals.map(({event,end}) => bar(event.time,end,`${noteTodoStateLabel(event.to)}: ${event.at} → ${new Date(end).toISOString()}`,event.to.toLowerCase())).join('') || '<small>No recorded state intervals</small>'}</div>
        ${compact ? '' : `<details><summary>Exact dates & evidence</summary><p>Plan: ${esc(item.plannedStart || 'Not set')} → ${esc(item.plannedEnd || 'Not set')}</p>
        ${intervals.map(({event,end}) => `<p>${esc(event.to)}: ${esc(event.at)} → ${new Date(end).toISOString()}</p>`).join('')}${noteTodoItemDetail(item)}
        ${slug ? `<button type="button" class="tbtn" data-todo-note="${noteTodoAttr(slug)}">Open Note</button>` : ''}</details>`}</article>`;
    }).join('') || '<p>No Work Items match this view.</p>'}</section>`;
}

function noteTodoStoryOverview(story) {
  const children = (noteTodo.snapshot?.items || []).filter(item=>item.kind!=='UserStory' && item.parentId===story.id);
  const readonly = noteTodo.readOnly || /^system(?:\/|$)/i.test(noteTodo.slug);
  return `<section class="note-todo-story-overview" aria-label="User Story overview">
    <header><small>User Story · ${esc(story.storyStatus || 'draft')} · ${esc(noteTodoStateLabel(story.state))}</small><h2>${esc(story.title)}</h2>
      <p>${esc(story.owner || 'Unassigned')} · ${story.acceptanceDecision ? `Accepted by ${esc(story.acceptanceDecision.by)}` : 'Not accepted'}</p>
      ${!readonly?`<button type="button" class="tbtn" data-todo-edit="${noteTodoAttr(story.id)}">Edit User Story</button>`:''}</header>
    <dl><dt>Problem / user value</dt><dd>${esc(story.goal)}</dd><dt>Scope</dt><dd>${esc(story.scope)}</dd>
      <dt>Acceptance criteria</dt><dd><ul>${(story.acceptance || []).map(text=>`<li>${esc(text)}</li>`).join('')}</ul></dd></dl>
    <section aria-label="Child Work Items Gantt"><h3>Work Items · Gantt</h3>
      <p>${children.length} Work Items · ${noteTodoStates.map(state=>`${noteTodoStateLabel(state)}: ${children.filter(item=>item.state===state).length}`).join(' · ')} · ${children.filter(item=>item.acceptanceDecision).length} accepted</p>
      <p>Child completion does not automatically complete or accept this User Story. Dashed bars show plans; colored bars show recorded states. Click a Work Item for details.</p>
      ${children.length?noteTodoTimeline(children.map(item=>({item,slug:noteTodo.slug})),true):'<p>No child Work Items yet.</p>'}
    </section>
  </section>`;
}

function noteTodoEditorHtml() {
  if (!noteTodo.editor) return '';
  const item = noteTodo.editor.item;
  const input = (name,label,type='text') => `<label>${label}<input name="${name}" type="${type}" spellcheck="${name==='title'||name==='owner'}" value="${noteTodoAttr(item[name] || '')}"></label>`;
  const textarea = (name,label,value=item[name]) => `<label class="wide">${label}<textarea name="${name}" spellcheck="${!['reviewerIds','dependsOn','evidence','links'].includes(name)&&!name.startsWith('evidence-')}" rows="3">${esc(Array.isArray(value)?value.join('\n'):value || '')}</textarea></label>`;
  const isStory = item.kind==='UserStory';
  return `<form id="note-todo-editor" class="note-todo-editor" aria-label="Work Item editor"><header class="wide"><strong>${noteTodo.editor.existing ? 'Edit' : 'New'} ${isStory?'User Story':'Work Item'}</strong><code>${esc(item.id)}</code></header>
    <p class="wide">User edits are explicit management decisions. Done records a reported result; Accept is separate. Changing the contract requires a reason.</p>
    ${noteTodo.editor.existing ? `<details class="wide"><summary>Current persisted record · compare before saving a retained draft</summary><pre>${esc(JSON.stringify(noteTodo.snapshot?.items.find(record=>record.id===item.id),null,2))}</pre></details>` : ''}
    ${input('title','Title')}${noteTodoAssignees(item)}${input('owner','Owner display name')}
    ${isStory?`<label>Story definition<select name="storyStatus"><option value="draft" ${item.storyStatus!=='confirmed'?'selected':''}>Draft · needs review</option><option value="confirmed" ${item.storyStatus==='confirmed'?'selected':''}>Confirmed by user</option></select></label>
      <p>Goal expresses user value; scope defines the boundary; acceptance criteria judge the story independently. Child completion never automatically accepts a story.</p>`
      :`<label class="wide">Parent User Story<select name="parentId"><option value="">Unassigned</option>${(noteTodo.snapshot?.items||[]).filter(parent=>parent.kind==='UserStory').map(parent=>`<option value="${noteTodoAttr(parent.id)}" ${parent.id===item.parentId?'selected':''}>${esc(parent.title)} (${esc(parent.storyStatus||'draft')})</option>`).join('')}</select></label>`}
    ${textarea('goal','Goal')}${textarea('scope','Scope')}${textarea('acceptance','Acceptance criteria · one per line')}
    <label>Owner identity<input name="ownerId" spellcheck="false" list="note-todo-actors" value="${noteTodoAttr(item.ownerId || '')}" placeholder="Stable Chat / actor ID"></label>
    <datalist id="note-todo-actors"><option value="user:local">Me</option>${noteTodo.chats.map(chat => `<option value="chat:${noteTodoAttr(chat.id)}">${esc(chat.title)}</option>`).join('')}</datalist>
    <p class="wide">Assignment does not start an Agent. External IDs use external:copilot/claude/other:&lt;stable-id&gt;. Save the assignment, then issue a Board-scoped worker token for that Agent. A display name alone does not grant access.</p>
    ${!noteTodo.browserManaged&&currentDetail.documentKind==='todo-board'&&/^external:(copilot|claude|other):[a-zA-Z0-9_-]+$/.test(item.ownerId||'')&&noteTodo.snapshot?.items.some(record=>record.id===item.id&&record.ownerId===item.ownerId)?`<button type="button" class="tbtn wide" data-todo-worker-token="${noteTodoAttr(item.ownerId)}">Copy / rotate external worker token</button>`:''}
    <label>Project<select name="projectId"><option value="">Unassigned</option>${noteTodo.projects.map(project => `<option value="${noteTodoAttr(project.projectId)}" ${project.projectId===item.projectId?'selected':''}>${esc(project.name)}</option>`).join('')}
      ${item.projectId && !noteTodo.projects.some(project=>project.projectId===item.projectId) ? `<option selected value="${noteTodoAttr(item.projectId)}">${esc(item.projectId)} (unavailable)</option>`:''}</select></label>
    ${textarea('reviewerIds','Delegated reviewer identities · one per line')}
    <label>State<select name="state">${noteTodoStates.map(state=>`<option value="${state}" ${state===item.state?'selected':''}>${noteTodoStateLabel(state)}</option>`).join('')}</select></label>
    <label>Outcome<select name="outcome"><option value="">Not reported</option>${['Success','Failed','Unsure'].map(outcome=>`<option ${outcome===item.outcome?'selected':''}>${outcome}</option>`).join('')}</select></label>
    ${textarea('blockedReason','Blocked reason')}${textarea('dependsOn','Dependency IDs · same Note, one per line')}
    ${input('plannedStart','Planned start','date')}${input('plannedEnd','Planned end','date')}
    ${textarea('evidence','Result evidence · references, one per line')}${textarea('links','Related Chat / Recipe / Action / Memory / Snapshot links · one per line')}
    ${['unit','functional','e2e'].map(layer=>{
      const verification = item.verification?.find(record=>record.layer===layer);
      return `<fieldset class="wide"><legend>${layer} verification</legend><label>Status<select name="verify-${layer}">${['not-run','passed','failed','not-applicable'].map(status=>`<option ${status===(verification?.status || 'not-run')?'selected':''}>${status}</option>`).join('')}</select></label>
        ${textarea(`evidence-${layer}`,'Evidence',verification?.evidence || [])}${textarea(`reason-${layer}`,'Reason / limitations',verification?.reason || '')}</fieldset>`;
    }).join('')}${textarea('reason','Reason for this change',noteTodo.editor.reason || '')}
    <footer class="wide"><button type="button" class="tbtn" data-todo-cancel>Cancel</button><button type="submit" class="tbtn primary" ${noteTodo.pending?'disabled':''}>Save Work Item</button></footer></form>`;
}

function noteTodoBoard(items,stories) {
  const states=noteTodoStates.filter(state=>state!=='Done'||noteTodo.showDone);
  const rows=stories.filter(story=>!noteTodo.story||story.id===noteTodo.story).map(story=>({story,children:items.filter(item=>item.parentId===story.id)}));
  const unassigned=items.filter(item=>!item.parentId||!stories.some(story=>story.id===item.parentId));
  const readonly=noteTodo.readOnly||/^system(?:\/|$)/i.test(noteTodo.slug);
  if(unassigned.length||!stories.length||noteTodo.story==='unassigned'||(!readonly&&!noteTodo.story)) rows.push({story:null,children:unassigned});
  return `<div class="note-todo-swimboard" role="region" aria-label="User Story taskboard" style="--todo-columns:${states.length}">
    <div class="note-todo-swimhead"><div class="note-todo-grouping"><strong>User Stories</strong>${!readonly?`<button type="button" class="tbtn primary" data-todo-new-story ${noteTodo.pending?'disabled':''}>+ New User Story</button><small>Drop on a Story or Unassigned header to classify without changing state.</small>`:'<small>Read only · create Stories and classify Work Items in the VS Code PKM panel.</small>'}<div><button type="button" class="tbtn" data-todo-collapse-all>Collapse all</button><button type="button" class="tbtn" data-todo-expand-all>Expand all</button></div></div>${states.map(state=>`<h3>${state==='Done'?'Completed':noteTodoStateLabel(state)}</h3>`).join('')}</div>
    ${rows.map(({story,children})=>{
      const key=story?.id||'unassigned';
      const collapsed=noteTodoCollapsedStories.has(`${noteTodo.slug}:${key}`);
      return `<section class="note-todo-swimrow ${collapsed?'collapsed':''}" aria-label="${noteTodoAttr(story?.title||'Unassigned Work Items')}" data-story-row="${noteTodoAttr(key)}">
        <div class="note-todo-swimstory" data-todo-story-drop="${noteTodoAttr(key)}" aria-label="${noteTodoAttr(story?.title||'Unassigned')} grouping${readonly?'':' · drop Work Item to change parent only'}"><button type="button" class="note-todo-story-toggle" aria-expanded="${!collapsed}" aria-label="${collapsed?'Expand':'Collapse'} ${noteTodoAttr(story?.title||'Unassigned Work Items')}" data-todo-toggle-story="${noteTodoAttr(key)}">${collapsed?'▸':'▾'}</button>
        <div>${story?noteTodoCard(story):'<strong>Unassigned Work Items</strong><small>No parent User Story</small>'}<small>${children.length} Work Items · ${children.filter(item=>item.acceptanceDecision).length} accepted</small>
        ${story&&!noteTodo.readOnly?`<button type="button" class="tbtn" data-todo-add-child="${noteTodoAttr(story.id)}">+ Work Item</button>`:''}</div></div>
        ${states.map(state=>`<div class="note-todo-swimcell" data-state="${state}" aria-label="${noteTodoStateLabel(state)} Work Items">${!collapsed?children.filter(item=>item.state===state).map(item=>noteTodoCard(item)).join(''):''}</div>`).join('')}</section>`;
    }).join('')}</div>`;
}

function noteTodoPaint() {
  const container = document.getElementById('note-todo');
  if (!container || currentDetail?.type !== 'note' || currentDetail.slug !== noteTodo.slug) return;
  const records = noteTodo.snapshot?.items || [];
  const stories = records.filter(item=>item.kind==='UserStory');
  const items = records.filter(item=>item.kind!=='UserStory');
  const readonly = noteTodo.readOnly || /^system(?:\/|$)/i.test(noteTodo.slug);
  const visible = items.filter(item => (!noteTodo.filter || [item.title,item.id,item.owner,item.blockedReason].some(value=>String(value || '').toLowerCase().includes(noteTodo.filter.toLowerCase())))
    && (!noteTodo.story || (noteTodo.story==='unassigned'?!item.parentId:item.parentId===noteTodo.story))
    && (noteTodo.showDone || item.state !== 'Done'));
  const closed = items.filter(item=>item.state==='Done');
  container.innerHTML = `<section class="note-todo-workspace" aria-label="Note Todo workspace">
    <header class="note-todo-toolbar"><div><strong>Work Items</strong><small>${items.length-closed.length} active · ${closed.length} closed · ${closed.filter(item=>item.outcome==='Success').length} reported Success · ${closed.filter(item=>item.acceptanceDecision).length} accepted</small></div>
    <button type="button" class="tbtn" data-todo-refresh ${noteTodo.pending?'disabled':''}>Reload from Note</button>
    ${!readonly ? `${noteTodo.view!=='board'?`<button type="button" class="tbtn" data-todo-new-story ${noteTodo.pending?'disabled':''}>New User Story</button>`:''}<button type="button" class="tbtn primary" data-todo-new ${noteTodo.pending?'disabled':''}>New Work Item</button>`:''}</header>
    <p class="note-todo-notice">${currentDetail.documentKind==='todo-board'?'Structured Board data is authoritative; Markdown cannot change tasks.':'Legacy Markdown Work Items. Convert to Todo Board for command-only task management.'} Done ≠ accepted. No model or Agent is started by this tracker.${readonly?' Read only.':''}</p>
    <p id="note-todo-external-status" role="status">${noteTodo.stale?'The Note changed externally. Reload to reconcile before saving. Your draft is retained.':''}</p>
    ${noteTodo.error?`<div class="note-todo-error" ${noteTodo.editor||noteTodo.detailId?'':'role="alert"'}>${esc(noteTodo.error)}<p>Your editor draft is retained. Reload, reconcile with the current Note, then explicitly save again.</p></div>`:''}
    ${noteTodo.pending?'<p role="status">Reading / saving the Note…</p>':''}
    <div class="note-todo-filters"><label>User Story <select id="note-todo-story"><option value="">All stories</option><option value="unassigned" ${noteTodo.story==='unassigned'?'selected':''}>Unassigned (${items.filter(item=>!item.parentId).length})</option>${stories.map(story=>`<option value="${noteTodoAttr(story.id)}" ${noteTodo.story===story.id?'selected':''}>${esc(story.title)}</option>`).join('')}</select></label><label>Filter <input id="note-todo-filter" value="${noteTodoAttr(noteTodo.filter)}" type="search"></label><label><input id="note-todo-show-done" type="checkbox" ${noteTodo.showDone?'checked':''}> Show completed (${closed.length})</label></div>
    ${!noteTodo.editor&&noteTodo.view!=='board' ? `<section class="note-todo-stories" aria-label="User Stories"><header><strong>User Stories (${stories.length})</strong><small>Independent goals and acceptance · child counts are not success percentages</small></header>
      ${stories.filter(story=>!noteTodo.story||noteTodo.story===story.id).map(story=>{
        const children=items.filter(item=>item.parentId===story.id);
        return `<article class="note-todo-story"><div>${noteTodoCard(story)}</div><footer><span>${children.length} child Work Items · ${children.filter(item=>!!item.acceptanceDecision).length} accepted</span><button type="button" class="tbtn" data-todo-story-focus="${noteTodoAttr(story.id)}">Show child Work Items</button></footer></article>`;
      }).join('') || '<p class="note-todo-notice">No User Story in this selection. Existing Work Items remain unassigned until explicitly linked.</p>'}</section>`:''}
    ${noteTodo.view === 'board' ? noteTodoBoard(visible,stories)
      : noteTodo.view === 'timeline' ? noteTodoTimeline(visible.map(item=>({item,slug:noteTodo.slug})))
      : `<div class="note-todo-table-wrap"><table class="note-todo-table"><caption class="sr-only">Work Items in ${esc(currentDetail.title)}</caption><thead><tr><th>Work Item / contract</th><th>State</th><th>Owner</th><th>Outcome / acceptance</th><th>Dependencies</th><th>Actions</th></tr></thead><tbody>${visible.map(item=>noteTodoCard(item,true)).join('')}</tbody></table>${!visible.length?'<p class="note-todo-empty">No explicit Work Items. Existing Markdown checklists are unchanged.</p>':''}</div>`}
    ${noteTodo.editor||noteTodo.detailId?`<dialog class="note-todo-dialog" aria-label="Work Item details"><header class="note-todo-dialog-title"><span>WORK ITEM · ${esc(noteTodo.editor?.item.id||noteTodo.detailId)}</span><button type="button" class="tbtn" data-todo-refresh ${noteTodo.pending?'disabled':''}>Reload from Note</button><button type="button" class="tbtn" data-todo-close aria-label="Close Work Item details">×</button></header>
      ${noteTodo.error?`<p class="note-todo-error" role="alert">${esc(noteTodo.error)}</p>`:''}
      ${noteTodo.editor?noteTodoEditorHtml():records.find(item=>item.id===noteTodo.detailId)?.kind==='UserStory'
        ?noteTodoStoryOverview(records.find(item=>item.id===noteTodo.detailId))
        :`<h2>${esc(records.find(item=>item.id===noteTodo.detailId)?.title||'Work Item no longer available')}</h2>${records.find(item=>item.id===noteTodo.detailId)?noteTodoItemDetail(records.find(item=>item.id===noteTodo.detailId)):''}`}</dialog>`:''}</section>`;
  const swimboard=container.querySelector('.note-todo-swimboard');
  if(swimboard)swimboard.style.scrollPaddingTop=`${swimboard.querySelector('.note-todo-swimhead').offsetHeight}px`;
  container.querySelectorAll('[data-todo-refresh]').forEach(button=>button.addEventListener('click',noteTodoLoad));
  container.querySelector('[data-todo-new]')?.addEventListener('click',()=>noteTodoEdit());
  container.querySelectorAll('[data-todo-new-story]').forEach(button=>button.addEventListener('click',()=>noteTodoEdit(undefined,'UserStory')));
  const dialog=container.querySelector('.note-todo-dialog');
  if(dialog){
    dialog.showModal();
    dialog.addEventListener('cancel',event=>{event.preventDefault();noteTodoClose();});
    if(!noteTodo.editor)dialog.querySelectorAll('details').forEach(detail=>detail.open=true);
    dialog.querySelector('[data-todo-close]')?.addEventListener('click',noteTodoClose);
  }
  container.querySelector('[data-todo-cancel]')?.addEventListener('click',noteTodoClose);
  container.querySelector('[name=assignee]')?.addEventListener('change',event=>{
    const form=container.querySelector('#note-todo-editor'), id=event.target.value;
    form.elements.ownerId.value=id;
    form.elements.owner.value=event.target.selectedOptions[0].textContent.replace(/^PKM Agent · /,'');
    if(!id)form.elements.owner.value='';
    if(/^external:(copilot|claude|other):$/.test(id))form.elements.ownerId.focus();
    noteTodoCapture(form);
  });
  container.querySelector('[data-todo-worker-token]')?.addEventListener('click',event=>{
    vscode.postMessage({command:'todoBoardGrantWorker',slug:noteTodo.slug,expectedDigest:noteTodo.snapshot.digest,actorId:event.currentTarget.dataset.todoWorkerToken});
  });
  container.querySelector('#note-todo-editor')?.addEventListener('submit',noteTodoSave);
  container.querySelector('#note-todo-editor')?.addEventListener('input',event=>noteTodoCapture(event.currentTarget));
  container.querySelector('#note-todo-editor')?.addEventListener('change',event=>noteTodoCapture(event.currentTarget));
  container.querySelector('#note-todo-filter')?.addEventListener('change',event=>{
    if (noteTodo.filter === event.target.value) return;
    noteTodo.filter=event.target.value;
    noteTodoPaint();
  });
  container.querySelector('#note-todo-show-done')?.addEventListener('change',event=>{noteTodo.showDone=event.target.checked;noteTodoPaint();});
  container.querySelector('#note-todo-story')?.addEventListener('change',event=>{
    if(noteTodo.story===event.target.value)return;
    noteTodo.story=event.target.value;noteTodoPaint();
  });
  container.querySelectorAll('[data-todo-story-focus]').forEach(button=>button.onclick=()=>{noteTodo.story=button.dataset.todoStoryFocus;noteTodoPaint();});
  container.querySelectorAll('[data-todo-add-child]').forEach(button=>{
    button.disabled=readonly||!!noteTodo.pending;
    button.onclick=()=>{noteTodoEdit();noteTodo.editor.item.parentId=button.dataset.todoAddChild;noteTodoPaint();};
  });
  container.querySelectorAll('[data-todo-toggle-story]').forEach(button=>button.onclick=()=>{
    const key=`${noteTodo.slug}:${button.dataset.todoToggleStory}`;
    if(noteTodoCollapsedStories.has(key))noteTodoCollapsedStories.delete(key);else noteTodoCollapsedStories.add(key);
    noteTodoPaint();
  });
  container.querySelector('[data-todo-collapse-all]')?.addEventListener('click',()=>{
    [...stories.map(story=>story.id),'unassigned'].forEach(id=>noteTodoCollapsedStories.add(`${noteTodo.slug}:${id}`));noteTodoPaint();
  });
  container.querySelector('[data-todo-expand-all]')?.addEventListener('click',()=>{
    [...stories.map(story=>story.id),'unassigned'].forEach(id=>noteTodoCollapsedStories.delete(`${noteTodo.slug}:${id}`));noteTodoPaint();
  });
  container.querySelectorAll('[data-todo-edit]').forEach(button=>{button.disabled=readonly||!!noteTodo.pending;button.onclick=()=>noteTodoEdit(button.dataset.todoEdit);});
  container.querySelectorAll('[data-todo-open]').forEach(button=>{
    button.title='Double-click to open · Enter or Space with keyboard';
    button.ondblclick=()=>noteTodoOpen(button.dataset.todoOpen);
    button.onclick=event=>{if(event.detail===0)noteTodoOpen(button.dataset.todoOpen);};
  });
  container.querySelectorAll('[data-todo-assign]').forEach(button=>button.onclick=()=>{
    noteTodoEdit(button.dataset.todoAssign);
    container.querySelector('#note-todo-editor [name=assignee]')?.focus();
  });
  container.querySelectorAll('[data-todo-copy-chat]').forEach(button=>button.onclick=async()=>{
    if(!noteTodo.readOnly && !noteTodo.browserManaged)vscode.postMessage({command:'copyText',text:button.dataset.todoCopyChat});
    else {
      try { await navigator.clipboard.writeText(button.dataset.todoCopyChat); button.title='PKM Chat URL copied'; }
      catch(error) { noteTodo.error=`Copy failed: ${error.message}`; noteTodoPaint(); }
    }
  });
  container.querySelectorAll('[data-todo-card-id]').forEach(card=>{
    card.addEventListener('dblclick',event=>{
      if(event.target.closest('button,a,input,select,textarea,details,summary'))return;
      noteTodoOpen(card.dataset.todoCardId);
    });
    card.addEventListener('dragstart',event=>{
      if(readonly||noteTodo.pending||card.draggable!==true){event.preventDefault();return;}
      event.dataTransfer.setData('application/x-pkm-work-item',card.dataset.todoCardId);
      event.dataTransfer.effectAllowed='move';
    });
  });
  if(!readonly)container.querySelectorAll('.note-todo-swimcell,[data-todo-story-drop]').forEach(cell=>{
    cell.addEventListener('dragover',event=>{if(!noteTodo.pending&&event.dataTransfer.types.includes('application/x-pkm-work-item')){event.preventDefault();event.dataTransfer.dropEffect='move';cell.classList.add('note-todo-drop-target');}});
    cell.addEventListener('dragleave',event=>{if(!cell.contains(event.relatedTarget))cell.classList.remove('note-todo-drop-target');});
    cell.addEventListener('drop',event=>noteTodoDrop(event,cell,cell.hasAttribute('data-todo-story-drop')));
  });
  container.querySelectorAll('[data-todo-action]').forEach(button=>{button.disabled=readonly||!!noteTodo.pending;button.onclick=()=>noteTodoAction(button.dataset.todoAction,button.dataset.todoId);});
  container.querySelectorAll('[data-todo-note]').forEach(button=>{button.onclick=()=>ask('detail',{type:'note',key:button.dataset.todoNote});});
}

const noteTodoProjectViews = new Map();
function noteTodoProjectLoad(projectId) {
  const container = document.getElementById('project-note-todos');
  if (!container) return;
  container.textContent = 'Loading Note Work Items…';
  const requestId = ++noteTodo.request;
  noteTodoProjectViews.set(projectId,{requestId});
  vscode.postMessage({command:'noteTodoProject',projectId,requestId});
}
function noteTodoProjectResult(data) {
  if (data?.requestId !== noteTodoProjectViews.get(data.projectId)?.requestId) return;
  const container = document.getElementById('project-note-todos');
  if (!container || container.dataset.projectId !== data.projectId) return;
  container.innerHTML = data.error ? `<p role="alert">${esc(data.error)}</p>` : noteTodoTimeline((data.records || []).filter(record=>!record.item.deletedAt));
  container.querySelectorAll('[data-todo-note]').forEach(button=>{button.onclick=()=>ask('detail',{type:'note',key:button.dataset.todoNote});});
}
