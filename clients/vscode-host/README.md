# pkm-v5 — experimental VS Code host

The test package and display name are **`pkm-v5`**; its VSIX identity is
`pkm-nonproduction.pkm-v5` and its default artifact is `pkm-v5-0.1.0.vsix`.
Core discovery (`name`/`serverId`) and the native, Note and compact MCP adapters' initialize
responses use `pkm-v5`. The native VS Code MCP provider ID and definition label
are also `pkm-v5`, distinct from the existing production `pkm` provider.

On VS Code versions with the native MCP API, the default provider publishes a definition
only when **user-level** `pkm.nextHost.managedRoot` explicitly selects an already
provisioned isolated managed generation. It uses the existing verified isolated
launcher; no account binding or user/workspace MCP configuration is written.
Workspace configuration is ignored. Changes to `managedRoot` or
`productionCoordinator` immediately invalidate old definitions and notify native
VS Code to rediscover servers; no reload is required. Definitions are also
revalidated at resolve time, and changed/forged definitions are rejected.
The same-root coordinator excludes this provider while enabled.

### Independent SDK model bridge

The source bridge keeps `vscode.lm` unchanged and adds an independent
`copilot-sdk` catalogue, selection and execution lane on the same authenticated
Chat IPC. SDK prompt measurements are UTF-8 bytes, **not native token counts**.
Actual HTTP requests, WebSocket connections and WebSocket messages wait for
current Core durability and separate native-human sending approval. These
records are sending boundaries, not `beforeInference` evidence. SDK usage is
provider-reported; absent usage/cost remains unknown. Canonical tools still
require their own current source, actor and effect approval.

`OriginalSdkHostControl` must supply the actual SDK module, independently
verified live runtime admission, approved current-user account accessor and
an explicit absolute runtime path/private working directories. There is no
default SDK bootstrap, automatic login, shared-runtime takeover, native-model
fallback or grant copied from the Host. The root-only composition facade uses
the public constructor's `requestHandler`, then the same retained
`streamCopilotSdkChat` executor. Summary sessions receive fresh IDs only after
awaited retirement of the prior session. SDK code never generates human
approval. Existing Todo role admission still requires native inference
provenance for its unchanged native variant. The separate SDK role variant
uses actual session, sending-boundary and canonical tool-receipt identity;
its child Chat actor comes only from the original same-Chat signed role grant.
The worker gate/receipt projection keeps its narrowly scoped SDK branch
separate; SDK does not invent `inferenceId`/`round` or produce human acceptance.

The normal `@github/copilot-sdk@1.0.34` public declarations/JavaScript support
the handler API; deprecation is not a reason to replace it blindly. Its
`start()` ignores the enrollment response's `success` field, so the facade
also verifies that result through the public RPC. This acknowledgment alone
does **not** qualify the installed Host runtime. In-memory tests execute the
genuine handler's cancellation path without starting a runtime or sending a
model request; lifecycle/transport doubles are not runtime proof.

All product SDK imports here are type-only: the actual module/runtime comes
from the admitted Host port. The npm SDK is therefore a development
type/test dependency, not a reason to embed another optional platform CLI
in Core's production payload. Parent-owned packaging must use normal
dependency placement/staging, not strip required SDK files manually, and
export the existing retained SDK executor/prompt/model-conversion functions.
Official account/Auto/role activation still requires the current Host
attachment wiring and independent private-profile acceptance; Recovery VSIX
evidence does not qualify this bridge.

`createOriginalMcpNativeSdkHostControl` now owns the selected-module/runtime
validation and Linux egress owner. It requires readonly module/runtime/launcher mounts,
explicit private HOME/XDG/work/scratch paths and a clean approved environment;
credential, proxy, config, skill and instruction auto-inheritance is not
accepted. The product launcher is `original-mcp-native-sdk-supervisor.py`,
not the test isolation helper. The public SDK constructor launches the
pinned interpreter/supervisor using `RuntimeConnection.forStdio` arguments;
the genuine SDK module and awaited forwarder remain in the Host namespace.

The supervisor closes extra inherited descriptors, creates separate
user/network/PID/mount namespaces, drops capabilities, sets `no_new_privs`,
and installs an inherited seccomp filter blocking namespace/mount escape,
UNIX/vsock proxy sockets, FD theft/ptrace and io_uring bypasses. The fresh
network has no external or Host-loopback route. A private control channel
admits the CLI only after the Host verifies actual process ancestry,
namespace handles, capabilities/filter state, immutable pins and blocked
network probes. PID-namespace teardown and owned reaping cover descendants.
The managed-child close callback is registered before launch. Missing Linux
namespace/filter/interpreter/readonly-mount support fails closed; no sudo,
system firewall changes, inherited credential socket or uncontained fallback.
Abort and manual close share one drain operation. Cleanup errors retain their
original causes, latch the owner closed, notify the Host diagnostic port and
remain visible through later `assertCurrent`/`close`. Registration/listeners
detach once even after failure. Partial reservations remove only their pinned
owned directory/server/namespace handles. Control frames are serialized and
bounded; malformed or duplicate frames terminate the owned client rather than
leaving a failed-but-live lease.

Its actual SDK `1.0.34` / runtime `1.0.112` (protocol 3) observations demonstrate
startup registration, kernel-blocked CLI egress, and awaited local HTTP/WSS
connection/message paths across two fully settled synthetic prompts each.
Synthetic TLS response fixtures are transport evidence only, not real
model/role/human success. No official account or production endpoint is used;
per-process synthetic TLS trust does not modify system trust.

The public API's registration success alone still proves no no-bypass
capability. The supported Linux factory instead requires enforced child
egress on every real client launch and current kernel-bound lease checks;
without that owner it remains `NATIVE_SDK_NO_UNINTERCEPTED_SENDING_PROOF`.
Unknown/replacement admission objects cannot enable SDK. `sdk.status`
reports unsupported configuration separately from the unchanged native LM
catalogue. No bounded-run downgrade is offered.

Official catalogue discovery is a separate unresolved boundary:
`client.rpc.models.list()` sends a CLI control RPC, not a model-layer handler
request. `onListModels` applies only to `client.listModels()` and does not
silently intercept that RPC. A bounded genuine-runtime probe with a synthetic
invalid credential rejected without entering any model-sending hook. This is
not official account/model-list evidence. Until an actual current-account
Host catalogue path is qualified, the native bridge reports
`NATIVE_SDK_CATALOGUE_CONTROL_EGRESS_UNSUPPORTED` before account/model work;
it advertises no fabricated Auto model, silently substituted LM or unrestricted
CLI networking. The supported Linux transport boundary is not a full SDK route.

`selectOriginalMcpNativeSdkProvider` is the VS Code-only local UI adapter. It
selects exact readonly public SDK/runtime files, interpreter and a private
profile parent; it creates fresh private HOME/XDG/work/scratch directories.
Only an already-authorized silent native GitHub session is offered for explicit
account consent. Every later accessor rechecks the same account/session; no
new login, session preference change or credential file is used. It returns an
opaque one-use selection, not JSON model authority.
`createOriginalMcpNativeSdkProviderFromSelection` binds that selection to the
Parent-owned current attachment, managed-child registry, diagnostics and
destination/approval ports. Parent must retain its returned `close` resource.
Unknown cleanup preserves a consumed private profile for reconciliation rather
than deleting a possibly live child's files. Neither descriptor API registers
commands, broadens Core authority or claims official SDK catalogue success.

