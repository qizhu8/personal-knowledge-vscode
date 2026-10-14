# Actions: contracts, execution and qualification

Status: implemented with a graphical Workbench, durable Action Runs and executable
acceptance tests. Native Windows and human-persona acceptance remain outstanding.
Audience: PKM maintainers and Action authors. The requirements below capture the
agreed direction; record layouts, SDK transport and default limits are proposals.

## Goal and boundary

An Action is a registered, discoverable, typed functional module. An Action Run
is one invocation, not the Action itself and not a remote job. A Script, compiled
program or MCP tool adapter can implement an Action. A Recipe orchestrates Actions;
it is not required for an atomic invocation. Existing Script identity and Recipe
semantics must remain intact.

Registration does not grant execution permission. Dependency discovery does not
prove readiness. Linux acceptance does not qualify Windows. Exit code zero does
not prove a remote transfer completed or an output contract was satisfied.

The initial platform targets are Cosmos upload, download, directory listing and
job progress, plus Singularity job progress. Cosmos here is the file/job platform,
not Azure Cosmos DB. Job progress stays read-only; job submission is out of scope.

Cosmos adapters are not default examples or default discoverable Actions. They
require Azure CLI authentication and an explicit local operator policy granting
the Action and remote scope. A clean store advertises no Cosmos adapter; enabling
one does not grant credentials or qualification. General-purpose examples will be
selected separately.

## Separate the records

| Record | Owns | Does not own |
| --- | --- | --- |
| Definition | Stable identity, version, schemas, effects, documentation | Local credentials or readiness |
| Implementation | Carrier, supported OS/architecture, entry point, dependency lock, digest | User-specific configuration |
| Environment binding | Selected implementation, execution host, runtime/config references | Portable acceptance evidence |
| Qualification | Controlled checks and bounded evidence for one binding | Permission to exceed operator scope |
| Run | Pinned contract, inputs, parent, budgets, state, output, artifacts | Definition identity or remote job lifetime |

### Implemented durable launch boundary

Module and platform Actions use their existing Run store, mutation lock, workers,
qualification, grants and artifacts. No second executor or Run identity namespace
is introduced. The OS-owned mutation lease serializes launch/recovery after a
process crash; the existing mutation marker remains a diagnostic and compatibility
guard. Native Windows uses `msvcrt` and Linux uses `flock`.

Before worker dispatch, a launch journal commits the original Run and invocation-key
receipt. Partial commits restore the same Run, never submit a replacement. Reusing
the key with different inputs is rejected. Each worker must claim a monotonically
fenced execution checkpoint; duplicate claims and completion after reconciliation
are rejected.

`pkm.action.execution-contract/v1` is a conservative projection of existing
definitions, exposed by the catalog and `action_get`, and frozen in
`pkm.action.execution/v1` Run metadata. It includes definition revision, schemas,
effects, capabilities, invocation-workspace claim, deadline/retry policies and
receipt contract. The Run additionally pins its environment fingerprint; platform
Runs pin the command specification. Legacy effects map to read/write/send/delete/
spend, with missing or unsupported metadata treated as unknown/high-risk. This
adapter grants no new capability. Automatic retry is disabled; launch deduplication
does **not** guarantee external-effect idempotency.

Worker loss, cancellation/timeout and errors after potentially mutating execution
enter `Reconciling`, not a false ordinary failure. Platform command-result evidence
alone is not a committed completion receipt. Uncertain module workspaces/artifacts
are retained rather than automatically collected. Recovery fences the original Run
and lists required review; it does not replay effects or imply a remote rollback.
P3 adds typed continuations, wakeups and pinned read-only reconciliation on this
same Run store; see [durable recovery](./action-durable-recovery.md).

Workbench persists the original submission key before sending, including browser
reload/VS Code webview state. Transport retry uses that key even if the draft has
changed. Native and authenticated-browser surfaces show recent root Runs, identity,
canonical state, owner/reason, checkpoint, elapsed time, pinned capabilities,
receipts/output/artifacts and cancellation. Inline human choices persist a Waiting
checkpoint tied to the original Run and request. Qualification must match the exact
saved definition hash, not an older ready version. P2 adds a Project Cockpit and
an "Open in Project" route without duplicating Run lifecycle authority.

Workbench API envelopes separate request success (`ok`) from execution success
(`execution_ok`), so Failed/Reconciling Runs remain inspectable instead of being
rejected as transport failures. MCP Run records retain their existing execution
`ok` field.

Validation uses isolated fixture stores and mock programs only:

```sh
.venv/bin/python tests/test-action-durable-runs.py
.venv/bin/python tests/test-action-modules.py
.venv/bin/python tests/test-action-runtime.py
.venv/bin/python tests/test-action-workbench.py
.venv/bin/python tests/test-action-recovery-e2e.py
npm run build
node tests/test-chat-action-recovery-e2e.js
node tests/test-action-browser.js
node tests/test-pkm-p0.js
```

