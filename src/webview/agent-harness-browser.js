(async function () {
  'use strict';
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  const connection = document.getElementById('connection');
  let stopped = false;
  const controllers = new Set();
  async function request(method, params = {}) {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetch('api', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
        body:JSON.stringify({ method, params }), signal:controller.signal, cache:'no-store' });
      if (!response.ok) throw new Error(`Harness connection failed (HTTP ${response.status}).`);
      const value = await response.json();
      if (!value.ok) throw new Error(value.error || 'Harness request failed.');
      return value.data;
    } finally { clearTimeout(timeout); controllers.delete(controller); }
  }
  let view;
  window.addEventListener('pagehide', () => { stopped = true; view?.dispose(); controllers.forEach(controller => controller.abort()); });
  try {
    if (!token) throw new Error('Open this Session from VS Code to obtain an authenticated browser link.');
    const initial = await request('snapshot');
    const container = document.getElementById('harness');
    container.replaceChildren();
    view = PkmAgentHarness.mount(container, { initial, request });
    let revision = 0, retryDelay = 1000;
    while (!stopped) {
      try {
        const event = await request('watch', { revision });
        if (stopped) break;
        if (event.revision !== revision) view.notify();
        revision = event.revision; retryDelay = 1000;
        connection.textContent = 'Connected / event subscription active';
      } catch (error) {
        if (stopped) break;
        connection.textContent = `Disconnected: ${error.message}. Retrying; manual refresh remains available.`;
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(30000, retryDelay * 2);
      }
    }
  } catch (error) { connection.textContent = error.message; connection.setAttribute('role', 'alert'); }
})();
