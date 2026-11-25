/** The experimental panel uses only the validated host channel, never a webview bearer token. */
export function experimentalPanelHtml(nonce: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
body{color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);padding:16px;max-width:900px;margin:auto}
h1{font-size:18px}h2{font-size:14px;margin-top:24px}label{display:block;margin:12px 0 5px}
button,input,select,textarea{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);padding:6px}
button{cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:disabled{opacity:.5;cursor:default}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.row input,.row select{flex:1;min-width:160px}textarea{box-sizing:border-box;width:100%;min-height:84px;resize:vertical}
.muted{color:var(--vscode-descriptionForeground);font-size:12px}#chat-status{min-height:2em;white-space:pre-wrap}
#transcript{border-left:2px solid var(--vscode-panel-border);padding-left:12px}article{margin:16px 0}article pre,#turn-output{white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit}
summary{cursor:pointer}#result{white-space:pre-wrap;overflow-wrap:anywhere}
</style></head><body>
<h1>pkm-v5 · Experimental host</h1>
<p class="muted">Configured standalone Core, directly or through its shared manager. Not the legacy production Chat panel or reduced native-public MCP.</p>
<section aria-label="Chats">
<h2>Chats</h2>
<div class="row"><label for="chat-session">Saved Chat</label><select id="chat-session" aria-label="Saved Chat"></select><button id="chat-refresh">Refresh Chats</button><button id="chat-more" hidden>More Chats</button></div>
<div class="row"><input id="chat-title" aria-label="New Chat title" placeholder="New Chat title" maxlength="120"><button id="chat-create">New Chat</button></div>
<p id="chat-status" role="status" aria-live="polite">Reading host capabilities…</p>
<div id="transcript" role="log" aria-label="Saved transcript"></div>
<button id="messages-more" hidden>More transcript</button>
<details id="turn-details"><summary id="turn-status">No selected turn</summary><pre id="turn-output"></pre></details>
<details><summary>Read-only turn evidence</summary><button id="chat-evidence">Refresh evidence</button><pre id="turn-evidence"></pre><div id="manager-links"></div></details>
<label for="chat-message">Message</label><textarea id="chat-message" maxlength="100000" aria-label="Message"></textarea>
<div class="row"><button id="chat-send">Send</button><button id="chat-cancel">Cancel active turn</button><button id="chat-archive">Archive Chat</button></div>
<p class="muted">The server owns history and appends the user/terminal transcript atomically. Refreshing, reselecting or reopening never starts a turn. Unknown outcomes require review; no automatic retry.</p>
</section>
<details><summary>Connection and document diagnostics</summary><div class="row"><button id="state">State</button><button id="list">List documents</button></div><pre id="result"></pre></details>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const node = id => document.getElementById(id);
const pageId = crypto.randomUUID();
let sequence = 0, selectedId = '', session, turn, state, sessions = [], nextChats, messagePage, messages = [];
let working = false, reading = false, readRevision = 0, poll, lastOperationId = '', locallyUnknown = false;
const pending = new Map(), terminal = new Set(['completed','cancelled','failed','unknown']);
const available = key => state && state.capabilities.includes(key);
const active = () => turn && !terminal.has(turn.status);
const blocked = () => locallyUnknown || !!(state && state.pending.length) || !!(turn && (turn.uncertain || turn.pendingTool));
const status = value => { node('chat-status').textContent = value; };
function request(action, input = {}) {
  const requestId = pageId + '-' + String(++sequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject({ code: 'HOST_RESPONSE_UNOBSERVED', effect: ['chatCreate','chatStart','chatCancel','chatArchive'].includes(action) ? 'unknown' : 'not-committed' });
    }, 30000);
    pending.set(requestId, { resolve, reject, timer });
    vscode.postMessage({ requestId, action, input });
  });
}
window.addEventListener('message', event => {
  const reply = event.data, waiter = reply && pending.get(reply.requestId);
  if (!waiter) return;
  pending.delete(reply.requestId); clearTimeout(waiter.timer);
  if (reply.error) waiter.reject(reply.error); else waiter.resolve(reply.result);
});
function controls() {
  const busy = working || reading, selected = !!session, archived = selected && !!session.archivedAt;
  node('chat-session').disabled = working;
  node('chat-create').disabled = busy || blocked() || !available('chatCreate');
  node('chat-send').disabled = busy || !selected || archived || active() || blocked() || !available('chatStart') || !node('chat-message').value.trim();
  node('chat-cancel').disabled = busy || !active() || locallyUnknown || !!(state && state.pending.length) || !available('chatCancel');
  node('chat-archive').disabled = busy || !selected || archived || active() || blocked() || !available('chatArchive');
  node('messages-more').hidden = !messagePage || !messagePage.hasMore;
  node('messages-more').disabled = busy;
  node('chat-more').hidden = !nextChats; node('chat-more').disabled = busy;
  node('chat-evidence').disabled = busy || !turn || !available('chatEvents');
}
function renderMessages() {
  node('transcript').replaceChildren();
  for (const message of messages) {
    const article = document.createElement('article'), label = document.createElement('strong'), text = document.createElement('pre');
    label.textContent = message.role + ' · ' + message.status;
    text.textContent = message.content;
    article.append(label, text); node('transcript').append(article);
  }
}
function clearEvidence() {
  node('turn-evidence').textContent = ''; node('manager-links').replaceChildren();
}
function renderSessions() {
  node('chat-session').replaceChildren();
  const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Select a saved Chat'; node('chat-session').append(empty);
  for (const item of sessions) {
    const option = document.createElement('option'); option.value = item.id; option.textContent = item.title; node('chat-session').append(option);
  }
  node('chat-session').value = selectedId;
}
async function observeState() {
  state = await request('state');
  if (state.pending.length) status('Uncertain operation IDs: ' + state.pending.join(', ') + '. Review before submitting replacements.');
  controls();
}
function report(error) {
  if (error.effect === 'unknown') locallyUnknown = true;
  status((error.code || 'CLIENT_ERROR') + (error.effect === 'unknown' ? ' — outcome unknown; do not replay.' : ' — refresh to reconcile; no request replayed.') + (lastOperationId ? ' Operation: ' + lastOperationId : ''));
  controls();
}
async function refreshSelected() {
  clearTimeout(poll);
  const revision = ++readRevision, id = selectedId;
  if (!id) {
    reading = false; session = undefined; turn = undefined; messages = []; messagePage = undefined;
    node('turn-status').textContent = 'No selected turn'; node('turn-output').textContent = '';
    status('Select or create a Chat. No generation starts during discovery.'); clearEvidence(); renderMessages(); controls(); return;
  }
  reading = true; controls();
  try {
    const discovered = [];
    let after;
    do {
      const page = await request('chatTurns', { sessionId: id, limit: 20, ...(after ? { after } : {}) });
      if (revision !== readRevision || id !== selectedId) return;
      discovered.push(...page.items);
      if (discovered.length > 512 || page.next && page.next === after) throw { code: 'TURN_DISCOVERY_BOUND' };
      after = page.next;
    } while (after);
    const page = await request('chatMessages', { id, limit: 100 });
    const current = await request('chatGet', { id });
    if (revision !== readRevision || id !== selectedId) return;
    session = current; messages = page.items; messagePage = page;
    const sorted = discovered.sort((a,b) => b.createdAt-a.createdAt || b.updatedAt-a.updatedAt);
    const previousTurn = turn && turn.id;
    turn = sorted.find(item => !terminal.has(item.status) || item.uncertain || item.pendingTool) || sorted[0];
    if (previousTurn !== (turn && turn.id)) clearEvidence();
    renderMessages();
    node('turn-status').textContent = turn ? 'Turn ' + turn.status + (turn.uncertain ? ' · outcome unknown' : '') : 'No saved turns';
    node('turn-output').textContent = turn ? [turn.output,turn.failure,turn.pendingTool ? 'Pending tool: ' + turn.pendingTool.call.name : ''].filter(Boolean).join('\\n') : '';
    status(active() ? 'Turn ' + turn.status + '. Attached to existing work; no replay.'
      : blocked() ? 'Outcome or pending effect requires review; replacement generation is blocked.'
      : !available('chatStart') ? 'Transcript available. Generation unavailable: configure the native model/provider authority on the standalone host.'
      : session.archivedAt ? 'Archived Chat. History is preserved.' : 'Ready. Server-owned transcript; one new user input per Send.');
    if (active()) poll = setTimeout(() => refreshSelected().catch(report), 1000);
  } finally { if (revision === readRevision) { reading = false; controls(); } }
}
async function refreshChats(more = false) {
  const page = await request('chatList', { limit: 20, ...(more && nextChats ? { cursor: nextChats } : {}) });
  sessions = more ? sessions.concat(page.items) : page.items; nextChats = page.nextCursor;
  renderSessions(); controls();
}
async function run(operation) {
  if (working) return;
  working = true; controls();
  try { await operation(); }
  catch (error) { report(error); }
  finally { working = false; await observeState().catch(report); controls(); }
}
node('chat-session').addEventListener('change', () => {
  selectedId = node('chat-session').value; session = undefined; turn = undefined;
  clearEvidence();
  vscode.setState({ workspaceId: state.workspaceId, sessionId: selectedId });
  refreshSelected().catch(report);
});
node('chat-refresh').addEventListener('click', () => run(async () => { await refreshChats(); await refreshSelected(); }));
node('chat-more').addEventListener('click', () => run(() => refreshChats(true)));
node('messages-more').addEventListener('click', () => run(async () => {
  const id = selectedId, page = await request('chatMessages', { id, limit: 100, cursor: messagePage.nextCursor });
  if (id !== selectedId) return;
  messages.push(...page.items); messagePage = page; renderMessages();
}));
node('chat-message').addEventListener('input', controls);
node('chat-create').addEventListener('click', () => run(async () => {
  lastOperationId = crypto.randomUUID();
  const created = await request('chatCreate', { id: crypto.randomUUID(), operationId: lastOperationId, expectedRevision: 0, title: node('chat-title').value.trim() || 'New Chat' });
  selectedId = created.id; vscode.setState({ workspaceId: state.workspaceId, sessionId: selectedId });
  node('chat-title').value = ''; await refreshChats(); await refreshSelected();
}));
node('chat-send').addEventListener('click', () => run(async () => {
  if (!session || active() || blocked()) return;
  lastOperationId = crypto.randomUUID();
  turn = await request('chatStart', { id: crypto.randomUUID(), sessionId: session.id, operationId: lastOperationId, expectedRevision: 0,
    expectedSessionRevision: session.revision, messages: [{ role: 'user', content: node('chat-message').value }] });
  node('chat-message').value = ''; await refreshSelected();
}));
node('chat-cancel').addEventListener('click', () => run(async () => {
  if (!active()) return;
  lastOperationId = crypto.randomUUID();
  await request('chatCancel', { id: turn.id, operationId: lastOperationId, expectedRevision: turn.revision });
  await refreshSelected();
}));
node('chat-archive').addEventListener('click', () => run(async () => {
  if (!session || active() || blocked()) return;
  lastOperationId = crypto.randomUUID();
  await request('chatArchive', { id: session.id, operationId: lastOperationId, expectedRevision: session.revision });
  selectedId = ''; vscode.setState({ workspaceId: state.workspaceId, sessionId: '' }); await refreshChats(); await refreshSelected();
}));
node('chat-evidence').addEventListener('click', () => run(async () => {
  const id = selectedId, turnId = turn && turn.id;
  if (!turnId) return;
  const events = [];
  let after = 0, next;
  do {
    const page = await request('chatEvents', { id: turnId, after, limit: 100 });
    events.push(...page.events); next = page.next;
    if (next === null || next <= after) break;
    after = next;
  } while (events.length < 1000);
  const runtime = available('retrievalAvailability') ? await request('retrievalAvailability') : { available: false };
  if (selectedId !== id || !turn || turn.id !== turnId) return;
  node('turn-evidence').textContent = 'Server-owned turn ' + turnId
    + '\\nTranscript sources and canonical tool receipts (bounded, read-only):\\n' + JSON.stringify(events, null, 2)
    + (next !== null ? '\\nFurther saved events omitted by this bounded view.' : '')
    + '\\nCurrent retrieval runtime observation — NOT proof that retrieval was injected into this prompt:\\n'
    + JSON.stringify(runtime, null, 2);
  node('manager-links').replaceChildren();
  for (const event of events) {
    const evidence = event.type === 'tool-complete' && event.data && event.data.evidence;
    const resource = evidence && evidence.resource;
    if (!resource || resource.kind !== 'manager-run' || typeof resource.id !== 'string'
      || typeof evidence.operation !== 'string' || !evidence.operation.startsWith('manager.') || !available('managerOverview')) continue;
    const button = document.createElement('button');
    button.textContent = 'Inspect linked Manager run ' + resource.id;
    button.addEventListener('click', () => request('managerOverview', { runId: resource.id })
      .then(value => { node('result').textContent = JSON.stringify(value, null, 2); }).catch(report));
    node('manager-links').append(button);
  }
}));
for (const [id,action] of [['state','state'],['list','knowledgeList']]) node(id).addEventListener('click', () => {
  request(action, {}).then(value => { node('result').textContent = JSON.stringify(value,null,2); }).catch(report);
});
controls();
(async () => {
  await observeState();
  if (!['chatList','chatGet','chatMessages','chatTurns'].every(available)) { status('Chat transcript operations are unavailable on this connection. Shared MCP and standalone Core are separate protocols.'); return; }
  const saved = vscode.getState();
  if (saved && saved.workspaceId === state.workspaceId && typeof saved.sessionId === 'string') selectedId = saved.sessionId;
  await refreshChats(); await refreshSelected();
  if (!selectedId) status('Select or create a Chat. No generation starts during discovery.');
})().catch(report);
</script></body></html>`;
}
