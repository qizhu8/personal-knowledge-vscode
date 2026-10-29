# GitHub Sync conflict workbench

The dedicated workbench replaces native-diff-only decision making. It labels
the **common base**, **local (this machine)**, **GitHub (remote)**, and
**editable result** independently. Native compare is an inspection tool, not a
resolution decision. Moved files show their per-source and result paths when
the conflict record supplies them.

## Review workflow

### Recovered partial transactions

Before applying a service result (including a partial-conflict result), the Host
validates its transaction ID, target, repository, branch and pushed commit against
the checkout receipt. A stale result is rejected before updating Recipes, privacy,
Last Sync or conflict records. The result is retained for review, not automatically
replayed, acknowledged or used to clear a newer conflict workspace. A receipt
mismatch is a recovery blocker, not evidence that retained conflicts were resolved.

### Local validation blockers

A target status refresh carries a monotonic snapshot sequence; older overlapping
responses cannot replace a newer target, conflict, repair or paused-item state.
Target metadata is reread after asynchronous fingerprint/authentication work.
Reopening the Sync page waits for current metadata instead of briefly painting
cached failures. A newer successful runtime event suppresses superseded issue
cards while the full refresh arrives; genuine partial outcomes and newer
issues remain visible.

Repair buttons show pending text/spinners and disable duplicate actions for the
target. Pending state and inline status survive background rerenders. Only the
matching request's explicit success/cancellation/error completes the operation;
an unrelated state refresh or a late previous response cannot reset it.
Timeouts report that background work may still be running. Validation, pause,
Trash and resume return explicit outcomes; Sync queuing and successful completion
are also reported on the target card.

A local preflight failure (for example, a Skill with frontmatter but no body)
is not a three-way conflict: GitHub has not yet been fetched. Each issue offers
**Edit content**, **Pause sync for this item...**, and, for file-backed knowledge,
**Move to Trash...**. Do not fabricate an empty-body merge or treat an empty
file as permission to delete it.

Only Skill **documents** require Skill frontmatter/body. Legacy `_assets/` and
document-owned `Name.assets/` directories hold attachments, which may be ordinary
Markdown, templates or binary images. Directory-backed Skill bundles likewise
validate `SKILL.md` as the document, not every reference/script/image member.
All members still require matching digests, safe paths and the existing text
conflict-marker checks. Workbench candidates retain their recorded member role;
choosing/editing a resource must not turn it into a Skill document.

A purely local attachment addition with an unchanged common Remote normally
publishes without a three-way conflict. Distinguish that from preflight blockers:
**Local content needs repair. Remote has not been fetched.** means no comparison
with current Remote has happened. Do not resolve it by forcing Local/Remote or
adding fake Skill frontmatter to attachments.

Target cards retain the absolute Last Sync timestamp and append `h min ago`.
Only age text updates each minute; drafts, focus and scroll are not rerendered.
Missing, invalid and future-clock timestamps remain explicit.

- Edit and save the source, then **Revalidate only**. This uses the same local
  admission checks as Sync, without fetching, pushing, or queueing Sync.
  **Revalidate & Sync** remains a separate explicit action.
- Pausing requires confirmation and affects only this target. `pausedItems`
  overrides both explicit item and folder selections across privacy scopes.
  Local files, existing Remote bytes/tombstones, and the item's common Base
  are retained while unrelated entities can synchronize. Paused items remain
  visible with **Resume & revalidate**; resuming does not start Sync.
- Moving to Trash requires confirmation, a saved/unchanged source, and an
  exact-path MCP `knowledge_file_trash` request with the reviewed SHA-256.
  The shared Trash payload and deletion journal are preserved. A changed file
  is rejected rather than deleted; an unsaved editor blocks the action.
  No Sync runs automatically, but a later explicit Sync may propose deletion
  of the GitHub copy using the recorded evidence.

Pausing/resuming require this target's Auto Sync to be off. Trash removes a
shared local file, so Auto Sync must be off for every target; confirmation
explicitly describes the shared effect. Normal target-settings saves preserve
paused items; cancelling an approval changes nothing.

