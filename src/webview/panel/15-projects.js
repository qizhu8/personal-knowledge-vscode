// ── Projects workspace ─────────────────────────────────────────────────────
const projectSections = ['Overview','Todos','Threads','Gantt','Agents','Artifacts','Decisions'];
let projectSnapshot = null;
let projectSnapshotDirty = false;
let projectRoute = { projectId:'', section:'', workflowView:'' };
let selectedGanttTaskId = '';
let selectedAgentSessionId = '';
let selectedAgentSnapshotId = '';
let agentSnapshotCredential = null;
let agentSessionArchiveExpanded = vscode.getState()?.agentSessionArchiveExpanded;
let agentSessionTreeCollapsed = !!vscode.getState()?.agentSessionTreeCollapsed;
let agentSessionFullscreenRunId = String(vscode.getState()?.agentSessionFullscreenRunId || '');
let agentSessionGraphZoom = Number(vscode.getState()?.agentSessionGraphZoom || 1);
let selectedAgentSessionTodoId = String(vscode.getState()?.selectedAgentSessionTodoId || '');
const agentSessionNodePositions = {...(vscode.getState()?.agentSessionNodePositions || {})};
const agentSessionGraphViewport = {...(vscode.getState()?.agentSessionGraphViewport || {})};
const agentSessionOpenRunIds = new Set(vscode.getState()?.agentSessionOpenRunIds || []);
let projectTreeCollapsed = !!vscode.getState()?.projectTreeCollapsed;
let agentDashboardStep = 'implement';
let agentTechExpanded = { root:true, implement:false };
let recipeSearchQuery = '';
let selectedRecipeId = '';
let recipeEditorMode = 'graph';
let recipeDraft = null;
let recipeDraftRecipeId = '';
let recipeDraftBaseline = '';
let recipeDraftBaselinePending = false;
let recipeGraphResizeObserver = null;
let agentSessionGraphResizeObserver = null;
let recipeGraphZoom = 1;
let recipePendingViewState = null;
let recipeTreeWidth = 280;
let recipeTreeCollapsed = !!vscode.getState()?.recipeTreeCollapsed;
let recipeValidationStatus = '';
let recipeDesignTab = 'intent';
let recipeParameterSnapshot = null;
let recipeReferencePickerNodeId = '';
let recipeGraphSelectedEdge = null;
const recipeGraphSelectedNodes = new Set();
const recipeGraphSelectedEdges = new Set();
const recipeGraphPendingNodeIds = new Set();
const recipeGraphUndoStack = [];
const recipeGraphRedoStack = [];
let recipeGraphClipboard = null;
let recipeGraphApplyingHistory = false;
const recipeReferenceSelectedKeys = new Set();
let recipeGraphKeyboardBound = false;
let recipeEnvironmentListRequested = false;
let recipeSubscriptionGroups = [];
let recipeSubscriptionGroupsRequested = false;
let agentSessionRefreshRequestedAt = 0;
const recipeGraphBoundaryOffset = 84;
const recipeGraphColumnPitch = 258;
const recipeGraphRowPitch = 114;
const recipeGraphExpandedNodes = new Set();
const recipeModuleTemplates = RecipeGraph.moduleTemplates;

const todoExecutionPreview = [{
  executionId:'todoexec_dashboard', projectName:'Personal Knowledge Manager', task:'Implement Automation workspace',
  recipe:'Build Agent Session Dashboard', recipeRevision:3,
  agent:{ id:'agent_copilot', name:'Copilot Agent', product:'GitHub Copilot', state:'Running', elapsed:'6m 14s' },
  todos:[
    { id:'understand', title:'Understand request', status:'succeeded' },
    { id:'plan', title:'Plan changes', status:'succeeded' },
    { id:'implement', title:'Implement dashboard', status:'running' },
    { id:'validate', title:'Validate behavior', status:'available' },
    { id:'report', title:'Report outcome', status:'locked' },
    { id:'release', title:'Release change', status:'locked' }
  ]
}];

function todoExecutionSummary(execution) {
  const total = execution.todos.length;
  const completed = execution.todos.filter(todo => todo.status === 'succeeded').length;
  const current = execution.todos.find(todo => todo.status === 'running') || execution.todos.find(todo => todo.status === 'available');
  return { total, completed, remaining:total - completed, current, percent:total ? Math.round(completed * 100 / total) : 0 };
}

function projectTodoExecutions(project) {
  return todoExecutionPreview.filter(execution => execution.projectId ? execution.projectId === project.projectId : execution.projectName === project.name);
}

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
  const normalizedSection = requestedSection === 'Workflows' ? 'Todos' : requestedSection;
  const normalizedWorkflowView = requestedWorkflowView === 'Runs' ? 'Todos' : requestedWorkflowView;
  projectRoute = {
    projectId:selected?.projectId || '',
    section:matched && projectSections.includes(normalizedSection) ? normalizedSection : 'Overview',
    workflowView:matched && ['Recipes','Todos'].includes(normalizedWorkflowView) ? normalizedWorkflowView : 'Todos'
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
  const normalized = section === 'Workflows' ? 'Todos' : section;
  projectRoute.section = projectSections.includes(normalized) ? normalized : 'Overview';
  normalizeProjectRoute(projectSnapshot);
  renderProjects();
}

function projectWorkflowView(view) {
  projectRoute.workflowView = view === 'Recipes' ? 'Recipes' : 'Todos';
  normalizeProjectRoute(projectSnapshot);
  renderProjects();
}

function renderTodoExecutionScope() {
  if (state.tab === 'projects') renderProjects();
  else renderAgentSessions();
}

function agentSessionSetActive(enabled) {
  if (enabled && (!projectSnapshot || projectSnapshotDirty)) ask('projectState', {});
}

setInterval(() => {
  if (document.visibilityState !== 'visible' || state.tab !== 'agentSessions') return;
  const now = Date.now();
  if (agentSessionRefreshRequestedAt && now - agentSessionRefreshRequestedAt < 10_000) return;
  agentSessionRefreshRequestedAt = now;
  ask('projectState', {}, null, true);
}, 3_000);

function agentSessionGroupToggle(group, open) {
  if (group === 'archive') agentSessionArchiveExpanded = !!open;
  const persisted = vscode.getState() || {};
  vscode.setState({ ...persisted, agentSessionArchiveExpanded });
}

function agentSessionSelect(sessionId) {
  selectedAgentSessionId = String(sessionId || '');
  renderAgentSessions();
}

function agentSessionPersistGraphView() {
  const persisted = vscode.getState() || {};
  vscode.setState({
    ...persisted,
    agentSessionFullscreenRunId,
    agentSessionGraphZoom,
    selectedAgentSessionTodoId,
    agentSessionNodePositions,
    agentSessionGraphViewport,
    agentSessionOpenRunIds:[...agentSessionOpenRunIds]
  });
}

function agentSessionSelectTodo(todoId) {
  selectedAgentSessionTodoId = selectedAgentSessionTodoId === todoId ? '' : String(todoId || '');
  agentSessionPersistGraphView();
  document.querySelectorAll('.agent-session-task[data-todo-id]').forEach(task => task.classList.toggle('selected', task.dataset.todoId === selectedAgentSessionTodoId));
  document.querySelectorAll('.agent-runtime-node[data-todo-id]').forEach(node => node.classList.toggle('todo-selected', node.dataset.todoId === selectedAgentSessionTodoId));
}

function agentSessionRunToggle(details) {
  const runId = String(details?.dataset?.runId || '');
  if (!runId) return;
  if (details.open) agentSessionOpenRunIds.add(runId); else agentSessionOpenRunIds.delete(runId);
  agentSessionPersistGraphView();
  agentSessionLayoutLinks();
}

function agentSessionOpenGraph() {
  agentSessionFullscreenRunId = String(selectedAgentSessionId || '');
  agentSessionGraphZoom = 1;
  agentSessionPersistGraphView();
  renderAgentSessions();
}

function agentSessionCloseGraph() {
  agentSessionFullscreenRunId = '';
  agentSessionPersistGraphView();
  renderAgentSessions();
}

function agentSessionGraphZoomSet(value) {
  agentSessionGraphZoom = Math.max(.45, Math.min(1.8, Number(value) || 1));
  const canvas = document.querySelector('.agent-session-fullscreen .agent-session-graph-canvas');
  if (canvas) canvas.style.setProperty('--agent-session-graph-zoom', agentSessionGraphZoom);
  document.querySelectorAll('[data-agent-session-zoom]').forEach(label => { label.textContent = `${Math.round(agentSessionGraphZoom * 100)}%`; });
  agentSessionPersistGraphView();
  agentSessionLayoutLinks();
}

function agentSessionGraphPanStart(event) {
  if (event.button !== 0 || event.target.closest('button,.agent-runtime-node,summary')) return;
  const stage = event.currentTarget;
  const start = { x:event.clientX, y:event.clientY, left:stage.scrollLeft, top:stage.scrollTop };
  stage.setPointerCapture?.(event.pointerId);
  stage.classList.add('panning');
  stage.onpointermove = move => {
    stage.scrollLeft = start.left - (move.clientX - start.x);
    stage.scrollTop = start.top - (move.clientY - start.y);
  };
  stage.onpointerup = () => {
    stage.classList.remove('panning'); stage.onpointermove = null; stage.onpointerup = null;
    agentSessionGraphRememberViewport(stage);
  };
}

function agentSessionGraphRememberViewport(stage) {
  if (!agentSessionFullscreenRunId || !stage) return;
  agentSessionGraphViewport[agentSessionFullscreenRunId] = { left:stage.scrollLeft, top:stage.scrollTop };
  agentSessionPersistGraphView();
}

function agentSessionNodeDragStart(event, node) {
  if (!agentSessionFullscreenRunId || event.button !== 0 || event.target.closest('button')) return;
  event.stopPropagation();
  const key = `${node.dataset.runId}:${node.dataset.nodeId}`;
  const current = agentSessionNodePositions[key] || { x:0, y:0 };
  const start = { x:event.clientX, y:event.clientY, left:current.x, top:current.y };
  node.setPointerCapture?.(event.pointerId);
  node.classList.add('dragging');
  node.onpointermove = move => {
    const position = { x:start.left + move.clientX - start.x, y:start.top + move.clientY - start.y };
    agentSessionNodePositions[key] = position;
    node.style.transform = `translate(${position.x}px,${position.y}px)`;
    agentSessionLayoutLinks();
  };
  node.onpointerup = () => {
    node.classList.remove('dragging'); node.onpointermove = null; node.onpointerup = null;
    agentSessionPersistGraphView();
  };
}

function agentSessionGraphReorganize() {
  const session = (projectSnapshot?.agentSessions || []).find(candidate => candidate.sessionId === agentSessionFullscreenRunId);
  const prefixes = new Set((session?.runs || []).map(run => `${run.runId}:`));
  Object.keys(agentSessionNodePositions).filter(key => [...prefixes].some(prefix => key.startsWith(prefix)))
    .forEach(key => delete agentSessionNodePositions[key]);
  agentSessionPersistGraphView();
  renderAgentSessions();
}

function agentSnapshotSelect(snapshotId) {
  selectedAgentSnapshotId = String(snapshotId || '');
  renderAgentSnapshots();
}

function agentSnapshotCreate(button) {
  const sessionId = document.getElementById('agent-snapshot-source')?.value || '';
  if (!sessionId) return;
  ask('agentSnapshotCreate', { sessionId, reason:'manual' }, button);
}

function agentSnapshotOnCreated(data) {
  const snapshot = data?.snapshot;
  if (!snapshot?.snapshotId) return;
  selectedAgentSnapshotId = snapshot.snapshotId;
  agentSnapshotCredential = {
    snapshotId:snapshot.snapshotId,
    recoveryPassphrase:String(data.recoveryPassphrase || ''),
    recoveryPrompt:String(data.recoveryPrompt || ''),
    copied:data.copied !== false,
    rotated:!!data.rotated
  };
  if (state.tab === 'agentSnapshots') renderAgentSnapshots();
}

function agentSnapshotCopy(text, button) {
  navigator.clipboard.writeText(String(text || '')).then(() => {
    if (!button) return;
    const label = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { if (button.isConnected) button.textContent = label; }, 1200);
  });
}

function agentSnapshotDismissCredential() {
  agentSnapshotCredential = null;
  renderAgentSnapshots();
}

function agentSnapshotRotate(snapshotId) {
  pkModal({
    title:'Rotate recovery passphrase?',
    message:'The existing recovery passphrase will stop working immediately. PKM will create and automatically copy a new Recovery Prompt.',
    okLabel:'Rotate and Copy',
    danger:true,
    onOk:()=>ask('agentSnapshotRotate',{snapshotId})
  });
}

function agentSnapshotContextMenu(event, snapshotId) {
  event.preventDefault(); event.stopPropagation();
  const snapshot = (projectSnapshot?.agentSnapshots || []).find(candidate => candidate.snapshotId === snapshotId);
  showPaperMenu(event.clientX, event.clientY, [
    { label:snapshot?.task || snapshotId, header:true },
    recipeCopyPathMenu(snapshot?.magicCode || snapshotId, 'Copy Magic Code'),
    { sep:true },
    { label:'Delete Snapshot…', danger:true, onClick:()=>pkModal({
      title:'Delete Agent Snapshot?',
      message:`${snapshot?.magicCode || snapshotId}\n\nThis permanently deletes the immutable recovery record. Sessions already recovered from it are not affected.`,
      okLabel:'Delete Snapshot', danger:true,
      onOk:()=>ask('agentSnapshotDelete',{snapshotId})
    }) }
  ], 'agent-snapshot-context-menu');
}

function agentSessionContextMenu(event, sessionId, status) {
  event.preventDefault(); event.stopPropagation();
  const session = (projectSnapshot?.agentSessions || []).find(candidate => candidate.sessionId === sessionId);
  const items = [
    { label:session?.task || sessionId, header:true },
    recipeCopyPathMenu(`pkm://agent-sessions/${encodeURIComponent(sessionId)}`),
    recipeCopyPathMenu(sessionId, 'Copy Session ID')
  ];
  if (status === 'running') items.push(
    { sep:true },
    { label:'Stop Session…', danger:true, onClick:()=>pkModal({
      title:'Stop Agent Session?',
      message:`${sessionId}\n\nThis preserves Todos and Recipe evidence but marks unfinished work as stopped, not completed.`,
      okLabel:'Stop Session', danger:true,
      onOk:()=>ask('agentSessionStop',{sessionId})
    }) }
  );
  if (status === 'completed' || status === 'stopped') items.push(
    { sep:true },
    { label:'Move to Trash…', danger:true, onClick:()=>pkModal({
      title:'Move Agent Session to Trash?',
      message:`${sessionId}\n\nThe Session remains recoverable from Agent Sessions Trash.`,
      okLabel:'Move to Trash', danger:true,
      onOk:()=>ask('agentSessionTrash',{action:'move',sessionId})
    }) }
  );
  showPaperMenu(event.clientX, event.clientY, items, 'agent-session-context-menu');
}

function agentSessionRootMenu(event) {
  event.preventDefault(); event.stopPropagation();
  showPaperMenu(event.clientX, event.clientY, [
    { label:'Agent Sessions', header:true },
    recipeCopyPathMenu('pkm://agent-sessions/')
  ], 'agent-session-context-menu');
}

function agentSessionFolderMenu(event, folder) {
  event.preventDefault(); event.stopPropagation();
  const path = String(folder || '').split('/').filter(Boolean);
  showPaperMenu(event.clientX, event.clientY, [
    { label:path.at(-1) || 'Agent Sessions', header:true },
    recipeCopyPathMenu(`pkm://agent-sessions/${path.map(encodeURIComponent).join('/')}/`)
  ], 'agent-session-context-menu');
}

function agentSessionTrashContextMenu(event, sessionId) {
  event.preventDefault(); event.stopPropagation();
  const session = (projectSnapshot?.agentSessionTrash || []).find(candidate => candidate.sessionId === sessionId);
  showPaperMenu(event.clientX, event.clientY, [
    { label:session?.task || 'Trashed Agent Session', header:true },
    { label:'Restore', onClick:()=>ask('agentSessionTrash',{action:'restore',sessionId}) },
    { label:'Delete Permanently…', danger:true, onClick:()=>pkModal({ title:'Permanently delete Agent Session?', message:`${sessionId}\n\nRecipe run evidence is retained. This Session record cannot be recovered.`, okLabel:'Delete Permanently', danger:true, onOk:()=>ask('agentSessionTrash',{action:'delete',sessionId}) }) }
  ], 'agent-session-context-menu');
}

function emptyAgentSessionTrash() {
  const count = projectSnapshot?.agentSessionTrash?.length || 0;
  if (!count) return;
  pkModal({
    title:'Empty Agent Sessions Trash?',
    message:`Permanently delete ${count} trashed Agent Session${count === 1 ? '' : 's'}?\n\nRecipe run evidence is retained, but these Session records cannot be recovered.`,
    okLabel:'Empty Trash',
    danger:true,
    onOk:()=>ask('agentSessionTrash',{action:'empty'})
  });
}

function catTreeTrashToggle(row) {
  const dock = row.closest('.cattree-trash-dock');
  const popover = dock?.querySelector('.knowledge-trash-popover');
  if (!popover) return;
  const open = !popover.classList.toggle('hidden');
  row.classList.toggle('active', open);
  row.setAttribute('aria-expanded', String(open));
}

function catTreeTrashDock(label, count, itemsHtml) {
  return `<div class="cattree-trash-dock"><div class="knowledge-trash-popover hidden">${itemsHtml || '<div class="empty">Trash is empty</div>'}</div><div class="knowledge-trash-dock-row" role="button" tabindex="0" aria-expanded="false" onclick="catTreeTrashToggle(this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();catTreeTrashToggle(this)}"><span><span class="codicon codicon-trash"></span> ${esc(label)}</span><span class="pk-group-count">${count}</span><i><span class="codicon codicon-chevron-up"></span></i></div></div>`;
}

function workspaceCatTreeToggle(area) {
  const persisted = vscode.getState() || {};
  if (area === 'recipes') {
    recipeTreeCollapsed = !recipeTreeCollapsed;
    vscode.setState({ ...persisted, recipeTreeCollapsed });
  } else if (area === 'agentSessions') {
    agentSessionTreeCollapsed = !agentSessionTreeCollapsed;
    vscode.setState({ ...persisted, agentSessionTreeCollapsed });
  } else {
    projectTreeCollapsed = !projectTreeCollapsed;
    vscode.setState({ ...persisted, projectTreeCollapsed });
  }
  const collapsed = area === 'recipes' ? recipeTreeCollapsed : area === 'agentSessions' ? agentSessionTreeCollapsed : projectTreeCollapsed;
  const workspace = document.querySelector(area === 'recipes' ? '.recipe-library-workbench' : area === 'agentSessions' ? '.agent-sessions-workspace' : '.projects-workspace');
  workspace?.classList.toggle('cattree-collapsed', collapsed);
  const button = workspace?.querySelector('.panel-collapse-toggle');
  const label = collapsed ? 'Restore category tree' : 'Minimize category tree';
  button?.setAttribute('title', label);
  button?.setAttribute('aria-label', label);
  const icon = button?.querySelector('.codicon');
  icon?.classList.toggle('codicon-chevron-right', collapsed);
  icon?.classList.toggle('codicon-chevron-left', !collapsed);
}

function workspaceCatTreeDivider(area, collapsed, resize = false) {
  const label = collapsed ? 'Restore category tree' : 'Minimize category tree';
  return `<div class="workspace-cattree-divider ${resize ? 'recipe-library-resizer' : ''}" ${resize ? 'title="Drag to resize category tree" onpointerdown="recipeTreeResizeStart(event)"' : ''}><button class="panel-collapse-toggle" title="${label}" aria-label="${label}" onclick="event.stopPropagation();workspaceCatTreeToggle('${area}')" onpointerdown="event.preventDefault();event.stopPropagation()"><span class="codicon codicon-chevron-${collapsed ? 'right' : 'left'}"></span></button></div>`;
}

function agentDashboardSelectStep(step) {
  agentDashboardStep = ['understand','plan','implement','validate','report','release'].includes(step) ? step : 'implement';
  renderTodoExecutionScope();
}

function agentTechToggle(nodeId) {
  agentTechExpanded[nodeId] = !agentTechExpanded[nodeId];
  renderTodoExecutionScope();
}

