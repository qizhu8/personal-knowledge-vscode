# MCP-only gateway: original business and storage

The option-A gateway changes the MCP boundary, **not** the business engine.
`src/compatibility-mcp.ts` runs one supervised original adapter per gateway,
captures its live contracts, and dispatches back to its original executors.
It does not create a v5 database, migrate the library, replace native authority,
or claim that discovering an operation proves its business behavior.

The current original runtime exposes 151 canonical `mcp.tool.*` operations.
The gateway exposes nine discovery/lifecycle/dispatch tools plus 18 module
aliases. An alias uses the canonical input schema, read/mutation classification,
and executor; it has no extra permission. In particular:

* `skill_write` preserves `add_skill` **create/upsert**, including overwriting an
  existing Skill. Use `skill_modify` for partial changes.
* Original business content, structured results, missing-object behavior and
  error results are retained. Boundary validation can reject before dispatch;
  its error text need not include FastMCP's original error prefix.
* `todo.*` and `memory.*` discovery and execution remain delegated to the actual
  canonical adapter. Their result envelopes are not replaced with guessed
  `mcp.tool.*` results.
* Worker tokens are forwarded, not reinterpreted. Conflicting tokens and
  unsupported leaf token arguments are refused. Discovery grants no worker,
  Memory confirmation, native model, or tool-effect authority.
* Original canonical metadata provides `readOnly`, not the complete legacy
  tool-annotation safety hints. Clients must not infer non-destructive approval
  scopes from missing hints; conservative additional prompts are appropriate.

In the native original-public bridge, `add_skill` also upserts an occupied
sanitized destination (for example, `Skill?` resolves to `Skill.md`). The exact
destination's knowledge identity, revision, bytes and scan are pinned for native
CAS; resources remain under their existing ownership. Ambiguous names, private
custody, competing edits and unapproved moves remain refused.

`skill_feedback` and `propose_skill_update` execute the existing native advisory
maintenance backend with exact current public actor/root approval and imported
maintenance genesis when present. Authority is rechecked after planning and
before committing immutable receipts. Feedback stores the task hash, not the
raw task; proposals record the real current Skill hash and mark stale bases as
conflicts. Neither operation edits formal Skills or contacts a collector.
Existing installation, activation and Skill routing semantics are unchanged.

The hybrid facade's `capabilities_list` / `capabilities_search` input schemas
declare the existing numeric discovery limits: `offset >= 0` and `limit` from
1 through 10. Clients can reject invalid pagination before a request instead of
learning these bounds from a runtime error. This refines the new hybrid
discovery boundary only; the captured compact/original schemas, 151 business
contracts and their authority are unchanged. Existing string-length guards
remain authoritative; no different Unicode-length rule is introduced.

## Staging and identity

`scripts/stage-compatibility-mcp.mjs` accepts an existing original extension,
library and managed runtime, a Python executable, and a **new private stage
outside the library**. It bundles privately rather than building shared `dist`.
It writes a pinned `target.json` and private `adapter.json` into that stage only.
A failed stage removes its own newly created partial directory, never an
existing destination. Staging does not select, deploy or rewrite a live target.

The CLI checks configuration ownership, permissions and SHA-256 using the opened
file descriptor. Node, supervisor and launcher files are pinned. A regenerated
original generation may be accepted only when the explicitly staged update
policy permits it and its **version and entire component-version set still
match exactly**. Its generation/build must be valid, its runtime accepting and
empty, and its identity unchanged throughout catalog capture. Incompatible
versions do not trigger a fallback.

`check_version.runtime` identifies the gateway. `check_version.backend`
truthfully identifies the original business runtime, reports
`storageEngine:"original"` / `storageMigrated:false`, and includes live
`health:{phase,inFlight,uncertainCalls,automaticReplay:false}`.

## Native, Chat and CLI selection

On same-ID v5 Linux profiles (local or Remote-SSH), the native `pkm` provider
and PKM Chat use one live gateway without an environment opt-in. Settings → MCP
can switch Original ↔ bundled v5 without replacing either client connection.
Both backends continue to use Original's storage; no migration or rollback is
performed. Admission requires the canonical owner-owned root, without
group/other writes, bound to this profile's
native provider. Windows on the same canonical Original root join its admitted
owner, retaining their own Original connections and host/Chat attribution.
Different roots remain independent. Unknown/unmanaged Original clients remain
refused; the switch does not silently rewrite external client configuration.

