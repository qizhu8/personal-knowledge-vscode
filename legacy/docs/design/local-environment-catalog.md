# Isolated-trial Linux environment management

## Selected missing vertical slice

The old `src/servers/pyenvs.ts` stores Python-specific machine paths in
`globalStorage/environments/registry.json`. Its reader silently treats damaged
JSON as an empty registry, and its writer suppresses write failures. Legacy
create/migrate/package/delete operations can invoke package managers or remove
runtime files. Those unbounded legacy writers are **not** admitted by this
slice; separately approved, constrained synthetic provisioning is described below.

Next already has the private registered-Python host composition:
`PythonEnvironmentAuthority → NextManagedClient → managed-client-child →
runHostPythonWorkflow → WorkflowExecutor → RuntimeProcessService`.
Public Workflow `environmentId` remains Python-specific. Environment IDs and
portable/imported metadata are not host execution authority. No new public
Core, HTTP or MCP API is introduced. The initial catalog slice added no execution
adapter; the subsequent explicitly approved native Python adapter is described
separately below.

The new command is **PKM: Manage Isolated Trial Local Environments**. It is
registered through the existing Next Python command registration, and requires
the current trusted **fresh isolated Next trial**. Imported/resumed trial clients
remain refused by the existing host gate. It does not enable production cutover,
admit legacy root writers, or relax any import writer gate.

## Experimental automatic upgrade

The machine-scoped setting
`personalKnowledge.experimental.localEnvironmentUpgrade` defaults to **false**.
Enable it only in the dedicated test profile, then restart/activate the upgraded
extension in a trusted workspace. Activation discovers **that profile's own**
`globalStorage/environments/registry.json`; it does not ask for an import file or
an environment/interpreter path. Disabled/untrusted profiles never auto-import.
There is no PATH search, executable probe, runtime creation, package installation,
production switch, or inherited execution approval.

The existing immutable catalog transaction is reused. Original IDs, names,
manager, root and interpreter paths are unchanged. Each new imported entry also
retains the complete original record in `legacyPython`, including descriptions,
conda names, cached size/version fields and unknown metadata. Original registry,
per-ID package caches and Workflow `environmentId` references are not rewritten.
Existing explicitly registered Node/C# catalog entries remain unchanged;
Python-only legacy data never invents Node or C# registrations.

Missing runtimes retain their configuration but produce a **repair-required**
warning on activation, including after restart. A missing interpreter is refused
by the existing authority before execution; metadata preservation is not a
successful runtime migration. Invalid/corrupt source, duplicate/conflicting IDs,
catalog corruption, symlinks, changed previously imported source or a missing
previously imported registry fail closed without overwriting existing entries.
They require inspection/explicit reconciliation, not silent path repair.

The source is re-read and digest-checked at publication. The committed source
digest is the idempotency receipt, atomically stored with the entries. A crash
before publication leaves inert pending data; the next activation can safely
complete the metadata transaction. After publication, activation observes the
receipt without a duplicate revision. A lost durability acknowledgement reports
uncertainty; reopening reconciles the already-published receipt. Deliberately
unregistered/restored-away entries are not resurrected by activation. This is
one-time snapshot migration, not live mirroring or a fence against a
noncooperating legacy profile writer.

After upgrading, use the existing management/runtime commands without selecting
the environment paths again. Starting a fresh isolated trial still separately
selects its broker Node executable, and each actual run still requires explicit
environment selection and one-run approval. That host setup is not automatic
production attachment or revival of an old capability. Registered Node bindings
survive restart; C# remains explicitly registered, with no fabricated migration.

## Python management against the shipped old UI

The actual old 4.0.22 VSIX contains
`extension/src/webview/panel/30-environments.js`. Its `newEnvForm` offers
conda/venv/uv; `editEnv` changes **name and description only**, not the ID/path;
`deleteEnv` defaults its destructive checkbox to false; `activateEnv` opens a
terminal. Folder registration and Python Workflow-node `config.environmentId`
selection exist. There is **no global default environment selection or global
rebinding operation** to recreate.

Under the same default-off experimental profile gate, the private management
command additionally offers:

- **Register existing Python folder**: explicitly select a canonical Linux
  venv/uv folder or conda prefix, check the interpreter without running it,
  review the exact target and commit metadata. Roots/config files must not be
  symlinks. Registration gets a new ID; no old Workflow reference is silently
  remapped. No conda-account/environment-list scan or installer is called.
- **Edit Python name and description**: a CAS metadata revision preserves the ID,
  paths and original `legacyPython` snapshot. Blank description clears the
  effective description, not the historical snapshot. Missing paths do not
  prevent metadata edits or non-destructive unregistration.
- **Create offline Python venv**: explicitly select an already registered local
  Python as base, enter name/description, then separately approve its exact
  interpreter, new prefix, `-I -B -m venv --without-pip` command and a fixed
  `sys.prefix` verification. Only the profile-owned
  `globalStorage/next-synthetic-python/<generated-ID>` destination is admitted.
  No arbitrary parent, PATH fallback, pip seed, download or deletion is used.
  Fresh trial/trust, catalog revision and base filesystem authority are checked
  before and after the operation. Creating a venv grants no Workflow capability.
- **Create offline Python venv with bundled pip** (new source-only option):
  separately approve the same newly generated prefix plus local `ensurepip`
  bootstrap. The original no-pip action remains unchanged. This installs the
  selected Python's existing pip/bootstrap wheels into the **new** venv, then
  verifies prefix-local pip before registering it. No existing-prefix upgrade,
  arbitrary package/index operation, installer download or Workflow grant.
  Installation has no rollback; failure/cancellation keeps an unregistered
  empty/partial prefix and requested receipt. See the bundled-pip evidence below;
  this is not additional installed VSIX qualification.

- **Create offline conda environment**: explicitly select an already installed
  local conda executable, a read-only local package cache and an exact cached
  Python version. A separate modal discloses the executable, cache, synthetic
  prefix and local package provisioning. A private `file://` channel is generated
  from bounded, whitelisted local repodata; original URLs/channel credentials
  are not copied. The offline dry-run chooses archives, whose stat identities
  and SHA-256/MD5 are checked before copying only those archives. Actual creation
  uses `--offline --copy --override-channels` with a private HOME/config/cache
  and envs directory; the user's existing cache/prefixes are never supplied as
  writable conda locations. Missing cached dependencies/version fail, not
  download. New `sys.prefix` must match before catalog publication.
- **Create offline uv environment**: explicitly select an already installed
  uv executable and a registered Python base. Fixed
  `--offline --no-python-downloads --no-config venv --python <selected Python>`
  uses private HOME/cache, no seed or Python installation. **Positive uv
  creation is not qualified on this machine: uv is absent.** Missing local
  selection/tool is clearly refused before creating a prefix/catalog entry;
  no substitute or tool installer is offered.

Native manager handles are in-memory, object-identity-bound and fingerprint the
selected executable/target and cache directory. Catalog paths, copied handles,
PATH search and restored metadata cannot authorize provisioning. Trust, current
fresh trial and the catalog revision must remain valid. Progress cancellation
SIGTERMs then, if necessary, SIGKILLs only the directly owned manager child, with
a bounded deadline; partial files remain. This is not a process-tree sandbox or
a claim to reverse arbitrary package post-link effects. Cached packages and the
chosen installed tool execute with OS user permissions, explicitly disclosed.
Cached conda binaries can also have fixed prefix-placeholder limits (255 bytes
in the tested packages). An overlong synthetic profile path can therefore fail
after extraction; its error/retained-directory guidance is preserved. Choose a
separate shorter private profile for a new explicit attempt; never silently
move, alias, rewrite or delete an existing prefix to bypass the package limit.

The actual old 4.0.22 `pyenvCreate` really implements `conda create -y -n NAME
python[=VERSION]`, followed by `conda env list --json`, and `uv venv TARGET
[--python VERSION]`. The focused fixture invokes that exact shipped conda
function against a copied private offline channel/cache and private envs/HOME:
real creation and Python execution succeed. The exact old uv branch returns
ENOENT with no new prefix when the local tool is unavailable. These are existing
old capabilities, not newly invented migration features. Terminal activation,
arbitrary package management, destructive removal and destructive migration
remain outside this slice.

Unregister always keeps runtime files, including newly created ones. Restore
appends metadata only, and the next Workflow still needs a fresh approval.
Creation or its catalog publication can fail after producing files. The error
identifies the retained directory; inspect the catalog first, then explicitly
register a completed folder if needed. The `.pkm-creation.json` file records the
request only, **not** successful completion or execution authority. No interrupted
creation is automatically replayed or cleaned up. Missing/broken paths explicitly
refuse execution: restore the original path and recheck, or register a corrected
folder and explicitly bind its **new** ID. Renaming is not a path-repair operation.

The baseline binding/use qualification uses the existing fixed Python Workflow diagnostic:
the selected stable environment ID is compiled into the Python node and dispatched
through the existing host authority, scheduler and Runtime. Preserving an old
reference does not make an arbitrary old Recipe script executable. The Recipe
workstream owns its own script-adapter/public API parity; no global or cross-domain
binding architecture is introduced here.

## Reviewed Next Python Workflow execution

The default-off experimental profile gate now also exposes **Run reviewed Python
Workflow** in **PKM: Run or Recover Registered Local Runtime Workflow**. This is
the **new Next adapter**, not `recipe_runtime.py` and not the fixed `print(7)`
diagnostic. It reuses `PythonEnvironmentAuthority`, the existing catalog
projection, `HostLocalEnvironmentWorkflow`'s durable owner/lease journal,
`WorkflowExecutor` and `RuntimeProcessService`; no second scheduler, process
recovery store or public script endpoint is introduced.

1. Start a fresh trusted isolated trial. Select a registered Python environment
   by its preserved ID, then a regular owned Workflow JSON file inside the
   current trusted VS Code workspace. No interpreter path must be reselected.
2. Supply explicit JSON-object Workflow inputs. A primitive `{{ inputs.key }}`
   in an argument becomes one literal argv element; source is never interpolated
   and no shell is used. Input descriptors must follow the actual Workflow
   contract, including `type`, `required`, `nullable` and `schema`.
3. Review the real source path/SHA-256, compiled executable digest, actor,
   workspace, exact interpreter/root/target, actual isolated CWD, inputs and
   complete definition/script/argument templates in a separate native modal.
   Selection is not approval. Only confirmation creates a three-minute native
   approval, consumed once before IPC. The existing one-use payload challenge
   revalidates the native object, source bytes/stat pins, environment mapping,
   trust, current trial and CWD before admission. Copied JSON/handles, public
   tokens, metadata lookup and previously consumed approvals cannot execute.
4. The child independently recompiles, checks the reviewed file's digest and
   compiled definition, then registers only that run's exact
   source/digest/inputs/environment/steps. The script adapter checks these again
   and launches the original registered interpreter as `-I -B - ...argv` with
   the approved source on stdin and an empty inherited environment.

The current boundary admits at most four Python script nodes in the same
explicitly selected environment, ordinary acyclic single execution, 20 seconds
and 4096 captured stdout bytes per process. Other runtimes, loops/branch controls,
arbitrary CWDs, output-reference argument templates and mixed-environment graphs
are not qualified. This is **not a sandbox**: approved scripts have OS user
permissions. No package manager, Python installer or download fallback is added.
Definition/script, inputs and bounded output persist in the existing private
profile journal, not portable Knowledge state. Non-UTF-8 binary stdout is not
qualified as a text result; an invalid/oversized wire result fails closed rather
than becoming successful or triggering a retry.

Cancellation fences Workflow results and stops the directly owned Runtime
process; started effects are UNKNOWN, never rollback. Full host loss uses the
existing explicit expired-owner recovery: started jobs become INTERRUPTED and
Workflow effects UNKNOWN, without replay, PID reuse signalling or restored
approval. A new execution after restart requires a new native selection,
reviewed-source selection and modal, but no environment path reselection.
Source edits, missing/replaced runtime paths and revocation refuse admission;
restore/recheck the original path or select and review corrected source again.

The same native adapter also accepts **genuine `source.kind=recipe`** when a
trusted host supplies the actual canonical Recipe resolver. It validates the
real revision/digest/snapshot source; inline substitution is rejected. Focused
tests execute the canonical Next filesystem Recipe compiler path, not the old
worker. The private reviewed-file IPC deliberately admits inline Workflow files
only. SQL `NativeRecipeLibrary`/Recipe UI/public composition requires its own
real resolver and independent runtime authority; **it is not claimed wired or
qualified by that initial reviewed-file change**. The subsequent separate
SQL/public composition below now supplies that resolver and authority.

## SQL/public Recipe Python composition

The private native Recipe host can now explicitly compose `HostPythonRecipe`
with `LegacyApiChatRecipes`, its real `NativeRecipeLibrary` and existing
`NativeRecipePublicApi`. The actual execution path is:

```
real SDK Streamable HTTP MCP capability_call / HTTP /v1/capability_call
  -> Core's restricted recipeProtocol actor
  -> NativeRecipePublicApi's exact separate public-start decision
  -> LegacyApiChatRecipes.create / actual SQL resolveRecipe
  -> separate Python admit(binding, complete approval)
  -> existing native WorkflowExecutor / normal durable scheduler
  -> HostPythonScriptAdapter / RuntimeProcessService / RuntimeProcessStore
  -> original registered interpreter, exact approved script and literal argv
```

The standard Runtime store shares the official same-root `core.sqlite` and
workspace lease. This does not start a parallel environment Workflow or create
another recovery database. `HostPythonScriptAdapter` accepts an explicit bound
native actor for this composition; its existing default `local:owner` behavior
is unchanged.

Private `recipe-python-preview` resolves the actual SQL source and produces a
bounded manifest binding root/workspace/actor/source fingerprint/Chat,
operation/run ID, Recipe ID/revision/executable digest/snapshot, full compiled
definition, exact inputs, CWD, environment ID, script hashes and rendered literal
argv. The native UI uses the existing `PythonEnvironmentAuthority` against only
its explicitly supplied private profile's **old** registry. No old writer is
initialized. Original IDs/paths are reused, not replaced by a catalog/path grant.
A protected old registry with group-write bits is accepted only beneath an
owned private ancestor; its bytes and permissions are not rewritten.

**Two independent native decisions are required.** A new Python modal discloses
the exact manifest, original interpreter/root/target, scripts, args and OS
permissions; a separate native/public Recipe run modal follows. Selection,
metadata eligibility, the public token and public-start approval are not Python
permissions. Only the branded live native object can consume the Python
decision. The private approval RPC recompiles and rechecks SQL, inputs, handle
and original registry; `admit` consumes the matching three-minute approval before
registering the exact run. Registry/root/interpreter and real SQL source are
rechecked before launch. The public actor cannot call these private RPCs or
bypass them through general Workflow/Note/manager operations.

Static adapter eligibility deliberately does not mint authority or depend on a
pending grant: the catalog digest must not change merely because a modal was
confirmed. Actual data authorization and execution still require the exact
native per-run registration. Drift or uncertain acknowledgments require
inspection and a distinct freshly reviewed intention, never automatic retry.
An interrupted Runtime owner requires explicit exact-prior-owner takeover under
the workspace lease. Started jobs become INTERRUPTED/UNKNOWN, old approvals
disappear, and neither a script nor a stored PID is replayed/signalled on restart.

The bounded-script, argument, persistence and non-sandbox limitations above
still apply. This is a private synthetic-profile integration, **not production
attachment, global exclusion of all old writers or full Recipe parity**.
Maintenance markers, quiescence acknowledgments and `/proc` cleanup observations
do not establish an atomic global old-writer handoff. Existing production gates
and historical provenance pins remain unchanged.

### SQL/public focused evidence

**48 focused tests passed, zero skipped**, both before packaging and against the
exact frozen candidate's Root/Next payload. The five added SQL/public tests
execute genuine Python through the actual library/resolver, independent SDK MCP
and HTTP clients, typed parameters/literal argv, separate permission denials,
real owned-child cancellation, source/inputs/registry/runtime invalidation and
explicit repair. A separate real broker is SIGKILLed after fsync/stdout; a new
process reopens the standard SQL stores, observes INTERRUPTED/UNKNOWN and
refuses approval/execution replay, then accepts a fresh approved Python run.
The same SQL/SDK path also executes an explicitly supplied genuine old-created
conda prefix with unchanged history and no provisioning. UV is absent; positive
uv qualification remains **untested**, not replaced with a fake.

Logs:
`.migration-test-work/next-python-sql-public-all-focused.log` and
`.migration-test-work/next-python-sql-public-frozen-focused.log`.
Per-case `sql-sdk-http-result.json`, `negative-and-explicit-repair-result.json`,
`public-cancel-result.json`, `actual-sigkill-recovery-result.json` and
`real-old-conda-result.json` remain in their corresponding
`.migration-test-work/python-sql-recipe-*` synthetic fixtures. These focused
fixtures use a fresh SQL root; they are not proof of same-root old-profile
installation. Installed evidence is qualified separately.

### SQL/public original-profile installed qualification

The private installed journey now passes with the **original repository
4.0.22 VSIX** (`1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27`),
not the different same-version private build. It upgrades the actual old UI
profile/root to the immutable 4.0.31 candidate
`a4c50d3e2675f75b0a6307b9460c78b654f4f44de2e0d2020640715b9c584186`.
The locally prepared offline/no-pip fixture interpreter is registered through
the original VSIX registry implementation; its record ID/path and registry
bytes remain unchanged. This is not a new claim of old environment-creation UI
coverage. Next performs no provisioning, installation or download.

The real native Workbench creates and edits a two-step SQL Python Recipe.
Separate native Python and public-start review modals precede actual SDK MCP
and HTTP executions. Literal argv, declined approval, unavailable prefix,
changed registry mapping and a genuine Workbench SQL revision change are
verified. Installed cancellation uses the actual native UI and directly owned
Python child; real public HTTP cancellation is additionally covered by the
focused suite, not claimed as that installed UI action.

Three Next Code/broker lifetimes cover graceful reopening, a broker SIGKILL
after a real Python effect/stdout, durable UNKNOWN without replay or retained
approval, and successful fresh approval. Read-only independent SQLite checks
find six SUCCEEDED jobs, one CANCELLED/unknown and one INTERRUPTED/unknown;
the five expected effects each occur exactly once and the SQL Recipe retains
its identity at revision 2. All **5430 installed payload files** match the
candidate (only Code-added manifest `__metadata` normalized); 13 relevant
current product sources and the historical verification file match the
frozen snapshot. Original, historical and new VSIX hashes remain unchanged.

Evidence:
`.migration-test-work/native-chat-ui-410a58e0-8e3d-4e01-a3c1-0e022f336024/python-sql-public-closed-independent-verification.json`;
log: `.migration-test-work/next-python-sql-public-installed-v3.log`.
Earlier v1 CDP reconnect and v2 driver-shutdown failures are retained; the final
controller uses explicit atomic stop messages and bounded owned-child cleanup.
Independent host `/proc` argv/cwd checks found zero processes from all three
attempts. This is experiment cleanup, not atomic global writer exclusion.
Production attachment remains blocked by unchanged old-writer gates. Full
Recipe parity and uv-positive qualification remain **false/unqualified**.

### Earlier reviewed-file qualification (not SQL/public)

Both isolated strict builds passed. **43 focused tests passed, zero skipped**,
including seven new cases: actual two-step Next Python execution and literal
argv; source/handle/trust/runtime drift refusal; actual cancellation and graceful
restart UNKNOWN; genuine canonical Next Recipe execution/revision conflict;
typed parameter rendering; real managed IPC rejecting missing/forged/consumed
approvals and revocation at its challenge; and the same adapter executing in an
explicitly supplied genuine old-created conda prefix without provisioning or
changing its history. UV remains absent and **positive uv execution/creation
is untested**, not substituted by a fake.

The real private installed old **4.0.22 → new overlay → complete restart**
journey passed in three Code lifetimes. Native commands used instrumented
dialogs/progress, not visual-click qualification. The new adapter actually ran
a reviewed script with parameters in the original venv. Decline/source drift
and a genuinely missing original prefix produced no script effect, followed by
explicit path restoration and successful use. Real cancellation produced
CANCELLED/UNKNOWN. After a Python effect and stdout, the actual broker was
SIGKILLed; restart explicitly recovered INTERRUPTED/UNKNOWN with the crash effect
still exactly once. A freshly reviewed/approved Python run then succeeded.
All previous venv management, old reference, Node and local .NET8 regressions
also passed.

Evidence:
`.migration-test-work/environments-installed-a3d83cf2-0e8d-42dc-b14e-a01ba10f7ec4/`
contains `execution-initial-result.json`, `execution-reopened-result.json`,
old-profile snapshots, upgrade/management receipts, `overlay-evidence.json` and
`closed-independent-verification.json`. Logs:
`.migration-test-work/next-python-program-installed.log` and
`.migration-test-work/next-python-program-full-focused.log`.
New overlay SHA-256:
`61857849ed86fcbcdfdbed51ddec107a0af2ec484b98b8fb6e57ba5675723681`;
fresh Runtime build ID:
`d981c0355ff3b28f4501f00f25b15fee386a21dba8e9e0a718a09ce7c5d658b7`.

