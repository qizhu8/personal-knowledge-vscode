# Staged original-library MCP cutover (experimental, fail closed)

The sole business scope is `preserve-existing-mcp/v1`: all 151 canonical
operations plus Todo/Memory and the approved hybrid tool surface. The original
nine tools are a subset, not an exposed-count assumption; approved aliases are
pinned separately. Readonly alias visibility follows canonical hints.

**No actual switch is currently qualified.** The concrete Source implementation
gate is still false. The Unix transport and bounded typed approval RPC now exist;
native model configuration/streaming, full staged Source integration and actual full-profile
qualification are not shipped. Genuine installed enrollment/reload is a
separate milestone, not model/tool or full151 qualification. The coordinator refuses
before mutation when either required implementation or attachment API is absent.
It never substitutes model-policy callbacks or counts of names for these gates.

## Explicit native dogfood wiring

`bootstrapOriginalMcpNativeRuntime` in
[`original-mcp-native-bootstrap.ts`](../src/original-mcp-native-bootstrap.ts)
accepts independently captured original custody and the retained actual root
fence. It opens one owner with recovery deferred, then publishes only a private
signed native-attachment endpoint. `complete()` obtains native public consent,
composes that same owner's canonical runtime and completes recovery. Opting into
models also requires both the advertised exact-inference approval method and the
separately enabled native model channel. Authentication does not grant old
source-domain or tool permissions.

The bootstrap itself never publishes a business descriptor, changes a profile,
retires state or claims full parity. Revoked consent invalidates its handle.
Closing while attachment is pending cancels the wait and closes its actual owner.

After an independently admitted writable native dogfood broker exists,
`writeOriginalMcpHotSwitchTarget` in
[`original-mcp-hot-switch-target.ts`](../src/original-mcp-hot-switch-target.ts)
can create an owner-only, token-free target outside the library for the v4.0.23
hot-switch command. It binds the exact root, profile, live descriptor, Node and
relay pins; it does not create an owner or claim the client has connected.
The full cutover coordinator below still requires its separate production gates.

[`original-mcp-dogfood.mjs`](./original-mcp-dogfood.mjs) is the explicit writable
dogfood controller, separate from the full151 coordinator. Planning freezes a
verified runtime outside the library and binds the actual installed native host,
enrolled public identity, profile and recovery request. It does not activate data.
The installed signing producer and staged business runtime may have distinct
independently verified build identities; neither is relabelled as the other.

Its `start PLAN PIN` entry must run outside the library. It retains one real root
fence, requires the unchanged writer inventory, captures and independently
restores B0, then applies backed root-only mode/Git protections before custody
and native bootstrap. After the user's actual native attachment consent it
publishes a pinned target for the v4 hot-switch command. Publication is not proof
that the client switched. Existing optional source domains remain unadmitted.

First pause its native client with **PKM: Pause MCP Runtime for Maintenance**;
then stop that controller cleanly before `retire PLAN PIN EXECUTION PIN`. Retirement
preserves compatible public changes in place, captures B1 and privately archives
the enumerated native state through the typed retirement API; unknown work,
optional domain state and writes outside the qualified increment refuse.
The operator then explicitly switches the v4 native transport back to Managed.
Neither command kills unrelated processes, rewrites an old database or claims
that stopping one native MCP connection drained independent Chat/CLI clients.
Interrupted retirement resumes its exact durable ticket. Keep the original root
private and its new Git guards until all retained runtime state is accounted for.

## Separate stages, not an impossible offline human grant

1. A qualified new, separate-ID package is installed **alongside** the original.
   The genuine VS Code UI enrolls its own signing identity. Only its public
   `original-mcp-native-identity.json` is persisted; the private key stays in the
   new per-profile/per-key SecretStorage slot. Old credentials are untouched.
2. The offline plan independently pins that public file **and** its semantic
   identity SHA, candidate package, payload build, host entry and protocol. It
   stages complete code outside the library before maintenance.
3. Before mutation require complete concrete implementation readiness and fixed
   deployment/package/profile/protocol/restart qualification. Deployment facts
   explicitly have **no** human/model authority and are not business activation.
4. With the editor/legacy writers closed, hold one actual canonical Linux fence,
   capture B0, verify it and freshly restore/validate its raw/SQLite closure.
   Back up the original root mode, fchmod **only that same inode** to approved
   0700, then back up/apply actual Git private-state guards. Capture custody
   after these controlled changes, then prepare the original root.
5. Source bootstraps exactly one actual owner/Storage using **internally
   deferred** `prepareNative`; recovery must not run yet. Expose only a private
   native-attachment control endpoint. Do not publish a business descriptor or
   `original-mcp-enrollment.json`.
