# Todo Boards and shared Work Item lifecycle

## Document types and authority

For the definition of idea/Story/task/method/Run/evidence relations and the
boundary between existing links and proposed typed adapters, see the
[idea-to-action contract](./design/idea-to-action-traceability.md).
That design does not enable new runtime APIs or change task acceptance authority.

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
their previous lifecycle. The low-level `todoBoardConversionPreview` /
`todoBoardConvert` migration API still supports explicit, digest-checked migration
of these blocks, preserving IDs, relations, states, evidence, history and original
Markdown. It is not the ordinary Note toolbar's conversion flow.

## Agent-assisted Markdown conversion

Ordinary Notes offer **Convert to Todo Board**, including free-form documents
created by Agents without structured Work Item blocks. The button opens two choices:

- **Copy conversion prompt** copies a source-specific prompt for the user to paste
  into any Agent chat with access to the same PKM Knowledge Root. This starts no
  model and performs no conversion.
- **Convert with PKM Chat** opens a picker of existing non-Trash PKM Chats plus
  **Create a new Chat** (available even when no Chats exist). After cost/execution
  confirmation, the selected Chat is opened and receives the same prompt using
  its model and normal tool approvals. Existing history and settings are retained;
  a new Chat remains available as a conversion audit trail. Busy Chats reject the
  request instead of being interrupted or silently replaced. Cancellation sends
  nothing. Errors are shown explicitly; requests are not automatically retried.

The prompt asks the Agent to read the full current source, preserve the original
Markdown, and create a separate standard Board through `todo_board_create` and
the named Story/task APIs. It requires complete contracts, source links,
draft Stories and unassigned Planning tasks. Checkboxes do not become verified
completion, acceptance, fabricated audit or automatic execution. Missing tools,
ambiguous requirements, duplicates and partial failures must be reported.
The Agent must read back the imported items and report their Board URL and counts;
dispatching a Chat request or returning a prose plan is not proof of conversion.
The UI does not itself parse or migrate the Markdown, delete the source, or bypass
tool permissions. The entry is unavailable on an existing Todo Board.
PKM Chat includes a native `todo_board_create` tool, subject to the same Work Item
write approvals as the named Story/task tools. Creation is not available in
read-only Plan mode and refuses existing paths; an external MCP connection is not
required for this native creation path. Existing Chat tool selections remain
unchanged; if a required tool is disabled, enable it explicitly.

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

- `description`: plain text, 1-16000 characters; rendered as escaped text, not
  executable HTML. Rich project/method records remain linked documents.
- `icon`: one of `tasklist`, `bug`, `beaker`, `eye`, `checklist`, `lightbulb`.
  Decorative only; it changes no task type, lifecycle or permissions.
- `collaboratorIds`: at most 20 unique namespaced stable actor identities,
  distinct from `ownerId`. Display names are not identities. This records
  participation, not ownership, reviewer delegation, resource access or a second
  execution slot. Remove a collaborator explicitly before assigning that same
  identity as execution owner. Restrictive workers cannot assign collaborators
  on creation or change them afterward; users and authorized Board management
  APIs manage this contract.
- `monitoring`: optional `{until?, endCondition?}`. Declaring it requires at
  least one boundary: `until` is a valid ISO UTC timestamp with `Z`;
  `endCondition` is nonempty plain text, at most 8000 characters. Unknown keys
  are rejected. An ordinary task without this field is unchanged. The system
  never guesses monitoring intent from a title or scope. The deadline is not
  planned scheduling and may describe a historical observation window.
  Expiry does not claim, stop, complete or accept anything. This contract does
  not install a scheduler, poll a model or prove that monitoring ran.
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
  `functional`, `e2e`. Statuses: `passed`, `failed`, `blocked`, `not-run`, `not-applicable`.
  Passed/failed reports require evidence; not-applicable requires a nonblank reason.
  These are reported results, not independently verified test execution. Verification
  `blocked` is distinct from the Work Item state `Blocked` and work outcome; it does
  not mean executed, passed or accepted. Its reason remains optional and evidence
  may be empty. The shared API schema and editor support retaining this status.
  Canonical writes/readback preserve supplied reasons and evidence. Reopen retains
  existing reports without making them fresh validation; replacing reports through
  lifecycle commands retains their previous values in history changes. Records have
  no attempt ID or execution attestation, so retained evidence cannot establish a
  current-attempt pass. Missing/empty verification never defaults to passed, and
  build/install/mock results alone do not prove functional or installed E2E behavior.
  Invalid layers/statuses or not-applicable reports without a reason reject the
  entire write. Data-contract regression coverage is not acceptance of these layers.
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

