#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const panelJs = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
const panelCss = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.css"), "utf8");
const sourceTs = fs.readFileSync(path.join(__dirname, "..", "src", "mcp.ts"), "utf8");
const extensionTs = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
const esc = value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
assert.match(panelCss, /\.mcp-version-table \.mcp-row-action\{text-align:left;/);

const presentation = panelJs.match(/function mcpRegeneratePresentation\(data\)\s*\{[\s\S]*?\n\}/);
assert(presentation, "MCP regenerate presentation helper must be bundled");
const presentationContext = { esc };
vm.createContext(presentationContext);
new vm.Script(`${presentation[0]}; this.present = mcpRegeneratePresentation;`).runInContext(presentationContext);

const outdated = presentationContext.present({
  installed: true, current: false, installedVersion: "2.4.0", expectedVersion: "2.5.4",
  installedKnowledgeVersion: "1.0.0", knowledgeVersion: "1.0.0",
  installedChatVersion: "2.2.1", chatVersion: "2.3.0",
});
assert.strictEqual(outdated.label, "Regenerate Server Code · v2.4.0 → v2.5.4");
assert.match(outdated.title, /Unified v2\.4\.0 → v2\.5\.4/);
assert.match(outdated.title, /Chat v2\.2\.1 → v2\.3\.0/);
assert.strictEqual(presentationContext.present({ installed: true, current: true, expectedVersion: "2.5.4", knowledgeVersion: "1.0.0", chatVersion: "2.3.0" }).label,
  "Regenerate Server Code · v2.5.4");
assert.strictEqual(presentationContext.present({ installed: false, expectedVersion: "2.5.4" }).label,
  "Generate Server Code · target v2.5.4");

const skillStart = panelJs.indexOf("function pkmSkillStateBadge");
const skillEnd = panelJs.indexOf("function renderMcpPane", skillStart);
assert(skillStart >= 0 && skillEnd > skillStart, "Skill Router renderer must be bundled");
const skillCalls = [];
const updateActions = [{ disabled: false, setAttribute() {} }, { disabled: false, setAttribute() {} }];
const skillContext = {
  esc,
  ask: (command, data) => skillCalls.push({ command, data }),
  document: { querySelectorAll: () => updateActions },
  mcpI18nAttrs: (key, params = {}) => `data-i18n="${key}" ${Object.entries(params).map(([name, value]) => `data-i18n-param-${name}="${value}"`).join(' ')}`,
};
vm.createContext(skillContext);
new vm.Script(`${panelJs.slice(skillStart, skillEnd)}; this.render = renderPkmSkillTargets; this.injectOne = pkmSkillInjectOne; this.injectAll = pkmSkillInjectAll; this.finish = finishPkmSkillUpdates;`).runInContext(skillContext);
const baseSkill = { routerVersion: "1.1.4", minimumMcpSchema: "2.2.3", sourcePath: "/skill.md", sourceExists: true, targets: [] };
const currentHtml = skillContext.render({ pkmSkill: { ...baseSkill, targets: [{ id: "copilot", kind: "copilot", label: "GitHub Copilot", root: "/x", skillPath: "/x/pkm-skills/SKILL.md", state: "current", installedVersion: "1.1.4", expectedVersion: "1.1.4", managed: true, detail: "Injected Skill is current." }] }, skillProposals: [] });
assert.match(currentHtml, /data-i18n="config\.current"[^>]*>Current<\/span> · v1\.1\.4/);
assert.doesNotMatch(currentHtml, /Reinstall|pkmSkillInject/);
const outdatedHtml = skillContext.render({ pkmSkill: { ...baseSkill, targets: [{ id: "copilot", kind: "copilot", label: "GitHub Copilot", root: "/x", skillPath: "/x/pkm-skills/SKILL.md", state: "outdated", installedVersion: "1.1.3", expectedVersion: "1.1.4", managed: true, detail: "Router 1.1.3 -> 1.1.4" }] }, skillProposals: [] });
assert.match(outdatedHtml, /data-i18n="config\.updateSkill"[^>]*data-i18n-param-installed="1\.1\.3"[^>]*data-i18n-param-expected="1\.1\.4"[^>]*>Update PKM Skill · v1\.1\.3 → v1\.1\.4<\/span>/);
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
assert(panelJs.includes("Knowledge: installed v"));
assert(panelJs.includes("Chat: installed v"));
for (const text of ["PKM Integration Status", "Unified MCP Server", "Knowledge schema", "Chat schema", "PKM Skill Router", "Setup guideline", "Ready · starts on demand", "Startup wizard"]) {
  assert(panelJs.includes(text), `missing dashboard text: ${text}`);
}
for (const text of ["Paths", "Knowledge root", "Environments root", "Managed MCP runtime", "MCP Base Python", "MCP server directory", "No action needed"]) {
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
assert(panelJs.includes("↻ Refresh sizes"));
assert(panelJs.includes("ask('reconfigureKnowledgeRoot',{})"));
assert(panelJs.includes("ask('reconfigureEnvironmentsRoot',{})"));
assert(panelJs.includes("ask('reconfigureMcpRuntimePath',{})"));
assert(panelJs.includes("ask('reconfigureMcpServerPath',{})"));
for (const text of ["Knowledge root", "Environments root", "Managed MCP runtime", "MCP Base Python", "MCP server directory", "This directory can grow very large", "Reconfigure &amp; Rebuild", "Reconfigure &amp; Regenerate"]) assert(panelJs.includes(text));
assert(panelJs.includes("command === 'pkmSkillUpdateComplete'"));
assert(panelJs.includes("finishPkmSkillUpdates(); if (!data?.ok) ask('checkMcp', {})"));
assert.doesNotMatch(/command === 'mcpStatus'[^\n]*/.exec(panelJs)?.[0] || "", /finishPkmSkillUpdates/);
assert(panelJs.includes('class="mcp-path-table"'));
assert(panelJs.includes("<th>Path Type</th><th>Location</th><th>Disk Usage</th><th>Action</th>"));
assert(panelCss.includes("table-layout:fixed"));
assert(panelCss.includes(".mcp-path-size-col{width:105px}"));
assert(panelJs.includes("data?.current ? '' : 'mcp-regenerate-action'"));
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