### Three-way decisions

1. Navigate the file list or use Previous/Next. The header counts unresolved
   decisions separately from explicitly saved and validated results.
2. Choose an existing side or edit the text result. Absent sides cannot be
   chosen as empty files. Merely opening a file or choosing a side does not
   validate or apply it.
3. For unresolved text skills and recipes, **Ask Agent** requests a proposed
   candidate from the integration. Review its rationale and structured review,
   then explicitly **Save & validate**. The workbench makes no model calls.
4. **Save & validate** persists a candidate in the resolution workspace only.
   Validation failures remain visible and retain unsaved text for correction.
5. Explicit deletion decisions require a confirmation. **Delete from synced
   result** means local deletion and removal from GitHub on the next sync.
   **Delete local only** leaves the GitHub variant unchanged. These decisions
   are stored and validated by the integration; no deletion happens before
   final apply.
6. Once every decision is saved and validated, **Review & apply all** requests
   a final confirmation before local acceptance and queuing synchronization.
   Local acceptance or queuing is **not** evidence of a successful push.

Unsaved result edits guard file navigation, side choice, native compare,
deletion, agent requests, refresh, and apply. Discard requires confirmation.
An unsolicited state update cannot overwrite dirty text. The browser also
registers a `beforeunload` guard, though VS Code may not honor it when disposing
a panel; save candidates before closing the tab.

Binary files and images never get a text editor or text decoding path. Choose
the original side, then explicitly save and validate the bytes. Safe image
previews and image downloads are offered when supplied by the integration;
other binaries use native compare to inspect/save the original bytes. SVG,
HTML, external-network previews, and arbitrary URLs are not embedded.

After `record.appliedAt` is set, the workspace is read-only except native
compare, refresh, and **Retry sync**. It clearly reports “Applied locally;
GitHub sync pending.” The integration keeps this workspace until queued sync
succeeds. No active record means the workspace is gone, not proof of a push:
the UI directs the user to GitHub Sync status for actual completion.

## Conflict entities and conservative merge

### Moved Markdown resource ownership

A legacy manifest may still assign an image to a Note's old path after the
Markdown document moves. Resource-only orphan groups can be reassigned to the
current Note, Skill or Research document only when one document with a valid
stable knowledge ID explicitly claims the old path as an identity alias, and
every resource has the same path, member role and bytes. This repairs ownership
metadata without replacing the canonical document or changing resource bytes.
Missing/invalid identities, absent or ambiguous aliases, changed resources and
groups that still contain a primary document are not proof of a migration.

When different Local/Remote entity owners share a destination and either owner
is blocked, their local writes/deletes and publication are isolated together.
An otherwise independent download must not overwrite bytes belonging to a
conflicted Local entity. Legitimate same-byte ownership reassignment without
blocked entities retains its existing behavior.

Candidate-ready means staged, not applied or pushed. Conflict workspace ID and
revision checks still reject stale actions before changing choices or files.
After a stale-workspace error, refresh and review the current record; do not use
Force, discard the workspace, or automatically replay the old Apply request.

### Partial publication and independent Bases

Conflicts no longer stop the whole target. A pure admission planner separates
ready entities from conflicted or unstable entities and their required Recipe
dependency groups. Case-insensitive destination collisions isolate all affected
entities. The blocked group's existing Remote bytes and tombstones remain
unchanged; only ready uploads, downloads and explicitly evidenced deletions
advance. Selection, privacy, System-content and ignore boundaries still apply.
Already-published ignored bundle members remain in the publication, not just in
the local checkout.

The target's `lastSync.commit` advances after successful host finalization.
`lastSync.entityBases` retains each blocked entity's older common Base under
`<content type>\0<stable identity>`; an empty commit denotes no prior Base.
The next attempt reconstructs these entities from their own historical manifests,
with the existing blob/digest validation. A successful unrelated push must not
become a conflicted entity's new Base, including after JSON persistence/restart.
Each target owns its acknowledgements; another target sharing the Knowledge Root
does not consume them.

