# 4.0.0 Release Readiness

Review date: 2026-10-25. Development version remains **3.2.106**.
**4.0.0 is a target, not a published or installed release.**

## Action Library / Workbench separation follow-up

Local **3.2.118** removes automatic Workbench catalog restoration/popups and
shows concise validation guidance. Pending proposals appear in the left Actions
tree with **Need Validation** and highlighted flasks; they remain excluded from
the executable catalog. The exact proposal ID/hash flows through native
review-first validation. Seven Library/UI cases passed, including restored legacy
popup state, three Falcon-shaped pending rows, effect-consent cancellation, exact
dispatch, badge removal after admission and preservation of the previous executable
revision during an update. Native dispatch, embedded panel restoration, private
palette and authenticated browser handoff checks passed. The handoff test now uses
a CSP-safe function predicate and a one-pixel pointer-coordinate tolerance.
The full package lifecycle passed, and five installed Linux UI/runtime assets
match the VSIX byte-for-byte. No automatic window reload, model review, smoke
execution of the user's Actions or Marketplace publication was performed.

Local **3.2.117** packaging passed the complete existing package lifecycle.
The installed Linux VSIX matches seven checked UI/runtime assets byte-for-byte.
The shared Sync daemon was explicitly drained and replaced with **3.2.117**;
CreativeGen Share and Primary Backup remain paused. CreativeGen's unverified
migration was archived and restarted at `previewed` against its last fetched
commit, with zero collisions after recognizing schema-3 Markdown resource members.
This recovery did not execute a production Sync or push. Stage must still fetch
and fence the current remote before Verify/Cutover and an explicitly authorized
manual sync. Neither the VS Code window nor the existing MCP process was reloaded.

Action Library is now an independent admitted-Action browser; it shows readiness
and supports explicit typed invocation. Opening or inspecting it does not open
Workbench. Per-Action/Run links explicitly navigate there. Workbench retains
proposals, editing, review and validation under **Review / test Actions**.

The embedded iframe previously allowed scripts but blocked forms, preventing
folder and Move to submit handlers from firing. A real sandboxed-iframe browser
test reproduces the blocked submission and passes with `allow-forms`, while
preserving opaque-origin isolation. It covers three-level folders, persisted
nested moves, automatic destination expansion and visible duplicate-folder errors.
The independent Library browser test covers unverified readiness, pending-proposal
exclusion, typed invocation/consent, original-Run polling, explicit navigation,
mobile layout and service errors. Native bridge tests cover read-only/mutation
boundaries and Root-change rejection. These are source-level checks, not
installed-host or Marketplace acceptance.

## 2026-10-25 Test Inventory Recheck

The current source build passed (`5c37b21ff246`). All **318 top-level files**
were inventoried: 271 JavaScript and 47 Python. File exits are not case counts:
after resolving failures and classifying helpers/skips, **314 independent
entries passed**, two exported scenarios ran through the API Chat suite, one
offline-package suite was entirely skipped, and one real-encoder gate was
blocked by missing explicit model input. Passing entries still contain
**six skipped cases** (three JavaScript, three Python), including the entirely
skipped package suite.

The initial inventory pass recorded 308 zero exits, eight failures, one helper
and one blocked gate. The zero exits included a second helper and the entirely
skipped suite; neither is counted as an independent passing entry above.
All eight failures subsequently passed targeted reruns:

- Three preview-dependent browser files passed against an explicitly owned
  local preview server, not an assumed existing server.
- The inline Action form passed after replacing obsolete dropdown interactions
  with actual radio/checkbox selection and checking draft restoration.
- Four retrieval Python suites passed **19/19 cases** using the existing
  retrieval Python and the integrity-verified bundled engine, rather than the
  generic interpreter that lacked the engine.

The preview reruns also exposed two stale default-expanded assumptions.
[Snapshot browser acceptance](../tests/test-agent-snapshots-browser-ui.py) and
[Recipe/Trash browser acceptance](../tests/test-recipe-browser-ui.py) now restore
the category tree explicitly; the Snapshot test also opens its collapsed group.
[Action forms](../tests/test-chat-action-forms.py) retain validation, retry and
cancel assertions. Production collapsed-tree and vertical-choice behavior was
not reverted, and no assertion was disabled or marked TODO.

Additional checks passed:

- Nested Memory Engine: **51 Python + 16 JavaScript cases**, no skips.
- Meeting coverage gate: statements/lines **99.74%**, branches **72.29%**,
  functions **100%**, limited to the two configured Meeting modules.
- Python syntax checks for the three changed browser files, and diff whitespace.

### Implementation Status and Remaining Acceptance

