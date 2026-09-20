// ── Chatroom (agent room) ───────────────────────────────────────────────────
const chat = {
  cfg: { hubUrl: '', room: 'general', displayName: 'user', hasSecret: false, hubPort: 7345, inviteHosts: [], inviteHost: '', inviteHostUnavailable: false },
  rooms: [], storedRooms: [], activeKey: '', active: null, recents: [], hubAdminRooms: [], pendingApprovals: [], managedAgents: [],
  hubRunning: false, hubWsUrl: '', hubHttpUrl: '', hubPort: 0, hubError: '',
  secretShown: false, secretVal: '',
  rendered: false, showJoin: false,
  mode: 'ask',
  discussionLead: '',
  modeNoticeTimer: null,
  quote: null,
  manualRecipients: [],
  bodyRecipients: [],
  removedRecipients: [],
  selectedRecipientIndex: -1,
  followLatest: true,
  scrollPositions: {},
  scrollAnchors: {},
  restoringScroll: false,
  defaultRecipientCache: null,
  logSnapshotKey: '',
  drafts: {},
  meetingSummarySelections: {},
  proto: {},   // user -> {state:'standby'|'working'|'engaged'}: live protocol status
};
const chatInactiveExpanded = { hosted: false, joined: false };

// Sentinel that marks an agent-to-agent protocol frame carried in a chat message
// (must match WIRE_PREFIX in protocol.py).
const PKMX_PREFIX = '\u2b1b\u2b1bPKMX\u2b1b';
function chatIsProto(text) { return typeof text === 'string' && text.startsWith(PKMX_PREFIX); }
function chatProtoDecode(text) {
  try { const f = JSON.parse(text.slice(PKMX_PREFIX.length)); return (f && f.t) ? f : null; }
  catch (e) { return null; }
}
// Derive each participant's live protocol status from observed frames.
function chatTrackProto(fr) {
  if (!fr) return;
  const t = fr.t, who = fr.from;
  if (t === 'open') { chat.proto = {}; if (who) chat.proto[who] = { state: 'engaged' }; }
  else if (t === 'start') {
    const roster = (fr.meta && fr.meta.roster) || {};
    Object.keys(roster).forEach(n => { chat.proto[n] = { state: 'standby' }; });
  } else if (t === 'turn') {
    if (fr.kind === 'ack') chat.proto[who] = { state: 'working' };
    else if (fr.kind === 'result') chat.proto[who] = { state: 'standby' };
    else if (fr.kind === 'command') { chat.proto[who] = { state: 'engaged' }; }
  } else if (t === 'state') {
    const meta = fr.meta || {};
    const st = meta.state;
    if (st === 'idle' || st === 'left') delete chat.proto[who];
    else if (st) chat.proto[who] = { state: st };
  } else if (t === 'end' || t === 'end_ack' || t === 'rst') {
    chat.proto = {};   // session over — everyone drops out of the protocol
  }
  chatPaintMembers();
}
function chatProtoBadge(state) {
  if (state === 'thinking' || state === 'working') return '<span class="chat-proto thinking" title="Received a message and is thinking"><span class="chat-thinking-dot">.</span><span class="chat-thinking-dot">.</span><span class="chat-thinking-dot">.</span></span>';
  if (state === 'sending') return '<span class="chat-proto engaged" title="Sending a response">sending</span>';
  if (state === 'reconnecting') return '<span class="chat-proto working" title="Connection lost — reconnecting">reconnecting</span>';
  if (state === 'engaged') return '<span class="chat-proto engaged" title="In session — coordinating">🔵 in session</span>';
  if (state === 'idle') return '<span class="chat-proto idle" title="Disconnected from the Room">idle</span>';
  if (state === 'standby') return '<span class="chat-proto standby" title="Waiting for a directed @ message">standby</span>';
  return '';
}

function chatEnsureControlComments(root) {
  if (!root) return;
  const comments = {
    'chat-send-btn': 'Send this message using the selected mode and recipients.',
    'chat-stophub-btn': 'Stop the local Chat Hub and store its active Rooms.',
    'chat-admin-closeall': 'Close and store every Room hosted by this Hub.',
  };
  root.querySelectorAll('button,a,[role="button"]').forEach(control => {
    if (control.title) return;
    const idComment = comments[control.id];
    const label = control.getAttribute('aria-label') || control.textContent?.trim();
    control.title = idComment || (label ? `${label}.` : 'Chatroom action.');
  });
}

function chatOnAgentState(data) {
  if (!data || data.key !== chat.activeKey || !data.user) return;
  chat.proto[data.user] = { state: data.state || 'idle' };
  chatPaintMembers();
}

function renderChatroom() {
  chat.rendered = true;
  const d = document.getElementById('detail');
  d.style.padding = '0';
  d.style.overflow = 'hidden';
    d.innerHTML = `
  <div id="chat-root">
    <div id="chat-rail">
      <section class="chat-room-section chat-hosted-section">
        <div class="chat-room-section-head"><span>Hosted by me</span><span id="chat-hosted-count" class="chat-muted"></span></div>
        <div class="chat-host-controls">
        <label class="chat-host-interface"><span>Hosting on</span><select id="chat-invite-host" class="chat-in" onchange="chatInviteHostChanged(this.value)" title="Hostname or network interface advertised in every hosted Room Magic Link. The Hub still listens on all interfaces."></select></label>
        <div id="chat-invite-url" class="chat-hint"></div>
        <button class="tbtn chat-wide" id="chat-host-toggle" onclick="chatToggleHostForm()">＋ Host a Room</button>
        <div id="chat-host-form" class="chat-join hidden">
          <label class="chat-field-lbl">Room</label>
          <input id="chat-hub-room" class="chat-in" placeholder="general" title="Room to host and auto-join. You'll appear in this room in the extension too.">
          <label class="chat-field-lbl">Your name</label>
          <input id="chat-hub-name" class="chat-in" placeholder="Host" title="Your display name shown to others in this room.">
          <label class="chat-field-lbl">Room secret</label>
          <div style="display:flex;gap:4px">
            <input id="chat-hub-key" class="chat-in" placeholder="type or generate" title="Secret for THIS room. Teammates must enter it to join. Leave blank to auto-generate.">
            <button class="tbtn" onclick="chatGenKey()" title="Generate a random secret" style="flex-shrink:0">🎲</button>
          </div>
          <div id="chat-hub-port-wrap">
            <label class="chat-field-lbl">Port <span class="chat-muted">(blank = auto)</span></label>
            <input id="chat-hub-port" class="chat-in" placeholder="auto" title="Port to host the hub on. Leave blank (or 0) to auto-pick a free port. Only used when starting the hub.">
          </div>
          <button class="tbtn chat-wide" onclick="chatHostRoom()" style="border-color:var(--accent)">Host Room</button>
        </div>
        <button class="tbtn chat-wide hidden" id="chat-stophub-btn" onclick="ask('chatStopHub',{})" style="border-color:#f87171;color:#f87171">Stop Hub</button>
        </div>
        <div id="chat-hosted-rooms" class="chat-room-cards"></div>
        <div id="chat-pending-wrap" class="hidden">
          <div class="chat-rail-hdr">Pending joins</div>
          <div id="chat-pending-joins"></div>
        </div>
        <button class="tbtn chat-wide chat-close-all hidden" id="chat-admin-closeall" onclick="ask('chatAdminCloseAll',{})">Close all rooms</button>
      </section>
      <section class="chat-room-section chat-joined-section">
        <div class="chat-room-section-head"><span>Joined before</span><span id="chat-joined-count" class="chat-muted"></span></div>
        <button class="tbtn chat-wide" onclick="chatToggleJoin()">＋ Join room</button>
        <div id="chat-join" class="chat-join hidden">
        <label class="chat-field-lbl">Hub URL</label>
        <input id="chat-url" class="chat-in" placeholder="ws://host:port  or  ws://host:port/room" oninput="chatUrlAutoRoom()" title="Address of the hub, e.g. ws://10.0.0.5:7345. You can paste a full room link (ws://host:port/room) and the Room below is filled automatically.">
        <label class="chat-field-lbl">Room <span class="chat-muted">(optional — auto-filled from a full room URL)</span></label>
        <input id="chat-room" class="chat-in" placeholder="auto from URL, or e.g. general" title="The room/channel to join. Leave blank if the Hub URL already includes the room (ws://host:port/room). Everyone in the same room shares one conversation.">
        <label class="chat-field-lbl">Your display name</label>
        <input id="chat-name" class="chat-in" placeholder="e.g. yu" title="The name others see in the room. Must be unique within the room.">
        <label class="chat-field-lbl">Shared secret</label>
        <input id="chat-secret-in" class="chat-in" type="password" placeholder="paste the secret from the host" title="The team shared secret the host gave you. Saved locally so you don't retype it.">
        <button class="tbtn chat-wide" onclick="chatDoJoin()" style="border-color:var(--accent)">Join</button>
        <div id="chat-join-hint" class="chat-hint"></div>
      </div>
        <div id="chat-joined-rooms" class="chat-room-cards"></div>
      </section>
    </div>
    <div id="chat-rail-resizer" title="Drag to resize"><button id="chat-rail-toggle" class="panel-collapse-toggle chat-rail-toggle" onclick="event.stopPropagation();chatToggleHubPanel()" onmousedown="event.stopPropagation()" title="Minimize Chatroom Hub panel" aria-label="Minimize Chatroom Hub panel">◀</button></div>
    <div id="chat-pane">
      <div id="chat-empty-pane" class="chat-empty-pane">Join a room to start or host one through Hub on the left.</div>
      <div id="chat-active" class="hidden">
        <div id="chat-pane-bar">
          <span id="chat-status-dot" class="chat-dot"></span>
          <span id="chat-pane-title"></span>
          <span style="flex:1"></span>
          <button class="tbtn" id="chat-meeting-summary-btn" onclick="chatToggleMeetingSummary()" title="Open the continuously updated Meeting Summary">Meeting Summary</button>
          <button class="tbtn hidden" id="chat-add-agent-btn" data-pending-label="Detecting models…" onclick="ask('chatAddManagedAgent',{},this)" title="Add an AI agent managed by this extension">＋ Agent</button>
          <button class="tbtn" onclick="chatRenameSelf()" title="Change your display name in this room">✏️ Rename me</button>
          <button class="tbtn" onclick="ask('chatShareFile',{})" title="Share a file with the room (peers must be online)">📎 Share</button>
          <button class="tbtn" onclick="ask('chatExport',{})" title="Download this room's transcript">⬇ Download</button>
          <button class="tbtn" id="chat-leave-btn" onclick="chatLeaveActive()" title="Leave this room">Leave Room</button>
        </div>
        <div id="chat-body">
          <div id="chat-main">
            <section id="chat-meeting-summary" class="chat-meeting-summary hidden" aria-label="Meeting Summary">
              <header class="chat-meeting-summary-head"><div><span>Meeting Summary</span><small>Generated from canonical state</small></div><button type="button" class="icon-btn" onclick="chatToggleMeetingSummary(false)" title="Close Meeting Summary" aria-label="Close Meeting Summary">×</button></header>
              <div id="chat-meeting-summary-body" class="chat-meeting-summary-body"></div>
            </section>
            <div id="chat-find" class="find-control">
              <input id="chat-searchbox" type="search" placeholder="Find messages…" oninput="chatRefreshSearch()" onkeydown="chatSearchKeydown(event)" title="Find in loaded messages">
              <span id="chat-search-count" class="find-count">0/0</span>
              <button type="button" onclick="navigateFind('chat',-1)" title="Previous matching message">↑</button>
              <button type="button" onclick="navigateFind('chat',1)" title="Next matching message">↓</button>
              <button id="chat-search-case" type="button" onclick="toggleFindOption('chat','case')" title="Match case">Aa</button>
              <button id="chat-search-regex" type="button" onclick="toggleFindOption('chat','regex')" title="Use regular expression">.*</button>
            </div>
            <div id="chat-log"></div>
            <button id="chat-jump-latest" class="chat-jump-latest hidden" type="button" onclick="chatPinLatest()" data-i18n="chat.jumpLatest" data-i18n-title="chat.followLatestTitle" title="Show the latest message and keep following new messages">↓ Show latest message</button>
            <div id="chat-mode-control" class="chat-mode-control hidden" role="group" aria-label="Message mode">
              <button type="button" data-mode="announce" onclick="chatSetMode('announce')" title="Notify the selected recipients without requesting an acknowledgement or reply.">Announce</button>
              <button type="button" data-mode="ask" onclick="chatSetMode('ask')" class="active" title="Ask each selected recipient for one required response.">Ask</button>
              <button type="button" data-mode="discuss" onclick="chatSetMode('discuss')" title="Invite the selected recipients into a shared peer discussion.">Discuss</button><label id="chat-discussion-lead-wrap" class="chat-discussion-lead hidden"><span>Lead</span><select id="chat-discussion-lead" onchange="chat.discussionLead=this.value;chatCaptureDraft()" title="Choose the Lead for this Discussion"></select></label>
            </div>
            <div id="chat-mode-notice" class="chat-mode-notice hidden" role="status" aria-live="polite"></div>
            <div id="chat-quote-bar" class="chat-quote-bar hidden"></div>
            <div id="chat-input-row">
              <div id="chat-composer">
                <div id="chat-recipient-row" title="Recipients. Type @ to add people; use arrows and Backspace/Delete to edit tokens."><span class="chat-recipient-label">To</span><div id="chat-recipient-chips"></div><input id="chat-recipient-input" type="text" autocomplete="off" spellcheck="false" placeholder="@ recipient" aria-label="Add recipients"></div>
                <div id="chat-input-wrap">
                <div id="chat-mention-pop" class="hidden"></div>
                <textarea id="chat-input" rows="1" placeholder="Message the room…  (Enter to send, Shift+Enter for newline)" disabled></textarea>
                </div>
              </div>
              <button class="tbtn" id="chat-send-btn" onclick="chatSend()" disabled>Send</button>
            </div>
          </div>
          <div id="chat-side-resizer" title="Drag to resize members"><button id="chat-side-toggle" class="panel-collapse-toggle chat-side-toggle" onclick="event.stopPropagation();chatToggleMemberPane()" onmousedown="event.stopPropagation()" title="Minimize In the room panel" aria-label="Minimize In the room panel">▶</button></div>
          <div id="chat-side">
            <div class="chat-side-hdr">In the room</div>
            <div id="chat-members"><div class="chat-empty">—</div></div>
          </div>
        </div>
      </div>
    </div>
    <div id="chat-message-viewer" class="chat-message-viewer hidden" role="dialog" aria-modal="true" aria-label="Expanded Chatroom message">
      <div class="chat-message-viewer-panel">
        <div class="chat-message-viewer-head"><span id="chat-message-viewer-title"></span><span class="chat-message-viewer-actions"><button type="button" title="Copy the original message text" onclick="chatCopyViewedMessage()">Copy</button><button type="button" title="Toggle fullscreen message view" onclick="chatToggleViewerFullscreen()">Fullscreen</button><button type="button" title="Close expanded message view" onclick="chatCloseMessageViewer()">Close</button></span></div>
        <div id="chat-message-viewer-body" class="chat-message-viewer-body prose"></div>
      </div>
    </div>
  </div>`;
  document.getElementById('chat-url').value  = chat.cfg.hubUrl || chat.hubWsUrl || '';
  document.getElementById('chat-room').value = chat.cfg.room || 'general';
  document.getElementById('chat-name').value = chat.cfg.displayName || 'user';
  const inp = document.getElementById('chat-input');
  inp.addEventListener('keydown', chatInputKeydown);
  inp.addEventListener('input', chatBodyInput);
  const recipientInput = document.getElementById('chat-recipient-input');
  recipientInput.addEventListener('input', chatRecipientInputChanged);
  recipientInput.addEventListener('keydown', chatRecipientInputKeydown);
  document.getElementById('chat-log')?.addEventListener('scroll', chatTrackScroll, { passive: true });
  chatEnsureControlComments(d);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { chatCloseMessageViewer(); chatToggleMeetingSummary(false); } });
  document.addEventListener('click', ev => {
    const pop = document.getElementById('chat-mention-pop');
    if (pop && !pop.classList.contains('hidden') && !pop.contains(ev.target) && ev.target.id !== 'chat-recipient-input') chatHideMentionPop();
  });
  chat.secretShown = false; chat.secretVal = '';
  chatPaintRoomCards();
  chatPaintActive();
  chatPaintHub();
  chatInitResizer();
  chatApplyHubPanelState();
  chatApplyMemberPaneState();
  chatRestoreDraft();
}

