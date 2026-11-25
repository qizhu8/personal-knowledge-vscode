# Local canonical-native Action controls

This is a bounded implementation slice, **not original-root Action admission or
full151 cutover readiness**. It does not activate archived settings, import old
worker grants, or proxy the original Python MCP.

## Typed adapter

Independent package/catalog, proposal, artifact and publication metadata is
closed-verified even when no old Action footprint exists. The synchronous
`verifyOriginalMcpActionAuthoringReadSchema` requires one current read transaction,
the exact physical schema and completed root/workspace journal custody. It
returns only verified SQLite object names, never source or execution permission.
Callers must still match every remaining base object to the pinned canonical or
derived schema and independently verify their own receipts and byte inventory.

The shared public facade also serves authenticated `recipe_capabilities` through
the pure workflow compiler and implemented bounded Recipe scheduler slice. This
describes implementations, not source or process permissions: source review and
each process effect still require separate current native decisions, autonomous
loops remain unavailable, and full Original Recipe parity is not asserted.

`src/original-mcp-action-runtime.ts` exports:

```ts
createOriginalMcpActionRuntime(owner: RootOwner, actor: Readonly<Actor>,
  host: OriginalMcpNativeHost): Promise<OriginalMcpActionRuntime>

interface OriginalMcpActionRuntime {
  readonly operationIds: readonly string[];
  invoke(tool: string, args: Record<string, unknown>,
    signal?: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
}
```

The factory resolves the owner's existing `ensureFull().runtime.core` and
`services.hostServices.actionRuntime`; it never opens another owner, constructs
another Action engine, or accepts a caller's runtime/authorization callback.
The host-services property is an in-process typed handoff, not an MCP method.

Every invocation checks the real owner/lease, fixed `mcp:external` actor, live
branded native host and exact actual151 input schema. Mutations require the
actor's existing write permission. Arguments are snapshotted before awaiting
approval. A surrounding approval is reused only when
`originalMcpPublicRequestMatches` verifies the same host, operation, classification
and complete argument digest; a tool-name-only match grants nothing.

`originalMcpActionOperationIds` contains these **local canonical-native**
operations, each prefixed `mcp.tool.`:

* `action_run_events`, `action_run_wait`, `action_run_cancel`
* `action_run_checkpoints`, `action_checkpoint_respond`, `action_run_wake`
* `action_run_recover`, `action_run_safety_scan`
* `action_implementation_select`
* `action_validate`, `action_validation_enqueue`, `action_validation_status`,
  `action_validation_cancel`, `action_validation_resume`

Conditional selected-source operations also include `action_get`,
`action_module_sets`, `action_run_get`, `action_run_reconcile` and now
`action_call`. The latter executes admitted flat pure/human-input native
pipelines only after separate exact native invocation consent. It retains
actor/key/request idempotency and never restores effect grants or replays
started work on restart. See the selected-source document for its precise
supported contexts and remaining blockers.

They require an actually composed native Action engine. Missing native policy
returns `ACTION_NATIVE_ENGINE_REQUIRED`, including for status/recovery; it is
not converted into successful empty history.

## Actual business effects

### Public authoring, packages and maintenance

The public facade dispatches registered authoring, graph, template, proposal,
retrieval, package and artifact operations through
`original-mcp-action-authoring.ts`. Existing validators and immutable proposal,
catalog and artifact stores are reused. A fresh public request is not an
execution/source/path grant. Original sources remain separately selected and
currently admitted; registry revisions, graph dependency hashes and conflicting
package hashes are checked before publication. A proposal remains pending unless
the independently configured native host admits its exact revision.

Package exports contain the selected action/dependency/resource closure and use
an independently admitted destination, immutable publication stages and
descriptor-relative Linux writes. Unknown publication outcomes are retained;
they are never overwritten or replayed.

The native VS Code Action producer provides separate signed
`action.package.source.approve`, `action.package.destination.approve` and
`action.package.decision.current` requests. Source review reads the selected
bounded archive and pins its actual bytes, descriptor, parent, current
workspace/profile/epoch and source protocol. It grants custody only, never
execution. Destination review independently binds the actual output archive
hash and one new path. Frozen host-owned decisions are not transferable by
copying their JSON. Current decision checks run inside workspace exclusivity
and again before publication; cancellation, expiry or native revocation denies
new writes. Relative public paths retain the existing execution-host `resolve`
semantics, while signed picker decisions always name exact canonical paths.

`action_run_gc` examines compiler-pinned, actor-owned native Run snapshots.
Live/unknown owners, nested ownership, other retained references and pending
artifact exports fence collection. Published outputs remain retained unless
explicitly released. Failed diagnostics have a one-hour retention interval.
New managed artifacts store immutable metadata and separate bounded
`native_action_managed_blobs`; exact owned GC receipts authorize transactional
payload deletion. Historical inline-v1 audit bytes are never rewritten/deleted.
GC reports those retained historical payloads separately; `deleted` contains
only physically collected native blobs, while `released` records revoked
references. A later default GC cannot resurrect a released output.
Released references cannot be inspected, materialized or exported. Borrowed
sources and user-exported files are never GC targets.