6. The newly started genuine profile/package proves a fresh one-use signed
   challenge bound to broker/root/workspace/plan/catalog/profile/build/host
   entry. Signature verification authenticates identity/activation only. Fresh
   LM selection, credentials availability, tool invocation contexts and actual
   per-domain approvals are obtained **after** attachment.
7. Source composes `createOriginalMcpNativeHost(actualStorage, policy)` from that
   authenticated producer, admits exact domain state, and runs the same owner's
   `ensureFull` typed recovery. No old receipt or unknown work is replayed as a
   current grant. Bootstrap root commit alone is not business activation.
8. Recheck concrete full readiness, authenticate/probe the same-owner business
   broker (151 describes, 23 hybrid discovery cases, Todo/Memory, approved alias
   names/schema pins), then publish the token-free business enrollment.

There is **no legacy uninstall** in this separate-identity flow and no old
SecretStorage read/copy/delete. Qualified native restart control must keep the
old extension disabled per launch. The coordinator never starts/stops/masks/
unmasks user services and never grants a PID exemption.

## API / CLI

```js
planOriginalMcpCutover(request, newPrivateStage)
validateOriginalMcpNativeStaging(planPath, independentlyPinnedPlanFileSha256)
executeOriginalMcpCutover(planPath, planPin)
verifyOriginalMcpCutover(planPath, planPin, businessDescriptorPath, descriptorPin, executionReceiptPin)
preserveOriginalMcpCutoverB1(planPath, planPin)
rollbackOriginalMcpCutover(planPath, planPin)
```

`execute` returns a live **pending bootstrap**, not an MCP-ready result:
`status:"awaiting-native-attachment"`, `businessReady:false`,
`storageRecovered:false`, private attachment descriptor pins, `complete()`,
`close()` and observable `closed`. `complete()` is memoized and accepts no
caller-supplied attestation/approval callback. It waits at most five minutes for
the qualified Source attachment and only then performs admission/publication.
The same actual owner/storage/fence are retained, never reopened for a client.

```sh
# Preparatory staging can run before shutdown. All controls are private 0600.
node /absolute/current/experimental/original-mcp-cutover.mjs plan REQUEST NEW_STAGE
node /absolute/staged/experimental/original-mcp-cutover.mjs validate-native-staging PLAN PIN

# After independent user-coordinated maintenance, outside all source roots:
cd /
/absolute/pinned/node /absolute/staged/experimental/original-mcp-cutover.mjs execute PLAN PIN
```

CLI execute first prints only the pending attachment locator/pins, then waits
for `complete()` and prints business locator/pins only after admission. The
bootstrap must remain alive while the genuine editor reconnects. SIGINT/SIGTERM
requests qualified cleanup, never a forced exit/release of an unconfirmed owner.
Other commands: `verify PLAN PIN DESCRIPTOR PIN EXECUTION_RECEIPT_PIN`,
`preserve-b1 PLAN PIN`, and `rollback PLAN PIN`.

Business enrollment remains frozen for the current host activation. Writing a
file is **not** hot registration. Final activation must prove either
`registrationMode:"authenticated-native-promotion/v1"` or
`"qualified-same-owner-native-rebind/v1"` after a reload; reloading alone revokes
the old epoch. Neither primitive is implemented by the identity-only socket.
The final activation verifier remains fail closed until the genuine native
producer implements and qualifies that transition.

## Pinned request

The request schema remains `pkm.original-mcp-cutover-request/v1`; unknown fields
refuse. Existing fields: `acceptedScope`, `operatorId`, `originalRoot`,
`recovery:{path,sha256}`, canonical `profile:{storageDirectory,sha256,
userDataDirectory,extensionsDirectory}`, old `legacy:{installedDirectory,
package:{path,sha256},main:{path,sha256},vsix:{path,sha256}}`,
`nativeCli:{path,sha256}`, `release:{directory,manifest,qualification,oracle}`
(each control reference has path/SHA), `maintenance`, explicit custody limits
and `rootMode:{approvedMode:448}`. That numeric mode is root-only configuration
approval, **not** cold/human authority.

New mandatory preparation:

```json
{
  "nativeDeployment": {
    "credentialPolicy": "native-reenroll-separate-id",
    "publicEnrollment": {
      "path": "/actual/new/globalStorage/original-mcp-native-identity.json",
      "sha256": "RAW_FILE_SHA256"
    },
    "identitySha256": "INDEPENDENT_IDENTITY_RECORD_BODY_SHA256",
    "package": { "path": "/actual/new-extension/package.json", "sha256": "SHA256" },
    "payloadBuildId": "VERIFIED_PAYLOAD_BUILD_ID",
    "hostEntry": { "path": "/actual/new-extension/dist/extension.cjs", "sha256": "SHA256" },
    "payloadManifest": { "path": "/actual/new-extension/next-runtime/manifest.json", "sha256": "SHA256" },
    "protocolSha256": "CANONICAL_ATTACHMENT_CONTRACT_SHA256"
  }
}
```

