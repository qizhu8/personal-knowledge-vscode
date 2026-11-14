import { createHash, randomUUID } from "crypto";
import type { MemoryEngineClient, MemorySourceReference } from "./memory-engine-client";

export interface ExplicitMemoryScope {
  account: string;
  project: string;
  repository: string;
}

export type ExplicitMemoryStatus = "pending" | "confirmed" | "superseded" | "revoked";
export type ExplicitMemoryHostAction = "confirm" | "revise" | "revoke";

export interface ExplicitMemoryRecord {
  id: string;
  scope: string;
  revision: number;
  current_revision: number;
  status: ExplicitMemoryStatus;
  current_status: "pending" | "confirmed" | "revoked";
  content: string;
  sources: MemorySourceReference[];
  created_at: number;
  updated_at: number;
  revision_created_at: number;
}

export interface ExplicitMemoryAuditEvent {
  sequence: number;
  revision: number;
  action: string;
  status: string;
  actor: string;
  decision_id?: string;
  operation_id: string;
  created_at: number;
}

export interface ExplicitMemoryHostDecisionRequest {
  action: ExplicitMemoryHostAction;
  operationId: string;
  scope: ExplicitMemoryScope;
  recordId: string;
  expectedRevision: number;
  content?: string;
  sources?: readonly MemorySourceReference[];
}

export interface ExplicitMemoryHostDecision {
  decisionId: string;
  actorId: string;
}

export type ExplicitMemoryHostAuthorizer =
  (request: ExplicitMemoryHostDecisionRequest) =>
    ExplicitMemoryHostDecision | null | Promise<ExplicitMemoryHostDecision | null>;

export interface ExplicitMemoryOperationOptions {
  operationId?: string;
}

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

export class ExplicitMemoryValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ExplicitMemoryValidationError"; }
}

function boundedText(value: unknown, name: string, maximumBytes: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || utf8Bytes(value) > maximumBytes ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    throw new ExplicitMemoryValidationError(`${name} must be nonempty text within ${maximumBytes} UTF-8 bytes.`);
  }
}

function validateScope(scope: ExplicitMemoryScope): ExplicitMemoryScope {
  if (!scope || typeof scope !== "object") throw new ExplicitMemoryValidationError("An account/project/repository scope is required.");
  for (const key of ["account", "project", "repository"] as const) boundedText(scope[key], key, 256);
  const result = Object.freeze({ account: scope.account, project: scope.project, repository: scope.repository });
  if (utf8Bytes(JSON.stringify(result)) > 1024) throw new ExplicitMemoryValidationError("Memory scope exceeds 1024 UTF-8 bytes.");
  return result;
}

function validateSources(sources: readonly MemorySourceReference[]): MemorySourceReference[] {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 32) {
    throw new ExplicitMemoryValidationError("Explicit memory needs 1..32 exact source references.");
  }
  const validated = sources.map(source => {
    if (!source || typeof source !== "object") throw new ExplicitMemoryValidationError("Invalid explicit-memory source reference.");
    boundedText(source.id, "source id", 256);
    boundedText(source.chat, "source chat", 1024);
    boundedText(source.revision, "source revision", 256);
    boundedText(source.locator, "source locator", 2048);
    return { id: source.id, chat: source.chat, revision: source.revision, locator: source.locator };
  });
  if (utf8Bytes(JSON.stringify(validated)) > 4096) {
    throw new ExplicitMemoryValidationError("Explicit-memory source references exceed 4096 UTF-8 bytes in total.");
  }
  return validated;
}

function resultRecord(value: unknown): ExplicitMemoryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Memory Engine returned an invalid explicit-memory record.");
  }
  const record = value as Partial<ExplicitMemoryRecord>;
  if (typeof record.id !== "string" || typeof record.scope !== "string" ||
      !Number.isSafeInteger(record.revision) || !Number.isSafeInteger(record.current_revision) ||
      !["pending", "confirmed", "superseded", "revoked"].includes(String(record.status)) ||
      !Array.isArray(record.sources)) {
    throw new Error("Memory Engine returned an invalid explicit-memory record.");
  }
  return record as ExplicitMemoryRecord;
}

function operationId(value?: string): string {
  const result = value ?? randomUUID();
  boundedText(result, "operation id", 256);
  return result;
}

function recordIdFor(operation: string, scope: string): string {
  return `explicit-${createHash("sha256").update(scope).update("\0").update(operation).digest("hex")}`;
}

function scopeKey(scope: ExplicitMemoryScope): string {
  return JSON.stringify(scope);
}

/** Caller-scoped API; only the injected Host authorizer can authorize state transitions. */
export class ExplicitMemoryService {
  private readonly scope: ExplicitMemoryScope;
  private readonly serializedScope: string;

  constructor(
    private readonly engine: MemoryEngineClient,
    scope: ExplicitMemoryScope,
    private readonly authorizeHostDecision: ExplicitMemoryHostAuthorizer,
  ) {
    this.scope = validateScope(scope);
    this.serializedScope = scopeKey(this.scope);
    if (typeof authorizeHostDecision !== "function") {
      throw new Error("A Host decision authorizer is required.");
    }
  }

