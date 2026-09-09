import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface ChatRoomCredentialHashes {
  hostCredentialHash: string;
  joinSecretHash: string;
}

export interface ChatRoomCredentials extends ChatRoomCredentialHashes {
  hostCredential: string;
  joinSecret: string;
}

export interface ChatRoomHostProof { timestamp: number; nonce: string; signature: string; }

export function hashChatRoomCredential(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashMatches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashChatRoomCredential(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class ChatRoomCredentialStore {
  constructor(private readonly secrets: SecretStorageLike) {}

  async create(roomId: string, requestedJoinSecret?: string): Promise<ChatRoomCredentials> {
    const existing = await this.load(roomId);
    if (existing) throw new Error(`Credentials already exist for Room ${roomId}.`);
    const hostCredential = randomBytes(32).toString("base64url");
    const joinSecret = requestedJoinSecret || randomBytes(24).toString("base64url");
    await this.secrets.store(this.hostKey(roomId), hostCredential);
    try { await this.secrets.store(this.joinKey(roomId), joinSecret); }
    catch (error) { await this.secrets.delete(this.hostKey(roomId)); throw error; }
    return this.withHashes(hostCredential, joinSecret);
  }

  async load(roomId: string): Promise<ChatRoomCredentials | undefined> {
    const [hostCredential, joinSecret] = await Promise.all([
      this.secrets.get(this.hostKey(roomId)),
      this.secrets.get(this.joinKey(roomId)),
    ]);
    if (!hostCredential && !joinSecret) return undefined;
    if (!hostCredential || !joinSecret) throw new Error(`Room ${roomId} has incomplete credentials.`);
    return this.withHashes(hostCredential, joinSecret);
  }

  async verifyHost(roomId: string, expectedHash: string): Promise<boolean> {
    const value = await this.secrets.get(this.hostKey(roomId));
    return !!value && hashMatches(value, expectedHash);
  }

  async createHostProof(roomId: string, purpose: string): Promise<ChatRoomHostProof> {
    const hostCredential = await this.secrets.get(this.hostKey(roomId));
    if (!hostCredential) throw new Error(`Host credential is missing for Room ${roomId}.`);
    const timestamp = Date.now();
    const nonce = randomBytes(16).toString("base64url");
    const signature = createHmac("sha256", hostCredential).update(`${purpose}\n${timestamp}\n${nonce}`).digest("base64url");
    return { timestamp, nonce, signature };
  }

  async verifyHostProof(roomId: string, expectedHash: string, purpose: string, proof: ChatRoomHostProof): Promise<boolean> {
    if (!Number.isFinite(proof.timestamp) || Math.abs(Date.now() - proof.timestamp) > 30_000 || !/^[A-Za-z0-9_-]{16,}$/.test(proof.nonce)) return false;
    const hostCredential = await this.secrets.get(this.hostKey(roomId));
    if (!hostCredential || !hashMatches(hostCredential, expectedHash)) return false;
    const expected = Buffer.from(createHmac("sha256", hostCredential).update(`${purpose}\n${proof.timestamp}\n${proof.nonce}`).digest("base64url"));
    const actual = Buffer.from(String(proof.signature || ""));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async rotateJoinSecret(roomId: string): Promise<{ joinSecret: string; joinSecretHash: string }> {
    if (!await this.secrets.get(this.hostKey(roomId))) throw new Error(`Host credential is missing for Room ${roomId}.`);
    const joinSecret = randomBytes(24).toString("base64url");
    await this.secrets.store(this.joinKey(roomId), joinSecret);
    return { joinSecret, joinSecretHash: hashChatRoomCredential(joinSecret) };
  }

  async replaceJoinSecret(roomId: string, joinSecret: string): Promise<void> {
    if (!await this.secrets.get(this.hostKey(roomId))) throw new Error(`Host credential is missing for Room ${roomId}.`);
    await this.secrets.store(this.joinKey(roomId), joinSecret);
  }

  async delete(roomId: string): Promise<void> {
    await Promise.all([
      this.secrets.delete(this.hostKey(roomId)),
      this.secrets.delete(this.joinKey(roomId)),
    ]);
  }

  private withHashes(hostCredential: string, joinSecret: string): ChatRoomCredentials {
    return {
      hostCredential,
      joinSecret,
      hostCredentialHash: hashChatRoomCredential(hostCredential),
      joinSecretHash: hashChatRoomCredential(joinSecret),
    };
  }

  private hostKey(roomId: string): string { return `personalKnowledge.chatroom.${roomId}.host`; }
  private joinKey(roomId: string): string { return `personalKnowledge.chatroom.${roomId}.join`; }
}