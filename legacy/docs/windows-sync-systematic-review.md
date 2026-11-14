# Windows Sync review: installed 3.2.37

Implementation follow-up to `next-step/bug_report_windows.md` (F1–F7).
This is not authorization to modify the Windows business Knowledge Root.

## Snapshot and integrity contracts

- Selected bodies, sidecars, directory/package members and dependencies retain
  the bytes from the original read as `rawSnapshot`, with a source locator.
  Fallback ingest uses the same comparison representation and retains raw bytes.
- Generated Recipes use their managed store representation, not an export-file
  path as a pretend disk source. Recipe compiler/digest validation remains intact.
- Valid UTF-8 without NUL or BOM has CRLF normalized for comparison/publication.
  Binary, invalid UTF-8, NUL and BOM-bearing content retain exact bytes. This is
  **not** a permissive write guard.
- Application, stale refresh and acceptance compare the captured raw local
  version strictly. Matching the approved result is allowed for idempotent retry.
  Creation at a previously absent destination, deletion of an expected file, or
  any edit (including a newline-only edit after capture) invalidates approval.
  An already-completed deletion is idempotent.
- Guards are checked again at each file mutation boundary; batch failure rolls
  back completed writes. This cannot provide an OS-level compare-and-swap against
  an unrelated editor writing in the tiny interval between check and rename.
- Historical Base newline reconciliation remains evidence-bound. The newest
  Remote manifest/blob integrity check remains strict; logical comparisons do
  not replace transport/blob integrity validation.

## Provenance and pending operations

Guard failure retains every unapplied operation. It no longer invents Base from
`expectedLocal`, or GitHub from the planned result:

- `base` / `baseCommit`: actual ancestor blob and commit, when available;
- `local`: current raw local snapshot;
- `remote`: fetched upstream member;
- `expected` variant: captured source bytes used by the original plan;
- `planned` variant / `plannedOperation`: retained write/delete operation.

The stale member has reason `concurrent-local-change` and needs a new choice.
Other members have reason `pending-apply`; their prepared candidate or deletion
is retained for explicit final approval. They are not extra content conflicts.
The fetched Remote commit still binds acceptance.

Old workspaces without raw snapshot provenance cannot be safely upgraded by
guessing LF-to-CRLF. Recheck with Remote to prepare a fresh source-backed
workspace; do not disable the guard, clear lastSync, or bulk-approve an old record
to bypass this safety check.

## Entity intent and counts

`unrecorded-local-absence` groups an entity's body, sidecars and dependencies.
The review displays identity, members, historical paths, selection/exclusion
evidence and available tombstones. Explicit restoration selects all upstream
members; explicit deletion selects all missing-entity members, including new
sidecars without a Base. Partial local membership is not silently treated as
whole-entity deletion. User choices remain candidates until final approval.

`totalFiles` counts unique assessed paths; `assessedEntities` is an independent
identity count. Rules describe reconciliation outcomes. Pending-apply members and
concurrent blockers are separate dimensions, not additions to totalFiles or
human-required. The UI reports workspace members, choice-required and
candidate-awaiting-approval counts; it never infers “both changed” by subtracting
missing-local/missing-remote counts. A historical 345-member workspace can have
129 choices required and 216 candidates ready; a freshly prepared plan need not
reproduce those historical counts.

## Interrupted acceptance and retry

Acceptance verifies the current Remote commit, validated candidate digests,
source snapshots and move destinations before writing. It durably writes
`applyState: applying` **before** mutation. File application remains rollback
capable; Recipes, privacy and target persistence are separate stores, not one
ACID transaction.
Conflict variants/metadata, atomic file payloads and receipts are fsynced before
rename. Directory-entry durability across power loss is filesystem/platform
dependent; this is not a claim of one crash-atomic transaction across all stores.
Primary fsync errors survive secondary temporary-cleanup errors.

- Failure during Recipe/target/marker persistence leaves a reviewable workspace
  with durable intent. Retry revalidates Remote, candidates and source snapshots.
  Files already equal to their approved results and completed deletes are
  idempotent. A changed Remote refuses acceptance without clearing choices.
- Baseline advancement occurs only after all file/Recipe operations succeed.
  Failure after baseline persistence but before the applied marker is safe to
  replay, with the same source/candidate guards.
- `appliedAt` plus `sync-pending` means applied **locally**, not pushed. Retry
  queues Sync rather than repeating the store mutation. The workspace survives
  failed commit/push and is retired only on successful Sync.
- A push followed by transaction-receipt failure is reported as an accepted
  push with failed local recording. It is not reset to the old checkout and is
  not described as a failed push or as having a durable recovery receipt.
