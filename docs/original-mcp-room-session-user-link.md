# Original public Magic Link ingress

## Design and credential facts

The public API remains **`chat_join(magic_link: string, name: string)`**, with
the original `{result:string}` wrapper and original producer behavior. It is
not replaced by an opaque-reference API or a new native MCP frontdoor.

The user's accepted security model is intranet plus explicit current native
authorization. A **user-supplied** link may transit local Node memory and the
authenticated native channel. It must not be copied into durable Core call
arguments, transcript/history, usage evidence or error logs. This permission
does not authorize exporting any native SecretStorage Host/join value.

The original credential implementation was verified, not assumed hardcoded:
the SHA-pinned 4.0.22 VSIX
`1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27`
generates `randomBytes(32)` for Host credentials and, by default,
`randomBytes(24)` for join secrets. It also supports an explicit
`requestedJoinSecret`. No generation/HMAC/signature/role validation was weakened
or replaced, and no new key was hardcoded.

## Dedicated implementation

- `originalRoomPublicJoinArguments` in
  `src/original-mcp-room-session-contracts.ts` exactly keeps the original two
  required string fields, with no public opaque-reference field.
- `src/original-mcp-room-session-user-link-codec.ts` derives a digest-only
  intent and a redacted diagnostic endpoint. It excludes URI credentials,
  path/query/fragment, the encoded link, decoded secret and original caller
  name. The pinned original Python parser remains authoritative.
- `src/original-mcp-room-session-user-link.ts` requires the actual current
  branded effect grant. It retains raw arguments only in a private, bounded,
  short-lived in-memory record. The returned ingress/approval descriptor is
  safe to serialize. Revocation/discard clears its owned raw reference.
- `consumeOriginalRoomUserJoin` returns a raw **forward** packet at most once
  per grant/call ID. Subsequent attempts return only a safe **replay** call.
  Changed arguments for the same ID fail instead of reconnecting or rebinding.
- The native session's `invokeUserJoin(callId, originalArgs, intent)` verifies
  that the received raw arguments match the safe intent, journals only that
  safe call, and forwards the original arguments to the real pinned
  `chat_join`. It does not substitute the native-stored secret.
- In the actual native client process, the original `_parse_magic_link`
  validates the link, then the exact approved endpoint/source and participant
  policy are checked before any connection. The real original `chat_join`
  produces alias/format/checksum/authentication errors and success strings.
  No success/error JSON is reconstructed for old business behavior.

Known, completed failures before a participant is assigned permit a new join
attempt, as the original client does. A successful/unknown join or existing
participant still cannot be silently replaced/rebound. At most one new
participant may be assigned under this bounded session.

## What Core persists

The durable `chat_join` call contains only:

```
tool: "chat_join"
arguments: {name: <already approved alias>}
userLink: {
  schema: "pkm.original-room-user-link/v1",
  argumentsSha256, magicLinkSha256, suppliedNameSha256,
  endpoint: <approved endpoint>,
  requestedEndpoint: <redacted origin or null>,
  requestedRoomId: <bounded ID or null>,
  parseStatus: "recognized" | "unresolved"
}
```

Core mutation receipts and client results reject actual `pkchat:v1:<payload>`
values, including decoded result strings, instead of persisting an invite.
The original diagnostic text ending in `pkchat:v1:` remains valid; it is not
itself an invite. An original legacy transcript containing an invite is not
silently rewritten or copied by the session port: activation fails closed and
requires an explicit legacy-history redaction/reconciliation choice. The
original source remains intact.

The existing exact response/cursor receipt is used on replay, without
reforwarding the link or rerunning the original join. An interrupted outcome
remains unknown; no receipt or online identity is fabricated.

## Exact parent public routing additions

**Shared router/request/attachment/harness/Task/Action/Core registrations were
not edited.** Put this branch at the existing `chat_join` leaf **before any
generic durable argument, Chat tool-call/history, usage or error recorder**.
Keep the original public schema and normal principal/write gates.

