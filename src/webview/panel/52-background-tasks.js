let backgroundTaskSnapshot = null;
let backgroundProcessSnapshot = null;
const backgroundProcessExpandedKinds = new Set();

function backgroundProcessDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'Unknown';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

function backgroundProcessesHtml() {
  const snapshot = backgroundProcessSnapshot;
  const processes = Array.isArray(snapshot?.processes) ? snapshot.processes : [];
  const groups = [
    ['mcp', 'PKM MCP'],
    ['retrieval', 'Retrieval worker'],
    ['service', 'PKM service'],
  ];
  const labels = {
    'test-leftover': 'Test leftover · entry deleted',
    'missing-entry': 'Entry missing · possibly stale',
    superseded: 'Reconnect / drain review',
    older: 'Older runtime reported',
    newer: 'Newer runtime reported',
    current: 'Matching extension version reported',
    test: 'Test fixture',
    unverified: 'Runtime not verified',
  };
  const actions = {
    'test-leftover': 'Review fixture ownership and in-flight work before cleanup.',
    'missing-entry': 'Verify ownership and ongoing work before cleanup; a missing entry is not permission to stop.',
    superseded: 'Reconnect the owning client after drain; review uncertain calls and never replay writes automatically.',
    older: 'Update / reconnect the owning client. Do not stop a process solely because its version is older.',
    newer: 'Check the owning installation and client before changing anything; do not downgrade automatically.',
    current: 'No version mismatch reported. This does not prove a task is active or the client handshake is verified.',
    test: 'Use the test runner teardown; do not confuse a test process with a production service.',
    unverified: 'Inspect the owning client or runtime status. PID and age do not determine old versus current.',
  };
  const row = p => {
    const assessment = p.assessment || { state: 'unverified', basis: 'unknown' };
    const status = assessment.state;
    const runtime = p.runtime;
    const pathOnly = assessment.basis === 'entry-path';
    const label = pathOnly && ['older', 'newer'].includes(status)
      ? `${status === 'older' ? 'Older' : 'Newer'} entry path · runtime unknown` : labels[status] || labels.unverified;
    const role = p.kind === 'mcp' ? 'Serves tools to an MCP client; separate stdio clients may have separate processes.'
      : p.kind === 'retrieval' ? 'Builds and queries the knowledge index; may host semantic retrieval models.'
      : 'Coordinates GitHub Sync across windows and preserves scheduling state.';
    return `<article class="background-task-row background-process-row ${esc(status)}" role="listitem">
      <span class="background-task-icon codicon codicon-${p.kind === 'mcp' ? 'plug' : p.kind === 'retrieval' ? 'database' : 'server'}" title="${esc(role)}" aria-hidden="true"></span>
      <div class="background-task-copy"><div class="background-task-title"><strong>PID ${esc(p.pid)}</strong>
        <span class="background-task-status">${['older', 'superseded'].includes(status) ? 'Old · ' : ''}${esc(label)}</span></div>
        <div class="background-process-meta">${esc(backgroundProcessDuration(p.elapsedSeconds))} · ${esc((p.rssBytes / 1048576).toFixed(1))} MiB
          · ${runtime?.fresh && runtime.extensionVersion ? `v${esc(runtime.extensionVersion)} (reported)` : p.pathVersion ? `v${esc(p.pathVersion)} (path only)` : 'Version unknown'}</div>
        ${p.runtimeError ? `<div class="background-process-error" role="alert">${esc(p.runtimeError)}</div>` : ''}
        <details class="background-process-entry"><summary>Details</summary>
        <div class="background-process-meta">Parent ${esc(p.parentPid)} (${esc(p.parentName || (p.parentPid === 1 ? 'system parent; ownership not proved' : 'not observed in this user snapshot'))})
          <br>Started ≈ ${esc(p.startedAt || 'Unknown')}
          <br>Entry-path version: ${esc(p.pathVersion || 'Unknown')}
          <br>Runtime-reported extension: ${esc(runtime?.extensionVersion || 'Unknown')}${p.kind === 'mcp' ? ` · MCP server version: ${esc(runtime?.serverVersion || 'Unknown')}` : ''}
          <br>Entry: ${p.entryExists === false ? 'Missing' : p.entryExists === true ? 'Present' : 'Unknown'} · ${p.fixture ? 'Test fixture path' : 'No known test-fixture marker'}
          ${p.kind === 'mcp' ? '<br>Client / Chat identity: Unverified; a parent PID does not identify a conversation.' : ''}</div>
        ${runtime ? `<div class="background-process-evidence"><strong>${runtime.fresh ? 'Fresh at sample time' : 'Stale report · not used as current runtime evidence'}</strong>
          <div class="background-process-meta">Source: managed MCP registry (not a same-client handshake) · Reported ${esc(runtime.observedAt || 'Unknown')}
            <br>Phase: ${esc(runtime.phase || 'Unknown')} · In flight: ${esc(runtime.inFlight ?? 'Unknown')} · Uncertain calls: ${esc(runtime.uncertainCalls ?? 'Unknown')}
            <br>Running generation: ${esc(runtime.generation || 'Unknown')}<br>Configured generation: ${esc(runtime.configuredGeneration || 'Unknown')}
            <br>MCP runtime build: ${esc(runtime.runtimeBuild || 'Unknown')}</div></div>`
          : '<div class="background-process-meta">Activity / in-flight work: Unknown · No per-process runtime report available.</div>'}
        <div class="background-process-action"><strong>Next:</strong> ${esc(actions[status] || actions.unverified)}</div>
        <div class="background-process-path">${esc(p.entryPath)}</div></details>
      </div></article>`;
  };
  return `<section class="background-processes">
    <header class="background-tasks-head"><div><h2>Background Processes</h2>
      <p>Processes, not active tasks.</p></div>
      <button type="button" class="tbtn" id="background-process-refresh">Refresh</button></header>
    ${!snapshot ? '<p role="status">Loading background processes…</p>' : snapshot.error
      ? `<p role="alert">${esc(snapshot.error)}</p>`
      : `<div class="background-process-overview"><span>${processes.length} processes</span>
          <span title="RSS includes shared pages; not reclaimable memory.">${esc((processes.reduce((sum, p) => sum + p.rssBytes, 0) / 1048576).toFixed(1))} MiB RSS</span></div>
        <details class="background-process-info"><summary>Snapshot details</summary>
          <dl class="background-process-facts">
            <dt>Host</dt><dd>${esc(snapshot.host)} (${esc(snapshot.platform)})</dd>
            <dt>Sampled</dt><dd>${esc(snapshot.sampledAt)}</dd>
            <dt>Installed / window</dt><dd>${esc(snapshot.installedExtension?.version || 'Unknown')} / ${esc(snapshot.loadedExtension?.version || 'Unknown')}</dd>
            <dt>Scope</dt><dd>This OS user and machine; all windows and knowledge roots.</dd>
            <dt>Refresh</dt><dd>Manual; no automatic polling.</dd>
          </dl>
          <ul class="background-process-notes"><li>RSS includes shared pages; not reclaimable memory.</li>
            <li>Latest requires a fresh runtime report, not a path version.</li>
            <li>Old or suspected leftover does not mean safe to stop.</li></ul>
        </details>
        ${!processes.length ? '<p>No recognized PKM background processes found.</p>' : ''}
        ${groups.map(([key, title]) => {
          const members = processes.filter(p => p.kind === key);
          const latest = members.filter(p => p.assessment?.state === 'current').length;
          const old = members.filter(p => ['older', 'superseded'].includes(p.assessment?.state)).length;
          const leftovers = members.filter(p => ['test-leftover', 'missing-entry'].includes(p.assessment?.state)).length;
          return `<details class="background-process-group" id="background-process-group-${key}" data-process-group="${key}" ${backgroundProcessExpandedKinds.has(key) ? 'open' : ''}>
            <summary><strong>${esc(title)}</strong><span class="background-process-counts">
              <span>${members.length} PIDs</span><span>${latest} latest (reported)</span>
              <span class="${old ? 'background-process-warning' : ''}">${old} old</span>
              <span class="${leftovers ? 'background-process-warning' : ''}">${leftovers} suspected leftovers</span>
              <span>${members.length - latest - old - leftovers} other / unverified</span></span></summary>
            ${members.length ? `<div class="background-task-list" role="list">${members.map(row).join('')}</div>` : '<p class="background-process-meta">No processes observed in this category.</p>'}</details>`;
        }).join('')}`}
  </section>`;
}

