#!/usr/bin/env node
const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-native-mcp-location-"));
const compiled = path.join(fixture, "mcp-native-location.js");
childProcess.execFileSync("npx", [
  "esbuild",
  path.join(root, "src", "mcp/mcp-native-location.ts"),
  "--bundle",
  "--platform=node",
  "--format=cjs",
  `--outfile=${compiled}`,
], { cwd: root, stdio: "ignore" });

const { nativeMcpCwdUri } = require(compiled);

class TestUri {
  constructor(scheme, authority, uriPath) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = uriPath;
  }

  with(change) {
    return new TestUri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      this.path,
    );
  }
}

const fileUri = value => new TestUri("file", "", value.replace(/\\/g, "/"));
const localExtension = new TestUri("file", "", "/home/person/.vscode/extensions/pkm");
const localCwd = nativeMcpCwdUri(localExtension, "/home/person/pkm/mcp-server", fileUri);
assert.deepStrictEqual(
  { scheme: localCwd.scheme, authority: localCwd.authority, path: localCwd.path },
  { scheme: "file", authority: "", path: "/home/person/pkm/mcp-server" },
  "local MCP definitions must retain a local file URI",
);

const remoteExtension = new TestUri(
  "vscode-remote",
  "ssh-remote+build-host",
  "/home/person/.vscode-server/extensions/pkm",
);
const remoteCwd = nativeMcpCwdUri(remoteExtension, "/home/person/pkm/mcp-server", fileUri);
assert.deepStrictEqual(
  { scheme: remoteCwd.scheme, authority: remoteCwd.authority, path: remoteCwd.path },
  {
    scheme: "vscode-remote",
    authority: "ssh-remote+build-host",
    path: "/home/person/pkm/mcp-server",
  },
  "remote MCP definitions must launch on the extension host instead of the local UI machine",
);

const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
assert.match(
  extensionSource,
  /definition\.cwd = nativeMcpCwdUri\(context\.extensionUri, data\.cwd, vscode\.Uri\.file\)/,
  "the native MCP provider must route cwd through the remote-aware helper",
);
assert.doesNotMatch(
  extensionSource,
  /definition\.cwd = vscode\.Uri\.file\(data\.cwd\)/,
  "the native MCP provider must not erase the remote extension-host authority",
);

