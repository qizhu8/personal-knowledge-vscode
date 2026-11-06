# Idea-to-action traceability contract

Status: definition deliverable for NOTE-TODO-01 Story `note-todo-01-story-01`,
Work Items `note-todo-01-7059ba49b093` (sections 1-8) and
`note-todo-01-b38623f2a881` (section 9). This document defines the first-stage
contract; it does **not** implement new storage fields, tools, navigation or
execution behavior. Existing capabilities and required extensions are separated
below. Completing this definition does not complete the later implementation
milestones or constitute user acceptance.

## 1. Purpose and non-goals

A user must be able to answer both:

- What work is intended to realize this idea, what actually ran, and what evidence
  was retained?
- For this result, which execution produced it, for which Work Item, from which
  idea, and using which recorded method version?

An idea can remain a Note; a Story expresses user value; a Work Item expresses a
bounded work contract. None of these is an executor. A Recipe is an optional
method/workflow definition, an Action is a program-controlled operation, and a
Run is a particular execution. A successful tool call, successful submission,
completed Run, reported task result and accepted deliverable are different facts.

This contract adds no scheduler, execution permission, automatic completion,
LLM-inferred association, automatic method promotion or second execution database.
Manual work and direct Actions are valid; neither a Project nor a Recipe is a
mandatory intermediate node.

## 2. Existing authority and gaps

| Existing source | Already provides | Not provided by that source |
| --- | --- | --- |
| [Knowledge contracts](../../src/knowledge/knowledge-contracts.ts) | `knowledgeId`, revision, typed aliases; `KnowledgeLinkV1` with relation, canonical target, floating/pinned mode | Work Item, Run or artifact targets in that link schema |
| [Derived link graph](../../src/knowledge/link-graph.ts) | Derived forward/backlinks; scope checks, pin mismatch, cycles and traversal budgets | A durable general graph store or Todo-to-Run adapter |
| [Work Items](../note-work-items.md) | Local stable item ID, Story parent, Project reference, string `links`, evidence, verification, generated audit | Typed/resolved Run associations or automatic validation of evidence |
| [Project Cockpit](./project-cockpit.md) | Explicit Project execution links and projections from original records | Proof that a Project's Run executed a particular Work Item |
| [Recipe model](../../src/workflows/project-model.ts) and [runtime](../../resources/recipe_runtime.py) | Definition identity/revision/digest; Run's pinned definition, `recipeRevision`, `executableDigest` | Proof of a Todo association when none was recorded |
| [Action runtime](../../resources/action_runtime.py) and [Run store](../../resources/action_run_store.py) | Run identity, Action ID, content hash and execution receipts/contracts | Proof that a successful invocation completed a remote job or user's goal |
| [Workflow values](../../src/workflows/value-contracts.ts) | Artifact reference `{evidenceId, digest}` | Permission to read the bytes or certification of their meaning |

Reuse these contracts and adapters. In particular, do not introduce new
knowledge IDs, duplicate backlinks as authoritative writes, replace Recipe
methodology, or treat existing Work Item `links: string[]` as structured
`KnowledgeLinkV1[]`. These are different fields on different objects.

## 3. Identity, locator and revision

All references are scoped to one explicitly selected knowledge root. No absolute
root path, credential, worker token, capability hash or execution-resume secret
belongs in a portable reference. Cross-root federation is out of scope.

| Entity | Identity within that root | Version/fact authority |
| --- | --- | --- |
| Idea Note, Skill, Research | Existing `knowledgeId`; `pkm://knowledge/<knowledgeId>` is a contract URI, not a promise of browser routing | Knowledge revision; exact retained content/hash if available |
| Story or task | Owning Note/Board `knowledgeId` **and** local `id` | Board digest or legacy Markdown digest for CAS; item audit/result for facts |
| Recipe definition | `recipeId`, mapped to existing `knowledgeId` where available | `revision`, `executableDigest`; separately `methodologyDigest` if recording methodology use |
| Recipe execution | `runId` | Run's `recipeId`, `recipeRevision`, `executableDigest`, pinned definition and node attempts |
| Action definition/execution | Definition `action_id`; execution `run_id` | Execution's recorded `content_hash`/contract, not today's definition |
| Chat/Task execution | Chat namespace + Chat ID; explicit Session ID and attempt/input identity where present | Recorded ownership/attempt receipts, not latest Chat title or latest response |
| Evidence artifact | Producer execution + `evidenceId` (or native artifact ID) + digest | Producer receipt and exact bytes/retained revision; absent digest means unverified content |

