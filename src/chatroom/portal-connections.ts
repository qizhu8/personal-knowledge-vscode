/** Secret-free history of named Portal pairings, shown in Projects → Portal Connections. */
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
  endedAt?: number;
  /** VS Code window that owns the live binding; other windows can't verify it, so they show it as "elsewhere". */
  windowId?: string;
}

export type PortalConnectionState = "active" | "reconnecting" | "elsewhere" | "ended";
export interface PortalConnectionView extends PortalConnectionRecord { state: PortalConnectionState; resumable: boolean }
export interface PortalConnectionLive { pairId?: string; connected: boolean }
export interface PortalPendingInvitation {
  chatId: string; chatLabel: string; external: boolean; role: "controller" | "controlled"; expiresAt: number; endpoint: string;
}
export interface PortalConnectionSnapshot { updatedAt: number; active: number; connections: PortalConnectionView[]; pendingInvitations?: PortalPendingInvitation[] }

export interface PortalBindingLike {
  pairId: string; role: "controller" | "controlled"; peerName: string;
  peerMachine?: string; peerChatId?: string; peerChatName?: string; peerEndpoint?: string;
}

const MAX_RECORDS = 200;
const text = (value: unknown, limit = 200): string | undefined => typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
const time = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

function sanitize(value: unknown): PortalConnectionRecord | undefined {
  const raw = value as Record<string, unknown> | undefined;
  const pairId = text(raw?.pairId), chatId = text(raw?.chatId), peerName = text(raw?.peerName);
  const connectedAt = time(raw?.connectedAt), lastSeenAt = time(raw?.lastSeenAt);
  if (!pairId || !chatId || !peerName || !connectedAt || !lastSeenAt || (raw?.role !== "controller" && raw?.role !== "controlled")) return undefined;
  const optional = (key: string) => text(raw?.[key]);
  return {
    pairId, chatId, peerName, connectedAt, lastSeenAt, role: raw.role,
    chatLabel: optional("chatLabel") || "Untitled Chat", external: raw?.external === true, localMachine: optional("localMachine") || "",
    ...(optional("peerMachine") ? { peerMachine: optional("peerMachine") } : {}),
    ...(optional("peerChatId") ? { peerChatId: optional("peerChatId") } : {}),
    ...(optional("peerChatName") ? { peerChatName: optional("peerChatName") } : {}),
    ...(optional("endpoint") ? { endpoint: endpointLabel(optional("endpoint")!) } : {}),
    ...(time(raw?.endedAt) ? { endedAt: time(raw?.endedAt) } : {}),
    ...(optional("windowId") ? { windowId: optional("windowId") } : {}),
  };
}