Independent checks matched **5435 installed payload files** (only Code's added
manifest `__metadata` ignored), current root Env modules/sources and the new Next
adapter/IPC modules. All four controlled Python runs have exactly one effect;
original registry/cache/reference bytes and the original usable runtime remain
unchanged. Host `/proc` argv/cwd inspection found zero fixture/controller
processes, both frozen original VSIX pins were unchanged, and the Code window
was formally returned to Recipe. Production attachment/writer gates are
unchanged; no production profile/account was used.

### Controlled original Recipe Python qualification

`scripts/run-environment-managers-qualification.js` requires explicit absolute
local build/tool/cache/Python/old-VSIX paths. Inside a private network/PID namespace
it runs real conda success/cancellation/empty-cache/CAS-retained-folder recovery,
then the exact old conda creator and old Recipe resources/compiler from the
SHA-pinned 4.0.22 VSIX. The controller Python must already have FastMCP; no
dependency is installed. All HOME/config/cache/state/output lives under the
project fixture.

`tests/old-python-recipe-journey.py` admits only its exact fixed definitions and
owned run IDs through captured original decorated callbacks, not a new server.
The real old compiler/background worker runs a fixed fixture script in the
actual old-created conda environment, preserving original `environmentId`,
literal argv and lazy start/explicit `next` behavior. It verifies missing-runtime
failure, real progress cancellation and reopened terminal receipts with exactly
one effect/no replay. The old cancellation terminal state is **failed**, not
Next's `cancelled/UNKNOWN`; it is observed, not reinterpreted. The old `get` schema
has `readOnlyHint: true` despite its existing advancement/synchronization behavior;
the fixture does not assume pure reads or change that behavior.

This proves the **original local resource execution path**, not authenticated
MCP/HTTP transport, visual UI use, arbitrary old scripts under Next or a general
Python adapter. No public script endpoint, grant or fallback is added, and no
Recipe-owned source is changed. The new private binding remains the existing
fixed diagnostic with fresh per-run native approval.

## Manual management workflow

1. Use a private VS Code profile and synthetic Knowledge Root. Start an isolated
   trial using an already installed local Node 22.18+ executable.
2. Run the new management command. Choose **Import legacy profile registry**
   and select a static old profile's `environments/registry.json`.
3. Review the source path, SHA-256, IDs and roots in the modal. Only explicit
   confirmation commits. The source is re-read and re-hashed after confirmation;
   duplicate IDs, incompatible records, damaged JSON, relative paths and ID
   conflicts refuse the entire import. Missing local runtime paths may be
   retained as inert metadata and are reported as needing repair.
4. Inspect entries, register an installed **Node.js runtime**, or register a
   **C# executor set** by explicitly selecting its executables. Registration
   checks local executable availability without running version probes.
5. Imported Python entries can run the existing fixed `print(7)` Workflow
   diagnostic after a separate modal and fresh host authority selection. The
   catalog projection supplies the existing authority's registry callback; it
   does not write back to the old registry. Catalog revision, workspace, actor,
   trust and host liveness are checked again before private child admission.
6. **Unregister** only removes current catalog metadata. Runtime directories,
   package caches and the old registry remain untouched. **Restore catalog
   revision** appends a historical metadata snapshot as a new revision. Restored
   metadata never revives a process, handle, approval or historical run.

The language-neutral entry model has `language`, `kind`, `manager` and named
`executors`. Python prefixes use `kind: environment`; Node uses `runtime`.
C# uses `executor-set`, with no mandatory environment root or fabricated venv
activation semantics. The model accepts additional language/provider IDs.
Registration alone still records paths, not capabilities. Execution requires the
separate explicitly selected provider and approval described below.

## Controlled registered runtime execution

Use **PKM: Run or Recover Registered Local Runtime Workflow**, also linked from
the management picker. Only these native providers are qualified:

- `node-diagnostic/v1`: a fixed stdin program echoes the exact argument array,
  performs a bounded wait, and exits. User arguments are passed after the stdin
  script marker, never interpolated into source or a shell. `--import=...`,
  whitespace, Unicode, empty strings and shell-looking text remain data.
- `dotnet8-diagnostic/v1`: a fixed C# program performs the same operation.
  The selected executor must have a complete already-installed .NET 8 SDK,
  reference pack and runtime beneath its canonical target directory. Compiler,
  reference and runtime assets/directories must have the selected runtime's
  owner and must not be group/world writable. This supports system and
  explicitly selected user-local SDKs, including private user namespaces without
  treating overflow UID `65534` as proof of root ownership. Asset identities are
  pinned for the run and checked again before launch.
- `node-project/v1`: an explicitly selected **actual project entry**, not the
  diagnostic. Initial v32 CommonJS and later v37 ESM/native TypeScript have
  separate qualifications described below.

C# uses the installed `csc.dll` directly with explicit local reference assemblies.
It does **not** call `dotnet new`, `build`, `restore`, NuGet, an installer or a
download service. Missing/incompatible SDK assets produce an explicit refusal
before a process/run is created. Other C# executor tools are not silently
substituted. The compiled DLL and runtime configuration are fingerprinted before
execution. This does not qualify arbitrary C# projects or other SDK versions.

Select an existing registered entry/executor, enter a JSON string-array argument
list (12 items, 256 characters each, 2048 UTF-8 bytes total), and a wait duration
of 0–20000 ms. Review the provider, workspace, actor, exact executable/target,
arguments, fixed program, local journal and persistence notice in the modal.
No arbitrary source, PATH lookup, requested environment variables or arbitrary
language/provider ID is accepted.

`LocalRuntimeAuthority` issues only in-memory capabilities for the current
trusted fresh trial, exact catalog revision and filesystem pins. The existing
`NextManagedClient` private IPC uses a one-use challenge bound to the entire
operation payload, including arguments and wait duration. Host authority is
checked again in response to that child challenge. Changed mapping/pins,
cloned handles, wrong workspace/actor, denied trust, altered payloads and
unrequested IPC fail closed. No grant survives restart or restore.

The child injects a fixed native command adapter into the existing
`WorkflowExecutor`, which dispatches the existing `RuntimeProcessService`.
Portable command definitions contain a symbolic program name, not a local
executable path. No new public Core/HTTP/MCP launch or portable language-specific
`environmentId` field is added. No generic executor architecture replaces the
existing scheduler/runtime.

The progress notification supports cancellation. It fences Workflow results and
stops/reaps only the directly owned process through Runtime. A started cancelled
run reports `cancelled` with effect `unknown`, not rolled back. Status/history is
also available through **Inspect or cancel environment runs**.

## Native Node project environments and named C# executor sets

This is a **post-v31 slice**, not an extension of v31's SQL/Python qualification.
The old Python UI/`EnvManager` has no Node project or C# registration to import.
The already-qualified Next Node/C# diagnostics and manual registrations are
preserved. The new missing workflows are explicit discovery, configuration and
actual Node project entry execution.

With `experimental.localEnvironmentUpgrade` enabled in a trusted **fresh
isolated Next trial**, the management command additionally offers:

- **Discover local Node.js runtimes / C# executor sets**: choose one installed
  directory, then select known executable names (`node`/`nodejs` or
  `dotnet`/`csc`/`csi`/`mcs`). This is a shallow read-only scan, not a PATH/home
  search, version probe or installer. C# tools retain named executors with no
  required root/venv. Discovery alone does not qualify `csc`, `csi` or Mono for
  execution; only the existing complete local .NET 8 provider is qualified.
- **Register Node.js project environment**: select an owned canonical folder
  containing `package.json` and an already registered Node runtime. The catalog
  records `language: javascript`, `kind: environment`, `manager: node-project`,
  a project folder and a symbolic `node` executor. It creates no venv, installs
  no dependencies and does not run package scripts or engine-resolution probes.
- **Reconfigure registered runtime or executor set**: explicitly review names,
  named executable mappings and, for a project, its root. Catalog CAS preserves
  the entry ID and original legacy snapshots. Changes invalidate previous
  runtime selections; restoring metadata does not revive authority. All files,
  installed tools and the original Python registry remain untouched.

The existing runtime command now offers **Run registered Node.js project entry
(CommonJS)**. Choose an existing `.cjs`, or `.js` in a CommonJS package scope,
enter literal arguments and review the complete source, project CWD, selected
Node executable/target, source digest and package/lock fingerprints. Entries
are bounded to 16 KiB UTF-8. Relevant `package.json` files and existing
`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml` and `yarn.lock` are
fingerprinted, not interpreted as install instructions. Each metadata input is
bounded (64 KiB manifests, 8 MiB locks).

The existing native object-identity authority and exact one-use private IPC
challenge recheck catalog, executable, project-directory identity, entry bytes
and metadata before admission/launch. The approved entry snapshot is passed
through a fixed stdin CommonJS bootstrap, preserving project CWD, relative
`require`, `__filename`, `__dirname`, `require.main` and literal `process.argv`.
It is **not** `npm run`, a shell or the fixed argument-echo diagnostic. The
existing WorkflowExecutor, Runtime, journal/owner lease and UNKNOWN recovery
are reused; no new scheduler, recovery database or public launch API is added.

Source/metadata drift, missing entries, changed mappings and stale/cloned
handles refuse admission. Missing dependencies produce a failed Runtime receipt
with bounded stderr, never an automatic install. A real started process can be
cancelled through native progress/history; its effects remain UNKNOWN.
Broker loss requires explicit expired-owner recovery without replay or restored
approval. Package changes do not roll back an already-started process.

**Initial v32 limits:** qualification was CommonJS on the selected local Node 22 runtime.
ESM/TypeScript transpilation, engine compatibility resolution, npm lifecycle
hooks, native addons (`--no-addons`), interactive stdin and arbitrary C# projects
are not qualified. Local imports/dependencies are **not recursively frozen**.
Reviewed code runs with OS-user permissions, can have arbitrary effects and
has a 25-second Runtime deadline; only its directly owned child is cancelled.
This is not a sandbox or descendant-process containment guarantee.

### Reviewed ESM and existing Node TypeScript (v37)

The same authority, private IPC, Workflow adapter, Runtime and journal now accept
`.mjs`, `.js` in its nearest module package scope, and `.ts`/`.mts`/`.cts`.
The review identifies the resolved module format and whether TypeScript is used.
No new public execution API or installer is added. Old CommonJS snapshots without
the optional format fields remain compatible.

ESM uses the selected **already installed Node** and its synchronous module
hooks to load the approved entry bytes at their original file URL. Relative
imports, `import.meta.url`, literal argv, project CWD and top-level await work.
The fixed bootstrap marks the entry's `import.meta.main` true; dependencies are
not marked main. The approved source is not reopened during entry loading.
Missing hook support fails with a Runtime receipt, not a runtime download.

TypeScript only reuses that selected Node's existing `stripTypeScriptTypes`
and `--experimental-strip-types` support. It is **strip-only**, not `tsc`,
`tsx`, `ts-node`, package-manager resolution, type-checking or compilation.
The local Node 22.23.1 was really tested with module `.ts`/`.mts`, CommonJS
`.cts`, typed local imports and unsupported non-erasable enum syntax.
An unsupported runtime or syntax fails without installing any fallback.
ESM cancellation, package/format drift and the existing no-replay recovery
contract are covered. Recursive dependency freezing, native addons and
interactive stdin remain outside qualification.

### Legacy lifecycle semantics and explicit Next alternatives (v37)

The immutable original `1804071c…` shipped manager and extension handler were
checked, not inferred from names:

- `envMigrate` really calls `pyenvMigrate`: venv/uv are renamed (or copied and
  removed on rename failure), copied/moved `bin` text and `pyvenv.cfg` paths are
  rewritten, then the original registry ID gets new paths. Conda uses clone,
  tries old-prefix removal and refuses a base prefix.
- `deleteEnv` defaults `removeFiles` false. `envDelete` calls `pyenvDelete`;
  metadata-only removal keeps the prefix, while an opted-in venv deletion really
  removes the folder, then unregisters and clears its package cache. A requested
  disk deletion refused for a missing path/conda base preserves registration.
  `envDeleteScript` is a
  **separate** clipboard-only destructive-script action.
- `envActivate` creates an interactive terminal and sends platform shell
  commands. Linux venv/uv source `bin/activate`; conda sources its installation
  hook then activates the prefix. It is not a Workflow execution grant.

Under the existing trusted fresh-trial and experimental profile gates, Next
provides explicit Linux Python lifecycle actions; C# executor sets are never
passed through these venv operations:

- **Activate registered Python in clean Bash terminal** reviews the entire
  bounded owned activation file and fresh mapping/digest, then starts
  `/bin/bash --noprofile --norc`. It sources the approved bytes through a
  here-document, not a later reopened activation path. This is arbitrary
  reviewed shell code with OS-user permissions; interactive environment
  variables may be inherited. Closing the terminal discards its activation.
- **Migrate Python venv copy (keep original)** is intentionally safer than old
  destructive move: copy into a new private synthetic prefix, preserve symlinks
  without following them, fix copied script/config paths, verify copied
  interpreter `sys.prefix`, then CAS rebind the **same ID**. Original prefix,
  legacy snapshot/registry and Workflow reference bytes stay unchanged.
  Source-tree fingerprints and a requested, fsynced receipt are checked;
  copy limits are 10,000 entries, 64 MiB/file and 256 MiB/tree. Failure/cancel
  retains files/receipt and requires manual inspection; no automatic replay,
  old-prefix deletion or download. Copying is synchronous; cancellation is
  checked between phases. Completion authority is the catalog, not the
  requested receipt. Metadata restore can select the preserved original again.
  Copied UTF-8 Python entry points with a direct source-prefix `bin/python`
  (or versioned Python alias) shebang now use a quoted shell/Python launcher
  when the new interpreter path contains whitespace or exceeds a conservative
  127-byte shebang limit. The original single shebang argument, literal argv,
  executable mode and encoding cookie are retained; ordinary short shebangs
  and non-Python scripts retain the existing path-rewrite behavior. This fixes
  migrated console tools failing even though the copied interpreter and Bash
  activation work. No console tool is executed during migration.
- **Remove synthetic Python to quarantine** only handles this profile's
  synthetic venv/uv prefixes, not external/original/MCP prefixes. Explicitly
  stop usage first: there is no claimed global process exclusion. It records
  intent, renames to a same-parent quarantine location and CAS unregisters,
  retaining revision history and the legacy registry/cache. A conflict/crash
  can leave moved files with stale metadata, not a false successful rollback.
  **Restore quarantined Python folder** verifies the bounded receipt, original
  revision, folder/config/activation identity, absent destination and no
  conflicting ID rebind, then explicitly restores paths/metadata. Nothing
  grants execution approval. Real SIGKILL after rename and explicit recovery
  are focused-tested; neither operation is automatically replayed.
- **Review Python folder deletion script (manual only)** copies a quoted
  permanent-deletion script with inode/config preflight. PKM does not execute it
  or unregister metadata. This is not atomic exclusion or recoverable deletion;
  metadata restore cannot recover files manually erased by that script.

These actions qualify Python venv behavior. `uv` folder handling shares the
implementation but no installed uv was available for positive qualification.
Conda lifecycle/terminal hooks, `other` manager relocation, cross-device moves,
irreversible automated erasure and power-loss guarantees are **not qualified**.

### Focused installed v37 closure and reproduction

Root/Next strict builds and **34/34 focused tests, zero skips** passed.
The same 34 tests passed again on the **exact installed Root modules and frozen
Runtime**, not a rebuild of newer peer source:

```sh
ROOT="$PWD/.migration-test-work/environments-installed-5127a149-8dd1-4737-b98e-43b1105a5373/x/uone.personal-knowledge-4.0.37/dist"
RUNTIME="$PWD/.migration-test-work/environments-installed-5127a149-8dd1-4737-b98e-43b1105a5373/fresh-next-runtime"
PKM_ENV_AUTHORITY_BUILD="$ROOT" PKM_ENV_NEXT_BUILD="$RUNTIME/server/dist" \
  PKM_ENV_FROZEN_RUNTIME="$RUNTIME" node --test \
  tests/test-local-node-project.js tests/test-local-python-management.js \
  tests/test-local-runtime-workflow.js tests/test-local-environment-catalog.js
```

Actual original old profile → focused 4.0.37 installation → Code restart passed.
The new native command opened a **real Bash terminal**, whose Python wrote its
actual original `sys.prefix` into an isolated evidence file. Native management
also copied/rebound the old venv with preserved ID/original, quarantined/restored
the managed copy, and explicitly restored the old catalog binding. Real Node
executed `.mjs` and `.mts` with local imports and `import.meta.main`; .NET8
compile/run/cancel, declined/drift/missing-path refusal and SIGKILL UNKNOWN with
no replay remained covered. Decisions were scripted instrumentation, **not
visual Workbench/modal clicks**.

Evidence root:
`.migration-test-work/environments-installed-5127a149-8dd1-4737-b98e-43b1105a5373`.
Independent report: `lifecycle-esm-closed-independent-verification.json`.
Overlay SHA-256:
`a554050465001445688c84b0d68e1e212dbab5f0980fee0db886a226c9ab3181`;
11-file captured Env source digest:
`d553765dac2dd4f6aab99f73c8a70347b40dc47572392d6e41f63821c5389cf6`;
Runtime build ID:
`f775fabca7151f8263372aae6ff3ac2cc8a9adf5e889375410a321c24498bf3e`.
All **5463 installed payloads / 4782 Runtime manifest pins** matched; the journal
closed with 9 SUCCEEDED, 3 CANCELLED/unknown and 1 INTERRUPTED/unknown jobs.
Four CommonJS effects occurred once each. Original registry/cache/reference
bytes, four historical VSIX pins and historical `verification.json` stayed
unchanged. Three attempts independently had zero owned `/proc` argv/cwd matches.

The first v36 attempt failed on a **controller-only** readonly clipboard
assignment; v36 retry used the same frozen Runtime and passed. Final v37
additionally qualifies ESM main identity. Logs:
`.migration-test-work/env-lifecycle-installed-v36-v1.log`,
`env-lifecycle-installed-v36-v2.log`, `env-lifecycle-installed-v37.log`,
`env-lifecycle-focused-v5.log`, `env-lifecycle-exact-installed-focused.log`.
All failed and successful fixtures remain preserved.

This is a focused overlay, not latest whole-tree/release or production cutover
qualification. After v37, a peer advanced shared `next-managed-client.ts`;
its newer bytes are explicitly **not** retroactively qualified by v37. The
other ten captured Env sources still matched; latest shared Root/Next strict
checks passed and the Node-project provider whitelist remained present.
The Code gate was independently cleaned and formally handed to the next peer.

### Reproducible focused verification

Use already-installed repository dependencies, local Node 22.18+ and, for
positive C# qualification, the installed .NET 8 SDK/reference/runtime packs:

```sh
node node_modules/typescript/bin/tsc -p tsconfig.json --outDir .node-project-root-build
node node_modules/typescript/bin/tsc -p next-server/tsconfig.json --outDir next-server/.node-project-next-build
PKM_ENV_AUTHORITY_BUILD="$PWD/.node-project-root-build" \
PKM_ENV_NEXT_BUILD="$PWD/next-server/.node-project-next-build" \
node --test tests/test-local-node-project.js tests/test-local-runtime-workflow.js tests/test-local-environment-catalog.js
```

Both isolated strict builds passed; **19 focused tests passed with zero skips**,
including actual .NET 8 compilation/run/cancellation. The exact frozen Runtime
was additionally checked with the same 19 tests, using
`PKM_ENV_FROZEN_RUNTIME` to copy the immutable payload into the private IPC
fixture rather than rebuilding it. Logs:
`.migration-test-work/node-project-focused-v2.log` and
`.migration-test-work/node-project-frozen-focused.log`.
No full `next-server npm test` was run.

For a rebuild-free reproduction of the **exact retained installed Root modules
and frozen Runtime**, the following additionally passed 19/19, zero skips
(`.migration-test-work/node-project-exact-installed-payload-focused.log`):

```sh
ROOT="$PWD/.migration-test-work/environments-installed-5047480e-674b-4c9d-8ab4-8147f2bffdde/x/uone.personal-knowledge-4.0.32/dist"
RUNTIME="$PWD/.migration-test-work/environments-installed-a032a18c-d288-4d01-bbe0-7caf4451b451/fresh-next-runtime"
PKM_ENV_AUTHORITY_BUILD="$ROOT" PKM_ENV_NEXT_BUILD="$RUNTIME/server/dist" \
PKM_ENV_FROZEN_RUNTIME="$RUNTIME" \
node --test tests/test-local-node-project.js tests/test-local-runtime-workflow.js tests/test-local-environment-catalog.js
```

### Focused installed v32 qualification

The genuine original repository 4.0.22 (`1804071c…`) private profile upgrades to
a **focused 4.0.32 overlay**, then fully restarts (three Code lifetimes total,
two Next lifetimes). This is not a complete new release/package or whole-current
worktree qualification. Native commands execute in the real installed extension
with **scripted dialog decisions**, not Playwright/native-modal visual testing.
They cover Node project registration, declined approval/source drift/missing
entry with no effect, actual imports/main/CWD/literal argv, cancellation and
fresh approval after broker SIGKILL/UNKNOWN. C# named discovery/configuration
preserves the same ID with no venv root; the actual local SDK compiles/runs and
its run phase is cancelled with UNKNOWN effects.

