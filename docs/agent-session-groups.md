# Chat Groups and Tasks

Agent Session MCP capability version 1.8.0 adds one durable Group per
`(host_kind, host_session_id)` within a Knowledge Root.

- `agent_session_start` starts a Task and reuses the chat's Group. Supply the
  stable chat ID, not the MCP connection ID. `host_kind` defaults to `copilot`;
  other adapters must supply their own identifier.
- The compatible Task record remains `pkm.agent.session/v1`. `taskId` equals
  `sessionId`; existing Todo, Recipe, checkpoint, usage, and Trash references
  remain unchanged. Ending a Task does not delete its Group.
- Group bindings live under `.pkm/state/agent-groups/` with schema
  `pkm.agent.group/v1`. Atomic writes and per-Group cross-process locks prevent
  duplicate creation. Membership is derived from Task records, not a duplicated
  list of IDs in the Group.
- Runtime registration idempotently adds binding metadata to existing active
  and trashed Session records without changing their progress, timestamps,
  snapshots, or IDs. Migration failures are logged per record. The UI can
  project compatible group identities before the MCP runtime is regenerated.
- Missing chat IDs produce explicitly **unlinked** Tasks, never one shared
  unknown-chat Group. `agent_session_resume` accepts `host_session_id` and
  `host_kind` to bind an unlinked resumable Task. It rejects moving an already
  bound Task to another chat; use Snapshot recovery for an independent copy.
- Snapshot recovery uses the destination chat binding, not the source Group.
  Checkpoint Package imports are initially unlinked; resume with the destination
  chat ID to bind them. Resuming without a destination keeps the existing binding.
- Empty Groups offer **Delete Chat Group** in their context menu and row action
  button. Populated Groups offer the same confirmed command, but the backend
  requires moving their Tasks to Trash first. Running Tasks must be stopped
  explicitly; deleting a Group never stops work or deletes a Copilot conversation.
- Deletion atomically retains a `deletedAt` marker under the per-Group lock.
  Deleted metadata is excluded from the tree and Group count. Runtime migration
  and restart preserve this marker, so retained Trash history cannot recreate
  an empty Group. Task, Todo, Recipe and checkpoint evidence remain unchanged.
  Explicitly starting or restoring a Task can display its original Group binding
  again; migration alone cannot. Visible counts include empty retained Groups
  and deduplicate Groups already represented by Tasks.

Automation > Agent Sessions displays **Chat Groups > Tasks**, independent of
Agent names. Task details retain the existing Session controls and graph, with
Group and Task identities shown explicitly.

The [independent API Chat](api-chat.md) owns native `hostKind: pkm` Sessions with
explicit `origin: pkm-native` and `runtimeOwner: pkm`. Tasks are optional and
explicit; casual Chat turns do not automatically create Tasks or Todos.
Existing external host records are projected without rewriting
them; ambiguous legacy origins remain unknown. Source labels do not imply that
external host runtimes are controlled by PKM.

This release does **not** add Group Memory editing, Task context retrieval,
context budgets, host AIU ingestion, or true model-context isolation. Those need
separate storage/retrieval/execution integration and quality/cost validation.

## Validation

```sh
npm run build
node tests/test-agent-session-lifecycle.js
node tests/test-four-workspace-ui.js
python tests/test-agent-session-groups.py
python tests/test-agent-session-mcp-runtime.py
```

Alternatively run `npm run test:agent-session-groups` with that Python on `PATH`.

Use the existing MCP Python environment (with FastMCP and cryptography) for the
Python scripts. Group tests cover process concurrency, migration and restart,
Agent-independent grouping, separate host namespaces, unlinked binding and
rejection of conflicting or corrupt bindings. Runtime tests cover Snapshot and
checkpoint compatibility.