function chatMeetingSummaryHtml() {
  const meetings = chat.active?.meetings || { current: null, history: [], trash: [] };
  const records = [meetings.current, ...(meetings.history || [])].filter(Boolean);
  const selected = records.find(record => record.id === chat.meetingSummarySelections[chat.activeKey || '']) || meetings.current || records[0];
  if (selected) chat.meetingSummarySelections[chat.activeKey || ''] = selected.id;
  const rows = records.map((record, index) => `${index === 0 && meetings.current ? '<div class="chat-meeting-list-label">Current</div>' : index === (meetings.current ? 1 : 0) ? '<div class="chat-meeting-list-label">Earlier</div>' : ''}<button type="button" class="chat-meeting-list-item${record.id === selected?.id ? ' active' : ''}" data-meeting-id="${record.id}" onclick="chatSelectMeetingSummary('${record.id}',this)" ${record.status === 'adjourned' ? `oncontextmenu="chatMeetingContextMenu(event,'${record.id}')" title="Right-click for Meeting actions"` : ''}><strong>${chatMeetingDate(record.startedAt)}</strong><span>${esc(record.title)}</span><small>${record.status === 'active' ? 'In Discussion' : 'Completed'}</small></button>`).join('');
  const trash = meetings.trash || [];
  const trashHtml = `<details class="chat-meeting-trash"><summary><span>Trash</span><small>${trash.length}</small></summary><div>${trash.length ? trash.map(record => `<div class="chat-meeting-trash-item"><span><strong>${esc(record.title)}</strong><small>${chatMeetingDate(record.deletedAt)}</small></span>${chat.active?.selfHost ? `<span class="chat-meeting-trash-actions"><button type="button" onclick="chatRestoreMeeting('${record.id}',${record.revision})" title="Restore Meeting">↶</button><button type="button" onclick="chatDeleteMeeting('${record.id}',${record.revision})" title="Delete permanently">×</button></span>` : ''}</div>`).join('') : '<p>Trash is empty.</p>'}</div></details>`;
  const empty = `<div class="chat-meeting-empty"><h2>No Meeting yet</h2><p>Send a Discuss message to start a continuously updated Meeting Summary. Ask and Announce never create Meeting state.</p>${chat.active?.selfHost ? '<button type="button" class="tbtn" onclick="chatStartMeeting()">Retry from latest Discuss</button>' : '<small>The Room Host records canonical Meeting state.</small>'}</div>`;
  return `<div class="chat-meeting-workspace"><aside class="chat-meeting-list" aria-label="Meetings">${rows || '<div class="chat-meeting-list-label">No history</div>'}${trashHtml}</aside><div id="chat-meeting-document" class="chat-meeting-document">${selected ? chatMeetingRecordHtml(selected) : empty}</div></div>`;
}

function chatHistoricalMeetingSummaryHtml(meetingId) {
  const meetings = chat.active?.meetings || { current: null, history: [] };
  const record = [meetings.current, ...(meetings.history || [])].find(item => item?.id === meetingId);
  return record ? chatMeetingRecordHtml(record) : '';
}

function chatMeetingDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? esc(value) : date.toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

function chatMeetingTopicHtml(topic, activeTopicId, depth = 0) {
  const rounds = (topic.rounds || []).map(round => `<article class="chat-meeting-round"><header><strong>Round ${round.number}</strong><small>${round.status}</small></header>${(round.opinions || []).map(opinion => `<div class="chat-meeting-opinion"><b>${esc(opinion.participant)}</b><span>${esc(opinion.text)}</span></div>`).join('')}<div class="chat-meeting-result"><b>Conclusion</b><span class="${round.conclusion ? 'complete' : 'pending'}">${esc(round.conclusion || 'Pending')}</span></div><div class="chat-meeting-result"><b>Next</b><span class="active">${esc(round.next || 'Continue discussion')}</span></div></article>`).join('');
  const work = (topic.workItems || []).length ? topic.workItems.map(item => `<div class="chat-meeting-work"><b>${esc(item.owner || 'Unassigned')}</b><span>${esc(item.objective || '')}</span><em>${esc(item.status || 'Pending Acceptance')}</em></div>`).join('') : '<p class="chat-muted">No WorkItems recorded.</p>';
  const subtopics = (topic.subtopics || []).map(child => chatMeetingTopicHtml(child, activeTopicId, depth + 1)).join('');
  return `<details class="chat-meeting-topic" ${topic.id === activeTopicId || depth === 0 ? 'open' : ''}><summary><span class="chat-meeting-arrow">▶</span><span><strong>${depth ? 'Subtopic' : 'Topic'} · ${esc(topic.title)}</strong><small>Owner: ${esc(topic.owner)} · Round ${topic.round} ${topic.id === activeTopicId ? '· active DFS node' : ''}</small></span><em class="chat-meeting-state ${topic.status === 'discussing' ? 'active' : topic.status}">${esc(topic.status)}</em></summary><div class="chat-meeting-topic-body"><section class="chat-meeting-branch"><label>Problem statement</label><p>${esc(topic.problemStatement)}</p></section><section class="chat-meeting-branch"><label>Discussion result</label>${rounds}</section><section class="chat-meeting-branch"><label>WorkItems</label>${work}</section>${subtopics ? `<div class="chat-meeting-subtopics"><label>Subtopics</label>${subtopics}</div>` : ''}</div></details>`;
}

function chatMeetingRecordHtml(record) {
  const active = record.status === 'active';
  const action = active && chat.active?.selfHost ? `<button type="button" class="tbtn chat-meeting-adjourn" onclick="chatAdjournMeeting('${record.id}',${record.revision})">Adjourn</button>` : '';
  const note = chat.active?.selfHost ? `<button type="button" class="tbtn" onclick="chatOpenMeetingNote('${record.id}')">Open detailed Note</button>` : '';
  const participants = (record.participants || []).map(name => `<span>${esc(name)}</span>`).join('') || '<span>Not recorded</span>';
  return `<div class="chat-meeting-document-head"><div><small>${active ? 'Active meeting' : 'Read-only history'}</small><h2>${esc(record.title)}</h2></div><div class="chat-meeting-head-actions"><span class="chat-meeting-state ${active ? 'active' : 'complete'}">${active ? 'In Discussion' : 'Completed'}</span>${note}${action}</div></div><dl class="chat-meeting-minutes-meta"><div><dt>Participants</dt><dd class="chat-meeting-participants">${participants}</dd></div><div><dt>Lead</dt><dd>${esc(record.lead || 'Not assigned')}</dd></div><div><dt>Recorder</dt><dd>${esc(record.recorder || record.lead)}</dd></div><div><dt>Started</dt><dd>${chatMeetingDate(record.startedAt)}</dd></div><div><dt>Ended</dt><dd>${record.endedAt ? chatMeetingDate(record.endedAt) : 'In progress'}</dd></div></dl>${(record.topics || []).map(topic => chatMeetingTopicHtml(topic, record.activeTopicId)).join('')}`;
}

function chatOpenMeetingNote(meetingId) {
  vscode.postMessage({ command:'chatMeetingOpenNote', meetingId });
}

