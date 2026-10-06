# Automation and Recipe Design

Status: reviewed design target with an implemented-capability baseline. The runtime accepts `pkm.workflow.definition/v1`, including outcome branches, bounded loop edges and pinned subflows. The open-world exploration graph and unified Todo execution model below remain proposals; they must not be exposed as executable before their compiler, reducer and safety tests exist.

## Goals and operating principles

The purpose is to preserve the user's goal and unfinished work while moving reliable execution and working material out of model context. Recovery is an optional operation, not the reason every Session exists.

- **Session** owns the original goal, current constraints, ordered commitments and unresolved work. A compact turn reminder prevents a local subtask from replacing the overall goal. Read-only multi-step work is included; quick answers and trivial commands are not.
- **Recipe** is a reusable, verified solution or useful task structure, not merely a guardrail. A mature linear Recipe is valid. A task may remain serial and use native tools when no qualified Recipe or useful decomposition exists.
- **Runtime** owns deterministic progression, Script execution, bounds, validation and evidence. A reliable automated path should require no model-driven polling or per-node management.
- **Agent** handles uncertainty and judgment using the smallest sufficient task context. A stronger model or multiple workers are options, not mandatory overhead for every task.
- **PKM working material** separates mutable drafts from immutable attempt evidence. Prompts reference relevant artifacts and fetch selected content; they do not carry the entire conversation, graph or history.
- **Scene preservation** through checkpoints or Snapshots happens only on an explicit preservation, recovery or handoff operation. Routine success, failure and turn boundaries do not trigger conversation copies. Durable goal, task and result records still persist normally.
- **Failure** is an evidence-bearing outcome. Its cause and next decision are separate; neither uncertainty nor a failed attempt justifies silently discarding the user goal.

## Implemented baseline and gaps

The baseline is grounded in `resources/agent_session_runtime.py`, `resources/recipe_runtime.py` and their MCP runtime tests. This table describes executable behavior, not roadmap promises.

| Area | Implemented | Remaining target |
| --- | --- | --- |
| Session | Persisted task, FIFO Todos, explicit redirects, compact responses, optional checkpoints and Snapshots | Versioned goal/constraint envelope and a smaller frontier reminder |
| Recipe | Pinned identity, lazy claims, outcome dependencies, bounded loops, subflows, knowledge references | Open-world candidate admission and deterministic append-only replay |
| Automation | Opt-in, bounded, serial command/Script progression driven by worker completion; native allowlist and human gates | Automatic native/subflow progression, loop support and terminal/blocker notifications |
| Ownership | File-locked mutations, command receipts, one running node per Run | Multiple independently leased workers, fencing and conflict-aware parallel admission |
| Failure | Node outcomes/results and run-health classification | Policy-driven retry, escalation, replacement Recipe and independent-branch continuation |
| Cost | Compact projections; measured, estimated and unknown usage distinguished | Batched lifecycle transitions, bounded worker context and model capability routing |

The capability flag `dynamic_v2` currently advertises the runtime's existing controls; it does not mean an open-world `pkm.workflow.definition/v2` exploration engine exists. Background processes are not a multi-Agent scheduler, and Session liveness is not a per-node worker lease.

## Execution and context contracts

These are infrastructure targets, not additional tools already available to Agents.

### Goal continuity and low-roundtrip lifecycle

Persist a versioned goal envelope: goal, constraints, acceptance criteria, user-directed changes, current commitment, unresolved frontier and artifact references. New instructions update this envelope explicitly without dropping earlier compatible commitments. Queue order is execution order, not proof of a logical dependency.

The default turn response should contain only the goal/constraint revision, current task, unresolved counts, blocker or next action and selected references. Fetch full history only for a specific investigation. It must not echo historical receipts, drafts or conversation summaries on every call.

