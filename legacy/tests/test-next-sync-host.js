"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { inspectNextSyncHost, rejectNextSyncCutover } = require("../dist/sync/next-sync-host");

function fixture(t) {
  const dir = path.resolve(".migration-test-work", `next-sync-host-${randomUUID()}`);
  const root = path.join(dir, "root"), globalStorage = path.join(dir, "profile");
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(globalStorage, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = { id: "fixture-target", repository: "https://github.com/fixture/fixture.git", branch: "main",
    authentication: { method: "vscode", expectedLogin: "fixture" },
    lastSync: { commit: "a".repeat(40), repository: "https://github.com/fixture/fixture.git", branch: "main", storeRoot: root } };
  const options = { root, globalStorage, targetId: target.id, readTargets: () => [target],
    readSecret: async key => {
      assert.equal(key, "personalKnowledge.githubSync.vscode.fixture-target");
      return JSON.stringify({ accountLabel: "fixture", accessToken: "synthetic-token" });
    } };
  function write(parts, value) {
    const file = path.join(globalStorage, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  }
  return { target, options, write, root, globalStorage };
}

test("host reads exact target and secret without returning credentials; cutover stays blocked", async t => {
  const { options, write, target } = fixture(t);
  write(["github-sync", "checkouts", target.id, "transactions", "latest.json"], {
    schema: 1, targetId: target.id, transactionId: randomUUID(), operation: "sync", state: "recorded",
    repository: target.repository, branch: target.branch, pushedCommit: target.lastSync.commit,
  });
  const observation = await inspectNextSyncHost(options);
  assert.equal(observation.credential, "available");
  assert.deepEqual(observation.recovery, {
    transaction: "recorded", coordinator: "absent", serviceResults: "absent", experimentalJournal: "absent",
  });
  assert.equal(observation.cutover, "BLOCKED_LEGACY_WRITER_EXCLUSION");
  assert(!JSON.stringify(observation).includes("synthetic-token"));
  assert.throws(rejectNextSyncCutover, /blocked/);
});

test("pending and corrupt recovery state remain visible without acknowledgment", async t => {
  const { options, write, target, root, globalStorage } = fixture(t);
  write(["github-sync", "checkouts", target.id, "transactions", "latest.json"], {
    schema: 1, targetId: target.id, transactionId: randomUUID(), operation: "sync", state: "pushed",
  });
  const digest = createHash("sha256").update(root).digest("hex");
  write(["github-sync", "coordinators", digest, "coordinator.json"], {
    schema: 1, intents: { [target.id]: {} }, claims: {}, blocked: {},
  });
  write(["pkm-service", "fixture", "results", "pending.json"], { schema: 1 });
  write(["github-sync", "experimental-next", `${target.id}.json`], {
    schema: "pkm.experimental-legacy-sync/v1", targetId: target.id, workspaceId: "fixture",
    configHash: "b".repeat(64), policyId: randomUUID(), baseline: target.lastSync.commit, phase: "publishing",
  });
  const before = fs.readFileSync(path.join(globalStorage, "pkm-service/fixture/results/pending.json"));
  const observation = await inspectNextSyncHost(options);
  assert.deepEqual(observation.recovery, {
    transaction: "pending", coordinator: "pending", serviceResults: "pending", experimentalJournal: "pending",
  });
  assert.deepEqual(fs.readFileSync(path.join(globalStorage, "pkm-service/fixture/results/pending.json")), before);
  write(["github-sync", "coordinators", digest, "coordinator.json"], { schema: 2 });
  assert.equal((await inspectNextSyncHost(options)).recovery.coordinator, "invalid");
  write(["github-sync", "experimental-next", `${target.id}.json`], { phase: "publishing" });
  assert.equal((await inspectNextSyncHost(options)).recovery.experimentalJournal, "invalid");
  write(["github-sync", "checkouts", target.id, "transactions", "latest.json"], {
    schema: 1, targetId: target.id, transactionId: randomUUID(), operation: "sync", state: "unknown",
  });
  assert.equal((await inspectNextSyncHost(options)).recovery.transaction, "invalid");
});

test("credential mismatch and missing state fail closed without leaking values", async t => {
  const { options } = fixture(t);
  options.readSecret = async () => JSON.stringify({ accountLabel: "different", accessToken: "synthetic-token" });
  assert.equal((await inspectNextSyncHost(options)).credential, "invalid");
  options.readSecret = async () => undefined;
  assert.equal((await inspectNextSyncHost(options)).credential, "missing");
  options.readSecret = async () => { throw new Error("synthetic-token"); };
  const result = await inspectNextSyncHost(options);
  assert.equal(result.credential, "unavailable");
  assert(!JSON.stringify(result).includes("synthetic-token"));
});

test("invalid or ambiguous target cannot read secret or escape the profile", async t => {
  const { options, target } = fixture(t);
  let reads = 0;
  options.readSecret = async () => { reads++; return undefined; };
  for (const id of ["../escape", ".", undefined]) {
    await assert.rejects(inspectNextSyncHost({ ...options, targetId: id }), /Invalid/);
  }
  await assert.rejects(inspectNextSyncHost({ ...options, readTargets: () => [target, target] }), /ambiguous/);
  assert.equal(reads, 0);
});

test("symlinked recovery state is not treated as absent or safe", async t => {
  const { options, globalStorage, root } = fixture(t);
  fs.mkdirSync(path.join(globalStorage, "github-sync"), { recursive: true });
  fs.symlinkSync(root, path.join(globalStorage, "github-sync/checkouts"));
  assert.equal((await inspectNextSyncHost(options)).recovery.transaction, "invalid");
});