Independent checks match **5451 installed payload files**, all **4777 Runtime
manifest files**, the emitted Root modules and nine scoped environment sources.
Package, VSIX XML and Runtime manifest versions all agree on 4.0.32. The durable
journal is closed: seven SUCCEEDED jobs, three CANCELLED/unknown and one
INTERRUPTED/unknown; four Node project effects each occur exactly once.
Original registry/config/cache/reference and original/v31/historical VSIX pins
remain unchanged. Independent argv/cwd checks find zero processes from all
three attempts; this proves owned experiment cleanup, not global writer exclusion.

Evidence:
`.migration-test-work/environments-installed-5047480e-674b-4c9d-8ab4-8147f2bffdde/node-project-closed-independent-verification.json`.
Overlay: the same directory's `environments-focused.vsix`.
Log: `.migration-test-work/node-project-installed-v3.log`.

```text
overlay SHA-256: 07852b725e445b47f10b6eb2aff0845aa10e6b47e3c9c1376607361bdb6dc3ca
Env source digest: 50adbdfb730841e0c579aad11bd6860817dd92fc9bdd287630c598c8360807f0
Runtime build ID: c4d3ea19244579bd63186d4acec7510e8c2220b1baa3ccf2b4b85db2ea1e204e
```

The first attempt passed product cases but failed an obsolete restart picker
count; the second passed execution but independent audit found the newly
overridden package version had not updated VSIX XML. Both failures are retained.
The packaging/controller corrections were verified by the complete third
journey against the **same frozen Next payload**, without new product changes.
Code was formally returned after cleanup. Later Collaboration/Recipe/writer
changes are not retroactively included in this qualification.

To reproduce that focused installed journey, first make the isolated Root build
above, then supply the existing original/base VSIX paths:

```sh
node scripts/run-environments-installed.js \
  --legacy-vsix="$PWD/personal-knowledge-4.0.22.vsix" \
  --candidate-vsix="$PWD/.migration-test-work/native-chat-ui-build-7b84bfa9-2851-464b-a020-35cb471fb612/native-chat-ui-candidate.vsix" \
  --root-build="$PWD/.node-project-root-build" --node-project --overlay-version=4.0.32
```

This requires the local cached Code/Xvfb, Python, existing dependencies and Linux
private namespace support; it does not install them. Coordinate the exclusive
Code test window first. `--frozen-next-runtime=<absolute checkout path>` can
reuse the already-staged immutable Runtime. Other manager/reviewed-Python
qualification flags intentionally require separate fixtures.

### Execution journal and restart recovery

Run history is a separate private, owned
`globalStorage/next-local-environment-runs/runs.sqlite` journal, outside portable
Next workspace/backup state. It persists bounded arguments, output, Workflow and
Runtime receipts, but not live executable handles or approvals. SQLite uses
WAL/FULL sync. Canonical owned DB/sidecar paths are checked before opening.

A renewable 4-second native owner lease excludes competing live hosts.
An interrupted unclosed journal refuses ordinary reopening. Explicitly choose
**Recover interrupted environment history (no replay)** after the old owner lease
expires; an unexpired lease is never stolen. Takeover uses the exact previous
Runtime owner CAS, then the existing
`WorkflowExecutor.interruptHostOwnedRun`, **not** recover-and-reschedule.
Previously running Runtime jobs become `INTERRUPTED`, started Workflow effects
become `UNKNOWN`, even if their longer Workflow assignment leases have not
expired. Prepared-but-not-started work is cancelled, not dispatched.

Recovery never signals a persisted PID, recompiles an old C# program, or replays
old arguments. Runtime signals only its own live child object. Controlled
programs are bounded and exit when their output pipe is lost; this is not
process-tree containment of a malicious substituted runtime. A new run requires
fresh selection and approval, with a new run ID. Old UNKNOWN receipts remain
UNKNOWN across later restarts.

An unexpired native owner lease is never stolen. Lease expiry does not prove OS
process quiescence; that is why recovery never replays effects or signals a
persisted PID. This execution-journal lease does not replace or relax the
production Knowledge Root's legacy-writer/quiescence gates.

If Runtime reports a drain/reap failure, shutdown is not announced as successful:
the repository remains available to Runtime and the local journal stays
unclosed. No successful owner release is recorded. Preserve the journal and
inspect the unknown outcome; a later host still needs explicit expired-owner
recovery.

The selected executable/SDK runs with OS-user permissions. Filesystem pins and
owner checks are not a sandbox and do not eliminate same-user replacement races
between validation and process creation.

## Conda lifecycle compatibility (current implementation)

The shipped 4.0.22 implementation really clones a conda prefix on migration,
then attempts manager removal of the source; Next deliberately **keeps the
original**, rebinds the same catalog ID, and requires fresh execution approval.
The old delete handler defaults to unregister-only; `removeFiles=true` calls
the conda manager before unregistering. Its base refusal includes a lexical
`/envs/` path check: a valid migrated prefix outside that segment can also be
refused. This is not semantic base detection.

The four explicit Next conda actions reuse the existing manager authority and
catalog: reviewed installed Bash hook/terminal activation; offline clone to a
managed prefix; real manager removal of a managed clone after verifying a
recovery clone; explicit recovery to the exact absent path and original ID.
Selected tool/cache paths are freshly reviewed, never a persisted execution
grant. Original prefixes, registries and source caches are not deleted.
No manager, compiler or runtime is downloaded or silently installed. Explicit
offline package provisioning/cloning only uses selected local archives in
private prefixes.

Only bounded, owned prefixes with exact locally cached archives are accepted.
Tool-containing prefixes (including a `conda` package) are conservatively
refused, even if they are not actually base. Removal uses private offline
CONDARC/CONDA_OFFLINE: this installed manager does not support an `--offline`
flag on `env remove`. Cancellation, missing archives, stale decisions, CAS
conflicts and crashes retain work/receipts/backups; requested receipts do not
mean completed catalog changes. Recovery never overwrites a present/partial
path, restores a rebound ID, or automatically replays work.

Five focused tests passed against installed conda and a retained private
old-4.0.22-created prefix/cache, inside an isolated network/PID namespace:
real old clone/remove oracle; Next clone/real Bash activation; real manager
delete and explicit restored Python execution; rejection/failure/actual child
cancellation; real host SIGKILL after source removal but before catalog commit,
followed by explicit recovery in a new catalog instance. These are runtime
tests, not installed Code qualification. UV is absent: positive UV lifecycle
remains **unverified**. No global process exclusion, process-tree containment,
atomic terminal delivery or power-loss durability is claimed.

### Separate installed Env42 qualification

The genuine `1804071c…` old 4.0.22 VSIX → focused 4.0.42 overlay → complete
Code restart passed in one private user-data/default-profile namespace.
Native commands used real installed conda and retained private archives:
actual Bash terminal activation wrote Python `sys.prefix`; old-ID clone/rebind
ran the Next Python Workflow; real manager removal preserved a verified backup
and explicit restore ran Python again. Missing-cache clone failed without a
catalog commit and retained its work/receipt. A second completed managed
removal remained absent before explicit post-restart recovery, then restored
the same ID/path and ran Python; no failed work/recovery replayed automatically.
Original legacy registry/cache/conda Workflow bytes and raw metadata remained
unchanged. Existing real create-child cancellation/retained files and missing
UV refusal also passed.

Independent closure verified 5,467 payload files, 4,782 Runtime pins, 38 Root
JS/map files against the tested emit, 13 Environment source hashes and six
controller hashes. Installed package JSON differed only by VS Code's
`__metadata`; package/XML both identify 4.0.42. Current conda focused tests were
5/5 with zero skips, with the same compiled bytes; the frozen Next Python
adapter regression also passed, as did 20 legacy-upgrade/Python-management tests
against the actual installed Root. The original conda full tree still matched
the migration approval snapshot. Historical verification pins stayed unchanged,
and an independent exact-owned argv/cwd cleanup scan found zero processes.

Evidence:
`.migration-test-work/em-ffd7e0af-a187-41e8-b1fc-ddac223b1030/conda-lifecycle-independent-verification.json`.
This uses scripted native decisions, not visual clicks or arbitrary Recipes.
The v42 SIGKILL-after-delete-before-commit case was **CLI host qualification**;
the separate Env49 result below supplies installed Code evidence. Fixed Python diagnostics really use
WorkflowExecutor/RuntimeProcessService with in-memory SQLite; they do not
produce durable manager `core.sqlite` job receipts. This result does not
qualify named-profile identity, production cutover, UV, arbitrary C# projects,
full TS compilation or full migration.

### Separate installed Env49 SIGKILL qualification

The immutable focused 4.0.49 candidate passed a real old-180407 installation,
same-private-profile upgrade and complete Code restart. Scripted native menus
called the unchanged installed conda lifecycle service. After actual manager
removal, the source was absent, the verified backup receipt existed, and the
catalog still had its pre-unregister digest. A test-only callback then sent
**SIGKILL to the actual extension host**. The parent observed host death,
stopped the exact owned old Code window and restarted Code, not merely a CLI
stand-in. The initial test child’s exit 9 is the deliberate kill; the overall
recovery runner exited **0**.

After restart, stale metadata still existed, execution was refused and nothing
automatically replayed/restored. Explicit approved restore preserved the ID/path;
original and recovered entries then ran the real fixed Next Python Workflow.
This supplements, rather than relabels, the v42 ordinary-restart result.

Independent checks matched **5,467 installed payload files / 4,782 Runtime
pins / 38 Root JS/maps / 13 Environment sources / nine controller sources**,
and 5,401 frozen inputs. Package/XML are 4.0.49; Runtime is explicitly inherited
from Env42 with only its manifest extension-version label changed, not borrowed
peer Runtime qualification. Actual installed upgrade/management regression was
**20/20, zero skips**; controller tests were **2/2**. Original registry, package
cache and both Workflow references, source-cache metadata snapshot and historical
verification pins stayed unchanged. Independent exact-owned argv/cwd scan found
zero processes, and the exclusive Code window was formally handed to Collab43.

Report:
`.migration-test-work/em-62c03a64-511b-46dd-808f-208257bd5604/conda-crash-installed-independent-verification.json`.
Log: `.migration-test-work/conda-crash-installed-v49-attempt1.log`.
Fault injection is test-only; there is no product kill switch. Decisions are
instrumented, not visual clicks; fixed diagnostics still use in-memory SQLite.
No Node/package-table qualification is borrowed into this result. UV remains
absent; production gates, power-loss/global-process guarantees and arbitrary
C#/full TS compiler scope are unchanged.

### Language/compiler scope boundary

| Need | Existing qualified scope | Additional extension needed |
| --- | --- | --- |
| C# environment | Named installed `executor-set`, not a venv; explicitly selected local .NET 8 fixed diagnostic compile/run | Arbitrary `.csproj`/solution builds, SDK selection beyond the fixed contract, NuGet restore, project/reference/source snapshots and artifact/execution approvals |
| TypeScript | Selected existing Node native **strip-only** `.ts/.mts/.cts` execution and reviewed CommonJS/ESM contracts | `tsc`/`tsx`/`ts-node`, `tsconfig` resolution, non-erasable syntax, type checking/transpilation, project dependency/output policy |
| Generic legacy commands | Existing explicit command/Bash/PowerShell workflows may invoke user-selected tools under their own contract | This does not implicitly provide typed C#/TS Environment providers or compiler provisioning |

Repository TypeScript build tooling is development validation, not a product
TS compiler provider. The registered Python script contract remains Python;
language-neutral catalog/executor discovery is not an arbitrary-language
execution grant. None of these extra compiler/project extensions are added
by the conda lifecycle slice.

### Remaining old Python workflows: actual legacy support versus Next integration

The audit reads the exact `1804071c…` old VSIX's environment UI, extension
message handlers and `servers/pyenvs.js`, not just exported API names.
The old edit UI submits name/description only. Old cached package comparison,
similarity and merge-script selection were exercised against that exact module
with synthetic cache records; actual old conda package refresh (`conda list`),
disk-size refresh (`du -sk`), Python-version probing and subsequent cached reads
also passed on the retained private old-created 28-package prefix, with private
HOME/config/cache and an isolated namespace. Generated merge scripts were
**not executed**; no UV manager was installed/invoked.

| Old real user workflow | Existing Next coverage / difference |
| --- | --- |
| Register a detected folder; edit name/description; create local venv/conda; unregister and use original IDs | Qualified focused installed paths; original metadata/Workflow references retained. The new explicit bundled-pip venv option is source/fixture-only, not additional installed qualification. UV creation remains positive-unverified because UV is absent. |
| List conda environments then select one to register | Env51 qualifies explicit installed-tool inventory with a selected inventory-file copy or envs directory, followed by separate current-catalog registration approval. Source inventory is unchanged; root/admin discovery is refused rather than scanning passwd homes. |
| Package table with cached view and explicit refresh | Env50 qualifies conda; Env51 qualifies registered-interpreter pip tables, explicit refresh and cached full restart. Missing pip fails without installation/fallback. Isolated pip excludes user-site/PYTHONPATH; UV positive coverage remains absent. |
| Compare two package sets | Env51 qualifies current-catalog cached same/upgrade/downgrade/added/deleted using the same pure legacy implementation. Missing cache requires explicit refresh, never implicit execution. |
| Find similar environments | Env51 qualifies shared legacy Jaccard/exact-version ranking, known Python-minor exclusions and cached size estimates; cached analysis after full restart does not select/run a tool. |
| Merge-script clipboard workflow | Env51 qualifies the shared package-count/size planner (display names, missing pinned packages, conflict comments), exact-interpreter shell quoting and separately approved clipboard delivery. Declining preserves clipboard; no install/delete command is executed. |
| Cached version/size badges and refresh | Env51 qualifies explicit version/Linux allocated-size probes and bound cached badges/views, including full restart. No hidden missing-metadata sweep or legacy-registry write; size is bounded/non-following, not a live estimate. |
| Activation, migration and deletion | V37/v42 cover reviewed real terminals, keep-original copies and managed-copy removal/recovery. Old migration moves/removes the original; Next intentionally does not. Both external and synthetic permanent deletion are now removed from the menu and hard-disabled after the mount/path-race review below. `removeFiles=true` parity is **not** claimed. |
| Manual delete-script clipboard | Env51 qualifies the reviewed current-catalog conda clipboard adapter, preserving `/envs/` and non-base restrictions; no deletion occurs. Existing reviewed venv/uv script paths are separate, and UV remains positive-unverified. |
| Crash during conda delete before catalog CAS | Separate Env49 real installed extension-host SIGKILL plus complete Code restart passed; stale execution refused, no replay, explicit restore kept ID/path and ran Python. It does not imply power-loss durability or global process containment. |

Do not duplicate the retained legacy analytics or silently route new IDs back
to an old registry/prefix. Env51 adapters bind the current catalog,
freshly approved installed tools and read-only cached snapshots explicitly.
The differences above remain deliberate boundaries, not claims of complete parity.
Arbitrary C# projects and full TypeScript compilation are **new extensions**,
not old Python parity blockers; existing generic command capabilities remain
separate from typed Environment provider support.

### First package integration slice: current Next conda table

The existing isolated-trial Environments command now exposes **View registered
conda package snapshot** and **Refresh registered conda package snapshot
(explicit tool)**. Both select the current Next catalog, including newly
created IDs absent from the legacy registry. Viewing a missing snapshot only
explains how to refresh; viewing an existing snapshot opens a searchable/native
editor Markdown name/version table without running a manager or selecting a
tool. It is an untitled display copy, not an editable cache connection.

Refresh explicitly selects installed conda, reviews exact `list --json -p`
argv and approves OS-user execution. It reuses the existing manager authority,
bounded/cancellable process helper and the legacy **pure package normalizer**
(newly exported without changing its logic). Query-only tool selections cannot
provision and require no archive cache. Private offline HOME/config/cache,
plugins-disabled execution, prefix-metadata/catalog checks and atomic snapshot
publication preserve the previous cache on pre-publication failures. A failure
after rename reports possibly published state rather than inventing rollback.
Work remains for inspection; no install/update/solve/download or automatic retry.

Bounded JSON snapshots live under the existing catalog's `package-snapshots`,
not a new registry/database. IDs, prefix/interpreter paths, root identity and
metadata digest distinguish the saved source. A rebound ID cannot reuse the
old binding's cache. Missing/changed sources can expose historical data with an
explicit non-live label, never an execution grant. Legacy registry/package
cache bytes are neither read as the current result nor rewritten.

Four focused tests passed with **real installed conda**, retained synthetic
prefix copies and isolated network/PID namespace: complete native-UI-function
refresh/table/cache/reopened-catalog flow, actual child cancellation plus
catalog/metadata drift, missing/rebound sources, and directory-sync failure
after publication. These tests instrument UI/editor decisions; separate
installed evidence follows. The immutable Env49 SIGKILL inputs were not changed.

After the formal Env49 → Collab43 → Env50 Code handoffs, the independent frozen
4.0.50 candidate passed real old-180407 installation, same-profile upgrade
and complete Code restart, runner **exit 0**. Its native Environments command
selected a **newly created current Next ID absent from the legacy registry**,
explicitly selected/approved actual installed conda, queried **28 packages**,
and opened the real native editor table. Missing-cache and subsequent cached
views needed no manager. After full restart, cached view had the exact same
snapshot hash/capture time, no tool selection and zero manager phases.

Independent checks matched **5,472 installed payloads / 4,782 Runtime pins /
44 Root JS/maps / 17 Environment source hashes / ten controller hashes** and
**5,410 frozen inputs**. Runtime is explicitly inherited from Env42, with only
the 4.0.50 manifest label changed; this is not latest-peer/full-release
qualification. The four package tests passed again against the **exact installed
Root**, as did **23** upgrade/management/real-offline-conda regressions, all
**zero skips**. Original legacy registry/package cache/Workflow references,
source-cache metadata and historical verification pins stayed unchanged.
Private namespaces exited; independent exact-owned argv/cwd process count was
zero and Code was formally handed to Recipe ports. No visual-click claim.

Report:
`.migration-test-work/em-adc9db89-517f-4799-a6f7-67a2dafe0e4d/conda-package-installed-independent-verification.json`.
Logs: `.migration-test-work/conda-packages-installed-v50-attempt1.log`,
`.migration-test-work/conda-v50-actual-installed-package-focused.log` and
`.migration-test-work/conda-v50-actual-installed-compatibility.log`.

This closes one explicit conda package-table workflow on a real installed path.
At this Env50 snapshot, pip/venv/UV tables, analytics, size/version refresh and
conda inventory remained separate gaps; Env51 below advances the non-UV paths.
Arbitrary C#/full TS compilation remain out-of-scope new extensions.

### Env51: pip, shared analytics and explicit inspection

Env51 connects the current catalog's **pip snapshot view/explicit refresh**,
**comparison**, **similarity**, **clipboard-only merge/manual conda deletion**,
**cached version/allocated-size view/refresh** and **scoped conda inventory with
separately approved registration**. These stay behind the existing trusted,
fresh isolated-trial/experimental-upgrade checks. They never route a new ID
through the legacy registry, automatically install pip/packages or run scripts.

The existing conda snapshot service is now a compatibility facade over a shared
Python snapshot service: the v1 conda schema/digest stays backward compatible.
Pip uses the selected registered interpreter's installed `pip`, isolated flags,
null pip configuration, private HOME and disabled indexes/version checks. No
`ensurepip`, package seed, PATH fallback or fallback to another interpreter.
Missing pip fails explicitly and keeps the previous cache. Cached view and
analytics never run a manager, including on missing cache: explicit refresh is
required. Pip's isolated scope includes configured system-site packages but
excludes user-site/PYTHONPATH injection; this is not all-user-site legacy parity.
Prefix-local metadata matching does not prove external system-site data live.

Comparison's numeric-components/fallback ordering and five statuses, similarity's
case-insensitive Jaccard/exact-version ranking and known minor-version exclusions,
and merge's package-count/size tie-break now share the **same pure functions**
with retained legacy handlers. Snapshot dates/source state remain visible.
Merge still returns display names, pins only missing packages and comments on
conflicting versions. Next generates shell-quoted direct-interpreter commands,
guards manual deletion and requires separate clipboard approval; it does not
execute the generated install/delete commands. Permanent deletion cannot be
undone through metadata restore. Legacy conda `/envs/`/non-base restrictions
remain; Next managed-copy deletion uses its existing reviewed lifecycle.

Version/size is an explicitly approved fixed interpreter probe: Linux allocated
blocks/hardlinks/non-followed symlinks, rounded like `du -sk`, bounded at 250,000
objects. Results live in bound snapshots beside package snapshots, not the
legacy registry or a new database; list badges are cached, never hidden probes.
Conda inventory uses the selected installed `env list --json` with private
offline config/HOME and selected inventory-file copy or envs directory; it
never cleans the source file. Choosing an entry requires a separate metadata
registration approval and grants no Workflow execution authority.

An early root-mapped inventory test failed to find its selected HOME copy
(`python-analytics-focused-v3.log`, 8/9); it is **not qualification**. Installed
conda's admin branch enumerates passwd homes despite HOME, so the new inventory
service now refuses root/admin **before launching anything**. The qualification
launcher instead maps the actual non-admin UID before exec, with private network,
mount and PID namespaces and private HOME. No admin/home-scan claim is borrowed
from the discarded test. Real non-admin frozen CLI results are **9/9**, plus
**23/23** upgrade/management/offline-manager regressions, zero skips; actual
old-module comparison/similarity/merge oracles and Linux `du` agree.

