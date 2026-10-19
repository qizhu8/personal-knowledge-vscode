(function (root) {
  'use strict';
  const terminal = value => ({ succeeded:'complete', completed:'complete', complete:'complete', failed:'failed', skipped:'ignored', ignored:'ignored' })[value] || '';
  const list = value => Array.isArray(value) ? value : [];
  const key = (...parts) => JSON.stringify(parts);

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
      if (list(attempt.budgetReceipts).length) {
        const budgets = graph(key('budgets', attempt.messageId), 'Per-round budget receipts', a.id);
        add(a, 'budgets', 'Budget', `${attempt.budgetReceipts.length} prepared rounds`, 'recorded',
          { note:'Input accounting is an estimate; prepared is not proof of provider acceptance or task completion.' }, { child:budgets.id, executable:false });
        for (const receipt of attempt.budgetReceipts) add(budgets, String(receipt.round), 'Budget receipt', `Round ${receipt.round}`, 'prepared', receipt, { executable:false });
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
          const details = graph(key('call', attempt.messageId, call.id), call.name, owner.id);
          add(owner, call.id, 'Function / MCP call', call.name, call.status, call, { child:details.id });
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
              add(evidence, key(attempt.messageId, call.id), 'Function / MCP call', call.name, call.status,
                { ...call, note:'Explicit recorded Recipe Stage binding; this link is not inferred from tool names.' }, { child:details.id });
            } else warnings.push(`Call ${call.id}: recorded Recipe Stage binding is unavailable.`);
          }
          add(details, 'arguments', 'Parameters', 'Recorded arguments', 'recorded', call.arguments, { executable:false });
          add(details, 'result', 'Result', call.resultTruncated ? `Preview (${call.resultPreview.length}/${call.resultCharacters} characters)` : 'Recorded result',
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
    return { root:main.id, graphs, runs, warnings:[...new Set(warnings)] };
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

  function mount(container, options) {
    const document = container.ownerDocument;
    const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
    const button = (text, action, label) => { const node = el('button', text); node.type = 'button'; if (label) node.setAttribute('aria-label', label); node.addEventListener('click', action); return node; };
    const root = el('section', undefined, 'pkm-harness');
    root.setAttribute('aria-label', 'PKM native execution subgraphs');
    let session, model, active, sequence = 0, disposed = false, loading = false, pending = false, pendingForce = false;
    let tabs = [], views = new Map(), auto = true;
    const toolbar = el('header'), title = el('h2'), status = el('span'), error = el('p', '', 'pkm-harness-error');
    error.setAttribute('role', 'alert');
    const manual = button('Refresh', () => void refresh(true));
    const autoLabel = el('label'), autoInput = el('input'); autoInput.type = 'checkbox'; autoInput.checked = true;
    autoInput.addEventListener('change', () => { auto = autoInput.checked; if (auto) void refresh(true); });
    autoLabel.append(autoInput, document.createTextNode(' Auto (events + 30s reconciliation)'));
    toolbar.append(title, manual, autoLabel, status);
    if (options.openBrowser) toolbar.append(button('Open in browser', () => void options.openBrowser(session.sessionId).catch(showError)));
    const warning = el('p', '', 'pkm-harness-warning');
    const tabbar = el('nav'); tabbar.setAttribute('aria-label', 'Open subgraphs');
    const breadcrumbs = el('nav'); breadcrumbs.setAttribute('aria-label', 'Graph ancestors');
    const tools = el('div', undefined, 'pkm-harness-toolbar');
    const back = button('Back to parent', () => { if (model.graphs.get(active)?.parent) open(model.graphs.get(active).parent); });
    const zoom = el('input'); zoom.type = 'range'; zoom.min = '50'; zoom.max = '150'; zoom.step = '10'; zoom.setAttribute('aria-label', 'Graph zoom');
    zoom.addEventListener('input', () => { capture(); view().zoom = Number(zoom.value) / 100; draw(); });
    tools.append(back, button('Current execution', focusCurrent), document.createTextNode(' Zoom '), zoom);
    const viewport = el('div', undefined, 'pkm-harness-viewport');
    const inspector = el('section', undefined, 'pkm-harness-inspector');
    const dialog = el('dialog'), dialogTitle = el('h3'), dialogBody = el('pre');
    dialog.append(dialogTitle, button('Close preview', () => dialog.close()), dialogBody);
    root.append(toolbar, error, warning, tabbar, breadcrumbs, tools, viewport, inspector, dialog);
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
    }
    function recipePreview(runId) {
      const run = model.runs.get(runId);
      dialogTitle.textContent = `${run.recipeName} / revision ${run.recipeRevision}`;
      dialogBody.textContent = run.definition ? JSON.stringify(run.definition, null, 2) : 'Pinned Recipe definition unavailable. The current library revision is not substituted.';
      dialog.showModal();
    }
    function open(id) {
      if (!model.graphs.has(id)) return;
      capture(); active = id; if (!tabs.includes(id)) tabs.push(id); draw();
    }
    function focusCurrent() {
      const depth = g => {
        let count = 0;
        for (let parent = g.parent; parent; parent = model.graphs.get(parent)?.parent) count++;
        return count;
      };
      const candidates = [...model.graphs.values()].flatMap(graph => graph.nodes
        .filter(node => ['running', 'waiting', 'awaiting-input', 'awaiting-result'].includes(node.status))
        .map(node => ({ graph, node }))).sort((left, right) => depth(right.graph) - depth(left.graph));
      const current = candidates[0];
      const latest = list(session.harness?.attempts).at(-1);
      if (!current) { open(latest ? key('chat-attempt', latest.messageId) : model.root); return; }
      open(current.graph.id); inspect(current.node);
      const position = layout(current.graph).positions.get(current.node.id);
      viewport.scrollLeft = position.x * view().zoom;
      viewport.scrollTop = Math.max(0, position.y * view().zoom - 24);
    }
    function draw() {
      const graph = model.graphs.get(active), saved = view(), focused = document.activeElement?.dataset?.harnessFocus;
      tabbar.replaceChildren();
      for (const id of tabs) {
        const tab = button(model.graphs.get(id)?.title || 'Unavailable subgraph', () => open(id));
        tab.dataset.harnessFocus = key('tab', id);
        tab.setAttribute('aria-current', String(id === active)); tabbar.append(tab);
      }
      breadcrumbs.replaceChildren();
      const ancestors = [], visited = new Set();
      let cursor = graph;
      while (cursor && !visited.has(cursor.id)) { ancestors.unshift(cursor); visited.add(cursor.id); cursor = model.graphs.get(cursor.parent); }
      ancestors.forEach(item => breadcrumbs.append(button(item.title, () => open(item.id))));
      back.disabled = !graph.parent; zoom.value = String(saved.zoom * 100);
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
      if (session?.sessionId !== next.sessionId) { sequence++; tabs = []; views = new Map(); active = null; }
      session = next; model = build(next);
      active = model.graphs.has(active) ? active : model.root;
      tabs = tabs.filter(id => model.graphs.has(id)); if (!tabs.includes(active)) tabs.push(active);
      title.textContent = next.task || 'PKM Chat';
      status.textContent = `Recorded: ${next.harness?.state || next.status}${next.harness?.currentPhase?.label ? ` / ${next.harness.currentPhase.label}` : ''}${next.liveness?.state ? ` / liveness: ${next.liveness.state}` : ''} / record: ${next.updatedAt || 'unknown'} / refreshed ${new Date().toLocaleTimeString()}`;
      warning.textContent = model.warnings.join('\n'); error.textContent = '';
      draw();
    }
    async function refresh(force = false) {
      if (disposed || !session || (!force && (!auto || document.visibilityState === 'hidden' || !root.isConnected))) return;
      if (loading) { pending = true; pendingForce = pendingForce || force; return; }
      loading = true;
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
      root, update, refresh, focusCurrent, get automatic() { return auto; },
      attach(parent) { parent.append(root); },
      notify() { void refresh(); },
      dispose() { disposed = true; sequence++; clearInterval(timer); document.removeEventListener('visibilitychange', visible); root.remove(); }
    };
  }
  const api = { build, layout, terminal, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PkmAgentHarness = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
