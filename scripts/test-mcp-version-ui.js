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

const presentation = panelJs.match(/function mcpRegeneratePresentation\(data\)\s*\{[\s\S]*?\n\}/);
assert(presentation, "MCP regenerate presentation helper must be bundled");
const presentationContext = { esc };
vm.createContext(presentationContext);
new vm.Script(`${presentation[0]}; this.present = mcpRegeneratePresentation;`).runInContext(presentationContext);

const outdated = presentationContext.present({
  installed: true, current: false, installedVersion: "2.4.0", expectedVersion: "2.5.0",
  installedKnowledgeVersion: "1.0.0", knowledgeVersion: "1.0.0",
  installedChatVersion: "2.2.1", chatVersion: "2.3.0",
});
assert.strictEqual(outdated.label, "Regenerate Server Code · v2.4.0 → v2.5.0");
assert.match(outdated.title, /Unified v2\.4\.0 → v2\.5\.0/);
assert.match(outdated.title, /Chat v2\.2\.1 → v2\.3\.0/);
assert.strictEqual(presentationContext.present({ installed: true, current: true, expectedVersion: "2.5.0", knowledgeVersion: "1.0.0", chatVersion: "2.3.0" }).label,
  "Regenerate Server Code · v2.5.0");
assert.strictEqual(presentationContext.present({ installed: false, expectedVersion: "2.5.0" }).label,
  "Generate Server Code · target v2.5.0");

const skillStart = panelJs.indexOf("function pkmSkillStateBadge");
const skillEnd = panelJs.indexOf("function renderMcpPane", skillStart);
assert(skillStart >= 0 && skillEnd > skillStart, "Skill Router renderer must be bundled");
const skillContext = { esc };
vm.createContext(skillContext);
new vm.Script(`${panelJs.slice(skillStart, skillEnd)}; this.render = renderPkmSkillTargets;`).runInContext(skillContext);
const baseSkill = { routerVersion: "1.1.3", minimumMcpSchema: "2.2.3", sourcePath: "/skill.md", sourceExists: true, targets: [] };
const currentHtml = skillContext.render({ pkmSkill: { ...baseSkill, targets: [{ id: "copilot", kind: "copilot", label: "GitHub Copilot", root: "/x", skillPath: "/x/pkm-skills/SKILL.md", state: "current", installedVersion: "1.1.3", expectedVersion: "1.1.3", managed: true, detail: "Injected Skill is current." }] }, skillProposals: [] });
assert.match(currentHtml, /Current · v1\.1\.3/);
assert.doesNotMatch(currentHtml, /Reinstall|pkmSkillInject/);
const outdatedHtml = skillContext.render({ pkmSkill: { ...baseSkill, targets: [{ id: "copilot", kind: "copilot", label: "GitHub Copilot", root: "/x", skillPath: "/x/pkm-skills/SKILL.md", state: "outdated", installedVersion: "1.1.2", expectedVersion: "1.1.3", managed: true, detail: "Router 1.1.2 -> 1.1.3" }] }, skillProposals: [] });
assert.match(outdatedHtml, /Update PKM Skill · v1\.1\.2 → v1\.1\.3/);
assert.match(outdatedHtml, /pkmSkillInject/);

assert(sourceTs.includes("installedKnowledgeVersion === KNOWLEDGE_MCP_VERSION"));
assert(sourceTs.includes("installedChatVersion === CHAT_MCP_VERSION"));
assert(panelJs.includes("Knowledge: installed v"));
assert(panelJs.includes("Chat: installed v"));
for (const text of ["PKM Integration Status", "Unified MCP Server", "Knowledge schema", "Chat schema", "PKM Skill Router", "Setup guideline", "Ready · not detected", "Startup wizard"]) {
  assert(panelJs.includes(text), `missing dashboard text: ${text}`);
}
for (const text of ["Paths", "Knowledge root", "Environments root", "Managed MCP runtime", "Runtime Python", "MCP server directory", "No action needed"]) {
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
assert.doesNotMatch(extensionTs, /300_000|Date\.now\(\) - cached\.at/);
assert(panelJs.includes("function refreshMcpPathSizes"));
assert(panelJs.includes("↻ Refresh sizes"));
assert(panelJs.includes('class="mcp-path-table"'));
assert(panelJs.includes("<th>Path Type</th><th>Location</th><th>Disk Usage</th><th>Source</th>"));
assert(panelCss.includes("table-layout:fixed"));
assert(panelCss.includes(".mcp-path-size-col{width:105px}"));
assert(panelJs.includes("data?.current ? '' : 'mcp-regenerate-action'"));
assert.doesNotMatch(panelJs, /configureStorePath|configureEnvironmentsPath/);
assert(panelJs.includes("mcpProcess"));
assert(sourceTs.includes("export function mcpProcessStatus"));
assert(extensionTs.includes('context.globalState.get<string>("lastStorePath"'));
assert(extensionTs.includes('_pendingTab = configuredPathValid ?'));
assert.doesNotMatch(extensionTs, /case "configureStorePath"|case "configureEnvironmentsPath"/);
console.log("MCP version UI test: regenerate version transitions and current Skill Router action state OK");
