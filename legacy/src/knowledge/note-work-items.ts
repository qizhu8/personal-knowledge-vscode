import { createHash } from "crypto";

export const workItemIcons = ["tasklist", "bug", "beaker", "eye", "checklist", "lightbulb"] as const;

export interface NoteWorkItem {
  id: string;
  kind?: "Task" | "UserStory";
  parentId?: string;
  storyStatus?: "draft" | "confirmed";
  title: string;
  description?: string;
  icon?: typeof workItemIcons[number];
  goal: string;
  scope: string;
  acceptance: string[];
  state: "Planning" | "WIP" | "Blocked" | "OnHold" | "Done";
  outcome?: "Success" | "Failed" | "Unsure";
  evidence: string[];
  blockedReason?: string;
  owner?: string;
  ownerId?: string;
  collaboratorIds?: string[];
  monitoring?: { until?: string; endCondition?: string };
  projectId?: string;
  reviewerIds?: string[];
  dependsOn?: string[];
  plannedStart?: string;
  plannedEnd?: string;
  links?: string[];
  verification?: { layer: "unit" | "functional" | "e2e"; status: "passed" | "failed" | "blocked" | "not-run" | "not-applicable"; evidence: string[]; reason?: string }[];
  history?: { at: string; actorId: string; action: string; from?: NoteWorkItem["state"]; to?: NoteWorkItem["state"]; reason?: string;
    changes?: { field: string; before?: string; after?: string }[] }[];
  acceptanceDecision?: { by: string; at: string; decision: "accepted" };
  deletedAt?: string;
  deletedBy?: string;
  comments?: { at: string; actorId: string; text: string }[];
}

export interface WorkItemActor { id: string; role: "user" | "worker" | "board-agent" }
export type WorkItemCommand =
  | { action: "create" | "edit"; item: NoteWorkItem; reason?: string }
  | { action: "claim" | "release" | "accept" | "reopen" | "delete" | "restore"; id: string; reason?: string }
  | { action: "assign"; id: string; ownerId: string; reason?: string }
  | { action: "comment"; id: string; text: string }
  | { action: "transition"; id: string; state: NoteWorkItem["state"]; reason?: string; blockedReason?: string; outcome?: "Success" | "Failed" | "Unsure"; evidence?: string[]; verification?: NoteWorkItem["verification"] };

interface WorkItemBlock { item: NoteWorkItem; start: number; end: number }

const states = ["Planning", "WIP", "Blocked", "OnHold", "Done"];
function object(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key))) throw new Error(`Unknown ${label} field.`);
  return record;
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string.`);
}
function strings(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a string list.`);
  value.forEach(entry => text(entry, label));
}
function timestamp(value: unknown): void {
  text(value, "Timestamp");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error("Invalid Work Item timestamp.");
}

export function noteWorkItemDigest(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex");
}

