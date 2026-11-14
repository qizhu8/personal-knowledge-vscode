import { existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { syncPlanHash } from "./sync-plan.js";
import { SubscriptionBundleHost, type SubscriptionBundleNativeHost } from "./subscription-bundle.js";
import { SubscriptionBundleApplyHost, deserializeSubscriptionBundleApplyPlan } from "./subscription-bundle-apply.js";
import type { SubscriptionBundleApplyJournal, SubscriptionBundleApplyNativePolicy, SubscriptionBundleApplyReceipt, SubscriptionBundleApplyBoundary } from "./subscription-bundle-apply-contracts.js";
import { nativeBundleRequestSchema, nativeBundleReceiptSchema, remoteBundleReceiptSchema } from "./remote-runtime-subscription-bundle-contracts.js";
import type { SubscriptionTransportEndpoint, SubscriptionTransportSecrets, SubscriptionTransportFetch } from "./subscription-transport.js";
import { subscriptionTransportSocketFetch } from "./subscription-transport.js";
import { transportEndpoint, transportBroker } from "./domain/subscription-transport-socket.js";
import { transportTicketSchema } from "./domain/subscription-transport-protocol.js";
import { SubscriptionTransportStaging } from "./domain/subscription-transport-staging.js";
import { verifyShareSummary } from "./domain/subscription-bundle-original.js";

type Request = z.infer<typeof nativeBundleRequestSchema>;
type Result = z.infer<typeof remoteBundleReceiptSchema>;
const pinSchema = z.strictObject({
  wireSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  wireBytes: z.number().int().positive().max(16_777_216),
});
const intentSchema = z.strictObject({
  kind: z.literal("remote-subscription-bundle/v1"), bindingId: z.string().min(1),
  request: nativeBundleRequestSchema, transfer: pinSchema,
});
const grantSchema = z.strictObject({
  kind: z.literal("native-bundle-verification/v1"), actorId: z.string(),
  source: nativeBundleRequestSchema.shape.source,
  ciphertextSha256: z.string(), plaintextSha256: z.string(),
  authority: z.strictObject({ publisherPublicKey: z.string(), keyEpoch: z.string(), policyRevision: z.string() }),
});

export interface NativeSubscriptionBundleAuthority {
  endpoint: SubscriptionTransportEndpoint;
  stagingRoot: string;
  /** A distinct host-owned directory; neither stage may be inside the workspace. */
  codecStagingRoot: string;
  secrets: SubscriptionTransportSecrets;
  fetch?: SubscriptionTransportFetch;
  nativeHost: SubscriptionBundleNativeHost;
  nativePolicy: SubscriptionBundleApplyNativePolicy;
  /** Trusted independent raw-transfer pin, not the signed snapshot collectionHash. */
  authorizeTransfer(actorId: string, source: Readonly<Request["source"]>, signal: AbortSignal): Promise<z.infer<typeof pinSchema>>;
  boundary?: SubscriptionBundleApplyBoundary;
}
export interface NativeSubscriptionBundleContext {
  database: DatabaseSync; root: string; workspaceId: string;
  transaction<T>(work: () => T): T;
  read<T>(work: (db: DatabaseSync) => T): T;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  assertLease(): void;
  assertOperationAvailable(operationId: string): void;
  claimReceipt(operationId: string, fingerprint: string, actorId: string, operation: string, result: unknown): void;
  /** Compute filesystem-backed index outside SQLite, install it synchronously inside commit. */
  prepareIndex(): () => void;
}

function conflict(): never { throw new CoreError("RECOVERY_CONFLICT", "Native bundle requires authorized reconciliation."); }
const grantId = (operationId: string) => `native-bundle:${operationId}`;
function canonical<T>(schema: z.ZodType<T>, serialized: string): T {
  const value = schema.parse(JSON.parse(serialized));
  if (JSON.stringify(value) !== serialized) conflict();
  return value;
}

/** Validate every persisted bundle before ANY sibling recovery effects or index promotion. */
export function inspectNativeSubscriptionBundles(db: DatabaseSync, workspaceId: string): void {
  if (db.prepare(`SELECT 1 FROM remote_runtime_intents WHERE
    kind NOT IN ('remote.sync.apply','remote.sync.publish','remote.subscription','remote.subscription.bundle')
    OR state NOT IN ('pending','complete','stale')
    OR (kind IN ('remote.subscription','remote.subscription.bundle') AND state='stale') LIMIT 1`).get()
    || db.prepare(`SELECT 1 FROM remote_subscription_apply a LEFT JOIN remote_runtime_intents i ON a.operation_id=i.operation_id
      WHERE i.operation_id IS NULL OR i.kind NOT IN ('remote.subscription','remote.subscription.bundle') LIMIT 1`).get()) conflict();
  const rows = db.prepare("SELECT * FROM remote_runtime_intents WHERE kind='remote.subscription.bundle'").all();
  for (const row of rows) {
    const id = String(row.operation_id), actorId = String(row.actor_id);
    const intent = canonical(intentSchema, String(row.payload_json));
    const globalReceipt = db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(id);
    if (intent.request.operationId !== id || row.fingerprint !== syncPlanHash({ workspaceId, actorId, intent: row.payload_json })
      || !["pending", "complete"].includes(String(row.state))
      || !globalReceipt || globalReceipt.actor_id !== actorId || globalReceipt.fingerprint !== row.fingerprint
      || globalReceipt.operation !== "remote.subscription.bundle"
      || globalReceipt.result !== (row.state === "complete" ? row.result_json : JSON.stringify({ operationId: id, pending: true }))) conflict();
    const applied = db.prepare("SELECT * FROM remote_subscription_apply WHERE operation_id=?").get(id);
    const granted = db.prepare("SELECT actor_id,pin_json FROM remote_runtime_pins WHERE pin_id=?").get(grantId(id));
    if (!!applied !== !!granted) conflict();
    if (applied) {
      const plan = deserializeSubscriptionBundleApplyPlan(String(applied.intent));
      const grant = canonical(grantSchema, String(granted!.pin_json));
      if (applied.actor_id !== actorId || granted!.actor_id !== actorId || plan.actorId !== actorId || plan.operationId !== id
        || JSON.stringify(plan.source) !== JSON.stringify(intent.request.source)
        || JSON.stringify(grant) !== JSON.stringify({
          kind: "native-bundle-verification/v1", actorId, source: plan.source,
          ciphertextSha256: plan.ciphertextSha256, plaintextSha256: plan.plaintextSha256, authority: plan.authority,
        })) conflict();
      if (applied.receipt_json !== null) {
        const receipt = canonical(nativeBundleReceiptSchema, String(applied.receipt_json));
        if (receipt.planSha256 !== plan.planSha256 || receipt.operationId !== id
          || receipt.ciphertextSha256 !== plan.ciphertextSha256 || receipt.plaintextSha256 !== plan.plaintextSha256
          || JSON.stringify(receipt.source) !== JSON.stringify(plan.source)
          || JSON.stringify(receipt.identities) !== JSON.stringify(plan.identities)
          || JSON.stringify(receipt.files) !== JSON.stringify(plan.changes.map(c => ({ path: c.path, sha256: c.afterSha256 })))) conflict();
      } else if (row.state === "complete") conflict();
    } else if (row.state === "complete") conflict();
    if (row.state === "complete") {
      const result = canonical(remoteBundleReceiptSchema, String(row.result_json));
      if (result.operationId !== id || result.wireSha256 !== intent.transfer.wireSha256 || result.wireBytes !== intent.transfer.wireBytes
        || JSON.stringify(result.apply) !== applied!.receipt_json) conflict();
    } else if (row.result_json !== null) conflict();
  }
  if (db.prepare(`SELECT 1 FROM remote_runtime_pins p LEFT JOIN remote_runtime_intents i
    ON p.pin_id='native-bundle:'||i.operation_id WHERE p.pin_id LIKE 'native-bundle:%'
    AND (i.operation_id IS NULL OR i.kind!='remote.subscription.bundle') LIMIT 1`).get()) conflict();
}

/** Shared journal injected into the original native apply host, under the outer workspace lock. */
export function createNativeSubscriptionBundle(context: NativeSubscriptionBundleContext, authority: NativeSubscriptionBundleAuthority) {
  const db = context.database;
  if (!authority.nativeHost || typeof authority.nativeHost.authorize !== "function" || typeof authority.nativeHost.resolveKeys !== "function"
    || typeof authority.nativePolicy?.authorize !== "function" || typeof authority.authorizeTransfer !== "function") {
    throw new CoreError("INVALID_CONFIGURATION", "Explicit native bundle policy and key authority are required.");
  }
  const root = resolve(context.root), stage = resolve(authority.stagingRoot), codecStage = resolve(authority.codecStagingRoot);
  const inside = (parent: string, child: string) => { const path = relative(parent, child); return !path || !path.startsWith("..") && !isAbsolute(path); };
  if (inside(root, stage) || inside(root, codecStage) || inside(stage, codecStage) || inside(codecStage, stage))
    throw new CoreError("INVALID_CONFIGURATION", "Bundle workspace and native staging roots must be disjoint.");
  const endpoint = Object.freeze({ ...authority.endpoint, transferPorts: Object.freeze([...authority.endpoint.transferPorts]) });
  transportEndpoint(endpoint);
  const staging = new SubscriptionTransportStaging(stage);
  const codec = new SubscriptionBundleHost(authority.nativeHost);
  const fetch = authority.fetch ?? subscriptionTransportSocketFetch;
  let closed = false;
  const controllers = new Set<AbortController>();
  const tasks = new Set<Promise<unknown>>();
  const check = () => { if (closed) throw new CoreError("NOT_AVAILABLE", "Native bundle host is closed."); context.assertLease(); };
  const transferPin = async (actorId: string, source: Request["source"], signal: AbortSignal) => {
    try {
      const value = await authority.authorizeTransfer(actorId, Object.freeze({ ...source }), signal);
      check(); signal.throwIfAborted();
      return pinSchema.parse(value);
    } catch { throw new CoreError("ACCESS_DENIED", "Native bundle transfer authority denied."); }
  };
  const owner = (id: string, actorId: string) => {
    const row = db.prepare("SELECT * FROM remote_runtime_intents WHERE operation_id=?").get(id);
    if (!row || row.actor_id !== actorId || row.kind !== "remote.subscription.bundle") conflict();
    return row;
  };
  const assertSiblings = (id: string) => context.read(() => {
    for (const table of ["pending_write", "pending_todo", "pending_asset", "pending_resource", "pending_document_lifecycle",
      "pending_project_mutation", "data_runtime_intents", "migration_runtime_intents"]) {
      if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) conflict();
    }
    if (db.prepare("SELECT 1 FROM remote_runtime_intents WHERE operation_id!=? AND state NOT IN ('complete','stale') LIMIT 1").get(id)
      || db.prepare("SELECT 1 FROM sync_apply_journal WHERE state!='completed' LIMIT 1").get()
      || db.prepare("SELECT 1 FROM coding_worker_effects WHERE state='intent' LIMIT 1").get()
      || db.prepare("SELECT 1 FROM coding_worker_records WHERE kind IN ('worker','check-intent') AND json_extract(record,'$.status')='intent' LIMIT 1").get()) conflict();
  });
  const assertReservations = (plan: ReturnType<typeof deserializeSubscriptionBundleApplyPlan>) => {
    const entries: [string, string][] = [];
    for (const identity of plan.identities) {
      for (const value of [identity.documentId, identity.knowledgeId]) if (value) entries.push(["identity", value]);
      for (const alias of identity.aliases) entries.push(["alias", alias.normalize("NFC").toLowerCase()]);
      if (identity.area === "packages") entries.push(["package", identity.path.normalize("NFC").toLowerCase()]);
    }
    for (const [namespace, value] of entries) {
      const row = db.prepare("SELECT operation_id FROM remote_subscription_identities WHERE namespace=? AND value=?").get(namespace, value);
      if (row && row.operation_id !== plan.operationId) conflict();
    }
  };
  const makeHost = (actorId: string, id: string, signal: AbortSignal) => {
    const policy: SubscriptionBundleApplyNativePolicy = {
      async authorize(binding, innerSignal) {
        check(); signal.throwIfAborted();
        assertSiblings(id);
        const stored = context.read(() => db.prepare("SELECT actor_id,pin_json FROM remote_runtime_pins WHERE pin_id=?").get(grantId(id)));
        if (stored) {
          const grant = canonical(grantSchema, String(stored.pin_json));
          if (stored.actor_id !== actorId || grant.actorId !== binding.actorId || JSON.stringify(grant.source) !== JSON.stringify(binding.source)
            || grant.ciphertextSha256 !== binding.ciphertextSha256 || grant.plaintextSha256 !== binding.plaintextSha256) conflict();
        } else if (context.read(() => db.prepare("SELECT 1 FROM remote_subscription_apply WHERE operation_id=?").get(id))) conflict();
        const current = await authority.nativePolicy.authorize(binding, innerSignal);
        check(); signal.throwIfAborted();
        return current;
      },
    };
    const journal: SubscriptionBundleApplyJournal = {
      async runExclusive(work) {
        check(); owner(id, actorId);
        return work({
          async load(operationId) {
            if (operationId !== id) conflict();
            return context.read(() => {
              check(); owner(id, actorId);
              const row = db.prepare("SELECT * FROM remote_subscription_apply WHERE operation_id=?").get(id);
              if (row && row.actor_id !== actorId) conflict();
              return row ? { intent: String(row.intent), receipt: row.receipt_json === null ? null
                : canonical(nativeBundleReceiptSchema, String(row.receipt_json)) as SubscriptionBundleApplyReceipt } : undefined;
            });
          },
          async persistIntent(operationId, serialized) {
            if (operationId !== id) conflict();
            const plan = deserializeSubscriptionBundleApplyPlan(serialized);
            if (plan.actorId !== actorId || plan.operationId !== id) conflict();
            assertSiblings(id);
            const current = await authority.nativePolicy.authorize({
              actorId, source: plan.source, ciphertextSha256: plan.ciphertextSha256, plaintextSha256: plan.plaintextSha256,
            }, signal);
            if (current.publisherPublicKey !== plan.authority.publisherPublicKey || current.keyEpoch !== plan.authority.keyEpoch
              || current.policyRevision !== plan.authority.policyRevision) conflict();
            const grant = JSON.stringify({ kind: "native-bundle-verification/v1", actorId, source: plan.source,
              ciphertextSha256: plan.ciphertextSha256, plaintextSha256: plan.plaintextSha256, authority: plan.authority });
            context.transaction(() => {
              check(); signal.throwIfAborted();
              const parent = owner(id, actorId), intent = canonical(intentSchema, String(parent.payload_json));
              if (parent.state !== "pending" || JSON.stringify(plan.source) !== JSON.stringify(intent.request.source)) conflict();
              assertReservations(plan);
              db.prepare("INSERT INTO remote_runtime_pins VALUES(?,?,?)").run(grantId(id), actorId, grant);
              db.prepare("INSERT INTO remote_subscription_apply VALUES(?,?,?,NULL)").run(id, actorId, serialized);
            });
          },
          async commit(operationId, planSha256, receipt) {
            if (operationId !== id) conflict();
            const installIndex = context.prepareIndex();
            context.transaction(() => {
              check(); signal.throwIfAborted(); owner(id, actorId);
              const row = db.prepare("SELECT * FROM remote_subscription_apply WHERE operation_id=?").get(id);
              if (!row || row.actor_id !== actorId) conflict();
              const plan = deserializeSubscriptionBundleApplyPlan(String(row.intent));
              assertReservations(plan);
              if (plan.planSha256 !== planSha256 || receipt.planSha256 !== planSha256 || receipt.operationId !== id
                || JSON.stringify(receipt.source) !== JSON.stringify(plan.source)
                || receipt.ciphertextSha256 !== plan.ciphertextSha256 || receipt.plaintextSha256 !== plan.plaintextSha256
                || JSON.stringify(receipt.identities) !== JSON.stringify(plan.identities)
                || JSON.stringify(receipt.files) !== JSON.stringify(plan.changes.map(c => ({ path: c.path, sha256: c.afterSha256 })))) conflict();
              if (row.receipt_json !== null) { if (row.receipt_json !== JSON.stringify(receipt)) conflict(); return; }
              const values = new Set<string>();
              const reserve = (namespace: string, value: string) => {
                const key = JSON.stringify([namespace, value]);
                if (!values.has(key)) { db.prepare("INSERT INTO remote_subscription_identities VALUES(?,?,?)").run(namespace, value, id); values.add(key); }
              };
              for (const identity of receipt.identities) {
                for (const value of [identity.documentId, identity.knowledgeId]) if (value) reserve("identity", value);
                for (const value of identity.aliases) reserve("alias", value.normalize("NFC").toLowerCase());
                if (identity.area === "packages") reserve("package", identity.path.normalize("NFC").toLowerCase());
              }
              installIndex();
              const changed = db.prepare("UPDATE remote_subscription_apply SET receipt_json=? WHERE operation_id=? AND intent=? AND receipt_json IS NULL")
                .run(JSON.stringify(receipt), id, row.intent);
              if (changed.changes !== 1) conflict();
            });
          },
        });
      },
    };
    return new SubscriptionBundleApplyHost(root, journal, policy, actorId);
  };
  const finish = (actorId: string, id: string, apply: SubscriptionBundleApplyReceipt): Result => context.transaction(() => {
    check();
    const row = owner(id, actorId), intent = canonical(intentSchema, String(row.payload_json));
    const result: Result = { kind: "remote-subscription-bundle/v1", operationId: id,
      wireSha256: intent.transfer.wireSha256, wireBytes: intent.transfer.wireBytes, apply };
    if (row.state === "complete") { if (row.result_json !== JSON.stringify(result)) conflict(); return result; }
    if (row.state !== "pending") conflict();
    const changed = db.prepare("UPDATE remote_runtime_intents SET state='complete',result_json=? WHERE operation_id=? AND fingerprint=? AND state='pending'")
      .run(JSON.stringify(result), id, row.fingerprint);
    if (changed.changes !== 1) conflict();
    const globalChanged = db.prepare("UPDATE receipts SET result=? WHERE operation_id=? AND fingerprint=? AND actor_id=? AND operation='remote.subscription.bundle'")
      .run(JSON.stringify(result), id, row.fingerprint, actorId);
    if (globalChanged.changes !== 1) conflict();
    return result;
  });
  const execute = <T>(work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> => {
    check();
    const controller = new AbortController(); controllers.add(controller);
    const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
    const task = context.exclusive(async () => { check(); signal.throwIfAborted(); return work(signal); });
    tasks.add(task);
    void task.finally(() => { controllers.delete(controller); tasks.delete(task); }).catch(() => {});
    return task;
  };
  const recoverLocked = async (actorId: string, id: string, signal: AbortSignal) => {
    check(); assertSiblings(id);
    context.read(() => { owner(id, actorId); inspectNativeSubscriptionBundles(db, context.workspaceId); });
    const host = makeHost(actorId, id, signal);
    return finish(actorId, id, await host.recover(id, signal, authority.boundary));
  };
  async function json(response: Awaited<ReturnType<SubscriptionTransportFetch>>, limit: number, signal: AbortSignal) {
    if (response.status !== 200 || response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") conflict();
    const chunks: Buffer[] = []; let total = 0;
    for await (const chunk of response.body) { signal.throwIfAborted(); total += chunk.byteLength; if (total > limit) conflict(); chunks.push(Buffer.from(chunk)); }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  }
  return {
    inspect() { check(); context.read(() => inspectNativeSubscriptionBundles(db, context.workspaceId)); },
    /** Caller holds the shared workspace lock; verify ALL authority before the first recovery effect. */
    async recoverPending() {
      check();
      const rows = context.read(() => {
        inspectNativeSubscriptionBundles(db, context.workspaceId);
        return db.prepare("SELECT operation_id,actor_id FROM remote_runtime_intents WHERE kind='remote.subscription.bundle' AND state='pending'").all();
      });
      const signal = new AbortController().signal;
      for (const row of rows) {
        const id = String(row.operation_id); assertSiblings(id);
        const applied = context.read(() => db.prepare("SELECT intent FROM remote_subscription_apply WHERE operation_id=?").get(id));
        // A transfer-only intent has no local effects; its identical run request may refetch.
        if (!applied) continue;
        const plan = deserializeSubscriptionBundleApplyPlan(String(applied.intent));
        let current;
        try {
          current = await authority.nativePolicy.authorize({
            actorId: String(row.actor_id), source: plan.source, ciphertextSha256: plan.ciphertextSha256, plaintextSha256: plan.plaintextSha256,
          }, signal);
        } catch { throw new CoreError("ACCESS_DENIED", "Bundle recovery source authority denied."); }
        check();
        if (current.publisherPublicKey !== plan.authority.publisherPublicKey || current.policyRevision !== plan.authority.policyRevision)
          throw new CoreError("ACCESS_DENIED", "Bundle recovery source authority changed.");
        if (current.keyEpoch !== plan.authority.keyEpoch) throw new CoreError("STALE_KEY_EPOCH", "Bundle recovery key epoch changed.");
        context.read(() => assertReservations(plan));
      }
      for (const row of rows) {
        const id = String(row.operation_id);
        if (context.read(() => db.prepare("SELECT 1 FROM remote_subscription_apply WHERE operation_id=?").get(id)))
          await recoverLocked(String(row.actor_id), id, signal);
      }
    },
    run(actorId: string, value: unknown, external?: AbortSignal) {
      const request = nativeBundleRequestSchema.parse(value); z.string().min(1).max(200).parse(actorId);
      return execute(async signal => {
        const deadline = Date.parse(request.expiresAt);
        if (deadline <= Date.now() || deadline - Date.now() > 120_000) throw new CoreError("ACCESS_DENIED", "Bundle request expired.");
        signal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
        const transfer = await transferPin(actorId, request.source, signal);
        check(); signal.throwIfAborted();
        const intent = JSON.stringify({ kind: "remote-subscription-bundle/v1", bindingId: endpoint.bindingId, request, transfer });
        const fingerprint = syncPlanHash({ workspaceId: context.workspaceId, actorId, intent });
        context.transaction(() => {
          check(); signal.throwIfAborted();
          const prior = db.prepare("SELECT * FROM remote_runtime_intents WHERE operation_id=?").get(request.operationId);
          if (prior) {
            if (prior.actor_id !== actorId || prior.kind !== "remote.subscription.bundle" || prior.payload_json !== intent || prior.fingerprint !== fingerprint) conflict();
          } else {
            context.assertOperationAvailable(request.operationId);
            context.claimReceipt(request.operationId, fingerprint, actorId, "remote.subscription.bundle", { operationId: request.operationId, pending: true });
            db.prepare("INSERT INTO remote_runtime_intents VALUES(?,?,?,?,?,?,NULL)")
              .run(request.operationId, actorId, "remote.subscription.bundle", fingerprint, "pending", intent);
          }
        });
        if (context.read(() => db.prepare("SELECT 1 FROM remote_subscription_apply WHERE operation_id=?").get(request.operationId)))
          return recoverLocked(actorId, request.operationId, signal);
        const fence = async () => {
          check(); signal.throwIfAborted();
          const fresh = await transferPin(actorId, request.source, signal);
          check(); signal.throwIfAborted();
          if (JSON.stringify(fresh) !== JSON.stringify(transfer)) throw new CoreError("ACCESS_DENIED", "Native transfer pin changed.");
          context.read(() => { const row = owner(request.operationId, actorId); if (row.payload_json !== intent || row.state !== "pending") conflict(); });
        };
        const headers = async () => {
          await fence();
          const proof = await authority.secrets.resolve(endpoint.secretRef, request.source.shareId);
          if (!proof.subscriberProof || proof.subscriberProof.length > 16_384 || /[\r\n]/.test(proof.subscriberProof)) conflict();
          await fence(); return { "X-PKM-Subscriber-Proof": proof.subscriberProof };
        };
        const base = transportEndpoint(endpoint);
        const summary = await json(await fetch(new URL(`/v1/shares/${encodeURIComponent(request.source.shareId)}/summary`, base),
          "GET", await headers(), signal, endpoint.connectAddress), 65_536, signal);
        await fence();
        try {
          verifyShareSummary(summary, endpoint.publisherPublicKey, request.source.nodeId, request.source.shareId);
          const metadata = summary as Record<string, unknown>;
          if (metadata.collectionHash !== request.source.collectionHash || metadata.revision !== request.source.revision
            || metadata.name !== request.source.brokerName || !z.number().int().positive().max(16_777_216).safeParse(metadata.snapshotBytes).success) conflict();
        } catch { throw new CoreError("ACCESS_DENIED", "Original bundle summary source authentication failed."); }
        if (!existsSync(join(stage, `${request.operationId}.snapshot`))) {
          const ticket = transportTicketSchema.parse(await json(await fetch(new URL(`/v1/shares/${encodeURIComponent(request.source.shareId)}/sync-ticket`, base),
            "POST", await headers(), signal, endpoint.connectAddress), 8192, signal));
          await fence();
          const ticketDeadline = Date.parse(ticket.expiresAt);
          if (ticket.revision !== request.source.revision || ticket.collectionHash !== request.source.collectionHash
            || ticketDeadline <= Date.now() || ticketDeadline - Date.now() > 120_000) conflict();
          const transferSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, ticketDeadline - Date.now()))]);
          const response = await fetch(transportBroker(ticket.brokerUrl, endpoint), "GET", { Authorization: `Bearer ${ticket.ticket}` },
            transferSignal, endpoint.connectAddress);
          if (response.status !== 200 || Number(response.headers["content-length"]) !== transfer.wireBytes
            || response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") conflict();
          await staging.receive(request.operationId, response.body, transfer.wireBytes, transfer.wireSha256,
            async () => { transferSignal.throwIfAborted(); await fence(); });
        }
        await fence();
        const wire = staging.verified(request.operationId, transfer.wireSha256, transfer.wireBytes);
        const apply = await makeHost(actorId, request.operationId, signal).apply(codec, { source: request.source, mode: "fork", summary, wire },
          codecStage, request.operationId, signal, authority.boundary);
        await fence();
        return finish(actorId, request.operationId, apply);
      }, external);
    },
    recover(actorId: string, value: unknown, signal?: AbortSignal) {
      const { operationId } = z.strictObject({ operationId: z.string().uuid() }).parse(value); z.string().min(1).max(200).parse(actorId);
      return execute(inner => recoverLocked(actorId, operationId, inner), signal);
    },
    async close() { closed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...tasks]); },
  };
}
