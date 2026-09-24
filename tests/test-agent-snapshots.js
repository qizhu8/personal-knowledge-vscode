#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createAgentSnapshot, deleteAgentSnapshot, listAgentSnapshots } = require("../dist/agent-snapshots");

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
  assert.strictEqual(snapshot.payload.session.todoCommandReceipts, undefined);
  assert.strictEqual(snapshot.payload.recipeRuns[0].receipts, undefined);
  const verifier = crypto.scryptSync(
    created.recoveryPassphrase,
    Buffer.from(snapshot.recovery.salt, "hex"),
    32,
    { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 },
  ).toString("hex");
  assert.strictEqual(verifier, snapshot.recovery.verifier);

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

  deleteAgentSnapshot(store, created.snapshot.snapshotId);
  assert.deepStrictEqual(listAgentSnapshots(store), []);
  assert.throws(() => deleteAgentSnapshot(store, created.snapshot.snapshotId), /not found/);
} finally {
  fs.rmSync(store, { recursive: true, force: true });
}

console.log("Agent Snapshot storage tests passed");
