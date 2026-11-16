import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createCipheriv, createDecipheriv, createHash, randomUUID } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { DatabaseSync } from "node:sqlite";
import { createLegacySnapshotRestore, initializeLegacySnapshotRestoreSchema } from "../dist/legacy-snapshot-restore.js";
import { initializeChatSessionSchema, createChatSessionStore } from "../dist/chat-session-store.js";
import { legacySnapshotRestoreSourcePins } from "../dist/domain/legacy-snapshot-restore-source-pins.js";
import { readOriginalSource } from "../scripts/migration.mjs";

export const hash = value => createHash("sha256").update(value).digest("hex");
export const at = "2026-11-07T16:30:00.000Z";
export const code = value => error => error?.code === value;
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const snapshotArchive = "migration/evidence/snapshot-authentication-originals.zip";
const snapshotArchiveSha256 = "88c60bdaf4cfafb4a9e5a1e02848518bf223b7be0008fb0908d49d115aab51c6";
const snapshotMembers = Object.freeze({
  "src/agent-sessions/agent-snapshots.ts": "snapshot-batch14-original/source/src/agent-sessions/agent-snapshots.ts",
  "src/agent-sessions/agent-session-lifecycle.ts": "snapshot-batch14-original/source/src/agent-sessions/agent-session-lifecycle.ts",
  "resources/agent_session_runtime.py": "snapshot-batch14-original/source/resources/agent_session_runtime.py",
  "src/chat/api-chat-store.ts": "snapshot-batch14-original/source/src/chat/api-chat-store.ts",
  "src/chat/api-chat-view.ts": "snapshot-batch14-original/source/src/chat/api-chat-view.ts",
  "src/chat/chat-budget-ledger.ts": "snapshot-batch14-original/source/src/chat/chat-budget-ledger.ts",
  "next-server/src/agent-runtime.ts": "snapshot-batch14-original/source/next-server/src/agent-runtime.ts",
  "next-server/src/manager-runtime.ts": "snapshot-batch14-original/source/next-server/src/manager-runtime.ts",
  "next-server/src/chat-session-store.ts": "snapshot-batch14-original/source/next-server/src/chat-session-store.ts",
  "next-server/src/legacy-state-import.ts": "snapshot-batch14-original/source/next-server/src/legacy-state-import.ts",
});
export async function readSnapshotOriginal(path, {
  root = packageRoot, kind = "source", sha256 = legacySnapshotRestoreSourcePins[path],
} = {}) {
  if (kind !== "source" || !Object.hasOwn(snapshotMembers, path)
    || !Object.hasOwn(legacySnapshotRestoreSourcePins, path) || sha256 !== legacySnapshotRestoreSourcePins[path]) {
    throw new Error("No exact snapshot source path/role/digest binding.");
  }
  return readOriginalSource(`${snapshotArchive}!/${snapshotMembers[path]}`, {
    root, kind, sha256, archiveSha256: snapshotArchiveSha256,
  });
}
assert.deepEqual(Object.keys(snapshotMembers).sort(), Object.keys(legacySnapshotRestoreSourcePins).sort());
const authenticatedSources = new Map(await Promise.all(Object.keys(legacySnapshotRestoreSourcePins)
  .map(async path => [path, await readSnapshotOriginal(path)])));
