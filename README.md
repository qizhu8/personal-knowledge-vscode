# PKM v5 codebase

This repository root is the new PKM codebase on the `pkm-v5` branch. The
former `next-server/` sources now live directly in `src/`, `tests/`, `clients/`,
`compat/` and `compute/`. No production Knowledge Root or service is switched
by this source migration.

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck:client
```

The normalized test entrypoint is `npm test` (bounded unit regressions).
See [tests/README.md](tests/README.md) for suite groups, selected Node/Python
files and repository-external automatic fixture cleanup. The previous default
verifier is preserved as `npm run test:qualification`; its historical capture
and provenance gates are unchanged and it is not part of the fixture runner.

Compatibility workflows and original-source test oracles use the frozen
`legacy/` snapshot. Restore its dependencies and build it explicitly:

```sh
npm --prefix legacy ci --ignore-scripts
npm run build:compat
npm run test:smoke
```

`legacy/` is not a second product to maintain or publish. Its source hashes
are recorded in `legacy/snapshot.json`; new implementation work belongs in
the root sources. Test fixtures and original-source provenance still require
these files, and selected runtime compatibility adapters require their compiled
modules.

Historical migration manifests and evidence have not been requalified for this
layout. They retain their original paths and hashes. The original implementation
already fails five cases in the server/library slice (writer-fence marker,
source pin, symlink diagnostic and owner-lease recovery); the relocated slice
reproduces those failures. A successful build or smoke run does not establish
full migration acceptance. Old frozen test packages, logs and isolated data
copies were intentionally retired; retained summaries are not recoverable
test environments and do not requalify the historical captures.
The additional resource/subscription slice passes 28 functional cases, while
its original-source hash check remains stale. The experimental Sync host test
is blocked by active or uninspectable hosts on the shared machine. Both
remaining failures were reproduced in the original layout; no process was
stopped to bypass that gate.

## Historical implementation and qualification notes

The notes below describe the migration work before the repository-root move.
References to the former extension layout and private test artifacts must not
be treated as qualification of this branch.

### PKM Next Server - isolated foundation

Experimental, standalone Node/TypeScript Core. This package does not participate in
the current extension's build, startup, configuration or installation. It does
not automatically import the legacy Knowledge Root. Do not point it at existing
PKM data; the offline import tools below are for quiescent disposable copies.

## Full migration progress

The full migration is **not complete**. See [MIGRATION.md](./MIGRATION.md) for the
persistent workstream checklist, old-source scope and remaining acceptance gates.
The acceptance target is preservation of existing PKM functionality and behavior.
For PKM Chat, the user also requires that work continue toward stated acceptance
criteria rather than stopping at partial progress or repeatedly asking permission
to continue. This is an acceptance requirement, not a claim that every Chat
execution path already enforces it.
Migration implementation is coordinated across delegated Memory, MCP coverage
and managed-client work. Integration acceptance requires a usable imported
workspace and actual client operations, not just preserved files or a successful
test slice. Technical gaps remain implementation work; stop for operator input
only when an explicit authority or behavior decision is required. A migration
rehearsal does not authorize switching production services or the real root.
The approved write-compatibility policy preserves stable identities, revision
history and links. Original writers that replace frontmatter and drop these
fields are not reproduced destructively. This is an explicit approved behavior
difference, not a claim of byte-for-byte legacy writer parity; other contracts,
authorization, conflicts and recovery still require verification.
The explicitly requested removal of Notes/Board count and byte ceilings is an
intentional relaxation, not a feature deletion or a requirement to reproduce the
former ceilings. Proposed soak/resource/power-loss thresholds and operating
decisions are tracked separately from functional parity; final cutover still
requires explicit human authorization.
Todo Board discovery scans the complete Notes collection; large paginated
responses warn but are returned in full rather than rejected by a fixed
response-size ceiling.

### Required release migration acceptance

The release target is an automatic upgrade for users who already have the old
PKM installed: on both Linux and Windows, the new server takes over that user's
existing configured Knowledge Root without asking them to select paths or
manually import data, and all existing PKM workflows remain available. No
workflow is intentionally deferred. Migration tests may use an isolated copy
of real data or fixtures only; they must not modify the production Knowledge
Root or perform a production service cutover.

The current Next server does **not** meet this target: `Storage.open()` requires
a Next-initialized workspace and rejects legacy roots, while the existing
first-run importer copies a disposable legacy root into a separate new
workspace. Only an unqualified, synthetic-fixture in-place lifecycle slice is
implemented; automatic upgrade takeover of an installed legacy Knowledge Root
is not implemented.
The bundled `inspect-legacy-root --root <absolute-path>` command is read-only
inventory only. Its versioned report always has `ready: false`; content
fingerprints and recognized import inventory do not prove writer isolation,
complete workflow parity, identity continuity, or a recoverable in-place
cutover.

Ordinary Linux activation now schedules that same read-only inventory for the
already configured root in a separate process, without a path picker, new root,
session creation, drain, or server startup. An already provisioned managed
session is enrolled separately as described below. **PKM: Check Original-Root
Upgrade Status** reruns it and shows blocker counts; its hidden status command
returns the last result. The packaged payload is verified using the existing
payload verifier before the inspection. The host runtime must provide Node
22.18 or newer; an unavailable, changing, or invalid root/payload leaves the
assessment unavailable and existing workflows unchanged. Only blocker codes
and counts, not inventory content, are returned to the extension host.
Inspection never grants adoption, and its result is not a lasting snapshot or
proof that writers are stopped. The extension binds each inspection to the
configured directory's device and inode before and after the child process,
and reports the result unavailable if that binding later changes. A managed
profile observation retains its own original binding even after a new
inspection. This rejects an observed replacement, not a transient swap or a
concurrent writer.

Ordinary activation already creates a local `HostWriterAdmission` and publishes
a host registry entry when observation is available. The **PKM: Drain This
Window's Managed Work and Reload** command requires a trusted workspace and an
explicit VS Code modal confirmation bound to that host, root and profile-storage
directory. It closes the current host's enrolled admission, drains its Chat and
local retrieval activity, and requests a window reload even if drain failed so
the window can recover. A failed drain or reload remains unknown. The registry
is discovery, not authority: this command does not drain other windows, already
running MCPs or unregistered writers, prove successor readiness, or authorize
original-root adoption. No drain or reload occurs on activation or cancellation.
Hosts already bound to a managed writer session cannot use this local command;
their existing profile lifecycle remains responsible for drain and restart.
Current compatible-aware unbound retrieval clients reject work after a compatible
session appears; therefore ordinary activation must not automatically create
that session merely to obtain enrollment. The original 4.0.22 launcher and a
compatible-aware current client are different compatibility cases. The
`compatible-existing-client.log` test keeps the same unbound client process
alive across bootstrap and observes its successful pre-bootstrap retrieval
becoming an admission denial afterward.

On Linux, **PKM: Ask Registered Windows to Drain and Reload** can route a
short-lived request to registered hosts sharing this installation and profile.
Each matching window must separately confirm its own existing local drain
modal; cancellation does nothing. Root device/inode and host IDs route the
request, but registry data is not trusted authorization or a drain receipt.
Requests can be overwritten, and old, unregistered, other-profile or
unavailable hosts may not receive them. Neither the request nor a reload
proves complete writer coverage, a successor, or unified-owner handoff; it
does not start or authorize Next. Managed-session hosts retain their existing
lifecycle and do not process these local requests.

An explicitly provisioned managed session has a separate experimental route:
each targeted registered host must confirm and drain its own enrolled work.
After a further modal, the coordinator validates the exact registered profile
set and each host's Root/profile-bound completion and confirmation under the
session lock, then fences new session admission. The enrolled Sync service
observes the fence, waits for its own active work and completes its durable
operation. The coordinator waits for **all** registered operations; a failed,
crashed or timed-out participant leaves the session fenced and its outcome
unknown, without replay. A fence can interrupt clients of the same Sync
service; the confirmation says so. Routing and same-user receipt files are
not cross-process authentication, a census of legacy/external writers, a
profile-exclusive grant, or authority to adopt a root. Next's strict session
inventory accepts a confirmation only when it matches a completed profile
operation in the verified rotation chain or current fenced session, and its
Root/profile directory pins still match. The confirmation is inventoried and
fingerprinted, not used as authorization; malformed, unmatched or changed
records remain blockers. Complete rotation history, the current fence and the
independent writer and snapshot gates are still required.
Profile completion now requires its original locally issued registration and
process/Root identity; a confirmation additionally requires that registration's
actual bound host admission to be drained. A copied record or an unbound host
cannot manufacture a confirmed drain. This strengthens the local participant
only: durable cross-process records are still not cross-host authentication.

The focused `root-managed-coordination/focused-v5.log` run passed 27 tests:
two registered child processes held admitted work, actually wrote Notes before
their drains completed, and fenced only after independent confirmations. It also
covered a real managed Sync service drain and crash-to-unknown. These are
process tests, not the requested installed dual-Code adoption/restart journey.
`focused-v6.log` reran the same 27 cases with Next's strict rotated-session and
privacy inventory enabled, including tampered and missing receipt rejection.
The first run (`focused-v1.log`) failed two Sync cases because its isolated
compiled output lacked the package manifest; `focused-v2.log` records the
rerun with the manifest available, not an unexplained pass.

The installed 4.0.22 Note editor's `saveNote` calls `noteUpsert`, which writes
the original Root's Note. An old, unenrolled window can therefore race an
adoption even when the enrolled hosts have drained. Environment Refresh and
MCP runtime maintenance have separate profile/runtime writes and need their own
coordination; Snapshot status approval does not authorize them. No production
default is switched by the isolated experiment.

The private `root-snapshot-live/journey-v1.log` and `journey-v3.log` exercised
two actual Code host drains, a successor rotation and fence, and the native
status-only Snapshot approval. Adoption was refused before Next started because
the coordinating Code host could not be inspected. In this VS Code build the
forked host's actual entrypoint is not present in `/proc/<pid>/environ`; that
file cannot authenticate another utility process's role. `journey-v2.log`
stopped earlier on a test-control JSON race, subsequently fixed in the private
driver. Each run's scoped shutdown reports zero remaining captured processes.
Treating every Code NodeService as a blocker is only a conservative
experimental limitation, not an acceptable permanent upgrade policy. A
verifiable way to coordinate known PKM hosts while clearly presenting unknown
external risk remains necessary; no unverified process or privacy gate has
been waived.

`node .migration-test-work/root-multi-host/journey.mjs` exercised two real
private Code extension hosts after a 4.0.22 Note was created. Both hosts
independently confirmed, including one cancellation followed by a new request;
two profile completions and confirmations were written. The final fence was
correctly refused because a real Sync service operation was still pending
(`root-multi-host/code-journey-v1.log`). A later test-overlay session fenced
before waiting for Sync, but its actual service startup failed and the pending
operation remained unknown (`fence-v3/code-journey-v3.log`). The v3 private
harness used `/proc/self/cwd/home`, which changed meaning when the service
changed working directory. `fence-v3/bundle-cwd-test.log` reproduces this
failure with the real bundled daemon and shows a stable controller-relative
private HOME starting and completing it. This isolated diagnosis does not
qualify a production upgrade or other failed journeys.

With the same frozen overlay and the corrected private HOME,
`node .migration-test-work/root-multi-host/fence-v3/journey-v4.mjs` exited
successfully: two real extension hosts independently confirmed, the enrolled
bundled Sync service reached `DRAINED` and wrote its matching completion, and
the exact session returned drained with external coverage unknown and cutover
unauthorized (`fence-v3/code-journey-v4.log`). The old Note was created by
4.0.22 in this isolated installation. This is not a Next owner, adoption,
post-fence Note workflow or coverage of unregistered writers. Scoped cleanup
and process-scan evidence is retained in `fence-v3/cleanup-v4-final.json`.
The later Environment host-fence additions were not in that frozen overlay.
An offline regression used two actual registered host processes to confirm and
drain, then rotated and fenced a successor session and inspected both retained
confirmations; changed profile IDs, directory pins, operation IDs, extra fields
and missing completions were rejected. It is not a Code-to-Next adoption.
The retained v4 session itself has not been rotated and remains rejected by
Next's complete-rotation requirement.

The separate managed Environment host-fence interface checks a same-process
issued registration, host admission, session, Root/profile identities and
scope on every assertion. Its host signal synchronously denies on local drain;
another process's session fence is observed on assertion, not delivered as a
synchronous signal. It is not connected to ordinary activation, and does not
provide an exclusive profile writer, effect consent or Next-owner authority.
The experimental **PKM: Check Managed Original Environments** command visibly
reports unavailable and starts no profile access or Refresh: the actual host's
independent Environment scope, close barriers and profile-writer authority are
not yet connected. A managed-host registration or test fixture cannot replace
those prerequisites.
During a real Environment completion, only the synchronous current-host
assertion can reuse that completion's already-held same-session lock; its
identity, nonce and live scope are rechecked. This is not a general reentrant
lock exemption.
Source-only verification of the router and two independent admissions
(`tests/test-host-drain-requests.js` and `tests/test-managed-host-reload.js`)
is retained in `root-upgrade-validation/host-drain-router/tests.log`: 6 passed,
including one host cancelling while the other waits for enrolled in-flight
work. The broader rerun with both historical fixtures configured is
`host-drain-router/tests-final-fixtures.log`: 37 passed, none skipped.
`node .migration-test-work/root-upgrade-validation/host-drain-router/journey.mjs`
also ran against the original 4.0.22 and a private 4.0.859 test overlay:
`installed-two-window-v3.log` records two real same-profile Code windows,
separate modal confirmations, two new local owners after reload, and the
original Note plus both successor writes on the same root inode. Automated
fixture clicks confirmed the UI and workspace trust was disabled in both
windows. Each admitted count was zero; the registry included a stale third
entry, and no remote drain ACK or unified owner was established. This
therefore does not qualify controlled in-flight legacy-writer draining,
cross-host authority, crash recovery or adoption. The v1 second-window trust
setup failure and v2 stale-count assertion failure remain in their logs. The
v3 overlay predates a subsequent staging-file cleanup fix; the final source
and shared-parent tests were rerun as
`shared-parent-scope/final-all-tests.log` (41 passed, none skipped), but that
final source has not been installed in Code.

Focused source verification used `./node_modules/.bin/tsc -p tsconfig.json
--outDir .migration-test-work/root-upgrade-validation/managed-host-reload/dist`
followed by `PKM_TEST_DIST="$PWD/.migration-test-work/root-upgrade-validation/managed-host-reload/dist"
node --test tests/test-managed-host-reload.js tests/test-managed-host-drain.js
tests/test-host-writer-admission.js`: 32 passed, 2 optional historical fixtures
skipped, no failures. The output is retained in
`.migration-test-work/root-upgrade-validation/managed-host-reload/focused.log`;
the final scoped rerun is `focused-v4.log`.
The two skipped tests were **admission preserves actual legacy root and .pkm
permissions on an isolated copy** (no `PKM_INSTALLED_LEGACY_FIXTURE` supplied)
and **original 4.0.22 Git queue commits inside a writable root with an
unwritable parent** (no `PKM_ORIGINAL_VSIX` supplied). Both were subsequently
run, not counted as passes in the original run: using the retained v4
old-to-current isolated root as the copy source and the original 4.0.22 VSIX
respectively, `previous-skips-run.log` records 2 passed, 0 skipped. The first
fixture had already been opened by the newer test overlay; it is not an
untouched 4.0.22-only installation.
The installed private-Code journey remains separate from this source evidence.
`node .migration-test-work/root-upgrade-validation/managed-host-reload/journey.mjs`
in a private PID/network namespace, private VS Code profile and disposable
root produced `installed-journey-v4.log`: installed 4.0.22 wrote a Note,
the independent 4.0.859 test overlay discovered its local host, a real modal
was confirmed, and `reload-requested` was followed by a new accepting host
on the same root inode and a Note read/write using its canonical path. This
fixture disables workspace trust rather than testing its UI. Both host
identities report incomplete coverage and no cutover authorization. This
is not a standard release package or a Next adoption. Earlier v1 (wrong
settings scope), v2 (driver saw reload cancellation) and v3 (direct old-slug
Note upsert collision after restart) failures remain in their own logs.
The v3 old-slug mutation failure is not covered by the v4 canonical-path save.
An independent Markdown asset import regression was also reproduced: the
shared Linux fence previously failed before import when the requested new
destination root did not yet exist. Import now creates that canonical root
before taking the unchanged fence; symlink ancestors remain rejected. The
isolated `markdown-assets-regression/before.log`, `after.log` and `alias.log`
retain the failure and passing legacy asset/Note regressions.

The missing default upgrade code remains: automatic reliable enrollment of
all existing writers and named profiles; a controlled handoff after *every*
legacy writer is stopped, including preventing old/external writers from
restarting; a qualified full-workflow and identity-preserving same-root
transition; production crash recovery and rollback; and routing ordinary
extension/MCP workflows to the adopted Next server. Current Linux quiescence
checks also treat running VS Code extension hosts as blockers, including the
host that initiated the check. Closing all legacy VS Code, MCP, Sync and other
writers is necessary for the existing experimental adoption check, but is not
sufficient authorization for production migration. There is currently no
supported user action that completes production original-root cutover; keep
using the existing workflows. The synthetic adoption commands are not an
upgrade workaround.

### Linux legacy-writer handoff boundary

The published 4.0.22 managed MCP maintenance marker fences calls in that
managed profile, and quiescence drains one connected process. Neither covers a
different profile writing the same root or older uninstrumented MCPs; the Next
`flock` does not stop those writers. The published extension also overwrites
and unconditionally removes its maintenance markers during runtime repair, so
their presence is not an owned durable lock. Do not treat a process scan,
drain callback, or maintenance marker as authority for root cutover.

The installed 4.0.22 extension registers a VS Code MCP provider and, separately,
can register a persistent Copilot CLI stdio command. Automatic integration
maintenance can regenerate the managed launcher, but published compatible
generation transitions intentionally allow already connected old processes to
continue accepting calls. Replacing a generation is not process replacement:
client reconnect, a separate profile or a saved direct command can launch a
different writer. A verified, owned connection can be quiesced and closed, but
a lost connection or uncertain in-flight operation still requires review.
The 4.0.22 Chat's bundled stdio transport waits after closing stdin and then
escalates to SIGTERM and SIGKILL if its child does not exit; its `close()`
alone is not proof of a signal-free, completed process exit.
Current source Chat closes admission, verifies its own instance drained, sends
stdin EOF and observes its owned child exit with code zero and no signal before
completing closure. A timeout does not signal the process and permits a later
exit observation; it does not replay a call. This depends on the SDK's current
owned-process handle and fails closed if that handle is unavailable. Before
preparing a changed managed generation or extension build, Chat drains its own
previous connection, then prepares and handshakes the replacement. This only
covers that Chat-owned connection, not other VS Code providers or clients.
An isolated VS Code 1.143 test of the actual 4.0.22 VSIX traced the earlier
60-second quiesce timeout to an unanswered VS Code confirmation, **before**
`tools/call` was sent. Concurrent status requests reached the same instance and
remained accepting. After explicit approval in the private fixture, the original
server returned drained, the VS Code stop command stopped it, and an explicit
start command produced a new instance of the same generation. A separate real
stdio test with the 4.0.22 middleware held a write in flight: quiesce counted
the write but not its own control call, rejected new work, and drained only
after the write completed. A repeat using a copied pre-overlay 4.0.22
generated launcher held an actual Note mutation, confirmed it completed before
the drain receipt, then closed the client and observed its exact child exit
with code zero and no signal. This is a client-owned stdio child, not the
VS Code-owned provider connection.

An isolated 4.0.22 to 4.0.70 **overlay**, with the editor stopped for
installation, automatically started the provider on reopening and read the
original Note. The extension reported 4.0.70, but its MCP process still
reported 4.0.22 and the original generation, including after 12 seconds.
This is not evidence that the new MCP runtime was deployed or that Next
automatically took over. The 4.0.22 VSIX contains lifecycle controls; static
inspection of the available 2.7.32-dev VSIX found no quiesce symbol. Do not
assume an older or differently generated server supports this handshake.

A future VS Code handshake must retain the real confirmation and bind status,
drain and stop to the same live owned connection; cancellation or timeout must
be treated as unknown, not as approval or proof of drain. Tool names, caller
attribution and a stop command returning are not an ownership fence. A VS Code
lifecycle-tool adapter now translates bounded cancellation and
responses into the existing coordinator, but requires its caller to supply an
independently verified live binding and exit observation. The coordinator passes
the verified generation, instance and runtime-build identity to that stop
implementation; these values alone cannot bind a VS Code stop operation.
The adapter is not
wired into automatic activation or the production provider; tool discovery alone
cannot supply that binding. A private single-profile 4.0.22-to-4.0.70 overlay
journey injected that adapter into a fixture driver: the real VS Code
confirmation was accepted, the old instance drained and exited, and the old
Note remained readable. This was not an automatic activation, a Next provider,
a Note write or a two-profile test; its fixture PID checks are not a general
ownership proof. The installed VS Code 1.143 stable API exposes
tool names and server definitions, but no live server or process handle on
`LanguageModelToolInformation` or `McpServerDefinitionProvider`. This does not
by itself rule out another supported binding mechanism. In the installed
1.143 workbench, `workbench.mcp.stopServer` looks up the current server by
definition ID when it executes; it does not accept a captured connection or
instance ID. A prior status/attribution check cannot prevent that target
changing before the stop. In an isolated real VS Code 1.143 / installed
4.0.22 test, a user-approved drained instance A was stopped, a new instance B
was started under the same definition ID, and a subsequent stale-ID stop
stopped B. This reproduced the lookup hazard without an in-flight write;
the separate owned-child drain test above is not a VS Code connection test.
Also, each standalone
Next MCP process opens Storage and acquires the exclusive root fence; launching
one independently per profile is not a shared-owner provider architecture.
For a future participating provider, a supervised per-root owner could close
launch admission, track and drain owned connections, and verify exact child
exit before publishing a successor. A restart must acquire a new generation
and handshake; stale connection results cannot be reused. This design does
not cover unregistered legacy writers. The extension cannot assume it owns
VS Code's existing 4.0.22 child: a separate SDK client can close its own child,
but opening one cannot transfer ownership of VS Code's existing connection.
[VS Code's MCP management documentation](https://code.visualstudio.com/docs/agents/run/manage-mcp-servers)
also distinguishes editor-managed and Copilot-runtime connections, and says a
stopped server may start again on a later request. It does not promise that
extension-host or window reload drains in-flight MCP calls. The existing
`personalKnowledge.reloadAllHosts` busy check counts PKM Chat and registered
background tasks, not native MCP writes; it must not be treated as an MCP
drain or root-adoption receipt.
An isolated VS Code 1.143 single-profile test installed the 4.0.22 VSIX,
held an actual compact-MCP Note write, approved and observed `draining`,
released the write and observed `drained`, explicitly confirmed a fixture
reload, installed the 4.0.70 overlay and reloaded the window. The old PID
disappeared and, after an explicit provider start, the replacement MCP read
the Note back. The extension reported 4.0.70, while the replacement MCP
reported extensionVersion 4.0.22: the legacy runtime continued. The driver
supplied orchestration and approval; this did not
test production automatic adoption, Next MCP, or automatic MCP startup. A
separate extension-host-restart run also replaced the MCP instance and read
the Note but still loaded extension 4.0.22 rather than the installed overlay;
it therefore failed the upgrade-version assertion. Neither observation is an
API guarantee that reload drains writes, covers every PKM connection or
proves that a successor was never started between drain and reload.
For a single legacy profile, the tested conservative option is to stop issuing
new PKM work, use that connection's lifecycle status and user-approved
quiesce if available, wait for its own `drained` result with zero in-flight
and uncertain calls, then explicitly confirm window reload and verify the
restarted legacy MCP can read the Note. If status or quiesce is unavailable,
the result is unknown; do not infer a drain from a reload or stop-by-ID.
This keeps the legacy provider and root, and is not an automatic Next
switch. Separately started Copilot/CLI connections need their own coordination;
unknown third-party processes are a distinct risk, not a system-wide scan
requirement. Root adoption still requires its existing authorization.

An isolated VS Code 1.143 journey installed the original 4.0.22 VSIX, then
the same private 4.0.839 v13 VSIX
(`c6ff56c15fccf52f8ea84767e5697154b44f97cf80322a28fb4a7d50731f67d1`)
and restarted it. Ordinary activation in each candidate window connected to
the same original retrieval worker; no native tools were observed before the
fixture explicitly started the provider. A separately connected 4.0.22 stdio
client, unregistered with the experimental owner, remained usable after each
last window closed; the old worker was not replaced. In both candidate stages
two windows shared one private profile, and the actual native compact provider
created and updated a Note via `capability_call`; the old client read each
update, and the restarted provider read the previous stage's update. Four
individual VS Code confirmations were accepted. The test explicitly used
`window.dialogStyle=custom` for automation: it does not verify interaction
with the default native OS dialog. An earlier attempt without that setting
timed out before the write reached MCP, with no confirmation observed by the
CDP controller; its exact cause is unconfirmed.

After both windows closed, the fixture voluntarily quiesced **its own** old
stdio client, checked `drained` and zero in-flight calls, closed its stdin and
observed clean exit, then explicitly reconnected and read the Note. It did not
retire the original worker or authorize Root takeover. The copied synthetic
Root retained 13 checked content/state files and Git ancestry, including
representative Note, attachment, Skill and Paper data. This is not complete
original-Root inheritance: arbitrary layouts, SQLite, other writers and real
production data remain unqualified. The separate in-flight exit tests above
used fixture-controlled blocking; this natural native write test did not hold
a native write across window exit. The current-source warning wording was
updated after v13 was frozen and is not included in that tested VSIX.

A subsequent private X11 run left the default dialog setting unchanged and
captured the actual system `Run capability_call` confirmation. The controller
used X11 input to accept each of four confirmations, and both installed
candidate stages completed native add/update and restart checks. A separate
diagnostic reproduction captured the default system modal outside the CDP
page, consistent with the earlier timeout; the original timeout's exact cause
remains unproven. No custom dialog was used in these later runs.

In another default-dialog run, the native provider updated a synthetic 96 MiB
existing Note, without a FIFO, lock or injected pause. Its own instance
registry reported an in-flight call both before and after the other same-profile
window exited; the update returned successfully and survived restart. A
separate run closed the provider's initiating window while that instance
reported an in-flight update. The caller was cancelled without a completion
receipt, while the provider was still alive and reporting in-flight work;
the provider subsequently exited and the file contained the update. After
restart, the native provider read the updated Note. This is an interrupted
call requiring reconciliation, **not** permission to replay or an API
guarantee. A first owner-exit run reached the same file outcome but its
restart controller incorrectly treated the expected cancellation as an
unexpected host error; it is retained as a failed run. An earlier 96 MiB
request-input attempt timed out before an in-flight receipt; its cause is
unconfirmed and it does not establish a window-exit overlap.

These are installed 4.0.839 **legacy** MCP generations (runtime version
2.19.0), not a Next provider or automatic adoption. The tested root had no
`.pkm-next-workspace` or `core.sqlite`. On one restart native tools were
already discoverable before the fixture's explicit start; tool discovery alone
does not establish which process is live or prove automatic Next startup.
The automatic production Root upgrade, full compatibility and safe writer
handoff remain unimplemented; these results do not relax their gates.
An independent Next MCP definition route now verifies the packaged payload,
workspace identity and current host-supplied authority before returning or
resolving a stdio launch. A private initialized Next workspace test launched
that definition, created a Note, restarted the real MCP process and read it
back. Its default profile uses the generic Next MCP interface. An explicitly
selected experimental compatibility profile instead verifies a supplied
Python interpreter and launches the packaged legacy compact adapter; an
isolated test created a Note via `mcp.tool.add_note`, restarted the actual
provider and read it via `mcp.tool.get_note`. This tests only that subset of
compatibility. The route alone does not own or drain a running server and does
not authorize a real-root upgrade.
An independent stdio owner now tracks one admitted transport and its exact
child, refuses new requests while draining, waits for in-flight responses and
server-initiated requests, then closes stdin and requires normal child exit
plus separately supplied descendant-exit evidence. A private Next compatibility
test held a real Note write on an isolated SQLite lock, initiated drain, released
the lock, verified the write and the bound Python/Next child exits, and read the
Note after restarting. Disconnects, unexpected exits and missing descendant
evidence remain unknown, not successful handoffs. This owner is not a
cross-profile broker or an adoption authority;
it cannot retire VS Code's pre-existing 4.0.22 connection.
For a newly broker-owned 4.0.22 connection, the broker can issue lifecycle
controls on that exact stdio channel, reject new client calls, wait for the
original server's drained identity and the supervised process tree's exit,
then allow an explicitly created successor. An isolated original 4.0.22
generation test held an actual Note creation, declined one handoff, then
drained it and read the Note through a newly owned instance. This does not
bind, stop or establish the absence of an earlier VS Code-owned connection;
the broker is not yet wired into ordinary legacy activation or root adoption.
The retired-state inspector additionally preserves a narrowly qualified
original `capability_call`/`add_note` history: version-1 usage, same original
process session, exact facade/leaf request identities, completed calls and
quiescence are required. The in-flight create may finish after quiesce returns.
An isolated clone of real 4.0.22 history was prepared and resumed using a
test-scoped snapshot authority, then its Note was updated, read after reopening,
and protected against duplicate creation; original diagnostic and usage bytes
were unchanged. A modified cloned log prevented reopening. This is an
experimental recovery test, not production authorization or full workflow
parity. Other mutation tools, incomplete histories and ambiguous sessions
remain blocked.
An independent Linux per-host broker and stdio bridge can now expose that
owner through a VS Code-shaped MCP provider definition. The private broker
admits one authenticated bridge, validates the definition and rechecks
authority before new requests; a test rejected an invalid token and a second
connection, then drained a held real Next Note call and restarted to read it.
An isolated VS Code 1.143 installed **fixture extension** also registered this
provider, used the actual VS Code MCP connection to write a Note, drained its
owned Python and observed backend exit, confirmed reload, then read the Note
through the restarted owner. The workspace was already initialized as Next;
the fixture is not PKM's ordinary activation, a legacy VSIX upgrade, or
old-root adoption. The fixture used a standalone Node executable: its earlier
attempt using VS Code's Electron executable failed during initialization
because the compatibility adapter's FastMCP child did not receive
`ELECTRON_RUN_AS_NODE`. The adapter now explicitly forwards that one flag
when selected, matching the existing extension-host executable strategy; a
private route test using the real VS Code Electron executable writes and reads
the compatibility Note without downloading Node.
An installed product overlay also exercises ordinary extension activation with
`PKM_EXPERIMENTAL_NEXT_MCP_WORKSPACE` explicitly set to a separate, pinned,
private initialized Next workspace. It registers `pkm-next-private` alongside,
not in place of, the unchanged legacy provider. A private profile wrote a Note
through VS Code, confirmed a fixture reload and read it from the restarted
provider. The first version only observed a child PID, so its drain correctly
returned **unknown**. The private owner now launches the compatibility
adapter under a Linux child subreaper: normal completion requires the direct
child and every descendant reparented to that supervisor to have exited.
Drain is bounded; a timeout, abnormal exit, missing evidence or host crash
remains unknown and does not kill or automatically replay work. A private
workspace lease persists across host exit: it is removed only after verified
drain; an abandoned or changed lease blocks automatic restart. This scope
covers the supervised process tree, not unrelated legacy clients or arbitrary
third-party processes.
An installed product overlay held a real Note write on a private SQLite lock,
observed `inFlight=1` while draining, released the lock, verified the completed
write and supervised-tree exit, restarted the owner and read the Note. It then
drained the successor, confirmed reload and read the Note again. All responses
kept `cutoverAuthorized:false`. The test did not
upgrade or switch the original root. This opt-in path is not a production
migration, shared cross-profile owner or supported handoff; without the
environment variable it is absent. An unexpected
owned child exit now closes the client transport rather than leaving VS Code
waiting indefinitely, but its outcome remains unknown.
Its abstract socket and token bind the
participating host, not arbitrary same-user processes; recovery from an
abandoned private lease and shared cross-profile ownership remain unqualified.
Separately, a direct SDK client owned its child and verified drain, EOF, exit and restart
using a copied original generation rebound to the isolated root. Neither
experiment proves root-wide exclusion. The experimental owned-channel
coordinator signals timeout cancellation to its caller, which must cancel any
undispatched request or pending confirmation. Cancellation cannot undo a
request already dispatched, so its result remains unknown and is never
automatically retried or stopped. The coordinator has no qualified production
caller and never authorizes cutover.

A combined private-profile journey additionally approved quiescence of the
4.0.22 provider, installed the 4.0.70 overlay, observed its **default**
upgrade assessment remain blocked, read the old Note through the still-4.0.22
MCP, approved and stopped that instance, and closed the editor. Only then a
separately invoked current-source experiment adopted the same isolated root,
started a Next experimental MCP, read and wrote the Note, killed its own Next
child after the acknowledged write and verified read/write after restart. The
test used `umask 077` when creating the legacy fixture and a synthetic snapshot
authority; it is **not** the installed extension's default upgrade path.
With the environment's ordinary `0002` umask, the real legacy fixture has
`.pkm` (`0775`), `.pkm/state` and
`project-store-migration` directories (`0775`); usage and Action state also
includes `0664` files. The old ProjectStore creates the migration backup and
staging directories with recursive `mkdir` and no explicit mode; its marker is
`0600` and backup `0400`. The legacy MCP usage writer similarly creates
directories and event files without explicit modes. The bounded archive now
accepts those specific legacy shared modes **only under a canonical,
current-user-owned private Linux root or private ancestor**; it checks identities and disallows
symlinks, special bits, world-writable entries and hard-linked files. Private
policy/settings, credentials and new locks remain subject to their own stricter
checks. The root, protective ancestor chain and, when needed, state-container identities are bound
into the compatibility receipt and revalidated. It does not chmod the old root or its
contents. This is a conservative DAC check, not a declaration that a
group-writable root was intentionally shared: the original setup itself uses
`mkdir` without a mode and may create `0775` under `0002`. Roots without a
verified private ancestor remain blocked by this migration experiment even
though they may be normal supported legacy roots. The check does not establish
writer quiescence against another process of the same user. One installed fixture passed these
permission checks but still failed the completed-lifecycle archive check: its
upgraded-provider diagnostic stream had never recorded quiescence. A separate
test of an original ProjectStore under `0002` and a synthetic archive/adoption
exercise cover the permissions compatibility; neither authorizes production
cutover.
In a subsequent ordinary-umask private-profile run, the legacy provider's
approved drain returned `instance-registry-unavailable`, so the experimental
handoff correctly stopped without adopting. A deterministic test of the actual
4.0.22 middleware reproduces a concurrent instance-registry publication race
that can cause that error, but the failed installed run did not capture its
errno and its precise cause is unconfirmed. Current middleware serializes
publication and still fails closed on I/O errors; this does not patch already
installed 4.0.22 instances. Its source hash now differs from the unchanged
historical inventory pin.

A second traced private-profile run created a `0775` root under a `0700`
fixture ancestor, approved the actual provider drain and verified its exit.
Its default upgrade assessment remained blocked and its original MCP/Note
remained available. The separate experimental Next probe first failed because
its compiled migration output was stale. Rebuilding current source and
rerunning that probe against the same stopped fixture passed adoption and
Next MCP Note read/write, followed by owned-child SIGKILL and restart
read/write. This is not a default installed upgrade, a production recovery
qualification, or evidence that other writers are drained. The isolated test
driver now rebuilds its probe before launching to prevent this stale-output
failure.
That fixture's corresponding instance record says `retired` but still
`acceptingNewCalls: true` and `action: none`; it is not silently treated as a
drained instance or rewritten into one.
Separately, a direct owned stdio client ran the 4.0.22 generated runtime twice
under `0002`, using the handoff coordinator to drain, verify exit and restart
with a new instance. Its copied generated server and manifest were rebound to
the fixture; the client was not the VS Code provider. Other undrained historical
records in that copy still blocked archive admission, as intended.
An additional private-namespace replay copied the previously drained 4.0.22
archive, simulated its observed shared modes on the **copy**, and omitted the
empty trash directories subsequently created by Next. Experimental adoption,
Next MCP Note read/write, and owned-child crash/restart then passed under
`0002`. This is a reconstructed test copy, not a fresh default-umask installed
journey or evidence of global writer exclusion.

The bounded archive now retains exact completed `get_note` diagnostics with
their paired read-only facade and matching usage counts, and validated
drained/retired MCP instance records. These records are preserved as bytes,
not trusted as proof that any process exited or that all writers are excluded.
Unknown, incomplete, unpaired, active or inconsistent records still block.
For versions without lifecycle controls, keep the old workflow and do not
silently stop or replace its process; a controlled explicit migration must
wait for an independently qualified writer handoff. No process scan or stale
record can supply that authority.
Newly generated managed MCP launchers also hold the shared root fence for the
server lifetime and check the Next ownership marker before starting; generation
publication and runtime maintenance also hold the fence. An already installed old launcher does not
gain either behavior until regenerated and its existing clients restarted.
Installed extension updates do not enumerate arbitrary clients or open file
descriptors. Current source shared-fence wrappers cover selected MCP mutations,
Action and Markdown asset paths, directory creation, package import/deletion,
fallback Note/Paper assets, Note folder pin/move, Skill/Knowledge Trash permanent
deletion, MyIdeas migration, content privacy and visual-group metadata,
asset-classification apply/rollback, Knowledge inventory and legacy Knowledge
migration writes, GitHub Sync including Remote authority
application, and the PKM Sync service
lifetime until it stops. An asynchronous operation retains its lease across
already-started nested work. This is not a complete enrolled fleet: other
extension paths and independently running published versions still require audit.

For the repository-root 4.0.22 VSIX, the inspected chain is:

- `extension/package.json`: `onStartupFinished` and the native MCP provider.
- `extension/dist/extension.js`: `registerNativeMcpProvider` and
  `maintainPkmIntegration`; the latter regenerates an outdated managed server.
- `extension/dist/mcp/mcp.js`: `mcpServerDefinitionData`,
  `generateMcpServer` and `ensureMcpRuntimeLocked`. The launcher path is also
  usable by separately configured clients.
- `extension/dist/mcp/mcp-lifecycle.js`: generation publish and the stable
  launcher; `extension/resources/mcp_call_guard.py`: per-instance admission
  and quiescence. Compatible predecessors remain accepting.
- `extension/dist/chat/api-chat-mcp.js`: owned Chat connection drain and its
  bundled SDK transport shutdown escalation, not all clients on the host.

Existing old installed extensions do not gain the source changes until replaced
and reloaded. The opt-in `provisionManagedWriterSession` launch contract binds
participating profiles to one root with `PKM_MANAGED_WRITER_SESSION`.
`closeManagedWriterAdmission` persistently blocks new enrolled Sync, service and
new managed MCP starts; `orchestrateManagedWriterHandoff` requests drain only
from caller-owned handles and checks durable operation records independently.
An enrolled launcher records pending before serving and completes only after its
actual lifecycle reports a clean drain; it retains the shared fence until exit.
Crash, failed drain, missing completion or timeout remains unknown. These APIs
are connected to ordinary Linux extension activation only when this launch
binding is explicitly supplied. Each active bound host observes the admission
fence and drains its own Chat connection; Chat passes a fresh launch identifier
and verifies the matching pending record before allowing tool calls. This is
process correlation, not an additional approval or signing requirement. A
bound, activated host records a global-storage-location hash and a distinct
durable host registration. The `profileId` field is only that storage hash:
different named profiles may share it, so it is not a unique profile identity.
Discovery lists registrations, not all VS Code profiles or live processes.
When the same Linux boot and PID namespace can establish that a recorded host
has exited, is a zombie, or its PID has been reused, its host record is
`stopped` and does not by itself block drain. Its independently registered
operations still must finish; an interrupted operation remains unknown.
Otherwise an unfinished registration is `registered-unverified`. A
registration completes only after its owned Chat drain succeeds. Disposal
starts that asynchronous drain but the editor may not wait for it. An unbound
or never-activated profile is not discovered or counted as handled. Native VS
Code MCP and CLI clients are not controlled through Chat's owned handle.
An enrolled PKM Sync daemon also observes the session fence and uses its
existing safe-idle drain. Its durable operation completes only after the daemon
has actually stopped; failed startup, interrupted work or failed drain remains
unknown rather than being marked complete.

The explicitly bound controller can observe an installed build change and
automatically fence, drain, rotate and ask VS Code to reload participating
windows when the installed coordinator files match the currently loaded
protocol and existing package fingerprints. Live enrolled hosts lacking that
protocol prevent automatic fencing; a busy PKM host defers its reload. Reload
restarts all extensions in that window, not only PKM. The runtime binds an
explicit old session to its published successor on activation. No ordinary
installation provisions this session, and no global cutover is authorized.
VS Code's public extension API does not expose a current profile identifier,
and globalStorageUri was observed shared even for a named profile. The
controller therefore observes the default and named-profile installation
indexes as a set, without assigning one to a particular host. It requires all
matching candidate installations to have compatible coordinator bytes; a
missing, malformed or incompatible candidate leaves automatic coordination
unavailable. The set detects changes after enrollment; if an update preceded
enrollment and the loaded package still appears in another index, the set
cannot identify which profile changed. Explicit drain remains available.

An explicit
`rotateManagedWriterSession` (also exposed through the hidden bound-host
command) can create a successor only after all registered operations have
completed and every host has drained or is demonstrably stopped; it retains the previous operations and a rotation
journal. Old bindings cannot write to the successor. A crash during rotation
can leave an incomplete, fenced state requiring recovery; there is no automatic
recovery protocol. Neither rotation nor restarting authorizes root cutover.
Focused tests kill the rotating process after the
operations archive rename and after the successor identity rename; both remain
closed rather than silently accepting old, new or unbound writers.
The host registry is profile-storage scoped and does not enumerate every
configured or inactive VS Code profile. Preexisting and external writers remain
unknown and the session never authorizes cutover.

On Linux with Python subreaper support, a Sync Git command runs under an
independently fenced supervisor that waits for orphaned descendants, including
detached hooks closing inherited descriptors. The ordinary Git result can return
while that supervisor retains the lock. Enrolled Git also records a pending
operation until the supervised process tree has exited successfully; a killed
supervisor leaves it unknown. Unsupported supervision rejects an enrolled Git
command before start; unregistered behavior falls back to the original direct
Git lock and cannot certify detached hooks. Tests use actual Git, setsid, closed
descriptors and owner/supervisor SIGKILL. This is not a guarantee against
arbitrary external writers or a basis for relaxing the production gate.

`tests/linux-legacy-managed-handoff.test.mjs` copies a closed, isolated
installed-4.0.22 generated profile, verifies its generation file hashes, and
rebinds the copies to a new disposable root. It requires the copied mutation
module, mutation helper, lifecycle guard and publisher to match the
repository-root 4.0.22 VSIX (SHA-256
`1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27`)
and sets the copied generated server's Node path to the test executable. The
closed fixture `native-chat-ui-40ef653b-950a-46d5-be57-1b951d043341` passes
these checks. Other VSIX builds with the same version can have different bytes:
the separate private 4.0.22 build with SHA-256
`80fcad4f0cfb4756eb3ba6988f574e085ed3c766ddaf8d02ea91fa9d412c158d`
differs in Node-resolution files and is not accepted by this test. These
checks do not claim that an entire generated profile is identical to a VSIX.
The publisher from the root archive is used with a synthetic compatible
successor: the existing old process still writes. The test checks a real MCP
quiescence receipt against its owned child PID while an actual Note write is
blocked by the original Markdown mutation lock: admission closes, the write
finishes after the lock is released, and that child exits without a signal.
This only drains that observed instance; it does not certify external child
processes or other clients. Another profile writes while the Next fence is
held. The test then simulates marker removal and verifies a new MCP can write. A
subsequent synthetic generation overlays only the current Note
mutation fence: its Note write respects the durable Next marker while the
still-running published predecessor writes past it. This is not a fully upgraded
extension. An independent child verifies that `chmod` does not revoke its
already-open writable file descriptor. The installed-profile case skips unless
`PKM_LEGACY_GENERATED_FIXTURE` points inside `.migration-test-work` and
`PKM_LEGACY_PYTHON` points to its installed Python. Run after building with:

```
PKM_LEGACY_GENERATED_FIXTURE="$PWD/.migration-test-work/<closed-fixture>" \
PKM_LEGACY_PYTHON="$PWD/.migration-test-work/<closed-fixture>/h/pkm-envs/pkm-mcp/bin/python" \
node --test next-server/tests/linux-legacy-managed-handoff.test.mjs
```

Another test overlays the current launcher and session helpers onto two separate
copies of the old generated profile, exercises actual FastMCP Note writing,
quiescence and EOF, verifies the owned Chat launch registration, and checks
durable admission and drains. A separate private-namespace journey installed
the original 4.0.22 package and a focused 4.0.34 overlay in two actual named
VS Code profiles, each in a different private user-data directory, against one
synthetic root. Both activated the opt-in controller; a real detached Git hook
outlived its killed extension host and blocked the other profile's handoff
until it exited. That journey does not prove same-user-data-dir profile
enumeration, an actual installed Chat MCP session, automatic profile upgrade,
or restart and cutover of unknown writers.
The later focused 4.0.39 overlay additionally tested three private named
profiles in separate user-data directories, one unbound. After a registered
host was killed and restarted while a detached Git hook remained alive, the
new and old host records shared the same profile hash; the old record remained
unknown and blocked handoff even after the hook exited. The unbound profile did
not appear in discovery. A same-user-data-dir parallel extension-test attempt
failed because VS Code disallows launching command-line extension tests while
another Code instance uses that user-data directory; it is not evidence of
same-directory profile coverage.
In a later isolated ordinary-window journey, the original 4.0.22 package was
replaced with focused 4.0.44, then one of two explicitly bound default-profile
installations was upgraded to 4.0.45 while running. After one real extension
host was SIGKILLed, its private Code window was restarted; VS Code did not
automatically restart that host in the attempted journey. A detached Git hook
delayed automatic rotation until it exited, after which both windows actually
reloaded and rebound to the successor. A separate unbound installation was not
registered. A previously stopped 4.0.22 installation subsequently started and
wrote a synthetic Note while the session was fenced, demonstrating why stopped
legacy profiles are not current writers but can become uncontrolled writers
later. A subsequent isolated 4.0.47/4.0.48 journey included the conservative
guard and passed twice with the same default-profile upgrade and reload path.
In those runs, adding a synthetic nonempty `User/profiles` directory prevented
automatic fencing during a two-second observation; removing it allowed the
upgrade to proceed. This is not an actual named-profile upgrade or discovery
test. An earlier run of that new negative assertion failed for an unconfirmed
reason; its failure log is retained, and the later passes do not explain it.
The original run deleted its fixture before diagnostics could capture the
marker or fence state. Two subsequent traced 4.0.47/4.0.48 guard-only runs
retained the marker throughout observation and passed; they cannot establish
why that first run failed. Separate follow-up runs exposed a fixture error:
`/proc/self/cwd/home` changed meaning when the detached Sync daemon changed
working directory, causing an `ENOENT` startup failure and a correctly retained
unknown Sync operation. The fixture now anchors HOME to its private parent
process's working directory; this explains those follow-up failures, not the
earlier negative assertion.

An isolated 4.0.52/4.0.53 focused overlay then exercised two real named
profiles sharing one user-data directory, with an installed driver rather
than extension-development windows. Both explicitly bound hosts enrolled; a
real running enrolled Sync daemon drained and recorded completion before
automatic rotation, and both windows reloaded into the successor after one
profile's installation was updated. In a repeated SIGKILL sequence, VS Code
automatically restarted the host after the first two kills; after the third
and fourth it did not restart within eight seconds, and the fixture invoked
VS Code's **Developer: Restart Extension Host** command in the actual window.
These observations apply to the tested VS Code version, not a guaranteed
crash threshold. A killed host with incomplete registered work, or a crash
during rotation, still needs recovery; host restart alone is not proof that
such work completed. The 52/53 overlay derives from the earlier focused
fixture, not a release qualification or global cutover.

An isolated ordinary unbound installation of the original 4.0.22 package was
upgraded to a private 4.0.61 focused overlay. The configured root stayed the
same, a synthetic old Note remained readable and unchanged, and the automatic
read-only assessment reported blocked. After the new extension host was
SIGKILLed, VS Code automatically restarted it in that run and the assessment
again reported blocked. No session was provisioned and no Next workspace
marker was created. This tests status and a Note workflow, not adoption,
global writer isolation, other workflows, or production qualification.
The first run's assertions passed but its fixture cleanup raced remaining
process shutdown and failed with `ENOTEMPTY` (exit 1); its log and surviving
fixture are retained. The corrected second run exited 0, and a separate
post-namespace process check found no processes belonging to either fixture.

The experimental `rollbackPreparedLegacyRootAdoptionExperimental` API now
cancels only an uncommitted prepared adoption before any Next database or
durable Next-owned writer marker exists. It first verifies the original source
and root identity, moves the workspace marker (or the journal if that marker
was never published) to a durable rollback intent, and removes the verified
journal and intent in recovery-safe order under the
existing adoption lock, exclusive writer fence and quiescence check. An
interrupted rollback must be completed rather than resumed as an adoption.
Todo projections, initialized or committed Next state, changed source data,
and unknown marker state are refused and preserved; this is not post-write
rollback and does not reopen a fenced managed session. The writer-fence
release is awaited before the adoption lock is released.

Isolated tests used the original 4.0.22 VSIX filestore to write a Note after
prepared rollback and verified that an old write after prepare blocks
rollback rather than being overwritten. Separate SIGKILL tests interrupted
both rollback boundaries and completed recovery. A committed Next Note update
is preserved and refused by this prepared-only rollback. Another isolated
test now drains, rotates and fences an actual synthetic managed session, then
prepares adoption with a journal-bound receipt that validates the complete
rotation chain, operation pairs, current fence and exact source identities.
The session files are preserved in place; unknown, active, unfenced or
unrotated records remain blockers. This receipt does not upgrade the session's
`preexistingAndExternalWriters: "unknown"` status or authorize cutover.
In a further isolated 4.0.22-to-4.0.61 installed journey, the original Note
and host restart assertions completed, but the subsequent offline probe exited
nonzero and its controller omitted the probe's stdout. The run is not a pass and
its fixture is retained. A separate replay against that same fixture in a new
private PID namespace found no process blockers and then returned
`PKM_STATE_UNSUPPORTED` for `.pkm/state/api-chat-control` (the dedicated archive
inspection rejected the fixture's `.pkm` directory, mode `0775`, as not private).
This replay identifies
its own blocker, not the missing reason for the earlier probe failure. Neither
run performed adoption or proves a full installed upgrade.
The exact legacy permission source is now verified in the pinned 4.0.22
bundle: `ProjectStore.loadOrInitialize` recursively creates `.pkm/state`
without a mode argument, so umask `0002` naturally produces mode `0775` for
both container directories. Its API Chat writer separately creates nested
state directories with mode `0700` and files with mode `0600`. The inspector
therefore permits same-owner `.pkm` and `.pkm/state` containers with group
permissions only when special bits and other-write are absent; private state
directories and records retain the stricter checks. A synthetic umask-`0002`
regression exercises this exact parent-mode shape and confirms that a `0775`
private child still blocks adoption. The installed offline probe must still
confirm this behavior in a fresh 4.0.22 fixture. A later private PID-namespace
probe of a mode-preserving copy of the retained installed fixture passed that
permission check. It exposed a control-only API Chat tree and empty default
Action settings: the experimental inventory now binds their original bytes as
inert evidence, retaining unresolved controls and rejecting configured Action
authority or unknown state. The subsequent non-empty `mcp-server` tree is
now inspected as inert evidence: generation pointers, the exact manifest file
set, hashes and runtime build identity are checked, and unknown or incomplete
state remains blocked. Neither the manifest nor archived launcher is trusted
as writer authority. A later fresh private 4.0.22-to-4.0.61 installed journey
used a separate current-source offline probe after both hosts stopped: it
prepared and rolled back, experimentally adopted the same root and wrote the
old Note. Prepared-only rollback then refused the committed write and preserved
it. The installed 4.0.61 package did not contain that current-source probe;
automatic activation remained blocked. This is not post-commit rollback or
proof of a complete installed upgrade, writer exclusion, or automatic cutover.
An additional isolated installed run used the original 4.0.22 VSIX
(`sha256:1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27`)
and the private 4.0.61 candidate
(`sha256:61c0f60970f02a8a650ff38f4231825f8bec9f52690e5f50adc76462fc9443b9`).
Automatic assessment still blocked the same root. After stopping the installed
hosts, a **separately compiled current-source experiment**, not the installed
candidate, opted into a committed rollback baseline. With no subsequent write,
it survived SIGKILL after archiving the journal, completed rollback, and the
original 4.0.22 filestore read and wrote the Note. It then adopted again and
wrote the Note through Next; rollback refused `SOURCE_CHANGED` and retained
that write. The fixture and log are retained. The isolated focused suite also
tests old-file and SQLite-only changes, including changes after interrupted
rollback, unknown SQLite sidecars, and four committed rollback SIGKILL points.
This proves only those cases, not that every old or Next data domain can be
detected or reconciled.

The explicit experimental committed rollback accepts only an opted-in baseline
with unchanged original source and unchanged SQLite contents, no Todo
projection or unattributed SQLite sidecar, and a matching writer marker. It
archives the verified Next state rather than deleting it. It is not a
production command or a data-preserving rollback after Next writes. SQLite
inspection uses immutable read only after sidecar absence is checked; an
unknown sidecar is never removed or interpreted as belonging to this operation.
If a later write or an interrupted recovery conflicts, stop all relevant
writers and retain the entire root **and its adjacent adoption-lock directory**
as a consistent backup. Do not remove markers, databases or sidecars, and do
not reopen that root with the old writer. For urgent access, inspect copies in
an isolated workspace and selectively export or copy user-verified file-based
content to a separate legacy workspace; this does not recover SQLite-only data
or establish a safe merge. Preserve the untouched backup for supported
reconciliation; there is currently no supported automatic merge or downgrade
that preserves all post-adoption writes.

For an explicitly controlled experimental host, `exportLegacyRootSqliteSnapshotExperimental`
can export a consistent SQLite snapshot to a new file in a private directory
outside the root while a real host-supplied quiescence lease and the workspace
lease remain held. It verifies integrity, never overwrites a destination, and
returns a digest. `inspectLegacyRootSqliteSnapshotExperimental` accepts that
exact digest and offers bounded, typed, read-only table pages, preserving
integers and blobs without JavaScript number coercion. An isolated test
exports SQLite-only data after adoption, reads it back through this API, and
refuses a conflicting rollback. This is data inspection and preservation, not
an old-workflow restore: the database may refer to other files or external
authorities, and it does not contain VS Code profile SecretStorage or restore
its credentials. There is no ordinary-user command or qualified production
quiescence host for this experimental API; it must not be used by inventing a
lease or treating a process scan as authorization.

The first SIGKILL test run timed out because the previous adoption fence release
was not awaited; after the release fix both checkpoints passed. Running the
writer-quiescence test file in parallel with other adoption tests also produced
expected false blockers from its synthetic VS Code hosts; the combined
regression passes when those files run serially in the private PID namespace.
`tests/legacy-root-adoption-rollback.focused.mjs` is deliberately not included
in the parallel general runner: run it in a private PID namespace with
`PKM_ROLLBACK_TEST_WORK` pointing to an isolated project-local fixture directory,
`PKM_LEGACY_DIST` to the extracted original VSIX's `extension/dist`, and
`PKM_MANAGED_DIST` to an isolated current-extension compilation.

For ordinary users who need to keep working, the existing legacy workflows
remain the available option; no Root selection or move is needed. Run the
original-root upgrade status command again when a supported migration becomes
available. Reloading the window is not a migration: the current host and its
writers are not yet qualified for coordinated handoff. Do not terminate
unrelated processes or remove the root, session files or adoption metadata:
there is currently no supported production command to perform the cutover or
to roll back Next writes.

The production cutover gate remains closed: no user pause or risk-acceptance
option currently implements the missing cross-profile pause, upgrade, recovery
and restart orchestration. Do not offer those as executable cutover choices.
A controlled service boundary can supervise only the writers it owns; process
scans, `chmod`, or fencing only newly launched children cannot establish global
exclusion of independent clients, already-open handles or remote hosts.
Unknown SQLite rollback journals and unbound Trash locks are preserved and
block recovery rather than being attributed to an application transaction by
path alone.

An isolated Linux single-profile installed-host probe observed the current
extension host classified as `vscode-host-process` by the inherited
`--standard-schemes=vscode-webview` argument. The same heuristic also matched
that window's renderer and utility processes; it is not proof that each is a
PKM writer. The extension host subsequently started a root-bound Sync service.
Neither it nor the host held an open root descriptor at the sampled instant,
which does not prove that they cannot open and write files later. The real
experimental adoption call returned `LEGACY_WRITERS_ACTIVE`, and the ordinary
status remained blocked. The existing managed-profile callback drains Chat MCP
only; host UI mutations and queued Git commits are not included. Therefore a
successful callback or a reload is not self-host quiescence. The test used the
previously frozen 4.0.836 package and a cloned 4.0.22 root, not a fully
integrated production cutover.

The current extension also enrolls panel and Chat webview message handlers,
direct knowledge and Recipe mutation commands, Chat sends and agent-control
commands, Chat supervisor, worker wake, deferred stream persistence and profile
learning, its Git commit queue and Sync execution callbacks in a
root-device-and-inode-bound in-process counter, identified by owner UUID,
PID and Linux process-start ticks. A scoped drain closes
admission and waits for enrolled work, including
work spawned by an already admitted operation; failures, cancellation, timeout
or a changed root remain unknown. Cancellation and already-admitted nested
work may still finish after a timeout, without turning unknown into success.
After a failed drain, scoped admission can resume legacy work only after its
enrolled work settles, the original root binding is revalidated and, on Linux,
a bounded shared Root fence is acquired with no Next writer or rollback marker.
An active exclusive fence or marker leaves admission closed. The shared fence
only protects that transition; it does not prove that unregistered or old
writers obey it. A status observation also rechecks the Root binding: replacing
the directory or discovering uncertain work after a drain invalidates its
`drained` state. The failure remains sticky and a later drain cannot turn it
into cutover evidence.
An isolated PID-namespace integration test bound the real host admission
object before experimental Next adoption. After the actual Next owner marker
was published, host resume was rejected. A rollback subprocess was SIGKILLed
after archiving that marker; its rollback intent still blocked host resume.
Retrying rollback completed recovery, after which the original 4.0.22
filestore wrote the same synthetic Note. In a separate fixture, a real Next
Note update caused rollback and host resume to be refused, preserving the
update. These tests use an explicitly invoked experimental adoption, not
ordinary VS Code activation or automatic production takeover.
Its status explicitly reports
`completeHostCoverage: false` and `cutoverAuthorized: false`: command handlers,
background writers, other Chat paths, older hosts and independent MCP clients
are not all covered. No ordinary command starts this drain or uses its result
to relax the process gate. A private fixture-only command exists when its
explicit root environment binding matches, and cannot authorize cutover.
Losing the binding during normal operation leaves legacy workflows usable but
makes the observation unknown.

The checked call-path inventory distinguishes the following from a whole-host
proof:

| Entry | Observed boundary | Remaining limitation |
| --- | --- | --- |
| Navigation Note/Recipe/Skill commands and Markdown virtual-file save | `registerHostWriterCommand` or `observeHostWriterSync`; Note/Skill/Paper persistence reaches `writeKnowledgeMarkdown` → `withMarkdownAssetMutation` → shared Linux fence. | Other commands and native file editors remain outside this counter. |
| Panel RPC | Webview request and direct `handleMessage` calls enter host admission. | UI-owned external workers and detached callbacks require individual lifecycle proof. |
| Git commit queue | Each queued add/commit holds the shared root fence; on Linux a subreaper waits for owned descendants. If supervision is unavailable, legacy execution remains possible but drain is unknown. | This does not account for independent Git processes. |
| GitHub Sync | Service `shouldExecute`, `execute` and auto-pause persistence enter host admission; the participating singleton's entire `startPkmService` lifetime runs inside `withManagedWriterOperation` and its shared physical root fence. An isolated real-service test confirmed an exclusive fence is unavailable until client drain and service exit, then becomes available. | An isolated service extracted from the actual 4.0.22 VSIX ran concurrently with an acquired Next exclusive fence; it cannot be retroactively enrolled. Abnormal termination also requires child-exit evidence. |
| Chat | Shell/agent-control callbacks, webview handlers, send, supervisor, worker wake, deferred stream persistence and profile learning enter admission. | Store callers outside these entry points and VS Code-owned MCP connections are not fully inventoried. |
| Legacy MCP and bootstrap | Generated MCP mutation paths can use a managed writer session and shared root fence. | An old unmodified 4.0.22 host cannot retroactively enroll; a reload or callback alone does not establish completion. |
| Root reconfiguration | `personalKnowledge.reconfigureKnowledgeRoot` is admitted for the duration of its command, including setup and store initialization. | A successful root change makes the old owner's observation unknown rather than rejecting the completed legacy workflow. Detached integration maintenance and establishment of a new owner still require independent lifecycle proof. |
| Hosted Room commands and received frames | Rename, repair, force-close, close and delete command handlers enter host admission. The legacy Hub also enrolls incoming websocket frames before its per-connection queue; an isolated real Hub/Client test held persistence, queued another message, and verified drain waited for both while explicitly rejecting a new frame without disconnecting the client. | Socket close, archive timers, independent collaboration service lifetimes, remote clients and other Room write paths are not established by the host counter. |

An isolated VS Code 1.143 installation of the frozen 4.0.837 candidate
`eee3144f2780b1db39d20eedb41a31225690be610dec7008cd3ec14d2332311d`
tested a copied 4.0.22 root using the fixture-only drain command. A real Note
command and Git hook remained counted until completion; new work was rejected
while draining. In a separate timeout run, admission could not resume while
work remained active, resumed after it settled, and retained the timeout as
unknown evidence. Both runs preserved the source Note and source and copied
root/`.pkm` modes and ownership. Their private process cleanup records reported
no remaining owned processes. They do not prove whole-host coverage or adoption.

The supplied 4.0.22 VSIX created and committed a Note with a writable Root and
an unwritable parent, but a private 4.0.837 candidate failed activation trying
to create the sibling fence directory. These installed tests removed
`CAP_DAC_OVERRIDE` and asserted actual permissions; earlier namespace runs that
checked only mode bits are not permission evidence.

The upgraded Linux extension, generated Python MCP/Action writers and Next
now use the Root directory's device/inode for shared/exclusive `flock`. The
holder uses an inherited directory descriptor and a readiness pipe, not an
ephemeral file which `git add -A` could stage. Adoption uses that same
exclusive fence instead of a separate parent SQLite lock; its ownership marker
and private rollback archive are inside the Root. The archive has a checked
private `.gitignore`, and a pending rollback blocks upgraded legacy writers
even after the ownership marker has been archived. A private readonly-parent
test exercised the real Git queue and drain, Python/Next exclusion, restart,
interrupted rollback and retry; it also verified ordinary Git staging excludes
the archive. These are isolated tests, not production cutover qualification.

In one private VS Code profile, the supplied 4.0.22 installation, a privately
repacked 4.0.839 candidate, and a restart of that candidate each performed a
real Note write and automatic Git commit on the copied Root with a genuinely
unwritable parent. The two candidate runs also drained while a real Git hook
was blocked. The first attempt exposed surviving private MCP/Sync descendants;
the successful retry identified and stopped only its own two remaining
retrieval-worker PIDs. Those workers are deliberately detached and shared by
windows in a profile, not MCP or Sync processes; the retry did not demonstrate
their natural drain or exit.
It is not evidence that all old writers naturally exit. The candidate VSIX
SHA-256 was `c3508c3a9affca1a10ce4c8506fb3e206f63c5ca9510d88543ed66727f60fb94`.
It was privately repacked after normal dependency enumeration failed, not
validated as a release package. Subsequent stricter rollback-archive validation
was compiled and tested separately and was not in that installed VSIX.

The later private candidate
`702e81d4cf9829e8e76ba13b7fc7fcccdd479c709f53304da9812484c8fad86e`
contains that archive validation and a retrieval-worker shutdown that rejects
new requests and waits for admitted requests and background builds. From that
same VSIX, four isolated rollback SIGKILL checkpoints recovered, and a real
in-flight 12,000-document index finished before authenticated shutdown without a
signal. In a separate same-profile 4.0.22 → candidate → restart installation,
all three Note/Git stages passed with no forced child termination. The two
candidate stages explicitly requested shutdown of the fixture-owned retrieval
worker after the scoped host drain; this was not automatic window deactivation.
An earlier strict run without that request failed because the shared retrieval
worker remained alive. This explicit private-profile test is not a production
handoff: another window may use the same worker, and its complete client set
has not been established.
The later private v7 candidate makes participating managers recognize the
draining response instead of killing the still-working process as unresponsive.
In an isolated test a second manager received that response while an actual
index build completed; the worker then exited without a signal. Old managers
cannot be assumed to recognize this response, and no existing profile secret or
host record proves that every consumer of this shared worker has enrolled.
Ordinary activation and deactivation therefore still do not authorize
automatic worker shutdown or original-root takeover.
On an unresponsive or endpoint-less live retrieval process, participating
managers now report unknown and leave it running instead of sending termination
signals; an operator must reconcile it before a replacement can start.

Completed rollback archives remain in the Root and can be inventoried for
another experimental adoption only after checking their bounded contents,
permissions, manifest, receipt, file identities and hashes, and the original
Root device/inode. Modified or unknown archive data fails closed and remains
preserved. Four isolated SIGKILL checkpoints and focused archive tampering
tests exercised recovery and refusal; they do not prove production recovery.

Sibling-only fences were found in this workspace's untracked experimental
source and private VSIXs, not in the supplied 4.0.22 VSIX or the public GitHub
default branch inspected for this test. The public Marketplace query returned
4.0.0 as its newest listed version; it did not establish the distribution
history of privately installed builds. Existing sibling preview lock or owner
files are preserved and fail closed for explicit recovery, not silently
migrated or deleted. An isolated permission-change test confirmed that an
older sibling-only process can otherwise overlap a Root-only process. This
does not require a published-user version retirement decision, but any actual
private preview processes must be stopped before their fixture is reconciled.
Original 4.0.22 processes do not honor either fence and still require an
explicit verified handoff, including their independent MCP/Sync clients and
Git descendants; this change does not authorize an automatic production
takeover or make an unsupported downgrade safe.

An isolated two-profile test with the real old FastMCP code and newly
participating launchers completed an actual Note mutation, fenced restart,
quiesced the exact clients and observed their exits. A separate test with
unmodified 4.0.22 managed clients confirmed that profile-scoped maintenance
does not stop another old client or make the Next physical fence effective
against it. Neither test establishes ownership of VS Code's provider process.

Native Next storage shutdown retains its real exclusive fence when scheduler
closure, worker shutdown dispatch or a retained resource fails. A retry may
release it only after those resources and the database worker finish. Isolated
cross-process tests also kill an owner with a live SQLite transaction and verify
rollback before a new owner opens the database. These checks do not make the
legacy host inventory complete or relax the adoption gate.

A future reload-assisted flow must first obtain explicit user consent, explain
that a 4.0.22 host cannot enroll its already-running operations, and ask the
user to finish their own PKM work before reload. On restart the new host must
bind its actual profile, build and canonical root before starting any legacy
writer, then establish ownership and completion of its old MCP/Sync children
and every remaining host writer. Reload completion alone is not that evidence:
independent clients may survive it, and the current host starts writers before
its scoped observation is installed. Only after a complete, verified drain and
release of the owned root fence could adoption be attempted. This flow is not
implemented or offered as a supported migration; it must not require the user
to terminate unrelated processes merely to satisfy the current broad scan.

The remaining host inventory includes other direct VS Code commands and
background paths, Chat persistence/worker activity not enrolled through the
covered callbacks, Sync's
separate service process, subscriptions and collaboration, and VS Code-owned
MCP connections. Counting panel events or one Sync callback does not close
these paths. In particular, closing the Git queue alone while other direct
mutation paths are still writable could leave uncommitted changes. The host therefore
does not publish a whole-host drained acknowledgement from this counter.

An isolated Environment refresh registration experiment writes a distinct
`environment-refresh` pending record only for an explicitly bound session and
an exact, one-shot prepared supervisor launch. A real subreaper fixture showed
that a manager exit does not drain a still-running detached descendant, and
that a proof from a different launch or a copied proof is rejected. Physical
drain alone does not establish that the encompassing handler and profile
commits finished. Experimental completion additionally requires the exact
owner's live transaction-finished capability. A controlled handler fixture
exercised the actual managed session and profile writes with separate
supervisor, cancellation, and crash cases; its owner and profile-exclusivity
fences were fixtures, not a real Next host or proof about external writers.
Both the local session drain and Next's adoption parser still reject these
records, including completed records. Do not use this experiment in an
ordinary profile; it cannot yet complete a handoff. It is not complete host
coverage or a profile grant.

### Current platform validation scope

Both Linux and Windows are required for release acceptance. This workspace is
Linux; native Windows verification still requires a Windows host. Windows
remains **not verified**: API-branch coverage and injected-error tests are not
native-host evidence. Linux verification alone does not satisfy the migration
acceptance target or authorize a production cutover.

Run `npm run progress` to refresh it. `npm run migration:inventory` explicitly
refreshes the legacy source snapshot. Source counts are not completion percentages.
`npm run test:qualification` writes fingerprinted test evidence only after a successful run; changed
implementation files invalidate that evidence in the progress report.
Original-source and captured-file hashes are also checked directly for every
curated capture. Refreshing the source inventory cannot turn a stale capture into
current parity evidence; changed source requires re-capture and revalidation.
Recorded native implementation pins are checked before full verification too.
The Batch20/21/22 Skill source implementation has bounded disposable-fixture native
qualification; its scope, evidence and pending gates are recorded in
[`batch20-qualification.json`](./migration/batch20-qualification.json),
[`batch21-qualification.json`](./migration/batch21-qualification.json), and
[`batch22-qualification.json`](./migration/batch22-qualification.json).
Capture scripts invoked by tests use read-only `--check` mode; in particular,
`node scripts/capture-workflow-executor.mjs --check` verifies generated originals
and native pins without updating them.
`--refresh-native` on the runtime-process/workflow-executor capture scripts
refreshes only native pins after explicit requalification; original-source and
captured-file hashes are first verified and never rewritten by that mode.
New composition, Manager progress and browser code has separate
[`native-qualification.json`](./migration/native-qualification.json) pins, not
invented original-source provenance. Browser resources participate in the full
verification fingerprint.

### Adopted Trash permanent deletion

`knowledge.trash.delete.original@1` removes one adopted entry by `area` and
`originalId`; `knowledge.trash.empty.original@1` removes the current adopted
entries in one area. Both require `operationId`, a writable actor and separate
native `knowledge.trash.delete` / `knowledge.trash.empty` policy grants.
Results include the exact entries and count. Active documents and other areas
are not deleted. These operations cover adopted Notes/Skills/Papers Trash, not
Prompts/Scripts or arbitrary native Trash.

The shared writer persists the exact selection and byte/identity pins before
filesystem effects. A partial failure is an error, not success; the intent
remains and blocks Trash reads/backup until explicitly retried or recovered by
the same authorized actor. Open storage with `{ deferRecovery: true }` for
native recovery, then supply `legacyTrash.recoveryActorId` to
`createNativeRuntime`; default storage recovery refuses these native intents.
Completed requests replay their immutable receipt; restore never revives a
permanently deleted entry. Original metadata/deletion history and older backups
remain: this is Trash deletion, **not secure erasure**.

On Linux, restore also recreates missing parent directories inside the existing
Notes/Skills/Papers area, matching the original PKM writer. Planning and adopted
Trash import do not create them. Creation occurs component by component only
after the exact restore intent is durable; each component must be a real
directory, never a symlink or file. Created directories and their parents are
synced before moving the pinned payload/assets. An interrupted creation or
publication retains the intent and any created directories for forward recovery;
there is no rollback or deletion of unrelated paths. The allowlisted area and
Trash roots must already exist and are never recreated by restore. Tests cover
missing-parent original-writer parity, HTTP/MCP replay, restart and backup/restore.

Removal uses Node's platform-specific `rm`: Linux unlink/rmdir semantics and
Windows read-only/sharing behavior are not emulated with shell commands.
Transient `EPERM`, `EACCES`, `EBUSY`, `ENOTEMPTY`, `EMFILE` and `ENFILE`
failures retry asynchronously, at most eight attempts; persistent failures
remain explicit and recoverable. Linux also syncs the retained Trash parent
directory before SQL publication. Windows has no equivalent portable directory
fsync guarantee here. Tests exercise real filesystem removal on the current
host and injected Windows-style errors; they are not a native Windows run.
Import/publication and paired/folder moves now share the platform-specific
no-replace primitive described below. This does not make the entire migration
chain Windows-qualified.

### Cross-platform migration publication

Imported original Trash and later runtime Trash retain separate authenticated
origins. New entries do not expand or rewrite the immutable import receipt;
restore provenance and Knowledge successor chains bind later updates and moves.
Unknown ownership, actor substitution and missing provenance fail explicitly.
Coexistence tests exercise actual MCP deletion, listing, restore and purge,
restart, interrupted recovery and relocated backup/restore. These scoped checks
do not establish compatibility for arbitrary unsupported Trash payloads.

The offline importer, workspace backup/restore, folder lifecycle and Trash
move/restore use the same no-replace helper. Linux uses
`renameat2(RENAME_NOREPLACE)`; Windows uses Unicode `MoveFileExW` with
`MOVEFILE_WRITE_THROUGH` and **without** `REPLACE_EXISTING` or `COPY_ALLOWED`.
Windows drive, UNC and long paths use extended-length addressing. Existing
targets, cross-volume moves, missing OS APIs/Python, permission failures and
sharing violations fail explicitly. There is no copy/delete or ordinary rename
fallback, so neither an empty target directory nor a racing publisher is
silently replaced.

Filesystem effects still require the existing writer, journal and exact
source/destination checks. Linux retains parent-directory fsync; Windows does
not claim an equivalent portable directory-fsync/power-loss guarantee.
Python is invoked directly with fixed arguments, never through a shell.
Offline import retains its explicit absolute `pythonExecutable` requirement.
Other callers use `python` on Windows and `python3` on Linux, unless their
existing options supply an executable.

Tests run real Linux file/directory moves, collision/racing-publisher checks and
the actual helper's Windows API branch against injected kernel32 responses.
They do **not** substitute for running import/restore on a native Windows host.
Other operating systems remain explicitly unsupported by this primitive.

### Explicit Memory import and scope continuity

The offline importer accepts a separate closed original v2 Memory Engine
snapshot with `--memory-engine /absolute/path/to/snapshot` and an explicitly
selected replay actor with `--memory-actor-id`. The snapshot must be outside the
disposable source root. Planning and import still require
`--acknowledge-quiescent-disposable-copy`; import additionally requires the exact
approved plan digest, a fresh destination and the Python publication executable.
Original scopes, IDs, revisions, audit events and historical operation results
are preserved rather than rewritten for the destination path.

Import alone does not activate old repository scopes. An embedding native host
must explicitly approve continuity using `authorizeMemoryScopeContinuity`;
planning selects one scope using `memoryContinuityScopeSha256`. The offline
planning CLI can inspect a proposed selection with
`--memory-continuity-scope-sha256`. Continuity
binds the selected original scope, target workspace, import receipt and replay
actor. Other scopes stay inaccessible, pending records stay pending and external
MCP callers cannot supply arbitrary scopes or confirmation authority. The
offline CLI may plan the selected scope but cannot create that trusted-host
approval; scope activation must use a native-host caller. The v2 binding also
pins the source database SHA, exact import-plan SHA and approval expiry.
Persisted bindings are provenance, not reusable grants: restart, external MCP
and relocated restore do not activate them. Historical v1 bindings remain
readable evidence but are never upgraded into permission.

`PKM: Import Static Legacy Copy into Isolated Trial` (`personalKnowledge.nextTrialImport`)
can select a dedicated closed Memory copy and exactly one original scope.
In a trusted workspace its private child IPC requests a separate host modal
showing the generated target workspace, actor (`local:owner`), scope, source,
plan and receipt digests. Cancellation, changed evidence or missing approval
fails closed before publication. This is explicit adoption, **not proof of the
original owner's identity**. No historical grants are imported.
The attached session uses the actual native Memory Markdown planner and exact
SQLite operation receipts, with read/search/audit and existing-receipt replay
only; it cannot propose or confirm new records. Approval expires after at most
15 minutes and is not inherited by a new host or restore.
After a successful fresh import, VS Code retains an independent Memory evidence
pin in SecretStorage, keyed by the exact workspace identity. It covers the
original scope/source/plan/import-receipt digests and the exact imported/native
operation receipt state; the workspace or backup cannot enroll its own pin.
`PKM: Re-adopt Imported Memory for Isolated Session`
(`personalKnowledge.nextTrialMemoryReadopt`) renews **permission**, not an old
grant: it compares current imported bytes and receipts with that independent
pin, then requests a separate trusted-host modal and a new expiring decision.
It works on the current resumed write experiment, or opens a selected
closed imported/restored workspace read-only when no trial is open.
The original disposable Engine/source paths need not exist.
Default-deny remains in effect until approval; mismatched evidence,
missing independent host pin, foreign actor/scope, cancellation and expired
approval fail closed. No grant or new deadline is written into the database,
and no source-owner identity proof or CLI re-adoption is implied.
Missing SecretStorage evidence cannot be replaced by trusting the backup
itself; it is an explicit prerequisite, not silently synthesized authority.
`tests/memory-host-continuity.test.mjs` verifies this real private child flow
with synthetic original Engine SQLite, including cancellation, mismatched
actor/scope/digests, exact reads/receipt replay and restore non-activation.
`../tests/test-next-managed-client.js` additionally runs the packaged private
IPC through fresh import, source deletion, restart denial, explicit
re-adoption, real CLI backup, independently authorized API restore, denial,
new re-adoption and read/receipt parity. It rejects altered receipt hashes and
self-consistent modified historical operation state against the independent pin.

These are isolated migration interfaces, not permission to open a live original
database, switch the real root, or claim complete Memory/Chat migration.

The combined `tests/managed-memory-migration.test.mjs` rehearsal exercises a
disposable original root and closed multi-scope Engine snapshot through owned
import and the real Chat connector. Managed Chat, generation restart and
relocated restore do not inherit an importer's in-process Memory approval;
the rehearsal checks that original/foreign scope reads and historical replay
remain denied without fresh host admission, while originals remain unchanged.
The private trial-host test above supplies the explicit session approval and
checks successful exact native reads and receipt replay.
This is integration evidence for that path, not coverage of every old MCP tool.

### Isolated managed migration launcher

`experimental/managed-migration.mjs` provides experimental generation staging,
integrity verification, atomic publication/rollback and launcher configuration.
Packages include their pinned Node and Python dependency closure; source or
dependency changes during copying fail explicitly. They refuse production-root
adoption and complete feature-domain claims. The isolated VS Code host uses the
original Chat connector and exposes separate experimental migration commands;
it does not replace the installed production extension.

`tests/managed-migration.test.mjs` covers actual drain/lease release, uncertain
native writes without replay, upgrade, rollback and publication failures.
Run `npm --prefix clients/vscode-host run test:electron:migration` from this
package for the isolated Electron host scenario. Final global verification must
cover the exact runtime bytes being packaged; later bridge changes invalidate
earlier rehearsal evidence.

### Original router configuration snapshot

The offline importer accepts an explicit external router configuration snapshot
as `routerConfig` in `planLegacyImport` or `--router-config` on the CLI. Its exact
bytes and source identity/digests are receipt-bound and staged at
`knowledge-read-config/retrieval/router-config.json`, rather than treating an
arbitrary original retrieval directory as owned server state. Malformed,
workspace-local and changed snapshots fail explicitly. MCP consumers must read
this owned projection and verify it after restart and relocated backup/restore;
creating a configuration file after server startup is not migration evidence.

### Original Prompt and Script library data on Linux

The shared offline importer now preserves `prompts/` and `scripts/` in addition
to the supported Markdown areas. Prompt project/task/version directories,
templates, nested dependencies, binary resources, empty directories and
`.gitkeep` files keep their original paths and bytes. A Prompt template or
Script README is **not** parsed or indexed as a Note, even if its name ends in
`.md`.

Script `.<filename>.pkm.json` identity sidecars remain byte-for-byte unchanged.
Preflight validates the original identity schema, requires the corresponding
regular Script, and rejects duplicate stable IDs or aliases. Migration does not
mint replacement IDs or drop old URL aliases. Unknown hidden files, pending
state, library Trash, links, special filesystem entries and portable-path
collisions remain explicit blockers; there are no silent exclusions.

On Linux, ordinary library file permission bits are part of the import
fingerprint/receipt and survive publication and workspace backup/restore.
Changes to source bytes, sidecars or modes invalidate the prepared import.
Setuid/setgid/sticky file modes are refused for review, not silently stripped or
activated. Backup files themselves remain private and non-executable; optional
library-only `mode` fields in the existing backup manifest restore the original
file permissions. Older manifests without these fields retain their existing
behavior. Owners, ACLs, timestamps and directory modes are not copied.

Original-source oracle tests compare Prompt listing, metadata, complete version
reads and Script ID/alias resolution before import, after import and after
backup relocation. They also execute the **old** Prompt version-note writer and
Script move writer on the restored disposable library. These checks demonstrate
data compatibility, not migration of those writers into the new Core.
An audited managed import can list preserved library files and empty
directories and read digest-pinned byte chunks without executing them. Small
UTF-8 files expose legacy Prompt metadata or Script text/identity; missing
Script sidecars remain explicitly unassigned. The audit rejects unplanned
library directories, including empty Prompt versions. This does not migrate
Prompt rendering/editing, Script execution, or historical events.
With adopted Knowledge Trash, the embedding host must explicitly assign
`prompts`/`scripts` to the shared importer's source/native snapshot exclusions;
the parent stage inventory still authenticates their files instead of letting
the Trash adapter claim or skip their ownership.

### Canonical Skill source migration: bounded fixture qualification

Workspace schema 23 adds `legacy.skill.source.install@1`,
`legacy.skill.source.remove@1`, `legacy.skill.source.bridge@1`, and the
receipt-bound read-only `subscription.identity.get@1` candidate to the actual
catalog (228 registered operations including adopted Trash deletion/empty);
the memory engine remains at schema 2.
These operations are composed only by an
embedding host that supplies
`skillSource` native callbacks. The CLI and a plain Core do not enable it. It binds
the authenticated actor, workspace, package fixture roots, pinned bundled source,
live ownership and epoch, exact before/after plans, and an independently durable
anchor. It creates a missing canonical source, upgrades recognized bundled
sources, preserves custom sources, and installs the managed projection. Neither
HTTP/MCP arguments nor an operation hash constitute native authority.

Schema 23 adds the separate source intent, immutable history and local receipt
journal. Unknown outcomes block unrelated requests; startup never applies them.
Retry requires the identical actor and request plus explicit native reconciliation
approval. Source history and the older projection lifecycle are currently
excluded from coexisting: their separate journals cannot prove a shared
source-version order. A coordinated native backup and atomic fresh restore/adoption
were exercised with independently authorized prepare and publish, original-writer
installation through Core HTTP/MCP, native reopen, old-request retry, new install,
rebackup, rerestore and restart. Missing approval, tampered, stale or pending
state, and unknown publication/stage outcomes fail closed. Other storage and
direct native writes cannot cross source activity without composed authority.
This does not qualify a general installer, multiple targets, hostile external
writers, OS locking, production authority, or Skill I/O power-loss durability.
The Batch21 full baseline is historical, not current Batch22 verification. The
final Batch22 scoped 28-case Document/Upload/Resource/Project I/O matrix passed
twice with identical normalized reports, and the separate plain no-save run
passed with all 959 covered files unchanged. This does not qualify Skill,
memory, or engine faults, power-loss durability, migration acceptance, or
existing Knowledge Root installation. At the Batch22 checkpoint, the parent
standard retry passed 1395 server plus 9 client tests (1404 total) at that
checkpoint's exact fingerprint; this historical result is superseded by the
Batch23–26 verification below.

Batch21 adds native-composed managed-source removal. It removes only an existing
managed lineage, preserves unrelated/custom sources, and denies mixed legacy
projection/source history because the separate journals do not prove a shared
source-version order. Unknown partial unlink, directory-removal, or post-commit
anchor outcomes require exact native recovery; startup never applies them.
Unix no-follow bounded UTF-8 checks are limited to disposable fixtures. Removal
does not expand the install/backup boundary: no production authority, hostile
external-writer exclusion, power-loss proof, accepted workstream, or cutover is
claimed. The Batch21 1393-test baseline is now historical and stale after Batch22;
it is not carried as current verification.

Batch22 adds `legacy.skill.source.bridge@1`, a native-composed writer candidate
that imports only a strictly pinned, already-installed old source head into
sequence-one native history while preserving its immutable legacy genesis and
receipts. Independent `approveBridge`, `verifyBridge`, and
`reconcileBridgeAnchor` callbacks are required outside SQLite transactions.
Removed old heads must first be reinstalled by the old writer; direct bridging
from a removed genesis is unsupported. Recognized bundled leaves remain
rejected, and custom-source preservation is bounded to the exercised case. The
bridge does not broaden qualification to all legacy targets or workstreams.
Build plus eight independent selectors passed 80 tests; the Batch22 standard
full verification passed 1404 tests at its then-current fingerprint. The
separate scoped storage-I/O results do not qualify
Skill, memory, or engine faults or power-loss durability. See
[`batch22-qualification.json`](./migration/batch22-qualification.json) for the
bounded evidence and limits. Cutover remains unauthorized.

The first Batch22 standard full run was red (1394/1395 server tests; clients
not run). The browser helper now waits for the selected document heading before
using its editor; its original literal unsafe-content assertion is unchanged.
An independent real Chromium selector passed after this test-only Python fix.
Its native pin was refreshed, while all 957 I/O fingerprint inputs and the
source/functional digests remained unchanged. The Batch22 parent full retry then passed all 1404 tests. The initial red
attempt is retained as historical evidence; neither targeted recovery nor the
prior Batch21 baseline is used as the current full result. That checkpoint's
readiness was blocked at 0/21 accepted workstreams. The live blocker count is
derived from the current contract and evidence; run
`node scripts/readiness.mjs --checklist` rather than relying on a historical
count. Full verification does not authorize cutover.

Batch23 adds a bounded native-authorized import path for original subscription
identities whose private Ed25519 keys were historically stored in plaintext.
Private key bytes pass only to an injected durable native secret authority; plans,
receipts, sanitized subscription JSON, identity sidecars, backups and transport
results carry only public metadata and an authority-bound reference. A
receipt-bound sidecar is checked through restart and fresh restore. The new
read-only `subscription.identity.get@1` operation exposes identity and metadata
only; signing, grants, broker, provider, production authority, real-root import,
workstream acceptance and cutover remain unsupported. See
[`batch23-qualification.json`](./migration/batch23-qualification.json) for the
scoped evidence and limitations.

Batch24 adds a separate nonproduction VS Code host package; it does not touch
the production extension. Three adapter tests and two live-runtime launcher
tests pass. Its live Electron E2E also passed with VS Code 1.143.0, the actual
next-server CLI/server, and a fresh synthetic workspace; it covers capability
discovery and reads, identity mismatch, HTTP denial, SecretStorage replacement,
and disposal of three panels. Linux qualification uses an authenticated local
virtual display. This does not qualify the installed production extension,
real Knowledge Root data, provider behavior, or cutover.
Batch25 validates complete Sync entity membership before restore writes. The
new journal records same-byte public-to-private permission transitions and
verifies their durable outcome. Recovery and native preflight classify historic
incompatible prepared journals as `needs-review`. Independent review and
focused tests cover the changed-byte recovery and historical receipt paths;
they do not establish power-loss safety or hostile-writer exclusion. Batch26 adds typed Manager
client start/reconcile/progress/feedback/cancel surfaces; targeted feedback
does not interrupt sibling workers, and worker completion is not acceptance.

For workspace schema 14 and later, a missing legacy state import receipt table
blocks startup and backup restore instead of being silently recreated. Schema
12 and 13 workspaces and backups retain their historical upgrade path.

The final parent verifier passed 1444 server and 12 client tests (1456 total)
at implementation digest
`28d1fd282874e94331d46bc71ad83dab68c8558763e95e8a8c666b6c85128f4a`.
See [`verification.json`](./migration/verification.json) for the current record.
The repeated synthetic 28-case I/O matrix covers Document, Upload, Resource and
Project faults, not Sync or physical power loss. The current functional-parity
contract computes 618 exact requirements; the checked-in qualification-plan
snapshot records 607 for an earlier contract digest and must be regenerated
after implementation scope is frozen. Proposed soak/resource/power-loss
thresholds and operating approvals are separate and do not count as lost PKM
functionality. Readiness remains blocked: 0/21 accepted workstreams, 618 missing
independent-evidence obligations, and one missing independent human/verifier
enrollment. Production cutover is not authorized. All 228 current canonical operations now map to exact workstream
obligations, including the 11 previously unmapped candidates; their separate
evidence requirements remain blocked and none is accepted by this catalog
mapping.

## Run

Requires Node >=22.18.0. Node's built-in `node:sqlite` is experimental on Node 22;
its warning is intentional. Running the server needs no Python or VS Code
process. Full qualification additionally needs Python, its existing compute
dependencies, Python Playwright and installed headless Chromium; browser tests
run the real same-origin client, not a DOM-only mock.

```sh
cd next-server
npm ci
npm run test:qualification

