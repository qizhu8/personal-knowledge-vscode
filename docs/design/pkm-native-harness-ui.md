# PKM-native Session subgraphs

## Core product acceptance: full-workflow visibility

End-to-end visibility is a core PKM product requirement, not optional decoration
after backend delivery. A user must be able to see the current Harness Step and
attempt, retrieval/search activity, model processing, and the explicitly bound
Recipe node / Action Component, then drill into their original evidence.
Model-processing animation denotes an observable waiting/running state, not
access to hidden reasoning. Unknown phases or ownership must remain unknown.

The current implementation supplies reusable views, not complete acceptance:
Chat has a candidate-to-model Retrieval Sankey and receipt timeline, activity
indicators/animations, and an inline Visualization button beside Memory. The
Session renderer supplies nested Step/Recipe/Action graphs and recorded tool
evidence. Dedicated search stages, automatic cross-view following and the entire
multi-component visual acceptance scenario remain open under VIS-01..05 in the
[delivery backlog](../../next-step/todo.md).

Every execution feature must be accepted together with its visible running,
waiting, failed and terminal states. Preserve the distinctions between prepared
and confirmed-sent context, function calls and Actions, submission and remote
completion, and agent reports and independent validation. Reuse recorded runtime
identities; do not invent a chronological pipeline between unrelated evidence.

## Chat visualization entry

**Visualization**, beside **Memory**, directly opens the dedicated Visualization
window for the current Chat; no inline panel crowds the conversation. It uses the
same Harness renderer as Agent Sessions. It starts at the deepest
recorded active node, or the latest attempt when none is active. **Current
execution** returns there after inspecting another subgraph; ordinary refresh
preserves the user's inspection rather than forcibly moving it.

Function/MCP nodes show the exact function name, arguments and result preview as
separate readable fields, with original metadata retained. Drill down through
explicit recorded links to Action Runs/Components and pinned Recipe revisions.
Public model explanations and per-round responses remain original text, not
extra generated summaries or access to hidden reasoning. Running nodes have a
status animation, respecting reduced-motion and background pause.

A **Live overview** stays above the graph. It shows the recorded state and phase
(model, retrieval, tool and planning animate; waiting, failed and complete have
static marks), the user-wait or dependency block reason, and the current
attempt's prepared model rounds, public output rounds and tool calls. The
current execution path runs from the root to the deepest running or waiting
node; each segment locates and selects that node. Recipe Runs appear only through
explicit managed-Task, planning, step-report or tool-call bindings. Action Runs
appear only through recorded call references. Missing bindings read "no explicit
binding recorded", and referenced but unloaded records are marked unavailable.

