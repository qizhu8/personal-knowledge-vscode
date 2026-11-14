import { createDecipheriv, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createChatSessionStore } from "./chat-session-store.js";
import { chatSessionMessageInput } from "./chat-session-contracts.js";
import {
  legacySnapshotRestoreDefinitions, legacySnapshotRestorePayload,
  LEGACY_SNAPSHOT_RESTORE_SCHEMA_VERSION,
} from "./legacy-snapshot-restore-contracts.js";
import { legacySnapshotRecovery } from "./domain/legacy-snapshot-restore-recovery.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const fingerprint = (value: unknown) => sha(JSON.stringify(value));
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.strictObject({
  actorId: identifier, nativeOwnerId: identifier, snapshotReceiptId: identifier,
  cipherSha256: digest, keyEpoch: identifier, sourceIdentity: identifier,
  snapshotId: z.string().regex(/^agent_snapshot_[A-Za-z0-9_-]+$/),
  sourceSessionId: identifier, sourceHostSessionId: z.string().max(128),
  targetWorkspaceId: identifier, targetSessionId: identifier, targetChatId: identifier,
  policySha256: digest, restoredAt: z.string().datetime(), expiresAt: z.number().int().safe().positive(),
});
export type LegacySnapshotRestoreBinding = z.infer<typeof bindingSchema>;
export interface LegacySnapshotRestoreOwner { actorId: string; nativeOwnerId: string }
export interface LegacySnapshotRestoreHost {
  resolveOwner(token: object): LegacySnapshotRestoreOwner | undefined;
  /** Read the already imported receipt and ORIGINAL bytes; never a user path or a live Knowledge Root. */
  loadImportedSnapshot(owner: Readonly<LegacySnapshotRestoreOwner>, receiptId: string):
    Promise<{ binding: LegacySnapshotRestoreBinding; bytes: Uint8Array }>;
  epoch(): Promise<string | undefined>;
  key(algorithm: string, epoch: string): Promise<Uint8Array | undefined>;
  /** Native operator approval AND revocation lookup. Strings/Magic Codes/public tokens are not grants. */
  approve(binding: Readonly<LegacySnapshotRestoreBinding>, action: "restore-paused" | "resume" | "cancel"): Promise<boolean>;
  /** MUST validate the entire supported payload against explicit redaction/serialization policy. */
  validateSafeState(binding: Readonly<LegacySnapshotRestoreBinding>, payload: unknown): Promise<boolean>;
  /** Synchronous, I/O-free native actor/workspace/session/receipt/owner-lease fence, including policy and revocation. */
  assertBinding(binding: Readonly<LegacySnapshotRestoreBinding>): void;
  /**
   * Optional existing Agent/Manager/Chat mapping. Never maps historical running receipts into grants.
   * Effects may be uncertain. inspect must confirm real native identities, never a worker's self-report.
   */
  control?: {
    resume(binding: Readonly<LegacySnapshotRestoreBinding>, staged: unknown, effectId: string): Promise<void>;
    cancel(binding: Readonly<LegacySnapshotRestoreBinding>, effectId: string): Promise<void>;
    inspect(binding: Readonly<LegacySnapshotRestoreBinding>, effectId: string):
      Promise<{ sessionId: string; chatId: string; state: "native-controlled" | "cancelled" | "unknown" }>;
  };
}
export class LegacySnapshotRestoreError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function fail(code: string, message: string): never { throw new LegacySnapshotRestoreError(code, message); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}
const sensitive = /^(?:.*(?:token|secret|password|credential|authorization|authVerifier|privateKey|apiKey)|__proto__|prototype|constructor)$/i;
const secretValue = /-----BEGIN [A-Z ]*PRIVATE KEY-----|pkms:v1:|Bearer\s+|[?&](?:access_token|token|key|secret|password)=/i;
function safeJson(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 100000 || depth > 32) fail("LIMIT", "Snapshot state exceeds bounds.");
  if (typeof value === "string" && secretValue.test(value)) fail("SECRET_STATE", "Secret-bearing state is unsupported.");
  if (Array.isArray(value)) for (const item of value) safeJson(item, depth + 1, budget);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    // Numeric token budgets are state, not credential tokens.
    if (sensitive.test(key) && !["maxOutputTokens", "inputTokens", "outputTokens", "estimatedInputTokens"].includes(key)) {
      fail("SECRET_STATE", "Sensitive or unsafe state fields are unsupported.");
    }
    safeJson(item, depth + 1, budget);
  }
}
const envelopeSchema = z.strictObject({
  algorithm: z.enum(["A256GCM-PKM-LOCAL-OBFUSCATION/v1", "A256GCM-PKM-INTERNAL/v1"]),
  iv: z.string(), tag: z.string(), ciphertext: z.string(),
});
const snapshotSchema = z.strictObject({
  schema: z.literal("pkm.agent.snapshot/v1"), snapshotId: identifier,
  magicCode: z.string().regex(/^PKM-SNAP-[A-Z0-9-]+$/).max(160),
  sourceSessionId: identifier, sourceHostSessionId: z.string().max(128), sourceHostKind: z.string(),
  task: z.string(), projectId: z.string(), name: z.string().optional(),
  agent: z.strictObject({ name: z.string(), product: z.string() }), reason: z.string(), createdAt: z.string(),
  capture: z.strictObject({
    recipeRunCount: z.number().int().nonnegative(), todoCount: z.number().int().nonnegative(),
    checkpoint: z.strictObject({
      checkpointId: identifier, sequence: z.number().int().positive(), createdAt: z.string(), reason: z.string(),
    }).optional(),
  }),
  payload: envelopeSchema,
});

