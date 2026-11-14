import type { NoteWorkItem, WorkItemActor } from "./domain/note-work-items.js";

export interface TodoSnapshot { digest: string; items: NoteWorkItem[] }
export interface TodoChat { hostSessionId: string; title: string; chatUrl?: string; deletedAt?: string }
export interface TodoStore {
  noteGet(slug: string): { title: string; documentKind: "todo-board" } | undefined;
  noteWorkItemsRead(slug: string): TodoSnapshot;
  noteWorkItemNotes(query: string, limit: number): {
    notes: { slug: string; title: string; count: number; digest: string }[];
    truncated: boolean;
  };
  noteWorkItemCommand(slug: string, digest: string, command: unknown, actor: WorkItemActor): TodoSnapshot;
  listChats(): TodoChat[];
}
