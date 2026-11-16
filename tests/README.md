# v5 test system

The active codebase is the root of the `pkm-v5` worktree. The test framework
discovers root `tests/` sources; it does not import the old branch's test tree,
scan frozen `legacy/tests/` as a second product, or restore retired test data.
Tests may explicitly use frozen compatibility helpers and original-source
oracles. These references remain visible in the catalog.
The retained browser protocol/DOM assertions run against the active browser
modules through two scoped import mappings; the frozen tests stay unchanged.

The API Chat upgrade/Room source regressions stage a disposable parent-extension
layout linking the retained `legacy/dist/` build and active Core build. This
preserves the frozen fixture server's exact layout guard without changing
historical helpers; it is not installed-extension qualification. Retained
Room WebSocket dependencies resolve from `legacy/package.json`, not Core.
Profile-local Chat Memory publishes its private workspace under the held
Linux directory fence with no replacement and a final-root-bound marker.
Its regression also checks that cancelling a pending human decision cannot
later authorize a Memory mutation.

The Recipe, authenticated 4.0.22 runtime-oracle and selected live-control
regressions still require their explicit isolated extension inputs
(`PKM_TEST_LEGACY_RECIPE_EXTENSION`, `PKM_LEGACY_422_PATH` and
`PKM_SELECTED_INSTALLED_EXTENSION`, respectively). An absent input skips
those assertions and fails an explicitly selected all-skipped file; do not
replace those inputs with rebuilt sources or treat the skips as qualification.
The first two inputs name authenticated extracted original extension directories,
not the active v5 worktree. `PKM_LEGACY_VSIX` instead names the original VSIX
archive. Extracted bytes do not qualify an installed or closed UI profile.
If precreating `PKM_TEST_REPORTS`, use an owned external directory with mode
`0700`; private simulation evidence rejects group- or world-accessible paths.
Recipe Python oracles resolve the retained `legacy/tests/next-trial-electron/`
helpers relative to their test modules, not the caller's working directory.

## Linux candidate validation

The explicit candidate scope is Linux side-by-side `pkm-v5`, not production
replacement or Windows. It selects all controlled test layers, including
browser/native tests and migration/provenance checks. List the exact selection
and five closed historical installed/private-profile exclusions with:

```sh
npm test -- --profile linux-candidate --list --json
```

Excluded suites require actual installed Note history, installed Chat heartbeat
modules, historical private Room data, installed Recipe metadata/quiesce profiles
or installed Recipe receipts. Their names and requirements are disclosed in
every candidate run receipt; their gates are unchanged. The separate
original-controlled Room simulation remains included, without replacing them.

Prepare a new explicit input snapshot, then run with the three authenticated
original archive/extracted-directory inputs described above and a private
external report directory:

```sh
node scripts/prepare-linux-candidate.mjs
npm test -- --profile linux-candidate --admit-native --admit-qualification --jobs 2
```

The profile sets `PKM_TEST_QUALIFICATION=linux-candidate` only for that run.
It binds current native/captured bytes to
[a separate unverified input snapshot](../migration/linux-candidate-inputs.json),
including unchanged historical-manifest digests and their original path/role/hash
bindings. It does not refresh historical pins or claim a passing qualification.
Acceptance additionally requires a successful matching fresh run and isolated
installation. After intentional input edits, `--replace-unverified` explicitly
replaces only this unverified snapshot; it never rewrites an old qualification.
Default `ci` and direct historical checks retain their original semantics.

Historical source archives authenticate exact old bytes offline. Compiled
release oracle modules are separately labelled JavaScript, never substitutes
for TypeScript source pins. Read-race qualification authenticates both unchanged
historical reports and all 43 original-generation inputs before executing six
current external-writer scenarios. Each scenario really rejects a second native
owner: six 30-second fence waits require a 240-second child budget and a
300-second framework budget. The measured passing run took 187.6 seconds.
New race receipts go only to `PKM_TEST_REPORTS`, never over an old report.

## Developer entrypoints

Restore declared dependencies before running source regressions:

```sh
npm ci --ignore-scripts
npm --prefix legacy ci --ignore-scripts
npm run typecheck
npm run test:check
npm run test:quick
npm test
npm run test:browser
npm run test:list
npm run --silent test:inventory > /tmp/pkm-v5-test-inventory.json
npm test -- --file tests/markdown.test.mjs
npm test -- --file tests/client-manager-workflow.test.mjs --jobs 1
npm test -- --domain sync
```

