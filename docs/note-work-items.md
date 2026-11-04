# Todo Boards and shared Work Item lifecycle

## Document types and authority

Creating a Note offers **Markdown** or **Todo Board**. Markdown stays free-form;
checkboxes are not managed tasks. A Todo Board is a separate document type in
the Notes tree, with its own Table / Story Board / Timeline UI and no Markdown
editing tab. It does not create Projects or start Agents.

The Board's authoritative document is `<Title>.assets/pkm-todo-board.json`
(`pkm.todo-board/v1`). Its Markdown descriptor carries `documentKind: todo-board`
and ordinary Note identity/metadata, not live tasks. Generic Markdown writes,
Note content edits, low-level item upserts and asset uploads cannot replace Board
authority. Only lifecycle commands mutate tasks. Directly editing the descriptor,
even pasting task blocks into it, does not change Board items or their CAS digest.
Missing or corrupt Board data is an explicit error, never a fallback to Markdown.
The existing companion-resource lifecycle moves Board authority with rename,
folder moves, Trash and restore. Explicit JSON export/import includes Board items
and audit records, but excludes external worker grants.

Existing fenced Markdown Work Items remain **legacy** and readable/editable with
their previous lifecycle. **Convert to Todo Board** previews the Story/task counts
and asks for explicit confirmation; application rechecks the full source digest.
It preserves IDs, parent relationships, states, evidence and recorded history,
retaining the original Markdown as historical source only. No automatic migration
or inferred completion occurs.

This is an application-level accidental-edit safeguard, not OS access control:
someone with filesystem write access can still modify backing JSON. Reviewed
snapshot recovery and Git sync remain privileged file-level operations.

## Legacy Markdown encoding

~~~~markdown
~~~pkm-work-item
{
  "id": "verify-health",
  "title": "Verify health endpoint",
  "goal": "Return the documented health response",
  "scope": "GET /health",
  "acceptance": ["HTTP 200 and exact expected JSON"],
  "state": "Planning",
  "evidence": []
}
~~~
~~~~

IDs are unique within a Note: letters, numbers, `_`, `-`, maximum 80 characters,
starting with a letter or number. All required text is nonempty. Unknown fields,
malformed JSON, duplicate IDs and invalid nested records are explicit errors.
Example blocks inside larger fences and frontmatter are not Work Items.
Only the selected item's block is serialized; unrelated Markdown and other
blocks retain their exact bytes, including CRLF.

## Fields

Required: `id`, `title`, `goal`, `scope`, nonempty string-array `acceptance`,
`state`, and string-array `evidence`.

Optional:

- `kind`: `Task` (also the default when absent) or `UserStory`. Stories use the
  same goal/scope/acceptance/evidence contract and explicit lifecycle, not another
  database. `storyStatus`: `draft` or `confirmed` describes a Story definition,
  independently of execution state. Missing status is shown as draft.
- `parentId`: Task's parent User Story ID in this Note. Command writes reject
  missing/non-Story parents, nested Stories and contradictory explicit Projects.
  Users define Stories and parent links; workers cannot create or change them.
  A Story cannot report Done until all children are Done and explicitly accepted;
  it still needs its own outcome/evidence and independent acceptance. Reopen a
  closed Story before reopening a child. No automatic completion rollup.
- `owner`: display label; `ownerId`: stable actor identity, used for command ownership.
  A legacy owner label alone is not silently mapped to an actor. A user must
  explicitly assign/clear it before a worker can claim.
- `projectId`: explicit user-set existing Project ID, never assigned automatically.
  Storage records the reference; it does not resolve or validate a Project catalog.
- `reviewerIds`: user-set stable actor IDs explicitly delegated to review/accept.
- `dependsOn`: unique local item IDs. Command writes validate the whole Note's
  dependency graph and reject missing IDs, self-dependencies and cycles.
- `plannedStart`, `plannedEnd`: both required together, real calendar dates in
  `YYYY-MM-DD`, with end on or after start. This is metadata, not a scheduler.
- `links`: nonempty string references to Recipe/Action/Chat/Memory/Snapshot or
  other evidence. References do not execute, resolve or grant permissions.
