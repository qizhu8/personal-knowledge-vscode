import type { StandaloneHost } from "./standalone-host.js";

type OwnerContext = ReturnType<StandaloneHost["ownerResourceContext"]>;

/**
 * Trusted embedding contract only. The factory must check assertCurrent for
 * every request and its close must stop admission and await every effect,
 * including after a transport disconnect. It must not close Storage or Core.
 */
export async function attachReadOnlyMcpToAdoptedOwner(options: {
  owner: OwnerContext;
  connection: AbortSignal;
  assertMcpAuthority(): void;
  start(context: {
    storage: OwnerContext["storage"]; core: OwnerContext["core"]; workspaceId: string;
    actor: Readonly<{ id: "mcp:external"; canWrite: false }>; assertCurrent(): void;
  }): Promise<{ close(): Promise<void> }>;
  onCloseError(error: unknown): void;
}) {
  let closed = false, closing: Promise<void> | undefined;
  let starting: Promise<{ close(): Promise<void> }> | undefined;
  let unregister = () => {};
  const check = () => {
    if (closed || options.connection.aborted) throw new Error("MCP attachment is closed.");
    options.owner.assertCurrent();
    const result = (options.assertMcpAuthority as () => unknown)();
    if (result !== undefined) {
      if (result && (typeof result === "object" || typeof result === "function")
        && typeof (result as { then?: unknown }).then === "function")
        void Promise.resolve(result).catch(() => {});
      throw new Error("MCP authority fence must be synchronous and return undefined.");
    }
    if (closed || options.connection.aborted) throw new Error("MCP attachment is closed.");
    options.owner.assertCurrent();
  };
  const close = () => {
    closed = true;
    return closing ??= (async () => {
      if (starting) {
        let resource: Awaited<typeof starting>;
        try { resource = await starting; }
        catch { throw new Error("MCP startup did not return a drainable resource; retain the owner."); }
        await resource.close();
      }
      options.connection.removeEventListener("abort", onDisconnect);
      unregister();
    })().catch(error => { closing = undefined; throw error; });
  };
  let disconnectTask: Promise<void> | undefined;
  const onDisconnect = () => {
    disconnectTask = close();
    void disconnectTask.catch(options.onCloseError);
  };
  check();
  unregister = options.owner.registerChildClose(close);
  options.connection.addEventListener("abort", onDisconnect, { once: true });
  try {
    check();
    starting = Promise.resolve().then(() => {
      check();
      return options.start({
        storage: options.owner.storage, core: options.owner.core, workspaceId: options.owner.workspaceId,
        actor: Object.freeze({ id: "mcp:external" as const, canWrite: false as const }), assertCurrent: check,
      });
    });
    const resource = await starting;
    if (!resource || typeof resource.close !== "function") throw new Error("MCP attachment has no drain contract.");
    check();
    return Object.freeze({ close, get disconnectTask() { return disconnectTask; } });
  } catch (error) {
    try { await close(); }
    catch (cleanupError) {
      options.onCloseError(cleanupError);
      throw new AggregateError([error, cleanupError], "MCP startup or shutdown is unconfirmed; retain the owner.");
    }
    throw error;
  }
}
