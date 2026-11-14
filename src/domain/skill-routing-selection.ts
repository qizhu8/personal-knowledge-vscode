import { createHash } from "node:crypto";
import { memoryTerms, memoryMatchScore } from "./skill-routing-terms.js";
import type { SkillRecord } from "../skill-contracts.js";

export function createAutomaticSkillSelection(records: SkillRecord[], list: () => Omit<SkillRecord, "content" | "_key">[]) {
  function skillList() { return list(); }
  function skillGet(name: string) { return records.find(record => record.name === name); }
function automaticChatSkills(query: string) {
  const terms = memoryTerms(query);
  return skillList().map(item => ({ item, score: memoryMatchScore(JSON.stringify(item), terms) }))
    .filter(candidate => candidate.score > 0)
    .sort((first, second) => second.score - first.score)
    .slice(0, 20).flatMap(({ item }) => {
      const record = skillGet(item.name);
      if (!record?.content) return [];
      const contentHash = createHash("sha256").update(record.content).digest("hex");
      return [{ id:String(item.name), label:String(item.name), sourceId:`pkm://skills/${encodeURIComponent(item.name)}`,
        sourceRevision:String(record.revision ?? contentHash), contentHash,
        ...(record.content.length <= 160_000 ? { content:record.content } : {}),
        reason:record.content.length <= 160_000 ? "Complete Skill source materialized" : "Skill requires source-range retrieval; no prefix was substituted" }];
    });
}
  return automaticChatSkills;
}

export function explicitlyMentionedKnowledgeTitle(query: string, title: string): boolean {
  const normalize = (value:string) => value.normalize("NFKC").toLowerCase().trim().replace(/[\s_-]+/g, " ");
  const name = normalize(title), text = normalize(query);
  return name.length >= 6 && text.includes(name);
}
