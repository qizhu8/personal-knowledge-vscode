import { join } from "path";
import { apiChatGroupSnapshots } from "../chat/api-chat-store";
import { getStorePath, noteGet, noteWorkItemCommand, noteWorkItemNotes, noteWorkItemsRead } from "./filestore";
import { NoteWorkItem } from "./note-work-items";

import { todoApiDefinitions, todoDetailFields as detailFields, todoStateNames as stateNames } from "./todo-api-contract";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

// Validate the same bounded JSON schemas advertised by native and MCP tools.
function validate(value: unknown, schema: Record<string, unknown>, label: string): void {
  if (schema.type === "object") {
    const data = record(value, label);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    if (Object.keys(data).some(key=>!Object.prototype.hasOwnProperty.call(properties,key))) throw new Error(`Unknown ${label} field.`);
    for (const key of (schema.required || []) as string[]) if (data[key] === undefined) throw new Error(`${label}.${key} is required.`);
    for (const [key, entry] of Object.entries(data)) validate(entry, properties[key], `${label}.${key}`);
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > Number(schema.maxItems ?? 100)) throw new Error(`${label} must be a bounded list.`);
    value.forEach(entry=>validate(entry, schema.items as Record<string, unknown>, label));
  } else if (schema.type === "string") {
    if (typeof value !== "string" || !value.trim() || value.length > Number(schema.maxLength ?? 16000)
      || schema.pattern && !new RegExp(String(schema.pattern)).test(value)) throw new Error(`Invalid ${label}.`);
  } else if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < Number(schema.minimum ?? 0)
      || value > Number(schema.maximum ?? Number.MAX_SAFE_INTEGER)) throw new Error(`Invalid ${label}.`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`Invalid ${label}.`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`Invalid ${label}; choose ${schema.enum.join(", ")}.`);
}

function publicItem(item: NoteWorkItem, items: NoteWorkItem[]) {
  const { history, comments, ...details } = item;
  const dependencies = (item.dependsOn || []).filter(id=>{
    const dependency = items.find(candidate=>candidate.id===id);
    return !dependency || dependency.deletedAt || dependency.state!=="Done";
  });
  return { ...details, history_count:history?.length || 0, comment_count:comments?.length || 0, comments:(comments || []).slice(-20),
    status:Object.entries(stateNames).find(([,state])=>state===item.state)![0],
    actionable:!item.deletedAt && item.state==="Planning" && !item.ownerId && !item.owner && !dependencies.length,
    unfinished_dependencies:dependencies };
}
function page<T>(items: T[], args: Record<string, unknown>) {
  const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 50);
  return { items:items.slice(offset, offset+limit), total:items.length, offset, limit, next_offset:offset+limit<items.length?offset+limit:null };
}
function requireBoard(slug: string) {
  if (slug.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(slug) || slug.split("/").some(part=>!part || part==="." || part==="..")) throw new Error("Provide an exact safe Board slug.");
  if (noteGet(slug)?.documentKind !== "todo-board") throw new Error("Choose a dedicated Todo Board; legacy Markdown is not a management API.");
}

export function callTodoApi(name: string, input: unknown, actorId: string): Record<string, unknown> {
  const result = executeTodoApi(name, input, actorId);
  if (todoApiDefinitions.find(api=>api.name===name)?.readOnly && JSON.stringify(result).length > 256000) {
    throw new Error("Todo query exceeds 256 KiB. Reduce limit or query; use get_workitem and paginated list_workitem_history instead of a broad listing.");
  }
  return result;
}