function backgroundTaskKindIcon(kind) {
  return ({
    'content-check':'search',
    inventory:'list-tree',
    retrieval:'database',
    'github-sync':'github',
    'broker-refresh':'broadcast',
    'action-validation':'beaker',
  })[kind] || 'gear';
}

function backgroundTaskScheduleLabel(nextRunAt, now = Date.now()) {
  const time = Date.parse(nextRunAt || '');
  if (!Number.isFinite(time)) return '';
  const remaining = time - now;
  if (remaining <= 0) return 'Due now';
  if (remaining < 60_000) return `in ${Math.max(1, Math.ceil(remaining / 1000))}s`;
  if (remaining < 3_600_000) return `in ${Math.ceil(remaining / 60_000)}m`;
  if (remaining < 86_400_000) return `in ${Math.ceil(remaining / 3_600_000)}h`;
  return new Date(time).toLocaleString();
}

function backgroundTaskProgressHtml(progress) {
  if (!progress || !Number.isFinite(Number(progress.current))) return '';
  const current = Number(progress.current);
  const total = Number(progress.total);
  const unit = esc(progress.unit || 'items');
  if (Number.isFinite(total) && total > 0) {
    return `<div class="background-task-progress"><progress value="${Math.min(current, total)}" max="${total}"></progress><span>${current.toLocaleString()} / ${total.toLocaleString()} ${unit}</span></div>`;
  }
  return `<span class="background-task-count">${current.toLocaleString()} ${unit}</span>`;
}

