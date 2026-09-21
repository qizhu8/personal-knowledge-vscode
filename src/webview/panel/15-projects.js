// ── Projects workspace ─────────────────────────────────────────────────────
const projectSections = ['Overview','Todos','Threads','Agents','Artifacts','Decisions'];
let projectSnapshot = null;
let projectRoute = { projectId:'', section:'', workflowView:'' };
let agentDashboardView = 'Execution';
let agentDashboardStep = 'implement';
let agentTechExpanded = { root:true, implement:false };
let recipeSearchQuery = '';
let selectedRecipeId = '';
let recipeEditorMode = 'graph';
let recipeDraft = null;
let recipeDraftRecipeId = '';
let recipeGraphResizeObserver = null;
let recipeGraphZoom = 1;
let recipeTreeWidth = 280;
const recipeModuleTemplates = {
  single:{ label:'Step', ports:{ inputs:['input'], outputs:['output'] }, control:{ mode:'single' } },
  repeat:{ label:'Repeat', ports:{ inputs:['items'], outputs:['result'] }, control:{ mode:'repeat', count:{ kind:'fixed', value:2 } } },
  if:{ label:'If / Else', ports:{ inputs:['condition'], outputs:['yes','no'] }, control:{ mode:'branch', kind:'if', cases:['yes','no'] } },
  switch:{ label:'Switch', ports:{ inputs:['value'], outputs:['case1','default'] }, control:{ mode:'branch', kind:'switch', cases:['case1','default'] } }
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

function agentDashboardSetView(view) {
  agentDashboardView = ['Execution','Evidence','Decisions'].includes(view) ? view : 'Execution';
  renderAgentSessions();
}

function renderTodoExecutionScope() {
  if (state.tab === 'projects') renderProjects();
  else renderAgentSessions();
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

function projectNewRecipe() {
  const global = state.tab === 'recipes';
  pkModal({ title:'New Recipe', message:global ? 'Create a reusable Recipe in the global library.' : 'Create a workflow Recipe in the selected Project.', input:true, okLabel:'Create', onOk:name => {
    if (name.trim()) ask('recipeCreate', { scope:global ? 'global' : 'project', ...(global ? {} : { projectId:projectRoute.projectId }), name:name.trim() });
  }});
}

function projectExportRecipes() {
  ask('projectRecipesExport', { projectId:projectRoute.projectId });
}

function recipeSearch(value) {
  recipeSearchQuery = String(value || '');
  renderGlobalRecipes();
}

function recipeSelect(recipeId) {
  selectedRecipeId = String(recipeId || '');
  recipeDraft = null;
  recipeDraftRecipeId = '';
  renderGlobalRecipes();
}

function recipeEnsureDraft(recipe) {
  if (recipeDraft && recipeDraftRecipeId === recipe.recipeId) return recipeDraft;
  recipeDraftRecipeId = recipe.recipeId;
  recipeDraft = JSON.parse(JSON.stringify({
    name:recipe.name, category:recipe.category || '', description:recipe.description || '',
    metadata:recipe.metadata || { applicableFunctions:[], solution:'', requiredInputs:[], expectedOutputs:[] },
    editorLayout:recipe.editorLayout || { nodePositions:{} },
    definition:recipe.definition
  }));
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
  renderGlobalRecipes();
}
function recipeMetadataRemove(collection, index) {
  recipeDraft.metadata[collection].splice(index, 1);
  renderGlobalRecipes();
}

function recipeGraphAddStep() {
  pkModal({ title:'Add Module', message:'Choose a module type, then enter a stable ID.', input:true, options:Object.entries(recipeModuleTemplates).map(([value, template]) => ({ value, label:template.label })), okLabel:'Add', onOk:(value, _text, _checked, selectedType) => {
    const nodeId = String(value || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(nodeId) || recipeDraft.definition.spec.nodes.some(node => node.nodeId === nodeId)) return;
    const template = recipeModuleTemplates[selectedType] || recipeModuleTemplates.single;
    recipeDraft.definition.spec.nodes.push({ nodeId, kind:'pkm.step.noop/v1', config:{}, dependsOn:[], ports:JSON.parse(JSON.stringify(template.ports)), control:JSON.parse(JSON.stringify(template.control)) });
    const index = recipeDraft.definition.spec.nodes.length - 1;
    recipeDraft.editorLayout ||= { nodePositions:{} };
    recipeDraft.editorLayout.nodePositions[nodeId] = recipeGraphDefaultPosition(index);
    renderGlobalRecipes();
  }});
}
function recipeGraphRemoveStep(nodeId) {
  const nodes = recipeDraft.definition.spec.nodes;
  if (nodes.length <= 1) return;
  recipeDraft.definition.spec.nodes = nodes.filter(node => node.nodeId !== nodeId).map(node => ({ ...node, dependsOn:(node.dependsOn || []).filter(dependency => dependency.from !== nodeId) }));
  recipeDraft.definition.spec.completion.requiredNodes = recipeDraft.definition.spec.completion.requiredNodes.filter(id => id !== nodeId);
  if (!recipeDraft.definition.spec.completion.requiredNodes.length) recipeDraft.definition.spec.completion.requiredNodes = [recipeDraft.definition.spec.nodes.at(-1).nodeId];
  if (recipeDraft.editorLayout?.nodePositions) delete recipeDraft.editorLayout.nodePositions[nodeId];
  renderGlobalRecipes();
}
function recipeGraphDefaultPosition(index) { return { x:24 + (index % 3) * 320, y:24 + Math.floor(index / 3) * 360 }; }
function recipeGraphPosition(nodeId, index) {
  recipeDraft.editorLayout ||= { nodePositions:{} };
  return recipeDraft.editorLayout.nodePositions[nodeId] ||= recipeGraphDefaultPosition(index);
}
function recipeGraphMoveStart(event, nodeId, index) {
  if (event.button !== 0 || event.target.closest('button,input,select,.recipe-drag-handle')) return;
  const card = event.currentTarget.closest('.recipe-graph-node');
  const canvas = card?.parentElement;
  if (!card || !canvas) return;
  event.preventDefault();
  const origin = recipeGraphPosition(nodeId, index);
  const startX = event.clientX;
  const startY = event.clientY;
  const move = moveEvent => {
    const position = { x:Math.max(0, Math.round(origin.x + (moveEvent.clientX - startX) / recipeGraphZoom)), y:Math.max(0, Math.round(origin.y + (moveEvent.clientY - startY) / recipeGraphZoom)) };
    recipeDraft.editorLayout.nodePositions[nodeId] = position;
    card.style.left = `${position.x}px`;
    card.style.top = `${position.y}px`;
    recipeGraphSizeCanvas(canvas);
    recipeGraphLayoutLinks();
  };
  const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop, { once:true });
}
function recipeGraphSizeCanvas(canvas) {
  const height = [...canvas.querySelectorAll('.recipe-graph-node')].reduce((maximum, card) => Math.max(maximum, (parseFloat(card.style.top) || 0) + card.offsetHeight + 40), 560);
  canvas.style.height = `${height}px`;
}
function recipeGraphApplyLayout() {
  const canvas = document.querySelector('.recipe-graph-canvas');
  if (!canvas || !recipeDraft) return;
  [...canvas.querySelectorAll('.recipe-graph-node')].forEach((card, index) => {
    const position = recipeGraphPosition(card.dataset.nodeId, index);
    card.style.position = 'absolute';
    card.style.left = `${position.x}px`;
    card.style.top = `${position.y}px`;
    card.draggable = false;
    const header = card.querySelector('header');
    if (header) { header.title = 'Drag to move this module'; header.onpointerdown = event => recipeGraphMoveStart(event, card.dataset.nodeId, index); }
    const connector = card.querySelector('.recipe-drag-handle');
    if (connector) { connector.draggable = true; connector.title = 'Drag onto another module to connect'; }
  });
  recipeGraphSizeCanvas(canvas);
}
function recipeGraphDragStart(event, nodeId) { event.dataTransfer.setData('text/plain', nodeId); event.dataTransfer.effectAllowed = 'link'; }
function recipeGraphDragOver(event) { event.preventDefault(); event.dataTransfer.dropEffect = 'link'; event.currentTarget.classList.add('drop-target'); }
function recipeGraphDragLeave(event) { event.currentTarget.classList.remove('drop-target'); }
function recipeGraphDrop(event, targetId) {
  event.preventDefault(); event.currentTarget.classList.remove('drop-target');
  const sourceId = event.dataTransfer.getData('text/plain');
  const target = recipeDraft.definition.spec.nodes.find(node => node.nodeId === targetId);
  if (!sourceId || sourceId === targetId || !target || (target.dependsOn || []).some(dependency => dependency.from === sourceId)) return;
  const source = recipeDraft.definition.spec.nodes.find(node => node.nodeId === sourceId);
  const sourceOutputs = source?.ports?.outputs || ['completion'];
  const targetInputs = target.ports?.inputs || ['dependency'];
  const outcomes = source?.control?.mode === 'branch' ? source.control.cases : ['succeeded'];
  target.dependsOn = [...(target.dependsOn || []), {
    from:sourceId, accept:[outcomes[0]], required:true,
    fromOutput:sourceOutputs[0], toInput:targetInputs[0]
  }];
  renderGlobalRecipes();
}
function recipeGraphRemoveDependency(nodeId, sourceId) {
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === nodeId);
  if (node) node.dependsOn = (node.dependsOn || []).filter(dependency => dependency.from !== sourceId);
  renderGlobalRecipes();
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
  renderGlobalRecipes();
}
function recipeGraphRepeatKind(nodeId, kind) {
  const node = recipeDraft.definition.spec.nodes.find(candidate => candidate.nodeId === nodeId);
  if (node?.control?.mode !== 'repeat') return;
  node.control.count = kind === 'dynamic' ? { kind:'dynamic' } : { kind:'fixed', value:2 };
  renderGlobalRecipes();
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
  renderGlobalRecipes();
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
}
function recipeGraphLayoutLinks() {
  const canvas = document.querySelector('.recipe-graph-canvas');
  const svg = canvas?.querySelector('.recipe-graph-links');
  if (!canvas || !svg || !recipeDraft) return;
  const canvasRect = canvas.getBoundingClientRect();
  const cards = new Map([...canvas.querySelectorAll('.recipe-graph-node')].map(card => [card.dataset.nodeId, card]));
  const paths = [];
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
      const endY = targetRect.top - canvasRect.top;
      const bend = Math.max(24, Math.abs(endY - startY) / 2);
      paths.push(`<path d="M ${startX} ${startY} C ${startX} ${startY + bend}, ${endX} ${endY - bend}, ${endX} ${endY}" marker-end="url(#recipe-arrow)"></path>`);
    }
  }
  svg.setAttribute('viewBox', `0 0 ${canvas.clientWidth} ${canvas.clientHeight}`);
  svg.innerHTML = `<defs><marker id="recipe-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs>${paths.join('')}`;
}
function recipeEditorModeSet(mode) {
  const error = document.getElementById('recipe-edit-error');
  if (mode === 'graph' && recipeEditorMode === 'json') {
    try { recipeDraft.definition = JSON.parse(document.getElementById('recipe-definition').value); }
    catch (parseError) { if (error) error.textContent = `Definition JSON is invalid: ${parseError.message}`; return; }
  }
  recipeEditorMode = mode === 'json' ? 'json' : 'graph';
  renderGlobalRecipes();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(recipeGraphLayoutLinks);
}