export function validateNoteWorkItem(value: unknown): NoteWorkItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Work Item must be an object.");
  const item = value as Record<string, unknown>;
  const allowed = ["id", "title", "goal", "scope", "acceptance", "state", "outcome", "evidence", "blockedReason", "owner",
    "ownerId", "projectId", "reviewerIds", "dependsOn", "plannedStart", "plannedEnd", "links", "verification", "history", "acceptanceDecision",
    "kind", "parentId", "storyStatus", "deletedAt", "deletedBy", "comments", "description", "icon", "collaboratorIds", "monitoring"];
  if (Object.keys(item).some(key => !allowed.includes(key))) throw new Error("Unknown Work Item field.");
  for (const field of ["id", "title", "goal", "scope"]) {
    if (typeof item[field] !== "string" || !item[field].trim()) throw new Error(`Work Item ${field} is required.`);
  }
  if (typeof item.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.id)) throw new Error("Invalid Work Item ID.");
  if (item.description !== undefined && (typeof item.description !== "string" || !item.description.trim() || item.description.length > 16000)) {
    throw new Error("Work Item description must contain 1-16000 characters.");
  }
  if (item.icon !== undefined && !workItemIcons.includes(item.icon as typeof workItemIcons[number])) throw new Error("Choose a supported Work Item icon.");
  if (item.collaboratorIds !== undefined) {
    strings(item.collaboratorIds, "Collaborator identities");
    const collaborators = item.collaboratorIds as string[];
    if (collaborators.length > 20 || new Set(collaborators).size !== collaborators.length
      || collaborators.some(id => !/^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(id) || id === item.ownerId)) {
      throw new Error("Use up to 20 distinct stable collaborator identities, separate from the execution owner.");
    }
  }
  if (item.monitoring !== undefined) {
    const monitoring = object(item.monitoring, ["until", "endCondition"], "monitoring contract");
    if (monitoring.until === undefined && monitoring.endCondition === undefined) throw new Error("Monitoring requires an observation deadline or explicit end condition.");
    if (monitoring.until !== undefined) timestamp(monitoring.until);
    if (monitoring.endCondition !== undefined) {
      text(monitoring.endCondition, "Monitoring end condition");
      if (monitoring.endCondition.length > 8000) throw new Error("Monitoring end condition exceeds 8000 characters.");
    }
  }
  if (item.kind !== undefined && item.kind !== "Task" && item.kind !== "UserStory") throw new Error("Invalid Work Item kind.");
  if (item.parentId !== undefined && (typeof item.parentId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.parentId))) throw new Error("Invalid User Story parentId.");
  if (item.kind === "UserStory" && item.parentId !== undefined) throw new Error("User Stories cannot have a parent User Story.");
  if (item.storyStatus !== undefined && (item.kind !== "UserStory" || !["draft", "confirmed"].includes(String(item.storyStatus)))) throw new Error("Only User Stories have draft/confirmed storyStatus.");
  for (const field of ["acceptance", "evidence"]) {
    if (!Array.isArray(item[field]) || item[field].some(value => typeof value !== "string" || !value.trim())) {
      throw new Error(`Work Item ${field} must be a list of nonempty strings.`);
    }
  }
  if (!(item.acceptance as string[]).length) throw new Error("Work Item acceptance criteria are required.");
  if (typeof item.state !== "string" || !states.includes(item.state)) throw new Error("Invalid Work Item state.");
  if (item.outcome !== undefined && (typeof item.outcome !== "string" || !["Success", "Failed", "Unsure"].includes(item.outcome))) throw new Error("Invalid Work Item outcome.");
  for (const field of ["blockedReason", "owner", "ownerId", "projectId"]) {
    if (item[field] !== undefined && (typeof item[field] !== "string" || !item[field].trim())) throw new Error(`Invalid Work Item ${field}.`);
  }
  if (typeof item.ownerId === "string" && item.ownerId.startsWith("external:")
    && !/^external:(?:copilot|claude|other):[a-zA-Z0-9_-]{1,80}$/.test(item.ownerId)) {
    throw new Error("External Agent ownership requires external:copilot/claude/other:<stable-id>.");
  }
  if (item.state === "Blocked" && !item.blockedReason) throw new Error("Blocked Work Items require a reason.");
  if (item.state === "Done" && (!item.outcome || !(item.evidence as string[]).length)) {
    throw new Error("Done Work Items require an explicit outcome and evidence; Done is not automatic acceptance.");
  }
  if (item.state !== "Done" && item.outcome !== undefined) throw new Error("Only Done Work Items can record a terminal outcome.");
  for (const field of ["dependsOn", "links", "reviewerIds"]) if (item[field] !== undefined) strings(item[field], field);
  if (item.dependsOn !== undefined && ((item.dependsOn as string[]).some(id => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id))
    || new Set(item.dependsOn as string[]).size !== (item.dependsOn as string[]).length)) throw new Error("Invalid Work Item dependencies.");
  if (item.plannedStart !== undefined || item.plannedEnd !== undefined) {
    for (const field of ["plannedStart", "plannedEnd"]) {
      const date = item[field];
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
        || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("Work Item schedule requires a valid YYYY-MM-DD pair.");
    }
    if ((item.plannedStart as string) > (item.plannedEnd as string)) throw new Error("Work Item schedule end precedes start.");
  }
  if (item.verification !== undefined) {
    if (!Array.isArray(item.verification)) throw new Error("Invalid Work Item verification.");
    for (const entry of item.verification) {
      const record = object(entry, ["layer", "status", "evidence", "reason"], "verification");
      if (!["unit", "functional", "e2e"].includes(record.layer as string)
        || !["passed", "failed", "blocked", "not-run", "not-applicable"].includes(record.status as string)) throw new Error("Invalid Work Item verification.");
      strings(record.evidence, "Verification evidence");
      if (record.reason !== undefined) text(record.reason, "Verification reason");
      if (record.status === "not-applicable" && !record.reason) throw new Error("Not-applicable verification requires a reason.");
      if (["passed", "failed"].includes(record.status as string) && !record.evidence.length) throw new Error("Reported verification requires evidence.");
    }
  }
  if (item.history !== undefined) {
    if (!Array.isArray(item.history)) throw new Error("Invalid Work Item history.");
    for (const entry of item.history) {
      const record = object(entry, ["at", "actorId", "action", "from", "to", "reason", "changes"], "history");
      timestamp(record.at);
      text(record.actorId, "History actorId");
      text(record.action, "History action");
      for (const field of ["from", "to"]) if (record[field] !== undefined && !states.includes(record[field] as string)) throw new Error("Invalid history state.");
      if (record.reason !== undefined) text(record.reason, "History reason");
      if (record.changes !== undefined) {
        if (!Array.isArray(record.changes)) throw new Error("Invalid history changes.");
        for (const value of record.changes) {
          const change = object(value, ["field", "before", "after"], "history change");
          text(change.field, "Changed field");
          for (const key of ["before", "after"]) if (change[key] !== undefined) text(change[key], "Changed value");
        }
      }
    }
  }
  if (item.acceptanceDecision !== undefined) {
    const decision = object(item.acceptanceDecision, ["by", "at", "decision"], "acceptance decision");
    text(decision.by, "Acceptance by");
    timestamp(decision.at);
    if (decision.decision !== "accepted" || item.state !== "Done") throw new Error("Acceptance requires a Done Work Item.");
  }
  if (item.deletedAt !== undefined || item.deletedBy !== undefined) {
    timestamp(item.deletedAt);
    text(item.deletedBy, "Deletion actor");
  }
  if (item.comments !== undefined) {
    if (!Array.isArray(item.comments)) throw new Error("Comments must be a list.");
    for (const entry of item.comments) {
      const comment = object(entry, ["at", "actorId", "text"], "comment");
      timestamp(comment.at);
      text(comment.actorId, "Comment actor");
      text(comment.text, "Comment text");
    }
  }
  return JSON.parse(JSON.stringify(item)) as NoteWorkItem;
}

