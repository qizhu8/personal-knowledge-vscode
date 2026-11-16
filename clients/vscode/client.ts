import { operations, type OperationInput, type OperationKey } from "./contracts.ts";
import { publicName } from "../../src/public-identity.ts";
import {
  managerProgressOverviewSchema, managerProgressEventsResponseSchema, managerProgressFeedbackReceiptSchema,
  type ManagerProgressOverview, type ManagerProgressEvent, type ManagerProgressEventsResponse,
  type ManagerProgressFeedbackReceipt,
} from "../../src/domain/manager-progress.ts";
import type { ManagerRun } from "../../src/manager-runtime.js";
import { managerPlanTaskSchema, managerPlanBudgetSchema } from "../../src/domain/manager-plan-contracts.ts";
import { z } from "zod";

export type { ManagerRun };

const managerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const managerPin = z.string().regex(/^[a-f0-9]{64}$/);
const managerNumber = z.number().int().safe().nonnegative();
const managerEffect = z.strictObject({ id: managerId, kind: z.string().min(1).max(80), leaseUntil: managerNumber });
const managerDelivery = z.strictObject({
  artifact: z.string().min(1).max(1024), pin: managerPin, workerId: managerId,
  paths: z.array(z.string().min(1).max(512)).max(100),
});
const managerRunResponseSchema = z.object({
  schema: z.literal("pkm.manager.runtime/v1"), runId: managerId, projectId: managerId,
  version: managerNumber.positive(), state: z.enum(["active", "succeeded", "paused", "cancelled", "unknown", "failed"]),
  phase: z.string().min(1).max(80), contract: z.unknown(), budget: managerPlanBudgetSchema,
  plan: z.unknown(), planHash: managerPin.nullable(),
  tasks: z.array(z.object({
    definition: managerPlanTaskSchema, definitionHash: managerPin, state: z.string().min(1).max(40),
    owner: z.string().min(1).max(160).nullable(),
    attempts: z.array(z.object({
      attemptId: managerId, number: managerNumber.positive(), state: z.string().min(1).max(40),
      effect: managerEffect, effects: z.array(managerEffect), delivery: managerDelivery.optional(),
      publications: z.array(managerDelivery).max(100).optional(), reason: z.string().optional(),
    }).passthrough()).max(100), repairReason: z.string().optional(),
  }).passthrough()).max(1024),
  checks: z.array(z.strictObject({
    kind: z.string().min(1).max(40),
    result: z.strictObject({ ok: z.boolean(), reason: z.string().max(4096).optional(),
      taskId: managerId.optional(), pin: managerPin.optional() }),
    pin: managerPin.optional(),
  })).max(2048),
  feedback: z.array(z.strictObject({
    id: z.string().uuid(), taskId: managerId.optional(), message: z.string().max(8192),
    urgent: z.boolean(), state: z.enum(["queued", "delivered"]),
  })).max(10000),
  effect: managerEffect.nullable(), freeze: managerPin.nullable(), integration: managerPin.nullable(),
  lastSequence: managerNumber, createdAt: managerNumber, updatedAt: managerNumber,
  reason: z.string().nullable(), lastHeartbeatAt: managerNumber.optional(),
}).passthrough();

