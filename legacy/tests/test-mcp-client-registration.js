#!/usr/bin/env node
const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const fixture = fs.mkdtempSync(path.join(__dirname, ".pkm-mcp-registration-"));
process.on("exit", () => fs.rmSync(fixture, { recursive: true, force: true }));
const compiled = path.join(fixture, "registration.js");
childProcess.execFileSync("npx", [
  "esbuild", path.join(root, "src/mcp/mcp-client-registration.ts"),
  "--bundle", "--platform=node", "--format=cjs", "--external:jsonc-parser", `--outfile=${compiled}`,
], { cwd: root, stdio: "ignore" });
const registration = require(compiled);
const launch = {
  command: String.raw`C:\Program Files\Microsoft VS Code\Code.exe`,
  args: [String.raw`C:\Users\person\.vscode\extensions\pkm\resources\windows\pkm-stdio-proxy.js`,
    String.raw`C:\Users\person\PKM Envs\pkm-mcp\Scripts\python.exe`,
    String.raw`C:\Users\person\Knowledge\mcp-server\server.py`],
  env: { ELECTRON_RUN_AS_NODE: "1" },
};
const definition = registration.copilotMcpDefinition(launch);
const filename = path.join(fixture, "account", ".copilot", "mcp-config.json");
const inspect = () => registration.inspectCopilotMcpRegistration(definition, filename);
const register = reviewed => registration.registerCopilotMcp(definition, reviewed.revision, filename);
const write = value => fs.writeFileSync(filename, JSON.stringify(value));

