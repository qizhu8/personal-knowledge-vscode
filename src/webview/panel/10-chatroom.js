// ── Chatroom (agent room) ───────────────────────────────────────────────────
const chat = {
  cfg: { hubUrl: '', room: 'general', displayName: 'user', hasSecret: false, hubPort: 7345 },
  rooms: [], storedRooms: [], activeKey: '', active: null, recents: [], hubAdminRooms: [], pendingApprovals: [], managedAgents: [],
  hubRunning: false, hubWsUrl: '', hubHttpUrl: '', hubPort: 0, hubError: '',
  secretShown: false, secretVal: '',
  rendered: false, showJoin: false,
  proto: {},   // user -> {state:'standby'|'working'|'engaged'}: live protocol status
};

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
    if (st === 'idle' || st === 'left') { delete chat.proto[who]; chatSetTurn(null); }
    else if (st) chat.proto[who] = { state: st };
    if (st === 'working') chatSetTurn('🤔 ' + who + ' is responding…');
    else if (meta.turn) chatSetTurn('🎯 It\'s ' + meta.turn + '\'s turn');
  } else if (t === 'end' || t === 'end_ack' || t === 'rst') {
    chat.proto = {};   // session over — everyone drops out of the protocol
    chatSetTurn(null);
  }
  chatPaintMembers();
}
// Plain-text magic messages also drive the markers (so the human host's
// /start_conversation lights everyone up immediately).
function chatTrackControl(text) {
  const s = (text || '').trim(), low = s.toLowerCase();
  let changed = false;
  if (low.startsWith('/start_conversation')) {
    chat.proto = {};
    chatSetTurn(null);
    changed = true;
  } else if (low.includes('conversation started') || low.includes('joined the conversation')) {
    chatParseMentions(s).forEach(name => {
      const member = (((chat.active && chat.active.members) || []).find(item => item.user.toLowerCase() === name.toLowerCase()));
      chat.proto[name] = { state: member && member.kind !== 'agent' ? 'engaged' : 'standby' };
    }); changed = true;
  } else if (low.startsWith('/stop_conversation')) {
    chat.proto = {}; changed = true; chatSetTurn(null);
  } else if (low.startsWith('/release')) {
    chatParseMentions(s).forEach(n => { delete chat.proto[n]; }); changed = true;
  }
  if (changed) chatPaintMembers();
}
// The background "whose turn" banner above the chat log.
function chatSetTurn(text) {
  const el = document.getElementById('chat-turn-banner');
  if (!el) return;
  if (text) { el.textContent = text; el.classList.remove('hidden'); }
  else { el.textContent = ''; el.classList.add('hidden'); }
}
function chatProtoBadge(state) {
  if (state === 'thinking' || state === 'working') return '<span class="chat-proto thinking" title="Received a message and is thinking"><span class="chat-thinking-dot">.</span><span class="chat-thinking-dot">.</span><span class="chat-thinking-dot">.</span></span>';
  if (state === 'sending') return '<span class="chat-proto engaged" title="Sending a response">sending</span>';
  if (state === 'reconnecting') return '<span class="chat-proto working" title="Connection lost — reconnecting">reconnecting</span>';
  if (state === 'engaged') return '<span class="chat-proto engaged" title="In session — coordinating">🔵 in session</span>';
  if (state === 'idle') return '<span class="chat-proto idle" title="Idle — stopped or released from standby">idle</span>';
  if (state === 'standby') return '<span class="chat-proto standby" title="Waiting for a directed @ message">standby</span>';
  return '';
}

