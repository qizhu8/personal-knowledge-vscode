import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { startMcp } from "../dist/mcp.js";
import { startLegacyNoteMcp } from "../dist/legacy-note-mcp.js";
import { VscodeClient } from "../clients/vscode/client.ts";

test("native and maintained Note MCP initialize as pkm-v5 without changing discovery authority", async t => {
  const directory = resolve("tests", `.public-identity-${randomUUID()}`);
  await initialize(directory);
  const storage = await Storage.open(directory);
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });
  const actor = { id: "local:identity-reader", canWrite: false };
  const core = new Core(storage);
  const info = (await core.dispatch("server_info", {}, actor)).result;
  assert.equal(info.name, "pkm-v5");
  assert.equal(info.serverId, "pkm-v5");
  assert.equal(info.actorId, actor.id);
  assert.equal(info.workspaceId, await storage.workspaceId());
  assert.equal(info.experimental, true);
  assert.equal(info.workspaceVersion, "pkm.next-workspace/v2");
  for (const [name, start] of [
    ["native", transport => startMcp(core, actor, transport)],
    ["maintained Note", transport => startLegacyNoteMcp(storage, transport)],
  ]) await t.test(name, async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await start(serverTransport);
    const client = new Client({ name: "identity-test", version: "1.0.0" });
    try {
      await client.connect(clientTransport);
      assert.equal(client.getServerVersion().name, "pkm-v5");
      const tools = (await client.listTools()).tools.map(tool => tool.name);
      assert(tools.includes(name === "native" ? "server_info" : "list_notes"));
      assert(!tools.includes("add_note"), "renaming must not manufacture write authority");
    } finally { await client.close(); await server.close(); }
  });
});

test("typed client accepts pkm-v5 discovery and still rejects old names and forged root/actor bindings", async () => {
  const info = {
    name: "pkm-v5", serverId: "pkm-v5", workspaceId: "workspace-identity", actorId: "actor-identity",
    workspaceVersion: "pkm.next-workspace/v2", protocolVersion: "v1", catalogRevision: "catalog-identity",
    storage: { workspaceSchema: "pkm.next-workspace/v2", authority: "Markdown" },
  };
  for (const [patch, bindingPatch, expected] of [
    [{}, {}, undefined],
    [{ name: "pkm" }, {}, "INCOMPATIBLE_SERVER"],
    [{ serverId: "pkm-next" }, {}, "INCOMPATIBLE_SERVER"],
    [{}, { serverId: "pkm" }, "WORKSPACE_BINDING_MISMATCH"],
    [{}, { workspaceId: "different-workspace" }, "WORKSPACE_BINDING_MISMATCH"],
    [{}, { actorId: "different-actor" }, "WORKSPACE_BINDING_MISMATCH"],
  ]) {
    let attested = false;
    const requests = [];
    const client = new VscodeClient({
      secrets: { get: async () => "s".repeat(40) },
      attestServer: async () => {
        attested = true;
        return { serverId: "pkm-v5", workspaceId: info.workspaceId, actorId: info.actorId,
          protocolVersion: "v1", ...bindingPatch };
      },
      fetch: async url => {
        requests.push(url);
        return new Response(JSON.stringify({
          schema: "pkm.next-result/v1", requestId: "identity-response",
          ...(url.endsWith("/server_info") ? { result: { ...info, ...patch } }
            : { error: { code: "NOT_FOUND", effect: "not-committed" } }),
        }), { headers: { "content-type": "application/json" } });
      },
    }, { origin: "http://127.0.0.1:12345", secretKey: "isolated.identity", expectedWorkspaceId: info.workspaceId });
    try {
      if (expected) {
        await assert.rejects(client.connect(), error => error.code === expected);
        assert.equal(client.state().status, "error");
        assert.equal(requests.length, 1, "discovery must stop before capability use on mismatch");
        if (expected === "INCOMPATIBLE_SERVER") assert.equal(attested, false);
      } else assert.equal((await client.connect()).status, "connected");
    } finally { client.dispose(); }
  }
});