Before push, the prepared tree is committed and pinned at the managed checkout's
`refs/pkm/outbox`. The `prepared` transaction receipt records that immutable
`preparedCommit`, per-entity snapshot descriptors and pending Base pins. The
`pushed` receipt is written only after CAS succeeds; `recorded` follows durable
host-only finalization. An unpublished prepared receipt cannot be acknowledged.
The ref retains the latest outbox through checkout reset/GC; it is a recovery
snapshot, **not** permission to blindly replay it. Retries fetch Remote again,
re-read Local and revalidate ignore/deletion/approval guards before preparing a
replacement. A post-push receipt failure reports that Git accepted the push and
does not reset the accepted checkout.

`GitHubSyncConflictError.partialResult` carries the successfully applied result
through service IPC, including binary Recipe guards and Base pins. The host
finalizes that result once, then persists the unresolved workspace. A failed
finalizer retains the raw recovery receipt. An acknowledged partial outcome
settles the owned queue claim, clears the ordinary failure budget and schedules
another interval; it does not disable Auto Sync. CAS contention uses eight
bounded attempts with exponential full jitter. Initial publication migration
retains its stricter admission boundary.

The dashboard labels this state **Partially synchronized: other content
continues syncing**. Saved candidates survive unrelated Remote commit changes
only when their complete entity snapshots, evidence and plan are unchanged.
Initial comparison previews still block background execution pending approval.
Normal conflict workspaces do not block unrelated progress. New publications
require `entity-partial-progress` and extension version 3.2.43 or newer; older
clients reject unsupported publications rather than silently discarding state.
Older schema-3 publications remain readable.

Stable reads compare file identity, size and timestamps before and after reading,
and check directory membership during traversal. ENOENT or a changing snapshot
defers the entire entity, without importing a partial bundle or inventing a
tombstone. Existing stable content errors still require explicit repair.
Filtering includes Hypothesis/Jupyter caches and precise PKM/editor staging
patterns, not arbitrary `*.tmp`, source, lock, native-library or data files.

Run `npm run test:github-sync-partial` for real bare-Git isolation, independent
Bases, immutable outbox/recovery, two targets, actual remote unavailability and
15 simultaneous replicas, plus scheduler/service/journal regressions. These are
isolated local Git tests, not production or Windows acceptance.

### Local deletion evidence and ignore scope

Normal filesystem-backed operations persist path-level intent in the Knowledge
Root's `.pkm/state/knowledge-deletions.json` before changing content. This covers
Skill, Note and Research direct deletion; Skill and general Knowledge Trash;
Markdown move/rename; folder rename, drag moves and container promotion.
Skill Trash empty/permanent deletion retains that intent. Restore/recreation
clears the destination's records, while a failed operation rolls back its
journal change. A partially rolled-back container promotion retains evidence
for the members that actually remained moved, rather than resetting the whole
operation's intent. Moving a Markdown item writes its destination before
removing the source; destination collisions and write/delete failures are
explicit and preserve the original source.

Intent is shared across sync targets, not consumed by the first successful
target. A present entity still uses stable identity and three-way reconciliation;
an old path record is not permission to delete that entity at its new path.
Both directions remain supported: a former receiver can edit and publish,
and delete-versus-concurrent-edit still requires review. Run
`npm run test:sync-operation-journal` for lifecycle and real local bare-Git
two-target/client convergence regressions.

This does not retroactively invent intent for historical missing files. External
filesystem deletions without a journal or matching Git evidence remain ambiguous;
they are not automatically restored or propagated as deletions. A file unchanged
on GitHub does not by itself prove why it disappeared locally.

An existing GitHub file is not an instruction to restore a missing local file.
For filesystem-backed entities, Sync also checks the Knowledge Root's local
Git repository (including a repository containing that root). An unstaged or
staged deletion is evidence only when the HEAD blob matches the synchronized
base and any remaining index entry matches HEAD. For a committed deletion,
the deleted blob in the deletion commit's parent must match the base.
Unmerged, skip-worktree, assume-unchanged, and divergent HEAD/index states
are not inferred deletions. Recipe records still use their explicit deletion
records rather than the absence of a filesystem export.

