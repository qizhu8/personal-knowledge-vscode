import * as path from "path";
import { getStorePath, noteList, noteGet, skillList, skillGet } from "../knowledge/filestore";
import { RecipeFilesystemStore } from "../workflows/recipe-filesystem-store";
import { memoryTerms, memoryMatchScore } from "./chat-memory";

export function automaticChatSkills(query: string) {
  const terms = memoryTerms(query);
  return skillList().map(item => ({ item, score: memoryMatchScore(JSON.stringify(item), terms) }))
    .filter(candidate => candidate.score > 0)
    .sort((first, second) => second.score - first.score)
    .slice(0, 3).flatMap(({ item }) => {
      const record = skillGet(item.name);
      return record?.content ? [{ id: String(item.name), label: String(item.name), content: record.content.slice(0, 4000) }] : [];
    });
}

export function readChatKnowledge(name: string, kind: string, value: string): string {
  if (!["pkm_search", "pkm_read"].includes(name) || !["note", "skill", "recipe"].includes(kind) || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Provide a bounded local knowledge query or identity.");
  const recipes = kind === "recipe" ? new RecipeFilesystemStore(path.join(getStorePath(), ".pkm", "state")).list().recipes : [];
  const items = kind === "recipe" ? recipes.map(item => ({ id: item.recipeId, title: item.name, category: item.category || "" }))
    : (kind === "note" ? noteList(undefined, 1000) : skillList()).map(item => ({ id: String(kind === "note" ? item.slug : item.name), title: String(kind === "note" ? item.title : item.name), category: String(item.category || "") }));
  if (name === "pkm_search") {
    const matches = items.filter(item => `${item.id} ${item.title} ${item.category}`.toLowerCase().includes(value.toLowerCase()));
    return JSON.stringify({ items: matches.slice(0, 12).map(item => ({ id: item.id.slice(0, 512), title: item.title.slice(0, 256), category: item.category.slice(0, 128) })), truncated: matches.length > 12 });
  }
  if (!items.some(item => item.id === value)) throw new Error("Choose an existing local knowledge identity returned by pkm_search.");
  if (kind === "recipe") {
    const recipe = recipes.find(item => item.recipeId === value)!;
    const result = JSON.stringify({ id: value, revision: recipe.revision, executableDigest: recipe.executableDigest, definition: recipe.definition, metadata: recipe.metadata, truncated: false });
    if (result.length > 16_000) throw new Error("Recipe definition exceeds the tool result limit; it was not truncated or executed.");
    return result;
  }
  const record = kind === "note" ? noteGet(value) : skillGet(value);
  if (!record || typeof record.content !== "string") throw new Error("The selected knowledge is unavailable.");
  const result = { id: value, content: record.content.slice(0, 4000), truncated: record.content.length > 4000 };
  while (JSON.stringify(result).length > 16_000) { result.content = result.content.slice(0, Math.floor(result.content.length * 0.8)); result.truncated = true; }
  return JSON.stringify(result);
}