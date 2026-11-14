import type { SkillRecord } from "../skill-contracts.js";
import { skillRoutingCasefold as casefold, skillRoutingIsDigit } from "./skill-routing-casefold.js";
import { sha256 } from "../file-write.js";

const stopWords = new Set("a an and are as at be by debug debugging for from how in into is it local member members name no not of on or problem substantial that the this to use using with workspace file files src code coding task issue".split(" "));
const words = (value: string) => casefold(value).replace(/[^\p{L}\p{N}_]+/gu, " ").trim();
export function skillContextTerms(value: string): Set<string> {
  return new Set((casefold(value.replace(/([a-z0-9])([A-Z])/g, "$1 $2")).match(/[\p{L}\p{N}_]{2,}/gu) || [])
    .filter(term => !stopWords.has(term) && !skillRoutingIsDigit(term)));
}
export const routingSkillId = (row: SkillRecord) => `${row.category ? `${row.category}/` : ""}${row.name}`.replace(/^\/+|\/+$/g, "");
const intersection = (left: Set<string>, right: Set<string>) => new Set([...left].filter(term => right.has(term)));
const compare = (a: string, b: string) => {
  const left = [...a], right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
};

export function skillContextHash(row: SkillRecord) {
  return sha256(JSON.stringify({
    category: row.category, content: row.content, description: row.description, name: row.name,
    recipe_hint: row.recipe_hint, recipe_required: row.recipe_required, related_skills: row.related_skills,
    tags: JSON.parse(row.tags) as string[],
  }));
}

export function skillLinkage(row: SkillRecord) {
  const hint = (row.recipe_hint || row.description || row.name || "").trim();
  return {
    recipe_required: row.recipe_required, recipe_hint: row.recipe_required ? hint : row.recipe_hint,
    related_skills: row.related_skills, related_recipes: [],
    ...(row.recipe_required ? { next_action: {
      kind: "search_or_create_recipe", search_query: hint, search_tool: "recipe_search",
      create_tool: "recipe_create_from_skill",
      instruction: "Search for a qualified Recipe. If none matches, proactively design and create a reusable Library Recipe from this Skill before continuing.",
    } } : {}),
  };
}

/** The original MCP metadata-threshold path with an unavailable retrieval boundary.
 * No candidate is synthesized for Agent Native, subscriptions or external Recipes. */
export function rankSkillContext(rows: SkillRecord[], task: string, workspace: string, files: string[], diagnostics: string, sourcePriority: string[]) {
  const taskTerms = skillContextTerms(task), contextTerms = skillContextTerms([workspace, ...files, diagnostics].join(" "));
  const normalizedContext = words([task, workspace, ...files, diagnostics].join(" "));
  const metadataDocuments = rows.map(row => skillContextTerms([row.name, row.description, row.category,
    ...(JSON.parse(row.tags) as string[]), row.source_project || ""].join(" ")));
  const rareLimit = Math.max(1, Math.trunc(rows.length * 0.05));
  const rareTerms = new Set([...taskTerms].filter(term => metadataDocuments.filter(document => document.has(term)).length <= rareLimit));
  const sourceRank = sourcePriority.indexOf("pkm-personal") < 0 ? sourcePriority.length : sourcePriority.indexOf("pkm-personal");
  const ranked = rows.flatMap(row => {
    const fields = {
      name: skillContextTerms(row.name), description: skillContextTerms(row.description),
      tag: skillContextTerms((JSON.parse(row.tags) as string[]).join(" ")), category: skillContextTerms(row.category),
      source_project: skillContextTerms(row.source_project || ""), content: skillContextTerms(row.content),
    };
    const weights = { name: 12, description: 8, tag: 8, category: 6, source_project: 10 } as const;
    let score = 0;
    const matched: string[] = [], metadataHits = new Set<string>(), contextMetadata = new Set<string>();
    for (const field of Object.keys(weights) as (keyof typeof weights)[]) {
      const hits = intersection(taskTerms, fields[field]);
      score += weights[field] * hits.size;
      for (const term of hits) metadataHits.add(term);
      matched.push(...[...hits].sort(compare).map(term => `${field}:${term}`));
      for (const term of intersection(contextTerms, fields[field])) contextMetadata.add(term);
    }
    const contentHits = intersection(taskTerms, fields.content);
    const coverage = metadataHits.size / Math.max(1, Math.min(taskTerms.size, 8));
    score += Math.min(contentHits.size, 4) + Math.min(contextMetadata.size * 2, 8);
    matched.push(...[...contentHits].sort(compare).slice(0, 3).map(term => `content:${term}`),
      ...[...contextMetadata].sort(compare).slice(0, 2).map(term => `context:${term}`));
    const enoughMetadata = metadataHits.size >= (taskTerms.size <= 2 ? 1 : 2);
    const enoughCoverage = coverage >= (taskTerms.size <= 2 ? 0.5 : 0.34);
    const anchorMatched = !rareTerms.size || intersection(metadataHits, rareTerms).size > 0;
    const priority = row.priority === "high" || row.priority === "highest" ? row.priority : "normal";
    const exact = [row.name, routingSkillId(row)].some(identifier => words(identifier).length >= 4 && normalizedContext.includes(words(identifier)));
    const priorityAdmission = priority !== "normal" && metadataHits.size >= 2 && coverage >= 0.12 && anchorMatched;
    if (!exact && !(enoughMetadata && enoughCoverage && anchorMatched) && !priorityAdmission) return [];
    score += { normal: 0, high: 30, highest: 60 }[priority];
    if (exact) { score += 80; matched.unshift("exact-identifier"); }
    if (priority !== "normal") matched.unshift(`priority:${priority}`);
    matched.unshift(`source-priority:${sourceRank + 1}`);
    return [{ row, score, coverage, metadataCount: metadataHits.size, sourceRank,
      protected: exact || priority === "highest", reasons: matched.slice(0, 8) }];
  });
  ranked.sort((a, b) => Number(b.protected) - Number(a.protected) || a.sourceRank - b.sourceRank
    || b.score - a.score || b.coverage - a.coverage || b.metadataCount - a.metadataCount
    || compare(casefold(routingSkillId(a.row)), casefold(routingSkillId(b.row))));
  return ranked;
}
