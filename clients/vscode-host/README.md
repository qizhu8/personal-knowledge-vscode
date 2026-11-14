# Experimental VS Code host for next-server

This is a **separate, nonproduction extension**. It does not modify or activate the
production extension. Its HTTP path does not start a server. It does not select a Knowledge Root, implement
all legacy approvals, or provide feature parity. Its separate first-run commands
can inspect and import a supported **disposable legacy copy** into a new isolated
workspace; they never select or switch the production Knowledge Root. Run it in
an isolated profile (host-only VSIX or Extension Development Host); do not install it alongside another extension registering
`pkm.next.connect` and `pkm.next.disconnect`.

## Provisioning and use

1. Start and provision next-server separately. Independently obtain its loopback
   origin, actual storage workspace ID, authenticated actor ID, and bearer token
   from the trusted server operator. Bind these to the same server instance and
   actor; never copy identity values from the server's own response as attestation.
2. Set **user-level** `pkm.nextHost.origin` (exactly
   `http://127.0.0.1:PORT`), `pkm.nextHost.workspaceId`, and
   `pkm.nextHost.actorId`. These settings are machine-scoped; workspace/folder
   settings are deliberately ignored. The trusted configuration independently
   asserts server ID `pkm-next`, protocol `v1`, workspace and actor. The client
   compares it with authenticated server info before capability discovery.
   The host relies on the operator's secure provisioning; it does not discover
   server identity independently or protect a compromised user profile.
3. Execute **PKM Next (Experimental): Store Token** and enter the token in the
   native password prompt. It is stored using VS Code SecretStorage under a fixed
   opaque key, never in settings or the webview. Execute **Connect**, then **Open**.
   Connecting again or changing the token closes panels and disposes the client.
   Errors shown to the user are deliberately generic.

The webview has a restrictive CSP, no network access, and renders responses as
text. Each panel receives its own host-created channel identity. No webview
message selects an endpoint, credential, transport path or review authority.
Human review is not registered or exposed. Disconnect or extension shutdown
disposes panel bindings, commands and clients. Pending uncertain writes are kept
only in client memory and are lost on replacement/disposal; reconcile server
receipts before submitting a replacement. If a connection is reset with in-flight
or uncertain writes, the host warns and records their operation IDs in the
**PKM Next Experimental** output channel without recording request bodies or
credentials. This session-only diagnostic is not durable recovery: a shutdown
may prevent the warning from being seen, and exact retry bodies are still lost.
No automatic replay is performed.

## First-run import (explicit opt-in; no cutover)

The installed host exposes two Command Palette commands. They need no HTTP
connection, token, `managedRoot` setting, or repository checkout at runtime:

1. **PKM Next (Experimental): Preview First-Run Import** asks you to select an
   existing, quiescent **disposable legacy copy**, a **new destination directory
   path** (the save dialog selects a path, not an existing workspace), a trusted
   Node.js executable **>=22.18 with `node:sqlite`**, and a trusted Python executable
   for atomic no-replace publication. No path is inferred from settings, workspace,
   home, or the production extension. The destination's parent must already exist;
   source and destination must be disjoint, canonical trees without directory
   symlinks. You must separately acknowledge that this is a disposable copy before
   inspection. Never select live production data.
2. Read the **PKM Next Experimental** output. It is a read-only VS Code output
   channel, not a file saved into the source or destination. The JSON includes exact
   source/destination/runtime paths, full bounded preflight, inventory mappings,
   blockers and plan SHA-256. A blocked/incomplete plan cannot be confirmed.
   Preserve and review unsupported material; do not delete data just to pass
   preflight. There is no “ignore blockers” or native-authority override.
3. Only after review, run **PKM Next (Experimental): Confirm Inspected Import**.
   A distinct modal repeats the exact paths, runtimes and digest and explicitly
   authorizes staging, receipt writes and publication. Cancel/deny consumes the
   in-memory plan without writes. Changing selections requires a fresh preview;
   reload also discards approval. Confirmation passes that inspected plan and
   destination unchanged to the existing importer, which re-inspects the source
   and rejects fingerprint drift **before** creating staging files. The destination
   is rechecked and published using atomic no-replace semantics, never overwritten.
