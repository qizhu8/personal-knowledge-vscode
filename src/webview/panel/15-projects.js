// ── Projects workspace ─────────────────────────────────────────────────────
const projectSections = ['Overview','Workflows','Threads','Agents','Artifacts','Decisions'];
let projectSnapshot = null;
let projectRoute = { projectId:'', section:'', workflowView:'' };

function projectDefault(snapshot) {
  return snapshot?.projects?.find(project => project.systemKind === 'default-project') || snapshot?.projects?.[0];
}

function normalizeProjectRoute(snapshot) {
  const saved = vscode.getState()?.projectRoute || {};
  const requestedProjectId = projectRoute.projectId || saved.projectId;
  const matched = snapshot.projects.find(project => project.projectId === requestedProjectId);
  const selected = matched || projectDefault(snapshot);
  const requestedSection = projectRoute.section || saved.section;
  const requestedWorkflowView = projectRoute.workflowView || saved.workflowView;
  projectRoute = {
    projectId:selected?.projectId || '',
    section:matched && projectSections.includes(requestedSection) ? requestedSection : 'Overview',
    workflowView:matched && ['Recipes','Runs'].includes(requestedWorkflowView) ? requestedWorkflowView : 'Recipes'
  };
  const persisted = vscode.getState() || {};
  vscode.setState({ ...persisted, projectRoute });
}

function projectSelect(projectId) {
  projectRoute.projectId = projectId;
  projectRoute.section = 'Overview';
  normalizeProjectRoute(projectSnapshot);
  renderProjects();
}

function projectSection(section) {
  projectRoute.section = projectSections.includes(section) ? section : 'Overview';
  normalizeProjectRoute(projectSnapshot);
  renderProjects();
}

function projectWorkflowView(view) {
  projectRoute.workflowView = view === 'Runs' ? 'Runs' : 'Recipes';
  normalizeProjectRoute(projectSnapshot);
  renderProjects();
}

function projectNew() {
  pkModal({ title:'New Project', message:'Create a Project with its required General Thread.', input:true, okLabel:'Create', onOk:name => {
    if (name.trim()) ask('projectCreate', { name:name.trim() });
  }});
}

function projectNewThread() {
  pkModal({ title:'New Thread', message:'Create a Thread in the selected Project.', input:true, okLabel:'Create', onOk:name => {
    if (name.trim()) ask('threadCreate', { projectId:projectRoute.projectId, name:name.trim() });
  }});
}

function projectMoveThread(threadId, destinationProjectId) {
  if (destinationProjectId) ask('threadMove', { threadId, destinationProjectId });
}

function projectOpenThread(threadId) {
  const persisted = vscode.getState() || {};
  vscode.setState({ ...persisted, projectThreadId:threadId });
  document.querySelector('.tab[data-tab="chatroom"]')?.dispatchEvent(new MouseEvent('click'));
}

function projectZero(title, detail) {
  return `<div class="project-zero"><strong>${esc(title)}</strong><span>${esc(detail)}</span></div>`;
}