const vm = require("vm");
const ts = require("typescript");
const providerStart = extensionSource.indexOf("function registerNativeMcpProvider(");
const providerEnd = extensionSource.indexOf("/** Open an item", providerStart);
assert(providerStart >= 0 && providerEnd > providerStart);
let provider;
let knowledgeRoot = "";
let providerBinding;
const registrationContext = { extensionUri: remoteExtension, subscriptions: [] };
const api = {
  lm: { registerMcpServerDefinitionProvider: (id, value) => { provider = value; return { dispose() {} }; } },
  McpStdioServerDefinition: class { constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); } },
  EventEmitter: class { event() {} dispose() {} },
  Uri: { file: fileUri },
  commands: { registerCommand: () => ({ dispose() {} }) },
};
vm.runInNewContext(ts.transpileModule(extensionSource.slice(providerStart, providerEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText + "\nregisterNativeMcpProvider(context);", {
  vscode: api, context: registrationContext, _mcpDefinitionsChanged: undefined, _nativeMcpProvider: false,
  getStorePath: () => knowledgeRoot,
  readAccountMcpBinding: () => providerBinding,
  mcpRuntimeStatus: () => { throw new Error("Discovery must not run a synchronous Python health check"); },
  mcpServerDefinitionData: () => ({ label: "pkm", command: "/managed/python", args: ["/knowledge/mcp-server/server.py"], cwd: "/knowledge/mcp-server", version: "fixture" }),
  nativeMcpCwdUri,
});
assert.strictEqual(provider.provideMcpServerDefinitions().length, 0);
knowledgeRoot = "/knowledge";
const definitions = provider.provideMcpServerDefinitions();
assert.strictEqual(definitions.length, 1, "a configured machine root must remain discoverable without a workspace or a health probe");
assert.strictEqual(definitions[0].cwd.authority, remoteExtension.authority);
providerBinding = { registrationOwner: "manual-user", knowledgeRoot: "/knowledge" };
assert.strictEqual(provider.provideMcpServerDefinitions().length, 0, "an account's manual adapter must suppress the duplicate native definition");
assert.throws(() => provider.resolveMcpServerDefinition(), /manual adapter/);
providerBinding = undefined;
assert.match(extensionSource, /_storeReady = true;[\s\S]*?_treeProvider\?\.refresh\(\);\s*refreshMcpDefinitions\(\);/, "store initialization must notify existing MCP definition subscribers");

const rememberStart = extensionSource.indexOf("async function rememberMachineStorePath(");
const rememberEnd = extensionSource.indexOf("\nlet _panelReady", rememberStart);
assert(rememberStart >= 0 && rememberEnd > rememberStart);
let globalPath;
const globalWrites = [];
const globalState = new Map();
const remember = vm.runInNewContext(ts.transpileModule(extensionSource.slice(rememberStart, rememberEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText + "\nrememberMachineStorePath;", {
  MACHINE_STORE_PATH_KEY: "machineRoot",
  _nativeMcpProvider: true,
  readAccountMcpBinding: () => undefined,
  writeAccountMcpBinding: async () => {},
  vscode: {
    ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: () => ({
      get: () => "/knowledge",
      inspect: () => ({ workspaceValue: "/knowledge", globalValue: globalPath }),
      update: async (key, value, target) => { globalWrites.push({ key, value, target }); globalPath = value; },
    }) },
  },
});
const rootContext = { globalState: { get: key => globalState.get(key), update: async (key, value) => { globalState.set(key, value); } } };
(async () => {
  const accountCompiled = path.join(fixture, "mcp-account-binding.js");
  childProcess.execFileSync("npx", ["esbuild", path.join(root, "src/mcp/mcp-account-binding.ts"), "--bundle", "--platform=node", "--format=cjs", `--outfile=${accountCompiled}`], { cwd: root, stdio: "ignore" });
  const account = require(accountCompiled);
  const accountDirectory = path.join(fixture, "account");
  const rootA = path.join(fixture, "knowledge-a");
  const rootB = path.join(fixture, "knowledge-b");
  fs.mkdirSync(rootA, { mode: 0o700 });
  fs.mkdirSync(rootB, { mode: 0o700 });
  const binding = await account.writeAccountMcpBinding(rootA, "native-provider", false, accountDirectory);
  assert.deepStrictEqual(account.readAccountMcpBinding(accountDirectory), binding);
  assert.strictEqual(binding.knowledgeRoot, fs.realpathSync(rootA));
  await assert.rejects(account.writeAccountMcpBinding(rootB, "native-provider", false, accountDirectory), /cannot redirect/);
  await assert.rejects(account.writeAccountMcpBinding(rootA, "manual-user", false, accountDirectory), /registration owner/);
  const changed = await account.writeAccountMcpBinding(rootB, "native-provider", true, accountDirectory);
  assert.strictEqual(changed.accountId, binding.accountId, "explicit root changes must preserve account identity");
  if (process.platform !== "win32") {
    assert.strictEqual(fs.statSync(accountDirectory).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(path.join(accountDirectory, "mcp-binding.json")).mode & 0o777, 0o600);
    assert.strictEqual(account.accountKnowledgeSecurity(rootB).private, true);
    fs.chmodSync(path.join(accountDirectory, "mcp-binding.json"), 0o644);
    assert.throws(() => account.readAccountMcpBinding(accountDirectory), /owner-only permissions/);
    fs.chmodSync(path.join(accountDirectory, "mcp-binding.json"), 0o600);
  }
  await remember(rootContext, "/knowledge");
  assert.deepStrictEqual(globalWrites, [{ key: "storePath", value: "/knowledge", target: 1 }], "a matching workspace value must not hide a missing global root");
  await remember(rootContext, "/knowledge");
  assert.strictEqual(globalWrites.length, 1, "an existing global root must not be rewritten");
  fs.rmSync(fixture, { recursive: true, force: true });
  console.log("native MCP remote location and global-root tests passed");
})().catch(error => { fs.rmSync(fixture, { recursive: true, force: true }); console.error(error); process.exitCode = 1; });