4. Review the receipt in output. No HTTP/managed connection, generation
   publication, production-root selection, service switch or automatic retry follows.
   Import publication here means publishing the **new isolated workspace**, not
   switching the active PKM service. On an uncertain helper failure after approval,
   preserve staging/outcome evidence and use the existing `import-status` recovery
   flow before any retry; this UI does not implement recovery/cleanup.

### Remaining real-user migration blockers

This is a bounded first journey, **not full migration**. You must independently
prepare a complete quiescent disposable copy and provision the trusted runtimes;
the host neither makes a production backup nor certifies copy completeness.
Only Linux/Windows atomic no-replace platforms are supported by the importer;
Python/OS API and destination permission failures may still require reconciliation
after confirmation. Node/Python are user-selected trusted executables, not
downloaded or attested by this host.

The host deliberately supplies **no** snapshot-key, subscription-identity,
trash/Recipe-trash, Memory scope-continuity, or retrieval-learner native approval.
Source layouts requiring those independent authorities remain blocked by existing
APIs; a user confirmation is not a substitute. Memory/router/retrieval-history
sidecar policy selection is not exposed here, so this is not a claim that external
legacy state has been imported. Unsupported entries, pending recovery state,
identity conflicts, bounds, symlinks and platform restrictions require explicit
resolution and a new preview. Connecting/provisioning an imported workspace,
feature parity, backup/restore/rollback qualification and production cutover remain
separate work.

## Build and tests

From the repository root, with the existing TypeScript, esbuild, VS Code types
and next-server dependencies already installed:

```sh
npm --prefix next-server/clients/vscode-host test
```

The adapter suite executes the bundled extension against a VS Code module
harness and an actual loopback HTTP server, including identity mismatch,
workspace-setting rejection, per-panel isolation, secret handling and disposal.
It also copies the built package assets into a fixture installation and invokes
the new commands against the **real packaged planner/importer and SQLite worker**.
Synthetic package-local trees prove picker/acknowledgement cancellation, final
denial, blocked/overlapping destinations and source drift cause no filesystem
changes, while confirmation publishes the exact inspected source fingerprint and
destination. No production root/profile/data is read. This is package-harness
coverage, not a claim of native-dialog Electron acceptance.

### Host-only VSIX and private installed-profile acceptance

```sh
npm --prefix next-server/clients/vscode-host run package:vsix
npm --prefix next-server/clients/vscode-host run test:installed
```

`package:vsix` uses an **already installed** `vsce` CLI (or explicit
`PKM_VSCE_EXECUTABLE`), `--no-dependencies`, and an allowlisted staging directory
containing only this host's manifest, built assets, README and license. It emits
`pkm-next-nonproduction-host-0.1.0.vsix` in this package. It does not invoke the
production packaging scripts, modify the production manifest/entry, or install
tooling. The archive includes the migration helper, SQLite worker, compatibility
assets and action-component resource; source checkout/dependencies are not needed
at runtime.

`test:installed` requires existing Linux `unshare -Urn` support, `ip`, `xauth`,
`xdpyinfo`, cached Xvfb (or `PKM_TRIAL_XVFB`), cached VS Code plus its `bin/code`
CLI (or `PKM_VSCODE_EXECUTABLE`), existing `vsce`, and Python Playwright. Missing
prerequisites fail explicitly; there is no download/install/mock fallback.
Everything writable—HOME, XDG storage, temporary files, display authorization,
user data, installed extensions and disposable source/destination—is under a
fresh package-local directory. A private network namespace exposes only loopback;
Xvfb uses private authenticated TCP, with Unix sockets/locks disabled. Git parent
repository discovery, updates and telemetry are disabled. The production extension
is neither installed nor loaded.

The test actually packages and CLI-installs **this host's VSIX**, verifies its
installed identity/path and contributed commands, and uses a separate minimal
development driver only to invoke the installed host's commands and inspect
fixture results. It does **not** load the host via `extensionDevelopmentPath`.
VS Code's `extensionTestsPath` test mode refuses modal dialogs, so this driver
deliberately launches without that mode. Python Playwright connects to the private
workbench and fills/clicks the **real VS Code simple file dialogs and custom modal
dialogs**, without replacing any `vscode.window` APIs. This is not OS-native
GTK/Windows/macOS file-dialog coverage.

