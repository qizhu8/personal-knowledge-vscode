# Browser migration boundary

The Browser Knowledge surface uses only capabilities advertised by the authenticated
native host. Literal Note, Skill, and Research search is read-only; results are
opened through the corresponding Core read operation and checked against the
search/list snapshot and source digest. A missing capability stays unavailable.
This is not a completion claim for the Browser workstream.

## Source-compatible offline entry

The existing extension's Library search is a different, richer path:
`src/webview/panel/21-search.js` sends `knowledgeSearch`; `src/extension.ts`
queries the ready retrieval-worker generation, resolves each hit with
`panelSearchTarget`, and the selected hit opens through the panel's native detail
request. The existing detail **Browser** action in
`src/webview/panel/20-knowledge.js` sends `exportNoteHtml` with `mode: "browser"`;
the extension renders the current Note with `buildStandaloneNoteHtml` and opens
that standalone page. `src/mcp/mcp.ts` also exposes the existing `search_notes`, `search_skills`,
`search_knowledge`, `get_note`, and `get_skill` tools. Those routes retain the old
retrieval/Chat behavior and are not replaced or redefined by this Browser.

The portable offline Browser entry is the static page loaded by
`next-server/src/http.ts` through `browser-host.ts`. It uses the authenticated
loopback server's existing public `capability_read` entry for the original
`knowledge.note.search` / `knowledge.note.get`, `knowledge.skill.search` /
`knowledge.skill.get`, and `knowledge.research.search` operations, then reads the
canonical document by its returned address. These literal, source-pinned reads
are not semantic-retrieval parity and do not imply the old remote/Chat services
are available. No extension command, shared Core registration, or new MCP
operation is introduced by this client slice.

The isolated end-to-end regression is `node --test
tests/browser-knowledge-search-e2e.test.mjs` from `next-server/` after the
TypeScript build and with the migration test Python Playwright/Chromium environment.

## Legacy Chat Browser remains unsupported

The legacy Chat Room browser in
[`src/chatroom/chatroom-browser.ts`](../../src/chatroom/chatroom-browser.ts) is a
live WebSocket participant, not a local Knowledge reader or an HTTP/MCP Chat client.
It accepts a host-generated `pkchat:v1` invitation, locally verifies its checksum,
then uses the invitation's Room URL and secret to join, exchange messages, and
send file chunks. Its browser `cid` is stored in `localStorage` (with a random fallback).
[`src/chatroom/chatroom-hub.ts`](../../src/chatroom/chatroom-hub.ts) listens on the
host's network interface and checks
the Room secret before joining; it explicitly treats browser identity as
unverified/best-effort (`verified = conn.kind !== "browser"`). The standalone
Browser does not implement that Room lifecycle, invitation, identity, approval,
WebSocket, or peer-file transport. Reconnect is therefore unsupported; no new
Room protocol or identity authority is introduced here.

The legacy API Chat retrieval-feedback action is also not a generic Browser
operation. [`src/chat/api-chat-view.ts`](../../src/chat/api-chat-view.ts) requires the selected Chat, a trusted
workspace, a successful retrieval receipt with a `retrievalId`, ready semantic
retrieval with online learning enabled, and explicit complete relevance judgments.
It submits feedback through the native retrieval worker and accepts success only
when [`src/chat/chat-retrieval-learning.ts`](../../src/chat/chat-retrieval-learning.ts) validates the persistent ranker and
calibrator revision acknowledgment. The standalone Browser has no source-compatible
authority for that receipt or learning state, so it must not submit or claim
retrieval feedback. Native Manager feedback is a separate capability and does not
establish Chat-retrieval parity.
