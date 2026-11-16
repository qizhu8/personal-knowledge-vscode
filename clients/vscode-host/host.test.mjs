import assert from "node:assert/strict";
import { createServer } from "node:http";
import Module, { createRequire } from "node:module";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { cp, mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const bearer = "s".repeat(40);

function fakeVscode() {
  const commands = new Map(), panels = [], messages = [], warnings = [], output = [], providers = new Map();
  const global = {}, workspace = {};
  const secrets = new Map(), keys = [];
  const subscriptions = [];
  const configurationListeners = new Set();
  let input;
  const selections = [], confirmations = [], information = [];
  const api = {
    EventEmitter: class {
      listeners = new Set();
      event = listener => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
      fire() { for (const listener of this.listeners) listener(); }
      dispose() { this.listeners.clear(); }
    },
    Uri: { file: fsPath => ({ fsPath }) },
    McpStdioServerDefinition: class {
      constructor(label, command, args, env) { Object.assign(this, { label, command, args, env }); }
    },
    lm: { registerMcpServerDefinitionProvider(id, provider) {
      assert(!providers.has(id));
      providers.set(id, provider);
      return { dispose() { providers.delete(id); } };
    } },
    workspace: {
      getConfiguration: () => ({ inspect: name => ({ globalValue: global[name], workspaceValue: workspace[name] }) }),
      onDidChangeConfiguration: listener => {
        configurationListeners.add(listener);
        return { dispose() { configurationListeners.delete(listener); } };
      },
    },
    commands: { registerCommand(id, handler) {
      assert(!commands.has(id));
      commands.set(id, handler);
      return { dispose() { commands.delete(id); } };
    } },
    ViewColumn: { One: 1 },
    window: {
      showErrorMessage: async message => { messages.push(message); },
      showWarningMessage: async message => { warnings.push(message); return confirmations.shift(); },
      showInformationMessage: async message => { information.push(message); },
      showOpenDialog: async () => selections.shift(),
      showSaveDialog: async () => selections.shift(),
      createOutputChannel: () => ({ appendLine: line => output.push(line), show() {}, dispose() {} }),
      showInputBox: async () => input,
      createWebviewPanel() {
        let listener, onDispose, disposed = false;
        const sent = [];
        const panel = {
          sent,
          webview: {
            html: "",
            onDidReceiveMessage(fn) { listener = fn; return { dispose() { listener = undefined; } }; },
            postMessage: async message => { sent.push(message); return true; },
          },
          onDidDispose(fn) { onDispose = fn; },
          emit(message) { listener?.(message); },
          dispose() { if (!disposed) { disposed = true; onDispose?.(); } },
        };
        panels.push(panel);
        return panel;
      },
    },
  };
  const context = { extensionPath: fileURLToPath(new URL(".", import.meta.url)),
    globalStorageUri: { fsPath: fileURLToPath(new URL(".", import.meta.url)) }, subscriptions, secrets: {
    async get(key) { keys.push(key); return secrets.get(key); },
    async store(key, value) { keys.push(key); secrets.set(key, value); },
  } };
  return { api, context, commands, panels, messages, warnings, output, providers, global, workspace, keys, selections, confirmations, information,
    configurationChanged: section => configurationListeners.forEach(listener => listener({
      affectsConfiguration: candidate => section === candidate || section.startsWith(`${candidate}.`),
    })), setInput: value => { input = value; } };
}

function activate(fake) {
  const load = Module._load;
  try {
    Module._load = function (id, ...args) { return id === "vscode" ? fake.api : load.call(this, id, ...args); };
    delete require.cache[require.resolve("./dist/extension.cjs")];
    return require("./dist/extension.cjs").activate(fake.context);
  } finally { Module._load = load; }
}

async function server(t, options = {}) {
  const requests = [];
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    requests.push({ path: req.url, body: data, authorization: req.headers.authorization });
    let result, error;
    if (req.url === "/v1/server_info") result = {
      name: "pkm-v5", serverId: "pkm-v5", workspaceId: "workspace-1", actorId: "actor-1",
      workspaceVersion: "pkm.next-workspace/v2", protocolVersion: "v1", catalogRevision: "revision",
      storage: { workspaceSchema: "pkm.next-workspace/v2", authority: "Markdown" },
    };
    else if (req.url === "/v1/capabilities_describe") {
      if (data.operation === "knowledge.document.list")
        result = { operation: data.operation, version: 1, readOnly: true, catalogRevision: "revision" };
      else if (options.beforeWrite && data.operation === "chat.session.create")
        result = { operation: data.operation, version: 1, readOnly: false, catalogRevision: "revision" };
      else error = { code: "NOT_FOUND", effect: "not-committed" };
    } else if (req.url === "/v1/capability_read") {
      if (options.beforeRead) await options.beforeRead();
      result = { items: [{ title: "<img src=x onerror=alert(1)>" }], total: 1, nextOffset: null, workspaceRevision: "revision" };
    } else if (req.url === "/v1/capability_call" && options.beforeWrite) {
      await options.beforeWrite();
      result = { id: data.arguments.id };
    } else error = { code: "NOT_FOUND", effect: "not-committed" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ schema: "pkm.next-result/v1", requestId: "request", ...(result ? { result } : { error }) }));
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  return { origin: `http://127.0.0.1:${http.address().port}`, requests };
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for webview reply");
}