The managed Original launcher holds a shared custody guard through its entire
lifetime. Live ownership takes the exclusive guard, durably inhibits restarts,
and proves that cooperating old writers released the root fence before starting
its own adapters. Only those adapters receive a private, root/owner-scoped launch
grant, consumed before business code runs. Unverified drains, crashed writers and
abandoned live-owner markers require explicit recovery; they never trigger an
Original fallback or automatic replay. Close an old cooperating client cleanly
before retrying an admission refusal. Older uninstrumented/external launchers
are not qualified participants.
Read/execute access on a root (for example `0755`) does not itself prevent
admission; its custody ancestry must also deny group/other writes when other
users can traverse that root. Custody markers and control directories remain
private. Admission never changes the root's permissions.

An independently detached compatibility service owns custody, not an extension
host. Native activation reserves a window's lifecycle with that service without
starting any Original adapter or MCP relay. The service publishes private
`owner-live.json` during its verified reservation, so another window can prepare
admission before MCP startup. Explicit client Start enrolls its own adapters;
an explicit Start retry can revalidate a newly ready service without Reload.
Enrollment checks its root inode, custody-marker hash, owner PID/start ticks and
boot identity, exact Original generation/build and bundled build, then performs
an authenticated loopback handshake. A peer never takes or bypasses `owner.guard`,
receives no custody launch grant, and cannot remove the pending marker. Its
host-only callback proves live admission/background activity and supplies native
confirmation. Each admitted native window confirms a switch; all windows'
Original work, browser reads, relay enrollment and CLI calls must be idle before
the shared dispatch reference changes. New work is refused during verification.
The actual drain transition is delivered through the authenticated native
callback, correlated to the pending switch and selection revision, before
verification and its terminal result. It is not inferred from a status-poll race
or fabricated while waiting for confirmation.
Lost transports or crashed/unknown owners or peers fence admission without replay.
Orderly window close or Reload drains only that window's adapters. Other
windows' admitted work, connections, identities and shared selection remain
intact; a reopened window joins the same service and selected backend. Lifecycle
departure waits for concurrent enrollment/switch management rather than treating
ordinary contention as a crash. Only the service's confirmed final-participant
drain releases its durable pending marker. Lost bootstrap admission, a crashed
service or an unacknowledged participant loss instead retains the recovery
fence: no automatic takeover, marker deletion, inferred result or replay occurs.

Native activation prepares this custody before its own retrieval and singleton
service writers start. Under that reservation and the existing singleton
lifecycle lock, it asks a verified same-profile/root predecessor service
(including protocol-v1 4.0.27) to perform its administrative safe-idle drain.
It waits for that process and endpoint to exit, then still takes the exclusive
root-writer preflight; it never kills the daemon or substitutes a health check
for drain proof. Unknown exits and unsupported drain protocols refuse admission.
The lifecycle lock prevents a reconnect from restarting the singleton in that
gap. Normal window disposal does not drain the independent HTTPS service.
Reopening a window joins an existing compatibility service; if no compatibility
participants remain, a new verified admission safely drains/readmits the HTTPS
successor while retaining its private provision.

Runtime repair checks for existing clients before publishing maintenance
markers: Original treats even a transient marker as a permanent admission fence.
A repair refused for active or unknown clients therefore leaves their accepting
state, identities and Note reads intact. An admitted repair still publishes both
markers and repeats the client check before changing shared dependencies.

The native provider and PKM Chat use the reviewed target selected in the v4 host.
Copilot CLI has a separate user configuration at `~/.copilot/mcp-config.json`.
Selecting the native provider does not silently rewrite that file. After explicit
user approval, its `pkm` command can use the verified payload's Node executable
and `[server/dist/compatibility-gateway-peer-cli.js, canonicalRoot,
exactOriginalGeneration, exactOriginalBuild, exactBundledBuild, "--writable"]`;
use `"--read-only"` when the reviewed owner is read-only. Keep other
server entries, JSONC comments and the existing `tools` policy unchanged.
The native route's `managedPeerDefinition()` supplies these exact root/installed
pins without starting or reserving a backend. If an authority is already bound,
its current accepting status is also verified. The reviewed definition
explicitly preserves the owner's configured writability rather
than silently downgrading existing CLI capabilities. The CLI joins as a distinct
verified external participant; `check_version.routeRuntime.participant` reports
its external source, process identity and effective writability. Original's
existing attribution schema truthfully remains `standalone/unknown`: no native
host identity is invented and Original's exact pins/schema are not weakened.
External writes use the same capability grants, worker-token checks, Original
executors and shared drain ledger as native calls. External peers cannot start
an owner or switch backends. An explicitly read-only peer refuses mutation,
and a read-only owner refuses a writable enrollment with `READ_ONLY_OWNER`.
Four-pin historical CLI launches remain read-only; new reviewed definitions
always include an explicit access flag.