- `verification`: records `{layer, status, evidence, reason?}`. Layers: `unit`,
  `functional`, `e2e`. Statuses: `passed`, `failed`, `not-run`, `not-applicable`.
  Passed/failed reports require evidence; not-applicable requires a reason.
  These are reported results, not independently verified test execution.
- `blockedReason`: required for Blocked.
- `outcome`: `Success`, `Failed`, `Unsure`; required for Done and forbidden otherwise.
  Done also requires evidence.
- `history`: generated records `{at, actorId, action, from?, to?, reason?}`.
  UTC ISO timestamps and explicit transitions are stored inside the same block.
- `acceptanceDecision`: generated `{by, at, decision:"accepted"}`; only valid on Done.

Legacy items without optional fields remain readable without inferred ownership,
history or acceptance. Their first command adds only that command's history entry.

## Backend contract

```ts
type WorkItemActor = { id: string; role: "user" | "worker" };
type WorkItemCommand =
  | { action: "create" | "edit"; item: NoteWorkItem; reason?: string }
  | { action: "claim" | "release" | "accept" | "reopen"; id: string; reason?: string }
  | { action: "transition"; id: string; state: "Planning" | "WIP" | "Blocked" | "OnHold" | "Done";
      reason?: string; blockedReason?: string; outcome?: "Success" | "Failed" | "Unsure"; evidence?: string[] };
```

Types are exported from `src/knowledge/note-work-items.ts`. Filestore exports:

- `noteWorkItemsRead(slug)` → `{digest, items}`, dispatching to Board JSON or
  legacy Markdown without changing the response shape.
- `noteWorkItemCommand(slug, expectedDigest, command: unknown, actor)` →
  `{digest, items}`. Runtime validation rejects malformed commands/actors and
  unexpected command keys. Actor identity must come from the trusted integration,
  never from model-supplied command JSON.
- `noteWorkItemNotes(query = "", limit = 20)` →
  `{notes: [{slug, title, count, digest?, error?}], truncated: boolean}`.
  Limits are integers 1–1000. Query matches Note slug/title/description,
  case-insensitively. Discovery derives from `noteList`, reads candidates on
  request, and returns only Notes containing explicit items or explicit read/
  malformed-block errors (`count: 0`, `error`). Empty Notes and plain checklists
  are omitted. Results retain Note updated-time order; `truncated` means another
  matching entry exists. Output is bounded; finding results may inspect every
  candidate Note. There is no background polling or index.
- `noteWorkItemUpsert` remains a low-level complete-item/manual user-equivalent
  compatibility API. It validates individual fields and CAS, but intentionally
  bypasses lifecycle role/history and dependency-graph conventions. New UI and
  native Chat integrations must use commands, not this escape hatch.

### Commands and roles

- **create**: new Planning item. No supplied history/acceptance. A user may set
  ownership, project, reviewers, schedule and criteria. A worker creates unowned
  Planning only, without `projectId` or `reviewerIds`, then explicitly claims.
- **edit**: preserves generated history/decision. Done items
  must be reopened first. Users can change ownership, project, reviewers, criteria,
  dependencies and schedule, and report state/outcome with validated evidence;
  this does not accept work. Workers edit only their own nonterminal items;
  title/goal/scope/criteria/owner/ownerId/project/reviewers/dependencies/schedule
  and state/outcome are protected. Evidence, blockedReason, links and verification
  can be updated; workers use transition to report state/outcome.
  User draft audit fields are ignored in favor of authoritative stored history/
  decision (including after a reload); workers supplying changed audit fields
  are rejected. Only explicit accept/reopen commands change acceptance decisions.
- **claim**: atomically claims an unowned nonterminal item (or the same actor's
  existing item), sets `ownerId` and `owner` to the actor ID and state to WIP.
  Another owner's claim is rejected.
- **transition**: only the owner, nonterminal only. Blocked needs a reason.
  Done needs explicit outcome plus evidence (existing or supplied). Supplied
  evidence is merged, preserving prior evidence. Done **does not mean accepted**.
- **release**: only the owner, nonterminal, mandatory reason. Clears ownership
  and blockedReason, returns to Planning.
