# Bounded original-layout MCP admission

`src/original-mcp-root.ts` implements a separate, versioned admission path.
It does **not** enlarge the experimental copy importer's limits or qualify
historical captures.

## Custody and scope

`captureOriginalMcpCustody({root, backup, operatorId, profileSha256, limits},
{writerFence})` produces a root/inode-, operator-, profile-digest- and
backup-bound `pkm.original-mcp-custody/v2` plan and a matching
`pkm.original-mcp-root/v2` journal.

The capture streams `.pkm`, Chatrooms, `knowledge.db` and its three possible
sidecars, Notes, Skills, Papers, Scripts, their original Trash, `AGENTS.md` and
`.gitignore`. A private SQLite inventory pins original identities, modes,
nanosecond timestamps and hashes. Private numbered blobs preserve file bytes
without interpreting or executing them. A second full source/hash comparison
and backup verification precede the no-replace completion receipt. Incomplete
captures are not resumable or successful receipts; use a new backup destination.

Bounds are explicit, independent of the small importer: at most 1,000,000
entries, depth 64, 256 GiB total and 64 GiB per file. Callers must select bounds
for their inspected root. Capture uses a fixed-size streaming buffer, not
in-memory Chat history entities. Unknown root/state surfaces, links or
hardlinks within the captured domains, foreign ownership, special files,
unsafe modes, changed identities and changed bytes fail closed. Existing
0755/0775 containers are accepted only beneath an owned private ancestor;
original modes are never changed.

Other recognized roots (`.git`, environments, servers, generated MCP builds,
packages, codebases, Actions, prompts, Projects, Recipes and Skill
maintenance roots) are **auxiliary, untouched, untrusted and unbacked by this
particular custody envelope**. Their presence is not execution authority.
They must be covered independently where needed by the complete offline
profile/configuration/serving-release recovery capture. This plan is not a
claim that the entire original directory or external profile has been backed up.

### Opaque Script/Prompt Trash

`knowledge_file_trash` accepts regular public Script/Prompt sources without
executing them or decoding them as Markdown identities. Scripts require a
version-2-or-newer source capture. Prompts require a **fresh explicit**
`captureOriginalMcpCustody({...request, preserveOpaquePrompts: true})` capture:
the new custody/root v3 envelope also preserves Prompt bytes and original
Trash. Existing v1/v2 envelopes are unchanged; an old Prompt auxiliary root
is not retrospectively authenticated or automatically upgraded.

The closed Trash request/transition v3 binds opaque byte SHA256/size, source
identity, current owner/profile/epoch, public arguments, paired ownership,
history and predecessor. Only `.md` sources have the original `.assets`
pair convention; other Script companions remain untouched. Shared or
unprovable pairs, changed source/pair bytes, occupied restore destinations
and late cancellation fail closed. Public exact-SHA trash is not replayable:
an absent source with `expected_sha256` conflicts. Canonical UUID receipt
replay remains actor/request-bound. Interrupted effects retain the exact
durable intent and require fresh native recovery review.

No SQLite tables or schema hash change. New v3 records require the new
receiver; older receivers must reject them, never reinterpret them as v1/v2.
Downgrade/hot-switch cannot discard or reconstruct pending intents, custody
successors, deletion history or receipts. Installed combined qualification
and final profile generation remain coordinator responsibilities.

### Operator capture entry point and native serving

The shipped `dist/original-mcp-custody-cli.js` exposes the explicit opt-in;
it is not a test-only fixture option. From outside the maintained original
root, create an owned private (0600) reviewed JSON request:

```json
{
  "schema": "pkm.original-mcp-custody-capture/v1",
  "root": "/owned/original",
  "backup": "/owned/recovery/new-custody",
  "operatorId": "reviewed-operator",
  "profileSha256": "RETAINED_VERIFIED_PROFILE_SHA256",
  "limits": {
    "maxEntries": 10000, "maxDepth": 32,
    "maxBytes": 1073741824, "maxFileBytes": 67108864
  },
  "preserveOpaquePrompts": true
}
```

Use the actual independently verified profile digest and bounds selected for
the inspected root. Retain the SHA256 of the exact reviewed request, then run:

```sh
umask 077
node dist/original-mcp-custody-cli.js capture \
  --request ./reviewed-capture.json --pin REVIEWED_REQUEST_SHA256 > ./enrolled-plan.json
```

The command acquires the ordinary cold writer fence, captures and verifies
custody, emits the exact plan, and releases its own fence. It neither opens a
business owner nor grants permissions or writes live profile pointers.
Subsequent admission must reacquire the ordinary real fence; capture does not
authorize ignoring writers that appeared since capture.

Pass the retained plan/fence to the existing
`bootstrapOriginalMcpNativeRuntime` operator flow, enroll the verified installed
native producer with its exact current profile/epoch bindings, and complete
native admission with the explicit public-request and Trash review methods.
Then `startOriginalMcpNativeBroker` attaches to that already-open owner,
Storage and current host, with explicit writable `native-dogfood/v1` scope.
The authenticated pinned relay exposes the `mcp.tool.knowledge_file_trash`
operation through `capability_call` (version 1 and its exact arguments) only when this
actual native Trash port exists. Each call still obtains exact public and
per-target current reviews. Canonical list/restore use the separately admitted
native lifecycle channel, not the reduced relay. Interrupted effects are
reconciled during a new native bootstrap with fresh recovery review; never
replay the old public call as recovery.