A future atomic begin operation should validate and persist the initial plan and claim its first Todo in one transaction. A completion operation should validate the claimed attempt, commit its result and return the next eligible commitment, or finish the Session, in one transaction. Caller command IDs make retries safe; parameter mismatch must reject reuse. With one begin and one report per Todo, an uninterrupted N-Todo lifecycle targets N+1 calls rather than the current 3+2N. Turns, human decisions and explicit preservation add calls separately.

### Autonomous automation

Recipe runtime 1.8.0 implements the first slice. `recipe_run_start` and `recipe_run_start_adhoc` accept `autonomous=True`; the default remains lazy execution and preserves existing default command fingerprints. Each command/Script worker persists its result and, under the Run lock, launches the next eligible command/Script without Agent polling or per-node claims. The start response contains a Run reference; `recipe_run_get` is optional inspection, not the progression driver.

`max_auto_nodes` defaults to 100 (range 1-1000) and `max_auto_seconds` to 300 (range 1-3600). Node timeouts are clamped to the remaining Run wall budget. Cancellation through `recipe_run_progress(..., progress_json='{"cancellationRequested":true}')` terminates the active command and prevents subsequent launches. Failure or exhausted budgets stop the chain. Human gates wait for `recipe_run_submit_input`; Agent, native and subflow nodes remain explicit adapter boundaries. Agent reporting, human submission and explicit native execution resume eligible automation. A subflow child stays lazy; after explicitly completing it, call `recipe_run_next` on the parent to reconcile and resume automation. Autonomous loop definitions are rejected; lazy bounded loops remain supported.

Launch intent is persisted before process creation. Worker completion checks the attempt and result identity under the Run lock. If completion was interrupted, `recipe_run_next` reconciles an existing result; an uncertain launch remains `reconciliation-required` and is not automatically repeated. This prevents blind relaunches, but is not a general exactly-once guarantee for arbitrary external side effects. Acceptance commands/Scripts must verify their declared outputs. No general output-validation engine, persistent scheduler daemon, parallel Agent ownership or host push notification is added in this slice.

The remaining target is broader automation:

After input validation and authorization, a durable scheduler should drain ready command, Script and allowlisted native nodes, verify declared outputs and persist receipts. It stops at an Agent task, human gate, unsupported capability, terminal outcome or budget boundary. The Agent receives a job reference and a terminal/blocker notification, not an instruction to poll every Script node.

Recovery reconciles existing process/attempt identities and output receipts before launching work again. Side effects require an idempotency contract or explicit reconciliation; a crash must never be treated as proof that an action did not run. Cancellation, timeout, privacy and environment pins remain enforced while no Agent is attached.

### Optional heterogeneous workers

Each work item has a bounded envelope: goal/constraint revision, input references, expected output schema, acceptance check, capability requirements, privacy boundary, cost/attempt/time budget and isolated write scope. Shared artifacts use content identity and explicit revision checks. Workers do not inherit the parent conversation or unrelated evidence by default.

Independent ready work may be claimed by separate ad hoc Agent processes. A claim records worker identity, attempt identity, lease expiry and a fencing token. Result submission checks that ownership and the pinned contract still match; a stale worker cannot commit over a successor. Lease expiry alone does not authorize repeating unknown side effects. Overlapping writes serialize or use isolated workspaces with a verified merge.

Choose a smaller model only when its capabilities satisfy the task contract and the output has an independent acceptance check. Escalate within an explicit budget after classified failure or unresolved uncertainty. Serial execution and a strong model remain valid for tightly coupled, poorly specified or non-decomposable work. The parent retains responsibility for integration and overall acceptance.

## Failure outcomes and follow-up decisions

Every attempt records its pinned Recipe/node identity, executor, input references, observed outcome, evidence references, acceptance result and remaining budget. Failed evidence is immutable; a retry or replacement creates a new attempt linked to its predecessor. Draft plans may change, but prior receipts do not.

Classify the cause separately from the decision. Prefer the existing health categories (`environment-failure`, `input-failure`, `implementation-failure`, `recipe-friction`, `recipe-failure`); add an explicit unresolved/unknown classification when evidence is insufficient. These categories must not be treated as a proven causal diagnosis from a model's assertion alone.