test("host wires secrets, independently provisioned identity, commands and isolated panels", async t => {
  const fixture = await server(t), fake = fakeVscode();
  Object.assign(fake.global, { origin: fixture.origin, workspaceId: "workspace-1", actorId: "actor-1" });
  Object.assign(fake.workspace, { origin: "http://example.com:9000", actorId: "attacker" });
  activate(fake);
  t.after(() => fake.context.subscriptions.forEach(item => item.dispose()));
  assert(!fake.commands.has("pkm.next.openHumanReview"));
  fake.setInput(bearer);
  await fake.commands.get("pkm.nextHost.setToken")();
  await fake.commands.get("pkm.next.connect")();
  assert.equal(fake.messages.length, 0);
  assert(fake.keys.every(key => key === "pkm.next-host.bearer"));
  assert(fixture.requests.every(req => req.authorization === `Bearer ${bearer}`));
  await fake.commands.get("pkm.nextHost.open")();
  await fake.commands.get("pkm.nextHost.open")();
  const [first, second] = fake.panels;
  assert.match(first.webview.html, /default-src 'none'/);
  assert.match(first.webview.html, /textContent/);
  first.emit({ requestId: "one", action: "knowledgeList", input: {} });
  await waitFor(() => first.sent.length === 1);
  assert.equal(first.sent[0].result.items.length, 1);
  assert.equal(second.sent.length, 0);
  second.emit({ requestId: "two", action: "knowledgeList", input: { endpoint: "http://example.com" } });
  await waitFor(() => second.sent.length === 1);
  assert.equal(second.sent[0].error.code, "INVALID_ARGUMENT");
  first.emit({ requestId: "three", action: "openHumanReview", input: {} });
  await waitFor(() => first.sent.length === 2);
  assert.equal(first.sent[1].error.code, "INVALID_ACTION");
  assert(!JSON.stringify([first.sent, second.sent, fake.messages]).includes(bearer));
  first.dispose();
  first.emit({ requestId: "four", action: "state", input: {} });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(first.sent.length, 2);
  await fake.commands.get("pkm.next.disconnect")();
  second.emit({ requestId: "five", action: "state", input: {} });
  assert.equal(second.sent.length, 1);
  fake.context.subscriptions.forEach(item => item.dispose());
  assert.equal(fake.commands.size, 0);
});

test("host rejects workspace configuration authority, unsafe origins and mismatched attestation", async t => {
  const fixture = await server(t), fake = fakeVscode();
  activate(fake);
  t.after(() => fake.context.subscriptions.forEach(item => item.dispose()));
  fake.setInput(bearer);
  await fake.commands.get("pkm.nextHost.setToken")();
  Object.assign(fake.workspace, { origin: fixture.origin, workspaceId: "workspace-1", actorId: "actor-1" });
  await fake.commands.get("pkm.next.connect")();
  assert.equal(fixture.requests.length, 0);
  Object.assign(fake.global, { origin: "http://example.com:80", workspaceId: "workspace-1", actorId: "actor-1" });
  await fake.commands.get("pkm.next.connect")();
  assert.equal(fixture.requests.length, 0);
  Object.assign(fake.global, { origin: fixture.origin, actorId: "wrong-actor" });
  await fake.commands.get("pkm.next.connect")();
  assert.equal(fixture.requests.length, 1);
  await fake.commands.get("pkm.nextHost.open")();
  assert.equal(fake.panels.length, 0);
  assert(!JSON.stringify(fake.messages).includes(bearer));
});