- Secondary failure-status persistence errors are appended to, rather than
  replacing, the primary Sync failure.

## Coordinated validation

Do not run tsc/build while the parent is validating Chat SDK-safe bundles.
After the parent completes the integrated build and signals focused execution:

```sh
node tests/test-github-sync-windows-review.js
node tests/test-github-sync-acceptance-recovery.js
node tests/test-github-sync-file-safety.js
node tests/test-github-sync-conflicts.js
node tests/test-github-sync-resolution.js
node tests/test-github-sync-ui.js
node tests/test-github-sync-workbench.js
node tests/test-github-sync-two-machine.js
node tests/test-github-sync-base-integrity.js
node tests/test-github-sync-content-repair.js
node tests/test-github-sync-content-repair-host.js
node tests/test-github-sync-version-compatibility.js
node tests/test-github-sync-identity.js
node tests/test-github-sync-git.js
node tests/test-github-sync-model.js
node tests/test-github-sync-stable-id.js
node tests/test-github-sync-migration.js
node tests/test-github-sync-coordinator.js
node tests/test-github-sync-scheduler.js
node tests/test-github-sync-watcher.js
node tests/test-sync-progress.js
```

New coverage includes raw CRLF snapshots and strict late newline edits; binary/
NUL/invalid UTF-8/BOM; candidate tampering; missing destination creation; actual
Base/upstream/plan separation; 244+101 historical UI counts and 122 grouped
entities; whole-entity body/sidecar intent; changed Remote approval invalidation;
durable intent, Recipe, baseline, applied-marker and queued-push fault injection.
File-safety adds real disposable Git repositories for selected/fallback CRLF
pulls, deterministic non-overlapping merge, and one stale member preserving all
101 pending operations through fetch/reconcile/commit/push/local guard.
Existing suites cover overlapping edits, deletion/ignore/move evidence, target
collisions, rollback, Recipe compilation and repair, Root identity, historical
Base and strict Remote integrity, longpath configuration and two-machine Sync.

Linux fixtures exercise CRLF bytes, not native Windows filesystem behavior.
Windows Git longpaths, case-preserving paths, file locking/rename semantics,
antivirus interference and native VS Code multi-window operation require a
separate Windows run against **synthetic** data. Do not run these scenarios on
the actual business Knowledge Root. Tests are not claimed passed before the
coordinated build and focused execution.

## Verified execution receipt (2026-10-14, Linux)

After explicit parent authorization, the final `npm run build` completed with
exit **0**, including SDK-safe Chat bundling and all 24 required UI artifact
checks. Runtime build ID: `59fff3aee445`. No standalone tsc or manual dist patch
was used.

All **21 Node commands listed above passed with exit 0** against that final build:

| Report-specific suite | Result |
| --- | --- |
| `node tests/test-github-sync-windows-review.js` | **44 assertions passed** |
| `node tests/test-github-sync-acceptance-recovery.js` | **7 scenarios passed**: intent, Recipe, baseline, marker, queued push, stale Remote, mixed entity intent |
| `node tests/test-github-sync-file-safety.js` | **45 scenarios passed**, including selected/fallback body/sidecar/dependency/package ingestion and post-push receipt failure recovery |
| Remaining 18 Node suites | All passed; includes prior Recipe/content repair and historical Base / strict newest Remote integrity |

Actual Chromium **149.0.7827.55** also passed:

```sh
WORKBENCH_TEST_PYTHON=/home/yuwang8/miniconda3/bin/python \
  node tests/test-github-sync-workbench.js --chromium-source
PKM_PREVIEW_URL=http://127.0.0.1:4190 \
  python tests/test-github-sync-browser-ui.py
git --no-pager diff --check
```

- Workbench: **1440×1000** and **390×844**; selections, save/dirty/stale state,
  binary/Agent restrictions, destructive confirmations, applied/retry.
- Full built panel: **1440px** and **390px**; historical **345 members / 129
  choices / 216 awaiting approval**, **122 entity intent groups**, **101 pending
  apply**, no fabricated both-sides classification, and local-applied vs pushed
  wording. Existing phase/file indicators also passed.
- `--chromium-source` tests the current asset without packaging or installation;
  this is **not** packaged-VSIX validation. Synthetic preview processes were
  stopped after the checks.
- Formatting check passed. Earlier assertion/mock/fixture failures were corrected
  and rerun; they are not counted as successful runs.

No repository commit/push, installation, live knowledge mutation, or real
GitHub Sync occurred. Git end-to-end tests use disposable local bare repositories.
Windows-native acceptance and release/archive/commit/push remain parent-owned.
