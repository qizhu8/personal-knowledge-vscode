import type { DatabaseSync } from "node:sqlite";
import { agentRuntimeDefinitions, type AgentRuntimeTask, type AgentRuntimeSpawnInput, type AgentRuntimeCancelInput, type AgentRuntimeRestoreInput } from "./agent-runtime-contracts.js";
import { createAgentRuntimeStore, type AgentRuntimeStoreOptions, type AgentRuntimeOwner, type AgentRuntimeObservation } from "./agent-runtime-store.js";
import { AgentRuntimeError, agentRuntimeTerminal } from "./domain/agent-runtime-policy.js";

/** Opaque in-process native capability, not a string or JSON identity. resolveOwner must reject fabricated objects. */
export type AgentRuntimeOwnerToken = object;
export interface AgentRuntimeHostInvocation {
  sessionId: string; intentId: string; owner: Readonly<AgentRuntimeOwner>;
}
export interface AgentRuntimeHost {
  resolveOwner(token: AgentRuntimeOwnerToken): AgentRuntimeOwner | undefined;
  /** Executes a CONFIGURED task key/policy only. No caller-supplied prompt, model or permission grant. */
  spawn(invocation: AgentRuntimeHostInvocation & { task: Readonly<AgentRuntimeTask> }): Promise<AgentRuntimeObservation>;
  /** Recovery lookup MUST NOT spawn, retry execution or treat a missing handle as permission to create. */
  inspect(invocation: AgentRuntimeHostInvocation & { handle?: string }): Promise<AgentRuntimeObservation>;
  /** Idempotent cancellation request, not a claimed terminal report. inspect confirms terminal state. */
  cancel(invocation: AgentRuntimeHostInvocation & { handle?: string }): Promise<void>;
}

/**
 * Native coordinator API. Inject the shared initialized DatabaseSync and a trusted native host.
 * Calls must start outside a transaction. No timers, automatic startup replay, file I/O or VS Code dependency.
 * Native host calls happen only after COMMIT; failed/ambiguous dispatch is never automatically re-spawned.
 * Public get/list/cancel/reconnect accept only native owner tokens, never actor IDs or completion results.
 */