| Area | Remaining verification or implementation |
|---|---|
| Production Chat retrieval | Implemented dual routing through the production adapter, invocation metadata and explicit-only relevance feedback. The real Python worker/HTTP chain is exercised with the existing synthetic frozen encoder; controller and DOM tests cover receipts, review/cancel/errors. Live encoder quality remains separate acceptance. |
| Long current Task input | Implemented explicit user-reviewed prefix checkpoints with unchanged originals, exact hash/range readback, revocation and mandatory newer requirements. A synthetic 4/16/64/256-input test measured 14,280/55,134/218,574/872,490 units before approval and 1,491/1,492/1,492/1,493 afterward. These are conservative input units, not provider tokens or live-model quality evidence. |
| Release gate wiring | Both Marketplace `pretest:release` and local `package` now require the shared Credit-ledger/nested-Memory accounting gate and retrieval/checkpoint/controller/browser gate after a complete build, before publication/packaging boundaries. The release-workflow contract prevents those gates being dropped. |
| Provider billing | Token/Credit transport, persistence and UI fixtures passed; actual billing metadata in the user's running provider has not been revalidated by a paid request. |
| Installed workbench | DAILY-HOST-01 through DAILY-HOST-04 remain not run: native Chat/PKM coexistence, dynamic layout/scroll and isolated SSH recovery. See the [daily matrix](../tests/cases/PKM_CHAT_DAILY_TEST_CASES.md). |
| Optional runtime gates | Real previous-version MCP and service compatibility, local default-weight import/setup, opt-in Hugging Face setup and offline package smoke retain six skips. The separate real-encoder feedback audit requires `PKM_RETRIEVAL_TEST_MODEL` and was not rerun here. |
| Broader acceptance | VAL-02/03 gold/quality/resource thresholds, native Windows/macOS, authorized real two-machine Portal/Sync and GitHub workflows remain separate acceptance. |
| Packaging / publication | Follow-up 3.2.107 passes the version-bump and complete local package lifecycle, VSIX metadata/fingerprint/boundary checks and remote CLI installation. Existing live Hosts still advertise 3.2.106 pending user Reload. Windows installation, installed-Host acceptance and Marketplace publication are not claimed. |

This was a full inventory pass plus targeted recovery, not a clean no-skip
318-file run or a full release certification. No dependency/model download,
paid model request, installation, user-Host reload, commit, push or publication
was performed.

### Follow-up implementation gates

`npm run test:chat-accounting:run` runs the dedicated Chat budget/Credit ledger
and nested Memory Engine accounting suites. `npm run test:chat-retrieval:run`
checks the production adapter/real worker chain, checkpoint growth and authority,
actual controller confirmation flows, persistence and rendered inspector controls.
Both commands reuse a coherent full build and are mandatory in release/package
prerequisites. `test:chat-context` also includes the real-worker integration.

User-approved checkpoints are a manual reviewed replacement of old Task inputs,
not inferred Memory authority or automatic semantic compression. Original inputs
survive reopening and remain individually readable. Tests cover History off,
Task changes, source invalidation, revocation, covered-input retries, failed or
cancelled confirmations and cross-window revision conflicts. No live provider
request, model acquisition or installed-Host acceptance is implied by these gates.

Final local follow-up verification:

- Complete build and `test:chat-context`: **225 passed**, no skips.
- Mandatory `test:chat-retrieval:run`: **145 passed**, no skips, including
  the complete API Chat controller suite and 38 rendered activity/browser cases.
- Mandatory `test:chat-accounting:run`: **12 Chat ledger + 51 Python Memory +
  16 JavaScript Memory cases passed**, no skips.
- Existing retrieval-worker integration, release-workflow contract,
  471 aligned localization keys across 11 locales, and diff whitespace passed.

These gates overlap; their case counts are not an additive coverage percentage.
Checkpoint report supersession is tracked by causal report identity, not clock
ordering, so equal timestamps cannot accidentally discard a later report.
These regression results alone do not establish publication, installed-Host
acceptance or real-encoder quality. The subsequent packaging/install handoff is
recorded separately below.

### Review-first validation installation handoff (3.2.116)

This supersedes the separate manual grant/admission flow below. The operator
clicks Validate, chooses a callable VS Code review model, and consents to any
non-pure smoke effects. A strict passing Agent review starts staged smoke tests;
only passing tests and final Root/trust/source/base/environment checks admit the
exact version. Missing/invalid/rejected reviews block execution. Test failures
preserve the previous approved registry definition. Direct non-builtin MCP
qualification hands off to Workbench rather than accepting agent-supplied grants.

Unverified drag attempts now show a dialog and highlight the flask. Validation
uses a Workbench dialog rather than browser `confirm()`, with persistent visible
review/test/cancellation/error feedback. Longer validation requests no longer
inherit the ordinary 35-second UI timeout.

Acceptance: 16 authoring cases, 4 Library cases, 37 module compatibility cases,
native model-verdict/dispatch tests and real stdio MCP passed. All nine Workbench
scenarios passed across the complete run plus a focused authenticated-handoff
rerun after correcting that fixture's private API request shape. Python syntax
checks passed. Full `npm run package` gates and isolated VSIX/service tests passed.
Model outcomes in tests are fixtures; no live paid model call or Azure query was
performed.

The final local 3.2.116 VSIX is 10,093,966 bytes, SHA-256
`b29ed5a8c4090d085a6e25446340828bce308974511320af75d19a3aa84c5cef`,
build `6869052b6218d419c5cdf0655a47d829ab6fbdb5e0a24b2e795fa42e1fab3b7a`.
Installation into current Linux Remote VS Code succeeded; installed build,
review orchestration, runtime and flask/canvas resources match the VSIX.
No automatic reload, actual user Action qualification, Windows installation,
Marketplace publication, commit or push was performed.