function chatOnAgentState(data) {
  if (!data || data.key !== chat.activeKey || !data.user) return;
  chat.proto[data.user] = { state: data.state || 'idle' };
  if (data.state === 'thinking') chatSetTurn('🤔 ' + data.user + ' is thinking…');
  else if (data.state === 'sending') chatSetTurn('✉ ' + data.user + ' is sending…');
  else if (data.state === 'standby' || data.state === 'idle') chatSetTurn(null);
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
      <div class="chat-hub-box">
        <div class="chat-rail-hdr">Hub <span class="chat-muted" title="Host a hub so teammates can connect">(host)</span></div>
        <div id="chat-hub-info" class="chat-hint"></div>
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
        <div id="chat-admin" class="hidden">
          <div class="chat-rail-hdr">Rooms on my hub <span class="chat-muted">(admin)</span></div>
          <div id="chat-admin-rooms"></div>
          <div id="chat-pending-wrap" class="hidden">
            <div class="chat-rail-hdr">Pending joins</div>
            <div id="chat-pending-joins"></div>
          </div>
          <button class="tbtn chat-wide" id="chat-admin-closeall" onclick="ask('chatAdminCloseAll',{})" style="border-color:#f87171;color:#f87171">Close all rooms</button>
        </div>
      </div>
      <div class="chat-rail-hdr" style="margin-top:10px">Rooms</div>
      <div id="chat-rooms"></div>
      <div id="chat-stored-wrap" class="hidden">
        <div class="chat-rail-hdr" style="margin-top:8px">Stored Rooms</div>
        <div id="chat-stored-rooms"></div>
      </div>
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
      <div id="chat-recents-wrap" class="hidden">
        <div class="chat-rail-hdr">Recent</div>
        <div id="chat-recents"></div>
      </div>
    </div>
    <div id="chat-rail-resizer" title="Drag to resize"></div>
    <div id="chat-pane">
      <div id="chat-empty-pane" class="chat-empty-pane">Join a room to start or host one through Hub on the left.</div>
      <div id="chat-active" class="hidden">
        <div id="chat-pane-bar">
          <span id="chat-status-dot" class="chat-dot"></span>
          <span id="chat-pane-title"></span>
          <span style="flex:1"></span>
          <button class="tbtn hidden" id="chat-add-agent-btn" onclick="ask('chatAddManagedAgent',{})" title="Add an AI agent managed by this extension">＋ Agent</button>
          <button class="tbtn" onclick="chatRenameSelf()" title="Change your display name in this room">✏️ Rename me</button>
          <button class="tbtn" onclick="ask('chatShareFile',{})" title="Share a file with the room (peers must be online)">📎 Share</button>
          <button class="tbtn" onclick="ask('chatExport',{})" title="Download this room's transcript">⬇ Download</button>
          <button class="tbtn" id="chat-leave-btn" onclick="chatLeaveActive()" title="Leave this room">Leave</button>
        </div>
        <div id="chat-body">
          <div id="chat-main">
            <div id="chat-turn-banner" class="hidden"></div>
            <div id="chat-log"></div>
            <div id="chat-input-row">
              <button class="tbtn" id="chat-at-btn" onclick="chatToggleMentionMenu()" title="Mention someone (@all or a specific user)" disabled>@</button>
              <div id="chat-input-wrap">
                <div id="chat-mention-pop" class="hidden"></div>
                <span id="chat-default-recipient" title="Inferred recipient; sending will make @all explicit">@all</span>
                <textarea id="chat-input" rows="1" placeholder="Message the room…  (Enter to send, Shift+Enter for newline)" disabled></textarea>
              </div>
              <button class="tbtn" id="chat-send-btn" onclick="chatSend()" disabled>Send</button>
            </div>
          </div>
          <div id="chat-side-resizer" title="Drag to resize members"></div>
          <div id="chat-side">
            <div class="chat-side-hdr">In the room</div>
            <div id="chat-members"><div class="chat-empty">—</div></div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
  document.getElementById('chat-url').value  = chat.cfg.hubUrl || chat.hubWsUrl || '';
  document.getElementById('chat-room').value = chat.cfg.room || 'general';
  document.getElementById('chat-name').value = chat.cfg.displayName || 'user';
  const inp = document.getElementById('chat-input');
  inp.addEventListener('keydown', chatInputKeydown);
  inp.addEventListener('input', () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 120) + 'px'; chatSuggestOnInput(); });
  document.addEventListener('click', ev => {
    const pop = document.getElementById('chat-mention-pop');
    if (pop && !pop.classList.contains('hidden') && !pop.contains(ev.target) && ev.target.id !== 'chat-at-btn') chatHideMentionPop();
  });
  chat.secretShown = false; chat.secretVal = '';
  chatPaintRooms();
  chatPaintStoredRooms();
  chatPaintActive();
  chatPaintHub();
  chatPaintRecents();
  chatInitResizer();
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
  initColumnResizer('chat-side-resizer', 'chat-side', 'pk-chat-side', 120, 500, -1, false);
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
}