export interface ServerBinding {
  serverId: typeof publicName;
  workspaceId: string;
  actorId: string;
  protocolVersion: "v1";
}
export interface Host {
  secrets: { get(key: string): Promise<string | undefined> };
  // Trusted host attests the endpoint and actor using its own process/session binding.
  attestServer(origin: string, info: Readonly<Record<string, unknown>>): Promise<ServerBinding>;
  fetch?: typeof fetch;
  onState?(state: ClientState): void;
  openHumanReview?(): Promise<void>;
}
export type ClientState = {
  status: "disconnected" | "connecting" | "connected" | "error" | "disposed";
  code?: string;
  capabilities: OperationKey[];
  pending: string[];
  workspaceId?: string;
};
export interface Document {
  id: string; title: string; content: string; revision: number; sha256: string;
  deleted: boolean; path?: string; area?: string;
}
export interface DocumentPage {
  items: Omit<Document, "content">[]; total: number; nextOffset: number | null; workspaceRevision: string;
}
export interface ChatTurn {
  schema: "pkm.chat.turn/v1"; id: string; sessionId: string; revision: number;
  status: string; output: string; lastSequence: number;
}
export interface ChatEvent { sequence: number; type: string; data: Record<string, unknown>; }
export type ManagerOverview = ManagerProgressOverview;
export type ManagerEvent = ManagerProgressEvent;
export type ManagerPage = ManagerProgressEventsResponse;
export type ManagerFeedbackReceipt = ManagerProgressFeedbackReceipt;
export class ClientError extends Error {
  code: string;
  effect: "unknown" | "not-committed";
  constructor(code: string, effect: "unknown" | "not-committed" = "not-committed") {
    super(code); this.name = "ClientError"; this.code = code; this.effect = effect;
  }
}
type Pending = { key: OperationKey; body: string; binding: string };
const validId = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class VscodeClient {
  private host: Host;
  private origin: string;
  #token = "";
  private status: ClientState["status"] = "disconnected";
  private code: string | undefined;
  private available = new Set<OperationKey>();
  private pending = new Map<string, Pending>();
  private inFlight = new Set<string>();
  private controllers = new Set<AbortController>();
  private generation = 0;
  private binding: ServerBinding | undefined;
  private timeoutMs: number;
  constructor(host: Host, options: { origin: string; secretKey: string; expectedWorkspaceId: string; timeoutMs?: number }) {
    const url = new URL(options.origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) throw new ClientError("UNSAFE_ORIGIN");
    if (!validId(options.secretKey) || !validId(options.expectedWorkspaceId)) throw new ClientError("INVALID_HOST_CONFIGURATION");
    this.host = host; this.origin = url.origin; this.secretKey = options.secretKey;
    this.expectedWorkspaceId = options.expectedWorkspaceId;
    this.timeoutMs = options.timeoutMs ?? 12000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120000) throw new ClientError("INVALID_HOST_CONFIGURATION");
  }
  private secretKey: string;
  private expectedWorkspaceId: string;
  private emit() { try { this.host.onState?.(this.state()); } catch { /* Observers cannot change transport outcomes. */ } }
  state(): ClientState {
    return { status: this.status, ...(this.code ? { code: this.code } : {}),
      capabilities: [...this.available], pending: [...this.pending.keys()],
      ...(this.binding ? { workspaceId: this.binding.workspaceId } : {}) };
  }
  async connect(): Promise<ClientState> {
    if (this.status === "disposed") throw new ClientError("DISPOSED");
    this.disconnect();
    const generation = this.generation;
    this.status = "connecting"; this.emit();
    try {
      const token = await this.host.secrets.get(this.secretKey);
      if (generation !== this.generation) throw new ClientError("REQUEST_ABORTED");
      if (!token || token.length < 32 || /[\r\n]/.test(token)) throw new ClientError("AUTHENTICATION_REQUIRED");
      this.#token = token;
      const info = await this.request("server_info", "{}", false);
      if (info.name !== publicName || info.serverId !== publicName || !validId(info.workspaceId) || !validId(info.actorId) ||
          info.workspaceVersion !== "pkm.next-workspace/v2" || info.protocolVersion !== "v1" ||
          !isRecord(info.storage) || info.storage.workspaceSchema !== "pkm.next-workspace/v2" ||
          info.storage.authority !== "Markdown" || !validId(info.catalogRevision) ||
          (info.protocolVersion !== undefined && info.protocolVersion !== "v1")) throw new ClientError("INCOMPATIBLE_SERVER");
      const binding = await this.host.attestServer(this.origin, info);
      if (generation !== this.generation) throw new ClientError("REQUEST_ABORTED");
      if (!binding || binding.serverId !== publicName || binding.workspaceId !== this.expectedWorkspaceId ||
          binding.workspaceId !== info.workspaceId || binding.actorId !== info.actorId ||
          !validId(binding.actorId) || binding.protocolVersion !== "v1")
        throw new ClientError("WORKSPACE_BINDING_MISMATCH");
      this.binding = { ...binding };
      for (const key of Object.keys(operations) as OperationKey[]) {
        const definition = operations[key];
        try {
          const desc = await this.request("capabilities_describe", JSON.stringify({ operation: definition.operation }), false);
          if (desc.operation !== definition.operation || desc.version !== 1 || desc.readOnly !== definition.readOnly ||
              desc.catalogRevision !== info.catalogRevision) throw new ClientError("INCOMPATIBLE_CAPABILITY");
          this.available.add(key);
        } catch (error) {
          if (!(error instanceof ClientError) || !["NOT_FOUND", "NOT_AVAILABLE", "ACCESS_DENIED"].includes(error.code)) throw error;
        }
      }
      if (generation !== this.generation) throw new ClientError("REQUEST_ABORTED");
      this.status = "connected"; this.code = undefined; this.emit(); return this.state();
    } catch (error) {
      if (generation === this.generation) {
        this.#token = ""; this.binding = undefined; this.available.clear(); this.status = "error";
        this.code = error instanceof ClientError ? error.code : "CONNECTION_FAILED"; this.emit();
      }
      throw error;
    }
  }
  disconnect(): void {
    if (this.status === "disposed") return;
    this.generation++; this.#token = ""; this.available.clear(); this.binding = undefined;
    for (const controller of this.controllers) controller.abort();
    this.status = "disconnected"; this.code = undefined; this.emit();
  }
  dispose(): void {
    if (this.status === "disposed") return;
    this.disconnect(); this.pending.clear(); this.status = "disposed"; this.emit();
  }
  async openHumanReview(): Promise<void> {
    if (!this.host.openHumanReview) throw new ClientError("HUMAN_REVIEW_UNAVAILABLE");
    if (this.status !== "connected") throw new ClientError("NOT_CONNECTED");
    await this.host.openHumanReview();
  }
  private bindingKey(): string {
    if (!this.binding) throw new ClientError("NOT_CONNECTED");
    return JSON.stringify([this.origin, this.binding.serverId, this.binding.workspaceId, this.binding.actorId]);
  }
  private async invoke<K extends OperationKey>(key: K, input: OperationInput<K>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.status !== "connected") throw new ClientError("NOT_CONNECTED");
    if (!this.available.has(key)) throw new ClientError("CAPABILITY_UNAVAILABLE");
    const definition = operations[key];
    const parsed = definition.input.safeParse(input);
    if (!parsed.success) throw new ClientError("INVALID_ARGUMENT");
    const body = JSON.stringify({ operation: definition.operation, version: 1, arguments: parsed.data });
    const mutationId = definition.readOnly ? undefined : (parsed.data as { operationId: string }).operationId;
    if (mutationId && (this.pending.has(mutationId) || [...this.pending.values()].some(p => p.key === key)))
      throw new ClientError("PENDING_OUTCOME_UNKNOWN", "unknown");
    if (mutationId) { this.pending.set(mutationId, { key, body, binding: this.bindingKey() }); this.inFlight.add(mutationId); this.emit(); }
    try {
      const result = await this.request(definition.readOnly ? "capability_read" : "capability_call", body, !definition.readOnly, signal);
      this.validateManagerResult(key, result, parsed.data);
      if (mutationId) this.pending.delete(mutationId);
      return result;
    } catch (error) {
      if (mutationId && error instanceof ClientError && error.effect !== "unknown") this.pending.delete(mutationId);
      this.code = error instanceof ClientError ? error.code : "TRANSPORT_ERROR"; this.emit();
      throw error;
    } finally { if (mutationId) { this.inFlight.delete(mutationId); this.emit(); } }
  }
  async retryMutation(operationId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const pending = this.pending.get(operationId);
    if (!pending || this.inFlight.has(operationId)) throw new ClientError("NO_RETRYABLE_OPERATION");
    if (this.status !== "connected" || pending.binding !== this.bindingKey() || !this.available.has(pending.key))
      throw new ClientError("RETRY_BINDING_MISMATCH");
    this.inFlight.add(operationId);
    try {
      const result = await this.request("capability_call", pending.body, true, signal);
      this.validateManagerResult(pending.key, result, JSON.parse(pending.body).arguments);
      this.pending.delete(operationId); return result;
    } catch (error) {
      this.code = error instanceof ClientError ? error.code : "TRANSPORT_ERROR";
      throw error;
    } finally { this.inFlight.delete(operationId); this.emit(); }
  }
  private async request(method: string, body: string, mutation: boolean, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.#token) throw new ClientError("NOT_CONNECTED");
    const generation = this.generation;
    if (new TextEncoder().encode(body).length > 131072) throw new ClientError("REQUEST_TOO_LARGE");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.controllers.add(controller);
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      const response = await (this.host.fetch ?? globalThis.fetch)(`${this.origin}/v1/${method}`, {
        method: "POST", redirect: "error", cache: "no-store",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#token}` },
        body, signal: controller.signal,
      });
      if (!response.headers.get("content-type")?.startsWith("application/json")) throw new Error("invalid response");
      const text = await response.text();
      if (generation !== this.generation || controller.signal.aborted) throw new Error("request aborted");
      if (text.length > 1048576) throw new Error("response too large");
      const envelope: unknown = JSON.parse(text);
      if (!isRecord(envelope) || envelope.schema !== "pkm.next-result/v1" || !validId(envelope.requestId) ||
          Boolean(envelope.result) === Boolean(envelope.error)) throw new Error("invalid envelope");
      if (isRecord(envelope.error)) {
        const code = typeof envelope.error.code === "string" && /^[A-Z_]{1,64}$/.test(envelope.error.code) ? envelope.error.code : "SERVER_ERROR";
        const effect = envelope.error.effect === "not-committed" ? "not-committed" : mutation ? "unknown" : "not-committed";
        throw new ClientError(code, effect);
      }
      if (!response.ok || !isRecord(envelope.result)) throw new Error("invalid result");
      return envelope.result;
    } catch (error) {
      if (error instanceof ClientError) throw error;
      throw new ClientError(controller.signal.aborted ? "REQUEST_ABORTED" : "TRANSPORT_ERROR", mutation ? "unknown" : "not-committed");
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); this.controllers.delete(controller);
    }
  }
  knowledgeList(input: OperationInput<"knowledgeList"> = {}, signal?: AbortSignal) { return this.invoke("knowledgeList", input, signal) as unknown as Promise<DocumentPage>; }
  knowledgeGet(input: OperationInput<"knowledgeGet">, signal?: AbortSignal) { return this.invoke("knowledgeGet", input, signal) as unknown as Promise<Document>; }
  knowledgeEdit(input: OperationInput<"knowledgeEdit">, signal?: AbortSignal) { return this.invoke("knowledgeEdit", input, signal) as unknown as Promise<Document>; }
  chatList(input: OperationInput<"chatList"> = {}, signal?: AbortSignal) { return this.invoke("chatList", input, signal); }
  chatCreate(input: OperationInput<"chatCreate">, signal?: AbortSignal) { return this.invoke("chatCreate", input, signal); }
  chatGet(input: OperationInput<"chatGet">, signal?: AbortSignal) { return this.invoke("chatGet", input, signal); }
  chatMessages(input: OperationInput<"chatMessages">, signal?: AbortSignal) { return this.invoke("chatMessages", input, signal); }
  chatStart(input: OperationInput<"chatStart">, signal?: AbortSignal) { return this.invoke("chatStart", input, signal) as unknown as Promise<ChatTurn>; }
  chatTurn(input: OperationInput<"chatTurn">, signal?: AbortSignal) { return this.invoke("chatTurn", input, signal) as unknown as Promise<ChatTurn>; }
  chatEvents(input: OperationInput<"chatEvents">, signal?: AbortSignal) { return this.invoke("chatEvents", input, signal) as unknown as Promise<{ events: ChatEvent[]; next: number | null }>; }
  chatCancel(input: OperationInput<"chatCancel">, signal?: AbortSignal) { return this.invoke("chatCancel", input, signal) as unknown as Promise<ChatTurn>; }
  private managerResponse<T extends { runId: string }>(schema: z.ZodType<T>, value: unknown, runId: string): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success || parsed.data.runId !== runId) throw new ClientError("INVALID_MANAGER_RESPONSE");
    return parsed.data;
  }
  private managerRun(value: Record<string, unknown>, runId: string): ManagerRun {
    // The native runtime catalog intentionally has a JSON output, not a public run schema.
    const parsed = managerRunResponseSchema.safeParse(value);
    if (!parsed.success || parsed.data.runId !== runId)
      throw new ClientError("INVALID_MANAGER_RESPONSE");
    return parsed.data as ManagerRun;
  }
  private validateManagerResult(key: OperationKey, result: Record<string, unknown>, input: unknown): void {
    if (!key.startsWith("manager")) return;
    const runId = (input as { runId: string }).runId;
    try {
      if (key === "managerOverview") this.managerResponse(managerProgressOverviewSchema, result, runId);
      else if (key === "managerEvents") this.managerResponse(managerProgressEventsResponseSchema, result, runId);
      else if (key === "managerFeedback") this.managerResponse(managerProgressFeedbackReceiptSchema, result, runId);
      else this.managerRun(result, runId);
    } catch {
      throw new ClientError("INVALID_MANAGER_RESPONSE", operations[key].readOnly ? "not-committed" : "unknown");
    }
  }
  async managerStart(input: OperationInput<"managerStart">, signal?: AbortSignal): Promise<ManagerRun> {
    return this.managerRun(await this.invoke("managerStart", input, signal), input.runId);
  }
  async managerGet(input: OperationInput<"managerGet">, signal?: AbortSignal): Promise<ManagerRun> {
    return this.managerRun(await this.invoke("managerGet", input, signal), input.runId);
  }
  async managerOverview(input: OperationInput<"managerOverview">, signal?: AbortSignal): Promise<ManagerOverview> {
    return this.managerResponse(managerProgressOverviewSchema, await this.invoke("managerOverview", input, signal), input.runId);
  }
  async managerEvents(input: OperationInput<"managerEvents">, signal?: AbortSignal): Promise<ManagerPage> {
    return this.managerResponse(managerProgressEventsResponseSchema, await this.invoke("managerEvents", input, signal), input.runId);
  }
  async managerFeedback(input: OperationInput<"managerFeedback">, signal?: AbortSignal): Promise<ManagerFeedbackReceipt> {
    return this.managerResponse(managerProgressFeedbackReceiptSchema, await this.invoke("managerFeedback", input, signal), input.runId);
  }
  async managerCancel(input: OperationInput<"managerCancel">, signal?: AbortSignal): Promise<ManagerRun> {
    return this.managerRun(await this.invoke("managerCancel", input, signal), input.runId);
  }
}
