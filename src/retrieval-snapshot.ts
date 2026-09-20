import { createHash } from "crypto";
import type { CachedSubscriptionGroup, SharedContentType } from "./subscriptions";

export type RetrievalContentType = "skill" | "note" | "script" | "subscription";

export interface RetrievalDocument {
  skill_id: string;
  title: string;
  description: string;
  body: string;
  content_type: RetrievalContentType;
  source_uri: string;
  metadata: Record<string, string>;
  provenance: Record<string, unknown>;
  read_only: boolean;
}

export interface RetrievalSnapshot {
  corpus_revision: string;
  documents: RetrievalDocument[];
}

export interface RetrievalSnapshotSources {
  skills: any[];
  notes: any[];
  scripts: any[];
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

export function createRetrievalSnapshot(sources: RetrievalSnapshotSources): RetrievalSnapshot {
  const documents: RetrievalDocument[] = [];
  for (const skill of sources.skills) {
    const key = String(skill._key || skill.key || skill.name || "").replace(/\.md$/i, "");
    if (!key) continue;
    documents.push({
      skill_id: `skill:${key}`,
      title: String(skill.name || key.split("/").pop() || key),
      description: String(skill.description || ""),
      body: String(skill.content || ""),
      content_type: "skill",
      source_uri: `pkm://skills/${uriPath(key)}`,
      metadata: { category: String(skill.category || ""), tags: tags(skill.tags), source_project: String(skill.source_project || "") },
      provenance: { provider: "pkm", collection: "skills" },
      read_only: false,
    });
  }
  for (const note of sources.notes) {
    const key = String(note.slug || "").replace(/\.md$/i, "");
    if (!key) continue;
    documents.push({
      skill_id: `note:${key}`,
      title: String(note.title || key.split("/").pop() || key),
      description: String(note.description || note.type || ""),
      body: String(note.content || ""),
      content_type: "note",
      source_uri: `pkm://notes/${uriPath(key)}`,
      metadata: { category: String(note.category || ""), tags: tags(note.tags), type: String(note.type || ""), created: String(note.created_at || "") },
      provenance: { provider: "pkm", collection: "notes" },
      read_only: false,
    });
  }
  for (const script of sources.scripts) {
    const key = String(script.path || "");
    if (!key) continue;
    documents.push({
      skill_id: `script:${key}`,
      title: String(script.file || key.split("/").pop() || key),
      description: `Script in ${String(script.category || "")}`,
      body: String(script.content || ""),
      content_type: "script",
      source_uri: `pkm://scripts/${uriPath(key)}`,
      metadata: { category: String(script.category || ""), extension: String(script.extension || ""), language: String(script.lang || "") },
      provenance: { provider: "pkm", collection: "scripts" },
      read_only: false,
    });
  }
  for (const group of sources.subscriptionGroups) {
    for (const item of group.items) {
      let detail: ReturnType<RetrievalSnapshotSources["readSubscription"]>;
      try { detail = sources.readSubscription(item.key); } catch { continue; }
      documents.push({
        skill_id: item.pkmPath,
        title: item.title,
        description: `Subscribed ${detail.contentType} from ${group.alias}`,
        body: String(detail.content || ""),
        content_type: "subscription",
        source_uri: item.pkmPath,
        metadata: { category: item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "", upstream_type: detail.contentType },
        provenance: {
          provider: "broker", subscription_id: group.subscriptionId, broker: group.alias,
          publisher: group.publisher, node_id: group.nodeId, share_id: group.shareId,
          revision: group.revision, synced_at: group.syncedAt, upstream_uri: item.pkmPath,
          ...(detail.provenance || {}),
        },
        read_only: true,
      });
    }
  }
  documents.sort((left, right) => left.skill_id.localeCompare(right.skill_id));
  const tuples = documents.map(document => [document.skill_id, documentHash(document), document.content_type,
    document.provenance.revision || "", document.read_only]);
  const corpus_revision = createHash("sha256").update(JSON.stringify(tuples)).digest("hex");
  return { corpus_revision, documents };
}
