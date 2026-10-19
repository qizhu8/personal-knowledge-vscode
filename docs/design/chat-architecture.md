# Chat Architecture

Chat folders, runtime Groups and Tasks are distinct identities. A folder organizes
Chats; a runtime Group identifies a Chat window; a Task is an explicitly started
unit of work. None is inferred from a model reply or a display name.

## Proposed Memory Management Engine

The [Memory Management Engine design](memory-management-engine.md) records the
2026-10-19 requirements and proposed SQLite-backed graph, append-only statements,
Lazy Summary, structured context access and low-level-first LRU. It is a design
proposal, not a description of the current recall implementation. It also
proposes Agent Sessions as the primary workspace for four linked visualizations;
the existing inline Chat panel remains current behavior until that transition
is implemented and verified.

## Owners

| Responsibility | Module |
| --- | --- |
| Shared folder/placement metadata and its lock | `src/chat/chat-library.ts` |
| Folder, move and Trash dialog orchestration | `src/chat/library-actions.ts` |
| Bounded read-only local knowledge lookup | `src/chat/knowledge-reader.ts` |
| Conversation validation, revisions, request recovery and native Task binding | `src/api-chat-store.ts` |
| Request lifecycle, approval state and VS Code view integration | `src/api-chat-view.ts` |
| Direct HTTP transport | `src/api-chat-client.ts` |
| Native model discovery, budgets and streaming adapter | `src/api-chat-vscode.ts` |
| HTTP/native MCP catalog and invocation guards | `src/api-chat-mcp.ts` |
| Approved workspace edit/save/process tools | `src/api-chat-tools.ts` |
| Fail-independent real-provider acceptance and receipts | `src/api-chat-acceptance.ts` |
| Two-level navigation and message rendering | `src/webview/api-chat.js` |
| Folder tree, context menu and drag/drop rendering | `src/webview/api-chat-library.js` |

The established public module paths remain stable. This refactor extracts the
new Chat-library domain and knowledge reads; it does not relocate unrelated
retrieval, Chatroom or workflow implementations. Request orchestration remains
in the view controller and is a future extraction boundary, not a claimed
completed repository-wide rewrite.

## Persistence And Ownership

### Hidden Chat views

Background runs continue when the user switches to native VS Code Chat, but
hidden Webviews do not receive state projections or streaming deltas and do not
rebuild controls. A visibility listener publishes the current snapshot on return;
it is disposed with its owning view and cannot publish into a replacement view.
Memory rendering is additionally deferred until its panel is open.

The 3.2.51 acceptance exercised 60 native Chat switches across four isolated
Linux VS Code windows and one restarted window, with no model calls. This
verifies the background-rendering fix, not the sole cause of an unobserved
Windows renderer crash or performance with the user's full live history.

### Task-aware recall

Current task goal, constraints, acceptance criteria, open questions, active
subgoals and failed verification contribute to memory recall. Superseded/closed
Steps and rejected or ignored plans do not supply active query hints.
Relevant latest user instructions are retained before selecting
other evidence; duplicate original chunks cannot occupy multiple recall slots.
Remaining slots prefer query-term coverage, then relevance, task and recency.
Tool name, status and arguments participate in deduplication so failed outcomes
and distinct scopes are not collapsed. History off still disables recall.

### Recall authorization and retention

The default automatic scope is the current Chat plus its descendants in the
persisted worker tree. It does not include a worker's manager, siblings, unrelated
Chats, or all Chats sharing a workspace. Completed spawned workers remain
available through their receipt-validated archives; releasing concurrent
capacity does not erase their evidence or reset its age. Assigning a pre-existing
Chat as a worker does not implicitly authorize that Chat's unrelated history.
A new worker receives its own default policy, never its manager's explicit
memory grants.

Memory settings can explicitly grant Chat, workspace, runtime Group or Project
sources. Each grant records the current approved Chat identities: future members
do not silently acquire access. Runtime Groups are not Chat-library folders.
Exclusions override grants and worker ancestry. Both consumer and source must
have History enabled, and the source must remain outside Trash.

The default recall window is 30 days. Message timestamps, tool execution times
or response times are used when available. Legacy undated messages use the
Chat's creation time conservatively; an old Chat does not acquire recent
evidence timestamps merely because it was opened or saved. The UI allows 7,
30, 90, 365 days or all time. Unknown dates are not admitted into a bounded
window.

Clear derived recall advances a reversible, consumer-owned cutoff. It does not
delete or rewrite original messages, tool results, knowledge, receipt history or
global indexes. Restore earlier recall removes that cutoff; the selected window
and source permissions still apply. The cutoff also applies to worker and
explicitly granted source evidence.

Automatic references are checked against current storage during planning and
again immediately before transport dispatch. Revocation, History off, Trash,
changed bytes or an expired/cleared window cannot silently reuse a prepared
reference. Other Chats' user messages remain untrusted system references, not
new user instructions or inherited tool permissions.

Transport receipts distinguish prepared payloads from provider-confirmed sent
payloads. Confirmation is recorded only after HTTP/native provider acceptance;
it does not certify response completion or task success. A failed dispatch with
no acceptance confirmation remains prepared/failed, not proof that no network
bytes were transmitted. Memory rounds retain the matching phase and selected
identities, separate from input-token estimates and reported usage.

