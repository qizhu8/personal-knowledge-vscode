import { HostWriterAdmission } from "./host-writer-admission";

type ChildClose = () => Promise<void>;

export interface ManagedHostChildRegistry {
  readonly signal: AbortSignal;
  register(close: ChildClose): () => void;
  close(): Promise<void>;
}

const registries = new WeakMap<ManagedHostChildRegistry, {
  root: string; host: HostWriterAdmission; assertOpen(): void;
}>();

export function assertManagedHostChildRegistry(registry: ManagedHostChildRegistry, root: string, host: HostWriterAdmission): void {
  const issued = registries.get(registry);
  if (!issued || issued.root !== root || issued.host !== host)
    throw new Error("An actual matching managed host child registry is required.");
  issued.assertOpen();
}

/** Tracks only explicitly enrolled children of this actual managed host. */
export function createManagedHostChildRegistry(root: string, host: HostWriterAdmission, timeoutMs = 30_000): ManagedHostChildRegistry {
  if (!(host instanceof HostWriterAdmission)) throw new Error("An actual host admission is required.");
  host.assertCurrentRoot(root);
  const controller = new AbortController(), children = new Set<ChildClose>();
  let state: "open" | "closing" | "closed" | "unknown" = "open";
  let closing: Promise<void> | undefined;
  const registry = Object.freeze({
    signal: controller.signal,
    register(close: ChildClose) {
      if (state !== "open" || controller.signal.aborted || typeof close !== "function" || children.has(close))
        throw new Error("Managed host child admission is closed or duplicated.");
      host.assertCurrentRoot(root);
      children.add(close);
      let unregistered = false;
      return () => {
        if (unregistered || state === "closing" || state === "unknown") return;
        unregistered = true;
        children.delete(close);
      };
    },
    close() {
      if (closing) return closing;
      if (state === "closed") return Promise.resolve();
      if (state !== "open") return Promise.reject(new Error("Managed host child drain is unknown."));
      state = "closing";
      controller.abort();
      closing = (async () => {
        let timer: NodeJS.Timeout | undefined;
        try {
          const results = await Promise.race([
            Promise.allSettled([...children].map(close => Promise.resolve().then(close))),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Managed host child drain timed out.")), Math.max(0, timeoutMs));
            }),
          ]);
          const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
          if (failed) throw failed.reason;
          children.clear();
          state = "closed";
        } catch (error) {
          state = "unknown";
          throw error;
        } finally { if (timer) clearTimeout(timer); }
      })();
      return closing;
    },
  });
  registries.set(registry, {
    root, host,
    assertOpen() {
      if (state !== "open" || controller.signal.aborted)
        throw new Error("Managed host child admission is closed.");
      host.assertCurrentRoot(root);
    },
  });
  return registry;
}
