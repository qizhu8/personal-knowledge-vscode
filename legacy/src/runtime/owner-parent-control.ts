import { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

type Scope = "chat" | "environment" | "mcp";
type Pending = { scope: Scope; resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout };
const claimedChildren = new WeakSet<ChildProcess>();
type OwnerParentControl = Readonly<{ revokeScope(scope: Scope): Promise<void>; dispose(): void }>;
export type OwnerParentScopeControl = Readonly<{ readonly signal: AbortSignal; revoke(): Promise<void> }>;
type ControlRecord = { child: ChildProcess; sessionId: string; check(): void; unavailable(scope: Scope): boolean;
  signalFor(scope: Scope): AbortSignal; claimed: Set<Scope> };
const controls = new WeakMap<OwnerParentControl, ControlRecord>();
const scopeControls = new WeakMap<OwnerParentScopeControl, { control: OwnerParentControl; scope: Scope }>();

/**
 * Issue a local deny-only capability from the already claimed direct-child
 * control. It does not grant a scope, authenticate another host, or own the
 * shared control's lifetime.
 */
export function createOwnerParentScopeControl(control: OwnerParentControl, binding: {
  child: ChildProcess; sessionId: string; scope: Scope;
}): OwnerParentScopeControl {
  const record = controls.get(control);
  if (!record || !binding || record.child !== binding.child || record.sessionId !== binding.sessionId
    || !["chat", "environment", "mcp"].includes(binding.scope) || record.claimed.has(binding.scope)
    || record.unavailable(binding.scope))
    throw new Error("A current unclaimed owner scope binding is required.");
  record.check();
  if (record.unavailable(binding.scope) || record.claimed.has(binding.scope))
    throw new Error("Owner scope binding changed.");
  const scope = binding.scope;
  const capability: OwnerParentScopeControl = Object.freeze({ signal: record.signalFor(scope),
    revoke: () => control.revokeScope(scope) });
  record.claimed.add(scope);
  scopeControls.set(capability, { control, scope });
  return capability;
}

export function assertOwnerParentScopeControl(capability: OwnerParentScopeControl, binding: {
  child: ChildProcess; sessionId: string; scope: Scope;
}): void {
  const scope = scopeControls.get(capability), record = scope && controls.get(scope.control);
  if (!scope || !record || !binding || scope.scope !== binding.scope || record.child !== binding.child
    || record.sessionId !== binding.sessionId || record.unavailable(scope.scope))
    throw new Error("Owner scope capability is unavailable or does not match.");
  record.check();
  if (record.unavailable(scope.scope)) throw new Error("Owner scope capability is unavailable.");
}

function childIdentity(pid: number): { parent: number; start: string } {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), end = stat.lastIndexOf(")");
  const fields = end >= 0 ? stat.slice(end + 2).trim().split(/\s+/) : [];
  if (!fields[0] || ["Z", "X"].includes(fields[0])
    || !/^[0-9]+$/.test(fields[1] || "") || !/^[0-9]+$/.test(fields[19] || ""))
    throw new Error("Owner child identity is unavailable.");
  return { parent: Number(fields[1]), start: fields[19] };
}

/**
 * Correlates deny-only scope revocation with one trusted forked owner.
 * The caller must independently verify its payload and root/profile authority.
 */
export function createOwnerParentControl(options: {
  child: ChildProcess;
  sessionId: string;
  assertCurrent(): void;
  timeoutMs?: number;
}): OwnerParentControl {
  const child = options?.child, timeout = options?.timeoutMs ?? 30_000;
  if (process.platform !== "linux" || !child?.pid || !child.connected || claimedChildren.has(child)
    || !/^[a-f0-9-]{36}$/.test(options.sessionId) || typeof options.assertCurrent !== "function"
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000)
    throw new Error("A connected owner child and explicit binding are required.");
  const pid = child.pid, identity = childIdentity(pid), sessionId = options.sessionId;
  const assertBinding = options.assertCurrent;
  if (identity.parent !== process.pid) throw new Error("Owner is not a direct child.");
  let closed = false;
  const pending = new Map<string, Pending>(), confirmed = new Set<Scope>(), invalidated = new Set<Scope>();
  const active = new Set<Scope>(), scopeSignals = new Map<Scope, AbortController>();
  const check = () => {
    if (closed || !child.connected || child.pid !== pid || child.exitCode !== null || child.signalCode !== null)
      throw new Error("Owner parent control is unavailable.");
    const current = childIdentity(pid);
    if (current.parent !== process.pid || current.start !== identity.start)
      throw new Error("Owner child identity changed.");
    const result = (assertBinding as () => unknown)();
    if (result !== undefined) {
      if (result && (typeof result === "object" || typeof result === "function")
        && typeof (result as { then?: unknown }).then === "function")
        void Promise.resolve(result).catch(() => {});
      throw new Error("Owner binding fence must synchronously return undefined.");
    }
    if (closed || !child.connected || child.exitCode !== null || child.signalCode !== null)
      throw new Error("Owner parent control is unavailable.");
    const after = childIdentity(pid);
    if (after.parent !== process.pid || after.start !== identity.start)
      throw new Error("Owner child identity changed.");
  };
  const failAll = () => {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Owner scope drain outcome is unknown."));
    }
    pending.clear();
    active.clear();
    for (const controller of scopeSignals.values()) controller.abort();
  };
  const onMessage = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.type !== "pkm.owner-scope-revoked/v1" || message.sessionId !== sessionId
      || typeof message.id !== "string") return;
    const request = pending.get(message.id);
    if (!request) return;
    if (message.scope !== request.scope || typeof message.drained !== "boolean") {
      failAll();
      return;
    }
    try { check(); } catch { failAll(); return; }
    pending.delete(message.id);
    active.delete(request.scope);
    clearTimeout(request.timer);
    if (message.drained) { confirmed.add(request.scope); request.resolve(); }
    else request.reject(new Error("Owner scope drain outcome is unknown."));
  };
  check();
  claimedChildren.add(child);
  child.on("message", onMessage);
  child.on("error", failAll);
  child.once("disconnect", failAll);
  child.once("exit", failAll);
  const control: OwnerParentControl = Object.freeze({
    revokeScope(scope: Scope): Promise<void> {
      if (!["chat", "environment", "mcp"].includes(scope) || confirmed.has(scope)
        || active.has(scope))
        return Promise.reject(new Error("Scope revoke is invalid, completed or pending."));
      active.add(scope);
      invalidated.add(scope);
      scopeSignals.get(scope)?.abort();
      try { check(); } catch { failAll(); return Promise.reject(new Error("Owner scope drain outcome is unknown.")); }
      const id = randomUUID();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          active.delete(scope);
          reject(new Error("Owner scope drain timed out; outcome is unknown."));
        }, timeout);
        pending.set(id, { scope, resolve, reject, timer });
        try {
          child.send({ type: "pkm.owner-scope-revoke/v1", sessionId, id, scope }, error => {
            if (error && pending.has(id)) failAll();
          });
        } catch { failAll(); }
      });
    },
    dispose() {
      failAll();
      child.removeListener("message", onMessage);
      child.removeListener("error", failAll);
      child.removeListener("disconnect", failAll);
      child.removeListener("exit", failAll);
    },
  });
  controls.set(control, { child, sessionId, check,
    unavailable: scope => invalidated.has(scope),
    signalFor(scope) {
      let controller = scopeSignals.get(scope);
      if (!controller) { controller = new AbortController(); scopeSignals.set(scope, controller); }
      return controller.signal;
    },
    claimed: new Set() });
  return control;
}
