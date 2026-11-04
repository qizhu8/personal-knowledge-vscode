import { ApiChatTool } from "./api-chat-client";
import { noteWorkItemCommand, noteWorkItemNotes, noteWorkItemsRead } from "../knowledge/filestore";
import { callTodoApi } from "../knowledge/todo-api";
import { todoApiDefinitions } from "../knowledge/todo-api-contract";

export function createNoteTodoTools(options: {
  actorId: string;
  assertActive: () => void;
  approve: (write: boolean, detail: string, signal: AbortSignal) => Promise<boolean>;
}): ApiChatTool[] {
  const authorize = async (write: boolean, detail: string, signal: AbortSignal) => {
    options.assertActive();
    if (signal.aborted) throw new Error("Request cancelled.");
    if (!await options.approve(write, detail, signal)) throw new Error("Note Work Item access declined.");
    options.assertActive();
    if (signal.aborted) throw new Error("Request cancelled before accessing Work Items.");
  };
  const slug = (value: unknown) => {
    if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Provide an exact bounded Note slug.");
    return value;
  };
  return [{
    name: "note_todo_read",
    description: "Read authoritative Todo Board Work Items (or legacy Note blocks) and CAS digest, or discover Boards/Notes using query/limit. Todo Board task data is separate from Markdown: never edit Markdown to update a Board. kind:'UserStory' identifies parent stories; tasks reference a same-Note story with parentId. Missing kind means legacy Task. storyStatus marks draft/confirmed definitions; it is not execution state. No checklist migration. Returns this Chat's stable worker actorId. Plan mode is read-only. Done/outcome is separate from acceptance and managed Task completion. Workers cannot create or reparent User Stories; ask the user to define that contract.",
    parameters: { type: "object", properties: {
      slug: { type: "string", maxLength: 1024 }, query: { type: "string", maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 100 },
    }, additionalProperties: false },
    execute: async (args, signal) => {
      if (args.slug !== undefined) {
        const identity = slug(args.slug);
        if (args.query !== undefined || args.limit !== undefined) throw new Error("Use either slug or discovery query/limit.");
        await authorize(false, `Read Work Items in Note ${identity}`, signal);
        const snapshot = noteWorkItemsRead(identity);
        const result = JSON.stringify({ actorId: options.actorId, slug: identity, ...snapshot });
        if (result.length > 100000) throw new Error("This Note's Work Items exceed the tool output limit. Split the Note explicitly; no partial digest or items were returned.");
        return result;
      }
      if (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 200)) throw new Error("Provide a discovery query of at most 200 characters.");
      const limit = args.limit ?? 20;
      if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error("Discovery limit must be from 1 to 100.");
      await authorize(false, "Discover Notes containing explicit Work Items", signal);
      return JSON.stringify({ actorId: options.actorId, ...noteWorkItemNotes(String(args.query || ""), Number(limit)) });
    },
  }, {
    name: "note_todo_update",
    description: "Compatibility restrictive worker command; prefer named Todo Board APIs for contract/Story management and soft-delete/restore. Never edit backing JSON or Markdown directly. Explicit CAS Work Item command. Read first; use exact expectedDigest. Reading does not claim: explicitly claim to take work. Worker identity is this Chat, never caller supplied. command: create/edit {item,reason?}; claim/release/accept/reopen {id,reason?}; transition {id,state,reason?,blockedReason?,outcome?,evidence?}. New item fields: id,title,goal,scope (strings), acceptance (string[]), state:'Planning', evidence:[]; no owner or audit on create. Preserve fields when editing. States Planning/WIP/Blocked/OnHold/Done; outcomes Success/Failed/Unsure. OnHold needs reason and retains ownership. Board claims/resumes enforce one Active task per Agent across all Boards; resolve WORKITEM_FOCUS_CONFLICT explicitly, never automatically suspend/complete old work. Claim is atomic. This legacy endpoint cannot change contracts, assignments or schedules, or accept without explicit reviewer delegation. Done needs outcome and evidence, not automatic acceptance. Release/reopen need reason. No model loop, remote execution or managed Task completion.",
    parameters: { type: "object", properties: {
      slug: { type: "string", maxLength: 1024 }, expectedDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      command: { type: "object", properties: {
        action: { type: "string", enum: ["create", "edit", "claim", "release", "accept", "reopen", "transition"] },
        id: { type: "string" }, item: { type: "object" }, reason: { type: "string" },
        state: { type: "string", enum: ["Planning", "WIP", "Blocked", "OnHold", "Done"] },
        blockedReason: { type: "string" }, outcome: { type: "string", enum: ["Success", "Failed", "Unsure"] }, evidence: { type: "array", items: { type: "string" } },
      }, required: ["action"], additionalProperties: false },
    }, required: ["slug", "expectedDigest", "command"], additionalProperties: false },
    execute: async (args, signal) => {
      const identity = slug(args.slug);
      if (typeof args.expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(args.expectedDigest)) throw new Error("Read the Note and provide its exact digest.");
      if (!args.command || typeof args.command !== "object" || Array.isArray(args.command) || JSON.stringify(args.command).length > 64000) throw new Error("Provide a bounded Work Item command.");
      await authorize(true, `Update Note ${identity}\nActor: ${options.actorId}\nDigest: ${args.expectedDigest}\n${JSON.stringify(args.command)}`, signal);
      return JSON.stringify({ actorId: options.actorId, slug: identity,
        ...noteWorkItemCommand(identity, args.expectedDigest, args.command, { id: options.actorId, role: "worker" }) });
    },
  }, ...todoApiDefinitions.map(api=>({
    name:api.name, description:api.description, parameters:api.parameters,
    execute:async (args: Record<string, unknown>, signal: AbortSignal) => {
      if (JSON.stringify(args).length > 64000) throw new Error("Todo API input exceeds 64 KiB.");
      await authorize(!api.readOnly, `${api.name}\nActor: ${options.actorId}\n${JSON.stringify(args)}`, signal);
      return JSON.stringify(callTodoApi(api.name, args, options.actorId));
    },
  }))];
}
