/**
 * Portal permission lease policy.
 *
 * One PortalPermissions instance models the permissions a *controlled* side has
 * leased to a *controller* for a single Chat + connection. It is in-memory only:
 * nothing is written to disk and there is intentionally no restore-from-snapshot
 * API, so leases never survive a process restart or a new connection.
 *
 * Policy summary:
 * - Leases have a fixed expiry (default 15 minutes) or last until disconnect
 *   (`durationMs: null`). Use is never a renewal: there is no sliding expiry.
 * - Grants are `once` (each listed permission usable once), `scoped`
 *   (remembered for the lease, optionally bounded to resource prefixes) or
 *   `all` (every dimension, still optionally bounded by scopes).
 * - File transfer is NOT a grantable dimension. Every transfer batch needs its
 *   own explicit consent from the controlled side, and even `all` never covers it.
 * - This is pure policy, not a sandbox. `code-execute` is an explicit broad
 *   execution grant: arbitrary code can read, write or transfer files and run
 *   git on its own, bypassing scopes and the file-transfer rule. Callers should
 *   default-deny it and warn before granting. No all-channel exfiltration
 *   protection is claimed.
 * - `invalidate()` drops every lease and pending transfer consent on disconnect,
 *   revoke, root/trust/role changes. `disconnect` is terminal for the instance.
 */

export const PORTAL_PERMISSION_DIMENSIONS = [
  "chat-read",
  "progress-read",
  "files-read",
  "files-write",
  "code-execute",
  "pkm-read",
  "pkm-write",
  "git-read",
  "git-write",
  "environment-manage",
] as const;

export type PortalPermission = (typeof PORTAL_PERMISSION_DIMENSIONS)[number];

/** Operation name that is always denied by `allows()`; use per-batch consent. */
export const PORTAL_FILE_TRANSFER_OPERATION = "file-transfer" as const;

export const PORTAL_PERMISSION_GRANT_MODES = ["once", "scoped", "all"] as const;
export type PortalPermissionGrantMode = (typeof PORTAL_PERMISSION_GRANT_MODES)[number];

export const PORTAL_PERMISSION_INVALIDATION_REASONS = [
  "disconnect",
  "revoke",
  "root-change",
  "trust-change",
  "role-change",
] as const;
export type PortalPermissionInvalidationReason = (typeof PORTAL_PERMISSION_INVALIDATION_REASONS)[number];

export const PORTAL_PERMISSION_DEFAULT_DURATION_MS = 15 * 60 * 1000;
/** Durations above this (or until-disconnected) should be confirmed via a UI warning. */
export const PORTAL_PERMISSION_LONG_DURATION_WARNING_MS = PORTAL_PERMISSION_DEFAULT_DURATION_MS;
/** Largest epoch-ms value a JS Date can represent; fixed expiries must not exceed it. */
export const PORTAL_PERMISSION_MAX_EXPIRY_EPOCH_MS = 8_640_000_000_000_000;
export const PORTAL_FILE_TRANSFER_CONSENT_TTL_MS = PORTAL_PERMISSION_DEFAULT_DURATION_MS;
export const PORTAL_PERMISSION_MAX_SCOPES_PER_PERMISSION = 64;
export const PORTAL_PERMISSION_MAX_RESOURCE_LENGTH = 4096;
export const PORTAL_FILE_TRANSFER_MAX_FILES_PER_BATCH = 1000;

export type PortalPermissionScopes = Partial<Record<PortalPermission, readonly string[]>>;

export interface PortalPermissionGrantRequest {
  mode: PortalPermissionGrantMode;
  /** Required for `once`/`scoped`; ignored for `all` (all dimensions are granted). */
  permissions?: readonly PortalPermission[];
  /** Milliseconds for fixed expiry, `null` for until-disconnected, omitted for 15 minutes. */
  durationMs?: number | null;
  /** Optional resource prefixes per permission, e.g. bounded directories. */
  scopes?: PortalPermissionScopes;
}

export type PortalPermissionLifecycle = "fixed" | "until-disconnected";

export interface PortalPermissionGrantSnapshot {
  id: string;
  mode: PortalPermissionGrantMode;
  permissions: PortalPermission[];
  /** For `once` grants: permissions that have not been used yet. */
  remaining: PortalPermission[];
  scopes: Partial<Record<PortalPermission, string[]>>;
  lifecycle: PortalPermissionLifecycle;
  grantedAt: number;
  expiresAt: number | null;
}