Permitted follow-up decisions are bounded retry, capability/model escalation, a new or revised pinned Recipe, user judgment, or record-and-continue. Record-and-continue only unlocks nodes whose declared predicates accept the observed outcome, or independent work with satisfied prerequisites. It does not manufacture a missing successful output. Overall completion still requires all required acceptance criteria; an acknowledged partial result is not full success.

The runtime, not an Agent's repeated narration, enforces attempt/cost/time ceilings and records the decision, actor and reason. A failed attempt may remain terminal while the owning goal continues through a different strategy. Recipe evolution produces a reviewable new revision and never retroactively rewrites the failed Run.

## Product model

```text
Automation
├── Agent Sessions
│   └── Task (Project association is optional)
│       └── Todo Technology Tree
│           └── Project Root (or virtual Ad-hoc Work root)
│               └── Recipe Expansion (pinned revision and digest)
│                   └── Todo
│                       ├── Attempt / Evidence
│                       ├── Decision / Handoff event
│                       └── Recipe Expansion → child Todos
└── Recipe Library
    └── CatTree category
        └── Recipe (Private or shared)
```

- An Agent Session owns execution and may contain multiple Tasks.
- A Task may be ad-hoc or associated with one Project. The Project reference anchors that Task's Todo tree and supplies context; it does not own the Agent Session.
- A Recipe is an immutable, reusable workflow definition. Editing creates a revision.
- Each Recipe Expansion pins `recipeId`, `revision`, and `executableDigest`. It never silently follows later edits.
- A Recipe Step is an authored Todo template. Expanding a Recipe materializes its Steps as child Todo nodes and records their unlock edges.
- The primary execution visualization is a technology tree. A Project is the root node; applying a Recipe to a node expands the next layer of Todo nodes. Any Todo may bind another Recipe and recursively expand another layer.
- An ad-hoc Task uses a clearly labeled virtual `Ad-hoc Work` root. This preserves the same tree mechanics without inventing a persisted Project association.
- Scope, category, and privacy are independent. Scope controls where a Recipe may be used; category controls its CatTree path; privacy controls disclosure.

## Unified Todo execution infrastructure

Project Todos and Agent Todos are not separate workflow systems. Both are projections over one persisted `TodoExecution` graph:

- `executionId`, Project association or ad-hoc root, and owning Task identify the execution.
- pinned Recipe expansions record where each Todo layer came from.
- Todo nodes carry dependency predicates, state, attempts, result/evidence references, and current Agent ownership.
- assignment/handoff events change ownership without moving or cloning the Todo.
- aggregate counts (`complete`, `remaining`, `blocked`, `failed`) are reduced from node state, never maintained as independent counters.

The **Project projection** filters executions by `projectId` and shows every Agent working in that Project, each current Todo, completed/remaining counts, and the complete technology tree. The **Agent projection** filters the same executions by `agentId` and emphasizes that Agent's current frontier, activity, evidence, and decisions. Opening the same `executionId` from either surface must show the same Recipe pins, node state, progress, and results.

Product terminology follows this model: a Recipe is a reusable definition; a Todo Execution is one materialized graph; a Todo is one executable node. Project navigation therefore uses `Todos` with `Todos | Recipes` subviews. Legacy `Workflows` and `Runs` routes migrate to `Todos`; they are not parallel concepts.

Raft is not the workflow or UI model. If multi-process writers later require consensus, Raft may replicate the append-only execution log, elect a command leader, and fence stale writers. The reducer still derives one canonical Todo graph from committed events, and both UI projections still query that graph. A standalone installation does not need distributed consensus merely to render or execute the technology tree.

## Definition and run graph

Static DAGs are insufficient for Agent work because the number and shape of possible approaches may not be known before execution. v2 therefore separates two graphs:

1. **Recipe Definition Graph**: immutable authored policy. It declares static Steps, control nodes, budgets, success predicates, and takeover policy.
2. **Recipe Run Graph**: append-only execution expansion. It records every runtime-generated candidate branch, nested expansion, attempt, result, prune, backtrack, and handoff.

