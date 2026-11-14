import * as path from "path";
import { createHash } from "crypto";
import { getStorePath, noteList, noteGet, skillList, skillGet, paperList, paperGet } from "../knowledge/filestore";
import { scriptList, scriptGet } from "../knowledge/storage";
import { RecipeFilesystemStore } from "../workflows/recipe-filesystem-store";
import { researchRetrievalBody, type RetrievalSnapshot } from "../retrieval/retrieval-snapshot";
import { memoryTerms, memoryMatchScore } from "./chat-memory";

export function automaticChatSkills(query: string) {
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

export const CHAT_KNOWLEDGE_KINDS = ["note", "skill", "research", "script", "recipe", "subscription"] as const;

export function explicitlyMentionedKnowledgeTitle(query: string, title: string): boolean {
  const normalize = (value:string) => value.normalize("NFKC").toLowerCase().trim().replace(/[\s_-]+/g, " ");
  const name = normalize(title), text = normalize(query);
  return name.length >= 6 && text.includes(name);
}

export const CHAT_ASSET_CURATION_GUIDANCE = [
  "Knowledge stewardship for substantive Tasks: search existing knowledge before proposing a new reusable asset; read candidate sources and reuse or update rather than duplicate.",
  "Distinguish evidence Notes and Papers, reusable procedural Skills, executable Scripts and typed Components, contract-validated Actions, and multi-step orchestration Recipes. This is a choice of abstraction and reuse, not a compulsory promotion ladder.",
  "After verified work, proactively identify a genuinely reusable lesson or correction when useful. Propose its asset kind, scope/tags, source URLs or receipt IDs, validation evidence and nearest existing asset. Explain what is new and what remains uncertain.",
  "Do not persist every exchange. Do not claim an asset was saved without a successful advertised write tool. Propose when no suitable tool is enabled; respect existing authorization before durable writes.",
  "Contradictions require source comparison and explicit correction provenance, not silent replacement. Do not bulk move, rename, merge, delete, reclassify, or promote assets, and do not run extra model calls, without user authorization.",
].join("\n");

interface SourceReadOptions { start?: unknown; end?: unknown; sourceRevision?: unknown; contentHash?: unknown; }
interface SourceReadHandle {
  id: string; kind: string; sourceId: string; sourceRevision: string; contentHash: string;
  totalCharacters: number; offsetEncoding: string; readOnly?: boolean; executableDigest?: string;
}

export function readChatKnowledge(name: string, kind: string, value: string,
  options: SourceReadOptions = {},
  readSnapshot?: () => RetrievalSnapshot): string {
  const identityLimit = name === "pkm_search" ? 512 : 2048;
  if (!["pkm_search", "pkm_read"].includes(name) || !CHAT_KNOWLEDGE_KINDS.some(item => item === kind) || !value.trim() || value.length > identityLimit || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Provide a bounded knowledge query or identity.");
  if (kind === "subscription" && !readSnapshot) throw new Error("Cached subscription source reading is unavailable in this Chat host.");
  const subscribed = kind === "subscription" ? readSnapshot!().documents.filter(document =>
    document.content_type === "subscription" && document.visibility === "available") : [];
  const recipes = kind === "recipe" ? new RecipeFilesystemStore(path.join(getStorePath(), ".pkm", "state")).list().recipes : [];
  const items = kind === "recipe" ? recipes.map(item => ({ id: item.recipeId, title: item.name, category: item.category || "", sourceId:`pkm://knowledge/${item.knowledgeId}` }))
    : kind === "subscription" ? subscribed.map(item => ({ id:item.source_id, title:item.title, category:item.metadata.category || "", sourceId:item.source_id }))
    : kind === "script" ? scriptList().map(item => ({ id:item.path, title:item.file, category:item.category, sourceId:"" }))
    : (kind === "note" ? noteList(undefined, Number.MAX_SAFE_INTEGER) : kind === "research" ? paperList() : skillList())
      .map(item => {
        const id = String(kind === "skill" ? item.name : item.slug);
        return { id, title:String(kind === "skill" ? item.name : item.title), category:String(item.category || ""),
          sourceId:item.knowledgeId ? `pkm://knowledge/${item.knowledgeId}`
            : `pkm://${kind === "skill" ? "skills" : kind === "research" ? "research" : "notes"}/${id.split("/").map(encodeURIComponent).join("/")}` };
      });
  if (name === "pkm_search") {
    const terms = memoryTerms(value);
    const matches = items.map(item => {
      const fields = `${item.id} ${item.title} ${item.category}`.toLowerCase();
      const score = (fields.includes(value.toLowerCase()) ? 10_000 : 0)
        + (explicitlyMentionedKnowledgeTitle(value, item.title) ? 1000 : 0) + memoryMatchScore(fields, terms);
      return { item, score };
    }).filter(match => match.score > 0).sort((a, b) => b.score - a.score).map(match => match.item);
    const selected = matches.slice(0, 12);
    if (selected.some(item => item.id.length > 2048)) throw new Error("A matching knowledge identity exceeds the 2,048-character tool limit; it was not silently shortened.");
    const result = { items:selected.map(item => ({ id: item.id, title: item.title.slice(0, 256), category: item.category.slice(0, 128) })), truncated:matches.length > 12 };
    while (JSON.stringify(result).length > 16_000 && result.items.length) { result.items.pop(); result.truncated = true; }
    return JSON.stringify(result);
  }
  const canonical = items.filter(item => item.sourceId === value
    || /^knowledge_[A-Za-z0-9._-]+$/.test(value) && item.sourceId === `pkm://knowledge/${value}`);
  if (canonical.length > 1) throw new Error("Canonical knowledge identity is ambiguous; use an exact local identity returned by pkm_search.");
  const resolvedScript = kind === "script" && value.startsWith("pkm://") ? scriptGet(value) : undefined;
  value = resolvedScript?.path || canonical[0]?.id || value;
  if (!items.some(item => item.id === value)) throw new Error("Choose an existing local knowledge identity returned by pkm_search.");
  if (kind === "recipe") {
    const recipe = recipes.find(item => item.recipeId === value)!;
    const document = { id:value, revision:recipe.revision, executableDigest:recipe.executableDigest,
      definition:recipe.definition, metadata:recipe.metadata };
    const complete = JSON.stringify({ ...document, truncated:false });
    if (complete.length <= 16_000 && Object.values(options).every(value => value === undefined)) return complete;
    const content = JSON.stringify(document);
    return readSourceRange(content, { id:value, kind, sourceId:`pkm://knowledge/${recipe.knowledgeId}`,
      sourceRevision:String(recipe.revision), contentHash:createHash("sha256").update(content).digest("hex"),
      totalCharacters:content.length, offsetEncoding:"utf16", readOnly:true, executableDigest:recipe.executableDigest }, options);
  }
  const record = kind === "note" ? noteGet(value) : kind === "research" ? paperGet(value)
    : kind === "script" ? resolvedScript || scriptGet(value) : kind === "subscription" ? (() => {
      const document = subscribed.find(item => item.source_id === value)!;
      return { content:document.body, revision:document.source_revision, sourceId:document.source_id,
        provenance:document.provenance, readOnly:true };
    })() : skillGet(value);
  if (!record || typeof record.content !== "string") throw new Error("The selected knowledge is unavailable.");
  const content = kind === "research" ? researchRetrievalBody(record) : record.content;
  const contentHash = createHash("sha256").update(content).digest("hex");
  const sourceRevision = String(record.revision ?? (kind === "script" ? `sha256:${contentHash}` : contentHash));
  const sourceId = kind === "subscription" ? record.sourceId : kind === "script" ? `pkm://script/${record.knowledgeId}`
    : record.knowledgeId ? `pkm://knowledge/${record.knowledgeId}`
    : `pkm://${kind === "skill" ? "skills" : kind === "research" ? "research" : "notes"}/${value.split("/").map(encodeURIComponent).join("/")}`;
  const handle = { id:value, kind, sourceId, sourceRevision, contentHash, totalCharacters:content.length,
    offsetEncoding:"utf16", ...(kind === "subscription" ? { readOnly:true } : {}) };
  return readSourceRange(content, handle, options);
}

function readSourceRange(content: string, handle: SourceReadHandle, options: SourceReadOptions): string {
  if (options.sourceRevision !== undefined && (typeof options.sourceRevision !== "string" || options.sourceRevision !== handle.sourceRevision)) throw new Error("Source revision changed; fetch the current source handle before reading ranges.");
  if (options.contentHash !== undefined && (typeof options.contentHash !== "string" || options.contentHash !== handle.contentHash)) throw new Error("Source content hash changed; stale ranges were not returned.");
  const ranged = options.start !== undefined || options.end !== undefined;
  if (ranged) {
    if (!Number.isSafeInteger(options.start) || !Number.isSafeInteger(options.end) || Number(options.start) < 0
      || Number(options.end) <= Number(options.start) || Number(options.end) > content.length
      || Number(options.end) - Number(options.start) > 4000 || options.sourceRevision === undefined || options.contentHash === undefined) {
      throw new Error("Source ranges require revision and contentHash plus a valid half-open UTF-16 range of at most 4,000 characters.");
    }
    const start = Number(options.start), end = Number(options.end);
    for (const offset of [start, end]) if (offset > 0 && offset < content.length &&
      /[\uD800-\uDBFF]/.test(content[offset - 1]) && /[\uDC00-\uDFFF]/.test(content[offset])) throw new Error("A source range must not split a Unicode surrogate pair.");
    const result = JSON.stringify({ ...handle,
      range:{ start, end, unit:"characters" }, content:content.slice(start, end),
      truncated:false, nextStart:end < content.length ? end : null });
    if (result.length > 16_000) throw new Error("The exact range exceeds the tool transport limit; request a smaller range. It was not truncated.");
    return result;
  }
  let end = Math.min(content.length, 4000);
  while (true) {
    if (end > 0 && /[\uD800-\uDBFF]/.test(content[end - 1]) && /[\uDC00-\uDFFF]/.test(content[end] || "")) end--;
    const result = JSON.stringify({ ...handle, content:content.slice(0, end), truncated:end < content.length,
      range:{ start:0, end, unit:"characters" }, nextStart:end < content.length ? end : null });
    if (result.length <= 16_000) return result;
    if (!end) throw new Error("Source handle exceeds the tool transport limit; no partial handle was returned.");
    end = Math.floor(end * 0.8);
  }
}