export function snapshotOriginalSource(path) {
  assert.equal(Object.hasOwn(snapshotMembers, path), true, "Unknown snapshot original");
  const bytes = authenticatedSources.get(path);
  assert.equal(hash(bytes), legacySnapshotRestoreSourcePins[path], `Source pin changed: ${path}`);
  return bytes.toString("utf8");
}
export function sourceOracle() {
  for (const path of Object.keys(legacySnapshotRestoreSourcePins)) snapshotOriginalSource(path);
  const source = snapshotOriginalSource("src/agent-sessions/agent-snapshots.ts");
  const ast = ts.createSourceFile("original.ts", source, ts.ScriptTarget.Latest, true);
  const names = ["continuationTodo", "agentSnapshotRecovery", "snapshotAad", "encryptPayload",
    "payloadKey", "decryptEnvelope", "decryptPayload", "snapshotCapture"];
  const captured = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    .map(node => node.getText(ast).replace(/^export /, "")).join("\n");
  assert.equal(captured.includes("function continuationTodo"), true);
  assert.equal(captured.includes("function agentSnapshotRecovery"), true);
  const context = createContext({
    createHash, createCipheriv, createDecipheriv, Buffer,
    randomBytes: count => Buffer.alloc(count, 3),
    SNAPSHOT_SCHEMA: "pkm.agent.snapshot/v1",
    SNAPSHOT_PAYLOAD_ALGORITHM: "A256GCM-PKM-LOCAL-OBFUSCATION/v1",
    LEGACY_SNAPSHOT_PAYLOAD_ALGORITHM: "A256GCM-PKM-INTERNAL/v1",
    SNAPSHOT_PAYLOAD_KEY: Buffer.alloc(32, 7), LEGACY_SNAPSHOT_PAYLOAD_KEY: Buffer.alloc(32, 8),
  });
  runInContext(ts.transpile(captured, { target: ts.ScriptTarget.ES2023 }), context);
  const oracle = (payload, snapshot, sessionId, recoveryKey) => JSON.parse(JSON.stringify(context.agentSnapshotRecovery(
    { snapshotId: snapshot.snapshotId, ...payload }, snapshot, sessionId, at, recoveryKey,
  )));
  oracle.encrypt = (payload, id, magic) => JSON.parse(JSON.stringify(context.encryptPayload(payload, id, magic)));
  oracle.decrypt = snapshot => JSON.parse(JSON.stringify(context.decryptPayload(snapshot)));
  oracle.capture = payload => JSON.parse(JSON.stringify(context.snapshotCapture(payload)));
  return oracle;
}
export function payloadFixture() {
  return {
    session: {
      schema: "pkm.agent.session/v1", sessionId: "agent_session_original",
      hostSessionId: "chat_original", origin: "pkm-native", hostKind: "pkm", runtimeOwner: "pkm",
      task: "Synthetic source task", status: "running", summary: "Review without replay", projectId: "project_fixture",
      todos: [
        { todoId: "todo_run", title: "Review child", status: "running", startedAt: at, recipeRunId: "recipe_run_parent" },
        { todoId: "todo_done", title: "Already done", status: "succeeded" },
      ],
      checkpoints: [
        { checkpointId: "checkpoint_one", sequence: 1, createdAt: at, reason: "manual", state: { summary: "Task checkpoint", next_actions: ["Review"] } },
        { checkpointId: "checkpoint_two", sequence: 2, createdAt: at, reason: "manual", state: { summary: "Latest checkpoint", nextActions: ["Continue locally"] } },
      ],
      recipeRunIds: ["recipe_run_parent", "recipe_run_child"],
      recipeTreeEdges: [{ fromRunId: "recipe_run_parent", toRunId: "recipe_run_child", nodeId: "nested" }],
      nativeChat: {
        id: "chat_original", workflowMode: "chat", includeHistory: true,
        messages: [
          { id: "message_user", role: "user", content: "Review fixture", status: "complete", taskId: "agent_session_original",
            metadata: { schema: "pkm.chat.transcript-metadata/v1", budgetReceipts: [{ consumed: { inputTokens: 12 }, status: "complete" }] } },
          { id: "message_assistant", role: "assistant", content: "Interrupted synthetic work", status: "streaming", taskId: "agent_session_original",
            toolCalls: [{ id: "tool_local", name: "fixture.inspect", arguments: "{}", status: "running" }] },
        ],
      },
    },
    recipeRuns: [
      { runId: "recipe_run_parent", recipeId: "recipe_parent", status: "running", receipts: { old: { status: "done" } },
        nodes: { nested: { state: "running", childRunId: "recipe_run_child", childRecipeId: "recipe_child", progress: { cancellationRequested: true } } } },
      { runId: "recipe_run_child", recipeId: "recipe_child", status: "running", parent: { runId: "recipe_run_parent", nodeId: "nested" },
        nodes: { leaf: { state: "succeeded", result: { value: "preserved" } } } },
    ],
  };
}
export function fixture(payload = payloadFixture(), db = new DatabaseSync(":memory:")) {
  db.exec("BEGIN IMMEDIATE");
  initializeLegacySnapshotRestoreSchema(db);
  initializeChatSessionSchema(db);
  db.exec("COMMIT");
  const key = Buffer.alloc(32, 7), oracle = sourceOracle();
  const snapshot = {
    schema: "pkm.agent.snapshot/v1", snapshotId: "agent_snapshot_capture", magicCode: "PKM-SNAP-AAAA-BBBB",
    sourceSessionId: payload.session.sessionId, sourceHostSessionId: payload.session.hostSessionId ?? "",
    sourceHostKind: payload.session.hostKind, task: payload.session.task, projectId: payload.session.projectId ?? "",
    agent: { name: "Local fixture", product: "PKM" }, reason: "manual", createdAt: at,
    capture: oracle.capture(payload),
  };
  snapshot.payload = oracle.encrypt(payload, snapshot.snapshotId, snapshot.magicCode);
  const bytes = Buffer.from(JSON.stringify(snapshot)), token = {}, foreign = {};
  const owner = { actorId: "actor_fixture", nativeOwnerId: "owner_fixture" };
  const binding = {
    ...owner, snapshotReceiptId: "import_receipt", cipherSha256: hash(bytes), keyEpoch: "epoch_fixture",
    sourceIdentity: "source_fixture", snapshotId: snapshot.snapshotId,
    sourceSessionId: snapshot.sourceSessionId, sourceHostSessionId: snapshot.sourceHostSessionId,
    targetWorkspaceId: "workspace_fixture", targetSessionId: "agent_session_target", targetChatId: "chat_target",
    policySha256: hash(JSON.stringify({ schema: "explicit-synthetic-secret-free-policy/v1", payloadSha256: hash(JSON.stringify(payload)) })),
    restoredAt: at, expiresAt: Date.parse(at) + 60000,
  };
  const f = { db, bytes, payload, snapshot, token, foreign, owner, binding, key,
    approved: true, epoch: binding.keyEpoch, safe: true, lease: true, time: Date.parse(at), calls: [] };
  const assertOutside = name => { assert.equal(db.isTransaction, false, name); f.calls.push(name); };
  const host = {
    resolveOwner: value => value === token ? owner : value === foreign ? { ...owner, actorId: "foreign_actor" } : undefined,
    loadImportedSnapshot: async (_owner, _receipt) => { assertOutside("load"); return { binding: { ...f.binding }, bytes: f.bytes }; },
    epoch: async () => { assertOutside("epoch"); return f.epoch; },
    key: async () => { assertOutside("key"); return key; },
    approve: async () => { assertOutside("approval"); return f.approved; },
    validateSafeState: async (_binding, data) => {
      assertOutside("safe-policy"); assert.equal(Object.isFrozen(data), true);
      assert.deepEqual(data, payload);
      return f.safe;
    },
    assertBinding: actual => {
      assert.deepEqual(actual, f.binding);
      if (!f.lease) throw Object.assign(new Error("owner lease lost"), { code: "LEASE_LOST" });
    },
  };
  f.host = host;
  f.restart = () => createLegacySnapshotRestore(db, { host, now: () => f.time, assertOwner: () => {
    if (!f.lease) throw Object.assign(new Error("owner lease lost"), { code: "LEASE_LOST" });
  } });
  f.runtime = f.restart();
  f.chat = createChatSessionStore(db);
  f.input = () => ({ opId: randomUUID(), snapshotReceiptId: f.binding.snapshotReceiptId, cipherSha256: f.binding.cipherSha256 });
  f.close = () => { key.fill(0); db.close(); };
  return f;
}