test("host native MCP registration leaves pkm intact and ignores workspace-only root selection", async () => {
  const fake = fakeVscode(), old = {}, providers = new Map([["pkm", old]]);
  fake.workspace.managedRoot = "/untrusted-workspace-managed-root";
  fake.api.Uri = { file: fsPath => ({ fsPath }) };
  fake.api.McpStdioServerDefinition = class {
    constructor(label, command, args, env) { Object.assign(this, { label, command, args, env }); }
  };
  fake.api.lm = { registerMcpServerDefinitionProvider(id, provider) {
    assert(!providers.has(id));
    providers.set(id, provider);
    return { dispose() { providers.delete(id); } };
  } };
  activate(fake);
  try {
    const provider = providers.get("pkm-v5");
    assert(provider, "activation must register the distinct public provider");
    const manifest = JSON.parse(await readFile(new URL("package.json", import.meta.url), "utf8"));
    const registered = [...providers].find(([, candidate]) => candidate === provider)[0];
    assert(manifest.contributes.mcpServerDefinitionProviders.some(item => item.id === registered && item.label === "pkm-v5"),
      "the native API requires the registered ID to be contributed by this extension");
    assert(manifest.activationEvents.includes(`onMcpCollection:${registered}`),
      "VS Code's contribution generator and discovery service use onMcpCollection:<id>");
    let changes = 0;
    const changed = provider.onDidChangeMcpServerDefinitions(() => { changes++; });
    fake.configurationChanged("unrelated.setting");
    assert.equal(changes, 0);
    fake.configurationChanged("pkm.nextHost.managedRoot");
    assert.equal(changes, 1, "root provisioning must trigger native rediscovery without reload");
    fake.configurationChanged("pkm.nextHost.productionCoordinator.enabled");
    assert.equal(changes, 2, "same-root coordinator changes must invalidate isolated discovery");
    changed.dispose();
    assert.deepEqual(await provider.provideMcpServerDefinitions(), []);
    assert.equal(providers.get("pkm"), old);
    assert.equal(fake.keys.length, 0, "discovery must not access the old or new token storage");
  } finally { fake.context.subscriptions.forEach(item => item.dispose()); }
  assert.equal(providers.has("pkm-v5"), false);
  assert.equal(providers.get("pkm"), old);
});

test("host reports unsupported native MCP APIs in standard output and native error notification", () => {
  const fake = fakeVscode();
  delete fake.api.McpStdioServerDefinition;
  activate(fake);
  try {
    assert.equal(fake.providers.size, 0);
    assert(fake.output.some(line => /MCP_API_UNAVAILABLE.*1\.101\.0/.test(line)));
    assert(fake.messages.some(message => /pkm-v5 native MCP is unavailable.*1\.101\.0/.test(message)));
    assert.equal(fake.keys.length, 0);
    assert(fake.commands.has("pkm.next.connect"), "an explicit MCP feature failure must not silently remove unrelated HTTP commands");
  } finally { fake.context.subscriptions.forEach(item => item.dispose()); }
});

test("active coordinator is off by default, ignores workspace enablement and requires reload for global changes", async t => {
  const fake = fakeVscode();
  fake.workspace.productionCoordinator = { enabled: true, root: "/untrusted-workspace-root" };
  activate(fake);
  t.after(() => fake.context.subscriptions.forEach(item => item.dispose()));
  const state = fake.commands.get("pkm.nextHost.productionState");
  assert.equal(state().enabled, false);
  assert.equal(state().status, "disabled");
  await assert.rejects(fake.commands.get("pkm.nextHost.productionPreview")(), /disabled/);
  fake.global.productionCoordinator = { enabled: true, root: "/explicit-root" };
  await assert.rejects(fake.commands.get("pkm.nextHost.productionPreview")(), /Reload/);
  assert.equal(fake.panels.length, 0);
  for (const suffix of ["Transition", "Read", "Rollback", "Disconnect"])
    assert(fake.commands.has(`pkm.nextHost.production${suffix}`));
});

test("active coordinator rejects caller-supplied profile and build overrides instead of trusting them", async t => {
  const fake = fakeVscode();
  activate(fake);
  t.after(() => fake.context.subscriptions.forEach(item => item.dispose()));
  for (const override of [{ profile: "/forged-profile" }, { buildId: "0".repeat(64) }, { authority: true }]) {
    fake.global.productionCoordinator = { enabled: true, root: "/explicit-root", ...override };
    await assert.rejects(fake.commands.get("pkm.nextHost.productionPreview")(), /overrides are forbidden/);
  }
  assert.equal(fake.panels.length, 0);
});