export function validateDependencies(items: NoteWorkItem[]): void {
  const byId = new Map(items.map(item => [item.id, item]));
  for (const item of items) {
    if (item.parentId !== undefined) {
      const parent = byId.get(item.parentId);
      if (!parent || parent.kind !== "UserStory") throw new Error("Work Item parentId must reference a User Story in the same Note.");
      if (!item.deletedAt && parent.deletedAt) throw new Error("Restore the parent User Story before linking or restoring a Work Item.");
      if (item.projectId && parent.projectId && item.projectId !== parent.projectId) throw new Error("Work Item and parent User Story belong to different Projects.");
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("Work Item dependency cycle or self-dependency.");
    if (visited.has(id)) return;
    const item = byId.get(id);
    if (!item) throw new Error(`Missing Work Item dependency: ${id}`);
    visiting.add(id);
    for (const dependency of item.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of items) visit(item.id);
  for (const item of items.filter(item=>!item.deletedAt)) {
    if (item.dependsOn?.some(id=>byId.get(id)?.deletedAt)) throw new Error("Active Work Items cannot depend on deleted Work Items.");
  }
}

/** Pure command reducer; callers must hold the shared Markdown mutation lock through persistence. */
export function commandNoteWorkItem(markdown: string, expectedDigest: string, input: unknown, actorInput: WorkItemActor): string {
  if (noteWorkItemDigest(markdown) !== expectedDigest) throw new Error("Note changed since it was read. Reload before updating a Work Item.");
  const current = readNoteWorkItems(markdown);
  const actor = object(actorInput, ["id", "role"], "Work Item actor");
  text(actor.id, "Actor id");
  if (actor.role !== "user" && actor.role !== "worker" && actor.role !== "board-agent") throw new Error("Invalid Work Item actor role.");
  const command = object(input, ["action", "id", "item", "reason", "state", "blockedReason", "outcome", "evidence", "verification", "ownerId", "text"], "Work Item command");
  const action = command.action;
  if (typeof action !== "string" || !["create", "edit", "claim", "release", "accept", "reopen", "transition", "delete", "restore", "comment", "assign"].includes(action)) throw new Error("Invalid Work Item command.");
  const allowed = action === "create" || action === "edit" ? ["action", "item", "reason"]
    : action === "transition" ? ["action", "id", "state", "reason", "blockedReason", "outcome", "evidence", "verification"]
    : action === "assign" ? ["action", "id", "ownerId", "reason"]
    : action === "comment" ? ["action", "id", "text"] : ["action", "id", "reason"];
  object(command, allowed, "Work Item command");
  if (command.reason !== undefined) text(command.reason, "Command reason");
  let submitted = command.item;
  if (action === "edit" && actor.role === "user" && submitted && typeof submitted === "object" && !Array.isArray(submitted)) {
    // User drafts may retain stale read-only audit fields after an explicit reload.
    const editable = { ...submitted } as Record<string, unknown>;
    delete editable.history;
    delete editable.acceptanceDecision;
    delete editable.comments;
    delete editable.deletedAt;
    delete editable.deletedBy;
    submitted = editable;
  }
  const supplied = action === "create" || action === "edit" ? validateNoteWorkItem(submitted) : undefined;
  const id = supplied?.id ?? command.id;
  text(id, "Work Item id");
  const previous = current.items.find(item => item.id === id);
  if (action === "create" ? !!previous : !previous) throw new Error(action === "create" ? "Work Item already exists." : "Work Item not found.");
  let next: NoteWorkItem = supplied ?? validateNoteWorkItem(previous!);
  if (previous?.deletedAt && action !== "restore") throw new Error("Work Item is deleted. Restore it before modifying it.");
  if (["delete", "restore", "assign"].includes(action) && actor.role === "worker") throw new Error("Use the Board management API for this operation.");
  const own = (): void => {
    if (!previous?.ownerId || previous.ownerId !== actor.id) throw new Error("Work Item must be owned by this actor.");
    if (previous.state === "Done") throw new Error("Done Work Items must be reopened by a user.");
  };
  if (action === "create") {
    if (next.history !== undefined || next.acceptanceDecision !== undefined || next.deletedAt !== undefined || next.comments !== undefined) throw new Error("History, comments, deletion and acceptance decisions are generated, not supplied.");
    if (actor.role === "board-agent" && next.reviewerIds !== undefined) throw new Error("Only users delegate acceptance reviewers.");
    if (next.state !== "Planning") throw new Error("Create Work Items in Planning.");
    if (actor.role === "worker" && (next.ownerId !== undefined || next.owner !== undefined)) throw new Error("Workers create unowned Planning Work Items, then claim them.");
    if (actor.role === "worker" && (next.projectId !== undefined || next.reviewerIds !== undefined || next.parentId !== undefined
      || next.kind === "UserStory" || next.storyStatus !== undefined || next.collaboratorIds?.length)) throw new Error("Only users assign projectId, reviewerIds, collaborators and User Story contracts.");
  } else if (action === "edit") {
    for (const field of ["deletedAt", "deletedBy", "comments"] as const) {
      if (actor.role === "user") {
        if (field==="comments") next.comments = previous!.comments;
        else if (field==="deletedAt") next.deletedAt = previous!.deletedAt;
        else next.deletedBy = previous!.deletedBy;
      }
      if (JSON.stringify(next[field]) !== JSON.stringify(previous![field])) throw new Error(`${field} is generated by dedicated commands.`);
    }
    if (actor.role === "board-agent" && JSON.stringify(next.reviewerIds) !== JSON.stringify(previous!.reviewerIds)) throw new Error("Only users delegate acceptance reviewers.");
    if (actor.role === "worker" && (JSON.stringify(next.history) !== JSON.stringify(previous!.history)
      || JSON.stringify(next.acceptanceDecision) !== JSON.stringify(previous!.acceptanceDecision))) throw new Error("History and acceptance decisions are protected.");
    next.history = previous!.history;
    next.acceptanceDecision = previous!.acceptanceDecision;
    if (previous!.state === "Done") throw new Error("Done Work Items must be reopened by a user.");
    if (actor.role === "worker") {
      own();
      for (const field of ["state", "outcome", "title", "goal", "scope", "acceptance", "owner", "ownerId", "projectId", "reviewerIds", "dependsOn", "plannedStart", "plannedEnd", "kind", "parentId", "storyStatus", "description", "icon", "collaboratorIds", "monitoring"] as const) {
        if (JSON.stringify(next[field]) !== JSON.stringify(previous![field])) throw new Error(`Worker cannot edit protected field: ${field}`);
      }
    }
  } else if (action === "claim") {
    if (previous!.state === "Done") throw new Error("Done Work Items cannot be claimed.");
    if (previous!.ownerId && previous!.ownerId !== actor.id) throw new Error("Work Item is owned by another actor.");
    if (!previous!.ownerId && previous!.owner) throw new Error("Legacy owner label requires a user to assign ownerId before claiming.");
    next.ownerId = actor.id;
    next.owner = actor.id;
    next.state = "WIP";
    delete next.blockedReason;
  } else if (action === "release") {
    own();
    text(command.reason, "Release reason");
    delete next.owner;
    delete next.ownerId;
    delete next.blockedReason;
    next.state = "Planning";
  } else if (action === "accept") {
    if (actor.role !== "user" && !previous!.reviewerIds?.includes(actor.id as string)) throw new Error("Only a user or explicitly delegated reviewer can accept Work Items.");
    if (previous!.state !== "Done" || !previous!.evidence.length) throw new Error("Acceptance requires Done and evidence.");
    if (previous!.acceptanceDecision) throw new Error("Work Item is already accepted.");
    text(command.reason, "Acceptance reason");
    next.acceptanceDecision = { by:actor.id, at:new Date().toISOString(), decision:"accepted" };
  } else if (action === "reopen") {
    if (actor.role === "worker") throw new Error("Only a user or Board management API can reopen Work Items.");
    if (previous!.state !== "Done") throw new Error("Only Done Work Items can be reopened.");
    text(command.reason, "Reopen reason");
    next.state = "Planning";
    delete next.acceptanceDecision;
    delete next.outcome;
    delete next.blockedReason;
  } else if (action === "delete") {
    text(command.reason, "Deletion reason");
    if (current.items.some(item=>!item.deletedAt && (item.parentId===id || item.dependsOn?.includes(id)))) throw new Error("Move/delete child Work Items and remove dependency references before deleting.");
    next.deletedAt = new Date().toISOString();
    next.deletedBy = actor.id;
  } else if (action === "restore") {
    if (!previous!.deletedAt) throw new Error("Work Item is not deleted.");
    text(command.reason, "Restore reason");
    delete next.deletedAt;
    delete next.deletedBy;
  } else if (action === "comment") {
    text(command.text, "Comment");
    if (command.text.length > 8000) throw new Error("Comment exceeds 8000 characters.");
    next.comments = [...(previous!.comments || []), { at:new Date().toISOString(), actorId:actor.id, text:command.text }];
  } else if (action === "assign") {
    if (previous!.state === "Done") throw new Error("Reopen completed Work Items before assigning them.");
    text(command.ownerId, "Owner identity");
    next.ownerId = command.ownerId;
    next.owner = command.ownerId;
  } else {
    own();
    if (typeof command.state !== "string" || !states.includes(command.state)) throw new Error("Invalid Work Item transition state.");
    next.state = command.state as NoteWorkItem["state"];
    delete next.blockedReason;
    delete next.outcome;
    if (command.blockedReason !== undefined) {
      if (next.state !== "Blocked") throw new Error("Only Blocked transitions take blockedReason.");
      text(command.blockedReason, "Blocked reason");
      next.blockedReason = command.blockedReason;
    }
    if (command.outcome !== undefined) next.outcome = command.outcome as NoteWorkItem["outcome"];
    if (command.evidence !== undefined) {
      strings(command.evidence, "Transition evidence");
      next.evidence = [...new Set([...next.evidence, ...command.evidence])];
    }
    if (command.verification !== undefined) next.verification = validateNoteWorkItem({ ...next, verification:command.verification }).verification;
    if (next.state === "Done" && (command.outcome === undefined || !next.evidence.length)) throw new Error("Done requires explicit outcome and evidence.");
  }
  if (next.state === "OnHold" && (previous?.state !== "OnHold" || action === "transition")) text(command.reason, "On hold reason");
  const at = next.acceptanceDecision?.at && action === "accept" ? next.acceptanceDecision.at : new Date().toISOString();
  const changes = (Object.keys(next) as Array<keyof NoteWorkItem>).concat(Object.keys(previous || {}) as Array<keyof NoteWorkItem>)
    .filter((field,index,fields)=>fields.indexOf(field)===index && !["history", "comments"].includes(field))
    .flatMap(field=>{
      const before = JSON.stringify(previous?.[field]), after = JSON.stringify(next[field]);
      return before===after?[]:[{ field, ...(before!==undefined?{before}:{}), ...(after!==undefined?{after}:{}) }];
    });
  next.history = [...(previous?.history ?? []), { at, actorId:actor.id as string, action,
    ...(previous ? { from:previous.state } : {}), to:next.state,
    ...(command.reason !== undefined ? { reason:command.reason as string } : {}),
    ...(action === "comment" ? { reason:command.text as string } : {}),
    ...(changes.length ? { changes } : {}),
    ...(action === "transition" && command.blockedReason ? { reason:command.blockedReason as string } : {}) }];
  next = validateNoteWorkItem(next);
  if (next.parentId && (next.parentId !== previous?.parentId || action === "restore") && current.items.find(item => item.id === next.parentId)?.state === "Done") {
    throw new Error("Reopen the parent User Story before adding or moving a child.");
  }
  if (next.state === "Done" && next.kind === "UserStory" && !next.deletedAt && current.items.some(item => !item.deletedAt && item.parentId === next.id && (item.state !== "Done" || !item.acceptanceDecision))) {
    throw new Error("Accept all child Work Items before reporting the User Story Done.");
  }
  if (action === "reopen" && previous?.parentId) {
    const parent = current.items.find(item => item.id === previous.parentId);
    if (parent?.state === "Done") throw new Error("Reopen the parent User Story before reopening a child.");
  }
  validateDependencies([...current.items.filter(item => item.id !== id), next]);
  return upsertNoteWorkItem(markdown, expectedDigest, next);
}

function blocks(markdown: string): WorkItemBlock[] {
  const result: WorkItemBlock[] = [];
  const ids = new Set<string>();
  const lines = [...markdown.matchAll(/([^\r\n]*)(?:\r?\n|$)/g)].filter(line => line[0]);
  let firstBodyLine = 0;
  if (/^\uFEFF?---[ \t]*$/.test(lines[0]?.[1] ?? "")) {
    const closing = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line[1]));
    if (closing >= 0) firstBodyLine = closing + 1;
  }
  for (let index = firstBodyLine; index < lines.length; index++) {
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index][1]);
    if (!opening) continue;
    const start = index;
    const marker = opening[1];
    const workItem = opening[2].trim() === "pkm-work-item";
    while (++index < lines.length) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[index][1]);
      if (closing && closing[1][0] === marker[0] && closing[1].length >= marker.length) break;
    }
    if (!workItem) continue;
    if (index >= lines.length) throw new Error("Unclosed pkm-work-item block.");
    let value: unknown;
    try { value = JSON.parse(markdown.slice(lines[start].index! + lines[start][0].length, lines[index].index!)); }
    catch (error) { throw new Error(`Invalid Work Item JSON: ${error instanceof Error ? error.message : String(error)}`); }
    const item = validateNoteWorkItem(value);
    if (ids.has(item.id)) throw new Error(`Duplicate Work Item ID: ${item.id}`);
    ids.add(item.id);
    result.push({ item, start:lines[start].index!, end:lines[index].index! + lines[index][0].length });
  }
  return result;
}

export function readNoteWorkItems(markdown: string): { digest: string; items: NoteWorkItem[] } {
  return { digest:noteWorkItemDigest(markdown), items:blocks(markdown).map(block => block.item) };
}

export function upsertNoteWorkItem(markdown: string, expectedDigest: string, input: unknown): string {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) || noteWorkItemDigest(markdown) !== expectedDigest) {
    throw new Error("Note changed since it was read. Reload before updating a Work Item.");
  }
  const item = validateNoteWorkItem(input);
  const existing = blocks(markdown).find(block => block.item.id === item.id);
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  // Tilde fences allow backtick code examples in JSON strings without closing the block.
  const body = JSON.stringify(item, null, 2).replace(/\n/g, newline);
  const serialized = `~~~pkm-work-item${newline}${body}${newline}~~~${newline}`;
  if (existing) return markdown.slice(0, existing.start) + serialized + markdown.slice(existing.end);
  return markdown + (markdown.endsWith(newline) ? newline : newline + newline) + serialized;
}