- **accept**: Done with evidence and mandatory reason. Only a user or an actor
  named in user-set `reviewerIds`; being owner/worker/lead does not by itself
  grant acceptance. Records explicit decision and history. Repeated acceptance
  is rejected. Success is not inferred or required: the reviewer judges the
  explicitly reported outcome/evidence.
- **reopen**: user only, Done only, mandatory reason. Returns to Planning,
  clears decision/outcome/blockedReason, preserves ownership, evidence and history.

Each command checks the authoritative document's SHA-256 digest (Board JSON or
legacy Markdown) and applies validation, history, and persistence under the
existing shared mutation lock. Board writes use atomic replacement. Competing
claims with the same digest have exactly one winner. A stale digest reports
`Note changed`; reload and reconcile rather than blindly retrying.
System Notes remain read-only for updates. Existing Note resource/Trash/move
lifecycle is reused.

## Note and Project UI

Markdown Notes open in **Markdown** by default; dedicated Boards open in **Board**.
Explicit **Todo Table**, **Board** and
**Timeline** tabs display the Note's structured Work Items without converting
plain checkboxes or migrating real Notes.

Use **New Work Item** or **Details / Edit** to set the contract (title, goal,
scope and acceptance criteria), owner label and stable owner ID, existing
`projectId`, delegated `reviewerIds`, dependencies, paired planned dates,
evidence and unit/functional/e2e verification reports. Reporting **Done** remains
separate from **Accept**; **Reopen** requires an explicit reason.

After a digest/CAS conflict, use explicit **Reload** to obtain the current
persisted record for comparison. Reload retains the local draft; reconcile it
with that record before saving rather than blindly retrying.

Under **Project > Gantt**, **Load / refresh Note timeline** aggregates explicit
Work Items whose `projectId` matches the Project, separating planned dates from
recorded state-history intervals.

**Board** is a User Story taskboard: each Story has a left-hand parent card and
one swimlane row, with its child cards in Planning / WIP / Blocked / On hold / Done columns.
Story and task cards omit the inline contract/evidence/history section; double-click a
Work Item title to open its details, including in the read-only browser view.
Opening a User Story shows its title, problem/user value (goal), scope and
acceptance criteria, followed by a Gantt of only its child Work Items, including
closed children. Planned dates and recorded state intervals remain separate;
unscheduled children are explicit. Double-click child titles for details, or use
**Edit User Story** to change the Story contract in editable views.
Unlinked legacy tasks remain in an explicit Unassigned row. In editable All stories,
the Unassigned row remains a drop target even when empty. Expand/collapse each row or
all rows. The **Completed** column and completed items are visible by default;
**Show completed** can hide them. Completed projects the existing Done state,
not acceptance or a new lifecycle state. The Story column stays 230px wide;
status columns share remaining width equally with a 220px minimum and
horizontal scrolling on narrow screens. **+ New User Story** beside the
Board grouping (in the toolbar for Table / Timeline) defines the user-value contract,
including on an empty Board. **+ Work Item** creates a child, and the task editor
can assign its parent. No tasks are converted into Stories or automatically linked.
Table cards show their parent; the Story filter narrows all three views.
Draft migration groupings are not confirmed user requirements.

Drag an active Task onto a Story's left-hand header/card area, including a
collapsed Story, to change only its parent. Drop onto **Unassigned Work Items** to
remove the parent. Classification preserves state, owner, blocked reason,
evidence and other metadata; it sends one explicit edit with the current CAS
digest and an audit reason. Same-parent drops are no-ops. Done items still require
explicit Reopen before moving. State-cell drops retain their separate state
transition behavior and Blocked/On hold/Done editor guards. The Parent User Story field
in Details / Edit provides a keyboard alternative.

**View in Browser** supports the same Table, Story Board and Timeline for Notes
containing explicit Work Items, with Markdown available as a fourth tab only for
legacy Notes. Dedicated Boards expose only Table / Board / Timeline. It uses
the shared renderer. Opening a dedicated Board locally uses the authenticated
private preview with user management commands, even when the Board is public.
Commands require the preview cookie, a same-origin JSON request, a custom header,
a trusted workspace and an editable Board path; mutations reuse digest/CAS and
the same user command validation as the panel. Public gateway pages, exports,
legacy Note browser views and System Notes remain read-only. No public write
endpoint or Agent permission grant is added. Reload from Note refreshes the
authorized snapshot and retains the selected tab. Interactive progress pages do not
auto-reload in the background, avoiding focus/filter/expanded-row resets; reload
explicitly for the latest data. Ordinary Notes retain their Markdown-only reader.
Existing public/private gateway authorization and navigation boundaries apply.
This is an on-request metadata
projection, not computed execution progress, scheduling or proof of completion.

