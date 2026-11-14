import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertOwnerParentScopeControl, createOwnerParentControl, type OwnerParentScopeControl } from "../runtime/owner-parent-control";
import { assertAdoptedChatAuthorityHost, type AdoptedRootChatAuthority } from "./adopted-root-chat-authority";
import type { AdoptedRootChatViewAuthority } from "./adopted-root-chat-view";

type HostBinding = Readonly<{ root: string; workspaceId: string; sessionId: string; configurationFingerprint: string }>;
type TransportBinding = HostBinding & Readonly<{
  actorId: "local:owner"; profileId: string; endpoint: string; bearer: string; sourceFingerprint: string;
}>;

function childStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), end = stat.lastIndexOf(")");
  const fields = end >= 0 ? stat.slice(end + 2).trim().split(/\s+/) : [];
  if (!fields[0] || ["Z", "X"].includes(fields[0]) || Number(fields[1]) !== process.pid || !/^[0-9]+$/.test(fields[19] || ""))
    throw new Error("Chat owner child identity is unavailable.");
  return fields[19];
}

export class AdoptedChatParentStartupError extends Error {
  constructor(readonly retryCleanup: () => Promise<void>, readonly startupCause: unknown) {
    super("Chat parent startup failed; owner scope drain is unconfirmed.");
  }
}

function syncFence(callback: () => void): void {
  const result = (callback as () => unknown)();
  if (result !== undefined) {
    if (result && (typeof result === "object" || typeof result === "function")
      && typeof (result as { then?: unknown }).then === "function")
      void Promise.resolve(result).catch(() => {});
    throw new Error("Chat host and transport fences must synchronously return undefined.");
  }
}

/**
 * Trusted direct-child embedding only. This is deny-only and cannot issue a
 * cross-process grant; the embedding must independently authenticate transport.
 */