function agentTechExpansionMode(mode) {
  if (mode === 'all') agentTechExpanded = { root:true, implement:true };
  else if (mode === 'none') agentTechExpanded = { root:false, implement:false };
  else agentTechExpanded = { root:true, implement:false };
  renderTodoExecutionScope();
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

function projectCreateCollaboration() {
  const threadId = document.getElementById('collaboration-thread')?.value || '';
  const title = document.getElementById('collaboration-title')?.value?.trim() || '';
  const lead = document.getElementById('collaboration-lead')?.value?.trim() || '';
  const owners = (document.getElementById('collaboration-workers')?.value || '').split(',').map(value => value.trim()).filter(Boolean);
  const reviewers = (document.getElementById('collaboration-reviewers')?.value || '').split(',').map(value => value.trim()).filter(Boolean);
  const objective = document.getElementById('collaboration-objective')?.value?.trim() || '';
  const context = document.getElementById('collaboration-context')?.value?.trim() || '';
  const expectedOutput = document.getElementById('collaboration-output')?.value?.trim() || '';
  const artifactType = document.getElementById('collaboration-artifact-type')?.value?.trim() || '';
  const acceptanceCriteria = (document.getElementById('collaboration-criteria')?.value || '').split('\n').map(value => value.trim()).filter(Boolean);
  const ganttTaskId = document.getElementById('collaboration-gantt')?.value || '';
  const deadlineValue = document.getElementById('collaboration-deadline')?.value || '';
  if (!threadId || !title || !lead || owners.length !== 1 || !reviewers.length || !objective || !context || !expectedOutput || !artifactType || !acceptanceCriteria.length) {
    toast('Title, Thread, Lead, one primary Worker, Reviewers, objective, context/version, output, artifact type, and acceptance criteria are required.', 'error');
    return;
  }
  ask('collaborationCreate', {
    collaborationId:`collaboration_${Date.now()}`, projectId:projectRoute.projectId, threadId, title, lead, owners, reviewers,
    expectedResponders:owners, primaryOwner:owners[0], objective, context, expectedOutput, artifactType, acceptanceCriteria,
    decisionRequired:document.getElementById('collaboration-decision-required')?.checked === true,
    ganttTaskId:ganttTaskId || undefined,
    deadlineAt:deadlineValue ? new Date(deadlineValue).toISOString() : undefined,
    at:new Date().toISOString(),
  });
}

function projectCollaborationTransition(collaborationId, action, actorRole, actor) {
  const task = (projectSnapshot?.collaborationTasks || []).find(candidate => candidate.collaborationId === collaborationId);
  if (!task) { toast('Collaboration changed or no longer exists. Refresh and retry.', 'error'); return; }
  const gantt = task.ganttTaskId && projectSnapshot?.ganttTasks?.find(candidate => candidate.taskId === task.ganttTaskId);
  const field = name => document.getElementById(`collaboration-${name}-${collaborationId}`);
  ask('collaborationTransition', {
    collaborationId, expectedVersion:task.version, action, actorRole, actor,
    expectedGanttTaskVersion:gantt?.version, at:new Date().toISOString(),
    resultArtifact:field('result')?.value?.trim() || undefined,
    evidenceSummary:field('evidence')?.value?.trim() || undefined,
    evidenceLinks:(field('links')?.value || '').split('\n').map(value => value.trim()).filter(Boolean),
    decisionResult:field('decision')?.value?.trim() || undefined,
    resolvedResponders:(field('responders')?.value || '').split(',').map(value => value.trim()).filter(Boolean),
    blockedWaitingOn:(field('waiting')?.value || '').split(',').map(value => value.trim()).filter(Boolean),
    completionClaim:field('claim')?.checked === true,
    evidenceMatchesContract:field('mismatch')?.checked !== true,
  });
}

function projectCollaborationActions(task) {
  const button = (action, role, actor, label) => `<button type="button" class="tbtn" aria-label="${esc(label)} for ${esc(task.title)}" onclick="projectCollaborationTransition('${esc(task.collaborationId)}','${action}','${role}','${esc(actor)}')">${esc(label)}</button>`;
  if (task.status === 'assigned') return button('start','Worker',task.owners[0],'Start work');
  if (task.status === 'working') return button('handoff','Worker',task.owners[0],'Hand off for review');
  if (task.status === 'review') return button('reject','Reviewer',task.reviewers[0],'Reject for retry') + button('approve','Reviewer',task.reviewers[0],'Approve');
  if (task.status === 'synthesis') {
    const synthesized = task.history?.at(-1)?.action === 'synthesize';
    return synthesized ? button('complete','Lead',task.lead,'Complete') : button('synthesize','Lead',task.lead,'Record synthesis');
  }
  if (task.status === 'blocked' || task.status === 'timed-out') return button('resume','Lead',task.lead,'Resume work');
  return '';
}

function projectCollaborationBody(project, threads) {
  const tasks = (projectSnapshot?.collaborationTasks || []).filter(task => task.projectId === project.projectId);
  const ganttTasks = (projectSnapshot?.ganttTasks || []).filter(task => task.projectId === project.projectId);
  const create = `<section class="project-band" aria-labelledby="collaboration-create-title"><h3 id="collaboration-create-title">Assign structured collaboration</h3>
    <div class="gantt-editor-grid">
      <label>Task title<input id="collaboration-title" aria-required="true" placeholder="Deliver reviewed result"></label>
      <label>Project Thread<select id="collaboration-thread" aria-required="true">${threads.map(thread => `<option value="${esc(thread.threadId)}">${esc(thread.name)}</option>`).join('')}</select></label>
      <label>Lead<input id="collaboration-lead" aria-required="true" placeholder="Lead name"></label>
      <label>Worker owners<input id="collaboration-workers" aria-required="true" placeholder="Worker A, Worker B"></label>
      <label>Reviewers<input id="collaboration-reviewers" aria-required="true" placeholder="Reviewer"></label>
      <label>Linked Gantt task<select id="collaboration-gantt"><option value="">None</option>${ganttTasks.map(task => `<option value="${esc(task.taskId)}">${esc(task.title)} · v${task.version}</option>`).join('')}</select></label>
      <label>Deadline (optional)<input id="collaboration-deadline" type="datetime-local"></label>
      <label>Objective<input id="collaboration-objective" aria-required="true" placeholder="What must be achieved"></label>
      <label>Context / version<input id="collaboration-context" aria-required="true" placeholder="Baseline, revision, or source context"></label>
      <label>Expected output<input id="collaboration-output" aria-required="true" placeholder="Concrete deliverable"></label>
      <label>Artifact type<input id="collaboration-artifact-type" aria-required="true" placeholder="Patch, report, decision"></label>
      <label>Acceptance criteria<textarea id="collaboration-criteria" aria-required="true" placeholder="One deterministic criterion per line"></textarea></label>
      <label><input id="collaboration-decision-required" type="checkbox"> Decision/result required</label>
    </div><button type="button" class="pk-button primary" onclick="projectCreateCollaboration()">Assign</button>
    <p>Roles and ownership are explicit. Agent Session and Recipe links are shown only when supplied by an actual run.</p></section>`;
  const list = tasks.length ? `<section class="project-band"><h3>Collaboration lifecycle</h3><div class="project-thread-list">${tasks.map(task => {
    const thread = threads.find(candidate => candidate.threadId === task.threadId);
    const last = task.history?.at(-1);
    const links = [task.ganttTaskId && `Gantt ${task.ganttTaskId}`, task.agentSessionId && `Session ${task.agentSessionId}`, task.recipeRunId && `Recipe ${task.recipeRunId}`].filter(Boolean);
    return `<article class="project-thread-card" aria-label="${esc(task.title)} collaboration, ${esc(task.status)}">
      <div><span class="gantt-status ${esc(task.status === 'timed-out' ? 'blocked' : task.status)}">${esc(task.status)}</span><strong>${esc(task.title)}</strong><small>${esc(thread?.name || task.threadId)} · v${task.version} · ${esc(task.phase)}</small></div>
      <p><b>Lead:</b> ${esc(task.lead)} · <b>Primary owner:</b> ${esc(task.primaryOwner || task.owners.join(', '))} · <b>Reviewers:</b> ${esc(task.reviewers.join(', '))}</p>
      <p><b>Objective:</b> ${esc(task.objective || 'missing')} · <b>Context/version:</b> ${esc(task.context || 'missing')}</p>
      <p><b>Expected output:</b> ${esc(task.expectedOutput || 'missing')} · <b>Artifact type:</b> ${esc(task.artifactType || 'missing')}</p>
      <p><b>Acceptance criteria:</b> ${esc(task.acceptanceCriteria?.join('; ') || 'missing')}</p>
      <p><b>Expected responders:</b> ${esc(task.expectedResponders.join(', ') || 'none')} ${task.deadlineAt ? `· <b>Deadline:</b> ${esc(task.deadlineAt)}` : ''}</p>
      <p><b>Convergence:</b> ${esc(task.convergenceState || 'contract-incomplete')} · <b>Evidence:</b> ${esc(task.evidenceSummary || task.evidenceLinks?.join(', ') || 'missing')} · <b>Decision:</b> ${esc(task.decisionResult || (task.decisionRequired ? 'required' : 'not required'))}</p>
      ${task.blockedWaitingOn?.length ? `<p role="alert"><b>Waiting on:</b> ${esc(task.blockedWaitingOn.join(', '))}</p>` : ''}
      ${(task.warnings || []).length ? `<ul role="alert" aria-label="Unresolved convergence warnings">${task.warnings.map(item => `<li><b>${esc(item.code)}</b>: ${esc(item.message)}</li>`).join('')}</ul>` : ''}
      ${links.length ? `<p><b>Links:</b> ${esc(links.join(' · '))}</p>` : ''}
      ${last ? `<p><b>Latest:</b> ${esc(last.actorRole)} ${esc(last.actor)} · ${esc(last.action)} · ${esc(last.at)}</p>` : ''}
      <div class="gantt-editor-grid" aria-label="Convergence evidence for ${esc(task.title)}">
        <label>Result artifact<input id="collaboration-result-${esc(task.collaborationId)}" value="${esc(task.resultArtifact || '')}" placeholder="${esc(task.expectedOutput || 'Required output')}"></label>
        <label>Evidence summary<textarea id="collaboration-evidence-${esc(task.collaborationId)}">${esc(task.evidenceSummary || '')}</textarea></label>
        <label>Evidence links<textarea id="collaboration-links-${esc(task.collaborationId)}">${esc((task.evidenceLinks || []).join('\n'))}</textarea></label>
        <label>Decision / result<input id="collaboration-decision-${esc(task.collaborationId)}" value="${esc(task.decisionResult || '')}"></label>
        <label>Resolved responders<input id="collaboration-responders-${esc(task.collaborationId)}" value="${esc((task.resolvedResponders || []).join(', '))}"></label>
        <label>Blocked / waiting on<input id="collaboration-waiting-${esc(task.collaborationId)}" value="${esc((task.blockedWaitingOn || []).join(', '))}"></label>
        <label><input id="collaboration-mismatch-${esc(task.collaborationId)}" type="checkbox"> Evidence explicitly mismatches contract</label>
        <label><input id="collaboration-claim-${esc(task.collaborationId)}" type="checkbox" ${task.completionClaim ? 'checked' : ''}> Explicit completion claim</label>
      </div>
      <div>${projectCollaborationActions(task)}</div>
      <details><summary>Thread history (${task.history?.length || 0})</summary><ol>${(task.history || []).map(event => `<li>v${event.version} ${esc(event.actorRole)} ${esc(event.actor)} — ${esc(event.action)} <time>${esc(event.at)}</time></li>`).join('')}</ol></details>
    </article>`;
  }).join('')}</div></section>` : projectZero('No structured collaboration','Assign Lead, Worker ownership, and Reviewer responsibility above.');
  return create + list;
}

function projectRenameThread(threadId) {
  const thread = projectSnapshot?.threads?.find(candidate => candidate.threadId === threadId);
  if (!thread || thread.systemKind === 'general-thread') return;
  pkModal({ title:'Rename Thread', message:'Thread identity, Chatroom ownership, and linked work remain unchanged.', input:true,
    inputValue:thread.name, okLabel:'Rename', onOk:name => {
      const normalized = String(name || '').trim();
      if (normalized && normalized !== thread.name) ask('threadRename', { threadId, name:normalized });
    } });
}

function projectNewRecipe(category = '') {
  const global = state.tab === 'recipes';
  pkModal({ title:'New Recipe', message:global ? 'Create a reusable Recipe in the global library.' : 'Create a workflow Recipe in the selected Project.', input:true, okLabel:'Create', onOk:name => {
    if (name.trim()) ask('recipeCreate', { scope:global ? 'global' : 'project', ...(global ? {} : { projectId:projectRoute.projectId }), name:name.trim(), ...(category ? { category } : {}) });
  }});
}

function projectExportRecipes() {
  ask('projectRecipesExport', { projectId:projectRoute.projectId });
}

function recipeSearch(value) {
  recipeSearchQuery = String(value || '');
  const recipes = (projectSnapshot?.recipes || []).filter(recipe => recipe.scope === 'global');
  const tree = document.querySelector('.recipe-library-tree-scroll');
  if (!tree) { renderGlobalRecipes(); return; }
  tree.innerHTML = globalRecipeTree(recipes);
  document.querySelector('.recipe-search-clear')?.classList.toggle('hidden', !recipeSearchQuery);
}

function recipeSearchClear() {
  const input = document.querySelector('.recipe-search input');
  if (input) input.value = '';
  recipeSearch('');
  input?.focus();
}

function recipeSelect(recipeId) {
  selectedRecipeId = String(recipeId || '');
  recipeDraft = null;
  recipeDraftRecipeId = '';
  recipeDraftBaseline = '';
  recipeDraftBaselinePending = false;
  recipeGraphSelectedEdge = null;
  recipeGraphSelectedNodes.clear();
  recipeGraphSelectedEdges.clear();
  recipeGraphPendingNodeIds.clear();
  renderGlobalRecipes();
}

function recipeEnsureDraft(recipe) {
  if (recipeDraft && recipeDraftRecipeId === recipe.recipeId) return recipeDraft;
  recipeDraftRecipeId = recipe.recipeId;
  recipeGraphUndoStack.length = 0;
  recipeGraphRedoStack.length = 0;
  recipeGraphPendingNodeIds.clear();
  recipeDraft = JSON.parse(JSON.stringify({
    name:recipe.name, category:recipe.category || '', description:recipe.description || '',
    methodology:recipe.methodology || null,
    metadata:recipe.metadata || { applicableFunctions:[], solution:'', requiredInputs:[], expectedOutputs:[] },
    editorLayout:recipe.editorLayout || { nodePositions:{} },
    definition:recipe.definition, nodeBindings:recipe.nodeBindings || []
  }));
  const nodes = recipeDraft.definition?.spec?.nodes || [];
  const positions = recipeDraft.editorLayout?.nodePositions || {};
  if (nodes.some(node => !Number.isFinite(positions[node.nodeId]?.x) || !Number.isFinite(positions[node.nodeId]?.y))) {
    recipeDraft.editorLayout = { nodePositions:recipeGraphOrganizedPositions(nodes) };
  }
  recipeDraftBaseline = '';
  recipeDraftBaselinePending = true;

  return recipeDraft;
}

function recipeDraftSignature(draft) {
  return JSON.stringify(draft || null);
}

function recipeDraftChanged() {
  if (!recipeDraft || recipeDraftBaselinePending || !recipeDraftBaseline) return false;
  if (recipeEditorMode !== 'json') return recipeDraftSignature(recipeDraft) !== recipeDraftBaseline;
  const editor = document.getElementById('recipe-definition');
  if (!editor) return recipeDraftSignature(recipeDraft) !== recipeDraftBaseline;
  try {
    const candidate = recipeClone(recipeDraft);
    candidate.definition = JSON.parse(editor.value);
    return recipeDraftSignature(candidate) !== recipeDraftBaseline;
  } catch {
    return true;
  }
}

function recipeRefreshSaveState() {
  if (typeof document.querySelectorAll !== 'function') return;
  document.querySelectorAll('[data-recipe-save]').forEach(button => { button.disabled = !recipeDraftChanged(); });
}

function recipeCancel() {
  if (!selectedRecipeId) return;
  recipeDraft = null;
  recipeDraftRecipeId = '';
  recipeDraftBaseline = '';
  recipeDraftBaselinePending = false;
  recipeValidationStatus = '';
  recipeGraphSelectedEdge = null;
  recipeGraphSelectedNodes.clear();
  recipeGraphSelectedEdges.clear();
  recipeGraphPendingNodeIds.clear();
  recipeGraphExpandedNodes.clear();
  renderGlobalRecipes();
}

function recipeDraftField(field, value) { if (recipeDraft) recipeDraft[field] = String(value || ''); recipeRefreshSaveState(); }
function recipeDraftFunctions(value) { if (recipeDraft) recipeDraft.metadata.applicableFunctions = String(value || '').split(/[,\n]/).map(item => item.trim()).filter(Boolean); recipeRefreshSaveState(); }
function recipeDraftSolution(value) { if (recipeDraft) recipeDraft.metadata.solution = String(value || ''); recipeRefreshSaveState(); }
function recipeDraftMetadataField(collection, index, field, value) {
  if (!recipeDraft?.metadata?.[collection]?.[index]) return;
  recipeDraft.metadata[collection][index][field] = field === 'required' ? !!value : String(value || '');
  recipeRefreshSaveState();
}
function recipeMetadataAdd(collection) {
  recipeDraft.metadata[collection].push({ name:'', description:'', ...(collection === 'requiredInputs' ? { required:true } : {}) });
  recipeRerenderPreservingView();
}
function recipeMetadataRemove(collection, index) {
  recipeDraft.metadata[collection].splice(index, 1);
  recipeRerenderPreservingView();
}

function recipeGraphAddStep() {
  pkModal({ title:'Add Module', message:'Choose a module type, then enter a stable ID.', input:true, options:Object.entries(recipeModuleTemplates).map(([value, template]) => ({ value, label:template.label })), okLabel:'Add', validate:value => {
    const nodeId = String(value || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(nodeId)) return 'Use a stable ID beginning with a letter.';
    if (recipeDraft.definition.spec.nodes.some(node => node.nodeId === nodeId)) return 'That Module ID already exists.';
    return '';
  }, onOk:(value, _text, _checked, selectedType) => {
    recipeGraphRecordHistory();
    const nodeId = String(value || '').trim();
    const template = recipeModuleTemplates[selectedType] || recipeModuleTemplates.single;
    recipeDraft.definition.spec.nodes.push({ nodeId, kind:template.kind, config:JSON.parse(JSON.stringify(template.config)), dependsOn:[], ports:JSON.parse(JSON.stringify(template.ports)), control:JSON.parse(JSON.stringify(template.control)) });
    const index = recipeDraft.definition.spec.nodes.length - 1;
    recipeDraft.editorLayout ||= { nodePositions:{} };
    recipeDraft.editorLayout.nodePositions[nodeId] = recipeGraphDefaultPosition(index);
    recipeGraphPendingNodeIds.add(nodeId);
    recipeGraphSelectedNodes.clear();
    recipeGraphSelectedNodes.add(nodeId);
    recipeRerenderPreservingView();
    const reveal = () => {
      if (typeof document.querySelectorAll !== 'function') return;
      [...document.querySelectorAll('.recipe-graph-node')]
        .find(card => card.dataset.nodeId === nodeId)?.scrollIntoView?.({ block:'nearest', inline:'nearest' });
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal); else reveal();
  }});
}
function recipeGraphRemoveStep(nodeId) {
  recipeGraphDeleteNodes(new Set([nodeId]));
}
function recipeGraphDeleteNodes(requestedIds) {
  const nodes = recipeDraft.definition.spec.nodes;
  if (nodes.length <= 1) return;
  const selectedIds = new Set([...requestedIds].filter(nodeId => nodes.some(node => node.nodeId === nodeId)));
  if (selectedIds.size >= nodes.length) selectedIds.delete(nodes[0].nodeId);
  if (!selectedIds.size) return;
  recipeGraphRecordHistory();
  recipeDraft.definition.spec.nodes = nodes.filter(node => !selectedIds.has(node.nodeId)).map(node => ({ ...node, dependsOn:(node.dependsOn || []).filter(dependency => !selectedIds.has(dependency.from)) }));
  recipeDraft.definition.spec.completion.requiredNodes = recipeDraft.definition.spec.completion.requiredNodes.filter(id => !selectedIds.has(id));
  if (!recipeDraft.definition.spec.completion.requiredNodes.length) recipeDraft.definition.spec.completion.requiredNodes = [recipeDraft.definition.spec.nodes.at(-1).nodeId];
  if (recipeDraft.editorLayout?.nodePositions) for (const nodeId of selectedIds) delete recipeDraft.editorLayout.nodePositions[nodeId];
  for (const nodeId of selectedIds) recipeGraphPendingNodeIds.delete(nodeId);
  recipeGraphSelectedNodes.clear();
  recipeGraphSelectedEdges.clear();
  recipeGraphSelectedEdge = null;
  recipeRerenderPreservingView();
}
function recipeGraphDefaultPosition(index) { return { x:24 + (index % 3) * recipeGraphColumnPitch, y:24 + Math.floor(index / 3) * recipeGraphRowPitch }; }
function recipeGraphOrganizedPositions(nodes) {
  return RecipeGraph.organizedPositions(nodes, { startX:24, startY:24, columnPitch:recipeGraphColumnPitch, rowPitch:recipeGraphRowPitch });
}
function recipeGraphPosition(nodeId, index) {
  recipeDraft.editorLayout ||= { nodePositions:{} };
  return recipeDraft.editorLayout.nodePositions[nodeId] ||= recipeGraphDefaultPosition(index);
}
function recipeGraphMoveStart(event, nodeId, index) {
  if (event.button !== 0 || event.target.closest('button,input,select,.recipe-drag-handle')) return;
  if (event.shiftKey) {
    event.preventDefault();
    if (recipeGraphSelectedNodes.has(nodeId)) recipeGraphSelectedNodes.delete(nodeId); else recipeGraphSelectedNodes.add(nodeId);
    recipeGraphSelectedEdges.clear();
    recipeGraphSelectedEdge = null;
    recipeGraphRefreshSelection();
    return;
  }
  if (!recipeGraphSelectedNodes.has(nodeId)) {
    recipeGraphSelectedNodes.clear();
    recipeGraphSelectedNodes.add(nodeId);
    recipeGraphSelectedEdges.clear();
    recipeGraphSelectedEdge = null;
    recipeGraphRefreshSelection();
  }
  const card = event.currentTarget.closest('.recipe-graph-node');
  const canvas = card?.parentElement;
  if (!card || !canvas) return;
  event.preventDefault();
  const moving = new Map([...recipeGraphSelectedNodes].map(selectedId => {
    const selectedIndex = recipeDraft.definition.spec.nodes.findIndex(node => node.nodeId === selectedId);
    return [selectedId, { ...recipeGraphPosition(selectedId, selectedIndex < 0 ? index : selectedIndex) }];
  }));
  const startX = event.clientX;
  const startY = event.clientY;
  let moved = false;
  let historyRecorded = false;
  const move = moveEvent => {
    if (!historyRecorded) { recipeGraphRecordHistory(); historyRecorded = true; }
    moved = true;
    const deltaX = (moveEvent.clientX - startX) / recipeGraphZoom;
    const deltaY = (moveEvent.clientY - startY) / recipeGraphZoom;
    for (const [selectedId, origin] of moving) {
      const position = { x:Math.max(0, Math.round(origin.x + deltaX)), y:Math.max(0, Math.round(origin.y + deltaY)) };
      recipeDraft.editorLayout.nodePositions[selectedId] = position;
      const selectedCard = canvas.querySelector(`.recipe-graph-node[data-node-id="${CSS.escape(selectedId)}"]`);
      if (selectedCard) { selectedCard.style.left = `${position.x}px`; selectedCard.style.top = `${position.y + recipeGraphBoundaryOffset}px`; }
    }
    recipeGraphMountBoundaries(canvas);
    recipeGraphSizeCanvas(canvas);
    recipeGraphLayoutLinks();
  };
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    if (!moved && recipeGraphSelectedNodes.size > 1) {
      recipeGraphSelectedNodes.clear();
      recipeGraphSelectedNodes.add(nodeId);
      recipeGraphRefreshSelection();
    }
    recipeRefreshSaveState();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop, { once:true });
}
function recipeGraphEdgeKey(sourceId, targetId) { return `${sourceId}\u0000${targetId}`; }
function recipeGraphClone(value) { return JSON.parse(JSON.stringify(value)); }
function recipeGraphHistorySnapshot() {
  return {
    definition:recipeGraphClone(recipeDraft.definition),
    editorLayout:recipeGraphClone(recipeDraft.editorLayout || { nodePositions:{} }),
    pendingNodes:[...recipeGraphPendingNodeIds],
    selectedNodes:[...recipeGraphSelectedNodes],
    selectedEdges:[...recipeGraphSelectedEdges],
    selectedEdge:recipeGraphSelectedEdge ? { ...recipeGraphSelectedEdge } : null
  };
}
function recipeGraphRecordHistory() {
  if (!recipeDraft || recipeGraphApplyingHistory) return;
  recipeGraphUndoStack.push(recipeGraphHistorySnapshot());
  if (recipeGraphUndoStack.length > 50) recipeGraphUndoStack.shift();
  recipeGraphRedoStack.length = 0;
}
function recipeGraphRestoreHistory(snapshot) {
  if (!snapshot || !recipeDraft) return;
  recipeGraphApplyingHistory = true;
  recipeDraft.definition = recipeGraphClone(snapshot.definition);
  recipeDraft.editorLayout = recipeGraphClone(snapshot.editorLayout);
  recipeGraphPendingNodeIds.clear(); snapshot.pendingNodes.forEach(nodeId => recipeGraphPendingNodeIds.add(nodeId));
  recipeGraphSelectedNodes.clear(); snapshot.selectedNodes.forEach(nodeId => recipeGraphSelectedNodes.add(nodeId));
  recipeGraphSelectedEdges.clear(); snapshot.selectedEdges.forEach(key => recipeGraphSelectedEdges.add(key));
  recipeGraphSelectedEdge = snapshot.selectedEdge ? { ...snapshot.selectedEdge } : null;
  renderGlobalRecipes();
  recipeGraphApplyingHistory = false;
}
function recipeGraphUndo() {
  const snapshot = recipeGraphUndoStack.pop();
  if (!snapshot) return;
  recipeGraphRedoStack.push(recipeGraphHistorySnapshot());
  recipeGraphRestoreHistory(snapshot);
}
function recipeGraphRedo() {
  const snapshot = recipeGraphRedoStack.pop();
  if (!snapshot) return;
  recipeGraphUndoStack.push(recipeGraphHistorySnapshot());
  recipeGraphRestoreHistory(snapshot);
}
function recipeGraphCopySelection() {
  const selected = new Set(recipeGraphSelectedNodes);
  if (!selected.size) return false;
  recipeGraphClipboard = {
    nodes:recipeDraft.definition.spec.nodes.filter(node => selected.has(node.nodeId)).map(node => {
      const copy = recipeGraphClone(node);
      copy.dependsOn = (copy.dependsOn || []).filter(dependency => selected.has(dependency.from));
      return copy;
    }),
    positions:Object.fromEntries([...selected].map(nodeId => [nodeId, { ...(recipeDraft.editorLayout?.nodePositions?.[nodeId] || { x:0, y:0 }) }])),
    requiredNodes:(recipeDraft.definition.spec.completion?.requiredNodes || []).filter(nodeId => selected.has(nodeId)),
    pasteCount:0
  };
  return true;
}
function recipeGraphPasteSelection() {
  if (!recipeGraphClipboard?.nodes?.length) return;
  recipeGraphRecordHistory();
  recipeGraphClipboard.pasteCount += 1;
  const existing = new Set(recipeDraft.definition.spec.nodes.map(node => node.nodeId));
  const idMap = new Map();
  for (const node of recipeGraphClipboard.nodes) {
    const base = `${node.nodeId}-copy`;
    let candidate = base;
    let suffix = 2;
    while (existing.has(candidate)) candidate = `${base}-${suffix++}`;
    existing.add(candidate);
    idMap.set(node.nodeId, candidate);
  }
  const offset = 32 * recipeGraphClipboard.pasteCount;
  const copies = recipeGraphClipboard.nodes.map(node => {
    const copy = recipeGraphClone(node);
    copy.nodeId = idMap.get(node.nodeId);
    copy.dependsOn = (copy.dependsOn || []).map(dependency => ({ ...dependency, from:idMap.get(dependency.from) }));
    const sourcePosition = recipeGraphClipboard.positions[node.nodeId] || { x:0, y:0 };
    recipeDraft.editorLayout ||= { nodePositions:{} };
    recipeDraft.editorLayout.nodePositions[copy.nodeId] = { x:sourcePosition.x + offset, y:sourcePosition.y + offset };
    return copy;
  });
  recipeDraft.definition.spec.nodes.push(...copies);
  const required = recipeDraft.definition.spec.completion.requiredNodes ||= [];
  recipeGraphClipboard.requiredNodes.forEach(nodeId => required.push(idMap.get(nodeId)));
  recipeGraphSelectedNodes.clear();
  copies.forEach(node => recipeGraphSelectedNodes.add(node.nodeId));
  recipeGraphSelectedEdges.clear();
  recipeGraphSelectInternalEdges();
  recipeRerenderPreservingView();
}
function recipeGraphRefreshSelection() {
  document.querySelectorAll('.recipe-graph-node').forEach(card => card.classList.toggle('selected', recipeGraphSelectedNodes.has(card.dataset.nodeId)));
  recipeGraphLayoutLinks();
}
function recipeGraphSelectInternalEdges() {
  recipeGraphSelectedEdges.clear();
  for (const node of recipeDraft.definition.spec.nodes) for (const dependency of node.dependsOn || []) {
    if (recipeGraphSelectedNodes.has(dependency.from) && recipeGraphSelectedNodes.has(node.nodeId)) recipeGraphSelectedEdges.add(recipeGraphEdgeKey(dependency.from, node.nodeId));
  }
  recipeGraphSelectedEdge = null;
}
function recipeGraphMarqueeStart(event) {
  if (event.button !== 0 || event.target.closest?.('.recipe-graph-node,.recipe-graph-boundary,.edge-hit,.recipe-edge-inspector')) return;
  if (!event.shiftKey) {
    recipeGraphSelectedNodes.clear();
    recipeGraphSelectedEdges.clear();
    recipeGraphSelectedEdge = null;
    recipeGraphRefreshSelection();
    return;
  }
  const canvas = event.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  const previous = new Set(recipeGraphSelectedNodes);
  const marquee = document.createElement('div');
  marquee.className = 'recipe-selection-marquee';
  canvas.appendChild(marquee);
  event.preventDefault();
  const move = moveEvent => {
    const left = Math.max(rect.left, Math.min(startX, moveEvent.clientX));
    const top = Math.max(rect.top, Math.min(startY, moveEvent.clientY));
    const right = Math.min(rect.right, Math.max(startX, moveEvent.clientX));
    const bottom = Math.min(rect.bottom, Math.max(startY, moveEvent.clientY));
    marquee.style.left = `${left - rect.left}px`; marquee.style.top = `${top - rect.top}px`;
    marquee.style.width = `${Math.max(0, right - left)}px`; marquee.style.height = `${Math.max(0, bottom - top)}px`;
    recipeGraphSelectedNodes.clear();
    previous.forEach(nodeId => recipeGraphSelectedNodes.add(nodeId));
    canvas.querySelectorAll('.recipe-graph-node').forEach(card => {
      const cardRect = card.getBoundingClientRect();
      if (cardRect.left >= left && cardRect.right <= right && cardRect.top >= top && cardRect.bottom <= bottom) recipeGraphSelectedNodes.add(card.dataset.nodeId);
    });
    recipeGraphSelectInternalEdges();
    canvas.querySelectorAll('.recipe-graph-node').forEach(card => card.classList.toggle('selected', recipeGraphSelectedNodes.has(card.dataset.nodeId)));
    recipeGraphLayoutLinks();
  };
  const stop = () => { marquee.remove(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop, { once:true });
}
function recipeGraphDeleteSelection() {
  if (!recipeDraft) return;
  if (recipeGraphSelectedNodes.size) { recipeGraphDeleteNodes(recipeGraphSelectedNodes); return; }
  if (!recipeGraphSelectedEdges.size) return;
  recipeGraphRecordHistory();
  for (const node of recipeDraft.definition.spec.nodes) node.dependsOn = (node.dependsOn || []).filter(dependency => !recipeGraphSelectedEdges.has(recipeGraphEdgeKey(dependency.from, node.nodeId)));
  recipeGraphSelectedEdges.clear();
  recipeGraphSelectedEdge = null;
  renderGlobalRecipes();
}
function recipeGraphBindKeyboard() {
  if (recipeGraphKeyboardBound || !document.addEventListener) return;
  recipeGraphKeyboardBound = true;
  document.addEventListener('keydown', event => {
    if (event.target?.closest?.('input,textarea,select,[contenteditable="true"]') || document.getElementById('pk-modal-bg') || state.tab !== 'recipes' || recipeEditorMode !== 'graph') return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (['Delete','Backspace'].includes(event.key)) {
      if (!recipeGraphSelectedNodes.size && !recipeGraphSelectedEdges.size) return;
      event.preventDefault(); recipeGraphDeleteSelection(); return;
    }
    if (!modifier) return;
    if (key === 'c') {
      if (recipeGraphCopySelection()) event.preventDefault();
    } else if (key === 'x') {
      if (recipeGraphCopySelection()) { event.preventDefault(); recipeGraphDeleteSelection(); }
    } else if (key === 'v') {
      if (recipeGraphClipboard?.nodes?.length) { event.preventDefault(); recipeGraphPasteSelection(); }
    } else if (key === 'z' && !event.shiftKey) {
      if (recipeGraphUndoStack.length) { event.preventDefault(); recipeGraphUndo(); }
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      if (recipeGraphRedoStack.length) { event.preventDefault(); recipeGraphRedo(); }
    }
  });
}
function recipeGraphSizeCanvas(canvas) {
  const cards = [...canvas.querySelectorAll('.recipe-graph-node')];
  const boundaries = [...canvas.querySelectorAll('.recipe-graph-boundary')];
  const height = boundaries.reduce((maximum, boundary) => Math.max(maximum, (parseFloat(boundary.style.top) || 0) + boundary.offsetHeight + 24),
    cards.reduce((maximum, card) => Math.max(maximum, (parseFloat(card.style.top) || 0) + card.offsetHeight + 118), 360));
  const width = boundaries.reduce((maximum, boundary) => Math.max(maximum, (parseFloat(boundary.style.left) || 0) + boundary.offsetWidth + 24),
    cards.reduce((maximum, card) => Math.max(maximum, (parseFloat(card.style.left) || 0) + card.offsetWidth + 34), 720));
  canvas.style.height = `${height}px`;
  canvas.style.width = `${width}px`;
}
function recipeGraphMountBoundaries(canvas) {
  const cards = new Map([...canvas.querySelectorAll('.recipe-graph-node')].map(card => [card.dataset.nodeId, card]));
  if (!cards.size) return;
  const nodes = recipeDraft.definition.spec.nodes;
  const { roots, terminals } = RecipeGraph.topology(nodes, recipeGraphPendingNodeIds);
  const averageCenterX = selected => selected.reduce((sum, node) => {
    const card = cards.get(node.nodeId);
    return sum + (parseFloat(card?.style.left) || 0) + (card?.offsetWidth || 240) / 2;
  }, 0) / Math.max(1, selected.length);
  const maximumBottom = Math.max(124, ...terminals.map(node => {
    const card = cards.get(node.nodeId);
    return (parseFloat(card?.style.top) || 0) + (card?.offsetHeight || 70);
  }));
  const moduleBounds = [...cards.values()].map(card => ({
    x:parseFloat(card.style.left) || 0,
    y:parseFloat(card.style.top) || 0,
    width:card.offsetWidth || 240,
    height:card.offsetHeight || 70
  }));
  recipeDraft.editorLayout ||= { nodePositions:{} };
  recipeDraft.editorLayout.boundaryPositions ||= {};
  const saved = recipeDraft.editorLayout.boundaryPositions;
  const sourceFallback = { x:Math.max(12, averageCenterX(roots) - 38), y:12 };
  const sinkFallback = { x:Math.max(12, averageCenterX(terminals) - 38), y:maximumBottom + 42 };
  const sourcePosition = RecipeGraph.constrainBoundary('input', saved.input, moduleBounds, sourceFallback, { boundaryHeight:36, gap:24, minimumX:12 });
  const sinkPosition = RecipeGraph.constrainBoundary('output', saved.output, moduleBounds, sinkFallback, { boundaryHeight:36, gap:42, minimumX:12 });
  let source = canvas.querySelector('[data-graph-boundary="source"]');
  if (!source) {
    source = document.createElement('div');
    source.className = 'recipe-graph-boundary source';
    source.dataset.graphBoundary = 'source';
    source.innerHTML = '<span class="codicon codicon-debug-start"></span><strong>Input</strong>';
    canvas.appendChild(source);
  }
  source.style.left = `${sourcePosition.x}px`;
  source.style.top = `${sourcePosition.y}px`;
  source.onpointerdown = event => recipeGraphBoundaryMoveStart(event, 'input');
  let sink = canvas.querySelector('[data-graph-boundary="sink"]');
  if (!sink) {
    sink = document.createElement('div');
    sink.className = 'recipe-graph-boundary sink';
    sink.dataset.graphBoundary = 'sink';
    sink.innerHTML = '<strong>Output</strong><span class="codicon codicon-debug-stop"></span>';
    canvas.appendChild(sink);
  }
  sink.style.left = `${sinkPosition.x}px`;
  sink.style.top = `${sinkPosition.y}px`;
  sink.onpointerdown = event => recipeGraphBoundaryMoveStart(event, 'output');
}
function recipeGraphBoundaryMoveStart(event, kind) {
  if (event.button !== 0 || !recipeDraft) return;
  const boundary = event.currentTarget;
  const canvas = boundary.parentElement;
  const start = { x:parseFloat(boundary.style.left) || 0, y:parseFloat(boundary.style.top) || 0 };
  const pointer = { x:event.clientX, y:event.clientY };
  event.preventDefault();
  event.stopPropagation();
  boundary.setPointerCapture?.(event.pointerId);
  const move = moveEvent => {
    recipeDraft.editorLayout ||= { nodePositions:{} };
    recipeDraft.editorLayout.boundaryPositions ||= {};
    recipeDraft.editorLayout.boundaryPositions[kind] = {
      x:start.x + (moveEvent.clientX - pointer.x) / recipeGraphZoom,
      y:start.y + (moveEvent.clientY - pointer.y) / recipeGraphZoom
    };
    recipeGraphMountBoundaries(canvas);
    recipeGraphSizeCanvas(canvas);
    recipeGraphLayoutLinks();
  };
  const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); recipeRefreshSaveState(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop, { once:true });
}
function recipeGraphToggleDetails(nodeId) {
  const viewState = recipeCaptureViewState();
  if (recipeGraphExpandedNodes.has(nodeId)) { recipeGraphCloseDetails(); return; }
  recipeParameterRestoreSnapshot();
  recipeGraphExpandedNodes.clear();
  recipeGraphExpandedNodes.add(nodeId);
  recipeDesignTab = 'intent';
  recipeParameterBegin(nodeId);
  renderGlobalRecipes();
  recipeRestoreViewState(viewState);
}
function recipeGraphCloseDetails() {
  const viewState = recipeCaptureViewState();
  recipeParameterRestoreSnapshot();
  recipeParameterSnapshot = null;
  recipeReferencePickerNodeId = '';
  recipeReferenceSelectedKeys.clear();
  recipeGraphExpandedNodes.clear();
  renderGlobalRecipes();
  recipeRestoreViewState(viewState);
}
function recipeClone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function recipeParameterBegin(nodeId) {
  const node = recipeDraft?.definition?.spec?.nodes?.find(candidate => candidate.nodeId === nodeId);
  if (!node) return;
  recipeParameterSnapshot = {
    nodeId,
    config:recipeClone(node.config), ports:recipeClone(node.ports), control:recipeClone(node.control),
    completionRequired:(recipeDraft.definition.spec.completion?.requiredNodes || []).includes(nodeId)
  };
}
function recipeParameterRestoreSnapshot() {
  if (!recipeParameterSnapshot || !recipeDraft) return;
  const snapshot = recipeParameterSnapshot;
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === snapshot.nodeId);
  if (!node) return;
  for (const field of ['config','ports','control']) {
    if (snapshot[field] === undefined) delete node[field]; else node[field] = recipeClone(snapshot[field]);
  }
  recipeDraft.definition.spec.completion ||= { requiredNodes:[] };
  const required = new Set(recipeDraft.definition.spec.completion.requiredNodes || []);
  if (snapshot.completionRequired) required.add(snapshot.nodeId); else required.delete(snapshot.nodeId);
  recipeDraft.definition.spec.completion.requiredNodes = [...required];
}
function recipeParameterSave() {
  const viewState = recipeCaptureViewState();
  recipeParameterSnapshot = null;
  recipeReferencePickerNodeId = '';
  recipeReferenceSelectedKeys.clear();
  recipeGraphExpandedNodes.clear();
  renderGlobalRecipes();
  recipeRestoreViewState(viewState);
}
function recipeParameterCancel() {
  const viewState = recipeCaptureViewState();
  recipeParameterRestoreSnapshot();
  recipeParameterSnapshot = null;
  recipeReferencePickerNodeId = '';
  recipeReferenceSelectedKeys.clear();
  recipeGraphExpandedNodes.clear();
  renderGlobalRecipes();
  recipeRestoreViewState(viewState);
}
function recipeGraphAdapterConfigHtml(node) {
  if (node.kind === 'pkm.step.command/v1') return `<div class="recipe-adapter-config"><label><span>Program</span><input value="${esc(node.config.program || '')}" placeholder="python3" onblur="recipeGraphCommandField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'program',this.value)"></label><label><span>Arguments · one per line</span><textarea rows="4" placeholder="script.py&#10;\${inputs.runId}" onblur="recipeGraphCommandField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'args',this.value)">${esc((node.config.args || []).join('\n'))}</textarea></label><label><span>Working directory</span><input value="${esc(node.config.cwd || '')}" placeholder="\${inputs.workspace}" onblur="recipeGraphCommandField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'cwd',this.value)"></label><div><label><span>Timeout seconds</span><input type="number" min="1" max="3600" value="${node.config.timeoutSeconds || 300}" onblur="recipeGraphCommandField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'timeoutSeconds',this.value)"></label><label><span>Output limit bytes</span><input type="number" min="1024" max="1048576" value="${node.config.maxOutputBytes || 65536}" onblur="recipeGraphCommandField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'maxOutputBytes',this.value)"></label></div><small>Arguments are passed directly without a shell. Use \${inputs.name} for Recipe instance parameters.</small></div>`;
  if (node.kind === 'pkm.step.script/v1') {
    const runtime = node.config.runtime || 'bash';
    const environments = typeof envCache === 'undefined' ? [] : envCache;
    const environmentOptions = environments.map(environment => `<option value="${esc(environment.id)}" ${environment.id === node.config.environmentId ? 'selected' : ''}>${esc(environment.name)} · ${esc(environment.python || 'missing interpreter')}</option>`).join('');
    const support = runtime === 'bash' ? 'Bash runs only on Linux and macOS.' : runtime === 'powershell' ? 'Windows PowerShell runs only on Windows.' : 'Python runs with the exact interpreter from the selected PKM Environment.';
    return `<div class="recipe-adapter-config"><label><span>Runtime</span><select onchange="recipeGraphScriptField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'runtime',this.value)"><option value="bash" ${runtime === 'bash' ? 'selected' : ''}>Bash · Linux / macOS</option><option value="powershell" ${runtime === 'powershell' ? 'selected' : ''}>PowerShell · Windows</option><option value="python" ${runtime === 'python' ? 'selected' : ''}>Python · PKM Environment</option></select></label>${runtime === 'python' ? `<label><span>PKM Python Environment</span><select required onchange="recipeGraphScriptField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'environmentId',this.value)"><option value="">Select an Environment…</option>${environmentOptions}</select></label>` : ''}<label><span>Script</span><textarea rows="10" spellcheck="false" placeholder="${runtime === 'python' ? 'print(\"ready\")' : runtime === 'powershell' ? 'Write-Output \"ready\"' : 'set -e'}" onblur="recipeGraphScriptField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'script',this.value)">${esc(node.config.script || '')}</textarea></label><label><span>Working directory</span><input value="${esc(node.config.cwd || '')}" placeholder="\${inputs.workspace}" onblur="recipeGraphScriptField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'cwd',this.value)"></label><div><label><span>Timeout seconds</span><input type="number" min="1" max="3600" value="${node.config.timeoutSeconds || 300}" onblur="recipeGraphScriptField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'timeoutSeconds',this.value)"></label><label><span>Output limit bytes</span><input type="number" min="1024" max="1048576" value="${node.config.maxOutputBytes || 65536}" onblur="recipeGraphScriptField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'maxOutputBytes',this.value)"></label></div><small>${support} Scripts run without a shell wrapper and may use \${inputs.name} parameters.</small></div>`;
  }
  if (node.kind === 'pkm.gate.human/v1') return `<div class="recipe-adapter-config"><label><span>Required prompt</span><textarea rows="3" onblur="recipeGraphHumanField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'prompt',this.value)">${esc(node.config.prompt || '')}</textarea></label><label><span>Response type</span><select onchange="recipeGraphHumanField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'inputKind',this.value)"><option value="approval" ${node.config.inputKind === 'approval' ? 'selected' : ''}>Approval</option><option value="text" ${node.config.inputKind === 'text' ? 'selected' : ''}>Text</option><option value="choice" ${node.config.inputKind === 'choice' ? 'selected' : ''}>Choice</option></select></label>${node.config.inputKind === 'choice' ? `<label><span>Choices</span><input value="${esc((node.config.choices || []).join(', '))}" onblur="recipeGraphHumanField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'choices',this.value)"></label>` : ''}<small>This module cannot be completed by an Agent report; it requires explicit user input.</small></div>`;
  return '';
}
function recipeGraphCollapseDetails(card, node) {
  const header = card.querySelector(':scope > header');
  if (!header) return;
  const details = document.createElement('div');
  details.className = 'recipe-node-details';
  [...card.children].filter(child => child !== header).forEach(child => details.appendChild(child));
  details.querySelector('.recipe-graph-dependencies')?.remove();
  if (!details.querySelector('.recipe-general-instruction')) {
    const instruction = document.createElement('label');
    instruction.className = 'recipe-general-instruction';
    instruction.innerHTML = '<span>Intent & guidance</span><small>Start with a brief purpose; continue with as much reusable guidance as this Module needs.</small><textarea rows="6" required placeholder="Brief: what this Module must accomplish. Add detailed guidance, constraints, and relevant context as needed."></textarea>';
    const textarea = instruction.querySelector('textarea');
    textarea.value = node.generalInstruction || '';
    textarea.onblur = event => recipeGraphGeneralInstruction(node.nodeId, event.target.value);
    details.prepend(instruction);
  }
  const adapterConfig = recipeGraphAdapterConfigHtml(node);
  if (adapterConfig) details.insertAdjacentHTML('afterbegin', adapterConfig);
    const ports = node.ports || { inputs:['dependency'], outputs:['completion'] };
  const control = node.control || { mode:'single' };
  card.classList.add(`mode-${control.mode}`);
  const presentation = RecipeGraph.presentation(node);
  card.classList.add(`kind-${presentation.key}`);
  const heading = header.querySelector('small');
  if (heading) heading.textContent = presentation.label;
  const glyph = document.createElement('span');
  glyph.className = `recipe-node-glyph kind-${presentation.key}`;
  glyph.textContent = presentation.icon;
  glyph.setAttribute('aria-hidden', 'true');
  header.prepend(glyph);
  const summary = document.createElement('div');
  summary.className = 'recipe-node-summary';
  summary.innerHTML = `<div class="recipe-node-edge-ports inputs">${ports.inputs.map(port => `<span title="Input: ${esc(port)}"><i></i>${esc(port)}</span>`).join('')}</div><div class="recipe-node-meta"><span>${esc(control.mode)}</span><span>${(node.dependsOn || []).length ? `${(node.dependsOn || []).length} routed dependencies` : 'Start module'}</span><small>Double-click to edit parameters</small></div><div class="recipe-node-edge-ports outputs">${ports.outputs.map(port => `<span title="Output: ${esc(port)}"><i></i>${esc(port)}</span>`).join('')}</div>`;
  const connector = header.querySelector('.recipe-drag-handle');
  if (connector) {
    const outputPort = summary.querySelector('.recipe-node-edge-ports.outputs span');
    connector.textContent = '';
    outputPort?.prepend(connector);
  }
  card.append(summary, details);
  header.ondblclick = event => {
    if (event.target.closest('button,.recipe-drag-handle')) return;
    event.preventDefault();
    recipeGraphToggleDetails(node.nodeId);
  };
}
function recipeGraphMountDetailsOverlay() {
  document.getElementById('recipe-design-overlay')?.remove();
  const nodeId = [...recipeGraphExpandedNodes][0];
  if (!nodeId) return;
  const card = [...document.querySelectorAll('.recipe-graph-node')].find(candidate => candidate.dataset.nodeId === nodeId);
  const details = card?.querySelector('.recipe-node-details');
  if (!details) return;
  const overlay = document.createElement('div');
  overlay.id = 'recipe-design-overlay';
  overlay.className = 'recipe-design-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `${nodeId} detailed design`);
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === nodeId);
  const mode = node?.control?.mode || 'single';
  overlay.innerHTML = `<section class="recipe-design-surface" onclick="event.stopPropagation()"><header><div><span>Module details</span><h3>${esc(nodeId)}</h3><small>${esc(mode)} Module · ${node?.kind === 'pkm.step.noop/v1' ? 'Workflow Module' : esc(node?.kind || '')}</small></div><button class="recipe-design-close" title="Close detailed design" aria-label="Close detailed design" onclick="recipeGraphCloseDetails()"><span class="codicon codicon-close"></span></button></header><div class="recipe-design-body"></div><footer><span>Changes remain in the Recipe draft until Save.</span><button class="tbtn" onclick="recipeGraphCloseDetails()">Done</button></footer></section>`;
  overlay.onclick = recipeGraphCloseDetails;
  const body = overlay.querySelector('.recipe-design-body');
  const tabs = document.createElement('nav');
  tabs.className = 'recipe-design-tabs';
  tabs.setAttribute('aria-label', 'Module detail sections');
  tabs.innerHTML = ['intent','parameters','references'].map(tab => `<button class="${tab === recipeDesignTab ? 'active' : ''}" data-recipe-design-tab="${tab}" onclick="recipeDesignSelectTab('${tab}')">${tab[0].toUpperCase() + tab.slice(1)}</button>`).join('');
  const intentPanel = document.createElement('section');
  intentPanel.className = 'recipe-design-tab-panel';
  intentPanel.dataset.recipeDesignPanel = 'intent';
  const instruction = details.querySelector('.recipe-general-instruction');
  if (instruction) intentPanel.appendChild(instruction);
  const editorButton = document.createElement('button');
  editorButton.className = 'tbtn recipe-intent-editor-button';
  editorButton.innerHTML = '<span class="codicon codicon-go-to-file"></span> Open in VS Code Editor';
  editorButton.onclick = () => recipeOpenIntentEditor(nodeId);
  intentPanel.appendChild(editorButton);
  const parametersPanel = document.createElement('section');
  parametersPanel.className = 'recipe-design-tab-panel recipe-node-details';
  parametersPanel.dataset.recipeDesignPanel = 'parameters';
  [...details.children].forEach(child => parametersPanel.appendChild(child));
  parametersPanel.insertAdjacentHTML('beforeend', '<div class="recipe-parameter-actions"><button class="tbtn" onclick="recipeParameterCancel()">Cancel</button><button class="tbtn primary" onclick="recipeParameterSave()">Save</button></div>');
  const referencesPanel = document.createElement('section');
  referencesPanel.className = 'recipe-design-tab-panel recipe-design-references';
  referencesPanel.dataset.recipeDesignPanel = 'references';
  referencesPanel.dataset.recipeReferenceNode = nodeId;
  body.append(tabs, intentPanel, parametersPanel, referencesPanel);
  document.body.appendChild(overlay);
  recipeReferenceRender(nodeId);
  recipeDesignSelectTab(recipeDesignTab);
}
function recipeNodeBinding(nodeId, create = false) {
  recipeDraft.nodeBindings ||= [];
  let entry = recipeDraft.nodeBindings.find(candidate => candidate.nodeId === nodeId);
  if (!entry && create) { entry = { nodeId, bindings:[] }; recipeDraft.nodeBindings.push(entry); }
  return entry;
}
function recipeAttribute(value) { return esc(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function recipeReferenceCatalogItem(kind, knowledgeId) {
  const items = kind === 'skill' ? projectSnapshot?.referenceCatalog?.skills : projectSnapshot?.referenceCatalog?.notes;
  return (items || []).find(item => item.id === knowledgeId);
}
function recipeReferencePickerTree(kind, node, path, attachedKeys) {
  const folders = Object.entries(node.folders).sort(([left],[right]) => left.localeCompare(right)).map(([name, child]) => {
    const fullPath = [...path, name];
    return `<details class="sub-tree-folder" open><summary><span class="sub-tree-folder-spacer"></span><span>${esc(name)}</span><small>${fileSelectorTreeItems(child).length}</small></summary><div>${recipeReferencePickerTree(kind, child, fullPath, attachedKeys)}</div></details>`;
  }).join('');
  const leaves = [...node.items].sort((left,right) => left.label.localeCompare(right.label)).map(item => {
    const key = `${kind}:${item.id}`;
    return `<label class="sub-tree-leaf" title="${recipeAttribute([item.cat,item.meta].filter(Boolean).join(' · '))}"><input type="checkbox" ${attachedKeys.has(key) ? 'checked' : ''} onchange="recipeReferencePickerToggle('${kind}','${encodeURIComponent(item.id)}',this.checked)"><span>${esc(item.label)}</span><small>${esc(item.meta || '')}</small></label>`;
  }).join('');
  return folders + leaves;
}
function recipeReferenceRender(nodeId) {
  const panel = document.querySelector(`[data-recipe-reference-node="${nodeId}"]`);
  if (!panel) return;
  const attached = recipeNodeBinding(nodeId)?.bindings || [];
  const attachedKeys = new Set(attached.map(binding => `${binding.kind}:${binding.knowledgeId}`));
  for (const key of [...recipeReferenceSelectedKeys]) if (!attachedKeys.has(key)) recipeReferenceSelectedKeys.delete(key);
  const rows = attached.map(binding => {
    const key = `${binding.kind}:${binding.knowledgeId}`;
    const item = recipeReferenceCatalogItem(binding.kind, binding.knowledgeId);
    return `<tr class="${recipeReferenceSelectedKeys.has(key) ? 'selected' : ''}"><td><input type="checkbox" aria-label="Select ${recipeAttribute(item?.label || binding.knowledgeId)}" ${recipeReferenceSelectedKeys.has(key) ? 'checked' : ''} onchange="recipeReferenceSelect('${recipeAttribute(key)}',this.checked)"></td><td><strong>${esc(item?.label || binding.knowledgeId)}</strong><small>${esc(item?.meta || binding.knowledgeId)}</small></td><td>${binding.kind === 'skill' ? 'Skill' : 'Note'}</td><td><code>${esc(item?.treePath || item?.cat || '')}</code></td><td><select title="How this reference is used" onchange="recipeReferenceUsage('${recipeAttribute(nodeId)}','${recipeAttribute(key)}',this.value)"><option value="reference" ${binding.usage === 'reference' ? 'selected' : ''}>Reference</option><option value="recommended" ${binding.usage === 'recommended' ? 'selected' : ''}>Recommended</option><option value="required" ${binding.usage === 'required' ? 'selected' : ''}>Required</option></select></td></tr>`;
  }).join('');
  const picker = recipeReferencePickerNodeId === nodeId ? `<div class="recipe-reference-picker"><div class="sub-tree-heading"><strong>File Selector</strong><span>Choose Skills or Notes to attach</span></div>${[
    ['skill','Skills',projectSnapshot?.referenceCatalog?.skills || []], ['note','Notes',projectSnapshot?.referenceCatalog?.notes || []]
  ].map(([kind,label,items]) => `<details class="sub-picker" open><summary><strong>${label}</strong><span>${items.length} available</span></summary><div class="sub-picker-items">${recipeReferencePickerTree(kind,fileSelectorCategoryTree(items),[],attachedKeys) || '<span class="sub-empty">No files</span>'}</div></details>`).join('')}</div>` : '';
  panel.innerHTML = `<header><div><strong>References</strong><p>Files attached as reusable context for this module.</p></div><span>${attached.length} attached</span></header>${picker}<div class="recipe-reference-table-wrap"><table class="pk-table recipe-reference-table"><thead><tr><th></th><th>File</th><th>Type</th><th>Folder</th><th>Usage</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="recipe-reference-empty">No references added.</td></tr>'}</tbody></table></div><div class="recipe-reference-actions"><button class="tbtn" onclick="recipeReferenceAddToggle('${recipeAttribute(nodeId)}')"><span class="codicon codicon-add"></span> Add Reference</button><button class="tbtn danger" onclick="recipeReferenceDeleteSelected('${recipeAttribute(nodeId)}')" ${recipeReferenceSelectedKeys.size ? '' : 'disabled'}><span class="codicon codicon-trash"></span> Delete Reference</button></div>`;
}
function recipeReferenceAddToggle(nodeId) {
  recipeReferencePickerNodeId = recipeReferencePickerNodeId === nodeId ? '' : nodeId;
  recipeReferenceRender(nodeId);
}
function recipeReferenceSelect(key, selected) {
  if (selected) recipeReferenceSelectedKeys.add(key); else recipeReferenceSelectedKeys.delete(key);
  const nodeId = document.querySelector('[data-recipe-reference-node]')?.dataset.recipeReferenceNode;
  if (nodeId) recipeReferenceRender(nodeId);
}
function recipeReferenceDeleteSelected(nodeId) {
  const entry = recipeNodeBinding(nodeId);
  if (entry) entry.bindings = entry.bindings.filter(binding => !recipeReferenceSelectedKeys.has(`${binding.kind}:${binding.knowledgeId}`));
  if (entry && !entry.bindings.length) recipeDraft.nodeBindings = recipeDraft.nodeBindings.filter(candidate => candidate.nodeId !== nodeId);
  recipeReferenceSelectedKeys.clear();
  recipeReferenceRender(nodeId);
}
function recipeReferencePickerToggle(kind, encodedKnowledgeId, checked) {
  recipeReferenceToggle(recipeReferencePickerNodeId, kind, decodeURIComponent(encodedKnowledgeId), checked);
}
function recipeReferenceToggle(nodeId, kind, knowledgeId, checked) {
  if (!nodeId) return;
  const entry = recipeNodeBinding(nodeId, checked);
  if (!entry) return;
  const key = `${kind}:${knowledgeId}`;
  entry.bindings = entry.bindings.filter(binding => `${binding.kind}:${binding.knowledgeId}` !== key);
  if (checked) entry.bindings.push({ kind, knowledgeId, usage:'reference' });
  if (!entry.bindings.length) recipeDraft.nodeBindings = recipeDraft.nodeBindings.filter(candidate => candidate.nodeId !== nodeId);
  recipeReferenceRender(nodeId);
}
function recipeReferenceUsage(nodeId, key, usage) {
  const binding = recipeNodeBinding(nodeId)?.bindings.find(candidate => `${candidate.kind}:${candidate.knowledgeId}` === key);
  if (binding) binding.usage = ['required','recommended','reference'].includes(usage) ? usage : 'reference';
}
function recipeDesignSelectTab(tab) {
  recipeDesignTab = ['intent','parameters','references'].includes(tab) ? tab : 'intent';
  document.querySelectorAll('[data-recipe-design-tab]').forEach(button => button.classList.toggle('active', button.dataset.recipeDesignTab === recipeDesignTab));
  document.querySelectorAll('[data-recipe-design-panel]').forEach(panel => { panel.hidden = panel.dataset.recipeDesignPanel !== recipeDesignTab; });
}
function recipeOpenIntentEditor(nodeId) {
  const node = recipeDraft?.definition?.spec?.nodes?.find(candidate => candidate.nodeId === nodeId);
  if (!node || !recipeDraftRecipeId) return;
  ask('recipeEditIntent', { recipeId:recipeDraftRecipeId, nodeId, guidance:node.generalInstruction || '' });
}
function recipeOnIntentEdited(data) {
  if (!recipeDraft || data?.recipeId !== recipeDraftRecipeId) return;
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === data.nodeId);
  if (!node) return;
  node.generalInstruction = String(data.guidance || '');
  recipeDesignTab = 'intent';
  recipeRerenderPreservingView();
}
function recipeGraphReorganize() {
  const nodes = recipeDraft?.definition?.spec?.nodes || [];
  if (!nodes.length) return;
  recipeDraft.editorLayout = { nodePositions:recipeGraphOrganizedPositions(nodes) };
  const canvas = document.querySelector('.recipe-graph-canvas');
  if (!canvas) return;
  canvas.querySelectorAll('.recipe-graph-node').forEach(card => {
    const position = recipeDraft.editorLayout.nodePositions[card.dataset.nodeId];
    if (!position) return;
    card.style.left = `${position.x}px`;
    card.style.top = `${position.y + recipeGraphBoundaryOffset}px`;
  });
  recipeGraphMountBoundaries(canvas);
  recipeGraphSizeCanvas(canvas);
  recipeGraphLayoutLinks();
  recipeRefreshSaveState();
}
function recipeGraphAddToolbarActions() {
  const tools = document.querySelector('.recipe-graph-tools');
  if (!tools || tools.querySelector('[data-recipe-reorganize]')) return;
  const graphHint = tools.closest('.recipe-graph-toolbar')?.querySelector(':scope > div:first-child span');
  if (graphHint) graphHint.textContent = 'Drag a Module output onto another Module input to create a Connection.';
  const definitionHint = document.querySelector('.recipe-definition-header p');
  if (definitionHint) definitionHint.textContent = 'Build executable Modules and Connections.';
  const add = tools.querySelector('[onclick="recipeGraphAddStep()"]');
  if (add) add.innerHTML = '<span class="codicon codicon-add"></span> Add Module';
  const button = document.createElement('button');
  button.className = 'tbtn';
  button.dataset.recipeReorganize = 'true';
  button.title = 'Automatically arrange modules by dependency level';
  button.innerHTML = '<span class="codicon codicon-type-hierarchy"></span> Re-organize';
  button.onclick = recipeGraphReorganize;
  tools.prepend(button);
}
function recipeGraphEnhanceDependencies() {
  if (!recipeDraft) return;
  document.querySelectorAll('.recipe-graph-node').forEach(card => {
    const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === card.dataset.nodeId);
    if (!node) return;
    const presentation = RecipeGraph.presentation(node);
    card.classList.add(`kind-${presentation.key}`);
    card.classList.toggle('recipe-repeat-group', node.control?.mode === 'repeat');
    if (node.control?.mode === 'repeat') {
      card.setAttribute('role', 'group');
      card.setAttribute('aria-label', `${RecipeGraph.terms.repeat} ${RecipeGraph.repeatBadge(node.control)} containing Module ${node.nodeId}`);
    }
    card.querySelectorAll('.recipe-dependency-route').forEach((route, index) => {
      const dependency = node.dependsOn?.[index];
      if (!dependency) return;
      route.insertAdjacentHTML('beforeend', `<label class="recipe-loop-toggle" title="Declare this connection as a terminating while-loop back-edge"><input type="checkbox" ${dependency.loop ? 'checked' : ''}><span>While</span></label>`);
      route.querySelector('.recipe-loop-toggle input').onchange = event => recipeGraphToggleLoop(node.nodeId, dependency.from, event.target.checked);
      if (!dependency.loop) return;
      route.insertAdjacentHTML('afterend', `<div class="recipe-loop-contract"><strong>Break loop</strong><label><span>Exit condition</span><input value="${esc(dependency.loop.termination.condition)}" placeholder="e.g. score >= target"></label><label><span>Max iterations</span><input type="number" min="1" step="1" value="${dependency.loop.termination.maxIterations}"></label></div>`);
      const contract = route.nextElementSibling;
      const inputs = contract?.querySelectorAll('input');
      if (!inputs?.length) return;
      inputs[0].oninput = event => recipeGraphLoopField(node.nodeId, dependency.from, 'condition', event.target.value);
      inputs[1].onchange = event => recipeGraphLoopField(node.nodeId, dependency.from, 'maxIterations', event.target.value);
    });
  });
}
function recipeGraphApplyLayout() {
  const canvas = document.querySelector('.recipe-graph-canvas');
  if (!canvas || !recipeDraft) return;
  canvas.onpointerdown = recipeGraphMarqueeStart;
  recipeGraphBindKeyboard();
  [...canvas.querySelectorAll('.recipe-graph-node')].forEach((card, index) => {
    const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === card.dataset.nodeId);
    if (!node) return;
    recipeGraphCollapseDetails(card, node);
    const position = recipeGraphPosition(card.dataset.nodeId, index);
    card.style.position = 'absolute';
    card.style.left = `${position.x}px`;
    card.style.top = `${position.y + recipeGraphBoundaryOffset}px`;
    card.classList.toggle('selected', recipeGraphSelectedNodes.has(card.dataset.nodeId));
    card.draggable = false;
    const header = card.querySelector('header');
    if (header) { header.title = 'Drag Module to move · Double-click for detailed design'; header.onpointerdown = event => recipeGraphMoveStart(event, card.dataset.nodeId, index); }
    const connector = card.querySelector('.recipe-drag-handle');
    if (connector) { connector.draggable = true; connector.title = 'Drag this Module output onto another Module input to create a Connection'; }
    const remove = card.querySelector('button[title^="Remove Step"]');
    if (remove) { remove.title = 'Remove Module'; remove.setAttribute('aria-label', `Remove Module ${card.dataset.nodeId}`); }
  });
  recipeGraphMountBoundaries(canvas);
  recipeGraphAddToolbarActions();
  recipeGraphMountDetailsOverlay();
  recipeGraphSizeCanvas(canvas);
  if (recipeDraftBaselinePending) {
    recipeDraftBaseline = recipeDraftSignature(recipeDraft);
    recipeDraftBaselinePending = false;
    recipeRefreshSaveState();
  }
}
function recipeGraphDragStart(event, nodeId) { event.dataTransfer.setData('text/plain', nodeId); event.dataTransfer.effectAllowed = 'link'; }
function recipeGraphDragOver(event) { event.preventDefault(); event.dataTransfer.dropEffect = 'link'; event.currentTarget.classList.add('drop-target'); }
function recipeGraphDragLeave(event) { event.currentTarget.classList.remove('drop-target'); }
function recipeGraphDrop(event, targetId) {
  event.preventDefault(); event.currentTarget.classList.remove('drop-target');
  const sourceId = event.dataTransfer.getData('text/plain');
  const target = recipeDraft.definition.spec.nodes.find(node => node.nodeId === targetId);
  const source = recipeDraft.definition.spec.nodes.find(node => node.nodeId === sourceId);
  if (!sourceId || !target || (target.dependsOn || []).some(dependency => dependency.from === sourceId)) return;
  const cycle = recipeGraphCyclePath(sourceId, targetId);
  if (cycle) {
    if (source?.control?.mode !== 'branch') {
      pkModal({ title:'Branch output required', message:'Only an If / Else or Switch branch output can connect to an upstream input to express while-if / if-while.' });
      return;
    }
    pkModal({
      title:'Create loop connection?',
      message:`${sourceId} → ${targetId} closes a cycle (${cycle.join(' → ')}). Confirm to connect this branch output to the upstream input as a bounded while-if / if-while loop.`,
      okLabel:'Create Loop',
      onOk:() => recipeGraphCommitDependency(sourceId, targetId, true)
    });
    return;
  }
  recipeGraphCommitDependency(sourceId, targetId, false);
}
function recipeGraphCyclePath(sourceId, targetId) {
  return RecipeGraph.cyclePath(recipeDraft?.definition?.spec?.nodes || [], sourceId, targetId);
}
function recipeGraphCommitDependency(sourceId, targetId, loop) {
  const target = recipeDraft.definition.spec.nodes.find(node => node.nodeId === targetId);
  const source = recipeDraft.definition.spec.nodes.find(node => node.nodeId === sourceId);
  if (!source || !target) return;
  recipeGraphRecordHistory();
  const sourceOutputs = source?.ports?.outputs || ['completion'];
  const targetInputs = target.ports?.inputs || ['dependency'];
  const outcomes = source?.control?.mode === 'branch' ? source.control.cases : ['succeeded'];
  target.dependsOn = [...(target.dependsOn || []), {
    from:sourceId, accept:[outcomes[0]], required:true,
    fromOutput:sourceOutputs[0], toInput:targetInputs[0],
    ...(loop ? { loop:{ termination:{ condition:'done', maxIterations:100 } } } : {})
  }];
  recipeGraphPendingNodeIds.delete(sourceId);
  recipeGraphPendingNodeIds.delete(targetId);
  recipeGraphSelectedNodes.clear();
  recipeGraphSelectedEdges.clear();
  recipeGraphSelectedEdges.add(recipeGraphEdgeKey(sourceId, targetId));
  recipeGraphSelectedEdge = { sourceId, targetId };
  recipeRerenderPreservingView();
}
function recipeGraphRemoveDependency(nodeId, sourceId) {
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === nodeId);
  if (node?.dependsOn?.some(dependency => dependency.from === sourceId)) recipeGraphRecordHistory();
  if (node) node.dependsOn = (node.dependsOn || []).filter(dependency => dependency.from !== sourceId);
  recipeGraphSelectedEdges.delete(recipeGraphEdgeKey(sourceId, nodeId));
  if (recipeGraphSelectedEdge?.sourceId === sourceId && recipeGraphSelectedEdge?.targetId === nodeId) recipeGraphSelectedEdge = null;
  recipeRerenderPreservingView();
}
function recipeGraphSelectEdge(event, sourceId, targetId) {
  event?.stopPropagation?.();
  if (!sourceId || !targetId) {
    recipeGraphSelectedNodes.clear();
    recipeGraphSelectedEdges.clear();
    recipeGraphSelectedEdge = null;
  } else {
    const key = recipeGraphEdgeKey(sourceId, targetId);
    recipeGraphSelectedNodes.clear();
    if (event?.shiftKey) {
      if (recipeGraphSelectedEdges.has(key)) recipeGraphSelectedEdges.delete(key); else recipeGraphSelectedEdges.add(key);
    } else {
      recipeGraphSelectedEdges.clear();
      recipeGraphSelectedEdges.add(key);
    }
    recipeGraphSelectedEdge = recipeGraphSelectedEdges.size === 1 && recipeGraphSelectedEdges.has(key) ? { sourceId, targetId } : null;
  }
  recipeGraphLayoutLinks();
}
function recipeGraphDeleteSelectedEdge() {
  recipeGraphDeleteSelection();
}
function recipeGraphToggleLoop(nodeId, sourceId, enabled) {
  const dependency = recipeDraft.definition.spec.nodes.find(node => node.nodeId === nodeId)?.dependsOn?.find(candidate => candidate.from === sourceId);
  if (!dependency) return;
  if (enabled) dependency.loop ||= { termination:{ condition:'done', maxIterations:100 } };
  else delete dependency.loop;
  recipeRerenderPreservingView();
}
function recipeGraphLoopField(nodeId, sourceId, field, value) {
  const dependency = recipeDraft.definition.spec.nodes.find(node => node.nodeId === nodeId)?.dependsOn?.find(candidate => candidate.from === sourceId);
  if (!dependency?.loop?.termination) return;
  dependency.loop.termination[field] = field === 'maxIterations' ? Math.max(1, Math.round(Number(value) || 1)) : String(value || '').trim();
}
function recipeGraphCompletion(nodeId, checked) {
  const required = new Set(recipeDraft.definition.spec.completion.requiredNodes || []);
  if (checked) required.add(nodeId); else required.delete(nodeId);
  recipeDraft.definition.spec.completion.requiredNodes = [...required];
}
function recipeGraphIdentifiers(value) {
  return [...new Set(String(value || '').split(/[\s,]+/).map(item => item.trim()).filter(item => /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(item)))];
}
function recipeGraphNodePorts(nodeId, direction, value) {
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === nodeId);
  if (!node || !['inputs','outputs'].includes(direction)) return;
  node.ports ||= { inputs:['dependency'], outputs:['completion'] };
  node.ports[direction] = recipeGraphIdentifiers(value);
  if (node.control?.mode === 'branch' && direction === 'outputs') node.control.cases = [...node.ports.outputs];
}
function recipeGraphGeneralInstruction(nodeId, value) {
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === nodeId);
  if (!node) return;
  const instruction = String(value || '').trim();
  if (instruction) node.generalInstruction = instruction;
  else delete node.generalInstruction;
}
function recipeGraphCommandField(nodeId, field, value) {
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === nodeId);
  if (node?.kind !== 'pkm.step.command/v1') return;
  if (field === 'args') node.config.args = String(value || '').split('\n').map(argument => argument.trim()).filter(Boolean);
  else if (field === 'timeoutSeconds') node.config.timeoutSeconds = Math.min(3600, Math.max(1, Number.parseInt(value, 10) || 300));
  else if (field === 'maxOutputBytes') node.config.maxOutputBytes = Math.min(1048576, Math.max(1024, Number.parseInt(value, 10) || 65536));
  else if (field === 'cwd') {
    const cwd = String(value || '').trim();
    if (cwd) node.config.cwd = cwd; else delete node.config.cwd;
  } else node.config[field] = String(value || '').trim();
}
function recipeGraphScriptField(nodeId, field, value) {
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === nodeId);
  if (node?.kind !== 'pkm.step.script/v1') return;
  if (field === 'runtime') {
    node.config.runtime = ['bash','powershell','python'].includes(value) ? value : 'bash';
    const environments = typeof envCache === 'undefined' ? [] : envCache;
    if (node.config.runtime === 'python') node.config.environmentId ||= environments[0]?.id || '';
    else delete node.config.environmentId;
    recipeRerenderPreservingView();
  } else if (field === 'timeoutSeconds') node.config.timeoutSeconds = Math.min(3600, Math.max(1, Number.parseInt(value, 10) || 300));
  else if (field === 'maxOutputBytes') node.config.maxOutputBytes = Math.min(1048576, Math.max(1024, Number.parseInt(value, 10) || 65536));
  else if (field === 'cwd') {
    const cwd = String(value || '').trim();
    if (cwd) node.config.cwd = cwd; else delete node.config.cwd;
  } else if (field === 'script') node.config.script = String(value || '');
  else node.config[field] = String(value || '').trim();
}
function recipeGraphHumanField(nodeId, field, value) {
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === nodeId);
  if (node?.kind !== 'pkm.gate.human/v1') return;
  if (field === 'inputKind') {
    node.config.inputKind = ['approval','text','choice'].includes(value) ? value : 'approval';
    if (node.config.inputKind === 'choice') node.config.choices ||= ['Option A','Option B']; else delete node.config.choices;
    node.ports.outputs = node.config.inputKind === 'approval' ? ['approved','rejected'] : node.config.inputKind === 'choice' ? [...node.config.choices] : ['response'];
    recipeRerenderPreservingView();
  } else if (field === 'choices') {
    node.config.choices = [...new Set(String(value || '').split(/[\n,]+/).map(choice => choice.trim()).filter(Boolean))];
    node.ports.outputs = [...node.config.choices];
  } else node.config[field] = String(value || '').trim();
}
function recipeGraphControlMode(nodeId, mode) {
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === nodeId);
  if (!node) return;
  node.ports ||= { inputs:['dependency'], outputs:['completion'] };
  if (mode === 'repeat') node.control = { mode:'repeat', count:{ kind:'fixed', value:2 } };
  else if (mode === 'branch') {
    const cases = node.ports.outputs.length > 1 ? node.ports.outputs : ['yes','no'];
    node.ports.outputs = [...cases];
    node.control = { mode:'branch', kind:'if', cases:[...cases] };
  } else node.control = { mode:'single' };
  recipeRerenderPreservingView();
}
function recipeGraphRepeatKind(nodeId, kind) {
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === nodeId);
  if (node?.control?.mode !== 'repeat') return;
  node.control.count = kind === 'dynamic' ? { kind:'dynamic' } : { kind:'fixed', value:2 };
  recipeRerenderPreservingView();
}
function recipeGraphRepeatCount(nodeId, value) {
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === nodeId);
  if (node?.control?.mode === 'repeat' && node.control.count.kind === 'fixed') node.control.count.value = Math.max(1, Number.parseInt(value, 10) || 1);
}
function recipeGraphBranchKind(nodeId, kind) {
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === nodeId);
  if (node?.control?.mode === 'branch') node.control.kind = kind === 'switch' ? 'switch' : 'if';
}
function recipeGraphDependencyField(nodeId, sourceId, field, value) {
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === nodeId);
  const dependency = node?.dependsOn?.find(candidate => candidate.from === sourceId);
  if (!dependency) return;
  if (field === 'accept') dependency.accept = [String(value)];
  else dependency[field] = String(value);
  recipeRerenderPreservingView();
}
function recipeGraphEdgeInspector() {
  document.querySelector('.recipe-edge-inspector')?.remove();
  if (!recipeGraphSelectedEdge) return;
  const { sourceId, targetId } = recipeGraphSelectedEdge;
  const source = recipeDraft.definition.spec.nodes.find(node => node.nodeId === sourceId);
  const target = recipeDraft.definition.spec.nodes.find(node => node.nodeId === targetId);
  const dependency = target?.dependsOn?.find(candidate => candidate.from === sourceId);
  const viewport = document.querySelector('.recipe-graph-viewport');
  if (!source || !target || !dependency || !viewport) { recipeGraphSelectedEdge = null; return; }
  const options = (values, selected) => values.map(value => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(value)}</option>`).join('');
  const outputs = source.ports?.outputs || ['completion'];
  const inputs = target.ports?.inputs || ['dependency'];
  const outcomes = source.control?.mode === 'branch' ? source.control.cases : ['succeeded'];
  const inspector = document.createElement('aside');
  inspector.className = 'recipe-edge-inspector';
  inspector.innerHTML = `<header><span><small>${dependency.loop ? 'Loop connection' : 'Connection'}</small><strong>${esc(sourceId)} → ${esc(targetId)}</strong></span><button title="Delete selected connection" aria-label="Delete selected connection" onclick="recipeGraphDeleteSelectedEdge()"><span class="codicon codicon-trash"></span></button></header><div class="recipe-edge-route"><label><span>Output</span><select onchange="recipeGraphDependencyField(decodeURIComponent('${encodeURIComponent(targetId)}'),decodeURIComponent('${encodeURIComponent(sourceId)}'),'fromOutput',this.value)">${options(outputs, dependency.fromOutput || outputs[0])}</select></label><label><span>Input</span><select onchange="recipeGraphDependencyField(decodeURIComponent('${encodeURIComponent(targetId)}'),decodeURIComponent('${encodeURIComponent(sourceId)}'),'toInput',this.value)">${options(inputs, dependency.toInput || inputs[0])}</select></label><label><span>Outcome</span><select onchange="recipeGraphDependencyField(decodeURIComponent('${encodeURIComponent(targetId)}'),decodeURIComponent('${encodeURIComponent(sourceId)}'),'accept',this.value)">${options(outcomes, dependency.accept?.[0] || outcomes[0])}</select></label></div>${dependency.loop ? `<div class="recipe-edge-loop"><label><span>Exit condition</span><input value="${esc(dependency.loop.termination.condition)}" onchange="recipeGraphLoopField(decodeURIComponent('${encodeURIComponent(targetId)}'),decodeURIComponent('${encodeURIComponent(sourceId)}'),'condition',this.value)"></label><label><span>Max iterations</span><input type="number" min="1" value="${dependency.loop.termination.maxIterations}" onchange="recipeGraphLoopField(decodeURIComponent('${encodeURIComponent(targetId)}'),decodeURIComponent('${encodeURIComponent(sourceId)}'),'maxIterations',this.value)"></label></div>` : ''}`;
  viewport.appendChild(inspector);
}
function recipeGraphZoomSet(value) {
  recipeGraphZoom = Math.min(1.6, Math.max(.55, Number(value) || 1));
  const canvas = document.querySelector('.recipe-graph-canvas');
  if (canvas) canvas.style.setProperty('--recipe-graph-zoom', recipeGraphZoom);
  const label = document.getElementById('recipe-graph-zoom-label');
  if (label) label.textContent = `${Math.round(recipeGraphZoom * 100)}%`;
  recipeGraphLayoutLinks();
}
function recipeTreeResizeStart(event) {
  if (event.target.closest('.panel-collapse-toggle')) return;
  event.preventDefault();
  const workbench = event.currentTarget.parentElement;
  const startX = event.clientX;
  const startWidth = recipeTreeWidth;
  const move = moveEvent => {
    recipeTreeWidth = Math.min(520, Math.max(190, startWidth + moveEvent.clientX - startX));
    workbench.style.setProperty('--recipe-tree-width', `${recipeTreeWidth}px`);
  };
  const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop, { once:true });
}
function recipeGraphNodeHtml(node, index, nodes, completion) {
  const ports = node.ports || { inputs:['dependency'], outputs:['completion'] };
  const control = node.control || { mode:'single' };
  const repeatBadge = control.mode === 'repeat' ? `<span class="recipe-repeat-badge" aria-label="${RecipeGraph.terms.repeat} ${RecipeGraph.repeatBadge(control)}">${RecipeGraph.repeatBadge(control)}</span>` : '';
  const pendingConnection = recipeGraphPendingNodeIds.has(node.nodeId);
  const controls = control.mode === 'repeat'
    ? `<div class="recipe-control-options"><select aria-label="Repeat count mode" onchange="recipeGraphRepeatKind(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),this.value)"><option value="fixed" ${control.count.kind === 'fixed' ? 'selected' : ''}>Fixed K</option><option value="dynamic" ${control.count.kind === 'dynamic' ? 'selected' : ''}>Dynamic ?</option></select>${control.count.kind === 'fixed' ? `<input type="number" min="1" value="${control.count.value}" aria-label="Repeat count" onchange="recipeGraphRepeatCount(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),this.value)">` : '<span>From upstream collection</span>'}</div>`
    : control.mode === 'branch' ? `<div class="recipe-control-options"><select aria-label="Branch kind" onchange="recipeGraphBranchKind(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),this.value)"><option value="if" ${control.kind === 'if' ? 'selected' : ''}>If / Else</option><option value="switch" ${control.kind === 'switch' ? 'selected' : ''}>Switch</option></select><span>${control.cases.length} outcomes</span></div>` : '';
  const dependencies = (node.dependsOn || []).length ? node.dependsOn.map(dependency => {
    const source = nodes.find(candidate => candidate.nodeId === dependency.from);
    const sourceOutputs = source?.ports?.outputs || ['completion'];
    const targetInputs = ports.inputs.length ? ports.inputs : ['dependency'];
    const outcomes = source?.control?.mode === 'branch' ? source.control.cases : ['succeeded'];
    const options = (values, selected) => values.map(value => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(value)}</option>`).join('');
    return `<div class="recipe-dependency-route"><strong>${esc(dependency.from)}</strong><select title="Source output" onchange="recipeGraphDependencyField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),decodeURIComponent('${encodeURIComponent(dependency.from)}'),'fromOutput',this.value)">${options(sourceOutputs, dependency.fromOutput || sourceOutputs[0])}</select><span>→</span><select title="Target input" onchange="recipeGraphDependencyField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),decodeURIComponent('${encodeURIComponent(dependency.from)}'),'toInput',this.value)">${options(targetInputs, dependency.toInput || targetInputs[0])}</select><select title="Outcome" onchange="recipeGraphDependencyField(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),decodeURIComponent('${encodeURIComponent(dependency.from)}'),'accept',this.value)">${options(outcomes, dependency.accept?.[0] || outcomes[0])}</select><button title="Remove dependency" aria-label="Remove dependency from ${esc(dependency.from)}" onclick="recipeGraphRemoveDependency(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),decodeURIComponent('${encodeURIComponent(dependency.from)}'))"><span class="codicon codicon-close"></span></button></div>`;
  }).join('') : '<em>Start node</em>';
  return `<article class="recipe-graph-node ${control.mode === 'branch' ? 'branch' : ''} ${pendingConnection ? 'invalid unconnected' : ''}" data-node-id="${esc(node.nodeId)}" ${pendingConnection ? 'aria-invalid="true" title="Connect this Module before saving"' : ''} draggable="true" ondragstart="recipeGraphDragStart(event,decodeURIComponent('${encodeURIComponent(node.nodeId)}'))" ondragover="recipeGraphDragOver(event)" ondragleave="recipeGraphDragLeave(event)" ondrop="recipeGraphDrop(event,decodeURIComponent('${encodeURIComponent(node.nodeId)}'))"><header><span class="recipe-drag-handle" title="Drag this Step onto another Step">⋮⋮</span><div><small>Step ${index + 1}</small><strong>${esc(node.nodeId)}</strong></div><button class="recipe-icon-button" title="Remove Step" aria-label="Remove ${esc(node.nodeId)}" onclick="recipeGraphRemoveStep(decodeURIComponent('${encodeURIComponent(node.nodeId)}'))" ${nodes.length <= 1 ? 'disabled' : ''}><span class="codicon codicon-trash"></span></button></header><div class="recipe-node-mode"><select aria-label="Execution mode" onchange="recipeGraphControlMode(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),this.value)"><option value="single" ${control.mode === 'single' ? 'selected' : ''}>Single</option><option value="repeat" ${control.mode === 'repeat' ? 'selected' : ''}>Repeat</option><option value="branch" ${control.mode === 'branch' ? 'selected' : ''}>Branch</option></select>${controls}</div><div class="recipe-node-ports"><label><span>Inputs</span><input value="${esc(ports.inputs.join(', '))}" placeholder="input1, input2" onblur="recipeGraphNodePorts(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'inputs',this.value)"></label><label><span>Outputs</span><input value="${esc(ports.outputs.join(', '))}" placeholder="output1, output2" onblur="recipeGraphNodePorts(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'outputs',this.value)"></label></div><div class="recipe-port-chips inputs">${ports.inputs.map(port => `<span>${esc(port)}</span>`).join('')}</div><div class="recipe-port-chips outputs">${ports.outputs.map(port => `<span>${esc(port)}</span>`).join('')}</div><div class="recipe-graph-dependencies"><span>Routes</span>${dependencies}</div><label class="recipe-completion"><input type="checkbox" ${completion.has(node.nodeId) ? 'checked' : ''} onchange="recipeGraphCompletion(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),this.checked)"><span>Required for completion</span></label>${repeatBadge}</article>`;
  return `<article class="recipe-graph-node ${control.mode === 'branch' ? 'branch' : ''}" data-node-id="${esc(node.nodeId)}" draggable="true" ondragstart="recipeGraphDragStart(event,decodeURIComponent('${encodeURIComponent(node.nodeId)}'))" ondragover="recipeGraphDragOver(event)" ondragleave="recipeGraphDragLeave(event)" ondrop="recipeGraphDrop(event,decodeURIComponent('${encodeURIComponent(node.nodeId)}'))"><header><span class="recipe-drag-handle" title="Drag this Step onto another Step">⋮⋮</span><div><small>Step ${index + 1}</small><strong>${esc(node.nodeId)}</strong></div><button class="recipe-icon-button" title="Remove Step" aria-label="Remove ${esc(node.nodeId)}" onclick="recipeGraphRemoveStep(decodeURIComponent('${encodeURIComponent(node.nodeId)}'))" ${nodes.length <= 1 ? 'disabled' : ''}><span class="codicon codicon-trash"></span></button></header><label class="recipe-general-instruction"><span>General instruction</span><textarea rows="4" placeholder="Reusable guidance for this module. A concrete workflow can add task-specific instructions later." onblur="recipeGraphGeneralInstruction(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),this.value)">${esc(node.generalInstruction || '')}</textarea></label><div class="recipe-node-mode"><select aria-label="Execution mode" onchange="recipeGraphControlMode(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),this.value)"><option value="single" ${control.mode === 'single' ? 'selected' : ''}>Single</option><option value="repeat" ${control.mode === 'repeat' ? 'selected' : ''}>Repeat</option><option value="branch" ${control.mode === 'branch' ? 'selected' : ''}>Branch</option></select>${controls}</div><div class="recipe-node-ports"><label><span>Inputs</span><input value="${esc(ports.inputs.join(', '))}" placeholder="input1, input2" onblur="recipeGraphNodePorts(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'inputs',this.value)"></label><label><span>Outputs</span><input value="${esc(ports.outputs.join(', '))}" placeholder="output1, output2" onblur="recipeGraphNodePorts(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'outputs',this.value)"></label></div><div class="recipe-port-chips inputs">${ports.inputs.map(port => `<span>${esc(port)}</span>`).join('')}</div><div class="recipe-port-chips outputs">${ports.outputs.map(port => `<span>${esc(port)}</span>`).join('')}</div><div class="recipe-graph-dependencies"><span>Depends on</span>${dependencies}</div><label class="recipe-completion"><input type="checkbox" ${completion.has(node.nodeId) ? 'checked' : ''} onchange="recipeGraphCompletion(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),this.checked)"><span>Required for Recipe completion</span></label>${repeatBadge}</article>`;
}
function recipeGraphEdgeRoute(startX, startY, endX, endY, outerX) {
  return RecipeGraph.edgeRoute(startX, startY, endX, endY, outerX);
}
function recipeGraphArrowHead(x, y, className = '', elementClass = 'recipe-graph-arrow') {
  return `<i class="${elementClass} ${className}" style="left:${x - 6}px;top:${y - 10}px"></i>`;
}

