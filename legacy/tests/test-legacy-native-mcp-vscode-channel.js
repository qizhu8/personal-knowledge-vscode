"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const dist = process.env.PKM_TEST_DIST || path.resolve(__dirname, "../dist");
const { bindLegacyNativeMcpVscodeChannel: bind } = require(path.join(dist, "runtime/legacy-native-mcp-vscode-channel"));
const { prepareOwnedLegacyNativeMcpHandoffExperimental: handoff } = require(path.join(dist, "runtime/legacy-native-mcp-handoff"));

const accepting = () => ({ schema: "pkm.mcp.lifecycle/v1", generation: "12345678-1234-1234-1234-123456789abc",
  instanceId: "a".repeat(32), runtimeBuild: "b".repeat(64), phase: "accepting", acceptingNewCalls: true,
  inFlight: 0, uncertainCalls: 0, controlError: "" });
const statusName = "mcp_pkm_mcp_lifecycle_status", quiesceName = "mcp_pkm_mcp_lifecycle_quiesce";
function fixture() {
  const calls = [], tools = [{ name: statusName }, { name: quiesceName }];
  let state = accepting(), held = true, cancelled = false, disposed = 0, stop = 0, identity;
  const channel = bind({
    tools: () => tools, statusName, quiesceName,
    assertOwned() { if (!held) throw Error("Binding lost"); },
    cancellation: () => ({ token: {}, cancel() { cancelled = true; }, dispose() { disposed++; } }),
    async invoke(name) {
      calls.push(name);
      if (name === quiesceName) state = { ...state, phase: "drained", acceptingNewCalls: false };
      return { content: [{ value: JSON.stringify(state) }] };
    },
    async stopAndVerify(_signal, expected) { stop++; identity = expected; },
  });
  return { channel, calls, tools, lose: () => { held = false; }, stopped: () => stop,
    cancelled: () => cancelled, disposed: () => disposed, identity: () => identity };
}

test("exact VS Code lifecycle tools run the coordinator without authorizing root cutover", async () => {
  const f = fixture();
  assert.deepEqual(await handoff(f.channel, async () => true), { state: "drained-and-stopped", cutoverAuthorized: false });
  assert.deepEqual(f.calls, [statusName, quiesceName, statusName]);
  assert.equal(f.stopped(), 1);
  assert.deepEqual(f.identity(), { generation: accepting().generation, instanceId: accepting().instanceId,
    runtimeBuild: accepting().runtimeBuild });
  assert.equal(f.disposed(), 3);
});

test("ambiguous tools or revoked server binding never dispatch a stop", async () => {
  const f = fixture();
  f.tools.push({ name: statusName });
  assert.equal((await handoff(f.channel, async () => true)).state, "unknown");
  assert.deepEqual(f.calls, []);
  f.tools.pop();
  f.lose();
  assert.equal((await handoff(f.channel, async () => true)).state, "unknown");
  assert.equal(f.stopped(), 0);
});

test("timeout cancels and disposes VS Code confirmation without stopping the server", async () => {
  const f = fixture();
  let signalSeen = false, disposed = false;
  f.channel.quiesce = async signal => {
    const never = bind({
      tools: () => f.tools, statusName, quiesceName, assertOwned() {},
      cancellation: () => ({ token: {}, cancel() { signalSeen = true; }, dispose() { disposed = true; } }),
      invoke: () => new Promise(() => {}), stopAndVerify: async () => { throw Error("unexpected stop"); },
    });
    return never.quiesce(signal);
  };
  assert.equal((await handoff(f.channel, async () => true, 30)).state, "unknown");
  assert.equal(signalSeen, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, true);
  assert.equal(f.stopped(), 0);
});

test("an already-cancelled invocation never dispatches a VS Code tool", async () => {
  const f = fixture(), controller = new AbortController();
  controller.abort();
  await assert.rejects(f.channel.status(controller.signal), /cancelled/);
  assert.deepEqual(f.calls, []);
});
