import { Worker } from "worker_threads";
import * as path from "path";
import { randomUUID } from "crypto";

export interface PersistedChatMessage {
  id: string;
  participantId?: string;
  aliasAtSend: string;
  senderKind: string;
  messageType: string;
  content: string;
  metadata?: unknown;
  createdAt: number;
}

export interface OpenRoomResult {
  messages: PersistedChatMessage[];
  replayed: number;
}

export interface StoredRoomInfo {
  roomId: string;
  roomName: string;
  state: "stored";
  updatedAt: number;
  messageCount: number;
  ownerInstallationId?: string;
  hostCredentialHash?: string;
  joinSecretHash?: string;
  hostParticipantId?: string;
}

export interface RoomCredentialsMetadata {
  ownerInstallationId: string;
  hostCredentialHash: string;
  joinSecretHash: string;
}

export type JoinDecision = "new" | "reuse" | "reject" | "timeout" | "cancel";

export interface PersistedPendingJoinRequest {
  requestId: string;
  alias: string;
  aliasKey: string;
  kind: string;
  requestedAt: number;
  expiresAt: number;
}

export interface PersistedJoinResolution {
  requestId: string;
  outcome: JoinDecision;
  participantId?: string;
  resolvedAt: number;
  reason?: string;
}

export interface ParticipantIdentityState {
  memberships: { participantId: string; kind: string; role: string; createdAt: number; updatedAt: number; forgottenAt?: number }[];
  aliases: { aliasKey: string; alias: string; participantId: string; assignedAt: number; releasedAt?: number }[];
  pendingJoins: { requestId: string; aliasKey: string; alias: string; kind: string; status: string; requestedAt: number; expiresAt: number; resolvedAt?: number; participantId?: string; reason?: string }[];
}

export function normalizeChatAlias(alias: string): string {
  return alias.trim().normalize("NFKC").toLocaleLowerCase();
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export class ChatPersistence {
  private worker: Worker;
  private ready: Promise<void>;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private log: (message: string) => void;

  constructor(rootDir: string, flushDelayMs = 500, historyLimitBytes = 0, logger?: (message: string) => void) {
    this.log = logger ?? (() => {});
    this.worker = new Worker(path.join(__dirname, "chat-persistence-worker.js"), {
      workerData: { rootDir, flushDelayMs, historyLimitBytes },
    });
    this.ready = new Promise((resolve, reject) => {
      const onMessage = (message: any) => {
        if (message?.event === "ready") { this.worker.off("error", reject); resolve(); }
        else if (message?.event === "fatal") reject(new Error(message.error || "Chat persistence worker failed."));
      };
      this.worker.on("message", onMessage);
      this.worker.once("error", reject);
    });
    this.worker.on("message", message => this.onMessage(message));
    this.worker.on("error", error => this.failAll(error instanceof Error ? error : new Error(String(error))));
    this.worker.on("exit", code => {
      if (code !== 0) this.failAll(new Error(`Chat persistence worker exited with code ${code}.`));
    });
  }

  async openRoom(roomId: string, roomName: string): Promise<OpenRoomResult> {
    return this.request("open", { roomId, roomName });
  }

  async createRoom(roomId: string, roomName: string, credentials: RoomCredentialsMetadata): Promise<OpenRoomResult> {
    return this.request("create", { roomId, roomName, credentials });
  }

  async recordLifecycle(roomId: string, type: string, state?: "active" | "stored", payload?: unknown): Promise<void> {
    await this.request("lifecycle", { roomId, event: { id: randomUUID(), type, state, payload, createdAt: Date.now() } });
  }

  async listStoredRooms(): Promise<StoredRoomInfo[]> {
    return this.request("list", {});
  }

  async setRoomState(roomId: string, state: "active" | "stored"): Promise<void> {
    await this.request("setState", { roomId, state });
  }

  async append(roomId: string, message: PersistedChatMessage): Promise<void> {
    await this.request("append", { roomId, message });
  }

  async appendMany(roomId: string, messages: PersistedChatMessage[]): Promise<void> {
    await this.request("appendMany", { roomId, messages });
  }

  async requestJoin(roomId: string, request: Omit<PersistedPendingJoinRequest, "aliasKey"> & { aliasKey?: string }): Promise<void> {
    await this.request("requestJoin", { roomId, joinRequest: { ...request, aliasKey: request.aliasKey ?? normalizeChatAlias(request.alias) } });
  }

  async resolveJoin(roomId: string, resolution: PersistedJoinResolution): Promise<void> {
    await this.request("resolveJoin", { roomId, resolution });
  }

  async releaseAlias(roomId: string, participantId: string, releasedAt: number, alias?: string): Promise<void> {
    await this.request("releaseAlias", { roomId, aliasRelease: { participantId, releasedAt, aliasKey: alias ? normalizeChatAlias(alias) : undefined } });
  }

  async renameAlias(roomId: string, participantId: string, alias: string, renamedAt: number): Promise<void> {
    await this.request("renameAlias", { roomId, aliasRename: { participantId, alias, aliasKey: normalizeChatAlias(alias), renamedAt } });
  }

  async setParticipantRole(roomId: string, participantId: string, role: string, updatedAt: number): Promise<void> {
    await this.request("setParticipantRole", { roomId, roleUpdate: { participantId, role, updatedAt } });
  }

  async forgetParticipant(roomId: string, participantId: string, forgottenAt: number): Promise<void> {
    await this.request("forgetParticipant", { roomId, participantForget: { participantId, forgottenAt } });
  }

  async identityState(roomId: string): Promise<ParticipantIdentityState> {
    return this.request("identityState", { roomId });
  }

  async flush(roomId: string): Promise<{ bytes: number }> {
    return this.request("flush", { roomId });
  }

  async closeRoom(roomId: string, reason = "closed"): Promise<{ bytes: number }> {
    return this.request("close", { roomId, reason });
  }

  async dispose(): Promise<void> {
    try { await this.request("shutdown", {}); }
    finally { await this.worker.terminate(); }
  }

  private async request(op: string, data: object): Promise<any> {
    await this.ready;
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, ...data });
    });
  }

  private onMessage(message: any): void {
    if (message?.event === "flushError") {
      this.log(`chat persistence flush failed for ${message.roomId}: ${message.error}`);
      return;
    }
    if (!message?.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.data);
    else pending.reject(new Error(message.error || "Chat persistence request failed."));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