Verified deletion plus unchanged remote content propagates a deletion
tombstone. Delete-versus-edit remains a conflict. Git-backed evidence is checked
again before pushing; restoring the file or changing that evidence aborts the
push. Tombstones have canonical field ordering so repeated syncs do not create
commits merely to reorder deletion metadata.

Local Git ignore rules apply to uploads, automatic downloads, initial previews,
explicit restores, and the file/folder fingerprint UI. Git's `check-ignore
--no-index` also excludes already tracked paths; root/nested `.gitignore`,
negation, and configured Git excludes are honored. A root without a Git
repository uses a temporary isolated Git directory to evaluate its ignore
files without initializing or modifying the Knowledge Root.

Ignoring a path does **not** authorize remote deletion. Existing remote bytes
and manifest entries are retained, but are not restored locally or included in
local comparison fingerprints. Ignored members are preserved when other
members of the same bundle change. Removing a whole bundle with retained
ignored remote members is conservative: the remote bundle is kept for explicit
cleanup, not partially destroyed. Ignore changes detected before push abort
the attempt. Remove the ignore rule before explicitly restoring an excluded
file; a blocked restore reports the excluded paths.

A conflicting entity enumerates **every member**, not just the member that
first triggered the conflict. The resolution plan therefore includes the
complete Skill or Recipe bundle, with per-member common-base, local, remote,
and result paths. Safe independent edits to different members merge without
discarding either side's work.

Legacy remote text containing Git merge markers is admitted for comparison,
not accepted as a valid result. If it is unchanged from the synchronized base,
a clean local-only edit can repair it. Changed remote marker content is staged
as a conflict rather than imported. New managed candidates still require
marker-free validation before commit/push; unchanged isolated Remote bytes are
retained without pretending that they are a validated resolution.

Within a JSON member, the three-way merge combines independent object-field
changes relative to the common base. Recipe nodes are matched by `nodeId`, so
independent changes to different nodes can merge without relying on array
position. This is intentionally conservative: ordered arrays, conflicting
scalar changes, and delete-versus-edit changes remain human decisions rather
than being concatenated, overwritten, or silently resolved. The compiled
Recipe executable digest is recomputed for the resulting candidate instead
of retaining an obsolete digest from either side.

Rechecking unchanged snapshots preserves existing candidate choices. A
recheck is not an instruction to reset human review or replace a saved
candidate. Bulk side selection and bulk Agent resolution operate only on
unresolved candidates; already reviewed decisions are not overwritten.

Clicking **Recheck with Remote** immediately hides the previous dashboard
conflict prompt. While queued or running, the dashboard shows the current
attempt's actual phase rather than substituting Resolve conflicts merely
because a stored workspace exists. The workspace and saved decisions are
retained; a completed attempt that still has conflicts displays the prompt
again, while successful synchronization removes the stored conflict.

## Integration boundary

### Concurrent edits and interrupted operations

Target/apply/state locks publish a fully initialized, nonce-owned nonempty
directory atomically. Reclamation removes only a dead owner's observed member,
not a successor's directory contents. A live owner is never revoked solely
because a lease duration elapsed. Existing live legacy file locks are respected;
incomplete legacy records fail closed with an explicit timeout instead of being
treated as permission to enter. Upgrade all participating hosts/services to use
the corrected protocol; an older binary retains its old lock implementation.

Both regular-file apply paths verify the currently applied bytes before
rolling a member back. If an external writer has changed that member, rollback
leaves it untouched, reports the partial rollback, and preserves the original
and applied bytes plus a receipt in a private `pkm-sync-rollback-*` directory
under the OS temporary directory. The error gives its exact location. This
evidence is not an automatic restore instruction; compare it with the current
file before recovery. Unchanged applied members still roll back normally.

Recipe deletion carries the expected machine-local sync content alongside its
ID and managed path, including through service errors and durable recovery
records. The host validates the complete deletion batch against current Recipes
before moving any of them to Trash. Concurrent changes block deletion. Already
absent Recipes are an idempotent no-op; a legacy ID-only recovery record cannot
authorize deletion of an existing Recipe and reports missing version evidence.

Coordinator settlement binds pending-intent cleanup to the sequence observed
for that attempt. A new manual request accepted while an older request executes
survives that older request's failure or content-attention result; equal reasons
do not make distinct requests interchangeable.

`tests/test-github-sync-concurrency.js` exercises both rollback paths, a real
local-Git Recipe delete plus the host handler, failed/skipped/attention intent
settlement, and two-process lock publication. No production target is involved.

GitHub Sync scheduling and Git execution belong to the independent
[PKM singleton service](./pkm-singleton-service.md). Extension Hosts are IPC
clients providing authorization, catalog and UI/postprocessing callbacks; they
do not elect themselves as production Sync leaders.

`src/sync/github-sync-workbench.ts` exports:

- `GitHubSyncWorkbenchState`: the stored conflict record plus per-file text
  variants, a `binary` flag, optional MIME, and optional preview URIs.
- `GitHubSyncWorkbenchRequest`: `choose`, `delete-remote`, `delete-local`,
  `save`, `agent`, `apply`, `compare`, or `refresh`, with conflict ID, revision,
  and optional path/source/content.
- `openGitHubSyncConflictWorkbench(context, targetId, options)`: one panel per
  extension context and target. Reopening reveals it; an `initialPath` requests
  guarded navigation. Panel disposal releases listeners and subscriptions.
- `renderGitHubSyncWorkbenchHtml` and `escapeGitHubSyncWorkbenchHtml`: simple
  rendering helpers for focused tests.

The opener accepts `getState()` and `perform(request)` callbacks. Callbacks own
all filesystem, candidate validation, model, local application, lock, and Git
operations. A successful action is followed by a fresh `getState()` publication.
Errors are returned visibly; a failed action also attempts a fresh state read.
Callback changes do not affect an already-open panel's HTML or dirty buffer.

Every request includes the current conflict ID and revision (`0` for legacy
records without `revision`). The host performs basic shape and availability
checks; the integration independently verifies current ID/revision under
target-scoped locks and guards dirty external editors. These checks complement
the webview's internal unsaved-result guard. Stale or invalid requests are
rejected, not silently repaired or defaulted. Refresh is read-only; compare
uses `path` plus `source` against the candidate.

Text `save` sends the edited `content`. Binary `save` intentionally omits
`content`: validate the existing candidate bytes without decoding them.
Choosing a binary side must copy original bytes. Deletion callbacks must
validate the stored destructive decision. All actions returning successfully
must have completed candidate persistence/validation as appropriate.

Validation receipts are intentionally panel-session-local. Reopening an
unapplied workspace requires explicit save/validation again. Changes to a
candidate or its source invalidate its receipt; changing conflict ID clears
all receipts. Separately, the integration records a **SHA256 approval of the
saved candidate** and verifies that the approved bytes have not changed before
acceptance. Text candidates containing unresolved conflict markers are
rejected. Apply authoritatively validates the entire persisted plan, including
renamed members and bundle-wide constraints; UI receipts alone never authorize
filesystem changes.

Accepted workspaces persist with `appliedAt` until actual Sync success. Retry
queues synchronization of the already accepted decisions without applying
them locally again. A fresh coordinator can recover an applied receipt and
queue the pending sync only when there is **no recorded failure**. A recorded
failure remains visible and requires an explicit retry, preventing automatic
retry loops after restart.

The standalone `resources/github-sync-workbench.js` ships directly in the VSIX;
the host resolves it from `context.extensionUri/resources`, not the source tree
or a generated webview copy. The webview allows only local resource roots,
nonce-gated scripts/styles, and safe images; no third-party scripts, model
calls, or network connections are used. Text and attributes are escaped;
editor content is assigned through `textarea.value`.
The host workbench bundles its line-diff dependency at build time; installed
extensions do not rely on development `node_modules`. Build and VSIX gates
load the module and execute a comparison in an isolated directory.

### Highlighted differences and block picking

Text files present on both sides show a bounded line-based Local/GitHub
two-column comparison in the main workspace. The left file navigation is a
collapsible directory/category tree, with remembered folder expansion and a
Hide/Show file tree control to give the comparison full width. Common base is
collapsed by default rather than occupying a third comparison column.
Local blocks use the removed-text theme color and GitHub blocks
the inserted-text color, with explicit source labels, line positions and
unchanged surrounding context. Colors identify the source, not correctness.
Each difference has **Pick left** / **Pick right** buttons; the column headers
also offer **Pick all left (local)** / **Pick all right (GitHub)** for the entire
file. Picks change only
the editable draft; Save & validate and final Review & apply remain required.
The result remains editable after picking, allowing manual modifications before
saving the combined draft.
An empty side of a block removes that block, not the entire file. Whole-file
deletion continues to require the existing explicit destructive decision.

Block ranges are mapped onto the current candidate, preserving independent
manual/Agent edits elsewhere. Picks can be made out of order or changed again;
later ranges shift with the replacement. A candidate edit spanning difference
boundaries has no unambiguous mapping and disables the affected picks instead
of guessing. Typing in the result disables all further block picks until the
candidate is saved/validated and comparison positions are recalculated.
Dirty navigation, refresh, stale-state, save failure and applied-state guards
also cover these drafts. Binary files and absent whole-file variants retain
their explicit side/deletion controls, not text-block picking.

The comparison preserves line endings and missing final newlines. Calculation
is bounded by 200,000 characters and 12,000 lines per variant, 4,096 line edits,
a 75 ms calculation timeout per diff, and 200 difference blocks. Exceeding a
limit produces a visible explanation and directs users to native compare or
manual editing; it never truncates an accepted candidate.

## Focused validation

Run:

```sh
node tests/test-github-sync-file-safety.js
node tests/test-github-sync-workbench.js
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict \
  --skipLibCheck --target ES2020 --module commonjs --types vscode,node \
  src/sync/github-sync-workbench.ts