function recipeGraphLayoutLinks() {
  const canvas = document.querySelector('.recipe-graph-canvas');
  const svg = canvas?.querySelector('.recipe-graph-links');
  if (!canvas || !svg || !recipeDraft) return;
  const canvasRect = canvas.getBoundingClientRect();
  const cards = new Map([...canvas.querySelectorAll('.recipe-graph-node')].map(card => [card.dataset.nodeId, card]));
  const paths = [];
  const arrows = [];
  for (const node of recipeDraft.definition.spec.nodes) {
    const target = cards.get(node.nodeId);
    if (!target) continue;
    const targetRect = target.getBoundingClientRect();
    for (const dependency of node.dependsOn || []) {
      const source = cards.get(dependency.from);
      if (!source) continue;
      const sourceRect = source.getBoundingClientRect();
      const startX = sourceRect.left - canvasRect.left + sourceRect.width / 2;
      const startY = sourceRect.bottom - canvasRect.top;
      const endX = targetRect.left - canvasRect.left + targetRect.width / 2;
      const endY = targetRect.top - canvasRect.top - 8;
      const outerX = Math.max(sourceRect.right, targetRect.right) - canvasRect.left + 32;
      const route = recipeGraphEdgeRoute(startX, startY, endX, endY, outerX);
      const selected = recipeGraphSelectedEdges.has(recipeGraphEdgeKey(dependency.from, node.nodeId));
      const edgeClass = dependency.loop ? 'loop-edge' : '';
      const edgeTitle = dependency.loop ? `${RecipeGraph.terms.loop}: branch output returns to an upstream input (while-if / if-while).` : `${RecipeGraph.terms.connection}: ${dependency.from} to ${node.nodeId}`;
      const selectEdge = `recipeGraphSelectEdge(event,decodeURIComponent('${encodeURIComponent(dependency.from)}'),decodeURIComponent('${encodeURIComponent(node.nodeId)}'))`;
      paths.push(`<path class="edge-hit ${edgeClass}" d="${route}" role="button" tabindex="0" aria-label="${esc(edgeTitle)}" data-tooltip="${esc(edgeTitle)}" onclick="${selectEdge}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${selectEdge}}"><title>${esc(edgeTitle)}</title></path><path class="edge-visible ${edgeClass} ${selected ? 'selected' : ''}" d="${route}"></path>`);
      arrows.push(recipeGraphArrowHead(endX, endY, `${edgeClass} ${selected ? 'selected' : ''}`));
    }
  }
  const sourceBoundary = canvas.querySelector('[data-graph-boundary="source"]');
  const sinkBoundary = canvas.querySelector('[data-graph-boundary="sink"]');
  if (sourceBoundary && sinkBoundary) {
    const { roots, terminals } = RecipeGraph.topology(recipeDraft.definition.spec.nodes, recipeGraphPendingNodeIds);
    const rootIds = new Set(roots.map(node => node.nodeId));
    const terminalIds = new Set(terminals.map(node => node.nodeId));
    const sourceRect = sourceBoundary.getBoundingClientRect();
    const sinkRect = sinkBoundary.getBoundingClientRect();
    const sourcePoint = { x:sourceRect.left - canvasRect.left + sourceRect.width / 2, y:sourceRect.bottom - canvasRect.top };
    const sinkPoint = { x:sinkRect.left - canvasRect.left + sinkRect.width / 2, y:sinkRect.top - canvasRect.top };
    for (const node of recipeDraft.definition.spec.nodes) {
      const card = cards.get(node.nodeId);
      if (!card) continue;
      const rect = card.getBoundingClientRect();
      if (rootIds.has(node.nodeId)) {
        const end = { x:rect.left - canvasRect.left + rect.width / 2, y:rect.top - canvasRect.top - 8 };
        paths.unshift(`<path class="boundary-edge" d="M ${sourcePoint.x} ${sourcePoint.y} C ${sourcePoint.x} ${sourcePoint.y + 20}, ${end.x} ${end.y - 20}, ${end.x} ${end.y}"></path>`);
        arrows.unshift(recipeGraphArrowHead(end.x, end.y));
      }
      if (terminalIds.has(node.nodeId)) {
        const start = { x:rect.left - canvasRect.left + rect.width / 2, y:rect.bottom - canvasRect.top };
        paths.push(`<path class="boundary-edge" d="M ${start.x} ${start.y} C ${start.x} ${start.y + 20}, ${sinkPoint.x} ${sinkPoint.y - 28}, ${sinkPoint.x} ${sinkPoint.y - 8}"></path>`);
        arrows.push(recipeGraphArrowHead(sinkPoint.x, sinkPoint.y - 8));
      }
    }
  }
  svg.setAttribute('viewBox', `0 0 ${canvas.clientWidth} ${canvas.clientHeight}`);
  svg.innerHTML = paths.join('');
  canvas.querySelectorAll('.recipe-graph-arrow').forEach(arrow => arrow.remove());
  canvas.insertAdjacentHTML('beforeend', arrows.join(''));
  recipeGraphEdgeInspector();
}
function recipeEditorModeSet(mode) {
  const error = document.getElementById('recipe-edit-error');
  if (mode === 'graph' && recipeEditorMode === 'json') {
    if (error) error.textContent = 'Validate the JSON before opening it as a Graph.';
    return;
  }
  recipeEditorMode = mode === 'json' ? 'json' : 'graph';
  recipeValidationStatus = '';
  recipeRerenderPreservingView();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(recipeGraphLayoutLinks);
}

