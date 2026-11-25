# Original public Recipe Library definition boundary

## Implemented behavior

`planOriginalMcpRecipeLibrary` no longer conflates definition admission with a
NoOp-only execution grant. The existing compiler validates and normalizes static
unbound NoOp, command, Script and command/Script Pipeline definitions, preserving the selected Recipe
identity, revision, executable digest, node identities and original source bytes.
NoOp graphs may declare ports and fixed branch cases. The original immutable canonical admission subtype retains its historical
static/unbound restriction. The fresh native source subtype below separately
admits validated definitions, controls and required Knowledge; it does not
reinterpret an old restricted source decision as new authority.

The existing canonical source DTO retains its signed no-effect contract:
`noExecution:true`, `protocol:"controlled-external-report/v1"` and
`effects:["caller-reported-result-only"]`. Admission remains an exact independent
source decision, not permission to launch a shell, process, model or SDK.
The existing canonical source producer, descriptor/membership pins, custody
reader, immutable native source schema and host/profile/epoch/approval checks
remain mandatory. Historical reads require the same exact source/schema proof;
table presence is only a routing classifier, never authority.

With a sealed Library source, the original public facade routes `recipe_search`
through a fresh source/host/request verification and the existing original
metadata ranking adapter. It searches all validated canonical source records,
not just the execution selection. Queries, category filtering, task-contract
fallback, error envelopes and original argument/output shapes are preserved.
Revocation, expiry, changed bytes/membership, or absent reactivation after restart
deny this admitted-source path instead of falling back to archived authority.
Without a sealed Library source the existing metadata-only search route remains.

The original public `recipe_run_start`, `recipe_run_next`, `recipe_run_report`
and native-run `recipe_run_get` still compose exactly one existing lazy runtime.
Static ported NoOp branches now use its existing explicit external-report
adapter; outcome selection, declared graph bindings, dependent-node claims and durable
receipts are native. Caller-reported data is not a verified host effect.
The public next-action `inputs` retain Original's run-input-only semantics;
declared ports are not a claim of newly verified typed port dataflow.
Every call retains the separate exact public approval and existing actor rules.
Claimed work is fenced UNKNOWN on source loss and never automatically replayed.

## Fresh native authoring and definitions

The public `recipe_create_from_skill` path requires the actual current Skill,
its canonical content hash, an explicit `recipe_required:true` declaration and
independently signed source/write approval. It preserves Original's deterministic
public ID, default arguments, first input node, portable Project category,
metadata and replay/error envelopes. Native UUID records retain their existing
schema; an exact receipt proves the public-ID projection. Reusing a command with
changed arguments or an edited record fails instead of overwriting it.

Fresh native definitions carry an atomic payload witness in the existing
receipt table, alongside the unchanged ordinary save receipt. This binds the
exact saved actor/input/record, not an actor-name or table-name allowlist. Bare
historical save receipts are never backfilled on replay. Current native metadata
can be independently admitted and searched before execution, including later
native revisions; a save alone is not an execution grant.

Adhoc preparation validates the caller's complete instance definition and
bindings without creating a Library record. Its Original public digest hashes
the raw definition and bindings, separately from the native compiler digest.
Replay uses the shared Original input normalizer, including typed defaults;
conflicting reuse is rejected before replacing the active source decision.
Required Knowledge uses the shared current-document resolver, exact declared
identity/path/modern Knowledge ID, revision, content hash, file/ancestor pins and
bounded data context. Serialized Knowledge never grants authority.

The new native source subtype remains `noExecution:true`. Read, author and
execute-source decisions have independent revocation lanes; metadata reads do
not cancel an unchanged running execution. Session loss revokes all lanes.
The first native Recipe may be authored against an empty canonical Library.
Only that native source subtype accepts an empty file list; existing canonical
admissions still require their complete record/control manifest, and nonempty
native manifests retain the same exact file entries, maximum and live pins.
Each fresh executable source declares `original-recipe-metadata/v1`, or
`native-runtime-bindings/v1` for explicitly declared versioned
`workflowControls` input. The former preserves Original's actual once-only
handling of repeat/trigger metadata, not recurring scheduling or typed output
mapping. The latter uses the one shared runtime-binding resolver/executor,
never an inferred dynamic count or caller UUID as effects authority.