## Atomic work contract

### Identity, lifecycle and attempts

The durable task identity is `(source knowledgeId, local Work Item id)`, with a
slug hint and current source digest for resolution/CAS. Legacy sources without
a stable knowledge identity require the exact digest and current path. A title,
icon, Chat name or list position is never an identity. Rename does not create a
new task. Duplicate/missing sources are explicit errors, not title-based matches.

| State | Meaning | Outcome |
|---|---|---|
| Planning | Defined, not reported actively executing | Absent |
| WIP | Owner reports active work; not a heartbeat or compute counter | Absent |
| Blocked | Reported obstacle with a reason; no implicit approval request | Absent |
| OnHold | Explicit suspension with a reason; ownership retained | Absent |
| Done | An explicit submitted result with evidence | Success, Failed or Unsure |

No conclusion yet means a nonterminal state with no outcome. `Unsure` means an
explicitly submitted inconclusive finding, not silent success or automatic
retry. `Failed` can be accepted as an accurately reported finding; acceptance
does not rewrite it into Success. Only explicit Reopen clears current outcome
and acceptance, returns to Planning and preserves ownership, evidence and audit.
Reopen a Done parent Story first. A native Chat's managed Task has separate
completion authority; reporting Work Item Done never completes that Task.

The UI's **Recorded attempts** partitions immutable lifecycle audit at explicit
`reopen` events, in audit order (even if timestamps coincide). The initial audit
segment is attempt 1; each Reopen starts the next. The conceptual reference is
the durable task identity plus this reopen ordinal. Repeated claims, tools,
model requests, owner handoffs or comments do not manufacture new attempts.
Each segment exposes its actors, reasons and recorded before/after changes,
including old outcome, evidence, verification and acceptance when audited.
Old acceptance remains historical, not valid for a reopened attempt. Evidence
is cumulative; its presence alone does not establish that it was produced by
the current attempt. Legacy/manual records without such audit remain unknown.
These segments are not executor run IDs, measured durations or a new attempt
database. Actual Recipe/Action/Chat attempts require explicit versioned links.

### Responsibility and authority

| Surface / role | Contracts, priority, allocation | Execution and result | Acceptance |
|---|---|---|---|
| Explicit user UI | Can revise contract, assignment and reviewer delegation | Can record observed state/result; cannot imply a model ran | Explicit accept/reopen with reason |
| Authorized named Board APIs | Can manage contracts/allocation through existing approval boundary; reviewer delegation remains user-only | Owner submits; atomic claim and task-focus guards remain | Only a previously user-delegated identity |
| Restrictive worker compatibility tools | Creates unowned Planning work; cannot change protected contracts/allocation | Claims unowned/self-owned work, updates own evidence, holds/releases/submits own task | Only if separately delegated by user |
| Collaborator | Participation metadata only | Can record discussion through existing authorized comment API, not submit for another owner | No additional acceptance power |
| A Chat called “lead” | The name grants nothing; use its actual authorized API role | No bypass of ownership or focus | No implied reviewer or managed-Task authority |

Priority is a documented user/authorized-manager decision in the task context
and audit comments, not inferred from Board order, a new Idea, urgency wording
or a lead's display name. No numeric priority field, automatic preemption or
allocation scheduler is introduced here. Management changes through named APIs
require an explicit reason and current digest. Compatibility user edits retain
their established behavior; integrations should supply reasons for contract
revisions so the record is reviewable.

Claims serialize under the shared mutation lock and source digest: exactly one
competing write wins; the loser reloads and reconciles, never blindly retries.
At most one execution `ownerId` exists. A helper does not become an owner
implicitly. Named Board starts also check unfinished dependencies; dedicated
Board focus permits at most one WIP task per stable actor across Boards.
Legacy Markdown retains its older dependency/start behavior; do not treat it
as certified equivalent to the dedicated Board management API.

