#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createAgentSnapshot, deleteAgentSnapshot, listAgentSnapshots, rotateAgentSnapshotPassphrase } = require("../dist/agent-snapshots");

const store = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-agent-snapshots-"));
try {
  const state = path.join(store, ".pkm", "state");
  const sessions = path.join(state, "agent-sessions");
  const runs = path.join(state, "recipe-runs");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(runs, { recursive: true });
  const sessionId = "agent_session_snapshot_test";
  const runId = "recipe_run_snapshot_test";
  fs.writeFileSync(path.join(runs, `${runId}.json`), JSON.stringify({
    schema: "pkm.recipe.run/v1",
    runId,
    status: "running",
    receipts: { shouldNotPersist: true },
    nodes: { work: { state: "running" } },
  }));
  fs.writeFileSync(path.join(sessions, `${sessionId}.json`), JSON.stringify({
    schema: "pkm.agent.session/v1",
    sessionId,
    status: "running",
    task: "Validate Agent Snapshot storage",
    projectId: "project_pkm",
    hostSessionId: "copilot-source",
    agent: { name: "Copilot Agent", product: "GitHub Copilot" },
    recipeRunIds: [runId],
    todos: [{ todoId: "todo_work", title: "Validate storage", status: "running", recipeRunId: runId }],
    todoCommandReceipts: { shouldNotPersist: true },
    checkpoints: [{ checkpointId: "checkpoint_test", sequence: 1, reason: "restart", createdAt: "2026-09-23T00:00:00Z" }],
    privateContext: "sensitive snapshot payload",
    createdAt: "2026-09-23T00:00:00Z",
    updatedAt: "2026-09-23T00:01:00Z",
  }));

  const created = createAgentSnapshot(store, sessionId, "restart");
  assert.match(created.snapshot.magicCode, /^PKM-SNAP-(?:[A-F0-9]{4}-){3}[A-F0-9]{4}$/);
  assert.match(created.recoveryPassphrase, /^(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/);
  assert.ok(created.recoveryPrompt.includes(created.snapshot.magicCode));
  assert.ok(created.recoveryPrompt.includes(created.recoveryPassphrase));

  const snapshotPath = path.join(state, "agent-snapshots", `${created.snapshot.snapshotId}.json`);
  const snapshotText = fs.readFileSync(snapshotPath, "utf8");
  assert.ok(!snapshotText.includes(created.recoveryPassphrase));
  const snapshot = JSON.parse(snapshotText);
  assert.strictEqual(snapshot.schema, "pkm.agent.snapshot/v1");
  assert.strictEqual(snapshot.payload.algorithm, "A256GCM-PKM-INTERNAL/v1");
  assert.ok(!snapshotText.includes("sensitive snapshot payload"));
  assert.strictEqual(snapshot.capture.todoCount, 1);
  assert.strictEqual(snapshot.capture.recipeRunCount, 1);
  const verifier = crypto.scryptSync(
    created.recoveryPassphrase,
    Buffer.from(snapshot.recovery.salt, "hex"),
    32,
    { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 },
  ).toString("hex");
  assert.strictEqual(verifier, snapshot.recovery.verifier);
  const originalPayload = JSON.stringify(snapshot.payload);

  const rotated = rotateAgentSnapshotPassphrase(store, created.snapshot.snapshotId);
  assert.notStrictEqual(rotated.recoveryPassphrase, created.recoveryPassphrase);
  assert.ok(rotated.recoveryPrompt.includes(rotated.recoveryPassphrase));
  const rotatedRecord = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.strictEqual(JSON.stringify(rotatedRecord.payload), originalPayload, "rotation must not rewrite the captured payload");
  assert.notStrictEqual(rotatedRecord.recovery.verifier, snapshot.recovery.verifier);
  assert.notStrictEqual(
    crypto.scryptSync(created.recoveryPassphrase, Buffer.from(rotatedRecord.recovery.salt, "hex"), 32,
      { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString("hex"),
    rotatedRecord.recovery.verifier,
    "the previous passphrase must stop validating immediately",
  );
  assert.strictEqual(
    crypto.scryptSync(rotated.recoveryPassphrase, Buffer.from(rotatedRecord.recovery.salt, "hex"), 32,
      { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString("hex"),
    rotatedRecord.recovery.verifier,
  );

  const listed = listAgentSnapshots(store);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].todoCount, 1);
  assert.strictEqual(listed[0].recipeRunCount, 1);
  assert.strictEqual(listed[0].recoveryCount, 0);
  fs.writeFileSync(path.join(sessions, "agent_session_recovered.json"), JSON.stringify({
    schema: "pkm.agent.session/v1",
    sessionId: "agent_session_recovered",
    provenance: { kind: "agent-snapshot", snapshotId: created.snapshot.snapshotId },
  }));
  assert.strictEqual(listAgentSnapshots(store)[0].recoveryCount, 1);

  const legacyId = "agent_snapshot_legacy_test";
  const legacyPath = path.join(state, "agent-snapshots", `${legacyId}.json`);
  fs.writeFileSync(legacyPath, JSON.stringify({
    schema: "pkm.agent.snapshot/v1",
    snapshotId: legacyId,
    magicCode: "PKM-SNAP-1111-2222-3333-4444",
    sourceSessionId: sessionId,
    sourceHostSessionId: "copilot-source",
    task: "Legacy snapshot",
    projectId: "project_pkm",
    agent: { name: "Copilot Agent", product: "GitHub Copilot" },
    reason: "legacy",
    createdAt: "2026-09-22T00:00:00Z",
    recovery: snapshot.recovery,
    payload: { session: { todos: [{ title: "legacy plaintext todo" }], checkpoints: [] }, recipeRuns: [] },
  }));
  listAgentSnapshots(store);
  const migratedLegacy = fs.readFileSync(legacyPath, "utf8");
  assert.doesNotMatch(migratedLegacy, /legacy plaintext todo/);
  assert.strictEqual(JSON.parse(migratedLegacy).payload.algorithm, "A256GCM-PKM-INTERNAL/v1");

  deleteAgentSnapshot(store, created.snapshot.snapshotId);
  deleteAgentSnapshot(store, legacyId);
  assert.deepStrictEqual(listAgentSnapshots(store), []);
  assert.throws(() => deleteAgentSnapshot(store, created.snapshot.snapshotId), /not found/);
} finally {
  fs.rmSync(store, { recursive: true, force: true });
}

console.log("Agent Snapshot storage tests passed");