A locator is not identity. Existing `pkm://notes/<encoded/path>.md` URLs from
[navigation paths](../../src/ui/navigation-path.ts) are share/open locators.
Keep them as optional display/navigation hints, never use a same-name path as a
replacement for a missing ID. Legacy objects without a stable identity remain
unverified until explicit supported migration/identity establishment; reading
must not silently mutate them.

Document identity plus item ID avoids collisions across Boards. Note moves and
renames can resolve through retained identity/aliases; do not assume every
filesystem operation maintains them. A deliberate item move/copy needs a
recorded identity mapping. A copy/import with conflicting identities fails
explicitly until reconciled, rather than merging unrelated work.

Definition revision and execution observation version are different. Pinning a
Run identifies an evolving execution, not immutable final output. Report its
observed version/time. To cite an exact result, pin the artifact digest or a
retained execution receipt. A digest without retrievable historical content does
not imply an old version can be restored.

## 4. Relation vocabulary and ownership

Directions below are canonical; the reverse direction is a derived query. Each
relation can be absent, and each target can be reused by multiple work items.
Local Story parentage remains the sole single-parent exception.

| Relation (source -> target) | Meaning | Canonical owner |
| --- | --- | --- |
| `originates-from`: Story/task -> idea Note | Explicit rationale/source; not inferred from similar text | Source Story/task |
| `part-of`: task -> Story | Existing same-document `parentId`, at most one | Task; change only through permitted parent operation |
| `uses-method`: task -> Skill/Recipe definition | Declared method selection; alone does not prove execution | Task |
| `has-execution`: task -> Run or explicit Session attempt | Explicit association; distinguish user/agent declaration from verified execution binding | Task association plus referenced executor receipt, if one exists |
| `instantiates`: Run -> definition/version | Actual definition used by that execution | Original Run record only |
| `produces`: Run -> artifact | Actual recorded producer, not an arbitrary attached file | Producer receipt only |
| `cites-evidence`: task -> artifact/retained receipt | Submitted supporting, contradicting or inconclusive evidence | Task report; producer/content still resolved independently |

`dependsOn` remains a local scheduling/work dependency, not `originates-from`.
Project membership groups work; it does not create `has-execution` edges.
Tool/MCP calls are not automatically Action Runs. Nested Recipe/Action Runs are
traversed only when their original records establish ownership.

No cardinality imposes one Recipe or one Run per task. Retries and failed/Unsure
attempts remain distinct; do not overwrite their relations with the last success.
One Run may serve several tasks only through explicit separate associations.
Evidence can contradict a result: attaching it never changes outcome/acceptance.

### Normalized read contract (future adapter, not persisted v1 input)

An adapter should expose each edge as:

```json
{
  "relation": "has-execution",
  "source": {
    "kind": "workitem",
    "documentKnowledgeId": "knowledge_aaaaaaaaaaaaaaaaaaaaaaaa",
    "id": "verify-health"
  },
  "target": {
    "kind": "action-run",
    "id": "action_run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "binding": "declared",
  "resolution": "unverified",
  "provenance": {
    "owner": "source-workitem",
    "actorId": "mcp:external",
    "recordedAt": "2026-11-04T22:00:00Z"
  }
}
```

`binding` is `declared` or `recorded-execution`: the latter requires a matching
executor-owned receipt. `resolution` describes target verification separately
from business success. A declared link to a valid Run can be `resolved` without
claiming the executor recorded task ownership.

Reference kinds must use their original validators; IDs and versions above are
illustrative, not evidence that these objects exist. Do not feed this envelope
to current Work Item or Knowledge link writers: their validators reject unknown
fields/targets.