The installed journey checks source-picker cancellation, read-only preview,
separate final denial with no import/staging writes, reinspection, explicit
digest/path confirmation, actual new-workspace publication, unchanged source
bytes/mtime, and no cutover. It selects/copies the real read-only Output editor;
the installed runner reads the actual private-display clipboard and checks the
inspected digest against the modal, source/destination, matching preview/receipt
fingerprints, and the publication receipt. The host is then CLI-uninstalled and
the private profile removed. Failures retain only package-local fixture evidence
for diagnosis. A Linux cached VS Code 1.143.0 run passed this installed-VSIX
journey; broader source layouts/native approvals, other operating systems,
recovery and cutover remain outside this acceptance claim.

For Electron Extension Development Host acceptance, use the separate command:

```sh
npm --prefix next-server/clients/vscode-host run test:electron
```

It uses an already-cached Linux VS Code executable under
`~/.cache/pkm-vscode-test/vscode-linux-x64-*/code`, or an explicit executable
from `PKM_VSCODE_EXECUTABLE`. It never downloads VS Code. The test activates the
extension in Electron, invokes its commands, stores a token through the real
SecretStorage API, verifies authenticated loopback requests, and checks panel
disposal and disconnect cleanup. Its isolated user-data and extensions profile
is removed after the run. Linux runs require an existing `DISPLAY` or
`WAYLAND_DISPLAY`; if the executable or display is unavailable, the acceptance
test fails with that limitation rather than substituting the adapter harness.

An isolated Linux run with VS Code 1.143.0 and a virtual display passed after
the test's disposed-panel assertions were corrected. It used the synthetic
loopback server above, not a real next-server or the installed production
extension; it does not establish migration parity or cutover readiness.

### Additional live-runtime acceptance (not production cutover)

```sh
npm --prefix next-server/clients/vscode-host run test:electron:live
```

This separate test **does run the actual next-server runtime**, using the existing
`next-server/dist/cli.js init` and `http --read-only --port 0` launcher. It needs
that build and its dependencies already present; it does not rebuild or modify
the server, use a mock backend on failure, or download any dependencies. CLI
initialization/startup each have a 30-second deadline and report the actual
blocker. A startup failure stops the test before Electron.

The new workspace and home are randomly named, mode-0700 directories **inside
this package**, not the operating system's temporary directory. They contain only
synthetic, initially empty data. Expected workspace identity is read from the
CLI-created workspace marker *before* starting HTTP; actor `local:reader` comes
from the CLI's read-only policy, not server-info attestation. A random bearer is
generated per run; no operator token, provider configuration, production
extension, existing Knowledge Root, user settings or credential directory is
copied. The child environment is allowlisted, and Electron uses fresh user-data
and extensions directories, disabled updates/telemetry/experiments, and a
dead-loopback proxy for non-loopback requests. The extension transport observer
rejects any destination other than this fixture, including redirects.

It reuses the Electron launcher and loads only the nonproduction development
extension. Coverage includes authenticated connect/server-info, capability
discovery and an actual empty document-list read, independently configured actor
mismatch (no discovery afterward), backend HTTP 401 after an invalid token is
stored, recovery through the real VS Code SecretStorage store/read path, CSP and
secret-leak assertions, and disposal of three actual Electron panels including
message-binding cleanup. Messages are injected at the real panel's host listener
and replies observed at `postMessage`; this is **not webview DOM/button-click
coverage**. On Linux, short `/proc/self/cwd` aliases avoid the Unix IPC path-length
limit while leaving every profile/temp file in this package. Server shutdown is
bounded (SIGTERM, then SIGKILL after 10 seconds); workspace and profiles are
removed in `finally`. The separate `test:live-runtime` command checks actual CLI
startup, authenticated identity/denial, environment isolation and cleanup
without Electron; the original adapter `test` command is unchanged.

Supply an existing `DISPLAY` and installed/cached VS Code as for `test:electron`.
A cached, unprivileged Xvfb can provide an authenticated display without a system
install; disable its filesystem locks and Unix/local sockets and use a fresh
test-only Xauthority cookie with a loopback TCP client. Do not reuse private
desktop credentials. Nothing is downloaded and no server/display should be left
running. This acceptance is additional **synthetic nonproduction evidence
only**: it does not test production extension cutover, real-root migration,
feature parity, provider/tool authority, or change readiness claims/signatures.