The raw file SHA and identity `sha256` are different pins. The coordinator uses
the parent's actual `verifyOriginalMcpNativeIdentity`, not an invented key
format. Public identity verification grants no model/tool/state permissions.
Private signing keys are never read by this tool. Package ID/version must match
the qualified release; code/build pins are independently supplied from actual
installation qualification, not inferred from six unit tests.

B0 must cover **whole** selected user-data and extensions directories, including
both installed packages and the new public profile record. The original
`.gitignore` is added explicitly as a configuration scope. Exact file-link
closure follows `cold-state-recovery.mjs`; unapproved links remain refused or
explicitly incomplete. OS keyrings are not copied. The old 21-scope remote-only
request is not silently promoted to full native-profile protection.

## Exact pending Source contract

The coordinator exports `originalMcpNativeAttachmentContract`. Its canonical
key-sorted JSON plus LF SHA is pinned by request and qualification. Qualified
runtime may contain `dist/original-mcp-native-attachment.js`; if absent or with
an incompatible contract, execution refuses
`NATIVE_ATTACHMENT_PROTOCOL_UNAVAILABLE` **before the cold fence/mutation**.
This optional staging file is not an implemented producer.

Required fixed exports (none is a caller-provided verifier):

* `originalMcpNativeAttachmentContract`: exact exported ABI/protocol declaration.
* `verifyOriginalMcpOfflineDeployment(input)` and
  `isTrustedOriginalMcpOfflineDeployment(resource,binding)`: read-only package,
  protocol, pinned public identity/profile, approved bootstrap footprint and
  real restart-control facts. Resource has `facts`, `managedRootFiles`, `close()`.
  Facts schema `pkm.original-mcp-offline-deployment/v1` binds root/profile/
  operator/release/package/public-file/identity/payload-build/host-entry/
  payload-manifest/protocol pins and credential policy. `modelAuthority`,
  `humanAuthority`, `businessReady` must all be **false**.
* `bootstrapOriginalMcpNativeAttachment(options)` and
  `isTrustedOriginalMcpNativeBootstrap(resource,binding)`: Source owns the actual
  `openOriginalMcpRoot(...,{writerFence,gitProtection,prepareNative})` factory.
  Return actual owner/storage/workspace/plan, private
  `attachmentDescriptorPath`/`attachmentDescriptorSha256`, `businessReady:false`,
  `storageRecovered:false`, `close()` and lifecycle notification. No business
  `descriptorPath`/`descriptorSha256` is allowed at this stage.
* `waitForOriginalMcpNativeAttachment(bootstrap,{timeoutMs})` and
  `isTrustedOriginalMcpNativeAttachment(session,binding)`: actual private
  control-plane signature/epoch authentication, not an MCP business route.
  The parent's `OriginalMcpNativeChallenges` provides 60-second one-use Ed25519
  challenges; `consume` yields activation/identity only, not permissions.
* `admitOriginalMcpNativeAttachment(bootstrap,session)`: fresh native ports,
  per-domain approvals/hydration and typed recovery. The
  `pkm.original-mcp-native-admission/v1` receipt binds the same workspace/plan/
  profile/identity/package-build/host entry, fresh epoch, exact enabled151 and
  canonical domains, completed recovery, new-namespace policy, and
  `oldCredentialsTouched:false`.
* `publishOriginalMcpNativeBusiness(options)`: same actual owner **and Storage**
  as the bootstrap; approved hybrid surface and actual full native dispatch,
  not `startOriginalMcpBroker` reopening an owner while the editor is live.
* `verifyOriginalMcpNativeActivation(input)`: actual current profile/package/
  epoch, descriptor/release/workspace, same-owner reuse, disabled old runtime
  and untouched old credentials. Installed version strings alone do not suffice.

These high-level interfaces must still be implemented/qualified by Source and
the genuine native producer. The generic model-policy factory is intentionally
irrelevant to offline staging. Current Source provides safe root bootstrap,
identity crypto and the authentication-only transport below; it does not yet
provide native model/tool/domain admission. No existing host/identity modules
are changed by this coordinator.

### Identity-first endpoint wire contract (not a business transport)

Implemented in `src/original-mcp-native-attachment.ts`:

```ts
startOriginalMcpNativeAttachmentServer({
  directory, identity, identitySha256, binding,
  maxConnections?, maxPacketBytes?, handshakeTimeoutMs?,
  heartbeatIntervalMs?, heartbeatTimeoutMs?
})
verifyOriginalMcpNativeAttachmentDescriptor(path, independentSha256, profileSha256)
assertAuthenticatedOriginalMcpNativeSession(session, expectedBinding?)
```

The start result has `descriptorPath`, `descriptorSha256`, `brokerId`,
`waitForSession({timeoutMs?,signal?})`, `close()` and observable `closed`.
The session is process-branded, with `activationId`, `identitySha256`,
`binding`, `signal`, synchronous `assertCurrent()` and `close()`. It has no
Storage/owner/model/tool/state API. A newer authenticated producer revokes the
previous session. Disconnect or missed heartbeat aborts the old signal.

The descriptor is exactly `{schema:"pkm.original-mcp-native-attachment/v1",
brokerId,socketPath,identitySha256,binding}`. Binding is exactly
`{root,workspaceId,planSha256,catalogSha256,profileSha256,payloadBuildId,
hostEntrySha256}`. The readonly verifier returns **exactly these five flat
descriptor fields**, with the binding frozen, so the actual host's strict
descriptor schema accepts it. File/socket identity/owner/mode checks remain internal.
It opens no root or Storage and mints no authority. The parent must create a
short empty canonical owned0700 endpoint directory; socket and descriptor are
0600. Root identity alone is never permission.

Frames are bounded UTF-8 JSON Lines. Server sends challenge immediately:

```json
{"type":"challenge","challenge":"ACTUAL OriginalMcpNativeChallenge OBJECT"}
{"type":"attestation","attestation":"ACTUAL OriginalMcpNativeAttestation OBJECT"}
{"type":"attached","brokerId":"UUID","activationId":"UUID","identitySha256":"PIN","businessReady":false}
{"type":"ping","nonce":"FRESH_NONCE"}
{"type":"pong","nonce":"SAME_NONCE"}
```

The quoted challenge/attestation placeholders mean the exact typed objects
from the parent's identity module, not strings on the wire. Source issues the
challenge with `OriginalMcpNativeChallenges`, the actual native signer obtains
fresh consent and calls `signChallenge`, and Source consumes it once on that
same connection. The client must validate the challenge against every pinned
descriptor binding and invoke `signer.assertCurrent()` before each pong.
Malformed/extra/business frames close only the offending connection; replay,
cross-connection proof, wrong keys and stale profiles never authenticate.
`capability_read`, `capability_call`, JSON-RPC business initialization, arbitrary
sign/eval and credential export are never valid private-control messages.

Limits: 1–8 connections (default4), 1–32 pending application waiters,
packet buffer1024–65536 bytes (default16384), handshake50–60000ms (default60000),
heartbeat interval/timeout20–60000ms (defaults15000/10000); wait timeout is
1–300000ms. Challenges are the parent's bounded 60-second one-use proofs.
Source validates file/socket ownership/inode/mode and preserves replacements
rather than deleting unknown controls. Native cleanup errors remain observable.

The successful attached reply grants **no** LM/tool/domain permissions. The
typed request slice below requires explicit real native handlers and fresh
decisions; model streaming/domain admission remain separate missing protocols.

### Fixed typed native requests (not generic method execution)

`src/original-mcp-native-request.ts` implements only six method IDs:
`admission.approve`, `public.approve`, `model.approve`, `tool.approve`,
`tool.review`, and `credential.present`. Auth-only clients remain compatible:
they advertise nothing and requests fail `MISSING_NATIVE_METHOD`. Actual native
client code must derive support from its installed handler table, never from a
model/MCP caller or an enrollment approval.

After `attached`, the native client explicitly advertises:

```json
{"type":"native-supports","protocol":"pkm.original-mcp-native-request/v1","session":"SESSION_OBJECT","methods":["admission.approve","public.approve"],"maxPacketBytes":65536}
```

`SESSION_OBJECT` is `{brokerId,activationId,identitySha256,epoch,binding}` where
`epoch === activationId` and binding is the same exact seven descriptor fields.
Every request, result and cancel carries this entire authenticated binding.

```json
{"type":"native-request","protocol":"pkm.original-mcp-native-request/v1","requestId":"FRESH_UUID","session":"SESSION_OBJECT","method":"public.approve","payload":"TYPED_PAYLOAD","requestDigest":"SHA256"}
{"type":"native-result","protocol":"pkm.original-mcp-native-request/v1","requestId":"SAME_UUID","session":"SAME_SESSION","requestDigest":"SAME_SHA256","result":{"decision":"deny"}}
{"type":"native-cancel","protocol":"pkm.original-mcp-native-request/v1","requestId":"SAME_UUID","session":"SAME_SESSION","requestDigest":"SAME_SHA256"}
```