# The target directory must NOT already exist. Its parent must exist.
node dist/cli.js init --data /absolute/path/to/new-pkm-next-data

# Generate a local secret; do not commit or log it.
export PKM_NEXT_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
node dist/cli.js http --data /absolute/path/to/new-pkm-next-data --port 0
```

The HTTP command prints one JSON readiness line with its actual loopback URL.
`--port 0` selects a free port; an explicit port is also supported.
Stop with Ctrl+C/SIGTERM. Pending storage work drains before shutdown.
No server is automatically installed or left running by the test suite.

HTTP example (substitute the port from readiness):

```sh
curl http://127.0.0.1:PORT/v1/capabilities_search \
  -H "Authorization: Bearer $PKM_NEXT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

For MCP, configure a **separate** test server in your client:

```json
{
  "command": "node",
  "args": [
    "/absolute/path/to/next-server/dist/cli.js",
    "mcp",
    "--data",
    "/absolute/path/to/new-pkm-next-data"
  ]
}
```

MCP uses the actual SDK stdio protocol, not HTTP tool emulation. Protocol output
is reserved for stdout; diagnostics go to stderr. The client launching the process
is trusted, so stdio does not use the HTTP bearer secret. Add `--read-only` to
either transport command to restrict that process to read authority.

An explicitly isolated **Knowledge/Todo/Memory compatibility experiment** provides
two separate test entry points:

* Add `--read-only --experimental-legacy-note-mcp` to the Node MCP command above
  for a server exposing only `list_notes`.
* For old compact discovery, named Todo tools and `mcp.tool.*` dispatch, launch
  `python3 /absolute/path/to/next-server/compat/legacy-compact-mcp.py --data
  /absolute/path/to/new-pkm-next-data` as a separate stdio MCP server. This
  bridge starts the Node compatibility entry point in read-only mode and uses `node` on PATH; use
  `--node /absolute/path/to/node` to select it explicitly. It requires FastMCP
  and defaults to `PKM_CAPABILITY_PROFILE=compact`; `legacy` exposes enabled
  named tools directly and uses canonical discovery as the original legacy
  profile does. The original discovery and
  named Todo registration implementations are reused. `path: "todo"` and
  `path: "memory"` discover canonical contracts; unqualified discovery lists
  enabled `mcp.tool.*` aliases. All requests use fixed actor `mcp:external`,
  matching the original token-free external MCP identity. Read-only mode
  excludes mutation contracts and disables named mutation aliases.

The compact bridge requires explicit `--allow-writes` to enable the 29 named
Todo APIs' mutation subset and pending Memory proposals in the isolated
workspace. The native Node entry point is `mcp --experimental-legacy-mcp`
(add `--read-only` to restrict authority). Canonical discovery reuses
source-checked original Todo/Memory contracts and returns the original
`pkm.capability-result/v1` envelope, not the new Core envelope. Named Todo calls
return raw original results. Todo mutations receive a fresh internal UUID on
each dispatch, preserving the old digest-CAS conflict on a repeated stale
request rather than returning an internal receipt as apparent success. There
is no automatic mutation retry. Memory proposals retain the caller's original
`operation_id`; repeated identical proposals replay their durable result.
Confirm/revise/revoke remain absent and rejected, including under write mode.
Board worker tokens resolve only against the exact Board's original hashed
worker grants, retain the granted external identity, and never confer
local-owner or human approval authority. The authenticated Board digest is
rechecked inside native Todo dispatch so grant rotation between authentication
and dispatch fails closed. Tokens are not persisted in Todo requests or receipts.

Original `todo_board_create` now publishes a Note descriptor, native Board and
actor-bound source admission through one recoverable journal. Workspaces opting
into this authority use schema24; existing schema23 workspaces are unchanged.
Both MCP profiles exercise discovery and subsequent Work Item mutations, restart
and relocated backup. Filename compatibility remains limited to portable names.

Bounded `knowledge_recovery_preview` and `knowledge_recovery_apply` use an explicit
host-authorized fixed recovery root, immutable plan/blob hashes and missing-only
Markdown publication. Journal, stage identity and content checks fence replay,
crashes, tampering and source races. This is partial original recovery support,
not private-Git content snapshots, encrypted Agent snapshots or workspace-backup
substitution.

Private-Git `knowledge_snapshot_status`, `knowledge_snapshot_create`,
`knowledge_snapshot_restore_preview` and `knowledge_snapshot_restore_apply`
now use the captured original implementation under persisted native fixed-root
and allowed-tool enrollment. Raw content, Trash behavior, lease/journal checks,
restart and backup are tested separately from Agent snapshots. This authority
opts into schema25. Explicitly enrolled native hosts can now configure a genuine
daily snapshot scheduler with original timezone calculations, persistent
claim/completion state and real timers. Scheduling opts into schema26; it is
default-off and requires an immutable managed-launch admission digest.
Disable, restart, drain and backup admission fences are tested. No OS-global
task registration or production scheduling is performed.

The bounded Action bridge supports original compiler diagnostics, templates,
registration/proposals, graph save, module-set import/load/remove/list and
admitted Action reads. Catalog admission binds exact source roots, inode/path
identity and package bytes to the native workspace. Module imports remain
disabled and diagnostic implementation selection does not grant execution
authority. `action_template_create` supports original poll and monitor
proposals pinned to builtin or selected admitted ModuleSet queries; it does not
approve or execute them. The host-specific Azure DevOps template remains
unavailable. Runtime, management and other remaining Action branches are not
qualified by these compiler/catalog tests. Bounded Action artifact import/export
uses explicit native grants, durable publication/recovery journals and schema27.
Process-death, unknown-effect fencing, backup and coexistence with schema26
snapshot scheduling are covered; neither feature grants arbitrary execution.

`action_retrieve` maps to the native read-only `legacy_action_read` adapter.
For pinned builtins and selected host-admitted ModuleSets, original scoring,
ordinal Action-ID tie ordering, ambiguity, limits, errors and candidate shapes
are source-oracle tested; retrieval does not add `action_get`'s execution contract.
Every candidate remains explicitly blocked with the native runtime-unavailable
reason and `selected_action_id` remains null. Discovery grants no execution
authority. The coverage assessment records this as **partial**, not complete:
original installed catalogs, enabled platform Actions and runtime readiness are
not imported. `action_call` still requires the unavailable original execution
host/policy/one-invocation consent contract; Cosmos configuration additionally
requires explicit private host/VC/account bindings and host credentials.
Neither declaration is mapped to a fallback success. Public catalog membership
and read/write classification are unchanged.
The retrieval source-oracle tests do not waive capture validation: the separate
`node scripts/capture-legacy-action-mcp.mjs --check` currently detects an
`action_modules.py` source/pin mismatch. Its original metadata capture requires
separate requalification; this slice does not refresh any source or capture pin.

The original asset-classification preview/apply/rollback tools are available
through the native adapter for all seven supported asset areas, including
Actions and Components. They are hidden by default. In the compatibility MCP
bridge, both `--allow-writes` and the separate `--allow-asset-classification`
opt-in are required; startup records immutable admission for the fixed actor,
current workspace root and exactly these three tools. Preview state is
session-local; apply requires an explicit proposal subset and rollback the
exact native journal. Classification uses schema28, accepted on restart and
by workspace backup. That admission is root-bound and is not transferable by
backup restore. Classification stays unavailable in a relocated workspace;
use the original workspace to classify or roll back its changes. Repeating
the explicit opt-in at a relocated root still fails closed: the immutable
singleton admission and every historical event/intent retain their original
root and inode pin. Neither restore metadata nor original journals authorize
a replacement root.

The bridge also runs source-captured original `get_note`, `list_skills`,
`list_papers`, `list_research`, `get_research`, `get_paper` and `paper_graph`.
Original signatures, descriptions, read-only hints, content hashes, missing-item
strings and leaf result shapes are retained; `get_note` includes original
Recipe linkage and the Board authority message instead of presenting Markdown
as task authority. Original `list_skills`, `list_papers` and `paper_graph` lack
read-only hints and therefore remain unavailable in read-only mode. Python reads
only a Node-owned immutable Markdown snapshot; workspace lease, content, inode,
timestamp, directory membership and Recipe snapshots are rechecked before a
result is returned. Native directory enumeration order is retained for original
stable-sort ties and duplicate-title citation resolution; graph nodes themselves
retain the original unordered-set behavior.

`node scripts/capture-legacy-knowledge-mcp.mjs --check` checks the exact original
Python functions and Recipe linkage helpers. The indexed adapter now supports
`get_knowledge`, `get_script`, `search_knowledge` and `search_scripts` using the
pinned original retrieval wheel and captured snapshot/worker functions. Local
sources, current native Boards and admitted subscription caches participate;
the shared SQLite generation metadata is derived, not a second content authority.
Reads recheck source freshness, imported cache receipts and native subscription
authorization, including revocation, before returning results. Configured model
serving and retrieval feedback/learning are supported only through explicitly
host-admitted local portable model packages and actor/source/model-bound
receipts. Package hashes, native selection authority and shared-SQL learning
state are revalidated on reads, restart and backup. Startup recovery publishes
only authenticated committed package bytes; it never executes models.
All ten original portable architectures are exercised against independent
original full-corpus and scoped rankings, including fitted PCA and token paths.
Explicit offline `retrievalHistory: { stateRoot, actorId }` import in
`planLegacyImport` preserves current-schema learner salt/history/user labels,
all installed packages and selected or null model state.
`importLegacyWorkspace` requires a native `authorizeRetrievalHistory` decision;
source bytes and immutable native genesis are receipt-bound. Historical call
IDs do not automatically acquire native feedback authority. Supported
predecessor schemas, including the original base schema without judgments,
upgrade only through the captured original initialization logic in memory;
raw source schema/state hashes and normalized genesis hashes remain distinct.
Selected portable frozen releases preserve their original identity and verify
model, corpus, source bytes and approval-time freshness before publication.
Inactive/null frozen releases, nonportable reranker/graph artifacts and remaining
metrics/management branches are still incomplete. Managed model execution additionally
requires an explicitly provisioned dependency profile satisfying the original
requirements; ordinary FastMCP packaging does not imply model support.
Offline random tiny-model tests demonstrate execution, not retrieval quality
or full original retrieval parity. The compatibility
backend now owns a persistent original Python worker with real process/resource
status and incremental source updates, and closes it when the backend closes.
Configured-model and learning status branches remain incomplete.

Original `skill_feedback` and advisory `propose_skill_update` now preserve
source-matched results and artifact bytes through a native durable journal.
Imported feedback/proposal artifacts bind immutable genesis provenance; startup
recovery projects only committed local journal effects. Backup and reads reject
unreceipted changes, rollback and tampering. Proposals do not directly update
Skills, raw tasks are not persisted, and no external collector is enabled.
Scale tests import 521 proposals and 600 feedback entries in a 2.9 MB JSONL file;
existing explicit generic host import/backup quotas still apply.

`todo_board_create` now uses the original captured schema/result while native
Board admission atomically publishes the Note descriptor and Board under
host-authorized actor/worker grants. The read-only and write-capable compact and
legacy MCP profiles both exercise creation, replay denial, restart and
relocated backup. Board filenames preserve the original raw title/category
mapping; unsafe names and unsupported layouts are rejected, so coverage remains
partial.

The original missing-only `knowledge_recovery_preview`/`apply` behavior is
available through explicitly named `legacy_knowledge_recovery_*` MCP adapters.
A native host must first approve the fixed evidence and audit roots and exact
plan digest. Recovery accepts only portable UTF-8 Note/Skill Markdown outside
System, refuses Boards and assets, never overwrites different existing bytes,
and journals/reconciles publication under the workspace lease. This narrower
native authorization and supported-file set is not full original recovery
parity.

Action reads and proposals use `legacy_action_read`/`legacy_action_write` in
the compatibility profiles. Original metadata and execution-contract capture
is checked from `action_modules.py` and `action_run_store.py`. The `action_get`
adapter can inspect only selected, host-admitted portable ModuleSet Actions;
it returns the original execution contract with availability explicitly
blocked because this next-server projection has no original Action execution,
authorization or readiness runtime. That blocker is independent of GPT-based
risk review, which is not represented or required by this projection. It does
not grant readiness or execution authority. Builtins, nested dependency
readiness and Action execution remain unavailable.

The original `action_get` contract is supported only for selected portable
ModuleSet Actions with no dependencies, admitted as package data by the native
host. It returns the original execution contract and explicit runtime-
unavailable blocked status, not execution authority. Action graph authoring
checks exact dependency pins and structure without requiring prior GPT
validation of children; this does not add `action_call`, background preparation
or an admission path. Builtins, original installed catalogs, dependency
readiness and validated or callable Actions remain unavailable.

Subscription cache import validates exact membership, paths, assets and source
hashes without arbitrary cache file-count, byte-total or depth ceilings.
Non-cache control-state limits and explicit host backup-depth policies remain.
Hashing and copying use bounded buffers; JSON metadata is validated per file.
Tests cover 524 cache files, over 37 MB, a 3 MB asset, complete subscription
pagination and 68-level import/restart/relocated backup restoration.

Subscription Skill listing uses imported, receipt-bound cache membership and
still fails explicitly if subscription metadata exists without a validated
native cache/identity binding. It never silently returns only local Skills in
that case.

Neither entry point replaces the existing extension registration or provides
full legacy MCP compatibility. The original MCP middleware is not active in
the bridge. Both need the repository's `resources/note_inventory.py` and the
files under `next-server/compat/`; the bridge also needs
`resources/capability_api.py` and `resources/todo_api.py`. They run only against an initialized or
imported isolated workspace, with normal workspace lease and startup/recovery
checks. Those checks can reject duplicate identities before the old inventory
can report them; this is a known compatibility gap. Startup can perform normal
storage recovery even though the exposed operation is read-only. This is not
a production cutover.

`node scripts/capture-legacy-mcp-contracts.mjs --check` checks the exact
source-derived canonical contracts; the stdio compatibility tests invoke it
without rewriting captures. This adapter does not qualify original Memory
database/scope migration, live Chat agent assignment, other legacy knowledge
tools, managed lifecycle, the installed extension, or full migration.

The existing Chat MCP connector is also tested against the actual isolated
bridge for generation handshake, Note invocation and graceful admission/drain.
The same real connection discovers and invokes the original Note and Research
reads and verifies that tools without read authority are absent.
This uses the original `ManagedMcpLifecycle` middleware, not a bypass of Chat's
handshake. `--managed-generation /absolute/path/to/generations/UUID` accepts an
already-created experimental manifest only: server/component versions must be
`0.1.0` and `enabledFeatureDomains` must be empty. It refuses to claim production
component versions or complete domains. This is a disposable test fixture, not
an installed-extension switch or production generation publisher; full managed
lifecycle/update parity remains unqualified.

Only one process may own a workspace at a time. HTTP and MCP processes must be
started sequentially for the same workspace: stop the first process cleanly
before starting the second. A second owner is rejected with `BUSY`; this
single-owner lease fences recovery and writes.
The HTTP API is JSON RPC-like POST, **not** MCP Streamable HTTP.

## Batch 07 configured launcher and qualified scope

Earlier Batch 04–06 descriptions below are historical slices; explicit Batch 07
host composition supersedes their statements that configured execution is
library-only. The unconfigured CLI still denies model/tool/Action execution.
The production extension remains unchanged. **All 21 full-migration gates remain
unaccepted (0/21)**; implemented slices are not an effort/completion percentage.

An operator may explicitly launch a configured **HTTP** host. Configuration must
be an absolute, owner-only regular file (`0600`) in an owner-only directory
(`0700`), without symlink aliases. It uses `pkm.native-host-config/v1` with provider,
exact endpoint, `secretRef`, model, context/output bounds, output token parameter,
usage flag and the admitted tool list. Configuration alone grants nothing:
separate launcher policy must admit each provider, endpoint, model and tool.
Secrets are resolved from explicit reference-to-environment mappings, never
stored in configuration, SQLite or public diagnostics. Redirects are rejected.
Cleartext loopback providers additionally require explicit opt-in.

```sh
node dist/cli.js http --data /absolute/new-isolated-workspace \
  --config /absolute/owner-only/host.json \
  --allow-provider openai-compatible \
  --allow-endpoint http://127.0.0.1:12345/v1 \
  --allow-model synthetic-model --allow-tool knowledge.document.create \
  --secret-ref secret:local/provider=LOCAL_PROVIDER_SECRET \
  --allow-insecure-loopback --human-review terminal
```

`PKM_NEXT_TOKEN` remains the machine API token; `LOCAL_PROVIDER_SECRET` is supplied
privately by the operator. The terminal's native review channel accepts stdin
JSON lines `{"action":"read"}` and
`{"action":"decide","input":{"id":"…","expectedRevision":1,"intentDigest":"…","decision":"approve"}}`.
It returns exact review records/results on stderr. Decisions are `approve`,
`reject` or `cancel`; `{"action":"renew"}` explicitly renews the short-lived
human session. Approval requires the viewed revision and intent/source pins, not
an agent's success claim.

`--human-review browser` prints a one-use, two-minute enrollment code **only to
the native operator channel**. Open `/human-review` at the readiness URL and
enter that code. The actual safe-DOM modal displays exact arguments, actor,
workspace, effect and source/record pins. Its short-lived `HttpOnly`,
`SameSite=Strict`, path-scoped cookie resolves a distinct native capability.
Neither machine HTTP/MCP calls nor bearer-plus-human-cookie requests can approve.
There is no generic bearer grant, credential storage in browser storage, or
automatic approval. Treat the enrollment code as private; do not capture logs
containing it.

`--manager-text-config /absolute/owner-only/manager-text.json` additionally opts
into `{"mode":"pinned-sqlite-text-artifacts/v1","contract":…,"expected":{"deliverables/worker-1/result.txt":"exact bytes"},"maxConcurrentTurns":20}`.
The native CompletionContract and complete expected map gate acceptance.
Qualification ran a real spawned CLI against a local socket SSE provider:
structured planner → **20 simultaneous Chat workers** → integrator → verifier →
native whole-manifest equality. Artifacts persist **only as SQLite text
artifacts**, read using `manager.chat.artifacts` with the exact freeze pin; this
does not qualify generic filesystem/code-editing workers. Existing bounded
Manager tests additionally cover intermediate results, target-only feedback,
owner-specific repair, malformed/bounded model outputs and unknown/no-replay.

Action execution is wired through the real native Core dispatcher only when a
trusted host injects `createNativeRuntime({storage,hostServices:{action:{process:{commands:…}}}})`.
Each command requires exact executable/arguments and actor/workspace/compiled
definition/input authorization callbacks, native approval and output redaction.
The qualified path compiled an Action, spawned an actual direct child, persisted
redacted lifecycle events, cancelled/drained a live child and preserved immutable
receipts. **No CLI JSON process-command grant exists**, and public clients cannot
submit ticks or results. Process-tree lifecycle and arbitrary adapters remain
unsupported.

The low-level `action.runtime.create` path can run an exact compiler-pinned
inline source without GPT validation, provided the trusted host has installed an
exact native adapter and its authorization/data/approval callbacks accept that
actor, definition and input.

A native host may explicitly opt into automatic exact-revision admission by
supplying `hostServices.action.automaticTrusted`. Its `current()` value must be
derived from the host's trusted-workspace decision and bind the actual workspace
ID, actor ID and a changing trust epoch; `revoke()` must disable trust and advance
that epoch. MCP arguments cannot supply this authority. Admission records bind
the immutable proposal, compiled digest, actor, workspace and trust epoch.
Creation/call and every node dispatch recheck the current trust and exact latest
revision. The process bridge checks trust again after native effect consent and
immediately before launch. Newer admitted revisions supersede older ones;
revocation or any trust-epoch change fails closed. The separate `action_call`
tool is registered only for this host opt-in and uses an immutable idempotency
receipt. It does not grant effect consent: input validation and per-invocation
consent remain in force. Hosts may still use the existing exact command-policy
adapters; the explicit trusted-program opt-in below instead permits declared
programs without a per-program allowlist.

With this host opt-in, a successfully admitted proposal reports `registered`
and `callable`; `action_get` and `action_call` resolve its exact latest Action ID
and content hash. A new call obtains effect consent before publishing its Run
or idempotency receipt. Refusal returns `ACTION_EFFECT_CONSENT_REQUIRED` from the
call without creating a Run or launching a process. Trust and revision are
rechecked after consent; identical completed call requests reuse their receipt.