## Native Chat boundary

Native `note_todo_read` and `note_todo_update` use the stable worker actor
`chat:<id>`. Updates require trusted permission; read-only and Plan contexts
remain read-only, and Portal writes are denied. Ownership, protected fields and
explicit reviewer delegation still follow the shared lifecycle rules.
These tools dispatch to Board JSON or legacy Markdown according to document
type. They do not start Agent execution or migrate real Notes.
The named Board APIs below are also available as native tools under the same
Chat permission and Plan/Portal gates. Their Board management policy is broader
than the compatibility `note_todo_update` worker policy.

## Named Todo Board APIs

All Agents with the configured Board MCP access can use these management APIs
to maintain task and Story contracts, assignment, grouping and soft deletion.
This does **not** make them users: acceptance reviewer delegation and external
worker-token issuance remain user-only. Ordinary Agent access cannot accept
results without explicit user delegation. Legacy Markdown Notes are not accepted
by these management APIs.

| Category | APIs |
|---|---|
| Discovery and queries | `list_boards`, `get_board`, `list_workitems`, `get_workitem`, `list_userstories`, `get_userstory`, `list_agents` |
| Work Item maintenance | `add_workitem`, `update_workitem`, `delete_workitem`, `restore_workitem`, `move_workitem` |
| Story maintenance | `add_userstory`, `update_userstory`, `delete_userstory`, `restore_userstory` |
| Assignment and execution | `claim_workitem`, `assign_workitem`, `release_workitem`, `change_workitem_state` |
| Results and acceptance | `submit_workitem_result`, `accept_workitem`, `reopen_workitem`, `change_userstory_state`, `accept_userstory`, `reopen_userstory` |
| Collaboration and audit | `add_workitem_comment`, `list_workitem_history`, `list_board_changes` |

### Common contract

- Board-scoped APIs require `board_slug`; mutations also require the last read
  `expected_digest`. Every mutation atomically checks that digest under the same
  cross-process lock, validates the graph and persists the audited result.
  Conflict errors require explicit reload/reconciliation, not automatic retry.
- MCP Board calls optionally take `worker_token`; without one the identity is
  `mcp:external`. Tokens resolve a real distinct external identity. Native tools
  use the calling `chat:<id>`; no API accepts a caller role/audit override.
- Public API states are `todo` = Planning, `active` = WIP, `blocked` = Blocked,
  `on-hold` = OnHold, `completed` = Done. Responses retain `state` and add public `status`.
- `list_workitems` filters by `states`, `story_id` (`unassigned` for no parent),
  `owner_id`, `unassigned`, `actionable`, `query` and `include_deleted`.
  Actionable means live unassigned Planning work with completed dependencies;
  it does not grant permission, start execution or schedule an Agent.
- Lists use `offset`, `limit` (default 50, maximum 100), `total` and `next_offset`.
  Task/Story/history/change lists accept `expected_digest` to pin pagination.
  `get_userstory` has paginated `children`; these include completed tasks.
  Reads never claim work. Input is bounded to 64 KiB; read results above 256 KiB
  fail explicitly with narrowing guidance rather than silently truncating.
- `add_workitem` / `add_userstory` take an `item` with
  `id,title,goal,scope,acceptance`. Creation is always Planning without generated
  audit/acceptance. Tasks can specify `parentId`; Stories cannot.
- `update_*` takes a partial `patch` and `reason`; optional `clear_fields`
  removes project/schedule/dependency/link metadata. Identity, type, parent,
  owner, lifecycle, result, reviewer delegation, deletion and audit cannot be
  patched. Use dedicated operations for these supported changes. Reopen
  completed work before editing its contract.
