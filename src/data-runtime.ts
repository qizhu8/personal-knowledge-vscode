import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { dataRuntimeDefinitions } from "./data-runtime-contracts.js";
import {
  applyFolderLifecycle, deserializeFolderLifecyclePlan, folderLifecycleDefinitions,
  inspectFolderLifecycleRecovery, planFolderLifecycle, readFolderLifecycle, recoverFolderLifecycle,
  serializeFolderLifecyclePlan, type FolderLifecycleRequest,
} from "./folder-lifecycle.js";
import { scanMarkdown } from "./markdown.js";
import { sha256 } from "./file-write.js";
import { SyncPlanStore } from "./sync-plan-store.js";
import {
  applySyncPlan, initializeSyncApplyJournal, inspectSyncApplyRecovery, serializeSyncApplyPlan,
} from "./sync-apply.js";
import { syncApplyPlanSchema } from "./sync-apply-contracts.js";
import {
  RetrievalRuntime, type RetrievalRuntimeOptions, type RetrievalScope,
} from "./retrieval-runtime.js";
import { RetrievalLearning, type RetrievalLearningOptions } from "./retrieval-learning.js";
import {
  SubscriptionApplyHost, deserializeSubscriptionApplyPlan, type SubscriptionApplyAuthority,
  type SubscriptionApplyJournalTransaction, type SubscriptionApplyNativePolicy,
} from "./subscription-apply.js";
import { observeApplyWorkspace } from "./domain/subscription-apply-files.js";
import { recoverSubscriptionMaterialize } from "./subscription-materialize.js";
import type { SubscriptionMaterializeInput } from "./subscription-materialize-contracts.js";
import type { MemoryContextDependencies } from "./memory-context-contracts.js";

export { dataRuntimeDefinitions } from "./data-runtime-contracts.js";
export const DATA_RUNTIME_DDL = `
  CREATE TABLE IF NOT EXISTS data_runtime_intents (
    operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, root_path TEXT NOT NULL,
    actor_id TEXT NOT NULL, operation TEXT NOT NULL, fingerprint TEXT NOT NULL,
    request_json TEXT NOT NULL, plan_json TEXT NOT NULL, digest TEXT NOT NULL
  ) STRICT;
`;
export function initializeDataRuntime(database: DatabaseSync): void {
  database.exec(DATA_RUNTIME_DDL);
  initializeSyncApplyJournal(database);
}
export interface DataRuntimeRequest {
  operation: string; args: Record<string, unknown>; actorId: string;
}
export interface DataRuntimeHost {
  namespace: string;
  syncContent?: import("./sync-content.js").SyncContentAuthority;
  withSyncContentReview?: (request: DataRuntimeRequest, work: () => Promise<unknown>) => Promise<unknown>;
  retrieval?: Omit<RetrievalRuntimeOptions, "database">;
  learning?: RetrievalLearningOptions;
  subscription?: {
    authority(actorId: string, source: SubscriptionMaterializeInput["source"]): SubscriptionApplyAuthority;
    nativeAuthorize: SubscriptionApplyNativePolicy;
  };
}
export interface DataRuntimeOptions {
  database: DatabaseSync; root: string; workspaceId: string;
  /** Shared owner transaction. Must reject async callbacks; no outer transaction during mutate/recover. */
  transaction<T>(work: () => T): T;
  /** Synchronous shared documents/identity index reconciliation, inside the final transaction. */
  reconcileIndex(): void;
  fingerprint?(request: DataRuntimeRequest): string;
  /** Check ALL other domains' global pending journals, not just completed receipts. */
  assertOperationAvailable?(operationId: string): void;
  host?: DataRuntimeHost;
}
interface Intent {
  operation_id: string; workspace_id: string; root_path: string; actor_id: string;
  operation: string; fingerprint: string; request_json: string; plan_json: string; digest: string;
}
const requestSchema = z.strictObject({
  operation: z.string().min(1).max(256), args: z.record(z.string(), z.unknown()), actorId: z.string().min(1).max(500),
});
const definitions = [...folderLifecycleDefinitions, ...dataRuntimeDefinitions];
function fail(message: string): never { throw new CoreError("RECOVERY_CONFLICT", message, "unknown"); }

/** Uses the caller's sole connection and workspace writer serialization; never opens/closes a DB.
 * Filesystem intents commit before effects. The final index, global receipt and intent removal share
 * one transaction. Sync owns its internal journal transaction and invokes our finalizer inside it.
 * Native embedding calls run outside DB transactions; checkpoint/receipt publication is atomic. */