`createVscodeActionTrustBridge` is the concrete bridge for a separately running
native host. `startStandaloneHost` accepts a host-configured
`actionTrustActorId`; it pins the canonical data root and workspace ID, reads
only the owner-protected `.pkm/state/actions/host-authority.json` endpoint, and
checks the VS Code authority over its token-authenticated loopback channel.
Admission refreshes that authority, and native process launch reauthorizes the
exact action revision and epoch. The MCP client cannot choose the actor, root,
endpoint, token, or trust state. Host revocation advances the epoch and disables
the current VS Code authority until the host authority is recreated.
The VS Code authority endpoint is gated by workspace trust and the automation
domain, not by the legacy Python qualification runtime; the next-server bridge
does not call legacy qualification or GPT validation.
An embedding that serves the original Action MCP tools must route them with the
same host's fixed actor and `services.hostServices`; it must not reconstruct
trust from request arguments.

For an explicitly selected Next workspace, `StandaloneHost.selectedOwnerContext`
combines its live Storage lease with a synchronous selection fence supplied by
the trusted embedding host. The lease is not proof of profile selection or
authority over a legacy root. An explicitly bound `ManagedClientHost` also
revalidates its own open/closing state; imported read-only and Room-only hosts
do not expose this capability. Registered child hosts must finish closing before
Storage is released; a failed child close keeps Storage held and makes shutdown
retryable while admission remains closed. The embedding host must revoke its
selection and close its child on disconnect. This interface neither registers a
production selection provider nor enables automatic legacy-root cutover.
The existing managed-child `close` message similarly stops admission; `closed`
is sent only after the owner drains and is followed by process exit. If a
connected child's owner fails to drain, `close-retryable-error` keeps its
channel and owner alive for an explicit close retry. A disconnected child cannot
send an ACK: even when it later exits cleanly, the parent must treat an
unacknowledged shutdown as unknown. These messages do not establish profile
selection, old-source exclusion or authority to adopt a legacy root.

For an explicitly selected isolated next workspace, the VS Code command
**PKM: Enable Trusted Actions for Isolated Next Workspace** starts a separate
authority after workspace trust, the automation domain and confirmation; the
selected private directory must be inside the trusted VS Code workspace. It
does not replace the existing Knowledge Root. Run the next CLI with
`mcp --data /absolute/isolated-workspace --experimental-legacy-mcp
--experimental-trusted-actions`. The fixed actor is `mcp:external`; the private
endpoint is `.pkm-action-authority/host-authority.json`. Without the flag the
old CLI behavior is unchanged. An unavailable authority denies admission.
`action_trust_status` and `action_trust_revoke` report and revoke that host
authority; revocation fences active runs and advances the epoch.

This opt-in permits a supported Action's declared program and argv without a
per-program allowlist or mandatory function/GPT check. It uses shell-free
direct-child execution, bounded stdin/stdout, and direct-child cancellation; programs are
**not sandboxed** and run with the host's OS permissions. Every program,
pipeline and managed artifact-copy invocation requires VS Code data/effect
consent before a Run or receipt is published; the
prompt shows an input preview and exact input digest. Input and validated output
may persist in workspace runtime state. Descendant processes are
not managed or guaranteed to stop. On a successful owned program run, legacy
`action_run_get` returns the adapter's schema-validated, size-bounded result
as top-level `output` only to the same authorized actor in this workspace;
revoked trust does not release it and reports
`output_availability: { state: "blocked", reason: "ACCESS_DENIED" }` while keeping
the run's status readable. It excludes inputs, raw process logs and
environment. The trusted-program adapter returns the declared result unchanged:
there is no automatic secret detection or GPT redaction, and the Action author
is responsible for what the result contains. Core runtime status and events
remain metadata-only. The transient authority token is excluded from
workspace backups. This path supports programs with plain JSON output or
`pkm.action.result/v1`: protocol stdout must be a bounded JSON
envelope `{ "ok": true, "output": {...} }` or
`{ "ok": false, "failure": { "code": "...", "message": "...", "blocked": true } }`
(`blocked` is optional). The successful inner output is schema-validated and
returned under the owned-output policy; an inner `terminal: false` is ordinary
data, not an incomplete local invocation. Extra envelope fields, malformed or
oversized output fail closed with an explicit node reason. Reported failure
and blocked failure have distinct node reasons; arbitrary failure messages are
not returned. A reported failure is `failed` for read-only effects and
`unknown` for potentially mutating effects, which may have already occurred.
On Linux, an enabled trusted VS Code
host exposes `action_artifact_pick_import` with an empty input object. The user
selects a local regular file and explicitly approves its exact path, SHA-256,
size, workspace and fixed actor. The host rechecks the bytes and creates the
borrowed artifact reference; callers cannot supply a path to this picker.
Cancelled, changed, linked, oversized or revoked selections are rejected.
The source grant is valid only for the approving trust epoch and is not
reinstated after revocation. The exact packaged
`core.artifact.copy` builtin is available on Linux. It accepts one existing
host-admitted artifact reference, displays its ID, SHA-256 and size for
per-invocation data/effect consent, then verifies and copies its exact bytes to
the native Action artifact store. A pure pipeline can accept exactly
`{source: {artifact_id}}` for an already published managed artifact and return
that same reference, for example through `core.constant`. The host verifies
the original successful owner, current trust and bytes, and displays its ID,
digest and size in the pipeline consent. This is reference forwarding, not
program artifact materialization or a new artifact; arbitrary or borrowed
references and other artifact-shaped pipeline outputs remain unsupported.
The copy builtin's output is a new `{artifact_id}` owned by
the successful run and fixed actor, not a caller-supplied path. Managed bytes
are stored with their owner, workspace, source and executable revision in the
existing native artifact table; reads recheck ownership and digest. Artifacts
are limited to 32 MiB and the workspace artifact-record budget to 64 MiB
(including encoded content). Failed or interrupted runs never publish their
artifact; an interrupted run may retain inaccessible data against that budget.
The native workspace backup includes these managed bytes, while borrowed source
paths and their old grants are not restored as fresh authority. A user can
export a published managed artifact with `action_artifact_pick_export`, passing
only `artifact_id`: VS Code selects a new local destination and confirms its
exact path, artifact ID, SHA-256, size, actor and workspace. Export never
overwrites; the destination grant binds those bytes and the current epoch.

The bounded program artifact path uses the original
`invoke_from_environment("core.artifact.copy", inputs, key)` interface, or
`python -m action_modules --invoke core.artifact.copy key` with JSON on stdin.
The host provides a hash-checked compatibility helper with the original
`PKM_ACTION_CONTEXT` store/run/capability binding and a private invocation
transport; it is not the full legacy `ModuleRuntime`. The parent must declare
exactly the packaged `core.artifact.copy` dependency hash and both local-read
and local-write effects, have no build, and accept exactly
`{source: {artifact_id}}`. The program and its one nested copy each require
separate consent. The nested copy creates new managed bytes; its result is
private until the parent successfully returns that exact reference. Parent
failure, cancellation or revoked consent cannot publish it. Ownership, bytes,
parent/child binding and trust are checked on reads, restart and restore.
Other program artifact APIs, arbitrary nested Actions, builds with nested
artifact calls and protocol envelope `artifacts` remain unsupported. Programs
and their descendants still run with host OS permissions; this is not a
sandbox. Pure pipelines are limited to
explicit `javascript` implementations of `core.constant`,
`core.math-expression`, `core.cast` and `core.lookup`, using the source-hash-checked original JavaScript
component engine packaged in the runtime inventory. They support `$input`,
`$step`, and `$literal` references and require the same invocation consent,
actor, workspace, revision and trust epoch as programs. Integral numeric or
structured values cast to strings are rejected because JSON cannot preserve
the original numeric provenance; unsafe integers in cast/lookup data and
outputs are also rejected. The exact packaged `core.cast.string-to-float`
definition can be registered without runtime identity fields and called as a
standalone pure builtin. Its packaged definition/source and JavaScript engine
are pinned to the adapter, and its host-generated revision is independently
bound to actor, workspace and trust epoch. It does not start a process or
request process consent. Negative zero and unsafe integral results are
rejected rather than silently changed. The host-generated revision hash is
not the captured original builtin hash: the captured float example loses
`150.0` versus `150` provenance in JSON. Neither that captured hash nor an
archived grant is execution authority. Other components, including
`core.file-path`, control-flow, polling, interactions and nested Actions,
`$op`/`$var`, other standalone builtins (including artifact write, integer casts and date),
effectful pipelines, MCP
implementations and other build shapes are unavailable. The original JavaScript
engine's `round(value)` and `round(value, integer-literal)` forms are supported
when the entire expression is one such call and its value is a numeric literal
or a single numbered input. Nested/composed round calls and dynamic precisions
are explicitly unavailable because JSON cannot preserve float provenance;
integer inputs outside JavaScript's safe range are rejected. Only validated
final output is returned, never intermediate node outputs. The executable must already
exist (absolute path or on the host PATH); PKM does not install or download a
missing runtime.

The supported legacy program `build` shape declares `program`, `args`,
`source_files`, `outputs`, and optional integer `timeout_seconds` (1–300).
Newly authored sources must be direct, unique, bounded regular files in the
owner-only `<workspace>/.pkm-action-sources` directory, with absolute paths used
as separate build argv elements. Outputs must be unique direct filenames.
Compiler argv may use `${build_dir}`; before compilation sources are copied as
`source-<index>-<basename>` in a fresh private build directory and exact source
argv elements are replaced with those copies. The run program must be a declared
`${build_dir}/<output>` or an installed executable whose argv names such an
output. Other source layouts, nested output paths, `files`, automatic source
adoption, and toolchain installation are unavailable. Registration does not
build. Before either child starts the consent prompt shows the complete build
and run plan, source hashes, compiler hash and installed-runtime hash when
applicable; those pins, the exact
revision, actor, workspace and trust epoch are rechecked. Build and run have
separate durable process jobs. Compiler failure, missing or unsafe output, source
changes, cancellation, and interrupted work never run a prior build; cancellation
is direct-child-only and unknown effects are not replayed. The private
`.pkm-action-sources` directory is included in workspace backup;
`.pkm-action-builds` contains disposable per-invocation outputs and is excluded.
Neither build nor result reading executes an imported Action archive.

`node dist/cli.js backup --data /absolute/new-isolated-workspace --destination /absolute/NEW-backup`
is an explicit offline/native-host operation, not an HTTP/MCP capability. Native
`services.hostServices.backup` also requires an authorization callback and actual
quiescence; restore is the authorized native helper into an absent destination,
not a CLI restore command. The snapshot uses SQLite `VACUUM INTO`, not a live
database file copy. Qualification preserves workspace identity/Markdown/assets/
receipts and rejects active Manager/Chat/Action/process work, pending journals or
intents, and changed/unsafe layouts. It does not establish power-loss durability.
Restore now requires an independent native lineage authority, including for
older backups with no erasure marker. The authority binds the actor, source
identity, manifest digest, workspace, destination and restore intent before
staging and is checked again before publication. A protected lineage cannot be
restored from an unpinned legacy backup; missing approval is denied. This does
not erase existing backups or establish physical secure deletion.
There is currently no safe standalone restore CLI: the CLI has no independent,
rollback-resistant lineage authority. A confirmation flag, a manifest hash, or
an assertion copied from the backup cannot establish that its workspace is
unrelated to a protected erasure lineage. The fixture-only test authority is
not a production authority. A future CLI must obtain an independent decision
bound to the actor, exact workspace, backup directory device/inode and manifest
hash, destination and restore intent, and revalidate it before publication.
Classified data, canonical Skill source, imported Trash and subscription
identity may require additional independent authorities. Protected lineage is
currently rejected by this unpinned-backup restore API, even with an authority.

Restore requires an absent destination outside the backup tree, with a real
canonical parent, and uses no-replace publication. An unpublished
`.pkm-restore.*.stage` in that parent blocks another restore; do not blindly
delete or publish it. The API does not provide a standalone stage
inspection/reconciliation command or a durable restore outcome receipt, so
an interrupted or uncertain restore requires native inspection of the
destination and retained stage before any retry. These constraints do not
authorize use against a real workspace or production cutover.
Paired backup/restore is now qualified only for an explicitly native-owned
disposable fixture with one absent workspace destination and the engine
database at `packages/.pkm-native-memory/memory.sqlite3` inside that workspace.
The host drains and fences its owned engine worker and workspace writers,
validates the SQLite engine and immutable receipt lineage, stages one directory,
and publishes it with no-replace semantics after independent native adoption
authority checks. Tests exercise actual Core HTTP/MCP forget receipts, a native
Python worker, same-ID receipt retries, a subsequent forget, restart, rebackup
and rerestore. Batch18 used workspace schema 21 and engine schema 2;
Batch19 advanced only the workspace to schema 22. Batch20 is now developing the
canonical Skill source operation on workspace schema 23. Its cross-transport and
coordinated backup/restore coverage is bounded to native-owned disposable
fixtures. The memory engine remains at schema 2.

The paired host additionally requires `engineStateAuthority.read/commit`,
an independent native content-seal provider outside both restore targets.
Its commits must be durable before returning success. The shared read-only
artifact validator checks engine identity, integrity, complete bytes and all
SQLite objects/tables before worker startup. Authorized owned dispatches and
forget receipt/epoch commits advance live seals; only a safely drained close
may normalize the closed engine and publish its exact closed seal.
An unsealed/unknown effect or live crash seal cannot authorize reopening.
Actual tests reject same-inode payload and header tampering, retain legitimate
write/forget/restart behavior, and fence a real effect when native seal commit
is denied. These are bounded tests, not an exhaustive hostile-writer proof.

This does not qualify external engine targets, two-target layouts, hostile
external writers or a general interprocess lock, production native authority,
automatic replay/reconciliation, physical erasure, power loss or a production
SLO. The older 28-case injected storage-I/O matrix covers Document, Upload,
Resource and Project only; it is not engine-fault evidence. Memory-engine
fault cross-products and exhaustive hostile lineage combinations remain
unqualified.

Batch19 separately registers `knowledge.classification.original-compatible.command@1`
under `pkm.legacy-classification.original-compatible/v1`; the strict classifier
is unchanged. A trusted host must inject `originalClassification` with independent
native fixture ownership, actor/epoch, retained original preview, genesis/history
and pending-head grants. Preview/apply/rollback preserve the bounded original
ordered skips, known-error journal prefixes, UUID result and reverse rollback,
not strict whole-selection semantics. Every retry still checks current authority.
All filesystem work and native adoption-authority callbacks run outside SQLite
transactions; transaction admission rechecks the exact authenticated history
using pure SQL for both strict and original-compatible classifiers.

Native `classificationBackup.originalCompatible: true` selects this lineage;
it grants no authority. `authorizeClassificationAdoption` and independently
checked `assertAdoptionAnchor` bind manifest/source-root, destination/stage pins,
native epoch, actor, policy and expiry before staging and publication. Separate
immutable adoption rows preserve original receipts, result and journal bytes.
Mixed strict/original backup histories and unknown staged residue are denied.
Prior workspace/backup schemas 12–21 remain isolated inputs, unchanged until
explicit open migrates them to 22; engine schema 2 is unchanged.
The qualification covers exclusive native-owned disposable Unix fixtures only,
not every asset, hostile external writers, production authority or any workstream
acceptance. The storage-I/O matrix covers Document/Upload/Resource/Project only,
not classification, engine, memory or Skill fault recovery. Cutover remains
unauthorized and acceptance remains 0/21.

The isolated VS Code seam now requires authenticated `server_info` workspace and
actor IDs, exact `serverId: "pkm-next"`, protocol and workspace versions. Actual
spawned CLI handshake tests reject missing/wrong identities even if a caller
offers an attestation. It is not installed or switched into the production
extension.

Qualification: `node --test tests/batch07-cli.test.mjs tests/batch07-human-browser.test.mjs tests/batch07-manager-cli.test.mjs tests/batch07-native-services.test.mjs`
(11/11 new targeted checks; 47/47 when combined with the existing bounded Manager
Chat/integration selectors), plus the isolated client selectors (9/9) and
read-only provenance selectors (9/9). Chromium
screenshots were visually inspected and disposable workspaces/browser profiles
cleaned; only synthetic local data/providers were used. Real SIGKILL recovery
waits the actual 30-second ownership lease and marks interrupted inference
unknown with zero automatic replay. Immediate restart is deliberately refused.
The existing bounded soak (~1.18 seconds, ~82.6 MB RSS) is a measurement, not
complete stability, a production SLO or a power-loss claim. Fingerprinted full
`npm run test:qualification` evidence is refreshed separately only after all source/test/pin lanes
freeze; targeted passes alone are not full-suite acceptance.

### Batch 08 configured coding, Channel and remote wrappers

The configured coding CLI now has an isolated end-to-end regression using a
local socket SSE provider: workers read disposable sources, propose scoped
patches, run native Node checks, repair a failed check, merge disjoint changes
and pass functional E2E without changing the source checkout. Coding process
state uses a distinct durable database; startup refuses unsupported backups and
active/unknown coding effects remain fenced. This is a local synthetic provider
and disposable source test, not production coding-worker approval.

The real headless Chromium workflow test exercises a mounted same-origin client
against HTTP: a stale document CAS conflict does not overwrite server content,
an interrupted upload resumes under the same mutation, delegated Todo review is
denied by native authority, and an active Action is cancelled. Attachment
controls are cleared and epoch-fenced during asynchronous document reloads so
stale file inputs cannot submit against a newer document revision. Browser
screenshots are kept in memory; no browser helper or server is left running.

The composed native Channel regression uses two distinct authenticated HTTP
peer sessions plus a separately held human authority. It requires explicit
invitation approval and reconnect for both peers, rejects caller-supplied role
forgery, delivers one directed Manager-pinned task, records update/reply
projections through SQL hooks in the canonical Manager transaction, verifies
mailbox cursors and a bounded wait, and checks that revocation cancels the wait
and denies later reads/reconnects. It does not create an alternate task table,
spawn an agent, or grant room-wide broadcast authority.

The configured remote wrapper tests use only a local mock GitHub HTTP server
and a local synthetic subscription broker. Before every mock GitHub mutation,
the fixture independently reads the real workspace database and requires both
the durable native publish intent and transport journal. The no-op publish
preserves unchanged managed and unmanaged files; missing all-writer policy and
a stale foreign ref fail closed before writes. This mock boundary is **not**
GitHub expected-SHA compare-and-swap and does not qualify credentials or real
publication. Remote runtime methods are native-only and intentionally absent
from public HTTP/MCP catalogs. Subscription tests cover fork materialization,
readonly mirror, mirror/fork separation, ACL revocation after fetch, source-pin,
digest, version and path drift, with no production broker or outbound request.

`node scripts/readiness.mjs --checklist` remains a read-only blocker report, not
an approval tool. It measures functional parity against the existing PKM scope;
the report separately lists optional operational soak/resource/power-loss gates.
Scope confirmation remains required to prevent silent exclusions, and final
cutover remains a separate human authorization. Unknown catalog operations are
not auto-mapped. Do not enroll a test key or use a test total to mark the
migration ready. `--require-ready` exits 1 while independent evidence is
missing. Only the final fingerprinted `npm run test:qualification` after all source/pin lanes
freeze can refresh full-suite evidence.

### Operator-supplied readiness evidence (read-only)

Defaults still load no receipts or signing authorities. Explicitly evaluate
existing independent evidence with:

```sh
node scripts/readiness.mjs --evidence /operator/receipts.json \
  --trusted-authorities /operator/enrolled-public-keys.json --json
```

Both flags are required together; paths resolve from the working directory.
The evidence JSON is
`{"schema":"pkm.readiness-evidence/v1","evidence":[...]}`, with existing
`pkm.readiness-attestation/v1` records containing only `authorityId`, `payload`
and `signature`. Signatures remain base64 Ed25519 over recursively key-sorted
payload JSON. The separate trust JSON is
`{"schema":"pkm.readiness-authorities/v1","authorities":[...]}`; each entry has
a unique `id`, `roles:["human"]` or `roles:["verifier"]`, and `publicKey` as
an Ed25519 public SPKI PEM. Human and verifier keys must differ.

The trust registry must be independently enrolled and outside this repository;
repository paths and symlink targets are rejected. Alternatively,
`--trusted-authorities -` reads that **separately selected operator registry**
from stdin. Stdin is an explicit trust decision, not an independence detector:
the operator must authenticate enrollment out of band and must not redirect
repository-controlled keys or receipt-provided keys into it. Nothing
auto-discovers/enrolls authorities, generates keys/signatures, or approves
policies. Trust input is per invocation and is never persisted.

Exact scopes, current contract/inventory/implementation fingerprints, required
checks, role separation and actual local artifact bytes still govern each
receipt. Artifact paths remain relative to `next-server`, under `migration/`
or `tests/`, with symlinks refused. Valid but stale/untrusted/insufficient
receipts remain ordinary blockers; malformed or unreadable explicit inputs
produce stderr, no success-shaped report, and exit 2. A valid blocked report
still exits 0 unless `--require-ready` requests exit 1. Inspection makes no
network connections or writes, and even a qualified report is never final
cutover authorization.

## Shared contracts

Both adapters use exactly one Core registry and executor. Five bootstrap methods
are available as MCP tools and `POST /v1/<method>`:

| Method | Input | Purpose |
| --- | --- | --- |
| `server_info` | `{}` | Isolation, limits and supported features |
| `capabilities_search` | Optional `query`, `offset`, `limit`, `revision` | Bounded authorized catalog summaries |
| `capabilities_describe` | `operation` | Exact version, input/output JSON Schema and authority |
| `capability_read` | `operation`, `version: 1`, `arguments` | Read-only operation |
| `capability_call` | `operation`, `version: 1`, `arguments` | Write-authorized mutation |

The read-only MCP process omits `capability_call` entirely. Its catalog excludes
mutations. HTTP retains the route but the Core denies mutations.

### Batch 04 bounded runtime operations

The current registry exposes these isolated, host-neutral slices through the same
HTTP and MCP dispatchers:

- `chat.session.capabilities`, `create`, `list`, `get`, `messages`, `append` and
  `archive` persist actor-scoped transcripts only. Generation is unavailable,
  replay is disabled, and these operations do not invoke models or tools.
- The original `api_chat_capabilities`, `api_chat_models`, `api_chat_list`,
  `api_chat_get` and `api_chat_request_get` MCP names expose only safe native
  reads. The sole accepted `host_id` is the isolated workspace identity;
  models are configured VS Code profiles (not a callable-model probe), Chat
  reads are actor-private, group filters and legacy Hosts are unsupported, and
  request polling fails closed because this runtime has no compatible native
  API Chat request-receipt store. No external provider is contacted.
- `workflow.run.create`, `get`, `events`, `ready-nodes` and `cancel` persist
  lifecycle state for validated noop workflows only. Results explicitly identify
  `host-only-noop`; model, native-step and process execution are not exposed.
- `recipe_capabilities` exposes a bounded, read-only projection of native Recipe
  metadata and static workflow compiler limits. It does not provide original
  Recipe search/create/run lifecycle or imply provider/autonomous execution.
- `sync.plan.create`, `get` and `decide` operate on offline snapshots and review
  decisions. They never fetch, publish or apply changes through GitHub.
- `collaboration.state.list`, `read` and `leave` expose actor-scoped room state
  and self-leave only. Room creation, join, mute and close remain host-authorized
  operations outside the public registry. A host-supplied `collaborationKind`
  determines identity mapping; no HTTP/MCP argument can choose an actor or kind.
- `action.compiler.capabilities`, `action.definition.check` / `compile`,
  `action.moduleSet.project` and `action.graph.compile` are deterministic reads
  and authoring diagnostics only; they do not persist or execute actions.
- The legacy `action_capabilities` name returns only a limited deterministic
  compiler projection. Original host, registry, scheduler, provider and runtime
  fields are unavailable; it does not enable Action execution or mutation.
- The legacy `action_run_get` view reads native-owned run status metadata and,
  for authorized successful trusted-program runs, the validated owned `output`
  described above. It omits source, inputs, credentials and raw execution logs.
  Legacy run records, monitor notifications and checkpoint/resume payloads remain unavailable.
- `plugin.runtime.discover` and `status` do not instantiate plugins. Teams remains
  unavailable without both an admitted native implementation and trusted configuration.
  The explicit native Plugin host boundary below adds gated lifecycle operations,
  not an implementation of the missing original Teams protocol.
  Model catalog/resolve operations are hidden unless a native `ModelConfigService`
  is injected.

### Explicit native Plugin host boundary (Teams implementation unavailable)

The production extension registers **PKM: Configure Isolated Plugin Workspace
(Teams Not Admitted)**, **PKM: Revoke Isolated Plugin Workspace**, and **PKM:
Isolated Plugin Workspace Status**. Configuration requires an initialized,
private next workspace inside the trusted VS Code workspace, disjoint from the
current Knowledge Root. The actor is explicitly selected (`mcp:external` for
compact managed MCP, `local:owner` for the default native HTTP/MCP host).
Only opaque `tenantId`, `clientId`, and `credentialRef` identifiers are accepted.
These commands never access SecretStorage, environment credentials, the old
Plugin configuration, or the user's source/archive data.

The shipped implementation registry is **empty**. Consequently the command saves
only a **disabled draft**, with no implementation pin or grant. There is no
generic code loader, URL-based implementation admission, or caller-supplied
factory. `--experimental-trusted-plugins` explicitly attaches the native
HTTP/MCP host to the VS Code authority; without it lifecycle controls are absent
from discovery. With it, `plugin.runtime.enable`, `.disable` and `.invoke` are
schema-defined public operations, but enabling/invoking unadmitted Teams returns
`NOT_AVAILABLE`. Discovery/status remain redacted and never start a provider.

`PluginHostAuthority` is the actual production host authorizer, not a test
authorization callback. It uses the established native-host pattern of a
private, current-account loopback endpoint and a random host-owned bearer token.
The host persists actor/workspace/root/configuration/implementation-SHA-256 and
revision-bound decisions in extension global state; endpoint files hold only
ephemeral connection authority and are excluded from workspace backups. Revoke
durably disables the record and advances its revision. Configuration replacement
also advances the revision. Observed workspace distrust latches the endpoint
closed to authorization until explicit reattachment; outstanding consent is
rechecked before authorization returns. Revocation fences future hooks; it does
not promise rollback of an already started effect.

The existing native `PluginFactory`/`PluginInstance` contract is retained.
An embedding **trusted native packager** may explicitly supply a
`NativePluginImplementation` (factory plus exact implementation SHA-256) to
`createVscodePluginRuntime`; the VS Code host must independently admit the same
pin/configuration. Neither transport arguments nor configuration JSON can
supply that implementation. The factory retains its separate native secret
authority; this bridge does not resolve a credential reference or mint secret
access. It injects into the real Core/native host and is drained/closed with the
native lifecycle. Each `teams.notifications.read` invocation reauthorizes the
exact actor, revision and input digest and requires fresh host effect consent;
initialization also requires fresh host effect consent for its exact
configuration. Denial leaves the provider uncalled. The response is only bounded
`{count, hasMore}`. Sending messages is not admitted. Invocation is deliberately
**not** advertised as idempotent and must not be automatically retried.

**Remaining external boundary:** no original Teams implementation, authenticated
provider/secret adapter, or source-matched Teams API protocol is present in this
checkout. The existing Teams runtime schemas are not evidence of such a
protocol. The functional fixture below implements only that existing **native
production Plugin contract**, uses one synthetic loopback HTTP GET with no
credentials/messages, and does **not** establish original Teams source parity
or production provider qualification. No source captures/hash pins or
qualification markers are refreshed.

Reproduce the strict builds and focused lifecycle/real-authority/CLI/registered
VS Code command tests from the repository root, without changing shared `dist`
(choose fresh output names if these already exist):

```sh
node_modules/.bin/tsc -p tsconfig.json --outDir .plugin-host-root-check --pretty false
next-server/node_modules/.bin/tsc -p next-server/tsconfig.json \
  --outDir next-server/.plugin-host-next-check --pretty false
PKM_PLUGIN_ROOT_BUILD=.plugin-host-root-check \
PKM_PLUGIN_NEXT_BUILD=next-server/.plugin-host-next-check \
  node --test next-server/tests/plugin-runtime.test.mjs \
  next-server/tests/plugin-trusted-host.test.mjs
```

The runtime tables are now initialized with isolated database schema v12.
Operation receipts are global to the workspace, bind normalized operation,
arguments and trusted actor, and commit with state changes. Exact retries return
their immutable receipt across HTTP/MCP processes and restart; reusing an ID for
another request conflicts. These limits and the public boundaries are exercised
by [the Batch 04 HTTP/MCP integration test](./tests/batch04-integration.test.mjs).
This is bounded transport qualification, not Chat/provider, workflow execution,
sync application, collaboration-admission, action-runtime or full legacy-client
parity acceptance. Execution approvals and process spawn/results remain absent
from the public catalog. Remote subscription materialization has a configured
native-only wrapper, but is not a public capability and requires explicit
source/ACL policy.

### Batch 05 native host boundary

The standalone CLI calls `createNativeRuntime({ storage })` without a model,
provider, tool catalog, reviewer, embedder or subscription authority. Those
capabilities remain unavailable by default; enabling the explicit-memory
authorizer alone does not enable model or tool execution. Hosts can opt in to
Chat only by supplying a complete `modelConfig`, `providerTransport`, non-empty
`toolCatalog` and trusted `reviewer` to `createNativeRuntime`. The implemented
path is ModelProvider → ChatTurn → exact approval → ToolGateway → Core → the
same SQLite workspace. The integration test uses a synthetic SSE provider and
synthetic approval; no remote production provider or production data was tested.

### Batch 06 Manager, browser and migration qualification

The default CLI now serves the allowlisted browser at its printed loopback URL.
Static resources load without authentication; every API request still requires
the bearer token. The browser holds that token only in memory, clears its entry
field after connecting, uses no cookies/localStorage/sessionStorage, and renders
source text literally. Exact Host/Origin checks, restrictive CSP and no CORS
protect the same-origin boundary. It uses ordered cursor polling, not a claimed
SSE transport. Unconfigured Manager, Chat generation and process execution stay
unavailable; a visible browser is not an enabled autonomous provider.

Programmatic native hosts may explicitly supply:

- `manager: { ownerForActor, host, leaseMs?, resumeInterrupted? }`. The trusted
  host provides planning, task authorization, workers, delivery validation,
  freeze, integration and whole-goal verification. Workers may call
  `publish({ grade: "draft" | "selfReport" | "delivery", delivery })` while still
  running; publications remain attempt/owner/scope/lease-fenced and cannot accept
  the parent instruction. Ordinary feedback queues only its selected worker;
  frozen integration failures route to the named source owner before another
  freeze and E2E check. Clarified completion-contract feedback can automatically
  replan without a separate continue command.
- `trash: { layoutVersion: "pkm.trash-lifecycle/v1" }`. Storage explicitly
  provisions/allowlists the three area `.trash` roots. Dedicated trash preview,
  move and restore preserve paired assets/subtrees and reject shared references,
  replacement destinations and unknown/tampered journal or bucket bytes.
  This is distinct from generic logical document deletion.
- `workflow: { adapters, process? }`. `process` is explicit trusted
  `ProcessBridgeOptions` without its database/workspaceRoot, supplied by the
  native composition. It installs the `pkm.step.command/v1` adapter using
  allowlisted commands, direct-child-only execution, exact definition/approval
  bindings, data authorization and output redaction. Child stdin and raw
  stdout/stderr are ephemeral; only validated sanitized workflow output persists.
  Cancellation/shutdown drain owned live children before closing SQLite.
  No automatic process adapter, public spawn/completion/generic approval or
  Action execution bridge is provided.

Specialized Note/Skill/Research create/update are available through native Core
by default. They use Markdown source/scan CAS, immutable global operation IDs,
intent-before-effects journals and atomic index/receipt completion. Startup
preflights pending journals before replaying only exact supported before/after
images; changed bytes or a missing trash policy fail closed.

Manager restart is deliberately limited: interrupted effects become unknown and
are not automatically retried. Native `services.manager.reconcile` requires an
explicit trusted host verdict for each interrupted effect.
`resumeInterrupted: true` resumes only resolved safe state (including effects
positively confirmed **not executed**); an unknown verdict stays fenced.
Without that opt-in, trusted native resume is explicit. No public resume
capability, real-provider reconciliation or distributed rollback is claimed.
Budgets cap workers/concurrency/attempts; heartbeat freshness does not prove
an effect completed or extend authority beyond its lease.

The [Manager HTTP/MCP tests](./tests/batch06-manager-integration.test.mjs) exercise
20 bounded independent workers, live publication, targeted feedback, failed
frozen integration, exact-owner repair and automatic parent E2E completion.
Feature, research, cleanup and small serial cases use synthetic host adapters.
The [real Chromium test](./tests/batch06-browser.test.mjs) renders live native
results, submits exact-result feedback and observes that automatic completion,
with inert HTML/source, token-storage and origin checks. Its screenshots are
disposable and browser/server/child helpers are stopped before return.
[Migration tests](./tests/batch06-data-integration.test.mjs) qualify specialized
CAS/retries, interrupted final transactions, before/after restart recovery,
rehashed tamper rejection and paired/folder trash guards.
[Process tests](./tests/batch06-process-integration.test.mjs) execute an actual
configured local Node child over native HTTP, including secret-free SQLite
receipts and cancellation/drain.

These are synthetic integration qualifications, **not** real-root cutover,
production-provider acceptance, completed migration workstreams or full legacy
client parity. Only the final fingerprinted `npm run test:qualification` establishes evidence for
the then-current frozen implementation; targeted commands do not create it.

The programmatic host entrypoint is `createNativeRuntime` from
`dist/native-runtime.js`; it is not a CLI switch. A configured host supplies the
provider, tool catalog and trusted reviewer explicitly:

```js
const storage = await Storage.open(workspace, { deferRecovery: true });
const runtime = await createNativeRuntime({
  storage,
  modelConfig,
  providerTransport,
  toolCatalog: [{ name: "create_document", operation: "knowledge.document.create" }],
  reviewer: async request => ({
    actorId: request.actorId,
    decisionId: randomUUID(),
    decision: "approve",
  }),
});
const { server, url } = await startHttp(runtime.core, token, actor, 0);
// On shutdown: close server, then await runtime.close(), then await storage.close().
```

The host creates the native runtime before starting its transport; it preflights
data journals before worker recovery. Do not run separate HTTP and MCP processes
concurrently on one workspace; use the single-owner sequence above.

Folder lifecycle and offline `sync.apply` are wired through the native Core and
use the shared SQLite workspace, filesystem, index and global receipts. Their
public operations are `knowledge.folder.lifecycle.preview`,
`knowledge.folder.move`, `knowledge.folder.lifecycle.promote-preview`,
`knowledge.folder.promote-delete`, `sync.apply.preview` and `sync.apply`. Sync applies only
the caller's pinned offline snapshots; no remote GitHub operation is performed.
An idempotent retry returns the original completed receipt as historical
evidence, not a guarantee of current file bytes or permissions; subsequent
external edits require separate inspection.
Retrieval availability is false and retrieval search is absent unless the host
explicitly supplies authoritative sources, an embedder and native
authorization. Subscription mutation and retrieval stage/qualify/activate
remain host-only. These are isolated synthetic-host/runtime qualifications,
not full legacy-client or production-service acceptance. See the configured
host, public transport, filesystem, receipt and recovery scenarios in
[the native runtime integration tests](./tests/native-runtime-integration.test.mjs).

Parent promote-delete uses `{ area, path, mode: "parent" }` for preview; mutation
adds `operationId`, `expectedSourceSha256`, `expectedScanRevision` and
`expectedDestinationSha256: null`. This implements original Notes/Skills/Papers
parent promotion, not prompts fallback-group modes or Trash. The preview's
`destinationAbsent` pins **child** destinations; the parent already exists.
Collisions include paired asset destinations and case-insensitive aliases.
Stable document identities, revisions and exact frontmatter remain unchanged;
only original asset-reference rebasing and Notes folder-pin repathing change
their pinned bytes. Ordinary Markdown links retain the original behavior.
As in the original, `.gitkeep` is excluded from the promoted count and removed
with its verified empty container; a root-promoted descendant folder pin retains
the original leading slash.

The existing immutable DataRuntime intent commits before any filesystem effect.
Physical children move in a deterministic no-replace prefix, followed by ordered
CAS Markdown writes, marker/empty-container removal, and sidecar CAS. A recognized
unrewritten prefix rolls back on a synchronous move failure; interrupted writes
recover forward. No recursive source deletion or best-effort data restoration is
used. Native startup (`Storage.open(root, { deferRecovery: true })`, then
`createNativeRuntime`) preflights the entire intent before recovery. After a
process crash the existing owner lease must expire before another owner opens it.
Index, receipt and intent removal publish in one shared SQLite transaction.
Unknown bytes, pins or phases preserve the intent and fence further writes.
This is recoverable multi-file publication, **not** an atomic filesystem snapshot;
uncooperative external writers racing checks still require reconciliation.
The existing restrictions on path-derived identities, legacy `_assets`, shared
outside references, symlinks, Todo/memory/System authorities and unsupported
entries still apply. Synthetic real-process crash and rollback coverage is in
[the promote-delete tests](./tests/knowledge-promote-delete.test.mjs).