test("the installed activation exports only an exact-context check and revokes it on disposal", () => {
  const fake = fakeVscode();
  const exports = activate(fake);
  exports.assertActiveMigrationContext(fake.context);
  assert.throws(() => exports.assertActiveMigrationContext({ ...fake.context }), /not this live extension activation/);
  assert.throws(() => exports.assertActiveMigrationContext(JSON.parse(JSON.stringify({
    extensionPath: fake.context.extensionPath, globalStorageUri: fake.context.globalStorageUri,
  }))), /not this live extension activation/);
  fake.context.subscriptions.forEach(item => item.dispose());
  assert.throws(() => exports.assertActiveMigrationContext(fake.context), /not this live extension activation/);
});

test("disconnect aborts in-flight panel work and suppresses late replies", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const fixture = await server(t, { beforeRead: () => gate }), fake = fakeVscode();
  Object.assign(fake.global, { origin: fixture.origin, workspaceId: "workspace-1", actorId: "actor-1" });
  activate(fake);
  t.after(() => fake.context.subscriptions.forEach(item => item.dispose()));
  fake.setInput(bearer);
  await fake.commands.get("pkm.nextHost.setToken")();
  await fake.commands.get("pkm.next.connect")();
  await fake.commands.get("pkm.nextHost.open")();
  const panel = fake.panels[0];
  panel.emit({ requestId: "slow", action: "knowledgeList", input: {} });
  await waitFor(() => fixture.requests.some(req => req.path === "/v1/capability_read"));
  await fake.commands.get("pkm.next.disconnect")();
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(panel.sent, []);
});

test("disconnect reports in-flight write IDs without logging secrets or request bodies", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const fixture = await server(t, { beforeWrite: () => gate }), fake = fakeVscode();
  Object.assign(fake.global, { origin: fixture.origin, workspaceId: "workspace-1", actorId: "actor-1" });
  activate(fake);
  t.after(() => fake.context.subscriptions.forEach(item => item.dispose()));
  fake.setInput(bearer);
  await fake.commands.get("pkm.nextHost.setToken")();
  await fake.commands.get("pkm.next.connect")();
  await fake.commands.get("pkm.nextHost.open")();
  const operationId = "6a76fc20-96e4-4d01-a964-cc8b6a600f08";
  fake.panels[0].emit({ requestId: "write", action: "chatCreate", input: {
    id: "session", operationId, expectedRevision: 0, title: "private title",
  } });
  await waitFor(() => fixture.requests.some(req => req.path === "/v1/capability_call"));
  await fake.commands.get("pkm.next.disconnect")();
  assert.equal(fake.warnings.length, 1);
  assert.match(fake.output.join("\n"), new RegExp(operationId));
  assert.match(fake.output.join("\n"), /Reconcile server receipts/);
  assert(!JSON.stringify([fake.output, fake.warnings]).includes(bearer));
  assert(!JSON.stringify([fake.output, fake.warnings]).includes("private title"));
  release();
  await fake.commands.get("pkm.next.connect")();
  assert.equal(fixture.requests.filter(req => req.path === "/v1/capability_call").length, 1);
});

async function tree(root) {
  const result = {};
  async function walk(path, prefix = "") {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = `${prefix}${entry.name}`;
      result[key] = entry.isDirectory() ? "directory" : createHash("sha256").update(await readFile(join(path, entry.name))).digest("hex");
      if (entry.isDirectory()) await walk(join(path, entry.name), `${key}/`);
    }
  }
  await walk(root);
  return result;
}

