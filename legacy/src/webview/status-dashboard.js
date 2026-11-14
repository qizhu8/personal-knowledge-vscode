(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pair = (label, value) => `<dt>${esc(label)}</dt><dd>${esc(value ?? 'Not reported')}</dd>`;
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not reported';
  function age(value) {
    const timestamp = Date.parse(value || '');
    if (!Number.isFinite(timestamp)) return '';
    if (timestamp > Date.now()) return ' (clock ahead)';
    const minutes = Math.floor((Date.now() - timestamp) / 60000);
    return ` (${Math.floor(minutes / 60)} h ${minutes % 60} min ago)`;
  }
  function progress(value) {
    if (!value || !Number.isFinite(value.current) || value.current < 0) return '<p class="muted">Work count not reported</p><progress aria-label="Index build in progress"></progress>';
    const known = Number.isFinite(value.total) && value.total > 0 && value.current <= value.total;
    const percent = known ? Math.floor(value.current / value.total * 100) : undefined;
    return `<p>${esc(value.current)}${known ? ` / ${esc(value.total)} (${percent}%)` : ''} ${esc(value.unit || 'items')}</p><progress aria-label="Index build progress"${known ? ` max="${value.total}" value="${value.current}"` : ''}></progress>`;
  }
  function render(snapshot) {
    const host = snapshot.host, retrieval = snapshot.retrieval, lifecycle = retrieval.lifecycle, index = retrieval.status;
    const tasks = snapshot.tasks.tasks;
    const html = `<section><h2>Host</h2><dl>${pair('Loaded', `${host.version} / ${host.build}`)}${pair('Installed', `${host.installedVersion || 'unknown'} / ${host.installedBuild || 'unknown'}`)}${pair('Activity', host.busy ? 'Busy' : 'Idle')}${pair('Integration', host.integration)}${pair('PID', host.pid)}${pair('VS Code / Node', `${host.vscode} / ${host.node}`)}${pair('Online hosts', host.hosts)}</dl>${host.error ? `<p class="error">${esc(host.error)}</p>` : ''}<p class="muted">Registered hosts in this installation/profile only. Other machines and external agents are not verified.</p></section>
      <section><h2>Retrieval index</h2><p class="state">${esc(retrieval.error ? 'Observation unavailable' : lifecycle.state)}</p><p>${esc(retrieval.error || lifecycle.detail || 'No worker build observation yet.')}</p>${!retrieval.error && lifecycle.state === 'working' ? progress(lifecycle.progress) : ''}<dl>${pair('Documents', index?.document_count)}${pair('Ready generation', index?.ready_generation)}${pair('Building generation', index?.building_generation)}${pair('Observed', date(retrieval.observedAt))}</dl>${index?.error || lifecycle.error ? `<p class="error">${esc(index?.error || lifecycle.error)}</p>` : ''}<p class="muted">Worker-reported phase progress, not an estimate of total elapsed time. A ready generation can continue serving while its replacement builds.</p></section>
      <section><h2>GitHub Sync</h2>${snapshot.sync.length ? snapshot.sync.map(target => `<article><h3>${esc(target.name)}</h3><p class="state">${esc(target.status)}</p>${target.detail ? `<p>${esc(target.detail)}</p>` : ''}${target.error ? `<p class="error">${esc(target.error)}</p>` : ''}<dl>${pair('Last success', date(target.lastSuccessAt) + age(target.lastSuccessAt))}${pair('Next scheduled', date(target.nextSyncAt))}</dl></article>`).join('') : '<p>No configured targets.</p>'}</section>
      <section><h2>Background work (${tasks.length})</h2>${tasks.slice(0, 100).map(task => `<article><h3>${esc(task.label)}</h3><p>${esc(task.status)}${task.detail ? ` - ${esc(task.detail)}` : ''}</p>${task.progress ? progress(task.progress) : ''}</article>`).join('') || '<p>No queued or running tasks reported.</p>'}${tasks.length > 100 ? `<p>${tasks.length - 100} additional tasks not displayed.</p>` : ''}<p class="muted">Registry observations are not proof that an external operation has terminated.</p></section>`;
    const dashboard = document.getElementById('dashboard');
    if (dashboard.innerHTML !== html) dashboard.innerHTML = html;
    document.getElementById('updated').textContent = `Snapshot: ${date(snapshot.updatedAt)}`;
  }
  document.querySelector('nav').addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (['refresh', 'sync', 'logs', 'diagnostics'].includes(action)) vscode.postMessage({ type: action });
  });
  window.addEventListener('message', event => {
    const message = event.data;
    const notice = document.getElementById('notice');
    if (message?.type === 'error') { notice.textContent = message.message; notice.hidden = false; return; }
    if (message?.type !== 'snapshot') return;
    notice.hidden = true;
    render(message.snapshot);
  });
  vscode.postMessage({ type: 'ready' });
})();
