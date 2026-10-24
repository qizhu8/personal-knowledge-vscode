# 4.0.0 Release Readiness

Review date: 2026-10-24. Development version remains **3.2.106**.
**4.0.0 is a target, not a published or installed release.**

## Latest Pre-Release Regression and UI Review

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