The observed WebSocket connect and `response.create` message share their
request/session/invocation context. They are distinct boundary kinds.
`agentInvocationId` is documented as stable across physical retries, while
the public context and observed message expose no distinct logical message
ID. Actual second settled prompts reuse a WSS connection/request ID but
receive distinct runtime invocation IDs, so the existing replay guard admits
those continuations. Repeating a logical sending identity remains refused; multiple
distinct messages under the same identity are unqualified, not silently
accepted by inventing round/sequence IDs or using changing payload hashes.

Bounded repro (no emission):
`PKM_SDK_PARENT_NETNS=$(readlink /proc/self/ns/net) python3 tests/framework/isolate.py node --test tests/original-mcp-native-sdk-runtime-conformance.test.mjs`

### Explicit cold-started original-library enrollment

The separate original-library route is an offline opt-in, not automatic
adoption. Only after qualified backup, native owner and broker setup may the
operator publish `original-mcp-enrollment.json` in this extension's own private
global storage directory. Its exact fields are `schema` =
`pkm.original-mcp-enrollment/v1`, `descriptorPath`, `descriptorSha256` and
`profileSha256`. It contains no token. The profile digest comes from
`originalMcpProfileBinding` and binds this extension's canonical owned private
storage directory and device/inode identity. It does not attest or migrate the
old extension's SecretStorage/keyring.

The broker descriptor is verified with its independently retained SHA and
profile binding; native MCP launches only its pinned Node/relay paths, never
token-bearing command arguments. This route refuses a concurrent old
`Uone.personal-knowledge` extension, `managedRoot` selection or enabled
same-root coordinator. The current-profile route additionally requires every
operation in the independently captured full original catalog, with writable
admission; it refuses a knowledge-only, partial or read-only descriptor.
Matching this catalog is necessary, not proof of automation/Chat/runtime
parity: actual native authorities and end-to-end behavior must also pass
cutover qualification.

The selected credential strategy keeps this independent extension ID. Old
`uone.personal-knowledge` SecretStorage is not read, copied or replaced.
The source-only **Enroll Separate Native Identity** command creates an
Ed25519 identity in the new extension's SecretStorage after native consent.
Only the public profile-bound record is written to
`original-mcp-native-identity.json`. Each candidate key has its own slot:
concurrent enrollment cannot replace the winning identity's private key.
Missing enrolled keys fail rather than silently rotate.

The public record must be independently pinned in an offline plan. Fresh
attachment challenges bind the root, workspace, plan, catalog, profile,
installed build and native activation; signatures are one-use and expire.
This authenticates a producer only, not model/tool/effect permission.
`node installed-test.mjs --native-identity` verifies actual Production-mode
VSIX enrollment through a real native modal, then reloads the window and
recovers the same key from a different extension-host process. It uses a
private profile/network/display and a **basic test-only password store**:
this is not qualification of the actual profile or its OS keyring.
The installed test also verifies actual native attachment consent/signing to
a separate Node broker and liveness beyond its heartbeat deadline. This is
identity authentication only. Per-request native RPC, model/tool/domain
authority and full business activation remain separate gates.
No actual user-profile credentials have been changed by this source work or
these disposable-profile tests.

The separate frozen `original-mcp-native-bootstrap.json` pointer permits only
native attachment. Its schema is `pkm.original-mcp-native-bootstrap/v1`, with
`descriptorPath`, `descriptorSha256` and `profileSha256`. It cannot substitute
for business MCP enrollment or hot-publish a business endpoint.

The source native attachment client starts only when that pinned bootstrap
was present at activation, or through **Attach Native Producer**. It checks
the exact Root/profile/plan/catalog/build challenge, signs after native
consent, and answers bounded liveness probes. An authenticated socket is
explicitly `businessReady:false`, not a model/tool/domain grant. Changed
bindings or attempted premature business publication close the connection.
No Root is opened by this client and failed attachment is not auto-replayed.

The client advertises only implemented request handlers. Fresh native
admission permits public reads for the exact current binding; writes and
tool reviews require their own native decision. Shared strict parsers bind
the activation/epoch, Root/profile/plan/catalog and full request digest.
Cancellation invalidates a later native click. Public read classification is
checked against the shipped canonical contract, never trusted from the
request's `readOnly` field. `model.approve` accepts only an exact, pending
VS Code inference from the separately enabled model channel, once. It cannot
authorize standalone or HTTP model requests.

The optional 25th method, `knowledge.trash.approve`, has separate action-specific
default-Deny decisions for scoped public Note Trash listing, move and restore.
Ordinary Host/public/model approval is not Trash authority. Each result binds
the exact current native session, operation and complete request digest with a
maximum 120-second expiry; cancellation invalidates late clicks. The original
deletion aliases are unchanged, and canonical list/restore are not advertised
as new original MCP aliases.

This producer registration is not successful native Trash migration proof.
Receipt-linked original custody, startup/recovery, pre-existing buckets,
physical effects and installed B1/fresh-B0 require independent validation.
Old original buckets remain read-only in the current bounded Source increment.

### Installed Todo exact-source lifecycle

`--native-todo-lifecycle` runs the separate `installed-native-todo-lifecycle.mjs`
acceptance leaf; no new production MCP alias is registered. Parent supplies
the exact installed package and branded cold fixture, configures
`installedNativeTodoLifecyclePrivacyPolicy`, calls
`prepareInstalledNativeTodoLifecycleFixture({ installed, componentFixture,
legacyVsix, python })` before B0/admission, then
`verifyInstalledNativeTodoLifecycle({ root, installed, component, sourceFixture,
payloadBuildId, python, env, port, timeoutMs })` with the actual component.

The component exposes only `revokeTodoGenesisSource(boardSlug)` and
`activateTodoGenesisSource(boardSlug, { signal? })` for this slice. Activation
derives its signed Host/Root/session, uses existing method26
`phase: "activate-source"`, and returns an opaque, one-Board capsule—not
serializable authority. Durable receipts never grant live access.

The new UI observer uses default-focused Deny/Enter and a separate handshake
for each create/activation cancellation: actual rendered modal ready,
transport settled with `NATIVE_REQUEST_CANCELLED`, then affirmative choice on
the same retained DOM node. Parent closes the component and editor, calls
`pinInstalledNativeTodoLifecycleStopped(sourceFixture, component)` before
B1/retirement, then uses `verifyInstalledNativeTodoLifecycleB1` and
`verifyInstalledNativeTodoLifecycleRestored` with `{ retirement, b1, restored }`
as applicable. No archived SQLite is reopened. Source/headless mechanics tests
are not installed acceptance; recovery, workers, reviewers and human
acceptance remain outside this leaf.

The installed run now qualifies exact-source revoke/renew, both create and
activation transport cancellations with same-modal late choices, and
stopped-image B1/fresh-B0 preservation. It has six PUBLIC and five GENESIS
dialogs, four canonical receipts, clean editor/UI exits and profile removal.
Preparation keeps the lifecycle oracle inside its own isolated release root.
Unchanged controls are checked against the post-prelude bytes; the independent
original B0 baseline is retained separately for restoration.

`--native-todo-recovery` separately qualifies the bounded empty-Board pending
creation checkpoint: intent and Note/backing durable, canonical/index/source/
receipt absent. The experimental callback is fixture-bound and owner-side;
its one-use worker control grants no business authority. Fresh deny and
approve editor epochs use the same original UUID/custody/B0, completing one
creation receipt/source row. Stopped-image B1 and fresh-B0 checks do not reopen
archived SQLite. Any sidecars already captured by B1 must match that exact
image and payload; WAL must be empty, and new sidecars are refused. This is
not arbitrary crash recovery, worker/human authority or production cutover.