function chatMeetingRequestId() {
  return globalThis.crypto?.randomUUID?.() || `meeting-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function chatStartMeeting() {
  vscode.postMessage({ command:'chatMeetingStart', requestId:chatMeetingRequestId(), expectedRevision:0 });
}

function chatAdjournMeeting(meetingId, expectedRevision) {
  pkModal({ title:'Adjourn Meeting?', message:'This closes the current Meeting and moves its generated Summary into Room history.', okLabel:'Adjourn', onOk:() => vscode.postMessage({ command:'chatMeetingAdjourn', meetingId, requestId:chatMeetingRequestId(), expectedRevision }) });
}

function chatMeetingContextMenu(event, meetingId) {
  event.preventDefault(); event.stopPropagation();
  const record = (chat.active?.meetings?.history || []).find(item => item.id === meetingId);
  if (!record || !chat.active?.selfHost) return;
  showPaperMenu(event.clientX, event.clientY, [
    { label:record.title, header:true },
    { sep:true },
    { label:'Move to Trash…', danger:true, onClick:() => pkModal({ title:'Move Meeting to Trash?', message:'The generated Meeting Note will leave Notes until this Meeting is restored.', okLabel:'Move to Trash', danger:true, onOk:() => vscode.postMessage({ command:'chatMeetingTrash', meetingId, requestId:chatMeetingRequestId(), expectedRevision:record.revision }) }) },
  ]);
}

function chatRestoreMeeting(meetingId, expectedRevision) {
  vscode.postMessage({ command:'chatMeetingRestore', meetingId, requestId:chatMeetingRequestId(), expectedRevision });
}

function chatDeleteMeeting(meetingId, expectedRevision) {
  pkModal({ title:'Delete Meeting permanently?', message:'This permanently deletes the canonical Meeting Summary and cannot be undone. Raw Chat History is not changed.', okLabel:'Delete Permanently', danger:true, onOk:() => vscode.postMessage({ command:'chatMeetingDelete', meetingId, requestId:chatMeetingRequestId(), expectedRevision }) });
}

function chatSelectMeetingSummary(meetingId, button) {
  chat.meetingSummarySelections[chat.activeKey || ''] = meetingId;
  const documentView = document.getElementById('chat-meeting-document');
  if (!documentView) return;
  document.querySelectorAll('.chat-meeting-list-item').forEach(item => item.classList.toggle('active', item === button));
  documentView.innerHTML = chatHistoricalMeetingSummaryHtml(meetingId);
}

function chatPaintMeetingSummary() {
  const body = document.getElementById('chat-meeting-summary-body');
  if (!body) return;
  body.innerHTML = chatMeetingSummaryHtml();
}

function chatToggleMeetingSummary(force) {
  const panel = document.getElementById('chat-meeting-summary');
  const button = document.getElementById('chat-meeting-summary-btn');
  if (!panel) return;
  const open = typeof force === 'boolean' ? force : panel.classList.contains('hidden');
  if (open) chatPaintMeetingSummary();
  panel.classList.toggle('hidden', !open);
  button?.classList.toggle('active', open);
  button?.setAttribute('aria-pressed', String(open));
}

function chatDraftKey(key = chat.activeKey) { return key || ''; }
function chatCaptureDraft(key = chat.activeKey) {
  const draftKey = chatDraftKey(key);
  if (!draftKey) return;
  const input = document.getElementById('chat-input');
  const recipientInput = document.getElementById('chat-recipient-input');
  const existing = chat.drafts[draftKey] || {};
  chat.drafts[draftKey] = {
    ...existing,
    text: input ? input.value : existing.text || '',
    selectionStart: input ? input.selectionStart : existing.selectionStart,
    selectionEnd: input ? input.selectionEnd : existing.selectionEnd,
    recipientText: recipientInput ? recipientInput.value : existing.recipientText || '',
    manualRecipients: [...chat.manualRecipients],
    removedRecipients: [...chat.removedRecipients],
    mode: chat.mode,
    discussionLead: chat.discussionLead,
    quote: chat.quote ? { ...chat.quote } : null,
  };
}

function chatRestoreDraft(key = chat.activeKey) {
  const draftKey = chatDraftKey(key);
  const input = document.getElementById('chat-input');
  if (!draftKey || !input) return;
  const draft = chat.drafts[draftKey];
  chat.manualRecipients = [...(draft?.manualRecipients || [])];
  chat.removedRecipients = [...(draft?.removedRecipients || [])];
  chat.mode = draft?.mode || 'ask';
  chat.discussionLead = draft?.discussionLead || '';
  chat.quote = draft?.quote ? { ...draft.quote } : null;
  input.value = draft?.text || '';
  const recipientInput = document.getElementById('chat-recipient-input');
  if (recipientInput) recipientInput.value = draft?.recipientText || '';
  if (Number.isInteger(draft?.selectionStart)) {
    input.selectionStart = Math.min(draft.selectionStart, input.value.length);
    input.selectionEnd = Math.min(draft.selectionEnd ?? draft.selectionStart, input.value.length);
  }
  chatResizeInput(input);
  chatUpdateDefaultRecipient();
  chatPaintMode();
  chatPaintQuote();
}

// Drag the divider between the left rail (Hub/Rooms) and the chat pane to resize.
function chatInitResizer() {
  const rz = document.getElementById('chat-rail-resizer');
  const rail = document.getElementById('chat-rail');
  if (!rz || !rail) return;
  let saved = 0;
  try { saved = Number(localStorage.getItem('pk-chat-rail')) || 0; } catch (e) {}
  if (saved >= 140 && saved <= 600) rail.style.width = saved + 'px';
  rz.addEventListener('mousedown', e => {
    const startX = e.clientX, startW = rail.getBoundingClientRect().width;
    rz.classList.add('active'); document.body.classList.add('chat-resizing');
    const move = ev => { const w = Math.max(140, Math.min(600, startW + (ev.clientX - startX))); rail.style.width = w + 'px'; };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      rz.classList.remove('active'); document.body.classList.remove('chat-resizing');
      try { localStorage.setItem('pk-chat-rail', String(Math.round(rail.getBoundingClientRect().width))); } catch (e) {}
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    e.preventDefault();
  });
  chatInitMemberResizer();
}

function chatInitMemberResizer() {
  const handle = document.getElementById('chat-side-resizer');
  const side = document.getElementById('chat-side');
  if (!handle || !side || handle.dataset.resizeBound) return;
  handle.dataset.resizeBound = '1';
  handle.addEventListener('mousedown', event => {
    if (event.target.closest('button')) return;
    const startX = event.clientX;
    const startWidth = side.getBoundingClientRect().width;
    handle.classList.add('active');
    document.body.classList.add('column-resizing');
    const move = moveEvent => {
      const width = Math.max(54, Math.min(500, startWidth - (moveEvent.clientX - startX)));
      side.style.width = `${width}px`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      handle.classList.remove('active');
      document.body.classList.remove('column-resizing');
      const key = chatMemberPaneCollapsed() ? 'pk-chat-side-compact' : 'pk-chat-side';
      try { localStorage.setItem(key, String(Math.round(side.getBoundingClientRect().width))); } catch {}
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    event.preventDefault();
  });
}

function chatMemberPaneCollapsed() {
  try { return localStorage.getItem('pk-chat-side-collapsed') === '1'; } catch { return false; }
}
function chatApplyMemberPaneState() {
  const body = document.getElementById('chat-body');
  const toggle = document.getElementById('chat-side-toggle');
  const side = document.getElementById('chat-side');
  if (!body || !toggle || !side) return;
  const collapsed = chatMemberPaneCollapsed();
  let width = collapsed ? 86 : 170;
  try { width = Number(localStorage.getItem(collapsed ? 'pk-chat-side-compact' : 'pk-chat-side')) || width; } catch {}
  side.style.width = `${Math.max(54, Math.min(500, width))}px`;
  body.classList.toggle('chat-side-collapsed', collapsed);
  toggle.textContent = collapsed ? '◀' : '▶';
  toggle.title = collapsed ? 'Restore full In the room panel' : 'Minimize In the room panel to status and name';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.setAttribute('aria-expanded', String(!collapsed));
}
function chatToggleMemberPane() {
  const side = document.getElementById('chat-side');
  const currentlyCollapsed = chatMemberPaneCollapsed();
  if (side) {
    try { localStorage.setItem(currentlyCollapsed ? 'pk-chat-side-compact' : 'pk-chat-side', String(Math.round(side.getBoundingClientRect().width))); } catch {}
  }
  const collapsed = !chatMemberPaneCollapsed();
  try { localStorage.setItem('pk-chat-side-collapsed', collapsed ? '1' : '0'); } catch {}
  chatApplyMemberPaneState();
}

function chatHubPanelCollapsed() {
  try { return localStorage.getItem('pk-chat-rail-collapsed') === '1'; } catch { return false; }
}
function chatApplyHubPanelState() {
  const root = document.getElementById('chat-root');
  const toggle = document.getElementById('chat-rail-toggle');
  if (!root || !toggle) return;
  const collapsed = chatHubPanelCollapsed();
  root.classList.toggle('chat-rail-collapsed', collapsed);
  toggle.textContent = collapsed ? '▶' : '◀';
  toggle.title = collapsed ? 'Restore Chatroom Hub panel' : 'Minimize Chatroom Hub panel';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.setAttribute('aria-expanded', String(!collapsed));
}
function chatToggleHubPanel() {
  const collapsed = !chatHubPanelCollapsed();
  try { localStorage.setItem('pk-chat-rail-collapsed', collapsed ? '1' : '0'); } catch {}
  chatApplyHubPanelState();
}

function chatIsNearBottom(log) { return !!log && log.scrollHeight - log.scrollTop - log.clientHeight <= 40; }
function chatCaptureScrollAnchor(log) {
  if (!log) return null;
  const children = Array.from(log.children);
  const element = children.find(child => child.offsetTop + child.offsetHeight > log.scrollTop) || children[0];
  if (!element) return null;
  return { messageId: element.dataset?.messageId || '', index: children.indexOf(element), offset: element.offsetTop - log.scrollTop };
}
function chatRestoreScrollAnchor(log, anchor, fallbackTop = 0) {
  if (!log) return;
  const children = Array.from(log.children);
  const element = (anchor?.messageId && children.find(child => child.dataset?.messageId === anchor.messageId))
    || (Number.isInteger(anchor?.index) ? children[Math.min(anchor.index, children.length - 1)] : null);
  chat.restoringScroll = true;
  log.scrollTop = element ? element.offsetTop - (anchor.offset || 0) : fallbackTop;
  requestAnimationFrame(() => { chat.restoringScroll = false; });
}
function chatPreserveReadingLayout(mutate) {
  const log = document.getElementById('chat-log');
  if (!log) { mutate(); return; }
  const shouldFollow = chat.followLatest;
  const anchor = !shouldFollow ? chatCaptureScrollAnchor(log) : null;
  const fallbackTop = log.scrollTop;
  mutate();
  const restore = () => {
    if (shouldFollow) {
      chat.followLatest = true;
      chatScrollLatest(log);
    } else {
      chat.followLatest = false;
      chatRestoreScrollAnchor(log, anchor, fallbackTop);
      document.getElementById('chat-jump-latest')?.classList.remove('hidden');
    }
  };
  restore();
  requestAnimationFrame(restore);
}
function chatTrackScroll() {
  const log = document.getElementById('chat-log');
  if (!log || chat.restoringScroll) return;
  chat.followLatest = chatIsNearBottom(log);
  if (chat.activeKey) {
    chat.scrollPositions[chat.activeKey] = log.scrollTop;
    if (!chat.followLatest) chat.scrollAnchors[chat.activeKey] = chatCaptureScrollAnchor(log);
  }
  document.getElementById('chat-jump-latest')?.classList.toggle('hidden', chat.followLatest);
}
function chatScrollLatest(log = document.getElementById('chat-log')) {
  if (!log || !chat.followLatest) return;
  log.scrollTop = log.scrollHeight;
  if (chat.activeKey) chat.scrollPositions[chat.activeKey] = log.scrollTop;
  document.getElementById('chat-jump-latest')?.classList.add('hidden');
}
function chatPinLatest() {
  const log = document.getElementById('chat-log');
  if (!log) return;
  chat.followLatest = true;
  delete chat.scrollAnchors[chat.activeKey];
  chatScrollLatest(log);
  requestAnimationFrame(() => chatScrollLatest(log));
}
function chatRefreshSearch(preserveCurrent = false) {
  const root = document.getElementById('chat-log');
  const options = findOptions('chat');
  const pattern = compileFindPattern(options.query, options.regex, options.caseSensitive);
  const current = findState.chat;
  const previousIndex = current.index;
  const previousMessageId = preserveCurrent && previousIndex >= 0 ? current.targets[previousIndex]?.dataset?.messageId || '' : '';
  current.targets.forEach(target => target.classList.remove('search-current'));
  current.index = -1; current.targets = [];
  if (pattern === false) { clearFindMarks(root); updateFindStatus('chat', true); return; }
  const marks = markFindMatches(root, pattern);
  current.targets = [...new Set(marks.map(mark => mark.closest('.chat-msg,.chat-sys')).filter(Boolean))];
  if (current.targets.length) {
    current.index = preserveCurrent ? preservedFindIndex(current.targets, previousMessageId, previousIndex) : 0;
    current.targets[current.index].classList.add('search-current');
  }
  updateFindStatus('chat', false);
}
function chatSearchKeydown(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault(); navigateFind('chat', event.shiftKey ? -1 : 1);
}

function chatToggleJoin() {
  chat.showJoin = !chat.showJoin;
  const j = document.getElementById('chat-join');
  if (j) j.classList.toggle('hidden', !chat.showJoin);
  const s = document.getElementById('chat-secret-in');
  if (s) s.placeholder = 'the room secret (from the host)';
}

function chatOnConfig(cfg) {
  chat.cfg = Object.assign(chat.cfg, cfg || {});
  if (!chat.rendered || state.tab !== 'chatroom') return;
  const u = document.getElementById('chat-url');   if (u && !u.value) u.value = chat.cfg.hubUrl || '';
  const r = document.getElementById('chat-room');  if (r && !r.value) r.value = chat.cfg.room || 'general';
  const n = document.getElementById('chat-name');  if (n && !n.value) n.value = chat.cfg.displayName || 'user';
  chatPaintInviteHosts();
}

function chatPaintInviteHosts() {
  const select = document.getElementById('chat-invite-host');
  const hint = document.getElementById('chat-invite-url');
  if (!select) return;
  const options = chat.cfg.inviteHosts || [];
  select.innerHTML = options.map(item => `<option value="${esc(item.address)}" ${item.address === chat.cfg.inviteHost ? 'selected' : ''}>${esc(item.label || ((item.interface || 'Interface') + ' · ' + item.address))}</option>`).join('');
  if (chat.cfg.inviteHostUnavailable) select.insertAdjacentHTML('afterbegin', `<option value="${esc(chat.cfg.inviteHost)}" selected disabled>Unavailable · ${esc(chat.cfg.inviteHost)}</option>`);
  select.disabled = !options.length;
  const port = chat.hubPort || chat.cfg.hubPort || 7345;
  if (hint) hint.innerHTML = chat.cfg.inviteHostUnavailable
    ? `<span style="color:#f87171">Saved interface is unavailable. Choose another hostname or network interface.</span>`
    : chat.cfg.inviteHost ? `Magic Links will advertise <code>ws://${esc(chat.cfg.inviteHost)}:${port}</code>` : '<span style="color:#f87171">No hostname or network interface is available.</span>';
}

function chatInviteHostChanged(address) {
  if (!address) return;
  chat.cfg.inviteHost = address;
  chat.cfg.inviteHostUnavailable = false;
  chatPaintInviteHosts();
  ask('chatSetInviteHost', { address });
}

