// ── Projects workspace ─────────────────────────────────────────────────────
const projectSections = ['Overview','Todos','Threads','Agents','Artifacts','Decisions'];
let projectSnapshot = null;
let projectSnapshotDirty = false;
let projectRoute = { projectId:'', section:'', workflowView:'' };
let selectedAgentSessionId = '';
let selectedAgentSnapshotId = '';
let agentSnapshotCredential = null;
let agentSessionArchiveExpanded = vscode.getState()?.agentSessionArchiveExpanded;
let agentSessionTreeCollapsed = !!vscode.getState()?.agentSessionTreeCollapsed;
let projectTreeCollapsed = !!vscode.getState()?.projectTreeCollapsed;
let agentDashboardStep = 'implement';
let agentTechExpanded = { root:true, implement:false };
let recipeSearchQuery = '';
let selectedRecipeId = '';
let recipeEditorMode = 'graph';
let recipeDraft = null;
let recipeDraftRecipeId = '';
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
const recipeReferenceSelectedKeys = new Set();
let recipeGraphKeyboardBound = false;
let recipeEnvironmentListRequested = false;
const recipeGraphBoundaryOffset = 84;
const recipeGraphColumnPitch = 258;
const recipeGraphRowPitch = 114;
const recipeGraphExpandedNodes = new Set();
const recipeModuleTemplates = {
  single:{ label:'Step', kind:'pkm.step.noop/v1', config:{}, ports:{ inputs:['input'], outputs:['output'] }, control:{ mode:'single' } },
  repeat:{ label:'Repeat', kind:'pkm.step.noop/v1', config:{}, ports:{ inputs:['items'], outputs:['result'] }, control:{ mode:'repeat', count:{ kind:'fixed', value:2 } } },
  if:{ label:'If / Else', kind:'pkm.step.noop/v1', config:{}, ports:{ inputs:['condition'], outputs:['yes','no'] }, control:{ mode:'branch', kind:'if', cases:['yes','no'] } },
  switch:{ label:'Switch', kind:'pkm.step.noop/v1', config:{}, ports:{ inputs:['value'], outputs:['case1','default'] }, control:{ mode:'branch', kind:'switch', cases:['case1','default'] } },
  command:{ label:'Background command', kind:'pkm.step.command/v1', config:{ program:'python3', args:[], timeoutSeconds:300, maxOutputBytes:65536 }, ports:{ inputs:['parameters'], outputs:['result'] }, control:{ mode:'single' } },
  script:{ label:'Executable script', kind:'pkm.step.script/v1', config:{ runtime:'bash', script:'set -e\n', timeoutSeconds:300, maxOutputBytes:65536 }, ports:{ inputs:['parameters'], outputs:['result'] }, control:{ mode:'single' } },
  human:{ label:'Required user input', kind:'pkm.gate.human/v1', config:{ prompt:'Do you approve continuing?', inputKind:'approval' }, ports:{ inputs:['request'], outputs:['approved','rejected'] }, control:{ mode:'single' } }
};

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

function agentSessionGroupToggle(group, open) {
  if (group === 'archive') agentSessionArchiveExpanded = !!open;
  const persisted = vscode.getState() || {};
  vscode.setState({ ...persisted, agentSessionArchiveExpanded });
}

function agentSessionSelect(sessionId) {
  selectedAgentSessionId = String(sessionId || '');
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
    recoveryPrompt:String(data.recoveryPrompt || '')
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
  showPaperMenu(event.clientX, event.clientY, [
    { label:session?.task || sessionId, header:true },
    recipeCopyPathMenu(`pkm://agent-sessions/${encodeURIComponent(sessionId)}`),
    recipeCopyPathMenu(sessionId, 'Copy Session ID'),
    { sep:true },
    { label:'Move to Trash…', danger:true, onClick:()=>pkModal({
    title:'Move Agent Session to Trash?',
    message:`${sessionId}\n\n${status === 'running' ? 'This Session is still running. Moving its record does not stop the Agent or delete Recipe run evidence.\n\n' : ''}The Session remains recoverable from Agent Sessions Trash.`,
    okLabel:'Move to Trash', danger:true,
    onOk:()=>ask('agentSessionTrash',{action:'move',sessionId})
  }) }], 'agent-session-context-menu');
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
  recipeGraphSelectedEdge = null;
  recipeGraphSelectedNodes.clear();
  recipeGraphSelectedEdges.clear();
  renderGlobalRecipes();
}

function recipeEnsureDraft(recipe) {
  if (recipeDraft && recipeDraftRecipeId === recipe.recipeId) return recipeDraft;
  recipeDraftRecipeId = recipe.recipeId;
  recipeDraft = JSON.parse(JSON.stringify({
    name:recipe.name, category:recipe.category || '', description:recipe.description || '',
    metadata:recipe.metadata || { applicableFunctions:[], solution:'', requiredInputs:[], expectedOutputs:[] },
    editorLayout:recipe.editorLayout || { nodePositions:{} },
    definition:recipe.definition, nodeBindings:recipe.nodeBindings || []
  }));
  const nodes = recipeDraft.definition?.spec?.nodes || [];
  const positions = recipeDraft.editorLayout?.nodePositions || {};
  if (nodes.some(node => !Number.isFinite(positions[node.nodeId]?.x) || !Number.isFinite(positions[node.nodeId]?.y))) {
    recipeDraft.editorLayout = { nodePositions:recipeGraphOrganizedPositions(nodes) };
  }
  return recipeDraft;
}

