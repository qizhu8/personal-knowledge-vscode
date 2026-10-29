# UI improvements acceptance and Refresh audit

Scope: the 20 requests in [the original checklist](../../next-step/ui%20improvement.md), plus configurable Chat continuation, deletion-safe Sync, and local browser-reader refresh.

Status: implemented source and isolated acceptance evidence, not an installed release or user acceptance. No extension installation, window reload, version bump, real Sync/Force/Restore, Git commit, or production upload was performed for this UI task. Browser previews use isolated stores. Native VS Code tool confirmations remain host-owned.

## Acceptance checklist

| # | Delivered behavior | Evidence / boundary |
| --- | --- | --- |
| 1 | Ordinary search hidden; Ctrl/Cmd+F opens compact floating find; Escape closes it. | [Panel/layout tests](../../tests/test-four-workspace-ui.js), [Workbench browser tests](../../tests/test-action-workbench.py), [reader tests](../../tests/test-browser-markdown-preview.js). |
| 2 | Functional-page Export/Sync header controls removed; Settings Sync retained. | Panel/layout tests. ModuleSet export remains an explicit Workbench operation. |
| 3 | Overflowing tabs have previous/next navigation. | Panel/layout tests and 390px Settings browser inspection. |
| 4 | Category tree and body stay side-by-side on narrow screens; tree collapses. | Panel/layout, Workbench, and reader browser tests; mobile palette title-width assertion. |
| 5 | Refresh forces the intended data source instead of merely repainting old inventory; drafts/search remain. | [Refresh regressions](../../tests/test-refresh-actions.js) and the matrix below. |
| 6 | Research bulk-trash header removed; Move to Trash uses context menus; shared CatTree controls. | [Trash UI tests](../../tests/test-knowledge-trash-ui.js). Archived Session inline Trash button also removed. |
| 7 | Trash count, right-side Delete All, disabled empty action, and danger confirmation. | Seven-domain runtime confirmation tests: five Knowledge areas, Recipes, Agent Sessions. |
| 8 | General/MCP, Router, and Sharing settings split into their requested subtabs; compact Sync action row. | [Router tests](../../tests/test-skill-router-ui.js), [Sharing tests](../../tests/test-subscription-ui.js), [Sync UI tests](../../tests/test-github-sync-ui.js); desktop/mobile browser ownership checks. |
| 9 | Available/cached content paints before background status refresh; navigation is not disabled by silent requests. | [Cache tests](../../tests/test-tab-cache-ui.js), Refresh tests, MCP unsaved-input browser check. No claim of zero latency on an uncached host. |
| 10 | Yellow Sync markers explain content/baseline uncertainty, not filename inequality or failure. | Sync UI/model tests. Refresh is read-only. |
| 11 | Cache artifacts excluded before file reads; genuine missing sources still fail; current failure text wins; staged-blob validation batched. | [Sync model tests](../../tests/test-github-sync-model.js), including binary/empty blobs and no-commit index fixture. Production Commit latency is not measured. |
| 12 | Missing Git produces execution-host/PATH/restart guidance instead of silent installation. | Sync model tests; dependency ownership below. |
| 13 | Optional machine-scoped external Action toolchains; explicit invalid bindings fail without PATH fallback. | [Module tests](../../tests/test-action-modules.py) and [toolchain documentation](../design/actions.md#optional-host-toolchains). No bundled SDKs. |
| 14 | Default 30 configurable rounds; Continue/Summarize/Cancel; three unchanged function calls/results trigger loop review, with exact wait/poll exemptions. | [Chat runtime/native/HTTP tests](../../tests/test-api-chat.js), [Chat policy](../api-chat.md#tool-loop-continuation). Allow All bypasses PKM's own approval, not native VS Code confirmation. |
| 15 | Allow All/Options in toolbar; mutually exclusive permission/tools/settings/memory popovers; composer stays fixed. | [Chat browser tests](../../tests/test-api-chat-ui.py), desktop and narrow viewport. |
| 16 | Model picker immediately shows busy feedback, suppresses duplicate requests, and clears on host acknowledgement. | Chat browser tests. Installed model-provider interaction not exercised. |
| 17 | One expandable Activity with recorded/completed counts and current-step runtime. | Chat browser tests. Counts represent recorded activity, not a predicted task size. |
| 18 | Consent-aware retrieval-click evaluation/training design. | [Design](../design/retrieval-click-evaluation.md). No collector, training, or upload enabled; clicks are not correctness labels. |
| 19 | Required border on the edit box only; no parameter-wrapper frame. | Actual computed-style assertions in Workbench browser tests. |
| 20 | Raw multiline string input with visible delimiters and escape-looking highlighting; no added quotes or decoding/eval. | Workbench browser/runtime tests. |

## Folder Trash feedback follow-up (2026-10-21)

Physical empty Notes directories remain visible without `.gitkeep` or other
marker files. Moving the last Note to Trash does not prune its empty ancestors;
only an explicit folder action removes a Notes directory. This does not change
Research's separate container-cleanup behavior.

Notes, Skills and Research folder Trash checks ignore dangling local links, but
still block existing externally referenced resources. Failure to inspect a target
(for example, permission denied) remains an explicit error. Research retains
**Delete folder container** (promote contents) separately from **Move folder to Trash**.

Trash commands keep a visible, accessible pending notice after confirmation
closes, suppress duplicate Trash submissions, and finish only on a Trash result,
not an unrelated list refresh. Host exceptions return a failure result; failures
preserve the current detail selection. Timeout warns that the background operation
may still be running, not that it has been cancelled. Native Navigation folder
Trash also shows progress and explicit failures.

Run `npm run test:knowledge-trash` for isolated store, actual Host-handler and
built-panel Chromium coverage: empty/hidden-only folders, stale and live references,
filesystem/lock failures, menu submission, progress, repeat activation, successful
refresh, failure preservation, retry and delayed/missing-path results. These tests
do not install the extension or delete production knowledge.

## Refresh matrix

| Surface | Refresh reads / recomputes | Preservation and effect boundary |
| --- | --- | --- |
| Knowledge | Manual reload rereads inventory with `fresh: true` and requests the exact current detail. Watcher updates remain scoped. | Find query and dirty detail retained; no Sync. |
| Recipes / Agent Sessions | Project/session state. | Selection and editor state retained; refresh does not execute a Recipe or Session Todo. |
| Environment dashboard | Forced Python-version and disk-size probes, including cached environments. | Partial failures are reported while usable cached cards remain. |
| Environment packages | Package inventory for the selected interpreter. | Dashboard rerender preserves package output; no package installation. |
| Servers | Process, port, and link status. | Refresh does not start/stop a server. Subscribed-server status is distinct from refreshing subscribed content. |
| General & MCP | Health/status; dedicated path-size and usage actions refresh their own data. | Draft controls and scroll survive background status paint. Refresh is distinct from regenerate/inject/configure actions. |
| Router | Routing/source/runtime status and existing measurements. | Benchmark runs only through its explicit action; model-based training is not enabled. |
| Sharing & Subscribe | Local gateway, share, subscription, and mounted-state status. | Explicit Refresh from Broker may update the local subscribed cache; ordinary status refresh does not republish or change secrets. |
| GitHub Sync | Persisted target state, local/runtime status, and diagnostic information. | No Fetch/Pull/Commit/Push; run/authentication/force/restore remain separate commands. |
| Action Workbench | Catalog, definitions, availability, and current local run state. | Does not invoke an Action. Qualification, package import/export, Save, and Run remain explicit operations. |
| Live Markdown reader | Visible-page same-origin HEAD/version check every two seconds. | Changed authorized content reloads; document/sidebar scroll, find, and Library collapse restored. Dirty inputs/contentEditable suppress reload; hidden pages skip polling. |

## Sync diagnosis and deletion safety

The read-only Primary Backup diagnostic confirmed an October 5, 2026 `lstat` failure on `scripts/DevOps/AzureDevOps/__pycache__/ado_work_items.cpython-311.pyc`. Generated caches can disappear during traversal; exclusions now happen before stat/read. A separate October 7 failure concerned a genuinely missing Markdown source and must remain an actionable error, not be masked as a cache exclusion.

Commit progress now separates staging, batched index validation, metadata, and actual Git commit/hooks/signing. Validation captures the index with `write-tree` and reads blobs in bounded batches instead of one subprocess per file. The isolated test creates no commit. This reduces subprocess overhead; it does not establish the cause or speedup of a production Commit.

Previously synchronized absence without explicit deletion evidence requires conflict review. It must not silently restore a locally missing entity or republish a remotely missing one. Notes, Papers, Prompts, and Scripts retain durable Trash deletion evidence; restore cancels it. A partial package-member deletion cannot authorize removing the whole entity, and a recreated local entity is retained. Skills without applicable deletion evidence stop for review rather than being resurrected.

Git is an external dependency on the execution host: the remote Linux host in Remote SSH, not automatically the desktop. Fetch/read-index/status/commit/push use that executable. The user installs Git through their host's package manager and makes it available on PATH, then restarts the relevant extension host. PKM does not silently install Git. Authentication and a missing checkout directory are separate failures. Optional C#/Rust SDK bindings follow the same user-owned host boundary; they are separate from PKM's managed MCP Python runtime.

## Verification boundaries

`npm run build` includes TypeScript compilation, generated panel/browser syntax checks, and required UI-artifact verification. Focused Node regressions cover Chat, Sync models/UI, Refresh, Trash, Router, Sharing, and cached/layout behavior. Python acceptance covers 20 Action-module tests, 12 runtime tests, Chat desktop/mobile, and authenticated Workbench workflows. Chromium reader acceptance covers public/private authorization, Note/Skill update reload, scroll restoration, mobile collapse, and unsaved-draft protection.

Actual installed-extension/native model-provider behavior, live scheduled Sync, production Commit latency, and production remote transfers were not exercised. No claim is made that the current running extension already contains these changes. Long-history, cross-chat picker, and every cross-tab draft combination are not exhaustively covered. Existing bundle-size and Python dependency warnings are separate from passing assertions.