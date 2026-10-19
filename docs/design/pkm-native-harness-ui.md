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

## Inline Chat visualization

**Visualization**, beside **Memory**, opens the shared Harness renderer inside
the current Chat without replacing its conversation. It starts at the deepest
recorded active node, or the latest attempt when none is active. **Current
execution** returns there after inspecting another subgraph; ordinary refresh
preserves the user's inspection rather than forcibly moving it.

Function/MCP nodes show the exact function name, arguments and result preview as
separate readable fields, with original metadata retained. Drill down through
explicit recorded links to Action Runs/Components and pinned Recipe revisions.
Public model explanations and per-round responses remain original text, not
extra generated summaries or access to hidden reasoning. Running nodes have a
status animation, respecting reduced-motion and background pause.

**Steer current task** focuses the existing composer in Steer mode without
sending or replacing a draft. The existing Stop control stays available; remote
execution retains its existing intervention restrictions. Merely opening or
navigating this panel never starts a Task, model request or tool execution.

Managed Tasks use the same authorized native Session reader as Agent Sessions.
Ordinary Chats use their recorded Chat evidence and explicitly say that managed
Task/Recipe bindings are unavailable, rather than manufacturing them. Full tool
results are read only by their recorded message/call identity.

Chat state/stream changes coalesce refresh notifications; the shared renderer
also reconciles every 30 seconds while visible. This does not claim that an
external engine's unreported internal search stages are observable. Closing,
returning to the library, switching Chat or disposing the view releases pending
requests, timers and renderer listeners. Late responses cannot populate another
Chat. Trust/access failures are shown as errors.

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

```sh
npm run test:native-harness
node --test tests/test-api-chat.js tests/test-action-browser.js \
  tests/test-chat-history-storage.js tests/test-chat-context-contracts.js
python tests/test-chat-visualization-ui.py
```

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
