export const todoStateNames = { todo:"Planning", active:"WIP", blocked:"Blocked", "on-hold":"OnHold", completed:"Done" } as const;
export const todoDetailFields = ["title", "goal", "scope", "acceptance", "projectId", "dependsOn", "plannedStart", "plannedEnd", "links"];
const string = { type:"string", minLength:1, maxLength:1024 };
const paging = { offset:{ type:"integer", minimum:0 }, limit:{ type:"integer", minimum:1, maximum:100 } };
const board = { board_slug:string };
const identity = { ...board, id:string };
const version = { expected_digest:{ type:"string", pattern:"^[a-f0-9]{64}$" } };
const reason = { reason:{ type:"string", minLength:1, maxLength:8000 } };
const filters = { include_deleted:{ type:"boolean" }, query:string };
const strings = { type:"array", items:{ type:"string", minLength:1 }, maxItems:100 };
const details = {
  title:string, goal:{ type:"string", minLength:1, maxLength:16000 }, scope:{ type:"string", minLength:1, maxLength:16000 },
  acceptance:strings, projectId:string, dependsOn:strings, plannedStart:string, plannedEnd:string, links:strings,
};
const patch = { type:"object", properties:{ ...details, storyStatus:{ type:"string", enum:["draft", "confirmed"] } }, additionalProperties:false };
const newItem = { type:"object", properties:{ id:string, ...details, parentId:string, storyStatus:{ type:"string", enum:["draft", "confirmed"] } },
  required:["id", "title", "goal", "scope", "acceptance"], additionalProperties:false };
const state = { type:"string", enum:Object.keys(todoStateNames) };
const resultFields = { outcome:{ type:"string", enum:["Success", "Failed", "Unsure"] }, evidence:strings,
  verification:{ type:"array", maxItems:3, items:{ type:"object", properties:{
    layer:{ type:"string", enum:["unit", "functional", "e2e"] }, status:{ type:"string", enum:["passed", "failed", "not-run", "not-applicable"] },
    evidence:strings, reason:string,
  }, required:["layer", "status", "evidence"], additionalProperties:false } } };

function definition(name: string, readOnly: boolean, description: string, properties: Record<string, unknown>, required: string[]) {
  return { name, readOnly, description: `${description} ${readOnly ? "Reads never claim work." : "Use the last read expected_digest; conflicts require reload/reconcile. Audit identity is authenticated, never supplied. Never edit backing files."}`,
    parameters:{ type:"object", properties, required, additionalProperties:false } };
}
const writeIdentity = { ...identity, ...version };
const writeRequired = ["board_slug", "id", "expected_digest"];

