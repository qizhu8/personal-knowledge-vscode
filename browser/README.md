# Browser migration boundary

## Uone Webview release gate

The same-ID package stages the built extension Webview and browser adapter in
`extension/next-runtime/server/browser/`. The packaged HTTP runtime resolves
that fixed location relative to its own code, checks served bytes against the
production payload manifest, and does not consult `PKM_BROWSER_WEBVIEW_DIR`.
The stable VSIX verifier requires the packaged browser bundle and compares its
actual panel HTML, CSS, and JavaScript with the extension's desktop assets.
No extension activation changes or extra browser service are required for an
already configured compatible HTTP runtime. Open `/webview/` on the origin
reported by the packaged `next-runtime/server/dist/cli.js http --data
<isolated-workspace>` or by the packaged shared manager configured for
`standalone-core`; sign in with that service's business token. Requests
use the manager's existing generation, admission, revocation, and receipt
handling; no child credential reaches the browser. The existing browser
client at `/` is unchanged. Source development remains explicitly opt-in:
build both trees, then point `PKM_BROWSER_WEBVIEW_DIR` at the absolute
`legacy/dist/webview` path before starting checkout HTTP.

The qualified shared-manager ABI is `pkm.shared-core-http/v1`. Bare
`pkm.mcp.api/1` still returns unavailable for `/webview/`; a tool catalog or
status relay is not a browser authority.

### Original-backed read route and activation handoff

The packaged runtime exports `createOriginalBrowserRoute` from
`server/dist/browser-original-owner.js`. The Original owner activation can
mount its returned request handler on its exact `127.0.0.1` origin before
generic routing (the handler returns `false` outside `/webview`). Supply a
browser token provisioned for one actor and a pinned grant with `actorId`,
canonical `workspaceRoot`, selected `generation`, and, for Chat, the exact
local `chatHostId`. `assertCurrent(grant)` must check token revocation, actor
access to this root, the live selected gateway and its generation. Supply
`capabilityRead(grant, input)` over the *already bound* gateway: issue only
`capability_read`, reject errors, unwrap the Original tool result, and check
the same grant inside the gateway admission boundary. Dispose the route on
selection change; do not rebuild it by choosing another owner. Installed mode
uses the immutable asset path and does not opt into checkout assets.
This module does not activate a gateway, register VS Code commands, or expose
the MCP credential or a generic MCP endpoint.

The route reads the actual Original Note inventory, lexical search and Note
body, and uses the existing Original Chat Host's IPC receipts to list saved
conversations and display their bounded latest replies when no transcript
callback is installed. To enable transcript sharing, pass the private
`readChatTranscript` returned by `apiChat.bindBrowserChatTranscript(grant,
assertCurrent)` into `createOriginalBrowserRoute`. The browser never requests
the first page automatically: the reader requires native confirmation for
that exact Chat and issues opaque snapshot-bound cursors for later pages.
With this callback, denied or expired pages never fall back to mailbox
replies. This callback is not the tool-approval route.

For text-only turns, activation can also pass `chatTurns:
apiChat.bindBrowserChatTurns(grant, assertCurrent)` alongside the transcript
callback. The browser records the owner's exact Chat/turn IDs before Send,
keeps only those IDs in tab storage, and checks that receipt on reload.
The owner requires native approval for the exact text. Stop targets only that
running turn; an unknown outcome requires inspecting the owning Chat, never
replaying Send. This does not enable public MCP or mailbox writes.

Original `update_note` carries no expected revision/digest;
the browser denies Note writes rather than substituting a read-then-write
check. Ordinary mailbox `send`/`cancel`, Chat creation, and tool review remain
unavailable here. Original tool approvals stay in the
owning Chat webview; browser sign-in grants no approval authority.

On local Linux VS Code with the installed same-ID v5 extension, a trusted
Original root and the selected bundled compatibility gateway, select
**PKM Browser** in the status bar, then **Copy sign-in token and open**. Paste
the freshly issued token into the loopback page. This is a separate,
allowlisted read connection to the same selected Original generation, not a
generic MCP proxy or a standalone Core server. Cold compatibility routing
only; remote hosts are intentionally excluded. With opt-in live switching,
the browser binds to the existing owner through an in-process read grant. It
does not launch a cold adapter or receive relay credentials. Starting a
handoff can revoke that grant; after changing backends, reopen PKM Browser
from the extension and sign in again.
Use **Revoke browser access** in the same picker to close the listener and
invalidate its token and cookies. A change to the trusted workspace, bound
root, or observed owner also closes the binding. Remember does not survive
revocation or VS Code shutdown.

Chat requires the exact native owner in the selected workspace. Transcript
sharing requires native consent. To send from the browser, open the existing
ordinary Chat in VS Code, leave it visible and idle, and set it to **Read-only**.
Each Send needs its own native confirmation; Stop targets only that
browser-admitted turn. Browser Chat creation and review remain unavailable.

The HTTPS listener is a transport component, not a deployment mode. It serves
only `/webview` and never exposes the MCP or management API. The installed
extension still opens only its local loopback listener. Independent access
requires a persistent owner for the same library and Chat permissions;
pointing HTTPS at the current extension-host callback cannot provide Chat
when that host is stopped.

