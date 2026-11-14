import { randomUUID } from "node:crypto";
import { z } from "zod";
import { documentPath, knowledgeArea } from "./document-path.js";
import { subscriptionMaterializeSource, type SubscriptionMaterializeInput } from "./subscription-materialize-contracts.js";
import { transportError, signedTransportSummary, transportTicketSchema } from "./domain/subscription-transport-protocol.js";
import { SubscriptionTransportStaging, transportHash } from "./domain/subscription-transport-staging.js";
import { subscriptionTransportSocketFetch, transportBroker, transportEndpoint } from "./domain/subscription-transport-socket.js";
import type { SubscriptionTransferPhase, SubscriptionTransferState, SubscriptionTransportHostOptions, SubscriptionTransportReceipt, SubscriptionTransportRequest, SubscriptionTransportResponse } from "./subscription-transport-contracts.js";

export { subscriptionTransportSocketFetch } from "./domain/subscription-transport-socket.js";
export { subscriptionTransportStoreContract } from "./subscription-transport-contracts.js";
export type * from "./subscription-transport-contracts.js";

const requestSchema = z.strictObject({
  operationId: z.string().uuid(), source: subscriptionMaterializeSource, area: knowledgeArea,
  paths: z.array(documentPath).min(1).max(512), mode: z.enum(["fork", "readonly-mirror"]),
  expiresAt: z.string().datetime(),
});
async function responseBytes(response: SubscriptionTransportResponse, limit: number, signal: AbortSignal) {
  if (response.status !== 200 || response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") transportError("INVALID_ARGUMENT", "Unsupported gateway response.");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of response.body) {
    signal.throwIfAborted();
    if ((total += value.byteLength) > limit) transportError("INVALID_ARGUMENT", "Gateway metadata exceeds limit.");
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.toString("utf8") !== new TextDecoder("utf-8", { fatal: true }).decode(bytes)) transportError("INVALID_ARGUMENT", "Invalid gateway encoding.");
  try { return JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { transportError("INVALID_ARGUMENT", "Gateway returned invalid JSON."); }
}
function supportedSnapshot(bytes: Buffer): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let bundle: Record<string, unknown>;
  try { bundle = JSON.parse(text); } catch { transportError("UNSUPPORTED", "Only original open JSON snapshots are supported; archives are unsupported."); }
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) transportError("INVALID_ARGUMENT", "Invalid snapshot bundle.");
  for (const key of ["packages", "prompts", "scripts", "servers", "recipes", "archive"]) {
    if (bundle[key] !== undefined && (!Array.isArray(bundle[key]) || (bundle[key] as unknown[]).length)) transportError("UNSUPPORTED", "Snapshot content kind is unsupported; no archive/package extraction is fabricated.");
  }
  return text;
}