export const todoApiDefinitions = [
  definition("list_boards", true, "Discover dedicated Todo Boards; paginated, excludes legacy Markdown Notes.", { query:string, ...paging }, []),
  definition("get_board", true, "Read Board identity, digest and live state/acceptance counts.", board, ["board_slug"]),
  definition("list_workitems", true, "List tasks by todo/active/blocked/on-hold/completed, User Story, owner, unassigned or actionable; exclude deleted by default.", {
    ...board, ...paging, ...filters, states:{ type:"array", items:state, maxItems:5 }, story_id:string, owner_id:string,
    unassigned:{ type:"boolean" }, actionable:{ type:"boolean" }, ...version,
  }, ["board_slug"]),
  definition("get_workitem", true, "Read one task's contract, dependencies, owner, result and audit.", { ...identity, include_deleted:{ type:"boolean" } }, ["board_slug", "id"]),
  definition("list_userstories", true, "List User Stories with state and child counts.", { ...board, ...paging, ...filters, ...version }, ["board_slug"]),
  definition("get_userstory", true, "Read Story high-level contract and paginated children, including completed tasks.", { ...identity, ...paging, include_deleted:{ type:"boolean" } }, ["board_slug", "id"]),
  definition("list_agents", true, "List actual PKM Chat names/IDs/URLs and recorded external owner IDs for this Board; assignment starts no Agent.", { ...board, ...paging, query:string }, ["board_slug"]),
  definition("add_workitem", false, "Create a Planning task. item contains id/title/goal/scope/acceptance and optional parentId/schedule/dependencies.", { ...board, ...version, item:newItem }, ["board_slug", "expected_digest", "item"]),
  definition("update_workitem", false, "Patch task contract/schedule/dependencies. clear_fields removes optional metadata; state/owner/audit use dedicated APIs. reason is required.", { ...writeIdentity, patch, clear_fields:strings, ...reason }, [...writeRequired, "patch", "reason"]),
  definition("delete_workitem", false, "Soft-delete task with reason; reject live dependent references. Audit remains.", { ...writeIdentity, ...reason }, [...writeRequired, "reason"]),
  definition("restore_workitem", false, "Restore deleted task with reason; parent and dependencies must be live.", { ...writeIdentity, ...reason }, [...writeRequired, "reason"]),
  definition("move_workitem", false, "Change parent Story; omit story_id to move to Unassigned. State/owner preserved.", { ...writeIdentity, story_id:string, ...reason }, [...writeRequired, "reason"]),
  definition("add_userstory", false, "Create an independent Planning User Story contract.", { ...board, ...version, item:newItem }, ["board_slug", "expected_digest", "item"]),
  definition("update_userstory", false, "Patch Story contract/schedule; no ownership, lifecycle, reviewer or audit overrides.", { ...writeIdentity, patch, clear_fields:strings, ...reason }, [...writeRequired, "patch", "reason"]),
  definition("delete_userstory", false, "Soft-delete Story with reason; reject live children or dependents.", { ...writeIdentity, ...reason }, [...writeRequired, "reason"]),
  definition("restore_userstory", false, "Restore soft-deleted Story without restoring children automatically.", { ...writeIdentity, ...reason }, [...writeRequired, "reason"]),
  definition("claim_workitem", false, "Atomically take an unassigned/self-owned task as the authenticated Agent and move to active. Reject unfinished dependencies. Only one Active task per Agent across all Boards. WORKITEM_FOCUS_CONFLICT requires explicitly holding/completing current work or deferring new work; never automatically switch.", writeIdentity, writeRequired),
  definition("assign_workitem", false, "Assign a task to a stable Agent ID. Assignment is metadata, not execution or acceptance delegation.", { ...writeIdentity, owner_id:string, ...reason }, [...writeRequired, "owner_id", "reason"]),
  definition("release_workitem", false, "Current owner releases task back to todo; reason required.", { ...writeIdentity, ...reason }, [...writeRequired, "reason"]),
  definition("change_workitem_state", false, "Current owner changes task state. on-hold requires reason and retains ownership; blocked needs blocked_reason; completed needs outcome/evidence. Resuming active enforces one Active task across all Boards. Reopen completed tasks explicitly.", {
    ...writeIdentity, state, ...reason, blocked_reason:string, ...resultFields,
  }, [...writeRequired, "state"]),
  definition("submit_workitem_result", false, "Current owner submits outcome, evidence and optional verification reports atomically; completes but never accepts.", { ...writeIdentity, ...resultFields }, [...writeRequired, "outcome", "evidence"]),
  definition("accept_workitem", false, "Explicitly delegated reviewer accepts completed task with evidence and reason; ordinary Agents cannot self-approve.", { ...writeIdentity, ...reason }, [...writeRequired, "reason"]),
  definition("reopen_workitem", false, "Reopen completed task with reason; clear acceptance/outcome, preserve audit/evidence.", { ...writeIdentity, ...reason }, [...writeRequired, "reason"]),
  definition("reopen_userstory", false, "Reopen a completed Story before reopening or adding its children; reason required.", { ...writeIdentity, ...reason }, [...writeRequired, "reason"]),
  definition("change_userstory_state", false, "Change Story state independently; active claims it, on-hold requires reason, completed requires all live children accepted plus outcome/evidence. Story state does not consume task focus.", { ...writeIdentity, state, ...reason, blocked_reason:string, ...resultFields }, [...writeRequired, "state"]),
  definition("accept_userstory", false, "Explicitly delegated reviewer accepts a completed Story; never inferred from child counts.", { ...writeIdentity, ...reason }, [...writeRequired, "reason"]),
  definition("add_workitem_comment", false, "Append progress/handoff comment with authenticated actor and server timestamp.", { ...writeIdentity, text:{ type:"string", minLength:1, maxLength:8000 } }, [...writeRequired, "text"]),
  definition("list_workitem_history", true, "Paginated audit history for a task or Story, including soft-deleted records.", { ...identity, ...paging, ...version }, ["board_slug", "id"]),
  definition("list_board_changes", true, "Paginated Board audit events, including deletions, with stable item/event IDs. since is inclusive UTC timestamp; pin digest when paging.", { ...board, ...paging, since:string, ...version }, ["board_slug"]),
];
export const todoReadApiNames = todoApiDefinitions.filter(api=>api.readOnly).map(api=>api.name);