These are closed optional metadata groups, not additions to the canonical
bootstrap schema. Historical readers validate their exact DDL, payload,
workspace/actor/root/source and native-host receipt bindings. Older readers must
be rejected by the managed source-protocol compatibility check **before**
draining a current owner; a parser failure after handoff is not a migration
gate. The Action marker is derived from the actual closed module-byte,
package-admission, GC, Cosmos and managed-blob schemas, independently of DDL.
Never reinterpret a retained record through an older live owner.
An original-owned schema23 root requires its exact physical custody and native
host metadata for this optional artifact namespace; artifact grants do not
upgrade it into private snapshot authority. Ordinary native workspaces retain
the existing schema27/28 artifact downgrade fence.

Native ModuleSet source v2 uses
`fileEncoding: "pkm.native-action-module-source/v2"` and closed
`{schema: "pkm.action.module-bytes/v1", base64: ...}` assets. Definitions remain
UTF-8 JSON; canonical base64 is decoded and bounded before hashing actual
bytes. Old UTF-8 snapshots and untagged v1 admission records remain unchanged.
Binary admission requires a separate current host-owned v2 source-protocol
decision bound to actor, workspace/root pin, source path and raw archive hash;
that decision is checked again immediately before the admission transaction
persists. Public arguments cannot supply the decision.

Exports retain only explicitly declared implementation/typed-path resources,
never a directory prefix scan. Byte hashes and declared executable metadata
survive native ZIP publication. Registered local definitions are reauthorized
at the final publication boundary. An uncertain package publication fences
further package/artifact writes and GC; there is no automatic reconciliation
or retry under a new destination. This journal does not itself supply an
operator reconciliation control.

`action_cosmos_configure` stores exact private lowercase host/VC/account maps in
the existing append-only native receipt ledger. It never rewrites archived
settings, imports credentials or exposes account maps publicly. Reordered maps
are equivalent; changed maps are fenced by retained operator policy or live/
unknown Action work. `readNativePrivateCosmosBinding` is a current branded-host
internal getter, not an MCP credential endpoint. Configuration alone grants no
execution or path authority and never inherits old path grants.

### Fresh registered programs and Original Cosmos operations

The default original-owned native bootstrap composes registered Action execution
when the current signed producer advertises `action.registered.status` and
`action.registered.review`. A separately reviewed exact proposal revision is
source authority only. Each new Run has its own effect decision binding the Run
ID, complete inputs, executable/interpreter and script hashes, closed argv,
current root/profile/actor/epoch and expiry. Revocation is polled while work is
active. No shell is synthesized, toolchain installed, archived grant restored,
or additional execution engine constructed. The existing ActionRuntime and
owned RuntimeProcess child provide status, events, cancellation and retention.
This is not an OS filesystem/network sandbox. Build/dependency-bearing programs
still need their existing specialized host; this default bridge admits direct
programs without silently installing dependencies.

The original IDs `cosmos.directory.list`, `cosmos.artifact.upload` and
`cosmos.artifact.download` use `action_get`, `action_call` and the existing Run
controls, not invented job APIs. Their private current definition pins the
append-only configuration revision and actual `az` executable/interpreter
closure. The adapter runs the real `az dls fs list/upload/download` command with
closed account/path/source/destination/overwrite/thread-count argv and JSON
output. Configuration is not an effect or path grant. Upload files/directories
and new or explicitly overwritten download files/directories require separate
current native picker/effect review of their bounded bytes and canonical parent.
Symlinks and special files are refused; directory review is bounded to 128
entries, depth 16 and 32 MiB. Relative local paths resolve from the current root.
Configured destinations are HTTPS and credential/query/fragment free.
Raw dot traversal, encoded separators, backslashes and control characters are
rejected before URL normalization. Selected parents must retain their canonical
identity, safe ownership and non-group/world-writable mode.

Transfer `timeout_seconds` is bounded by the existing local Run/process limits.
CLI output is projected as the original arbitrary JSON result. A successful CLI
completion is not independent verification of remote contents. Nonzero mutating
CLI exits, cancellation, timeout, malformed/truncated output and uncertain
completion remain `outcome_unknown`; repeating the same idempotency key returns
the same Run without another transfer. Unknown/live work fences configuration
changes. Controlled local executable tests are not external-account acceptance.

`action_run_reconcile` also supports one bounded fresh-native case: the same
owner actually observed a successful, typed direct-child result, but the Action
result commit was lost. Independent signed `reconcile` review binds the exact
actor/root, current Run revision, source and adapter pins, actual process
operation/job receipt, observed output and evidence reason. The existing engine
records one idempotent version-CAS transition without executing anything.
Caller-declared outcomes or replacement outputs are not evidence. Ambiguous
results, altered receipts, stale revisions, source changes and revocation deny.
The owner's observation cache is bounded to 128 results and is never authority
after restart: durable terminal process metadata alone cannot recreate consumed
stdout or prove its Action linkage. Missing/evicted post-restart evidence leaves
UNKNOWN fenced; no archival/reset/manual-override framework is provided.
Historical `reconcileRecovered` retains its original-admission guard unchanged.

