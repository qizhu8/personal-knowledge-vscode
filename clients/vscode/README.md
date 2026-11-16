# Isolated VS Code client seam

This is not registered, started or imported by the production extension. The server
remains a separately hosted, single-owner process. This client never opens Storage,
starts processes or accesses a Knowledge Root. The host supplies a loopback HTTP
origin, an opaque SecretStorage key (never the token in configuration), the
expected workspace ID, `secrets.get`, and `attestServer`. The latter is a trusted
host callback that must independently bind that endpoint, workspace and authenticated
actor; it must not simply echo user-controlled input. Authenticated `server_info`
must advertise the actual storage workspace ID, authenticated actor, exact
`serverId: "pkm-v5"`, protocol `v1`, and workspace version. Missing or mismatched
identity fails closed; attestation cannot substitute a caller-supplied workspace ID.
The canonical envelope, `/v1` endpoint, workspace schema, catalog
revision and each available operation's version/read/write flag are checked.

The adapter exposes typed, strict request shapes for document list/get/edit with
revision and digest CAS, Chat sessions/turns/events, and Manager overview, events,
targeted feedback and cancellation. `ChatActivity` and `ManagerActivity` report
cursor gaps; the caller must refresh a snapshot and visibly warn that events may
be missing. They never cancel a run. Errors and pending operation IDs appear in
`state()` / `onState`. On uncertain writes the exact body and operation ID remain
in memory and must be explicitly retried; they are not persisted across disposal
or process termination. The host must inform the user of that limitation and
reconcile with server receipts before any replacement request. Different bindings
cannot retry one another's mutations.

Optional integration: create `VscodeClient` with a VS Code SecretStorage adapter
and trusted attestation, call `registerCommands`, and bind each webview using
`bindWebview` with a unique, host-owned source object. The host must map actual
VS Code panel identity to this object; messages cannot supply their own source.
Dispose bindings, command registrations and client on extension shutdown. The
bridge never accepts an operation name, path, endpoint, credential, shell command,
or human review decision as transport authority. Render response text as text.
`openHumanReview` is a separate trusted native-host command only: its injected
callback must obtain an independently authenticated human session and use the
native review queue; no chat/webview message may approve or open that session.

Unsupported relative to the existing VS Code UX: production extension activation
and existing panels, Knowledge create/move/trash/assets/folders and specialized
editing, Manager start/plan authoring, original worker tree controls and streaming
UI, model selection, rich activity details, search, attachments, native approvals
and memory decisions. Chat generation and Manager require server-side native
providers and actor-specific capability discovery. The adapter does not claim
feature parity or perform automatic reconnect, background polling, or replay.

Scoped checks (from repository root, using installed tools):

```
next-server/node_modules/.bin/tsc -p next-server/clients/vscode/tsconfig.json
node --experimental-transform-types --test tests/vscode-client*.mjs
```

## Batch26 scoped Manager lifecycle

This supersedes the **Manager start** unsupported item above, not plan authoring
or native UX parity. `VscodeClient.managerStart` discovers and invokes the actual
`manager.runtime.start` capability with the canonical bounded completion contract
and budget. `managerGet` reads the native runtime; `ManagerWorkflow` in
`workflow-surfaces.ts` scopes start, reconcile, progress, feedback and cancel to
one run. Reconcile retries boundedly when runtime and overview versions differ.
Progress exposes typed pinned worker, integration and verification results,
refreshes snapshots on cursor gaps, and retains an `eventsMayBeMissing` warning.
Worker delivery alone never marks whole-goal acceptance. Feedback uses explicit
version CAS and exact task/result targeting without waiting for other workers.
Malformed mutation responses remain uncertain and retain the exact retry body.

Capability discovery is not native task authorization. The server still owns
planning, worker permissions, integration, verification and acceptance. Neither
chat nor webview input can supply an actor, native owner, permission or human
approval. Native effect recovery, production activation, provider/worker parity,
plan authoring, background polling and durable client replay remain unsupported.
The added E2E uses only synthetic native adapters and a disposable authenticated
loopback HTTP fixture; it is not qualification of a production native provider.

```
next-server/node_modules/.bin/tsc -p next-server/clients/vscode/tsconfig.json
npm --prefix next-server run build
node --experimental-transform-types --test next-server/tests/client-manager-workflow.test.mjs
```