Fault tests cover journal interruptions, concurrent duplicate submission after
host loss, stale worker fences, invalid dispatch capabilities, waiting receipts,
uncertain local effects, remote-response evidence before completion, conservative
metadata and browser transport loss/reload. Process-loss durability is tested;
native Windows and filesystem/power-loss acceptance are not inferred from Linux.
See [execution baseline](./pkm-execution-baseline.md) for opt-in measurements and
the five explicitly pending human-persona baselines.

Publish only portable definitions and implementations through normal PKM privacy
and sync rules. Bindings, qualifications, grants, logs and run workspaces are local
state by default. Credential references resolve at execution time; secrets are not
stored in definitions, command histories, qualification evidence or chat replies.

A definition digest must be environment-neutral. An implementation digest includes
executable content, dependent adapters and locked runtime dependencies. A moved
file keeps its immutable identity; a semantic name such as `cosmos.artifact.upload`
is an alias, not an identity derived from its present location.

Generic definitions retain stable `knowledgeId` and `pkm://knowledge/<id>` references.
Formal index integration remains outstanding. Legacy Cosmos `pkm://actions/<name>`
references still need migration aliases, not silent replacement. Do not infer that
source files alone have been indexed.

## Platform qualification

Definitions can have separate Windows, Linux and macOS implementations. Select
against the actual execution host, not the editor UI's OS. Remote bindings must
identify their host and report that host's environment and qualification.

Proposed availability states:

| State | Meaning |
| --- | --- |
| unsupported | No implementation supports this target |
| unverified | Supported target without applicable controlled acceptance |
| blocked | Missing runtime, dependencies, configuration, auth or permissions |
| ready | Applicable unexpired acceptance and current preflight both pass |
| failed | Applicable controlled acceptance failed |
| stale | Implementation/environment changed or evidence expired |

The qualification pipeline is static contract validation, runtime/dependency
preflight, then a controlled smoke/acceptance test with explicit test scope.
Preflight is read-only unless an independently authorized validation step declares
an effect. Never silently install dependencies, start login or create remote jobs.

Evidence binds to the definition and implementation digests, OS/architecture,
runtime and dependency versions, relevant configuration revision, host identity,
principal/scope references, validation recipe revision, timestamps and expiry.
Never hash credential contents into a shareable fingerprint. Recheck dynamic
prerequisites before launch: yesterday's valid token does not prove today's access.

Readiness is specific to an Action and target scope. Passing a read-only directory
list does not qualify upload or download. Testing an MCP server's discovery does
not qualify a mutating tool. Qualification failure is a structured diagnostic,
not an automatic fallback to another implementation or wider authorization.

## Common typed boundary

Use JSON Schema 2020-12 for portable input/output contracts. Validate against its
metaschema and enable explicit format checking where required. Every invocation
validates input before allocation/launch, and validates output before success.
Schema validation does not perform implicit coercion.

Keep the wire representation language-independent:

| Value | Wire rule |
| --- | --- |
| Bounded integer | Declare range; generated binding checks its native range |
| Large integer | Decimal string with declared logical type; never rounded through JS Number |
| Exact decimal | Canonical decimal string with precision/scale constraints |
| Date | `YYYY-MM-DD`, without inventing a timezone |
| Date-time | RFC 3339 with explicit offset; timezone-free input rejected |
| Enum | Declared members, no unknown-value fallback |
| Optional/nullable | Missing and null remain distinct where the schema distinguishes them |
| File/directory | Artifact reference, not an arbitrary absolute path |
| Binary | Artifact reference; bounded inline encoding only if explicitly declared |

Casting is an explicit versioned binding rule, not a global convenience. A
string-to-integer cast rejects whitespace/notation outside its declared syntax,
fractional values and overflow. Date conversion must not silently truncate a
timestamp. Lossy conversion requires a declared policy; lossless is the default.
Return field-addressed errors with expected type and cast rule, without echoing
sensitive values. Cast and validate before submitting the child invocation.

## Cross-language composition

One supervisor owns invocation, authorization, readiness, persistence and GC.
Language bindings are thin clients of the same protocol, not separate launchers.
C# calling Python and Rust calling Java therefore use the same Action identity,
input contract, result envelope and parent/child relationship.

Proposed protocol operations are invoke, get, cancel and artifact retain/release.
Invocation carries protocol version, pinned Action/implementation, invocation key,
parent context handle and validated JSON input. The supervisor supplies an opaque
run-scoped capability; a child cannot forge a parent ID to gain authority.

For managed local processes, prefer dedicated inherited protocol pipes separate
from logs and program stdout. Bindings frame messages with bounded lengths and
validate protocol versions. An MCP adapter translates this same supervisor
protocol rather than exposing child tools to ambient unrestricted routing.
Cross-host transport requires authentication and its own qualification; it is
not part of the first local prototype.

