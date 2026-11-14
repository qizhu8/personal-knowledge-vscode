import { readKnowledgeIdentity } from "./knowledge-contracts.js";
import type { SkillRecord } from "../skill-contracts.js";

export interface SkillSource { rel: string; mtime: number; fm: Record<string, unknown>; body: string }

function asArray(v: any): string[] {
  return Array.isArray(v) ? v : v ? [String(v)] : [];
}

function relNoExt(rel: string): string { return rel.replace(/\.md$/i, ""); }

function catOf(keyPath: string): string {
  return keyPath.includes("/") ? keyPath.slice(0, keyPath.lastIndexOf("/")) : "";
}

function nameOf(keyPath: string): string {
  return keyPath.includes("/") ? keyPath.slice(keyPath.lastIndexOf("/") + 1) : keyPath;
}

export type SkillPriority = "normal" | "high" | "highest";

function skillPriority(value: unknown): SkillPriority {
  return value === "high" || value === "highest" ? value : "normal";
}

export function projectSkill(f: SkillSource): unknown {
  const { fm, body } = f;
  const key = relNoExt(f.rel);
  return {
    name: fm.name || nameOf(key),
    _key: key,
    ...readKnowledgeIdentity(fm, "skill", key),
    description: fm.description ?? "",
    category: catOf(key),
    tags: JSON.stringify(asArray(fm.tags)),
    source_project: fm.source_project ?? null,
    recipe_required: fm.recipe_required === true,
    recipe_hint: String(fm.recipe_hint || ""),
    related_skills: asArray(fm.related_skills),
    links: Array.isArray(fm.links) ? fm.links : [],
    priority: skillPriority(fm.priority),
    pinned: fm.pinned === true,
    content: body,
    created_at: fm.created || new Date(f.mtime).toISOString(),
    updated_at: new Date(f.mtime).toISOString(),
  };
}

export function createSkillQueries<T extends SkillRecord>(skills: T[]) {
  function allSkillFiles() { return skills; }
  function skillFromFile(skill: T) { return skill; }

function skillList(category?: string, tag?: string): any[] {
  let rows = allSkillFiles().map(skillFromFile);
  if (category) rows = rows.filter(r => r.category === category);
  if (tag) rows = rows.filter(r => asArray(JSON.parse(r.tags || "[]")).includes(tag));
  rows.sort((a, b) => (a.category || "").localeCompare(b.category || "") || a.name.localeCompare(b.name));
  return rows.map(({ content, _key, ...meta }) => meta);
}

  return { skillList };
}
