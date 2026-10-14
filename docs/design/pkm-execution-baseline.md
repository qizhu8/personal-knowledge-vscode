# PKM execution vocabulary and local baseline

## Scope

P0 adds shared, read-only product projections and local measurement. It does not
introduce another executor, lifecycle state machine, scheduler, Cockpit, or
permission mode.

The five product objects are:

| Object | Existing surfaces |
| --- | --- |
| Action | Workbench definitions and background Action validation |
| Recipe | Recipe library definitions |
| Run | Action execution, Recipe execution, Agent Sessions, Chat requests/workers |
| Project | Projects, Threads, and existing Gantt task states |
| Collaboration | Existing collaboration tasks and convergence states |

`src/runtime/pkm-projection.ts` projects existing states into **Planned, Ready,
Running, Waiting, Needs review, Blocked, Completed, Failed, Cancelled, Reconciling**.
Nonterminal projections expose `nextOwner`, `reason`, and `resume` guidance.
Unknown states require review; interruption or uncertain effects require
reconciliation, not a fabricated successful outcome or automatic retry.

Existing Session, Recipe, Chat, background validation, Project/Gantt, and
Collaboration UI surfaces consume these projections. Raw persisted states remain
unchanged. Projects without an existing lifecycle receive their object kind,
not an invented execution state.

## Local collection and reporting

`src/runtime/pkm-baseline.ts` reuses the existing, default-off
`personalKnowledge.loadProfilingEnabled` setting. Production callers reevaluate
the setting for every event. The collector stores only allowlisted event/source/
evidence enums, optional persona enums, counts, and durations in the extension
host's `globalStorage/performance/p0-baseline.json`. It never sends telemetry.
It does not store prompts, inputs, outputs, bodies, tool arguments, paths, Run
identities, or approval text.

Writes use the existing cross-process lock and atomic replacement with mode
`0600`, retaining at most 10,000 events. Optional measurement does not throw
persistence failures into execution. `recordBaselineEvent` returns a bounded
outcome: `recorded`, `disabled`, `invalid-event`, or `unavailable` with a fixed
`reasonCode`; existing callers may ignore the return value. Errors never expose
exception text, paths, event bodies, or user identifiers.

`baselineReport` exposes `available`, `storage.status` (available, missing,
unavailable, or disabled), and `collection.status` (no-known-failure, incomplete,
or disabled), with fixed failure codes where applicable. Settings displays these
diagnostics. Lock acquisition, write, replacement, cleanup, read, invalid-format,
and oversized-storage failures are distinguishable. Invalid stored evidence is
not overwritten as an empty baseline.

After a recording failure, report metrics remain unavailable even if a later
write succeeds: a later observation cannot restore a lost one. Failure diagnostics
are process-local, bounded to 32 storage destinations, and do not persist across
extension-host restart; no-known-failure is not proof of complete historical
collection.
Disabling collection also disables reading retained evidence for reports; it
does not automatically delete the local file.

Actual instrumentation includes:

- Chat persisted start/dispatch, completion, failure, cancellation, dead-owner
  recovery, permission requests/repeated permission scopes, and waiting.
- Background Action validation admission and dispatch; disappearance from the
  registry is not treated as successful completion.
- Native/browser Workbench Action submissions and observed Run transitions:
  Waiting/resume, Completed, Failed, Cancelled, and Reconciling. Bounded in-memory
  deduplication prevents repeated polling from becoming repeated observations.
  Transport loss is not reported as definite execution failure.

Event bodies contain no deduplication identities. Repeated approval means the
same permission scope was requested again within one Chat attempt, not proof of
duplicate side effects. Chat waiting recovery measures successful completion of
an attempt that waited, not recovery of every individual checkpoint. Chat start
success measures persisted admission/dispatch, not every model preflight failure.
Dead-owner recovery is not a complete host-restart task-loss study.

Settings' Load profiling section displays `baselineReport`. Reports separate
observed runtime evidence, synthetic fixtures, and human measurements. Missing
numerators, denominators, durations, or human measurements remain
`available: false` / `null` and appear as **Unavailable**, not measured zero.
Uninstrumented promotions and task-loss outcomes remain unavailable.

## Validation and remaining evidence

Run the SDK-safe build and focused regression:

```sh
npm run build && node tests/test-pkm-p0.js
```

`tests/fixtures/p0-baseline-scenarios.json` contains five deterministic **synthetic**
scenarios: student, researcher, PM, designer, and developer.
`tests/test-pkm-p0.js` verifies taxonomy/state coverage, contextual next owners,
privacy filtering, opt-in behavior, missing evidence, lifecycle event
deduplication, injected lock/write/storage failures, UI projections, and
separation of synthetic/human evidence.

All five real-persona baseline sessions remain pending. The synthetic timings
and counts do not satisfy human UX acceptance. First-record experience, finding
the next step, recovery understanding, source quality, review turnaround, actual
host-crash task loss, promotion/reuse, and three-day/three-month retrieval require
real human observations or separately identified fault-injection evidence.
No live knowledge or real Actions are required by the deterministic P0 fixture.