Parent scope is the upper bound. Child scope is the intersection of inherited
scope, implementation effects and local operator policy. A child needing broader
scope returns blocked instead of opening an unattended approval/login prompt.
Parent and child share a top-level budget for deadline, concurrency, output bytes
and artifact storage. The Action dependency depth limit is 16. A composition may
only nest an already completed, currently qualified pinned Action version.
Registration, graph checks, import/load and readiness checks reject recursive
dependencies. Bounded language loops do not authorize recursive Action nesting.

The supervisor generates a child invocation key from the parent run, call-site
identity and stable iteration key. A replay must reuse that key; changed inputs
with the same key are rejected. A lost response is reconciled, not resubmitted
under a fresh key. Parent cancellation propagates to children, but does not imply
rollback or cancellation of remote jobs. A parent cannot succeed while a required
child has failed, remains unresolved or returned an invalid output.

Directory scope validation is not an OS sandbox. Arbitrary trusted C#/Python/Rust/
Java code can bypass an SDK and access ambient credentials or the filesystem.
Label trusted host execution honestly. Untrusted code requires a qualified sandbox
or isolated runner with enforced filesystem, process and network boundaries; reject
it on a host lacking that isolation rather than claiming the SDK enforces security.

## Programming and execution workspaces

The development workspace contains source, build products, tests and manifests.
The execution workspace is a user-selected local staging root. Neither a Recipe
directory nor the Knowledge Root is an implicit staging directory.

Ask for the root once when missing; nested Actions inherit it without repeating
the question. Persist the user's explicit choice as a local binding, not in the
portable Action. Batch execution with no choice returns blocked. Do not silently
choose `/tmp` when the user requested a working-directory decision.

Allocate one top-level run directory under that root. Give each child a separate
subdirectory and explicit references to shared parent artifacts. Inputs are
imported as read-only borrowed files or deliberate copies. User originals are
never runtime-owned. Validate relative paths, real paths and symlink/reparse-point
escapes; do not reuse a caller-supplied pre-existing directory as a managed run.

The wire format identifies artifacts by ID. The supervisor resolves IDs to paths
inside the appropriate run, with kind, size, digest and ownership metadata. Large
outputs are artifacts; metadata stays within bounded JSON output. Export to a
user destination is a separate authorized step, with collision/overwrite checks.

## Artifact lifecycle and GC

Track ownership and references durably, not by filename patterns or an in-memory
counter. A manifest records run-relative location, content digest, owning run,
borrowed/managed/exported status and retention state. Reference edges belong to
active runs and exported outputs and are committed before handing an artifact to
another process. Child completion cannot delete a still-referenced artifact.

On top-level termination, mark unreferenced runtime-owned staging content eligible
for GC. Failure/cancel diagnostics use a bounded, configurable retention TTL.
Borrowed inputs and user-exported outputs are not GC targets. Remote Cosmos data
is never part of local GC; remote deletion requires a separate Action and grant.

GC takes a lease, rechecks references and containment, marks a pending deletion,
then deletes idempotently and records completion. Restart recovery resumes pending
deletions and reconciles abandoned runs before releasing references. Missing or
malformed ownership metadata means quarantine, not recursive deletion. Revalidate
paths and reject replaced symlinks before deleting anything.

Execution result and GC result are separate: a successful Action can have pending
cleanup, while failed cleanup must remain visible. Quotas block further allocation
with an actionable error, not deletion of unknown or active artifacts. Initial
defaults for retention and quotas require explicit agreement and disk-budget tests.

## MCP implementations and ecosystem integration

An MCP implementation pins a configured server identity, exact tool name,
input/output contract digests and expected effects. Validate discoverability,
schema compatibility, credentials/scope, controlled tool invocation and output
contract. A server label or tool-name match alone is insufficient. Protocol errors,
tool `isError`, unavailable servers and truncated/invalid responses are failures
or unknown outcomes as appropriate, not valid Action outputs.

Preserve distinction between an Action Run, underlying MCP request ID and any
remote operation/job ID. Propagate deadlines and trace IDs. Do not advertise
cancellation support unless the adapter can demonstrate it. Mutation retries
require backend idempotency or explicit reconciliation; never blindly retry.

PKM retrieval returns discoverable definitions with per-binding readiness and
diagnostics. Automatic selection requires a non-ambiguous compatible ready match.
Formal registration, stable reads, privacy, sync and index refresh must be tested
together. Run/evidence records are not portable knowledge merely because they
contain JSON. Scripts remain the implementation carrier with their existing IDs.

Recipe needs a real Action node that pins the contract and stores the child run
reference. Resume reconciles the existing invocation before any retry. Do not
rename a raw command node and claim Action semantics. MCP tools belong to the
automation domain and existing guard/diagnostic paths; the generated server must
copy and register the runtime and expose capability/schema discovery.

## Current implementation and evidence

