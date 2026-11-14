import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import Module, { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const nextBuild = resolve(process.env.PKM_PLUGIN_NEXT_BUILD ?? resolve(import.meta.dirname, "../dist"));
const rootBuild = resolve(process.env.PKM_PLUGIN_ROOT_BUILD ?? resolve(import.meta.dirname, "../legacy/dist"));
const load = name => import(pathToFileURL(resolve(nextBuild, `${name}.js`)).href);
const require = createRequire(import.meta.url);
const { PluginHostAuthority } = require(resolve(rootBuild, "runtime/plugin-host-authority.js"));
const { createVscodePluginRuntime } = await load("vscode-plugin-host");
const { createNativeRuntime } = await load("native-runtime");
const { initialize, Storage } = await load("storage");
const { startMcp } = await load("mcp");
const configuration = { tenantId: "synthetic-tenant", clientId: "synthetic-client", credentialRef: "synthetic-reference-only" };
const capability = "teams.notifications.read";
const actor = { id: "mcp:external", canWrite: true };
const call = (client, operation, args) => client.callTool({
  name: "capability_call", arguments: { operation, version: 1, arguments: args },
}).then(value => value.structuredContent);
const read = (client, operation, args) => client.callTool({
  name: "capability_read", arguments: { operation, version: 1, arguments: args },
}).then(value => value.structuredContent);

test("native Plugin contract: real host IPC + MCP + local HTTP fixture, NOT Teams source parity", { timeout: 30_000 }, async t => {
  const root = resolve(import.meta.dirname, `.plugin-host-${randomUUID()}`);
  await initialize(root);
  const storage = await Storage.open(root);
  const workspaceId = await storage.workspaceId();
  const stateDirectory = resolve(import.meta.dirname, `.plugin-host-state-${randomUUID()}`);
  // Host-owned durable state is deliberately outside the native workspace.
  mkdirSync(stateDirectory, { mode: 0o700 });
  const stateFile = resolve(stateDirectory, "grant.json");
  let trusted = true, consent = true, requests = 0, consentCalls = 0, disposed = 0, starts = 0;
  let releaseConsent, announceConsent;
  let waitingConsent;
  const http = createServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/synthetic-notifications");
    assert.equal(request.headers.authorization, undefined);
    requests++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ count: 2, hasMore: false }));
  });
  await new Promise(done => http.listen(0, "127.0.0.1", done));
  const factory = config => ({
    start() { starts++; assert.deepEqual(config, configuration); },
    async invoke(_capability, _input, context) {
      const response = await fetch(`http://127.0.0.1:${http.address().port}/synthetic-notifications`, {
        signal: context.signal, redirect: "error",
      });
      return response.json();
    },
    stop() {},
    dispose() { disposed++; },
  });
  const implementationSha256 = createHash("sha256").update(factory.toString()).digest("hex");
  const authority = new PluginHostAuthority({
    workspaceRoot: root, workspaceId, actorId: actor.id, implementationSha256,
    isTrusted: () => trusted, load: () => undefined,
    save: async grant => { writeFileSync(stateFile, JSON.stringify(grant), { mode: 0o600 }); },
    async confirmInvocation(request) {
      consentCalls++;
      assert.equal(request.actorId, actor.id);
      assert.equal(request.workspaceId, workspaceId);
      assert.equal(request.implementationSha256, implementationSha256);
      assert.match(request.configurationSha256, /^[a-f0-9]{64}$/);
      assert.match(request.inputDigest, /^[a-f0-9]{64}$/);
      announceConsent?.();
      if (waitingConsent) await waitingConsent;
      return consent;
    },
  });
  let native, server, client;
  t.after(async () => {
    releaseConsent?.();
    await client?.close();
    await server?.close();
    await native?.close();
    await authority.dispose();
    await storage.close();
    await new Promise(done => http.close(done));
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDirectory, { recursive: true, force: true });
  });
  const grant = await authority.configure(configuration);
  await authority.start();
  assert.equal(grant.enabled, true);
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).revision, grant.revision);
  const wrongPin = await createVscodePluginRuntime(storage, {
    actorId: actor.id, teams: { implementationSha256: "0".repeat(64), factory },
  });
  assert.equal((await wrongPin.read("plugin.runtime.status", { pluginId: "teams" })).available, false);
  await wrongPin.close();
  const plugins = await createVscodePluginRuntime(storage, { actorId: actor.id, teams: { implementationSha256, factory } });
  native = await createNativeRuntime({ storage, plugins });
  const pair = InMemoryTransport.createLinkedPair();
  server = await startMcp(native.core, actor, pair[0]);
  client = new Client({ name: "native-plugin-fixture", version: "1" });
  await client.connect(pair[1]);
  assert.equal((await read(client, "plugin.runtime.status", { pluginId: "teams" })).result.available, true);
  assert.equal(requests, 0);
  consent = false;
  assert.equal((await call(client, "plugin.runtime.enable", { pluginId: "teams", capabilities: [capability] })).error.code, "ACCESS_DENIED");
  assert.equal(starts, 0);
  consent = true;
  assert.equal((await call(client, "plugin.runtime.enable", { pluginId: "teams", capabilities: [capability] })).result.state, "enabled");
  assert.equal(starts, 1);
  assert.equal(requests, 0, "enabling must not make a provider request");
  assert.deepEqual((await call(client, "plugin.runtime.invoke", {
    pluginId: "teams", capability, input: { limit: 2 },
  })).result, { count: 2, hasMore: false });
  assert.equal(requests, 1);
  consent = false;
  assert.equal((await call(client, "plugin.runtime.invoke", { pluginId: "teams", capability, input: {} })).error.code, "ACCESS_DENIED");
  assert.equal(requests, 1);
  assert.equal((await native.core.dispatch("capability_call", {
    operation: "plugin.runtime.enable", version: 1, arguments: { pluginId: "teams", capabilities: [capability] },
  }, { id: "other:actor", canWrite: true })).error.code, "ACCESS_DENIED");
  assert.equal((await native.core.dispatch("capability_call", {
    operation: "plugin.runtime.enable", version: 1, arguments: { pluginId: "teams", capabilities: [capability] },
  }, { id: actor.id, canWrite: false })).error.code, "ACCESS_DENIED");
  assert.equal((await call(client, "plugin.runtime.invoke", {
    pluginId: "teams", capability: "teams.messages.send", input: {},
  })).error.code, "INVALID_ARGUMENT");
  consent = true;
  waitingConsent = new Promise(done => { releaseConsent = done; });
  const consentEntered = new Promise(done => { announceConsent = done; });
  const pending = call(client, "plugin.runtime.invoke", { pluginId: "teams", capability, input: {} });
  await consentEntered;
  await authority.revoke();
  releaseConsent();
  assert.equal((await pending).error.code, "ACCESS_DENIED", "revocation while the modal is open must fence the effect");
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).enabled, false);
  assert.equal(requests, 1);
  assert.equal(consentCalls, 5);
  await native.close();
  assert.equal(disposed, 1);
  const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  const restored = new PluginHostAuthority({
    workspaceRoot: root, workspaceId, actorId: actor.id, implementationSha256,
    isTrusted: () => trusted, load: () => persisted, save: async () => {},
    confirmInvocation: async () => { throw new Error("Revoked durable authority must not request consent."); },
  });
  assert.equal(restored.snapshot().enabled, false);
  await restored.dispose();
});

