# PKM Chat daily-use acceptance matrix

## Scope and execution

Run `npm run test:pkm-chat:daily` after changes to Chat behavior, tool
permissions, persistence, status rendering or related refresh paths.
`npm run test:pkm-chat:daily:run` reuses an existing build. The full browser
plan includes the same file list as `pkm-chat`, so `npm run test:release`
cannot pass its browser phase while omitting this daily-use gate.
[The plan contract](../test-browser-test-plan.js) checks that the commands
stay aligned.

This is scenario coverage, not a percentage inferred from test counts.
The older `test:chat-coverage` command instruments two **Chatroom meeting**
modules; its percentage does not measure PKM Chat coverage.

Evidence levels:

- **Connected browser/controller:** real built Chat DOM, real event handlers
  and message bridge, production controller, store, locks and SQLite Memory
  worker. Model output, credentials and native desktop confirmations are
  synthetic. No production account or Notes are used.
- **Cross-surface browser:** the real built Agent Sessions tree renders
  production snapshots following the controller's record notifications.
  A second Chat controller receives updates through the real bounded
  filesystem watcher, without manual refresh. This does not replace a test of
  VS Code's complete multi-window panel event bus.
- **Component/integration:** actual production components, sometimes with a
  VS Code host mock. Real MCP SDK subprocess tests are marked separately.
- **Installed/real provider:** requires an explicitly authorized Host/model
  acceptance run. These results cannot be inferred from the preceding levels.

## Lifecycle and cross-surface requirements

Primary connected test:
[browser/controller lifecycle](../test-chat-lifecycle-browser-controller.js),
invoked by [the controller suite](../test-api-chat.js).

| ID | User workflow | Required result and refresh |
| --- | --- | --- |
| DAILY-01 | Open an empty library; select/reopen a PKM URL | No implicit blank Chat or model call; stored identity is unchanged. |
| DAILY-02 | New Chat | Exactly one persisted Chat; Chat List updates; a No Task Chat Group appears in Agent Sessions; Visualization's library contains it; another open Chat view refreshes automatically. |
| DAILY-03 | Send, including a repeated submission ID | One user input and one dispatch; clear only the submitted draft; rejection preserves it and any newer draft. Duplicate acceptance must not resend. |
| DAILY-04 | Provider fails after partial output | Keep partial output and explicit failure; expose Retry only on the latest failed/cancelled/interrupted reply. Failed is not Completed. |
| DAILY-05 | Retry, then Cancel | Inline decision, no model request, original message and failed evidence unchanged. |
| DAILY-06 | Confirm Retry | One new attempt, original user input occurs once, previous failed reply remains; newer unsent draft is unchanged; completion removes Retry and updates status. No automatic replay of earlier tools. |
| DAILY-07 | Stop during model/tool activity | Persist Stopped, retain partial output; ignore late text/tools/images/usage; no automatic retry or queued dispatch. Tool effects are not claimed undone. Uncooperative tool/close controller test retains its 250 ms deadline. |
| DAILY-08 | Cancel Trash | No changes to storage, selection, live lists or Agent Sessions. |
| DAILY-09 | Confirm Trash | Remove from live Chat List, rendered live Agent Sessions and Visualization's library; show the same identity in Trash; another Chat view refreshes automatically. Preserve Task evidence. |
| DAILY-10 | Restore | Restore the same identity/group/history; rendered Agent Sessions row and other Chat view return, with no model dispatch. |
| DAILY-11 | Permanent delete | Only allowed from Trash; clean derived Memory before removal. Remove from all library projections and another open Chat view; no resurrection after reopening the store. Preserve Task evidence. |
| DAILY-12 | Delete the last Chat | Two views show no selected Chat, not a newly created replacement. Covered by the controller suite. |
| DAILY-13 | Empty Trash; one cleanup fails | Successful items disappear; failed item remains recoverable with an explicit error. Covered by library-action integration. |
| DAILY-14 | Rename/move/group operations | Stored title/placement survives reopen; existing controller/library-action tests cover ownership, cancellation and case-insensitive group selection. Agent Sessions watches Chat metadata, library and group records. |
| DAILY-15 | External Portal context | New companion uses the Portal group; does not switch the current Chat or invoke a model. A normal Chat opening a Portal stays in its existing group. Retain contextId rather than opening another context per request. |
| DAILY-16 | New Chat after a read-only Chat | If enabled PKM tools are not connected, initialize and await the configured managed service before sending. Failure is explicit, never a native-tool fallback. |
| DAILY-17 | Context budget prevents Send | Visible explanation, not an unexplained disabled button; fixing the budget clears it without submitting. |