function recipeValidateJson(button) {
  const error = document.getElementById('recipe-edit-error');
  try {
    const definition = JSON.parse(document.getElementById('recipe-definition').value);
    if (error) error.textContent = '';
    recipeValidationStatus = '';
    ask('recipeValidateDefinition', { definition }, button);
  } catch (parseError) {
    if (error) error.textContent = `Definition JSON is invalid: ${parseError.message}`;
  }
}

function recipeOnValidation(data) {
  finishAction('recipeValidateDefinition');
  if (!recipeDraft || !data?.definition) return;
  recipeDraft.definition = data.definition;
  recipeEditorMode = 'graph';
  recipeValidationStatus = `Valid Graph · ${Number(data.nodeCount || 0)} modules · ${String(data.executableDigest || '').slice(0,12)}`;
  renderGlobalRecipes();
}

function recipeSave(button) {
  const error = document.getElementById('recipe-edit-error');
  try {
    if (recipeEditorMode === 'json') recipeDraft.definition = JSON.parse(document.getElementById('recipe-definition').value);
    const pending = RecipeGraph.unconnectedNodeIds(recipeDraft.definition.spec.nodes, recipeGraphPendingNodeIds);
    recipeGraphPendingNodeIds.clear();
    pending.forEach(nodeId => recipeGraphPendingNodeIds.add(nodeId));
    if (recipeGraphPendingNodeIds.size) {
      recipeEditorMode = 'graph';
      recipeValidationStatus = '';
      recipeRerenderPreservingView();
      const names = [...recipeGraphPendingNodeIds].join(', ');
      const graphError = document.getElementById('recipe-edit-error');
      if (graphError) graphError.textContent = `Connect highlighted Modules before saving: ${names}`;
      pkModal({
        title:'Incomplete Recipe Graph',
        message:`Connect the highlighted ${recipeGraphPendingNodeIds.size === 1 ? 'Module' : 'Modules'} before saving: ${names}`,
        okLabel:'Review Graph'
      });
      return;
    }
    if (error) error.textContent = '';
    recipePendingViewState = recipeCaptureViewState();
    button?.blur?.();
    ask('recipeUpdate', {
      recipeId:selectedRecipeId,
      name:recipeDraft.name, category:recipeDraft.category, description:recipeDraft.description,
      methodology:recipeDraft.methodology || undefined,
      metadata:recipeDraft.metadata, editorLayout:recipeDraft.editorLayout, definition:recipeDraft.definition,
      nodeBindings:recipeDraft.nodeBindings
    }, button);
  } catch (parseError) {
    if (error) error.textContent = `Definition JSON is invalid: ${parseError.message}`;
  }
}

