import { AsyncLocalStorage } from "node:async_hooks";

export interface LegacyEnvironmentDispatchPause { readonly kind: "pkm.legacy-environment-dispatch-pause/v1" }
type Binding = Readonly<{ knowledgeRoot: string; globalStorageDirectory: string }>;
const pauses = new WeakMap<LegacyEnvironmentDispatchPause, { gate: LegacyEnvironmentDispatch; binding: Binding }>();

/** Counts enrolled legacy callbacks, not unobserved processes or outside writers. */
export class LegacyEnvironmentDispatch {
  private state: "legacy" | "closing" | "paused" | "unknown" = "legacy";
  private readonly active = new Set<Promise<unknown>>();
  private readonly context = new AsyncLocalStorage<{ open: boolean }>();
  private failure = false;
  private unmanagedEffects = false;
  private pausing?: Promise<LegacyEnvironmentDispatchPause>;
  private pause?: LegacyEnvironmentDispatchPause;
  private readonly binding: Binding;

  constructor(binding: Binding) { this.binding = Object.freeze({ ...binding }); }

  observe<T>(kind: "read" | "effect", work: () => T | Promise<T>): Promise<T> {
    const parent = this.context.getStore();
    if (this.state !== "legacy" && !(this.state === "closing" && parent?.open))
      return Promise.reject(new Error("Legacy Environment dispatch is closed."));
    if (kind !== "read" && kind !== "effect") return Promise.reject(new Error("Unknown legacy Environment work."));
    if (kind === "effect") this.unmanagedEffects = true;
    const scope = { open: true };
    let result: Promise<T>;
    try { result = Promise.resolve(this.context.run(scope, work)); }
    catch (error) { result = Promise.reject(error); }
    const tracked = result.catch(error => { this.failure = true; throw error; })
      .finally(() => { scope.open = false; this.active.delete(tracked); });
    this.active.add(tracked);
    return tracked;
  }

  pauseLegacy(): Promise<LegacyEnvironmentDispatchPause> {
    if (this.pausing) return this.pausing;
    if (this.state !== "legacy") return Promise.reject(new Error("Legacy Environment dispatch cannot be handed off."));
    this.state = "closing";
    this.pausing = (async () => {
      while (this.active.size) await Promise.allSettled([...this.active]);
      if (this.failure || this.unmanagedEffects) {
        this.state = "unknown";
        throw new Error("UNKNOWN: legacy Environment effects lack physical family-drain proof; restart or independently resolve them.");
      }
      this.state = "paused";
      this.pause = Object.freeze({ kind: "pkm.legacy-environment-dispatch-pause/v1" });
      pauses.set(this.pause, { gate: this, binding: this.binding });
      return this.pause;
    })();
    return this.pausing;
  }

  assertPaused(pause: LegacyEnvironmentDispatchPause): void {
    if (this.state !== "paused" || this.pause !== pause || this.active.size)
      throw new Error("Legacy Environment dispatch pause is not current.");
  }

  resume(pause: LegacyEnvironmentDispatchPause): void {
    this.assertPaused(pause);
    pauses.delete(pause); this.pause = undefined; this.pausing = undefined; this.state = "legacy";
  }
}

export function assertPausedLegacyEnvironmentDispatch(pause: LegacyEnvironmentDispatchPause, binding: Binding): void {
  const entry = pauses.get(pause);
  if (!entry || entry.binding.knowledgeRoot !== binding.knowledgeRoot
    || entry.binding.globalStorageDirectory !== binding.globalStorageDirectory)
    throw new Error("A current same-Root/profile legacy Environment dispatch pause is required.");
  entry.gate.assertPaused(pause);
}
