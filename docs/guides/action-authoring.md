# Authoring Actions Through MCP

## Discover Before Registering

Call `action_capabilities()` and read:

- `authoring.definition_schema`: JSON Schema 2020-12, including the implementation
  union and required fields.
- `authoring.examples`: copyable CLI and read-only HTTP definitions.
- `execution_host`: the hostname, OS, architecture and path/identity boundary.
- `authoring.lifecycle` and `authoring.limitations`: what registration,
  qualification and execution do, and what they do **not** guarantee.

The legal user implementation kinds are `program`, `pipeline` and `mcp`.
`python` is a **program**, not an implementation kind. Neither `command` nor
`http` is an implementation kind. HTTP integrations require a reviewed program
or pinned MCP adapter.

`registry` and workspace paths belong to the MCP execution host. A caller's
terminal may be on another machine; a missing path there does not prove a
registry failure. There is no per-call remote host selector. Workspace roots,
toolchains, OS account and credentials are operator-managed on the execution host.

## Check Without Executing

Call `action_definition_check({"definition": ...})` before registering.
It checks the schema, reserved IDs, component structure, declared effects,
existing local revision and exact dependency pins. It returns JSON Pointer paths:

```json
{
  "ok": false,
  "diagnostics": [{
    "path": "/implementations/0/kind",
    "code": "enum",
    "message": "Choose a supported implementation kind.",
    "allowed_values": ["program", "pipeline", "mcp"]
  }],
  "persisted": false,
  "executed": false,
  "readiness_checked": false,
  "next_action": "fix_definition"
}
```

The actual response also includes a schema identifier. Passing this check is not
proof of CLI availability, authentication, grants, dependency qualification,
resource resolution or output behavior. Proposal submission rechecks the contract;
admission rechecks exact dependency revisions and readiness. No dry-run grants execution.

## Minimal CLI Lifecycle

1. Copy `authoring.examples.cli` from capabilities.
2. Check it, then call `action_register({"definition": ...})`. This submits a
   **proposal**, not a formal library entry. Retain `proposal_id`, `action_id`
   and `content_hash`. The response is `state: "pending_operator_approval"`,
   `registered: false`, `callable: false`, `next_owner: "operator"`.
   `action_proposals()` lists pending submissions.
3. Stop and ask the operator to open **Action Workbench**. Pending proposals appear
   under **Components > Actions** with **Need Validation** and a highlighted flask.
   Click the flask to start review-first validation, or double-click the row to
   inspect it in the right-hand canvas. The
   right-hand canvas shows purpose, input/output fields, execution commands or
   composition steps, declared risks, host, version changes and source files.
   The full JSON and fingerprints are optional **Advanced details**, not the
   primary review UI. Click **Validate: risks and environment tests**. This
   requests Agent risk information followed by the declared tests, not immediate
   admission. Select a callable VS Code review model (model credits may apply).
   The Agent explains risks, not grants or denies permission. Findings and incomplete
   assessments are shown for explicit user confirmation before execution.
4. Review the smoke-effect consent dialog and Agent risk notice. Cancelling either
   executes nothing. Only passing environment tests admit and
   qualify the exact version. Test failure preserves the previous
   approved definition. Validation feedback shows review progress, cancellation,
   errors or success. Read `action_get` afterwards to inspect readiness.
   Direct non-builtin MCP validation returns `ACTION_CODE_REVIEW_REQUIRED`:
   hand off to the Workbench instead of bypassing review or editing local policy.
5. When availability is `ready`, call:

```json
{
  "action_id": "example.cli.echo",
  "inputs": {"value": "hello"},
  "idempotency_key": "operator-selected-stable-key",
  "content_hash": "<hash returned by registration>"
}
```

6. Attach `action_run_wait` to the returned original `run_id`. The expected output
   is `{"value":"hello"}`. A bounded wait returning `wait_expired` does not mean
   success, failure or cancellation; attach to the same Run again.

Program arguments are fixed argv strings, never a shell command. Action inputs
arrive as JSON on stdin. The program must emit one JSON value on stdout matching
`output_schema`; extra logging belongs on bounded, redacted stderr. Inputs are
not substituted into argv. Wrap a fixed CLI with code that validates input,
constructs argv without a shell and transforms the result.

External source files should be listed in implementation `files` so changes
invalidate the host fingerprint. Qualification pins the definition and host
environment, is time-limited and does not transfer to another host.

### Updates and Existing Definitions

An update requires a larger version and a new proposal. The previous approved
definition stays in the formal library and remains usable until the new revision
passes review and smoke tests. Admission checks that the base revision, implementation fingerprints
and exact dependencies have not changed during review. Qualification does not
automatically transfer to the new version.

Save changed source at a **new versioned path**, declare it in `files`, and submit
the updated definition. Workbench source editing cannot overwrite an approved
implementation. These are PKM lifecycle guards, not filesystem isolation: external
tools can still modify files, making existing qualification stale.

