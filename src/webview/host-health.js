(() => {
  const api = acquireVsCodeApi();
  const STARTUP_LIMIT_MS = 180_000;
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
    banner.dataset.kind = kind;
    banner.setAttribute('role', 'alert');
    text.textContent = message;
    banner.hidden = false;
    document.body.classList.add('pkm-host-unavailable');
  }
  // The Host answers health pings before the Chat backend has loaded. While it does, slow first activation (cold
  // Windows disk caches, Defender scanning a freshly installed VSIX, Python discovery) is "starting", not a failure.
  function starting(seconds) {
    if (failed) return;
    text.textContent = `PKM is still starting (${seconds}s). First start after install or update can take a minute or two; nothing is wrong yet.`;
    banner.dataset.kind = 'starting';
    banner.setAttribute('role', 'status');
    banner.hidden = false;
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
      else if (!loaded && failed && failureKind === 'initial-unresponsive') {
        failed = false; failureKind = undefined; document.body.classList.remove('pkm-host-unavailable');
        if (loading) loading.hidden = false;
        starting(Math.round((Date.now() - startedAt) / 1000));
      }
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
    if (!loaded && failureKind !== 'interface' && failureKind !== 'initial') {
      if (now - startedAt >= STARTUP_LIMIT_MS) warn('PKM failed to load: the Extension Host is responding but did not provide the initial state within 3 minutes. Use reconnect, or check Output > Personal Knowledge.', 'initial');
      else if (now - startedAt >= 15_000 && now - lastReply >= 30_000) warn('PKM is not responding while starting. The Extension Host may be busy or stopped; your draft is preserved.', 'initial-unresponsive');
      else if (now - startedAt >= 8_000) starting(Math.round((now - startedAt) / 1000));
    }
    else if (loaded && now - lastReply >= 20_000 && failureKind !== 'interface') warn('Extension Host is not responding. PKM is disconnected; your draft is preserved.', 'host');
    ping();
  }, 5000);
  ping();
})();