import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { syncPlanHash } from "./sync-plan.js";
import { SubscriptionApplyHost, deserializeSubscriptionApplyPlan, type SubscriptionApplyAuthority, type SubscriptionApplyJournal, type SubscriptionApplyNativePolicy, type SubscriptionApplyReceipt } from "./subscription-apply.js";
import { SubscriptionTransportHost, type SubscriptionTransportEndpoint, type SubscriptionTransportFetch, type SubscriptionTransportRequest, type SubscriptionTransportSecrets, type SubscriptionTransferState, type SubscriptionTransferStore } from "./subscription-transport.js";
import type { SubscriptionMaterializeInput } from "./subscription-materialize-contracts.js";
import { subscriptionMaterializeResultSchema, subscriptionMaterializeSource } from "./subscription-materialize-contracts.js";
import { documentPath, knowledgeArea } from "./document-path.js";

const requestSchema = z.strictObject({
  operationId: z.string().uuid(), source: subscriptionMaterializeSource, area: knowledgeArea,
  paths: z.array(documentPath).min(1).max(512), mode: z.enum(["fork", "readonly-mirror"]), expiresAt: z.string().datetime(),
});
const applyReceiptSchema = z.strictObject({
  kind: z.literal("subscription-apply/v1"), planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  result: subscriptionMaterializeResultSchema,
  identities: z.array(z.strictObject({ area: knowledgeArea, path: z.string(), documentId: z.string(), knowledgeId: z.string().nullable(), aliases: z.array(z.string()), sourceAlias: z.string() })),
});
export const remoteSubscriptionReceiptSchema = z.strictObject({
  kind: z.literal("subscription-transport/v1"), operationId: z.string().uuid(),
  mode: z.enum(["fork", "readonly-mirror"]), source: subscriptionMaterializeSource,
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(),
  readOnly: z.boolean(), apply: applyReceiptSchema.nullable(),
});
export const remoteSubscriptionDefinitions = [
  { id: "remote.runtime.subscription.run", readOnly: false, nativeOnly: true, description: "Fetch and verify a pinned source, then fork or retain an immutable readonly mirror using native ACL authority.",
    input: requestSchema, output: remoteSubscriptionReceiptSchema },
  { id: "remote.runtime.subscription.mirror", readOnly: true, nativeOnly: true, description: "Read a currently authorized verified readonly mirror.",
    input: requestSchema, output: z.string() },
] as const;