Validation: build and all five adapter/launcher tests passed; the live-runtime
Electron acceptance passed with cached VS Code 1.143.0 and an authenticated
cached Xvfb display, without a system install. The CLI readiness/exit race and
disposed-webview HTML inspection found during execution were corrected; all
owned runtime, display and profile state was removed afterward.

## Isolated managed MCP migration launcher

The separate managed-MCP path starts **only an explicitly provisioned experimental
generation**, not the installed PKM service. It neither registers an MCP provider
nor changes the production MCP registry, extension, install, or Knowledge Root.
Provision an initialized disposable/imported next workspace and a separate empty
absolute managed directory using `next-server/experimental/managed-migration.mjs`:

```js
const generation = await stageIsolatedManagedGeneration({
  managedRoot: "/absolute/disposable/managed",
  data: "/absolute/disposable/data",
  // Default false. True explicitly authorizes this isolated workspace's writes.
  allowWrites: false,
});
await publishIsolatedManagedGeneration(generation.managedRoot, generation.generation);
```

The workspace must already have the next-server initialization marker. A new
managed root is private and marked as isolated; nonempty unmarked roots (including
production managed roots), linked roots, and a different existing launcher are
refused. Staging copies the entire built server, adapters, resources, Node
dependencies, and installed transitive Python dependencies (including requested
extras) without installing anything. Every copied file, launch configuration,
Python leaf bootstrap, and interpreter executable has a SHA-256 pin; the launcher
rejects changed, missing, additional, linked or unlisted runtime files. Python
uses `-I -S` and the vendored import closure, including backend leaf subprocesses,
not ambient user-site dependencies. Node startup hooks are removed. System
libraries, Python's standard library and the operating system remain trusted
platform dependencies; this is not a hermetic OS image or a signed package.

Publication verifies the complete package before atomically replacing one latest
pointer under an exclusive lock. The initial compatibility baseline stays fixed.
Publishing an earlier verified generation is explicit rollback; failed
verification leaves the latest pointer unchanged. No generation is hot-reloaded
or deleted while in use. All manifests remain experimental `0.1.0`, with
`enabledFeatureDomains: []`; no complete-domain or production compatibility claim
is made.

Set **user-level** `pkm.nextHost.managedRoot` to that isolated root. Execute
**Connect Isolated Managed MCP**. The host uses the original
`connectManagedChatMcp` client and its actual same-connection
version/build/generation/schema/capability handshake. `migrationState` reports the
verified generation and catalog; `migrationInvoke` accepts `{ name, input }` for
catalogued `mcp_pkm_*` tools only. The HTTP webview cannot invoke this path.
Publishing a compatible successor leaves an existing connection pinned to its
original generation. Execute connect again to fence and drain the old connection
**before** starting the successor: the native workspace deliberately has one
owner. Drain receipts include closing that owned backend's workspace lease.
Disconnect and extension deactivation drain this separate connection as well.
Timeouts, uncertain work or lost control return action-required; they do not
replay calls, forcibly terminate uncertain work, or report a replacement as ready.

Targeted real subprocess coverage:

```sh
npm --prefix next-server run build
node --test next-server/tests/managed-migration.test.mjs
npm --prefix next-server/clients/vscode-host run test:electron:migration
```

The final command requires a usable display and an already cached/installed VS
Code, as above. It loads the real isolated Extension Development Host, provisions
only fixture data, and exercises the frozen launcher, original Chat connector,
Note/Research reads, publication, drain-before-reconnect, rollback and disconnect.
The lifecycle test also blocks the copied **actual Note inventory subprocess**
at a fixture-only gate, cancels its client request, verifies nonzero in-flight and
uncertain work survives close timeout, then releases the gate and observes actual
completion before retrying close. No production service or original source file
is altered. A separate explicitly write-enabled fixture gates the actual native
Note-create adapter, cancels after admission, observes action-required drain,
then verifies the real write commits once after cancellation and reconnect does
not replay it or change its bytes/revision. These are execution/lifecycle tests, not independent user acceptance
signatures or a production cutover authorization.

### Optional local-model dependency provisioning

The default managed package still includes only FastMCP's dependency closure.
Model dependencies require explicit opt-in; having packages in global
site-packages never admits them into a running isolated generation.

