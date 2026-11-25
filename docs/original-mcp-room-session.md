# Bounded native-owned loopback Room session

This checkpoint implements the missing opaque-credential/canonical-persistence
boundary and exercises a genuinely joined original client. **It is not installed
acceptance, public-tool registration, full-ten Room, remote networking, history
restoration or full migration readiness.** The parent's already-qualified
installed no-joined-client status leaf is not changed.

## What executes

- `src/legacy-chatroom-persistence.ts` extracts the existing Room persistence ABI,
  unchanged DDL and rehost preparation from `legacy-chatroom-runtime.ts`.
  The old runtime now delegates to it. Its new reservation guard prevents an
  old local/raw-credential runtime from opening a Room held by a native session.
- `src/original-mcp-room-session-authority.ts` requires the actual RootOwner,
  same Storage/native host, exact Room source authority and current branded Host
  proof. It then requests **separate genuine native `tool.approve` consent**
  through the existing signed lane for `room.session.loopback.open`.
  A source receipt, Host proof, copied grant or caller boolean cannot construct
  the persistence capability.
- `src/original-mcp-room-session-persistence.ts` uses the actual Storage's
  `connectNative()` and the extracted canonical adapter. There is no second
  database, Room persistence engine, Storage owner or original-file writer.
  The business table remains `legacy_room_runtime_rooms` in `core.sqlite`.
- `clients/vscode-host/original-mcp-native-room-session-hub.ts` runs the real
  retained `ChatHub`/`ChatJoinApprovalManager` on the **native side**, with
  lifecycle/persistence requests sent to that actual canonical Core port.
  Only native code loads the original credential store's join material.
  Neither its raw join secret nor its ephemeral Hub Host token is returned.
- Its fresh, native-owned Python child executes the SHA-pinned original
  `chat_server.py.template` functions and protocol. It does not reconstruct
  success JSON, register a fake connected client or run an alternate MCP/Room
  server. `chat_join` builds its Magic Link **inside that native process**.
  Original join/read/post/leave/status result strings are forwarded unchanged.
- `clients/vscode-host/original-mcp-native-room-session.ts` is the actual
  Production-context producer leaf. It requires the real installed signer,
  exact profile/build/root/epoch, current native credential hashes, and another
  explicit native loopback/network/new-participant/client confirmation. It
  loads the manifest-verified retained bytes and pinned original client, uses
  real `ExtensionContext.secrets`, and revokes on actual credential changes.
  It is not yet composed into the parent's shared attachment.

The source and Host-custody DTOs/producers remain unchanged:
`noExecution:true` and no network/participant authority are not promoted.

## Deliberate bounded policy

The separate effect binds root/workspace/custody/source/profile/native epoch,
native Host receipt/hash/participant and current Host-proof deadline, plus:

- One exact `ws://127.0.0.1:<port>` endpoint, port 1024–65535. No DNS, remote
  address, wildcard listener, port zero or automatic fallback port.
- One fresh temporary **agent**, never the original offline Host. Original
  human Host ownership remains unchanged. Existing CIDs/participant IDs and
  any `reuse` resolution are rejected by the Core before membership commit.
- One explicitly approved progress-post text; original outer-whitespace
  stripping is respected. The call must use `continue_working:true`,
  `require_reply:false`, and no command/final-topic action.
- Original reads/status/leave for the single native client. Original Python
  named lookup/casefold and read-limit/cursor behavior are not reimplemented.
- At most 16 client calls, bounded history/frames, no implicit truncation.
- No more than 30 seconds, bounded by the current Host proof. Renewal is not
  implemented and must not silently reacquire a Host proof to extend a session.

Rehost preparation uses the **existing** canonical temporary-participant
retirement/alias-release policy on the Core copy. Original source databases,
canonical Meetings and manually edited private Notes are never rewritten.
The existing original automatic-new identity manager assigns the fresh UUID;
the Core rejects any attempt to reuse an old identity. No Host reassignment,
original profile/keyring copy, old worker/PID or CID restoration occurs.