/** Drops anything after host:port so tokens or paths in a URL can never reach the journal. */
export function endpointLabel(endpoint: string): string {
  try { const url = new URL(endpoint); return `${url.protocol}//${url.host}`; }
  catch { return endpoint.replace(/[?#].*$/, "").slice(0, 200); }
}

export type PortalEndpointScope = "forwarded-localhost" | "lan" | "remote" | "unknown";

/** Where an endpoint is reachable from; loopback means the machine running the VS Code UI, not the peer's reachability. */
export function endpointScope(endpoint: string | undefined): PortalEndpointScope {
  if (!endpoint) return "unknown";
  let host: string;
  try { host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return "unknown"; }
  if (host === "localhost" || host === "::1" || /^127\./.test(host)) return "forwarded-localhost";
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host) || host.endsWith(".local") || host.endsWith(".lan") || !host.includes(".") && !host.includes(":")) return "lan";
  return "remote";
}

const recordKey = (item: Pick<PortalConnectionRecord, "pairId" | "chatId">) => `${item.pairId}\u0000${item.chatId}`;
const sanitizeAll = (stored: unknown) => Array.isArray(stored) ? stored.map(sanitize).filter((item): item is PortalConnectionRecord => !!item).slice(-MAX_RECORDS) : [];

/**
 * Several VS Code windows share one globalState key. Each window re-reads the stored list before every change
 * and writes back only the records it touched, so windows never erase or resurrect each other's history.
 */
export class PortalConnectionJournal {
  private records: PortalConnectionRecord[];
  private readonly dirty = new Set<string>();
  private readonly forgotten = new Set<string>();

  constructor(stored: unknown, private readonly save: (records: PortalConnectionRecord[]) => unknown, private readonly now: () => number = Date.now,
    private readonly load?: () => unknown, readonly windowId: string = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    private readonly windowAlive: (windowId: string) => boolean = () => false) {
    this.records = sanitizeAll(stored);
  }

  private sync(): void {
    if (!this.load) return;
    const local = new Map(this.records.map(item => [recordKey(item), item]));
    const merged = sanitizeAll(this.load()).filter(item => !this.forgotten.has(recordKey(item)));
    const index = new Map(merged.map((item, position) => [recordKey(item), position]));
    for (const key of this.dirty) {
      const item = local.get(key);
      if (!item) continue;
      const position = index.get(key);
      if (position === undefined) { index.set(key, merged.length); merged.push(item); } else merged[position] = item;
    }
    this.records = merged.slice(-MAX_RECORDS);
  }

  private commit(keys: Iterable<string>): void {
    for (const key of keys) this.dirty.add(key);
    this.sync();
    this.records = this.records.slice(-MAX_RECORDS);
    this.save(this.records.map(item => ({ ...item })));
    this.dirty.clear(); this.forgotten.clear();
  }

  /** Called whenever a Chat's Portal binding changes; a binding upserts by pairId, no binding ends the Chat's open records. */
  observe(owner: { chatId: string; chatLabel: string; external: boolean; localMachine: string; endpoint?: string }, binding: PortalBindingLike | undefined): void {
    this.sync();
    const now = this.now();
    const touched: string[] = [];
    // Only this window's records: another window may legitimately hold the same Chat's live binding.
    const mine = (item: PortalConnectionRecord) => item.chatId === owner.chatId && !item.endedAt && (!item.windowId || item.windowId === this.windowId);
    if (binding) {
      const existing = this.records.find(item => item.pairId === binding.pairId && item.chatId === owner.chatId);
      const next = sanitize({
        ...existing, pairId: binding.pairId, chatId: owner.chatId, chatLabel: owner.chatLabel, external: owner.external, role: binding.role,
        localMachine: owner.localMachine, peerName: binding.peerName, peerMachine: binding.peerMachine, peerChatId: binding.peerChatId,
        peerChatName: binding.peerChatName, endpoint: binding.peerEndpoint || owner.endpoint || existing?.endpoint,
        connectedAt: existing?.connectedAt || now, lastSeenAt: now, endedAt: undefined, windowId: this.windowId,
      });
      if (!next) return;
      for (const item of this.records) if (mine(item) && item.pairId !== binding.pairId) { item.endedAt = now; touched.push(recordKey(item)); }
      if (existing) this.records.splice(this.records.indexOf(existing), 1);
      this.records.push(next);
      touched.push(recordKey(next));
    } else {
      for (const item of this.records) if (mine(item)) { item.endedAt = now; item.lastSeenAt = now; touched.push(recordKey(item)); }
    }
    if (touched.length) this.commit(touched);
  }

  rename(chatId: string, chatLabel: string): void {
    const label = text(chatLabel);
    if (!label) return;
    this.sync();
    const touched: string[] = [];
    for (const item of this.records) if (item.chatId === chatId && item.chatLabel !== label) { item.chatLabel = label; touched.push(recordKey(item)); }
    if (touched.length) this.commit(touched);
  }

  forget(pairId: string): boolean {
    this.sync();
    const removed = this.records.filter(item => item.pairId === pairId);
    if (!removed.length) return false;
    for (const item of removed) this.forgotten.add(recordKey(item));
    this.records = this.records.filter(item => item.pairId !== pairId);
    this.commit([]);
    return true;
  }

  /** State is derived from live bindings, so stale records from a previous VS Code session never look active. */
  snapshot(live: ReadonlyMap<string, PortalConnectionLive>, resumableChats: ReadonlySet<string>): PortalConnectionSnapshot {
    this.sync();
    const latest = new Map<string, PortalConnectionRecord>();
    for (const item of this.records) {
      const current = latest.get(item.chatId);
      if (!current || item.lastSeenAt >= current.lastSeenAt) latest.set(item.chatId, item);
    }
    const connections = this.records.map(item => {
      const current = live.get(item.chatId);
      const state: PortalConnectionState = current?.pairId === item.pairId ? (current.connected ? "active" : "reconnecting")
        : !item.endedAt && item.windowId && item.windowId !== this.windowId && this.windowAlive(item.windowId) ? "elsewhere" : "ended";
      return { ...item, state, resumable: state === "ended" && resumableChats.has(item.chatId) && latest.get(item.chatId) === item };
    }).sort((left, right) => rank(left.state) - rank(right.state) || right.lastSeenAt - left.lastSeenAt);
    return { updatedAt: this.now(), active: connections.filter(item => item.state === "active").length, connections };
  }
}

function rank(state: PortalConnectionState): number { return state === "active" ? 0 : state === "reconnecting" ? 1 : state === "elsewhere" ? 2 : 3; }
