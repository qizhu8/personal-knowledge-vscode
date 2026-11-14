import type { ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ChatRoomCredentialStore, SecretStorageLike } from "./chat-room-credentials";

export interface NextRoomHostBinding {
  root: string;
  workspaceId: string;
  actorId: "local:owner";
  roomId: string;
  sourceFingerprint: string;
  operation: "reopen";
}
export interface NextRoomParticipantApproval {
  roomId: string; participantId: string; previousAlias: string; requestedAlias: string; clientId: string; kind: string;
  expiresAt: number;
}

/**
 * Attach only to a child forked by the trusted extension host. The binding is
 * fixed by that host's Room action, never by a child or an MCP request.
 */
export function attachNextRoomHostBridge(options: {
  child: ChildProcess;
  secrets: SecretStorageLike;
  binding: NextRoomHostBinding;
  authorized(): boolean | Promise<boolean>;
  approveParticipant?(candidate: NextRoomParticipantApproval): Promise<boolean>;
}): { session: string; close(): void } {
  const { child } = options, binding = Object.freeze({ ...options.binding });
  if (!child.connected || !child.send || !path.isAbsolute(binding.root) || path.resolve(binding.root) !== binding.root
    || fs.realpathSync(binding.root) !== binding.root || binding.actorId !== "local:owner"
    || binding.operation !== "reopen" || !/^[A-Za-z0-9_-]{6,80}$/.test(binding.roomId)
    || !/^[a-f0-9]{64}$/.test(binding.sourceFingerprint) || !binding.workspaceId || binding.workspaceId.length > 200)
    throw new Error("Room host bridge binding denied.");
  const root = fs.lstatSync(binding.root, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Room host root denied.");
  const session = randomUUID(), credentials = new ChatRoomCredentialStore(options.secrets), seen = new Set<string>();
  let closed = false;
  const assertCurrent = async () => {
    try {
      if (closed || !child.connected || !await options.authorized()) throw new Error();
      const now = fs.lstatSync(binding.root, { bigint: true });
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== root.dev || now.ino !== root.ino
        || fs.realpathSync(binding.root) !== binding.root) throw new Error();
    } catch { close(); throw new Error("Room host authority revoked."); }
  };
  const receive = (raw: unknown) => {
    if (closed || !raw || typeof raw !== "object" || Array.isArray(raw)
      || (raw as Record<string, unknown>).type !== "pkm.room.host-request/v1") return;
    const value = raw as Record<string, unknown>;
    const id = value.id;
    const response = (ok: boolean, result?: unknown) => {
      if (!closed && child.connected) child.send!({ type: "pkm.room.host-response/v1", session, id, ok, result },
        error => { if (error) close(); });
    };
    void (async () => {
      if (value.session !== session || typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)
        || seen.has(id) || seen.size >= 4096 || JSON.stringify(value.binding) !== JSON.stringify(binding))
        throw new Error("Room host request denied.");
      const op = value.operation;
      const keys = op === "verify" ? ["binding", "expectedHash", "id", "operation", "session", "type"]
        : op === "approve-participant" ? ["binding", "candidate", "id", "operation", "session", "type"]
        : ["binding", "id", "operation", "session", "type"];
      if (!["authorize", "verify", "load", "approve-participant"].includes(String(op))
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)
        || op === "verify" && (typeof value.expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedHash)))
        throw new Error("Room host request denied.");
      const candidate = value.candidate as NextRoomParticipantApproval | undefined;
      if (op === "approve-participant" && (!options.approveParticipant || !candidate || typeof candidate !== "object"
        || Array.isArray(candidate) || Object.keys(candidate).sort().join(",") !== "clientId,expiresAt,kind,participantId,previousAlias,requestedAlias,roomId"
        || candidate.roomId !== binding.roomId || typeof candidate.participantId !== "string" || !candidate.participantId
        || candidate.participantId.length > 128 || typeof candidate.previousAlias !== "string" || candidate.previousAlias.length > 200
        || typeof candidate.requestedAlias !== "string" || candidate.requestedAlias.length > 60
        || typeof candidate.clientId !== "string" || !candidate.clientId || candidate.clientId.length > 32
        || !["human", "agent", "browser"].includes(candidate.kind) || !Number.isSafeInteger(candidate.expiresAt)
        || candidate.expiresAt <= Date.now() || candidate.expiresAt > Date.now() + 120_000))
        throw new Error("Room participant approval denied.");
      seen.add(id);
      await assertCurrent();
      const result = op === "authorize" ? true
        : op === "verify" ? await credentials.verifyHost(binding.roomId, value.expectedHash as string)
        : op === "approve-participant" ? await options.approveParticipant!(candidate!) === true && Date.now() < candidate!.expiresAt
        : (await credentials.load(binding.roomId) ?? null);
      await assertCurrent();
      response(true, result);
    })().catch(() => { response(false); });
  };
  const close = () => {
    if (closed) return;
    if (child.connected) child.send!({ type: "pkm.room.host-revoked/v1", session }, () => {});
    closed = true;
    clearInterval(heartbeat);
    child.off("message", receive);
    child.off("exit", close);
    child.off("disconnect", close);
  };
  let checking = false;
  const heartbeat = setInterval(() => {
    if (checking) return;
    checking = true;
    void assertCurrent().catch(() => {}).finally(() => { checking = false; });
  }, 1000);
  heartbeat.unref();
  child.on("message", receive);
  child.once("exit", close);
  child.once("disconnect", close);
  return { session, close };
}
