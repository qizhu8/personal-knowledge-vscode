import { createHash } from "crypto";
import type { CachedSubscriptionGroup, SharedContentType } from "../subscriptions/subscriptions";
import { compileKnowledgeLinksV1, type KnowledgeLinkV1 } from "../knowledge/knowledge-contracts";
import type { RetrievalCandidateV1, RetrievalContentType } from "./retrieval-contracts";
import { refineRuleCandidates } from "./retrieval-passages";

export interface RetrievalDocument {
  skill_id: string;
  source_id: string;
  source_revision: string;
  knowledge_id?: string;
  title: string;
  description: string;
  body: string;
  content_type: RetrievalContentType;
  source_uri: string;
  metadata: Record<string, string>;
  provenance: Record<string, unknown>;
  read_only: boolean;
  visibility: "available" | "private" | "trashed" | "unavailable";
  links: KnowledgeLinkV1[];
}

export interface RetrievalSnapshot {
  corpus_revision: string;
  generation?: number;
  documents: RetrievalDocument[];
}

export function indexedRetrievalDocument(document: RetrievalDocument): RetrievalDocument {
  const hash = documentHash(document);
  return { ...document, source_id:document.source_id || document.source_uri || document.skill_id,
    source_revision:`${document.source_revision || "content"}:${hash}`,
    visibility:document.visibility || "available", links:document.links || [] };
}

function retrievalSourceContentType(document: RetrievalDocument): RetrievalContentType {
  if (document.content_type !== "subscription") return document.content_type;
  switch (document.metadata.upstream_type) {
    case "skills": return "skill";
    case "notes": return "note";
    case "papers": case "research": return "research";
    case "scripts": return "script";
    default: return "subscription";
  }
}

export function retrievalDocumentContentHash(document: RetrievalDocument): string {
  const orderedKeys = Object.keys(document.metadata).sort((first, second) => {
    const a = Array.from(first, value => value.codePointAt(0)!);
    const b = Array.from(second, value => value.codePointAt(0)!);
    for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index] - b[index];
    return a.length - b.length;
  });
  const metadata = `{${orderedKeys.map(key => `${JSON.stringify(key)}:${JSON.stringify(document.metadata[key])}`).join(",")}}`;
  // Match the pinned worker's SkillDocument canonical JSON, not its index-event hash.
  const sourceType = retrievalSourceContentType(document);
  const type = sourceType === "action" ? "note" : sourceType;
  const canonical = `{"body":${JSON.stringify(document.body)},"content_type":${JSON.stringify(type)},"description":${JSON.stringify(document.description)},"metadata":${metadata},"title":${JSON.stringify(document.title)}}`;
  return createHash("sha256").update(canonical).digest("hex");
}

export function retrievalDocumentForSource(snapshot: RetrievalSnapshot, sourceId: string, revision: string,
  contentHash?: string): RetrievalDocument | undefined {
  for (const document of snapshot.documents) {
    if ((document.source_id || document.source_uri || document.skill_id) !== sourceId) continue;
    const indexed = document.source_revision === revision ? document : indexedRetrievalDocument(document);
    if (indexed.source_revision === revision && indexed.visibility === "available"
      && (contentHash === undefined || retrievalDocumentContentHash(indexed) === contentHash)) {
      const content_type = retrievalSourceContentType(indexed);
      return content_type === indexed.content_type ? indexed : { ...indexed, content_type };
    }
  }
  return undefined;
}

