# GitHub Sync conflict workbench

The dedicated workbench replaces native-diff-only decision making. It labels
the **common base**, **local (this machine)**, **GitHub (remote)**, and
**editable result** independently. Native compare is an inspection tool, not a
resolution decision. Moved files show their per-source and result paths when
the conflict record supplies them.

## Review workflow

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

### Local deletion evidence and ignore scope

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
as a conflict rather than imported. Final managed candidates still require
marker-free validation before commit/push.

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