1. Obtain the already approved same-owner loopback session's genuine effect
   grant. Source/Host custody alone remains no-execution/no-network.
2. Validate/prepare the original caller arguments in memory:

   ```ts
   const ingress = prepareOriginalRoomUserJoin(grant, request.arguments, callId);
   const safeApproval = originalRoomUserJoinPublicApproval(ingress);
   ```

3. Use `safeApproval` for the existing fresh native public approval and any
   usage/evidence envelope. Its `user_link.argumentsSha256` still binds the
   complete original caller input. Do **not** pass raw args to a generic
   durable Chat/tool recorder or modal-evidence capture. On denial/cancellation,
   call `discardOriginalRoomUserJoin(ingress)`.
4. Consume only after approval, forwarding through the actual authenticated
   producer transport:

   ```ts
   const packet = consumeOriginalRoomUserJoin(ingress);
   if (packet.kind === "forward") {
     // INTERNAL signed RPC only; never log/return this packet.
     // method: room.session.join
     // payload: {binding, sessionId, effectSha256,
     //           callId:packet.callId, arguments:packet.arguments, intent:packet.intent}
   } else {
     // Existing INTERNAL room.session.invoke:
     // {binding,sessionId,effectSha256,callId:packet.callId,call:packet.call}
     // Complete Core receipt -> exact result replay; otherwise fail closed.
   }
   ```

5. Return the actual producer `{result:string}` through the original
   `chat_join` public wrapper. Do not return an ingress object, transport token,
   opaque-reference instruction or synthetic connected response.

Use the same canonical leaf module/grant/call ID for retries so its in-memory
single-forward ledger applies. Normal new public attempts may use new call IDs.
Do not silently reforward an uncertain call after a process/session restart.

### Required shared native method

The additional method is separately exported as
`originalRoomUserLinkNativeMethods = ["room.session.join"]`; it is not
automatically advertised or registered.

Its strict payload/result entries are in
`originalRoomSessionNativePayloads/Results` and included by
`isOriginalRoomSessionNativeMethod` /
`parseOriginalRoomSessionNativePayload`:

```
room.session.join:
  payload {binding, sessionId, effectSha256, callId,
           arguments:{magic_link,name}, intent}
  result  {result:string}
```

The native attachment must check its existing actual session/effect registry
and dispatch to `native.invokeUserJoin(callId, payload.arguments, payload.intent)`.
The original internal name-only native-owned join may stay unchanged.
No native SecretStorage getter or key value is added to Node/Core/MCP APIs.

## Endpoint and participant scope

The working fixture is intentionally the already approved exact loopback
endpoint and selected Room. A different loopback port, intranet endpoint,
source UUID or alias needs its own exact current authorization; this ingress
does not automatically bind or contact it. Intranet support is not globally
forbidden, but the current bounded loopback effect is not an intranet grant.
No original participant/CID/Host role is rebound just because a link or client
ID is available.

## Verified tests, not installed qualification

```sh
python3 -I -B tests/framework/isolate.py node --test tests/original-mcp-room-session.test.mjs
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/tsc --ignoreConfig --noEmit --moduleResolution bundler --module esnext --target es2023 --types node,vscode --skipLibCheck --strict clients/vscode-host/original-mcp-native-room-session.ts
```

The added genuine Core/private-network fixture supplies a caller-generated
random invite secret through the **original requested-secret input**, never
exports it from native storage, and retains a separately generated native Host
credential. It verifies original alias/format/checksum error bytes against the
pinned producer, actual wrong-secret rejection, real successful user-link join,
fresh identity, single forwarding/replay/conflict, endpoint/old-alias refusal,
redacted approval/evidence and durable Core rows, and unchanged original
Room/private Meeting Note bytes. Native-side facts also verify 32/24-byte
default random generation and different values across creations.

Actual shared public routing, installed permission methods and installed
user-link acceptance remain the parent's integration/proof. No broader
readiness, keyring restoration, remote bind or full-ten claim is made.