Managed generations now advertise the schema-derived source protocol separately
from the unchanged SQLite schema. The existing generation-selection and switch
compatibility preflight rejects missing/older advertisements **before** draining
the owner; verification also rejects a copied receiver whose advertisement was
omitted or altered. New v3-capable generations are intentionally source-protocol
incompatible with older/unadvertised receivers, even with the same 129-table
DDL. Existing v1/v2 roots and durable UNKNOWN records are not rewritten or
discarded. An incompatible migration needs separate cold operator admission,
not an automatic managed hot-switch.

## One real fence, one real owner

The intended coordinator sequence is:

1. Establish operator-controlled maintenance: stop/drain legacy writers and
   prevent their automatic restart. Verify the pinned release and complete
   external/profile recovery scopes. Run the coordinator with its working
   directory **outside** the original root.
2. `acquireOriginalMcpRootFence(root)` returns the actual branded
   `LinuxRootWriterFence`, after the existing full Linux writer check.
3. Keep that same resource held through
   `captureColdStateRecovery(request, pack, {writerFence})`,
   `captureOriginalMcpCustody(request, {writerFence})` and
   `prepareOriginalMcpRoot(plan, {writerFence})`. Retain the independent
   capture/plan/preparation pins outside the original.
4. `openOriginalMcpRoot(plan, {writerFence})` transfers the **same fence** to
   `RootOwner.acquire` and attaches the actual `Storage` worker/SQL owner
   lease. It returns `{owner, storage, root, workspaceId, planSha256,
   journalSha256}`. Closing that owner releases the fence.

Caller-provided fences are brand-checked, never replaced or released by capture
or prepare. Before ownership transfer, failure leaves the caller responsible
for releasing its fence. Once transferred, owner shutdown owns release.
No callback, supplied PID, same-process exemption or manual “cold” flag
substitutes for the real resource or the existing process inventory.

Captures and process observations do **not** prove future/global shutdown
authority. The offline coordinator must retain maintenance control over
external writers/configuration, not infer it from a successful byte capture.
The original active-VS-Code migration boundary remains unchanged and blocked.

### Frozen Script sources

Version 2 preserves complete Script membership, identities, nanosecond pins,
and raw hashes in the bounded B0 inventory and numbered blobs. Scripts are
immutable, including public sources; this is preservation, not execution or
write authority. Serving still requires the genuine signed native Host/public
read admission. No new Script write, update, execution, or model grant exists.

The indexed reader checks only admitted **public** Script membership, identity,
classification, and hashes after the actual Root privacy policy excludes private
top levels. It checks again around asynchronous worker execution and before
generation publication. These serving checks never open private Script bytes
or backup blobs, and do not run full offline custody verification. Unknown,
missing, substituted, or edited public members and changed privacy pins refuse
with `RECOVERY_REQUIRED`; no replacement corpus baseline is published.

An external edit requires explicit operator retirement/rebinding, a fresh
custody capture, and confirmation. Generic unsealed workspaces and the
original-business compatibility adapter retain their existing live refresh
behavior. Their refresh receipts do not authorize edits to a frozen native root.

The parser retains matching v1 plan/journal pairs for compatible non-Script
operations. V1 treated Scripts as unbacked auxiliary roots, so its Script reads
require an explicit version-2 custody upgrade and are not silently promoted.
Mixed plan/journal versions refuse, and retained v1-only runtime parsers reject
the new protocol. Existing auxiliary-only sealed captures are not rewritten or
reassigned.

Every new canonical owner, including a committed-root restart, remains
cold-gated. A newly started VS Code host must **not** directly reopen this
root. Current-profile reconnections require an authenticated broker attaching
transports to the already cold-started canonical owner/backend. The broker owns
their lifetime; a client disconnect must not close the shared owner/backend.
`createNativePublicOwnerBackend(owner, {actor})` provides the real native
backend for that composition. `startOriginalMcpBroker` now provides authenticated
per-client transports and shared-owner lifetime management; use it **instead
of** separately calling `openOriginalMcpRoot`, since it performs that one
ownership handoff itself. See [the broker protocol](original-mcp-broker.md).
Profile endpoint registration, operator scope acceptance and release rollback
remain coordinator integration work; these APIs perform no live profile edits.

## Runtime policy and recovery

Custody alone exposes only public Note/Skill/Paper content reads and the six
original add/update signatures. Frozen Script serving additionally requires the
genuine native public-read Host admission described above. Schema-1 privacy top-level entries
remain immutable **denials**, never inherited grants. Canonical and fresh
scanners and direct Note path reads share the same live denial policy.
Original Projects/Recipes are not read to activate Note linkage.