### Action proposal admission installation handoff (3.2.114)

Public MCP/Workbench authoring now submits pending proposals instead of writing
the formal registry. Native operator confirmation admits and authorizes the exact
revision; qualification and effect consent remain explicit subsequent steps.
The Action Library separates proposals and existing/imported unapproved
definitions from admitted Actions. Updates preserve the previous approved
version while pending, and approved source cannot be overwritten through the
Workbench. Cancellation/rejection never runs or registers the proposal.

Authoring acceptance passed **13 cases**, including real MCP submission,
no self-approval tools, previous-version invocation during a pending update,
stale-source/base rejection, rejection with missing source and write rollback.
All **9 Workbench cases** passed, including authenticated browser handoff,
composition admission, definition proposals, immutable source and imported
ModuleSet admission. All three Library scenarios passed through focused
reruns, including desktop/mobile drafts and native-review request routing.
Monitoring/builtin compatibility passed **11 + 7 cases**; Pylance syntax,
native confirmation/bypass tests and real stdio MCP discovery/calls passed.

The complete local `npm run package` release gates and isolated VSIX
metadata/dependency/service/boundary tests passed. The final universal stable
`personal-knowledge-3.2.114.vsix` is **10,085,721 bytes**, SHA-256
`442d87468d15d8f90d9121b5d86c4209661543c1bc63f0b278b7fdb5f184951a`.
Its build ID is
`4f555da7132ace87eab630f61828c62d968764ece1d626a76a0efaf2c40fbf53`.
Remote VS Code CLI installation succeeded; installed version, build metadata
and proposal/runtime/browser resources match the final VSIX. The intermediate
3.2.113 package is not the proposal-workflow handoff.

No automatic window reload, real Action admission, Azure query, paid model call,
Windows installation, commit or publication was performed. Existing live Hosts
still need user reload/reconnection before claiming the new runtime is active.

### Role-only Portal installation handoff (3.2.112)

Setup now asks only Controller or Controlled. Controller automatically resolves
the forwarded endpoint and copies its code; Controlled pastes that code and
explicitly approves control. Naming, create/accept selection and endpoint
configuration dialogs are removed. Reversed legacy codes are rejected by setup,
cancelled input opens no connection, and context changes during forwarding fail
explicitly. Native external UI and Chat-local permission boundaries remain.
This does not establish a fix for the reported Windows forwarding timeout.

The full `npm run package` pipeline passed: peer lifecycle **22/22**, real
FastMCP/TypeScript transport, accounting **12 + 51 + 16**,
retrieval/controller/browser **149/149** and combined contracts **264/264**.
The earlier focused setup/permission/transfer batches passed **25 + 78**.
These overlapping counts are not additive coverage. Existing optional
environment tests retain their skips.

The universal stable `personal-knowledge-3.2.112.vsix` is 10,079,685 bytes,
SHA-256 `c4f67acc7559ebf37c8a55572ca5e5ac1ccde9a8f826240cdb1e435575b3ca1d`.
Its build ID is
`293b3508c6a1a788181875c0bf5bbf7f7d622fe0f7e5f1c87ae68c4ac3dd5312`,
with 425 fingerprinted artifacts. Isolated VSIX dependency, service and package
boundary checks passed. On user request it was installed through VS Code's
server CLI into the current Linux Remote extension environment. CLI inventory
reports 3.2.112 and installed metadata/fingerprint match the VSIX.
No window reload, Portal reconnect, Windows-side installation or publication was
performed; installed runtime/Windows visual and network acceptance remain pending.

### Temporary Portal lifecycle follow-up (3.2.111)

Portal pairing credentials, connection views, approval state, permissions and
task fingerprints/receipts are now Host-local memory, not restart-recovery data.
Disconnect, remote revoke, transport loss, Root/trust changes and disposal
cancel local execution and discard pairing state. Fresh pairing is mandatory;
external effects cannot be rolled back and no task is replayed automatically.

The external file-based MCP transport now uses a private per-Host OS-temporary
spool, not Knowledge Root Portal receipts. Orderly disposal deletes it; an
offline Host's Portal receipts are not readable or recoverable. Crashed-Host OS
temporary remnants are not rediscovered. This is not a claim that file IPC has
no temporary on-disk bytes.

Migration removes only indexed Portal credentials, legacy Portal global keys,
task journals and recognized Portal entries in the shared control mailbox.
Chat/Room histories, unrelated Chat control records, transferred files and the
earlier automatically-created Chat remain intact. Migration errors are surfaced;
symlink escapes and unexpected task-journal members are rejected. Source-level
tests do not mean cleanup has run in an installed Host.

The complete `npm run package` pipeline passed: the new lifecycle gate passed
**22/22** peer cases plus the real FastMCP/TypeScript transport scenario;
accounting passed **12 + 51 + 16**, retrieval/controller/browser **149/149**
and combined contracts **264/264**. These are overlapping suites, not an additive
coverage measure. The first package run exposed an outdated Host test stub
without a real paired session. That fixture now uses actual PeerSession routing
and verifies remote revoke and transport-loss cleanup over real sockets; the
isolated case and complete retry passed without weaker assertions/timeouts.
Obsolete durable-resume tests were replaced by temporary lifecycle/migration
acceptance, including in-flight altered content, the 1,000-task boundary,
concurrent cleanup, shared-mailbox isolation and preserved Chat histories.