The isolated installed-native test also covers admission, pre-admission
denial, scoped reads, explicit write denial/approval, cancellation while a
real native modal is visible, and ignoring its later approval click.
Those are native permission-RPC tests, not actual business mutation or
full151 qualification.

**Re-enroll Native Model Credential** uses a masked native input and writes
only a profile-specific slot in the new extension's SecretStorage. Its logical
`personalKnowledge.aiApiKey` lookup returns presence only after native
profile validation; arbitrary secret lookups are rejected. Keys are not
returned in command results or written to profile files. This source command
does not supply a model transport or approve model requests.

**Enable Native VS Code Models** explicitly enables the separate fixed
`models.catalogue/select/count/stream` and `execution.run` lane after native
consent. Native model selection and execution each require another native
confirmation. The actual model objects remain in the extension host; there
is no HTTP fallback, guessed provider limit or arbitrary method execution.
Large requests use bounded, hashed, acknowledged chunks rather than schema
truncation. Inference and tool callbacks must return to the owning Core.
That Core still needs its exact source/domain/permission and durable receipts.

The existing retained native Chat loop supplies original hard-round limits
and a final tool-free summary. Registry changes revoke selections. Initial
provider discovery can itself change the registry, so only that read is
retried, at most three times; inference is never automatically replayed.
Model-channel shutdown closes the socket independently of channel disposal,
avoiding a recursive cleanup wait.

`node installed-test.mjs --native-identity --native-models` exercises the real
Production-installed VS Code API, native consent, authenticated Node IPC,
token counting, streaming, and 31 tool rounds followed by a tool-free summary.
It registers a **synthetic deterministic local provider**, not a remote model
or the user's Copilot. This proves native API/transport/loop integration only,
not actual-profile credentials, canonical business effects or full151 parity.

The test-only `--native-model-token-persistence sync|buffered` option requires
`--native-models --native-model-rounds 48`. Both arms must use the same sealed
VSIX and unchanged resource, 1-second headroom and 2-second heartbeat limits.
Only per-token counter-file writes differ; serialization and non-token writes
remain. One post-settlement true-counter flush is acknowledged before assertions.
Missing or budget-blocked flush remains a failure, not a stale counter fallback.
Default 31-round behavior is unchanged; a buffered result never qualifies the
original synchronous gate.

The tokenizer producer now yields to the event loop after each16 completed
native counts, preserving every count, approval, cancellation and limit.
A fresh synchronous48-round installed profile passed the existing resource/
headroom criteria, terminal log coverage, native UI controls and clean removal.
This is bounded synthetic-provider acceptance, not a historical OOM diagnosis
or long-running/remote-provider stability guarantee.

### Basic Skill acceptance

`node installed-test.mjs --vsix CANDIDATE.vsix --native-identity --cold-component
--native-skill-basic --legacy-vsix ORIGINAL.vsix --evidence REPORT.json` runs a
disposable original-root Skill sequence: create/read/update/read, same-name
upsert/read, list and lexical retrieval of the new marker. The cold component
exposes the existing read-only `list_skills`/`search_skills` handlers for this
test; it creates no new business executor or permission.

The real native producer keeps its existing classification: approved Host
admission permits public reads; mutations require exact independent native
decisions. The profile verifies three durable Skill receipts with one stable
ID and revisions 1/2/3, exact updated bytes and all receipts at B1, and absence
of the created Skill after fresh B0 restoration. It requires complete editor/
reader/owner/coordinator shutdown and actual profile cleanup.

This does not qualify semantic retrieval or replacement of an occupied file
with another identity. The separate compatibility MCP case in
`tests/compatibility-mcp.test.mjs` verifies the direct Skill module wrappers,
partial-field preservation, same-name overwrite, lexical search, wrong-read-lane
denial and persistence after actual gateway reconnect. A gateway/catalog check
alone is not a Skill write-permission or full migration proof.

In a development checkout, the module acceptance tests share
`tests/compatibility-mcp-fixture.mjs` (not shipped inside the host VSIX).
Its optional setup hook runs only inside the newly owned disposable library,
before original server generation/staging. Script tests may prepare/edit their
controlled external fixtures; this does not create a Script write API.
Extracting this helper preserved all fourteen actual compatibility cases.
Owned sidecar workers register through `retainCleanup`; MCP clients close and
workers must exit before the shared fixture is removed. A separate late
`t.after` hook is insufficient because those hooks run in registration order.

### Script custody correction

The old original-root policy records `scripts` only as an auxiliary directory
name, not file membership/identity/hash entries. A native regression proved
that post-seal public edits could be reindexed without a new confirmation.
Therefore that policy must not be described as immutable Script custody.

The approved replacement is **frozen-root**: versioned Script B0/custody and
admitted public membership/pin checks before indexing, with revalidation after
asynchronous work. External changes require explicit operator recapture/
confirmation; old auxiliary-only plans must not be silently reinterpreted.

The isolated `--native-script` scenario requires `--native-identity`,
`--cold-component` and a pinned `--legacy-vsix`. It uses separate denied and
approved editor lifetimes, a genuine in-memory denial witness and independent
driver/UI markers. The optional `--held-old-script-parser-vsix` and
`--held-old-script-parser-sha256` must be supplied together; absence means no
old-package proof is claimed. This read-only profile does not run the ordinary
Note/Skill write prelude. The isolated installed run now verifies distinct
deny/approve editor epochs, exact public get/search, private exclusion,
generation 1, unchanged business receipts, stopped-image B1 and fresh-B0
restoration. Both editor/UI segments exit 0 and the private profile is removed.
The actual HOME need not be private; the recovery base and branded fixtures
must be. Helper/syntax tests alone still prove none of these installed effects.
Script execution, external recapture and actual old-v1 owner serving remain
unqualified.

The `--native-note-paper-basic` profile qualifies PUBLIC Note/Paper
create/read/update/list/lexical search with 29 acknowledged stages,
13 independent PUBLIC choices, four canonical receipts and B1/fresh-B0.
Admitted-Root Note inventory filters private subtrees before byte reads;
the unrestricted compatibility inventory is not used for that public lane.
Original raw Markdown writes do not assign identity/revision, so native
stable-ID/revision increments are evidenced separately rather than claimed
as Original raw-writer parity. Paper offline lexical search remains
metadata-only; body-only queries are empty. Semantic/PDF/network and
read-only-actor/stale-CAS caller lanes are not qualified by this profile.

The separate `--native-research-basic` profile is wired for exact Research
stable-ID/slug reads, metadata lists, offline lexical search and local citation
graphs. `list_research` has no pagination; `paper_graph` retains its independent
PUBLIC approval. The fresh installed profile passed 16 acknowledged stages,
four graph choices, typed stopped B1 and exact fresh-B0 restoration with
clean editor/uninstall/profile removal. Paper-profile evidence does not
qualify these four aliases; semantic/network retrieval and full cutover remain
unqualified.

The separate `--native-knowledge-recovery` profile has qualified zero-write
evidence preview and normal repair of one already-registered PUBLIC, unshared,
asset-free baseline Note at its retained Original `0644` mode. Seven stages
use actual evidence pickers and independent Source/PUBLIC/repair decisions.
Wrong plan hashes and occupied paths refuse without effects; successful repair
preserves raw identity/revision, bytes and index lineage with exact audit/custody
receipts, stopped B1 and fresh-B0 closure. Unknown owners, private resources,
attachments, unsupported mode provenance, multi-owner and arbitrary crash/Root
recovery remain unqualified. No existing file is overwritten.