### Shared resources and explicit handoff

A Work Item claim protects its **record**, not arbitrary files, terminals,
external services or a developer's uncommitted changes. Before shared-resource
work, record in `scope` / linked project context:

1. Exact resource identities/paths and permitted mutation boundary.
2. Current digest/revision/environment and which actor may write each resource.
3. Independent collaborator work versus mutually exclusive operations.
4. Verification rules, evidence locations and escalation/reconciliation owner.

Use the resource's actual authority (e.g. Note/Board digest-CAS, reviewed
knowledge-file SHA, Project store version or executor proposal digest). If its
version changes, stop the conflicting write, reread and reconcile. Never
overwrite another actor's changes, lower criteria, blindly replay uncertain
side effects or claim that a task assignment acquired a filesystem lock. For
resources with no concurrency primitive, coordinate a single writer explicitly;
this feature supplies no generalized resource reservation or distributed lock.

For assistance or handoff, first append an explicit comment containing:
requesting/receiving stable identities, permitted scope/resources, last confirmed
result with source versions, missing or uncertain effects, current obstacle,
resume point, next action, verification needed and return/decision conditions.
Requesting help does not change owner, group, permissions or acceptance.
The current owner then explicitly holds (retain responsibility) or releases
(clear owner and return to Planning), or an authorized manager explicitly
reassigns with a reason. The receiver reads current contract/evidence/digests
and explicitly claims before executing. After reassignment the old owner cannot
submit a late result. Completion of a comment or handoff is not acceptance.
Network/agent disappearance is not authorization to replay effects or silently
take ownership; cross-group policy and automated recovery are separate work.

### Tests, monitoring and result decisions

Before execution, record applicable unit/functional/E2E criteria, exact target
environment and evidence expectations in acceptance/scope and related records.
For delegated review, the user records the identity in `reviewerIds` and the
permitted review scope. Contract widening, ambiguous scope, new permissions or
unsupported environments go back to the user rather than being self-approved
by a lead. Delegation applies only to this Work Item result, not an external
deployment, broader knowledge change or managed Task completion.

Monitoring workers must execute within the declared window/end condition and
explicitly submit observations, limitations and an outcome. A time boundary
only defines when to evaluate; it is not evidence that an observation happened.
If the boundary cannot be evaluated, report the actual obstacle or submit an
evidenced Unsure finding, not an invented successful duration. Changing/removing
the boundary is a management contract change; a restrictive worker cannot make
its own task endless. The UI, native named APIs and MCP enforce the same field
validation. Authoritative named updates clear optional fields only through
explicit `clear_fields`; clearing `monitoring` returns to an ordinary task.

`Done` is the submitter's report; unit/functional/E2E results, independent audit
and acceptance are separate statements. Preserve failed, blocked, not-run and
not-applicable reports (the last requires a reason), and link actual output
versions. Reading, a successful tool call, a plan, a screenshot or a build alone
cannot approve changed work. Acceptance is bound by task/source digest and
explicit decision audit; stale replies cannot approve a reopened or edited
record. “Needs rework” means explicit Reopen; “needs more verification” remains
unaccepted with the missing checks recorded, not silently converted to Success.

Validation uses `tests/test-note-work-item-lifecycle.js`, `tests/test-todo-api.js`
and `tests/test-note-tracking-e2e.js` after building. The E2E uses two real stdio
MCP processes with distinct Board-scoped actor tokens, native worker permission
checks, authenticated HTTP/Chromium contract editing, independent user review,
handoff and restart readback. Generic file-resource exclusivity and automatic
monitor execution are **not implemented or claimed**. Installed-window and
live-provider certification remain separate.

## Proposed user-decision record (unimplemented; approval required)

This is a contract proposal only: no decision schema, commands, Board/UI/API
support or policy is implemented or approved. A user issue is not a Work Item
execution state, a Done acceptance, a meeting topic, or a third task store. If
approved, attach its record to the existing stable Work Item identity
`(source knowledgeId, local Work Item id)` and persist it through that source's
existing authority: the Board sidecar or the legacy Markdown block. Preserve
legacy items without inferring a decision.

