import type { LegacyNativeMcpInstanceIdentity, LegacyNativeMcpOwnedChannel } from "./legacy-native-mcp-handoff";

type Tool = { name: string };
type Cancellation = {
  token: unknown;
  cancel(): void;
  dispose(): void;
};

/**
 * Adapts the VS Code tool API only after a caller independently binds the exact
 * server and its stop/exit observation. Tool names alone are not ownership.
 */
export function bindLegacyNativeMcpVscodeChannel(options: {
  tools(): readonly Tool[];
  statusName: string;
  quiesceName: string;
  assertOwned(): void;
  cancellation(): Cancellation;
  invoke(name: string, token: unknown): Promise<{ content: readonly unknown[] }>;
  stopAndVerify(signal: AbortSignal, identity: LegacyNativeMcpInstanceIdentity): Promise<void>;
}): LegacyNativeMcpOwnedChannel {
  const { statusName, quiesceName } = options;
  if (!statusName || !quiesceName || statusName === quiesceName
    || !statusName.endsWith("mcp_lifecycle_status") || !quiesceName.endsWith("mcp_lifecycle_quiesce"))
    throw new Error("Exact legacy lifecycle tool names are required.");
  const assertOwned = () => {
    options.assertOwned();
    const tools = options.tools();
    for (const name of [statusName, quiesceName]) {
      if (tools.filter(tool => tool.name === name).length !== 1)
        throw new Error("The bound lifecycle tool is unavailable or ambiguous.");
    }
  };
  const invoke = async (name: string, signal: AbortSignal): Promise<unknown> => {
    assertOwned();
    if (signal.aborted) throw new Error("MCP lifecycle request cancelled.");
    const cancellation = options.cancellation();
    let rejectCancellation!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    const cancel = () => {
      cancellation.cancel();
      rejectCancellation(new Error("MCP lifecycle request cancelled."));
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      const result = await Promise.race([Promise.resolve().then(() => {
        if (signal.aborted) throw new Error("MCP lifecycle request cancelled.");
        return options.invoke(name, cancellation.token);
      }), cancelled]);
      if (signal.aborted) throw new Error("MCP lifecycle request cancelled.");
      assertOwned();
      if (!result || !Array.isArray(result.content) || result.content.length !== 1)
        throw new Error("Invalid lifecycle tool result.");
      const part = result.content[0];
      if (!part || typeof part !== "object" || !("value" in part)
        || typeof part.value !== "string" || Buffer.byteLength(part.value) > 65536)
        throw new Error("Invalid lifecycle tool result.");
      return JSON.parse(part.value);
    } finally {
      signal.removeEventListener("abort", cancel);
      cancellation.dispose();
    }
  };
  return {
    assertOwned,
    status: signal => invoke(statusName, signal),
    quiesce: signal => invoke(quiesceName, signal),
    async stopAndVerify(signal, identity) {
      assertOwned();
      if (signal.aborted) throw new Error("MCP stop cancelled.");
      await options.stopAndVerify(signal, identity);
    },
  };
}