export function createAdoptedRootChatParentSession(options: {
  authority: AdoptedRootChatAuthority;
  root: string; workspaceId: string; sessionId: string; configurationFingerprint: string;
  endpoint: string; bearer: string; sourceFingerprint: string;
  child: ChildProcess; hostSignal: AbortSignal;
  assertHostCurrent(binding: HostBinding): void;
  assertTransportCurrent(binding: TransportBinding, child: ChildProcess): void;
  onCloseError(error: unknown): void;
  timeoutMs?: number;
  scopeControl?: OwnerParentScopeControl;
}): { readonly viewAuthority: AdoptedRootChatViewAuthority; revokeChat(): Promise<void>; close(): Promise<void> } {
  if (!options || !options.authority || !options.child || !options.hostSignal
    || typeof options.assertHostCurrent !== "function" || typeof options.assertTransportCurrent !== "function"
    || typeof options.onCloseError !== "function")
    throw new Error("A trusted direct-owner Chat embedding is required.");
  const { authority, child, hostSignal, assertHostCurrent, assertTransportCurrent, onCloseError } = options;
  const hostBinding: HostBinding = Object.freeze({ root: options.root, workspaceId: options.workspaceId,
    sessionId: options.sessionId, configurationFingerprint: options.configurationFingerprint });
  const binding: TransportBinding = Object.freeze({ ...hostBinding, actorId: "local:owner",
    profileId: authority.profileId, endpoint: options.endpoint, bearer: options.bearer, sourceFingerprint: options.sourceFingerprint });
  if (!/^[a-f0-9]{64}$/.test(binding.sourceFingerprint) || !/^[A-Za-z0-9_-]{43}$/.test(binding.bearer))
    throw new Error("Chat transport binding is unavailable.");
  const endpoint = new URL(binding.endpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port
    || endpoint.pathname !== "/" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error("Chat transport must be a private loopback endpoint.");
  const pid = child.pid;
  if (!pid || !child.connected || child.exitCode !== null || child.signalCode !== null)
    throw new Error("Chat owner child is unavailable.");
  const start = childStart(pid);
  const checkChild = () => {
    if (child.pid !== pid || !child.connected || child.exitCode !== null || child.signalCode !== null || childStart(pid) !== start)
      throw new Error("Chat owner child is unavailable.");
  };
  const hostCheck = () => {
    if (hostSignal.aborted) throw new Error("Chat owner host is unavailable.");
    checkChild();
    syncFence(() => assertHostCurrent(hostBinding));
    syncFence(() => assertTransportCurrent(binding, child));
    if (hostSignal.aborted) throw new Error("Chat owner host is unavailable.");
    checkChild();
  };
  assertAdoptedChatAuthorityHost(authority, { ...hostBinding, hostSignal, assertHostCurrent });
  hostCheck();
  const scopeBinding = { child, sessionId: binding.sessionId, scope: "chat" as const };
  const sharedScope = options.scopeControl;
  if (sharedScope !== undefined) assertOwnerParentScopeControl(sharedScope, scopeBinding);
  const control = sharedScope === undefined
    ? createOwnerParentControl({ child, sessionId: binding.sessionId, assertCurrent: hostCheck, timeoutMs: options.timeoutMs })
    : undefined;
  const revokeScope = () => sharedScope === undefined ? control!.revokeScope("chat")
    : sharedScope.revoke().catch(() => { throw new Error("Chat scope drain outcome is unknown."); });
  const controller = new AbortController();
  let fenced = false, disposed = false, drained = false, pending: Promise<void> | undefined;
  const revokeChat = (): Promise<void> => {
    fenced = true;
    controller.abort();
    if (drained) return Promise.resolve();
    if (!pending) pending = revokeScope().then(() => { drained = true; }, error => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
  const invalidate = () => {
    if (fenced) return;
    void revokeChat().catch(error => { try { onCloseError(error); } catch { /* The unconfirmed drain remains retryable. */ } });
  };
  const check = () => {
    try {
      if (fenced || disposed || controller.signal.aborted) throw new Error("Chat session is revoked.");
      assertAdoptedChatAuthorityHost(authority, { ...hostBinding, hostSignal, assertHostCurrent });
      hostCheck();
      if (sharedScope !== undefined) assertOwnerParentScopeControl(sharedScope, scopeBinding);
      if (fenced || disposed || controller.signal.aborted) throw new Error("Chat session is revoked.");
    } catch (error) { invalidate(); throw error; }
  };
  authority.signal.addEventListener("abort", invalidate, { once: true });
  hostSignal.addEventListener("abort", invalidate, { once: true });
  sharedScope?.signal.addEventListener("abort", invalidate, { once: true });
  child.once("disconnect", invalidate);
  child.once("exit", invalidate);
  child.on("error", invalidate);
  const removeListeners = () => {
    authority.signal.removeEventListener("abort", invalidate);
    hostSignal.removeEventListener("abort", invalidate);
    sharedScope?.signal.removeEventListener("abort", invalidate);
    child.removeListener("disconnect", invalidate);
    child.removeListener("exit", invalidate);
    child.removeListener("error", invalidate);
  };
  if (sharedScope?.signal.aborted) invalidate();
  try { check(); } catch (error) {
    throw new AdoptedChatParentStartupError(async () => {
      await revokeChat();
      removeListeners();
      control?.dispose();
    }, error);
  }
  const session: AdoptedRootChatViewAuthority["session"] = Object.freeze({
    signal: controller.signal,
    assertCurrent(current) {
      check();
      if (current.root !== binding.root || current.workspaceId !== binding.workspaceId
        || current.actorId !== binding.actorId || current.profileId !== binding.profileId
        || current.sessionId !== binding.sessionId || current.endpoint !== binding.endpoint
        || current.bearer !== binding.bearer || current.sourceFingerprint !== binding.sourceFingerprint)
        throw new Error("Chat transport binding changed.");
      check();
    },
    revokeChat,
  });
  const viewAuthority: AdoptedRootChatViewAuthority = Object.freeze({ root: binding.root, workspaceId: binding.workspaceId,
    sessionId: binding.sessionId, profileId: binding.profileId, endpoint: binding.endpoint, bearer: binding.bearer,
    sourceFingerprint: binding.sourceFingerprint, session, profile: authority });
  return Object.freeze({
    viewAuthority,
    revokeChat,
    async close() {
      await revokeChat();
      if (!disposed) {
        disposed = true;
        removeListeners();
        control?.dispose();
      }
    },
  });
}