`npm test` and `test:ci` execute all catalogued framework/component/integration
files. `test:all` is the same safe regression scope, not production
qualification. `quick` includes every framework test and the Markdown,
Core-result validation and document-path regressions. The existing
`test:smoke` wrapper is preserved and can be selected with `--suite test:smoke`.

`npm run typecheck` covers Core and both VS Code surfaces without emitting
artifacts; it is also a CI gate. The CLI configuration regressions assert
missing/blank values, duplicate singleton flags and command-inapplicable flags
fail before creating a workspace. Valid configured HTTP/MCP, repeated explicit
policy entries, backup and coding workflows continue through their real fixtures.

Profiles are `audit`, `quick`, `ci`, `regression`, `linux-candidate`, `browser`, `native`,
`runtime`, `sync` and `qualification`. Native files require `--admit-native`;
explicit live SDK/model dependencies require `--admit-external`. These flags
do not grant production authority or network access.

The active compact MCP lifecycle keeps admission, generation fencing and
uncertain-call drain state in memory. It never creates or scans `instances/`,
persists instance history or publishes diagnostic heartbeats. Generation and
maintenance control reads remain necessary for safe retirement. The
`legacy-mcp-diagnostics` regression audits actual default stdio startup, idle,
calls, quiesce and shutdown for zero registry I/O and an unchanged nine-tool
catalog; it also exercises cancellation and fail-closed drain behavior. Diagnostic
logs and their history tools still require explicit `--diagnostics-directory`
and `--diagnostics-history` grants; environment leftovers grant neither.

Use one profile, or file/suite selectors, or domain/layer selectors.
`--dry-run` prints the plan; `--json` emits the final structured result.
`--test-name` requires exactly one file. Unknown/empty selections, zero-test
Node executions and entirely skipped files fail rather than report success.
Node `--test-name` patterns retain raw Node semantics: matching an ancestor
admits its descendants. Prefer positive patterns; negative patterns must not
match `<root>` or the empty root fullname, or excluded cases may still run.
Standalone programs without native case summaries are counted as
`opaqueTasks`; case totals aggregate only files with verified passing summaries.

## Source catalog and preparation

Discovery parses JavaScript/TypeScript with the installed TypeScript parser
and Python with stdlib AST, without importing Python modules. Entries record
roles, content hashes, dependency evidence, capabilities, domains and layers.
Helpers, data, host actors and controllers cannot be selected as test files.
The source roots include `tests/`, the standalone Memory engine tests, and both
active clients (`clients/vscode/` and `clients/vscode-host/`). Client
`node_modules/`, `dist/`, `out/`, `artifacts/` and staged `next-runtime/` directories are excluded;
client source helpers still contribute capabilities and content identity.
Hidden generated workspaces and `__pycache__` are outside source discovery.
Python child scripts referenced by process-launching Node files contribute
their runtime requirements, so Chromium scenarios remain outside normal CI.
Synthetic DOM clients and synthetic native-service fixtures are not classified
by their filenames.

The supported Node engine is `>=22.18.0` (see `package.json`). Catalogued
`node:test` named `mock.module` calls, including aliased imports and transitive
helpers, selectively enable `--experimental-test-module-mocks`; other files
do not receive that flag. Direct execution of the protected-state importer
test must supply it explicitly. Its real filesystem fault injection is not
replaced by fallback mocks.
Original snapshot-key oracles transpile unchanged historical sources with
relative dependencies and VM filenames anchored to each actual source module,
including the original Linux writer fence, not the calling test directory.

A plan builds root Core sources once in a disposable preparation layer.
Selected imports of the VS Code client also request `typecheck:client`;
references to `legacy/dist/` request `build:compat`. Selected host sources and
their transitive consumers request compatibility compilation followed by
`npm --prefix clients/vscode-host run build` in that same layer. Host tests
therefore consume fresh Core, retained modules and staged payloads rather
than ignored checkout `dist/` or `next-runtime/` output. The stale-output
regression poisons all three outputs and verifies that preparation replaces
them without modifying checkout files. Existing npm wrappers
keep their own ordering and prerequisite hooks. No path is rebound to the
former `next-server/` layout. Preparation failure blocks assertions.
`--no-build` explicitly requests existing artifacts; it is not the default.

The retained Memory host continuity/readoption fixtures import their original
authority from `legacy/dist/runtime/` explicitly, so preparation builds that
dependency instead of resolving outside the v5 checkout. In-place original
Trash contention likewise launches the retained lock from `legacy/dist/`.
These tests exercise actual child hosts/locks and do not establish installed
production acceptance.

