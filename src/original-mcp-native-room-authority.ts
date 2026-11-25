import { randomUUID } from "node:crypto";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, originalMcpPublicRequestMatches, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession } from "./original-mcp-native-attachment.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestSession, requestOriginalMcpNative } from "./original-mcp-native-request.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import { inspectOriginalMcpRoomSource } from "./original-mcp-room-source.js";
import { inspectLegacyChatroomArchive, inspectLegacyChatroomParticipants } from "./legacy-chatroom-continuation.js";
import { inspectRetainedMeetingSource } from "./next-room-meeting-source.js";
import {
  originalNativeRoomDigest, originalNativeRoomResultSchemas, parseOriginalNativeRoomPayload, assertOriginalNativeRoomPacketBudget,
  originalNativeRoomStatusArguments,
  type OriginalNativeRoomMethod, type OriginalNativeRoomSource,
} from "./original-mcp-native-room-contracts.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
type SourceDecision = { source: OriginalNativeRoomSource; decisionId: string; expiresAtMs: number;
  lifetime: AbortController; expiry: ReturnType<typeof setTimeout>; host?: AbortController };
const authorities = new WeakMap<object, { storage: Storage; host: OriginalMcpNativeHost; current(): void }>();
const hostGrants = new WeakMap<object, {
  storage: Storage; host: OriginalMcpNativeHost; roomId: string; current(): void;
  challenge: string; sourceDecisionId: string; executionUsed: boolean; signal: AbortSignal;
}>();
export function assertOriginalMcpNativeRoomAuthority(value: unknown, storage: Storage, host: OriginalMcpNativeHost): void {
  const state = value && typeof value === "object" ? authorities.get(value) : undefined;
  if (!state || state.storage !== storage || state.host !== host) fail("NATIVE_ROOM_AUTHORITY_REQUIRED");
  state.current();
}
export function assertOriginalMcpNativeRoomHostGrant(value: unknown, storage: Storage, host: OriginalMcpNativeHost,
  roomId: string): void {
  const grant = value && typeof value === "object" ? hostGrants.get(value) : undefined;
  if (!grant || grant.storage !== storage || grant.host !== host || grant.roomId !== roomId)
    fail("NATIVE_ROOM_CURRENT_HOST_GRANT_REQUIRED");
  grant.current();
}