async function main() {
  const nativeLaunch = { ...launch, cwd: path.join(fixture, "knowledge", "mcp-server") };
  const workspaceConfig = path.join(fixture, "workspace", ".vscode", "mcp.json");
  fs.mkdirSync(path.dirname(workspaceConfig), { recursive: true });
  const scopedJsonc = '\uFEFF{\r\n  // Preserve this comment\r\n  "servers": { "other": { "type": "http", "url": "https://example.test/mcp" }, },\r\n  "inputs": [],\r\n}\r\n';
  fs.writeFileSync(workspaceConfig, scopedJsonc);
  const reviewedVscode = registration.inspectVscodeMcpRegistration(workspaceConfig, nativeLaunch);
  await registration.registerVscodeMcp(workspaceConfig, nativeLaunch, reviewedVscode.revision);
  const registeredJsonc = fs.readFileSync(workspaceConfig, "utf8");
  assert(registeredJsonc.startsWith("\uFEFF") && registeredJsonc.includes("// Preserve this comment"));
  const parsedVscode = registration.parseNativeMcpConfiguration(registeredJsonc);
  assert.strictEqual(parsedVscode.servers.pkm.type, "stdio");
  assert.strictEqual(parsedVscode.servers.pkm.cwd, nativeLaunch.cwd);
  assert.strictEqual(parsedVscode.servers.pkm.env.ELECTRON_RUN_AS_NODE, "1");
  assert.strictEqual(parsedVscode.servers.other.url, "https://example.test/mcp");
  assert.deepStrictEqual(parsedVscode.inputs, []);
  assert(fs.readdirSync(path.dirname(workspaceConfig)).some(name => name.includes(".pkm-backup-")));
  const matchingVscode = registration.inspectVscodeMcpRegistration(workspaceConfig, nativeLaunch);
  await registration.registerVscodeMcp(workspaceConfig, nativeLaunch, matchingVscode.revision);
  assert.strictEqual(fs.readFileSync(workspaceConfig, "utf8"), registeredJsonc, "matching scoped configuration is idempotent");
  fs.appendFileSync(workspaceConfig, "\n");
  await assert.rejects(registration.registerVscodeMcp(workspaceConfig, nativeLaunch, matchingVscode.revision), /changed after review/);
  assert.throws(() => registration.vscodeMcpConfiguration('{"servers":{"pkm":{"command":"different"}}}', nativeLaunch), /conflicts/);
  assert.throws(() => registration.vscodeMcpConfiguration('{"servers":{}, "servers":{}}', nativeLaunch), /Duplicate/);
  const profileConfig = path.join(fixture, "profile", "mcp.json");
  const profileReview = registration.inspectVscodeMcpRegistration(profileConfig, nativeLaunch);
  assert(!fs.existsSync(profileConfig));
  await registration.registerVscodeMcp(profileConfig, nativeLaunch, profileReview.revision);
  assert.strictEqual(JSON.parse(fs.readFileSync(profileConfig, "utf8")).servers.pkm.command, launch.command);
  assert.deepStrictEqual(definition, { type: "local", command: launch.command, args: launch.args, env: launch.env, tools: ["*"] });
  assert.strictEqual(inspect().state, "missing");
  assert(!fs.existsSync(path.dirname(filename)), "inspection must not create any configuration");
  const created = await register(inspect());
  assert.strictEqual(created.changed, true);
  assert.strictEqual(created.backup, undefined);
  assert.strictEqual(inspect().state, "matching");
  const before = fs.readFileSync(filename, "utf8");
  const mtime = fs.statSync(filename).mtimeMs;
  assert.strictEqual((await register(inspect())).changed, false);
  assert.strictEqual(fs.readFileSync(filename, "utf8"), before);
  assert.strictEqual(fs.statSync(filename).mtimeMs, mtime, "matching configuration is a no-op");
  assert.strictEqual(fs.readdirSync(path.dirname(filename)).length, 1, "idempotent registration must not leave lock, backups or temporary files");

  const unrelated = { settings: { retained: true }, mcpServers: { other: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "test-only" } } } };
  const originalText = "\uFEFF" + JSON.stringify(unrelated, null, 4) + "\n";
  fs.writeFileSync(filename, originalText);
  const merged = await register(inspect());
  assert.strictEqual(fs.readFileSync(merged.backup, "utf8"), originalText, "backup must preserve the original bytes");
  const expected = { ...unrelated, mcpServers: { ...unrelated.mcpServers, pkm: definition } };
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(filename, "utf8")), expected);
  if (process.platform !== "win32") {
    assert.strictEqual(fs.statSync(filename).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(merged.backup).mode & 0o777, 0o600);
  }

  write({ mcpServers: { pkm: { ...definition, tools: ["check_version"] } } });
  const conflict = fs.readFileSync(filename, "utf8");
  assert.strictEqual(inspect().state, "conflict");
  await assert.rejects(register(inspect()), /existing pkm entry/);
  assert.strictEqual(fs.readFileSync(filename, "utf8"), conflict, "conflicts must preserve existing tool selection");
  for (const name of ["pkm-alias", "PKM"]) {
    write({ mcpServers: { [name]: definition } });
    assert.strictEqual(inspect().state, "conflict", `must reject duplicate registration ${name}`);
  }
  for (const text of ["{", "[]", "null", '{"mcpServers":[]}', '{"mcpServers":null}', '{"mcpServers":{},"mcpServers":{}}']) {
    fs.writeFileSync(filename, text);
    assert.strictEqual(inspect().state, "invalid");
    await assert.rejects(register(inspect()));
    assert.strictEqual(fs.readFileSync(filename, "utf8"), text);
  }
  write(unrelated);
  const stale = inspect();
  write({ ...unrelated, changedDuringReview: true });
  await assert.rejects(register(stale), /changed after review/);
  assert.strictEqual(JSON.parse(fs.readFileSync(filename, "utf8")).changedDuringReview, true);
  fs.unlinkSync(filename);
  const linkTarget = path.join(fixture, "must-not-change.json");
  fs.writeFileSync(linkTarget, "{}");
  fs.symlinkSync(linkTarget, filename);
  assert.strictEqual(inspect().state, "invalid");
  await assert.rejects(register({ revision: "missing" }), /Unsafe/);
  assert.strictEqual(fs.readFileSync(linkTarget, "utf8"), "{}");
  fs.unlinkSync(filename);
  fs.symlinkSync(path.join(fixture, "missing-target"), filename);
  assert.strictEqual(inspect().state, "invalid", "dangling symlinks must not be adopted");
  fs.unlinkSync(filename);
  const nestedConfig = path.join(fixture, "linked-dir", ".copilot", "mcp-config.json");
  fs.symlinkSync(path.dirname(filename), path.join(fixture, "linked-dir"), "dir");
  assert.strictEqual(registration.inspectCopilotMcpRegistration(definition, nestedConfig).state, "invalid");

  const jsonc = registration.parseNativeMcpConfiguration('// Preserve comments in native files\n{ "servers": { "other": {"type":"http","url":"https://example.invalid",},},}');
  registration.assertNoManualPkm(jsonc, launch);
  assert.throws(() => registration.assertNoManualPkm({ servers: { pkm: {} } }, launch), /Manual VS Code MCP entry/);
  assert.throws(() => registration.assertNoManualPkm({ servers: { alias: { args: launch.args } } }, launch), /conflicts/);
  assert.throws(() => registration.parseNativeMcpConfiguration("{ invalid"), /Invalid/);
  assert.throws(() => registration.parseNativeMcpConfiguration('{"servers":{"pkm":{}},"servers":{}}'), /Duplicate/);

  const extensionSource = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
  const source = ts.createSourceFile("extension.ts", extensionSource, ts.ScriptTarget.Latest, true);
  const functionText = name => {
    const node = source.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
    assert(node, name);
    return ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  };
  let owner;
  const globalState = new Map();
  const rememberSandbox = {
    _nativeMcpProvider: false, MACHINE_STORE_PATH_KEY: "machine",
    readAccountMcpBinding: () => undefined,
    writeAccountMcpBinding: async (_root, selectedOwner) => { owner = selectedOwner; },
    vscode: {
      lm: { registerMcpServerDefinitionProvider() {} }, McpStdioServerDefinition: class {},
      ConfigurationTarget: { Global: 1 },
      workspace: { getConfiguration: () => ({ inspect: () => ({ globalValue: "/knowledge" }) }) },
    },
  };
  vm.runInNewContext(functionText("rememberMachineStorePath") + "\nthis.remember = rememberMachineStorePath;", rememberSandbox);
  await rememberSandbox.remember({ globalState: { get: key => globalState.get(key), update: async (key, value) => globalState.set(key, value) } }, "/knowledge");
  assert.strictEqual(owner, "native-provider", "first startup must not save manual-user before the native provider has registered");
  rememberSandbox.readAccountMcpBinding = () => ({ registrationOwner: "manual-user" });
  await rememberSandbox.remember({ globalState: { get: key => globalState.get(key) } }, "/knowledge");
  assert.strictEqual(owner, "manual-user", "startup must not steal explicitly manual ownership");

  const mcpSource = fs.readFileSync(path.join(root, "src/mcp/mcp.ts"), "utf8");
  const mcpFile = ts.createSourceFile("mcp.ts", mcpSource, ts.ScriptTarget.Latest, true);
  const definitionFunction = mcpFile.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === "mcpServerDefinitionData");
  const definitionSandbox = {
    exports: {}, fs: { existsSync: () => true }, path,
    managedMcpServerDirectory: () => "/knowledge/mcp-server",
    mcpRuntimePythonPath: () => "/runtime/bin/python", mcpStdioCommand: (command, args) => ({ command, args }),
    UNIFIED_MCP_VERSION: "test",
    resolveMcpPython: () => { throw new Error("Discovery cannot probe Python"); },
  };
  vm.runInNewContext(ts.transpileModule(definitionFunction.getText(mcpFile), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, definitionSandbox);
  assert.strictEqual(definitionSandbox.exports.mcpServerDefinitionData().command, "/runtime/bin/python");

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  for (const command of ["configureNativeMcpDiscovery", "registerCopilotMcp"]) {
    assert(manifest.contributes.commands.some(item => item.command === `personalKnowledge.${command}`));
    assert(extensionSource.includes(`case "${command}"`), "Config must use the same explicit reviewed command as the palette");
    const handler = extensionSource.slice(extensionSource.indexOf(`case "${command}"`)).split(/\n    case /)[0];
    assert(handler.includes('command: "mcpActionResult"') && handler.includes("cancelled: !completed"), "Config buttons need an explicit terminal result, including cancellation");
  }
  const nativeCommand = functionText("configureNativeMcpDiscovery");
  assert(manifest.dependencies["jsonc-parser"], "JSONC parsing is a production runtime dependency");
  assert(fs.readFileSync(path.join(root, ".vscodeignore"), "utf8").includes("!node_modules/jsonc-parser/**"), "VSIX must retain the JSONC parser and its runtime implementation files");
  assert(nativeCommand.includes("assertNoManualPkm") && nativeCommand.includes("showInformationMessage"));
  assert(!nativeCommand.includes("workbench.mcp.startServer"), "registration must not start or trust MCP");
  let confirmation;
  let userChoice;
  let selectedOwner;
  let refreshCount = 0;
  let manualServers;
  let nativeConfig = "{}";
  let onConfirmation;
  const commandSandbox = {
    _nativeMcpProvider: true, _storeReady: true, Buffer, process, os: require("os"),
    getStorePath: () => "/knowledge",
    mcpServerDefinitionData: () => launch,
    parseNativeMcpConfiguration: registration.parseNativeMcpConfiguration,
    assertNoManualPkm: registration.assertNoManualPkm,
    extensionHostDescription: () => "Remote extension host Linux (not local Windows)",
    refreshMcpDefinitions: () => { refreshCount++; },
    writeAccountMcpBinding: async (_root, value) => { selectedOwner = value; },
    vscode: {
      env: { remoteName: "ssh-remote" },
      Uri: { joinPath: (base, ...segments) => ({ toString: () => [base, ...segments].join("/") }) },
      workspace: {
        workspaceFolders: [{ uri: "workspace" }],
        fs: { readFile: async () => Buffer.from(nativeConfig) },
        getConfiguration: () => ({ get: () => manualServers }),
      },
      window: { showInformationMessage: async (_message, options) => { if (options?.modal) { confirmation = options.detail; onConfirmation?.(); return userChoice; } } },
    },
  };
  vm.runInNewContext(nativeCommand + "\nthis.configure = configureNativeMcpDiscovery;", commandSandbox);
  assert.strictEqual(await commandSandbox.configure({ globalStorageUri: "profile/globalStorage/pkm" }), false);
  assert.strictEqual(selectedOwner, undefined, "cancelling native setup must not change account ownership");
  assert.strictEqual(refreshCount, 0);
  assert(confirmation.includes("does not create VS Code user/workspace MCP entries"));
  userChoice = "Use Native Provider";
  manualServers = { pkm: {} };
  await assert.rejects(commandSandbox.configure({ globalStorageUri: "profile/globalStorage/pkm" }), /conflicts/);
  assert.strictEqual(selectedOwner, undefined);
  manualServers = undefined;
  nativeConfig = '{"servers":{"alias":{"args":' + JSON.stringify(launch.args) + "}}}";
  await assert.rejects(commandSandbox.configure({ globalStorageUri: "profile/globalStorage/pkm" }), /conflicts/);
  nativeConfig = "{}";
  onConfirmation = () => { nativeConfig = '{"servers":{"pkm":{}}}'; };
  await assert.rejects(commandSandbox.configure({ globalStorageUri: "profile/globalStorage/pkm" }), /conflicts/);
  assert.strictEqual(selectedOwner, undefined, "a manual entry added during review must prevent native ownership");
  onConfirmation = undefined;
  nativeConfig = "{}";
  assert.strictEqual(await commandSandbox.configure({ globalStorageUri: "profile/globalStorage/pkm" }), true);
  assert.strictEqual(selectedOwner, "native-provider");
  assert.strictEqual(refreshCount, 1);

  const scopeChoices = [];
  let scopeChoice = "none", scopeWrites = 0;
  commandSandbox.vscode.window.showQuickPick = async items => { scopeChoices.push(...items); return items.find(item => item.id === scopeChoice); };
  commandSandbox.configureNativeMcpDiscovery = async () => { scopeWrites++; return true; };
  vm.runInNewContext(functionText("configurePkmMcp") + "\nthis.configureScope = configurePkmMcp;", commandSandbox);
  assert.strictEqual(await commandSandbox.configureScope({}), false);
  assert.deepStrictEqual(scopeChoices.map(item => item.id), ["account", "profile", "workspace", "none"]);
  assert.strictEqual(scopeWrites, 0, "Do not configure must not write anything");
  scopeChoice = undefined;
  assert.strictEqual(await commandSandbox.configureScope({}), false);
  scopeChoice = "account";
  assert.strictEqual(await commandSandbox.configureScope({}), true);
  assert.strictEqual(scopeWrites, 1, "account scope uses the existing managed native provider");
  let notices = 0, configuredOffers = 0, respondToNotice;
  commandSandbox.vscode.window.showWarningMessage = () => { notices++; return new Promise(resolve => { respondToNotice = resolve; }); };
  commandSandbox.configurePkmMcp = async () => { configuredOffers++; return false; };
  vm.runInNewContext("let _mcpConfigurationOffered = false; let _mcpConfigurationOffer;\n" + functionText("offerPkmMcpConfiguration") + "\nthis.offer = offerPkmMcpConfiguration;", commandSandbox);
  const firstOffer = commandSandbox.offer({}, "Missing runtime");
  const secondOffer = commandSandbox.offer({}, "Missing tools");
  assert.strictEqual(notices, 1, "parallel discovery failures must show one notification");
  respondToNotice("Configure MCP");
  await Promise.all([firstOffer, secondOffer]);
  assert.strictEqual(configuredOffers, 1);
  await commandSandbox.offer({}, "still missing");
  assert.strictEqual(notices, 1, "declining configuration must not repeatedly interrupt Chat");

  const fileUri = filename => ({ fsPath: filename, toString: () => filename });
  const scopeRoot = path.join(fixture, "scoped-ui");
  let pickedScope = "profile", confirmScope = true, scopeOwner = "native-provider";
  const scopedContext = { globalStorageUri: fileUri(path.join(scopeRoot, "User", "globalStorage", "pkm")) };
  const scopedFolder = { name: "Project", uri: fileUri(path.join(scopeRoot, "Project")) };
  const scopeSandbox = {
    fs, process, os: require("os"), _storeReady: true,
    getStorePath: () => nativeLaunch.cwd, mcpServerDefinitionData: () => nativeLaunch,
    extensionHostDescription: () => "Windows account",
    readAccountMcpBinding: () => ({ knowledgeRoot: nativeLaunch.cwd, registrationOwner: scopeOwner }),
    writeAccountMcpBinding: async (_root, value) => { scopeOwner = value; },
    refreshMcpDefinitions: () => {},
    inspectVscodeMcpRegistration: registration.inspectVscodeMcpRegistration,
    registerVscodeMcp: registration.registerVscodeMcp,
    parseNativeMcpConfiguration: registration.parseNativeMcpConfiguration, assertNoManualPkm: registration.assertNoManualPkm,
    vscode: {
      env: {}, Uri: { joinPath: (base, ...parts) => fileUri(path.resolve(base.fsPath, ...parts)) },
      workspace: { isTrusted: true, workspaceFolders: [scopedFolder], textDocuments: [] },
      window: {
        showQuickPick: async items => items.find(item => item.id === pickedScope),
        showInformationMessage: async (_message, options) => options?.modal && confirmScope ? "Configure MCP" : undefined,
      },
    },
  };
  vm.runInNewContext(functionText("configurePkmMcp") + "\nthis.configure = configurePkmMcp;", scopeSandbox);
  confirmScope = false;
  assert.strictEqual(await scopeSandbox.configure(scopedContext), false);
  assert.strictEqual(scopeOwner, "native-provider", "declining confirmation must preserve native ownership");
  assert(!fs.existsSync(scopeRoot), "declining confirmation must not create directories or files");
  confirmScope = true;
  assert.strictEqual(await scopeSandbox.configure(scopedContext), true);
  const userMcp = path.join(scopeRoot, "User", "mcp.json");
  assert(fs.existsSync(userMcp), "user/profile selection must target this host profile, not the workspace");
  assert.strictEqual(scopeOwner, "manual-user");
  pickedScope = "workspace";
  await assert.rejects(scopeSandbox.configure(scopedContext), /conflicts/, "must not add another scope over a matching user registration");
  fs.unlinkSync(userMcp);
  assert.strictEqual(await scopeSandbox.configure(scopedContext), true);
  assert(fs.existsSync(path.join(scopedFolder.uri.fsPath, ".vscode", "mcp.json")), "workspace selection must target the selected folder");
  assert(!fs.existsSync(userMcp));

  let writerCalls = 0;
  let cliState = "missing";
  commandSandbox.copilotMcpDefinition = registration.copilotMcpDefinition;
  commandSandbox.inspectCopilotMcpRegistration = () => ({ state: cliState, revision: "reviewed", path: filename, detail: "review conflict" });
  commandSandbox.mcpStatus = () => ({ installed: true });
  commandSandbox.registerCopilotMcp = async (value, revision) => {
    assert.deepStrictEqual(value, definition);
    assert.strictEqual(revision, "reviewed");
    writerCalls++;
    return { changed: true, backup: "fixture-backup" };
  };
  vm.runInNewContext(functionText("registerCopilotMcpUserConfig") + "\nthis.registerUser = registerCopilotMcpUserConfig;", commandSandbox);
  userChoice = undefined;
  await commandSandbox.registerUser();
  assert.strictEqual(writerCalls, 0, "cancelling CLI setup must not invoke the writer");
  assert(confirmation.includes("does not register the local Windows account"));
  userChoice = "Register User Configuration";
  cliState = "conflict";
  await assert.rejects(commandSandbox.registerUser(), /review conflict/);
  assert.strictEqual(writerCalls, 0);
  cliState = "matching";
  await commandSandbox.registerUser();
  assert.strictEqual(writerCalls, 0);
  cliState = "missing";
  onConfirmation = () => { commandSandbox.mcpServerDefinitionData = () => ({ ...launch, args: [...launch.args, "--changed"] }); };
  await assert.rejects(commandSandbox.registerUser(), /launch changed during review/);
  assert.strictEqual(writerCalls, 0);
  onConfirmation = undefined;
  commandSandbox.mcpServerDefinitionData = () => launch;
  await commandSandbox.registerUser();
  assert.strictEqual(writerCalls, 1);
  assert.strictEqual(selectedOwner, "native-provider", "CLI registration must not suppress native VS Code ownership");
  console.log("MCP client registration: Windows launch/env, native startup ownership, JSONC conflict checks, user-only safe merge, backups, idempotence, revision fencing and symlink rejection OK");
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(fixture, { recursive: true, force: true }));
