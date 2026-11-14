const helpGuides = new Map();
const helpRequests = new Map();
let helpRequestId = 0;
let helpRenderGeneration = 0;
let helpPendingSection = null;
const helpSectionIndexes = Object.freeze({ start:0, tools:1, retrieval:2, agents:3, tasks:4, workers:5, memory:6, recipes:7, projects:8, sharing:9, snapshots:10, setup:11, troubleshooting:12 });
function helpLanguage() { return uiI18n.resolved === 'zh-hans' ? 'zh-hans' : 'en'; }
function helpText(english, chinese) { return helpLanguage() === 'zh-hans' ? chinese : english; }

function openHelpSection(section) {
  if (!Object.hasOwn(helpSectionIndexes, section)) {
    console.error('Unknown PKM Help section', section);
    helpStatus(helpText('This guide section is not available.', '这个帮助章节暂不可用。'));
    return;
  }
  helpPendingSection = helpSectionIndexes[section];
  document.querySelector('.tab[data-tab="help"]')?.click();
}
function problemGuideSection(tab = state.tab) {
  return ({ skills:'retrieval', notes:'tasks', papers:'tools', prompts:'tools', scripts:'tools', packages:'tools',
    environments:'tools', servers:'tools', skillRouter:'retrieval', mcp:'setup', subscriptions:'sharing',
    githubSync:'sharing', portalConnections:'sharing', chatroom:'projects', projects:'projects',
    agentSessions:'workers', agentSnapshots:'snapshots' })[tab] || 'troubleshooting';
}
function problemGuidanceHtml(message, nextStep, actions = '', section = problemGuideSection()) {
  if (!Object.hasOwn(helpSectionIndexes, section)) throw new Error('Invalid problem guide section');
  return `<aside class="pkm-problem-guidance" data-pkm-guidance><p role="alert">${esc(message)}</p><p class="pkm-problem-next">${esc(nextStep)}</p><div class="pkm-problem-actions">${actions}<button type="button" class="tbtn" onclick="openHelpSection('${section}')">${esc(helpText('View step-by-step guide', '查看分步指南'))}</button></div></aside>`;
}
function appendProblemGuide(container) {
  const next = document.createElement('span');
  next.className = 'pkm-problem-next';
  next.textContent = helpText('Inspect the current status and saved results before retrying. Do not repeat uncertain writes.', '重试前检查当前状态和已保存结果，不要重复结果不确定的写入。');
  const guide = document.createElement('button');
  guide.type = 'button'; guide.className = 'tbtn';
  guide.textContent = helpText('View troubleshooting steps', '查看排障步骤');
  const section = problemGuideSection();
  guide.addEventListener('click', () => openHelpSection(section));
  container.append(next, guide);
}
function showHelpTab(retry = false) {
  const language = helpLanguage();
  if (retry) helpGuides.delete(language);
  const cached = helpGuides.get(language);
  if (cached) { void renderHelpGuide(cached); return; }
  helpRenderGeneration++;
  document.getElementById('detail').innerHTML = `<section class="pkm-help" aria-label="Help"><p role="status">${esc(helpText('Loading the PKM user guide…', '正在加载 PKM 使用指南…'))}</p></section>`;
  const requestId = ++helpRequestId;
  helpRequests.set(language, requestId);
  ask('helpGuide', { language, requestId }, null, true);
}

function helpOnGuide(data) {
  if (data?.requestId !== undefined && data.requestId !== helpRequests.get(data.language)) return;
  if (data?.error) {
    if (state.tab !== 'help' || data.language !== helpLanguage()) return;
    helpRenderGeneration++;
    document.getElementById('detail').innerHTML = `<section class="pkm-help"><h1>Help</h1><p role="alert">${esc(data.error)}</p><button class="tbtn" onclick="showHelpTab(true)">${esc(helpText('Retry loading guide', '重新加载指南'))}</button></section>`;
    return;
  }
  if (!data || !['en','zh-hans'].includes(data.language) || typeof data.content !== 'string') {
    console.error('Invalid PKM Help guide response', data);
    helpOnGuide({ language:helpLanguage(), error:helpText('The Help response was invalid. Retry loading the guide.', '帮助内容响应无效，请重新加载指南。') });
    return;
  }
  helpGuides.set(data.language, data);
  if (state.tab === 'help' && data.language === helpLanguage()) void renderHelpGuide(data);
}

