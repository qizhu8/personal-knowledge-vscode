# Original-root Room: held native source/Host custody slice

This is **not full Room readiness or installed Room acceptance**. A bounded
native `chat_status` port and its shared public-router journey are implemented
below. They do not start a Hub, join a network, copy SecretStorage,
restore an old process, or publish a Meeting Note.

## Implemented boundary

`src/original-mcp-room-source.ts` inspects one closed schema-2 original Room under
the actual original-root journal, canonical RootOwner/Storage lease and branded
native host. It checks the archive and each canonical private Meeting Note
against the sealed original custody, retains owner installation/project/thread
and Host participant identities, and fingerprints memberships, aliases and
resolved joins. Manual Note bytes are hashed, not projected into a public Note.
Changed or uncustodied sources fail closed. Renamed Meeting Note aliases are
preserved but are not yet admitted by this bounded original-root reader.

`src/original-mcp-native-room-contracts.ts` contains pure bounded DTOs for:

- `room.source.approve`: `{binding, source, noExecution:true}` →
  `{decisionId, expiresAtMs} | null`.
- `room.host.prove`: `{binding, source, sourceDecisionId, challenge,
  noExecution:true}` → `{challenge, sourceDecisionId, sourceSha256,
  hostParticipantId, hostCredentialHash, joinSecretHash,
  proof:{timestamp,nonce,signature}} | null`.
- `room.status.read`: `{binding, source, sourceDecisionId, hostChallenge,
  challenge, operation:"mcp.tool.chat_status", arguments:{name?:string},
  argumentsSha256, noNetwork:true, noRehost:true, noParticipantChange:true}` →
  `{challenge, hostChallenge, sourceDecisionId, sourceSha256, argumentsSha256,
  resultSha256, result:{result:string}, proof:{timestamp,nonce,signature}} | null`.

The exact source includes root/workspace/custody/profile/native-host receipt,
archive/Meeting/participant hashes, original owner and Host participant,
project/thread, credential hashes, bounded counts and every selected file hash.
Its `sourceSha256` covers that complete selection. Oversized signed frames fail
explicitly; no truncated approval or chunking fallback exists.

`clients/vscode-host/original-mcp-native-room.ts` requires two distinct actual
native UI decisions. Source consent is private-source-only and lasts at most
five minutes. Host verification uses the original `ChatRoomCredentialStore`
with **current native-profile** `ExtensionContext.secrets`:

1. Verify the source's Host credential hash.
2. Load and compare the current Host/join hashes locally.
3. Generate and locally verify an original HMAC proof whose purpose binds the
   complete source, signed host binding, source decision and fresh challenge.
4. Repeat the credential/proof checks after the Host dialog.

Neither raw credential leaves native SecretStorage. A join secret, client ID,
installation ID or old Hub Host token is never ownership evidence. Source
consent, identity, model/public approval, and Host credential custody are separate.
No new key or restored keyring is manufactured.

The producer checks trust and signer/attachment/profile/build/epoch continuity.
UI revocation, workspace change, or a Host/join SecretStorage change for an
admitted Room closes the **actual signed attachment**, not just its status bar.
Pending requests abort and late dialogs cannot grant authority. Restart retains
no source decision or Host grant.

`src/original-mcp-native-room-authority.ts` accepts only actual branded Storage,
host and authenticated signed session objects, not caller approval callbacks.
`admit(roomId)` derives its selection from custody rather than trusting a
caller-supplied source. `proveHost(roomId)` requires that independent source
admission and makes a fresh signed credential-proof request.
`assertOriginalMcpNativeRoomHostGrant(grant, storage, host, roomId)` rejects
copies, wrong owners/Rooms, changed source, expiry and revocation. Host grants
last at most 30 seconds; each new verification retires the previous grant.
These grants prove custody only, **not permission to rehost or reassign a person**.

## Bounded original public status execution

`src/original-mcp-room-public.ts` provides
`createOriginalMcpRoomPublicPort(storage, host, authority, selectedRoomId)`.
The Room selection is already admitted by the actual source authority; it is
not smuggled into `chat_status` as a new public `room_id` argument.
`dispatch("mcp.tool.chat_status", {name?}, signal?)` requires the existing exact
`withOriginalMcpPublicRequest` scope before requesting fresh Host verification.
It then calls `authority.readStatus(roomId, brandedHostGrant, {name?}, signal?)`.
The complete source, current Host challenge, operation, exact arguments and a
fresh execution challenge bind the signed request. A Host grant is single-use
for this execution, including a denial; it cannot be replayed as a credential.

The actual native producer requires another exact status-read dialog, checks
current Host/join credentials before and after the operation, and uses the
original credential store to HMAC-sign the exact request **and returned result**.
No raw Host/join material reaches the Node owner, the Python status executor,
or MCP. A source receipt or custody proof alone cannot execute this read.
Grant expiry aborts pending transport; credential revocation closes the actual
signed session and discards late UI decisions.

`clients/vscode-host/original-mcp-native-room-status.ts` executes the actual
original `chat_status` function from the pinned 4.0.22
`chat_server.py.template` (SHA-256
`0834131c634962e3526540eac35fdba35beb28cefa6de1f17dce8ac586e4a722`).
It does not reconstruct JSON, patch original business code, or launch the
original MCP server. The helper is one bounded read-only invocation, not a Hub,
a second persistence engine or a restored worker. The installed template and
call guard must match the verified payload manifest. The native producer does
**not advertise** `room.status.read` when that payload is absent or invalid.
There is no fallback to invented output or another engine.

