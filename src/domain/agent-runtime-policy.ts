import { createHash } from "node:crypto";
import {
  AGENT_RUNTIME_LIMITS, agentRuntimeSnapshot, type AgentRuntimeSnapshot, type AgentRuntimeTask,
} from "../agent-runtime-contracts.js";

export class AgentRuntimeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function agentRuntimeHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function agentRuntimeGroup(nativeOwnerId: string): string {
  return "agent_group_" + agentRuntimeHash(["pkm", nativeOwnerId]);
}
export function agentRuntimeTerminal(state: string): boolean {
  return ["completed", "failed", "cancelled"].includes(state);
}
export function assertAgentRuntimeChild(parent: AgentRuntimeTask, child: AgentRuntimeTask): void {
  if (child.capabilities.some(capability => !parent.capabilities.includes(capability))) {
    throw new AgentRuntimeError("POLICY_DENIED", "A child cannot expand its parent's native capabilities.");
  }
}
/** Only explicit, pinned, synthetic fixtures are restorable. No legacy envelopes, prompts or grants. */
export function validateAgentRuntimeSnapshot(value: unknown): AgentRuntimeSnapshot {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > AGENT_RUNTIME_LIMITS.snapshotBytes) {
    throw new AgentRuntimeError("LIMIT_EXCEEDED", "Synthetic snapshot exceeds its byte boundary.");
  }
  const parsed = agentRuntimeSnapshot.safeParse(value);
  if (!parsed.success) throw new AgentRuntimeError("INVALID_SNAPSHOT", "Unsupported synthetic snapshot.");
  const snapshot = parsed.data;
  const visited = new Map<string, number>();
  const fanout = new Map<string, number>();
  let roots = 0;
  for (const node of snapshot.nodes) {
    if (visited.has(node.sourceId)) throw new AgentRuntimeError("INVALID_TREE", "Duplicate snapshot node.");
    if (node.parentSourceId === null) {
      if (++roots !== 1 || visited.size !== 0) throw new AgentRuntimeError("INVALID_TREE", "A snapshot has exactly one first root.");
      visited.set(node.sourceId, 0);
    } else {
      const parentDepth = visited.get(node.parentSourceId);
      if (parentDepth === undefined) throw new AgentRuntimeError("INVALID_TREE", "Snapshot nodes must follow their parents without cycles or orphans.");
      const count = (fanout.get(node.parentSourceId) ?? 0) + 1;
      if (parentDepth + 1 > AGENT_RUNTIME_LIMITS.depth || count > AGENT_RUNTIME_LIMITS.fanout) {
        throw new AgentRuntimeError("LIMIT_EXCEEDED", "Snapshot tree exceeds depth or fanout.");
      }
      fanout.set(node.parentSourceId, count);
      visited.set(node.sourceId, parentDepth + 1);
    }
  }
  return snapshot;
}