## 5. Resolution, privacy and lifecycle

Resolution is read-time, scope-checked and bounded:

1. Validate source and requested relation; authenticate and authorize source read.
2. Resolve target identity within the selected root, using the target's native
   reader and authorization. Do not open arbitrary paths supplied in a locator.
3. Distinguish `resolved`, `unverified` (insufficient identity/version/content
   evidence), `unsupported`, `unavailable`, `trashed`, `version-mismatch` and
   `ambiguous`. These statuses are requirements for a future adapter, not today's
   exported enums. Keep executor outcome and task acceptance separate.
4. An unauthorized caller gets only generic `unavailable`; do not expose hidden
   title, path, ID, version, existence, visibility class or reverse-link counts.
   Missing versus denied must not be an existence oracle. Lifecycle-specific
   diagnostics are available only when the caller can inspect that lifecycle.
5. Return target observation time/version and provenance only in authorized scope.
   Resolver failure is an explicit error/diagnostic, never an empty success.

Floating references intentionally observe a current definition for browsing.
Pinned use/evidence references require the exact recorded revision/digest. A
missing old revision is `version-mismatch` or `unverified`, never a silent upgrade
to current. Pinning knowledge does not imply the Run used that version.

Trash/delete does not remove source audit. Soft restore reuses the same identity;
permanent deletion leaves an authorized unavailable reference. Unlink appends an
audited removal without deleting original Run/artifact/history. Retained old
snapshots do not bypass current permissions or justify automatic resumption.
Changing privacy revokes derived access immediately; cached edges are not grants.

## 6. Write, concurrency and reverse-query contract

Current writers remain authoritative. Future structured task relations belong
with their source task, not in a second central graph database:

- Extend/version the existing task schema, codecs, native/MCP contract and UI
  together before enabling typed relation writes. Preserve legacy string links
  byte-for-byte; never reinterpret or migrate them by guessing.
- Reuse existing canonical Knowledge links for already supported knowledge
  targets, `parentId` for Story membership, and original Run/artifact fields.
  Add an adapter for task/Run edges; today's `DerivedLinkGraph` does not accept
  these kinds. Derive forward/reverse indexes from authorized canonical owners.
- Adding/removing a relation requires source-owner permission, expected digest
  and reason; generate actor/time server-side. Workers cannot acquire contract,
  parent, reviewer or acceptance rights through a new relation API.
- Validate target type, accessible identity and any supplied pin before a new
  structured association; unverified legacy links remain visible as such.
  Failed validation leaves source bytes untouched. Target can change immediately
  after validation: this is not a cross-store transaction; revalidate on read/use.
- Duplicate exact adds are set-idempotent under a fresh digest; stale CAS fails
  even for a duplicate. Compare normalized relation/source/target/pin/binding,
  not display title. Reads never claim work or mutate links.
- Source mutations invalidate derived indexes. Reverse queries must expose
  owner digest/index revision and completeness; a stale/incomplete index is not
  proof of "no related work." No unbounded full-root scan or model maintenance
  loop should run on each render.

Proposed logical operations are **list relations**, **resolve reference**,
**add relation**, **remove relation**; they are not currently callable MCP names.
Prefer extending the existing categorized Todo APIs/capability registry over
parallel generic file writers. Query inputs need one source/target, direction
(`forward`/`backlink`), relation filters and a bounded limit (default 20, max 100).
Traversal is explicitly bounded (default depth 1, max depth 3, max 100 nodes and
200 edges); cycles use a visited set. Further traversal is a new bounded query,
not an implicit complete-graph result.

Results need edges, authorized resolution/provenance, owner digests, snapshot
identity, diagnostics and `truncated`/continuation. Cursor use must pin that
snapshot; changed owners or permissions invalidate it explicitly. Counts cover
visible results only. Native UI must distinguish unsupported/partial results
from verified empty results, and stale responses cannot overwrite a new target.
These limits define future reads, not execution budgets.

## 7. Worked examples and failure cases