```

The executable suite transpiles the host with the existing TypeScript
dependency and mocks VS Code. Its browser DOM/event harness executes the real
standalone asset. It covers escaping/CSP, panel reuse/disposal, stale and
malformed requests, missing sides, error retention, double-click serialization,
save/validation gates, dirty guards, navigation, agent restrictions, binary
non-editability, safe previews, destructive confirmations, external candidate
changes, final apply, and applied-but-sync-pending retry. It touches no Git
remotes, model service, or KnowledgeRoot.

After the normal extension build, the integration regression suite can also
be run with:

```sh
node tests/test-github-sync-resolution.js
```

That parent-owned suite uses isolated two-machine Git repositories and calls
the actual extension accept function with a mocked VS Code host. It exercises
the resolution mechanism and local acceptance boundary separately from the
synthetic workbench/browser tests.

For real browser acceptance, use an existing packaged VSIX and a Python
environment with Playwright. No extra Node browser dependency is required:

```sh
WORKBENCH_TEST_PYTHON=/absolute/path/to/python \
WORKBENCH_TEST_VSIX=/absolute/path/to/personal-knowledge.vsix \
node tests/test-github-sync-workbench.js --chromium
```

Set `WORKBENCH_TEST_CHROMIUM=/absolute/path/to/chromium` when using an already
installed Chromium executable rather than Playwright's default browser. The
test loads the **actual resource bytes from the VSIX**, verifies they match the
implementation, and routes the synthetic renderer/asset entirely in memory.
Unexpected network requests fail the test. It runs real headless Chromium at
1440×1000 and 390×844, including real confirm dialogs, native browser textarea
behavior, image decoding, and overflow assertions.

Validation in flight disables the editor as well as action/navigation buttons,
so edits made after submission cannot be lost when the saved state returns.
Failed validation re-enables editing without erasing the submitted candidate.
Retry failures keep the applied-locally/sync-pending status visible alongside
the actual error.