function recipeDraftField(field, value) { if (recipeDraft) recipeDraft[field] = String(value || ''); }
function recipeDraftFunctions(value) { if (recipeDraft) recipeDraft.metadata.applicableFunctions = String(value || '').split(/[,\n]/).map(item => item.trim()).filter(Boolean); }
function recipeDraftSolution(value) { if (recipeDraft) recipeDraft.metadata.solution = String(value || ''); }
function recipeDraftMetadataField(collection, index, field, value) {
  if (!recipeDraft?.metadata?.[collection]?.[index]) return;
  recipeDraft.metadata[collection][index][field] = field === 'required' ? !!value : String(value || '');
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
  pkModal({ title:'Add Module', message:'Choose a module type, then enter a stable ID.', input:true, options:Object.entries(recipeModuleTemplates).map(([value, template]) => ({ value, label:template.label })), okLabel:'Add', onOk:(value, _text, _checked, selectedType) => {
    const nodeId = String(value || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(nodeId) || recipeDraft.definition.spec.nodes.some(node => node.nodeId === nodeId)) return;
    const template = recipeModuleTemplates[selectedType] || recipeModuleTemplates.single;
    recipeDraft.definition.spec.nodes.push({ nodeId, kind:template.kind, config:JSON.parse(JSON.stringify(template.config)), dependsOn:[], ports:JSON.parse(JSON.stringify(template.ports)), control:JSON.parse(JSON.stringify(template.control)) });
    const index = recipeDraft.definition.spec.nodes.length - 1;
    recipeDraft.editorLayout ||= { nodePositions:{} };
    recipeDraft.editorLayout.nodePositions[nodeId] = recipeGraphDefaultPosition(index);
    recipeRerenderPreservingView();
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
  recipeDraft.definition.spec.nodes = nodes.filter(node => !selectedIds.has(node.nodeId)).map(node => ({ ...node, dependsOn:(node.dependsOn || []).filter(dependency => !selectedIds.has(dependency.from)) }));
  recipeDraft.definition.spec.completion.requiredNodes = recipeDraft.definition.spec.completion.requiredNodes.filter(id => !selectedIds.has(id));
  if (!recipeDraft.definition.spec.completion.requiredNodes.length) recipeDraft.definition.spec.completion.requiredNodes = [recipeDraft.definition.spec.nodes.at(-1).nodeId];
  if (recipeDraft.editorLayout?.nodePositions) for (const nodeId of selectedIds) delete recipeDraft.editorLayout.nodePositions[nodeId];
  recipeGraphSelectedNodes.clear();
  recipeGraphSelectedEdges.clear();
  recipeGraphSelectedEdge = null;
  recipeRerenderPreservingView();
}
function recipeGraphDefaultPosition(index) { return { x:24 + (index % 3) * recipeGraphColumnPitch, y:24 + Math.floor(index / 3) * recipeGraphRowPitch }; }
function recipeGraphOrganizedPositions(nodes) {
  if (!nodes.length) return {};
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const indegree = new Map(nodes.map(node => [node.nodeId, 0]));
  const outgoing = new Map(nodes.map(node => [node.nodeId, []]));
  for (const node of nodes) for (const dependency of node.dependsOn || []) {
    if (dependency.loop || !byId.has(dependency.from)) continue;
    indegree.set(node.nodeId, indegree.get(node.nodeId) + 1);
    outgoing.get(dependency.from).push(node.nodeId);
  }
  const rank = new Map(nodes.map(node => [node.nodeId, 0]));
  const queue = nodes.filter(node => indegree.get(node.nodeId) === 0).map(node => node.nodeId);
  const visited = new Set();
  while (queue.length) {
    const sourceId = queue.shift();
    visited.add(sourceId);
    for (const targetId of outgoing.get(sourceId)) {
      rank.set(targetId, Math.max(rank.get(targetId), rank.get(sourceId) + 1));
      indegree.set(targetId, indegree.get(targetId) - 1);
      if (indegree.get(targetId) === 0) queue.push(targetId);
    }
  }
  const fallbackRank = Math.max(0, ...rank.values()) + 1;
  nodes.filter(node => !visited.has(node.nodeId)).forEach(node => rank.set(node.nodeId, fallbackRank));
  const rows = new Map();
  for (const node of nodes) {
    const level = rank.get(node.nodeId);
    if (!rows.has(level)) rows.set(level, []);
    rows.get(level).push(node.nodeId);
  }
  const positions = {};
  const widestRow = Math.max(1, ...[...rows.values()].map(nodeIds => nodeIds.length));
  for (const [level, nodeIds] of [...rows.entries()].sort((left, right) => left[0] - right[0])) {
    const rowOffset = (widestRow - nodeIds.length) * recipeGraphColumnPitch / 2;
    nodeIds.forEach((nodeId, index) => { positions[nodeId] = { x:24 + rowOffset + index * recipeGraphColumnPitch, y:24 + level * recipeGraphRowPitch }; });
  }
  return positions;
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
  const move = moveEvent => {
    const deltaX = (moveEvent.clientX - startX) / recipeGraphZoom;
    const deltaY = (moveEvent.clientY - startY) / recipeGraphZoom;
    for (const [selectedId, origin] of moving) {
      const position = { x:Math.max(0, Math.round(origin.x + deltaX)), y:Math.max(0, Math.round(origin.y + deltaY)) };
      recipeDraft.editorLayout.nodePositions[selectedId] = position;
      const selectedCard = canvas.querySelector(`.recipe-graph-node[data-node-id="${CSS.escape(selectedId)}"]`);
      if (selectedCard) { selectedCard.style.left = `${position.x}px`; selectedCard.style.top = `${position.y + recipeGraphBoundaryOffset}px`; }
    }
    recipeGraphSizeCanvas(canvas);
    recipeGraphLayoutLinks();
  };
  const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop, { once:true });
}
function recipeGraphEdgeKey(sourceId, targetId) { return `${sourceId}\u0000${targetId}`; }
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
  if (event.button !== 0 || event.target.closest?.('.recipe-graph-node') || event.target.closest?.('.recipe-edge-inspector')) return;
  const canvas = event.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  const previous = event.shiftKey ? new Set(recipeGraphSelectedNodes) : new Set();
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
  for (const node of recipeDraft.definition.spec.nodes) node.dependsOn = (node.dependsOn || []).filter(dependency => !recipeGraphSelectedEdges.has(recipeGraphEdgeKey(dependency.from, node.nodeId)));
  recipeGraphSelectedEdges.clear();
  recipeGraphSelectedEdge = null;
  renderGlobalRecipes();
}
function recipeGraphBindKeyboard() {
  if (recipeGraphKeyboardBound || !document.addEventListener) return;
  recipeGraphKeyboardBound = true;
  document.addEventListener('keydown', event => {
    if (!['Delete','Backspace'].includes(event.key) || event.target?.closest?.('input,textarea,select,[contenteditable="true"]') || document.getElementById('pk-modal-bg')) return;
    if (!recipeGraphSelectedNodes.size && !recipeGraphSelectedEdges.size) return;
    event.preventDefault();
    recipeGraphDeleteSelection();
  });
}
function recipeGraphSizeCanvas(canvas) {
  const cards = [...canvas.querySelectorAll('.recipe-graph-node')];
  const height = cards.reduce((maximum, card) => Math.max(maximum, (parseFloat(card.style.top) || 0) + card.offsetHeight + 118), 360);
  const width = cards.reduce((maximum, card) => Math.max(maximum, (parseFloat(card.style.left) || 0) + card.offsetWidth + 34), 720);
  canvas.style.height = `${height}px`;
  canvas.style.width = `${width}px`;
}
function recipeGraphMountBoundaries(canvas) {
  const cards = new Map([...canvas.querySelectorAll('.recipe-graph-node')].map(card => [card.dataset.nodeId, card]));
  if (!cards.size) return;
  const nodes = recipeDraft.definition.spec.nodes;
  const incoming = new Set();
  const outgoing = new Set();
  for (const node of nodes) for (const dependency of node.dependsOn || []) {
    if (dependency.loop) continue;
    incoming.add(node.nodeId);
    outgoing.add(dependency.from);
  }
  const roots = nodes.filter(node => !incoming.has(node.nodeId));
  const terminals = nodes.filter(node => !outgoing.has(node.nodeId));
  const averageCenterX = selected => selected.reduce((sum, node) => {
    const card = cards.get(node.nodeId);
    return sum + (parseFloat(card?.style.left) || 0) + (card?.offsetWidth || 240) / 2;
  }, 0) / Math.max(1, selected.length);
  const maximumBottom = Math.max(...[...cards.values()].map(card => (parseFloat(card.style.top) || 0) + (card.offsetHeight || 70)));
  let source = canvas.querySelector('[data-graph-boundary="source"]');
  if (!source) {
    source = document.createElement('div');
    source.className = 'recipe-graph-boundary source';
    source.dataset.graphBoundary = 'source';
    source.innerHTML = '<span class="codicon codicon-debug-start"></span><strong>Input</strong>';
    canvas.appendChild(source);
  }
  source.style.left = `${Math.max(12, averageCenterX(roots) - 38)}px`;
  source.style.top = '12px';
  let sink = canvas.querySelector('[data-graph-boundary="sink"]');
  if (!sink) {
    sink = document.createElement('div');
    sink.className = 'recipe-graph-boundary sink';
    sink.dataset.graphBoundary = 'sink';
    sink.innerHTML = '<strong>Output</strong><span class="codicon codicon-debug-stop"></span>';
    canvas.appendChild(sink);
  }
  sink.style.left = `${Math.max(12, averageCenterX(terminals) - 38)}px`;
  sink.style.top = `${maximumBottom + 42}px`;
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
    instruction.innerHTML = '<span>Intent & guidance</span><small>Start with a brief purpose; continue with as much reusable guidance as this step needs.</small><textarea rows="6" required placeholder="Brief: what this step must accomplish. Add detailed guidance, constraints, and relevant context as needed."></textarea>';
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
  const heading = header.querySelector('small');
  if (heading) heading.textContent = `${control.mode} module`;
  const glyph = document.createElement('span');
  glyph.className = 'recipe-node-glyph codicon codicon-symbol-method';
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
  overlay.innerHTML = `<section class="recipe-design-surface" onclick="event.stopPropagation()"><header><div><span>Step details</span><h3>${esc(nodeId)}</h3><small>${esc(mode)} module · ${node?.kind === 'pkm.step.noop/v1' ? 'Workflow step' : esc(node?.kind || '')}</small></div><button class="recipe-design-close" title="Close detailed design" aria-label="Close detailed design" onclick="recipeGraphCloseDetails()"><span class="codicon codicon-close"></span></button></header><div class="recipe-design-body"></div><footer><span>Changes remain in the Recipe draft until Save.</span><button class="tbtn" onclick="recipeGraphCloseDetails()">Done</button></footer></section>`;
  overlay.onclick = recipeGraphCloseDetails;
  const body = overlay.querySelector('.recipe-design-body');
  const tabs = document.createElement('nav');
  tabs.className = 'recipe-design-tabs';
  tabs.setAttribute('aria-label', 'Step detail sections');
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
  recipeGraphSizeCanvas(canvas);
  recipeGraphLayoutLinks();
}
function recipeGraphAddToolbarActions() {
  const tools = document.querySelector('.recipe-graph-tools');
  if (!tools || tools.querySelector('[data-recipe-reorganize]')) return;
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
    if (header) { header.title = 'Drag to move · Double-click for detailed design'; header.onpointerdown = event => recipeGraphMoveStart(event, card.dataset.nodeId, index); }
    const connector = card.querySelector('.recipe-drag-handle');
    if (connector) { connector.draggable = true; connector.title = 'Drag onto another module to connect'; }
  });
  recipeGraphMountBoundaries(canvas);
  recipeGraphAddToolbarActions();
  recipeGraphMountDetailsOverlay();
  recipeGraphSizeCanvas(canvas);
}
function recipeGraphDragStart(event, nodeId) { event.dataTransfer.setData('text/plain', nodeId); event.dataTransfer.effectAllowed = 'link'; }
function recipeGraphDragOver(event) { event.preventDefault(); event.dataTransfer.dropEffect = 'link'; event.currentTarget.classList.add('drop-target'); }
function recipeGraphDragLeave(event) { event.currentTarget.classList.remove('drop-target'); }
function recipeGraphDrop(event, targetId) {
  event.preventDefault(); event.currentTarget.classList.remove('drop-target');
  const sourceId = event.dataTransfer.getData('text/plain');
  const target = recipeDraft.definition.spec.nodes.find(node => node.nodeId === targetId);
  if (!sourceId || !target || (target.dependsOn || []).some(dependency => dependency.from === sourceId)) return;
  const cycle = recipeGraphCyclePath(sourceId, targetId);
  if (cycle) {
    pkModal({
      title:'Create loop connection?',
      message:`${sourceId} → ${targetId} closes a cycle (${cycle.join(' → ')}). Confirm to create an explicit bounded loop edge with an exit condition and maximum iteration count.`,
      okLabel:'Create Loop',
      onOk:() => recipeGraphCommitDependency(sourceId, targetId, true)
    });
    return;
  }
  recipeGraphCommitDependency(sourceId, targetId, false);
}
function recipeGraphCyclePath(sourceId, targetId) {
  if (sourceId === targetId) return [sourceId, targetId];
  const outgoing = new Map((recipeDraft?.definition?.spec?.nodes || []).map(node => [node.nodeId, []]));
  for (const node of recipeDraft?.definition?.spec?.nodes || []) for (const dependency of node.dependsOn || []) {
    if (!dependency.loop && outgoing.has(dependency.from)) outgoing.get(dependency.from).push(node.nodeId);
  }
  const queue = [[targetId, [targetId]]];
  const visited = new Set();
  while (queue.length) {
    const [current, path] = queue.shift();
    if (current === sourceId) return [...path, targetId];
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of outgoing.get(current) || []) queue.push([next, [...path, next]]);
  }
  return null;
}
function recipeGraphCommitDependency(sourceId, targetId, loop) {
  const target = recipeDraft.definition.spec.nodes.find(node => node.nodeId === targetId);
  const source = recipeDraft.definition.spec.nodes.find(node => node.nodeId === sourceId);
  if (!source || !target) return;
  const sourceOutputs = source?.ports?.outputs || ['completion'];
  const targetInputs = target.ports?.inputs || ['dependency'];
  const outcomes = source?.control?.mode === 'branch' ? source.control.cases : ['succeeded'];
  target.dependsOn = [...(target.dependsOn || []), {
    from:sourceId, accept:[outcomes[0]], required:true,
    fromOutput:sourceOutputs[0], toInput:targetInputs[0],
    ...(loop ? { loop:{ termination:{ condition:'done', maxIterations:100 } } } : {})
  }];
  recipeGraphSelectedNodes.clear();
  recipeGraphSelectedEdges.clear();
  recipeGraphSelectedEdges.add(recipeGraphEdgeKey(sourceId, targetId));
  recipeGraphSelectedEdge = { sourceId, targetId };
  recipeRerenderPreservingView();
}
function recipeGraphRemoveDependency(nodeId, sourceId) {
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === nodeId);
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
  const repeatBadge = control.mode === 'repeat' ? `<span class="recipe-repeat-badge">× ${control.count.kind === 'dynamic' ? '?' : control.count.value}</span>` : '';
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
  return `<article class="recipe-graph-node ${control.mode === 'branch' ? 'branch' : ''}" data-node-id="${esc(node.nodeId)}" draggable="true" ondragstart="recipeGraphDragStart(event,decodeURIComponent('${encodeURIComponent(node.nodeId)}'))" ondragover="recipeGraphDragOver(event)" ondragleave="recipeGraphDragLeave(event)" ondrop="recipeGraphDrop(event,decodeURIComponent('${encodeURIComponent(node.nodeId)}'))"><header><span class="recipe-drag-handle" title="Drag this Step onto another Step">⋮⋮</span><div><small>Step ${index + 1}</small><strong>${esc(node.nodeId)}</strong></div><button class="recipe-icon-button" title="Remove Step" aria-label="Remove ${esc(node.nodeId)}" onclick="recipeGraphRemoveStep(decodeURIComponent('${encodeURIComponent(node.nodeId)}'))" ${nodes.length <= 1 ? 'disabled' : ''}><span class="codicon codicon-trash"></span></button></header><div class="recipe-node-mode"><select aria-label="Execution mode" onchange="recipeGraphControlMode(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),this.value)"><option value="single" ${control.mode === 'single' ? 'selected' : ''}>Single</option><option value="repeat" ${control.mode === 'repeat' ? 'selected' : ''}>Repeat</option><option value="branch" ${control.mode === 'branch' ? 'selected' : ''}>Branch</option></select>${controls}</div><div class="recipe-node-ports"><label><span>Inputs</span><input value="${esc(ports.inputs.join(', '))}" placeholder="input1, input2" onblur="recipeGraphNodePorts(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'inputs',this.value)"></label><label><span>Outputs</span><input value="${esc(ports.outputs.join(', '))}" placeholder="output1, output2" onblur="recipeGraphNodePorts(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'outputs',this.value)"></label></div><div class="recipe-port-chips inputs">${ports.inputs.map(port => `<span>${esc(port)}</span>`).join('')}</div><div class="recipe-port-chips outputs">${ports.outputs.map(port => `<span>${esc(port)}</span>`).join('')}</div><div class="recipe-graph-dependencies"><span>Routes</span>${dependencies}</div><label class="recipe-completion"><input type="checkbox" ${completion.has(node.nodeId) ? 'checked' : ''} onchange="recipeGraphCompletion(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),this.checked)"><span>Required for completion</span></label>${repeatBadge}</article>`;
  return `<article class="recipe-graph-node ${control.mode === 'branch' ? 'branch' : ''}" data-node-id="${esc(node.nodeId)}" draggable="true" ondragstart="recipeGraphDragStart(event,decodeURIComponent('${encodeURIComponent(node.nodeId)}'))" ondragover="recipeGraphDragOver(event)" ondragleave="recipeGraphDragLeave(event)" ondrop="recipeGraphDrop(event,decodeURIComponent('${encodeURIComponent(node.nodeId)}'))"><header><span class="recipe-drag-handle" title="Drag this Step onto another Step">⋮⋮</span><div><small>Step ${index + 1}</small><strong>${esc(node.nodeId)}</strong></div><button class="recipe-icon-button" title="Remove Step" aria-label="Remove ${esc(node.nodeId)}" onclick="recipeGraphRemoveStep(decodeURIComponent('${encodeURIComponent(node.nodeId)}'))" ${nodes.length <= 1 ? 'disabled' : ''}><span class="codicon codicon-trash"></span></button></header><label class="recipe-general-instruction"><span>General instruction</span><textarea rows="4" placeholder="Reusable guidance for this module. A concrete workflow can add task-specific instructions later." onblur="recipeGraphGeneralInstruction(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),this.value)">${esc(node.generalInstruction || '')}</textarea></label><div class="recipe-node-mode"><select aria-label="Execution mode" onchange="recipeGraphControlMode(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),this.value)"><option value="single" ${control.mode === 'single' ? 'selected' : ''}>Single</option><option value="repeat" ${control.mode === 'repeat' ? 'selected' : ''}>Repeat</option><option value="branch" ${control.mode === 'branch' ? 'selected' : ''}>Branch</option></select>${controls}</div><div class="recipe-node-ports"><label><span>Inputs</span><input value="${esc(ports.inputs.join(', '))}" placeholder="input1, input2" onblur="recipeGraphNodePorts(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'inputs',this.value)"></label><label><span>Outputs</span><input value="${esc(ports.outputs.join(', '))}" placeholder="output1, output2" onblur="recipeGraphNodePorts(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),'outputs',this.value)"></label></div><div class="recipe-port-chips inputs">${ports.inputs.map(port => `<span>${esc(port)}</span>`).join('')}</div><div class="recipe-port-chips outputs">${ports.outputs.map(port => `<span>${esc(port)}</span>`).join('')}</div><div class="recipe-graph-dependencies"><span>Depends on</span>${dependencies}</div><label class="recipe-completion"><input type="checkbox" ${completion.has(node.nodeId) ? 'checked' : ''} onchange="recipeGraphCompletion(decodeURIComponent('${encodeURIComponent(node.nodeId)}'),this.checked)"><span>Required for Recipe completion</span></label>${repeatBadge}</article>`;
}
function recipeGraphEdgeRoute(startX, startY, endX, endY, outerX) {
  if (Math.abs(endX - startX) < 3 && endY > startY) return `M ${startX} ${startY} L ${endX} ${endY}`;
  if (endY >= startY + 32) {
    const bend = Math.max(24, Math.abs(endY - startY) * .45);
    return `M ${startX} ${startY} C ${startX} ${startY + bend}, ${endX} ${endY - bend}, ${endX} ${endY}`;
  }
  const middleY = Math.round((startY + endY) / 2);
  return `M ${startX} ${startY} C ${startX} ${startY + 28}, ${outerX} ${startY + 28}, ${outerX} ${middleY} S ${endX} ${endY - 28}, ${endX} ${endY}`;
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
      const selectEdge = `recipeGraphSelectEdge(event,decodeURIComponent('${encodeURIComponent(dependency.from)}'),decodeURIComponent('${encodeURIComponent(node.nodeId)}'))`;
      paths.push(`<path class="edge-hit ${edgeClass}" d="${route}" role="button" tabindex="0" aria-label="Connection ${esc(dependency.from)} to ${esc(node.nodeId)}" onclick="${selectEdge}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${selectEdge}}"></path><path class="edge-visible ${edgeClass} ${selected ? 'selected' : ''}" d="${route}"></path>`);
      arrows.push(recipeGraphArrowHead(endX, endY, `${edgeClass} ${selected ? 'selected' : ''}`));
    }
  }
  const sourceBoundary = canvas.querySelector('[data-graph-boundary="source"]');
  const sinkBoundary = canvas.querySelector('[data-graph-boundary="sink"]');
  if (sourceBoundary && sinkBoundary) {
    const incoming = new Set();
    const outgoing = new Set();
    for (const node of recipeDraft.definition.spec.nodes) for (const dependency of node.dependsOn || []) {
      if (dependency.loop) continue;
      incoming.add(node.nodeId); outgoing.add(dependency.from);
    }
    const sourceRect = sourceBoundary.getBoundingClientRect();
    const sinkRect = sinkBoundary.getBoundingClientRect();
    const sourcePoint = { x:sourceRect.left - canvasRect.left + sourceRect.width / 2, y:sourceRect.bottom - canvasRect.top };
    const sinkPoint = { x:sinkRect.left - canvasRect.left + sinkRect.width / 2, y:sinkRect.top - canvasRect.top };
    for (const node of recipeDraft.definition.spec.nodes) {
      const card = cards.get(node.nodeId);
      if (!card) continue;
      const rect = card.getBoundingClientRect();
      if (!incoming.has(node.nodeId)) {
        const end = { x:rect.left - canvasRect.left + rect.width / 2, y:rect.top - canvasRect.top - 8 };
        paths.unshift(`<path class="boundary-edge" d="M ${sourcePoint.x} ${sourcePoint.y} C ${sourcePoint.x} ${sourcePoint.y + 20}, ${end.x} ${end.y - 20}, ${end.x} ${end.y}"></path>`);
        arrows.unshift(recipeGraphArrowHead(end.x, end.y));
      }
      if (!outgoing.has(node.nodeId)) {
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
    if (error) error.textContent = '';
    recipePendingViewState = recipeCaptureViewState();
    button?.blur?.();
    ask('recipeUpdate', {
      recipeId:selectedRecipeId,
      name:recipeDraft.name, category:recipeDraft.category, description:recipeDraft.description,
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
  const active = document.activeElement;
  return {
    editorTop:editor?.scrollTop || 0, editorLeft:editor?.scrollLeft || 0,
    graphTop:graph?.scrollTop || 0, graphLeft:graph?.scrollLeft || 0,
    zoom:recipeGraphZoom, focusId:active?.id || ''
  };
}

function recipeRestoreViewState(viewState) {
  if (!viewState) return;
  recipeGraphZoom = Number(viewState.zoom) || recipeGraphZoom;
  const restore = () => {
    const editor = document.querySelector('.recipe-library-editor');
    const graph = document.querySelector('.recipe-graph-viewport');
    const canvas = document.querySelector('.recipe-graph-canvas');
    if (editor) { editor.scrollTop = viewState.editorTop; editor.scrollLeft = viewState.editorLeft; }
    if (graph) { graph.scrollTop = viewState.graphTop; graph.scrollLeft = viewState.graphLeft; }
    if (canvas) canvas.style.setProperty('--recipe-graph-zoom', recipeGraphZoom);
    const zoomLabel = document.getElementById('recipe-graph-zoom-label');
    if (zoomLabel) zoomLabel.textContent = `${Math.round(recipeGraphZoom * 100)}%`;
    if (viewState.focusId) document.getElementById(viewState.focusId)?.focus({ preventScroll:true });
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
  document.querySelector('.tab[data-tab="chatroom"]')?.dispatchEvent(new MouseEvent('click'));
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
  return { label, onClick:() => vscode.postMessage({ command:'copyText', text:value }) };
}

function recipeRootMenu(event) {
  event.preventDefault(); event.stopPropagation();
  showPaperMenu(event.clientX, event.clientY, [
    { label:'Recipe Library', header:true },
    { label:'New Recipe', onClick:() => projectNewRecipe() },
    recipeCopyPathMenu('pkm://recipes/')
  ]);
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
    recipeCopyPathMenu(`pkm://recipes/${encodeURIComponent(folder)}/`),
    { sep:true },
    { label:isPrivate ? 'Set as Public' : 'Set as Private', onClick:() => ask('contentSetPrivacy', { type:'recipes', topLevel, isPrivate:!isPrivate }) }
  ]);
}

function recipePersistUpdate(recipe, changes) {
  ask('recipeUpdate', {
    recipeId:recipe.recipeId,
    name:recipe.name,
    category:recipe.category || '',
    description:recipe.description || '',
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
    recipeCopyPathMenu(`pkm://recipes/${encodeURIComponent(recipe.category || '')}/${encodeURIComponent(recipe.name)}`),
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
    const metadataFields = [...(metadata.requiredInputs || []), ...(metadata.expectedOutputs || [])];
    const searchable = [recipe.name, recipe.description, recipe.category, ...(metadata.applicableFunctions || []), metadata.solution, ...metadataFields.flatMap(field => [field.name, field.description]), ...nodes.map(node => node.nodeId), ...nodes.map(node => node.kind)].filter(Boolean).join('\n').toLocaleLowerCase();
    return normalizedQuery.split(/\s+/).every(term => searchable.includes(term));
  }) : recipes;
  if (!matchedRecipes.length) return normalizedQuery
    ? `<div class="project-zero"><strong>No matching Recipe</strong><span>No accessible Recipe matches “${esc(recipeSearchQuery.trim())}”. Review the task contract or design a new Recipe.</span><button class="tbtn" onclick="projectNewRecipe()">Design Recipe</button></div>`
    : projectZero('No Recipes','Reusable Recipes available to every Agent Task will appear here.');
  const previousPrivateTopLevels = state.privateTopLevels;
  state.privateTopLevels = projectSnapshot?.privateTopLevels || [];
  const tree = buildCatTree(matchedRecipes, recipe => recipe.category, '(uncategorized)');
  const html = renderCatTree(tree, [], 0, (recipe, depth) => {
    const stepCount = recipe.definition?.spec?.nodes?.length || 0;
    const privateRecipe = privacyInherited(recipe.category || '');
    return `<div class="li cattree-item project-recipe-row ${recipe.recipeId === selectedRecipeId ? 'active' : ''}" style="margin-left:${8 + depth * 12}px" role="button" tabindex="0" onclick="recipeSelect(decodeURIComponent('${encodeURIComponent(recipe.recipeId)}'))" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();recipeSelect(decodeURIComponent('${encodeURIComponent(recipe.recipeId)}'))}" oncontextmenu="recipeItemMenu(event,decodeURIComponent('${encodeURIComponent(recipe.recipeId)}'))"><div><strong>${privacyLock(privateRecipe)}${esc(recipe.name)}</strong><span>${recipe.scope === 'global' ? 'Global' : 'Project'} · Revision ${recipe.revision} · ${stepCount} ${stepCount === 1 ? 'step' : 'steps'}</span></div><code title="Executable digest">${esc(String(recipe.executableDigest || '').slice(0,12))}</code><button class="cattree-item-menu" title="Recipe actions" aria-label="Actions for ${esc(recipe.name)}" onclick="event.stopPropagation();recipeItemMenu(event,decodeURIComponent('${encodeURIComponent(recipe.recipeId)}'))"><span class="codicon codicon-ellipsis"></span></button></div>`;
  }, '', (_child, name, fullPath) => name !== '(uncategorized)'
    ? ` oncontextmenu="recipeFolderMenu(event,decodeURIComponent('${encodeURIComponent(fullPath.join('/'))}'))"`
    : ` oncontextmenu="recipeRootMenu(event)"`);
  state.privateTopLevels = previousPrivateTopLevels;
  return `<div class="project-recipe-tree">${html}</div>`;
}

function globalRecipeEditor(recipe) {
  if (!recipe) return `<div class="recipe-editor-empty"><span class="codicon codicon-symbol-method"></span><strong>Select a Recipe</strong><p>Choose a Recipe from the CatTree to inspect or edit its executable definition.</p></div>`;
  const draft = recipeEnsureDraft(recipe);
  const metadataRows = (collection, label, emptyText) => `<section class="recipe-metadata-list"><header><div><strong>${label}</strong><span>${emptyText}</span></div><button class="tbtn" onclick="recipeMetadataAdd('${collection}')"><span class="codicon codicon-add"></span> Add</button></header>${draft.metadata[collection].length ? draft.metadata[collection].map((field, index) => `<div class="recipe-metadata-row"><input value="${esc(field.name)}" placeholder="Name" aria-label="${label} name" oninput="recipeDraftMetadataField('${collection}',${index},'name',this.value)"><input value="${esc(field.description)}" placeholder="Description" aria-label="${label} description" oninput="recipeDraftMetadataField('${collection}',${index},'description',this.value)">${collection === 'requiredInputs' ? `<label title="Required input"><input type="checkbox" ${field.required !== false ? 'checked' : ''} onchange="recipeDraftMetadataField('${collection}',${index},'required',this.checked)"><span>Required</span></label>` : ''}<button class="recipe-icon-button" title="Remove" aria-label="Remove ${label}" onclick="recipeMetadataRemove('${collection}',${index})"><span class="codicon codicon-trash"></span></button></div>`).join('') : `<p class="recipe-list-empty">None defined.</p>`}</section>`;
  const nodes = draft.definition?.spec?.nodes || [];
  const completion = new Set(draft.definition?.spec?.completion?.requiredNodes || []);
  const graph = `<div class="recipe-graph-toolbar"><div><strong>Definition Graph</strong><span>Drag a Step onto another Step to route an output into an input.</span></div><div class="recipe-graph-tools" role="toolbar" aria-label="Definition Graph actions"><button class="recipe-icon-button" title="Zoom out" aria-label="Zoom out" onclick="recipeGraphZoomSet(recipeGraphZoom-.1)"><span class="codicon codicon-zoom-out"></span></button><span id="recipe-graph-zoom-label">${Math.round(recipeGraphZoom * 100)}%</span><button class="recipe-icon-button" title="Zoom in" aria-label="Zoom in" onclick="recipeGraphZoomSet(recipeGraphZoom+.1)"><span class="codicon codicon-zoom-in"></span></button><button class="recipe-icon-button" title="Reset zoom" aria-label="Reset zoom" onclick="recipeGraphZoomSet(1)"><span class="codicon codicon-screen-normal"></span></button><button class="tbtn" onclick="recipeGraphAddStep()"><span class="codicon codicon-add"></span> Add Step</button><button class="tbtn primary" onclick="recipeSave(this)"><span class="codicon codicon-save"></span> Save</button></div></div><div class="recipe-graph-viewport"><div class="recipe-graph-canvas" style="--recipe-graph-zoom:${recipeGraphZoom}"><svg class="recipe-graph-links" aria-hidden="true"></svg>${nodes.map((node, index) => recipeGraphNodeHtml(node, index, nodes, completion)).join('')}</div></div>`;
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
      <section class="recipe-editor-section wide"><header class="recipe-definition-header"><div><span>Definition</span><p>Build executable Steps and dependency edges.</p></div><div class="recipe-mode-switch" role="tablist" aria-label="Definition editor mode"><button class="${recipeEditorMode === 'graph' ? 'active' : ''}" role="tab" aria-selected="${recipeEditorMode === 'graph'}" onclick="recipeEditorModeSet('graph')"><span class="codicon codicon-type-hierarchy"></span> Graph</button><button class="${recipeEditorMode === 'json' ? 'active' : ''}" role="tab" aria-selected="${recipeEditorMode === 'json'}" onclick="recipeEditorModeSet('json')"><span class="codicon codicon-code"></span> JSON</button></div></header>${recipeEditorMode === 'graph' ? `${recipeValidationStatus ? `<div class="recipe-validation-status"><span class="codicon codicon-pass-filled"></span>${esc(recipeValidationStatus)}</div>` : ''}${graph}` : `<div class="recipe-json-editor"><label class="definition"><span>Advanced JSON</span><textarea id="recipe-definition" rows="18" spellcheck="false">${esc(JSON.stringify(draft.definition, null, 2))}</textarea></label><footer><span>Validation uses the same workflow contract as Save and execution.</span><div class="recipe-json-actions"><button class="tbtn" onclick="recipeValidateJson(this)"><span class="codicon codicon-pass"></span> Validate &amp; Open Graph</button><button class="tbtn primary" onclick="recipeSave(this)"><span class="codicon codicon-save"></span> Save</button></div></footer></div>`}</section>
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

function agentSessionRunGraph(run, allRuns, seen = new Set()) {
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
    return `<div class="agent-runtime-node-shell"><article class="agent-runtime-node ${stateName}" data-node-id="${esc(node.nodeId)}"><header><span class="codicon ${node.kind === 'pkm.subflow/v1' ? 'codicon-type-hierarchy-sub' : stateName === 'running' ? 'codicon-loading codicon-modifier-spin' : stateName === 'succeeded' ? 'codicon-pass-filled' : stateName === 'failed' ? 'codicon-error' : stateName === 'skipped' ? 'codicon-debug-step-over' : 'codicon-circle-outline'}"></span><strong>${esc(node.nodeId)}</strong><b>${esc(stateName)}</b></header><small>${dependencies ? `After ${esc(dependencies)}` : 'Start node'}${node.outcome && node.outcome !== stateName ? ` · ${esc(node.outcome)}` : ''}</small>${node.instruction ? `<p>${esc(node.instruction)}</p>` : ''}${node.error ? `<p class="agent-runtime-error">${esc(node.error)}</p>` : ''}</article>${child ? `<div class="agent-runtime-child"><span>Nested Recipe</span>${agentSessionRunGraph(child, allRuns, seen)}</div>` : ''}</div>`;
  }).join('')}</div>`).join('');
  const runKind = run.origin?.kind === 'agent-session-adhoc' ? 'Ad hoc task' : 'Recipe run';
  const markerId = `agent-runtime-arrow-${String(run.runId || '').replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return `<section class="agent-runtime-run"><header><div><span>${runKind}</span><strong>${esc(run.recipeName)}</strong><small>r${run.recipeRevision} · ${esc(String(run.executableDigest || '').slice(0,12))}</small></div><b class="agent-runtime-run-status ${esc(run.status)}">${esc(run.status)}</b></header>${loops ? `<div class="agent-runtime-loops">${loops}</div>` : ''}<div class="agent-runtime-graph" data-run-id="${esc(run.runId)}"><svg class="agent-runtime-graph-links" data-marker-id="${markerId}" aria-hidden="true"></svg>${nodes.length ? `<div class="agent-runtime-boundary start" data-runtime-boundary="start"><span class="codicon codicon-debug-start"></span><strong>Start</strong></div>${levelHtml}<div class="agent-runtime-boundary end" data-runtime-boundary="end"><strong>End</strong><span class="codicon codicon-debug-stop"></span></div>` : '<p class="agent-muted">No materialized tasks.</p>'}</div></section>`;
}

function agentSessionLayoutLinks() {
  if (typeof document.querySelectorAll !== 'function') return;
  document.querySelectorAll('.agent-runtime-graph[data-run-id]').forEach(graph => {
    const svg = graph.querySelector(':scope > .agent-runtime-graph-links');
    if (!svg) return;
    const graphRect = graph.getBoundingClientRect();
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
        const startX = sourceRect.left - graphRect.left + sourceRect.width / 2;
        const startY = sourceRect.bottom - graphRect.top;
        const endX = targetRect.left - graphRect.left + targetRect.width / 2;
        const endY = targetRect.top - graphRect.top - 8;
        const outerX = Math.max(sourceRect.right, targetRect.right) - graphRect.left + 24;
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
      const startPoint = { x:startRect.left - graphRect.left + startRect.width / 2, y:startRect.bottom - graphRect.top };
      const endPoint = { x:endRect.left - graphRect.left + endRect.width / 2, y:endRect.top - graphRect.top };
      for (const [nodeId, card] of cards) {
        const rect = card.getBoundingClientRect();
        if (!incoming.has(nodeId)) {
          const target = { x:rect.left - graphRect.left + rect.width / 2, y:rect.top - graphRect.top - 8 };
          paths.unshift(`<path class="boundary-edge" d="${recipeGraphEdgeRoute(startPoint.x,startPoint.y,target.x,target.y,target.x)}"></path>`);
          arrows.unshift(recipeGraphArrowHead(target.x, target.y, '', 'agent-graph-arrow'));
        }
        if (!outgoing.has(nodeId)) {
          const source = { x:rect.left - graphRect.left + rect.width / 2, y:rect.bottom - graphRect.top };
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
}

function agentSessionTodoQueue(todos) {
  if (!todos.length) return '';
  const terminal = new Set(['succeeded','failed','skipped']);
  return `<section class="agent-session-todo-queue"><header><div><span>Ordered backlog</span><strong>Session Todos</strong></div><b>${todos.filter(todo => terminal.has(todo.status)).length} / ${todos.length}</b></header><ol>${todos.map(todo => {
    const status = ['pending','running','succeeded','failed','skipped'].includes(todo.status) ? todo.status : 'pending';
    const icon = status === 'running' ? 'codicon-loading codicon-modifier-spin' : status === 'succeeded' ? 'codicon-pass-filled' : status === 'failed' ? 'codicon-error' : status === 'skipped' ? 'codicon-debug-step-over' : 'codicon-circle-outline';
    return `<li class="${status}"><span class="codicon ${icon}"></span><div><strong>${esc(todo.title)}</strong>${todo.details ? `<p>${esc(todo.details)}</p>` : ''}${todo.summary ? `<small>${esc(todo.summary)}</small>` : ''}</div><b>${esc(status)}</b></li>`;
  }).join('')}</ol></section>`;
}

function agentSessionTree(sessions) {
  if (!sessions.length) return '';
  const tree = buildCatTree(sessions, session => [
    session.agent?.name || 'Agent',
    session.hostSessionId ? `Copilot Session ${session.hostSessionId}` : 'Unlinked sessions'
  ], 'Unlinked sessions');
  return `<div class="agent-session-tree">${renderCatTree(tree, [], 0, (session, depth) => `<div class="li cattree-item agent-session-row ${session.sessionId === selectedAgentSessionId ? 'active' : ''}" style="padding-left:${8 + depth * 12}px" role="button" tabindex="0" onclick="agentSessionSelect(decodeURIComponent('${encodeURIComponent(session.sessionId)}'))" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();agentSessionSelect(decodeURIComponent('${encodeURIComponent(session.sessionId)}'))}" oncontextmenu="agentSessionContextMenu(event,decodeURIComponent('${encodeURIComponent(session.sessionId)}'),'${esc(session.status)}')"><span><i class="${session.status === 'running' ? '' : 'idle'}"></i><strong>${esc(session.task)}</strong></span><b>${esc(session.sessionId.replace(/^agent_session_/, '').slice(0,12))}</b><small>${esc(session.lastActivity?.tool || (session.checkpoint ? 'Checkpoint ready' : 'Registered'))}</small><button class="cattree-item-menu" title="Agent Session actions" aria-label="Actions for ${esc(session.task)}" onclick="event.stopPropagation();agentSessionContextMenu(event,decodeURIComponent('${encodeURIComponent(session.sessionId)}'),'${esc(session.status)}')"><span class="codicon codicon-ellipsis"></span></button></div>`, '', (_child, _name, fullPath) => ` oncontextmenu="agentSessionFolderMenu(event,decodeURIComponent('${encodeURIComponent(fullPath.join('/'))}'))"`, null, {
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
  const sessions = projectSnapshot?.agentSessions || [];
  const trash = projectSnapshot?.agentSessionTrash || [];
  const activeSessions = sessions.filter(session => session.status !== 'completed');
  const archivedSessions = sessions.filter(session => session.status === 'completed');
  if (!sessions.some(session => session.sessionId === selectedAgentSessionId)) selectedAgentSessionId = activeSessions[0]?.sessionId || archivedSessions[0]?.sessionId || '';
  const selected = sessions.find(session => session.sessionId === selectedAgentSessionId);
  if (agentSessionArchiveExpanded === undefined) agentSessionArchiveExpanded = !activeSessions.length && archivedSessions.some(session => session.sessionId === selectedAgentSessionId);
  const trashList = trash.map(session => `<div class="li cattree-item agent-session-trash-row" oncontextmenu="agentSessionTrashContextMenu(event,decodeURIComponent('${encodeURIComponent(session.sessionId)}'))"><div><strong>${esc(session.task)}</strong><small>${esc(session.agent?.name || 'Agent')}</small></div><button class="cattree-item-menu" title="Trash actions" aria-label="Trash actions for ${esc(session.task)}" onclick="event.stopPropagation();agentSessionTrashContextMenu(event,decodeURIComponent('${encodeURIComponent(session.sessionId)}'))"><span class="codicon codicon-ellipsis"></span></button></div>`).join('');
  const list = `${agentSessionTree(activeSessions)}${archivedSessions.length ? `<details class="agent-session-archive"${agentSessionArchiveExpanded ? ' open' : ''} ontoggle="agentSessionGroupToggle('archive',this.open)"><summary><span><i class="codicon codicon-archive"></i>Archived</span><b>${archivedSessions.length}</b></summary>${agentSessionTree(archivedSessions)}</details>` : ''}`;
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
      status:selected.status === 'completed' ? 'succeeded' : 'running'
    }];
    const todoTerminal = sessionTodos.filter(todo => ['succeeded','failed','skipped'].includes(todo.status)).length;
    const runningTodo = sessionTodos.find(todo => todo.status === 'running');
    const progressDone = sessionTodos.length ? todoTerminal : terminal;
    const progressTotal = sessionTodos.length || nodes.length;
    const percent = progressTotal ? Math.round(progressDone * 100 / progressTotal) : 0;
    const rootRuns = selected.runs.filter(run => !run.parent || !selected.runs.some(candidate => candidate.runId === run.parent.runId));
    content = `<div class="agent-dashboard"><header class="agent-session-head"><div><span>PKM-managed Agent Session</span><h3>${esc(selected.task)}</h3><p>${esc(selected.sessionId)} · Updated ${esc(selected.updatedAt || 'unknown')}</p></div><span class="agent-status ${selected.status === 'running' ? 'running' : ''}">${selected.status === 'running' ? '<i class="agent-live-dot"></i> ' : ''}${esc(selected.status)}</span></header><div class="agent-session-summary"><div><span>Agent</span><strong>${esc(selected.agent?.name || 'Agent')}</strong><small>${esc(selected.agent?.product || '')}</small></div><div><span>Current task</span><strong>${esc(runningTodo?.title || running?.nodeId || (selected.runs.length ? 'No running node' : 'Awaiting task plan'))}</strong><small>${esc(selected.lastActivity?.tool || 'Registered')}</small></div><div><span>${sessionTodos.length ? 'Session todos' : 'Task runs'}</span><strong>${sessionTodos.length || selected.runs.length}</strong><small>${sessionTodos.length ? `${sessionTodos.filter(todo => todo.status === 'pending').length} queued` : `${nodes.length} graph tasks`}</small></div><div><span>Progress</span><strong>${progressDone} / ${progressTotal}</strong><small>${percent}% complete</small><div class="agent-progress" aria-label="${progressDone} of ${progressTotal} tasks terminal"><i style="width:${percent}%"></i></div></div></div>${selected.checkpoint ? `<div class="agent-checkpoint-strip"><span class="codicon codicon-save"></span><div><strong>Checkpoint ${selected.checkpoint.sequence}</strong><small>${esc(selected.checkpoint.summary || selected.checkpoint.reason || 'Recovery state saved')} · ${selected.checkpoint.nextActionCount} next actions</small></div><code>${esc(selected.checkpoint.checkpointId)}</code></div>` : ''}${agentSessionTodoQueue(sessionTodos)}<div class="agent-runtime-runs">${rootRuns.map(run => agentSessionRunGraph(run, selected.runs)).join('') || '<div class="agent-session-empty compact"><span class="codicon codicon-type-hierarchy"></span><strong>Managed session registered</strong><p>The task graph appears when this Agent starts an ad hoc task or Recipe run.</p></div>'}</div></div>`;
  }
  detail.innerHTML = `<div class="agent-sessions-workspace ${agentSessionTreeCollapsed ? 'cattree-collapsed' : ''}"><aside class="agent-session-list"><div class="agent-session-list-head"><strong>Agent Sessions</strong><span>${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}</span></div><div class="agent-session-tree-scroll" oncontextmenu="if(event.target===this)agentSessionRootMenu(event)">${list}</div>${catTreeTrashDock('Trash', trash.length, trashList)}</aside>${workspaceCatTreeDivider('agentSessions',agentSessionTreeCollapsed)}<main class="agent-session-content">${content}</main></div>`;
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
    content = `<article class="agent-snapshot-detail"><header><div><span>Immutable recovery point</span><h3>${esc(selected.task)}</h3><p>${esc(selected.snapshotId)}</p></div><b>${selected.recoveryCount || 0} recoveries</b></header>${credential ? `<section class="agent-snapshot-secret"><div><span class="codicon codicon-warning"></span><div><strong>Save this recovery passphrase now</strong><p>It is shown only once and is never stored in plaintext. Keep it separate from the Magic Code.</p></div></div><code>${esc(credential.recoveryPassphrase)}</code><div><button class="pk-button" onclick="agentSnapshotCopy(decodeURIComponent('${encodedPrompt}'),this)">Copy Recovery Prompt</button><button class="pk-button secondary" onclick="agentSnapshotDismissCredential()">I saved it</button></div></section>` : ''}<section class="agent-snapshot-identity"><div><span>Magic Code</span><code>${esc(selected.magicCode)}</code><button class="pk-button secondary" onclick="agentSnapshotCopy(decodeURIComponent('${encodedMagic}'),this)">Copy</button></div><p>The Magic Code identifies this local Snapshot. Recovery also requires the one-time passphrase shown when it was created.</p></section><div class="agent-snapshot-metrics"><div><span>Source Session</span><strong>${esc(selected.sourceSessionId)}</strong></div><div><span>Captured</span><strong>${esc(selected.createdAt)}</strong></div><div><span>Session Todos</span><strong>${selected.todoCount || 0}</strong></div><div><span>Recipe Runs</span><strong>${selected.recipeRunCount || 0}</strong></div></div><section class="agent-snapshot-recover"><span class="codicon codicon-debug-restart"></span><div><strong>Recover in a new conversation</strong><ol><li>Open a new Copilot session in this Knowledge Root.</li><li>Paste the recovery prompt containing the Magic Code and passphrase.</li><li>The Agent calls <code>agent_session_snapshot_recover</code> and continues from the captured todos and Recipe runs.</li></ol><p>Each recovery creates a new independent Session. Right-click this Snapshot to delete it when it is no longer needed.</p></div></section></article>`;
  }
  detail.innerHTML = `<div class="agent-snapshot-page">${create}<div class="agent-snapshot-workspace"><aside><header><strong>Agent Snapshots</strong><span>${snapshots.length}</span></header><div>${list}</div></aside><main>${content}</main></div></div>`;
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
  if (projectRoute.section === 'Threads') return threads.length ? `<div class="project-thread-list">${threads.map(thread => `
    <div class="project-thread-row"><div><strong>${esc(thread.name)}</strong><span>${thread.systemKind === 'general-thread' ? 'System · General Thread' : thread.archived ? 'Archived Thread' : 'Thread'}</span></div>
      <select aria-label="Move ${esc(thread.name)} to Project" onchange="projectMoveThread('${esc(thread.threadId)}',this.value)" ${thread.systemKind === 'general-thread' ? 'disabled title="General Thread cannot move"' : ''}><option value="">Move to…</option>${projectSnapshot.projects.filter(candidate => candidate.projectId !== project.projectId).map(candidate => `<option value="${esc(candidate.projectId)}">${esc(candidate.name)}</option>`).join('')}</select>
      <button class="tbtn" onclick="projectOpenThread('${esc(thread.threadId)}')">Open Thread</button></div>`).join('')}</div>` : projectZero('No Threads','Create a Thread to open a focused collaboration surface.');
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
  const detail = document.getElementById('detail');
  if (!projectSnapshot) { detail.innerHTML = '<div class="empty">Opening the Recipes grimoire…</div>'; return; }
  const recipes = (projectSnapshot.recipes || []).filter(recipe => recipe.scope === 'global');
  const recipeTrash = (projectSnapshot.recipeTrash || []).filter(recipe => recipe.scope === 'global');
  if (!recipes.some(recipe => recipe.recipeId === selectedRecipeId)) selectedRecipeId = recipes[0]?.recipeId || '';
  const selected = recipes.find(recipe => recipe.recipeId === selectedRecipeId);
  const recipeTrashList = recipeTrash.map(recipe => `<div class="li cattree-item recipe-trash-row" oncontextmenu="recipeTrashItemMenu(event,decodeURIComponent('${encodeURIComponent(recipe.recipeId)}'))"><div><strong>${esc(recipe.name)}</strong><small>${esc(recipe.category || 'Uncategorized')}</small></div><button class="cattree-item-menu" title="Trash actions" aria-label="Trash actions for ${esc(recipe.name)}" onclick="event.stopPropagation();recipeTrashItemMenu(event,decodeURIComponent('${encodeURIComponent(recipe.recipeId)}'))"><span class="codicon codicon-ellipsis"></span></button></div>`).join('');
  detail.innerHTML = `<div class="global-recipes-workspace"><header class="project-header"><div><span>Automation</span><h2>Recipe Library</h2><p>${recipes.length} reusable Recipes</p></div><div class="project-header-actions"><button class="recipe-icon-button" title="Refresh Recipe Library" aria-label="Refresh Recipe Library" onclick="recipeRefresh()"><span class="codicon codicon-refresh"></span></button><button class="tbtn" onclick="projectNewRecipe()">New Recipe</button></div></header><div class="recipe-library-workbench ${recipeTreeCollapsed ? 'cattree-collapsed' : ''}" style="--recipe-tree-width:${recipeTreeWidth}px"><aside class="recipe-library-tree"><div class="recipe-search pkm-search-field"><span class="codicon codicon-search pkm-search-icon"></span><input type="search" value="${esc(recipeSearchQuery)}" placeholder="Search Recipes and Steps" aria-label="Search Recipes" oninput="recipeSearch(this.value)"><button class="recipe-search-clear${recipeSearchQuery ? '' : ' hidden'}" title="Clear Recipe search" aria-label="Clear Recipe search" onclick="recipeSearchClear()"><span class="codicon codicon-close"></span></button></div><div class="recipe-library-tree-scroll" oncontextmenu="if(event.target===this)recipeRootMenu(event)">${globalRecipeTree(recipes)}</div>${catTreeTrashDock('Trash', recipeTrash.length, recipeTrashList)}</aside>${workspaceCatTreeDivider('recipes',recipeTreeCollapsed,true)}<main class="recipe-library-editor">${globalRecipeEditor(selected)}</main></div></div>`;
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

function recipeRefresh() {
  ask('projectState', {});
}

function projectOnState(snapshot) {
  projectSnapshot = snapshot;
  projectSnapshotDirty = false;
  finishAction('agentSnapshotDelete');
  normalizeProjectRoute(snapshot);
  if (state.tab === 'agentSessions') renderAgentSessions(); else if (state.tab === 'agentSnapshots') renderAgentSnapshots(); else if (state.tab === 'recipes') renderGlobalRecipes(); else renderProjects();
}

function projectOnResult(data) {
  finishAction('projectCreate','threadCreate','threadMove','recipeCreate','recipeUpdate','recipeDelete','recipeTrash','recipeOpenBrowser');
  projectSnapshot = data.snapshot;
  const recipeViewState = data.action === 'recipeUpdate' ? recipePendingViewState || recipeCaptureViewState() : null;
  if (data.action === 'recipeUpdate') { recipeDraft = null; recipeDraftRecipeId = ''; recipePendingViewState = null; }
  if (data.action === 'recipeDelete' && selectedRecipeId === data.entityId) { selectedRecipeId = ''; recipeDraft = null; recipeDraftRecipeId = ''; }
  if (data.action === 'recipeTrash' && selectedRecipeId === data.entityId && !data.snapshot.recipes.some(recipe => recipe.recipeId === data.entityId)) { selectedRecipeId = ''; recipeDraft = null; recipeDraftRecipeId = ''; }
  if (data.action === 'projectCreate') { projectRoute.projectId = data.entityId; projectRoute.section = 'Overview'; }
  if (data.action === 'threadCreate') projectRoute.section = 'Threads';
  if (data.action === 'recipeCreate' && state.tab === 'projects') { projectRoute.section = 'Todos'; projectRoute.workflowView = 'Recipes'; }
  if (data.action === 'recipeCreate' && state.tab === 'recipes') selectedRecipeId = data.entityId;
  normalizeProjectRoute(projectSnapshot);
  if (state.tab === 'agentSessions') renderAgentSessions(); else if (state.tab === 'agentSnapshots') renderAgentSnapshots(); else if (state.tab === 'recipes') renderGlobalRecipes(); else renderProjects();
  recipeRestoreViewState(recipeViewState);
}

function projectOnError(data) {
  if (data?.action === 'recipeOpenBrowser') failAction(data?.error || 'The Recipe workbench could not be opened.', 'recipeOpenBrowser');
  else finishAction('projectCreate','threadCreate','threadMove','recipeCreate','recipeUpdate','recipeValidateDefinition');
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