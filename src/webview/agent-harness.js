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
  const ringPositions = { configure:[520, 80], run:[720, 200], monitor:[650, 380], evaluate:[420, 380], check:[330, 200], end:[90, 200] };
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
        ['Reported usage', usage ? `${usage.inputTokens ?? '?'} in / ${usage.outputTokens ?? '?'} out` : 'not reported'],
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

  function mount(container, options) {
    const document = container.ownerDocument;
    const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
    const button = (text, action, label) => { const node = el('button', text); node.type = 'button'; if (label) node.setAttribute('aria-label', label); node.addEventListener('click', action); return node; };
    const root = el('section', undefined, 'pkm-harness');
    root.setAttribute('aria-label', 'PKM native execution subgraphs');
    let session, model, active, sequence = 0, disposed = false, loading = false, pending = false, pendingForce = false;
    let tabs = [], views = new Map(), auto = true, ringSelected, dashboardAttemptId;
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
    root.append(toolbar, error, dashboard, overviewBox, warning, tabbar, breadcrumbs, tools, viewport, inspector, dialog);
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
    function drawRing() {
      const data = model.lifecycle, focused = document.activeElement?.dataset?.harnessFocus;
      if (!data.stages.some(stage => stage.id === ringSelected)) ringSelected = data.current;
      back.disabled = true; zoom.disabled = true;
      breadcrumbs.replaceChildren();
      const ring = el('div', undefined, 'pkm-harness-ring');
      ring.dataset.outcome = data.outcome;
      ring.setAttribute('role', 'group'); ring.setAttribute('aria-label', 'Harness lifecycle');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 800 460'); svg.setAttribute('aria-hidden', 'true');
      const defs = document.createElementNS(svg.namespaceURI, 'defs'), marker = document.createElementNS(svg.namespaceURI, 'marker');
      marker.setAttribute('id', 'pkm-ring-arrow'); marker.setAttribute('viewBox', '0 0 10 10'); marker.setAttribute('refX', '8'); marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '3.2'); marker.setAttribute('markerHeight', '3.2'); marker.setAttribute('orient', 'auto-start-reverse');
      const head = document.createElementNS(svg.namespaceURI, 'path'); head.setAttribute('d', 'M0 0 L10 5 L0 10 z');
      marker.append(head); defs.append(marker); svg.append(defs);
      const arrows = [['configure', 'run'], ['run', 'monitor'], ['monitor', 'evaluate'], ['evaluate', 'check'], ['check', 'configure'], ['check', 'end']];
      for (const [from, to] of arrows) {
        const a = ringPositions[from], b = ringPositions[to], dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy), r = 68;
        const line = document.createElementNS(svg.namespaceURI, 'line');
        line.setAttribute('x1', String(a[0] + dx / length * r)); line.setAttribute('y1', String(a[1] + dy / length * r));
        line.setAttribute('x2', String(b[0] - dx / length * r)); line.setAttribute('y2', String(b[1] - dy / length * r));
        line.setAttribute('marker-end', 'url(#pkm-ring-arrow)');
        const fromIndex = stageOrder.indexOf(from), currentIndex = stageOrder.indexOf(data.current);
        const taken = from === 'check' ? (to === 'end' ? data.check === 'passed' : data.check === 'failed' || data.iterations > 0)
          : fromIndex < currentIndex;
        line.setAttribute('class', `${taken ? 'taken' : ''} ${from === 'check' && to === 'configure' ? 'loop' : ''}`.trim());
        svg.append(line);
        if (from === 'check' && to === 'configure' && data.iterations) {
          const label = document.createElementNS(svg.namespaceURI, 'text');
          label.setAttribute('x', String((a[0] + b[0]) / 2 - 120)); label.setAttribute('y', String((a[1] + b[1]) / 2 - 18));
          label.textContent = `Iterate x${data.iterations}`; svg.append(label);
        }
      }
      ring.append(svg);
      for (const stage of data.stages) {
        const circle = button('', () => { ringSelected = stage.id; drawRing(); }, `${stage.label}: ${stage.current ? `${data.live ? 'current' : 'last recorded'}, ${stage.status}` : stage.status}`);
        circle.className = 'pkm-harness-stage'; circle.dataset.stage = stage.id; circle.dataset.status = stage.status;
        circle.dataset.harnessFocus = key('stage', stage.id);
        if (stage.current) circle.setAttribute('aria-current', 'step');
        circle.setAttribute('aria-pressed', String(stage.id === ringSelected));
        const [x, y] = ringPositions[stage.id];
        circle.style.left = `${x / 8}%`; circle.style.top = `${y / 4.6}%`;
        circle.append(el('span', stage.label, 'pkm-harness-stage-label'),
          el('small', stage.current ? { unverified:'done, not validated', waiting:'waiting', running:'running', failed:'failed', complete:'reached' }[stage.status] || stage.status
            : stage.status === 'pending' ? '' : stage.status));
        if (stage.id === 'run' && data.activity) {
          circle.append(el('span', data.activity, 'pkm-harness-current-activity'));
          circle.title = `Current activity: ${data.activity}`;
        }
        ring.append(circle);
      }
      const summary = el('p', undefined, 'pkm-harness-ring-summary');
      summary.append(el('strong', `${data.live ? 'Current' : 'Last recorded'} / ${data.stages.find(stage => stage.current).label}: `), document.createTextNode(data.reason));
      tools.hidden = true;
      summary.append(button('Current execution', focusCurrent), button('Full execution graph', () => open(model.root)));
      viewport.replaceChildren(summary, ring);
      const selected = data.stages.find(stage => stage.id === ringSelected);
      inspector.replaceChildren(el('h3', `${selected.label}${selected.current ? data.live ? ' (current)' : ' (last recorded)' : ''}`));
      const items = el('dl', undefined, 'pkm-harness-stage-items');
      for (const [name, value] of selected.items) items.append(el('dt', name), el('dd', value));
      inspector.append(items, button('Open records', () => open(selected.graphId), `Open recorded evidence for ${selected.label}`));
      if (focused) [...root.querySelectorAll('[data-harness-focus]')].find(node => node.dataset.harnessFocus === focused)?.focus({ preventScroll:true });
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
    function drawDashboard() {
      const focused = document.activeElement?.dataset?.harnessFocus;
      const attempts = list(session.harness?.attempts);
      const attempt = attempts.find(item => item.messageId === dashboardAttemptId) || attempts.at(-1);
      const receipts = list(attempt?.budgetReceipts), receipt = receipts.at(-1), usage = attempt?.validation?.reportedUsage;
      const diagnostics = el('section', undefined, 'pkm-harness-diagnostics');
      diagnostics.setAttribute('role', 'log'); diagnostics.setAttribute('aria-label', 'Latest runtime diagnostics');
      diagnostics.append(el('h3', 'Latest errors / warnings / status'));
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
      for (const record of records.slice(-10)) {
        const line = el('p', `${record.level.toUpperCase()} / ${record.text}`);
        line.dataset.level = record.level; diagnostics.append(line);
      }
      const parameters = el('table', undefined, 'pkm-harness-parameters');
      parameters.setAttribute('aria-label', 'Recorded runtime parameters');
      const caption = el('caption', 'Runtime parameters (latest attempt; reported usage may cover only some rounds)');
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
        ['Token usage (input / output)', `${quantity(usage?.inputTokens)} / ${quantity(usage?.outputTokens)}`],
        ['Reasoning tokens', quantity(usage?.reasoningTokens)],
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
      attemptSelect.addEventListener('change', () => { dashboardAttemptId = attemptSelect.value; drawDashboard(); });
      selection.append(attemptSelect, el('p', 'Diagrams and parameters use the selected attempt; Recipe / Action bindings are Session-wide. Missing receipts are not zero work. No model, Recipe or Action is run to populate this view.', 'pkm-harness-unknown'));
      const card = (id, title, graphId) => {
        const node = el('section', undefined, 'pkm-harness-diagram-card'); node.dataset.diagram = id;
        const heading = el('h3', title); node.append(heading);
        if (graphId && model.graphs.has(graphId)) {
          const openGraph = button('Inspect recorded graph', () => locate(graphId), `Inspect ${title}`);
          openGraph.dataset.harnessFocus = key('dashboard', id); node.append(openGraph);
        }
        grid.append(node); return node;
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
      const attemptGraph = attempt && key('chat-attempt', attempt.messageId);
      const harnessCard = card('harness', 'Harness flow', attemptGraph || model.root);
      const selectedLifecycle = attempt && attempt !== attempts.at(-1)
        ? lifecycle({ ...session, status:attempt.status, todos:[], harness:{ ...session.harness, attempts:[attempt], state:attempt.status,
          currentPhase:attempt.progress?.phase, waiting:undefined } }, model, new Map(list(session.actionRuns).map(run => [run.runId, run])))
        : model.lifecycle;
      const stages = el('ol', undefined, 'pkm-harness-flow-preview');
      for (const stage of selectedLifecycle.stages) {
        const item = el('li', `${stage.label} / ${stage.status}`);
        if (stage.current) item.setAttribute('aria-current', 'step');
        stages.append(item);
      }
      harnessCard.append(stages, el('small', selectedLifecycle.reason));
      preview(harnessCard, attemptGraph || model.root);
      const recipe = card('recipes', 'Recipe / Action graphs');
      const bindings = [...model.overview.recipes, ...model.overview.actions].filter(item => item.available && item.graphId);
      if (!bindings.length) recipe.append(el('p', 'No available explicit Recipe / Action binding.', 'pkm-harness-unknown'));
      for (const binding of bindings) {
        const name = binding.name || binding.actionId || binding.runId;
        const link = button(`Inspect ${name}`, () => locate(binding.graphId, binding.nodeId));
        link.dataset.harnessFocus = key('dashboard-binding', binding.runId); recipe.append(link);
        preview(recipe, binding.graphId);
      }
      const memory = card('memory', 'Memory pyramid', attempt?.memory?.accounting && key('memory-accounting', attempt.messageId));
      if (!attempt?.memory) memory.append(el('p', 'No Memory preparation receipt recorded for this attempt. This does not establish that Memory is disabled or empty.', 'pkm-harness-unknown'));
      else {
        const pyramid = el('div', undefined, 'pkm-harness-memory-pyramid');
        const blocks = list(attempt.memory.blocks);
        const kinds = [...new Set(blocks.map(block => block.kind))];
        kinds.forEach((kind, index) => {
          const level = el('div', `${kind}: ${blocks.filter(block => block.kind === kind).length} block(s)`);
          level.style.width = `${55 + (index + 1) / kinds.length * 45}%`; pyramid.append(level);
        });
        memory.append(pyramid, el('small', kinds.length ? 'Recorded preparation blocks grouped by kind; widths are illustrative, not token usage or inferred storage hierarchy.' : 'Receipt recorded no preparation blocks.'));
        if (attempt.memory.error) memory.append(el('p', `Memory preparation error: ${attempt.memory.error}`, 'pkm-harness-unknown'));
        if (attempt.memory.accounting) preview(memory, key('memory-accounting', attempt.messageId));
      }
      const retrieval = card('retrieval', 'Retrieval flow', attempt && key('retrieval', attempt.messageId));
      const last = list(attempt?.retrieval).at(-1), candidates = list(last?.receipt?.candidates);
      if (!last) retrieval.append(el('p', 'No retrieval receipt recorded.', 'pkm-harness-unknown'));
      else {
        const flow = el('div', undefined, 'pkm-harness-retrieval-stages');
        for (const [label, count] of [
          ['Candidates', candidates.length], ['Selected', candidates.filter(item => item.selected).length],
          ['Sent', candidates.filter(item => item.evidenceState === 'sent').length]
        ]) flow.append(el('div', `${label}: ${count}`));
        retrieval.append(flow, el('small', `Latest receipt: ${last.kind} / ${last.receipt?.phase || 'unknown'}. Selection alone does not prove transmission.`));
        preview(retrieval, key('retrieval', attempt.messageId));
      }
      dashboard.replaceChildren(diagnostics, selection, parameters, grid);
      if (focused) [...dashboard.querySelectorAll('[data-harness-focus]')].find(node => node.dataset.harnessFocus === focused)?.focus({ preventScroll:true });
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
      tabbar.replaceChildren();
      for (const id of tabs) {
        const tab = button(id === RING ? 'Lifecycle' : model.graphs.get(id)?.title || 'Unavailable subgraph', () => open(id));
        tab.dataset.harnessFocus = key('tab', id);
        tab.setAttribute('aria-current', String(id === active)); tabbar.append(tab);
      }
      if (active === RING) { drawRing(); return; }
      tools.hidden = false; zoom.disabled = false;
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
      if (session?.sessionId !== next.sessionId) { sequence++; tabs = []; views = new Map(); active = null; }
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
        ringSelected = model.lifecycle.current; open(RING);
        root.querySelector('.pkm-harness-stage[aria-current="step"]')?.focus({ preventScroll:true });
      },
      attach(parent) { parent.append(root); },
      notify() { void refresh(); },
      dispose() { disposed = true; sequence++; clearInterval(timer); document.removeEventListener('visibilitychange', visible); root.remove(); }
    };
  }
  const api = { build, layout, terminal, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PkmAgentHarness = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