The verified universal stable package `personal-knowledge-3.2.111.vsix` is
10,079,771 bytes, SHA-256
`b6803dcbd9d636d98e664d1cddba3720a4baac69889b546dfd5fe083ce4d7733`.
Its build ID is
`378183b80d4415140c7fc8aee6dd5bc8347870672a950850a20c9998b2935b69`,
with 425 fingerprinted artifacts. Isolated package-boundary, dependency and
service tests passed. It was not installed, reloaded, re-paired or published;
installed Windows CPU/responsiveness and visual acceptance remain pending.

### External Portal ownership follow-up (3.2.110)

External Copilot/MCP setup and consent now use native VS Code UI. PKM
Chat-owned Portal operations retain their in-Chat cards. External open allocates
only a Portal identity: it no longer calls the Chat-creation/naming path.
Controlled external execution requires selecting an existing Chat per task.
Cancellation, stale selection and selection of a Chat owning another Portal
do not execute; temporary permission routing is released after execution.
Progress retains the authenticated paired identity. Historical automatically
created Chats were not deleted or hidden.

The related Portal batch passed **82/82**. The complete packaging retry passed
accounting **12 + 51 + 16**, retrieval/controller/browser **149/149** and the
expanded combined contracts **270/270**. Existing optional suites retain six
skips. The initial package attempt hit a FastMCP lifecycle connection-close
failure; its isolated case and the subsequent complete unchanged gate passed.
No timeout or assertion was weakened. Native UI tests mock VS Code controls;
installed Windows/Copilot visual acceptance is still required.

`personal-knowledge-3.2.110.vsix` is 10,084,400 bytes, SHA-256
`711d2e5f0431b3d5cd5b6df7e3db44568a92f4fa82473469be62875dd1f51b49`.
Build ID:
`a2503edc3f7e74d0a30e4e95d7e0cf9b1f039ebe7fa7a0184335c2690e95eb44`,
424 fingerprinted artifacts. Isolated VSIX loading, service and boundary checks
passed. No installation, reload, automatic re-pairing or publication was done.

### Profile placement follow-up (3.2.109)

User Profile now belongs to Automation, including restoration of the previous
Settings page state. Session Profile belongs to Agent Sessions: the shortcut
opens the selected native Chat/Task's current assignment, with its explicit
management flow. Chat's existing Profile shortcut remains available. No
Session Profile management page was added to Settings.

Focused browser/navigation/Profile tests passed **23/23**, including full-panel
workspace restoration and selected-Chat management routing. The complete
`npm run package` pipeline passed with the existing six optional skips.
Accounting passed **12 + 51 + 16**, retrieval/controller/browser **149/149**,
and combined contracts **265/265**. Isolated package-boundary and service tests
passed; these overlapping counts are not an additive coverage measure.

`personal-knowledge-3.2.109.vsix` is 10,081,772 bytes, SHA-256
`a6c793f9aec22b51930646a072d52d2da80484421c3d8f17b15e103dbd62d0c7`.
Its build ID is
`baefb5bd140bee377f1e630e4c89bdce8b91ae6f65ab9508a62ea498e1e0acbf`
with 423 fingerprinted artifacts. It was not installed or published; Windows
runtime acceptance and CPU diagnosis remain pending.

### VSIX test-package handoff (3.2.108)

The complete `npm run package` lifecycle passed for 3.2.108. The package's
combined Node contract suite now limits test-file concurrency to two: its
unbounded run on this shared 48-thread host produced changing Worker/Sync
timer failures, while the isolated Worker case passed. No cases, assertions or
timeouts were removed or relaxed. The bounded full run passed **265/265**.

The related compact-Portal/current-Profile browser and controller batch passed
**63/63**. Required accounting passed **12 Chat ledger + 51 Python Memory +
16 JavaScript Memory** cases; required retrieval/controller/browser passed
**149/149**. Existing optional environment/runtime suites retained **six skips**.
These overlapping counts are not an additive coverage measure.

The verified universal stable package is `personal-knowledge-3.2.108.vsix`,
10,081,277 bytes, SHA-256
`10c81a5cd614de114fee3d3447e3ef22ad065b1b325c2d9d12c5022dc5aac70f`.
Its runtime build ID is
`e2a27f2866fbf5dbbf53b48cb08ecdc9a3aa76ec994bbfd62a13071ca080aeb1`,
covering 423 fingerprinted artifacts. Isolated VSIX dependency, Chat library,
service lifecycle and package-boundary checks passed. The package was not
installed or published, and no Portal was reattached.

Windows inventory execution, CPU/extension responsiveness and installed-host
visual acceptance remain pending; local tests do not establish those outcomes.

### VSIX installation handoff (3.2.107)