Refresh contract:

| Surface | Create/rename/move | Trash | Restore | Permanent delete |
| --- | --- | --- | --- | --- |
| Current Chat sidebar/list/selector | Same current identity plus latest metadata | Fallback to an existing available Chat or none | Original identity available again | No stale selected/deleted identity |
| Another Chat view, same Knowledge Root | Bounded watcher invalidation | Live list removed, Trash visible | Same identity returns | No retained Trash row |
| Agent Sessions | No Task groups included; library category follows placement | Remove from live tree; retained Task evidence may be archived | Live group returns | Chat projection removed; retained Task evidence is not silently erased |
| Visualization picker | Add/update metadata without invoking a model | Remove from live picker | Same identity returns | Remain absent after reload |
| Hidden/duplicate main panels | Keep draft/DOM, revalidate on return | No resurrected stale list | Revalidate current view | No replay on ready/reopen |
| Portal Connections | Connection journal is distinct from Chat history | Do not claim deleting a list row cancels remote work | No automatic re-pairing | No automatic replay or fabricated connection completion |

The connected lifecycle validates Chat List and Agent Sessions rendering plus
Visualization library data. Hidden/duplicate panels use their separate built
browser suite. Portal transport/journal lifecycle uses the separate Portal
suites. Installed cross-window focus, panel invalidation, open inspectors and
connection teardown still require real-Host acceptance.

## Orthogonal coverage

| Dimension | Cases | Executable evidence |
| --- | --- | --- |
| Permissions | Inline Allow All; no native PKM confirmations; stale approvals rejected; outside-workspace paths, denial, scoped Portal grants | [Controller](../test-api-chat.js), [real SDK MCP](../test-chat-managed-mcp.js), [Portal permissions](../test-portal-permissions.js) |
| History/drafts | Top-scroll and keyboard paging, one pending page, stale cross-Chat response, stable viewport, end of history; draft survives delayed acceptance and UI switches | [Chat browser](../test-chat-activity-browser.js), [history storage](../test-chat-history-storage.js) |
| Terminal status | Completed/unread result: small side-profile face at a desk, staggered animated zZZ, green light; Failed: smaller sooty face, visible top-right red light; Stopped: distinct neutral pause glyph | [Chat browser](../test-chat-activity-browser.js) |
| Accessibility | Status/role labels for ordinary, manager, worker, controller and controlled Chats; keyboard navigation; reduced motion; readable Chinese cancellation | [Chat browser](../test-chat-activity-browser.js), [Agent Sessions browser](../test-agent-session-tree-browser.js), [locale parity](../test-localization.js) |
| Ownership/recovery | Running Chat cannot be deleted, including after async lock acquisition; stale retry/decision rejected; root/workspace identity retained; no replay on recovery | [Controller](../test-api-chat.js), [library actions](../test-chat-library-actions.js) |
| Responsiveness | 16 MB history mutations do not parse segments on the UI thread; lock wait heartbeat gap below 250 ms; Stop does not wait on uncooperative cleanup | [Library actions](../test-chat-library-actions.js), [controller](../test-api-chat.js) |
| Portal invitation | Pending invitations exist before journal history; no secret snapshot; expiry/trust/root/state rechecked at Host-side copy | [Connections](../test-portal-connections.js) |
| Multi-panel state | Independent requests/drafts/snapshots, retained DOM on hide, changed lists refresh, unchanged lists avoid DOM mutation | [Panel instances browser](../test-panel-instances-browser.js) |

## Remaining acceptance gaps and boundaries