- `claim_workitem` atomically assigns the authenticated caller and moves it to
  active; competing owners and unfinished dependencies are rejected.
  `change_workitem_state`, result submission and release require ownership.
  Blocked needs `blocked_reason`; completion needs explicit `outcome`
  (Success/Failed/Unsure) and evidence. `submit_workitem_result` can also submit
  unit/functional/e2e verification reports atomically. Completion is not acceptance.
- Each stable Agent identity can start only one Active task across **all dedicated
  Todo Boards in the current knowledge root**. The check and write share the
  cross-process lock, including compatibility Board claims/resumes, active
  reassignment, restoration and user edits. Reads never claim. User Story state
  is independent and does not occupy task focus; Blocked, On hold, Planning,
  deleted and Done tasks do not occupy focus. Existing multiple Active tasks
  are not silently changed, but new starts are rejected until reconciled.
- A second start fails without modifying either Board, with
  `WORKITEM_FOCUS_CONFLICT` and JSON error details: `confirmation_required`,
  `action_taken:false`, `actor_id`, `target`, `active_workitem_count`,
  `active_workitems` (up to 20, including Board slug, ID, title and read digest)
  and three choices. The Agent must explicitly:
  1. Put current work on hold using `change_workitem_state(state="on-hold",
     reason="...")`; ownership/evidence are retained and the reason is audited.
  2. Submit the real outcome/evidence of finished current work using
     `submit_workitem_result`; this does not accept it.
  3. Continue current work and defer the new task, without mutating either.
  After resolving current work, reload the target Board and explicitly retry
  its claim. Resuming On hold is checked again. No confirmation flag bypasses
  the invariant and no API automatically parks/completes another task.
- Focus follows the **authenticated stable identity**, not a model/provider name.
  Give the same external Agent the same stable ID on different Boards (with
  Board-specific worker tokens); different Agents need distinct IDs. Untokened
  callers share `mcp:external` and therefore share one focus slot. Legacy
  Markdown, other knowledge roots and direct OS filesystem writes are outside
  this Board-level guarantee. A malformed Board fails the check explicitly.
- Story state is independent. Moving it to active claims it for the caller;
  reporting completed requires all live children accepted and Story evidence.
  Reopen a completed Story before reopening/adding children.
- Deletion is soft, requires a reason and generates `deletedAt`/`deletedBy`.
  Live dependent references or Story children prevent deletion. Normal lists,
  Board cards and Gantt projections exclude deleted items. Use `include_deleted`
  for inspection and `restore_*` with a reason; restoring a Story does not
  restore its children. Restore parents/dependencies before their children.
- Comments append immutable actor/time/text, not replace details. Record reads
  return the latest 20 comments and total counts; comment text also appears in
  paginated history. History is excluded from item projections and queried
  separately; generated events include actor/time and field before/after values.
  `list_board_changes(since=...)` uses an inclusive valid UTC timestamp and
  stable `event_id` values, including deletes/restores; deduplicate events by ID
  at timestamp boundaries and pin the digest while paging.

### Example Agent workflow

```text
list_boards(query="Project")
list_workitems(board_slug="Project/Board", states=["todo"], actionable=true)
get_workitem(board_slug="Project/Board", id="implement-ui")
claim_workitem(board_slug="Project/Board", id="implement-ui", expected_digest=<read digest>)
change_workitem_state(..., state="blocked", blocked_reason="Waiting for dependency")
change_workitem_state(..., state="active")
change_workitem_state(..., state="on-hold", reason="Explicitly pause before switching tasks")
submit_workitem_result(..., outcome="Success", evidence=["test://verified-result"])
```

Use the digest returned by each mutation for the next command. Shared MCP
identity is not proof of an individual Agent: use a user-issued external worker
token or a native Chat to distinguish owners. Existing external clients retain
their configured knowledge-root access; this adds no unauthenticated remote
Board management endpoint.

## MCP boundary

- `note_work_items(slug)` reads items/digest.
- `todo_board_create(title, category="")` creates an empty Board and returns its
  slug, items and initial digest, rejecting existing documents.
- `note_work_item_notes(query="", limit=20)` exposes discovery.
- `note_work_item_command(slug, expected_digest, command, worker_token=None)`
  exposes commands.
- `note_work_item_upsert` is compatibility create/edit **through worker command
  policy**, not the low-level upsert bypass.

