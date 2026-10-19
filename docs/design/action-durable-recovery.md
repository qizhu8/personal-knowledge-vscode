# Durable Action continuations and recovery (P3)

## One execution authority

P3 extends the existing Action Run, launch journal, qualification, grants,
capability fence and artifact store. A wakeup continues the original Run; it is
not a replacement invocation or permission grant. Unknown external effects never
automatically retry. No additional autonomy mode is introduced.

Pipeline traversal commits per-step receipts, including outputs and restored
scope. Reentry traverses only the pinned definition and skips completed steps.
Nested Action calls reuse their original child invocation key and identity.
Missing completion evidence after a claimed worker dies requires reconciliation.
Definition/source replacement and ModuleSet unload remain blocked while affected
Runs are running, waiting or reconciling.

### Observational execution events

In addition to authoritative completion receipts in `steps/`, execution records
observational `pkm.action.component-events/v1` files in `step-events/`. These
retain started, failed, ignored and waiting history with the current Run fence.
Unselected branch Components and empty loop bodies have explicit ignored
reasons. Suspension marks running ancestors waiting before releasing their
worker ownership.

The Module runtime records the actual script-owned implementation as
`__implementation__` (builtin, pipeline, program or MCP). These events are
projected into the native Session subgraphs and trigger refresh. They do not
automatically instrument arbitrary functions inside a program.

Events never grant replay or stand in for `pkm.action.step-receipt/v1`.
Completed effects still restore from their authoritative receipts. Observation
failures surface, and execution failures are recorded and rethrown; ignored
Components do not acquire successful completion receipts.

Only pipeline continuations are resumable. An arbitrary Python/C#/other program
stack cannot be restored. A program invoking a waiting child must surface an
explicit failure/reconciliation rather than pretend its caller's stack resumed.

## Waiting releases execution

`core.checkpoint` supports input, approval, artifact-review, decision and exception.
Each checkpoint pins its proposal/digest, evidence, answer schema, owner, UTC
deadline, timeout behavior, identity and resume token. Submitting a response
requires all identity fields and schema validation. Duplicate identical answers
are idempotent; a changed answer, stale proposal or expired response is rejected.
Earlier proposals and responses are retained under the original Run's
`checkpoints/` directory when the next checkpoint replaces the current one.
`action_run_checkpoints(include_history=true)` includes that audit history.

`core.user-action` retains its inline choice UX, backed by the same durable
checkpoint. `core.sleep` yields to a timer rather than holding a worker.
`core.wait` accepts an absolute UTC timer, a named event, or an existing Run
dependency with pinned invocation identity and observed minimum version.
Failed/cancelled/unknown dependencies require review; an unrelated rerun cannot
satisfy them.

Waiting clears the worker claim and preserves remaining active execution time.
It does not consume active worker capacity or extend permission scope. A host
restart or timezone change does not reset the timer. Event delivery requires
the exact name and a stable delivery key; repeated delivery does not repeat
effects.

## Admission, safety scans and fencing

`action_call` optionally accepts `trigger` and `project_id` for a predispatch
module Run. Direct platform scheduling is rejected; use a pipeline wrapper.
The trigger participates in invocation-key fingerprinting. `schedule_run` can
reschedule only an explicitly prepared, unclaimed dispatch continuation, never
an arbitrary in-flight program or human approval.

Managed extension lifecycle scans and active Workbench refreshes invoke
`safety_scan`. Scans recover launch journals, expire abandoned worker claims,
handle cancellation/deadlines and dispatch eligible original continuations.
Wakeup admission is capped at eight active Runs, with one candidate per Project
or root group in a rotating pass. The dispatch request limit is bounded.
This is wakeup admission, not a new global executor for ordinary Action calls.

Workers renew a lease every five seconds. Lease expiry, missing workers or active
execution timeout fences the original Run and preserves evidence. Unknown
effects do not become an empty success or an automatic mutation retry.
Waiting cancellation is deterministically Cancelled only when no owned child
has a running or uncertain effect. Cancelling a waiting parent with an unresolved
child remains Reconciling, as does cancellation during an uncertain effect.
Checkpoint timeout explicitly selects
cancel or review. Late responses/events cannot override expiry.