The separate `--native-action-pure` profile passed eight no-review stages:
the complete Original template catalogue, bounded invalid-definition schema
diagnostics and closed basic-component graphs. Valid-definition registry checks,
Action-referencing graphs and capabilities that require private runtime state
remain denied. Knowledge/business state is unchanged and stopped B1/fresh-B0
closure is verified. Only templates are a complete operation; these checks do
not qualify Action execution, source admission, Cosmos or credentials.
This Source change is still being implemented. Public serving/indexing must
not read private Script bytes; separately authorized offline backup is not a
public/private-reading grant. Original/A unsealed refresh remains separate.
No Script write or execution API is added.

### Installed public Note Trash acceptance

The separate `--native-skill-paper-trash` profile has qualified post-admission
PUBLIC Skill/Paper deletion and receipt-linked restore for unshared owned
pairs. Note v1 remains unchanged; Skill/Paper requests use strict v2.
The verified run has 23 acknowledged stages, nine PUBLIC and twelve target
choices, four canonical receipts/successors, raw identity/revision/pair/history
preservation, stopped-image B1 and fresh-B0 restoration. `list_papers` retains
its Original non-read-only contract and requires a separate PUBLIC choice;
it is a verification call, not full Paper-list qualification.

An optional `--held-old-trash-parser-vsix` / `--held-old-trash-parser-sha256`
pair performs actual sealed-v1 schema refusal of receipt/UI-linked v2 packets.
Absence is explicitly unperformed; a Note-v1 DTO control is schema-only, not
old-owner serving. Old bucket restore, generic native file-trash, destination
collision and installed interrupted Skill/Paper recovery remain separate
unqualified gates.

The separate `--native-trash-lifecycle` profile has qualified actual
transport cancellation/late-choice refusal, canonical restore collision and
one-use injected partial-move recovery through fresh deny/approve editors.
It requires the same isolated identity, cold component and pinned original
package as the fresh Trash profile. The fault callback is available only on
the branded component API, never through MCP arguments. Helper mechanics are
not installed fault/recovery qualification by themselves. The installed
profile verifies all three epochs, unchanged prior/private controls,
receipt-linked B1/fresh-B0 and clean editor/UI exits. Original old-bucket
restore and Skill/Paper deletion remain separate unqualified gates.

The `--native-todo-genesis` profile has passed bounded installed acceptance. It prepares
an empty public category in a branded cold fixture, exercises independent
PUBLIC/genesis approvals and basic Original-shaped Board/WorkItem calls,
then verifies paired source bytes, the stopped B1 image and fresh-B0 absence
of the Board and native grants. The verified run has eight PUBLIC and two
GENESIS dialogs, five canonical receipts, twelve invoked Original aliases,
clean editor/UI exits and private-profile removal. Original contracts come from the exact
installed catalog; the canonical Todo/Memory discovery registry is not
misrepresented as Original-ID discovery. This does not qualify worker/human
acceptance, source renewal or pending-genesis recovery.

`node installed-test.mjs --vsix CANDIDATE.vsix --native-identity --cold-component
--native-trash --legacy-vsix ORIGINAL.vsix --evidence REPORT.json` runs the
bounded post-admission Note/owned-pair lifecycle. It requires three original
public choices and eight independent Trash choices, including focused-default
Enter denials, Escape dismissal, stale source refusal and exact restore-UUID
replay without another effect/review.

The parent qualified two real runs: exact raw identity/revision/pair/history,
two mutation receipts and two custody successors, unchanged private/prior
read-only buckets, B1 receipts/data and fresh B0 without native DB/grants.
Complete editor/reader/owner/coordinator exit and profile cleanup are required.
This does not qualify transport cancellation, destination collision, pending
recovery, old pre-admission bucket restore or Skill/Paper deletion.

The full native facade defaults to the hybrid module-tool surface documented
in the root README: common Note/Skill/Paper content actions, Script reads and
retrieval can be called directly; the discovery/execution gateways remain.
The profile route must not assume that `tools/list` contains exactly nine
entries. Additional direct tools do not replace or weaken any canonical
operation or native approval.

Enrollment is frozen per activation. Adding/changing/removing it while the
host is live requires reload and fails closed; it never hot-falls back to an
old engine or another root. It does not revoke already attached broker clients;
global maintenance and shutdown belong to the authenticated broker. The host
never starts a new original RootOwner or adopts a root. Profile enrollment is
not cold-shutdown proof or permission to bypass the existing writer checks.

For side-by-side installation/comparison, keep old `pkm` installed and use owned
nonproduction profiles and separate disposable data roots. The host's existing
`pkm.next*` command/settings IDs, `pkm.next-host.bearer` SecretStorage key (scoped
to this extension), internal schemas, workspace markers and runtime compatibility
paths remain stable. They do not reuse the production extension's credential or
default data selection. Coexistence is **not** permission for simultaneous writers
on the same Root.

After qualification, an explicit public rename can change `src/public-identity.ts`,
`compat/legacy-compact-mcp.py`'s `PUBLIC_NAME`,
the two package manifests, root lockfile, provider contribution and packaging/test
expectations to `pkm`. That alone does **not** replace the installed production
extension: publisher/extension-ID migration, credentials, profile/data ownership,
conflicting provider removal and an authorized replacement/install remain separate
decisions. Nothing here automatically cuts over or weakens admission guards.

This is a **separate, nonproduction extension**. It does not modify or activate the
production extension. Its HTTP path does not start a server. It does not select a Knowledge Root, implement
all legacy approvals, or provide feature parity. Its separate first-run commands
can inspect and import a supported **disposable legacy copy** into a new isolated
workspace; they never select or switch the production Knowledge Root. Run it in
an isolated profile (host-only VSIX or Extension Development Host); do not install it alongside another extension registering
`pkm.next.connect` and `pkm.next.disconnect`.

## Provisioning and use

1. Start and provision next-server separately. Independently obtain its loopback
   origin, actual storage workspace ID, authenticated actor ID, and bearer token
   from the trusted server operator. Bind these to the same server instance and
   actor; never copy identity values from the server's own response as attestation.
2. Set **user-level** `pkm.nextHost.origin` (exactly
   `http://127.0.0.1:PORT`), `pkm.nextHost.workspaceId`, and
   `pkm.nextHost.actorId`. These settings are machine-scoped; workspace/folder
   settings are deliberately ignored. The trusted configuration independently
   asserts server ID `pkm-v5`, protocol `v1`, workspace and actor. The client
   compares it with authenticated server info before capability discovery.
   The host relies on the operator's secure provisioning; it does not discover
   server identity independently or protect a compromised user profile.
3. Execute **pkm-v5 (Experimental): Store Token** and enter the token in the
   native password prompt. It is stored using VS Code SecretStorage under a fixed
   opaque key, never in settings or the webview. Execute **Connect**, then **Open**.
   Connecting again or changing the token closes panels and disposes the client.
   Errors shown to the user are deliberately generic.

The webview has a restrictive CSP, no network access, and renders responses as
text. Each panel receives its own host-created channel identity. No webview
message selects an endpoint, credential, transport path or review authority.
Human review is not registered or exposed. Disconnect or extension shutdown
disposes panel bindings, commands and clients. Pending uncertain writes are kept
only in client memory and are lost on replacement/disposal; reconcile server
receipts before submitting a replacement. If a connection is reset with in-flight
or uncertain writes, the host warns and records their operation IDs in the
**pkm-v5 Experimental** output channel without recording request bodies or
credentials. This session-only diagnostic is not durable recovery: a shutdown
may prevent the warning from being seen, and exact retry bodies are still lost.
No automatic replay is performed.