**Proposed record fields:** stable decision ID and revision; lifecycle status
`pending`, `discussing` or `closed`; concise decision needed and reason/impact;
candidate options with linked evidence; participants; references to related
Work Item objectives, acceptance criteria and artifacts; optional user-supplied
review/defer date; and an audit of explicit events. Record the request, work and
evidence versions each decision/reply concerns. Keep the decision discussion
separate from execution permission: recording, reading, acknowledging or
closing a discussion does not itself authorize a worker/API to perform an
operation or resume suspended work.

| Explicit event | Proposed effect |
|---|---|
| Create | Create an open `pending` issue with its version-bound context. |
| Begin discussion | `pending` becomes `discussing`; preserve the issue and its context. |
| Read / acknowledge | Audit only; status and authorization are unchanged. Repeated reads are harmless. |
| Defer | Record who deferred, when, reason and any explicitly supplied replacement date; remain open (`pending` or `discussing`). No inferred expiry or automatic close. |
| Return to pending | Explicit event when discussion pauses without resolution; retain prior discussion and dates in history. |
| Resolve | Explicit, version-bound user decision closes this issue with its outcome and evidence. A changed request/work/evidence version makes an old reply stale and unusable as approval. |

Dates are optional and never generated to make an item visible or actionable.
An undated open issue remains discoverable across day changes. A defer or date
passing does not close it, approve work, or silently change its state. Until date
meaning and timezone rules are approved, do not interpret a date as a deadline,
expiry instant or permission boundary. Meeting completion/adjournment, task
transitions, Done acceptance and day rollover are not decision events.

If approved, the existing named Board API/command path should validate explicit
actor authority, source digest/CAS, decision revision and version bindings in
the same atomic write as the Work Item source; it must not use the low-level
upsert escape hatch. The Board UI should link the record to its Work Item,
show all open issues including those without dates, expose explicit discuss /
defer / resolve actions only to authorized actors, and render reads separately
from state changes. Legacy Markdown and Board sidecar remain the respective
sources of truth; no disconnected runtime index is proposed.

**Acceptance examples for a future implementation:** (1) an undated pending
issue is still listed after multiple days without a generated date; (2) an
explicit defer remains open and retains its prior history; (3) repeated reads
or acknowledgements do not resolve it; (4) duplicate resolution is rejected or
idempotently reported without duplicate effects; (5) a reply bound to changed
request/work/evidence is rejected as stale and cannot authorize execution.

**Open approval questions (not settled):** which existing user/worker/reviewer
roles may create, edit, defer or resolve; what the optional date means and its
date-only/timezone semantics; and the immutable decision ID/revision model and
exact request/work/evidence version binding, and whether an issue may exist
without a Work Item reference and which existing source would own it.
Conservative recommendations,
subject to approval: only the existing user-authorized path resolves or defers
user decisions (no implied worker, Board-agent or “lead” authority); use an
explicit user-supplied date with no assumed timezone or expiry; and bind each
reply to an immutable decision revision plus the exact relevant request, work
and evidence versions. These recommendations grant no runtime permission.

## Note and Project UI

Project **Overview** and **Gantt** share **Load / refresh progress**. This is an
on-demand projection of explicit Project assignments, with local parent Stories
included as context even when their Project is unset. It does not create Gantt
tasks or a second task store. Responsibility, Story, timeline and performance
sections start collapsed. Submitted, reported Success and accepted counts are
independent; Blocked is not automatically a user request. The existing Cockpit
review inbox still owns execution approvals.

The projection reads under the shared Markdown mutation lock, returns its read
time and source digests, and refuses truncated or unreadable discovery rather
than displaying a misleadingly complete summary (1000 source Notes / 5000
selected records maximum). Discovery may inspect the entire Note collection;
it never runs on automatic Project refresh. This is not a filesystem-wide
transaction against editors or tools that bypass PKM locking.