function deriveStaging(binding: LegacySnapshotRestoreBinding, history: unknown) {
  safeJson(history);
  const parsed = legacySnapshotRestorePayload.safeParse(history);
  if (!parsed.success) fail("STATE_TAMPERED", "Persisted restore history contains unsupported state.");
  const payload = parsed.data, source = payload.session;
  if (source.sessionId !== binding.sourceSessionId || (source.hostSessionId ?? "") !== binding.sourceHostSessionId) {
    fail("STATE_TAMPERED", "Persisted source history identity changed.");
  }
  const recovery = legacySnapshotRecovery(payload, binding.snapshotId, binding.sourceSessionId,
    binding.targetSessionId, binding.restoredAt, fingerprint(binding));
  const messages = (source.nativeChat?.messages ?? []).map(original => {
    const message = structuredClone(original);
    if (message.taskId) message.taskId = binding.targetSessionId;
    if (message.status === "streaming") message.status = "interrupted";
    if (message.toolCalls) message.toolCalls = message.toolCalls.map(call => call.status === "running"
      ? { ...call, status: "failed", result: call.result || "Interrupted before the Snapshot was recovered." } : call);
    return chatSessionMessageInput.parse(message);
  });
  return {
    checkpoints: recovery.session.checkpoints, history: payload,
    recipes: recovery.recipeRuns, task: { task: source.task, status: "paused", ...recovery.session },
    transcript: messages,
  };
}

/** Pure, synchronous shared backup/recovery validation hook. No grant, callback, I/O or effects. */
export function validateLegacySnapshotRestoreStaging(binding: LegacySnapshotRestoreBinding,
  restoreId: string, staging: unknown): void {
  const parsed = bindingSchema.safeParse(binding);
  if (!parsed.success || fingerprint(binding) !== restoreId) fail("STATE_TAMPERED", "Restore binding identity changed.");
  if (!staging || typeof staging !== "object" || Array.isArray(staging)) fail("STATE_TAMPERED", "Restore staging is unsupported.");
  safeJson(staging);
  const state = staging as Record<string, unknown>;
  if (Object.keys(state).length !== 5) fail("STATE_TAMPERED", "Restore staging is incomplete.");
  const derived = deriveStaging(binding, state.history);
  for (const [kind, value] of Object.entries(derived)) {
    if (fingerprint(state[kind]) !== fingerprint(value)) fail("STATE_TAMPERED", "Restore surface differs from approved history derivation.");
  }
}

