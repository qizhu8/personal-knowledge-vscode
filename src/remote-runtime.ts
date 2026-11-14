import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { initializeSyncPlanStore, SyncPlanStore } from "./sync-plan-store.js";
import { syncPlanInputSchema, syncPlanDecisionSchema, syncPlanSessionSchema, type SyncPlanInput } from "./sync-plan-contracts.js";
import { planSync, syncPlanHash } from "./sync-plan.js";
import { applySyncPlan, initializeSyncApplyJournal, inspectSyncApplyRecovery } from "./sync-apply.js";
import { syncApplyReceiptSchema, type SyncApplyReceipt } from "./sync-apply-contracts.js";
import { GitHubSyncTransport, SyncTransportError, type SyncTransportNativeHost } from "./sync-transport.js";
import { initializeSyncTransportStore, SyncTransportStore } from "./sync-transport-store.js";
import { syncTransportPinSchema, syncTransportPublicationSchema, syncTransportShaSchema, syncTransportStatusSchema, type SyncTransportPin } from "./sync-transport-contracts.js";
import { prepareSyncTransportPublication, syncTransportApplyStaging } from "./sync-transport-plan.js";
import { initializeRemoteSubscriptionSchema, inspectRemoteSubscriptionRecovery, remoteSubscriptionReceiptSchema } from "./remote-runtime-subscription.js";

