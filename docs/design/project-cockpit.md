# Project Cockpit (P2)

Projects are optional durable context, not an executor. Ordinary Chat continues without a Project. A blank Project requires only a name and gets its existing General Thread. Research and Delivery templates supply editable intent, not executable Recipes. Chat's optional **Promote Chat to Project** button uses one name/confirmation dialog; owner, deadline, policy and criteria can be filled later. Promotion retains a Chat identity and, when available, its Agent Session link. It does not copy or change the conversation.

## Durable Project state

`ProjectRecord` adds optional `goal`, `successCriteria: string[]`, `status: planned | active | completed`, `currentMilestone`, `owner`, ISO-date `deadline`, and `autonomyPolicyReference`. Status describes **Project intent**, never Run status. A policy reference is descriptive and grants no permissions.

Optional `links` contain `{kind, id, linkedAt}` where kind is `action-run`, `recipe-run`, `agent-session` or `chat`. Action associations are explicit `action_run_<32 hex>` identities; Python `project_id` is not required. Project records, links, decisions and timeline are stored with the existing canonical `project/<portable-name>.<projectId>/project.json`, digest, OS lock, store-version fence and command receipts. Legacy Projects remain readable with fields absent. Restart reconstructs exactly these records; the Project does not store a cached execution state.

Changing goal or success criteria requires an explicit nonempty reason. An immutable appended decision includes timestamp, identity and exact before/after changes. Creation records initial intent. Other Overview edits append a durable event. Timeline entries are not capped or replaced by debug logs.

## Five primary sections

- **Overview:** intent, success criteria, milestone, owner, optional deadline and policy reference.
- **Now:** canonical `projectExecution` projections grouped into Running/Ready, Waiting, Blocked, plus **one review inbox** for Needs review and Reconciling. Original execution surfaces remain directly inspectable. Human waiting checkpoints support explicit inline answer JSON and confirmed whole-Run cancellation through the original Action APIs, never a blind resume.
- **Artifacts:** referenced proposal/draft/final/evidence/output records with their source execution ID, revisions/hashes and provenance supplied by the underlying record. An output is not automatically designated final.
- **Decisions:** explicit intent decisions and available resolved checkpoints / Collaboration decisions with reasons and evidence.
- **Timeline:** Project events, Action execution receipts, Agent checkpoint references, Recipe durable events and Collaboration transition history. Debug/console logs are excluded.

Threads, Gantt, Todos and Agents remain secondary existing navigation surfaces. Overview no longer uses the old demonstration execution fixture.

`projectCockpits(root, projects, collaborationTasks)` reads execution records once per snapshot, then builds each Project's projection. Sources are `.pkm/state/actions/runs/<run_id>/run.json`, `agent-sessions/<sessionId>.json`, `recipe-runs/<runId>.json` and canonical Collaboration records. Membership comes from explicit links, native Project identity, Session Recipe Run IDs or Collaboration execution links. Unknown states, missing linked executions and unreadable/truncated sources are visible diagnostics, never fabricated success. Source reads are bounded, reject symlinks and validate identities; projections omit Action capability hashes and checkpoint resume tokens.

Action waiting metadata supports top-level `checkpoint` / `checkpoints`, or `execution.checkpoint`. Checkpoints use snake_case `checkpoint_id`, `run_id`, `kind`, `state`, `owner`, exact `proposal`, `proposal_digest`, `evidence`, optional epoch-second `deadline`, `timeout_behavior`, `answer` and `options`. The precise proposal and digest are shown read-only. Pending input remains Waiting; approval/artifact-review/decision/exception or expired checkpoints enter the review inbox. `waiting` and `execution.phase: waiting` project Waiting; `outcome_unknown` or reconciling phase project Reconciling.

Scheduled nonhuman triggers remain Waiting under the scheduler, not a human approval inbox. A canonical cancelled Run supersedes its retained waiting checkpoint/approval envelope: evidence remains visible but cannot be answered and does not falsely keep the Project active.

## Lifecycle and evidence retention

- **Archive:** refuses active, queued, waiting, review, reconciling, unknown, missing-linked or unverified execution records. Moves the Project out of the active map, leaving all files, links and evidence intact.
- **Remove from active map:** available only after archive and explicit confirmation. This is reversible soft deletion (`deletedAt`), **not a purge**. No Run, Recipe, Thread, artifact, decision or external reference is deleted.
- **Restore:** clears archived/deleted markers, preserving identity, evidence, references and the lifecycle timeline.
- The system Default Project is protected. Archived/removed Projects are visible in a retained-evidence group. Overview/source-link mutations require restoration.

Lifecycle checks reread current execution records under the existing Project mutation lock. They are conservative guards, not a cross-store execution freeze; the non-destructive semantics remain safe if a separately managed executor changes later. Physical purge is intentionally unsupported.

## Host and parent P3 interfaces

Workbench native and authenticated browser requests use:

```text
method: open_project
params: {run_id: "action_run_<32 hex>"}
result: {ok: true, project_id?: string}
```

The existing Workbench route checks workspace trust and the enabled automation domain, validates the Run identity, then invokes `personalKnowledge.openActionRunProject`. A previously linked Project opens directly. Otherwise the user selects an existing active Project or creates one for the Run; the link is persisted without writing execution state. The Project panel opens Now. Cancellation creates nothing.