These are specification examples, not executions or acceptance-test receipts.

### Forward and reverse

Idea Note A describes "verify a deployment before sharing it." Story S cites A.
Task W is `part-of` S and `originates-from` A, declares `uses-method` Recipe R
revision 3/digest H3, and explicitly associates Recipe Run X.
X records R revision 3/H3 and its pinned definition. X records child Action Run
Y; Y records its own Action definition hash and produces artifact E/digest HE.
W cites E and reports its own outcome with separate verification.

Forward inspection A -> backlinks of `originates-from` -> S/W -> execution X
-> recorded child Y -> E explains intended work and retained result.
Reverse inspection E -> producer Y -> recorded parent X -> backlinks of
`has-execution` -> W -> S/A explains provenance. If X does not record W, label
that association declared, even if a human selected the correct Run.
The Project's ownership/linking context is optional and cannot fill missing edges.

### Required counterexamples

| Case | Required answer/behavior |
| --- | --- |
| Direct Action, no Recipe | W -> Action Run Y -> E is valid; no synthetic Recipe |
| Manual work | W cites a document revision/digest; no fabricated Run/producer |
| Failed Run X1, successful retry X2 | Retain both attempts and their outcomes; evidence/acceptance evaluated separately |
| Run completed, result Unsure | Show both facts; do not turn task into Success |
| Recipe now revision 4 | X remains revision 3/H3; no rebinding or execution of revision 4 |
| Pinned content unavailable | Explicit version/content diagnostic, not current-content substitution |
| Note renamed | Resolve retained knowledge identity/aliases; stale path is only a locator hint |
| Same task ID in two Boards | Resolve document ID + item ID; no cross-Board collision |
| Missing/Trash/private target | Retain source audit; scope-safe diagnostic; no hidden metadata or auto-repair |
| Uncertain external side effect | Link original Run and reconciliation evidence; no blind retry |
| Cancelled/accepted/reopened task | Preserve prior provenance; reopening is explicit and does not erase evidence |
| Conflicting CAS/expired cursor | Reject, reload/reconcile; no automatic retry of mutations |
| Partial reverse index | Show partial/truncated/stale status; never certify no incoming edges |

## 8. Delivery and follow-on gates

The definition is complete when the authority/identity mapping, relation
vocabulary, version/privacy/lifecycle/concurrency rules and forward/reverse
counterexamples above are reviewable. It does not require adding runtime fields.

Later implementation work is separately scoped:

1. Extend the existing task codecs and categorized APIs with compatible typed
   relations; preserve old clients/legacy data, enforce source authority/CAS.
2. Add bounded, scope-safe task/Run adapters and derived reverse queries,
   including current-state/version and index-completeness diagnostics.
3. Wire Story/Work Item details and exact-target navigation using existing
   routes; do not advertise unresolved contract URIs as working deep links.
4. Verify schema/identity/pin rules, real MCP CAS/negative cases, browser
   navigation, and installed/reloaded behavior as separate layers. Record
   not-run honestly; existing graph/integration tests are not feature E2E.

No later task is auto-created or auto-started by this document. The original
Story's method-concept boundary is a separate definition deliverable; it must
not become a runtime prerequisite for this traceability chain.

## 9. Mindset, Framework and Paradigm

These are PKM working definitions for describing reusable knowledge, not a
universal philosophical taxonomy, new runtime object kinds or a hierarchy every
task must instantiate. Their boundaries answer different questions:

| Term | Question and meaning | Example | Not equivalent to |
| --- | --- | --- | --- |
| Mindset | How should we reason and judge under uncertainty? Reusable principles and habits | "Seek disconfirming evidence; distinguish reported results from acceptance" | A task plan, hidden reasoning, executable steps or permission |
| Framework | How do we organize this class of problem? A reusable decomposition with roles, phases, inputs, outputs and decision gates | "Form a hypothesis, define a measurement, run a controlled check, review the result" | A necessarily runnable Recipe or proof those phases occurred |
| Paradigm | Which underlying model/assumptions make the problem and evidence meaningful? A lens with applicability limits and alternatives | "Treat diagnosis as hypothesis testing rather than similarity-based guessing" | A mandatory global policy, an approved truth or a runtime engine |
| Recipe | Which explicit reusable workflow/definition could operationalize a method? | A versioned health-validation workflow with inputs, nodes and gates | Its execution or the user's task |
| Action | Which registered program-controlled operation is available? | An operation that requests and validates a health response | An arbitrary model tool call or the remote service's completion |
| Run | What actually executed this time? | Recipe Run X or Action Run Y with recorded definition/version and receipts | The method definition, intended plan or accepted Work Item |

