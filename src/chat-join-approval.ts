import { randomUUID } from "crypto";
import { ChatPersistence, normalizeChatAlias, ParticipantIdentityState } from "./chat-persistence";

export type JoinApprovalOutcome = "new" | "reuse" | "reject" | "timeout" | "cancel";

export interface JoinApprovalResult {
  outcome: JoinApprovalOutcome;
  participantId?: string;
  reason?: string;
}

export interface PendingJoinApproval {
  requestId: string;
  connectionId: string;
  roomId: string;
  alias: string;
  aliasKey: string;
  kind: string;
  requestedAt: number;
  expiresAt: number;
  reusableParticipants: { participantId: string; previousAlias?: string; kind: string }[];
}

interface PendingEntry extends PendingJoinApproval {
  clientKey: string;
  status: "pending" | "settling";
  timer?: NodeJS.Timeout;
  resolve: (result: JoinApprovalResult) => void;
}

export class ChatJoinApprovalManager {
  private pending = new Map<string, PendingEntry>();

  constructor(
    private readonly persistence: ChatPersistence,
    private readonly isParticipantOnline: (roomId: string, participantId: string) => boolean,
    private readonly timeoutMs = 120_000,
    private readonly onChanged?: () => void,
  ) {}

  async request(roomId: string, connectionId: string, alias: string, clientKey: string, kind: string): Promise<{ approval: PendingJoinApproval; result: Promise<JoinApprovalResult> }> {
    const requestedAt = Date.now();
    const requestId = randomUUID();
    const aliasKey = normalizeChatAlias(alias);
    const expiresAt = requestedAt + this.timeoutMs;
    await this.persistence.requestJoin(roomId, { requestId, alias, aliasKey, clientKey, kind, requestedAt, expiresAt });
    let state: ParticipantIdentityState;
    try { state = await this.persistence.identityState(roomId); }
    catch (error) {
      await this.persistence.resolveJoin(roomId, {
        requestId, outcome: "cancel", resolvedAt: Date.now(), reason: "Could not prepare automatic Room identity assignment.",
      });
      throw error;
    }
    let resolve!: (result: JoinApprovalResult) => void;
    const result = new Promise<JoinApprovalResult>(done => { resolve = done; });
    const entry: PendingEntry = {
      requestId, connectionId, roomId, alias, aliasKey, clientKey, kind, requestedAt, expiresAt,
      reusableParticipants: this.reusableParticipants(roomId, state),
      status: "pending", resolve,
    };
    this.pending.set(requestId, entry);
    this.armTimeout(entry);
    this.onChanged?.();
    return { approval: this.publicEntry(entry), result };
  }

  async approveAutomatic(requestId: string): Promise<void> {
    const entry = this.requirePending(requestId);
    const state = await this.persistence.identityState(entry.roomId);
    const previous = [...state.pendingJoins].reverse().find(item =>
      item.requestId !== requestId && item.clientKey === entry.clientKey &&
      (item.status === "approved_new" || item.status === "approved_reuse") && !!item.participantId);
    const membership = previous?.participantId
      ? state.memberships.find(item => item.participantId === previous.participantId && item.forgottenAt == null)
      : undefined;
    if (membership && !this.isParticipantOnline(entry.roomId, membership.participantId)) {
      await this.settle(requestId, { outcome: "reuse", participantId: membership.participantId });
    } else {
      await this.settle(requestId, { outcome: "new", participantId: randomUUID() });
    }
  }

  list(roomId?: string): PendingJoinApproval[] {
    return [...this.pending.values()]
      .filter(entry => entry.status === "pending" && (!roomId || entry.roomId === roomId))
      .map(entry => this.publicEntry(entry));
  }

  async approveNew(requestId: string): Promise<void> {
    await this.settle(requestId, { outcome: "new", participantId: randomUUID() });
  }

  async approveReuse(requestId: string, participantId: string): Promise<void> {
    const entry = this.requirePending(requestId);
    const state = await this.persistence.identityState(entry.roomId);
    const membership = state.memberships.find(item => item.participantId === participantId);
    if (!membership) throw new Error(`Participant ${participantId} was not found.`);
    if (membership.forgottenAt != null) throw new Error(`Participant ${participantId} was forgotten.`);
    if (this.isParticipantOnline(entry.roomId, participantId)) throw new Error("Only an offline participant identity can be reused.");
    await this.settle(requestId, { outcome: "reuse", participantId });
  }

  async reject(requestId: string, reason = "Rejected by the Host."): Promise<void> {
    await this.settle(requestId, { outcome: "reject", reason });
  }

  async cancelConnection(connectionId: string, reason = "Join connection closed."): Promise<void> {
    const ids = [...this.pending.values()].filter(entry => entry.connectionId === connectionId && entry.status === "pending").map(entry => entry.requestId);
    for (const requestId of ids) await this.settle(requestId, { outcome: "cancel", reason });
  }

  async cancelRoom(roomId: string, reason = "Room deactivated."): Promise<void> {
    const ids = [...this.pending.values()].filter(entry => entry.roomId === roomId && entry.status === "pending").map(entry => entry.requestId);
    for (const requestId of ids) await this.settle(requestId, { outcome: "cancel", reason });
  }

  async dispose(reason = "Room deactivated."): Promise<void> {
    const ids = [...this.pending.values()].filter(entry => entry.status === "pending").map(entry => entry.requestId);
    for (const requestId of ids) await this.settle(requestId, { outcome: "cancel", reason });
  }

  private reusableParticipants(roomId: string, state: ParticipantIdentityState): PendingJoinApproval["reusableParticipants"] {
    return state.memberships
      .filter(membership => membership.kind !== "browser" && membership.forgottenAt == null && !this.isParticipantOnline(roomId, membership.participantId))
      .map(membership => ({
        participantId: membership.participantId,
        previousAlias: [...state.aliases].reverse().find(alias => alias.participantId === membership.participantId)?.alias,
        kind: membership.kind,
      }));
  }

  private requirePending(requestId: string): PendingEntry {
    const entry = this.pending.get(requestId);
    if (!entry || entry.status !== "pending") throw new Error(`Pending Join ${requestId} was not found or is already resolving.`);
    return entry;
  }

  private async settle(requestId: string, result: JoinApprovalResult): Promise<void> {
    const entry = this.requirePending(requestId);
    entry.status = "settling";
    if (entry.timer) clearTimeout(entry.timer);
    try {
      await this.persistence.resolveJoin(entry.roomId, {
        requestId,
        outcome: result.outcome,
        participantId: result.participantId,
        resolvedAt: Date.now(),
        reason: result.reason,
      });
      this.pending.delete(requestId);
      entry.resolve(result);
      this.onChanged?.();
    } catch (error) {
      entry.status = "pending";
      this.armTimeout(entry);
      throw error;
    }
  }

  private armTimeout(entry: PendingEntry): void {
    const delay = Math.max(0, entry.expiresAt - Date.now());
    entry.timer = setTimeout(() => {
      if (entry.status !== "pending") return;
      void this.settle(entry.requestId, { outcome: "timeout", reason: "Automatic Room identity assignment timed out." }).catch(() => {});
    }, delay);
    entry.timer.unref?.();
  }

  private publicEntry(entry: PendingEntry): PendingJoinApproval {
    const { requestId, connectionId, roomId, alias, aliasKey, kind, requestedAt, expiresAt, reusableParticipants } = entry;
    return { requestId, connectionId, roomId, alias, aliasKey, kind, requestedAt, expiresAt, reusableParticipants };
  }
}