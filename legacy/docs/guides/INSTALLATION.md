# Installation Guide

Start with the [README quick start](../../README.md#get-started) and the [complete installation guide](../../FEATURES.md#installation-guide).

VS Code Marketplace tabs are platform-defined; extension manifests cannot add a custom Installation Guide tab. This file provides a stable direct link for release notes, support responses, and repository navigation.

Follow the complete guide:

1. Install the extension.
2. Choose or recover the Knowledge Root.
3. Open Config → General Setting → **Create your first Note**, save it and reopen it. Basic Notes and Skills do not require Python or MCP.
4. Optionally choose Python 3.10+ in Config → MCP → **Validate & Save**. PKM automatically creates the isolated runtime, installs dependencies, generates the server and verifies runtime health. Follow the retained phase/output display; **Later** and **Resume Python guide** do not mark unfinished setup complete. Missing Python, dependency failures and shared-runtime action-required states each expose an appropriate next action. For Remote SSH, install/select Python on the remote host. The project interpreter is not the PKM base Python.
5. For VS Code native chat, use the account-level native provider and start `pkm` through **MCP: List Servers**. Do not add another VS Code user/workspace registration for the same server. Copilot CLI / SDK sessions that do not inherit VS Code MCP definitions need the separate user-level registration below.
6. Call `check_version` through the actual agent tool surface, then verify discovery and a real call in a second workspace on the same target/account.

For clients without native provider support, use an explicit user-level adapter for that client. Do not register the same server twice within one client. Review and back up legacy registrations before removing only the matching PKM entries; preserve unrelated servers.

## Linux: opt in this profile's Collaboration

**PKM: Upgrade This Profile's Collaboration** recovers this profile's hosted
Room archives, original Meeting state and exact existing Meeting Note bytes
from its configured Knowledge Root. The original Host credential must still
exist in this same profile's SecretStorage; an invitation/join secret alone
cannot recover Host authority.

Retain an independent backup and stop other writers/windows using these
archives first. Review the confirmation: this window's old Hub stops normally,
then recovery uses a **separate private Collaboration workspace** under the
extension's profile storage. Choose **Reload Window** when recovery is ready.
Ordinary Host/Stored Room and Meeting actions then use its persistent Next
owner. **Later** leaves this window's old Room writer blocked until reload.
Use **PKM: Collaboration Storage Status** to inspect the selected route.

This is not a switch of the Knowledge Root or a default/full PKM migration.
Profiles that do not opt in retain the old route. Other Notes and PKM workflows
still use their existing root. Original source archives and manual Meeting
Notes are retained; later edits to those retained archives need reconciliation,
not automatic overwrite or continuous synchronization. The recovered owned
Meeting Note is available through the existing read-only Meeting Note view.
Portal tools/Chat policy and Project state retain the original PKM context;
the separate Collaboration owner admits operations. New Project-bound Rooms
verify the original Project/thread; strict mode additionally checks existing
Room bindings before hosting. Default compatibility keeps original Host
authority even if an old Project link is missing. This is not a migration of
those tools or Project files.
Retained-archive deletion remains unavailable. If recovery is refused,
preserve its partial private workspace.
If a saved selection cannot reopen, its Room route blocks instead of silently
opening an old writer; do not delete the selection or either copy to bypass it.

Configured `chatHubUrl` is only a network hint. Owner discovery additionally
requires the original Host's signed proof and matching Room lineage;
`chatHubPort` and `externalLinkHost`/`chatInviteHost` remain the listening and
advertisement configuration, not new authority. Traffic remains **plaintext
ws/HTTP**, including attachments; a hostname does not provide TLS. Compatibility
defaults to the original shared-secret/client-ID reconnect interaction and
retains its impersonation risk. Explicitly enable
`personalKnowledge.nextCollaborationStrict` and reload to require Host approval
on **every** unmodified old-client identity recovery, including network retries,
plus a separately labelled one-operation Portal owner approval. Saved pairing,
receiving permissions, Chat policy and file-batch approval still apply.
A missing remote owner response does not prove that owner released a Room.
The verified private v11 package admits transcript-only cross-root Rooms, not
retained canonical Meeting archives or full Meeting/Note/file transfer, and
refuses that transfer instead of releasing the Host. The continuation source
adds an explicitly composed version-2 checkpoint for canonical state, original
canonical/Note inventory text, manual Notes and complete attachment bytes,
installed together in Core without rewriting either root's retained files.
Missing historical payload bytes still refuse; receipt-bound local edits do
not create a replacement checkpoint. This source has passed native network and
byte-preservation tests, **not** a new complete installed Room/Project UI journey.
Later source keeps the original Force Close transcript-only and exposes a
separate **Take over full assets…** confirmation. Selected Core Notes have
reviewed-SHA/Host-authority guarded saves; **Recover saved file…** admits missing
original file IDs only after an explicit saved-file selection and owner
attestation (old metadata has no digest, so size alone proves no historical
byte identity). The four focused source/network/provider suites now pass 31/31,
including explicit full receiver Host-identity succession and a new local-runtime
restart. Default/v1 Host admission is unchanged; strict old-client recovery
still requires approval every time. Private 841–844 installed attempts failed
before the first Host button because the Python CDP panel probe found no iframe.
New 845 includes succession/frame diagnostics. A project-private Python 1.64.1
adapter fixes the observed missing-frame attach; v7 actually clicked Host Room,
then failed at old Join name/UUID routing. Independent 848 corrects that form
input and a fresh full-only schema guard. Actual Room/Project/editor and full-asset
crash/restart renderer qualification remains missing. This does not
promote v11, other agents' overlays, or production migration qualification.
Further strict source tests separate Host-role proof from every unmodified
old-client identity approval only in verified full-succession Rooms. Private
850 contains that correction and a name/endpoint/Host-presence observer for
the original client's missing Manager UUID; 850 itself was never installed.
Private 851's original 4.0.22 UI passed basic Host/Guest Room actions and rehost
with the same new Room's Guest PID, then failed at the real New Project modal
because its original HTML has no `dialog` role. The offline actor now uses
the actual modal ID/title; that correction is not installed-qualified.
This run never reached Next strict approval, Project/Note/file or full
crash/resume/process-restart identity qualification. Its six own cleanup
entries were empty; exact own-fixture scan and the subsequent formal Chat/SDK
window handoff are retained in the Collaboration evidence.
Private 852 then passed the modal fix and actual Project/Thread creation but
failed their Open chatroom association: its actual numeric-leading Room UUID
is rejected by the retained exact 4.0.22 model. Current source already fixes
that validation. The next offline actor retains every rejected Thread/Room and
allows only this exact original defect a bounded new-Thread real-UI retry.
852 still did not reach Next identity/restart/Note/file/full/revocation
qualification; its failed fixture and six empty own cleanup groups are retained.
853 subsequently captured the real numeric-UUID error and retained its orphan,
but its retry Thread names collided after original 80-character Room-name
normalization discarded their differing suffixes. That driver naming defect
is fixed offline with leading attempt prefixes; the exact original normalizer
reproduces it, and focused cases fail 2/4 on frozen853 versus pass 4/4 after
the fix. The same run was not restarted, and no new installed qualification
is implied. Its six own cleanup groups are empty; Root is queued for the next
formally handed-off private window.
854 subsequently passed the original Project/Thread's actual Room association,
then failed opening the primary card because its closed Shadow DOM toggle is
named **Show Room actions**, not the actor's exact **Room actions**. The offline
actor now uses the real label and retains the real Open click; no Note/file or
Next identity/full/restart/revocation result is implied. Screenshot/error,
persisted association and six empty own cleanup groups remain saved.
855 then passed the real menu and Meeting detailed-Note opening, but attempted
editor typing while the original PKM Note detail was still displayed. Its
actual **Edit Content** click is required first. The offline bridge adds that
original-only UI step without routing guarded Core Notes into retained legacy
Notes; focused mock cases pass 6/6 versus frozen855's 5/6. No actual Note save,
attachment or Next full/identity/restart/revocation result is implied; screenshot,
one preserved numeric rejection and six empty cleanup groups remain saved.
856 passed the additional real **Edit Content** click and opened the actual
Monaco Markdown editor, but the actor's `textarea.inputarea` selector timed out
before typing/save. Its evidence does not prove a specific EditContext cause.
The offline correction clicks the visible editor surface and observes focus
inside it; three mocked focus cases and six existing mocked bridge cases pass.
No revised real typing/save, attachment or Next full/identity/restart result is
implied. All six own cleanup groups are empty, the failed controller/namespace
exited, and exact own UUID scan found none; Root was formally handed the window.
857 completed the real editor operations, then its observer failed reading the
old timestamp path: ordinary original Note save renames it to its title and
adds a Knowledge header/legacy alias. The retained exact original filestore
independently verifies content exactly equals editor input; persistence of
those bytes is narrowly verified, not successful UI save completion.
The run remains failed and never reached attachments
or Next/full/restart. Offline observer/source fixes follow the unique validated
alias without rewriting original canonical paths or saved bytes. The original
retained-root source comparison passes, not installed Next admission.
Its six own cleanup groups are empty and the window was formally handed to Root.
858 then confirmed persisted content but failed revealing the renamed **Notes**
Workbench tab. Its screenshot also proves original **Failed to save** the old
timestamp `pkm-content` URI after physical title rename; the editor is dirty.
The offline actor now reveals Notes. Original 4.0.22 is not patched and current
Knowledge compatibility work is separately coordinated. Eight newer installed
failures and their exact own-fixture cleanup remain preserved; no attachment
or Next/full/restart qualification is implied.
859 separately verifies the current ordinary Note fix in real private Code:
original 4.0.22's old-URI save failure is captured; current 859 saves through
that same old URI/root/profile, clears dirty state and matches provider
read/stat bytes. Code restart reads the previous value before another real
successful edit/save. Canonical bytes are unchanged and the original root has
no Core SQLite. This is **ordinary URI compatibility only**, not Room
attachment/full transfer, Host/Hub restart, Next adoption or standard release.
Eight cleanup groups are empty; the window was formally handed to Chat.
See `collaboration-room-note-compat-installed-v19-summary.json` in the private
evidence directory. The full Room v19 workflow has not run.
Root subsequently exposed a separate direct old-slug `noteUpsert` collision.
The fix uses the safely resolved existing physical slug as the previous path,
without relaxing move-target, asset or root fences. Five focused source cases
pass; the old failed Root fixture remains retained. The new 861 full candidate
is separately frozen; its private dual-profile attempt failed before Share
File or candidate installation. The Notes panel was revealed, but its
Knowledge workspace hid Threads under Projects. The offline actor now clicks
the actual workspace-rail button before the inner tab; nine Python mocks pass,
not installed qualification. Six own cleanup groups are empty and the window
was formally released to Env. The failed 861 summary is retained separately
from 859's ordinary-URI success—not a production or full migration pass.
862/863 separately exposed real file-dialog labels; 864 failed even earlier
at original Monaco focus. All failures remain retained. Before another full
attempt, independent 865 targeted **real original 4.0.22 Code** passed three
viewport/observed-DOM-focus edits and clean saves: fresh load, scroll/tab switch,
and full Code restart reading the preceding save first. Actual provider read,
physical semantic content and stat bytes agree; the separate Meeting old-URI
**Failed to save** negative still fails as expected. API fixture seeding is not
UI creation, and this is not candidate/full/Host-Hub/Next qualification.
Seven own cleanup groups are empty and the private window was formally released.
See `collaboration-original-editor-installed-v25-summary.json`. Only afterward,
separately frozen 866, with the exact same verified actor hash, passed offline
checks and ran one bounded private full attempt after Root/Env handoff.
866 exited 1 at the actual Host upgrade command after its warning confirmation.
Before that failure, original Guest real file Save wrote **110000 bytes** equal
to Host input; independent rereading also confirms all 32 original
archive/canonical/Note hashes unchanged. Candidate activated only in Host
prepare, not selected/migrated primary or full qualification. The pending
upgrade substep is unresolved: no prepare screenshot was captured, so snapshot
or owner refusal is not inferred. See
`collaboration-room-full-installed-v26-summary.json`; seven cleanup groups are
empty and Room formally released before Root formally accepted its own trial.
Next work is isolated real preparation UI/progress diagnosis, not another blind
full retry, a fabricated grant or deletion of partial data.
There is no distributed owner lock or
automatic per-Room topology switch. A separately confirmed transcript-only
takeover can explicitly clear the profile's old `chatHubUrl` hint before a local
restart; this does not establish ownership of its other Rooms.
See `next-server/LEGACY-CHATROOM.md` for current source versus installed
qualification; earlier private injected-owner fixtures do not qualify the new
product Portal/project and cross-root Force Close journey.

## Linux: isolated legacy-copy import from a VSIX

The production extension includes the Next server payload, but this is an
**opt-in isolated trial**, not a default data-store switch or a release
qualification. Install the production VSIX in VS Code, then run **PKM: Import
Static Legacy Copy into Isolated Next Trial**. Select a quiescent disposable
copy of the legacy root, an empty private parent directory, and existing local
Node >=22.18.0 and Python >=3.10 executables. Node is not downloaded. The
destination `parent/workspace` must not exist. Stop external writers and
retain an independent backup; the static-copy assertion is not a writer fence.
Review the displayed blockers and exact plan digest before confirming import.

The imported workspace initially attaches read-only. To experiment with
supported Notes, Skills and Research edits, explicitly enable **PKM: Enable
Isolated Import Write Experiment**, review its authorization, and publish
drafts using the isolated document commands. Close via **PKM: Close Isolated
Next Trial** to drain the child; reopening a write experiment requires
explicit resume. Boards remain read-only and archived code is inert. See
[managed lifecycle](managed-mcp-lifecycle.md#importing-a-static-legacy-copy)
for limitations and recovery. This does not establish parity, live-root
migration, cutover, rollback or production release readiness.

Maintainers can run `node scripts/run-next-trial-private-display.js
--installed-vsix` on Linux with the existing cached VS Code, Xvfb, Node and
Python dependencies. It builds and verifies the actual production VSIX in a
private staging directory, installs it in an isolated profile, drives synthetic
copy import and editing in a real Extension Host, then uninstalls it. Dialog
responses are automated; no real user profile or root is used. It is not the
full release gate.

For an installed-version upgrade rehearsal, append
`--legacy-vsix=/absolute/path/to/older-personal-knowledge.vsix`. The harness
first installs and activates that older package against a synthetic configured
root, then installs the current package in the same private profile. It checks
that activation retains that root without starting Next, and runs the packaged
read-only adoption inspector against the fixture. The inspector always blocks
in-place adoption: it does not prove writer isolation, complete workflow
parity, or recoverable cutover. This is not an automatic migration or a
Windows acceptance test.

Maintainers may additionally pass `--in-place-experiment`. This test-only
entry exits both editor sessions and drains only the fixture's own services
before invoking the explicitly unqualified adoption API. It then starts the
real packaged MCP/native runtime, reads and updates an existing Note at its
original path, and reopens it in another server process. Production activation
has no corresponding automatic switch. Unsupported old `.pkm` state must be
rejected with the entire old tree unchanged; in that case the runner separately
exercises a notes-only synthetic root and labels it **not the installed legacy
root**. A successful bounded lifecycle does not establish full migration,
writer fencing for real users, or complete workflow parity.
`--focused-package` additionally restricts this experiment to the normal build,
real VSIX packaging and payload integrity checks; it does **not** run the full
package/service release gate. It cannot be used without the explicit in-place
experiment. Keep any unrelated package-gate failure separate from this bounded
journey's result.
For acceptance of the actual installed legacy root, add `--require-same-root`.
Any refusal then fails the journey rather than falling back to another root.
The experimental recovery path interrupts a separate process after durable
preparation, checks that ordinary startup refuses the pending journal, then
explicitly resumes that same root/journal before exercising MCP and restart.
The Linux 2.7.32 → 4.0.22 private-profile journey has exercised this on the
**same installed legacy root**, including its activation-created privacy
metadata, local Git metadata, a nonempty closed Chatroom and empty MCP/Server
directories. It checks that all original files are unchanged at adoption, only
the selected old Note changes, and native Chat continuation leaves every old
Chatroom file unchanged across crash recovery/restarts. This is a narrow,
`experimental-unqualified` slice, not authority to switch a real user's root.
Other private state, active legacy writers and unqualified workflow parity
remain blockers; Windows still requires separate acceptance.

The same-root runner now also requires a **nonempty Chatroom**, written and
closed by the actually installed old extension's `ChatPersistence`. An optional,
host-authorized compatibility adapter reads that SQLite archive without changing
it, preserving original message IDs, aliases, metadata and ordering. Text/notice
history can be explicitly projected into a new actor-private native Chat and
continued through the native provider/turn pipeline. The fixture uses a real
loopback HTTP/SSE server with deterministic synthetic responses, not a live model.
It deliberately terminates the Next process after the provider result commits
but before assistant publication, then checks recovery and further restart with
exactly one provider request, complete native history and unchanged old DB bytes.
Import progress and continuation use existing durable operation receipts and
revision CAS. Native messages retain a bounded inert legacy-origin record in
the existing portable retrieval metadata; old system notices are never promoted
to privileged model instructions. Historical provenance pins are not changed.
No legacy tool observations, Host secrets or network-room rights
are replayed or inherited.

This adapter is off unless a native host explicitly supplies root/workspace/
actor/source-fingerprint authorization. Active rooms, pending joins, nonempty
journals, SQLite sidecars, links and unknown files/schema fail closed.
Non-text records remain readable as archive records, but are refused for lossy
text continuation. A separate, default-off native Room host now supports an
explicit `legacy_chatroom_reopen` experiment: it imports historical messages,
members and aliases into component-owned tables in the existing `core.sqlite`,
never a new root directory or a writable copy of the old DB. New explicit host
authorization and fresh join/Host credentials are required; old client IDs do
not acquire historical participant or Host authority. The parent must await
`drain()` before closing Storage. Every transaction checks the workspace owner
and fencing epoch, and stale admission closes rather than silently restarting.

Focused tests load the actual 2.7.32 VSIX writer, then exercise real retained
human/agent protocol clients, history/roster reads, bidirectional messages,
binary file transfer, authenticated HTTP download and replay after reopening.
A native client adapter suppresses duplicate file notes/delivery while retaining
the actual protocol client. A real MCP child exits after its file note commits
but before live delivery; the next child resumes that same file ID and verifies
duplicate offers/chunks create one durable note and payload. The installed
same-root runner includes this journey too; these experiments do not enable
the production UI or establish complete Chat parity.
This host is loopback-only: production webview handoff, LAN/Portal hosting and
the full legacy administration/tool surface are not wired by this experiment.
It refuses archives above 4,900 messages, stops at 5,000 total messages or
16 MiB native room state, and never silently prunes preserved history.

Historical Room attachments have a hard limitation: the old Hub persisted only
`file.offer` metadata, relayed chunks live, and the receiving extension kept bytes
in memory until the user chose an arbitrary Save destination. Missing bytes
cannot be reconstructed from the old root: history stays readable but download
returns an explicit 404, never invented contents. Newly transferred native
payloads have SHA-256 receipts and bounded storage (8 MiB/file, 64 MiB/room).

Ordinary **API Chat is a different layout**, not a Chatroom DB:
`.pkm/state/api-chats/<namespace>/<uuid>.json`, immutable
`.pkm/state/api-chat-history/<uuid>/<sha256>.bin` segments, and related
`agent-groups`/Session/library control state. A dedicated experimental receipt now
admits **closed ordinary API Chats** on their exact original root: it verifies
the complete segmented index graph, every private file and directory identity,
inline image bytes, and exact owner group records. Older hash-verified CAS
generations are retained inertly, never treated as current messages or authority.
Unrecognized library, Session, worker, queue or recovery layouts still fail closed;
the refusal test checks all original bytes, inodes, modes and timestamps remain
unchanged. No state is discarded and no notes-only replacement root is used.
The separately gated managed Task/worker experiment below admits explicitly
verified managed archives; it never sends them through this plain-text host.

An explicitly supplied native host exposes history and continuation over MCP,
with mutable transcript/operation receipts only in `core.sqlite`. Real client
tests read the segmented history and decode its PNG, send the original PNG bytes
to a real loopback multimodal HTTP/SSE provider, continue both Chats and reopen
them across process restarts. Actual exit78 after the durable provider result
recovers without another HTTP request or duplicate message; exit79 before that
receipt leaves an **unknown outcome requiring reconciliation**, never an
automatic reissue. The latter is not automatically recoverable by this host.
The retained legacy HTTP client explicitly rejects image transport, so the new
native-only loopback provider handles multimodal requests instead of dropping
images. It cannot contact non-loopback endpoints or inherit old provider secrets,
tools or permission grants. Archived legacy configuration remains inert.

Bounds are 128 Chats, 4096 archive entities, 128 MiB of source archive, and
10,000 messages/64 MiB per native transcript; excess or unsupported state is
refused, not truncated. The host/tools are absent unless explicitly injected.
Production UI/model/tool integration, complete Room/API Chat parity and Windows
remain **unqualified**, as does automatic production root switching.
The 2.7.32 VSIX does not contain `ApiChatStore`; the fixture uses the retained
ordinary API Chat writer/client (the upgraded installed payload in the combined
installed gate) on its own private **pre-adoption** root. This is not evidence
that 2.7.32 had API Chat, nor a production API Chat profile cutover.

The separate Linux installed-renderer experiment uses the existing Chat webview,
an explicitly approved synthetic-only profile grant and a fresh authenticated
loopback broker. It returns before legacy activation; other legacy workflows are
not registered. Without the explicit grant, a previously marked experimental
profile fails closed rather than falling back to legacy writers. Normal profiles
do not start this broker or switch roots.

`scripts/build-native-chat-ui-candidate.js` freezes and hashes a private build.
`scripts/run-native-chat-ui-installed.js` installs the untouched VSIX into a
private profile/network/PID namespace and drives the real Electron renderer.
The historical 4.0.22 legacy-backend baseline genuinely reads its PNG/segmented
history and sends through HTTP after an actual user approval. In the earlier
frozen candidate, that activation also creates ProjectStore/Action state: same-root preparation refuses
`PKM_STATE_UNSUPPORTED`, and the ProjectStore planner independently reports
`MIGRATION_MARKER`. No marker/state is deleted or bypassed.
`--native-protocol-only` tests a **different, bounded synthetic root**
created by the real legacy API Chat store without legacy activation. Its native
renderer checks are not a completed old-UI upgrade, nor a released-version
upgrade. A separate installed protocol run has exercised real PNG/history reads,
a genuine button send with a distinct pasted PNG, two actual Code windows using
the normal Enter submission path for a stale-revision race, preservation and
explicit retry of the rejected draft, and an actual exit78 followed by a full
Code/broker restart without replaying the HTTP effect. The synthetic grant stores
a disposable loopback bearer in an owned 0600 profile file; this is not old
SecretStorage recovery, encrypted credential storage, or a no-swap guarantee.
The read-only retired-state inspector grants no Project/Action rights
and does not reconcile the migration marker. Full Room UI, tools, Tasks, Portal,
queue/steer, pre-send attachment-draft recovery and Windows remain unqualified.
With that earlier candidate, `--expect-legacy-ui-block` explicitly re-runs the genuine old-UI baseline and
asserts both refusals plus unchanged source/payload; its success means that the
unsafe upgrade was **blocked**, not that migration succeeded.
Closing that private Code window can leave its legacy MCP service alive: the
runner first records the real `LEGACY_WRITERS_ACTIVE` refusal. It only signals
known services whose argv, UID and PID start-time bind them to this synthetic
fixture, then waits for the unchanged full writer scanner to report no blockers.
The immutable-source baseline is captured after this legacy shutdown; unknown
processes are not terminated or exempted. No production process is inspected,
connected to or stopped by this namespace-isolated controller.

#### Verified same-root old-UI bootstrap experiment (Linux only)

The subsequent `--legacy-ui-same-root` journey uses the real historical
4.0.22 legacy-backend VSIX to activate the old UI in a private profile, then
installs candidate SHA-256
`02683900293023e1d2a039ddf482c422fb7fa59b41e285ac733fb8752c02c8a1`.
It keeps that **same original Knowledge Root**, rather than replacing it with
the protocol-only fixture. This remains a same-version payload replacement,
not a released semantic-version upgrade or a production/default cutover.

The former `PKM_STATE_UNSUPPORTED` paths are `.pkm/state/actions`
(`settings.json`, blocked `preparations`, empty `validation-queue.json` and
`mutation-lease`), `diagnostics/mcp`, `mcp-usage/events`, `projects.json`,
`project-store.json` and `project-store-migration`. Compatibility accepts only
the observed untouched bootstrap: one Default Project/General Thread, validated
built-in Recipe envelopes, no user tasks, migrations, receipts, configured Action
workspaces, workers or queued jobs, and paired completed lifecycle telemetry.
It does not promote blocked Action preparations to executable authority.

The former `MIGRATION_MARKER` is the old ProjectStore's **completed `cutover`**
journal, not an unexamined pending intent. The new compatibility receipt checks
its source digest, byte-identical preserved backup, empty stage/backup directories,
canonical control, ordered receipts, counts and actual Project tree against the
original envelope. Unknown phases, pending Project intents/locks, foreign staging,
changed trees/control/backup and additional unknown state remain fail-closed.
No old marker, backup, envelope, attachment or workflow file is deleted or rewritten.
The complete file-identity/byte inventory and semantic receipt enter the adoption
plan/fingerprint; the original envelope and receipt are committed together in
`core.sqlite` and checked on restart.

The installed journey passed a real exit80 after that SQLite transaction but
before the root adoption commit: ordinary Storage open stayed blocked with
`RECOVERY_REQUIRED`, followed by exact journal resume. The installed runtime also
refused an unknown pending Project intent in a copy of the actual old-UI
synthetic root, retaining every file and creating no native authority. On the same
root, the original Chat renderer then read PNG/segmented history, sent a distinct
pasted PNG through HTTP, preserved and retried a two-window stale draft, and
recovered a real exit78 through a full Code/broker restart without repeating HTTP.
All original source files and the untouched installed payload retained their
bytes, modes, inodes and timestamps.

`LEGACY_WRITERS_ACTIVE` is unchanged: the surviving private legacy MCP service
was genuinely rejected and explicitly drained; an actual running VS Code host
was also rejected without source changes. **All Code hosts must exit before
this experiment adopts/reopens Storage. This is not a seamless upgrade.**
User Project/Recipe workflows, configured or running Actions, full Room UI,
tools/Tasks/Portal/queue/steer, pre-send attachment drafts, credential/provider
continuity and Windows are not qualified by this bootstrap Chat experiment.
Sibling Subscription host changes made after this candidate's source freeze
are not covered by its installed Chat result.

#### Verified private original Todo/Board upgrade (Linux only)

The later `--legacy-ui-same-root --todo-same-root --require-version-upgrade`
journey **passed a real private-profile 4.0.22 → 4.0.23 installation upgrade**.
The version overlay applies only to the frozen build staging directory; the
repository version, historical VSIX and historical provenance pins are unchanged.
The candidate is a private prerelease, not a published release:

- Frozen candidate source SHA-256:
  `c1357e205a3b7e3b279695d749ff147ddedc636da75873bca9e0789fa7172f57`.
- VSIX SHA-256:
  `e62fa43319ca7e737dcad2580d538e615b4f3bb8728d5a518f486994b0e2b98c`.
- Actual controller SHA-256:
  `04d2a116677b6af9191f16d52e823d906415a76d27dc80bace072481bfb6bf91`.

The untouched installed old FileStore creates genuine
`notes/<slug>.assets/pkm-todo-board.json` Boards, an accepted result, comments,
original Chat ownership and an actual inline-to-Board conversion. Before upgrade,
the real old Library/Todo renderer also reads and edits a Chat-linked Work Item.
The new server then adopts that **same configured root** without a path-import
dialog. Publication copies exact original Board bytes to the native `boards/`
authority; a journal/source fingerprint and transactional SQLite receipt bind
the original Note, Work Item IDs and audit. Original backing files stay untouched.

The original shipped Todo renderer, through the fixture-only native user
transport, passed Story confirmation, user-only title/goal/reviewer/date/Project
edits, original audit display, task creation, Table/Board/Timeline, reported
verification, acceptance/reopen and continued edits after old inline conversion.
Associated Chat navigation uses the actual old UUID, sends through real HTTP,
and retains an unsaved Todo editor draft. These are native writes, not a read-only
projection or a legacy FileStore writer on the adopted root.

Complete Code/broker restarts retain those edits and identities. In addition to
the exit80 adoption and exit78 Chat-result recoveries, a private-namespace
read-only bind mount causes **real `EROFS` after durable Todo intent preparation**.
The observer verifies the pending transaction, missing receipt and unchanged
Board before actual exit79. Default recovery and exact operation-ID replay
produce one comment/history addition. All original comments/history prefixes
and the complete previously accepted result remain intact. A mode-only denial
was insufficient under namespace-root capabilities and is not the passing proof.
The installed payload and original source file bytes/modes/inodes/timestamps
remain checked. Targeted frozen-runtime tests passed 19/19, adapter tests 2/2,
and the readonly/private browser regression passed 3/3.

This qualifies only the named synthetic Linux journey. Normal activation still
does **not** start or switch to Next. New Board creation through this private UI,
original Chat tools acting as Todo workers, worker-token continuity/SecretStorage,
the full related-record/Harness inspector, arbitrary user Project/Action workflows
and Windows are not qualified by this candidate. The existing all-hosts-exited
guard and the unmodified-old-writer limitation below still apply; production
cutover and complete migration remain blocked.

Separate focused Linux evidence now covers an **original worker token**, not an
invented old SecretStorage entry. With `PKM_TODO_LEGACY_EXTENSION` pointing to the
historical 4.0.22 FileStore, `native-todo-user-host.test.mjs` mints an external
worker token using that codec, adopts the same synthetic root, and makes a native
user edit. After closing that host/storage, a real compact stdio MCP process
authenticates with the unchanged token, claims and submits the assigned Work
Item, but is explicitly refused human/reviewer-only acceptance. A further
storage restart preserves original identities, aliases and source bytes. This
focused test passed 1/1; it is not an installed old-UI token-creation journey or
qualification of production OS keyrings. The old UI copies tokens to the
clipboard; it does not store them in VS Code SecretStorage.

#### Subsequent private worker credentials and concurrent Todo edits (Linux)

A newer frozen candidate repeated the complete real 4.0.22 → 4.0.23 journey
above and **passed**, including the following additional qualification:

- Frozen candidate source SHA-256:
  `399bd54bc04f72ea1a205002caf426e4a6f2ce15c4b4a1cfa81d65e31d40ee56`.
- VSIX SHA-256:
  `b81db72ccc0621311fc220b0a2a6f510665db12a04d8a003d780d901160886c4`.
- Actual controller SHA-256:
  `ee92ca2b97916316a13e67522aa4968bb71882b64721203b9696b5a5c898e078`.

Two actual original Todo webviews race a native user edit: the stale save is
rejected, its unsaved draft survives explicit reload, and the user's retry
persists. The original worker-token button grants and rotates twice using real
VS Code SecretStorage, without submitting or clearing an unsaved Todo editor.
Complete Code/broker restarts retain the rotated credential and original saved
task fields.

The private UI addresses pending and finalized secrets by workspace, Board,
actor and committed token hash. Recovery reads authoritative native worker
grants rather than depending on a profile Memento map; finalizing one hash cannot
overwrite another hash's credential. A real fault holds the HTTP acknowledgement
**after** the native grant and user receipt have committed. All Code/broker
processes stop, then restart normally. The original renderer verifies the
recovered SecretStorage token against the actual native hash and confirms that
the pending secret was deleted. Native Board bytes do not change during recovery;
no replacement grant or plaintext-token transport is used. Older experimental
pending-index entries have matching-hash compatibility recovery.

Evidence: `todo-installed-same-root-v11.log` completed with exit 0. Exact packaged
runtime focused tests passed 19/19, including the separate historical-codec/real
stdio worker-token test; frozen adapter/credential recovery tests passed 8/8 and
browser regressions 4/4. During the preceding candidate's validation, a parallel
focused attempt failed closed on a transient uninspectable process; serial
execution passed without weakening the writer guard.

This still qualifies only synthetic Linux profiles using the explicit
`--password-store=basic` test setting, not production OS keyrings, credential
retention hardening or Windows. It does not qualify new Board creation, new
inline conversions, original Chat tool execution as a Todo worker, full
Library/related-record/Harness workflows or arbitrary existing user roots.
Normal activation and production root switching remain gated; this is not
complete migration.

#### Original Library Board creation and original Board task lifecycle (Linux)

The private Todo transport now reuses the packaged original Library renderer and
its folder/title/document-type dialogs. Its dedicated native create path fixes
the actor to `user:local`, requires the unforgeable fixture authority, and uses
the existing durable Note/Board creation journal. Restart admission for a
user-created Board comes from its immutable workspace/source binding, not an
in-memory allowlist. Focused tests cover stable Note identity, replay, collisions,
task deletion/restoration, and restart. The private Todo renderer also exposes
reasoned task deletion/restoration without removing audit history. Library
commands and panel messages share a queue, so a list refresh does not enter the
exclusive Board-create fence; the Storage gate itself is unchanged.

An untouched historical 4.0.22 installation has actually created the additional
old assets-layout Board through its real Library dialogs. A subsequent complete
real 4.0.22 → 4.0.23 same-root installation journey **passed** with:

- Frozen candidate source SHA-256:
  `3f68921dc3831c1615460b910b0c8f47bd02f4de5b70e26ef2404c3b15c98413`.
- VSIX SHA-256:
  `6ffac8d6d01ad4cd0e4e569751cc6fe8b028d35cb8cc224e40b0ee1845478265`.
- Actual controller SHA-256:
  `3b04862ba6456eb9211703341c26846172c8638f842033333ac5a68caa212a4a`.

The original Library dialogs then create a new native Board on that same root;
its original Todo renderer creates a task owned by an original Chat. Actual
duplicate creation is visibly rejected without changing Board bytes. On the
Board genuinely created by the old UI, actual buttons create/edit a task,
reassign it between the two original Chat UUIDs, navigate to the associated Chat,
and delete/restore the same task with explicit reasons. The reassignment's
before/after owner IDs, stable Note/item identities and complete task history
survive full Code/broker restarts.

An additional real read-only bind denies descriptor publication **after** the
durable user Board-create intent. The observer verifies real `EROFS`, the exact
pending actor/operation, absent receipt and absent Note/Board before actual
exit82. Default restart recovery publishes one Board; exact operation-ID replay
is idempotent and changed-input replay is rejected. This repeats the earlier
exit80/78/79, stale-draft, worker-grant lost-ack and fail-closed missing-profile-
grant checks. Original file bytes/modes/inodes/timestamps and installed payload
bytes remain checked.

Evidence: `board-installed-same-root-v5.log` completed with exit 0. Exact frozen
runtime focused tests passed 25/25, and frozen renderer/Library-queue/adapter/
credential regressions passed 15/15. Earlier attempts preserved the guard when
invoked without private-writer-drain mode, then exposed actual folder-collapse,
create-ack and command-picker timing issues. The passing driver uses real folder
expansion and waits for the real auto-opened Board and named Board picker; it
does not inject UI state or fabricate Board creation.

That v5 qualification did not cover Board-file rename/move/trash. Task deletion
is not Board deletion. Generic Markdown lifecycle and Trash still deliberately
refuse Todo descriptors; the later private implementation uses a dedicated
identity/reference-aware durable Board lifecycle, not an ungated FileStore write.

#### Experimental Board-file lifecycle (Linux)

The private native Library now routes metadata, folder move, Trash and Restore
through that dedicated lifecycle. `boards/<original-key>/pkm-todo-board.json`
stays at its stable key: only the current Markdown descriptor and paired assets
move. Immutable original-byte genesis and append-only events preserve provenance,
Note identity, path aliases, canonical task audit and worker authority. Durable
intent recovery refuses unknown partial bytes and occupied restoration targets.
Knowledge links are opened through an exact current task relation and same-root
Note lookup, not an arbitrary FileStore path.

Real old UI file operations leave `.pkm/state/knowledge-deletions.json`.
Compatibility accepts only the strict original schema, absent historical resource
paths and a byte/identity-pinned source receipt. Unknown, live or pending state
still fails closed. Native operations preserve the journal; original deletion
paths, ancestors and destination assets trees remain conservatively reserved.
Same-path metadata updates do not move assets or revive deleted files. This is
preserved original Sync metadata, **not native Sync reconciliation or parity**.

The frozen candidate `127620123d31a56f95ef793d589f4ce7e9a8e808e7f8feb70d4da6a2b5ae7796`
(VSIX `9d36662018d33d4e4896e792b5eb1fb699739c07d775e0f7a674ee8330e1ab8f`)
passed 28 focused runtime tests and 17 frozen-source renderer/Library/credential
regressions. A verified, awaited worker-secret finalization is not downgraded by
a stale pending-key cache; status responses must match the current Board and
in-flight request, without discarding the user's unsaved task draft.
An actual-old-UI-root copy passed adoption, deletion reservation, metadata update,
move, Trash, full runtime reopen and Restore with exact Note/task continuity.
Three non-Code frozen-package probes passed real assets `renameat2`, exact broker
SIGSTOP/SIGKILL and fresh-process move/Trash/Restore recovery. These probes are
not installed VS Code UI qualification.

The extended actual installed journey now passes on that frozen candidate:
untouched 4.0.22 installation, genuine old Library/Todo file operations, 4.0.23
upgrade and same-root adoption, then real native metadata rename, folder move,
Trash and Restore. Actual Note/linked Note/Chat navigation and the complete task
snapshot remain intact. Three additional real Library actions reach an assets
`renameat2` prefix, SIGSTOP/SIGKILL the exact private broker, and recover through
full Code/broker restarts with the original Todo/Trash UI. This is actual installed
coverage, not a same-named headless Table test.

The run also passes lost-ack worker recovery, durable user/create-intent recovery,
exact original-file/genesis/paired-assets inventory and unchanged installed
payload checks. An independent read-only check of the closed synthetic profile
finds three hash-qualified active SecretStorage slots and no pending slots,
without reading secret values. Earlier incomplete attempts are not qualifications.
The corrected external controller SHA256 is
`9738c9e02a8cb89985a949aca486238fbb4f8fabd583e77bf1b1bc61974e11b9`;
its Python driver is
`e55faadf21206f2f6e998b5f361343a1db34e48ce332b499fd853eda4e1247c6`.
The result covers the frozen package above, including the matching current Board
product sources, not later Subscription or other worktree changes. Production
activation, complete migration/native Sync parity and mandatory Windows
qualification remain blocked.

Adoption uses the default Linux
cross-process exclusive fence; the runner verifies contention while Storage
is alive. The historical VSIX predates that protocol, so its synthetic writers
are explicitly drained first. A separate real 2.7.32 private-profile test
demonstrates the limitation: its published MCP can restart and successfully
`add_note` on the same synthetic root while Next still holds its flock.
Preflight quiescence detects existing old hosts; it does not prevent an
unmodified writer from starting later. Even a passing single-owner installed
journey therefore cannot qualify production cutover or arbitrary old installs.

The installed fixture additionally exercises Skills-only GitHub Sync through
the production panel host handler and scheduler against a disposable local Git
remote. It checks a fresh index, add/update/delete, preservation of unselected
files and existing non-Skill index entries, and lexical search after worker
restart. Panel messages and confirmations are injected; this is not browser
interaction coverage. The private Python environment uses the bundled wheel
offline and does not activate a model. These assertions are not a release or
live-user migration qualification.

The installed Memory fixture selects a closed synthetic Engine and one scope
through the trial UI, explicitly confirms the host's pinned adoption summary,
and reads native records and an existing receipt. Resume and restore do not
renew Memory admission: the fixture explicitly re-adopts each session through
the production command and independently retained host pin. A separate native
process must also deny the old session, and a real CLI backup must not authorize
restore without independent native authority. The fixture uses the installed
restore API with an independently pinned synthetic fixture-owner policy.
There is no CLI restore command or proof of the original owner's identity.

#### Verified private managed Task and worker upgrade (Linux only)

The managed installed journey now passes on an untouched **4.0.22 → private
4.0.23** profile upgrade. Version 4.0.23 is an isolated build overlay, not a
released version or repository-version change. The existing configured Knowledge
Root and its inode are retained; there is no import-path picker. Normal profiles
still do **not** start Next or switch roots.

The old installed UI genuinely creates a Task, records its Harness goal, reads a
synthetic file, discovers the advertised worker capability, and runs an actual
temporary child file read. Its Library create/move/rename and nested Harness
tool inspector also run before upgrade. Session, worker-tree/result, control,
Library and history bytes are archived as inert evidence; old PIDs, permission
modes, write scopes, provider credentials and queued commands are not authority.
Streaming Tasks and unacknowledged original sends remain explicitly uncertain.

An optional, freshly authorized managed host uses native `ChatTurnService` and
the native HTTP model adapter. In the actually installed new package, the same
Task/Session continues through real parent and independently delegated child
`read_file` executions. A fresh file has different bytes from the old probe.
The original Library renderer renames the retained group using native revision
CAS, and the original Harness graph opens the actual native read result. Neither
the extension nor this read-only Harness bridge initializes a legacy writer on
the adopted root. Model/tool authority is rechecked around I/O; revocation
after a real file effect produces an unknown outcome, not a fabricated success.

Installed **v4** then executes another parent read and dispatches a real child.
After that child reads `native-crash.txt`, but before acknowledging its tool
result, the fixture precisely `SIGKILL`s its own broker. Complete Code/broker
restart preserves **both parent and child as unknown**, with `replay=never`;
there are no additional model requests or tool reads. The full journey observes
eight real model HTTP calls and four file reads. All pre-cutover source-file
bytes, modes, inode identities and timestamps, the root inode, and installed
package bytes are checked unchanged. The live-Code writer guard is never
exempted, and the exit80 adoption-commit recovery is also exercised.

Qualified frozen provenance:

- Source: `b7bbb02ccd2cc311a839d94f57176ccd1b36160e9801a9f1e22e0fc3c2f5833e`
- VSIX: `e6e0ed0d1ab1583435bb3dc9f8fcbf5e4c52323cfab3aef28549b0d7fca0e9eb`
- v4 controller: `4dcaca4147d69a82348e62fed1ce21820cb30d310f2ed8f845ef2718a451d1fb`
- Log: `.migration-test-work/chat-managed-installed-v4.log`
- Fixture: `.migration-test-work/native-chat-ui-c2a1da53-7d89-4520-838a-5e3e319d9d5e`

The candidate is built with `scripts/build-native-chat-ui-candidate.js
--candidate-version=4.0.23`. Run `scripts/run-native-chat-ui-installed.js` with
absolute `--legacy-vsix`/`--candidate-vsix` paths and
`--chat-worker-managed --legacy-ui-same-root --require-version-upgrade`.
Earlier v1/v2 attempts failed at test-only CDP/idle waits after their positive
UI checks; only complete v3/v4 runs qualify. Those wait fixes changed test
controllers, not this frozen product VSIX. Focused archive/runtime/host tests
(18), adapter tests (4), strict builds, and separate actual model/tool
revocation and SIGKILL checks also pass; the Next full test suite is not used.

#### Verified private Task controls (separate Linux qualification)

The separately gated `--chat-task-controls` installed journey also passes the
same-root **4.0.22 → private 4.0.23** upgrade. It first continues the original
Task with real parent/child reads, then uses the actual Complete/Start Task
dialogs to complete it and create a fresh Core-owned Task. Stop aborts a real,
observed HTTP model request before tool dispatch. Resume preserves the typed
draft and only changes control flags; it never resubmits that request. The
exact private pause API and the original Resume button are exercised too.
A fresh read and its actual Harness inspector belong to the new Task, not to
the archived source Session. Completion retains the conversation, and a second
fresh Task then executes the child-read/SIGKILL/full-Code-restart scenario.
Both its parent and child recover unknown with `replay=never`, without any
additional model/tool execution. There are **11 real model HTTP calls and
5 actual file reads**. Source files/root identity and installed package bytes
remain unchanged.

Controls have fresh authorization, durable operation receipts and revision CAS.
Original pause semantics are retained: pause aborts the parent, not an already
authorized child; cancel aborts the native parent and descendants. Pending tool
effects stay uncertain. Resume, completion or a new Task cannot clear or escape
an unknown outcome. Cancellation only controls this native runtime's own
controllers; it never trusts or kills original PIDs, restores `allow-all`,
or grants arbitrary executable authority. Archived execution trees remain
readable evidence, but are not projected as live controls for a fresh Task.
Fresh Task Harness evidence is task-filtered and labelled `native_core`.
Ordinary Chat → Task creation and retention of an earlier plain native
transcript are additionally verified with real HTTP on an isolated old-root
copy; cross-engine operation IDs cannot cause a second execution.

Task-controls installed **v4** provenance (not the older managed-worker v4):

- Source: `c9ccfadbecc7e5db4ae146d40544eaf5bf1e7c66ee0fe7775f0963a16e46779d`
- VSIX: `4222317f954bcc2f2b3c8e2eae7c83899eaec23426dd6ba9d6c75585dea648c7`
- Controller: `dbb651ef5ad5aba0ab30c29f0fcda8af3a7e770b715ec732a8a335cdd35c8806`
- Log: `.migration-test-work/chat-task-controls-installed-v4.log`
- Fixture: `.migration-test-work/native-chat-ui-84bc179f-0725-46cd-815f-bdb878ce795c`

Add `--chat-task-controls` to the managed installed command above. Earlier
controls v1/v2 attempts exposed the renderer's blanket native Task/Stop
disable; v3 fixed the product gate but its test could not inspect the native
OS confirmation dialog. V4 uses the **same frozen v3 product VSIX**, with
`window.dialogStyle=custom` only in the synthetic profile, and completes the
real confirmation. Only the complete controls v4 run qualifies. Related
validation passes: 19 focused archive/runtime/host/control tests, 5 adapter
tests, 2 real-browser renderer/menu tests, strict builds and a self-contained
real-HTTP control fixture. No full Next test suite or historical pin refresh
is involved.

#### Verified private queue, steering and unknown-intent review (Linux only)

The separately gated `--chat-workflows` installed journey passes the same-root
**4.0.22 → private 4.0.23** upgrade; it includes Task controls. Real UI actions
steer the exact active attempt before its next model prompt, queue/edit/remove
inputs, and Stop while preserving the queue. A full Code/broker restart retains
the edited FIFO. Resume does not execute it: an explicit Run is required.
Another real child read is interrupted with broker SIGKILL before its tool
acknowledgment. The actual warning and required reason lead to a separate,
fresh `user-required` decision to **abandon without replay**. UNKNOWN,
uncertainty and `replay=never` remain intact; review neither fabricates success
nor automatically drains the queue. Explicit Run executes a distinct fresh
input, not the unknown intent.

The installed followup also exercises a controlled, known `not-committed`
tool denial before filesystem access. Automatic drain stops. Explicit Run
continues only the distinct remaining work, never retries the denied intent,
and cannot bypass an unresolved unknown outcome. A further full Code/broker
restart preserves both failed/unknown records, the separate review audit,
and original/native history. Original history beyond the first page is
retrieved through actual renderer scrolling/pagination. There are **20 native
model HTTP calls and 7 actual native file reads**, including exactly one read
of the unacknowledged child's file. Original installed-writer reads are
additional, separate evidence. All source/root identity and custody checks
pass; no production profile or service is used.

Queue authority is fresh and defaults to denial when absent. Sending-window
Task/attempt IDs and queue revisions cannot be retargeted; stale submissions
fail closed. Durable receipts, edit tokens, FIFO ordering and revision CAS
survive restart. Inputs are bounded to 20 pending items and 16,000 characters
each. Source queues remain archived: focused genuine-old-writer HTTP tests
verify explicit adoption as a **fresh** input without reusing missing old
execution context, executable/`allow-all` permissions or Portal grants.
The only outcome decision provided here is abandonment without replay, not
verification of arbitrary effects, undo, or proof that an external process
has stopped. Stop-steering is separately tested to prevent the next actual
model HTTP request.

Workflow installed **v8** provenance (independent of earlier qualifications):

- Frozen product source: `f358dd32e86c7ebb488dbf6c05bd44d4decb768c9f2e0bed8feba23fe3a179b6`
- VSIX: `5039afa91f10c416deae33807672446ec138b6699df3e172821207db7029d63c`
- Independently pinned controller: `049f7db4854a2e496f8ffa530b5309e786cce36fe25658d98e8526ab3c065b12`
- Log: `.migration-test-work/chat-workflow-installed-v8.log`
- Fixture: `.migration-test-work/native-chat-ui-cf14b6b2-f06f-4e55-ad0e-7575e6f96e03`

Add `--chat-workflows` to the managed same-root installed command. Only the
complete v8 run qualifies this final product/controller pair. Earlier v5/v6
completed the business stages but failed final history-pagination assertions;
v7 safely rejected a send before its new attempt was published. V8 waits for
the actual persisted attempt's renderer projection and uses real scrolling;
it does not retry rejected sends or relax authority. These controller fixes
did not change the frozen product VSIX. The runner exits zero and independent
process inspection finds no surviving processes for this private fixture.

Related validation: 36 focused root-cwd tests, 35 frozen-candidate focused
tests plus one pure reducer test, 6 adapter tests, 2 real-browser renderer
tests (including a 300px-wide actionable queue), strict builds and payload
verification. The frozen focused run explicitly skips the original installed
fixture test whose attested original path cannot be relocated; the 36-test
root run includes it. Historical capture provenance still fails on dirty
captured Chat-turn files; its pins are unchanged. Neither those historical
gates nor the entire current worktree are claimed green. The full Next
`npm test` is not run because of its verification-file side effects.

**Release blockers remain, not waived or deferred:** individual Chat rename,
permanent-delete/Empty-Trash/cleanup parity; Task switching and tool-specific
effect verification/reconciliation beyond the bounded abandonment above;
all original tool and managed-image workflows; Memory/Recipe/profile integration;
segmented archived worker results; and deleted-Chat Task/Session families.
The current bounded context is not full original tool-evidence retrieval.
This proof does not qualify every current
worktree change, production automatic startup/cutover, or Windows. Windows
verification remains mandatory. Installed and real-I/O tests use synthetic
fixtures/private profiles and isolated network/PID/mount namespaces, never
production PKM/MCP.

#### Explicit original Chat Memory integration (private Linux experiment)

The optional managed host discovers the original Engine automatically from the
existing profile's `memory/<SHA256(canonical Knowledge Root)[0:24]>.sqlite3`.
It does not ask for an import path or write that SQLite file. Exact source
identity, original revisions, audit and receipts are retained; actual native
Core/Storage mutations go to a separate profile-local `next-chat-memory`
Markdown workspace, matching the original Memory's profile-local placement.

Fresh, exact-scope admission lasts 15 minutes and is fenced in both host and
Storage worker. Restart does not inherit it. Confirm/revise/revoke each require
an additional exact-record human modal, even when the archived Chat used
`allow-all`; revision returns a record to pending. Operation identity is supplied
by the host, never the model. The real Memory context service supplies quoted,
source-pinned untrusted references and checks stale epochs before dispatch and
every stream event. Pending, foreign-scope and revoked records are excluded
from active recall; revocation does not erase retained history or prior prompts.
Existing exact native Memory journals can be reconciled only after fresh scope
admission; this does not authorize replaying unknown model/tool intentions.

This is the explicit-record subset, not complete Memory or Chat parity.
A closed, checkpointed original Engine is still required: safe automatic
capture/quiescence of an active Engine and protection against later unmodified
old writers are not delivered. Hierarchical/computed/embedding Memory and its
background workers are not qualified here. Original Recipe runtime execution
is also **not implemented**: its real `.pkm/state/recipe-runs` JSON/locks,
definitions, node bindings, receipts, attempts, user input and restart/unknown
semantics still need native integration and installed qualification. A Recipe
projection/compiler is not evidence that these original workflows execute.
These remain mandatory release blockers; production activation/cutover and
Windows qualification remain blocked.

The separate **Memory installed v5** journey exits zero for an untouched old
4.0.22 VSIX upgraded to the private 4.0.23 overlay. The original Memory fixture
is produced by that installed old package's real ExplicitMemoryService/Engine,
not handwritten SQLite rows. The new installed UI and local native HTTP
provider verify original recall, exact-human revision/pending exclusion,
confirmation, denied and approved revocation, and fresh scope after full
Code/broker restarts. An actual confirmation commits before its acknowledgement
is withheld and the broker is SIGKILLed. The record remains genuinely confirmed,
but the Chat intention remains UNKNOWN/uncertain/never-replay. A separate real
warning/reason and user-required abandonment permits only a distinct fresh read.
Final restart preserves both facts without another model or mutation.

- Frozen product source: `85130ab7dff63fe0babe86054898a44a73ca4b1660898f1eb49ce6c42dcc7ed7`
- VSIX: `18179f246b62ea8a44ff659359f16a7cd8d4c330662dd52f7f87373e4d36199d`
- Independently pinned final controller: `d8aa3e606dd894b2d7ef7c1eea1594dbb84198206c2ac1fa3433aa992bffda70`
- Log: `.migration-test-work/chat-memory-installed-v5.log`
- Fixture: `.migration-test-work/native-chat-ui-3ae388e7-7537-475c-ae0f-17131072699a`
- Closed independent check: `.migration-test-work/chat-memory-independent-v2.log`

Add `--chat-memory` to the managed same-root installed command; do not combine
its qualification with the workflow/task-control branches. V5 records 14 actual
native model HTTP calls and five actual Core Memory mutation commits. Closed
Markdown audit independently contains exactly one confirmation for the
unacknowledged operation and retains the original lifecycle/actors. The original
SQLite bytes, inode, mode, owner and timestamps are unchanged (owner IDs are
explicitly mapped across the private user namespace); no private fixture
process survives. Forty frozen-source focused tests, strict builds, payload
verification and a separate real native HTTP catalog-boundary check also pass.
Earlier incomplete installed attempts are not qualifications. Historical
provenance pins are not refreshed; the destructive full Next test is not run.

#### Recipe execution continuation (private experiment; narrow same-root admission)

`LegacyApiChatRecipes` can compose explicitly installed trusted adapters with the
real native `WorkflowExecutor` and Core transactions. Its private Chat RPC/UI
offers distinct run creation, persisted state and CAS cancellation. Creation
requires the current Recipe/snapshot digest, exact inputs and a fresh human
modal; the bounded grant is not persisted. Native intent and adapter pins
commit before dispatch; only real executor results produce execution receipts,
never client-reported success. A new private host explicitly fences
its predecessor's active Recipe intentions even before their leases expire:
running effects remain `unknown`, untouched steps are cancelled, and neither
reads nor restarts replay them. Cancellation only fences future results; it
does not prove rollback. Default activation/server composition is unchanged.

The trusted synthetic host adapter reads one fixed private fixture file,
verifies its SHA256 and fsyncs a fixed effect ledger. Recipe/model data cannot
supply a program, script, executable path or network endpoint. It is an exact
allowlisted replacement for two synthetic original Agent claim/report steps,
not arbitrary Agent execution or general `pkm.step.noop/v1` parity. Original
command/script/process permissions, human gates, subflows, scheduling, dynamic
controls, Knowledge bindings and authoring are not inherited or qualified.

The genuine old `recipe_run_get` can synchronize/materialize runtime actions
despite its read-only annotation. The new history view instead reads inert
archived JSON; original running records are shown as unknown historical
evidence with `replay: never`, never transplanted into native success.
The original API fixture actually claims nodes, inspects synthetic bytes,
performs/fsyncs its effect and reports the observed result; it also retains an
unresolved original claim.

Earlier separate-root functional evidence comprised **25 passing** tests: five Recipe cases including
real authenticated HTTP create/read/cancel, nineteen executor regressions and
the existing Chat HTTP-host baseline
(`.migration-test-work/recipe-runtime-http-regressions-v13.log`); **nine** Chat
UI-adapter tests also pass (`recipe-ui-adapter-v2.log`), plus strict extension/isolated
Next compilation. The crash case SIGKILLs the actual native host after fsync,
then verifies immediate UNKNOWN before lease expiry, restart grant denial,
unchanged old-source bytes/identities and no duplicate effect across restarts.
**These are separate-root runtime tests:** an explicit test-only filesystem
projection feeds native definitions. They do not prove root adoption, installed
new Recipe UI parity or seamless upgrade.

The actual 4.0.22 library is in `.pkm/state/projects.json`; its observed
create/update receipts are in `.pkm/state/project-store.json`. The migration's
`sourceDigest` describes the version-1 backup, not the current version-3
envelope. A bounded validator now checks that genuine evolution: the bootstrap
Project/Thread/audit and all built-ins must remain unchanged, custom Recipe
revisions must match a complete ordered create/update receipt history, and the
original run/health archives must satisfy the observed NoOp/empty-binding
schema and digest/link/count invariants. Unknown operations, malformed or
pending state, unknown files/locks and mixed filesystem/ProjectStore Recipe
authorities remain blocked. These receipts confer no execution permission.

The reader exposes this verified original inventory without creating `recipes/`
or rewriting old state. A real copied-root test now performs prepare/resume,
executes fresh native IO, closes and reopens the same root, and proves no replay
and unchanged source identities. Its four tests plus nine root-adoption
regressions pass (`recipe-receipt-adoption-v6.log`, including resealed
cross-domain/usage/health corruption). Another **66** focused
functional tests pass (`recipe-final-focused-v3.log`); the separate immutable
historical source-capture assertion is intentionally not selected. Running it
against changed current source reports the expected pin mismatch; historical
pins have not been refreshed.

The old Save 400 is independently reproduced with its genuine HTTP router and
ProjectStore: a valid Recipe lacking optional methodology causes the route to
fingerprint explicitly inserted `undefined` values before mutation. The current
browser and embedded producers now omit absent optional fields. Two real HTTP
tests reproduce the old error and verify successful current save/revision CAS
plus invalid-definition rejection (`recipe-save-independent-v3.log`). This does
not modify the frozen old VSIX or qualify native library authoring.

The actual isolated `--recipe-upgrade-probe` v9 installed old 4.0.22 and opened
its genuine Code-command/HTTP Recipe Workbench in an already installed local
headless Chromium. Graph and JSON showed the real two-node definition. A real
Save on this API-created fixture returned HTTP 400,
`Unsupported canonical JSON type: undefined`; readback/reload proved no save,
unchanged revision and executable digest. This old authoring defect is recorded,
not counted as a pass. After installing immutable 4.0.23,
the journey verified actual old-server/Code-host writer refusal, closed its
private processes, and observed the precise `PKM_STATE_UNSUPPORTED` /
`LEGACY_UI_RETIRED_STATE_BLOCKED` receipt guard. It deliberately exits **1**.
Independent closed verification found all **179** original entities unchanged
(bytes, inode, mode, owner and mtime/ctime; private UID/GID mapping accounted for),
no Core database/adoption journal and no remaining owned helpers.
Evidence and real Workbench screenshots are under
`.migration-test-work/native-chat-ui-12602d44-7aa0-44a1-a970-3f7ce87a3445/`
(`recipe-installed-blocker-evidence.json`, `legacy-recipe-workbench.png`,
`legacy-recipe-save-refusal.png`); log: `recipe-installed-probe-v9.log`.
The browser uses only this fixture's cwd/temp/profile and private loopback;
external-open consent is cancelled, not granted.

This diagnostic uses the existing immutable Memory-qualified candidate,
**not a package containing the current Recipe changes**, and is not installed
Recipe qualification or permission to switch a real root. All historical
qualification pins remain unchanged; Windows and complete same-root execution
remain mandatory, unfinished acceptance.

A separate current `--chat-recipe` journey now passes on Linux
(`recipe-installed-positive-v2.log`, exit 0). It actually installs old 4.0.22
then a newly frozen 4.0.24 candidate on one synthetic root/private Code profile,
checks real old-server/Code-host writer fencing, commits/resumes adoption, and
reads all 17 original Recipes without filesystem projection. Actual renderer
clicks and exact human modals create a fresh native run with real SHA256/fsync
results and cancel another at its running-node version. Full Code/broker
restarts preserve those results; actual broker SIGKILL after fsync is fenced
before the old lease expires, displays UNKNOWN and never duplicates the effect
on refresh or another full restart. Exactly two native effects and zero model
calls are observed. Source file bytes/identity/mode/owner/timestamps and the
installed candidate inventory remain unchanged. The Recipe disclosure also
keeps its user-opened state during live progress updates.

Candidate SHA256 is
`0b8d86a73ba468d35d30fb66c2fc3f82e5d79c7aaae7f70111f551a5c624ef5e`
(source `52d56d18f756c659bce782ed553e34e278d800c26cf5349cbd2cdb5e5946a44a`).
Evidence, six real UI screenshots and independent closed `/proc`/installed
identity verification are in
`.migration-test-work/native-chat-ui-fbab2302-0de2-4cf3-a069-9b67e8d7d752/`
(`native-recipe-installed-evidence.json`,
`recipe-closed-independent-verification.json`). The first positive attempt
completed a real native run but failed reconnecting Playwright CDP to an
already-existing out-of-process webview; it is not qualification. The passing
controller uses one CDP session per Code lifetime, not a fake webview/backend.
All owned Code/browser/Xvfb/helper processes were independently checked closed
before the Code test window was handed over.

**Run creation is not library authoring/save.** That 4.0.24 qualification
does not cover creating or editing persisted Recipe definitions. Full original
adapter/control/Knowledge-binding parity, complete automatic upgrade,
Windows acceptance and production default cutover remain mandatory and
unfinished. The evidence explicitly retains `libraryAuthoringQualified: false`,
`fullRecipeParity: false` and `migrationQualified: false`; no production root or
historical qualification pin is changed.

#### Native Recipe Library authoring (separate private Linux qualification)

The new `--chat-recipe-library` journey passes an actual **4.0.22 → private
4.0.25** VSIX installation in the same isolated Code profile and synthetic
Knowledge Root. This is definition authoring, not a renamed run-creation API.
It reuses the full original Graph/JSON Workbench through a nonce/CSP-protected
VS Code panel, with no HTTP editor server or filesystem/network permission.
Normal production activation and its default runtime selection remain unchanged.

Definitions and operation receipts commit atomically into the adopted root's
native `core.sqlite`, under its workspace writer lease. Original ProjectStore
Recipes remain immutable inputs: native edits overlay their stable Recipe ID,
Knowledge ID, aliases and origin; copies get distinct identities. No `recipes/`
projection or old-source rewrite is introduced. Built-ins/non-global definitions
remain read-only and can be copied into a new global definition. Compilation,
methodology digests, layout/node references and pinned Knowledge-binding data
are validated before save. Saving references is not execution authorization.

Each save requires fresh exact human confirmation and current catalog/revision
CAS. Conflict, invalid input and lost acknowledgment never trigger an automatic
retry. The private library reader and the explicitly composed WorkflowExecutor
resolver consume the same native catalog; execution retains its real
`source.kind: recipe`, revision and digest, not a fabricated inline source.
Uncomposed public clients and unsupported adapters/bindings are not qualified
by this private integration.

The passing installed journey (`recipe-library-installed-v2.log`, exit 0)
uses real UI actions to create/save revision 1, edit/save revision 2, reject an
invalid JSON graph both on Validate and on an actual confirmed Save, and reject
a stale second editor after the first commits revision 3. Reopening retains
the graph and identity. A genuine fresh native run performs exactly one
fixed, independently authorized effect. A subsequent definition save commits
revision 4 before the broker is actually `SIGKILL`ed, losing its acknowledgment.
Two complete Code/broker restarts retain revision 4 and its identity without
replaying either save or effect. Native model calls remain zero. All original
source-file bytes/identity/attributes, root identity and installed package
inventory are checked unchanged. Before-COMMIT rollback and after-COMMIT
idempotent receipt recovery additionally pass real SQLite/SIGKILL focused tests.

Frozen candidate provenance:

- VSIX: `a013b6eac32a22f72e90223a584bb10491578b89a201e6004cfe0be2ec0fc112`
- Source: `8a021294efcd7fcf7b5d62933f60fd74ba0ccbaf004921f90bf2d7a3f5fad911`
- Bundled Next runtime: 4,761 verified pinned files.
- Fixture: `.migration-test-work/native-chat-ui-251297db-946c-4673-8815-8ca242e812e7/`
- Evidence: `native-recipe-installed-evidence.json` and
  `recipe-library-closed-independent-verification.json`, plus four real UI
  screenshots in that fixture.

The first attempt reached real saves but its controller selected a hidden
editor's iframe during the conflict assertion; it is not qualification. The
passing controller keeps the actual panel-bound frame handles without changing
the frozen VSIX. Independent host `/proc` argv/cwd checks find no owned
Code/browser/broker/runner processes after either attempt; both the new VSIX
and the historical 4.0.24 candidate hashes remain unchanged. Strict builds and
76 focused runtime, authoring, original HTTP and UI cases pass; no Next full
test run or historical provenance-pin update is used.

This evidence sets `libraryAuthoringQualified: true`, but deliberately retains
`fullRecipeParity: false` and `migrationQualified: false`. Complete original
adapter/control/Knowledge-binding parity, unrestricted public API integration,
automatic production cutover and mandatory Windows qualification remain
unfinished. It does not qualify subsequent Environment-only source changes.

#### Recipe public protocol composition (private Linux, not full legacy parity)

An explicitly composed `NativeRecipePublicApi` shares the actual native SQL
catalog with the full Library Workbench and WorkflowExecutor. Normal activation,
CLI defaults and production root selection do not enable these endpoints.
The optional HTTP/MCP hosts bind exact loopback Host/Origin, separate bearer
credentials and a host-only Recipe protocol role. That role cannot invoke
general WorkflowExecutor, Note or other Core operations. A bearer, metadata,
old receipt or environment registration is never execution authority.

Actual installed 4.0.22 discovery uses the **compact facade**, not necessarily
direct `recipe_*` entries in `tools/list`: inspect
`capabilities_describe({operation:"mcp.tool.recipe_search"})`, then invoke
`capability_read` with version 1 and the original arguments. The private
original-profile probe really initializes the generated Python MCP server and
performs discovery/search; it does not invoke execution-capable old `get`.
For the two composed `mcp.tool.recipe_*` reads, the MCP facade preserves the
leaf JSON payload rather than silently wrapping it in a new Core envelope.
New canonical Core/HTTP operations continue to use their normal envelopes.

| Original interface | Explicit native mapping and boundary |
| --- | --- |
| Compact `mcp.tool.recipe_search` / direct `recipe_search` | Same local catalog and original `query`, `category`, `project_id`, `limit`, `task_contract_json`; local metadata ranking and Methodology family fallback, not remote subscribed search or model semantics. |
| `mcp.tool.recipe_capabilities` | An explicitly bounded native projection, with unsupported original lifecycle operations listed rather than advertised as implemented. |
| Workbench `GET /api/recipe` | Same native definition, revision, Knowledge ID, aliases and origin as `project.recipe.get`. One editor resource is host-bound; no arbitrary root selection. |
| Workbench `POST /api/validate` | Real existing deterministic compiler, returning definition, executable digest and node count. |
| Workbench `PUT /api/recipe` | Full-record input, immutable identity checks and revision/catalog CAS; invokes real atomic SQL authoring only with a **separate host approval policy**. Bearer alone cannot save; the original unauthenticated/query-token editor surface is not restored. |
| Native `recipe.library.state/save` | Current catalog digest / strict authoring DTO with operation UUID, expected revision and digest; durable definition and operation receipt share one transaction. |
| Native `recipe.runtime.start/get/cancel` | Fresh native intention / pure actor-owned read / exact-version cancellation. These are deliberately **not** aliases for the old lazy execution lifecycle. |

Public start can be enabled by an actual private UI confirmation of one exact
actor/root/chat/Recipe/input/operation request. Its grant lasts three minutes,
is consumed once, cannot authorize a changed payload and disappears on restart.
Public clients cannot mint grants. Other public mutations require their own
separately composed host decision; the start decision does not authorize save
or cancellation. Compiler source remains `kind: recipe` with its real identity,
revision and digest. Empty binding slots confer no Knowledge permission;
nonempty unsupported Knowledge bindings remain denied.

Focused tests use genuine SDK clients, multiple MCP sessions, HTTP, official
Storage/SQLite, deterministic compilation and a controlled file
read/hash/fsync executor. They prove rejection without approval, generic
Core/Note isolation, stale approval/CAS, exact execution, and restart without
replay. A separately approved HTTP PUT actually commits SQL before an injected
lost acknowledgment: response effect is `unknown`, the committed revision is
readable and a stale retry conflicts. This is not a callback-only success.
Unknown outcomes must be reconciled against durable records/receipts, never
automatically retried. Legacy HTTP valid typed fields are preserved; invalid
types/unknown fields are not permission to bypass strict native validation.

The archive hook admits only successful observed Recipe metadata
search/capabilities and static discovery footprints. A compact `capability_read`
must contain exactly one completed permitted leaf with the same diagnostic
writer, transport and request identity; usage and diagnostic counts must match
for every tool. Every old MCP writer still needs its own real completed
quiesce. Failed, dropped, incomplete, unknown or execution-capable `get`/run
events remain blocked. All original bytes, counts and identities are retained
as **archive-only**, never runtime authority.

The actual installed public journey (`recipe-public-installed-v4.log`, exit 0)
uses the frozen private **4.0.22 → private 4.0.26** builds, one synthetic
root/profile and four
new-package Code/broker lifetimes. Original compact MCP discovery/search really
finds the original revision-2 Recipe before upgrade and quiesces its owned
server. Full Graph/JSON UI creation, invalid Save and double-editor CAS pass.
Real UI confirmations authorize independent installed-SDK MCP and HTTP clients,
which each read/compile the newly authored definition and perform genuine
controlled execution. Including the separate private UI run, there are exactly
**three** file read/hash/fsync effects and zero native model calls.
Revision-4 COMMIT followed by an actual broker `SIGKILL` and two complete
Code/broker restarts retain definition identity and run results; public
replay attempts without fresh approval are rejected.

Frozen qualification provenance:

- VSIX: `78822f6cb1898d7cf0df5727df8a7990f60de0a85e6cd764e3e7cd4dc9b1d791`
- Source: `2a84428b8bf6af6c54716ba61d498a5eb09ae609d0a1c6e096acfe972095bf84`
- Bundled Next runtime: 4,767 pinned files.
- Fixture: `.migration-test-work/native-chat-ui-c7354bb9-c334-40b5-b4a8-5a6a93d9d3d6/`
- Evidence: `native-recipe-installed-evidence.json`,
  `legacy-recipe-public-discovery.json`, the four public-client result files,
  and `recipe-public-closed-independent-verification.json`.

Independent host `/proc` argv/cwd verification finds zero owned processes
across successful and all three failed attempts, including brokers and old/new
protocol clients. Every one of 5,422 packaged installed files matches the
frozen VSIX (only Code's added `package.json.__metadata` is normalized).
Original root/source/installed identity checks pass, and historical 4.0.22,
4.0.24 and 4.0.25 VSIX hashes are unchanged. Strict root/Next builds and
51 focused protocol, real SQL/I/O, archive-negative, authoring, compiler and UI
cases pass without skips. No Next full test suite or historical pin refresh is
used.

Earlier attempts are retained, not counted as qualification: the first assumed
direct old MCP aliases instead of its actual compact discovery; the second
hit a disabled/detached original UI approval button; the third correctly
blocked new metadata usage and the probe's missing owned quiesce. The fix is
precise completed-metadata validation and real quiesce, not deleting evidence
or exempting writers. Private build snapshots also exclude mutable
dot-prefixed test fixture directories, rather than copying live environment
provisioning outputs as source.

The original `recipe_run_start` defaults to lazy execution; `recipe_run_get`
is advertised read-only but synchronizes background results and can materialize
an already-current gate/subflow action. It does **not** claim a new pending
command. Replacing these
names with full-graph start or pure get would change observable semantics.
Consequently legacy `next/report/input`, ad-hoc/autonomous control,
`create_from_skill`, subscribed search, bundle/Knowledge bindings and arbitrary
old script/environment execution are **not qualified** by this integration.
Native operation UUIDs and `recipe_native_*` run IDs are not silently substituted
for original command IDs or `recipe_run_*` identities. Archived runs remain
historical, not automatically resumed. Windows and complete migration/default
cutover remain outstanding; production is not switched.
This result qualifies only the explicitly composed bounded public protocol
slice (`publicProtocolQualified: true`); `fullRecipeParity` and
`migrationQualified` deliberately remain false. Environment-only or future
general Python adapter changes require their own qualification.

### Controlled original Recipe lazy lifecycle — separate Linux qualification

The optional `LegacyRecipeLazyRuntime` composition adds the original compact
operation IDs `mcp.tool.recipe_run_start`, `recipe_run_get`, `recipe_run_next`
and `recipe_run_progress`. All four are mutations; in particular `get` requires
write authority and a separate fresh exact native decision, and is rejected by
`capability_read`. Canonical HTTP uses `/v1/capability_call`; MCP preserves the
original leaf JSON response rather than substituting a full-graph native run.
This composition is not enabled by default.

The controlled command slice preserves:

- Arbitrary nonempty original command strings, deterministic
  `recipe_run_` + first 24 SHA-256 hex characters, original Recipe identity,
  revision/digest, counts/status/version, stored-response replay and conflicting
  command errors. Native operation UUIDs are internal, never replacement IDs.
- `start` and `get` never claim a pending command; `next` requests at most one
  step, and an already-running step prevents dispatching another. Real
  `WorkflowExecutor` assignment/start-intent/lease/result fencing is reused.
- A persisted **host-only** `dispatchMode: explicit` prevents generic startup
  recovery/scheduling from running unrequested steps. Ordinary public create
  cannot select that mode and retains its previous default behavior. Original
  empty-descriptor input dictionaries have a separate host-only seam; ordinary
  create still rejects undeclared inputs.
- There was no original `recipe_run_cancel` tool. Cancellation is
  `recipe_run_progress` with `cancellationRequested: true`; only the directly
  owned child is signalled. A real acknowledged cancellation produces original
  **failed**, not an invented successful `cancelled` run. Host interruption
  instead reports `launch-outcome-unknown`, requires reconciliation and never
  dispatches/replays the uncertain work, even with a different command string.

The actual old-profile comparison (`recipe-lazy-old-installed-v1.log`, exit 0)
installs the private 4.0.22 baseline, opens its real UI/Workbench and exercises its genuine managed
compact MCP facade, compiler and background command worker. It observes exactly
three effects, lazy inspection, explicit progression, receipt/conflict and
actual cancellation. **That execution-bearing comparison profile is probe-only
and is never adopted.** Direct ZIP comparison confirms this profile's generated
`recipe_runtime.py`, `knowledge_mutations.py`, `mcp_call_guard.py` and
`runtime/dist/mcp/mcp-lifecycle.js` match their original VSIX entries exactly.
Generated server configuration points only to the fixture. These four files
are unmodified relative to that private package; this is not a claim that every
generated file is identical or that all same-version packages are identical.
The original Recipe lifecycle implementation/worker is used, not a callback
pretending to execute it.

The separate upgrade journey (`recipe-lazy-installed-v2.log`, exit 0) uses
**private 4.0.22 → private 4.0.30**, the same synthetic Knowledge Root/inode and the
real native SQL catalog/resolver. Its old profile makes only admitted metadata
calls, so execution usage is not smuggled through the archive guard. Real
private UI decisions authorize independent installed-SDK MCP and HTTP calls.
Across three complete new Code/broker lifetimes there are exactly six real
local-command/fsync effects, zero model calls, no unrequested second step,
known cancellation→failed, and an actual effect followed by broker `SIGKILL`.
After restart the interrupted result remains explicitly unknown, old receipts
remain readable and neither old nor fresh command strings replay that effect.
A separate known run's previously pending second step runs only after another
exact decision.

Frozen 4.0.30 qualification:

- Private baseline VSIX:
  `80fcad4f0cfb4756eb3ba6988f574e085ed3c766ddaf8d02ea91fa9d412c158d`,
  `.migration-test-work/trial-electron-2b32dd99-9d99-4756-a28b-73bf97da3830/build/personal-knowledge-4.0.22.vsix`.
  This is **not** the repository-root 4.0.22 archive
  `1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27`.
  Their Recipe compiler Node selection/unavailable-error text and MCP Node
  selection differ; matching version strings do not qualify the other build.
- VSIX: `da0af5001ac160c67113bb58210a3fb2c354892b3b839de8de994dc36be4d34a`
- Source: `15aeaf4b863b32a5a394389512de4bf6cf3b91fd87418d02fd584f843ca3a682`
- Next payload: 4,771 pinned files; 5,430 extension payload files independently
  match the installed ZIP, normalizing only Code's manifest `__metadata`.
- Next fixture: `.migration-test-work/native-chat-ui-52d95426-dfc5-4304-b9b8-cd2c5a9cad58/`;
  evidence: `native-recipe-installed-evidence.json` and
  `recipe-lazy-closed-independent-verification.json`.
- Old comparison: `.migration-test-work/native-chat-ui-dfcfb1b7-3de2-45e4-8c0e-8879aee9208b/actual-installed-old-lazy-evidence.json`.

The first new-package attempt (4.0.29) is retained as a failure: private
approval publication could be lost to polling because the request was absent
from the UI fingerprint. 4.0.30 includes the actual publication fix. Independent
cleanup finds zero owned fixture processes and verifies six old/new VSIX hashes
unchanged. **Cleanup, owned quiesce, maintenance markers and test callbacks do
not prove atomic exclusion of all old writers or authorize production takeover.**

Latest CLI verification has three focused lazy tests passing without skips,
including actual original worker comparison, real MCP/HTTP, restart/unknown,
host-only untyped inputs and executable-byte drift denied before claim. The
last preflight hardening and separate SQL Python private-review hooks were
added after the frozen 4.0.30 installation; they have strict root/Next and
focused CLI verification, not retroactive installed qualification in that
package. The same three focused tests also pass without skips against a private
extraction of the repository-root **1804071c…** archive, using its actual
`recipe_runtime.py` (`8fb3baf4…`), compiler and command worker. This repeats the
original response/receipt/cancellation comparison with real Next SQL/MCP/HTTP,
but is not an installed original-archive UI journey
(`recipe-lazy-original-180407-focused.log`). The broader targeted run passed 33
behavioral cases but its historical
source-capture assertion fails on `resources/recipe_runtime.py` versus its
frozen pin. No historical pin was refreshed and no Next full suite was run.
An additional original-archive negative comparison exposed different
`expected_revision`/`expected_digest` rejection wording. The two strings now
match the original exactly; strict root/Next and all three original-archive
focused tests pass (`recipe-lazy-original-180407-final.log`). That subsequent
message-only fix is not in the previously frozen 4.0.30/4.0.31 packages.

**Original repository archive installed repeat:** the separate
`recipe-lazy-original-180407-old-installed.log` and
`recipe-lazy-original-180407-installed-v31.log` both exit 0. They install the
actual repository **1804071c… 4.0.22** archive, not the same-version private
80fc build. The execution-bearing old comparison remains probe-only and is
never adopted. A distinct old metadata-only profile upgrades automatically on
the same synthetic root to the immutable **4.0.31**
`a4c50d3e2675f75b0a6307b9460c78b654f4f44de2e0d2020640715b9c584186`.
Real native exact decisions, independent SDK MCP/HTTP, inert start/get,
single-step next, running-step exclusion, stored receipt/conflict, acknowledged
cancel→failed, pending preservation through two restarts and actual
effect→broker `SIGKILL`→unknown/no replay all pass again. Executable drift
preflight is now included in the installed frozen implementation; its negative
byte-drift case and the two subsequent error-message fixes still have focused
CLI qualification rather than separate installed negative-case coverage.

- Old actual comparison:
  `.migration-test-work/native-chat-ui-c91b6b89-d895-4bdf-9c77-859c1994079c/actual-installed-old-lazy-evidence.json`.
- Same-root upgrade:
  `.migration-test-work/native-chat-ui-2181a471-0b11-463f-8635-de1f8e12f4e5/native-recipe-installed-evidence.json`.
- Independent closure in the latter fixture:
  `recipe-original-lazy-closed-independent-verification.json`.

Independent verification confirms all 5,430 installed payload files, the old
generated four lifecycle/dispatch modules byte-for-byte against the original
180407 archive, three actual old effects, six actual new effects, zero model
calls, eight unchanged old/new VSIX hashes and zero owned fixture/controller
processes. Twelve relevant current product sources match the frozen snapshot;
the only thirteenth-source difference is proved to be exactly the two later
error-message literals. Subsequent legacy-writer fence changes are explicitly
not in 4.0.31. This repeat is not a global atomic-writer exclusion proof and
does not qualify default production takeover or Windows.

This qualifies **fixed explicitly authorized command nodes with single
dispatch only**, not arbitrary executables, legacy script/environment
authority, agent/report/input/gate/subflow/loop/autonomous/ad-hoc behavior or
usage/health parity. SQL/public Python execution needs its separate independent
Python authority and installed qualification; a public start decision is not a
Python grant. Original execution archives remain inert. Global old-writer
exclusion, Windows and complete migration/default cutover remain unqualified:
`fullRecipeParity: false`, `migrationQualified: false`.

### Recipe Knowledge context and complete original history — current-source qualification

This continuation is **not included in frozen 4.0.31**. Its separate private
4.0.33 installed qualification is recorded below. Existing SQL authoring, public Python
admission and controlled command/lazy behavior are reused, not counted as new
implementations.

An explicitly composed `LegacyApiChatRecipes` can now receive a host-approved
Note/Skill document scope. `readIndexedRecipeKnowledgeDocuments` selects only
those exact IDs from the existing `documents` index; it does not discover or
scan a root. The private managed fixture host opts in with
`recipeKnowledgeDocumentIds`; absent that option, bound recipes remain
unavailable. Current indexed hashes, bounded no-follow regular-file reads,
UTF-8, inode identity and the original binding semantic hashes are rechecked
before admission and each Step. Scope is limited to 128 documents / 2 MiB,
128 bindings and a 512 KiB context. Each explicitly trusted adapter receives
only that Step's data-only `recipeKnowledge` context, never another Step's
bindings. Context is not shell interpolation, an executable grant, Python
admission or permission to launch arbitrary agent/script/environment work.
Approval and catalog-source object shapes remain unchanged for Python.

`recipe.history.get` is a pure, exact-SHA read available through the scoped
native public MCP/HTTP host. It returns the original raw JSON plus the complete
parsed record, retaining definition, inputs, receipts, results, progress and
usage rather than only a summary. Private Chat adds **Inspect original Recipe
history (no resume)**. A running original is presented as UNKNOWN while its
original record remains unchanged; ownership is explicitly unattributed.
Neither the old side-effecting getter nor any worker/resume/replay is called.
Reads stay within the existing immutable archive scope (or verified
same-root legacy bootstrap), with a 200-entry / 4 MiB aggregate source budget;
returning both raw and parsed data intentionally duplicates the bounded data.
This does not relax adoption guards for execution-bearing old roots.

Current-source verification:

- Root strict, isolated Next strict and UI/helper syntax checks pass.
- **20/20 focused tests, no skips**, in a private Linux PID/network namespace:
  actual repository 180407 4.0.22 `ProjectStore` bindings; existing-index scope
  → native SQL resolver → SDK MCP compiler → HTTP admission → two real fixed
  command effects; per-Step isolation; missing authority, indexed-byte drift
  and symlink rejection. Drift after a real first effect yields UNKNOWN and
  prevents dependent-Step execution. Actual original-runtime completed and
  unresolved run bytes survive pure MCP/HTTP reads and native restart unchanged,
  with no new workflow intention or replay. Native/public/library/lazy
  regressions are included. Run serially to avoid unrelated crash-test
  processes racing the conservative legacy-writer process inspection.
- Existing SQL/public Python regression is **5/5, no skips**, using this current
  isolated Next build and the preserved original conda fixture without
  provisioning. Logs: `.migration-test-work/recipe-knowledge-history-regression.log`
  and `.migration-test-work/recipe-knowledge-python-regression.log`.

The functional fixtures explicitly project immutable original data into a
separate synthetic native root; they are **not themselves** installed same-root
upgrade evidence. The following distinct journey qualifies the bounded native
inspect UI and private indexed-host composition. Original agent/report/input execution, complex
controls, ad-hoc/autonomous behavior, general executor/environment authority,
full usage/health behavior and execution-bearing old-root recovery remain
open work, not silently mapped to command/Python success. Windows remains
required. Production gates, historical provenance pins and the meaning of
`fullRecipeParity: false` / `migrationQualified: false` are unchanged.

#### Dedicated original 180407 → 4.0.33 Knowledge/history installed slice

The original repository 4.0.22 archive was installed in a fresh private Linux
VS Code profile, activated with its real Workbench and managed MCP, then upgraded
to a separately frozen 4.0.33 candidate on the **same root/inode**. Original
runtime-produced completed and unresolved records remain in that root. They
are read as historical data, never resumed or attributed to the new actor.
The experimental root admission still uses its existing guards; there is no
filesystem Recipe library projection and no production/default cutover.

Real Playwright interactions verify a native run modal displaying both pinned
Note/Skill contents and `executionAuthority: false`; one approved native run
performs one actual fixed read/hash/fsync effect. Its trusted adapter receives
both bindings only on `inspect`, with none on `record`. Default host composition
without the document scope rejects this bound Recipe. SDK MCP, canonical HTTP
and private RPC each recover the complete original bytes/records, and the real
**Inspect original Recipe history (no resume)** button opens an ephemeral JSON
document. A complete Code/broker restart preserves the result, opens the
unresolved history as UNKNOWN, performs no replay and leaves the effect count
at one. Model calls remain zero.

- Frozen candidate version: **4.0.33**.
- VSIX SHA-256:
  `5e75cbaa8ef97d56f84b2a7df427e6a958aea9cdc3050759d3d99f4b754079b6`.
- Frozen source SHA-256:
  `6329ccb8bd183576e175b3aa9f4ebe0e628a149a67a443837f8cacc5a55b7a22`.
- Actual controller SHA-256:
  `88d510aac9d902f1ff3f933850eeaa708b32614a4ac5896e3be9abaa481e0920`.
- Fixture:
  `.migration-test-work/native-chat-ui-3dea50e6-523b-415a-ae6a-8fb06d35d204/`.
  Evidence: `native-recipe-knowledge-installed-evidence.json` and
  `recipe-knowledge-history-closed-independent-verification.json`.
- Complete installed journey: `recipe-knowledge-history-installed-v33-v3.log`,
  exit 0. First attempt had a test-only stale revision descriptor; the second
  passed product/UI behavior but failed the test's final evidence filename.
  Both failed attempts are retained. The immutable product package was not
  changed to repair these controller issues.

Independent verification checks **5,443 extension payload files** against the
ZIP (only Code's manifest `__metadata` is normalized), all **4,779 pinned runtime
files**, package/XML/runtime version 4.0.33, all nine relevant current product
sources against the frozen source rows, eight unchanged historical VSIX pins
and unchanged verification pins. The actual installed runtime passes **20/20**
focused tests and the existing SQL/Python regression **5/5**, all without skips.
All three attempted profiles have zero owned process matches by exact argv/cwd.
Code was formally handed to the next owner after cleanup.

This qualifies **scoped Note/Skill data context and pure complete history reads**,
not arbitrary executable/agent authority or ownership of original in-flight
work. The later managed-session hardening is not in this candidate; Env's
separate 4.0.32 qualification is not merged into it. Whole Recipe parity,
execution-bearing old-profile automatic takeover, global writer exclusion,
Windows and production migration remain unqualified.

### Original external-caller Recipe reports — explicit host opt-in

The original seeded catalog contains 95 nodes: 84 NoOp, four human gates,
three commands and four scripts. A NoOp is not evidence that an agent ran:
the original caller reads its `generalInstruction`, performs work under its
own permissions and commits an explicit `recipe_run_report`. Automatically
returning success would lose that workflow.

`LegacyRecipeExternalReports` now supplies an optional, explicitly authorized
adapter to `LegacyRecipeLazyRuntime`. Without this composition, report remains
unavailable and the command-only gate is unchanged. The qualified definition
shape is **all NoOp, portless, single control, no Knowledge bindings**. The
original six-node **Universal Unknown Task** meets it. The bridge preserves
`execute_node` instructions, running `report_node`, JSON results (including
null/arrays), success/failure error text, run-level usage, receipt replay/conflict,
and report's automatic claim of one successor. It does not complete that
successor without another external report.

Reports are real durable WorkflowExecutor lease/result commits, not simulated
agent execution. A fresh exact native decision is required for every public
start/get/next/progress/report request. Actor/source/revision/definition and
host policy are rechecked; a bearer, prior start approval or supplied usage
does not grant tools, launch a model or authorize filesystem/command access.
The modal declares `executionAuthority:false` and
`resultAuthority:external-caller-reported`. Interrupted claims remain UNKNOWN
and cannot accept late reports or replay work.
Inspection-only progress annotations remain supported after interruption, but
must preserve UNKNOWN/reconciliation and `replay_allowed:false`, never replace
them with an actionable `report_node`. A reproduced pre-install candidate
counterexample drove this correction; that earlier package is retained but
does not qualify the corrected installed slice.

The actual original Python runtime is exercised against genuine SDK MCP/HTTP:
six real caller file reads, result/error/null/array and failure-chain responses,
measured/estimated usage, original validation errors, receipt replay/conflict,
policy revocation, oversized-output refusal and restart/no-successor checks.
The original oracle uses a separate synthetic copy, never the adopted root.
The dedicated `--chat-recipe-reports` installed harness is separate from the
4.0.33 Knowledge/history evidence; its installed qualification must be recorded
independently, not inferred from these CLI results.

Remaining differences are mandatory work, not deferred parity: ported Reflection
nodes and branch Tutorial nodes, mixed adapters, human input/challenges,
script/agent/subflow/loop/autonomous execution, Knowledge bindings in this lazy
report path, global original usage/health aggregation, and exact Python-versus-JS
JSON diagnostics/numeric-representation parity. The bounded native path also has a five-minute
claim lease, 61,440-byte result-plus-error budget and safe-integer usage sums.
The global report entrypoint is the existing mutating `capability_call` with
operation `mcp.tool.recipe_run_report`, not an advertised standalone MCP tool.
No default activation/root switch, production data or historical pins change;
whole Recipe parity, automatic migration and Windows acceptance remain open.

#### Dedicated original 180407 → private 4.0.38 installed report slice

The original repository 4.0.22 VSIX was actually installed, activated with its
real Workbench/managed MCP, then upgraded to private **4.0.38** on the same
synthetic Knowledge Root/inode, without an import-path picker. Normal profiles
still do not start Next or switch roots.

The real renderer made **24 separate exact native decisions**: three starts,
five gets, four nexts, two progress updates and ten reports (including a receipt
replay). Genuine SDK MCP and HTTP calls reproduce the original runtime's
six-node successful run, failure chain, null/array results, retained diagnostic
text, run-level usage and receipt responses. Six actual caller file reads are
fsynced outside the root; no model is called. A directly owned broker is then
SIGKILLed while another NoOp is claimed. A complete Code/broker restart retains
UNKNOWN and five unclaimed nodes; a fresh next or inspection progress annotation
cannot turn that into execution/report permission. Effects remain six.

- Frozen source:
  `ef183a87fd9bf7f3701501bffb3326a0c333c8bd34db6ede721478b96be7367b`.
- Candidate SHA-256:
  `683dae25004e273583c9c243547e7fd3d17227f4081b816e63f7ac5cefd9d62b`.
- Build: `.migration-test-work/native-chat-ui-build-6c45d831-0000-405a-9f42-583dacf432dd`.
- Actual profile below that build:
  `build/.migration-test-work/native-chat-ui-5ed56b18-022d-4349-8705-a4ac55ff48a3`.
- Installed log: `.migration-test-work/recipe-external-report-installed-v38.log`, exit 0.
- Independent closure in the profile:
  `recipe-external-report-closed-independent-verification.json`.

Independent checks match **5,449 installed extension files**, all **4,782 runtime
pins**, version/XML/manifest, six owned product sources, nine historical VSIX
pins and unchanged `verification.json`. The exact frozen package passes
**23/23** focused tests and **5/5** existing SQL/Python regressions. The actual
installed runtime separately passes **3/3** report-focused tests, including
UNKNOWN annotation *before* any synchronizing get. All tests have zero skips.
The first, uninstalled candidate and its UNKNOWN-action counterexample are
retained; the corrected package was built from a new immutable snapshot.

The private namespace closed and independent exact argv/cwd checks found zero
owned profile processes before formal Code handoff. This is not global writer
exclusion. It does not inherit subsequent profile/lock/Environment/Collab
changes or their installed qualifications, and retains
`fullRecipeParity:false` / `migrationQualified:false`.

**Later numeric/cooperative safeguards are not in that immutable 4.0.38 VSIX.**
The separate 4.0.46 qualification below includes them; its evidence is not
backfilled into 4.0.38. A
post-install comparison found that original Python rejects usage count `1.0`,
where ordinary JS JSON parsing had erased its floating-point spelling, and
that a result integer `9007199254740993` would round. The report parser now
retains JSON number source spelling for usage validation; NoOp inputs/results
reject non-finite numbers and unsafe integer-valued numbers before any intent
or report commit. Original arbitrary-precision integers are therefore refused,
not silently changed. Original manual NoOp `cancellationRequested` is also
preserved as cooperative progress metadata: it does not signal a command
process or pretend to stop an external caller. Owned command cancellation
continues to use its existing adapter. Report/command focused regression passes
**6/6**, zero skips, with Root and Next strict compilation. This does **not** retroactively qualify
these safeguards as installed in frozen 4.0.38; malformed-JSON diagnostics and
floating-point protocol-estimate formatting remain differences.

### User-authored static Recipe branches — additional explicit opt-in

The external reporter can separately enable `staticBranches:true`. The default
still excludes branches. Only all-NoOp, statically declared branches and single
nodes without Knowledge bindings are admitted; dynamic cases, gates and mixed
automatic adapters are not covered. Portless branches remain supported by this
flag alone; nodes with declared ports additionally require `portedNoops:true`.
A case is a real native WorkflowExecutor `branch`, not a fabricated `succeeded`
outcome. Public results, accepted outcomes and persisted history retain that
case while native dependency selection skips the other path and admits an
explicitly defined join. No execution kernel, production activation or default
root gate is changed.

The original immutable ProjectStore actually authors a four-node evidence
workflow: inspect file bytes, select `valid` or `invalid`, record or repair
exactly that path, then archive the selected artifact. The unchanged original
Python runtime is the oracle. Native SQL definitions are separately authored
through real HTTP `recipe.library.save` with a fresh exact host decision, not
injected as test SQL or passed as additional fixture Recipes. Comparison of
this new native copy normalizes only its intentionally new ID/revision; the
executable digest, inputs, raw results, outcomes and protocol receipts match.
Real SDK MCP/HTTP callers perform actual file reads, copies and fsynced writes.
Five original-runtime scenarios cover both branches and their join, cooperative
cancellation reported as failure, a real caller ENOENT, and inspection failure.
Revocation and restart checks retain the known selected case and skipped path
while fencing the interrupted claim UNKNOWN; neither replay nor switching
branches may resume it. Branch/report/command regression passes **8/8**, zero skips.

This investigation also executes the original seeded **PKM Tutorial** start:
its edge accepts `succeeded` from cases `known/unknown/validated`, so the original
runtime rejects it. It is not silently rewritten or counted as a migrated
successful built-in. Original manual `execute_node.inputs` are run inputs;
declared ports alone do not prove that the old caller received an automatic
`fromOutput`/`toInput` value mapping. Ported Reflection and human gates remain
mandatory unresolved workflows, not successful branch evidence.

`--chat-recipe-branches` provides a separate original-install → private candidate
journey using the actual original-authored root metadata, not a filesystem
Recipe projection or injected native graph. It includes a real broker SIGKILL
after case commitment and before selected-path reporting, followed by complete
Code/broker restart.

#### Historical original 180407 → private 4.0.46 portless branch slice

The original repository VSIX was actually installed and activated with its
real Workbench and managed MCP, then upgraded to **4.0.46** on the same
synthetic Knowledge Root/inode without an import-path picker. The renderer made
**40 separate exact native decisions**: six starts, seven nexts, seventeen
reports (including receipts), two progress updates and eight gets. Genuine SDK
MCP/HTTP reproduce all five original-runtime scenarios; the independent caller
actually validates/repairs files, archives the selected artifact and fsyncs
nine evidence entries. No model is called. This qualifies original ProjectStore
API authoring and native execution, not a claim that the historical Workbench's
known failing save route has been repaired.

After an `invalid` case is committed and `repair` is claimed, the actual broker
is SIGKILLed. Complete Code/broker restart preserves the known case and skipped
`record-valid`, leaves the selected claim UNKNOWN, and neither replays it nor
switches branches. Independent native SQL inspection verifies those states
and exactly two dispatches. Native execution cancels the unclaimed join; the
legacy inspection view retains its original pending projection, not permission
to resume. First failure reports `required-node-skipped`; subsequent get uses
the original `recipe-failed`, while cached receipts retain their original response.

- Frozen product source: `d5c61f1b97719671f1700d8fdf4e150645dae9b20780a05159627c621825dbad`.
- Immutable VSIX: `016ee133389813484d09bc47d4cfe4fea0daf27621323c96a4fcd6ee5be198cc`.
- Build: `.migration-test-work/native-chat-ui-build-c0ff2212-2555-4c5d-801d-ea7a56800932`.
- Successful private profile:
  `.migration-test-work/recipe-branch46-controller-d68cd38c-a88b-4b99-8254-8c29f3ae452d/.migration-test-work/native-chat-ui-75baa499-dcb6-450a-9e12-38d65ec5e7b7`.
- Independent report there: `recipe-static-branch-closed-independent-verification.json`.

The first installed attempt reached the last scenario but failed at MCP session
17: the one-shot test caller closed its SDK client without sending session
DELETE, exhausting the server's unchanged sixteen-session bound. Its exit-1
log/profile are retained and are not counted as complete. A **separate frozen
test-controller overlay** adds explicit SDK `terminateSession()`; the original
snapshot and VSIX are untouched. The successful controller SHA-256 is
`73c169714bfab7ff4d5c90f1130c9cd06b472604a9f07a1a9bb01375bb9a4985`;
the report records that sole test-only delta rather than claiming the original
controller was unchanged. No server limit or authorization check is relaxed.

Independent closure matches **5,453 installed files** (5,452 extension ZIP files
plus Code's byte-identical copied `.vsixmanifest`), **4,782 runtime pins**,
version/XML/package, six owned product sources, ten historical VSIX pins and
unchanged `verification.json`. Only Code's `package.json.__metadata` is excluded
from the otherwise exact package comparison. Root build and Next strict pass;
the exact frozen runtime passes **11/11**, and the actual installed runtime
passes **8/8** branch/report/command regressions, all zero skip. These include the
post-4.0.38 numeric/cooperative safeguards. Both failed and successful private
namespaces exited; exact argv/cwd checks found zero owned processes before
formal Code handoff to the profile agent.

This slice cannot inherit Environment, Room or profile-rotation qualifications.
Ported Reflection, the original invalid Tutorial, gates and the other mandatory
remaining differences above are not completed by these branch tests.
`fullRecipeParity:false` / `migrationQualified:false`, production/default
activation gates and Windows acceptance remain unchanged.

#### Original 4.0.22 → private 4.0.23 ported-branch verification

A later, separately frozen candidate exercised the new `portedNoops:true` gate
on the actual original-authored four-node branch recipe. The old Python oracle
confirmed that each old `execute_node` still receives only the original
run-level inputs; the new executor additionally mapped `inspect.sha256` into
the selected branch node while retaining the legacy-facing input view and raw
caller result/error. Exact declared output names were required, the other path
was skipped, and the join completed. Focused cancellation, cooperative failure,
and broker-SIGKILL/full-restart cases verified late-report rejection and
UNKNOWN/no-replay behavior.

The private installed journey upgraded the untouched original **4.0.22** VSIX
to the staging-only **4.0.23** candidate on the same synthetic Root and inode.
The installed evidence records nine caller effects, zero model calls, the
selected case committed before SIGKILL, and full restart recovery without
replay or path switching. Final root/installed identity was independently
verified; the exact candidate fixture process search was empty after exit.

- Frozen candidate source SHA-256:
  `24fae8157b04efb0a65068cdcea47d079fc786654843d78933a4ab5ba709e90a`.
- Candidate VSIX SHA-256:
  `fe1c297880b00b3661249aec9bd120d7f49ce9caa66890d75d7728c0815e8ece`.
- Private build:
  `.migration-test-work/native-chat-ui-build-df449b3f-0f20-40be-8df4-0f184a8b20b1`.
- Private profile evidence:
  `.migration-test-work/native-chat-ui-a99b2fd1-b3da-4a04-860f-ed97ad07add3/native-recipe-branch-installed-evidence.json`.

This qualifies only the synthetic ported NoOp/static-branch slice. Reflection,
gates, mixed adapters and complete Recipe parity remain open. It does not
change production activation/root behavior, historical provenance pins or
Windows acceptance.

### Explicitly ported NoOp reports — separately gated

`portedNoops:true` remains an additional adapter opt-in and does not broaden the
static-branch or separate `humanGates:true` permissions. Ordinary Native
invocations still enforce declared output-port shapes and apply dependency port
mappings. **That Native behavior is not the legacy compatibility contract.**

The original 4.0.22 ProjectStore/Python runtime was exercised on an isolated
four-node ported branch fixture. Its callers still receive the original
run-level inputs for each `execute_node`; declaring `fromOutput`/`toInput` did
not make the old runtime map values automatically. Legacy Lazy runs now persist
a host-only `legacyRunInputs:true` mode: actual adapter invocations, their
input digests/data authorization and caller responses all receive the original
run-level inputs, including collisions with port names. Legacy NoOp reports
retain arbitrary bounded JSON results rather than requiring declared port keys.
The actual old-runtime comparison deliberately reports an object containing no
declared output keys, then follows its selected path and join with unchanged
global inputs. Ordinary Native mapping/strict-output regression tests remain
separate and pass; legacy ports are not silently reinterpreted as Native ports.

Focused source/old-runtime tests pass with the private original 4.0.22 VSIX
fixture. The additional Reflection/Gate evidence below does not change whole
Recipe qualification, ordinary activation, production Root handoff, Windows
acceptance or `migrationQualified:false`.

### Original Reflection and human-input compatibility

The original installed 4.0.22 built-in **Reflection**, its extracted MCP Python
Skill-ranking/feedback functions and the original Recipe runtime run on an
isolated copy. Next follows the same three nodes with deliberately colliding
global `reflection`/`skills` inputs, actually calls the local Skill handlers
through the MCP SDK, compares selected Skill IDs/content hashes, and writes
real `_feedback/skill-usage.jsonl` evidence without changing the formal Skill.
Retrieval is explicitly unavailable in the offline original oracle; its real
local fallback executes. This proves local external-caller orchestration, not
automatic agent reasoning, remote retrieval or automatic model execution.

The original **Publish Personal Knowledge VSIX** definition is itself invalid:
its dependency accepts `succeeded` from a gate that emits
`approved/rejected/failed/skipped`. The original runtime refuses it. No publishing
action runs, and the source definition is not silently repaired. A separately
labelled synthetic Recipe copies its original Gate with an `approved`
dependency to a harmless evidence node. Original/Next comparisons exercise
explicit approval, rejection, the unchanged challenge across restart, and
global inputs after approval.

`recipe_run_submit_input` is separate from ordinary reports and requires the
current run/node/challenge plus a valid explicit approval/text/choice response.
Public requests require a fresh exact host decision; a protocol bearer or an
agent report cannot approve a Gate. As in the original runtime, supplemental
response fields are retained; they cannot replace the configured explicit
boolean/text/choice decision. The original-runtime oracle and focused tests
also verify that additional evidence does not silently disappear.
Focused tests cover stale/malformed input,
revoked authority, one-shot public decisions invalidated by progress, journaled
input interrupted before completion, and recoverable waiting-lease expiry.
Only side-effect-free waiting Gates resume; ordinary interrupted work stays
UNKNOWN and is never automatically replayed.

Production `startStandaloneHost` now composes these existing Recipe authorities
through `legacy-recipe-host.ts` when the embedding host supplies an explicit
function-valued `legacyRecipes` policy. It uses the already-opened Knowledge
Root without another path selection, native SQL library, actual public Core
dispatch, host-only review and orderly shutdown. A real isolated HTTP test
verifies waiting-Gate restart, exact rejection, bearer denial and consumed
approval; existing standalone Chat tests also pass. This is production-host
plumbing, **not an automatic/default upgrade or full parity claim**: ordinary
activation still lacks complete safe Recipe policy/UX integration, automatic
agent execution, mixed/subflow/dynamic control qualification and Windows
acceptance.

The production `startManagedClientHost` now forwards that same explicit
function-valued policy and, only when composed, exposes an embedding-only
`recipeContext()` for state, exact previews/approvals and lifecycle dispatch.
Its actor is fixed to the managed local owner. This does not extend ordinary
document operations or grant Recipe authority through configuration JSON,
HTTP/MCP bearer credentials or agent output. Review and execution share managed
admission/draining; retained contexts stop working when shutdown starts, and
approvals do not survive restart. With no policy, the capability is absent.

The new Linux namespace test executes the genuine original 4.0.22 raw-port and
Human Gate oracle, copies its unchanged definitions using real native
`NativeRecipeLibrary.save` calls, and runs them through the actual production
managed host. It checks global inputs/raw reports, preserved challenge and
supplemental human evidence after restart, fresh one-shot decisions, refusal
of ordinary reports for Gates, unchanged original source and zero provider
access. **This is a native-library-copy test, not same-root adoption or an
installed-profile journey.** An attempted partial old-bootstrap fixture was
correctly refused by existing adoption guards; those guards were not relaxed
and missing telemetry was not fabricated. Next strict compilation and 24
bounded Recipe/managed/standalone tests pass
(`.migration-test-work/recipe-managed-production-focused.log`, no skips).
The ordinary managed child now supplies a production policy on its eligible
fresh native workspace, rather than requiring a test-injected Recipe policy.
It permits only bounded caller-reported NoOps/static branches and explicit
Human Gates. No command/model/automatic-agent/Knowledge adapter is granted.
The existing Recipes command reuses the original Graph/JSON Workbench, with
exact host confirmations for saves and every lifecycle request, including
inspection. It supports human approval/rejection, real caller reports,
progress and **cooperative** cancellation requests; requesting cancellation
is not a fabricated terminal result or permission to stop another process.
Closed panels, revoked trust, changed workspaces and declined decisions cannot
commit saves. Imported read-only browsing retains its existing behavior;
imported writer/Room-only hosts do not thereby acquire this owner capability.

A separate recovery entry reopens only a previously created native workspace
whose root/database/marker identities match an independently retained extension
SecretStorage pin. It does not import, repair or adopt an original Root, accept
a backup's self-issued grant, or restore old approvals. The actual ordinary
child CLI test passes save denial/acceptance, controlled execution, Human Gate
SIGKILL recovery, fresh decisions, honest cooperative cancellation and a changed
pin's refusal. Seventeen focused Workbench/old read-only UI cases also pass.
`run-managed-recipe-profile.js` provides a distinct real-renderer installed
journey using ordinary extension activation, original Workbench controls and
native dialogs, without approval/backend mocks. Its new installed acceptance
is still pending; the earlier 4.0.58 installation does not qualify this path.
Complete automatic original-root takeover and Windows remain unqualified.

The separately frozen **original 4.0.22 → private 4.0.58** installed journey
completed with exit 0 in a private Linux user/network/mount/PID namespace and
isolated VS Code profile. It uses that production Recipe composition, not a
test replacement for the executor. Real UI approvals drive HTTP and SDK MCP
lifecycle requests; local Skill handlers write exactly one feedback record and
leave the formal Skill unchanged. The original raw-port branch completes
without declared output keys, and all downstream caller inputs remain global.
An approved Gate advances only to synthetic evidence; a second waiting Gate
survives actual broker SIGKILL and complete Code restart with its original
challenge, then records an explicit rejection. The synthetic dependency is not
the invalid original publishing Recipe. Model calls remain zero.

Final original-root inode/content and installed-payload identity checks passed.
An independent exact fixture argv/cwd scan found zero owned processes after the
private namespace exited. This installed candidate covers boolean Gate
responses; the subsequent supplemental-response-fields change is separately
verified against the actual original runtime and focused source tests, not
retroactively attributed to 4.0.58.

- Frozen candidate source SHA-256:
  `d3a745413e0e468d695ea7de2290a5b00d297e89cdd0c78f6f1ce64c6f1f86a5`.
- Candidate VSIX SHA-256:
  `e3881734d2aa1c3b96207e1cabeef7fc725f21759f69782b793ef5ea3c9d3837`.
- Private build:
  `.migration-test-work/native-chat-ui-build-8d388202-568d-44fb-b11e-d021db72117b`.
- Installed evidence within that build:
  `build/.migration-test-work/native-chat-ui-35793593-c51a-4f56-8839-4203e89aa35d/native-recipe-reflection-gate-installed-evidence.json`.
- Independent cleanup:
  `.migration-test-work/recipe58-cleanup.json`.

These are real bounded installation results, not full automatic-upgrade
qualification; `fullRecipeParity:false` / `migrationQualified:false` remain.

Historical provenance pins are unchanged. The executor source-capture test
currently fails first on `resources/recipe_runtime.py` (pinned
`8fb3baf4…`, current `2342ea42…`); captured files themselves match. Separate
current-source mismatches also include `workflow-executor.ts`,
`workflow-executor-contracts.ts` and `domain/workflow-executor-state.ts`.
Functional regressions and explicit old-VSIX oracles are run separately; their
success does not repair or override that historical capture failure.

## File watcher resource limits

PKM uses non-recursive native directory watchers with a shared maximum of **64
per Extension Host** across knowledge content, Project/Recipe state, Chatrooms
and the Chat library. It does not register recursive VS Code watchers for these
trees. Multiple VS Code windows have separate Extension Hosts and therefore
separate budgets; this is not an OS-account-wide limit.

Directories beyond the native budget are still checked by metadata polling
every 15 seconds (plus scan time). Native events trigger a debounced metadata
check; system allocation failures such as `ENOSPC` are reported and leave polling
active. Dependency/cache trees such as `node_modules`, `.git`, `.venv` and
`__pycache__` are excluded before descent, not only after receiving events.
Child symlinks are not traversed; an explicitly configured symlink root works.
System trees such as `/usr` (including `/usr/lib`), `/lib*`, `/etc`, `/proc`,
`/sys`, `/dev` and `/run`, filesystem roots, macOS system directories and Windows
Windows/Program Files directories are refused, including symlink aliases.
This refusal stops both native watching and fallback polling and reports an
error asking for a dedicated Knowledge Root. The five-minute signature check
uses the same guard.
Chat polling only visits namespace-level Chat records and `library.json`;
Action Run polling does not descend into execution workspaces or artifacts.
The separate five-minute knowledge-signature sweep remains a safety check.

If an older PKM build already exhausted the system watcher limit, installing the
fixed build alone does not replace watchers held by running Extension Hosts.
After updating, save your work and use **Developer: Reload Window** in affected
windows. The change does not raise system inotify limits or stop other processes.
Run `npm run test:file-watchers` from the extension source to verify the shared
budget, polling fallback, notifications and disposal.

## Copilot CLI / SDK registration

Installing PKM does not automatically modify Copilot CLI's user configuration. If the CLI / SDK
session already exposes PKM tools, no additional registration is needed.
Otherwise, after creating the managed runtime and generating the server:

1. On the machine/account where Copilot CLI will run, use **PKM: Register Copilot
   CLI MCP (User)** in the Command Palette, or **Register Copilot CLI MCP (User)**
   under **General & MCP > MCP**. Review the host, account configuration path,
   Knowledge Root and launch command in the confirmation. Install Copilot CLI if
   `copilot` is unavailable.
2. Confirm to add `mcpServers.pkm` to the default `~/.copilot/mcp-config.json`
   (`%USERPROFILE%\.copilot\mcp-config.json` on Windows). Existing bytes are backed
   up beside that file as `mcp-config.json.pkm-backup-<id>`, and unrelated entries
   are preserved. Matching configurations are not rewritten. Differing `pkm`
   entries (including disabled servers or restricted tool lists), equivalent
   aliases, malformed JSON, symlinks and configuration changes after review are
   rejected rather than overwritten. Review conflicts manually; do not add a
   second registration. Alternatively, copy the machine-specific snippet and
   merge it manually after making your own backup.
   Copilot CLI uses `type: "local"`, not VS Code's `type: "stdio"` / `servers`
   format. The snippet uses the managed runtime and includes the Windows launcher
   environment when needed. `tools: ["*"]` exposes enabled PKM tools, subject to
   client consent.
3. Run `copilot mcp list` and `copilot mcp get pkm`, then start a new CLI / SDK
   chat. If a VS Code-hosted session still has the old tool list, run
   **Developer: Reload Window**. Enabled confirms registration only; verify
   discovery and an actual `check_version` call through the agent.

This registration is per machine and OS account, not per project. For Remote
SSH, use the remote account's configuration and run Copilot on the remote
machine, not Linux executable paths on a local Windows client. Update the entry
after moving the managed runtime or server directory. PKM does not automatically
write or refresh external client configuration. Custom CLI `--config-dir`
locations are not modified: inspect that client's actual configuration instead.
CLI and VS Code are separate clients; a CLI entry does not replace or suppress
the VS Code native provider.

### VS Code native Copilot Agent discovery

`~/.pkm/mcp-binding.json` is PKM's account binding, **not** a configuration file
that VS Code or Copilot CLI reads. A saved binding alone does not prove either
client has discovered PKM.

1. In the relevant local or remote VS Code extension host, run **PKM: Configure
   VS Code MCP Discovery**, also available as **Configure PKM MCP...** in
   **General & MCP > MCP**. Choose **This machine's account** (recommended,
   extension-managed native provider across workspaces on this host account),
   **VS Code user / profile** (this profile's user MCP file), **Workspace folder**
   (the selected folder's `.vscode/mcp.json`), or **Do not configure**. On Remote
   SSH these choices apply to the remote extension host, not the Windows-local
   account. Choosing no configuration changes nothing; Chat remains usable
   without PKM MCP tools. No independent stdio server is silently started.
2. The command checks the current profile's user `mcp.json`, open workspace
   folders' `.vscode/mcp.json` files (JSONC supported), and legacy `mcp.servers`
   settings for conflicts. Back up and remove matching manual entries yourself
   before switching to account scope. Explicit profile/workspace setup preserves
   other entries and JSONC comments, backs up the existing file, and disables the
   account provider to avoid duplicates. Review the file path before confirming;
   workspace configuration may be committed to Git. Other profiles/adapters cannot be fully inventoried from
   this host; review those before confirming. Existing manual ownership stays
   suppressed until you explicitly select the native provider. A changed
   account binding is backed up beside `mcp-binding.json`.
3. Run **MCP: List Servers**, find **pkm / Personal Knowledge Manager**, review
   the native trust/start controls, and enable the tools in Copilot **Agent**
   mode. Call `check_version`, then repeat discovery in a second workspace on
   the same target/account. If the client list is stale, use **Developer: Reload
   Window**. Configuration commands do not start MCP or grant trust themselves.

On Windows the generated CLI entry and native definition both use the signed
`Code.exe` host, packaged JavaScript stdio proxy, absolute managed Python/server
paths, and `ELECTRON_RUN_AS_NODE=1`. Do not replace this with a bare Python launch.
If an extension upgrade moves the versioned proxy path, review and update the CLI
entry; conflicting older entries are intentionally not silently replaced.
Discovery/status checks do not spawn Python to build the native definition.
Definition available, CLI configuration matching, client discovery, trust,
connection and callable tools are distinct states. Windows-local live discovery
still requires verification on that Windows machine; Linux/Remote SSH tests
cannot establish that a local Windows client is configured.

Settings no longer offers **Inject / Update All** or a copyable MCP installation prompt. Runtime maintenance does not recreate Agent Router files. Run **PKM: Remove Legacy Agent Injection** to confirm private backups and removal of earlier PKM-managed adapters. Canonical Skills and user-authored files are preserved.

### Local recovery snapshots and MCP-only writes

MCP `delete_note`, `delete_skill` and `delete_paper` use PKM Trash and the shared
deletion journal. Restart an existing MCP connection after upgrading; an old
Python process retains its old deletion implementation.

Use `knowledge_snapshot_create` for an immutable, annotated Git tag containing
the actual knowledge bytes. The isolated repository is
`<knowledge-root>/.pkm/state/knowledge-snapshots/repository.git`; it does not
change the development repository's branch/index or upload private contents.
This is local recovery protection, not off-machine disaster recovery.

On Linux, `knowledge_snapshot_configure(enabled=True, local_time="17:00",
timezone="America/Los_Angeles")` installs a persistent user systemd timer.
`knowledge_snapshot_status` reports the schedule, UTC next run and PST/PDT.
17:00 PST corresponds to 01:00 UTC the following day; 17:00 PDT corresponds to
00:00 UTC the following day. The time and timezone are configurable. The user
systemd manager must be running; `Persistent=true` catches a missed run when
the timer starts again. Other platforms currently support manual snapshots,
but not this persistent Linux scheduler.

Restore requires `knowledge_snapshot_restore_preview` followed by
`knowledge_snapshot_restore_apply` with the approved preview hash. It first
creates a safety snapshot; replaced/extra files go to Trash. Current privacy
configuration is preserved, not weakened by historical settings.

For new Linux CLI Agents, [protected-agent.py](../../scripts/protected-agent.py)
requires bubblewrap and fails closed when it is unavailable. Run
`python3 scripts/protected-agent.py --knowledge-root /path/to/knowledge --workspace /path/to/knowledge/packages/project`
to launch Copilot, or add `-- command arguments` for another CLI. The parent
filesystem and knowledge are read-only; only the development workspace and
Copilot runtime are writable. A trusted MCP child runs outside the sandbox and
is reached through a stdio broker. Do not place its executable or generated
server in the writable development workspace. This does not retrofit isolation
into existing VS Code Agents; workspace/user MCP-only instructions are policy,
not an OS permission boundary. Re-run via the launcher for enforced protection.

See the [complete installation guide](../../FEATURES.md#installation-guide) for the walkthrough and troubleshooting details. Runtime/server readiness does not prove client discovery or retrieval completion; verify them separately.