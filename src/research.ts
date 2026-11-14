import { CoreError, type StorageRequest } from "./contracts.js";
import { createPaperQueries, projectPaper } from "./domain/research.js";
import { sha256 } from "./file-write.js";
import type { MarkdownRecord } from "./markdown.js";
import { paperRecord, researchGraph } from "./research-contracts.js";
import { knowledgeSnapshot } from "./knowledge-snapshot.js";

export function readResearch(root: string, documents: MarkdownRecord[], request: StorageRequest) {
  const papers = knowledgeSnapshot(root, documents, "papers", "Research").map(source => {
    const parsed = paperRecord.safeParse(projectPaper(source));
    if (!parsed.success) throw new CoreError("INVALID_DOCUMENT", `Research metadata violates the original read-model types: papers/${source.rel}. Use knowledge.metadata.get to inspect it.`);
    return parsed.data;
  });
  const revision = sha256(JSON.stringify(papers));
  if (request.args.revision !== undefined && request.args.revision !== revision) {
    throw new CoreError("CONFLICT", "Research snapshot changed; restart related queries/pagination.");
  }
  const queries = createPaperQueries(papers);
  let result: unknown;
  switch (request.operation) {
    case "knowledge.research.list": {
      const all = queries.paperList(), offset = Number(request.args.offset);
      const items = all.slice(offset, offset + Number(request.args.limit)), next = offset + items.length;
      result = { revision, items, total: all.length, nextOffset: next < all.length ? next : null };
      break;
    }
    case "knowledge.research.facets": result = { revision, ...queries.paperFacets() }; break;
    case "knowledge.research.groups": result = { revision, items: queries.paperGroups() }; break;
    case "knowledge.research.graph": {
      const graph: unknown = queries.paperGraph(request.args);
      const parsed = researchGraph.safeParse(graph);
      if (!parsed.success) {
        if (parsed.error.issues.some(issue => issue.code === "too_big")) {
          throw new CoreError("BUSY", "Research graph exceeds 1024 nodes/16384 edges; reduce the seed limit or disable neighbors. No partial graph was returned.");
        }
        throw new CoreError("INVALID_RESULT", "Original research graph produced an invalid read model; inspect the source metadata.");
      }
      return { revision, ...parsed.data };
    }
    default: throw new CoreError("NOT_FOUND", "Unknown research query.");
  }
  return result;
}
