import type { StandaloneHost } from "./standalone-host.js";

type Owner = ReturnType<StandaloneHost["ownerResourceContext"]>;
type Scope = "chat" | "environment" | "mcp";
type Close = () => Promise<void>;
type HostBinding = {
  /** An opaque key supplied by the trusted transport, not proof of identity. */
  hostKey: string;
  connection: AbortSignal;
  assertHostCurrent(): void;
  assertScopeCurrent(scope: Scope): void;
  onCloseError(error: unknown): void;
};

function synchronousFence(callback: () => void): void {
  const result = (callback as () => unknown)();
  if (result !== undefined) {
    if (result && (typeof result === "object" || typeof result === "function")
      && typeof (result as { then?: unknown }).then === "function")
      void Promise.resolve(result).catch(() => {});
    throw new Error("Host authority fences must synchronously return undefined.");
  }
}

/**
 * Session lifecycle for an already authenticated embedding transport.
 * Neither hostKey nor the existence of an owner lease authenticates a host.
 */
export function createOwnerHostSessions(owner: Owner, expectedWorkspaceId: string) {
  if (!owner || !expectedWorkspaceId || owner.workspaceId !== expectedWorkspaceId)
    throw new Error("Owner workspace binding mismatch.");
  owner.assertCurrent();
  let closed = false;
  const sessions = new Map<string, { revoke(): Promise<void> }>();

  function open(binding: HostBinding) {
    if (closed || !binding || typeof binding.hostKey !== "string"
      || !binding.hostKey || binding.hostKey.length > 512 || sessions.has(binding.hostKey)
      || !binding.connection || binding.connection.aborted
      || typeof binding.assertHostCurrent !== "function" || typeof binding.assertScopeCurrent !== "function"
      || typeof binding.onCloseError !== "function")
      throw new Error("Host session admission is unavailable.");
    owner.assertCurrent();
    synchronousFence(binding.assertHostCurrent);
    if (binding.connection.aborted || closed) throw new Error("Host session admission is unavailable.");
    owner.assertCurrent();
    const { hostKey, connection, assertHostCurrent, assertScopeCurrent, onCloseError } = binding;

    let active = true;
    let revoking: Promise<void> | undefined;
    let unregisterOwner = () => {};
    const controller = new AbortController();
    const scopes: Scope[] = ["chat", "environment", "mcp"];
    const scopeControllers = new Map(scopes.map(scope => [scope, new AbortController()]));
    const scopeDrains = new Map<Scope, Promise<void>>();
    const revokedScopes = new Set<Scope>();
    const children = new Map<symbol, { scope: Scope; close: Close; closing?: Promise<void> }>();
    const drainChild = (key: symbol, child: { scope: Scope; close: Close; closing?: Promise<void> }) => {
      if (child.closing) return child.closing;
      const task = Promise.resolve().then(child.close).then(() => {
        if (children.get(key) === child) children.delete(key);
      }, error => {
        if (child.closing === task) child.closing = undefined;
        throw error;
      });
      child.closing = task;
      return task;
    };
    const drainChildren = async (scope?: Scope) => {
      const current = [...children].filter(([, child]) => !scope || child.scope === scope);
      const results = await Promise.allSettled(current.map(([key, child]) => drainChild(key, child)));
      if (results.some(result => result.status === "rejected"))
        throw new Error("Host session resources did not drain.");
    };
    const session = {
      revoke(): Promise<void> {
        if (revoking) return revoking;
        active = false;
        const task = Promise.resolve().then(async () => {
          await drainChildren();
          connection.removeEventListener("abort", disconnected);
          unregisterOwner();
          if (sessions.get(hostKey) === session) sessions.delete(hostKey);
        }).catch(error => {
          if (revoking === task) revoking = undefined;
          throw error;
        });
        revoking = task;
        controller.abort();
        for (const scopeController of scopeControllers.values()) scopeController.abort();
        return task;
      },
    };
    const disconnected = () => {
      void session.revoke().catch(error => {
        try { onCloseError(error); } catch { /* Reporting does not release the owner. */ }
      });
    };
    unregisterOwner = owner.registerChildClose(() => session.revoke());
    sessions.set(hostKey, session);
    connection.addEventListener("abort", disconnected, { once: true });
    if (connection.aborted) disconnected();

    const assertCurrent = (scope: Scope) => {
      if (!scopes.includes(scope) || revokedScopes.has(scope) || !active || closed
        || connection.aborted || sessions.get(hostKey) !== session)
        throw new Error("Host session authority is unavailable.");
      owner.assertCurrent();
      synchronousFence(assertHostCurrent);
      synchronousFence(() => assertScopeCurrent(scope));
      if (revokedScopes.has(scope) || !active || closed || connection.aborted || sessions.get(hostKey) !== session)
        throw new Error("Host session authority is unavailable.");
      owner.assertCurrent();
    };
    return Object.freeze({
      workspaceId: expectedWorkspaceId,
      signal: controller.signal,
      assertCurrent,
      signalFor(scope: Scope) {
        assertCurrent(scope);
        return scopeControllers.get(scope)!.signal;
      },
      registerChildClose(scope: Scope, close: Close) {
        assertCurrent(scope);
        if (typeof close !== "function") throw new Error("A drainable child is required.");
        const key = Symbol();
        children.set(key, { scope, close });
        return () => { if (active && !revokedScopes.has(scope)) children.delete(key); };
      },
      revokeScope(scope: Scope): Promise<void> {
        if (!scopes.includes(scope)) return Promise.reject(new Error("Invalid host session scope."));
        const existing = scopeDrains.get(scope);
        if (existing) return existing;
        revokedScopes.add(scope);
        const task = Promise.resolve().then(() => drainChildren(scope)).catch(error => {
          if (scopeDrains.get(scope) === task) scopeDrains.delete(scope);
          throw error;
        });
        scopeDrains.set(scope, task);
        scopeControllers.get(scope)!.abort();
        return task;
      },
      revoke: session.revoke,
    });
  }

  return Object.freeze({
    open,
    async close() {
      closed = true;
      const results = await Promise.allSettled([...sessions.values()].map(session => session.revoke()));
      if (results.some(result => result.status === "rejected"))
        throw new Error("Owner host sessions did not drain.");
    },
  });
}