test("native-inventory harness: legacy cohosting revokes consent and never certifies a cold writer boundary", async t => {
  const root = fileURLToPath(new URL(`.cohosting-fixture-${randomUUID()}/`, import.meta.url));
  const installedPath = join(root, "installed"), source = join(root, "source");
  await mkdir(join(source, "notes"), { recursive: true, mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(source, "notes", "Existing.md"),
    "---\ntitle: Existing\ndocumentId: synthetic-note\nrevision: 1\n---\nUnchanged synthetic root.\n");
  await cp(new URL("next-runtime/", import.meta.url), join(installedPath, "next-runtime"), { recursive: true });
  await cp(new URL("dist/", import.meta.url), join(installedPath, "dist"), { recursive: true });
  await cp(new URL("package.json", import.meta.url), join(installedPath, "package.json"));
  const core = join(installedPath, "next-runtime/server/dist");
  const bridge = await import(pathToFileURL(join(core, "active-vscode-migration-host.js")).href);
  const gate = await import(pathToFileURL(join(core, "linux-legacy-writer-quiescence.js")).href);
  const adoption = await import(pathToFileURL(join(core, "legacy-root-adoption.js")).href);
  const original = await tree(source);
  const legacy = { id: "Uone.personal-knowledge", extensionPath: join(root, "old-pkm"), isActive: false,
    packageJSON: { publisher: "Uone", name: "personal-knowledge", main: "./dist/extension.js" } };
  await mkdir(join(legacy.extensionPath, "dist"), { recursive: true });
  await writeFile(join(legacy.extensionPath, "package.json"), JSON.stringify(legacy.packageJSON));
  await writeFile(join(legacy.extensionPath, "dist/extension.js"), "// Synthetic old entrypoint identity.\n");

  const activation = async (test, extras = []) => {
    const fake = fakeVscode(), listeners = new Set();
    const profile = join(root, `profile-${randomUUID()}`);
    const installed = { id: "pkm-nonproduction.pkm-v5", extensionPath: installedPath, isActive: true,
      packageJSON: JSON.parse(await readFile(join(installedPath, "package.json"), "utf8")) };
    const inventory = [installed, ...extras];
    Object.assign(fake.context, { extensionPath: installedPath, extension: installed, globalStorageUri: { fsPath: profile } });
    fake.global.productionCoordinator = { enabled: true, root: source };
    Object.assign(fake.api.workspace, { isTrusted: true, onDidChangeWorkspaceFolders: () => ({ dispose() {} }) });
    fake.api.extensions = {
      all: inventory, getExtension: id => inventory.find(item => item.id === id),
      onDidChange(callback) { listeners.add(callback); return { dispose() { listeners.delete(callback); } }; },
    };
    const native = async work => {
      const load = Module._load;
      try {
        Module._load = function(id, ...args) {
          return id === "vscode" ? fake.api : load.call(this, id, ...args);
        };
        return await work();
      } finally { Module._load = load; }
    };
    const entry = join(installedPath, "dist/extension.cjs");
    delete require.cache[require.resolve(entry)];
    installed.exports = await native(() => require(entry).activate(fake.context));
    test.after(() => fake.context.subscriptions.forEach(item => item.dispose()));
    return { fake, inventory, profile, native, changed: () => [...listeners].forEach(callback => callback()),
      host: () => native(() => bridge.activateActiveVscodeMigrationHost(fake.context)) };
  };
  const intent = { action: "adopt", sourceRoot: source, planSha256: "a".repeat(64) };
  const consent = async (test, fixture) => {
    const host = await fixture.host();
    test.after(() => host.dispose());
    await host.drain();
    fixture.fake.confirmations.push("Approve exact same-root transition");
    const grant = await host.requestMigrationApproval(intent);
    bridge.assertActiveVscodeMigrationGrant(host, grant, source, intent);
    return { host, grant };
  };

  for (const isActive of [false, true]) await t.test(`old PKM ${isActive ? "active" : "inactive"} blocks the actual command before root/profile effects`, async test => {
    const fixture = await activation(test, [{ ...legacy, isActive }]);
    await assert.rejects(fixture.native(() => fixture.fake.commands.get("pkm.nextHost.productionPreview")()),
      /native inventory includes Uone.personal-knowledge/);
    await assert.rejects(readdir(fixture.profile), { code: "ENOENT" });
    assert.deepEqual(await tree(source), original);
  });
  await t.test("native entrypoint aliases into the legacy build are not retained-payload utilities", async test => {
    const fixture = await activation(test, [{
      id: "another.entrypoint", extensionPath: root, isActive: false,
      packageJSON: { publisher: "another", name: "entrypoint", main: join(legacy.extensionPath, "dist/extension.js") },
    }]);
    await assert.rejects(fixture.host(), /entrypoint resolves into an installed legacy PKM build/);
    await assert.rejects(readdir(fixture.profile), { code: "ENOENT" });
    assert.deepEqual(await tree(source), original);
  });
  await t.test("unsupported transition fails before any consent/drain and leaves read-only preview usable", async test => {
    const fixture = await activation(test);
    const invoke = suffix => fixture.native(() => fixture.fake.commands.get(`pkm.nextHost.production${suffix}`)());
    const preview = await invoke("Preview");
    assert.equal(preview.writerBoundary, "cold-host-unproven");
    assert.equal(preview.installedLegacyTakeover, false);
    const profileBefore = await tree(fixture.profile);
    await assert.rejects(invoke("Transition"), /cold-host boundary is unproven/);
    assert.equal(fixture.fake.warnings.length, 0, "Known-unsupported operations must not ask for native consent.");
    assert.deepEqual(await tree(fixture.profile), profileBefore, "No grants or durable migration intent are created.");
    assert.deepEqual(await tree(source), original);
    const retry = await invoke("Preview");
    assert.equal(retry.planSha256, preview.planSha256, "Admission was not drained by the blocked transition.");
  });
  await t.test("unrelated extension changes preserve consent, but cannot exempt the PID or establish cold history", async test => {
    const fixture = await activation(test), { host, grant } = await consent(test, fixture);
    fixture.inventory.push({ id: "another.extension", extensionPath: root, isActive: false,
      packageJSON: { publisher: "another", name: "extension", main: "./dist/extension.js" } },
    { id: "another.retained-utility", extensionPath: installedPath, isActive: false,
      packageJSON: { main: "./next-runtime/server/legacy/dist/runtime/managed-writer-session.js" } });
    fixture.changed();
    bridge.assertActiveVscodeMigrationGrant(host, grant, source, intent);
    assert.equal(host.signal.aborted, false);
    assert.throws(() => bridge.assertActiveVscodeMigrationGrant(host, { ...grant }, source), /approval/);
    const duplicate = await import(`${pathToFileURL(join(core, "active-vscode-migration-host.js")).href}?duplicate-instance`);
    assert.throws(() => duplicate.assertActiveVscodeMigrationGrant(host, grant, source), /authentic/);
    assert.equal(host.writerBoundary, "cold-host-unproven");
    assert.throws(() => gate.bindLinuxActiveVscodeMigrationHost({ host, grant }),
      error => error.code === "LEGACY_WRITER_INVENTORY_UNAVAILABLE" && /cold-host boundary is unproven/.test(error.message));
    await assert.rejects(adoption.prepareLegacyRootAdoptionExperimental(source, {
      activeVscodeMigration: { host, grant },
    }), { code: "LEGACY_WRITER_INVENTORY_UNAVAILABLE" });
    assert.deepEqual(await tree(source), original);
  });
  await t.test("a legacy inventory change permanently revokes already-issued consent", async test => {
    const fixture = await activation(test), { host, grant } = await consent(test, fixture);
    fixture.inventory.push(legacy);
    fixture.changed();
    assert.equal(host.signal.aborted, true);
    fixture.inventory.pop();
    fixture.changed();
    assert.throws(() => bridge.assertActiveVscodeMigrationGrant(host, grant, source), /revoked/);
    assert.throws(() => gate.bindLinuxActiveVscodeMigrationHost({ host, grant }), /revoked/);
    assert.deepEqual(await tree(source), original);
  });
  await t.test("grant validation re-reads native inventory even before its change event arrives", async test => {
    const fixture = await activation(test), { host, grant } = await consent(test, fixture);
    fixture.inventory.push({ ...legacy, id: "renamed.wrapper" });
    assert.throws(() => bridge.assertActiveVscodeMigrationGrant(host, grant, source), /native inventory includes/);
    assert.equal(host.signal.aborted, true);
    fixture.inventory.pop();
    assert.throws(() => bridge.assertActiveVscodeMigrationGrant(host, grant, source), /revoked/);
    assert.deepEqual(await tree(source), original);
  });
  await t.test("legacy arriving during native consent cannot publish a grant", async test => {
    const fixture = await activation(test), host = await fixture.host();
    test.after(() => host.dispose());
    await host.drain();
    fixture.fake.api.window.showWarningMessage = async (_message, _options, label) => {
      fixture.inventory.push(legacy);
      return label;
    };
    await assert.rejects(host.requestMigrationApproval(intent), /native inventory includes/);
    assert.equal(host.signal.aborted, true);
    assert.deepEqual(await tree(source), original);
  });
});

test("packaged first-run commands: cancel/deny/blockers write nothing; confirmation binds inspected source, destination and digest", async t => {
  const root = fileURLToPath(new URL(`.first-run-fixture-${randomUUID()}/`, import.meta.url));
  await mkdir(root, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, "installed");
  await cp(fileURLToPath(new URL("dist/", import.meta.url)), join(installed, "dist"), { recursive: true });
  await cp(fileURLToPath(new URL("next-runtime/", import.meta.url)), join(installed, "next-runtime"), { recursive: true });
  const manifest = JSON.parse(await readFile(new URL("package.json", import.meta.url), "utf8"));
  for (const suffix of ["importPreview", "importConfirm"]) {
    assert(manifest.activationEvents.includes(`onCommand:pkm.nextHost.${suffix}`));
    assert(manifest.contributes.commands.some(item => item.command === `pkm.nextHost.${suffix}`));
  }
  const source = join(root, "disposable"), destination = join(root, "new-workspace");
  await mkdir(join(source, "notes"), { recursive: true });
  const note = join(source, "notes", "Example.md");
  await writeFile(note, "---\nid: migration-fixture\ntitle: First-run fixture\n---\nFixture bytes.\n");
  const fake = fakeVscode();
  fake.context.extensionPath = installed;
  // Load only the copied extension and copied helper, not next-server/dist.
  const load = Module._load;
  try {
    Module._load = function (id, ...args) { return id === "vscode" ? fake.api : load.call(this, id, ...args); };
    require(join(installed, "dist", "extension.cjs")).activate(fake.context);
  } finally { Module._load = load; }
  t.after(() => fake.context.subscriptions.forEach(item => item.dispose()));
  const invoke = suffix => fake.commands.get(`pkm.nextHost.${suffix}`)();
  const uri = fsPath => ({ scheme: "file", fsPath });
  const select = (target = destination) => fake.selections.push(
    [uri(source)], uri(target), [uri(process.execPath)], [uri("/usr/bin/python3")]);
  const initial = await tree(root);
  await invoke("importPreview"); // Source picker cancellation.
  assert.deepEqual(await tree(root), initial);
  select();
  await invoke("importPreview"); // Disposable-copy acknowledgement denied.
  assert.deepEqual(await tree(root), initial);
  await t.test("pending consent still holds the guard and cannot authorize publication", async () => {
    const warning = fake.api.window.showWarningMessage;
    const consent = Promise.withResolvers();
    let requested = false, completed = false;
    fake.api.window.showWarningMessage = (message, options, ...items) => {
      if (options?.modal && items.includes("Inspect disposable copy")) {
        fake.warnings.push(message); requested = true; return consent.promise;
      }
      return warning(message, options, ...items);
    };
    select();
    const preview = invoke("importPreview").then(() => { completed = true; });
    try {
      await waitFor(() => requested);
      assert.equal(completed, false);
      await invoke("importConfirm");
      assert.match(fake.warnings.at(-1), /already running/);
      assert.deepEqual(await tree(root), initial);
      assert(!fake.output.some(line => line.startsWith("{")), "inspection must await consent");
    } finally {
      consent.resolve(undefined);
      await preview;
      fake.api.window.showWarningMessage = warning;
    }
    assert.deepEqual(await tree(root), initial, "denied consent must not write");
  });
  await t.test("ready preview completes and releases busy while its advisory remains open", async () => {
    const information = fake.api.window.showInformationMessage;
    const notice = Promise.withResolvers();
    let shown = false, completed = false;
    fake.api.window.showInformationMessage = message => {
      fake.information.push(message); shown = true; return notice.promise;
    };
    select();
    fake.confirmations.push("Inspect disposable copy");
    const preview = invoke("importPreview").then(() => { completed = true; });
    try {
      await waitFor(() => shown);
      await waitFor(() => completed);
      assert.deepEqual(await tree(root), initial);
      await invoke("importConfirm"); // Final consent remains mandatory; denial writes nothing.
      assert.match(fake.warnings.at(-1), /Create and publish a NEW isolated workspace/);
      assert.deepEqual(await tree(root), initial);
    } finally {
      notice.resolve(undefined);
      await preview;
      fake.api.window.showInformationMessage = information;
    }
  });
  assert.equal(fake.messages.length, 0, fake.messages.join("\n"));
  const inspected = JSON.parse(fake.output.find(line => line.startsWith("{")));
  assert.equal(inspected.plan.ready, true, JSON.stringify(inspected));
  assert.equal(inspected.source, source);
  assert.equal(inspected.destination, destination);
  assert.deepEqual(await tree(root), initial);
  await invoke("importConfirm"); // Denial consumes the plan.
  assert.deepEqual(await tree(root), initial);
  assert.match(fake.warnings.at(-1), /No ready inspected plan/);

  await t.test("advisory rejection is logged without invalidating the ready inspected plan", async () => {
    const information = fake.api.window.showInformationMessage, log = console.error;
    const failure = new Error("notification delivery failed"), errors = [];
    const previousMessages = fake.messages.length;
    console.error = (...args) => errors.push(args);
    fake.api.window.showInformationMessage = () => Promise.reject(failure);
    try {
      select();
      fake.confirmations.push("Inspect disposable copy");
      await invoke("importPreview");
      await waitFor(() => errors.length > 0);
      assert.match(errors[0][0], /first-run advisory notification failed/i);
      assert.equal(errors[0][1], failure);
      assert.equal(fake.messages.length, previousMessages);
      await invoke("importConfirm"); // The exact plan survives failed notification delivery.
      assert.match(fake.warnings.at(-1), /Create and publish a NEW isolated workspace/);
      assert.deepEqual(await tree(root), initial);
    } finally {
      fake.api.window.showInformationMessage = information;
      console.error = log;
    }
  });

  await writeFile(join(source, "unsupported.txt"), "preserve unsupported content");
  const blocked = await tree(root);
  select();
  fake.confirmations.push("Inspect disposable copy");
  await invoke("importPreview");
  await invoke("importConfirm");
  assert.match(fake.warnings.at(-1), /No ready inspected plan/);
  assert.deepEqual(await tree(root), blocked);
  await rm(join(source, "unsupported.txt"));

  await mkdir(join(source, "recipes", ".trash"), { recursive: true });
  const nativeBlocked = await tree(root);
  select();
  fake.confirmations.push("Inspect disposable copy");
  await invoke("importPreview");
  const nativeInspection = JSON.parse(fake.output.filter(line => line.startsWith("{")).at(-1));
  assert(nativeInspection.blockers.some(blocker => blocker.code === "recipe-trash-authority-required"));
  await invoke("importConfirm");
  assert.match(fake.warnings.at(-1), /No ready inspected plan/);
  assert.deepEqual(await tree(root), nativeBlocked, "User acknowledgement cannot grant independent native authority");
  await rm(join(source, "recipes"), { recursive: true });

  select(source); // Overlapping/existing destination blocks even a ready source.
  fake.confirmations.push("Inspect disposable copy");
  await invoke("importPreview");
  await invoke("importConfirm");
  assert.match(fake.warnings.at(-1), /No ready inspected plan/);
  assert.deepEqual(await tree(root), initial);

  select();
  fake.confirmations.push("Inspect disposable copy");
  await invoke("importPreview");
  await writeFile(note, "---\nid: migration-fixture\ntitle: Changed\n---\nChanged bytes.\n");
  const changed = await tree(root);
  fake.confirmations.push("Import exact inspected plan");
  await invoke("importConfirm");
  assert.match(fake.messages.at(-1), /SOURCE_CHANGED/);
  assert.deepEqual(await tree(root), changed, "Source drift must fail before staging/publication writes");

  select();
  fake.confirmations.push("Inspect disposable copy");
  await invoke("importPreview");
  const exact = JSON.parse(fake.output.filter(line => line.startsWith("{")).at(-1));
  const sourceBefore = await tree(source);
  // Configuration changes must not retarget the inspected destination.
  fake.global.managedRoot = join(root, "uninspected-root");
  fake.confirmations.push("Import exact inspected plan");
  await invoke("importConfirm");
  assert.equal(fake.messages.length, 1, fake.messages.join("\n")); // Only expected SOURCE_CHANGED above.
  const published = JSON.parse(fake.output.filter(line => line.startsWith("{")).at(-1));
  assert.equal(published.cutover, false);
  assert.equal(published.receipt.destination, exact.destination);
  assert.equal(published.receipt.fingerprint, exact.plan.fingerprint);
  assert.match(fake.warnings.at(-1), new RegExp(exact.plan.planSha256));
  assert.equal(await readFile(join(destination, "notes", "Example.md"), "utf8"), await readFile(note, "utf8"));
  assert.deepEqual(await tree(source), sourceBefore);
  assert(!(await readdir(root)).includes("uninspected-root"));
});
