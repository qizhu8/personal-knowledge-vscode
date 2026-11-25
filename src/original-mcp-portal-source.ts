import { randomUUID } from "node:crypto";
import { originalPortalNativeDecision, originalPortalTaskReference, originalPortalManualIntent,
  parseOriginalPortalNativePayload } from "./original-mcp-portal-contracts.js";
import type { OriginalMcpNativeRequestFrame } from "./original-mcp-native-request.js";

type Json = Record<string, any>;
export interface OriginalPortalEndpointStorePort {
  list(): Json[];
  get(id: string): Json | undefined;
  create(input: Json): Promise<Json>;
  pair(id: string, binding: Json, transport: Json, credential: string): Promise<Json>;
  update(id: string, changes: Json, revision?: number): Promise<Json>;
  credential(id: string): Promise<string | undefined>;
}
/** Adapts the original named-endpoint store, never archive files or public credentials. */
export function createOriginalMcpNativePortalSource(options: {
  assertCurrent(): void;
  store(frame: OriginalMcpNativeRequestFrame): OriginalPortalEndpointStorePort;
  decide(request: Json, frame: OriginalMcpNativeRequestFrame, signal: AbortSignal): Promise<Json>;
}) {
  const references = new Map<string, { reference: Json; frame: OriginalMcpNativeRequestFrame }>();
  const intents = new Map<string, Json[]>();
  const outcomes = new Map<string, Json>();
  return Object.freeze({
    dispose() { references.clear(); intents.clear(); outcomes.clear(); },
    outcomes() { options.assertCurrent(); return [...outcomes.values()].map(value => ({ ...value })); },
    references(): Array<Json & { key: string }> {
      options.assertCurrent(); return [...references].map(([key, value]) => ({ key, ...value.reference }));
    },
    async requestManual(key: string, signal: AbortSignal) {
      options.assertCurrent();
      const selected = references.get(key);
      if (!selected || signal.aborted || !["failed", "cancelled", "interrupted"].includes(selected.reference.status))
        throw new Error("PORTAL_CURRENT_FAILED_REPLY_REFERENCE_REQUIRED");
      const decision = await options.decide({ phase: "manual-attempt", contextId: selected.reference.contextId,
        pairId: selected.reference.pairId, revision: selected.reference.revision, detail: selected.reference }, selected.frame, signal);
      options.assertCurrent();
      if (signal.aborted || references.get(key) !== selected || decision.decision !== "approve")
        throw new Error("PORTAL_MANUAL_INTENT_DENIED_OR_CHANGED");
      const workspaceId = selected.frame.session.binding.workspaceId, queue = intents.get(workspaceId) ?? [];
      if (queue.length >= 8) throw new Error("PORTAL_MANUAL_INTENT_QUEUE_FULL");
      const intent = originalPortalManualIntent.parse({ ...selected.reference, commandId: randomUUID(), expiresAtMs: Date.now() + 120000 });
      queue.push(intent); intents.set(workspaceId, queue);
      if (outcomes.size >= 128) outcomes.delete(outcomes.keys().next().value!);
      outcomes.set(intent.commandId, { commandId: intent.commandId, workspaceId, epoch: intent.epoch, status: "queued", replay: "never" });
      return { commandId: intent.commandId, queued: true, replay: "never" };
    },
    async handle(frame: OriginalMcpNativeRequestFrame, signal: AbortSignal) {
      options.assertCurrent();
      const payload = parseOriginalPortalNativePayload(frame.payload, frame.session), request = payload.request;
      for (const [key, value] of references) {
        if (value.frame.session.binding.workspaceId === frame.session.binding.workspaceId
          && value.reference.epoch !== frame.session.activationId) references.delete(key);
      }
      const store = options.store(frame);
      const sourceRevision = request.detail.sourceRevision ?? request.revision;
      const current = () => {
        options.assertCurrent();
        if (signal.aborted) throw new Error("NATIVE_REQUEST_CANCELLED");
      };
      current();
      const owned = (id: string) => {
        const endpoint = store.get(id);
        if (!endpoint || endpoint.root !== payload.binding.root || endpoint.deleted)
          throw new Error("PORTAL_CURRENT_SAVED_ENDPOINT_REQUIRED");
        return endpoint;
      };
      let decision: Json;
      if (request.phase === "task-reference") {
        const reference = originalPortalTaskReference.parse(request.detail.reference);
        if (reference.epoch !== frame.session.activationId || reference.contextId !== request.contextId
          || reference.pairId !== request.pairId) throw new Error("PORTAL_TASK_REFERENCE_BINDING_REQUIRED");
        if (references.size >= 128) references.delete(references.keys().next().value!);
        references.set(`${frame.session.binding.workspaceId}:${reference.contextId}:${reference.requestId}`, { reference, frame });
        decision = { decision: "approve" };
      } else if (request.phase === "manual-result") {
        const value = request.detail;
        const issued = outcomes.get(String(value.commandId));
        if (!issued || issued.workspaceId !== frame.session.binding.workspaceId || issued.epoch !== frame.session.activationId
          || issued.status !== "queued" || !["succeeded", "failed", "outcome_unknown", "cancelled"].includes(String(value.status))
          || typeof value.error !== "string" || value.error.length > 2000)
          throw new Error("PORTAL_CURRENT_MANUAL_RESULT_REQUIRED");
        outcomes.set(String(value.commandId), { ...issued, ...value, replay: "never" });
        decision = await options.decide(request, frame, signal);
      } else if (request.phase === "manual-intents") {
        const workspaceId = frame.session.binding.workspaceId, queue = intents.get(workspaceId) ?? [];
        intents.delete(workspaceId);
        decision = { decision: "approve", manualIntents: queue.filter(intent =>
          intent.epoch === frame.session.activationId && intent.expiresAtMs > Date.now()) };
      } else if (request.phase === "endpoints") {
        decision = { decision: "approve", endpoints: store.list().filter(endpoint =>
          endpoint.root === payload.binding.root && !endpoint.deleted) };
      } else if (request.phase === "endpoint-check") {
        const endpoint = store.get(request.contextId);
        decision = { decision: endpoint?.root === payload.binding.root && !endpoint.deleted
          && endpoint.revision === sourceRevision && endpoint.paired?.binding.pairId === request.pairId
          ? "approve" : "deny", ...(endpoint ? { endpoint } : {}) };
      } else {
        if (request.contextId) {
          const endpoint = store.get(request.contextId);
          if (endpoint && (endpoint.root !== payload.binding.root || endpoint.deleted || endpoint.revision !== sourceRevision))
            throw new Error("PORTAL_SOURCE_CHANGED_DURING_APPROVAL");
        }
        decision = await options.decide(request, frame, signal);
        current();
        if (request.contextId) {
          const endpoint = store.get(request.contextId);
          if (endpoint && (endpoint.root !== payload.binding.root || endpoint.deleted || endpoint.revision !== sourceRevision))
            throw new Error("PORTAL_SOURCE_CHANGED_DURING_APPROVAL");
        }
        if (decision.decision === "approve" && request.phase === "open" && decision.name) {
          decision.endpoint = await store.create({ name: decision.name, root: payload.binding.root,
            localMachine: decision.localMachine, ...(decision.chatId ? { chatId: decision.chatId } : {}) });
          delete decision.name; delete decision.localMachine;
        }
        if (decision.decision === "approve" && request.phase === "endpoint") {
          const endpoint = owned(String(request.detail.id));
          if (!endpoint.paired) throw new Error("PORTAL_SAVED_PAIR_REQUIRED");
          const credential = await store.credential(endpoint.id);
          current();
          if (!credential || store.get(endpoint.id)?.revision !== endpoint.revision)
            throw new Error("PORTAL_CURRENT_CREDENTIAL_CUSTODY_REQUIRED");
          decision.endpoint = endpoint; decision.credential = credential;
        }
        if (decision.decision === "approve" && request.phase === "save-pair") {
          const endpoint = owned(request.contextId);
          if (endpoint.revision !== sourceRevision) throw new Error("PORTAL_SOURCE_CHANGED_DURING_APPROVAL");
          const saved = await store.pair(endpoint.id, request.detail.binding as Json, request.detail.transport as Json,
            String(request.detail.credential));
          current();
          decision.endpoint = await store.update(saved.id, { acceptsIncoming: true }, saved.revision);
        }
      }
      current();
      return originalPortalNativeDecision.parse({ ...decision, requestSha256: payload.requestSha256,
        epoch: frame.session.activationId, expiresAtMs: Date.now() + 120000 });
    },
  });
}
