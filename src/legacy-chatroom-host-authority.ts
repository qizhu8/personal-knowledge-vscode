import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Storage } from "./storage.js";
import { inspectLegacyChatroomArchive } from "./legacy-chatroom-continuation.js";
import { inspectNativeRoom } from "./native-chatroom-identity.js";
import { resolveRoomJoinSecretHash } from "./next-room-secret-state.js";

type Binding = { root: string; workspaceId: string; actorId: string; roomId: string;
  sourceFingerprint: string; operation: "reopen" };
type Credentials = { hostCredential: string; hostCredentialHash: string; joinSecretHash: string; joinSecret: string };
type CredentialStore = { verifyHost(roomId: string, hash: string): Promise<boolean>;
  load(roomId: string): Promise<Credentials | undefined> };
type Grant = object;
type GrantData = { binding: Binding; joinSecret: string; hostParticipantId?: string; revalidate(): Promise<boolean> };
const grants = new WeakMap<Grant, GrantData>();

function sameHash(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * The embedding VS Code host must supply its real ChatRoomCredentialStore and
 * independently authorize the caller. A room secret or client ID is not host authority.
 */
export function createLegacyChatroomHostAuthority(options: {
  storage: Storage; actorId: string; credentials: CredentialStore;
  authorizeActor(binding: Readonly<Binding>): Promise<boolean>;
}): (binding: Binding) => Promise<Grant | false> {
  return async binding => {
    options.storage.assertWorkspaceLease();
    if (binding.root !== options.storage.workspaceRoot() || binding.workspaceId !== await options.storage.workspaceId()
      || binding.actorId !== options.actorId || binding.operation !== "reopen"
      || !await options.authorizeActor(Object.freeze({ ...binding }))) return false;
    const native = inspectNativeRoom(options.storage, binding.roomId);
    const archive = native ? undefined : inspectLegacyChatroomArchive(binding.root, binding.roomId);
    if ((native?.sourceFingerprint ?? archive?.sourceFingerprint) !== binding.sourceFingerprint) return false;
    let metadata: Record<string, unknown> | undefined;
    if (native) metadata = { owner_installation_id: "native:local", host_credential_hash: native.hostCredentialHash,
      join_secret_hash: native.joinSecretHash, host_participant_id: null };
    else {
      const database = new DatabaseSync(join(binding.root, "chatrooms", binding.roomId, "chatroom.db"), { readOnly: true });
      try {
        database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
        const columns = database.prepare("PRAGMA table_info(room_metadata)").all().map(row => row.name);
        if (!["owner_installation_id", "host_credential_hash", "join_secret_hash", "host_participant_id"]
          .every(column => columns.includes(column))) return false;
        metadata = database.prepare(`SELECT owner_installation_id,host_credential_hash,join_secret_hash,host_participant_id
          FROM room_metadata WHERE room_id=?`).get(binding.roomId);
      } finally { database.close(); }
    }
    if (!metadata || typeof metadata.owner_installation_id !== "string" || !metadata.owner_installation_id
      || typeof metadata.host_credential_hash !== "string" || typeof metadata.join_secret_hash !== "string"
      || (metadata.host_participant_id !== null && typeof metadata.host_participant_id !== "string")) return false;
    if (!await options.credentials.verifyHost(binding.roomId, metadata.host_credential_hash)) return false;
    const credentials = await options.credentials.load(binding.roomId);
    const joinSecretHash = credentials && typeof credentials.joinSecret === "string"
      ? resolveRoomJoinSecretHash(options.storage, binding.roomId, metadata.join_secret_hash, credentials.joinSecret)
      : metadata.join_secret_hash;
    if (!credentials || typeof credentials.hostCredential !== "string" || !credentials.hostCredential
      || typeof credentials.joinSecret !== "string" || !credentials.joinSecret
      || !sameHash(credentials.hostCredentialHash, metadata.host_credential_hash)
      || !sameHash(credentials.joinSecretHash, joinSecretHash)
      || !sameHash(createHash("sha256").update(credentials.hostCredential).digest("hex"), metadata.host_credential_hash)
      || !sameHash(createHash("sha256").update(credentials.joinSecret).digest("hex"), joinSecretHash)) return false;
    options.storage.assertWorkspaceLease();
    if (!await options.authorizeActor(Object.freeze({ ...binding }))) return false;
    options.storage.assertWorkspaceLease();
    const stillCurrent = () => native
      ? JSON.stringify(inspectNativeRoom(options.storage, binding.roomId)) === JSON.stringify(native)
      : inspectLegacyChatroomArchive(binding.root, binding.roomId).sourceFingerprint === archive!.sourceFingerprint;
    if (!stillCurrent()) return false;
    const grant = Object.freeze({});
    grants.set(grant, { binding: { ...binding }, joinSecret: credentials.joinSecret,
      ...(metadata.host_participant_id ? { hostParticipantId: metadata.host_participant_id as string } : {}),
      async revalidate() {
        options.storage.assertWorkspaceLease();
        if (!await options.authorizeActor(Object.freeze({ ...binding }))
          || !await options.credentials.verifyHost(binding.roomId, metadata!.host_credential_hash as string)) return false;
        const current = await options.credentials.load(binding.roomId);
        if (!current || typeof current.hostCredential !== "string" || typeof current.joinSecret !== "string"
          || !sameHash(createHash("sha256").update(current.hostCredential).digest("hex"), metadata!.host_credential_hash as string)
          || !sameHash(createHash("sha256").update(current.joinSecret).digest("hex"), joinSecretHash)
          || current.joinSecret !== credentials.joinSecret) return false;
        options.storage.assertWorkspaceLease();
        if (!await options.authorizeActor(Object.freeze({ ...binding }))) return false;
        options.storage.assertWorkspaceLease();
        return stillCurrent();
      } });
    return grant;
  };
}

export async function consumeLegacyChatroomHostGrant(value: unknown, binding: Binding):
Promise<Pick<GrantData, "joinSecret" | "hostParticipantId"> | undefined> {
  if (!value || typeof value !== "object") return undefined;
  const data = grants.get(value);
  grants.delete(value);
  if (!data || Object.keys(binding).some(key => binding[key as keyof Binding] !== data.binding[key as keyof Binding])
    || !await data.revalidate())
    return undefined;
  return { joinSecret: data.joinSecret, hostParticipantId: data.hostParticipantId };
}