export interface PortalPermissionInvalidationRecord {
  reason: PortalPermissionInvalidationReason;
  at: number;
}

export interface PortalPermissionsSnapshot {
  chatId: string;
  connectionId: string;
  closed: boolean;
  now: number;
  grants: PortalPermissionGrantSnapshot[];
  /** Whether each dimension is currently held by any lease (ignoring resource scopes). */
  effective: Record<PortalPermission, boolean>;
  pendingFileTransferBatches: string[];
  lastInvalidation: PortalPermissionInvalidationRecord | null;
}

export interface PortalFileTransferConsentRequest {
  batchId: string;
  direction: "to-controller" | "to-controlled";
  files: readonly string[];
}

export interface PortalPermissionsOptions {
  chatId: string;
  connectionId: string;
  /** Injected clock in epoch milliseconds; defaults to Date.now. */
  now?: () => number;
}

interface GrantRecord {
  id: string;
  mode: PortalPermissionGrantMode;
  permissions: PortalPermission[];
  remaining: Set<PortalPermission>;
  scopes: Map<PortalPermission, string[]>;
  grantedAt: number;
  expiresAt: number | null;
}

interface TransferConsentRecord {
  batchId: string;
  direction: PortalFileTransferConsentRequest["direction"];
  files: string[];
  expiresAt: number;
}

const DIMENSION_SET: ReadonlySet<string> = new Set(PORTAL_PERMISSION_DIMENSIONS);

export function isPortalPermission(value: unknown): value is PortalPermission {
  return typeof value === "string" && DIMENSION_SET.has(value);
}

/** True when the UI must warn before accepting this lease duration. */
export function portalPermissionDurationNeedsWarning(durationMs: number | null | undefined): boolean {
  if (durationMs === undefined) return false;
  if (durationMs === null) return true;
  return durationMs > PORTAL_PERMISSION_LONG_DURATION_WARNING_MS;
}

/**
 * Normalizes a resource identifier (path or `namespace:path`). Returns null for
 * anything unsafe or unbounded: empty, too long, NUL, `.`/`..` segments.
 */
export function normalizePortalResource(resource: unknown): string | null {
  if (typeof resource !== "string") return null;
  if (!resource || resource.length > PORTAL_PERMISSION_MAX_RESOURCE_LENGTH || resource.includes("\0")) return null;
  let value = resource.replace(/\\/g, "/");
  const leadingDouble = value.startsWith("//");
  value = value.replace(/\/{2,}/g, "/");
  if (leadingDouble) value = "/" + value;
  if (value.length > 1 && value.endsWith("/")) value = value.replace(/\/+$/, "");
  if (!value) return null;
  for (const segment of value.split("/")) {
    if (segment === "." || segment === "..") return null;
  }
  return value;
}

function resourceWithinPrefix(resource: string, prefix: string): boolean {
  if (resource === prefix) return true;
  if (prefix.endsWith("/") || prefix.endsWith(":")) return resource.startsWith(prefix);
  return resource.startsWith(prefix + "/");
}

function validateDuration(durationMs: number | null | undefined): number | null {
  if (durationMs === undefined) return PORTAL_PERMISSION_DEFAULT_DURATION_MS;
  if (durationMs === null) return null;
  if (typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new Error("Portal permission durationMs must be a positive safe integer, null, or omitted.");
  }
  return durationMs;
}

function rejectFileTransfer(value: unknown): void {
  if (value === PORTAL_FILE_TRANSFER_OPERATION) {
    throw new Error("file-transfer cannot be granted; it requires explicit per-batch consent.");
  }
}

export class PortalPermissions {
  readonly chatId: string;
  readonly connectionId: string;
  private readonly now: () => number;
  private grants: GrantRecord[] = [];
  private transfers = new Map<string, TransferConsentRecord>();
  private closed = false;
  private lastInvalidation: PortalPermissionInvalidationRecord | null = null;
  private sequence = 0;

