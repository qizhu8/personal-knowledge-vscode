import type { NoteRecord } from "../note-contracts.js";
import type { PaperRecord } from "../research-contracts.js";
import type { SkillRecord } from "../skill-contracts.js";

export interface LiteralSearchOptions {
  query: string;
  caseSensitive: boolean;
}

export function literalSearchMatches(options: LiteralSearchOptions, values: unknown[]): boolean {
  const source = options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(source, options.caseSensitive ? "" : "i");
  return values.some(value => pattern.test(String(value || "")));
}

export function noteSearchValues(note: NoteRecord, relativePath: string): unknown[] {
  return [
    note.title, note.description, note.content, note.slug, note.category, note.type,
    relativePath, `notes/${relativePath}`, ...JSON.parse(note.tags || "[]"),
  ];
}

export function skillSearchValues(skill: SkillRecord): unknown[] {
  return [
    skill.name, skill._key, skill.description, skill.content, skill.category, skill.source_project,
    ...JSON.parse(skill.tags || "[]"),
  ];
}

export function paperSearchValues(paper: PaperRecord): unknown[] {
  return [
    paper.slug, paper.title, paper.description, paper.content, paper.topic, paper.publisher, paper.category, paper.group,
    paper.url, paper.file, paper.year, ...paper.authors, ...paper.tags, ...paper.conclusions, ...paper.implementation,
    ...paper.assumptions, ...paper.cites.flatMap(cite => [cite.paper, cite.note]),
  ];
}
