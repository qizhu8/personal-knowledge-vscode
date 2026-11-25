import { CoreError } from "../host-composition-legacy-batch15-errors.js";
import type { WorkflowDefinitionV1 } from "./project-recipes-workflow-contracts.js";
import { WORKFLOW_EXECUTOR_LIMITS as L } from "./workflow-executor-limits.js";

export interface OriginalRecipeLoop {
  loopId: string; source: string; target: string; accept: string[];
  condition: string; maxIterations: number; body: string[];
}
export function originalRecipeLoops(definition: WorkflowDefinitionV1): OriginalRecipeLoop[] {
  const forward = new Map<string, string[]>(), reverse = new Map<string, string[]>();
  for (const node of definition.spec.nodes) {
    forward.set(node.nodeId, []); reverse.set(node.nodeId, []);
  }
  for (const node of definition.spec.nodes) for (const edge of node.dependsOn.filter(edge => !edge.loop)) {
    forward.get(edge.from)!.push(node.nodeId); reverse.get(node.nodeId)!.push(edge.from);
  }
  function reachable(graph: Map<string, string[]>, start: string) {
    const found = new Set([start]), pending = [start];
    while (pending.length) for (const next of graph.get(pending.pop()!)!) {
      if (!found.has(next)) { found.add(next); pending.push(next); }
    }
    return found;
  }
  const loops: OriginalRecipeLoop[] = [];
  for (const node of definition.spec.nodes) for (const edge of node.dependsOn.filter(edge => edge.loop)) {
    const from = reachable(forward, node.nodeId), to = reachable(reverse, edge.from);
    const body = definition.spec.nodes.filter(item => from.has(item.nodeId) && to.has(item.nodeId)).map(item => item.nodeId);
    if (!body.includes(node.nodeId) || !body.includes(edge.from))
      throw new CoreError("INVALID_DEFINITION", "Original loop must close a forward execution path.");
    const { condition, maxIterations } = edge.loop!.termination;
    if (maxIterations > L.iterations) throw new CoreError("RESOURCE_LIMIT", "Original loop exceeds the iteration bound.");
    const loopId = `${edge.from}->${node.nodeId}`;
    if (loops.some(loop => loop.loopId === loopId)) throw new CoreError("INVALID_DEFINITION", "Duplicate Original loop identity.");
    loops.push({ loopId, source: edge.from, target: node.nodeId, accept: edge.accept, condition, maxIterations, body });
  }
  return loops;
}