On explicit user request, bumped the extension and lockfile to 3.2.107 and ran
the complete `npm run package` lifecycle successfully. The first attempt hit the
existing 120-second nested Memory-suite timeout; the indicated case passed in
isolation, and the unchanged complete lifecycle passed on retry. No gate or
timeout was relaxed.

The verified universal package is `personal-knowledge-3.2.107.vsix`, 10,072,967
bytes, SHA-256
`275b593965afec7b648b62765cc08cdaaab21a6ec81fbd4d8797dbb8eaaec01e`.
Its build ID is
`1295c05fb6b6b1e8442d632e8cc21b2db1e1ec4fb7c6f54f6eb07a26284ede56`.
The existing remote VS Code server CLI installed and lists 3.2.107.
Post-install checks matched 421 artifact hashes and the packaged manifest,
allowing only VS Code's standard added `__metadata` installation field.

Installation is distinct from activation: both existing SSH Hosts still
advertised 3.2.106 immediately afterward. No automatic window reload was
requested, to avoid interrupting the conversation. The user must Reload the
relevant SSH window and install/reload the same VSIX in a Windows-local window
before the subsequently consented Portal acceptance run. No Windows install,
live model/credit acceptance, Portal task, commit, push or publication occurred
during packaging.

## Previous Pre-Release Regression and UI Review (2026-10-24)

**Local regression evidence is complete; publication is still blocked by the
unchanged version and the remaining acceptance items below.** The final full
build passed, including bundled UI syntax, source ownership and 36 required UI
artifact checks (build `5eae92f1b4a5`). This build has not been packaged or installed.

| Check | Result | Boundary |
|---|---|---|
| Complete top-level test inventory | **318 files executed: 271 JavaScript, 47 Python** | First pass: 302 successful, 16 failed, no timeouts. All 16 subsequently passed targeted reruns; the original failures remain recorded. This is not a new all-files run after the fixes. |
| Exact full browser release plan | **9/9 suites passed**, about 82 seconds | Includes Panel, standalone Recipe, PKM Chat/Profiles, Router, Portal/Sync fixtures, feature introduction and isolated Extension Host startup. |
| Isolated startup | **5/5 scenarios passed** | Clean install, persisted upgrade, offline, malformed state and repeated reload; no running user window was reloaded. |
| Activity/Harness/Panel theme regressions | **66/66 passed, no skips** | Dark, light, high-contrast and high-contrast-light; Chat widths 280/390/1280, Dashboard and Panel widths 320/390/1280. Narrow Panel checks explicitly collapse the existing category sidebar first. |
| Real offline encoder feedback audit | **1/1 passed** | Actual imported encoder, persisted attribution, restart, private-query non-persistence and frozen-weight checks; existing local runtime and weights, no download or paid inference. |
| Nested Memory Engine suite | **51 Python + 15 JavaScript cases passed, no skips** | All three module-level Python test files plus the configured service/client/accounting integration runner; full bundles were preserved instead of rerunning plain `tsc`. |
| Release simulation wrapper | **Passed** | Actual configured deterministic Chatroom/Project simulation command, not live external services. |
| Chatroom coverage gate | **Passed** | Statements/lines 99.74%, branches 72.29%, functions 100%; this covers the two configured Meeting modules, not all PKM Chat. |
| Publication version gate | **Failed, unresolved** | Product files changed, but the version is still 3.2.106 and must increase. No version change was made during this review. |

The inventory retains **six JavaScript and three Python skipped cases** from
environment/optional-runtime gates. Successful file exits do not mean every
optional case executed. The real encoder audit above is separate evidence, not
a replacement for those skipped scenarios.

### Corrections Made During This Review

- Tool-command details now use the theme foreground instead of inheriting
  success green or muted text. Settings/Profile and Harness secondary buttons
  pair their backgrounds with the corresponding theme foreground.
- Native checkbox/select color schemes follow light/dark VS Code theme classes.
  High-contrast Harness stages remain opaque and have explicit borders/focus,
  rather than fading pending stages into the background.
- Browser checks verify on-screen, unobstructed Send controls, contained settings,
  reachable tabs/selectors and horizontal bounds. The sampled narrow-window
  screenshots were inspected; no text overlap or missing controls was found in
  the exercised surfaces. This is not an exhaustive accessibility certification.
- Outdated test fixtures now supply the actual Sync mutation/failure helpers,
  asynchronous MCP probes, Chat startup tracing and execution projections.
  Historical Recipe Run fixtures use valid identities. Chat assertions follow
  startup grace, lossless draft recovery, default-open running Activity, wizard
  sizes and counted history pagination without weakening the underlying checks.
- Recipe health acceptance refreshes the synthetic heartbeat immediately before
  asserting healthy running. Production stale-heartbeat detection is unchanged.
  Snapshot tests were rerun against an explicitly started preview server.
- Retrieval suites use the integrity-verified bundled engine with an existing
  dependency-complete Python environment, rather than an unrelated interpreter
  or an older separately installed engine.

Earlier sections below retain evidence from preceding development stages.
This review did not publish, push, commit, install, enable Profile Sync, upload
private data, or invoke a paid model/cloud job. The previously installed candidate
does not contain these new Activity/theme changes.

## Current Outcome

- Router has three visible Title Case views, compact hover details, persisted
  model-call charts, and actual initialized/current calibration functions.
