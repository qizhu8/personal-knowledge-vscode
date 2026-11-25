import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assertRootOwner, type RootOwner } from "./root-owner.js";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import {
  assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession,
} from "./original-mcp-native-attachment.js";
import {
  originalMcpNativeRequestMethods, originalMcpNativeRequestSession, requestOriginalMcpNative, waitForOriginalMcpNativeSupport,
} from "./original-mcp-native-request.js";
import { assertOriginalMcpNativeRoomAuthority, type OriginalMcpNativeRoomAuthority } from "./original-mcp-native-room-authority.js";
import { approveOriginalRoomLoopbackSession, type OriginalRoomSessionGrant } from "./original-mcp-room-session-authority.js";
import {
  createOriginalRoomSessionPersistence, startOriginalRoomSessionPersistenceServer, type OriginalRoomSessionPersistence,
} from "./original-mcp-room-session-persistence.js";
import {
  originalRoomSessionClientCallSchema, originalRoomSessionDigest as digest, originalRoomSessionNativeResults,
  originalRoomSessionNativeMethods, originalRoomUserLinkNativeMethods, parseOriginalRoomSessionNativePayload,
  type OriginalRoomSessionNativeMethod,
} from "./original-mcp-room-session-contracts.js";
import {
  prepareOriginalRoomUserJoin, consumeOriginalRoomUserJoin, discardOriginalRoomUserJoin, originalRoomUserJoinPublicApproval,
  type OriginalRoomUserJoinIngress,
} from "./original-mcp-room-session-user-link.js";
import { assertNoDurableOriginalRoomInvite, parseOriginalRoomUserJoinArguments } from "./original-mcp-room-session-user-link-codec.js";

type State = "opening" | "active" | "closing" | "closed" | "expired" | "revoked" | "uncertain";
export interface OriginalMcpRoomLiveSession {
  readonly kind: "pkm.original-mcp-room-live-session/v1";
  readonly roomId: string;
  readonly state: State;
  readonly sessionId: string | undefined;
  readonly effectSha256: string | undefined;
  readonly endpoint: string | undefined;
  readonly expiresAtMs: number | undefined;
  invokePublic(tool: string, args: unknown, signal?: AbortSignal, callId?: string): Promise<Readonly<{ result: string }>>;
  close(): Promise<void>;
}
const selections = new WeakMap<Storage, { host: OriginalMcpNativeHost; resource: OriginalMcpRoomLiveSession }>();
export const originalMcpRoomLivePublicTools = Object.freeze(["chat_join", "chat_read", "chat_status", "chat_leave", "chat_post"] as const);
const supported = new Set<string>(originalMcpRoomLivePublicTools);
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

/** Expired/uncertain selections deliberately remain visible: callers must not fall through to another Room path. */
export function getOriginalMcpRoomLiveSession(storage: Storage, host: OriginalMcpNativeHost): OriginalMcpRoomLiveSession | undefined {
  assertStorage(storage);
  const selected = selections.get(storage);
  if (!selected) return undefined;
  if (selected.host !== host) fail("ROOM_LIVE_SAME_HOST_REQUIRED");
  return selected.resource;
}