function projectSectionBody(project, threads) {
  if (projectRoute.section === 'Overview') return `
    <div class="project-metrics" aria-label="Project counts">
      <div><strong>${threads.length}</strong><span>Threads</span></div><div><strong>0</strong><span>Active Runs</span></div><div><strong>0</strong><span>Agents</span></div><div><strong>0</strong><span>Artifacts</span></div>
    </div>
    <section class="project-band"><h3>Current work</h3>${threads.length ? `<div class="project-thread-compact">${threads.map(thread => `<button onclick="projectOpenThread('${esc(thread.threadId)}')"><span>${esc(thread.name)}</span><small>${thread.systemKind ? 'System · General' : 'Thread'}</small></button>`).join('')}</div>` : projectZero('No Threads','Create a Thread to begin project work.')}</section>
    <section class="project-band"><h3>Recent activity</h3>${projectZero('No recorded activity','Runs, decisions, and artifacts will appear here when their stores are connected.')}</section>`;
  if (projectRoute.section === 'Workflows') {
    const label = projectRoute.workflowView;
    return `<div class="project-subnav" role="tablist" aria-label="Workflow views"><button class="${label === 'Recipes' ? 'active' : ''}" onclick="projectWorkflowView('Recipes')">Recipes</button><button class="${label === 'Runs' ? 'active' : ''}" onclick="projectWorkflowView('Runs')">Runs</button></div>${label === 'Recipes' ? projectZero('No Recipes','Workflow recipes assigned to this Project will appear here.') : projectZero('No Runs','This Project has no workflow runs yet.')}`;
  }
  if (projectRoute.section === 'Threads') return threads.length ? `<div class="project-thread-list">${threads.map(thread => `
    <div class="project-thread-row"><div><strong>${esc(thread.name)}</strong><span>${thread.systemKind === 'general-thread' ? 'System · General Thread' : thread.archived ? 'Archived Thread' : 'Thread'}</span></div>
      <select aria-label="Move ${esc(thread.name)} to Project" onchange="projectMoveThread('${esc(thread.threadId)}',this.value)" ${thread.systemKind === 'general-thread' ? 'disabled title="General Thread cannot move"' : ''}><option value="">Move to…</option>${projectSnapshot.projects.filter(candidate => candidate.projectId !== project.projectId).map(candidate => `<option value="${esc(candidate.projectId)}">${esc(candidate.name)}</option>`).join('')}</select>
      <button class="tbtn" onclick="projectOpenThread('${esc(thread.threadId)}')">Open Thread</button></div>`).join('')}</div>` : projectZero('No Threads','Create a Thread to open a focused collaboration surface.');
  const zero = {
    Agents:['No Agents','Agents assigned to this Project will appear here.'],
    Artifacts:['No Artifacts','Outputs produced by project work will appear here.'],
    Decisions:['No Decisions','Recorded project decisions will appear here.']
  }[projectRoute.section];
  return projectZero(zero[0], zero[1]);
}

function renderProjects() {
  if (state.tab !== 'projects') return;
  const detail = document.getElementById('detail');
  if (!projectSnapshot) { detail.innerHTML = '<div class="empty">Loading Projects…</div>'; return; }
  normalizeProjectRoute(projectSnapshot);
  const project = projectSnapshot.projects.find(candidate => candidate.projectId === projectRoute.projectId) || projectDefault(projectSnapshot);
  if (!project) { detail.innerHTML = projectZero('Projects unavailable','The Project store did not provide a system Default Project.'); return; }
  const threads = projectSnapshot.threads.filter(thread => thread.projectId === project.projectId);
  detail.innerHTML = `<div class="projects-workspace">
    <aside class="project-tree" aria-label="Projects"><div class="project-tree-head"><strong>Projects</strong><button class="tbtn" onclick="projectNew()">New Project</button></div>
      ${projectSnapshot.projects.map(candidate => `<button class="project-tree-item ${candidate.projectId === project.projectId ? 'active' : ''}" onclick="projectSelect('${esc(candidate.projectId)}')"><span>${esc(candidate.name)}</span><small>${candidate.systemKind === 'default-project' ? 'System · Default' : `${projectSnapshot.threads.filter(thread => thread.projectId === candidate.projectId).length} Threads`}</small></button>`).join('')}</aside>
    <div class="project-content"><header class="project-header"><div><span>${project.systemKind === 'default-project' ? 'System Project' : 'Project'}</span><h2>${esc(project.name)}</h2><p>${threads.length} Threads · 0 Runs · 0 Agents</p></div><button class="tbtn" onclick="projectNewThread()">New Thread</button></header>
      <nav class="project-sections" aria-label="Project sections">${projectSections.map(section => `<button class="${section === projectRoute.section ? 'active' : ''}" onclick="projectSection('${section}')">${section}</button>`).join('')}</nav>
      <div class="project-section-body">${projectSectionBody(project, threads)}</div>
    </div></div>`;
}

function projectOnState(snapshot) {
  projectSnapshot = snapshot;
  normalizeProjectRoute(snapshot);
  renderProjects();
}

function projectOnResult(data) {
  finishAction('projectCreate','threadCreate','threadMove');
  projectSnapshot = data.snapshot;
  if (data.action === 'projectCreate') { projectRoute.projectId = data.entityId; projectRoute.section = 'Overview'; }
  if (data.action === 'threadCreate') projectRoute.section = 'Threads';
  normalizeProjectRoute(projectSnapshot);
  renderProjects();
}

function projectOnError(data) {
  finishAction('projectCreate','threadCreate','threadMove');
  const host = document.querySelector('.project-header') || document.getElementById('detail');
  host?.querySelector('.project-error')?.remove();
  const error = document.createElement('div'); error.className = 'project-error'; error.setAttribute('role','alert'); error.textContent = data?.error || 'Project action failed.';
  host?.appendChild(error);
}