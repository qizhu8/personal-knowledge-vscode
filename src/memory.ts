import { realpathSync } from "node:fs";
import { z } from "zod";
import { CoreError, type StorageRequest } from "./contracts.js";
import { sha256 } from "./file-write.js";
import { decodeMarkdown, encodeMarkdown, scanMarkdown, type MarkdownRecord } from "./markdown.js";
import { memoryContent, memoryEvent, memoryRecord, memoryText, type MemoryRecord } from "./memory-contracts.js";
import { readKnowledgeMetadata } from "./metadata.js";
import { projectMemoryPreview } from "./domain/memory-search.js";
import { assertMemoryScopeActor, continuityScope } from "./memory-scope-continuity.js";
import { originalMemoryStore, scanOriginalMemoryDocuments } from "./original-mcp-memory-store.js";

const prefix = "System/Memory/";
const version = memoryContent.extend({
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["pending", "confirmed", "superseded", "revoked"]), event: memoryEvent,
});
export const explicitMemoryStateSchema = z.strictObject({
  schema: z.literal("pkm.explicit-memory/v1"), id: z.string().regex(/^explicit-[a-f0-9]{64}$/),
  scope: memoryText(1024), versions: z.array(version).min(1),
});
export type ExplicitMemoryState = z.infer<typeof explicitMemoryStateSchema>;
type State = ExplicitMemoryState;
const memoryImportProvenanceSchema = z.strictObject({
  schema: z.literal("pkm.legacy-explicit-memory-origin/v1"),
  sourceDatabaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  engineIdentity: memoryText(512),
  sourceScopeSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export function memoryScope(root: string) {
  const continuity = continuityScope(root);
  if (continuity !== undefined) return continuity;
  const identity = sha256(realpathSync(root));
  return JSON.stringify({ account: "local-owner", project: identity, repository: identity });
}
export function assertMemoryReceiptScope(root: string, actorId: string, result: unknown): void {
  assertMemoryScopeActor(root, actorId);
  const parsed = memoryRecord.safeParse(result);
  if (!parsed.success) throw new CoreError("INVALID_RESULT", "Memory receipt contains an invalid historical record; preserve it for reconciliation.");
  if (parsed.data.scope !== memoryScope(root)) {
    throw new CoreError("NOT_AVAILABLE", "Explicit memory receipt is not available in this repository scope.");
  }
  const document = (originalMemoryStore(root) ? scanOriginalMemoryDocuments(root) : scanMarkdown(root))
    .find(item => item.record.id === parsed.data.id);
  if (document && readKnowledgeMetadata(document).metadata.memoryImport
    && continuityScope(root) !== parsed.data.scope)
    throw new CoreError("NOT_AVAILABLE", "Imported Memory receipts require a fresh exact host session.");
}
export function memoryTemporaryId(operation: string) {
  const value = sha256(operation);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}
function stateOf(document: MarkdownRecord) {
  const parsed = explicitMemoryStateSchema.safeParse(readKnowledgeMetadata(document).metadata.memory);
  if (!parsed.success) throw new CoreError("INVALID_DOCUMENT", "Explicit-memory Markdown contains invalid state; preserve it for reconciliation.");
  const state = parsed.data, last = state.versions.at(-1)!;
  if (document.record.path !== `${prefix}${state.id}.md` || document.record.id !== state.id
    || document.record.deleted || document.record.revision !== state.versions.length
    || document.record.content !== last.content) throw new CoreError("INVALID_DOCUMENT", "Explicit-memory identity/body/revision disagrees with its authoritative state.");
  for (const [index, value] of state.versions.entries()) {
    const event = value.event, expectedAction = index === 0 ? "proposed" : event.action;
    const expectedStatus = expectedAction === "confirmed" ? "confirmed" : expectedAction === "revoked" ? "revoked" : "pending";
    if (value.revision !== index + 1 || event.revision !== value.revision
      || (index < state.versions.length - 1 ? value.status !== "superseded" : value.status !== event.status)
      || (index === 0 ? event.action !== "proposed" || event.decision_id !== null || event.actor !== "caller"
        : event.action === "proposed" || event.decision_id === null)
      || event.status !== expectedStatus
      || (index > 0 && (event.sequence <= state.versions[index - 1]!.event.sequence
        || event.created_at < state.versions[index - 1]!.event.created_at
        || state.versions[index - 1]!.event.status === "revoked"
        || event.action === "confirmed" && state.versions[index - 1]!.event.status === "confirmed"))) {
      throw new CoreError("INVALID_DOCUMENT", "Explicit-memory history violates lifecycle/audit invariants.");
    }
  }
  return state;
}
export function encodeImportedMemoryDocument(stateInput: ExplicitMemoryState, provenanceInput: unknown, knowledgeId?: string): MarkdownRecord {
  const state = explicitMemoryStateSchema.parse(stateInput);
  const provenance = memoryImportProvenanceSchema.parse(provenanceInput);
  const current = state.versions.at(-1)!;
  const path = `${prefix}${state.id}.md`;
  const initial = decodeMarkdown(state.id, encodeMarkdown(state.id, "Explicit memory", current.content,
    current.revision, false, undefined, path), path);
  const metadata = initial.metadata.clone();
  if (knowledgeId !== undefined) metadata.set("knowledgeId", knowledgeId);
  metadata.set("memory", state);
  metadata.set("memoryImport", provenance);
  const raw = encodeMarkdown(state.id, "Explicit memory", current.content, current.revision, false,
    { ...initial, metadata }, path);
  const document = decodeMarkdown(state.id, raw, path);
  stateOf(document);
  return document;
}
export function readMemoryRecord(document: MarkdownRecord, revision?: number): MemoryRecord {
  const state = stateOf(document), current = state.versions.at(-1)!;
  const selected = revision === undefined ? current : state.versions.find(item => item.revision === revision);
  if (!selected) throw new CoreError("NOT_AVAILABLE", "Explicit-memory revision not found.");
  return memoryRecord.parse({
    id: state.id, scope: state.scope, revision: selected.revision, current_revision: current.revision,
    status: selected.status, current_status: current.status,
    content: selected.content, sources: selected.sources, created_at: state.versions[0]!.event.created_at,
    updated_at: current.event.created_at, revision_created_at: selected.event.created_at,
    documentSha256: document.record.sha256,
  });
}
export function memoryIntentResult(root: string, document: MarkdownRecord, operation: string, operationId: string) {
  const state = stateOf(document), event = state.versions.at(-1)!.event;
  const action = operation === "memory.record.propose" ? "proposed" : operation === "memory.record.confirm" ? "confirmed"
    : operation === "memory.record.revise" ? "revised" : operation === "memory.record.revoke" ? "revoked" : undefined;
  if (action === undefined || state.scope !== memoryScope(root) || event.action !== action || event.operation_id !== operationId
    || operation === "memory.record.propose" && state.versions.length !== 1) {
    throw new CoreError("INVALID_WORKSPACE", "Pending memory action/operation/scope disagrees with its authoritative state; preserve the journal.");
  }
  return readMemoryRecord(document);
}
export function planMemory(root: string, documents: MarkdownRecord[], request: StorageRequest):
  { result: unknown } | { write: { id: string; path: string; raw: string; before: string | null }; result: MemoryRecord } {
  assertMemoryScopeActor(root, request.actorId);
  const collection = originalMemoryStore(root) ? scanOriginalMemoryDocuments(root)
    : documents.filter(item => item.record.area === "notes" && item.record.path.startsWith(prefix));
  const memories = collection.map(document => ({ document, state: stateOf(document) }));
  const sequences = new Set<number>();
  for (const { state } of memories) for (const item of state.versions) {
    if (sequences.has(item.event.sequence)) throw new CoreError("CONFLICT", "Duplicate global memory audit sequence; preserve Markdown for reconciliation.");
    sequences.add(item.event.sequence);
  }
  const scope = memoryScope(root), { args, operation } = request;
  const activeScope = continuityScope(root);
  const accessible = (item: typeof memories[number]) => item.state.scope === scope
    && (!readKnowledgeMetadata(item.document).metadata.memoryImport || activeScope === item.state.scope);
  const owned = memories.find(item => item.state.id === args.id && accessible(item));
  if (operation === "memory.record.search") {
    const lower = (text: string) => text.replace(/[A-Z]/g, character => character.toLowerCase());
    const found = memories.filter(item => accessible(item) && item.state.versions.at(-1)!.status === "confirmed")
      .map(item => readMemoryRecord(item.document))
      .filter(item => lower(item.content).includes(lower(String(args.query))))
      .sort((a, b) => b.updated_at - a.updated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, Number(args.limit));
    return { result: { records: found.map(projectMemoryPreview) } };
  }
  if (operation !== "memory.record.propose" && !owned) throw new CoreError("NOT_AVAILABLE", "Explicit memory not found in this repository scope.");
  if (operation === "memory.record.get") return { result: readMemoryRecord(owned!.document, args.revision === undefined ? undefined : Number(args.revision)) };
  if (operation === "memory.record.audit") {
    const events = owned!.state.versions.map(item => item.event).filter(item => item.sequence > Number(args.after)).slice(0, Number(args.limit));
    return { result: { events, next: events.length === args.limit ? events.at(-1)!.sequence : null } };
  }
  let sequence = 1;
  for (const value of sequences) sequence = Math.max(sequence, value + 1);
  if (!Number.isSafeInteger(sequence)) throw new CoreError("CONFLICT", "Memory audit sequence exhausted.");
  let state: State, previous: MarkdownRecord | undefined;
  const operationId = String(args.operation_id), now = Date.now() / 1000;
  if (operation === "memory.record.propose") {
    if (collection.length === 4096) throw new CoreError("BUSY", "Explicit-memory record limit reached; no proposal was committed.");
    const id = `explicit-${sha256(`${scope}\0${operationId}`)}`;
    if ([...documents, ...collection].some(item => item.record.id === id || item.record.area === "notes" && item.record.path === `${prefix}${id}.md`)) {
      throw new CoreError("CONFLICT", "Explicit-memory proposal identity/path already exists.");
    }
    const content = memoryContent.parse({ content: args.content, sources: args.sources });
    state = { schema: "pkm.explicit-memory/v1", id, scope, versions: [{
      ...content, revision: 1, status: "pending",
      event: { sequence, revision: 1, action: "proposed", status: "pending", actor: "caller", decision_id: null, operation_id: operationId, created_at: now },
    }] };
  } else {
    if (!request.memoryDecision) throw new CoreError("NOT_AVAILABLE", "Native human exact-record approval is required; HTTP/MCP cannot authorize memory transitions.");
    previous = owned!.document;
    const current = owned!.state.versions.at(-1)!;
    if (args.expected_revision !== current.revision || request.memoryDecision.documentSha256 !== previous.record.sha256) {
      throw new CoreError("CONFLICT", "Memory changed since its exact-record human review; reread and approve the current version.");
    }
    if (current.status === "revoked" || operation === "memory.record.confirm" && current.status === "confirmed") {
      throw new CoreError("CONFLICT", "Revoked/already-confirmed memory cannot perform this transition.");
    }
    if (current.revision === Number.MAX_SAFE_INTEGER) throw new CoreError("CONFLICT", "Memory revision exhausted.");
    state = structuredClone(owned!.state);
    state.versions.at(-1)!.status = "superseded";
    const content = operation === "memory.record.revise" ? memoryContent.parse({ content: args.content, sources: args.sources })
      : { content: current.content, sources: current.sources };
    const status = operation === "memory.record.confirm" ? "confirmed" : operation === "memory.record.revoke" ? "revoked" : "pending";
    const action = operation === "memory.record.confirm" ? "confirmed" : operation === "memory.record.revoke" ? "revoked" : "revised";
    state.versions.push({
      ...content, revision: current.revision + 1, status,
      event: { sequence, revision: current.revision + 1, action, status, actor: request.memoryDecision.actorId,
        decision_id: request.memoryDecision.decisionId, operation_id: operationId, created_at: Math.max(now, current.event.created_at) },
    });
  }
  const path = `${prefix}${state.id}.md`, current = state.versions.at(-1)!;
  const initial = previous ?? decodeMarkdown(state.id, encodeMarkdown(state.id, "Explicit memory", current.content, 1, false, undefined, path), path);
  const metadata = initial.metadata.clone();
  metadata.set("memory", state);
  const raw = encodeMarkdown(state.id, "Explicit memory", current.content, current.revision, false, { ...initial, metadata }, path);
  const result = readMemoryRecord(decodeMarkdown(state.id, raw, path));
  return { write: { id: state.id, path, raw, before: previous?.record.sha256 ?? null }, result };
}