## First-run import (explicit opt-in; no cutover)

The installed host exposes two Command Palette commands. They need no HTTP
connection, token, `managedRoot` setting, or repository checkout at runtime:

1. **pkm-v5 (Experimental): Preview First-Run Import** asks you to select an
   existing, quiescent **disposable legacy copy**, a **new destination directory
   path** (the save dialog selects a path, not an existing workspace), a trusted
   Node.js executable **>=22.18 with `node:sqlite`**, and a trusted Python executable
   for atomic no-replace publication. No path is inferred from settings, workspace,
   home, or the production extension. The destination's parent must already exist;
   source and destination must be disjoint, canonical trees without directory
   symlinks. You must separately acknowledge that this is a disposable copy before
   inspection. Never select live production data.
2. Read the **pkm-v5 Experimental** output. It is a read-only VS Code output
   channel, not a file saved into the source or destination. The JSON includes exact
   source/destination/runtime paths, full bounded preflight, inventory mappings,
   blockers and plan SHA-256. A blocked/incomplete plan cannot be confirmed.
   Preserve and review unsupported material; do not delete data just to pass
   preflight. There is no “ignore blockers” or native-authority override.
3. Only after review, run **pkm-v5 (Experimental): Confirm Inspected Import**.
   A distinct modal repeats the exact paths, runtimes and digest and explicitly
   authorizes staging, receipt writes and publication. Cancel/deny consumes the
   in-memory plan without writes. Changing selections requires a fresh preview;
   reload also discards approval. Confirmation passes that inspected plan and
   destination unchanged to the existing importer, which re-inspects the source
   and rejects fingerprint drift **before** creating staging files. The destination
   is rechecked and published using atomic no-replace semantics, never overwritten.
4. Review the receipt in output. No HTTP/managed connection, generation
   publication, production-root selection, service switch or automatic retry follows.
   Import publication here means publishing the **new isolated workspace**, not
   switching the active PKM service. On an uncertain helper failure after approval,
   preserve staging/outcome evidence and use the existing `import-status` recovery
   flow before any retry; this UI does not implement recovery/cleanup.

### Remaining real-user migration blockers

This is a bounded first journey, **not full migration**. You must independently
prepare a complete quiescent disposable copy and provision the trusted runtimes;
the host neither makes a production backup nor certifies copy completeness.
Only Linux/Windows atomic no-replace platforms are supported by the importer;
Python/OS API and destination permission failures may still require reconciliation
after confirmation. Node/Python are user-selected trusted executables, not
downloaded or attested by this host.

The host deliberately supplies **no** snapshot-key, subscription-identity,
trash/Recipe-trash, Memory scope-continuity, or retrieval-learner native approval.
Source layouts requiring those independent authorities remain blocked by existing
APIs; a user confirmation is not a substitute. Memory/router/retrieval-history
sidecar policy selection is not exposed here, so this is not a claim that external
legacy state has been imported. Unsupported entries, pending recovery state,
identity conflicts, bounds, symlinks and platform restrictions require explicit
resolution and a new preview. Connecting/provisioning an imported workspace,
feature parity, backup/restore/rollback qualification and production cutover remain
separate work.

## Build and tests

From the repository root, with the existing TypeScript, esbuild, VS Code types
and next-server dependencies already installed:

```sh
# Direct packaging or direct node test runs need current generated assets:
npm run build
npm --prefix clients/vscode-host run build

# Canonical host selectors prepare fresh Core, compatibility and host assets
# automatically in the isolated preparation layer; manual builds are not needed:
npm test -- --file clients/vscode-host/host.test.mjs \
  --file clients/vscode-host/electron-test-packaging.test.mjs \
  --file clients/vscode-host/live-runtime.test.mjs --jobs 1
```

The adapter suite executes the bundled extension against a VS Code module
harness and an actual loopback HTTP server, including identity mismatch,
workspace-setting rejection, per-panel isolation, secret handling and disposal.
It also copies the built package assets into a fixture installation and invokes
the new commands against the **real packaged planner/importer and SQLite worker**.
Synthetic package-local trees prove picker/acknowledgement cancellation, final
denial, blocked/overlapping destinations and source drift cause no filesystem
changes, while confirmation publishes the exact inspected source fingerprint and
destination. No production root/profile/data is read. This is package-harness
coverage, not a claim of native-dialog Electron acceptance.

### Host-only VSIX and private installed-profile acceptance

```sh
npm --prefix clients/vscode-host run package:vsix
npm --prefix clients/vscode-host run test:installed

# Retain and verify one exact artifact, with durable native evidence:
node clients/vscode-host/package-host.mjs ../../artifacts/pkm-v5-host-0.1.0.vsix
node clients/vscode-host/installed-test.mjs \
  --vsix artifacts/pkm-v5-host-0.1.0.vsix \
  --evidence artifacts/pkm-v5-host-installed.json
```

`package:vsix` uses an **already installed** `vsce` CLI (or explicit
`PKM_VSCE_EXECUTABLE`), `--no-dependencies`, and an allowlisted staging directory
containing only this host's manifest, built assets, README and license. It emits
`pkm-v5-0.1.0.vsix` in this package. It does not invoke the
production packaging scripts, modify the production manifest/entry, or install
tooling. Output paths passed to `package-host.mjs` are relative to the host package;
`installed-test.mjs` paths are relative to the invoking directory. Build Core
first; host build compiles the unchanged retained CommonJS sources and stages a
complete `next-runtime` with locked production dependencies. The archive includes
a thin migration helper that imports the same installed Core importer, SQLite
worker, compatibility Python assets and retained resources from that payload.
There is exactly one physical unchanged retained authority closure under
`next-runtime/server/legacy/dist`; the extension's managed client externalizes
its shared session imports there. The shared active-host Core brand leaf is
never bundled into the extension or first-run helper. Source checkout and Node
dependencies are not needed at runtime. The build first clears its own `dist` and records every asset's
SHA-256 in `dist/host-build.json`; packaging rejects missing, changed, additional
or linked assets rather than silently shipping stale build files. The unchanged
retained verifier validates the full installed payload and its exact host-version
binding before packaging and again after real installation.

`test:installed` requires existing Linux `unshare -Urn` support, `ip`, `xauth`,
`xdpyinfo`, cached Xvfb (or `PKM_TRIAL_XVFB`), cached VS Code plus its `bin/code`
CLI (or `PKM_VSCODE_EXECUTABLE`), existing `vsce`, and Python Playwright. The installed
journey does not require the optional `@vscode/test-electron` development runner. Missing
prerequisites fail explicitly; there is no download/install/mock fallback.
Everything writable—HOME, XDG storage, temporary files, display authorization,
user data, installed extensions and disposable source/destination—is under a
fresh package-local directory. A private network namespace exposes only loopback;
Xvfb uses private authenticated TCP, with Unix sockets/locks disabled. Git parent
repository discovery, updates and telemetry are disabled. The production extension
is neither installed nor loaded.

The test actually packages and CLI-installs **this host's VSIX**, verifies its
installed identity/path and contributed commands, and uses a separate minimal
development driver only to invoke the installed host's commands and inspect
fixture results. It does **not** load the host via `extensionDevelopmentPath`.
VS Code's `extensionTestsPath` test mode refuses modal dialogs, so this driver
deliberately launches without that mode. Python Playwright connects to the private
workbench and fills/clicks the **real VS Code simple file dialogs and custom modal
dialogs**, without replacing any `vscode.window` APIs. This is not OS-native
GTK/Windows/macOS file-dialog coverage.