function recipeCaptureViewState() {
  const editor = document.querySelector('.recipe-library-editor');
  const graph = document.querySelector('.recipe-graph-viewport');
  const tree = document.querySelector('.recipe-library-tree-scroll');
  const workspace = document.querySelector('.global-recipes-workspace');
  const active = document.activeElement;
  const focusable = workspace ? [...workspace.querySelectorAll('input:not([type="hidden"]),textarea,select,button,[tabindex]:not([tabindex="-1"])')] : [];
  const focusIndex = workspace?.contains(active) ? focusable.indexOf(active) : -1;
  return {
    editorTop:editor?.scrollTop || 0, editorLeft:editor?.scrollLeft || 0,
    graphTop:graph?.scrollTop || 0, graphLeft:graph?.scrollLeft || 0,
    treeTop:tree?.scrollTop || 0, treeLeft:tree?.scrollLeft || 0,
    zoom:recipeGraphZoom, focusId:active?.id || '', focusIndex,
    selectionStart:Number.isInteger(active?.selectionStart) ? active.selectionStart : null,
    selectionEnd:Number.isInteger(active?.selectionEnd) ? active.selectionEnd : null,
    selectionDirection:active?.selectionDirection || 'none'
  };
}

function recipeRestoreViewState(viewState) {
  if (!viewState) return;
  recipeGraphZoom = Number(viewState.zoom) || recipeGraphZoom;
  const restore = () => {
    const editor = document.querySelector('.recipe-library-editor');
    const graph = document.querySelector('.recipe-graph-viewport');
    const tree = document.querySelector('.recipe-library-tree-scroll');
    const canvas = document.querySelector('.recipe-graph-canvas');
    if (editor) { editor.scrollTop = viewState.editorTop; editor.scrollLeft = viewState.editorLeft; }
    if (graph) { graph.scrollTop = viewState.graphTop; graph.scrollLeft = viewState.graphLeft; }
    if (tree) { tree.scrollTop = viewState.treeTop; tree.scrollLeft = viewState.treeLeft; }
    if (canvas) canvas.style.setProperty('--recipe-graph-zoom', recipeGraphZoom);
    const zoomLabel = document.getElementById('recipe-graph-zoom-label');
    if (zoomLabel) zoomLabel.textContent = `${Math.round(recipeGraphZoom * 100)}%`;
    const workspace = document.querySelector('.global-recipes-workspace');
    const focusable = workspace ? [...workspace.querySelectorAll('input:not([type="hidden"]),textarea,select,button,[tabindex]:not([tabindex="-1"])')] : [];
    const focusTarget = (viewState.focusId && document.getElementById(viewState.focusId))
      || (viewState.focusIndex >= 0 ? focusable[viewState.focusIndex] : null);
    focusTarget?.focus({ preventScroll:true });
    if (focusTarget && viewState.selectionStart !== null && typeof focusTarget.setSelectionRange === 'function') {
      focusTarget.setSelectionRange(viewState.selectionStart, viewState.selectionEnd, viewState.selectionDirection);
    }
    recipeGraphLayoutLinks();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore); else restore();
}

function recipeRerenderPreservingView() {
  const viewState = recipeCaptureViewState();
  renderGlobalRecipes();
  recipeRestoreViewState(viewState);
}

function projectMoveThread(threadId, destinationProjectId) {
  if (destinationProjectId) ask('threadMove', { threadId, destinationProjectId });
}

function projectOpenThread(threadId) {
  const persisted = vscode.getState() || {};
  vscode.setState({ ...persisted, projectThreadId:threadId });
  ask('threadOpenChatroom', { threadId });
}

function projectGanttEdit(taskId = '') {
  selectedGanttTaskId = String(taskId || '');
  renderProjects();
  document.getElementById('gantt-title')?.focus();
}

function projectGanttCancel() {
  selectedGanttTaskId = '';
  renderProjects();
}

function projectGanttSave(button) {
  const value = id => document.getElementById(id)?.value || '';
  const owners = value('gantt-owners').split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const separator = item.indexOf(':');
    return { name:(separator < 0 ? item : item.slice(0, separator)).trim(), role:(separator < 0 ? '' : item.slice(separator + 1)).trim() };
  });
  const dependencyIds = [...(document.getElementById('gantt-dependencies')?.selectedOptions || [])].map(option => option.value);
  const payload = {
    projectId:projectRoute.projectId, taskId:selectedGanttTaskId || undefined, title:value('gantt-title'),
    threadId:value('gantt-thread'), startDate:value('gantt-start'), endDate:value('gantt-end'),
    status:value('gantt-status'), progress:Number(value('gantt-progress')), owners, dependencyIds
  };
  ask(selectedGanttTaskId ? 'ganttTaskUpdate' : 'ganttTaskCreate', payload, button);
}

function projectGanttDelete(taskId) {
  const task = projectSnapshot?.ganttTasks?.find(candidate => candidate.taskId === taskId);
  if (!task) return;
  pkModal({ title:'Delete Gantt task?', message:`Delete “${task.title}”? Tasks that depend on it must be updated first.`,
    okLabel:'Delete', danger:true, onOk:()=>ask('ganttTaskDelete', { taskId }) });
}

function projectZero(title, detail) {
  return `<div class="project-zero"><strong>${esc(title)}</strong><span>${esc(detail)}</span></div>`;
}

function projectRecipeBody(recipes, emptyDetail) {
  const list = recipes.length ? `<div class="project-recipe-list">${recipes.map(recipe => {
    const stepCount = recipe.definition?.spec?.nodes?.length || 0;
    return `<div class="project-recipe-row"><div><strong>${esc(recipe.name)}</strong><span>Draft · Revision ${recipe.revision} · ${stepCount} ${stepCount === 1 ? 'step' : 'steps'}</span></div><code title="Executable digest">${esc(String(recipe.executableDigest || '').slice(0,12))}</code></div>`;
  }).join('')}</div>` : projectZero('No Recipes',emptyDetail);
  return `<div class="project-workflow-toolbar"><strong>Recipes</strong><span><button class="tbtn" onclick="projectExportRecipes()" ${recipes.length ? '' : 'disabled'} title="Export reproducible JSON bundle">Export</button><button class="tbtn" onclick="projectNewRecipe()">New Recipe</button></span></div>${list}`;
}

function projectTodoBody(project) {
  const executions = projectTodoExecutions(project);
  if (!executions.length) return projectZero('No Todos','Todo executions associated with this Project will appear here, regardless of which Agent owns them.');
  return `<div class="project-todo-list">${executions.map(execution => {
    const summary = todoExecutionSummary(execution);
    return `<article class="project-todo-execution"><header><div><span>Active Todo Execution</span><strong>${esc(execution.task)}</strong><small>${esc(execution.recipe)} · Recipe r${execution.recipeRevision}</small></div><span class="agent-status running">${esc(execution.agent.state)}</span></header>
      <div class="project-todo-facts"><div><span>Agent</span><strong>${esc(execution.agent.name)}</strong><small>${esc(execution.agent.product)}</small></div><div><span>Current Todo</span><strong>${esc(summary.current?.title || 'None')}</strong><small>${summary.completed} complete</small></div><div><span>Remaining</span><strong>${summary.remaining}</strong><small>${summary.total} total Todos</small></div><div><span>Progress</span><strong>${summary.percent}%</strong><div class="agent-progress" aria-label="${summary.completed} of ${summary.total} Todos complete"><i style="width:${summary.percent}%"></i></div></div></div>
      ${todoTechnologyTree(execution, 'project')}
    </article>`;
  }).join('')}</div>`;
}

function recipeCopyPathMenu(value, label = 'Copy Path') {
  return { label, onClick:() => vscode.postMessage({ command:'copyText', text:label === 'Copy Path' ? canonicalPkmPath(value) : value }) };
}

function recipeRootMenu(event) {
  event.preventDefault(); event.stopPropagation();
  showPaperMenu(event.clientX, event.clientY, [
    { label:'Recipe Library', header:true },
    { label:'New Recipe', onClick:() => projectNewRecipe() },
    { label:'New Folder…', onClick:() => recipeCreateFolder('') },
    recipeCopyPathMenu('pkm://recipes/')
  ]);
}

function recipeCreateFolder(parent) {
  const location = parent || 'Recipe Library';
  pkModal({
    title:parent ? 'Create Recipe Subfolder' : 'Create Recipe Folder',
    message:`Create inside “${location}”. Slash-separated names create multiple levels.`,
    input:true,
    okLabel:'Create',
    onOk:name => {
      const normalized = String(name || '').trim();
      if (normalized) ask('recipeFolderCreate', { parent, name:normalized });
    }
  });
}

function recipeFolderMenu(event, category) {
  event.preventDefault(); event.stopPropagation();
  const topLevel = String(category || '').split('/').filter(Boolean)[0];
  const folder = String(category || '').split('/').filter(Boolean).join('/');
  if (!folder || folder === '(uncategorized)') return recipeRootMenu(event);
  const isPrivate = (projectSnapshot?.privateTopLevels || []).includes(topLevel);
  showPaperMenu(event.clientX, event.clientY, [
    { label:`Folder: ${folder}`, header:true },
    { label:'New Recipe Here', onClick:() => projectNewRecipe(folder) },
    { label:'Create Subfolder…', onClick:() => recipeCreateFolder(folder) },
    recipeCopyPathMenu(`pkm://recipes/${folder.split('/').filter(Boolean).map(encodeURIComponent).join('/')}/`),
    { sep:true },
    { label:isPrivate ? 'Set as Public' : 'Set as Private', onClick:() => ask('contentSetPrivacy', { type:'recipes', topLevel, isPrivate:!isPrivate }) },
    { sep:true },
    { label:'Delete Folder…', danger:true, onClick:() => pkModal({
      title:'Delete Recipe Folder?',
      message:`Delete “${folder}”? Its Recipes and subfolders will move to the parent folder. No Recipes will be deleted.`,
      okLabel:'Delete Folder',
      danger:true,
      onOk:() => ask('recipeFolderDelete', { folder })
    }) }
  ]);
}

function recipePersistUpdate(recipe, changes) {
  ask('recipeUpdate', {
    recipeId:recipe.recipeId,
    name:recipe.name,
    category:recipe.category || '',
    description:recipe.description || '',
    methodology:recipe.methodology,
    metadata:recipe.metadata,
    editorLayout:recipe.editorLayout,
    definition:recipe.definition,
    nodeBindings:recipe.nodeBindings || [],
    ...changes
  });
}

function recipeItemMenu(event, recipeId) {
  event.preventDefault(); event.stopPropagation();
  const recipe = (projectSnapshot?.recipes || []).find(candidate => candidate.recipeId === recipeId);
  if (!recipe) return;
  const items = [
    { label:recipe.name, header:true },
    { label:'Open Recipe', onClick:() => recipeSelect(recipe.recipeId) },
    { label:'Rename…', onClick:() => pkModal({ title:'Rename Recipe', message:'Enter a new Recipe name.', input:true, inputValue:recipe.name, okLabel:'Rename', onOk:name => { if (name.trim() && name.trim() !== recipe.name) recipePersistUpdate(recipe, { name:name.trim() }); } }) },
    { label:'Move to Folder…', onClick:() => pkModal({ title:'Move Recipe', message:'Enter a folder path. Leave empty for uncategorized.', input:true, inputValue:recipe.category || '', okLabel:'Move', onOk:category => recipePersistUpdate(recipe, { category:String(category || '').trim() }) }) },
    recipeCopyPathMenu(`pkm://recipes/${[recipe.category, recipe.name].filter(Boolean).flatMap(value => String(value).split('/').filter(Boolean)).map(encodeURIComponent).join('/')}`),
    recipeCopyPathMenu(recipe.recipeId, 'Copy Recipe ID')
  ];
  if (recipe.systemKind !== 'built-in') items.push(
    { sep:true },
    { label:'Move to Trash…', danger:true, onClick:() => pkModal({ title:'Move Recipe to Trash?', message:`Move “${recipe.name}” to Trash? Existing run records are retained.`, okLabel:'Move to Trash', danger:true, onOk:() => ask('recipeTrash', { action:'move', recipeId:recipe.recipeId }) }) }
  );
  showPaperMenu(event.clientX, event.clientY, items);
}

function recipeTrashItemMenu(event, recipeId) {
  event.preventDefault(); event.stopPropagation();
  const recipe = (projectSnapshot?.recipeTrash || []).find(candidate => candidate.recipeId === recipeId);
  if (!recipe) return;
  showPaperMenu(event.clientX, event.clientY, [
    { label:recipe.name, header:true },
    { label:'Restore', onClick:() => ask('recipeTrash', { action:'restore', recipeId }) },
    { label:'Delete Permanently…', danger:true, onClick:() => pkModal({ title:'Permanently delete Recipe?', message:`${recipe.name}\n\nExisting run evidence is retained. This Recipe cannot be recovered.`, okLabel:'Delete Permanently', danger:true, onOk:() => ask('recipeTrash', { action:'delete', recipeId }) }) }
  ]);
}

function globalRecipeTree(recipes) {
  const normalizedQuery = recipeSearchQuery.trim().toLocaleLowerCase();
  const matchedRecipes = normalizedQuery ? recipes.filter(recipe => {
    const nodes = recipe.definition?.spec?.nodes || [];
    const metadata = recipe.metadata || {};
    const methodology = recipe.methodology || {};
    const artifacts = methodology.artifacts || {};
    const communication = methodology.communication || {};
    const retrieval = methodology.retrieval || {};
    const metadataFields = [...(metadata.requiredInputs || []), ...(metadata.expectedOutputs || [])];
    const searchable = [
      recipe.name, recipe.description, recipe.category,
      ...(metadata.applicableFunctions || []), metadata.solution,
      ...metadataFields.flatMap(field => [field.name, field.description]),
      ...nodes.map(node => node.nodeId), ...nodes.map(node => node.kind),
      methodology.family, methodology.phase, ...(methodology.capabilities || []),
      ...(artifacts.inputs || []), ...(artifacts.outputs || []),
      ...(methodology.gates || []), ...(methodology.invariants || []),
      communication.minimumAssurance, ...(communication.escalateOn || []),
      ...(retrieval.intents || []), ...(retrieval.terminology || []), ...(retrieval.operationalPoints || [])
    ].filter(Boolean).join('\n').toLocaleLowerCase();
    return normalizedQuery.split(/\s+/).every(term => searchable.includes(term));
  }) : recipes;
  const matchedFolders = (projectSnapshot?.recipeFolders || []).filter(folder =>
    !normalizedQuery || normalizedQuery.split(/\s+/).every(term => String(folder).toLocaleLowerCase().includes(term)));
  if (!matchedRecipes.length && !matchedFolders.length) return normalizedQuery
    ? `<div class="project-zero"><strong>No matching Recipe</strong><span>No accessible Recipe matches “${esc(recipeSearchQuery.trim())}”. Review the task contract or design a new Recipe.</span><button class="tbtn" onclick="projectNewRecipe()">Design Recipe</button></div>`
    : projectZero('No Recipes','Reusable Recipes available to every Agent Task will appear here.');
  const previousPrivateTopLevels = state.privateTopLevels;
  state.privateTopLevels = projectSnapshot?.privateTopLevels || [];
  const tree = buildCatTree(matchedRecipes, recipe => recipe.category, '(uncategorized)');
  seedFolders(tree, matchedFolders);
  const html = renderCatTree(tree, [], 0, (recipe, depth) => {
    const stepCount = recipe.definition?.spec?.nodes?.length || 0;
    const privateRecipe = privacyInherited(recipe.category || '');
    return `<div class="li cattree-item project-recipe-row ${recipe.recipeId === selectedRecipeId ? 'active' : ''}" style="margin-left:${depth * 12}px" role="button" tabindex="0" onclick="recipeSelect(decodeURIComponent('${encodeURIComponent(recipe.recipeId)}'))" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();recipeSelect(decodeURIComponent('${encodeURIComponent(recipe.recipeId)}'))}" oncontextmenu="recipeItemMenu(event,decodeURIComponent('${encodeURIComponent(recipe.recipeId)}'))"><div><strong>${privacyLock(privateRecipe)}${esc(recipe.name)}</strong><span>${recipe.scope === 'global' ? 'Global' : 'Project'} · Revision ${recipe.revision} · ${stepCount} ${stepCount === 1 ? 'step' : 'steps'} · <code title="Executable digest">${esc(String(recipe.executableDigest || '').slice(0,12))}</code></span></div><button class="cattree-item-menu" title="Recipe actions" aria-label="Actions for ${esc(recipe.name)}" onclick="event.stopPropagation();recipeItemMenu(event,decodeURIComponent('${encodeURIComponent(recipe.recipeId)}'))"><span class="codicon codicon-ellipsis"></span></button></div>`;
  }, '', (_child, name, fullPath) => name !== '(uncategorized)'
    ? ` oncontextmenu="recipeFolderMenu(event,decodeURIComponent('${encodeURIComponent(fullPath.join('/'))}'))"`
    : ` oncontextmenu="recipeRootMenu(event)"`, undefined, { baseIndent:0 });
  state.privateTopLevels = previousPrivateTopLevels;
  return `<div class="project-recipe-tree">${html}</div>`;
}

function recipeMethodologyProjection(recipe) {
  const methodology = recipe.methodology;
  if (!methodology) {
    return `<div class="recipe-methodology-empty"><strong>Legacy execution-only Recipe</strong><span>This Recipe remains fully supported. Add a Methodology Manifest when it needs standardized inheritance, artifacts, gates, communication assurance, or methodology-aware retrieval.</span></div>`;
  }
  const tags = values => (values || []).length
    ? values.map(value => `<code>${esc(value)}</code>`).join('')
    : '<span class="recipe-methodology-none">None</span>';
  const reference = value => value
    ? `<code title="${esc(value.executableDigest || '')}">${esc(value.recipeId)} · r${Number(value.revision || 0)}</code>`
    : '<span class="recipe-methodology-none">Root methodology</span>';
  const mixins = (methodology.mixins || []).length
    ? methodology.mixins.map(value => reference(value)).join('')
    : '<span class="recipe-methodology-none">None</span>';
  return `<div class="recipe-methodology-projections">
    <article><header><span>Pyramid</span><strong>${esc(methodology.family)}</strong></header><dl><div><dt>Phase</dt><dd><code>${esc(methodology.phase)}</code></dd></div><div><dt>Parent</dt><dd>${reference(methodology.extends)}</dd></div><div><dt>Mixins</dt><dd class="recipe-methodology-tags">${mixins}</dd></div><div><dt>Shape</dt><dd>${methodology.abstract ? 'Abstract methodology' : 'Executable specialization'} · ${esc(methodology.expansion?.mode || 'atomic')}</dd></div></dl></article>
    <article><header><span>Composition</span><strong>Capabilities</strong></header><div class="recipe-methodology-tags">${tags(methodology.capabilities)}</div><dl><div><dt>Expansion signals</dt><dd class="recipe-methodology-tags">${tags(methodology.expansion?.signals)}</dd></div><div><dt>Minimum assurance</dt><dd><code>${esc(methodology.communication?.minimumAssurance || 'direct')}</code></dd></div><div><dt>Escalate on</dt><dd class="recipe-methodology-tags">${tags(methodology.communication?.escalateOn)}</dd></div></dl></article>
    <article><header><span>Evidence Contract</span><strong>Artifacts and gates</strong></header><dl><div><dt>Inputs</dt><dd class="recipe-methodology-tags">${tags(methodology.artifacts?.inputs)}</dd></div><div><dt>Outputs</dt><dd class="recipe-methodology-tags">${tags(methodology.artifacts?.outputs)}</dd></div><div><dt>Gates</dt><dd class="recipe-methodology-tags">${tags(methodology.gates)}</dd></div><div><dt>Final invariants</dt><dd class="recipe-methodology-tags">${tags(methodology.invariants)}</dd></div></dl></article>
    <article><header><span>Retrieval</span><strong>Resolution vocabulary</strong></header><dl><div><dt>Intents</dt><dd class="recipe-methodology-tags">${tags(methodology.retrieval?.intents)}</dd></div><div><dt>Terminology</dt><dd class="recipe-methodology-tags">${tags(methodology.retrieval?.terminology)}</dd></div><div><dt>Operational points</dt><dd class="recipe-methodology-tags">${tags(methodology.retrieval?.operationalPoints)}</dd></div></dl></article>
  </div>`;
}