function chatOnState(s) {
  if (!s) return;
  chat.rooms = s.rooms || [];
  chat.storedRooms = s.storedRooms || [];
  chat.activeKey = s.activeKey || '';
  chat.active = s.active || null;
  chat.hubRunning = !!s.hubRunning;
  chat.hubWsUrl = s.hubUrl ?? chat.hubWsUrl;
  chat.hubHttpUrl = s.hubHttpUrl ?? chat.hubHttpUrl;
  chat.hubPort = s.hubPort ?? chat.hubPort;
  chat.hubAdminRooms = s.hubAdminRooms || [];
  chat.pendingApprovals = s.pendingApprovals || [];
  chat.managedAgents = s.managedAgents || [];
  if (chat.hubRunning) chat.hubError = '';   // running truth clears any stale error
  if (state.tab !== 'chatroom') return;
  chatPaintRooms();
  chatPaintStoredRooms();
  chatPaintActive();
  chatPaintHub();
  chatPaintRecents();
}

function chatOnRecents(d) {
  chat.recents = (d && d.recents) || [];
  if (state.tab === 'chatroom') chatPaintRecents();
}

function chatOnMessage(d) {
  if (state.tab !== 'chatroom' || !d || d.key !== chat.activeKey) return;
  chatAppend(d.message);
}

function chatOnFileReady(d) {
  if (state.tab !== 'chatroom' || !d || d.key !== chat.activeKey) return;
  chatAppendFileRow(d.key, d);
  const log = document.getElementById('chat-log');
  if (log) log.scrollTop = log.scrollHeight;
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
    const u = document.getElementById('chat-url');
    if (u && !u.value) u.value = res.wsUrl || '';
  } else {
    chat.hubError = res.error || 'unknown — run “Personal Knowledge Manager: Show Logs” for details';
  }
  chatPaintHub();
}

function chatOpenBrowser() {
  if (!chat.hubHttpUrl) return;
  const room = chatPrimaryHubRoom();
  if (!room) return;
  ask('openExternal', { url: chat.hubHttpUrl + '/room/' + encodeURIComponent(room) });
}

// The room a hub-level shortcut should act on: prefer the room open in the pane
// if it's on my hub, otherwise the first room hosted on my hub. Never guesses
// from the (often-empty) host-form input, which caused the wrong room to open.
function chatPrimaryHubRoom() {
  const rooms = chat.hubAdminRooms || [];
  if (!rooms.length) return '';
  const canon = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const act = chat.active && chat.active.room;
  if (act) { const hit = rooms.find(r => canon(r.room) === canon(act)); if (hit) return hit.room; }
  return rooms[0].room;
}

function chatCopyPrimaryLink() {
  const room = chatPrimaryHubRoom();
  if (room) ask('chatCopyInvite', { room });
}

function chatOpenRoomBrowser(room) {
  if (chat.hubHttpUrl) ask('openExternal', { url: chat.hubHttpUrl + '/room/' + encodeURIComponent(room) });
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
  const text = chatMaterializeRecipient(draft);
  ask('chatSend', { text });
  inp.value = ''; inp.style.height = 'auto';
  chatUpdateDefaultRecipient();
  chatHideMentionPop();
  chatOnLocalSend(text);
}

// After I send a normal message in an active conversation, hand the turn to the
// engaged party (so the banner flips immediately, not only when they reply).
function chatOnLocalSend(text) {
  if ((text || '').trim().startsWith('/')) return;   // commands drive the banner elsewhere
  const self = (chat.active && chat.active.self) || '';
  const engaged = Object.keys(chat.proto || {}).filter(n => n !== self);
  if (!engaged.length) return;
  const who = engaged.length === 1 ? engaged[0] : 'the others';
  chatSetTurn('🤔 ' + who + ' is responding…');
}