export function initializeRemoteSubscriptionSchema(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error("Remote schema requires the parent migration transaction");
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_subscription_transfers (
      operation_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS remote_subscription_apply (
      operation_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, intent TEXT NOT NULL, receipt_json TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS remote_subscription_identities (
      namespace TEXT NOT NULL, value TEXT NOT NULL, operation_id TEXT NOT NULL,
      PRIMARY KEY(namespace,value)
    ) STRICT;
  `);
}

/** Inspect persisted state only: never fetch, authorize, apply, or infer success at startup. */
export function inspectRemoteSubscriptionRecovery(db: DatabaseSync, workspaceId: string): void {
  const stateSchema = z.strictObject({
    revision: z.number().int().safe().nonnegative(), intent: z.string(),
    phase: z.enum(["intent", "downloading", "verified", "applying", "complete", "cancelled", "expired"]),
    receipt: remoteSubscriptionReceiptSchema.nullable(), runnerId: z.string().uuid().nullable(),
    leaseUntil: z.number().int().safe().nonnegative(), verifiedBytes: z.number().int().safe().nonnegative().nullable(),
  });
  const intentSchema = z.strictObject({
    kind: z.literal("subscription-transport/v1"), bindingId: z.string().min(1), request: requestSchema,
    nativeRevision: z.string().min(1),
  });
  const rows = db.prepare(`SELECT t.operation_id,t.actor_id,t.revision,t.state_json,
    i.kind,i.actor_id AS owner,i.fingerprint,i.state AS operation_state,i.payload_json,i.result_json
    FROM remote_subscription_transfers t LEFT JOIN remote_runtime_intents i ON i.operation_id=t.operation_id`).all();
  for (const row of rows) {
    const operationId = String(row.operation_id), actorId = String(row.actor_id);
    const state = stateSchema.parse(JSON.parse(String(row.state_json)));
    const intent = intentSchema.parse(JSON.parse(state.intent));
    if (JSON.stringify(intent) !== state.intent || state.revision !== row.revision || intent.request.operationId !== operationId
      || row.kind !== "remote.subscription" || row.owner !== actorId || row.payload_json !== state.intent
      || row.fingerprint !== syncPlanHash({ workspaceId, actorId, intent: state.intent })
      || (state.phase === "complete") !== (row.operation_state === "complete")
      || (state.phase === "complete" && (!state.receipt || row.result_json !== JSON.stringify(state.receipt)))
      || (state.phase !== "complete" && state.receipt !== null)) throw new Error("Subscription transfer requires manual review");
    const applied = db.prepare("SELECT actor_id,intent,receipt_json FROM remote_subscription_apply WHERE operation_id=?").get(operationId);
    if (applied) {
      const plan = deserializeSubscriptionApplyPlan(String(applied.intent));
      if (applied.actor_id !== actorId || plan.material.operationId !== operationId || plan.material.actorId !== actorId
        || JSON.stringify(plan.material.source) !== JSON.stringify(intent.request.source)
        || intent.request.mode !== "fork") throw new Error("Subscription apply requires manual review");
      if (applied.receipt_json !== null) {
        const receipt = applyReceiptSchema.parse(JSON.parse(String(applied.receipt_json)));
        if (receipt.planSha256 !== plan.planSha256 || state.phase === "complete"
          && JSON.stringify(receipt) !== JSON.stringify(state.receipt?.apply)) throw new Error("Subscription apply receipt requires manual review");
      } else if (state.phase === "complete") throw new Error("Subscription apply receipt missing");
    } else if (state.phase === "complete" && intent.request.mode === "fork") throw new Error("Subscription apply journal missing");
    if (state.phase === "complete" && (state.receipt!.operationId !== operationId || state.receipt!.mode !== intent.request.mode
      || JSON.stringify(state.receipt!.source) !== JSON.stringify(intent.request.source)
      || state.receipt!.readOnly !== (intent.request.mode === "readonly-mirror")
      || intent.request.mode === "readonly-mirror" && state.receipt!.apply !== null)) throw new Error("Subscription receipt requires manual review");
  }
  if (db.prepare(`SELECT 1 FROM remote_runtime_intents i LEFT JOIN remote_subscription_transfers t ON t.operation_id=i.operation_id
    WHERE i.kind='remote.subscription' AND t.operation_id IS NULL LIMIT 1`).get()
    || db.prepare(`SELECT 1 FROM remote_subscription_apply a LEFT JOIN remote_subscription_transfers t ON t.operation_id=a.operation_id
    LEFT JOIN remote_runtime_intents i ON i.operation_id=a.operation_id
    WHERE t.operation_id IS NULL AND (i.operation_id IS NULL OR i.kind!='remote.subscription.bundle') LIMIT 1`).get()) throw new Error("Orphaned subscription journal requires manual review");
}

export interface RemoteSubscriptionOptions {
  database: DatabaseSync;
  root: string;
  workspaceId: string;
  transaction<T>(work: () => T): T;
  read<T>(work: (db: DatabaseSync) => T): T;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  assertLease(): void;
  assertOperationAvailable(operationId: string): void;
  claimReceipt(operationId: string, fingerprint: string, actorId: string, operation: string, result: unknown): void;
  reconcileIndex(): void;
  endpoint: SubscriptionTransportEndpoint;
  stagingRoot: string;
  secrets: SubscriptionTransportSecrets;
  fetch?: SubscriptionTransportFetch;
  authorityForActor(actorId: string, source: Readonly<SubscriptionMaterializeInput["source"]>): Promise<SubscriptionApplyAuthority>;
  nativePolicy: SubscriptionApplyNativePolicy;
  authorize(actorId: string, source: Readonly<SubscriptionMaterializeInput["source"]>, mode: SubscriptionTransportRequest["mode"]): Promise<string>;
}

/** Transport and its apply journal share the host workspace lease and the global operation ID. */
export function createRemoteSubscriptionRuntime(options: RemoteSubscriptionOptions) {
  const { database: db } = options;
  let closed = false;
  const controllers = new Set<AbortController>();
  const draining = new Set<Promise<void>>();
  const check = () => { if (closed) throw new Error("Remote subscription runtime closed"); options.assertLease(); };
  const owner = (operationId: string, actorId: string) => {
    const row = db.prepare("SELECT actor_id,kind FROM remote_runtime_intents WHERE operation_id=?").get(operationId);
    if (!row || row.actor_id !== actorId || row.kind !== "remote.subscription") throw new Error("Subscription operation authority mismatch");
  };
  const transferStore = (actorId: string): SubscriptionTransferStore => ({
    async runExclusive(operationId, work) {
      check();
      const current = options.read(() => {
        const row = db.prepare("SELECT actor_id,revision,state_json FROM remote_subscription_transfers WHERE operation_id=?").get(operationId);
        if (row && row.actor_id !== actorId) throw new Error("Subscription operation authority mismatch");
        return row ? { revision: Number(row.revision), state: JSON.parse(String(row.state_json)) as SubscriptionTransferState } : undefined;
      });
      let next: SubscriptionTransferState | undefined;
      const result = await work({
        async load() { return current?.state; },
        async create(state) { if (current || next) throw new Error("Subscription operation already exists"); next = state; },
        async compareAndSwap(revision, state) {
          if (!current || next || current.revision !== revision || state.revision !== revision + 1) return false;
          next = state; return true;
        },
      });
      if (next) options.transaction(() => {
        check();
        if (!current) {
          options.assertOperationAvailable(operationId);
          if (db.prepare("SELECT 1 FROM remote_runtime_intents WHERE state NOT IN ('complete','stale') LIMIT 1").get()
            || db.prepare("SELECT 1 FROM sync_apply_journal WHERE state != 'completed' LIMIT 1").get()) throw new Error("Remote recovery required");
          const fingerprint = syncPlanHash({ workspaceId: options.workspaceId, actorId, intent: next!.intent });
          options.claimReceipt(operationId, fingerprint, actorId, "remote.subscription", { operationId, fingerprint, kind: "remote.subscription" });
          db.prepare("INSERT INTO remote_runtime_intents VALUES(?,?,?,?,?,?,NULL)")
            .run(operationId, actorId, "remote.subscription", fingerprint, "pending", next!.intent);
          db.prepare("INSERT INTO remote_subscription_transfers VALUES(?,?,?,?)")
            .run(operationId, actorId, next!.revision, JSON.stringify(next));
        } else {
          owner(operationId, actorId);
          const changed = db.prepare("UPDATE remote_subscription_transfers SET revision=?,state_json=? WHERE operation_id=? AND actor_id=? AND revision=?")
            .run(next!.revision, JSON.stringify(next), operationId, actorId, current.revision);
          if (changed.changes !== 1) throw new Error("Subscription transfer CAS conflict");
          if (next!.phase === "complete") {
            db.prepare("UPDATE remote_runtime_intents SET state='complete',result_json=? WHERE operation_id=?").run(JSON.stringify(next!.receipt), operationId);
          }
        }
        check();
      });
      return result;
    },
  });
  const applyJournal = (actorId: string, expectedOperation: string): SubscriptionApplyJournal => ({
    async runExclusive(work) {
      check();
      return work({
        async load(operationId) {
          if (operationId !== expectedOperation) throw new Error("Subscription operation mismatch");
          return options.read(() => {
            owner(operationId, actorId);
            const row = db.prepare("SELECT intent,receipt_json FROM remote_subscription_apply WHERE operation_id=? AND actor_id=?").get(operationId, actorId);
            return row ? { intent: String(row.intent), receipt: row.receipt_json === null ? null : JSON.parse(String(row.receipt_json)) as SubscriptionApplyReceipt } : undefined;
          });
        },
        async persistIntent(operationId, intent) {
          if (operationId !== expectedOperation) throw new Error("Subscription operation mismatch");
          const plan = deserializeSubscriptionApplyPlan(intent);
          if (plan.material.actorId !== actorId || plan.material.operationId !== operationId) throw new Error("Subscription apply authority mismatch");
          options.transaction(() => {
            check(); owner(operationId, actorId);
            db.prepare("INSERT INTO remote_subscription_apply VALUES(?,?,?,NULL)").run(operationId, actorId, intent);
          });
        },
        async commit(operationId, receipt) {
          if (operationId !== expectedOperation) throw new Error("Subscription operation mismatch");
          options.transaction(() => {
            check(); owner(operationId, actorId);
            const row = db.prepare("SELECT intent,receipt_json FROM remote_subscription_apply WHERE operation_id=? AND actor_id=?").get(operationId, actorId);
            if (!row) throw new Error("Subscription apply intent missing");
            const plan = deserializeSubscriptionApplyPlan(String(row.intent));
            if (plan.planSha256 !== receipt.planSha256 || plan.material.operationId !== operationId || plan.material.actorId !== actorId) throw new Error("Subscription apply receipt mismatch");
            if (row.receipt_json !== null) {
              if (row.receipt_json !== JSON.stringify(receipt)) throw new Error("Subscription apply receipt conflict");
              return;
            }
            const insert = db.prepare("INSERT INTO remote_subscription_identities VALUES(?,?,?)");
            for (const identity of receipt.identities) {
              for (const value of new Set([identity.documentId, ...(identity.knowledgeId ? [identity.knowledgeId] : [])])) insert.run("identity", value, operationId);
              for (const value of identity.aliases) insert.run("alias", value.normalize("NFC").toLocaleLowerCase("en-US"), operationId);
            }
            options.reconcileIndex();
            db.prepare("UPDATE remote_subscription_apply SET receipt_json=? WHERE operation_id=? AND receipt_json IS NULL").run(JSON.stringify(receipt), operationId);
            check();
          });
        },
      });
    },
  });
  const host = async (actorId: string, request: SubscriptionTransportRequest) => {
    z.string().trim().min(1).max(200).parse(actorId); z.string().uuid().parse(request.operationId); check();
    const authority = await options.authorityForActor(actorId, Object.freeze({ ...request.source }));
    check();
    if (!authority || authority.actorId !== actorId || typeof options.nativePolicy !== "function" || typeof options.authorize !== "function") throw new Error("Explicit native subscription authority required");
    const applyHost = new SubscriptionApplyHost(options.root, applyJournal(actorId, request.operationId), authority, options.nativePolicy);
    return new SubscriptionTransportHost({
      endpoint: options.endpoint, stagingRoot: options.stagingRoot, store: transferStore(actorId), applyHost,
      secrets: options.secrets, fetch: options.fetch,
      authorize: (source, mode) => options.authorize(actorId, source, mode),
    });
  };
  const run = async <T>(actorId: string, request: SubscriptionTransportRequest, signal: AbortSignal | undefined, mirror: boolean): Promise<T> => {
    check();
    let done!: () => void;
    const finished = new Promise<void>(resolve => { done = resolve; });
    draining.add(finished);
    try { return await options.exclusive(async () => {
      check();
      const service = await host(actorId, request);
      const controller = new AbortController(); controllers.add(controller);
      try {
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        return (mirror ? await service.readMirror(request) : await service.run(request, combined)) as T;
      } finally { controllers.delete(controller); }
    }); } finally { draining.delete(finished); done(); }
  };
  return {
    run: (actorId: string, request: SubscriptionTransportRequest, signal?: AbortSignal) => run<Awaited<ReturnType<SubscriptionTransportHost["run"]>>>(actorId, request, signal, false),
    readMirror: (actorId: string, request: SubscriptionTransportRequest) => run<Buffer>(actorId, request, undefined, true),
    async close() { closed = true; for (const controller of controllers) controller.abort(); await Promise.all([...draining]); },
  };
}