/** Called inside the host's schema migration transaction, on its shared connection. */
export function initializeRemoteRuntimeSchema(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error("Remote schema requires the parent migration transaction");
  initializeSyncPlanStore(db);
  initializeSyncApplyJournal(db);
  initializeSyncTransportStore(db);
  initializeRemoteSubscriptionSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_runtime_schema (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS remote_runtime_pins (
      pin_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, pin_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS remote_runtime_sessions (
      session_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, pin_id TEXT NOT NULL, input_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS remote_runtime_intents (
      operation_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, kind TEXT NOT NULL,
      fingerprint TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT NOT NULL, result_json TEXT
    ) STRICT;
  `);
  db.prepare("INSERT OR IGNORE INTO remote_runtime_schema VALUES(1,1)").run();
  const version = db.prepare("SELECT version FROM remote_runtime_schema WHERE singleton=1").get();
  if (version?.version !== 1) throw new Error("Unsupported remote runtime schema version");
}

/** Include this in every global mutation fence, even when remote transport is disabled. */
export function remoteRuntimePending(db: DatabaseSync): boolean {
  const hasDataIntents = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'data_runtime_intents'").get();
  // Local Core sync recovery owns its shared intent; it must not require a GitHub transport.
  const pendingSync = hasDataIntents
    ? db.prepare(`SELECT 1 FROM sync_apply_journal j WHERE j.state != 'completed'
      AND NOT EXISTS (SELECT 1 FROM data_runtime_intents i WHERE i.operation = 'sync.apply'
        AND i.actor_id = j.actor_id AND i.root_path = j.root_path
        AND json_valid(i.plan_json) AND json_extract(i.plan_json, '$.planHash') = j.plan_hash
        AND json_extract(i.plan_json, '$.sessionId') = j.session_id) LIMIT 1`).get()
    : db.prepare("SELECT 1 FROM sync_apply_journal WHERE state != 'completed' LIMIT 1").get();
  return !!db.prepare(`SELECT 1 FROM remote_runtime_intents WHERE state NOT IN ('complete', 'stale')
    OR kind NOT IN ('remote.sync.apply','remote.sync.publish','remote.subscription','remote.subscription.bundle') LIMIT 1`).get()
    || !!pendingSync
    || !!db.prepare(`SELECT 1 FROM sync_transport_intents t LEFT JOIN remote_runtime_intents i ON i.operation_id=t.operation_id
      WHERE i.operation_id IS NULL OR i.kind != 'remote.sync.publish' LIMIT 1`).get()
    || !!db.prepare(`SELECT 1 FROM remote_subscription_transfers t LEFT JOIN remote_runtime_intents i ON i.operation_id=t.operation_id
      WHERE i.operation_id IS NULL OR i.kind != 'remote.subscription' LIMIT 1`).get()
    || !!db.prepare(`SELECT 1 FROM remote_subscription_apply a LEFT JOIN remote_subscription_transfers t ON t.operation_id=a.operation_id
      LEFT JOIN remote_runtime_intents i ON i.operation_id=a.operation_id
      WHERE t.operation_id IS NULL AND (i.operation_id IS NULL OR i.kind!='remote.subscription.bundle') LIMIT 1`).get();
}

export interface RemoteRuntimeOptions {
  database: DatabaseSync;
  workspaceId: string;
  root: string;
  transaction<T>(work: () => T): T;
  read<T>(work: (db: DatabaseSync) => T): T;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  assertLease(): void;
  assertOperationAvailable(operationId: string): void;
  claimReceipt(operationId: string, fingerprint: string, actorId: string, operation: string, result: unknown): void;
  /** Called in the same commit as the sync apply receipt, with the parent transaction active. */
  reconcileIndex(): void;
  /** Native identity/authorization, not a caller-provided approval. */
  authorize(actorId: string, action: "read" | "plan" | "apply" | "publish"): Promise<boolean>;
  sync?: SyncTransportNativeHost;
  /** Native attestation: repository/ref controls actually exclude every foreign writer.
   * A process/workspace lease does not qualify. GitHub REST itself offers no expected-SHA CAS. */
  publisherPolicy?: { policyId: string; enforcement: "all-repository-ref-writers" | "atomic-git-lease" };
}

type IntentRow = { actor_id: string; kind: string; fingerprint: string; state: string; payload_json: string; result_json: string | null };
const id = z.string().uuid();
const actor = z.string().trim().min(1).max(200);

export const remoteRuntimeDefinitions = [
  { id: "remote.runtime.pin", readOnly: true, nativeOnly: true, description: "Read a configured native GitHub source and persist an actor-bound verified immutable pin.",
    input: z.strictObject({}), output: z.strictObject({ pinId: id, pin: syncTransportPinSchema }) },
  { id: "remote.runtime.readHistoricalBase", readOnly: true, nativeOnly: true, description: "Read a verified historical commit as a possible reconciliation base, without admitting it as the current remote pin.",
    input: z.strictObject({ commit: syncTransportShaSchema }), output: syncTransportPinSchema },
  { id: "remote.runtime.plan", readOnly: false, nativeOnly: true, description: "Persist a local three-way plan using an actor-bound verified remote pin.",
    input: z.strictObject({ operationId: id, sessionId: id, pinId: id, base: syncPlanInputSchema.shape.base, local: syncPlanInputSchema.shape.local }), output: syncPlanSessionSchema },
  { id: "remote.runtime.decide", readOnly: false, nativeOnly: true, description: "Persist an actor-bound decision on a pinned Sync plan.",
    input: syncPlanDecisionSchema.omit({ actorId: true }), output: syncPlanSessionSchema },
  { id: "remote.runtime.apply", readOnly: false, nativeOnly: true, description: "Apply the stored pinned Sync plan with a durable native intent.",
    input: z.strictObject({ operationId: id, sessionId: id }), output: syncApplyReceiptSchema },
  { id: "remote.runtime.publish", readOnly: false, nativeOnly: true, description: "Publish only with explicit native approval and a writer-excluding expected-commit boundary.",
    input: z.strictObject({ operationId: id, sessionId: id, stagedReceiptId: id }), output: syncTransportStatusSchema },
  { id: "remote.runtime.status", readOnly: true, nativeOnly: true, description: "Read the actor-owned durable remote operation status.",
    input: z.strictObject({ operationId: id }), output: z.strictObject({
      kind: z.enum(["remote.sync.apply", "remote.sync.publish", "remote.subscription"]),
      state: z.enum(["pending", "complete", "stale"]),
      result: z.union([syncApplyReceiptSchema, syncTransportStatusSchema, remoteSubscriptionReceiptSchema]).nullable(),
    }).nullable() },
  { id: "remote.runtime.reconcile", readOnly: false, nativeOnly: true, description: "Reconcile a remote outcome using reads only; never repeats a POST or PATCH.",
    input: z.strictObject({ operationId: id, candidateCommit: z.string().regex(/^[a-f0-9]{40}$/).optional() }), output: syncTransportStatusSchema },
] as const;

export function createRemoteRuntime(options: RemoteRuntimeOptions) {
  const { database: db } = options;
  const plans = new SyncPlanStore(db);
  const active = new Set<AbortController>();
  const draining = new Set<Promise<void>>();
  let closed = false;
  const check = () => { if (closed) throw new Error("Remote runtime closed"); options.assertLease(); };
  const authorize = async (actorId: string, action: "read" | "plan" | "apply" | "publish") => {
    actor.parse(actorId); check();
    if (await options.authorize(actorId, action) !== true) throw new Error("Native remote authority denied");
    check();
  };
  const row = (operationId: string): IntentRow | undefined =>
    db.prepare("SELECT actor_id,kind,fingerprint,state,payload_json,result_json FROM remote_runtime_intents WHERE operation_id=?").get(operationId) as IntentRow | undefined;
  const reserve = (operationId: string, actorId: string, kind: string, fingerprint: string, payload: unknown) => {
    const prior = row(operationId);
    if (prior) {
      if (prior.actor_id !== actorId || prior.kind !== kind || prior.fingerprint !== fingerprint) throw new Error("Remote operation identity conflict");
      return prior;
    }
    options.assertOperationAvailable(operationId);
    if (remoteRuntimePending(db)) throw new Error("Remote recovery required before another operation");
    options.claimReceipt(operationId, fingerprint, actorId, kind, { kind, operationId, fingerprint });
    db.prepare("INSERT INTO remote_runtime_intents VALUES(?,?,?,?,?,?,NULL)")
      .run(operationId, actorId, kind, fingerprint, "pending", JSON.stringify(payload));
    return row(operationId)!;
  };
  const loadSession = (actorId: string, sessionId: string) => {
    const session = db.prepare("SELECT pin_id,input_json FROM remote_runtime_sessions WHERE session_id=? AND actor_id=?").get(sessionId, actorId);
    if (!session) throw new Error("Remote session unavailable");
    return { pinId: String(session.pin_id), input: syncPlanInputSchema.parse(JSON.parse(String(session.input_json))) };
  };
  const loadPin = (actorId: string, pinId: string): SyncTransportPin => {
    const pin = db.prepare("SELECT pin_json FROM remote_runtime_pins WHERE pin_id=? AND actor_id=?").get(pinId, actorId);
    if (!pin) throw new Error("Remote pin unavailable");
    const parsed = syncTransportPinSchema.parse(JSON.parse(String(pin.pin_json)));
    if (!options.sync || parsed.policyId !== options.sync.policy.policyId) throw new Error("Remote pin policy changed");
    return parsed;
  };
  const store = new SyncTransportStore(db, journal => {
    check();
    const current = row(journal.publication.operationId);
    if (!current || current.kind !== "remote.sync.publish" || current.actor_id !== journal.publication.actorId
      || JSON.stringify(syncTransportPublicationSchema.parse(JSON.parse(current.payload_json))) !== JSON.stringify(journal.publication)) {
      throw new Error("Publication not bound to a native durable intent");
    }
    const state = journal.status.state === "published" ? "complete" : journal.status.state === "stale" ? "stale" : "pending";
    db.prepare("UPDATE remote_runtime_intents SET state=?,result_json=? WHERE operation_id=?")
      .run(state, JSON.stringify(journal.status), journal.publication.operationId);
    check();
  });
  const gitLease = options.sync?.nativeGit?.bind(store, (publication, tree) => {
    check();
    const current = row(publication.operationId);
    if (!current || current.kind !== "remote.sync.publish" || current.actor_id !== publication.actorId
      || JSON.stringify(syncTransportPublicationSchema.parse(JSON.parse(current.payload_json))) !== JSON.stringify(publication))
      throw new Error("Git publication lacks a native intent.");
    const session = loadSession(publication.actorId, publication.sessionId);
    const pin = loadPin(publication.actorId, session.pinId);
    const recomputed = prepareSyncTransportPublication(db, plans, {
      sessionId: publication.sessionId, actorId: publication.actorId, input: session.input,
      operationId: publication.operationId, stagedReceiptId: publication.stagedReceiptId,
    }, pin, syncTransportApplyStaging(db, plans, {
      sessionId: publication.sessionId, actorId: publication.actorId, input: session.input,
    }), new Date(publication.message.slice("PKM sync ".length)));
    if (JSON.stringify(recomputed) !== JSON.stringify(publication)
      || store.read(publication.operationId, publication.actorId)?.status.tree !== tree)
      throw new Error("Git publication differs from its native staged receipt.");
    check();
  }, options.sync?.assertPublicationAuthority);
  const transport = options.sync ? new GitHubSyncTransport(options.sync, store, {}, gitLease) : undefined;
  const network = async <T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    check();
    const controller = new AbortController();
    active.add(controller);
    let done!: () => void;
    const finished = new Promise<void>(resolve => { done = resolve; });
    draining.add(finished);
    try { return await work(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal); }
    finally { active.delete(controller); draining.delete(finished); done(); }
  };

  return {
    async pin(actorId: string, signal?: AbortSignal) {
      await authorize(actorId, "read");
      if (!transport) throw new SyncTransportError("DENIED");
      const pin = await network(signal, s => transport.readPin(undefined, s));
      await authorize(actorId, "read");
      const pinId = randomUUID();
      options.transaction(() => {
        check();
        db.prepare("INSERT INTO remote_runtime_pins VALUES(?,?,?)").run(pinId, actorId, JSON.stringify(pin));
      });
      return { pinId, pin };
    },
    /** The caller must independently bind this commit to the legacy target and selection. */
    async readHistoricalBase(actorId: string, commit: string, signal?: AbortSignal) {
      await authorize(actorId, "read");
      syncTransportShaSchema.parse(commit);
      if (!transport) throw new SyncTransportError("DENIED");
      const pin = await network(signal, s => transport.readPin(commit, s));
      await authorize(actorId, "read");
      return pin;
    },
    async plan(actorId: string, request: { operationId: string; sessionId: string; pinId: string; base: SyncPlanInput["base"]; local: SyncPlanInput["local"] }) {
      await authorize(actorId, "plan");
      id.parse(request.operationId); id.parse(request.sessionId); id.parse(request.pinId);
      return options.exclusive(async () => options.transaction(() => {
        check(); options.assertOperationAvailable(request.operationId);
        if (remoteRuntimePending(db)) throw new Error("Remote recovery required");
        const pin = loadPin(actorId, request.pinId);
        const input = syncPlanInputSchema.parse({ base: request.base, local: request.local, remote: { manifest: pin.manifest, sha256: pin.manifestHash } });
        const fingerprint = syncPlanHash({ workspaceId: options.workspaceId, actorId, kind: "remote.sync.plan",
          operationId: request.operationId, sessionId: request.sessionId, pinId: request.pinId, input });
        const result = plans.create({ operationId: request.operationId, sessionId: request.sessionId, actorId, input });
        const prior = db.prepare("SELECT actor_id,pin_id,input_json FROM remote_runtime_sessions WHERE session_id=?").get(request.sessionId);
        if (prior && (prior.actor_id !== actorId || prior.pin_id !== request.pinId || prior.input_json !== JSON.stringify(input))) throw new Error("Session identity conflict");
        if (!prior) {
          db.prepare("INSERT INTO sync_plan_owners VALUES(?,?)").run(request.sessionId, actorId);
          db.prepare("INSERT INTO remote_runtime_sessions VALUES(?,?,?,?)").run(request.sessionId, actorId, request.pinId, JSON.stringify(input));
        }
        options.claimReceipt(request.operationId, fingerprint, actorId, "remote.sync.plan", result);
        return result;
      }));
    },
    async decide(actorId: string, request: Omit<z.infer<typeof syncPlanDecisionSchema>, "actorId">) {
      await authorize(actorId, "plan");
      const decision = syncPlanDecisionSchema.parse({ ...request, actorId });
      return options.exclusive(async () => options.transaction(() => {
        check(); options.assertOperationAvailable(decision.operationId);
        if (remoteRuntimePending(db)) throw new Error("Remote recovery required");
        loadSession(actorId, decision.sessionId);
        const result = plans.decide(decision);
        options.claimReceipt(decision.operationId, syncPlanHash({ workspaceId: options.workspaceId, decision }), actorId, "remote.sync.decide", result);
        return result;
      }));
    },
    async inspectSession(actorId: string, sessionId: string) {
      await authorize(actorId, "read");
      id.parse(sessionId);
      return options.read(() => {
        const stored = loadSession(actorId, sessionId), pin = loadPin(actorId, stored.pinId);
        const session = syncPlanSessionSchema.parse(plans.get(sessionId));
        if (JSON.stringify(session.plan) !== JSON.stringify(planSync(stored.input))
          || session.decisions.some(decision => decision.actorId !== actorId))
          throw new Error("Remote session evidence changed");
        return { session, input: stored.input, pin };
      });
    },
    async apply(actorId: string, request: { operationId: string; sessionId: string }) {
      await authorize(actorId, "apply");
      id.parse(request.operationId); id.parse(request.sessionId);
      return options.exclusive(async () => {
        const input = options.read(() => loadSession(actorId, request.sessionId).input);
        const fingerprint = syncPlanHash({ workspaceId: options.workspaceId, actorId, kind: "remote.sync.apply",
          operationId: request.operationId, sessionId: request.sessionId, input });
        const prior = options.transaction(() => reserve(request.operationId, actorId, "remote.sync.apply", fingerprint, { sessionId: request.sessionId }));
        if (prior.state === "complete") return JSON.parse(prior.result_json!) as SyncApplyReceipt;
        check();
        return applySyncPlan(plans, { sessionId: request.sessionId, actorId, input }, options.root, {
          beforeCommit(receipt) {
            check(); options.reconcileIndex();
            db.prepare("UPDATE remote_runtime_intents SET state='complete',result_json=? WHERE operation_id=? AND fingerprint=?")
              .run(JSON.stringify(receipt), request.operationId, fingerprint);
            check();
          },
        });
      });
    },
    async publish(actorId: string, request: { operationId: string; sessionId: string; stagedReceiptId: string }, signal?: AbortSignal) {
      await authorize(actorId, "publish");
      id.parse(request.operationId); id.parse(request.sessionId); id.parse(request.stagedReceiptId);
      const authority = options.publisherPolicy?.enforcement;
      if (!transport || !options.sync
        || !(authority === "all-repository-ref-writers" && !options.sync.nativeGit && typeof options.sync.withExpectedCommitCAS === "function"
          || authority === "atomic-git-lease" && !!options.sync.nativeGit && !!gitLease)
        || options.publisherPolicy?.policyId !== options.sync.policy.policyId) throw new SyncTransportError("DENIED");
      return options.exclusive(async () => {
        const session = options.read(() => loadSession(actorId, request.sessionId));
        const fingerprint = syncPlanHash({ workspaceId: options.workspaceId, actorId, kind: "remote.sync.publish",
          operationId: request.operationId, sessionId: request.sessionId, stagedReceiptId: request.stagedReceiptId });
        const journal = options.transaction(() => {
          const existing = row(request.operationId);
          if (existing) {
            if (existing.actor_id !== actorId || existing.kind !== "remote.sync.publish" || existing.fingerprint !== fingerprint) throw new Error("Remote operation identity conflict");
            return existing;
          }
          const pin = loadPin(actorId, session.pinId);
          const plan = prepareSyncTransportPublication(db, plans, { ...request, actorId, input: session.input }, pin,
            syncTransportApplyStaging(db, plans, { sessionId: request.sessionId, actorId, input: session.input }));
          return reserve(request.operationId, actorId, "remote.sync.publish", fingerprint, plan);
        });
        const publication = syncTransportPublicationSchema.parse(JSON.parse(journal.payload_json));
        return network(signal, s => transport.publish(publication, s));
      });
    },
    async status(actorId: string, operationId: string) {
      await authorize(actorId, "read"); id.parse(operationId);
      return options.read(() => { const current = row(operationId); return current?.actor_id === actorId ? { kind: current.kind, state: current.state, result: current.result_json ? JSON.parse(current.result_json) as unknown : null } : null; });
    },
    async reconcile(actorId: string, operationId: string, candidateCommit?: string, signal?: AbortSignal) {
      await authorize(actorId, "publish"); id.parse(operationId);
      if (!transport) throw new SyncTransportError("DENIED");
      return options.exclusive(() => network(signal, s => transport.reconcile(operationId, actorId, candidateCommit, s)));
    },
    inspect() {
      check();
      options.read(() => {
        inspectSyncApplyRecovery(plans, options.root);
        inspectRemoteSubscriptionRecovery(db, options.workspaceId);
        const intents = db.prepare("SELECT operation_id,actor_id,kind,fingerprint,state,payload_json,result_json FROM remote_runtime_intents WHERE kind IN ('remote.sync.apply','remote.sync.publish')").all();
        for (const value of intents) {
          const operationId = String(value.operation_id), actorId = String(value.actor_id);
          if (value.kind === "remote.sync.apply") {
            const payload = z.strictObject({ sessionId: id }).parse(JSON.parse(String(value.payload_json)));
            const input = loadSession(actorId, payload.sessionId).input;
            const fingerprint = syncPlanHash({ workspaceId: options.workspaceId, actorId, kind: "remote.sync.apply", operationId, sessionId: payload.sessionId, input });
            if (value.fingerprint !== fingerprint || !["pending", "complete"].includes(String(value.state))
              || value.state === "complete" && !syncApplyReceiptSchema.safeParse(JSON.parse(String(value.result_json))).success) throw new Error("Sync apply intent requires manual review");
          } else {
            const publication = syncTransportPublicationSchema.parse(JSON.parse(String(value.payload_json)));
            const { planHash, ...unsigned } = publication;
            const fingerprint = syncPlanHash({ workspaceId: options.workspaceId, actorId, kind: "remote.sync.publish", operationId,
              sessionId: publication.sessionId, stagedReceiptId: publication.stagedReceiptId });
            if (publication.operationId !== operationId || publication.actorId !== actorId || planHash !== syncPlanHash(unsigned)
              || publication.manifestHash !== syncPlanHash(publication.manifest) || value.fingerprint !== fingerprint) throw new Error("Sync publication intent requires manual review");
            const journal = store.read(operationId, actorId);
            if (journal && (JSON.stringify(journal.publication) !== JSON.stringify(publication)
              || journal.status.operationId !== operationId || journal.status.planHash !== planHash
              || journal.status.policyId !== publication.policyId || journal.status.expectedCommit !== publication.expectedCommit
              || value.result_json !== JSON.stringify(journal.status)
              || (value.state === "complete") !== (journal.status.state === "published")
              || (value.state === "stale") !== (journal.status.state === "stale"))) throw new Error("Sync publication journal requires manual review");
            if (!journal && (value.state !== "pending" || value.result_json !== null)) throw new Error("Sync publication journal missing");
          }
        }
        if (db.prepare(`SELECT 1 FROM sync_transport_intents t LEFT JOIN remote_runtime_intents i ON i.operation_id=t.operation_id
          WHERE i.operation_id IS NULL OR i.kind != 'remote.sync.publish' LIMIT 1`).get()) throw new Error("Orphaned sync publication requires manual review");
      });
      return options.read(() => remoteRuntimePending(db));
    },
    async close() {
      closed = true;
      for (const controller of active) controller.abort();
      await Promise.all([...draining]);
    },
  };
}