Both Agent Sessions and the dedicated Visualization window mount the same
**four-diagram Dashboard**. A fixed **2 x 2** grid shows Harness, Recipe / Action,
Memory / Profiles and Retrieval thumbnails. Below it, four detail tabs select one
full view; clicking a thumbnail selects its tab. Left/Right and Home/End navigate
tabs, and refresh preserves selection. Runtime parameters and diagnostics expand
on demand. Retrieval shows a sampled pool of up to 32 recorded candidate blocks
on the left, with curved links from selected blocks to the right-hand shortlist.
All six selections are shown when a receipt records six; larger selections are
bounded at 24 and explicitly labelled. Selected pieces take priority in sampling,
so selecting a late candidate never loses its connection. Total, displayed,
selected and sent counts remain distinct; the pool is not the entire Memory
database. Green markers require recorded sent evidence, not selection alone.
The thumbnail uses the same diagram. Category/count evidence remains available
in a collapsed legend; hashes, source IDs and per-item labels are never shown.
The flow continues through a selection gate into the selected set and then the
model-context box. Only candidates with recorded sent evidence have a context
connection. Clicking a candidate or selection (Enter/Space also work) highlights
its path and reveals the recorded source URI, retrieval method, score, reason
and evidence state. Missing metadata is labelled, not inferred. This is a
read-only process view, not a new retrieval algorithm or crawler animation.
Visual inspiration: the process-as-objects approach of
[@rybinfx](https://www.rybinfx.com/) and the independently credited
[WebCrawlerMY demo](https://felixyu9722.github.io/WebCrawlerMY/), not copied code
or a claim that this visualization is a crawler.

Memory uses the same visual-first approach: a shared pyramid renderer draws
actual stored levels, sampled piece blocks (up to six per level), and only the
recorded relationships between displayed pieces. Profiles stay separate; they
are not invented learned-memory levels. Prepared references are blue and sent
reference membership is green. An ID match in a historical sent manifest does
not prove that the current mutable stored revision was sent.

Opening the Memory detail tab lazily reads the existing scoped Memory overview;
the four-thumbnail overview alone does not scan the database. Refresh is
explicit, errors remain visible, and clicking a block reads its bounded evidence.
The detailed Visualization view uses the same pyramid, with the inventory,
provenance and source reader kept behind disclosure. Inventory expansion
survives refresh. Native Agent Session webviews/browser pages use the existing
owning Chat reader through an authenticated, Session-bound read-only bridge;
they cannot choose a foreign Chat or mutate Memory. Unsupported/missing owning
records fail explicitly. Neither inspection path invokes a model or changes
retrieval selection, historical snapshots or meaningful-access timestamps.

The default Harness detail is a **compact arrow-connected flow**:
Configure → Run → Monitor → Evaluate → Check → End. Recorded Check-to-Configure
iterations are noted separately. There is no additional large lifecycle ring or
duplicate Last recorded / Run summary. Exactly one stage is current, chosen only
from recorded evidence:

- Live attempt with a started validation report → Evaluate.
- Dependency wait, awaiting result, or non-terminal referenced Action Run →
  Monitor.
- Task/planning report started, or planning without calls/outputs → Configure.
- Any other live attempt → Run. A user wait keeps the stage and adds
  "Waiting for you".
- Finished: completed managed Task or passed validation → End; failed
  validation → Meets goals? (failed); failed/interrupted/cancelled attempt →
  Run (failed); a reply that finished without validation stops at Meets goals?
  marked "done, not validated" and End stays dark.

Earlier stages are visited; Monitor/Evaluate passed without evidence are
skipped. Selecting a stage lists its recorded items and opens their records.
**Current execution** and **Full execution graph** lead to the detailed graph.
The four thumbnails retain two columns even on narrow screens; the stage flow
uses two columns with small connecting arrows.

Steer and Stop remain in the existing Chat composer; visualization does not
create another intervention toolbar or replace the draft. Remote
execution retains its existing intervention restrictions. Merely opening or
navigating this panel never starts a Task, model request or tool execution.

Managed Tasks use the same authorized native Session reader as Agent Sessions.
Ordinary Chats use their recorded Chat evidence and explicitly say that managed
Task/Recipe bindings are unavailable, rather than manufacturing them. Full tool
results are read only by their recorded message/call identity.

Record changes coalesce refresh notifications; the shared renderer also
reconciles every 30 seconds while visible. This does not claim that an
external engine's unreported internal search stages are observable. Switching
Chat, closing or disposing the view releases pending
requests, timers and renderer listeners. Late responses cannot populate another
Chat. Trust/access failures are shown as errors.

## Visualization window

**Personal Knowledge Manager: Open Visualization Window** (also the
Chat's Visualization button) opens one editor-area window.
Opening it again reveals the same window and selects the requesting Chat. The
conversation and its draft stay unchanged.

- **Left: Chat tree.** Mirrors the Chat List: Ungroup, then user folders;
  workers nest under their manager; Trash is excluded. Active Chats sort first.
  Arrow keys, Home/End, Enter/Space and Left/Right navigate and expand.
- **Right: dashboard.** The same four-thumbnail, four-detail-tab core used in
  Agent Sessions is the main view. A compact navigation strip retains additional
  views without duplicating diagram previews:
  - **Lifecycle** and **Execution graph** use the shared renderer (current
    stage / current execution).
  - **Recipe / Action** lists every explicit Recipe Run/stage and Action Run
    binding for the current Harness attempt. Buttons open the exact recorded
    graph (and stage, when specified); unavailable records remain disabled and
    explicitly labeled rather than replaced with current library definitions.
    The initial target prefers a running/waiting binding over completed work.
    Nested Recipe and Component receipts use the shared renderer, including
    branch, retry, ignored, failed and waiting evidence. Tool/submission
    completion is explicitly not remote-job completion.
    Each graph panel remembers its last subgraph while switching dashboard
    panels; returning restores its selection, zoom and scroll. Record refreshes
    preserve inspection, and selecting another Chat clears this navigation.
  - **Retrieval / Search** shows each recorded receipt (query, model, phase,
    selected/candidate counts, candidates and reasons, candidate → model flow)
    plus search-type tool calls. Internal stages of external engines are not
    observable and are not drawn.
    - A live banner appears only while the latest attempt's recorded phase is
      retrieval.
    - Stage tabs (shortlist, prepared, sent / model round N) explain what each
      stage means. Shortlist and prepared are PKM selections, and their token
      counts are PKM estimates. Only "sent" means the provider accepted the
      request.
    - The facts list compares the input-token estimate with the budget.
    - Candidates can be filtered by selected, excluded, or evidence state.
    - A `pkm://` source shows its range and an **Open** button. The button opens
      the Chat, a memory locator's owning Chat, or the Knowledge item.
    - Search tool cards show the parsed arguments. A hit count appears only when
      the result is JSON. **Load full result** fetches the recorded result
      through the same read-only gate.
  - **Memory** shows the Memory Engine blocks recalled for the reply (kind,
    piece, characters, model, duration, error). Memory organization writes are
    not part of this receipt.
  - **Timeline** draws recorded stage transitions and timed tool calls with
    budget markers, then lists waits/blockers and the longest stages.

Any non-Trash Chat in the current Knowledge Root can be inspected, including
Chats not open in the sidebar. A Chat running in this window is read from its
live record; otherwise the stored record is read without creating anything.
Every read passes the same trust, Trash and read-only (`snapshot`/`result`)
gate as the Agent Sessions reader. Record writes, including other VS Code windows' writes
seen by the library watcher, push at most one tree update per 400 ms and only
while the window is visible. Switching Chat cancels pending requests; late
results are ignored. Removing the selected Chat clears the dashboard.

### Activity list target (partial implementation; full acceptance pending)

The requested primary execution UI is a VS Code-style chronological activity
list, not a graph or raw JSON inspector. Readable rows identify the actual
operation: file glob, search query/scope, file and line range, or edit target.
Arguments, results and errors expand per operation; the useful operation label
must not require opening them. Running, waiting, completed, failed and cancelled
states follow recorded events, and the history remains available after completion.

PKM additionally exposes recorded elapsed time and provider-reported token usage.
Time is dispatch/wait/result time, not CPU time. Token usage belongs to its model
round, with input/output and reasoning tokens separated when reported. Missing
usage is unknown, not zero; a round's usage must not be charged to every tool.
Explicit public reasoning summaries are inspectable alongside their model round;
hidden reasoning is not inferred or generated to fill gaps.

Chat and Dashboard reuse the same call IDs, attempt/round identities and recorded
state. Existing generic tool rows, timers, usage and collapsed summaries are
partial infrastructure, not acceptance of this interaction target. Acceptance
must cover live updates, disclosure preservation, historical inspection and a
real long-task scenario, not just the presence of receipt fields.

The first slice uses a shared request-description formatter for Chat rows and
Harness call nodes, initially opens live Activity with user-controlled
collapse/expand, and identifies reported reasoning tokens as part of output.
It does not infer arbitrary external-tool schemas, expose private thinking,
or complete the real long-task acceptance gate.

Implementation: [host](../../src/chat/visualization-window.ts),
[page](../../src/webview/visualization-window.html),
[script](../../src/webview/visualization-window.js) and
[styles](../../src/webview/visualization-window.css).

## Entry points and scope

Select a PKM-native Chat in **Agent Sessions** to open its execution subgraphs.
External Copilot, VS Code Copilot and Claude Sessions retain their existing detail
UI. Trash retains the existing recovery UI.

**Open in browser** opens the same renderer against the same Session snapshot
provider. The owning extension host must remain running. Opening this view does
not execute Actions, invoke models, submit jobs or change Chat state.

The implementation is in the shared
[renderer](../../src/webview/agent-harness.js), its
[styles](../../src/webview/agent-harness.css), the
[browser adapter](../../src/webview/agent-harness-browser.js) and the
[read-only host](../../src/runtime/native-harness-server.ts).

## Navigation and execution semantics

- Each graph shows one level. A node has a top-right **+** only when recorded
  nested content exists. Expansion opens or reuses a subtab.
- **Back to parent** follows structural ownership, not tab-open history.
  Breadcrumb buttons jump to ancestors. Each open graph retains selection,
  scroll and zoom across updates; refresh restores the focused node control.
- Layout is top-to-bottom. Only explicit dependency and retry edges imply
  relationships. Cyclic, loop and unresolved links are listed separately rather
  than rendered as misleading forward edges. Unconnected evidence categories
  are not claimed to be a chronological execution pipeline.
- Execution nodes have a `start` input port and a terminal `complete`, `failed`
  or `ignored` output when that outcome is recorded. An input port is not an
  assertion that execution actually started. Running, pending and unknown
  states do not acquire a fabricated terminal result.
- Ignored nodes remain visible with a dashed, patterned treatment and
  **IGNORED / not executed**. Inspect the node for its recorded reason and
  source data. A rejected planning possibility, cancelled operation or
  missing refinement is not classified as ignored.
- Direct execution is supported without requiring a planning receipt.
  Attempts remain nested under the same input/task Step. Explicit `retryOf`
  links connect attempts; prior failures and their evidence remain intact.
  A retry reason is not inferred when the recorder did not supply one.
- Recipe badges preview the definition pinned to that Run and its revision,
  independently of drilling into its execution. The current library revision
  is never substituted for a missing pinned definition. Nested Recipes and
  recorded Recipe loop attempts have their own subgraphs.

## Evidence authority

Chat snapshots retain all recorded assistant attempts, transitions, retrieval
receipts and tool calls, including segmented history. Tool arguments are not
silently shortened. Result previews show up to 2,000 characters with a visible
character count and an explicit **Load full recorded result** operation.
The recorder's dropped-transition count remains visible; the viewer cannot
reconstruct transitions that were never retained.

Function/MCP calls are model-issued calls, **not Actions**. Their names and
arguments are shown verbatim; the viewer does not infer a transport or hidden
model reasoning from a name. Structured tool-result references can link to
actual durable Action Runs. The Action projection follows their recorded
parent-child ownership and persisted Component receipts. Definition-only
internal calls are not fabricated as executed calls. Capability hashes and
checkpoint response tokens are excluded from this projection.

Action means program-controlled automation. A successful submission Action
does not certify that a remote AML job completed. Similarly, assistant response
completion is not a task-validation receipt. Retrieval selection and
sent-context receipts remain distinct. Missing goals, acceptance contracts,
planning records, Runs and historical attempts are reported rather than
invented.

## Runtime recording

When a managed Task is active and the selected builtin tools include
`record_harness`, the native controller advertises an explicit report writer.
It also works in read-only mode because it records observations, not external
effects. Casual Chat does not incur this tool's schema overhead.

- `task` records the agent-reported goal, constraints, acceptance, open questions
  and actual user source-input identities. Reports can explicitly supersede an
  earlier report. The current report and its original user instructions are
  mandatory context; an insufficient budget fails instead of dropping them.
- `planning` records a validated possibility tree, including an empty tree for
  direct execution. It does not expose hidden reasoning.
- `step` records start/complete/failed/ignored transitions. `parentStepId` creates
  recorded nested ownership. The parent must be running when a child starts;
  it cannot complete while a descendant remains running.
- A new Step start creates a distinct `stepAttemptId`. Failed Step attempts and
  their calls remain visible in separate subgraphs. Calls capture the active
  Step/attempt at dispatch; completing a child restores its active parent.
- Recipe bindings are checked against the current native Session, pinned Run
  definition and recorded parent-owned child Runs. A terminal Step cannot
  substitute a different Recipe.
- `validation` outcomes require recorded terminal call identities. These are
  explicitly **agent-reported** observations, not independent certification
  that a test passed or authority to complete a managed Task.

Chat retries append a new response with explicit `retryOf` and confirmation
reason. Earlier failed output and effects remain stored. The latest task report
survives retry preparation, but the failed response body is not reintroduced as
dialogue. This does not automatically replay any tools.

Each prepared model round records requested/effective limits, estimated input,
active elapsed time and selected reference identities. Prepared receipts do not
prove provider acceptance; full token calibration, remaining-budget ledgers and
all stop-reason acceptance are still pending.
The receipt now includes a separate final-transport manifest: actual HTTP/native
message hashes, the active transformed tool-schema hash and its counting method.
Native counts use the host model's `countTokens` plus explicit overhead when
available, otherwise a labelled estimate. Canonical selection hashes are not
presented as hashes of the native transformed prompt.

The native Chat summary is scoped to its current Task and links to Agent
Sessions. It distinguishes reported goals, recorded validation and response
status. Browser and external Session behavior remain unchanged.

## Refresh and browser lifetime

- File-system changes are debounced through the existing state watcher.
  Browser listeners are notified before the panel-visibility check, so browser
  refresh does not depend on keeping the VS Code panel open.
- Browser updates use authenticated, bounded long polling, not tokens in
  query strings. Both renderers also reconcile every 30 seconds while visible.
- **Auto** pauses snapshot updates, not execution. Manual refresh remains
  available while Auto is off. Visibility restoration reconciles missed events.
- Snapshot requests are serialized, with a coalesced follow-up request and
  stale-response protection. Missing/deleted Sessions and access failures
  surface as errors instead of empty successful snapshots.
- The loopback host reuses the existing Action Workbench transport's token,
  Host/Origin checks, CSP and forwarded-URI support. Its operations are restricted
  to one native Session: snapshot, recorded result and event watch.
  Workspace trust and Knowledge Root/Session ownership are checked on requests
  and after a long-poll wake-up. Closing the owning extension disposes the host.

## Validation

### Public Agent explanations and responses

Each native attempt's **Agent explanation / response** node opens a subgraph
containing the public text already streamed by the model. Exact UTF-16 ranges
in the original assistant response retain per-inference boundaries. Text from a
round that dispatches tools is labeled progress explanation; the last text-only
round of a completed response is labeled final response/conclusion. Streaming,
failed and interrupted responses retain live/partial labels rather than
claiming completion. Tool-only rounds do not fabricate explanations.

This display creates no extra LLM request, summary prompt, mandatory report or
generated conclusion. It does not expose hidden model reasoning. Existing
historical responses without phase boundaries remain visible as unsplit original
text. Plain text rendering prevents model output from executing HTML. Stored
ranges survive reload; event-driven refresh updates the same shared VS Code and
browser renderer. Final response is not a Task/Recipe acceptance certificate.

Public validation reports must cite unique, unambiguous terminal tool calls
with available original results in the current Task. Duplicate identities,
cross-response ambiguity, running calls and missing results are rejected before
committing the report. A successful validation citing a failed call must explain
the expected failure or superseding evidence in its reason. Negative tests are
therefore supported without treating tool dispatch success as acceptance success.
These checks validate report consistency, not arbitrary result semantics; the
report remains an agent observation and cannot complete a managed Task/Recipe.

An explicit Recipe binding can attach a newly created root to the current PKM
Task only when its original completed creation result is in that same Task.
The command ID must produce the exact deterministic Run ID, the result must not
be a replay, and the local runtime creation receipt must confirm that identity.
Direct JSON and MCP structured/text results are supported. The pinned Stage,
Run identities and reciprocal nested-parent links are checked before writing
ownership. Existing ownership remains valid without replaying creation. Foreign
Tasks, incomplete calls, missing receipts and invalid links fail explicitly.
This attaches observation metadata, not execution or completion authority.

```sh
npm run test:native-harness
node --test tests/test-api-chat.js tests/test-action-browser.js \
  tests/test-chat-history-storage.js tests/test-chat-context-contracts.js
python tests/test-chat-visualization-ui.py
```

`test:native-harness` includes the Visualization window host test
([test-visualization-window.js](../../tests/test-visualization-window.js)).
[test-visualization-window-browser.js](../../tests/test-visualization-window-browser.js)
runs the window page in Chromium with the same `PKM_PLAYWRIGHT_PATH`. It covers
tree grouping, keyboard navigation, all six enlarged views, late results after
switching Chat and removal of the selected Chat. Set
`PKM_VIS_WINDOW_SCREENSHOT=/tmp/vis` to save desktop, timeline and narrow
screenshots.

The real Chromium acceptance test is
[test-native-harness-browser.js](../../tests/test-native-harness-browser.js).
It uses the production renderer, assets, CSP and authenticated browser transport,
with isolated recorded-state fixtures, not live execution:

```sh
# Use an existing Playwright installation and its matching Chromium.
PKM_PLAYWRIGHT_PATH=/absolute/path/to/playwright \
  node --test tests/test-native-harness-browser.js
```

It checks nested navigation, pinned previews, all three ignored node kinds
through projection/DOM tests, append-only retries, focus/scroll/zoom retention,
manual refresh with Auto paused, full-result loading, escaped tool parameters,
shared state across two browser windows and explicit access failures.
The shared renderer also has an in-flight refresh/disposal race test.
The runtime suite verifies report provenance, nested Step retries and Recipe
ownership. A fourth Chromium scenario checks bound-call navigation, explicit
ignored reasons and the absence of execution ports on prepared budget records.

The fixture-based browser tests alone do not constitute installed-extension
acceptance. `npm run test:chat-context:host` additionally packages and installs
the actual VSIX into isolated extension/user/HOME directories, starts two
different Extension Hosts and verifies real controller/HTTP evidence on disk.
The installed Webview and its authenticated browser host both render the real
refinement and transport receipts before and after restart. Real native host
message classes are exercised with a controlled local model. This is not
SSH port-forwarding, a paid model benchmark or an upgrade of the user's running
extension. No production deployment or real AML submission is part of this gate.
The installed Webview also mounts the production inline Visualization adapter
and reads the actual persisted native Session through the registered read-only
command before and after restart; the Chromium Chat test separately covers the
production Chat layout on desktop/mobile, Recipe/Action drilldown, intervention
drafts, explicit errors and stale-response isolation.

The same installed-host gate now opens the production standalone
`VisualizationWindow` with its shipped HTML, CSP, scripts and message handlers.
A nonce-bound test probe observes the actual DOM; it does not replace runtime
snapshots. It checks all six panels, persisted-record change notifications and
closing/reopening in both hosts.

A second managed PKM Chat runs against a controlled local HTTP model with actual
`run_process` tools in the isolated workspace: one denied launch, an approved
process exiting with code 1, then an approved recovery process. The probe must
observe retrieval, model, tool, approval-wait and completion phases before
passing. Approval answers are released only after the waiting state is visible.
It drills into the denied tool's original failure receipt. Permission waits are
recorded in the Harness timeline only when a decision is actually pending, and
answering resumes the prior phase; automatic grants do not fabricate a wait.

Both hosts reopen that Chat and compare the original execution-message hash.
A local append-only marker must contain exactly one recovery entry, and the
denied command's marker must not exist. This checks that reopening and restart
do not replay those process effects.

A third managed Chat runs the complete nested chain with installed runtime
resources through a loopback MCP fixture:

1. Actual workspace `search_text`, with its query, one hit and original result
   visible in Retrieval / Search.
2. Start a parent ad-hoc Recipe, claim its pinned nested Recipe and Stage, then
   record the explicit Harness Step binding through the production controller.
3. Invoke a parent Action that invokes a child pipeline containing
   `core.constant`, `core.wait` and another `core.constant`.
4. Inspect the original child Action's persisted waiting state in the graph.
   Only after the Webview shows that state and `action_run_wait` is running does
   the test release the original event. No model polling loop is used.
5. Inspect the completed original Component and its `VIS_COMPONENT_COMPLETE`
   receipt; report the nested Recipe and read the parent's actual completion.
6. Close/reopen in the same Host, then restart in another Host. Combined
   messages/Recipe/Action evidence hashes must be unchanged, with exactly the
   original parent and child Action Runs and zero restart model requests.

See [visualization-chain.js](../../tests/ctx-host/visualization-chain.js) and
[visualization-runtime.py](../../tests/ctx-host/visualization-runtime.py).
The fixture registers and validates definitions using the installed production
libraries; execution records and receipts are created by those actual runtimes,
not fabricated by the test. The controller uses 12 deterministic local HTTP model
requests. History is explicitly off in these execution/Visualization scenarios;
they do not certify Memory quality.

Set `PKM_VIS_ACCEPTANCE_OUTPUT=/absolute/output/directory` to retain screenshots
from the actual VS Code Electron renderer. The nonce-bound probe waits for a
capture acknowledgement before navigating to the next state, so captures cannot
race ahead to a later graph. Images include search, the live nested Recipe,
Action wait, Component completion, lifecycle state, held approvals and the
original denied-process receipt after recovery. `live` and `recorded` filenames
distinguish active execution from same-host reopening/restart inspection. Long
receipts and their graph nodes have separate captures. The installed window's
Chat tree/header/graph layout is also visually checked; Chromium regressions
measure title wrapping, overflow and dashboard-width-based stacking at
1280/700/390 px.

Together these installed scenarios close VIS-01/03/05 for the controlled Linux
execution scope. Browser-only fixtures separately cover missing/ignored
records, reduced motion and hidden-window refresh. Windows/native desktop
notification interaction, paid-model quality/performance, real AML or Cosmos
execution and general roadmap acceptance remain separate.