export function materializeRetrievalCandidates(parents: RetrievalCandidateV1[], snapshot: RetrievalSnapshot,
  query: string): RetrievalCandidateV1[] {
  if (parents.length > 20) throw new Error("Source materialization accepts at most 20 ranked parents.");
  const candidates = [...parents];
  for (let index = 0; index < parents.length; index++) {
    const parent = parents[index];
    const document = parent.sourceId && parent.sourceRevision
      ? retrievalDocumentForSource(snapshot, parent.sourceId, parent.sourceRevision, parent.contentHash) : undefined;
    if (!document || !retrievalCandidateMatchesDocument(parent, document, parent.id)) {
      const { content, ...metadata } = parent;
      candidates[index] = { ...metadata, reason:"Source revision or content hash changed, is private, or is unavailable; no content was materialized." };
      continue;
    }
    if (!document.title || document.title.length > 512) {
      const { content, ...metadata } = parent;
      candidates[index] = { ...metadata, reason:"Current source title exceeds the provenance label boundary or is empty; no content was materialized." };
      continue;
    }
    candidates[index] = { ...parent, label:document.title, ...materializeRetrievalSource(document) };
    if (document.body.length <= 160_000) continue;
    const refined = refineRuleCandidates([{ ...candidates[index], content:document.body }], query);
    const [metadata, ...passages] = refined.candidates;
    if (candidates.length + passages.length > 100) {
      candidates[index].reason = "The 100-candidate materialization boundary was reached; this source's dependent passage group was not injected.";
      continue;
    }
    candidates[index] = { ...metadata, reason:[metadata.reason, ...refined.warnings].join(" ").slice(0, 1024) };
    candidates.push(...passages);
  }
  return candidates;
}

export function materializeRetrievalSource(document: RetrievalDocument | undefined): { content?: string; reason: string } {
  if (!document || document.visibility !== "available") return { reason:"Source revision changed or unavailable" };
  if (document.body.length > 160_000) return { reason:"Complete source exceeds the 160,000-character materialization boundary; source-range retrieval is required. No prefix was substituted." };
  return { content:document.body, reason:"Ranked knowledge candidate; complete source materialized" };
}

function retrievalCandidateMatchesDocument(candidate: RetrievalCandidateV1, document: RetrievalDocument, parentId: string): boolean {
  if (candidate.sourceId !== document.source_id || candidate.sourceUri !== document.source_uri
    || candidate.kind !== retrievalSourceContentType(document) || candidate.sourceRevision !== document.source_revision) return false;
  if (candidate.level !== "l2-passage") return candidate.id === parentId
    && candidate.contentHash === retrievalDocumentContentHash(document)
    && (candidate.content === undefined || candidate.content === document.body);
  const range = candidate.range;
  if (candidate.parentId !== parentId || candidate.parentRevision !== document.source_revision
    || candidate.parentContentHash !== retrievalDocumentContentHash(document)
    || !range || range.unit !== "characters" || candidate.offsetEncoding !== "utf16"
    || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 0 || range.end <= range.start || range.end > document.body.length) return false;
  const content = document.body.slice(range.start, range.end);
  return candidate.contentHash === createHash("sha256").update(content).digest("hex")
    && (candidate.content === undefined || candidate.content === content);
}

export function retrievalSourceValidation(readSnapshot: () => RetrievalSnapshot) {
  const admitted = new Map<string, { fingerprint:string; parentId:string }>(), currentHashes = new Map<string, string>();
  let snapshot: RetrievalSnapshot | undefined;
  const key = (candidate:RetrievalCandidateV1) => JSON.stringify([
    candidate.sourceId, candidate.parentRevision || candidate.sourceRevision, candidate.parentContentHash || candidate.contentHash,
  ]);
  return {
    admit(candidate:RetrievalCandidateV1, document:RetrievalDocument): void {
      if (document.visibility !== "available" || candidate.level === "l2-passage"
        || !retrievalCandidateMatchesDocument(candidate, document, candidate.id)) throw new Error("Cannot admit unavailable or mismatched retrieval evidence.");
      admitted.set(key(candidate), { fingerprint:documentHash(document), parentId:candidate.id });
      if (admitted.size > 1000) admitted.delete(admitted.keys().next().value!);
    },
    refreshSourceValidation(): void { snapshot = readSnapshot(); currentHashes.clear(); },
    sourceIsCurrent(candidate:RetrievalCandidateV1): boolean {
      const identity = key(candidate), expected = admitted.get(identity);
      const document = snapshot && retrievalDocumentForSource(snapshot, candidate.sourceId!,
        (candidate.parentRevision || candidate.sourceRevision)!);
      if (!expected || !document) return false;
      if (!currentHashes.has(identity)) currentHashes.set(identity, documentHash(document));
      return currentHashes.get(identity) === expected.fingerprint
        && retrievalCandidateMatchesDocument(candidate, document, expected.parentId);
    },
  };
}

