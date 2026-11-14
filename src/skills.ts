import { CoreError, type StorageRequest } from "./contracts.js";
import { createSkillQueries, projectSkill } from "./domain/skills.js";
import { sha256 } from "./file-write.js";
import { knowledgeSnapshot } from "./knowledge-snapshot.js";
import type { MarkdownRecord } from "./markdown.js";
import { skillRecord } from "./skill-contracts.js";

export function readSkills(root: string, documents: MarkdownRecord[], request: StorageRequest) {
  const records = knowledgeSnapshot(root, documents, "skills", "Skill").map(source => {
    const parsed = skillRecord.safeParse(projectSkill(source));
    if (!parsed.success) throw new CoreError("INVALID_DOCUMENT", `Skill metadata violates the original read-model types: skills/${source.rel}. Use knowledge.metadata.get to inspect it.`);
    return {
      ...parsed.data, documentId: source.document.record.id, path: source.rel, documentSha256: source.document.record.sha256,
    };
  });
  const snapshotRevision = sha256(JSON.stringify(records));
  if (request.args.snapshotRevision !== undefined && request.args.snapshotRevision !== snapshotRevision) {
    throw new CoreError("CONFLICT", "Skill snapshot changed; restart related queries/pagination.");
  }
  if (request.operation === "knowledge.skill.get") {
    const found = records.filter(record => request.args.name !== undefined ? record.name === request.args.name
      : record.documentId === request.args.id || record.knowledgeId === request.args.id);
    if (!found.length) throw new CoreError("NOT_FOUND", "Skill not found in this isolated workspace.");
    if (found.length > 1) throw new CoreError("CONFLICT", "Skill name is ambiguous; use knowledge.skill.list and read its stable documentId.");
    return { item: found[0]!, snapshotRevision };
  }
  if (request.operation !== "knowledge.skill.list") throw new CoreError("NOT_FOUND", "Unknown Skill query.");
  const queries = createSkillQueries(records);
  const all = queries.skillList(request.args.category === undefined ? undefined : String(request.args.category),
    request.args.tag === undefined ? undefined : String(request.args.tag));
  const offset = Number(request.args.offset), limit = Number(request.args.limit);
  const items = all.slice(offset, offset + limit);
  const next = offset + items.length;
  return { items, total: all.length, nextOffset: next < all.length ? next : null, snapshotRevision };
}
