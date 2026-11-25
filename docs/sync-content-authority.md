# Sync content and current native authority

`sync.apply.preview` and `sync.apply` use persisted, actor-owned three-way
plans. They do not execute Scripts, install packages, enable servers, select
Actions, start Recipes, or restore Agent sessions.

The original twelve-type manifest is a planning wire format, not a blanket
filesystem or execution authorization.

| Type | Local content application |
| --- | --- |
| Notes, Papers, Skills | Existing Markdown/attachment behavior and ownership fences |
| Prompts | Exact project/task members, including inert non-Markdown bytes |
| Scripts | One body, exact original path identity or stable identity with its paired original sidecar, owned dependencies |
| Packages, Servers | Exact root-owned directory members; current native source approval required; no execution; structured credential fields denied |
| Actions | Valid portable definition and identity; current native source approval required; no executable grant |
| Action ModuleSets | Complete immutable version inventory, original package/member hashes and resource references; existing members cannot be replaced |
| Recipes | Valid typed global definition record and compiled executable/methodology digests; no run/history/state import |
| Profiles | Private `pkm.profile/v1` cards only, with exact current root/source/selection consent; remote publication additionally requires exact repository/branch consent |
| Agent Snapshots | Original local-obfuscated historical payloads remain denied. They are not independently encrypted portable current-source authority |

Binary ModuleSet assets retain their actual bytes and hashes. A Sync byte
receipt is not an executable compiler source selection. A UTF-8-only Action
snapshot cannot represent arbitrary binary assets; the Action runtime needs
its independently qualified byte-aware adapter before loading those sources.

## Native composition

Native hosts provide `SyncContentAuthority` through `DataRuntimeHost.syncContent`
or `SyncTransportNativeHost.contentAuthority`, never through public arguments.
The host must reject expired or foreign epochs/profiles/roots and bind its
approval to the actor, session, exact three source pins, complete source hash,
and typed entity identities supplied to `assertCurrent`. These are current
producer checks, not archived receipt imports or a generic boolean permission.
The assertion is synchronous and returns no value; boolean and asynchronous
callbacks are rejected before byte effects.

The shipped `bootstrapOriginalMcpNativeRuntime` registers
`createOriginalMcpNativeSyncDataHost` after authenticated same-owner native
attachment, provided that attachment advertises `sync.source.approve`.
The default VS Code attachment supplies `createOriginalMcpNativeSyncProducer`.
It verifies the active signer, build, host, profile and session, then presents
an explicit deny-default modal containing the exact root, actor, epoch, source
pins/corpus, selected typed identities, inventory digests and private-metadata
flag. Preview and Apply require different affirmative decisions; Apply also
binds its operation ID and plan hash. Approval expires, is request-local, and
is rechecked synchronously before effects. No public argument creates it.
Completed result replay remains historical and requires no new approval.

This producer explicitly grants **local-only** application of the reviewed
three-way source. Manifest snapshots have no target-ref field: this consent
must not be treated as remote publication approval. Remote transport still
requires its separate current native transport host, exact reviewed target
configuration/ref and expected-commit CAS. The isolated Original-target host
below is a separately admitted adapter, not an automatically provisioned
GitHub transport in native bootstrap.

The isolated original-target host projects the exact selected types, items,
folders and privacy classifications. Unselected entities follow the remote
state on all three sides and are neither pulled nor deleted. Comparison
confirmation rechecks the target configuration, privacy policy, current
source corpus and reviewed remote commit. Publication additionally checks the
selected local result bytes and retains the native-only remote approval,
private visibility fence and actual expected-commit CAS boundary.

Source review is still required for opaque artifact bytes; a byte inventory
is not a claim that arbitrary binary/code content has been semantically
sanitized. Typed JSON rejects credential/history fields, including common
environment API-key names. Profile cards are the original closed non-secret
card schema, not arbitrary credential references or historical SDK objects.

Original native file Trash is not whole-entity Sync deletion authority for a
stable Script's untouched sidecar/dependencies or a Prompt project/task.
The original full-extension deletion path is preserved by the Trash producer;
Sync must not invent missing member pins or derive a directory deletion.
Explicit fully reviewed typed Sync tombstones can delete their complete
pinned entity members through the public native apply path.

## Recovery and compatibility

Every member is SHA-pinned, regular-file/root-owned, and checked before and
after effects. Explicit tombstones preserve deletion metadata. Unknown bytes,
permissions, ownership, source changes or outcomes preserve pending intents;
they never authorize overwriting an external change.

Existing knowledge/Script byte journals retain their known-before/after
filesystem recovery behavior. Pending privileged source effects are not
automatically re-admitted under a fresh epoch: startup fails closed for review.
Completed receipts remain immutable historical outcomes, not assertions about
current files.

Nonempty Servers and the Profiles/Action ModuleSets roots require additional
passive admission: the current owned native database must pass the existing
exact bootstrap-schema gate, and completed byte journals must match genuine
shared local/remote apply receipts and their immutable request fingerprints.
Every current file and directory is matched to that completed inventory;
private card modes are checked too. Missing, changed, orphaned, pending or
unknown-schema state is denied without replay. Empty directories left by a
completed explicit deletion remain admissible only under that same evidence.
This does not grant executable/source selection or admit an imported receipt.
An inert legacy Root without a native database still rejects nonempty Servers
as `LEGACY_ROOT_INERT_STATE_UNSUPPORTED`; it cannot acquire native byte custody.
Any additional optional database schema needs independently qualified closed
physical-schema and typed custody verification; this gate never accepts unknown
tables merely because a Sync receipt exists.

An original-owned Root may also contain legitimately authored Action catalog,
proposal, artifact, publication, blob or configuration metadata. On an otherwise
unknown-schema classification, passive Sync admission uses the synchronous
Action-owned historical reader to verify complete physical groups and every
typed record against the actual completed original custody journal, workspace,
source protocol and root identity. Existing native-host admission records are
separately checked with their exact physical DDL and historical receipt reader.
Only those verified schema objects are removed from the comparison; every
remaining object must still match an unchanged canonical or derived release
schema and seed rows. Unknown objects, altered journal/catalog/host receipts,
and mismatched base schemas remain denied. This read-only integration does not
recreate a live native Host, restore old grants, widen the bootstrap profile or
replace Sync's independent completed-byte receipt and current inventory checks.
The original custody plan's auxiliary-directory topology is unchanged by this
schema integration; the Action/Sync cold-reopen proof uses a genuine original
Root with its Servers area present at capture.

This change uses the existing twelve-type enums, v1 base64 file intents and
receipts, and existing SQL tables. It adds no persisted record fields, DDL,
schema version or historical pins, and does not relax database admission. The two
export-only original ModuleSet path/reference validators are a coordinated
Action-owner prerequisite. Bootstrap profiles generated for private testing
are unverified candidates and are not product handoff artifacts.
