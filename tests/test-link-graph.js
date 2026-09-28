#!/usr/bin/env node
const assert = require("assert");
const { DerivedLinkGraph } = require("../dist/link-graph.js");

const ids = {
  a: "pkm://knowledge/knowledge_aaaaaaaaaaaaaaaaaaaaaaaa",
  b: "pkm://knowledge/knowledge_bbbbbbbbbbbbbbbbbbbbbbbb",
  c: "pkm://knowledge/knowledge_cccccccccccccccccccccccc",
  d: "pkm://knowledge/knowledge_dddddddddddddddddddddddd",
};
const node = (id, revision, visibility, links = []) => ({
  sourceId: id,
  sourceUri: id,
  sourceRevision: revision,
  visibility,
  links,
});
const graph = new DerivedLinkGraph();
graph.replace([
  node(ids.a, "1", "available", [
    { relation: "supports", target: ids.b, mode: "floating", required: true },
    { relation: "cites", target: ids.c, mode: "pinned", required: false, targetRevision: "7" },
    { relation: "mentions", target: ids.d, mode: "floating", required: false },
    { relation: "unresolved", target: "pkm://knowledge/knowledge_eeeeeeeeeeeeeeeeeeeeeeee", mode: "floating", required: false },
  ]),
  node(ids.b, "2", "available", [{ relation: "supports", target: ids.a, mode: "floating", required: false }]),
  node(ids.c, "8", "available"),
  node(ids.d, "1", "private"),
]);
assert.strictEqual(graph.nodeCount, 4);
assert.strictEqual(graph.edgeCount, 5);

const forward = graph.traverse([ids.a], {
  maxDepth: 4, maxNodes: 10, maxEdges: 10, relations: ["supports"], direction: "forward",
}, { capabilityId: "all", sourceIds: [ids.a, ids.b, ids.c] });
assert.deepStrictEqual(new Set(forward.nodes), new Set([ids.a, ids.b]));
assert(forward.diagnostics.some(item => item.code === "cycle"));

const pinned = graph.traverse([ids.a], {
  maxDepth: 2, maxNodes: 10, maxEdges: 10, relations: ["cites"], direction: "forward",
}, { capabilityId: "all", sourceIds: [ids.a, ids.b, ids.c] });
assert(pinned.diagnostics.some(item => item.code === "pinned-revision-mismatch"));
assert(!pinned.nodes.includes(ids.c));

const unavailable = graph.traverse([ids.a], {
  maxDepth: 2, maxNodes: 10, maxEdges: 10, relations: ["mentions"], direction: "forward",
}, { capabilityId: "limited", sourceIds: [ids.a] });
assert.deepStrictEqual(unavailable.diagnostics[0], {
  code: "unavailable-target",
  message: "A graph target is outside the caller capability scope.",
  sourceId: ids.a,
  relation: "mentions",
});
assert(!JSON.stringify(unavailable).includes(ids.d), "out-of-scope private target identity must not leak");

const privateDiagnostic = graph.traverse([ids.a], {
  maxDepth: 2, maxNodes: 10, maxEdges: 10, relations: ["mentions"], direction: "forward",
}, { capabilityId: "private-aware", sourceIds: [ids.a, ids.d] });
assert(privateDiagnostic.diagnostics.some(item => item.code === "private-target" && item.targetId === ids.d));

graph.replace([
  node(ids.a, "1", "available", [{ relation: "archives", target: ids.d, mode: "floating", required: false }]),
  node(ids.d, "1", "trashed"),
]);
const trashedDiagnostic = graph.traverse([ids.a], {
  maxDepth: 2, maxNodes: 10, maxEdges: 10, relations: ["archives"], direction: "forward",
}, { capabilityId: "trash-aware", sourceIds: [ids.a, ids.d] });
assert(trashedDiagnostic.diagnostics.some(item => item.code === "trashed-target" && item.targetId === ids.d));

graph.replace([
  node(ids.a, "1", "available", [
    { relation: "supports", target: ids.b, mode: "floating", required: true },
    { relation: "cites", target: ids.c, mode: "pinned", required: false, targetRevision: "7" },
    { relation: "mentions", target: ids.d, mode: "floating", required: false },
    { relation: "unresolved", target: "pkm://knowledge/knowledge_eeeeeeeeeeeeeeeeeeeeeeee", mode: "floating", required: false },
  ]),
  node(ids.b, "2", "available", [{ relation: "supports", target: ids.a, mode: "floating", required: false }]),
  node(ids.c, "8", "available"),
  node(ids.d, "1", "private"),
]);

const unresolved = graph.traverse([ids.a], {
  maxDepth: 2, maxNodes: 10, maxEdges: 10, relations: ["unresolved"], direction: "forward",
}, { capabilityId: "all", sourceIds: [ids.a, ids.b, ids.c] });
assert(unresolved.diagnostics.some(item => item.code === "unresolved-target"));

const backlinks = graph.traverse([ids.b], {
  maxDepth: 1, maxNodes: 10, maxEdges: 10, relations: ["supports"], direction: "backlink",
}, { capabilityId: "all", sourceIds: [ids.a, ids.b] });
assert(backlinks.nodes.includes(ids.a), "derived backlinks must be traversable without becoming canonical links");

const truncated = graph.traverse([ids.a], {
  maxDepth: 4, maxNodes: 1, maxEdges: 1, direction: "both",
}, { capabilityId: "all", sourceIds: [ids.a, ids.b, ids.c] });
assert.strictEqual(truncated.truncated, true);
assert(truncated.diagnostics.some(item => item.code === "truncated"));
console.log("link graph test: canonical forward/backlinks, pins, cycles, scope privacy, filters, and budgets OK");