Knowledge foundation operations:

- `knowledge.document.list`: metadata-only pages ordered by document ID; optional `area` filters Notes, Skills or Papers.
- `knowledge.document.get`: full content, storage area, relative path and deletion state; accepts document ID or canonical `knowledgeId`.
- `knowledge.document.create`: caller supplies stable document ID and UUID `operationId`; optional `area` (`notes`, `skills`, `papers`, default `notes`) and nested Markdown `path`.
- `knowledge.document.update`: replaces title/content with `expectedRevision` and `expectedSha256`.
- `knowledge.document.trash`: retains content, sets deleted state using revision CAS.
- `knowledge.document.restore`: restores retained content using revision CAS.
- `knowledge.metadata.get`: complete JSON-compatible YAML metadata and original identity/link diagnostics, without changing the file.
- `knowledge.metadata.update`: patches `set` fields/removes `remove` keys with revision/digest CAS; returns the new document receipt.

Metadata patches preserve the document body, YAML comments and untouched fields.
Identity/history fields, title/deletion state and Todo authority fields cannot be
overwritten through a metadata patch. Empty or contradictory patches are errors.
`links` uses the captured original pinned/floating Knowledge-link compiler, not a
second looser validator. Explicit invalid identity/alias metadata is reported, not
silently regenerated or dropped. A legacy document with missing identity gains
identity only on an explicit successful mutation.

The original pure identity/link contracts are captured under
[src/domain/knowledge-contracts.ts](./src/domain/knowledge-contracts.ts), with
[capture provenance](./migration/knowledge-provenance.json).
`node scripts/capture-knowledge.mjs` explicitly refreshes the module and the
unchanged original pure assertions. Old filestore integration/move tests remain
explicitly excluded; capturing assertions is not claiming those integrations pass.
Generic Markdown mutations reject old Todo descriptors or paired Board backing
data rather than bypassing Todo lifecycle authority before layout import exists.

### Note and Skill read models

- `knowledge.note.list` / `knowledge.note.get`: original Note title/type,
  JSON-encoded tags, pinned state, category, timestamps and descending update-time
  ordering. List excludes body; get accepts a stable/canonical ID or Markdown path.
  The list defaults to 20 items, accepts any nonnegative safe-integer limit, and
  returns all remaining items for `limit: 0`. This is not the legacy MCP
  `list_notes` inventory contract, which still needs separate compatibility.
- `knowledge.skill.list` / `knowledge.skill.get`: original Skill name (metadata
  `name`, otherwise filename, not document title), JSON-encoded tags, priority,
  source project, related skills and recipe fields. List preserves exact
  category/tag filters and category/name ordering; get accepts name or stable ID.

Both domains add `documentId`, `path` and `documentSha256` to original records so
clients can use the existing document/metadata CAS operations without relying on
display names. Duplicate Skill names explicitly conflict; use list addresses
instead of the old arbitrary first-file lookup. Full models are returned under
`item`; metadata-only pages under `items`, with `total`/`nextOffset`.

Pin `snapshotRevision` across pages/related reads. External body, metadata,
unknown YAML/comment, mtime or path changes invalidate it; changes in other
knowledge areas do not. All reads exclude soft-deleted documents, never establish
identity/rewrite files, and validate original field types before dynamic query
rules. Skill snapshots are bounded to 4096 documents and 32 MiB. Note snapshots
have no aggregate document-count or byte ceiling. Markdown files and Note Board
backings have no application-defined size ceiling; invalid UTF-8 and invalid
Board data still fail explicitly. The same uncapped source scanning applies to
Note lifecycle, legacy Note/Board bridges, Knowledge-link sources, subscriptions
and sync. These Notes-specific exceptions do not relax Skills/Papers snapshot
limits or binary attachment resource limits. Those paths retain integrity,
authorization and data-validation checks. Link
graph output and specialized per-request work batches may have separate
result-shape limits.

Note reads preserve legacy Board classification, including descriptors without
backing files. Existing paired Board backing must be a regular, valid UTF-8 JSON
file and pass the original Board codec. Its digest and mtime contribute to
Note metadata/snapshot; grant hashes and backing data are never returned. Reading
a descriptor does not import its Board into the new Todo command layout or
authorize generic Markdown edits.

The original read projection/filter/order bodies are tracked in
[Note provenance](./migration/notes-provenance.json) and
[Skill provenance](./migration/skills-provenance.json).
`node scripts/capture-notes.mjs` / `node scripts/capture-skills.mjs` refresh these
explicit filesystem seams. Specialized mutation/search, routing, legacy layout
import and full client parity remain unqualified.

### Paired document moves

`knowledge.document.lifecycle.preview` validates stable identity, source
revision/SHA, destination absence, the paired resource tree and bounded
three-area references. `knowledge.document.move` requires the preview's
`scanRevision` and paired-tree digest plus a UUID `operationId` and explicit
null destination pins. Moves preserve identity/revision, rebase owner resource
references and move paired bytes together; unsafe shared references and
unsupported Todo/memory descriptors fail explicitly.

Database v8 adds a serialized document-lifecycle intent committed before effects.
Recovery validates exact ordered partial states before indexing, then commits
the updated identity/path index, immutable receipt and intent completion under
the shared writer lock. Unknown bytes or unrelated source changes retain the
intent for reconciliation. HTTP/MCP replay, stable-ID reads after move and
restart recovery are tested. Whole-folder moves, arbitrary external-writer
atomicity and power-loss qualification remain outside this slice.

### Resource rename/delete lifecycle

`knowledge.asset.lifecycle.preview` validates owner document and binary
revision/SHA/size pins, bounded three-area references and rename destination.
Copy its `scanRevision` into the mutation's `expectedScanRevision`.
`knowledge.asset.rename` and `knowledge.asset.delete` require write authority
and a durable UUID `operationId`; replay only identical arguments and actor.

Referenced deletes are refused. Referenced renames require explicit
`rewriteMarkdown:true`; otherwise Markdown is never changed implicitly.
Rename preserves original metadata/revision semantics while returning before/
after Markdown SHA. Destination overwrite is not supported. Unknown paths,
bytes, references or staging state fail closed.

Database v7 adds a shared serialized resource intent. Commit that intent before
effects; recovery under the shared writer lock publishes destination, optionally
rewrites Markdown, then removes source. Exact completed steps are skipped and
the immutable receipt is stored before the intent is removed. Interrupted
unknown outcomes retain the journal for reconciliation. Process-restart
recovery and real HTTP/MCP replay are tested; arbitrary external directory
substitution and power-loss qualification remain limitations. Original sync
deletion/restoration bookkeeping is not integrated: no sync parity is claimed.

### Canonical Knowledge-link resolution

`knowledge.links.resolve` resolves canonical Knowledge IDs across Notes, Skills
and Papers without external fetches or mutations. Pass up to 16 `starts` URIs;
the default traversal direction is `both`, depth 4, 100 nodes, 200 edges and
50-item pages. Reuse returned three-area `snapshotPins` on later pages:
source changes return `CONFLICT`. Depth is capped at 16, nodes at 256 and edges
at 1024. Snapshot budgets are 4096 documents, 32 MiB and 20000 links.

Pinned targets require exact original provider revision-string equality.
Floating targets use the current snapshot. Original metadata revision/body
digest fallback is preserved; retrieval-index-only suffixed tokens are not
invented. Todo Boards without metadata revision cannot receive a guessed token.
Missing or mismatched targets and malformed/unsupported links return explicit
diagnostics; Script, Project and external URL adapters are unavailable.
Traversal exposes totals, pagination and `truncated`, not an unbounded graph.

### Literal knowledge search

`knowledge.note.search`, `knowledge.skill.search` and
`knowledge.research.search` search original domain fields without invoking a
model or reading external URLs. `query` is required (at most 500 characters);
`caseSensitive` defaults to false. Results omit bodies and carry stable document
addresses, with pages of 1..100 items. Note/Skill pages use `snapshotRevision`;
Research pages use `revision`, matching its existing collection contract.

`regex: true` explicitly returns `INVALID_ARGUMENT`; regular-expression execution
is not yet qualified. Host-specific absolute Note paths are intentionally excluded
from portable search. Deleted documents are excluded; legacy searchable fields
and ordering are preserved where portable. This is literal search, **not**
embedding retrieval/online learning. Capture scope and exclusions are recorded in
[search provenance](./migration/search-provenance.json).

### Host-neutral Skill routing and prompt projections

The read-only `knowledge.skill.routing.*` catalog exposes `sources`, `context`,
`select`, `project` and `prompt`. Dispatch and authority are shared by HTTP/MCP.
Reuse `snapshotRevision` across these reads; selected `project`/`prompt` entries
may additionally pin `documentSha256`. Stale pins return `CONFLICT`.

`context` admits candidates using original metadata rules, returns bounded
rankings without bodies, and defaults to three candidates (maximum five).
`select` searches body-free metadata, then materializes complete Skill bodies:
body-only matches are not admitted, Skill `name` rather than document `title`
is used, and priority/pinned alone do not reorder original Chat selection.
Pages default to 20 and cap at 100, with the original 20-candidate cap applied
before empty-body removal. `project` returns at most 20 complete selected sources
and optionally renders router text; `prompt` accepts at most eight sources and
builds relevance messages, not a model call.

Snapshots cap at 4096 records and 32 MiB; result bytes cap at 256 KiB.
Native activation, subscriptions, related-Recipe discovery, retrieval workers,
projection installation, models and execution remain unavailable with explicit
adapter explanations. No host-native candidate or score is synthesized.

### Workflow definition validation and compilation

Read-only `workflow.compiler.capabilities`, `workflow.definition.validate` and
`workflow.definition.compile` expose the captured deterministic compiler.
Source is either `{kind:"inline",definition:...}` or
`{kind:"recipe",recipeId,expectedRevision,expectedExecutableDigest,snapshotRevision?}`.
Invalid definitions retain original structured diagnostics and `status:"invalid"`;
they never receive a fabricated plan. Valid plans preserve graph and dependency
ordering. These operations do not start a workflow, call models or grant native
execution adapters.

Bounds are 256 KiB input, 1 MiB output, JSON depth 32/32768 values,
128 nodes, 512 edges and DAG depth 64, with 16384 cycle-search steps.
Actual HTTP/MCP tests compare complete captured valid/invalid compiler fixtures,
not only successful transport envelopes.

### Subscription ACL and immutable Agent Snapshot reads

`subscription.list`, `subscription.get` and `subscription.acl.evaluate` read
optional `subscriptions/` metadata without contacting brokers or materializing
content. Metadata projections redact credentials/provider payloads. ACL evaluation
preserves the original Casbin policy using the trusted Core actor, not a public
role override; `evaluationOnly:true` grants no remote authorization. Source files,
directories and missing paths are rechecked after asynchronous enforcement.
Patched `csv-parse`/`minimatch` transitive overrides are regression-tested against
the original ACL; unused CSV/glob helpers are not authorization substitutes.

`subscription.broker.share-markers@1` is a read-only native Core operation.
Supply `{type, items, expectedRevision?}` with the same item projections used
by the original broker marker calculation; the result contains `revision`,
`items`, and `folders`. Exact selections, inherited folders and paused shares
are preserved. It reads the local isolated subscription snapshot, not broker
discovery or publication. Input is limited to 4096 items and 1 MiB, and
projection work/output are bounded; excessive requests fail, never truncate.
Missing subscription state gives empty markers, while malformed state and stale
revisions fail explicitly. Imported identity remains subject to its native
actor/workspace/secret-reference authority and receipt checks before and after
the read; no private key, verifier, item payload or secret is returned.

On the packaged compact MCP entry, discover and call
`mcp.tool.subscription_broker_share_markers@1` with `capability_read` and the
same arguments. This is local-only; it does not create, edit, publish, sign,
connect, or establish a subscriber grant. The existing separately authorized
remote subscription bundle/transport remains conditional on its native
endpoint, identity, proof and host policy; local markers do not enable it.
Public use with an imported original subscription identity is still blocked:
the compact CLI does not supply `NativeSubscriptionIdentityPolicy` or an
approved durable native secret authority, and its offline import CLI does not
admit subscription identity migration. It fails closed rather than treating
the MCP actor string or workspace files as an identity grant. The old manager
stores its node Ed25519 private key in its original subscription state and
uses VS Code SecretStorage separately for protected-share secrets; those
secrets alone are not a native identity-continuity approval or subscriber
proof provider. The empty/unbound local marker case is callable in the packaged
host, but does not demonstrate production identity migration or broker parity.

`agent.snapshot.list`, `.get` and `.read` read optional
`agent-snapshot-reads/.pkm/state/agent-snapshots/` originals, with optional session
recovery counts. Magic Code is a selector, not authority. Reads require a trusted
actor; caller role/actor overrides are rejected. Default pages are 50 and recent
messages 12; reuse `snapshotRevision`. File inode/device/size/mtime and raw hashes
are checked, but multi-file snapshots require quiescent staging: there is no
atomic directory snapshot. No restore/session spawn, encryption/network adapter
or VS Code execution is implied. Missing optional directories cause no writes.

### Project and Recipe mutations

`project.create`, `.update`, `.archive`, `project.recipe.create` and
`.update` retain original validation, version/revision and executable-digest
semantics. Read `project.mutation.pin` with `entityKind` and `id` to obtain
publicly usable file SHA, version, snapshot revision and Recipe digest; no host
filesystem read is required to build a CAS request. Archive records original
`archivedAt`, not an invented status value.

Database v9 adds a serialized multi-file Project intent committed before effects.
Recovery validates workspace identity, action/actor/operation identity, original
root snapshot for untouched plans, and exact before/after file guards for partial
plans. Bound Recipes revalidate source Markdown projections. Only a complete
outcome becomes an immutable receipt; unknown states retain the journal.
Public-pin-only create/update/archive and Recipe create/update sequences,
HTTP/MCP replay, read-only denial, restart and committed-before-effects recovery
are tested. Delete, providers, execution and full client parity are not exposed.

### Project and Recipe read models

Read-only `project.list`, `project.get`, `project.recipe.list`,
`project.recipe.get` and `project.recipe.bundle.get` use optional original
`project/<safe-name>.<id>/` and `recipes/<category>/` layouts within an isolated
workspace. Missing collections are empty; reads never initialize directories.
Existing Project schemas, default-project invariants, Recipe executable/content
pins and bundle rules are validated rather than guessed.

Pages default to 20 and cap at 100. Reuse `snapshotRevision`; get operations
may also pin Project version or Recipe revision/executable digest. Bundle reads
resolve original Note slugs and category/Skill names from indexed Markdown,
requiring exact bound content hashes; no models or workflows are executed.
Catalog budgets are 12000 entries, 8000 files, 2 MiB per file and 32 MiB combined,
depth 24 and 2048-character relative paths. Unsafe or malformed files and missing
bound sources fail explicitly. Mutation/execution and full client parity remain.

The original `recipe_run_get` read is also available for host-admitted retained
Recipe runs. It reads only the immutable `recipe-usage-reads` projection and
preserves the original compact/full result and usage summaries. Only runs whose
terminal nodes and native health receipt are already finalized are readable;
active or inconsistent runs fail closed because reconciliation, command results,
subflows and live health authority are not attached to this MCP host. The adapter
never executes or mutates a Recipe.

### Research read models

- `knowledge.research.list`: body-free Paper/Idea metadata, original citation
  counts and citation/year/title ordering; bounded pages with a shared revision.
- `knowledge.research.facets`: original topic/tag counts and descending years.
- `knowledge.research.groups`: custom groups in alphabetical order, then the
  always-present `Papers` group.
- `knowledge.research.graph`: original title/slug citation resolution, filters,
  ranking and one-hop neighbor expansion. Edges point from cited parent to citing
  child; duplicate citations retain their original counting/edge semantics.

All four reads exclude soft-deleted papers and share an optional `revision` pin.
External metadata/body/mtime changes invalidate the pin; other knowledge areas
do not. Reads never establish identity or rewrite legacy Markdown. Invalid
metadata types fail explicitly before executing the original query rules.
Snapshots are limited to 4096 papers and 32 MiB of authoritative Markdown.
Graph seeds are limited to 100; neighbor expansion may exceed the seed count,
but more than 1024 nodes or 16384 edges is an explicit error, never silent
truncation. There is no research-specific mutation/search/import qualification yet.

The original projection, citation resolver/counts, list, graph, facets and groups
are captured with explicit filesystem seams in
[research provenance](./migration/research-provenance.json).
`node scripts/capture-research.mjs` regenerates that capture; its freshness is
part of the verification gate. This is not a claim that the old full filestore
integration tests pass.

### Markdown resource reads

- `knowledge.asset.list`: paginated metadata for owned and referenced resources,
  including unreferenced owned diagrams and legacy `_assets` references.
- `knowledge.asset.get`: base64 chunks of at most 64 KiB, requiring the catalog's
  `expectedDocumentSha256` and prefixed `expectedDigest` (`sha256:<hex>`).
  Decode each chunk separately before concatenating bytes.

The captured original Markdown parser/ownership helpers handle encoded filenames,
nested link labels, HTML/reference definitions and fenced-code exclusions.
[Capture provenance](./migration/assets-provenance.json) explicitly excludes
mutation/locking/deletion-journal code and old full integration tests.
`node scripts/capture-assets.mjs` refreshes the curated read-only capture.

Only catalog-owned/referenced files are readable. Root/nested/dangling symlinks,
special files, unsafe paths and Todo backing JSON are rejected. Missing and
outside-area references produce explicit diagnostics without changing Markdown.
Pin list `revision` across pages; a changed file digest or document SHA requires
rediscovery before continuing chunks. The Core performs no external URL fetches.
Resource edit/delete, migration, paired moves and shared-reference
lifecycle protection are not migrated yet.

Read limits: 16 MiB per file, 64 MiB total per catalog, 2048 traversed entries
(including resource roots) and 32 directory levels beneath a resource root.
These are explicit experimental admission limits, not scalability qualification.

### Durable resource upload

1. `knowledge.upload.begin`: reserve a filename, exact byte size/digest and
   current document revision/SHA; returns an actor-owned `uploadId`.
2. `knowledge.upload.append`: append canonical base64 chunks of 1..65536 bytes
   at the exact next byte offset, each with its own durable `operationId`.
3. `knowledge.upload.get`: reconnect/read progress; `knowledge.upload.list`
   recovers the actor's active IDs if local client state was lost.
4. `knowledge.upload.commit`: verify complete bytes/checksum and original
   document area/path/revision/SHA, journal the resource, atomically persist it
   and return its encoded Markdown `resource.uri`.
5. `knowledge.upload.abort`: explicitly discard an active upload's buffered
   chunks without changing knowledge files.

Uploads work through existing HTTP/MCP entry points. Chunk/commit retries use
the original operationId. Receipts
are historical results, not current progress or resource authority. Commit never
edits Markdown or overwrites different bytes; identical existing bytes may be
reused, matching original save-resource behavior. System resources and Todo
backing filenames are protected. Other actors cannot inspect/mutate sessions.

Active uploads reserve at most 16 MiB each, 4 per actor, 8 globally and 64 MiB
total. Active chunks and file intents are durable SQLite runtime state, not
authoritative knowledge storage. Commit/abort releases buffered chunks; receipt
and completed-session retention/compaction is future work. Changed/moved/deleted
documents require abort/restart; uploads are not silently redirected. Unresolved
resource-intent conflicts fail closed and retain the journal. No automatic
expiry silently discards uploads.

### Explicit memory

The seven original `memory.record.*` lifecycle/read operations now use a
Markdown-authoritative Node implementation. Each record and its sourced revision
history live under `notes/System/Memory/`; SQLite keeps only indexes, intents and
historical runtime receipts. Generic document/metadata writes cannot modify
memory authority, even after an external move.

HTTP/MCP expose `propose`, `get`, `search` and `audit`. Proposals remain **pending**
and never enter active recall without an exact-record native human decision.
`confirm`, `revise` and `revoke` are only available to a native Core with an
injected human authorizer; no bearer privilege, Allow All setting or request field
can substitute for that decision. The actual native approval UI is not migrated.
An authorized receipt replay does not repeat the approval or mutation.

Transitions increment the revision; revising creates a pending state without
carrying old confirmation forward. Revocation excludes subsequent search but
retains audit/history, not claiming erasure of backups or already-sent prompts.
Human decisions pin both revision and authoritative document SHA; concurrent
changes reject stale approvals. Sources require 1..32 exact references and
4096 aggregate UTF-8 bytes; content is limited to 4096 UTF-8 bytes.

These operations retain the original `operation_id` / `expected_revision`
field names. Search returns at most three original bounded previews and preserves
SQLite's ASCII-only case-insensitive literal matching. Audit retains global
sequence cursors and pages of at most ten events. Snapshots are bounded to 4096
records/32 MiB, with an explicit error rather than silent history truncation.
`documentSha256` is an additive current-state pin on full record responses.

[Memory provenance](./migration/memory-provenance.json) records a disposable
original-Python semantic oracle and the unchanged TypeScript preview projection.
`node scripts/capture-memory.mjs` refreshes both; normal runtime/build/tests do not
require Python. Chat memory, model accounting, embeddings, native UI and old-layout
import remain separate unqualified work.

### Migrated Todo domain

The registry additionally exposes the existing 29 canonical Todo operations and
`todo.board.create`. Search `todo` and describe the selected operation for the
full schema. Canonical identities are captured from the old registry, not renamed
after a transport. The original reducer, validation, Board codec, JSON schemas and
API business branches are captured under [src/domain](./src/domain), with
[source/transformation provenance](./migration/todo-provenance.json).
`scripts/capture-todo.mjs` refreshes this curated capture explicitly; normal
builds and runtime never load the old extension or its build output.

The 29 operations cover Board discovery/counts, Work Item and User Story
CRUD/grouping, assignment/claim/release, transitions, result submission, explicit
reviewer acceptance, reopening, soft-delete/restore, comments, history and changes.
The host/storage calls are injected into the captured API; Node business logic
runs in the same bounded storage worker as documents.

Structured Todo Boards retain their existing authoritative JSON codec
(`pkm.todo-board/v1`); this was already an exception to Markdown knowledge bodies
in the old server. The isolated layout is currently
`boards/<board_slug>/pkm-todo-board.json`. Nested slugs are supported. The offline
disposable importer can migrate validated old descriptor/backing pairs; normal
Board reads do not import or convert layouts. System Boards can be read, but not
mutated.

The experimental original MCP `todo_board_create(title, category)` creates an
empty native Board and its discoverable Note descriptor as one recoverable
operation, using the fixed external actor. Existing files are never converted or
overwritten; unsupported names and source layouts are rejected. This is partial
compatibility, not authorization to migrate a production Knowledge Root.

Mutations preserve the old `expected_digest` CAS and add a UUID `operationId`.
Both the Board replacement and its exact response are journaled before execution;
startup finalizes or rejects interrupted work rather than silently replaying.
Cross-Board one-active-task-per-agent checks occur under the same cross-process
workspace database lock. These checks do not start an Agent or switch its task.
Requests cannot supply actor identity, role, reviewer delegation, generated audit,
or acceptance overrides. Ordinary callers remain Board agents, not human reviewers;
Done/result submission never implies accepted.

The live Chat directory adapter is not implemented. `todo.agent.list` explicitly
returns `chatDirectory.available: false` and only recorded Board identities.
Assignment to a `chat:<UUID>` fails `NOT_AVAILABLE`; no fake Chat is invented.
Other explicit external identities retain the original validation.

Tests exercise all 29 APIs through Core, real HTTP/MCP Board contention,
restart/replay, both journal recovery boundaries and external conflict handling.
Fourteen unchanged pure legacy tests are captured separately with their
[inclusion/exclusion provenance](./migration/todo-test-provenance.json).
Host/bridge tests excluded from that capture are not claimed as passed.
Full Todo workstream acceptance still requires old-layout migration, Chat
integration, client parity and broader qualification.

Example mutation arguments after discovering/describing its contract:

```json
{
  "operation": "knowledge.document.create",
  "version": 1,
  "arguments": {
    "operationId": "f2811195-c5cd-4be6-933c-7f47155da0aa",
    "id": "example-document",
    "title": "Example",
    "content": "Only in the new isolated workspace."
  }
}
```

Core responses use `schema: "pkm.next-result/v1"`, a unique per-attempt `requestId`,
and exactly one `result` or `error`. Operation responses also identify the canonical
operation/version/catalog revision. Errors identify `code`, `message` and `effect`
(`not-committed` or `unknown`). HTTP pre-dispatch failures use the same envelope;
malformed MCP protocol/tool arguments may instead be rejected by the SDK itself.

### Concurrency and retry

- Markdown in `<area>/<relative path>.md` is authoritative, including identity,
  revision, deletion state, title, body and arbitrary YAML frontmatter. `area`
  is `notes`, `skills` or `papers`; omitted area/path creates `notes/<id>.md`.
  Nested paths, spaces and Unicode are supported, but traversal, hidden/resource
  paths, reserved filenames and symlinks are rejected. System folders are
  read-only in every area. IDs and canonical `knowledgeId` remain unambiguous
  across all areas; identical relative paths in different areas are independent.
  Portable paths require well-formed Unicode, at most 2048 UTF-8 bytes total
  and 255 bytes per component; lone surrogates are rejected before URI/FS encoding.
- Updates preserve unknown metadata and YAML comments, including Skill/Paper
  fields, old aliases and `knowledgeId`. New identities include the area-specific
  `note:`, `skill:` or `research:` aliases. Reads/index rebuilds do not add metadata
  to legacy YAML/plain Markdown. An explicit edit establishes missing identity.
  Persisted `documentId` survives an external move within the workspace; a
  legacy document without persistent identity is path-dependent until edited.
  Directory/attachment move, copy, import and old-layout parity remain unfinished.
- Paired `.assets` directories and legacy `_assets` directories are preserved and excluded from document scanning,
  including owners using `.MD`. Orphaned/ambiguous ownership is rejected.
  Resource access separately performs bounded recursive validation and supports
  chunked reads; document scans alone do not recursively validate resources.
  Resource mutations and full attachment lifecycle migration remain unfinished.
- SQLite contains the rebuildable metadata index, durable operation receipts and
  pending write intents. Receipt snapshots are historical execution results, not
  a competing source of current document content. Do not discard the entire
  database just to rebuild the index: runtime receipts/intents are not disposable.
- Writes use a durable SQLite intent followed by a flushed atomic Markdown
  replacement, then a completed receipt. Startup/requests recover unfinished
  intents before serving data. SQLite serializes cooperating server processes.
  Filesystem replacement and SQL cannot form a single native transaction.
  Atomic replacement uses the committed operation's reserved temporary filename;
  recovery replaces an interrupted partial temporary file, but rejects a symlink
  or non-regular temporary path. Nested newly created parents are flushed on
  POSIX. Invalid UTF-8 Markdown is rejected without replacing its source bytes.
- `expectedRevision` AND `expectedSha256` (from the last read) are mandatory on
  update/trash/restore. The digest covers the entire Markdown file, so an external
  edit is detected even if it did not increment frontmatter revision. Reads/index
  rebuilds do not silently rewrite external edits. Workspace page revision is a
  digest of the current file set, not a database counter.
- Recovery refuses an unexpected external edit with `RECOVERY_CONFLICT` and keeps
  the intent. Preserve both the file and journal and reconcile manually; do not
  delete the intent or blindly start another operation. All data operations
  fail closed until the unresolved recovery conflict is addressed.
- There is no filesystem compare-and-swap against arbitrary external writers.
  Digest checks prevent known stale writes but cannot exclude an uncoordinated
  editor writing between the last check and rename. Route concurrent mutations
  through the Core; stronger editor/watch integration is still a migration gate.
- Every mutation needs a fresh UUID `operationId`. For a lost response or unknown
  outcome, retry the **identical normalized request with the same operationId and
  actor**. This returns the original persisted result without writing again,
  including after restart or later edits. Never generate a new operationId merely
  because the transport timed out.
- Database schemas v2 through v11 upgrade to v12 without rewriting Markdown. New
  Chat/workflow/sync/collaboration runtime tables are durable isolated state, not
  authoritative knowledge content. Existing
  prototype identities and receipts retain their original meaning; historical
  receipt responses may lack `path`/`area`. New/current reads include both fields.
  Pre-area pending writes recover into Notes, not an inferred destination.
- Reusing an operationId for different arguments, operation or actor is a conflict.
  Receipts do not expire in this foundation; retention/compaction is future work.
  When there is no unresolved pending intent, a historical receipt can still be
  read after a later external malformed edit; this never rewrites the bad file or
  presents the historical result as current document state.
- To page safely, reuse `workspaceRevision` from the first document page, or
  `revision` from the first catalog page. A changed revision requires restarting
  pagination. This detects changes; it is not a retained historical snapshot.

## Isolation and operational limits

- Initialization exclusively creates a new directory (mode 0700 where supported)
  and workspace marker (0600). Existing directories are refused, not adopted.
- Opening requires a `pkm.next-workspace/v2` marker and allows only that marker,
  `notes/`, optional `skills/`, `papers/` and `boards/` directories, and SQLite database/WAL/SHM files. Root/entry symlinks are rejected;
  parent paths are canonicalized. Database-only prototype v1 workspaces are
  explicitly refused, not silently converted or discarded.
  This is an accidental-misconfiguration guard, not a sandbox against another
  local process/user able to replace workspace files.
- The database uses WAL, `synchronous=FULL`, transactional receipts and a 3-second
  busy timeout. Synchronous SQLite work runs in a dedicated worker thread so it
  does not block the HTTP/MCP event loop.
- The current correctness-first indexer recursively scans/reconciles Markdown files on
  each operation under a workspace transaction. Incremental indexing and large
  workspace performance qualification are not complete; no scalability claim
  is made for this implementation. Scans are not capped by document count or
  Markdown file size; scans taking at least two seconds emit a rate-limited warning.
  Directory traversal remains bounded to 32 levels.
- The worker admits at most 32 pending requests per process; HTTP also admits at
  most 32 active requests. Saturation is an explicit `BUSY`, never a silent drop.
  These limits are per-process, not a global distributed scheduler.
- HTTP binds only `127.0.0.1`, requires a bearer secret of at least 32 characters,
  rejects browser Origin/non-loopback Host, and has no CORS support. HTTP request
  bodies have no application-defined size limit; request/header timeout: 10 seconds;
  idle socket timeout: 15 seconds.
- The transport is a trusted local owner or read-only principal, not multi-user
  authentication, document-level ACLs or remote hosting. Clients must treat document
  content as untrusted data, not instructions.
- No migration or backup command exists yet. Do not copy only `core.sqlite` while
  processes are running: committed data may be in WAL. No downgrade from an unknown
  database version is attempted. Never modify real PKM data to test this package.

## Scope and verification

### Parallel migration tracking