1. Linux browser/fixture success is not Windows visual/process qualification,
   real desktop prompt acceptance, or installed multi-window/remote acceptance.
2. Scripted provider success is not a real provider's availability, pricing,
   long-context quality, AML submission or completed remote job.
3. No production Notes/Skills are changed by these cases. Notes CRUD transport
   uses a real MCP SDK process with synthetic file-backed state.
4. Legacy `Portal:` titles alone are not reliable provenance. Do not hide,
   merge or delete such Chats automatically; existing entries can be moved
   through normal Chat group actions. New external contexts are grouped.
5. The reported historical cancellation proves a cancelled attempt, not who
   requested cancellation. Do not attribute it to a user click without evidence.
6. Scenario owners must add the affected lifecycle **and refresh** assertions
   when adding a new operation, not only a source-text or snapshot assertion.
7. The broad Retrieval/Memory/Harness roadmap is not closed by this daily-use
   suite. External materials, product decisions and real-environment gates
   remain tracked in [the TODO](../../next-step/todo.md).

## Installed workbench coexistence: not yet validated

The AMLCodebase incident on 2026-10-21 exposed a separate acceptance gap:
isolated PKM Webview replay does not exercise the native VS Code Chat message
list, its dynamic row heights, scroll anchors or the complete workbench layout.
The affected installation ran PKM 3.2.84 and VS Code commit
`2d0b7506a36c1d6db9a466440131a8e01eab2289`. Its final renderer stacks identify
the native Chat message renderer and repeated list scroll/rerender re-entry.
This identifies the affected component, not the initial trigger or a PKM fix.

These cases require a disposable installed VS Code workspace, synthetic native
Chat history, and no real model request. Keep native Chat distinct from PKM Chat
and the Agent Sessions tree. Record client renderer/main logs and remote Host
heartbeat separately. A synthetic Webview test cannot mark these cases passed.

| ID | Coexistence scenario | Required observations | Status |
| --- | --- | --- | --- |
| DAILY-HOST-01 | Native Chat with an existing conversation visible; open PKM Chat from its normal entry | Window remains interactive; no repeated native scroll/render recursion or unresponsive notification; no implicit model send or lost draft/history | Not run |
| DAILY-HOST-02 | Repeat with native Chat hidden, then with both sidebar placements and editor arrangements | Both Chat identities/drafts survive focus and layout changes; native and PKM lists remain scrollable | Not run |
| DAILY-HOST-03 | Native history with wrapped text, code blocks and tool rows; scroll at middle/end while resizing or switching to PKM Chat | Dynamic-height changes settle; no scroll feedback loop; no repeated row-template/listener errors | Not run |
| DAILY-HOST-04 | Interrupt and restore SSH transport in an isolated workspace while both Chats are open | Connection loss is reported distinctly from client renderer/Host unresponsiveness; reconnect does not replay sends or duplicate Chats | Not run |

Preserve the incident's original production histories and workspace state.
An authorized reproduction should stop on the first unresponsive event and
retain its trace rather than repeatedly freezing the user's working window.

## Validation record: 2026-10-21

- Daily gate: 60/60 runner tests, including the connected lifecycle. The large
  existing controller suite counts as one runner test; this is not 60 distinct
  end-user scenarios or a percentage coverage claim.
- Full `test:release`: passed, including all six browser-plan suites.
- Actual animation frame, hidden pause and reduced-motion checks: passed in
  the 15-test Chat browser suite.
- `npm run package`: passed, including 131/131 pre-package runner tests and
  isolated packaged dependency, Chat worker and service lifecycle checks.
  Candidate: 3.2.85, runtime build prefix `9841c3de562b`.
- Separate TODO follow-up: 18/18 isolated Sync/Trash tests passed. The 15-writer
  scenario forces synchronized backoff, waits for every writer to settle,
  permits only identified CAS contention to be explicitly revalidated/retried,
  and checks all authors' exact bytes in every replica. Production retry limits
  are unchanged. Trash fault injection checks explicit errors on the actual
  recoverable deletion path.
- No installation/reload of user Hosts, production Sync, live task replay,
  real provider billing test or production Notes/Skills mutation.