- Model retrieval remains optional. No model is acquired or enabled by opening
  the UI or taking the feature tour.
- Explicit complete relevance judgments train local scalar calibration and an
  EWMA score-gap threshold. Embedding weights remain frozen. Missing judgments
  do not become Recall labels.
- Adaptive Result Count preserves each caller's limit unless sufficient safe
  feedback, calibrated separation, and a clear score cliff permit fewer results.
  It can be disabled. This is not a statistical Recall guarantee.
- The Marketplace overview is shorter; the
  [Feature Guide](../FEATURES.md) contains details and illustrative screenshots.
- The seven-step feature introduction covers PKM Chat, Retrieval System,
  GitHub Sync, Router, and Portal. Completed patch introductions do not replay.

## Evidence Levels

Contract/unit tests, connected browser/controller fixtures, real local processes,
isolated Extension Hosts, and real external-service acceptance are distinct.
Passing one level does not imply the others.

## Latest User-Reported Blockers: Local Candidate Acceptance

- Chat queue editing now has persisted cross-window holds, draft restoration,
  Save/Cancel, and ordered single-request batches with all submission identities.
  An editor prevents both idle drain and active steering consumption. Oversized
  batches fail before model dispatch and remain queued.
- VS Code token counting is INFO diagnostic bookkeeping, excluded from the main
  Activity rows and LLM counts, including historical misclassified rows.
- Explicit debugging imperatives use the same bounded completion check on HTTP
  and VS Code transports. `finish_debug` records diagnostic evidence or a
  concrete blocker; a second advice-only ending is an explicit failure, not a
  successful debug outcome. This lightweight contract does not create a managed
  Task, grant permissions, recognize every possible phrasing, or prove semantic
  correctness from the existence of a tool receipt.
- The final combined related regression gate passed **180/180**, with no skips,
  covering worker/transport/history/Harness/browser behavior. Fixtures exercised
  real local log/process diagnostics, actual native
  and HTTP transport loops, busy-to-edit-to-complete-to-held queue transitions,
  cross-process state preservation, browser draft recovery and failure handling.
  Synthetic model decisions are not live paid-model quality acceptance.
- The **3.2.106** candidate passed isolated VSIX dependency, resource and service
  checks and was installed locally. Fourteen installed runtime/UI/Action assets
  match the build byte-for-byte (`7f097728e2a1`). No automatic Extension Host
  reload, MCP restart, cloud job, or sync publication was triggered. CreativeGen
  Share remains disabled and still requires manual publication verification.

### Subsequent Live Copilot Investigation

- Four real Copilot investigation turns used **47 model rounds** in the
  original user Chat, including actual log reads and read-only process commands.
  One waiting question was cancelled by the controller to relay the user's
  answer; this was not a model investigation failure. Actual billed credits
  are unavailable from the public API and remain unknown.
- Live testing exposed missing host-log access and evidence-call identities.
  An independent bounded `diagnostic_logs` capability now reads allowlisted
  VS Code logs, without widening generic hidden-file access. It redacts common
  secrets, account names and selected identifying fields; public excerpts still
  require review. `session_info.currentAttemptCalls` provides real evidence IDs.
- A subsequent live prompt exposed a stop-intent false positive: descriptions
  prohibiting service shutdown could clear the debug contract. Stop recognition
  now requires an explicit leading stop command. The production-controller
  regression includes negative shutdown/investigation phrases.
- The latest related gate passed **87/87**, with no skips, and isolated VSIX
  checks passed. Candidate `661b088264e1` was installed and the authorized original
  workspace was observed running it after an idle-only scoped reload. Other
  windows were not targeted. This is not a rerun of the earlier 180-test gate.
