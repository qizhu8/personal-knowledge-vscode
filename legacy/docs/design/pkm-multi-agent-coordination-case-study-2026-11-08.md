# PKM multi-agent coordination: migration case study and reusable template

Date: 2026-11-08.

Status: operational case study and design input for the next PKM Chat stage.
The migration remains incomplete: current foundation verification is not
workstream acceptance or cutover authorization. This document distinguishes
observed results from proposed coordination behavior.

## Executive summary

The useful unit of parallelism is an independently implementable and verifiable
change, not an arbitrary number of workers. In a shared worktree, workers need
exclusive file ownership, explicit interfaces and a parent-controlled merge and
acceptance gate. A worker reporting "done" is a handoff, not proof that the
user's task is complete.

PKM Chat should plan large, parallelizable tasks as a dependency graph, expose
useful intermediate results, and keep a Manager responsible for integration and
the user's end-to-end acceptance criteria. The activity stream remains available
as detailed execution history; it is not the primary progress view and does not
establish meaningful progress or completion.

## Observed migration case

The current next-server migration used several distinct forms of work:

- A bounded implementation owner built the Skill-source history bridge.
- Separate read-only reviewers identified a concrete VS Code host integration
  gap, a missing client-side Manager start workflow, and an entity-level Sync
  restore invariant.
- A parent-integrated verifier independently qualified the implementation,
  ran the scoped storage-I/O checks and fixed-point generators, and ran the
  standard full verifier.
- After Batch22's first full run exposed a browser assertion race, investigation
  found that the test waited for a generic editor form left over from the prior
  selection. The test now waits for the selected detail heading before using the
  editor. The original literal unsafe-content assertion remains in place.

The corrected Batch22 standard run passed 1395 server tests and 9 isolated
client tests (1404 total) at implementation digest
`aac09888b6df0cd7aa6a59a3c811cf40840877c13ca4c70f335532bb8731e6ce`.
That was Batch22 implementation verification only; the later Batch23–26
integration result is recorded below. Migration readiness remains blocked at
0/21 accepted workstreams; it is not permission to switch production.
See [Batch22 qualification](../../next-server/migration/batch22-qualification.json)
and [migration progress](../../next-server/MIGRATION.md).

### Batch23–26 integration follow-up

Four bounded owners delivered subscription identity import, an isolated VS Code
host package, complete Sync entity restore, and typed Manager client workflow
surfaces. The independent review and parent integration pass added findings not
visible in each worker's focused suite:

- The Batch25 review found that native startup preflight inspected an unsupported
  historic privacy-only Sync journal but did not persist `needs-review`; the
  normal recovery path already did. The owner fixed the preflight path and
  tested reopen, unchanged bytes/mode, and caller-owned transaction behavior.
- The first parent run found an old-backup compatibility bug: subscription
  identity verification queried a receipt table that is intentionally absent in
  historical schemas with no identity import. It also exposed that the new
  Manager client test was being run by the server's strip-only Node runner even
  though it imports TypeScript parameter properties. The compatibility check was
  made table-aware, and the Manager test was assigned to the existing
  transform-enabled client-test lane.
- Changes to shared native implementation files invalidated the checked-in
  Batch14 source pins and legacy-regression report source maps. Re-running the
  repository's ordered/concurrent fixed-point qualification refreshed those
  native evidence maps; it did not alter original-source captures. The next
  standard parent run then passed 1426 server tests and 12 client tests (1438
  total) at digest
  `ce9005f2c1410727d7bdfe1683048dbc741d25ab7d19120a2022b8e693107ecb`.
- Batch24's VS Code host is tested with its module adapter and loopback HTTP
  service, not Electron or an installed production extension. The parent
  verification does not upgrade that limitation.

An additional integration cycle reinforced these lessons:

- A review found a missing-table compatibility fix could silently accept a
  damaged schema 14+ workspace. The parent fenced both startup and backup
  restore while retaining the schema 12/13 upgrade path.
- The Sync reviewer found changed-byte private recovery could receipt a file
  whose permissions were externally widened. The owner fixed the prepared
  recovery path; subsequent review exposed inconsistent historical-receipt
  validation and an exception path that left a transaction open. Each was
  fixed and tested before the final integration run. Completed receipts remain
  historical evidence, not guarantees about later external changes.
