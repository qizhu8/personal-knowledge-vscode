import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { ChatRoomLock } from "./chat-room-lock";
import { ChatRoomCredentialStore, SecretStorageLike } from "./chat-room-credentials";
import { ChatPersistence, OpenRoomResult, ParticipantIdentityState, StoredRoomInfo } from "./chat-persistence";

export interface ActiveChatRoom extends OpenRoomResult {
  roomId: string;
  roomName: string;
  joinSecret: string;
  hostParticipantId?: string;
  identityState: ParticipantIdentityState;
}

export interface StoredChatRoom {
  roomId: string;
  roomName: string;
  updatedAt: number;
  messageCount: number;
  canRehost: boolean;
  activeElsewhere?: boolean;
  activeUrl?: string;
  unavailableReason?: string;
}

export class ChatRoomLifecycle {
  readonly persistence: ChatPersistence;
  private readonly credentials: ChatRoomCredentialStore;
  private readonly locks = new Map<string, ChatRoomLock>();

  constructor(
    private readonly rootDir: string,
    private readonly installationId: string,
    secrets: SecretStorageLike,
    flushDelayMs = 500,
    historyLimitBytes = 0,
    logger?: (message: string) => void,
  ) {
    this.credentials = new ChatRoomCredentialStore(secrets);
    this.persistence = new ChatPersistence(rootDir, flushDelayMs, historyLimitBytes, logger);
  }

  async listStoredRooms(): Promise<StoredChatRoom[]> {
    const records = await this.listStoredRoomRecords();
    const result: StoredChatRoom[] = [];
    for (const room of records) {
      const hostVerified = !!room.hostCredentialHash && await this.credentials.verifyHost(room.roomId, room.hostCredentialHash);
      if (room.ownerInstallationId !== this.installationId && !hostVerified) continue;
      let unavailableReason: string | undefined;
      if (!room.hostCredentialHash) unavailableReason = "Host credential metadata is missing.";
      else if (!hostVerified) unavailableReason = "Host credential is missing or invalid.";
      else if (room.state === "active") unavailableReason = room.activeUrl
        ? "Active in another VS Code window."
        : "Active in another VS Code window; endpoint unavailable.";
      result.push({
        roomId: room.roomId,
        roomName: room.roomName,
        updatedAt: room.updatedAt,
        messageCount: room.messageCount,
        canRehost: room.state === "stored" && !unavailableReason,
        activeElsewhere: room.state === "active",
        activeUrl: room.activeUrl,
        unavailableReason,
      });
    }
    return result;
  }

  private async listStoredRoomRecords(): Promise<StoredRoomInfo[]> {
    this.recoverStaleLocks();
    return this.persistence.listStoredRooms();
  }

  async createRoom(roomName: string, requestedJoinSecret?: string): Promise<ActiveChatRoom> {
    const roomId = randomUUID();
    const roomDir = path.join(this.rootDir, roomId);
    fs.mkdirSync(roomDir, { recursive: true });
    const lock = ChatRoomLock.acquire(path.join(roomDir, "chatroom.lock"), this.installationId);
    try {
      const credentials = await this.credentials.create(roomId, requestedJoinSecret);
      try {
        const opened = await this.persistence.createRoom(roomId, roomName, {
          ownerInstallationId: this.installationId,
          hostCredentialHash: credentials.hostCredentialHash,
          joinSecretHash: credentials.joinSecretHash,
        });
        this.locks.set(roomId, lock);
        return { roomId, roomName, joinSecret: credentials.joinSecret, identityState: await this.persistence.identityState(roomId), ...opened };
      } catch (error) {
        await this.credentials.delete(roomId);
        throw error;
      }
    } catch (error) {
      lock.release();
      try { fs.rmSync(roomDir, { recursive: true, force: true }); } catch { /* best-effort rollback of a new UUID */ }
      throw error;
    }
  }

  publishActiveDescriptor(roomId: string, roomName: string, activeUrl: string): void {
    const lock = this.locks.get(roomId);
    if (!lock) throw new Error(`Room ${roomId} is not active in this Hub.`);
    lock.updateDescriptor({ roomId, roomName, activeUrl });
  }