The placeholders above are typed JSON objects, not strings. `requestDigest`
is the **actual exported `originalMcpRequestDigest`** of
`{protocol,requestId,session,method,payload}`, excluding `type` and the digest.
It is not the tool argument byte/depth hash or a truncated projection. Public/
tool argument digests and complete execution-review record digests are checked
separately. Approval payloads include the exact native-host admission binding,
with fixed `mcp:external` actor, root/workspace/plan/profile/catalog/configuration
pins, `authorityId:"native-rpc:BROKER_UUID"` and authenticated activation epoch.

Ordinary approval results are exactly `{decision:"approve"|"deny"}`.
Credential presence is exactly `{present:boolean}` for logical slot
`personalKnowledge.aiApiKey`; raw keys/handles are never a result.
Review is `{decision:"approve"|"reject",decisionId,actorId:"mcp:external"}` or
`null`, not a caller boolean. A result frame has exactly one of `result` or
`error:{code}`. Allowed error codes: `MISSING_NATIVE_METHOD`, `NATIVE_DENIED`,
`NATIVE_REQUEST_CANCELLED`, `NATIVE_HANDLER_FAILED`. No arbitrary method names,
script execution or domain/Memory grant is carried by this protocol.

Shared parent-client exports include strict support/session/payload/result/
cancel schemas, `parseOriginalMcpNativeRequest(value,expectedSession)`,
`originalMcpNativeResult(request,result)` and
`originalMcpNativeErrorResult(request,code)`. The returned parsed request is
discriminated by `method` for a typed handler switch.

Broker exports: `waitForOriginalMcpNativeSupport`, availability-only
`originalMcpNativeSupportedMethods`, `requestOriginalMcpNative`, and
`createOriginalMcpNativeRequestPolicy(session,{toolCatalog?})`.
The policy's synchronous `assertCurrent` uses the real process-branded live
session, `signal=session.signal`, and epoch=activationId. Its ports perform a
fresh actual roundtrip for each exact request. It accepts no configuration
approval callback or supplied fake transport. The actual Socket channel is
bound internally once, before the authenticated session becomes observable;
it cannot be replaced by a later caller.

This slice deliberately provides **no model configuration/transport**:
registry availability is empty, `transport.supports` is false and `open` fails
`MISSING_NATIVE_METHOD`. An approved model-request digest is not a network
transport or model selection. Actual VS Code handlers/UI/credential/network
behavior remain the native producer's responsibility, not fixture callbacks.

Bounds: at most16 in-flight requests and16 support waiters per session,
timeout1–120000ms (default30000), at most256 retired IDs, negotiated packet
limit at most65536 bytes, portable JSON depth64/nodes65536. The auth transport's
configured lower bound still applies. Oversize/credential-bearing structured
arguments are explicitly rejected, never truncated/redacted into another
approved request. Cancellation/timeouts send a bound cancel and retire the
receipt; late or duplicate decisions cannot authorize another request.
Disconnect/epoch change rejects every pending request. Wrong digest/binding,
unexpected IDs or malformed results revoke the session. No raw frames,
arguments, transcripts, native errors or credential values are logged.

## Existing safety boundaries remain

* Concrete `verifyOriginalMcpImplementationReadiness` must be ready before any
  original-mode/Git/DB mutation; all151 exact implementation IDs, no missing
  routes, canonical Todo/Memory and approved hybrid schema/oracle qualification
  remain mandatory. Canonical pins:
  SHA `696d70e87c1b56697de21d0ab545eb161fed46ae11b34fce6a1f1179198d6a21`,
  revision `8f4de8526bc2b4a043cfb493c180709292ed245bbf97bef8b7e9e4b4891a76a5`.
* The release completely lists regular code files/SHA, Node pin, build and
  extension identity. The qualification pins actual native151/23 discovery/
  canonical/alias tests and deployment protocol cases, never merely assertions.
  Optional attachment ABI absence does not prevent staging, but prevents execute.
* The fixed native user-systemd controller must prove the profile launcher
  persistently masked/inactive/dead before cold mutation, with no drop-ins.
  The pinned command is `HOST --start-server --user-data-dir USERDATA
  --extensions-dir EXTENSIONS --disable-extension uone.personal-knowledge`.
  No post-attachment cold scan exempts the new editor; warm use retains the
  existing fenced owner. Other restart-control systems remain unsupported.
