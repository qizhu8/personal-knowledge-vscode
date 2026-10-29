const skillRouterBenchmarks = [
  { profile: 'copilot_default', name: 'Copilot default search', detail: 'Host-provided fallback', state: 'Available' },
  { profile: 'l1_online', name: 'Exact + BM25', detail: 'Default local keyword retrieval', state: 'Available' },
];
let skillRouterStatusCache = null;
let skillRouterStatusUpdatedAt = 0;
let skillRouterDraggedSourceId = '';
let skillRouterSourceSaving = false;
let skillRouterSolutionCache = null;
let skillRouterSolutionPending = '';
let skillRouterSolutionSequence = 0;
let skillRouterSolutionTimer;
let skillRouterHoverSequence = 0;
let skillRouterMetric = 'runtime';
let skillRouterCalibrationContext = '';
let skillRouterAdaptivePending;
let skillRouterPerformanceTimer;
let skillRouterPerformancePending = '';
let skillRouterPerformanceError = '';
let skillRouterWorkflowStage = 'calibrator';
let skillRouterInspectorTab = 'parameters';
let skillRouterWorkflowTipTimer;
const skillRouterInspectorTabs = [['parameters','Parameters'],['controls','Controls'],['graphs','Graphs'],['metrics','Metrics']];

function skillRouterRequestPerformance() {
  if (skillRouterPerformancePending) return;
  clearTimeout(skillRouterPerformanceTimer);
  skillRouterPerformanceError = '';
  skillRouterPerformancePending = `performance-${Date.now()}-${++skillRouterSolutionSequence}`;
  skillRouterPerformanceTimer = setTimeout(() => {
    skillRouterPerformancePending = '';
    skillRouterPerformanceError = 'Performance refresh timed out. Refresh explicitly to check again.';
    skillRouterRefreshPerformanceView();
  }, 10000);
  skillRouterRefreshPerformanceView();
  ask('retrievalPerformance', { requestId:skillRouterPerformancePending }, null, true);
}

function skillRouterSchedulePerformanceRefresh() {
  if (skillRouterPerformancePending) return;
  clearTimeout(skillRouterPerformanceTimer);
  if (state.tab !== 'skillRouter' || settingsSubtabs.router !== 'performance'
      || document.visibilityState !== 'visible' || !skillRouterSolutionCache?.learning || skillRouterPerformanceError
      || !(skillRouterSolutionCache.requested_package_id || skillRouterSolutionCache.active_package_id
        || skillRouterStatusCache?.runtime?.semanticStatus === 'ready')) return;
  skillRouterPerformanceTimer = setTimeout(skillRouterRequestPerformance, 10000);
}
document.addEventListener?.('visibilitychange', skillRouterSchedulePerformanceRefresh);

function skillRouterPerformanceOnSnapshot(data) {
  if (!data || data.requestId !== skillRouterPerformancePending) return;
  clearTimeout(skillRouterPerformanceTimer);
  skillRouterPerformancePending = '';
  skillRouterPerformanceError = data.error || (data.learning ? '' : 'Call history is unavailable from this worker.');
  if (data.learning) skillRouterSolutionCache = { ...skillRouterSolutionCache, learning:data.learning };
  if (state.tab === 'skillRouter') skillRouterRefreshPerformanceView();
}

function skillRouterNavigation() {
  if (settingsSubtabs.router === 'models') settingsSubtabs.router = 'performance';
  return settingsTabBar('router', [['sources','Skill Sources'],['performance','Retrieval & Performance'],['privacy','Collector & Privacy']]);
}

function skillRouterChart(series, { label, xLabel, yLabel, percent = false }) {
  const points = series.flatMap(line => line.points).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!points.length) return '';
  const xMin = Math.min(...points.map(point => point.x)), xMax = Math.max(...points.map(point => point.x));
  const yMax = percent ? 1 : Math.max(1, ...points.map(point => point.y));
  const x = value => 60 + (value - xMin) / (xMax - xMin || 1) * 540;
  const y = value => 192 - value / yMax * 160;
  const format = value => percent ? `${Math.round(value * 100)}%` : String(Math.round(value * 100) / 100);
  return `<svg class="sr-chart" viewBox="0 0 640 240" role="img" aria-label="${esc(label)}">
    ${[0,.5,1].map(tick => `<line x1="60" x2="600" y1="${y(tick * yMax)}" y2="${y(tick * yMax)}" class="sr-chart-grid"/><text x="52" y="${y(tick * yMax) + 4}" text-anchor="end">${format(tick * yMax)}</text>`).join('')}
    <text x="60" y="210" text-anchor="middle">${xMin}</text><text x="600" y="210" text-anchor="middle">${xMax}</text>
    <text x="330" y="232" text-anchor="middle">${esc(xLabel)}</text><text x="60" y="18">${esc(yLabel)}</text>
    ${series.map((line, index) => {
      const valid = line.points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
      const segments = [];
      let segment = [];
      for (const point of line.points) {
        if (Number.isFinite(point.x) && Number.isFinite(point.y)) segment.push(`${x(point.x)},${y(point.y)}`);
        else if (segment.length) { segments.push(segment); segment = []; }
      }
      if (segment.length) segments.push(segment);
      return `<g class="sr-chart-series sr-chart-series-${index}">${segments.map(values => `<polyline points="${values.join(' ')}"/>`).join('')}${valid.map(point =>
        `<circle cx="${x(point.x)}" cy="${y(point.y)}" r="3" ${point.failed ? 'class="sr-chart-failed"' : ''}><title>${esc(`${line.label}: ${point.x} / ${format(point.y)}${point.route ? ` / ${point.route}` : ''}${point.failed ? ' / Failed model attempt' : ''}`)}</title></circle>`).join('')}</g>`;
    }).join('')}</svg>`;
}

