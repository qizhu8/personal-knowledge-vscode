export interface PortalConnectionRecord {
  pairId: string;
  chatId: string;
  chatLabel: string;
  external: boolean;
  role: "controller" | "controlled";
  localMachine: string;
  peerName: string;
  peerMachine?: string;
  peerChatId?: string;
  peerChatName?: string;
  endpoint?: string;
  connectedAt: number;
  lastSeenAt: number;
}
import type { PortalPermission, PortalPermissionGrantMode, PortalPermissionsSnapshot } from "./portal-permissions";

export interface PortalReconnecting { since: number; deadline: number }
/** Display-only access summary for one local Portal Chat. Grants and revocation stay with the standard Portal permissions command. */
export interface PortalConnectionAccess {
  /** Leases this controlled side gave the controller; absent when nothing is granted. */
  permissions?: { mode: PortalPermissionGrantMode; dimensions: PortalPermission[]; scoped: boolean; expiresAt: number | null };
  /** Remembered external MCP access for this pairing; absent means every external request asks. */
  externalAuthorization?: { expiresAt: number | null };
}
export interface PortalConnectionView extends PortalConnectionRecord { state: "active" | "reconnecting"; resumable: false; reconnecting?: PortalReconnecting; access?: PortalConnectionAccess }
/** reconnecting: the pairing is kept during the reconnect grace period even while the transport is down. */
export interface PortalConnectionLive { pairId?: string; connected: boolean; reconnecting?: PortalReconnecting; access?: PortalConnectionAccess }

/** Summarizes live leases without folder paths; only grants for the given pairing count. */
export function portalConnectionAccess(pairId: string | undefined, permissions: PortalPermissionsSnapshot | undefined,
  external?: { expiresAt: number } | undefined): PortalConnectionAccess {
  const access: PortalConnectionAccess = {};
  const now = permissions?.now ?? Date.now();
  const grants = permissions && !permissions.closed && pairId && permissions.connectionId === pairId
    ? permissions.grants.filter(grant => (grant.expiresAt === null || grant.expiresAt > now) && grant.remaining.length) : [];
  if (grants.length) {
    const dimensions = [...new Set(grants.flatMap(grant => grant.remaining))];
    const ends = grants.map(grant => grant.expiresAt);
    access.permissions = {
      mode: grants.some(grant => grant.mode === "all") ? "all" : grants.every(grant => grant.mode === "once") ? "once" : "scoped",
      dimensions, scoped: grants.some(grant => Object.keys(grant.scopes).length > 0),
      expiresAt: ends.includes(null) ? null : Math.max(...(ends as number[])),
    };
  }
  if (external && external.expiresAt > Date.now()) access.externalAuthorization = { expiresAt: Number.isFinite(external.expiresAt) ? external.expiresAt : null };
  return access;
}
export interface PortalPendingInvitation {
  chatId: string; chatLabel: string; external: boolean; role: "controller" | "controlled"; expiresAt: number; endpoint: string;
  localMachine?: string;
}
export interface PortalEndpointView {
  id: string; name: string; localMachine: string; chatId?: string; chatName?: string; deleted: boolean;
  acceptsIncoming: boolean; permissions: PortalPermission[]; paired: boolean;
  state: "connected" | "connecting" | "disconnected"; error?: string;
  peer?: { name: string; machine?: string; chatId?: string; chatName?: string; deleted?: boolean; acceptsIncoming?: boolean; confirmed: boolean };
}
export interface PortalHubPortStatus {
  requestedPort: number;
  actualPort?: number;
  state: "starting" | "ready" | "failed" | "stopped";
  reason: "configured" | "in-use" | "system-selected" | "reused";
  at: number;
  error?: string;
}
export interface PortalConnectionSnapshot { updatedAt: number; active: number; connections: PortalConnectionView[]; pendingInvitations?: PortalPendingInvitation[]; endpoints?: PortalEndpointView[]; hubPort?: PortalHubPortStatus }
export interface PortalBindingLike {
  pairId: string; role: "controller" | "controlled"; peerName: string;
  peerMachine?: string; peerChatId?: string; peerChatName?: string; peerEndpoint?: string;
}

/** Drops anything after host:port so tokens or paths never enter the connection view. */
export function endpointLabel(endpoint: string): string {
  try { const url = new URL(endpoint); return `${url.protocol}//${url.host}`; }
  catch { return endpoint.replace(/[?#].*$/, "").slice(0, 200); }
}
export type PortalEndpointScope = "forwarded-localhost" | "lan" | "remote" | "unknown";
export function endpointScope(endpoint: string | undefined): PortalEndpointScope {
  if (!endpoint) return "unknown";
  let host: string;
  try { host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return "unknown"; }
  if (host === "localhost" || host === "::1" || /^127\./.test(host)) return "forwarded-localhost";
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host) || host.endsWith(".local") || host.endsWith(".lan") || !host.includes(".") && !host.includes(":")) return "lan";
  return "remote";
}

/** Window-local live bindings only. No storage callbacks, ended history or restoration. */
export class PortalConnectionJournal {
  private readonly records = new Map<string, PortalConnectionRecord>();

  observe(owner: { chatId: string; chatLabel: string; external: boolean; localMachine: string; endpoint?: string }, binding: PortalBindingLike | undefined): void {
    if (!binding) { this.records.delete(owner.chatId); return; }
    const now = Date.now(), previous = this.records.get(owner.chatId);
    const endpoint = binding.peerEndpoint || owner.endpoint;
    this.records.set(owner.chatId, {
      ...owner, pairId: binding.pairId, role: binding.role, peerName: binding.peerName,
      peerMachine: binding.peerMachine, peerChatId: binding.peerChatId, peerChatName: binding.peerChatName,
      endpoint: endpoint ? endpointLabel(endpoint) : undefined,
      connectedAt: previous?.pairId === binding.pairId ? previous.connectedAt : now, lastSeenAt: now,
    });
  }

  forget(pairId: string): boolean {
    let removed = false;
    for (const [id, record] of this.records) if (record.pairId === pairId) { this.records.delete(id); removed = true; }
    return removed;
  }

  snapshot(live: ReadonlyMap<string, PortalConnectionLive>): PortalConnectionSnapshot {
    const connections: PortalConnectionView[] = [];
    for (const record of this.records.values()) {
      const current = live.get(record.chatId);
      if (!current || current.pairId !== record.pairId) continue;
      const access = current.access && (current.access.permissions || current.access.externalAuthorization) ? { access: current.access } : {};
      if (current.reconnecting) connections.push({ ...record, state: "reconnecting", resumable: false, reconnecting: { ...current.reconnecting }, ...access });
      else if (current.connected) connections.push({ ...record, state: "active", resumable: false, ...access });
    }
    return { updatedAt: Date.now(), active: connections.filter(item => item.state === "active").length, connections };
  }
}