A missing owner (including a root containing only `owner.guard`) reports
`COMPATIBILITY_OWNER_UNAVAILABLE`, never a cold fallback. The new verified
native admission must first reserve the independent service; the old
process-local installation cannot provide the new authenticated rendezvous.
SDK hosts may reuse `joinCompatibilityGatewayPeer(root, binding, host)` with the
same binding, `relayRoles:["workbench"]`, supported standalone attribution and
`externalPeer:{writable:true}` (or `false`) for an explicitly reviewed external
participant.

Native provider enumeration uses metadata-only `describeLaunch()`; only server
resolution/explicit Start calls `launch()`. Settings reads also never start a
relay, authority or Original backend. Registering a CLI definition before native
startup is therefore safe, but launching that CLI still reports unavailable
until the authenticated owner rendezvous is ready. Standalone metadata builders
must pass `executable` matching the native host's actual verified executable:
its path/digest are part of the bundled build pin. For a VSCode executable,
the caller supplies `ELECTRON_RUN_AS_NODE=1`; metadata contains no credentials.
Use the actual Remote-SSH server Node when building a definition for that host,
not a different Node selected by the standalone shell.

A restored non-read-only PKM Chat legitimately starts managed tool discovery
when its view becomes ready. Settings therefore reports that verified active
Original backend even before a separate Workbench MCP Start; it must not pretend
the backend is cold. Passive discovery/Settings reads remain side-effect-free
when no client has started. Installed restored-profile qualification checks the
actual Chat startup trace and attribution, then waits for both client relays to
be verified before measuring unchanged scheduled-refresh rendering.

New CLI/agent chats then discover the selected gateway. An already-running
conversation may still have its previous launch descriptor and private socket
cached; a native reload or editing the CLI file is not proof that this old
conversation refreshed. Verify `check_version`, backend identity and the tool
inventory through the actual new chat's MCP tools. Do not label a direct SDK
probe as proof of that conversation's inherited connection.

## Explicit manual compatibility-custody recovery (Linux)

Recovery is **not automatic takeover**, adapter restart, journal repair, or
replay. A crashed service leaves its durable admission fence. Do not remove
`owner.guard`, pending markers, writer-session directories, or operation records.
First close the affected native/CLI participants explicitly; do not kill an
unrelated process or use a PID alone as death proof.

Use the **same verified installed payload's Node and recovery entry**, with the
canonical root that the operator actually reviewed. For example, with the
absolute installed paths substituted:

```sh
"/verified/node" "/verified/next-runtime/server/dist/compatibility-gateway-recovery-cli.js" inspect "/canonical/library"
"/verified/node" "/verified/next-runtime/server/dist/compatibility-gateway-recovery-cli.js" recover "/canonical/library" --confirm REVIEW_SHA256
```

For an extension-host executable used as Node, supply `ELECTRON_RUN_AS_NODE=1`.
Inspection is read-only and returns `recoverable`, owner/peer process pins,
unresolved operation IDs/labels and evidence paths, blockers, and
`reviewSha256`. It does not disclose rendezvous credentials or tool arguments.
Review those details before supplying the exact digest to `recover`; a stale
review requires another inspection and confirmation.

The recovery command acquires the existing exclusive custody guard and Original
root-writer fence, then repeats the complete review, including immediately before
publication. The owner and every outstanding participant must be proven dead
using Linux PID **and start ticks and boot identity**. Live processes, replacement
PIDs, different boots, unreadable identities, another writer, malformed/older
uninstrumented custody, and competing recovery are refused. No process is killed
and no root permissions or client configurations are changed.

Custody now journals predecessor admission before requesting drain. Participant
admission, observed background activity, coordinator management operations and
relay business calls receive durable begin/terminal evidence before effects can
be forgotten. A clean close cannot discard outstanding evidence. A crash with
an unterminated call or uncertain predecessor drain is **not recoverable by this
command**, even after every process exits. The refusal identifies the operation
and retained evidence for qualified offline outcome reconciliation; do not retry
it, invent a completion record, or describe refusal as successful recovery.
Independent `original-pending-*`, cold adapters, and native
`managed-writer-session`, `managed-writer-session-compatible`, or their lock are
also outside this command's authority and require their own verified manual
resolution. Presence of those native journals remains a blocker even if their
individual operations might be complete; this command does not certify or clear
them.