The source implementation in [action_runtime.py](../../resources/action_runtime.py)
and [action_modules.py](../../resources/action_modules.py) is registered by the
generated unified MCP server in its automation domain. It includes the three
`az dls fs` adapters, persistent generic contracts, typed input/output validation,
pinned nested pipelines, trusted-host program and MCP implementations, managed
artifacts, explicit workspace roots, local cancellation and conservative GC.
Source integration does not prove activation in an already running installed MCP.

The current compiled-language acceptance actually builds a .NET 8 C# module,
invokes a Python Action, and checks its output. Missing build evidence returns
`needs_build`; a changed compiled output withdraws readiness. Background validation
uses a persistent, bounded, single-worker queue with dependencies, deduplication,
priority promotion, aging, cancellation and unknown-outcome reconciliation.
ModuleSet subset export/import, disabled-by-default installation, explicit
load/unload/remove, stable identity retention and unsafe ZIP path rejection have
focused executable tests. Imported packages never carry grants or readiness.

Calls now fail closed unless a local operator-owned smoke record matches the
definition/implementation, environment and expiry. The environment fingerprint
includes runtime, executable and declared build inputs/outputs for generic modules,
but does not capture the full dependency/config/auth context described above.
The generic queue is executable; the legacy Cosmos adapters still lack a production
qualification runner. Unit-test records qualify only their temporary mock;
they are not evidence for the installed Azure CLI or any actual platform account.

The definition digest is now independent of executable availability and includes
the prototype/shared-worker source digest. That coarse digest deliberately
invalidates acceptance on shared-worker changes; implementation-specific manifests
and canonical digest rules are still required for production.

[test-action-runtime.py](../../tests/test-action-runtime.py) passes twelve isolated
Linux tests covering discovery/ambiguity, background argv execution, idempotency,
scope/schema rejection, cancellation, stale/expired/environment-mismatched evidence
and FastMCP registration, including Cosmos being absent from a clean default store.
[test-action-modules.py](../../tests/test-action-modules.py) covers nineteen tests,
including completed-child admission, typed Basic Components, bounded control flow
and real worker wait/answer behavior. Existing
[test-recipe-mcp-runtime.py](../../tests/test-recipe-mcp-runtime.py) also passes after
the shared worker gained Action cancellation-marker support.

These checks used terminal Python 3.11; they do not qualify the editor interpreter
or Windows. The run emits dependency compatibility and detached-process resource
warnings; those are not silently presented as a clean release gate.

Outstanding acceptance: full exact-decimal/date-time wire bindings, Rust-to-Java
execution (no Rust compiler on this host), formal knowledge index/sync integration,
Recipe Action nodes, job-progress adapters, full remote content hashing,
and activation in the user's installed host. An isolated packaged VS Code 1.90
Extension Host passes startup acceptance; that version disables Chat Participants
and uses the Workbench chat fallback. Windows/macOS need their own target-host
qualification; Linux evidence is never a substitute. CLI JSON/exit-code handling
alone is not remote transfer verification.

## ModuleSet and graphical composition

The source extension contributes `PKM: Open Action Workbench`. Its left-hand
searchable standard category tree contains Actions and Basic Components; the
right-hand workspace edits the composition. Its block palette,
parameter forms, draggable blocks and named typed input/output ports lower to
pinned nested pipeline Actions. Connections require identical port schemas unless
the target accepts generic JSON; conversions must be explicit. A cycle, missing input,
unknown port or changed block pin is rejected before saving. Editing withdraws
Run immediately; saving requires a larger definition version. Existing saved
compositions reopen from the palette. Canvas positions remain portable metadata.
Current compositions bind block inputs to literals or earlier output fields;
editable external graph input ports and full-object/artifact bundle connections
remain follow-up work. Browser numeric entry rejects integers outside JavaScript's
exact representation rather than silently rounding an otherwise valid int64.

ModuleSet controls cover subset export, import, explicit enable/unload and removal.
Queue controls expose stage/state, cancel and explicit resume; graph validation
does not block the editor until compilation/testing finishes. Active qualification
is registered with the existing Settings > Background Tasks registry, like search
index refresh and GitHub Sync. The Workbench links to that unified page; its local
table is qualification detail/history, not a second global task dashboard. A
read-only host adapter follows durable validation state even when the Workbench
is closed or MCP enqueues work. The existing registry aggregates status; domain
workers still own execution, priorities and crash-recovery evidence. No second
global scheduler is introduced. A missing local
working directory prompts through the existing machine-setting folder selector.
The approved Linux root is persisted in both machine and runtime settings.
Windows/macOS roots are not inferred. The Workbench honors the automation feature
domain, workspace trust and verified managed Python runtime.

### Category and definition authoring

The palette's Add Group command creates persistent empty groups. A group's context
menu adds subgroups. Action context menus provide Rename, Edit, Delete and Move to;
double-click also opens the definition. Dragging a qualified palette entry onto the
canvas inserts a pinned block at the drop position, without changing its definition.
Instance parameters remain editable independently of definition ownership.

