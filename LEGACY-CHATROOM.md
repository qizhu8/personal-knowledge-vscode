# Legacy Chatroom compatibility

The retained Room hub uses WebSocket and HTTP, a shared Room join secret, and a
separate Host credential stored in VS Code SecretStorage. The old lifecycle
checks the Host credential against the Room database before rehosting. Its
automatic participant reconnect uses a client ID, which is not an authentication
credential.

The experimental native adapter can verify the old credential and join secret
against the unchanged archive, independently check a host-supplied actor policy,
and restore the historical Host participant. Its one-use grant rechecks the
policy, secrets, archive and workspace lease. Network binding is explicit and
requires this credential grant; the default remains loopback. The retained
protocol uses plaintext `ws`/HTTP, as before: network exposure must be selected
and protected by the actual host, not silently enabled.

`next-room-host-bridge.ts` and `legacy-chatroom-vscode-host.ts` provide a
Room- and actor-bound inherited child IPC bridge to the extension's real
SecretStorage. The caller must pass the already workspace-owning Storage, a
fixed `local:owner` binding from the trusted Room action, and a live authority
callback. Revocation or IPC disconnect drains the Room; the parent must call
`close()` immediately on a known revocation, with periodic revalidation as a
backstop. The bridge does not accept an MCP actor or let the child select a
different Room.

Without a qualified workspace owner injected before Room UI initialization,
the existing production Room UI still starts the old hub. The fresh isolated
Next trial now has a **Host an isolated legacy Room** action: it copies one
closed Room without a Meeting archive from a private source disjoint from the
live root, checks the old Host credentials in the actual profile SecretStorage,
and uses the existing
managed workspace owner and inherited IPC bridge. It supports loopback Host
messaging, attachments, a local Magic Link, Stop and rehost in the same trial.
It is not the original Room UI or the default production host. A failed copy
may leave a partial destination; preserve it rather than retrying. The trial is
disposable and is not a same-root adoption path.
`chatroom-secretstorage-journey.mjs` exercises the action with a real VS Code
extension host, actual Host SecretStorage and packaged Next child in a
synthetic extension/private profile. Setup selections are scripted, but the
identity-approval dialog is real and is clicked through the VS Code renderer.
A separate peer process recovers the historical agent, saves its credential
in a private file-backed test store, restarts, and reconnects again after Host
rehost on the same port. This does not verify a separately installed VS Code
participant profile or a production upgrade.

An additional Linux installed-profile journey used the original 4.0.22 VSIX
and a frozen private 4.0.43 candidate, two independent profiles and separate
veth-connected network namespaces. The original Host reused the Guest's
historical identity without approval. The upgraded Host's actual dialog denied
one old-client request and approved two subsequent old-client rejoins. A later
unexpected network interruption triggered an automatic old-client retry that
also required Host approval. After the Guest upgrade and one approval, its original identity and history were
restored. Manual rejoin, including after a full Guest process restart, required
no further approval; the UI did not reopen the Room automatically. An
unexpected network interruption reconnected automatically without approval.
Setup selections used a test driver against the installed Host's VS Code API;
the Host credential, participant SecretStorage and approval modal were real.
The isolated profiles used VS Code `--password-store=basic`; this does not
qualify an OS keyring or encryption at rest.
Explicit Host stop closed the Room; same-trial rehost and manual rejoin through
the original Join form restored the same identity without approval. This
corrected runner exited 0; its evidence is
`.migration-test-work/room-installed-e4bd65e5-404d-485f-909d-6a5dee1e37c7-verification.json`.
The earlier runner exited 1 when it clicked a hidden Leave button; that
failure remains separately documented in
`.migration-test-work/room-installed-78a8ac75-78c7-4158-9965-a3b3c9256209-partial-verification.json`.
A separate 4.0.54 private candidate adds explicit Room-only recovery after a
complete Host process restart. Starting a trial and selecting the previously
used trial directory offers a confirmation, then the Host chooses the
reconnect policy and confirms hosting again. It does not automatically start
a Hub or open other trial workflows. The profile stores a pin for the most
recently hosted isolated Room only: canonical trial and existing Root paths
and identities, workspace/database/marker identities, workspace and Room
IDs, archive fingerprint and Host credential hash. Recovery requires the
original Host SecretStorage credential and matching archive, and fails closed
on a replaced directory, marker, database, changed Root, archive or competing
writer. The native writer fence remains in force. Only one copied Room archive
is admitted by this recovery path; another archive requires separate work.
The child opens storage with general recovery deferred and admits only the
pinned Room, not document, Python, import or other workspace operations.
The normal workspace/adoption admission remains unchanged.

The current experimental implementation extends that single-pin design:
independently pinned Rooms in the same private trial can be hosted concurrently
on one loopback Hub, and each can be closed or explicitly rehosted separately.
All Rooms on a Hub share its port and reconnect policy, but each requires its
own original Host credential and independent approval routing. On restart no
Room starts automatically; the user selects the first Room, then can explicitly
add other pinned Rooms. The v1 profile pin is retained when upgraded to the v2
multi-Room index. Recovery admits only the exact, duplicate-free pinned archive
inventory; an unexpected, removed or changed archive blocks recovery rather
than granting authority to copied data. A failed copy before its Host pin is
saved may therefore require manual reconciliation. Other trial operations and
the normal Root/adoption gate remain unchanged. `ws` and the HTTP attachment
transport are plaintext, including when forwarded outside loopback.

## Qualified-owner route for the original UI

The original **Host Room** handler now goes through
`ChatRoomManager.requireHub()` and `src/chatroom/room-host-owner.ts`.
A trusted workspace host must explicitly register its exact root, workspace
identity, live authority guard and Hub factory **before** the legacy UI is
initialized. Only a genuinely new Next workspace or a production-qualified
adoption is eligible. `experimental-unqualified` is rejected; marker files,
journals, adoption commits and successful `Storage.open()` are not admission.
There is currently **no production-qualified adoption caller** registering this
owner, so unselected production activation still uses the old Hub. This is a
real conditional adapter, not a completed production cutover.

An explicit profile-selected Collaboration workspace is now composed by the
product entry described below. It registers a genuinely new, separate Next
workspace, not an `adopted-production-qualified` legacy root. Profiles that
have not made that selection still use the old Hub.

### Product profile selection and original archive recovery

`PKM: Upgrade This Profile's Collaboration`
(`personalKnowledge.upgradeCollaboration`) is registered by real product
activation, before `applyChatArchiveCfg` initializes its Room route. Its source
is the existing product `resolvedStorePath(context)`, before `initStore`
initializes `getStorePath()` to that same root, not a fixture source or
environment override. The original `ChatRoomCredentialStore` reads
`personalKnowledge.chatroom.<roomId>.host` and `.join` from the actual product
profile's SecretStorage. Neither the deprecated `chatSharedSecret`, a Room
invitation nor an installation ID can manufacture the separate Host credential.
The product upgrade does not copy Host credentials from snapshots or another
profile. Restoring an existing full profile backup is a separate, explicit
authority prerequisite, not something a join invitation can do.

One explicit confirmation normally stops this window's old Hub, including its
normal Meeting adjournment. The existing journaled Room/Meeting admission copies
the original closed archives and exact canonical/manual Meeting Note bytes into
a new private workspace under this profile's `globalStorageUri`. The source
root need not be chmodded private: ownership, real paths, unchanged source file
identities/content and original Host proof remain checked; destination and
receipts stay private. Existing admission pins are not rewritten. Incomplete
credentials, changed sources or conflicting partial copies refuse rather than
overwrite either version. Preserve partial copies for reconciliation.

The selected workspace has one persistent `next-collaboration-child` Storage
owner. Its inherited IPC uses the live product SecretStorage and original
Manager approval callbacks. It is not a temporary MCP request, second owner of
the MCP workspace, injected fixture factory or general old-root adoption.
After the profile selection is durably observable and the user reloads, real
activation recovers that same workspace **before** the ordinary Host/Stored
Room and Meeting handlers initialize. The original Manager uses its IPC facade;
Meeting snapshots/Notes use the existing owned Core reducer. Original general
Note files and other PKM workflows remain on their existing configured root.
The copied canonical Meeting Note opens through the existing read-only owned
Note provider; it is not republished into the public Notes library.

Unselected profiles retain the original route without an environment switch.
A saved Next selection that cannot recover is blocked, not silently redirected
to the old writer. A confirmed selection pending reload also blocks another
old writer in that window. The selection key includes this profile's actual
`globalStorageUri`, not just the source root, so a shared credential backend
cannot opt another profile into that source. Malformed saved selections stay
blocked and cannot silently start a new bootstrap. An explicit bootstrap retry
revalidates every source Room, including remaining Rooms after a partial
admission; it cannot select just the first successfully copied Room.
`PKM: Collaboration Storage Status` displays the route; its command result and
the bounded `_personalKnowledge.nextCollaborationStatus` expose the live owner
binding without returning secrets. Changing retained source
Room/canonical Note bytes later requires reconciliation; this is not continuous
replication of later edits to the old archive.

The existing machine configuration has different meanings: `chatHubPort`
selects the listen port; `externalLinkHost` (with existing `chatInviteHost`
fallback) is the advertised hostname/address; `chatHubUrl` is only a network
endpoint hint, not Host authority. The selected owner can query that configured
endpoint's new `POST /api/native-rooms/<id>/owner`. Request and response use
separate original-Host HMAC purposes, nonce binding/replay receipts and matching
Room content lineage. Workspace ID, actual local source fingerprint and explicit
active/released status come from that live owner, not a fixture directory.
Missing contact is not release. A legacy-only server cannot impersonate this
new authenticated protocol. Remote transcript synchronization retains its
explicit file/Meeting/Note limitations; original archive recovery above is a
different local workflow. There is still no distributed owner lock.

This preserves plaintext `ws`/HTTP, including attachment transport. A hostname
is not TLS; original Host authorization and participant recovery policy are
separate. Product compatibility defaults to the old shared-secret/client-ID
reconnect interaction, including its impersonation risk. The separately named
`personalKnowledge.nextCollaborationStrict` setting defaults to `false` and
requires a reload. Enabled strict mode asks Host approval on **every**
unmodified old-client identity recovery, including retries, and adds a clearly
labelled one-operation Portal owner confirmation. Original pairing, receiving
permissions, Chat policy and file-batch approval remain mandatory.

The explicit product composition now supplies Portal admission through the
same persistent child. Its one-use exact command grant is consumed there;
the original product process supervisor executes in the original PKM context
and keeps its durable `(pairId, requestId)` receipts. Hub stop/child exit abort
that execution; lifecycle-epoch checks cannot confuse a still-live but stopped
owner with a valid execution admission. This capability is explicit, not a
generic legacy fallback: other injected owners remain command-only unless
they separately implement retained-context support. Models/tasks and files
retain their original product authorization; this is not their Core migration.

Original Project/thread IDs are read from copied Room metadata without
changing the archive fingerprint or historical pins. The original Project
store verifies the pair and any existing Room association read-only before new Project-bound
creation. Default compatibility keeps original Host authority for existing
Rooms even when an old Project link is missing; strict mode additionally checks
that existing binding before hosting. Denied Rooms remain visible without
preventing the rest of the profile from opening. New Rooms store the pair in
owned Core state. A retry between Room
creation and original Project linking returns the same Room, including while
it is active; it does not reset connected identities. Canonical numeric-leading
Room UUIDs are accepted by Project association validation, unlike the old
letter-leading general-object-ID rule. Retained archive deletion is still
unavailable. Full same-root/default PKM adoption remains separate unfinished
work.

The current source-focused regression has 52 passing cases in
`.migration-test-work/collaboration-portal-product-source-v6.log`, including
stop after grant consumption but before the parent executor continuation.
Earlier injected-owner Portal fixtures and the 4.0.836 Room/Meeting result below
do **not** qualify the newer integrations.

#### Installed Portal/project/transcript-only takeover — 2026-11-14

The separate frozen private 4.0.837 candidate (SHA-256
`3239baf9fba5b2a084a0c3ffdf8f119f0e62daa87dcdc62b361d385bca09ec22`)
passed `collaboration-complete-product` in
`meeting-installed-10d2d601-1049-4b9d-a7d0-2d49390ef83a`.
`.migration-test-work/collaboration-complete-product-verification.json` binds
that package, all 1,146 frozen source inputs, 4,937 pinned payload files, actual
live observer/controller hashes, original compiled-module hashes and cleanup.
It is a private installed qualification, not a release or default PKM cutover.

- Actual original 4.0.22 activation established independent Host/Guest identities,
  a Project-linked Meeting Room and a separate transcript-only handoff Room.
  The second private profile explicitly restored a complete original Host
  profile backup before generating its own client identity. A join invitation
  did not grant it Host authority.
- Both real public upgrade commands ran against their actual configured roots
  and profile SecretStorage. Real Portal renderer actions tested permissions,
  pairing, an OS command, saved-pair recovery after a complete Guest Code process
  restart, and final endpoint removal/revocation. An in-flight slow command
  started exactly once and did not finish or replay across that process-tree
  restart; this is not separate proof of graceful shutdown cancellation.
- The actual Project `threadOpenChatroom` handler retried an interrupted
  creation/link and reused the same active native Room. This is not a full
  Project-renderer navigation test.
- The public Force Close command and confirmation released the original
  **transcript-only** Room. Join-secret-only proof was rejected with the original
  exact HTTP 401 response. Directory failure and a lost released-state response
  did not count as release. A fresh local receiver then recovered the exact
  original Guest identity and the latest network-synchronized history.
- After explicitly clearing the old remote hint, a strict full restart retained
  the pair. One Portal operation received **Approve once**; cancelling another
  denied it despite saved execution permission. Two separate recoveries using
  the untouched original 4.0.22 `ChatClient` module each required a real Host
  approval, retained the same original Guest ID and received the latest history.
  This is not a third concurrently running complete old extension installation.
- All 24 original source archive/manual-Note file hashes remained unchanged.
  Twelve shutdown groups had `remaining=[]`; an additional exact own-marker
  scan found none among 232 readable argv/cwd pairs, with 594 unreadable entries
  and zero races. It does not claim whole-system exclusivity.

All ten failed earlier installed attempts remain preserved. In v10 the takeover
join reported `room-mismatch`, then the observer read the still-connected other
Room's participant. Read-only checks retained the original handoff identity on
both sides; its 16 original file hashes were unchanged. Secret-free partial
evidence remains in
`.migration-test-work/collaboration-complete-product-partial-v10.json`.
The repaired harness preserves the destination Host for relative HTTP/WebSocket
proxy requests and waits for the exact Room/URL connection instead of any active
tab. A real forced-proxy socket reproducer showed the old wrong-destination
route; v11 recorded actual forwarding to port 19176 as well as 19175. No product
credential or participant-ID assertion was weakened.

The canonical Meeting Room explicitly refused transcript-only remote transfer
without releasing its Host. Cross-root Meeting/Note/file transfer remains
unimplemented there. The takeover explicitly leaves any old remote connection
and clears the profile's old remote hint before local restart; this neither
automatically changes each Room's topology nor provides a distributed owner
lock. Complete Host/Join/Leave/moderation renderer journeys, Portal Replace Chat,
models/files/profile sharing, key-rotation reconciliation, physical two-host
networking and OS-keyring qualification remain outside this result. The test
used private HOME/user-data/extensions, one isolated namespace, basic password
storage and automated custom dialogs. Subsequent shared-tree Root/Chat changes
are **not** installed-qualified by this frozen package.

#### Post-v11 full-asset continuation — source-only, not installed-qualified