The current four-agent batch tracks resource lifecycle, disposable legacy import,
Skill routing and Project/Recipe read models in the
[Migration Board](pkm://notes/Research/PKM/Migration/Migration%20Board).
Only the parent integrator changes shared registry/storage/transport files and
records integration evidence. Agent delivery is not transport qualification or
full-workstream acceptance.

Board management uses PKM commands and digest CAS, never raw Markdown/JSON edits.
This batch uses planning-only items and progress comments by explicit user
choice: the shared external MCP identity already owns an unrelated active task.
Do not pause that task, invent an identity, claim parallel items, or accept
results automatically. Implementation evidence and full migration acceptance
remain separately tracked in [MIGRATION.md](./MIGRATION.md).

### Legacy-layout preflight

`migrationPreflight(root, options?)` from
[migration-preflight.ts](./src/migration-preflight.ts) inspects an absolute path
to a quiescent disposable copy. It does not write, import, repair or switch data.
The offline `import-plan` CLI below runs the more comprehensive import planner,
which includes this preflight; there is no public endpoint.

The report includes `complete`, `ready`, `limits`, `entries` and `blockers`.
It identifies legacy resources/Boards, unsafe paths or symlinks, malformed
Markdown/Board data, identity/alias/portable-path collisions, and unsupported
dotfiles, trash and deletion-journal surfaces. Entry and read-byte budgets are
unbounded by default and can be lowered explicitly; traversal remains bounded
to 32 directory levels, and other resource types retain their own limits.
A `ready` result means only that this inspection found no blockers, not import,
rollback or cutover qualification. The copy must be quiescent: traversal does not
provide an atomic filesystem snapshot.

### Disposable legacy import

[legacy-import.ts](./src/legacy-import.ts) exposes `planLegacyImport`,
`importLegacyWorkspace`, `recoverLegacyImportOutcome` and conservative
`cleanupInterruptedLegacyImportStages`. Only inspect a quiescent disposable
copy; no production or real-root cutover is authorized. Lowercase
`notes/`, `skills/` and `papers/` Markdown and assets are preserved byte-for-byte.
Original `prompts/` template/version trees and `scripts/` with their identity
sidecars are preserved separately as described above, not as Markdown knowledge.
Validated paired Note Board JSON moves to `boards/<slug>/pkm-todo-board.json`,
preserving raw digest and histories; the Markdown descriptor remains unchanged.
Unsupported dotfiles/trash/deletion-journal surfaces block rather than disappear.

Plans fingerprint/recheck source content before staging. Bounds default to
20000 entries, depth 32 and 512 MiB total import bytes; aggregate preflight
reads have no fixed default ceiling. Callers may set a smaller read budget.
Target must be absent. Publication requires Linux or Windows and an explicitly
supplied absolute `pythonExecutable` with standard-library ctypes and the
corresponding no-replace OS API described above, invoked with fixed arguments
without a shell. Unsupported environments fail explicitly; there is no racy
check-then-rename fallback. No pip dependencies are installed.

A sibling outcome record supports post-publication recovery against the
workspace marker identity; callers must retain and reconcile it rather than
blindly repeat import. Staging cleanup requires matching ownership/workspace
identity and a demonstrably dead PID. Unknown ownership, reused/live PIDs and
unmarked remnants are retained. The standalone CLI exposes the uncomposed
importer for disposable copies:

```sh
node dist/cli.js inspect-legacy-root --root /absolute/configured-legacy-root
node dist/cli.js import-plan --source /absolute/disposable-copy --acknowledge-quiescent-disposable-copy
node dist/cli.js import --source /absolute/disposable-copy --destination /absolute/new-workspace \
  --plan-sha256 <planSha256-from-import-plan> --python /absolute/path/to/python3 \
  --acknowledge-quiescent-disposable-copy
node dist/cli.js import-status --destination /absolute/new-workspace
node dist/cli.js import-cleanup --destination /absolute/new-workspace --acknowledge-abandoned-stages
```

Planning prints the complete JSON plan and exits nonzero if blocked. Import
replans and refuses a changed digest, a blocked source, or an existing
destination. `import-status` reconciles the durable outcome; a non-published
or unknown outcome exits nonzero. The acknowledgment is a user assertion,
not proof that other writers are stopped or that a copy is disposable.
`inspect-legacy-root` prints a `pkm.legacy-root-adoption-inspection/v1` report
and exits successfully when inspection itself completes; it never opens
`Storage`, initializes files, or authorizes a cutover. Its `ready: false` and
blockers must not be overridden by callers.

The internal `legacy-root-adoption.js` module has experimental
`prepareLegacyRootAdoptionExperimental`, `resumeLegacyRootAdoptionExperimental`
and `adoptLegacyRootInPlaceExperimental` APIs. They exist only for controlled
isolated fixtures: adoption writes a bound journal/workspace marker and
Next's SQLite state beside the original Markdown, then supports a Note
read/write and ordinary reopen. The supplied quiescence callback is not a
cross-version writer fence and is not production authorization; when adoption
returns Storage, the supplied resource remains held until `Storage.close()`.
The bounded `.pkm` slice accepts only a valid schema-1
`.pkm/content-privacy.json`, supported original API Chat archives, the
validated managed-writer-session preservation receipt, and optional empty
`.pkm/state/actions` and empty `mutation-lease`. It requires an explicit snapshot host `authorityId`,
`authorize` callback and tool scope, then records a new immutable native
snapshot admission; old snapshot grants, private Git state, and Action
authority are never inherited. Non-empty Action state, ProjectStore,
snapshots/sessions, locks, intents, and every other unknown `.pkm` entry remain
blocked unless their existing dedicated recovery/adoption receipts are used.
The host callback/API is experimental and must bind the exact synthetic or
authorized workspace, actor, authority ID, private Git root and tool scope.

An unconnected VS Code snapshot issuer experiment permits only
`knowledge_snapshot_status` for `mcp:external`, after a native modal in a
trusted workspace. It does not authorize creation, configuration, restore,
interrupted-operation reconciliation, writer handoff, or migration. Its
independently supplied host fence must synchronously validate the current host;
the modal alone is not that fence. The issuer binds Root and profile identities,
the original privacy directory and file identities, metadata and bytes, and
the host session, and revokes on changes or expiry. It is not wired into
ordinary extension activation.

On an isolated copy of a real 4.0.22 Root, the mock-UI/fixture-fence test
`tests/test-legacy-snapshot-vscode-adoption.js` exercised strict admission,
one unified owner, Note read/write, revocation, reopen, and fresh approval; it
did not establish a real Code host fence. Separately, a private installed Code
journey using test overlay SHA-256
`26711745f1f9b57809218169ec1752a7230a9e06e9c890c2a1851eeb2c26abe6`
confirmed workspace trust, native modal cancellation, status-only approval,
and revocation with a fixture host fence. It did not adopt the Root or use a
real owner fence. That overlay predates the subsequent privacy identity and
metadata checks and overlapping-profile checks in the current issuer source. Both
failed initial trust-UI attempts and the successful third run are retained under
`.migration-test-work/root-upgrade-validation/snapshot-vscode-authority/`.
These separate tests cannot be combined into an end-to-end migration claim.
Active legacy Code writers and the strict writer gate remain unresolved.

The original 4.0.22 MCP default discovers snapshot tools; discovery is not
consent. In an isolated original-root copy, the original status reported its
snapshot schedule disabled. Neither that default discovery nor Chatroom's
original private-folder policy authorizes a new snapshot grant or permits
removing the policy.

The original API Chat `chats.lock` is not an archive-wide writer fence.
In an isolated fixture using the original 4.0.22 store, library and lock
implementation, holding it made a Chat save time out while a library group
write still succeeded under its separate lock. Archive inspection rejected
the live lock. Holding that lock therefore both interrupts the old workflow
and fails to exclude all archive writers; it cannot authorize adoption.

The managed snapshot Chat composition can copy a validated archive to a
separate owner-private directory and check both the original and the copy
before later use. It checks file identity and content while copying and
rejects live locks or observed changes. This is optimistic conflict detection,
not an atomic snapshot, writer exclusion or adoption. An explicit independent
Next Chat command can use the trial workspace's selected profile over the
managed child IPC; it does not replace the default VS Code Chat or perform an
original-root upgrade. It reads the configured HTTP model and SecretStorage
credential and supports OpenAI-compatible and Azure endpoints. It can also use
an explicitly selected native VS Code language model through the extension
host, with streamed text and scoped process tool calls over the child IPC.
VS Code supplies the model permission; no PKM API key is passed to that
provider. A selected vision-capable VS Code model can receive up to two bounded
PNG/JPEG images on the current input, including subsequent tool rounds. Images
are stored only in the independent Chat's private database, not the original
history; earlier images are not re-sent. The host checks image capability and
uses the model's `countTokens` before sending. Managed Task input accounting
records the text bound, not that image token count. HTTP models reject images
as did the original installed 4.0.22 direct HTTP transport.

An explicitly approved Copilot SDK model discovery uses the existing GitHub
authentication API and a separate owner-private SDK runtime directory. It does
not reuse or clean the original shared SDK directory or alter the original
model selection. Each managed model round uses a fresh SDK session. SDK tool
callbacks cannot execute tools: the host first confirms that session's abort,
then passes the bounded call to the existing durable intent and user approval
chain. The next session receives the recorded conversation and tool result;
it is not the same SDK session. A failed abort admits no tool and remains
retryable during owner drain. SDK images use the original blob attachment
format and the original 2,000-token-per-image estimate, not an exact count.
The installed extension-host bridge and the actual VS Code 1.143 bundled SDK
were exercised together with a loopback JSON-RPC runtime fixture for tool
admission, new-session context, cancellation and disconnect. Separately, the
same real SDK and fixture were connected through the parent/fork durable
approval chain: approve, deny and cancellation passed, and the next session
received the actual managed process result. That parent/fork run was not an
installed UI run; the installed run did not exercise approvals. Disconnect
followed by cancellation left SDK drain unconfirmed rather than permitting a
tool or replay; immediate automatic disconnect detection is not established. No real
SDK model service or paid model was called; remote behavior remains unverified.
The existing SIGKILL/unknown-result no-replay test uses a separate model fixture;
it has not been combined with this real SDK transport.

Cancellation requests the VS Code token or SDK session abort; neither proves
that an uncooperative remote provider stopped. Text input and output use conservative byte-based bounds,
and provider errors are not automatically retried. The HTTP model has a total
timeout of at most 30 minutes rather than the old idle timeout; managed turns
currently have a two-minute deadline. Output is capped at
4096 tokens. Process execution requires an explicitly selected exact command
and user approval; grants are temporary and original Chat permissions are not
inherited. Changing PKM configuration, the selected workspace, or the PKM API
key in SecretStorage, the selected VS Code model catalog, or a GitHub session
change while using SDK revokes the
selected profile and drains its owner; a
failed drain remains available for an explicit close retry. The private snapshot
and its read-only original process evidence do
not exclude old writers, and concurrent changes can still produce conflicts.
Failed copies are retained in the private parent for review. A failed drain
keeps its owner and storage until a confirmed retry; an unconfirmed turn
persistence failure remains blocked for reconciliation.

The bounded inert root inventory may retain only regular `.git` metadata, a
regular `.gitignore`, `chatrooms/`, `mcp-server/`, `servers/`, and
`fixture-sentinel.txt`, with no links, hardlinks, special modes, pending
lock/intent/temp files or limit violations. Those bytes remain in place and
their full inventory is journal-bound; they are not copied, read as active
content, or used to grant old Git/chatroom/server authority. Their legacy
workflows are not thereby migrated or exposed by the new runtime. Other
unsupported inventory and existing Next state still block adoption. This
slice is not wired to the CLI or extension activation, does not prove a global
legacy-writer fence, and is not installed-upgrade success or complete workflow
parity. Do not remove legacy state to make a test pass.
After reconciling status, `import-cleanup` removes only stages whose matching
ownership and workspace identity are verified and whose recorded process is
demonstrably dead; it reports verified stages retained for safety. Unrecognized
or unmarked remnants are left alone and may not appear in the report. It does
not remove an outcome record or a published destination, authorize a retry, or
repair an unknown outcome. Preserve and investigate those separately.
The CLI does not supply the separately required authority for composed Trash,
Recipe Trash or other protected state; such sources remain blocked and require
the qualified host composition. This is not a public endpoint, full legacy
layout support, backup/rollback qualification, production integration or
approved cutover.

### Client-integrated imported-file audit

The private managed child used by `personalKnowledge.nextTrialImport` retains
the approved import plan in the same process. After explicit digest confirmation,
successful import and published-status/marker reconciliation, `attach-import`
now additionally runs `src/managed-import-audit.ts`. It compares every mapped
file's raw SHA-256 and size, plus mode/mtime when specified by the plan, and
checks mapped directory kinds and Markdown path/document-ID/count consistency.
This includes binary assets and relocated Board backing bytes, not just Markdown.
Unplanned files, symlinks, missing or changed files fail closed. Generated marker
and SQLite/WAL/SHM files are not compared with legacy content: their current
bytes are only pinned in the process-local baseline, except for the narrowly
verified original ProjectStore envelope described below. This is **not** a
general SQLite semantic/integrity audit. Other transformed or authority-dependent
special plans, and unverified entries without destinations, explicitly block
this reader; they are not silently omitted.

The existing response fields remain unchanged; successful attach additionally
returns `audit` with schema `pkm.import-byte-audit/v1`, the approved `planSha256`,
mapped file/document counts, `scope: "mapped-files-and-document-identities"`,
`externalWriters: "unknown"` and `cutoverAuthorized: false`. Each subsequent
document/resource read hashes the full target tree before and after the Core read and checks
file/directory identities, modes and timestamps against that baseline. A failed
check returns no document result, invalidates the reader for the rest of that
process, and reports `OUTCOME_UNKNOWN`; restoring bytes does not enable retries.
Close stops admission and waits for these checks and pending reads to finish.
The host still enforces a `canWrite:false` actor and only `capability_read`;
the filesystem-only backend never opens Storage or repairs its index.

Each audit pass is bounded to 20,000 entries, depth 64, 256 MiB per file and
1 GiB total file bytes (including generated database files). Attachment and
every read perform multiple full passes, so large fixtures may exceed client
timeouts; no validation is skipped to avoid that cost. Errors can include
private path names and are for bounded UI display, not logging or automatic
retry. These tests use independent project-local compilation, never shared dist:

```sh
# From the extension package root:
node --test next-server/tests/managed-client-import.test.mjs
```

This closes a client-path preservation-check gap, **not** production migration.
Before/after hashing is not atomic, authentication or writer exclusion:
concurrent mutation, TOCTOU and change-then-revert activity are not proven absent.
The source must remain an explicitly authorized static disposable copy; its
quiescence acknowledgment remains a user assertion, not a fence. Published
outcome/marker and this scoped audit do not prove protected lineage or complete
application-state consistency.

Practical Linux migration still requires decisions and real-environment
evidence for (1) production identity-bound write admission rather than elevating
this fixed reader actor, (2) inventorying and draining/fencing all known old-root
writers plus excluding unknown/external writers, (3) authorized consistent
backup of the existing root and external state, and (4) independent protected
lineage/erasure authorities for rollback. Native host leases/drain cover only
cooperating known hosts. No write enablement, real-root adoption, cutover, pin
change or production backup/restore authorization is supplied by this reader.

### Original ProjectStore envelope and Recipe reader

The normal import planner already recognizes the original
`.pkm/state/projects.json` schema-1 ProjectStore envelope. Its supported active
Project/Recipe records become deterministic canonical projections; the exact
original source bytes (including opaque envelope metadata), control projection
and original ordered command receipts remain in the native database.
Published-status reconciliation compares adoption receipts canonically:
different JSON key ordering is not an unknown publication outcome.

Audited managed attach now admits **only this verified envelope special plan**.
It rebuilds the exact approved projection plan from the stored original bytes,
checks the imported control and initial ordered receipt history, and checks
every projected file against the plan. It queries the closed database through
an immutable, URI-encoded SQLite attachment to an in-memory connection: it
does not create WAL/SHM files or change target metadata. Nonempty WAL or any
rollback journal blocks this verification; it never ignores uncheckpointed
changes or performs recovery. The summary adds
`projectEnvelope: "original-bytes-control-projections-and-ordered-receipts"`.
Unknown state, malformed envelopes, unsupported record metadata, empty
non-derived Recipe folders, Recipe Trash and independently protected state
remain blocked.

`NextManagedClient.invoke("recipe-list", input)` and `"recipe-get"` map only
to `project.recipe.list/get` using the existing Core read admission. Responses
retain the Core envelope's `result`:

- List input: optional `offset`, `limit` (maximum 100), `category`, `projectId`,
  `snapshotRevision`. Result: `items`, `total`, `nextOffset`, `snapshotRevision`.
  Items retain `recipeId`, `knowledgeId`, `revision`, `name`, `description`,
  `category`, optional `systemKind`, and `executableDigest`.
- Get input: `id` (Recipe ID), optional `expectedRevision`,
  `expectedExecutableDigest`, `snapshotRevision`. Result: full `item` and
  `snapshotRevision`. Stale pins fail with `CONFLICT`.

The legacy Recipe filesystem migration intentionally transforms project-scoped
Recipes into global Recipes under `Project/<portable-project-name>/<category>`;
the reader exposes that canonical scope, not the original `projectId`.
Original ownership remains preserved in the opaque source bytes. Recipe IDs,
revisions, definitions, executable digests and supported metadata are preserved;
missing Knowledge identity/aliases are deterministically compiled. The new
test compares full Recipe content with the **actual original ProjectStore's**
`migrateLegacyRecipes` preview/stage/verify/cutover on a separate synthetic copy,
not with a weakened hand-written expected projection.

```sh
node --test next-server/tests/managed-recipe-envelope.test.mjs \
  next-server/tests/managed-client-import.test.mjs
```

The new test independently compiles/stages the production client/runtime,
imports an actual original ProjectStore fixture, verifies list/get and target
immutability, checks corruption/WAL/unknown-state rejection, clean isolated
experiment restart, publication-boundary process death and conservative stage
cleanup. Source and legacy sentinel hashes must remain unchanged.
These mappings do not add Recipe execution, mutations, bundles, production
write authority, or independent restore authority. They establish client
adapter access, not by themselves a Recipe UI or Recipe Electron acceptance.
The existing authorized native backup/restore test remains separate from the
unavailable general-purpose standalone protected restore path.

### Usable imported knowledge: isolated structured editing

Imported Notes, Skills and Research are not restricted to previews once the
user explicitly authorizes the exact `isolated_experiment` target. Private
operations `note-create/update`, `skill-create/update` and
`research-create/update` now invoke the existing native
`knowledge.note/skill/research.create/update` contracts and durable migration
runtime. They are **not aliases for raw document CRUD**. The readonly adapter
rejects all six, and the empty first-run trial does not gain these effects:
only approved import enable/resume admits them under its existing persistent
actor, capability, lease, snapshot and drain checks.

`mutation-scan {}` returns `{scanRevision,documents}`. Each document retains
`id`, `area`, `path`, `revision`, `sha256` and nullable `knowledgeId`. Its
digest is the existing `knowledgeMutationScanRevision`, not the differently
defined document-list revision. The full existing native input schemas remain
in `knowledge-mutations-contracts.ts`: updates require operation ID, source
scan/revision/SHA and identity; create requires operation ID, current scan
and the area's original name/title fields. The receipt contains
`operationId`, `action`, `area`, `path`, `id`, `knowledgeId`, `revision`,
`sha256`, `category` and `name`.

The native service preserves untouched frontmatter, opaque metadata/comments,
identity/aliases and adjacent assets, and atomically reconciles its index and
durable receipt through its existing intent journal. Replaying only the exact
same known request/operation ID returns its receipt; changed requests and
stale scans fail with `CONFLICT`. UI/transport unknown outcomes must still be
preserved and never automatically replayed. A crashed experiment remains
active/unclean and cannot manufacture a clean reopen checkpoint.

This slice permits body and supported metadata edits, **not renaming or file
moves**. Native name/title changes already require the dedicated lifecycle
operation; `moveTo` is rejected before planning. Board/explicit-memory
authority, Trash, models, tools, Script execution and production write scope
are not added. No provider/tool/approval host is injected into the default
native data runtime.

A related lossless-writer bug surfaced in the real client fixture: adding
identity fields to JSON/flow-style YAML previously appended keys outside its
closing mapping. Native edits now splice fields inside the existing flow
mapping and preserve untouched byte ranges; commented flow mappings remain
explicitly unsupported and unchanged rather than being reformatted.

```sh
node --test next-server/tests/managed-knowledge-edit.test.mjs
```

The isolated production-client test uses actual current original
`noteUpsert`, `skillUpsert` and `paperUpsert` on synthetic roots. It covers
all six effects, preservation of identity/custom fields/binary assets,
stale/create/request conflicts, exact durable receipts and clean restart,
flow frontmatter safety, and crash refusal without automatic replay.
The existing native mutation suite separately covers protected descriptors
and exact before/after journal recovery.
Its isolated run currently passes those eight functional tests but fails the
ninth capture/provenance check (`Knowledge mutation captures/provenance are
stale`); no capture or pin is regenerated to conceal existing source drift.

Nonempty code libraries can now be preserved without enabling their runtime,
as described below. This native editing slice does not enable code execution
or claim that every legacy state category is accepted.

### Inert Package/Action/Component/module-set preservation

On Linux, the planner explicitly inventories `packages/`, `actions/`, `components/`
and `action-module-sets/`, including binary files, hidden files/directories,
empty files/directories and ordinary Unix modes. It hashes every file and
pins the full inventory and modes in the approved plan. Import maps **only**
to `legacy-code-archive/<original relative path>` under a private `0700`
archive parent, never to the native runtime's package/catalog roots.
Other platforms explicitly block this slice until their archive protection
policy is qualified; portable names alone do not prove an ACL boundary.
Archive contents are opaque data: neither planning, importing, auditing nor
reading loads Python/JavaScript modules, interprets manifests, installs
dependencies, registers catalogs, creates grants or changes Action trust.
Existing trusted-workspace automatic Action policy remains unchanged; archive
preservation is not a new execution permission and does not implement that
runtime policy in next-server.

Portable case/Unicode collisions, traversal/reserved names, symlinks,
hardlinks, special files, privileged mode bits, unknown roots and inspection
limits block rather than being silently omitted or approved. A supplied
`legacy-code-archive/` source root is itself unsupported; it cannot overwrite
or merge with generated archive content. Source drift rejects the approved
plan; publication remains atomic no-replace and conservative owned-stage
cleanup retains unknown outcome evidence.
Cleanup may restore owner read/write/traverse bits solely inside a verified
owned abandoned archive stage before deleting it, so preserved read-only
directories do not prevent recovery. It never relaxes source or published
target permissions; directory descriptors refuse symlinks.

`action-module-sets/` is fully byte-preserved, **not activated**.
The user's `archive_only` decision also preserves the exact quiescent
`.pkm/state/actions/**` subtree as `legacy-code-archive/action-state/**`,
including historical trust, validation, runs, queues and grants. Its original
bytes and ordinary modes are evidence only, not current state or authority;
no grants, trust, registrations or execution are inherited. Pending locks,
intents and temporary files still block import, as does other unknown `.pkm`
state. The archive may contain sensitive old credentials and must remain private.

The existing receipt's `assets` include archive destinations, size, SHA-256
and file modes; optional `archivedDirectories` records directory destinations
and original modes. Audit verifies those mappings/modes and rejects extra
archive directories/files. The existing read-only `library-list` /
`library-get` operations accept the four code areas and `action-state`: logical paths stay
`actions/...` etc., but bytes come only from the protected archive, never from
native runtime roots. `action-state/...` maps to the original
`.pkm/state/actions/...` solely for historical read-only inspection; no runtime
state API is exposed. Snapshot-pinned pagination and SHA-pinned 64 KiB base64
chunks are unchanged. Entries have `prompt:null`, `scriptIdentity:null`,
`identityStatus:"not-applicable"` and `legacy:null` on get; no executable
projection or identity is invented.

On Linux, Skills-only migration also preserves regular files beneath
`skills/.trash`, regular `.gitkeep` markers, and visible non-Markdown regular
files as `legacy-code-archive/skills-history/skills/<original path>`. The plan
and receipt identify this as `opaque-inert-history`; ordinary file and directory
modes, empty directories, bytes, and digests are retained for backup/restore.
These records are not active Skills, are not exposed through
`library-list`/`library-get`, and are never parsed, indexed, synchronized,
executed, or admitted as Action authority. This is archive-only preservation,
not Trash editing or support for arbitrary package execution. Symlinks, special
files, hardlinks, privileged modes, unsafe paths, and unsupported filesystem
shapes still block instead of being omitted.

Active Skill Markdown and assets keep native private publication permissions
(`0600` files, `0700` directories), not the source filesystem permissions.
The original-mode preservation above applies to opaque history, not active
Skills; byte, identity, body, metadata and resource preservation are separate
checks.

Authorized workspace backup/restore includes these bytes and modes, including
empty directories. Backups keep private on-disk modes and bind original
directory modes in the optional, archive-only `archivedDirectoryModes`
manifest field; restore validates its exact directory set and reapplies modes
inside the protected archive. Existing restore authorization and no-replace
publication are unchanged. Older consumers that do not support this manifest
field must reject it rather than silently drop mode information.

```sh
node --test next-server/tests/managed-code-archive.test.mjs
```

This isolated production-client/CLI test uses only generated synthetic
content. It covers byte/mode parity, binary chunks, hidden/empty inventory,
read-only audit, explicit experiment clean restart, native-authorized
backup/restore, collisions/unsafe entries/state blockers, source drift,
no-replace, interrupted publication, conservative cleanup and permanent
audit invalidation. It never imports or runs the archived module.
**Installed/authorized/verified code execution is still not implemented by
this preservation slice.** `legacy-action-catalog.ts` continues to project
packages disabled, and `vscode-action-trust-bridge.ts` still requires native
workspace/content-hash/trust-epoch authority; filenames and import approval
are not substitute execution grants. No real-root migration or cutover is
claimed.

### Prompt/Script libraries: original versions and identities

These are not a newly invented Markdown format: `legacy-library.ts` already
imports raw `prompts/` and `scripts/` trees, including nested/binary resources,
sidecars, placeholders and empty directories. Library Markdown is not indexed
as Notes. File bytes and ordinary executable modes are preserved; destination
directories use the existing private `0700` import policy.

The current original `src/knowledge/storage.ts` writers
`promptSaveVersionNote`, `scriptGet` (when initializing identity) and
`scriptMove` leave empty `.pkm/state` lock-parent directories. Those exact
empty shells previously blocked import. The importer now maps **only** the
empty `.pkm` / `.pkm/state` directory inventory into inert
`legacy-import-evidence/.pkm[/state]`, explicitly recorded in plan entries
and checked by the existing mapped-directory audit. It does not create a
legacy `.pkm` root in the destination or weaken native snapshot authority.
Backup/restore preserves this evidence directory. Any lock, journal, unknown
descendant, symlink or actual protected state still follows its original
fail-closed rules; nothing is silently deleted to make a plan pass.
The composed Trash importer also recognizes that exact empty evidence tree,
validating each directory and its stable listing without treating its contents
as Trash or removing it. Unknown descendants and symlinks remain blockers.

The preflight also rejects a sidecar alias owned by a different *current*
Script path, even if that current file has no sidecar. Malformed, orphan or
multiply owned identities still block. Sidecar metadata over 64 KiB is now
an explicit `script-identity-limit` blocker rather than admitting data that
the bounded client identity projection cannot safely inspect. Preserve such
originals for review; do not truncate them or regenerate their IDs.

Private managed operations `library-list` and `library-get` map to Core
`knowledge.library.list/get`. The same Core contracts work in the isolated
experiment/restart adapter; no execution, template rendering, sidecar
initialization, mutation or historical restore capability is added.
Strict schemas are in `src/library-contracts.ts`; responses retain the Core
envelope's `result`:

- List input: `{area:"prompts"|"scripts",offset?,limit?,snapshotRevision?}`.
  Limit is at most 100. Result contains `items`, `total`, `nextOffset`,
  `snapshotRevision`, including every file and directory below that area.
- Each entry includes `area`, full area-prefixed `path`, `kind`, `role`,
  `size`, raw `sha256` (null for directories), `mode`, Prompt path coordinates
  when applicable, `scriptIdentity` (the complete original JSON object or
  null), and `identityStatus`.
- Get requires `{area,path,expectedDigest,snapshotRevision}` from that list,
  with optional `offset` and `length` (maximum 65536). Only files can be read.
  Result includes the exact entry binding, snapshot, canonical base64 `data`,
  `offset`, `nextOffset`, `textStatus` and `legacy`. Full small UTF-8 files
  additionally expose the original Prompt `{raw,content,meta,...coordinates}`
  or Script text/language/identity projection. Larger files use chunks;
  binary or oversized content is never substituted with truncated text.
- A missing Script sidecar is `unassigned`, with null canonical identity:
  no deterministic or random ID is fabricated, and reads never call the old
  identity-initializing `scriptGet`. Preserved aliases are not execution
  grants. Prompt history is the existing version-directory/file inventory;
  Script aliases record preserved lineage, **not an event log**.

The scanner fails closed on unsafe paths, unknown hidden state, portable
collisions, ambiguous identity and changing files. Complete inventory is
limited to 20,000 entries, depth 64, 256 MiB/file and 1 GiB total; no partial
success is returned when limits are exceeded. Reads pin the full library
snapshot and raw digest, and the managed reader additionally checks its
unchanged whole-workspace baseline before and after each Core read.

```sh
node --test next-server/tests/managed-library-import.test.mjs
```

This independently compiles/stages the production client/runtime. Its
`library-original-fixture.mjs` invokes the **current actual original writers**
on a synthetic root: Prompt cloning/note updates, Script identity creation
and move/alias retention. Tests verify complete version and raw/metadata
parity, sidecar opaque fields, binary chunks, empty files/directories,
unassigned identities, no-write reads, restart, native-authorized
backup/restore, permanent tamper invalidation, blocked locks/hidden history,
and publication-boundary process death with conservative cleanup.

The separate existing `legacy-library-import.test.mjs` functional cases
continue to cover raw library import and authorized restore. Its source-pin
check currently reports `src/knowledge/storage.ts: hash-changed` against
`migration/legacy-batch15-provenance.json` because the shared original source
already contains Markdown-lock/fence changes. Those pins are not updated by
this slice. Current-writer fixture success is not proof of pinned historical
parity, support for arbitrary hidden history/Trash, real-root migration,
production write admission, independent rollback authority or cutover.

### Opt-in isolated import write rehearsal

The managed child additionally supports **`isolated_experiment`**, only for
synthetic data or a dedicated, explicitly authorized isolated copy. The original
read-only import/attach path remains unchanged. This mode is not production
write authority, real-root adoption, cutover, rollback qualification or a claim
that external writers have stopped. The UI must explicitly display
`external: "unknown"` and obtain separate exact-target approval.

The private IPC sequence is:

1. Complete import, status and audited read-only attach in the same child.
2. `prepare-import-write {id}` rechecks the approved snapshot and returns
   `{workspaceId,target,planSha256,authorizationDigest,scope:"isolated_experiment",
   writerCoverage,blockers:string[]}`. UUID `id` follows the existing result
   envelope. Preparation does not grant writes.
3. `enable-import-write {id,authorizationDigest,confirmTarget,
   acknowledgeIsolatedExperiment:true}` requires the current digest and the
   **exact absolute target path**. Successful result includes
   `{workspaceId,readOnly:false,scope,writerCoverage,
   credential:{parent,capability}}`. A 256-bit capability is generated in the
   child and returned only once. The trusted client stores it in VS Code
   SecretStorage, never a workspace file or log. Failed/unknown enable, timeout
   or SecretStorage failure must not trigger automatic enable/write replay.
4. After successful close **and actual exit zero**, a new child can receive
   `start-import-write {parent,capability,acknowledgeIsolatedExperiment:true}`.
   Startup returns `ready {workspaceId,readOnly:false,scope,writerCoverage}`.
   The client must match its saved workspace identity and scope. No arbitrary
   existing directory can be adopted merely by supplying a marker.

`src/managed-import-write.ts` binds the capability to an owner-only sibling
`.pkm-isolated-experiment.json`: exact parent/target, parent inode/UID,
workspace identity, original plan digest/source boundaries, random persistent
experiment actor and clean-close inventory. The file stores only a capability
hash, and its payload has an HMAC keyed by the capability retained outside the
workspace. The actor is a local bearer-capability identity, not authentication
of a human or production principal. The parent/control record must be private,
canonical and non-symlink; hard-linked data files are refused. An exclusive
sibling session lock rejects competing rehearsal sessions.

Before Storage opens, the session is durably marked active. A cooperating
native host must acquire the real workspace lease; Core admission limits the
random actor to document list/get/create/update and resource list/get, with
native revision/hash CAS for document mutations.
Requests are serialized. Before/after checks pin all non-database files and
directories; a successful mutation may change only its returned document and
create necessary parent directories. The written bytes must match its returned
digest. Runtime SQLite/WAL/SHM bytes are excluded from live byte comparison
because lease/index updates legitimately change them; this is **not** a
database-tamper detector. Lease checks, not a byte hash, protect cooperating
native ownership. Known CAS conflicts leave the session usable; an unknown
effect, unexpected file change, lost lease or altered authorization invalidates
it and refuses further operations.

Close stops admission, drains requests and Storage, then captures/rechecks the
entire closed target including database bytes, synchronizes an authenticated
clean checkpoint and releases the session lock. Only then can it report
`closed`; failures report `close-error` and do not authorize restart writes.
A wrong capability, changed record/permissions, changed closed inventory,
active/crashed session or retained lock rejects reopening without automatic
repair, lock removal, cleanup or reimport. Preserve the directory and investigate
unknown outcomes; there is deliberately no force-unlock or lineage bypass.

The cooperating-host lease, local lock, CAS and before/after hashes do not
exclude same-UID/noncooperating writers, prove atomic quiescence, prevent all
TOCTOU activity or establish anti-rollback lineage. HMAC protects the binding
against edits without the client-held capability; it is not an independent
monotonic authority. These residual risks are accepted only for the explicitly
selected isolated experiment. Original sources remain untouched, no pins or
active-root configuration change, and existing backup/restore/erasure authority
requirements are not relaxed.

The targeted command above covers real child/Python/Storage write→clean close→
restart, durable content and actor binding, CAS and competing-host conflicts,
wrong credentials, altered authorization/permissions, target changes (including
change then restore), active external edits and SIGKILL refusal. It compiles
into per-test project-local output rather than shared `dist`; these fixtures
do not establish real-data migration or production acceptance.

### Imported Notes, Skills and Papers resource reads

The managed client previously retained attachment bytes during import but
exposed only document text. `NextManagedClient.invoke("asset-list", input)` and
`invoke("asset-get", input)` now bridge the existing `knowledge.asset.list/get`
contracts, rather than inventing a migration-only file reader. Both are read
capabilities in the audited read-only host and the isolated write rehearsal;
they never grant asset mutation, arbitrary path access or executable handling.
The response is the same Core envelope as document reads: `{result: ...}` or
`{error:{code,message,effect}}`.

The document ID determines `notes`, `skills` or `papers`; discovery takes
`{id,offset?,limit?,revision?}` and returns its document SHA, catalog revision,
paged `{area,path,digest,size}` items and diagnostics. Paths are relative to that
document's area, not arbitrary filesystem paths. Resource reads require
`{id,path,expectedDocumentSha256,expectedDigest,offset?,length?}` and return
bounded base64 chunks, offset, size and next offset. Pin both digests across
chunks and recheck the complete byte digest. Native limits remain 16 MiB per
file, 64 MiB/2048 entries per catalog and 65,536 bytes per chunk; UI limits may
be stricter. Conflict/error envelopes are not resource bytes or retry authority.

The implementation reuses `src/assets.ts` and the captured Markdown resource
rules: paired `Document.assets`, unreferenced owned diagrams, percent-encoded
names and actual shared `_assets` references. References appearing only in
code do not grant catalog membership. Missing and outside-area references
produce diagnostics; traversal and symlinks are refused, and Todo backing JSON
remains denied through this API. Notes/Papers shared import retains its original
content-addressed upload restrictions. Skills shared trees follow the broader
original bundle layout described below. Neither path repairs broken links or
silently drops diagnostics.

```sh
# From the extension package root; isolated compilation and production payload staging:
node --test next-server/tests/managed-client-assets.test.mjs
```

The representative synthetic fixture uses original `pkm.knowledge/v1`
`knowledgeId` metadata in all three areas, binary and empty paired resources,
unreferenced diagrams, content-addressed shared files and nested Skills shared
resources with percent-encoded references. The real
production client adapter verifies import→status→read-only resource pagination/
multi-chunk reads→explicit experiment enable→clean close→restart→resource reads.
Source, legacy sentinel and read-only target bytes are compared independently.
Wrong pins, traversal, Todo authority access, oversized chunks and post-attach
resource tampering fail without returning content or restoring write authority.
This closes attachment access, not full feature parity: library templates and
scripts are not executable here, Board authority needs Board operations, and
advanced Skill routing, structured Research views, protected/control-state
composition, external state and production writer fencing retain their own
requirements. Resource preservation/read evidence is not production cutover.

### Skills shared-resource preservation and interrupted-import recovery

The original `src/knowledge/markdown-assets.ts` bundle writer accepts
`type:"skills"` assets in both paired directories and referenced `_assets`
trees, with portable arbitrary filenames and nested directories. This differs
from the filename convention generated by untitled Notes/Papers uploads.
`planLegacyImport` now preserves `skills/_assets` and category-local
`skills/<category>/_assets` trees at their exact original paths, including
nested binary, empty and unreferenced files/directories. It does not rename,
deduplicate, rewrite Markdown, select a winner or require a resource to be
currently referenced before preserving its bytes.

Portable path rules, regular-file-only reads and the existing conservative
catalog bounds still apply: 16 MiB/file, 64 MiB combined paired/shared assets
and 2048 combined entries, in addition to global importer limits. Unknown
hidden/unsafe paths, links, special entries and `pkm-todo-board.json` authority
files block rather than disappear. Shared paths are compared after NFC and
case normalization against each other and the rest of the source inventory:
file/file, directory/directory and file/directory collisions produce
`shared-asset-path-collision` with both paths. Even identical bytes do not
silently resolve a collision. Existing Notes/Papers shared restrictions remain
unchanged.

The plan fingerprints every included file; source drift invalidates approval.
Import still requires an absent destination and atomic no-replace publication,
so no existing root or resource is merged or overwritten. A process death
around publication is reconciled through the existing sibling outcome record,
not inferred from a missing target. Only proven-dead, correctly owned stages
may be removed by conservative cleanup; the outcome record and published
destination remain untouched. Unknown outcomes do not authorize a retry,
force-unlock, lineage adoption or restore. No new recovery authority is added.

```sh
# Package root, independent compilation/staging; never shared dist:
node --test next-server/tests/skills-shared-import.test.mjs next-server/tests/managed-client-assets.test.mjs
```

The Skills-specific fixture calls the **actual original bundle writer** to
produce category/root shared binaries, then imports a static copy. It checks
exact bytes and Markdown, catalog visibility, multi-chunk reads, unreferenced
preservation, destination refusal, case/NFC/file-directory collisions, unsafe
surfaces and source drift. An actual importer CLI is killed at the publication
boundary: staged binary bytes remain recoverable, status is not published,
dead-stage cleanup retains the durable outcome, and a separate published
target stays intact. The production-client fixture also reads Skills shared
resources after audited attach, explicit experiment enable and clean restart.
These synthetic rehearsals are not evidence of real-root migration, full
Skills routing/subscription parity, rollback authority or external-writer
exclusion; those requirements remain separate.

### Disposable migration reconciliation and rollback rehearsal

`scripts/migration-audit.mjs` provides a read-only, scoped check independent of
the importer publication operation. Use the already built `dist` from the same
revision. All inputs must be explicitly quiescent disposable fixtures, not a
real Knowledge Root. This command does not stop writers or make a snapshot;
running it concurrently with a writer is unsafe. The acknowledgment is an
operator assertion, not proof. Reports include path names: keep them private.

```sh
node scripts/migration-audit.mjs reconcile --source /absolute/disposable-source \
  --destination /absolute/imported-workspace --acknowledge-quiescent-disposable-copy
# Save outside BOTH trees on a private filesystem; do not overwrite an existing baseline.
umask 077
set -C
node scripts/migration-audit.mjs snapshot --root /absolute/imported-workspace \
  --acknowledge-quiescent-disposable-copy > /absolute/private-baseline.json
node scripts/migration-audit.mjs diff --root /absolute/imported-workspace \
  --baseline /absolute/private-baseline.json --acknowledge-quiescent-disposable-copy
```

Reconciliation replans the source, checks the durable published outcome and
fingerprint, and independently hashes each mapped destination file, including
relocated Board backing files; reported modes and mtimes are compared when
the plan specifies them. Missing, changed, unsupported or transformed entries
and special plans prevent success. `matched-scoped` does **not** check extra
destination files, all external state, application-level compatibility, or
approve a migration. Outputs distinguish blocked plans and a non-published or
unknown outcome. An outcome is not itself proof of the current file bytes.

Snapshot inventories the entire workspace including database, files,
directories, file hashes, modes and file mtimes. Diff reports additions,
deletions and modifications and exits nonzero on any change; snapshot/diff
also fail on symlinks, special files, unstable reads, invalid baseline or the
bounded limits (20,000 entries, depth 64, 256 MiB/file, 1 GiB total). Both
operations are read-only; the shell redirect creates the baseline. Its
directory must be outside the inventoried tree. Diff requires the same
canonical root and device/inode, and cannot validate the authenticity or
retention of a user-supplied baseline. Read-only inspection is not an atomic
snapshot; hard links and other writers must be excluded by the operator.

For rehearsal, preserve the legacy source and create a separate backup before
allowing disposable target writes. Quiesce again and run `diff` before any
rollback: changes require an independently reviewed preservation/merge plan,
not a silent switch back to the old copy. The audit never applies a rollback,
exports new writes, resolves conflicts, or infers whether a deletion is
protected. Even an unchanged filesystem does not establish protected
lineage or grant rollback authority. A fixture-only restore authority can
exercise a fresh absent destination in tests, but production backup restore
still requires the independent native authorities described above.

For a **frozen disposable workspace only**, `deliver` builds a non-destructive
review bundle in a new directory outside the workspace and baseline:

```sh
node scripts/migration-audit.mjs deliver --root /absolute/imported-workspace \
  --baseline /absolute/private-baseline.json --destination /absolute/NEW-delivery \
  --acknowledge-quiescent-disposable-copy
# Save the printed manifestSha256 separately in a trusted, private location.
node scripts/migration-audit.mjs verify-delivery --destination /absolute/NEW-delivery \
  --manifest-sha256 <printed-lowercase-sha256> --acknowledge-quiescent-disposable-copy
```

The manifest retains both inventories, per-path added/changed/removed status,
original modes, file mtimes and hashes. The `payload/` contains **all current
workspace file bytes**, not just changed files, including Markdown identities,
resources, database files and any SQLite WAL/SHM/journal sidecars; sidecar
paths are explicitly listed. The verifier checks the externally retained
manifest hash, exact payload inventory and file hashes. It is an integrity
check, not authentication unless that hash is independently protected.
Deletes are only reported: a baseline has hashes, not old file contents, and
the tool neither deletes from nor writes to a legacy store. Retain the original
legacy copy and any separately authorized backup to preserve prior bytes.

The artifact is a raw, bounded filesystem capture, **not** a SQLite-consistent
backup, semantic delta, automatic merge, restoration mechanism, production
handoff, or proof that outside-workspace state was included. DB changes may
need application-specific interpretation; raw SQLite sidecars must not be
discarded or independently replayed. Secrets may be present in the complete
payload: restrict access and do not send it to untrusted systems. The caller
must stop all writers, including external hard-link writers, and keep source,
baseline and artifact parent private and unchanged for the whole operation.
The inventory and copy recheck cannot prove quiescence. Missing baseline
authenticity, excluded external state, protected deletion lineage, and
concurrent or interrupted writes prevent any claim of complete migration or
safe rollback. An unsuccessful delivery can leave an incomplete new directory;
never use it as a valid delivery, and inspect it before manual cleanup. No
power-loss durability or automatic recovery is claimed.

For a stronger **disposable single-database** delivery, use the existing native
host backup rather than raw `deliver`:

```sh
node scripts/migration-audit.mjs deliver-consistent --root /absolute/frozen-workspace \
  --baseline /absolute/private-baseline.json --destination /absolute/NEW-delivery \
  --python /absolute/path/to/python3 --acknowledge-quiescent-disposable-copy
# Preserve the printed manifestSha256 separately via an independent trusted channel.
node scripts/migration-audit.mjs verify-consistent --destination /absolute/NEW-delivery \
  --manifest-sha256 <printed-lowercase-sha256> --python /absolute/path/to/python3 \
  --acknowledge-quiescent-disposable-copy
```

This calls the standalone `backup` CLI in a child process. The host drains its
own admitted work, holds its quiescence/workspace lease, rejects pending
journals and unsupported state, uses `VACUUM INTO` for `core.sqlite`, checks
SQLite integrity, pins and rechecks file bytes and verifies the backup before
no-replace publication. The audit additionally checks the full workspace
inventory before and after the host backup, compares all non-database file
bytes against the result, records the baseline diff and backup receipt, and
requires all listed entries to be present. Its verifier hashes the complete
backup and runs Python's SQLite `integrity_check` in immutable read-only mode.
It does not re-run the host's private backup verifier or authenticate the
receipt. The external digest must be independently trusted.

The CLI opens the workspace and updates native ownership/lease bookkeeping;
unlike raw `deliver`, it is **not read-only**. The caller must stop all
other hosts, schedulers, external filesystem/database/hard-link writers and
hold the source, baseline and delivery directories private and unchanged
throughout; the process cannot prove that assertion or provide a cross-process
filesystem freeze. The resulting consistency is conditional on those facts.
The single-database path refuses additional SQLite headers, database-like
filenames or journal/sidecar names, instead of treating raw copies as
transaction snapshots. Hidden/encrypted databases, external Memory, credentials,
state outside the workspace and unrecognized authority-dependent features
require separate inventory and qualified coordination; they are not covered.
Python must be an explicitly trusted absolute executable with standard-library
SQLite, and Node/build must match the installed workspace. A failed operation
can leave an incomplete directory without a valid delivery manifest. This is
not restore, deletion approval, lineage verification, a semantic merge, power
loss qualification or permission for production use.

For a local, already initialized isolated workspace, the internal compound
Markdown bundle importer is available separately:

```sh
node dist/cli.js bundle-import --data /absolute/workspace --bundle /absolute/bundle.json
```

The UTF-8 JSON file must be a regular non-symlink file no larger than 96 MiB.
It requires `operationId` (a UUID retained for exact receipt replay), and
optionally accepts `prefix`, legacy `from`, `created_at`, `version`, `skills`,
`notes`, `papers`, and `assets`. Paths follow the legacy bundle resource
mapping: Skill category/name, Note slug, and Paper slug (or category/title).
Assets contain `type`, `path`, canonical base64 `data`, and `sha256:` `digest`.
The receipt is printed as `{"receipt": ...}` after storage closes. A changed
request using the same operationId conflicts. Unsupported nonempty areas,
unknown fields and Todo Boards are rejected; they are not silently omitted.
Knowledge links are validated using the original v1 contract and stored
without requiring targets to exist. Paper citations are normalized and
resolved against existing and incoming Papers by case-insensitive slug or
title (slug first), with incoming slugs relocated under the prefix. Unresolved
and self citations are dropped; duplicates and notes are retained. For duplicate
titles, the last path in sorted destination path order wins. Resolution is
captured in the journal and is not recalculated during recovery. Existing
resolved Paper targets are journaled by document identity and content digest;
if a target changes or disappears before restart recovery, recovery preserves
the intent and publishes no remaining import files. A completed import remains
associated with its Markdown resources and citations after a relocated
workspace backup restore.
Supported descriptive metadata is stored in
frontmatter, including tags, descriptions, authors and Paper file references.
Source `schema` and `knowledgeId` must occur together and are validated;
source revision and aliases, when provided, are preserved. Missing identities
and revisions are generated as native identity and revision 1, respectively.
Aliases are normalized and augmented with source path, native path and document aliases;
identity or alias collisions are rejected both before journaling and during
recovery. Native document IDs remain path-derived rather than copied. Skill
identity may be supplied on the Skill or its metadata, but not both; legacy
Sync Skill exports omit it. `updated_at` and bundle envelope metadata are not
restored. A revision number is retained, not historical revision snapshots.
This is not full legacy bundle parity: legacy upserts may choose different filenames or enforce additional Skill-name and
group-import rules. The journal recovers partial publication; it is not an
atomic multi-file filesystem transaction.

The importer fingerprints Markdown modification times in nanoseconds and
restores them in the staged workspace; backup manifests retain those times for
Notes, Skills and Papers and restore reapplies them. This preserves the
original Note interface's timestamp input rather than rounding it to
milliseconds. A changed source timestamp invalidates the plan. Older backups
without timestamp fields remain readable but cannot recover times they never
recorded. Timestamp restoration requires a filesystem that can represent the
recorded value; otherwise it fails before publication. Linux is tested;
native Windows behavior remains unverified.

### Markdown-to-compute staging rebuild

[knowledge-index.ts](./src/compute/knowledge-index.ts) provides
`rebuildKnowledgeIndex` and a bounded `KnowledgeIndexRebuilder` queue.
Supply canonical `root`, indexed Markdown `documents`, an explicit
`{partition,namespace}` scope and `ComputeOptions`. Derive the worker identity
with `knowledgeIndexScope(root, scope)`; the staging runtime directory must be
absent, outside the Markdown root, and its database a direct child.

The bridge maps verified original source projections into derivative compute
pieces/edges, not authoritative knowledge or fabricated embeddings. Bounds are
128 explicitly selected documents, uncapped source bytes and 512 edges. Pass
`recheckDocuments: () => scanMarkdown(root)` to fence additions/deletions across
all areas as well as changes to selected sources. Standalone
`recheckKnowledgeIndexSources(artifact)` checks existing pins only.

The orchestrator closes/checkpoints its worker before returning
`{artifact,artifactPath,worker}`; `worker` is reopening configuration, not a live
client. The artifact resides in the staging runtime directory; its physical
database hash covers closed bytes and can be invalidated by later mutation.
Callers own retained staging cleanup/activation decisions. Rebuild has no
automatic uncertain-mutation replay, embedding generation or production swap.

Knowledge-index provenance records **eight transformed reference mappings**,
not eight byte-identical original captures: four original source references
and four native reuse references. The extended native `ChatMemoryWorker` is
no longer an active ninth source/capture mapping; its current bytes are pinned
separately in native qualification. Its previous source hash and captured-path
hash remain in `sourceHistory`. This reclassification does not modify the
original Python captures or either knowledge-index implementation.

### Persistent memory-compute adapter (library only)

The captured Python engine and `ChatMemoryWorker` adapter isolate computation in
a persistent subprocess. Configuration explicitly selects an absolute Python
executable, a dedicated runtime data directory, its direct-child SQLite database
and partition identity; never point initial qualification at the real Knowledge
Root. Deployment must include `dist/compute/` and the sibling `compute/` Python
worker/package, not just TypeScript build output. Python >=3.10 with
standard-library SQLite is required; no pip dependencies are needed.

Open the adapter with `ChatMemoryWorker.open(options)` from
[chat-memory-worker.ts](./src/compute/chat-memory-worker.ts). `close()` drains
cleanup; `reopen()` is explicit. Named methods and parameter unions are defined
in [compute contracts](./src/compute/contracts.ts); there is no public raw RPC.
Defaults are 10-second startup/request deadlines (including queue wait),
2-second close timeout, 64 pending requests, 16 MiB queued bytes, 8 MiB request
and response bounds, and 16 KiB retained stderr. Configuration uses validated
safe integers. Symlinked data paths/files, identity mismatches and unsupported
database schemas are rejected rather than replaced.

Ready-handshake validation, bounded queues/IO/timeouts, stderr diagnostics and
process cleanup are covered by disposable subprocess tests. Failures distinguish
not-submitted, read-only, rejected and submitted-mutation unknown outcomes.
Mutations (including usage-touching `readMemory`) are **not automatically
replayed** after uncertain outcomes; fatal failures terminate/reap the child.
Explicit-memory
operations are blocked in this adapter: Markdown-backed Node explicit-memory
authority remains unchanged. This library is not yet a Core service or public
HTTP/MCP operation. Authorization, model execution, Markdown ingestion/rebuild
and production lifecycle integration remain.

`npm run test:qualification` builds only this package and tests fresh temporary workspaces, real HTTP,
real SDK MCP child processes, cross-process CAS, durable replay after restart,
trash/restore, permissions, strict input/output shapes, bounded queue draining,
event-loop responsiveness during a write lock, pagination conflicts, invalid
workspaces, CLI startup, unsupported database versions and committed-WAL recovery
after an abrupt process exit. This does not simulate hardware power failure.
Markdown tests cover external edits, digest CAS, arbitrary nested metadata/comment/
identity preservation, index reconstruction and both pending-intent recovery
boundaries (including refusal to overwrite an external conflict).

This isolated partial migration is **not a replacement for the existing PKM
server**. It does not yet include full legacy-layout data import/client parity.
The bounded browser, Chat, execution/approval, memory, retrieval and Python
compute slices described above do not establish full legacy behavior or
production acceptance; optional Teams plugins remain unqualified. No
throughput/latency/capacity improvement is claimed without representative
workloads and approved SLO benchmarks.
Remaining work is tracked in the full migration checklist: knowledge/asset/Todo
parity first, then the remaining server domains and independent Browser/Chat,
followed by migration/rollback and qualification before any cutover.

### Experimental MCP process diagnostics

The isolated `compat/legacy-compact-mcp.py` host can opt into original MCP
metadata diagnostics with `--diagnostics-directory /absolute/private/directory`.
The operator must provision this existing canonical directory outside the
workspace and protect it and its parent from other writers. On POSIX it must
be owned by the launching user and inaccessible to group and others; other
platforms fail closed until equivalent directory authorization exists. No
diagnostic directory is created or used unless explicitly selected. This is
independent of `--allow-writes`, and is not enabled by managed launchers
automatically. Logs are outside workspace backups.

The original `DiagnosticLog` and call middleware record actual runtime start,
call start, wait, return, failure and cancellation metadata, never tool
arguments, results or transcripts. `diagnostics_latest` preserves the legacy
1–1000-record, oldest-first tail for the current process. The experimental
`diagnostics_page` pages the same actual records newest-first, with an
append-stable cursor and a maximum of 1,000 records per page. Retention or
damaged files can invalidate a cursor; restart pagination rather than assuming
complete history. Each process has a fresh writer ID. These two tools and their
cursors are confined to that writer; older files remain available to the
directory owner through the original local diagnostic export.
Every client sharing a process shares this diagnostic view. The logger is
best-effort and exposes dropped counts in `diagnostics_latest`; it is not an
audit ledger or evidence of complete delivery. This opt-in slice does not
implement legacy MCP usage aggregation or full production diagnostics parity.

An operator may additionally pass `--diagnostics-history` to authorize every
MCP client of that process to read **all writers** in the selected directory;
only use a dedicated directory whose entire history is appropriate for those
clients. This is a separate grant, not inferred from a worker token, read-only
mode, a cursor, or discovery. `diagnostics_writers` returns bounded writer-ID
pages with a pinned inventory revision. `diagnostics_history_page` reads
actual retained JSONL rows for a selected writer, newest-first, and accepts a
cursor across server restarts. It pins the byte length and SHA-256 of each
original chunk, so later appends do not change the page and a missing, truncated
or changed chunk fails rather than mixing histories. It does not create events
or a persistent copy of their content. Cursor capture scans up to 101 chunks
and continuation verifies chunks being read; large logs can therefore be
expensive. Restart pagination after a conflict. Files must be regular,
single-link and owned by the launching user; symlinks are refused.

Legacy `diagnostics_latest` itself intentionally reads only the current
writer: each process has a fresh writer ID and the original local export is
the way to select older writers. Thus preserving its behavior is not a
restart-parity regression; the separately authorized history tools are an
experimental extension, not a claim that full legacy production integration
or historical ingestion has been migrated.

### Isolated legacy GitHub Sync experiment

`openExperimentalLegacySyncHost` is a native-only test integration, not an
activation, scheduler, CLI, or production migration path. Its caller supplies
an already-adopted synthetic workspace, the original profile directory, the
VS Code SecretStorage reader, an explicit transport, and an independently
enforced all-writers expected-commit boundary. The local Git transport used
in tests is not a GitHub provider. The caller must exclusively control all
fixture writers; the old MCP can bypass the Next filesystem lock.

The host reads the original target and recorded transaction without rewriting
them and binds the prior commit to the target, root, account and policy. This
slice only accepts all-public, flat root-level Skills with no pending deletions,
paused entities, per-entity bases or Skills mount. Private Skills, folder/item
subsets and other selected types are refused. Existing non-Skills are not
selected or changed. Prepared/ambiguous legacy transactions, legacy conflicts,
content repairs, coordinator work and service recovery records are refused
for their original recovery procedure; they are not silently acknowledged.
A narrowly qualified legacy `pushed` transaction can be explicitly reconciled when the original
baseline and prepared/pushed commits match, the remote branch still points to
that commit, the complete outbox matches the remote manifest, all selected local Skills
already match, and non-Skills are unchanged from the historical base. The
experimental host stores a native durable receipt and baseline; it does not
change or acknowledge the old transaction or configuration. Any mismatch
remains blocked. Native publish interruptions reconcile read-only after restart.
Without an old baseline, `sync()` first returns a persisted, non-publishing
comparison against an **empty virtual Skills base**, not a claimed historical
commit. An explicit `confirmComparison(sessionId)` is required. Conflicts
are inspected with `inspectComparison()` and resolved individually through
`decide()` with session, revision and operation IDs; `discardComparison()`
abandons the comparison without applying it. Confirmation and decisions recheck
the original configuration, local Skills and remote commit/manifest. Changed
inputs require a new comparison. Decisions and incomplete comparisons survive
restart; unknown publishing results are never automatically replayed.

`activateNativeSyncUiFixture` wires this bounded host to the installed GitHub
Sync panel only for an explicitly granted synthetic private profile. Its
controller acquires the normal writer lease before VS Code starts, uses a
loopback-only bearer-authenticated bridge, and only accepts a synthetic
credential and local bare Git fixture. The installed UI journey covers initial
comparison, explicit Local/Remote choices, push/pull and a lost push response
across a controller and editor restart; Notes and Prompts remain unchanged.
The fixture does not establish a safe production bridge, autonomous legacy
upgrade or actual GitHub publication. Original profile state is preserved.

The old Git implementation supports an HTTPS credential manager and SSH
identities as well as VS Code credentials. This isolated host only accepts the
VS Code credential binding; it does not support HTTPS helpers or SSH, and
neither the fixture's atomic Git lease nor a workspace lock establishes a
production GitHub REST CAS. A network-isolated test exercises the old Git
arguments using a synthetic credential helper and a fake SSH executable backed
by local bare Git; it does not establish real SSH host-key, identity or helper
trust. None of these experimental APIs lifts the production writer gate.

The private installed fixture injects a temporary manifest entry-point shim for
normal-mode SecretStorage access and restores the installed payload afterward.
It uses the original extension ID and one synthetic profile; this is not an
unmodified-package, unattended upgrade or a legacy GitHub Sync implementation.
VS Code extension-test mode uses in-memory storage, so its secret reads cannot
establish persistence across editor processes. The fixture disables workspace
trust only in its synthetic profile to avoid an interactive trust prompt.
For the isolated Sync journey the shim passes the synthetic credential once
over a private socket to the fixture runner; VS Code exits before the guarded
Sync process starts. This does not wire production SecretStorage. The current
process-inventory guard blocks VS Code hosts including ancestors, because
parentage does not establish host identity or writer quiescence. It also cannot
prevent an uncooperative legacy writer from starting after the scan;
production writer exclusion remains unresolved.

The regular VS Code extension also registers the internal
`personalKnowledge.inspectNextSyncHost` command. On explicit invocation it
reads the existing target, checks its VS Code SecretStorage credential without
returning the secret, and reports observational legacy transaction,
coordinator, service-result and experimental-journal states. Observation does
not recover or acknowledge anything and is not an admission decision.
`personalKnowledge.executeNextSyncHost` always refuses cutover: neither
production writer exclusion nor a qualified production GitHub publisher is
available. Registration does not start Next or switch the Knowledge Root.

An additional Linux-only synthetic fixture command,
`personalKnowledge.runIsolatedNextSyncFixture`, is registered only with an
explicit private-fixture environment grant. The VS Code host verifies the
bundled Next payload, starts its fixed child itself, and responds to that
child's session-bound, non-replayed requests for the exact fixture credential
using `context.secrets.get`. The synthetic token is sent over the fork IPC,
not through arguments, environment, webview, or fixture logs. Child failure
does not cause automatic retry. Disposal terminates the child. This is
test-only: the hard-coded account/token and local bare-Git adapter are not a
production credential bridge or GitHub publisher.

The private normal-mode journey installs the candidate VSIX without modifying
its payload, seeds a synthetic secret under the same extension ID and profile
using a temporary old-package entry-point shim, and drives the candidate via
a separate development-extension test hook. VS Code adds installation
metadata to the manifest. The actual candidate host and its own Next child
perform bare-Git push and pull, recover a lost push response without another
push, and retain a conflict across restart without a credential read. The
positive test uses a newly initialized synthetic Next root, **not** an adopted
legacy root or a complete upgrade. A separate private test shows that the
existing guard refuses the child on an adopted synthetic root while a real
VS Code host is active. The shim is not old GitHub Sync; the tested old package
does not include that feature. The guard does not identify a trusted live host,
and its process scan has a race with later legacy writers.
Consequently direct safe production old-root host integration, general Sync
selections, legacy pending-operation recovery, conflict resolution, GitHub
compare-and-swap, Windows and unattended parity remain unqualified or missing.

The retained pre-Next Sync code has also generated a real historical baseline
and `pushed` journal on a nonempty synthetic legacy root. Offline, after
in-place adoption with no VS Code running, the bounded reconciliation above was
tested against a loopback HTTP Git protocol fixture backed by local bare Git;
a new Next process reopened the same root and Skills-only publication was
verified. This offline test supplies a synthetic credential, not a VS Code
host bridge. A separate
normal VS Code test with that same kind of legacy-generated state was refused
by the writer guard. Actual activation also created `.pkm` state that the
existing private snapshot-authority check rejects; neither protection was
bypassed. This is not a successful live-host old-root takeover.

The original Knowledge Snapshot repository is
`.pkm/state/knowledge-snapshots/repository.git`; it is local Git, not an
encrypted SecretStorage credential. Content privacy is a separate policy,
not an MCP authorization grant. The existing Next snapshot admission does not
reconcile that original repository or its pending state, and the in-place
guard rejects it with the specific unsupported path.

The original Agent Snapshot algorithms instead use code-derived local
obfuscation keys. The legacy host's `copyAgentSnapshotObfuscationKey` exposes
a disposable copy for a future native-host authority; it is neither a user
secret nor an access grant. The host must still supply the existing key
authority and authorization and enforce writer quiescence. This helper is not
wired into activation or a child process and does not enable migration,
recovery, production cutover or access to a legacy root.

`legacyKnowledgeSnapshotFixtureBridge` is an additional Linux-only offline
experiment, not a Storage adoption or an extension activation path. It requires
an explicit private fixture marker and environment binding, a private original
root, the existing writer fence and the unmodified legacy-writer scan. It
also holds the original `snapshot.lock` flock used by the old Snapshot writer.
It validates the original private Git configuration and history in a disposable
stage, then reads old tags or journals and publishes a new snapshot at the
original `.pkm/state/knowledge-snapshots` path. A pending journal supports
explicit commit or rollback; unknown changes block both. It does not import
scheduled jobs, pending previews, restores or protected Subscription snapshots.
Its native-only API is `legacyKnowledgeSnapshotFixtureBridge(root, { nonce,
operation, ... })`: `status`, `read` (`tag` and content `path`), `create`,
`recover-commit`, `recover-rollback` and `acknowledge`. A completed create keeps
its journal and result until explicit acknowledgement, so a lost response must
be reconciled before another create; this is not a general durable operation-ID
protocol. Read bytes are returned to the native
caller as base64; no HTTP, MCP, webview or VS Code command is registered.
Its bounded private fixture tests do not establish exclusion against writers
outside the test PID namespace or qualify production cutover. A crash before
journal publication can leave a private stage requiring manual inspection.

Secret Protected Broker snapshots are a distinct format. Their original
publisher and subscriber secrets use `personalKnowledge.shareBroker.<shareId>.secret`
and `personalKnowledge.subscription.<nodeId>.<shareId>.secret` in VS Code
SecretStorage. The fixture bridge neither reads nor invents those credentials;
the required production host connection and original-root encrypted snapshot
recovery are not implemented.

`inspectLegacyProtectedSnapshotFixture` is an unwired, in-memory publisher
snapshot verification primitive. It checks the original signed summary,
ciphertext, publisher identity, original scrypt/HMAC verifier, AES-GCM tag,
plaintext hash and item counts; an explicit caller-supplied authority is
checked before and after decrypting. Its disposable secret and derived buffers
are cleared and its result contains only a hash and count. The caller must
independently bind that authority to the original profile, owner, ACL and state;
the primitive itself supplies no such authorization, filesystem checks, host
bridge, original-root read/write, restart recovery or production admission.
The synthetic focused test uses actual legacy cryptographic helpers and summary
builder with an in-memory generated identity; it is not a real SecretStorage
host test. JavaScript strings and parsed plaintext objects cannot be reliably
zeroed by this primitive.

`legacySubscriptionProfileFixture(root, options)` is a separate, explicitly
enabled Linux **offline fixture** association for the original publisher's
current Secret Protected share. The fixture requires a private root, a distinct
private `profile/subscriptions` directory, a nonce/root/profile inode marker,
and `PKM_PRIVATE_SUBSCRIPTION_FIXTURE` set to the fixture parent. It verifies
the original Ed25519 public/private identity, the old signed summary and
current ciphertext, and derives the content key from a disposable secret
supplied by the caller's `LegacySubscriptionProfileAuthority`. Authority is
bound to the root, profile, source state, publisher, share, revision, ciphertext
and host epoch; it is checked again after decryption.

`associate` durably records only that binding and digests in the same fixture
Knowledge Root; it does not rewrite the profile, original ciphertext, or old
identity. `read` revalidates the original source and secret before returning a
caller-owned plaintext buffer, which the caller must clear. `recover` completes
an interrupted association only when its pending bytes match the freshly
revalidated binding. Prior ciphertext files remain in their original profile
directory and are recorded as **unverified**, not authenticated or decrypted.
Wrong/missing secrets, corrupt current content and identity mismatch fail before
creating the association or lock. The old writer scan and Next writer fence
remain in force for both root and profile. The profile scan also blocks a
detached `subscription-gateway.js` process whose `gateway-state.json` argument
belongs to that profile, even without an open file descriptor. These checks are
not proof that a legacy writer cannot start after a scan.

This is not wired to `legacy-state-import`, `Storage.open`, VS Code SecretStorage,
or production activation. Its synthetic legacy-manager test uses an in-memory
secret provider, not a real VS Code host; a separate simulated extension-host
process exercises the existing guard. It does not import subscriptions, restore
subscriber caches, update shares, establish native host permissions, or enable
production adoption. A legitimate existing profile with a running/enabled old
gateway remains outside this fixture's supported scope. The legacy fixture
itself contains a synthetic old-format signing private key in its private
`subscriptions.json`: the original manager actively writes that plaintext PEM
while constructing the fixture. The focused test requires a project-local tmpfs
fixture mount and refuses disk-backed fixtures, but tmpfs does not change the
fact that the test writes a key to a file. **Do not run this fixture where
writing even synthetic plaintext keys to files is prohibited.** The bridge
itself does not create, copy or rotate that key. The earlier tmpfs test results
do not establish compliance with that stricter constraint.

The focused association tests are skipped unless an isolated tmpfs is supplied.
One Linux invocation from the repository root is:

```sh
dir=.migration-test-work/subscription-profile-ram
mkdir -m 700 "$dir"
unshare --user --map-root-user --mount --pid --fork --mount-proc sh -c '
  mount -t tmpfs -o size=64m,mode=700 tmpfs "$1" || exit 1
  PKM_SUBSCRIPTION_TEST_RAM_ROOT="$PWD/$1" node --test next-server/tests/legacy-subscription-profile-fixture.test.mjs
  result=$?
  umount -n "$1"
  exit "$result"
' sh "$dir"
rmdir "$dir"
```

`legacy-state-import` additionally accepts an explicitly fixture-gated
`LegacyProtectedSubscriptionImport` policy. Its native callbacks supply the
publisher secret and authorize the exact source-state and current-ciphertext
hashes; neither the secret nor the original signing private key is exported to
the staged workspace. The planner verifies the original Ed25519 identity,
signed current summary, secret verifier, authenticated ciphertext and content
hash. The importer copies ciphertext bytes into its disjoint unpublished stage,
marks older revisions `unverified`, and retains the original profile unchanged.
`readImportedProtectedSubscriptionSnapshot` rechecks the source and staged
bytes and returns a caller-owned plaintext buffer, which must be cleared.

This is a **copy-import experiment**, not in-place adoption or a SecretStorage
host bridge. The original profile remains necessary for subsequent validation;
the original gateway state is pinned but not migrated, and production
signing/broker and subscriber recovery are not implemented. The fixture requires an explicit
environment binding, private inode-pinned directories and a fixture marker.
It invokes the existing Linux writer guard for both source root and profile;
the guard's later-writer race remains. Its focused test invokes the full import,
backup/restore and a fresh reader process:

```sh
unshare --user --map-root-user --mount --pid --fork --mount-proc \
  node --experimental-test-module-mocks --test next-server/tests/legacy-protected-state-import.test.mjs
```

The test uses the old crypto and summary-building functions, but supplies the
old-format state through a mocked in-memory file read, not a real VS Code
SecretStorage host or a physically written original profile. It does not write
its synthetic private key or publisher secret to a file, argv or log.
The PID namespace contains only test processes and does not establish that
external host processes would be visible or quiescent.

The gated extension command `personalKnowledge.runIsolatedProtectedSubscriptionFixture`
reads the old publisher secret from the isolated profile's VS Code SecretStorage
and sends it to a private fixture broker. The broker supplies the verified
`legacy-protected-state-vscode-child.js` payload over IPC; credentials are not
passed in arguments, environment variables, files or logs. This command is
available only with the explicit private fixture environment and does not
activate the production migration path. The native Chat activation hook keeps
its existing priority over this fixture.

`node scripts/run-protected-subscription-host-private.cjs` builds its own private
payload and runs a normal VS Code profile against an isolated D-Bus Secret
Service. The synthetic share and both ciphertext revisions are generated by
the old `SharedMarketManager`; a temporary test-only seed shim stores its secret
under the original extension ID. A separate driver invokes the actual gated
extension command across restarts. The live host is refused by the writer guard;
after the host exits, the imported copy can be read by a restarted child. The
test also checks a wrong SecretStorage value leaves source and destination
unchanged. It scans fixture files for both synthetic secrets and the synthetic
signing PEM.

The old manager's signing-key state file is simulated in memory, not persisted:
the test transfers that synthetic state only through IPC and intercepts the
child's state-file reads. This is not a real physical old profile, an
unmodified installed-package upgrade, or original-root cutover. The importer
still requires the retained source profile; historic ciphertext is not
authenticated. JavaScript strings cannot be reliably zeroed.

An additional, explicitly gated signing fixture uses the actual old-format
`subscriptions.json` generated by the legacy manager, including its synthetic
PEM in that original private profile file. It does not copy the PEM into the
import, IPC, arguments, logs, or another file. The native host obtains the
committed Next import receipt through the verified fixture child, checks the
receipt-bound source identity, public projection, ciphertext, signature and
SecretStorage verifier, and invokes the legacy manager's fixed-format Magic
Link and subscriber-proof signing methods. No arbitrary signing API or webview
key access is provided. Wrong secrets and altered imported projections fail
closed.

```sh
PKM_PRIVATE_SUBSCRIPTION_REAL_IDENTITY=1 node scripts/run-protected-subscription-host-private.cjs
```

In the private PID/network namespace, two separate VS Code host starts sign
with the same original identity. A private instance of the old gateway verifies
the proof, issues a sync ticket, and transfers the encrypted snapshot; the
fixture client checks both authenticated encryption layers, the signed summary,
and equality with the imported ciphertext. This exercises the wire protocol,
not the old subscriber's complete refresh/cache UI. The test scans for secret
material outside the one original state file. The old manager's original atomic
state-file writes are part of fixture creation; do not run this mode when even
that synthetic plaintext PEM is prohibited. It remains a gated copy-import
experiment, not production activation or in-place cutover; it does not resolve
the later-writer race or authenticate historical ciphertext.

The separately gated `PKM_PRIVATE_SUBSCRIPTION_UI_JOURNEY=1` fixture exercises
the original Subscription renderer, legacy manager and refresh client with a
synthetic self-subscription and a loopback-only old gateway. It seeds the old
configuration and revision-1 cache using the old manager, then publishes
revision 2. A private mount exposes the same original fixture profile to VS
Code; it is not a production profile. The webview uses the original renderer
with a test-only bridge, not the complete installed UI. The host checks the
receipt, original identity, secret and membership before fixture actions; the
refresh is restricted to that self-subscription and matching SecretStorage
credentials. The existing active-writer guard remains mandatory for import.

```sh
PKM_PRIVATE_SUBSCRIPTION_UI_JOURNEY=1 node scripts/run-protected-subscription-host-private.cjs
PKM_PRIVATE_SUBSCRIPTION_UI_JOURNEY=1 PKM_PRIVATE_SUBSCRIPTION_MULTI=1 node scripts/run-protected-subscription-host-private.cjs
PKM_PRIVATE_SUBSCRIPTION_UI_JOURNEY=1 PKM_PRIVATE_SUBSCRIPTION_REMOTE=1 node scripts/run-protected-subscription-host-private.cjs
PKM_PRIVATE_SUBSCRIPTION_UI_JOURNEY=1 PKM_PRIVATE_SUBSCRIPTION_REMOTE=1 PKM_PRIVATE_SUBSCRIPTION_MEMBERSHIP=1 node scripts/run-protected-subscription-host-private.cjs
```

The fixture's trusted host holds the original manager's state lock across the
authenticated client refresh and publication. A separate Next child obtains
the normal workspace writer fence and atomically appends a receipt-bound,
sanitized cache generation to SQLite. The immutable imported genesis files and
receipt remain unchanged; Next Subscription metadata and retrieval readers
resolve the latest verified generation. Duplicate exact publication is
idempotent; stale heads, rollback and differing content at the same revision
are rejected. Priority edits use the same host lock and publication path.
An interrupted SQLite transaction exposes no partial generation. No key is
copied into the generation.

The multi fixture uses two self-subscriptions with distinct credentials and
ports, different account policies, and different published revisions. Each
action binds one subscriber; unrelated membership, record and cache changes
conflict rather than being automatically published. Refresh and priority
actions admit only their respective state changes. A recognized failed refresh
can publish its offline status only when its cached bytes and other fields
remain unchanged; unrecognized errors or partial metadata changes fail closed.

The private journey exercises the original renderer and client, a local
gateway, changed cache content, Next reads, restart, duplicate/conflicting
publication, and a wrong subscriber credential. It also injects a child exit
inside the transaction and another after commit but before the reply. A host
restart re-pulls after the first interruption and replays the committed result
after the second. Isolated tampered genesis and database copies are rejected;
an actual Next backup and restore retains the refreshed view. Browser automation
attaches before opening the real out-of-process webview frame. The runner scans
for synthetic secrets and the signing PEM outside the original profile state
file. An empty old `downloads/` directory is accepted and bound to the import
plan; nonempty downloads remain blocked.
The multi journey additionally verifies both UI and Next cache contents, a
foreign subscriber change conflict, network timeout and actual account ACL
revocation (403), and explicit recovery. Old and Next readers retain the
previous cache while offline, matching legacy behavior.

The remote mode creates separate synthetic legacy publisher and subscriber
profiles with distinct signing identities, a loopback gateway, and an
account-restricted share. The historical subscriber derives a protected
transfer key using the publisher identity although the gateway uses the
subscriber identity; consequently unmodified old code fails authentication
when the identities differ. The fixture installs
`next-protected-remote-subscription-fixture.ts` on the old manager to correct
that transfer calculation without modifying the historical source or captures.
This adapter is explicitly fixture-only and is not an activated production fix.
The isolated remote journey exercises the old renderer and adapted manager,
the Next HTTP `subscription.list` client, an unauthorized signed identity,
ACL revocation and network failure, explicit retry, remote-target transaction
interruptions before and after commit, and backup/restore. Both synthetic
signing keys are checked for leakage outside their original profile files.

This is limited to synthetic self-subscriptions and the isolated remote
fixture, fixture-only activation,
and a disjoint imported workspace. It does not activate a production refresh
bridge, establish full Subscription parity or authorize real network access.
The fixture does not establish support for arbitrary remote publishers or all
network and revocation failure modes. Its private membership bridge supports
explicit invitations and removals through the legacy manager, with durable
intent, fail-closed workspace fencing and explicit recovery of interrupted
operations. It is not a production membership bridge; the private host and
adapted remote transport are fixture trust boundaries, not production
authorization. Unknown external state is not automatically replayed.
The retained old profile is still required; an interrupted pre-commit refresh
requires an explicit authenticated retry. Direct readers of the old imported
cache files still see genesis, not the database-backed current generation.
The append-only generations are not garbage-collected and are not yet qualified
for large histories. Existing in-place writer guards and their later-writer
limitation are unchanged.

The separate Linux same-root Subscription experiment can attach to the
unconfigured writable HTTP CLI only through an inherited Node IPC channel,
`PKM_EXPERIMENTAL_SUBSCRIPTION_HOST=1`, and an absolute private
`PKM_EXPERIMENTAL_SUBSCRIPTION_PROFILE`. The launcher must hold the original
profile mutation lock continuously for the IPC session. Admission and
membership changes use receipt-bound SQLite generations; `subscription.list`
and `subscription.get` read the verified head and refuse pending recovery.
Only the trusted host may report a completed authenticated pull. Unknown
network outcomes require explicit inspection and retry; they are not replayed.
The experimental transport requires an explicitly supplied network policy,
rejects redirects and does not start the old background manager.

The focused `native-subscription-host-ipc.test.mjs` exercises the real CLI,
HTTP reads and inherited IPC with two synthetic old-manager identities and an
isolated local protected gateway. This is not a normal VS Code UI journey or a
production qualification. The existing writer inventory still rejects an
active VS Code host. A separate synthetic-only coordinator can start the CLI
before the experimental VS Code host, retain the original profile lock and
present the original Subscription panel through a private loopback endpoint.
It admits membership add/remove, retrieval-priority changes, local renames,
forced Broker refresh, explicit recovery and reads; the other panel actions
remain unavailable. Changes retain the target identity, journal an exact intent
before the legacy profile writes, and publish only a validated receipt-bound
generation. Protected refresh requires the original secret from VS Code
SecretStorage; every refresh requires a completed authenticated legacy
download. Secrets never enter the journal.
An interrupted update requires an explicit matching retry; cancellation is
allowed only when the baseline is unchanged. On coordinator restart, a
matching refresh intent may remove only empty legacy materializer staging
directories, after checking the admitted cache and that no materializer is
running. The intent remains pending and no network request is replayed.
Nonempty staging, changed cache, an uninspectable process inventory or an
active materializer remain blocked and preserved for review. The private panel
can inspect the pending operation and retained target entries, open its cache
folder and explicitly recheck after the user preserves and reconciles the
files. Rechecking does not resolve the intent or contact the remote; a retry
is a separate explicit action, with a fresh baseline check.

An experimental GitHub branch refresh accepts only an existing legacy
membership bound to a VS Code GitHub Sync target and matching SecretStorage
account, or an anonymous public membership without a credential target.
Anonymous refresh disables credential helpers and prompting. Credentials are
sent only to an HTTPS `github.com` repository; user
information, non-default ports, redirects and alternate hosts are rejected,
and inherited Git, proxy and custom CA settings are not trusted. Tests route a
synthetic GitHub URL to a local TLS fixture via a test-only Git wrapper inside
an isolated network namespace. The journal binds the target, branch, exact commit
and selected content hashes, and publication validates the resulting mount.
Changed branches or caches and unknown post-mount outcomes remain pending for
review, not automatic replay. SSH and default credential-manager profiles are
not supported. Real GitHub has not been
contacted or qualified; this is restricted to a caller-created
private fixture and does not prove exclusion of future legacy writers.
The optional controller test can install a frozen focused VSIX into an isolated
profile and compare its packaged Next runtime bytes before exercising the
original panel. It uses `--disable-site-isolation-trials` for Playwright frame
access; this is not full release qualification or a production upgrade.
Broader Subscription workflows, normal host integration, future-writer
exclusion, backup/restore and unbounded-history qualification remain
outstanding. Do not use the experiment to switch a production Knowledge Root.

For the focused test, build into a disposable project-local directory with the
CLI's adjacent `compat` and `browser` files, then use an isolated Linux PID
and network namespace (with loopback enabled):

```sh
mkdir -p next-server/.migration-test-work/native-subscription
cp -a next-server/compat next-server/browser next-server/.migration-test-work/native-subscription/
npx tsc -p next-server/tsconfig.json --outDir next-server/.migration-test-work/native-subscription/dist
unshare --user --map-root-user --mount --net --pid --fork --mount-proc sh -c \
  'ip link set lo up && PKM_TEST_NEXT_DIST=next-server/.migration-test-work/native-subscription/dist node --test next-server/tests/native-subscription-host-ipc.test.mjs'
```

### Private Native Git Sync experiment

The private Sync controller can opt into `SyncNativeGitProvider` and
`LegacyGitLease`. The existing planner verifies the base, exact publication
tree and native staged apply receipt; Git performs `--force-with-lease` after
the durable `ref-pending` journal. Recovery reads the ref and never retries an
unknown push. The synthetic controller inherits its private profile's Git and
SSH environment and uses the retained legacy Git argument and SSH-command
functions.

Focused tests exercise fake SSH against a bare Git repository and a real
credential helper against a loopback TLS smart-HTTP Git server. The HTTPS test
requires a private user, mount, PID and network namespace and temporarily
mounts synthetic DNS and CA files there. Neither contacts GitHub.
The installed private panel was also exercised with each transport against its
original synthetic root, including comparison, conflicts, push/pull and a lost
push response followed by controller and Code restart. Only the HTTPS test
actually exercises a configured credential helper; SSH uses a controlled fake
transport, not a real SSH server.

This is not a production adoption path: the repository visibility authority is
specific to the isolated fixture, legacy authentication/configuration shapes
remain restricted, Git URL rewrites to another effective endpoint are refused,
and object-store/configuration race boundaries require further review. The
production writer gate remains unchanged.

The isolated native host also accepts selected public and private Skills in a
fixture verified as a private repository. It uses the original top-level privacy
classification and preserves unselected remote Skills, Notes and Prompts.
Private means a selection classification, not encryption. The experiment holds
the retained `targets-state.lock` across Sync and the workspace exclusive gate
during publication; cooperating legacy target mutations and native workspace
mutations cannot race the push. These advisory boundaries cannot exclude
uncooperative filesystem or Git configuration writers, and local apply may
already have occurred before a late change is detected. Privacy reclassification
across the historical base also requires review. SSH scp and `ssh://` URLs and HTTPS
URLs may omit `.git`; default explicit ports are accepted without rewriting the
stored URL.

This is still a bounded experiment: it refuses private publication to public
repositories, remotely private categories not already marked private locally,
unsupported asset types and other unsupported names or layouts. By default,
local removals still block. The isolated host-only `experimentalNativeTrash`
option enables a recoverable native Trash bridge for whole Skills documents
and their paired assets. It journals operations before native Trash effects,
validates identity and content, and resumes after interruption. Remote restore
is restricted to exact original Trash bytes. Original legacy Trash entries and
the original deletion journal are not yet integrated with this bridge.
The experimental host checks the retained original deletion journal before
sync and refuses any recorded Skills deletion rather than resurrecting it from
the remote. The isolated caller must exclude legacy and uncooperative writers;
the host does not hold the original deletion-journal lock.
It preserves the original journal and unrelated entries, and does not yet
publish its deletions or reconcile original Trash restores.
The isolated-only `experimentalOriginalSkillTrash` adoption option prepares a
versioned source proof under the adoption writer fence and original target lock,
before any workspace marker or Sync journal exists. The proof pins the original
IDs, timestamps, Trash metadata, deletion journal and attachment bytes in a
private SQLite sidecar, together with source inode, owner, group and mode.
Its versioned original-identity adapter preserves the independently recorded
ID timestamp and `deletedAt` from exact filestore metadata; it does not relax
the native Trash journal's existing identity rules or authorize a native restore.
The gated adoption preparation also writes an experimental
`pkm.legacy-trash-inplace-receipt/v2` in the same SQLite transaction as the
source proof. It binds the original root identity and source digest, retains
the exact journal and payload/attachment bytes, and keeps the original bucket
IDs. Existing source-only sidecars are upgraded transactionally without changing
their source row; this is not the native staged-import v1 receipt, a workspace
receipt, or evidence of completed adoption. A failed transaction rolls back the
receipt and schema change. After a killed owner, an unknown SQLite rollback
journal or unbound legacy target lock is retained and blocks automatic recovery.
`previewExperimentalOriginalSkillRestoreJournal` calculates the original
filestore's ordered JSON after-image for one prepared entry and its paired
assets; it is read-only and is not an intent, receipt or authorization to write.
The separate isolated-only `transitionExperimentalOriginalRestoreJournal`
experiment records exact original and projected journal bytes, digests, original
ID and root identity in a durable intent. Under the original journal lock and
root writer fence it atomically replaces the journal only after recording the
staged file identity; restart accepts only the pinned before-image or that
recorded after-image, and only after the locks can be acquired safely. An
abandoned original target or journal lock is retained and blocks recovery when
using the unbound lock path.
Unknown changes are retained and rejected. A crash after
the temporary file is written but before its identity is recorded requires
manual review, as do unrecognized SQLite recovery journals. This experiment
does **not** move the Trash payload or assets, update adoption receipts, or
complete a restore. It is not connected to adoption, Sync or production use.
An independent isolated bound-lock experiment prepares a nonce and process
domain before acquiring the original journal lock, then records its exact
directory and owner-file identity. Its trusted caller must durably pin the
intent digest before acquisition and synchronously persist the effect digest
before work begins. Recovery checks both pinned digests, the original source,
root, workspace marker, operation and attempt, PID namespace and boot ID, and
requires the recorded owner to have exited. Unbound, changed, live or
unrecognized locks are preserved and rejected. The journal-only transition can
optionally use this lock: its trusted caller must also synchronously persist the
transition digest before staging and the effect digest before replacement.
Recovery verifies the exact original journal and, where a transition exists,
its anchored intent; with both pointers it verifies the pinned staged or installed
after-image for the same operation. An unanchored temporary file remains blocked. The fixture pointer
used by tests is not a trusted production startup pointer. A retry must supply
the previously anchored transition and effect digests; existing self-hashed
sidecars alone are not resume authority. This interface is
not yet wired to a trusted startup pointer, workspace lease, restore, or
adoption/Sync gate.
The Linux writer fence also provides a same-root no-replace move primitive for
future restore transactions. The move helper inherits the fence keepalive so a
killed caller cannot release the kernel lock while that helper is still moving.
Callers must still validate path identities and journal every effect; the
primitive alone does not provide restore or receipt recovery.
The source-proof preparation rechecks original members before commit; it does not exclude uncooperative
writers. Unknown layouts block without rewriting the old Trash or journal.
This option currently stops after preparation: it does not write an adoption
marker or receipt, activate a workspace, or enable Sync. The separately tested
`admitExperimentalInPlaceSkillTrash` can subsequently bind the same unchanged
proof to a matching workspace marker and Sync journal using a separate durable
binding database; the source-proof database is not modified by binding. Tests
use a synthetic marker and Sync journal, not a completed adoption. This binding
is not yet connected to actual adoption, Sync apply, restore or installed UI and
is not a production path. In particular,
unrecognized SQLite recovery journals block rather than being removed, so
recovery during an arbitrary internal SQLite commit is not yet qualified.
Admission currently supports document Skills with portable names and owned
regular files/directories not writable by other users; other original layouts
or permissions are preserved and rejected, not changed.
Synthetic bare-Git tests cover native deletion, restoration, an explicitly
reviewed concurrent edit, divergent restore refusal, lost push-response
reconciliation without replay, and SIGKILL recovery across native Trash and
bridge journal boundaries. A separate isolated installed UI run of source
`16a7a3706bebd5bae4e4109e76a2fc05e7d9ce99d52450bc9b30d6e06a350139`
and VSIX `1d7580e96c7f69aa145d027dd4760d109e35615c694bd1d705d6f64ad338f446`
used fake SSH and bare Git to pull a remote deletion into native Trash, restart
Code and the controller, and pull an exact-byte restore via the UI. It is not
an original Trash interoperability, uncooperative-writer, power-loss, or
production qualification.
An isolated installed UI run with source
`6ef7c7eead0a01726135f2de8ef469e8cb7715dbf228fd98250dd97eea62b826` and VSIX
`570696774b4908ff3268acc7898492e6f1461c91589e3237e09be80658bb2146`
confirmed that a synthetic pending journal is blocked without changing Skills,
assets, Notes, Prompts or the Git ref. It is not a deletion/restore sync test.
An explicit Skills mount can adopt a supported unmanifested `Skills/` tree,
preserving outside paths, and synchronize owned Markdown assets. The optional
native Git API visibility check reuses the authenticated GitHub transport;
private publication using it requires a host-provided visibility fence spanning
publication. The tests use a controlled mock, not real GitHub, and no production
visibility fence has been established. The existing synthetic Git fixture's
repository-visibility authority proves only its controlled local fixture. An
isolated installed UI test of source `62af839f473b9f4ab9a365a4db358b3d91b4ae8c39839e4fcd36a7d443b5ab41`
and VSIX `9fe2a2f006cfc4d292b24a311adc6d92d15c1ceeedb32a3c4c20b4f2e8056799`
exercised both selected public and already-classified private Skills over fake
SSH and loopback HTTPS/helper, including push, pull and lost-response restart.
With the same product VSIX, separate installed driver runs changed the target
after commit creation and raced the branch at receive-pack; both stopped and
restarted into review without a repeated push. These tests did not qualify
real GitHub or the unsupported cases above.

The separate frozen source `3ea3281b6842bd48df692873b47c90e45d1db338f35919b61d439eb478993462`
and VSIX `529ad71db13b611e372d64f2f55a78395ff4bc97480db48059f177c6d575744b`
also passed isolated installed panel tests for an initially unmanifested
`Skills/` mount with owned PNG, selected public/private Skills, push, pull and
lost-response restart over fake SSH and loopback HTTPS. Separate SSH runs
exercised target-configuration and branch races. This does not qualify Trash,
arbitrary legacy layouts, external GitHub visibility fencing or production use.

The Linux retrieval owner protocol is a private experiment, enabled in the
extension host only with `PKM_EXPERIMENTAL_RETRIEVAL_OWNER_PROTOCOL=1`. The
normal activation does not automatically shut down the profile-shared worker.
The host receipts do not cover the separate MCP process: its
`_retrieval_request` reads `worker.json` directly and can use the worker after
a VS Code window exits. Original clients and idle or restarted MCP consumers
therefore still need a proven admission and lifetime handoff before final-owner
shutdown can be enabled by default.

Ordinary Linux managers now close their local retrieval admission before
deactivation waits and share concurrent close requests; they do not stop the
shared worker. A bound managed profile's drain waits for its own admitted
retrieval calls and can complete its own profile receipt; this does not prove
that worker background jobs or unregistered clients have drained. When an
already provisioned managed-writer session exists, normal Linux activation
enrolls and records its profile before initializing the ordinary host, and
refuses enrollment after the fence. Both extension creation paths record
each top-level retrieval request against its captured root. After the session
fence, a new bound request or an unenrolled process is rejected; an already
admitted request may finish, and a failed request remains pending. With no
session, ordinary retrieval does not create session files and an unmanaged
root switch remains available. A root change involving a managed session is
rejected until reload rather than reusing the wrong session binding. A request begun
before session creation, old clients, external writers and worker background
jobs remain outside this evidence. Next's session inspector validates completed
request records and explicitly reports worker drain as unknown; actual in-place
adoption still rejects that unknown worker state. Default automatic session
creation is not enabled: provisioning while already-running or independently
launched clients lack a binding can disrupt existing MCP workflows. No Next
cutover is enabled.

Ordinary host enrollment into an existing session now records the profile under
the same cross-process lock that checks the fence. An isolated bootstrap
primitive also atomically publishes a new session and enrolls its first host;
it is not wired to default activation. For new bootstrap locks with a verified
same-boot, same-PID-namespace process identity, a later caller can serialize
recovery of a dead initializer, preserve its lock and staging in a private
`managed-writer-session-recovery` archive, and retry initialization. Crash
tests cover the lock link, session publication, concurrent retries and a second
crash during recovery. Incomplete operation records, old locks without that
identity, ambiguous state and unverifiable owners remain untouched. The
preserved archive is not yet an authorized Next adoption receipt. A newly
generated current managed MCP launcher
without an inherited session can now atomically join an accepting session
before serving; a fenced session still refuses a new participating launch.
The existing released launcher and already-running original MCP processes
cannot be retroactively enrolled by this change. In an isolated test two real
4.0.22 MCP processes continued writing after session creation; an original
process also wrote after SIGKILL and restart without registering. The wrapper
was tested separately around actual FastMCP, including quiesce/EOF and crash
followed by restart: the crashed launch remained pending. This is neither a
production provider upgrade nor ownership of existing clients; default session
creation therefore remains disabled and preexisting writers remain unknown.

An isolated compatibility bootstrap can instead create
`.pkm/state/managed-writer-session-compatible`. Earlier unbound launchers that
only recognize the old session path continue their original behavior; current
launchers recognize either path and join the compatible session before serving.
Both paths present together are rejected. A test ran the actual 4.0.22 server
through a frozen previous launcher and the current launcher: the previous one
continued unregistered, while the current one registered and drained. This is
not retroactive enrollment or proof that a bound old helper can use the new
session. The compatible path has no Next receipt; Next explicitly rejects it,
including when it appears after a plan was prepared. This bootstrap is not
wired to ordinary activation.

For an already-running original MCP whose actual SDK stdio transport is held by
the caller, an explicit cooperative adapter can notify and request approval,
register that particular instance in an accepting session, invoke its existing
lifecycle quiesce, wait for its in-flight calls, and close only that transport.
Completion requires the caller's verified owned-process-tree exit; a crash or
failed verification leaves its registration pending. A private test used real
4.0.22 MCP clients: one held Note write completed before approved retirement,
another unregistered client kept writing, an original client crashed and
reconnected, and a newly generated successor joined the session and read the
Note. A separate in-flight crash remained pending. This does not claim ownership
of a VS Code provider's existing connection, automatic approval or a root-wide
drain; it does not scan or stop unrelated processes.

An incarnation-scoped provider owner can manage a brokered legacy connection:
retirement requires that exact owner's ID and verified child-tree drain, and
replacement creates a fresh ID. A late retirement using the prior ID is rejected
before approval or dispatch and cannot stop the replacement. An isolated real
4.0.22 MCP test exercised an in-flight Note, a replacement, a stale retirement,
and an independently connected original client. This owns only connections
started through its broker; it cannot seize a previously running VS Code
provider or authorize root cutover. It is not yet wired to ordinary activation.

A private Code 1.143.0 journey additionally registered a fixture-owned brokered
provider beside the real original 4.0.22 provider. The test approved an actual
Note write and retirement in the UI, observed one in-flight write during drain,
then started a replacement. A stale owner ID was rejected while both the
replacement and the independent original provider retained their instance
identities and remained accepting. The private 4.0.22 root and installation
were then upgraded to overlay 4.0.839, and native Note read/write succeeded
after upgrade and restart with the old client and worker still available.
The session bootstrap was explicit, not automatic. The fixture provider used
the old 4.0.22 MCP backend, not Next, and did not take ownership of the
already-running original provider. The overlay
`3d68ca011774d6ef55618b001ab06012b8cad1e0e28efc219e916545c24e0268`
is a private experimental package with an older Next payload, not a release
or an adoption candidate.

The successful run was:

```bash
set -o pipefail
TMPDIR="$PWD/.migration-test-work/root-upgrade-validation" TMP="$PWD/.migration-test-work/root-upgrade-validation" TEMP="$PWD/.migration-test-work/root-upgrade-validation" node .migration-test-work/root-upgrade-validation/native-provider-exact-journey.cjs 2>&1 | tee .migration-test-work/root-upgrade-validation/native-provider-exact-run-3.log
```

Its log and fixture
`native-legacy-activation-430e630a-3210-45b1-a7df-7013d18e07c9` preserve
the approvals, identities and cleanup (166 captured, none remaining; a
separate accessible host-process check found no matching fixture). Two earlier
failed attempts are preserved: VS Code exposed the second server's tools under
`mcp_pkm2`, not the assumed label-derived prefix. The driver was corrected
to discover the unique second tool; neither failure counts as a pass. These
isolated results do not enable default bootstrap, automatic provider replacement
or Next cutover.

Another isolated Code run approved quiescence of the actual original provider,
closed the old window naturally without a stop-by-definition command, and
committed the existing experimental adoption on the same root after the host
exited. The first attempt to start a Next provider in the reopened window
failed: the unchanged writer check classified that new Code host as an
unverified legacy host. It did not perform a Next read or write. The failed
fixture `natural-next-c5992ad0-ffb4-48bf-818a-6adf2d820837`, its
`natural-exit-next-run-2.log`, and cleanup are retained.

An independent private PID-namespace test subsequently started the actual
Next MCP owner on an experimentally adopted copy of a 4.0.22 root *before*
starting a simulated extension host. It then read an old Note, wrote and read
another Note through its owned stdio bridge, and drained the exact child. The
existing scanner still classified the simulated host as a blocker; its policy
was not changed. `isolated-adopt-prelaunch-run-3.log` records the command
`TMPDIR="$PWD/.migration-test-work/root-upgrade-validation" node .migration-test-work/root-upgrade-validation/isolated-adopt-prelaunch.cjs`
and the retained fixture `legacy-owned-broker-0de809f8-9e24-4efb-9583-b295ce199457`.
The original and replacement connections were controlled fixture clients, not
the VS Code-owned legacy connection; the host was simulated and the snapshot
authority was synthetic.

For this explicit experiment only, a Next stdio process can report a
caller-supplied 64-hex nonce on its inherited descriptor 3 after its Storage
and MCP server have started. An invalid nonce, missing descriptor, or failed
startup produces no readiness receipt and closes acquired resources. The nonce
is a process-start synchronization signal, not a root grant, ownership proof,
writer-drain receipt, cross-profile owner or production cutover authority.
The host-side `createPrelaunchedNextMcpBroker` starts that process before
providing a single authenticated VS Code bridge, binds admission to the
caller's checked authority and requires its descendant-exit verifier for
drain. A repeat on an experimentally adopted original-root copy used that
source broker (`isolated-adopt-prelaunch-run-7.log`, fixture
`legacy-owned-broker-8075bad4-afbb-408a-b21f-8699fbde41af`); reopening while
the simulated host remained alive was rejected by the unchanged scanner, while
restarting the owner after that host exited reopened the Note. The experimental legacy
owner can also seal a verified stopped incarnation to reject any subsequent
restart; stale IDs cannot seal a successor. These facilities are not wired into
ordinary activation and do not transfer an existing VS Code connection.

`isolated-adopt-prelaunch-run-9.log` additionally records a real independent
4.0.22 MCP client remaining accepting while experimental adoption was rejected
with `LEGACY_WRITERS_ACTIVE`. Only after that client voluntarily drained and
exited did the isolated adoption and prelaunch/restart probe pass. This does
not establish control over other clients or qualify the production cutover.

The private Code continuation succeeded with an isolated 4.0.22 installation
and root copy: the actual original provider was voluntarily drained, its
window exited naturally, and experimental adoption committed on that same
path. A Next owner was started before reopening Code; a fixture provider then
read the old Note and wrote it. After draining the owner and closing Code,
both were restarted and the Note was read and updated again. The run used the
same private profile, disabled the legacy extension during Next, and used a
synthetic snapshot authority and private experimental overlay. It is not
ordinary activation, a production cutover, or a cross-host authorization.

```bash
set -o pipefail
TMPDIR="$PWD/.migration-test-work/root-upgrade-validation" TMP="$PWD/.migration-test-work/root-upgrade-validation" TEMP="$PWD/.migration-test-work/root-upgrade-validation" node .migration-test-work/root-upgrade-validation/natural-exit-next-journey.mjs 2>&1 | tee .migration-test-work/root-upgrade-validation/natural-exit-next-run-5.log
```

Fixture `natural-next-7b361182-41f2-4d6b-b5e9-5b92889bd800` retained the
results and cleanup (65 captured, none remaining). The accessible host process
check found no matching argv/cwd for this and the two failed fixtures
`natural-next-c0564a50-6ec5-459e-9aca-c44643113fcd` and
`natural-next-6fd05c20-3f9c-40b2-ae72-71742b223b23` (211 readable, 599
partially unreadable, zero races; not a system-wide exclusion). Run 3 timed
out before the Next driver; run 4 captured the cause: the fixture passed
`ELECTRON_RUN_AS_NODE` to Code itself, so Code tried to load the workspace as
a Node module. Run 5 passed only the bridge tokens to Code; the bridge still
receives its required environment separately. Failed evidence is retained.

The experimental unified owner now also has a host-session lifecycle contract.
An embedding must independently authenticate the host and authorize its exact
root, profile and each resource scope; the session key and parent PID are not
authorization. Revoking a scope stops its admission, signals its children and
waits for their drains without revoking unrelated scopes. Host disconnect or
owner close drains all scopes. An unconfirmed drain keeps the owner's Storage
lease and can be retried. The optional parent adapter binds to an inherited
direct-fork IPC channel and checks the parent's PID and Linux start time; its
scope-revoke reply follows drain, and a missing reply is not a completion
receipt. These mechanisms do not start an adopted owner in ordinary
activation, authenticate other hosts, or establish effect-level authorization.

`owner-host-sessions-run-8.log` records a private PID-namespace test against a
real adopted 4.0.22 root: a real MCP SDK socket read, independent scopes and
two host sessions, a delayed drain with no early acknowledgement over direct
parent IPC, and parent disconnect retaining the root lease until the admitted
child finished. Its profile and scope issuer was synthetic. `owner-host-sessions-run-14.log` also
used the source parent-side controller: matching drain acknowledgements were
accepted, while a disconnect with an outstanding revoke remained unknown.
It additionally killed only its own forked parent and observed owner admission
close and the root lease remain held until the child drained, even when a
fixture-owned descendant retained the IPC handle. Parent PID/start-time
monitoring revoked the session while that handle was still connected.
`owner-parent-control-regression-v5.log` covers mismatched sessions, stale
acknowledgements and changed parent authority. These are not Code
installation tests or production cutover qualifications.

For one direct child, a trusted embedding can issue one in-process
`createOwnerParentScopeControl` handle per scope from its existing
`createOwnerParentControl`. `assertOwnerParentScopeControl` verifies the
unforgeable local object and exact child, session and scope binding. Each
handle can only request its own scope's revocation; it cannot dispose the
shared controller. Its read-only `signal` aborts synchronously when that scope
starts revoking, or when the shared control is lost. Once revoke starts, even
a timeout permanently invalidates the handle for active-scope assertions,
while a revoke retry remains possible.
The parent must keep its global authority fence separate from a revocable
scope fence and retain the controller until all scope drains are confirmed.
`shared-parent-scope/final-tests.log` records four source-level real-fork
tests, including independent Chat/Environment revocations, immediate
invalidation, reentrant revoke rejection and unknown/retry. These
handles grant no user authority and do not authenticate another host or prove
physical effect drain.

```bash
./node_modules/.bin/tsc -p next-server/tsconfig.json --outDir next-server/.migration-owner-session-dist --pretty false
./node_modules/.bin/tsc --ignoreConfig --target es2022 --module node16 --moduleResolution node16 --types node --skipLibCheck --strict --outDir .migration-test-work/root-upgrade-validation/parent-control-build src/runtime/owner-parent-control.ts --pretty false
TMPDIR="$PWD/.migration-test-work/root-upgrade-validation" TMP="$PWD/.migration-test-work/root-upgrade-validation" TEMP="$PWD/.migration-test-work/root-upgrade-validation" PKM_TEST_NEXT_SERVER_DIST="$PWD/next-server/.migration-owner-session-dist" PKM_TEST_PARENT_CONTROL_DIST="$PWD/.migration-test-work/root-upgrade-validation/parent-control-build" PKM_TEST_LEGACY_CHAT_EXTENSION="$PWD/.migration-test-work/selected-code-e160bd37-9c36-4310-9e0f-b1813ddc9317/extensions/uone.personal-knowledge-4.0.22" unshare -Urpf --mount-proc node --test tests/test-owner-host-sessions.mjs
```

Ordinary activation still requires a real profile/root/scope authorization
issuer, a single owner launch and reconnection protocol, qualified handoff of
the existing legacy writers, effect-aware recovery, and coverage of the old
workflows. In particular, starting the owner from a live Code host is still
rejected by the unchanged legacy-writer inventory. No receipt, socket token,
process identity or test-injected callback alone supplies those missing
qualifications; the production gate remains closed.

A separate private installed journey used Code 1.143.0, an isolated copy of a
4.0.22 root and package, and experimental overlay 4.0.839
(`7a0e2fafa24122ab1520d88b762627095bbd0e279df8f9f4d2952283f0863abf`).
After an original unregistered MCP was already running, the test explicitly
called `bootstrapManagedProfile`, installed the overlay, and opened two
ordinary hosts. The original client and 4.0.22 retrieval worker continued
working across installation, window closure and restart. A native MCP created
and updated Notes after the test clicked the actual approval dialogs; the old
client read them, retained synthetic files and Git ancestry were checked, and
the old client voluntarily quiesced and exited before an explicitly started
successor read a Note. The controller used
`node .migration-test-work/root-upgrade-validation/native-cooperative-session-v3.cjs`;
its log and fixture `native-legacy-activation-28cebefd-9729-452a-a257-a4ca21cb92ed`
retain the evidence and exact-process cleanup. This manually bootstrapped,
driver-controlled journey does not exercise the owned SDK adapter against the
VS Code provider's connection, automatic session creation, crash recovery or
Next adoption. It is not a production upgrade or a root-wide drain.

A subsequent private run with overlay
`9bf3673465fddeb07c8d0b82f58a831240fb82d542bb2fe3264e459ee895bb9b`
(`node .migration-test-work/root-upgrade-validation/native-cooperative-session-v4.cjs`)
SIGKILLed its explicit bootstrap before publication and recovered it while two
original 4.0.22 clients were connected. An original Note write was observed
in flight while the candidate installation ran and subsequently completed.
After upgrade and restart, one old client voluntarily drained a further
in-flight write and exited; the other remained accepting and wrote a Note,
then a newly started client read a Note. The private fixture and exact cleanup
are recorded under `native-legacy-activation-b88b9802-d4c1-47cd-af93-33606a6e2083`.
This was still manually bootstrapped; the controlled old clients were not the
VS Code provider's already-running connection, and the archive does not
authorize Next adoption.

For ordinary Linux managers, local quiescence additionally verifies that each
successfully submitted index/update revision from this manager reached the
same still-identical worker, with no build in progress. It does not kill the
worker. A timeout, changed worker identity, lost submission response or build
failure remains unknown. A managed request now durably records a separate
pending build before dispatch, with hashes of its revision and worker identity.
Only the originating manager can complete it after observing the same worker's
finished revision. A crash, lost response or changed worker leaves the pending
record for explicit recovery; restarting a host does not replay or complete it.
These records do not prove other clients, solution rebuilds, requests started
before enrollment, or full worker drain. Next validates the records but still
rejects worker-drain unknown.

`automatic-managed-retrieval-multiprocess-v3.log` records a source-build test
in a private PID/network namespace, not installed Code: two real host
processes enrolled in the existing session and shared a Python worker; a
fixture-held status return completed after the fence while the other host's new
status was refused, both profile drains completed, and the worker remained
alive. A deliberately dropped real status response and SIGKILL of another
host with a fixture-held request each left an unknown outcome and rejected
handoff without killing the shared worker. The fixture controls the timing and
does not prove a natural in-flight drain. A separate actual Next adoption test
(`managed-retrieval-next-adoption-guard-v2.log`) confirmed that the unknown
worker state prevents preparation even though inspection accepts the records.
`retrieval-atomic-bootstrap-build-drain-final.log` additionally exercised
concurrent isolated bootstrap and a real 12,000-item build completing before
the registered local handoff; a killed fixture worker left its build unknown.
It also exposed a race where a fence rejected a request before dispatch while
local drain was observing it; the final run distinguishes that provable
pre-dispatch refusal from an unknown post-dispatch failure. Neither test
represents installed Code.

In an isolated PID/network namespace, two independent Node host processes
shared one experimental worker; the first close left the other usable, and
the last close waited for a 12,000-document in-flight build before the worker
exited. Host and worker crashes followed by restart remained unknown; invalid
proof, mismatched host identity, and shutdown while owners remained were
rejected. Evidence: `retrieval-managed-hosts-test-v2.log` under
`.migration-test-work/root-upgrade-validation`. The crash fixture workers were
retained until their private namespace exited. The same test also passed using
the exact experimental VSIX `7a45d2094d4e127396158e11b959c274adacfb47c6e78006547be0dfd3bb3966`
(`retrieval-managed-hosts-test-v3-frozen.log`). Its Next payload and 566 build
fingerprints verified, and four isolated SIGKILL rollback checkpoints passed
(`root-fence-same-vsix-crash-v9.log`). The original 4.0.22 manager refused
the newer experimental worker without killing it both before and during drain
(`retrieval-managed-hosts-test-v5-frozen-legacy-drain.log`). A single private
Code profile also passed the 4.0.22 → v9 → restart Note/Git journey with the
experimental owner opt-in and no fixture shutdown; both v9 stages produced
completed host and runtime receipts and exited naturally
(`root-fence-natural-installed-v9-experimental.log`). The exact owned fixture
cleanup was empty; an initial scanner false-positive on its own shell was
preserved alongside the corrected scan. These are not a two-window Code test,
a default-path qualification, or permission to migrate the old root.

The private owner experiment now also admits each generated MCP stdio process,
including an idle process, in the same cross-process-locked receipt registry.
Normal stdio EOF completes only after the managed MCP call drain and the
authenticated worker close; SIGKILL leaves its receipt unknown. A drain
marker serializes last-owner shutdown with new MCP admission. An original
unmanaged worker is preserved rather than automatically replaced. The source
notice asks users to review existing clients and explains that a separate
profile alone does not isolate a shared Knowledge Root. The precisely
fingerprinted original 4.0.22 worker additionally
supports read-only search of its existing, potentially stale index; new index,
model and feedback writes are refused rather than sent to that shared worker.
Other unverified legacy builds remain blocked without terminating them. The
experiment remains opt-in: old generated MCP processes
cannot join the new registry, so enabling final-owner shutdown by default
would still be unsafe.

`retrieval-mcp-stdio-v12-frozen-original.log` records a real generated MCP stdio server
from experimental VSIX `c6ff56c15fccf52f8ea84767e5697154b44f97cf80322a28fb4a7d50731f67d1` with
two independent Node host processes: both hosts exited as shared during an
admitted MCP search held in flight by a fixture-owned SQLite lock; after the
lock was released, the search and a later retrieval-status call succeeded,
and MCP EOF drained the worker. A separate MCP SIGKILL/reconnect case
preserved the worker and the unknown old admission.
An actual stdio server generated from the original 4.0.22 VSIX searched its own
original worker before and after the candidate read the same index; candidate
index writes were rejected and neither client stopped the worker.
`retrieval-mcp-owner-offline-v6-frozen.log` covers a separate Python owner, a
12,000-document in-flight build, and read-only search against the original
4.0.22 worker while blocking candidate index writes.
These fixtures are not real VS Code windows, the native VS Code MCP provider,
or qualification of unregistered legacy ownership for automatic shutdown.

The same frozen VSIX was separately installed in two real private Code
windows with distinct user-data profiles sharing one globalStorage directory.
A separately launched managed MCP stdio process kept a real search in flight
while both windows closed; the search then completed, and MCP EOF drained the
last worker naturally. A second run restarted both windows and SIGKILLed the
MCP process: a reconnected MCP still read successfully, the old owner remained
unknown, and the worker was preserved until exact fixture cleanup. This latter
case is not a natural-drain result. See `retrieval-mcp-two-code-v13*.log`.
These runs do not establish native provider transport behavior, a single
complete profile, unregistered legacy MCP coverage, or the default gate.
The same VSIX passed four separate rollback SIGKILL checkpoints
(`root-fence-same-vsix-crash-v13.log`). It was subsequently installed over
the original 4.0.22 in a private root-copy journey
(`root-fence-natural-installed-v13-experimental.log`): original, upgraded and
restarted windows each created a Note and made the expected Git commit; the
two candidate phases also drained an in-flight Git operation. The original
commit remained an ancestor and all seven pre-upgrade content/config files
remained byte-identical; the two copied legacy project-state files also
matched the source copy after restart. Git internals, generated MCP files and
other mutable `.pkm/state` were excluded from that content inventory. This
small fixture does not establish inheritance for arbitrary production roots.

`same-profile-native-v13-v10.log` exercised the same VSIX with two real Code
windows using the same private user-data directory, two distinct extension
hosts, a real VS Code native provider process, and an independent MCP client.
In both the initial run and a restart, the independent client's Note update
was held in flight by a fixture FIFO while one window exited; it completed
after release and was read through the native provider. A separate independent
retrieval read was held by a fixture SQLite lock across the last window exit,
then completed; independent MCP EOF naturally stopped the final worker. The
restart also read the first run's Note. The FIFO is a synthetic pre-write
gate, not evidence that an ordinary Note write naturally blocks there. Native
provider *mutation* remained unverified: attempts did not reach a verified
in-flight MCP call, and the failed logs and UI observations were retained.
The tests do not establish coverage of unregistered legacy MCP processes; the
private opt-in remains unsuitable for automatic production takeover.

An additional frozen-v13 stdio check
(`retrieval-mcp-ordinary-v13-v2.log`) used an ordinary manager with no
experimental owner: the actual original 4.0.22 MCP kept using its original
worker, while the candidate read the verified old index, emitted the
compatibility notice and rejected a new index write. This is a focused
manager/stdio test, not proof of ordinary VS Code activation.

For an unregistered old client, a safe handoff is per connection, not a
process sweep: explicitly ask the user to finish or voluntarily quiesce the
client they control, wait for that exact client's in-flight work to drain and
its transport to close, and let the user reconnect it. Missing ownership,
an unexpected exit or unaccounted clients remain unknown; do not kill their
worker, replay writes, replace the root, or interpret an idle timeout as
consent. A known client's clean exit alone cannot establish that no other old
clients may start or write.