### Representation and translation

Mindset/Framework/Paradigm content can be ordinary versioned Notes or Skills,
identified by the existing Knowledge identity and linked as reference material.
No new folder, required tag, enum, schema or store is necessary. A document can
contain several of these roles, but should label which statement is a principle,
structural method or assumption. Classification is explicit, never inferred
from prose as an authorization or completion decision.

The existing [Recipe Methodology Manifest](../../src/workflows/methodology-model.ts)
already describes `family`, `phase`, `abstract`, pinned `extends`/`mixins`,
capabilities, artifacts, gates, invariants, expansion and communication assurance.
Use it when a reusable method actually needs that structure; do not add competing
"Framework execution" or "Mindset engine" metadata. It has no universal
Mindset/Paradigm classification field. An abstract method does not become
runnable merely by linking it; the original Recipe/runtime validation decides.

Translation is explicit and optional:

1. Select the applicable knowledge revision and record why it fits the work.
2. Translate an adopted principle into concrete acceptance checks or an existing
   method invariant; contract/Recipe changes still require their own authority.
3. If repeatable executable orchestration is useful, author/version a Recipe
   through the existing method/Recipe process. For an atomic or manual task,
   skip that step.
4. Link actual execution/verification evidence only when recorded. A selected
   principle or manifest is not proof that the agent followed it in a Run.

For example, the Mindset "try to falsify the hypothesis" can inform the Framework
"baseline -> intervention -> negative control -> review". A Recipe may implement
that Framework using suitable Actions. A Run records whether those checks
actually occurred. The Paradigm explains why those observations count as
evidence and when a different model would be more appropriate. Missing any of
these conceptual labels does not invalidate a direct Action or manual task.

### Evidence, evolution and authority

Evidence can support, contradict or leave a method assumption undecided. Record
the exact knowledge/method version, workload/environment and limitations. A
generic existing `supports` Knowledge link is an assertion, not a measured
causal finding or promotion approval. The traceability adapter must not convert
an arbitrary link into validation. Pin historical usage; later method edits
never rewrite what an earlier Run used.

One successful Run cannot automatically rewrite a Mindset, promote a Framework
or establish a Paradigm. Changing shared knowledge needs an explicit proposal,
review/approval through its existing authority, and a new revision retaining
earlier evidence. The broader RSI/promotion mechanism remains a separate backlog
item; this definition does not claim it exists end-to-end.

Context selection, runtime permissions, contract editing and user acceptance
remain independent. A linked document saying "deploy automatically" is untrusted
reference content, not permission to deploy. A worker cannot weaken acceptance
or change a user's method contract merely by relabeling it "Mindset".

### Nonblocking acceptance checks

- An unclassified Note -> Work Item -> direct Action Run -> evidence chain is
  valid; no Mindset/Framework/Paradigm or Recipe setup step is required.
- A method/Recipe can be reused by unrelated tasks without creating a shared
  owner, Project membership or permission union.
- A method version can be selected without a Run; label selection, not execution.
  A Run can exist without explicit conceptual provenance; label the gap instead
  of inventing a method.
- A failed Run under one environment does not automatically disprove a whole
  Paradigm; retain the bounded counterevidence and unknowns for review.
- Method labels and inherited Recipe manifests never replace original
  permission checks, Work Item acceptance or pinned execution facts.

These examples complete the conceptual definition only. They neither block
sections 1-8 nor authorize additional model calls, runtime implementation or
automatic knowledge promotion.