The installed journey checks source-picker cancellation, read-only preview,
separate final denial with no import/staging writes, reinspection, explicit
digest/path confirmation, actual new-workspace publication, unchanged source
bytes/mtime, and no cutover. It selects/copies the real read-only Output editor;
the installed runner reads the actual private-display clipboard and checks the
inspected digest against the modal, source/destination, matching preview/receipt
fingerprints, and the publication receipt. It explicitly activates the installed
extension, checks disconnected managed state and repeated disconnect, and records
the clean extension-host/application exit. This is not a connected managed-runtime
drain or production takeover test. The host is then CLI-uninstalled and
the private profile removed. Failures retain only package-local fixture evidence
for diagnosis. `--vsix` installs the supplied artifact without rebuilding it;
`--evidence` preserves the artifact SHA-256, exact isolated install arguments,
installed extension path/version/activation, UI results, exit status, uninstall
and profile cleanup after success. No build/list-only result is activation evidence.
A Linux cached VS Code 1.143.0 run passed this installed-VSIX
journey; broader source layouts/native approvals, other operating systems,
recovery and cutover remain outside this acceptance claim.

Packaging and this installed nonproduction journey are separate acceptance
gates from migration completion. Neither changes the installed legacy extension,
authorizes a live legacy writer handoff, selects a production root, nor certifies
same-root production cutover.

### Explicit same-root coordinator acceptance

The six `pkm.nextHost.production{Preview,Transition,State,Read,Rollback,Disconnect}`
commands are independently gated by the **user-level only** setting
`pkm.nextHost.productionCoordinator: { "enabled": true, "root": "/canonical/absolute/disposable/root" }`.
The default is disabled. No workspace setting, caller-supplied profile or build
override is accepted: the host derives its actual global-storage profile and the
verified installed payload build. Configure before activation; changing enablement
requires reload so pre-existing unrelated clients cannot become migration authority.
Never use a production Root for an acceptance run.

**Current enforced boundary: installed same-root transition is unavailable.**
Read-only preview remains available. Transition preflight fails with
`cold-host boundary is unproven` before resource drain, snapshot/migration
consent, durable migration intent or Root effects. Rollback also requires this
boundary before closing an owner or requesting consent. State reports
`writerBoundary: "cold-host-unproven"` and `installedLegacyTakeover: false`.
Native same-root adoption/read/rollback acceptance is **UNIMPLEMENTED**, not just
waiting for a quieter environment. There is no setting, receipt or PID exemption
that enables it.

The shared Core authority resolves the real native `vscode` module itself.
Its native extension inventory rejects the exact `Uone.personal-knowledge`
identity (including the manifest identity), **even when inactive**, and declared
native entrypoints resolving into that legacy package's `dist/extension.js`.
These checks do not mistake unchanged retained utility modules under the verified
active `next-runtime/server/legacy/dist` for an old extension activation.
The inventory is re-read during authority/grant checks and after modal awaits;
`extensions.onDidChange` revokes observed unsafe authority permanently, even if
the old extension is subsequently removed. Unrelated extensions are neither an
exemption nor an arbitrary denylist.

Native inventory only describes extensions currently available to this host.
It cannot establish that previously loaded/uninstalled legacy code ended.
No module-cache heuristic, an empty new child registry, planning-only admission
drain or exact-plan consent can prove that cold boundary. Consequently the active
Linux permit binder also rejects a current-PID exemption, independently of the UI.
The existing conservative process inventory and frozen legacy binding are unchanged.

The retained legacy interfaces are useful but do not close this gap:
`personalKnowledge.requestManagedHostDrains` routes requests only; each actual old
window independently confirms `confirmLocalDrain`, which drains its enrolled
admission, registered children, Chat and retrieval work. Its original registration
and bound admission are required to record confirmation. `discoverManagedProfiles`
is participation discovery, not a census; `beginConfirmedManagedProfileFence` and
`sealConfirmedManagedProfiles` require the exact independently confirmed set, but
still report external/preexisting writers unknown and cutover unauthorized.
`observeManagedProfileInstallations` detects compatible local profile-index/build
changes, not process/child termination. `holdSnapshotTransition`/`snapshotHost`
require the original process-local brands, completed records and exact fenced
successor rotation; JSON cannot recreate them after restart. A real cold installed
handoff still needs authentic old-process/owned-child termination and complete
profile/writer coverage. No durable handoff proof is produced by this coordinator.

Active resource cleanup is narrower than that missing installed handoff.
`StandaloneHost` closes its registered actual owner children before native
services and Storage; failed children keep Storage owned. The adopted-owner MCP
attachment closes admission, awaits its real calls, then closes its privately
constructed `LegacyMcpPythonWorker` and connection. Worker close awaits actual
process termination and rejects abnormal exit/protocol failure; one attachment
does not own another attachment's worker. This is not the frozen shared HTTP
`RetrievalWorkerManager`. The managed client child separately awaits its actual
`HostLocalEnvironmentWorkflow.close()`, including owned runtime children and
journal cleanup, before acknowledging shutdown. These mechanisms cover resources
constructed through those active paths, not retroactive enrollment of old hosts
or arbitrary detached descendants. They issue no native cold-upgrade proof.

The opt-in native runner mode is an unfinished positive acceptance target, not a
supported transition. It provisions a separate synthetic same-root fixture
with private snapshot policy, leaves the first-run import fixture separate, and
attempts native consent, adoption, owner reads and rollback. With the current
enforced boundary it must stop at preflight, before consent. Do not retry it to
obtain a green report or reuse historical artifact evidence as current acceptance:

```sh
node clients/vscode-host/installed-test.mjs \
  --vsix artifacts/pkm-v5-host-active.vsix \
  --evidence artifacts/pkm-v5-host-active-installed.json --coordinator
```

Only a future implementation plus a matching successful evidence report containing
`coordinator.passed: true` could establish this isolated native journey.
Merely packaging these commands, unit mock approval,
the default first-run test, or a historical VSIX report does not. This remains a
bounded opt-in coordinator, not automatic production extension takeover, service
registration, parity certification or production deployment.

For Electron Extension Development Host acceptance, use the separate command:

```sh
npm --prefix clients/vscode-host run test:electron
```

It uses an already-cached Linux VS Code executable under
`~/.cache/pkm-vscode-test/vscode-linux-x64-*/code`, or an explicit executable
from `PKM_VSCODE_EXECUTABLE`. It never downloads VS Code. The test activates the
extension in Electron, invokes its commands, stores a token through the real
SecretStorage API, verifies authenticated loopback requests, and checks panel
disposal and disconnect cleanup. Its isolated user-data and extensions profile
is removed after the run. Linux runs require an existing `DISPLAY` or
`WAYLAND_DISPLAY`; if the executable or display is unavailable, the acceptance
test fails with that limitation rather than substituting the adapter harness.

An isolated Linux run with VS Code 1.143.0 and a virtual display passed after
the test's disposed-panel assertions were corrected. It used the synthetic
loopback server above, not a real next-server or the installed production
extension; it does not establish migration parity or cutover readiness.

### Additional live-runtime acceptance (not production cutover)

```sh
npm --prefix clients/vscode-host run test:electron:live
```