```js
const plan = await planIsolatedPythonDependencies({
  python: "/absolute/path/to/compliant/python",
  modelDependencies: true,
  maxPythonDependencyBytes: 8 * 1024 ** 3,
});
if (!plan.ready) throw new Error(plan.issues.join("; "));
const generation = await stageIsolatedManagedGeneration({
  managedRoot, data,
  python: "/absolute/path/to/compliant/python",
  modelDependencies: true,
  maxPythonDependencyBytes: 8 * 1024 ** 3,
});
```

`planIsolatedPythonDependencies` is exported by the same experimental module.
It measures the entire installed transitive distribution closure before copying,
including requested extras, package resources, native libraries and Torch's
declared NVIDIA/Triton dependencies. It reports exact distribution versions,
per-file sizes, total bytes and missing/incompatible dependencies. The default
512-MiB byte budget applies to both profiles; larger closures need an explicit
budget and enough free disk. No package is installed, downloaded or extracted.

Model-enabled provisioning strictly enforces the existing
`resources/retrieval-model-requirements.txt`, including `torch==2.6.0` and
`transformers>=4.36,<5`. There is no compatibility-override parameter. The measured
development environment has Transformers 5.7.0 and is therefore **refused**,
even though development model execution tests can run there. Its measured
model closure is 5,735,693,339 bytes across 113 distributions; Torch alone is
1,552,595,077 bytes. These measurements are environment-specific, not size limits.
A compliant locally provisioned interpreter or separately approved independent
compatibility qualification is required; this code does not certify 5.7 support.

Copies request filesystem copy-on-write reflinks when supported, otherwise use
ordinary independent files subject to the same explicit budget. No writable
hard-link cache or ambient site-packages fallback is introduced. Generation
`python-dependencies.json` records exact distribution versions and every copied
content hash; the manifest pins this file, the dependency profile, requirements
bytes and the complete runtime. Hashing and copying stream large native files
rather than loading Torch libraries into memory. After copying, an offline
`-I -S` subprocess imports the actual model stack solely from that generation.
Missing or unusable native dependencies fail staging before publication.
Interpreter/standard-library and operating-system libraries remain trusted
platform dependencies, as above; model weights require their separate native
runtime admission and are not provided by dependency staging.

Run the bounded provisioning tests without copying active server source:

```sh
node --test next-server/tests/managed-model-dependencies.test.mjs
```

These prove default behavior, real installed-version refusal and pre-copy size
gating, missing dependencies/extra/native-resource inventory, and version/content
pin tamper rejection using an owned small packaging fixture. They do **not**
claim successful real model-enabled managed execution in the incompatible
development environment.

