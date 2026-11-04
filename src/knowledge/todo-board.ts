import { commandNoteWorkItem, noteWorkItemDigest, NoteWorkItem, readNoteWorkItems, validateDependencies, validateNoteWorkItem, WorkItemActor } from "./note-work-items";

export const todoBoardFilename = "pkm-todo-board.json";
export const todoBoardSchema = "pkm.todo-board/v1";
export type TodoBoardWorkers = Record<string, string>;

function itemMarkdown(items: NoteWorkItem[]): string {
  return items.map(item => `~~~pkm-work-item\n${JSON.stringify(item)}\n~~~\n`).join("\n");
}

export function serializeTodoBoard(items: NoteWorkItem[], workers?: TodoBoardWorkers): string {
  items.forEach(validateNoteWorkItem);
  validateDependencies(items);
  return JSON.stringify({ schema: todoBoardSchema, items, ...(workers ? { workers } : {}) }, null, 2) + "\n";
}

export function todoBoardWorkers(source: string): TodoBoardWorkers {
  const record = JSON.parse(source) as Record<string, unknown>;
  if (record.workers === undefined) return {};
  if (!record.workers || typeof record.workers !== "object" || Array.isArray(record.workers)) throw new Error("Invalid Todo Board worker grants.");
  for (const [id, hash] of Object.entries(record.workers)) {
    if (!/^external:(?:copilot|claude|other):[a-zA-Z0-9_-]{1,80}$/.test(id) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error("Invalid Todo Board worker grant.");
    }
  }
  return record.workers as TodoBoardWorkers;
}

export function readTodoBoard(source: string): { digest: string; items: NoteWorkItem[] } {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new Error("Invalid Todo Board JSON. Restore a reviewed snapshot; do not edit the backing file."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Todo Board document.");
  const record = value as Record<string, unknown>;
  if (record.schema !== todoBoardSchema || Object.keys(record).some(key => !["schema", "items", "workers"].includes(key)) || !Array.isArray(record.items)) {
    throw new Error("Unsupported Todo Board schema.");
  }
  const items = record.items.map(validateNoteWorkItem);
  todoBoardWorkers(source);
  // The shared codec also rejects duplicate IDs; commands enforce the same graph rules.
  readNoteWorkItems(itemMarkdown(items));
  validateDependencies(items);
  return { digest: noteWorkItemDigest(source), items };
}

export function commandTodoBoard(source: string, expectedDigest: string, command: unknown, actor: WorkItemActor): string {
  const snapshot = readTodoBoard(source);
  if (snapshot.digest !== expectedDigest) throw new Error("Todo Board changed since it was read. Reload before updating a Work Item.");
  const markdown = itemMarkdown(snapshot.items);
  const updated = commandNoteWorkItem(markdown, noteWorkItemDigest(markdown), command, actor);
  return serializeTodoBoard(readNoteWorkItems(updated).items, todoBoardWorkers(source));
}