/** Source custody and fresh native-profile Host proof are independent, revocable, same-owner capabilities. */
export function createOriginalMcpNativeRoomAuthority(storage: Storage, host: OriginalMcpNativeHost,
  session: AuthenticatedOriginalMcpNativeSession) {
  const lifetime = new AbortController(), decisions = new Map<string, SourceDecision>();
  const pending = new Map<string, AbortController>();
  function current() {
    assertStorage(storage); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    assertAuthenticatedOriginalMcpNativeSession(session);
    const journal = assertOriginalMcpPrivacy(storage.workspaceRoot()), signed = session.binding;
    if (lifetime.signal.aborted || host.signal.aborted || session.signal.aborted) fail("NATIVE_ROOM_SESSION_REVOKED");
    if (!journal || signed.root !== storage.workspaceRoot() || signed.workspaceId !== journal.workspaceId
      || signed.planSha256 !== journal.plan.planSha256 || signed.profileSha256 !== journal.plan.profileSha256
      || signed.root !== host.receipt.root || signed.workspaceId !== host.receipt.workspaceId
      || signed.planSha256 !== host.receipt.planSha256 || signed.profileSha256 !== host.receipt.profileSha256
      || signed.catalogSha256 !== host.receipt.sourceCatalogSha256 || session.activationId !== host.receipt.epoch
      || host.receipt.authorityId !== `native-rpc:${session.brokerId}` || !host.receipt.domains.includes("mcp-public"))
      fail("NATIVE_ROOM_SIGNED_OWNER_BINDING_REQUIRED");
  }
  function revoke(roomId: string) {
    const entry = decisions.get(roomId);
    if (entry) { clearTimeout(entry.expiry); entry.lifetime.abort(); decisions.delete(roomId); }
    pending.get(roomId)?.abort();
  }
  function dispose() {
    lifetime.abort();
    for (const roomId of new Set([...decisions.keys(), ...pending.keys()])) revoke(roomId);
    host.signal.removeEventListener("abort", dispose); session.signal.removeEventListener("abort", dispose);
  }
  function sourceCurrent(entry: SourceDecision) {
    current();
    if (entry.lifetime.signal.aborted || decisions.get(entry.source.roomId) !== entry || entry.expiresAtMs <= Date.now())
      fail("NATIVE_ROOM_SOURCE_REVOKED");
    const source = entry.source;
    try {
      if (inspectLegacyChatroomArchive(source.root, source.roomId).sourceFingerprint !== source.sourceFingerprint
        || originalNativeRoomDigest(inspectLegacyChatroomParticipants(source.root, source.roomId)) !== source.participantSha256
        || inspectRetainedMeetingSource(source.root, source.roomId).hash !== source.meetingSha256)
        fail("NATIVE_ROOM_SOURCE_CHANGED");
    } catch (error) { revoke(source.roomId); throw error; }
  }
  async function request(method: OriginalNativeRoomMethod, source: OriginalNativeRoomSource, extra: object, signal: AbortSignal) {
    current();
    const name = originalMcpNativeRequestMethods.find(candidate => String(candidate) === method);
    if (!name) fail("MISSING_NATIVE_METHOD");
    const { receiptSha256: _receipt, ...binding } = host.receipt;
    const signed = originalMcpNativeRequestSession(session);
    const flags = method === "room.status.read" ? { noNetwork: true, noRehost: true, noParticipantChange: true } : { noExecution: true };
    const payload = parseOriginalNativeRoomPayload(method, { binding, source, ...flags, ...extra }, signed);
    assertOriginalNativeRoomPacketBudget(method, payload, signed);
    const value = await requestOriginalMcpNative(session, name, payload, { signal, timeoutMs: 120000 });
    current();
    if (signal.aborted) fail("NATIVE_ROOM_CANCELLED");
    return value;
  }
  async function operation<T>(roomId: string, signal: AbortSignal | undefined, callback: (signal: AbortSignal) => Promise<T>) {
    current();
    if (pending.has(roomId)) fail("NATIVE_ROOM_BUSY");
    if (!decisions.has(roomId) && new Set([...decisions.keys(), ...pending.keys()]).size >= 32) fail("NATIVE_ROOM_SELECTION_LIMIT");
    const controller = new AbortController(); pending.set(roomId, controller);
    try {
      const combined = AbortSignal.any([controller.signal, lifetime.signal, session.signal, host.signal,
        ...(signal ? [signal] : [])]);
      if (combined.aborted) fail("NATIVE_ROOM_CANCELLED");
      return await callback(combined);
    } finally { pending.delete(roomId); }
  }
  async function admit(roomId: string, signal?: AbortSignal) {
    current();
    if (pending.has(roomId)) fail("NATIVE_ROOM_BUSY");
    revoke(roomId);
    return operation(roomId, signal, async combined => {
      try {
        const source = await inspectOriginalMcpRoomSource(storage, host, roomId);
        const decision = originalNativeRoomResultSchemas["room.source.approve"].parse(
          await request("room.source.approve", source, {}, combined));
        if (!decision) fail("NATIVE_ROOM_SOURCE_DENIED");
        if (decision.expiresAtMs <= Date.now() || decision.expiresAtMs > Date.now() + 300000)
          fail("NATIVE_ROOM_SOURCE_EXPIRED");
        const checked = await inspectOriginalMcpRoomSource(storage, host, roomId);
        if (combined.aborted) fail("NATIVE_ROOM_CANCELLED");
        if (checked.sourceSha256 !== source.sourceSha256) fail("NATIVE_ROOM_SOURCE_CHANGED");
        const expiry = setTimeout(() => revoke(roomId), decision.expiresAtMs - Date.now()); expiry.unref();
        const entry = { source, ...decision, lifetime: new AbortController(), expiry };
        decisions.set(roomId, entry); sourceCurrent(entry);
        return source;
      } catch (error) { revoke(roomId); throw error; }
    });
  }
  async function proveHost(roomId: string, signal?: AbortSignal) {
    return operation(roomId, signal, async combined => {
      const entry = decisions.get(roomId);
      if (!entry) fail("NATIVE_ROOM_SOURCE_REQUIRED");
      sourceCurrent(entry);
      entry.host?.abort(); entry.host = undefined;
      const challenge = randomUUID(), decision = originalNativeRoomResultSchemas["room.host.prove"].parse(
        await request("room.host.prove", entry.source, { challenge, sourceDecisionId: entry.decisionId }, combined));
      sourceCurrent(entry);
      if (!decision) fail("NATIVE_ROOM_HOST_DENIED");
      if (decision.challenge !== challenge || decision.sourceDecisionId !== entry.decisionId
        || decision.sourceSha256 !== entry.source.sourceSha256 || decision.hostParticipantId !== entry.source.hostParticipantId
        || decision.hostCredentialHash !== entry.source.hostCredentialHash || decision.joinSecretHash !== entry.source.joinSecretHash
        || Math.abs(Date.now() - decision.proof.timestamp) > 30000)
        fail("NATIVE_ROOM_HOST_PROOF_MISMATCH");
      const expiry = new AbortController();
      entry.host = expiry;
      const expiresAtMs = Math.min(entry.expiresAtMs, decision.proof.timestamp + 30000, Date.now() + 30000);
      const grant = Object.freeze({ kind: "pkm.original-native-room-host-grant/v1" as const, roomId,
        hostParticipantId: entry.source.hostParticipantId, sourceSha256: entry.source.sourceSha256,
        expiresAtMs, signal: AbortSignal.any([expiry.signal, entry.lifetime.signal, lifetime.signal, host.signal, session.signal]) });
      const timer = setTimeout(() => expiry.abort(), Math.max(0, expiresAtMs - Date.now())); timer.unref();
      grant.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      hostGrants.set(grant, { storage, host, roomId, challenge, sourceDecisionId: entry.decisionId,
        executionUsed: false, signal: grant.signal, current() {
        sourceCurrent(entry);
        if (grant.signal.aborted || entry.host !== expiry || grant.expiresAtMs <= Date.now()) fail("NATIVE_ROOM_HOST_GRANT_EXPIRED");
      } });
      return grant;
    });
  }
  async function readStatus(roomId: string, grant: unknown, input: unknown, signal?: AbortSignal) {
    const args = originalNativeRoomStatusArguments.parse(input);
    const approval = { operation: "mcp.tool.chat_status", version: 1 as const, tool: "chat_status", readOnly: true,
      arguments: args, argumentsDigest: originalNativeRoomDigest(args) };
    if (!originalMcpPublicRequestMatches(storage, host, approval)) fail("NATIVE_ROOM_EXACT_PUBLIC_REQUEST_REQUIRED");
    assertOriginalMcpNativeRoomHostGrant(grant, storage, host, roomId);
    const credential = hostGrants.get(grant as object)!;
    if (credential.executionUsed) fail("NATIVE_ROOM_HOST_EXECUTION_REPLAY");
    credential.executionUsed = true;
    const executionSignal = signal ? AbortSignal.any([signal, credential.signal]) : credential.signal;
    return operation(roomId, executionSignal, async combined => {
      const entry = decisions.get(roomId)!; sourceCurrent(entry); credential.current();
      const challenge = randomUUID();
      const result = originalNativeRoomResultSchemas["room.status.read"].parse(await request("room.status.read", entry.source, {
        sourceDecisionId: entry.decisionId, hostChallenge: credential.challenge, challenge, operation: approval.operation,
        arguments: args, argumentsSha256: approval.argumentsDigest,
      }, combined));
      sourceCurrent(entry); credential.current();
      if (!result) fail("NATIVE_ROOM_STATUS_DENIED");
      if (result.challenge !== challenge || result.hostChallenge !== credential.challenge
        || result.sourceDecisionId !== credential.sourceDecisionId || result.sourceSha256 !== entry.source.sourceSha256
        || result.argumentsSha256 !== approval.argumentsDigest || result.resultSha256 !== originalNativeRoomDigest(result.result)
        || Math.abs(Date.now() - result.proof.timestamp) > 30000
        || !originalMcpPublicRequestMatches(storage, host, approval))
        fail("NATIVE_ROOM_STATUS_BINDING_MISMATCH");
      return Object.freeze(result.result);
    });
  }
  current();
  host.signal.addEventListener("abort", dispose, { once: true }); session.signal.addEventListener("abort", dispose, { once: true });
  const authority = Object.freeze({ kind: "pkm.original-native-room-authority/v1" as const, signal: lifetime.signal,
    admit, proveHost, readStatus, assertSource(roomId: string) {
      const entry = decisions.get(roomId);
      if (!entry) fail("NATIVE_ROOM_SOURCE_REQUIRED");
      sourceCurrent(entry); return entry.source;
    }, revoke, dispose });
  authorities.set(authority, { storage, host, current });
  storage.retainNativeCleanup({ release: dispose });
  return authority;
}
export type OriginalMcpNativeRoomAuthority = ReturnType<typeof createOriginalMcpNativeRoomAuthority>;
