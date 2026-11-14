import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const build = resolve(process.env.PKM_PLUGIN_NEXT_BUILD ?? resolve(import.meta.dirname, "../dist"));
const { PLUGIN_RUNTIME_LIMITS, PluginRuntime, PluginRuntimeError } =
  await import(pathToFileURL(resolve(build, "plugin-runtime.js")).href);
const { pluginRuntimeDefinitions } =
  await import(pathToFileURL(resolve(build, "plugin-runtime-contracts.js")).href);

const actor = id => Object.freeze({ id, trusted: true });
const config = Object.freeze({
  tenantId: "tenant-fixture",
  clientId: "client-fixture",
  credentialRef: "credential-ref-fixture",
});
const safeCapability = "teams.notifications.read";
const sendCapability = "teams.messages.send";
const noopPlugin = (overrides = {}) => ({
  start: async () => {},
  invoke: async () => ({ count: 0, hasMore: false }),
  stop: async () => {},
  dispose: async () => {},
  ...overrides,
});
const runtimeWith = (plugin, options = {}) => new PluginRuntime({
  factories: { teams: () => plugin },
  configurations: { teams: config },
  authorize: async () => true,
  ...options,
});
const expectCode = code => error => error instanceof PluginRuntimeError && error.code === code;

test("public plugin contracts are schema-only reads; discovery never initializes plugins or sends", async () => {
  let factoryCalls = 0;
  const runtime = new PluginRuntime({
    factories: { teams: () => { factoryCalls++; return noopPlugin(); } },
    configurations: { teams: config },
    authorize: async () => true,
  });
  assert.deepEqual(pluginRuntimeDefinitions.map(item => [item.id, item.readOnly]), [
    ["plugin.runtime.discover", true],
    ["plugin.runtime.status", true],
  ]);
  const discovery = await runtime.read("plugin.runtime.discover", {});
  assert.deepEqual(discovery.items.map(item => [item.id, item.available, item.state]), [["teams", true, "disabled"]]);
  assert.equal(factoryCalls, 0);
  assert.equal((await runtime.read("plugin.runtime.status", { pluginId: "teams" })).state, "disabled");
  assert.equal(factoryCalls, 0);
  await assert.rejects(runtime.read("plugin.runtime.enable", { pluginId: "teams" }), expectCode("NOT_FOUND"));
  await assert.rejects(runtime.invoke(actor("owner"), "teams", sendCapability, {}), expectCode("CAPABILITY_DENIED"));
  assert.equal(factoryCalls, 0);
  await runtime.close();
});

test("Teams stays explicitly unavailable until both trusted implementation and configuration are injected", async () => {
  assert.throws(() => new PluginRuntime({
    factories: { unlisted: () => noopPlugin() },
  }), /statically allowlisted/);
  assert.throws(() => new PluginRuntime({
    configurations: { teams: { ...config, accessToken: "PRIVATE-TOKEN" } },
  }), /non-secret, opaque identifiers/);

  const noImplementation = new PluginRuntime({ configurations: { teams: config } });
  const missingImplementation = await noImplementation.read("plugin.runtime.status", { pluginId: "teams" });
  assert.equal(missingImplementation.available, false);
  assert.equal(missingImplementation.unavailableReason, "implementation_not_injected");
  assert.equal(missingImplementation.capabilities[0].available, false);
  await assert.rejects(
    noImplementation.enable(actor("owner"), "teams", [safeCapability]),
    expectCode("NOT_AVAILABLE"),
  );

  const missingConfig = new PluginRuntime({
    factories: { teams: () => noopPlugin() },
    authorize: async () => true,
  });
  const configurationRequired = await missingConfig.read("plugin.runtime.status", { pluginId: "teams" });
  assert.equal(configurationRequired.unavailableReason, "configuration_required");
  await assert.rejects(missingConfig.enable(actor("owner"), "teams", [safeCapability]), expectCode("NOT_AVAILABLE"));
});