All windows sharing a Knowledge Root enumerate its existing Chat partitions.
Conversation writes compare revisions under a common process lock. Library
updates use a separate atomic file and lock. Trash/delete acquire the conversation
lock first; folder operations never acquire it while holding the library lock.
Stale revisions fail rather than silently merge histories or model settings.

Opening a view is read-only unless a new-format request's recorded same-machine
process is confirmed absent. That recovery marks interruption; it never reruns
tools or the model. Unknown, legacy, remote and live owners are not inferred dead.
Workspace-bound tools reject a Chat opened against a different workspace partition.

Chat URLs arriving before the Webview attaches retain a pending selection.
The ready handshake applies it to the real conversation and opens the Chat
screen; it must not be lost as an early `showChat` message sent without a view.

The controller retains trust and per-call knowledge approval. The knowledge reader
does not execute Recipes, migrate storage or expose arbitrary filesystem paths.
Chat Trash removes conversation records only; Task and Group evidence remain owned
by the Session runtime.

## Verification

`tests/test-api-chat.js` covers shared partitions, stale writes, actual two-process
contention, live/dead request owners, Group/Task independence, knowledge approvals,
transport/tool guards and acceptance failure isolation. Its scripted acceptance
regression executes an unchanged Node fixture but is not a real model E2E run.

`tests/test-agent-session-lifecycle.js` covers Session lifecycle behavior.
Packaging requires every Chat UI asset and isolated bundled dependency loading.
Real provider acceptance still requires the installed build to be loaded and
explicit model/tool approvals; public API credit totals are not fabricated.

The E2E command now invokes `runFixtureChatAcceptance`: select a real Copilot
model, then run synthetic tail-evidence/shared-condition and coding probes.
The temporary per-Chat retrieval override replaces the production retriever
only during each probe and is removed in `finally`; it is not persisted as a
permission or inherited by other Chats. History, attachments, agent context,
MCP servers and native tool selections are cleared for the fresh fixture Chat.
The fixture's synthetic L1 parent is explicit; this is not a real worker-ranking
quality test. It does exercise the materializer, measured planner, transport and
confirmed-sent receipts. The coding probe requires successful edit/save/process
tools, exact Node test invocation and unchanged fixture test bytes.
Evidence failures do not skip coding; no failed operation is automatically
retried. Reports retain actual usage when supplied and null credits when absent.
Scripted runner and actual loopback-controller tests verify isolation, but cannot
be reported as a successful real-provider run.

## Multiple windows and local endpoints

PKM Chat's Webview communicates with its owning Extension Host through VS Code
messages, not a fixed TCP listening port. Every Host's control mailbox has its
own random identity; closing one does not unregister another. Knowledge-root
conversation/library locks and revision guards remain shared.

The retrieval worker is shared. Its startup/transition lock now uses the same
atomically published, nonce-owned directory lock as other cross-process owners.
The previous exclusive-file-then-PID-write sequence exposed an empty record:
another Host could mistake it for a dead owner, unlink it and enter startup
concurrently. A deterministic four-process regression preempts that creator and
reproduces the old overlap. Incomplete legacy locks fail explicitly rather than
being stolen. Host expectations, worker version and the managed runtime wheel
must agree; otherwise cold startup can keep waiting for a version that will
never be returned.

The worker and browser Workbenches bind loopback port **0**, allowing the OS to
assign a free port. The independent PKM Sync service uses an account-private
Unix socket/Windows pipe scoped to canonical Knowledge Root and global storage,
not a Chat TCP port. The separately configured Servers proxy keeps its stable
port: same-root windows verify and reuse its identity, an unrelated listener
is reported rather than replaced, and survivors can take over after the owner
closes. It is not appropriate to allocate a different fixed Chat port per window
or kill a process merely because its port is occupied.

`npm run test:chat-multi-window` includes the lock repro, four-process proxy
reuse/owner exit and unrelated-port ownership, then four **actually installed**
VS Code Hosts sharing Knowledge Root and physical extension storage. A barrier
opens Chat concurrently, exercises repeated open commands and a cold PKM Chat
URL, checks the real Electron Webview's health round trip, and verifies one
actual retrieval worker PID/port. One window exits and restarts while the other
three remain responsive. RSS and timings are recorded, not claimed as a
universal resource SLA. The fixture is read-only/offline, sends no model request,
and explicitly shuts down its own worker/service before deleting temporary data.

Use `PKM_PLAYWRIGHT_PATH` for an existing Playwright installation,
`PKM_CHAT_TEST_PYTHON` for an interpreter with the existing MCP dependencies,
and optionally `PKM_CHAT_VSCODE_VERSION`/`PKM_CHAT_WINDOWS_REPORT` for a pinned
VS Code runtime and JSON evidence. The test creates an isolated system-site
venv and installs only the bundled retrieval wheel offline. Linux Xvfb/installed
Host results do not certify Windows/Remote or identify the user's historical
freeze without corresponding logs.