function globalRecipeEditor(recipe) {
  if (!recipe) return `<div class="recipe-editor-empty"><span class="codicon codicon-symbol-method"></span><strong>Select a Recipe</strong><p>Choose a Recipe from the CatTree to inspect or edit its executable definition.</p></div>`;
  const draft = recipeEnsureDraft(recipe);
  const metadataRows = (collection, label, emptyText) => `<section class="recipe-metadata-list"><header><div><strong>${label}</strong><span>${emptyText}</span></div><button class="tbtn" onclick="recipeMetadataAdd('${collection}')"><span class="codicon codicon-add"></span> Add</button></header>${draft.metadata[collection].length ? draft.metadata[collection].map((field, index) => `<div class="recipe-metadata-row"><input value="${esc(field.name)}" placeholder="Name" aria-label="${label} name" oninput="recipeDraftMetadataField('${collection}',${index},'name',this.value)"><input value="${esc(field.description)}" placeholder="Description" aria-label="${label} description" oninput="recipeDraftMetadataField('${collection}',${index},'description',this.value)">${collection === 'requiredInputs' ? `<label title="Required input"><input type="checkbox" ${field.required !== false ? 'checked' : ''} onchange="recipeDraftMetadataField('${collection}',${index},'required',this.checked)"><span>Required</span></label>` : ''}<button class="recipe-icon-button" title="Remove" aria-label="Remove ${label}" onclick="recipeMetadataRemove('${collection}',${index})"><span class="codicon codicon-trash"></span></button></div>`).join('') : `<p class="recipe-list-empty">None defined.</p>`}</section>`;
  const nodes = draft.definition?.spec?.nodes || [];
  const completion = new Set(draft.definition?.spec?.completion?.requiredNodes || []);
  const graph = `<div class="recipe-graph-toolbar"><div><strong>Definition Graph</strong><span>Drag a Module output onto another Module input to create a Connection.</span></div><div class="recipe-graph-tools" role="toolbar" aria-label="Definition Graph actions"><button class="recipe-icon-button" title="Zoom out" aria-label="Zoom out" onclick="recipeGraphZoomSet(recipeGraphZoom-.1)"><span class="codicon codicon-zoom-out"></span></button><span id="recipe-graph-zoom-label">${Math.round(recipeGraphZoom * 100)}%</span><button class="recipe-icon-button" title="Zoom in" aria-label="Zoom in" onclick="recipeGraphZoomSet(recipeGraphZoom+.1)"><span class="codicon codicon-zoom-in"></span></button><button class="recipe-icon-button" title="Reset zoom" aria-label="Reset zoom" onclick="recipeGraphZoomSet(1)"><span class="codicon codicon-screen-normal"></span></button><button class="tbtn" onclick="recipeGraphAddStep()"><span class="codicon codicon-add"></span> Add Module</button></div></div><div class="recipe-graph-viewport"><div class="recipe-graph-canvas" style="--recipe-graph-zoom:${recipeGraphZoom}"><svg class="recipe-graph-links" aria-hidden="true"></svg>${nodes.map((node, index) => recipeGraphNodeHtml(node, index, nodes, completion)).join('')}</div></div><div class="recipe-graph-actions"><button class="tbtn" type="button" onclick="recipeCancel()" title="Discard every unsaved Recipe draft change">Cancel</button><button class="tbtn primary" type="button" data-recipe-save onclick="recipeSave(this)" ${recipeDraftChanged() ? '' : 'disabled'}><span class="codicon codicon-save"></span> Save</button></div>`;
  return `<div class="recipe-editor">
    <header class="recipe-editor-header"><div><span>Global Recipe</span><h3>${esc(recipe.name)}</h3><p>Revision ${recipe.revision} · <code title="Executable digest">${esc(recipe.executableDigest || '')}</code></p></div><div><button class="tbtn recipe-open-browser" data-pending-label="Opening…" onclick="ask('recipeOpenBrowser',{recipeId:selectedRecipeId},this)" title="Open the Recipe workbench in a browser"><span class="codicon codicon-globe"></span> Open in Browser</button></div></header>
    <div class="recipe-editor-form">
      <section class="recipe-editor-section wide"><header><span>Metadata</span><p>Structured retrieval context used to match this Recipe to Agent tasks.</p></header><div class="recipe-metadata-grid">
        <label><span>Name</span><input id="recipe-name" value="${esc(draft.name)}" autocomplete="off" oninput="recipeDraftField('name',this.value)"></label>
        <label><span>Category</span><input id="recipe-category" value="${esc(draft.category)}" placeholder="Automation/Software Development" autocomplete="off" oninput="recipeDraftField('category',this.value)"></label>
        <label class="wide"><span>Description</span><textarea id="recipe-description" rows="3" oninput="recipeDraftField('description',this.value)">${esc(draft.description)}</textarea></label>
        <label class="wide"><span>Applicable functions</span><textarea id="recipe-functions" rows="2" placeholder="One function per line" oninput="recipeDraftFunctions(this.value)">${esc(draft.metadata.applicableFunctions.join('\n'))}</textarea></label>
        <label class="wide"><span>Solution</span><textarea id="recipe-solution" rows="4" placeholder="How this Recipe solves the target problem" oninput="recipeDraftSolution(this.value)">${esc(draft.metadata.solution)}</textarea></label>
        <div class="wide recipe-metadata-lists">${metadataRows('requiredInputs','Required input','What must the Agent provide?')}${metadataRows('expectedOutputs','Expected output','What should this Recipe produce?')}</div>
      </div></section>
      <section class="recipe-editor-section wide"><header><span>Methodology</span><p>Pyramid, composition, evidence, communication, and retrieval projections compiled separately from the execution DAG.</p></header>${recipeMethodologyProjection(draft)}</section>
      <section class="recipe-editor-section wide"><header class="recipe-definition-header"><div><span>Definition</span><p>Build executable Modules and Connections.</p></div><div class="recipe-mode-switch" role="tablist" aria-label="Definition editor mode"><button class="${recipeEditorMode === 'graph' ? 'active' : ''}" role="tab" aria-selected="${recipeEditorMode === 'graph'}" onclick="recipeEditorModeSet('graph')"><span class="codicon codicon-type-hierarchy"></span> Graph</button><button class="${recipeEditorMode === 'json' ? 'active' : ''}" role="tab" aria-selected="${recipeEditorMode === 'json'}" onclick="recipeEditorModeSet('json')"><span class="codicon codicon-code"></span> JSON</button></div></header>${recipeEditorMode === 'graph' ? `${recipeValidationStatus ? `<div class="recipe-validation-status"><span class="codicon codicon-pass-filled"></span>${esc(recipeValidationStatus)}</div>` : ''}${graph}` : `<div class="recipe-json-editor"><label class="definition"><span>Advanced JSON</span><textarea id="recipe-definition" rows="18" spellcheck="false" oninput="recipeRefreshSaveState()">${esc(JSON.stringify(draft.definition, null, 2))}</textarea></label><footer><span>Validation uses the same workflow contract as Save and execution.</span><div class="recipe-json-actions"><button class="tbtn" onclick="recipeValidateJson(this)"><span class="codicon codicon-pass"></span> Validate &amp; Open Graph</button><button class="tbtn primary" data-recipe-save onclick="recipeSave(this)" ${recipeDraftChanged() ? '' : 'disabled'}><span class="codicon codicon-save"></span> Save</button></div></footer></div>`}</section>
      <div id="recipe-edit-error" class="recipe-edit-error" role="alert"></div>
    </div>
  </div>`;
}

function todoTechnologyTree(execution, scope) {
  const summary = todoExecutionSummary(execution);
  const techNode = (id, title, status, condition, meta, icon, expandable) => `<div class="agent-tech-node-shell">${expandable ? `<button class="agent-tech-toggle" title="${agentTechExpanded[id] ? 'Collapse' : 'Expand'} child Recipe" aria-label="${agentTechExpanded[id] ? 'Collapse' : 'Expand'} ${esc(title)}" aria-expanded="${!!agentTechExpanded[id]}" onclick="event.stopPropagation();agentTechToggle('${id}')"><span class="codicon codicon-chevron-${agentTechExpanded[id] ? 'down' : 'right'}"></span></button>` : ''}<button role="treeitem" aria-selected="${id === agentDashboardStep}" class="agent-tech-node ${status} ${id === agentDashboardStep ? 'active' : ''}" onclick="agentDashboardSelectStep('${id}')"><i class="codicon ${icon}"></i><span><strong>${esc(title)}</strong><small><em>${esc(condition)}</em>${esc(meta)}</small></span><b>${status === 'succeeded' ? 'Complete' : status === 'running' ? 'Running' : status === 'available' ? 'Available' : 'Locked'}</b></button>${expandable && !agentTechExpanded[id] ? '<small class="agent-tech-hidden">3 child Todos</small>' : ''}</div>`;
  return `<div class="agent-tech-toolbar"><strong>Todo Technology Tree</strong><div><button title="Show only the path to the running Todo" onclick="agentTechExpansionMode('current')"><span class="codicon codicon-target"></span>Focus current</button><button title="Expand every materialized Recipe layer" onclick="agentTechExpansionMode('all')"><span class="codicon codicon-expand-all"></span>Expand all</button><button title="Collapse every Recipe layer" onclick="agentTechExpansionMode('none')"><span class="codicon codicon-collapse-all"></span>Collapse all</button></div></div><div class="agent-tech-tree vertical" role="tree" aria-label="${scope === 'project' ? 'Project' : 'Agent'} Todo technology tree"><div class="agent-tech-canvas"><div class="agent-tech-boundary start"><span class="codicon codicon-debug-start"></span><strong>Start</strong></div><div class="agent-tech-stem"></div>
    <button class="agent-tech-root" aria-expanded="${!!agentTechExpanded.root}" onclick="agentTechToggle('root')"><span>Project</span><strong>${esc(execution.projectName)}</strong><small>Root · ${summary.total} Todo nodes · ${agentTechExpanded.root ? 'expanded' : 'collapsed'}</small><i class="codicon codicon-chevron-${agentTechExpanded.root ? 'down' : 'right'}"></i></button>
    ${agentTechExpanded.root ? `<div class="agent-tech-stem"></div><div class="agent-tech-recipe"><span class="codicon codicon-repo"></span><strong>Software Development</strong><small>Recipe r1 · expands Project</small></div>
    <div class="agent-tech-tier three">${techNode('understand','Understand request','succeeded','COUNT ≥1','Project active','codicon-search')}${techNode('plan','Plan changes','succeeded','COUNT ALL','All prerequisites','codicon-list-tree')}${techNode('implement','Implement dashboard','running','SUBSET A∧B','Named prerequisites','codicon-tools',true)}</div>
    ${agentTechExpanded.implement ? `<div class="agent-tech-expansion"><div class="agent-tech-stem"></div><div class="agent-tech-recipe nested"><span class="codicon codicon-git-branch"></span><strong>UI Development</strong><small>Recipe r1 · expands selected Todo</small></div>
      <div class="agent-tech-tier three">${techNode('validate','Validate behavior','available','COUNT >1','2 of 3 prerequisites','codicon-pass')}${techNode('report','Report outcome','locked','COUNT >K','K is Recipe input','codicon-note')}${techNode('release','Release change','locked','SUBSET','(A∨B)∧C','codicon-rocket')}</div>
    </div>` : ''}` : ''}<div class="agent-tech-stem"></div><div class="agent-tech-boundary end"><strong>End</strong><span class="codicon codicon-debug-stop"></span></div>
  </div></div>`;
}

function agentSessionNodeState(stateName) {
  return ['pending','running','succeeded','failed','skipped'].includes(stateName) ? stateName : 'pending';
}

function agentSessionNodeHealth(node) {
  if (node.state !== 'running') return '';
  const observed = String(node.observability?.state || '');
  if (observed) return observed;
  const progress = node.progress || {};
  if (progress.cancellationRequested) return 'cancellation-requested';
  if (progress.waitingOn) return 'waiting-external';
  const heartbeat = Date.parse(node.lastHeartbeatAt || node.startedAt || '');
  const lastProgress = Date.parse(node.lastProgressAt || node.startedAt || '');
  const staleMs = Math.max(15, Number(progress.staleAfterSeconds || 300)) * 1000;
  if (Number.isFinite(heartbeat) && Date.now() - heartbeat > staleMs) return 'possibly-stalled';
  if (Number.isFinite(lastProgress) && Date.now() - lastProgress > staleMs / 2) return 'slow-but-progressing';
  return 'healthy-running';
}

function agentSessionLivenessLabel(liveness) {
  const stateName = String(liveness?.state || '');
  if (stateName === 'suspected-stalled') return 'Suspected stalled';
  if (stateName === 'suspected-interrupted') return 'Suspected interrupted';
  if (stateName === 'waiting') return 'Waiting';
  if (stateName === 'healthy') return 'Live';
  return '';
}

function agentSessionProgressDetails(node) {
  if (node.state !== 'running') return '';
  const progress = node.progress || {};
  const health = agentSessionNodeHealth(node);
  const completed = Number(progress.completed);
  const total = Number(progress.total);
  const percent = Number.isFinite(Number(progress.percent))
    ? Number(progress.percent)
    : (Number.isFinite(completed) && total > 0 ? Math.round(completed * 100 / total) : null);
  const events = Array.isArray(progress.events) ? progress.events.slice(-4) : [];
  return `<div class="agent-module-progress">
    <div class="agent-module-health ${health}"><i></i><strong>${esc(health.replaceAll('-', ' '))}</strong><span>${esc(progress.phase || 'running')}</span></div>
    ${progress.message ? `<p>${esc(progress.message)}</p>` : ''}
    ${percent !== null ? `<div class="agent-module-meter"><i style="width:${Math.max(0, Math.min(100, percent))}%"></i></div>` : ''}
    <dl>
      ${Number.isFinite(completed) && Number.isFinite(total) ? `<div><dt>Progress</dt><dd>${completed} / ${total}${percent !== null ? ` · ${percent}%` : ''}</dd></div>` : ''}
      <div><dt>Heartbeat</dt><dd>${esc(node.lastHeartbeatAt || 'Not reported')}</dd></div>
      <div><dt>Meaningful progress</dt><dd>${esc(node.lastProgressAt || 'Not reported')}</dd></div>
      ${progress.currentValidation ? `<div><dt>Validation</dt><dd>${esc(progress.currentValidation)}</dd></div>` : ''}
      ${Number.isFinite(Number(progress.toolCallCount)) ? `<div><dt>Tool calls</dt><dd>${esc(progress.toolCallCount)}</dd></div>` : ''}
      ${node.observability?.recommendedAction ? `<div><dt>Recommended action</dt><dd>${esc(node.observability.recommendedAction)}</dd></div>` : ''}
      ${progress.checkpoint ? `<div><dt>Checkpoint</dt><dd>${esc(progress.checkpoint)}</dd></div>` : ''}
      ${progress.nextStep ? `<div><dt>Next</dt><dd>${esc(progress.nextStep)}</dd></div>` : ''}
      ${progress.waitingOn ? `<div><dt>Waiting on</dt><dd>${esc(progress.waitingOn)}</dd></div>` : ''}
      ${Number.isFinite(Number(progress.etaSeconds)) ? `<div><dt>ETA</dt><dd>${esc(progress.etaSeconds)}s</dd></div>` : ''}
      <div><dt>Interrupt safety</dt><dd>${progress.safeToInterrupt ? 'Safe to interrupt' : 'Do not skip active work'}</dd></div>
      ${Array.isArray(progress.sideEffects) && progress.sideEffects.length ? `<div><dt>Possible side effects</dt><dd>${progress.sideEffects.map(esc).join(' · ')}</dd></div>` : ''}
    </dl>
    ${events.length ? `<ol class="agent-module-events">${events.map(event => `<li><time>${esc(event.at || '')}</time>${esc(event.message)}</li>`).join('')}</ol>` : ''}
  </div>`;
}

function agentSessionRunGraph(run, allRuns, seen = new Set(), ownerTodo = null, forceOpen = false) {
  if (!run || seen.has(run.runId)) return '';
  seen.add(run.runId);
  const nodes = run.nodes || [];
  const ranks = new Map(nodes.map(node => [node.nodeId, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const node of nodes) {
      const dependencies = (node.dependsOn || []).filter(dependency => !dependency.loop && ranks.has(dependency.from));
      const rank = dependencies.length ? Math.max(...dependencies.map(dependency => ranks.get(dependency.from) + 1)) : 0;
      if (rank > ranks.get(node.nodeId)) { ranks.set(node.nodeId, rank); changed = true; }
    }
    if (!changed) break;
  }
  const levels = [];
  for (const node of nodes) (levels[ranks.get(node.nodeId) || 0] ||= []).push(node);
  const loops = (run.loops || []).map(loop => `<span class="agent-runtime-loop ${esc(loop.state)}"><span class="codicon codicon-sync"></span>${esc(loop.source)} → ${esc(loop.target)} · ${loop.iteration}/${loop.maxIterations} · ${esc(loop.state || 'ready')}</span>`).join('');
  const levelHtml = levels.map((level, levelIndex) => `<div class="agent-runtime-level" data-level="${levelIndex}">${level.map(node => {
    const stateName = agentSessionNodeState(node.state);
    const dependencies = (node.dependsOn || []).filter(dependency => !dependency.loop).map(dependency => dependency.from).join(', ');
    const child = node.childRunId ? allRuns.find(candidate => candidate.runId === node.childRunId) : null;
    const position = agentSessionNodePositions[`${run.runId}:${node.nodeId}`] || { x:0, y:0 };
    const todoSelected = ownerTodo?.todoId && selectedAgentSessionTodoId === ownerTodo.todoId;
    return `<div class="agent-runtime-node-shell"><article tabindex="0" class="agent-runtime-node ${stateName}${todoSelected ? ' todo-selected' : ''}" data-run-id="${esc(run.runId)}" data-node-id="${esc(node.nodeId)}" data-todo-id="${esc(ownerTodo?.todoId || '')}" style="transform:translate(${Number(position.x) || 0}px,${Number(position.y) || 0}px)" onpointerdown="agentSessionNodeDragStart(event,this)"><header><span class="codicon ${node.kind === 'pkm.subflow/v1' ? 'codicon-type-hierarchy-sub' : stateName === 'running' ? 'codicon-loading codicon-modifier-spin' : stateName === 'succeeded' ? 'codicon-pass-filled' : stateName === 'failed' ? 'codicon-error' : stateName === 'skipped' ? 'codicon-debug-step-over' : 'codicon-circle-outline'}"></span><strong>${esc(node.nodeId)}</strong><b>${esc(stateName)}</b></header><small>${dependencies ? `After ${esc(dependencies)}` : 'Start node'}${node.outcome && node.outcome !== stateName ? ` · ${esc(node.outcome)}` : ''}</small>${ownerTodo ? `<small class="agent-runtime-todo-owner"><span class="codicon codicon-checklist"></span>${esc(ownerTodo.title)} · ${esc(String(ownerTodo.todoId).slice(0, 12))}</small>` : ''}${node.instruction ? `<p>${esc(node.instruction)}</p>` : ''}${node.error ? `<p class="agent-runtime-error">${esc(node.error)}</p>` : ''}${agentSessionProgressDetails(node)}</article>${child ? `<div class="agent-runtime-child"><span>Nested Recipe</span>${agentSessionRunGraph(child, allRuns, seen, ownerTodo, forceOpen)}</div>` : ''}</div>`;
  }).join('')}</div>`).join('');
  const runKind = run.origin?.kind === 'agent-session-adhoc' ? 'Ad hoc task' : 'Recipe run';
  const markerId = `agent-runtime-arrow-${String(run.runId || '').replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const open = forceOpen || agentSessionOpenRunIds.has(run.runId);
  return `<details class="agent-runtime-run" data-run-id="${esc(run.runId)}"${open ? ' open' : ''} ontoggle="agentSessionRunToggle(this)"><summary><span class="agent-runtime-disclosure codicon codicon-add" aria-hidden="true"></span><div><span>${runKind}</span><strong>${esc(run.recipeName)}</strong><small>r${run.recipeRevision} · ${esc(String(run.executableDigest || '').slice(0,12))}</small></div><span class="agent-session-run-actions"><button title="Open full-screen Session graph" aria-label="Open full-screen Session graph" onclick="event.preventDefault();event.stopPropagation();agentSessionOpenGraph()"><span class="codicon codicon-screen-full"></span></button><b class="agent-runtime-run-status ${esc(run.status)}">${esc(run.status)}</b></span></summary><div class="agent-runtime-run-body">${loops ? `<div class="agent-runtime-loops">${loops}</div>` : ''}<div class="agent-runtime-graph" data-run-id="${esc(run.runId)}"><svg class="agent-runtime-graph-links" data-marker-id="${markerId}" aria-hidden="true"></svg>${nodes.length ? levelHtml : '<p class="agent-muted">No materialized tasks.</p>'}</div></div></details>`;
}

function agentSessionLayoutLinks() {
  if (typeof document.querySelectorAll !== 'function') return;
  document.querySelectorAll('.agent-runtime-graph[data-run-id]').forEach(graph => {
    const svg = graph.querySelector(':scope > .agent-runtime-graph-links');
    if (!svg) return;
    const graphRect = graph.getBoundingClientRect();
    const scaleX = graph.offsetWidth ? graphRect.width / graph.offsetWidth : 1;
    const scaleY = graph.offsetHeight ? graphRect.height / graph.offsetHeight : scaleX;
    const graphPoint = (rect, xRatio, yRatio) => ({
      x:(rect.left - graphRect.left + rect.width * xRatio) / scaleX,
      y:(rect.top - graphRect.top + rect.height * yRatio) / scaleY,
    });
    const run = (projectSnapshot?.agentSessions || []).flatMap(session => session.runs || [])
      .find(candidate => candidate.runId === graph.dataset.runId);
    const cards = new Map([...graph.querySelectorAll(':scope > .agent-runtime-level > .agent-runtime-node-shell > .agent-runtime-node')]
      .map(card => [card.dataset.nodeId, card]));
    const paths = [];
    const arrows = [];
    const incoming = new Set();
    const outgoing = new Set();
    for (const target of cards.values()) {
      const targetNode = target.dataset.nodeId;
      const targetRect = target.getBoundingClientRect();
      const node = run?.nodes?.find(candidate => candidate.nodeId === targetNode);
      for (const dependency of node?.dependsOn || []) {
        const source = cards.get(dependency.from);
        if (!source) continue;
        const sourceRect = source.getBoundingClientRect();
        const start = graphPoint(sourceRect, .5, 1);
        const end = graphPoint(targetRect, .5, 0);
        const startX = start.x;
        const startY = start.y;
        const endX = end.x;
        const endY = end.y - 8;
        const outerX = Math.max(
          (sourceRect.right - graphRect.left) / scaleX,
          (targetRect.right - graphRect.left) / scaleX
        ) + 24;
        const route = recipeGraphEdgeRoute(startX, startY, endX, endY, outerX);
        paths.push(`<path class="${dependency.loop ? 'loop-edge' : ''}" d="${route}"></path>`);
        arrows.push(recipeGraphArrowHead(endX, endY, dependency.loop ? 'loop-edge' : '', 'agent-graph-arrow'));
        if (!dependency.loop) { incoming.add(targetNode); outgoing.add(dependency.from); }
      }
    }
    const startBoundary = graph.querySelector('[data-runtime-boundary="start"]');
    const endBoundary = graph.querySelector('[data-runtime-boundary="end"]');
    if (startBoundary && endBoundary) {
      const startRect = startBoundary.getBoundingClientRect();
      const endRect = endBoundary.getBoundingClientRect();
      const startPoint = graphPoint(startRect, .5, 1);
      const endPoint = graphPoint(endRect, .5, 0);
      for (const [nodeId, card] of cards) {
        const rect = card.getBoundingClientRect();
        if (!incoming.has(nodeId)) {
          const targetPoint = graphPoint(rect, .5, 0);
          const target = { x:targetPoint.x, y:targetPoint.y - 8 };
          paths.unshift(`<path class="boundary-edge" d="${recipeGraphEdgeRoute(startPoint.x,startPoint.y,target.x,target.y,target.x)}"></path>`);
          arrows.unshift(recipeGraphArrowHead(target.x, target.y, '', 'agent-graph-arrow'));
        }
        if (!outgoing.has(nodeId)) {
          const source = graphPoint(rect, .5, 1);
          paths.push(`<path class="boundary-edge" d="${recipeGraphEdgeRoute(source.x,source.y,endPoint.x,endPoint.y - 8,endPoint.x)}"></path>`);
          arrows.push(recipeGraphArrowHead(endPoint.x, endPoint.y - 8, '', 'agent-graph-arrow'));
        }
      }
    }
    svg.setAttribute('viewBox', `0 0 ${graph.clientWidth} ${graph.clientHeight}`);
    svg.innerHTML = paths.join('');
    graph.querySelectorAll('.agent-graph-arrow').forEach(arrow => arrow.remove());
    graph.insertAdjacentHTML('beforeend', arrows.join(''));
  });
  agentSessionLayoutUnifiedLinks();
}

function agentSessionTodoRunIds(todo) {
  return [...new Set([...(todo.recipeRunIds || []), todo.recipeRunId].filter(Boolean))];
}

function agentSessionOwnedRuns(todo, runs) {
  const byId = new Map((runs || []).map(run => [run.runId, run]));
  const queue = agentSessionTodoRunIds(todo);
  const owned = [];
  const seen = new Set();
  while (queue.length) {
    const runId = queue.shift();
    if (seen.has(runId)) continue;
    seen.add(runId);
    const run = byId.get(runId);
    if (!run) continue;
    owned.push(run);
    for (const node of run.nodes || []) if (node.childRunId) queue.push(node.childRunId);
  }
  return owned;
}

function agentSessionUnifiedNode(run, node, todo, position = { x:0, y:0 }, treeDependencies = []) {
  const stateName = agentSessionNodeState(node.state);
  const offset = agentSessionNodePositions[`${run.runId}:${node.nodeId}`] || { x:0, y:0 };
  const dependencies = (node.dependsOn || []).filter(dependency => !dependency.loop).map(dependency => dependency.from).join(', ');
  const todoSelected = todo?.todoId && selectedAgentSessionTodoId === todo.todoId;
  return `<article tabindex="0" class="agent-runtime-node agent-session-unified-node ${stateName}${todoSelected ? ' todo-selected' : ''}" data-run-id="${esc(run.runId)}" data-node-id="${esc(node.nodeId)}" data-node-key="${esc(`${run.runId}:${node.nodeId}`)}" data-todo-id="${esc(todo?.todoId || '')}" data-tree-dependencies="${encodeURIComponent(JSON.stringify(treeDependencies))}" style="left:${Number(position.x) || 0}px;top:${Number(position.y) || 0}px;transform:translate(${Number(offset.x) || 0}px,${Number(offset.y) || 0}px)" onpointerdown="agentSessionNodeDragStart(event,this)">
    <header><span class="codicon ${node.kind === 'pkm.subflow/v1' ? 'codicon-type-hierarchy-sub' : stateName === 'running' ? 'codicon-loading codicon-modifier-spin' : stateName === 'succeeded' ? 'codicon-pass-filled' : stateName === 'failed' ? 'codicon-error' : stateName === 'skipped' ? 'codicon-debug-step-over' : 'codicon-circle-outline'}"></span><strong>${esc(node.nodeId)}</strong><b>${esc(stateName)}</b></header>
    <small>${dependencies ? `After ${esc(dependencies)}` : 'Start module'}${node.outcome && node.outcome !== stateName ? ` · ${esc(node.outcome)}` : ''}</small>
    <small class="agent-runtime-todo-owner"><span class="codicon codicon-checklist"></span>${esc(todo?.title || 'Session activity')} · ${esc(String(todo?.todoId || 'unassigned').slice(0, 12))}</small>
    ${node.instruction ? `<p>${esc(node.instruction)}</p>` : ''}${node.error ? `<p class="agent-runtime-error">${esc(node.error)}</p>` : ''}${agentSessionProgressDetails(node)}
  </article>`;
}

function agentSessionUnifiedTodoNode(todo, index) {
  const status = agentSessionNodeState(todo.status);
  return `<article class="agent-session-unified-todo ${status}${selectedAgentSessionTodoId === todo.todoId ? ' selected' : ''}" data-todo-id="${esc(todo.todoId)}" data-todo-node="${esc(todo.todoId)}" data-todo-status="${esc(status)}">
    <header tabindex="0" role="button" onclick="agentSessionSelectTodo(decodeURIComponent('${encodeURIComponent(todo.todoId)}'))"><span>${index + 1}</span><div><small>Session Todo</small><strong>${esc(todo.title)}</strong><code>${esc(todo.todoId)}</code></div><b>${esc(todo.status)}</b></header>
  </article>`;
}

function agentSessionUnifiedTree(session, todos) {
  const entries = [];
  const dependencies = new Map();
  for (const todo of todos) {
    const ownedRuns = agentSessionOwnedRuns(todo, session.runs || []);
    const owned = [];
    for (const run of ownedRuns) for (const node of run.nodes || []) {
      const key = `${run.runId}:${node.nodeId}`;
      const entry = { key, run, node, todo };
      entries.push(entry);
      owned.push(entry);
      dependencies.set(key, (node.dependsOn || []).filter(dependency => !dependency.loop).map(dependency => `${run.runId}:${dependency.from}`));
    }
    const runsById = new Map(ownedRuns.map(run => [run.runId, run]));
    for (const run of ownedRuns) for (const node of run.nodes || []) {
      if (!node.childRunId || !runsById.has(node.childRunId)) continue;
      const child = runsById.get(node.childRunId);
      const childIds = new Set((child.nodes || []).map(candidate => candidate.nodeId));
      for (const root of (child.nodes || []).filter(candidate => !(candidate.dependsOn || []).some(dependency => !dependency.loop && childIds.has(dependency.from)))) {
        dependencies.get(`${child.runId}:${root.nodeId}`)?.push(`${run.runId}:${node.nodeId}`);
      }
    }
  }
  for (const edge of session.recipeTreeEdges || []) {
    const source = `${edge.fromRunId}:${edge.fromNodeId}`;
    const target = `${edge.toRunId}:${edge.toNodeId}`;
    if (dependencies.has(target) && entries.some(entry => entry.key === source)) dependencies.get(target).push(source);
  }
  const layoutNodes = entries.map(entry => ({
    nodeId:entry.key,
    dependsOn:(dependencies.get(entry.key) || []).map(from => ({ from }))
  }));
  const positions = RecipeGraph.organizedPositions(layoutNodes, { startX:28, startY:32, columnPitch:244, rowPitch:138 });
  const width = Math.max(520, ...entries.map(entry => (positions[entry.key]?.x || 0) + 216 + 28));
  const height = Math.max(180, ...entries.map(entry => (positions[entry.key]?.y || 0) + 104 + 34));
  const boundaries = todos.map(todo => {
    const ownedRuns = agentSessionOwnedRuns(todo, session.runs || []);
    const statuses = ownedRuns.map(run => run.status || 'pending').join(' ');
    return `<section class="agent-session-recipe-subtree${selectedAgentSessionTodoId === todo.todoId ? ' selected' : ''}" data-todo-id="${esc(todo.todoId)}" data-recipe-group="${esc(todo.todoId)}" data-recipe-statuses="${esc(statuses)}"><header><small>Todo subtree</small><strong>${esc(todo.title)}</strong></header></section>`;
  }).join('');
  const nodes = entries.map(entry => agentSessionUnifiedNode(
    entry.run,
    entry.node,
    entry.todo,
    positions[entry.key],
    dependencies.get(entry.key) || []
  )).join('');
  return `<section class="agent-session-recipe-tree"><header><small>Unified Recipe tree</small><strong>Parent → child dependencies; siblings share a level</strong></header><div class="agent-session-recipe-tree-canvas" style="width:${width}px;height:${height}px">${boundaries}${nodes}</div></section>`;
}

function agentSessionUnifiedGraph(session) {
  const todos = session.todos || [];
  const assigned = new Set(todos.flatMap(todo => agentSessionOwnedRuns(todo, session.runs).map(run => run.runId)));
  const unassignedRuns = (session.runs || []).filter(run => !assigned.has(run.runId) && (!run.parent || !session.runs.some(candidate => candidate.runId === run.parent.runId)));
  const synthetic = unassignedRuns.length ? [{
    todoId:`${session.sessionId}:unassigned`, title:'Session activity', status:session.status === 'running' ? 'running' : 'succeeded',
    recipeRunIds:unassignedRuns.map(run => run.runId)
  }] : [];
  const lanes = [...todos, ...synthetic];
  const traversal = String(session.traversalStrategy || session.runs?.find(run => run.traversalStrategy)?.traversalStrategy || '');
  const traversalLabel = traversal === 'breadth-first' ? 'BFS' : traversal === 'depth-first' ? 'DFS' : 'Traversal';
  return `<div class="agent-session-unified-graph" data-session-id="${esc(session.sessionId)}">
    <svg class="agent-session-unified-links" aria-hidden="true"></svg>
    <div class="agent-session-unified-layout">
      <div class="agent-session-todo-lane">
        <article class="agent-session-unified-session" data-session-node="${esc(session.sessionId)}"><small>Agent Session</small><strong>${esc(session.task)}</strong><code>${esc(session.sessionId)}</code><b>${esc(session.status)}</b></article>
        <header class="agent-session-traversal-header"><small>Materialized Todo order</small><strong>${esc(traversalLabel)} traversal queue</strong></header>
        ${lanes.map((todo, index) => agentSessionUnifiedTodoNode(todo, index)).join('')}
      </div>
      ${agentSessionUnifiedTree(session, lanes)}
    </div>
  </div>`;
}

function agentSessionLayoutUnifiedLinks() {
  const graph = document.querySelector('.agent-session-unified-graph');
  if (!graph) return;
  const svg = graph.querySelector(':scope > .agent-session-unified-links');
  const graphRect = graph.getBoundingClientRect();
  const scaleX = graph.offsetWidth ? graphRect.width / graph.offsetWidth : 1;
  const scaleY = graph.offsetHeight ? graphRect.height / graph.offsetHeight : scaleX;
  const cards = new Map([...graph.querySelectorAll('.agent-session-unified-node[data-node-key]')]
    .map(card => [card.dataset.nodeKey, card]));
  const todoCards = new Map([...graph.querySelectorAll('.agent-session-unified-todo[data-todo-node]')]
    .map(card => [card.dataset.todoNode, card]));
  const recipeGroups = new Map([...graph.querySelectorAll('.agent-session-recipe-subtree[data-recipe-group]')]
    .map(group => [group.dataset.recipeGroup, group]));
  const sessionCard = graph.querySelector('.agent-session-unified-session[data-session-node]');
  const sessions = projectSnapshot?.agentSessions || [];
  const session = sessions.find(candidate => candidate.sessionId === graph.dataset.sessionId);
  const paths = [];
  const arrows = [];
  const point = (rect, xRatio, yRatio) => ({
    x:(rect.left - graphRect.left + rect.width * xRatio) / scaleX,
    y:(rect.top - graphRect.top + rect.height * yRatio) / scaleY,
  });
  const addEdge = (sourceKey, targetKey, className = '') => {
    const source = cards.get(sourceKey);
    const target = cards.get(targetKey);
    if (!source || !target) return;
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const start = point(sourceRect, .5, 1);
    const targetTop = point(targetRect, .5, 0);
    const end = { x:targetTop.x, y:targetTop.y - 8 };
    const outerX = Math.max(point(sourceRect, 1, 0).x, point(targetRect, 1, 0).x) + 24;
    const edgeClass = className ? ` ${className}` : '';
    paths.push(`<path class="agent-session-unified-edge${edgeClass}" data-edge-source="${esc(sourceKey)}" data-edge-target="${esc(targetKey)}" d="${recipeGraphEdgeRoute(start.x,start.y,end.x,end.y,outerX)}"></path>`);
    arrows.push(`<i class="agent-graph-arrow${edgeClass}" data-edge-source="${esc(sourceKey)}" data-edge-target="${esc(targetKey)}" style="left:${end.x - 6}px;top:${end.y - 10}px"></i>`);
  };
  const addStructuralEdge = (source, target, sourceKey, targetKey) => {
    if (!source || !target) return;
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const start = point(sourceRect, .5, 1);
    const end = point(targetRect, .5, 0);
    const middleY = start.y + Math.max(12, (end.y - start.y) / 2);
    paths.push(`<path class="agent-session-structure-edge" data-structure-source="${esc(sourceKey)}" data-structure-target="${esc(targetKey)}" d="M ${start.x} ${start.y} V ${middleY} H ${end.x} V ${end.y}"></path>`);
  };
  const addOwnershipEdge = (todoId, todoCard, recipeGroup) => {
    if (!todoCard || !recipeGroup) return;
    const todoRect = todoCard.getBoundingClientRect();
    const groupRect = recipeGroup.getBoundingClientRect();
    const start = point(todoRect, 1, .5);
    const end = point(groupRect, 0, .5);
    const middleX = start.x + Math.max(16, (end.x - start.x) / 2);
    paths.push(`<path class="agent-session-ownership-edge" data-structure-source="${esc(todoId)}" data-structure-target="${esc(`${todoId}:recipes`)}" d="M ${start.x} ${start.y} H ${middleX} V ${end.y} H ${end.x}"></path>`);
  };
  const treeCanvas = graph.querySelector('.agent-session-recipe-tree-canvas');
  if (treeCanvas) for (const [todoId, boundary] of recipeGroups) {
    const ownedCards = [...cards.values()].filter(card => card.dataset.todoId === todoId);
    if (!ownedCards.length) {
      boundary.hidden = true;
      continue;
    }
    boundary.hidden = false;
    const canvasRect = treeCanvas.getBoundingClientRect();
    const rects = ownedCards.map(card => card.getBoundingClientRect());
    const left = Math.min(...rects.map(rect => rect.left));
    const top = Math.min(...rects.map(rect => rect.top));
    const right = Math.max(...rects.map(rect => rect.right));
    const bottom = Math.max(...rects.map(rect => rect.bottom));
    boundary.style.left = `${(left - canvasRect.left) / scaleX - 14}px`;
    boundary.style.top = `${(top - canvasRect.top) / scaleY - 24}px`;
    boundary.style.width = `${(right - left) / scaleX + 28}px`;
    boundary.style.height = `${(bottom - top) / scaleY + 38}px`;
  }
  let previousStructure = sessionCard;
  let previousKey = session?.sessionId || 'session';
  for (const [todoId, todoCard] of todoCards) {
    addStructuralEdge(previousStructure, todoCard, previousKey, todoId);
    addOwnershipEdge(todoId, todoCard, recipeGroups.get(todoId));
    previousStructure = todoCard;
    previousKey = todoId;
  }
  for (const [targetKey, card] of cards) {
    const sources = JSON.parse(decodeURIComponent(card.dataset.treeDependencies || '%5B%5D'));
    sources.forEach(sourceKey => addEdge(sourceKey, targetKey));
  }
  svg.setAttribute('viewBox', `0 0 ${graph.offsetWidth} ${graph.offsetHeight}`);
  svg.innerHTML = paths.join('');
  graph.querySelectorAll(':scope > .agent-graph-arrow').forEach(arrow => arrow.remove());
  graph.insertAdjacentHTML('beforeend', arrows.join(''));
}

function agentSessionTodoFlow(session, todos, runs) {
  const terminal = new Set(['succeeded','failed','skipped']);
  const rootRuns = runs.filter(run => !run.parent || !runs.some(candidate => candidate.runId === run.parent.runId));
  const assigned = new Set();
  const taskHtml = todos.map((todo, index) => {
    const status = ['pending','running','succeeded','failed','skipped'].includes(todo.status) ? todo.status : 'pending';
    const icon = status === 'running' ? 'codicon-loading codicon-modifier-spin' : status === 'succeeded' ? 'codicon-pass-filled' : status === 'failed' ? 'codicon-error' : status === 'skipped' ? 'codicon-debug-step-over' : 'codicon-circle-outline';
    const linked = new Set(agentSessionTodoRunIds(todo));
    const todoRuns = rootRuns.filter(run => linked.has(run.runId));
    todoRuns.forEach(run => assigned.add(run.runId));
    return `<article class="agent-session-task ${status}${selectedAgentSessionTodoId === todo.todoId ? ' selected' : ''}" data-todo-id="${esc(todo.todoId)}"><header tabindex="0" role="button" aria-label="Highlight modules for ${esc(todo.title)}" onclick="agentSessionSelectTodo(decodeURIComponent('${encodeURIComponent(todo.todoId)}'))" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();agentSessionSelectTodo(decodeURIComponent('${encodeURIComponent(todo.todoId)}'))}"><span class="agent-session-task-index">${index + 1}</span><span class="codicon ${icon}"></span><div><strong>${esc(todo.title)}</strong>${todo.details ? `<p>${esc(todo.details)}</p>` : ''}${todo.summary ? `<small>${esc(todo.summary)}</small>` : ''}</div><b>${esc(status)}</b></header><div class="agent-session-task-recipes">${todoRuns.map(run => agentSessionRunGraph(run, runs, new Set(), todo)).join('') || '<span class="agent-session-no-recipe">No Recipe attached</span>'}</div></article>`;
  }).join('');
  const unassigned = rootRuns.filter(run => !assigned.has(run.runId));
  const unassignedHtml = unassigned.length ? `<article class="agent-session-task unassigned"><header><span class="agent-session-task-index"><span class="codicon codicon-history"></span></span><div><strong>Session activity</strong><p>Recipe runs retained without a Todo association.</p></div><b>${unassigned.length}</b></header><div class="agent-session-task-recipes">${unassigned.map(run => agentSessionRunGraph(run, runs)).join('')}</div></article>` : '';
  const complete = session.status === 'completed';
  const stopped = session.status === 'stopped';
  const readyToEnd = !complete && !stopped && todos.length > 0 && todos.every(todo => terminal.has(todo.status));
  const endLabel = complete ? 'Completed' : stopped ? 'Stopped' : readyToEnd ? 'Ready to end' : 'End pending';
  return `<section class="agent-session-flow" aria-label="Session Todo flow"><header><div><span>Ordered task flow</span><strong>Session Todos</strong></div><b>${todos.filter(todo => terminal.has(todo.status)).length} / ${todos.length}</b></header><div class="agent-session-boundary start"><span class="codicon codicon-debug-start"></span><strong>Start</strong></div><div class="agent-session-flow-stem"></div><div class="agent-session-tasks">${taskHtml}${unassignedHtml}</div><div class="agent-session-flow-stem"></div><div class="agent-session-boundary end ${complete || stopped || readyToEnd ? 'ready' : ''}"><strong>${endLabel}</strong><span class="codicon codicon-debug-stop"></span></div>${readyToEnd ? '<p class="agent-session-end-guidance">All Todos are terminal. Validate the overall outcome, checkpoint if useful, then call <code>agent_session_end</code>.</p>' : ''}</section>`;
}

