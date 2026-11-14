import type { ManagedClientHost } from "./managed-client-host.js";
import type { StandaloneHost } from "./standalone-host.js";
import type { createOwnerHostSessions } from "./owner-host-sessions.js";
import { startManagedClientSelectedOwnerChat } from "./legacy-api-chat-selected-owner.js";
import { OwnedChatStartupCleanupError } from "./legacy-api-chat-process-owned-host.js";

type Session = ReturnType<ReturnType<typeof createOwnerHostSessions>["open"]>;
type ChatOptions = Parameters<typeof startManagedClientSelectedOwnerChat>[0];

/**
 * Trusted embedding only. Session and profile authority are independently
 * issued; neither the owner lease nor a client-supplied chat ID grants access.
 */
export async function attachAdoptedRootSessionChat(options: {
  managed: ManagedClientHost;
  owner: ReturnType<StandaloneHost["ownerResourceContext"]>;
  session: Session;
  profile: {
    workspaceId: string; actorId: "local:owner"; root: string; profileId: string; signal: AbortSignal;
    assertCurrent(binding: Readonly<{ workspaceId: string; actorId: "local:owner"; root: string; profileId: string;
      chats: readonly Readonly<{ namespace: string; chatId: string }>[] }>): void;
  };
  ownerOptions: ChatOptions["owner"];
  chat: ChatOptions["chat"];
  onCloseError(error: unknown): void;
}) {
  if (!options?.managed || !options.owner || !options.session || !options.profile
    || options.managed.workspaceId !== options.owner.workspaceId
    || options.session.workspaceId !== options.owner.workspaceId
    || options.profile.workspaceId !== options.owner.workspaceId || options.profile.actorId !== "local:owner"
    || options.profile.root !== options.owner.storage.workspaceRoot()
    || typeof options.profile.profileId !== "string" || !options.profile.profileId || options.profile.profileId.length > 512
    || !options.profile.signal || options.profile.signal.aborted || typeof options.profile.assertCurrent !== "function"
    || typeof options.onCloseError !== "function" || !options.chat || !Array.isArray(options.chat.chats)
    || !options.chat.chats.length)
    throw new Error("Adopted Chat session binding is unavailable.");
  const chats = Object.freeze(options.chat.chats.map(chat => Object.freeze({ namespace: chat.namespace, chatId: chat.chatId })));
  if (new Set(chats.map(chat => `${chat.namespace}:${chat.chatId}`)).size !== chats.length)
    throw new Error("Adopted Chat session selection contains duplicates.");
  const binding = Object.freeze({ workspaceId: options.owner.workspaceId, actorId: "local:owner" as const,
    root: options.profile.root, profileId: options.profile.profileId, chats });
  const chatSignal = options.session.signalFor("chat");
  let closed = false, closing: Promise<void> | undefined;
  let starting: ReturnType<typeof startManagedClientSelectedOwnerChat> | undefined;
  let child: Awaited<ReturnType<typeof startManagedClientSelectedOwnerChat>> | undefined;
  let unregister = () => {};
  const check = () => {
    if (closed || options.profile.signal.aborted || chatSignal.aborted)
      throw new Error("Adopted Chat session is closed.");
    options.owner.assertCurrent();
    options.session.assertCurrent("chat");
    const result = (options.profile.assertCurrent as (value: typeof binding) => unknown)(binding);
    if (result !== undefined) {
      if (result && (typeof result === "object" || typeof result === "function")
        && typeof (result as { then?: unknown }).then === "function")
        void Promise.resolve(result).catch(() => {});
      throw new Error("Adopted Chat profile fence must be synchronous and return undefined.");
    }
    if (closed || options.profile.signal.aborted || chatSignal.aborted)
      throw new Error("Adopted Chat session is closed.");
    options.session.assertCurrent("chat");
    options.owner.assertCurrent();
  };
  const close = () => {
    closed = true;
    return closing ??= (async () => {
      if (starting) {
        try { child ??= await starting; }
        catch (error) {
          if (error instanceof OwnedChatStartupCleanupError || error instanceof AggregateError) throw error;
        }
      }
      if (child) await child.close();
      options.profile.signal.removeEventListener("abort", revoked);
      unregister();
    })().catch(error => { closing = undefined; throw error; });
  };
  let revokeTask: Promise<void> | undefined;
  const revoked = () => {
    revokeTask = close();
    void revokeTask.catch(error => { try { options.onCloseError(error); } catch { /* Retain the session barrier. */ } });
  };
  check();
  const selected = options.managed.selectedOwnerContext?.({
    workspaceId: binding.workspaceId, actorId: binding.actorId, assertCurrent: check,
  });
  if (!selected || selected.storage !== options.owner.storage)
    throw new Error("Chat and host session do not share the same live Storage.");
  unregister = options.session.registerChildClose("chat", close);
  options.profile.signal.addEventListener("abort", revoked, { once: true });
  try {
    check();
    starting = startManagedClientSelectedOwnerChat({
      managed: options.managed,
      selection: { workspaceId: binding.workspaceId, actorId: binding.actorId, assertCurrent: check },
      connection: chatSignal, assertProfile: check,
      owner: options.ownerOptions, chat: { ...options.chat, chats: [...chats] },
      onCloseError: options.onCloseError,
    });
    child = await starting;
    check();
    return Object.freeze({ ...child, close, get revokeTask() { return revokeTask; } });
  } catch (error) {
    try { await close(); }
    catch (cleanupError) {
      try { options.onCloseError(cleanupError); } catch { /* Preserve the unconfirmed cleanup. */ }
      throw new AggregateError([error, cleanupError], "Adopted Chat startup or cleanup is unconfirmed; retain the owner.");
    }
    throw error;
  }
}