The Recipe digest covers the Definition Graph, including the exploration policy. It does not pretend to cover branches that do not exist yet. Each generated branch is canonicalized and content-addressed when admitted to a Run. The Run records both the Recipe digest and a hash chain over expansion events.

This preserves two necessary truths: the policy is reproducible, while the search space is open-world.

## Control nodes

Workflow Definition v2 should support these control forms without encoding them as ordinary Steps:

- `sequence`: execute children in order.
- `decision`: select among a finite authored set using a typed predicate.
- `loop`: repeat a body with an explicit condition and hard iteration budget.
- `explore`: generate an unknown number of candidate branches at runtime and search them.
- `step`: perform domain work and emit typed outputs.

Cycles remain illegal in the raw graph. A loop is a structured control node with bounded runtime expansion, not a graph back-edge. This keeps compilation and visualization tractable.

## Dynamic exploration

The revolutionary primitive is `explore`: for example, “think of all plausible solution approaches, then try them in probability order.” Its output arity is variable and may grow during execution.

An exploration policy declares:

```json
{
  "kind": "pkm.control.explore/v2",
  "config": {
    "generator": "agent",
    "traversal": "probability-ordered-depth-first",
    "success": { "predicateRef": "solution.accepted" },
    "stop": "first-success",
    "budgets": {
      "maxCandidates": 20,
      "maxDepth": 6,
      "maxAttempts": 40,
      "maxWallTimeSeconds": 1800
    },
    "onExhausted": { "takeover": "user" }
  }
}
```

The Agent emits one or more sealed proposal batches. Every admitted candidate has:

```json
{
  "candidateId": "candidate_<run-local-id>",
  "parentCandidateId": null,
  "label": "Inspect the event ordering path",
  "estimatedSuccessProbability": 0.62,
  "dedupeKey": "sha256:<canonical-approach-hash>",
  "plan": {},
  "successPredicateRef": "solution.accepted",
  "proposedBy": "agent:<identity>",
  "proposedAt": "<timestamp>"
}
```

`estimatedSuccessProbability` is an Agent estimate in $[0,1]$, not a promise or a requirement that an open-world candidate set sum to 1. Ties use canonical `candidateId` order. The score, rationale evidence, model identity, and prompt/template identity are retained so ranking is inspectable without storing hidden chain-of-thought.

### Traversal semantics

1. Validate and deduplicate a proposal batch before it enters the frontier.
2. Sort untried siblings by descending estimated success probability.
3. Start the highest-ranked sibling and recursively exhaust its descendants before trying the next sibling: depth-first search.
4. A succeeded candidate ends the exploration when `stop` is `first-success`.
5. A failed candidate records its evidence and backtracks to the nearest parent with an untried candidate.
6. New candidates may be appended at runtime. They never reorder attempted history. On return to their parent, all currently untried siblings are ranked again.
7. A candidate may be pruned only with a structured reason: duplicate, predicate-impossible, policy-blocked, superseded, invalid, or budget-exceeded.
8. Exhaustion occurs only when the frontier is empty or a hard budget is reached. It invokes the configured takeover policy.

Probability ordering is local to siblings. It is deliberately not best-first search: once DFS enters a branch, it explores that branch deeply before returning. A future strategy registry may add best-first or beam search without changing the event model.

### Dynamic output contract

An `explore` node has a stable authored output named `result`, but its Run Graph has variable child outputs:

- `candidates[]`: append-only candidate descriptors.
- `selectedCandidateId`: the candidate whose success predicate passed.
- `result`: the selected candidate's typed result.
- `searchSummary`: counts, budget use, terminal reason, and handoff state.

Downstream Steps depend on the stable `result`, not on a statically named candidate edge. This lets a Recipe consume a successful answer without knowing how many branches produced it.

## Events and replay

The Run is reconstructed from append-only events such as:

- `exploration.started`
- `candidate.batch-proposed`
- `candidate.admitted`
- `candidate.started`
- `candidate.child-expanded`
- `candidate.succeeded`
- `candidate.failed`
- `candidate.pruned`
- `search.backtracked`
- `exploration.exhausted`
- `takeover.requested`
- `takeover.accepted`
- `takeover.resolved`

Each event includes `runId`, `stepRunId`, monotonic sequence, actor, timestamp, causation ID, previous-event hash, and redacted evidence references. Commands are idempotent. Replaying the same accepted events must reconstruct the same frontier and selected result.

## Failure and takeover

Failure policy is authored at Recipe level and may be overridden by a Step or control node:

1. Retry the same candidate within its attempt policy.
2. Backtrack and try the next candidate when the failure is branch-local.
3. Ask an Agent to take over when a different Agent capability or fresh proposal generation is appropriate.
4. Ask the user to take over for judgment, approval, credentials, unsafe actions, or exhausted search.
5. Fail the Recipe Run only when policy says no takeover is available or an accepted handoff is unresolved past its deadline.

A handoff names the current owner, requested owner kind (`user` or `agent`), reason, supplied artifacts, expected result schema, acceptance predicate, and resume location. Requesting takeover pauses that branch; it does not imply acceptance. The dashboard must show who owns the next action and why execution is waiting.

## Safety and bounds

Dynamic does not mean unbounded. Every `explore` and `loop` node requires hard limits. Runtime also enforces workspace-level ceilings for depth, candidates, attempts, tokens/cost, wall time, concurrent branches, and generated artifact size. The stricter limit wins.

Side-effecting candidate actions require declared capabilities and idempotency keys. User approval remains mandatory where platform policy requires it. Private Recipe definitions, candidate plans, and evidence must not cross their privacy boundary through Agent prompts, logs, exports, or shared subscriptions.

## Recipe resolution and recursive nesting

A Recipe is not selected from category alone. Whenever a Project root or Todo needs decomposition, the Agent follows one explicit resolution protocol:

1. **Classify** the problem into one or more CatTree categories and emit a structured task contract: goal, typed inputs, required outputs, constraints, capabilities, risk level, and privacy boundary.
2. **Retrieve** candidates from the accessible Project scope, global library, and allowed subscriptions. Search covers category path, name, description, tags, declared input/output schemas, capabilities, and Step/control-node metadata.
3. **Qualify** every candidate against hard constraints. Inputs must be satisfiable, outputs must cover the requested result, required capabilities must be available, privacy and scope must permit use, and the schema/runtime version must be supported. A category or text match alone is never sufficient.
4. **Rank** qualified candidates by contract coverage, category specificity, Project-local preference, verified success evidence, recency of the pinned revision, and estimated execution cost. Ranking factors and rejection reasons are recorded; confidence never bypasses hard qualification.
5. **Bind** the selected exact `recipeId`, revision, and digest to the owning root or Todo, then materialize its child Todos.
6. If there is **no qualified match**, keep the Todo in native execution when no reusable solution or useful structure is needed. Otherwise enter **Recipe Design** with the unresolved contract and rejected candidates as evidence. Compile and validate an ad hoc draft, then pin it before expansion. Publishing a stable reusable solution to the Library is a separate explicit action; do not force a one-node noop Recipe just to track work.

Recipe Design is a system bootstrap operation, not an endlessly recursive lookup. It may itself use a pinned built-in design Recipe, but failure to resolve that Recipe falls back to a fixed host protocol that gathers the contract, authors the graph, compiles it, runs validation, and requests approval where required.

Every resolution appends a `recipe.resolution.started` event followed by candidate/rejection evidence and exactly one terminal event: `recipe.bound`, `recipe.design.requested`, `recipe.native.selected`, or `recipe.resolution.failed`. The target Run Graph records the parent Todo, classification, query/index revision, chosen or rejected identities, binding depth, and pinned executable identity when a binding exists.