`action_template_create`, `action_graph_save` and Workbench definition/composition
saves follow the same proposal process. A composition draft is not runnable while
pending; after successful review and tests the unchanged draft reconnects to its admitted revision.
Existing definitions and enabled imported ModuleSets without admission appear
under **Pending operator review**, not the callable library. Use **Review in
canvas**, then **Validate: risks and environment tests** to qualify and admit them; no silent migration or
agent self-approval occurs. Built-in system Actions are preinstalled exceptions.

## Trusted Host Execution Authorization

If an agent encounters:

```text
ACTION_HOST_TRUST_REQUIRED: Missing operator approval for this exact Action revision; this is not a definition/schema error.
```

the selected `program` or `mcp` implementation has no matching operator grant.
The error also supplies the exact Action ID, registered content hash and local
operator policy path, followed by an explicit agent stop/operator handoff.
Older installed versions use the shorter message
`Operator must grant this pinned implementation trusted host execution; this is not a sandbox.`;
it means the same gate.
This is an execution trust gate, not a Portal permission or a schema error.
Build, qualification and execution can reach this gate. Registering a definition
does not grant execution permission, and a later authorization error does not
by itself prove that registration failed. Do not repeatedly register the Action
or change its version to work around this error.

The grant matches both the exact `action_id` and `content_hash`. A grant for
another revision does not authorize this one. A `pipeline` does not require this
direct implementation grant, but its executable dependencies still require their
own authorization and qualification. **Every non-builtin pipeline still requires
operator admission**, so wrapping a program in a pipeline is not a bypass.
`ACTION_ADMISSION_REQUIRED` means formal admission is missing; direct policy
editing cannot admit a pending proposal.

### Action Library and Operator Review in Workbench

**Automation > Action Library** (or **PKM: Open Action Library**) opens inside
the existing PKM extension panel. Its resizable folder tree lists admitted Actions,
including those needing revalidation, with readable names and readiness badges.
Expand/collapse folders or navigate with arrow keys; search also matches descriptions
and expands matching paths. Library and Workbench retain their own selection and
view state. Search and inspect
without opening Workbench. Ready public Actions support explicitly approved typed
invocations; Run details can be opened in Workbench. Pending proposals do not appear
in Library. Select **Open in Workbench** on an Action to explicitly locate it there;
an unsaved Workbench draft requires confirmation before replacement.

Open **PKM: Open Action Workbench**. No catalog modal opens automatically, including
when restoring an older tab. A short next-step notice tells you to click a highlighted
flask. The left tree includes pending proposals and unapproved definitions under
**Actions**; every non-ready public Action has a **Need Validation** label and a
highlighted flask. Pending rows cannot be exported or added to a composition.
Showing them does not admit or authorize them, and the previous approved version
remains the executable catalog version until admission succeeds.

Click the flask beside an Action to validate its exact proposal/revision. Double-click
a pending row to inspect the implementation first. **Review / test Actions** shows
only next-step guidance initially; the full catalog is under its Advanced disclosure.
Click the toolbar refresh button to fetch newly submitted proposals without reloading
the VS Code window. The right-hand review canvas shows the execution
host, inputs, outputs, selected implementation, risks and source files; its
optional Advanced details includes the full definition, exact revision, policy
path and source-file fingerprints. Click Validate to start the Agent review/test
pipeline. Review the referenced source files too;
fingerprints are not a code audit. Programs, build commands and MCP servers run
with the host's OS permissions and available credentials, not in a sandbox.

Builtin and pipeline Actions execute PKM host code rather than declared source
files; their review material includes the exact executing handler source and
is covered by the review snapshot hash. `core.artifact.copy` smoke tests copy a
reserved fixture artifact created only inside the isolated qualification store.

Clicking an Action's flask first offers **Cancel**, **Validate this action**, and
**Validate all possible actions**. Cancel (or Escape) executes nothing. The single
option validates the selected revision; the all option uses the same batch flow
as **Validate all needed**, including pending proposals and effect confirmation.

**Validate all needed** takes a snapshot of every public **Need Validation** row
(including pending proposals). Confirm the batch's declared effects and inspect
exact examples in **Smoke test inputs**, then select one review model. PKM reviews,
tests and admits each pinned revision independently, sequentially. A failed item
does not prevent later items from being checked; the final summary lists every
success and error. Successful admissions are retained, not rolled back when another
item fails. Cancelling model selection executes nothing. Root/trust changes block
further execution/admission. Refresh and inspect readiness before retrying an
interrupted batch; no uncertain smoke execution is replayed automatically.
During a batch, Workbench displays completed/total progress, the current Action,
review/test/admission stage and elapsed stage time in one line. Results are
collapsed by default; expand **Results**, then an individual Action to read its
complete failure reason. The final line shows passed/failed counts. Review
has a hard three-minute deadline even if the model provider ignores cancellation;
the timed-out item fails without smoke execution and the remaining queue continues.