/** Host-only service: no operation registration, automatic network, default broker, or private database. */
export class SubscriptionTransportHost {
  private readonly endpoint;
  private readonly staging: SubscriptionTransportStaging;
  private readonly now;
  constructor(private readonly options: SubscriptionTransportHostOptions) {
    this.endpoint = options.endpoint ? Object.freeze({ ...options.endpoint, transferPorts: Object.freeze([...options.endpoint.transferPorts]) }) : undefined;
    if (this.endpoint) transportEndpoint(this.endpoint);
    this.staging = new SubscriptionTransportStaging(options.stagingRoot);
    this.now = options.now ?? Date.now;
  }
  /** MQTT is a bounded routing hint, never a source pin, authorization result, proof or apply request. */
  notificationHint(topic: string, payload: Uint8Array, source: SubscriptionMaterializeInput["source"]): boolean {
    if (payload.byteLength > 65_536 || topic !== `pkm/v1/nodes/${source.nodeId}/shares/${source.shareId}/summary`) return false;
    try {
      const value = JSON.parse(Buffer.from(payload).toString("utf8"));
      return value?.shareId === source.shareId && Number.isSafeInteger(value?.revision) && value.revision > source.revision;
    } catch { return false; }
  }
  async run(value: unknown, externalSignal?: AbortSignal): Promise<SubscriptionTransportReceipt> {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) transportError("INVALID_ARGUMENT", "Invalid subscription transport request.");
    const request = parsed.data;
    if (!this.endpoint) transportError("UNSUPPORTED", "Subscription transport is disabled until a host endpoint is explicitly configured.");
    const deadline = Date.parse(request.expiresAt);
    if (deadline <= this.now() || deadline - this.now() > 120_000) transportError("ACCESS_DENIED", "Transport capability expired or exceeds maximum lifetime.");
    const timeout = AbortSignal.timeout(Math.max(1, deadline - this.now()));
    const cleanup = new AbortController();
    const signal = AbortSignal.any([cleanup.signal, timeout, ...(externalSignal ? [externalSignal] : [])]);
    const nativeRevision = await this.options.authorize(Object.freeze({ ...request.source }), request.mode);
    if (typeof nativeRevision !== "string" || !nativeRevision || nativeRevision.length > 1024) transportError("ACCESS_DENIED", "Native source authorization is required.");
    signal.throwIfAborted();
    const intent = JSON.stringify({ kind: "subscription-transport/v1", bindingId: this.endpoint.bindingId, request, nativeRevision });
    const runnerId = randomUUID();
    let state = await this.options.store.runExclusive(request.operationId, async tx => {
      const prior = await tx.load();
      if (prior && prior.intent !== intent) transportError("RECOVERY_CONFLICT", "Transport retry source, arguments or native authorization changed.");
      if (prior?.phase === "cancelled" || prior?.phase === "expired") transportError("ACCESS_DENIED", "Transport operation is terminal.");
      if (prior?.runnerId && prior.leaseUntil > this.now()) transportError("CONFLICT", "Transport operation has an active runner.");
      const next: SubscriptionTransferState = prior
        ? { ...prior, revision: prior.revision + 1, runnerId, leaseUntil: Math.min(deadline, this.now() + 15_000) }
        : { revision: 0, intent, phase: "intent", receipt: null, runnerId, leaseUntil: Math.min(deadline, this.now() + 15_000), verifiedBytes: null };
      if (prior) { if (!await tx.compareAndSwap(prior.revision, next)) transportError("CONFLICT", "Transport claim CAS failed."); }
      else await tx.create(next);
      return next;
    });
    const update = async (phase: SubscriptionTransferPhase, extra: Partial<SubscriptionTransferState> = {}) => {
      state = await this.options.store.runExclusive(request.operationId, async tx => {
        const current = await tx.load();
        if (!current || current.revision !== state.revision || current.runnerId !== runnerId || current.intent !== intent) transportError("RECOVERY_CONFLICT", "Transport runner lost its durable intent.");
        const next = { ...current, ...extra, phase, revision: current.revision + 1,
          leaseUntil: extra.runnerId === null ? 0 : Math.min(deadline, this.now() + 15_000) };
        if (!await tx.compareAndSwap(current.revision, next)) transportError("RECOVERY_CONFLICT", "Transport state CAS failed.");
        return next;
      });
    };
    const fence = async () => {
      signal.throwIfAborted();
      if (this.now() >= deadline) transportError("ACCESS_DENIED", "Transport capability expired.");
      const revision = await this.options.authorize(Object.freeze({ ...request.source }), request.mode);
      signal.throwIfAborted();
      if (this.now() >= deadline || revision !== nativeRevision) transportError("ACCESS_DENIED", "Source ACL/identity changed during transfer.");
      await this.options.store.runExclusive(request.operationId, async tx => {
        const current = await tx.load();
        if (!current || current.runnerId !== runnerId || current.revision !== state.revision || current.intent !== intent) transportError("RECOVERY_CONFLICT", "Transport runner was superseded.");
        if (current.leaseUntil - this.now() < 5000) {
          const renewed = { ...current, revision: current.revision + 1, leaseUntil: Math.min(deadline, this.now() + 15_000) };
          if (!await tx.compareAndSwap(current.revision, renewed)) transportError("RECOVERY_CONFLICT", "Transport lease CAS failed.");
          state = renewed;
        }
      });
      signal.throwIfAborted();
      if (this.now() >= deadline) transportError("ACCESS_DENIED", "Transport capability expired during authorization.");
    };
    const fetch = this.options.fetch ?? subscriptionTransportSocketFetch;
    const subscriberHeaders = async () => {
      const credentials = await this.options.secrets.resolve(this.endpoint!.secretRef, request.source.shareId);
      await fence();
      if (!credentials.subscriberProof || credentials.subscriberProof.length > 16_384 || /[\r\n]/.test(credentials.subscriberProof)) transportError("ACCESS_DENIED", "Invalid host-issued subscriber proof.");
      return { "X-PKM-Subscriber-Proof": credentials.subscriberProof };
    };
    const fetchSource = async () => {
      const summaryURL = new URL(`/v1/shares/${encodeURIComponent(request.source.shareId)}/summary`, transportEndpoint(this.endpoint!));
      const summary = signedTransportSummary(await responseBytes(await fetch(summaryURL, "GET", await subscriberHeaders(), signal, this.endpoint!.connectAddress), 65_536, signal),
        this.endpoint!.publisherPublicKey, request.source.nodeId, request.source.shareId);
      await fence();
      if (summary.revision !== request.source.revision || summary.collectionHash !== request.source.collectionHash || summary.name !== request.source.brokerName) transportError("REVISION_CONFLICT", "Publisher source version changed.");
      return summary;
    };
    try {
      await fence();
      if (state.phase === "complete") {
        if (!state.receipt) transportError("RECOVERY_CONFLICT", "Missing transport receipt.");
        const expectedReceipt = {
          kind: "subscription-transport/v1", operationId: request.operationId, mode: request.mode, source: request.source,
          snapshotSha256: request.source.collectionHash.slice(7), bytes: state.verifiedBytes,
          readOnly: request.mode === "readonly-mirror", apply: state.receipt.apply,
        };
        if (JSON.stringify(state.receipt) !== JSON.stringify(expectedReceipt)
          || request.mode === "readonly-mirror" && state.receipt.apply !== null) transportError("RECOVERY_CONFLICT", "Transport receipt does not match its immutable intent.");
        this.staging.verified(request.operationId, request.source.collectionHash, state.receipt.bytes);
        if (request.mode === "fork") {
          const recovered = await this.options.applyHost.recover(request.operationId);
          if (JSON.stringify(recovered) !== JSON.stringify(state.receipt.apply)) transportError("RECOVERY_CONFLICT", "Transport and apply receipts differ.");
        }
        await fence();
        return state.receipt;
      }
      if (state.phase === "intent" || state.phase === "downloading") {
        await update("downloading");
        const endpoint = transportEndpoint(this.endpoint);
        const summary = await fetchSource();
        const ticketURL = new URL(`/v1/shares/${encodeURIComponent(request.source.shareId)}/sync-ticket`, endpoint);
        const ticket = transportTicketSchema.safeParse(await responseBytes(await fetch(ticketURL, "POST", await subscriberHeaders(), signal, this.endpoint.connectAddress), 8192, signal));
        await fence();
        if (!ticket.success) transportError("INVALID_ARGUMENT", "Invalid gateway transfer ticket.");
        if (ticket.data.revision !== summary.revision || ticket.data.collectionHash !== summary.collectionHash) transportError("REVISION_CONFLICT", "Gateway changed revision before transfer.");
        const ticketDeadline = Date.parse(ticket.data.expiresAt);
        if (ticketDeadline <= this.now() || ticketDeadline - this.now() > 120_000) transportError("ACCESS_DENIED", "Expired or excessive transfer ticket.");
        const broker = transportBroker(ticket.data.brokerUrl, this.endpoint);
        const transferSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, ticketDeadline - this.now()))]);
        const response = await fetch(broker, "GET", { Authorization: `Bearer ${ticket.data.ticket}` }, transferSignal, this.endpoint.connectAddress);
        await fence();
        if (response.status !== 200 || response.headers["content-type"]?.split(";")[0] !== "application/json"
          || response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity"
          || Number(response.headers["content-length"]) !== summary.snapshotBytes) transportError("UNSUPPORTED", "Unsupported or inconsistent snapshot wire format.");
        const bytes = await this.staging.receive(request.operationId, response.body, summary.snapshotBytes, summary.collectionHash, async () => {
          transferSignal.throwIfAborted();
          await fence();
        });
        await fence();
        await update("verified", { verifiedBytes: bytes });
      }
      if (state.verifiedBytes === null) transportError("RECOVERY_CONFLICT", "Verified byte count is missing.");
      const bytes = this.staging.verified(request.operationId, request.source.collectionHash, state.verifiedBytes);
      // A fresh authorized source fetch after download (including durable resume) is mandatory before local writes.
      const currentSource = await fetchSource();
      if (currentSource.snapshotBytes !== bytes.length) transportError("REVISION_CONFLICT", "Publisher snapshot size changed.");
      const input: SubscriptionMaterializeInput = { source: request.source, area: request.area, paths: request.paths, snapshot: supportedSnapshot(bytes) };
      // Native application/preview executes original bounded Markdown/assets parsing.
      await this.options.applyHost.assertAuthorized(input);
      await fence();
      let apply = null;
      if (request.mode === "fork") {
        if (state.phase === "applying") {
          // Unknown application outcome must consult the local durable apply intent, never replay fetch/apply.
          apply = await this.options.applyHost.recover(request.operationId, () => signal.throwIfAborted());
        } else {
          const preview = await this.options.applyHost.preview(input);
          await fence();
          await update("applying");
          await fence();
          apply = await this.options.applyHost.apply(input, request.operationId, preview.workspaceRevision, () => {
            signal.throwIfAborted();
            if (this.now() >= deadline) transportError("ACCESS_DENIED", "Transport capability expired before application.");
          });
        }
      } else {
        await this.options.applyHost.preview(input);
      }
      await fence();
      const receipt: SubscriptionTransportReceipt = { kind: "subscription-transport/v1", operationId: request.operationId,
        mode: request.mode, source: request.source, snapshotSha256: transportHash(bytes), bytes: bytes.length,
        readOnly: request.mode === "readonly-mirror", apply };
      await update("complete", { receipt });
      return receipt;
    } catch (error) {
      if ((signal.aborted || this.now() >= deadline) && state.phase !== "applying") {
        await update(this.now() >= deadline ? "expired" : "cancelled");
      }
      throw error;
    } finally {
      cleanup.abort();
      await update(state.phase, { runnerId: null, leaseUntil: 0 });
    }
  }
  /** Host-only readonly cache access; reauthorization on every read, no writable knowledge registration. */
  async readMirror(request: SubscriptionTransportRequest): Promise<Buffer> {
    if (request.mode !== "readonly-mirror") transportError("ACCESS_DENIED", "This request is not a readonly subscription mirror.");
    const receipt = await this.run(request);
    if (!receipt.readOnly) transportError("ACCESS_DENIED", "This receipt is not a readonly subscription mirror.");
    return this.staging.verified(request.operationId, request.source.collectionHash, receipt.bytes);
  }
}