Groups classify Actions; they are not ModuleSets, invocation dependencies or source
folders. Renames and moves are stored separately from semantic definitions and do
not change stable IDs, versions or qualification pins. System core definitions and
the core group are read-only, enforced by both the UI and backend. Imported package
definitions cannot be edited or deleted locally, but local display names and
categories can be changed without rewriting their package.

Local compositions open in the graph editor. Other local Actions open an in-page
JSON definition editor, with a file selector for declared implementation sources.
Definition saves require a larger version and the current content pin. Source saves
require the current file hash, preserve file permissions and withdraw qualification.
Unsaved graph/source drafts survive tab refresh. Concurrent source changes are not
overwritten. Active calls and queued/running qualification block semantic mutations;
deletion also refuses referenced Actions and retains source files and run history.
This trusted-host editor is not a sandbox or a source-folder scaffolding feature.

Language labels come from the host-selected implementation and declared source files,
including nested Action implementations. Python, C# and other recognized languages
are shown directly; Hybrid lists its constituent languages in a tooltip. Unsupported
or ambiguous alternative implementations list their languages separately rather
than claiming mixed-language composition. An MCP carrier is labeled MCP because
its remote implementation language is not known.

### Optional host toolchains

PKM does not bundle or install .NET, Rust, Java or other Action SDKs. Install the
SDK yourself on the execution host, then verify its executable there, for example
`dotnet --info` or `rustc --version`. With Remote SSH this is the remote host, not
the computer displaying the browser. Missing executables fail with actionable
guidance; PKM does not silently install packages or substitute a different SDK.

Settings > General & MCP > General Setting > Optional Action toolchains opens
the machine-scoped `personalKnowledge.actions.toolchains` setting. Optional
bindings map an Action's program name to an absolute executable path:

```json
{
   "personalKnowledge.actions.toolchains": {
      "linux": { "dotnet": "/usr/bin/dotnet", "rustc": "/home/me/.cargo/bin/rustc" },
      "windows": { "dotnet": "C:\\Program Files\\dotnet\\dotnet.exe" },
      "macos": { "rustc": "/Users/me/.cargo/bin/rustc" }
   }
}
```

These are examples, not portable paths. Configure only platforms you use. Bind
the actual program required by the implementation; a Rust Action might use
`rustc` or `cargo`. A C# Action generally needs a .NET SDK, not just the runtime.
If no binding exists, non-Python programs use the execution host's PATH. Action
Python defaults to the managed Action supervisor's interpreter; an explicit
`python` binding affects Action execution, not the separate MCP Python setting.

A configured binding must be an existing executable at an absolute path.
An invalid explicit binding fails instead of falling back to PATH. Program
arguments remain structured; bindings are not shell commands. Executable path,
content and version participate in host qualification, so changing a toolchain
requires rebuilding and requalifying affected Actions. Existing qualification
does not authorize a replacement compiler. No SDK is included in ModuleSets.

### Sleep

`core.sleep` is a read-only Python Basic Component with a required numeric `seconds`
input, default 1, allowing finite values from 0 through 300 and fractional seconds.
Its output is `{ "seconds": requestedSeconds }`. It uses a monotonic wait and checks
cancellation and the existing shared invocation deadline at intervals of at most
50 milliseconds. The current Action budget is 300 seconds, so the remaining parent
budget can interrupt a longer requested wait. Qualification runs the actual wait;
it does not skip Sleep or fabricate completion evidence.

### Browser Workbench

Run `PKM: Open Action Workbench in Browser`, or use the native Workbench's
external-link button to open its current graph, saved pin and active run in a
browser. Both surfaces serve the same editor and use the same guarded managed
Action backend and Knowledge Root, not a copied preview catalog. Graph editing,
qualification, invocation, ModuleSets and chat choices remain available in both.
The browser's Background Tasks button shows the shared Action qualification queue;
the native button opens the existing global Settings page. No new scheduler is
created.

Unsaved graph state is local to each editor. Browser refresh restores that tab's
draft and active run, including pending chat choices. A fresh native handoff takes
precedence over the reused tab's old draft. This is not live synchronization between
editors. Saved definitions and durable runs belong to the common Action store.

The browser uses forms for the execution workspace and ModuleSet import/export
paths instead of native file pickers. Those paths refer to the execution host:
with Remote SSH they are remote paths, not the browser machine's filesystem.
The extension uses VS Code's external-URI forwarding for the loopback service.
Keep the owning VS Code Extension Host running; closing or reloading it stops the
browser backend. This is not an independently deployed web service.

The service listens only on `127.0.0.1` at an allocated port. API requests require
a random bearer capability, approved Host and Origin, JSON content type and a
bounded request body. The launch capability is passed in the URL fragment, removed
from the displayed URL and retained only in tab session storage. Do not share it.
A nonce-based CSP restricts executable content. Every operation rechecks workspace
trust, automation access and managed-runtime health; changing the Knowledge Root
invalidates the old browser service's operations. These controls authorize trusted
host execution; they do not sandbox arbitrary Action implementations.