/** Same canonical owner, real signed transport only. No injected approval/transport or credential-loading callbacks. */
export async function openOriginalMcpRoomLiveSession(owner: RootOwner, host: OriginalMcpNativeHost,
  session: AuthenticatedOriginalMcpNativeSession, authority: OriginalMcpNativeRoomAuthority,
  roomId: string, selection: unknown, options: { directory: string; signal?: AbortSignal }): Promise<OriginalMcpRoomLiveSession> {
  assertRootOwner(owner);
  const full = await owner.ensureFull(), storage = full.storage;
  assertOriginalMcpNativeHost(host, storage); assertAuthenticatedOriginalMcpNativeSession(session);
  assertOriginalMcpNativeRoomAuthority(authority, storage, host);
  authority.assertSource(roomId);
  const signed = session.binding, receipt = host.receipt;
  if (signed.root !== storage.workspaceRoot() || signed.workspaceId !== receipt.workspaceId
    || signed.planSha256 !== receipt.planSha256 || signed.profileSha256 !== receipt.profileSha256
    || signed.catalogSha256 !== receipt.sourceCatalogSha256 || session.activationId !== receipt.epoch
    || receipt.authorityId !== `native-rpc:${session.brokerId}`) fail("ROOM_LIVE_SIGNED_OWNER_BINDING_REQUIRED");
  if (selections.has(storage)) fail("ROOM_LIVE_SELECTION_MUST_BE_CLOSED_OR_RECONCILED");
  if (options.signal?.aborted) fail("ROOM_LIVE_CANCELLED");
  const binding = { ...receipt }; const { receiptSha256: _receipt, ...hostBinding } = binding;
  const admission = new AbortController();
  let phase: "opening" | "active" | "closing" | "closed" = "opening";
  let fault: "expired" | "revoked" | "uncertain" | undefined;
  let uncertain = false, explicitClose = false, nativeOpenSent = false;
  let grant: OriginalRoomSessionGrant | undefined, persistence: OriginalRoomSessionPersistence | undefined;
  let transport: Awaited<ReturnType<typeof startOriginalRoomSessionPersistenceServer>> | undefined;
  let opening: Promise<void> = Promise.resolve(), cleanup: Promise<void> | undefined;
  let invocation: Promise<unknown> = Promise.resolve();
  const inflight = new Set<Promise<unknown>>();
  function baseCurrent() {
    owner.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    assertAuthenticatedOriginalMcpNativeSession(session);
  }
  function openingCurrent() {
    baseCurrent();
    if (admission.signal.aborted || options.signal?.aborted) fail("ROOM_LIVE_CANCELLED");
  }
  async function request<M extends OriginalRoomSessionNativeMethod>(method: M, payload: unknown,
    signal?: AbortSignal, timeoutMs = 30000) {
    const registered = originalMcpNativeRequestMethods.find(candidate => String(candidate) === method);
    if (!registered) fail("MISSING_NATIVE_METHOD");
    const exact = parseOriginalRoomSessionNativePayload(method, payload, originalMcpNativeRequestSession(session));
    const response = await requestOriginalMcpNative(session, registered, exact, { signal, timeoutMs });
    return originalRoomSessionNativeResults[method].parse(response);
  }
  function finalize() {
    if (explicitClose && !uncertain) {
      phase = "closed"; fault = undefined;
      if (selections.get(storage)?.resource === resource) selections.delete(storage);
    }
  }
  function stop(reason: "closed" | "expired" | "revoked" | "uncertain", explicit = false): Promise<void> {
    if (explicit) explicitClose = true;
    if (reason === "uncertain") { uncertain = true; fault = "uncertain"; }
    else if (!uncertain && reason !== "closed") fault ??= reason;
    phase = "closing";
    if (!cleanup) cleanup = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      await opening.catch(() => {});
      await Promise.allSettled([...inflight]);
      // Cleanup authenticates with the base attachment, never the now-expired effect/caller signal.
      if (nativeOpenSent && grant && !session.signal.aborted) {
        try {
          assertAuthenticatedOriginalMcpNativeSession(session);
          await request("room.session.close", { binding: hostBinding, sessionId: grant.effect.sessionId,
            effectSha256: digest(grant.effect) }, session.signal, 10000);
        } catch (error) { failures.push(error); }
      }
      try { if (transport) await transport.close(); else await persistence?.close(); }
      catch (error) { failures.push(error); }
      session.signal.removeEventListener("abort", revoked);
      host.signal.removeEventListener("abort", revoked);
      authority.signal.removeEventListener("abort", revoked);
      options.signal?.removeEventListener("abort", cancelled);
      grant?.signal.removeEventListener("abort", effectEnded);
      phase = "closed";
      if (failures.length) {
        uncertain = true; fault = "uncertain";
        throw Object.assign(new AggregateError(failures, "Room live-session cleanup was not confirmed; preserve Core receipts."),
          { code: "ROOM_LIVE_CLOSE_UNCONFIRMED" });
      }
      finalize();
    });
    admission.abort();
    persistence?.closeAdmission();
    grant?.revoke();
    void cleanup.catch(() => {});
    return cleanup.then(() => { finalize(); });
  }
  const revoked = () => { if (phase !== "closing" && phase !== "closed") void stop("revoked"); };
  const cancelled = () => { if (phase !== "closing" && phase !== "closed") void stop("revoked"); };
  const effectEnded = () => {
    if (phase === "closing" || phase === "closed") return;
    void stop(grant && grant.effect.expiresAtMs <= Date.now() ? "expired" : "revoked");
  };
  function current() {
    if (uncertain) fail("ROOM_LIVE_UNCERTAIN_RECONCILIATION_REQUIRED");
    if (fault) fail(fault === "expired" ? "ROOM_LIVE_EXPIRED" : "ROOM_LIVE_REVOKED");
    if (phase !== "active") fail(phase === "opening" ? "ROOM_LIVE_OPENING" : "ROOM_LIVE_CLOSED");
    try { baseCurrent(); grant!.assertCurrent(); }
    catch {
      void stop(grant && grant.effect.expiresAtMs <= Date.now() ? "expired" : "revoked");
      fail(grant && grant.effect.expiresAtMs <= Date.now() ? "ROOM_LIVE_EXPIRED" : "ROOM_LIVE_REVOKED");
    }
  }
  async function invokePublic(tool: string, input: unknown, signal?: AbortSignal, callId = randomUUID()) {
    current();
    if (!supported.has(tool)) fail("ROOM_LIVE_PUBLIC_TOOL_UNAVAILABLE");
    let args: unknown, call: ReturnType<typeof originalRoomSessionClientCallSchema.parse> | undefined;
    if (tool === "chat_join") args = parseOriginalRoomUserJoinArguments(input);
    else {
      const parsed = originalRoomSessionClientCallSchema.safeParse({ tool, arguments: input });
      if (!parsed.success) fail("ROOM_LIVE_PUBLIC_ARGUMENTS_NOT_SUPPORTED");
      call = JSON.parse(JSON.stringify(parsed.data)); args = call!.arguments;
      assertNoDurableOriginalRoomInvite(call);
      if (call!.tool === "chat_post" && call!.arguments.text.trim() !== grant!.effect.selection.postText)
        fail("ROOM_LIVE_EXACT_POST_APPROVAL_REQUIRED");
    }
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(callId)) fail("ROOM_LIVE_CALL_ID_REQUIRED");
    const combined = AbortSignal.any([admission.signal, grant!.signal, session.signal, host.signal, ...(signal ? [signal] : [])]);
    const run = invocation.then(async () => {
      let ingress: OriginalRoomUserJoinIngress | undefined, sent = false;
      try {
        current();
        if (combined.aborted) fail("ROOM_LIVE_CALL_CANCELLED");
        const approval = tool === "chat_join"
          ? originalRoomUserJoinPublicApproval(ingress = prepareOriginalRoomUserJoin(grant!, args, callId))
          : { operation: `mcp.tool.${tool}`, version: 1 as const, tool,
            readOnly: tool === "chat_read" || tool === "chat_status", arguments: args as Record<string, unknown>, argumentsDigest: digest(args) };
        await host.authorizePublic(approval, combined);
        current();
        if (combined.aborted) fail("ROOM_LIVE_CALL_CANCELLED");
        const common = { binding: hostBinding, sessionId: grant!.effect.sessionId, effectSha256: digest(grant!.effect), callId };
        let value: unknown;
        if (ingress) {
          const packet = consumeOriginalRoomUserJoin(ingress);
          sent = true;
          value = packet.kind === "forward"
            ? await request("room.session.join", { ...common, arguments: packet.arguments, intent: packet.intent }, combined)
            : await request("room.session.invoke", { ...common, call: packet.call }, combined);
        } else {
          sent = true; value = await request("room.session.invoke", { ...common, call }, combined);
        }
        current();
        return Object.freeze(originalRoomSessionNativeResults["room.session.invoke"].parse(value));
      } catch (error) {
        if (ingress && !sent) discardOriginalRoomUserJoin(ingress);
        if (sent) void stop("uncertain");
        throw error;
      }
    });
    invocation = run.then(() => undefined, () => undefined);
    inflight.add(run);
    try { return await run; } finally { inflight.delete(run); }
  }
  const resource: OriginalMcpRoomLiveSession = Object.freeze({
    kind: "pkm.original-mcp-room-live-session/v1" as const, roomId,
    get state() { return fault ?? phase; },
    get sessionId() { return grant?.effect.sessionId; },
    get effectSha256() { return grant ? digest(grant.effect) : undefined; },
    get endpoint() { return grant?.effect.endpoint; },
    get expiresAtMs() { return grant?.effect.expiresAtMs; },
    invokePublic, close: () => stop("closed", true),
  });
  selections.set(storage, { host, resource });
  owner.retainResource({ closeAdmission() { admission.abort(); persistence?.closeAdmission(); }, release: resource.close });
  session.signal.addEventListener("abort", revoked, { once: true });
  host.signal.addEventListener("abort", revoked, { once: true });
  authority.signal.addEventListener("abort", revoked, { once: true });
  options.signal?.addEventListener("abort", cancelled, { once: true });
  opening = (async () => {
    openingCurrent();
    const directory = options.directory;
    if (!isAbsolute(directory) || resolve(directory) !== directory || await realpath(directory) !== directory)
      fail("ROOM_LIVE_PRIVATE_DIRECTORY_REQUIRED");
    const member = relative(storage.workspaceRoot(), directory), node = await lstat(directory);
    if (member === "" || member !== ".." && !member.startsWith(`..${sep}`) && !isAbsolute(member)
      || !node.isDirectory() || node.isSymbolicLink() || node.uid !== process.getuid!() || node.mode & 0o077
      || (await readdir(directory)).length !== 0) fail("ROOM_LIVE_DISJOINT_EMPTY_PRIVATE_DIRECTORY_REQUIRED");
    const methods = await waitForOriginalMcpNativeSupport(session, { signal: admission.signal, timeoutMs: 30000 });
    if ([...originalRoomSessionNativeMethods, ...originalRoomUserLinkNativeMethods]
      .some(method => !methods.some(candidate => String(candidate) === method))) fail("MISSING_NATIVE_METHOD");
    openingCurrent();
    const proof = await authority.proveHost(roomId, admission.signal);
    openingCurrent();
    grant = await approveOriginalRoomLoopbackSession(owner, host, authority, roomId, proof, selection, admission.signal);
    grant.signal.addEventListener("abort", effectEnded, { once: true });
    openingCurrent(); grant.assertCurrent();
    persistence = await createOriginalRoomSessionPersistence(owner, host, grant);
    openingCurrent(); grant.assertCurrent();
    transport = await startOriginalRoomSessionPersistenceServer(persistence, directory);
    openingCurrent(); grant.assertCurrent();
    nativeOpenSent = true;
    const result = originalRoomSessionNativeResults["room.session.open"].parse(await request("room.session.open", {
      binding: hostBinding, effect: grant.effect, persistence: transport.descriptor,
    }, AbortSignal.any([admission.signal, grant.signal]), 30000));
    openingCurrent(); grant.assertCurrent();
    if (result.sessionId !== grant.effect.sessionId || result.effectSha256 !== digest(grant.effect)
      || result.endpoint !== grant.effect.endpoint || result.alias !== grant.effect.selection.alias
      || result.expiresAtMs !== grant.effect.expiresAtMs) fail("ROOM_LIVE_NATIVE_OPEN_BINDING_REQUIRED");
    phase = "active";
  })();
  try { await opening; return resource; }
  catch (error) {
    const reason = nativeOpenSent ? "uncertain" : "closed";
    try { await stop(reason, !nativeOpenSent); }
    catch (cleanupError) {
      throw Object.assign(new AggregateError([error, cleanupError], "Room live-session open failed; preserve its cleanup receipts."),
        { code: "ROOM_LIVE_OPEN_CLEANUP_UNCONFIRMED" });
    }
    throw error;
  }
}