function skillRouterWorkflowState(model, learning, runtime = skillRouterStatusCache?.runtime || {}) {
  const data = skillRouterSolutionCache || {};
  const solution = runtime.solution || data;
  const active = solution.active_package_id || (runtime.skillServing?.ready ? runtime.skillServing.release_id : '');
  const index = active ? solution.index?.statistics : undefined;
  const count = value => Number.isInteger(value) && value >= 0 ? value.toLocaleString() : 'Not reported';
  const decimal = value => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : 'Not reported';
  const packages = data.packages;
  const valid = packages?.filter(item => !item.error) || [];
  const identities = valid.map(item => typeof item.encoder_bundle_id === 'string'
    && /^[a-f0-9]{64}$/.test(item.encoder_bundle_id) ? item.encoder_bundle_id : undefined);
  const bundles = new Set(identities.filter(Boolean));
  const completeInventory = packages && valid.length === packages.length && identities.every(Boolean);
  const encoders = !packages ? 'Not reported' : completeInventory ? count(bundles.size) : `${count(bundles.size)} known; inventory incomplete`;
  const policy = learning?.policy;
  const revision = solution.corpus_revision || runtime.corpusRevision;
  const stages = {
    assets:{ label:'Assets', tip:'Configured L1 sources feed the local index. Counts describe assets, not necessarily physical files.',
      facts:[['Ready L1 sources', runtime.ready === false ? 'Not ready' : count(runtime.documentCount)], ['Corpus revision', runtime.corpusRevision || 'Not reported']] },
    encoder:{ label:'Encoder A', tip:`Frozen encoder shared by documents and queries. ${active ? 'Active: ' + active : 'No active embedding model'}. Managed inventory excludes external caches and unmanaged releases.`,
      facts:[['Total parameters','Not reported'], ['Encoder parameters updated online',0], ['Managed encoders',encoders],
        ['Imported packages',count(packages?.length)], ['Active package / release',active || 'None'], ['Requested package',solution.requested_package_id || 'None'],
        ['Architecture',valid.find(item => item.package_id === active)?.architecture || runtime.skillServing?.architecture_id || 'Not reported']] },
    index:{ label:'Index A', tip:'Built/restored model index. Internal sections are not the API L2 passage table; L2 evidence ranges are materialized separately.',
      facts:[['Model-index sources',count(index?.document_count)], ['Document vectors',count(index?.document_vector_count)],
        ['Internal units',count(index?.unit_count)], ['Covered sources',count(index?.unit_source_count)],
        ['Unit vectors',count(index?.unit_vector_count)], ['Token vectors',count(index?.token_vector_count)],
        ['Granularity',index?.granularity || 'Not reported'], ['L2 passage table','Not reported'],
        ['State',solution.state || 'Not reported'], ['Model corpus revision',revision || 'Not reported']] },
    query:{ label:'Query', tip:'Each caller chooses lexical, semantic or dual. There is no model A/B traffic controller today.',
      facts:[['Routes','lexical / semantic / dual'], ['Selection','Per query'], ['A/B split','Not implemented']] },
    lexical:{ label:'Exact + BM25', tip:'Default keyword path. Lexical-only results bypass online ranking, calibration and adaptive thresholding.',
      facts:[['Engine',runtime.engineVersion || 'Not reported'], ['Ready sources',count(runtime.documentCount)], ['Online learning','Bypassed']] },
    score:{ label:'Similarity / fusion', tip:'Semantic similarity searches Index A. Dual mode merges semantic and keyword ranks using RRF(k=60).',
      facts:[['Dual fusion','Reciprocal rank fusion'], ['RRF k',60], ['Candidate scores','Not retained in history']] },
    ranker:{ label:'Online ranker', tip:'A bounded hashed-feature residual reranks the admitted candidate pool before calibration. Embeddings stay frozen.',
      facts:[['Trainable parameters',count(model?.ranker?.features)], ['Weight bound',model?.ranker?.weight_bound ?? 'Not reported'],
        ['Revision',count(model?.ranker_revision)], ['Effective judged calls',count(model?.judged_calls)], ['State',model?.state || 'Not reported']] },
    calibrator:{ label:'Calibrator', tip:'sigmoid(slope × normalized rank score + bias). Runs after the ranker and before thresholding; the Graphs tab shows this function.',
      facts:[['Trainable parameters',2], ['Slope',decimal(model?.current?.slope)], ['Bias',decimal(model?.current?.bias)],
        ['Initial slope',decimal(model?.baseline?.slope)], ['Initial bias',decimal(model?.baseline?.bias)], ['Revision',count(model?.calibrator_revision)]] },
    threshold:{ label:'Threshold', tip:'A calibrated score gap can reduce the caller limit after consecutive safe complete judgments. No clear gap keeps the original limit; this is not a Recall guarantee.',
      facts:[['Adaptive parameters',1], ['Gap threshold',decimal(model?.threshold)], ['Gap floor',decimal(policy?.minimum_gap)],
        ['Retain probability ≥',decimal(policy?.retain_probability)], ['Discard probability ≤',decimal(policy?.discard_probability)],
        ['EWMA new weight',decimal(policy?.threshold_ewma)], ['Safe streak',`${count(model?.safe_streak)} / ${count(learning?.minimum_judged_calls)}`]] },
    results:{ label:'L1 results', tip:'Returned sources respect the caller limit. Consumers separately materialize L2 evidence. Top-K judgments cannot establish full-corpus Recall.',
      facts:[['Output','L1 sources'], ['Caller limit','Upper bound'], ['L2 evidence','Separate source-range materialization']] },
    feedback:{ label:'Feedback', tip:'Eligible semantic/dual judgments update the ranker, calibrator and gap threshold. User labels override model labels. Unused is not negative; hashed receipts are not an encoder-training corpus.',
      facts:[['Retained receipts',count(learning?.stored_calls)], ['Receipt capacity',count(policy?.retention_calls)],
        ['Visible receipts',count(learning?.calls?.length)], ['Persistent user authorities',count(learning?.stored_user_judgments)],
        ['Effective model examples',count(model?.model_labels)], ['Effective user examples',count(model?.user_labels)]] },
    candidate:{ label:'Candidate rollout', tip:'Planned only: encoder replay → model B/index B → shadow/canary → paired promotion/rollback. 150 updates is a proposal, not a configured gate.',
      facts:[['Status','Not implemented'], ['Encoder training','Not enabled'], ['Traffic split','Not enabled'], ['Promotion gate','Not configured']] },
  };
  return { data, runtime, solution, active, index, stages, count, decimal };
}

function skillRouterWorkflowHtml(view) {
  const node = (stage, id, label, x, y) => `<button type="button" class="sr-flow-node ${stage === 'candidate' ? 'sr-flow-planned' : ''}"
    id="sr-flow-${id}" style="left:${x}px;top:${y}px" data-workflow-stage="${stage}" data-workflow-tip="${esc(view.stages[stage].tip)}"
    aria-pressed="${skillRouterWorkflowStage === stage}" aria-controls="sr-inspector" aria-describedby="sr-workflow-tooltip"
    onpointerenter="skillRouterHoverWorkflow(this)" onpointerleave="skillRouterHideWorkflowTip()" onfocus="skillRouterHoverWorkflow(this)" onblur="skillRouterHideWorkflowTip()"
    onkeydown="if(event.key==='Escape')skillRouterHideWorkflowTip(true)" onclick="skillRouterSelectWorkflow('${stage}')">${esc(label)}</button>`;
  return `<div id="sr-workflow" class="sr-workflow">
    <div class="sr-section-head"><h3>Retrieval worker</h3><span class="sr-flow-hint">Hover to explain · Click to inspect</span>
      <button class="tbtn" aria-label="Refresh Performance" onclick="skillRouterRequestPerformance()" ${skillRouterPerformancePending ? 'disabled' : ''}>Refresh</button></div>
    <div class="sr-workflow-viewport" tabindex="0" role="region" aria-label="Retrieval runtime graph">
      <div class="sr-workflow-canvas">
        <svg viewBox="0 0 1000 310" aria-hidden="true" class="sr-flow-edges"><defs><marker id="sr-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z"/></marker></defs>
          <g class="sr-flow-path">${['M130 46H160','M270 46H300','M355 68V112','M75 156V226H160','M130 134H160','M270 134H300','M410 134H440','M550 134H580','M690 134H720','M830 134H860'].map(path => `<path d="${path}"/>`).join('')}
            <path d="M270 226H355V156" class="sr-flow-dual"/><path d="M215 248V286H915V156" class="sr-flow-lexical"/>
            ${['M915 156V266H635V248','M580 226H495V156','M635 204V156','M690 226H775V156'].map(path => `<path d="${path}" class="sr-flow-feedback-path"/>`).join('')}
            <path d="M215 68V112" class="sr-flow-shared"/></g>
          <g class="sr-flow-edge-label"><text x="20" y="16">Build</text><text x="20" y="103">Search</text>
            <text x="278" y="218">dual</text><text x="370" y="302">lexical · bypass learning</text><text x="710" y="260">eligible labels</text></g>
        </svg>
        ${node('assets','assets','Assets',20,24)}${node('encoder','encoder','Encoder A',160,24)}${node('index','index','Index A',300,24)}
        ${node('candidate','candidate','Candidate · planned',720,24)}
        ${node('query','query','Query',20,112)}${node('encoder','query-encoder','Query encoder',160,112)}${node('score','score','Similarity / fusion',300,112)}
        ${node('ranker','ranker','Ranker',440,112)}${node('calibrator','calibrator','Calibrator',580,112)}${node('threshold','threshold','Threshold',720,112)}${node('results','results','L1 results',860,112)}
        ${node('lexical','lexical','Exact + BM25',160,204)}${node('feedback','feedback','Feedback',580,204)}
      </div>
    </div>
    <div id="sr-workflow-tooltip" class="sr-hover-panel sr-workflow-tooltip" role="tooltip" hidden
      onpointerenter="clearTimeout(skillRouterWorkflowTipTimer)" onpointerleave="skillRouterHideWorkflowTip()"></div>
  </div>`;
}

function skillRouterSelectWorkflow(stage) {
  skillRouterWorkflowStage = stage;
  skillRouterRefreshPerformanceView();
  skillRouterHideWorkflowTip(true);
}

function skillRouterSetInspectorTab(tab, focus = false) {
  if (!skillRouterInspectorTabs.some(([id]) => id === tab)) return;
  skillRouterInspectorTab = tab;
  skillRouterRefreshPerformanceView();
  if (focus) document.getElementById(`sr-inspector-tab-${tab}`)?.focus({ preventScroll:true });
}