The SHA-checked original 4.0.22 implementation was audited separately in
`.migration-test-work/collaboration-original-full-behavior-audit.json`.
Its Force Close uses a locally stored lifecycle descriptor and authenticated
HTTP close; it has no full remote archive download. Its canonical Meeting is
local, and history reconciliation does not transmit manual Note bytes.
Received attachments live in the client's Room file Map; only the explicit
Save File action writes a selected disk file. Missing historical payload bytes
must not be invented from archive metadata.

The continuation source adds an explicitly composed version-2 Host-proof
history checkpoint containing Room-only canonical Meeting state, manual Notes
(including Trash) and complete native attachment bytes. Transcript-only
callers retain version 1 and its guards. Transfer stages immutable pages without
publishing partial assets; Room history, Note rows, attachment bytes/replay chunks,
original canonical/Note inventory text and the receipt commit together. Transferred
original text survives a subsequent export without replacing the destination's
own retained-file admission provenance. Destination receipts bind the asset state too:
local edits, another Room's Note-path collision, corrupt bytes or revoked
authority refuse without overwriting either branch. Retained files and
historical admission pins are not rewritten. The original unselected route and
default reconnect/approval settings are unchanged.

Focused actual HTTP/SQLite, WebSocket/original-client receiver replay and
transcript regressions passed 17 cases in
`.migration-test-work/collaboration-full-assets-tests-v8.log`; Next no-emit
compilation passed in `collaboration-full-assets-types-v8.log`. They cover the
the original client's native-source participant identity after takeover, a 73,000-byte file replay,
manual Note trash/restore, foreign-Room isolation, Host-proof refusal and
preservation of the asset fixture's canonical formatting. A changed receipt is rejected
before creating a new checkpoint, so restoring the exact prior local bytes
does not leave an invalid staged base behind.
The native Delete facade also removes that Room's imported-Note flags and
transferred-source rows; its test preserves the source root and another Room.
This is not a verified Delete button, and retained archives remain ineligible.

The unchanged 4.0.22 Meeting store is a two-argument filesystem implementation,
not the current backend-adapted reducer. The live test characterizes it in its
own private producer directory, then runs the adapted reducer against Core;
copying its Note bytes into Core is fixture setup, **not** a verified editing UI
or original filesystem-archive admission. Earlier full-live v1/v2/v3 failures
are retained. Their 12 accidentally misplaced test-generated files were moved,
byte-for-byte, into their own failed fixtures; the read-only Core DB hashes
remained unchanged (`collaboration-full-live-misplaced-output-preserved.json`).
Later intermediate asset-test failures are retained too. An earlier combined failure at Storage reopening was
preserved, traced by the Root agent to its new marker allowlist and passed after
that agent repaired it. These tests are **not** the full installed product
qualification. The Python renderer-only Room/Project driver is prepared but
has not run; actual user buttons, original/current profile permissions and a
new frozen installed package remain pending. The source fixtures use in-memory
credential stores, not a real installed SecretStorage/keyring qualification.
The v11 evidence above must not be promoted to cover these new source changes.

The later source separates **Take over full assets…** from the original
**Force Close**: the latter still uses version 1, refuses canonical assets,
and does not release their active source Host. Full transfers use independent
checkpoint/receipt tables; an unchanged, empty failed v1 file checkpoint may
start the explicit full operation, but a changed local branch may not.
Nonce consumption is checked across both namespaces and already transferred
file IDs cannot acquire different bytes, even with a valid Host proof.

Selected Core Meeting Notes now use a guarded writable filesystem provider.
Only an existing visible owned Note may be saved, against the SHA of its
reviewed content and freshly checked Host authority/workspace lease. Stale or
revoked saves refuse; stat does not advance the reviewed version. Explicit
manual edits survive later canonical reducer changes and Trash/Restore.
These saves never edit the retained original Note or canonical archive.

**Recover saved file…** is another new, explicit selected-Host action, not a
replacement for Share File. It selects one missing retained file ID and an
actual saved local file, checks the exact size, then requires the owner's
attestation that these are the original bytes. Old metadata has no digest:
size alone is not proof of historical byte identity. Core records the admitted
SHA without sending a new offer; foreign metadata, inconsistent provenance,
different existing bytes and incomplete uploads refuse.

The four focused history/assets/live-client/UI-facade suites passed **29/29**
in `collaboration-room-recovery-source-v2.log`; both Next and extension no-emit
checks passed. The earlier v1 failures (revocation assertion wrapper and the
obsolete text-provider test double) remain saved. This is still source/network
and provider-adapter qualification, **not** actual renderer qualification.
Private 4.0.841–844 graphs were built separately. Installed attempts v2–v4
reached original dual-profile setup, but failed before the first new Host
button: Python CDP found no PKM iframe although the screenshot showed the panel
under its dynamic **Portal Connections** title. v1 failed before Code launch.
All failures and fixture cleanups remain saved; changing the title probe and
serializing Node/Python CDP did not fix this. Room/Project/editor/full-transfer
renderer qualification is therefore still missing, not merely unattempted.

The subsequent source fixes a separately reproduced identity bug: original
Host-token admission reused the old Host PID even when the explicit full
receiver was the original Guest. Only **Take over full assets…**, backed by a
verified complete receipt matching the current owned assets, may record a Core
Host succession and request the receiver's normal participant identity.
Ordinary/v1 Host recovery keeps its original behavior; shared secret alone
does not authorize hosting, and strict old-client recovery still requires
approval on every attempt. The succession survives a new local runtime;
mismatched Room/assigned-Host state refuses. Unsupported transports refuse
before releasing the source Host. Original archive/Host pins are not rewritten.

The four suites now pass **31/31**
(`collaboration-room-hosting-identity-v4.log`), including local-runtime restart,
manual-byte preservation and successor mismatch refusal; Next no-emit passes.
A further exact 4.0.22 persistence/client archive fixture retains its original
Host pin while the original Guest hosts after full takeover and a new runtime;
removing the succession refuses, and both original archive database hashes stay
unchanged. This fixture has no attachments/Notes; it is not installed full-asset
qualification. It exposed a full-only second pull incorrectly querying absent
v1 tables; checking schema existence fixes that without creating v1 tables or
relaxing reconciliation. Failures `collaboration-room-legacy-succession-v1..v3.log`
and passing v4 remain separate. These remain source/network/provider evidence,
not actual installed full-Host succession qualification. Earlier PID failure v1
and 29/29 v2 remain preserved. New private **4.0.845**
(`collaboration-room-full-product-package-v5.json`) contains this fix and
additional frame/target diagnostics; 841–844 do not. Its installed run is
tracked independently. No production profile, historical VSIX or admission
pin was changed.

The frame diagnosis is now concrete: in installed v5, Node saw the real nested
PKM frame (`#detail=1`, 23 tabs), whereas Python Playwright 1.61 saw only an empty
child although CDP reported a webview iframe target. A declared, project-private
Python **1.64.1** adapter fixes this observed attach failure. Shared Python and
historical packages were not upgraded. v6 preserved an interpreter-selection
failure; v7 with the correct private interpreter **actually clicked Host Room**
and observed the new Room, then failed because the old Join form was given a UUID
as a display name (`no-room`, not a wrong-secret rejection). v8/private **4.0.848**
uses the actual Room name in that form and includes the full-only schema guard;
v8 then passed visible wrong-secret refusal but reset the Join form by repeatedly
clicking the already active Threads tab. v9 avoids that reset and actually
clicked correct Join; its controller still failed waiting for a Guest UUID.
Exact 4.0.22 name-based Join does not retain the assigned Room UUID in the
Manager/client, so the next observer checks connected name/endpoint **and the
Guest participant in the Host's actual presence** instead of inventing a UUID.
That revised observer subsequently passed the original basic Room portion in
v11 below; it does not establish Next installed qualification.
Versions 845–847 lack the full-only guard.
All previous pointers and failed fixtures remain intact.

A further source-only strict succession case found that the runtime's valid
Host-token shortcut still bypassed the normal old-client identity approval.
The correction is limited to receipt-authorized succession Rooms: Host-role
proof is separate from participant proof, including the currently assigned
Host PID. Without Host proof, that PID cannot acquire retained PID-based owner
privileges; with Host proof, each unmodified old-client recovery still requires
the selected strict approval. Strong participant resume proof may replace
identity approval, but not Host-role proof. Ordinary/v1 admission is unchanged.
The exact 4.0.22 archive/client source test now verifies denial, approval,
disconnect/rehost, repeat approval and immutable archive hashes
(`collaboration-room-legacy-strict-succession-v6.log`); all four suites again
pass **31/31** (`collaboration-room-hosting-identity-v6.log`) and Next no-emit
passes. Failed strict attempts remain preserved. Private **4.0.850**
(`collaboration-room-full-product-package-v10.json`) is newly frozen with this
fix and the revised presence observer; 841–849 do not establish its installed
qualification. Source approval callbacks are not actual installed dialogs.

Installed v5–v9 all failed, with own cleanup counts `[6,3,6,6,6]`, remaining
empty and namespaces exited. Exact fixture-UUID host argv/cwd scan found none
(208 readable, 592 unreadable, zero races); unreadable processes prevent any
global-exclusion claim (`collaboration-room-full-host-cleanup-v3.json`).
The private window was formally handed to the Chat/SDK agent after v9.
These attempts never
reached new Project/editor/file/recovery/full-transfer/restart qualification.

After a separate formal handoff, installed **4.0.851/v11** used the exact
original 4.0.22 in two private profiles. Its original UI actually created a
Room, rejected the wrong secret, admitted the Guest with observed Host presence,
verified the Guest had no moderation controls, delivered announce/ask/discuss,
left/closed the Room, and used **Rehost** followed by Guest rejoin with the
same **new Room's** participant ID. This is not proof that the primary archive's
old PID survives migration or that the Host process restarted.
The subsequent **New Project** click opened a real modal, but the actor waited
for a nonexistent `dialog` role: the retained original uses `#pk-modal` without
that role. Screenshot/error and all prior results remain in the failed fixture
`room-full-installed-74f17383-e57b-4a2f-bfde-767af076d062` under frozen
`collaboration-product-frozen-9f5e9ec1-4757-470a-af16-210675caf202`.
The next offline actor uses its real modal ID and exact title and persists each
action result independently. That correction has no new installed qualification.
It is frozen separately in **4.0.852/v12**
(`collaboration-room-full-product-package-v12.json`, VSIX SHA-256
`992d6d64eddf0f98d950ef0299da6ec1ffcebd5a44a3974abca26be794667005`).
All 1159 frozen inputs, 4943 payload pins, exact packaged extension/client
bytes and frozen root no-emit checks pass. After the Chat/SDK agent's formal
return, v12 actually launched: the modal fix passed, New Project and New Thread
were created, and **Open chatroom** was clicked. The association then failed.
The actual orphan Room UUID was `43e2dfa1-12e4-443b-9bd6-31bc0151b7e0`.
The retained exact 4.0.22 pure model rejects that numeric-leading UUID with
`chatroom-id-invalid`; this reproduces the older bounded seed failures,
not a new Next product defect. The current source already accepts numeric
UUIDs. The private original module/data were not patched or deleted.
Evidence: `collaboration-room-full-installed-v12-summary.json` and the full
failed `room-full-installed-25663ffe-04c2-4375-b1f4-71f46384da9a` fixture.

The next offline actor observes the original error's actual DOM/screenshot
and may make at most twenty real **new Thread** UI attempts with unique names.
Every failed Thread and orphan Room is retained; retrying the same original
Thread cannot fix its reserved Room name. Only that exact original numeric-UUID
rejection is admitted as a bounded oracle retry. Next errors and unrelated
original failures still fail; no IDs are rewritten and no API substitutes for
the UI. This adaptation is syntax-checked, not installed-qualified.
It is frozen as **4.0.853/v13** (VSIX SHA-256
`aeea67d08c15330eef0233d7e9f5274d2d5d57dfc7143c77eadb86a1e1a1436c`).
All 1160 frozen source inputs, 4943 payload pins, exact packaged compiled
extension/client bytes and root no-emit pass. Four offline mock-protocol
cases verify preserved rejected data, distinct new-Thread attempts, Next and
unrelated-error refusal, and exhaustion at twenty; their tested bridge/actor
hashes match v13. The error DOM IDs and previous-error removal are also checked
against the exact 4.0.22 renderer. These are not real-DOM/installed results.
The Room admission/full-UI-Hub/Chat-Hub product files remain byte-identical to
v12; no new Room product fix was inferred from the original numeric rejection.
After the next formal return, v13 actually ran and captured the original
numeric-UUID error in the real `#project-action-error` DOM and screenshot.
Its first rejected Thread/Room stayed intact. A second real Thread was created,
but its composed Room name collided: original `displayRoomName` keeps only the
first **80 Unicode characters**, dropping the retry suffix after the long
synthetic Project name. The collision failed loudly rather than being admitted
as another numeric rejection. This is a driver naming defect, not evidence
that a new Next product fix is needed.

