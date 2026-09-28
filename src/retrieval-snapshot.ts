import { createHash } from "crypto";
import type { CachedSubscriptionGroup, SharedContentType } from "./subscriptions";
import { compileKnowledgeLinksV1, type KnowledgeLinkV1 } from "./knowledge-contracts";
import type { RetrievalContentType } from "./retrieval-contracts";

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
      body: [
        String(paper.content || ""),
        ...(paper.conclusions || []),
        ...(paper.implementation || []),
        ...(paper.assumptions || []),
      ].join("\n"),
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
    const stableId = `script_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    documents.push({
      skill_id: `script:${key}`,
      source_id: `pkm://script/${stableId}`,
      source_revision: sourceRevision(script.revision || script.updatedAt, createHash("sha256").update(String(script.content || "")).digest("hex")),
      title: String(script.file || key.split("/").pop() || key),
      description: `Script in ${String(script.category || "")}`,
      body: String(script.content || ""),
      content_type: "script",
      source_uri: `pkm://scripts/${uriPath(key)}`,
      metadata: {
        category: String(script.category || ""), extension: String(script.extension || ""), language: String(script.lang || ""),
        canonical_uri: `pkm://script/${stableId}`,
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
