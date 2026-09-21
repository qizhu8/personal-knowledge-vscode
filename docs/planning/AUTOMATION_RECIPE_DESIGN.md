# Automation and Recipe Design

Status: design target. Workflow Definition v1 remains the implemented, DAG-only format. The v2 structures below are proposals and must not be exposed as executable until their compiler and runtime exist.

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
6. If there is **no qualified match**, enter **Recipe Design** with the unresolved task contract and rejected candidates as evidence. Compile and validate a new draft, then pin that immutable draft before it can expand the current Todo. Publishing it to the reusable Library is a separate explicit action.

Recipe Design is a system bootstrap operation, not an endlessly recursive lookup. It may itself use a pinned built-in design Recipe, but failure to resolve that Recipe falls back to a fixed host protocol that gathers the contract, authors the graph, compiles it, runs validation, and requests approval where required.

Every nested binding appends a `recipe.resolution.started` event followed by candidate/rejection evidence and exactly one terminal event: `recipe.bound`, `recipe.design.requested`, or `recipe.resolution.failed`. The Run Graph records the parent Todo, classification, query/index revision, chosen or rejected identities, binding depth, and pinned executable identity.

Recursive expansion is allowed; recursive definition identity is bounded. Before binding, the runtime checks the active ancestor chain. The same executable digest may not appear again on that chain unless the parent definition declares a bounded recursive call with decreasing typed measure and maximum depth. Workspace depth and expansion budgets still apply. This prevents `A → B → A` and self-binding loops while allowing deliberate bounded recursion.

Search outcomes are `qualified-match`, `ambiguous`, or `no-qualified-match`. Ambiguous high-ranked candidates require a declared tie-break policy or Agent/user decision; the runtime must not silently select one. Search is ACL-aware before ranking so private metadata is not leaked through result counts, rejection explanations, or embeddings.

### Step knowledge bindings

Every Recipe node may bind zero or more Skills and Notes. A binding contains a stable `bindingId`, `kind` (`skill` or `note`), canonical PKM `knowledgeId`, pinned SHA-256 `contentHash`, and usage (`required`, `recommended`, or `reference`). The path gives identity and the hash gives reproducibility; names alone are never sufficient.

Bindings are node-side metadata rather than v1 noop `config`, because the v1 compiler intentionally requires that config to be empty. Binding changes increment the Recipe revision. The definition `executableDigest` continues to identify the executable DAG, while the Recipe revision and portable bundle digest identify the complete DAG-plus-knowledge contract.

When `recipe_run_next` or `recipe_run_report` claims a node, its `execute_node` action includes `knowledge_bindings`. The Agent fetches selected content with `get_skill` or `get_note`, verifies the returned content hash, applies required bindings, and reports unresolved or changed bindings instead of silently using another revision. The action carries references, not duplicated bodies, keeping lazy state responses small.

### Portable Project Recipe bundle

Project Recipe export uses canonical JSON with schema `pkm.project-recipe-bundle/v1`. The bundle contains Project identity, the transitive Recipe closure needed by the Project, exact Recipe revisions and definitions, all node bindings, embedded Skill/Note snapshots required to reproduce those bindings, an export timestamp, and a SHA-256 digest over the entire canonical payload. Secrets, credentials, machine paths, Run state, and ephemeral evidence are excluded. Private content requires an explicit destination/privacy confirmation before export.

Import is validate-first: verify the envelope digest, compile every definition and check its executable digest, reject duplicate identities, verify every embedded content hash, and require every binding to resolve to matching kind/hash content. Import then presents identity conflicts and privacy changes for review; it never overwrites local knowledge or executes a Recipe as a side effect.

JSON is authoritative. YAML has no practical shallow nesting limit, but parser behavior for implicit scalar typing, duplicate keys, anchors/aliases, custom tags, and merge keys varies, and stable canonical bytes for signing are harder to guarantee. A future YAML export may be offered as a human-readable review view, but it must round-trip through the JSON model and is not the signed reproduction artifact. Deep nesting is an ergonomics issue in either format, so definitions remain graph-shaped with ID references rather than recursively embedding child Recipes.

### Agent MCP API

The unified PKM MCP server exposes a lazy static-DAG execution slice for `pkm.workflow.definition/v1`:

- `recipe_capabilities`: discover the supported definition schema, serial ready-node strategy, claim semantics, and explicit v2/design limitations.
- `recipe_search`: search accessible Project/global Recipes by query and category. Candidate results require qualification; zero results return a structured `design_recipe` next action carrying the task contract.
- `recipe_run_start`: idempotently create a Run pinned to `recipeId`, revision, and executable digest.
- `recipe_run_get`: inspect status, accumulated node results, counts, and the next non-claiming action.
- `recipe_run_next`: atomically claim exactly one ready node and return an `execute_node` action with its pinned Skill/Note bindings. Repeated calls cannot hand the same work to another Agent while it is running.
- `recipe_run_report`: commit `succeeded` or `failed` plus a JSON result, reduce dependency state, and atomically return or claim the next action.

Every response uses `pkm.recipe.api/v1` and contains `current_result` plus `next_action`. Mutations require a caller-generated `command_id`; replay with the same parameters is idempotent and reuse with different parameters fails. Run state is stored separately under `.pkm/state/recipe-runs/` and never mutates the pinned Recipe definition.

This first slice is intentionally honest about its boundary: v1 nodes are `pkm.step.noop/v1`, so the executable instruction is the node identity plus its complete kind/config/dependency record. Typed instructions, dynamic branches, loops, recursive Recipe binding, contract qualification, and Recipe Design persistence require the v2 compiler/reducer and extension authoring bridge. `recipe_search` may request design, but it does not bypass ProjectStore to write a draft.

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

- v1 stays supported and remains DAG-only.
- A v1 Recipe can be lifted losslessly into v2 as static `step` nodes.
- v2 must use a new schema identifier; the v1 compiler must continue rejecting v2 fields and cycles.
- First implementation slice: v2 types, canonical compiler, and negative tests.
- Second slice: append-only Run Graph reducer with deterministic DFS tests.
- Third slice: Agent proposal adapter, budget enforcement, and handoff state machine.
- Fourth slice: flowchart authoring and live Run overlay.
- Enable v2 execution only after replay, crash recovery, privacy, cancellation, and takeover tests pass.

## Required invariants

1. Recipe revisions are immutable and Runs pin exact executable identity.
2. Dynamic candidates never mutate the Recipe Definition Graph.
3. Candidate admission and traversal are deterministic from accepted events.
4. No loop or exploration can execute without hard bounds.
5. Success is decided by a declared predicate, not by the proposing Agent's confidence alone.
6. Every attempt, prune, backtrack, and handoff is observable and attributable.
7. A takeover request changes ownership only after explicit acceptance.
8. Privacy applies to definitions, generated branches, evidence, and exports.