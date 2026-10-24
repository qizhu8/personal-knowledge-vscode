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

## Offline and disconnected hosts

The independent Sync service can outlive every VS Code window. If no protocol-compatible
host is connected, automatic checks wait at the configured interval without
consuming failure attempts or switching off Auto Sync. A host lost before the
execution callback starts is handled the same way. Reconnecting a compatible host
allows the next scheduled check to proceed without toggling Auto again.

Recognized DNS/connection failures during Git clone/fetch also remain visible
as deferred checks, preserving the Auto setting and retrying at the configured
interval. Authentication, configuration, conflict and content-repair failures
keep their existing bounded retry/review behavior. A lost push response or a
host lost during execution is not proof that no mutation occurred: those
operations are not classified as safe deferred reads or automatically replayed.
Existing disabled targets are not silently re-enabled; they may have been
deliberately paused by the user.

## Durable intent admission

The coordinator dispatches each persisted intent sequence once while it waits on
host preflight. Polling must not enqueue another copy of that same request.
Under the coordinator lock, the scheduler verifies the current leader and claims
the exact sequence that was checked. An unclaimed request superseded by a newer
or higher-priority intent, or removed by an Auto pause, is skipped before any Sync
execution; it is not recorded as a failed GitHub operation and does not consume
the automatic failure limit. The newer intent remains pending.

A new same-reason sequence submitted during an active claimed run is still a
distinct follow-up. Completion of the older sequence cannot erase it. Leadership
and fencing checks remain mandatory; no uncertain in-flight work is replayed by
this admission deduplication. Existing historical failures and user Auto settings
are not cleared or retried automatically.

## Credential storage and visible failures

VS Code credential reads have a 10-second deadline, including account checks
used to render the Sync dashboard. A timed-out read never resumes Sync when its
RPC eventually returns. It does not delete credentials or automatically launch
sign-in. A failing account check is returned separately, so one unresponsive
target cannot suppress other targets or their synchronization errors.

Failed attempts retain `errorCode` and `phase` alongside the message and existing
retry count, through target normalization, scheduler state and service IPC.
Collapsed target cards show the code, failed phase and actionable message once.
The authentication phase is restored after reload, not replaced by a generic
failure diagram. The diagnostic event also contains `errorCode`.

- `CREDENTIAL_READ_TIMEOUT`: credential storage did not respond within 10 seconds.
- `CREDENTIAL_READ_CANCELED`: VS Code canceled credential access; this alone does
  not distinguish host shutdown from another cancellation.
- `CREDENTIAL_READ_FAILED`: credential storage raised another error.
- `CREDENTIAL_MISSING`, `CREDENTIAL_INVALID`, `CREDENTIAL_ACCOUNT_MISMATCH`:
  reconnect the expected account using **Test Account**.

For storage timeout/cancellation/failure, reload the affected window and explicitly
retry Sync. These failures occur before GitHub Fetch/Push and are not evidence of
an expired token or GitHub permission denial. Existing retry limits and Auto
intent are unchanged. Historical bare `Canceled` records display `SYNC_CANCELED`
with a retry hint; they are not retrospectively assigned an authentication cause.
These bounds cannot retrofit a call already hung inside an old Host.

## Protocol compatibility and installed-version advisories

The Sync daemon checks the installed extension registry every five seconds.
A newer installed version gives a deduplicated update/reload advisory; it does
not automatically drain a healthy compatible service or disconnect its hosts.
Admission uses `pkm-github-sync/1` and advertised operation/callback capabilities,
not exact extension version equality. Unsupported advertised operations fail
before submission while supported operations remain usable.

New clients can also register with an original protocol-v1 service: discovery
detects its legacy version-bound wire contract, opens an explicitly adapted
connection using that wire version, and sends the actual host version separately
in registration. This adapter neither changes the service's identity/version nor
replays a business operation. Identity, nonce, private IPC, protocol checks,
execution ownership and fencing tokens are unchanged. A different protocol or
malformed capability declaration is still an explicit error.

An explicit administrative drain waits for current execution, durable result
persistence and host postprocessing. The monotonic version pin still prevents
starting older daemon code over newer state; it no longer prevents an older
compatible client from connecting to a live newer daemon. When no daemon is alive,
an older compatible Host can start the verified current installed service entry
from the existing extension registry, rather than requiring a same-version
window. The child still uses its own actual installed version and must pass
protocol/capability discovery before registration. This does not forcibly
reload any window, replay uncertain writes, clear recovery receipts, or change Auto Sync intent.
Installing a VSIX alone is not evidence that every existing window runs it.

Drain admission is fenced before stopping. Its barrier counts live Host RPCs
and active executions (including raw Sync and Host postprocessing), not the
persisted runtime display: an old `syncing/authenticating` observation alone
cannot pin an idle daemon. A scheduler disposed while awaiting preflight or
durable admission cannot start a late execution. No pending/uncertain write is
replayed or inferred complete from display state.

An idle daemon with no compatible client also drains itself if its entry,
ownership metadata, or Unix socket has disappeared. An ordinary offline daemon
with intact installation and IPC ownership continues waiting for reconnect.
Missing or ambiguous installed-build evidence never authorizes a version upgrade.
Already-running old Hosts and daemons cannot acquire new client/monitor behavior
merely because files on disk changed. They need to load the new implementation
once through normal lifecycle controls; installation alone is not proof of that.
Idle disconnections are advisory and reconnect without replay; disconnection with
pending operations or active callbacks remains an explicit uncertain-work error.

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
# Sync Status and Historical Publication Scope

Sync status compares current selected bytes with the last successful publication,
not merely whether a file exists remotely. Yellow may indicate a retained
historical publication outside the current privacy scope; it is not proof of
failed backup. Changing a folder to private does not erase previously public
files or Git history.

Built-in Recipes are not user-synchronized content. Status computation excludes
historical baseline records by the current built-in Recipe identity, including
old paths/categories, so those records do not create false pending markers.
This is a status-only filter: it does not delete remote copies or rewrite history.
Historical public user content, including private MyIdeas, remains visible as a
publication discrepancy until separately reconciled.