[test-action-browser.js](../../tests/test-action-browser.js) covers real HTTP
authorization, forwarded origins, static assets and the native/browser request
bridge. The authenticated workflow in
[test-action-workbench.py](../../tests/test-action-workbench.py) uses the production
HTTP server and actual Python supervisor in an isolated store, verifies saved
versions and results, draft/repeated-handoff recovery, chat choice recovery,
loaded icon fonts, persisted groups, protected context menus, palette drag/drop,
language labels, definition/source editing conflicts, Sleep controls and
desktop/mobile layout. Installed-host browser launch and
actual Remote SSH forwarding remain separate acceptance checks.

For an isolated preview without installing or reloading the extension:

```sh
python scripts/action-workbench-preview.py --workspace /tmp/pkm-action-acceptance
```

It prints a free localhost URL and stores preview-only state under the selected
directory. The preview uses the actual Python supervisor and qualification queue,
not simulated success responses. It never writes the user's primary Action catalog.
It binds only localhost and rejects cross-origin mutation requests. The VS Code
Workbench uses native package file pickers; the preview uses host-file path forms.

## Core Basic Components

PKM supplies Basic Components in the `core` group. They are inline compiler/runtime
primitives, not externally registered Actions requiring individual qualification.
Users can still create and explicitly load their own ModuleSets. This change adds
no sync behavior.

| Component | Behavior |
| --- | --- |
| `core.constant` | Typed string, integer, number, boolean, object, array or null |
| `core.lookup` | Dictionary key lookup; missing keys fail unless an explicit default exists |
| `core.file-path` | Resolve a local path within the configured Action workspace; optionally require existence |
| `core.if-else` | Execute only the selected branch |
| `core.switch` | Execute only the matching case, or its explicit default |
| `core.for` | Iterate an array with a required static `max_iterations` limit |
| `core.while` | Recheck a boolean condition with a required static `max_iterations` limit |
| `core.user-action` | Wait for a declared option to be selected in chat |

Loop limits must be integers from 1 through 1000. Reaching a while limit with a
still-true condition fails the run. Control bodies are edited as structured JSON;
nested graphical body editing is not yet implemented. Structural nesting and
execution budgets are bounded independently of Action dependency depth.

Expressions use `$input`, `$step` (`step.field`), `$var` (`item` or `index`) and
two-argument `$op` operations for arithmetic, comparisons and boolean logic.
`{"$literal": value}` preserves arbitrary JSON data without interpreting reserved
expression keys. There is no arbitrary Python, JavaScript or shell evaluation.
Typed output declarations are checked before success.

Math Expression is the sole built-in arithmetic component; standalone legacy
arithmetic Actions are removed. It accepts up to 32 numbered numeric inputs,
highlights supported functions and shows their Python source (for example,
`log` uses `math.log`). Expressions are parsed with a bounded AST, not `eval`.

For example, a `core.for` body can use Math Expression:

```json
{
   "items": [1, 2, 3],
   "max_iterations": 3,
   "body": [{
      "id": "increment",
      "component": "core.math-expression",
      "inputs": {"expression": "{0} + {1}", "input_0": {"$var": "item"}, "input_1": 1}
   }],
   "value": {"$step": "increment.value"}
}
```

Each iteration receives a distinct deterministic child invocation key. Action
effects and readiness remain enforced inside selected branches and loop bodies.

User Action requests persist with the Run, including requests from descendant
Actions. Qualification uses the explicitly declared `test_choice`; real execution
waits for a live answer, cancellation or deadline. The Workbench opens
`@pkm-actions` in native VS Code Chat on hosts supporting Chat Participants
(VS Code 1.91+). VS Code 1.90 and the browser preview use the Workbench's chat area.
No QuickPick, InputBox or system-level notification asks for the choice. Responses
are checked against the declared options and current run state.

[test-action-workbench.py](../../tests/test-action-workbench.py) performs the full
browser-to-supervisor workflow: add two blocks, change parameters, connect ports,
save, background-qualify and invoke (sum 9), reopen/edit/save version 2, export a
selected composition, import into another store disabled, enable and unload. It
also checks 390px-wide layout overflow and captures desktop/mobile screenshots.
These checks do not constitute installed-extension or Windows/macOS acceptance.

### Graph interaction and input presence

Clicking a connection selects it without changing the graph. Remove it explicitly
with the toolbar's Remove selected connection command or Delete/Backspace outside
text controls; Undo restores it. Choose either port first, or drag an output onto
an input. Matching visible ports are highlighted; mismatched schemas require an
explicit conversion Action. Schema key order does not affect compatibility.

Each block can collapse its parameter list; the toolbar also collapses all lists.
Collapsed blocks retain input/output selectors and connection anchors, including
edges to ports not currently selected. Folding, port selection and moving blocks
do not invalidate the already-saved executable graph. An explicit Save still
creates a new registered version, including its current presentation metadata.
Polling preserves focused parameter and graph-name drafts.