* Real B0/restore/source hash checks precede backed root-only fchmod and backed
  Git CAS. Actual `git check-ignore` protects private DB/journal/archive paths
  before their creation. Custody pins the protected policy. Live Git guard
  remains retained by the actual owner. Children are not chmodded.
* New captures/stages are private 0700/0600 under
  `$HOME/.local/state/pkm-v5-recovery`, outside original/sync/session raw areas.
  Interrupted stages never replay. Raw movement does not preserve inode identity.
* Independent plan, execution-receipt and descriptor pins bind ordered journals,
  B0/SQLite restoration and mode/Git/custody artifacts. No business enrollment
  is accepted merely because a bootstrap root commit exists.
* B1 capture/restore precedes any retirement, but complete retirement is still
  unqualified: `rollback` preserves selected B1 then refuses. Keep root0700 and
  private Git guards while state remains. Fenced B1 captures and independently
  restores `.pkm-next-retrieval-models`, `.pkm-next-todo`, and
  `.pkm-next-memory` when present. This preserves bytes, not proof of domain
  closure or authority to retire or reactivate those directories.
  Unknown state is never deleted or overwritten.
* Cleanup still attempts applicable resource closes and preserves primary plus
  all cleanup errors in `AggregateError.errors`/`primaryError`/`cleanupErrors`.
  Redacted durable notifications and observable `closed` prevent success-shaped
  cleanup failures. Unknown owner shutdown retains the canonical fence.

## Focused tests

```sh
TMPDIR="$HOME/.local/state/pkm-v5-recovery" node tests/framework/run.cjs \
  --file tests/original-mcp-cutover.test.mjs --no-build --jobs 1 --json
```

Actual synthetic RootOwner/Storage/fence/Git/SQLite and crypto identity
verification are used. Future attachment producer, native CLI effects and full
business dispatch are explicitly module-mocked **unit fixtures**, not genuine
VS Code enrollment, model/human authority or production qualification. Tests
must preserve the accepted cleanup-error regressions and prove that no factory,
recovery, business endpoint or enrollment precedes trusted native attachment.

Actual-socket primitive regression:
`tests/original-mcp-native-attachment.test.mjs` (cryptographic Node clients, not
genuine VS Code producer qualification). It also proves the caller's held
canonical root fence remains held; the server imports/opens no root owner.

## Isolated cold-owner component experiment

`src/original-mcp-cold-component.ts` is a **separate, fixture-only component
experiment**, not `execute`, reduced full admission, a business server, or
same-root rollback. The production full151 gate and default rollback above
are unchanged. Neither business enrollment nor profile promotion is published.

The embedding native harness uses this fixed sequence:

1. `createOriginalMcpColdComponentFixture(newDirectory)` creates a new 0700
   fixture/root beneath `$HOME/.local/state/pkm-v5-recovery`. The returned
   object is process-branded. Existing roots, clones and arbitrary actual-root
   paths cannot be enrolled in this experiment. Seed synthetic original
   Note/Skill/.pkm/SQLite/archived state there before bootstrap.
2. Enroll the separate real installed native identity **before** cold admission.
   Fully close that actual editor/process tree; a window reload is not cold.
3. `bootstrapOriginalMcpColdComponent(fixture, options)` uses the unchanged
   actual Linux writer/quiescence gates, one fence, complete fixture-root B0,
   independent custody, and `openOriginalMcpRoot({prepareNative})`. It returns
   the actual `owner`, unrecovered `storage`, custody/prepared identities, B0
   pin, private attachment descriptor/path pin, and component methods.
   Options are `operatorId`, `profileSha256`, explicit custody `limits`, and
   `attachment:{directory,identity,identitySha256,payloadBuildId,hostEntrySha256}`.
   The endpoint directory must already be empty/private and the Unix socket
   path short enough. It is not a business endpoint.
4. Publish only the separate pinned native bootstrap pointer while the editor
   is closed. Restart the actual enrolled profile, authenticate its genuine
   signed session, and call `complete()`. The deferred fixed factory awaits
   advertised native methods, creates the actual session-only request policy
   and native host, obtains fresh native admission, and then recovers/composes
   **the same Storage/Core**. `complete()` returns that branded native host.
   No caller-success callbacks or PID exemptions enter this sequence.
5. `invoke(tool,arguments,signal?)` permits only `get_note`, `get_skill`,
   `add_note`, `update_note`, `add_skill`, and `update_skill`. Before completion
   it refuses `NATIVE_AUTHORITY_REQUIRED`. The actual original public
   dispatcher validates schemas and obtains fresh exact native approval.
   Cancellation reaches the socket request; late approval cannot grant a new
   request. There is no direct-filesystem mutation fallback.
6. Fully close the editor and await `component.close()`. This revokes the
   authenticated session, drains outstanding calls, and closes the actual
   owner. Failed shutdown does not qualify B1.
