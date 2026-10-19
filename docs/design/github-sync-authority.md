# GitHub Sync authority controls

## Three distinct workflows

| Control | Authority | Effect |
| --- | --- | --- |
| Sync with Remote | Local / Base / Remote reconciliation | Pull, reconcile and optionally commit/push. |
| Force use Local | Selected Local projection | Overwrite selected GitHub content and delete selected Remote-only entities. Existing attributed audit commit and push lease remain required. |
| Force use Remote | Selected validated GitHub projection | Replace selected Local content, create Remote-only members and delete selected Local-only members. Never commit or push to GitHub. |

Restore snapshot remains a separate selective file restoration operation. It
does not delete Local-only content or establish a new reconciliation baseline.
The legacy `githubSyncForceUpdate` request name is retained for compatibility;
its visible label is now Force use Local.

Both authority controls require Auto Sync to be off. They never re-enable it.
Complete or roll back an active publication migration first. Force use Remote
may deliberately abandon an existing conflict comparison or Local repair issue,
but clears those records only after successful component and baseline application.

## Remote replacement workflow

1. Fetch a read-only snapshot in an independent Git cache. Validate the current
   manifest and exact blob digests, missing/omitted members, schemas, Script
   identities and tombstone consistency. Historical Base newline exceptions are
   **not** accepted as proof of current Remote integrity.
2. Select managed entities using the target's public/private item and folder
   selection. Preserve unselected, System and ignored content. An ignored Script
   identity member protects the whole entity. Refuse partial-scope entities,
   ambiguous identities and collisions with unselected or uncatalogued Local files.
3. Display the complete scrollable list of creates, overwrites and deletes in
   VS Code's native picker. Every entry must remain checked; unchecking an entry
   cancels the full-scope operation rather than silently changing its meaning.
4. Collect a required audit reason and explicitly confirm the counts and pinned
   commit. An empty selected Remote can mean deleting all listed Local-only content.
5. Reacquire the existing target and shared apply locks, rebuild the Local catalog,
   fetch Remote again and compare the preview. Root, repository, branch, selection,
   authentication, deletion intents, ignore boundaries, selected raw sources or
   Remote changes require a new preview. Unsaved affected file editors block apply.
6. Before mutation, persist original bytes and full Recipe records outside the
   Knowledge Root. Apply regular members with existing guarded atomic replacement
   and rollback; apply Recipes through the Project store, preserving editor layout
   on replacement and using Recipe Trash for deletion.
7. Only after component application, save the pinned commit as the target's Base
   and compute fresh Local fingerprints. Clear superseded selected deletion
   intents and old conflict/repair/failure records, finalize the audit, and refresh
   inventory/retrieval. An index refresh error is reported separately and retried;
   it does not pretend the applied recovery was rolled back.

Remote bytes use the [shared LF suffix rules](text-newline-rules.md) on Local
materialization. This never rewrites Remote. A later normal Sync may publish LF
for historical, byte-valid CRLF Remote content.

An arbitrary Remote can advance immediately after the final head check; that
cannot be locked across machines. Recovery applies exactly the reviewed commit,
not a silently retargeted version. Subsequent normal Sync reconciles any later
Remote advance against that pinned Base.

## Durable recovery evidence

Backups live under the extension's global storage:

```text
github-sync/checkouts/remote-authority-backups/<target-id>/<operation-id>/
  audit.json
  originals/<managed-relative-path>
```

The operation directory and original-file directories have private permissions;
original files are written with mode `0600` where supported. No backup is published
to GitHub. The result/error displays the exact backup directory. Deleting a target
removes its normal and read-only caches, but retains its recovery backups.

`audit.json` records the actor, reason, original existence and digests, target,
root, reviewed commit, plan digest and affected identities:

- `prepared`: backup was persisted; apply has not been recorded.
- `needs-review`: component application failed; inspect the error and actual Local
  state before retrying.
- `local-applied`: component application succeeded but baseline finalization has
  not been recorded. A crash or baseline error must not be interpreted as completion.
- `completed`: components, baseline and audit finalization succeeded.

Regular file mutation errors use the existing rollback path. A Recipe/component
failure can leave earlier file changes applied; backups and an explicit error
remain, and the old conflict/repair records are not cleared. There is no automatic
replay or automatic backup restore, which could overwrite new user edits.

For interrupted recovery, keep Auto Sync off. Inspect the audit and compare Local
content with its originals. Restore only the reviewed files to their managed
destinations (Agent snapshots map to `.pkm/state/agent-snapshots`), or generate a
fresh Remote preview to finish replacement. Restore Recipe records through the
Recipe library/store; copying their generated JSON into the Knowledge Root does
not update the Project database. Deleted Recipes also have the existing Recipe
Trash recovery path. The audit's existence flags identify files newly created by
the operation, for which no original backup exists.

This feature does not delete arbitrary untracked directories or bypass unreadable,
invalid identity, symlink or schema safety guards. Partial-scope replacement uses
normal conflict resolution or Restore snapshot instead.

## Validation

```sh
npm run test:github-sync-authority
```

Tests use disposable Local stores and bare Git repositories, not actual GitHub
targets. They cover core replacement and the actual production Host handler,
including confirmations, cancellation, stale previews, empty Remote, raw backup
bytes, Recipe handoff, Script moves/sidecars, privacy/ignore/System boundaries,
component/baseline failures, index retry and ordinary Sync after recovery.
Native Windows confirmation rendering and human dogfood remain separate checks.
