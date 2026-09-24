#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const panelJs = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
const panelCss = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.css"), "utf8");
const sourceTs = fs.readFileSync(path.join(__dirname, "..", "src", "mcp.ts"), "utf8");
const extensionTs = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
const sourcePanelCss = fs.readFileSync(path.join(__dirname, "..", "src", "webview", "panel.css"), "utf8");
assert.match(sourcePanelCss, /\.srv-global-controls select,\.srv-edit input,\.mcp-setup-step select,\.mcp-setup-step input\{[^}]*background:var\(--input\)[^}]*color:var\(--text\)[^}]*color-scheme:dark/,
  "Settings hostname, IP, and port controls must use the dark themed input surface");
assert.match(extensionTs, /function maintainPkmIntegration\(context: vscode\.ExtensionContext\)/);
assert.match(extensionTs, /server\.newerThanExpected \|\| newerRouters\.length[\s\S]{0,900}This window will not downgrade shared PKM files/,
  "an older window must stop maintenance and recommend a manual Reload Window");
assert.doesNotMatch(extensionTs, /executeCommand\([^\n]*(reloadWindow|reload)/i,
  "PKM must never reload the user's window automatically");
assert.match(sourceTs, /Refusing to replace newer PKM MCP server/,
  "the generated server write boundary must reject downgrades");
assert.match(panelJs, /data\?\.current \|\| data\?\.newerThanExpected/,
  "a newer shared server must remain usable in an older window");
assert.match(panelJs, /data\?\.newerThanExpected \? 'Newer installed'/,
  "Config must describe a newer shared server without requesting downgrade");
assert.match(extensionTs, /if \(!runtime\.healthy\)[\s\S]{0,500}await ensureMcpRuntime\(context\)/,
  "automatic maintenance must create or repair the managed runtime");
assert.match(extensionTs, /else if \(!server\.current\)[\s\S]{0,500}generateMcpServer\(context\)/,
  "automatic maintenance must regenerate stale server code");
assert.match(extensionTs, /target\.managed[\s\S]{0,180}target\.state === "outdated"[\s\S]{0,700}injectPkmSkill\(context, staleManaged\[index\]\.id\)/,
  "automatic maintenance must update existing managed Skill projections");
assert.doesNotMatch(extensionTs, /void offerMcpRuntimeDependencyRepair\(context\)/);
assert.doesNotMatch(extensionTs, /void offerMcpServerRegeneration\(context\)/);
assert.match(extensionTs, /await ensureMcpRuntime\(context\)/);
assert.match(extensionTs, /case "generateMcp"[\s\S]{0,500}!mcpRuntimeStatus\(\)\.healthy[\s\S]{0,350}await ensureMcpRuntime\(context\)/,
  "Update with Server must automatically repair missing managed dependencies");
assert.doesNotMatch(extensionTs, /Managed PKM MCP runtime is not healthy\. Create or Repair it first/);
assert.match(sourceTs, /await pipInstall\(\["-r", requirements\]\)/);
assert.match(sourceTs, /promptManagerDownloadFailure/);
assert.match(sourceTs, /--no-deps", wheel/);
assert.match(sourceTs, /PROMPT_MANAGER_WHEEL_SHA256/);
assert.match(sourceTs, /RETRIEVAL_ENGINE_WHEEL_SHA256/);
assert.match(sourceTs, /import fastmcp, prompt_manager, websockets, adaptive_skill_retrieval/);
assert.match(sourceTs, /def search_knowledge\(/);
assert.match(sourceTs, /def retrieval_status\(/);
assert.match(sourceTs, /_collector_post\("search_invocation"/);
assert.match(sourceTs, /"tool_name": tool_name/);
assert.match(sourceTs, /"model_based_routing_enabled": False/);
assert.doesNotMatch(sourceTs, /adaptive_candidate = _retrieval_request/);
assert.doesNotMatch(sourceTs, /_collector_post\("retrieval"/);
assert.match(extensionTs, /extensionVersion: String\(chatCtx\?\.extension\?\.packageJSON\?\.version \|\| "unknown"\)/);
assert.match(extensionTs, /skillRouters: \[[\s\S]{0,600}name: "Exact"[\s\S]{0,300}name: "BM25"/);
const esc = value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
assert.match(panelCss, /\.mcp-version-table \.mcp-row-action\{text-align:left;/);
assert.match(panelCss, /\.mcp-setup-step select,\.mcp-setup-step input\{[^}]*background:var\(--input\)[^}]*color:var\(--text\)[^}]*color-scheme:dark/, "MCP hostname and port controls share the dark input contract");

const presentation = panelJs.match(/function mcpRegeneratePresentation\(data\)\s*\{[\s\S]*?\n\}/);
assert(presentation, "MCP regenerate presentation helper must be bundled");
const presentationContext = { esc };
vm.createContext(presentationContext);
new vm.Script(`${presentation[0]}; this.present = mcpRegeneratePresentation;`).runInContext(presentationContext);

const outdated = presentationContext.present({
  installed: true, current: false, installedVersion: "2.4.0", expectedVersion: "2.5.5",
  installedKnowledgeVersion: "1.0.0", knowledgeVersion: "1.0.0",
  installedChatVersion: "2.3.0", chatVersion: "2.3.1",
  installedRecipeVersion: "1.0.0", recipeVersion: "1.1.0",
  installedAgentSessionVersion: "1.0.0", agentSessionVersion: "1.1.0",
});
assert.strictEqual(outdated.label, "Regenerate Server Code · v2.4.0 → v2.5.5");
assert.match(outdated.title, /Unified v2\.4\.0 → v2\.5\.5/);
assert.match(outdated.title, /Chat v2\.3\.0 → v2\.3\.1/);
assert.match(outdated.title, /Recipes v1\.0\.0 → v1\.1\.0/);
assert.match(outdated.title, /Agent Sessions v1\.0\.0 → v1\.1\.0/);
assert.strictEqual(presentationContext.present({ installed: true, current: true, expectedVersion: "2.5.5", knowledgeVersion: "1.0.0", chatVersion: "2.3.1" }).label,
  "Regenerate Server Code · v2.5.5");
assert.strictEqual(presentationContext.present({ installed: false, expectedVersion: "2.5.5" }).label,
  "Generate Server Code · target v2.5.5");

const skillStart = panelJs.indexOf("function pkmSkillStateBadge");
const skillEnd = panelJs.indexOf("function renderMcpPane", skillStart);
assert(skillStart >= 0 && skillEnd > skillStart, "Skill Router renderer must be bundled");
const skillCalls = [];
const updateActions = [{ disabled: false, setAttribute() {} }, { disabled: false, setAttribute() {} }];
const skillContext = {
  esc,
  uiIcon: (name, label = '') => `<span class="codicon codicon-${name}"></span>${label ? `<span>${esc(label)}</span>` : ''}`,
  ask: (command, data) => skillCalls.push({ command, data }),
  document: { querySelectorAll: () => updateActions },
  mcpI18nAttrs: (key, params = {}) => `data-i18n="${key}" ${Object.entries(params).map(([name, value]) => `data-i18n-param-${name}="${value}"`).join(' ')}`,
};
vm.createContext(skillContext);
new vm.Script(`${panelJs.slice(skillStart, skillEnd)}; this.render = renderPkmSkillTargets; this.injectOne = pkmSkillInjectOne; this.injectAll = pkmSkillInjectAll; this.finish = finishPkmSkillUpdates;`).runInContext(skillContext);
const baseSkill = { routerVersion: "1.1.6", minimumMcpSchema: "2.8.0", sourcePath: "/skill.md", sourceExists: true, targets: [] };
const currentHtml = skillContext.render({ pkmSkill: { ...baseSkill, targets: [{ id: "copilot", kind: "copilot", label: "GitHub Copilot", root: "/x", skillPath: "/x/pkm-skills/SKILL.md", state: "current", installedVersion: "1.1.6", expectedVersion: "1.1.6", managed: true, detail: "Injected Skill is current." }] }, skillProposals: [] });
assert.match(currentHtml, /data-i18n="config\.current"[^>]*>Current<\/span> · v1\.1\.6/);
assert.doesNotMatch(currentHtml, /Reinstall|pkmSkillInject/);
const outdatedHtml = skillContext.render({ pkmSkill: { ...baseSkill, targets: [{ id: "copilot", kind: "copilot", label: "GitHub Copilot", root: "/x", skillPath: "/x/pkm-skills/SKILL.md", state: "outdated", installedVersion: "1.1.5", expectedVersion: "1.1.6", managed: true, detail: "Router 1.1.5 -> 1.1.6" }] }, skillProposals: [] });
assert.match(outdatedHtml, /data-i18n="config\.updateSkill"[^>]*data-i18n-param-installed="1\.1\.5"[^>]*data-i18n-param-expected="1\.1\.6"[^>]*>Update PKM Skill · v1\.1\.5 → v1\.1\.6<\/span>/);
assert.match(outdatedHtml, /pkmSkillInject/);
const bulkHtml = skillContext.render({ pkmSkill: { ...baseSkill, targets: [
  { id: "copilot", label: "Copilot", skillPath: "/x", state: "outdated" },
  { id: "agents", label: "Agents", skillPath: "/y", state: "missing" },
] }, skillProposals: [] });
assert.match(bulkHtml, /Update All \(2\)/);
const oneButton = { disabled: false, innerHTML: "Update", setAttribute(name, value) { this[name] = value; } };
skillContext.injectOne(oneButton, "copilot");
skillContext.injectOne(oneButton, "copilot");
assert.strictEqual(oneButton.disabled, true);
assert.match(oneButton.innerHTML, /Updating/);
assert.strictEqual(JSON.stringify(skillCalls), JSON.stringify([{ command: "pkmSkillInject", data: { id: "copilot" } }]), "a pending target must not send duplicate updates");
skillContext.finish();
skillCalls.length = 0;
const allButton = { disabled: false, innerHTML: "Update All", setAttribute(name, value) { this[name] = value; } };
skillContext.injectAll(allButton, ["copilot", "agents", "copilot"]);
skillContext.injectAll(allButton, ["copilot", "agents"]);
assert.strictEqual(allButton.disabled, true);
assert.match(allButton.innerHTML, /Updating 2/);
assert.strictEqual(JSON.stringify(skillCalls), JSON.stringify([{ command: "pkmSkillInjectAll", data: { ids: ["copilot", "agents"] } }]), "Update All must send one deduplicated bulk request");
skillContext.finish();

assert(sourceTs.includes("installedKnowledgeVersion === KNOWLEDGE_MCP_VERSION"));
assert(sourceTs.includes("installedChatVersion === CHAT_MCP_VERSION"));
assert(sourceTs.includes("installedRecipeVersion === RECIPE_MCP_VERSION"));
assert(sourceTs.includes("installedAgentSessionVersion === AGENT_SESSION_MCP_VERSION"));
assert(panelJs.includes("Knowledge: installed v"));
assert(panelJs.includes("Chat: installed v"));
for (const text of ["PKM Integration Status", "Unified MCP Server", "Knowledge schema", "Chat schema", "Recipe runtime", "Agent Session runtime", "PKM Skill Router", "Setup progress", "Ready · starts on demand", "Automatic integration", "Agent connection"]) {
  assert(panelJs.includes(text), `missing dashboard text: ${text}`);
}
assert.doesNotMatch(panelJs, />Update with Server<\/button>|>Update Code<\/button>|>Repair Runtime<\/button>/,
  "normal Config state must not ask new users to maintain internal components manually");
assert.match(panelJs, /automatic\.state === 'error' \? '<button class="tbtn" onclick="ask\(\\'checkMcp\\'/,
  "automatic failures must expose one Retry action");
assert.match(panelJs, /Personal Knowledge Manager<\/span>[\s\S]{0,300}Extension v\$\{esc\(data\?\.extensionVersion \|\| 'unknown'\)\}/,
  "the Config header must show the complete Extension semver independently from MCP schema versions");
assert.match(panelJs, /\['PKM Skill Router',[\s\S]{0,240}<span class="mcp-no-action">No action<\/span>/,
  "the Skill Router version row must be informational only");
assert.match(panelJs, /\['PKM Skill Router',[\s\S]{0,240}'Info', 'info'\]/,
  "the informational Router row must never report Update available");
assert.doesNotMatch(panelJs, /PKM Skill Router',[\s\S]{0,240}>Review Targets<\/button>/,
  "the version table must not duplicate Router target actions");
assert.match(panelJs, /<details class="mcp-router-field"><summary><span>Skill Router<\/span>/,
  "Config must provide a collapsible Skill Router field");
assert.doesNotMatch(panelJs, /<details class="mcp-router-field" open/,
  "the Skill Router field must be collapsed by default");
assert.match(panelJs, /function renderSkillRouterField[\s\S]{0,900}router\.name[\s\S]{0,900}router\.description/,
  "the field must render the backend-provided route list without action buttons");
assert.match(extensionTs, /firstRunGuide: \{ visible: !!guideStep, step: guideStep \}/);
assert.match(panelJs, /id="pkm-first-run-guide"[\s\S]{0,1400}Click the highlighted Inject or Update All button/,
  "first configuration must explain the consent action in a floating guide");
assert.match(panelJs, /pkm-first-run-target[\s\S]{0,500}pkmSkillInjectAll/,
  "the first Skill injection action must receive an anchored callout");
assert.match(panelJs, /dataset\.step === 'python'\) completeIntegrationGuide\(\)/,
  "Python guidance must complete only when Validate & Save submits a path");
assert.match(panelCss, /\.pkm-first-run-target::after\{content:'Start here'/);
assert.match(panelCss, /\.pkm-first-run-guide\{position:fixed/);
assert.match(panelJs, /const previousScrollTop = el\?\.scrollTop \|\| 0/);
assert.match(panelJs, /requestAnimationFrame\(\(\) => \{[\s\S]{0,180}Math\.min\(previousScrollTop, maxScrollTop\)/,
  "Config rerenders after Update with Server must clamp stale scroll offsets instead of leaving blank space");
assert.match(panelJs, /\['Unified MCP Server',[\s\S]{0,300}<span class="mcp-no-action">Automatic<\/span>/);
assert.doesNotMatch(panelJs, />Update with Server<\/button>|>Update Code<\/button>|>Repair Runtime<\/button>/,
  "routine internal updates must not be presented as user actions");
for (const text of ["Paths", "Knowledge root", "Environments root", "Managed MCP runtime", "MCP Base Python", "MCP server directory", "Automatic", "Connected"]) {
  assert(panelJs.includes(text), `missing path/status text: ${text}`);
}
for (const key of ["store", "environments", "runtime", "python", "serverDirectory"]) {
  assert(panelJs.includes(`data-mcp-path-size=\"${key}\"`), `missing disk usage target: ${key}`);
}
assert(panelJs.includes("function mcpPathSizeText"));
assert(panelJs.includes("function renderMcpPathSize"));
assert(extensionTs.includes("async function calculatePathBytes"));
assert(extensionTs.includes("fs.promises.lstat"));
assert(extensionTs.includes("fs.promises.readdir"));
assert(extensionTs.includes("stat.isSymbolicLink()"));
assert(extensionTs.includes("stat.blocks * 512"));
assert.doesNotMatch(extensionTs, /execFile\(["']du["']/);
assert(extensionTs.includes('case "refreshMcpPathSizes"'));
assert(extensionTs.includes("mcpPathSizeCache.clear()"));
assert(extensionTs.includes("mcpPathSizeGeneration += 1"));
assert(extensionTs.includes("generation !== mcpPathSizeGeneration"));
assert(extensionTs.includes("sendMcpPathSizes(respond, mcpPathSizeGeneration)"));
assert.doesNotMatch(extensionTs, /300_000|Date\.now\(\) - cached\.at/);
assert(panelJs.includes("function refreshMcpPathSizes"));
assert(panelJs.includes("uiIcon('refresh', 'Refresh sizes')"));
assert(panelJs.includes("ask('reconfigureKnowledgeRoot',{})"));
assert(panelJs.includes("ask('reconfigureEnvironmentsRoot',{})"));
assert(panelJs.includes("ask('reconfigureMcpRuntimePath',{})"));
assert(panelJs.includes("ask('reconfigureMcpServerPath',{})"));
for (const text of ["Knowledge root", "Environments root", "Managed MCP runtime", "MCP Base Python", "MCP server directory", "This directory can grow very large", "Reconfigure & Rebuild", "Reconfigure & Regenerate"]) assert(panelJs.includes(text));
assert(panelJs.includes("command === 'pkmSkillUpdateComplete'"));
assert(panelJs.includes("finishPkmSkillUpdates(); if (!data?.ok) ask('checkMcp', {})"));
assert.doesNotMatch(/command === 'mcpStatus'[^\n]*/.exec(panelJs)?.[0] || "", /finishPkmSkillUpdates/);
assert(panelJs.includes('class="mcp-path-table"'));
assert(panelJs.includes("<th>Path Type</th><th>Location</th><th>Disk Usage</th><th>Action</th>"));
assert(panelCss.includes("table-layout:fixed"));
assert(panelCss.includes(".mcp-path-size-col{width:105px}"));
assert(panelJs.includes("automatic.state === 'error'"));
assert(panelJs.includes(">Retry</button>"));
assert.doesNotMatch(panelJs, /configureStorePath|configureEnvironmentsPath/);
assert(panelJs.includes("mcpProcess"));
assert(sourceTs.includes("export function mcpProcessStatus"));
assert(extensionTs.includes('context.globalState.get<string>("lastStorePath"'));
assert(extensionTs.includes('_pendingTab = configuredPath ?'));
assert(extensionTs.includes('const initialResolution = resolvedStorePath(context)'));
assert(extensionTs.includes('case "pkmSkillInjectAll"'));
assert(extensionTs.includes('case "reconfigureKnowledgeRoot"'));
assert(extensionTs.includes('registerCommand("personalKnowledge.reconfigureKnowledgeRoot"'));
assert(extensionTs.includes('registerCommand("personalKnowledge.reconfigureEnvironmentsRoot"'));
assert(extensionTs.includes('registerCommand("personalKnowledge.reconfigureMcpRuntimePath"'));
assert(extensionTs.includes('registerCommand("personalKnowledge.reconfigureMcpServerPath"'));
for (const text of ["disposeServers();", "await initStore(context, chosen);", "applyChatArchiveCfg();", "startFileWatcher(context);", "refreshMcpDefinitions();"]) assert(extensionTs.includes(text));
for (const text of [
  'configuration.update("mcpPythonPath", previousPython || undefined',
  'configuration.update("environmentsPath", previous || undefined',
  'configuration.update("mcpRuntimePath", previous || undefined',
  'configuration.update("mcpServerPath", previous || undefined',
]) assert(extensionTs.includes(text), `missing rollback: ${text}`);
for (const text of [
  "safeMcpRuntimeTarget(derivedRuntime)",
  "safeMcpRuntimeTarget(chosen)",
  "safeMcpServerTarget(chosen)",
  "mcpPathSizeGeneration += 1",
  'panel?.webview.postMessage({ command: "mcpStatus", data: mcpPanelStatusData() })',
]) assert(extensionTs.includes(text), `missing safe path refresh: ${text}`);
assert(sourceTs.includes("Refusing to replace unrecognized directory"));
const pipInstallIndex = sourceTs.indexOf('execFile(validation.path, ["-m", "pip", "install"');
const markerWriteIndex = sourceTs.lastIndexOf("fs.writeFileSync(mcpRuntimeBaseMarker()");
assert(pipInstallIndex >= 0 && markerWriteIndex > pipInstallIndex, "runtime ownership marker must be written after pip succeeds");
assert.doesNotMatch(extensionTs, /case "configureStorePath"|case "configureEnvironmentsPath"/);
console.log("MCP version UI test: regenerate version transitions and current Skill Router action state OK");