// ── @mentions ───────────────────────────────────────────────────────────────
// Candidates = "@all" plus every member except yourself. Members who have LEFT
// are still listed (marked "away") so you can @ them — they may rejoin.
function chatMentionCandidates(filter) {
  const f = (filter || '').toLowerCase();
  const self = (chat.active && chat.active.self) || '';
  const members = (chat.active && chat.active.members) || [];
  const list = [{ name: 'all', label: 'all', sub: 'notify everyone', icon: '📢' }];
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

// The "@" button: open a picker at the caret (insert, don't replace).
function chatToggleMentionMenu() {
  const pop = document.getElementById('chat-mention-pop');
  if (pop && !pop.classList.contains('hidden')) { chatHideMentionPop(); return; }
  const inp = document.getElementById('chat-input');
  if (inp && !inp.disabled) inp.focus();
  chatShowMentionPop('', { start: 0, end: 0 });
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

// Magic conversation-control messages, offered via slash-command autocomplete.
const CHAT_COMMANDS = [
  { cmd: '/start_conversation', args: ' ', desc: 'Start free talk with @agents or @all' },
  { cmd: '/start', args: '', desc: 'Initiator: begin the prepared discussion' },
  { cmd: '/stop_conversation', args: '', desc: 'Host: stop and release all standby agents' },
  { cmd: '/release', args: ' ', desc: 'Drop one party from the conversation' },
  { cmd: '/request_join', args: ' ', desc: 'Invite an online member into the discussion' },
  { cmd: '/leave', args: '', desc: 'Leave/close this Room; stored history is preserved' },
];

// One dispatcher for the composer: slash-command at line start, else @mention.
function chatSuggestOnInput() {
  const inp = document.getElementById('chat-input');
  if (!inp) return;
  const caret = inp.selectionStart;
  const upto = inp.value.slice(0, caret);
  chatUpdateDefaultRecipient();
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
  inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
  chatHideMentionPop();
  inp.focus();
}

function chatPickMention(name) {
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
  inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
  chatHideMentionPop();
  chatUpdateDefaultRecipient();
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
function chatParseMentions(text) {
  const re = /(?<![\p{L}\p{N}_@])@(?:"([^"]{1,60})"|([\p{L}\p{N}_][\p{L}\p{N}_\-]{0,59}))/gu;
  const out = []; let m;
  while ((m = re.exec(text || ''))) {
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
function chatMaterializeRecipient(text) {
  const value = String(text || '').trim();
  if (!value || value.startsWith('/') || chatParseRecipients(value).length) return value;
  return '@all ' + value;
}
function chatUpdateDefaultRecipient() {
  const input = document.getElementById('chat-input');
  const inferred = document.getElementById('chat-default-recipient');
  if (!input || !inferred) return;
  const value = input.value.trimStart();
  inferred.classList.toggle('hidden', value.startsWith('/') || chatParseRecipients(value).length > 0);
}
function chatMentionsMe(text) {
  const me = (chat.active && chat.active.self) || '';
  if (!me) return false;
  const low = chatParseRecipients(text).map(s => s.toLowerCase());
  return low.includes(me.toLowerCase()) || low.includes('all') || low.includes('everyone');
}
// Wrap @tokens in an already-HTML-escaped string for display.
function chatHighlightMentions(escaped) {
  const me = ((chat.active && chat.active.self) || '').toLowerCase();
  return (escaped || '').replace(
    /(?<![\p{L}\p{N}_@])@(?:&quot;[\s\S]{1,120}?&quot;|all|everyone|[\p{L}\p{N}_][\p{L}\p{N}_\-]{0,59})/gu,
    m => {
      const name = m.slice(1).replace(/^&quot;|&quot;$/g, '').toLowerCase();
      const targetMe = name === me || name === 'all' || name === 'everyone';
      return `<span class="chat-at ${targetMe ? 'chat-at-me' : 'chat-at-other'}">${m}</span>`;
    });
}

function chatAppend(m) {
  const log = document.getElementById('chat-log');
  if (!log) return;
  // Protocol frames (agent-to-agent) never render as chat — they only drive the
  // per-member status marker. Hide the raw sentinel/JSON from the log.
  if (m && !m.system && chatIsProto(m.text)) { chatTrackProto(chatProtoDecode(m.text)); return; }
  if (m && !m.system && m.text) chatTrackControl(m.text);
  // Idempotent by message id: a message (history backfill + live echo, or a
  // repaint racing an incremental append) never renders twice. System notices
  // get fresh random ids, so join/leave lines still show each time.
  if (m && m.id) {
    if (!chat.renderedIds) chat.renderedIds = new Set();
    if (chat.renderedIds.has(m.id)) return;
    chat.renderedIds.add(m.id);
  }
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const el = document.createElement('div');
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
    el.innerHTML = `<div class="chat-msg-hdr"><span class="chat-who">${m.kind === 'agent' ? '🤖 ' : ''}${esc(m.from)}</span><span class="chat-time">${hh}</span>${receipt}</div><div class="chat-msg-body">${chatHighlightMentions(esc(m.text))}</div>`;
  }
  log.appendChild(el);
  if (atBottom) log.scrollTop = log.scrollHeight;
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

function chatPaintRooms() {
  const box = document.getElementById('chat-rooms');
  if (!box) return;
  if (!chat.rooms.length) { box.innerHTML = '<div class="chat-empty">No rooms joined.</div>'; return; }
  box.innerHTML = chat.rooms.map(r => {
    const active = r.key === chat.activeKey;
    const badge = r.unread ? `<span class="chat-badge">${r.unread}</span>` : '';
    return `<div class="chat-room-item${active ? ' active' : ''}" onclick="ask('chatSetActive',{key:'${esc(r.key)}'})">
      <span class="chat-dot ${esc(r.status)}"></span>
      <span class="chat-room-name" title="${esc(r.url)}">${esc(r.room)}</span>${badge}</div>`;
  }).join('');
}

function chatPaintStoredRooms() {
  const wrap = document.getElementById('chat-stored-wrap');
  const box = document.getElementById('chat-stored-rooms');
  if (!wrap || !box) return;
  const rooms = chat.storedRooms || [];
  wrap.classList.toggle('hidden', !rooms.length);
  if (!rooms.length) { box.innerHTML = ''; return; }
  box.innerHTML = rooms.map(room => {
    const available = room.canRehost !== false;
    const count = Number(room.messageCount) || 0;
    const activity = room.updatedAt ? chatAgo(room.updatedAt).replace(/^left /, '') : 'unknown';
    const meta = `${count} message${count === 1 ? '' : 's'} · ${activity}`;
    const reason = room.unavailableReason || 'This Room cannot be Rehosted.';
    return `<div class="chat-stored-item${available ? '' : ' unavailable'}" title="${available ? 'Stored locally · Rehost this Room' : esc(reason)}">
      <button class="chat-stored-open" title="${available ? 'Rehost Room' : esc(reason)}" ${available ? `onclick="ask('chatRehostStoredRoom',{roomId:'${esc(room.roomId)}'})"` : 'disabled'}>▶</button>
      <span class="chat-stored-copy"><span class="chat-stored-name">${esc(room.roomName)}</span><span class="chat-stored-meta">${esc(meta)}</span></span>
      <span class="chat-stored-actions">
        ${available ? `<button class="chat-stored-icon" title="Rename Stored Room" onclick="ask('chatRenameStoredRoom',{roomId:'${esc(room.roomId)}',roomName:'${esc(room.roomName)}'})">✏</button>` : '<span class="chat-stored-warning" aria-label="Unavailable">!</span>'}
        ${available ? `<button class="chat-stored-icon danger" title="Delete Room Data permanently" onclick="ask('chatDeleteStoredRoom',{roomId:'${esc(room.roomId)}',roomName:'${esc(room.roomName)}'})">🗑</button>` : ''}
      </span>
    </div>`;
  }).join('');
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
  document.getElementById('chat-pane-title').textContent = a.room + (a.statusDetail ? ' — ' + a.statusDetail : (connected ? '' : ' — ' + a.status));
  const inp = document.getElementById('chat-input'), sbtn = document.getElementById('chat-send-btn');
  const atbtn = document.getElementById('chat-at-btn');
  const muted = !!a.selfMuted;
  const addAgent = document.getElementById('chat-add-agent-btn');
  if (addAgent) addAgent.classList.toggle('hidden', !a.selfHost);
  if (inp)  { inp.disabled  = !connected || muted; inp.placeholder = muted ? 'You are muted by the host — you can read but not post.' : 'Message the room…  (Enter to send, Shift+Enter for newline)'; }
  if (sbtn) sbtn.disabled = !connected || muted;
  if (atbtn) atbtn.disabled = !connected || muted;
  // Repaint the full log from the snapshot (switching rooms).
  const log = document.getElementById('chat-log');
  if (log) {
    log.innerHTML = '';
    chat.renderedIds = new Set();   // reset id-dedup tracking for a clean repaint
    chat.proto = {};                // rebuild protocol status from this room's frames
    chatSetTurn(null);
    (a.messages || []).forEach(chatAppend);
    Object.entries(a.agentStates || {}).forEach(([user, runtimeState]) => { chat.proto[user] = { state: runtimeState }; });
    (a.files || []).forEach(f => chatAppendFileRow(f.key || chat.activeKey, f));
    log.scrollTop = log.scrollHeight;
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
  log.appendChild(el);
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
    const tail = isHere ? '' : `<span class="chat-ago">${esc(chatAgo(m.lastSeen))}</span>`;
    const role = m.role ? `<span class="chat-role">${esc(m.role)}</span>` : '';
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
    return `<div class="chat-member${isHere ? '' : ' gone'}${m.muted ? ' muted' : ''}" data-sid="${attr(m.sid || '')}" data-user="${attr(m.user)}" data-role="${attr(m.role || '')}" title="${esc(how)}"><span class="chat-mdot ${dotK}${runtimeState ? ' state-' + runtimeState : ''}"></span><span class="chat-mname">${icon} ${esc(m.user)}${sid}${unv}${mut}${proto}${role}</span>${tail}${actions}</div>`;
  };
  let html = amHost ? '<div class="chat-host-hint">You host this room — use each member\'s buttons to mute, rename ✏️, or remove 🚫.</div>' : '';
  if (chat.proto && Object.keys(chat.proto).length) {
    html += '<div class="chat-proto-legend"><span class="chat-proto standby">🟢 standby</span><span class="chat-proto working">⚙️ working</span><span class="chat-proto engaged">🔵 in session</span></div>';
  }
  if (amHost && managed.length) {
    html += '<div class="chat-side-sub">Managed agents</div>' + managed.map(agent => {
      const stateLabel = agent.busy ? '⚙️ working' : agent.active ? '🟢 standby' : '⚪ idle';
      const role = agent.role ? `<span class="chat-role">${esc(agent.role)}</span>` : '';
      return `<div class="chat-member" title="${attr(agent.backend)}"><span class="chat-mdot agent"></span><span class="chat-mname">🤖 ${esc(agent.name)}<span class="chat-sid">${stateLabel}</span>${role}</span><span class="chat-mod-actions"><button class="chat-mod" title="Edit name and role" onclick="ask('chatEditManagedAgent',{id:'${attr(agent.id)}',name:'${attr(agent.name)}',role:'${attr(agent.role || '')}'})">✏️</button><button class="chat-mod chat-mod-kick" title="Permanently remove managed agent" onclick="ask('chatRemoveManagedAgent',{id:'${attr(agent.id)}'})">🚫</button></span></div>`;
    }).join('');
  }
  html += here.map(row).join('');
  if (gone.length) html += `<div class="chat-side-sub">Earlier</div>` + gone.map(row).join('');
  box.innerHTML = html;
}

function chatModerate(action, btn) {
  const rowEl = btn.closest('.chat-member');
  if (!rowEl) return;
  ask('chatModerate', { action, sid: rowEl.dataset.sid || '', user: rowEl.dataset.user || '', role: rowEl.dataset.role || '' });
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

function chatPaintHub() {
  const info = document.getElementById('chat-hub-info');
  const stopBtn = document.getElementById('chat-stophub-btn');
  const toggle = document.getElementById('chat-host-toggle');
  const portWrap = document.getElementById('chat-hub-port-wrap');
  if (info) {
    if (chat.hubRunning) {
      const pr = chatPrimaryHubRoom();
      const links = pr
        ? ` · <span class="chat-muted" title="This shortcut targets room &quot;${esc(pr)}&quot;">${esc(pr)}</span> `
          + `<a href="#" title="Copy one-paste MCP Magic Link invite" onclick="chatCopyPrimaryLink();return false;">📋 Invite</a> `
          + `<a href="#" title="Open this room in a browser" onclick="chatOpenBrowser();return false;">Join via browser</a>`
        : '';
      info.innerHTML = `● Hosting on <code>${esc(chat.hubWsUrl)}</code>${links}`;
    } else if (chat.hubError) {
      info.innerHTML = `<span style="color:#f87171">Hub failed: ${esc(chat.hubError)}</span>`;
    } else {
      info.innerHTML = '<span class="chat-muted">Not hosting.</span>';
    }
  }
  if (stopBtn) stopBtn.classList.toggle('hidden', !chat.hubRunning);
  if (toggle)  toggle.textContent = chat.hubRunning ? '＋ Host another Room' : '＋ Host a Room';
  if (portWrap) portWrap.style.display = chat.hubRunning ? 'none' : '';
  // Admin: rooms currently on my hub.
  const admin = document.getElementById('chat-admin');
  const list = document.getElementById('chat-admin-rooms');
  if (!admin || !list) return;
  admin.classList.toggle('hidden', !chat.hubRunning);
  if (!chat.hubRunning) return;
  if (!chat.hubAdminRooms.length) { list.innerHTML = '<div class="chat-empty">No active rooms.</div>'; return; }
  list.innerHTML = chat.hubAdminRooms.map(r =>
    `<div class="chat-admin-item" title="host: ${esc(r.owner)} · ${r.members} member(s)">
       <div class="chat-admin-name">${esc(r.room)} <span class="chat-muted">(${r.members})</span></div>
       <div class="chat-admin-btns">
         ${r.hasKey ? `<span class="chat-secret-btn" title="Copy one-paste MCP Magic Link invite" onclick="ask('chatCopyInvite',{room:'${esc(r.room)}'})">📋</span>` : ''}
         <span class="chat-secret-btn" title="Open browser view for this room" onclick="chatOpenRoomBrowser('${esc(r.room)}')">🌐</span>
         ${r.hasKey ? `<span class="chat-secret-btn" title="Refresh key and copy the new Magic Link invite" onclick="ask('chatRotateSecret',{room:'${esc(r.room)}'})">🔄</span>` : ''}
         <span class="chat-recent-x" title="Deactivate this room" onclick="ask('chatAdminCloseRoom',{room:'${esc(r.room)}'})">✕</span>
       </div>
     </div>`
  ).join('');
  chatPaintPendingJoins();
}

function chatPaintPendingJoins() {
  const wrap = document.getElementById('chat-pending-wrap');
  const box = document.getElementById('chat-pending-joins');
  if (!wrap || !box) return;
  const pending = chat.pendingApprovals || [];
  wrap.classList.toggle('hidden', !pending.length);
  if (!pending.length) { box.innerHTML = ''; return; }
  box.innerHTML = pending.map(item => {
    const seconds = Math.max(0, Math.ceil((Number(item.expiresAt) - Date.now()) / 1000));
    const reusable = (item.reusableParticipants || []).length;
    return `<div class="chat-pending-item">
      <div class="chat-pending-head"><span class="chat-pending-alias">${esc(item.alias)}</span><span class="chat-recent-badge guest">${esc(item.kind)}</span></div>
      <div class="chat-stored-meta">${seconds}s remaining</div>
      <div class="chat-pending-actions">
        <button class="tbtn" onclick="ask('chatApproveJoinNew',{requestId:'${esc(item.requestId)}'})">New user</button>
        <button class="tbtn" ${reusable ? `onclick="ask('chatApproveJoinReuse',{requestId:'${esc(item.requestId)}'})"` : 'disabled'} title="${reusable ? `${reusable} offline identity option(s)` : 'No offline identity available'}">Reuse</button>
        <button class="tbtn chat-pending-reject" onclick="ask('chatRejectJoin',{requestId:'${esc(item.requestId)}'})">Reject</button>
      </div>
    </div>`;
  }).join('');
}

function chatPaintRecents() {
  const wrap = document.getElementById('chat-recents-wrap');
  const box = document.getElementById('chat-recents');
  if (!wrap || !box) return;
  const joinedKeys = new Set(chat.rooms.map(r => r.key));
  const items = (chat.recents || []).filter(r => !joinedKeys.has(r.id));
  wrap.classList.toggle('hidden', !items.length);
  const rowHtml = (r) => {
    let hostAddr = '';
    try { hostAddr = new URL(r.url).host; } catch (e) { hostAddr = r.url || ''; }
    // In the "Joined before" group, show the hub address so same-named rooms on
    // different hubs stay distinguishable. The "Hosted by me" header needs no tag.
    const tag = r.host ? '' : (hostAddr ? `<span class="chat-recent-badge guest" title="Hosted by ${esc(r.url)}">@${esc(hostAddr)}</span>` : '');
    return `<div class="chat-recent-item" title="${esc(r.url)} · as ${esc(r.user)}">
       <span class="chat-recent-name" onclick="ask('chatRejoin',{id:'${esc(r.id)}'})">${tag}${esc(r.room)}</span>
       <span class="chat-recent-x" title="Forget this room" onclick="ask('chatForgetRoom',{id:'${esc(r.id)}'})">✕</span>
     </div>`;
  };
  const mine   = items.filter(r => r.host);
  const others = items.filter(r => !r.host);
  let html = '';
  if (mine.length)   html += '<div class="chat-side-sub">Hosted by me</div>' + mine.map(rowHtml).join('');
  if (others.length) html += '<div class="chat-side-sub">Joined before</div>' + others.map(rowHtml).join('');
  box.innerHTML = html;
}

