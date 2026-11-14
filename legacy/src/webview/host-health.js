(() => {
  const api = acquireVsCodeApi();
  const STARTUP_LIMIT_MS = 180_000;
  let startedAt = Date.now();
  let hiddenAt;
  let lastReply = startedAt;
  let loaded = false;
  let failed = false;
  let failureKind;
  let waitingForStyles = false;
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
  retry.title = 'Retry connection';
  retry.setAttribute('aria-label', retry.title);
  retry.textContent = retry.title;
  const logs = document.createElement('button');
  logs.type = 'button'; logs.textContent = 'Open diagnostic log';
  logs.onclick = () => api.postMessage({ command:'showLogs', type:'showLogs' });
  banner.append(icon, text, retry, logs);
  document.body.append(banner);
  function warn(message, kind = 'interface') {
    if (kind === 'interface') api.postMessage({ type: 'interfaceError', message: String(message).slice(0, 600) });
    if (loading) loading.hidden = true;
    failed = true;
    failureKind = kind;
    banner.dataset.kind = kind;
    banner.setAttribute('role', 'alert');
    text.textContent = message + ' Check Output > Personal Knowledge Manager when available. Retrying does not reconnect SSH, resend requests or undo tool actions.';
    retry.hidden = false; logs.hidden = false;
    retry.textContent = kind === 'interface' ? 'Reload interface' : 'Retry connection';
    retry.title = retry.textContent; retry.setAttribute('aria-label', retry.title);
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
    retry.hidden = true; logs.hidden = false;
  }
  function ready() {
    if (globalThis.PkmChatStyleFailure) {
      warn('PKM interface failed to load a required stylesheet. Reload the interface.');
      return;
    }
    const pendingStyles = ['pkm-chat-styles', 'pkm-chat-icons']
      .map(id => document.getElementById(id))
      .filter(link => link && !link.sheet);
    if (pendingStyles.length) {
      if (!waitingForStyles) {
        waitingForStyles = true;
        const resume = () => {
          for (const link of pendingStyles) {
            link.removeEventListener('load', resume);
            link.removeEventListener('error', resume);
          }
          waitingForStyles = false;
          ready();
        };
        for (const link of pendingStyles) {
          link.addEventListener('load', resume);
          link.addEventListener('error', resume);
        }
      }
      return;
    }
    if (loading) loading.hidden = true;
    document.documentElement?.removeAttribute('data-pkm-loading');
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
      if (failed && !['ready', 'hostHealth', 'openHelp', 'showLogs'].includes(message.command || message.type)) return;
      return api.postMessage(message);
    },
  };
  retry.onclick = () => {
    if (failureKind === 'interface') { window.location.reload(); return; }
    if (!loaded) {
      startedAt = Date.now();
      failureKind = undefined;
      if (loading) loading.hidden = false;
    }
    text.textContent = 'Retrying connection to PKM backend...';
    ping();
    api.postMessage({ command: 'ready', type: 'ready' });
  };
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'initializationError') warn('PKM Chat failed to initialize: ' + String(message.message || 'Unknown error'), 'initial');
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
  if (globalThis.PkmChatStyleFailure) warn('PKM interface failed to load a required stylesheet. Reload the interface.');
  setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (!loaded && failureKind !== 'interface' && failureKind !== 'initial') {
      if (now - startedAt >= 15_000 && now - lastReply >= 30_000) warn('Cannot reach the PKM backend while starting. The remote/network connection may be interrupted, or the Extension Host may be busy or stopped. Remote SSH users: check the VS Code connection status first. Your draft is preserved; diagnostic commands may be unavailable until the connection recovers.', 'initial-unresponsive');
      else if (now - startedAt >= STARTUP_LIMIT_MS) warn('PKM failed to load: the Extension Host is responding but did not provide the initial state within 3 minutes. Retry the connection, or check Output > Personal Knowledge Manager.', 'initial');
      else if (now - startedAt >= 8_000) starting(Math.round((now - startedAt) / 1000));
    }
    else if (loaded && now - lastReply >= 20_000 && failureKind !== 'interface') warn('Cannot reach the PKM backend. The remote/network connection may be interrupted, or the Extension Host may be busy or stopped. Remote SSH users: check the VS Code connection status first. Your draft is preserved; diagnostic commands may be unavailable until the connection recovers.', 'host');
    ping();
  }, 5000);
  ping();
})();