- A full run failed 1437/1438 server tests because the readiness fixture copied
  another test's transient directory while it was being removed. The owner
  restricted fixture copying to stable inputs and tested concurrent execution.
  The failed run was retained; a later run passed 1444 server and 12 client
  tests after the repeated 28-case synthetic storage-I/O matrix was frozen.
- A session-local authenticated virtual display enabled the real Electron
  harness without installing a system service. Its first run exposed a test
  that accessed a disposed webview; the corrected run passed against the
  synthetic loopback server, not a real backend or production extension.
  Independent evidence and authority input is implemented, but neither fixture
  test results nor the tool itself enrolls an authority.
- A readiness pass also exposed 11 registered canonical operations that were
  listed as candidates but had no workstream obligation. They are now mapped
  to the relevant Assets, Memory, Skills or Subscriptions scope; tests assert
  each still blocks on its own independently signed evidence. Mapping is not
  acceptance and does not reduce the evidence requirement.

The sequence shows why completion needs a parent-owned acceptance lane:
targeted green tests did not cover every startup/restore entry path, historic
schema boundary, runtime invocation mode, or evidence pin. A source change can
also make a valid old evidence map stale without changing the original-source
captures; refresh only through the dedicated qualification path, then rerun the
exact full verifier against the final fingerprint. The current foundation pass
still does not accept a migration workstream or authorize cutover.
See [Batch23 qualification](../../next-server/migration/batch23-qualification.json)
and [current verification](../../next-server/migration/verification.json) for the
bounded implementation record and exact full-suite evidence.

### What worked

1. **Concrete bounded implementation beats open-ended delegation.** The most
   useful implementation assignment names a behavior, its actual transport and
   recovery path, allowed files, forbidden effects and executable tests.
   "Investigate the migration" or "make a plan" alone did not close a feature.
2. **Read-only discovery can parallelize safely.** Independent gap-finding
   tasks returned actionable symbols, old behavior, missing wiring and test
   scenarios without competing for the same source files.
3. **Ownership boundaries make shared-worktree work tractable.** One worker per
   file surface, with a named integration owner, lowers accidental overlap.
   Shared files should have one writer at a time; interface changes are
   coordinated explicitly rather than assumed.
4. **Verification must reproduce the user's actual criterion.** The browser
   failure was not fixed by deleting the assertion or increasing a timeout.
   Waiting for the selected document identity corrected the stale-element
   observation while preserving the original content-safety check.
5. **Current evidence and remaining work can coexist.** Batch22's full test
   pass is recorded separately from all-workstream readiness. A test count is
   not a migration-completion percentage.

### What did not work, and why

- **Too-broad delegation produces activity without mergeable work.** A worker
  can spend its turn describing a planner or proposing an architecture instead
  of implementing the requested behavior. Assign one deliverable, require a
  concrete first checkpoint, and re-scope early if no artifact or test appears.
- **More agents do not remove shared-resource bottlenecks.** Forty agents
  writing one worktree can increase collisions, stale reads and parent review
  cost. Raise concurrency only when tasks have disjoint ownership and the
  integration lane can absorb their outputs.
- **A green targeted test is not a full integration pass.** The selected
  browser test and a concurrent browser subset passed before the full suite
  exposed the timing window. The standard runner, current fingerprint and
  post-run evidence are separate gates.
- **A useful worker report is not acceptance.** Independent review can identify
  a gap, but the parent still needs to reconcile the implementation, verify
  behavior across callers and transports, run the relevant failure/recovery
  tests, and record remaining limitations.
- **Activity volume is a poor progress proxy.** Tool calls, elapsed time,
  worker count and verbose status are not proof that an artifact changed or a
  criterion passed.
- **Stale historical baselines cannot be carried forward.** A source or test
  change invalidates a fingerprint-bound full result unless the repository's
  qualification process proves otherwise. Do not copy an old green digest or
  claim a newly edited test was covered by a previous run.

## Proposed PKM Chat coordination model

### Planning phase

Before dispatch, the Manager should produce a compact plan with:

- the durable user objective and measurable acceptance criteria;
- candidate work units and why they can proceed independently;
- dependencies and shared interfaces;
- one owner and a file/resource write boundary for each work unit;
- validation and integration tasks, including who owns final acceptance;
- policy boundaries, credentials/data exclusions, and decisions that require
  the user;
- a concurrency level based on actual independence and merge capacity.