The offline fix puts distinct `t00`/`t01` attempt prefixes at the start of the
actual Thread names. The retained exact 4.0.22 normalizer reproduces both the old
collision and the corrected distinction. Mock-protocol tests now include the
80-character projection: frozen v13 fails two cases/passes two, while the
corrected actor bridge passes **4/4**. Neither frozen v13 nor any retained data
was modified, and this test was not restarted/repeated.
Evidence: `collaboration-room-full-installed-v13-summary.json`, real rejection
screenshots and failed `room-full-installed-4e7e45ec-6d6f-4056-921a-b1b386b56204`.
No Note/file/Next identity/full/restart/revocation stage was reached.
Six own cleanup groups are empty, controller/namespace exited, and exact own
fixture scan found none (206 readable, 599 unreadable, zero races; no global
claim), in `collaboration-room-full-host-cleanup-v6.json`.
Root is queued next after the formal handoff; any corrected installed retry
must use another frozen identity after Root formally returns the window.
Root subsequently formally accepted that window. The corrected bridge is
frozen separately in **4.0.854/v14** (VSIX SHA-256
`9bbface30a52b8e5b51950526925a0757677bf20acc096fe50c22f9d8fdedaca`).
All 1161 source inputs, 4943 payload pins, exact compiled extension/client
bytes and frozen root no-emit pass. The four cap/preservation/refusal/bound
cases also pass against that **frozen** bridge, not merely the current tree.
After Root's precise formal return, v14 launched a new fixture. Original
Project/Thread creation and the actual persisted chatroom association passed.
It then failed before Meeting Note actions: **Open** is a hidden action slot
inside the card's open Shadow DOM, and the actor sought the nonexistent exact
toggle name `Room actions`. The retained original component's `syncState`
sets **Show Room actions** while closed and **Hide Room actions** while expanded.
Its screenshot shows the primary card and closed disclosure, not a missing
PKM panel or failed Project association.
The next offline actor uses the actual closed label, still clicks the real
Open action, and adds per-action phases/card diagnostics. A minimal-VM call of
the exact original component confirms those labels; that is not installed
qualification. Failed `room-full-installed-191c300c-af8e-475d-ae6f-1c8a2f5e7c84`
and `collaboration-room-full-installed-v14-summary.json` remain preserved.
No Note/file/Next identity/full/restart/revocation stage was reached.
Six cleanup groups have no remaining PIDs; controller/namespace exited and
exact own UUID scan found none (204 readable, 593 unreadable, zero races;
no global claim), in `collaboration-room-full-host-cleanup-v7.json`.
Root has requested the next formally handed-off window, then Chat is queued.
After the formal handoff, Root completed its separately scoped session probe
and formally passed the private window to Chat. The corrected disclosure actor
is now independently frozen in **4.0.855/v15** (VSIX SHA-256
`73a2919e65c751e9e49e034ede995ab66453afa34c9902bf857b3344e8d7fc1e`).
Its 1161 source inputs, 4943 payload pins, exact compiled bytes, frozen root
no-emit, actor AST and four frozen-bridge mock cases pass. After Chat's formal
return, v15 actually ran. One original numeric-UUID rejection was captured and
preserved, the next leading-prefix Thread association passed, and the real
primary **Open** menu plus Meeting Summary/selection/**Open detailed Note**
all passed. The detailed Note opened the ordinary PKM Knowledge detail view,
not a Monaco editor. The actor then timed out seeking an editor without first
clicking the visible **Edit Content** action; its screenshot proves that path
mismatch, not a failed actual save.
Original **Edit Content** dispatches `openKnowledgeContent` and opens the
editable `pkm-content` document. The next offline bridge performs that real
UI click only for original Notes, before Workbench edit/save. Selected Core
Notes retain their guarded direct editor route and never use that old retained
Note's Edit Content action. Six mock-protocol cases now verify both routes and
the prior retry guards: frozen v15 passes five/fails one, corrected bridge
passes **6/6**. This still does not qualify the additional real click/save.
No actual Note save, attachment or Next identity/full/restart/revocation stage
was reached. Failed `room-full-installed-88aa9c90-5276-46e6-a19f-4dd551574471`
and `collaboration-room-full-installed-v15-summary.json` remain intact.
Six cleanup groups are empty; controller/namespace exited and exact own UUID
scan found none (209 readable, 593 unreadable, zero races; no global claim),
in `collaboration-room-full-host-cleanup-v8.json`.
Root is next after formal handoff, followed by Chat's separately queued
standard-packaging test. Any corrected Room retry must be independently frozen.
That original-only content-editor route is frozen in **4.0.856/v16**
(VSIX SHA-256
`9d41acdf0e30c393587a1353f06f701841caa06b9be0c246b9cf0b47d9af5963`).
All 1162 source inputs, 4943 payload pins, exact compiled extension/client
bytes, frozen root no-emit and actor AST pass. Six mock-protocol cases also
pass against that exact frozen bridge, including preservation/retry limits
and separate original-versus-Core Note editor routes.
After Root's precise formal handoff to Chat and Chat's subsequent precise
return, v16 launched a new private fixture
`room-full-installed-a2b3b6bd-d005-474f-8edb-5b3d3be3c5b9`.
v16 completed with a preserved failure. The additional real **Edit Content**
click passed and its screenshot shows the actual Monaco Markdown editor.
The actor still required `textarea.inputarea` and timed out at
`workbench-editor-focus`, before typing or saving. The saved diagnostic does
not contain editor-input DOM: a specific EditContext implementation is not
proven as the cause. This is a failed selector assumption, not evidence of a
failed Note save or a missing content editor.
The offline actor now clicks the visible editor's rendered text surface and
requires DOM focus inside that editor before typing; it rejects ambiguous
editors and records input-element attributes on failure. Three mocked focus
cases and the existing six mock bridge cases pass, but no real revised
click/type/save qualification is implied.
Evidence: `collaboration-room-full-installed-v16-summary.json` and the
retained fixture's `actual-ui-error-f9047666-e614-4ae2-81cd-ce220e4e1c66.png`.
Six own cleanup groups are empty, controller/namespace exited with failure
exit 1, and exact own UUID scan found none (205 readable, 581 partially
unreadable, zero races; no global claim), recorded in
`collaboration-room-full-host-cleanup-v9.json`.
Root's next provider lifecycle journey was formally handed the released
window, followed by Chat's queued ordinary-route test. Any revised Room run
requires a new frozen identity and another formal return. Chat's
standard-package result remains separately scoped.
The revised editor-focus actor is independently frozen in **4.0.857/v17**
(VSIX SHA-256
`6887b301bbc683cf7cc4dc1be49b6b4f8c100d1200e6efe85561d3bb36584426`).
All 1162 source inputs, 4943 payload pins, exact compiled extension/client
bytes, root no-emit and actor AST pass. The three mocked focus cases and six
mock bridge cases pass against the exact frozen actor/bridge.
Chat relinquished its next slot because no original-root Chat owner contract
was available. Root then formally handed the window to Env; after Env's
independently scoped test and precise formal cleanup, v17 launched once in
new private fixture `room-full-installed-7b1c1315-c3a5-45a1-9628-dfc9cd2c76e6`.
v17 completed with a preserved failure after the real editor focus,
replacement and Ctrl+S operations succeeded. Its read-only observer then
failed opening the old timestamp Note path. The original ordinary
`noteUpsert` renamed that file to **Original product Discuss.md**, adding an
outer `pkm.knowledge/v1` header with the original typed `note:` alias.
The original Meeting canonical record still contains the timestamp path.
An independent read-only verification using the retained exact original
filestore finds one matching alias and confirms its **content is exactly
the editor input**, including the new saved marker. Thus persistence of the
typed content is narrowly verified, not successful UI save completion;
v17 itself remains failed and never reached
attachment or Next/full/restart qualification. Its physical raw bytes include
the Knowledge header and must not be confused with editor content.
Evidence: `collaboration-room-original-save-857-v1.json` and
`collaboration-room-full-installed-v17-summary.json`.
Six own cleanup groups are empty, controller/namespace exited with failure
exit 1, and exact own UUID scan found none (209 readable, 597 partially
unreadable, zero races; no global claim), in
`collaboration-room-full-host-cleanup-v10.json`. The window was formally
handed to Root, which acknowledged acceptance.

The offline original-Note observer now uses the actual filestore content and
the unique legacy alias in the same Meeting collection. It preserves the
canonical timestamp path, separately records the physical saved path, and
the closed backup copies that saved file without rewriting canonical data.
This also exposes a real later-stage source blocker: frozen v17's Next
Meeting reader cannot read the unchanged canonical path after that ordinary
save. The corrected source reader retains direct canonical-file precedence;
only a missing file permits a bounded same-directory search for a unique,
validated `pkm.knowledge/v1` legacy alias. Ambiguous identities, links and
shared resolved Notes are rejected. No original canonical/file is rewritten.
The retained failed v17 root reproduces the old ENOENT and corrected raw-byte
read, with canonical and saved-Note hashes unchanged
(`collaboration-room-note-alias-retained-v1.json`). This is read-only source
verification, not installed Next admission or full-transfer qualification.
The revised observer/source chain is independently frozen in **4.0.858/v18**
(VSIX SHA-256
`1bb2c3bf45b011ce1d6379dc355e23c92b02d68e4635b22b9dda1223bc226e11`).
Its 1169 source inputs, 4943 payload pins, exact compiled extension/client
bytes, frozen root/Next no-emit and actor AST pass. Four source alias cases
and twelve mocked observer/bridge/focus cases pass against the frozen inputs.
The existing runtime/assets/full source regression run was **18/19**, not
fully green: one same-root adoption baseline was safely rejected by
`LEGACY_WRITERS_ACTIVE` for uninspectable hosts before entering alias code.
The failure remains in `collaboration-room-note-alias-source-regression-v1.log`;
no writer gate was relaxed and no unknown process was stopped.
After Root explicitly confirmed it was not ready to use Code and allowed
Room to proceed, d3 formally accepted and launched v18 once in private fixture
`room-full-installed-a602c539-64a3-4b39-8f9f-0eef5b49e1f7`.
v18 completed with another preserved failure. The new observer confirmed
persisted editor content, but the next Room action timed out because the
ordinary PKM Workbench tab was now **Notes**, absent from the actor's
known-panel title set; the text editor stayed in front. The offline actor
now reveals that real Notes tab and records panel/navigation phases.
The screenshot additionally proves a genuine original 4.0.22 failure:
**Failed to save** the old `pkm-content` timestamp URI, which no longer resolves
after `noteUpsert` title-renames the physical file. The editor remains dirty.
Written bytes therefore must not be promoted to successful UI save. Original
4.0.22/pins remain unchanged; compatibility changes to current ordinary
Knowledge lookup require separately coordinated scope and validation.
Evidence: `collaboration-room-full-installed-v18-summary.json` and
`actual-ui-error-5f5852b2-a898-4ae9-8e22-8ba281ba9b5b.png` in the retained fixture.
Six cleanup groups are empty, controller/namespace exited with failure
exit 1, and exact own UUID scan found none (207 readable, 593 partially
unreadable, zero races; no global claim), in
`collaboration-room-full-host-cleanup-v11.json`. The window was formally
released. Attachments and every Next/full/restart stage remain unqualified.
Root, Chat and Env subsequently confirmed the narrowly coordinated ordinary
`src/knowledge/filestore.ts` scope. Current `noteGet` now keeps checked direct
paths authoritative and, only when missing, resolves one validated same-directory
legacy alias. Alias reads are bounded, use a no-follow descriptor where supported,
check identity before/after reading, and reject ambiguity, links, unsafe paths,
invalid UTF-8 and non-missing filesystem errors. Existing Root writer-fence and
other shared edits remain intact. This does not add cross-directory alias lookup
or Next/default-root routing.
Focused ordinary URI source cases reproduce two failures/one pass before the
fix and pass **3/3** after it. The current source compilation, four Meeting
source cases, nine observer/bridge mock cases and five panel/focus mock cases
also pass. These are source/mock results, not successful actual Code save.
A separate `collaboration-room-note-compatibility` installed workflow is
prepared: original real UI failure must be retained, then current real
Workbench save through the **same old URI**, root/profile and a subsequent
Code restart must clear dirty state and match actual provider read/stat bytes.
It explicitly does not qualify Room attachments/full migration, Next adoption
or a standard release. The full workflow also preserves stale Guest Notes
outside the restored collection before copying the saved physical source Note;
canonical paths and previous Note bytes are not silently rewritten/deleted.
That source/controller is frozen in **4.0.859/v19**, VSIX SHA-256
`5ce510c4592dffe0a26d7d40a25862c3d15640e5d03f46d4c889589dcc5e9a87`,
source SHA-256
`6aedfde912959252e1624461d51d6a117892cac9618889de415431f32590d8f1`.
All 1174 inputs, 4943 payload pins, exact compiled extension/client/filestore
bytes, frozen root/Next compilation and 21 focused source/mock cases pass.
Two additional ordinary compiled regression scripts passed; owned-Markdown
import failed at the previously added Root fence's missing new-root `realpath`,
before alias lookup. Root separately fixed and tested that later source;
its result is not substituted into frozen v19. The v19 failure remains recorded
in `collaboration-note-uri-general-regression-failure-v1.json`.
After explicit Root/Chat agreement on d3 then Chat, v19's **Note compatibility
only** workflow launched once in private
`room-full-installed-0aa68dc4-6f9d-4a2e-b41c-e041cb9d826d`.
It completed with **exit 0**. The real original 4.0.22 UI failure and dirty
buffer were captured, not patched away. Current 859 then opened the same old
timestamp `pkm-content` URI in the same private original root/profile, performed
actual Workbench editing/Ctrl+S, cleared dirty state, and matched actual provider
read/stat bytes. After Code restart it read the previous value before a second
real edit/save; that also cleared dirty state and matched provider bytes.
Canonical Meeting bytes stayed unchanged and no Core SQLite appeared in the
original root. This qualifies ordinary old-URI save/restart compatibility only.
Eight own cleanup groups are empty, controller/namespace exited with success
exit 0, and exact own UUID scan found none (206 readable, 579 partially
unreadable, zero races; no global claim), in
`collaboration-room-note-compat-host-cleanup-v19.json`.
Secret-free evidence: `collaboration-room-note-compat-installed-v19-summary.json`,
with original failure and two current successful-save screenshots retained.
The private window was formally handed to Chat, which accepted. Chat's
issuer test is followed by Root's separately queued modal/drain/reload test,
then Room's next formal return. The v19 full Room workflow has **not** launched:
attachment recovery, primary migrated identities, Host/Hub restart, strict
old-client approvals/revocation and full assets/crash/resume remain unqualified.

The next full attempt has an independent **860/v20 offline frozen candidate**
(`464bc9d797d1e98f653ac2e92665fc2dd828dadd25d83a6ae932c286a6fa7f51`,
source `bac14d00219db8785f28f9583ab2d9886abda913cdcbefcab1be9eea34227d1b`).
Its full original-Note stage now explicitly captures persisted bytes **and**
the real dirty/missing-URI/visible Failed-to-save negative evidence before
attachment actions. Failure to verify that evidence stops the journey.
Frozen checks passed: 1174 source inputs, 4948 payload pins, actual ZIP
extension/collaboration-client/filestore bytes, unchanged original baseline
dependency entries, root/Next noEmit, 18 focused Node cases and five Python
mocks. Isolated compiled Knowledge contracts, legacy Markdown lifecycle and
owned assets passed with Root's import-directory fix; this does not replace
859's retained owned-assets ENOENT failure. Evidence:
`collaboration-room-full-frozen-verification-v20.json`.
860 is **not installed or full-qualified**. Root currently holds the private
window for its independent modal/drain/reload work, then formally hands it
back. 860 predates Root's later reload-await correction and does not call that
new command; no Root or Chat issuer qualification is borrowed.

Root's separate real Code v3 exposed a tightly related **direct** old-slug
`noteUpsert` collision: `noteGet` safely returned the resolved physical slug,
but upsert still passed the missing requested slug as its previous path.
Ordinary VFS's resolved-item save from 859 remains separately qualified.
Upsert now uses `existing.slug` as its previous path; existing move-target,
asset and Linux root fences are unchanged. New source cases reproduce the
collision before the fix (4/5), then pass (5/5), including identity-preserving
alias update/rename and rejection of an unrelated existing destination.
Root's v3 failed fixture remains retained; its separate v4 canonical-path
success is not substituted for it.

**861/v21** independently froze that fix and the full original UI-failure
capture, with candidate
`f2d265c067edf64029607624bfad93842fa1cf1f98eef194bb774e362160ca6c`,
source `4226c2fa76470cc605b3158acff73d1033d6beb4bda23e70ed1ddc8c62f146af`.
Offline checks passed: 1176 source inputs, 4948 payload pins, ZIP/compiled
bytes and unchanged baseline dependency entries, root/Next types, 20 focused
Node cases, five Python mocks and three isolated compiled ordinary suites.
`collaboration-room-full-frozen-verification-v21.json` records that scope.
After Root's formal precise release, Room formally accepted the window and
launched one bounded private dual-profile full attempt. It **failed with exit
1 before Share File or candidate installation**. Original basic buttons and
Project/Meeting/editing prerequisites ran; the new persisted-bytes plus real
dirty/missing-URI/visible Failed-to-save negative capture succeeded.
The next real Room Open timed out on `panel-navigation-chatroom`.
Its screenshot shows the Notes Workbench tab successfully revealed, but
Knowledge is the selected product workspace. The exact retained original
`src/webview/panel.html` places Threads (`data-tab="chatroom"`) in the hidden
Projects workspace. Merely revealing the Workbench tab does not reveal that
inner navigation group.
The offline actor fix resolves the target tab's actual workspace ancestor,
clicks the unique visible workspace-rail button, waits for the tab to become
visible, then clicks it. No hidden force-click or product-function invocation
is used. Four new group cases fail against frozen 861; all nine current Python
mocks and AST pass. This fix is **not installed-qualified yet**.
All six captured cleanup groups are empty; controller/namespace exited,
and own UUID scan found none (204 readable, 582 partially unreadable, zero
races; ancestors excluded, no global claim). The window was formally released
to the queued Env agent; Root's new multi-host experiment follows before any
new Room request. Evidence:
`collaboration-room-full-installed-v21-summary.json` and
`collaboration-room-full-host-cleanup-v21.json`.
No attachment save/recovery, candidate activation, primary identity migration,
strict approvals/revocation, Core Note, Host/Hub restart or full transfer
qualification is inferred from 861, ordinary URI, Root or Chat experiments.

The grouped-navigation fix is now independently frozen as **862/v22**:
candidate `5e6c323db9473ed6cd4b2f146ace1e8c5efbed0b7569f2e2fb20b4b20adfb3ed`,
source `464690111ae8941a263f2023bf207fa3961656d7481a49491c61e3b8882ee31f`.
1178 input hashes, 4948 payload pins, compiled/ZIP bytes, preserved original
dependency entries, root/Next types, 20 Node cases, nine Python mocks and
three isolated compiled ordinary suites passed offline. Evidence:
`collaboration-room-full-frozen-verification-v22.json`.
After Root's precise release, Env explicitly accepted at 17:40 UTC and ran two
bounded fixtures. Both failed before new Code/Env Refresh; the second safely
refused missing snapshot Host authority, without deleting privacy or bypassing
the gate. Env precisely cleaned/released and Root explicitly confirmed offline.
Room then **formally accepted and started one bounded 862 private dual-profile
full workflow**; its retained failure is described below. Included Root/Env source changes are fingerprinted
but do not confer their qualification on this candidate.

The real **862/v22 attempt failed with exit 1** in original 4.0.22 prerequisites,
before candidate installation. It actually passed the corrected
Knowledge→Projects→Threads navigation and clicked Share File. Its screenshot
shows the visible custom Workbench file dialog with **Share to room**. The
retained exact original compiled extension specifies that `openLabel` and
**Save shared file** for receiving; the actor incorrectly waited for generic
“Open”. The diagnostic phase inherited `panel-networkidle`, so that phase
alone must not be taken as proof the wait was inside `networkidle`.
No file save/bytes qualification is inferred from the Share click.
All six captured groups were cleaned; namespace/controller exited and exact
own UUID scan found none (203 readable, 585 partially unreadable, zero races,
ancestors excluded; no global claim). The window was formally released.
Evidence: `collaboration-room-full-installed-v22-summary.json` and
`collaboration-room-full-host-cleanup-v22.json`; raw screenshots remain.

The new actor locates the unique visible Workbench file dialog by its actual
confirm-button label, refuses unrelated dialogs/out-of-fixture paths, and does
not wait on unrelated PKM panel network-idle for Workbench operations.
Its phase is explicitly `workbench-file`. Original Share, Guest Save and
current recovery/receiver Save use their actual product labels.
Three new cases fail against frozen 862; all 12 current Python mocks pass.
**863/v23** independently froze the fix: candidate
`c6eb2508803947433edf434e6b588fe345f055efe70ae2edeb6c27b547c095ba`,
source `42297d4c8c2f3bad3a5b7e66b1232a174a2dc388fa938bbbd107bdca32758888`.
1181 inputs, 4949 payload pins, actual compiled/ZIP bytes, unchanged baseline
dependencies, root/Next types, 20 Node cases, 12 Python mocks and three
isolated ordinary compiled suites passed offline. After Root/Env explicitly
confirmed no ready candidate/no held window and agreed to the new slot,
Room **formally reaccepted and launched one bounded 863 full attempt**.
It failed with exit 1 at the actual Guest Save chooser. Host Share file
selection and Guest receipt UI succeeded, but the real custom chooser's
button was **OK**, not the supplied `Save shared file`. Physical Guest save
was not reached; candidate installation, identity migration, restart,
revocation and full takeover were not qualified. All six own captured groups
are empty and namespace/controller exited; exact UUID scan found none
(205 readable, 580 partially unreadable, zero races; ancestors excluded,
no global claim). The window was formally precisely released.
`collaboration-room-full-installed-v23-summary.json` retains this boundary
and the real screenshot separately from 859/861/862 evidence.

**864/v24** independently freezes a narrow observed Save fallback: only the
`Save shared file` action may use the unique visible **OK** confirmation.
Share/open/recovery actions still require their actual labels; an unrelated
dialog or a path outside the private fixture is refused. Two new cases fail
against frozen 863; all 14 current Python mocks pass.
Candidate `2877804d8898d2050deb57e12afcdf1851de6edafb29a048533ded291b0796b3`,
source `5a842f06b70b42ba41e6aec55e7e87c4ccc7a082b41912c51c6f81f13e5172b6`:
1181 inputs, 4949 pins, exact ZIP/compiled bytes, preserved original
dependency entries, root/Next types, 20 Node cases, 14 Python mocks and three
ordinary compiled suites passed offline. It had not yet started Code when
Root requested the next window.
Because Root's snapshot UI candidate became ready before Room formally
accepted, Room explicitly yielded and Root formally holds the next bounded
window; Root will precisely release to Room afterward. No Root fixture
snapshot authority or UI outcome is imported into this Room qualification.
Root subsequently precisely released after its limited status-only native
snapshot UI experiment. Room then **formally accepted and started one 864
private dual-profile full workflow**. It failed with exit 1 before editing or
saving the original Note: `workbench-editor-focus` timed out. The actual
screenshot shows a blank viewport at line 36, content only in the minimap,
and an unfocused native EditContext. Clicking the center of the virtual
`.view-lines` container was not a reliable viewport/focus operation. None of
864's later file-dialog fallback, candidate or full stages was reached.
All six captured groups are empty; namespace/controller exited and exact own
UUID scan found none (207 readable, 593 partially unreadable, zero races;
ancestors excluded, no global claim). The window was formally precisely
released. Failed fixtures, screenshots and the original bytes remain retained.

At the user's request, **865/v25 is a separate original Editor targeted actual
UI workflow**, not another complete Room attempt. It completed with **exit 0**.
The exact original 4.0.22 API seeds an isolated stable canonical ordinary Note
with 80 lines; that API seed is **not UI Note-creation qualification**.
The actor waits for a unique visible rendered editor with positive viewport
geometry, clicks within that viewport, sends actual `Ctrl+1`, and requires the
DOM active element to be inside the editor before typing. It does not
force-click the large virtual text container or substitute product JS calls.

Actual private Code exercised three real keyboard edits/`Ctrl+S` saves:
fresh load; after `Ctrl+End` and real editor-tab switching; and after a complete
same-profile Code restart that first reread the preceding save. All three
completed states have `dirty=false`, editor text equal to actual provider read
and physical semantic content, matching byte-count stat and physical raw
SHA-256. ExtensionHost PID changed from 1167 to 2095. A separate real Meeting
old-URI negative still records persisted content, `dirty=true` and a visible
**Failed to save** notification; it is not counted as successful saving.
The independent verifier checks original compiled hashes for every activation,
the pinned actor/source, actual provider/physical observations, restart reads,
real UI action records and all four screenshots.

Evidence: `collaboration-original-editor-installed-v25-summary.json`,
`collaboration-original-editor-host-cleanup-v25.json`, and reproducible
`verify-original-editor-targeted-v25.cjs`. All seven captured groups are empty,
controller/namespace exited 0, and exact own UUID scan found none (204 readable,
590 partially unreadable, zero races; no global-exclusion claim). Root, Env
and Chat received the formal precise release. This proves only the independently
tested original single-editor-group driver modes, not attachment save/recovery,
candidate activation, Host/Hub restart, full transfer or Next adoption.

Only after that real Editor gate passed, **866/v26** independently froze the
full attempt: candidate
`af8c0552259376aa0f8a77e32255f6f88a599a49c1dd5656d542819ebbc195a1`,
source `928f07ea85175611a9a18fec3cc5483cf54caf80084b95bedff4ee339b72dbe2`.
Its actor SHA-256
`6ce8e6287b899f26287620b7954cc844a3fa6272c10a9930e69f20fe63b131d7`
is exactly the implementation verified by the 865 real UI probe.
1183 source inputs, 4949 payload pins, actual ZIP/compiled bytes, 38 unchanged
original dependency entries, root/Next types, 16 selected Node cases against
explicit frozen modules, 15 Python mocks and three isolated compiled ordinary
suites passed offline. An initial offline test-path setup failure was corrected
and recorded; no Code was started for that failure. Mocks are auxiliary only.
After Root and Env explicitly confirmed no ready candidate/no held window,
Root agreed to one bounded slot before its new offline multi-host work. Room
then formally reaccepted and started **one ≤15-minute private dual-profile
full 866 workflow**; its retained result follows. None of
Root's snapshot/registration fixtures or Env's controlled embedding is promoted
to actual owner or external-writer authority by this test.

That **866 actual full attempt exited 1**, now beyond the earlier unrelated
Editor and file-dialog failures. Original Host real Share File and Guest real
Save chooser completed. Independent rereading verifies the fresh physical Guest
file equals the Host input, **110000 bytes**, SHA-256
`917c40eecd526d9a63c3c12a521e3d92cb375d26bfdb1a7d0e98fcdda8ebc365`.
This is original-product attachment saving, **not** candidate saved-file
recovery or full-assets transfer. The original real Meeting old-URI dirty/save
failure remains separately captured. All 32 pre-upgrade original Room
SQLite/journal, canonical Meeting and Note file hashes remain unchanged after
the failed preparation.

Candidate 4.0.866 actually activated only in **Host prepare**. The real public
`personalKnowledge.upgradeCollaboration` command remained pending after the
observed **Upgrade Collaboration** warning choice; the action deadline ended
with `Complete actual installed journey: host upgrade`. No preparation result
or Later modal was observed. **A prepare-window screenshot was not captured**,
so this does not identify the pending substep or establish a snapshot/owner
refusal. Frozen `next-collaboration-activation.ts:91–145` is the separate
private-globalStorage workspace flow: stop this old Hub, `start(root,true)`,
close candidate, save profile selection, then Reload/Later; its result explicitly
states `sameRootAdoption:false`. Root's status-only snapshot issuer is not a
legal grant to inject here. Before another full attempt, the remaining real
entry requires a bounded independent preparation UI/DOM/progress diagnosis,
not guessed authority, deletion of partial data or another blind full retry.
Read-only stopped-fixture filesystem inspection finds that the actual private
workspace was created, with a 1 MiB Core SQLite and ten Room directories.
This narrows the pending command beyond creating that workspace, but does not
identify start/close/selection/modal or error-notification completion and is
not owner/adoption qualification.

The **subsequent current offline-only harness** now records a pending operation
before awaiting the actual public command. A failed action best-effort captures
the actual Code screenshot and visible native modal/QuickPick/notification DOM
before cleanup, retaining raw UI privately while the public result contains
only safe diagnostic metadata. Renderer disposal cannot replace the original
failure. Ten diagnostic/retry cases and controller/driver syntax checks pass.
This does not retroactively create the absent 866 screenshot, fix its pending
product substep, or constitute an installed preparation-UI result. That probe
still needs a new frozen candidate, explicit latest handoff and real UI evidence
before another full retry.

No primary identity migration, current Note clean save, saved-file recovery,
Host/Hub restart, strict repeated recovery approval, endpoint revocation or
full crash/resume qualification was reached. Evidence:
`collaboration-room-full-installed-v26-summary.json` and
`collaboration-room-full-host-cleanup-v26.json`; original failed logs/data remain.
All seven captured groups are empty, controller/namespace exited, and exact
own UUID scan found none (205 readable, 591 partially unreadable, zero races;
ancestors excluded, no global claim). Room formally precisely released; Root
subsequently formally accepted its independently frozen bounded dual-host
session/modal/drain experiment. Room stays offline; those results must not be
combined with 865/866 into shared migration acceptance.
Those checks do not establish actual menu/Note/file/Next/full qualification.
Other agents' source changes included in this snapshot are not independently
qualified by these Room checks.
v12 never reached Note/file/Next identity/full/restart/revocation qualification.
Its six cleanup entries are empty; controller/namespace exited and exact own
fixture scan found none (205 readable, 607 unreadable, zero races; no global
claim), retained in `collaboration-room-full-host-cleanup-v5.json`.
Late old-socket callbacks remain a possible retry race, not a demonstrated cause
of this v11 failure; its wrong-secret/correct-retry sequence actually passed.
v11 never reached Project creation, Note/file actions, Next takeover or strict
approval dialogs, full crash/resume, or process-restart identity qualification.

v11's six own cleanup entries have no remaining PIDs, its namespace/controller
exited, and exact fixture-UUID host argv/cwd scan found none (213 readable,
584 unreadable, zero races; no global-exclusion claim).
Evidence: `collaboration-room-full-host-cleanup-v4.json`. The private window
was formally handed to the Chat/SDK agent again after v11. Private 850 was
frozen/type-checked but never installed. No historical package/pin or production
profile changed; other agents' SDK/environment packages are separate evidence.
The secret-free partial result is
`collaboration-room-full-installed-v11-summary.json`; all four original
seed/relocate/baseline activations also match the original compiled-module SHA.

To reproduce the new private UI adapter, create a project-local virtualenv and
install `tests/next-trial-electron/requirements-collaboration-room-ui.txt`; pass
its absolute Python path as `PKM_ROOM_UI_PYTHON` to the new full installed
runner. The runner enforces and records the adapter version. This still requires
explicit private-window handoff; it never authorizes using a production profile.

#### Earlier installed Room/Meeting upgrade — private 4.0.836, 2026-11-14

The final private product graph
`collaboration-product-frozen-8daba3ef-9d48-409d-a883-50340b5675de`
completed the full extension build and production Next-runtime stage, including
its locked runtime dependencies. The original 4.0.22 VSIX was not overwritten.
The private 4.0.836 candidate SHA-256 is
`87f6534b29c9a48b830bc81e34112043164b8c73f7fe38fe46f8cee424b0ee23`.
This is not a release/package-wide readiness claim.

The actual installed workflow `collaboration-production-upgrade` passed in
`meeting-installed-ccd1b1bb-ee89-4e34-8167-41804e0452fc`:

- The actually activated original 4.0.22 Manager created a Room and a two-profile
  Host/Guest conversation, reduced Discuss/opinion into an original Meeting,
  adjourned, and saved a real manual edit to its existing Meeting Note.
- The candidate's **real public upgrade command** consumed the actual configured
  root and same product profile SecretStorage. Automated confirmation chose
  Upgrade, then Later; a complete Code process restart selected the recovered
  workspace. It did not inject a Host credential, owner factory, fixture
  directory/bootstrap record or rebound VM Manager.
- Ordinary activated Manager methods recovered original Host/Guest IDs, Room
  history, exact Meeting snapshot and manual Note. An independent ordinary Note
  remained readable at its original file path. The upgraded but **unselected**
  second profile still reported the legacy route.
- A new native Room message survived another complete Code/child restart.
  Child PID changed from `1912` to `3107` while workspace
  `1a86f155-dea5-4c22-9ef2-6131cc06d89a` remained the same. Original Room SQLite/
  journal, canonical Meeting, manual Note and independent Note hashes were
  unchanged after preparation and both native phases.

The test has an explicitly private **observation-only compiled-module export
hook**, synthetic original data, automated custom dialogs, two separate
user-data/extensions/HOME directories and one isolated network namespace.
It is not a physical two-host, OS-keyring, default native-X11-dialog or TLS test.
Later plus a full process restart was exercised; a click on Reload Window is
not claimed. Installed policy was explicitly Keep Legacy; separate regression
cases exercise approval on every old-client recovery.

The latest six-file source batch passed **47 cases**, including original Host
versus join-secret owner authentication, missing original Host refusal, child
restart, malformed saved selection/profile separation and partial admission
retry after incomplete original credentials. The intermediate assertion that
expected only “Original Host credentials” was corrected to recognize the
original CredentialStore's actual incomplete-credentials error; runtime
authorization was not relaxed.

Four failed installed fixtures remain preserved: an incorrect imported getter
in the observer, accidentally shared HOME/machine-root preferences, an early
hook reading uninitialized `getStorePath()`, and an intermediate late hook
whose Host activation stalled. The final hook resolves real product
configuration **before** store/persistence UI initialization. Two earlier
passed graphs also remain historical, not latest qualification; the verifier
explicitly rejected a passed graph after its Collaboration source changed.

Final cleanup recorded nine shutdown groups with `remaining=[]`; all seven
installed attempts exited their private namespaces. The final exact-marker
scan found zero matches among 216 readable `/proc` argv/cwd pairs, with 599
unreadable/raced entries at handoff (595 on the final evidence recheck): this
is not whole-system exclusivity.
`.migration-test-work/collaboration-production-upgrade-verification.json`
binds the final candidate, frozen source graph, observer/original compiled
hashes, source test results, original data hashes, retained failures and cleanup.
Private Code was formally returned to the root-adoption agent. Production
profiles, historical pins/inventory and the general old-root adoption gate
were not modified.

`next-server/src/next-room-ui-hub.ts` uses the caller's already-owned `Storage`;
it never adopts a root or opens another owner. Multiple UI selectors share one
Hub. A process that already selected a legacy writer must restart after the
qualified handoff rather than registering an owner over that writer.
Revocation blocks subsequent UI calls, drains the Hub, prevents replacement
while shutdown is pending, and leaves a no-legacy-fallback tombstone. A failed
shutdown does not authorize another owner.
The registered factory receives a selected-owner guard in addition to the UI
sink. It must combine that guard with its actual live Storage fence and actor
authorization, including cached Meeting stores and network callbacks. Neither
registration nor a qualification label is proof that legacy writers stopped.

Before listening, the real Host warning explicitly discloses plaintext
`ws`/HTTP, missing integrations, and two different reconnect policies:

- **Use Participant Credentials**: an unmodified old client must receive Host
  approval every time it recovers an existing identity, including manual
  rejoin and automatic retry after transport loss. This differs from the old
  protocol; it is not a seamless upgrade. Updated clients retain endpoint-bound
  private credentials in their own profile. Losing that credential or changing
  its endpoint requires recovery again.
  “Every time” means every existing-identity recovery/reconnect, not a new
  approval dialog for each ordinary message or file-protocol frame.
- **Keep Legacy Reconnect**: only an explicit Host selection enables the old
  non-Host shared-secret/client-ID recovery behavior without those approvals.
  The warning explains that someone possessing both can impersonate that
  identity. Host recovery still requires Host proof. This does not claim that
  client IDs have become authentication credentials.

  An unregistered/unadopted root retains its original Hub and reconnect behavior;
  it is not silently switched to strict approval. On the conditional Next route,
  the Host must choose or cancel the warning; compatibility is not silently
  enabled. Strict recovery approval is a behavior change, while compatibility
  retains impersonation risk. Neither choice encrypts the plaintext transport.
  Approval is not proof that the requester owns the old profile: the actual
  recovery dialog asks the Host to verify the requester out of band. The shared
  secret and updated client's resume secret travel over plaintext WebSocket;
  capture can enable impersonation/replay even with participant credentials.

New participant admission is distinct from recovery of an existing identity.
Neither policy makes `resumeAfter` authenticate a participant. Explicit
`closed` still requires manual rejoin rather than automatic retry.

The same original manager/client handles the supported actions below.
Stored rename/repair can run without opening a network listener. Secret
rotation uses a hash-only two-phase core journal around the real profile
credential write; recovery accepts only one of the recorded candidates and
preserves an unmatched journal rather than guessing. In-flight writes cannot
be mistaken for a crashed rotation. Historical archive bytes and native
creation definitions are not rewritten to rotate secrets or rename Rooms.
Deleting a native Room requires original Host credentials and a closed Room;
retained migration archives are deliberately not physically deleted here.

Meeting has a conditional Core implementation described below, only when the
qualified owner injects the retained `MeetingStateStore` reducer. Without it,
Meeting actions report the missing integration: Discuss messages remain
messages, not silently successful Note creation. Portal has the conditional
command-only owner route below. Remote force-close additionally requires the
explicit trusted owner directory and original Host-proof capability described
below; project/thread Room ownership remains unintegrated.
Unsupported actions fail explicitly without opening a legacy writer.

### Meeting: original workflow, conditional Core persistence

The real path is `src/webview/panel/10-chatroom.js` (`chatStartMeeting`,
`chatAdjournMeeting`, `chatOpenMeetingNote`, trash/restore/delete controls) →
the `chatMeeting*` handlers in `src/extension.ts` → `ChatRoomManager` →
`MeetingStateStore` / `ChatMeetingLifecycle`. The qualified-owner facade in
`next-room-ui-hub.ts` injects `next-room-meetings.ts` behind that same reducer.
The rehearsal retained bundle exports the reducer, but this is not a
production-qualified owner registration or installed payload qualification.

Supported workflow: explicitly Host/rehost a Room, start a Meeting or let
Discuss start it, record addressed participant discussion, adjourn, open its
Note, trash/restore/remove its Core Summary, normally stop the Host, and
explicitly rehost after Storage restart. Original Guests remain Guests:
only the Host can broadcast `@all` or publish canonical Meeting snapshots.
New canonical state, revision/receipt changes and Note bodies commit in one
SQLite transaction; they do not start the old filesystem writer.

Original 4.0.22 data comes from
`chatrooms/<safeRoomId>/meetings/canonical.json` and the referenced
`notes/Chatroom Meetings/<safeRoom>/<timestamp>.md`. Closed canonical files
are now recognized by archive inspection; lock/recovery/unknown entries are
still rejected. Original IDs, canonical text and exact Note bodies (including
manual edits) are retained in Core source records and unchanged source files.
Subsequent reducer edits generate a derived canonical Note, not a merge of
manual source edits. Trash/restore of a retained real document preserves its
current body, including manual annotations; lifecycle revision still advances
and the retained document header can describe its earlier snapshot. A
previously trashed original with no Note file instead needs a newly generated
restored projection, not its generated “trashed” placeholder.
Missing active/adjourned Notes, escaping paths, symlinks,
unstable/nonregular files and oversized inventories refuse admission rather
than copying or trimming data.

Every mutation and Note-body read rechecks original Host profile authorization,
live owner selection and original source bytes. External source changes stop
reads/writes; no automatic source overwrite, reconciliation or rollback is
performed. Revocation refuses cached stores too; transport can close while
unauthorized cleanup fails, which is not successful canonical adjournment.
Normal Host shutdown must finish before authority is revoked.

**Open Note is a read-only `pkm-room-meeting:` Core view**, not the old editable
Note file or an item in the ordinary Notes library/sync. Trash hides the Core
Note; removal deletes the current Core Summary/Note, not retained source
records/files or raw chat history. Original default-root dialogs remain
unchanged; Core dialogs explicitly describe this difference. Open Core views
are invalidated on trash/restore/removal.

The basename-only private archive-copy route still refuses any Meeting archive
**before creating the target**, because it has no admission for private Note
files. This is deliberately not a Meeting installation/import entry. SQLite
snapshots may include these tables and private source text, but exclude files
and SecretStorage and are **not standalone Meeting recovery**. Original Host
credentials, source lineage and a qualified live owner are still required.
Changed original canonical/Note files also prevent experimental root rollback;
do not delete or overwrite them to make rollback pass.

### Exact private Room/Note admission and crash recovery

`next-room-private-admission.ts` adds an **explicit non-overlapping private
copy admission**, not same-root production adoption. The caller supplies its
live selected-owner fence, actual original Host credential store, independent
profile SecretStorage and exact-source consent. A Room secret, CID, marker or
filesystem journal alone cannot authorize it. The old basename-only copy
menu still refuses Meeting archives; unadopted default UI remains unchanged.

`admitPrivateRoom` pins the source/root/marker identities, closed original
archive, canonical state and referenced Note bytes. Private profile metadata
is durable before filesystem publication. Files are staged under the owned
`.pkm-room-admission/<intent>/` directory, with 0700 directories and 0600 files.
Original canonical JSON and raw Note text/manual annotations remain unchanged.
**Note source copies stay in that private directory, never `notes/` or the
public Notes index.** The canonical original `markdownPath` is preserved and
resolved through the exact private receipt, not rewritten to a public path.
The original source's modes/content are not modified.

The stage digest uses an independent immutable profile key
`personalKnowledge.next.privateRoomAdmissionStage.v1.<workspace>.<intent>`.
The initial profile index need not be rewritten to advance that phase. Existing
non-null index digests remain accepted only if the independent key agrees.
Both profile writes require exact observable readback before publication.
The profile stage digest, immutable plan/stage receipts and atomic no-replace
Room-directory publication precede the SQLite admission receipt. Partial
temporary writes remain private in `work`; they are not exposed or deleted.
`openPrivateRoomAdmissions` reacquires the real exclusive writer fence,
rechecks profile/Host/source authority and resumes prepared, staged,
published or SQL-committed work. A durable profile stage pin whose filesystem
receipt is absent is reconstructed only from the same exact staged file
identities. SQL commit is idempotent; a missing final commit file is repaired
only on this explicit recovery route.

Ordinary `Storage.open` refuses a private admission directory **before
starting workers**. Recovery does not infer authority from the marker or
reapply Portal grants. Missing/revoked profile pins, changed original Note,
private-copy edits, replaced marker/inode, symlinks, unknown intents and
conflicting native receipts fail closed and preserve both versions. Note
reads/mutations and owner Hub admission recheck the independent profile and
original Host authority. Retained manual Note Trash/Restore behavior remains
unchanged; canonical edits still produce derived documents, not a merge.

Evidence so far:

- `private-room-admission-min-fail.log`: reproduces the real saved original
  installed data's missing journal/private Note admission without copying its
  Note to a public location.
- `private-room-admission-core-full.log` and frozen
  `private-room-admission-frozen-v1.log`: **18 cases passed**, including 12
  dedicated admission cases and the six existing Room/Portal workflows.
  Dedicated cases use actual original 4.0.22 archive/reducer data, retained
  manual text, four recovery boundaries, profile-pin/FS durability ordering,
  actual SIGKILL after publication and after SQLite commit, authority/PIN
  revocation, source/private-copy edits, marker replacement and SQL conflicts.
  Both extension and Next TypeScript checks passed in the same frozen source.
- Frozen manifest SHA256:
  `ec49a6058cdb31070588d54763170bdde2b0d6f1ceadfba83487b45ea99f5792`.
  Private installed overlay 4.0.825 is a ZIP-only version label. This original
  source evidence is retained, not relabeled as the later fix.
- Journal installed runs 1–3 failed safely: the real product SecretStorage
  subsequently returned the prepared index's null stage digest, even after
  run3's bounded readback had observed the updated value. Readback alone was
  insufficient. Independent immutable stage keys remove this same-key phase
  update; the underlying VS Code event/cache regression is not independently
  proven. Frozen v3 initially failed TypeScript because the helper was nested;
  corrected frozen v4 passed Next TypeScript and **20 cases** (14 journal,
  six existing workflows), including a late same-key cache regression case.
  Product TS/compiled payload is unchanged from the previously checked v2.
  V4 source manifest:
  `8eb88ffe872f1b54e3deb0e0106908f07ba9b73cd28c2bfe1efc5f6c89078f03`.
- `meeting-installed-journal-run4.log` records a harness version-selection
  mistake; run5 passed admission/Host gates but exposed an invalid assertion:
  extension edit APIs can mutate a virtual buffer despite user-editor readonly
  behavior. The successful run6 tests the actual user `type` command instead,
  plus unchanged canonical Note bytes. It does **not** qualify virtual buffers
  as immutable against arbitrary trusted extensions.
- `meeting-installed-c7f4614c-8a9e-4e25-9c95-4ac6a75faea2/report.json`:
  **all four private installed phases passed**: original 4.0.22 baseline,
  explicit private admission, complete Code restart, then source-conflict
  restart. Actual product SecretStorage's independent stage digest matched
  disk; original Host CID/participant identity, raw manual Note, readonly user
  typing, Host/profile/live-owner revocation, Trash/Restore and normal shutdown
  adjourn passed. An actual original-file editor save before the last restart
  caused recovery to refuse, preserving both edited original and prior private
  source bytes. Public `notes/` copies remained absent. SIGKILL boundary tests
  above are real isolated forks, **not this installed run's crash claim**.
  Private ZIP-only 4.0.827 SHA256:
  `8cc59458677107805e6d3412605281b21e9fe6b409ca2b7edce4572a9fe4f0c3`.
  Next native journal comes separately from frozen v4; the private package
  reuses the checked v2 compiled product payload. Controller, driver and
  native bundle digests are recorded separately in private evidence.
  Recorded owned descendants and the additional exact-fixture `/proc` check
  were clear before formal Code handoff to the next agent.

Installed qualification is one private Code profile plus an actual installed
protocol Guest, **not two ordinary production profiles**. The fixture selects
an explicitly held Storage owner and supplies admission; ordinary production
Room/Hub UI and same-root default adoption remain unqualified. Multi-Room
mutable-index append under the real SecretStorage cache regression is not
covered by this single-Room installed journey. Custom private dialogs and
`--password-store=basic` do not qualify native X11 dialogs or OS-keyring storage.
The historical run8 refusal below remains valid for its unqualified copied
source; it was not rewritten into a pass.

This route does not authorize production same-root ownership, public Note
import/sync, model execution or arbitrary Portal command grants. SQLite-only
exports omit the private source files/profile pins and are not independent
Room/Meeting recovery. HTTP/ws remain plaintext.

### Portal: conditional original-manager command-only owner route

Original `chatEndpoint*` handlers call `managePersistentEndpoint` →
`startPortal` / `acceptPortalLink` / `connectPersistentEndpoint`.
`startPortal` uses `startHub` → `createPortalChannel` → `PortalRelay`;
both link and saved-endpoint joins reach `joinPortalTransport` → `ensurePeer`
→ permission/approval checks → `executePortalCommand`. Accepting a remote link
can bypass a local Hub, so merely implementing a relay is insufficient.
Files require per-batch consent; code execution remains broad and unsandboxed.
Saved persistent endpoint policy may be reapplied on automatic reconnect,
unlike an ephemeral in-memory permission lease.

`next-room-ui-hub.ts` can explicitly inject `next-room-portals.ts` into the
same live Storage owner and `legacy-chatroom-runtime.ts` listener. Merely
opening Storage, selecting a marker or registering a Room-only owner does
not grant Portal access. Without that separate capability, manual connect,
direct saved-endpoint connect and automatic restore still refuse before
reading/reapplying old credentials or policies. Unadopted roots retain the
old implementation; original endpoint records and SecretStorage are preserved.

The retained `ChatHub` must expose its dedicated Portal transport ABI:
**exact `/pkm/portal`** sockets are dispatched to the original `PortalRelay`,
not the Room connection handler. Portal is peer-only: it does not create a
Room, Meeting, membership archive or Room transcript. A General endpoint ID
is not a Chat ID. Adopted pairing does not run the old project/thread
retirement writer.

The full conditional route is General/external endpoint pairing →
original receiving-control and command approval → fresh owner admission →
explicitly injected command executor → original stdout/stderr/result
transport. Persistent pairing deliberately clears incoming-control and
saved permissions: users must explicitly enable receiving control again and
complete nonce/binding confirmation. Ephemeral “Always” is only until
disconnect; named-endpoint permissions require explicit Save and may be
restored from the original profile. Neither setting bypasses owner admission
for each command. Local command approval and owner approval are independent.

Authority grants bind an immutable command/request snapshot, are short-lived
and one-use, and are consumed even for an already-cancelled matching call.
They are **not durable execution receipts**. The injected executor must
provide durable request idempotency: the tested original supervisor retains
`(pairId, requestId)` outcomes in profile `globalStorage/portal-processes`,
preventing a replay after Storage restart from repeating its OS side effect.
This supervisor executes broad, unsandboxed OS/network commands; this does
not qualify native Chat-process migration or sandboxing.

Bound-Chat lineage, model/tasks, files (including cached old file adapters),
profile sharing and old MCP tool grants remain explicitly unavailable.
Ordinary production caller installation and root-wide owner/writer fencing
are **not qualified** by the source-focused test route.

Transport remains **plaintext `ws` / HTTP**. Original Portal HMAC/channel
secret and CID semantics are retained: a holder of the same secret and CID
can replace that peer's socket. Room strict reconnect policy does not upgrade
Portal identity. Old Room clients without resume proof require Host approval
on **every** restored identity in strict mode; “Keep Legacy” requires explicit
Host consent to the original impersonation risk. Neither policy encrypts
transport.

### Portal owner shutdown: delivered bounded cancellation workflow

`next-room-portals.ts` now owns an execution cancellation signal and lifecycle
epoch. `createNextRoomUiHub.stop()` cancels pending command grants, approvals
and running commands **before** draining a listener, including when an
accepted external link has never started a local Hub. Selected-owner disposal
already calls this stop method. Active executions also recheck the live owner
and writer lease every 250ms; loss aborts their signal and suppresses a success
result. The caller's disconnect/cancel signal is composed with that signal.
Late approvals cannot mint grants for the previous lifecycle. A still-live
owner can explicitly authorize fresh work after an ordinary Stop.

The original Manager's command path already monitors trust/root/binding and
owner loss every 100ms. This change closes the **Next admission/executor port
and explicit Hub-stop boundary**, rather than claiming that every original
UI command previously escaped revocation. It does not remotely force-close
a different Room Host or add a production owner registration.

Executors must cooperate with cancellation and preserve durable request
receipts. The tested retained supervisor reaches terminal `cancelled` and
retains its process directory; no new execution replaces that receipt.
Unknown executors that ignore AbortSignal are not qualified. Requests already
executed before cancellation cannot have their OS/network effects undone.

- `portal-close-min-fail.log` reproduced all four missing boundaries against
  the original fixed 4.0.22 supervisor: live owner loss, stop without a local
  Hub, late approval and unused grants surviving stop.
- `portal-owner-close-frozen.log`: Next TypeScript and **25 cases passed**
  (the prior 20 Room/Meeting/Portal cases plus four cancellation subcases and
  their parent). Frozen source manifest:
  `ba95796197bde5d0d5444abada5c8445ca558c2a4a8b19029394fc3267d64ed8`.
- Private installed run2, fixture
  `meeting-installed-e9689744-e7c4-443b-ba46-b7ba4aa6fe8e/report.json`,
  passed actual activated product owner registry/context, real renderer-clicked
  one-command modal, original compiled supervisor, Hub Stop and owner disposal.
  Both original process receipts reached `cancelled`, with the delayed test
  effects absent. The unadopted root selected the actual legacy Hub factory;
  no Room archive or public Note was created in the Next fixture.
  **Requests were scripted synthetic Portal admissions, not installed pairing,
  permission UI, network peers or a production default workflow.**
  Private ZIP-only 4.0.829 SHA256:
  `d216c503a18b5247bc6a55018c5fd40d456bbc00caedd27d3222fb59d8f7d8fa`.
  It reuses the earlier checked product payload; Next code comes from the
  separate frozen native bundle. Source/package/controller/driver/native
  digests are separate in `portal-owner-close-verification.json`.
  First installed attempt's driver passed but its reused Meeting-only report
  reader failed on missing `meeting-state.json`; that failure is retained.
  Both namespaces and exact recorded descendants were cleared before formal
  Code handoff; inaccessible processes are not evidence of system exclusivity.

### Two-profile Portal UI and selected remote Room close

The private installed `portal-dual` run5 passed with two isolated Code
profiles: original General endpoint pairing, receiving disabled refusing a
command, explicit receiving-control enablement and saved permissions,
independent per-command owner approval/denial, Disconnect/Connect preserving
the pairing, and a complete Guest Code restart preserving the same pair and
permissions. Commands after that restart still required fresh owner approval.
Disposing the selected Guest owner made the original Manager's Portal
preflight refuse further work.

This uses the original Portal renderer in a fixture container, the actual
activated product context/SecretStorage/owner registry, the installed Manager
class rebound to an explicitly held private owner, and actual renderer-clicked
VS Code dialogs. It is **not ordinary production panel activation or an
original-to-latest two-profile upgrade**. Both profiles install private ZIP-only
4.0.835, reusing an earlier checked compiled product payload; the Next native
backend is bundled separately from frozen source manifest
`10e3f5d2d25e01406402ba1299cc3273c2b951694883c8f5b14ed370eab82321`.
The private VSIX SHA256 is
`652fbb066c43e0c0b6cd5fa56a5d2e98af05f6043646daec94234d5216eec37e`.
It uses one machine's isolated network namespace/loopback, custom dialogs and
`--password-store=basic`: not two physical hosts, TLS, native GTK or OS-keyring
qualification. Only the Guest fully restarts in this Portal journey.

The original **Force Close Host…** manager action now has an optional Next
port. Its caller must explicitly supply a trusted Room-to-owner directory
(`remoteRooms.resolve`) and original Host-proof credentials. A copied archive,
Room join link, Portal secret, CID or MCP actor does not supply that authority.
The directory binds the exact Room source fingerprint, distinct workspace
identity and `ws`/`wss` endpoint, with no URL credentials, query or fragment.
An active remote binding blocks local rehost. A configured directory with an
unknown observation also blocks rehost: loss of contact is not release.

The original credential store signs
`force-close:<roomId>\n<timestamp>\n<nonce>` with its independent Host secret.
The receiver rechecks the selected live owner, exact admitted active Room,
fresh Host credential and timestamp/nonce/proof, then consumes a nonce receipt
in SQLite before accepting the old HTTP close request. A valid proof cannot
be replayed after Room rehost. The sender rejects redirects and confirms only
an explicit `released` observation from the same directory binding, not merely
HTTP 202, disappearance or timeout. This closes only that Room; it does not
release a workspace writer lease or transfer root ownership.

Installed run5 exercised that original Force Close confirmation and proof
HTTP path against another private owner and observed release while retaining
the unrelated Room. The Room was freshly synthetic; its Host credential was
explicitly bootstrapped out of band into the other actual product profile
after a separate test confirmation. The directory was a private fixture
published by the receiving owner, **not production discovery or credentials
derived from joining**. Without these capabilities, Next does not fabricate
remote availability or fall back to an old writer.

The final source-focused test additionally uses the original fixed 4.0.22
client for two participants and an explicitly addressed message. It verifies
receiver-side normalized history and identity survive proof-close and same
receiver Room rehost, rejects join-secret forgery/wrong-purpose/expired proofs,
nonce replay and owner revocation, and rejects unknown-directory rehost.
Initial added-history assertions failed: unaddressed traffic is rejected, and
Core messages use `content`, not the old frame's `text`. Those failed logs
remain; the corrected `room-remote-close-final-focused5.log` passes six cases.
Final related Room/Meeting/Portal validation passes **31 cases** in
`room-remote-close-final-regression.log` (25) and
`room-remote-close-final-ui-hub.log` (six), plus the Next TypeScript check
recorded in `room-remote-close-verified-tsc.log`.
The stricter unknown-directory listing/rehost guard was added **after**
installed run5 and is source-tested only; that installed native bundle has
not been silently relabelled as the final source.

Evidence: `.migration-test-work/portal-dual-verification.json`, installed
fixture `meeting-installed-b6d39da2-14ab-4891-b315-40415928d1ee/report.json`,
and `portal-dual-final-cleanup.json`. The historical report's top-level
`workflow: meeting-private-admission` is a generic reporter label; its
`dual` object/phases and actual CLI identify this Portal run. Earlier attempts
remain: run1 missing compiled credential constructor export, run2 stale
QuickPick transition, run3 passing the smaller journey, run4 polling a closed
Guest page after restart. Run5 fixes the harness without bypassing dialogs.
All recorded descendants were cleared before formal handoff; inaccessible
processes are not evidence of whole-system exclusivity.

That run5 did not qualify cross-root synchronization of the receiver's latest
derived transcript before sender rehost. The subsequent opt-in transcript
workflow below addresses that bounded gap. Distributed Room ownership fencing, ordinary production
directory/bootstrap installation, same-root adoption and full Host restart for this dual-Portal/remote-close route
remain **unqualified**. Retaining receiver history is not proof of transferring
that history to the sender. Plaintext `ws`/HTTP and the old Portal
shared-secret/CID replacement semantics remain unchanged.

### Live cross-root transcript pull and restart recovery

**The fixed original 4.0.22 has no independent cross-root history replication
protocol.** `ChatRoomLifecycle` rehosts the same persistence directory and
uses `ChatRoomLock` (`chatroom.lock`) for exclusion and its `activeUrl`
descriptor. Force Close releases that shared-directory lock. The original
WebSocket client sends `resumeAfter`; an approved join gets `history` with
`mode: catchup` after a known message ID, otherwise `baseline`. The original
Manager keeps that replay in its connection's bounded in-memory messages;
it does not replicate another Root's Room database. These paths were checked
in the fixed original VSIX, not inferred from current source.

`next-room-history-sync.ts` therefore adds a **new, explicitly enabled Next
Host-to-Host transcript protocol**, not a claim that this was an old network
feature. The original data shape is retained:
`id`, `participantId`, `aliasAtSend`, `senderKind`, `messageType`, `content`,
`metadata`, `createdAt`, plus memberships, aliases, pending joins and the Host
participant binding. Identity recovery still follows the separately selected
Room policy; private endpoint-bound resume secrets are **not transferred**.

The already selected source owner must enable `historyExport`; the destination
must independently enable `remoteRooms.synchronizeHistory` and select the
trusted owner directory and original Host credentials. Neither a qualification
label nor a Room join secret grants export. The real listener accepts
`POST /api/native-rooms/<roomId>/history`. A fresh original Host proof binds
the complete request, including destination workspace, source fingerprint,
immutable checkpoint and byte offset. Each returned page is also signed with
the original Host credential, bound to that particular request nonce and page
contents. Tampered/replayed pages do not become committed history. HMAC does
**not encrypt** chat text or upgrade old participant identity.

Original archive `sourceFingerprint` includes its local Root, inode, mode and
timestamps; two independently pinned private copies therefore have different
fingerprints. Those local integrity pins are **not rewritten or weakened**.
For a retained archive, an explicitly selected directory can additionally
report `historyLineage`: SHA256 of the Room ID and exact original file
path/content-hash/size inventory. Both owners independently compute and match
that content relation. The transfer still binds the source's actual local
fingerprint/workspace, the destination's unchanged local source receipt and
fresh Host proofs. A common lineage is not ownership, identity or adoption
authority. Native definition copies retain their existing shared immutable
source lineage.

The source captures its currently committed runtime state after queued Room
messages settle, stores an immutable SHA256 checkpoint, and serves bounded
32-KiB pages. The destination durably stores its byte cursor in SQLite without
publishing partial history. After a transport failure and complete owner/
Storage restart it resumes that checkpoint, then **makes another real network
request for a fresh head**: the resumed old checkpoint is never labelled
“latest”. This is explicit point-in-time pull and automatic close/rehost
catch-up, not continuous background synchronization or a global ordering claim.

The selected original Manager's Force Close call first preflights a live
checkpoint and the destination branch **before disconnecting the Host**, then waits for confirmed
release **and**, when enabled, pulls the closed owner's final transcript.
Rehost makes another authenticated pull and requires a closed source snapshot
before activating the destination Room. Unavailable export, a changed directory
binding, invalid proof/page, timeout or an unconfirmed release fails closed;
an old copied fixture snapshot cannot substitute for that network operation.
If the source exits before its final export can be obtained, the partial
checkpoint remains and rehost is not admitted.

An active destination, an already-used unsynchronized local runtime, conflicting
local message prefix, source/owner binding, or changes since the prior durable
receipt are refused without merging, deleting or overwriting that branch.
Synchronization publishes the full validated transcript and its receipt in
one destination transaction. Imported state remains locally **stored**, not
an independently active owner. This is not a distributed ownership lock:
source reactivation and root-wide handoff need a separate coordinated owner
protocol.

This route deliberately refuses file-bearing messages, non-chat records,
retained Meeting archives and nonempty Core Meeting/Note state. It does not
copy attachment bytes, canonical Meetings, Note bodies, Portal grants or
private participant resume secrets. Checkpoints are limited to 16 MiB,
4,900 messages and bounded identity arrays; oversized history is rejected,
never trimmed. The private outgoing checkpoint budget is 128 MiB; exhaustion
requires explicit reconciliation rather than deleting old history.

Evidence is `.migration-test-work/room-live-history-verification.json`.
Final source validation: **40 related cases passed** in
`room-live-history-final40-regression.log`, and Next TypeScript passed in
`room-live-history-final40-tsc.log`. Source, package, native bundle/worker,
controller, driver, actual workflow and each preserved attempt are recorded
separately; an installed result never substitutes for a different source hash.
The source-focused journey uses real fixed 4.0.22 clients writing ten messages
over the actual retained protocol, a source-owned HTTP fault proxy that breaks
the second page, and another message committed while the destination is
disconnected. Owner/Storage restart resumes 32,768 durable bytes and then
retrieves that new message. A further live message before original Force Close
appears in the final transferred history and in the original Guest's baseline
after destination rehost. Tests also reject page tampering, request forgery/
purpose reuse/replay, unsynchronized local branches and either owner revocation.
An additional source case creates a real chat-only SQLite archive through the
fixed 4.0.22 persistence API, independently admits it into two private Roots
with the existing Room journal/profile pins, recovers its non-UUID historical
Guest ID through the old client, and commits a new message **after** the first
network pull. Original Force Close and destination rehost replay both the
original message and that live update while the original SQLite bytes remain
unchanged. These source-case profiles are independent memory-backed
SecretStorage-like stores, not the installed profiles below.

The private installed journey repeats this with two actual Code profiles,
actual product SecretStorage and selected owners, a complete Guest Code
restart after the interrupted transfer while the Host writes another message,
then a second later write, original Manager Force Close, latest-history
rehost and original Guest identity. The fixture transfers **only the fresh
Room definition and separately approved Host credential**, not historical
message data; all twelve messages arrive through the live network protocol.
It retains the original renderer fixture container, compiled Manager rebound
to the private owner and reused 4.0.835 product payload, with a separately
frozen new native backend. It is not an ordinary production panel or a
historical source-archive-to-latest full upgrade. “Keep Legacy Reconnect” is
chosen through the actual warning for this identity check; it retains the old
shared-secret/CID impersonation risk.

The final installed run is private fixture
`meeting-installed-3d06a208-f122-417e-b6d0-c30b4ff76fba` (**passed**), using frozen
v3 source manifest
`2609c6feedd7344095aedddf6db1c05a5139598236ae6b2a7320d0a0dd09a4c6`.
The evidence builder rebuilds both native bundle and worker in memory from
that exact frozen input graph and requires byte equality with the actual
installed fixture; the earlier v2 passed fixture is explicitly rejected as
latest-source evidence. All three attempt namespaces exited, all six recorded
shutdown groups per attempt have no remaining descendants, and the final
readable `/proc` argv/cwd marker check found no owned fixture processes.
Its 593 unreadable/raced entries are retained, not treated as proof of
whole-system exclusivity. Code was formally returned to the other owners.

The first installed attempt completed live transfer/restart/final-head/rehost
but failed its final owner-disposal check: the newly rehosted Room was still
active when authority was revoked, so authorized canonical shutdown correctly
refused. That failure remains. The corrected journey normally closes its
rehosted Room **before** the separate owner-disposal test; it does not bypass
revocation or claim successful canonical writes after owner loss. The first
source attempt also retains its fault-proxy callback error after source
revocation; the proxy now uses its captured port rather than querying a
revoked owner.
The first added original-archive case also exposed the incorrectly shared
Root-local fingerprint assumption; its failure and the related
`LegacyChatroomArchive.hostCredentialHash` type failure remain. The corrected
route uses independent local pins/common content lineage and freshly loaded
verified profile credential hashes, not a fabricated field on the archive.

Production owner-directory/bootstrap installation, an installed historical
archive-to-latest full upgrade, attachments/Meetings/Notes transfer, continuous replication,
distributed ownership and cross-machine/TLS/OS-keyring qualification remain
uncompleted. Transport is still plaintext `ws`/HTTP on private loopback; signed
pages improve transfer integrity, not confidentiality or old identity trust.

### Remaining real Collaboration entry points

These are the existing user paths, not promises of production migration:

| User path and real dispatch | Old versus selected Next behavior / remaining qualification |
| --- | --- |
| **PKM: Upgrade This Profile's Collaboration** → `registerNextCollaboration` → actual configured source/original profile Host proof → private persistent child; reload → original Manager | Explicit Room/Meeting/Note recovery uses a separate profile workspace. Unselected profiles remain legacy and general PKM routing is unchanged. This is the product entry above, not general same-root/default adoption or an injected Portal authority. |
| **Portal connections → New endpoint… → General Enteray → Pair…**; `portalEndpointCreate/Pair` → `managePersistentEndpoint` → `startPortal` or accept code | Explicit product profile selection now composes child owner admission with the actual original Manager/context; no fixture owner is needed. Other owners without that explicit capability still refuse. The new full installed product journey is distinct from the injected-owner fixtures above. |
| **Local permissions… → Enable receiving control → Save permissions**; `portalEndpointPermissions` | Saved grants survive reconnect; ephemeral Always lasts until disconnect. Default compatibility keeps original interaction; strict mode adds separately labelled owner approval. Retained-context task/file/profile/Chat paths keep their original authorization, not Core migration. Full installed model inference, file transfer and bound-Chat qualification remain outstanding. |
| Endpoint **Disconnect** versus **Remove…**; `portalEndpointDisconnect/Remove` → `closePortalTransport` / `store.remove` | Disconnect retains saved pairing; explicit Remove revokes/removes that endpoint. Private installed Disconnect/Connect and pair preservation passed; endpoint Remove, remote idle-socket revocation and replace-Chat interaction remain unqualified. Owner disposal refuses preflight; this is not proof of immediate physical socket closure. |
| Endpoint **MCP access…**; `portalEndpointExternalAccess` | Saved access deliberately authorizes all MCP clients on that Host, not one chat/session. It is separate from receiving-control, file-batch approval and per-command owner admission. Production/root-wide policy and the full actual remote MCP journey remain unqualified. |
| Room **Stop Hub**, **Close all rooms**, per-Room Close; `chatStopHub`, `chatAdminCloseAll`, `chatAdminCloseRoom` | Selected owner closes its own listener/Rooms; owner disposal also cancels Portal work. These are not another profile's remote Host release. Unadopted roots still call their legacy Hub. |
| Stored Room **Force Close Host…**; `chatForceCloseHostedRoom` or `personalKnowledge.forceCloseHostedRoom` → `forceCloseRemoteRoom` | Product opt-in wires the actual configured, original-Host-signed directory and transcript synchronization. Missing contact and a close acknowledgement without confirmed release are not success; recover contact before rehosting. Current full product installed qualification is tracked separately below/above; distributed handoff and full attachment/Meeting/Note transfer are not supplied. |
| Stored Room **Take over full assets…**; `chatTakeOverFullRoom` → `takeOverFullRoom` → verified sealed full receipt and explicit Host succession | Independent source-qualified full-byte/canonical/manual-Note path, not a version-1 Force Close upgrade. Actual new installed transfer, partial-owner crash/restart and receiver-save qualification remain missing; private 851 is the next independent run. Legacy Host pins/default admission are unchanged. |
| Selected Host **Recover saved file…**; `chatRecoverSavedAttachment` → original file selection, owner attestation and `recoverFileBytes` | Missing original IDs only; no new offer and no invented historical digest. Source tests pass. Actual saved-byte recovery UI is still unqualified in the new independent package. |
| Selected Core Meeting Note **Open Note** → Workbench edit/Save → guarded filesystem provider | Reviewed SHA, same owned Room and live authority required; partial/full mismatch, foreign/stale/revoked scope and dirty save after owner crash refuse in source tests. New installed editor/restart/crash journey remains outstanding. |
| Project/thread **Open Chatroom** → `threadOpenChatroom` → `createHostedRoom` → `linkThreadChatroom` | Product composition verifies creation against the original Project store and retains original IDs. Interrupted create/link retries reuse the same owned Room. Existing Host authority stays compatible by default; strict mode adds original binding verification. This is not Project-file migration or automatic repair of every dangling/deleted association. |
| Portal **Replace Chat…**, private Meeting Note access | Original retained-context policy/lineage is enabled only in the explicit product composition. Actual installed Replace Chat/model/file/profile-sharing remains unqualified. Exact private Room/Note admission stays source/profile/owner-bound; public import/sync and ordinary default admission remain unqualified. |

The visible spelling **General Enteray** is the current original dialog label.
Ordinary activation has no general production-qualified old-root owner caller,
so unselected roots continue all old logic. Explicit profile opt-in above
selects a new separate Collaboration workspace. A previously selected but revoked Next root
fails closed rather than becoming an unadopted fallback. None of the tests
refresh production pins, inventory or historical provenance.

### Portal source evidence and installed Meeting failures

- `.migration-test-work/portal-owner-focused-run6.log`: both TypeScript checks
  and **six full manager/runtime cases passed**, with actual original 4.0.22
  Peer/EndpointStore/profile command supervisor and actual Next Storage.
  Covers pairing, nonce, both independent declines, stdout/stderr, exact-once
  side effects, grant replay/cancellation, profile identity/port restoration,
  Storage reopen and unchanged source archives.
- Frozen v6 source/resource SHA256:
  `23ecbe921bdb72be5e511464eedf4436f9d9e4b712d85a53dd2f420f57d1a6c6`.
  This predates the subsequent missing-original-Note restore edge and private
  installed-driver fixes; it does not validate those later sources.
- `.migration-test-work/portal-owner-focused-run8.log`: **six cases passed**
  after adding the original reducer's genuinely trashed/missing-Note fixture.
  Restoring it generates an adjourned projection rather than retaining a
  “trashed” placeholder; the retained manual-document restore still preserves
  exact body bytes. V7's unchanged executable sources passed both TypeScript
  checks and driver syntax checks. V7's four workflow failures were an
  incorrect test-only `trashMeeting` method; V8 uses the original
  `moveToTrash` API and reuses those unchanged compiled outputs.
  V8 all-file manifest SHA256:
  `6ff3e154abbdb05d289c35a1c4b3645e8de6b5924e9af70599628dabedee5f3d`.
  This hash uses the V8 manifest definition, not the older source/resource
  manifest algorithm. The later private-driver changes have separate hashes
  in the installed reports.
- `.migration-test-work/portal-original-regression-run2.log`: **nine original
  Portal scripts passed**. Run1 retains three harness/AST failures; owner
  stubs and legacy/Core profile-sharing behavior checks were corrected
  without changing the unadopted defaults.
- Portal runs 1–4 remain: wrong Room/Portal transport dispatch; cross-realm
  EndpointStore plain-object rejection plus an old project writer call;
  finally pairing's intentional incoming-control revocation. Later successful
  runs retain the real pairing/permission/nonce protocol, not a bypass.

**These earlier attempts did not establish an installed Meeting pass.**
The later exact private admission run6 above is a separate bounded pass.
The earlier private installed journey
uses the original fixed VSIX plus a separately labelled compiled overlay;
it is not a release-package audit or ordinary production caller.
`meeting-installed-run1.log` failed because the fresh target was pre-created;
run2 failed because a cold extension module did not have the actual activated
product context; run3 connected its browser websocket but timed out during
CDP attachment before any product-driver event.
Run3's private bus log records rejected method replies/NameAcquired signals.
Correcting the fixture's receiving policy and workbench-ready gate allowed
actual CDP attachment and product activation in runs 4–8. Runs 4/6/7 exposed
the original single-Host Discuss rule: the actual Hub replied **“Discuss
requires at least one recipient.”** Run5's attempt to substitute `hostToken`
for the join secret was a wrong fixture assumption and was fully reverted.

Run8 (`meeting-installed-c7b43da1-5905-4452-b807-228d22b7c483/report.json`)
completed the original installed baseline: real product context/SecretStorage,
Host identity, a real installed-protocol Guest recipient, Discuss/opinion,
adjournment, and editing/saving the original Note in the actual editor.
The Guest is **not a second Code profile**. The owned phase then safely
refused `Storage.open`: **“Non-empty legacy Chatroom archives require an
exact in-place adoption journal.”** The fixture's controlled Room/Note copy
has no such qualified admission journal. Candidate owner registration,
read-only provider, authority denial, Trash/Restore refresh, normal-stop
adjournment and installed full-restart qualification were **not reached**.
Do not fabricate a journal, weaken validation, or route the private Meeting
Note through a public Notes importer to bypass this real entry blocker.
Failure fixtures and reports are retained.
Exact recorded descendants and owned fixture argv/cwd cleanup found no
remaining owned processes; inaccessible global processes were not inspected
or stopped. The private Code window was formally returned to the root agent.
History pins/inventory/captures were not refreshed; old provenance remains
stale for the changed source.

### Meeting increment verification: source-focused, not installed

- `.migration-test-work/meeting-owner-verification.json` records the complete
  scope and retained failures.
- `.migration-test-work/meeting-owner-frozen-v3-verification.log`:
  **14 Next/Room cases passed**, including both reconnect choices, original
  4.0.22 canonical/Note data, actual Storage close/reopen, Host credential
  removal, forged Guest snapshots, stale revisions, SQL Note-write rollback,
  source changes during admission, and readonly Note/provider/dialog behavior.
- `.migration-test-work/meeting-owner-frozen-v3-original-scripts.log`:
  **seven original regression scripts passed**: Meeting state, lifecycle,
  snapshot delivery, Room cards, managed-agent routing, Room identity and
  Portal permissions (13 permission cases).
- Frozen source/resource SHA256:
  `7f4598427cf70d3e8b1f750290d7a2d9a549944c5387a4fe59219f089ae329db`.
  Sources were rechecked after both runs. Frozen and current shared-tree
  extension/Next TypeScript checks passed.

The v3 combined command exited 1 **after all 14 Node cases passed** because
an original script lacked its generated compatibility worker entry. Running
the existing postbuild bridge generator and copying declared sql.js assets
inside that same frozen `dist` allowed all seven scripts to pass; no executable
source changed. Earlier v1 refused an uninspectable PID during parallel tests
(its identity was not established); v2 lacked the original VSIX in the fixture.
Both failure logs remain. Serial private PID/proc testing did not relax any
production admission gate. Exact frozen-fixture argv/cwd cleanup found no
remaining processes, not system-wide exclusion.

The Meeting manager/provider/modal APIs and profile secrets are scripted VM
objects; the actual retained 4.0.22 files and Next SQLite/Storage are used.
**This is not installed Meeting renderer, real profile/keyring, or ordinary
production default-route qualification.** No Code window was started for this
increment; the earlier installed Room evidence does not cover these changes.

Earlier Room-only source-focused evidence (predates this Meeting increment):

- `.migration-test-work/room-ui-owner-verification.json`
- `.migration-test-work/room-ui-owner-frozen-pidns-v2-verification.log`:
  **13 Room tests plus three original-UI regression scripts passed**. Both
  Next and extension TypeScript checks also passed.
- Frozen source/resource SHA256:
  `6a612216894e1639140194eb21df711882aad7fa24f18aea045bfa39c413bd34`.
  The snapshot manifest was rechecked after testing; exact fixture argv/cwd
  cleanup found no remaining processes.

The new tests transpile the actual complete `ChatRoomManager`, use actual
Next Storage/runtime and retained clients, and extract unchanged clients and
archive writers from the SHA-checked original 4.0.22 VSIX. Both policy choices
exercise reconnection; original archive Host identity, core-only rename,
rotation, repair and unchanged source/archive bytes are checked. Rotation
tests cover interruption before/after profile writes, concurrent readers,
unmatched secrets and connection-open failure. However, the manager runs in a
VM with scripted VS Code APIs and an isolated in-memory credential store:
this is **not installed default-route or real SecretStorage qualification**.
The installed 4.0.69 evidence below predates this route.

The first frozen regression run deliberately retained the global admission
gate and refused unrelated/uninspectable hosts in two adoption cases. Those
processes were not stopped. Private PID/proc isolation removed that unrelated
inventory, but a second fixture attempt lacked the existing `next-server/compat`
resources. Both failed logs are preserved separately in the verification JSON.
The complete snapshot then passed in an unprivileged user/PID namespace;
no production gate or historical pin was changed, and no Code window was
started for this source-focused round.

The original 4.0.22 shipped UI exposes the following actions. Owner-injected
source-focused verification is distinct from the installed isolated-trial
evidence below:

| Original action | Current Next/legacy status |
| --- | --- |
| Start Hub, create another Room, choose Host name/secret, rehost, close one, stop/close all | Qualified-owner original-manager adapter supports these; ordinary unregistered production roots retain the old Hub. Installed evidence below remains for the separate isolated trial. |
| Join, rejoin, leave, switch active Room, forget recent, browser link | Original Guest UI still uses its existing protocol client and recents; joining the isolated Next Hub is supported, not a migrated Next Guest UI. |
| Send structured text, replies, images; share/save files; export history | Original-manager source-focused coverage includes structured send, image composer, bidirectional files/save and export against an original 4.0.22 client; not installed renderer qualification of this new route. |
| Copy invite, reveal/rotate secret | Original manager retains invite/key state; the owner facade supports durable profile/core secret rotation, including interrupted writes. Transport is still plaintext. |
| Rename active/stored Room, repair/delete stored data, force-close remote Host | Owner facade supports rename/repair and native Room deletion. Preserved archive deletion and remote force-close remain unsupported. |
| Moderate participant, rename self; add/edit/remove managed agent | Original-manager source-focused coverage exercises these against the real retained clients/runtime. It connects/edits/removes a managed agent, but does not execute a model or qualify every moderation operation. |
| Meeting start/adjourn, open note, trash/restore/delete meeting | Conditional qualified-owner adapter with retained reducer supports the Core workflow above; later source adds guarded editable Core Notes (new installed renderer qualification pending). Ordinary roots retain old filesystem Meetings. |
| Portal relay/routing and browser participation | Explicit command-only Portal owner/executor injection supports the original General/external endpoint route in source-focused tests; absent that capability connect/restore remains blocked. Bound-Chat, model, files, sharing and MCP grants remain unavailable. Ordinary roots retain old Portal behavior; browser Room links do not qualify Portal. |

New isolated Rooms use a native SQLite definition and runtime, with independent
profile-held Host credentials and a recovery pin written before creation. The
original Chatroom Host form also offers an explicitly separate “Host in
isolated Next trial” entry; it pre-fills the trial's Room prompts and retains
the directory selection, trust, reconnect-policy and Host confirmations. The
existing “Host Room” action retains the old Hub unless the qualified-owner
route above is explicitly installed by the trusted workspace host.
Restart requires explicit Room selection and Host authorization; no new
Room opens automatically. An interrupted create remains pinned so the same
intent can be completed rather than automatically generating another identity.
This does not route the original production Chatroom UI or change the
same-root adoption gate.

The 4.0.68 private installed attempt created a native Room alongside copied
Rooms, connected an original Guest, and persisted a Host message. Its live
message assertion incorrectly inspected a stale webview state snapshot and
timed out; a corrected controller rerun failed earlier when the original Host
restart's debugging endpoint timed out. Both attempts exited nonzero; their
logs are `.migration-test-work/room68-installed-run{2,3}.log` and their private
fixtures are `room-installed-5ef9ea04-88ad-43e6-b985-c4673971a640` and
`room-installed-8843a577-9c1c-4cf2-ba01-ef0ede2f4010`, respectively.
They do not qualify the complete installed new-Room or restart workflow.

The follow-up investigation confirmed that the first failed fixture's native
Room database contains `@all Native-created Room message`; the old renderer
handles live messages separately from its last full `chat.active` snapshot.
The installed controller now checks the rendered log for that live delivery,
while retaining history assertions after rejoin. The second fixture's saved
stderr contains D-Bus connection timeouts, not evidence that disk exhaustion
caused its CDP failure. The controller now provides a private session bus and
per-launch logs rather than connecting to the machine's session/system bus.
A further run (`room68-installed-run4.log`) failed while waiting for old Code
descendants to exit. The controller now records and terminates only descendants
captured from its own private Code process, checking their PID start times
before signaling. In particular, the original 4.0.22 background
`pkm-service-entry.js` can survive the editor process: editor exit alone is not
proof that all old writers stopped. No production process is stopped by this
test cleanup, and failed fixtures remain preserved.
The next controller attempt (`room68-installed-run5.log`) reached the real
installed Host kill and restart, but selected the first alphabetically sorted
recovery entry, which was now the newly created Room rather than the intended
historical Room. The Guest could not reconnect to its inactive Room. The
driver now selects the explicit configured Room UUID and fails immediately
if that Room is unavailable; Room ordering is not an identity binding.
`room68-installed-run6.log` then reached both complete historical-Room Host
restarts and the native Room's installed Host kill/recovery, but its final
cleanup attempted Leave after stopping the Hub. The original UI hides its
active pane for a disconnected Room. The controller now performs the real
visible Leave action while still connected, before Stop; it does not force a
click on a hidden control. This nonzero run is not counted as a complete
installed journey.
`room68-installed-run7.log` completed that recovery section but failed at the
new form-entry step: the older frozen 4.0.68 package does not contain the
later-added form button at all, despite current source having it. Both
profiles' 5,471 package files matched that original frozen VSIX. The missing
entry must be tested in a newly built candidate, not inferred from source
tests or repaired by modifying an installed extension. The follow-up 4.0.69
candidate was frozen and built separately; its source and VSIX digests are
recorded in its `candidate.json`.

The frozen 4.0.69 installed journey then exited **0**, including the actual
Chatroom form's **Host in isolated Next trial…** button, real prefilled Room
inputs and trial/Host confirmation dialogs. It repeated original 4.0.22
Host/Guest identity and two-Room baseline behavior, original Host restart,
independent Room close/rehost, repeated old-client approvals, native creation
and live delivery, Guest upgrade/restart, network retry, two complete Host
restarts, and actual installed extension-host `SIGKILL` plus child exit for
both historical and native Rooms. Recovery and approval dialogs were real;
other setup selections remained scripted. Host death delivered `closed`, so
the Guest needed manual rejoin rather than automatically reconnecting.
Evidence:

- `.migration-test-work/room69-installed-run1.log`
- `.migration-test-work/room-installed-963e3041-32de-4d03-91b0-e495984c3a00-verification.json`
- `.migration-test-work/room69-installed-integrity.json`: both profiles' 5,473
  package files, VSIX manifest and package JSON match the frozen package,
  excluding only VS Code's added `__metadata`; no unexpected files.
- `.migration-test-work/room69-historical-host-integrity.json`: both original
  Host participant IDs survived; original, source-copy and trial-copy archive
  database bytes remain identical.
- `.migration-test-work/room69-cleanup.json`: an independent argv/cwd check
  found no processes belonging to this round's five fixtures before the
  private Code test window was explicitly handed back.
- `.migration-test-work/room69-frozen-focused.log`: nine focused lifecycle,
  identity, recovery and form/trust tests passed against this frozen source
  and its staged runtime.

The candidate source digest is
`8a428b667223d82bbe5ff3811305a1745c41e7e14c8645cfeedf394d8fbe9397`;
the VSIX digest is
`5ac4656415d86560497de16d5b1fc09cf9ea73a841ade28c349e20e941a4899a`.
No background UI errors were reported. This remains a private, isolated
loopback/veth trial using basic password storage and plaintext `ws`/HTTP, not
a production-root upgrade, OS-keyring, TLS, browser/Portal or complete legacy
action qualification. All earlier nonzero attempts remain separate.

The native multi-Room regression exercises independent Host sessions and
credentials, same-port hosting, closing one Room without closing another,
v1 index upgrade, inventory mismatch, child `SIGKILL` and explicit rehost. This
synthetic test alone does not demonstrate a killed installed VS Code Host.

A separate frozen 4.0.65 installed journey used an actual 4.0.22 Host and
Guest in private VS Code profiles and network namespaces. The original Host
hosted two Rooms on one Hub, and after a complete restart both were inactive
until individually rehosted. The upgraded Host hosted both, closed and
rehosted one without closing the other, and routed each Room's own historical
Guest identity and history. With both active, the test identified and
`SIGKILL`ed the installed VS Code extension-host process, verified that its
actual native child exited, restarted Code, and explicitly rehosted each Room.
The Guest received `closed` and needed a manual rejoin; this does not prove
automatic reconnection after Host death. Old clients still needed approval on
each identity recovery. The successful runner exited 0:
`.migration-test-work/room-installed-405acd6f-97db-4530-8da2-57b1ed138e48-verification.json`.
Setup was scripted; approval and recovery confirmations were actual VS Code
dialogs. Three earlier controller attempts exited 1 and are retained in
`.migration-test-work/room65-multi-installed-run{1,2,3}.log`. The independent
cleanup and installed-file checks are `room65-cleanup.json` and
`room65-installed-integrity.json` in the same directory. This does not qualify
physical multi-machine networking, TLS, OS keyring or production migration.

The 4.0.54 installed-profile journey additionally restarted the original Host:
its Hub remained stopped until the user expanded Inactive and rehosted. It
then restarted the upgraded Host twice, once while its Room was active and
once after Stop. The real Host profile and upgraded Guest retained credentials
and identity; original history was verified before these restarts. The Host
explicitly confirmed recovery and the Guest manually rejoined without another
approval. In the active-process restart the
child sent `closed`, so that run did **not** demonstrate automatic reconnect
across a Host restart. Its successful runner exited 0:
`.migration-test-work/room-installed-7a084d9b-9491-44a2-9f45-ba57ebc2124b-verification.json`.
Two earlier controller runs exited 1 waiting for the old UI's collapsed
Inactive section; the failed fixtures and the corrected controller are retained
separately in `.migration-test-work/room-restart-54-controller-failures.json`.
They do not establish an earlier successful journey.
The source subsequently added a workspace-trust check before starting the
Room-only child. `tests/test-next-room-recovery-trust.js` covers that guard;
those later source bytes were not part of the installed 4.0.54 run but were
included in the 4.0.57 candidate below.
The installed run used a test driver for setup, real Host recovery and
participant-approval dialogs, VS Code basic password storage, and plaintext
`ws` via a private relay. It does not qualify encryption at rest, TLS, a
production root, multiple physical machines, automatic Host startup or a
force-killed Host. The pin and inode checks do not protect against a malicious
process with the same OS account modifying the database in place.
The focused Room-only recovery regression also checks missing/changed profile
credentials, replaced markers, changed archive, denied non-Room operations,
repeat rehost and a competing writer fence. It also kills the synthetic native
child with `SIGKILL` and observes a credentialed client's automatic retry after
a new child opens the same port; that is not a killed installed VS Code Host.
Three other packaged-snapshot IPC
and runtime cases passed. A fourth, unrelated same-root adoption case was
blocked by the existing unverified VS Code hosts; none was terminated.
A separate 4.0.56 snapshot did not build because it captured unrelated Recipe
edits mid-change; `.migration-test-work/room-candidate-56-build-failure.json`
records its diagnostics. It was not installed or counted as a passing run.

The final frozen 4.0.57 candidate repeated the complete installed journey,
including both proof-required and Host-approval modes on a stable port. After
the first Host restart, the Guest was also fully restarted and independently
received the original history and identity without another approval. The
runner exited 0 with no reported background errors:
`.migration-test-work/room-installed-0c0d6bd2-54d5-447f-9cc3-c7762910f266-verification.json`.
Both installed profiles independently matched 5,461 package files byte for
byte, the original VSIX manifest, and the package JSON after excluding VS
Code's added `__metadata`. The initial literal JSON byte comparison failed
and is retained alongside the corrected integrity report. A separate exact
fixture argv/cwd process check found no remaining processes.
The original client treats a `closed` frame as deliberate shutdown and stops
automatic retries; this differs from an unexpected transport disconnect.

The normal copy importer currently rejects `chatrooms` as
`unsupported-surface`; its Chatroom plan is restricted to in-place adoption.
The explicit Room-only private-copy action does not change that gate. An
eventual production route needs an authorized copy/import plan or safe
same-root handoff, the old Room UI and its lifecycle/meeting storage routed to
the selected Next workspace, and installed-upgrade validation.
The actual default **Host Room** form still sends `chatStartHub` to the old
`ChatRoomManager` in `src/extension.ts`. The separate experimental button
sends `chatStartNextIsolated` to `personalKnowledge.nextTrialStart`; its host
menu is in `src/ui/next-managed-trial.ts`. Joining and leaving still use the
retained Chatroom Guest UI/client. Neither entry migrates the original Root
or routes the old rename/repair/delete, moderation/managed-agent, secret
rotation, structured composer/export, meeting or Portal menus to the Next
Host. The action table above remains the unfinished-work boundary.

Non-Host participant reconnect cannot safely inherit authority from the old
client ID alone. The adapter issues a random per-participant resume credential
for newly admitted clients and persists only its hash, bound to the Room,
participant and client ID. The upgraded `ChatClient` and existing human Room
join path use `NextRoomResumeStore` in the profile's SecretStorage. A name-only
join learns the Room ID from the credential frame after the server approves the
join, and stores an endpoint/name/client-ID index pointing to the Room-bound
credential. A changed endpoint never receives the old credential automatically;
all isolated Host reconnect modes let the user choose a stable loopback port
for rehost, or explicitly choose port 0 for a temporary one. A stale name index
is removed after a Room-ID mismatch, allowing a
subsequent manual join. Removal revokes the server-side credential.
The name-only index is exact; a renamed Room or a different spelling needs a
fresh approval unless its Room ID is already known.
The old protocol has no per-participant credential: `chatroom-hub.ts` checks the
shared Room secret, then `chat-join-approval.ts` automatically reuses the most
recent offline, non-forgotten membership for that client ID. A simultaneous
same-alias/same-ID connection supersedes the earlier one; a different ID with
the same active alias is rejected. `resumeAfter` requests message catchup, not
identity authentication. The retained Hub regression
`tests/test-chat-hub-approval.js` verifies those behaviors and Host rehost.
The compiled `chat-join-approval.js` in the original 4.0.22 VSIX also matches
the prior approved client key to an offline, non-forgotten participant without
a participant credential. Removing repeat approval for unmodified clients
would therefore restore client-ID impersonation risk; it is not enabled.
The adapter preserves bounded historical join records but does not permit that
insecure identity reuse. A
forgotten member may join with the same client ID as a **new** participant,
matching the old Hub; a retained historic membership is still blocked. An old
client does not recognize the new `participant-proof-required` error as
permanent and can keep retrying; the Host should stop it until a migration
choice is available.

Migration choices (historical isolated-action checkpoint; the newer
conditional-owner product route above separately exposes explicit **Keep
Legacy Reconnect**. “Not implemented” below describes this older action,
not the current conditional route or a production qualification):

1. **Explicit legacy compatibility (not implemented):** after a Host warning, allow the old
   shared-secret-plus-client-ID mapping for non-Hosts. Old clients and automatic
   reconnect work unchanged, but any Room-secret holder who learns a client ID
   can impersonate that participant. Host identity must still require Host
   proof. This requires an explicit product security decision; it is not the
   current default.
2. **Host-approved historical binding:** the isolated Host action can explicitly
   choose this mode and review pending requests. The dialog displays the
   historical participant, previous/requested aliases, client ID and kind;
   the Host must verify the requester out of band. Approval binds only the
   matching offline, non-forgotten historical participant, rechecks Host
   authority and does not block other Room traffic while waiting. A denial,
   disconnection, timeout, competing request or Host revocation cannot grant
   the identity. The approved join rotates the participant credential, so a
   lost previous credential can be recovered. An unmodified old client needs
   a new Host approval on each reconnect; this is a deliberate interaction
   change from the old automatic client-ID-only reuse. The actual 4.0.22
   client labels `join.pending` “assigning Room identity automatically…”,
   even when this Host is waiting for human approval. Pending requests expire
   after two minutes; disconnection can trigger another retry. An explicit
   rejection stops that client's retry and requires a new manual join.
3. **Join as a new member:** the isolated Host action can explicitly choose
   this for old clients without a private credential. The server assigns a new
   identity without requiring a client upgrade; historic messages keep their
   original author. Every reconnect can create another identity, and an
   overlapping same-alias connection can still be rejected. This is available
   only in the isolated trial; preserving a stable new identity needs client UI
   and private credential storage.
4. **Upgrade participant credentials:** after approved join/rebind, the updated
   VS Code human participant path stores the random credential and reconnects
   automatically to the exact same endpoint. A lost frame or credential needs
   another Host approval. Other old clients, including browser, MCP and managed
   agents, have not been upgraded to persist this credential.

Temporary managed participants are forgotten on rehost. Secret rotation is
currently refused for a credential-bound Room until the SecretStorage and
archive metadata update can be coordinated durably.

The old hub persisted file metadata but relayed attachment bytes only to
connected clients; bytes absent from all surviving client storage are not
recoverable from the Room database. New transfers support the old 25 MiB
per-file limit, but the experimental durable adapter still has a 64 MiB total
Room quota and 128-file bound. `legacy-chatroom-remote.mjs` exercises actual WebSocket messaging, attachment
transfer and approved historical identity credential reconnect across two
private Linux network namespaces connected by a veth pair. Its approval is a
test callback, not a VS Code Host; the separate VS Code journey above exercises
the real Host and dialog. Neither test alone qualifies a production upgrade;
the separate installed-profile run above is restricted to the stated scope. None
is a two-physical-machine or browser/Portal qualification. The isolated UI action is loopback-only;
the retained network protocol remains plaintext and requires a separately
protected transport for confidential remote use.
