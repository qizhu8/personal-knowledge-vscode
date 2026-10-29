# Shared Chat and Sending-Window Execution

Status: initial runtime implemented and covered by automated tests; live
multi-window, host-loss, and account-isolation acceptance remains pending.

## Decision

A Chat is account-level durable identity and history within a configured
Knowledge Root. Any workspace on that target/account can open it. A window is a
viewer and a possible request worker, not the owner of a Chat.

File/process execution context belongs to the window that sends each instruction.
Capture that context when accepting the request. Never pin a Chat permanently to
its creation workspace or substitute the most recently active window's roots.
Two requests in one Chat may legitimately target different workspaces.

One Remote Server can contain multiple Extension Host processes. Serialize shared
Chat mutations and coordinate request ownership explicitly; global configuration
does not solve concurrency by itself.

## Existing Implementation

- [ApiChatStore](../../src/chat/api-chat-store.ts) lists histories across namespace
  directories and uses revision checks, cross-process locks, run ownership, and
  durable queues. Context-bound requests can cross workspace aliases; legacy
  requests retain the existing filesystem restriction. Foreign task submission
  is atomic, and the active owner merges queue-only revisions without accepting
  unrelated stale writes.
- [ApiChatViewProvider](../../src/chat/api-chat-view.ts) resolves shared Chat
  identities and captures each sender's roots, trust, account, and permissions.
  A live sender can claim its acknowledged task after its predecessor completes;
  cancellation disarms dispatch. Reopening does not replay pending requests.
- [createBuiltinTools](../../src/chat/api-chat-tools.ts) already captures the
  captured request roots when creating tools. Existing trust, path, symlink,
  sensitive-file, and approval checks remain. Remembered approvals are bound to
  the sender's context, not transferred with shared Chat history.
- [ApiChatShell](../../src/chat/api-chat-shell.ts) separates shell/backend
  lifecycle. Preserve lazy initialization and disposal/hidden-render safeguards.

Simply removing the cross-workspace error does not implement coordinator ownership,
request provenance, authorization, or reliable cross-window updates.

Current contexts use hashes for integrity, not authentication credentials. The
initial coordinator uses account-local files, cross-process locks, and attempt
fences, not a new network listener. A lost or changed sender leaves its queued
input pending and requires explicit removal/resubmission; the UI does not yet
expose a dedicated `awaiting-origin` state. Private filesystem/DACL deployment
and real host-loss recovery still require live acceptance.

## Identity and Storage

Separate `chatId`, legacy locator/storage namespace, and request execution context.
Resolve an existing `pkm://` Chat URL through the shared registry to its actual
storage location, regardless of the viewing window's workspace. Validate the
locator and Knowledge Root boundary; do not accept arbitrary filesystem paths.

Preserve existing namespace directories and URLs as storage identity/aliases
during migration. They no longer mean execution ownership. Canonical links for
listed Chats must use the resolved Chat's identity, not the viewer's namespace.
Unknown, conflicting, deleted, or out-of-root identities fail explicitly.

Account-level means the selected account deployment/Knowledge Root, not arbitrary
other accounts or automatic merging of different Knowledge Roots.

## Authority and Workers

Use one logical coordinator per account deployment/Knowledge Root. It accepts
commands, owns durable Chat revisions, sequences events, arbitrates runs, and
maintains receipts. Viewer processes cannot overwrite a full stale history.
Implement the initial authority using the existing lock/revision infrastructure
where possible; add a physical sidecar only if lifecycle requirements justify it.
These are implementation options for the same contract, not concurrent writers.

A worker is an explicitly registered Extension Host with an authenticated
account-private transport and a host-incarnation ID. It can execute VS Code model
and tool APIs for requests from its own window. Do not assume a Python stdio
coordinator can directly call VS Code language-model APIs.

The coordinator assigns one fenced run epoch per Chat. Every worker write carries
the epoch, attempt ID, request ID, and expected revision. Reject stale writes
under the shared lock, including writes from an old worker after takeover. UI
disposal disconnects a viewer; it does not cancel an independent durable run.
Closing the actual execution host can interrupt its worker and requires explicit
recovery rather than silently adopting another window's permissions.

## Request Provenance

Each accepted command carries an idempotent submission ID and a validated
execution-context record:

| Field | Meaning |
| --- | --- |
| `originHostId` / incarnation | Authenticated sending Extension Host; a reused PID is not identity. |
| `originWindowId` | Sending viewer/window for approvals and user-visible attribution. |
| Target/account identity | Prevents local/remote or cross-account routing mistakes. |
| Workspace URI snapshot | Ordered roots with scheme/authority and chosen root/cwd; immutable for this request. |
| Tool/model policy | Selected capabilities and permission mode, not exported secret values. |
| Acceptance metadata | Request ID, timestamp, input kind, context digest, and coordinator receipt. |

The worker supplies the roots from its own VS Code host; reject caller-provided
forged roots/host identity. Persist only necessary provenance, never API keys,
ambient environment variables, or reusable authorization tokens.

