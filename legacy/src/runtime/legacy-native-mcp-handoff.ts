const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const instance = /^[a-f0-9]{32}$/;
const digest = /^[a-f0-9]{64}$/;

export type LegacyNativeMcpInstanceIdentity = Readonly<{
  generation: string;
  instanceId: string;
  runtimeBuild: string;
}>;

export interface LegacyNativeMcpOwnedChannel {
  /** The owner must bind this live channel to the exact VS Code server, not a registry or PID. */
  assertOwned(): void;
  status(signal: AbortSignal): Promise<unknown>;
  /** Cancel any undispatched request or pending confirmation when the signal aborts. */
  quiesce(signal: AbortSignal): Promise<unknown>;
  /** Closes this exact live owned transport and resolves only after its exit is verified. */
  stopAndVerify(signal: AbortSignal, identity: LegacyNativeMcpInstanceIdentity): Promise<void>;
}

type BoundStatus = {
  schema: "pkm.mcp.lifecycle/v1";
  generation: string;
  instanceId: string;
  runtimeBuild: string;
  phase: string;
  acceptingNewCalls: boolean;
  inFlight: number;
  uncertainCalls: number;
  controlError: string;
};

function lifecycle(value: unknown): BoundStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid lifecycle response.");
  const record = value as Record<string, unknown>;
  if (record.schema !== "pkm.mcp.lifecycle/v1" || typeof record.generation !== "string" || !uuid.test(record.generation)
    || typeof record.instanceId !== "string" || !instance.test(record.instanceId)
    || typeof record.runtimeBuild !== "string" || !digest.test(record.runtimeBuild)
    || typeof record.phase !== "string" || typeof record.acceptingNewCalls !== "boolean"
    || !Number.isSafeInteger(record.inFlight) || (record.inFlight as number) < 0
    || !Number.isSafeInteger(record.uncertainCalls) || (record.uncertainCalls as number) < 0
    || typeof record.controlError !== "string" || record.controlError)
    throw new Error("Invalid or uncertain lifecycle response.");
  return {
    schema: "pkm.mcp.lifecycle/v1", generation: record.generation, instanceId: record.instanceId,
    runtimeBuild: record.runtimeBuild, phase: record.phase, acceptingNewCalls: record.acceptingNewCalls,
    inFlight: record.inFlight as number, uncertainCalls: record.uncertainCalls as number,
    controlError: record.controlError,
  };
}

/** Retires only one already-owned connection; it does not establish root-wide exclusion. */
export async function prepareOwnedLegacyNativeMcpHandoffExperimental(
  channel: LegacyNativeMcpOwnedChannel, approve: (signal: AbortSignal) => Promise<boolean>, timeoutMs = 30_000,
): Promise<{ state: "drained-and-stopped" | "declined" | "unknown"; cutoverAuthorized: false }> {
  if (!channel || typeof channel.assertOwned !== "function" || typeof channel.status !== "function"
    || typeof channel.quiesce !== "function" || typeof channel.stopAndVerify !== "function"
    || typeof approve !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error("An exact live owner and bounded handoff are required.");
  const deadline = Date.now() + timeoutMs;
  const bounded = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Handoff timed out.");
    const cancellation = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => operation(cancellation.signal)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Handoff timed out."));
          cancellation.abort();
        }, remaining);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    channel.assertOwned();
    const first = lifecycle(await bounded(signal => channel.status(signal)));
    if (first.phase !== "accepting" || !first.acceptingNewCalls) throw new Error("MCP admission is not in its initial state.");
    if (!await bounded(approve)) return { state: "declined", cutoverAuthorized: false };
    channel.assertOwned();
    let current = lifecycle(await bounded(signal => channel.quiesce(signal)));
    const same = (value: BoundStatus) => value.generation === first.generation
      && value.instanceId === first.instanceId && value.runtimeBuild === first.runtimeBuild;
    for (;;) {
      if (!same(current) || current.acceptingNewCalls || current.uncertainCalls)
        throw new Error("MCP identity or drain outcome is uncertain.");
      if (current.phase === "drained" && current.inFlight === 0) break;
      if (current.phase !== "draining" || current.inFlight === 0) throw new Error("MCP drain is not verified.");
      await bounded(() => new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now())))));
      channel.assertOwned();
      current = lifecycle(await bounded(signal => channel.status(signal)));
    }
    channel.assertOwned();
    current = lifecycle(await bounded(signal => channel.status(signal)));
    if (!same(current) || current.phase !== "drained" || current.acceptingNewCalls
      || current.inFlight !== 0 || current.uncertainCalls !== 0) throw new Error("MCP drain changed before stop.");
    channel.assertOwned();
    const identity = Object.freeze({ generation: first.generation, instanceId: first.instanceId, runtimeBuild: first.runtimeBuild });
    await bounded(signal => channel.stopAndVerify(signal, identity));
    return { state: "drained-and-stopped", cutoverAuthorized: false };
  } catch {
    return { state: "unknown", cutoverAuthorized: false };
  }
}