  constructor(options: PortalPermissionsOptions) {
    if (!options || typeof options.chatId !== "string" || !options.chatId) throw new Error("PortalPermissions requires chatId.");
    if (typeof options.connectionId !== "string" || !options.connectionId) throw new Error("PortalPermissions requires connectionId.");
    this.chatId = options.chatId;
    this.connectionId = options.connectionId;
    this.now = options.now ?? Date.now;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  grant(request: PortalPermissionGrantRequest): PortalPermissionGrantSnapshot {
    if (this.closed) throw new Error("Portal connection is disconnected; create a new PortalPermissions for a new connection.");
    if (!request || typeof request !== "object") throw new Error("Portal permission grant request is required.");
    if (!(PORTAL_PERMISSION_GRANT_MODES as readonly string[]).includes(request.mode)) {
      throw new Error(`Unknown portal permission grant mode: ${String(request.mode)}`);
    }
    const durationMs = validateDuration(request.durationMs);

    let permissions: PortalPermission[];
    if (request.mode === "all") {
      for (const p of request.permissions ?? []) rejectFileTransfer(p);
      permissions = [...PORTAL_PERMISSION_DIMENSIONS];
    } else {
      if (!Array.isArray(request.permissions) || request.permissions.length === 0) {
        throw new Error("Portal permission grant requires at least one permission.");
      }
      for (const p of request.permissions) {
        rejectFileTransfer(p);
        if (!isPortalPermission(p)) throw new Error(`Unknown portal permission: ${String(p)}`);
      }
      permissions = [...new Set(request.permissions)];
    }

    const scopes = new Map<PortalPermission, string[]>();
    if (request.scopes !== undefined) {
      if (!request.scopes || typeof request.scopes !== "object") throw new Error("Portal permission scopes must be an object.");
      for (const [key, prefixes] of Object.entries(request.scopes)) {
        rejectFileTransfer(key);
        if (!isPortalPermission(key)) throw new Error(`Unknown portal permission scope: ${key}`);
        if (!permissions.includes(key)) throw new Error(`Scope given for permission not in grant: ${key}`);
        if (!Array.isArray(prefixes) || prefixes.length === 0) throw new Error(`Scope for ${key} must be a non-empty array.`);
        if (prefixes.length > PORTAL_PERMISSION_MAX_SCOPES_PER_PERMISSION) throw new Error(`Too many scopes for ${key}.`);
        const normalized = prefixes.map((prefix) => {
          const value = normalizePortalResource(prefix);
          if (!value || value === "/") throw new Error(`Invalid or unbounded scope for ${key}: ${String(prefix)}`);
          return value;
        });
        scopes.set(key, [...new Set(normalized)]);
      }
    }

    const grantedAt = this.now();
    if (durationMs !== null && (!Number.isSafeInteger(grantedAt + durationMs) || grantedAt + durationMs > PORTAL_PERMISSION_MAX_EXPIRY_EPOCH_MS)) {
      throw new Error("Portal permission durationMs overflows the maximum representable expiry; use until-disconnected instead.");
    }
    const record: GrantRecord = {
      id: `grant-${++this.sequence}`,
      mode: request.mode,
      permissions,
      remaining: new Set(permissions),
      scopes,
      grantedAt,
      expiresAt: durationMs === null ? null : grantedAt + durationMs,
    };
    this.grants.push(record);
    return this.grantSnapshot(record);
  }

  /**
   * Enforcement check. Returns true when a live lease covers the permission and
   * (if scoped) the resource. A matching `once` grant is consumed. Never extends
   * expiry. Unknown operations and `file-transfer` always return false.
   */
  allows(permission: string, resource?: string): boolean {
    if (this.closed || !isPortalPermission(permission)) return false;
    this.prune();
    let normalized: string | null | undefined;
    if (resource !== undefined) {
      normalized = normalizePortalResource(resource);
      if (normalized === null) return false;
    }
    const matches = (grant: GrantRecord): boolean => {
      if (!grant.remaining.has(permission)) return false;
      const prefixes = grant.scopes.get(permission);
      if (!prefixes) return true;
      if (normalized === undefined || normalized === null) return false;
      return prefixes.some((prefix) => resourceWithinPrefix(normalized as string, prefix));
    };
    // Prefer remembered leases so a once grant is not spent needlessly.
    const remembered = this.grants.find((grant) => grant.mode !== "once" && matches(grant));
    if (remembered) return true;
    const once = this.grants.find((grant) => grant.mode === "once" && matches(grant));
    if (!once) return false;
    once.remaining.delete(permission);
    if (once.remaining.size === 0) this.grants = this.grants.filter((grant) => grant !== once);
    return true;
  }

  /** Revokes a single lease by id. Returns whether it existed. */
  revokeGrant(id: string): boolean {
    const before = this.grants.length;
    this.grants = this.grants.filter((grant) => grant.id !== id);
    return this.grants.length !== before;
  }

  /**
   * Records explicit controlled-side consent for exactly one transfer batch.
   * Independent of all leases (including `all`). Expires after a fixed TTL.
   */
  consentFileTransferBatch(request: PortalFileTransferConsentRequest): void {
    if (this.closed) throw new Error("Portal connection is disconnected.");
    if (!request || typeof request.batchId !== "string" || !request.batchId) throw new Error("File transfer consent requires batchId.");
    if (request.direction !== "to-controller" && request.direction !== "to-controlled") {
      throw new Error("File transfer consent requires a valid direction.");
    }
    if (!Array.isArray(request.files) || request.files.length === 0 || request.files.length > PORTAL_FILE_TRANSFER_MAX_FILES_PER_BATCH) {
      throw new Error("File transfer consent requires a bounded, non-empty file list.");
    }
    if (this.transfers.has(request.batchId)) throw new Error(`File transfer batch already has consent: ${request.batchId}`);
    const files = request.files.map((file) => {
      const value = normalizePortalResource(file);
      if (!value) throw new Error(`Invalid file transfer path: ${String(file)}`);
      return value;
    });
    this.transfers.set(request.batchId, {
      batchId: request.batchId,
      direction: request.direction,
      files: [...new Set(files)].sort(),
      expiresAt: this.now() + PORTAL_FILE_TRANSFER_CONSENT_TTL_MS,
    });
  }

  /**
   * Single-use check for a transfer batch. Succeeds only if consent exists for
   * this batch id, direction and exactly this file set; consent is consumed.
   */
  consumeFileTransferBatch(request: PortalFileTransferConsentRequest): boolean {
    if (this.closed || !request) return false;
    this.prune();
    const consent = this.transfers.get(request.batchId);
    if (!consent) return false;
    this.transfers.delete(request.batchId);
    if (consent.direction !== request.direction || !Array.isArray(request.files)) return false;
    const files = request.files.map((file) => normalizePortalResource(file));
    if (files.some((file) => !file)) return false;
    const unique = [...new Set(files as string[])].sort();
    return unique.length === consent.files.length && unique.every((file, index) => file === consent.files[index]);
  }

  /** Drops every lease and pending transfer consent. `disconnect` is terminal. */
  invalidate(reason: PortalPermissionInvalidationReason = "revoke"): void {
    if (!(PORTAL_PERMISSION_INVALIDATION_REASONS as readonly string[]).includes(reason)) {
      throw new Error(`Unknown portal permission invalidation reason: ${String(reason)}`);
    }
    this.grants = [];
    this.transfers.clear();
    this.lastInvalidation = { reason, at: this.now() };
    if (reason === "disconnect") this.closed = true;
  }

  snapshot(): PortalPermissionsSnapshot {
    this.prune();
    const effective = Object.fromEntries(PORTAL_PERMISSION_DIMENSIONS.map((p) => [p, false])) as Record<PortalPermission, boolean>;
    if (!this.closed) {
      for (const grant of this.grants) for (const p of grant.remaining) effective[p] = true;
    }
    return {
      chatId: this.chatId,
      connectionId: this.connectionId,
      closed: this.closed,
      now: this.now(),
      grants: this.grants.map((grant) => this.grantSnapshot(grant)),
      effective,
      pendingFileTransferBatches: [...this.transfers.keys()],
      lastInvalidation: this.lastInvalidation ? { ...this.lastInvalidation } : null,
    };
  }

  private prune(): void {
    const now = this.now();
    this.grants = this.grants.filter((grant) => grant.expiresAt === null || now < grant.expiresAt);
    for (const [id, consent] of this.transfers) if (now >= consent.expiresAt) this.transfers.delete(id);
  }

  private grantSnapshot(grant: GrantRecord): PortalPermissionGrantSnapshot {
    return {
      id: grant.id,
      mode: grant.mode,
      permissions: [...grant.permissions],
      remaining: [...grant.remaining],
      scopes: Object.fromEntries([...grant.scopes].map(([p, prefixes]) => [p, [...prefixes]])),
      lifecycle: grant.expiresAt === null ? "until-disconnected" : "fixed",
      grantedAt: grant.grantedAt,
      expiresAt: grant.expiresAt,
    };
  }
}
