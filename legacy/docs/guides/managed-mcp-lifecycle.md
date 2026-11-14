# Managed PKM MCP generations

Run `npm run test:mcp-lifecycle` to build coherent bundles and execute the
generated-runtime/Chat connector Node tests plus real FastMCP concurrency tests.
The fixtures use the shared dev venv `~/pkm-envs/personal-knowledge-vscode-dev` (see `tests/dev-paths.js`) and a `python` on PATH with
FastMCP available. All server instances and generations belong to isolated test
directories; this command does not upgrade or reconnect production clients.

Generating a server is **not** upgrading an existing MCP connection. In particular,
an already connected 2.17 process keeps executing its old code. Generated version
constants, a detected PID, provider registration and listed tools are not proof
that the connected process upgraded.

## Runtime ownership

The unified managed entry remains `<managed directory>/server.py`. It is now a
stable launcher that reads `latest-generation.json` (or the original
`active-generation.json` for pre-migration installs) once and executes one complete
generation under `generations/<id>/`. A generation contains:

- Generated unified and internal Chat Python modules and their Python/JS helpers.
- A private copy of bundled `dist` and runtime resource code, including the shared
  Knowledge mutation/asset/deletion-journal implementation.
- An immutable Recipe compiler and its configuration.
- `manifest.json`: generation, extension version, component schemas, Node executable,
  enabled feature domains, runtime build digest and individual file hashes.

The launcher verifies hashes before importing the server. Knowledge helpers use
the generation's runtime, not an installed extension or development fixture path.
Removing an old extension directory therefore cannot redirect an in-flight Skill
write into a different implementation.

When no current VS Code host is available, Recipe compiler resolution accepts a
valid explicitly configured absolute `nodejs` executable as well as `node`. It
does not search `PATH`; an injected host executable still takes precedence.

Generation is serialized across extension windows. Failed staging leaves the
predecessor active. Only a complete generation is published through the atomic
pointer. Old generations are deliberately retained: do not remove them while
clients may still be using them. There is no automatic generation garbage
collection.

Compatible publication retains `active-generation.json` as a marked compatibility
baseline for already-running lifecycle implementations that read only that file;
new launchers and hosts use `latest-generation.json`. Thus an older session is not
silently upgraded, fenced or terminated merely because new code was installed.
An incompatible publication changes the baseline first, fencing old admission,
then commits the latest pointer. An incomplete incompatible transition fails
closed. Both pointers remain account-owned control files, not drain receipts.

The Python environment is shared, not copied into every code generation.
Managed Create/Repair serializes maintenance, blocks new launcher starts, and
refuses in-place dependency changes/replacement when a managed process is running
or its safety cannot be established. Close all PKM clients first, preserve/review
uncertain writes, or select a new empty runtime path. On Windows passive process
inspection is unavailable, so an existing possibly active environment is not
silently replaced. This protection does not authorize changing external runtimes,
nor does it make external/manual `pip` invocations safe.

## Admission and bounded draining