## Concrete same-Core persistence and receipts

The private typed port supports only:

```
room.activate, room.snapshot, identity.read
join.request, join.resolve (new only)
alias.release, participant.forget (this new participant only)
message.append (this participant and the one approved progress post)
room.close
client.begin, client.complete
```

`session.watch` is transport-only. It is not a business mutation/API.

Mutations and their operation-ID/digest/result receipts commit atomically on
the canonical connection. The original Hub persists a post **before** sending
its acknowledgement. A successful original post result is accepted only when
its message/participant/client-request IDs match the already committed Core
message. The original result string and real cursor-before/after values are
stored in `legacy_room_runtime_native_calls`; exact call-ID replays return that
stored original string without repeating the client effect or advancing its
cursor. Conflicting arguments/results fail.

An intent left running after an interrupted native call is explicitly
`ROOM_SESSION_CLIENT_OUTCOME_UNKNOWN`; it is not automatically retried and no
success JSON is manufactured from a message row. Cursor receipts are durable
evidence, **not authority to restore a process/cursor after restart**.
Internal snapshot/identity queries do not duplicate large results into the
mutation receipt ledger.

The transport is an owned 0700 Unix-socket directory, 0600 socket, bounded
one-request frames and a narrow per-session transport token. This token is
**not a Room Host/join key or an authority grant**; the port already requires
its genuine same-owner effect capability. The descriptor must stay inside the
authenticated native lane, never MCP output, a model prompt or public evidence.

The native side holds an authenticated persistent watch on that exact port.
Revoking the effect closes the watch and therefore the real native listener,
original client process and connections promptly, even if source/Host identity
admission remains live. Cleanup closes the Room, cancels pending joins and
retires/releases only the new temporary participant under the held owner lease.
Closed/expired authority cannot reuse cached calls or ports.

An unfinished persisted session reservation blocks another old/new owner path
with `ROOM_SESSION_RECOVERY_OR_CLOSE_REQUIRED`. There is no automatic takeover
or invented restart reconciliation.

## Exact parent wiring — not applied here

No shared native request/attachment/model-RPC schema, public router, Core
dispatch/storage-worker registration, cold harness or installed harness was
edited. Pure contracts for the additions live in
`src/original-mcp-room-session-contracts.ts`:

```
originalRoomSessionNativeMethods
originalRoomSessionNativePayloads
originalRoomSessionNativeResults
isOriginalRoomSessionNativeMethod
parseOriginalRoomSessionNativePayload
```

The proposed **internal-only** signed methods are:

| Method | Exact payload, in addition to the signed frame session |
|---|---|
| `room.session.open` | `{binding, effect, persistence}` |
| `room.session.invoke` | `{binding, sessionId, effectSha256, callId, call}` |
| `room.session.close` | `{binding, sessionId, effectSha256}` |

`binding` is the existing native Host binding without `receiptSha256`.
The parser checks root/workspace/plan/catalog/profile/authority/epoch and binds
the open effect and private descriptor to that exact Host receipt/session.
Results are respectively bounded session metadata, `{result:string}` containing
the actual original producer output, and denial-only `{closed:true}` metadata.
They must not be advertised merely because this file exists.

### Owner-side sequence

Use the already active same-owner Room authority and **same** Storage/host:

```ts
const hostProof = await roomAuthority.proveHost(roomId, signal); // still custody-only
const grant = await approveOriginalRoomLoopbackSession(
  owner, host, roomAuthority, roomId, hostProof,
  { port, alias, postText }, signal,
); // separate real native tool approval, readOnly:false
const corePort = await createOriginalRoomSessionPersistence(owner, host, grant);
const transport = await startOriginalRoomSessionPersistenceServer(corePort, privateShortDirectory);
```

Send `{binding, effect:grant.effect, persistence:transport.descriptor}` to the
actual producer using `room.session.open`. Store the active owner/producer
handles, same source and effect digest in a private registry; do not expose
the transport descriptor or accept a caller-supplied policy.

