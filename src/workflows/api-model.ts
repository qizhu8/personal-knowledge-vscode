import { createHash } from "crypto";
import { canonicalJson } from "../workflow-contracts";

export const WORKFLOW_REQUEST_SCHEMA = "pkm.workflow.request/v1" as const;
export const WORKFLOW_RESPONSE_SCHEMA = "pkm.workflow.response/v1" as const;
export const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
export const DEFAULT_MAX_PAGE_SIZE = 100;

export type OperationKind = "query" | "mutation" | "long";

export interface OperationDescriptor {
  readonly operationId: string;
  readonly operationMajor: number;
  readonly kind: OperationKind;
  readonly requiredCapabilities: readonly string[];
  readonly protectedVersions: readonly string[];
  readonly description: string;
}

function operation(operationId: string, kind: OperationKind, description: string, protectedVersions: readonly string[] = [], requiredCapabilities: readonly string[] = []): OperationDescriptor {
  return Object.freeze({ operationId, operationMajor: 1, kind, requiredCapabilities: Object.freeze([...requiredCapabilities]), protectedVersions: Object.freeze([...protectedVersions]), description });
}

export const WORKFLOW_OPERATION_REGISTRY: readonly OperationDescriptor[] = Object.freeze([
  operation("capability.negotiate", "query", "Negotiate supported workflow capabilities."),
  operation("definition.publish", "mutation", "Publish an immutable workflow definition.", ["definition"], ["definition"]),
  operation("run.create", "mutation", "Create a workflow run.", ["definition"], ["definition"]),
  operation("run.get", "query", "Get a workflow run."),
  operation("run.control", "mutation", "Pause, resume, or cancel a run.", ["run"], ["run"]),
  operation("assignment.offer", "mutation", "Offer an assignment.", ["assignment"], ["assignment"]),
  operation("assignment.claim", "mutation", "Claim an assignment.", ["assignment"], ["assignment"]),
  operation("assignment.decline", "mutation", "Decline an assignment.", ["assignment"], ["assignment"]),
  operation("lease.heartbeat", "mutation", "Report lease liveness.", ["lease"], ["lease"]),
  operation("lease.renew", "mutation", "Renew a lease.", ["lease"], ["lease"]),
  operation("lease.release", "mutation", "Release a lease.", ["lease"], ["lease"]),
  operation("evidence.register", "mutation", "Register immutable evidence.", ["run"], ["run"]),
  operation("evidence.get", "query", "Get authorized evidence."),
  operation("gate.decide", "mutation", "Record a gate decision.", ["gate"], ["gate"]),
  operation("archive", "long", "Archive a workflow object and descendants.", ["target"], ["target"]),
  operation("migration", "long", "Migrate workflow state.", ["target"], ["target"]),
  operation("repair", "long", "Repair workflow state.", ["target"], ["target"]),
  operation("operation.get", "query", "Get a retained long operation."),
  operation("operation.wait", "query", "Wait for a retained long operation."),
  operation("operation.cancel", "mutation", "Request cancellation of a long operation.", ["operation"], ["operation"]),
  operation("events.list", "query", "Read an authorized event stream page.")
]);

const REGISTRY = new Map(WORKFLOW_OPERATION_REGISTRY.map(descriptor => [`${descriptor.operationId}@${descriptor.operationMajor}`, descriptor]));

export interface WorkflowActor { readonly actorId: string; readonly roles: readonly string[]; }
export interface WorkflowClient { readonly clientId: string; readonly version: string; readonly capabilities: readonly string[]; }
export interface WorkflowScope { readonly rootId: string; readonly projectScopeId: string; }
export interface CapabilityGrant { readonly grantId: string; readonly version: number; readonly capabilities: readonly string[]; }
export interface Pagination { readonly limit: number; readonly cursor?: string; }