export interface RetrievalSnapshotSources {
  skills: any[];
  notes: any[];
  papers?: any[];
  scripts: any[];
  recipes?: any[];
  subscriptionGroups: CachedSubscriptionGroup[];
  readSubscription(key: string): { contentType: SharedContentType; content: string; provenance: any };
}

function tags(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(" ");
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map(String).join(" ") : String(value || "");
  } catch {
    return String(value || "");
  }
}

function uriPath(value: string): string {
  return value.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function documentHash(document: RetrievalDocument): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

function sourceRevision(value: unknown, fallback: string): string {
  const revision = String(value ?? "").trim();
  return revision || fallback;
}

function sourceLinks(value: unknown, label: string): KnowledgeLinkV1[] {
  if (value === undefined) return [];
  const compiled = compileKnowledgeLinksV1(value);
  if (!compiled.ok) throw new Error(`Invalid Knowledge links for ${label}: ${compiled.diagnostics.map(item => `${item.pointer} ${item.message}`).join("; ")}`);
  return compiled.links;
}

function canonicalRecipeBody(recipe: any): string {
  return JSON.stringify({
    metadata: recipe.metadata || {},
    methodology: recipe.methodology || {},
    definition: recipe.definition || {},
    nodeBindings: recipe.nodeBindings || [],
  });
}

export function researchRetrievalBody(paper: {
  content?: string; conclusions?: string[]; implementation?: string[]; assumptions?: string[];
}): string {
  return [paper.content || "", ...paper.conclusions || [], ...paper.implementation || [],
    ...paper.assumptions || []].join("\n");
}

export function createRetrievalSnapshot(sources: RetrievalSnapshotSources): RetrievalSnapshot {
  const documents: RetrievalDocument[] = [];
  for (const skill of sources.skills) {
    const key = String(skill._key || skill.key || skill.name || "").replace(/\.md$/i, "");
    if (!key) continue;
    const knowledgeId = /^knowledge_[a-f0-9]{24}$/.test(String(skill.knowledgeId || "")) ? String(skill.knowledgeId) : "";
    const legacyUri = `pkm://skills/${uriPath(key)}`;
    const sourceId = knowledgeId ? `pkm://knowledge/${knowledgeId}` : legacyUri;
    documents.push({
      skill_id: `skill:${key}`,
      source_id: sourceId,
      source_revision: sourceRevision(skill.revision, createHash("sha256").update(String(skill.content || "")).digest("hex")),
      ...(knowledgeId ? { knowledge_id: knowledgeId } : {}),
      title: String(skill.name || key.split("/").pop() || key),
      description: String(skill.description || ""),
      body: String(skill.content || ""),
      content_type: "skill",
      source_uri: knowledgeId ? `pkm://knowledge/${knowledgeId}` : legacyUri,
      metadata: {
        category: String(skill.category || ""), tags: tags(skill.tags), source_project: String(skill.source_project || ""),
        recipe_required: skill.recipe_required === true ? "true" : "false", recipe_hint: String(skill.recipe_hint || ""),
        related_skills: tags(skill.related_skills),
        priority: skill.priority === "high" || skill.priority === "highest" ? skill.priority : "normal",
        legacy_uri: legacyUri,
        knowledge_revision: String(skill.revision || ""),
      },
      provenance: { provider: "pkm", collection: "skills" },
      read_only: false,
      visibility: skill.visibility || "available",
      links: sourceLinks(skill.links, `skill:${key}`),
    });
  }
  for (const note of sources.notes) {
    const key = String(note.slug || "").replace(/\.md$/i, "");
    if (!key) continue;
    const knowledgeId = /^knowledge_[a-f0-9]{24}$/.test(String(note.knowledgeId || "")) ? String(note.knowledgeId) : "";
    const legacyUri = `pkm://notes/${uriPath(key)}`;
    const sourceId = knowledgeId ? `pkm://knowledge/${knowledgeId}` : legacyUri;
    documents.push({
      skill_id: `note:${key}`,
      source_id: sourceId,
      source_revision: sourceRevision(note.revision, createHash("sha256").update(String(note.content || "")).digest("hex")),
      ...(knowledgeId ? { knowledge_id: knowledgeId } : {}),
      title: String(note.title || key.split("/").pop() || key),
      description: String(note.description || note.type || ""),
      body: String(note.content || ""),
      content_type: "note",
      source_uri: knowledgeId ? `pkm://knowledge/${knowledgeId}` : legacyUri,
      metadata: {
        category: String(note.category || ""), tags: tags(note.tags), type: String(note.type || ""),
        created: String(note.created_at || ""), legacy_uri: legacyUri, knowledge_revision: String(note.revision || ""),
      },
      provenance: { provider: "pkm", collection: "notes" },
      read_only: false,
      visibility: note.visibility || "available",
      links: sourceLinks(note.links, `note:${key}`),
    });
  }
  const papers = sources.papers || [];
  const paperUris = new Map<string, string>();
  for (const paper of papers) {
    const knowledgeId = /^knowledge_[a-f0-9]{24}$/.test(String(paper.knowledgeId || "")) ? String(paper.knowledgeId) : "";
    if (!knowledgeId) continue;
    const uri = `pkm://knowledge/${knowledgeId}`;
    paperUris.set(String(paper.slug || "").toLowerCase(), uri);
    paperUris.set(String(paper.title || "").toLowerCase(), uri);
  }
  for (const paper of papers) {
    const key = String(paper.slug || "").replace(/\.md$/i, "");
    const knowledgeId = /^knowledge_[a-f0-9]{24}$/.test(String(paper.knowledgeId || "")) ? String(paper.knowledgeId) : "";
    if (!key || !knowledgeId) continue;
    const sourceId = `pkm://knowledge/${knowledgeId}`;
    const citationLinks: KnowledgeLinkV1[] = (Array.isArray(paper.cites) ? paper.cites : []).flatMap((cite: any) => {
      const target = paperUris.get(String(cite?.paper || "").replace(/\.md$/i, "").toLowerCase());
      return target ? [{ relation: "cites", target, mode: "floating", required: false }] : [];
    });
    documents.push({
      skill_id: `research:${key}`,
      source_id: sourceId,
      source_revision: sourceRevision(paper.revision, createHash("sha256").update(String(paper.content || "")).digest("hex")),
      knowledge_id: knowledgeId,
      title: String(paper.title || key.split("/").pop() || key),
      description: String(paper.description || paper.topic || ""),
      body: researchRetrievalBody(paper),
      content_type: "research",
      source_uri: sourceId,
      metadata: {
        category: String(paper.category || ""),
        topic: String(paper.topic || ""),
        publisher: String(paper.publisher || ""),
        year: String(paper.year || ""),
        kind: String(paper.kind || "paper"),
        tags: tags(paper.tags),
        legacy_uri: `pkm://research/${uriPath(key)}`,
        knowledge_revision: String(paper.revision || ""),
      },
      provenance: { provider: "pkm", collection: "papers" },
      read_only: false,
      visibility: paper.visibility || "available",
      links: [...sourceLinks(paper.links, `research:${key}`), ...citationLinks],
    });
  }
  for (const script of sources.scripts) {
    const key = String(script.path || "");
    if (!key) continue;
    const legacyId = `script_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    const knowledgeId = /^script_[A-Za-z0-9._-]+$/.test(String(script.knowledgeId || "")) ? String(script.knowledgeId) : legacyId;
    const sourceId = `pkm://script/${knowledgeId}`;
    const contentHash = createHash("sha256").update(String(script.content || "")).digest("hex");
    documents.push({
      skill_id: sourceId,
      source_id: sourceId,
      source_revision: `sha256:${contentHash}`,
      knowledge_id: knowledgeId,
      title: String(script.file || key.split("/").pop() || key),
      description: `Script in ${String(script.category || "")}`,
      body: String(script.content || ""),
      content_type: "script",
      source_uri: sourceId,
      metadata: {
        category: String(script.category || ""), extension: String(script.extension || ""), language: String(script.lang || ""),
        canonical_uri: sourceId, legacy_uri: `pkm://scripts/${uriPath(key)}`, content_hash: `sha256:${contentHash}`,
      },
      provenance: { provider: "pkm", collection: "scripts" },
      read_only: false,
      visibility: script.visibility || "available",
      links: sourceLinks(script.links, `script:${key}`),
    });
  }
  for (const recipe of sources.recipes || []) {
    const recipeId = String(recipe.recipeId || "");
    const knowledgeId = /^knowledge_[a-f0-9]{24}$/.test(String(recipe.knowledgeId || "")) ? String(recipe.knowledgeId) : "";
    if (!recipeId || !knowledgeId) continue;
    documents.push({
      skill_id: `recipe:${recipeId}`,
      source_id: `pkm://knowledge/${knowledgeId}`,
      source_revision: sourceRevision(recipe.revision, recipe.executableDigest || createHash("sha256").update(canonicalRecipeBody(recipe)).digest("hex")),
      knowledge_id: knowledgeId,
      title: String(recipe.name || recipeId),
      description: String(recipe.description || ""),
      body: String(recipe.content || canonicalRecipeBody(recipe)),
      content_type: "recipe",
      source_uri: `pkm://knowledge/${knowledgeId}`,
      metadata: {
        category: String(recipe.category || ""),
        legacy_uri: `pkm://recipes/${encodeURIComponent(recipeId)}`,
        knowledge_revision: String(recipe.revision || ""),
        executable_digest: String(recipe.executableDigest || ""),
      },
      provenance: { provider: "pkm", collection: "recipes" },
      read_only: recipe.systemKind === "built-in",
      visibility: recipe.visibility || "available",
      links: sourceLinks(recipe.links, `recipe:${recipeId}`),
    });
  }
  for (const group of sources.subscriptionGroups) {
    for (const item of group.items) {
      let detail: ReturnType<RetrievalSnapshotSources["readSubscription"]>;
      try { detail = sources.readSubscription(item.key); } catch { continue; }
      documents.push({
        skill_id: item.pkmPath,
        source_id: item.pkmPath,
        source_revision: sourceRevision(detail.provenance?.revision || group.revision, String(group.revision)),
        title: item.title,
        description: `Subscribed ${detail.contentType} from ${group.alias}`,
        body: String(detail.content || ""),
        content_type: "subscription",
        source_uri: item.pkmPath,
        metadata: {
          category: item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "",
          upstream_type: detail.contentType,
          source_priority: group.priority,
        },
        provenance: {
          provider: "broker", subscription_id: group.subscriptionId, broker: group.alias,
          source_priority: group.priority,
          publisher: group.publisher, node_id: group.nodeId, share_id: group.shareId,
          revision: group.revision, synced_at: group.syncedAt, upstream_uri: item.pkmPath,
          ...(detail.provenance || {}),
        },
        read_only: true,
        visibility: "available",
        links: [],
      });
    }

  }
  documents.sort((left, right) => left.skill_id.localeCompare(right.skill_id));
  const tuples = documents.map(document => [document.skill_id, documentHash(document), document.content_type,
    document.provenance.revision || "", document.read_only]);
  const corpus_revision = createHash("sha256").update(JSON.stringify(tuples)).digest("hex");
  return { corpus_revision, documents };
}