function chatOnState(s) {
  if (!s) return;
  const existingLog = document.getElementById('chat-log');
  const previousKey = chat.activeKey;
  if (previousKey) chatCaptureDraft(previousKey);
  if (existingLog && previousKey) {
    chat.scrollPositions[previousKey] = existingLog.scrollTop;
    chat.followLatest = chatIsNearBottom(existingLog);
    if (!chat.followLatest) chat.scrollAnchors[previousKey] = chatCaptureScrollAnchor(existingLog);
  }
  chat.rooms = s.rooms || [];
  chat.storedRooms = s.storedRooms || [];
  chat.activeKey = s.activeKey || '';
  if (chat.activeKey !== previousKey) chat.followLatest = chat.scrollPositions[chat.activeKey] == null;
  chat.active = s.active || null;
  chat.hubRunning = !!s.hubRunning;
  chat.hubWsUrl = s.hubUrl ?? chat.hubWsUrl;
  chat.hubHttpUrl = s.hubHttpUrl ?? chat.hubHttpUrl;
  chat.hubPort = s.hubPort ?? chat.hubPort;
  chat.hubAdminRooms = s.hubAdminRooms || [];
  chat.pendingApprovals = s.pendingApprovals || [];
  chat.managedAgents = s.managedAgents || [];
  chatPaintInviteHosts();
  if (chat.hubRunning) chat.hubError = '';   // running truth clears any stale error
  if (state.tab !== 'chatroom') return;
  chatPaintRoomCards();
  chatPaintActive();
  chatPaintHub();
  if (chat.activeKey !== previousKey) chatRestoreDraft();
}

function chatOnRecents(d) {
  chat.recents = (d && d.recents) || [];
  if (state.tab === 'chatroom') chatPaintRoomCards();
}

function chatOnMessage(d) {
  if (state.tab !== 'chatroom' || !d || d.key !== chat.activeKey) return;
  chatAppend(d.message);
}

function chatOnFileReady(d) {
  if (state.tab !== 'chatroom' || !d || d.key !== chat.activeKey) return;
  chatAppendFileRow(d.key, d);
}

function chatToast(err) {
  if (!err) return;
  // Reveal the join form so the user can fix the name/secret and retry.
  chat.showJoin = true;
  const j = document.getElementById('chat-join'); if (j) j.classList.remove('hidden');
  const hint = document.getElementById('chat-join-hint');
  if (hint) hint.innerHTML = `<span style="color:#f87171">${esc(err)}</span>`;
}

function chatOnHubResult(res) {
  if (!res) return;
  if (res.ok) {
    chat.hubError = '';
    chat.hubRunning = true;                       // success is authoritative → no red
    if (res.wsUrl)   chat.hubWsUrl   = res.wsUrl;
    if (res.httpUrl) chat.hubHttpUrl = res.httpUrl;
    if (res.wsUrl) { try { chat.cfg.inviteHost = new URL(res.wsUrl).hostname; } catch {} }
    const u = document.getElementById('chat-url');
    if (u && !u.value) u.value = res.wsUrl || '';
  } else {
    chat.hubError = res.error || 'unknown — run “Personal Knowledge Manager: Show Logs” for details';
  }
  chatPaintInviteHosts();
  chatPaintHub();
}

function chatOpenRoomBrowser(room) {
  if (chat.hubHttpUrl) ask('openExternal', { url: chat.hubHttpUrl + '/room/' + encodeURIComponent(room) });
}
function chatOpenRoomBrowserAt(url, room) {
  try {
    const target = new URL(url);
    target.protocol = target.protocol === 'wss:' ? 'https:' : target.protocol === 'ws:' ? 'http:' : target.protocol;
    target.pathname = '/room/' + encodeURIComponent(room);
    target.search = ''; target.hash = '';
    ask('openExternal', { url: target.toString() });
  } catch {}
}

// Reveal/hide the shared secret. The value is fetched on demand from the host's
// own settings (never proactively pushed to the webview).
function chatToggleSecret() {
  if (chat.secretShown) {
    chat.secretShown = false; chat.secretVal = '';
    const el = document.getElementById('chat-secret-val'); if (el) el.textContent = '••••••';
  } else {
    ask('chatRevealSecret', {});
  }
}

function chatOnSecret(secret) {
  chat.secretVal = secret || '';
  chat.secretShown = true;
  const el = document.getElementById('chat-secret-val');
  if (el) el.textContent = chat.secretVal || '(none set)';
}

function chatDoJoin() {
  const raw  = document.getElementById('chat-url').value.trim();
  // A full room link (ws://host:port/<room>) carries the room in its path — split it
  // out so the user only needs to paste the Hub URL. An explicit Room field overrides.
  let url = raw, roomFromUrl = '';
  const m = raw.match(/^(wss?:\/\/[^/]+)(?:\/(.+))?$/i);
  if (m) { url = m[1]; if (m[2]) { try { roomFromUrl = decodeURIComponent(m[2]); } catch { roomFromUrl = m[2]; } } }
  const room = document.getElementById('chat-room').value.trim() || roomFromUrl || 'general';
  const user = document.getElementById('chat-name').value.trim() || 'user';
  const secret = document.getElementById('chat-secret-in').value.trim();
  const hint = document.getElementById('chat-join-hint');
  if (!url) { if (hint) hint.innerHTML = '<span style="color:#f87171">Enter a hub URL (ws://host:port or a full room link).</span>'; return; }
  if (!secret) { if (hint) hint.innerHTML = '<span style="color:#f87171">Enter the room secret the host gave you.</span>'; return; }
  if (hint) hint.textContent = '';
  ask('chatConnect', { url, room, user, secret });
  document.getElementById('chat-secret-in').value = '';
  chat.showJoin = false;
  const j = document.getElementById('chat-join'); if (j) j.classList.add('hidden');
}
// Auto-fill the Room field from a full room URL (ws://host:port/<room>) so the
// user only needs to paste the Hub URL. Only fills when Room is still empty.
function chatUrlAutoRoom() {
  const raw = document.getElementById('chat-url').value.trim();
  const roomIn = document.getElementById('chat-room');
  if (!roomIn || roomIn.value.trim()) return;
  const m = raw.match(/^wss?:\/\/[^/]+\/(.+)$/i);
  if (m) { try { roomIn.value = decodeURIComponent(m[1]); } catch { roomIn.value = m[1]; } }
}

function chatLeaveActive() { if (chat.activeKey) ask('chatLeave', { key: chat.activeKey }); }

function chatToggleHostForm() {
  const f = document.getElementById('chat-host-form');
  if (!f) return;
  const showing = f.classList.toggle('hidden') === false;
  if (showing) {
    const pw = document.getElementById('chat-hub-port-wrap');
    if (pw) pw.style.display = chat.hubRunning ? 'none' : '';   // port only matters before the hub is up
    const rin = document.getElementById('chat-hub-room'); if (rin && !rin.value) rin.value = 'general';
    const nin = document.getElementById('chat-hub-name'); if (nin && !nin.value) nin.value = 'Host';
    if (rin) rin.focus();
  }
}

function chatHostRoom() {
  const rv = document.getElementById('chat-hub-room');
  const nv = document.getElementById('chat-hub-name');
  const kv = document.getElementById('chat-hub-key');
  const pv = document.getElementById('chat-hub-port');
  const room = (rv && rv.value.trim()) || 'general';
  const user = (nv && nv.value.trim()) || 'Host';
  const key  = (kv && kv.value.trim()) || '';   // blank => extension generates one
  const port = pv ? (parseInt(pv.value.trim(), 10) || 0) : 0;   // blank/0 => auto
  ask('chatStartHub', { port, room, user, key });
  const f = document.getElementById('chat-host-form'); if (f) f.classList.add('hidden');
  if (rv) rv.value = '';
  if (kv) kv.value = '';
}

function chatGenKey() {
  const kv = document.getElementById('chat-hub-key');
  if (!kv) return;
  const a = new Uint8Array(9); (self.crypto || window.crypto).getRandomValues(a);
  kv.value = Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}

function chatSend() {
  const inp = document.getElementById('chat-input');
  const draft = inp.value;
  if (!draft.trim()) return;
  const text = draft.trim();
  const recipients = chatComposerRecipientNames(draft);
  const mode = chat.active?.selfHost ? chat.mode : undefined;
  if (mode === 'discuss') {
    const audienceSize = recipients.some(name => ['all','everyone'].includes(name.toLowerCase()))
      ? (chat.active?.members || []).filter(member => member.user !== chat.active.self).length
      : recipients.length;
    if (audienceSize < 1) {
      chatToast("Discuss requires at least one recipient.");
      return;
    }
  }
  const replyPolicy = mode === 'announce' ? 'none' : mode === 'discuss' ? 'required' : 'required';
  const discussionLead = mode === 'discuss' ? chatSelectedDiscussionLead() : '';
  ask('chatSend', { text, mode, replyPolicy, recipients, discussionLead, replyToMessageId: chat.quote?.id || '' });
  delete chat.drafts[chatDraftKey()];
  chatPreserveReadingLayout(() => {
    inp.value = ''; inp.style.height = 'auto';
    chat.manualRecipients = [];
    chat.bodyRecipients = [];
    chat.removedRecipients = [];
    chat.selectedRecipientIndex = -1;
    chatClearQuote();
    chatUpdateDefaultRecipient();
    chatHideMentionPop();
  });
}

function chatMessageById(messageId) {
  return (chat.active?.messages || []).find(message => message.id === messageId);
}
function chatQuoteMessage(messageId) {
  const message = chatMessageById(messageId);
  if (!message) return;
  chat.quote = { id: message.id, from: message.from, ts: message.ts, text: message.text };
  if (typeof chatCaptureDraft === 'function') chatCaptureDraft();
  chatPaintQuote();
  document.getElementById('chat-input')?.focus();
}
function chatPaintQuote() {
  const bar = document.getElementById('chat-quote-bar');
  if (!bar) return;
  const message = chat.quote;
  if (!message) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  const summary = String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const time = new Date(message.ts || Date.now()).toLocaleString();
  bar.innerHTML = `<button type="button" class="chat-quote-jump" title="Jump to the quoted message" onclick="chatJumpToMessage('${esc(message.id)}')"><b>${esc(message.from)}</b><span>${esc(time)} · ${esc(summary)} · ${esc(message.id)}</span></button><button type="button" class="chat-quote-close" title="Remove quoted message" onclick="chatClearQuote()">×</button>`;
  bar.classList.remove('hidden');
}
function chatClearQuote() {
  chat.quote = null;
  chatCaptureDraft();
  const bar = document.getElementById('chat-quote-bar');
  if (bar) { bar.classList.add('hidden'); bar.innerHTML = ''; }
}
function chatJumpToMessage(messageId) {
  const element = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!element) return;
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  element.classList.add('chat-message-focus');
  setTimeout(() => element.classList.remove('chat-message-focus'), 1800);
}
function chatOpenMessageViewer(messageId) {
  const message = chatMessageById(messageId);
  const viewer = document.getElementById('chat-message-viewer');
  const body = document.getElementById('chat-message-viewer-body');
  const title = document.getElementById('chat-message-viewer-title');
  if (!message || !viewer || !body || !title) return;
  chat.viewedMessage = message;
  title.textContent = `${message.from} · ${new Date(message.ts || Date.now()).toLocaleString()} · ${message.id}`;
  chatRenderMarkdown(body, message.text);
  viewer.classList.remove('hidden');
}
function chatCloseMessageViewer() {
  const viewer = document.getElementById('chat-message-viewer');
  if (viewer) { viewer.classList.add('hidden'); viewer.classList.remove('fullscreen'); }
  chat.viewedMessage = null;
}
function chatToggleViewerFullscreen() { document.getElementById('chat-message-viewer')?.classList.toggle('fullscreen'); }
async function chatCopyViewedMessage() {
  if (!chat.viewedMessage) return;
  try { await navigator.clipboard.writeText(chat.viewedMessage.text || ''); } catch { vscode.postMessage({ command: 'copyText', text: chat.viewedMessage.text || '' }); }
}
function chatMessageMenu(event, messageId) {
  event.preventDefault();
  event.stopPropagation();
  const message = chatMessageById(messageId);
  if (!message) return;
  showPaperMenu(event.clientX, event.clientY, [
    { label: 'Quote', onClick: () => chatQuoteMessage(messageId) },
    { label: 'Open in viewer', onClick: () => chatOpenMessageViewer(messageId) },
    { label: 'Copy text', onClick: () => {
      if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(message.text || '');
      else vscode.postMessage({ command: 'copyText', text: message.text || '' });
    } },
  ]);
}

function chatPaintMode() {
  document.querySelectorAll('#chat-mode-control button').forEach(button => button.classList.toggle('active', button.dataset.mode === chat.mode));
  chatPaintDiscussionLead();
}

function chatSelectedDiscussionLead() {
  const select = document.getElementById('chat-discussion-lead');
  return select?.value || chat.discussionLead || chat.active?.self || '';
}

function chatPaintDiscussionLead() {
  const wrap = document.getElementById('chat-discussion-lead-wrap');
  const select = document.getElementById('chat-discussion-lead');
  if (!wrap || !select) return;
  wrap.classList.toggle('hidden', chat.mode !== 'discuss');
  const members = (chat.active?.members || []).filter(member => member.present !== false);
  const preferred = chat.discussionLead || chat.active?.self || members.find(member => member.host)?.user || '';
  select.innerHTML = members.map(member => `<option value="${esc(member.user).replace(/"/g, '&quot;')}" ${member.user === preferred ? 'selected' : ''}>${esc(member.user)}</option>`).join('');
  chat.discussionLead = select.value || preferred;
}