test("registered native definition coexists with pkm and rejects forged, changed, rebound and disposed launches", async t => {
  // Only the already separately tested verified-launch boundary is mocked.
  const compiled = await build({
    stdin: {
      contents: `export {registerIsolatedMcp} from "./clients/vscode-host/mcp-provider.ts";
        export {setLaunch} from "identity-launch-fixture";`,
      resolveDir: resolve("."),
    }, bundle: true, write: false, platform: "node", format: "esm",
    plugins: [{
      name: "identity-launch-fixture",
      setup(plugin) {
        plugin.onResolve({ filter: /^(?:identity-launch-fixture|.*managed-launch-client\.mjs)$/ },
          () => ({ path: "launch", namespace: "identity-fixture" }));
        plugin.onLoad({ filter: /.*/, namespace: "identity-fixture" }, () => ({
          contents: `let fixture;
            export const setLaunch = value => { fixture = value; };
            export async function isolatedManagedLaunch(root) {
              if (!fixture || fixture.root !== root) throw new Error("Unverified isolated root");
              return fixture.launch;
            }`,
        }));
      },
    }],
  });
  const { registerIsolatedMcp, setLaunch } = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
  const providers = new Map([["pkm", { old: true }]]);
  const old = providers.get("pkm");
  class Definition {
    // VS Code 1.143's actual constructor also owns undefined version and metadata defaults.
    constructor(label, command, args, env = {}, version, metadata) {
      Object.assign(this, { label, command, args, env, version, metadata });
    }
  }
  class CachedUri {
    scheme = "file";
    authority = "";
    query = "";
    fragment = "";
    _fsPath = null;
    constructor(path) { this.path = path; }
    get fsPath() { return this._fsPath ||= this.path; }
    toJSON() {
      return { $mid: 1, ...(this._fsPath ? { fsPath: this._fsPath } : {}),
        path: this.path, scheme: this.scheme };
    }
  }
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
    Uri: { file: path => new CachedUri(path) }, McpStdioServerDefinition: Definition,
    lm: { registerMcpServerDefinitionProvider(id, provider) {
      assert(!providers.has(id)); providers.set(id, provider);
      return { dispose() { providers.delete(id); } };
    } },
  };
  for (const unsupported of [
    undefined, {}, { ...api, lm: undefined },
    { ...api, lm: { registerMcpServerDefinitionProvider: true } },
    { ...api, McpStdioServerDefinition: undefined },
    { ...api, McpStdioServerDefinition: {} },
    { ...api, Uri: { file: undefined } },
    { ...api, EventEmitter: undefined },
  ]) {
    assert.throws(() => registerIsolatedMcp(unsupported, () => undefined),
      error => error.code === "MCP_API_UNAVAILABLE" && /VS Code 1\.101\.0/.test(error.message));
    assert.deepEqual([...providers.keys()], ["pkm"], "unavailable APIs must fail before touching existing providers");
  }
  let root, productionCoordinator = false, changes = 0;
  const registration = registerIsolatedMcp(api, () => productionCoordinator ? undefined : root);
  try {
    const provider = providers.get("pkm-v5");
    assert(provider);
    provider.onDidChangeMcpServerDefinitions(() => { changes++; });
    assert.equal(providers.get("pkm"), old);
    assert.deepEqual(await provider.provideMcpServerDefinitions(), []);
    root = "/isolated/test-managed";
    setLaunch({ root, launch: { command: "/trusted/python", args: ["-I", "-S", `${root}/launch.py`],
      env: { PYTHONDONTWRITEBYTECODE: "1" } } });
    registration.refresh();
    assert.equal(changes, 1, "provisioning a previously absent root must notify native discovery");
    let [definition] = await provider.provideMcpServerDefinitions();
    assert.equal(definition.label, "pkm-v5");
    assert.equal(definition.cwd.scheme, "file");
    assert.equal(definition.cwd.path, root);
    assert.deepEqual(Object.getOwnPropertyDescriptor(definition, "metadata"),
      { value: undefined, writable: true, enumerable: true, configurable: true });
    await t.test("native DTO conversion may populate the same URI's fsPath cache without changing its launch", async () => {
      const before = JSON.parse(JSON.stringify(definition.cwd));
      const dto = { cwd: definition.cwd.fsPath, command: definition.command, args: definition.args, env: definition.env };
      const after = JSON.parse(JSON.stringify(definition.cwd));
      assert.equal(Object.hasOwn(before, "fsPath"), false);
      assert.equal(after.fsPath, root);
      assert.notDeepEqual(before, after, "reproduce VS Code 1.143's cached URI serialization");
      assert.equal(dto.cwd, root);
      assert.equal(await provider.resolveMcpServerDefinition(definition), definition);
    });
    assert.equal(await provider.resolveMcpServerDefinition(definition), definition);
    const previous = definition;
    registration.refresh();
    assert.equal(changes, 2);
    await assert.rejects(provider.resolveMcpServerDefinition(previous), /stale or changed/,
      "notification must invalidate old definitions before native rediscovery starts");
    [definition] = await provider.provideMcpServerDefinitions();
    assert.notEqual(definition, previous);
    assert.equal(await provider.resolveMcpServerDefinition(definition), definition);
    productionCoordinator = true;
    registration.refresh();
    assert.equal(changes, 3);
    await assert.rejects(provider.resolveMcpServerDefinition(definition), /stale or changed/);
    assert.deepEqual(await provider.provideMcpServerDefinitions(), []);
    productionCoordinator = false;
    registration.refresh();
    assert.equal(changes, 4);
    [definition] = await provider.provideMcpServerDefinitions();
    assert.equal(await provider.resolveMcpServerDefinition(definition), definition);
    await assert.rejects(provider.resolveMcpServerDefinition({ ...definition }), /stale or changed/);
    const cwd = definition.cwd;
    for (const [component, changed] of [
      ["scheme", "http"], ["authority", "other-host"], ["path", "/different-managed-root"],
      ["query", "injected=true"], ["fragment", "injected"],
    ]) {
      const original = cwd[component];
      cwd[component] = changed;
      await assert.rejects(provider.resolveMcpServerDefinition(definition), /stale or changed/, component);
      cwd[component] = original;
    }
    definition.version = "unexpected-version";
    await assert.rejects(provider.resolveMcpServerDefinition(definition), /stale or changed/);
    definition.version = undefined;
    for (const metadata of [null, false, "unexpected", { tools: [] }]) {
      definition.metadata = metadata;
      await assert.rejects(provider.resolveMcpServerDefinition(definition), /stale or changed/);
    }
    let metadataReads = 0;
    Object.defineProperty(definition, "metadata", { configurable: true, get() {
      metadataReads++; return undefined;
    } });
    await assert.rejects(provider.resolveMcpServerDefinition(definition), /stale or changed/);
    assert.equal(metadataReads, 0, "metadata accessors must be rejected without being invoked");
    delete definition.metadata;
    const prototype = Object.getPrototypeOf(definition);
    Object.setPrototypeOf(definition, Object.create(prototype, { metadata: { value: undefined } }));
    await assert.rejects(provider.resolveMcpServerDefinition(definition), /stale or changed/);
    Object.setPrototypeOf(definition, prototype);
    assert.equal(await provider.resolveMcpServerDefinition(definition), definition,
      "older native constructors may omit metadata entirely");
    Object.defineProperty(definition, "metadata",
      { value: undefined, writable: true, enumerable: true, configurable: true });
    for (const [field, value] of [
      ["uri", { scheme: "https", path: "/unexpected-mcp" }], ["headers", {}],
      ["authentication", {}], ["sandbox", {}], ["envFile", "/unexpected.env"], ["unexpected", true],
    ]) {
      definition[field] = value;
      await assert.rejects(provider.resolveMcpServerDefinition(definition), /stale or changed/, field);
      delete definition[field];
    }
    definition.label = "pkm";
    await assert.rejects(provider.resolveMcpServerDefinition(definition), /stale or changed/);
    definition.label = "pkm-v5";
    definition.args.push("--unapproved");
    await assert.rejects(provider.resolveMcpServerDefinition(definition), /stale or changed/);
    definition.args.pop();
    definition.env.PYTHONDONTWRITEBYTECODE = "0";
    await assert.rejects(provider.resolveMcpServerDefinition(definition), /stale or changed/);
    definition.env.PYTHONDONTWRITEBYTECODE = "1";
    setLaunch({ root, launch: { command: "/changed/python", args: definition.args, env: definition.env } });
    await assert.rejects(provider.resolveMcpServerDefinition(definition), /launch changed/);
    root = "/other-root";
    await assert.rejects(provider.resolveMcpServerDefinition(definition), /stale or changed/);
    await assert.rejects(provider.provideMcpServerDefinitions(), /Unverified isolated root/);
    registration.dispose();
    registration.refresh();
    assert.equal(changes, 4, "disposed registrations must not emit refresh notifications");
    await assert.rejects(provider.resolveMcpServerDefinition(definition), /stale or changed/);
    assert.deepEqual(await provider.provideMcpServerDefinitions(), []);
    assert.equal(providers.get("pkm"), old);
  } finally { registration.dispose(); }
});
