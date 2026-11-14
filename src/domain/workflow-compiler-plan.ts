import type { WorkflowDefinitionV1 } from "./project-recipes-workflow-contracts.js";

type RawNode = { nodeId?: unknown; dependsOn?: unknown[] };

export function workflowPlan(model: WorkflowDefinitionV1, original: unknown) {
  const raw = original as { spec: { nodes: RawNode[] } };
  const nodes = model.spec.nodes;
  const edges = nodes.flatMap(node => node.dependsOn.map(dependency => ({ ...dependency, to: node.nodeId })));
  const pending = new Map(nodes.map(node => [node.nodeId, node.dependsOn.filter(edge => !edge.loop).length]));
  const outgoing = new Map(nodes.map(node => [node.nodeId, [] as string[]]));
  for (const edge of edges) if (!edge.loop) outgoing.get(edge.from)!.push(edge.to);
  const layers: string[][] = [];
  let ready = nodes.filter(node => pending.get(node.nodeId) === 0).map(node => node.nodeId);
  while (ready.length) {
    layers.push(ready);
    const next: string[] = [];
    for (const id of ready) for (const target of outgoing.get(id)!) {
      pending.set(target, pending.get(target)! - 1);
      if (pending.get(target) === 0) next.push(target);
    }
    ready = next.sort();
  }
  const order: string[] = [];
  if (model.spec.traversalStrategy === "depth-first") {
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const node = nodes.find(node => node.nodeId === id)!;
      for (const dependency of node.dependsOn) if (!dependency.loop) visit(dependency.from);
      order.push(id);
    };
    for (const node of nodes) visit(node.nodeId);
  } else order.push(...layers.flat());
  return {
    schema: "pkm.workflow.plan/v1" as const, execution: "unavailable" as const,
    nodes: nodes.map(({ nodeId, kind }) => ({ nodeId, kind })),
    edges, order, layers, depth: layers.length,
    requiredNodes: model.spec.completion.requiredNodes,
    traversalStrategy: model.spec.traversalStrategy ?? "breadth-first",
    sourceMap: nodes.map((node, index) => {
      const originalIndex = raw.spec.nodes.findIndex(candidate => candidate.nodeId === node.nodeId);
      const originalDependencies = raw.spec.nodes[originalIndex]!.dependsOn ?? [];
      return {
        nodeId: node.nodeId, sourcePointer: `/spec/nodes/${originalIndex}`,
        canonicalPointer: `/spec/nodes/${index}`,
        dependencies: node.dependsOn.map((edge, edgeIndex) => {
          const sourceIndex = originalDependencies.findIndex(value => {
            const candidate = value as Record<string, unknown>;
            return candidate.from === edge.from && candidate.fromOutput === edge.fromOutput
              && candidate.toInput === edge.toInput;
          });
          return {
            sourcePointer: `/spec/nodes/${originalIndex}/dependsOn/${sourceIndex}`,
            canonicalPointer: `/spec/nodes/${index}/dependsOn/${edgeIndex}`,
          };
        }),
      };
    }),
  };
}