function recipeSave(button) {
  const error = document.getElementById('recipe-edit-error');
  try {
    if (recipeEditorMode === 'json') recipeDraft.definition = JSON.parse(document.getElementById('recipe-definition').value);
    if (error) error.textContent = '';
    ask('recipeUpdate', {
      recipeId:selectedRecipeId,
      name:recipeDraft.name, category:recipeDraft.category, description:recipeDraft.description,
      metadata:recipeDraft.metadata, editorLayout:recipeDraft.editorLayout, definition:recipeDraft.definition
    }, button);
  } catch (parseError) {
    if (error) error.textContent = `Definition JSON is invalid: ${parseError.message}`;
  }
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

function recipeFolderMenu(event, category) {
  event.preventDefault(); event.stopPropagation();
  const topLevel = String(category || '').split('/').filter(Boolean)[0];
  if (!topLevel || topLevel === '(uncategorized)') return;
  const isPrivate = (projectSnapshot?.privateTopLevels || []).includes(topLevel);
  showPaperMenu(event.clientX, event.clientY, [
    { label:isPrivate ? 'Set as Public' : 'Set as Private', onClick:() => ask('contentSetPrivacy', { type:'recipes', topLevel, isPrivate:!isPrivate }) }
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
    return `<button class="project-recipe-row ${recipe.recipeId === selectedRecipeId ? 'active' : ''}" style="margin-left:${8 + depth * 12}px" onclick="recipeSelect(decodeURIComponent('${encodeURIComponent(recipe.recipeId)}'))"><div><strong>${privacyLock(privateRecipe)}${esc(recipe.name)}</strong><span>${recipe.scope === 'global' ? 'Global' : 'Project'} · Revision ${recipe.revision} · ${stepCount} ${stepCount === 1 ? 'step' : 'steps'}</span></div><code title="Executable digest">${esc(String(recipe.executableDigest || '').slice(0,12))}</code></button>`;
  }, '', (child, name, fullPath) => fullPath.length === 1 && name !== '(uncategorized)'
    ? ` oncontextmenu="recipeFolderMenu(event,decodeURIComponent('${encodeURIComponent(fullPath.join('/'))}'))"`
    : '');
  state.privateTopLevels = previousPrivateTopLevels;
  return `<div class="project-recipe-tree">${html}</div>`;
}

function globalRecipeEditor(recipe) {
  if (!recipe) return `<div class="recipe-editor-empty"><span class="codicon codicon-symbol-method"></span><strong>Select a Recipe</strong><p>Choose a Recipe from the CatTree to inspect or edit its executable definition.</p></div>`;
  const draft = recipeEnsureDraft(recipe);
  const metadataRows = (collection, label, emptyText) => `<section class="recipe-metadata-list"><header><div><strong>${label}</strong><span>${emptyText}</span></div><button class="tbtn" onclick="recipeMetadataAdd('${collection}')"><span class="codicon codicon-add"></span> Add</button></header>${draft.metadata[collection].length ? draft.metadata[collection].map((field, index) => `<div class="recipe-metadata-row"><input value="${esc(field.name)}" placeholder="Name" aria-label="${label} name" oninput="recipeDraftMetadataField('${collection}',${index},'name',this.value)"><input value="${esc(field.description)}" placeholder="Description" aria-label="${label} description" oninput="recipeDraftMetadataField('${collection}',${index},'description',this.value)">${collection === 'requiredInputs' ? `<label title="Required input"><input type="checkbox" ${field.required !== false ? 'checked' : ''} onchange="recipeDraftMetadataField('${collection}',${index},'required',this.checked)"><span>Required</span></label>` : ''}<button class="recipe-icon-button" title="Remove" aria-label="Remove ${label}" onclick="recipeMetadataRemove('${collection}',${index})"><span class="codicon codicon-trash"></span></button></div>`).join('') : `<p class="recipe-list-empty">None defined.</p>`}</section>`;
  const nodes = draft.definition?.spec?.nodes || [];
  const completion = new Set(draft.definition?.spec?.completion?.requiredNodes || []);
  const graph = `<div class="recipe-graph-toolbar"><div><strong>Definition Graph</strong><span>Drag a Step onto another Step to route an output into an input.</span></div><div class="recipe-graph-tools"><button class="recipe-icon-button" title="Zoom out" aria-label="Zoom out" onclick="recipeGraphZoomSet(recipeGraphZoom-.1)"><span class="codicon codicon-zoom-out"></span></button><span id="recipe-graph-zoom-label">${Math.round(recipeGraphZoom * 100)}%</span><button class="recipe-icon-button" title="Zoom in" aria-label="Zoom in" onclick="recipeGraphZoomSet(recipeGraphZoom+.1)"><span class="codicon codicon-zoom-in"></span></button><button class="recipe-icon-button" title="Reset zoom" aria-label="Reset zoom" onclick="recipeGraphZoomSet(1)"><span class="codicon codicon-screen-normal"></span></button><button class="tbtn" onclick="recipeGraphAddStep()"><span class="codicon codicon-add"></span> Add Step</button></div></div><div class="recipe-graph-viewport"><div class="recipe-graph-canvas" style="--recipe-graph-zoom:${recipeGraphZoom}"><svg class="recipe-graph-links" aria-hidden="true"></svg>${nodes.map((node, index) => recipeGraphNodeHtml(node, index, nodes, completion)).join('')}</div></div>`;
  return `<div class="recipe-editor">
    <header class="recipe-editor-header"><div><span>Global Recipe</span><h3>${esc(recipe.name)}</h3><p>Revision ${recipe.revision} · <code title="Executable digest">${esc(recipe.executableDigest || '')}</code></p></div><div><button class="tbtn" onclick="ask('recipeOpenBrowser',{recipeId:selectedRecipeId})" title="Open the Recipe workbench in a browser"><span class="codicon codicon-globe"></span> Browser</button><button class="tbtn" onclick="recipeSave(this)"><span class="codicon codicon-save"></span> Save</button></div></header>
    <div class="recipe-editor-form">
      <section class="recipe-editor-section wide"><header><span>Metadata</span><p>Structured retrieval context used to match this Recipe to Agent tasks.</p></header><div class="recipe-metadata-grid">
        <label><span>Name</span><input id="recipe-name" value="${esc(draft.name)}" autocomplete="off" oninput="recipeDraftField('name',this.value)"></label>
        <label><span>Category</span><input id="recipe-category" value="${esc(draft.category)}" placeholder="Automation/Software Development" autocomplete="off" oninput="recipeDraftField('category',this.value)"></label>
        <label class="wide"><span>Description</span><textarea id="recipe-description" rows="3" oninput="recipeDraftField('description',this.value)">${esc(draft.description)}</textarea></label>
        <label class="wide"><span>Applicable functions</span><textarea id="recipe-functions" rows="2" placeholder="One function per line" oninput="recipeDraftFunctions(this.value)">${esc(draft.metadata.applicableFunctions.join('\n'))}</textarea></label>
        <label class="wide"><span>Solution</span><textarea id="recipe-solution" rows="4" placeholder="How this Recipe solves the target problem" oninput="recipeDraftSolution(this.value)">${esc(draft.metadata.solution)}</textarea></label>
        <div class="wide recipe-metadata-lists">${metadataRows('requiredInputs','Required input','What must the Agent provide?')}${metadataRows('expectedOutputs','Expected output','What should this Recipe produce?')}</div>
      </div></section>
      <section class="recipe-editor-section wide"><header class="recipe-definition-header"><div><span>Definition</span><p>Build executable Steps and dependency edges.</p></div><div class="recipe-mode-switch" role="tablist" aria-label="Definition editor mode"><button class="${recipeEditorMode === 'graph' ? 'active' : ''}" role="tab" aria-selected="${recipeEditorMode === 'graph'}" onclick="recipeEditorModeSet('graph')"><span class="codicon codicon-type-hierarchy"></span> Graph</button><button class="${recipeEditorMode === 'json' ? 'active' : ''}" role="tab" aria-selected="${recipeEditorMode === 'json'}" onclick="recipeEditorModeSet('json')"><span class="codicon codicon-code"></span> JSON</button></div></header>${recipeEditorMode === 'graph' ? graph : `<label class="definition"><span>Advanced JSON</span><textarea id="recipe-definition" rows="18" spellcheck="false">${esc(JSON.stringify(draft.definition, null, 2))}</textarea></label>`}</section>
      <div id="recipe-edit-error" class="recipe-edit-error" role="alert"></div>
    </div>
  </div>`;
}

function agentDashboardStepDetail() {
  const details = {
    understand:{ title:'Understand request', state:'Succeeded', attempt:'Attempt 1', duration:'1m 42s', summary:'Scope confirmed and repository context collected.', evidence:['Request context','Workspace inventory','Relevant source files'] },
    plan:{ title:'Plan changes', state:'Succeeded', attempt:'Attempt 1', duration:'54s', summary:'Implementation route and focused validation selected.', evidence:['Execution plan','Risk notes'] },
    implement:{ title:'Implement dashboard prototype', state:'Running', attempt:'Attempt 1', duration:'3m 18s', summary:'Editing the Projects Agent surface and its interaction states.', evidence:['2 files changed','Working tree diff'], current:true },
    validate:{ title:'Validate behavior', state:'Pending', attempt:'Not started', duration:'--', summary:'Build, focused UI tests, and browser checks are required.', evidence:['Expected: build result','Expected: UI test result'] },
    report:{ title:'Report outcome', state:'Pending', attempt:'Not started', duration:'--', summary:'Summarize the implementation, evidence, and remaining decisions.', evidence:['Expected: final summary'] },
    release:{ title:'Release change', state:'Pending', attempt:'Not started', duration:'--', summary:'Release remains locked until every required predecessor is complete.', evidence:['Expected: release receipt'] }
  };
  const step = details[agentDashboardStep] || details.implement;
  const todos = {
    understand:[['done','Read user request'],['done','Inspect workspace context']],
    plan:[['done','Choose owning surface'],['done','Define focused validation']],
    implement:[['done','Add Automation workspace'],['active','Render session execution hierarchy'],['pending','Record detailed design']],
    validate:[['pending','Run focused UI tests'],['pending','Check responsive overflow'],['pending','Review browser interaction']],
    report:[['pending','Summarize decisions'],['pending','Link design document']],
    release:[['pending','Confirm all prerequisites'],['pending','Create release receipt']]
  }[agentDashboardStep] || [];
  return `<div class="agent-step-detail">
    <div class="agent-detail-heading"><div><span>Selected Step</span><h3>${esc(step.title)}</h3></div><span class="agent-status ${step.state.toLowerCase()}">${esc(step.state)}</span></div>
    <dl class="agent-detail-facts"><div><dt>Attempt</dt><dd>${esc(step.attempt)}</dd></div><div><dt>Elapsed</dt><dd>${esc(step.duration)}</dd></div><div><dt>Owner</dt><dd>GitHub Copilot</dd></div></dl>
    <section class="agent-detail-band"><h4>Activity</h4><p>${esc(step.summary)}</p>${step.current ? '<div class="agent-live-line"><i></i><span>Editing implementation</span><small>updated now</small></div>' : ''}</section>
    <section class="agent-detail-band"><h4>Todos</h4><div class="agent-todo-list">${todos.map(([status,label]) => `<div class="${status}"><span class="codicon ${status === 'done' ? 'codicon-check' : status === 'active' ? 'codicon-loading codicon-modifier-spin' : 'codicon-circle-large-outline'}"></span><span>${esc(label)}</span></div>`).join('')}</div></section>
    <section class="agent-detail-band"><h4>Evidence</h4><div class="agent-evidence-list">${step.evidence.map(item => `<button><span class="codicon codicon-file"></span><span>${esc(item)}</span><span class="codicon codicon-chevron-right"></span></button>`).join('')}</div></section>
    <section class="agent-detail-band"><h4>Deviation</h4><p class="agent-muted">None recorded. This step is following Recipe revision 3.</p></section>
  </div>`;
}

function todoTechnologyTree(execution, scope) {
  const summary = todoExecutionSummary(execution);
  const techNode = (id, title, status, condition, meta, icon, expandable) => `<div class="agent-tech-node-shell">${expandable ? `<button class="agent-tech-toggle" title="${agentTechExpanded[id] ? 'Collapse' : 'Expand'} child Recipe" aria-label="${agentTechExpanded[id] ? 'Collapse' : 'Expand'} ${esc(title)}" aria-expanded="${!!agentTechExpanded[id]}" onclick="event.stopPropagation();agentTechToggle('${id}')"><span class="codicon codicon-chevron-${agentTechExpanded[id] ? 'down' : 'right'}"></span></button>` : ''}<button role="treeitem" aria-selected="${id === agentDashboardStep}" class="agent-tech-node ${status} ${id === agentDashboardStep ? 'active' : ''}" onclick="agentDashboardSelectStep('${id}')"><i class="codicon ${icon}"></i><span><strong>${esc(title)}</strong><small><em>${esc(condition)}</em>${esc(meta)}</small></span><b>${status === 'succeeded' ? 'Complete' : status === 'running' ? 'Running' : status === 'available' ? 'Available' : 'Locked'}</b></button>${expandable && !agentTechExpanded[id] ? '<small class="agent-tech-hidden">3 child Todos</small>' : ''}</div>`;
  return `<div class="agent-tech-toolbar"><strong>Todo Technology Tree</strong><div><button title="Show only the path to the running Todo" onclick="agentTechExpansionMode('current')"><span class="codicon codicon-target"></span>Focus current</button><button title="Expand every materialized Recipe layer" onclick="agentTechExpansionMode('all')"><span class="codicon codicon-expand-all"></span>Expand all</button><button title="Collapse every Recipe layer" onclick="agentTechExpansionMode('none')"><span class="codicon codicon-collapse-all"></span>Collapse all</button></div></div><div class="agent-tech-tree vertical" role="tree" aria-label="${scope === 'project' ? 'Project' : 'Agent'} Todo technology tree"><div class="agent-tech-canvas">
    <button class="agent-tech-root" aria-expanded="${!!agentTechExpanded.root}" onclick="agentTechToggle('root')"><span>Project</span><strong>${esc(execution.projectName)}</strong><small>Root · ${summary.total} Todo nodes · ${agentTechExpanded.root ? 'expanded' : 'collapsed'}</small><i class="codicon codicon-chevron-${agentTechExpanded.root ? 'down' : 'right'}"></i></button>
    ${agentTechExpanded.root ? `<div class="agent-tech-stem"></div><div class="agent-tech-recipe"><span class="codicon codicon-repo"></span><strong>Software Development</strong><small>Recipe r1 · expands Project</small></div>
    <div class="agent-tech-tier three">${techNode('understand','Understand request','succeeded','COUNT ≥1','Project active','codicon-search')}${techNode('plan','Plan changes','succeeded','COUNT ALL','All prerequisites','codicon-list-tree')}${techNode('implement','Implement dashboard','running','SUBSET A∧B','Named prerequisites','codicon-tools',true)}</div>
    ${agentTechExpanded.implement ? `<div class="agent-tech-expansion"><div class="agent-tech-stem"></div><div class="agent-tech-recipe nested"><span class="codicon codicon-git-branch"></span><strong>UI Development</strong><small>Recipe r1 · expands selected Todo</small></div>
      <div class="agent-tech-tier three">${techNode('validate','Validate behavior','available','COUNT >1','2 of 3 prerequisites','codicon-pass')}${techNode('report','Report outcome','locked','COUNT >K','K is Recipe input','codicon-note')}${techNode('release','Release change','locked','SUBSET','(A∨B)∧C','codicon-rocket')}</div>
    </div>` : ''}` : ''}
  </div></div>`;
}

function agentDashboardBody(execution) {
  if (agentDashboardView === 'Evidence') return `<div class="agent-flat-view"><div class="agent-view-heading"><div><span>Session Evidence</span><h3>Evidence ledger</h3></div><strong>7 records</strong></div><div class="agent-ledger"><div><span>Current</span><strong>Working tree diff</strong><small>Step: Implement dashboard prototype</small></div><div><span>Verified</span><strong>Workspace UI test</strong><small>Step: Move Recipes to Tools</small></div><div><span>Captured</span><strong>Repository context</strong><small>Step: Understand request</small></div></div></div>`;
  if (agentDashboardView === 'Decisions') return `<div class="agent-flat-view"><div class="agent-view-heading"><div><span>Session Decisions</span><h3>Decision and deviation log</h3></div><strong>2 decisions</strong></div><div class="agent-ledger"><div><span>Decision</span><strong>Dashboard belongs to an Agent Session</strong><small>Recipe remains an immutable reusable definition.</small></div><div><span>Decision</span><strong>Preview data stays outside runtime storage</strong><small>The prototype must not appear as a real run.</small></div></div></div>`;
  return `<div class="agent-execution-layout">${todoTechnologyTree(execution, 'agent')}${agentDashboardStepDetail()}</div>`;
}

function agentSessionDashboard() {
  const execution = todoExecutionPreview[0];
  const summary = todoExecutionSummary(execution);
  return `<div class="agent-dashboard" data-preview="true">
    <div class="agent-preview-note"><span class="codicon codicon-beaker"></span><strong>Interactive preview</strong><span>Sample session data is shown for UX evaluation.</span></div>
    <header class="agent-session-head"><div><span>Agent Session</span><h3>${esc(execution.agent.name)} · Session agt_7f31</h3><p><span class="agent-live-dot"></span> ${esc(execution.agent.state)} for ${esc(execution.agent.elapsed)} · 2 Tasks</p></div><button class="tbtn" title="More session actions"><span class="codicon codicon-ellipsis"></span></button></header>
    <div class="agent-task-strip"><div><span>Active Task</span><strong>${esc(execution.task)}</strong><small>Project · ${esc(execution.projectName)}</small></div><button title="Previous task"><span class="codicon codicon-chevron-left"></span></button><span>1 / 2</span><button title="Next task"><span class="codicon codicon-chevron-right"></span></button></div>
    <div class="agent-session-summary"><div><span>Recipe</span><strong>${esc(execution.recipe)}</strong><small>Global · Revision ${execution.recipeRevision}</small></div><div><span>Current Todo</span><strong>${summary.completed + 1} of ${summary.total}</strong><small>${esc(summary.current?.title || 'None')}</small></div><div><span>Progress</span><strong>${summary.percent}%</strong><div class="agent-progress" aria-label="${summary.completed} of ${summary.total} Todos complete"><i style="width:${summary.percent}%"></i></div></div><div><span>Remaining</span><strong>${summary.remaining}</strong><small>Todos not complete</small></div></div>
    <nav class="agent-dashboard-tabs" aria-label="Agent session views">${['Execution','Evidence','Decisions'].map(view => `<button class="${view === agentDashboardView ? 'active' : ''}" onclick="agentDashboardSetView('${view}')">${view}</button>`).join('')}</nav>
    ${agentDashboardBody(execution)}
  </div>`;
}

function renderAgentSessions() {
  if (state.tab !== 'agentSessions') return;
  const detail = document.getElementById('detail');
  detail.innerHTML = `<div class="agent-sessions-workspace"><aside class="agent-session-list"><div class="agent-session-list-head"><strong>Agent Sessions</strong><span>1 active</span></div><button class="active"><span><i></i><strong>Copilot Agent</strong></span><small>Implement Automation workspace</small><b>Running · now</b></button><button><span><i class="idle"></i><strong>Research Agent</strong></span><small>Summarize retrieval findings</small><b>Completed · 18m ago</b></button></aside><main class="agent-session-content">${agentSessionDashboard()}</main></div>`;
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
  if (!projectSnapshot) { detail.innerHTML = '<div class="empty">Loading Projects…</div>'; return; }
  normalizeProjectRoute(projectSnapshot);
  const project = projectSnapshot.projects.find(candidate => candidate.projectId === projectRoute.projectId) || projectDefault(projectSnapshot);
  if (!project) { detail.innerHTML = projectZero('Projects unavailable','The Project store did not provide a system Default Project.'); return; }
  const threads = projectSnapshot.threads.filter(thread => thread.projectId === project.projectId);
  const recipes = (projectSnapshot.recipes || []).filter(recipe => recipe.scope !== 'global' && recipe.projectId === project.projectId);
  const executions = projectTodoExecutions(project);
  const activeAgents = new Set(executions.filter(execution => execution.agent.state === 'Running').map(execution => execution.agent.id)).size;
  detail.innerHTML = `<div class="projects-workspace">
    <aside class="project-tree" aria-label="Projects"><div class="project-tree-head"><strong>Projects</strong><button class="tbtn" onclick="projectNew()">New Project</button></div>
      ${projectSnapshot.projects.map(candidate => `<button class="project-tree-item ${candidate.projectId === project.projectId ? 'active' : ''}" onclick="projectSelect('${esc(candidate.projectId)}')"><span>${esc(candidate.name)}</span><small>${candidate.systemKind === 'default-project' ? 'System · Default' : `${projectSnapshot.threads.filter(thread => thread.projectId === candidate.projectId).length} Threads`}</small></button>`).join('')}</aside>
    <div class="project-content"><header class="project-header"><div><span>${project.systemKind === 'default-project' ? 'System Project' : 'Project'}</span><h2>${esc(project.name)}</h2><p>${threads.length} Threads · ${executions.length} Todo Executions · ${activeAgents} Active Agents</p></div><button class="tbtn" onclick="projectNewThread()">New Thread</button></header>
      <nav class="project-sections" aria-label="Project sections">${projectSections.map(section => `<button class="${section === projectRoute.section ? 'active' : ''}" onclick="projectSection('${section}')">${section}</button>`).join('')}</nav>
      <div class="project-section-body">${projectSectionBody(project, threads, recipes)}</div>
    </div></div>`;
}

function renderGlobalRecipes() {
  if (state.tab !== 'recipes') return;
  const detail = document.getElementById('detail');
  if (!projectSnapshot) { detail.innerHTML = '<div class="empty">Loading Recipes…</div>'; return; }
  const recipes = (projectSnapshot.recipes || []).filter(recipe => recipe.scope === 'global');
  if (!recipes.some(recipe => recipe.recipeId === selectedRecipeId)) selectedRecipeId = recipes[0]?.recipeId || '';
  const selected = recipes.find(recipe => recipe.recipeId === selectedRecipeId);
  detail.innerHTML = `<div class="global-recipes-workspace"><header class="project-header"><div><span>Automation</span><h2>Recipe Library</h2><p>${recipes.length} reusable Recipes</p></div><button class="tbtn" onclick="projectNewRecipe()">New Recipe</button></header><div class="recipe-library-workbench" style="--recipe-tree-width:${recipeTreeWidth}px"><aside class="recipe-library-tree"><div class="recipe-search"><span class="codicon codicon-search"></span><input type="search" value="${esc(recipeSearchQuery)}" placeholder="Search Recipes and Steps" aria-label="Search Recipes" oninput="recipeSearch(this.value)">${recipeSearchQuery ? '<button title="Clear Recipe search" aria-label="Clear Recipe search" onclick="recipeSearch(\'\')"><span class="codicon codicon-close"></span></button>' : ''}</div>${globalRecipeTree(recipes)}</aside><div class="recipe-library-resizer" title="Drag to resize Recipe CatTree" onpointerdown="recipeTreeResizeStart(event)"></div><main class="recipe-library-editor">${globalRecipeEditor(selected)}</main></div></div>`;
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

function projectOnState(snapshot) {
  projectSnapshot = snapshot;
  normalizeProjectRoute(snapshot);
  if (state.tab === 'agentSessions') renderAgentSessions(); else if (state.tab === 'recipes') renderGlobalRecipes(); else renderProjects();
}

function projectOnResult(data) {
  finishAction('projectCreate','threadCreate','threadMove','recipeCreate','recipeUpdate');
  projectSnapshot = data.snapshot;
  if (data.action === 'recipeUpdate') { recipeDraft = null; recipeDraftRecipeId = ''; }
  if (data.action === 'projectCreate') { projectRoute.projectId = data.entityId; projectRoute.section = 'Overview'; }
  if (data.action === 'threadCreate') projectRoute.section = 'Threads';
  if (data.action === 'recipeCreate' && state.tab === 'projects') { projectRoute.section = 'Todos'; projectRoute.workflowView = 'Recipes'; }
  if (data.action === 'recipeCreate' && state.tab === 'recipes') selectedRecipeId = data.entityId;
  normalizeProjectRoute(projectSnapshot);
  if (state.tab === 'agentSessions') renderAgentSessions(); else if (state.tab === 'recipes') renderGlobalRecipes(); else renderProjects();
}

function projectOnError(data) {
  finishAction('projectCreate','threadCreate','threadMove','recipeCreate','recipeUpdate');
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
      editorError.textContent = data?.error || 'Recipe update failed.';
    }
    return;
  }
  const host = document.querySelector('.project-header') || document.getElementById('detail');
  host?.querySelector('.project-error')?.remove();
  const error = document.createElement('div'); error.className = 'project-error'; error.setAttribute('role','alert'); error.textContent = data?.error || 'Project action failed.';
  host?.appendChild(error);
}