This separate test **does run the actual next-server runtime**, using the existing
`dist/cli.js init` and `http --read-only --port 0` launcher. It needs
that build and its dependencies already present; it does not rebuild or modify
the server, use a mock backend on failure, or download any dependencies. CLI
initialization/startup each have a 30-second deadline and report the actual
blocker. A startup failure stops the test before Electron.

The new workspace and home are randomly named, mode-0700 directories **inside
this package**, not the operating system's temporary directory. They contain only
synthetic, initially empty data. Expected workspace identity is read from the
CLI-created workspace marker *before* starting HTTP; actor `local:reader` comes
from the CLI's read-only policy, not server-info attestation. A random bearer is
generated per run; no operator token, provider configuration, production
extension, existing Knowledge Root, user settings or credential directory is
copied. The child environment is allowlisted, and Electron uses fresh user-data
and extensions directories, disabled updates/telemetry/experiments, and a
dead-loopback proxy for non-loopback requests. The extension transport observer
rejects any destination other than this fixture, including redirects.

It reuses the Electron launcher and loads only the nonproduction development
extension. Coverage includes authenticated connect/server-info, capability
discovery and an actual empty document-list read, independently configured actor
mismatch (no discovery afterward), backend HTTP 401 after an invalid token is
stored, recovery through the real VS Code SecretStorage store/read path, CSP and
secret-leak assertions, and disposal of three actual Electron panels including
message-binding cleanup. Messages are injected at the real panel's host listener
and replies observed at `postMessage`; this is **not webview DOM/button-click
coverage**. On Linux, short `/proc/self/cwd` aliases avoid the Unix IPC path-length
limit while leaving every profile/temp file in this package. Server shutdown is
bounded (SIGTERM, then SIGKILL after 10 seconds); workspace and profiles are
removed in `finally`. The separate `test:live-runtime` command checks actual CLI
startup, authenticated identity/denial, environment isolation and cleanup
without Electron; the original adapter `test` command is unchanged.

Supply an existing `DISPLAY` and installed/cached VS Code as for `test:electron`.
A cached, unprivileged Xvfb can provide an authenticated display without a system
install; disable its filesystem locks and Unix/local sockets and use a fresh
test-only Xauthority cookie with a loopback TCP client. Do not reuse private
desktop credentials. Nothing is downloaded and no server/display should be left
running. This acceptance is additional **synthetic nonproduction evidence
only**: it does not test production extension cutover, real-root migration,
feature parity, provider/tool authority, or change readiness claims/signatures.

Validation: build and all five adapter/launcher tests passed; the live-runtime
Electron acceptance passed with cached VS Code 1.143.0 and an authenticated
cached Xvfb display, without a system install. The CLI readiness/exit race and
disposed-webview HTML inspection found during execution were corrected; all
owned runtime, display and profile state was removed afterward.

## Isolated managed MCP migration launcher

The separate managed-MCP path starts **only an explicitly provisioned experimental
generation**, not the installed PKM service. It neither registers an MCP provider
nor changes the production MCP registry, extension, install, or Knowledge Root.
Provision an initialized disposable/imported next workspace and a separate empty
absolute managed directory using `experimental/managed-migration.mjs`:

```js
const generation = await stageIsolatedManagedGeneration({
  managedRoot: "/absolute/disposable/managed",
  data: "/absolute/disposable/data",
  // Default false. True explicitly authorizes this isolated workspace's writes.
  allowWrites: false,
});
await publishIsolatedManagedGeneration(generation.managedRoot, generation.generation);
```

The workspace must already have the next-server initialization marker. A new
managed root is private and marked as isolated; nonempty unmarked roots (including
production managed roots), linked roots, and a different existing launcher are
refused. Staging copies the entire built server, adapters, resources, Node
dependencies, and installed transitive Python dependencies (including requested
extras) without installing anything. Every copied file, launch configuration,
Python leaf bootstrap, and interpreter executable has a SHA-256 pin; the launcher
rejects changed, missing, additional, linked or unlisted runtime files. Python
uses `-I -S` and the vendored import closure, including backend leaf subprocesses,
not ambient user-site dependencies. Node startup hooks are removed. System
libraries, Python's standard library and the operating system remain trusted
platform dependencies; this is not a hermetic OS image or a signed package.

Publication verifies the complete package before atomically replacing one latest
pointer under an exclusive lock. The initial compatibility baseline stays fixed.
Publishing an earlier verified generation is explicit rollback; failed
verification leaves the latest pointer unchanged. No generation is hot-reloaded
or deleted while in use. All manifests remain experimental `0.1.0`, with
`enabledFeatureDomains: []`; no complete-domain or production compatibility claim
is made.

Set **user-level** `pkm.nextHost.managedRoot` to that isolated root. Execute
**Connect Isolated Managed MCP**. The host uses the original
`connectManagedChatMcp` client and its actual same-connection
version/build/generation/schema/capability handshake. `migrationState` reports the
verified generation and catalog; `migrationInvoke` accepts `{ name, input }` for
catalogued `mcp_pkm_*` tools only. The HTTP webview cannot invoke this path.
Publishing a compatible successor leaves an existing connection pinned to its
original generation. Execute connect again to fence and drain the old connection
**before** starting the successor: the native workspace deliberately has one
owner. Drain receipts include closing that owned backend's workspace lease.
Disconnect and extension deactivation drain this separate connection as well.
Timeouts, uncertain work or lost control return action-required; they do not
replay calls, forcibly terminate uncertain work, or report a replacement as ready.

Targeted real subprocess coverage:

```sh
npm --prefix next-server run build
node --test tests/managed-migration.test.mjs
npm --prefix clients/vscode-host run test:electron:migration
```

The final command requires a usable display and an already cached/installed VS
Code, as above. It loads the real isolated Extension Development Host, provisions
only fixture data, and exercises the frozen launcher, original Chat connector,
Note/Research reads, publication, drain-before-reconnect, rollback and disconnect.
The lifecycle test also blocks the copied **actual Note inventory subprocess**
at a fixture-only gate, cancels its client request, verifies nonzero in-flight and
uncertain work survives close timeout, then releases the gate and observes actual
completion before retrying close. No production service or original source file
is altered. A separate explicitly write-enabled fixture gates the actual native
Note-create adapter, cancels after admission, observes action-required drain,
then verifies the real write commits once after cancellation and reconnect does
not replay it or change its bytes/revision. These are execution/lifecycle tests, not independent user acceptance
signatures or a production cutover authorization.

### Optional local-model dependency provisioning

The default managed package still includes only FastMCP's dependency closure.
Model dependencies require explicit opt-in; having packages in global
site-packages never admits them into a running isolated generation.

```js
const plan = await planIsolatedPythonDependencies({
  python: "/absolute/path/to/compliant/python",
  modelDependencies: true,
  maxPythonDependencyBytes: 8 * 1024 ** 3,
});
if (!plan.ready) throw new Error(plan.issues.join("; "));
const generation = await stageIsolatedManagedGeneration({
  managedRoot, data,
  python: "/absolute/path/to/compliant/python",
  modelDependencies: true,
  maxPythonDependencyBytes: 8 * 1024 ** 3,
});
```

`planIsolatedPythonDependencies` is exported by the same experimental module.
It measures the entire installed transitive distribution closure before copying,
including requested extras, package resources, native libraries and Torch's
declared NVIDIA/Triton dependencies. It reports exact distribution versions,
per-file sizes, total bytes and missing/incompatible dependencies. The default
512-MiB byte budget applies to both profiles; larger closures need an explicit
budget and enough free disk. No package is installed, downloaded or extracted.

