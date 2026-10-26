# Chat Groups and Tasks

Agent Sessions are owned by **PKM Chat only** (Agent Session MCP capability
version 2.0.0). External agents (Copilot, Claude, and other MCP clients) can no
longer start, resume, checkpoint, stop, end, or manage Todos of an Agent Session.
Support for them was retired because the external lifecycle could not be
controlled reliably and gave no clear benefit over the agent's own planning.

- A PKM Chat Task is a native `pkm.agent.session/v1` record with
  `origin: pkm-native`, `runtimeOwner: pkm`, and `hostKind: pkm`. `taskId`
  equals `sessionId`. Tasks are optional and explicit; casual Chat turns do not
  create Tasks or Todos.
- Automation > Agent Sessions shows **Chat Groups > Tasks** for PKM Chat only.
  Each PKM Chat is one Group; Library categories label it without changing its
  identity.
- The Agent Sessions category-tree sidebar defaults to collapsed. An explicitly
  saved expanded preference is preserved. Inside the tree, categories and Chat
  branches also start collapsed until the user expands them; choices survive
  normal view refreshes. Empty Chat leaves still have no false expand control.
- When the panel first loads a Knowledge Root, every existing external
  (non-PKM) Session record of any status moves to Agent Sessions Trash. All
  external MCP transport mappings (`agent-sessions/active/*.json`) are removed.
  The records are kept (not deleted), so their history stays readable. Normal
  Trash retention and permanent deletion still apply. External Sessions cannot
  be restored from Trash. Retired external Group bindings are no longer shown.
- Empty Groups offer **Delete Chat Group**. Populated Groups need their Tasks
  moved to Trash first. Deleting a Group never deletes the PKM Chat conversation.
- Chat entries use one compact line: icon, ellipsized title, inline Portal status
  and Task count. Full titles and the empty-Chat explanation remain available
  on hover, instead of inheriting the multi-line Task-card button layout.
- Chats without Tasks remain visible with their Chat icon and **0 Tasks** count,
  but have no expand arrow or empty expandable body. Library categories and
  Chats with Tasks or worker Chats remain expandable; Task rows remain leaves.
- Chat metadata, Library placement and Group changes invalidate the Agent
  Sessions view automatically, including Chats created in another workspace
  namespace of the same Knowledge Root. History-segment directories are not
  watched for this tree; message bodies are not needed to discover a Chat.
- Tree counts explicitly say **Tasks**: `0 Tasks` means no managed Task beneath
  that Chat, not zero messages, calls or execution. Use the Chat Group actions'
  **Open PKM Chat** to inspect its conversation and Chat-only Visualization
  without creating a Task.
- The **Portal** tree filter supports All Chats, Controller, Controlled,
  Connected and No Portal role. Role labels use the Chat Group's Portal binding
  even when it owns Tasks. Ancestors can remain for worker-tree context.
  **Portal Connections overview** opens the separate live/history pairing tab;
  it shows this machine's recorded pairings, not a global network registry.

## Agent Snapshots

Snapshots are created from **Automation > Agent Snapshot**. They are immutable,
locally obfuscated captures (fixed local `uone` key, not encryption against
another user of this machine).

- A **PKM Chat Snapshot** captures the Session (task, todos, checkpoints), its
  conversation, and the whole Recipe tree: top-level runs, runs referenced by
  `recipeTreeEdges`, and nested child runs. Execution receipts are never
  captured.
- An **external Snapshot** (created before external Sessions were retired)
  contains only task, todos, and checkpoints. It has no Recipes and no
  conversation.
- **Any agent can read a Snapshot.** The MCP tools `agent_session_snapshot_list`
  and `agent_session_snapshot_read(magic_code, recent_messages=12)` are
  read-only. Reading creates no Agent Session and changes no state. A read
  returns task, todos, checkpoints, and the latest checkpoint state. For PKM
  Chat Snapshots it also returns Recipe run node states and up to 50 recent
  messages. **Copy Read Prompt** puts a prompt for this call on the clipboard.
- **Recover into New PKM Chat** creates a new PKM Chat with its own Task:
  - For PKM Snapshots, the conversation is restored. Streaming replies become
    interrupted and running tool calls become failed.
  - Recipe runs are cloned with fresh IDs. Running nodes restart as pending,
    receipts are cleared, and parent/child links are remapped.
  - Running or paused todos become pending.
  - A continuation todo is added when nothing is left unfinished.
  - The Session records `provenance.snapshotId`, and the Snapshot's recovery
    count increases.
  - The source Snapshot and its source runs are never modified.

The retired "Create Agent Snapshot" built-in Recipe is removed from installed
Recipe Libraries.

Group Memory editing, Task context retrieval, context budgets, and true
model-context isolation are not part of this feature.

## Validation

```sh
npm run build
node tests/test-agent-session-lifecycle.js
node tests/test-four-workspace-ui.js
node tests/test-agent-snapshots.js
node tests/test-agent-session-pkm-only.js
python tests/test-agent-session-mcp-runtime.py
```

Alternatively, run `npm run test:agent-session-groups` with the MCP Python
environment (FastMCP and cryptography) on `PATH`. `test-agent-session-pkm-only.js`
covers:

- external Session retirement and its idempotence
- the Trash restore guard
- Recipe-tree capture
- Python reads of TypeScript-created Snapshots
- recovery into a PKM Chat