export interface WorkflowRequestEnvelope {
  readonly schema: typeof WORKFLOW_REQUEST_SCHEMA;
  readonly requestId: string;
  readonly operationId: string;
  readonly operationMajor: number;
  readonly actor: WorkflowActor;
  readonly client: WorkflowClient;
  readonly scope: WorkflowScope;
  readonly parameters: unknown;
  readonly referencedObjectDigests?: Readonly<Record<string, string>>;
  readonly expectedVersions?: Readonly<Record<string, number>>;
  readonly capabilityGrants?: readonly CapabilityGrant[];
  readonly commandId?: string;
  readonly pagination?: Pagination;
  readonly trace?: unknown;
  readonly deadline?: string;
  readonly bearer?: string;
}

export interface RedactionSummary { readonly redactedCount: number; readonly reasons: readonly string[]; }
export interface WorkflowApiErrorBody { readonly code: string; readonly message: string; readonly retryable: boolean; readonly details: Readonly<Record<string, unknown>>; }
export interface WorkflowResponseEnvelope {
  readonly schema: typeof WORKFLOW_RESPONSE_SCHEMA;
  readonly requestId: string;
  readonly operationId: string;
  readonly operationMajor: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: WorkflowApiErrorBody;
  readonly redactionSummary: RedactionSummary;
  readonly replayed: boolean;
}

export interface WorkflowEvent { readonly sequence: number; readonly resourceId: string; readonly payload: unknown; }
export interface EventPage { readonly events: readonly WorkflowEvent[]; readonly nextCursor?: string; }
export type LongOperationState = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export interface LongOperationRecord {
  readonly operationRecordId: string;
  readonly creatorOperationId: string;
  readonly creatorOperationMajor: number;
  readonly state: LongOperationState;
  readonly retainedUntil: string;
  readonly result?: unknown;
}

export class WorkflowApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = "WorkflowApiError";
  }
}

export type WorkflowHandler = (request: WorkflowRequestEnvelope, context: Readonly<{ fingerprint: string; descriptor: OperationDescriptor }>) => unknown | Promise<unknown>;
export interface WorkflowApiHandlers { readonly [operationId: string]: WorkflowHandler | undefined; }
export interface WorkflowApiOptions {
  readonly handlers: WorkflowApiHandlers;
  readonly supportedCapabilities: readonly string[];
  readonly authEpoch: () => number;
  readonly authorizeEvent: (actor: WorkflowActor, scope: WorkflowScope, event: WorkflowEvent) => boolean;
  readonly maxPayloadBytes?: number;
  readonly maxPageSize?: number;
  readonly now?: () => Date;
}

export interface WorkflowDispatcher {
  dispatch(request: WorkflowRequestEnvelope): Promise<WorkflowResponseEnvelope>;
  deprecate(operationId: string, operationMajor: number): void;
  putOperation(record: LongOperationRecord): void;
}

interface Receipt { readonly fingerprint: string; readonly response: WorkflowResponseEnvelope; }

export function requestFingerprint(request: WorkflowRequestEnvelope): string {
  const canonical = {
    operationId: request.operationId,
    operationMajor: request.operationMajor,
    rootId: request.scope.rootId,
    projectScopeId: request.scope.projectScopeId,
    canonicalParameters: request.parameters,
    referencedObjectDigests: request.referencedObjectDigests || {},
    expectedVersions: request.expectedVersions || {},
    capabilityGrantIdsAndVersions: (request.capabilityGrants || [])
      .map(grant => ({ grantId: grant.grantId, version: grant.version }))
      .sort((left, right) => left.grantId.localeCompare(right.grantId) || left.version - right.version)
  };
  return createHash("sha256").update(canonicalJson(canonical)).digest("hex");
}

export function encodeEventCursor(authEpoch: number, afterSequence: number): string {
  if (!Number.isInteger(authEpoch) || authEpoch < 1 || !Number.isInteger(afterSequence) || afterSequence < 0) fail("cursor-invalid", "Event cursor values are invalid.");
  return Buffer.from(canonicalJson({ authEpoch, afterSequence }), "utf8").toString("base64url");
}