Trust must still be valid at execution time. Path and symlink checks are repeated
when tools run. A saved context records provenance; it is not a portable grant
that another window can inherit. Scope existing permission grants to target,
account, origin context, and resolved operation before reusing them.

If the sender changes folders or disconnects before execution, keep the original
snapshot and block execution unless its host can still validate that context and
obtain required approval. Otherwise show `awaiting-origin` and require an explicit
resubmit/resume with a newly captured context. Never silently use new folders.

Delegated child requests inherit the originating request's context through an
explicit receipt. A later independent instruction uses its own sending window.

## Concurrency and Running Input

Allow concurrent viewing of one Chat and parallel runs in different Chats. Within
one Chat, serialize model runs and history edits through the coordinator.

- A task submission is a durable FIFO command with its own origin context.
- A steer is attached to a specific active attempt and applied at a safe model
  boundary. A same-context steer can join that run without changing tool roots.
- A steer from another workspace must not retarget the active run. Reject it with
  an explicit context conflict or let the user deliberately submit it as a
  separate queued task; do not silently reinterpret the input mode.
- Persist acceptance before ACK. Retrying the same submission ID returns the same
  receipt; reusing that ID with different payload/context is a conflict.
- Cancellation addresses an attempt/receipt, not whichever process happens to be
  viewing the Chat. Keep parent and delegated child cancellation independent.

Queue cancellation, pause, deletion, and completion are coordinator commands with
revision checks. No viewer may delete active history or lose accepted queue items
by saving an older document snapshot.

## Events, Status, and Recovery

Expose ordered incremental events with monotonic sequence numbers and a bounded
history cursor. A reconnecting viewer requests events since its cursor; if those
events were compacted, return a revisioned snapshot and continue from its cursor.
Do not rerender full history for every token or poll every Chat from every window.

Separate execution state, waiting reason, and unread-result state. Acknowledging a
result must not turn completed into idle. Viewer focus is not worker liveness.
Persist delegation receipts and bounded result/error payloads so a reopened viewer
can retrieve completion without rerunning the child.

Use host incarnation, lease/heartbeat, and fencing together. An expired heartbeat
alone does not prove a file edit/process failed to execute. After owner loss,
preserve partial output, mark uncertain tool outcomes, and reject late writes.
Never replay side-effecting tools automatically. Recovery/resume needs a user
decision and new validated execution context when the origin is unavailable.

Avoid per-viewer recursive watchers. Share bounded root-scoped subscriptions,
dispose them on disconnect, and coalesce refreshes. Log watcher failures and queue
sizes without private content. Resource pressure must not be hidden behind a
healthy Chat status.

## Migration and Rollback

1. Add versioned origin/request/coordinator records and a shared locator resolver;
   preserve old files and URLs. Route new commands through the authority.
2. Keep old and new schema writers from running together: fence unsupported hosts
   or make legacy views read-only before permitting new-schema writes.
3. Legacy pending inputs have no verified origin snapshot. Mark them
   `needs-context`; require explicit adoption from the sending window. Do not
   guess their context from the Chat's namespace or replay them on startup.
4. Retain locking, revisions, receipt bounds, hidden-view safeguards, and existing
   approval semantics while converting views into subscribers/command clients.
5. Enable cross-workspace sends only after provenance and coordinator tests pass,
   then retire the permanent workspace restriction and namespace-local URL lookup.
6. Rollback uses a preserved compatible snapshot or read-only legacy views when
   new state cannot be represented safely. Never let an old writer erase origin
   records, events, or accepted queue receipts.

## Acceptance Gates

| Gate | Required evidence |
| --- | --- |
| Shared identity | A Chat created in workspace A opens by its existing URL in B without a copied history or changed ID. |
| Sending window | A and B contain a distinct same-named fixture; reads/writes/process cwd resolve to the sending window for each request. |
| Immutable context | Change sender roots after enqueue; execution blocks or validates the captured roots, never switches silently. |
| Arbitration | Concurrent sends, revisions, cancellation, and worker takeover produce no lost updates or stale writes. |
| Running input | Same-context steer works at a safe boundary; cross-context steer reports a conflict; tasks retain individual origins. |
| Durable ACK | Disconnect after acceptance and retry: one receipt and one queue item; side effects are not claimed exactly-once after unknown outcomes. |
| Recovery | Kill the execution host, reopen elsewhere, preserve partial output/receipts, and require explicit resume without tool replay. |
| Permissions | Outside-workspace paths, symlink changes, untrusted hosts, and foreign-account requests remain rejected or explicitly approved. |
| Viewer lifecycle | Two viewers receive consistent events; hidden/reopened views do not cancel runs or duplicate work. |
| Compatibility | Existing URLs survive migration; legacy queues and writers cannot invent origins or destroy new records. |
| Resource bounds | Long history, multiple windows, and idle soak tests stay within measured watcher/memory/render budgets. |

These gates are not yet passed. Define explicit measurable resource budgets in the
implementation test plan. Capture client renderer and remote-host diagnostics
separately for live crash acceptance; a packaging test cannot prove an idle
window stays alive. Implement and locally install before any publication decision.