Recursive expansion is allowed; recursive definition identity is bounded. Before binding, the runtime checks the active ancestor chain. The same executable digest may not appear again on that chain unless the parent definition declares a bounded recursive call with decreasing typed measure and maximum depth. Workspace depth and expansion budgets still apply. This prevents `A → B → A` and self-binding loops while allowing deliberate bounded recursion.

Search outcomes are `qualified-match`, `ambiguous`, or `no-qualified-match`. Ambiguous high-ranked candidates require a declared tie-break policy or Agent/user decision; the runtime must not silently select one. Search is ACL-aware before ranking so private metadata is not leaked through result counts, rejection explanations, or embeddings.

### Step knowledge bindings

Every Recipe node may bind zero or more Skills and Notes. A binding contains a stable `bindingId`, `kind` (`skill` or `note`), canonical PKM `knowledgeId`, pinned SHA-256 `contentHash`, and usage (`required`, `recommended`, or `reference`). The path gives identity and the hash gives reproducibility; names alone are never sufficient.

Bindings are node-side metadata rather than executable node `config`. Noop config remains empty; command, Script, native, human-gate and subflow kinds have their own validated configuration. Binding changes increment the Recipe revision. The definition `executableDigest` identifies the executable graph, while the Recipe revision and portable bundle digest identify the complete graph-plus-knowledge contract.

When `recipe_run_next` or `recipe_run_report` claims a node, its `execute_node` action includes `knowledge_bindings`. The Agent fetches selected content with `get_skill` or `get_note`, verifies the returned content hash, applies required bindings, and reports unresolved or changed bindings instead of silently using another revision. The action carries references, not duplicated bodies, keeping lazy state responses small.

### Portable Project Recipe bundle

Project Recipe export uses canonical JSON with schema `pkm.project-recipe-bundle/v1`. The bundle contains Project identity, the transitive Recipe closure needed by the Project, exact Recipe revisions and definitions, all node bindings, embedded Skill/Note snapshots required to reproduce those bindings, an export timestamp, and a SHA-256 digest over the entire canonical payload. Secrets, credentials, machine paths, Run state, and ephemeral evidence are excluded. Private content requires an explicit destination/privacy confirmation before export.

Import is validate-first: verify the envelope digest, compile every definition and check its executable digest, reject duplicate identities, verify every embedded content hash, and require every binding to resolve to matching kind/hash content. Import then presents identity conflicts and privacy changes for review; it never overwrites local knowledge or executes a Recipe as a side effect.

JSON is authoritative. YAML has no practical shallow nesting limit, but parser behavior for implicit scalar typing, duplicate keys, anchors/aliases, custom tags, and merge keys varies, and stable canonical bytes for signing are harder to guarantee. A future YAML export may be offered as a human-readable review view, but it must round-trip through the JSON model and is not the signed reproduction artifact. Deep nesting is an ergonomics issue in either format, so definitions remain graph-shaped with ID references rather than recursively embedding child Recipes.

### Agent MCP API

The unified PKM MCP server exposes a persisted control-state-machine slice for `pkm.workflow.definition/v1`, with lazy execution by default and opt-in command/Script automation:

- `recipe_capabilities`: discover the supported definition schema, controls, claim semantics and explicit limitations. Bounded serial command/Script automation is implemented; parallel Agent claims and automatic model escalation are not.
- `recipe_search`: search accessible Project/global Recipes by query and category. Candidate results require qualification; zero results return a `design_recipe` suggestion, not a requirement to author or execute a Recipe.
- `recipe_run_start`: idempotently create a Run pinned to `recipeId`, revision, and executable digest, optionally enabling bounded automation. `recipe_run_start_adhoc` offers the same automation parameters for instance-only definitions.
- `recipe_run_get`: inspect status, accumulated node results, counts, and the next non-claiming action.
- `recipe_run_next`: atomically claim exactly one ready node and return an `execute_node` action with its pinned Skill/Note bindings. Repeated calls cannot hand the same work to another Agent while it is running.
- `recipe_run_report`: commit `succeeded` or `failed` plus a JSON result, reduce dependency state, and atomically return or claim the next action.