export class DataRuntime {
  private readonly db: DatabaseSync;
  private readonly root: string;
  private readonly sync: SyncPlanStore;
  private readonly retrieval?: RetrievalRuntime;
  private readonly learning?: RetrievalLearning;
  private closed = false;
  constructor(private readonly options: DataRuntimeOptions) {
    this.db = options.database; this.root = resolve(options.root); this.sync = new SyncPlanStore(this.db);
    if (!options.workspaceId || typeof options.transaction !== "function" || typeof options.reconcileIndex !== "function") {
      throw new CoreError("INVALID_ARGUMENT", "Explicit shared database, workspace identity and transaction/index ownership required.");
    }
    if (options.host?.retrieval) {
      this.retrieval = new RetrievalRuntime({ ...options.host.retrieval, database: this.db });
      this.learning = new RetrievalLearning(this.db, options.host.learning);
    }
  }
  private check(): void {
    if (this.closed) throw new CoreError("UNAVAILABLE", "Data runtime is closed.");
    if (this.db.isTransaction) throw new CoreError("INVALID_ARGUMENT", "Data runtime requires the shared writer outside an open transaction.");
  }
  private parse(request: DataRuntimeRequest): DataRuntimeRequest {
    const parsed = requestSchema.parse({ operation: request.operation, args: request.args, actorId: request.actorId });
    const definition = definitions.find(item => item.id === parsed.operation);
    if (!definition) throw new CoreError("NOT_FOUND", "Unknown data runtime operation.");
    const args = definition.input.safeParse(parsed.args);
    if (!args.success) throw new CoreError("INVALID_ARGUMENT", "Data operation violates its exact schema.");
    return { ...parsed, args: args.data };
  }
  private fingerprint(request: DataRuntimeRequest): string {
    return this.options.fingerprint?.(request) ?? sha256(JSON.stringify(request));
  }
  private receipt(request: DataRuntimeRequest): { result: unknown } | undefined {
    const row = this.db.prepare("SELECT fingerprint,actor_id,operation,result FROM receipts WHERE operation_id=?")
      .get(String(request.args.operationId));
    if (!row) return undefined;
    if (row.fingerprint !== this.fingerprint(request) || row.actor_id !== request.actorId || row.operation !== request.operation) {
      throw new CoreError("CONFLICT", "Global operationId belongs to a different immutable request or actor.");
    }
    return { result: JSON.parse(String(row.result)) };
  }
  private scope(actorId: string): RetrievalScope {
    if (!this.options.host?.namespace) throw new CoreError("UNAVAILABLE", "Native namespace/provider composition is unavailable.");
    return { actor: actorId, namespace: this.options.host.namespace, workspace: this.options.workspaceId };
  }
  private engine(): RetrievalRuntime {
    if (!this.retrieval) throw new CoreError("UNAVAILABLE", "No explicit native embedder, authoritative sources and authorization are configured.");
    return this.retrieval;
  }
  private pending(id: string): Intent | undefined {
    return this.db.prepare("SELECT * FROM data_runtime_intents WHERE operation_id=?").get(id) as Intent | undefined;
  }
  private insert(request: DataRuntimeRequest, plan: string): void {
    const id = String(request.args.operationId), json = JSON.stringify(request);
    const row = this.pending(id);
    if (row) {
      this.validate(row);
      if (row.request_json !== json || row.plan_json !== plan) throw new CoreError("CONFLICT", "Global operationId belongs to a different pending data intent.");
      return;
    }
    if (this.receipt(request)) throw new CoreError("CONFLICT", "Operation already completed.");
    this.options.assertOperationAvailable?.(id);
    const binding = [this.options.workspaceId, this.root, request.actorId, request.operation, this.fingerprint(request), json, plan];
    this.db.prepare("INSERT INTO data_runtime_intents VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, ...binding, sha256(JSON.stringify([id, ...binding])));
  }
  private validate(row: Intent): DataRuntimeRequest {
    const request = this.parse(JSON.parse(row.request_json) as DataRuntimeRequest);
    const binding = [row.operation_id, row.workspace_id, row.root_path, row.actor_id, row.operation,
      row.fingerprint, row.request_json, row.plan_json];
    if (row.workspace_id !== this.options.workspaceId || row.root_path !== this.root
      || row.actor_id !== request.actorId || row.operation !== request.operation
      || row.operation_id !== request.args.operationId || row.fingerprint !== this.fingerprint(request)
      || row.digest !== sha256(JSON.stringify(binding)) || this.receipt(request)) {
      fail("Pending data intent has an unknown workspace, actor, identity, digest or committed effect; preserve it.");
    }
    if (definitions.find(item => item.id === request.operation)!.readOnly) fail("A read-only operation cannot own a pending mutation intent.");
    return request;
  }
  private finish(request: DataRuntimeRequest, result: unknown): void {
    if (!this.db.isTransaction) throw new CoreError("INVALID_ARGUMENT", "Final receipt/index publication requires the shared transaction.");
    const row = this.pending(String(request.args.operationId));
    if (!row) fail("Pending data intent disappeared before final publication.");
    this.validate(row);
    const definition = definitions.find(item => item.id === request.operation)!;
    const parsed = definition.output.safeParse(result);
    if (!parsed.success) fail("Data operation returned an invalid result; preserve its pending intent.");
    this.options.reconcileIndex();
    this.db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(
      String(request.args.operationId), this.fingerprint(request), JSON.stringify(parsed.data),
      request.actorId, request.operation, new Date().toISOString());
    this.db.prepare("DELETE FROM data_runtime_intents WHERE operation_id=? AND digest=?").run(row.operation_id, row.digest);
  }
  private serializeSync(request: DataRuntimeRequest) {
    try {
      return serializeSyncApplyPlan(this.sync, {
        sessionId: String(request.args.sessionId), actorId: request.actorId, input: request.args.input,
      }, { contentAuthority: this.options.host?.syncContent }, this.root);
    } catch (error) {
      if (error instanceof CoreError || !(error instanceof Error)) throw error;
      if (/Sync plan session not found/.test(error.message)) throw new CoreError("NOT_FOUND", error.message);
      if (/Only the persisted sync plan owner/.test(error.message)) throw new CoreError("ACCESS_DENIED", error.message);
      if (/source pins|persisted sync decision|decision source pins|persisted explicit decision|authenticated plan owner/i.test(error.message)) {
        throw new CoreError("CONFLICT", error.message);
      }
      throw error;
    }
  }
  async read(value: DataRuntimeRequest): Promise<unknown> {
    this.check(); const request = this.parse(value), { operation, args, actorId } = request;
    if (operation === "knowledge.folder.lifecycle.preview" || operation === "knowledge.folder.lifecycle.promote-preview") return this.options.transaction(() =>
      readFolderLifecycle(this.root, scanMarkdown(this.root), request as FolderLifecycleRequest));
    if (operation === "sync.apply.preview") {
      const work = async () => this.options.transaction(() => this.serializeSync(request));
      return this.options.host?.withSyncContentReview ? this.options.host.withSyncContentReview(request, work) : work();
    }
    if (operation === "retrieval.runtime.availability") return this.retrieval?.availability(this.scope(actorId)) ?? { available: false };
    if (operation === "retrieval.runtime.search") return this.engine().search(this.scope(actorId), args as unknown as Parameters<RetrievalRuntime["search"]>[1]);
    throw new CoreError("INVALID_ARGUMENT", "This data operation is not read-only.");
  }
  async mutate(value: DataRuntimeRequest): Promise<unknown> {
    this.check(); const request = this.parse(value);
    if (request.operation === "sync.apply" && this.options.host?.withSyncContentReview && !this.receipt(request))
      return this.options.host.withSyncContentReview(request, () => this.mutatePrepared(request));
    return this.mutatePrepared(request);
  }
  private async mutatePrepared(request: DataRuntimeRequest): Promise<unknown> {
    const definition = definitions.find(item => item.id === request.operation)!;
    if (definition.readOnly) throw new CoreError("INVALID_ARGUMENT", "Read-only data operation cannot mutate.");
    if (request.operation === "subscription.materialize.apply") {
      await this.subscription(request.actorId, (request.args.input as SubscriptionMaterializeInput).source, request)
        .assertAuthorized(request.args.input);
    }
    const prior = this.receipt(request); if (prior) return prior.result;
    await this.recover();
    const recovered = this.receipt(request); if (recovered) return recovered.result;
    if (request.operation === "subscription.materialize.apply") return this.subscription(request.actorId,
      (request.args.input as SubscriptionMaterializeInput).source, request).apply(request.args.input,
      String(request.args.operationId), String(request.args.expectedWorkspaceRevision)).then(receipt => receipt.result);
    let plan = "";
    this.options.transaction(() => {
      if (request.operation === "knowledge.folder.move" || request.operation === "knowledge.folder.promote-delete") {
        plan = serializeFolderLifecyclePlan(planFolderLifecycle(this.root, scanMarkdown(this.root), request as FolderLifecycleRequest));
      } else if (request.operation === "sync.apply") {
        const serialized = this.serializeSync(request);
        if (serialized.planHash !== request.args.expectedPlanHash) throw new CoreError("CONFLICT", "Sync apply plan pin changed.");
        plan = JSON.stringify(serialized);
      } else { this.engine(); plan = JSON.stringify({ kind: "retrieval-checkpoint", request }); }
      this.insert(request, plan);
    });
    return this.execute(this.pending(String(request.args.operationId))!, false);
  }
  private async execute(row: Intent, recovering: boolean): Promise<unknown> {
    const request = this.validate(row), { operation, args, actorId } = request;
    if (operation === "knowledge.folder.move" || operation === "knowledge.folder.promote-delete") {
      const plan = deserializeFolderLifecyclePlan(row.plan_json);
      if (plan.actorId !== actorId || plan.operationId !== args.operationId) fail("Folder intent identity mismatch.");
      const result = recovering ? recoverFolderLifecycle(this.root, plan, row.operation_id)
        : applyFolderLifecycle(this.root, plan, row.operation_id);
      this.options.transaction(() => this.finish(request, result)); return result;
    }
    if (operation === "sync.apply") {
      const plan = syncApplyPlanSchema.parse(JSON.parse(row.plan_json));
      if (plan.actorId !== actorId || plan.planHash !== args.expectedPlanHash
        || JSON.stringify(serializeSyncApplyPlan(this.sync, { sessionId: String(args.sessionId), actorId, input: args.input },
          { contentAuthority: this.options.host?.syncContent }, this.root)) !== row.plan_json) {
        fail("Sync intent no longer matches its persisted owner, source or decision pins.");
      }
      return applySyncPlan(this.sync, { sessionId: String(args.sessionId), actorId, input: args.input }, this.root, {
        contentAuthority: this.options.host?.syncContent,
        beforeCommit: receipt => this.finish(request, receipt),
      });
    }
    if (operation === "subscription.materialize.apply") {
      const plan = deserializeSubscriptionApplyPlan(row.plan_json);
      return this.subscription(actorId, plan.material.source, request).recover(row.operation_id).then(receipt => receipt.result);
    }
    const engine = this.engine(), scope = this.scope(actorId);
    if (row.plan_json !== JSON.stringify({ kind: "retrieval-checkpoint", request })) fail("Unknown retrieval checkpoint intent.");
    const commit = (result: unknown) => this.finish(request, result);
    if (operation === "retrieval.runtime.stage") return engine.stage(scope, { indexId: row.operation_id, onCommit: commit });
    if (operation === "retrieval.runtime.qualify") return engine.qualify(scope, String(args.indexId), commit);
    if (operation === "retrieval.runtime.activate") return engine.activate(scope, String(args.indexId), args.expectedActiveIndexId as string | null, commit);
    fail("Unknown pending data operation.");
  }
  private subscription(actorId: string, source: SubscriptionMaterializeInput["source"], request: DataRuntimeRequest): SubscriptionApplyHost {
    const host = this.options.host?.subscription;
    if (!host || typeof host.nativeAuthorize !== "function") throw new CoreError("UNAVAILABLE", "Native subscription ACL/source policy is unavailable.");
    const authority = host.authority(actorId, source);
    if (authority.actorId !== actorId) throw new CoreError("ACCESS_DENIED", "Native subscription actor binding mismatch.");
    const transaction: SubscriptionApplyJournalTransaction = {
      load: async id => { const row = this.pending(id); if (!row) return undefined; this.validate(row); return { intent: row.plan_json, receipt: null }; },
      persistIntent: async (_id, plan) => { this.options.transaction(() => this.insert(request, plan)); },
      commit: async (_id, receipt) => { this.options.transaction(() => this.finish(request, receipt.result)); },
    };
    return new SubscriptionApplyHost(this.root, { runExclusive: work => work(transaction) }, authority, host.nativeAuthorize);
  }
  /** Read-only fence for the owner's ALL-journals startup preflight. Must precede other recovery. */
  async inspectRecovery(): Promise<void> {
    this.check();
    const rows = this.db.prepare("SELECT * FROM data_runtime_intents ORDER BY operation_id").all() as unknown as Intent[];
    inspectSyncApplyRecovery(this.sync, this.root);
    for (const journal of this.db.prepare("SELECT actor_id,plan_hash FROM sync_apply_journal WHERE state != 'completed'").all()) {
      if (!rows.some(row => row.operation === "sync.apply" && row.actor_id === journal.actor_id
        && syncApplyPlanSchema.parse(JSON.parse(row.plan_json)).planHash === journal.plan_hash)) fail("Orphan Sync journal has no shared immutable operation identity.");
    }
    for (const row of rows) {
      const request = this.validate(row);
      if (request.operation === "knowledge.folder.move" || request.operation === "knowledge.folder.promote-delete") {
        const plan = deserializeFolderLifecyclePlan(row.plan_json);
        const args = request.args;
        if (plan.actorId !== request.actorId || plan.operationId !== row.operation_id || plan.area !== args.area
          || plan.sourcePath !== args.path
          || (request.operation === "knowledge.folder.move" ? !!plan.promote || plan.destinationPath !== args.destinationPath
            : !plan.promote || args.mode !== "parent")
          || plan.expectedScanRevision !== args.expectedScanRevision || plan.expectedSourceSha256 !== args.expectedSourceSha256
          || plan.expectedDestinationSha256 !== args.expectedDestinationSha256) fail("Pending folder actor, arguments or pins mismatch.");
        inspectFolderLifecycleRecovery(this.root, plan, row.operation_id);
      } else if (request.operation === "subscription.materialize.apply") {
        const plan = deserializeSubscriptionApplyPlan(row.plan_json);
        if (plan.material.operationId !== row.operation_id || plan.material.actorId !== request.actorId
          || plan.material.workspaceRevision !== request.args.expectedWorkspaceRevision
          || plan.inputSha256 !== sha256(JSON.stringify(request.args.input))) fail("Pending subscription serialization identity mismatch.");
        await this.subscription(request.actorId, plan.material.source, request).assertAuthorized(request.args.input, plan.nativeRevision);
        recoverSubscriptionMaterialize(plan.material, request.actorId, row.operation_id, observeApplyWorkspace(this.root, plan));
      } else if (request.operation === "sync.apply") {
        const plan = serializeSyncApplyPlan(this.sync, {
          sessionId: String(request.args.sessionId), actorId: request.actorId, input: request.args.input,
        }, { contentAuthority: this.options.host?.syncContent }, this.root);
        if (JSON.stringify(plan) !== row.plan_json || plan.planHash !== request.args.expectedPlanHash) fail("Shared Sync recovery source/decision pins changed.");
      } else {
        if (!["retrieval.runtime.stage", "retrieval.runtime.qualify", "retrieval.runtime.activate"].includes(request.operation)
          || row.plan_json !== JSON.stringify({ kind: "retrieval-checkpoint", request })) fail("Unknown pending data operation; no recovery effects were attempted.");
        this.engine();
      }
    }
  }
  async recover(): Promise<void> {
    await this.inspectRecovery();
    const rows = this.db.prepare("SELECT * FROM data_runtime_intents ORDER BY operation_id").all() as unknown as Intent[];
    for (const row of rows) await this.execute(row, true);
  }
  /** Actual authorized, index-pinned engine results through the captured ranker/calibrator adapter. */
  async searchReranked(actorId: string, request: Parameters<RetrievalRuntime["search"]>[1]) {
    this.check();
    const scope = this.scope(actorId), result = await this.engine().search(scope, request);
    const ranked = this.learning!.rerank({ scope, query: request.query, indexId: result.indexId, model: result.model, hits: result.hits });
    return { ...result, hits: ranked.hits };
  }
  /** Native MemoryContextService dependency; only supplied canonical memory pins may be returned. */
  memoryRetriever(): NonNullable<MemoryContextDependencies["retrieve"]> {
    return async input => {
      if (!this.retrieval || input.signal?.aborted || input.binding.namespace !== this.options.host?.namespace) {
        return { status: "unavailable", reason: "Native pinned retrieval is unavailable for this memory scope." };
      }
      const result = await this.searchReranked(input.binding.actorId, {
        query: input.query, sourceIds: input.sources.map(source => source.id), limit: Math.min(100, input.sources.length || 1),
      });
      if (input.signal?.aborted) return { status: "unavailable", reason: "Memory retrieval was cancelled." };
      let remaining = input.budgetChars;
      const blocks = result.hits.flatMap(hit => {
        const source = input.sources.find(source => source.id === hit.sourceId
          && source.revision === hit.sourceRevision && source.contentHash === hit.sourceSha256);
        if (!source || remaining < hit.text.length) return [];
        remaining -= hit.text.length;
        return [{ kind: "related-topic" as const, piece: hit.chunkId, text: hit.text, sources: [{ ...source }] }];
      });
      return { status: "available", blocks };
    };
  }
  close(): void { this.closed = true; }
}