After b9's formal handoff, the final immutable **4.0.51** passed actual
old-180407 installation, same-default-profile upgrade, all native workflows
above and complete Code restart, runner **exit 0**, with actual UID **1009**.
Two newly registered venvs use explicitly created `--without-pip
--system-site-packages` fixtures and already-installed system pip, not seeded
packages. Real editor tables cover all five comparison statuses; native
similarity, explicit metadata probing, declined/approved clipboard delivery,
actual conda inventory/registration and Python Workflow use passed. Restart
preserved snapshot/capture-time/metadata hashes and inventory ID, with zero
query/tool selection or script replay on cached analysis.

Independent checks matched **5,486 installed payloads / 4,782 Runtime pins /
58 Root JS/maps / 23 Environment source hashes / 12 controller hashes**, plus
the **nine actual installed harness copies** and **5,435 frozen inputs**.
Runtime is inherited from Env42, not latest peers; only its manifest version
label changes. Root strict emit was retained unchanged. The newly packaged
Room recovery dependency's source independently reproduces that strict emit;
no Room workflow qualification is borrowed. Against the **exact installed
Root**, **10/10** package/inspection cases and **23/23** upgrade/management/
real-offline-manager regressions passed, zero skips; the namespace launcher's
**2/2** lifecycle cases also passed with the same pinned launcher.

The first installed attempt failed activation because the focused overlay
omitted that Room dependency. The second passed native initial/restart tests
but failed final evidence generation because its source file was not frozen.
Both exit-1 fixtures/logs remain intact with independent owned-process count
zero. The final snapshot adds the matching dependency source and preflights
source pins before Code launch; it does not edit either failed snapshot.
Legacy registry/package cache/Workflow references, selected inventory,
source-cache attributes/repodata and historical verification pins stayed
unchanged. The final namespace exited, exact-owned argv/cwd process count was
zero, and Code was formally handed to Collab57 before CLI report work.

Report:
`.migration-test-work/em-53985cff-c49b-4ac8-8545-1e815f30c5f3/python-analytics-installed-independent-verification.json`.
Logs: `.migration-test-work/python-analytics-installed-v51-attempt3.log`,
`.migration-test-work/python-analytics-v51-actual-installed-focused.log` and
`.migration-test-work/python-analytics-v51-actual-installed-compatibility-v2.log`.
The earlier compatibility command pointed at tests absent from the frozen
subset and never started; its log is retained, not counted as coverage.

This does not retroactively extend Env49/50 evidence, qualify named profiles,
visual clicks, production automatic adoption, global process containment or
power-loss durability. UV is absent and positive-unverified; arbitrary
C#/full TS compilation remain new scope, not old Python blockers.

### Remaining deletion audit: execution is not a script preview

The original `1804071c…` VSIX's `30-environments.js`, compiled extension
handlers and `servers/pyenvs.js` distinguish three workflows:

* **Delete, unchecked** calls `envDelete(removeFiles=false)`: unregister and
  discard its old package cache, but retain the folder.
* **Delete, checked** calls `envDelete(removeFiles=true)`: actually remove the
  venv-like folder, or run `conda env remove`, then unregister only on success.
  Missing-path/manager/filesystem failures retain registration. This is not a
  generated script and is irreversible; old partial filesystem failure is not
  transactional either.
* **Merge script / Del script** only generate, copy and display text. Both old
  handlers and their UI explicitly say the extension does **not** execute it.
  Merge generation may still perform legacy cache/metadata queries; that is
  not execution of its emitted package-install/delete commands.
  Manually running a script does not unregister metadata. Adding automatic
  merge/package-install/script execution would invent behavior, not fill parity.

Existing Next quarantine/removal-with-recovery-clone actions really remove
the selected source binding, but retain files elsewhere. They are **not**
equivalent to permanent deletion or full space reclamation.

The new narrowly scoped action **Permanently delete synthetic Python files
and unregister** reuses the existing profile-owned synthetic-prefix guard,
fresh identity/config/activation checks, catalog CAS and maintenance ledger.
After a separate irreversible-deletion modal it file/directory-fsyncs a bounded
`pkm.local-python-deletion/v1` **requested** record, physically removes the
prefix without following child symlinks, then CAS unregisters. It does not
quarantine, run a generated script, repair permissions, terminate users of a
prefix, roll back or automatically replay. Partial deletion, crash or CAS loss
can leave stale metadata. **Inspect recorded permanent Python deletion** is
read-only observed state, not a completion receipt; a surviving folder may be
partial/replaced. Ordinary metadata restore cannot restore erased files.
Deletion requests are excluded from quarantine restoration.
This is a user-requested execution action, never an unattended deletion policy.

The original module's real checked-delete effects and the new native adapter
were exercised with isolated real venvs; before-approval refusal, stale
catalog/config, revocation, partial deletion, post-delete CAS loss and a real
worker SIGKILL after deletion were checked. Manually run generated venv deletion
and no-missing-package merge scripts actually delete only their quoted target;
declined `DELETE` and stale-config guards refuse, and metadata stays unchanged.
A generated conda deletion script also ran on a copied `/envs/` prefix with
private offline manager state, preserving its source and catalog. These are
explicit **test-actor** shell executions, not a new PKM execution feature.
No missing-package installation stage, UV manager or real account was used.
The five focused cases plus thirteen existing management/quarantine cases pass
**18/18**; with seven automatic-upgrade recovery cases, the actual installed
Env64 modules pass **25/25**, zero skips, in an actual-non-admin private namespace.
Full-manager installed attempts retained their failed fixtures: first the
controller assumed `EACCES` where Electron reports `ENOTEMPTY` for the genuinely
unreadable directory, then two attempts hit shared-disk `ENOSPC`. The corrected
controller independently requires a real `readdir` `EACCES`, not merely a relaxed
message assertion. A fourth attempt passed the new native deletion/failure cases,
but an extra general-executor trial returned a detail-free startup error. That
unattributed third-host issue is retained, not claimed fixed or blamed on disk.

The final resource-bounded `--python-delete-only` journey **passes, exit 0**:
actual original 4.0.22 private-profile installation → Env64 → complete Code restart,
with explicit missing-Python refusal, native decline/success, child-symlink canary,
real permission failure, preserved stale registration and read-only outcomes.
Restart preserves request hashes and the unreadable folder's mode until the
test controller explicitly repairs its own fixture permission. No deletion replay
or automatic permission repair occurs. This is native command/dialog
instrumentation, not visual-click qualification. The new deletion's real SIGKILL
test is a CLI worker, **not** an installed extension-host kill.

Independent verification matches 5,486 installed payload files, 4,782 Runtime
pins, 58 selected Root JS/maps, 23 Environment sources, 16 controllers,
13 installed harness copies and 5,438 frozen inputs; namespace exit and exact
argv/cwd owned-process count are independently zero. The final installed modules
are byte-identical to those used by the 25-case CLI suite. Env64 inherits Env51's
other Root modules and Env42's Runtime, not the latest peers/full release.
This narrow rerun does **not** requalify Node executors, conda or package analytics;
their previous separate qualifications remain separate. Original registry,
package cache, Workflow reference and historical verification bytes stay fixed.

Still not claimed: automatic permanent deletion of external/original or
generic `other` prefixes; erasure of conda recovery clones; old destructive
move/source-removal migration semantics; automatic all-environment probing;
old interactive column sorting/hide-unchanged controls in native Markdown.
Historical Next snapshots remain retained instead of old cache-file deletion.
UV positive behavior remains unverified. These are explicit remaining
boundaries, not evidence that old scripts used to execute automatically.

## Persistence and recovery

`globalStorage/next-local-environments` is an explicitly upgraded, machine-local
catalog, separate from portable Next workspace state and backups. It is not a
second execution registry: the old registry stays read-only and the imported
Python provider is an explicit projection into the existing host authority.
Automatic discovery is limited to the opt-in profile metadata gate above.
No dual-write, Python environment creation or PATH discovery is performed.
Restart requires starting a fresh trial and reselecting authority, not re-entering
the stored environment paths.
Do not sync this catalog to another machine as executable configuration.

Each commit is an immutable numbered JSON revision containing the prior
revision's digest. Writes are size-bounded, mode `0600`, and file-fsynced before
exclusive hard-link publication. Directory fsync completes the commit. Two
hosts sharing an expected revision cannot overwrite each other's changes;
the loser must reopen, review and explicitly retry. No lock stealing occurs.

SIGKILL before publication leaves an ignored `.pending-*` file and no committed
change. SIGKILL after publication leaves a readable committed revision. Neither
case replays runtime effects, because catalog writes have none. If publication
succeeds but durability acknowledgement fails, the error explicitly says the
commit may have succeeded: inspect the catalog, do not automatically retry.
This tests process crashes, not power-loss/filesystem-fault durability.
Pending files are inert and retained for manual inspection; no automatic cleanup
touches other hosts' pending writes. Gaps, corrupt committed JSON, changed hash
chains and symlinked catalog directories/files fail closed, not as empty state.

Exact source re-import is idempotent. Imported source digests remain recorded
even after restoring an older snapshot, so restoring revision 0 does not silently
re-import previously removed entries; use explicit metadata restore instead.
The catalog itself never deletes/moves files, installs packages, updates
interpreters or repairs paths. The separately reviewed private lifecycle above
can copy/rebind and quarantine/restore synthetic prefixes; no metadata restore
silently performs those filesystem operations.

## Validation

Use fresh isolated output directories; never run the next-server full test
script (it removes verification state).

```sh
node_modules/.bin/tsc -p tsconfig.json --outDir .environment-catalog-build
next-server/node_modules/.bin/tsc -p next-server/tsconfig.json \
  --outDir next-server/.environment-catalog-build
PKM_ENV_AUTHORITY_BUILD="$PWD/.environment-catalog-build" \
PKM_ENV_NEXT_BUILD="$PWD/next-server/.environment-catalog-build" \
node --test tests/test-local-environment-catalog.js \
  tests/test-local-environment-upgrade.js \
  tests/test-local-python-management.js \
  tests/test-local-runtime-workflow.js tests/test-python-environment-authority.js \
  tests/test-next-python-workflow.js
```

Focused tests cover real local Python venvs created with `--without-pip`, real
local Node, source drift/corruption, stale revision refusal, two competing native
processes, SIGKILL before/after publication, non-destructive unregister/restore,
and trust/client/source revalidation. Existing Python tests additionally cover
the real private child, Workflow/Runtime dispatch and workspace backup/restore.

An optional **exclusive Code test window** is required for:

```sh
node scripts/run-environments-installed.js \
  --management \
  --legacy-vsix=/absolute/old.vsix \
  --candidate-vsix=/absolute/frozen-next-candidate.vsix \
  --root-build="$PWD/.environment-catalog-build"
```

This runner only uses installed local Code/Xvfb and a private network/PID/mount
namespace. It creates a private HOME/profile/root. With `--upgrade`, it actually
installs and activates old 4.0.22, exercises its own profile registry and local
Python, then installs an independent focused candidate overlay into that same
profile. This slice's compiled root modules/commands and a **freshly
staged** Next payload are installed, with their own new manifest/build ID.
The base candidate and historical provenance/runtime verification pins are not
rewritten. MCP Python is deliberately unconfigured to prevent
automatic runtime installation; no package installation is requested.

The original catalog-only and `--execution` harnesses exercise production command registration and a real
private Python child using instrumented VS Code dialogs. It reopens the same
private profile in a second Code process, verifies persisted metadata cannot
revive old authority, and reselects Python in a new trial. With `--execution`, it
also runs Node/C# through production commands, cancels a real Node process, and
SIGKILLs the directly owned managed child after stdout confirms the Node program
started. The next Code process explicitly recovers UNKNOWN without replay, then
approves a new Node run. It is **not**
interactive click/visual UI qualification, full release-package validation,
or same-root production migration. Those earlier modes do not activate the old
extension; the separate `--upgrade` journey does. `--management` includes that
journey plus explicit Python creation/edit/register/unregister/restore and restart
use; old UI functions are evaluated with instrumented modal/form inputs, not
claimed as visual clicks.
The runner retains scoped JSON evidence and hashes under its own
`.migration-test-work/environments-installed-*` fixture.

### Recorded Linux result (2026-11-13)

Both strict TypeScript builds and the 12 focused tests passed. The focused
installed overlay journey also passed in two successive Code processes:
old-writer profile import, denied/idempotent import, installed Node registration,
real Python Workflow, unregister/restore, closed/restarted authority refusal,
and explicit Python re-selection in a new trial. The actual old writer's emitted
registry remained byte-identical across activation, commands and restart.
Independent host `/proc` inspection found no remaining fixture processes;
the base frozen candidate SHA-256 remained unchanged and no MCP runtime was
created.

Evidence:
`.migration-test-work/environments-installed-7182b092-7fd3-41c6-8e64-697bc508e76c/`
contains `installed-result.json`, `reopened-result.json`,
`overlay-evidence.json` and `closed-independent-verification.json`.
Log: `.migration-test-work/environments-installed-20261113.log`.
Overlay SHA-256:
`fbdddc3f6558204e5adcc48ff14612126393dab51bc3cd6892e43ba5ddcaf5a4`.
These are new scoped test results, not refreshed historical provenance pins.
The original catalog-only journey used an old VSIX's real registry writer,
**not** old Workbench environment-management clicks.

The subsequent execution journey passed both strict builds and **18 focused
tests**, including actual local .NET SDK `8.0.420` controlled compilation/run,
missing-SDK refusal, one-use IPC grants, real Node argv/cancellation and real
SIGKILL recovery before Workflow lease expiry. Old Python tests were retained.
Installed v2 passed in two successive Code processes, with Node and C# execution,
real cancellation, managed-child SIGKILL and explicit recovery/new Node approval;
Python succeeded in both processes.

Execution evidence:
`.migration-test-work/environments-installed-75eb140c-6486-4bc7-abb9-224e5c2f9066/`
contains `execution-initial-result.json`, `execution-reopened-result.json`,
`overlay-evidence.json` and `closed-independent-verification.json`.
Log: `.migration-test-work/environment-execution-installed-v2.log`.
Overlay SHA-256:
`0a22ea4309d048a6aa6528a21a362f990edf3115fa1424eaaa8c2a38aa997131`;
fresh Runtime build ID:
`c388b460123ded6e5d55df41ea45fbcc400a761d086c16296646d40c0564ed21`.
Independent `/proc` inspection found no remaining processes from either the
initial failed qualification attempt or successful v2. The first attempt
explicitly refused C# because a root-only ownership assumption was incompatible
with private user namespaces; no install fallback ran. The final policy uses
the explicitly selected runtime's owner and canonical, non-shared-writable SDK
assets instead.

The final installed rerun, including permanent in-memory handle revocation after
trust failure, also passed and its root module source hashes match the final
root authority implementation. Final installed evidence:
`.migration-test-work/environments-installed-e05a0717-34a8-4a91-aab2-bb47f5414a81/`;
log `.migration-test-work/environment-execution-installed-final.log`;
overlay SHA-256
`8702f185c55242146e1839d921a5550b7abc24ccf3fe1433b211025c57a7ac7d`;
fresh Runtime build ID
`180862b3c12c874cb9046aba1e7201f9f3c5b3a15a5cfc72fbb393c648f17ada`.
Its independent cleanup verification confirms no fixture processes remain,
the original frozen candidate is unchanged, and no MCP runtime was created.
The exclusive Code window was explicitly returned to the Recipe workstream.
After that installed run, the Env-only shutdown failure branch was tightened to
preserve Runtime's repository/unclosed lease on drain failure. The final strict
builds and **19 focused tests** passed, including an injected `REAP_TIMEOUT`
asserting no false release/closed database. That exceptional branch is focused
fault-injection evidence, **not** an additional installed-Code qualification.
Final focused log: `.migration-test-work/environment-execution-focused-final.log`.

### Automatic upgrade installed result (2026-11-13)

Both strict builds and **26 focused tests** passed, with zero skipped. Seven new
automatic-upgrade cases cover gate/trust, complete record preservation,
unavailable runtimes, drift/corruption/conflicts, lost durability acknowledgement,
and two actual SIGKILL publication boundaries. Existing Python, Node, C#,
cancellation, no-SDK refusal and no-replay recovery regressions remain.

The actual old-installed → new-overlay → restart journey passed in **three Code
lifetimes** against one private profile. Old 4.0.22 activation read its registry,
updated configuration through its real writer and ran the existing Python.
The new activation discovered both an existing and a missing Python entry with
**zero import or activation file dialogs**. Full original records were retained;
registry, package cache and original Workflow reference bytes stayed unchanged.
The old/new compilers retained the reference's executable digest.

The missing Python emitted a repair warning and an actual run attempt refused,
both before and after restart. The available original Python ran through the
existing fixed Workflow diagnostic in both new Code lifetimes. A newly,
explicitly registered Node ran with exact arguments and cancellation; after
managed-child SIGKILL and a complete Code restart, explicit recovery recorded
UNKNOWN without replay, then the unchanged Node binding ran again. Only the
fresh trial's root/broker setup selected paths after restart, never the
environment paths. Explicit C# registration and actual offline .NET8 compile/run
also passed. These checks do **not** qualify arbitrary old Recipe execution.

Evidence:
`.migration-test-work/environments-installed-65bf2ba6-0bde-47b5-b8a3-bf5f2fc75a44/`
contains `legacy-profile-snapshot.json`, `upgrade-initial-result.json`,
`upgrade-reopen-result.json`, execution receipts, `overlay-evidence.json` and
`closed-independent-verification.json`.
Logs: `.migration-test-work/environment-upgrade-installed.log` and
`.migration-test-work/environment-upgrade-focused.log`.
New overlay SHA-256:
`bbba4f5125634444799b97102ca01f38500e58ddea0a6a2075a4324869dbe538`;
fresh Runtime build ID:
`b1fea3ce2640f3c64acd16724f2e2c10fafeacdb7c88e7444185277aac56625c`.