function chatSetMode(mode) {
  if (!['announce', 'ask', 'discuss'].includes(mode)) return;
  chat.mode = mode;
  document.querySelectorAll('#chat-mode-control button').forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
  chatPaintDiscussionLead();
  if (typeof chatCaptureDraft === 'function') chatCaptureDraft();
  const notices = {
    announce: 'Switched to Announce mode: Recipients are notified, but no acknowledgement or reply is requested.',
    ask: 'Switched to Ask mode: Each selected recipient is asked to reply once.',
    discuss: 'Switched to Discuss mode: Selected recipients are invited into a shared peer discussion.',
  };
  const notice = document.getElementById('chat-mode-notice');
  if (!notice) return;
  notice.textContent = notices[mode];
  notice.classList.remove('hidden');
  if (chat.modeNoticeTimer) clearTimeout(chat.modeNoticeTimer);
  chat.modeNoticeTimer = setTimeout(() => {
    notice.classList.add('hidden');
    chat.modeNoticeTimer = null;
  }, 4500);
}

// ── @mentions ───────────────────────────────────────────────────────────────
// Candidates = "@all" plus every member except yourself. Members who have LEFT
// are still listed (marked "away") so you can @ them — they may rejoin.
function chatMentionCandidates(filter) {
  const f = (filter || '').toLowerCase();
  const self = (chat.active && chat.active.self) || '';
  const members = (chat.active && chat.active.members) || [];
  const list = chat.active?.selfHost ? [{ name: 'all', label: 'all', sub: 'notify everyone', icon: '📢' }] : [];
  const seen = new Set();
  // Present members first, then those who left.
  const ordered = members.slice().sort((a, b) => (a.present === false ? 1 : 0) - (b.present === false ? 1 : 0));
  ordered.filter(m => m.user !== self).forEach(m => {
    const key = m.user.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const away = m.present === false;
    const role = m.host ? 'host' : m.kind === 'agent' ? 'agent' : m.kind === 'browser' ? 'browser' : '';
    list.push({
      name: m.user, label: m.user,
      sub: away ? (role ? role + ' · away' : 'away') : role,
      icon: away ? '💤' : m.host ? '👑' : m.kind === 'agent' ? '🤖' : m.kind === 'browser' ? '🌐' : '👤',
    });
  });
  return list.filter(c => !f || c.name.toLowerCase().startsWith(f));
}

function chatShowMentionPop(filter, anchor) {
  const pop = document.getElementById('chat-mention-pop');
  if (!pop) return;
  const cands = chatMentionCandidates(filter);
  if (!cands.length) { chatHideMentionPop(); return; }
  chat.mentionAnchor = anchor || null;
  chat.mentionSel = 0;
  pop.innerHTML = cands.map((c, i) =>
    `<div class="chat-mrow${i === 0 ? ' sel' : ''}" data-name="${esc(c.name).replace(/"/g, '&quot;')}">` +
    `<span>${c.icon}</span><span>@${esc(c.label)}</span>` +
    `${c.sub ? `<span class="chat-mrow-sub">${esc(c.sub)}</span>` : ''}</div>`).join('');
  pop.querySelectorAll('.chat-mrow').forEach(r => r.addEventListener('click', () => chatPickMention(r.dataset.name)));
  pop.classList.remove('hidden');
}

function chatHideMentionPop() {
  const pop = document.getElementById('chat-mention-pop');
  if (pop) { pop.classList.add('hidden'); pop.innerHTML = ''; }
  chat.mentionAnchor = null; chat.mentionSel = -1;
}

let chatInputMeasure = null;
function chatResizeInput(input) {
  if (!chatInputMeasure) {
    chatInputMeasure = document.createElement('textarea');
    chatInputMeasure.setAttribute('aria-hidden', 'true');
    chatInputMeasure.rows = 1;
    chatInputMeasure.tabIndex = -1;
    Object.assign(chatInputMeasure.style, {
      position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden', pointerEvents: 'none',
      resize: 'none', overflow: 'hidden', height: '0', minHeight: '0', maxHeight: 'none', boxSizing: 'border-box',
    });
    document.body.appendChild(chatInputMeasure);
  }
  const style = getComputedStyle(input);
  for (const property of ['fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing', 'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']) {
    chatInputMeasure.style[property] = style[property];
  }
  chatInputMeasure.style.width = input.getBoundingClientRect().width + 'px';
  chatInputMeasure.value = input.value || ' ';
  const height = Math.min(chatInputMeasure.scrollHeight, 120);
  if (Math.abs(input.getBoundingClientRect().height - height) >= 1) {
    const log = document.getElementById('chat-log');
    const bottomGap = log ? Math.max(0, log.scrollHeight - log.scrollTop - log.clientHeight) : 0;
    input.style.height = height + 'px';
    if (log) log.scrollTop = Math.max(0, log.scrollHeight - log.clientHeight - bottomGap);
  }
}

function chatBodyInput() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  chatCaptureDraft();
  const mentioned = chatSyncBodyRecipients(input.value);
  chatResizeInput(input);
  chatSuggestOnInput();
  chatUpdateDefaultRecipient(mentioned);
}

function chatRecipientInputChanged() {
  const input = document.getElementById('chat-recipient-input');
  if (!input) return;
  chatCaptureDraft();
  const value = input.value;
  const match = /^@?(.*)$/.exec(value);
  chatShowMentionPop(match?.[1] || '', { recipientMode: true });
}

function chatSelectRecipient(index) {
  const chips = Array.from(document.querySelectorAll('#chat-recipient-chips .chat-recipient-chip'));
  chat.selectedRecipientIndex = chips.length ? Math.max(0, Math.min(chips.length - 1, index)) : -1;
  chips.forEach((chip, chipIndex) => chip.classList.toggle('selected', chipIndex === chat.selectedRecipientIndex));
}
function chatRecipientInputKeydown(event) {
  const input = event.currentTarget;
  const pop = document.getElementById('chat-mention-pop');
  const rows = pop && !pop.classList.contains('hidden') ? Array.from(pop.querySelectorAll('.chat-mrow')) : [];
  if (rows.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    chat.mentionSel = (((chat.mentionSel ?? -1) + (event.key === 'ArrowDown' ? 1 : -1)) + rows.length) % rows.length;
    rows.forEach((row, index) => row.classList.toggle('sel', index === chat.mentionSel));
    rows[chat.mentionSel].scrollIntoView({ block: 'nearest' });
    return;
  }
  if (rows.length && (event.key === 'Enter' || event.key === 'Tab')) {
    event.preventDefault();
    rows[chat.mentionSel >= 0 ? chat.mentionSel : 0]?.click();
    return;
  }
  const names = chatComposerRecipientNames(document.getElementById('chat-input')?.value || '');
  if (event.key === 'ArrowLeft' && !input.value) {
    event.preventDefault(); chatSelectRecipient(chat.selectedRecipientIndex < 0 ? names.length - 1 : chat.selectedRecipientIndex - 1); return;
  }
  if (event.key === 'ArrowRight' && chat.selectedRecipientIndex >= 0) {
    event.preventDefault();
    if (chat.selectedRecipientIndex >= names.length - 1) { chatSelectRecipient(-1); input.focus(); }
    else chatSelectRecipient(chat.selectedRecipientIndex + 1);
    return;
  }
  if ((event.key === 'Backspace' || event.key === 'Delete') && !input.value) {
    const index = chat.selectedRecipientIndex >= 0 ? chat.selectedRecipientIndex : names.length - 1;
    if (index >= 0) { event.preventDefault(); chatRemoveRecipient(names[index]); chatSelectRecipient(Math.min(index, names.length - 2)); }
    return;
  }
  if (event.key === 'Escape') { chatHideMentionPop(); input.value = ''; chatSelectRecipient(-1); }
}

// Typing "@word" anywhere opens the picker filtered by the partial under the caret.
function chatMentionOnInput() {
  const inp = document.getElementById('chat-input');
  if (!inp) return;
  const caret = inp.selectionStart;
  const upto = inp.value.slice(0, caret);
  const m = upto.match(/@([^@\s,.;:!?，。！？；：]*)$/);
  if (m) chatShowMentionPop(m[1], { start: caret - m[1].length - 1, end: caret });
  else chatHideMentionPop();
}

const CHAT_COMMANDS = [
  { cmd: '/stop', args: ' ', desc: 'Host: disconnect an online agent without removing its identity' },
  { cmd: '/leave', args: '', desc: 'Leave/close this Room; stored history is preserved' },
];

// One dispatcher for the composer: slash-command at line start, else @mention.
function chatSuggestOnInput() {
  const inp = document.getElementById('chat-input');
  if (!inp) return;
  const caret = inp.selectionStart;
  const upto = inp.value.slice(0, caret);
  const sc = upto.match(/^\/([a-z_]*)$/i);
  if (sc) { chatShowCommandPop(sc[1], { start: 0, end: caret }); return; }
  chatMentionOnInput();
}

function chatShowCommandPop(filter, anchor) {
  const pop = document.getElementById('chat-mention-pop');
  if (!pop) return;
  const f = (filter || '').toLowerCase();
  const items = CHAT_COMMANDS.filter(c => !f || c.cmd.slice(1).toLowerCase().startsWith(f));
  if (!items.length) { chatHideMentionPop(); return; }
  chat.mentionAnchor = anchor || null;
  chat.mentionSel = 0;
  pop.innerHTML = items.map((c, i) =>
    `<div class="chat-mrow${i === 0 ? ' sel' : ''}" data-cmd="${esc(c.cmd)}" data-args="${esc(c.args || '')}">` +
    `<span>⌘</span><span>${esc(c.cmd)}</span><span class="chat-mrow-sub">${esc(c.desc)}</span></div>`).join('');
  pop.querySelectorAll('.chat-mrow').forEach(r => r.addEventListener('click', () => chatPickCommand(r.dataset.cmd, r.dataset.args)));
  pop.classList.remove('hidden');
}

function chatPickCommand(cmd, args) {
  const inp = document.getElementById('chat-input');
  if (!inp) return;
  const a = chat.mentionAnchor;
  const start = a ? a.start : 0;
  const end = a ? a.end : inp.selectionStart;
  const insert = cmd + (args || '');
  inp.value = inp.value.slice(0, start) + insert + inp.value.slice(end);
  const pos = start + insert.length;
  inp.setSelectionRange(pos, pos);
  chatResizeInput(inp);
  chatHideMentionPop();
  inp.focus();
}

function chatPickMention(name) {
  if (chat.mentionAnchor?.recipientMode) {
    if (!chat.manualRecipients.some(item => item.toLowerCase() === name.toLowerCase())) chat.manualRecipients.push(name);
    chat.removedRecipients = chat.removedRecipients.filter(item => item.toLowerCase() !== name.toLowerCase());
    chatHideMentionPop();
    const recipientInput = document.getElementById('chat-recipient-input');
    if (recipientInput) recipientInput.value = '';
    chat.selectedRecipientIndex = -1;
    chatUpdateDefaultRecipient();
    document.getElementById('chat-input')?.focus();
    return;
  }
  const inp = document.getElementById('chat-input');
  if (!inp) return;
  const needQuotes = name !== 'all' && /[^A-Za-z0-9_\-]/.test(name);
  const token = (needQuotes ? `@"${name}"` : `@${name}`) + ' ';
  const a = chat.mentionAnchor;
  const start = a ? a.start : inp.selectionStart;
  const end = a ? a.end : inp.selectionEnd;
  const leading = start > 0 && !/\s/.test(inp.value[start - 1]) ? ' ' : '';
  inp.value = inp.value.slice(0, start) + leading + token + inp.value.slice(end);
  const pos = start + leading.length + token.length;
  inp.setSelectionRange(pos, pos);
  chatResizeInput(inp);
  chatHideMentionPop();
  chatBodyInput();
  inp.focus();
}

// Keydown on the composer: drive the popup if open, else send on Enter.
function chatInputKeydown(ev) {
  const pop = document.getElementById('chat-mention-pop');
  const open = pop && !pop.classList.contains('hidden');
  if (open) {
    const rows = Array.from(pop.querySelectorAll('.chat-mrow'));
    if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && rows.length) {
      ev.preventDefault();
      chat.mentionSel = (((chat.mentionSel ?? -1) + (ev.key === 'ArrowDown' ? 1 : -1)) + rows.length) % rows.length;
      rows.forEach((r, i) => r.classList.toggle('sel', i === chat.mentionSel));
      rows[chat.mentionSel].scrollIntoView({ block: 'nearest' });
      return;
    }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      const idx = (chat.mentionSel != null && chat.mentionSel >= 0) ? chat.mentionSel : 0;
      if (rows[idx]) { ev.preventDefault(); rows[idx].click(); return; }
    }
    if (ev.key === 'Escape') { ev.preventDefault(); chatHideMentionPop(); return; }
  }
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); chatSend(); }
}