/** Schema-only hook. Parent owns schema version, transaction, owner lease and backup fencing. */
export function initializeLegacySnapshotRestoreSchema(db: DatabaseSync): void {
  if (!db.isTransaction) fail("TRANSACTION_REQUIRED", "Initialize restore schema in the parent migration transaction.");
  db.exec(`
    CREATE TABLE IF NOT EXISTS legacy_snapshot_restore_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS legacy_snapshot_restore_originals(
      actor_id TEXT NOT NULL,owner_id TEXT NOT NULL,restore_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,cipher_hash TEXT NOT NULL,binding TEXT NOT NULL,original BLOB NOT NULL,
      PRIMARY KEY(actor_id,owner_id,restore_id),UNIQUE(actor_id,owner_id,workspace_id,snapshot_id,cipher_hash));
    CREATE TABLE IF NOT EXISTS legacy_snapshot_restore_records(
      actor_id TEXT NOT NULL,owner_id TEXT NOT NULL,restore_id TEXT NOT NULL,record TEXT NOT NULL,
      PRIMARY KEY(actor_id,owner_id,restore_id));
    CREATE TABLE IF NOT EXISTS legacy_snapshot_restore_staging(
      actor_id TEXT NOT NULL,owner_id TEXT NOT NULL,restore_id TEXT NOT NULL,kind TEXT NOT NULL,record TEXT NOT NULL,sha256 TEXT NOT NULL,
      PRIMARY KEY(actor_id,owner_id,restore_id,kind));
    CREATE TABLE IF NOT EXISTS legacy_snapshot_restore_receipts(
      actor_id TEXT NOT NULL,owner_id TEXT NOT NULL,op_id TEXT NOT NULL,fingerprint TEXT NOT NULL,record TEXT NOT NULL,
      PRIMARY KEY(actor_id,owner_id,op_id));
    CREATE TABLE IF NOT EXISTS legacy_snapshot_restore_effects(
      actor_id TEXT NOT NULL,owner_id TEXT NOT NULL,effect_id TEXT NOT NULL,restore_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,
      PRIMARY KEY(actor_id,owner_id,effect_id));
    INSERT OR IGNORE INTO legacy_snapshot_restore_schema VALUES(1,1);
  `);
  if (db.prepare("SELECT version FROM legacy_snapshot_restore_schema WHERE singleton=1").get()?.version !== LEGACY_SNAPSHOT_RESTORE_SCHEMA_VERSION) {
    fail("UNSUPPORTED_SCHEMA", "Unsupported restore schema.");
  }
}

/**
 * Native-only restore coordinator. No startup work, FS, model, timers or process APIs.
 * Decryption and imported-file callbacks occur OUTSIDE SQL. Safe staging, Chat import,
 * original ciphertext and durable receipt are committed together BEFORE any native effect.
 */
