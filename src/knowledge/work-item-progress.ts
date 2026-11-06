import { getStorePath, noteGet, noteWorkItemNotes, noteWorkItemsRead } from "./filestore";
import { withMarkdownAssetMutation } from "./markdown-assets";
import { NoteWorkItem } from "./note-work-items";
import { resolvePkmLocator } from "./knowledge-locator";

export interface WorkItemReference {
  slug: string;
  id: string;
  digest: string;
  knowledgeId?: string;
}

export interface WorkItemProgressRecord {
  slug: string;
  digest: string;
  knowledgeId?: string;
  item: NoteWorkItem;
}

function discover() {
  const found = noteWorkItemNotes("", 1000);
  if (found.truncated) throw new Error("Too many Work Item Notes for a complete Project view. Narrow the knowledge collection.");
  if (found.notes.some(note => note.error)) throw new Error("A Work Item Note could not be read. Repair it before loading a complete Project view.");
  return found.notes;
}

function knowledgeIdentity(slug: string): string | undefined {
  const identity = noteGet(slug)?.knowledgeId;
  return typeof identity === "string" ? identity : undefined;
}

function record(slug: string, digest: string, item: NoteWorkItem, knowledgeId: string | undefined): WorkItemProgressRecord {
  return { slug, digest, knowledgeId, item };
}

/** Source snapshots, never a second task store or an inference about live execution. */
export function projectWorkItemProgress(projectId: string, readAt?: string) {
  return withMarkdownAssetMutation(getStorePath(), () => {
    const records: WorkItemProgressRecord[] = [];
    for (const note of discover()) {
      const snapshot = noteWorkItemsRead(note.slug);
      const live = snapshot.items.filter(item => !item.deletedAt);
      const assigned = live.filter(item => item.projectId === projectId);
      const parents = new Set(assigned.map(item => item.parentId).filter(Boolean));
      const knowledgeId = knowledgeIdentity(note.slug);
      for (const item of live.filter(item => assigned.includes(item) || parents.has(item.id))) {
        records.push(record(note.slug, snapshot.digest, item, knowledgeId));
        if (records.length > 5000) throw new Error("Project Work Item view exceeds 5000 records. Narrow the project before loading.");
      }
    }
    const tasks = records.filter(record => record.item.kind !== "UserStory");
    const count = (predicate: (item: NoteWorkItem) => boolean) => tasks.filter(record => predicate(record.item)).length;
    return { readAt: readAt ?? new Date().toISOString(), records, summary: {
      total: tasks.length, active: count(item => item.state === "WIP"),
      remaining: count(item => item.state !== "Done"), submitted: count(item => item.state === "Done"),
      success: count(item => item.state === "Done" && item.outcome === "Success"),
      accepted: count(item => !!item.acceptanceDecision),
      unassigned: count(item => !item.ownerId),
      blocked: count(item => item.state === "Blocked"),
      awaitingAcceptance: count(item => item.state === "Done" && !item.acceptanceDecision),
    } };
  });
}

export function inspectWorkItem(reference: WorkItemReference) {
  if (!reference || typeof reference.slug !== "string" || typeof reference.id !== "string"
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(reference.id)
    || typeof reference.digest !== "string" || !/^[a-f0-9]{64}$/.test(reference.digest)
    || reference.knowledgeId !== undefined && !/^knowledge_[a-f0-9]{24}$/.test(reference.knowledgeId)) {
    throw new Error("Choose an exact Work Item reference from a current progress view.");
  }
  return withMarkdownAssetMutation(getStorePath(), () => {
    let slug = reference.slug;
    if (reference.knowledgeId) {
      const inventory = discover().map(note => ({
        area: "notes", relativePath: `${note.slug}.md`, slug: note.slug, title: note.title,
        knowledgeId: knowledgeIdentity(note.slug),
      }));
      const target = resolvePkmLocator(`pkm://knowledge/${reference.knowledgeId}`, inventory);
      if (target.kind !== "panel" || target.type !== "note") throw new Error("Work Item source is unavailable. No same-name substitute was opened.");
      slug = target.key;
    }
    const snapshot = noteWorkItemsRead(slug);
    if (!reference.knowledgeId && snapshot.digest !== reference.digest) {
      throw new Error("Unversioned Note changed. Reload before opening this Work Item.");
    }
    const item = snapshot.items.find(item => item.id === reference.id && !item.deletedAt);
    if (!item) throw new Error("Work Item is unavailable. Reload the progress view.");
    const live = snapshot.items.filter(item => !item.deletedAt);
    const related = live.filter(other => other.id === item.parentId || item.dependsOn?.includes(other.id)
      || item.kind === "UserStory" && other.parentId === item.id);
    const knowledgeId = knowledgeIdentity(slug);
    return { ...record(slug, snapshot.digest, item, knowledgeId), readAt: new Date().toISOString(),
      changed: snapshot.digest !== reference.digest, related: related.map(item => record(slug, snapshot.digest, item, knowledgeId)) };
  });
}