  async rehostRoom(roomId: string): Promise<ActiveChatRoom> {
    if (this.locks.has(roomId)) throw new Error(`Room ${roomId} is already active in this Hub.`);
    const stored = (await this.listStoredRoomRecords()).find(room => room.roomId === roomId);
    if (!stored) throw new Error(`Stored Room ${roomId} was not found or is hosted elsewhere.`);
    if (!stored.ownerInstallationId || !stored.hostCredentialHash) throw new Error(`Room ${roomId} has no Host credential metadata.`);
    const hostVerified = await this.credentials.verifyHost(roomId, stored.hostCredentialHash);
    if (stored.ownerInstallationId !== this.installationId && !hostVerified) throw new Error("This Extension installation does not own the Room.");
    if (!hostVerified) throw new Error("The Room Host credential is missing or invalid.");
    const credentials = await this.credentials.load(roomId);
    if (!credentials) throw new Error("The Room credentials are missing.");
    const lock = ChatRoomLock.acquire(path.join(this.rootDir, roomId, "chatroom.lock"), this.installationId);
    try {
      const opened = await this.persistence.openRoom(roomId, stored.roomName);
      await this.persistence.recordLifecycle(roomId, "room.rehosted", "active");
      this.locks.set(roomId, lock);
      return { roomId, roomName: stored.roomName, joinSecret: credentials.joinSecret, hostParticipantId: stored.hostParticipantId, identityState: await this.persistence.identityState(roomId), ...opened };
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  async deactivateRoom(roomId: string, reason: string): Promise<void> {
    const lock = this.locks.get(roomId);
    if (!lock) return;
    try { await this.persistence.closeRoom(roomId, reason); }
    finally { this.locks.delete(roomId); lock.release(); }
  }

  async rotateJoinSecret(roomId: string): Promise<string> {
    if (!this.locks.has(roomId)) throw new Error(`Room ${roomId} is not active in this Hub.`);
    const previous = await this.credentials.load(roomId);
    if (!previous) throw new Error("The Room credentials are missing.");
    const rotated = await this.credentials.rotateJoinSecret(roomId);
    try {
      await this.persistence.recordLifecycle(roomId, "room.secret_rotated", undefined, { joinSecretHash: rotated.joinSecretHash });
      return rotated.joinSecret;
    } catch (error) {
      await this.credentials.replaceJoinSecret(roomId, previous.joinSecret);
      throw error;
    }
  }

  async renameStoredRoom(roomId: string, roomName: string): Promise<void> {
    const normalizedName = roomName.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!normalizedName) throw new Error("Room name is required.");
    const stored = await this.requireOwnedStoredRoom(roomId);
    const records = await this.listStoredRoomRecords();
    if (records.some(room => room.roomId !== roomId && room.roomName.trim().toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) {
      throw new Error(`A stored Room named "${normalizedName}" already exists.`);
    }
    const lock = ChatRoomLock.acquire(path.join(this.rootDir, roomId, "chatroom.lock"), this.installationId);
    try {
      await this.persistence.openRoom(roomId, stored.roomName);
      await this.persistence.recordLifecycle(roomId, "room.renamed", undefined, { roomName: normalizedName });
      await this.persistence.closeRoom(roomId, "renamed");
    } finally {
      lock.release();
    }
  }

  async renameActiveRoom(roomId: string, roomName: string): Promise<string> {
    if (!this.locks.has(roomId)) throw new Error(`Room ${roomId} is not active in this Hub.`);
    const normalizedName = roomName.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!normalizedName) throw new Error("Room name is required.");
    const records = await this.listStoredRoomRecords();
    if (records.some(room => room.roomId !== roomId && room.roomName.trim().toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) {
      throw new Error(`A stored Room named "${normalizedName}" already exists.`);
    }
    await this.persistence.recordLifecycle(roomId, "room.renamed", undefined, { roomName: normalizedName });
    return normalizedName;
  }

  async deleteStoredRoom(roomId: string): Promise<void> {
    await this.requireOwnedStoredRoom(roomId);
    const roomDir = path.join(this.rootDir, roomId);
    const lock = ChatRoomLock.acquire(path.join(roomDir, "chatroom.lock"), this.installationId);
    try {
      fs.rmSync(roomDir, { recursive: true, force: false });
    } finally {
      lock.release();
    }
    await this.credentials.delete(roomId);
  }

  async dispose(): Promise<void> {
    for (const roomId of [...this.locks.keys()]) await this.deactivateRoom(roomId, "hub-shutdown");
    await this.persistence.dispose();
  }

  private recoverStaleLocks(): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const lockPath = path.join(this.rootDir, entry.name, "chatroom.lock");
      if (!fs.existsSync(lockPath)) continue;
      try { ChatRoomLock.acquire(lockPath, this.installationId).release(); }
      catch { /* a live or remotely-owned lock remains authoritative */ }
    }
  }

  private async requireOwnedStoredRoom(roomId: string): Promise<StoredRoomInfo> {
    const stored = (await this.listStoredRoomRecords()).find(room => room.roomId === roomId);
    if (!stored) throw new Error(`Stored Room ${roomId} was not found or is hosted elsewhere.`);
    const hostVerified = !!stored.hostCredentialHash && await this.credentials.verifyHost(roomId, stored.hostCredentialHash);
    if (stored.ownerInstallationId !== this.installationId && !hostVerified) throw new Error("This Extension installation does not own the Room.");
    if (!hostVerified) {
      throw new Error("The Room Host credential is missing or invalid.");
    }
    return stored;
  }
}