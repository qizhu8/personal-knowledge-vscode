#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const panelJs = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
const panelCss = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.css"), "utf8");
const sourceTs = fs.readFileSync(path.join(__dirname, "..", "src", "mcp/mcp.ts"), "utf8");
const solutionSource = fs.readFileSync(path.join(__dirname, "..", "resources", "retrieval_solution.py"), "utf8");
const extensionTs = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
const sourcePanelCss = fs.readFileSync(path.join(__dirname, "..", "src", "webview", "panel.css"), "utf8");
assert.match(sourcePanelCss, /\.srv-global-controls select,\.srv-edit input,\.mcp-setup-step select,\.mcp-setup-step input\{[^}]*background:var\(--input\)[^}]*color:var\(--text\)[^}]*color-scheme:dark/,
  "Settings hostname, IP, and port controls must use the dark themed input surface");
assert.match(extensionTs, /function maintainPkmIntegration\(context: vscode\.ExtensionContext\)/);
assert.match(extensionTs, /function refreshMcpDefinitions\(\): void \{\s*mcpRuntimeStatusCache = undefined;/,
  "runtime mutations must invalidate the cached MCP health before refreshing the UI");
assert.match(extensionTs, /case "checkMcp":[\s\S]{0,350}await maintainPkmIntegration\(context\)[\s\S]{0,250}command: "mcpCheckComplete"/,
  "the MCP refresh action must remain pending until automatic integration maintenance finishes");
assert.match(extensionTs, /case "reconfigureMcpRuntimePath":[\s\S]{0,500}command: "mcpActionResult"[\s\S]{0,120}action: "reconfigureMcpRuntimePath"/,
  "managed runtime reconfiguration must send a dedicated terminal result");
assert.match(extensionTs, /case "reconfigureMcpServerPath":[\s\S]{0,500}command: "mcpActionResult"[\s\S]{0,120}action: "reconfigureMcpServerPath"/,
  "server directory reconfiguration must send a dedicated terminal result");
assert.match(extensionTs, /if \(server\.newerThanExpected\)[\s\S]{0,900}This window will not downgrade shared PKM files/,
  "an older window must stop maintenance and recommend a manual Reload Window");
const extensionAst = ts.createSourceFile("extension.ts", extensionTs, ts.ScriptTarget.Latest, true);
const hostRuntime = extensionAst.statements.find(statement => ts.isFunctionDeclaration(statement)
  && statement.name?.text === "registerExtensionHostRuntime");
assert(hostRuntime, "explicit coordinated Host reload registration must exist");
assert.doesNotMatch(extensionTs.slice(0, hostRuntime.pos) + extensionTs.slice(hostRuntime.end),
  /executeCommand\([^\n]*(reloadWindow|reload)/i,
  "MCP maintenance and other automatic paths must never reload the user's window");
const hostRuntimeText = hostRuntime.getText(extensionAst);
assert.match(hostRuntimeText, /if \(registry\.poll\(installed\?\.buildId, isBusy\(\)\)\) \{[\s\S]{0,350}executeCommand\("workbench\.action\.reloadWindow"\)/,
  "coordinated reload must require the registry's validated request and busy-state gate");
assert.match(hostRuntimeText, /registerCommand\("personalKnowledge\.reloadAllHosts"[\s\S]*showWarningMessage[\s\S]*modal: true[\s\S]*if \(answer !== "Reload registered windows"\) return;[\s\S]*registry\.requestReload/,
  "a coordinated reload request must require explicit modal confirmation");
assert.match(sourceTs, /Refusing to downgrade the installed PKM MCP runtime/,
  "the generated server write boundary must reject downgrades");
assert.match(sourceTs, /The newer runtime was preserved[\s\S]*Upgrade Personal Knowledge Manager/,
  "downgrade protection must preserve the newer runtime and recommend an extension upgrade");
assert.match(sourceTs, /export const UNIFIED_MCP_VERSION = "\d+\.\d+\.\d+";/,
  "unified runtime version must be declared as numeric SemVer");
assert.match(sourceTs, /SERVER_VERSION = "\$\{UNIFIED_MCP_VERSION\}"/,
  "generated MCP must use the authoritative unified runtime version");
assert.doesNotMatch(panelJs, /PKM MCP server is outdated/,
  "equal unified versions must not be mislabeled as an outdated server");
assert.match(panelJs, /server v\$\{installed\} is current, but runtime components need update/,
  "equal unified versions with changed components must identify the component transition");
assert.match(panelJs, /A newer PKM MCP runtime is installed and was preserved/,
  "newer installed runtimes must receive preservation and Extension upgrade guidance");
assert.match(panelJs, /checkMcp:600000/,
  "automatic integration checks can install dependencies and need a realistic timeout");
assert.match(panelJs, /command === 'mcpStatus'\)\s*\{\s*mcpOnStatus\(data\);\s*\}/,
  "generic MCP status refreshes must not prematurely finish mutating actions");
assert.match(panelJs, /command === 'mcpCheckComplete'[\s\S]{0,350}finishAction\('checkMcp'\)/,
  "only the dedicated MCP check terminal event may finish the check action");
assert.match(panelJs, /command === 'mcpActionResult'[\s\S]{0,500}completeMcpUiAction/,
  "MCP reconfiguration results must finish the action and publish visible completion");
assert.match(panelJs, /function completeMcpUiAction\(message\)[\s\S]{0,450}getElementById\('mcp-completion-slot'\)[\s\S]{0,450}role="status"/,
  "MCP completion must update the visible pane immediately instead of waiting for a later rerender");
assert.match(panelJs, /id="mcp-completion-slot"/,
  "the MCP pane must preserve a dedicated completion status surface across rerenders");
assert.match(panelJs, /data\?\.current \|\| data\?\.newerThanExpected/,
  "a newer shared server must remain usable in an older window");
assert.match(panelJs, /data\?\.newerThanExpected \? 'Newer installed'/,
  "Config must describe a newer shared server without requesting downgrade");
assert.match(extensionTs, /if \(!runtime\.healthy\)[\s\S]{0,500}await ensureMcpRuntime\(context\)/,
  "automatic maintenance must create or repair the managed runtime");
assert.match(extensionTs, /else if \(!server\.current\)[\s\S]{0,500}generateMcpServer\(context\)/,
  "automatic maintenance must regenerate stale server code");
assert.doesNotMatch(extensionTs, /reconcilePkmSkillProjections|\bconnectPkmSkill\(/,
  "runtime maintenance must never restore retired Agent Router injections");
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
assert.match(solutionSource, /from adaptive_skill_retrieval\.solution_package import import_package/,
  "offline Solution import must require the retrieval wheel's solution_package API");
assert.match(solutionSource, /except \(ImportError,[\s\S]{0,350}return 1/,
  "offline Solution import must reject a wheel missing the required API");
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

assert.doesNotMatch(panelJs, /pkmSkillInject|renderPkmSkillTargets|copyMcpInstructions|agency-install-code|mcp-install-code/,
  "Settings must not offer retired Router injection or an Agent installation prompt");

assert(sourceTs.includes("installedKnowledgeVersion === KNOWLEDGE_MCP_VERSION"));
assert(sourceTs.includes("installedChatVersion === CHAT_MCP_VERSION"));
assert(sourceTs.includes("installedRecipeVersion === RECIPE_MCP_VERSION"));
assert(sourceTs.includes("installedAgentSessionVersion === AGENT_SESSION_MCP_VERSION"));
assert(sourceTs.includes("mcp.add_middleware(McpCallGuardMiddleware(mcp))"));
assert(sourceTs.includes('"resources", "mcp_call_guard.py"'));
assert(panelJs.includes("Knowledge: installed v"));
assert(panelJs.includes("Chat: installed v"));
for (const text of ["PKM Integration Status", "Unified MCP Server", "Knowledge schema", "Chat schema", "Recipe runtime", "Agent Session runtime", "Setup progress", "Ready · starts on demand", "Automatic integration", "Account binding (not client discovery)"]) {
  assert(panelJs.includes(text), `missing dashboard text: ${text}`);
}
assert.doesNotMatch(panelJs, /Account MCP registration/,
  "an account binding must not be presented as an actual client registration");
assert(panelJs.includes("~/.pkm/mcp-binding.json is not a client registration. Verify each client separately."),
  "the binding dashboard must explicitly distinguish binding from client discovery");
assert.match(panelJs, /clientRegistration\?\.vscode\?\.definitionAvailable \? 'available on this host \(client discovery not verified\)'/,
  "a native definition must not be presented as verified client discovery");
assert.match(panelJs, /Default CLI user configuration: \$\{esc\(data\?\.clientRegistration\?\.copilot\?\.state/,
  "CLI configuration state must be shown independently from native discovery");
for (const [id, command, label] of [
  ["mcp-configure-native", "configureNativeMcpDiscovery", "Configure VS Code MCP discovery"],
  ["mcp-register-copilot-user", "registerCopilotMcp", "Register Copilot CLI MCP (User)"],
]) {
  assert.match(panelJs, new RegExp(`id="${id}"[^>]*beginMcpUiAction\\('${command}'[^>]*>${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<\\/button>`),
    `${label} must remain an explicit client-specific setup action`);
}
assert.doesNotMatch(panelJs, />Update with Server<\/button>|>Update Code<\/button>|>Repair Runtime<\/button>/,
  "normal Config state must not ask new users to maintain internal components manually");
assert.match(panelJs, /automatic\.state === 'error' \? '<button class="tbtn" data-pending-label="Retrying…" onclick="beginMcpUiAction\(\\'checkMcp\\'/,
  "automatic failures must expose one Retry action");
assert.match(panelJs, /Personal Knowledge Manager<\/span>[\s\S]{0,300}Extension v\$\{esc\(data\?\.extensionVersion \|\| 'unknown'\)\}/,
  "the Config header must show the complete Extension semver independently from MCP schema versions");
assert.doesNotMatch(panelJs, /\['PKM Skill Router',/,
  "retired Agent adapters must not be presented as required MCP components");
assert.doesNotMatch(panelJs, /PKM Skill Router',[\s\S]{0,240}>Review Targets<\/button>/,
  "the version table must not duplicate Router target actions");
assert.match(panelJs, /<details class="mcp-router-field"><summary><span>Skill Router<\/span>/,
  "Config must provide a collapsible Skill Router field");
assert.doesNotMatch(panelJs, /<details class="mcp-router-field" open/,
  "the Skill Router field must be collapsed by default");
assert.match(panelJs, /function renderSkillRouterField[\s\S]{0,900}router\.name[\s\S]{0,900}router\.description/,
  "the field must render the backend-provided route list without action buttons");
assert.match(extensionTs, /firstRunGuide: \{ visible: !!guideStep, step: guideStep \}/);
assert.match(panelJs, /guide\.step !== 'python'/,
  "first configuration must not guide users back into retired injection");
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
for (const text of ["Paths", "Knowledge root", "Environments root", "Managed MCP runtime", "MCP Base Python", "MCP server directory", "Automatic", "Account binding (not client discovery)"]) {
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
assert(panelJs.includes("beginMcpUiAction('reconfigureKnowledgeRoot',{},this)"));
assert(panelJs.includes("beginMcpUiAction('reconfigureEnvironmentsRoot',{},this)"));
assert(panelJs.includes("beginMcpUiAction('reconfigureMcpRuntimePath',{},this)"));
assert(panelJs.includes("beginMcpUiAction('reconfigureMcpServerPath',{},this)"));
for (const label of ["Searching…", "Browsing…", "Configuring…", "Rebuilding…", "Regenerating…"]) {
  assert(panelJs.includes(`data-pending-label="${label}"`), `missing MCP pending feedback: ${label}`);
}
assert.match(panelJs, /data-pending-label="\$\{runtime\.exists \? 'Repairing…' : 'Creating…'\}"/,
  "runtime creation and repair must expose operation-specific pending feedback");
assert.match(panelJs, /function saveMcpPython\(button\)[\s\S]{0,500}beginMcpUiAction\('mcpSetPython', \{ path \}, button\)/,
  "Validate & Save must bind its button to the long-running runtime setup");
assert.match(panelJs, /Python configured and managed MCP runtime is ready/,
  "successful runtime configuration must survive the status refresh as an explicit completion notice");
assert.match(panelJs, /id="mcp-completion-notice" role="status"/,
  "MCP completion feedback must remain visible after the panel rerenders");
assert.match(panelJs, /command === 'mcpPythonBrowseCancelled'[\s\S]{0,100}finishAction\('mcpBrowsePython'\)/,
  "cancelling the Python picker must restore its pending button");
assert.match(extensionTs, /case "mcpBrowsePython"[\s\S]{0,700}mcpPythonBrowseCancelled/,
  "the host must explicitly acknowledge Python picker cancellation");
for (const command of ["reconfigureKnowledgeRoot", "reconfigureEnvironmentsRoot", "reconfigureMcpRuntimePath", "reconfigureMcpServerPath"]) {
  assert.match(extensionTs, new RegExp(`case "${command}":[\\s\\S]{0,300}command: "mcpStatus"`),
    `${command} must return a completion state even when its native picker is cancelled`);
}
for (const text of ["Knowledge root", "Environments root", "Managed MCP runtime", "MCP Base Python", "MCP server directory", "This directory can grow very large", "Reconfigure & Rebuild", "Reconfigure & Regenerate"]) assert(panelJs.includes(text));
assert.doesNotMatch(panelJs, /pkmSkillUpdateComplete|finishPkmSkillUpdates/,
  "retired injection responses must not restart maintenance");
assert(panelJs.includes('class="mcp-path-table"'));
assert.match(panelJs, /id="mcp-copilot-registration"/,
  "MCP settings must explain the separate Copilot CLI / SDK registration");
for (const text of ["~/.copilot/mcp-config.json", "copilot mcp list", "copilot mcp get pkm", "Enabled only confirms configuration", "do not inherit VS Code MCP definitions"]) {
  assert(panelJs.includes(text), `missing Copilot registration guidance: ${text}`);
}
const copilotElements = {
  "mcp-copilot-cfg-code": { textContent: "", removeAttribute(name) { this.removedAttribute = name; } },
  "mcp-copy-copilot-cfg": { disabled: true },
};
const copilotSandbox = {
  window: {},
  document: { getElementById: id => copilotElements[id] || null },
};
vm.createContext(copilotSandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "webview", "panel", "50-mcp.js"), "utf8"), copilotSandbox);
for (const definition of [
  { type: "stdio", command: "/home/person/pkm runtime/bin/python", args: ["/home/person/knowledge/mcp-server/server.py"] },
  { type: "stdio", command: String.raw`C:\Program Files\Microsoft VS Code\Code.exe`, args: [String.raw`C:\PKM\pkm-stdio-proxy.js`, String.raw`C:\PKM\runtime\Scripts\python.exe`, String.raw`C:\PKM\server.py`], env: { ELECTRON_RUN_AS_NODE: "1" } },
]) {
  copilotSandbox.renderMcpGenerated({ preview: true, configSnippet: JSON.stringify({ servers: { pkm: definition } }) });
  const config = JSON.parse(copilotSandbox.window._copilotMcpCfg);
  assert.deepStrictEqual(config, { mcpServers: { pkm: { ...definition, type: "local", tools: ["*"] } } },
    "Copilot configuration must preserve exact managed launch paths, arguments, and Windows environment");
  assert.strictEqual(copilotElements["mcp-copilot-cfg-code"].textContent, copilotSandbox.window._copilotMcpCfg);
  assert.strictEqual(copilotElements["mcp-copilot-cfg-code"].removedAttribute, "data-i18n",
    "localization must not replace a generated configuration with placeholder text");
  assert.strictEqual(copilotElements["mcp-copy-copilot-cfg"].disabled, false);
}
assert.throws(() => copilotSandbox.renderMcpGenerated({ preview: true, configSnippet: '{"servers":{}}' }),
  /missing its command or arguments/,
  "invalid generated launch definitions must not produce a success-shaped CLI configuration");
for (const locale of ["en", "zh-hans"]) {
  const contents = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "resources", "locales", `${locale}.json`), "utf8"));
  for (const key of ["Title", "Description", "Prepare", "Merge", "NotReady", "Copy", "Copied", "Schema", "Verify", "Remote"]) {
    assert(contents.strings[`config.copilotRegistration${key}`],
      `${locale} must localize Copilot registration ${key}`);
  }
}
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
console.log("MCP version UI test: version transitions, account binding versus client discovery, explicit client setup, and retired injection UI OK");