test("shipped CLI exposes native Plugin controls but does not manufacture a Teams implementation", { timeout: 30_000 }, async t => {
  const root = resolve(import.meta.dirname, `.plugin-cli-${randomUUID()}`);
  await initialize(root);
  const storage = await Storage.open(root);
  const workspaceId = await storage.workspaceId();
  const authority = new PluginHostAuthority({
    workspaceRoot: root, workspaceId, actorId: "local:owner", isTrusted: () => true,
    load: () => undefined, save: async () => {},
    confirmInvocation: async () => { throw new Error("Unadmitted implementation must not request effect consent."); },
  });
  await authority.configure(configuration);
  await authority.start();
  await storage.close();
  const client = new Client({ name: "plugin-cli-boundary", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve(nextBuild, "cli.js"), "mcp", "--data", root, "--experimental-trusted-plugins"],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  t.after(async () => {
    await client.close();
    await transport.close();
    await authority.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  await client.connect(transport);
  const status = await read(client, "plugin.runtime.status", { pluginId: "teams" });
  assert.equal(status.error, undefined, stderr);
  assert.equal(status.result.unavailableReason, "implementation_not_injected");
  assert.equal(status.result.state, "disabled");
  assert.equal((await call(client, "plugin.runtime.enable", { pluginId: "teams", capabilities: [capability] })).error.code, "NOT_AVAILABLE");
  assert.equal((await call(client, "plugin.runtime.invoke", { pluginId: "teams", capability, input: {} })).error.code, "NOT_AVAILABLE");
});

test("configuration/revision changes and observed workspace distrust fence already enabled native instances", async t => {
  const root = resolve(import.meta.dirname, `.plugin-revision-${randomUUID()}`);
  await initialize(root);
  const storage = await Storage.open(root);
  let trusted = true, hooks = 0;
  const factory = () => ({
    start() {}, invoke() { hooks++; return { count: 0, hasMore: false }; }, dispose() {},
  });
  const implementationSha256 = createHash("sha256").update(factory.toString()).digest("hex");
  const authority = new PluginHostAuthority({
    workspaceRoot: root, workspaceId: await storage.workspaceId(), actorId: actor.id, implementationSha256,
    isTrusted: () => trusted, load: () => undefined, save: async () => {},
    confirmInvocation: async () => true,
  });
  let runtime, replacement;
  t.after(async () => {
    await runtime?.close();
    await replacement?.close();
    await authority.dispose();
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const first = await authority.configure(configuration);
  await authority.start();
  runtime = await createVscodePluginRuntime(storage, { actorId: actor.id, teams: { implementationSha256, factory } });
  await runtime.enable({ ...actor, trusted: true }, "teams", [capability]);
  const second = await authority.configure({ ...configuration, clientId: "replacement-client" });
  assert.notEqual(second.revision, first.revision);
  assert.notEqual(second.configurationSha256, first.configurationSha256);
  await assert.rejects(runtime.invoke({ ...actor, trusted: true }, "teams", capability, {}), error => error.code === "ACCESS_DENIED");
  replacement = await createVscodePluginRuntime(storage, { actorId: actor.id, teams: { implementationSha256, factory } });
  await replacement.enable({ ...actor, trusted: true }, "teams", [capability]);
  trusted = false;
  await assert.rejects(replacement.invoke({ ...actor, trusted: true }, "teams", capability, {}), error => error.code === "ACCESS_DENIED");
  trusted = true;
  await assert.rejects(replacement.invoke({ ...actor, trusted: true }, "teams", capability, {}), error => error.code === "ACCESS_DENIED");
  assert.equal(hooks, 0);
});

test("registered production VS Code commands persist only a disabled draft and revoke its exact revision", { timeout: 15_000 }, async t => {
  const root = resolve(import.meta.dirname, `.plugin-ui-${randomUUID()}`);
  await initialize(root);
  const commands = new Map(), values = new Map(), subscriptions = [];
  const messages = [];
  const configValues = Object.values(configuration);
  let trusted = true, inputIndex = 0;
  const vscode = {
    Uri: { file: fsPath => ({ fsPath, scheme: "file" }) },
    workspace: {
      get isTrusted() { return trusted; },
      getWorkspaceFolder: uri => uri.fsPath === root ? { uri } : undefined,
    },
    commands: { registerCommand(name, handler) {
      commands.set(name, handler);
      return { dispose() { commands.delete(name); } };
    } },
    window: {
      showOpenDialog: async () => [{ fsPath: root, scheme: "file" }],
      showQuickPick: async () => actor.id,
      showInputBox: async () => configValues[inputIndex++],
      showWarningMessage: async (message, _options, label) => { messages.push(message); return label; },
      showInformationMessage: async message => { messages.push(message); },
    },
  };
  const previousLoad = Module._load;
  let registerNativePluginWorkspace;
  try {
    Module._load = function(specifier, ...args) {
      if (specifier === "vscode") return vscode;
      return previousLoad.call(this, specifier, ...args);
    };
    ({ registerNativePluginWorkspace } = require(resolve(rootBuild, "ui/native-plugin-workspace.js")));
  } finally { Module._load = previousLoad; }
  registerNativePluginWorkspace({
    subscriptions, globalState: {
      get: key => values.get(key),
      update: async (key, value) => { values.set(key, structuredClone(value)); },
    },
  }, () => resolve(import.meta.dirname, ".not-a-real-knowledge-root"));
  t.after(async () => {
    await commands.get("personalKnowledge.plugins.revokeNativeWorkspace")?.();
    for (const subscription of subscriptions) subscription.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  await commands.get("personalKnowledge.plugins.configureNativeWorkspace")();
  const grant = [...values.values()][0];
  assert.equal(grant.enabled, false);
  assert.equal(grant.implementationSha256, null);
  assert.deepEqual(grant.configuration, configuration);
  assert.equal(grant.actorId, actor.id);
  const status = await commands.get("personalKnowledge.plugins.nativeWorkspaceStatus")();
  assert.equal(status.implementation, "not-admitted");
  assert.equal(status.enabled, false);
  assert.equal(JSON.stringify(status).includes(configuration.credentialRef), false);
  assert.ok(messages.some(message => message.includes("Teams implementation is not admitted")));
  const storage = await Storage.open(root);
  try {
    const runtime = await createVscodePluginRuntime(storage, { actorId: actor.id });
    assert.equal((await runtime.read("plugin.runtime.status", { pluginId: "teams" })).unavailableReason, "implementation_not_injected");
    await runtime.close();
  } finally { await storage.close(); }
  await commands.get("personalKnowledge.plugins.revokeNativeWorkspace")();
  const revoked = [...values.values()][0];
  assert.equal(revoked.enabled, false);
  assert.notEqual(revoked.revision, grant.revision);
  trusted = false;
  await assert.rejects(commands.get("personalKnowledge.plugins.configureNativeWorkspace")(), /workspace trust/);
});
