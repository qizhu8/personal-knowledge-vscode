import { AsyncLocalStorage } from "node:async_hooks";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import type { Actor } from "./contracts.js";
import type { Storage } from "./storage.js";

export interface ManagedTaskScope {
  storage: Storage; actorId: string; workspaceId: string; requestId: string; mode: string; grant: object;
  assertSource(): void; assertLive(): void; allows(operation: string): boolean;
}
const active = new AsyncLocalStorage<ManagedTaskScope>();

/** Heavy native/source composition is loaded only for a genuine Task operation, never ordinary Core startup. */
export async function withinNativeTaskScope<T>(token: object, work: () => Promise<T>): Promise<T> {
  const { readGenuineManagedTaskScope } = await import("./managed-chat-task-native.js");
  return active.run(readGenuineManagedTaskScope(token), work);
}
export function managedChatTaskAvailable(storage: Storage, operation: string, actor?: Readonly<Actor>) {
  const scope = active.getStore();
  if (!scope || scope.storage !== storage || scope.actorId !== actor?.id || actor.boardWorker || !scope.allows(operation)) return false;
  try { scope.assertSource(); return true; } catch { return false; }
}
export function currentManagedChatTaskGrant(storage: Storage, operation: string, actor: Readonly<Actor>): object {
  if (!managedChatTaskAvailable(storage, operation, actor))
    throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "No genuine native Task scope is active.");
  return active.getStore()!.grant;
}
export function managedChatTaskToolAllowed(operation: string, actorId: string, context: { workspaceId: string; turnId: string }) {
  const scope = active.getStore();
  if (!scope || scope.mode !== "execute" || scope.actorId !== actorId || scope.workspaceId !== context.workspaceId
    || scope.requestId !== context.turnId || !["chat.task.get", "chat.task.report_work", "chat.task.record_harness"].includes(operation)) return false;
  try { scope.assertLive(); return true; } catch { return false; }
}
