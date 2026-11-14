import { randomUUID } from "node:crypto";
import { createNextMcpOwnerBroker } from "./next-mcp-owner-broker";

type Broker = Awaited<ReturnType<typeof createNextMcpOwnerBroker>>;

/** Owns provider incarnations individually; a stale retirement can never target a successor. */
export async function createLegacyMcpProviderOwner(createBroker: () => Promise<Broker>) {
  if (typeof createBroker !== "function") throw new Error("A broker factory is required.");
  const first = await createBroker();
  if (first.status().state !== "accepting") {
    first.dispose();
    throw new Error("Initial provider is not accepting.");
  }
  let current = { id: randomUUID(), broker: first };
  let busy = false, disposed = false, sealed = false;
  const check = (id: string) => {
    if (disposed || id !== current.id) throw new Error("The provider connection is stale or unavailable.");
    return current;
  };
  return {
    status() {
      if (disposed) throw new Error("The provider owner is disposed.");
      return { id: current.id, ...current.broker.status() };
    },
    definitionEnvironment(id: string) {
      return check(id).broker.definitionEnvironment();
    },
    async retire(id: string, approve: (signal: AbortSignal) => Promise<boolean>, timeoutMs?: number) {
      const target = check(id);
      if (busy) throw new Error("A provider handoff is already in progress.");
      busy = true;
      try {
        const result = await target.broker.drainLegacyAndClose(approve, timeoutMs);
        if (disposed || current !== target) throw new Error("Provider ownership changed during handoff.");
        return result;
      } finally { busy = false; }
    },
    async restart(id: string) {
      const target = check(id);
      if (sealed) throw new Error("The provider owner is sealed for host shutdown.");
      if (busy || target.broker.status().state !== "stopped")
        throw new Error("Restart requires a verified stopped provider.");
      busy = true;
      let next: Broker | undefined;
      try {
        next = await createBroker();
        if (disposed || current !== target) throw new Error("Provider ownership changed during restart.");
        if (next.status().state !== "accepting") throw new Error("Replacement provider is not accepting.");
        current = { id: randomUUID(), broker: next };
        return current.id;
      } catch (error) {
        next?.dispose();
        throw error;
      } finally { busy = false; }
    },
    seal(id: string) {
      const target = check(id);
      if (busy || target.broker.status().state !== "stopped")
        throw new Error("Sealing requires a verified stopped provider.");
      sealed = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      current.broker.dispose();
    },
  };
}