New instrumented processes snapshot `pkm.mcp.attribution/v1` launch context into
their lifecycle status and durable instance record. The native provider reuses
the registered extension-host identity, editor session, host-registry slot and
workspace context when available. `hostId` identifies one extension activation
(the existing registry's random UUID); `extensionHostPid` identifies that
extension-host process. Neither is a recovered VS Code UI window ID.
`editorSessionId` is `vscode.env.sessionId`: the API promises a current editor
session identifier that changes when the editor starts, not a unique identifier
per window. It must not distinguish multiple windows in an application session.
`hostSlotId` reuses the registry's `slotId`, a SHA-256 hash of
`context.storageUri.toString()` or, when storage is unavailable, the editor
session ID. It correlates workspace/storage slots across host reloads; windows
using the same storage context may share it. No exact window ID is claimed.
`workspace` is the workspace-file URI or joined workspace-folder URIs;
`machine` and `remoteName` describe the launch host when supplied.
This is caller-reported launch evidence, not
a verified same-client handshake or proof that the original window is still alive.
Shared provider/host connections are not attributed to a single Chat. The managed
Chat connector records a Chat ID only when its caller explicitly provides one;
the reusable PKM Chat connection therefore has no synthetic conversation identity.
Standalone launches have unknown window/Chat ownership. Legacy records without
metadata stay unverified; sibling PIDs and parent PIDs never reconstruct old
window or conversation IDs. Stale reports display historical launch context,
not current ownership. Malformed attribution is discarded without changing drain
or admission behavior.

New instrumented unified processes install `ManagedMcpLifecycle` as outer FastMCP
middleware. Each actual call checks the shared generation before admission.
An unchanged API contract permits old processes/windows to keep using their
discovered tools. Component schema major versions, the explicit
`pkm.mcp.api/1` contract and enabled feature domains determine compatibility,
not extension version equality or a new build hash. New tools require discovery
on a newer connection; they are not invented in an old catalog. Backwards-
incompatible argument, response, storage or write semantics must bump the
component API major or the explicit API contract, even for a patch release.
Feature-domain removal, incompatible/unknown API transitions, explicit quiesce,
maintenance and unavailable control still fence admission. Already admitted
calls continue against their original generation.

`mcp_lifecycle_status` reports:

- `accepting`: this process owns the current or a compatible retained generation.
  `updateAvailable` distinguishes a compatible update without claiming a reload.
- `draining`: superseded, with actual calls still in flight.
- `action-required`: the 30-second drain budget expired and calls remain.
- `drained`: this instrumented process has no remaining admitted calls.
- `retired`: a superseded, instrumented managed server closed its own stdio
  session normally after real calls and responses completed.

New managed generations retire themselves after a one-second quiet period only
when a valid successor pointer fences admission, tracked actual/uncertain calls
are zero, no protocol handler is active and lifecycle control/registry remains
available. The owned read pipe is cancellation-aware so an idle client keeping
stdin open cannot pin the old process indefinitely. This uses the FastMCP
lifespan and underlying MCP stdio session; the normal SDK stdin worker cannot
be cancelled while blocked on input. Explicit quiesce, maintenance, missing or
invalid control alone never authorize retirement. Legacy already-running
processes do not acquire this behavior retroactively and are never signalled.

The deadline is an observation/action boundary, **not** a forced cancellation or
claim that writes stopped. Cancellation by a caller does not remove an executing
write from the in-flight ledger: the execution is shielded and counted until its
actual completion. A caller that lost its response must inspect durable state
before deciding what to do. No automatic tool replay, process signal, restart,
external-server termination, or native-client trust bypass is performed.

`check_version` and `mcp_lifecycle_status` remain callable after fencing so that
clients can discover the boundary. Fencing is sticky; rolling back a pointer
cannot re-enable an already superseded instance.

The owned Chat connector closes local admission immediately on close/lifetime
cancellation. It calls `mcp_lifecycle_quiesce` on that same transport to fence
that process before observing drain; this also fences tools queued but not yet
admitted. The control is omitted from the Chat model's catalog. Only verified
zero actual/uncertain calls allows closing the owned transport. Timeout,
ownership mismatch or lost observation leaves action-required and does not
terminate uncertain writes; an explicit later close can retry observation.
Once the Chat host starts closing an owned connection, it will not reuse that
connection even if the configured generation later returns to its original
value. A subsequent discovery retries the old drain before connecting a
successor; concurrent discoveries share that transition. Until it completes,
managed tools are not dispatched or replaced with a native-tool fallback.
The local drain-observation deadline does not cancel an outstanding lifecycle
control request. A delayed response may still arrive after action-required;
this does not resume local admission or permit automatic tool replay. Control
RPCs retain their independent bounded transport timeout.

Instance files under `instances/` are metadata-only observations. Stale/missing
heartbeats mean **unknown**, not drained or stopped. An instance registry never
establishes that the current Chat/native MCP client is ready.
Config keeps routine unverified connection observations in neutral collapsed
details, not a permanent global failure banner. Fresh draining, uncertain or
control-error observations keep actionable warnings and expanded details.

In **Background Tasks → Background Processes**, the opt-in **Review next-server
migration blockers** button refreshes the existing process snapshot and shows
aggregate MCP observations. It is read-only and always reports that production
migration is not authorized or verified. The current-user inventory is partial:
even an empty snapshot cannot establish that external writers are fenced, that a
specific connection drained, or that next-server identity and credentials are
trusted. It does not connect to next-server, change settings, or enable cutover.

## Scoped Markdown writer barrier

The Linux-only internal `beginMarkdownMigrationTracking` and
`fenceTrackedMarkdownWrites` APIs coordinate through the existing
`markdown-assets.lock`. Tracking is explicitly prepared, not enabled by default.
Participating Markdown/asset writers create a durable in-flight marker inside
that lock. Fencing waits for the lock and refuses an abandoned lock or an
unresolved marker; completed operation records remain until explicit recovery
or cleanup rather than being removed during the barrier. Once fenced,
participating writers reject new mutations,
including after restart. A failed or interrupted mutation retains its marker,
even if the failure might have occurred before any change. An incomplete
preparation or fence is also action-required; no automatic recovery or removal
of these control records is provided. Retrying an already completed fence with
the same operation ID is safe.

This is **not a production cutover gate**. It covers only code actually entering
`withMarkdownAssetMutation`: covered Markdown/assets paths, Todo Board and
Work Item mutation functions in `filestore.ts`, Prompt version-note/import,
Script identity creation/import/move, and the managed MCP helper when it calls
those covered functions using this updated runtime. This does not cover every
Prompt/Script writer, every Work Item route, sync, independent workers, older
builds, or arbitrary external filesystem writers. The barrier cannot attest that
all processes use this version or that
the root was consistent before tracking began. A missing/stale participant or
unknown external writer is not evidence of drain. There is no production
activation, authenticated coordinator, or cutover command wired to this API.
Fencing proves neither delivery of a client response nor reconciliation of a
client's uncertain operation; reconcile those separately before retrying.
Tests use isolated synthetic roots and process-crash injection, not power-loss
or production-root qualification.

## Scoped async managed writer session

The internal Linux-only managed writer session is separately provisioned before
launching participating processes. An enrolled `syncGitHubTarget` operation
persists a pending record before entering the async implementation and a
completion record only after it settles successfully. An enrolled PKM GitHub
Sync service holds a record for its entire lifetime, including its owned async
callbacks; a service not bound to an existing session is refused on startup.
Nested sync operations obtain their own admission and completion records:
fencing rejects new nested operations, while a previously admitted nested
operation remains pending even if its parent has already returned.
The existing sync service drain must still be invoked and awaited. A fence
durably closes new admission before checking these records. Active, crashed,
failed or malformed records keep the drain unknown, including after restart;
no timeout or PID disappearance turns one into a completion. There is no
automatic recovery or replay.

The session is a launch contract, not authentication or a fleet inventory:
`PKM_MANAGED_WRITER_SESSION` alone does not establish process identity. It must
be provisioned before any participating client starts. A process started
earlier, an older extension, independently started workers, direct restore or
remote-authority operations, and external writers can still write outside it.
The fence result explicitly reports those writers as **unknown** and never
authorizes cutover, even if all enrolled records are complete. No production
session launcher, enrollment authority, takeover/recovery protocol or unified
Markdown/async drain coordinator is wired up yet.

## Native managed document embedding

`next-server/src/managed-client-host.ts` provides an explicitly opted-in
in-process capability over `StandaloneHost`, bound to an expected workspace and
the fixed `local:owner` actor. It exposes only document list, get, create and
update, closes admission before waiting for admitted calls, and does not
automatically replay uncertain operations. A caller holding this object is
trusted; the object is **not** cross-process client authentication. The
returned coverage explicitly marks external writers unknown.

The production extension exposes an explicit **PKM: Start Isolated Next Trial**
command; by default it starts no next-server. Choose an existing empty, private
directory outside the current Knowledge Root and a local, real Node executable
at least 22.18 with `node:sqlite`; nothing is downloaded. The extension verifies
the packaged payload inventory, starts its child with a private parent-child IPC
channel, and creates a new workspace rather than adopting an existing one.
**PKM: Open Isolated Next Trial Documents** lists, creates and edits trial
documents; **PKM: Close Isolated Next Trial** closes admission and drains.
Only the process holding that IPC channel can issue these calls; this is not
authentication against arbitrary code running as the same account. Packaged
file hashes detect corruption, not an attacker controlling the package and
manifest. A failed initialization leaves the selected directory for inspection;
no automatic deletion, reconnection or replay occurs. Startup failure or timeout
requests a graceful close and retains the child handle until it exits. While
drain is pending or timed out, another trial cannot be started; use the close
command again to wait. A close acknowledgement is not enough until the child
exits successfully. Failure or unexpected exit leaves the outcome unknown and
the selected directory must be preserved for reconciliation. A child crash makes
in-flight writes unknown; preserve the displayed operation ID.

The deterministic startup/close race regression can be run with isolated
outputs (no shared `dist` build):

```sh
scratch="$PWD/.migration-test-work/trial-races-$$"
mkdir -p "$scratch/extension" "$scratch/server" "$scratch/temp"
export TMPDIR="$scratch/temp" TMP="$scratch/temp" TEMP="$scratch/temp"
printf '{"type":"commonjs"}\n' > "$scratch/extension/package.json"
printf '{"type":"module"}\n' > "$scratch/server/package.json"
./node_modules/.bin/tsc -p tsconfig.json --outDir "$scratch/extension" --sourceMap false
./node_modules/.bin/tsc -p next-server/tsconfig.json --outDir "$scratch/server"
PKM_TRIAL_TEST_ROOT="$scratch" PKM_TRIAL_SERVER_DIST="$scratch/server" \
  PKM_TRIAL_EXTENSION_DIST="$scratch/extension" node --test tests/test-next-managed-startup-lifecycle.js
```

After confirming no fixture process remains, remove only that scratch directory.

For the closing-pipe regression, the same isolated outputs support
`node --test --test-name-pattern='real rejecting child' tests/test-next-managed-startup-lifecycle.js`
with the three `PKM_TRIAL_*` environment variables above. The synthetic child
reports startup failure, disconnects, and delays process exit. The parent must
send only the initial start, retain the handle, and report unknown drain until
the failed exit. Previously it sent `close` after `startup-error` while Node's
`connected` flag could still be true, causing `EPIPE`/`SIGPIPE` in the actual
Electron Extension Host. Terminal child responses now stop further IPC writes;
startup timeouts without such a response still request drain. No signal handler
or error-output suppression is used. The Electron runner rejects acceptance if
its output contains `Unexpected SIGPIPE`, even with editor exit code zero.

This is not a production cutover or a replacement for existing extension
storage. Do not point it at a live root or use its shutdown as a migration
receipt. Tests use synthetic roots;
after a crash the native workspace lease can prevent immediate restart, and
unknown write outcomes must be reconciled using their original operation IDs.

For the production Extension Host trial journey, run
`node scripts/run-next-trial-electron-test.js` from the repository root with an
already-running isolated display and cached VS Code 1.143.0, or set
`PKM_VSCODE_EXECUTABLE` to an existing absolute executable. The runner compiles
and stages into a project-local isolated extension and uses separate synthetic
HOME, user data, extensions, temporary directory, editor workspace and legacy
root. MCP Python is deliberately set to a nonexistent fixture path to prevent
automatic runtime installation. It does not download tools or run a shared
build. Missing display fails before staging. On Linux,
`node scripts/run-next-trial-private-display.js` can instead use the cached
Xvfb and VS Code with `unshare`, `ip`, `xauth`, and `xdpyinfo`: it starts
Xvfb in a private network namespace, with only loopback TCP, an isolated
Xauthority file, no local X11 transport and no X11 lock. It does not modify
other displays. `PKM_TRIAL_XVFB` and `PKM_VSCODE_EXECUTABLE` may select
existing executables. The `--prepare-only` option on the Electron runner checks
fixture staging without running Electron and is not an end-to-end pass. The
fixture uses isolated TypeScript compilation, not a fully postbuilt VSIX; this
test is not a production cutover or a complete packaging acceptance test.

The Electron journey also invokes the real static-copy import command with
synthetic copies: blocked plan, declined digest confirmation, then approved
plan/import/published status/read-only attach and preview. It sends a direct
private-IPC write attempt to verify server rejection and compares all imported
workspace file hashes before/after reads, rejection and close. Legacy fixture
file hashes are preserved except for the running extension's explicit
`.pkm/state/api-chat-control/hosts` liveness records. Dialog responses are
injected, but extension commands, bundled child, Python import and document
preview run in the actual Electron Extension Host.

### Importing a static legacy copy

**PKM: Import Static Legacy Copy into Isolated Next Trial** is a separate,
explicit command. Select a private static legacy copy, a private empty parent
directory, and local Node/Python executables. The target is always
`parent/workspace` and must not exist. The static-copy assertion is made by the
user; it is not a writer fence or caller authentication. Live roots are not
eligible sources.

The private child returns a plan. The UI displays its digest, target and every
blocker, and requires a separate exact-plan confirmation before importing.
Import is attempted at most once per child. Published status is queried before
read-only attach; the child independently revalidates its own successful import,
receipt and workspace marker. These checks do not certify every current file.
Imported documents can be listed and opened as untitled content snapshots;
editing a snapshot does not write back to the imported workspace. Both the
client and server reject create/update in this mode.

Failure or timeout preserves the selected directories and reports uncertain
outcomes/operation IDs without automatic replay. Close retains the same child
until its operations drain and it exits. This remains an isolated trial, not a
production migration switch.

### Structured Research and Skills

**PKM: Browse Isolated Research Read-Only** and **PKM: Browse Isolated Skills
Read-Only** expose the existing structured list contracts with snapshot-pinned
pagination and original names/categories/identities. Selecting an item opens
an untitled plain-text detail snapshot, preserving all returned projection
fields, the complete original JSON-representable metadata (including unknown
fields and diagnostics), document identity/path/SHA and body. Canonical
knowledge IDs, revisions, aliases, links, citations, Research authors and
conclusions, and Skills recipe/priority/related-skill fields are not replaced
with title-only summaries.

Skills details use `knowledge.skill.get` by stable document ID, not ambiguous
display names. Research has no `knowledge.research.get` contract: the UI binds
the selected list projection to the exact papers document path and its
metadata/body, then rechecks the Research snapshot revision. Identity/digest
inconsistency, malformed read models and Core errors refuse the preview; no
metadata is repaired or coerced. Rendering is inert text, with no automatic
URL/link/model/recipe execution and no structured mutation permissions.

These views work in read-only imported sessions and after capability-backed
experiment restart, with the existing before/after audited guards. They do
not add Research graphs, Skill routing, execution, or a full production
migration. Board `read_only_defer` remains unchanged.

The real Electron fixture verifies imported Research and Skill canonical
identities/revisions/aliases, related fields, unknown original metadata and
body, unchanged read-only target/source bytes, and access after clean restart.

### Editing Notes, Skills and Research in the isolated experiment

After importing a static copy and explicitly enabling `isolated_experiment`
(or resuming its saved capability), use **PKM: Edit Isolated Notes, Skills or
Research**. Choose an area, then an existing document or native categorized
create. The untitled plaintext editor supports complete multiline bodies without
writing directly to an imported file. **PKM: Edit Isolated Document Metadata
Fields** opens an optional JSON change set: omitted fields remain untouched.
Its displayed allowlist covers existing Note type/pin/tags, Skill recipe fields
and priority, and Research authors/citations/conclusions and related metadata.
Identity, arbitrary YAML, moves and renames are not editable through this form.
Native validation remains authoritative; this JSON interface is not complete
legacy webview form parity.

Use **PKM: Publish Isolated Document Draft** from either linked buffer and
confirm the isolated destination. Ordinary editor Save does **not** publish to
Next. Publication uses the existing `knowledge.note/skill/research.create/update`
semantics, not a generic Markdown overwrite. A pinned native mutation scan and
exact document ID/revision/raw SHA guard updates. Native creation assigns the
canonical identity and categorized path; updates use `preserveIdentity`, keeping
existing identity/unknown metadata while adding only missing canonical identity
fields when required. Existing asset bytes and source files are not edited.
The existing isolated capability, actor and effect restrictions still apply;
these operations are not authorized in the initial empty trial or a read-only
import. No model/tool/authentication or production authority is granted.

Cancelled approval sends no mutation. Conflict, validation failure and unknown
outcome retain the local buffers and block replay; unknown outcomes display the
operation ID for reconciliation. Reopen current server content and merge
manually into a fresh draft instead of force-overwriting or automatic rebase.
A successful draft is also single-publication: reopen before the next edit.
Closing/switching trials cannot authorize an old draft.

Real Electron acceptance exercises multiline and structured-field changes in
all three areas, native categorized creates, original identity/unknown-field
preservation, unchanged source, read-only refusal, a concurrent-editor CAS
conflict with retained draft/no replay, and clean restart persistence. Board
remains `read_only_defer`; Recipe/Prompt/Script remain read-only. This workflow
does not replace the legacy main UI or perform production cutover.

### Protected inert code archive (read-only)

**PKM: Inspect Isolated Inert Code Archive Read-Only** exposes preserved
Packages, Actions, Components and Action module sets through the same pinned
`knowledge.library.list/get` byte-reader. Logical paths such as `actions/...`
refer only to protected `legacy-code-archive/actions/...` data, never active
runtime roots. The archive ancestor is private mode `0700`. Original file
bytes/modes and directories remain evidence, not installation or runtime
validation.

The picker and every plaintext preview explicitly say **NOT installed;
execution NOT authorized; runtime NOT verified**. There is no code loader,
catalog registration, environment setup, install, execution, grant, restore or
edit action. Hidden files, JSON/YAML descriptors, executable-looking sources,
binary data and empty directories are all inert raw inventory. The UI requires
`not-applicable` runtime identity, null Prompt/Script models, the exact returned
entry and snapshot, verified chunks and the complete SHA-256. The existing
1 MiB preview limit applies before any content request.

The established policy remains: trusted workspaces automatically trust Actions;
that trust does not itself authorize effects, install archived code or validate
its runtime. This inspector changes neither workspace trust nor effect grants.
Old `.pkm/state/actions` state remains an explicit import blocker rather than
being interpreted or activated.

Real Electron synthetic acceptance covers all four logical areas, raw byte/hash
parity (including hidden and multichunk binary files), empty directories, no
active runtime roots, no non-read IPC, unchanged source/target and access after
clean experiment restart. This is data preservation and inspection only, not a
claim that the old executable environment has been migrated.

### Original Prompt and Script libraries (read-only)

**PKM: Browse Isolated Prompts Read-Only** and **PKM: Browse Isolated Scripts
Read-Only** use `knowledge.library.list/get`. The inventory includes every
preserved file, identity sidecar and directory, including empty directories.
Prompt project/task/version/file coordinates expose the original version tree;
they are not a synthesized event history. Script identities include the complete
original sidecar JSON, including unknown fields and aliases. Aliases are not an
event log or execution authority. Missing sidecars remain explicitly unassigned:
the reader never calls the old identity-initializing `scriptGet`.

The UI pins pagination and details to one snapshot and checks the entire
selected entry on every chunk. It validates canonical base64, byte counts,
continuations and the complete SHA-256 before opening an untitled plaintext
preview. Files above 1 MiB are refused before any content request. Binary bytes
are shown as hex; UTF-8 bytes remain inert text, without template rendering,
Script execution, automatic file saves or history restoration. Complete UTF-8
files up to 64 KiB also include the original Prompt/Script text model. Larger
files are explicitly chunked bytes, not a truncated legacy model. Directories
display their inventory record without a file read. Malformed responses, changed
identities and Core rejections fail without automatic retry.

The synthetic Electron fixture uses the actual old `promptSaveVersionNote`
writer to clone a version and `scriptGet`/`scriptMove` to establish and move an
identity **only in the synthetic source**. Its original-store getters supply
parity expectations. Acceptance covers original notes/metadata, canonical Script
identity and aliases, missing identity, binary/multichunk bytes, pinned
pagination, unchanged source/target and clean experiment restart. No Prompt,
Script, Action or arbitrary command execution is granted. This remains an
isolated migration rehearsal, not complete production migration.

### Original ProjectStore Recipes (read-only)

**PKM: Browse Isolated Recipes Read-Only** lists imported Recipes using
`project.recipe.list`, then reads the selected original identity using
`project.recipe.get`. Pagination pins the workspace snapshot; details also pin
the Recipe ID, revision and executable digest. Missing pins, changed identities,
stale pages and Core errors refuse the preview without retry.

The untitled plaintext preview retains the complete returned Recipe, including
canonical identity, aliases, definition, methodology, metadata, editor layout and
origin when present. Nothing is executed or rendered as active content.
The original ProjectStore migration projects legacy project-scoped Recipes as
global Recipes under `Project/<safe-project-name>/<original-category>`.
This is not active project ownership: the original project ID/owner and unknown
envelope fields remain preserved in the audited opaque source bytes, not
reconstructed by this UI.

The real Electron synthetic fixture uses the actual original `ProjectStore`
writer, imports both global and project Recipes, and compares full details to an
independently migrated original-store copy. It verifies source bytes and the
read-only target remain unchanged, and repeats access after clean experiment
restart. No Recipe execution, bundle/export, edits, Trash access, production
identity or production cutover is introduced. Board `read_only_defer` remains
unchanged; this is not complete production migration.

### Imported Boards: read_only_defer

**PKM: View Isolated Trial Boards Read-Only** exposes dedicated imported Boards
through existing `todo.board.list/get`, `todo.workitem.list` and
`todo.story.list` contracts. Select a Board, then its summary, Tasks or User
Stories. Item pages pin the original Board digest; changed digests and invalid
paths/contracts are refused, never repaired or replayed. Previews are untitled
plain-text projections, not backing-file editors. Editing a preview cannot
update the Board.

The imported reader uses the existing Board codec without `Storage.open`,
lease creation, index rebuild or journal recovery, surrounded by the same
audited snapshot checks as document/resource reads. Board worker credentials
are not exposed. The experiment path permits the same Board reads after
restart but exposes no Board mutations, claims, assignment or transitions.
The original `read_only_defer` decision remains in force: no legacy layout
write support or production Board management is introduced. Task projections
use existing contract semantics (including bounded comments, not full audit
history or a live agent directory).

The real Electron fixture imports an original `pkm.todo-board/v1` legacy
backing file, reads summary/55 tasks over two pages/a User Story, verifies exact
backing bytes and the complete read-only target snapshot are unchanged, rejects
stale digests and traversal, and reads again after clean experiment restart.

### Safe imported resource previews

**PKM: Preview Isolated Trial Resources Safely** is available for the active
trial, including read-only imports and capability-backed restarted experiments.
Select a notes, skills or papers document, then a resource returned by its
resource inventory; there is no arbitrary path entry. Document/resource lists
can be paged and inventory diagnostics are shown. Resources are read in 64 KiB
chunks, pinning document SHA, resource digest, area/path, offsets and total size.
Canonical base64, chunk lengths/continuations and the full SHA-256 are checked
before an untitled **plain-text hex preview** is opened. Nothing is executed,
rendered as HTML/PDF/image, downloaded or written to the source/target library.
The safe preview limit is 1 MiB (the server may support larger resources);
oversized resources are refused before reading chunks. This remains an
isolated rehearsal, not general attachment rendering or production migration.

The Electron fixture verifies exact binary bytes spanning multiple chunks in
all three document areas, a PNG, an empty resource, oversized refusal, unchanged
source/target bytes and attachment access after clean experiment restart.

### Isolated import write experiment

The original import command still attaches read-only. **PKM: Enable Isolated
Import Write Experiment** separately prepares and displays the actual workspace,
plan/authorization digests, target, blockers and writer coverage. It requires a
modal approval and typing the exact target. Use only synthetic data or a
dedicated isolated copy. External writers remain **unknown**; a native lease
coordinates participating hosts, CAS rejects stale edits, and unexpected changes
fail closed. None of these is a global writer fence or production authorization.

The child issues a random capability for `isolated_experiment`, not a human
identity or production owner. The extension stores its resume credential in VS
Code SecretStorage, never in the workspace or logs. Only the latest approved
experiment is retained in that profile's resume slot. Storage failure closes
the child rather than claiming resumability.

After a successful drain and clean checkpoint, **PKM: Resume Isolated Import
Write Experiment** requires another explicit warning approval and local Node
selection. Resume authenticates the saved capability and workspace binding;
changed targets, incomplete/crashed sessions and lease conflicts are rejected
without repair or replay. It does not adopt arbitrary existing roots.

The real Electron test additionally exercises declined/mismatched authorization,
approved UI writes, stale CAS refusal, clean close and capability-backed restart,
then tamper refusal. Prompt responses are automated; authorization is the actual
production private-child capability, not a test actor.

## Successor handshake and client integration

After the client explicitly reconnects, use the **same connected transport** to
list tools and call `check_version` plus `mcp_lifecycle_status`.
`handshakeManagedMcpConnection(directory, invoke, toolNames)` verifies the active
generation before/after those calls; `invoke` must return each tool's decoded
structured payload, not the MCP content envelope.
It validates the connected process against its own immutable manifest and checks
that its API remains compatible with the configured successor. The Chat connector
keeps using that actual generation/catalog across compatible publications rather
than rejecting every subsequent call because a different generation exists.

`waitForManagedMcpDrain(oldInvoke)` bounds observation of an already fenced
connection (30 seconds by default). Only `state === "drained"` permits closing
that owned connection without interrupting tracked calls. Missing lifecycle
support, an accepting/unfenced old process, timeout, cancellation of execution,
or transport loss is `action-required`, never fabricated completion. Handshake
reads also have a bounded timeout. Neither helper reconnects or closes a client
on its own; the caller must apply the relevant client's explicit controls.

`verifyManagedMcpHandshake(manifest, version, lifecycle, toolNames)` is the pure
validator. It requires unified/component versions, generation/build identity,
accepting admission, exact enabled domains, advertised managed-lifecycle support,
and required Skill-write/Chat tool presence. Only its `state === "ready"` result
justifies a connected-ready claim. A generated/current server is still merely
configured until this handshake succeeds.

For an uninstrumented old process, missing lifecycle discovery, stale
observations, or a failed handshake, show **Reconnect / action required**. Do not
claim automatic drain completion. Existing 2.17 connections cannot be retrofitted
with middleware; clients must close/reconnect them through their own controls.
The separate legacy standalone Chat entry is not a managed unified connection;
move those registrations to the unified launcher explicitly.

For extension/Chat wiring, import the helpers from `mcp/mcp`. After generating
the successor, the host must treat the old connection's drain result separately
from the successor's readiness:

```ts
const boundary = await waitForManagedMcpDrain(invokeOldDecodedTool);
if (boundary.state !== "drained") {
  // Surface action-required; do not automatically close/replay uncertain calls.
  throw new Error(boundary.reason);
}
await oldOwnedConnection.close();
// Connect a new owned client using mcpServerDefinitionData().
const readiness = await handshakeManagedMcpConnection(
  managedMcpServerDirectory(), invokeNewDecodedTool, actualNewToolNames,
);
if (readiness.state !== "ready") throw new Error(readiness.reason);
```

The adapter functions above invoke tools on their respective **actual**
connections and decode structured JSON. They must not route discovery to a
different temporary probe process. For native/external registrations the host
cannot substitute `oldOwnedConnection.close()`; show the client's explicit
Reconnect action and then verify that client's actual tool surface. The
configured-state UI can display `mcpStatus().lifecycle`, whose connection state
deliberately remains `unverified`.

Its exact fields are `state: "unverified"`, `connectionState: "unverified"`,
`generation`, `configuredGeneration`, `reason`, `action`, and `instances`.
With a coherent manifest, `reason` starts: “Managed runtime prepared; actual
client connection not yet verified.” Local integration preparation can be ready
for Host migration/reload coordination without claiming any external/native
client has completed its own handshake.

## Focused validation

```sh
node --test tests/test-mcp-lifecycle.js
node --test tests/test-chat-managed-mcp.js
PYTHONDONTWRITEBYTECODE=1 ~/pkm-envs/personal-knowledge-vscode-dev/bin/python tests/test-mcp-lifecycle.py -v
node_modules/.bin/tsc --noEmit
```

The JavaScript suite stages/publishes real generations, tests corruption and
failure handling, verifies strict handshakes, then starts the actual generated
unified FastMCP server and performs Skill add/update after removing its source
extension fixture. The Python suite uses actual concurrent stdio/FastMCP clients
to test multi-window fencing, bounded draining, explicit MCP cancellation with an
uncertain write, failure cleanup, and missing/malformed generation control.
All fixtures remain under the repository's `tests/` directory.
The Chat suite additionally verifies same-client manifest identity, same-version
legacy/build-mismatch rejection, successor generation changes, and actual
threaded-write cancellation/close timeouts. The generated-server integration
also writes a Skill through the production Chat connector after extension removal.
