import type { KnowledgeLinkV1 } from "./knowledge-contracts";
import type { RetrievalCapabilityScope, RetrievalDiagnostic, RetrievalGraphBudget } from "./retrieval-contracts";

export interface LinkGraphNode {
  sourceId: string;
  sourceUri: string;
  sourceRevision: string;
  visibility: "available" | "private" | "trashed" | "unavailable";
  links: KnowledgeLinkV1[];
}

export interface LinkGraphEdge {
  sourceId: string;
  targetId: string;
  relation: string;
  mode: "floating" | "pinned";
  targetRevision?: string;
}

export interface LinkGraphTraversal {
  nodes: string[];
  edges: LinkGraphEdge[];
  diagnostics: RetrievalDiagnostic[];
  truncated: boolean;
}

function canonicalId(value: string): boolean {
  return /^pkm:\/\/(knowledge\/knowledge_[a-f0-9]{24}|script\/script_[A-Za-z0-9._-]+|project\/project_[A-Za-z0-9._-]+)$/.test(value);
}

export class DerivedLinkGraph {
  private readonly nodesById = new Map<string, LinkGraphNode>();
  private readonly idsByUri = new Map<string, string>();
  private readonly forward = new Map<string, LinkGraphEdge[]>();
  private readonly backlinks = new Map<string, LinkGraphEdge[]>();

  replace(nodes: readonly LinkGraphNode[]): void {
    this.nodesById.clear();
    this.idsByUri.clear();
    this.forward.clear();
    this.backlinks.clear();
    for (const node of nodes) {
      if (!node.sourceId || !canonicalId(node.sourceUri)) throw new Error(`Invalid graph node ${node.sourceId || "<empty>"}.`);
      if (this.nodesById.has(node.sourceId) || this.idsByUri.has(node.sourceUri)) throw new Error(`Duplicate graph node ${node.sourceId}.`);
      this.nodesById.set(node.sourceId, { ...node, links: node.links.map(link => ({ ...link })) });
      this.idsByUri.set(node.sourceUri, node.sourceId);
    }
    for (const node of this.nodesById.values()) {
      for (const link of node.links) {
        if (!canonicalId(link.target)) throw new Error(`Invalid canonical link target ${link.target}.`);
        const targetId = this.idsByUri.get(link.target) || link.target;
        const edge: LinkGraphEdge = {
          sourceId: node.sourceId,
          targetId,
          relation: link.relation,
          mode: link.mode,
          ...(link.targetRevision ? { targetRevision: link.targetRevision } : {}),
        };
        this.forward.set(node.sourceId, [...(this.forward.get(node.sourceId) || []), edge]);
        this.backlinks.set(targetId, [...(this.backlinks.get(targetId) || []), edge]);
      }
    }
  }

  get nodeCount(): number { return this.nodesById.size; }
  get edgeCount(): number { return [...this.forward.values()].reduce((count, edges) => count + edges.length, 0); }

  traverse(startIds: readonly string[], budget: RetrievalGraphBudget, scope: RetrievalCapabilityScope): LinkGraphTraversal {
    const allowed = scope.sourceIds ? new Set(scope.sourceIds) : undefined;
    const visible = (sourceId: string): boolean => {
      const node = this.nodesById.get(sourceId);
      return !!node && node.visibility === "available" && (!allowed || allowed.has(sourceId));
    };
    const nodes: string[] = [];
    const edges: LinkGraphEdge[] = [];
    const diagnostics: RetrievalDiagnostic[] = [];
    const visited = new Set<string>();
    const queued = new Set<string>();
    const queue: { sourceId: string; depth: number }[] = [];
    for (const sourceId of startIds) {
      if (!visible(sourceId) || queued.has(sourceId)) continue;
      queue.push({ sourceId, depth: 0 });
      queued.add(sourceId);
    }
    const relations = budget.relations?.length ? new Set(budget.relations) : undefined;
    const direction = budget.direction || "both";
    let truncated = false;
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current.sourceId)) {
        diagnostics.push({ code: "cycle", message: "Graph cycle was bounded by the visited set.", sourceId: current.sourceId });
        continue;
      }
      visited.add(current.sourceId);
      nodes.push(current.sourceId);
      if (nodes.length >= budget.maxNodes) {
        truncated = queue.length > 0
          || (current.depth < budget.maxDepth && [
            ...(direction === "backlink" ? [] : this.forward.get(current.sourceId) || []),
            ...(direction === "forward" ? [] : this.backlinks.get(current.sourceId) || []),
          ].some(edge => !relations || relations.has(edge.relation)));
        break;
      }
      if (current.depth >= budget.maxDepth) continue;
      const candidates = [
        ...(direction === "backlink" ? [] : this.forward.get(current.sourceId) || []),
        ...(direction === "forward" ? [] : this.backlinks.get(current.sourceId) || []),
      ];
      for (const edge of candidates) {
        if (relations && !relations.has(edge.relation)) continue;
        const nextId = edge.sourceId === current.sourceId ? edge.targetId : edge.sourceId;
        const targetNode = this.nodesById.get(nextId);
        if (!targetNode) {
          diagnostics.push({
            code: "unresolved-target",
            message: "A canonical graph target is unresolved.",
            sourceId: current.sourceId,
            targetId: nextId,
            relation: edge.relation,
          });
          continue;
        }
        if (!visible(nextId)) {
          const targetVisibleToCapability = !!allowed?.has(nextId);
          const diagnosticCode = targetVisibleToCapability && targetNode.visibility === "private"
            ? "private-target"
            : targetVisibleToCapability && targetNode.visibility === "trashed"
              ? "trashed-target"
              : "unavailable-target";
          diagnostics.push({
            code: diagnosticCode,
            message: "A graph target is outside the caller capability scope.",
            sourceId: current.sourceId,
            ...(targetVisibleToCapability ? { targetId: nextId } : {}),
            relation: edge.relation,
          });
          continue;
        }
        if (edge.mode === "pinned" && edge.targetRevision !== targetNode.sourceRevision) {
          diagnostics.push({
            code: "pinned-revision-mismatch",
            message: "Pinned graph target revision is unavailable.",
            sourceId: current.sourceId,
            targetId: nextId,
            relation: edge.relation,
          });
          continue;
        }
        edges.push(edge);
        if (edges.length >= budget.maxEdges) {
          truncated = true;
          break;
        }
        if (visited.has(nextId)) {
          diagnostics.push({ code: "cycle", message: "Graph cycle was bounded by the visited set.", sourceId: nextId, relation: edge.relation });
          continue;
        }
        if (!queued.has(nextId)) {
          queue.push({ sourceId: nextId, depth: current.depth + 1 });
          queued.add(nextId);
        }
      }
      if (truncated) break;
    }
    if (truncated) diagnostics.push({ code: "truncated", message: "Graph traversal stopped at the configured budget." });
    return { nodes, edges, diagnostics: diagnostics.slice(0, 100), truncated };
  }
}