No DDL, canonical Schema digest or native record version changes. Namespaced
receipt rows are additive; old pending/UNKNOWN state and receipts are not reset
or reconstructed. Cold reads validate exact native/source/payload receipts,
historical host evidence, canonical origin, membership, custody and descriptor
pins. Restoring readable records never restores live execution consent.
An unchanged execution source retains its exact plan across a real cold reopen,
but requires a fresh signed decision bound to the new host receipt and epoch;
a denied fresh decision cannot reactivate it.
Matching updated native producer/server payloads are needed for the new source
subtype; unsupported old producers fail closed. Local definition/Knowledge
contracts require no external SDK credentials.

Execution, external-report and human-input orchestration remain the single
shared Recipe runtime's responsibility. Commands and Scripts additionally
require its independently approved current-host per-invocation effect producer;
neither authoring, source admission nor metadata-mode declarations authorize a
process, model, account, SDK or network effect.
Pipeline definition acceptance does not supply a native Pipeline effect adapter.
Parent/child orchestration composes that same executor; reachable-source
admission alone does not claim that work was executed.

## Pinned reachable subflow sources

Fresh executable parent sources include only the transitively referenced current
Library children. Every edge requires the exact public Recipe ID, revision and
compiler digest. Native children additionally require their unchanged ordinary
save receipt and exact atomic producer payload witness. Public authored aliases
resolve to those actual records, not invented child sources or copied authority.

Child graph/body/receipt pins and aggregate current Knowledge pins are covered
by the authentic parent's signed source plan. The bounded closure permits at
most 16 levels, 32 recipes, 128 source nodes and 128 Knowledge pins; missing,
changed, recursive or over-budget graphs fail before source consent. Unrelated
Library commands do not enter the execution catalogue. All child resolution
uses the same parent plan, source lifetime and per-recipe Knowledge context.
The explicit public `project_id` is hash-bound when nonempty; changing it
requires fresh source review and fences the old grant. Child Project scope is
never inferred from unrelated metadata. Current portable Project categories
retain the existing global-record representation.

The public `run_subrecipe` action uses deterministic child IDs and exact pinned
Library references, forwarding the parent's normalized inputs and Project.
Child creation does not dispatch its work: the caller explicitly claims the
child, and the parent completes only from its actual authoritative terminal
result. The one shared executor enforces family claim/depth/run/deadline budgets
and cancellation; commands and Scripts retain separate fresh effect approval.

Cold verification returns the unchanged authentic parent source alongside its
verified parent/child records. It does not fabricate a child DTO bearing the
parent's hash, restore effect authority, or admit historical embedded children
as a new public grant. Native lazy-run headers retain compiler digests; the
adhoc raw definition/binding digest identifies the adhoc receipt, not that
header. Actual cold public semantic replay requires fresh approval of the same
root plan; interrupted UNKNOWN work remains fenced without additional claims
or effects.

## Focused evidence

`tests/original-mcp-recipe-library.test.mjs` compares genuine original 4.0.22
Python tool responses with the actual original public owner backend under the
signed native attachment and real RootOwner. It reproduces the former command,
Script and ported-branch admission failures, checks that authoring/search emit
no effect review or native run/assignment, compares complete Library search and
errors, and exercises ported branch lifecycle/receipts. Existing execution,
source-policy, historical tamper, native authoring and report suites remain
part of the combined Recipe qualification. This is not installed-profile or
full-original-protocol qualification.

`tests/original-mcp-recipe-authoring.test.mjs` exercises actual public from-Skill,
native-overlay search, required-Knowledge claim/fencing, typed-default replay,
cold source reactivation and the unchanged `inputs_json` opt-in. It distinguishes
Original's one attempt from three explicitly bound native repeat attempts and
reads the typed output through the public result, not a private helper.
Its reachable-source cases also cover canonical/native children, missing exact
pins and either receipt half, current child Knowledge drift, cold verified
records, explicit Project grant replacement and a genuinely authored over-depth
chain. The genuine public parent/child regression remains the orchestration
qualification, separate from these source-component checks. Its actual cold
parent/child case also validates the strict historical reader, matching row
versions, exact compiler digests and common root/actor/source binding after
fresh same-plan reactivation, with no replay of interrupted work.