// Parse @names out of a message (mirror of protocol.parse_mentions).
function chatMentionSearchText(text) {
  let fence = '';
  return String(text || '').split(/\r?\n/).map(line => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker; else if (fence === marker) fence = '';
      return '';
    }
    if (fence || /^\s*>/.test(line)) return '';
    let visible = '';
    for (let index = 0; index < line.length;) {
      if (line[index] !== '`') { visible += line[index++]; continue; }
      let end = index;
      while (end < line.length && line[end] === '`') end += 1;
      const marker = line.slice(index, end);
      const closing = line.indexOf(marker, end);
      if (closing < 0) { visible += ' '.repeat(line.length - index); break; }
      visible += ' '.repeat(closing + marker.length - index);
      index = closing + marker.length;
    }
    return visible;
  }).join('\n');
}
function chatParseMentions(text) {
  const re = /(?<![\p{L}\p{N}_@])@(?:"([^"]{1,60})"|([\p{L}\p{N}_][\p{L}\p{N}_\-]{0,59}))/gu;
  const out = []; let m;
  while ((m = re.exec(chatMentionSearchText(text)))) {
    const n = m[1] || m[2];
    if (n && !out.some(x => x.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out;
}
function chatParseRecipients(text) {
  const value = String(text || '').trimStart();
  if (!value || value.startsWith('/')) return [];
  const recipients = [];
  const re = /^@(?:"([^"]{1,60})"|([\p{L}\p{N}_][\p{L}\p{N}_-]{0,59}))(?:\s+|$)/u;
  let rest = value;
  while (true) {
    const match = re.exec(rest);
    if (!match) break;
    recipients.push(match[1] || match[2]);
    rest = rest.slice(match[0].length);
  }
  return recipients;
}
function chatValidRecipientMap() {
  const active = chat.active || {};
  const valid = new Map((active.members || []).map(member => [String(member.user || '').toLowerCase(), member.user]));
  if (active.selfHost) { valid.set('all', 'all'); valid.set('everyone', 'all'); }
  return valid;
}
function chatRecipientToken(name) {
  const value = String(name || '').trim() || 'all';
  return value === 'all' || /^[A-Za-z0-9_][\w-]{0,59}$/.test(value) ? `@${value}` : `@"${value.replace(/"/g, '')}"`;
}
function chatExplicitRecipientNames(text) {
  const valid = chatValidRecipientMap();
  const recipients = [];
  for (const name of chatParseRecipients(text)) {
    const resolved = valid.get(name.toLowerCase());
    if (resolved && !recipients.some(item => item.toLowerCase() === resolved.toLowerCase())) recipients.push(resolved);
  }
  return recipients;
}
function chatStructuredRecipientNames(text) {
  const valid = chatValidRecipientMap();
  const recipients = [];
  const source = chatMentionSearchText(text);
  const unquotedAliases = [...new Set([...valid.values()])].filter(name => !/\s/.test(name)).sort((a, b) => b.length - a.length);
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '@' || (index > 0 && /[\p{L}\p{N}_@]/u.test(source[index - 1]))) continue;
    let resolved = '';
    if (source[index + 1] === '"') {
      const close = source.indexOf('"', index + 2);
      if (close > index + 2) resolved = valid.get(source.slice(index + 2, close).toLowerCase()) || '';
    } else {
      resolved = unquotedAliases.find(name => source.slice(index + 1, index + 1 + name.length).toLowerCase() === name.toLowerCase()
        && (index + 1 + name.length === source.length || !/[\p{L}\p{N}_-]/u.test(source[index + 1 + name.length]))) || '';
    }
    if (resolved && !recipients.some(item => item.toLowerCase() === resolved.toLowerCase())) recipients.push(resolved);
  }
  return recipients;
}
function chatSyncBodyRecipients(text) {
  const current = chatStructuredRecipientNames(text);
  const previous = new Set(chat.bodyRecipients.map(name => name.toLowerCase()));
  const added = new Set(current.filter(name => !previous.has(name.toLowerCase())).map(name => name.toLowerCase()));
  if (added.size) chat.removedRecipients = chat.removedRecipients.filter(name => !added.has(name.toLowerCase()));
  chat.bodyRecipients = current;
  return current;
}
function chatDefaultRecipientNames() {
  const active = chat.active || {};
  const members = active.members || [];
  const messages = active.messages || [];
  const signature = `${chat.activeKey}|${active.selfHost ? 1 : 0}|${active.self || ''}|${members.map(member => `${member.user}:${member.present !== false ? 1 : 0}:${member.host ? 1 : 0}`).join('|')}|${messages.length}|${messages[messages.length - 1]?.id || ''}`;
  if (chat.defaultRecipientCache?.signature === signature) return chat.defaultRecipientCache.names.slice();
  let result = [];
  if (active.selfHost) {
    const valid = new Map(members.filter(member => member.present !== false && member.user !== active.self)
      .map(member => [member.user.toLowerCase(), member.user]));
    let previous;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message.system && message.from === active.self && ((message.recipients || []).length || chatParseRecipients(message.text).length)) { previous = message; break; }
    }
    if (previous) {
      const recipients = (previous.recipients || []).length ? previous.recipients : chatParseRecipients(previous.text);
      if (recipients.some(name => ['all', 'everyone'].includes(name.toLowerCase()))) result = ['all'];
      const carried = recipients.map(name => valid.get(name.toLowerCase())).filter(Boolean);
      if (!result.length && carried.length) result = [...new Set(carried)];
    }
    if (!result.length) result = ['all'];
  } else {
    const host = members.find(member => member.host && member.present !== false);
    result = host?.user ? [host.user] : [];
  }
  chat.defaultRecipientCache = { signature, names: result.slice() };
  return result;
}
function chatMaterializeRecipient(text) {
  return String(text || '').trim();
}
function chatComposerRecipientNames(text, explicit = chatStructuredRecipientNames(text)) {
  const inherited = chatDefaultRecipientNames();
  const effectiveInherited = explicit.length && inherited.some(name => ['all', 'everyone'].includes(name.toLowerCase())) ? [] : inherited;
  const selected = [...effectiveInherited, ...chat.manualRecipients, ...explicit];
  const removed = new Set(chat.removedRecipients.map(name => name.toLowerCase()));
  const unique = selected.filter(name => !removed.has(name.toLowerCase()))
    .filter((name, index, items) => items.findIndex(item => item.toLowerCase() === name.toLowerCase()) === index);
  return chatCollapseFullAudience(unique);
}
function chatCollapseFullAudience(names) {
  const active = chat.active || {};
  if (!active.selfHost) return names;
  if (names.some(name => ['all', 'everyone'].includes(name.toLowerCase()))) return ['all'];
  const audience = (active.members || []).filter(member => member.user !== active.self)
    .map(member => String(member.user || '').toLowerCase()).filter(Boolean);
  const selected = new Set(names.map(name => name.toLowerCase()));
  return audience.length && audience.every(name => selected.has(name)) ? ['all'] : names;
}
function chatRemoveRecipient(name) {
  chat.manualRecipients = chat.manualRecipients.filter(item => item.toLowerCase() !== String(name || '').toLowerCase());
  if (!chat.removedRecipients.some(item => item.toLowerCase() === String(name || '').toLowerCase())) chat.removedRecipients.push(String(name || ''));
  chatUpdateDefaultRecipient();
}
function chatUpdateDefaultRecipient(explicitMentions) {
  const input = document.getElementById('chat-input');
  const chips = document.getElementById('chat-recipient-chips');
  if (!input || !chips) return;
  const value = input.value.trimStart();
  const mentionedNames = explicitMentions || chatStructuredRecipientNames(value);
  const names = value.startsWith('/') ? [] : chatComposerRecipientNames(value, mentionedNames);
  const inherited = new Set(chatDefaultRecipientNames().map(name => name.toLowerCase()));
  const manual = new Set(chat.manualRecipients.map(name => name.toLowerCase()));
  const mentioned = new Set(mentionedNames.map(name => name.toLowerCase()));
  const html = names.map(name => {
    const sources = [inherited.has(name.toLowerCase()) ? 'inherited' : '', manual.has(name.toLowerCase()) ? 'manual' : '', mentioned.has(name.toLowerCase()) ? 'mentioned' : ''].filter(Boolean).join(', ');
    return `<span class="chat-recipient-chip" title="Recipient: ${esc(name)} · ${esc(sources)}">${esc(chatRecipientToken(name))}<button type="button" title="Remove ${esc(name)} from this message" onclick="chatRemoveRecipient(decodeURIComponent('${encodeURIComponent(name)}'))">×</button></span>`;
  }).join('');
  if (chips.innerHTML !== html) {
    chips.innerHTML = html;
    chatSelectRecipient(chat.selectedRecipientIndex);
  }
  document.getElementById('chat-recipient-row')?.classList.toggle('hidden', value.startsWith('/'));
}
function chatMentionsMe(text) {
  const me = (chat.active && chat.active.self) || '';
  if (!me) return false;
  const low = chatParseRecipients(text).map(s => s.toLowerCase());
  return low.includes(me.toLowerCase()) || low.includes('all') || low.includes('everyone');
}
function chatHighlightableMentionNames() {
  const names = new Set(['all', 'everyone']);
  const active = chat.active || {};
  [active.self, ...(active.members || []).map(member => member.user)].forEach(name => {
    const value = String(name || '').trim();
    if (value) names.add(esc(value).toLowerCase());
  });
  return names;
}
// Wrap @tokens in an already-HTML-escaped string for display.
function chatHighlightMentions(escaped) {
  const me = esc((chat.active && chat.active.self) || '').toLowerCase();
  const known = chatHighlightableMentionNames();
  return (escaped || '').replace(
    /(?<![\p{L}\p{N}_@])@(?:"[^"\n]{1,60}"|&quot;[\s\S]{1,120}?&quot;|all|everyone|[\p{L}\p{N}_][\p{L}\p{N}_\-]{0,59})/gu,
    m => {
      const name = m.slice(1).replace(/^"|"$/g, '').replace(/^&quot;|&quot;$/g, '').toLowerCase();
      if (!known.has(name)) return m;
      const targetMe = name === me || name === 'all' || name === 'everyone';
      return `<span class="chat-at ${targetMe ? 'chat-at-me' : 'chat-at-other'}">${m}</span>`;
    });
}

function chatSanitizeMarkdown(root) {
  const blocked = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'META', 'LINK']);
  root.querySelectorAll('*').forEach(element => {
    if (blocked.has(element.tagName)) { element.remove(); return; }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || ((name === 'href' || name === 'src') && /^(?:javascript|data):/.test(value))) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.tagName === 'A') {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

function chatHighlightMentionText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement;
    if (parent && !parent.closest('code,pre,a,.katex,.mermaid-diagram')) nodes.push(walker.currentNode);
  }
  nodes.forEach(node => {
    const html = chatHighlightMentions(esc(node.nodeValue || ''));
    if (html === esc(node.nodeValue || '')) return;
    const replacement = document.createElement('span');
    replacement.innerHTML = html;
    node.replaceWith(...replacement.childNodes);
  });
}

let chatMarkdownRenderer;
function chatSafeMarked(text) {
  if (typeof marked === 'undefined') return `<pre>${esc(text || '')}</pre>`;
  if (!chatMarkdownRenderer && marked.Renderer) {
    chatMarkdownRenderer = new marked.Renderer();
    chatMarkdownRenderer.html = token => esc(typeof token === 'string' ? token : token.text || token.raw || '');
  }
  return marked.parse(String(text || ''), chatMarkdownRenderer ? { renderer: chatMarkdownRenderer } : undefined);
}

function chatRenderMarkdown(root, text) {
  let html;
  try {
    html = chatSafeMarked(text);
  } catch {
    html = `<pre>${esc(text || '')}</pre>`;
  }
  root.innerHTML = html;
  chatSanitizeMarkdown(root);
  chatHighlightMentionText(root);
  root.querySelectorAll('pre code:not(.language-mermaid)').forEach(safeHljs);
  root.querySelectorAll('img').forEach(image => {
    if (!image.complete) image.addEventListener('load', () => chatScrollLatest(), { once: true });
  });
  return renderMermaid(root);
}

function chatAppend(m, refreshSearch = true) {
  const log = document.getElementById('chat-log');
  if (!log) return;
  // Protocol frames (agent-to-agent) never render as chat — they only drive the
  // per-member status marker. Hide the raw sentinel/JSON from the log.
  if (m && !m.system && chatIsProto(m.text)) { chatTrackProto(chatProtoDecode(m.text)); return; }
  // Idempotent by message id: a message (history backfill + live echo, or a
  // repaint racing an incremental append) never renders twice. System notices
  // get fresh random ids, so join/leave lines still show each time.
  if (m && m.id) {
    if (!chat.renderedIds) chat.renderedIds = new Set();
    if (chat.renderedIds.has(m.id)) return;
    chat.renderedIds.add(m.id);
  }
  const shouldFollow = chat.followLatest;
  const el = document.createElement('div');
  let renderDone = Promise.resolve();
  if (m.system) {
    el.className = 'chat-sys';
    el.textContent = m.text;
  } else {
    const mine = chat.active && m.from === chat.active.self;
    const atMe = !mine && chatMentionsMe(m.text);
    el.className = 'chat-msg' + (mine ? ' mine' : '') + (m.kind === 'agent' ? ' agent' : '') + (atMe ? ' mentions-me' : '');
    if (m.id) el.dataset.messageId = m.id;
    const t = new Date(m.ts || Date.now());
    const hh = String(t.getHours()).padStart(2,'0') + ':' + String(t.getMinutes()).padStart(2,'0');
    const receipt = mine && m.receipt ? `<span class="chat-read-receipt" data-message-id="${esc(m.id)}" title="Mentioned recipients who received this message">✓ ${m.receipt.read}/${m.receipt.total}</span>` : '';
    const quoted = m.replyToMessageId ? chatMessageById(m.replyToMessageId) : null;
    const quoteHeader = m.replyToMessageId ? `<button type="button" class="chat-reply-reference" title="Jump to quoted message ${esc(m.replyToMessageId)}" onclick="chatJumpToMessage('${esc(m.replyToMessageId)}')">Reply to ${esc(quoted?.from || 'message')} · ${esc(m.replyToMessageId)}</button>` : '';
    el.innerHTML = `<div class="chat-msg-hdr"><span class="chat-who">${m.kind === 'agent' ? '🤖 ' : ''}${esc(m.from)}</span><span class="chat-time">${hh}</span>${receipt}<span class="chat-msg-actions"><button type="button" title="Quote this message" onclick="chatQuoteMessage('${esc(m.id)}')">Quote</button><button type="button" title="Open this message in a larger resizable viewer" onclick="chatOpenMessageViewer('${esc(m.id)}')">Open</button></span></div>${quoteHeader}<div class="chat-msg-body prose"></div>`;
    renderDone = chatRenderMarkdown(el.querySelector('.chat-msg-body'), m.text);
    el.addEventListener('dblclick', event => { if (!event.target.closest('button,a')) chatOpenMessageViewer(m.id); });
    el.addEventListener('contextmenu', event => chatMessageMenu(event, m.id));
  }
  log.appendChild(el);
  while (log.children.length > 1000) {
    const oldest = log.firstElementChild;
    const messageId = oldest && oldest.dataset && oldest.dataset.messageId;
    if (messageId && chat.renderedIds) chat.renderedIds.delete(messageId);
    oldest?.remove();
  }
  if (shouldFollow) {
    chatScrollLatest(log);
    requestAnimationFrame(() => chatScrollLatest(log));
    void renderDone.finally(() => chatScrollLatest(log));
  } else {
    document.getElementById('chat-jump-latest')?.classList.remove('hidden');
  }
  if (refreshSearch && document.getElementById('chat-searchbox')?.value) chatRefreshSearch(true);
}

