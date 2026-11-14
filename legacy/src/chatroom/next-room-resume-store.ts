import { createHash } from "crypto";
import type { SecretStorageLike } from "./chat-room-credentials";

export interface NextRoomResumeCredential {
  roomId: string;
  url: string;
  clientId: string;
  participantId: string;
  secret: string;
}

function valid(value: unknown): value is NextRoomResumeCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "clientId,participantId,roomId,secret,url"
    || typeof record.roomId !== "string" || !/^[A-Za-z0-9_-]{6,80}$/.test(record.roomId)
    || typeof record.clientId !== "string" || !record.clientId || record.clientId.length > 32
    || typeof record.participantId !== "string" || !record.participantId || record.participantId.length > 128
    || typeof record.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(record.secret)
    || typeof record.url !== "string" || record.url.length > 2048) return false;
  try {
    const url = new URL(record.url);
    return ["ws:", "wss:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

/** Stores participant proof only in the extension's SecretStorage, scoped to an exact endpoint. */
export class NextRoomResumeStore {
  constructor(private readonly secrets: SecretStorageLike) {}

  private key(roomId: string, url: string, clientId: string): string {
    return `personalKnowledge.chatroom.resume.${createHash("sha256").update(JSON.stringify([roomId, url, clientId])).digest("hex")}`;
  }

  private nameKey(room: string, url: string, clientId: string): string {
    return `personalKnowledge.chatroom.resume-name.${createHash("sha256").update(JSON.stringify([room, url, clientId])).digest("hex")}`;
  }

  async save(credential: NextRoomResumeCredential, room?: string): Promise<void> {
    if (!valid(credential)) throw new Error("Invalid Room participant credential.");
    await this.secrets.store(this.key(credential.roomId, credential.url, credential.clientId), JSON.stringify(credential));
    if (room && room.length <= 512)
      await this.secrets.store(this.nameKey(room, credential.url, credential.clientId), credential.roomId);
  }

  async loadByName(room: string, url: string, clientId: string): Promise<NextRoomResumeCredential | undefined> {
    if (!room || room.length > 512) return undefined;
    const roomId = await this.secrets.get(this.nameKey(room, url, clientId));
    return roomId && /^[A-Za-z0-9_-]{6,80}$/.test(roomId) ? this.load(roomId, url, clientId) : undefined;
  }

  async deleteName(room: string, url: string, clientId: string): Promise<void> {
    await this.secrets.delete(this.nameKey(room, url, clientId));
  }

  async load(roomId: string, url: string, clientId: string): Promise<NextRoomResumeCredential | undefined> {
    const raw = await this.secrets.get(this.key(roomId, url, clientId));
    if (!raw || Buffer.byteLength(raw) > 4096) return undefined;
    try {
      const credential: unknown = JSON.parse(raw);
      return valid(credential) && credential.roomId === roomId && credential.url === url && credential.clientId === clientId
        ? credential : undefined;
    } catch { return undefined; }
  }

  async delete(roomId: string, url: string, clientId: string): Promise<void> {
    await this.secrets.delete(this.key(roomId, url, clientId));
  }
}