Timeline bars show **recorded state**, not measured continuous execution.
Open intervals end at the displayed read time; no heartbeat, duration, remaining
time or success percentage is invented. Last state timestamps, missing audit and
state/audit mismatches are explicit. No arbitrary age threshold implies activity
or inactivity. A changed source digest warns on inspection; reload before
comparing Project counts with a newer record.

Extension inspection pins `knowledgeId` plus the Note-local Work Item ID. It
follows source moves, rejects missing/duplicate/trashed identities and never
substitutes a same-title task. Unversioned legacy sources require the original
digest; changed or moved sources must be reloaded. Dependencies resolve only
inside that exact source, including dependencies outside the selected Project.
Inspection is read-only and does not replace an open Work Item editor or its
unsaved draft. Public/private browser Boards retain their existing boundaries;
the Agent record inspector is an Extension surface, not a new browser endpoint.

**View Agent Todo / Memory / Snapshot / execution** resolves only a recorded
`chat:<id>` owner in this Knowledge Root. Other identities and unavailable Chats
are explicit unknowns. The existing scoped, read-only Harness reader provides
current reports, experience context and attempt/validation evidence; these are
the Agent's records, not proof it executed this particular Work Item. Task links
and evidence remain separate. Memory is not hidden reasoning; a plan is not
execution. Historical Snapshots must match the owning Chat and can be viewed
without restore/recovery. Inspection does not call a model or change acceptance.
Agent attempt usage retains its original source/measurement semantics; without a
Project workload, measurement window and baseline, Project performance is
**unmeasured**, not zero, a passing budget or an optimization claim.

Regression: `node --test tests/test-work-item-progress.js tests/test-note-todo-host.js
tests/test-note-tracking-e2e.js` after building. The E2E uses persisted isolated
Projects, real stdio MCP/Chat tools, shipped Cockpit/Gantt in Chromium, real scoped
Memory storage and encrypted Snapshot reads. VS Code message/command transport
is adapted in-process; this is not installed-window or live-model certification.

Markdown Notes open in **Markdown** by default; dedicated Boards open in **Board**.
Explicit **Todo Table**, **Board** and
**Timeline** tabs display the Note's structured Work Items without converting
plain checkboxes or migrating real Notes.

Use **New Work Item** or **Details / Edit** to set the contract (title, goal,
scope and acceptance criteria), owner label and stable owner ID, existing
`projectId`, delegated `reviewerIds`, dependencies, paired planned dates,
evidence and unit/functional/e2e verification reports. Reporting **Done** remains
separate from **Accept**; **Reopen** requires an explicit reason.
Done Work Item dialogs and Story overviews also expose **Accept** / **Reopen**,
so evidence can be reviewed and the decision made without closing the details.
These decisions apply to the current persisted record, not unsaved editor changes.

After a digest/CAS conflict, use explicit **Reload** to obtain the current
persisted record for comparison. Reload retains the local draft; reconcile it
with that record before saving rather than blindly retrying.

Under **Project > Gantt**, **Load / refresh Note timeline** aggregates explicit
Work Items whose `projectId` matches the Project, separating planned dates from
recorded state-history intervals.

**Board** is a User Story taskboard: each Story has a left-hand parent card and
one swimlane row, with its child cards in Planning / WIP / Blocked / On hold / Done columns.
Story rows start collapsed for a compact overview; expand a row or use **Expand all**
to reveal the unchanged cards. Explicit expansion choices are retained per Note and
Story for the current page session, including reloads and filter changes. Unassigned
Work Items remain expanded by default.
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
node --test tests/test-note-tracking-e2e.js
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

The tracking E2E test creates actual persisted Projects in isolated knowledge
roots. It runs two independent FastMCP stdio processes through the Python/Node
bridge, native Chat tool execution, HTTP-served Chromium views, explicit user
accept/reopen in authenticated Board dialogs, stale-window draft preservation,
MCP restart, hash-reviewed Trash/asset restore, and two-machine synchronization
against a local bare Git remote. Divergent task histories require an explicit
conflict instead of silent overwrite; rejected Trash requests expose the original
reason through MCP. The package gate's `note-todo` group includes this test.
This is not a run against an existing business Project, a live model, an external
GitHub account, or an installed VS Code window; those environments require their
own verification and must not be inferred from this result.