## Reconciliation

The registry has five adapter kinds:

| Kind | Evidence and outcome |
| --- | --- |
| manual | Explicit operator reason; successful output must validate against the pinned schema |
| file-hash | Pinned relative Run workspace file and SHA-256, with declared typed output |
| process-status | Read-only process evidence; never sufficient to fabricate completion |
| remote-resource | Pinned, qualified, read-only lookup Action and exact success predicate/output |
| message-order | The same read-only pinned lookup boundary for externally sent messages/orders |

Reconciliation compares the expected original execution version. Stale evidence
is rejected. Remote evidence comes from the declared lookup Action, not a caller
asserting that an arbitrary resource exists. Lookup launch keys deduplicate
verification; the original mutation is never rerun. Process/file/provider
evidence does not imply rollback.

## User surfaces and APIs

Workbench shows canonical state, next owner/reason, the original identity,
waiting trigger and inline checkpoint forms. Draft responses and reconciliation
evidence survive polling. Errors remain actionable in the form. Successful
response refreshes the same Run; there is no blind Resume button for uncertain
effects. Project navigation uses the Run association.

MCP exposes `action_run_checkpoints`, `action_checkpoint_respond`,
`action_run_wake`, `action_run_safety_scan` and `action_run_reconcile`.
Mutating tools retain normal Chat approval policy. Proposal approval is distinct
from granting the Chat tool permission to submit that approval.

## Automated acceptance

All tests use isolated temporary stores, local HTTP fixtures, synthetic model
SSE and mock programs. They do not execute real business Actions, contact a model
provider, modify the live knowledge root or push a knowledge repository.

```sh
npm run build
.venv/bin/python tests/test-action-durable-runs.py
.venv/bin/python tests/test-action-modules.py
.venv/bin/python tests/test-action-runtime.py
.venv/bin/python tests/test-action-recovery-e2e.py
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu22.04-x64 .venv/bin/python tests/test-action-workbench.py
node tests/test-chat-action-recovery-e2e.js
node tests/test-project-cockpit-python.js
```

| Boundary | Cases |
| --- | --- |
| Real worker / fresh API process | All five checkpoint kinds, exited workers, original Run resume, duplicate concurrent answers, stale proposal/token |
| Durable traversal | Nested artifact effect retained once, completed step receipts unchanged, loop/branch approvals and historical exact proposals |
| Scheduling / faults | Missed timers, named event redelivery, UTC/timezone changes, dependency failure/unrelated rerun, fair admission and exact eight-active wakeup cap, expired live-worker lease, cancelled parent with a mutating child and stale completion authority |
| Reconciliation | File SHA-256 evidence, pinned read-only remote resource/message lookup, stale CAS, no original mutation replay |
| Browser / real API workers | Graph save/qualification/nested execution, inline choices, authenticated reload, transport loss retaining launch identity, waiting cancellation |
| Browser / protocol fixture | Desktop and 390px checkpoint forms for five kinds, keyboard submit, invalid JSON/stale proposal, preserved polling drafts, Project route, reconciliation evidence and stale CAS |
| Chat / real HTTP MCP / workers / Chat store | Scripted Chat tool loop launches Action, inspects waiting proposal, rejects denied/stale submission, explicitly approves in a later Chat turn, completes the same Run, rejects duplicate execution, reconciles original launch key and reloads persisted tool evidence |
| Project production host / real Python worker | Promote fixture Chat, durably link the original waiting Run, show its exact checkpoint in Cockpit, answer through the production host and Python API, and reflect same-Run completion with an empty inbox |

Protocol fixtures are not live model or human usability evidence. Native Windows
process/lease behavior, filesystem power-loss durability, real-persona sessions
and two-week dogfood remain separate acceptance work. Atomic file replacement
and process-loss fault tests do not claim fsync of the containing directory.