Independent host `/proc` inspection found zero fixture/Env controller/helper
processes. All **5419 installed payload files** matched the overlay (apart from
Code's added manifest `__metadata`); current root sources and emitted Next Env/IPC
modules matched the installed evidence. The real old VSIX and original frozen
candidate hashes were unchanged. No MCP runtime was created, no dependency or
runtime installation was requested, and no historical pins were refreshed.
Code gate was formally returned to Recipe. The drain-failure branch remains
focused fault-injection qualification, not an actual installed REAP_TIMEOUT.

### Python management installed result (2026-11-13)

Both strict builds and **32 focused tests** passed, zero skipped. Six added tests
cover stable-ID edits and the untouched original snapshot, actual local no-pip
venv creation, revoked/out-of-synthetic-root refusal, a catalog conflict after
filesystem creation with retained-file recovery, missing/invalid paths and
explicit native modal/trust behavior.

The management journey passed with actual installed old 4.0.22, the new private
overlay and a complete Code restart. The old shipped UI functions were evaluated
with controlled form/modal inputs: name/description edit, default non-destructive
remove, venv create form and terminal selection produced their actual old message
shapes. The old rename was persisted by the installed old registry writer. These
are function-level checks, **not visual Workbench clicks**.

The new gate then covered:

- automatic old-profile discovery, original-reference Python Workflow use, and
  name/description changes with the original ID/snapshot/reference preserved;
- declined creation without any directory/catalog effect, then explicitly
  approved synthetic offline venv creation and actual Workflow use;
- editing the created entry, unregistering while retaining all files, metadata
  restore with fresh run approval, actual missing-path run refusal, explicitly
  restoring that synthetic path and running again;
- explicit existing-folder registration with a new ID and actual Workflow use,
  non-destructive removal of that registration, and stale-editor CAS refusal;
- restart retaining the created ID/name/description/path; both original and newly
  created Python ran again without reselecting environment paths.

The combined Node/C# argument/cancellation/SIGKILL/no-replay regressions also
passed. The new interpreter independently reported its exact synthetic prefix
and no installed `pip`. Original registry, per-ID cache and Workflow reference
bytes were unchanged after the old baseline. No old runtime files were removed.

Evidence:
`.migration-test-work/environments-installed-1eb0511a-92d7-4e24-be76-40a5bb90d3f1/`
contains `old-ui-management-map.json`, `management-initial-result.json`,
`management-reopen-result.json`, upgrade/execution receipts,
`overlay-evidence.json` and `closed-independent-verification.json`.
Logs: `.migration-test-work/environment-management-focused.log` and
`.migration-test-work/environment-management-installed-v2.log`.
New overlay SHA-256:
`60fa2cfcf29f687841857413253cde4fa3836a77293664a45f712e6e3d79043a`;
fresh Runtime build ID:
`f0e54a5098d629eea2adc694b0646e640ee2f80653af18107ac67a6d051c7c69`.

Independent host `/proc` inspection found zero fixture/controller/helper
processes, including the first attempt that failed staging before starting any
Code due to a peer-owned transient TypeScript error. The peer fixed that error;
the successful rerun needed no Env product-code change. All **5427 installed
payload files** matched the overlay (except Code's added manifest `__metadata`);
current root sources and emitted Next Env/IPC modules matched installed evidence.
Original VSIX/candidate pins remained unchanged. No MCP runtime or missing legacy
Python was created. Code gate was formally returned to Recipe.

Qualification is **offline venv management plus fixed Workflow bindings/use**,
not conda/uv creation, arbitrary old Recipe script execution, visual UI parity,
or production migration. That statement describes this earlier frozen venv
journey, not the subsequent offline-manager qualification below.

### Offline managers and exact old Python Recipe focused result

Both isolated strict builds and **36 focused tests** passed with zero skips,
including the explicitly selected installed conda/cache integration. New cases
cover native/cloned/changed/revoked manager handles, absent uv, real offline
conda creation and prefix verification, actual spawned-child cancellation,
empty-cache failure and a catalog conflict after actual creation with explicit
completed-folder recovery. A thrown progress observer also stops and awaits its
owned child before returning failure. No retained prefix is deleted or replayed.
Final log with private account enumeration isolation:
`.migration-test-work/environment-managers-focused-accounts-isolated.log`.

The additional actual old creator/Recipe proof is retained under
`.migration-test-work/environment-managers-qualification-15759537-82fe-43f5-83c5-a1bd4d8f681c/`.
Its `manager-lifecycle-evidence.json`, `old-manager/old-manager-create-evidence.json`
and `old-python-recipe-evidence.json` record local new-manager and exact old
creator success, old missing-uv refusal, and the original Python compiler/worker
execution/cancellation/reopened-receipt results described above. The selected
source cache's root/top-level identities/attributes and repodata bytes match
before/after; this is not an all-files forensic hash. Original VSIX SHA-256 and
the fixture's original registry bytes remain unchanged. The old creator's entire
original record and stable `legacy-conda` ID are preserved in that Recipe
binding; its own original registry is unchanged. The old Recipe result
does **not** qualify Next general Python execution or public protocol permissions.

The fixture's single-user mount namespace also binds a synthetic passwd entry
before any conda call. Namespace UID 0 otherwise causes old conda `env list` to
enumerate passwd home directories despite a private HOME. This avoids that
real-home discovery without changing host account files, installed conda or old
code. Logs:
`.migration-test-work/environment-managers-old-recipe-proof-accounts-isolated.log`.

### Offline managers installed result

The separate canonical short private profile
`.migration-test-work/em-7acd6827-05ec-4232-ae8f-776d2eb816ef/`
passed actual installed **old 4.0.22 → new gated overlay → full restart**, three
Code lifetimes. Its old conda prefix was genuinely created through the shipped
old creator using only a private copied offline channel/cache. Original full
configuration, ID, Python/conda Workflow reference bytes and interpreter paths
were automatically discovered with no manual import or path reselection.

Instrumented native commands and real processes covered:

- original conda binding/use, separately approved local conda tool/cache/version,
  actual offline new-prefix creation and fixed Python Workflow binding/use;
- real owned create-child cancellation with partial files retained, incomplete
  folder registration refusal, empty-cache failure without a successful entry,
  missing uv refusal with no new directory/catalog revision;
- stable-ID conda metadata edit, non-destructive unregister/restore and fresh
  approval, then original/new conda use after restart without creation replay or
  environment/tool/cache path reselection;
- all prior offline venv management, original Python, Node exact-argv/cancellation,
  actual offline .NET8 executor use and real broker SIGKILL/UNKNOWN/no-replay
  regressions.

The first long fixture's 261-byte prefix genuinely hit a cached binary's
255-byte placeholder limit. It failed with no entry and retained its files.
The successful run used a **new, separate shorter canonical profile**, not an
alias, move, shortened interpreter path or mutation/deletion of the failed
prefix. Both failed and successful fixture processes were independently absent
after closure.

Evidence includes `managers-initial-result.json`, `managers-reopen-result.json`,
old creator/profile snapshots, management/upgrade/execution receipts,
`overlay-evidence.json` and `closed-independent-verification.json`.
Log: `.migration-test-work/environment-managers-installed-v2.log`.
New overlay SHA-256:
`961fcd68efd669667c5c5e7045c703b13189f69bcad397b253110070bf577996`;
fresh Runtime build ID:
`be4df8454c6dd7e0f6e7b1ead580db9b1a4df233497ad231261887be43c513e0`.

Independent host checks matched **5429 installed payload files** (only Code's
added manifest `__metadata` ignored), current root Env sources/emitted modules
and Next Env/IPC modules. Original profile registry/cache/reference bytes, old
usable runtimes, selected cache snapshot and both original VSIX pins were
unchanged. No missing Python, MCP environment or downloaded runtime was created.
The Code gate was formally returned to Recipe immediately after independent
argv/cwd process cleanup. This remains private experimental qualification,
**not production cutover, positive uv creation, arbitrary Next Python scripts,
authenticated public Recipe parity or visual-click UI qualification**.

## Offline missing-package installation: narrow adapter for the old manual merge workflow

The genuine **4.0.22** ordinary Environments dashboard has package view/refresh,
activated terminals and `Merge script`; it does **not** have direct generic
pip/conda install/uninstall buttons. Its shipped `pyenvMergeScript` chooses
the larger package set (allocated size breaks ties), emits
`python -m pip install "missing==version"` and leaves different existing
versions unchanged. The user runs that script manually; default pip indexes
and dependency resolution can download code, and its later footer removes
the other prefix. Neither the old network-enabled script nor its deletion
footer is executed by this slice. Next's existing clipboard-only merge script
and its original manual contract remain unchanged.

The new **Install missing merge packages from local wheels (synthetic only)**
native action in `src/ui/next-python-packages.ts` restores an executable
**installation portion**, with a deliberately narrower offline adapter:
select two fresh saved package snapshots, preserve the old keep/drop decision
and pins, select exactly matching local wheels, then approve the exact target,
interpreter, wheel digests and installation risks. Only a registered **created
synthetic venv** under this private profile, with its matching creation receipt
and already installed prefix-local pip, is eligible. External/conda targets
are refused; there is no bootstrap, upgrade or generic uninstall API here.
Stop prefix usage first; PKM does not exclude every outside process or revoke
every existing Workflow approval. Creating/installing packages grants no new
Workflow execution authority.

`src/runtime/local-python-wheel-install.ts` binds the selected interpreter,
current catalog and both saved source fingerprints to the merge plan. It
copies reviewed owned wheels from bounded no-follow file reads into a new
private operation directory and checks the digest again before parsing.
All wheels are validated before pip runs: at most eight simple-name/numeric-
version distributions; `py3-none-any` and `Root-Is-Purelib:true`; bounded regular
Python module payloads and minimal `METADATA/WHEEL/RECORD` only. It rejects
path traversal, duplicate names, special/symlink payloads, `.data`, entrypoints,
startup hooks, native binaries, foreign or already present namespaces and
RECORD paths outside the exact archive files. Python payloads are syntax-parsed
without importing/executing them. **This does not support arbitrary
real-world wheels**, package data/licenses outside this minimal layout, sdists,
shared namespaces, dependency installation or general conda packages.

The approved installed pip runs on the private copies with:
`--no-index --no-deps --only-binary=:all: --no-compile --ignore-installed
--disable-pip-version-check --no-cache-dir`. `--ignore-installed` prevents
pip's uninstall phase; absence checks reject ordinary overwrites. Prefix and
installed distribution/version locations are verified. No index/download,
source build, existing-version change, drop deletion or catalog rebind is
requested. Old snapshot bytes remain unchanged: the kept table becomes
historical after installation and requires its separate explicit refresh;
the untouched other prefix's snapshot is not automatically marked historical.

**Limits and failure semantics:** selected Python/pip still execute with OS-user
permissions. Private HOME/temp and checks are not OS network denial, an atomic
filesystem sandbox or protection against same-user concurrent path/mount or
staged-file replacement. This is not production safety/installed qualification.
Installation mutates prefix files with **no rollback**; partial files can remain
on failure/cancel. Only the direct process is stopped; installer descendants
are not guaranteed terminated. Requested work/receipt is retained, and a
separate success outcome means the installer returned and verified distributions,
not a restored execution grant. There is no automatic replay/retry/cleanup or
cache refresh. Process/crash outcomes must be inspected; receipt writes are
not claimed a power-loss-durable transaction.

`tests/test-local-wheel-install.js` creates only private real venvs and a
self-authored minimal wheel. It loads the actual old VSIX manager to verify
the old missing-pin/keep decision, executes the approved Next adapter with
installed local pip, then imports **pkm_demo 1.0, value=42**. Catalog IDs,
old cache bytes and the other prefix are unchanged. Other focused cases reject
traversal, entrypoints, foreign/existing namespace collisions and escaping
RECORD data and invalid Python payloads before package writes, plus digest drift, decline, pre-spawn
cancellation, forged target binding and a real external prefix copy. No Code
window, production data or network-enabled old install was used.

```sh
B=.migration-test-work/environment-local-wheel/build
node node_modules/typescript/bin/tsc -p tsconfig.json --outDir "$B" --incremental false
PKM_ENV_AUTHORITY_BUILD="$PWD/$B" node --test tests/test-local-wheel-install.js
unzip -p personal-knowledge-4.0.22.vsix extension/dist/servers/pyenvs.js \
  > .migration-test-work/environment-local-wheel/old-pyenvs.cjs
PKM_ENV_AUTHORITY_BUILD="$PWD/$B" PKM_TEST_PYTHON=/usr/bin/python3 \
PKM_TEST_LEGACY_PYENVS="$PWD/.migration-test-work/environment-local-wheel/old-pyenvs.cjs" \
  node --test \
  --test-name-pattern='genuine 4.0.22 manual|traversal|decline/digest|real isolated Python metadata|comparison stays|cancel, catalog|real existing pip|real allocated-size|missing pip|saved pip' \
  tests/test-local-wheel-install.js tests/test-python-comparison-interaction.js \
  tests/test-local-python-packages.js
```

Compile succeeded; new cases **3/3**, selected regression **10/10** (new three,
three comparison-interaction cases and four prior offline pip/metadata cases).
Logs: `.migration-test-work/environment-local-wheel/{compile,compile-final,initial,focused,regression,regression-final}.log`.
Initial fixtures had a picker-selection bug and writable archive mode; these
were corrected, not product failure-to-pass evidence. The first combined
selector accidentally included the conda inventory case, which refused its
missing explicit tool before any conda execution; its negative selector was
replaced with the positive selector above. The external-copy fixture's mode
was also made private so its refusal tests target scope, not permissions.
Build/extracted-oracle/private fixtures may be cleaned; compile/extract before
reproduction. Production default remains unchanged; both permanent Python
deletion APIs remain disabled and old destructive move is not restored.

## Explicit bundled-pip venv creation: restore old usability, not automatic installation

The actual 4.0.22 `extension/dist/servers/pyenvs.js` creates a venv with
`<baseInterpreter> -m venv <parent/name>`; ordinary Python's default venv
creation seeds pip. Next deliberately uses `--without-pip`, and existing
package refresh correctly fails instead of silently installing missing pip.
The missing user workflow was a usable **new venv with pip** from already
installed local Python resources, not an old general-purpose install/uninstall
button: the old Environments UI has package viewing/refresh and a manual merge
script, not direct arbitrary pip install/uninstall controls.

`src/ui/next-local-environments.ts` adds **Create offline Python venv with
bundled pip** to the existing default-off experimental management menu. The
user chooses a registered base and explicitly approves both creation and
bootstrap into the exact generated private-profile prefix. The ordinary
**Create offline Python venv** remains no-pip. No production route/default,
root-adoption logic or installed package manager is changed.

`src/runtime/local-python-management.ts` still creates/inspects the empty venv
and verifies `sys.prefix` first. Only the new opt-in venv mode invokes that
**new prefix's** Python with `-I -B`, checks it is not the base/system prefix,
and calls `ensurepip.bootstrap(default_pip=True)`. Its existing local wheels
are used; on this host Debian Python 3.8 reads `/usr/share/python-wheels`.
Then it checks `sys.prefix` and the real prefix-local `pip.__file__` before
the existing catalog CAS registration. Conda/uv provider creation cannot use
this option. The requested creation receipt records `bundledPip:true`; success
is still determined by the catalog, not replaying that receipt.

**Side effects and boundaries:** this intentionally installs pip and whatever
bootstrap dependencies that Python supplies (e.g. setuptools), console scripts
and, on Debian, copies dependency wheels into the new prefix's share folder.
It is not latest-pip selection, an arbitrary wheel/index install or an
existing-prefix upgrade. The local inspected ensurepip implementation requests
`install --no-cache-dir --no-index --find-links <private-temp>`; it does not
download resources. Missing ensurepip/wheels fails, never invokes apt,
ensurepip installation, a package download, PATH fallback or repair. HOME and
all temp variables point inside retained `.pkm-pip-bootstrap/{home,scratch}`;
the bootstrap interpreter uses `-B`, its ordinary pip child inherits
`PYTHONDONTWRITEBYTECODE=1`. No `/tmp` destination is selected by this workflow.
Selected Python/package code still has OS-user permissions: this is not
network enforcement, an atomic filesystem sandbox or an exclusion guarantee.
There is **no installation rollback**. Cancellation/timeout stops only the
direct process; installer descendants are not guaranteed terminated. Interrupted
work can leave partial installed files without registration; a crash after CAS
can leave the completed catalog entry. Inspect files and catalog explicitly,
do not assume cancellation removed files, and do not automatically replay.
The ordinary existing package refresh retains its **separate** explicit approval
and does not bootstrap pip itself.

`tests/test-bundled-pip-creation.js` executes genuine old 4.0.22 venv creation
and the new native adapter against only private fixtures. Both install
**pip 20.0.2** from this host's already present Debian wheels, with real
prefix-local imports. The new prefix then successfully uses Next's real
`refreshPipPackageSnapshot`, solving the previous missing-pip obstacle.
The original no-pip base identity/config/package metadata remains unchanged.
Other cases exercise native decline, trust loss, default-disabled menu,
unchanged original no-pip creation, cancellation **before bootstrap** with
retained unregistered prefix/receipt, no existing-target replay and refusal
of conda provider bootstrap. This does not qualify live installer-descendant
cancellation, absent-resource hosts, latest pip, arbitrary package installation,
uninstallation, production or an installed VSIX. No Code window was used.

```sh
B=.migration-test-work/environment-bundled-pip/build
node node_modules/typescript/bin/tsc -p tsconfig.json --outDir "$B" --incremental false
PKM_ENV_AUTHORITY_BUILD="$PWD/$B" node --test tests/test-bundled-pip-creation.js \
  tests/test-local-python-management.js tests/test-local-environment-upgrade.js
```

Compile succeeded; new focused cases **3/3**, combined management/upgrade
regression **32/32**. Logs:
`.migration-test-work/environment-bundled-pip/{compile,focused,regression}.log`.
The build and private fixtures may be cleaned afterwards; compile first to
reproduce. Both permanent Python deletion entries remain disabled, and this
is unrelated to restoring the old destructive move.

## Interactive package comparison: old hide/sort controls, current source only

The actual 4.0.22 VSIX's `extension/src/webview/panel/30-environments.js`
implements `cmp-hide-same`, `sortCmp` and `cmpSortRows`: hide unchanged rows and
cycle each Package/A version/B version/Change type column through ascending,
descending and original order. Next already computed the same five statuses
but exposed only a static Markdown comparison. This was a missing executable
interaction, not a missing package-analysis algorithm.

The existing experimental Environments menu now includes **Browse and filter
Python package comparison** (`src/ui/next-python-packages.ts`). Select A and B,
then use the native QuickPick controls to hide/show unchanged packages and cycle
the four sorts. Select a package to inspect both versions, its change status,
capture times and historical/current-at-read prefix metadata state; Escape
closes. Names, versions and statuses are searchable using Code's native fuzzy
QuickPick filtering, not the old package-table substring filter. Reopening the
picker after a selection/control resets its search text; this is not identical
webview/layout parity. Historical missing-prefix snapshots remain browseable,
explicitly labelled historical; all-unchanged comparisons can hide every row
while retaining the show-unchanged control. Reopen comparison to reload data;
the session is a saved comparison, not a live package monitor.

The old **Compare registered Python package snapshots** Markdown report remains
unchanged. This new interaction only reads saved snapshots: no Python/manager
execution, package refresh, clipboard script, installation, download, merge,
deletion, original move, catalog write or Workflow approval. Existing checks
stop row delivery if trust/catalog changes while a picker is open. Existing
experimental gating and the fresh-isolated-trial entry remain; no production
default or root-adoption route changes.

`tests/test-python-comparison-interaction.js` creates real private no-pip venvs
with `/usr/bin/python3`, seeds controlled `.dist-info/METADATA` records, and
uses each real prefix's `importlib.metadata` to construct fixture snapshots.
These are metadata fixtures, not downloaded/installed package payloads or live
pip-query qualification. It executes **the actual old VSIX manager and webview
functions**, checks all five statuses, drives 16 native-adapter picker rounds,
and compares every hide/sort state against old `cmpSortRows` and
`renderCmpBody`. It also checks unchanged prefix identities/metadata and snapshot
bytes, old Markdown delivery, historical source absence, an empty changed-only
view, cancel, trust revocation and concurrent catalog edits. The native API is
an offline test adapter; no private Code window or installed VSIX was used, and
Code's fuzzy-filter implementation itself is not claimed tested.

```sh
B=.migration-test-work/environment-comparison-interaction/build
node node_modules/typescript/bin/tsc -p tsconfig.json --outDir "$B" --incremental false
PKM_ENV_AUTHORITY_BUILD="$PWD/$B" node --test tests/test-python-comparison-interaction.js

unzip -p personal-knowledge-4.0.22.vsix extension/dist/servers/pyenvs.js \
  > .migration-test-work/environment-comparison-interaction/old-pyenvs.cjs
PKM_ENV_AUTHORITY_BUILD="$PWD/$B" PKM_TEST_PYTHON=/usr/bin/python3 \
PKM_TEST_LEGACY_PYENVS="$PWD/.migration-test-work/environment-comparison-interaction/old-pyenvs.cjs" \
  node --test \
  --test-name-pattern='real isolated Python metadata|comparison stays|cancel, catalog|real existing pip|real allocated-size|missing pip|saved pip' \
  tests/test-python-comparison-interaction.js tests/test-local-python-packages.js
```

Final compile succeeded; new tests **3/3**, combined selected regression
**7/7** (four existing installed-pip/version-size/cache cases, using the already
installed system pip with private venvs and no installation). The real conda
inventory case is intentionally outside this selector; this is not a whole
file/full-suite result. Evidence:
`.migration-test-work/environment-comparison-interaction/{compile,compile-after,compile-final,focused,regression}.log`.
Initial compile reported TS7053 on status-rank indexing; its local map typing
was corrected. An attempted previous-source baseline could not load
`runtime/local-python-packages.js`; `baseline-unavailable.log` records that
dependency failure, **not a behavioral regression proof**. No historical pin
or build was changed. The private build/fixtures may be cleaned afterwards:
compile first to reproduce. Permanent Python deletion remains disabled; Next
copy-and-rebind still does not implement old destructive move semantics.

## Cache-free conda activation: a separate old interaction, not move parity

The shipped **4.0.22** `pyenvMigrate` computes `destRoot/slugify(name)` (falling
back to ID), rejects an existing destination, moves venv/uv with path rewrites,
and clones conda before removing its source. Its host uses the configured
`personalKnowledge.environmentsPath`, defaulting to the legacy managed location.
Next's current reviewed migration copies into a newly generated private prefix
and rebinds the same ID while preserving the original. **These are different
filesystem semantics, not original move parity.** The old Environments Root
setter can also rebuild the derived MCP runtime; this change does not invoke it,
change that setting, widen copy destinations or re-enable source deletion.

Instead, this slice restores a concrete separate old interaction: **activating
an existing registered conda prefix does not require its package archives**.
The old `pyenvActivateCommands` returns the installation's Bash hook and
`conda activate <prefix>` without a cache selection. Next previously routed
activation through the same mandatory archive-cache picker as clone/recovery;
users whose usable prefix remained after cache removal could not open the
reviewed terminal.

`src/ui/next-conda-lifecycle.ts` now uses the existing native query-only manager
handle for **Activate registered conda in private Bash terminal**. It asks only
for the already-installed executable, not an archive directory. A separate
native approval discloses the exact `shell.bash hook` query, prefix, tool and
private offline HOME/config/cache before spawning it. Declining runs no tool and
opens no terminal. The existing second modal still reviews the returned hook
and activation scripts before opening clean Bash; selection/query approval
alone is not terminal or Workflow approval. Trust, tool identity, current
catalog and prefix snapshots are revalidated at their existing boundaries.
Clone and recovery still require their explicit cache; no provisioning handle,
download, installation or environment mutation is added.

The existing prefix constraints remain: canonical registered non-base conda
Python, bounded owned metadata/tree and exact archive digests in installed
records. **The archive files themselves need not exist for activation**.
Base/tool-containing prefixes, record repair and arbitrary package operations
are not newly supported.

The new `tests/test-conda-activation-interaction.js` loads the actual 4.0.22
manager from the shipped VSIX. Both its activation commands and the Next native
adapter execute a real Bash/Python fixture, then deactivate and verify the
original prefix and `CONDA_SHLVL=0`. No cache exists or folder picker succeeds.
The selected conda-hook executable and shell function are controlled fixture
implementations, **not a real installed conda manager**; these tests establish
the cache-free interaction/composition, not new conda installation qualification.
They also verify query decline before spawning, activation decline after query,
trust loss, catalog drift, unchanged prefix/catalog, and retained clone/recovery
cache prompts. No private Code window or production environment was used.

```sh
node node_modules/typescript/bin/tsc -p tsconfig.json \
  --outDir .migration-test-work/environment-cache-free-activation/build --incremental false
PKM_ENV_AUTHORITY_BUILD="$PWD/.migration-test-work/environment-cache-free-activation/build" \
  node --test tests/test-conda-activation-interaction.js \
  tests/test-local-python-management.js tests/test-local-environment-upgrade.js
```

Result: **32/32 passed** (three new interaction cases plus 29 existing
management/upgrade cases, including the real old move oracle and both permanent
deletion refusals). Logs:
`.migration-test-work/environment-cache-free-activation/{compile,focused,baseline}.log`.
The same new tests against the unchanged previous source build at
`.migration-test-work/conda-crash-frozen-v4-81a496d7-0cdb-41c0-90ea-50d9e6430ea9/root-build`
produce **two failures / one pass**: activation presents two pickers instead of
one and cannot reach hook approval without a cache; clone/recovery still pass.
That frozen source build was only read, not updated or treated as an installed
VSIX. To reproduce this negative baseline, use it as `PKM_ENV_AUTHORITY_BUILD`
and run only `tests/test-conda-activation-interaction.js` (expected exit 1).
The build may be cleaned afterwards; compile first to reproduce. The command
remains default-off experimental and fresh-isolated-trial-only. Ordinary
production activation and installed VSIX qualification are unchanged.

## Both permanent-deletion paths disabled after mount/path-race review

The shipped **4.0.22** UI has two distinct entry points, not two script previews:
`deleteEnvScript` sends `envDeleteScript`, whose host copies script text without
executing it. `deleteEnv` opens a danger modal with **Also delete the environment
files from disk**, initially unchecked, and sends `envDelete` with the chosen
`removeFiles` boolean. `pyenvDelete(id, false)` unregisters only; `true` actually
removes an eligible folder before unregistering. The focused old-oracle test
now executes both shipped UI callbacks and the actual shipped manager; its
previous “deletion only generates script” title was misleading and is corrected.

The prior source attempt's **26/26** fixture tests did **not** establish safe
external deletion. Those results and failure logs remain under
`.migration-test-work/environment-external-deletion/`; their qualification is
withdrawn, not replaced by new pins. In particular, “does not follow child
symlinks” was inadequate: a checked directory can subsequently become a symlink
or bind mount before path-based traversal.

Current source removes both **Permanently delete external registered Python
files and unregister** and **Permanently delete synthetic Python files and
unregister** from the menu. Direct/stale UI dispatch only shows a disabled
warning. Both `deleteExternalPythonFiles` and `deleteSyntheticPythonFiles`
unconditionally refuse before any
recursive removal, receipt or catalog mutation, regardless of previous consent
or plan. **Unregister (keep all runtime files)** is unchanged. No quarantine,
metadata restoration or clipboard script is presented as equivalent deletion.
Historical external requested receipts remain read-only: absent/partial paths
are observations, not completion, recovery authority or automatic replay.
The unsafe recursive-removal implementation has been removed, not merely gated
by an optional flag. Existing synthetic quarantine and explicit restore still
retain filesystem contents and their receipt/history checks; neither erases
files or automatically retries.

The read-only planner now rejects mounted target roots and nested directory/file
mount points using `/proc/self/mountinfo`, including escaped paths and
**same-device bind mounts**. It never infers absence of mounts from `st_dev`.
Malformed/missing mount data fails closed. This is a snapshot only: checking it
before/after review cannot atomically exclude a later mount or parent-directory
redirection, so a successful plan still grants **no deletion authority**.

Actual unprivileged user+mount-namespace tests, on **Node v22.23.1**, demonstrate:

- An already-mounted nested bind directory returns `EBUSY` and preserves its
  sentinel on this runtime; it is not claimed that every static bind immediately
  loses its contents.
- After the real nested `rmdir` returns `ENOTEMPTY`, a deterministic test hook
  installs an actual bind mount before Node reopens that path for traversal.
  `st_dev` remains equal to the parent. The mounted source's sentinel is really
  erased before final `EBUSY`.
- At the same gap, replacing the directory with a symlink also really erases
  the separate fixture sentinel before final `ENOTDIR`.

The hook schedules real filesystem changes at a proven check/use gap; it is
not a naturally scheduled stress race or an installed Electron result.
All mounts and victims are newly created checkout-local fixtures, within a
private mount namespace (`mount --make-rprivate /`); no host privilege,
production files, downloads or private Code window are used.

The earlier synthetic-only mount-table preflights and warning were insufficient
for the same demonstrated race, so that path is now disabled too. Production
legacy handling and manual scripts remain unchanged and are not certified by
these tests.

### Existing native capability investigation

The project already uses installed Python/standard-library `ctypes` for native
calls in `next-server/src/rename-no-replace.ts`, `resources/next_mcp_subreaper.py`
and `src/runtime/linux-git-supervisor.ts`. The rename helper uses
`renameat2(RENAME_NOREPLACE)` on path names; it prevents replacing the destination,
not compare-and-delete of the approved source inode. The existing root writer
fence passes directory descriptors to a cooperative flock holder; it does not
exclude noncooperating mounts/path replacement. These files were inspected,
not changed. No existing directory-fd deletion backend was found in the
project source; no compiler, addon, SDK or Python package was installed.

`tests/linux-delete-fd-probe.py` is a **fixture-only native investigation**, not
a product helper or execution grant. With the already installed
`/usr/bin/python3`, isolated user/mount namespaces really verify:

- Linux `openat2` with `RESOLVE_NO_XDEV | RESOLVE_NO_SYMLINKS |
  RESOLVE_BENEATH` and `O_NOFOLLOW` refuses a same-device bind with **EXDEV (18)**
  and a symlink directory with **ENOTDIR (20)** on this machine.
- A held root directory fd retains its exact `(dev, ino)` after the root path
  is replaced by a symlink. Relative unlink affects the approved original
  directory, not the symlink victim.
- That does **not** identity-bind final named removal: after a matching
  `fstatat`-style identity check, replacing the empty root directory and calling
  fd-relative `rmdir` really removes the **replacement inode**, leaving the
  approved inode at its retained path.
- `unlinkat(root_fd, "", AT_REMOVEDIR | AT_EMPTY_PATH)` really returns
  **EINVAL (22)**; the tested Linux API does not provide fd-only directory
  removal through this flag combination. `openat2` resolve flags apply to
  opening, not an atomic identity predicate on subsequent unlink/rename.

Thus the primitives are available, but merely composing them with a last inode
check or existing no-replace rename does not meet exact-target identity and
concurrent-replacement requirements. Leaving an empty root, moving an unrelated
replacement or retrying/rolling it back is not successful legacy deletion.
No production-safe deletion backend is admitted, and **both APIs stay disabled**.

Re-enabling permanent deletion requires an implemented, reviewed traversal
backend anchored to directory descriptors, with mount-transition rejection
(including bind mounts), symlink/name-redirection handling and verified removal
semantics. Node's current path-based `fs.rmSync` and separate mount/inode
snapshots cannot provide that guarantee. The exact-identity final-removal issue
also remains unresolved by the native primitives tested here.

Reproduce from the extension checkout (compile first; the isolated build may
be cleaned afterwards):

```sh
node node_modules/typescript/bin/tsc -p tsconfig.json \
  --outDir .migration-test-work/environment-fd-delete/build --incremental false
PKM_ENV_AUTHORITY_BUILD="$PWD/.migration-test-work/environment-fd-delete/build" \
  node --test tests/test-local-python-management.js tests/test-local-environment-upgrade.js
PKM_ENV_AUTHORITY_BUILD="$PWD/.migration-test-work/environment-fd-delete/build" \
  PKM_TEST_PYTHON=/usr/bin/python3 PKM_TEST_LEGACY_VSIX="$PWD/personal-knowledge-4.0.22.vsix" \
  node --test --test-name-pattern='original checked delete|disabled synthetic API|restarted worker refuses' \
  tests/test-local-python-deletion.js
```

The first native probe expected only ELOOP for the symlink, but the actual
`O_DIRECTORY | O_NOFOLLOW` combination returned ENOTDIR. Its original failing
run remains in `.migration-test-work/environment-fd-delete/lifecycle.log`;
the probe now accepts only the two legitimate refusal errnos, not arbitrary
errors or fallback execution. The native syscall results above are from the
subsequent successful run (`native-fd.log`).
Final validation: **29/29** management/upgrade cases and **3/3** focused
synthetic-deletion cases passed. Logs:
`.migration-test-work/environment-fd-delete/{compile-final,lifecycle-final,
deletion-final}.log`; the Python probe also passed an explicit AST syntax check.
This is **current-source offline qualification of the refusal and primitive
limits**, not restored permanent-deletion parity, production cutover or
installed UI qualification.

## Ordinary legacy profile Packages integration (Linux, source qualification)

The ordinary Environments panel does **not** require the Next catalog import
gate. The existing host initializes `src/servers/pyenvs.ts` from
`context.globalStorageUri.fsPath/environments`; it reads that profile's
`registry.json` and `<id>.packages.json` directly. Knowledge Root adoption does
not import or move this registry. Reuse requires the same extension ID and
original user-data/profile/globalStorage context; the environment file root
(`personalKnowledge.environmentsPath`, normally `~/pkm-envs`) is separate.
`personalKnowledge.experimental.localEnvironmentUpgrade` remains machine-scoped,
restricted and **default false**. Its metadata import and fresh-trial management
UI are not prerequisites or replacements for the ordinary legacy panel.

A concrete ordinary **Packages / Refresh** failure was reproduced: an existing
conda prefix and associated installation are retained, but the desktop/remote
Extension Host PATH does not contain `conda`. Both the shipped 4.0.22 service and
the pre-change current service return `spawn conda ENOENT`. This is a demonstrated
compatibility gap, not evidence that the upgrade introduced a new regression.

`src/servers/pyenvs.ts` now preserves the normal PATH command whenever any PATH
candidate exists, including non-executable files, failing wrappers and broken
symlinks; permission/inspection errors also retain the original command.
Only when PATH genuinely lacks the command, on Linux with an absolute registered
prefix, package queries use an already-existing executable `bin/conda` or
`condabin/conda` from the associated base installation. A prefix immediately
inside `envs` uses its parent installation; a base prefix uses itself.
If those logical locations are genuinely absent and the registered prefix is a
symlink alias, the same lookup may use its physical prefix's installation.
The registered prefix, interpreter, ID and CLI `-p` argument remain verbatim;
only the manager executable is located through the physical prefix.
The existing `list --json -p <exact registered prefix>` arguments, timeout,
normalization and cache semantics are unchanged. Failed queries do not overwrite
the prior package cache. An associated candidate is skipped only if `lstat`
reports ENOENT. EACCES, ENOTDIR, ELOOP, non-regular candidates, and errors after an
existing candidate is found (including a dangling executable symlink) are
returned as `conda list failed: <actual error/path>` through the ordinary
Packages UI. They do not fall through to another manager, a canonical-prefix
lookup, or a misleading bare-command ENOENT. No manager is downloaded, installed or repaired, and
create/remove/activation/other manager-selection paths are unchanged. This is
legacy trusted-manager execution, not a new sandbox or atomic path-identity
guarantee; an arbitrary manager or its plugins are not independently contained.

`tests/test-environment-conda-profile.js` uses a genuine isolated no-pip Python
venv and a registry generated by the **actual 4.0.22 VSIX** service, then copies
that profile into an isolated active globalStorage. Its conda manager is a
**controlled Bash/Python, local-metadata-only fixture**, not a real conda
installation. It runs the current `30-environments.js`, actual host `envPackages`
case and `00-core.js` reply route, with Next import disabled. The UI receives the
retained prefix's package list; cached viewing does not execute the tool, and
explicit Refresh does. Both associated executable locations, PATH precedence,
wrapper failure, EACCES, dangling PATH symlinks and absent managers are covered.
IDs, unknown registry fields and registry bytes remain unchanged by these
package queries; normal dashboard version/size refresh is a separate operation.

The initial pre-change focused result was **2 passed / 1 failed**, with the first
case failing on the product's ENOENT. After that initial fix, the three focused
cases and existing ordinary dashboard Refresh test passed **4/4**. Existing
real-pip package comparison and allocated-size/version regressions against 4.0.22
passed **2/2**:

```sh
mkdir -p .migration-test-work/environment-ordinary-profile
node node_modules/typescript/bin/tsc -p tsconfig.json --outDir \
  .migration-test-work/environment-ordinary-profile/build --incremental false
PKM_ENV_AUTHORITY_BUILD="$PWD/.migration-test-work/environment-ordinary-profile/build" \
  node --test tests/test-environment-conda-profile.js tests/test-environment-refresh.js
unzip -p personal-knowledge-4.0.22.vsix extension/dist/servers/pyenvs.js \
  > .migration-test-work/environment-ordinary-profile/old-pyenvs.cjs
PKM_ENV_AUTHORITY_BUILD="$PWD/.migration-test-work/environment-ordinary-profile/build" \
PKM_TEST_PYTHON=/usr/bin/python3 \
PKM_TEST_LEGACY_PYENVS="$PWD/.migration-test-work/environment-ordinary-profile/old-pyenvs.cjs" \
  node --test --test-name-pattern='real existing pip|real allocated-size/version' \
  tests/test-local-python-packages.js
```

Logs: `.migration-test-work/environment-ordinary-profile/{compile-before,before,
compile-after,after,ordinary-final,package-regression}.log`. The isolated build
and extracted oracle are cleaned after validation: compile before rerunning,
not just the test command. No production profile, network/package installation,
Code window, Root/Chat/Collaboration files or historical pins were used or
modified. This closes a **normal production-call-path source gap**, not a new
experimental install action. At this source checkpoint, installed profile-upgrade UI acceptance was still
unqualified. The later installed check below does not qualify a real conda installation.
The Next production switch remains unchanged, and its unsafe external/synthetic
permanent deletion is not reopened.

### Associated failure review and retained prefix aliases

The subsequent review reproduced a real 0600 associated manager incorrectly
reported as `spawn conda ENOENT`. The new ordinary UI case failed before the
correction and now passes. In the isolated fixture, it checks the non-executable
file, an inaccessible 000 ancestor directory (**actually exercised as UID
1009**, not privileged simulation), a cyclic executable symlink (ELOOP), a
non-directory ancestor (ENOTDIR), a directory instead of the executable, and a
dangling executable symlink. A valid secondary `condabin/conda` is deliberately
present during the latter failures: it must not execute. Each failure is
delivered through the real host case and ordinary panel reply handler, preserves
the prior cache byte-for-byte and leaves the registry unchanged. Restoring the
fixture manager makes explicit Refresh succeed without re-registration.

The next ordinary compatibility repair retains old registered prefix aliases.
The actual 4.0.22 service accepts an isolated prefix symlink with its manager on
PATH; the pre-repair current fallback fails ENOENT when PATH lacks that manager.
The new case now passes through the ordinary Packages UI using the associated
physical installation, still passing the **original alias** as `-p`. Neither
the registered path nor environment files are migrated/rebound. This is not a
new experimental command, install action, or activation implementation.

Current focused plus existing dashboard Refresh results are **6/6**, and the
existing real-pip comparison/metadata regression remains **2/2**. Reproduce the
ordinary cases after compiling (the validation build is cleaned afterwards):

```sh
mkdir -p .migration-test-work/environment-ordinary-permissions
node node_modules/typescript/bin/tsc -p tsconfig.json --outDir \
  .migration-test-work/environment-ordinary-permissions/build --incremental false
PKM_ENV_AUTHORITY_BUILD="$PWD/.migration-test-work/environment-ordinary-permissions/build" \
  node --test tests/test-environment-conda-profile.js tests/test-environment-refresh.js
```

Logs: `.migration-test-work/environment-ordinary-permissions/{compile-before,
before,compile-after,after,alias-before,compile-reviewed,ordinary-reviewed,
package-regression}.log`. This remains current-source, isolated-fixture
qualification, with the controlled manager and installed-profile/Code limitations
above unchanged. The private window was not used; deployed environment/profile
files, default gates, Root/Chat/Collaboration files and historical pins were not
changed.

### Full ordinary profile/UI connection and installed handoff preparation

The next check starts at the real ordinary UI rather than calling Packages
directly. `tests/helpers/ordinary-environment-profile-fixture.js` produces a
**new, project-local** standard
`user-data/User/globalStorage/uone.personal-knowledge/environments` using the
actual 4.0.22 service. It preserves two registrations and old per-ID caches:
a genuine isolated Python venv using the **already installed system pip 20.0.2**
(no pip installation), and a controlled local-metadata-only conda prefix.
The venv uses system site packages read-only; its local dist-info fixture is
reported by real pip as `retained-fixture`. HOME, pip configuration/index/version
checking, bytecode and cache paths are isolated for these test queries.
The fixture also contains an untouched Knowledge Root **directory placeholder**,
not a claim that a real Root database upgrade has been exercised.

`tests/test-ordinary-environment-profile-ui.js` executes the actual old/current
`envListForUi`, ordinary List/Packages host cases, metadata refresh/sweep
functions, and the current `globalStorageUri.fsPath` initialization expression.
Both stages reuse the **same registry directory**, without copying/importing it.
The actual 60-init request, 00-core replies, 30-environments panel and category
tree functions run in headless Chromium. Only unrelated icon/privacy/shell
services are fixture adapters. `tests/ordinary_environment_profile_ui.py`
clicks real tree headers and card/package/dashboard buttons; its locator helpers
can also accept an installed webview surface.

The old ordinary UI can read its preserved cache with no manager execution;
its explicit conda Refresh displays ENOENT when the host PATH lacks conda.
The current ordinary UI finds the associated fixture manager and refreshes;
EACCES is visible without overwriting the cache, cached viewing works after
restoring permissions, and dashboard Refresh preserves both registrations.
Genuine pip cached viewing and explicit refresh also succeed. IDs, registered
paths, descriptions/unknown fields and the separate Root directory are retained.
Normal metadata Refresh updates its size/version metadata, so this is not a
claim that the registry is always byte-for-byte read-only.

**7/7** pass: the full real-DOM journey plus the six previously reviewed ordinary
tests. No additional production source defect was found in this complete
offline list-to-card connection. The concrete remaining integration blockers
at that offline checkpoint were that Root's earlier frozen v8 predated the latest Environment fixes and
ordinary Environments had **not yet been qualified in an installed same-profile
old→current Root upgrade**. Source/browser success must not be assigned to v8,
Room 857 or any other frozen installed candidate.

```sh
mkdir -p .migration-test-work/environment-ordinary-root-ui
node node_modules/typescript/bin/tsc -p tsconfig.json --outDir \
  .migration-test-work/environment-ordinary-root-ui/build --incremental false
PKM_ENV_AUTHORITY_BUILD="$PWD/.migration-test-work/environment-ordinary-root-ui/build" \
PKM_BROWSER_PYTHON="$(command -v python)" \
  node --test tests/test-ordinary-environment-profile-ui.js \
  tests/test-environment-conda-profile.js tests/test-environment-refresh.js
```

Requires an existing native Python Playwright interpreter and its already
installed Chromium (observed Python 3.11 and Chromium 1228); a missing dependency
is a refusal, never an automatic download. The browser has isolated HOME/XDG
directories and uses `TMPDIR=.` from its private project-local runtime cwd:
absolute long Unix singleton socket paths exceeded Linux's limit. The first
browser failures were fixture issues (unzip omitted from the deliberately
restricted PATH, the old host's MCP namespace adapter, the singleton socket
length, and pip's hyphen-normalized name), not product regressions. Logs:
`.migration-test-work/environment-ordinary-root-ui/{compile,initial,diagnostic,
bridge-diagnostic,dom-progress,final,relative-runtime,final-verified}.log`.

The reusable CLI prepares only a **new direct child** of the canonical project
migration workspace, refusing existing targets or redirected parents:

```sh
node tests/helpers/ordinary-environment-profile-fixture.js \
  .migration-test-work/ordinary-env-installed-NEW-UNIQUE-ID
```

The prepared old registry/cache receipt is retained at
`.migration-test-work/ordinary-env-installed-ready-85b2ada3-9ce5-43c5-b3ad-17cf840322bf/fixture-receipt.json`.
`.migration-test-work/environment-ordinary-root-ui/installed-contract.json`
records source/compiled hashes, the real old VSIX hash, dependencies and exact
installed assertions. It is explicitly a **fixture/source contract, not a
frozen VSIX**. Root coordination requires a fresh **standard** candidate with
these Environment changes, not a Room/rehearsal overlay or a relabeled v8.
The formal queue is Root current journey → Environment installed → d3 Room 857;
no Code instance may start before Root's exact cleanup/handoff. Environment must
then clean up exactly its own processes/window and hand off to d3. Default Next
switch/import gates, production profiles, Root/Chat/Collaboration source and
historical pins remain untouched by this preparation.

### Standard stable candidate and actual ordinary installed qualification

The subsequent private snapshot has source SHA256
`d5018e4eee597e36fb32ad2d846ecf341beaa0746c0279ab10eefb75ed40fd55`.
Its first candidate was experimental/prerelease and was **not** used for this
ordinary qualification. A separate copy went through the real stable
`node scripts/package-extension.js --prebuilt` entry, including production
staging, normal dependency-inclusive VSCE packaging and the actual package
validator. No hand overlay or `--no-dependencies` was used.
The immutable standard artifact is
`.migration-test-work/environment-ordinary-root-ui/release-8b8ece0a-ed42-4b41-9fd3-1e7d01b3e350/build/personal-knowledge-4.0.900.vsix`,
SHA256 `7224e3db4644209c751d42c9324a16c5ee89ad2d68b479cd2bafe4faf31f27b5`.
The repository manifest remains 4.0.22; historical pins were not changed.
All **4943** pinned payload entries and standalone dependency/Chat/Sync,
ws/JSONC/MQTT/gateway, worker and independent service lifecycle validations
passed. `--prebuilt` skips the repeated build and release test group, so this
is **not** a claim that the complete `npm package` release gate ran.

The first stable validator attempt failed on the pre-existing Unix IPC path
limit with a long private HOME. Its failed `standard-package.log` is retained.
The successful `standard-package-project-home.log` uses the canonical project
directory as HOME (endpoint length 99 bytes), and its own project-local
TMPDIR/npm cache; no `/tmp`, production HOME or service source fix was used.

After Root's formal exact cleanup/handoff, the independent ordinary installed
controller used Code 1.143/Electron 43, its own private PID/user/network
namespace, display/CDP, profile, extensions and driver. The first original
4.0.22 host really activated and retained the Root/registry, but Python
Playwright 1.61 could not expose its OOPIF: this is not a product UI failure.
The existing, explicitly authorized read-only
`.migration-test-work/collaboration-python-164/bin/python` reports 1.64.1 and
exposes the real webview. A second actor attempt incorrectly selected Automation
instead of the ordinary **Tools** workspace; both failed fixtures/logs remain.
The actor now waits for network idle and clicks the actual Tools button before
Environments, never forcing a hidden tab.

Two fresh journeys then passed **4.0.22 → stable 4.0.900 → restart 4.0.900**.
The final fixture is
`.migration-test-work/ordinary-env-installed-final-a1b2f363-71e7-4fe9-bf27-959bb4e3ba65`.
The genuine installed host uses the same original Root path and VS Code
profile registry throughout, preserving both old IDs, prefix/python paths and
unknown `customReference` fields. The actor actually clicks ordinary
List/tree/card/Packages, retained caches, explicit conda and real-pip Refresh,
and dashboard Refresh. Upgrade and restart also chmod **only the owned fixture
manager** to 0600: actual UI Refresh reports EACCES with that tool's full path,
cache bytes and manager-call bytes remain unchanged, and permissions are restored
in `finally`. Cached recovery executes no tool; another explicit Refresh adds
exactly one manager execution. No re-registration or environment copying occurs.

All three hosts report the local Environment upgrade gate **false**, and no
Next local-environment directory is created. This qualifies the **ordinary
installed legacy Environments path** in the new standard package. It is not
Next same-root adoption, a real conda distribution/install, a complete existing
Root database migration, production deployment, or qualification of the unrelated
Root/Chat/Room candidate. The conda manager is controlled local metadata;
pip really executes the existing system pip in an isolated venv.

Driver files (full paths):

- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/ordinary-environment-installed-controller.cjs`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/ordinary-environment-installed-host.cjs`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/ordinary_environment_installed_actor.py`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/helpers/ordinary-environment-profile-fixture.js`

The related ordinary product/source regression files are:

- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/src/servers/pyenvs.ts`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/test-environment-conda-profile.js`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/test-ordinary-environment-profile-ui.js`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/ordinary_environment_profile_ui.py`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/docs/design/local-environment-catalog.md`

The actual authorized command was:

```sh
PKM_BROWSER_PYTHON="$PWD/.migration-test-work/collaboration-python-164/bin/python" \
  node tests/ordinary-environment-installed-controller.cjs --run-installed \
  > .migration-test-work/environment-ordinary-root-ui/installed-final.log 2>&1
```

This is an opt-in test driver, **not a product experimental entry point**.
It requires a fresh fixture and a prepared standard-package contract with status
`STANDARD_PACKAGE_READY_INSTALLED_PENDING`, verified package hashes and formal
private-window handoff. It refuses already-started fixtures. The retained final
contract is now `STANDARD_STABLE_ORDINARY_INSTALLED_VERIFIED`; do not reset its
status or rerun against that completed fixture.

`installed-results.json` records the three real hosts/UI results, and
`installed-cleanup-receipt.json` records controller/unshare exit 0, **75**
captured private-namespace processes with `remaining=[]`, and exact argv/cwd
host scanning of all four owned fixture UUIDs: `found=[]`, **214** fully readable,
**600** partially unreadable, **0** races, excluding scanner ancestors.
Unreadable processes do not establish system-wide exclusivity. Environment
formally handed the window back to d3; d3 acknowledged exclusive possession
for its independent Room 857 run. Environment will not reopen Code.
No production environment/profile, Root/Chat/Collaboration source, historical
pins, default Next gates or unrelated fixture was modified.
The final post-installed offline rerun is also **7/7**:
`.migration-test-work/environment-ordinary-root-ui/post-installed-focused.log`.
The isolated source validation build is cleaned; recompile with the earlier
command before rerunning those tests. Frozen packages, source receipts and
failed/successful installed fixture evidence remain intact.

### Initial Next owner → original profile → ordinary cached Environments adapter

The next user-requested slice follows the **actual consumer boundary**, not an
experimental Environment menu. Root/Chat coordination confirmed that
`next-server/src/managed-client-host.ts::startAdoptedRootUnifiedHost` supplies
the real in-process native owner and `ownerResourceContext()`, but its fixed
`ManagedClientHost.invoke` operations do **not** include Environments.
`src/extension.ts` ordinary `envList`/`envPackages` still call the legacy
globalStorage subsystem. Neither a prelaunched MCP socket/token nor the
existence of a Storage lease authenticates or grants access to that profile.
The normal production activation is **not changed by this slice**.

New adapter:
`/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/src/runtime/ordinary-environment-owner.ts`.
`attachOrdinaryEnvironmentsToOwner({owner, hostSession, authority,
onCloseError})` is a trusted embedding API, not a public token-authenticated
entry. Its `handleMessage` understands the **existing ordinary** `envList` and
`envPackages` request/reply protocol. An authorized owner-side dispatcher can
use `respond(await adapter.handleMessage(msg))`; it must retain that bound
adapter and must not fall back to a legacy writer on denial. No shared
`extension.ts`, managed host, Root adoption, Chat or Room implementation was
modified to claim a default production switch.

The adapter requires:

- The live private owner resource capability and its actual original
  `storage.workspaceRoot()`.
- A real `createOwnerHostSessions(...).open(...)` session, with matching
  workspace, synchronous `assertCurrent("environment")`, revocation signal
  and session child-close registration. Current sessions supply
  `signalFor("environment")`; the adapter captures it while authorized and
  retains compatibility with the earlier whole-host signal interface.
- A separate original-profile authority: `workspaceId`, `actorId: local:owner`,
  canonical `knowledgeRoot` and `globalStorageDirectory`,
  `scope: ordinary-environments:read-cache`, its own AbortSignal and synchronous
  `assertCurrent(binding)`. Host/environment session checks do not replace this
  profile grant. A trusted transport issuer must supply those fences; a hostKey
  or MCP nonce is not proof of identity.

Owner, session, profile scope, original directory identity and Root binding are
checked before reading and before publishing. The adapter holds the original
`environments` directory FD and opens registry/cache files through that FD,
with `O_NOFOLLOW` and `O_NONBLOCK`. Redirected/replaced profile directories,
cache symlinks, FIFOs, malformed/ambiguous registries and nonregular/oversized
metadata are refused. Reads are bounded at 2 MB, file-change checks surround
reading, and the selected ID/prefix/python/manager binding is checked again
after a cache read. Registered interpreter-prefix aliases are preserved as
literal metadata; no interpreter is probed or rebound.

Both owner and session register the adapter's child-close barrier. Revocation,
connection loss and owner shutdown stop new admission and reject queued result
publication. Close waits for all queued reads to settle, then closes the FD and
unregisters child barriers. A newly registered session with the same hostKey
cannot revive the old adapter. It never closes Storage or terminates an owner.

This initial read-only grant serves original registry rows and **existing package caches**
directly. It never calls singleton `initPyenvs`, copies/imports a registry,
creates a Next catalog, invokes a manager or overwrites cache/registry bytes.
Explicit package Refresh returns an ordinary visible error; metadata Refresh
is rejected. Missing/unreadable/malformed caches retain their real errors,
including EACCES and the original file path, rather than executing a manager
or pretending Refresh succeeded. This deliberately does **not** grant
activation, installation, removal or package/metadata Refresh. The subsequent
finite Refresh extension below adds separate execution/write permission; the
read-cache grant alone still does not authorize it.

Focused tests:

- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/test-ordinary-environment-owner.js`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/ordinary_environment_owner_ui.py`

**4/4 new cases**, combined with the existing seven ordinary regressions:
**11/11 passed**, with current isolated Root and Next TypeScript builds passing.
The integration creates a disposable minimal original Root and uses genuine
`adoptLegacyRootInPlaceExperimental` → `startAdoptedRootUnifiedHost` →
`ownerResourceContext` → **actual host-session module** → this adapter.
The original profile/cache comes from the actual 4.0.22 API. Real headless
Chromium runs current ordinary 60-init/00-core/30-environments and clicks the
existing tree/card/Packages/Refresh controls; only its transport is the private
test HTTP dispatcher. Both old IDs, prefix/python strings, unknown fields,
registry/cache bytes and manager-call bytes remain unchanged during consumption.
The tests also call actual `revokeScope("mcp")` while Environment reads continue,
then `revokeScope("environment")` with a queued read. That read is rejected and
the child drains while the actual Root lease stays held. They disconnect with
another queued request, reconnect with a new session and close the actual owner.
Old adapters stay revoked. Scope signals are captured before revocation:
requesting a new signal from an already revoked scope is correctly forbidden.

Reproduce from the project cwd using **existing** dependencies/Playwright only:

```sh
mkdir -p .migration-test-work/environment-owner-profile/{build,next,t}
node -e 'require("fs").writeFileSync(".migration-test-work/environment-owner-profile/next/package.json", JSON.stringify({type:"module"}))'
ln -s "$PWD/next-server/node_modules" \
  .migration-test-work/environment-owner-profile/next/node_modules
node node_modules/typescript/bin/tsc -p tsconfig.json --incremental false \
  --outDir .migration-test-work/environment-owner-profile/build
node next-server/node_modules/typescript/bin/tsc -p next-server/tsconfig.json \
  --outDir .migration-test-work/environment-owner-profile/next
TMPDIR="$PWD/.migration-test-work/environment-owner-profile/t" \
PKM_ENV_AUTHORITY_BUILD="$PWD/.migration-test-work/environment-owner-profile/build" \
PKM_TEST_NEXT_SERVER_DIST="$PWD/.migration-test-work/environment-owner-profile/next" \
PKM_BROWSER_PYTHON="$(command -v python)" \
unshare -Urnmpf --mount-proc bash -c '"$@" & workload=$!; wait "$workload"' \
  pkm-private-init bash -c \
  'ip link set lo up && exec setpriv --bounding-set=-dac_override,-dac_read_search --no-new-privs "$@"' \
  pkm-private-tests node --test --test-concurrency=1 tests/test-ordinary-environment-owner.js \
  tests/test-ordinary-environment-profile-ui.js \
  tests/test-environment-conda-profile.js tests/test-environment-refresh.js
```

The dependency link is read-only reuse, not an installation; use a fresh output
directory or remove **only that owned link** before creating it again.
The private namespace is an **offline fixture** with a quiescent Root model,
not system-wide writer coverage and not a Code window. Dropped DAC capabilities
make the cache EACCES test real even with namespace UID 0.
The first current Next compile saw the shared Room `toJSON` TS error; that
failed log is retained, and a later compile passed after d3's own correction.
Initial fixture failures (missing dependency resolution, host writer scan
safely refusing uninspectable hosts, a non-importable placeholder, unexpected
privacy admission and invalid empty native tool config) are retained rather
than hiding them or weakening gates.
The latest per-scope rerun passed **11/11** with
`compile-root-final.log`, `compile-next-scoped-final.log` and
`final-scoped-reviewed.log` under
`.migration-test-work/environment-owner-profile/`.
The preceding `final-scoped.log` **10/11** failure is retained: the test tried
to obtain a new scope signal after revocation and was correctly denied. This
was a test assumption, not permission restored or a relaxed session gate.
Earlier whole-host `final-session.log` **11/11** and all failed attempts remain.

Qualification remains **current-source/offline genuine experimental owner +
synthetic trusted issuer + real ordinary DOM**, not production default
activation, authenticated cross-host authority, installed Code or a complete
legacy-root migration. The prior stable 900 installed result predates this
adapter and must not be assigned its new qualification. Cached conda data is
controlled fixture metadata; this does not validate a real conda installation
or a Next manager query. No Code window was requested/started; Root/d3 retain
their formally coordinated queue. Isolated validation outputs are cleaned after
verification; source/tests/docs and all diagnostic logs remain.

### Finite owner-authorized ordinary version/size/Packages Refresh

Read-only refusal was not the requested legacy functionality. The adapter now
accepts `handleMessage(message, refreshPermit)` for the existing ordinary
dashboard **Refresh** and **Packages / Refresh** gestures. It uses the actual
`pyenvPyVersion`, `pyenvSize` and `pyenvPackages` workflows with an optional
`PyenvRefreshWorkflow` context; unchanged default calls retain their legacy
profile/cache behavior. The owner context instead reads and commits the
original bound profile, never the global singleton. Genuine registered Python,
associated conda, Linux `du` and the existing version parser run; there is no
download, install, catalog import or production fallback.

`OrdinaryEnvironmentRefreshPermit` is supplied by a trusted embedding issuer,
**not** by message fields, an MCP token or the Environment session scope:

- One immutable request binds request ID, workspace, `local:owner`, canonical
  Root/profile, operation, Refresh intent and exact IDs/prefixes/interpreters/
  managers. `claim` consumes it once; object replay is also refused. Its fixed
  deadline is at most five minutes, with a separate revocation signal.
- Synchronous `assertCurrent` fences probe, execution and commit. Targets are
  rechecked after authorization callbacks. `assertExecution` sees the actual
  program, literal argv and frozen execution environment before spawning.
  Actual children are recorded; mandatory `verifyDrained` establishes physical
  completion even after permission is revoked.
- `assertProfileWriter` and `withProfileWrite` require independently proven
  original-profile writer exclusion/serialization. A Root Storage lease is not
  that proof. Commit uses pinned-directory, bounded regular-file snapshots,
  writable-file permission checks, mode-preserving temporary writes/fsync and
  bytes/inode/mode CAS before rename. CAS detects tested conflicts but does
  **not** eliminate a final race with an uncooperating external writer.
- Revoke/close stops new effects and publication and waits for started queries.
  Unconfirmed process drain preserves the owner/session child barrier and Root
  lease; retry verifies only, never replays the query. No post-revoke cache write
  is permitted.

Cached viewing still executes nothing. Missing/bad cache queries require a
separately authorized Packages intent; explicit Refresh executes and writes the
existing per-ID cache. Query/commit failures preserve cache bytes and expose the
ordinary error, including EACCES and the original path. Dashboard Refresh uses
the legacy version/allocated-size update and `refreshErrors`/row probe-error
shape. Version configuration reads are bounded/non-following/nonblocking in
the owner context; the legacy parser/fallback remains shared.

Modified files (absolute paths):

- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/src/runtime/ordinary-environment-owner.ts`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/src/servers/pyenvs.ts`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/test-ordinary-environment-owner.js`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/ordinary_environment_owner_ui.py`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/docs/design/local-environment-catalog.md`

**12/12** focused cases passed with freshly compiled Root and Next, including
actual ordinary headless DOM gestures, a real isolated system-site-packages
venv and a controlled conda helper reading local conda metadata. Coverage
includes expired/reused/wrong-target grants, callback-time target replacement,
cache conflicts and read-only cache EACCES, simultaneous metadata/real-pip/held
conda queries, request revocation and owner drain, UNKNOWN verification-only
retry, legacy singleton isolation, and actual same-Root experimental owner
resume/restart followed by another Refresh. The controlled helper is not a real
conda installation. Two default-workflow real-pip/version/allocated-size cases
also passed against the actual shipped 4.0.22 oracle (**2/2**).

From the project cwd, prepare fresh isolated outputs as in the preceding recipe,
using `.migration-test-work/environment-owner-refresh` in place of
`environment-owner-profile`, then run:

```sh
TMPDIR="$PWD/.migration-test-work/environment-owner-refresh/t" \
PKM_ENV_AUTHORITY_BUILD="$PWD/.migration-test-work/environment-owner-refresh/build" \
PKM_TEST_NEXT_SERVER_DIST="$PWD/.migration-test-work/environment-owner-refresh/next" \
PKM_BROWSER_PYTHON="$(command -v python)" \
unshare -Urnmpf --mount-proc bash -c '"$@" & workload=$!; wait "$workload"' \
  pkm-private-init bash -c \
  'ip link set lo up && exec setpriv --bounding-set=-dac_override,-dac_read_search --no-new-privs "$@"' \
  pkm-private-tests node --test --test-concurrency=1 \
  tests/test-ordinary-environment-owner.js tests/test-ordinary-environment-profile-ui.js \
  tests/test-environment-conda-profile.js tests/test-environment-refresh.js

unzip -p personal-knowledge-4.0.22.vsix extension/dist/servers/pyenvs.js \
  > .migration-test-work/environment-owner-refresh/legacy-pyenvs.cjs
TMPDIR="$PWD/.migration-test-work/environment-owner-refresh/t" \
PKM_ENV_AUTHORITY_BUILD="$PWD/.migration-test-work/environment-owner-refresh/build" \
PKM_TEST_PYTHON=/usr/bin/python3 \
PKM_TEST_LEGACY_PYENVS="$PWD/.migration-test-work/environment-owner-refresh/legacy-pyenvs.cjs" \
node --test --test-name-pattern='real existing pip|real allocated-size/version' \
  tests/test-local-python-packages.js
```

Use serial file execution: concurrent headless workers legitimately trigger the
existing legacy-writer safety gate. The initial **10/12** fixture failure
(parallel writer detection plus incorrectly reading UI `state.envs` instead of
actual global `envCache`) remains in `initial.log`; no gate was bypassed.
Final evidence under `.migration-test-work/environment-owner-refresh/`:
`compile-root-final.log`, `compile-next-final.log`,
`final-current-next.log` (**12/12**) and `legacy-regression.log` (**2/2**).
Earlier successes/failures and a verification receipt remain; owned build
outputs/fixtures are cleaned.

Qualification is **source/offline real experimental unified owner + actual
session + fixture-specific synthetic issuer/writer/drain proof + real ordinary
DOM**, not a new installed/default-production UI qualification. A production
trusted UI issuer, managed profile-writer handoff, descendant containment and
cross-host fencing are still required. Missing proof remains denied; no default
production entry was enabled. Stable 900 installed evidence predates this
extension. No Code window, production environment, shared activation/Chat/Room,
historical pins, full Next test suite or migration inventory was touched.

### Native VS Code intent issuer and shared owner lifecycle: installed trial blocked

The next slice adds:

- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/src/runtime/ordinary-environment-vscode-authority.ts`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/src/runtime/ordinary-environment-vscode-host.ts`

The authority uses **native VS Code** modal consent, actual workspace trust,
`ExtensionContext.globalStorageUri`, current `getStorePath()`, canonical
Root/profile inode identity and the supplied current host fence. Host/scope,
configuration, identity loss and expiry revoke it. Read consent lasts at most
five minutes. Refresh intent lasts at most two minutes, binds all exact
operation/ID/prefix/interpreter/manager fields and is consumed once.
`requestOrdinaryEnvironmentRefreshIntent` deliberately returns **no writer or
process capability**. `requestOrdinaryEnvironmentRefreshPermit` additionally
requires independent managed effects; neither a modal nor a scope signal
creates them.

`startOrdinaryEnvironmentVscodeHost` composes that issuer with the existing
ordinary adapter and a real owner/environment session. Both register its close
barrier. Close revokes pending modal admission without waiting for a stale
answer, waits requests/actual adapter drains, and unregisters only after
successful drain; UNKNOWN keeps the barrier for retry. Cached packages do not
request effects. Missing authority stays visibly denied. This is a trusted
embedding API; **shared activation is not wired** and production stays closed.

Focused native API contract tests are in
`/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/test-ordinary-environment-vscode-authority.js`.
Those nine cases **mock VS Code APIs/embedding** and are not installed UI
qualification. The kernel test
`/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/test-ordinary-environment-native-effects.js`
uses actual private tmpfs, an immutable private bind mount and a launcher into a
nested PID namespace. Normal outer `unshare` completion establishes PID1 exit
and kernel cleanup of a real forked descendant; signal loss remains UNKNOWN.
The callback unit scaffolding is not a real Root host/profile grant. Initial
tmpfs remount failure is retained; correcting the private bind/remount recipe
did not relax a production gate.

Latest isolated Root/Next compiles passed; native contracts, real kernel drain
and the existing twelve owner/ordinary UI regressions passed **22/22, zero
skips**, in `.migration-test-work/environment-native-issuer/final-reviewed.log`.
This includes rejecting asynchronous owner/session fencing before native
consent; displayed literal paths are JSON-quoted rather than allowing embedded
newlines to spoof modal fields. The earlier 21/21 log remains:

```sh
TMPDIR="$PWD/.migration-test-work/environment-native-issuer/t" \
PKM_TEST_PRIVATE_NATIVE_EFFECTS=1 \
PKM_ENV_AUTHORITY_BUILD="$PWD/.migration-test-work/environment-native-issuer/build" \
PKM_TEST_NEXT_SERVER_DIST="$PWD/.migration-test-work/environment-native-issuer/next" \
PKM_BROWSER_PYTHON="$(command -v python)" \
unshare -Urnmpf --mount-proc bash -c '"$@" & workload=$!; wait "$workload"' \
  pkm-private-init bash -c \
  'ip link set lo up && exec setpriv --bounding-set=-dac_override,-dac_read_search --no-new-privs "$@"' \
  pkm-private-tests node --test --test-concurrency=1 \
  tests/test-ordinary-environment-vscode-authority.js \
  tests/test-ordinary-environment-native-effects.js \
  tests/test-ordinary-environment-owner.js tests/test-ordinary-environment-profile-ui.js \
  tests/test-environment-conda-profile.js tests/test-environment-refresh.js
```

After formal Root/d3 handoff, two fresh private Code fixtures ran and both
exited **1**:

1. `native-env-code-2321686b-ff76-44ad-acd5-bb3ffdb2bd4f`: renderer could not
   access `/proc/<controller>/cwd/runtime` after sandbox/DAC capability drop,
   EACCES/code133; no old host activation/new owner/native modal/Refresh.
   Captured **12**, remaining `[]`.
2. `native-env-code-72ee7b44-070c-4302-a6b3-9a483b7e87fa`: self-cwd aliases fixed
   renderer access without weakening permissions. Actual **4.0.22** activated,
   read both original registrations in the same actual profile and original
   Root with the upgrade gate false. All known owned old descendants exited.
   Prestarting the actual owner then correctly refused
   `SNAPSHOT_HOST_AUTHORITY_REQUIRED`: the old host created original `.pkm`
   privacy, and no legitimate host snapshot authority/fixed snapshot scope was
   supplied. **No new Code/native consent/Refresh/restart stage was reached.**
   Captured **19**, remaining `[]`.

Both controller/unshare processes exited. Exact readable host argv/cwd matching
for both own fixture names found `[]`: **789 readable, 580 partial, 1 race**,
excluding probe ancestors; this is not system-wide exclusion. Evidence includes
`code-initial.log`, `code-retry.log`, `host-cleanup.json` and each fixture's
`cleanup.json`; the second fixture's `host-original.json` records actual old
activation. The Code window was formally released to d3; no further Code
launch is permitted without another handoff.

The bounded controller/driver/actor and test-only kernel capability helper are:
`tests/ordinary-environment-native-controller.cjs`,
`tests/ordinary-environment-native-code-host.cjs`,
`tests/ordinary_environment_native_actor.py`,
`tests/helpers/ordinary-environment-native-parent.cjs` and
`tests/helpers/ordinary-environment-native-effects.cjs`.
The proposed private loopback channel signs messages with an inherited fixture
key. **Key possession, PID and controller-supplied fields do not prove native UI
authorization or exclusive trusted Code embedding.** These files cannot be used
as a production issuer. Even a later success would qualify only observed real
native UI plus a controlled fixture channel and **prestarted** owner, not a
same-host owner startup or authenticated cross-host safety closure.

No `.pkm` privacy was deleted and no fake snapshot callback/admission was added.
Environments only needs its original profile, manager probes and cache/metadata
writes; it invokes no `knowledge_snapshot_*` or snapshot restore operation.
Its restart requirement is owner/session/profile reopening, not restoring
Knowledge snapshots. Root owns the public adoption/snapshot decision; enabling
unused snapshot tools merely to pass adoption would incorrectly expand intent.
This gate remains explicitly blocked pending a legitimate Root design.

#### Exact 4.0.22 snapshot defaults versus Environment intent

Read-only inspection of the original VSIX, followed by importing its **exact**
`extension/resources/knowledge_snapshots.py` through Python's zip importer in
an isolated copy, separates three facts:

- `personalKnowledge.mcpEnabledFeatureDomains` defaults to `knowledge`,
  `automation`, `skillRouter`. The old generated MCP server registers all five
  `knowledge_snapshot_*` tools when the knowledge domain is enabled. This is
  default **tool discovery**, not new host authorization.
- With no schedule/repository, the actual old `knowledge_snapshot_status`
  implementation returns `enabled: false`, local time `17:00`,
  `America/Los_Angeles`, no tags and no latest snapshot. The isolated run
  preserved privacy bytes and created no snapshot state. No MCP server,
  scheduler, create/configure/restore operation was started. `configure`'s
  default `enabled=True` applies only when that tool is called; restore apply
  requires its preview ID and approved digest.
- Actual old activation wrote `{schema:1,private:{notes:["Chatroom Meetings"]}}`.
  The shipped `extension.js` Chatroom initialization sets that privacy flag
  automatically; this is necessary default private-content protection, not
  Environment Refresh or a backup request. Its actual fixture policy SHA-256 is
  `013c796bd51a1fea5edbe58eb180c0c1119b7413fe6cbddcdd5800466cbaa3ed`.

Evidence: `.migration-test-work/environment-native-issuer/old-snapshot-status.json`.
Default snapshot discovery must not be silently claimed absent or replaced
with permanent deferral. Equally, default discovery/Chatroom privacy does not
authorize snapshot admission for an Environment-only owner. Any optional
disabled strategy must preserve privacy and fail closed across all snapshot,
MCP, startup and recovery paths; Root owns that separate implementation.

## Enrolled profile writer and real Refresh process drain (offline, default-off)

This independent slice now executes ordinary `envPackages`/`envList` Refresh
through a real installed Linux Python subreaper, and consumes Root's specialized
managed-writer registration. It is **not** a native-UI mock standing in for
process completion. It is also **not** production or installed Next qualification:
the new tests' owner/session embedding and independent exclusive-profile fence
are controlled fixture callbacks; the raw 4.0.22 global writer is not silently
enrolled and no default activation or Root admission path is changed.

Changed complete file paths:

- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/src/runtime/linux-environment-supervisor.ts`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/src/runtime/ordinary-environment-managed-effects.ts`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/src/runtime/ordinary-environment-owner.ts`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/src/runtime/ordinary-environment-vscode-authority.ts`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/test-linux-environment-supervisor.js`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/test-ordinary-environment-managed-effects.js`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/docs/design/local-environment-catalog.md`

The supervisor preparation is pure. The adapter reserves the one-shot launch
before exposing the prepared token to registration callbacks, authorizes the
original manager **and actual helper argv/environment**, registers durably, repeats
its current fence, and only then starts the actual process. The reserved launch
capability is not passed to the registration callback. No interpreter, manager or
package is installed/downloaded.

The helper sets `PR_SET_CHILD_SUBREAPER`, non-dumpable/no-new-privileges and drops
effective/permitted/inheritable capabilities before the manager. Manager output
uses separate pipes from the completion protocol. It waits with `waitpid(-1)`
until **all** owned descendants are reaped, including detached/orphaned children
after their parent exited and closed stdio. The normal output protocol and opaque
physical proof are bound to the exact prepared token; matching request strings
alone are insufficient. Root/profile inodes are rechecked when consuming proof.
The real manager cannot open the helper's protected protocol descriptor, and a
fake completion printed by the manager stays ordinary captured output.

`ManagedOrdinaryEnvironmentProfileWriter` requires actual `HostWriterAdmission`,
independent current/exclusive/execution fences and specialized Root begin/complete
callbacks. It also requires both Root and Environment child-close registrations.
Its deny signal closes new effects synchronously. Its local `handoff()` closes new
legacy admissions and waits admitted handlers, physical descendants and the
serialized original-profile write queue before allowing **separately authorized**
owner intents. This is only the explicitly enrolled same-host profile subset,
not Root-wide handoff, a scanner, other-host coverage or user consent inferred
from a read/session grant.

Root's `.complete` must not be written from `verifyDrained`: query parsing and
profile commits still follow that callback. The owner alone mints an opaque
transaction completion after the entire successful handler and commits; it is
usable only inside the awaited `finishRefresh` callback, rechecks current
owner/profile/permit signal/deadline synchronously, and is invalidated in `finally`.
Root's three-argument specialized completion consumes both exact physical and
transaction capabilities. Saved/spread/wrong-token/aborted completion is rejected.
Failure, cancellation, timeout, supervisor SIGKILL, caller crash or missing
registration never creates completion or replays the query. Late physical drain
after timeout is verification-only: it does not restore expired transaction
authority. UNKNOWN retains durable pending and both close barriers.

Verification: isolated Root and Next TypeScript builds pass; final combined suite
**35/35, zero skips**, in
`.migration-test-work/environment-managed-effects/final-reviewed-v2.log`.
The new **13** cases cover real descendants/protected protocol, four prepared
queries in one metadata transaction, held writer queue, two concurrent profiles,
one-profile cancellation, commit/finish cancellation, missing registration,
unknown external writer rejection, timeout and actual supervisor/caller SIGKILL.
The remaining **22** are prior regression cases, including **9 native API/embedding
mocks**, separate actual owner/session and ordinary source UI tests, and the prior
isolated kernel fixture. These distinct evidence levels are not combined into
new installed or production authority.

Rebuild and run the focused cases from this package directory:

```sh
mkdir -p .migration-test-work/environment-managed-effects/{build,next,t}
node node_modules/typescript/bin/tsc -p tsconfig.json --incremental false \
  --outDir .migration-test-work/environment-managed-effects/build
node node_modules/typescript/bin/tsc -p next-server/tsconfig.json --incremental false \
  --outDir .migration-test-work/environment-managed-effects/next
printf '{"type":"module"}\n' > .migration-test-work/environment-managed-effects/next/package.json
ln -s "$PWD/next-server/node_modules" .migration-test-work/environment-managed-effects/next/node_modules
TMPDIR="$PWD/.migration-test-work/environment-managed-effects/t" \
PKM_ENV_AUTHORITY_BUILD="$PWD/.migration-test-work/environment-managed-effects/build" \
PKM_TEST_NEXT_SERVER_DIST="$PWD/.migration-test-work/environment-managed-effects/next" \
unshare -Urnmpf --mount-proc bash -c '"$@" & workload=$!; wait "$workload"' \
  pkm-private-init bash -c \
  'ip link set lo up && exec setpriv --bounding-set=-dac_override,-dac_read_search --no-new-privs "$@"' \
  pkm-private-tests node --test --test-concurrency=1 \
  tests/test-linux-environment-supervisor.js tests/test-ordinary-environment-managed-effects.js
```

The combined command adds `PKM_TEST_PRIVATE_NATIVE_EFFECTS=1`,
`PKM_BROWSER_PYTHON="$(command -v python)"` and the six existing selectors
`test-ordinary-environment-vscode-authority.js`,
`test-ordinary-environment-native-effects.js`, `test-ordinary-environment-owner.js`,
`test-ordinary-environment-profile-ui.js`, `test-environment-conda-profile.js`,
`test-environment-refresh.js` under `tests/`.

`compile-final-reviewed.log`, `compile-next.log`, `verification-receipt.json` and
all failed/intermediate logs are retained in the same evidence directory. Initial
Python 3.8 lacked `os.waitstatus_to_exitcode`; the real failing test led to portable
`WIFEXITED`/`WEXITSTATUS`/`WTERMSIG` handling. Later assertion-only failures confused
closing admission with actual drain and deduplicated fixture barrier functions;
the first combined run also correctly exposed a read-only metadata fixture write
under DAC capability drop. Those failures are preserved, not counted as success.
The initial standalone Python-3.8 failure left one owned waiting descendant;
the final exact fixture-UUID scan identified PID 3469195, which was terminated
with specific SIGTERM and verified absent. `standalone-cleanup.json` preserves
that limited cleanup, without a system-wide exclusion claim. All later runs used
private PID namespaces, exited, and cleaned their own fixtures. Only this slice's
build/Next dependency link/scratch directory is removed after recording hashes;
source, tests, receipts and all logs remain.

Remaining hard boundaries: Root local session drain still refuses
`environment-refresh`, even after valid completion; the actual compatible session
is refused by Next with `PKM_STATE_UNSUPPORTED` (no adoption receipt), and Root's
separate rotated-session parser oracle also refuses the new kind. Current begin
uses the legitimate legacy Root writer fence, so an already active Next owner
cannot be bypassed. Root owns any future owner-aware/cross-host registration and
Snapshot issuer. Unknown outside writers, systemd/DBus effects outside the process
family, unreviewed raw old global writers, crash recovery authority, installed
new-owner UI and production-default handoff remain unqualified. No private Code
window was acquired or started for this slice; Root → d3 → Env coordination and
the peers' independent UI evidence do not grant this slice Code readiness.

### Actual Root host fence bridge (offline, not installed authorization)

The independent bridge is implemented in:

- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/src/runtime/ordinary-environment-root-host-effects.ts`
- `/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/tests/test-ordinary-environment-root-host-effects.js`

It directly consumes Root's branded `createManagedEnvironmentHostFence` /
`assertManagedEnvironmentHostFence`, specialized
`beginManagedEnvironmentRefresh` and three-argument
`completeManagedEnvironmentRefresh`. There is no injectable substitute Root
backend. Actual issued registration, Root/profile binding and current/deny
checks are mandatory. A Root host/session confirmation alone cannot authorize
profile writing or execution: an independently authorized profile writer,
fresh finite intent and both lifecycle close barriers remain required.
The profile-writer interface is a trusted embedding contract, **not a branded
native kernel issuer**.

Four top-level tests passed against an isolated emitted Root build. Three
create profiles with the real shipped 4.0.22 manager, real retained venvs and
`pip list`, drain the entire old-oracle process family, preserve original
registry/cache bytes and Refresh only a private tmpfs profile copy. They
exercise the real Root registration/host fence and actual ordinary
`envPackages` handler:

- Successful real pip Refresh commits its cache and durable completion.
- Changing the held completion lock's nonce or replacing its inode refuses
  completion and retains pending. A callback queued within the lock scope
  cannot borrow that scope after completion.
- A separate process closes the actual session admission. The host rejects
  subsequent assertions/effect creation, without pretending that a remote
  file update synchronously aborts its local signal. Local scope abort and
  host drain do synchronously deny.

The first real bridge run exposed a same-process Root completion-lock
deadlock; Root subsequently fixed its private scoped lock reuse. The failed
`real-profile-v1.log` remains preserved. `real-profile-v2.log` is the original
three-case success. `real-profile-v3.log` inadvertently ran the remote case
nested three times (six total passes), **not six independent cases**; the
test structure is now corrected. Final combined verification is **39/39,
zero skips**, in
`.migration-test-work/environment-root-host-effects/final-focused-v6.log`:
the four new cases plus the previous 35, including nine native API/embedding
mocks and separately tested Next owner/source UI. Those separate results
do not establish a combined Root-bridge → actual Next-owner handoff.
`final-focused-v4.log` retains an earlier runner failure: the four bridge
cases passed, but two existing owner UI cases lacked the required
`PKM_BROWSER_PYTHON` selection. The retry used existing Python/Playwright,
not an installation or download.

Reproduce just the four new cases from this package directory:

```sh
mkdir -p .migration-test-work/environment-root-host-effects/{build,t}
node node_modules/typescript/bin/tsc -p tsconfig.json --incremental false \
  --outDir .migration-test-work/environment-root-host-effects/build
TMPDIR="$PWD/.migration-test-work/environment-root-host-effects/t" \
PKM_ENV_AUTHORITY_BUILD="$PWD/.migration-test-work/environment-root-host-effects/build" \
unshare -Urnmpf --mount-proc bash -c '"$@" & workload=$!; wait "$workload"' \
  pkm-private-init bash -c \
  'ip link set lo up && exec setpriv --bounding-set=-dac_override,-dac_read_search --no-new-privs "$@"' \
  pkm-private-tests node --test --test-concurrency=1 \
  tests/test-ordinary-environment-root-host-effects.js
```

The combined command uses the previous eight selectors, adds
`tests/test-ordinary-environment-root-host-effects.js`, supplies the same
private-native/browser variables described above, and points the Next
output to `.migration-test-work/environment-root-host-effects/next`.
Root/Next compile logs, tested emitted-module hashes, exact commands and
limited cleanup evidence are recorded in this directory's
`verification-receipt.json`; only this slice's build/dependency link/scratch
outputs are removed afterward.

The kernel mount/namespace checks and owner/session projections in these tests
are **controlled fixture callbacks**, not actual installed Code authorization.
The real legacy host still lacks an Environment child scope, two independent
native close registrars and a Code-verifiable branded kernel profile writer
issuer. Root's explicit Linux
`personalKnowledge.checkManagedOriginalEnvironmentsExperimental` therefore
visibly refuses when those capabilities are unavailable; it does not read
the environment profile or launch Refresh and never runs automatically.
This command's registration has source-focused evidence, **not installed
Code evidence**. Ordinary production activation remains unchanged.

No production environment, original prefix, snapshot authority or default
activation was modified, and no private Code window was started. This slice
does not supply Snapshot approval, grant an already active Next owner a
legacy write bypass, prove exclusion of unmanaged writers, or complete
Root adoption. Unknown external-writer risk is retained explicitly, not
converted into a claim of system-wide exclusivity.

Native integration reuse points are deliberately narrower than authorization:
the actual `earlyManagedProfile` and `hostWriterAdmission` in
`src/extension.ts` can supply issued registration and enrolled-work counting.
`HostWriterAdmission.run("ui", ...)` counts the bridge's complete transaction,
but supplies neither an Environment child-close registry nor a profile-writer
grant. Its `observe` fallback must not be used to mint authority. The actual
`activateManagedProfileWriter` drain callback currently drains shared host
services, not a registered Environment scope; native integration must await
both real child-close barriers and propagate UNKNOWN before profile completion.
An `ExtensionContext` synchronous disposable is not that awaited barrier.

After real adoption, `createOwnerHostSessions` in
`next-server/src/owner-host-sessions.ts` already provides scoped Environment
abort and awaited child-close machinery, alongside the actual owner's
`registerChildClose`. Its trusted transport/host/scope binding still requires
real authentication; a host key or profile confirmation is insufficient.
Those Next resources cannot be constructed as a substitute legacy owner.
Conversely, this bridge requires an **accepting** legacy host: a drained host
snapshot issuer cannot reopen it, and its legacy Root `begin` cannot write
through an active Next owner. Snapshot-reader authorization and later
Next-owner Environment execution therefore need their own legitimate
lifecycle integrations, not reused writer grants.

## Explicit remaining gaps

The entry-point relocation fix is **offline current-source qualification**, not
a new installed VSIX or production-default migration result:
`node node_modules/typescript/bin/tsc -p tsconfig.json --outDir
.migration-test-work/environment-shebang/build --incremental false`, followed by
`PKM_ENV_AUTHORITY_BUILD="$PWD/.migration-test-work/environment-shebang/build"
node --test tests/test-local-python-management.js
tests/test-local-environment-upgrade.js` (**23/23 passed**). The initial two cases failed
before the fix (quoted profile: ENOENT; long profile: shell fallback/syntax
failure); a third covers literal backslashes and repeated quotes. All passed
with real fixture Python entry-point execution, literal
arguments, UTF-8/future import, versioned Python plus `-I`, unchanged source and
legacy registry. The suite also runs the shipped **4.0.22** manager from
`personal-knowledge-4.0.22.vsix` against disposable venvs for old move/delete/
activation behavior. Logs are under
`.migration-test-work/environment-shebang/`. No private VS Code window, package
installation/download, production environment or historical pins were used.
Binary/non-UTF-8 wrappers, arbitrary executable shebangs and scripts over the
existing 2 MB rewrite limit are not covered by this repair. The management
command remains experimental, default-off and fresh-isolated-trial-only;
ordinary production activation still uses the legacy path.

- Unreviewed Node projects, recursive dependency pinning, TypeScript compilation
  beyond the installed Node's strip-only support, engine
  compatibility/package-manager workflows, arbitrary C# source/projects and
  non-.NET8 execution of discovered C# tools. Project-to-SQL/public Recipe
  environment binding was not added by the private Node project slice.
- Additional providers/SDK versions, sandboxing,
  process-tree containment and automatic execution resume (UNKNOWN is never replayed).
- Unreviewed Python execution, mixed-environment/control graphs, output-reference
  arguments and production/public attachment. Bounded native Python Workflows,
  canonical filesystem Recipes and the separately approved private SQL/public
  composition are qualified only within their stated evidence boundaries.
- Production-default Next ownership of ordinary package and size/version Refresh
  (the finite experimental owner/source behavior is qualified above); package
  comparison, similarity and merge-script workflows; conda terminal hooks;
  old destructive `pyenvMigrate` parity, cross-device relocation and
  unrestricted irreversible runtime deletion. Preserved caches and
  metadata are not migrated management/execution workflows.
- Package-snapshot UI/copying and additional manager-specific operations
  (raw configuration is preserved and original per-ID caches remain untouched).
- Positive uv creation/lifecycle on a machine with uv, arbitrary package
  maintenance, manager-specific relocation/deletion beyond the synthetic
  venv copy/quarantine slice, and uncached dependency acquisition.
  Explicit offline synthetic venv/conda provisioning is supported as above;
  missing uv is refused, not silently installed or positively qualified.
- Native Windows/macOS tests, power-loss fault injection and interactive UI tests.
- Production profile/root upgrade and automatic cutover remain unqualified.
