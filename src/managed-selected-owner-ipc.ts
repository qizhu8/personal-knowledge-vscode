import type { ManagedClientHost } from "./managed-client-host.js";
import type { StandaloneHost } from "./standalone-host.js";

type SelectedOwner = ReturnType<StandaloneHost["selectedOwnerContext"]>;
type Entry = {
  session: string;
  active: boolean;
  controller: AbortController;
  capability: SelectedOwner;
  children: Map<() => Promise<void>, () => void>;
  revoking?: Promise<void>;
};

/** Parent-forked IPC admission. Revocation ACK follows every registered child drain. */
export function managedSelectedOwnerIpc(options: {
  host(): ManagedClientHost | undefined;
  unavailable(): boolean;
  connected(): boolean;
  send(message: object): void;
}) {
  let entry: Entry | undefined;
  let shuttingDown = false;
  const revoke = (current: Entry): Promise<void> => {
    current.active = false;
    current.controller.abort();
    if (!current.revoking) {
      const task = Promise.resolve().then(async () => {
        for (const [close, unregister] of [...current.children]) {
          await close();
          unregister();
          current.children.delete(close);
        }
        if (entry === current) entry = undefined;
      }).catch(error => {
        if (current.revoking === task) current.revoking = undefined;
        throw error;
      });
      current.revoking = task;
    }
    return current.revoking;
  };
  return {
    capability(session: string): SelectedOwner {
      if (!entry || entry.session !== session || !entry.active || shuttingDown)
        throw new Error("Selected owner is unavailable.");
      entry.capability.assertCurrent();
      return entry.capability;
    },
    signal(session: string): AbortSignal {
      if (!entry || entry.session !== session || !entry.active || shuttingDown)
        throw new Error("Selected owner is unavailable.");
      return entry.controller.signal;
    },
    closeAdmission() {
      shuttingDown = true;
      if (entry) { entry.active = false; entry.controller.abort(); }
    },
    async drain() {
      if (entry) await revoke(entry);
    },
    handle(message: Record<string, unknown>) {
      if (!["selected-owner-open", "selected-owner-revoke"].includes(String(message.type))) return false;
      if (typeof message.id !== "string" || !/^[a-f0-9-]{36}$/.test(message.id)
        || typeof message.session !== "string" || !/^[a-f0-9-]{36}$/.test(message.session)) return true;
      const id = message.id, session = message.session;
      if (message.type === "selected-owner-revoke") {
        const current = entry;
        if (!current) {
          options.send({ type: "result", id, result: { revoked: true } });
        } else if (current.session !== session) {
          options.send({ type: "result", id, error: "BUSY_OR_INVALID" });
        } else {
          void revoke(current).then(() => options.send({ type: "result", id, result: { revoked: true } }),
            () => options.send({ type: "result", id, error: "SELECTED_OWNER_DRAIN_UNKNOWN" }));
        }
        return true;
      }
      const host = options.host();
      if (entry || shuttingDown || options.unavailable() || !options.connected() || !host?.selectedOwnerContext
        || message.workspaceId !== host.workspaceId || message.actorId !== "local:owner") {
        options.send({ type: "result", id, error: "BUSY_OR_INVALID" });
        return true;
      }
      try {
        const current: Entry = { session, active: true, controller: new AbortController(), capability: undefined!, children: new Map() };
        entry = current;
        const underlying = host.selectedOwnerContext({
          workspaceId: host.workspaceId, actorId: "local:owner",
          assertCurrent() {
            if (!current.active || entry !== current || shuttingDown || options.unavailable()
              || options.host() !== host || !options.connected())
              throw new Error("Selected owner admission revoked.");
          },
        });
        const capability: SelectedOwner = Object.freeze({
          ...underlying,
          registerChildClose(close: () => Promise<void>) {
            underlying.assertCurrent();
            if (current.children.has(close)) throw new Error("Selected child is already registered.");
            const unregister = underlying.registerChildClose(close);
            current.children.set(close, unregister);
            return () => { current.children.delete(close); unregister(); };
          },
        });
        current.capability = capability;
        capability.assertCurrent();
        options.send({ type: "result", id, result: { session, workspaceId: host.workspaceId, actorId: "local:owner" } });
      } catch {
        entry = undefined;
        options.send({ type: "result", id, error: "BUSY_OR_INVALID" });
      }
      return true;
    },
  };
}