Action `dependencies` pins other Actions, not arbitrary Python imports or CLI
packages. Implementation source/helpers must be included in declared fingerprinted
files and fit the review limits. Describe required external toolchains explicitly
and pin executable files where available. The Azure DevOps status adapter uses
core Azure CLI `az rest` GET (no azure-devops extension), a self-contained bounded
command runner and existing host authentication. Its authoring factory accepts
the intended version/examples; factory defaults are not an executing Action.

In the Workbench category tree, **Add group** creates a root folder; right-click
a folder and select **Add subgroup** to create a child. The dialog shows the parent
path. **Move to** offers all writable folders, including full nested paths.
Successful creation/moves expand the destination; failures stay visible inside the
dialog instead of appearing behind it. The Core tree remains read-only.

Clicking Validate is the operator's authorization for this review/test attempt.
Source and definition are provided to the selected review model as untrusted
data. The model describes risky operations and uncertainty; its verdict is not
an execution veto. The user confirms the pinned version, risks, effects and test
inputs before tests in an inline card inside the Workbench (one card for a whole
batch: every selected Action is assessed first, then a single **Run all** starts
the tests). The browser Workbench, which has no progress channel, uses a concise
native confirmation instead. Unanswered cards expire after 15 minutes and count
as Cancel. Missing models, timeouts or malformed responses produce an
explicit incomplete-assessment warning that also requires confirmation, not a
success-shaped fallback. Source size limits stop preparation instead of truncating it.

Exact bundled core revisions skip the model and run their controlled examples as
environment self-tests. They still require workspace/effect consent and a passing
test result. A `core.*` name alone does not qualify for this path. Self-tests cover
actual execution and output contracts; artifact-copy tests also verify a distinct
artifact with identical content. Neither a passed test nor user consent certifies
safety or removes OS permissions, revision, dependency or environment checks.

Smoke tests execute in a separate qualification registry, with exact-version
execution permissions scoped to that registry. The formal registry and previous
approved version stay unchanged. After passing tests the host rechecks Root and
workspace trust; admission rechecks source/base/dependencies and environment
before preserving unrelated policy fields and saving qualification/admission.
Failed tests retain evidence in the local qualification-attempt directory.
Tests may still have real effects: a staging registry is not an OS sandbox.

Opening the review canvas never executes anything. **Back to canvas** and
**Cancel review** preserve the original draft. The detail page retains native
confirmation for **Revoke host execution for this revision**, not a separate
manual grant flow. Browser Workbench uses the same trusted host orchestration.
There is no MCP/generic-dispatch operation for injecting a code-review pass,
grant or admission. Agents should direct the operator to Validate and wait.

### Local Review State

Pending proposals, exact-revision admissions and execution policy live under
`<knowledge-root>/.pkm/state/actions/` on the execution host. These are
operator-managed state, not agent-editable authoring inputs. Editing only
`policy.json` does **not** admit a proposal or move it into the registry.
Use the native review workflow instead of asking an agent to patch local files.
Portal permissions, Chat tool approvals and workspace trust do not imply admission.

Use the native **Revoke host execution for this revision** control to withdraw
future admission/authorization. It also removes the revision from the formal
library. Revocation does not undo effects or guarantee termination of existing
work. Explicit qualification, effect approval and available host credentials
remain separate requirements.

## Read-Only HTTP Example

`authoring.examples.http_get_json` is an actual Python program implementation:
HTTP GET only, five-second request timeout, 64 KiB response bound, JSON decoding,
no retries, no redirects and no authentication. It accepts `{"url": ...}` and
returns `{"response": ...}`. A non-2xx response, invalid JSON or oversized body
cannot return successful output. This minimal adapter does not implement
domain-specific 401/403/404/network diagnostics.

There is deliberately no default live smoke URL. In an isolated workspace, start
an authorized loopback fixture returning JSON and add its URL to `examples`,
then check/submit the resulting definition. Click Workbench Validate to review
and qualify the exact revision, consenting to its smoke effects: even read-only network access
is an effect requiring consent. This does not authorize cloud access. Changing
the fixture/example changes the revision and requires a new review/test attempt.

The executable regression serves a real local HTTP endpoint and follows
privileged test setup -> qualify -> call. Public Workbench flows additionally
test Agent review before staged qualification/admission. It also checks 403, invalid JSON and the
response bound. It does not access any external service.

## Read-Only Pipeline Status and Durable Monitoring