export function createAgentRuntime(db: DatabaseSync, options: AgentRuntimeStoreOptions & {
  host?: AgentRuntimeHost; assertOwner?: () => void;
  onMutation?: (input: {
    actorId: string; nativeOwnerId: string; opId: string; operation: string; args: unknown;
    receipt: ReturnType<ReturnType<typeof createAgentRuntimeStore>["execute"]>;
    session: ReturnType<ReturnType<typeof createAgentRuntimeStore>["get"]>;
  }) => void;
}) {
  const store = createAgentRuntimeStore(db, options);
  const host = options.host;
  function outside() {
    if (db.isTransaction) throw new AgentRuntimeError("TRANSACTION_BOUNDARY", "Native host coordination cannot run within a caller transaction.");
    options.assertOwner?.();
  }
  function owner(token: AgentRuntimeOwnerToken): AgentRuntimeOwner {
    outside();
    if (!host) throw new AgentRuntimeError("HOST_UNAVAILABLE", "A configured trusted native session host is required.");
    if (token === null || typeof token !== "object") throw new AgentRuntimeError("UNAUTHORIZED", "Native owner token required.");
    const result = host.resolveOwner(token);
    if (!result) throw new AgentRuntimeError("UNAUTHORIZED", "Native owner token was not issued by this host.");
    return { actorId: result.actorId, nativeOwnerId: result.nativeOwnerId };
  }
  function atomic<T>(fn: () => T): T {
    outside();
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); options.assertOwner?.(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function invocation(context: AgentRuntimeOwner, id: string) {
    return { owner: { ...context }, sessionId: id, intentId: id };
  }
  function apply(context: AgentRuntimeOwner, id: string, revision: number, observation: AgentRuntimeObservation) {
    try { return atomic(() => store.observe(context, id, revision, observation)); }
    catch (error) {
      // A concurrent cancellation wins over a stale spawn/read response; its next reconnect reconciles the handle.
      if (error instanceof AgentRuntimeError && error.code === "REVISION_CONFLICT") return store.get(context, id);
      throw error;
    }
  }
  async function drive(context: AgentRuntimeOwner, id: string) {
    const claim = atomic(() => store.claimSpawn(context, id));
    if (!claim) return store.get(context, id);
    let observation: AgentRuntimeObservation;
    try { observation = await host!.spawn({ ...invocation(context, id), task: claim.task }); }
    catch { return store.get(context, id); }
    outside();
    return apply(context, id, claim.record.revision, observation);
  }
  async function reconcile(context: AgentRuntimeOwner, id: string) {
    const binding = store.binding(context, id);
    if (agentRuntimeTerminal(binding.record.state)) return binding.record;
    if (binding.record.state === "intent") return drive(context, id);
    const args = { ...invocation(context, id), ...(binding.handle ? { handle: binding.handle } : {}) };
    try {
      if (binding.record.state === "cancel-requested") await host!.cancel(args);
      outside();
      const observation = await host!.inspect(args);
      outside();
      return apply(context, id, binding.record.revision, observation);
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error;
      return store.get(context, id);
    }
  }
  return {
    get(token: AgentRuntimeOwnerToken, input: unknown) {
      const context = owner(token);
      const parsed = agentRuntimeDefinitions[3].input.safeParse(input);
      if (!parsed.success) throw new AgentRuntimeError("INVALID_INPUT", "Invalid Agent read arguments.");
      return store.get(context, parsed.data.id);
    },
    list(token: AgentRuntimeOwnerToken, input: unknown = {}) { return store.list(owner(token), input); },
    async spawn(token: AgentRuntimeOwnerToken, input: AgentRuntimeSpawnInput) {
      const context = owner(token);
      const receipt = atomic(() => {
        const value = store.execute(context, "spawn", input);
        options.onMutation?.({ actorId: context.actorId, nativeOwnerId: context.nativeOwnerId,
          opId: input.opId, operation: "spawn", args: input, receipt: value, session: store.get(context, value.rootId) });
        return value;
      });
      await drive(context, receipt.rootId);
      return { receipt, session: store.get(context, receipt.rootId) };
    },
    async cancel(token: AgentRuntimeOwnerToken, input: AgentRuntimeCancelInput) {
      const context = owner(token);
      const receipt = atomic(() => {
        const value = store.execute(context, "cancel", input);
        options.onMutation?.({ actorId: context.actorId, nativeOwnerId: context.nativeOwnerId,
          opId: input.opId, operation: "cancel", args: input, receipt: value, session: store.get(context, value.rootId) });
        return value;
      });
      // Children first. Host errors never undo a durable subtree cancellation intent.
      for (const id of [...receipt.ids].reverse()) await reconcile(context, id);
      return { receipt, session: store.get(context, receipt.rootId) };
    },
    async reconnect(token: AgentRuntimeOwnerToken, input: unknown) {
      const context = owner(token);
      const parsed = agentRuntimeDefinitions[5].input.safeParse(input);
      if (!parsed.success) throw new AgentRuntimeError("INVALID_INPUT", "Invalid reconnect arguments.");
      const receipt = atomic(() => {
        const value = store.execute(context, "reconnect", parsed.data);
        options.onMutation?.({ actorId: context.actorId, nativeOwnerId: context.nativeOwnerId,
          opId: parsed.data.opId, operation: "reconnect", args: parsed.data, receipt: value, session: store.get(context, value.rootId) });
        return value;
      });
      return reconcile(context, receipt.rootId);
    },
    async restore(token: AgentRuntimeOwnerToken, input: AgentRuntimeRestoreInput) {
      const context = owner(token);
      const receipt = atomic(() => {
        const value = store.execute(context, "restore", input);
        options.onMutation?.({ actorId: context.actorId, nativeOwnerId: context.nativeOwnerId,
          opId: input.opId, operation: "restore", args: input, receipt: value, session: store.get(context, value.rootId) });
        return value;
      });
      for (const id of receipt.ids) await drive(context, id);
      return { receipt, session: store.get(context, receipt.rootId) };
    },
  };
}