The Environment session boundary regression imports active Core directly; it
does not require the former `PKM_TEST_NEXT_DIST` environment override.
Private subscription fixtures still require RAM-only synthetic keys. Selected
sources and transitive helpers reading `PKM_SUBSCRIPTION_TEST_RAM_ROOT` receive
a private 64 MiB tmpfs at `legacy/.pkm-test-subscription-ram` inside their mount
namespace. No host mount or checkout file is changed; mount/setup failures
block execution. Python output-only environment assignments are not fixture
inputs, while reads and augmented assignments remain transitive dependencies.
The framework verifies actual tmpfs type, private mode and cleanup; the
subscription file now executes all eleven cases instead of skipping for a
missing mount. This is synthetic fixture coverage, not private production input.

The actual legacy Sync recovery fixture initializes a Git repository at its
disposable parent, outside the adopted root. Otherwise Git discovers this
checkout's `.migration-test-work/` ignore rule and the unchanged original
producer emits an empty outbox. The regression requires a real changed commit
and exact expected entities before testing recovery, and preserves conflict,
tamper, incomplete-outbox, CAS, restart/no-replay and single-publication checks.
Product Git ignore behavior and historical producers remain unchanged.
Knowledge snapshot privacy fixtures use the supported private schema-1 policy,
not arbitrary JSON that the native admission correctly rejects. The child-death
recovery case does not wait out the SQL lease on Linux: recovery must use the
released native directory lock immediately. Other platforms retain the lease
wait. This avoids spending thirty seconds of the file deadline on an obsolete
Linux assumption without extending the default test timeout.

## Isolation, scheduling and bounded evidence

The normalized runner requires non-admin Linux x86-64/AArch64, Python 3.8+,
kernel pidfds, user/PID/mount/network namespaces and unprivileged OverlayFS.
Unavailable isolation fails closed; Windows/macOS or real installed-host
acceptance must use their separate authorized workflows.

Each run owns repository-external scratch directories. Tests receive the
prepared build as a readonly lower layer and independent writable COW layers.
Root/compatibility build outputs, `.migration-test-work/`, test fixtures and
per-case temporary paths are reclaimed without recreating them on the host.
The host `legacy/` snapshot is never modified. Shared tool caches remain
separate; this is not a credentials/filesystem security sandbox.

`--jobs 1..4` defaults to two. Browser/retrieval/native resources are serialized
within one run, not leased across the shared host. Node uses one test-file
worker, TAP and the existing assertions. Per-file deadlines default to two
minutes, browser and offline model-runtime files to ten minutes, native/wrapper runs to thirty minutes;
`--timeout 1..3600` overrides execution, not preparation.
Python ML imports propagate the model-runtime deadline and resource lease to
their Node controllers without excluding these offline source fixtures from CI.

The supervisor stops managed descendants before ownership-validated cleanup,
including on timeout, cancellation and coordinator death. Changed ownership
fails cleanup and retains the identified workspace; it never triggers a
blanket stale-directory sweep or unrelated process termination. Killing the
supervisor itself can leave scratch requiring explicit inspection.
Only the invoking UID is mapped; host root-owned files appear with the
namespace overflow UID. This cannot qualify real host-ownership attestation.

Linux crash recovery uses the real exclusive root `flock` as its liveness
authority. Once the dead owner's lock is released, a successor can advance the
SQL fencing token without waiting for a stale wall-clock lease. Recovery tests
must verify new ownership, increasing fences, durable receipts and no implicit
request replay; the separate cross-process tests enforce live-writer exclusion.
Owned import publication rebinds the writer marker to the final root while
retaining the same directory lock through the no-replace rename. Interrupted
publication fails closed; arbitrary copied or renamed roots are not authorized.
Read-only import audits validate this generated marker and track its bytes.
Native Trash inventories also validate the root binding before excluding the
generated marker from knowledge projection; original-source inventories still
reject it.
Restore publication uses the same held directory fence and final-root marker
binding, including when a native Trash host opened the staging root.

The storage I/O fault preload recognizes the worker's root-bearing configuration
and covers both Node filesystem calls and the exact native no-replace helper.
Injection requires both helper paths inside the disposable workspace; real
out-of-scope Node and helper renames must remain unaffected. The current report
identifies probe version 2 without rewriting historical reports or recovery
oracles. These are adapter-boundary faults, not genuine kernel errors.