function executeTodoApi(name: string, input: unknown, actorId: string): Record<string, unknown> {
  const api = todoApiDefinitions.find(api=>api.name===name);
  if (!api) throw new Error("Unknown Todo API.");
  if (JSON.stringify(input)?.length > 64000) throw new Error("Todo API input exceeds 64 KiB.");
  validate(input, api.parameters, "arguments");
  const args = record(input, "arguments");
  if (!actorId?.trim()) throw new Error("Authenticated actor identity is required.");
  if (name==="list_boards") {
    const discovery = noteWorkItemNotes(String(args.query || ""), 1000);
    if (discovery.truncated) throw new Error("Too many Boards/Notes to enumerate. Narrow query; no partial Board list returned.");
    const boards = discovery.notes.filter(note=>noteGet(note.slug)?.documentKind==="todo-board");
    return { actorId, ...page(boards, args) };
  }
  const slug = String(args.board_slug);
  requireBoard(slug);
  const snapshot = noteWorkItemsRead(slug);
  if (args.expected_digest !== undefined && args.expected_digest!==snapshot.digest) throw new Error("Todo Board changed. Reload/reconcile before continuing or paging.");
  const base = { actorId, board_slug:slug, digest:snapshot.digest };
  const live = snapshot.items.filter(item=>!item.deletedAt);
  const item = snapshot.items.find(item=>item.id===args.id);
  const projection = (entries: NoteWorkItem[])=>entries.map(entry=>publicItem(entry, snapshot.items));
  const visible = snapshot.items.filter(item=>(args.include_deleted || !item.deletedAt)
    && (!args.query || [item.id,item.title,item.goal,item.ownerId].some(value=>String(value || "").toLowerCase().includes(String(args.query).toLowerCase()))));
  if (name==="get_board") return { ...base, title:noteGet(slug)!.title, counts:{
    workitems:live.filter(item=>item.kind!=="UserStory").length, userstories:live.filter(item=>item.kind==="UserStory").length,
    deleted:snapshot.items.length-live.length, accepted:live.filter(item=>item.acceptanceDecision).length,
    ...Object.fromEntries(Object.entries(stateNames).map(([key,state])=>[key,live.filter(item=>item.kind!=="UserStory" && item.state===state).length])),
  } };
  if (name==="list_agents") {
    const chats = apiChatGroupSnapshots(join(getStorePath(), ".pkm", "state")).filter(chat=>!chat.deletedAt);
    const agents = new Map<string, { id:string; kind:string; title:string; chatUrl?:string }>();
    for (const chat of chats) agents.set(`chat:${chat.hostSessionId}`, { id:`chat:${chat.hostSessionId}`, kind:"pkm-chat", title:chat.title, chatUrl:chat.chatUrl });
    for (const id of new Set(snapshot.items.flatMap(item=>[item.ownerId, ...(item.collaboratorIds || []), ...(item.history || []).map(event=>event.actorId)]).filter((id): id is string=>!!id))) {
      if (!agents.has(id)) agents.set(id, { id, kind:id.startsWith("chat:")?"missing-chat":id.startsWith("user:")?"user":"external", title:id });
    }
    return { ...base, ...page([...agents.values()].filter(agent=>!args.query || `${agent.id} ${agent.title}`.toLowerCase().includes(String(args.query).toLowerCase())), args) };
  }
  if (name==="list_workitems") {
    const states = args.states as Array<keyof typeof stateNames> | undefined;
    return { ...base, ...page(projection(visible.filter(item=>item.kind!=="UserStory"
      && (!states || states.some(state=>stateNames[state]===item.state))
      && (!args.story_id || (args.story_id==="unassigned"?!item.parentId:item.parentId===args.story_id))
      && (!args.owner_id || item.ownerId===args.owner_id)
      && (!args.unassigned || !item.ownerId && !item.owner)
      && (!args.actionable || publicItem(item,snapshot.items).actionable))), args) };
  }
  if (name==="list_userstories") return { ...base, ...page(projection(visible.filter(item=>item.kind==="UserStory")).map(story=>({
    ...story, child_count:live.filter(child=>child.parentId===story.id).length,
  })), args) };
  if (name==="list_board_changes") {
    if (args.since && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(String(args.since)) || !Number.isFinite(Date.parse(String(args.since)))
      || new Date(String(args.since)).toISOString().slice(0,19)!==String(args.since).slice(0,19))) throw new Error("since must be a valid UTC timestamp.");
    const changes = snapshot.items.flatMap(item=>(item.history || []).map((event,index)=>({ ...event, item_id:item.id, event_id:`${item.id}:${index}` })))
      .filter(event=>!args.since || Date.parse(event.at)>=Date.parse(String(args.since))).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.event_id.localeCompare(b.event_id));
    return { ...base, ...page(changes, args) };
  }
  if (name.startsWith("add_") && name!=="add_workitem_comment") {
    const supplied = record(args.item, "item");
    const story = name==="add_userstory";
    if (!story && supplied.storyStatus!==undefined || story && supplied.parentId!==undefined) throw new Error("Only tasks take parentId; only Stories take storyStatus.");
    return mutate({ action:"create", item:{ ...supplied, kind:story?"UserStory":"Task", state:"Planning", evidence:[] } });
  }
  if (!item) throw new Error("Work Item/User Story not found.");
  const storyApi = name.endsWith("userstory") || name==="change_userstory_state";
  const generic = ["list_workitem_history", "add_workitem_comment"].includes(name);
  if (!generic && (item.kind==="UserStory")!==storyApi) throw new Error(`Use the ${item.kind==="UserStory"?"User Story":"Work Item"} API for this record.`);
  if (name==="list_workitem_history") return { ...base, ...page(item.history || [], args) };
  if (item.deletedAt && !name.startsWith("restore_") && !(api.readOnly && args.include_deleted)) throw new Error("Record is deleted; use restore or include_deleted to inspect it.");
  if (name==="get_workitem") return { ...base, item:publicItem(item,snapshot.items) };
  if (name==="get_userstory") return { ...base, story:publicItem(item,snapshot.items), children:page(projection(visible.filter(child=>child.parentId===item.id)), args) };
  if (name.startsWith("update_") || name==="move_workitem") {
    const next = structuredClone(item);
    const fields = name==="move_workitem"?{ parentId:args.story_id }:record(args.patch, "patch");
    const allowed = [...detailFields, ...(storyApi?["storyStatus"]:[])];
    if (name!=="move_workitem" && Object.keys(fields).some(field=>!allowed.includes(field))) throw new Error("Use a dedicated operation for parent, ownership, state, result or audit.");
    for (const field of (args.clear_fields || []) as string[]) {
      if (!["projectId", "dependsOn", "plannedStart", "plannedEnd", "links", "description", "icon", "collaboratorIds", "monitoring"].includes(field) || fields[field]!==undefined) throw new Error("clear_fields only removes optional metadata not present in patch.");
      delete next[field as "projectId" | "dependsOn" | "plannedStart" | "plannedEnd" | "links" | "description" | "icon" | "collaboratorIds" | "monitoring"];
    }
    const merged = { ...next, ...fields };
    if (name==="move_workitem" && args.story_id===undefined) delete merged.parentId;
    return mutate({ action:"edit", item:merged, reason:args.reason });
  }
  if (name.startsWith("delete_") || name.startsWith("restore_") || name.startsWith("reopen_") || name.startsWith("accept_") || name==="release_workitem") {
    return mutate({ action:name.split("_")[0], id:item.id, reason:args.reason });
  }
  if (name==="add_workitem_comment") return mutate({ action:"comment", id:item.id, text:args.text });
  if (name==="assign_workitem") {
    if (!/^(?:chat:[a-f0-9-]{36}|external:(?:copilot|claude|other):[a-zA-Z0-9_-]{1,80}|mcp:external|user:local)$/.test(String(args.owner_id))) throw new Error("Choose a stable PKM Chat or external Agent identity from list_agents, or external:copilot/claude/other:<id>.");
    if (String(args.owner_id).startsWith("chat:") && !apiChatGroupSnapshots(join(getStorePath(),".pkm","state")).some(chat=>!chat.deletedAt && `chat:${chat.hostSessionId}`===args.owner_id)) throw new Error("Assigned PKM Chat no longer exists.");
    return mutate({ action:"assign", id:item.id, ownerId:args.owner_id, reason:args.reason });
  }
  const target = name==="submit_workitem_result"?"Done":args.state ? stateNames[args.state as keyof typeof stateNames] : undefined;
  if ((name==="claim_workitem" || target==="WIP") && publicItem(item,snapshot.items).unfinished_dependencies.length) throw new Error("Unfinished dependencies block starting this record.");
  if (name==="claim_workitem" || name==="change_userstory_state" && target==="WIP") return mutate({ action:"claim", id:item.id });
  if (name==="submit_workitem_result" || name.startsWith("change_")) {
    if (args.verification!==undefined && target!=="Done") throw new Error("Verification reports belong to result submission.");
    return mutate({ action:"transition", id:item.id, state:target, ...(args.blocked_reason!==undefined?{ blockedReason:args.blocked_reason }:{}),
      ...(args.reason!==undefined?{ reason:args.reason }:{}),
      ...(args.outcome!==undefined?{ outcome:args.outcome }:{}), ...(args.evidence!==undefined?{ evidence:args.evidence }:{}),
      ...(args.verification!==undefined?{ verification:args.verification }:{}) });
  }
  throw new Error("Unsupported Todo operation.");

  function mutate(command: unknown): Record<string, unknown> {
    const updated = noteWorkItemCommand(slug, String(args.expected_digest), command, { id:actorId, role:"board-agent" });
    const id = args.id || record(args.item, "item").id;
    return { actorId, board_slug:slug, digest:updated.digest, item:publicItem(updated.items.find(item=>item.id===id)!, updated.items) };
  }
}
