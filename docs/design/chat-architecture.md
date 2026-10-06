# Chat Architecture

Chat folders, runtime Groups and Tasks are distinct identities. A folder organizes
Chats; a runtime Group identifies a Chat window; a Task is an explicitly started
unit of work. None is inferred from a model reply or a display name.

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

All windows sharing a Knowledge Root enumerate its existing Chat partitions.
Conversation writes compare revisions under a common process lock. Library
updates use a separate atomic file and lock. Trash/delete acquire the conversation
lock first; folder operations never acquire it while holding the library lock.
Stale revisions fail rather than silently merge histories or model settings.

Opening a view is read-only unless a new-format request's recorded same-machine
process is confirmed absent. That recovery marks interruption; it never reruns
tools or the model. Unknown, legacy, remote and live owners are not inferred dead.
Workspace-bound tools reject a Chat opened against a different workspace partition.

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