Automatic source/readmission, invocation and nested-artifact metadata remains
an exact optional group, outside the canonical bootstrap schema. Cold/Sync
readers verify closed DDL, typed records, independently retained native-host
epochs, exact proposal/compiler/input/Run links and nested ownership. Passive
verification restores neither source consent nor process/path authority.

The Azure DevOps status template produces a real pinned Python program with a
bounded read-only Azure CLI GET adapter and the existing result protocol.
It distinguishes local query completion from remote completion, redacts CLI
errors, disables dynamic extension installation and never logs in, switches
identity, installs tools, retries unknown work or cancels remote work. Separate
native source/effect/process/environment authority is still mandatory.
Deterministic local CLI fixtures are not live Azure account qualification.

The existing `ActionRuntime` now supports intrinsic `core.checkpoint` and
`core.wait` steps, **after** the existing exact adapter/source/data authorization
checks. All five human checkpoint kinds preserve the original Run. Proposals,
answer schemas, resume tokens, history and node receipts are committed in the
existing run snapshot/event transaction. Responses bind the current checkpoint,
exact proposal digest, token and typed answer; identical answers are replayable
but changed/stale answers fail. Human answers never grant downstream effect
permission: each remaining node still requires its current native authorization.
Parallel peers finish before a worker suspends.

Event wakeups are deduplicated. Timer/dependency scans resolve only their
original waiting Run. Dependencies bind actor-owned run identity, revision and
invocation fingerprint. Failed/unknown dependencies and expired review deadlines
require reconciliation, not resubmission. Waiting runs survive real owner
restart without execution. Recovery skips this engine's currently owned work
and marks abandoned started work unknown; it does not replay it.

Original event replies expose a replayable 256-entry retained cursor with
explicit gaps and redacted native lifecycle payloads. Wait uses a monotonic
deadline, advances due native continuations, returns typed successful outputs
when their current result policy permits, and distinguishes expiry/event update
from completion. Aborting a wait does not cancel its Run. Cancellation uses the
same Core operation and reports `cancel_requested` and `remote_rollback:false`;
like the original protocol, the returned pre-cancel record is not proof of
completion.

Implementation selection is actor/revision scoped in the immutable
`action_runtime_selections` SQL journal. It rejects incompatible targets and
actually changes native run creation, including after owner restart.
Ambiguous compatible implementations are no longer silently selected.

Qualification executes real packaged pure-builtin examples through the same
Core and records their native Run IDs/results in the bounded, immutable,
hash-chained `original_mcp_action_validation` SQL journal. One worker per actual
Action engine handles deduplication, priority promotion, cancellation and safe
queued-job resumption. Crashed/interrupted active qualification is unknown and
never replayed. A public `allow_effects` value is retained as request data,
**not** interpreted as an effect grant. Nonbuiltin qualification still requires
the native Workbench code-review flow; effectful/credential/host-specific
qualification fails closed without its real native producer.

These are additions inside canonical SQLite, not new original-root directories.
Their presence must still be included in the eventual B1 preservation/recovery
closure. No old `.pkm/state/actions` file is overwritten.

## Still missing for the actual original-root cutover

The follow-up selected-source/state implementation is documented in
[`original-mcp-action-domain.md`](original-mcp-action-domain.md). It adds
independently sealed auxiliary/executable custody, real engine import and a
separate typed current Action source-decision RPC. That scoped implementation
does not make the remaining full-library/production authority requirements
below disappear.

* Full source/ModuleSet/executable closure, source-identity qualification,
  actual native producer and B1-qualified write footprint beyond the selected
  admitted capsules.
* Complete Run/worker/checkpoint/validation and invocation-tree coverage
  beyond the supported imported flat native continuations. Selected original
  notifications are preserved; unselected history is never manufactured.
* Actual current-profile native Workbench review/admission and fresh
  revision/toolchain/input/effect approvals. The public model/tool grant is not
  an Action effect grant.
* Native credentials, OS/toolchain, Cosmos, nested process/artifact and remote
  reconciler authority where required. Unsupported protocol operations remain
  explicit blockers.

Consequently, these local operation IDs are **not** permission to mark the
full original-root implementation/authority gate ready. The public dispatcher
must preserve the remaining source/custody/native-producer blockers.

## Focused validation

`tests/original-mcp-action-runtime.test.mjs` uses the independently pinned
`original-public-mcp-discovery.json` and genuine synthetic original-layout
roots, writer fences, canonical Core, live SQL leases and native process/pure
engines. It covers real checkpoint outputs, all five kinds, event/timer/
dependency effects, cursor gaps, exact approval binding, actor/permission
denials, builtin evidence, queue cancel/dedupe/resume, actual implementation
choice, and owner restart/no replay. Fixtures remove their own roots.

```sh
npx tsc -p tsconfig.json --noEmit
# Run against a coordinated build (or isolated private compiled output).
npm test -- --no-build --file tests/original-mcp-action-runtime.test.mjs \
  --jobs 2 --admit-native --admit-qualification
```

This is isolated fixture regression, not live profile or cutover qualification.
