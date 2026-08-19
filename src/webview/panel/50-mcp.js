// ── MCP wizard ────────────────────────────────────────────────────────────
function renderMcpLoading() {
  document.getElementById('detail').innerHTML = `<div style="padding:32px 36px;max-width:720px">
    <div style="color:var(--muted);font-size:12px">Checking MCP server status…</div>
  </div>`;
}

function updateGlobalMcpWarning(data) {
  const banner = document.getElementById('mcp-global-warning');
  const text = document.getElementById('mcp-global-warning-text');
  if (!banner || !text) return;
  if (data?.installed && data?.current) {
    banner.classList.add('hidden');
    text.textContent = '';
    return;
  }
  const installed = data?.installedVersion || 'missing';
  const expected = data?.expectedVersion || '?';
  text.textContent = data?.installed
    ? `PKM MCP server is outdated (installed v${installed}, expected v${expected}). Regenerate it and restart pkm.`
    : `PKM MCP server is missing (expected v${expected}). Create the managed runtime and generate the server.`;
  banner.classList.remove('hidden');
}

function openMcpSetup() {
  const button = document.querySelector('.tab[data-tab="mcp"]');
  if (button) button.dispatchEvent(new MouseEvent('click'));
  setTimeout(highlightMcpRegenerate, 250);
}

function highlightMcpRegenerate() {
  const button = document.getElementById('mcp-regenerate-server-code');
  if (!button) { ask('checkMcp', {}); setTimeout(highlightMcpRegenerate, 300); return; }
  button.scrollIntoView({ behavior: 'smooth', block: 'center' });
  button.classList.remove('mcp-regenerate-highlight');
  void button.offsetWidth;
  button.classList.add('mcp-regenerate-highlight');
  setTimeout(() => button.classList.remove('mcp-regenerate-highlight'), 6500);
}

function mcpVersionBadge(installed, current, installedVersion, expectedVersion) {
  if (!installed) return '<span style="font-size:11px;padding:2px 8px;border-radius:8px;background:var(--border);color:var(--muted)">○ Missing · expected v' + esc(expectedVersion || '?') + '</span>';
  if (current) return '<span style="font-size:11px;padding:2px 8px;border-radius:8px;background:#4ade8022;color:#4ade80">● Current · v' + esc(installedVersion) + '</span>';
  return '<span style="font-size:11px;padding:2px 8px;border-radius:8px;background:#f4b40022;color:#f4b400">● Outdated · ' + esc(installedVersion || 'unknown') + ' → v' + esc(expectedVersion || '?') + '</span>';
}

function mcpRegeneratePresentation(data) {
  const installed = data?.installedVersion || 'missing';
  const expected = data?.expectedVersion || '?';
  const knowledgeInstalled = data?.installedKnowledgeVersion || 'missing';
  const knowledgeExpected = data?.knowledgeVersion || '?';
  const chatInstalled = data?.installedChatVersion || 'missing';
  const chatExpected = data?.chatVersion || '?';
  const label = !data?.installed
    ? `Generate Server Code · target v${expected}`
    : data?.current
      ? `Regenerate Server Code · v${expected}`
      : `Regenerate Server Code · v${installed} → v${expected}`;
  const title = data?.current
    ? `Generated server is current: Unified v${expected}, Knowledge v${knowledgeExpected}, Chat v${chatExpected}.`
    : `Regenerate Unified v${installed} → v${expected}; Knowledge v${knowledgeInstalled} → v${knowledgeExpected}; Chat v${chatInstalled} → v${chatExpected}.`;
  return { label, title };
}

function pkmSkillStateBadge(target) {
  const labels = {
    missing: 'Missing', current: 'Current', outdated: 'Router Outdated',
    'content-outdated': 'Content Outdated', modified: 'Modified',
    conflict: 'Conflict', unavailable: 'Unavailable',
  };
  const good = target.state === 'current';
  const color = good ? '#4ade80' : target.state === 'missing' ? 'var(--muted)' : target.state === 'conflict' || target.state === 'unavailable' ? '#f87171' : '#f4b400';
  return `<span style="font-size:10px;color:${color}">${good ? '●' : '○'} ${esc(labels[target.state] || target.state)}${target.installedVersion ? ' · v' + esc(target.installedVersion) : ''}</span>`;
}

