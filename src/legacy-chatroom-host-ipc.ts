import { randomUUID } from "node:crypto";
import type { LegacyParticipantRebind } from "./legacy-chatroom-runtime.js";

type Binding = { root: string; workspaceId: string; actorId: string; roomId: string;
  sourceFingerprint: string; operation: "reopen" };
type Credentials = { hostCredential: string; joinSecret: string; hostCredentialHash: string; joinSecretHash: string };

/** Uses only the inherited IPC channel of the trusted extension-host parent. */
export function attachLegacyChatroomHostIpc(options: {
  session: string;
  binding: Binding;
  onRevoked(): void;
}): {
  authorizeActor(binding: Readonly<Binding>): Promise<boolean>;
  approveParticipant(request: LegacyParticipantRebind): Promise<boolean>;
  credentials: { verifyHost(roomId: string, hash: string): Promise<boolean>; load(roomId: string): Promise<Credentials | undefined> };
  close(): void;
} {
  const binding = Object.freeze({ ...options.binding });
  if (!process.connected || typeof process.send !== "function" || process.ppid <= 1
    || !/^[a-f0-9-]{36}$/.test(options.session) || binding.actorId !== "local:owner"
    || binding.operation !== "reopen") throw new Error("Room host IPC unavailable.");
  const pending = new Map<string, { resolve(value: unknown): void; timer: NodeJS.Timeout }>();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    process.off("message", receive);
    process.off("disconnect", close);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve(undefined); }
    pending.clear();
    options.onRevoked();
  };
  const receive = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const value = raw as Record<string, unknown>;
    if (value.session !== options.session) return;
    if (value.type === "pkm.room.host-revoked/v1") { close(); return; }
    if (value.type !== "pkm.room.host-response/v1" || typeof value.id !== "string") return;
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id); clearTimeout(entry.timer);
    entry.resolve(value.ok === true ? value.result : undefined);
  };
  process.on("message", receive);
  process.once("disconnect", close);
  const request = (operation: "authorize" | "verify" | "load" | "approve-participant", extra: Record<string, unknown> = {}) => {
    if (closed || !process.connected) return Promise.resolve(undefined);
    const id = randomUUID();
    return new Promise<unknown>(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve(undefined); }, operation === "approve-participant" ? 120_000 : 5000);
      pending.set(id, { resolve, timer });
      process.send!({ type: "pkm.room.host-request/v1", session: options.session, id, operation, binding, ...extra },
        error => { if (error) { const entry = pending.get(id); if (entry) {
          pending.delete(id); clearTimeout(entry.timer); entry.resolve(undefined);
        } } });
    });
  };
  return {
    async approveParticipant(candidate) {
      return candidate.roomId === binding.roomId && await request("approve-participant", { candidate }) === true;
    },
    async authorizeActor(candidate) {
      return JSON.stringify(candidate) === JSON.stringify(binding) && await request("authorize") === true;
    },
    credentials: {
      async verifyHost(roomId, expectedHash) {
        return roomId === binding.roomId && await request("verify", { expectedHash }) === true;
      },
      async load(roomId) {
        if (roomId !== binding.roomId) return undefined;
        const value = await request("load");
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        const result = value as Record<string, unknown>;
        if (Object.keys(result).sort().join(",") !== "hostCredential,hostCredentialHash,joinSecret,joinSecretHash"
          || !["hostCredential", "joinSecret"].every(key => typeof result[key] === "string"
            && !!result[key] && Buffer.byteLength(result[key] as string) <= 4096)
          || !["hostCredentialHash", "joinSecretHash"].every(key => typeof result[key] === "string"
            && /^[a-f0-9]{64}$/.test(result[key] as string))) return undefined;
        return result as Credentials;
      },
    },
    close,
  };
}