export function createLegacySnapshotRestore(db: DatabaseSync, options: {
  host: LegacySnapshotRestoreHost; assertOwner: () => void; now?: () => number;
}) {
  const host = options.host, now = options.now ?? Date.now;
  const chat = createChatSessionStore(db, { now: () => new Date(now()).toISOString() });
  function outside() {
    if (db.isTransaction) fail("TRANSACTION_BOUNDARY", "Native callbacks require no enclosing SQL transaction.");
    options.assertOwner();
    if (db.prepare("SELECT version FROM legacy_snapshot_restore_schema WHERE singleton=1").get()?.version !== LEGACY_SNAPSHOT_RESTORE_SCHEMA_VERSION) {
      fail("UNSUPPORTED_SCHEMA", "Unsupported restore schema.");
    }
  }
  function owner(token: object): LegacySnapshotRestoreOwner {
    outside();
    if (!token || typeof token !== "object") fail("UNAUTHORIZED", "Native owner capability required.");
    const value = host.resolveOwner(token);
    if (!value || !identifier.safeParse(value.actorId).success || !identifier.safeParse(value.nativeOwnerId).success) {
      return fail("UNAUTHORIZED", "Native owner capability was not issued.");
    }
    return { ...value };
  }
  function fence(token: object, binding: LegacySnapshotRestoreBinding, inTransaction = false) {
    if (!inTransaction) outside(); else options.assertOwner();
    const current = host.resolveOwner(token);
    if (!current || current.actorId !== binding.actorId || current.nativeOwnerId !== binding.nativeOwnerId
      || now() >= binding.expiresAt) fail("AUTHORITY_EXPIRED", "Snapshot native authority expired or changed.");
    host.assertBinding(binding);
  }
  async function authorize(token: object, binding: LegacySnapshotRestoreBinding, action: "restore-paused" | "resume" | "cancel") {
    fence(token, binding);
    if (await host.epoch() !== binding.keyEpoch) fail("KEY_EXPIRED", "Snapshot key epoch expired.");
    fence(token, binding);
    if (!await host.approve(binding, action)) fail("APPROVAL_REQUIRED", "Explicit native operator approval required.");
    fence(token, binding);
    if (await host.epoch() !== binding.keyEpoch) fail("KEY_EXPIRED", "Snapshot key epoch expired.");
    fence(token, binding);
  }
  function atomic<T>(token: object, binding: LegacySnapshotRestoreBinding, callback: () => T): T {
    fence(token, binding);
    db.exec("BEGIN IMMEDIATE");
    try { const result = callback(); fence(token, binding, true); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function receipt(context: LegacySnapshotRestoreOwner, opId: string, pin: string) {
    const row = db.prepare("SELECT fingerprint,record FROM legacy_snapshot_restore_receipts WHERE actor_id=? AND owner_id=? AND op_id=?")
      .get(context.actorId, context.nativeOwnerId, opId);
    if (row && row.fingerprint !== pin) fail("OP_CONFLICT", "Operation receipt pins different intent.");
    return row ? legacySnapshotRestoreDefinitions[0].output.parse(JSON.parse(String(row.record))) : undefined;
  }
  function saveReceipt(context: LegacySnapshotRestoreOwner, opId: string, pin: string, record: unknown) {
    db.prepare("INSERT INTO legacy_snapshot_restore_receipts VALUES(?,?,?,?,?)")
      .run(context.actorId, context.nativeOwnerId, opId, pin, JSON.stringify(record));
  }
  function read(context: LegacySnapshotRestoreOwner, restoreId: string) {
    const row = db.prepare(`SELECT o.binding,o.original,o.cipher_hash,r.record FROM legacy_snapshot_restore_originals o
      JOIN legacy_snapshot_restore_records r USING(actor_id,owner_id,restore_id)
      WHERE o.actor_id=? AND o.owner_id=? AND o.restore_id=?`).get(context.actorId, context.nativeOwnerId, restoreId);
    if (!row) return fail("NOT_FOUND", "Actor-owned restore not found.");
    const binding = freeze(bindingSchema.parse(JSON.parse(String(row.binding))));
    if (sha(row.original as Uint8Array) !== row.cipher_hash || binding.cipherSha256 !== row.cipher_hash
      || binding.actorId !== context.actorId || binding.nativeOwnerId !== context.nativeOwnerId
      || fingerprint(binding) !== restoreId) fail("STATE_TAMPERED", "Restore identity or original ciphertext changed.");
    const record = legacySnapshotRestoreDefinitions[0].output.parse(JSON.parse(String(row.record)));
    if (record.restoreId !== restoreId || record.sessionId !== binding.targetSessionId || record.chatId !== binding.targetChatId) {
      fail("STATE_TAMPERED", "Restore target identity changed.");
    }
    return { binding, record };
  }
  function staged(context: LegacySnapshotRestoreOwner, restoreId: string) {
    const rows = db.prepare("SELECT kind,record,sha256 FROM legacy_snapshot_restore_staging WHERE actor_id=? AND owner_id=? AND restore_id=? ORDER BY kind")
      .all(context.actorId, context.nativeOwnerId, restoreId);
    if (rows.length !== 5) fail("STATE_TAMPERED", "Restore staging is incomplete.");
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      if (sha(String(row.record)) !== row.sha256) fail("STATE_TAMPERED", "Restore staging changed.");
      result[String(row.kind)] = JSON.parse(String(row.record));
    }
    const { record, binding } = read(context, restoreId);
    if (fingerprint({ binding, staging: result }) !== record.planSha256) fail("STATE_TAMPERED", "Restore plan changed.");
    validateLegacySnapshotRestoreStaging(binding, restoreId, result);
    return freeze(result);
  }
  async function validateStagedPolicy(token: object, binding: LegacySnapshotRestoreBinding,
    action: "resume" | "cancel", state: Readonly<Record<string, unknown>>) {
    await authorize(token, binding, action);
    if (!await host.validateSafeState(binding, state.history)) fail("SAFE_POLICY_REQUIRED", "Native serialized-state policy rejected persisted history.");
    await authorize(token, binding, action);
  }
  return {
    async restorePaused(token: object, input: unknown) {
      const context = owner(token);
      const parsed = legacySnapshotRestoreDefinitions[0].input.safeParse(input);
      if (!parsed.success) return fail("INVALID_INPUT", "Restore requires strict intent-only pins.");
      const args = parsed.data, pin = fingerprint(["restore-paused", args]);
      outside();
      const loaded = await host.loadImportedSnapshot(freeze(context), args.snapshotReceiptId);
      outside();
      const binding = freeze(bindingSchema.parse(loaded.binding)), bytes = Buffer.from(loaded.bytes);
      if (bytes.length > 2 * 1024 * 1024 || binding.actorId !== context.actorId || binding.nativeOwnerId !== context.nativeOwnerId
        || binding.snapshotReceiptId !== args.snapshotReceiptId || binding.cipherSha256 !== args.cipherSha256
        || sha(bytes) !== args.cipherSha256) fail("SOURCE_TAMPERED", "Imported snapshot receipt or ciphertext changed.");
      await authorize(token, binding, "restore-paused");
      const replay = receipt(context, args.opId, pin);
      if (replay) {
        if (fingerprint(binding) !== replay.restoreId) fail("OP_CONFLICT", "Native receipt authority changed; no old restore grant replayed.");
        const stored = read(context, replay.restoreId);
        fence(token, stored.binding);
        staged(context, replay.restoreId);
        return replay;
      }
      let snapshot: z.infer<typeof snapshotSchema>;
      try { snapshot = snapshotSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
      catch { return fail("UNSUPPORTED_STATE", "Original encrypted snapshot schema is unsupported."); }
      safeJson({ ...snapshot, payload: null });
      if (snapshot.snapshotId !== binding.snapshotId || snapshot.sourceSessionId !== binding.sourceSessionId
        || snapshot.sourceHostSessionId !== binding.sourceHostSessionId) fail("SOURCE_TAMPERED", "Original snapshot identity differs from native receipt.");
      let decrypted: unknown = snapshot.payload;
      for (let depth = 0; depth < 4; depth++) {
        const envelope = envelopeSchema.safeParse(decrypted);
        if (!envelope.success) break;
        await authorize(token, binding, "restore-paused");
        const supplied = await host.key(envelope.data.algorithm, binding.keyEpoch);
        fence(token, binding);
        if (!(supplied instanceof Uint8Array) || supplied.length !== 32) fail("KEY_UNAVAILABLE", "Native key authority unavailable.");
        const key = Buffer.from(supplied);
        let plaintext: Buffer | undefined;
        try {
          const decode = (text: string, length?: number) => {
            const value = Buffer.from(text, "base64url");
            if (value.toString("base64url") !== text || (length !== undefined && value.length !== length)) throw new Error();
            return value;
          };
          const cipher = createDecipheriv("aes-256-gcm", key, decode(envelope.data.iv, 12));
          cipher.setAAD(Buffer.from(`${snapshot.schema}:${snapshot.snapshotId}:${snapshot.magicCode}`));
          cipher.setAuthTag(decode(envelope.data.tag, 16));
          plaintext = Buffer.concat([cipher.update(decode(envelope.data.ciphertext)), cipher.final()]);
          decrypted = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
        } catch { return fail("CIPHERTEXT_INVALID", "Snapshot authentication failed."); }
        finally { key.fill(0); plaintext?.fill(0); }
        await authorize(token, binding, "restore-paused");
      }
      safeJson(decrypted);
      const payloadResult = legacySnapshotRestorePayload.safeParse(decrypted);
      if (!payloadResult.success) return fail("UNSUPPORTED_STATE", "Every unsupported runtime surface must be explicitly mapped; no fields discarded.");
      const payload = freeze(payloadResult.data), source = payload.session;
      if (source.sessionId !== binding.sourceSessionId || (source.hostSessionId ?? "") !== binding.sourceHostSessionId
        || source.hostKind !== snapshot.sourceHostKind) fail("SOURCE_TAMPERED", "Original session ownership differs from receipt.");
      if (source.origin !== "pkm-native" && (source.nativeChat || payload.recipeRuns.length)) {
        fail("UNSUPPORTED_STATE", "External host conversation or Recipe effects require a separate mapping.");
      }
      if (source.origin === "pkm-native" && (source.hostKind !== "pkm" || (source.runtimeOwner && source.runtimeOwner !== "pkm"))) {
        fail("UNSUPPORTED_STATE", "Native session ownership is unsupported.");
      }
      const runIds = new Set(payload.recipeRuns.map(run => run.runId));
      const todoIds = new Set(source.todos.map(todo => todo.todoId));
      const messageIds = new Set(source.nativeChat?.messages.map(message => message.id) ?? []);
      if (runIds.size !== payload.recipeRuns.length || todoIds.size !== source.todos.length
        || messageIds.size !== (source.nativeChat?.messages.length ?? 0)) fail("UNSUPPORTED_STATE", "Duplicate runtime identities.");
      const references = [
        ...(source.recipeRunIds ?? []), ...source.todos.flatMap(todo => [...(todo.recipeRunIds ?? []), ...(todo.recipeRunId ? [todo.recipeRunId] : [])]),
        ...payload.recipeRuns.flatMap(run => [...(run.parent ? [run.parent.runId] : []), ...Object.values(run.nodes).flatMap(node => node.childRunId ? [node.childRunId] : [])]),
        ...(source.recipeTreeEdges ?? []).flatMap(edge => [edge.fromRunId, edge.toRunId]),
      ];
      if (references.some(id => !runIds.has(id))) fail("UNSUPPORTED_STATE", "Unmapped Recipe identity; no dangling state discarded.");
      const edges = [
        ...(source.recipeTreeEdges ?? []).map(edge => [edge.fromRunId, edge.toRunId]),
        ...payload.recipeRuns.flatMap(run => [
          ...(run.parent ? [[run.parent.runId, run.runId]] : []),
          ...Object.values(run.nodes).flatMap(node => node.childRunId ? [[run.runId, node.childRunId]] : []),
        ]),
      ];
      const visiting = new Set<string>(), visited = new Set<string>();
      const visit = (id: string): void => {
        if (visiting.has(id)) fail("UNSUPPORTED_STATE", "Recipe tree is cyclic.");
        if (visited.has(id)) return;
        visiting.add(id);
        for (const [from, to] of edges) if (from === id) visit(to!);
        visiting.delete(id); visited.add(id);
      };
      for (const id of runIds) visit(id);
      const latest = source.checkpoints.at(-1);
      if (snapshot.capture.todoCount !== source.todos.length || snapshot.capture.recipeRunCount !== payload.recipeRuns.length
        || fingerprint(snapshot.capture.checkpoint ?? null) !== fingerprint(latest ? {
          checkpointId: latest.checkpointId, sequence: latest.sequence, createdAt: latest.createdAt, reason: latest.reason,
        } : null)) fail("SOURCE_TAMPERED", "Original capture metadata differs from payload.");
      fence(token, binding);
      if (!await host.validateSafeState(binding, payload)) fail("SAFE_POLICY_REQUIRED", "Native serialized-state policy rejected payload.");
      await authorize(token, binding, "restore-paused");
      const restoreId = fingerprint(binding);
      const staging = deriveStaging(binding, payload), messages = staging.transcript;
      const planSha256 = fingerprint({ binding, staging });
      const record = legacySnapshotRestoreDefinitions[0].output.parse({
        restoreId, revision: 1, state: "paused", chatId: binding.targetChatId, sessionId: binding.targetSessionId, planSha256, replay: "never",
      });
      return atomic(token, binding, () => {
        const prior = receipt(context, args.opId, pin);
        if (prior) return prior;
        if (db.prepare("SELECT restore_id FROM legacy_snapshot_restore_originals WHERE actor_id=? AND owner_id=? AND workspace_id=? AND snapshot_id=? AND cipher_hash=?")
          .get(context.actorId, context.nativeOwnerId, binding.targetWorkspaceId, binding.snapshotId, binding.cipherSha256)) {
          fail("DUPLICATE_SNAPSHOT", "Snapshot already restored; no new identity or replay grant issued.");
        }
        db.prepare("INSERT INTO legacy_snapshot_restore_originals VALUES(?,?,?,?,?,?,?,?)")
          .run(context.actorId, context.nativeOwnerId, restoreId, binding.targetWorkspaceId, binding.snapshotId, binding.cipherSha256, JSON.stringify(binding), bytes);
        db.prepare("INSERT INTO legacy_snapshot_restore_records VALUES(?,?,?,?)").run(context.actorId, context.nativeOwnerId, restoreId, JSON.stringify(record));
        for (const [kind, value] of Object.entries(staging)) {
          const text = JSON.stringify(value);
          db.prepare("INSERT INTO legacy_snapshot_restore_staging VALUES(?,?,?,?,?,?)")
            .run(context.actorId, context.nativeOwnerId, restoreId, kind, text, sha(text));
        }
        const title = String(snapshot.name || snapshot.task || source.task || "Recovered Snapshot")
          .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100) || "Recovered Snapshot";
        const { messages: _messages, id: _id, ...metadata } = source.nativeChat ?? { messages: [] };
        let session = chat.execute({ operation: "chat.session.create", args: {
          operationId: args.opId, id: record.chatId, expectedRevision: 0, title: `${title} (recovered)`.slice(0, 120),
          metadata: { schema: "pkm.chat.session-metadata/v1", sessionId: record.sessionId, ...metadata },
        } }, context.actorId) as { revision: number };
        for (const message of messages) {
          const appended = chat.execute({ operation: "chat.session.append", args: {
            operationId: args.opId, id: record.chatId, expectedRevision: session.revision, message,
          } }, context.actorId) as { session: { revision: number } };
          session = appended.session;
        }
        saveReceipt(context, args.opId, pin, record);
        return record;
      });
    },
    get(token: object, input: unknown) {
      const context = owner(token), args = legacySnapshotRestoreDefinitions[3].input.parse(input);
      const result = read(context, args.restoreId);
      fence(token, result.binding);
      staged(context, args.restoreId);
      return result.record;
    },
    readStaged(token: object, input: unknown) {
      const context = owner(token), args = legacySnapshotRestoreDefinitions[3].input.parse(input);
      fence(token, read(context, args.restoreId).binding);
      return staged(context, args.restoreId);
    },
    pending(token: object) {
      const context = owner(token);
      return db.prepare("SELECT restore_id,effect_id,kind FROM legacy_snapshot_restore_effects WHERE actor_id=? AND owner_id=? AND state='unknown' ORDER BY effect_id")
        .all(context.actorId, context.nativeOwnerId).map(row => {
          const { binding } = read(context, String(row.restore_id));
          fence(token, binding);
          return { restoreId: String(row.restore_id), effectId: String(row.effect_id), kind: String(row.kind), replay: "never" as const };
        });
    },
    async confirmNative(token: object, input: unknown) {
      const context = owner(token);
      const args = legacySnapshotRestoreDefinitions[4].input.parse(input), pin = fingerprint(["confirm-native", args]);
      const { binding, record } = read(context, args.restoreId);
      const action = ["resume-unknown", "native-controlled"].includes(record.state) ? "resume" : "cancel";
      await authorize(token, binding, action);
      const prior = receipt(context, args.opId, pin);
      if (prior) return read(context, prior.restoreId).record;
      if (!["resume-unknown", "cancel-unknown"].includes(record.state)) fail("NO_UNKNOWN_EFFECT", "No unknown native effect to confirm.");
      const state = staged(context, args.restoreId);
      await validateStagedPolicy(token, binding, action, state);
      if (!host.control) fail("NATIVE_MAPPING_UNAVAILABLE", "Native confirmation mapping is unavailable.");
      if (record.revision !== args.expectedRevision) fail("REVISION_CONFLICT", "Restore revision changed.");
      const effect = db.prepare("SELECT effect_id FROM legacy_snapshot_restore_effects WHERE actor_id=? AND owner_id=? AND restore_id=? AND kind=? AND state='unknown'")
        .get(context.actorId, context.nativeOwnerId, args.restoreId, action);
      if (!effect) fail("STATE_TAMPERED", "Unknown effect journal is missing.");
      // Observation only; never call resume/cancel while reconnecting an uncertain effect.
      const observation = await host.control.inspect(binding, String(effect.effect_id));
      await authorize(token, binding, action);
      if (observation.sessionId !== binding.targetSessionId || observation.chatId !== binding.targetChatId
        || observation.state !== (action === "resume" ? "native-controlled" : "cancelled")) return record;
      return atomic(token, binding, () => {
        if (read(context, args.restoreId).record.revision !== record.revision) fail("REVISION_CONFLICT", "Restore changed during native confirmation.");
        const confirmed = { ...record, revision: record.revision + 1, state: observation.state };
        db.prepare("UPDATE legacy_snapshot_restore_records SET record=? WHERE actor_id=? AND owner_id=? AND restore_id=?")
          .run(JSON.stringify(confirmed), context.actorId, context.nativeOwnerId, args.restoreId);
        if (action === "cancel") {
          db.prepare("UPDATE legacy_snapshot_restore_effects SET state='confirmed' WHERE actor_id=? AND owner_id=? AND restore_id=? AND state='unknown'")
            .run(context.actorId, context.nativeOwnerId, args.restoreId);
        } else {
          db.prepare("UPDATE legacy_snapshot_restore_effects SET state='confirmed' WHERE actor_id=? AND owner_id=? AND effect_id=?")
            .run(context.actorId, context.nativeOwnerId, String(effect.effect_id));
        }
        saveReceipt(context, args.opId, pin, confirmed);
        return confirmed;
      });
    },
    async control(token: object, action: "resume" | "cancel", input: unknown) {
      const context = owner(token);
      if (action !== "resume" && action !== "cancel") return fail("INVALID_INPUT", "Unsupported native control.");
      const args = legacySnapshotRestoreDefinitions[1].input.parse(input), pin = fingerprint([action, args]);
      const { binding, record } = read(context, args.restoreId);
      await authorize(token, binding, action);
      const prior = receipt(context, args.opId, pin);
      if (prior) return read(context, prior.restoreId).record;
      const state = staged(context, args.restoreId);
      await validateStagedPolicy(token, binding, action, state);
      if (!host.control) fail("NATIVE_MAPPING_UNAVAILABLE", "Native execution mapping is unavailable by default.");
      if (record.revision !== args.expectedRevision) fail("REVISION_CONFLICT", "Restore revision changed.");
      if (action === "resume" && record.state !== "paused") fail("UNKNOWN_EFFECT", "Interrupted native effects cannot be resumed or replayed.");
      if (action === "cancel" && record.state === "cancel-unknown") fail("UNKNOWN_EFFECT", "Cancellation is already uncertain; confirm its native outcome without dispatching again.");
      if (record.state === "cancelled") fail("TERMINAL", "Restore is cancelled.");
      const effectId = fingerprint([binding, action, args.opId]);
      const pending = { ...record, revision: record.revision + 1, state: action === "resume" ? "resume-unknown" as const : "cancel-unknown" as const };
      atomic(token, binding, () => {
        if (read(context, args.restoreId).record.revision !== args.expectedRevision) fail("REVISION_CONFLICT", "Restore changed before dispatch.");
        if (receipt(context, args.opId, pin)) fail("OP_CONFLICT", "Control already reserved.");
        db.prepare("UPDATE legacy_snapshot_restore_records SET record=? WHERE actor_id=? AND owner_id=? AND restore_id=?")
          .run(JSON.stringify(pending), context.actorId, context.nativeOwnerId, args.restoreId);
        db.prepare("INSERT INTO legacy_snapshot_restore_effects VALUES(?,?,?,?,?,?)")
          .run(context.actorId, context.nativeOwnerId, effectId, args.restoreId, action, "unknown");
        saveReceipt(context, args.opId, pin, pending);
      });
      try {
        await authorize(token, binding, action);
        if (action === "resume") await host.control.resume(binding, state, effectId);
        else await host.control.cancel(binding, effectId);
        await authorize(token, binding, action);
        const observation = await host.control.inspect(binding, effectId);
        await authorize(token, binding, action);
        if (observation.sessionId !== binding.targetSessionId || observation.chatId !== binding.targetChatId
          || observation.state !== (action === "resume" ? "native-controlled" : "cancelled")) return pending;
        return atomic(token, binding, () => {
          const current = read(context, args.restoreId).record;
          if (current.revision !== pending.revision) return current;
          const confirmed = { ...pending, state: observation.state, revision: pending.revision + 1 };
          db.prepare("UPDATE legacy_snapshot_restore_records SET record=? WHERE actor_id=? AND owner_id=? AND restore_id=?")
            .run(JSON.stringify(confirmed), context.actorId, context.nativeOwnerId, args.restoreId);
          if (action === "cancel") {
            db.prepare("UPDATE legacy_snapshot_restore_effects SET state='confirmed' WHERE actor_id=? AND owner_id=? AND restore_id=? AND state='unknown'")
              .run(context.actorId, context.nativeOwnerId, args.restoreId);
          } else {
            db.prepare("UPDATE legacy_snapshot_restore_effects SET state='confirmed' WHERE actor_id=? AND owner_id=? AND effect_id=?")
              .run(context.actorId, context.nativeOwnerId, effectId);
          }
          return confirmed;
        });
      } catch { return read(context, args.restoreId).record; }
    },
  };
}
