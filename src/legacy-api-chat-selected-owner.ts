import type { StandaloneHost } from "./standalone-host.js";
import type { ManagedClientHost } from "./managed-client-host.js";
import type { SelectedWorkspaceOwner } from "./standalone-host.js";
import { OwnedChatStartupCleanupError, startOwnedLegacyChatProcessUiHost } from "./legacy-api-chat-process-owned-host.js";

type SelectedOwner = ReturnType<StandaloneHost["selectedOwnerContext"]>;
type OwnedOptions = Parameters<typeof startOwnedLegacyChatProcessUiHost>[0];

/**
 * Explicit embedding entry: a live selected-owner capability and a revocable
 * profile connection are required. No root adoption or default selection.
 */
export async function startSelectedOwnerChatProcessHost(options: {
  selected: SelectedOwner;
  connection: AbortSignal;
  assertProfile(): void;
  owner: Omit<OwnedOptions["owner"], "storage" | "actorId" | "assertCurrent">;
  chat: OwnedOptions["chat"];
  onCloseError(error: unknown): void;
}) {
  const check = () => {
    if (options.connection.aborted) throw new Error("Selected Chat connection is closed.");
    options.selected.assertCurrent();
    if ((options.assertProfile() as unknown) !== undefined)
      throw new Error("Selected Chat profile fence must be synchronous.");
  };
  check();
  let starting: ReturnType<typeof startOwnedLegacyChatProcessUiHost> | undefined;
  let child: Awaited<ReturnType<typeof startOwnedLegacyChatProcessUiHost>> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let unregister = () => {};
  const close = (): Promise<void> => {
    closed = true;
    return closing ??= (async () => {
      try {
        if (starting) {
          try { child ??= await starting; }
          catch (error) {
            if (error instanceof OwnedChatStartupCleanupError) throw error;
          }
        }
        if (child) await child.close();
        options.connection.removeEventListener("abort", onDisconnect);
        unregister();
      } catch (error) {
        closing = undefined;
        throw error;
      }
    })();
  };
  let disconnectTask: Promise<void> | undefined;
  const onDisconnect = () => {
    disconnectTask = close();
    void disconnectTask.catch(options.onCloseError);
  };
  unregister = options.selected.registerChildClose(close);
  options.connection.addEventListener("abort", onDisconnect, { once: true });
  try {
    check();
    starting = startOwnedLegacyChatProcessUiHost({
      owner: { ...options.owner, storage: options.selected.storage, actorId: options.selected.actorId, assertCurrent: check },
      chat: options.chat,
    });
    child = await starting;
    if (closed) throw new Error("Selected Chat host closed during startup.");
    check();
    return { ...child, close, get disconnectTask() { return disconnectTask; } };
  } catch (error) {
    try { await close(); }
    catch (closeError) {
      options.onCloseError(closeError);
      throw new AggregateError([error, closeError], "Selected Chat startup and cleanup are unconfirmed.");
    }
    throw error;
  }
}

/** Entry for an explicitly selected live managed-client host; read-only hosts cannot provide it. */
export async function startManagedClientSelectedOwnerChat(options: {
  managed: ManagedClientHost;
  selection: SelectedWorkspaceOwner;
} & Omit<Parameters<typeof startSelectedOwnerChatProcessHost>[0], "selected">) {
  if (!options.managed.selectedOwnerContext) throw new Error("Managed selected Chat owner is unavailable.");
  const selected = options.managed.selectedOwnerContext(options.selection);
  return startSelectedOwnerChatProcessHost({ ...options, selected });
}