Model-enabled provisioning strictly enforces the existing
`resources/retrieval-model-requirements.txt`, including `torch==2.6.0` and
`transformers>=4.36,<5`. There is no compatibility-override parameter. The measured
development environment has Transformers 5.7.0 and is therefore **refused**,
even though development model execution tests can run there. Its measured
model closure is 5,735,693,339 bytes across 113 distributions; Torch alone is
1,552,595,077 bytes. These measurements are environment-specific, not size limits.
A compliant locally provisioned interpreter or separately approved independent
compatibility qualification is required; this code does not certify 5.7 support.

Copies request filesystem copy-on-write reflinks when supported, otherwise use
ordinary independent files subject to the same explicit budget. No writable
hard-link cache or ambient site-packages fallback is introduced. Generation
`python-dependencies.json` records exact distribution versions and every copied
content hash; the manifest pins this file, the dependency profile, requirements
bytes and the complete runtime. Hashing and copying stream large native files
rather than loading Torch libraries into memory. After copying, an offline
`-I -S` subprocess imports the actual model stack solely from that generation.
Missing or unusable native dependencies fail staging before publication.
Interpreter/standard-library and operating-system libraries remain trusted
platform dependencies, as above; model weights require their separate native
runtime admission and are not provided by dependency staging.

Run the bounded provisioning tests without copying active server source:

```sh
node --test tests/managed-model-dependencies.test.mjs
```

These prove default behavior, real installed-version refusal and pre-copy size
gating, missing dependencies/extra/native-resource inventory, and version/content
pin tamper rejection using an owned small packaging fixture. They do **not**
claim successful real model-enabled managed execution in the incompatible
development environment.

For actual model-enabled migration acceptance, prepend an explicitly provisioned
compliant virtual environment's `bin` to `PATH`, unset `PYTHONPATH`, `PYTHONHOME`,
`PKM_ISOLATED_PYTHON_COMMAND` and `PKM_ISOLATED_PYTHON_BOOTSTRAP`, and set
`PYTHONNOUSERSITE=1`, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1` and
`HF_DATASETS_OFFLINE=1`. Keep `TMPDIR` in an owned project directory. Then run:

```sh
PKM_MANAGED_MODEL_ACCEPTANCE=1 node --test tests/managed-memory-migration.test.mjs
PKM_MANAGED_MODEL_ACCEPTANCE=1 node clients/vscode-host/migration-electron-test.mjs
```

The Electron command requires the previously built host, cached VS Code and a
usable display. Both opt-in fixtures generate only tiny random local BERT
weights, admit them through native authority, and stage the full compliant
`local-model` dependency profile with a measured 2-GiB per-generation budget.
They require actual original semantic model invocation, 48-hex retrieval
receipts, original feedback training and persistent-child cleanup. The combined
Memory fixture also verifies receipt replay across restart and relocated backup
restore, source-model immutability and `-I -S` imports exclusively from staged
site-packages. Its original closed learner fixture imports the selected package,
an inactive package and historical user judgments through explicit native
approval. It checks exact learner genesis, preserved salt/user judgments and
denial of historical raw retrieval IDs without actor-bound native envelopes
through upgrade, restart and restore. A separate null-selection import retains
both inactive packages without granting model selection or receipt authority.
Original learner/package files remain unchanged. Default test behavior remains model-disabled. No pretrained
weights are downloaded, and random-model execution is not quality evidence or
production migration authorization.

The model-enabled combined fixture also exercises original partial-predecessor
normalization and a base-predecessor import control. Its selected portable
frozen release retains the exact original release identity and evaluated Skill
corpus through Chat query/feedback, managed upgrade and restart. Original source
bytes are verified before the disposable originals are explicitly removed; the
subsequent backup and relocated query/feedback must use native admitted copies
only. This does not claim unsupported frozen architectures or inactive/null
frozen-release admission.

Add `PKM_MANAGED_BOARD_RECOVERY_ACCEPTANCE=1` to the combined fixture command
to cover portable Todo Board creation, original Note discovery and native WorkItem
mutation, plus bounded missing-only Markdown recovery. The disposable host
explicitly admits one fixed actor/workspace/evidence/audit-root/plan-hash binding
through `admitLegacyKnowledgeRecovery` before starting managed MCP. The launcher
does not gain a public root-grant flag or general path override. Original Chat
preview/apply must preserve raw bytes, reject caller authority spoofing, survive
restart and preserve completed recovery through relocated backup. Relocation
must not remap the old external-root grant. External evidence is removed before
backup. This is not private Git snapshot or unrestricted recovery coverage.

Add `PKM_MANAGED_ACTION_SNAPSHOTS_ACCEPTANCE=1` to exercise a separately
host-enrolled exact Action ZIP catalog and four fixed private-Git snapshot tools.
The host verifies the native workspace inode and exact reviewed package digest
before launch; importing/selecting a ModuleSet permits static diagnostics and
blocked `action_get` only, never runtime execution authority. Pending proposals
remain noncallable. Snapshot enrollment binds its four allowed tools to the
native root/private repository; configure is deliberately unavailable, with no
fake scheduler. The fixture restores CRLF Markdown and executable source modes,
checks replaced/extra bytes in native Trash, verifies all archived files are
mode 0600, and preserves original modes after relocated restore. External
catalog sources are removed before backup; relocated tools must not inherit the
old snapshot root grant. Strict native-database and privacy guards remain intact.

### Optional managed snapshot scheduler enrollment

The scheduler is **off by default**. A trusted native host must first persist a
snapshot admission explicitly covering configure and create. After the native
runtime provides the verified enrollment, pass that exact object when staging:

```js
await stageIsolatedManagedGeneration({
  managedRoot, data, allowWrites: true,
  snapshotScheduler: {
    schema: "pkm.native-snapshot-scheduler/v1",
    workspaceId: independentlyApprovedWorkspaceId,
    actorId: "mcp:external",
    admissionSha256: independentlyApprovedExistingAdmissionSha256,
  },
});
```

Staging performs read-only verification against the existing native admission,
including current root/inode and allowed tools; it does not mint a grant or take
over an active workspace lease. The immutable generation pins the full metadata.
The launcher checks the workspace identity and forwards only the admitted digest
through `--experimental-managed-snapshot-scheduler`; no root, path, actor or
authority override is added. The lease-owning backend must reverify the actual
admission before starting its scheduler. Missing, stale, foreign, read-only or
insufficient enrollment is refused. No operating-system global scheduler is
registered, and ordinary generations retain their existing behavior.

The disposable acceptance fixtures additionally accept
`PKM_MANAGED_SCHEDULER_ARTIFACTS_ACCEPTANCE=1`. For the combined Chat fixture,
also enable `PKM_MANAGED_ACTION_SNAPSHOTS_ACCEPTANCE=1`; existing model and
Board/recovery opt-ins remain independent. This explicitly enrolls only fixture
paths and waits for real UTC-minute deadlines, without clock/interval overrides.
It checks scheduled Git creation, missed-deadline restart catch-up, artifact
import/exclusive export, and relocated old-grant denial. The Electron fixture
checks actual extension-host invocation and disabled scheduling across a real
deadline after upgrade/rollback.

Backup fencing is tested separately on the same persisted managed queue using
the admitted native scheduler: the automatic backup fence pauses claims before
native quiescence, crosses an actual due deadline, and resumes afterward. This
is **not** a claim that Chat exposes a workspace-backup tool. A separate CLI
backup cannot take over a live managed backend's workspace lease. Acceptance
keeps every snapshot-status error fatal; it never retries an uncertain call.
