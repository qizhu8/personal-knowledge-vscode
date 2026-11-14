import type { RecipeKnowledgeBinding } from "../project-recipes-contracts.js";
type RecipeNodeBindings = { nodeId: string; bindings: RecipeKnowledgeBinding[] };
class ProjectModelError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function normalizeRecipeNodeBindings(value: RecipeNodeBindings[], nodeIds: Set<string>): RecipeNodeBindings[] {
  const seenNodes = new Set<string>();
  return value.filter(node => nodeIds.has(node.nodeId)).map(node => {
    if (seenNodes.has(node.nodeId)) throw new ProjectModelError("recipe-binding-node-duplicate", `Recipe bindings repeat Step ${node.nodeId}.`);
    seenNodes.add(node.nodeId);
    const seenBindings = new Set<string>();
    const bindings = node.bindings.map(binding => {
      if (!binding.bindingId || !["skill", "note"].includes(binding.kind) || !binding.knowledgeId
        || !/^[a-f0-9]{64}$/.test(binding.contentHash) || !["required", "recommended", "reference"].includes(binding.usage)) {
        throw new ProjectModelError("recipe-binding-invalid", `Recipe binding on Step ${node.nodeId} is invalid.`);
      }
      const identity = `${binding.kind}:${binding.knowledgeId}`;
      if (seenBindings.has(identity)) throw new ProjectModelError("recipe-binding-duplicate", `Recipe binding ${identity} is duplicated on Step ${node.nodeId}.`);
      seenBindings.add(identity);
      return { ...binding };
    });
    return { nodeId: node.nodeId, bindings };
  }).filter(node => node.bindings.length);
}