The helper receives only the exact optional `name`, never a knowledge-root
path, secrets, old client IDs or old process state. Python runs with `-I -B`;
an audit guard denies file writers, network operations and child processes.
Its event loop may create its internal local socket pair, not a Room listener.
Cancellation drains the owned child; stdout is bounded and malformed/oversized
results are rejected, not truncated.

**Current business scope is honest no-joined-client status only.** No original
participant is silently made into a joined client. The genuine original
producer reports `{"ok": true, "active_aliases": [], "connections": []}` for an
unnamed status and its exact original named-client error for an old/historical
alias. Unicode quoting, whitespace and the `{result:string}` wrapper are
preserved by executing the original producer. This does **not** prove a live
joined-client registry, cursor/history continuity, Room networking or rehost.
Those still require an actual canonical native client/Hub port with separate
network/rehost/participant approval and same-Core persistence bridging.

## Parent-owned composition and verified boundary

The three Room methods are integrated in the shared signed lane; the current
support bound derives from the complete 18-method tuple, including separate
Todo Worker enrollment. The actual producer retains strict typed routing,
cancellation and full-session revocation. Core/host typechecks and guarded
builds passed. The focused Room authority file passes two cases, including
the actual original-public status route and raced credential revocation.
These are isolated signed-socket/producer fixtures, not installed Room custody.

1. `scripts/stage-runtime.cjs` now stages the unchanged original template at
   `next-runtime/server/legacy/resources/chat_server.py.template` and includes
   `server/legacy/resources/chat_server.py.template` in the verified payload
   manifest/required-file checks. The staged `mcp_call_guard.py` must also
   match its manifest entry. The chosen native
   Python must already supply the original FastMCP/websockets prerequisites;
   this slice installs nothing. Missing resources or prerequisites stay closed.
2. The cold component's explicit `selectRoom(roomId)` creates
   `createOriginalMcpNativeRoomAuthority(storage, nativeHost, session)` using
   the **existing** full attachment, not `Storage.open` or another RootOwner.
   It admits the exact source before selecting the public port. Model/public
   booleans cannot replace source consent. Cleanup is retained on that Storage.
3. Explicit source selection registers
   `createOriginalMcpRoomPublicPort(storage, nativeHost, authority, roomId)`.
   Its process-local registry is scoped to the same Storage and native host.
   The existing `withOriginalMcpPublicRequest` closure in
   `src/original-mcp-public.ts` routes **only** `mcp.tool.chat_status` to this
   port's `dispatch(operation.id, request.arguments, signal?)`, preserving the
   original public `{result:string}` contract; never return the internal proof
   envelope. Other Room operations remain unavailable. The test invokes the
   actual public owner backend, not only this internal port. No business
   fallback is attempted if the selected source or proof is invalid.
4. Do not connect this proof-only grant to the legacy IPC credential `load`
   fallback. The existing retained rehost runtime still consumes raw join
   material; proof-only, consented credential execution/transport and exact
   rehost/network/participant approval need their own real native composition.
   This slice deliberately exports no raw-credential transport.

## Original public contract remains unchanged and held

The captured contract has nine `chat_*` tools plus `check_chat_version`:
`chat_capabilities`, `chat_history`, `chat_join`, `chat_leave`, `chat_members`,
`chat_post`, `chat_read`, `chat_standby`, `chat_status`, `check_chat_version`.
The eight stateful/client operations return the original FastMCP
`{result:string}` wrapper; discovery/version return objects. Their exact input
defaults (including named clients, standby batching and post continuation
flags), error strings and wire output must come from the actual original
`chat_server.py` producer contracts. These source/Host DTOs are internal;
they are **not substitutes for those public outputs**.

Only the selected no-joined-client `chat_status` public dispatch is qualified
by the focused signed-socket fixture. Live retained Hub/client behavior, real
installed/browser/Chat approval and same-Core execution for all ten operations
remain unqualified. The bounded status fixture is not live Room proof.
The historical `PKM_PRIVATE_ROOM_BASELINE_FIXTURE` reproduction remains blocked
without its authorized `meeting-state.json`, `old-root` and `host-home`.
Newly created fixtures do not satisfy that historical provenance guard.

## Focused validation

```sh
node --test clients/vscode-host/original-mcp-native-room.test.mjs
python3 -I -B tests/framework/isolate.py node --test --test-concurrency=1 clients/vscode-host/original-mcp-native-room-status.test.mjs tests/original-mcp-native-room-authority.test.mjs
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/tsc --ignoreConfig --noEmit --moduleResolution bundler --module esnext --target es2023 --types node,vscode --skipLibCheck --strict clients/vscode-host/original-mcp-native-room.ts
```

Producer tests run the credential class extracted from the SHA-pinned original
4.0.22 VSIX, with fixture VS Code UI/signer boundaries; they are not installed UI
evidence. The private Linux test creates an original persistence/Meeting fixture
using that VSIX, opens a genuine original-root RootOwner/Storage/Core and signed
native session, dispatches through the actual Core to check workspace identity,
and verifies exact private source/participant custody and edit preservation.
Before shared integration the test verified `MISSING_NATIVE_METHOD` without a
Room grant. The parent rerun now exercises the active source/proof/revocation
branch after the actual method registration.
The added status journey invokes the real native producer across that signed
socket, compares empty and Unicode named status byte-for-byte with a separate
original-producer oracle, checks exact public approval/replay/denial gates, and
revokes native credentials during an outstanding status dialog. A separate
executor case proves an attempted file writer is denied; no original Room or
Meeting Note is modified by status execution.
Only fixture-owned bundles/files are created under the checkout and cleaned;
no full dist/repackage, production quiescence claim or historical substitute.