Without a token, external MCP clients share identity `mcp:external`. Compatibility
commands use restrictive `worker` policy; named management APIs use Board-scoped
`board-agent` policy, never `user` authority.
Native Chats use distinct `chat:<id>` identities. In the Work Item dialog, the user
can select **Me**, an actual PKM Chat, or an external Copilot/Claude/other worker
with a stable `external:copilot|claude|other:<id>` identity. Assignment is metadata,
not automatic execution or proof of a vendor/provider identity.

After saving an external assignment on a Board, the user can explicitly copy/
rotate that worker's Board-scoped token in the VS Code panel (not the browser).
Share it privately with the intended
Agent, which supplies `worker_token` on commands. Only its hash is stored; reads,
browser snapshots and JSON exports never expose tokens or grants. Rotating
invalidates the old token and changes the Board digest. Tokens resolve identity,
not user authority; ownership, generated audit and acceptance protections apply.
Acceptance still needs explicit user delegation via `reviewerIds`.

Double-clicking a card or title opens a modal occupying approximately 80% of desktop
viewport area (90vw x 90vh), with contract, ownership, scheduling, verification,
evidence and persisted history. A single mouse click does not open it; Enter/Space
remain keyboard alternatives on title buttons. Click **Unassigned** to open
assignment controls, then explicitly save the selected user, PKM Chat or stable
external worker identity. **Assigned** shows the actual `ownerId` for external
workers, or the resolved Chat name and ID. Clicking a resolved PKM Chat assignment
copies its canonical PKM URL. Missing/removed Chat records retain the stored ID;
no URL or worker name is fabricated. Reload obtains current MCP claims.
Editable Boards
support mouse dragging between state columns and Story rows via a single CAS
command. Drops to Blocked, On hold or Done open the dialog and require reason or explicit
outcome/evidence before saving. Moving Done work requires explicit reopen;
dragging never silently accepts work. The form provides keyboard alternatives.

These are deterministic metadata operations: no model calls, execution,
automatic acceptance, automatic permission grants, evidence verification or dependency
scheduling. For legacy Markdown items only, manual Markdown edits and generic
Note writes can still bypass role conventions and forge history; convert them to
Boards for application-level protection. This is not a tamper-proof audit or
filesystem security boundary. Sync/editor writers not honoring the lock
can race the final write; there is no OS-wide editor lock. No provider-token
savings or performance gains have been measured.

Agents must use the bounded read/discovery and lifecycle command APIs, not generic
file or Markdown editing. Reading never takes a task: explicit **claim** records
the authenticated actor and moves it to WIP. Generic Board Markdown updates and
low-level upserts are rejected. Native generic `replace_text`/`save_file` tools
also reject Board JSON and its Markdown document while keeping reads available;
this is not a shell or filesystem sandbox. Worker commands cannot rewrite Story structure,
ownership, protected contracts or audit history through legacy worker commands.
The named Board management APIs explicitly allow contract, assignment and Story
maintenance while protecting reviewer delegation and generated audit.
External clients need their
user-issued Board token for distinct identities; without one the recorded actor
is the shared `mcp:external`, not an inferred provider/session name. These
application guards cannot prevent an external process with direct filesystem
write permission from tampering with the backing JSON; use filesystem isolation
if that stronger enforcement is required.

## Validation

After the extension build:

```sh
node --test tests/test-note-work-items.js tests/test-note-work-item-lifecycle.js
node --test tests/test-todo-board.js tests/test-todo-board-browser.js
node tests/test-pkm-skill-mcp.js
```

Isolated project-local test stores cover CAS, competing claims, worker protections,
reviewer/user acceptance, evidence versus acceptance, reopen/release, strict
schedule/extended fields, dependency graphs, generated/legacy history, exact
unrelated Markdown preservation, MCP fixed identity/discovery, System refusal,
and existing resource/Trash round trips. These tests do not certify installed-host
UI acceptance or independently validate linked evidence.

Board tests additionally cover immutable task authority under descriptor edits,
explicit conversion, empty discovery, atomic cross-process CAS, lifecycle/
export/import preservation, external token scoping/rotation, modal dimensions,
identity assignment, guarded drag/drop and read-only browser dialogs.