export function decodeEventCursor(value: string): Readonly<{ authEpoch: number; afterSequence: number }> {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (Object.keys(parsed).sort().join(",") !== "afterSequence,authEpoch" || !Number.isInteger(parsed.authEpoch) || (parsed.authEpoch as number) < 1 || !Number.isInteger(parsed.afterSequence) || (parsed.afterSequence as number) < 0) throw new Error("invalid");
    return { authEpoch: parsed.authEpoch as number, afterSequence: parsed.afterSequence as number };
  } catch {
    fail("cursor-invalid", "Event cursor is malformed.");
  }
}

export function negotiateCapabilities(requested: readonly string[], supported: readonly string[]): Readonly<{ accepted: readonly string[]; unavailable: readonly string[] }> {
  const available = new Set(supported);
  const unique = [...new Set(requested)].sort();
  return Object.freeze({ accepted: Object.freeze(unique.filter(value => available.has(value))), unavailable: Object.freeze(unique.filter(value => !available.has(value))) });
}

export function createWorkflowDispatcher(options: WorkflowApiOptions): WorkflowDispatcher {
  const receipts = new Map<string, Receipt>();
  const operations = new Map<string, LongOperationRecord>();
  const deprecated = new Set<string>();
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;

  return {
    async dispatch(request): Promise<WorkflowResponseEnvelope> {
      let descriptor: OperationDescriptor | undefined;
      let fingerprint = "";
      try {
        validateEnvelope(request, maxPayloadBytes, maxPageSize);
        descriptor = REGISTRY.get(`${request.operationId}@${request.operationMajor}`);
        if (!descriptor || deprecated.has(`${request.operationId}@${request.operationMajor}`)) fail("operation-not-found", "Operation is not registered.");
        fingerprint = requestFingerprint(request);
        if (descriptor.kind !== "query") {
          requireText(request.commandId, "command-required", "Mutations require commandId.");
          const prior = receipts.get(request.commandId!);
          if (prior) {
            if (prior.fingerprint !== fingerprint) fail("command-conflict", "commandId was used with a different request fingerprint.");
            return { ...prior.response, requestId: request.requestId, replayed: true };
          }
        }
        validateCapabilities(request, descriptor);
        validateExpectedVersions(request, descriptor);
        let result: unknown;
        let redactionSummary: RedactionSummary = Object.freeze({ redactedCount: 0, reasons: Object.freeze([]) });
        if (request.operationId === "capability.negotiate") {
          result = negotiateCapabilities(request.client.capabilities, options.supportedCapabilities);
        } else if (request.operationId === "operation.get" || request.operationId === "operation.wait") {
          result = getRetainedOperation(operations, request.parameters, options.now?.() || new Date());
        } else if (request.operationId === "operation.cancel") {
          const current = getRetainedOperation(operations, request.parameters, options.now?.() || new Date());
          result = isTerminal(current.state) ? current : { ...current, state: "cancelled" as const };
          operations.set(current.operationRecordId, result as LongOperationRecord);
        } else {
          const handler = options.handlers[request.operationId];
          if (!handler) fail("handler-unavailable", "No handler is available for the registered operation.", true);
          result = await handler(request, { fingerprint, descriptor });
          if (request.operationId === "events.list") {
            const delivered = deliverEvents(request, result, options.authEpoch(), options.authorizeEvent, maxPageSize);
            result = delivered.page;
            redactionSummary = delivered.redactionSummary;
          }
          if (descriptor.kind === "long") {
            validateLongOperation(result, descriptor);
            operations.set((result as LongOperationRecord).operationRecordId, result as LongOperationRecord);
          }
        }
        validatePayloadSize(result, maxPayloadBytes, "response");
        const response = success(request, result, redactionSummary);
        if (descriptor.kind !== "query") receipts.set(request.commandId!, { fingerprint, response });
        return response;
      } catch (error) {
        return failure(request, normalizeError(error));
      }
    },
    deprecate(operationId, operationMajor): void {
      deprecated.add(`${operationId}@${operationMajor}`);
    },
    putOperation(record): void {
      validateLongOperation(record);
      operations.set(record.operationRecordId, Object.freeze({ ...record }));
    }
  };
}