test("trusted native authorization and per-actor exact capability grants gate every hook", async () => {
  const calls = [];
  let starts = 0;
  let invocations = 0;
  let stops = 0;
  const runtime = runtimeWith(noopPlugin({
    start: async () => { starts++; },
    invoke: async (capability, input, context) => {
      invocations++;
      calls.push({ capability, input, actorId: context.actorId });
      return { count: 2, hasMore: false };
    },
    stop: async () => { stops++; },
  }), {
    authorize: async (trusted, request) => {
      calls.push({ trusted, request });
      return trusted.trusted && (request.action === "disable"
        || request.capabilities.includes(safeCapability));
    },
  });
  await assert.rejects(runtime.invoke(actor("alice"), "teams", safeCapability, {}), expectCode("NOT_AVAILABLE"));
  await assert.rejects(runtime.enable({ id: "alice", trusted: false }, "teams", [safeCapability]), expectCode("ACCESS_DENIED"));
  await assert.rejects(runtime.enable(actor("alice"), "teams", [sendCapability]), expectCode("CAPABILITY_DENIED"));
  assert.equal(starts, 0);
  const enabled = await runtime.enable(actor("alice"), "teams", [safeCapability]);
  assert.equal(enabled.state, "enabled");
  assert.equal(starts, 1);
  await assert.rejects(runtime.invoke(actor("bob"), "teams", safeCapability, {}), expectCode("ACCESS_DENIED"));
  assert.equal(invocations, 0);
  assert.deepEqual(await runtime.invoke(actor("alice"), "teams", safeCapability, { limit: 2 }), { count: 2, hasMore: false });
  assert.equal(invocations, 1);
  assert.deepEqual(calls.find(item => item.actorId), {
    capability: safeCapability,
    input: { offset: 0, limit: 2 },
    actorId: "alice",
  });
  await runtime.disable(actor("alice"), "teams");
  assert.equal(stops, 1);
  assert.equal((await runtime.read("plugin.runtime.status", { pluginId: "teams" })).state, "disabled");
});

test("no authorizer or a non-true decision cannot opt a plugin in", async () => {
  const noAuthorizer = runtimeWith(noopPlugin(), { authorize: undefined });
  await assert.rejects(noAuthorizer.enable(actor("owner"), "teams", [safeCapability]), expectCode("ACCESS_DENIED"));
  const denied = runtimeWith(noopPlugin(), { authorize: async () => "yes" });
  await assert.rejects(denied.enable(actor("owner"), "teams", [safeCapability]), expectCode("ACCESS_DENIED"));
});

test("one actor cannot disable another actor's scoped enablement", async () => {
  let stops = 0;
  const runtime = runtimeWith(noopPlugin({ stop: async () => { stops++; } }));
  await runtime.enable(actor("alice"), "teams", [safeCapability]);
  await runtime.enable(actor("bob"), "teams", [safeCapability]);
  assert.equal((await runtime.disable(actor("alice"), "teams")).state, "enabled");
  assert.equal(stops, 0);
  assert.deepEqual(await runtime.invoke(actor("bob"), "teams", safeCapability, {}), { count: 0, hasMore: false });
  assert.equal((await runtime.disable(actor("bob"), "teams")).state, "disabled");
  assert.equal(stops, 1);
});