Call `action_template_create` with your chosen `action_id` and
`parameters: {"template_id":"azuredevops-pipeline-status"}` to submit a proposal for
the Azure DevOps query adapter. It uses the host's existing Azure CLI identity;
it never logs in, changes identity, queues a pipeline or cancels remote work.
The host CLI binary, when present at authoring time, is pinned in argv and
fingerprinted with the adapter source. Missing CLI/authentication/permission,
not-found, ambiguous access/not-found, network and malformed-response failures
are typed. Raw CLI stderr is not exported. The adapter reads bounded build/task
status, not complete pipeline logs.

The query input is `organization`, `project`, and decimal **string** `run_id`.
Its output includes `remote_id`, `pipeline_id`, `observed_at`, `url`, raw
`status`/`result`, normalized `terminal` and bounded active/failed task metadata.
`completed/failed`, `completed/canceled` and partial success are terminal too.
Registration includes no live smoke input. Add an explicitly authorized fixture
or read-only test run in a new definition revision, then click Workbench Validate:
Agent review and passing smoke tests must admit that exact revision before calling it.

For monitoring, use `action_template_create` with:

```json
{
  "action_id": "example.pipeline.monitor",
  "parameters": {
    "template_id": "monitor",
    "query_action_id": "<qualified read-only query ID>",
    "query_revision": "<exact content_hash>",
    "query_inputs": {
      "organization": "https://example.visualstudio.com",
      "project": "Example",
      "run_id": "123"
    },
    "interval_seconds": 30,
    "timeout_seconds": 3600,
    "max_iterations": 120
  }
}
```

This template reuses the existing scheduler/Run/step receipts. Its query must
require string `remote_id`, boolean `terminal` and `result` in its output schema.
It preserves the full actual query output, including optional fields.
Definitions are pinned and qualification remains separate; creating the template
does not start monitoring or grant permissions.

The observation envelope includes the original PKM Run ID, remote ID, last
observation/time, next check, original deadline, attempts, remote result,
whether remote work may remain active and an explicit stop reason:
`remote_completed`, `observation_timed_out`, `query_failed` or `cancelled`.
The active state is `observing`. A timed-out observer, a query failure, or a
non-success remote terminal result does **not** return a successful Action Run
that a Recipe could use to authorize later writes. Authentication/permission
failures are displayed as Blocked.

The Workbench shows observation/remote status and next check, with the complete
envelope on hover and in the Run receipt. Its **Stop Monitoring** operation
cancels only the observer and descendant read queries, never the remote pipeline.
Reattach with `action_run_get`/`action_run_wait` to the original Run; waiting and
API-process restart do not reset the observation deadline or create a new remote
task. A stopped/terminal observer is not automatically restarted.

### Notification Delivery and Reconnect

`action_run_wait` accepts `after_sequence`. While attached, it returns promptly
when a new monitor event is available, including `event_delivery.next_sequence`.
Store that cursor only after consuming the result. Reconnect using
`action_run_events(run_id, after_sequence)` or another bounded wait; repeating
the same cursor replays retained events without executing a query.

This is replayable pull/active-wait delivery, not a promise to wake a disconnected
agent. The latest 256 events are retained per Run; `gap: true` explicitly reports
an older cursor outside retention, and the current Run/observation remains
available. No claim of exactly-once notification processing is made.

### Compatibility with Generic Poll

The `poll` template pins an exact read-only Action revision and validated inputs.
Its `field` must be a declared **top-level** output field and its `expected` value
uses equality. For a pipeline status adapter, expose `terminal: true` for **all**
remote terminal outcomes, including failure/cancellation; do not wait only for
`result == "succeeded"`. The generic HTTP example is not that domain adapter.

`core.poll` persists its clock, per-attempt receipts and scheduler timer
checkpoints. Waiting does not require a long-lived chat shell. Existing regression
tests cover success, timeout, original Run receipts across API restart and
cancelling an active read query. `status: "timed_out"` is an observation result,
even if the Action Run successfully returned that result; it does not mean
remote failure or remote cancellation.

The older generic poll output remains `status`, `attempts` and selected `value`;
use `monitor` when observation-specific error and continuation gates are needed.
An OJS-specific HTTP/auth adapter, cloud submissions/reconciliation, unsolicited
Chat wakeup and native Windows/macOS/live-cloud qualification remain separate
acceptance gates, not capabilities inferred from the local fixture.
Keep large OJS identifiers as strings across JSON, storage and URL construction.
Keep remote submission/reconciliation, GPU use and destructive operations behind
separate explicit approval; a monitor must never hide automatic submission.

## Repeatable Local Acceptance

```sh
npm run test:action-authoring
```

Use an existing Python environment with FastMCP/jsonschema; the JavaScript MCP
tests also accept `PYTHON`. The gate includes an actual fake Azure CLI executable,
registered query -> qualification -> persistent monitor -> tool-delivered events,
as well as timeout, failed terminal, typed auth error and cancellation. This is
local fixture acceptance, not live cloud or Windows/macOS acceptance.