function renderPkmSkillTargets(data) {
  const skill = data?.pkmSkill;
  if (!skill) return '<div class="empty">Configure a PKM store before injecting the Skill Router.</div>';
  const rows = (skill.targets || []).map(target => {
    const update = ['missing','outdated','content-outdated','modified'].includes(target.state);
    const label = target.state === 'missing'
      ? `Inject PKM Skill · v${target.expectedVersion || skill.routerVersion}`
      : `Update PKM Skill · v${target.installedVersion || 'unknown'} → v${target.expectedVersion || skill.routerVersion}`;
    const action = update
      ? `<button class="tbtn" style="border-color:var(--accent)" onclick="ask('pkmSkillInject',{id:'${esc(target.id)}'})">${label}</button>`
      : '';
    const remove = target.managed
      ? `<button class="tbtn" onclick="ask('pkmSkillRemove',{id:'${esc(target.id)}'})">Remove</button>`
      : '';
    const removeTarget = target.kind === 'custom'
      ? `<button class="tbtn" onclick="ask('pkmSkillRemoveCustomTarget',{id:'${esc(target.id)}'})">Remove Target</button>`
      : '';
    return `<div class="pkm-skill-target">
      <div class="pkm-skill-target-main"><strong>${esc(target.label)}</strong>${pkmSkillStateBadge(target)}
        <div class="pkm-skill-path">${esc(target.skillPath)}</div><div class="pkm-skill-detail">${esc(target.detail || '')}</div></div>
      <div class="pkm-skill-target-actions">${action}${remove}${removeTarget}</div>
    </div>`;
  }).join('');
  const proposals = data?.skillProposals || [];
  return `<div class="pkm-config-section">
    <div class="pkm-config-heading"><div><strong>PKM Skill Router</strong><div class="pkm-skill-detail">Native discovery adapter · router v${esc(skill.routerVersion)} · requires MCP ≥ ${esc(skill.minimumMcpSchema)}</div></div>
      <div class="pkm-config-actions"><button class="tbtn" onclick="ask('pkmSkillBrowseCustomTarget',{})">Browse Directory</button><button class="tbtn" onclick="ask('pkmSkillEnterCustomTarget',{})">Enter Path</button></div></div>
    <div class="pkm-skill-source">Canonical source: <code>${esc(skill.sourcePath)}</code>${skill.sourceExists ? '' : ' · created on first Inject'}</div>
    <div class="pkm-skill-detail" style="margin-bottom:8px">Choose any Agent Skills root. PKM creates <code>&lt;root&gt;/pkm-skills/SKILL.md</code>. Windows drive, UNC, <code>%USERPROFILE%</code>, <code>~</code>, and environment-variable paths are supported on their matching host.</div>
    ${rows || '<div class="empty">No Agent targets configured.</div>'}
    <div class="pkm-skill-proposals"><span><strong>Skill Proposals</strong> · ${proposals.length} pending</span>
      <button class="tbtn" onclick="ask('pkmSkillOpenProposals',{})">Open Proposals Folder</button></div>
  </div>`;
}

function mcpDashboardState(data) {
  const skill = data?.pkmSkill;
  const targets = skill?.targets || [];
  const installedRouterVersions = [...new Set(targets.map(target => target.installedVersion).filter(Boolean))];
  const routerInstalled = installedRouterVersions.length ? installedRouterVersions.map(version => `v${version}`).join(', ') : 'Missing';
  const routerCurrent = targets.length > 0 && targets.every(target => target.state === 'current');
  const process = data?.mcpProcess || { running:false, available:false, detail:'Not checked' };
  const runtime = data?.mcpRuntime || {};
  const store = data?.store || {};
  return {
    process, runtime, store, skill, routerInstalled, routerCurrent,
    ready: !!store.valid && !!runtime.healthy && !!data?.current,
  };
}