Old Chat/Action settings, groups, histories, original Trash and snapshot state
remain archived bytes; no workers, credentials, permissions, native Trash
receipts or private snapshot authority are inherited. Trash restore/purge,
Actions, Chat, scripts, other legacy runtimes and autonomous enrollment return
`NOT_AVAILABLE`/`ACCESS_DENIED`, rather than treating preserved bytes as native
authority. Public Note/Skill/Paper moves now validate retained private Markdown
as read-only reference evidence in the existing compound move journal. Those
sources are never indexed, returned, rewritten or granted as an executable
source domain. Their path/hash pins remain private journal state and must still
match at every recovery phase. Private source/destination paths and shared
paired resources refuse without publishing the private referrer's path.
A normal content update does not implicitly normalize an original filename to
its title.

The original 4.0.22 writer scans same-area referrers, including private folders,
and refuses shared **existing** paired resources without rewriting other
documents. The native lifecycle conservatively retains its complete three-area
proof and destination-reference protection: dangling shared references,
malformed/unsupported private Markdown, links, legacy `_assets` migration and
other unsupported lifecycle cases remain closed rather than silently omitted.
Private inspection here is an internal ownership/conflict proof, not a new
read/publication or historical-permission grant. The public add/update adapter
requires the exact active native public-request approval before selecting a move
with retained private sources; the earlier experimental content-only broker
cannot silently acquire this increment. Separately admitted source domains are
unchanged.
The bounded valid-private-Markdown profile has now passed genuine installed
approval and B1/fresh-B0 qualification; see
[installed Knowledge moves](./installed-native-knowledge-move.md).
`PRIVATE_REFERENCE_MOVE_COMPATIBILITY_REQUIRED` remains in full readiness for
the complete original contract, including still-unqualified legacy asset and
other unsupported source layouts. This conditional slice does not silently
promote full original parity or source authority.

Prepare durably publishes the exact journal before the workspace marker.
Missing commit receipts require the exact offline resume path; ordinary worker
startup refuses them. Existing committed owners validate preserved-state
metadata against the sealed inventory and permit canonical public Markdown
updates. They never accept an inode-changing restore as the same original
root. Adoption checkpoints support interruption qualification without acting
as authority.

`rollbackOriginalMcpRoot(plan, independentlyRetainedPreparation)` requires a
closed owner, no SQLite sidecars and unchanged original source identities and
hashes. It uses a durable private root-child archive and no-replace fenced
moves; all native SQLite/control state (including B1 state) is retained, not
deleted. Interrupted rollback prevents owner startup and resumes against the
same independent pins. Original file bytes, inodes and modes are never
rewritten by this rollback.

If authoritative original content has changed, rollback refuses and leaves
both source and native state intact. Capture B1 first; reverting that content
requires a separately authorized restore/rebind protocol. Neither this module
nor the cold snapshot controller claims that a fresh-directory restore
preserves original inode-bound adoption identity.

### Post-write engine retirement is not yet qualified

The broker does not weaken this rule or supply a post-write retirement API.
A separate versioned protocol would need an independently pinned B1 custody
of current public Markdown plus proof that private/archived state still
matches B0, and a no-replace archive of every native SQLite/control file.
It must retain current public files rather than restore B0 over them.

The requested genuine-original-reader qualification additionally needs the
coordinator's independently pinned original 4.0.22 release/VSIX and an isolated
read/update test against its actual reader for retained and v5-created
Note/Skill/Paper identities. The checkout's `legacy/package.json` version
string is not sufficient release provenance. One available source path,
`legacy/src/knowledge/filestore.ts`'s `noteUpsert`, reconstructs a selected
frontmatter set rather than carrying `documentId`; this is evidence that
metadata/identity compatibility needs a real target-reader test, not a
blanket compatibility assertion.

Until that qualification and explicit operator acceptance of **native-state
archival, not SQLite feature/history merging or automatic replay/rebind**,
post-write engine retirement remains blocked. Do not remove the Next owner
marker manually to make old writers start.

## Qualification

`tests/original-mcp-root.test.mjs` covers representative configured old state,
over 4096 Chat files, original Trash/SQLite/config preservation, private-data
denial, real same-fence handoff, public canonical mutation/restart, explicit
bounds, unknown/changed/corrupt source refusal, interruption/resume, B1-safe
rollback and live-host cold-start refusal. These are isolated synthetic
regressions, not acceptance of an actual library or a live profile cutover.

`tests/legacy-knowledge-private-move.test.mjs` extracts only the writer's exact
dependency closure from independently SHA-pinned original 4.0.22
(`1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27`).
Disposable original-created Note/Skill/Paper pairs exercise successful public
moves with retained private sources, original shared-resource refusal/rollback,
Core CAS/privacy/readonly denial, private-reference drift, durable interruption,
same-owner restart and actor-bound receipt replay. Positive tests invoke the
real trusted Core; the public adapter is also tested to reject missing fresh
native approval. No source receipt or native approval success callback is
supplied by these fixtures. Actual approved public-adapter success belongs to
the separate genuine installed qualification.
