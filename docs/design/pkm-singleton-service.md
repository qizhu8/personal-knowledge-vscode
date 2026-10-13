# PKM singleton service

## Boundary

PKM has one independent background service for each OS account, global-storage
location, and canonical Knowledge Root. Extension Hosts are clients, not
background leaders. GitHub Sync is the first migrated workload; the existing
Subscription Gateway, Chat Hub, and retrieval worker are not migrated by this
change.

The service owns the Sync coordinator, scheduling, durable queue, and Git
reconciliation/commit/push execution. Windows provide authenticated credentials,
the current catalog (including Project Store Recipes), and host-only UI,
privacy, inventory, and retrieval refresh operations. These are explicit client
callbacks, not a second coordinator. Credentials cross only account-private
local IPC and are never written into the service registry or queue.

The service identity does not include a workspace, window, or Extension Host
PID. Symlink aliases of the same Knowledge Root resolve to the same identity.
Closing a window disconnects its client; it does not dispose the service.
Without a compatible client, operations requiring host authorization cannot
proceed and must report that condition rather than silently succeeding.

## Lifecycle and upgrades

A shared transition lock serializes service discovery, startup, and upgrades.
Clients verify service identity, protocol, and version before sending work.
Older clients cannot downgrade a newer service or supply stale execution
callbacks. An upgrade drains outstanding work before replacing the service;
it never kills a running commit or push to make a newer window appear ready.

The singleton uses the existing Sync coordinator state as a migration bridge.
It takes the legacy leader lease only after live legacy work drains. Its
service PID then maintains that lease, so already-running legacy windows
become followers instead of continuing to execute Sync. The fencing token
advances during takeover. This is a compatibility boundary, not a second
independent election domain.

The old coordinator implementation remains for state compatibility and direct
unit tests, but production Extension Hosts instantiate service clients rather
than coordinators. It is not sufficient to check the installed extension
version: runtime diagnostics must also identify the actual service executor.

## Safety

IPC uses an account-private local endpoint, not a public HTTP server. Startup
and replacement validate endpoint ownership; unsafe directories, mismatched
identities, malformed messages, and protocol/version mismatches produce
explicit errors. Payloads and waits are bounded, and pending calls fail when
their connection is lost.

Completed Git results survive a client disconnect in private recovery receipts.
A reconnecting client checks the original target, repository, branch and
execution reason before applying host-only postprocessing. Success recovery
also verifies the existing transaction receipt; conflict recovery persists the
full conflict workspace before acknowledging the service receipt. Recovery
does not perform another Git operation. Missing metadata or changed target
endpoints leave the receipt intact and report a review requirement.
Progress callbacks restore the original assigned execution context before
reporting phases. A host that has durably recorded an ordinary raw Sync error
acknowledges its error receipts before returning failure; only genuinely
unhandled results produce the unfinished-postprocessing recovery warning.

Recovery staging is created with an exclusive writable descriptor, written,
flushed with that same descriptor, closed, then renamed. Write/flush/rename
failures cannot replace the original Sync error: a typed
`PkmServiceRecoveryPersistenceError` transports both redacted errors, including
their stacks/codes, operation/target IDs, persistence stage, and transaction
reference. Diagnostics explicitly state that no recovery result is available
and disable automatic retry. A successful raw Sync with failed persistence is
not a successful host transaction and must not be blindly replayed.
Only successfully published result records can produce a recovery notice.
An old transaction receipt is not evidence for a newly failed operation.

All Sync Git commands already pass `-c core.longpaths=true`, including initial
clone. Managed checkouts also persist `core.longpaths=true` locally before
worktree inspection, so direct diagnostics use the same path handling.
This does not change the user's global Git configuration or reset a dirty
checkout. Windows path failures must not be interpreted as user deletion.

The existing target lock and cross-target local-apply lock span the host
transaction, including its service call and postprocessing. Conflict variants
retain exact bytes over IPC; typed conflict and extension-compatibility errors
are reconstructed for the existing resolution workflow. Saved human choices
are not cleared merely because service ownership changes.

## Automatic triggers and feedback

The Auto switch updates immediately with a pending indicator. The host
acknowledges persisted settings before expensive catalog and shield scans.
Errors roll back the pending view and display the failure. Turning Auto off
while a synchronization is active allows that transaction to finish, but
cancels subsequent automatic work.

Periodic fetch and sync-on-change are independent: the configured interval
checks GitHub even when local content is unchanged; selected content changes
use a two-second debounce. Watcher events are only hints. Before a change job
enters Git execution, the host checks an ignore-aware snapshot of selected
bytes, entity identity, privacy, and pending deletion records against the
local input snapshot of the last successful attempt. Unselected files,
mtime-only writes, and unrelated project/session state cannot repeatedly
start Git. The local input baseline is separate from the remote manifest:
preserved remote-only or built-in content must not look like a new local edit.
Capturing input before Git execution keeps edits made during synchronization
eligible for a follow-up. Existing targets bootstrap this local baseline on
their next successful sync. Skipped change events do not delay periodic fetch.

## Validation commands

```sh
npx tsc -p tsconfig.json
node tests/test-pkm-service.js
node tests/test-pkm-service-integration.js
node tests/test-github-sync-coordinator.js
node tests/test-github-sync-resolution.js
node tests/test-github-sync-file-safety.js
node tests/test-github-sync-ui.js
```

The actual VSIX must also start the service outside repository `node_modules`.
Tests must verify independent process execution, shared identity across two
clients, rejecting old-client mutations, drained upgrades, legacy takeover,
and binary/error preservation, not just source-code patterns.

The service test records a native read-only/writable fsync probe and injects
write, fsync and rename failures for both raw-success and raw-error outcomes.
File-safety tests construct checkout paths of exactly 274, 294 and 300
characters and cover a new clone, an existing checkout, a real edit and an
unchanged repeated Sync. The existing CI matrix runs on Windows, Linux and
macOS. Passing these tests on Linux is not Windows runtime acceptance.

For the reported Windows machine, keep Auto off until manual acceptance:
update the extension and reload the window, confirm the actual service
version, retain its diagnostics and transaction receipts, then run normal
manual Sync. Confirm that long files are no longer false deletions and that
the resulting remote commit, new transaction ID, lastSync and cleared failure
agree. Repeat without edits to verify no extra commit. Do not force-update or
reset the checkout to bypass another error.
