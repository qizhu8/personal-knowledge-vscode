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
resource resolution or output behavior. Registration rechecks the contract and
the existing dependency-readiness/revision guards. No dry-run grants execution.

## Minimal CLI Lifecycle

1. Copy `authoring.examples.cli` from capabilities.
2. Check it, then call `action_register({"definition": ...})`. Retain the returned
   `action_id` and `content_hash`.
3. Have the operator review the exact implementation and grant its pinned
   `action_id`/`content_hash` trusted host execution. This is **not sandboxed**.
   The existing local policy is at
   `<knowledge-root>/.pkm/state/actions/policy.json`; an authorized operator entry
   has `action_id`, `content_hash` and `trusted_host_execution: true` in `grants`.
   Do not have an agent grant itself permissions or copy production credentials
   into definitions.
4. Call `action_validation_enqueue` with the exact ID/hash. Read
   `action_validation_status`, then `action_get`. Validation executes the
   declared smoke examples on this host; it is not a static check.
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

## Read-Only HTTP Example

`authoring.examples.http_get_json` is an actual Python program implementation:
HTTP GET only, five-second request timeout, 64 KiB response bound, JSON decoding,
no retries, no redirects and no authentication. It accepts `{"url": ...}` and
returns `{"response": ...}`. A non-2xx response, invalid JSON or oversized body
cannot return successful output. This minimal adapter does not implement
domain-specific 401/403/404/network diagnostics.

There is deliberately no default live smoke URL. In an isolated workspace, start
an authorized loopback fixture returning JSON and add its URL to `examples`,
then check/register the resulting definition. Grant the exact revision and
enqueue qualification with `allow_effects: true`: even read-only network access
is an effect requiring consent. This does not authorize cloud access. Changing
the fixture/example changes the revision and requires a corresponding grant.

The executable regression serves a real local HTTP endpoint and follows
register -> grant -> qualify -> call. It also checks 403, invalid JSON and the
response bound. It does not access any external service.

## Read-Only Pipeline Status and Durable Monitoring

Call `action_template_create` with your chosen `action_id` and
`parameters: {"template_id":"azuredevops-pipeline-status"}` to explicitly register
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
or read-only test run in a new definition revision, grant and qualify that exact
revision before calling it.

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
