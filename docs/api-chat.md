# Independent API Chat

## Portal connection overview

Projects > Portal Connections shows one row per pairing, with **Controlled**
on the left and **Controller** on the right. When both Chats are local, each
side has its own **Open Chat** action. A newly created invitation shows the
existing side and an awaiting-peer placeholder; **Copy magic code** copies the
complete one-time link through the Host clipboard, never into webview state.
Copy is only available while the invitation is unredeemed and unexpired.
**Remove** forgets an ended pairing's history, including both local sides; it
does not disconnect a live Portal, delete its Chats or revoke saved re-attach
credentials. A pairing with any live/reconnecting/other-window side cannot be
removed. Button actions use data-bound listeners, not generated JavaScript.

The Chat sidebar retains its webview context while hidden. Switching away and
back preserves the live conversation DOM and draft instead of requiring page
initialization again. The main PKM editor panel follows the same policy and
silently revalidates its active view on return. Retention uses more memory for
hidden views; actual disposal and window restarts still use persisted state.

Daily-use regression requirements and refresh ownership are tracked in the
[PKM Chat acceptance matrix](../tests/cases/PKM_CHAT_DAILY_TEST_CASES.md).
Run `npm run test:pkm-chat:daily`; the full release browser plan includes it.
The legacy Chatroom code-coverage percentage does not represent PKM Chat.

Completed responses use a small side-profile wizard sleeping at a desk with
animated zZZ and a green light. Failed responses use a smaller sooty face with
a visible upper-right red light. Stopped/cancelled is separate from Failed:
it uses a neutral pause glyph and a plain-language notice, not a red error.
The notice distinguishes an unfinished tool from already completed tools;
stopping a response cannot undo prior actions. Older generic cancellation
messages are clarified when displayed, without rewriting stored evidence.
Animations stop in hidden views and honor reduced-motion preferences.

Model settings and Activity tool details follow VS Code light, dark and
high-contrast themes, including paired secondary-button foregrounds and native
checkbox color schemes. Expanded commands use normal theme foreground rather
than the tool's success/warning color. High-contrast Harness stages remain opaque
with explicit borders and focus indicators.

When context estimates exceed the budget, the composer explains why Send is
disabled. A first send needing PKM tools initializes and waits for the
configured managed service even when the previously selected Chat was read-only;
startup failure remains explicit and does not fall back to native confirmation.

MCP discovery has a single 30-second deadline covering connection, all catalog
pages and managed identity verification, in addition to per-request timeouts.
An endless sequence of distinct cursors cannot keep initialization pending.
Discovery timeout invokes no content tools and does not retry writes.

Streamed public reasoning summaries share the text stream's 500 ms persistence
flush rather than saving/publishing full history for every fragment. Hidden
views do not trigger summary-driven full refreshes. Completion, failure and Stop
still persist the final partial text and public summaries immediately; this
does not expose or reconstruct hidden reasoning.

## Inspecting retrieval and actual context

Use **Retrieval and Chat memory** in the composer, or **Memory** on a historical
response, then choose the Activity and its recall attempt or model round. The
inspector reads that response's persisted records; opening it does not rerun
retrieval, inference or a tool.

- Recall shortlists are not sent context. Prepared context and prepared
  transports are not confirmed sends. Accepted transport is not proof that the
  model completed or followed the references.
- Inspect the recorded query, Chat/attempt identity, scope, retrieval methods,
  candidate selection/exclusion state and reason, source revision, hash and
  original range when present. Missing metadata remains explicitly unrecorded;
  candidate metadata is not the full original resource.
- Each model round exposes its model, estimated input/budget, reserved output,
  actual transport counting method, selected/omitted/unresolved reference IDs,
  planner stop reason and expandable plan/transport/budget ledger.
- HTTP plan/transport message hashes are compared in order. Native VS Code
  messages undergo conversion, so their transport hashes are displayed as
  evidence but are not falsely declared equal to raw planner hashes.
- Rounds with only a budget receipt remain inspectable even when retrieval
  evidence is absent. The bounded retrieval timeline can omit earlier rounds;
  unavailable receipts are not reconstructed from the latest response.

Synthetic four-turn loopback HTTP tests check exact request manifests and
immutable records after reopening. Browser tests cover historical selection,
recall/prepared/accepted distinctions, late hash updates and narrow layouts.
These tests do not replace the user's pending typical 3–5-turn case or validate
its answer quality.

## PKM Portal / PKM 传送门 (Chat-scoped)

PKM Portal is the user-facing name for the peer-to-peer connection between two
agents over the existing Chat transport. It does not imply NAT traversal or a
new transport. Existing protocol fields, command IDs and tool names are unchanged.

This reuses the Chatroom WebSocket client and Hub listener, not SSH or a second
transport service. New Portals use a dedicated `/pkm/portal` peer-only endpoint
with an in-memory, two-endpoint channel. They do **not** create a Chatroom Room,
Room archive/credentials, membership history or Meeting, and never change the
selected Chatroom or enter its Hosted/Joined lists. Room administration does not
manage these channels; stopping the shared listener still disconnects both.
A Portal belongs to one specific Chat, not the active Room,
window or machine. Different Chats can simultaneously control different
IP/hostname endpoints or be controlled independently. Open the current Chat's
**Portal** door button; it shows only a closed door before pairing/disconnected
and an open door while connected. Role-specific wizards remain in status/details,
not on this two-state button. Chat List has no global Portal button.
**PKM: Portal** asks which Chat owns the connection.
Agent Sessions passes its native Chat identity. Opening or using a Portal does
not select a different Chat, interrupt its current local turn or replace history.

**Portal link (recommended).** No Room needs to exist beforehand.

The top-right Chat Portal button shows only an open or closed portal, without
a wizard or role-specific decoration. Clicking it opens the Portal controls to
prepare a connection change; it does not immediately disconnect or switch roles.
Role-specific wizards remain in status and connection details.

1. Choose **Start a Portal**, then this Chat's direction: **Controller** (the
   default) or **Controlled**. For example Windows can create a controlled
   endpoint so the existing Linux conversation can test it. PKM starts the Hub,
   opens a peer channel and copies a one-time `pkmportal:v1:` link
   (transport address/credentials, role and pairing code; ten-minute expiry).
   In a Remote window the Hub port is forwarded with
   VS Code port forwarding, so the link uses `localhost` on the computer that
   shows the initiator's window; the receiving window must run on that computer.
   Alternatively enter a reachable **WSS** address (IP or hostname). A link
   cannot create network reachability, certificates or NAT traversal.
2. In the other Chat choose **Accept a Portal link**, paste it privately and
   explicitly confirm the stated direction and endpoint. When the initiator is
   controlled it must also approve the incoming controller. One transport cannot be
   attached to another local Chat. Pasting alone grants nothing; a link redeemed
   in the wrong direction is rejected.
3. Control direction is fixed. **Switch control direction…** first asks the
   requester to confirm, then the peer must explicitly **Allow switch**; roles
   flip only after both consents, never while a remote task is active, and
   tasks cannot be sent while a switch is pending. Declined or expired requests
   leave roles unchanged; an ambiguously late acceptance revokes the connection
   rather than leaving contradictory roles.

**Copy a forgotten invitation.** Projects → Portal Connections includes an
**Awaiting peer** section with **Copy magic link** for unredeemed, unexpired
invitations owned by this window. The Host copies directly to the clipboard;
the secret link is never included in webview snapshots or persisted history.
Redeemed, revoked or expired links cannot be reused. Invitations remain
memory-only and disappear on Host restart; established pairings use re-attach.

After pairing:

1. Continue asking the controller Chat to work on the remote machine. Enable
   the **PKM Portal** builtin capability: it exposes `portal` with
   `open/status/send/get/cancel/disconnect/switch/permissions/files`. `send` uses a stable request
   UUID and returns delivery only; `get` reads that exact remote request's answer
   back into this conversation. Manual **Send task** remains available.
   The target approves the exact instruction separately from pairing. Execution
   uses the existing bound Chat's model/history, not a newly created Chat per
   instruction. A busy target rejects instead of interrupting or queueing.
   Existing local Allow All
   does not authorize remote calls; reusable approvals must use explicit Portal
   leases. Initial remote
   execution cannot delegate to other Chats/workers or start another peer session.
2. **Status** shows endpoint, peer participant, advertised machine/Chat identity,
   role and original request IDs. `get` returns the bounded answer.
   **Cancel task** addresses
   the original request, and **Disconnect** revokes pairing and requests
   cancellation. Cancellation cannot undo effects or implicitly terminate
   previously approved durable background commands.

**Copilot and other MCP clients.** Discover a Host with
`api_chat_capabilities`, then call `portal_control` with `operation="open"`
and no context ID. Local UI names the conversation and handles link copying/
pasting; credentials are never returned to the model or written into the
MCP request queue. Poll the returned local request with `api_chat_request_get`
to get its `contextId`. Keep it in this conversation. Subsequent operations
use that context and the original remote `request_id`; local control receipts
and remote task receipts are different identities.

**Automatic review (PKM controller Chats only).** Receipt/observation changes to
awaiting approval, waiting input, restricted visibility, completed, failed,
cancelled, denied or unknown enqueue a PKM system event:
`Please check controlled chat status.` It contains the original context/request
identity, not copied remote instructions or approval authority. Running changes
and repeated heartbeat/receipt delivery do not repeatedly trigger a waiting
episode. Completion is triggered after its final receipt has been stored, so
the controller can query that same request rather than guess from an early
snapshot. Late snapshots cannot reopen a terminal task.

The normal controller runner consumes the persisted event when idle (model
charges may apply); it never interrupts a busy run, steals focus, or approves
anything for the controlled user. Pending events for the same request coalesce
to the newest state. A paused/stopped controller retains the notification for
explicit resumption. The event is labelled **PKM · Portal status event**, not
**You**, and is not a human Task requirement. Expired execution context,
disconnect or role/pair changes prevent a queued review from running; the
queue reports the reason instead of replaying a remote task.

External Copilot/MCP contexts do **not** auto-wake the companion PKM Chat or
inject messages into Copilot. Use an explicit status/get request when the user
asks, or keep the external agent's own approved blocking watcher/program
waiting for results (as with Chatroom standby). A pushed transport receipt
alone is not a mechanism for starting a new Copilot turn.

MCP does **not** authenticate individual Copilot conversation IDs. External
operations require local consent showing the named context, or an explicit
unexpired grant to remember access to the current connection. That grant trusts
the local MCP client holding the handle, not a cryptographically authenticated
Copilot conversation; a caller-supplied name is not authorization. External handles
cannot access PKM Chat-owned contexts. Remote execution for an external context
uses one dedicated, visible PKM companion Chat; it cannot inject a task into an
existing Copilot UI conversation. The controller's Copilot conversation remains
the planning/reporting surface. Pairing is never re-attached automatically after a
Host restart or Knowledge Root change; see **Re-attach** below for the explicit path.

New external companions have a `Portal:` title and are placed in the **Portal**
Chat group rather than Ungroup. They retain ordinary inspectable execution
history and permissions, and creating one does not switch the currently selected
Chat. Reuse its returned `contextId`: an `open` without a context ID creates a
new companion, even if the label matches. Existing titles alone do not prove
provenance; historical Chats are not automatically hidden, merged or deleted.
Opening a Portal on a normal existing Chat does not regroup that Chat.

The Chat List does not display the selected Chat's Portal details; those remain
inside that Chat. Returning to the list or receiving a background Portal update
must not reserve space below the list for that connection.

Dedicated `pkm.peer/v1` frames are directed to one authenticated Portal endpoint.
The Hub replaces supplied sender identities and does not store peer frames in
chat history; ordinary messages and catch-up history never trigger remote work.
The controlled Host first creates an exclusive, synced claim under local
`.pkm/state/peer-tasks`. Duplicate IDs do not execute again, altered content is
rejected, and interrupted claims remain unknown rather than being replayed.
Claims are not a distributed exactly-once transaction for external side effects.

**Re-attach (`resume-v1`, 3.2.83+ on both Hosts).** After pairing, each Host keeps
the pairing (pair ID, derived HMAC secret, role, peer Chat identity, controller
outgoing receipts) and its transport details in VS Code SecretStorage, never in
knowledge, Sync or ordinary logs. After a restart or network loss, the Chat door
shows *Re-attach available*; choose **Re-attach previous Portal** in the Portal menu
or call `portal_control` with `operation="reattach"`. The initiator restarts its
in-memory channel if it hosted it; the other side reconnects using saved transport
credentials. Both
sides must be online on the same transport and Knowledge Root. A nonce-bound HMAC
proof must match the stored pair, the expected peer Chat and the complementary
role; mismatches are rejected without attaching. Reusable permissions and external
grants are **not** restored. The controlled Host then re-sends durable receipts for
the controller's open requests: interrupted running/awaiting tasks become `unknown`,
missing journals become `unknown`, completed results are recovered, and nothing is
replayed. Revoke forgets the stored pairing on both sides; Disconnect keeps it.
Pre-3.2.83 Hosts must pair once more after upgrading.

Legacy Room-backed links and saved connections remain compatible. Their existing
Rooms are not automatically deleted or renamed; all newly created Portals use the
dedicated peer endpoint. Version-1 links retain their historical Room-named fields
for compatibility, not as a request to create a Room.