Project panel messages: `projectCreate {name, overview?, template?}`, `projectOverview {projectId, overview, reason}`, `projectLink {projectId, kind, id}`, `projectLifecycle {projectId, action, confirmed}`, and `projectOpenSource {projectId, id}`. Existing `projectState` adds `cockpits: {[projectId]: ProjectCockpit}`. `openProject {projectId}` handles immediate and startup-deferred navigation.

P2 mutation messages include the displayed `expectedStoreVersion`; stale forms cannot overwrite concurrent Project changes. Background refresh preserves focused Overview/checkpoint drafts while retaining their originally displayed version/proposal pins. Chat and optional Session links are created atomically; the store deduplicates repeated promotions under its existing mutation lock.

`projectCheckpoint {projectId, id: run_id, checkpointId, proposalDigest, action: answer | cancel, answer: JSON-text, eventKey: checkpoint_id, confirmed?}` refreshes `checkpoints {run_id}` through managed `actionRequest`. The host matches Run, checkpoint, waiting state and displayed digest, rejecting stale/nonhuman triggers before mutation. For answers it privately obtains `resume_token` and calls `respond_checkpoint {run_id, checkpoint_id, resume_token, proposal_digest, answer: parsed-JSON, event_key}`. JSON-schema validation and final stale-token checks belong to the authoritative runtime. Cancel requires an inline explicit entire-Run checkbox and calls `cancel_run {run_id}`; cancellation racing active work can still require reconciliation. Expired/scheduled checkpoints and uncertain effects remain inspection-only; no arbitrary wake/reconcile button is offered. Success/error feedback is in-panel and both paths refresh the authoritative projection.

Checkpoint `presentation: json | choice` is projected explicitly. Cockpit accepts exact answer JSON against the displayed schema for both presentations; only an explicit `choice` presentation gets the choice-schema label. A generic proposal containing `options` never changes the checkpoint's interpretation or hides an approval.

`openActionWorkbench(context, runId?)` can preselect the exact validated Run using the existing Workbench's initial view state. `src/workflows/project-cockpit-host.ts` exports `handleProjectCockpitRequest`, `promoteChatProject`, and `actionRunProject`; extension handlers and browser acceptance invoke this same production boundary.

`actionRequest(context, method, params)` is exported from `src/ui/action-browser.ts`. The Python allowlist includes `checkpoints`, `respond_checkpoint`, `schedule_run`, `wake_run`, `reconcile_run`, `safety_scan`, and `associate_project`. P2 does not invoke `associate_project`; explicit links suffice. Calling it separately may give Python fairness a Project key, but should not replace Project links.

`ActionBackgroundTasks` accepts optional injected `{enabled, scan, report}` dependencies. Extension activation supplies managed-runtime `safety_scan {}` with Knowledge Root readiness, workspace trust, automation-domain and healthy-runtime guards. One initial eligible scan and a non-overlapping 30-second timer use the existing managed Python API; no daemon or second state engine is created. Scan failures go to the extension diagnostic log, not popups. Both timers are disposed. Without injected dependencies, tests and existing consumers never auto-scan.

## Verification boundary

`npm run build` is the full SDK-safe bundling build, not tsc-only. Focused regressions:

```sh
node tests/test-project-cockpit.js
node tests/test-project-cockpit-browser.js
node tests/test-project-cockpit-python.js
node tests/test-action-safety-scan.js
node tests/test-action-browser.js
node tests/test-project-filesystem-store.js
node tests/test-workflow-project-model.js
node tests/test-workflow-project-store.js
node tests/test-project-threads-ui.js
```

P2 service acceptance uses isolated synthetic records, VM-rendered UI and byte-preservation checks. The separate Chromium integration loads the actual bundled Chat and Project webviews, invokes the same production host functions against a real isolated filesystem ProjectStore and Run records, and tests promotion, exact source identity, persisted inbox freshness, stale proposals/store versions, schema/API errors, explicit answer/cancel, escaped provenance, archive/remove/restore, keyboard activation and 320/390px layouts. It reuses the repository's existing Playwright driver; its Action executor boundary is stubbed. Parent P3 acceptance exercises real Chat/MCP/Python execution separately. Neither test mutates a live Knowledge Root or measures human UX. Two-week dogfood, three actual pauses and the roadmap's 60-second comprehension gate remain **unmeasured manual acceptance**, not claims based on automated tests.

The single bounded `test-project-cockpit-python.js` cooperation case closes the Project executor boundary: it reuses the isolated qualified `core.checkpoint` fixture, launches one original real Python Run, promotes a fixture Chat identity through `promoteChatProject`, links through `handleProjectCockpitRequest`, projects the actual Waiting checkpoint, and answers through that production host and Python `--api`. It verifies the same Run completes, fresh Cockpit clears its inbox, explicit JSON presentation is honored, tokens remain private, and links survive ProjectStore restart. It uses the shared dev venv from `tests/dev-paths.js` (or `PKM_TEST_PYTHON`), repository-local disposable storage, bounded API/poll timeouts and fixture-process cleanup. Chat model streaming and HTTP MCP transport are intentionally left to the separate parent acceptance; there are no external model or business effects.