On denial, open failure, cancellation, shutdown or explicit close: close
admission/revoke the effect and always await transport/Core close. The persistent
watch closes the actual native network side independently. An explicit native
close request is cleanup and must remain usable with the base attachment even
after the effect has expired; do not require a live effect to stop it.

### Native-side sequence

In the parent's authenticated attachment, validate the pure payload/session,
then call:

```ts
const native = await createOriginalMcpNativeRoomSessionProducer(context, {
  session, effect, persistence, signal: actualAttachmentLifetime,
  assertCurrent: assertActualAttachmentCurrent, // synchronous, denial-only
});
```

Retain it in the actual attachment's private registry, verify exact
`sessionId/effectSha256` on every invoke/close, and invoke
`native.invoke(callId, call)` or `await native.close()`. Its real context UI
confirmation is separate from the owner-side tool consent. Keep producer
resources alive beyond the open RPC, drain them on attachment disposal, and
never pass a raw secret, legacy `load` fallback or a fake credential callback
to the owner.

The existing manifest-covered retained bundle/resources are used. Shared
staging/builds and installed acceptance remain the parent's responsibility.

## Public contract/state choices still held

1. **Public `chat_join(magic_link, name)` is preserved.** The user's design
   decision explicitly permits transient forwarding of a user-supplied link
   through Node, under current native endpoint/effect/participant authorization.
   The added user-link ingress keeps that original contract; it does not
   require an opaque-reference or native-frontdoor rewrite. Only digests and
   redacted endpoint metadata may enter durable Core calls/evidence. Native
   SecretStorage values are still never exported. See
   `original-mcp-room-session-user-link.md` for exact routing and transport.
   The existing name-only native-owned join remains an internal alternative.
2. The original default/final `chat_post` waits in standby. This slice runs the
   actual original progress-post path only, not a fake immediate final result.
   Full blocking standby, final-post cancellation, remote reconnect, history/
   cursor restoration and attachment/Meeting live convergence remain separate.
3. While a live session exists, route its status/read/leave through that
   session. The earlier no-joined-client status port obtains a new Host proof;
   doing that silently would revoke the proof underlying this effect.
4. No automatic renewal, old participant rebind, profile/keyring restoration,
   host succession or stale reservation recovery is authorized by this slice.

## Verified evidence

```sh
python3 -I -B tests/framework/isolate.py node --test tests/original-mcp-room-session.test.mjs
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/tsc --ignoreConfig --noEmit --moduleResolution bundler --module esnext --target es2023 --types node,vscode --skipLibCheck --strict clients/vscode-host/original-mcp-native-room-session.ts
```

Four focused cases use the genuine RootOwner/Storage/Core, actual signed native
attachment, original credential/HMAC producer, actual retained Hub/WebSocket,
and SHA-pinned original Python client in a **separate native-side fixture
process**. Only newly created synthetic fixture keys exist in that process.
The test verifies default-off/denial and fake-grant refusal; actual fresh join;
unchanged offline Host; Unicode named status; original `limit=0` behavior and
real read cursors; committed progress post; replay/conflict; leave; effect-only
watch revocation with the base session still alive; actual listener closure;
same Core/lease; no raw Room keys in owner evidence; and unchanged original
Room/private manual Meeting Note bytes. The old runtime is also refused while
the native reservation is active.

The user-link case exercises the unchanged original public arguments, pinned
alias/format/checksum error bytes, wrong-secret rejection, a real successful
join, one-time forwarding and safe replay, redacted durable Core records, and
refusal of unapproved loopback/intranet endpoints or old participant aliases.

The existing source-bundling `next-room-ui-hub.test.mjs` case
`one Next owner (legacy-client-id) without a legacy writer` also passes against
the canonical adapter extraction. It remains a legacy fixture regression, not
qualification of the new opaque-key path.

The fixture's approval choices are not installed native UI evidence. The
Production-context producer is typechecked but its new UI/shared RPC/installed
journey has not been run. No whole editor, shared build/package, dependency
install, real user Room or remote network was used.
