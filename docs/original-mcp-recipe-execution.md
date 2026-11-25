# Native Original Recipe execution

The existing `original_mcp_public` Recipe lifecycle uses the real RootOwner's
SQLite, `LegacyRecipeLazyRuntime` and one `WorkflowExecutor`. Library and adhoc
authoring feed the same compiler/source-admission path; execution never falls
back to the archived business engine. Historical reads remain separately
admitted and cannot restart effects.

## Scheduling and results

Static NoOp nodes require explicit caller reports. Native scheduling verifies
their lease, invocation, output shape and receipt, not the caller's external
work. Human gates require the exact explicit input/challenge. Progress preserves
bounded events and observability. Original metadata preserves authored node and
outcome order, dependency selection, bounded feedback loops, and loop history.
History state/results come from Core completion snapshots; progress and ISO
timestamps come from matching, host-owned observations and actual completion
clocks, never guessed completion or replayed effects.

Command and registered Python Script nodes use native source-bound effect
adapters and the existing process service. Every launch needs a **separate**
current native effect decision. Commands receive literal argv without a shell;
Python uses the registered, exactly pinned interpreter and isolated execution.
Approved Knowledge inputs are resolved from the same current source; a source
grant is not an effect, provider, credential or tool grant.

`autonomous:true` drains admitted command/Script chains after authoritative
completion. Lazy execution remains the default. `max_auto_nodes` is 1–1000 and
`max_auto_seconds` is 1–3600. Whole-run claims and a durable deadline cannot be
reset by receipt replay. External reports, human input and subflow child claims
remain explicit boundaries; autonomous feedback loops are explicitly refused.
Failure, cancellation, budget exhaustion or changed authority stops dependent
dispatch. A deadline bounds new launches; it does not authorize signaling an
unowned process.

## Pinned subflows

Original `pkm.subflow/v1` references contain the exact child Recipe ID, revision
and executable digest. Source admission resolves only the reachable closure,
including child Knowledge, under one authentic root plan and current actor,
project, host/session and source witnesses. Missing/revised children and
recursive or over-budget closures are refused before source consent.

The same executor creates a durable child under the current parent invocation.
Inputs/project are copied exactly from the parent, without adding child start
defaults. `run_subrecipe` exposes the pinned child and its current next action;
creation does not launch a child effect or manufacture effect approval. Child
claims use the same public lifecycle and their own exact effect consent. Only
known child terminal completion can complete the parent with
`{child_run_id,child_result}`. An unknown child fences the parent UNKNOWN.

The family shares the root deadline and claim budget, with maximum depth 16,
32 runs and 1000 claims (or the smaller autonomous bound). Waiting polls and
idempotent creation do not consume additional claims. Parent cancellation and
UNKNOWN fence descendants without resurrecting stored process IDs.

## Custody, authority and uncertainty

Canonical Recipe files are admitted by the independent, current RootOwner
source producer; the original control is compared with sealed custody. Exact
bytes, revision, compiled digest, membership, source snapshot and current
Knowledge bindings are rechecked. Definition-only authoring/source
`noExecution:true` does not permit launching anything. Each public lifecycle
request additionally needs its own signed current native approval.

Effect files retain descriptor/ancestor/hash/stat identity and rechecks. Source
files and registries refuse links and group/world writes. An executable may be
owner-writable or writable by the current owner's primary group; its exact
UID/GID/mode/link/hash identity remains pinned. The native prompt explicitly
warns that these pins do not make the executable immutable. There is **no OS
sandbox**, no inherited unrelated credential grant, and no implicit descendant
or arbitrary host-command authority.

Source replacement, actor/owner loss, consent revocation, expiry or session
close fences claimed work UNKNOWN. Late output cannot become authoritative.
Restart does not reenroll autonomous work or replay an unknown launch. Fresh
source admission, reconnect, `next` or semantic start replay cannot reset a
stopped budget or repeat an uncertain effect. Exact command fingerprints,
CAS and durable receipts preserve idempotence; ambiguous acknowledgment is
reported explicitly rather than fabricated success.

`recipe_capabilities` describes this bounded compiler/control slice. Positive
readiness is not execution authority and does not claim full Recipe or
full-original-MCP parity. Arbitrary dynamic providers, inline embedded child
grants and unregistered host commands are not implied.

## Qualification

Focused Linux fixtures use the verified Original 4.0.22 runtime only as an
independent contract oracle. Native execution uses actual signed sockets,
source/effect producers, SQLite leases/receipts and real owned command/Python
processes. Whole affected-file selections cover autonomous chains, public
parent/child scheduling, reports/loops, cancellation, budgets, source changes,
revocation and cold UNKNOWN/no replay. Signer/UI identities are deterministic
test doubles; installed/platform acceptance remains a separate parent gate.
Original source files are never rewritten or relabeled.
