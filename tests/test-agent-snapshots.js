#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createAgentSnapshot, deleteAgentSnapshot, listAgentSnapshots } = require("../dist/agent-snapshots");

function encryptPayload(payload, snapshotId, magicCode, keyText = "uone") {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(keyText, "utf8").digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`pkm.agent.snapshot/v1:${snapshotId}:${magicCode}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    algorithm: keyText === "uone"
      ? "A256GCM-PKM-LOCAL-OBFUSCATION/v1"
      : "A256GCM-PKM-INTERNAL/v1",
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function decryptPayload(payload, snapshotId, magicCode) {
  const key = crypto.createHash("sha256").update("uone", "utf8").digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64url"));
  decipher.setAAD(Buffer.from(`pkm.agent.snapshot/v1:${snapshotId}:${magicCode}`, "utf8"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8"));
}

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
  assert.strictEqual(
    created.recoveryPrompt,
    `Call the PKM MCP function agent_session_snapshot_recover with {"magic_code":"${created.snapshot.magicCode}"}.`,
  );

  const snapshotPath = path.join(state, "agent-snapshots", `${created.snapshot.snapshotId}.json`);
  const snapshotText = fs.readFileSync(snapshotPath, "utf8");
  const snapshot = JSON.parse(snapshotText);
  assert.strictEqual(snapshot.schema, "pkm.agent.snapshot/v1");
  assert.strictEqual(snapshot.payload.algorithm, "A256GCM-PKM-LOCAL-OBFUSCATION/v1");
  assert.strictEqual(snapshot.recovery, undefined);
  assert.ok(!snapshotText.includes("sensitive snapshot payload"));
  assert.strictEqual(snapshot.capture.todoCount, 1);
  assert.strictEqual(snapshot.capture.recipeRunCount, 1);

  const listed = listAgentSnapshots(store);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].todoCount, 1);
  assert.strictEqual(listed[0].recipeRunCount, 1);
  assert.strictEqual(listed[0].recoveryCount, 0);
  assert.strictEqual(fs.readFileSync(snapshotPath, "utf8"), snapshotText,
    "listing a healthy Snapshot must not rewrite its immutable record");

  const doubleWrapped = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  doubleWrapped.capture = { recipeRunCount: 0, todoCount: 0 };
  doubleWrapped.payload = encryptPayload(
    doubleWrapped.payload, doubleWrapped.snapshotId, doubleWrapped.magicCode);
  fs.writeFileSync(snapshotPath, JSON.stringify(doubleWrapped));
  const repaired = listAgentSnapshots(store).find(item => item.snapshotId === created.snapshot.snapshotId);
  assert.strictEqual(repaired.todoCount, 1);
  assert.strictEqual(repaired.recipeRunCount, 1);
  const repairedRecord = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const repairedPayload = decryptPayload(
    repairedRecord.payload, repairedRecord.snapshotId, repairedRecord.magicCode);
  assert.ok(repairedPayload.session);
  assert.ok(Array.isArray(repairedPayload.recipeRuns));
  assert.strictEqual(repairedPayload.algorithm, undefined, "migration removes nested encryption envelopes");

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
    recovery: { algorithm: "scrypt-sha256/v1", salt: "00", verifier: "legacy" },
    payload: { session: { todos: [{ title: "legacy plaintext todo" }], checkpoints: [] }, recipeRuns: [] },
  }));
  listAgentSnapshots(store);
  const migratedLegacy = fs.readFileSync(legacyPath, "utf8");
  assert.doesNotMatch(migratedLegacy, /legacy plaintext todo/);
  assert.strictEqual(JSON.parse(migratedLegacy).payload.algorithm, "A256GCM-PKM-LOCAL-OBFUSCATION/v1");
  assert.strictEqual(JSON.parse(migratedLegacy).recovery, undefined);

  const legacyEncryptedId = "agent_snapshot_legacy_encrypted";
  const legacyEncryptedMagic = "PKM-SNAP-AAAA-BBBB-CCCC-DDDD";
  const legacyEncryptedPath = path.join(state, "agent-snapshots", `${legacyEncryptedId}.json`);
  const legacyPayload = { session: { todos: [{ title: "legacy encrypted todo" }], checkpoints: [] }, recipeRuns: [] };
  fs.writeFileSync(legacyEncryptedPath, JSON.stringify({
    schema: "pkm.agent.snapshot/v1",
    snapshotId: legacyEncryptedId,
    magicCode: legacyEncryptedMagic,
    sourceSessionId: sessionId,
    task: "Legacy encrypted snapshot",
    createdAt: "2026-09-21T00:00:00Z",
    recovery: { algorithm: "scrypt-sha256/v1", salt: "00", verifier: "legacy" },
    payload: encryptPayload(
      legacyPayload, legacyEncryptedId, legacyEncryptedMagic, "uone:agent-snapshot:payload:v1"),
  }));
  listAgentSnapshots(store);
  const migratedEncrypted = JSON.parse(fs.readFileSync(legacyEncryptedPath, "utf8"));
  assert.strictEqual(migratedEncrypted.payload.algorithm, "A256GCM-PKM-LOCAL-OBFUSCATION/v1");
  assert.strictEqual(migratedEncrypted.recovery, undefined);
  assert.doesNotMatch(JSON.stringify(migratedEncrypted), /legacy encrypted todo/);

  deleteAgentSnapshot(store, created.snapshot.snapshotId);
  deleteAgentSnapshot(store, legacyId);
  deleteAgentSnapshot(store, legacyEncryptedId);
  assert.deepStrictEqual(listAgentSnapshots(store), []);
  assert.throws(() => deleteAgentSnapshot(store, created.snapshot.snapshotId), /not found/);
} finally {
  fs.rmSync(store, { recursive: true, force: true });
}

console.log("Agent Snapshot storage tests passed");
