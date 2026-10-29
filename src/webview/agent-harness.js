(function (root) {
  'use strict';
  const terminal = value => ({ succeeded:'complete', completed:'complete', complete:'complete', failed:'failed', skipped:'ignored', ignored:'ignored' })[value] || '';
  const list = value => Array.isArray(value) ? value : [];
  const key = (...parts) => JSON.stringify(parts);
  function creditLabel(summary, translate = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? `{${key}}`)) {
    if (!summary?.reportedCalls || summary.credits === undefined) return '';
    return summary.status === 'partial'
      ? translate('{credits} credits (partial: {reported}/{total} calls)', { credits:summary.credits, reported:summary.reportedCalls, total:summary.totalCalls })
      : translate('{credits} credits', { credits:summary.credits });
  }

  function svgShape(parent, tag, attrs, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  }

  function pieceInteraction(svg, group, index, action) {
    if (!action) return;
    group.setAttribute('role', 'button'); group.setAttribute('tabindex', '0');
    group.dataset.harnessFocus = key('piece',group.getAttribute('class'),index);
    const inspect = () => {
      svg.dataset.focused = 'true';
      for (const node of svg.querySelectorAll('[data-piece]')) node.classList.toggle('is-active', node.dataset.piece === String(index));
      action();
    };
    group.addEventListener('click', inspect);
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect(); }
    });
  }

  const memoryTiers = Object.freeze([
    Object.freeze({ id:'cache', label:'Cache', horizon:'Short-term', meaning:'Actual model context, evidenced by a sent manifest.' }),
    Object.freeze({ id:'memory', label:'Memory', horizon:'Mid-term', meaning:'Organized Chat history and source-backed derived observations.' }),
    Object.freeze({ id:'disk', label:'Disk', horizon:'Long-term', meaning:'Independently maintained knowledge assets and accepted Profile cards.' }),
  ]);
  function memoryTierObservations(data, attempt) {
    const sent = list(attempt?.budgetReceipts).filter(receipt => receipt.status === 'sent').at(-1);
    const manifest = sent?.contextPlan?.manifest;
    const assetKinds = new Set(['note','skill','paper','research','script','action','recipe']);
    const assets = new Set(list(attempt?.retrieval).flatMap(record => list(record.receipt?.candidates))
      .filter(candidate => assetKinds.has(candidate.kind))
      .map(candidate => candidate.sourceId || candidate.id).filter(id => typeof id === 'string' && id.length));
    const cards = ['user','agent'].filter(kind => attempt?.profileContext?.[kind]).length;
    return {
      cache:{ summary:Array.isArray(manifest) ? `${manifest.length} recorded messages` : 'No sent manifest recorded',
        detail:Array.isArray(manifest)
          ? `Last recorded sent round ${sent.round ?? 'unknown'}. Historical payload evidence, not a live view into the provider. Prepared rounds are not sent evidence.`
          : 'Context is unknown, not empty. Prepared references and stored pieces do not prove transmission.' },
      memory:{ summary:Array.isArray(data?.pieces) ? `${data.pieces.length} displayed pieces` : 'Stored overview unavailable',
        detail:'Chat-scoped, bounded stored organization. Abstraction Levels belong inside Memory; they are not temporal tiers or expiry rules.' },
      disk:{ summary:`${assets.size} asset references / ${cards} Profile snapshots`,
        detail:'References recorded in this attempt, not a Knowledge Root inventory or proof that assets still exist. Note, Skill and other saved assets have independent lifetimes; retrieval does not move or promote them.' },
    };
  }
  function memoryTierPyramid(observations, onSelect) {
    const root = document.createElement('div');
    root.className = 'pkm-harness-memory-tiers';
    root.setAttribute('role','group'); root.setAttribute('aria-label','Cache / Memory / Disk tiers');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox','0 0 600 282');
    svg.setAttribute('preserveAspectRatio','none'); svg.setAttribute('aria-hidden','true');
    svg.classList.add('pkm-harness-memory-graph'); root.append(svg);
    memoryTiers.forEach((tier,index) => {
      const observation = observations[tier.id], y = 8 + index * 90, top = 330 + index * 78, bottom = top + 72;
      svgShape(svg,'path',{d:`M${300-top/2} ${y} L${300+top/2} ${y} L${300+bottom/2} ${y+82} L${300-bottom/2} ${y+82} Z`,
        class:'pkm-harness-memory-layer','data-tier-background':tier.id});
      const row = document.createElement('div'), title = document.createElement('strong'), summary = document.createElement('span');
      row.className = 'pkm-harness-memory-tier'; row.dataset.memoryTier = tier.id; row.dataset.piece = tier.id;
      row.setAttribute('role','group');
      row.setAttribute('aria-label',`${tier.label} / ${tier.horizon}. ${observation.summary}. ${observation.detail}`);
      row.title = `${tier.meaning}\n${observation.summary}\n${observation.detail}`;
      title.textContent = `${tier.label} / ${tier.horizon}`; summary.textContent = observation.summary;
      row.append(title,summary); root.append(row);
      pieceInteraction(root,row,tier.id,onSelect && (() => onSelect(tier.id)));
    });
    return root;
  }
  const abstractionExpansion = new WeakMap();
  function memoryPyramid(data, attempt, onInspect) {
    const pyramid = memoryTierPyramid(memoryTierObservations(data,attempt));
    if (!onInspect || !Array.isArray(data?.pieces)) return pyramid;
    const section = document.createElement('section'), details = document.createElement('details'), summary = document.createElement('summary');
    section.className = 'pkm-harness-memory-stack';
    details.className = 'pkm-harness-memory-abstraction-detail';
    details.open = abstractionExpansion.get(data) === true;
    details.addEventListener('toggle',() => abstractionExpansion.set(data,details.open));
    summary.textContent = 'Inside Memory: stored abstraction levels and evidence';
    details.append(summary,memoryPiecePyramid(data,attempt,onInspect)); section.append(pyramid,details);
    return section;
  }
  function memoryPiecePyramid(data, attempt, onInspect) {
    const pieces = list(data.pieces), levels = [...new Set(pieces.map(piece => piece.level))].sort((a,b) => b-a);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const height = Math.max(150, levels.length * 100 + 50);
    svg.setAttribute('viewBox', `0 0 600 ${height}`);
    svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', 'Stored Memory Piece abstraction graph');
    svg.classList.add('pkm-harness-memory-graph');
    const positions = new Map(), layers = [], sent = new Set(), prepared = new Set(list(attempt?.memory?.blocks).map(block => block.piece));
    for (const receipt of list(attempt?.budgetReceipts).filter(receipt => receipt.status === 'sent')) {
      for (const message of list(receipt.contextPlan?.manifest)) for (const reference of list(message.referenceIds)) {
        if (reference.startsWith('memory:')) sent.add(reference.slice(7));
      }
    }
    levels.forEach((level, row) => {
      const members = pieces.filter(piece => piece.level === level), shown = members.slice(0, 6), y = 25 + row * 100;
      const top = 240 + row * 320 / Math.max(1,levels.length), bottom = 240 + (row + 1) * 320 / Math.max(1,levels.length);
      svgShape(svg,'path',{d:`M${300-top/2} ${y} L${300+top/2} ${y} L${300+bottom/2} ${y+92} L${300-bottom/2} ${y+92} Z`,class:'pkm-harness-memory-layer'});
      svgShape(svg,'text',{x:300,y:y+19,'text-anchor':'middle'},`Level ${level} / ${members.length} pieces`);
      shown.forEach((piece,index) => {
        const x = 300 - Math.min(3,shown.length) * 36 + index % 3 * 72, py = y + 28 + Math.floor(index/3)*28;
        positions.set(piece.id,{x:x+32,y:py+11});
        layers.push({piece,index:pieces.indexOf(piece),x,y:py});
      });
      if (members.length > shown.length) svgShape(svg,'text',{x:300,y:y+89,'text-anchor':'middle'},`${shown.length} shown`);
    });
    for (const edge of list(data.edges)) {
      const parent = positions.get(edge.parent), child = positions.get(edge.child);
      if (parent && child) {
        const path = svgShape(svg,'path',{d:`M${child.x} ${child.y} C${child.x} ${(child.y+parent.y)/2}, ${parent.x} ${(child.y+parent.y)/2}, ${parent.x} ${parent.y}`,
          class:'pkm-harness-memory-edge'});
        svgShape(path,'title',{},edge.relation || 'Recorded relation');
      }
    }
    for (const {piece,index,x,y} of layers) {
      const state = sent.has(piece.id) ? 'sent' : prepared.has(piece.id) ? 'prepared' : 'stored';
      const group = svgShape(svg,'g',{'data-piece':index,'data-memory-state':state,class:'pkm-harness-memory-piece',
        'aria-label':`Inspect ${piece.kind}, level ${piece.level}, piece ${index+1}`});
      svgShape(group,'title',{},onInspect
        ? `${piece.label || piece.id}\n${piece.kind} / level ${piece.level} / revision ${piece.revision ?? 'unknown'}\n${state} / ${piece.summary_current ? 'summary current' : piece.summary ? 'summary stale' : 'no summary'}${piece.summary ? `\n${String(piece.summary).slice(0,600)}` : ''}`
        : `${piece.kind} / ${state}`);
      svgShape(group,'rect',{x,y,width:64,height:22,rx:5});
      svgShape(group,'text',{x:x+32,y:y+15,'text-anchor':'middle'},String(piece.kind).slice(0,9));
      pieceInteraction(svg,group,index,onInspect && (() => onInspect(piece)));
    }
    return svg;
  }

  function retrievalPieceFlow(candidates, onInspect) {
    const description = item => `${item.label || item.id || 'Unnamed piece'}\n${item.kind || 'unknown'} / ${item.evidenceState === 'sent' ? 'sent evidence recorded' : item.selected ? 'selected, no sent evidence' : 'not selected'}\nSource: ${item.sourceUri || 'not recorded'}\n${item.method || 'unknown method'} / score ${item.score ?? 'not recorded'}\n${item.reason || 'No selection reason recorded'}`.slice(0,1800);
    const selected = candidates.map((item, index) => ({ item, index })).filter(({ item }) => item.selected);
    const shown = selected.slice(0, 24);
    const sample = [...shown, ...candidates.map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.selected).slice(0, 32 - shown.length)].sort((a, b) => a.index - b.index);
    const height = Math.max(240, 70 + Math.ceil(sample.length / 4) * 30, 70 + shown.length * 32);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 800 ${height}`);
    svg.setAttribute('role', onInspect ? 'group' : 'img');
    svg.setAttribute('aria-label', `Retrieval selection: ${candidates.length} recorded candidates, ${selected.length} selected; showing ${sample.length} candidates and ${shown.length} selected connections.`);
    svg.classList.add('pkm-harness-piece-flow');
    svg.dataset.sampleSize = String(sample.length); svg.dataset.selectedSize = String(shown.length);
    const shape = (tag, attrs, text, parent = svg) => svgShape(parent,tag,attrs,text);
    shape('text', { x:16, y:23 }, 'Candidate pool');
    shape('text', { x:278, y:23 }, 'Filter');
    shape('text', { x:420, y:23 }, 'Selected pieces');
    shape('text', { x:650, y:23 }, 'Model context');
    shape('rect', { x:8, y:38, width:208, height:height - 52, rx:12, class:'pkm-harness-piece-pool' });
    shown.forEach(({ index }, position) => {
      const source = sample.findIndex(piece => piece.index === index);
      const x = 24 + source % 4 * 46 + 36, y = 54 + Math.floor(source / 4) * 30 + 11;
      const targetY = 54 + position * 32 + 11;
      shape('path', { d:`M${x} ${y} C260 ${y}, 260 ${height/2}, 300 ${height/2} S370 ${targetY}, 420 ${targetY}`,
        class:'pkm-harness-piece-link', 'data-piece':index });
    });
    shape('path',{d:`M300 ${height/2-20} l20 20 -20 20 -20 -20 Z`,class:'pkm-harness-selection-gate'});
    const sentCount = candidates.filter(item => item.evidenceState === 'sent').length;
    shape('rect',{x:650,y:height/2-28,width:134,height:56,rx:8,class:'pkm-harness-context-box'});
    shape('text',{x:717,y:height/2-3,'text-anchor':'middle'},`${sentCount} sent`);
    shape('text',{x:717,y:height/2+15,'text-anchor':'middle'},sentCount ? 'recorded evidence' : 'not established');
    shown.forEach(({item,index},position) => {
      if (item.evidenceState === 'sent') shape('path',{d:`M584 ${65+position*32} C620 ${65+position*32}, 610 ${height/2}, 650 ${height/2}`,
        class:'pkm-harness-context-link','data-piece':index});
    });
    sample.forEach(({ item, index }, position) => {
      const x = 24 + position % 4 * 46, y = 54 + Math.floor(position / 4) * 30;
      const group = shape('g', { class:'pkm-harness-pool-piece', 'data-selected':!!item.selected, 'data-piece':index });
      group.setAttribute('aria-label', `Inspect candidate ${index+1}: ${item.kind || 'unknown'}`);
      pieceInteraction(svg,group,index,onInspect && (() => onInspect(item,index)));
      shape('title', {}, onInspect ? description(item) : `${item.kind || 'unknown'} / ${item.selected ? 'selected' : 'not selected'}`, group);
      shape('rect', { x, y, width:36, height:22, rx:4 }, undefined, group);
      shape('text', { x:x + 18, y:y + 15, 'text-anchor':'middle' }, String(item.kind || '?').slice(0, 4), group);
    });
    shown.forEach(({ item, index }, position) => {
      const y = 54 + position * 32;
      const group = shape('g', { class:'pkm-harness-chosen-piece', 'data-piece':index,
        'data-sent':item.evidenceState === 'sent' });
      group.setAttribute('aria-label', `Inspect selected piece ${index+1}: ${item.kind || 'unknown'}`);
      pieceInteraction(svg,group,index,onInspect && (() => onInspect(item,index)));
      shape('title', {}, onInspect ? description(item) : `${item.kind || 'unknown'} / ${item.evidenceState === 'sent' ? 'sent evidence recorded' : 'selected, no sent evidence'}`, group);
      shape('rect', { x:420, y, width:164, height:22, rx:5 }, undefined, group);
      shape('text', { x:430, y:y + 15 }, String(onInspect ? item.label || item.kind || 'unknown' : item.kind || 'unknown').slice(0, 18), group);
      if (item.evidenceState === 'sent') shape('circle', { cx:574, cy:y + 11, r:3 }, undefined, group);
    });
    if (!shown.length) shape('text', { x:420, y:70 }, 'None recorded');
    return svg;
  }

  function toolActivityDetails(call) {
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    const parse = value => {
      try { return JSON.parse(value); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; return undefined; }
    };
    let args = parse(call.arguments), name = call.name;
    if (!object(args)) return undefined;
    if (name === 'invoke_vscode_tool') {
      name = args.name;
      args = args.input;
      if (typeof name !== 'string' || !object(args)) return undefined;
    }
    const operation = /(?:^|_)(read_file|readFile|view)$/.test(name) ? 'Read'
      : /(?:^|_)(replace_text|replace_string_in_file|multi_replace_string_in_file|edit_file|editFile|edit)$/.test(name) ? 'Edit'
      : /(?:^|_)(save_file)$/.test(name) ? 'Save'
      : /(?:^|_)(write_file|writeFile|create_file)$/.test(name) ? 'Write'
      : /(?:^|_)(apply_patch|applyPatch|patch)$/.test(name) ? 'Patch' : undefined;
    if (operation) {
      const paths = [];
      const add = value => { if (typeof value === 'string' && value && !paths.includes(value)) paths.push(value); };
      const target = input => { add(input.path); add(input.filePath); add(input.file_path); add(input.filename); };
      target(args);
      if (Array.isArray(args.replacements)) args.replacements.filter(object).forEach(target);
      if (operation === 'Patch') {
        const patch = args.patch ?? args.input;
        if (typeof patch === 'string') for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)\r?$/gm)) add(match[1].trim());
      }
      if (!paths.length) return undefined;
      const result = call.status === 'complete' && call.name === 'replace_text' ? parse(call.result) : undefined;
      const exact = object(result) && result.applied === true && result.attribution === 'exact' && result.path === args.path
        && Number.isSafeInteger(result.added) && result.added >= 0 && Number.isSafeInteger(result.removed) && result.removed >= 0;
      return { operation, paths, ...(exact ? { added:result.added, removed:result.removed } : {}) };
    }
    if (name === 'run_process' && typeof args.program === 'string') {
      const quote = value => /^[\w./:=@%+,-]+$/.test(value) ? value : JSON.stringify(value);
      const command = [args.program, ...(Array.isArray(args.arguments) ? args.arguments.filter(value => typeof value === 'string') : [])].map(quote).join(' ');
      return { operation:'Run', command, cwd:typeof args.cwd === 'string' ? args.cwd : undefined, argv:true };
    }
    if (/(?:^|_)(run_in_terminal|runInTerminal|bash|shell|execute_command)$/.test(name) && typeof args.command === 'string') {
      return { operation:'Run', command:args.command, cwd:typeof args.cwd === 'string' ? args.cwd : undefined };
    }
    return undefined;
  }

  function describeToolCall(call, translate) {
    const label = (template, params = {}) => {
      let value = translate ? translate(template, params) : template;
      if (!translate) for (const [name, text] of Object.entries(params)) value = value.split(`{${name}}`).join(String(text));
      value = value.replace(/\s+/g, ' ').trim();
      return value.length > 240 ? `${value.slice(0, 237)}...` : value;
    };
    let args;
    try { args = JSON.parse(call.arguments); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return label('{tool} (invalid recorded arguments)', { tool:call.name });
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return label('{tool} (invalid recorded arguments)', { tool:call.name });
    const path = typeof args.path === 'string' && args.path;
    if (call.name === 'read_file' && path) {
      const start = Number.isSafeInteger(args.startLine) && args.startLine > 0;
      const end = Number.isSafeInteger(args.endLine) && args.endLine >= (start ? args.startLine : 1);
      if (end) return label('Read {path}, lines {start}-{end}', { path, start:start ? args.startLine : 1, end:args.endLine });
      if (start && args.endLine === undefined) return label('Read {path}, from line {start}', { path, start:args.startLine });
      return label('Read {path}', { path });
    }
    if (call.name === 'find_files' && typeof args.glob === 'string') return label('Find files matching {glob}', { glob:args.glob });
    if (call.name === 'search_text' && typeof args.query === 'string') return typeof args.glob === 'string' && args.glob
      ? label('Search for "{query}" in {glob}', { query:args.query, glob:args.glob })
      : label('Search for "{query}"', { query:args.query });
    if (call.name === 'replace_text' && path) return label('Edit {path}', { path });
    if (call.name === 'save_file' && path) return label('Save {path}', { path });
    if (call.name === 'list_directory' && path) return label('List directory {path}', { path });
    if (call.name === 'run_process' && typeof args.program === 'string') return label('Run {program}', { program:args.program });
    if (call.name === 'invoke_vscode_tool' && typeof args.name === 'string') return label('Invoke {tool}', { tool:args.name });
    return label('{tool}', { tool:call.name });
  }

  function build(session) {
    if (session.origin !== 'pkm-native') throw new Error('The native Harness requires a PKM-native Session.');
    const graphs = new Map(), warnings = [...list(session.harnessWarnings), ...list(session.actionWarnings)];
    const graph = (id, title, parent = null) => {
      if (!graphs.has(id)) graphs.set(id, { id, title, parent, nodes:[], edges:[] });
      return graphs.get(id);
    };
    const add = (g, id, kind, title, status, info, extra = {}) => {
      const node = { id, kind, title, status:status || 'unknown', info, ...extra };
      if (terminal(node.status) === 'ignored') node.info = {
        ...(info && typeof info === 'object' ? info : { record:info }),
        ignoreReason:info?.reason || info?.error || 'No separate ignore reason recorded; inspect the source fields.'
      };
      g.nodes.push(node);
      return node;
    };
    const main = graph(key('session', session.sessionId), session.task || 'PKM Chat');
    const harness = session.harness;
    const actions = new Map(list(session.actionRuns).map(run => [run.runId, run]));
    const actionGraphs = new Map();
    for (const run of actions.values()) actionGraphs.set(run.runId, graph(key('action', run.runId), `Action: ${run.actionId}`));
    const actionNode = (parent, run) => {
      const child = actionGraphs.get(run.runId);
      if (!child.parent) child.parent = parent.id;
      return add(parent, key('action', run.runId), 'Action / program-controlled', String(run.actionId), run.state, {
        ...run, source:{ kind:'durable-action-run', runId:run.runId },
        note:'A script controls this automation. Submission completion does not imply remote job completion.'
      }, { child:child.id });
    };
    for (const run of actions.values()) {
      const g = actionGraphs.get(run.runId);
      add(g, 'execution', 'Execution host', 'Durable Action receipts', run.state, {
        inputs:run.inputs, output:run.output, execution:run.execution, error:run.error,
        note:'Only persisted internal calls can be shown; a script definition is not an execution trace.'
      });
      const steps = list(run.steps);
      const scopes = new Map();
      for (const step of steps) if (steps.some(child => child.key.startsWith(`${step.key}/`))) {
        scopes.set(step.key, graph(key('component', run.runId, step.key), step.key));
      }
      for (const step of steps) {
        const owner = [...scopes.keys()].filter(prefix => step.key.startsWith(`${prefix}/`)).sort((a, b) => b.length - a.length)[0];
        const parent = scopes.get(owner) || g, child = scopes.get(step.key);
        if (child) child.parent = parent.id;
        add(parent, step.key, step.implementation_kind ? `Script-owned ${step.implementation_kind} execution` : 'Component', step.tool || step.program || step.key, step.state,
          { ...step, source:{ kind:'component-receipt', runId:run.runId, key:step.key } }, child ? { child:child.id } : {});
      }
      if (actions.has(run.parentRunId)) actionNode(actionGraphs.get(run.parentRunId), run);
    }
    if (!harness) warnings.push('Chat execution records are unavailable.');
    if (harness?.currentProblemSource === 'unavailable') warnings.push(harness.waiting?.detail || 'Harness snapshot unavailable.');
    add(main, 'input', 'Input / Goal', 'Recorded request', 'recorded', {
      input:harness?.currentProblem, source:harness?.currentProblemSource,
      note:'A user request is not a separately recorded goal or acceptance contract.',
      waiting:harness?.waiting, queuedInputs:harness?.queuedInputs,
      taskWorkingState:harness?.taskWorkingState,
      liveness:session.liveness, configuration:session.nativeAgent, recordUpdatedAt:session.updatedAt
    }, { executable:false });
    const todos = new Map();
    for (const todo of list(session.todos)) {
      const child = graph(key('todo', todo.todoId), todo.title, main.id);
      todos.set(todo.todoId, child);
      add(main, child.id, 'Step', todo.title, todo.status, { ...todo, source:{ kind:'session-todo', sessionId:session.sessionId, todoId:todo.todoId } }, { child:child.id });
    }
    const runs = new Map(list(session.runs).map(run => [run.runId, run]));
    const runGraphs = new Map();
    for (const run of runs.values()) runGraphs.set(run.runId, graph(key('recipe', run.runId), run.recipeName || run.runId));
    const runNode = (g, run) => add(g, key('run', run.runId), 'Recipe', run.recipeName || run.runId, run.status,
      { runId:run.runId, revision:run.recipeRevision, executableDigest:run.executableDigest },
      { child:runGraphs.get(run.runId).id, recipe:run.runId });
    for (const run of runs.values()) {
      const g = runGraphs.get(run.runId);
      const owner = list(session.todos).find(todo => list(todo.recipeRunIds).includes(run.runId) || todo.recipeRunId === run.runId);
      const treeParent = list(session.recipeTreeEdges).find(edge => edge.toRunId === run.runId);
      const parentRun = runs.get(run.parent?.runId || treeParent?.fromRunId) || [...runs.values()].find(item => list(item.nodes).some(n => n.childRunId === run.runId));
      const parent = parentRun ? runGraphs.get(parentRun.runId) : todos.get(owner?.todoId) || main;
      if (!g.parent) g.parent = parent.id;
      if (!parentRun) runNode(parent, run);
      for (const step of list(run.nodes)) {
        const childRunIds = new Set([step.childRunId,
          ...list(session.recipeTreeEdges).filter(edge => edge.fromRunId === run.runId && edge.fromNodeId === step.nodeId).map(edge => edge.toRunId),
          ...[...runs.values()].filter(child => child.parent?.runId === run.runId && child.parent?.nodeId === step.nodeId).map(child => child.runId)
        ].filter(Boolean));
        const children = [...childRunIds].map(id => runs.get(id)).filter(Boolean);
        const childRun = children[0];
        const node = add(g, step.nodeId, /command/.test(step.kind) ? 'Script automation' : 'Step', step.instruction || step.nodeId,
          step.outcome || step.state, { ...step, source:{ kind:'recipe-node', runId:run.runId, nodeId:step.nodeId } }, childRun ? { child:runGraphs.get(childRun.runId).id, recipe:childRun.runId } : {});
        const history = list(run.loops).flatMap(loop => list(loop.history).flatMap(iteration =>
          iteration.nodes?.[step.nodeId] ? [{ iteration:iteration.iteration, ...iteration.nodes[step.nodeId] }] : []));
        if (history.length || step.attempt > 1) {
          const attempts = graph(key('recipe-attempts', run.runId, step.nodeId), `${step.nodeId} attempts`, g.id);
          node.child = attempts.id;
          const seen = new Set();
          for (const record of [...history, step]) {
            const id = key('attempt', record.attempt || record.iteration || 1);
            if (seen.has(id)) continue;
            seen.add(id);
            add(attempts, id, 'Execution attempt', `Attempt ${record.attempt || record.iteration || 1}`,
              record.outcome || record.state, record);
          }
          if (step.attempt > attempts.nodes.length) warnings.push(`${run.runId}/${step.nodeId}: some earlier attempt records are unavailable.`);
          if (childRun) { runGraphs.get(childRun.runId).parent = attempts.id; runNode(attempts, childRun); }
        } else if (!childRun && (step.progress || step.result !== undefined || step.background)) {
          const evidence = graph(key('step-evidence', run.runId, step.nodeId), step.nodeId, g.id);
          node.child = evidence.id;
          add(evidence, 'record', 'Execution record', 'Recorded progress and result', step.state, step);
        }
        if (step.childRunId && !childRun) warnings.push(`Nested Recipe ${step.childRunId} is unavailable.`);
        if (children.length > 1) {
          let childGraph = node.child && graphs.get(node.child);
          if (!childGraph || runGraphs.get(childRun.runId) === childGraph) {
            childGraph = graph(key('nested-recipes', run.runId, step.nodeId), `${step.nodeId} Recipes`, g.id);
            node.child = childGraph.id;
          }
          for (const child of children) {
            runGraphs.get(child.runId).parent = childGraph.id;
            if (!childGraph.nodes.some(item => item.recipe === child.runId)) runNode(childGraph, child);
          }
        }
        for (const dependency of list(step.dependsOn)) g.edges.push({ from:dependency.from, to:step.nodeId, kind:dependency.loop ? 'loop' : 'dependency', accept:dependency.accept });
      }
    }
    const attempts = list(harness?.attempts);
    const byAttempt = new Map(attempts.flatMap(item => [[item.attemptId || item.messageId, item], [item.messageId, item]]));
    const groups = new Map();
    for (const attempt of attempts) {
      let first = attempt;
      const visited = new Set();
      while (first.retryOf && byAttempt.has(first.retryOf) && !visited.has(first.retryOf)) {
        visited.add(first.retryOf); first = byAttempt.get(first.retryOf);
      }
      if (first.retryOf && visited.has(first.retryOf)) warnings.push(`Retry cycle recorded for ${attempt.messageId}.`);
      const groupId = key('chat-step', first.attemptId || first.messageId);
      let group = groups.get(groupId);
      if (!group) {
        let parent = todos.get(first.taskId) || main;
        const binding = first.planning;
        if (binding?.recipeRunId && binding.recipeStageId) {
          const runGraph = runGraphs.get(binding.recipeRunId);
          const step = runGraph?.nodes.find(node => node.id === binding.recipeStageId);
          if (step) {
            const evidence = graph(key('step-evidence', binding.recipeRunId, binding.recipeStageId), step.title, runGraph.id);
            if (step.child && step.child !== evidence.id) {
              const nested = graphs.get(step.child);
              add(evidence, key('nested', nested.id), 'Nested execution', nested.title, 'recorded',
                { source:'Recorded Step nesting' }, { child:nested.id, recipe:step.recipe, executable:false });
              nested.parent = evidence.id;
            }
            step.child = evidence.id;
            parent = evidence;
          } else warnings.push(`Recorded Harness binding ${binding.recipeRunId}/${binding.recipeStageId} is unavailable.`);
        }
        group = graph(groupId, (first.associatedProblem || 'Direct execution').slice(0, 100), parent.id);
        groups.set(groupId, group);
        add(parent, groupId, 'Step', group.title, attempt.status, {
          input:first.associatedProblem, inputId:first.inputId, taskId:first.taskId,
          refinement:first.planning ? 'Recorded planning' : 'Direct execution / not refined',
          note:'No recorded plan is not an ignored step. Attempt completion is not task validation.'
        }, { child:group.id });
      }
      const parentNode = graphs.get(group.parent).nodes.find(node => node.child === group.id);
      parentNode.status = attempt.status;
      if (attempt.planning) parentNode.info.refinement = 'Recorded planning in one or more attempts';
      const a = graph(key('chat-attempt', attempt.messageId), `Attempt ${attempt.attempt || attempt.attemptId || attempt.messageId}`, group.id);
      add(group, attempt.attemptId || attempt.messageId, 'Harness attempt', a.title, attempt.status, {
        attemptId:attempt.attemptId, retryOf:attempt.retryOf, retryReason:attempt.retryReason, model:attempt.model, progress:attempt.progress,
        note:attempt.retryOf ? 'Retry relationship is recorded; missing retry reasons are not inferred.' : 'No retry relationship recorded.'
      }, { child:a.id });
      if (attempt.retryOf) group.edges.push({ from:attempt.retryOf, to:attempt.attemptId || attempt.messageId, kind:'retry' });
      add(a, 'input', 'Input', 'Associated input', 'recorded', { text:attempt.associatedProblem, source:attempt.problemSource }, { executable:false });
      const reportSteps = new Map(), reports = list(attempt.harnessReports);
      if (attempt.memory?.accounting) {
        const memory = graph(key('memory-accounting', attempt.messageId), 'Independent Memory inference accounting', a.id);
        const recordedMemory = add(a, 'memory-accounting', 'Memory accounting', 'Memory preparation accounting', attempt.memory.error ? 'failed' : 'recorded', {
          ...attempt.memory.accounting, turn:attempt.memory.turn,
          note:'Preparation snapshot only. Post-reply extraction is stored in the original durable Memory turn receipt, not written back into the Chat. Missing usage is not zero or free.'
        }, { child:memory.id, executable:false });
        if (session.memoryReceiptReader) recordedMemory.memoryReceipt = { messageId:attempt.messageId };
        for (const [index, call] of list(attempt.memory.calls).entries()) add(memory, String(index), 'Memory model call',
          `${call.purpose} / ${index + 1}`, call.status, call, { executable:false });
      }
      if (list(attempt.invocationBudgets).length) {
        const invocations = graph(key('invocation-budgets', attempt.messageId), 'Tool / retrieval invocation budgets', a.id);
        add(a, 'invocation-budgets', 'Invocation budgets', `${attempt.invocationBudgets.length} observed invocations`, 'recorded', {
          note:'Each invocation is recorded once, independently of model rounds. Active time excludes tracked PKM user waits, not CPU time. Missing deadlines are unknown, not unlimited.'
        }, { child:invocations.id, executable:false });
        for (const invocation of attempt.invocationBudgets) add(invocations, invocation.id, 'Invocation accounting',
          invocation.label, invocation.status, invocation, { executable:false });
      }
      if (list(attempt.budgetReceipts).length) {
        const budgets = graph(key('budgets', attempt.messageId), 'Per-round budget receipts', a.id);
        add(a, 'budgets', 'Budget', `${attempt.budgetReceipts.length} prepared rounds`, 'recorded',
          { note:'Input accounting is an estimate; prepared is not proof of provider acceptance or task completion.' }, { child:budgets.id, executable:false });
        for (const receipt of attempt.budgetReceipts) {
          const node = add(budgets, String(receipt.round), 'Budget receipt', `Round ${receipt.round}`, receipt.status || 'prepared', receipt, { executable:false });
          if (receipt.ledger?.schema === 'pkm.chat.budget-ledger/v1' && list(receipt.ledger.entries).length) {
            const ledger = graph(key('budget-ledger', attempt.messageId, receipt.round), `Round ${receipt.round} budget ledger`, budgets.id);
            node.child = ledger.id;
            for (const entry of receipt.ledger.entries) add(ledger, entry.id, 'Budget accounting', `${entry.label} (${entry.unit})`,
              entry.consumed ? 'recorded' : 'unavailable', entry, { executable:false });
          }
        }
      }
      if (reports.length) {
        const records = graph(key('reports', attempt.messageId), 'Task / planning / validation reports', a.id);
        add(a, 'reports', 'Harness reports', `${reports.length} explicit reports`, 'recorded', {
          note:'Agent-reported observations; user, managed Task and Recipe authority are unchanged.'
        }, { child:records.id, executable:false });
        for (const report of reports) {
          const status = report.status === 'start' ? 'running' : report.status || 'recorded';
          add(records, report.id, `Reported ${report.kind}`, report.summary || report.goal || report.kind, status, report,
            { executable:report.kind === 'step' || report.kind === 'validation' });
          if (report.kind === 'step') reportSteps.set(report.binding.stepId, report);
        }
        for (const [id, report] of reportSteps) graph(key('reported-step', attempt.messageId, id), report.summary || id, a.id);
        for (const [id, report] of reportSteps) {
          const s = graphs.get(key('reported-step', attempt.messageId, id));
          const owner = report.binding.parentStepId && reportSteps.has(report.binding.parentStepId)
            ? graphs.get(key('reported-step', attempt.messageId, report.binding.parentStepId)) : a;
          s.parent = owner.id;
          add(owner, key('step', id), 'Step (agent report)', report.summary || id,
            report.status === 'start' ? 'running' : report.status, report, { child:s.id,
              ...(runs.has(report.binding.recipeRunId) ? { recipe:report.binding.recipeRunId } : {}) });
          add(s, 'lifecycle', 'Step reports', 'Recorded lifecycle', report.status === 'start' ? 'running' : report.status,
            reports.filter(item => item.kind === 'step' && item.binding.stepId === id), { executable:false });
          const stepAttempts = [];
          for (const item of reports.filter(item => item.kind === 'step' && item.binding.stepId === id)) {
            if (item.status === 'start' || !stepAttempts.length) stepAttempts.push([]);
            stepAttempts[stepAttempts.length - 1].push(item);
          }
          if (stepAttempts.length > 1) stepAttempts.forEach((items, index) => {
            const first = items[0], last = items[items.length - 1];
            const identity = first.binding.stepAttemptId || first.id;
            const details = graph(key('step-attempt', attempt.messageId, identity), `Step attempt ${index + 1}`, s.id);
            add(s, identity, 'Step attempt', details.title, last.status === 'start' ? 'running' : last.status, items, { child:details.id });
            add(details, 'reports', 'Step reports', 'Recorded lifecycle', 'recorded', items, { executable:false });
            if (index) s.edges.push({ from:stepAttempts[index - 1][0].binding.stepAttemptId || stepAttempts[index - 1][0].id, to:identity, kind:'retry' });
          });
        }
      }
      if (attempt.planning) {
        const p = graph(key('planning', attempt.messageId), 'Recorded planning', a.id);
        add(a, 'planning', 'Planning', 'Possibilities and decisions', 'recorded', attempt.planning, { child:p.id, executable:false });
        const possibilities = list(attempt.planning.possibilities);
        const planGraphs = new Map();
        for (const item of possibilities) if (possibilities.some(other => other.parentId === item.id)) {
          planGraphs.set(item.id, graph(key('possibility', attempt.messageId, item.id), item.label));
        }
        for (const item of possibilities) {
          const parent = planGraphs.get(item.parentId) || p;
          const child = planGraphs.get(item.id);
          if (child) child.parent = parent.id;
          add(parent, item.id, 'Possibility', item.label, item.status, item, { executable:false, ...(child ? { child:child.id } : {}) });
        }
        const recipe = runs.get(attempt.planning.recipeRunId);
        if (recipe) add(p, 'recipe-reference', 'Recipe reference', recipe.recipeName, 'recorded', { runId:recipe.runId }, { recipe:recipe.runId, executable:false });
      } else add(a, 'planning', 'Planning', 'Direct execution / not refined', 'recorded', { note:'The agent may execute without refining a plan; this is not ignored.' }, { executable:false });
      const retrieval = list(attempt.retrieval);
      if (retrieval.length) {
        const r = graph(key('retrieval', attempt.messageId), 'Retrieval records', a.id);
        add(a, 'retrieval', 'Retrieval', `${retrieval.length} receipts`, 'recorded', { note:'Selection and sent-round receipts are distinct evidence.' }, { child:r.id, executable:false });
        retrieval.forEach((receipt, i) => add(r, String(i), 'Retrieval', receipt.kind, 'recorded', receipt, { executable:false }));
      }
      const calls = list(attempt.toolCalls);
      if (calls.length) {
        const c = graph(key('calls', attempt.messageId), 'Function / MCP calls', a.id);
        add(a, 'calls', 'Tool calls', `${calls.length} recorded calls`, 'recorded', { note:'Model-issued tool calls are not Actions. Call identity and arguments are shown verbatim; transport is not inferred.' }, { child:c.id, executable:false });
        for (const call of calls) {
          const owner = graphs.get(key('step-attempt', attempt.messageId, call.harnessBinding?.stepAttemptId))
            || (call.harnessBinding?.stepId && reportSteps.has(call.harnessBinding.stepId)
              ? graphs.get(key('reported-step', attempt.messageId, call.harnessBinding.stepId)) : c);
          const title = describeToolCall(call);
          const details = graph(key('call', attempt.messageId, call.id), title, owner.id);
          add(owner, call.id, 'Function / MCP call', title, call.status, call, { child:details.id });
          if (call.harnessBinding?.recipeRunId && call.harnessBinding.recipeStageId) {
            const runGraph = runGraphs.get(call.harnessBinding.recipeRunId);
            const recipeStep = runGraph?.nodes.find(node => node.id === call.harnessBinding.recipeStageId);
            if (recipeStep) {
              const evidence = graph(key('step-evidence', call.harnessBinding.recipeRunId, call.harnessBinding.recipeStageId), recipeStep.title, runGraph.id);
              if (recipeStep.child && recipeStep.child !== evidence.id) {
                const nested = graphs.get(recipeStep.child);
                if (!evidence.nodes.some(node => node.child === nested.id)) add(evidence, key('nested', nested.id), 'Nested execution', nested.title, 'recorded', {}, { child:nested.id, executable:false });
                nested.parent = evidence.id;
              }
              recipeStep.child = evidence.id;
              add(evidence, key(attempt.messageId, call.id), 'Function / MCP call', title, call.status,
                { ...call, note:'Explicit recorded Recipe Stage binding; this link is not inferred from tool names.' }, { child:details.id });
            } else warnings.push(`Call ${call.id}: recorded Recipe Stage binding is unavailable.`);
          }
          add(details, 'arguments', 'Parameters', 'Recorded arguments', 'recorded', call.arguments, { executable:false });
          add(details, 'result', 'Result', call.status === 'running' ? 'Result pending' : call.resultTruncated ? `Preview (${call.resultPreview.length}/${call.resultCharacters} characters)` : 'Recorded result',
            call.status, call.resultPreview, { fullResult:call.resultTruncated ? { messageId:attempt.messageId, callId:call.id } : undefined });
          for (const id of list(call.actionRunIds)) {
            const action = actions.get(id);
            if (action) actionNode(details, action);
            else warnings.push(`Referenced Action Run ${id}: no execution record loaded.`);
          }
        }
      }
      if (attempt.progress) {
        const t = graph(key('transitions', attempt.messageId), 'Harness transitions', a.id);
        add(a, 'transitions', 'State transitions', 'Recorded timeline', attempt.progress.status, {
          droppedSteps:attempt.progress.droppedSteps, note:'These events are observations, not inferred child plans.'
        }, { child:t.id });
        list(attempt.progress.transitions).forEach((event, i) => add(t, key(event.at, i), 'Event', event.label, event.status, event, { executable:false }));
        if (attempt.progress.droppedSteps) warnings.push(`${attempt.messageId}: ${attempt.progress.droppedSteps} transitions were not retained by the recorder.`);
      }
      const outputGraph = graph(key('public-output', attempt.messageId), 'Agent explanation / response', a.id);
      const outputs = list(attempt.publicOutputs);
      const note = 'Original public assistant output, not hidden reasoning. No extra summary/model request. Response completion does not certify task validation.';
      for (const summary of list(attempt.reasoningSummaries)) add(outputGraph, key('reasoning-summary', summary.round), 'Public reasoning summary',
        `Provider summary / round ${summary.round + 1}`, 'recorded',
        { note:'Explicit public provider summary only; hidden reasoning is not exposed.' }, { executable:false, publicText:summary.text });
      if (outputs.length) {
        outputs.forEach((output, index) => {
          const last = index === outputs.length - 1;
          const title = output.hasToolCalls ? `Progress explanation / round ${output.round + 1}`
            : last && attempt.status === 'complete' ? 'Final response / conclusion'
            : last && attempt.status === 'streaming' ? 'Live response' : 'Partial response';
          add(outputGraph, key('output', output.round, index), 'Public assistant output', title, 'recorded',
            { text:output.text, round:output.round, range:{ start:output.start, end:output.end, offsetEncoding:'utf16' }, note },
            { executable:false, publicText:output.text });
        });
      } else if (attempt.response) {
        add(outputGraph, 'legacy-output', 'Public assistant output', 'Recorded response (phase boundaries unavailable)', 'recorded',
          { text:attempt.response, note }, { executable:false, publicText:attempt.response });
      } else {
        add(outputGraph, 'no-output', 'Public assistant output', 'No public explanation or response recorded', 'unavailable',
          { note:'Activity events are not inferred reasoning; no summary was generated.' }, { executable:false });
      }
      add(outputGraph, 'outcome', 'Response metadata', 'Status / error / usage', 'recorded', attempt.validation || {}, { executable:false });
      add(a, 'response', 'Response', 'Agent explanation / response', attempt.status,
        { ...attempt.validation, note }, { child:outputGraph.id, executable:false });
    }
    for (const g of actionGraphs.values()) if (!g.parent) g.parent = main.id;
    for (const g of graphs.values()) {
      const visited = new Set([g.id]);
      let parent = g.parent;
      while (parent && graphs.has(parent)) {
        if (visited.has(parent)) { warnings.push(`Hierarchy cycle at ${g.title}; parent navigation detached.`); g.parent = main.id; break; }
        visited.add(parent); parent = graphs.get(parent).parent;
      }
      for (const node of g.nodes) if (node.child && !graphs.get(node.child)?.nodes.length) {
        delete node.child;
        node.info = { record:node.info, note:'No nested execution evidence recorded.' };
      }
    }
    const model = { root:main.id, graphs, runs, warnings:[...new Set(warnings)] };
    model.overview = overview(session, model, actions);
    model.lifecycle = lifecycle(session, model, actions);
    return model;
  }

  const stageIds = ['configure', 'run', 'monitor', 'evaluate', 'check', 'end'], stageOrder = stageIds, RING = 'lifecycle';
  function lifecycle(session, model, actions) {
    const harness = session.harness || {}, attempts = list(harness.attempts);
    const attempt = attempts.at(-1);
    const reports = list(attempt?.harnessReports), calls = list(attempt?.toolCalls);
    const validation = [...reports].reverse().find(report => report.kind === 'validation');
    const setup = [...reports].reverse().find(report => report.kind === 'task' || report.kind === 'planning');
    const referenced = calls.flatMap(call => list(call.actionRunIds)).map(id => actions.get(id)).filter(Boolean);
    const backgroundRuns = referenced.filter(run => !terminal(run.state) && !['cancelled', 'submitted-and-closed'].includes(run.state));
    const state = harness.state || session.status || 'unknown';
    const live = liveStatuses.has(attempt?.status)
      || (['awaiting-input', 'awaiting-result'].includes(state) && !['failed', 'interrupted', 'cancelled'].includes(attempt?.status))
      || (!attempt && state === 'running');
    const waitingUser = harness.waiting?.kind === 'user' || state === 'awaiting-input';
    const outputs = list(attempt?.publicOutputs);
    const todos = list(session.todos), taskAccepted = session.status === 'completed' && todos.length > 0
      && todos.every(todo => ['complete', 'completed', 'succeeded', 'skipped', 'ignored'].includes(todo.status));
    let current, outcome, check = 'pending', reason;
    if (!attempt) { current = 'configure'; outcome = live ? 'running' : 'pending'; reason = 'No Harness attempt recorded yet.'; }
    else if (live) {
      outcome = waitingUser ? 'waiting' : 'running';
      if (validation?.status === 'start') { current = 'evaluate'; reason = validation.summary || 'Validation report started.'; }
      else if (harness.waiting?.kind === 'dependency' || state === 'awaiting-result' || backgroundRuns.length) {
        current = 'monitor'; outcome = 'waiting';
        reason = harness.waiting?.detail || (backgroundRuns.length ? `${backgroundRuns.length} referenced Action Run(s) not terminal.` : 'Awaiting a background result.');
      } else if (setup?.status === 'start' || (harness.currentPhase?.kind === 'planning' && !calls.length && !outputs.length)) {
        current = 'configure'; reason = setup?.summary || harness.currentPhase?.label || 'Preparing the request.';
      } else { current = 'run'; reason = harness.currentPhase?.label || 'Agent executing.'; }
      if (waitingUser) reason = `Waiting for you: ${harness.waiting?.detail || 'input or approval'}`;
    } else if (taskAccepted || validation?.status === 'complete') {
      current = 'end'; outcome = 'complete'; check = 'passed';
      reason = taskAccepted ? 'Managed Task completed.' : validation.summary || 'Validation report passed with recorded evidence.';
    } else if (validation?.status === 'failed') {
      current = 'check'; outcome = 'failed'; check = 'failed'; reason = validation.summary || validation.reason || 'Validation failed; iterate from Configure.';
    } else if (['failed', 'interrupted', 'cancelled'].includes(attempt.status)) {
      current = 'run'; outcome = attempt.status === 'failed' ? 'failed' : attempt.status;
      reason = attempt.validation?.error || `Attempt ${attempt.status}.`;
    } else {
      current = 'check'; outcome = 'unverified'; check = 'unverified';
      reason = 'Response delivered; no validation was recorded, so goals are not confirmed.';
    }
    const index = stageIds.indexOf(current);
    const usage = attempt?.validation?.reportedUsage;
    const graphOr = (...ids) => ids.find(id => id && model.graphs.has(id));
    const m = attempt?.messageId, attemptGraph = m && key('chat-attempt', m);
    const items = {
      configure:[
        ['Task / goal', harness.currentProblem || attempt?.associatedProblem || 'not recorded'],
        ['Agent / model', attempt?.model || session.nativeAgent?.model || 'not recorded'],
        ['Planning', attempt?.planning ? `${list(attempt.planning.possibilities).length} recorded possibilities` : 'direct execution / not refined'],
        ['Acceptance criteria', reports.find(report => report.kind === 'task')?.goal || 'not recorded'],
      ],
      run:[
        ['Model output rounds', Array.isArray(attempt?.publicOutputs) ? String(new Set(outputs.map(output => output.round)).size) : 'not recorded'],
        ['Tool calls', Array.isArray(attempt?.toolCalls) ? `${calls.length} (${calls.filter(call => call.status === 'running').length} running, ${calls.filter(call => call.status === 'failed').length} failed)` : 'not recorded'],
        ['Retrieval receipts', Array.isArray(attempt?.retrieval) ? String(attempt.retrieval.length) : 'not recorded'],
        ['Reported steps', Array.isArray(attempt?.harnessReports) ? String(new Set(reports.filter(report => report.kind === 'step').map(report => report.binding?.stepId)).size) : 'not recorded'],
        ['Scope', 'Latest attempt only; zero means no recorded events, not a test result.'],
        ['Attempt outcome', attempt?.status || 'not recorded'],
        ['Error', attempt?.validation?.error || 'none recorded'],
      ],
      monitor:[
        ['Waiting on', harness.waiting?.kind === 'dependency' ? harness.waiting.detail : backgroundRuns.length ? `${backgroundRuns.length} Action Run(s)` : 'nothing recorded'],
        ['Action Runs', referenced.length ? referenced.map(run => `${run.actionId}: ${run.state}`).join(', ') : 'none referenced'],
        ['Prepared model rounds', String(list(attempt?.budgetReceipts).length)],
        ...(usage ? [['Reported usage', `${usage.inputTokens ?? '?'} in / ${usage.outputTokens ?? '?'} out`]] : []),
        ...(creditLabel(attempt?.validation?.reportedCredits) ? [['Copilot credits (Chat only)', creditLabel(attempt.validation.reportedCredits)]] : []),
        ['Liveness', session.liveness?.state || 'not recorded'],
      ],
      evaluate:[
        ['Validation reports', String(reports.filter(report => report.kind === 'validation').length)],
        ['Latest', validation ? `${validation.status}: ${validation.summary || ''}` : 'none recorded'],
        ['Evidence calls', validation ? String(list(validation.evidenceCallIds).length) : '0'],
      ],
      check:[
        ['Meets goals?', { passed:'yes (recorded)', failed:'no - iterate', unverified:'not validated', pending:'not decided yet' }[check]],
        ['Iterations', String(attempts.filter(item => item.retryOf).length + 1)],
      ],
      end:[['Result', check === 'passed' ? 'accepted' : 'not reached']],
    };
    const evidence = {
      configure:graphOr(m && key('planning', m), attemptGraph), run:graphOr(m && key('calls', m), attemptGraph),
      monitor:graphOr(referenced[0] && key('action', referenced[0].runId), m && key('transitions', m), m && key('budgets', m), attemptGraph),
      evaluate:graphOr(m && key('reports', m), attemptGraph), check:graphOr(attemptGraph), end:graphOr(m && key('public-output', m), attemptGraph),
    };
    const stages = stageIds.map((id, position) => ({
      id, label:{ configure:'Configure', run:'Run', monitor:'Monitor', evaluate:'Evaluate', check:'Check', end:'End' }[id],
      status:id === current ? outcome : position < index && id !== 'end' ? 'visited' : 'pending',
      current:id === current, items:items[id], graphId:evidence[id] || model.root,
    }));
    const passed = id => stageIds.indexOf(id) < index;
    if (passed('monitor') && !referenced.length && harness.waiting?.kind !== 'dependency') stages[2].status = 'skipped';
    if (passed('evaluate') && !validation && !taskAccepted) stages[3].status = 'skipped';
    const activity = live && current === 'run'
      ? calls.findLast(call => call.status === 'running')?.name || harness.currentPhase?.label || ''
      : '';
    return { current, outcome, check, reason, live, activity, waitingUser, iterations:attempts.filter(item => item.retryOf).length, stages };
  }

  const liveStatuses = new Set(['running', 'streaming', 'waiting', 'awaiting-input', 'awaiting-result']);
  function depth(graphs, g) {
    let count = 0;
    for (let parent = g.parent, seen = new Set(); parent && !seen.has(parent); parent = graphs.get(parent)?.parent) { seen.add(parent); count++; }
    return count;
  }
  function currentNode(model) {
    const candidates = [...model.graphs.values()].flatMap(graph => graph.nodes
      .filter(node => liveStatuses.has(node.status)).map(node => ({ graph, node })));
    candidates.sort((left, right) => depth(model.graphs, right.graph) - depth(model.graphs, left.graph));
    return candidates[0];
  }
  function overview(session, model, actions) {
    const harness = session.harness || {}, attempts = list(harness.attempts);
    const attempt = [...attempts].reverse().find(item => liveStatuses.has(item.status)) || attempts.at(-1);
    const current = currentNode(model), path = [];
    if (current) {
      path.push({ graphId:current.graph.id, nodeId:current.node.id, kind:current.node.kind, title:current.node.title, status:current.node.status });
      for (let g = current.graph, seen = new Set(); g?.parent && !seen.has(g.id); g = model.graphs.get(g.parent)) {
        seen.add(g.id);
        const owner = model.graphs.get(g.parent), node = owner?.nodes.find(item => item.child === g.id);
        if (!node) break;
        path.unshift({ graphId:owner.id, nodeId:node.id, kind:node.kind, title:node.title, status:node.status });
      }
    }
    const recipeBindings = new Map(), add = (runId, nodeId, source) => {
      if (!runId) return;
      const id = key(runId, nodeId || '');
      if (recipeBindings.has(id)) return;
      const run = model.runs.get(runId), node = list(run?.nodes).find(item => item.nodeId === nodeId);
      recipeBindings.set(id, { runId, nodeId, source, available:!!run && (!nodeId || !!node),
        name:run?.recipeName || runId, status:node ? node.outcome || node.state : run?.status,
        graphId:model.graphs.has(key('recipe', runId)) ? key('recipe', runId) : undefined });
    };
    if (attempt) {
      const todo = list(session.todos).find(item => item.todoId === attempt.taskId);
      for (const runId of [...list(todo?.recipeRunIds), todo?.recipeRunId].filter(Boolean)) add(runId, '', 'managed-task');
      add(attempt.planning?.recipeRunId, attempt.planning?.recipeStageId, 'planning');
      for (const report of list(attempt.harnessReports)) add(report.binding?.recipeRunId, report.binding?.recipeStageId, 'step-report');
      for (const call of list(attempt.toolCalls)) add(call.harnessBinding?.recipeRunId, call.harnessBinding?.recipeStageId, 'tool-call');
    }
    const actionBindings = [...new Set(list(attempt?.toolCalls).flatMap(call => list(call.actionRunIds)))].map(runId => {
      const run = actions.get(runId);
      const components = list(run?.steps).filter(step => !terminal(step.state) && step.state !== 'cancelled').map(step => ({ key:step.key, state:step.state }));
      return { runId, available:!!run, actionId:run?.actionId, state:run?.state, components,
        graphId:model.graphs.has(key('action', runId)) ? key('action', runId) : undefined };
    });
    const outputs = list(attempt?.publicOutputs), calls = list(attempt?.toolCalls);
    return {
      state:harness.state || session.status || 'unknown',
      phase:harness.currentPhase || undefined,
      waiting:harness.waiting || undefined,
      liveness:session.liveness?.state,
      attempt:attempt ? {
        id:attempt.attemptId || attempt.messageId, messageId:attempt.messageId, number:attempt.attempt, status:attempt.status, model:attempt.model,
        retryOf:attempt.retryOf, graphId:key('chat-attempt', attempt.messageId),
        preparedRounds:list(attempt.budgetReceipts).length,
        publicRounds:new Set(outputs.map(output => output.round)).size,
        toolCalls:calls.length, runningToolCalls:calls.filter(call => call.status === 'running').length,
      } : undefined,
      path,
      recipes:[...recipeBindings.values()],
      actions:actionBindings,
    };
  }

  function layout(graph) {
    const positions = new Map(), ranks = new Map(graph.nodes.map(node => [node.id, 0]));
    const edges = graph.edges.filter(edge => edge.kind !== 'loop' && ranks.has(edge.from) && ranks.has(edge.to));
    const pending = new Set(ranks.keys());
    while (pending.size) {
      const ready = [...pending].filter(id => !edges.some(edge => edge.to === id && pending.has(edge.from)));
      if (!ready.length) break;
      for (const id of ready) {
        for (const edge of edges.filter(edge => edge.to === id)) ranks.set(id, Math.max(ranks.get(id), ranks.get(edge.from) + 1));
        pending.delete(id);
      }
    }
    let tail = Math.max(0, ...ranks.values()) + 1;
    for (const id of pending) ranks.set(id, tail++);
    if (!edges.length) graph.nodes.forEach((node, i) => ranks.set(node.id, i));
    const rows = new Map();
    for (const node of graph.nodes) { const rank = ranks.get(node.id); const row = rows.get(rank) || []; row.push(node); rows.set(rank, row); }
    let width = 336;
    for (const [rank, nodes] of rows) {
      width = Math.max(width, nodes.length * 336);
      nodes.forEach((node, column) => positions.set(node.id, { x:column * 336 + 24, y:rank * 244 + 32 }));
    }
    return { positions, width, height:Math.max(280, (Math.max(0, ...ranks.values()) + 1) * 244 + 32),
      forward:edges.filter(edge => positions.get(edge.to).y > positions.get(edge.from).y),
      deferred:graph.edges.filter(edge => !edges.includes(edge) || positions.get(edge.to).y <= positions.get(edge.from).y) };
  }

  let mountCount = 0;
  function mount(container, options) {
    const detailId = `pkm-harness-detail-${++mountCount}`;
    const document = container.ownerDocument;
    const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
    const button = (text, action, label) => { const node = el('button', text); node.type = 'button'; if (label) node.setAttribute('aria-label', label); node.addEventListener('click', action); return node; };
    const root = el('section', undefined, 'pkm-harness');
    root.setAttribute('aria-label', 'PKM native execution subgraphs');
    let session, model, active, sequence = 0, disposed = false, loading = false, pending = false, pendingForce = false;
    let tabs = [], views = new Map(), auto = true, ringSelected, dashboardAttemptId, lifecycleInspection = false, dashboardDiagram = 'harness';
    const memoryReads = new Map();
    let memoryPieceChoice, memoryRevision;
    const toolbar = el('header'), title = el('h2'), status = el('span'), error = el('p', '', 'pkm-harness-error');
    error.setAttribute('role', 'alert');
    const manual = button('Refresh', () => void refresh(true));
    const autoLabel = el('label'), autoInput = el('input'); autoInput.type = 'checkbox'; autoInput.checked = true;
    autoInput.addEventListener('change', () => { auto = autoInput.checked; if (auto) void refresh(true); });
    autoLabel.append(autoInput, document.createTextNode(' Auto (events + 30s reconciliation)'));
    toolbar.append(title, manual, autoLabel, status);
    if (options.openBrowser) toolbar.append(button('Open in browser', () => void options.openBrowser(session.sessionId).catch(showError)));
    const warning = el('p', '', 'pkm-harness-warning');
    const dashboard = el('section', undefined, 'pkm-harness-dashboard');
    dashboard.setAttribute('aria-label', 'Agent runtime dashboard');
    const diagramTabs = el('nav', undefined, 'pkm-harness-diagram-tabs');
    diagramTabs.setAttribute('role', 'tablist'); diagramTabs.setAttribute('aria-label', 'Diagram details');
    const diagramDetail = el('section', undefined, 'pkm-harness-diagram-detail');
    diagramDetail.setAttribute('role', 'tabpanel'); diagramDetail.id = detailId;
    const diagramContent = el('div');
    diagramTabs.addEventListener('keydown', event => {
      const items = [...diagramTabs.querySelectorAll('[role="tab"]')], index = items.indexOf(document.activeElement);
      const next = event.key === 'ArrowRight' ? (index + 1) % items.length
        : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault(); items[next].click();
      diagramTabs.querySelector('[aria-selected="true"]')?.focus();
    });
    const overviewBox = el('section', undefined, 'pkm-harness-overview');
    overviewBox.setAttribute('aria-label', 'Live execution overview'); overviewBox.setAttribute('aria-live', 'polite');
    const tabbar = el('nav'); tabbar.setAttribute('aria-label', 'Open subgraphs');
    const breadcrumbs = el('nav'); breadcrumbs.setAttribute('aria-label', 'Graph ancestors');
    const tools = el('div', undefined, 'pkm-harness-toolbar');
    const back = button('Back to parent', () => open(model.graphs.get(active)?.parent || RING));
    const zoom = el('input'); zoom.type = 'range'; zoom.min = '50'; zoom.max = '150'; zoom.step = '10'; zoom.setAttribute('aria-label', 'Graph zoom');
    zoom.addEventListener('input', () => { capture(); view().zoom = Number(zoom.value) / 100; draw(); });
    tools.append(back, button('Current execution', focusCurrent), document.createTextNode(' Zoom '), zoom);
    const viewport = el('div', undefined, 'pkm-harness-viewport');
    const inspector = el('section', undefined, 'pkm-harness-inspector');
    const dialog = el('dialog'), dialogTitle = el('h3'), dialogBody = el('pre');
    dialog.append(dialogTitle, button('Close preview', () => dialog.close()), dialogBody);
    diagramDetail.append(diagramContent, overviewBox, tabbar, breadcrumbs, tools, viewport, inspector);
    root.append(toolbar, error, dashboard, diagramTabs, diagramDetail, warning, dialog);
    container.append(root);
    function view() { if (!views.has(active)) views.set(active, { zoom:1, left:0, top:0, selected:'' }); return views.get(active); }
    function capture() { if (!active) return; Object.assign(view(), { left:viewport.scrollLeft, top:viewport.scrollTop }); }
    function showError(value) { error.textContent = value instanceof Error ? value.message : String(value); }
    function inspect(node) {
      view().selected = node.id;
      for (const card of viewport.querySelectorAll('.pkm-harness-node')) {
        const selected = card.dataset.nodeId === node.id;
        card.classList.toggle('selected', selected);
        card.querySelector('button')?.setAttribute('aria-pressed', String(selected));
      }
      inspector.replaceChildren(el('h3', `${node.kind}: ${node.title}`));
      if (typeof node.publicText === 'string') {
        inspector.append(el('pre', node.publicText), el('small', node.info.note));
      } else if (node.kind === 'Function / MCP call') {
        inspector.append(el('h4', 'Arguments (recorded)'), el('pre', node.info.arguments),
          el('h4', 'Result preview (recorded)'), el('pre', node.info.resultPreview));
        const metadata = el('details');
        metadata.append(el('summary', 'Recorded call metadata'), el('pre', JSON.stringify(node.info, null, 2)));
        inspector.append(metadata);
      } else inspector.append(el('pre', typeof node.info === 'string' ? node.info : JSON.stringify(node.info, null, 2)));
      if (node.fullResult) inspector.append(button('Load full recorded result', async () => {
        const id = session.sessionId, graphId = active, selected = node.id;
        try {
          const value = await options.request('result', { sessionId:id, ...node.fullResult });
          if (session.sessionId === id && active === graphId && view().selected === selected) inspector.replaceChildren(el('h3', 'Full recorded result'), el('pre', value));
        } catch (e) { showError(e); }
      }));
      if (node.memoryReceipt) inspector.append(button('Read durable Memory receipt', async () => {
        const id = session.sessionId, graphId = active, selected = node.id;
        try {
          const value = await options.request('memoryReceipt', { sessionId:id, ...node.memoryReceipt });
          if (session.sessionId === id && active === graphId && view().selected === selected) inspector.replaceChildren(
            el('h3', 'Durable Memory receipt (read-only)'), el('pre', JSON.stringify(value, null, 2)));
        } catch (e) { showError(e); }
      }));
    }
    function recipePreview(runId) {
      const run = model.runs.get(runId);
      dialogTitle.textContent = `${run.recipeName} / revision ${run.recipeRevision}`;
      dialogBody.textContent = run.definition ? JSON.stringify(run.definition, null, 2) : 'Pinned Recipe definition unavailable. The current library revision is not substituted.';
      dialog.showModal();
    }
    function open(id) {
      if (id !== RING && !model.graphs.has(id)) return;
      capture(); active = id; if (!tabs.includes(id)) tabs.push(id); draw();
    }
    function dashboardLifecycle() {
      const attempts = list(session.harness?.attempts), attempt = attempts.find(item => item.messageId === dashboardAttemptId);
      return attempt && attempt !== attempts.at(-1)
        ? lifecycle({ ...session, status:attempt.status, todos:[], harness:{ ...session.harness, attempts:[attempt], state:attempt.status,
          currentPhase:attempt.progress?.phase, waiting:undefined } }, model, new Map(list(session.actionRuns).map(run => [run.runId, run])))
        : model.lifecycle;
    }
    function drawRing() {
      const data = dashboardLifecycle();
      if (!data.stages.some(stage => stage.id === ringSelected)) ringSelected = data.current;
      tools.hidden = true; viewport.hidden = true;
      viewport.replaceChildren(); breadcrumbs.replaceChildren();
      inspector.hidden = !lifecycleInspection;
      const selected = data.stages.find(stage => stage.id === ringSelected);
      inspector.replaceChildren(el('h3', `${selected.label}${selected.current ? data.live ? ' (current)' : ' (last recorded)' : ''}`));
      const items = el('dl', undefined, 'pkm-harness-stage-items');
      for (const [name, value] of selected.items) items.append(el('dt', name), el('dd', value));
      inspector.append(items, button('Open records', () => open(selected.graphId), `Open recorded evidence for ${selected.label}`));
    }
    function locate(graphId, nodeId) {
      const graph = model.graphs.get(graphId), node = graph?.nodes.find(item => item.id === nodeId);
      if (!graph) return;
      open(graphId);
      if (!node) return;
      inspect(node);
      const position = layout(graph).positions.get(node.id);
      viewport.scrollLeft = position.x * view().zoom;
      viewport.scrollTop = Math.max(0, position.y * view().zoom - 24);
    }
    function readDashboardMemory(method, params = {}) {
      const cacheKey = key(method,params);
      if (!memoryReads.has(cacheKey)) {
        if (memoryReads.size >= 200) memoryReads.delete(memoryReads.keys().next().value);
        const state = {loading:true}, id = session.sessionId;
        memoryReads.set(cacheKey,state);
        options.request(method,params).then(data => { state.data = data; }, error => { state.error = error.message; }).finally(() => {
          state.loading = false;
          if (!disposed && session.sessionId === id && memoryReads.get(cacheKey) === state) drawDashboard();
        });
      }
      return memoryReads.get(cacheKey);
    }
    function drawDashboard() {
      const focused = document.activeElement?.dataset?.harnessFocus;
      const attempts = list(session.harness?.attempts);
      const attempt = attempts.find(item => item.messageId === dashboardAttemptId) || attempts.at(-1);
      const receipts = list(attempt?.budgetReceipts), receipt = receipts.at(-1), usage = attempt?.validation?.reportedUsage;
      const diagnostics = el('section', undefined, 'pkm-harness-diagnostics');
      diagnostics.setAttribute('role', 'log'); diagnostics.setAttribute('aria-label', 'Latest runtime diagnostics');
      const diagnosticDetails = el('details');
      diagnosticDetails.open = !!dashboard.querySelector('.pkm-harness-diagnostics details')?.open;
      const diagnosticSummary = el('summary', 'Recent diagnostics');
      diagnosticDetails.append(diagnosticSummary);
      diagnostics.append(diagnosticDetails);
      const records = [];
      for (const item of list(session.harness?.attempts).slice(-5)) {
        for (const event of list(item.progress?.transitions).slice(-10)) records.push({
          level:event.status === 'failed' ? 'error' : event.status === 'waiting' ? 'warning' : 'status',
          text:`${Number.isFinite(event.at) ? new Date(event.at).toLocaleTimeString() : 'time unknown'} / ${event.label}`
        });
        if (item.validation?.error) records.push({ level:'error', text:item.validation.error });
        if (item.validation?.outputBudgetWarning) records.push({ level:'warning', text:item.validation.outputBudgetWarning });
      }
      records.push(...model.warnings.map(text => ({ level:'warning', text })));
      records.push({ level:'status', text:`${session.harness?.state || session.status || 'unknown'} / ${session.harness?.currentPhase?.label || 'No current phase recorded'}` });
      diagnosticSummary.textContent = `Recent diagnostics · ${records.filter(record => record.level === 'error').length} errors · ${records.filter(record => record.level === 'warning').length} warnings`;
      for (const record of records.slice(-10)) {
        const line = el('p', `${record.level.toUpperCase()} / ${record.text}`);
        line.dataset.level = record.level; diagnosticDetails.append(line);
      }
      const parameters = el('table', undefined, 'pkm-harness-parameters');
      parameters.setAttribute('aria-label', 'Recorded runtime parameters');
      const caption = el('caption', 'Selected attempt · runtime parameters');
      parameters.append(caption);
      const body = el('tbody');
      const quantity = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : 'not reported';
      for (const [label, value] of [
        ['Record identity', `${session.harness?.chatId || session.sessionId || 'unknown'} / ${attempt?.messageId || 'no attempt'}`],
        ['Model', attempt?.model || session.nativeAgent?.model || 'not recorded'],
        ['Provider', receipt?.transport?.provider || session.nativeAgent?.provider || 'not recorded'],
        ['Thinking quota', receipt?.ledger?.thinkingPolicy === 'provider-default' ? 'Provider default (no override)' : 'not recorded'],
        ['Context window', quantity(receipt?.requested?.contextWindow)],
        ['Output token limit (effective)', quantity(receipt?.effective?.outputTokens)],
        ...(usage ? [['Token usage (input / output)', `${quantity(usage.inputTokens)} / ${quantity(usage.outputTokens)}`]] : []),
        ...(creditLabel(attempt?.validation?.reportedCredits) ? [['Copilot credits (Chat only)', creditLabel(attempt.validation.reportedCredits)]] : []),
        ...(Number.isSafeInteger(usage?.reasoningTokens) && usage.reasoningTokens >= 0 ? [['Reasoning tokens', quantity(usage.reasoningTokens)]] : []),
        ['Model rounds / tools', `${receipts.length} prepared / ${list(attempt?.toolCalls).length} recorded`],
      ]) { const row = el('tr'); row.append(el('th', label), el('td', value)); body.append(row); }
      parameters.append(body);
      const grid = el('div', undefined, 'pkm-harness-diagram-grid');
      const selection = el('label', 'Attempt records ');
      const attemptSelect = el('select');
      attemptSelect.setAttribute('aria-label', 'Attempt records');
      attemptSelect.dataset.harnessFocus = 'dashboard-attempt-records';
      attempts.forEach((item, index) => {
        const option = el('option', `${index + 1} / ${item.status}${index === attempts.length - 1 ? ' (latest)' : ''}`);
        option.value = item.messageId; option.selected = item === attempt; attemptSelect.append(option);
      });
      attemptSelect.disabled = !attempts.length;
      attemptSelect.addEventListener('change', () => {
        dashboardAttemptId = attemptSelect.value; ringSelected = undefined; drawDashboard();
        if (active === RING) drawRing();
      });
      selection.append(attemptSelect);
      const cards = new Map();
      const selectDiagram = id => {
        dashboardDiagram = id; lifecycleInspection = false; drawDashboard(); open(RING);
      };
      const card = (id, title, graphId) => {
        const node = el('section', undefined, 'pkm-harness-diagram-card'); node.dataset.diagram = id;
        const heading = el('h3', title); node.append(heading);
        if (graphId && model.graphs.has(graphId)) {
          const openGraph = button('Inspect recorded graph', () => locate(graphId), `Inspect ${title}`);
          openGraph.dataset.harnessFocus = key('dashboard', id); node.append(openGraph);
        }
        cards.set(id, {node, title}); return node;
      };
      const preview = (node, graphId) => {
        const graph = model.graphs.get(graphId), nodes = list(graph?.nodes).slice(0, 18);
        if (!nodes.length) { node.append(el('p', 'No execution records available.', 'pkm-harness-unknown')); return; }
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', `0 0 600 ${Math.ceil(nodes.length / 3) * 66 + 8}`);
        svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${graph.title}: recorded nodes; placement is not execution order`);
        const positions = new Map(nodes.map((item, index) => [item.id, { x:index % 3 * 200 + 100, y:Math.floor(index / 3) * 66 + 32 }]));
        for (const edge of graph.edges) {
          const from = positions.get(edge.from), to = positions.get(edge.to);
          if (!from || !to) continue;
          const line = document.createElementNS(svg.namespaceURI, 'path');
          line.setAttribute('d', `M${from.x} ${from.y} L${to.x} ${to.y}`);
          line.setAttribute('class', 'pkm-harness-preview-edge'); svg.append(line);
        }
        nodes.forEach((item, index) => {
          const group = document.createElementNS(svg.namespaceURI, 'g');
          group.dataset.status = terminal(item.status) || item.status;
          const x = index % 3 * 200 + 4, y = Math.floor(index / 3) * 66 + 4;
          const rect = document.createElementNS(svg.namespaceURI, 'rect');
          for (const [name, value] of Object.entries({ x, y, width:192, height:56, rx:6 })) rect.setAttribute(name, String(value));
          const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = `${item.title} / ${item.status}`;
          group.append(title, rect);
          for (const [line, text] of [[0, item.title], [1, item.status]]) {
            const label = document.createElementNS(svg.namespaceURI, 'text');
            label.setAttribute('x', String(x + 8)); label.setAttribute('y', String(y + 22 + line * 19));
            label.textContent = String(text).slice(0, 24); group.append(label);
          }
          svg.append(group);
        });
        node.append(svg, el('small', `${nodes.length} of ${graph.nodes.length} recorded nodes; open the graph for edges, nesting and full evidence.`));
      };
      const harness = card('harness', 'Harness flow');
      const data = dashboardLifecycle(), stages = el('ol', undefined, 'pkm-harness-flow-preview');
      stages.setAttribute('role', 'group'); stages.setAttribute('aria-label', 'Harness lifecycle'); stages.dataset.outcome = data.outcome;
      for (const stage of data.stages) {
        const item = el('li'), select = button('', () => {
          ringSelected = stage.id; lifecycleInspection = true; drawDashboard(); open(RING);
          root.querySelector(`[data-stage="${stage.id}"]`)?.focus({preventScroll:true});
        }, `${stage.label}: ${stage.current ? `${data.live ? 'current' : 'last recorded'}, ${stage.status}` : stage.status}`);
        select.className = 'pkm-harness-stage'; select.dataset.stage = stage.id; select.dataset.status = stage.status;
        select.dataset.harnessFocus = key('stage', stage.id);
        select.setAttribute('aria-pressed', String(lifecycleInspection && stage.id === ringSelected));
        if (stage.current) select.setAttribute('aria-current', 'step');
        select.append(el('span', stage.label, 'pkm-harness-stage-label'), el('small', stage.status));
        if (stage.id === 'run' && data.activity) select.append(el('span', data.activity, 'pkm-harness-current-activity'));
        item.append(select); stages.append(item);
      }
      harness.append(stages, el('small', data.reason));
      if (data.iterations) harness.append(el('small', `Check -> Configure: ${data.iterations} recorded iteration(s)`));
      harness.append(button('Current execution', focusCurrent), button('Full execution graph', () => open(model.root)));
      const recipe = card('recipes', 'Recipe / Action graphs');
      const bindings = [...model.overview.recipes, ...model.overview.actions].filter(item => item.available && item.graphId);
      if (!bindings.length) recipe.append(el('p', 'No available explicit Recipe / Action binding.', 'pkm-harness-unknown'));
      for (const binding of bindings) {
        const name = binding.name || binding.actionId || binding.runId;
        const link = button(`Inspect ${name}`, () => locate(binding.graphId, binding.nodeId));
        link.dataset.harnessFocus = key('dashboard-binding', binding.runId); recipe.append(link);
        preview(recipe, binding.graphId);
      }
      const memory = card('memory', 'Memory / Profiles', attempt?.memory?.accounting && key('memory-accounting', attempt.messageId));
      let memoryOverview;
      if (session.memoryStoreReader) {
        const state = readDashboardMemory('memoryOverview');
        memory.append(button('Refresh stored Memory', () => { memoryReads.clear(); memoryPieceChoice = undefined; drawDashboard(); }));
        if (state.loading) memory.append(el('p','Reading stored Memory...'));
        else if (state.error) memory.append(el('p',state.error,'pkm-harness-error'));
        else {
          memoryOverview = state.data;
          memory.append(memoryPyramid(memoryOverview,attempt,piece => { memoryPieceChoice = piece; drawDashboard(); }),
            el('small','Cache / Memory / Disk are logical tiers, not age buckets. Expand Inside Memory for stored abstraction levels and evidence. Blue: prepared reference; green: historical sent membership, not proof the current revision was sent.'));
          if (memoryPieceChoice) {
            const evidence = el('section'); evidence.setAttribute('aria-label','Stored Memory piece evidence');
            const piece = readDashboardMemory('memoryPiece',{piece:memoryPieceChoice.id,after:0});
            evidence.append(el('h4',memoryPieceChoice.label || memoryPieceChoice.id),
              el('p',`${memoryPieceChoice.kind} / level ${memoryPieceChoice.level} / ${memoryPieceChoice.id}`));
            if (piece.loading) evidence.append(el('p','Reading stored piece...'));
            else if (piece.error) evidence.append(el('p',piece.error,'pkm-harness-error'));
            else {
              const data = piece.data;
              evidence.append(el('p',`${data.status} / revision ${data.piece?.revision ?? 'not recorded'}`));
              if (data.summary) evidence.append(el('pre',data.summary.body));
              for (const statement of list(data.statements)) {
                evidence.append(el('h4',`Statement ${statement.sequence} / ${statement.status}`),el('pre',statement.body ?? 'Content unavailable'));
                for (const source of list(statement.sources)) evidence.append(el('small',`${source.locator} / revision ${source.revision}`));
              }
              if (data.next !== null && data.next !== undefined) evidence.append(el('small','First statement page shown; more statements are available in the scoped Memory view.'));
            }
            memory.append(evidence);
          }
        }
        if (!memoryOverview) memory.append(memoryPyramid(undefined,attempt));
      }
      const profiles = attempt?.profileContext;
      if (session.profileReader) {
        const current = el('section'); current.setAttribute('aria-label','Current User and Agent Session Profiles');
        current.append(el('h4','Current User / Agent Session Profiles'));
        const state = readDashboardMemory('profiles');
        current.append(button('Refresh current Profiles', () => { memoryReads.delete(key('profiles',{})); drawDashboard(); }));
        if (options.configureProfiles) current.append(button('Manage Session Profile', () => options.configureProfiles()));
        if (state.loading) current.append(el('p','Reading current Profiles...'));
        else if (state.error) current.append(el('p',state.error,'pkm-harness-error'));
        else {
          current.append(el('small',`${state.data.scope}. Current cards apply to the next attempt; they do not replace historical snapshots.`));
          for (const kind of ['user','agent']) {
            const profile = state.data[kind];
            current.append(el('h4',kind === 'user' ? 'User Profile' : 'Agent Session Profile'),
              el('p',profile ? `${profile.name} · r${profile.revision}` : kind === 'agent' && !state.data.agentAssigned ? 'Not assigned' : 'Not configured'));
            if (profile) {
              const fields = el('dl');
              for (const field of ['role','focus','preferences','boundaries']) fields.append(el('dt',field),el('dd',profile[field] || 'Not configured'));
              current.append(fields);
            }
          }
        }
        memory.append(current);
      }
      memory.append(el('h4','Selected attempt · historical User / Agent Profiles'));
      const profileTable = el('table', undefined, 'pkm-harness-parameters'), profileBody = el('tbody');
      profileTable.setAttribute('aria-label', 'Recorded collaboration Profiles');
      for (const kind of ['user', 'agent']) {
        const profile = profiles?.[kind], row = el('tr');
        row.append(el('th', kind === 'user' ? 'User Profile' : 'Agent Profile'), el('td', profile ? `${profile.name} · r${profile.revision}` : 'Not recorded'));
        profileBody.append(row);
      }
      profileTable.append(profileBody); memory.append(profileTable);
      if (profiles) {
        const details = el('details'); details.open = true; details.append(el('summary', 'Profile snapshot recorded for this attempt'));
        const fields = el('table', undefined, 'pkm-harness-parameters'), body = el('tbody');
        for (const kind of ['user', 'agent']) for (const field of ['role', 'focus', 'preferences', 'boundaries']) if (profiles[kind]?.[field]) {
          const row = el('tr'); row.append(el('th', `${kind} / ${field}`), el('td', profiles[kind][field])); body.append(row);
        }
        fields.append(body); details.append(fields); memory.append(details);
      }
      if (!attempt?.memory) memory.append(el('p', 'No Memory preparation receipt recorded for this attempt. This does not establish that Memory is disabled or empty.', 'pkm-harness-unknown'));
      else {
        const preparation = memoryOverview ? el('details') : memory;
        if (memoryOverview) { preparation.append(el('summary','Attempt preparation details')); memory.append(preparation); }
        const pyramid = el('div', undefined, 'pkm-harness-memory-pyramid');
        const blocks = list(attempt.memory.blocks);
        const kinds = [...new Set(blocks.map(block => block.kind))];
        kinds.forEach((kind, index) => {
          const level = el('div', `${kind}: ${blocks.filter(block => block.kind === kind).length} block(s)`);
          pyramid.append(level);
        });
        preparation.append(pyramid, el('small', kinds.length ? 'Recorded preparation blocks grouped by kind, not stored abstraction levels. Open Visualization / Memory for the scoped storage pyramid and provenance.' : 'Receipt recorded no preparation blocks.'));
        if (attempt.memory.error) preparation.append(el('p', `Memory preparation error: ${attempt.memory.error}`, 'pkm-harness-unknown'));
        if (attempt.memory.accounting) {
          const credits = creditLabel(attempt.memory.accounting.credits);
          if (credits) preparation.append(el('p', `Memory preparation: ${credits}. Separate from Chat credits; post-reply organization is in the durable Memory receipt.`));
          preview(preparation, key('memory-accounting', attempt.messageId));
        }
      }
      const retrieval = card('retrieval', 'Retrieval flow', attempt && key('retrieval', attempt.messageId));
      const retrievalRecords = list(attempt?.retrieval);
      const last = [...retrievalRecords].reverse().find(record => list(record.receipt?.candidates).length) || retrievalRecords.at(-1);
      const candidates = list(last?.receipt?.candidates);
      if (!last) retrieval.append(el('p', 'No retrieval receipt recorded.', 'pkm-harness-unknown'));
      else {
        const flow = el('div', undefined, 'pkm-harness-retrieval-stages');
        for (const [label, count] of [
          ['Candidates', candidates.length], ['Selected', candidates.filter(item => item.selected).length],
          ['Sent', candidates.filter(item => item.evidenceState === 'sent').length]
        ]) flow.append(el('div', `${label}: ${count}`));
        retrieval.append(flow, el('small', `Displayed receipt: ${last.kind} / ${last.receipt?.phase || 'unknown'}. Selection is not transmission.`));
        if (last !== retrievalRecords.at(-1)) retrieval.append(el('small', 'The latest receipt has no candidates; showing the most recent populated receipt.'));
        const pieces = el('div', undefined, 'pkm-harness-retrieval-pieces');
        pieces.setAttribute('role', 'list'); pieces.setAttribute('aria-label', 'Retrieval piece categories');
        const kinds = new Map();
        for (const candidate of candidates) {
          const kind = candidate.kind || 'unknown';
          if (!kinds.has(kind)) kinds.set(kind, []);
          kinds.get(kind).push(candidate);
        }
        for (const [kind, items] of kinds) {
          const block = el('div'); block.setAttribute('role', 'listitem');
          block.append(el('strong', kind), el('span', `${items.length} piece(s)`),
            el('small', `${items.filter(item => item.selected).length} selected / ${items.filter(item => item.evidenceState === 'sent').length} sent`));
          pieces.append(block);
        }
        if (candidates.length) {
          const evidence = el('section');
          evidence.setAttribute('aria-label','Retrieval piece evidence');
          const diagram = retrievalPieceFlow(candidates,(item,index) => {
            evidence.replaceChildren(el('h4',item.label || `Piece ${index+1} / ${item.kind || 'unknown'}`));
            const fields = el('dl');
            for (const [label,value] of [
              ['Identity',item.id],['Kind',item.kind],['Source',item.sourceUri],['Method',item.method],['Score',item.score],
              ['Selection reason',item.reason],['Evidence',item.evidenceState === 'sent' ? 'Sent evidence recorded'
                : item.selected ? 'Selected; transmission not established' : 'Not selected'],
            ]) fields.append(el('dt',label),el('dd',value === undefined || value === '' ? 'Not recorded' : String(value)));
            evidence.append(fields);
          });
          retrieval.append(diagram, el('small', `${diagram.dataset.sampleSize} / ${candidates.length} recorded pieces shown; ${diagram.dataset.selectedSize} selected connections shown. Sampled view, not the entire Memory database.`));
          retrieval.append(evidence);
          const legend = el('details');
          legend.append(el('summary', 'Piece categories and evidence'), pieces);
          retrieval.append(legend);
        }
        else retrieval.append(el('p', 'This receipt recorded no candidates. Open Retrieval / Search for stage details.', 'pkm-harness-unknown'));
      }
      diagramTabs.replaceChildren();
      for (const [id, {node, title}] of cards) {
        const thumb = button('', () => selectDiagram(id), `Show ${title} details`);
        thumb.className = 'pkm-harness-diagram-thumbnail'; thumb.dataset.diagram = id;
        thumb.dataset.harnessFocus = key('thumbnail', id);
        thumb.setAttribute('aria-pressed', String(id === dashboardDiagram));
        thumb.append(el('strong', title));
        if (id === 'harness') {
          const mini = el('div', undefined, 'pkm-harness-flow-mini');
          for (const stage of data.stages) {
            const block = el('span', stage.label); block.dataset.status = stage.status;
            if (stage.current) block.setAttribute('aria-current', 'step');
            mini.append(block);
          }
          thumb.append(mini);
        } else if (id === 'recipes') {
          const svg = node.querySelector('svg');
          if (svg) { const mini = svg.cloneNode(true); mini.setAttribute('aria-hidden', 'true'); thumb.append(mini); }
          thumb.append(el('small', `${model.overview.recipes.length} Recipe / ${model.overview.actions.length} Action binding(s)`));
        } else if (id === 'memory') {
          const mini = memoryPyramid(memoryOverview,attempt); mini.setAttribute('aria-hidden','true'); thumb.append(mini);
          if (!memoryOverview && session.memoryStoreReader) {
            const memoryState = memoryReads.get(key('memoryOverview',{}));
            thumb.append(el('small', memoryState?.error || 'Reading stored Memory...', memoryState?.error ? 'pkm-harness-error' : undefined));
          }
          const groups = el('div', undefined, 'pkm-harness-category-mini');
          for (const kind of new Set(list(attempt?.memory?.blocks).map(block => block.kind))) groups.append(el('span', kind));
          thumb.append(groups, el('small', attempt?.memory ? `${list(attempt.memory.blocks).length} preparation block(s)` : 'No preparation receipt'),
            el('small', profiles ? `${profiles.user ? 'User' : ''}${profiles.user && profiles.agent ? ' / ' : ''}${profiles.agent ? 'Agent' : ''} Profile recorded` : 'No Profile snapshot'));
        } else {
          if (candidates.length) {
            const mini = retrievalPieceFlow(candidates);
            mini.removeAttribute('role'); mini.removeAttribute('aria-label'); mini.setAttribute('aria-hidden', 'true');
            thumb.append(mini);
          }
          thumb.append(el('small', last ? `${candidates.length} candidates / ${candidates.filter(candidate => candidate.selected).length} selected` : 'No retrieval receipt'));
        }
        grid.append(thumb);
        const tab = button(title, () => selectDiagram(id));
        tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(id === dashboardDiagram));
        tab.id = `${detailId}-${id}`; tab.setAttribute('aria-controls', detailId);
        tab.tabIndex = id === dashboardDiagram ? 0 : -1; tab.dataset.harnessFocus = key('diagram-tab', id);
        diagramTabs.append(tab);
        if (id === dashboardDiagram) {
          diagramDetail.setAttribute('aria-labelledby', tab.id); diagramContent.replaceChildren(node);
        }
      }
      const parameterDetails = el('details');
      parameterDetails.open = !!dashboard.querySelector('.pkm-harness-runtime-parameters')?.open;
      parameterDetails.className = 'pkm-harness-runtime-parameters';
      parameterDetails.append(el('summary', 'Runtime parameters'), parameters);
      dashboard.replaceChildren(diagnostics, selection, parameterDetails, grid);
      if (focused) [...root.querySelectorAll('[data-harness-focus]')].find(node => node.dataset.harnessFocus === focused)?.focus({ preventScroll:true });
    }
    function focusCurrent() {
      const current = currentNode(model);
      const latest = list(session.harness?.attempts).at(-1);
      if (!current) { open(latest && model.graphs.has(key('chat-attempt', latest.messageId)) ? key('chat-attempt', latest.messageId) : model.root); return; }
      locate(current.graph.id, current.node.id);
    }
    function drawOverview() {
      const data = model.overview;
      const phase = data.waiting ? 'waiting' : data.phase?.kind || data.state;
      const head = el('div', undefined, 'pkm-harness-overview-head');
      const chip = el('span', undefined, 'pkm-harness-phase');
      chip.dataset.phase = phase;
      chip.append(el('i', undefined, 'pkm-harness-phase-mark'), document.createTextNode(`${data.state}${data.phase?.label ? ` / ${data.phase.label}` : ''}`));
      head.append(el('strong', 'Live overview'), chip);
      if (data.liveness) head.append(el('span', `liveness: ${data.liveness}`));
      overviewBox.replaceChildren(head);
      if (data.waiting) overviewBox.append(el('p', `${data.waiting.kind === 'user' ? 'Waiting for you' : 'Blocked on dependency'}: ${data.waiting.detail}`, 'pkm-harness-blocked'));
      const attempt = data.attempt;
      if (attempt) {
        const line = el('p');
        line.append(button(`Attempt ${attempt.number || attempt.id}`, () => locate(attempt.graphId), 'Open current attempt'),
          document.createTextNode(` ${attempt.status}${attempt.model ? ` / ${attempt.model}` : ''} / prepared model rounds: ${attempt.preparedRounds}` +
            ` / public output rounds: ${attempt.publicRounds} / tool calls: ${attempt.toolCalls}${attempt.runningToolCalls ? ` (${attempt.runningToolCalls} running)` : ''}` +
            `${attempt.retryOf ? ` / retry of ${attempt.retryOf}` : ''}`));
        overviewBox.append(line);
      } else overviewBox.append(el('p', 'No Harness attempt recorded yet.'));
      const path = el('nav', undefined, 'pkm-harness-path');
      path.setAttribute('aria-label', 'Current execution path');
      if (data.path.length) data.path.forEach((item, index) => {
        if (index) path.append(el('span', '>', 'pkm-harness-path-sep'));
        const step = button(`${item.kind}: ${item.title}`, () => locate(item.graphId, item.nodeId), `Locate ${item.kind} ${item.title} (${item.status})`);
        step.dataset.status = item.status;
        path.append(step);
      });
      else path.append(el('span', 'No running or waiting node recorded.'));
      overviewBox.append(path);
      const bindings = el('p', undefined, 'pkm-harness-bindings');
      bindings.append(el('span', 'Recipe: '));
      if (data.recipes.length) data.recipes.forEach(item => bindings.append(item.graphId
        ? button(`${item.name}${item.nodeId ? ` / ${item.nodeId}` : ''} (${item.status || 'unknown'})`, () => locate(item.graphId), `Open Recipe Run ${item.runId}`)
        : el('span', `${item.runId}${item.nodeId ? ` / ${item.nodeId}` : ''} (bound via ${item.source}; record unavailable)`, 'pkm-harness-unknown')));
      else bindings.append(el('span', 'no explicit binding recorded', 'pkm-harness-unknown'));
      bindings.append(el('span', ' Action: '));
      if (data.actions.length) data.actions.forEach(item => bindings.append(item.graphId
        ? button(`${item.actionId} (${item.state || 'unknown'})${item.components.length ? ` / active: ${item.components.map(component => component.key).join(', ')}` : ''}`,
          () => locate(item.graphId), `Open Action Run ${item.runId}`)
        : el('span', `${item.runId} (referenced; record unavailable)`, 'pkm-harness-unknown')));
      else bindings.append(el('span', 'no Action Run referenced', 'pkm-harness-unknown'));
      overviewBox.append(bindings);
    }
    function draw() {
      overviewBox.hidden = active === RING; tabbar.hidden = active === RING;
      diagramContent.hidden = active !== RING;
      tabbar.replaceChildren();
      for (const id of tabs) {
        const tab = button(id === RING ? 'Lifecycle' : model.graphs.get(id)?.title || 'Unavailable subgraph', () => open(id));
        tab.dataset.harnessFocus = key('tab', id);
        tab.setAttribute('aria-current', String(id === active)); tabbar.append(tab);
      }
      if (active === RING) { drawRing(); return; }
      tools.hidden = false; viewport.hidden = false; inspector.hidden = false; zoom.disabled = false;
      const graph = model.graphs.get(active), saved = view(), focused = document.activeElement?.dataset?.harnessFocus;
      breadcrumbs.replaceChildren();
      const ancestors = [], visited = new Set();
      let cursor = graph;
      while (cursor && !visited.has(cursor.id)) { ancestors.unshift(cursor); visited.add(cursor.id); cursor = model.graphs.get(cursor.parent); }
      breadcrumbs.append(button('Lifecycle', () => open(RING)));
      ancestors.forEach(item => breadcrumbs.append(button(item.title, () => open(item.id))));
      back.disabled = false; zoom.value = String(saved.zoom * 100);
      const geometry = layout(graph), frame = el('div', undefined, 'pkm-harness-frame'), canvas = el('div', undefined, 'pkm-harness-canvas');
      frame.style.width = `${geometry.width * saved.zoom}px`; frame.style.height = `${geometry.height * saved.zoom}px`;
      canvas.style.width = `${geometry.width}px`; canvas.style.height = `${geometry.height}px`; canvas.style.transform = `scale(${saved.zoom})`;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', String(geometry.width)); svg.setAttribute('height', String(geometry.height));
      svg.setAttribute('aria-hidden', 'true'); canvas.append(svg);
      for (const edge of geometry.forward) {
        const from = geometry.positions.get(edge.from), to = geometry.positions.get(edge.to);
        const line = document.createElementNS(svg.namespaceURI, 'path');
        const x = from.x + 144, y = from.y + 180, endX = to.x + 144, endY = to.y;
        line.setAttribute('d', `M ${x} ${y} C ${x} ${y + 32}, ${endX} ${endY - 32}, ${endX} ${endY} M ${endX - 4} ${endY - 6} L ${endX} ${endY} L ${endX + 4} ${endY - 6}`);
        line.setAttribute('class', edge.kind === 'retry' ? 'retry' : 'dependency'); svg.append(line);
      }
      for (const node of graph.nodes) {
        const position = geometry.positions.get(node.id), outcome = terminal(node.status);
        const card = el('article', undefined, `pkm-harness-node ${outcome}`);
        card.dataset.status = node.status;
        card.style.left = `${position.x}px`; card.style.top = `${position.y}px`;
        card.dataset.nodeId = node.id;
        if (node.executable !== false) card.append(el('small', 'start', 'pkm-harness-port'));
        card.append(el('small', node.kind));
        const select = button(node.title, () => inspect(node)); select.dataset.harnessFocus = key(active, node.id);
        card.append(select, el('strong', outcome === 'ignored' ? 'IGNORED / not executed' : node.status));
        if (node.recipe) card.append(button(`Recipe: ${model.runs.get(node.recipe)?.recipeName || node.recipe}`, () => recipePreview(node.recipe)));
        if (node.child) { const expand = button('+', () => open(node.child), `Open subgraph: ${node.title}`); expand.className = 'pkm-harness-expand'; card.append(expand); }
        if (node.executable !== false) card.append(el('small', outcome || 'no terminal outcome recorded', 'pkm-harness-port output'));
        canvas.append(card);
      }
      frame.append(canvas); viewport.replaceChildren(frame);
      if (geometry.deferred.length) viewport.append(el('pre', `Loop / unresolved / cyclic links (not drawn as forward flow):\n${JSON.stringify(geometry.deferred, null, 2)}`));
      viewport.scrollLeft = saved.left; viewport.scrollTop = saved.top;
      const selected = graph.nodes.find(node => node.id === saved.selected);
      if (selected) inspect(selected); else inspector.replaceChildren(el('p', 'Select a node to inspect its recorded evidence. Grouping does not imply execution order.'));
      if (focused) [...root.querySelectorAll('[data-harness-focus]')].find(node => node.dataset.harnessFocus === focused)?.focus({ preventScroll:true });
    }
    function update(next, force = false) {
      if (!force && !auto && next.sessionId === session?.sessionId) return;
      capture();
      if (session?.sessionId !== next.sessionId) { sequence++; tabs = []; views = new Map(); active = null; memoryReads.clear(); memoryPieceChoice = undefined; }
      const revision = key(next.sessionId, list(next.harness?.attempts).map(attempt => [
        attempt.messageId, attempt.memory?.turn, attempt.memory?.blocks, attempt.memory?.error
      ]));
      if (revision !== memoryRevision) { memoryReads.clear(); memoryPieceChoice = undefined; memoryRevision = revision; }
      session = next; model = build(next);
      active = active === RING || model.graphs.has(active) ? active : RING;
      tabs = tabs.filter(id => id === RING || model.graphs.has(id)); if (!tabs.includes(active)) tabs.push(active);
      title.textContent = next.task || 'PKM Chat';
      status.textContent = `Recorded: ${next.harness?.state || next.status}${next.harness?.currentPhase?.label ? ` / ${next.harness.currentPhase.label}` : ''}${next.liveness?.state ? ` / liveness: ${next.liveness.state}` : ''} / record: ${next.updatedAt || 'unknown'} / refreshed ${new Date().toLocaleTimeString()}`;
      warning.textContent = model.warnings.join('\n'); error.textContent = '';
      drawDashboard(); drawOverview(); draw();
      options.onUpdate?.(session, model);
    }
    async function refresh(force = false) {
      if (disposed || !session || (!force && (!auto || document.visibilityState === 'hidden' || !root.isConnected))) return;
      if (loading) { pending = true; pendingForce = pendingForce || force; return; }
      loading = true;
      if (force) { memoryReads.clear(); memoryPieceChoice = undefined; }
      const id = session.sessionId, current = ++sequence; manual.disabled = true;
      try {
        const next = await options.request('snapshot', { sessionId:id });
        if (!disposed && current === sequence && id === session.sessionId) update(next, force);
      } catch (e) { if (current === sequence) showError(e); }
      finally {
        loading = false; manual.disabled = false;
        if (pending && !disposed) { const forceAgain = pendingForce; pending = false; pendingForce = false; void refresh(forceAgain); }
      }
    }
    const visible = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    const timer = setInterval(() => void refresh(), 30000);
    update(options.initial, true);
    return {
      root, update, refresh, focusCurrent, locate,
      get graphId() { return active; },
      restoreGraph(id) {
        if (id !== RING && !model.graphs.has(id)) return false;
        open(id);
        return true;
      },
      get automatic() { return auto; }, get model() { return model; }, get session() { return session; },
      showLifecycle() {
        dashboardDiagram = 'harness'; lifecycleInspection = false; ringSelected = dashboardLifecycle().current; drawDashboard(); open(RING);
        root.querySelector('.pkm-harness-stage[aria-current="step"]')?.focus({ preventScroll:true });
      },
      showProfiles() {
        dashboardDiagram = 'memory'; lifecycleInspection = false; drawDashboard(); open(RING);
        const current = root.querySelector('[aria-label="Current User and Agent Session Profiles"]');
        if (current) { current.tabIndex = -1; current.focus(); }
      },
      attach(parent) { parent.append(root); },
      notify() { void refresh(); },
      dispose() { disposed = true; sequence++; clearInterval(timer); document.removeEventListener('visibilitychange', visible); root.remove(); }
    };
  }
  function profileCards(data, includeAgent = true) {
    const root = document.createElement('section');
    root.className = 'pkm-persona-cards';
    const scope = document.createElement('p'); scope.textContent = data.scope; root.append(scope);
    for (const kind of includeAgent ? ['user', 'agent'] : ['user']) {
      const section = document.createElement('section'), title = document.createElement('h3');
      title.textContent = kind === 'user' ? 'User Profile' : 'Agent Session Profile';
      section.append(title);
      const profile = data[kind];
      if (!profile) {
        const empty = document.createElement('p');
        empty.textContent = kind === 'agent' && !data.agentAssigned ? 'Not assigned to this Chat' : 'Not configured';
        section.append(empty);
      } else {
        const name = document.createElement('strong'); name.textContent = `${profile.name} · revision ${profile.revision}`; section.append(name);
        const fields = document.createElement('dl');
        for (const [label, value] of [['Role', profile.role], ['Focus', profile.focus], ['Working preferences', profile.preferences], ['Responsibility boundaries', profile.boundaries]]) {
          const term = document.createElement('dt'), content = document.createElement('dd');
          term.textContent = label; content.textContent = value || 'Not specified'; fields.append(term, content);
        }
        section.append(fields);
      }
      root.append(section);
    }
    const note = document.createElement('p');
    note.textContent = 'Current cards apply to the next attempt. Historical attempt snapshots are unchanged. Profiles are preferences, not permissions.';
    root.append(note);
    return root;
  }
  const api = { build, layout, terminal, mount, describeToolCall, toolActivityDetails, memoryTiers, memoryTierObservations, memoryTierPyramid, memoryPyramid, creditLabel, profileCards };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PkmAgentHarness = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
