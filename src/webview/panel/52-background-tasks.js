let backgroundTaskSnapshot = null;

function backgroundTaskKindIcon(kind) {
  return ({
    'content-check':'search',
    inventory:'list-tree',
    retrieval:'database',
    'github-sync':'github',
    'broker-refresh':'broadcast',
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

function renderBackgroundTasks() {
  const detail = document.getElementById('detail');
  if (!detail) return;
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
          <div class="background-task-title"><strong>${esc(task.label || 'Background task')}</strong><span class="background-task-status"><i></i>${running ? 'Running' : 'Queued'}</span></div>
          <div class="background-task-detail">${esc(task.detail || (running ? 'In progress' : 'Waiting to run'))}</div>
          ${backgroundTaskProgressHtml(task.progress)}
        </div>
        <time class="background-task-time" datetime="${esc(task.nextRunAt || task.startedAt || '')}">${esc(schedule)}</time>
      </article>`;
    }).join('')}</div>` : `<div class="background-task-empty">
      <span class="codicon codicon-check-all" aria-hidden="true"></span>
      <strong>No background tasks</strong>
      <span>Nothing is queued or running right now.</span>
    </div>`}
  </section>`;
}

function showBackgroundTasksTab() {
  if (backgroundTaskSnapshot) renderBackgroundTasks();
  else {
    document.getElementById('detail').innerHTML = '<div class="empty">Loading background tasks…</div>';
    ask('backgroundTasks', {});
  }
}

function backgroundTasksOnSnapshot(snapshot) {
  backgroundTaskSnapshot = snapshot && typeof snapshot === 'object'
    ? snapshot
    : { revision: 0, updatedAt: '', tasks: [] };
  if (state.tab === 'backgroundTasks') renderBackgroundTasks();
}