For actual model-enabled migration acceptance, prepend an explicitly provisioned
compliant virtual environment's `bin` to `PATH`, unset `PYTHONPATH`, `PYTHONHOME`,
`PKM_ISOLATED_PYTHON_COMMAND` and `PKM_ISOLATED_PYTHON_BOOTSTRAP`, and set
`PYTHONNOUSERSITE=1`, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1` and
`HF_DATASETS_OFFLINE=1`. Keep `TMPDIR` in an owned project directory. Then run:

```sh
PKM_MANAGED_MODEL_ACCEPTANCE=1 node --test next-server/tests/managed-memory-migration.test.mjs
PKM_MANAGED_MODEL_ACCEPTANCE=1 node next-server/clients/vscode-host/migration-electron-test.mjs
```

The Electron command requires the previously built host, cached VS Code and a
usable display. Both opt-in fixtures generate only tiny random local BERT
weights, admit them through native authority, and stage the full compliant
`local-model` dependency profile with a measured 2-GiB per-generation budget.
They require actual original semantic model invocation, 48-hex retrieval
receipts, original feedback training and persistent-child cleanup. The combined
Memory fixture also verifies receipt replay across restart and relocated backup
restore, source-model immutability and `-I -S` imports exclusively from staged
site-packages. Its original closed learner fixture imports the selected package,
an inactive package and historical user judgments through explicit native
approval. It checks exact learner genesis, preserved salt/user judgments and
denial of historical raw retrieval IDs without actor-bound native envelopes
through upgrade, restart and restore. A separate null-selection import retains
both inactive packages without granting model selection or receipt authority.
Original learner/package files remain unchanged. Default test behavior remains model-disabled. No pretrained
weights are downloaded, and random-model execution is not quality evidence or
production migration authorization.

The model-enabled combined fixture also exercises original partial-predecessor
normalization and a base-predecessor import control. Its selected portable
frozen release retains the exact original release identity and evaluated Skill
corpus through Chat query/feedback, managed upgrade and restart. Original source
bytes are verified before the disposable originals are explicitly removed; the
subsequent backup and relocated query/feedback must use native admitted copies
only. This does not claim unsupported frozen architectures or inactive/null
frozen-release admission.

Add `PKM_MANAGED_BOARD_RECOVERY_ACCEPTANCE=1` to the combined fixture command
to cover portable Todo Board creation, original Note discovery and native WorkItem
mutation, plus bounded missing-only Markdown recovery. The disposable host
explicitly admits one fixed actor/workspace/evidence/audit-root/plan-hash binding
through `admitLegacyKnowledgeRecovery` before starting managed MCP. The launcher
does not gain a public root-grant flag or general path override. Original Chat
preview/apply must preserve raw bytes, reject caller authority spoofing, survive
restart and preserve completed recovery through relocated backup. Relocation
must not remap the old external-root grant. External evidence is removed before
backup. This is not private Git snapshot or unrestricted recovery coverage.

Add `PKM_MANAGED_ACTION_SNAPSHOTS_ACCEPTANCE=1` to exercise a separately
host-enrolled exact Action ZIP catalog and four fixed private-Git snapshot tools.
The host verifies the native workspace inode and exact reviewed package digest
before launch; importing/selecting a ModuleSet permits static diagnostics and
blocked `action_get` only, never runtime execution authority. Pending proposals
remain noncallable. Snapshot enrollment binds its four allowed tools to the
native root/private repository; configure is deliberately unavailable, with no
fake scheduler. The fixture restores CRLF Markdown and executable source modes,
checks replaced/extra bytes in native Trash, verifies all archived files are
mode 0600, and preserves original modes after relocated restore. External
catalog sources are removed before backup; relocated tools must not inherit the
old snapshot root grant. Strict native-database and privacy guards remain intact.

### Optional managed snapshot scheduler enrollment

The scheduler is **off by default**. A trusted native host must first persist a
snapshot admission explicitly covering configure and create. After the native
runtime provides the verified enrollment, pass that exact object when staging:

```js
await stageIsolatedManagedGeneration({
  managedRoot, data, allowWrites: true,
  snapshotScheduler: {
    schema: "pkm.native-snapshot-scheduler/v1",
    workspaceId: independentlyApprovedWorkspaceId,
    actorId: "mcp:external",
    admissionSha256: independentlyApprovedExistingAdmissionSha256,
  },
});
```

Staging performs read-only verification against the existing native admission,
including current root/inode and allowed tools; it does not mint a grant or take
over an active workspace lease. The immutable generation pins the full metadata.
The launcher checks the workspace identity and forwards only the admitted digest
through `--experimental-managed-snapshot-scheduler`; no root, path, actor or
authority override is added. The lease-owning backend must reverify the actual
admission before starting its scheduler. Missing, stale, foreign, read-only or
insufficient enrollment is refused. No operating-system global scheduler is
registered, and ordinary generations retain their existing behavior.

The disposable acceptance fixtures additionally accept
`PKM_MANAGED_SCHEDULER_ARTIFACTS_ACCEPTANCE=1`. For the combined Chat fixture,
also enable `PKM_MANAGED_ACTION_SNAPSHOTS_ACCEPTANCE=1`; existing model and
Board/recovery opt-ins remain independent. This explicitly enrolls only fixture
paths and waits for real UTC-minute deadlines, without clock/interval overrides.
It checks scheduled Git creation, missed-deadline restart catch-up, artifact
import/exclusive export, and relocated old-grant denial. The Electron fixture
checks actual extension-host invocation and disabled scheduling across a real
deadline after upgrade/rollback.

Backup fencing is tested separately on the same persisted managed queue using
the admitted native scheduler: the automatic backup fence pauses claims before
native quiescence, crosses an actual due deadline, and resumes afterward. This
is **not** a claim that Chat exposes a workspace-backup tool. A separate CLI
backup cannot take over a live managed backend's workspace lease. Acceptance
keeps every snapshot-status error fatal; it never retries an uncertain call.
