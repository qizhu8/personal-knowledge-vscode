import type { Storage } from "./storage.js";

export interface NextRoomPortalRequest {
  root: string;
  contextId: string;
  operation: "connect" | "restore" | "command" | "task" | "files";
  pairId?: string;
  peerId?: string;
  detail?: unknown;
}
export interface NextRoomPortalExecutors {
  /** Explicit separate-workspace composition retaining the product's original PKM tools/Chat root. */
  legacyContext?: true;
  authorize(request: Readonly<NextRoomPortalRequest>): Promise<boolean>;
  /** Execution owns durable request idempotency; the admission token alone is not a durable process receipt. */
  executeCommand?(input: NextRoomPortalRequest & { requestId: string; command: unknown; defaultCwd: string; signal: AbortSignal }): Promise<unknown>;
}

/** Explicit owner policy and execution ports, never a marker-selected legacy tool fallback. */
export function createNextRoomPortalAuthority(options: {
  storage: Storage; workspaceId: string; assertAuthority(): void; executors: NextRoomPortalExecutors;
}) {
  const assert = () => { options.assertAuthority(); options.storage.assertWorkspaceLease(); };
  const grants = new Map<string, number>();
  const executions = new Set<AbortController>();
  let epoch = 0, monitor: ReturnType<typeof setInterval> | undefined;
  const cancelPending = (reason: unknown = new Error("Portal owner stopped.")) => {
    epoch++;
    grants.clear();
    if (monitor) { clearInterval(monitor); monitor = undefined; }
    for (const controller of executions) controller.abort(reason);
  };
  const fingerprint = (value: NextRoomPortalRequest) => JSON.stringify({
    root: value.root, contextId: value.contextId, operation: value.operation,
    pairId: value.pairId, peerId: value.peerId, detail: value.detail,
  });
  const freeze = (value: any): any => {
    if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
    return value;
  };
  const request = (value: NextRoomPortalRequest) => {
    assert();
    if (value.root !== options.storage.workspaceRoot() || !/^[a-f0-9-]{36}$/.test(value.contextId)
      || !["connect", "restore", "command", "task", "files"].includes(value.operation))
      throw new Error("Portal owner context does not match the owned workspace.");
    return freeze(JSON.parse(JSON.stringify(value))) as Readonly<NextRoomPortalRequest>;
  };
  const guard = async () => {
    assert();
    if (await options.storage.workspaceId() !== options.workspaceId) throw new Error("Portal workspace identity changed.");
    assert();
  };
  return {
    legacyContext: options.executors.legacyContext === true,
    assertAuthority: assert,
    executionEpoch() { assert(); return epoch; },
    assertExecution(admittedEpoch: number) {
      assert();
      if (admittedEpoch !== epoch) throw new Error("Portal owner lifecycle changed; inspect existing receipts before retry.");
    },
    cancelPending,
    async authorize(value: NextRoomPortalRequest) {
      const admittedEpoch = epoch;
      const snapshot = request(value);
      await guard();
      if (!options.executors.legacyContext && (snapshot.operation === "files" || snapshot.operation === "task")
        || snapshot.operation === "command" && !options.executors.executeCommand) return false;
      const allowed = await options.executors.authorize(snapshot);
      await guard();
      if (epoch !== admittedEpoch) throw new Error("Portal lifecycle changed during owner approval.");
      for (const [key, expires] of grants) if (expires <= Date.now()) grants.delete(key);
      if (allowed === true && snapshot.operation === "command") {
        if (grants.size >= 1000) throw new Error("Too many pending Portal command admissions.");
        grants.set(fingerprint(snapshot), Date.now() + 60_000);
      }
      return allowed === true;
    },
    ...(options.executors.executeCommand ? { async executeCommand(input: Parameters<NonNullable<NextRoomPortalExecutors["executeCommand"]>>[0]) {
      const admittedEpoch = epoch;
      const snapshot = request(input);
      const execution = Object.freeze({ ...snapshot,
        requestId: (snapshot as typeof input).requestId, command: (snapshot as typeof input).command,
        defaultCwd: (snapshot as typeof input).defaultCwd, signal: input.signal });
      await guard();
      const key = fingerprint(execution), expires = grants.get(key);
      grants.delete(key);
      if (execution.operation !== "command" || execution.signal.aborted) throw new Error("Portal command is unavailable or cancelled.");
      if (!expires || expires <= Date.now() || JSON.stringify(execution.command) !== JSON.stringify((execution.detail as any)?.command)
        || execution.defaultCwd !== (execution.detail as any)?.defaultCwd || execution.requestId !== (execution.detail as any)?.requestId)
        throw new Error("Portal command has no matching one-use workspace-owner admission.");
      const controller = new AbortController();
      const abort = () => controller.abort(input.signal.reason);
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      executions.add(controller);
      monitor ??= setInterval(() => {
        try { assert(); } catch (error) { cancelPending(error); }
      }, 250);
      monitor.unref();
      try {
        if (epoch !== admittedEpoch) throw new Error("Portal lifecycle changed before command execution.");
        const result = await options.executors.executeCommand!({ ...execution, signal: controller.signal });
        await guard();
        if (epoch !== admittedEpoch) throw new Error("Portal owner stopped during command execution.");
        return result;
      } finally {
        input.signal.removeEventListener("abort", abort);
        executions.delete(controller);
        if (!executions.size && monitor) { clearInterval(monitor); monitor = undefined; }
      }
    } } : {}),
  };
}