function skillRouterInspectorKey(event) {
  const index = skillRouterInspectorTabs.findIndex(([id]) => id === skillRouterInspectorTab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : event.key === 'ArrowRight' ? (index + 1) % 4 : event.key === 'ArrowLeft' ? (index + 3) % 4 : -1;
  if (next < 0) return;
  event.preventDefault();
  skillRouterSetInspectorTab(skillRouterInspectorTabs[next][0], true);
}

function skillRouterHoverWorkflow(button) {
  clearTimeout(skillRouterWorkflowTipTimer);
  const tip = document.getElementById('sr-workflow-tooltip');
  if (!tip) return;
  tip.textContent = button.dataset.workflowTip;
  tip.hidden = false;
  skillRouterPositionPopover(tip, button);
}

function skillRouterHideWorkflowTip(immediate = false) {
  clearTimeout(skillRouterWorkflowTipTimer);
  const close = () => { const tip = document.getElementById('sr-workflow-tooltip'); if (tip) tip.hidden = true; };
  if (immediate) close(); else skillRouterWorkflowTipTimer = setTimeout(close, 150);
}

function skillRouterPerformanceHtml(runtime = skillRouterStatusCache?.runtime || {}) {
  const data = skillRouterSolutionCache || {};
  const selected = data.requested_package_id || data.active_package_id || runtime.semanticStatus === 'ready'
    || runtime.skillServing?.ready;
  const learning = data.learning;
  const packageId = runtime.solution?.active_package_id || runtime.solution?.requested_package_id
    || data.active_package_id || data.requested_package_id || runtime.skillServing?.release_id;
  const corpusRevision = runtime.corpusRevision || data.corpus_revision;
  const models = (learning?.models || []).filter(model => (!packageId || model.package_id === packageId)
    && (!corpusRevision || model.corpus_revision === corpusRevision));
  const recent = [...(learning?.calls || [])].reverse();
  const latest = recent.find(call => call.success !== false && models.some(model => model.context === call.context))
    || recent.find(call => models.some(model => model.context === call.context));
  const model = models.find(model => model.context === skillRouterCalibrationContext)
    || models.find(model => model.context === latest?.context);
  if (model) skillRouterCalibrationContext = model.context;
  const calls = (learning?.calls || []).filter(call => model && call.context === model.context);
  const view = skillRouterWorkflowState(model, learning, runtime);
  const stage = view.stages[skillRouterWorkflowStage];
  const facts = entries => `<dl class="sr-inspector-facts">${entries.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
  const metrics = { runtime:['Runtime (ms)','runtime_ms'], recall:['Recall','recall'], precision:['Precision','precision'], results:['Returned Results','returned_count'] };
  const [label, field] = metrics[skillRouterMetric];
  const plot = skillRouterChart([{ label, points:calls.map(call => ({ x:call.invocation, y:call[field], failed:call.success === false,
    route:models.find(item => item.context === call.context)?.route })) }],
    { label:`${label} by Model Call`, xLabel:'Model Call Sequence', yLabel:label, percent:['recall','precision'].includes(skillRouterMetric) });
  const curves = model ? ['baseline','current'].map(key => ({
    label:key === 'baseline' ? 'Original' : 'Current',
    points:Array.from({ length:41 }, (_, index) => {
      const x = index / 40, parameters = model[key];
      return { x, y:1 / (1 + Math.exp(-Math.max(-40, Math.min(40, parameters.slope * x + parameters.bias)))) };
    }),
  })) : [];
  const curve = skillRouterChart(curves, { label:'Original and Current Calibration Functions', xLabel:'Normalized Rank Score',
    yLabel:'Estimated Relevance', percent:true });
  const adaptive = learning ? `<label class="sr-solution-toggle"><input id="sr-adaptive-count" type="checkbox" ${(skillRouterAdaptivePending ?? learning.enabled) ? 'checked' : ''}
    ${skillRouterSolutionPending ? 'disabled' : ''} onchange="skillRouterSolutionRequest('retrievalAdaptiveCount',undefined,this.checked)">Adaptive Result Count</label>
    <p class="sr-inspector-note">Controls online ranking, calibration updates and result trimming together.</p>` : '<p role="status">Learning controls are unavailable from this worker.</p>';
  const lexicalEnabled = skillRouterStatusCache?.solutions?.l1_online?.enabled;
  const controls = skillRouterWorkflowStage === 'candidate' ? '<p role="status">Not implemented. No training, traffic split or promotion is enabled.</p>'
    : ['query','lexical'].includes(skillRouterWorkflowStage) ? `${typeof lexicalEnabled === 'boolean' ? `<label class="sr-solution-toggle"><input id="sr-inspector-lexical" type="checkbox" ${lexicalEnabled ? 'checked' : ''} onchange="skillRouterToggleSolution('l1_online',this.checked)">Exact + BM25</label>` : '<p role="status">Route configuration not reported.</p>'}<p class="sr-inspector-note">Search mode is chosen per request, not by a global route knob.</p>`
    : ['ranker','calibrator','threshold','feedback'].includes(skillRouterWorkflowStage) ? adaptive
    : skillRouterWorkflowStage === 'encoder' ? ''
    : '<p role="status">Read-only stage. No independent tuning control is exposed.</p>';
  let graph = '<p role="status">No stage-specific graph is reported.</p>';
  if (skillRouterWorkflowStage === 'calibrator') graph = `<div id="sr-calibration">${curve || '<p role="status">No calibration observations for this model and corpus yet.</p>'}
    <div class="sr-chart-legend"><span>Original (dashed)</span><span>Current (solid)</span><strong>${model?.judged_calls ? `${Number(model.judged_calls)} Judged Calls` : 'Not Trained Yet'}</strong></div></div>`;
  if (['assets','index'].includes(skillRouterWorkflowStage)) {
    const sizes = [['Document vectors',view.index?.document_vector_count],['Internal units',view.index?.unit_count],['Covered sources',view.index?.unit_source_count],['Token vectors',view.index?.token_vector_count]];
    const max = Math.max(1, ...sizes.map(([, value]) => Number.isInteger(value) ? value : 0));
    graph = `<ul class="sr-index-bars" aria-label="Observed model index contents">${sizes.map(([name, value]) => `<li><span>${name}</span>${Number.isInteger(value) ? `<meter aria-label="${name}" min="0" max="${max}" value="${value}"></meter>` : '<span>Not reported</span>'}<b>${view.count(value)}</b></li>`).join('')}</ul><p class="sr-inspector-note">Internal units are not a persisted L2 passage table.</p>`;
  }
  if (['ranker','feedback'].includes(skillRouterWorkflowStage)) graph = skillRouterChart([
    {label:'Brier',points:calls.map(call => ({x:call.invocation,y:call.prequential_brier}))},
    {label:'Log-loss',points:calls.map(call => ({x:call.invocation,y:call.prequential_log_loss}))},
  ], {label:'Pre-update Learning Loss',xLabel:'Model Call Sequence',yLabel:'Loss'}) || '<p role="status">No pre-update loss observations yet.</p>';
  if (skillRouterWorkflowStage === 'threshold') graph = skillRouterChart([{label:'Returned Results',points:calls.map(call => ({x:call.invocation,y:call.returned_count}))}],
    {label:'Returned Results by Model Call',xLabel:'Model Call Sequence',yLabel:'Returned Results'}) || '<p role="status">No result-count observations yet.</p>';
  if (skillRouterWorkflowStage === 'candidate') graph = '<div class="sr-candidate-graph" aria-label="Planned candidate lifecycle"><span>Training replay</span><span>Model B + index B</span><span>Shadow / canary</span><span>Promote / rollback</span></div><p class="sr-inspector-note">Planned only. 150 updates is not a configured gate.</p>';
  const judged = [...calls].reverse().find(call => Number.isFinite(call.precision) || Number.isFinite(call.recall));
  const percent = value => Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'Not reported';
  const benchmark = skillRouterStatusCache?.benchmark;
  const metricBody = skillRouterWorkflowStage === 'candidate' ? '<p role="status">No candidate traffic or evaluation metrics exist.</p>'
    : skillRouterWorkflowStage === 'lexical' ? `${facts([['Synthetic Success@5',percent(benchmark?.metrics?.successRate)],['Synthetic Precision@5',percent(benchmark?.metrics?.precisionAt5)]])}<button class="tbtn" onclick="ask('runSkillRouterBenchmark',{})" ${benchmark?.running ? 'disabled' : ''}>${benchmark?.running ? 'Measuring…' : 'Run benchmark'}</button><p class="sr-inspector-note">Synthetic corpus, not live-corpus Recall.</p>`
    : `${facts([['Latest judged Precision',percent(judged?.precision)],['Latest judged Recall',percent(judged?.recall)],['Pre-update Brier',view.decimal(model?.prequential?.brier)],['Pre-update log-loss',view.decimal(model?.prequential?.log_loss)]])}
      <label>Metric <select id="sr-metric" aria-label="Performance Metric" onchange="skillRouterSetMetric(this.value)">${Object.entries(metrics).map(([id,[name]]) => `<option value="${id}" ${skillRouterMetric === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
      ${plot || `<p role="status">${['recall','precision'].includes(skillRouterMetric) && calls.length ? `${label} unavailable: no reported judgments with a valid denominator for these calls.` : 'No observations for this route and corpus.'}</p>`}
      <p class="sr-inspector-note" title="Precision = relevant returned / returned. Recall = relevant returned / declared relevant, including declared misses. All-negative labels can yield Precision 0 but undefined Recall. Runtime excludes persistence/transport and is not encoder or stage-only latency.">Worker-wide timing · judged-pool Recall, not full-corpus Recall · missing labels are gaps.</p>`;
  return `<section id="sr-performance" class="sr-section" data-settings-panel="performance">
    ${skillRouterWorkflowHtml(view)}
    ${!selected ? '<p role="status" class="sr-inspector-note">Model retrieval is not enabled. Exact + BM25 remains available.</p>' : ''}
    ${skillRouterPerformanceError || data.learning_error || data.error ? `<p role="alert">${esc(skillRouterPerformanceError || data.learning_error || data.error)}</p>` : ''}
    ${skillRouterAdaptivePending !== undefined ? '<p role="status">Applying Adaptive Result Count...</p>' : ''}
    <section id="sr-inspector" class="sr-inspector" aria-labelledby="sr-inspector-title" data-stage="${skillRouterWorkflowStage}">
      <header class="sr-inspector-head"><h3 id="sr-inspector-title">${esc(stage.label)}</h3>
        ${models.length > 1 ? `<label>Context <select id="sr-calibration-context" aria-label="Calibration Route" onchange="skillRouterCalibrationContext=this.value;skillRouterRefreshPerformanceView()">${models.map(item => `<option value="${esc(item.context)}" ${item === model ? 'selected' : ''}>${esc(item.route)}</option>`).join('')}</select></label>` : `<span class="sr-inspector-note">${esc(model?.route || '')}</span>`}</header>
      <div class="sr-inspector-tabs" role="tablist" aria-label="Stage details" onkeydown="skillRouterInspectorKey(event)">
        ${skillRouterInspectorTabs.map(([id,name]) => `<button type="button" role="tab" id="sr-inspector-tab-${id}" aria-controls="sr-inspector-${id}" aria-selected="${skillRouterInspectorTab === id}" tabindex="${skillRouterInspectorTab === id ? 0 : -1}" onclick="skillRouterSetInspectorTab('${id}')">${name}</button>`).join('')}
      </div>
      <div id="sr-inspector-parameters" class="sr-inspector-panel" role="tabpanel" aria-labelledby="sr-inspector-tab-parameters" ${skillRouterInspectorTab !== 'parameters' ? 'hidden' : ''}>${facts(stage.facts)}</div>
      <div id="sr-inspector-controls" class="sr-inspector-panel" role="tabpanel" aria-labelledby="sr-inspector-tab-controls" ${skillRouterInspectorTab !== 'controls' ? 'hidden' : ''}>${controls}
        <div ${skillRouterWorkflowStage !== 'encoder' ? 'hidden' : ''}>${skillRouterSolutionsHtml()}<details class="sr-section"><summary>Connection & serving diagnostics</summary>${skillRouterModelReadiness(runtime)}</details></div>
      </div>
      <div id="sr-inspector-graphs" class="sr-inspector-panel" role="tabpanel" aria-labelledby="sr-inspector-tab-graphs" ${skillRouterInspectorTab !== 'graphs' ? 'hidden' : ''}>${graph}</div>
      <div id="sr-inspector-metrics" class="sr-inspector-panel" role="tabpanel" aria-labelledby="sr-inspector-tab-metrics" ${skillRouterInspectorTab !== 'metrics' ? 'hidden' : ''}>${metricBody}</div>
    </section></section>`;
}

function skillRouterRefreshPerformanceView() {
  const root = document.getElementById('sr-performance');
  if (!root) return;
  const focusId = root.contains(document.activeElement) ? document.activeElement.id : '';
  const focusTabIndex = focusId ? document.activeElement.getAttribute('tabindex') : null;
  const detailFocus = root.contains(document.activeElement) ? document.activeElement.dataset.routerDetail : '';
  const opened = [...root.querySelectorAll('.sr-hover.open > .sr-help')].map(button => button.dataset.routerDetail);
  const expanded = [...root.querySelectorAll('#sr-text-solutions details[open]')].map(element => element.querySelector('summary')?.textContent);
  const focused = document.activeElement;
  const modelFocus = !focusId && root.contains(focused) && focused.closest('#sr-text-solutions')
    ? { text:focused.textContent, packageId:focused.dataset.packageId } : null;
  const left = root.querySelector('.sr-workflow-viewport')?.scrollLeft || 0;
  const holder = document.createElement('div');
  holder.innerHTML = skillRouterPerformanceHtml();
  skillRouterCompactView(holder.firstElementChild);
  const replacement = holder.firstElementChild;
  root.replaceWith(replacement);
  for (const element of replacement.querySelectorAll('#sr-text-solutions details')) element.open = expanded.includes(element.querySelector('summary')?.textContent);
  replacement.querySelector('.sr-workflow-viewport').scrollLeft = left;
  if (focusId) {
    const focused = document.getElementById(focusId);
    if (focused && focusTabIndex !== null) focused.setAttribute('tabindex', focusTabIndex);
    focused?.focus({ preventScroll:true });
  }
  if (modelFocus) [...replacement.querySelectorAll('#sr-text-solutions button')].find(button =>
    button.textContent === modelFocus.text && button.dataset.packageId === modelFocus.packageId)?.focus({ preventScroll:true });
  for (const button of replacement.querySelectorAll('.sr-help')) {
    if (detailFocus === button.dataset.routerDetail) button.focus();
    if (opened.includes(button.dataset.routerDetail)) button.parentElement.dispatchEvent(new Event('pointerenter'));
  }
  applySettingsSubtab('router');
}

function skillRouterSetMetric(metric) {
  if (!['runtime','recall','precision','results'].includes(metric)) return;
  skillRouterMetric = metric;
  skillRouterRefreshPerformanceView();
}

function skillRouterPositionDetails(wrapper) {
  const panel = wrapper.querySelector('.sr-hover-panel');
  const button = wrapper.querySelector('.sr-help');
  skillRouterPositionPopover(panel, button);
}

function skillRouterPositionPopover(panel, button) {
  panel.style.width = `${Math.min(460, Math.max(0, innerWidth - 24))}px`;
  panel.style.maxHeight = `${Math.max(0, innerHeight - 24)}px`;
  const target = button.getBoundingClientRect();
  const bounds = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(12, Math.min(target.left, innerWidth - bounds.width - 12))}px`;
  panel.style.top = `${Math.max(12, Math.min(target.bottom + 6, innerHeight - bounds.height - 12))}px`;
}

function skillRouterPositionOpenDetails(event) {
  if (event.target?.closest?.('.sr-hover-panel')) return;
  document.querySelectorAll('.sr-hover.open').forEach(skillRouterPositionDetails);
  skillRouterHideWorkflowTip(true);
}
globalThis.addEventListener?.('resize', skillRouterPositionOpenDetails);
globalThis.addEventListener?.('scroll', skillRouterPositionOpenDetails, true);

function skillRouterAddDetails(anchor, label, nodes) {
  if (!anchor || !nodes.length) return;
  let wrapper = [...anchor.children].find(node => node.classList.contains('sr-hover'));
  if (!wrapper) {
    wrapper = document.createElement('span');
    wrapper.className = 'sr-hover';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sr-help';
    button.textContent = 'i';
    button.dataset.routerDetail = `${anchor.textContent.trim()} details`;
    button.setAttribute('aria-label', button.dataset.routerDetail);
    const panel = document.createElement('div');
    panel.className = 'sr-hover-panel';
    panel.id = `sr-hover-${++skillRouterHoverSequence}`;
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', button.dataset.routerDetail);
    button.setAttribute('aria-controls', panel.id);
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    wrapper.append(button, panel);
    anchor.appendChild(wrapper);
    let closeTimer;
    const close = () => {
      clearTimeout(closeTimer);
      panel.hidden = true;
      wrapper.classList.remove('open');
      button.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      clearTimeout(closeTimer);
      for (const other of document.querySelectorAll('.sr-hover.open')) {
        if (other === wrapper) continue;
        other.querySelector('.sr-hover-panel').hidden = true;
        other.querySelector('.sr-help').setAttribute('aria-expanded', 'false');
        other.classList.remove('open');
      }
      panel.hidden = false;
      wrapper.classList.add('open');
      button.setAttribute('aria-expanded', 'true');
      skillRouterPositionDetails(wrapper);
    };
    const leave = () => {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (!wrapper.matches(':hover') && !wrapper.contains(document.activeElement)) close();
      }, 150);
    };
    wrapper.addEventListener('pointerenter', open);
    wrapper.addEventListener('pointerleave', leave);
    wrapper.addEventListener('focusin', open);
    wrapper.addEventListener('focusout', leave);
    button.addEventListener('click', open);
    wrapper.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (panel.contains(document.activeElement)) button.focus();
      close();
    });
  }
  const panel = wrapper.querySelector('.sr-hover-panel');
  const heading = document.createElement('h4');
  heading.textContent = label;
  panel.append(heading, ...nodes);
}

function skillRouterCompactView(scope) {
  for (const details of scope.querySelectorAll('details[data-model-budget]')) {
    for (const actions of details.querySelectorAll(':scope > .sr-model-actions')) details.after(actions);
    const card = details.closest('.sr-model-card');
    const anchor = card?.querySelector('h4') || details.closest('.sr-section')?.querySelector('h3');
    skillRouterAddDetails(anchor, details.querySelector('summary').textContent,
      [...details.children].filter(node => node.tagName !== 'SUMMARY'));
    details.remove();
  }
  for (const details of scope.querySelectorAll('details.sr-section')) {
    const readiness = details.querySelector('#sr-model-readiness');
    if (!readiness) continue;
    const anchor = scope.querySelector('#sr-text-solutions h3');
    if (!anchor) continue;
    skillRouterAddDetails(anchor, details.querySelector('summary').textContent,
      [...details.children].filter(node => node.tagName !== 'SUMMARY'));
    details.remove();
  }
  const sections = [...scope.querySelectorAll('.sr-section')];
  if (scope.matches?.('.sr-section')) sections.unshift(scope);
  for (const section of sections) {
    if (section.closest('.sr-hover-panel')) continue;
    const anchor = section.querySelector(':scope > .sr-section-head h3, :scope > h3');
    const nodes = [...section.querySelectorAll(':scope > .sr-section-head > div > p, :scope > .sr-source-note, :scope > .sr-facts, :scope > .sr-boundary, :scope > p:not([role]):not(.sr-runtime-error), :scope > .sr-model-setup > p:not([role])')];
    skillRouterAddDetails(anchor, 'Details', nodes);
  }
  for (const row of scope.querySelectorAll('.sr-source-row, .sr-route-name')) {
    skillRouterAddDetails(row.querySelector('strong'), 'Source & routing', [...row.querySelectorAll('small')]);
  }
  for (const contract of scope.querySelectorAll('.sr-contract')) {
    skillRouterAddDetails(contract.querySelector('strong'), 'Fallback behavior',
      [...contract.children].filter(node => node.tagName === 'SPAN'));
  }
  const header = scope.querySelector('.sr-head');
  if (header) skillRouterAddDetails(header.querySelector('h2'), 'Router', [...header.querySelectorAll('p')]);
}

function renderSkillRouterLoading() {
  document.getElementById('detail').innerHTML = `<div class="sr-dashboard" data-settings-owner="router"><h2>Router</h2>${skillRouterNavigation()}<p role="status">Retrieving available Router status...</p></div>`;
  applySettingsSubtab('router');
}

function showSkillRouterTab() {
  if (skillRouterStatusCache) renderSkillRouterPane(skillRouterStatusCache); else renderSkillRouterLoading();
  if (!tabCacheIsFresh(skillRouterStatusUpdatedAt)) ask('skillRouterStatus', {}, null, true);
  ask('retrievalSolutions', {}, null, true);
}

function skillRouterSolutionBytes(value) {
  return Number.isFinite(value) ? `${(value / 1048576).toFixed(1)} MiB` : 'Not available';
}

function skillRouterSetupHtml(data) {
  const setup = data?.setup;
  if (!setup) return '';
  const archive = setup.source === 'archive';
  const steps = archive ? ['runtime','acquire','verify','configure','ready'] : ['runtime','acquire','verify','configure','index','ready'];
  const labels = archive ? ['Runtime','Import','Verify','Register','Imported']
    : ['Runtime', setup.source === 'huggingface' ? 'Download' : 'Import', 'Verify', 'Configure', 'Build index', 'Ready'];
  const failed = ['failed','cancelled'].includes(setup.phase);
  const phase = failed ? setup.failedPhase : setup.phase === 'index' && data.state === 'ready' && data.active_package_id === setup.packageId ? 'ready' : setup.phase;
  const blocked = phase === 'index' && data.state === 'blocked';
  const inactive = phase === 'index' && data.requested_package_id !== setup.packageId && data.active_package_id !== setup.packageId;
  const position = steps.indexOf(phase);
  return `<div class="sr-model-setup" role="status" aria-label="Model setup progress">
    <ol class="sr-setup-steps">${steps.map((step, index) => `<li data-step="${step}" class="${index < position ? 'complete' : index === position ? failed || blocked ? 'failed' : 'current' : ''}" ${index === position ? 'aria-current="step"' : ''}><span class="sr-setup-circle" aria-hidden="true"></span><span>${labels[index]}</span></li>`).join('')}</ol>
    ${setup.phase === 'acquire' && setup.source === 'huggingface' && setup.total > 0 ? `<div class="sr-download-progress"><progress aria-label="Model download" value="${Number(setup.current) || 0}" max="${Number(setup.total)}"></progress><span>${skillRouterSolutionBytes(setup.current)} / ${skillRouterSolutionBytes(setup.total)}</span></div>` : ''}
    ${setup.detail && !failed ? `<p role="status">${esc(setup.detail)}</p>` : ''}
    ${failed || blocked ? `<p role="alert">${esc(setup.error || data.error || 'Index preparation blocked. Check the model Python and retry explicitly.')}</p>` : ''}
    ${archive ? '<p>Imported only. Review the budget below, then choose Enable & build.</p>' : inactive ? '<p>Model is not enabled. Verified files remain available; choose Enable & build to activate it.</p>' : phase === 'index' ? `<p>Building local index${data.progress?.phase ? ': ' + esc(data.progress.phase) : ''}. Exact + BM25 remains available.</p>` : phase === 'ready' ? '<p>Embedding retrieval is ready for semantic / dual queries.</p>' : '<p>Preparation uses local CPU and storage. No knowledge text is sent to Hugging Face.</p>'}
  </div>`;
}

function skillRouterModelSetupOnProgress(setup) {
  skillRouterSolutionCache = { ...skillRouterSolutionCache, setup };
  if (state.tab === 'skillRouter') skillRouterRefreshSolutionsView();
}

function skillRouterSolutionsHtml() {
  const data = skillRouterSolutionCache;
  const preparing = ['queued','building'].includes(data?.state);
  const disabled = skillRouterSolutionPending ? 'disabled' : '';
  const cards = (data?.packages || []).map(item => {
    const requested = item.package_id === data.requested_package_id;
    const active = item.package_id === data.active_package_id;
    const resources = item.resources || {};
    return `<article class="sr-model-card"><h4>${esc(item.name)}</h4>
      <p class="sr-model-summary">${active ? 'Ready / active' : requested ? `Requested: ${esc(data.state)}` : 'Imported, not enabled'} · ${skillRouterSolutionBytes(item.bytes)}</p>
      ${item.error ? `<p role="alert">${esc(item.error)}</p>` : ''}
      <details data-model-budget="${esc(item.package_id)}"><summary>Preparation budget & source validation</summary>
        <p>${esc(item.architecture || 'Unknown architecture')} · ${esc(item.license || 'License not reported')}</p>
        <code class="sr-model-id">${esc(item.package_id)}</code>
        <p>Documents: ${esc(resources.document_count ?? 'Unknown')} · Units: ${esc(resources.unit_count ?? 'Unknown')}
          · Index estimate: ${skillRouterSolutionBytes(resources.index_bytes_estimate)}
          · Additional disk estimate: ${skillRouterSolutionBytes(resources.additional_disk_peak_bytes_estimate)}
          · Build RAM estimate: ${skillRouterSolutionBytes(resources.build_ram_bytes_estimate)}
          · Free disk: ${skillRouterSolutionBytes(resources.disk_free_bytes)}</p>
        <p>${esc(resources.caveat || '')} ${esc(resources.cpu_demand || '')}</p>
        <p>Content types: ${esc(JSON.stringify(resources.content_type_counts || {}))}</p>
        <p>Source validation (not a quality score for this local corpus): ${esc(JSON.stringify(item.validation || {}))}</p></details>
      <details class="sr-model-advanced"><summary>Model actions</summary><div class="sr-model-actions">
        ${!active ? `<button class="tbtn" data-package-id="${esc(item.package_id)}" onclick="skillRouterSolutionRequest('retrievalSolutionEnable',this.dataset.packageId)" ${disabled || (preparing || item.error ? 'disabled' : '')}>Enable & build</button>` : ''}
        <button class="tbtn" data-package-id="${esc(item.package_id)}" onclick="skillRouterSolutionRequest('retrievalSolutionRebuild',this.dataset.packageId)" ${disabled || (preparing || item.error ? 'disabled' : '')}>Rebuild</button>
        <button class="tbtn" data-package-id="${esc(item.package_id)}" onclick="skillRouterSolutionRequest('retrievalSolutionDelete',this.dataset.packageId)" ${disabled}>Delete</button>
      </div></details></article>`;
  }).join('');
  const progress = data?.progress;
  const observed = data?.observed || {};
  const setupError = data?.setup && (['failed','cancelled'].includes(data.setup.phase) || data.setup.phase === 'index' && data.state === 'blocked');
  return `<section class="sr-section" id="sr-text-solutions" data-settings-panel="performance"><h3>Embedding retrieval</h3>
    <p>Optional local model. Exact + BM25 works without it.</p>
    <div class="sr-model-actions sr-model-sources">
      <button class="tbtn primary" onclick="skillRouterSolutionRequest('retrievalModelDownload')" ${disabled}>Download from Hugging Face</button></div>
    <p role="status">One step: prepare PKM environment, download, verify, configure and build the index automatically.</p>
    <p class="sr-source-note">Multilingual E5 Small · about 470 MiB · MIT. CPU dependencies are installed in PKM's own environment, not system Python. Allow several GB of free disk.</p>
    ${skillRouterSetupHtml(data)}
    <details class="sr-model-advanced"><summary>Advanced model settings</summary>
    <div class="sr-model-actions">
      <button class="tbtn" onclick="skillRouterSolutionRequest('retrievalModelDirectory')" ${disabled}>Import model directory</button>
      <button class="tbtn" onclick="skillRouterSolutionRequest('retrievalSolutionImport')" ${disabled}>Import offline package</button></div>
    <p>Model runtime: <code class="sr-model-id">${esc(data?.modelRuntime?.python || 'Loading…')}</code>
      · ${data?.modelRuntime?.configured ? 'Model runtime configured; system Python unchanged' : 'PKM prepares the model environment during setup'}</p>
    <p>Inference thread budget: ${esc(data?.modelRuntime?.cpuThreads ?? 'Not reported')} (library setting, not an OS CPU quota).</p>
    <div class="sr-model-actions"><button class="tbtn" onclick="skillRouterSolutionRequest('retrievalSolutionRuntime')" ${disabled}>Choose model Python</button>
    </div>
    <div class="sr-model-actions">
      <button class="tbtn" onclick="skillRouterSolutionRequest('retrievalSolutions')">Refresh models</button>
      <button class="tbtn" onclick="skillRouterSolutionRequest('retrievalSolutionDisable')" ${disabled}>Disable model</button></div></details>
    ${skillRouterSolutionPending ? '<p role="status">Applying model configuration…</p>' : ''}
    ${data?.error && !setupError ? `<p role="alert" class="sr-runtime-error">${esc(data.error)}</p>` : ''}
    ${data ? `<p role="status">Current model: ${esc(data.state === 'disabled' || data.state === 'idle' ? 'Not enabled · Exact + BM25 is available' : data.state || 'unavailable')}${preparing && progress ? ` · ${esc(progress.phase)}` : ''}</p>` : '<p role="status">Loading model catalog…</p>'}
    ${progress && progress.total > 0 ? `<progress value="${Math.min(progress.current, progress.total)}" max="${progress.total}"></progress><span>${progress.current} / ${progress.total} units</span>` : ''}
    <details data-model-budget="diagnostics"><summary>Resource diagnostics</summary>
    ${observed.elapsed_seconds !== undefined ? `<p>Preparation: ${esc(observed.elapsed_seconds)}s · RSS ${skillRouterSolutionBytes(observed.rss_bytes)}
      · Sampled peak ${skillRouterSolutionBytes(observed.sampled_peak_rss_bytes)} · CPU cores ${esc(observed.cpu_core_equivalents ?? 'Unknown')}
      · Persistent index: ${skillRouterSolutionBytes(data.index?.bytes)}${data.index?.reused ? ' (reused)' : ''}</p>` : ''}
    ${data?.index?.embedding_cache_hits !== undefined ? `<p>Raw embedding cache: ${esc(data.index.embedding_cache_hits)} reused · ${esc(data.index.embedding_cache_misses)} newly encoded · ${skillRouterSolutionBytes(data.index.embedding_cache_bytes)}. Corpus-fitted indexes are still rebuilt and admitted for the current revision.</p>` : ''}
    </details>
    ${cards || (data && !data.error && !skillRouterSolutionPending ? '<p>No imported models.</p>' : '')}
  </section>`;
}

function skillRouterRefreshSolutionsView() {
  skillRouterRefreshPerformanceView();
}

function skillRouterSolutionsOnSnapshot(data) {
  skillRouterSolutionCache = { ...skillRouterSolutionCache, ...data,
    ...(Array.isArray(data?.packages) ? { learning:data.learning, learning_error:data.learning_error } : {}) };
  if (data?.runtimeStatus) {
    if (skillRouterStatusCache) skillRouterStatusCache.runtime = { ...skillRouterStatusCache.runtime, ...data.runtimeStatus };
    const readiness = document.getElementById('sr-model-readiness')?.closest('section');
    if (readiness) readiness.outerHTML = skillRouterModelReadiness(data.runtimeStatus);
    const paths = document.getElementById('sr-routing-paths');
    if (paths) {
      const holder = document.createElement('div');
      holder.innerHTML = skillRouterRoutingPathsHtml({ ...skillRouterStatusCache, runtime:data.runtimeStatus });
      const current = paths.querySelector('[data-sr-profile="model_based"] > td:last-child');
      const replacement = holder.querySelector('[data-sr-profile="model_based"] > td:last-child');
      if (current && replacement && current.innerHTML !== replacement.innerHTML) current.replaceWith(replacement);
    }
  }
  if (data?.actionCompleted && data.operationId === skillRouterSolutionPending) {
    skillRouterSolutionPending = '';
    skillRouterAdaptivePending = undefined;
    clearTimeout(skillRouterSolutionTimer);
  }
  if (state.tab === 'skillRouter') skillRouterRefreshSolutionsView();
}

function skillRouterSolutionRequest(command, packageId, enabled) {
  if (command !== 'retrievalSolutions') {
    if (skillRouterSolutionPending) return;
    if (command === 'retrievalAdaptiveCount') skillRouterAdaptivePending = enabled;
    skillRouterSolutionPending = `${Date.now()}-${++skillRouterSolutionSequence}`;
    skillRouterSolutionTimer = setTimeout(() => {
      skillRouterSolutionCache = { ...skillRouterSolutionCache,
        error:'Model operation has not completed and may still be running. Refresh models checks status; it does not cancel or retry the operation.' };
      if (state.tab === 'skillRouter') skillRouterRefreshSolutionsView();
    }, ['retrievalModelDownload','retrievalModelDirectory'].includes(command) ? 1800000 : 180000);
  }
  ask(command, { packageId, enabled, requestId: command === 'retrievalSolutions' ? undefined : skillRouterSolutionPending }, null, true);
  skillRouterRefreshSolutionsView();
}

function skillRouterOnStatus(data) {
  skillRouterStatusCache = data || {};
  skillRouterStatusUpdatedAt = Date.now();
  skillRouterSourceSaving = false;
  if (state.tab === 'skillRouter') renderSkillRouterPane(skillRouterStatusCache);
}

function skillRouterStatusBadge(label, tone) {
  return `<span class="sr-status sr-status-${tone}"><i></i>${esc(label)}</span>`;
}

function skillRouterRoutingPathsHtml(data) {
  const active = String(data?.activeProfile || 'l1_online');
  const runtime = data?.runtime || {};
  const solution = runtime.solution || {};
  const modelReady = runtime.semanticStatus === 'ready';
  const modelSelected = Boolean(solution.requested_package_id || solution.active_package_id)
    || runtime.semanticStatus === 'unavailable';
  const preparing = ['queued','building'].includes(solution.state);
  const modelState = modelReady ? 'Available' : preparing ? 'Preparing' : modelSelected ? 'Unavailable' : 'Not enabled';
  const rows = skillRouterBenchmarks.map(item => {
    const serving = item.profile === active;
    const route = data?.solutions?.[item.profile] || {};
    const toggle = route.externallyServed
      ? `<span class="sr-status sr-status-good"><i></i>Required fallback</span>`
      : route.available && route.mature
      ? `<label class="sr-solution-toggle"><input type="checkbox" data-sr-solution="${item.profile}" ${route.enabled ? 'checked' : ''} onchange="skillRouterToggleSolution('${item.profile}',this.checked)"><span>${route.enabled ? 'Enabled' : 'Disabled'}</span></label>`
      : skillRouterStatusBadge(item.state, 'neutral');
    return `<tr class="${serving ? 'selected' : ''}" data-sr-profile="${item.profile}"><td><span class="sr-route-name"><span><strong>${esc(item.name)}</strong><small>${esc(item.detail)}</small></span></span></td><td><div class="sr-solution-state">${serving ? skillRouterStatusBadge('Serving', 'good') : ''}${toggle}</div></td></tr>`;
  }).join('');
  return `<section class="sr-section" id="sr-routing-paths" data-settings-panel="sources performance">
    <div class="sr-contract current"><strong>Automatic fallback: ${active === 'l1_online' ? 'Exact + BM25 → Copilot default' : 'Copilot default'}.</strong><span>Model availability is separate from the default keyword route and does not mean it served every query.</span></div>
    <div class="sr-section-head"><div><h3>Routing paths</h3><p>Live retrieval availability. The benchmark below measures only Exact + BM25.</p></div><div><span>Default: <strong>${esc(active === 'l1_online' ? 'Exact + BM25' : 'Copilot default')}</strong></span></div></div>
    <div class="sr-table-wrap"><table class="sr-table"><thead><tr><th>Routing path</th><th>Status</th></tr></thead><tbody>${rows}
      <tr data-sr-profile="model_based"><td><span class="sr-route-name"><span><strong>Model-based retrieval · Semantic / Dual</strong><small>Optional local embeddings · explicit semantic / dual queries</small></span></span></td><td>${skillRouterStatusBadge(modelState, modelReady ? 'good' : modelSelected && !preparing ? 'warn' : 'neutral')}</td></tr>
    </tbody></table></div></section>`;
}

function skillRouterModelReadiness(runtime) {
  const solution = runtime.solution || {};
  const serving = runtime.skillServing || {};
  const modelSelected = Boolean(solution.requested_package_id || solution.active_package_id || serving.enabled)
    || runtime.semanticStatus === 'unavailable';
  return `<section class="sr-section" aria-labelledby="sr-model-readiness"><h3 id="sr-model-readiness">Explicit semantic / dual readiness</h3>
    <dl class="sr-facts"><div><dt>Semantic path</dt><dd>${esc(runtime.semanticStatus || 'Not reported')}</dd></div>
      <div><dt>Requested model package</dt><dd>${esc(solution.requested_package_id || 'None reported')}</dd></div>
      <div><dt>Active model package</dt><dd>${esc(solution.active_package_id || 'None reported')}</dd></div>
      <div><dt>Frozen Skill release</dt><dd>${serving.ready === true ? 'Ready' : serving.ready === false ? 'Not ready' : 'Not reported'}</dd></div></dl>
    ${solution.error ? `<p class="sr-runtime-error" role="alert">${esc(solution.error)}</p>` : ''}
    ${modelSelected && serving.error ? `<p class="sr-runtime-error" role="alert">${esc(serving.error)}</p>` : ''}
    <p class="sr-source-note">Worker readiness only proves the local index is available. It does not prove a model is loaded, admitted or serving this query.</p></section>`;
}

function skillRouterOrderedSources(data) {
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  const byId = new Map(sources.map(source => [String(source.id), source]));
  return (Array.isArray(data?.sourcePriority) ? data.sourcePriority : [])
    .map(id => byId.get(String(id))).filter(Boolean);
}

function skillRouterCommitSourcePriority(sourceIds) {
  if (!skillRouterStatusCache) return;
  skillRouterSourceSaving = true;
  skillRouterStatusCache = { ...skillRouterStatusCache, sourcePriority: sourceIds };
  renderSkillRouterPane(skillRouterStatusCache);
  ask('setSkillRouterSourcePriority', { sourceIds });
}

function skillRouterMoveSource(sourceId, direction) {
  const sourceIds = skillRouterOrderedSources(skillRouterStatusCache).map(source => String(source.id));
  const from = sourceIds.indexOf(String(sourceId));
  const to = from + Number(direction);
  if (from < 0 || to < 0 || to >= sourceIds.length) return;
  sourceIds.splice(to, 0, sourceIds.splice(from, 1)[0]);
  skillRouterCommitSourcePriority(sourceIds);
}

function skillRouterSourceDragStart(event) {
  skillRouterDraggedSourceId = String(event.currentTarget.dataset.sourceId || '');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', skillRouterDraggedSourceId);
  event.currentTarget.classList.add('dragging');
}

function skillRouterSourceDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.classList.add('drop-target');
}

function skillRouterSourceDragLeave(event) {
  event.currentTarget.classList.remove('drop-target');
}

function skillRouterSourceDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove('drop-target');
  const targetId = String(event.currentTarget.dataset.sourceId || '');
  const sourceId = String(event.dataTransfer.getData('text/plain') || skillRouterDraggedSourceId);
  const sourceIds = skillRouterOrderedSources(skillRouterStatusCache).map(source => String(source.id));
  const from = sourceIds.indexOf(sourceId);
  const to = sourceIds.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return;
  sourceIds.splice(to, 0, sourceIds.splice(from, 1)[0]);
  skillRouterCommitSourcePriority(sourceIds);
}

function skillRouterSourceDragEnd(event) {
  skillRouterDraggedSourceId = '';
  event.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.sr-source-row.drop-target').forEach(row => row.classList.remove('drop-target'));
}

function renderSkillRouterPane(data) {
  const runtime = data?.runtime || {};
  const corpus = data?.corpus || {};
  const collector = data?.collector || {};
  const benchmark = data?.benchmark || {};
  const orderedSources = skillRouterOrderedSources(data);
  const sourceRows = orderedSources.map((source, index) => `<article class="sr-source-row" draggable="true" data-source-id="${esc(source.id)}" ondragstart="skillRouterSourceDragStart(event)" ondragover="skillRouterSourceDragOver(event)" ondragleave="skillRouterSourceDragLeave(event)" ondrop="skillRouterSourceDrop(event)" ondragend="skillRouterSourceDragEnd(event)">
    <span class="sr-source-handle" aria-hidden="true">⋮⋮</span><span class="sr-source-rank">${index + 1}</span><span class="sr-source-copy"><strong>${esc(source.label)}</strong><small>${esc(source.detail || '')}</small></span><span class="sr-source-kind">${esc(source.kind || 'source')}</span>
    <span class="sr-source-actions"><button class="ibtn" data-source-id="${esc(source.id)}" onclick="skillRouterMoveSource(this.dataset.sourceId,-1)" ${index === 0 ? 'disabled' : ''} aria-label="Move source up">↑</button><button class="ibtn" data-source-id="${esc(source.id)}" onclick="skillRouterMoveSource(this.dataset.sourceId,1)" ${index === orderedSources.length - 1 ? 'disabled' : ''} aria-label="Move source down">↓</button></span>
  </article>`).join('');
  const metrics = benchmark.metrics;
  const measuredRow = metrics ? `<tr data-sr-profile="l1_online"><td><strong>Exact + BM25</strong><small> ${Number(metrics.judgedQueries)} labeled queries · ${Number(metrics.samples)} runs</small></td><td>${Math.round(Number(metrics.successRate) * 100)}%</td><td>${Math.round(Number(metrics.precisionAt5) * 100)}%</td><td>${Math.round(Number(metrics.ndcgAt5) * 100)}%</td><td title="p50 / p95">${Number(metrics.latencyMs.p50).toFixed(1)} / ${Number(metrics.latencyMs.p95).toFixed(1)} ms</td></tr>` : '<tr><td colspan="5">No measured run yet.</td></tr>';
  document.getElementById('detail').innerHTML = `<div class="sr-dashboard" data-settings-owner="router">
    <header class="sr-head"><div><h2>Router</h2><p>Control Skill source priority and inspect the implemented retrieval engine.</p></div><button class="tbtn" onclick="ask('skillRouterStatus',{})">Refresh</button></header>
    ${skillRouterNavigation()}
    ${skillRouterPerformanceHtml(runtime)}
    <section class="sr-section"><div class="sr-section-head"><div><h3>Skill source priority</h3><p>Drag sources into precedence order. Relevance admission still applies, and explicit or required Skills remain protected.</p></div>${skillRouterStatusBadge(skillRouterSourceSaving ? 'Saving…' : `${orderedSources.length} sources`, skillRouterSourceSaving ? 'warn' : 'good')}</div><div class="sr-source-list">${sourceRows || '<div class="empty">No Skill sources are available.</div>'}</div><p class="sr-source-note">PKM Personal and individual Subscribers are ranked here after relevance admission. Agent Native is selected by the active Agent host; its position is sent as a routing preference without inventing host candidates or scores.</p></section>
    ${skillRouterRoutingPathsHtml(data)}
    <section class="sr-section"><div class="sr-section-head"><div><h3>Routing path performance</h3><p>Synthetic labeled corpus, 1K documents. Each query has one judged relevant item; Precision@5 therefore caps at 20%. Not a live-corpus quality score.</p></div><button class="tbtn" onclick="ask('runSkillRouterBenchmark',{})" ${benchmark.running ? 'disabled' : ''}>${benchmark.running ? 'Measuring…' : 'Run benchmark'}</button></div>${benchmark.error ? `<p class="sr-runtime-error">Benchmark failed: ${esc(benchmark.error)}</p>` : ''}<div class="sr-table-wrap"><table class="sr-table"><thead><tr><th>Measured path</th><th>Success@5</th><th>Precision@5</th><th>NDCG@5</th><th>Latency p50 / p95</th></tr></thead><tbody>${measuredRow}</tbody></table></div>${benchmark.generatedAt ? `<p class="sr-source-note">Measured ${esc(benchmark.generatedAt)} · synthetic corpus · engine-matched report</p>` : ''}</section>
    <section class="sr-privacy-declaration" aria-labelledby="sr-privacy-title"><div class="sr-privacy-mark" aria-hidden="true">P</div><div>
      <h3 id="sr-privacy-title">Router Privacy Statement</h3>
      <p><strong>Scope &amp; Purpose.</strong> Updated 23 October 2026. This statement describes PKM Router search collection, local indexing, and retrieval learning. These records support retrieval observation and explicitly judged local calibration. It is not a general privacy policy for Chat providers, GitHub, Brokers, Portal peers, or other configured services.</p>
      <p><strong>Collector Data.</strong> Raw query and task text, workspace paths, file names, diagnostics, and loaded knowledge content are excluded from collector events. Search payloads include the tool name, duration, success state, result count, hashed result identities, and active routes. Skill-load events include content hashes, source/provider, and read-only status. Explicit Skill feedback emits outcome labels and counts, not observation or evidence text. Event envelopes also include timestamps, event/interaction IDs, a node ID (by default the hostname), and a collector session ID (by default containing hostname, process ID, and a random suffix). These identifiers and hashes are not anonymous and may permit correlation.</p>
      <p><strong>Recipients &amp; Transmission.</strong> MCP tools attempt to send these events to <code>http://127.0.0.1:8766/api/collector/events</code> by default. <code>PKM_COLLECTOR_URL</code> can redirect them to a remote receiver; <code>PKM_COLLECTOR_NODE_ID</code> and <code>PKM_COLLECTOR_SESSION_ID</code> can override identifiers. Loopback is on the machine running MCP, which may be a remote development host. A configured receiver and its operator control received copies, retention, access, and onward sharing; this page cannot verify or delete those copies. Default loopback transport uses HTTP, not encrypted HTTPS.</p>
      <p><strong>Local Storage &amp; Learning.</strong> Configured knowledge content is indexed by the local retrieval worker; an optional model adds a local model index. Explicit <code>skill_feedback</code> stores a task hash, used Skill identifiers, outcome, and supplied observations/evidence under <code>_feedback/skill-usage.jsonl</code>. That file has no automatic retention limit in this implementation. Retrieval learning separately stores up to 512 call receipts, timing/counts, salted source-identity hashes, complete relevance judgments represented by hashes/Recall, and context-specific scalar parameters in <code>retrieval-learning.sqlite3</code>; the chart shows at most 256 calls. It does not store query text or raw source IDs in that learning database. PKM does not train or modify embedding-model weights.</p>
      <p><strong>Controls &amp; Deletion.</strong> Model retrieval is optional. Turning off Adaptive Result Count disables truncation, not collector transmission, call-history recording, or explicit feedback processing, and does not erase prior records. There is currently no collector opt-out or history-erasure control on this page. For local-record removal, stop the relevant PKM/MCP processes before removing the applicable feedback file or learning database; removing the database also resets learned parameters. Copies in backups, shared storage, or a collector receiver require separate removal by their owner. Do not submit confidential information in feedback unless you intend it to be stored there.</p>
      <p><strong>Other Services.</strong> Content selected for Chat, Sync, sharing, or Portal may be sent to the services or peers you configure under their own permissions and privacy terms. The collector's text exclusions do not apply to those separate features. This statement does not establish a legal basis, jurisdiction-specific rights procedure, or a retention promise for third-party operators.</p>
      <p class="sr-privacy-proof"><strong>Review &amp; Questions.</strong> Source and issue reporting: <a href="https://github.com/qizhu8/personal-knowledge-vscode">github.com/qizhu8/personal-knowledge-vscode</a>. Do not post credentials or private content in public issues. Contact your configured receiver's operator for its data-handling terms.</p>
    </div></section>
    <section class="sr-section"><div class="sr-section-head"><div><h3>Search data collector</h3><p>Collects search-function outcomes, never search text.</p></div>${skillRouterStatusBadge('Query-free', 'good')}</div><ul class="sr-boundary"><li><b>Collected</b><span>Tool name, duration, success, result count, hashed result identities, and active routes.</span></li><li><b>PKM tools</b><span>${(collector.collectedTools || []).map(esc).join(' · ') || 'Not reported'}</span></li><li><b>Unavailable</b><span>VS Code built-in tool_search and grep_search do not expose invocation events to this extension.</span></li></ul></section>
    <div class="sr-lower-grid"><section class="sr-section"><div class="sr-section-head"><div><h3>Runtime</h3><p>Current local retrieval worker and indexed corpus.</p></div>${skillRouterStatusBadge(runtime.ready ? 'Ready' : 'Unavailable', runtime.ready ? 'good' : 'warn')}</div><dl class="sr-facts"><div><dt>Documents</dt><dd>${Number(corpus.documentCount || runtime.documentCount || 0).toLocaleString()}</dd></div><div><dt>Corpus revision</dt><dd><code>${esc(String(corpus.revision || runtime.corpusRevision || 'Not ready').slice(0, 12))}</code></dd></div><div><dt>Engine</dt><dd>${esc(runtime.engineVersion || 'Not running')}</dd></div><div><dt>Configuration</dt><dd><code>${esc(String(runtime.configurationHash || '').slice(0, 12) || 'Not available')}</code></dd></div></dl>${runtime.error ? `<p class="sr-runtime-error">${esc(runtime.error)}</p>` : ''}</section>
      <section class="sr-section"><div class="sr-section-head"><div><h3>Privacy boundary</h3><p>Current retrieval behavior.</p></div>${skillRouterStatusBadge('Local index', 'good')}</div><ul class="sr-boundary"><li><b>Index</b><span>PKM builds a local Exact + BM25 index over configured knowledge, plus a local model index only when enabled.</span></li><li><b>Collector</b><span>Task identity is hashed; only aggregate retrieval and outcome fields are emitted.</span></li><li><b>Training</b><span>Explicit relevance judgments train local scalar calibration and a score-gap threshold. Embedding-model weights remain frozen.</span></li></ul></section></div>
  </div>`;
  const root = document.querySelector('[data-settings-owner="router"]');
  root.querySelector('.sr-contract').dataset.settingsPanel = 'sources';
  root.querySelector('.sr-source-list').closest('section').dataset.settingsPanel = 'sources';
  root.querySelector('.sr-solution-state').closest('section').dataset.settingsPanel = 'sources';
  for (const table of root.querySelectorAll('.sr-table')) if (table.querySelector('th')?.textContent === 'Measured path') table.closest('section').dataset.settingsPanel = 'sources';
  root.querySelector('.sr-privacy-declaration').dataset.settingsPanel = 'privacy';
  root.querySelector('.sr-boundary').closest('section').dataset.settingsPanel = 'privacy';
  root.querySelector('.sr-lower-grid').dataset.settingsPanel = 'privacy';
  root.querySelector('.sr-lower-grid .sr-section:first-child').dataset.settingsPanel = 'privacy';
  root.querySelector('.sr-lower-grid .sr-section:last-child').dataset.settingsPanel = 'privacy';
  skillRouterCompactView(root);
  applySettingsSubtab('router');
}

function skillRouterToggleSolution(solution, enabled) {
  ask('setSkillRouterSolutionEnabled', { solution, enabled });
}