Cross-machine endpoints require **WSS/TLS**; plain WS is accepted only on loopback
for local tests. The existing Hub does not itself supply TLS, NAT traversal, or a
public relay. Use an already reachable secure Chat endpoint; Magic Codes do not
create reachability. The shared Hub terminates the transport and is trusted with
peer frames: this is not end-to-end encryption against the Hub.

Current limits: two endpoints per channel, one peer binding and one active incoming
task per local Portal connection, 100 outgoing requests per pairing, 16,000-character instructions,
48 KiB frames and a 12,000-character answer preview (oversized encoded receipts
are additionally bounded to fit the frame).
Pairing and live controls are session-local and must be re-established after
Host restart; claims remain to prevent replay, but automatic Chat attachment and
outgoing receipt recovery are not implemented. Real Linux/Windows installed-host
acceptance remains separate from local automated tests. Machine/Chat labels are peer-advertised metadata; transport
participant identity and the approved pairing determine routing.

**Timed permissions.** Portal tasks never inherit the controlled Chat's local
remembered approvals or permanent Allow All. Choose Run once, or open Permissions
to select Chat/progress reads, file reads/writes, program execution, PKM reads/
writes, Git reads/writes and environment management. The matrix shows effective
grants and expiry. Recognized builtin tools reuse only their mapped dimension;
unrecognized/native tools still ask unless timed Allow All was explicitly granted.
A dimension is not a promise that every third-party tool supports fine-grained
authorization. Existing tool workspace boundaries still apply. When files-read or
files-write is granted, the matrix can limit it to chosen folders (not drive/filesystem
roots; compared case-insensitively on Windows). Accesses outside them, or whose path
cannot be resolved, still ask. Bounded tool output (at most 1,500 characters per tool
and 12,000 in total) is mirrored to the controller only under a reusable, unscoped
`progress-read` lease plus an unscoped lease for that tool's own dimension; otherwise
the controller sees the tool status with output marked as withheld.

The default is a fixed 15-minute deadline, never sliding renewal. Longer or custom
durations and Until disconnected are allowed after warning. Until disconnected is
not persisted permanent access: disconnect, Host restart, role/identity, Root or
trust change revoke reuse; reconnect does not restore it. Expiry blocks new
operations and cancels the active Portal run. This does not roll back effects or
prove a previously submitted external/cloud job stopped. Revoke is available
from the same Permissions menu. Program execution and Allow All are **not an OS/
network sandbox** and cannot guarantee that arbitrary code cannot copy data by a
different channel. Do not grant them to an untrusted controller.

**Visible state and attribution.** Both bound Chats show Controller/Controlled,
peer identity and front/back wizard visuals independently of task execution.
Public task snapshots include stage, partial answer, tool names/status, waiting
approval/question titles, errors and terminal state. UI and `status`/`get` use
the same per-original-request snapshots. Hidden/background webviews do not stop
collection. Snapshots are bounded (latest per task, up to 100 tasks), ordered and
deduplicated, with a five-second heartbeat; this is not a replayable event log or
screen sharing. Freshness uses local receipt time, not an assumed synchronized
remote clock. Restricted and stale observations are explicitly labelled. Hidden
reasoning, raw tool stdout, unrelated history, desktop state and system dialogs
are not mirrored. When the user is focused on the actual target Chat, permission/
input prompts remain inline rather than adding another VS Code notification.
Remote instructions persist their controller hostname, endpoint and Chat identity.
The Chat header no longer has Pause, New Chat or connection Settings buttons;
Chat List creation, model selection/configuration and immediate Stop remain.

**Files require separate permission.** `portal` operation `files` accepts
absolute local `paths`, or opens a local multi-file picker. MCP `portal_control`
uses `file_paths`. The controlled user explicitly approves **every** immutable
batch, in either direction, even with Allow All/Until disconnected. Receiver
selects a destination and reviews names, sizes and SHA-256 hashes. No content is
sent before required controlled-side approval. Both Hosts must advertise
`files-v1`; older Hosts fail explicitly and cannot receive their own upgrade
through this new protocol. Transfer is flat files only: no unpacking, execution,
installation or Reload.

Defaults are 64 files, 100 MiB per file/batch and a 10-minute idle timeout.
Source/destination identity is rechecked after approval, writes use private
temporary files, size/hash verification and exclusive non-overwriting commit.
Cancellation, timeout and disconnect clean up owned temporary files. This is
not resumable transport or protection against every local filesystem attacker.
`status.transfers` retains the latest 32 local batches. `files` metadata is the
expected manifest, **not** proof of delivery. Only completed `verifiedFiles` is
verification evidence: on the sender it means the receiver acknowledged the
same manifest after verification, not an independent inspection of remote disk.
An offered batch is not a completed delivery, and delivery is never installation.

Validation: `npm run test:peer-collaboration` covers actual loopback Hub/Clients,
pairing/denial/revocation, durable duplicate suppression, shared-store races,
interrupted claims, cancellation, and local HTTP-controller tool approvals.
Loopback tests do not constitute Windows, TLS deployment or real-model acceptance.

If Memory context preparation fails, the main response can still complete using
the recent dialogue. Post-response organization is then explicitly **skipped**
with the original preparation error, not submitted to `turn_commit` for an
unfinished turn. The saved response is retained; memory organization is not
misreported as successful. This guard does not explain or hide the original
transport/provider/storage failure during preparation.

Agent Sessions uses the same user groups as Chat List: user group → Chat →
Task Session. Spawned worker Chats are nested under their parent Chat; existing
Chats receiving a delegation retain their own user group. Empty/no-Task Chats
also appear inside their user group rather than as loose top-level entries.
This is a display projection; Task and host-group identities are unchanged.
Select a PKM Chat's name to inspect its recorded execution in the right-hand
Harness dashboard, including ordinary or Portal-controlled Chats with no managed
Task. This uses the same read-only, current-root and non-Trash access checks as
Visualization; it neither starts a model nor creates a Task or Recipe binding.
The tree's counts still refer to managed Tasks. Folder arrows expand groups
independently, and selecting a Task restores its existing Task dashboard.

Completed Chats and unread results use a sleeping wizard with zzz and a green
status light. Failed Chats use a sooty wizard with white blinking eyes. Manager/
worker roles remain available in status labels and metadata; reduced motion
disables blinking and hidden/background animation is paused.

Tool-enabled explicit Tasks receive knowledge-stewardship guidance: search and
read existing assets before proposing new ones, distinguish evidence from
reusable procedures and executable/orchestrated contracts, and propose useful
corrections with source/validation provenance. This is not an automatic promotion
ladder or a requirement to persist every exchange. Casual/tool-free Chats do not
receive this extra guidance. No background model call or bulk knowledge mutation
is introduced; durable changes still need appropriate tools and authorization.

Assistant replies and delegated worker result cards share sanitized Markdown,
KaTeX math (`$...$`, `$$...$$`, `\(...\)`, `\[...\]`) and Mermaid rendering.
Math and diagram libraries load locally only when needed. Raw HTML is displayed
as text; unsafe links and interactive Mermaid bindings are disabled. Invalid
math or diagrams show explicit rendering errors.

Sending clears and persists the composer first, then immediately shows a local
user bubble before dispatching the request.
It remains marked as sending/awaiting sync until its exact submission identity
appears in saved messages or the input queue. A pre-acceptance rejection restores
the submitted text, preserving any newer draft after it, and displays an error;
local bubbles are not written to conversation history. Delayed acceptance or
state updates never clear a new draft, even when it equals the submitted text.

Queued text messages support Edit, Save and Cancel. The host acknowledges a
persisted per-message editor token before Save/Cancel become available; the draft
is retained in webview state across refreshes. Any active editor holds both
automatic queue dispatch and in-flight steering consumption, even after the
current response completes. Another window cannot silently replace that editor
or consume its message. Finish or cancel the editor to release the hold; there
is no timer that submits an unfinished draft.

On release, an idle Chat sends all queued messages with the same execution
context in their original order as distinct user messages in one request,
retaining every submission identity. Inputs arriving during preparation remain
queued for the next request. Mixed execution contexts and Portal review events
are not combined across authority boundaries: an explicit error preserves the
queue for review. A batch that exceeds the model context budget is not truncated
or split silently; it fails before dispatch and remains queued. During an active
response, task inputs prevent steering from overtaking their queue order.

Explicit English/Chinese execution delegations with enabled execution tools
(for example, “Please fix this endpoint” or “请帮我排查这个问题”) activate
a persisted work objective, without creating or completing a managed Task.
Ordinary explanations and tool-free Chats do not activate it. Recognition uses
bounded phrase matching, not a general intent classifier; arbitrary paraphrases
are not guaranteed to start autonomous work.

The work record separates the stable original objective from the current
attempt and retains acceptance criteria across follow-ups with History enabled.
`session_info.workGoal` supplies the original objective, ordered source input
IDs and acceptance state. The model uses `report_work` to record `continue`,
`resolved`, `blocked` or `needs_input`. Reports must account for every ordered
source input and cannot remove previously recorded criteria, including the
original-objective criterion. Continuing requires a concrete next action;
resolution requires every criterion verified against successful, non-report
tool calls from the current attempt. A successful diagnostic alone does not
automatically settle the objective. These are evidence-linked **agent claims**,
not independent semantic certification.

Both HTTP and VS Code transports review attempted text-only completion while
the objective is active and continue within the same request. Two successive
endings without new execution evidence fail explicitly; changing only call IDs
or repeating reports does not reset that check. Actual new evidence can permit
further continuation, subject to existing tool-loop, permission, queue, context,
time and output-budget guards. Further tool execution after an outcome reopens
acceptance. This is not an idle scheduler that starts new model requests.
The legacy `finish_debug` gate remains for debug attempts without an active
work-objective contract; it is not a second completion authority.

A non-explanatory answer to a blocked/needs-input goal reactivates the same
original objective and invalidates old verification. Explicit Stop/Pause
disarms it; cancellation, authentication/transport failure and recovered host
interruption preserve the unfinished objective without restarting it. Paused
or interrupted work requires an explicit Continue/Resume or execution
delegation. The model must reconcile recorded and uncertain effects before
repeating operations. Changed execution contexts are rejected, not silently
retargeted; History off does not resume a hidden earlier objective. None of
this grants permissions or authorizes service restarts or side-effect replay.
Live-model autonomy acceptance remains separate from controller regressions.

`diagnostic_logs` is a separate read-only diagnostic capability, not a relaxation
of general hidden-file restrictions. Discovery covers only host-local standard
VS Code/VS Code Server log roots, skips symlinks, and exposes allowlisted log
names. Reads reject traversal and symlink paths, inspect at most 256 KiB per
byte window, return at most 40 diagnostic lines/12,000 characters, and redact
common authentication secrets, email addresses, home identities, URL paths and
request payload fields. An optional literal `query` filters diagnostic lines;
`beforeByte` pages earlier windows. Omitted lines and local-only visibility are
explicit. Redaction is defense in depth, not a guarantee that arbitrary log text
is safe for publication; review evidence before sharing. Permission follows the
Chat's outside-workspace read policy, and remote Portal instructions retain
their independent tool/resource gate. Credentials, settings and arbitrary
hidden files remain excluded.

`session_info.currentAttemptCalls` exposes bounded current-response call
identities and statuses so the model can cite actual evidence in `report_work`
or legacy `finish_debug`
without guessing opaque tool-call IDs or replaying operations. Invalid evidence
references return the current eligible identities explicitly.

The Activity list owns its per-operation disclosures: tool arguments/results,
model-round receipts and Advertised tools expand in place and default to
collapsed. The running attempt's Activity list initially opens so execution
is visible; explicitly collapsing or expanding it survives refresh and completion.
Builtin read/search/find/edit/save/list/program rows describe their recorded
request targets, including requested line ranges and query scope, without
requiring the arguments to be expanded. Native tool dispatch shows the selected
tool name; unknown third-party schemas are not guessed. Harness tool graphs use
the same descriptions. Full recorded names and arguments remain inspectable.
File operations also show compact filename chips (full paths on hover), including
recognized native read/write/edit/patch tools forwarded through `invoke_vscode_tool`.
Multi-file patches show each recorded target; unknown third-party schemas keep
their original tool label and arguments. Exact `+added/-removed` counts appear only
for successful builtin edits with an attributed result, not from proposed patch text.
Program/terminal operations show a truncated command preview and an expandable,
wrapping command block with the recorded working directory. Native program argv
is explicitly display-only, not a shell command or a rerun action. These details
are derived from retained tool records, so live and historical Activity rows agree.
Original tool call IDs and model round IDs correlate new records;
old records without these IDs remain readable without guessing a match by
tool name. Reported model-round `in / out` usage appears before elapsed time.
Each event is labelled **LLM**, **CMD** or **INFO**, in its original chronological
order. The Activity type filter hides other categories without reordering events;
its selection survives live refreshes. LLM includes inference only. VS Code model
API token counting is local INFO bookkeeping retained in diagnostic receipts,
not a standalone Activity row or an additional LLM call (including older records
previously labelled LLM). Counting does not establish a token charge. Inference usage remains unknown unless
the provider reports it. CMD identifies tool/command dispatch, not an independent
model charge; tool output can consume input tokens in a later request, and third-party
tools may call models internally. INFO identifies local preparation, retrieval and
display, not inference; displayed data can still enter later model input.
CMD/INFO do not show a token-usage placeholder. Explicit completion timestamps
prevent a completed Memory step from absorbing subsequent knowledge retrieval.