Input presence comes from `input_schema.required`: required fields have blue
frames, optional fields gray frames. Optional literal fields are omitted until
their presence checkbox is enabled; disabling it removes the property rather
than sending null, zero, false or an empty string. A connected optional input is
present via its edge. JSON Schema defaults are annotations, not supervisor-side
insertion; each implementation owns its documented omitted-input behavior.

The pure conversion Actions are `core.cast.integer-to-string`,
`core.cast.string-to-integer` and `core.cast.string-to-float`. They require normal
host qualification like other Actions and never silently coerce an incompatible
wire. Integer conversion preserves and checks signed int64 boundaries. Float
conversion accepts decimal/scientific syntax and returns an IEEE-754 binary64
JSON number, not an exact decimal. It rejects malformed input, nonfinite values,
overflow and nonzero values underflowing to zero. Optional `trim` defaults to
false inside that implementation; `trim=true` explicitly accepts outer whitespace.
Thousands separators and locale-specific numeric formats are not inferred.

### Component execution cost

Canvas blocks are DOM elements and connections are SVG paths; opening a graph
does not launch its Actions. Folding avoids rendering every parameter control.
Execution is substantially heavier than arithmetic: `ModuleRuntime.call` checks
contracts/readiness/capabilities, creates a durable invocation/workspace and
starts a Python supervisor worker for every node, even builtins and casts.
`ModuleRuntime.execute` invokes pipeline children in topological order and waits
for each one; siblings are not currently parallelized. Programs add their own
process startup, and the MCP adapter opens a fresh stdio client/server session.
Build outputs are cached, but execution workers are not pooled. This is neither
a streaming scheduler nor a sandbox.

A controlled local Linux/Python 3.11.14 measurement used three qualified calls
per case, fresh invocation keys and an isolated temporary acceptance store:
single addition 709.3/710.5/710.1 ms (median 710.1 ms); two-node addition graph
2168.3/2172.3/2225.1 ms (median 2172.3 ms). This includes `call` plus `wait`
and durable state, excluding UI/API process startup and qualification. It is
host-specific evidence, not a latency guarantee. Current components are suitable
for task-level orchestration, not high-frequency tiny operators. A future pure
node evaluator could batch or fuse calls inside one graph invocation while
retaining node-level diagnostics; that optimization is not implemented here.

Browser regressions cover nondestructive wire clicks, explicit removal/Undo,
drag and reverse-order port selection, folded anchors, retained drafts and
optional omission/colors. Runtime tests cover durable omitted inputs, strict
conversion failures, int64 boundaries and actual add-to-string-to-float nesting.

The unit of optional installation is a `pkm.action.module-set/v1` plugin package.
Installation, enablement, build completion and execution readiness are separate
states. Only enabled sets participate in discovery. Disabled definitions are not
read or executed when listing Action blocks. Unloading retains the package;
removal removes only the installed package version, never run records or exports.
Running calls, queued validation and enabled dependants block unsafe unloads.

A package contains a small manifest, selected definitions with their dependency
closure, declared implementation assets, examples and Git provenance. Export is
explicitly scoped to selected Actions, never the whole catalog. Built-in contracts
remain external pinned dependencies. Package files and manifest are SHA-256
checked, with bounded ZIP sizes/entry counts, traversal/symlink rejection and
immutable `(module_set_id, version)` installation. Local settings, environment
paths, credentials, grants, run state and qualification records are excluded.
No installer hooks, automatic runtime installation or automatic Git execution are
permitted. Hash integrity is not publisher authenticity or a sandbox.

The graphical authoring surface follows the GNU Radio model: a searchable block
palette, typed named input/output ports, parameter controls and data connections.
The stored graph is declarative and language-neutral. Blocks pin logical contracts;
connections refer to output fields, not shell commands. Invalid types, missing
inputs, cycles, ambiguous providers and changed pins fail before execution.
The runtime lowers a valid acyclic graph to nested Action invocations. Users do
not write C#-to-Python process bridges or JSON in the composition UI. Streaming
and GNU Radio's signal scheduler are not implied by this finite Action DAG.

Logical Action identity, display name, contract version and implementation
identity/version are distinct. Implementations explicitly declare target OS,
optional architecture, runtime/Shell and a build manifest. Similar Bash and
PowerShell syntax does not imply compatibility. If multiple implementations match,
require an explicit local binding rather than silently choosing one. A local
variant preserves Git origin and commit; semantic incompatibility requires a new
logical Action. Git reviews/version tags manage portable sources and manifests;
the host keeps selection and evidence private. Git commits/publication are never
performed automatically. Dedicated guided fork/update/rollback UX remains a
separate delivery gate from accepting and preserving provenance metadata.

## Build and background qualification