function chatUpdateReadReceipt(data) {
  if (!data || data.key !== chat.activeKey) return;
  const message = chat.active && (chat.active.messages || []).find(item => item.id === data.messageId);
  if (message) message.receipt = { read: data.read, total: data.total };
  let marker = Array.from(document.querySelectorAll('.chat-read-receipt')).find(el => el.dataset.messageId === data.messageId);
  if (!marker) {
    const rendered = Array.from(document.querySelectorAll('.chat-msg.mine')).find(el => el.dataset.messageId === data.messageId);
    const header = rendered && rendered.querySelector('.chat-msg-hdr');
    if (header) {
      marker = document.createElement('span');
      marker.className = 'chat-read-receipt';
      marker.dataset.messageId = data.messageId;
      marker.title = 'Mentioned recipients who received this message';
      header.appendChild(marker);
    }
  }
  if (marker) marker.textContent = `✓ ${data.read}/${data.total}`;
}

function chatRoomCard(room) {
  const attr = value => esc(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const actions = (room.actions || []).map(action => `<button slot="actions" type="button" class="chat-room-card-action${action.danger ? ' danger' : ''}" onclick="event.stopPropagation();${action.onclick}">${esc(action.label)}</button>`).join('');
  const open = room.onclick ? `onclick="${room.onclick}" role="button" tabindex="0" onkeydown="if(event.target===this&&(event.key==='Enter'||event.key===' ')){event.preventDefault();${room.onclick}}"` : 'tabindex="0"';
  return `<uone-disclosure-card class="chat-room-card" action-label="Room actions" ${room.selected ? 'selected' : ''} ${room.unavailable ? 'unavailable' : ''} ${open} title="${attr(room.title || room.meta || room.name)}">
    <span slot="leading" class="chat-dot ${esc(room.status || 'disconnected')}"></span><strong slot="title">${esc(room.name)}</strong><small slot="description">${esc(room.meta || '')}</small>${room.unread ? `<span slot="badge" class="chat-badge">${room.unread}</span>` : ''}${actions}
  </uone-disclosure-card>`;
}
function chatInactiveRoomCard(room) {
  const attr = value => esc(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const actions = (room.actions || []).map(action => `<button slot="actions" type="button" class="chat-room-card-action${action.danger ? ' danger' : ''}" onclick="event.stopPropagation();${action.onclick}">${esc(action.label)}</button>`).join('');
  return `<uone-disclosure-card class="chat-room-card chat-room-card-inactive" action-label="Room actions" ${room.unavailable ? 'unavailable' : ''} tabindex="0" title="${attr(room.title || room.meta || room.name)}">
    <button slot="primary-action" type="button" class="chat-inactive-resume" ${room.resume ? `onclick="event.stopPropagation();${room.resume.onclick}"` : 'disabled'} title="${esc(room.resume?.title || 'Unavailable')}" aria-label="${esc(room.resume?.title || 'Unavailable')}">▶</button><strong slot="title">${esc(room.name)}</strong><small slot="description">${esc(room.meta || '')}</small>${actions}
  </uone-disclosure-card>`;
}
function chatToggleInactive(group) {
  chatInactiveExpanded[group] = !chatInactiveExpanded[group];
  chatPaintRoomCards();
}
function chatRoomCardCollection(group, active, inactive) {
  let html = active.map(chatRoomCard).join('');
  if (inactive.length) {
    const expanded = !!chatInactiveExpanded[group];
    html += `<button type="button" class="chat-room-card-divider" aria-expanded="${expanded}" onclick="chatToggleInactive('${group}')"><span class="chat-room-card-divider-arrow">${expanded ? '▾' : '▸'}</span><span>Inactive · ${inactive.length}</span></button>`;
    if (expanded) html += `<div class="chat-room-inactive">${inactive.map(chatInactiveRoomCard).join('')}</div>`;
  }
  return html;
}
function chatPaintRoomCards() {
  const hostedBox = document.getElementById('chat-hosted-rooms');
  const joinedBox = document.getElementById('chat-joined-rooms');
  if (!hostedBox || !joinedBox) return;
  const connectionsByRoomId = new Map((chat.rooms || []).filter(room => room.roomId).map(room => [room.roomId, room]));
  const hostedActive = (chat.hubAdminRooms || []).map(room => {
    const connection = connectionsByRoomId.get(room.roomId);
    return { name:room.room, status:'connected', selected:connection?.key === chat.activeKey, unread:connection?.unread || 0, meta:`Active · ${room.members} member${room.members === 1 ? '' : 's'}`,
      onclick:connection ? `ask('chatSetActive',{key:'${esc(connection.key)}'})` : '', actions:[
        ...(connection ? [{label:'Open',onclick:`ask('chatSetActive',{key:'${esc(connection.key)}'})`}] : []),
        ...(room.hasKey ? [{label:'Magic Link',onclick:`ask('chatCopyInvite',{roomId:'${esc(room.roomId)}',roomName:'${esc(room.room)}'})`}] : []),
        {label:'Browser',onclick:`chatOpenRoomBrowser('${esc(room.room)}')`},
        ...(room.hasKey ? [{label:'Refresh Key',onclick:`ask('chatRotateSecret',{roomId:'${esc(room.roomId)}',roomName:'${esc(room.room)}'})`}] : []),
        {label:'Close',danger:true,onclick:`ask('chatAdminCloseRoom',{roomId:'${esc(room.roomId)}'})`},
      ] };
  });
  const hostedIds = new Set(hostedActive.map((_, index) => (chat.hubAdminRooms || [])[index]?.roomId));
  const stored = (chat.storedRooms || []).filter(room => !hostedIds.has(room.roomId)).sort((a,b) => Number(b.updatedAt||0)-Number(a.updatedAt||0));
  const hostedElsewhere = stored.filter(room => room.activeElsewhere).map(room => ({ name:room.roomName,status:'connected',meta:`Active elsewhere · ${Number(room.messageCount)||0} messages`,title:room.unavailableReason,unavailable:!room.canForceClose,actions:[
    ...(room.activeUrl ? [{label:'Browser',onclick:`chatOpenRoomBrowserAt('${esc(room.activeUrl)}','${esc(room.roomName)}')`}] : []),
    ...(room.canForceClose ? [{label:'Force Close',danger:true,onclick:`ask('chatForceCloseHostedRoom',{roomId:'${esc(room.roomId)}',roomName:'${esc(room.roomName)}'},this)`}] : []),
  ] }));
  const hostedInactive = stored.filter(room => !room.activeElsewhere).map(room => ({ name:room.roomName,status:'disconnected',meta:`${Number(room.messageCount)||0} messages · ${room.updatedAt ? chatAgo(room.updatedAt).replace(/^left /,'') : 'unknown'}`,title:room.unavailableReason,unavailable:!room.canRehost,
    resume:room.canRehost ? {title:'Rehost this Room',onclick:`ask('chatRehostStoredRoom',{roomId:'${esc(room.roomId)}'})`} : null, actions:[
    ...(room.canRehost ? [{label:'Rename',onclick:`ask('chatRenameStoredRoom',{roomId:'${esc(room.roomId)}',roomName:'${esc(room.roomName)}'})`},{label:'Delete',danger:true,onclick:`ask('chatDeleteStoredRoom',{roomId:'${esc(room.roomId)}',roomName:'${esc(room.roomName)}'})`}] : []),
  ] }));
  const activeHostedIds = new Set([...hostedIds, ...stored.filter(room => room.activeElsewhere).map(room => room.roomId)]);
  const joinedActive = (chat.rooms || []).filter(room => !room.selfHost && !activeHostedIds.has(room.roomId)).map(room => ({ name:room.room,status:room.status,selected:room.key===chat.activeKey,unread:room.unread,meta:`${room.status} · joined as ${room.user || ''}`,title:room.url,onclick:`ask('chatSetActive',{key:'${esc(room.key)}'})`,actions:[{label:'Open',onclick:`ask('chatSetActive',{key:'${esc(room.key)}'})`},{label:'Browser',onclick:`chatOpenRoomBrowserAt('${esc(room.url)}','${esc(room.room)}')`}]}));
  const joinedKeys = new Set((chat.rooms || []).map(room => room.key));
  const joinedBefore = (chat.recents || []).filter(room => !room.host && !joinedKeys.has(room.id)).sort((a,b)=>Number(b.lastJoined||0)-Number(a.lastJoined||0)).map(room => { let host='';try{host=new URL(room.url).host}catch{}return {name:room.room,status:'disconnected',meta:`${host ? '@'+host+' · ' : ''}${room.lastJoined ? chatAgo(room.lastJoined).replace(/^left /,'') : 'joined before'}`,title:`${room.url} · as ${room.user}`,resume:{title:`Rejoin as ${room.user}`,onclick:`ask('chatRejoin',{id:'${esc(room.id)}'})`},actions:[{label:'Browser',onclick:`chatOpenRoomBrowserAt('${esc(room.url)}','${esc(room.room)}')`},{label:'Forget',danger:true,onclick:`ask('chatForgetRoom',{id:'${esc(room.id)}'})`} ]};});
  hostedBox.innerHTML = chatRoomCardCollection('hosted', [...hostedActive, ...hostedElsewhere], hostedInactive) || '<div class="chat-empty">No hosted rooms yet.</div>';
  joinedBox.innerHTML = chatRoomCardCollection('joined', joinedActive, joinedBefore) || '<div class="chat-empty">No joined rooms yet.</div>';
  const hostedCount = document.getElementById('chat-hosted-count'); if (hostedCount) hostedCount.textContent = String(hostedActive.length + hostedElsewhere.length + hostedInactive.length);
  const joinedCount = document.getElementById('chat-joined-count'); if (joinedCount) joinedCount.textContent = String(joinedActive.length + joinedBefore.length);
}

function chatActiveRoomMenu(event, key, roomId, roomName) {
  event.preventDefault(); event.stopPropagation();
  showPaperMenu(event.clientX, event.clientY, [
    { label: roomName, header: true },
    copyPathMenu(`pkm://chatroom/rooms/${encodeURIComponent(roomId || roomName)}`),
    { sep: true },
    { label: 'Rename…', onClick: () => ask('chatRenameActiveRoom', { roomId, roomName }) },
    { sep: true },
    { label: 'Close Room', onClick: () => ask('chatLeave', { key }) },
  ]);
}

function chatStoredRoomMenu(event, roomId, roomName) {
  event.preventDefault(); event.stopPropagation();
  showPaperMenu(event.clientX, event.clientY, [
    { label: roomName, header: true },
    copyPathMenu(`pkm://chatroom/rooms/${encodeURIComponent(roomId || roomName)}`),
    { sep: true },
    { label: 'Rehost', onClick: () => ask('chatRehostStoredRoom', { roomId }) },
    { label: 'Repair Room', onClick: () => ask('chatRepairStoredRoom', { roomId }) },
    { label: 'Rename…', onClick: () => ask('chatRenameStoredRoom', { roomId, roomName }) },
    { sep: true },
    { label: 'Delete Data…', danger: true, onClick: () => ask('chatDeleteStoredRoom', { roomId, roomName }) },
  ]);
}

function chatActiveElsewhereRoomMenu(event, roomId, roomName) {
  event.preventDefault(); event.stopPropagation();
  showPaperMenu(event.clientX, event.clientY, [
    { label: roomName, header: true },
    copyPathMenu(`pkm://chatroom/rooms/${encodeURIComponent(roomId || roomName)}`),
    { sep: true },
    { label: 'Force Close Host…', danger: true, onClick: () => ask('chatForceCloseHostedRoom', { roomId, roomName }) },
  ]);
}

function chatPaintActive() {
  const emptyPane = document.getElementById('chat-empty-pane');
  const activeBox = document.getElementById('chat-active');
  if (!activeBox) return;
  const hasLiveRoom = !!chat.active && ['connecting','connected'].includes(String(chat.active.status || '').toLowerCase());
  if (!hasLiveRoom) { emptyPane.classList.remove('hidden'); activeBox.classList.add('hidden'); return; }
  emptyPane.classList.add('hidden'); activeBox.classList.remove('hidden');
  const a = chat.active;
  const connected = a.status === 'connected';
  document.getElementById('chat-status-dot').className = 'chat-dot ' + a.status;
  document.getElementById('chat-status-dot').title = connected ? 'Connected to this Room.' : `Room connection state: ${a.statusDetail || a.status}.`;
  document.getElementById('chat-pane-title').textContent = a.room + (a.statusDetail ? ' — ' + a.statusDetail : (connected ? '' : ' — ' + a.status));
  if (!document.getElementById('chat-meeting-summary')?.classList.contains('hidden')) chatPaintMeetingSummary();
  const inp = document.getElementById('chat-input'), sbtn = document.getElementById('chat-send-btn');
  const muted = !!a.selfMuted;
  const addAgent = document.getElementById('chat-add-agent-btn');
  const leave = document.getElementById('chat-leave-btn');
  const modeControl = document.getElementById('chat-mode-control');
  if (addAgent) addAgent.classList.toggle('hidden', !a.selfHost);
  if (leave) { leave.textContent = a.selfHost ? 'Close Room' : 'Leave Room'; leave.title = a.selfHost ? 'Close and store this Room; data remains available under Stored Rooms' : 'Leave this Room'; }
  if (modeControl) modeControl.classList.toggle('hidden', !a.selfHost);
  chatPaintDiscussionLead();
  if (inp)  { inp.disabled  = !connected || muted; inp.placeholder = muted ? 'You are muted by the host — you can read but not post.' : 'Message the room…  (Enter to send, Shift+Enter for newline)'; }
  if (sbtn) sbtn.disabled = !connected || muted;
  const recipientInput = document.getElementById('chat-recipient-input');
  if (recipientInput) recipientInput.disabled = !connected || muted;
  chatUpdateDefaultRecipient();
  // Repaint the full log from the snapshot (switching rooms).
  const log = document.getElementById('chat-log');
  if (log) {
    const messages = a.messages || [];
    const files = a.files || [];
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];
    const logSnapshotKey = `${chat.activeKey}|${messages.length}|${firstMessage?.id || firstMessage?.ts || ''}|${lastMessage?.id || lastMessage?.ts || ''}|${files.length}|${files[files.length - 1]?.fileId || ''}`;
    if (chat.logSnapshotKey === logSnapshotKey) {
      chatScrollLatest(log);
      document.getElementById('chat-jump-latest')?.classList.toggle('hidden', chat.followLatest);
      chatPaintMembers();
      return;
    }
    const restoreTop = chat.scrollPositions[chat.activeKey] ?? log.scrollTop;
    const shouldFollow = chat.followLatest;
    const restoreAnchor = !shouldFollow ? chat.scrollAnchors[chat.activeKey] || chatCaptureScrollAnchor(log) : null;
    log.innerHTML = '';
    chat.renderedIds = new Set();   // reset id-dedup tracking for a clean repaint
    chat.proto = {};                // rebuild protocol status from this room's frames
    (a.messages || []).forEach(message => chatAppend(message, false));
    Object.entries(a.agentStates || {}).forEach(([user, runtimeState]) => { chat.proto[user] = { state: runtimeState }; });
    (a.files || []).forEach(f => chatAppendFileRow(f.key || chat.activeKey, f));
    if (document.getElementById('chat-searchbox')?.value) chatRefreshSearch(true);
    if (shouldFollow) chatScrollLatest(log);
    else chatRestoreScrollAnchor(log, restoreAnchor, restoreTop);
    chat.logSnapshotKey = logSnapshotKey;
    chat.scrollPositions[chat.activeKey] = log.scrollTop;
    document.getElementById('chat-jump-latest')?.classList.toggle('hidden', shouldFollow);
  }
  chatPaintMembers();
}

function chatAppendFileRow(key, f) {
  const log = document.getElementById('chat-log');
  if (!log) return;
  const el = document.createElement('div');
  el.className = 'chat-file';
  el.innerHTML = `<span>✅ <b>${esc(f.name)}</b> from ${esc(f.from)} received</span>
    <button class="tbtn" onclick="ask('chatSaveFile',{key:'${esc(key)}',fileId:'${esc(f.fileId)}'})">Save…</button>`;
  const shouldFollow = chat.followLatest;
  log.appendChild(el);
  if (shouldFollow) {
    chatScrollLatest(log);
    requestAnimationFrame(() => chatScrollLatest(log));
  }
  else document.getElementById('chat-jump-latest')?.classList.remove('hidden');
}

function chatPaintMembers() {
  const box = document.getElementById('chat-members');
  if (!box) return;
  const members = (chat.active && chat.active.members) || [];
  const amHost = !!(chat.active && chat.active.selfHost);
  const managed = (chat.managedAgents || []).filter(agent => agent.roomKey === chat.activeKey);
  const managedNames = new Set(managed.map(agent => agent.name.toLowerCase()));
  const visibleMembers = amHost ? members.filter(member => !managedNames.has(member.user.toLowerCase())) : members;
  if (!visibleMembers.length && (!amHost || !managed.length)) { box.innerHTML = '<div class="chat-empty">No one yet.</div>'; return; }
  const here = visibleMembers.filter(m => m.present !== false);
  const gone = visibleMembers.filter(m => m.present === false);
  const attr = (s) => esc(s).replace(/"/g, '&quot;');
  const row = (m) => {
    const isHere = m.present !== false;
    const icon = m.host ? '👑' : m.kind === 'agent' ? '🤖' : m.kind === 'browser' ? '🌐' : '👤';
    const how  = m.host ? 'room host' : m.kind === 'agent' ? 'via MCP agent' : m.kind === 'browser' ? 'via browser' : 'via extension';
    const runtimeState = isHere && m.kind === 'agent' ? ((chat.proto && chat.proto[m.user] || {}).state || 'idle') : '';
    const dotK = isHere ? (m.host ? 'host' : m.kind) : 'gone';
    const sid  = m.sid ? `<span class="chat-sid" title="${m.verified === false ? 'best-effort id (browser — not verified)' : 'stable identity id'}">${esc(m.sid)}</span>` : '';
    const unv  = (m.verified === false) ? '<span class="chat-unverified" title="browser identity — best-effort, not verified">⚠️</span>' : '';
    const canManage = amHost && !m.host;
    const canModerate = canManage && isHere;
    // Non-host viewers see a small greyed muted indicator; the host toggles it below.
    const mut  = (m.muted && !canModerate) ? '<span class="chat-muted-badge" title="muted by the host — can\'t speak">🔇</span>' : '';
    const proto = isHere ? chatProtoBadge((chat.proto && chat.proto[m.user] || {}).state) : '';
    const tail = `<span class="chat-ago">${esc(isHere ? chatUpdatedAgo(m.stateChangedAt || m.lastSeen) : chatAgo(m.lastSeen))}</span>`;
    const role = m.role ? `<span class="chat-role">${esc(m.role)}</span>` : '';
    const runtimeComment = runtimeState === 'standby' ? 'Standby: actively waiting for a directed message.'
      : runtimeState === 'thinking' || runtimeState === 'working' ? 'Working: processing a delivered message.'
      : runtimeState === 'sending' ? 'Sending: posting a response to the Room.'
      : runtimeState === 'engaged' ? 'In session: participating in a coordinated exchange.'
      : runtimeState === 'reconnecting' ? 'Reconnecting: transport is being restored.'
      : runtimeState === 'idle' ? 'Idle: connected but not actively waiting.' : '';
    const identityComment = [
      `Full name: ${m.user}`,
      `Participant ID: ${m.participantId || 'not assigned'}`,
      `Connection ID: ${m.id || 'not available'}`,
      `Client identity ID: ${m.sid || 'not available'}`,
      `Type: ${how}`,
      `Presence: ${isHere ? 'present' : chatAgo(m.lastSeen)}`,
      runtimeComment,
      m.role ? `Role: ${m.role}` : '',
    ].filter(Boolean).join('\n');
    let actions = '';
    if (canManage) {
      // Icon reflects the CURRENT state: 🔊 = can speak (click to mute), 🔇 = muted (click to unmute).
      const tog = !isHere ? '' : m.muted
        ? `<button class="chat-mod" title="Muted — click to unmute" onclick="chatModerate('unmute',this)">🔇</button>`
        : `<button class="chat-mod" title="Can speak — click to mute" onclick="chatModerate('mute',this)">🔊</button>`;
      actions = `<span class="chat-mod-actions">${tog}`
        + `<button class="chat-mod" title="Edit name and role" onclick="chatModerate('edit',this)">✏️</button>`
        + `<button class="chat-mod chat-mod-kick" title="Permanently remove from this room and Earlier" onclick="chatModerate('kick',this)">🚫</button></span>`;
    }
    return `<div class="chat-member${isHere ? '' : ' gone'}${m.muted ? ' muted' : ''}" data-participant-id="${attr(m.participantId || '')}" data-sid="${attr(m.sid || '')}" data-user="${attr(m.user)}" data-role="${attr(m.role || '')}" title="${attr(identityComment)}"><span class="chat-mdot ${dotK}${runtimeState ? ' state-' + runtimeState : ''}" title="${attr(runtimeComment || (isHere ? 'Present in the Room.' : 'Not currently connected.'))}"></span><span class="chat-mname"><span class="chat-avatar">${icon}</span><span class="chat-member-name-text">${esc(m.user)}</span>${sid}${unv}${mut}${proto}${role}</span>${tail}${actions}</div>`;
  };
  let html = '<div class="chat-proto-legend"><span class="chat-proto standby" title="Standby: the Agent has an active blocking wait for directed messages."><span class="chat-legend-dot standby"></span>standby</span><span class="chat-proto working" title="Working: the Agent is processing a delivered message or task."><span class="chat-legend-dot working"></span>working</span><span class="chat-proto engaged" title="In session: the Agent is participating in a coordinated multi-step exchange."><span class="chat-legend-dot engaged"></span>in session</span></div>';
  if (amHost && managed.length) {
    html += '<div class="chat-side-sub">Managed agents</div>' + managed.map(agent => {
      const detail = String(agent.status || '');
      const runtimeState = agent.busy || detail.startsWith('queued') ? 'thinking' : agent.active ? 'standby' : 'idle';
      const stateLabel = detail.startsWith('error')
        ? `<span class="chat-proto idle" title="${attr(detail)}">error</span>`
        : chatProtoBadge(runtimeState);
      const role = agent.role ? `<span class="chat-role">${esc(agent.role)}</span>` : '';
      return `<div class="chat-member" title="${attr(agent.backend)}"><span class="chat-mdot agent state-${runtimeState}"></span><span class="chat-mname"><span class="chat-avatar">${esc(agent.icon || '🤖')}</span><span class="chat-member-name-text">${esc(agent.name)}</span>${stateLabel}${role}</span><span class="chat-mod-actions"><button class="chat-mod" title="Edit profile, name, and role" onclick="ask('chatEditManagedAgent',{id:'${attr(agent.id)}',name:'${attr(agent.name)}',role:'${attr(agent.role || '')}',icon:'${attr(agent.icon || '🤖')}'})">✏️</button><button class="chat-mod chat-mod-kick" title="Permanently remove managed agent" onclick="ask('chatRemoveManagedAgent',{id:'${attr(agent.id)}'})">🚫</button></span></div>`;
    }).join('');
  }
  html += here.map(row).join('');
  if (gone.length) html += `<div class="chat-side-sub">Earlier</div>` + gone.map(row).join('');
  box.innerHTML = html;
  chatEnsureControlComments(box);
}

function chatModerate(action, btn) {
  const rowEl = btn.closest('.chat-member');
  if (!rowEl) return;
  ask('chatModerate', { action, participantId: rowEl.dataset.participantId || '', sid: rowEl.dataset.sid || '', user: rowEl.dataset.user || '', role: rowEl.dataset.role || '' });
}
function chatRenameSelf() {
  ask('chatRenameSelf', { user: (chat.active && chat.active.user) || (chat.cfg && chat.cfg.displayName) || '' });
}

function chatAgo(ts) {
  if (!ts) return 'left';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'left ' + s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return 'left ' + m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return 'left ' + h + 'h ago';
  return 'left ' + Math.round(h / 24) + 'd ago';
}
function chatUpdatedAgo(ts) {
  if (!ts) return 'updated unknown';
  return chatAgo(ts).replace(/^left /, 'updated ');
}

function chatPaintHub() {
  const stopBtn = document.getElementById('chat-stophub-btn');
  const toggle = document.getElementById('chat-host-toggle');
  const portWrap = document.getElementById('chat-hub-port-wrap');
  if (stopBtn) stopBtn.classList.toggle('hidden', !chat.hubRunning);
  if (toggle)  toggle.textContent = chat.hubRunning ? '＋ Host another Room' : '＋ Host a Room';
  if (portWrap) portWrap.style.display = chat.hubRunning ? 'none' : '';
  const closeAll = document.getElementById('chat-admin-closeall');
  if (closeAll) closeAll.classList.toggle('hidden', !chat.hubRunning || !(chat.hubAdminRooms || []).length);
  chatPaintPendingJoins();
  chatPaintRoomCards();
}

function chatPaintPendingJoins() {
  const wrap = document.getElementById('chat-pending-wrap');
  const box = document.getElementById('chat-pending-joins');
  if (!wrap || !box) return;
  wrap.classList.add('hidden');
  box.innerHTML = '';
}