Every response uses `pkm.recipe.api/v1` and contains `current_result` plus `next_action`. Mutations require a caller-generated `command_id`; replay with the same parameters is idempotent and reuse with different parameters fails. Run state is stored separately under `.pkm/state/recipe-runs/` and never mutates the pinned Recipe definition.

The runtime accepts noop, command, Script, built-in native operation, human-gate and pinned subflow nodes. It supports outcome-selected branches and bounded loop edges, but permits only one running node per Run. In lazy mode, claiming a command or Script starts a background worker; inspection reconciles its result and adapter calls advance ready work. In autonomous mode, worker completion advances supported command/Script chains directly. Neither mode implements concurrent Agent ownership.

Full contract qualification, open-world exploration, general failure-policy dispatch and heterogeneous worker scheduling remain targets. `recipe_create_from_skill` supports a declared Skill-gap authoring path; a search suggestion alone neither persists a draft nor bypasses validation and privacy rules.

## Recipe Library UX

- Recipe Library uses the same CatTree interaction as Skills, Notes, and Papers.
- Top-level categories can be marked Private. Descendants inherit the marker.
- A Recipe row shows name, revision, Step/control-node count, scope, privacy, and digest prefix.
- Opening a Recipe shows a flowchart. Static nodes have solid borders; runtime-expanding controls use a distinct branching glyph and the label “Dynamic”.
- Definition view shows policy and possible shape. Run view overlays the actual expanded tree, probability estimates, attempted order, current frontier, backtracks, and takeover state.
- Search matches Recipe metadata, contracts, and nodes while preserving category context. A zero-result view carries the current task contract into `Design Recipe`; it does not create an empty Recipe silently.

## Dashboard semantics

Agent Sessions is the operational view. Its execution surface is a top-down technology tree, not a timeline or a national-focus-style route chooser:

```text
Project: Personal Knowledge Manager
└── Recipe: Software Development r1
  ├── Todo: Understand · complete
  ├── Todo: Plan · complete
  └── Todo: Implement · running
    └── Recipe: UI Development r1
      ├── Todo: Validate · available
      └── Todo: Report · locked
```

Recipe edges are expansion provenance: the dashboard can always answer which Recipe revision created a Todo layer. Todo edges are unlock dependencies. A node is `locked`, `available`, `running`, `blocked`, `failed`, or `complete`; its declared predicate, not visual position, decides when descendants unlock.

### Unlock conditions

Every Todo with prerequisite nodes declares one of two deterministic condition modes.

#### Count mode

`count` evaluates how many prerequisite edge predicates are currently satisfied. It supports exact comparison rather than collapsing behavior into `any`, `subset`, and `all` enums:

```json
{
  "mode": "count",
  "from": ["A", "B", "C"],
  "comparison": { "operator": "gt", "value": 1 }
}
```

Supported operators are `gt`, `gte`, `eq`, and `all`. The threshold may be a non-negative integer or a typed Recipe input reference such as `{ "input": "requiredReviews" }`. At run creation, the resolved threshold must be an integer in the valid range for the operator and prerequisite count. `all` takes no value and means the satisfied count equals the number of unique prerequisites. Thus `>1`, `>=1`, `==k`, `>k`, and `all` remain distinct and visible in the dashboard.

#### Specific subset mode

`subset` names the exact prerequisite relationships using a structured monotone Boolean expression:

```json
{
  "mode": "subset",
  "from": ["A", "B", "C"],
  "expression": {
    "and": [
      { "or": [{ "ref": "A" }, { "ref": "B" }] },
      { "ref": "C" }
    ]
  }
}
```

This represents $(A \lor B) \land C$. `A && B` is `{ "and": [{ "ref": "A" }, { "ref": "B" }] }`. The schema accepts only `ref`, `and`, and `or`; it never evaluates authored strings as code. `not` is intentionally excluded so unlock conditions are monotone: once a Todo becomes available, additional successful prerequisites cannot lock it again.

