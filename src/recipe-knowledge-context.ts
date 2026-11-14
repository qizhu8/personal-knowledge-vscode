import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { CoreError } from "./contracts.js";
import { checkedDocumentPath } from "./document-path.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { normalizeRecipeNodeBindings } from "./domain/workflow-compiler-bindings.js";
import { decodeMarkdown, type MarkdownRecord } from "./markdown.js";
import { buildProjectRecipeKnowledge, type ProjectRecipeRecord } from "./project-recipes.js";
import type { WorkflowInvocation } from "./workflow-executor.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** A host-selected read scope, never a discovery mechanism or an executable grant. */
export function freshRecipeKnowledgeDocuments(root: string, documents: readonly MarkdownRecord[]): MarkdownRecord[] {
  if (!Array.isArray(documents) || documents.length > 128
    || documents.some(item => !item || typeof item.raw !== "string")
    || documents.reduce((sum, item) => sum + Buffer.byteLength(item.raw, "utf8"), 0) > 2_097_152)
    throw new CoreError("RESOURCE_LIMIT", "Recipe Knowledge read scope exceeds its document/byte budget.");
  for (const document of documents) {
    if (!document?.record || typeof document.raw !== "string"
      || !["notes", "skills"].includes(document.record.area) || document.record.deleted)
      throw new CoreError("INVALID_DOCUMENT", "Recipe Knowledge requires an explicit current Note/Skill read scope.");
    const file = checkedDocumentPath(root, document.record.path, false, document.record.area);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > 2_097_152n)
        throw new CoreError("INVALID_DOCUMENT", "Recipe Knowledge refuses links, special files and oversized documents.");
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      const bytes = buffer.subarray(0, length), after = fstatSync(fd, { bigint: true });
      const current = lstatSync(checkedDocumentPath(root, document.record.path, false, document.record.area), { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || current.dev !== after.dev || current.ino !== after.ino || current.nlink !== 1n
        || bytes.length !== Number(before.size)
        || hash(bytes.toString("utf8")) !== document.record.sha256
        || new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== document.raw)
        throw new CoreError("CONFLICT", "Recipe Knowledge bytes changed from the host-selected document snapshot.");
    } finally { closeSync(fd); }
  }
  return documents.map(document => decodeMarkdown(document.record.id, document.raw, document.record.path, document.record.area));
}

export function resolveRecipeKnowledgeContext(root: string, recipe: ProjectRecipeRecord, documents: readonly MarkdownRecord[]) {
  const definition = recipe.definition as { spec: { nodes: Array<{ nodeId: string }> } };
  const nodes = normalizeRecipeNodeBindings(recipe.nodeBindings ?? [], new Set(definition.spec.nodes.map(node => node.nodeId)));
  if (nodes.reduce((sum, node) => sum + node.bindings.length, 0) > 128)
    throw new CoreError("RESOURCE_LIMIT", "Recipe Knowledge binding count exceeds the host context budget.");
  const knowledge = buildProjectRecipeKnowledge(root, freshRecipeKnowledgeDocuments(root, documents), [recipe]);
  const data = { nodes, knowledge };
  if (Buffer.byteLength(canonicalJson(data), "utf8") > 524288)
    throw new CoreError("RESOURCE_LIMIT", "Recipe Knowledge context exceeds the host payload budget.");
  return { schema: "pkm.recipe.knowledge-context/v1" as const, ...data,
    digest: hash(canonicalJson(data)), executionAuthority: false as const };
}

export type RecipeKnowledgeContext = ReturnType<typeof resolveRecipeKnowledgeContext>;
export type RecipeKnowledgeInvocation = WorkflowInvocation & { recipeKnowledge?: RecipeKnowledgeContext };

export function recipeKnowledgeForNode(context: RecipeKnowledgeContext, nodeId: string): RecipeKnowledgeContext {
  const nodes = context.nodes.filter(node => node.nodeId === nodeId);
  const keys = new Set(nodes.flatMap(node => node.bindings.map(binding => `${binding.kind}\0${binding.knowledgeId}`)));
  const knowledge = context.knowledge.filter(item => keys.has(`${item.kind}\0${item.knowledgeId}`));
  const data = { nodes, knowledge };
  return { ...context, ...data, digest: hash(canonicalJson(data)) };
}
