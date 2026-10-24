const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const extensionRoot = process.env.PKM_INTENT_TEST_EXTENSION_ROOT || path.resolve(__dirname, "..");
const { GitHubSyncCoordinator } = require(path.join(extensionRoot, "dist/sync/github-sync-coordinator"));

async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for intent admission");
}
function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-intent-admission-"));
  const states = [];
  const coordinator = new GitHubSyncCoordinator({
    stateDirectory:directory, knowledgeRoot:directory, extensionVersion:"3.2.101",
    pollMs:10, leaseMs:1000, onState:(_id, state) => states.push(state), ...options,
  });
  t.after(() => { coordinator.dispose(); fs.rmSync(directory, { recursive:true, force:true }); });
  coordinator.configure([{ id:"backup", enabled:true, intervalMinutes:60, syncOnChange:true, lastSuccessAt:new Date().toISOString() }]);
  return { coordinator, states, read:() => JSON.parse(fs.readFileSync(path.join(directory, "coordinator.json"), "utf8")) };
}

test("one durable change waiting on preflight is dispatched once despite repeated coordinator polls", async t => {
  let release, checks = 0, runs = 0;
  const f = fixture(t, {
    shouldExecute:async (_id, reason) => {
      if (reason === "startup") return false;
      checks++;
      if (checks === 1) await new Promise(resolve => { release = resolve; });
      return true;
    },
    execute:async () => { runs++; },
  });
  await until(() => f.coordinator.isLeader());
  f.coordinator.request("backup", "change");
  await until(() => !!release);
  await new Promise(resolve => setTimeout(resolve, 100));
  release();
  await until(() => runs === 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(checks, 1, "polls cannot queue another copy of the active sequence");
  assert.equal(runs, 1);
  assert.equal(f.read().targets.backup.lastFailure, undefined);
  assert.equal(f.states.some(state => state.status === "error"), false);
  assert.deepEqual(f.read().intents, {});
  assert.deepEqual(f.read().claims, {});
});

test("a new same-reason sequence submitted during execution runs once after the active claim", async t => {
  let release, runs = 0;
  const f = fixture(t, {
    shouldExecute:async (_id, reason) => reason !== "startup",
    execute:async () => { if (++runs === 1) await new Promise(resolve => { release = resolve; }); },
  });
  await until(() => f.coordinator.isLeader());
  f.coordinator.request("backup", "manual");
  await until(() => !!release);
  assert.equal(f.coordinator.request("backup", "manual"), true);
  assert.equal(f.coordinator.request("backup", "manual"), false);
  await new Promise(resolve => setTimeout(resolve, 50));
  release();
  await until(() => runs === 2);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(runs, 2, "sequence deduplication must not lose legitimate same-reason follow-up");
  assert.deepEqual(f.read().intents, {});
  assert.deepEqual(f.read().claims, {});
  assert.equal(f.read().targets.backup.lastFailure, undefined);
});

test("pausing Auto while preflight waits cancels only the unclaimed change, not a Sync failure", async t => {
  let release, runs = 0;
  const f = fixture(t, {
    shouldExecute:async (_id, reason) => {
      if (reason === "startup") return false;
      await new Promise(resolve => { release = resolve; }); return true;
    },
    execute:async () => { runs++; },
  });
  await until(() => f.coordinator.isLeader());
  f.coordinator.request("backup", "change");
  await until(() => !!release);
  f.coordinator.configure([{ id:"backup", enabled:false, intervalMinutes:60, syncOnChange:true }]);
  release();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(runs, 0);
  assert.equal(f.read().targets.backup.enabled, false);
  assert.equal(f.read().targets.backup.lastFailure, undefined);
  assert.equal(f.states.some(state => state.status === "error"), false);
  assert.deepEqual(f.read().intents, {});
  assert.deepEqual(f.read().claims, {});
});

test("manual promotion during change preflight supersedes unclaimed work without recording Sync failure", async t => {
  let release, checked = false;
  const runs = [];
  const f = fixture(t, {
    shouldExecute:async (_id, reason) => {
      if (reason === "startup") return false;
      if (reason === "change" && !checked) { checked = true; await new Promise(resolve => { release = resolve; }); }
      return true;
    },
    execute:async (_id, reason) => runs.push(reason),
  });
  await until(() => f.coordinator.isLeader());
  f.coordinator.request("backup", "change");
  await until(() => !!release);
  assert.equal(f.coordinator.request("backup", "manual"), true);
  await new Promise(resolve => setTimeout(resolve, 40));
  release();
  await until(() => runs.length === 1);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(runs, ["manual"]);
  assert.equal(f.read().targets.backup.lastFailure, undefined, "supersession is not a failed sync attempt");
  assert.equal(f.states.some(state => state.status === "error"), false);
  assert.deepEqual(f.read().intents, {});
  assert.deepEqual(f.read().claims, {});
});

test("independent service IPC admits slow change preflight once and preserves a manual promotion without false failure", { timeout:20000 }, async t => {
  const { PkmServiceClient, pkmServiceIdentity } = require(path.join(extensionRoot, "dist/runtime/pkm-service"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-intent-service-"));
  let release, client, changeChecks = 0;
  const runs = [];
  const options = {
    knowledgeRoot:path.join(root, "knowledge"), globalStoragePath:path.join(root, "storage"),
    extensionVersion:require(path.join(extensionRoot, "package.json")).version,
    serviceEntryPath:path.join(extensionRoot, "dist/runtime/pkm-service-entry.js"),
    shouldExecute:async (_id, reason) => {
      if (reason === "startup") return false;
      if (reason === "change") { changeChecks++; await new Promise(resolve => { release = resolve; }); }
      return true;
    },
    execute:async (_id, reason) => { runs.push(reason); },
  };
  fs.mkdirSync(options.knowledgeRoot); fs.mkdirSync(options.globalStoragePath);
  t.after(async () => {
    release?.();
    if (client) {
      await client.drain(); client.dispose();
      await until(() => !fs.existsSync(path.join(pkmServiceIdentity(options).serviceDirectory, "endpoint.json")));
    }
    fs.rmSync(root, { recursive:true, force:true });
  });
  client = await PkmServiceClient.connect(options);
  await client.configure([{ id:"backup", enabled:true, intervalMinutes:60, syncOnChange:true, lastSuccessAt:new Date().toISOString() }]);
  await client.request("backup", "change");
  await until(() => !!release);
  await new Promise(resolve => setTimeout(resolve, 1700));
  release();
  await until(() => runs.length === 1);
  await new Promise(resolve => setTimeout(resolve, 850));
  assert.equal(changeChecks, 1);
  assert.deepEqual(runs, ["change"]);
  release = undefined;
  await client.request("backup", "change");
  await until(() => !!release);
  await client.request("backup", "manual");
  await new Promise(resolve => setTimeout(resolve, 850));
  release();
  await until(() => runs.length === 2);
  await new Promise(resolve => setTimeout(resolve, 850));
  assert.deepEqual(runs, ["change", "manual"]);
  const state = JSON.parse(fs.readFileSync(path.join(pkmServiceIdentity(options).stateDirectory, "coordinator.json"), "utf8"));
  assert.equal(state.targets.backup.enabled, true);
  assert.equal(state.targets.backup.lastFailure, undefined);
  assert.deepEqual(state.intents, {}); assert.deepEqual(state.claims, {});
});