For a proven dead, idle, fully instrumented compatibility service with no
independent journal blockers, recovery archives the exact owner descriptor,
pending marker and reviewed receipt in a new private `recovered-*` directory.
The owner's `evidence-*` directory is retained unchanged. The pending marker's
atomic final archive is the restart-release point, under both held guards.
Interrupted archival remains fail-closed; inspect again rather than deleting
partial evidence. Recovery itself never starts a service or selects a backend.
Only a subsequent explicit native Start admits a new verified service, initially
in Original mode; verify the original Note read and then perform the usual
reviewed Original ↔ bundled-v5 switch.

`tests/compatibility-gateway-service.test.mjs` exercises this complete isolated
CLI workflow (crash, live-peer refusal, close peers, inspect, digest confirmation,
archive verification, explicit restart, original Note read, v5 and back). It also
crashes an actually admitted Original write and verifies actionable refusal with
its begin evidence retained. These are isolated fixtures, not a claim that a real
user library or independent native journals were repaired.

## Cancellation, failure and shutdown

Cancelling a caller's wait does not cancel/replay an admitted original write or
remove it from the gateway drain ledger. EOF and SIGINT/SIGTERM, including
signals during startup, request the same graceful close. The gateway waits for
the original lifecycle to prove drain, ends its input, and observes its
supervisor exit. It does not substitute a forced kill for that proof.

An adapter transport failure fences new work and quiesces gateway admission.
Unacknowledged writes retain an unknown outcome even after their process exits.
Close rejects rather than reporting a verified drain or replaying the write.
A malformed/unavailable drain control also refuses a clean-shutdown claim.

## Focused evidence

The native original-public facade implements `diagnostics_latest` from its
current native host's process-local metadata writer, not the legacy adapter or
archived diagnostic files. It retains the original response keys and default
100-row limit; reads accept integers from 1 through 1000. `directory` is the
opaque locator `native:current-process`, never a filesystem path. The bounded
100,000-row in-memory ring reports overwritten rows in `dropped_records` and
marks records `persisted:false`. Reloading or replacing the native host starts
a fresh writer; no old writer rows, transcripts, caller arguments, exception
messages, profile/owner identifiers, secrets or raw output are imported.

This is an intentional native privacy deviation from v4's filesystem locator,
not a promise that the marker names a directory or an openable URI. No shipped
MCP/UI caller opens the returned field. The legacy local JSONL exporter and
historical-writer tools operate on explicitly selected legacy disk directories;
they must not be used with this native marker or writer ID. For native export,
save the current MCP reply's `records` (at most 1,000 per read); there is no
filesystem/history export or persisted tail to open. Existing extension/Sync
log-opening UI continues to use its own independently owned logs.

Every read requires the same exact current native public approval, owner,
source-catalog and epoch checks as other original-public operations. Read-only
principals may read diagnostics but gain no mutation authority. Cancellation
or authority revocation before publication discards the response. This adds no
durable schema, migration, historical authority or logging-framework change.

Run:

```sh
node --experimental-transform-types --test --test-concurrency=1 tests/compatibility-mcp.test.mjs
PKM_COMPATIBILITY_EXTENSION="$PWD/legacy" node --test --test-concurrency=1 tests/compatibility-gateway-authority.test.mjs tests/compatibility-gateway-coordination.test.mjs
npx --no-install tsc -p tsconfig.json --noEmit
```

Tests generate isolated original-managed fixtures under `.pkm-test-evidence/`,
with their own CommonJS package boundary, and remove their private stages and
libraries afterwards. They require the current original extension build
(`PKM_COMPATIBILITY_EXTENSION`, default `../personal-knowledge-vscode`) and its
configured test Python (`PKM_TEST_PYTHON` can override).

The focused suite verifies actual-original Note update/read; Skill
create/read/partial-update/upsert and alias/canonical results/errors; Action
capability read; canonical Todo board listing and Memory record search;
worker-token denial/forwarding; cancellation followed by EOF during a locked
real write; normal EOF; startup signals; compatible regeneration; incompatible
build/component refusal; and partial-stage cleanup. A separately labeled
synthetic protocol fault tests read/write disconnect accounting and no replay;
it is **not** evidence of original business execution. The 151 captured
contracts and 18 aliases are catalog evidence, not 151 executed business tests.

The suite also compares warm `capabilities_search(query:"get_skill",limit:1)`
over stdio against a direct supervised **current original service on the same
isolated fixture**: five warm-ups, 40 measured calls per side, alternating call
order, startup excluded, nearest-rank percentiles. One Linux run on 2026-11-20
measured gateway p50/p95 **0.655/1.151 ms**, direct original
**7.272/11.429 ms**. These are local warm discovery measurements, not provider
tokens, business-call parity, startup latency or a production performance SLA.
The test prints fresh metrics; no historical benchmark artifacts are required.