7. `preserveOriginalMcpColdComponentB1(component)` obtains a new actual cold
   fence and returns a private process-branded retirement ticket. It captures
   **every fixture-root child**, not a selected smaller DB list, verifies
   source identities/hashes and payload closure, restores a separate
   validation copy, and runs SQLite integrity checks there only. SQLite
   detection includes headers/SQLite3 sources; raw WAL/SHM/journal bytes remain
   in the sealed image, even if recovery removes sidecars on validation copies.
8. `retireOriginalMcpColdComponent(ticket)` checks sealed B0/B1 and current
   B1 again, writes a durable intent, and uses the real held fence's
   no-replace operations to archive **all** fixture children. No original
   inode is rewritten. Only a completed verified archive yields the branded
   retirement object. On a refusal retain state; `ticket.close()` releases
   unused custody. Partial retirement has no automatic replay/restore.
9. `restoreOriginalMcpColdComponentB0(retirement)` verifies the receipt,
   retained B1/archive and B0, and restores B0 into the **new sibling**
   `restored-b0`, never over the retired original path. Its receipt explicitly
   records a new root inode and `originalRootOverwritten:false`; this is not
   native owner/epoch rebind, credential recovery or actual-root rollback.

Committed `.pkm-next-todo`, `.pkm-next-memory`, and
`.pkm-next-retrieval-models` are included recursively and checked against their
actual typed SQL/file inventories before B1. Pending domain intents refuse
even if their directory does not yet exist: external Memory staging references
are not silently omitted. Unknown files/links, missing or changed receipts,
pending retrieval publication, and `.pkm-action-authority` retirement remain
explicit refusals. Positive optional-directory tests qualify **source byte/SQL
closure only**, not the still-missing genuine native domain approval methods,
production write plans or the default coordinator's B1 scope.

Models remain unavailable. Runtime preparation projects only the actual
authenticated tool-approval port; it does not pass an incomplete model/Chat
bundle or weaken NativeRuntime's complete-provider/catalog/reviewer guard.
`businessReady` and `fullCutoverQualified` remain false throughout.

`tests/original-mcp-cold-component.test.mjs` exercises actual owner/Core effects,
socket crypto, cancellation, B0/B1/SQLite, optional closures, typed retirement,
corruption and identity refusals. Its socket producer and source-domain
decisions are explicitly **fixture producers**, not installed-native UI proof.
The installed production-mode UI harness must separately qualify the complete
cold/editor-restart/same-owner sequence before any genuine-native claim.

## Separate authenticated native chat lane

`src/original-mcp-native-chat-rpc.ts` implements the fixed protocol
`pkm.original-mcp-native-chat-rpc/v1` on the **existing authenticated private
session**. It does not open a Root, inspect processes, import Storage/Core,
expose a Socket, copy credentials, execute arbitrary methods, or turn the
identity signature into model/tool/source permission.

The only methods are:

* `models.catalogue` — actual `vscode.lm` descriptors, current activation epoch,
  separate registry revision; no fabricated model/profile or token metadata.
* `models.select` — exact catalogue SHA/model ID to ephemeral selection handle.
* `models.count` — exact selection/request/message/image/tool/output-cap digest
  and actual native counting result.
* `models.stream` — one inference, bounded acknowledged `ModelProviderEvent`
  stream. Tool events are proposals, **never executions**. A finish event is
  required before successful completion.
* `execution.run` — the full `OriginalNativeChatExecutionPort` plan, including
  required budget and nullable hard 1–1000 tool-round boundary. There is no
  automatic replay, alternate provider, or VS Code-to-HTTP fallback.

### Node embedding

After actual support advertisement, call
`createOriginalMcpNativeChatRpcPort(actualSession)` (alias
`createOriginalMcpNativeChatPorts`). The frozen, process-branded resource has
`session` (the **actual** branded session), `models`, `execution`, `signal`,
`closed`, `assertCurrent()` and idempotent awaited `dispose()`.
`assertOriginalMcpNativeChatRpcPort(resource,expectedSession?)` and its `Ports`
alias verify the real resource, current session and lifetime; structural copies
and caller transport callbacks cannot satisfy this factory.

`waitForOriginalMcpNativeChatSupport(session,{signal?,timeoutMs?})` waits only
for advertised availability, not permission. Auth-only/approval-only clients
stay compatible and model calls refuse `MISSING_NATIVE_METHOD`. The server
registers this internal lane once, before publishing a real authenticated
session. The existing six approval methods remain a separate protocol; their
typed host domain supports the actual `api-chat-native` receipt label, which
itself grants no model transport or permission.

