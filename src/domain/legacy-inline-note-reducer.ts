import { parseDocument } from "yaml";
import { CoreError } from "../contracts.js";
import { commandNoteWorkItem, noteWorkItemDigest, readNoteWorkItems, upsertNoteWorkItem, validateDependencies, type WorkItemActor } from "./note-work-items.js";
import { legacyInlineNoteCommandSchema } from "../legacy-inline-note-contracts.js";

export function inspectLegacyInlineNote(markdown: string) {
  if (typeof markdown !== "string" || Buffer.from(markdown).toString() !== markdown)
    throw new CoreError("INVALID_DOCUMENT", "Inline Note must be valid UTF-8.");
  const lines = [...markdown.matchAll(/([^\r\n]*)(?:\r?\n|$)/g)].filter(line => line[0]);
  let firstBodyLine = 0;
  if (/^\uFEFF?---[ \t]*$/.test(lines[0]?.[1] ?? "")) {
    const end = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line[1]));
    if (end < 0) throw new CoreError("INVALID_DOCUMENT", "Unclosed original Note YAML.");
    firstBodyLine = end + 1;
    const yaml = markdown.slice(lines[0][0].length, lines[end].index);
    const document = parseDocument(yaml, { uniqueKeys: true });
    if (document.errors.length) throw new CoreError("INVALID_DOCUMENT", "Corrupt or ambiguous original Note YAML.");
    let metadata: unknown;
    try { metadata = document.toJS({ maxAliasCount: 100 }); }
    catch { throw new CoreError("INVALID_DOCUMENT", "Unbounded original Note YAML aliases."); }
    if (metadata !== null && (typeof metadata !== "object" || Array.isArray(metadata)))
      throw new CoreError("INVALID_DOCUMENT", "Original Note YAML must be a mapping.");
    if ((metadata as Record<string, unknown> | null)?.documentKind === "todo-board")
      throw new CoreError("NOT_AVAILABLE", "Attached Board authority is not inline Note authority; filestore.ts:674-693.");
  }
  // Match the original fence scanner, but fail closed on duplicate JSON keys
  // that JSON.parse would otherwise silently discard.
  for (let index = firstBodyLine; index < lines.length; index++) {
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index][1]);
    if (!opening) continue;
    const start = index;
    while (++index < lines.length) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[index][1]);
      if (closing && closing[1][0] === opening[1][0] && closing[1].length >= opening[1].length) break;
    }
    if (opening[2].trim() !== "pkm-work-item" || index >= lines.length) continue;
    const json = markdown.slice(lines[start].index! + lines[start][0].length, lines[index].index);
    const document = parseDocument(json, { uniqueKeys: true });
    if (document.errors.length) throw new CoreError("INVALID_DOCUMENT", "Ambiguous original inline Work Item JSON keys.");
  }
  try {
    const snapshot = readNoteWorkItems(markdown);
    validateDependencies(snapshot.items);
    return snapshot;
  } catch (error) { throw new CoreError("INVALID_DOCUMENT", String(error)); }
}

export function reduceLegacyInlineNote(markdown: string, expected: string, command: unknown,
  actor: WorkItemActor, at: string): string {
  const before = inspectLegacyInlineNote(markdown);
  if (before.digest !== expected) throw new CoreError("CONFLICT", "Original Note changed; reload exact bytes.");
  if (actor.role === "board-agent") throw new CoreError("NOT_AVAILABLE", "Board management requires a dedicated Board; filestore.ts:690.");
  const parsed = legacyInlineNoteCommandSchema.safeParse(command);
  if (!parsed.success) throw new CoreError("INVALID_ARGUMENT", "Invalid strict original inline command.");
  if (parsed.data.action === "accept" && actor.role !== "user")
    throw new CoreError("NOT_AVAILABLE", "Original delegated worker acceptance is not human-only native acceptance; note-work-items.ts:303.");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at)
    throw new CoreError("INVALID_ARGUMENT", "Trusted event clock must be an exact ISO timestamp.");
  let result: string;
  try { result = commandNoteWorkItem(markdown, expected, parsed.data, actor); }
  catch (error) { throw new CoreError("INVALID_ARGUMENT", String(error)); }
  // Original reducer generates times internally. Project only the newly generated
  // event times to the durable host clock; old audit and all surrounding bytes stay exact.
  const after = readNoteWorkItems(result);
  const changed = after.items.find(item => (item.history?.length ?? 0)
    === (before.items.find(prior => prior.id === item.id)?.history?.length ?? 0) + 1);
  if (!changed) throw new CoreError("STORAGE_ERROR", "Original reducer produced no exact audit event.");
  changed.history!.at(-1)!.at = at;
  if (parsed.data.action === "accept") changed.acceptanceDecision!.at = at;
  if (parsed.data.action === "delete") changed.deletedAt = at;
  if (parsed.data.action === "comment") changed.comments!.at(-1)!.at = at;
  for (const change of changed.history!.at(-1)!.changes ?? []) {
    if (parsed.data.action === "accept" && change.field === "acceptanceDecision")
      change.after = JSON.stringify(changed.acceptanceDecision);
    if (parsed.data.action === "delete" && change.field === "deletedAt")
      change.after = JSON.stringify(at);
  }
  // Same original encoder, never a YAML serializer or a Board conversion.
  result = upsertNoteWorkItem(result, noteWorkItemDigest(result), changed);
  inspectLegacyInlineNote(result);
  if (noteWorkItemDigest(result) === before.digest) throw new CoreError("STORAGE_ERROR", "Original command did not generate an audit effect.");
  return result;
}