function agentSessionRefresh() {
  projectSnapshotDirty = true;
  ask('projectState', {});
}

function agentSessionFullscreenGraph(session) {
  if (!agentSessionFullscreenRunId) return '';
  if (agentSessionFullscreenRunId !== session.sessionId) {
    agentSessionFullscreenRunId = '';
    agentSessionPersistGraphView();
    return '';
  }
  const moduleCount = (session.runs || []).reduce((total, run) => total + (run.nodes || []).length, 0);
  return `<div class="agent-session-fullscreen" role="dialog" aria-modal="true" aria-label="Full-screen Agent Session Recipe graph">
    <header><div><span>Unified Agent Session graph</span><strong>${esc(session.task)}</strong><small>${(session.todos || []).length} Todos · ${moduleCount} modules · ${esc(session.sessionId)}</small></div><div class="agent-session-graph-toolbar"><button title="Zoom out" onclick="agentSessionGraphZoomSet(agentSessionGraphZoom-.1)"><span class="codicon codicon-zoom-out"></span></button><output data-agent-session-zoom>${Math.round(agentSessionGraphZoom * 100)}%</output><button title="Zoom in" onclick="agentSessionGraphZoomSet(agentSessionGraphZoom+.1)"><span class="codicon codicon-zoom-in"></span></button><button title="Reset zoom" onclick="agentSessionGraphZoomSet(1)"><span class="codicon codicon-discard"></span></button><button title="Re-organize graph" onclick="agentSessionGraphReorganize()"><span class="codicon codicon-layout"></span></button><button title="Close full-screen graph" onclick="agentSessionCloseGraph()"><span class="codicon codicon-close"></span></button></div></header>
    <div class="agent-session-graph-stage" onpointerdown="agentSessionGraphPanStart(event)" onscroll="agentSessionGraphRememberViewport(this)"><div class="agent-session-graph-canvas" style="--agent-session-graph-zoom:${agentSessionGraphZoom}">${agentSessionUnifiedGraph(session)}</div></div>
  </div>`;
}