The trusted Source consumer must compare actual RootOwner/Storage/Host brands
and root/workspace/plan/catalogue/profile/epoch, obtain fresh native model and
effect approvals, and supply **its own canonical durable closures** to
`execution.run(plan,{beforeInference,tool,text,usage},signal)`. The transport
does not accept callback functions or successful Core receipts from the native
client. `beforeInference` validates the exact complete plan/source/selection,
portable actual native request, count and inference digest before returning
the Node callback's ACK. Inference IDs also bind prior canonical tool receipt
hashes. Native execution cannot continue before that durable callback settles.
Tool proposals require the current admitted inference/round, unique call ID,
exact arguments digest and a tool declared both in the plan and that actual
inference's tool catalogue. Only the server-side canonical closure executes
it and returns the receipt/effect. Unknown effects or rejected text/usage
sinks cannot produce successful continuation.

### Installed native client embedding

Only after the real installed
`createOriginalMcpNativeChatProducer(context)` succeeds, Parent wires its
`models` and `execution` into
`createOriginalMcpNativeChatProducerChannel({session,models,execution,signal,
assertCurrent,send,close,maxPacketBytes?})`. `session` is the exact attached
portable binding; `assertCurrent` must check the actual native signer.
`send` is the host's bounded JSON-line write and `close` is its actual
connection cleanup, not a business executor. Route `native-chat-*` frames to
`channel.receive(value)`, await `channel.support()`, and retain/observe
`channel.closed`. On detach abort the connection signal, await idempotent
`channel.dispose()`, and dispose the actual local producer. Aggregate cleanup
failures rather than hiding them.

The shared helper has a fixed five-port dispatcher; there is no generic
`execute(name,args)`. Advertisement is sent only after those actual producer
ports exist. This helper is not by itself proof that a native producer was
installed or that an LM invocation was authorized. Packet/session schemas,
payload/callback schemas and the `OriginalMcpNativeChatMethod`, `Session`,
`Frame`, `RpcPort`, and `CanonicalCallbacks` types are exported for this wiring.

### Bounded transfer and lifetime

Control frames remain within the existing per-packet limit, at most 64KiB
(the server default stays 16KiB). Logical JSON bodies are capped at **16MiB**,
depth64/one million JSON nodes. `native-chat-open` pins byte length and SHA256;
canonical-base64 `native-chat-chunk` frames carry exact monotonically increasing
sequence numbers and at most4096 raw bytes. Open and every chunk require an
exact bound `native-chat-ack` before the next chunk. The receiver checks the
complete byte hash and strict UTF-8/JSON/schema before use, never truncates,
and does not raise the global socket packet ceiling.

Every frame binds broker/activation/identity/epoch and all descriptor root,
workspace, plan, catalogue, profile, build and host pins. Every logical request
also has an exact canonical digest. Callback IDs/digests/sequences, stream
sequences and per-direction transfer IDs are independently checked.
Only one incoming and one outgoing transfer are active per peer; at most
four outgoing bodies/32MiB are queued, two RPCs are pending, two callbacks are
pending, and one unconsumed stream event is retained. The per-execution
262144-callback ceiling is a counter, not an allocated queue; request deadlines
remain at most300s. Partial transfers/ACKs time out after30s.

`native-chat-cancel`, local cancellation, timeout, disposal or disconnect
abort pending native method signals. Late replies cannot authorize another
request. Lost or post-dispatch outcomes retain `dispatch:"uncertain"` and are
never replayed automatically; cancellation is not a no-billing/no-effect
claim. Disposal revokes the resource, drains owned Node callbacks, and visibly
refuses unconfirmed cleanup. Protocol/cleanup failures are observable through
`closed`; repeated disposal preserves the same failure.

`tests/original-mcp-native-chat-rpc.test.mjs` exercises real Unix sockets and
crypto with **fixture model producers**, including a15MiB image request,
per-chunk and event-consumption backpressure,31 and1000 tool-round executions
plus summaries, durable-callback ordering, cancellation, unknown effects,
undeclared tool refusal, corruption, credential-field refusal and cleanup
failure propagation. `tests/fixtures/original-mcp-native-chat-session.mjs`
exports a minimal actual-socket fixture for the separate Source/Core consumer
tests; neither fixture supplies genuine VS Code/model authority.

Models remain unavailable until the actual installed producer, this transport
and genuine native approvals are wired and qualified together. FullAPI8/full151,
business promotion and actual-root cold admission are **not** qualified by
successful model control RPC. The genuine whole-editor cold attempt remains
blocked by actual visible/uninspectable legacy writers; this lane does not
narrow process inventory or introduce PID exemptions.