Connected VS Code model objects are reused within the view rather than rediscovered
for each turn, including Memory preparation. Concurrent discovery is shared;
cancelling one caller does not cancel another. Model-list changes and explicit
model refresh invalidate the cache. An explicit `NoPermissions` or `NotFound`
failure triggers one access revalidation, never an automatic request replay.
Other failures do not trigger access checks. Input budgets and token counts are
still checked for every changed request; caching model access does not bypass them.

The current owned Task Session's todos are
shown as a flat grey list; when no Session todos exist, explicit agent-reported
planning possibilities are shown instead. Neither is a guarantee of future
execution. Old activity records retain their own recorded plans.

Reported reasoning tokens, when available, are shown as a subset of the round's
output tokens, not an extra amount to add again. Row time is the recorded
dispatch/result interval including waits, not CPU time or proof of remote-job
completion. Missing accounting remains unknown.

Direct HTTP providers can supply explicit public `reasoning_summary` deltas;
these are bounded, persisted and displayed inside the corresponding model
activity and Harness output graph. Hidden `reasoning_content` and opaque native
`thinking` metadata are not exposed or interpreted as a public summary. When
no public summary is reported, the UI says so; it does not generate one using
an extra model call.

User and Agent Profiles are explicit preference cards, separate from model
connection profiles, Skills, Notes and retrieved Memory. Open **Profiles** to
inspect or edit them without a model call. Storage remains Host-private by
default. **Profile storage / GitHub Sync** offers an explicit preview before
adopting root-scoped cards at `profiles/user/<id>.json` and
`profiles/agent/<id>.json`. GitHub transfer requires another approval for each
target's repository, branch and Private Profile selection. Nothing is selected
or uploaded by default; long-term Memory and Chat history are not included.
These JSON cards are plaintext, and deletion cannot erase Git history.
See [Profiles and Chat priorities](design/pkm-profiles-and-chat-priorities.md)
for storage ownership, migration, conflicts and revocation.

Agent Sessions' shared native renderer starts with a full-width diagnostic log
(latest recorded errors/warnings/status), a runtime-parameter table, and
simultaneous Harness, Recipe/Action, Memory and Retrieval diagram cards in two
columns. Narrow containers stack cards. Model/limits/usage use recorded receipts;
unknown quantities stay unknown. The shared Memory preparation card groups
recorded blocks by kind; it is not the stored-memory pyramid.
Full graph navigation, nested evidence, read-only receipts and lifecycle controls
remain below the cards. Automation orders Action Library third, immediately
before Recipe Library.

The dashboard's **Attempt records** selector can inspect earlier replies instead
of only the latest attempt. Parameters, Memory and retrieval diagrams follow
that selection; Recipe/Action bindings remain Session-wide. Missing receipts
stay explicitly unavailable and do not imply an empty memory store. Actual
Harness, retrieval and Memory-accounting records have graph previews when
present; absent Recipe/Action bindings do not generate synthetic runs.

The lifecycle's Run node is a rounded rectangle with room for the live activity
name. Finished activities are not retained in the node. Terminal attempts show
**Last recorded** rather than **current**; failures include their recorded error.
Run counters describe the latest attempt's recorded events, not test coverage.
An absent field says **not recorded**, whereas an explicitly empty event array
may show zero. Provider token usage is separate from public output-segment
records and does not imply a recorded output-segment count.

Native VS Code notifications announce permission requests, questions/decisions
waiting for input, completed replies, explicitly completed Tasks, and failures.
Each notification belongs to its originating Chat, even after switching Chats.
Completion of a reply does not mean the managed Task is complete. Cancelling a
request is not reported as a failure. Background memory-organization failures
are reported separately and do not change a successfully saved reply to failed.
`personalKnowledge.chatMemoryThinkingBudget` (900 / 1500 / 2048 / unlimited)
sets how much hidden model thinking each background memory step may use,
separately from its limited visible output.

Permission notifications offer only **Open Chat** (localized with the UI);
authorization is always decided in the originating Chat's inline card.
The card offers **Allow once**, **Approve & remember**, **Allow All** and refusal
where appropriate. Allow once does not remember a grant; Allow All belongs to
this Chat, not the account or other Chats. Batch/quota safeguards still require
explicit review. Dismissing a notification or
choosing Open Chat leaves its decision pending. Cancelled, replaced or disposed
requests cannot be authorized through an old notification.

For independent work, the manager is instructed to put all ready sibling tasks
in one `spawn_workers.tasks` batch before sleeping. This is model guidance, not
a guarantee that every model follows it; dependent tasks should still wait.
Displaying a worker's saved original answer is local UI work and uses no model
tokens. Event-driven manager wakeups, summaries and decisions do call the model
and incur input/output tokens, including worker results admitted as context.

Run **Personal Knowledge Manager: Open API Chat** from the command palette.
The Webview opens in the secondary (right) sidebar on VS Code versions supporting
`viewsContainers.secondarySidebar`; the current development host is 1.140.
The extension's general minimum version has not changed. Older hosts without
this contribution location cannot use this view.

## Asset stewardship and organization

The current Task guidance is a prompt-level policy, not an autonomous learning or
deduplication service. It does not prove that a model follows the guidance; real
model acceptance remains distinct from request-context tests.

For a large library, prefer a logical/faceted index over a bulk physical folder
reorganization. Keep stable PKM identities and separate asset kind, domain,
project/scope, maturity, privacy, provenance and relationships such as
`derived-from`, `implements`, `orchestrates` and `supersedes`. A Note can remain
valuable evidence without ever becoming a Skill; a Recipe is orchestration, not
automatically a more general or better Action.

A suggested model-free first pass is byte hashes for exact duplicates, existing
lexical retrieval plus optional shingles/MinHash for near-duplicate *candidates*,
and explicit links/references for structural grouping. Do not normalize executable
code or merge records on text similarity alone. An optional small embedding model
can rank ambiguous candidates incrementally; it cannot certify equivalence,
contradictions or permission to publish. Any future reorganization should first
produce a read-only review list with stable IDs, evidence and reasons, followed by
an explicitly approved, recoverable migration. None of those bulk mutations runs
as a side effect of Chat or this guidance.

Relevant research, verified against the primary arXiv abstracts:

- [A-MEM](https://arxiv.org/abs/2502.12110): Zettelkasten-inspired structured notes,
  links and memory evolution; useful inspiration for organizing related evidence.
- [ExpeL](https://arxiv.org/abs/2308.10144): extracts natural-language insights from
  experience and retrieves them for later tasks without parameter updates.
- [Voyager](https://arxiv.org/abs/2305.16291): an executable skill library with
  environment feedback, execution errors and self-verification in Minecraft.

These are related designs, not proof that PKM now has autonomous consolidation,
semantic deduplication or reliable model-free generalization. PKM must retain
source evidence, local validation, correction history and user authorization.

## Configuration

Click the model name / **Choose model** button beside Send. For a new direct-HTTP
chat, select **VS Code models** to open the actual available-model picker, or
**Connect API provider...** to configure HTTP. An already connected VS Code chat
opens discovery/selection directly. The header gear (**Model connection**) also
switches provider sources. Choose one of two connection paths:

1. **Use VS Code models**: choose an actually available model from VS Code's
  Language Model API. Sign in to the relevant provider and approve access when
  VS Code asks. PKM does not request an API key or extract a Copilot login token.
  Copilot and other configured providers can appear, subject to their actual
  availability, permissions, quota and subscription. If the list is empty, sign
  in or configure providers using VS Code's **Manage Language Models** command.
2. **OpenAI-compatible** or **Azure OpenAI**: provide a base endpoint, model
  ID/deployment name and API key as described below.

The model source and identity are saved per chat. A successful model selection
also saves its source, identity and capability profile in VS Code user state as
the default for new chats. Cancelled selections leave the default unchanged;
existing chats keep their own selections. Without a remembered model, new chats
use `personalKnowledge.apiChatProvider` (initially OpenAI-compatible).
The default does not copy chat history, context, selected budgets, keys, tools,
MCP connections or permissions. HTTP endpoint/key configuration remains shared
as described below. Remembered native metadata lets the model display survive
reload, but is not proof of availability. Discovery runs only when explicitly
connecting/refreshing or sending, not on activation. The selected model is
checked again before each request. A missing
model does not silently fall back to another model. Hosts without this public API
show an explicit error. PKM still owns the conversation, Session and tool runner;
this path does not reuse Copilot's Agent Host or history. Registered VS Code
tools can be controlled in the Tools tree, as described below.

The current Copilot extension also registers `copilotcli` model metadata for its
CLI chat-session selector, but its Language Model request callback is empty and
its token counter returns zero. PKM excludes that catalog-only vendor and rejects
previously saved selections before calling it. A model's presence in discovery
alone is not evidence that an extension can invoke it. This restriction must be
re-evaluated if the provider implements public requests in a later version.

For direct HTTP connections, the key is entered through a native
password input and stored in VS Code SecretStorage, never in the Webview or
conversation JSON. Leaving the key empty keeps the existing key.

- OpenAI-compatible example: `https://api.openai.com/v1`.
- Azure example: `https://your-resource.openai.azure.com` with a deployment name.
- Local servers may use HTTP on localhost. Remote endpoints require HTTPS.
- The endpoint must have no embedded credentials, query string or fragment.
- The provider must implement streaming Chat Completions; Responses-only and
  native Anthropic APIs are not supported yet.

Direct HTTP chat reuses `personalKnowledge.aiEndpoint`, `aiModel`, `aiAzureApiVersion` and
the existing AI API key. Changing them also affects HTTP script summarization.
`personalKnowledge.apiChatProvider` is independent of `aiBackend`: selecting
Copilot for summaries does not select a chat provider. For direct HTTP models,
add IDs to `personalKnowledge.apiChatModels` or choose **Enter API model ID...**.
`personalKnowledge.apiChatTimeoutSeconds` is a model **inactivity** timeout:
default 1800 seconds (30 minutes), range 10-86400. It is not a maximum task,
model-call or stream duration. Responses and stream activity renew the timer;
native hidden-thinking/metadata parts and HTTP stream bytes (including SSE
heartbeats) count even without visible text. Tool
execution and user/approval waits do not consume it. Chat, workers and Memory
use the same setting, without a separate two-minute Memory cap. Existing explicit
settings are preserved. Providers may impose their own limits; internal work
without an exposed activity signal cannot be distinguished from a stalled call.
Loop review remains separate; activity alone does not prove useful progress.
Requests are not automatically retried.

Model display names are not API IDs. For a name such as **GPT-6.1 Sol**, use its
entry only if the public VS Code model catalog actually exposes it. A model
visible in another chat product need not be exposed to extensions. An exposed
entry belonging to the catalog-only `copilotcli` vendor cannot be used
through this route even though Copilot CLI can display it. Instead,
configure an API provider that supports it and use that provider's exact model
ID or Azure deployment name; PKM does not guess an ID or certify availability.

## Extension Host Builds

The exact-Host control queue also supports `tools` for native MCP diagnostics.
With empty arguments it returns bounded registered tool names, counts, and native
tool API availability without creating a Chat, starting a server, or calling a
model/tool. Explicit `{ "start": true }` requests managed PKM startup through
VS Code's existing trust checks before reading the catalog; it does not restart
other servers or change tool selection. A registered catalog is not proof that
Copilot enabled those tools for a particular agent request.

Installation updates files on disk; it does not replace code already loaded in
other windows. The status bar shows the running PKM build fingerprint, observed
retrieval-index state/progress and GitHub Sync state. Click it or run
**Personal Knowledge Manager: Show Running Extension Hosts** to open the read-only
**PKM Status Dashboard**. It shows loaded/installed identity, PID, online hosts,
background work, worker-reported index counters/generations and each Sync target's
state, last success and next schedule. **Host log** and **Host diagnostics JSON**
retain the original log and detailed coordinated-reload verification.

Webview rendering runs separately from the Extension Host and index worker.
The dashboard receives small snapshots; it never scans knowledge, builds an index,
fetches a remote, starts/restarts a worker or starts Sync. Existing worker status
observations are asynchronous, non-overlapping, cancellable and bounded to two
seconds including the response body. Visible dashboard refreshes do not overlap
and stop when hidden/disposed. A submitted corpus is not a completed index.
Percentages require real nonnegative counters and a known positive total; unknown
totals show indeterminate progress. These are per-phase document counts, not an
elapsed-time estimate. An earlier ready generation may still serve during a build.
Observation failures are explicit, not a fabricated healthy/100% state. This is
not a claim that every existing Extension Host filesystem operation is off-thread.

Startup logs and `session_info`
also include the captured build identity; subsequent disk changes do not change
that running identity. Packages verify fingerprints against shipped artifacts.

After installing one verified package, run **Personal Knowledge Manager: Reload
All Registered Hosts to Installed Build**. A single native confirmation broadcasts
to registered hosts sharing this installation and profile storage. The target is
resolved from the installer's extension registration, including version-directory
changes; malformed or ambiguous registration blocks reload instead of guessing.
Busy PKM Chat/background work
defers reload; the request expires after five minutes. Completion requires a new
online host in the same storage slot reporting the requested build and completed
background integration preparation, not merely accepting the request.
On activation, PKM automatically checks and upgrades its managed MCP runtime and
generated server in the background. Concurrent windows serialize this work;
successful upgrades require no setup dialog or manual regeneration. Existing
account bindings and manual registration ownership are preserved. Missing Python,
conflicting/newer runtimes and migration failures remain explicit in Host Status
and Config; failed or incomplete preparation cannot acknowledge upgrade success.
This restarts other extensions in those windows too;
external agent activity is not tracked and must be stopped first.

Legacy hosts without this coordinator require an initial manual reload. Other
machines/installations/profiles are separate cohorts. Missing or expired registrations
are not evidence that every VS Code host has upgraded; no process is force-killed.

## Chat Names and Status

Internal resource links use `pkm://` URLs. **Copy PKM URL** in the Chat header
or library menu copies `pkm://chats/<workspace-namespace>/<Chat UUID>`, not a
bare UUID. The namespace is stable across reloads. Paste it into **Go to PKM
Path**, or click a PKM link in a Chat response, to open the existing Chat.
An address from another workspace is rejected with guidance to open its original
workspace; opening a link does not create a Chat, start a model, or change permissions.
The native control API and `list_chats` return `chatUrl`; use that URL as the
`chat_id`/`chatId` input to get, send, cancel, or `ask_chat`. Legacy UUID inputs
remain accepted for compatibility, but are not resource links.

User messages align right and assistant messages align left. Every message has a
small bottom-right token footer: pending messages show `Awaiting token usage`,
valid reported input/output counts are shown when supplied, and absent counts show
`Token usage not reported`. Request input includes history/context/tools; it is not an
independent count for the user message. Counts cover reported model rounds only,
not unreported rounds or provider billing. Workflow stages use identical compact
colored dots, with status/tooltips and expandable activity preserved.

The header pencil opens **Rename chat**. Names are trimmed, limited to 120
characters, saved with the conversation/native Session, and never overwritten by
the first prompt. Cancelling leaves the previous name unchanged; a pending rename
still belongs to the chat where it was opened, even after switching chats.

Every history option starts with **Running**, **Idle**, **New result**,
**Needs input**, or **Paused**. Live runtime state takes priority over disk recovery, including
background chats. **Needs input** covers edit/program/MCP approval while running,
or the next user turn after a viewed reply/failure. **New result** means a completed
request has not yet been acknowledged in the visible selected chat; this receipt
survives reload. A selected chat is acknowledged only when visible and scrolled
to the end. Hidden views/background selections do not clear it, and an old
receipt cannot acknowledge a newer result. Fresh chats and acknowledged stopped
responses are **Idle**. Recovered interrupted requests require input, not a false
running indicator.

## Context and History

**Options** is collapsed by default and holds attached context, Context/Output
limits, **Use earlier Chat context** (formerly **History**) and token/cost/provider details. An attachment count remains in
the summary and Add context tooltip. Folding the controls does not disable their
limits or detach selected references; explicit expansion is preserved on refresh.

The add-file button attaches the editor selection, current file, or chosen text
files, including knowledge files. Attachments are snapshots, not live watches;
remove/re-add them after edits. Nothing scans or uploads the whole workspace.
Sending transmits the current message, selected context, and, when **History**
is enabled, budget-selected recent dialogue and matching Chat evidence to the
selected model provider. Historical tool calls are never replayed wholesale.
Files may contain secrets: inspect the selection before attaching it.

**Use earlier Chat context** controls model context, not Chat storage. Turning it
off excludes earlier dialogue and Chat / authorized-source memory recall, without
deleting saved messages or derived Memory. Explicit User / Agent Profiles remain
separate context. The settings panel explains this beside the checkbox; its
checkbox, text buttons, slider and number fields use distinct sizing so long
labels do not overlap on narrow windows. Output is a per-inference generated-token
limit; Tool rounds is the model/tool round limit before asking to continue.
The displayed input estimate conservatively counts UTF-8 bytes, including system
text, attachments, selected Memory/Skills, bounded dialogue and builtin schemas.
MCP schemas are discovered and checked at connection time. This is not provider
tokenization; every model round is checked against the configured window.

Limits: 160 KB per chosen file, 60,000 attached characters, 16,000 message
characters and 100,000 UTF-8 output bytes per model inference, including serialized
tool calls. The output byte limit resets for each tool round; it is not a
cumulative task limit or a token estimate. Requests use the configured model
context/output budget, not an unrelated 100,000-character ceiling. Required input,
explicit context and active tool results are never silently shortened; if these
alone exceed the budget, the request fails before model dispatch. Optional
retrieved references and recent dialogue are admitted only when they fit.

Automatic PKM knowledge references have a separate **8,000-token input budget per
model round**, independent of the model window. Long L1 sources are refined into
query-matching original structural passages before admission, even when the full
source would fit the window. A source without a bounded safe passage is omitted,
not prefix-truncated or rewritten. Dependent passage context stays together.
Planning uses the existing conservative UTF-8-byte upper bound, so it may admit
less than 8,000 provider tokens. Native transport additionally checks real
`countTokens` plus overhead when available; HTTP and native hosts without a
tokenizer use conservative local bounds, not reported provider usage. Dispatch
stops explicitly if the independent reference limit is exceeded.

This limit applies to automatically retrieved knowledge, not manual attachments,
required task instructions, recent dialogue, organized Chat Memory or tools.
Those remain subject to the overall model context budget. Full source evidence
is retained locally; the retrieval inspector and budget ledger show selection,
omission, refinement limits and the independent reference budget. No extra LLM
compression/relevance request is introduced.

## Native Session Ownership

Each Chat has a stable runtime Group (`hostKind: pkm`). Casual conversations
remain Group-only. **Start Task** creates an explicit compatible
`pkm.agent.session/v1` record with `origin: pkm-native` and `runtimeOwner: pkm`.
Chat titles name Groups; Task titles remain independent. Replies are not Todos.
**Complete Task** preserves its evidence and allows a later Task in the same Chat;
unfinished Todos or attached Recipes must be resolved first. Existing Task
and Todo evidence is not migrated or silently removed.
Agent Sessions shows native/external/unknown source labels; names are not used
to infer ownership. Existing Copilot/Claude host identities project as external;
ambiguous legacy records remain unknown, without a bulk migration.

Conversation JSON lives under `.pkm/state/api-chats/<workspace-hash>` in the
configured Knowledge Root, with atomic replacement and private file permissions.
Small histories retain their existing inline format. Larger histories use a
versioned index and immutable, SHA-256-verified segments under
`.pkm/state/api-chat-history/<chat-id>`. Each segment is at most 1 MiB, and
individual large messages can span segments without truncation. There is no
5 MB cumulative history cutoff: model context limits remain independent of
stored dialogue, tool evidence and retrieval audit records.

Existing inline histories, including ones larger than 5 MB, can be read and
convert on the next normal save; merely opening a Chat does not migrate it.
Revision checks still prevent stale overwrites. Segmented records use storage
version 2 so older builds reject them rather than interpreting an empty inline
message array as the complete history. Use the updated build in participating
windows before continuing shared work; installing does not force a reload.
Task mirrors and worker archives reference the same immutable evidence.
Explicit Session Snapshots expand their history into a self-contained payload.
Immutable revisions can retain extra segment data; they are not deleted during
an active operation. Permanent Chat deletion removes its segments unless a
retained Task or worker archive still owns that evidence.

The Chat UI initially receives up to 20 recent messages, with an approximately
512 KiB page budget (one larger message is still displayed in full).
Scrolling near the top automatically retrieves preceding pages. A **Load older
messages (N)** button also exposes the remaining history, including when a short
visible page cannot scroll. The message area is keyboard-focusable so keyboard scrolling
uses the same pagination. An upward mouse wheel also loads earlier history at the
top of a page that has no scrollbar. Scrolling upward pauses streaming auto-follow;
returning to the bottom or explicitly sending a message resumes it. Host refreshes
and streamed output must not pull a reader back down. Loading retrieves history without model inference or
adding those pages to model context. This is rendering pagination, not a
multi-window fallback: every window reads and writes the same Chat history. UI paging does not delete stored evidence
or affect in-place Retry and worker Resume. Retrieval and execution still use
the owning conversation's evidence; this is not a promise of constant-memory
execution or unlimited disk space. Disk, I/O and validation failures remain
explicit errors instead of silently dropping history.
The shared Chat List enumerates existing workspace partitions in that root,
without moving histories. Windows using different Knowledge Roots do not share
the list. File/process tools remain bound to the originating workspace, including
legacy histories whose partition supplies that identity.
Native Session records include owned conversation/context state, so selected
Session Snapshots can capture that state, not hidden model reasoning.
These are local plaintext records, not encrypted archives; normal filesystem
backups can include them. SecretStorage keys are not copied into those records.

User-managed Chat folders live separately in `.pkm/state/api-chats/library.json`.
The header's back arrow opens the collapsible Chat List. Chats default to
**Ungroup**; folders can be created, renamed and deleted. Deleting a folder moves
its Chats to Ungroup, not Trash. Drag a Chat to a folder or use its context menu
to move it. **Trash** stays at the bottom and supports restore, permanent delete
and Empty Trash. Destructive actions require confirmation; Task/Group evidence
is preserved even when a Chat is permanently deleted.
The move picker accepts a new name directly and creates that group; selecting an
existing name reuses it. Permanent deletion completes Memory cleanup before
removing the recoverable Chat file. Empty Trash attempts each item, reports
failures explicitly, and leaves failed items in Trash rather than presenting
a UI-only deletion or silently stopping the remainder. Cross-workspace cleanup
uses the original Chat's namespace. Successful deletions persist after reopening.

Chat List trash/restore/permanent-delete operations, Empty Trash enumeration and
the deletion cleanup's owning-namespace lookup run in a Node worker. Full-history
validation, segment cleanup and contended filesystem locks therefore do not block
the Extension Host's health replies during those operations. The same store locks,
running-Chat checks and evidence-retention rules still apply; failures are surfaced
without automatic replay. Unchanged selected Chats reuse already validated history
when publishing state, with filesystem-stamp invalidation for changes from other
windows. This does not make every Chat load or rendering operation asynchronous.
Slow publishes log `PKM Chat slow publish` phase timings; library actions log
`PKM Chat library action` cleanup/publish timings without Chat contents or paths.
The request duration includes the user's confirmation time, not just storage work.

Shared-file notifications refresh lists across windows. Revision checks and a
cross-process write lock reject stale overwrites and overlapping requests.
Running Chats cannot be trashed. New requests record their process owner; only
a confirmed absent same-machine process permits interrupted-state recovery,
never an automatic model retry. Legacy requests without ownership evidence are
not automatically recovered. Another window's live request remains read-only.

Switching chats does not misroute or cancel another chat's response. The header
**Pause Chat** button cancels the selected request and persists an explicit pause.
Sending and incoming native Session questions remain blocked after reload until
**Resume Chat** is clicked. While paused, the primary composer button also becomes
**Resume Chat** and remains available even with an empty draft or no model connection.
Resume preserves the draft without replaying a request or submitting a message;
send the message explicitly after resuming. The running composer's **Stop response**
button stops everything this Chat is doing: the current response and its in-flight
tools, the queued-input drain, running worker Chats it manages (recursively) and its
durable background processes. Cancellation does not await a tool result or MCP
connection shutdown. Late output cannot restart the response or execute another
tool. Connection/process cleanup runs separately; a cancellation request is not
proof of remote termination. The Chat stays available for new messages. Stop cannot
cancel work already submitted to a remote service (for example an AML job).
Pausing a source does not cancel an already approved independent
delegation. Stop the target Chat to cancel its work; its own permissions still apply.
Session stop/Trash/removal is detected within one
second and aborts generation without recreating the Session. Partial chat text
is preserved. After a process interruption, persisted streaming replies appear
as interrupted; they are not automatically replayed. Restore a trashed Session
before sending again, or start a new chat after stopping/deleting it.

In Agent Sessions, right-click a running Session or a paused PKM-native Session
and choose **Stop Session**. Stopping preserves Todos and Recipe evidence. A
stopped/completed Session can then be moved to Trash; the Trash menu supports
Restore and confirmed permanent deletion. Paused external Sessions are not
stopped through this native ownership path.

## Agent-Driven Chats

The automation MCP domain exposes the real owning Extension Host controller,
not a preview server or a second model runner. Agents can create visible Chats,
send prompts, inspect results and explicitly cancel responses:

1. Call `api_chat_capabilities` and select the exact online Host by workspace,
  machine and loaded build. Empty/virtual workspaces do not advertise a Host.
2. Call `api_chat_models(host_id, command_id)` and poll its returned receipt with
  `api_chat_request_get(host_id, request_id)` for actual callable native models.
3. Call `api_chat_create(host_id, title, command_id, model_id)` and poll the
  receipt for `chatId`. Omit `model_id` only to use remembered/default settings.
  Creation opens the actual sidebar Chat and does not send or create a Task.
4. Call `api_chat_send(host_id, chat_id, prompt, command_id)` once. Inspect its
  receipt, or use `api_chat_get` while generation or inline approval is pending.
  `api_chat_list` returns workspace-local non-Trash metadata; read-only calls
  do not create, recover or adopt conversations. `api_chat_cancel` cancels only
  the owning Host's current response, retaining partial output and history.

Read-only `api_chat_models`, `api_chat_list` and `api_chat_get` accept an omitted
or empty `command_id`; each such call gets a new receipt ID. `api_chat_get` also
accepts the full `pkm://chats/<workspace>/<chat-id>` URL as `chat_id`, but still
requires an exact discovered Host ID.
The reply's `context` field is a compact cost summary: the latest five rounds,
planned/transport input counts, automatic-reference budget and consumption,
selected/omitted/unresolved reference counts, selected source kinds and omitted
round counts. It does not return full source IDs, content hashes, message-hash
manifests or source contents. Full evidence remains available in the local Chat
retrieval inspector; the summary does not rewrite historical receipts.

Use a unique `command_id` for every mutation. Repeating the same explicit ID and
input returns the existing receipt, never another creation/model invocation.
Conflicting inputs are rejected. A receipt marked `succeeded` means the
controller operation returned: inspect `reply.status`, `reply.error` and actual
tool statuses before claiming a successful model answer. Responses are bounded
and disclose truncation; unavailable credits remain `null`, not zero.

Mutation requires a trusted filesystem workspace and the existing Chat's
ownership/permission policy. Busy, paused, foreign-owned and trashed Chats are
not resumed or taken over. Native confirmations remain enabled; the API cannot
set Allow All, select an unavailable fallback model or automatically retry.
Agent-driven turns exclude recursive Chat control and `ask_session` delegation.
Sending can incur real model/tool charges and transmit the Chat's selected
history/context. Model discovery can trigger the provider's native consent.

Private Host registrations and request receipts live under
`.pkm/state/api-chat-control` in the Knowledge Root. Receipts contain the submitted
prompt and bounded answer as local plaintext; normal backups may include them.
They do not include SecretStorage keys, full tool results or hidden reasoning.
There is no automatic receipt deletion. Host IDs change on reload. Offline
queued/running receipts report `outcome_unknown` without rewriting or replaying
them; inspect the existing Chat rather than submit another charged attempt.
An installed package is not a loaded Host: reload explicitly before expecting
its registry or new tools. The MCP runtime must also be regenerated/restarted
through the supported setup/upgrade path to discover the new tool catalog.

## Model Budgets and Activity

Each assistant attempt keeps its own persisted workflow rail (circles connected
by lines). Green means completed, blue running, amber waiting for input, red
failed, and muted grey cancelled. Icons and labels carry the same information;
color is not the only signal. Click a node for its event and time, or expand
Activity for the recorded sequence and actually advertised tool names. Terminal
timers stop. Reload recovers interrupted nodes without replaying the request.
Historical attempts retain their own graph when the next request starts.

Attempts also persist `invocationBudgets` (`pkm.chat.invocation-budget/v1`)
for each observed tool dispatch, local Chat/authorized-worker recall, and
knowledge-provider guard. These are invocation records, not per-round totals:
repeated observations replace the same original identity rather than adding
another call. Each record separates `elapsedMs`, `activeMs` and `userWaitMs`;
active excludes tracked PKM approval/input waits, but is not CPU time.
Native provider confirmations that PKM cannot observe are not subtracted.
The knowledge-provider guard records its actual configured 5000 ms deadline;
that deadline does not cover subsequent reference materialization. Missing
tool deadlines are uninstrumented, not unlimited capacity or the model idle
timeout. Existing tool/process limits remain unchanged.

Visualization's **Tool / retrieval invocation budgets** subgraph is read-only
and available even if retrieval was cancelled before the first model round.
Degraded/unavailable retrieval remains distinct from a successful Chat answer.
Cancelling a tool records the end of local observation, not proof that its
remote effects or durable process terminated. Host recovery marks running
records interrupted and preserves their last sampled counters without
inventing an end timestamp or charging downtime.

Only the latest failed/cancelled/interrupted response offers Retry. It requires
an explicit inline Chat decision and replaces that failed assistant response in place with
a new attempt using current settings and the original user message/images.
The original user message ID, content and position stay unchanged; no duplicate
user message is appended or sent as extra history. The failed response and its
tool-result memory are excluded from the new inference. An unsent image draft
remains untouched. Earlier conversation turns are preserved. Retrying can repeat charges and tool
side effects. Busy, paused and superseded responses cannot be retried, and no
automatic retries are enabled.

The composer Tools icon opens a searchable tree of builtin tools, native MCP
namespaces/other VS Code tools and each configured HTTP MCP server. Source and
individual-tool toggles, mixed states and **Only this source** control the next
request. New Chats default-enable available tools; saved explicit exclusions
remain disabled. Native namespace labels are name-based, not verified server
provenance. `session_info` reports the current
request's Session identity, model, permission mode and actual tool list.
The shield icon is visible in the main composer toolbar; **Agent settings** also
offers **Permissions**. Ordinary new Chats explicitly use **Protective**; QA
Chats explicitly select **Allow All**. Protective allows verified workspace-local
operations and asks once for a disclosed, remembered per-Chat outside-workspace
boundary grant. Unknown-scope MCP calls and programs need that grant; a local
working directory does not confine a program. Another Chat does not inherit it.
Read-only excludes edits, programs, MCP and Session
cooperation. Ask-before-changes uses inline Chat approvals and remembered scopes.
Verified reads are free; verified non-destructive changes share one remembered
grant. Unclassified/destructive tools retain tool-specific grants. Public native
registrations do not expose verified safety annotations, so PKM does not infer
read-only safety from their names. **Allow All** enables all configured tools,
clears prior selection exclusions, and skips PKM approval prompts but
does not bypass VS Code confirmations, workspace trust or ownership checks.
The composer labels this **Allow All (PKM)** and explains this boundary:
PKM-controlled loop, Retry and Complete Task decisions appear as inline Chat
cards, not VS Code-level modal dialogs. These decisions cannot be approved by
changing tool permissions. Pending cards are scoped to their Chat, attempt and
sending-window context; stopping/disposal removes active cards, and changed
idle conversations invalidate Retry/Task confirmations without executing them.
Reset approvals clears remembered grants; cancelled settings leave the previous
mode unchanged. These controls are not an OS-level
filesystem/network sandbox for approved processes.
`pkm_search` searches local Note/Skill/Research/Script/Recipe titles and categories
and available cached Subscription metadata (at most 12 matches, without a
first-1,000-Notes cutoff); `pkm_read` reads an exact catalog identity with bounded
content. Previews expose an exact UTF-16 range and a revision/hash handle for
subsequent half-open reads of at most 4,000 characters. Small Recipes keep their
complete structured response; oversized definitions expose pinned JSON text
ranges instead of failing solely on size. Neither Scripts nor Recipes execute
when read. Stale, removed/private or trashed sources fail explicitly. Both tools require a trusted workspace;
their verified builtin read operations need no change approval in Ask mode,
but outside-root references still require the Protective boundary grant. These
are not access to all PKM services or live Broker content; cached Subscription
reads use the current local snapshot without a remote fetch. Read-only mode
keeps safe read/question tools, not write/process/MCP/cooperation tools.
PKM supplies its own Session ID and actual tool availability to the model even
when no tool is selected. Independent Streamable HTTP MCP connections remain
supported. The Tools tree lists the actual `vscode.lm.tools`
registry on capable hosts. Enabled registrations are made available
through `find_vscode_tools` (bounded schema discovery) and `invoke_vscode_tool`
(exact discovered name and validated input). PKM's own tools use a Chat-owned SDK connection to the **configured managed PKM
MCP launch** (the same Python/runtime, generated server, cwd and Windows proxy).
The Tools tree identifies them as **PKM · Chat permissions**. Discovery starts
one service process per Chat view Host, shared by that view's requests and closed
on disposal/replacement. Tool definitions and safety annotations come from that
service, not guessed from native tool names. Existing canonical PKM selection
IDs remain valid. Ordinary `list_notes`, `update_note` and other PKM calls obey
the Chat's permissions: Allow All does not show a second native tool dialog;
required approvals appear inline. No failed/uncertain call is automatically
retried, and failed managed setup never falls back to native execution.

Third-party/native tools still use `vscode.lm.invokeTool`
with `toolInvocationToken: undefined` outside a Chat Participant. Their VS Code
or extension-specific confirmations are independent of PKM permissions.
The [public invocation API](https://code.visualstudio.com/api/references/vscode-api#LanguageModelToolInvocationOptions)
only supplies an inline native confirmation token through a real Chat Participant
request. A custom PKM webview cannot manufacture that token, relocate a third-party
confirmation into its own DOM, or override it with Allow All.
Opening PKM Chat in a trusted workspace starts background discovery of the
configured managed `pkm` service. Core extension activation
and the initial Chat page do not wait for this discovery. Read-only Chats skip
it; saved exclusions and native confirmations remain unchanged. Startup errors
are reported separately, with no automatic tool-call retry or replay. A broken
or missing managed runtime still requires repair in Config.
Third-party native servers must already be configured, trusted and registered by VS Code; this
does not imply access to every Copilot-internal tool. Missing registrations
fail explicitly. The bridge currently returns text results only, not MCP
resources, prompts or image results. New chats do not inherit exclusions/grants.

The native selector groups registered PKM tools into Skills, Notes, Papers,
Chatroom, Recipe, Agent Sessions, Subscriptions, Retrieval and Runtime. Other
VS Code/MCP tools remain selectable in a separate group. Grouping does not
rename invocation IDs, add unavailable functions or change saved selections.

The builtin `list_directory` lists bounded entry names/types in a relative or
absolute directory without reading file bodies or following entry symlinks.
It uses the same per-Chat outside-workspace approval as other builtin tools;
local Allow All does not show an extra directory dialog. The agent is instructed
to prefer this path over equivalent native directory tools. While the builtin
is enabled, the duplicate `copilot_listDirectory` is omitted from the Chat tool
catalog, so an ordinary listing cannot accidentally enter its separate approval
path. Disable the builtin first to explicitly select that native tool. Hidden/sensitive
path exclusions, trust, sending-workspace checks and Portal folder grants still
apply. Third-party tools such as `copilot_listDirectory` retain their own
confirmation if explicitly enabled and invoked; PKM does not forge their consent.

For collapsible groups in Copilot, run **Personal Knowledge Manager: Export PKM
MCP Tool Sets** after PKM MCP has registered its tools. The export contains only
the current Host's registrations, using VS Code prompt references such as
`pkm/list_skills`; actual calls retain IDs such as `mcp_pkm_list_skills`.
Choose a new `.toolsets.jsonc` file in the current client's user Tool Sets
folder, located through **Chat: Configure Tool Sets**. Existing files are never
overwritten. A different client/profile, including a local client connected to
a remote Host, may require moving the exported file into its own Tool Sets
folder. Exporting alone neither enables tools nor bypasses approvals. MCP's
wire-level tool list remains flat; clients without Tool Sets keep their own UI.
Regenerate to a new file after changing the available MCP tools.

`replace_text` changes an open document without saving it. `save_file` requires
the edit's exact SHA-256 `afterHash`, the applicable saved permission grant and unchanged document
version/content, then verifies the saved disk content. Configured save actions
may change the document and are disclosed. Tests run against disk only after
an approved save; approved programs are not sandboxed.

## Session Diagnosis

Options contains an Export Chat diagnostics icon. The native Save dialog exports
`pkm.chat.diagnostics/v1`: up to five recent assistant attempts, error categories, model
and limits, tool names/statuses and bounded workflow timings. It does not export
chat/context text, images, tool arguments/results, raw provider errors, endpoint
URLs, API keys or hidden reasoning. Older records may lack per-attempt manifests;
absence means unknown, not proof that a historical schema was empty.
Workflow timings keep the latest 12 steps per attempt, with explicit omitted
attempt/step counts. Context costs use the same hash-free summary as `api_chat_get`;
the diagnostic export is not a full Harness snapshot.

From a built checkout, the equivalent read-only command is:

```sh
node scripts/export-chat-diagnostics.js <knowledge-root> <session-id>
node scripts/export-chat-diagnostics.js <knowledge-root> 'pkm://chats/<workspace>/<chat-id>'
```

It checks PKM-native ownership/identity, rejects malformed/external records,
limits output size, and never resumes or modifies the target Chat or Session.
Use this summary rather than dumping stored Chat JSON, budget manifests or
immutable history segments into an agent conversation.
The Library Recipe **PKM Native Chat Session Diagnosis** is persisted as
`recipe_f73177a622faec24138f613f3da78481`, revision 3, executable digest
`7eeed33bee0856964d436077e7794b2e277e42da968a6abe440e8e03c064b2b4`.
Inputs: `session_id`, `knowledge_root`, `extension_root` (a built checkout).
Its bounded export command is followed by explicit Agent diagnosis/report nodes,
not a provider rerun or deployment. Node.js and existing build artifacts are
prerequisites; installing/building/reloading is not part of this recipe.

Native `LanguageModelDataPart` is not necessarily an image. PKM reads only bounded
`usage` JSON containing valid nonnegative integer `prompt_tokens`,
`completion_tokens` and optional `prompt_tokens_details.cached_tokens`, as
verified in the installed Copilot provider. Only the last valid usage per model
round is accumulated; no other payload fields are retained. Other bounded
`stateful_marker`, `thinking`, `context_management`, `phase_data` and
`cache_control` metadata is discarded without parsing/persisting it. Unknown binary data
and invalid/oversized real images still fail; metadata-only streams remain empty
response errors. Absent or invalid usage is unavailable, not zero billing. Old records do not
retain the exact streamed MIME, so diagnosis separates static provider evidence
from directly observed runtime data. New diagnostics whitelist reported token
counts and scalar usage-frame totals (received, valid, invalid); they never
copy metadata payloads. Counts are delivered when a model round finishes and
published immediately. No background account-usage polling is implemented.

## Real Native Acceptance

Run **Personal Knowledge Manager: Run Chat E2E Acceptance** in the installed,
reloaded VS Code Host. Consent and select an actual callable model. The command
creates a visible timestamped Chat and runs up to six independent probes, plus
tool rounds: reply/usage, MCP listings, actual Note/Skill bodies, a complete
Recipe definition, read-only Session status, and existing-file edit/save/process
verification. A failed MCP probe does not skip coding. Truncated bodies,
metadata-only responses and failed tool results do not pass body-read gates.
Session status is intentionally read-only: it does not prove mutation tools or
that the MCP transport's active Session belongs to this Chat. PKM's saved permission
policy and native confirmations remain in force. Existing Chats are not replayed or modified; failures are
retained without automatic retries or fallback.

Evidence lives in the workspace's newly created `chat-e2e-*/acceptance.json`
and its retained fixture files. The report records model/Session identity,
actual tool statuses, registered names, token/usage-frame observations and the
exact test command, exit code, marker and file hashes. Success requires that
every probe passes, and the fixture test remains unchanged and passes against
the saved module. Each probe has a separate verdict and failure receipt.
`credits: null` means not supplied by the public API, never zero credits.
Local mocked tests or a browser preview are not substitutes for this acceptance.

The built-in **PKM Chat E2E Acceptance** Recipe in `System/PKM/Chat` guides three
Agent steps: prepare an isolated Session, execute the native acceptance command,
and verify the retained report against actual tool/test evidence. It never
resumes the original Session or substitutes mocks for a missing provider. If
the Agent cannot invoke native commands, the execution step waits for the user
to run the command and provide its report; the Recipe does not grant automatic
Session control. Failed/cancelled attempts are retained without automatic retry.

## Request Budgets

**Context** has at most five slider presets, derived from the selected model's
local window (1/16, 1/8, 1/4, 1/2 and full, with a 256 minimum and duplicates
removed). The adjacent display uses compact K/M labels (for example, 128K or 1M)
without rounding the internal budget. Existing custom values are not snapped to
a preset until the slider is changed. A smaller window is a rejection limit,
not automatic truncation or summarization of attached context. **Options** is
collapsed by default and contains **Output**; its existing limit stays enforced
when hidden. Lowering Context can reduce the reserved output to keep it bounded.

Model, context-window and output-limit changes apply to the next request, even
while the current response runs. A request captures its model, selected context,
tools and server configuration. Window means total input plus reserved output,
not a provider option that purchases a different physical context window.

VS Code models use discovered `maxInputTokens` as a conservative local total
budget, with reserved output deducted from it; this is not a claim about the
provider's full context window. Their **Output per inference** setting is a local
token guard for visible text and serialized tool calls, using the model tokenizer
when available. Without a tokenizer, PKM displays and saves an explicit warning:
valid provider usage can enforce the token limit at the end of that inference,
before pending tools execute; without either counter local token enforcement is
unavailable. UTF-8 bytes are never substituted for output tokens.
Each tool round receives the full configured output-token budget on both native
and HTTP transports. Previous rounds' usage remains in cost/diagnostic totals but
does not consume the next round's budget. The separate 100,000-byte per-inference
limit and tool-loop controls still apply.
The default follows discovered model output metadata (4096 when unavailable),
not a fixed 1024-token agent total. This is not a provider-enforced output-token
or billing cap. Generation and hidden reasoning may consume additional quota
before cancellation. Verified provider-specific usage data parts can supply
actual token counts; providers omitting them show unavailable usage. The public
API does not guarantee usage data or expose actual charges, so PKM shows
**Billing unavailable** or **Credits unavailable**, without invented prices.
Providers control access, quota and billing. PKM instructions/reference context
are supplied as user messages because this API has no system-message role.

For direct HTTP models, configure `personalKnowledge.apiChatModelProfiles` with
verified provider metadata:

```json
[{"id":"my-profile","model":"my-deployment","label":"My model",
  "status":"active","contextWindow":32768,"maxOutputTokens":4096,
  "includeUsage":true,"outputTokenParameter":"max_completion_tokens",
  "inputPricePerMillion":1,"outputPricePerMillion":2,"currency":"USD"}]
```

These example limits/prices are illustrative, not a model catalog. Deprecated
status or a past `deprecatedAt` blocks the model, including configured aliases.
Unknown legacy IDs are marked unverified and use a conservative 4096-token local
window; deprecation cannot be inferred universally from arbitrary deployment IDs.
Set `outputTokenParameter` to `max_tokens` for providers requiring the older name.

Activity shows actual request stages, elapsed time and expandable tool arguments,
status and results. Usage is accumulated across model rounds when reported.
Cost is an estimate at configured rates, not an invoice; cache discounts and
surcharges are not calculated. The output allowance is shared across up to eight
rounds, with at most sixteen calls per round. Cancel/timeout preserves partial
output and warns when in-flight execution may already have occurred.

### Credits and Multi-Round Cost

[GitHub's usage-based pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)
converts model-priced input, cached input, cache writes where applicable and
output into GitHub AI Credits: **1 AI credit = USD 0.01**. Rates can depend on
model/context tier; cached input is not necessarily free. Some existing annual
plans remain on legacy premium-request billing. This conversion is not a contract
that internal `AIU` telemetry equals UI credits, nor a billing unit for other
providers.

For discovered Copilot models, the UI shows **Credits unavailable**: the public
VS Code Language Model API does not supply billed credits, account plan or quota.
It does not show zero, invent a tariff, or apply Copilot's unit to direct HTTP
providers. Other native providers retain **Billing unavailable**; configured
direct HTTP prices remain in their configured currency.

The direct HTTP **First-call estimate** is not a whole-turn cost cap: each tool
round can resend history and growing tool results, adding input costs even when
the output allowance is shared. Context bounds each call, not cumulative input.
The runtime currently enforces eight model rounds, sixteen calls per round, a
shared output allowance and the request deadline. It does not yet enforce a
cumulative input/credit cap, general delegated subagents, or context compression.
Those require separate runtime budgets; a slider or a smaller Output alone cannot
prevent the multi-round amplification described by the supplied Copilot lesson.

## Agent Configuration

The composer Agent configuration button and native Session component diagram
configure retrieval/history, external Markdown Skills, explicit attachments,
model budgets, builtin permissions and MCP servers. Explicit attachments remain
snapshots. Skill and Chat Memory selection is automatic, not a required checklist.

The **Retrieval** panel shows Top 10 or Top 20 typed candidates from the last
request receipt, with that request's actual model as the target. Only selected
context connects. Type filtering changes the view, not model context. Sources
include Chat Memory segments, Skills, Notes, Scripts, Recipes, Research and
indexed subscriptions. API/function kinds are extensible visualization contracts;
no API/function source adapter or automatic execution is implemented.
The current knowledge route is lexical unified retrieval, not a learned ranking
model. Raw scores/components and source URIs are inspectable. Memory uses bounded
dialogue and a lexical-overlap rule; pools are interleaved rather than falsely
globally ranked across incomparable scoring methods. Flow thickness is normalized
within the scoring method and is not a probability.

Memory belongs to one Chat, with optional Task branches and 1,200-character
source slices. Content-hashed IDs change when the source or tool outcome changes.
Each terminal tool outcome is indexed separately, even when its containing reply
failed, was cancelled or was interrupted. Outcome status and arguments accompany
each tool slice; failed tool outcomes are not presented as successful facts.
Recent tool evidence is eligible for retrieval. Up to four matching segments
with at least 60% of the best lexical score are considered, alongside at most six
short complete dialogue messages (no historical images or tool serialization).
Matching evidence takes budget priority over recent dialogue. History off disables
both. Up to three knowledge bodies of at most 4,000 characters are considered;
larger bodies are omitted with an explicit L2-required reason, not cut mid-source.
All automatic context is optional and checked with actual tool schemas before
every model round. Persisted selection flags/counts describe the admitted context,
not the pre-budget shortlist. Scripts and Recipes are not executed.
Unavailable/revision-changed bodies are not selected. Persisted receipts contain
bounded metadata, not duplicate bodies or hidden reasoning. Knowledge retrieval
honors workspace trust and the Protective outside-workspace grant. Provider
invocation has a five-second deadline and validates a bounded candidate batch.
Malformed results, provider exceptions and timeouts produce a visible retrieval
warning, not a failed primary Chat request. Cancellation remains cancellation.
Compression, automatic L2 refinement and learned segment retrieval remain future work.

### Activity retrieval timeline

Every assistant activity records separate Memory and knowledge retrieval attempts,
their duration, and the actual selected context before each model round. Click the
Memory icon on an answer, or choose an activity in the Retrieval panel. The second
selector switches between recall attempts and sends. A recall shortlist is not
evidence of transmission: only a send snapshot describes the admitted context.
Each send exposes the conservative UTF-8 budget estimate and selected/excluded
candidates. Retrieved references appear in a collapsible list, grouped by the
sources actually present. Chat dialogue and tool receipts are distinguished;
type filtering and Top 10/20 only change the inspection view. Memory summaries
show the first 30 Unicode characters of the source slice, with UUIDs relegated
to expanded metadata. Tool summaries use the actual result, not the repeated
provenance header. Expanding a Memory entry lazily resolves its exact
content-sensitive ID and displays the complete segment; changed or missing
revisions explicitly report unavailable. Expansion and loaded content survive
streaming refreshes and are cleared when switching Chats. The retrieval flow
remains available in a separate collapsible section. Non-Memory receipts expose
their retained source metadata, not an invented historical resource body.
Raw scores remain per-method values, not probabilities or a measured precision
score. Relevance annotation and learned feedback ingestion are not implemented.

The last receipt remains available for older Chats. Activity history retains up
to 32 attempts and the latest 32 send snapshots; omitted sends are counted
explicitly. These records contain metadata, not duplicate source bodies. Missing
or revised source content is reported unavailable rather than substituted.
Retries, manager wakeups and peer-message responses are separate activities with
their own timeline. No extra model call is used to render or summarize it.

Memory inference has an independent durable per-turn accounting receipt. Each
observed call records the actual model/provider, local call duration, configured
timeout/output/thinking limits and available transport timing/provider usage.
Repeated cumulative usage frames replace rather than add; a missing native model
that actually falls back to HTTP is labelled HTTP. Failure can retain partial
usage/timing without applying partial model output. Cancellation persists a
cancelled call/turn without applying late topics or statements; restarting the
worker does not revive it.

The Memory accounting subgraph preserves the preparation snapshot. In PKM
Visualization, **Read durable Memory receipt** explicitly reads the original turn's
latest SQLite receipt, including post-reply extraction, without changing Chat
files, running a model or accepting a caller-supplied foreign turn. Other readers
without this capability retain the preparation snapshot only. Totals report
known/unknown usage and timing coverage; unknown is not zero/free. Local duration
includes model selection/access overhead and is neither CPU nor a provider invoice.
Memory usage is never added to the main Chat usage. Run `npm run test:memory-engine`
for the real Python/SQLite policy, host integration and accounting regression suite.

### Stored Memory observation chain

Click **Visualization** beside Memory to open the dedicated window, then select
**Memory** for the chosen Chat. This view does not require a managed Task.

The Chat no longer mounts an inline Harness panel. The window shares the Agent
Sessions renderer, but retains the selected Chat / Task's scope and recorded
authority. Both entry points use the same **2 x 2 thumbnail Dashboard**:
Harness, Recipe / Action, Memory / Profiles, and Retrieval. Four corresponding
detail tabs sit below it; selecting a thumbnail opens that tab. Tabs support
Left/Right and Home/End, retain selection on record refresh, and do not execute
anything. Runtime parameters and diagnostics are expandable.

Harness uses a compact arrow-connected stage flow, not a second large lifecycle
ring or duplicate **Last recorded / Run** summary. Stage selection still exposes
the exact recorded evidence; full execution graphs remain available. Retrieval
groups candidates into category blocks with piece, selected and sent counts,
without listing memory hashes, candidate IDs or per-item labels. A later empty
receipt does not hide the latest populated receipt; its provenance remains
explicit. Selection alone is not proof of transmission. The dedicated window
retains the Chat tree and additional Memory storage, search and timeline views;
their navigation is no longer another set of diagram previews.

**Collaboration Profiles** shows the attempt's immutable User / Agent Profile
snapshot (including revision and expandable fields), separately from learned Chat
topics. It never substitutes today's edited Profile for historical context.
Transmission requires a `sent` round manifest containing that snapshot's exact
message hash. Missing snapshots mean **Not recorded**, not an inferred or newly
created Profile. The User Profile remains explicit, private persistent context.

The Memory chain separates:

1. **Stored Memory**: a live, Chat-scoped snapshot from the existing SQLite
   engine. The pyramid groups actual Pieces by their stored abstraction level,
   showing kind, revision, logical bytes and current/stale/missing summaries.
   Recorded parent/relation/child rows expose the links behind the levels.
   Shape is schematic; width is not tokens, capacity or compression.
2. **This attempt**: preparation blocks are separate from actual sent-round
   membership. Membership comes from persisted sent context manifests; an
   absent manifest means not recorded, not zero. Historical membership does
   not imply that today's stored summary matches the original transmitted text.
3. **Post-reply organization**: the latest durable receipt for that exact
   response, including extraction failure, model calls, available independent
   Memory usage and timing. It is not copied into or added to main Chat usage.

Expand a stored Piece to inspect its current summary and paged statements,
their epistemic statuses and source locators/revisions. **Read original source**
resolves the selected Chat message only if its content revision still matches;
changed/missing revisions fail explicitly rather than substituting new text.
Source previews are limited to 12,000 characters with explicit truncation;
open the originating Chat for the full message. Statement pages contain at most
20 items and show at most 20 source references each, restricted to this Chat.
Prepared Piece links can also inspect evicted/missing content when its stored
identity remains available.

The storage snapshot includes at most 200 non-evicted Pieces per kind and 100
incident edges per topic/project; possible truncation is explicit. Level counts
describe displayed Pieces, whereas the scope usage totals cover all live Pieces.
Logical byte totals are not SQLite/WAL disk sizes. Recall-window, History and
derived-clear boundaries are displayed separately: stored does not imply
eligible for automatic recall. Refresh explicitly to observe later writes;
the current storage snapshot is not an atomic historical snapshot of the entire
multi-read graph.

Inspection uses scoped reads only: no model call, ingestion, LRU touch, summary
publication or receipt mutation. It may start the local Python reader worker
against an existing database, but never creates a missing Memory database.
Unsupported Hosts, unavailable Python/storage and absent receipts show explicit
unavailable states. This is a Chat-scoped observation surface, not a global
cross-Chat Memory browser or deletion/recovery authority.

### Retrieval-first acceptance

Run `npm run test:chat-context` for source immutability, the eight original
regressions, and real controller/disk-store/local-HTTP acceptance. Run
`npm run test:api-chat` for existing permissions, native-model, tools, transport
and browser regressions. The context suite explicitly labels future mechanisms
as TODO; passing implemented cases is not a claim that those TODOs are complete.
An 8K-window request over the synthetic >100K-character tool history must reach
HTTP with the exact relevant evidence, without unrelated tool output, without
turning History off, and without rewriting persisted evidence.

Tools require a trusted workspace. Available tools start enabled; saved exclusions
remain meaningful:

- `read_file`: bounded authorized text reads; `find_files`: bounded workspace glob listing;
  `search_text`: bounded literal search, not regex or shell.
- `replace_text`: a unique exact replacement, with policy-based PKM approval.
  Stale versions are rejected; edits remain unsaved in VS Code.
- `run_process`: policy-based approval for non-interactive program launch, separate
  program/arguments, closed stdin, restricted inherited environment, output cap
  and 1-120 second deadline. Programs can still modify files outside the workspace
  or access the network; inspect the approval prompt before authorizing.
  Foreground behavior remains unchanged. For an explicitly durable command use
  `background:true`, a required `timeoutSeconds` from 1 to 86,400 and a stable
  `idempotency_key` from 1 to 200 characters. Its lifetime requires a one-time
  approval even under Allow All or remembered program permission. The approved
  process survives window reload; Chat Stop or `process_cancel` with the
  original handle cancels it. No shell, credentials or production execution is implied.
- `process_get`: query the original durable handle in this Chat, including
  launcher/running/exit/timeout/cancel/storage-limit states. A stale supervisor
  reports **unknown**, not success or permission to retry. Reusing the exact
  launch key/inputs returns the original record, including after response loss
  or restart. Changed inputs with that key are rejected. It never launches a
  replacement or signals a historical PID.
- `process_output`: read stdout/stderr by bounded byte offset and length, up to
  12,000 bytes. Read the returned `end` as the next offset: escaping can shorten
  a page to fit the actual tool-result envelope. Large output does not kill a
  healthy command. Complete local logs have an independent 64 MiB combined hard
  storage limit; reaching it requests process-tree termination and is reported
  explicitly. UTF-8 split-byte display replacement does not alter stored bytes.
  Foreground execution also returns an `outputHandle` for reading its saved logs
  without arbitrary filesystem access. Its `foreground-log` state reports only
  log availability; the original execution receipt remains the completion
  authority. These handles cannot be used to poll or cancel a durable process.
- `process_cancel`: explicitly approve cancellation of that Chat's original
  handle, then query until termination is confirmed. A cancellation request is
  not a completion receipt or rollback of effects already performed.
- `record_harness`: record public task/plan/Step/validation observations without
  changing managed Task/Recipe completion or execution authority. Task updates
  must `supersedes` the latest task report ID from `session_info` and cite the
  latest actual user input in `sourceInputIds`. A stale-base or stale-input update
  is rejected without changing history. `session_info.taskWorkingState`, model
  working context, snapshots and the Input/Goal inspector expose the original
  report and `pendingInputIds` newer than its cited sources; workers do not become
  user instructions. Reading or restoring a report does not reconcile those
  inputs, authorize effects, or certify acceptance.
- `ask_user`: native single/multi-choice picker and optional free-text input.
  Dismissal returns a cancelled answer, not consent. Answers are model-visible;
  this is not a secret/password collection tool.
- `ask_session`: one explicitly approved question to an advertised idle,
  unpaused PKM-native Session. Returns an immediate delegation receipt.
- `ask_chat`: the same independent delegation for an ordinary Chat, using its
  canonical PKM URL from `list_chats`.
- `read_chat_result`: read an approved receipt's status and bounded saved answer
  immediately, without starting a model, blocking, retrying or polling.
- `spawn_workers`: create a batch of independent worker Chats and dispatch them
  concurrently. Recursive workers share reusable tree-wide concurrent capacity.
- `assign_workers`: batch activities to existing idle Chats without reparenting
  them or changing their models, histories, permissions or user groups.
- `request_manager_input`: hold a worker activity for clarification or a suggestion.
- `stop_worker`, `respond_worker`, `resolve_worker`: control an exact owned
  receipt/activity/attempt (and decision episode for responses), never another
  unrelated activity. Manager responses cannot grant human permissions.
- `list_workers`: inspect tree membership and parent/child URLs without history.
- `send_worker_message`: explicit, persistent, addressed messaging within one
  task tree. It does not read another Chat's Memory or conversation.

### Worker task trees, sleep and explicit messaging

`spawn_workers` accepts focused `{title, question}` tasks. It creates visible
ordinary Chats, not automatic Tasks. Workers inherit the manager's selected
model, budgets, tool selection, MCP configuration and permission mode, but not
its messages, attachments, draft images or remembered grants. Their tool calls
continue to obey those inherited selections and their own approvals. A worker
may become a manager by calling `spawn_workers` itself; no separate recursion
budget is reset at that boundary.

Defaults are **3 automatically approved concurrent workers** and **10 maximum** across
the entire tree, configured by `personalKnowledge.apiChatAutomaticWorkers` and
`personalKnowledge.apiChatMaximumWorkers`. The automatic threshold must not
exceed the hard maximum. Only increasing the approved capacity needs explicit
approval, even under Allow All. An approved quota of six can be reused after
resolution without asking again. Reservations and releases are persisted under
a cross-process lock. Completed/cancelled temporary workers archive full results
and tool evidence before their Chat is removed and capacity is released. Existing
Chats retain their history/group and release their activity binding. Failed or
interrupted activities retain evidence and capacity until `resolve_worker`;
blockers are not terminal resolution. An uncertain dispatch is never replayed
automatically. The capacity belongs to this tree, not to a model turn or each manager. A new
independent task tree starts in a new Chat.

After the dispatch round the manager stops model requests and releases its
stream/connections/timers. **Sleep is a scheduler state, not a repeated wait tool
or model poll.** PKM reports actionable outcomes and blockers: completed,
failed/interrupted, cancelled, clarification, suggestion, real human permission,
active-time limit, or a suspected loop with repeated-tool evidence. Ordinary
running/progress/resume updates affect UI only. Events are bound to activity and
attempt and deduplicated per decision episode; stale reports cannot control
replacement work. A busy manager processes events after its current activity.
Explicit peer messages are not coalesced. Wake
requests contain bounded events and result references; larger answers can be
read through the existing receipt tool. If work remains, the manager sleeps again.
Token deltas and elapsed-clock refreshes do not wake the manager. A runtime-limit
notice does not imply execution has stopped. It reuses `apiChatLoopReviewMinutes`,
excludes approval/input waits, and permits a manager to continue or terminate the
exact activity. Stop never rolls back tool effects already performed.

Quota approval offers **Yes / No / Let me ask a question**. Follow-up answers
use a separate tools-disabled model request with bounded context/output; they
may incur model charges, are accounted on the active reply, and never constitute
consent or create workers. The original decision remains pending.

The worker status strip shows active/approved/maximum capacity and an expandable
task tree. Archived results open locally with rich rendering and tool-status
evidence; `read_chat_result` supports character-offset paging. Existing Chat
inputs identify their source manager, receipt and dispatch time. Chat List nests
new workers beneath their manager, preserves existing Chat groups, and sorts
only active above inactive with stable order inside each partition. Agent
Sessions follows **user group → Chat → Task**, including empty Chats.

Failed worker details are visible even when the task-tree node is collapsed.
The owning manager or an ancestor manager can explicitly **Resume worker** for
an idle, unarchived failed/interrupted/cancelled activity still occupying its
tree slot. Busy, stale, unrelated or archived activities cannot be resumed.
Resume preserves the worker Chat, activity, receipt, quota reservation, failed
response and recorded tool evidence, then creates a new continuation turn and
attempt using that worker's saved model, tools and permissions. The manager view
is not switched to the worker.

Unlike in-place Retry, Resume does not delete the failed response or replay the
original assignment. A bounded checkpoint supplies the assignment, failure,
partial answer and recent tool evidence; the complete history remains stored.
The model is instructed to inspect existing artifacts and uncertain effects
before continuing, and to split oversized changes into smaller operations.
This is evidence-based continuation, not a complete runtime checkpoint or an
exactly-once guarantee: previously failed tools may already have changed external
state. Clicking Resume authorizes another model attempt and its possible charges;
normal tool approval rules still apply. No worker is resumed automatically.

Peers send text to a specific task-tree Chat URL and receive a delivery ID once
the inbox is saved. Only that message, sender identity and delivery metadata are
shared; there is no hidden common Memory. A busy recipient queues the message,
and a sleeping/idle recipient is woken. Delivery means queued, not that a model
has already processed it. Tree members and parent links are discoverable through
`list_workers`, with pagination. Explicit messaging and wake tools are available
only when the task-tree tool remains enabled.

Stop also works while a manager sleeps and disables its automatic wakeups; it
also stops the manager's running worker Chats. Pause, failed/cancelled manager requests,
Trash and changed sending-window context likewise prevent auto-wakes. Queued
events remain visible in saved state. Host reload does not silently replay child
jobs or resume model work in another window: send/resume explicitly in the owner
context. This implementation is not a durable distributed scheduler or a claim
that running workers survive Host shutdown. PKM's five-second supervisor detects
dead local owner processes and durably reports interruption without asking the
worker to report its own crash. PID reuse, hung processes and remote-host leases
are not inferred as crashes; long-running live activities use the review events.

`npm run test:chat-workers` verifies real controller/store/HTTP dispatch overlap,
no-poll sleep, individual completion wakeups, shared recursive limits, mandatory
expansion approval and explicit peer inbox delivery.

### Refresh and motion

Chat refresh reuses unchanged message DOM instead of rebuilding every bubble,
preserving open disclosures and avoiding unnecessary animation restarts. New
popover openings use a short opacity/position transition; hover/focus surfaces
use restrained color transitions. Reduced-motion preferences disable the new
transitions. Draft, scroll-follow and permission behavior are unchanged.

Delegating Chats use an original 16-by-16 pixel-art magic teacher holding a
book and wand. Workers use a matching wizard stirring a stationary cauldron;
a worker that delegates to its own workers becomes a teacher as well.
Manager identity comes from retained dispatch receipts, so it survives worker
archival and removal. The same roles appear in the library, selected Chat,
worker tree, delegation results and active Activity indicators.
Only running roles animate. Other states keep a static character with the
existing state color/shape as a corner badge and an explicit role/status
accessible label. Ordinary Chats keep the existing cauldron loading icon.
Backgrounded or disconnected views pause motion; reduced-motion preferences
show a single stationary pixel frame. No Minecraft or third-party art is used.

The permission control and **Allow All** sit beside **Options** in the composer
toolbar. Permission, tool, settings and memory choices open separate popovers
without moving the composer. Model selection acknowledges the click immediately
while the host loads its available models. Permissions choose a persistent
per-Session mode. **Protective** asks for the Chat's outside-workspace boundary grant.
**Read only** permits enabled workspace reads and user questions, but
withholds edits, programs, MCP and Session questions. **Ask before changes**
uses remembered scopes for PKM approval. **Allow All** skips ordinary builtin/managed PKM approvals, including approved
outside-workspace reads, but does not bypass third-party/native confirmations,
trust or special batch safeguards. Changes apply to the next request, not a running
tool catalog; read-only is not a general sandbox for providers or attachments.

An explicit permission change (including **Allow All** in a pending approval)
does not retarget an already-running request owned by this window. Its captured
tool catalog and execution environment remain fixed; live approval/read-only
checks still apply. Different sending windows, workspace/root/account changes,
or changed trust still reject execution. Queued inputs retain their original
permission/context digest and require explicit resubmission if it no longer
matches. Genuine context-change errors name the changed fields without exposing
their filesystem or account values.

### Tool-loop continuation

`personalKnowledge.apiChatLoopReviewMinutes` defaults to **30** and accepts
integers from **1 through 1440**. An activity is one submitted Chat turn, including
its model/tool rounds, not each UI Activity entry. Settings apply to the next
request. Chat asks whether to **Continue**, **Answer with current results**, or
**Cancel** only when both the active-time window has elapsed and a repeated tool
loop is detected. Time or round count alone does not fail a productive turn.
Continue grants a fresh active-time window, retaining completed results without
replaying tools. Allow All does not approve this independent decision.
The inline Chat card offers all three actions; choose Cancel or Stop to abort.
Switching Chats hides the card without approving, retargeting or cancelling it.
`apiChatMaxToolRounds` remains a legacy SDK round-review limit, not
the native Chat policy.

Chat also suspects a loop after the same function returns the same result for
the same canonical arguments three times without observable progress. Object
key order does not count as progress; changed arguments or results reset that
function's repetition count. This detects repeated observable behavior, not
semantic task completion. Interleaved functions are tracked independently.
Exact wait/poll exceptions are `wait`, `sleep`, `poll`, `core.sleep`,
`mcp_pkm_chat_standby`, `mcp_pkm_api_chat_request_get`, and
`mcp_pkm_recipe_run_progress`. Legacy SDK round allowances still count these calls.

Summarize performs a final tool-free model turn, explicitly records any pending
calls as not executed, and keeps call/result IDs paired. Cancel aborts the run.
The review clock pauses for PKM user input, approvals and continuation decisions.
Output, context, individual model/tool deadlines and cancellation remain separate
boundaries. Checks run between calls, not inside a stalled in-flight tool. Native
provider confirmations are not tracked as PKM waiting states. The library's
non-interactive fallback summarizes instead of inventing user consent.

The visible Activity header combines completed/recorded steps, the current step
and its elapsed time. The recorded count is not a prediction of future task
size. Expand Activity for detailed steps, tool results and debug information.

For the historical Note follow-up error, the former small round allowance was
a concrete termination path, not evidence that no relevant Notes existed.
Use `pkm_search` and `pkm_read` for verified local reads. Native MCP tools are
invoked through `vscode.lm.invokeTool`; VS Code owns their confirmation. PKM's
Allow All skips its own prompts but cannot disable that independent host
confirmation. This distinction must be checked on the installed host rather
than inferred from an isolated model test.

Successful editor replacements record relative path, workspace index, timestamp,
SHA-256 before/after hashes and bounded `+added/-removed` counts. The response's
**Applied edits** expander sums successful edit operations, not net Git changes
or saved files. Declined/stale/cancelled edits are not counted; counts become
unknown when concurrent changes or bounded diff limits prevent attribution.
Program/MCP execution is explicitly marked as not file-attributed. This ledger
is evidence of edits, not proof that tests passed or a rollback mechanism.

For VS Code models, enabled tools also require the selected model's tool-calling
capability and the host's structured tool-message API. Unsupported combinations
fail before any tool execution; text-only chats do not require these capabilities.

File reads, edits, saves and process working directories can use absolute or
parent paths after the outside-workspace permission boundary. Physical symlink
targets are authorized before reading and rechecked after approval. Hidden/sensitive
paths and `node_modules` remain rejected, including sensitive symlink targets.
Find/search glob discovery remains workspace-local. Explicit attachments are a separate
user-authorized path. Filesystem-backed workspaces are required. Multi-root tools
accept a zero-based `workspace` index. Execution occurs on the extension host,
which is the remote machine under Remote SSH, not necessarily the desktop OS.

File operations use VS Code APIs with physical-path checks. Process launch uses
Node without an implicit shell. Linux/macOS cancellation targets the process group;
Windows uses `taskkill /T /F`. Windows `.cmd`/`.bat` wrappers are rejected: use a
native executable (for example `node.exe`) directly. Termination is best-effort;
detached descendants or remote side effects cannot be guaranteed undone.

## MCP Connections

Add a Streamable HTTP MCP URL through Agent configuration. HTTPS is required
except localhost HTTP. Embedded credentials, query strings, fragments and
redirects are disallowed. Optional bearer tokens are entered only in a native
password input and stored in SecretStorage, not conversation JSON. Choose allowed
tools explicitly; every remote call needs native approval. Servers can be disabled
or removed. To change a URL/token/tool selection, remove and add the connection.

Connections are established and closed per request. Discovery is bounded to the
first 64 tools/page; select at most sixteen per server and four servers per chat.
Duplicate identical calls are blocked within a request, and SDK reconnection
retries are disabled. A failed/cancelled remote call may already have taken effect.
Do not automatically retry uncertain operations. Recorded results are sent to the
model and saved locally; check the server's data policies before enabling it.

Only Streamable HTTP with optional bearer authentication is supported currently;
stdio, legacy SSE, OAuth and automatic reuse of Copilot/Claude MCP connections are
not supported. Ordinary model requests do not require MCP. Automatic Recipe
execution/retrieval remains out of scope. Markdown is sanitized, remote images are
not loaded, and tool results are rendered as text, never executable HTML.

## Running Input

While a response runs, **Steer** supplies text at the next model-round boundary;
completed tools are retained and the runtime does not restart the active request.
**New task** saves a separate text request in a per-Chat FIFO queue. Both actions
confirm receipt before clearing the draft and deduplicate submission IDs. Up to
20 inputs are retained. Running-time input is text-only; images stay with idle drafts.

If the current response finishes before a steer reaches a boundary, that input
remains queued for the next serialized turn. Successful completion drains the queue.
Stop, failure and reopening do not replay pending work: **Run queued inputs** or
explicitly sending another request resumes FIFO processing. Queued inputs can be
removed individually. Other Chats can run independently. A Chat owned by another
window remains read-only, and changing settings affects the next request.

Status distinguishes an animated running cauldron, green completion (including
read results), red failure, yellow user-input/result waiting, and blue stop/pause.
Only a never-run or otherwise idle Chat uses the empty indicator.

## Native Session Questions

Enable `ask_session` through Agent configuration. Up to eight other native chats
are advertised by Session identity and title. One attempt is allowed per source
turn, including a declined attempt. Stopped, deleted, trashed, externally owned,
paused or busy targets are refused; questions are not queued. The explicit native
approval identifies the target, question and possible additional model charges.

The target retains its own model, selected context, complete history and tool
permissions. The source conversation and the target's unsent image draft are
not forwarded. A provenance-tagged user turn and stable delegation identity are
persisted in the target. Approval returns a receipt immediately; the source is
not blocked waiting for the answer. Saved results appear beside the source turn
and can be read with `read_chat_result`, at most 12,000 answer characters and
16,000 serialized JSON characters; truncation is indicated. Binary outputs stay
in the target Chat. A delegated target cannot recursively delegate. Source
cancellation does not cancel the child. Denied approval starts no child request.
Reopening reconciles saved receipts with their exact target turns, without
restarting a model. New results become unread; waiting does not lock the composer.

This is single-hop cooperation between native chats in the active extension
host, not Copilot/Claude Agent Host control, automatic wake scheduling, parallel
workers or a cross-Host background scheduler. Native VS Code confirmations remain
independent of inline PKM approvals. Charges across both Sessions cannot be
capped in credits through the public API.

## Images

Select an actual VS Code model that advertises `imageInput`, then use the image
button to choose PNG/JPEG files, or paste a screenshot/image directly into the
composer using Ctrl+V (Cmd+V on macOS). Pasted images use the same preview,
Remove action, persisted draft, validation and binary model transmission as
picked images; pasting never sends a request automatically. Ordinary text keeps
native paste behavior. Switching Chats during clipboard loading rejects the
paste rather than attaching to another Chat. There are at most two images per draft/message,
512 KB per image, 4096 pixels per side, 16 megapixels and 2 MB of image data per message or draft
bytes per conversation. MIME/type, dimensions and canonical Base64 are checked;
files are not automatically resized. SVG, GIF and WebP are not supported.

Attachments are binary `LanguageModelDataPart` messages, not image paths or text
containing Base64. Input requires a modern host with DataPart and a model exposing
image capability and token counting; unsupported combinations fail explicitly.
The text estimate excludes image tokens and is labelled accordingly. Provider
token counting checks complete image messages and tool schemas before every
call, against Context plus reserved Output. It is not billed usage or a guarantee
of the provider's internal image-token accounting.

Actual PNG/JPEG binary responses are previewed and persisted, with an explicit
native **Save image** dialog. At most two bounded image response parts are
accepted per turn. Image output is provider-dependent: the public API exposes no
image-generation capability flag, and PKM does not manufacture one or provide an
image-generation tool. The text Output guard does not meter binary output cost.
Direct HTTP image input/output and drag/drop attachments are not implemented.
Voice input is intentionally excluded.

Images, including drafts, live in the same private-permission plaintext chat and
native Session records as text, and can be included in backups/Snapshots. History
can resend complete image messages. Only explicitly chosen images are uploaded;
new attachments added during generation belong to the next request. Previews
use validated inline raster data; remote Markdown images remain blocked.

## Copilot Comparison

The public MIT-licensed `microsoft/vscode-copilot-chat` source was inspected at
revision [`5863f5a`](https://github.com/microsoft/vscode-copilot-chat/tree/5863f5a7088958050792b5dccbe8b46c6e13eccc).
Question/permission/image test patterns informed local regressions, not a claim
of equivalent implementation or compatibility with Copilot's private runtime.
Relevant references are `permissionHelpers.spec.ts`, `askQuestionsTypes.ts`,
`askUserQuestionHandler.ts`, `imageToolUtils.spec.ts` and
`executionSubagentTool.spec.ts` in that revision. A small portion of the last
suite was reviewed; the whole Copilot suite was not ported or executed.

| Capability | PKM native Chat status |
| --- | --- |
| Model picker, context/output controls, rename/status/timer | Implemented; actual catalog, no guessed model identities |
| Chat Memory and typed knowledge retrieval | Automatic lexical/rule baseline; Top 10/20 collapsible source previews and retrieval flow, Task segments, bounded injection; no learned-model claim |
| External Markdown Skills and explicit attachments | User-authorized snapshots, separate from Chat Memory |
| Workspace/outside read/edit/save and program execution | Bounded builtins, physical-path checks and Protective/Ask/All policy |
| User question UI | Sixth builtin; choices/free text, dismissal/cancellation tested |
| Session questions | Seventh builtin; approved single-hop native cooperation only |
| MCP tools | Explicit Streamable HTTP connections; no inherited Copilot tools/OAuth/stdio |
| Permissions and loop escape | Protective/read-only/ask/Allow All, persistent Pause/Resume, deadlines/round limits |
| File-change evidence | Per-response successful edit counts/hashes; no net Git diff or process attribution |
| Images | Gated native binary input and actual response display/save; no direct HTTP vision/generation tool |
| Copilot execution/search subagents and auto-wake | Not implemented; Session questions are not an equivalent |
| Terminal interaction, debugger/test/diagnostics/browser tools | Not built in; explicitly configured MCP may expose separate tools |
| Automatic context compression, cumulative credit cap | Not implemented; credits/quota unavailable through the API |
| Voice | Intentionally excluded |

There is no honest percentage of "all Copilot functions" from this partial
review. Seven PKM builtin names do not mean seven Copilot-equivalent workflows.

## Validation

`npm run test:api-chat` builds the assets and runs transport, storage and
controller tests using temporary stores, fake credentials and mocked boundaries,
including VS Code model discovery, routing, native text/tool/image parts,
permissions, pause, native questions, image budgets, evidence persistence and cancellation.
It also runs real temporary filesystem/process tests and a local HTTP MCP fixture.
Linux execution is validated; Windows/macOS runtime and installed-extension checks
still require their respective hosts. Cross-platform interfaces are implemented,
but this is not a claim that those hosts have already passed the suite.
The current source build script uses POSIX commands; Windows source builds need
WSL/Git Bash. This does not change the packaged extension's runtime adapters.
`node tests/test-api-chat.js --preview` serves an ephemeral localhost UI fixture
for browser checks; it is not a live model chat. Stop it after verification.
Live provider authentication, VS Code's consent dialog, actual model responses
and installed-extension behavior require a separate local host acceptance check.