function validateEnvelope(request: WorkflowRequestEnvelope, maxPayloadBytes: number, maxPageSize: number): void {
  if (request.schema !== WORKFLOW_REQUEST_SCHEMA) fail("schema-unsupported", "Request schema is unsupported.");
  requireText(request.requestId, "request-invalid", "requestId is required.");
  requireText(request.operationId, "request-invalid", "operationId is required.");
  if (!Number.isInteger(request.operationMajor) || request.operationMajor < 1) fail("request-invalid", "operationMajor must be a positive integer.");
  requireText(request.actor?.actorId, "actor-invalid", "actorId is required.");
  requireText(request.client?.clientId, "client-invalid", "clientId is required.");
  requireText(request.client?.version, "client-invalid", "client version is required.");
  requireText(request.scope?.rootId, "scope-invalid", "rootId is required.");
  requireText(request.scope?.projectScopeId, "scope-invalid", "projectScopeId is required.");
  validatePayloadSize(request, maxPayloadBytes, "request");
  if (request.pagination && (!Number.isInteger(request.pagination.limit) || request.pagination.limit < 1 || request.pagination.limit > maxPageSize)) fail("pagination-invalid", "Page limit is out of bounds.", false, { maxPageSize });
}

function validatePayloadSize(value: unknown, maxPayloadBytes: number, direction: "request" | "response"): void {
  let bytes: number;
  try { bytes = Buffer.byteLength(canonicalJson(value), "utf8"); } catch { fail(direction === "request" ? "request-invalid" : "response-invalid", `${direction} must be canonical-JSON compatible.`); }
  if (bytes! > maxPayloadBytes) fail("payload-too-large", `${direction} exceeds the payload limit.`, false, { direction, maxPayloadBytes });
}

function validateCapabilities(request: WorkflowRequestEnvelope, descriptor: OperationDescriptor): void {
  const granted = new Set((request.capabilityGrants || []).flatMap(grant => grant.capabilities));
  const missing = descriptor.requiredCapabilities.filter(capability => !granted.has(capability));
  if (missing.length) fail("capability-required", "Required capabilities were not granted.", false, { missing });
}

function validateExpectedVersions(request: WorkflowRequestEnvelope, descriptor: OperationDescriptor): void {
  const expected = request.expectedVersions || {};
  const missing = descriptor.protectedVersions.filter(name => !Number.isInteger(expected[name]) || expected[name] < 0);
  if (missing.length) fail("expected-version-required", "Protected operation requires version-tuple CAS.", false, { missing });
}

function deliverEvents(request: WorkflowRequestEnvelope, value: unknown, authEpoch: number, authorize: WorkflowApiOptions["authorizeEvent"], maxPageSize: number): Readonly<{ page: EventPage; redactionSummary: RedactionSummary }> {
  const page = value as EventPage;
  if (!page || !Array.isArray(page.events)) fail("handler-contract", "Event handler must return an event page.");
  const cursor = request.pagination?.cursor ? decodeEventCursor(request.pagination.cursor) : { authEpoch, afterSequence: 0 };
  if (cursor.authEpoch !== authEpoch) fail("cursor-auth-epoch-stale", "Cursor authorization epoch is stale.");
  const limit = request.pagination?.limit ?? maxPageSize;
  const candidates = page.events.filter(event => event.sequence > cursor.afterSequence).slice(0, limit);
  const events = candidates.filter(event => authorize(request.actor, request.scope, event));
  const redactedCount = candidates.length - events.length;
  const afterSequence = candidates.length ? candidates[candidates.length - 1].sequence : cursor.afterSequence;
  return Object.freeze({
    page: Object.freeze({ events: Object.freeze(events), ...(candidates.length === limit ? { nextCursor: encodeEventCursor(authEpoch, afterSequence) } : {}) }),
    redactionSummary: Object.freeze({ redactedCount, reasons: Object.freeze(redactedCount ? ["not-authorized"] : []) })
  });
}