The `from` list contains unique prerequisite IDs. Every expression `ref` must name a member of `from`, but a subset expression need not reference every member; unreferenced prerequisites do not affect that condition. Empty operators, duplicate prerequisites, unknown references, invalid thresholds, and count-input type mismatches are compile errors. Commutative `and` and `or` children are canonicalized by digest order so equivalent authored ordering has one executable identity. A failed or skipped prerequisite is satisfied only when its edge predicate explicitly accepts that outcome. The Run records the prerequisite snapshot and condition result on the event that changes a node from `locked` to `available`.

Dynamic `explore` nodes grow candidate subtrees under their owning Todo. The UI must distinguish authored nodes from generated candidates and show why traversal moved. It must never expose hidden chain-of-thought; concise rationale, tool actions, outputs, evidence, and decisions are sufficient.

### Orientation, expansion, and focus

- The default graph orientation is vertical: Project root, Recipe gate, and Todo nodes flow downward. Siblings stack vertically along a dependency rail rather than widening the page.
- Every node with a child Recipe Expansion can independently expand or collapse its descendant subtree.
- The default is `Focus current`: expand every ancestor needed to reveal the Agent's running Todo, but keep that Todo's own descendants collapsed. This shows work up to the current frontier without exposing all future branches.
- `Expand all` opens every currently materialized Recipe layer. Runtime-generated branches that do not exist yet are not fabricated.
- `Collapse all` leaves only the Project root (or virtual Ad-hoc root) visible.
- Manual expansion state is scoped to the Agent Session and retained while navigating its Tasks. It is presentation state and never mutates the Run Graph.
- When the running Todo changes, untouched views follow the new current path. After manual expansion, the dashboard preserves the user's view and offers `Focus current` to recenter explicitly rather than unexpectedly collapsing their inspection context.

## Compatibility and delivery

- Preserve implemented v1 nodes, outcome dependencies, bounded loop edges and pinned subflows. Do not redefine them as noop-only or reject existing supported loops.
- The proposed open-world definition uses a distinct schema identifier. An adapter must preserve existing execution semantics; do not assume loops and subflows can be lifted as ordinary static Steps without transformation.
- Delivered: align Router/MCP policy and expose the implemented capability baseline.
- Next: versioned goal/frontier projection and atomic begin/report transitions. Gate on idempotency, redirects, crash recovery and response-size tests; measure lifecycle roundtrips separately from provider tokens.
- Delivered: opt-in autonomous command/Script progression, tested through runtime and actual MCP transport for multi-node completion without Agent polling, acceptance Script output checks, cancellation, time/node budgets, failed launch, interrupted callback reconciliation, concurrent claim suppression and legacy replay. General output validation, autonomous native/subflow/loop execution and host notifications remain follow-up work. Actual Windows cancellation remains unverified on the Linux test host.
- Next: leased heterogeneous worker claims and failure-policy dispatch. Gate on concurrent-claim uniqueness, stale-write fencing, privacy, bounded escalation, workspace conflicts and independent-branch continuation tests.
- Then: open-world compiler, append-only reducer, proposal adapter and Run overlay. Gate on deterministic replay, budgets, crash recovery, privacy, cancellation and accepted takeover tests.

These slices can be delivered independently where contracts permit. Parallel exploration is not a prerequisite for a useful linear Recipe or reliable Script automation.

## Required invariants

1. Recipe revisions are immutable and Runs pin exact executable identity.
2. Dynamic candidates never mutate the Recipe Definition Graph.
3. Candidate admission and traversal are deterministic from accepted events.
4. No loop or exploration can execute without hard bounds.
5. Success is decided by a declared predicate, not by the proposing Agent's confidence alone.
6. Every attempt, prune, backtrack, and handoff is observable and attributable.
7. A takeover request changes ownership only after explicit acceptance.
8. Privacy applies to definitions, generated branches, evidence, and exports.