function mcpStatusLight(kind, label) {
  return `<span class="mcp-status mcp-status-${kind}"><span class="mcp-status-dot"></span>${esc(label)}</span>`;
}
function mcpPathSizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  const units = ['B','KB','MB','GB','TB']; let value = bytes; let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index === 0 || value >= 100 ? 0 : 1)} ${units[index]}`;
}
function renderMcpPathSize(data) {
  const element = document.querySelector(`[data-mcp-path-size="${CSS.escape(String(data?.key || ''))}"]`);
  if (!element) return;
  element.textContent = data?.error ? data.error : mcpPathSizeText(Number(data?.bytes));
  element.title = data?.error ? data.error : `${Number(data?.bytes || 0).toLocaleString()} bytes`;
}
function refreshMcpPathSizes() {
  document.querySelectorAll('[data-mcp-path-size]').forEach(element => { element.textContent = 'Calculating…'; element.title = ''; });
  ask('refreshMcpPathSizes', {});
}

function renderMcpDashboard(data) {
  const status = mcpDashboardState(data);
  const paths = data?.paths || {};
  const processKind = status.process.running ? 'good' : status.ready ? 'warn' : 'bad';
  const processLabel = status.process.running ? `Running${status.process.pid ? ` · PID ${status.process.pid}` : ''}` : status.ready ? 'Ready · not detected' : 'Setup required';
  const rows = [
    ['Unified MCP Server', data?.installedVersion ? `v${data.installedVersion}` : 'Missing', `v${data?.expectedVersion || '?'}`, data?.current, `<button class="tbtn ${data?.current ? '' : 'mcp-regenerate-action'}" onclick="doGenerateMcp()" ${status.runtime.healthy ? '' : 'disabled'}>${data?.current ? 'Regenerate' : data?.installed ? 'Update' : 'Generate'}</button>`],
    ['Knowledge schema', data?.installedKnowledgeVersion ? `v${data.installedKnowledgeVersion}` : 'Missing', `v${data?.knowledgeVersion || '?'}`, data?.installedKnowledgeVersion === data?.knowledgeVersion, data?.installedKnowledgeVersion === data?.knowledgeVersion ? '<span class="mcp-no-action">No action</span>' : '<button class="tbtn mcp-regenerate-action" onclick="doGenerateMcp()">Update with Server</button>'],
    ['Chat schema', data?.installedChatVersion ? `v${data.installedChatVersion}` : 'Missing', `v${data?.chatVersion || '?'}`, data?.installedChatVersion === data?.chatVersion, data?.installedChatVersion === data?.chatVersion ? '<span class="mcp-no-action">No action</span>' : '<button class="tbtn mcp-regenerate-action" onclick="doGenerateMcp()">Update with Server</button>'],
    ['PKM Skill Router', status.routerInstalled, `v${status.skill?.routerVersion || '?'}`, status.routerCurrent, '<button class="tbtn" onclick="document.getElementById(\'pkm-skill-router-section\')?.scrollIntoView({behavior:\'smooth\'})">Review Targets</button>'],
  ];
  const setup = [
    [status.store.valid, 'Knowledge root', status.store.valid ? status.store.path : status.store.configured ? 'Configured path is unavailable; restart to enter recovery setup' : 'Restart to enter first-run setup', '<span class="mcp-no-action">Startup wizard</span>'],
    [!!data?.mcpPython?.valid, 'Python 3.10+', data?.mcpPython?.valid ? `${data.mcpPython.path} · ${data.mcpPython.version}` : 'Select and validate a Python executable', '<button class="tbtn" onclick="document.getElementById(\'mcp-python-path\')?.scrollIntoView({behavior:\'smooth\'})">Configure Python</button>'],
    [!!status.runtime.healthy, 'Managed runtime', status.runtime.healthy ? `${status.runtime.python} · healthy` : status.runtime.error || 'Create the dedicated virtual environment', `<button class="tbtn" onclick="ask('mcpRepairRuntime',{})" ${data?.mcpPython?.valid ? '' : 'disabled'}>${status.runtime.exists ? 'Repair Runtime' : 'Create Runtime'}</button>`],
    [!!data?.current, 'Generated server code', data?.current ? `Unified v${data.expectedVersion} is current` : 'Generate or update server.py, chat_server.py, and requirements.txt', data?.current ? '<span class="mcp-no-action">No action needed</span>' : `<button class="tbtn mcp-regenerate-action" onclick="doGenerateMcp()" ${status.runtime.healthy ? '' : 'disabled'}>${data?.installed ? 'Update Code' : 'Generate Code'}</button>`],
    [!!data?.nativeMcpProvider, 'Registration', data?.nativeMcpProvider ? 'VS Code provider is available; verify external Agency separately' : 'Register pkm in VS Code and any external Agency', '<button class="tbtn" onclick="document.getElementById(\'mcp-agency-registration\')?.scrollIntoView({behavior:\'smooth\'})">Registration Guide</button>'],
  ];
  return `<section class="mcp-dashboard">
    <div class="mcp-dashboard-head"><div><h2>PKM Integration Status</h2><p>Server runtime, generated schemas, and Agent Skill Router are versioned independently.</p></div><div class="mcp-running">${mcpStatusLight(processKind, processLabel)}<button class="tbtn" onclick="ask('checkMcp',{})" title="Refresh process and version status">↻</button></div></div>
    <div class="mcp-runtime-note">${esc(status.process.detail || '')}${!status.process.running && status.ready ? ' Stdio MCP servers start on demand; use MCP: List Servers to start pkm.' : ''}</div>
    <div class="mcp-version-table"><div class="mcp-version-row mcp-version-header"><span>Component</span><span>Installed</span><span>Target</span><span>Status</span><span>Action</span></div>${rows.map(row => `<div class="mcp-version-row"><strong>${row[0]}</strong><code>${esc(row[1])}</code><code>${esc(row[2])}</code>${mcpStatusLight(row[3] ? 'good' : 'warn', row[3] ? 'Current' : 'Update available')}<span class="mcp-row-action">${row[4]}</span></div>`).join('')}</div>
    <div class="mcp-paths"><div class="mcp-paths-head"><h3>Paths</h3><button class="tbtn" onclick="refreshMcpPathSizes()" title="Recalculate disk usage">↻ Refresh sizes</button></div>
      <div class="mcp-path-table-wrap"><table class="mcp-path-table"><colgroup><col class="mcp-path-type-col"><col><col class="mcp-path-size-col"><col class="mcp-path-source-col"></colgroup>
        <thead><tr><th>Path Type</th><th>Location</th><th>Disk Usage</th><th>Source</th></tr></thead>
        <tbody>
          <tr><td>Knowledge root</td><td><code title="${esc(paths.store || '')}">${esc(paths.store || 'Not configured')}</code></td><td data-mcp-path-size="store">Calculating…</td><td>read-only</td></tr>
          <tr><td>Environments root</td><td><code title="${esc(paths.environments || '')}">${esc(paths.environments || 'Not configured')}</code></td><td data-mcp-path-size="environments">Calculating…</td><td>read-only</td></tr>
          <tr><td>Managed MCP runtime</td><td><code title="${esc(paths.runtime || '')}">${esc(paths.runtime || 'Not created')}</code></td><td data-mcp-path-size="runtime">Calculating…</td><td>derived</td></tr>
          <tr><td>Runtime Python</td><td><code title="${esc(paths.python || '')}">${esc(paths.python || 'Not configured')}</code></td><td data-mcp-path-size="python">Calculating…</td><td>read-only</td></tr>
          <tr><td>MCP server directory</td><td><code title="${esc(paths.serverDirectory || '')}">${esc(paths.serverDirectory || 'Not generated')}</code></td><td data-mcp-path-size="serverDirectory">Calculating…</td><td>from Root</td></tr>
        </tbody>
      </table></div>
    </div>
    <div class="mcp-setup-guide"><h3>Setup guideline</h3><div class="mcp-setup-list">${setup.map((step, index) => `<div class="mcp-setup-step ${step[0] ? 'done' : 'needed'}"><span class="mcp-step-number">${step[0] ? '✓' : index + 1}</span><span><strong>${esc(step[1])}</strong><small>${esc(step[2])}</small></span><span class="mcp-row-action">${step[3]}</span></div>`).join('')}</div></div>
  </section>`;
}

function renderMcpPane(data) {
  const el = document.getElementById('detail');
  const installed = data?.installed;
  const serverPath = data?.serverPath ?? '';
  const python = data?.mcpPython || { path:'', version:'', valid:false, source:'none', error:'Python status unavailable.' };
  const runtime = data?.mcpRuntime || { path:'', python:'', exists:false, healthy:false, registered:false, error:'Managed runtime status unavailable.' };
  const regenerate = mcpRegeneratePresentation(data);
  el.innerHTML = `
    <div style="padding:28px 36px;max-width:980px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
        <span style="font-size:22px">⚡</span>
        <span style="font-size:17px;font-weight:700">Unified PKM MCP Server</span>
        <span id="mcp-version-badge">${mcpVersionBadge(installed, data?.current, data?.installedVersion, data?.expectedVersion)}</span>
        <span style="flex:1"></span>
        <label class="pkm-language-control"><span data-i18n="language.label">Language</span><select id="pkm-language-select" onchange="changeUiLanguage(this.value)" data-i18n-title="language.choose" title="${esc(t('language.choose'))}"><option value="auto" data-i18n="language.auto" ${uiI18n.setting === 'auto' ? 'selected' : ''}>${t('language.auto')}</option><option value="en" data-i18n="language.english" ${uiI18n.setting === 'en' ? 'selected' : ''}>${t('language.english')}</option><option value="zh-cn" data-i18n="language.chineseSimplified" ${uiI18n.setting === 'zh-cn' ? 'selected' : ''}>${t('language.chineseSimplified')}</option><option value="es" data-i18n="language.spanish" ${uiI18n.setting === 'es' ? 'selected' : ''}>${t('language.spanish')}</option></select></label>
      </div>
      <p style="color:var(--muted);font-size:12px;margin-bottom:14px;line-height:1.6">
        Configure the external runtimes and Agent integrations used by Personal Knowledge Manager.
      </p>
      ${renderMcpDashboard(data)}
      <div id="pkm-skill-router-section">${renderPkmSkillTargets(data)}</div>
      <div style="background:var(--panel);border:1px solid ${data?.nativeMcpProvider ? '#4ade8066' : '#f4b40066'};border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:11px;line-height:1.6;color:var(--muted)">
        ${data?.nativeMcpProvider
          ? '<strong style="color:#4ade80">Available in every workspace.</strong> The extension registers <code>pkm</code> directly with VS Code; no project <code>.vscode/mcp.json</code> is needed. Remove old workspace <code>pkm</code>, <code>pkm-chat</code>, and <code>pkm-chat-live</code> entries to avoid duplicates.'
          : '<strong style="color:#f4b400">User configuration fallback.</strong> This VS Code version cannot accept extension-provided MCP definitions. Add the generated <code>pkm</code> entry once with <strong>MCP: Open User Configuration</strong>.'}
      </div>
      <div style="background:var(--panel);border:1px solid ${python.valid ? '#4ade8066' : '#f4b40066'};border-radius:8px;padding:12px 14px;margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <strong style="font-size:13px">Python executable</strong>
          <span style="font-size:10px;color:${python.valid ? '#4ade80' : '#f4b400'}">${python.valid ? '● Valid · Python ' + esc(python.version) : '● Required · Python 3.10+'}</span>
          <span style="flex:1"></span><span style="font-size:10px;color:var(--muted)">${esc(python.source || 'none')}</span>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <input id="mcp-python-path" value="${esc(python.path || '')}" placeholder="Absolute path to Python 3.10+" style="flex:1;background:var(--input);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px 8px;font-size:11px">
          <button class="tbtn" id="mcp-python-scan-btn" onclick="ask('mcpDetectPython',{})">List Pythons</button>
          <button class="tbtn" onclick="ask('mcpBrowsePython',{})">Browse…</button>
          <button class="tbtn" style="border-color:var(--accent)" onclick="saveMcpPython()">Validate &amp; Save</button>
        </div>
        <select id="mcp-python-candidates" class="hidden" onchange="selectMcpPythonCandidate(this)" style="width:100%;margin-top:7px;background:var(--input);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px 8px;font-size:11px"></select>
        <div id="mcp-python-scan" class="hidden" style="margin-top:7px">
          <div style="display:flex;align-items:center;gap:8px;font-size:10px;color:var(--muted)"><span id="mcp-python-scan-text">Scanning…</span><span style="flex:1"></span><button class="tbtn" style="font-size:9px;padding:1px 6px" onclick="ask('mcpCancelPythonScan',{})">Cancel</button></div>
          <div style="height:3px;background:var(--border);border-radius:3px;overflow:hidden;margin-top:4px"><div class="mcp-scan-bar" style="height:100%;width:35%;background:var(--accent);border-radius:3px;animation:mcpScanMove 1.1s infinite ease-in-out"></div></div>
        </div>
        <div id="mcp-python-status" style="font-size:11px;color:${python.valid ? 'var(--muted)' : '#f4b400'};margin-top:6px">${esc(python.valid ? 'This machine-specific interpreter will be used for PKM MCP configuration.' : python.error || 'Select or install Python first. PKM itself remains available.')}</div>
      </div>
      <div style="background:var(--panel);border:1px solid ${runtime.healthy ? '#4ade8066' : '#f4b40066'};border-radius:8px;padding:12px 14px;margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:8px">
          <strong style="font-size:13px">Managed PKM MCP runtime</strong>
          <span style="font-size:10px;color:${runtime.healthy ? '#4ade80' : '#f4b400'}">${runtime.healthy ? '● Healthy' : runtime.exists ? '● Broken' : '○ Missing'}</span>
          <span style="flex:1"></span>
          <button class="tbtn" onclick="ask('mcpRepairRuntime',{})" ${python.valid ? '' : 'disabled'}>${runtime.exists ? 'Repair / Reinstall' : 'Create Runtime'}</button>
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:6px;overflow-wrap:anywhere">${esc(runtime.python || runtime.path || '')}${runtime.version ? ' · Python ' + esc(runtime.version) : ''} · ${runtime.registered ? 'Registered in PKM Envs' : 'Not registered'}</div>
        <div id="mcp-runtime-status" style="font-size:11px;color:${runtime.healthy ? 'var(--muted)' : '#f4b400'};margin-top:5px">${esc(runtime.healthy ? 'The unified pkm server uses this dedicated environment.' : runtime.error || 'Create the runtime before generating MCP configuration.')}</div>
      </div>
      <div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:var(--muted);line-height:1.7">
        <div style="font-weight:600;color:var(--text);margin-bottom:6px">Why run this?</div>
        Without MCP you copy-paste context into every chat, and whatever the AI learns is lost when the session ends.
        With it, your assistant can:
        <ul style="margin:6px 0 0 16px;padding:0">
          <li><strong>Search &amp; read</strong> your skills, notes, and scripts — so it answers with <em>your</em> conventions and past solutions.</li>
          <li><strong>Write back</strong> new learnings (<code>add_note</code>, <code>update_skill</code>…) — turning your store into a durable memory that grows across sessions.</li>
          <li><strong>Join Chatrooms</strong> through <code>chat_join</code>, <code>chat_standby</code>, and the other <code>chat_*</code> tools exposed by the same <code>pkm</code> server.</li>
          <li><strong>Stay in sync</strong> — it reads the same store this extension writes, and every change is git-tracked.</li>
        </ul>
      </div>

      ${installed ? `
        <div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:16px">
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Server location</div>
          <code style="font-size:11px;color:var(--accent)">${esc(serverPath)}</code>
          <div id="mcp-schema-versions" style="font-size:10px;color:var(--muted);margin-top:6px">Unified: installed v${esc(data?.installedVersion || 'unknown')} → target v${esc(data?.expectedVersion || '?')}<br>Knowledge: installed v${esc(data?.installedKnowledgeVersion || 'unknown')} → target v${esc(data?.knowledgeVersion || '?')}<br>Chat: installed v${esc(data?.installedChatVersion || 'unknown')} → target v${esc(data?.chatVersion || '?')}</div>
        </div>
        <div style="font-size:13px;font-weight:600;margin-bottom:10px">VS Code MCP definition</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px">
          <strong>Current machine preview.</strong>
          ${data?.nativeMcpProvider ? 'The extension provides this definition automatically in every workspace.' : 'Merge this entry once into <strong>MCP: Open User Configuration</strong>, preserving other servers.'}
          The command always uses the managed runtime's absolute Python path:
        </div>
        <pre style="background:var(--vscode-textCodeBlock-background);border-radius:6px;padding:12px;font-size:11px;overflow-x:auto"><code id="mcp-cfg-code"></code></pre>
        <button class="tbtn" style="margin-top:8px;font-size:11px" onclick="copyCfg()">Copy config snippet</button>
        <hr class="div" style="margin:18px 0">
        <div style="font-size:12px;color:var(--muted);margin:10px 0 4px">Run <strong>MCP: List Servers</strong> → <strong>pkm</strong> → Start/Restart. Remote SSH windows receive the provider from the remote extension host and use remote paths.</div>
        <hr class="div" style="margin:18px 0">
        <button class="tbtn ${data?.current ? '' : 'mcp-regenerate-action mcp-regenerate-highlight'}" id="mcp-regenerate-server-code" title="${esc(regenerate.title)}" onclick="doGenerateMcp()" ${runtime.healthy ? '' : 'disabled'}>↺ ${esc(regenerate.label)}</button>
      ` : `
        <div style="border:1px solid var(--border);border-radius:8px;padding:16px 18px;margin-bottom:16px">
          <div style="font-size:13px;font-weight:600;margin-bottom:8px">Setup steps</div>
          <div style="font-size:12px;color:var(--muted);line-height:1.8">
            1. Click <strong>Generate Server</strong> — creates <code style="font-size:11px">${esc(serverPath || '~/personal-knowledge/mcp-server/server.py')}</code><br>
            2. Install dependencies: <code style="font-size:11px">pip install fastmcp websockets</code><br>
            3. The extension publishes <code>pkm</code> to every workspace automatically<br>
            4. Use <strong>MCP: List Servers</strong> to start it
          </div>
        </div>
        <button class="tbtn mcp-regenerate-action mcp-regenerate-highlight" id="mcp-regenerate-server-code" title="${esc(regenerate.title)}" style="padding:6px 18px;font-size:13px" onclick="doGenerateMcp()" ${runtime.healthy ? '' : 'disabled'}>
          ✦ ${esc(regenerate.label)}
        </button>
      `}
      <div id="mcp-result" style="margin-top:12px;font-size:12px"></div>

      <hr class="div" style="margin:24px 0">
      <div id="mcp-agency-registration" style="font-size:14px;font-weight:700;margin-bottom:6px">MCP Agency registration</div>
      <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:8px">
        The extension cannot reliably inspect an external Agency registry. If <code>pkm</code> is not registered there, copy these current-machine instructions into Copilot or Agency. The managed runtime, PKM store, server, and
        requirements paths are already resolved; the agent should register the single <code>pkm</code> entry and verify its unified tool surface.
      </div>
      <pre style="background:var(--vscode-textCodeBlock-background);border-radius:6px;padding:12px;font-size:11px;overflow:auto;max-height:340px"><code id="agency-install-code">${esc(data?.agencyInstallInstruction || '')}</code></pre>
      <button class="tbtn" style="margin-top:8px;border-color:var(--accent)" onclick="copyAgencyInstall()">Copy Agency installation instructions</button>
    </div>`;

  if (installed && runtime.healthy) {
    // Populate config snippet async after render
    ask('generateMcp', { previewOnly: true });
  }
}

function renderMcpGenerated(data) {
  // Store config snippet for copying
  window._mcpCfg = data.configSnippet || '';
  const codeEl = document.getElementById('mcp-cfg-code');
  if (codeEl) codeEl.textContent = data.configSnippet || '';
  // A preview call only fills the config block — do NOT re-render (would loop)
  if (data.preview) return;
  const el = document.getElementById('mcp-result');
  if (el) {
    const base = String(data.serverPath || '').replace(/[\\/]server\.py$/, '');
    el.innerHTML = `<div style="color:#4ade80">✓ Unified MCP code regenerated:</div>` +
      `<div style="margin-top:4px;color:var(--muted)"><code>${esc(data.serverPath)}</code><br><code>${esc(base + '/chat_server.py')}</code><br><code>${esc(base + '/requirements.txt')}</code></div>` +
      `<div style="margin-top:7px;color:var(--muted)">No Agency registry was modified. If <code>pkm</code> is not registered in your MCP Agency, copy the installation instructions below into Copilot or Agency.</div>`;
  }
  // Real generation: refresh the pane once to show the installed state
  setTimeout(() => ask('checkMcp', {}), 300);
}

function renderMcpPythonResult(data) {
  const input = document.getElementById('mcp-python-path');
  const status = document.getElementById('mcp-python-status');
  if (input && data?.path) input.value = data.path;
  if (status) {
    status.style.color = data?.valid ? '#4ade80' : '#f87171';
    status.textContent = data?.valid ? `✓ Python ${data.version} validated${data.saved ? ' and saved' : '. Click Validate & Save to use it.'}` : `✕ ${data?.error || 'Invalid Python executable.'}`;
  }
  if (data?.saved) setTimeout(() => ask('checkMcp', {}), 200);
}

function renderMcpPythonCandidates(data) {
  const select = document.getElementById('mcp-python-candidates');
  const status = document.getElementById('mcp-python-status');
  const candidates = data?.candidates || [];
  if (!select) return;
  select.replaceChildren();
  select.appendChild(new Option(candidates.length ? 'Select a Python 3.10+ runtime…' : 'No usable Python 3.10+ runtimes found', ''));
  candidates.forEach(candidate => select.appendChild(new Option(`Python ${candidate.version} · ${candidate.label} · ${candidate.path}`, candidate.path)));
  select.classList.remove('hidden');
  if (status) { status.style.color = candidates.length ? 'var(--muted)' : '#f87171'; status.textContent = candidates.length ? `${candidates.length} usable runtime(s) found. Pick one, then Validate & Save.` : 'No usable Python 3.10+ runtime found. Install Python or Browse to an executable.'; }
}

function startMcpPythonScan(data) {
  window._mcpPythonCandidates = new Map();
  const select = document.getElementById('mcp-python-candidates');
  if (select) { select.replaceChildren(new Option('Scanning for Python 3.10+…', '')); select.classList.remove('hidden'); }
  const scan = document.getElementById('mcp-python-scan'); if (scan) scan.classList.remove('hidden');
  const text = document.getElementById('mcp-python-scan-text'); if (text) text.textContent = data?.text || 'Scanning…';
  const button = document.getElementById('mcp-python-scan-btn'); if (button) button.disabled = true;
}

function appendMcpPythonCandidate(data) {
  const candidate = data?.candidate; if (!candidate?.path) return;
  if (!window._mcpPythonCandidates) window._mcpPythonCandidates = new Map();
  if (window._mcpPythonCandidates.has(candidate.path)) return;
  window._mcpPythonCandidates.set(candidate.path, candidate);
  const select = document.getElementById('mcp-python-candidates');
  if (select) {
    if (select.options.length === 1 && !select.options[0].value) select.options[0].textContent = 'Select a Python 3.10+ runtime…';
    select.appendChild(new Option(`Python ${candidate.version} · ${candidate.label} · ${candidate.path}`, candidate.path));
  }
  updateMcpPythonScan({ text: `Scanning… ${data.count || window._mcpPythonCandidates.size} found` });
}

function updateMcpPythonScan(data) { const text = document.getElementById('mcp-python-scan-text'); if (text) text.textContent = data?.text || 'Scanning…'; }
function finishMcpPythonScan(data) {
  const scan = document.getElementById('mcp-python-scan'); if (scan) scan.classList.add('hidden');
  const button = document.getElementById('mcp-python-scan-btn'); if (button) button.disabled = false;
  const status = document.getElementById('mcp-python-status'); if (status) { status.style.color = data?.count ? 'var(--muted)' : data?.cancelled ? 'var(--muted)' : '#f87171'; status.textContent = data?.text || 'Scan complete.'; }
}

function selectMcpPythonCandidate(select) {
  if (!select.value) return;
  const input = document.getElementById('mcp-python-path');
  if (input) input.value = select.value;
  const status = document.getElementById('mcp-python-status');
  if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Candidate selected. Click Validate & Save to recreate the managed runtime with this Python.'; }
}

function renderMcpRuntimeProgress(data) {
  const status = document.getElementById('mcp-runtime-status');
  if (!status) return;
  status.style.color = '#f4b400';
  status.textContent = data?.text || 'Working…';
}

function renderMcpRuntimeResult(data) {
  const status = document.getElementById('mcp-runtime-status');
  if (data?.ok) { if (status) { status.style.color = '#4ade80'; status.textContent = '✓ Managed runtime is healthy and registered in PKM Envs.'; } setTimeout(() => ask('checkMcp', {}), 200); return; }
  if (!status) return;
  const commands = data?.commands || [];
  window._mcpManualCommands = commands.join('\n');
  status.style.color = '#f87171';
  status.innerHTML = `✕ ${esc(data?.error || 'Managed runtime setup failed.')}` + (commands.length
    ? `<pre style="white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:5px;margin-top:7px;color:var(--text)">${esc(commands.join('\n'))}</pre><button class="tbtn" style="margin-top:5px" onclick="navigator.clipboard.writeText(window._mcpManualCommands || '')">Copy manual commands</button>`
    : '');
}

function saveMcpPython() {
  const path = document.getElementById('mcp-python-path')?.value.trim() || '';
  ask('mcpSetPython', { path });
}

function doGenerateMcp() {
  const el = document.getElementById('mcp-result');
  if (el) el.innerHTML = '<span style="color:var(--muted)">Generating…</span>';
  ask('generateMcp', {});
}

function copyCfg() {
  navigator.clipboard.writeText(window._mcpCfg || '').then(() =>
    vscode.window.setStatusBarMessage?.('Copied!'));
}

function copyAgencyInstall() {
  const text = document.getElementById('agency-install-code')?.textContent || '';
  navigator.clipboard.writeText(text).then(() => vscode.window.setStatusBarMessage?.('Copied!'));
}

