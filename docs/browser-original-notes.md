# Private Original Notes browser bridge

`bindOriginalBrowserNotes` in the legacy runtime binds one explicitly authorized
Original filestore root. It does not import, copy, migrate, or call v5 Core.
Native consent supplies `root`, `expiresAt` (no more than 24 hours),
`allowWrite`, `assertCurrent()`, and `withWriter(work)`.

Pass its returned callback as `originalNotes` to `createOriginalBrowserRoute`.
Keep the callback's immutable `allowWrite` property when passing it through:
the server uses it to mark the existing adapter's Create control as authorized.
Read-only consent leaves Create disabled; edit controls require a returned CAS
pin. This presentation hint never replaces server-side write checks.
Only `list`, `detail`, `saveNote`, and `updateNote` reach this private callback.
The ordinary existing `/webview/` Notes page becomes available even for a
detached Chat owner. This does not broaden the detached Chat ID: Chat listing,
transcript access, and turn controls retain their original pin.

Reads use actual `noteList`, `noteSearch`, and `noteGet`. Writes require separate
native read-and-write consent. Creates use the ordinary title-derived filename,
atomically refusing an existing file under the shared Markdown-assets lock.
Body edits use the Original filestore's exact-byte SHA/revision CAS, preserving
metadata and refusing stale desktop or MCP drafts. Todo Board bodies and Work
Item-bearing Notes do not receive ordinary body-edit capabilities.

Edit handles are random, server-private, and map to the existing browser numeric
revision schema; at most 512 handles are retained. The session remembers at most
512 mutation operation IDs, including failures. Matching replays return the
recorded outcome; changed payloads are refused. A restart loses these handles:
there is no automatic write retry or durable generic replay mechanism.

All commands recheck expiry, revocation, selected-root identity, and browser
authorization. Writes also recheck within writer admission and the filestore
lock. Reads refuse symlink/hardlink traversal, inspect at most 10,000 entries
with maximum depth 32, and bound Markdown input to 512 KiB per document and
32 MiB per traversal. Lists return at most 500 entries (search: 100); callers
must narrow searches for larger collections. Errors never expose filestore
paths. Unknown mutation outcomes require checking the library before retrying.

This is bounded Notes access, not full library parity: Skills, Papers, arbitrary
filesystem operations, generic MCP, asset editing, and Work Item commands are
not exposed.

Focused validation (compile both roots before running the JS tests):

```sh
npx tsc -p tsconfig.json --noEmit
npx tsc -p legacy/tsconfig.json --noEmit
node --test legacy/tests/test-browser-original-notes.js legacy/tests/test-original-note-body-cas.js tests/browser-original-notes.test.mjs
```

The TLS test uses a disposable, project-local Original store and the actual
existing Webview bundle. It verifies same-store create/body edits and independent
pinned Chat; it is not installed VS Code-close acceptance evidence.