async function renderHelpGuide(data) {
  const generation = ++helpRenderGeneration;
  try {
    await loadMarkdownLibraries();
    if (state.tab !== 'help' || data.language !== helpLanguage() || generation !== helpRenderGeneration) return;
    if (typeof marked === 'undefined') throw new Error(helpText('The Markdown renderer did not load. Retry loading the guide.', 'Markdown 渲染器未加载，请重试。'));
    const rendered = marked.parse(data.content);
    const detail = document.getElementById('detail');
    detail.innerHTML = `<section class="pkm-help" aria-label="Help">
      <header class="pkm-help-header"><span class="codicon codicon-question" aria-hidden="true"></span><span>Help</span><small>${esc(helpText('A practical guide · no setup required to read', '实用指南 · 无需完成配置即可阅读'))}</small></header>
      ${!['en','zh-hans'].includes(uiI18n.resolved) ? '<p class="pkm-help-language">This guide is available in English and 简体中文. English is shown for your current UI language.</p>' : ''}
      <div class="pkm-help-layout"><nav class="pkm-help-toc" aria-label="${esc(helpText('Guide contents', '指南目录'))}"></nav><article class="pkm-help-content markdown-body" lang="${data.language}" dir="ltr">${rendered}</article></div>
      <p class="pkm-help-status" role="status" aria-live="polite"></p>
    </section>`;
    const article = detail.querySelector('.pkm-help-content');
    const toc = detail.querySelector('.pkm-help-toc');
    const title = document.createElement('strong');
    title.textContent = helpText('What do you want to do?', '你想完成什么？');
    toc.appendChild(title);
    article.querySelectorAll('h2').forEach((heading, index) => {
      heading.id = `pkm-help-section-${index}`;
      heading.tabIndex = -1;
      const link = document.createElement('a');
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent;
      toc.appendChild(link);
    });
    article.querySelectorAll('pre:has(code.language-agent)').forEach(pre => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tbtn pkm-help-copy';
      button.textContent = helpText('Copy Agent request', '复制给 Agent 的指令');
      button.addEventListener('click', () => { void copyHelpRequest(pre.querySelector('code').textContent); });
      pre.after(button);
    });
    detail.querySelector('.pkm-help').addEventListener('click', event => {
      const link = event.target.closest('a');
      if (!link) return;
      const href = link.getAttribute('href') || '';
      if (href.startsWith('#')) {
        event.preventDefault();
        event.stopPropagation();
        const heading = article.querySelector(`[id="${CSS.escape(href.slice(1))}"]`);
        heading?.scrollIntoView({ block:'start' });
        heading?.focus({ preventScroll:true });
      } else if (href.startsWith('pkm-help:')) {
        event.preventDefault();
        event.stopPropagation();
        openHelpDestination(href.slice('pkm-help:'.length));
      }
    });
    if (helpPendingSection !== null) {
      const heading = document.getElementById(`pkm-help-section-${helpPendingSection}`);
      if (!heading) throw new Error('The requested Help section is missing.');
      heading.scrollIntoView({ block:'start' });
      heading.focus({ preventScroll:true });
      helpPendingSection = null;
    }
  } catch (error) {
    console.error('PKM Help rendering failed', error);
    if (generation === helpRenderGeneration) helpOnGuide({ language:data.language, error:error.message || String(error) });
  }
}

function openHelpDestination(destination) {
  if (destination === 'chat') { ask('openApiChat', {}); return; }
  if (destination === 'setup') { openMcpSetup('python'); return; }
  if (!Object.values(workspaceSurfaces).some(tabs => tabs.includes(destination))) {
    console.error('Unknown PKM Help destination', destination);
    helpStatus(helpText('This guide link is not available.', '这个帮助链接暂不可用。'));
    return;
  }
  document.querySelector(`.tab[data-tab="${destination}"]`)?.click();
}

function helpStatus(text) {
  const status = document.querySelector('.pkm-help-status');
  if (status) status.textContent = text;
}
async function copyHelpRequest(text) {
  try {
    await navigator.clipboard.writeText(text);
    helpStatus(helpText('Copied. Paste into your chosen Agent chat; nothing has been executed.', '已复制。请粘贴到你选择的 Agent 聊天中；尚未执行任何操作。'));
  } catch (error) {
    console.error('PKM Help clipboard copy failed', error);
    helpStatus(helpText('Copy failed. Select the example text and copy it manually.', '复制失败，请选中示例文字手工复制。'));
  }
}