function getRetainedOperation(operations: Map<string, LongOperationRecord>, parameters: unknown, now: Date): LongOperationRecord {
  const operationRecordId = (parameters as { operationRecordId?: unknown })?.operationRecordId;
  if (typeof operationRecordId !== "string" || !operationRecordId) fail("operation-record-invalid", "operationRecordId is required.");
  const record = operations.get(operationRecordId);
  if (!record || Date.parse(record.retainedUntil) <= now.getTime()) fail("operation-record-not-found", "Operation record was not found.");
  return record;
}

function validateLongOperation(value: unknown, descriptor?: OperationDescriptor): asserts value is LongOperationRecord {
  const record = value as Partial<LongOperationRecord>;
  if (!record || typeof record !== "object" || typeof record.operationRecordId !== "string" || !record.operationRecordId || typeof record.retainedUntil !== "string" || Number.isNaN(Date.parse(record.retainedUntil)) || !isOperationState(record.state)) fail("handler-contract", "Long operation handler returned an invalid record.");
  if (descriptor && (record.creatorOperationId !== descriptor.operationId || record.creatorOperationMajor !== descriptor.operationMajor)) fail("handler-contract", "Long operation creator version does not match the request.");
}

function isOperationState(value: unknown): value is LongOperationState { return ["pending", "running", "succeeded", "failed", "cancelled"].includes(value as string); }
function isTerminal(value: LongOperationState): boolean { return value === "succeeded" || value === "failed" || value === "cancelled"; }

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<{ readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }>;
}

export function workflowMcpToolDescriptors(registry: readonly OperationDescriptor[] = WORKFLOW_OPERATION_REGISTRY): readonly McpToolDescriptor[] {
  return Object.freeze(registry.map(descriptor => Object.freeze({
    name: descriptor.operationId.replace(/\./g, "_"),
    description: descriptor.description,
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["schema", "requestId", "actor", "client", "scope", "parameters"]), additionalProperties: false }),
    annotations: Object.freeze({ readOnlyHint: descriptor.kind === "query", destructiveHint: descriptor.operationId === "archive" || descriptor.operationId === "operation.cancel", idempotentHint: true })
  })));
}

function success(request: WorkflowRequestEnvelope, result: unknown, redactionSummary: RedactionSummary): WorkflowResponseEnvelope {
  return Object.freeze({ schema: WORKFLOW_RESPONSE_SCHEMA, requestId: request.requestId, operationId: request.operationId, operationMajor: request.operationMajor, ok: true, result, redactionSummary, replayed: false });
}

function failure(request: WorkflowRequestEnvelope, error: WorkflowApiError): WorkflowResponseEnvelope {
  return Object.freeze({ schema: WORKFLOW_RESPONSE_SCHEMA, requestId: request?.requestId || "", operationId: request?.operationId || "", operationMajor: request?.operationMajor || 0, ok: false, error: Object.freeze({ code: error.code, message: error.message, retryable: error.retryable, details: error.details }), redactionSummary: Object.freeze({ redactedCount: 0, reasons: Object.freeze([]) }), replayed: false });
}

function normalizeError(error: unknown): WorkflowApiError {
  return error instanceof WorkflowApiError ? error : new WorkflowApiError("internal-error", "Workflow operation failed.", true);
}

function requireText(value: unknown, code: string, message: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) fail(code, message);
}

function fail(code: string, message: string, retryable = false, details: Readonly<Record<string, unknown>> = {}): never {
  throw new WorkflowApiError(code, message, retryable, Object.freeze({ ...details }));
}
