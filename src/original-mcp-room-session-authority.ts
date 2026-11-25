import { randomUUID } from "node:crypto";
import { assertRootOwner, type RootOwner } from "./root-owner.js";
import type { Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import {
  assertOriginalMcpNativeRoomAuthority, assertOriginalMcpNativeRoomHostGrant, type OriginalMcpNativeRoomAuthority,
} from "./original-mcp-native-room-authority.js";
import { inspectLegacyChatroomParticipants } from "./legacy-chatroom-continuation.js";
import { assertNoDurableOriginalRoomInvite } from "./original-mcp-room-session-user-link-codec.js";
import {
  originalRoomLoopbackSelection, originalRoomSessionEffectSchema, originalRoomSessionDigest,
  type OriginalRoomSessionEffect,
} from "./original-mcp-room-session-contracts.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const grants = new WeakMap<object, { owner: RootOwner; storage: Storage; host: OriginalMcpNativeHost; current(): void; claimed: boolean }>();
export interface OriginalRoomSessionGrant {
  readonly kind: "pkm.original-native-room-loopback-grant/v1";
  readonly effect: Readonly<OriginalRoomSessionEffect>;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  revoke(): void;
}
export function assertOriginalRoomSessionGrantCurrent(value: unknown): asserts value is OriginalRoomSessionGrant {
  const state = value && typeof value === "object" ? grants.get(value) : undefined;
  if (!state) fail("ROOM_SESSION_EXACT_EFFECT_GRANT_REQUIRED");
  state.current();
}
export function claimOriginalRoomSessionGrant(value: unknown, owner: RootOwner, storage: Storage, host: OriginalMcpNativeHost):
  asserts value is OriginalRoomSessionGrant {
  const state = value && typeof value === "object" ? grants.get(value) : undefined;
  if (!state || state.owner !== owner || state.storage !== storage || state.host !== host || state.claimed)
    fail("ROOM_SESSION_EXACT_EFFECT_GRANT_REQUIRED");
  state.current(); state.claimed = true;
}

/** Separate genuine native tool approval. A source receipt/Host proof alone never opens persistence or a listener. */
export async function approveOriginalRoomLoopbackSession(owner: RootOwner, host: OriginalMcpNativeHost,
  authority: OriginalMcpNativeRoomAuthority, roomId: string, hostGrant: unknown, input: unknown, signal?: AbortSignal):
  Promise<OriginalRoomSessionGrant> {
  assertRootOwner(owner);
  const full = await owner.ensureFull(), storage = full.storage;
  assertOriginalMcpNativeHost(host, storage); assertOriginalMcpNativeRoomAuthority(authority, storage, host);
  assertOriginalMcpNativeRoomHostGrant(hostGrant, storage, host, roomId);
  const selected = originalRoomLoopbackSelection.parse(input), source = authority.assertSource(roomId);
  assertNoDurableOriginalRoomInvite(selected);
  const proof = hostGrant as { expiresAtMs: number; signal: AbortSignal };
  const key = selected.alias.normalize("NFKC").toLocaleLowerCase();
  const identities = inspectLegacyChatroomParticipants(storage.workspaceRoot(), roomId);
  if (identities.aliases.some(alias => alias.aliasKey === key || alias.alias.normalize("NFKC").toLocaleLowerCase() === key))
    fail("ROOM_SESSION_NEW_ALIAS_REQUIRED");
  if (!host.options.authorizeTool) fail("ROOM_SESSION_NATIVE_EFFECT_APPROVAL_REQUIRED");
  const effect = originalRoomSessionEffectSchema.parse({
    schema: "pkm.original-native-room-loopback-effect/v1", sessionId: randomUUID(), root: storage.workspaceRoot(),
    workspaceId: host.receipt.workspaceId, profileSha256: host.receipt.profileSha256,
    custodyPlanSha256: host.receipt.planSha256, nativeEpoch: host.receipt.epoch,
    nativeHostReceiptSha256: host.receipt.receiptSha256, roomId, sourceSha256: source.sourceSha256,
    sourceFingerprint: source.sourceFingerprint, hostParticipantId: source.hostParticipantId,
    hostCredentialHash: source.hostCredentialHash, joinSecretHash: source.joinSecretHash,
    currentHostProofExpiresAtMs: proof.expiresAtMs, endpoint: `ws://127.0.0.1:${selected.port}`, selection: selected,
    maxClients: 1, maxPosts: 1, temporaryParticipant: true, participantPolicy: "new-agent-only-no-rebind",
    clientPolicy: "original-producer-progress-post-no-commands", noRemote: true, noHostReassignment: true,
    noCredentialExport: true, expiresAtMs: Math.min(proof.expiresAtMs, Date.now() + 30000),
  });
  Object.freeze(effect.selection); Object.freeze(effect);
  const lifetime = new AbortController();
  const combined = AbortSignal.any([lifetime.signal, proof.signal, authority.signal, host.signal, ...(signal ? [signal] : [])]);
  function current() {
    owner.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    assertOriginalMcpNativeRoomAuthority(authority, storage, host);
    assertOriginalMcpNativeRoomHostGrant(hostGrant, storage, host, roomId);
    if (combined.aborted || effect.expiresAtMs <= Date.now() || authority.assertSource(roomId).sourceSha256 !== effect.sourceSha256)
      fail("ROOM_SESSION_EFFECT_REVOKED");
  }
  current();
  const arguments_ = { effect }, argumentsDigest = originalRoomSessionDigest(arguments_);
  if (!await host.options.authorizeTool({
    operation: "room.session.loopback.open", version: 1, arguments: arguments_, argumentsDigest,
    operationId: effect.sessionId, actorId: "mcp:external", workspaceId: effect.workspaceId,
    turnId: `room-session:${effect.sessionId}`, contextDigest: originalRoomSessionDigest(effect), readOnly: false,
  }, combined)) fail("ROOM_SESSION_EFFECT_DENIED");
  current();
  const timer = setTimeout(() => lifetime.abort(), Math.max(0, effect.expiresAtMs - Date.now())); timer.unref();
  combined.addEventListener("abort", () => clearTimeout(timer), { once: true });
  const grant = Object.freeze({ kind: "pkm.original-native-room-loopback-grant/v1" as const, effect,
    signal: combined, assertCurrent: current, revoke: () => lifetime.abort() });
  grants.set(grant, { owner, storage, host, current, claimed: false });
  const weak = new WeakRef(grant);
  owner.onLeaseLost(() => weak.deref()?.revoke());
  storage.retainNativeCleanup({ release: grant.revoke });
  return grant;
}
