(() => {
  const api = acquireVsCodeApi();
  let startedAt = Date.now();
  let hiddenAt;
  let lastReply = startedAt;
  let loaded = false;
  let failed = false;
  let failureKind;
  let sequence = 0;
  const pending = new Set();
  const loading = document.getElementById('pkm-chat-loading');
  const banner = document.createElement('aside');
  banner.className = 'pkm-host-warning';
  banner.id = 'pkm-host-warning';
  banner.setAttribute('role', 'alert');
  banner.hidden = true;
  const icon = document.createElement('span');
  icon.className = 'codicon codicon-warning';
  icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.title = 'Reconnect to Extension Host';
  retry.setAttribute('aria-label', retry.title);
  retry.innerHTML = '<span class="codicon codicon-refresh" aria-hidden="true"></span>';
  banner.append(icon, text, retry);
  document.body.append(banner);
  function warn(message, kind = 'interface') {
    if (loading) loading.hidden = true;
    failed = true;
    failureKind = kind;
    text.textContent = message;
    banner.hidden = false;
    document.body.classList.add('pkm-host-unavailable');
  }
  function ready() {
    if (loading) loading.hidden = true;
    loaded = true;
    lastReply = Date.now();
    pending.clear();
    failed = false;
    failureKind = undefined;
    banner.hidden = true;
    document.body.classList.remove('pkm-host-unavailable');
  }
  function ping() {
    const id = 'host-health-' + ++sequence;
    pending.add(id);
    if (pending.size > 8) pending.delete(pending.values().next().value);
    api.postMessage({ command: 'hostHealth', type: 'hostHealth', id });
  }
  globalThis.PkmHostHealth = { ready, get unavailable() { return failed || !loaded; } };
  globalThis.PkmWebviewApi = {
    getState: () => api.getState(),
    setState: value => api.setState(value),
    postMessage: message => {
      if (failed && !['ready', 'hostHealth'].includes(message.command || message.type)) return;
      return api.postMessage(message);
    },
  };
  retry.onclick = () => {
    if (!loaded) {
      startedAt = Date.now();
      failureKind = undefined;
      if (loading) loading.hidden = false;
    }
    text.textContent = 'Reconnecting to Extension Host...';
    ping();
    api.postMessage({ command: 'ready', type: 'ready' });
  };
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'initializationError') warn('PKM Chat failed to initialize: ' + String(message.message || 'Unknown error'));
    if ((message?.type || message?.command) === 'hostHealth' && pending.has(message.id)) {
      pending.delete(message.id);
      lastReply = Date.now();
      if (loaded && failed && failureKind === 'host') ready();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else {
      if (hiddenAt !== undefined) startedAt += Date.now() - hiddenAt;
      hiddenAt = undefined;
      lastReply = Date.now();
      ping();
    }
  });
  window.addEventListener('error', event => warn('PKM interface failed to load: ' + (event.message || 'A script or asset failed to load.')), true);
  window.addEventListener('unhandledrejection', event => warn('PKM interface error: ' + String(event.reason?.message || event.reason || 'Unknown error')));
  setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (!loaded && now - startedAt >= 15_000 && failureKind !== 'interface') warn('PKM failed to load: Extension Host did not provide the initial state.', 'initial');
    else if (loaded && now - lastReply >= 20_000 && failureKind !== 'interface') warn('Extension Host is not responding. PKM is disconnected; your draft is preserved.', 'host');
    ping();
  }, 5000);
  ping();
})();