Planning should not force parallelism. If tasks share a critical file or depend
on the same unknown interface, sequence that work or assign one owner and make
the others reviewers. Prefer a small number of high-value independent tasks
over an arbitrary worker quota.

### Execution and integration phases

1. **Discovery:** Use read-only workers for independent unknowns. Each returns
   evidence and a bounded implementation proposal, not a completion claim.
2. **Contract and ownership:** The Manager resolves overlaps, defines
   interfaces and records dependencies before concurrent edits begin.
3. **Implementation:** Each worker executes only its assigned scope and
   reports changed artifacts, commands/results, blockers and next action.
   Unknown behavior is escalated rather than silently broadened.
4. **Integration:** The Manager checks ownership boundaries and diffs, resolves
   interface mismatches, and combines changes. Conflicting edits stop for
   explicit reconciliation; a worker must not overwrite another owner's work.
5. **Independent acceptance:** Run exact targeted scenarios, then the required
   integration/full checks against the merged fingerprint. Preserve failed
   runs and fix the root cause without weakening assertions.
6. **Completion:** Compare the merged evidence with every original acceptance
   criterion. Mark done only when all required checks pass; otherwise remain
   in progress, blocked, or needs-user with the unmet criteria visible.

### User-visible progress

Show an outcome-oriented progress view alongside, not derived solely from, the
activity list. At each material checkpoint report:

- **Now:** current phase and owner;
- **Completed:** artifact or behavior, with a link/reference where possible;
- **Verified:** exact test/measurement and result;
- **Open:** failed checks, unresolved interfaces, risks and decisions;
- **Next:** the next concrete action and its owner.

Keep detailed tool/activity history available for diagnosis, but do not require
the user to infer progress from raw events. Intermediate results should appear
as soon as they are useful, so the user can steer the Manager without
interrupting workers whose tasks remain valid.

### Lifecycle and authority

- The Manager owns the parent objective; workers own only their assigned
  subtask attempt.
- Worker completion does not complete the parent task. Integration and
  acceptance are explicit work units with evidence.
- User feedback goes to the Manager. It changes scope or priorities only after
  the Manager reconciles it with active assignments and tells workers which
  contracts changed.
- Pause, cancellation, host loss and uncertain effects preserve evidence and
  disarm automatic mutation. Resume requires reconciliation; do not blindly
  replay a worker or external side effect.
- Permission, data scope, credentials, production actions and final acceptance
  remain explicit authority boundaries. Delegation does not inherit authority
  from the Manager by implication.

## Reusable task packet

Use this packet for each delegated unit. The Manager should persist the packet
and its status so a long task can resume after compaction or host restart.

```text
Task ID:
Parent objective:
User acceptance criteria served:
Deliverable:
Evidence / current facts:
In scope:
Out of scope:
Owner:
Write boundary (files, APIs, or fixture):
Read-only dependencies:
Depends on:
Interface contract:
Authority and data boundary:
Required scenarios:
Required commands:
Expected report:
Uncertainty / escalation rule:
Manager integration owner:
Independent acceptance owner:
```

Worker report:

```text
Status: done | blocked | needs-input | interrupted
Changed artifacts:
Behavior delivered:
Exact commands and results:
Failure/recovery cases:
Known limitations:
Unresolved dependencies or conflicts:
Parent acceptance criteria still unmet:
Recommended next action:
```

## Parent Manager acceptance checklist

- [ ] Parent goal and acceptance criteria remain unchanged or have an explicit
      user-approved revision.
- [ ] Every worker had bounded ownership and did not report authority it was
      not granted.
- [ ] All outputs are present in the shared integration surface and reviewed
      against their stated interface.
- [ ] Cross-worker interactions and original behavior are tested after merge.
- [ ] Failure, retry, recovery and restart cases are covered where effects are
      durable or externally visible.
- [ ] Standard required validation passes on the exact current source; stale
      results and failed attempts remain labeled as such.
- [ ] Remaining risks, unsupported cases, blocked criteria and required human
      decisions are visible.
- [ ] The user receives a concise intermediate/final outcome, not only an
      activity transcript or "all workers finished" message.

## Design consequence

PKM Chat should treat parallel work as a supervised workflow with explicit
planning, ownership, integration and evidence-backed acceptance—not as a
scatter of independent Chats. This case is a template for task structure and
verification discipline. It is not proof that the current Chat UI or Manager
already implements every proposed interaction.