function rememberBackgroundProcessExpansion() {
  for (const kind of ['mcp', 'retrieval', 'service']) {
    const group = document.getElementById(`background-process-group-${kind}`);
    if (!group) continue;
    if (group.open) backgroundProcessExpandedKinds.add(kind);
    else backgroundProcessExpandedKinds.delete(kind);
  }
}

function renderBackgroundTasks() {
  const detail = document.getElementById('detail');
  if (!detail) return;
  rememberBackgroundProcessExpansion();
  const tasks = Array.isArray(backgroundTaskSnapshot?.tasks)
    ? backgroundTaskSnapshot.tasks.filter(task => task && (task.status === 'queued' || task.status === 'running'))
    : [];
  detail.style.padding = '0';
  detail.style.overflow = 'auto';
  detail.innerHTML = `<section class="background-tasks-workspace">
    <header class="background-tasks-head">
      <div><h2>Background Tasks</h2><p>Live extension work that is running now or waiting to run.</p></div>
      <span class="background-task-total">${tasks.length} active</span>
    </header>
    ${tasks.length ? `<div class="background-task-list" role="list">${tasks.map(task => {
      const running = task.status === 'running';
      const schedule = running ? '' : backgroundTaskScheduleLabel(task.nextRunAt);
      return `<article class="background-task-row ${running ? 'running' : 'queued'}" role="listitem">
        <span class="background-task-icon codicon codicon-${backgroundTaskKindIcon(task.kind)}" aria-hidden="true"></span>
        <div class="background-task-copy">
          <div class="background-task-title"><strong>${esc(task.label || 'Background task')}</strong><span class="background-task-status"><i></i>${esc(task.projection?.state || (running ? 'Running' : 'Queued'))}</span></div>
          <div class="background-task-detail">${esc(task.detail || (running ? 'In progress' : 'Waiting to run'))}</div>
          ${task.projection ? `<div class="background-task-detail">${esc(task.projection.objectKind)} · Next: ${esc(task.projection.nextOwner)} · ${esc(task.projection.reason)} ${esc(task.projection.resume)}</div>` : ''}
          ${backgroundTaskProgressHtml(task.progress)}
        </div>
        <time class="background-task-time" datetime="${esc(task.nextRunAt || task.startedAt || '')}">${esc(schedule)}</time>
      </article>`;
    }).join('')}</div>` : `<div class="background-task-empty">
      <span class="codicon codicon-check-all" aria-hidden="true"></span>
      <strong>No background tasks</strong>
      <span>Nothing is queued or running right now.</span>
    </div>`}
    ${backgroundProcessesHtml()}
  </section>`;
  const refresh = document.getElementById('background-process-refresh');
  if (refresh) refresh.onclick = () => {
    refresh.disabled = true;
    refresh.textContent = 'Refreshing…';
    ask('backgroundProcesses', {});
  };
  for (const kind of ['mcp', 'retrieval', 'service']) {
    const group = document.getElementById(`background-process-group-${kind}`);
    if (group) group.ontoggle = () => {
      if (group.isConnected) rememberBackgroundProcessExpansion();
    };
  }
}

function showBackgroundTasksTab() {
  if (backgroundTaskSnapshot) renderBackgroundTasks();
  else {
    document.getElementById('detail').innerHTML = '<div class="empty">Loading background tasks…</div>';
    ask('backgroundTasks', {});
  }
  ask('backgroundProcesses', {});
}

function backgroundProcessesOnSnapshot(snapshot) {
  backgroundProcessSnapshot = snapshot;
  if (state.tab === 'backgroundTasks') renderBackgroundTasks();
}

function backgroundTasksOnSnapshot(snapshot) {
  backgroundTaskSnapshot = snapshot && typeof snapshot === 'object'
    ? snapshot
    : { revision: 0, updatedAt: '', tasks: [] };
  if (state.tab === 'backgroundTasks') renderBackgroundTasks();
}
