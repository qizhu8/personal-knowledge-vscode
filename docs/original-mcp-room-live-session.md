# Owner-side Room live-session orchestrator

`src/original-mcp-room-live-session.ts` composes the existing dedicated Room
authority, canonical persistence, user-link ingress and fixed signed native
methods. It introduces no caller-supplied transport/approval callback, no new
Room database/engine, no model execution and no native credential getter.

Shared schemas/router/attachment/cold and installed harnesses are parent-owned
and were not edited by this checkpoint.

Parent integration now routes the bounded live leaves through the actual public
dispatcher before its generic request scope and forwards the stable call ID.
The cold component exposes `openRoomLive`/`roomLive` and drains the selected
resource before closing its native attachment. The bounded actual-editor and
B1/fresh-B0 recovery journey has passed; see
[installed acceptance](./installed-native-room-live.md). Broader Room parity
and production cutover remain unqualified.

## Fixed API

```ts
openOriginalMcpRoomLiveSession(
  owner, host, actualAuthenticatedSession, roomAuthority, roomId,
  { port, alias, postText },
  { directory, signal? },
): Promise<OriginalMcpRoomLiveSession>

getOriginalMcpRoomLiveSession(storage, host):
  OriginalMcpRoomLiveSession | undefined

resource.invokePublic(tool, args, signal?, callId?):
  Promise<Readonly<{ result: string }>>

resource.close(): Promise<void>
```

The names match the proposed parent API. Static classification is also exported
as `originalMcpRoomLivePublicTools`; it grants no authority. The source must already have been
independently admitted by the genuine Room authority; opening does not silently
admit source. It uses that authority's real `proveHost`, then the real separate
`approveOriginalRoomLoopbackSession`, same-Storage canonical persistence/server,
and `requestOriginalMcpNative` for the fixed methods.

`directory` must already be an empty canonical owned 0700 directory, disjoint
from the knowledge Root, with a short enough path for the existing Unix socket
port. The orchestrator removes its own socket through the existing transport
cleanup, not the caller's directory or unrelated files.

Read-only exposed fields are `kind`, `roomId`, `state`, `sessionId`,
`effectSha256`, `endpoint`, `expiresAtMs`. There is no transport descriptor,
token, Storage/host/session/grant object, context or model output on the
resource. Public results are only the exact original `{result:string}` wrapper.

## Lifecycle and registry semantics

- The actual RootOwner/full Storage, branded native host, branded authenticated
  session, Room authority, root/workspace/custody/catalog/profile/broker/epoch
  and complete native open response are checked.
- All four actual support methods must exist before requesting Host/effect
  permissions. Advertisement remains availability, not authority.
- A same-Storage reservation is registered while opening. Concurrent opens
  cannot silently replace it or accidentally reuse a different host.
- State is `opening`, `active`, `closing`, `closed`, `expired`, `revoked` or
  `uncertain`. Invocation during opening/after close fails without fallback.
- Effect/source/Host/session/caller cancellation closes admission, revokes the
  effect, stops Core writes and drains signed work, native cleanup and the
  canonical port. The persistent Core watch is the real native network
  revocation path.
- Cleanup's native close authenticates with the **base attachment**, not the
  expired effect or cancelled request signal. Explicit close therefore remains
  valid after effect expiry while that attachment is live.
- Automatic expiry/revocation retains a non-routable **tombstone resource** in
  the registry. `get` must not turn it into `undefined` and fall back to a
  no-joined-client status/legacy path.
- A successful explicit close clears a non-uncertain selection. A previously
  held resource still rejects calls after removal.
- Cancellation/transport/handler failure **after a native operation was sent**
  is conservatively uncertain. Core receipts may prove an actual committed
  post, but the owner does not invent an original success response. The
  uncertain tombstone survives explicit network cleanup and blocks another
  open; reconciliation/owner recovery is separate.
- Known public-approval denial before forwarding does not poison an otherwise
  active session. Raw pending user-link ingress is discarded.
- Failed preflight/Host/effect approval before a native open was sent cleans its
  reservation without pretending that an active session exists.

`get(storage, host)` returns only that same Storage/host's selected resource.
It rejects a different host when a selection exists. It intentionally does not
re-prove an expired effect merely to locate the resource for cleanup.

## Public tools and exact authorization

