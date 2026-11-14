type Download = (record: { nodeId: string; shareId: string }, summary: unknown) => Promise<unknown>;
type Manager = { downloadSnapshot: Download };
const active = new WeakSet<object>();

/**
 * Observe the legacy client's completed authenticated materialization, not merely
 * its refresh return: a broker can respond 304 even to a forced refresh.
 * The caller must hold the legacy state-mutation lock for this entire operation.
 */
export async function withAuthenticatedSubscriptionPull<T>(
  manager: object, target: { nodeId: string; shareId: string }, action: () => Promise<T>,
): Promise<T> {
  if (active.has(manager) || !/^[a-f0-9]{64}$/.test(target.nodeId)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(target.shareId))
    throw new Error("Authenticated Subscription pull is unavailable.");
  const { nodeId, shareId } = target;
  const instance = manager as Manager, original = instance.downloadSnapshot;
  const descriptor = Object.getOwnPropertyDescriptor(manager, "downloadSnapshot");
  if (typeof original !== "function" || descriptor && (!descriptor.configurable || !("value" in descriptor)))
    throw new Error("Authenticated Subscription pull is unavailable.");
  active.add(manager);
  let started = false, completed = false, invalid = false;
  try {
    Object.defineProperty(manager, "downloadSnapshot", { configurable: true, writable: true,
      value: async function(record: { nodeId: string; shareId: string }, summary: unknown) {
        if (started || !record || record.nodeId !== nodeId || record.shareId !== shareId) {
          invalid = true;
          throw new Error("Authenticated Subscription pull target changed.");
        }
        started = true;
        try {
          const result = await original.call(manager, record, summary);
          completed = true;
          return result;
        } catch (error) { invalid = true; throw error; }
      } });
    const result = await action();
    if (!completed || invalid) throw new Error("Authenticated Subscription pull did not complete.");
    return result;
  } finally {
    if (descriptor) Object.defineProperty(manager, "downloadSnapshot", descriptor);
    else Reflect.deleteProperty(manager, "downloadSnapshot");
    active.delete(manager);
  }
}
