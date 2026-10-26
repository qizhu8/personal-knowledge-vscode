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
export interface PortalConnectionView extends PortalConnectionRecord { state: "active"; resumable: false }
export interface PortalConnectionLive { pairId?: string; connected: boolean }
export interface PortalPendingInvitation {
  chatId: string; chatLabel: string; external: boolean; role: "controller" | "controlled"; expiresAt: number; endpoint: string;
  localMachine?: string;
}
export interface PortalConnectionSnapshot { updatedAt: number; active: number; connections: PortalConnectionView[]; pendingInvitations?: PortalPendingInvitation[] }
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
      if (current?.connected && current.pairId === record.pairId) connections.push({ ...record, state: "active", resumable: false });
    }
    return { updatedAt: Date.now(), active: connections.length, connections };
  }
}
