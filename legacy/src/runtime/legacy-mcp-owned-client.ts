import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ChildProcess } from "node:child_process";
import { prepareOwnedLegacyNativeMcpHandoffExperimental } from "./legacy-native-mcp-handoff";
import { beginExistingManagedMcp, completeExistingManagedMcp, type ExistingManagedMcpRegistration } from "./managed-writer-session";

const handoffs = new WeakMap<Client, "running" | "unknown">();

/** Cooperate with one already-connected, client-owned legacy stdio process. */
export async function retireOwnedLegacyMcpClient(options: {
  client: Client;
  transport: StdioClientTransport;
  notifyAndApprove(signal: AbortSignal): Promise<boolean>;
  verifyOwnedDescendantsExited(child: ChildProcess): Promise<void>;
  managedSession?: { root: string; sessionId: string };
  timeoutMs?: number;
}): Promise<{ state: "drained-and-stopped" | "declined" | "unknown"; cutoverAuthorized: false }> {
  const { client, transport } = options;
  const child = (transport as unknown as { _process?: ChildProcess })._process;
  if (!child?.stdin || !child.pid || child.pid !== transport.pid || client.transport !== transport
    || typeof options.notifyAndApprove !== "function" || typeof options.verifyOwnedDescendantsExited !== "function")
    throw new Error("An exact live client-owned MCP transport and exit verifier are required.");
  if (handoffs.has(client)) throw new Error("This client already has an active or uncertain MCP handoff.");
  handoffs.set(client, "running");
  const assertOwned = () => {
    if (client.transport !== transport || (transport as unknown as { _process?: ChildProcess })._process !== child
      || transport.pid !== child.pid || child.exitCode !== null || child.signalCode !== null || !child.stdin?.writable)
      throw new Error("The owned MCP transport changed or exited.");
  };
  let firstIdentity: { generation: string; instanceId: string; runtimeBuild: string } | undefined;
  let registration: ExistingManagedMcpRegistration | undefined;
  let quiesceStarted = false;
  const call = async (name: "mcp_lifecycle_status" | "mcp_lifecycle_quiesce", signal: AbortSignal) => {
    assertOwned();
    const result = await client.callTool({ name, arguments: {} }, undefined, { signal });
    if (result.isError) throw new Error("Legacy MCP lifecycle failed.");
    let value: unknown = result.structuredContent;
    if (value === undefined) {
      if (!Array.isArray(result.content) || result.content.some(part => part.type !== "text" || typeof part.text !== "string"))
        throw new Error("Legacy MCP lifecycle response is invalid.");
      value = JSON.parse(result.content.map(part => part.text).join(""));
    }
    if (name === "mcp_lifecycle_status" && !firstIdentity && value && typeof value === "object") {
      const { generation, instanceId, runtimeBuild } = value as Record<string, unknown>;
      if (typeof generation === "string" && typeof instanceId === "string" && typeof runtimeBuild === "string")
        firstIdentity = { generation, instanceId, runtimeBuild };
    }
    return value;
  };
  try {
    const outcome = await prepareOwnedLegacyNativeMcpHandoffExperimental({
      assertOwned,
      status: signal => call("mcp_lifecycle_status", signal),
      quiesce: signal => { quiesceStarted = true; return call("mcp_lifecycle_quiesce", signal); },
      async stopAndVerify(signal) {
        assertOwned();
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { child.removeListener("close", onClose); signal.removeEventListener("abort", onAbort); };
          const onClose = (code: number | null, termination: NodeJS.Signals | null) => {
            cleanup();
            if (code !== 0 || termination !== null) reject(new Error("Legacy MCP process did not exit cleanly."));
            else resolve();
          };
          const onAbort = () => { cleanup(); reject(new Error("Legacy MCP exit observation expired.")); };
          child.once("close", onClose);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) { onAbort(); return; }
          child.stdin!.end();
        });
        await options.verifyOwnedDescendantsExited(child);
        if (signal.aborted) throw new Error("Legacy MCP tree verification expired.");
        if (registration) completeExistingManagedMcp(registration);
      },
    }, async signal => {
      if (!await options.notifyAndApprove(signal)) return false;
      if (signal.aborted) throw new Error("Legacy MCP approval expired.");
      assertOwned();
      if (options.managedSession) {
        if (!firstIdentity) throw new Error("Existing MCP identity was not observed.");
        registration = beginExistingManagedMcp(options.managedSession.root, options.managedSession.sessionId, firstIdentity);
      }
      return true;
    }, options.timeoutMs);
    if (outcome.state === "unknown" && (quiesceStarted || registration)) handoffs.set(client, "unknown");
    else handoffs.delete(client);
    return outcome;
  } catch (error) {
    if (quiesceStarted || registration) handoffs.set(client, "unknown");
    else handoffs.delete(client);
    throw error;
  }
}