function agentSessionTree(sessions, archived = false) {
  if (!sessions.length) return '';
  const tree = buildCatTree(sessions, session => [
    session.agent?.name || 'Agent',
    session.hostSessionId ? `Copilot Session ${session.hostSessionId}` : 'Unlinked sessions'
  ], 'Unlinked sessions');
  return `<div class="agent-session-tree">${renderCatTree(tree, [], 0, (session, depth) => `<div class="li cattree-item agent-session-row ${session.sessionId === selectedAgentSessionId ? 'active' : ''}" style="padding-left:${8 + depth * 12}px" role="button" tabindex="0" onclick="agentSessionSelect(decodeURIComponent('${encodeURIComponent(session.sessionId)}'))" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();agentSessionSelect(decodeURIComponent('${encodeURIComponent(session.sessionId)}'))}" oncontextmenu="agentSessionContextMenu(event,decodeURIComponent('${encodeURIComponent(session.sessionId)}'),'${esc(session.status)}')"><span><i class="${session.status === 'running' ? '' : 'idle'}"></i><strong>${esc(session.task)}</strong></span><b>${esc(session.sessionId.replace(/^agent_session_/, '').slice(0,12))}</b><small>${esc(session.lastActivity?.tool || (session.checkpoint ? 'Checkpoint ready' : 'Registered'))}${agentSessionLivenessLabel(session.liveness) ? ` · <em class="agent-session-liveness ${esc(session.liveness.state)}">${esc(agentSessionLivenessLabel(session.liveness))}</em>` : ''}</small>${archived ? `<button class="agent-session-quick-trash" title="Move archived Agent Session to Trash" aria-label="Move ${esc(session.task)} to Trash" onclick="event.stopPropagation();ask('agentSessionTrash',{action:'move',sessionId:decodeURIComponent('${encodeURIComponent(session.sessionId)}')},this)"><span class="codicon codicon-trash"></span></button>` : ''}<button class="cattree-item-menu" title="Agent Session actions" aria-label="Actions for ${esc(session.task)}" onclick="event.stopPropagation();agentSessionContextMenu(event,decodeURIComponent('${encodeURIComponent(session.sessionId)}'),'${esc(session.status)}')"><span class="codicon codicon-ellipsis"></span></button></div>`, '', (_child, _name, fullPath) => ` oncontextmenu="agentSessionFolderMenu(event,decodeURIComponent('${encodeURIComponent(fullPath.join('/'))}'))"`, null, {
    area:'agentSessions',
    defaultOpen:true,
    renderFolderLabel:(name, path) => path.length === 1
      ? `<span class="codicon codicon-account"></span>${esc(name)}`
      : `<span class="codicon codicon-comment-discussion"></span>${name === 'Unlinked sessions' ? name : `Copilot Session ${esc(name.slice('Copilot Session '.length, 'Copilot Session '.length + 12))}`}`
  })}</div>`;
}

function renderAgentSessions() {
  if (state.tab !== 'agentSessions') return;
  const detail = document.getElementById('detail');
  const previousTreeScroll = detail.querySelector?.('.agent-session-tree-scroll')?.scrollTop || 0;
  const previousContentScroll = detail.querySelector?.('.agent-session-content')?.scrollTop || 0;
  const focused = document.activeElement?.closest?.('[data-run-id][data-node-id]');
  const focusedIdentity = focused ? { runId:focused.dataset.runId, nodeId:focused.dataset.nodeId } : null;
  const sessions = projectSnapshot?.agentSessions || [];
  const trash = projectSnapshot?.agentSessionTrash || [];
  const activeSessions = sessions.filter(session => session.status === 'running');
  const archivedSessions = sessions.filter(session => session.status !== 'running');
  const archiveKeepLatestK = projectSnapshot?.agentSessionArchiveKeepLatestK || 50;
  if (!sessions.some(session => session.sessionId === selectedAgentSessionId)) selectedAgentSessionId = activeSessions[0]?.sessionId || archivedSessions[0]?.sessionId || '';
  const selected = sessions.find(session => session.sessionId === selectedAgentSessionId);
  if (agentSessionArchiveExpanded === undefined) agentSessionArchiveExpanded = !activeSessions.length && archivedSessions.some(session => session.sessionId === selectedAgentSessionId);
  const trashList = `${trash.length ? `<div class="agent-session-trash-actions"><button class="tbtn danger" onclick="emptyAgentSessionTrash()"><span class="codicon codicon-trash"></span>Empty Trash</button></div>` : ''}${trash.map(session => `<div class="li cattree-item agent-session-trash-row" oncontextmenu="agentSessionTrashContextMenu(event,decodeURIComponent('${encodeURIComponent(session.sessionId)}'))"><div><strong>${esc(session.task)}</strong><small>${esc(session.agent?.name || 'Agent')}</small></div><button class="cattree-item-menu" title="Trash actions" aria-label="Trash actions for ${esc(session.task)}" onclick="event.stopPropagation();agentSessionTrashContextMenu(event,decodeURIComponent('${encodeURIComponent(session.sessionId)}'))"><span class="codicon codicon-ellipsis"></span></button></div>`).join('')}`;
  const list = `${agentSessionTree(activeSessions)}${archivedSessions.length ? `<details class="agent-session-archive"${agentSessionArchiveExpanded ? ' open' : ''} ontoggle="agentSessionGroupToggle('archive',this.open)"><summary title="The newest ${archiveKeepLatestK} completed or stopped Agent Sessions are retained; overflow moves to recoverable Trash."><span><i class="codicon codicon-archive"></i>History <small>Keep newest ${archiveKeepLatestK}</small></span><b>${archivedSessions.length}</b></summary>${agentSessionTree(archivedSessions, true)}</details>` : ''}`;
  const empty = `<div class="agent-session-empty"><span class="codicon codicon-run-all"></span><strong>No Agent Sessions</strong><p>An Agent appears here only after it explicitly accepts PKM management with agent_session_start.</p></div>`;
  let content = empty;
  if (selected) {
    const nodes = selected.runs.flatMap(run => run.nodes || []);
    const terminal = nodes.filter(node => ['succeeded','failed','skipped'].includes(node.state)).length;
    const running = nodes.find(node => node.state === 'running');
    const persistedTodos = selected.todos || [];
    const sessionTodos = persistedTodos.length || selected.runs.length ? persistedTodos : [{
      todoId:`${selected.sessionId}:task`,
      title:selected.task || 'Agent Session task',
      details:'Ad hoc task · No Recipe run attached',
      status:selected.status === 'completed' ? 'succeeded' : selected.status === 'stopped' ? 'skipped' : 'running'
    }];
    const todoTerminal = sessionTodos.filter(todo => ['succeeded','failed','skipped'].includes(todo.status)).length;
    const runningTodo = sessionTodos.find(todo => todo.status === 'running');
    const progressDone = sessionTodos.length ? todoTerminal : terminal;
    const progressTotal = sessionTodos.length || nodes.length;
    const percent = progressTotal ? Math.round(progressDone * 100 / progressTotal) : 0;
    content = `<div class="agent-dashboard"><header class="agent-session-head"><div><span>PKM-managed Agent Session</span><h3>${esc(selected.task)}</h3><p>${esc(selected.sessionId)} · Updated ${esc(selected.updatedAt || 'unknown')}</p></div><div class="agent-session-head-actions"><button class="tbtn" title="Refresh without resetting graph focus" onclick="agentSessionRefresh()"><span class="codicon codicon-refresh"></span>Refresh</button><span class="agent-status ${selected.status === 'running' ? 'running' : ''}">${selected.status === 'running' ? '<i class="agent-live-dot"></i> ' : ''}${esc(selected.status)}</span>${agentSessionLivenessLabel(selected.liveness) ? `<span class="agent-session-liveness ${esc(selected.liveness.state)}" title="Heartbeat age: ${selected.liveness.heartbeatAgeSeconds === null ? 'unknown' : `${Math.round(selected.liveness.heartbeatAgeSeconds)}s`} · Lease: ${selected.liveness.leaseSeconds}s">${esc(agentSessionLivenessLabel(selected.liveness))}</span>` : ''}</div></header><div class="agent-session-summary"><div><span>Agent</span><strong>${esc(selected.agent?.name || 'Agent')}</strong><small>${esc(selected.agent?.product || '')}</small></div><div><span>Current task</span><strong>${esc(runningTodo?.title || running?.nodeId || (selected.runs.length ? 'No running node' : 'Awaiting task plan'))}</strong><small>${esc(selected.lastActivity?.tool || 'Registered')}</small></div><div><span>${sessionTodos.length ? 'Session todos' : 'Task runs'}</span><strong>${sessionTodos.length || selected.runs.length}</strong><small>${sessionTodos.length ? `${sessionTodos.filter(todo => todo.status === 'pending').length} queued` : `${nodes.length} graph tasks`}</small></div><div><span>Progress</span><strong>${progressDone} / ${progressTotal}</strong><small>${percent}% complete</small><div class="agent-progress" aria-label="${progressDone} of ${progressTotal} tasks terminal"><i style="width:${percent}%"></i></div></div></div>${selected.checkpoint ?  `<div class="agent-checkpoint-strip"><span class="codicon codicon-save"></span><div><strong>Checkpoint ${selected.checkpoint.sequence}</strong><small>${esc(selected.checkpoint.summary || selected.checkpoint.reason || 'Recovery state saved')} · ${selected.checkpoint.nextActionCount} next actions</small></div><code>${esc(selected.checkpoint.checkpointId)}</code></div>` : ''}${agentSessionTodoFlow(selected, sessionTodos, selected.runs)}</div>${agentSessionFullscreenGraph(selected)}`;
  }
  detail.innerHTML = `<div class="agent-sessions-workspace ${agentSessionTreeCollapsed ? 'cattree-collapsed' : ''}"><aside class="agent-session-list"><div class="agent-session-list-head"><strong>Agent Sessions</strong><span>${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}</span></div><div class="agent-session-tree-scroll" oncontextmenu="if(event.target===this)agentSessionRootMenu(event)">${list}</div>${catTreeTrashDock('Trash', trash.length, trashList)}</aside>${workspaceCatTreeDivider('agentSessions',agentSessionTreeCollapsed)}<main class="agent-session-content">${content}</main></div>`;
  const nextTree = detail.querySelector?.('.agent-session-tree-scroll');
  const nextContent = detail.querySelector?.('.agent-session-content');
  if (nextTree) nextTree.scrollTop = previousTreeScroll;
  if (nextContent) nextContent.scrollTop = previousContentScroll;
  const nextGraphStage = detail.querySelector?.('.agent-session-graph-stage');
  const graphViewport = agentSessionGraphViewport[agentSessionFullscreenRunId];
  if (nextGraphStage && graphViewport) {
    nextGraphStage.scrollLeft = Number(graphViewport.left) || 0;
    nextGraphStage.scrollTop = Number(graphViewport.top) || 0;
  }
  if (focusedIdentity) {
    const nextFocus = [...(detail.querySelectorAll?.('[data-run-id][data-node-id]') || [])]
      .find(element => element.dataset.runId === focusedIdentity.runId && element.dataset.nodeId === focusedIdentity.nodeId);
    nextFocus?.focus?.({ preventScroll:true });
  }
  if (agentSessionGraphResizeObserver) agentSessionGraphResizeObserver.disconnect();
  agentSessionGraphResizeObserver = null;
  const runGraphs = typeof detail.querySelectorAll === 'function' ? detail.querySelectorAll('.agent-runtime-graph[data-run-id]') : [];
  if (runGraphs.length && typeof ResizeObserver !== 'undefined') {
    agentSessionGraphResizeObserver = new ResizeObserver(agentSessionLayoutLinks);
    runGraphs.forEach(graph => agentSessionGraphResizeObserver.observe(graph));
  }
  agentSessionLayoutLinks();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(agentSessionLayoutLinks);
}

function renderAgentSnapshots() {
  if (state.tab !== 'agentSnapshots') return;
  const detail = document.getElementById('detail');
  const snapshots = projectSnapshot?.agentSnapshots || [];
  const sessions = projectSnapshot?.agentSessions || [];
  if (!snapshots.some(snapshot => snapshot.snapshotId === selectedAgentSnapshotId)) {
    selectedAgentSnapshotId = snapshots[0]?.snapshotId || '';
  }
  const selected = snapshots.find(snapshot => snapshot.snapshotId === selectedAgentSnapshotId);
  const preferredSessionId = sessions.some(session => session.sessionId === selectedAgentSessionId)
    ? selectedAgentSessionId : sessions.find(session => session.status === 'running')?.sessionId || sessions[0]?.sessionId || '';
  const sourceOptions = sessions.map(session => `<option value="${esc(session.sessionId)}" ${session.sessionId === preferredSessionId ? 'selected' : ''}>${esc(session.task)} · ${esc(session.status)}</option>`).join('');
  const create = `<section class="agent-snapshot-create"><div><span>Capture current durable state</span><strong>Create Agent Snapshot</strong><p>Saves the Session, ordered todos, checkpoints, and linked Recipe runs. The source Session remains unchanged.</p></div><label>Source Agent Session<select id="agent-snapshot-source" ${sessions.length ? '' : 'disabled'}>${sourceOptions || '<option value="">No Agent Sessions available</option>'}</select></label><button class="pk-button primary" data-pending-label="Creating…" onclick="agentSnapshotCreate(this)" ${sessions.length ? '' : 'disabled'}><span class="codicon codicon-save"></span>Create Snapshot</button></section>`;
  const list = snapshots.length ? snapshots.map(snapshot => `<button class="agent-snapshot-row ${snapshot.snapshotId === selectedAgentSnapshotId ? 'active' : ''}" onclick="agentSnapshotSelect(decodeURIComponent('${encodeURIComponent(snapshot.snapshotId)}'))" oncontextmenu="agentSnapshotContextMenu(event,decodeURIComponent('${encodeURIComponent(snapshot.snapshotId)}'))"><span class="codicon codicon-save"></span><span><strong>${esc(snapshot.task)}</strong><small>${esc(snapshot.magicCode)} · ${esc(snapshot.createdAt)}</small></span><b>${snapshot.recoveryCount || 0} recovered</b></button>`).join('') : `<div class="agent-snapshot-empty"><span class="codicon codicon-save"></span><strong>No Agent Snapshots</strong><p>Create one before closing a resource-heavy conversation.</p></div>`;
  let content = `<div class="agent-snapshot-empty detail"><span class="codicon codicon-key"></span><strong>Choose or create a Snapshot</strong><p>A Snapshot can be recovered repeatedly into independent Agent Sessions.</p></div>`;
  if (selected) {
    const credential = agentSnapshotCredential?.snapshotId === selected.snapshotId ? agentSnapshotCredential : null;
    const encodedMagic = encodeURIComponent(selected.magicCode);
    const encodedPrompt = credential ? encodeURIComponent(credential.recoveryPrompt) : '';
    content = `<article class="agent-snapshot-detail"><header><div><span>Immutable recovery point</span><h3>${esc(selected.task)}</h3><p>${esc(selected.snapshotId)}</p></div><b>${selected.recoveryCount || 0} recoveries</b></header>${credential ? `<section class="agent-snapshot-secret"><div><span class="codicon codicon-warning"></span><div><strong>${credential.rotated ? 'New recovery passphrase' : 'Save this recovery passphrase now'}</strong><p>${credential.copied ? 'The complete Recovery Prompt was copied automatically. ' : 'Automatic copy failed; use the button below. '}It is shown only once and is never stored in plaintext.${credential.rotated ? ' The previous passphrase is no longer valid.' : ''}</p></div></div><code>${esc(credential.recoveryPassphrase)}</code><div><button class="pk-button" onclick="agentSnapshotCopy(decodeURIComponent('${encodedPrompt}'),this)">Copy Recovery Prompt</button><button class="pk-button secondary" onclick="agentSnapshotDismissCredential()">I saved it</button></div></section>` : ''}<section class="agent-snapshot-identity"><div><span>Magic Code</span><code>${esc(selected.magicCode)}</code><button class="pk-button secondary" onclick="agentSnapshotCopy(decodeURIComponent('${encodedMagic}'),this)">Copy</button><button class="pk-button secondary" data-pending-label="Rotating…" onclick="agentSnapshotRotate(decodeURIComponent('${encodeURIComponent(selected.snapshotId)}'))">Rotate Passphrase…</button></div><p>The Magic Code identifies this Snapshot. Its encrypted payload may be selected explicitly for GitHub Sync; other Sync and Subscribe surfaces exclude Agent Snapshots.</p></section><div class="agent-snapshot-metrics"><div><span>Source Session</span><strong>${esc(selected.sourceSessionId)}</strong></div><div><span>Captured</span><strong>${esc(selected.createdAt)}</strong></div><div><span>Session Todos</span><strong>${selected.todoCount || 0}</strong></div><div><span>Recipe Runs</span><strong>${selected.recipeRunCount || 0}</strong></div></div><section class="agent-snapshot-recover"><span class="codicon codicon-debug-restart"></span><div><strong>Recover in a new conversation</strong><ol><li>Open a new Copilot session in this Knowledge Root.</li><li>Paste the recovery prompt containing the Magic Code and passphrase.</li><li>The Agent calls <code>agent_session_snapshot_recover</code> and continues from the captured todos and Recipe runs.</li></ol><p>Each recovery creates a new independent Session. Right-click this Snapshot to delete it when it is no longer needed.</p></div></section></article>`;
  }
  detail.innerHTML = `<div class="agent-snapshot-page">${create}<div class="agent-snapshot-workspace"><aside><header><strong>Agent Snapshots</strong><span>${snapshots.length}</span></header><div>${list}</div></aside><main>${content}</main></div></div>`;
}

function projectGanttBody(project, threads) {
  const tasks = (projectSnapshot?.ganttTasks || []).filter(task => task.projectId === project.projectId);
  let selected = tasks.find(task => task.taskId === selectedGanttTaskId);
  if (selectedGanttTaskId && !selected) selectedGanttTaskId = '';
  const draft = selected || { title:'', threadId:'', startDate:'', endDate:'', progress:0, status:'not-started', owners:[], dependencyIds:[] };
  const parsed = tasks.map(task => ({ task, start:Date.parse(`${task.startDate}T00:00:00Z`), end:Date.parse(`${task.endDate}T00:00:00Z`) }));
  const valid = parsed.every(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.start <= item.end);
  const min = valid && parsed.length ? Math.min(...parsed.map(item => item.start)) : 0;
  const max = valid && parsed.length ? Math.max(...parsed.map(item => item.end)) : 0;
  const span = Math.max(86400000, max - min + 86400000);
  const timeline = !tasks.length ? projectZero('No Gantt tasks','Create a dated task to build this Project timeline.')
    : !valid ? '<div class="project-error" role="alert">Some stored task dates are malformed. The table remains available; edit the affected records before using the timeline.</div>'
      : `<div class="gantt-timeline" role="img" aria-label="Project task timeline from ${esc(new Date(min).toISOString().slice(0,10))} to ${esc(new Date(max).toISOString().slice(0,10))}">
        <header><span>${esc(new Date(min).toISOString().slice(0,10))}</span><strong>Timeline</strong><span>${esc(new Date(max).toISOString().slice(0,10))}</span></header>
        ${parsed.map(({ task, start, end }) => {
          const left = Math.max(0, (start - min) * 100 / span);
          const width = Math.max(2, (end - start + 86400000) * 100 / span);
          return `<button class="gantt-bar-row" onclick="projectGanttEdit('${esc(task.taskId)}')" aria-label="Edit ${esc(task.title)}, ${esc(task.startDate)} through ${esc(task.endDate)}, ${task.progress}% complete"><span>${esc(task.title)}</span><i><b class="${esc(task.status)}" style="left:${left}%;width:${Math.min(100-left,width)}%"><em style="width:${task.progress}%"></em></b></i></button>`;
        }).join('')}</div>`;
  const rows = tasks.map(task => {
    const thread = threads.find(candidate => candidate.threadId === task.threadId);
    const dependencies = task.dependencyIds.map(id => tasks.find(candidate => candidate.taskId === id)?.title || id);
    return `<tr><th scope="row"><button class="gantt-title-button" onclick="projectGanttEdit('${esc(task.taskId)}')">${esc(task.title)}</button><small>${esc(task.taskId)}</small></th><td>${esc(thread?.name || 'Project')}</td><td>${esc(task.startDate)} → ${esc(task.endDate)}</td><td><span class="gantt-status ${esc(task.status)}">${esc(task.status)}</span> ${task.progress}%</td><td>${esc(task.owners.map(owner => `${owner.name} (${owner.role})`).join(', ') || '—')}</td><td>${esc(dependencies.join(', ') || '—')}</td><td><button class="tbtn" onclick="projectGanttEdit('${esc(task.taskId)}')">Edit</button><button class="tbtn danger" onclick="projectGanttDelete('${esc(task.taskId)}')">Delete</button></td></tr>`;
  }).join('');
  const form = `<form class="gantt-editor" onsubmit="event.preventDefault();projectGanttSave(this.querySelector('[type=submit]'))">
    <header><div><span>${selected ? 'Update scheduled work' : 'Add scheduled work'}</span><strong>${selected ? esc(selected.title) : 'New Gantt task'}</strong></div>${selected ? `<button type="button" class="tbtn" onclick="projectGanttCancel()">Cancel</button>` : ''}</header>
    <label>Title<input id="gantt-title" required maxlength="200" value="${esc(draft.title)}"></label>
    <label>Thread<select id="gantt-thread"><option value="">Project-level</option>${threads.map(thread => `<option value="${esc(thread.threadId)}" ${thread.threadId === draft.threadId ? 'selected' : ''}>${esc(thread.name)}</option>`).join('')}</select></label>
    <label>Start<input id="gantt-start" type="date" required value="${esc(draft.startDate)}"></label>
    <label>End<input id="gantt-end" type="date" required value="${esc(draft.endDate)}"></label>
    <label>Status<select id="gantt-status">${[['not-started','Not started'],['in-progress','In progress'],['blocked','Blocked'],['completed','Completed']].map(([value,label]) => `<option value="${value}" ${draft.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <label>Progress<input id="gantt-progress" type="number" min="0" max="100" step="1" required value="${Number(draft.progress)}"></label>
    <label class="wide">Owners and roles<input id="gantt-owners" value="${esc((draft.owners || []).map(owner => `${owner.name}:${owner.role}`).join(', '))}" placeholder="Alex:Owner, Sam:Reviewer"><small>Comma-separated Name:Role pairs.</small></label>
    <label class="wide">Dependencies<select id="gantt-dependencies" multiple size="${Math.min(5, Math.max(2, tasks.length))}">${tasks.filter(task => task.taskId !== selectedGanttTaskId).map(task => `<option value="${esc(task.taskId)}" ${(draft.dependencyIds || []).includes(task.taskId) ? 'selected' : ''}>${esc(task.title)}</option>`).join('')}</select><small>Use Ctrl/Cmd or Shift to select multiple tasks.</small></label>
    <footer><button class="pk-button primary" type="submit" data-pending-label="Saving…">${selected ? 'Update task' : 'Create task'}</button></footer>
  </form>`;
  return `<div class="gantt-workspace">${timeline}<div class="gantt-table-wrap">${tasks.length ? `<table class="gantt-table"><caption class="sr-only">Gantt tasks for ${esc(project.name)}</caption><thead><tr><th>Task</th><th>Scope</th><th>Dates</th><th>Status</th><th>Owners</th><th>Depends on</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>` : ''}</div>${form}</div>`;
}

function projectSectionBody(project, threads, recipes) {
  const executions = projectTodoExecutions(project);
  const activeAgents = new Set(executions.filter(execution => execution.agent.state === 'Running').map(execution => execution.agent.id)).size;
  const totals = executions.reduce((result, execution) => {
    const summary = todoExecutionSummary(execution);
    result.completed += summary.completed; result.remaining += summary.remaining; result.total += summary.total;
    return result;
  }, { completed:0, remaining:0, total:0 });
  if (projectRoute.section === 'Overview') return `
    <div class="project-metrics" aria-label="Project counts">
      <div><strong>${threads.length}</strong><span>Threads</span></div><div><strong>${totals.completed}</strong><span>Todos complete</span></div><div><strong>${totals.remaining}</strong><span>Todos remaining</span></div><div><strong>${activeAgents}</strong><span>Active Agents</span></div>
    </div>
    <section class="project-band"><h3>Current Todos</h3>${executions.length ? executions.map(execution => { const summary = todoExecutionSummary(execution); return `<button class="project-current-todo" onclick="projectSection('Todos')"><span><strong>${esc(summary.current?.title || execution.task)}</strong><small>${esc(execution.agent.name)} · ${summary.completed} complete · ${summary.remaining} remaining</small></span><span class="codicon codicon-chevron-right"></span></button>`; }).join('') : projectZero('No active Todos','Todo executions associated with this Project will appear here.')}</section>
    <section class="project-band"><h3>Threads</h3>${threads.length ? `<div class="project-thread-compact">${threads.map(thread => `<button onclick="projectOpenThread('${esc(thread.threadId)}')"><span>${esc(thread.name)}</span><small>${thread.systemKind ? 'System · General' : 'Thread'}</small></button>`).join('')}</div>` : projectZero('No Threads','Create a Thread to begin project work.')}</section>`;
  if (projectRoute.section === 'Todos') {
    const label = projectRoute.workflowView;
    return `<div class="project-subnav" role="tablist" aria-label="Todo views"><button class="${label === 'Todos' ? 'active' : ''}" onclick="projectWorkflowView('Todos')">Todos</button><button class="${label === 'Recipes' ? 'active' : ''}" onclick="projectWorkflowView('Recipes')">Recipes</button></div>${label === 'Recipes' ? projectRecipeBody(recipes,'Recipes owned by this Project will appear here.') : projectTodoBody(project)}`;
  }
  if (projectRoute.section === 'Threads') return (threads.length ? `<div class="project-thread-list">${threads.map(thread => `
    <div class="project-thread-row"><div><strong>${esc(thread.name)}</strong><span>${thread.systemKind === 'general-thread' ? 'System · General Thread' : thread.archived ? 'Archived Thread' : 'Thread'}${thread.chatroom ? ` · Chatroom ${esc(thread.chatroom.roomId.slice(0,8))}` : ''}</span></div>
      <select aria-label="Move ${esc(thread.name)} to Project" onchange="projectMoveThread('${esc(thread.threadId)}',this.value)" ${thread.systemKind === 'general-thread' ? 'disabled title="General Thread cannot move"' : ''}><option value="">Move to…</option>${projectSnapshot.projects.filter(candidate => candidate.projectId !== project.projectId).map(candidate => `<option value="${esc(candidate.projectId)}">${esc(candidate.name)}</option>`).join('')}</select>
      ${thread.systemKind === 'general-thread' ? '' : `<button class="tbtn" onclick="projectRenameThread('${esc(thread.threadId)}')">Rename</button>`}
      <button class="tbtn" onclick="projectOpenThread('${esc(thread.threadId)}')">${thread.chatroom ? 'Open Chatroom' : 'Open in Chatroom'}</button></div>`).join('')}</div>` : projectZero('No Threads','Create a Thread to open a focused collaboration surface.')) + projectCollaborationBody(project, threads);
  if (projectRoute.section === 'Gantt') return projectGanttBody(project, threads);
  if (projectRoute.section === 'Agents') return executions.length ? `<div class="project-agent-list">${executions.map(execution => { const summary = todoExecutionSummary(execution); return `<div><span><i class="agent-live-dot"></i><strong>${esc(execution.agent.name)}</strong><small>${esc(execution.task)}</small></span><b>${summary.completed} complete · ${summary.remaining} remaining</b></div>`; }).join('')}</div>` : projectZero('No linked Agents','Agents appear here when they own Todos associated with this Project.');
  const zero = {
    Artifacts:['No Artifacts','Outputs produced by project work will appear here.'],
    Decisions:['No Decisions','Recorded project decisions will appear here.']
  }[projectRoute.section];
  return projectZero(zero[0], zero[1]);
}

function renderProjects() {
  if (state.tab !== 'projects') return;
  const detail = document.getElementById('detail');
  if (!projectSnapshot) { detail.innerHTML = '<div class="empty">Revealing the Projects map…</div>'; return; }
  normalizeProjectRoute(projectSnapshot);
  const project = projectSnapshot.projects.find(candidate => candidate.projectId === projectRoute.projectId) || projectDefault(projectSnapshot);
  if (!project) { detail.innerHTML = projectZero('Projects unavailable','The Project store did not provide a system Default Project.'); return; }
  const threads = projectSnapshot.threads.filter(thread => thread.projectId === project.projectId);
  const recipes = (projectSnapshot.recipes || []).filter(recipe => recipe.scope !== 'global' && recipe.projectId === project.projectId);
  const executions = projectTodoExecutions(project);
  const activeAgents = new Set(executions.filter(execution => execution.agent.state === 'Running').map(execution => execution.agent.id)).size;
  detail.innerHTML = `<div class="projects-workspace ${projectTreeCollapsed ? 'cattree-collapsed' : ''}">
    <aside class="project-tree" aria-label="Projects"><div class="project-tree-head"><strong>Projects</strong><button class="tbtn" onclick="projectNew()">New Project</button></div>
      ${projectSnapshot.projects.map(candidate => `<button class="project-tree-item ${candidate.projectId === project.projectId ? 'active' : ''}" onclick="projectSelect('${esc(candidate.projectId)}')"><span>${esc(candidate.name)}</span><small>${candidate.systemKind === 'default-project' ? 'System · Default' : `${projectSnapshot.threads.filter(thread => thread.projectId === candidate.projectId).length} Threads`}</small></button>`).join('')}</aside>${workspaceCatTreeDivider('projects',projectTreeCollapsed)}
    <div class="project-content"><header class="project-header"><div><span>${project.systemKind === 'default-project' ? 'System Project' : 'Project'}</span><h2>${esc(project.name)}</h2><p>${threads.length} Threads · ${executions.length} Todo Executions · ${activeAgents} Active Agents</p></div><button class="tbtn" onclick="projectNewThread()">New Thread</button></header>
      <nav class="project-sections" aria-label="Project sections">${projectSections.map(section => `<button class="${section === projectRoute.section ? 'active' : ''}" onclick="projectSection('${section}')">${section}</button>`).join('')}</nav>
      <div class="project-section-body">${projectSectionBody(project, threads, recipes)}</div>
    </div></div>`;
}

function renderGlobalRecipes() {
  if (state.tab !== 'recipes') return;
  if (!recipeEnvironmentListRequested) { recipeEnvironmentListRequested = true; ask('envList', {}); }
  if (!recipeSubscriptionGroupsRequested) { recipeSubscriptionGroupsRequested = true; ask('recipeSubscriptionGroups', {}); }
  const detail = document.getElementById('detail');
  if (!projectSnapshot) { detail.innerHTML = '<div class="empty">Opening the Recipes grimoire…</div>'; return; }
  const recipes = (projectSnapshot.recipes || []).filter(recipe => recipe.scope === 'global');
  const recipeTrash = (projectSnapshot.recipeTrash || []).filter(recipe => recipe.scope === 'global');
  if (!recipes.some(recipe => recipe.recipeId === selectedRecipeId)) selectedRecipeId = recipes[0]?.recipeId || '';
  const selected = recipes.find(recipe => recipe.recipeId === selectedRecipeId);
  const recipeTrashList = recipeTrash.map(recipe => `<div class="li cattree-item recipe-trash-row" oncontextmenu="recipeTrashItemMenu(event,decodeURIComponent('${encodeURIComponent(recipe.recipeId)}'))"><div><strong>${esc(recipe.name)}</strong><small>${esc(recipe.category || 'Uncategorized')}</small></div><button class="cattree-item-menu" title="Trash actions" aria-label="Trash actions for ${esc(recipe.name)}" onclick="event.stopPropagation();recipeTrashItemMenu(event,decodeURIComponent('${encodeURIComponent(recipe.recipeId)}'))"><span class="codicon codicon-ellipsis"></span></button></div>`).join('');
  detail.innerHTML = `<div class="global-recipes-workspace"><header class="project-header"><div><span>Automation</span><h2>Recipe Library</h2><p>${recipes.length} reusable Recipes</p></div><div class="project-header-actions"><button class="recipe-icon-button" title="Refresh Recipe Library" aria-label="Refresh Recipe Library" onclick="recipeRefresh()"><span class="codicon codicon-refresh"></span></button><button class="tbtn" onclick="projectNewRecipe()">New Recipe</button></div></header><div class="recipe-library-workbench ${recipeTreeCollapsed ? 'cattree-collapsed' : ''}" style="--recipe-tree-width:${recipeTreeWidth}px"><aside class="recipe-library-tree"><div class="recipe-search pkm-search-field"><span class="codicon codicon-search pkm-search-icon"></span><input type="search" value="${esc(recipeSearchQuery)}" placeholder="Search Recipes and Steps" aria-label="Search Recipes" oninput="recipeSearch(this.value)"><button class="recipe-search-clear${recipeSearchQuery ? '' : ' hidden'}" title="Clear Recipe search" aria-label="Clear Recipe search" onclick="recipeSearchClear()"><span class="codicon codicon-close"></span></button></div><div class="recipe-library-tree-scroll" oncontextmenu="if(event.target===this)recipeRootMenu(event)">${globalRecipeTree(recipes)}</div>${catTreeTrashDock('Trash', recipeTrash.length, recipeTrashList)}</aside>${workspaceCatTreeDivider('recipes',recipeTreeCollapsed,true)}<main class="recipe-library-editor">${globalRecipeEditor(selected)}</main></div></div>`;
  renderSubscribedGroups(detail.querySelector('.recipe-library-tree-scroll'), recipeSubscriptionGroups, 'recipes');
  if (typeof detail.querySelector === 'function') detail.querySelector('.recipe-search input')?.setAttribute('placeholder', `Search ${RecipeGraph.terms.recipe}s and ${RecipeGraph.terms.modules}`);
  if (recipeGraphResizeObserver) recipeGraphResizeObserver.disconnect();
  recipeGraphResizeObserver = null;
  const graphCanvas = typeof detail.querySelector === 'function' ? detail.querySelector('.recipe-graph-canvas') : null;
  if (graphCanvas && typeof ResizeObserver !== 'undefined') {
    recipeGraphResizeObserver = new ResizeObserver(recipeGraphLayoutLinks);
    recipeGraphResizeObserver.observe(graphCanvas);
  }
  recipeGraphApplyLayout();
  recipeGraphLayoutLinks();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(recipeGraphLayoutLinks);
}

function recipeSubscriptionGroupsOnResult(groups) {
  recipeSubscriptionGroups = Array.isArray(groups) ? groups : [];
  recipeSubscriptionGroupsRequested = true;
  if (state.tab === 'recipes') renderGlobalRecipes();
}

function invalidateRecipeSubscriptionGroups() {
  recipeSubscriptionGroups = [];
  recipeSubscriptionGroupsRequested = false;
  if (state.tab === 'recipes') renderGlobalRecipes();
}

function recipeRefresh() {
  ask('projectState', {});
}

function recipeSnapshotSignature(snapshot) {
  return JSON.stringify({
    recipes:snapshot?.recipes || [],
    recipeFolders:snapshot?.recipeFolders || [],
    recipeTrash:snapshot?.recipeTrash || [],
    privateTopLevels:snapshot?.privateTopLevels || [],
    referenceCatalog:snapshot?.referenceCatalog || []
  });
}

function agentSessionSnapshotSignature(snapshot) {
  return JSON.stringify({
    agentSessions:snapshot?.agentSessions || [],
    agentSessionTrash:snapshot?.agentSessionTrash || []
  });
}

function projectOnState(snapshot) {
  agentSessionRefreshRequestedAt = 0;
  const agentSessionStateChanged = state.tab !== 'agentSessions' || !projectSnapshot || projectSnapshotDirty
    || agentSessionSnapshotSignature(snapshot) !== agentSessionSnapshotSignature(projectSnapshot);
  const recipeViewState = state.tab === 'recipes' ? recipeCaptureViewState() : null;
  const recipeStateChanged = state.tab !== 'recipes' || !projectSnapshot
    || recipeSnapshotSignature(snapshot) !== recipeSnapshotSignature(projectSnapshot);
  projectSnapshot = snapshot;
  projectSnapshotDirty = false;
  finishAction('agentSnapshotDelete','agentSessionTrash','agentSessionStop');
  normalizeProjectRoute(snapshot);
  if (state.tab === 'agentSessions') {
    if (!agentSessionStateChanged) return;
    renderAgentSessions();
  }
  else if (state.tab === 'agentSnapshots') renderAgentSnapshots();
  else if (state.tab === 'recipes') {
    if (!recipeStateChanged) return;
    renderGlobalRecipes();
    recipeRestoreViewState(recipeViewState);
  } else renderProjects();
}

function projectOnResult(data) {
  projectSnapshotDirty = false;
  projectSnapshot = data.snapshot;
  finishAction('projectCreate','threadCreate','threadRename','threadMove','threadOpenChatroom','ganttTaskCreate','ganttTaskUpdate','ganttTaskDelete','collaborationCreate','collaborationTransition','recipeCreate','recipeFolderCreate','recipeFolderDelete','recipeUpdate','recipeDelete','recipeTrash','recipeOpenBrowser');
  const recipeViewState = data.action === 'recipeUpdate' ? recipePendingViewState || recipeCaptureViewState() : null;
  if (data.action === 'recipeUpdate') { recipeDraft = null; recipeDraftRecipeId = ''; recipeDraftBaseline = ''; recipeDraftBaselinePending = false; recipePendingViewState = null; recipeGraphPendingNodeIds.clear(); }
  if (data.action === 'recipeDelete' && selectedRecipeId === data.entityId) { selectedRecipeId = ''; recipeDraft = null; recipeDraftRecipeId = ''; recipeDraftBaseline = ''; recipeDraftBaselinePending = false; }
  if (data.action === 'recipeTrash' && selectedRecipeId === data.entityId && !data.snapshot.recipes.some(recipe => recipe.recipeId === data.entityId)) { selectedRecipeId = ''; recipeDraft = null; recipeDraftRecipeId = ''; recipeDraftBaseline = ''; recipeDraftBaselinePending = false; }
  if (data.action === 'projectCreate') { projectRoute.projectId = data.entityId; projectRoute.section = 'Overview'; }
  if (data.action === 'threadCreate') projectRoute.section = 'Threads';
  if (data.action === 'threadOpenChatroom') document.querySelector('.tab[data-tab="chatroom"]')?.dispatchEvent(new MouseEvent('click'));
  if (data.action === 'ganttTaskCreate') { projectRoute.section = 'Gantt'; selectedGanttTaskId = data.entityId; }
  if (data.action === 'ganttTaskUpdate') selectedGanttTaskId = '';
  if (data.action === 'ganttTaskDelete' && selectedGanttTaskId === data.entityId) selectedGanttTaskId = '';
  if (data.action === 'recipeCreate' && state.tab === 'projects') { projectRoute.section = 'Todos'; projectRoute.workflowView = 'Recipes'; }
  if (data.action === 'recipeCreate' && state.tab === 'recipes') selectedRecipeId = data.entityId;
  normalizeProjectRoute(projectSnapshot);
  if (state.tab === 'agentSessions') renderAgentSessions(); else if (state.tab === 'agentSnapshots') renderAgentSnapshots(); else if (state.tab === 'recipes') renderGlobalRecipes(); else renderProjects();
  recipeRestoreViewState(recipeViewState);
}

function projectOnError(data) {
  if (data?.action === 'recipeOpenBrowser') failAction(data?.error || 'The Recipe workbench could not be opened.', 'recipeOpenBrowser');
  else if (data?.action === 'agentSessionTrash') failAction(data?.error || 'The Agent Session Trash action failed.', 'agentSessionTrash');
  else if (data?.action === 'agentSessionStop') failAction(data?.error || 'The Agent Session could not be stopped.', 'agentSessionStop');
  else finishAction('projectCreate','threadCreate','threadRename','threadMove','threadOpenChatroom','ganttTaskCreate','ganttTaskUpdate','ganttTaskDelete','collaborationCreate','collaborationTransition','recipeCreate','recipeFolderCreate','recipeFolderDelete','recipeUpdate','recipeValidateDefinition');
  const editorError = state.tab === 'recipes' ? document.getElementById('recipe-edit-error') : null;
  if (editorError) {
    const diagnostics = Array.isArray(data?.details?.diagnostics) ? data.details.diagnostics : [];
    const cycles = diagnostics.filter(diagnostic => diagnostic?.code === 'E3203');
    if (cycles.length) {
      editorError.textContent = cycles.map(diagnostic => {
        const details = diagnostic.details || {};
        const cycle = details.cycle || (Array.isArray(details.witness) ? details.witness.join(' → ') : 'Unknown cycle');
        const edge = details.suggestedLoopEdge;
        const suggestion = edge?.from && edge?.to
          ? `If this is an intentional while loop, mark ${edge.from} → ${edge.to} as the loop edge and provide both an exit condition and a positive maximum iteration count.`
          : 'If this is an intentional while loop, mark one back-edge as the loop edge and provide both an exit condition and a positive maximum iteration count.';
        return `Cycle detected: ${cycle}. Every connection in this path depends on the next, so execution cannot start or finish. ${suggestion}`;
      }).join('\n');
    } else {
      editorError.textContent = diagnostics.length
        ? diagnostics.map(diagnostic => `${diagnostic.code} ${diagnostic.pointer || '/'} · ${diagnostic.details?.expected || diagnostic.messageTemplateId || 'Invalid workflow definition'}`).join('\n')
        : data?.error || 'Recipe update failed.';
    }
    return;
  }
  const host = document.querySelector('.project-header') || document.getElementById('detail');
  host?.querySelector('.project-error')?.remove();
  const error = document.createElement('div'); error.className = 'project-error'; error.setAttribute('role','alert'); error.textContent = data?.error || 'Project action failed.';
  host?.appendChild(error);
}