test("timed-out async hooks are cancelled, bounded, fault-isolated and disposed", async () => {
  let hookSignal;
  let stopped = 0;
  let disposed = 0;
  const runtime = runtimeWith(noopPlugin({
    invoke: (_capability, _input, context) => {
      hookSignal = context.signal;
      return new Promise(() => {});
    },
    stop: async () => { stopped++; },
    dispose: async () => { disposed++; },
  }), { hookTimeoutMs: 25, disposeTimeoutMs: 25 });
  await runtime.enable(actor("owner"), "teams", [safeCapability]);
  const before = Date.now();
  await assert.rejects(runtime.invoke(actor("owner"), "teams", safeCapability, {}), error => {
    assert.equal(error.code, "PLUGIN_HOOK_FAILED");
    assert.match(error.message, /cleanup timed-out after timeout/);
    assert.equal(JSON.stringify(error).includes("credential-ref-fixture"), false);
    return true;
  });
  assert.ok(Date.now() - before < 500);
  assert.equal(hookSignal.aborted, true);
  assert.equal(stopped, 1);
  assert.equal(disposed, 1);
  const status = await runtime.read("plugin.runtime.status", { pluginId: "teams" });
  assert.equal(status.state, "faulted");
  assert.equal(status.cleanup, "timed-out");
  assert.equal(JSON.stringify(status).includes("credential-ref-fixture"), false);
  assert.equal(JSON.stringify(status).includes("tenant-fixture"), false);
  await assert.rejects(runtime.enable(actor("owner"), "teams", [safeCapability]), expectCode("NOT_AVAILABLE"));
});

test("start faults and cleanup failures are surfaced without leaking plugin exceptions", async () => {
  let disposed = 0;
  const runtime = runtimeWith(noopPlugin({
    start: async () => { throw new Error("PRIVATE-BEARER-SECRET"); },
    stop: async () => { throw new Error("PRIVATE-CLEANUP-SECRET"); },
    dispose: async () => { disposed++; },
  }));
  await assert.rejects(runtime.enable(actor("owner"), "teams", [safeCapability]), error => {
    assert.equal(error.code, "PLUGIN_START_FAILED");
    assert.equal(error.cleanup.stop, "failed");
    assert.equal(error.cleanup.dispose, "complete");
    assert.equal(error.cleanup.state, "failed");
    assert.ok(!error.message.includes("PRIVATE-BEARER-SECRET"));
    assert.ok(!error.message.includes("PRIVATE-CLEANUP-SECRET"));
    return true;
  });
  assert.equal(disposed, 1);
  const status = await runtime.read("plugin.runtime.status", { pluginId: "teams" });
  assert.equal(status.state, "faulted");
  assert.equal(status.cleanup, "failed");
  assert.ok(!JSON.stringify(status).includes("PRIVATE"));
});

test("capability schemas bound arguments and reject malformed provider output without exposing it", async () => {
  let invocations = 0;
  const runtime = runtimeWith(noopPlugin({
    invoke: async () => {
      invocations++;
      return { count: 1, hasMore: false, token: "PRIVATE-PROVIDER-SECRET" };
    },
  }));
  await runtime.enable(actor("owner"), "teams", [safeCapability]);
  await assert.rejects(
    runtime.invoke(actor("owner"), "teams", safeCapability, { limit: 51 }),
    expectCode("INVALID_ARGUMENT"),
  );
  assert.equal(invocations, 0);
  await assert.rejects(runtime.invoke(actor("owner"), "teams", safeCapability, {}), error => {
    assert.equal(error.code, "PLUGIN_HOOK_FAILED");
    assert.ok(!error.message.includes("PRIVATE-PROVIDER-SECRET"));
    return true;
  });
  const status = await runtime.read("plugin.runtime.status", { pluginId: "teams" });
  assert.equal(status.state, "faulted");
  assert.ok(!JSON.stringify(status).includes("PRIVATE-PROVIDER-SECRET"));
});

test("host shutdown reports bounded cleanup state", async () => {
  let disposed = 0;
  const runtime = runtimeWith(noopPlugin({ dispose: async () => { disposed++; } }));
  await runtime.enable(actor("owner"), "teams", [safeCapability]);
  const result = await runtime.close();
  assert.equal(result[0].state, "disabled");
  assert.equal(result[0].cleanup, "complete");
  assert.equal(disposed, 1);
  assert.ok(PLUGIN_RUNTIME_LIMITS.maximumTimeoutMs >= 30_000);
  assert.equal((await runtime.close())[0].cleanup, "complete");
  await assert.rejects(runtime.enable(actor("owner"), "teams", [safeCapability]), expectCode("NOT_AVAILABLE"));
});