  async propose(input: {
    content: string;
    sources: readonly MemorySourceReference[];
  }, options: ExplicitMemoryOperationOptions = {}): Promise<ExplicitMemoryRecord> {
    boundedText(input?.content, "memory content", 4096);
    const sources = validateSources(input.sources);
    const opId = operationId(options.operationId);
    const result = await this.engine.request({
      method: "explicit_propose", operationId: opId,
      params: { id: recordIdFor(opId, this.serializedScope), scope: this.serializedScope,
        content: input.content, sources },
    });
    return resultRecord(result);
  }

  async get(id: string, revision?: number): Promise<ExplicitMemoryRecord> {
    boundedText(id, "memory id", 256);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
      throw new ExplicitMemoryValidationError("revision must be a positive safe integer.");
    }
    return resultRecord(await this.engine.request({
      method: "explicit_get", params: { memory_id: id, scope: this.serializedScope, revision },
    }));
  }

  async search(query: string, limit = 20): Promise<ExplicitMemoryRecord[]> {
    boundedText(query, "query", 512);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new ExplicitMemoryValidationError("limit must be an integer in [1, 20].");
    }
    const result = await this.engine.request({
      method: "explicit_search", params: { scope: this.serializedScope, query, limit },
    });
    if (!Array.isArray(result)) throw new Error("Memory Engine returned an invalid search result.");
    return result.map(resultRecord);
  }

  async confirm(
    id: string, expectedRevision: number, options: ExplicitMemoryOperationOptions = {},
  ): Promise<ExplicitMemoryRecord> {
    const opId = operationId(options.operationId);
    const authorization = await this.authorize("confirm", opId, id, expectedRevision);
    return resultRecord(await this.engine.request({
      method: "explicit_confirm", operationId: opId,
      params: { id, scope: this.serializedScope, expected_revision: expectedRevision,
        host_authorization: { decision_id: authorization.decisionId, actor_id: authorization.actorId } },
    }));
  }

  async revise(id: string, expectedRevision: number, input: {
    content: string;
    sources: readonly MemorySourceReference[];
  }, options: ExplicitMemoryOperationOptions = {}): Promise<ExplicitMemoryRecord> {
    boundedText(input?.content, "memory content", 4096);
    const sources = validateSources(input.sources);
    const opId = operationId(options.operationId);
    const authorization = await this.authorize("revise", opId, id, expectedRevision, input.content, sources);
    return resultRecord(await this.engine.request({
      method: "explicit_revise", operationId: opId,
      params: { id, scope: this.serializedScope, expected_revision: expectedRevision, content: input.content,
        sources, host_authorization: { decision_id: authorization.decisionId, actor_id: authorization.actorId } },
    }));
  }

  async revoke(
    id: string, expectedRevision: number, options: ExplicitMemoryOperationOptions = {},
  ): Promise<ExplicitMemoryRecord> {
    const opId = operationId(options.operationId);
    const authorization = await this.authorize("revoke", opId, id, expectedRevision);
    return resultRecord(await this.engine.request({
      method: "explicit_revoke", operationId: opId,
      params: { id, scope: this.serializedScope, expected_revision: expectedRevision,
        host_authorization: { decision_id: authorization.decisionId, actor_id: authorization.actorId } },
    }));
  }

  async audit(id: string, after = 0, limit = 50): Promise<{
    events: ExplicitMemoryAuditEvent[];
    next: number | null;
  }> {
    boundedText(id, "memory id", 256);
    if (!Number.isSafeInteger(after) || after < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ExplicitMemoryValidationError("Invalid explicit-memory audit cursor or limit.");
    }
    const result = await this.engine.request({
      method: "explicit_audit", params: { scope: this.serializedScope, memory_id: id, after, limit },
    });
    if (!result || typeof result !== "object" || Array.isArray(result) ||
        !Array.isArray((result as { events?: unknown }).events)) {
      throw new Error("Memory Engine returned an invalid audit result.");
    }
    return result as { events: ExplicitMemoryAuditEvent[]; next: number | null };
  }

  private async authorize(
    action: ExplicitMemoryHostAction,
    operation: string,
    recordId: string,
    expectedRevision: number,
    content?: string,
    sources?: readonly MemorySourceReference[],
  ): Promise<ExplicitMemoryHostDecision> {
    boundedText(recordId, "memory id", 256);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new ExplicitMemoryValidationError("expectedRevision must be a positive safe integer.");
    }
    const request: ExplicitMemoryHostDecisionRequest = {
      action, operationId: operation, scope: this.scope, recordId, expectedRevision,
      ...(content === undefined ? {} : { content }),
      ...(sources === undefined ? {} : { sources: Object.freeze(sources.map(source => Object.freeze({ ...source }))) }),
    };
    const decision = await this.authorizeHostDecision(Object.freeze(request));
    if (!decision) throw new Error("Host did not authorize the explicit-memory decision.");
    boundedText(decision.decisionId, "Host decision id", 256);
    boundedText(decision.actorId, "Host actor id", 256);
    return { decisionId: decision.decisionId, actorId: decision.actorId };
  }
}
