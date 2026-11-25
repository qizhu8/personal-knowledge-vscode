# Browser migration boundary

The Browser Knowledge surface uses only capabilities advertised by the authenticated
native host. Literal Note, Skill, and Research search is read-only; results are
opened through the corresponding Core read operation and checked against the
search/list snapshot and source digest. A missing capability stays unavailable.
The configured standalone-Core shared manager serves the same surface at its
stable origin. An original-tool-only MCP proxy does not provide these Core
contracts or implicitly enable Chat.

## Mutation ownership across connections

The Browser binds each pending mutation to the authenticated workspace and actor
that admitted it. It reserves the exact request before sending, rejects another
mutation while that request is unresolved, and never automatically replays it.
Changing credentials or disconnecting does not turn an uncertain write into a
safe new request.

An explicit retry is available only after reconnecting to the same workspace and
actor, with no request still in flight. Replies from an obsolete connection must
not update the newly connected workspace's state. If the identity differs,
reconcile the original server's receipts before submitting replacement work;
the Browser must not send the retained body to the new identity.

Reload recovery retains bounded, nonsecret pins: workspace, actor, operation,
UUID and body hash. Tokens and request bodies are not persisted. A retained pin
blocks replacement writes; reloading is not a retry or proof that the original
request failed.

For supported Core mutations, `operation.receipt.get` checks the actual
actor-private receipt and its durable transport-hash/canonical-fingerprint
binding. Only an exact committed match clears an orphan pin and refreshes
server state. Missing, mismatched, pending or unsupported receipts remain
unknown. Lookup never replays work or invokes recovery. An explicit identical
retry requires the original request still to be available in memory; an orphan
pin cannot reconstruct that body.

## Native Chat continuity

Selecting a Chat or using its **Reconnect updates** button reloads the
server-owned transcript and pages `chat.turn.list` oldest first. An active turn
is reattached using read-only snapshots and events, never restarted. After a
terminal turn, the transcript is refreshed from the server; live assistant output
is replaced rather than appended a second time. Cancellation displays the native
status and does not promise rollback of in-flight effects.

Send passes the selected session revision and exactly one new user message.
Context and durable user/assistant observations belong to the server; the Browser
neither sends its rendered transcript as context nor calls transcript append.
Concurrent transcript changes trigger a bounded snapshot reload. Missing
continuity reads or generation/model authority disables Send; no model catalogue
or successful generation is fabricated. After a full page reload, authenticate
again and select the Chat to recover its durable state.

Acceptance checks ownership, archive/revision state and transcript capacity
before provider effects. Accepted input, turn intent and transcript reservation
are durable; terminal output is recorded once. Cancelled-but-running provider
and tool promises continue blocking handoff until actual retirement. Late
completion cannot overwrite terminal transcripts. Restart records interruption,
not another model or tool invocation.

Provider/model/tool/secret policy comes from the configured native host, not a
static Browser model list. Server transcript IDs, revisions, sequences and
hashes identify actual context. Retrieval availability does not prove prompt
injection; explicit `not-injected` reasons remain visible. Read-only execution
and tool evidence can link to existing Manager views without inventing a Task
binding or claiming acceptance.

Canonical Browser regressions include
`tests/browser-client-regression.test.mjs` and
`tests/browser-knowledge-search-e2e.test.mjs`. Actual Python Playwright/Chromium
checks remain separate from contract fixtures. Deterministic providers do not
qualify a production account, the official SDK catalogue or the legacy Room
transport below.

## Shared-service management

Management is separate from the business connection. It uses an in-memory
management credential, the pinned service UUID and explicit, expiring approval
for an exact action/target. Verified candidates, actual status and controls use
the existing manager, not a second Browser supervisor. Preparing a runtime is
an explicit administrator provisioning step.

Switching retains the stable origin and shared selection. Index reset affects
only the separated Fresh Note database. Unknown outcomes are not permission to
retry, clear a pin locally or roll back user data. Human-review enrollment is a
separate one-use channel; a business token cannot impersonate it. The listener
remains loopback-only, with one configured local actor rather than invented
per-client principals.

## Source-compatible offline entry

The existing extension's Library search is a different, richer path:
[`legacy/src/webview/panel/21-search.js`](../legacy/src/webview/panel/21-search.js)
sends `knowledgeSearch`; `legacy/src/extension.ts`
queries the ready retrieval-worker generation, resolves each hit with
`panelSearchTarget`, and the selected hit opens through the panel's native detail
request. The existing detail **Browser** action in
[`legacy/src/webview/panel/20-knowledge.js`](../legacy/src/webview/panel/20-knowledge.js)
sends `exportNoteHtml` with `mode: "browser"`;
the extension renders the current Note with `buildStandaloneNoteHtml` and opens
that standalone page. `legacy/src/mcp/mcp.ts` also exposes the existing `search_notes`, `search_skills`,
`search_knowledge`, `get_note`, and `get_skill` tools. Those routes retain the old
retrieval/Chat behavior and are not replaced or redefined by this Browser.

The portable offline Browser entry is the static page loaded by
[`src/http.ts`](../src/http.ts) through
[`src/browser-host.ts`](../src/browser-host.ts). It uses the authenticated
loopback server's existing public `capability_read` entry for the original
`knowledge.note.search` / `knowledge.note.get`, `knowledge.skill.search` /
`knowledge.skill.get`, and `knowledge.research.search` operations, then reads the
canonical document by its returned address. These literal, source-pinned reads
are not semantic-retrieval parity and do not imply the old remote/Chat services
are available. These literal readers do not redefine the original MCP APIs.

Run the isolated end-to-end regression from the repository root with the
existing Python Playwright/Chromium environment:

```sh
node tests/framework/run.cjs --file tests/browser-knowledge-search-e2e.test.mjs
```

## Legacy Chat Browser remains unsupported

The legacy Chat Room browser in
[`legacy/src/chatroom/chatroom-browser.ts`](../legacy/src/chatroom/chatroom-browser.ts) is a
live WebSocket participant, not a local Knowledge reader or an HTTP/MCP Chat client.
It accepts a host-generated `pkchat:v1` invitation, locally verifies its checksum,
then uses the invitation's Room URL and secret to join, exchange messages, and
send file chunks. Its browser `cid` is stored in `localStorage` (with a random fallback).
[`legacy/src/chatroom/chatroom-hub.ts`](../legacy/src/chatroom/chatroom-hub.ts) listens on the
host's network interface and checks
the Room secret before joining; it explicitly treats browser identity as
unverified/best-effort (`verified = conn.kind !== "browser"`). The standalone
Browser does not implement that Room lifecycle, invitation, identity, approval,
WebSocket, or peer-file transport. Reconnect is therefore unsupported; no new
Room protocol or identity authority is introduced here.

The legacy API Chat retrieval-feedback action is also not a generic Browser
operation. [`legacy/src/chat/api-chat-view.ts`](../legacy/src/chat/api-chat-view.ts) requires the selected Chat, a trusted
workspace, a successful retrieval receipt with a `retrievalId`, ready semantic
retrieval with online learning enabled, and explicit complete relevance judgments.
It submits feedback through the native retrieval worker and accepts success only
when [`legacy/src/chat/chat-retrieval-learning.ts`](../legacy/src/chat/chat-retrieval-learning.ts) validates the persistent ranker and
calibrator revision acknowledgment. The standalone Browser has no source-compatible
authority for that receipt or learning state, so it must not submit or claim
retrieval feedback. Native Manager feedback is a separate capability and does not
establish Chat-retrieval parity.