Source builds declare an argv compiler command, complete source/config/dependency
file list, bounded timeout and expected relative output files. A supervised build
writes only a managed build directory and retains bounded diagnostics. Compiler
path/content/version, source contents, execution OS/architecture and chosen
workspace identify a build. All required output files must exist, remain inside
the owned directory, be non-symlinks and match their recorded digests. Partial or
failed builds do not qualify execution. Precompiled implementations skip building,
not runtime/ABI/permission/contract checks. Undeclared dependency files remain a
manifest-authoring risk; the runtime does not pretend this is a hermetic build.

Qualification performs preflight, required build, controlled example executions,
output-contract checks and a final environment-fingerprint comparison. A passing
record expires after 24 hours. Any relevant binding, source, dependency, runtime
or artifact change makes the old evidence stale. Compilation failure is distinct
from execution-test failure. Readiness belongs to a pinned implementation on an
actual execution host, not to an Action name globally.

Queue priorities are demand, selected graph, explicit ModuleSet, then idle.
Dependencies are queued before dependants, shared requests merge, and higher
priority requests promote existing jobs. Aging prevents indefinite starvation.
The first implementation permits one concurrent qualification worker per store;
it does not preempt an in-flight compiler or unsafe remote operation. Each command
has an output and time bound; total queue history is capped at 2048 records.
Unreviewed history is not silently deleted to make room.

Only pure tests enter automatically. Effectful examples require explicit consent
and existing operator grants. Consent is not permission. Imported or merely
disabled sets never trigger qualification. Cancellation signals the compiler and
local invocation; it never claims remote rollback. A vanished worker marks its
active job `outcome_unknown`, cancels its validation context and requires
reconciliation rather than replaying a potentially mutating example. Queued work
can resume explicitly. Production writes remain behind verified readiness.

## Delivery and acceptance gates

1. Contract foundation: persistent registry and stable reads; validate definitions,
   output schemas, environment bindings and controlled qualification. No evidence
   means no invocation. Wire four Action MCP tools and test actual tools/list.
2. Local composition: begin with pure integer addition, explicit date parsing and
   a managed file-copy Action. Prove parent/child idempotency, output validation,
   scope intersection, budget limits and restart recovery before platform writes.
3. Cross-language proof: C# to Python and Rust to Java through the same protocol;
   cover integer overflow, decimal precision, timezone rejection, child failure,
   concurrent siblings, cancellation and protocol-version disagreement. Missing
   runtimes are blocked, not inferred to work from a Python-only test.
4. Artifact/GC proof: borrowed originals survive; exported files survive; a sibling
   reference prevents deletion; failed runs honor TTL; crashes resume cleanup;
   corrupt manifests and symlink substitution do not trigger unsafe deletion.
5. Cosmos proof: independent upload, download and list qualification; verified
   account mapping; small non-private file plus nested folder roundtrip; compare
   bytes/digests and directory manifests. No automatic overwrite or deletion.
6. Remaining adapters: establish authoritative read-only Cosmos/Singularity job
   progress contracts and mock/live acceptance without submitting jobs. Qualify an
   MCP-backed read-only example separately from a mutating example.
7. Platform/release proof: repeat applicable runtime and real adapter qualification
   on Windows and Linux. Test built package and current live MCP/worker contracts,
   not just source or installed bytes. Unsupported/unverified stays visible.

The authorized Cosmos test scope is the supplied `cosmos08` browser directory,
whose verified account is `bingads-algo-prod-adsplus-c08` and remote path is
`/shares/bingads.algo.prod.adsplus/ProdAdsPlusShare/users/uone/AdHoc/temp/`.
Use a unique child directory and no pre-existing remote data. The user approved
`/tmp/pkm-action-acceptance` on Linux. Read-only directory listing succeeded;
real upload/download acceptance is still outstanding. Windows/macOS roots must
be explicitly selected in `personalKnowledge.actions.workspaceRoots`. If
authentication requires a secret, the user enters it directly in the terminal.

The current native MCP connection still has earlier knowledge/worker activation
gaps; installing matching extension bytes alone did not repair them. Treat Action
activation as another explicit acceptance gate. No publication, version bump,
automatic Reload or shared retrieval-worker restart is authorized by this design.

Reproduce current isolated checks:

```sh
python tests/test-action-runtime.py
python tests/test-action-modules.py
python tests/test-action-workbench.py
python tests/test-recipe-mcp-runtime.py
node tests/test-mcp-stdio-smoke.js
npm run build
node tests/test-ui-build-artifacts.js
```

## Decisions still needing review

- Formal Action storage/index migration and aliases using existing stable PKM IDs.
- Qualification TTL and invalidation boundaries; platform-specific sandbox choice.
- Initial artifact quotas, diagnostic TTL, export retention and managed-root UX.
- SDK packaging and dedicated-pipe framing for the first compiled languages.
- Windows/macOS host staging directories and target-host acceptance.

Review questions: Can a Windows host use Linux evidence? Can a child expand its
parent's grant? Can a stale Action be invoked? Can GC delete the original input,
an exported output or a sibling's live artifact? Does MCP discovery prove that a
tool works? The intended answer to each is no; the delivery gates must demonstrate
those answers in running code, not merely document them.