`tests/compatibility-chat-browser.test.mjs` exercises the route against a
disposable Original gateway and production Chat controller running in a test
host. To exercise browser Send and exact Stop as well, set
`PKM_TEST_ORIGINAL_TRANSCRIPT_READER` to the owner's
`legacy/src/chat/browser-chat-transcript.ts` and `PKM_TEST_ORIGINAL_TURN_OWNER`
to the owner's built `legacy/` directory. This uses the real owner writer
and loopback model, with the native modal choice supplied by the fixture.
It supplements, but is not, installed activation qualification.

To run the disposable installed path against a built, hash-pinned v5 VSIX:

```sh
node tests/installed-compatibility-chat.mjs --same-profile-upgrade \
  --bundled-gateway --installed-browser --candidate-vsix="$VSIX" \
  --candidate-sha256="$SHA256"
```

The installed gate requires the actual predecessor Note to appear in canonical
Original search and requires a browser Send and exact Stop after reload.
The fixture gracefully retires its detached 4.0.27 retrieval worker after the
predecessor exits, so 5.0.0 indexes the unchanged predecessor library rather
than querying the old empty corpus. This is safe only in the fixture’s private
profile and process/network namespace: production does not retire other
owners' workers. The fixture opens the persisted Chat and changes its
permission mode through the real Workbench UI, then uses native Send consent
and verifies that Stop closes the held loopback model stream.

The internal Note body edit contract is in `legacy/src/knowledge/filestore.ts`:
`readOriginalNoteBodyForEdit(relative)` returns the body, exact file SHA-256,
and opaque revision; `compareAndSwapOriginalNoteBody(relative, expected, body)`
requires both pins and returns `ORIGINAL_NOTE_EDIT_CONFLICT` on a stale draft.
The owner supplies the exact selected root, actor admission, and path. This
changes only an existing ordinary Note body; it preserves frontmatter and
rejects System Notes, Todo Boards, and legacy Work Item blocks. The opaque
revision is not the YAML `revision` or the Original MCP content hash.

The comparison and replacement hold `markdown-assets.lock` from
`legacy/src/knowledge/markdown-assets.ts`. Desktop `saveNote` and
`KnowledgeContentFileSystem.writeFile` in `legacy/src/extension.ts` use
`noteUpsert`; MCP `update_note` uses `knowledge_mutations.py` and
`knowledge_mutations.js` to call the same locked filestore. The desktop
panel’s draft precheck is separate and does not itself enforce CAS.
GitHub Sync’s live `applyLocalChanges` and `replaceGitHubSyncFilesAtomically`
in `legacy/src/sync/github-sync.ts` now take the same lock for Markdown
areas, including snapshot checks, replacement, deletion, and guarded
rollback. Fetching and checkout staging stay outside the lock. Browser
writes are not enabled: raw `file:` editors, external Git, and older or
otherwise uncoordinated writers can bypass it. Activation must exclude
such writers; a browser-side precheck cannot do that.

The sign-in page exchanges the token for a revocable, path-scoped, HttpOnly
session cookie; remember sets an eight-hour maximum instead of a browser-session
cookie. Sessions are held in memory and die on restart. The token is not stored
in browser storage or passed in navigation URLs. The authenticated page uses the
built `panel.html`, `panel.css`, and byte-identical `panel.js`. The browser
adapter handles only explicit operations, under the same Core actor as the HTTP
host; the cookie is not accepted by `/v1`, management, or human-review routes.
The Webview's inline script handlers and `eval` are not enabled in the browser.
Only the original inline style attributes are admitted for layout.

Notes support list, open, create, edit Markdown content, and literal search,
with at most 100 displayed results. Edits use the original detail's document
ID, revision, and SHA, plus a pinned workspace scan; stale writes fail without
replacing newer content. Title/category moves, metadata-only editing, Board
editing, rich resources, and other desktop surfaces are outside this gate.
On an uncertain Note write the draft stays open; there is no automatic replay.

The Webview's **PKM Chat** button opens `/webview/chat`. It uses the same Core
actor for chat lists, durable transcripts, revision-checked send, and
revision-checked stop. Reload reconnects to the selected conversation; it
does not start a new turn. Generation is unavailable without an admitted
model. Chat links to the existing `/human-review` desk when the host exposes
it. The business session cannot enroll or decide: the human needs the
existing, separately authorized enrollment and exact review policy. Stop
does not roll back effects already dispatched.

Run the release qualification after both builds:

```sh
node --test tests/webview-release-gate.test.mjs tests/batch06-browser.test.mjs
```

For the same-ID packaging check, after `npm run build` and
`npm --prefix legacy run build`, run `node scripts/stage-runtime.cjs stage
--payload`, move the new `next-runtime` under the disposable `legacy/`
packaging root, then run `vsce package` there with
`PKM_PACKAGE_PREBUILT=1 PKM_PACKAGE_NEXT_PAYLOAD_STAGED=1`. Set
`PKM_TEST_BROWSER_VSIX` to the archive path when running
`tests/webview-release-gate.test.mjs`. The test extracts the real VSIX,
verifies its production payload, rejects a changed asset, and runs its
packaged shared manager and staged Core without a development bundle path.

The tests use Chromium via Python Playwright on both standalone and a real
shared-manager loopback origin. They compare served bundle bytes, verify Note
CAS and independent Core/disk readback, and exercise durable send/stop against
an isolated deterministic loopback provider, not a production model.

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