Cancelling an already running Action preserves `unknown` run/node effects and
records `cancelRequested`; it must reap the child without claiming rollback or
replaying the effect after restart. An Action cancelled before dispatch can
finish as `cancelled`. Browser and service regressions use the same contract.

Passing runs write no new logs or archives. A failing run writes one report
of at most 64 KiB under the checkout-specific `~/.cache/pkm-tests/` directory,
or repository-external `PKM_TEST_REPORTS`. Output tails are bounded; every
task retains a SHA-256 reference and outcome, with at most eight detailed
failures and an explicit omitted-detail count. Outcomes distinguish failure,
blocked execution, timeout, cancellation and cleanup errors.
The first 4 KiB of TAP failure diagnostics are retained separately from output
tails so later warnings cannot erase the original assertion.

## Migration qualification is not ordinary CI

The original `npm run test:qualification` remains exactly
`node scripts/verify.mjs`. It owns its builds, checks source/capture provenance
and runs its original acceptance workload. It is not replaced by a green
developer profile or a subset of its tests.

```sh
npm test -- --profile qualification --admit-qualification
```

This supervised entrypoint invokes that original npm wrapper unchanged.
Missing or stale historical assets remain failures. Never regenerate captures,
refresh historical pins or recreate retired environments merely to turn it
green. Qualification evidence created inside isolation is not exported as a
production acceptance record.

Compute capture checks use the relocated active root and frozen original
package sources, preserving the existing manifests and captured bytes.
They also require local Git history containing the `sourceCommit` recorded in
[`compute-provenance.json`](../migration/compute-provenance.json), currently
`371fcf85b36b6b1cc9c8022bd10e3a6ae4dd8088`, and its referenced objects.
Package blobs are checked against that revision; the knowledge-index bridge
reads the original retrieval source from it because the frozen runtime snapshot
contains a later implementation. Missing history fails explicitly; current
runtime bytes are not substituted for original evidence. This history is a
capture-verification prerequisite, not a production worker dependency.
Passing these checks does not satisfy the separate native-worker qualification
pin, which remains an independent assertion.

The [Compute v5 native record](../migration/compute-native-v5-qualification.json)
keeps historical records immutable. The original worker is verified from the
authenticated, byte-exact test-only archive referenced by that record; its
original commit/path/blob remain provenance, not a dependency on local session
objects. SHA-256 and Git blob identities are both checked, including with an
unavailable Git object directory. The archive is excluded from compilation and
runtime use, and its `-text` Git attribute preserves bytes across checkouts.
Maintained worker/accounting identities have separate pins. Real-worker tests
check receipt accounting and restart persistence. The bounded fixture record
passes; it is not a blanket refresh of historical hashes or independent
production acceptance.

Collaboration capture checks likewise use an explicit original Git revision:
`371fcf85b36b6b1cc9c8022bd10e3a6ae4dd8088`, which is preserved on the original
source branch rather than only in a local session checkpoint. The shared capture-source reader
is used by the script and provenance test; all existing source and capture
hashes remain unchanged. The frozen runtime contains later room/meeting code
and is not a substitute for these original evidence bytes. Local history is
required, and the historical manifest's logical roots are not resolved against
an unrelated parent checkout.
CI uses full-history checkout for these published original revisions. A local
checkpoint object alone is not sufficient evidence for portable verification.

Readiness CLI fixtures use the same root/`legacy/` layout. The readiness
contract maps all 244 canonical operations to explicit workstream obligations,
including the 16 Recipe and historical remote-read additions; these mappings
require separate signed evidence and do not qualify any operation.
Public-key enrollment files must resolve outside the entire active checkout,
not merely outside `legacy/`; symlink aliases cannot bypass this boundary.
Preflight schemas live in a dependency-free domain module so direct preflight
imports cannot cycle through the complete native registry before initialization.
Linux handoff fixtures retain the real environment-owner dependency and use an
owned directory descriptor for their short IPC home; socket limits remain strict.
Coding-worker timeout coverage uses the ordinary model-setup budget and a
nonterminating native check, then verifies a real timed-out/cancelled child.
It must not spend a 150ms whole-worker deadline before the check even starts.

The GitHub workflow restores the root and frozen compatibility dependencies,
runs catalog/framework gates and then separate CI/browser jobs on Ubuntu
22.04. It installs declared browser runtimes before private-network isolation
and uploads only the bounded failure report.

Development and bug fixes now belong in root sources on `pkm-v5`. The old
branch's failure counts do not constitute a v5 baseline; record the actual
v5 execution results and distinguish framework, product and environment faults.
