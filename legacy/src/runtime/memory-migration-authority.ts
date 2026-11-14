import { createHash, randomUUID } from "crypto";

export const NEXT_TRIAL_MEMORY_ACTOR_ID = "local:owner";
export const MEMORY_MIGRATION_GRANT_TTL_MS = 15 * 60 * 1000;

export interface MemoryScopeApprovalRequest {
  schema: "pkm.memory-scope-continuity/v2";
  workspaceId: string;
  scope: string;
  sourceScopeSha256: string;
  sourceDatabaseSha256: string;
  importPlanSha256: string;
  importReceiptSha256: string;
  actorId: string;
}

export interface MemoryScopeApprovalExpectation {
  workspaceId?: string;
  target: string;
  actorId: typeof NEXT_TRIAL_MEMORY_ACTOR_ID;
  scope: string;
  sourceDatabaseSha256: string;
  importPlanSha256: string;
  importReceiptSha256?: string;
  receiptStateSha256?: string;
}
export interface MemoryHostPin extends Omit<MemoryScopeApprovalRequest, "schema" | "actorId"> {
  schema: "pkm.memory-host-pin/v1";
  actorId: typeof NEXT_TRIAL_MEMORY_ACTOR_ID;
  receiptStateSha256: string;
}
export function parseMemoryHostPin(input: unknown): MemoryHostPin | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const pin = input as Record<string, unknown>;
  if (Object.keys(pin).length !== 9 || pin.schema !== "pkm.memory-host-pin/v1"
    || !isDigest(pin.receiptStateSha256) || pin.actorId !== NEXT_TRIAL_MEMORY_ACTOR_ID) return undefined;
  const request = parseRequest({
    schema: "pkm.memory-scope-continuity/v2", workspaceId: pin.workspaceId, scope: pin.scope,
    actorId: pin.actorId, sourceScopeSha256: pin.sourceScopeSha256, sourceDatabaseSha256: pin.sourceDatabaseSha256,
    importPlanSha256: pin.importPlanSha256, importReceiptSha256: pin.importReceiptSha256,
  });
  if (!request) return undefined;
  return {
    schema: "pkm.memory-host-pin/v1", actorId: NEXT_TRIAL_MEMORY_ACTOR_ID,
    workspaceId: request.workspaceId, scope: request.scope, sourceScopeSha256: request.sourceScopeSha256,
    sourceDatabaseSha256: request.sourceDatabaseSha256, importPlanSha256: request.importPlanSha256,
    importReceiptSha256: request.importReceiptSha256, receiptStateSha256: pin.receiptStateSha256,
  };
}

export interface MemoryScopeApproval {
  actorId: string;
  decisionId: string;
  expiresAtMs: number;
}

export class MemoryMigrationAuthority {
  private consumed = false;

  constructor(
    private readonly isTrusted: () => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  async authorize(
    input: unknown,
    expected: MemoryScopeApprovalExpectation,
    confirm: (request: Readonly<MemoryScopeApprovalRequest>) => Promise<boolean>,
  ): Promise<MemoryScopeApproval | null> {
    if (this.consumed || !this.isTrusted()) return null;
    const envelope = parseEnvelope(input);
    const request = envelope && parseRequest(envelope.request);
    if (!envelope || envelope.target !== expected.target || !request
      || expected.workspaceId !== undefined && request.workspaceId !== expected.workspaceId
      || request.actorId !== expected.actorId || request.actorId !== NEXT_TRIAL_MEMORY_ACTOR_ID
      || request.scope !== expected.scope
      || request.sourceScopeSha256 !== sha256(expected.scope)
      || request.sourceDatabaseSha256 !== expected.sourceDatabaseSha256
      || request.importPlanSha256 !== expected.importPlanSha256
      || expected.importReceiptSha256 !== undefined && request.importReceiptSha256 !== expected.importReceiptSha256
      || expected.receiptStateSha256 !== undefined && envelope.receiptStateSha256 !== expected.receiptStateSha256) return null;

    this.consumed = true;
    const accepted = await confirm(Object.freeze({ ...request }));
    if (!accepted || !this.isTrusted()) return null;
    const expiresAtMs = this.now() + MEMORY_MIGRATION_GRANT_TTL_MS;
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= this.now()) return null;
    return { actorId: request.actorId, decisionId: randomUUID(), expiresAtMs };
  }
}

function parseEnvelope(value: unknown): { target: string; request: unknown; receiptStateSha256?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).some(key => !["target", "request", "receiptStateSha256"].includes(key))
    || envelope.receiptStateSha256 !== undefined && !isDigest(envelope.receiptStateSha256) || typeof envelope.target !== "string"
    || !envelope.target || !envelope.request) return undefined;
  return { target: envelope.target, request: envelope.request,
    ...(isDigest(envelope.receiptStateSha256) ? { receiptStateSha256: envelope.receiptStateSha256 } : {}) };
}

function parseRequest(value: unknown): MemoryScopeApprovalRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const request = value as Record<string, unknown>;
  if (Object.keys(request).length !== 8
    || request.schema !== "pkm.memory-scope-continuity/v2"
    || typeof request.workspaceId !== "string" || !/^[a-f0-9-]{36}$/i.test(request.workspaceId)
    || typeof request.scope !== "string" || !request.scope || Buffer.byteLength(request.scope) > 1024
    || typeof request.actorId !== "string" || !request.actorId || request.actorId.length > 256
    || !isDigest(request.sourceScopeSha256) || !isDigest(request.sourceDatabaseSha256)
    || !isDigest(request.importPlanSha256) || !isDigest(request.importReceiptSha256)
    || request.sourceScopeSha256 !== sha256(request.scope)) return undefined;
  return {
    schema: request.schema,
    workspaceId: request.workspaceId,
    scope: request.scope,
    sourceScopeSha256: request.sourceScopeSha256,
    sourceDatabaseSha256: request.sourceDatabaseSha256,
    importPlanSha256: request.importPlanSha256,
    importReceiptSha256: request.importReceiptSha256,
    actorId: request.actorId,
  };
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