Supported leaves are only `chat_join`, `chat_read`, `chat_status`, `chat_leave`,
and the already bounded **progress-post** `chat_post`.

For read/status/leave/progress-post, the orchestrator parses the existing
bounded original argument DTO, preserves its values/default behavior, requests
the normal fresh native public approval for the exact tool/arguments/digest,
then sends `room.session.invoke`. It does not silently make a final/default
post into `continue_working:true` or `require_reply:false`. Unsupported/final
posts and a different progress text fail before public approval or execution.

For **unchanged public `chat_join(magic_link, name)`** it:

1. Prepares the existing branded transient ingress.
2. Requests actual current native public approval using its safe descriptor,
   binding the entire original input digest without showing/logging the link.
3. Consumes the link at most once and sends `room.session.join`.
4. For the same call ID/input, sends only the safe replay call through
   `room.session.invoke`; the canonical receipt returns the exact original
   result without reconnecting or reforwarding the link.

Use the optional stable UUID `callId` for a true retry of a forwarded call.
Normal new attempts use a new ID. Failed/denied attempts do not authorize a new
participant or endpoint, and interrupted outcomes are never retried
automatically. The existing effect/endpoint/new-agent constraints remain.

The orchestrator serializes its public calls and binds caller cancellation to
the actual approval/native request. It returns no reconstructed business JSON.
No raw link enters its registry fields, approval descriptor or Core call
arguments; there is no owner-side response/model cache.

## Parent routing/composition

The parent supplies its already-admitted same-owner Room authority and actual
authenticated session to `openOriginalMcpRoomLiveSession`. It must not pass a
copied session, a fixture approval policy or a replacement RPC callback.
The fixed payload/result/parser contracts remain in
`original-mcp-room-session-contracts.ts`.

In the public dispatcher, after the original schema/principal/write gates but
**before generic durable argument/Chat tool-history/usage capture**, consult the
registry for the bounded live leaves:

```ts
const live = getOriginalMcpRoomLiveSession(storage, host);
if (live && originalMcpRoomLivePublicTools.some(tool => tool === request.tool)) {
  return originalToolResult(
    await live.invokePublic(request.tool, request.arguments, signal, stableCallId),
  );
}
```

Do not wrap these calls in a second generic raw `withOriginalMcpPublicRequest`
scope; the orchestrator performs the real approval itself. In particular,
`chat_join` must reach it before a generic recorder receives `magic_link`.
Never catch an expired/uncertain live error and route it to the old Room path.
Unrelated tools are not owned by this resource.

On explicit close/owner shutdown, await `resource.close()`. If it reports
`ROOM_LIVE_CLOSE_UNCONFIRMED`, retain Core receipts/private evidence rather
than declaring closure/readiness. Uncertainty is not reconciliation.

There is no public MCP entrypoint redesign or opaque-reference requirement.
There is also no automatic intranet authorization: this checkpoint still uses
the exact bounded loopback effect. The parent's persistent native resource
router must route open/invoke/join/close on the real signed attachment and
retain/drain the actual native resource, including cleanup after expiry.

## Focused evidence

```sh
python3 -I -B tests/framework/isolate.py node --test tests/original-mcp-room-live-session.test.mjs
./node_modules/.bin/tsc -p tsconfig.json --noEmit
```

Four owner/signed-Core cases exercise:

- Real canonical Core and signed open/invoke/join/close, original pinned client
  join/status/read/post/leave, redacted user-link approval/durable receipts and
  single-forward replay, native public denial, no final-post coercion,
  same Core/lease and complete explicit cleanup.
- Cancellation while an actual native open request is pending, closed Core
  reservation/socket and an uncertain no-fallback registry entry.
- Cancellation after the real original post has committed: its actual Core
  response receipt remains, the caller receives no manufactured success, and
  cleanup cannot erase the uncertain selection.
- Actual 30-second effect expiry, closed real listener, no fallback, live base
  attachment, and successful explicit cleanup after expiry.

The peer is a separate native-side synthetic fixture process with actual
signed transport/original producers, not an installed VS Code UI claim.
Installed live-session acceptance and harness wiring remain the next
parent-owned proof. No editor/shared build/package/dependency install, real user
Room, remote bind, old-keyring restore or full-ten/readiness claim is made.
