const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const dist = process.env.PKM_TEST_DIST || path.resolve(__dirname, "../dist");
const { prepareOwnedLegacyNativeMcpHandoffExperimental: handoff } = require(path.join(dist, "runtime/legacy-native-mcp-handoff"));

const accepting = () => ({
  schema: "pkm.mcp.lifecycle/v1", generation: "12345678-1234-1234-1234-123456789abc",
  instanceId: "a".repeat(32), runtimeBuild: "b".repeat(64), phase: "accepting",
  acceptingNewCalls: true, inFlight: 0, uncertainCalls: 0, controlError: "",
});
const drained = () => ({ ...accepting(), phase: "drained", acceptingNewCalls: false });

test("a later mutation of the initial response cannot rebind the owned identity", async () => {
  const first = accepting();
  let stopped = false;
  const channel = {
    assertOwned() {},
    status: async () => first,
    quiesce: async () => ({ ...first, phase: "drained", acceptingNewCalls: false }),
    stopAndVerify: async () => { stopped = true; },
  };
  const result = await handoff(channel, async () => {
    first.instanceId = "c".repeat(32);
    return true;
  });
  assert.deepEqual(result, { state: "unknown", cutoverAuthorized: false });
  assert.equal(stopped, false);
});

test("only the exact live MCP channel is drained and stopped; root cutover remains unauthorized", async () => {
  const calls = [];
  let state = accepting(), stoppedIdentity;
  const channel = {
    assertOwned: () => { calls.push("owner"); },
    status: async () => { calls.push("status"); return state; },
    quiesce: async () => { calls.push("quiesce"); state = drained(); return state; },
    stopAndVerify: async (_signal, identity) => { calls.push("stop"); stoppedIdentity = identity; },
  };
  assert.deepEqual(await handoff(channel, async () => { calls.push("approve"); return true; }),
    { state: "drained-and-stopped", cutoverAuthorized: false });
  assert.deepEqual(calls, ["owner", "status", "approve", "owner", "quiesce", "owner", "status", "owner", "stop"]);
  assert.deepEqual(stoppedIdentity, { generation: state.generation, instanceId: state.instanceId, runtimeBuild: state.runtimeBuild });
  assert(Object.isFrozen(stoppedIdentity));
});

test("decline, unknown drain, identity replacement and timeout never invoke stop", async () => {
  let stops = 0, quiesces = 0;
  const base = {
    assertOwned() {},
    status: async () => accepting(),
    quiesce: async () => { quiesces++; return drained(); },
    stopAndVerify: async () => { stops++; },
  };
  assert.equal((await handoff(base, async () => false)).state, "declined");
  assert.equal(quiesces, 0);
  assert.equal((await handoff({ ...base, quiesce: async () => ({ ...drained(), uncertainCalls: 1 }) }, async () => true)).state, "unknown");
  assert.equal((await handoff({ ...base, quiesce: async () => ({ ...drained(), instanceId: "c".repeat(32) }) }, async () => true)).state, "unknown");
  assert.equal((await handoff({ ...base, quiesce: () => new Promise(() => {}) }, async () => true, 20)).state, "unknown");
  assert.equal(stops, 0);
});

test("a revoked live owner is never stopped even if its process reports drained", async () => {
  let held = true, stopped = false;
  const channel = {
    assertOwned: () => { if (!held) throw new Error("owner revoked"); },
    status: async () => accepting(),
    quiesce: async () => { held = false; return drained(); },
    stopAndVerify: async () => { stopped = true; },
  };
  assert.equal((await handoff(channel, async () => true)).state, "unknown");
  assert.equal(stopped, false);
});

test("legacy servers without lifecycle controls remain unknown and are never stopped", async () => {
  let quiesced = false, stopped = false;
  const channel = {
    assertOwned() {},
    status: async () => { throw new Error("Unknown tool: mcp_lifecycle_status"); },
    quiesce: async () => { quiesced = true; return drained(); },
    stopAndVerify: async () => { stopped = true; },
  };
  assert.equal((await handoff(channel, async () => true)).state, "unknown");
  assert.equal(quiesced, false);
  assert.equal(stopped, false);
});

test("timeout cancels a pending confirmation without stopping or authorizing cutover", async () => {
  let aborted = false, stopped = false;
  const channel = {
    assertOwned() {},
    status: async () => accepting(),
    quiesce: signal => new Promise(resolve => {
      signal.addEventListener("abort", () => { aborted = true; resolve(drained()); }, { once: true });
    }),
    stopAndVerify: async () => { stopped = true; },
  };
  assert.deepEqual(await handoff(channel, async () => true, 20),
    { state: "unknown", cutoverAuthorized: false });
  assert.equal(aborted, true);
  assert.equal(stopped, false);
});