- The upstream symptom report is
  [microsoft/vscode#343987](https://github.com/microsoft/vscode/issues/343987).
  Token acquisition near the user-reported symptom and a later Host exit are
  verified, but neither proves the authentication root cause. Client-side
  GitHub Authentication and Window logs remain the key evidence gap. The
  upstream authentication problem is **not fixed** by these PKM changes.
- The final real turn verified the installed build, masked both account-bearing
  diagnostic lines, and successfully persisted `finish_debug: needs_input` with
  three actual current-attempt evidence IDs. Its six model rounds exercised the
  repaired stop-intent and completion path in the original Chat, not a fixture.
  Its public answer completed without falsely marking authentication fixed.
- A subsequent user-supplied output confirmed Copilot Chat **0.71.0** and
  VS Code **1.143.1**. A fifth real turn used seven more model rounds to match
  the token timestamps to an existing remote log, distinguish process events,
  and persist `needs_input` again. Total observed rounds are now **54**. The
  reviewed upstream issue was updated and read back. This output still does
  not provide the client authentication prompt/session events or a direct
  log-directory-to-window mapping.

There are now 318 directly named JavaScript/Python test files. Filename families
overlap and are not coverage percentages. The complete 2026-10-24 execution and
targeted-rerun results are recorded above; the following matrix also retains
earlier focused acceptance evidence.

## Feature-to-Test Matrix

| Feature | Representative Executable Evidence | Evidence and Remaining Boundary |
|---|---|---|
| PKM Chat, Harness, Tasks, Profiles | [Daily acceptance matrix](../tests/cases/PKM_CHAT_DAILY_TEST_CASES.md), [controller suite](../tests/test-api-chat.js), [rendered activity](../tests/test-chat-activity-browser.js) | Daily browser/controller release gate passed. Real paid-provider long-task quality is separate. |
| Chat retrieval, evidence, Memory, budgets | [Context matrix](../tests/cases/CHAT_CONTEXT_TEST_CASES.md), [mechanisms](../tests/test-chat-context-mechanisms.js), [transport](../tests/test-chat-transport-receipts.js) | Core suite: 199 passed, no skips. Synthetic provider output is not proof of semantic compression or live task quality. |
| Model retrieval, calibration, adaptive counts | [Learning/HTTP worker](../tests/test-retrieval-learning.py), [HTTP-to-browser graphs](../tests/test-retrieval-learning-browser.js), [serving worker](../tests/test-retrieval-serving-worker.py), [solutions](../tests/test-retrieval-solutions.py) | Focused Python suites: 14 passed. Browser uses real persisted worker history with a synthetic encoder, not production latency or quality measurements. |
| Router sources, performance, privacy | [Router UI contracts](../tests/test-skill-router-ui.js), [model lifecycle browser](../tests/test-retrieval-solutions-browser.js), [observation boundaries](../tests/test-retrieval-boundary.js) | Visible tabs, narrow viewports, hover details, focus preservation, failed attempts, missing Recall, polling, timeout, and old-worker boundaries passed. |
| MCP, Skills, Knowledge tools | [Generated stdio](../tests/test-mcp-stdio-smoke.js), [Skill MCP](../tests/test-pkm-skill-mcp.js), [feature domains](../tests/test-mcp-feature-domains.js) | Actual FastMCP subprocess calls passed, including feedback annotations/schema, explicit incomplete/expired errors, compact receipts, original overfetch, and caller output limits. The bridge fixture is local, not a production account. |
| Notes, Research, Scripts, subscriptions | [Knowledge contracts](../tests/test-knowledge-contracts.js), [retrieval snapshot](../tests/test-retrieval-snapshot.js), [subscription ACL](../tests/test-subscription-acl.js) | Existing release checks cover typed retrieval, stable reads, privacy, read-only aliases, sharing boundaries, and storage. They do not certify every external research provider or GitHub ACL. |
| Actions, Recipes, workflow execution | [Action UI](../tests/test-action-browser.js), [Recipe runtime](../tests/test-recipe-mcp-runtime.py), [stdio transport](../tests/test-recipe-mcp-transport.py), [methodology E2E](../tests/test-methodology-recipe-e2e.py) | Release checks passed, including actual local command/Script chains, explicit subflow resumption, restart recovery, lazy branches/loops, and budgets. Cloud ML jobs were not submitted. |
| Projects, durable work | [Project store](../tests/test-workflow-project-store.js), [bundles](../tests/test-project-recipe-bundle.js), [panel browser](../tests/test-recipe-browser-ui.py) | Existing project simulation, persistence, bundle, and rendered editor gates passed. No claim of real distributed-team production acceptance. |
| Chatroom, invitations, Meetings | [Room cards](../tests/test-chat-layout-scroll-ui.js), [stored Rooms](../tests/test-chat-stored-rooms-ui.js), [Meeting lifecycle](../tests/test-chat-meeting-lifecycle.js) | Release gates passed. The hosted card has one key-gated invitation action and is not duplicated as a joined Room. Meeting coverage instrumentation concerns two Meeting modules, not all PKM Chat. |
| GitHub Sync, backup, recovery | [Two-machine Git](../tests/test-github-sync-two-machine.js), [file safety](../tests/test-github-sync-file-safety.js), [Script recovery](../tests/test-github-sync-script-recovery-e2e.js) | Actual isolated local bare-Git, multi-checkout, conflict/deletion, restore, migration, and recovery checks passed. Real GitHub credentials, organization permissions, and geographically separate hosts remain external acceptance. |
| Portal, cross-machine collaboration | [Transport](../tests/test-portal-transport.js), [file permissions](../tests/test-portal-files.js), [resume](../tests/test-portal-resume.js), [overview browser](../tests/test-portal-connections-browser.js) | Actual loopback relay/socket and permission/resume fixtures passed. They do not replace a real two-machine disconnect/reconnect run. |
| Prompts, Environments, Servers, utilities | [Prompt inheritance](../tests/test-prompt-inheritance.py), [environment refresh](../tests/test-environment-refresh.js), [Server proxy](../tests/test-server-proxy.js), [navigation paths](../tests/test-navigation-copy-path.js) | Existing release checks passed. External package registries, native OS environment discovery, and production Server accounts are not implied. |
| Feature introduction, localization | [Real rendered tour](../tests/test-feature-tour-browser.js), [selection contracts](../tests/test-guided-onboarding.js), [localization](../tests/test-localization.js) | Five highlights/seven steps, narrow layout, manual dismissal, automatic completion, and absence of model/Sync/Portal activation passed. 450 keys align across 11 locales. |
| Startup, packaging, service | [Isolated Host runner](../scripts/run-extension-startup-test.js), [VSIX verifier](../scripts/verify-vsix-package.js), [Windows launch contracts](../tests/test-mcp-windows-stdio.js) | Five actual isolated Host scenarios passed. Same-version local candidate passed packaged dependency loading, Chat worker lifecycle, independent service, metadata, and native Linux fsync checks. Windows source/launcher contracts are not native Windows execution. |

## Gates Executed

- Build/type-check and required UI artifact checks passed.
- All nine registered browser suites passed: plan, contract, standalone, panel,
  startup, PKM Chat, retrieval-router, sharing-sync, and experience.
  The final Profiles-only CSS repair followed that full run; the affected
  Chat/Profile selectors were rerun afterward: 31 passed, no skips.
- Startup used five isolated scenarios: clean install, persisted upgrade,
  offline, malformed state, and repeated reload.
- Sharing-sync passed 55 tests without skips.
- Python learning/serving/solution lifecycle passed 14 tests; the bundled engine
  was activated using its integrity-checked runtime helper, without installing
  an unrelated test runner.
- Chat context passed 199 tests without skips.
- Existing release prerequisites and release-body checks were completed in
  segments: after a failure, only its repaired check and remaining selectors
  were rerun. The initial monolithic commands failed; this report does not
  represent those initial commands as successful.
- The local 3.2.106 candidate VSIX passed the existing verifier, including the
  independent service lifecycle. Subsequently, on 2026-10-23, the user authorized
  local installation for testing. The installed manifest and nine runtime/UI
  assets match the verified candidate. No automatic Reload or publication was
  performed; the running Host needs a normal user-initiated Reload to load it.
- 27 local overview/feature-guide references resolved; new screenshots were
  inspected. Illustrative fixture data is captioned as such.
- Pylance syntax checks passed for the modified retrieval Python implementation
  and learning test. Global Python emitted an existing Requests dependency
  warning during some unrelated subprocess gates; dependencies were not changed.

## Findings Fixed During Review

1. Repeated performance refresh could cancel its own deadline and leave an
   in-flight request stuck. Refresh now disables immediately and retains the
   original deadline.
2. A full snapshot from an older worker could retain stale learning capability
   from the previous worker. Full catalogs now clear absent learning fields;
   partial operation progress still preserves usable state.
3. Browser fixtures lacked complete VS Code theme/font variables, allowing
   invisible curves or incomplete screenshots. Real theme variables and icon
   assets are supplied; computed curve color is asserted.
4. Existing panel onboarding tests still expected nine steps and retired module
   IDs. They now exercise the actual seven-step catalog and Router navigation.
5. The Windows launch assertion referenced the deleted-install script path rather
   than the immutable staged runtime. It now checks the staged script while
   retaining signed-host proxy, launcher environment, and spawn assertions.
6. Two Room-card tests contradicted each other about invitation copying. The
   layout test now executes the card projection and verifies one hosted card,
   one key-gated invitation action, no joined duplicate, and no copy without a key.
7. The test index incorrectly described already-implemented context mechanisms
   as failing TODOs. It now matches the executable matrix and passing core suite.
8. Final screenshot inspection found the Chat Profiles label overflowing a
   28px icon-sized button (49px content at a 320px viewport). The text action now
   sizes to its content; a real-browser regression checks 320/360/1280px layouts.
9. User testing found the Router Privacy Statement body was hidden inside hover
   details. Privacy/legal disclosures now remain directly visible in Collector
   & Privacy. The notice also discloses collector envelope identifiers, remote
   receiver configuration, local retention/deletion limits, and separate service
   boundaries. Browser regressions verify inline text, no hover dependency, and
   narrow layouts. The verified fix was locally installed as 3.2.106 without
   automatic Reload.

## Remaining Acceptance Before a Formal 4.0.0 Release

These are open acceptance items, not claims of known implementation failures:

- [ ] Native Windows and macOS: install/upgrade, model setup, paths, stdio,
  Router graphs/tour, and cross-machine Portal/Sync.
- [ ] Authorized real GitHub small-team workflow: private access, publication,
  subscription, backup/restore, conflict review, and revocation. Repository
  readers can access committed content/history; publication selection is not
  per-file Git access control.
- [ ] Real two-machine Portal: approval, bounded permissions, file batches,
  network loss, reconnect, and no task replay.
- [ ] Authorized live-model long-task and retrieval quality/resource acceptance,
  with explicit relevance judgments and measured Recall/runtime/token budgets.
  Synthetic graph fixtures cannot certify those thresholds.
- [ ] Final agreed scope, version bump/changelog, regenerated release screenshots,
  coherent final release gate, and explicit permission to publish. Documentation
  and images must be pushed before Marketplace GitHub links can resolve.
- [ ] Responsible-party legal review of public privacy disclosures, including
  applicable jurisdictions, operator identity, legal bases, rights/contact
  procedures, and configured collector operators. Implementation verification
  alone is not legal compliance certification.

No production Chat/Sync/cloud task was replayed, no model was implicitly enabled,
and no forced Reload, commit, push, or Marketplace publication was performed.
The currently running extension host is not retrofitted by local source changes.
