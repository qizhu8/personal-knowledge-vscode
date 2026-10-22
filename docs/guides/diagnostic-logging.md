# Bounded Diagnostic Logging

PKM keeps the latest 100,000 structured diagnostic records **per writer**, not one shared global log. Each extension host or MCP process creates its own writer ID (`PID-UUID`), so logging does not acquire the Subscription mutation lock or a cross-process write lock. Different hosts, restarted processes and previous writers remain separately inspectable; this is not a global 100,000-row disk quota. Old inactive writers must be removed separately after incident review.

## Storage and Events

- Extension: `<VS Code globalStorage>/diagnostics/extension/`. The Personal Knowledge Manager output channel prints the directory and writer ID at initialization. The old shared `personal-knowledge.log` is no longer appended to; existing files are not deleted or migrated.
- Unified MCP: `<Knowledge Root>/.pkm/state/diagnostics/mcp/`. `runtime.started` includes the process and parent PID.
- JSONL files contain one event per physical line. Each writer retains at most 101 segments of 1,000 records: the extra segment preserves an exact latest-100,000 query without rewriting a large file on every event. Retained physical rows are bounded by 101,000 per writer; queries never exceed 100,000.
- New files are created with mode `0600` and directories with `0700` where the platform supports those modes. Existing directory permissions are not changed.
- Records are capped at 4 KiB. Writes fail open: storage errors do not replace tool results or exceptions; the next successfully written record exposes a cumulative `dropped` counter. Records are best-effort, not fsync-backed crash guarantees.

MCP records `mcp.call.started`, `mcp.call.returned`, `mcp.call.failed`, `mcp.call.cancelled`, and `mcp.call.waiting` every 30 seconds while a call remains pending. A unique `callId`, tool name, hashed transport/request IDs, PID and duration correlate the boundaries. Arguments, results and exception messages are not recorded. Exception type is recorded; a returned result is not necessarily a successful business outcome.

The extension retains existing level-filtered operational messages as `extension.log`; these messages are truncated to 1,024 characters and should still be reviewed before sharing. It also records `host.started`, `host.stopped` on normal disposal, and a `host.heartbeat` every 60 seconds. Heartbeat delay of 5 seconds or more produces a warning. Heartbeats are independent of the configured operational log level.

## Query and Export

The unified MCP exposes the read-only `diagnostics_latest(limit=100)` tool for its **current writer**. Valid limits are 1-1,000. Its response includes the directory, writer ID, recent records, configured `max_rows` capacity and cumulative `dropped_records` count, including when the log directory is unavailable. A tail query may include its own start event; its return event is only available to the next query. Avoid repeated polling or dumping the full retention window into an Agent conversation.

For a local export, use the dependency-free Python helper bundled in `resources/diagnostic_log.py` and copied alongside the generated MCP server. Omit `--writer` to list available current and historical writers:

```sh
python3 resources/diagnostic_log.py --directory "$PKM_ROOT/.pkm/state/diagnostics/mcp"
```

Then supply an ID from that list or the MCP query:

```sh
python3 resources/diagnostic_log.py \
  --directory "$PKM_ROOT/.pkm/state/diagnostics/mcp" \
  --writer 'PID-UUID' --latest 100000 > pkm-diagnostics-latest.jsonl
```

The same helper reads extension logs by substituting their directory and writer ID. `--latest` defaults to 200 and supports 1-100,000. Exports are ordered oldest to newest within the selected tail. Partial JSON lines are skipped, and export does not mutate source logs. Separate active-writer tails are not an atomic cross-process snapshot.

## Interpretation and Activation

`mcp.call.started` without a terminal event narrows the wait to the PKM middleware boundary. `mcp.call.returned` means that boundary returned, **not** that the response reached Copilot or that Copilot's `sendMessage` queue settled. PKM cannot instrument the external Copilot Agent Host queue with this mechanism. Correlate its `agenthost.log` and `~/.copilot/session-state/<runtime-session-id>/events.jsonl` separately, retaining both logical-chat and runtime-session IDs.

Waiting events are progress observations, not automatic failures; long chat standby calls can legitimately produce them. An event-loop stall can prevent its own timers from running. Missing heartbeats alone do not distinguish a blocked host, a stopped process, a logging failure or storage loss; delayed heartbeats only measure delay after execution resumes.

These changes take effect after building/installing the updated extension, regenerating the unified MCP server through the normal setup flow, and starting the new host/process. Changing repository sources does not retrofit existing running processes. The diagnostic tools do not restart hosts, regenerate the live runtime, cancel calls or fix the underlying Copilot queue incident.

## Resource Attribution and Test Cleanup

Measure these separately: the shared Extension Host, the detached PKM Sync
service, retrieval workers, per-host Memory workers, and desktop Webviews.
Copilot's Agent Host/runtime and other extensions' language servers are not
PKM-owned processes. Extension Host RSS alone cannot identify an extension's
retained heap. A Linux server sample also cannot explain a Windows renderer OOM.

For Linux measurements, report RSS alongside PSS where permitted. Summed RSS
double-counts shared pages; PSS apportions those pages. Sample CPU-time deltas
over a known interval rather than interpreting lifetime `%CPU` as current load.
Disk `read_bytes`/`write_bytes` deltas are process I/O accounting, not network
traffic, total disk occupancy, or a guaranteed sustained rate. Preserve process
start identity when comparing samples so PID reuse cannot look like growth.
Do not collect full command lines, request bodies, or heap snapshots by default.

Sync and retrieval deliberately survive an Extension Host restart. Tests must
therefore stop their isolated services **before** deleting fixture directories:

- The startup, installed-context and four-window Chat runners use
  `scripts/stop-fixture-services.js`.
- Cleanup checks that storage, knowledge and home resolve inside the fixture.
  Sync uses its authenticated safe-idle drain; retrieval verifies the endpoint
  token and PID before requesting shutdown. It never signals an arbitrary PID.
- Cleanup failure is explicit and preserves the fixture rather than deleting
  the worker's endpoint/token. This is not automatic garbage collection of
  historical processes or production stores.
- `npm run test:resource-consumption` builds and checks polling plus detached
  service survival/exit, scope rejection, repeat cleanup and retrieval endpoint
  mismatch protection. Installed-host acceptance remains a separate test; an
  isolated HOME may need the existing `PKM_CHROMIUM_EXECUTABLE` override.

A 61.568-second read-only Linux sample on 2026-10-22 found 24 historical
installed-context fixture services: about 2,146 MiB summed RSS but 730 MiB PSS,
with about 15.4 MiB of accounted disk writes during that interval. Ten retrieval
workers used about 1,795 MiB RSS / 1,681 MiB PSS; nine referenced missing state
directories and need separate ownership/lifecycle review, not blind termination.
The installed Sync service used about 529 MiB RSS / 485 MiB PSS at sample end.
These are observations on an existing workload, not a clean-install baseline,
leak proof, load benchmark, or Windows OOM diagnosis. The installed-context
initial/restart acceptance passed after the cleanup change and left zero net
new fixture services; historical processes were not stopped by that test.

## Copilot Tool-Search Timeout Investigation (2026-10-22)

This incident concerns the surrounding development Agent, not a PKM Chat model
request or a submitted GitHub Sync operation. The observed installation was
VS Code 1.143.0 with bundled Copilot Chat 0.71.0.

### Confirmed boundaries

- Tool call `call_27QD57l85K8Wqy2dOC8h9evs` started at
  `02:08:32.178Z`. Its input requested PKM capability/version tool discovery.
- The runtime's external request
  `e2e2e75b-bf38-40a0-965e-1334b41d7f2a` expired at
  `02:38:32.213Z` with no response, using a 1,800-second timeout.
  The session recorded tool failure at `02:38:32.225Z`.
- The Agent Host forwarded that failure as a tool completion at
  `02:38:32.246Z`; the search adapter then logged an empty match list at
  `02:38:32.248Z`. That empty list is **not** a successful search result:
  it followed the timeout failure.
- Earlier tool searches in the same session completed normally. The Agent Host
  continued logging during this wait; the interval is not evidence of 30 minutes
  of model generation or a completely stalled Agent Host.

### Installed implementation and isolated mechanism probe

The installed Agent Host adapts `toolSearch` to `tool_search_tool`. With client
ownership, it registers a pending response, emits `chat/toolCallReady`, and waits
for the client completion. The pending-response registry has no independent
deadline. A separate host-local matching path exists for calls without a client
contributor; no use of that fallback was logged for this call.

The receiving Copilot tool is not just a local name lookup. It awaits its tool
embedding profile/cache initialization, a query embedding, and candidate tool
embeddings before ranking. Those method boundaries do not impose a short search
deadline. This establishes possible inner waits, **not** which one occurred.

A network-free probe evaluated the actual installed tool factory and pending
registry with stubbed dependencies. It verified immediate host fallback without
a client contributor, pending client-owned search without a response, and
completion after an explicit failure. This validates the handoff mechanism, not
the original client's receipt, a disconnection reproduction, or the reason its
response was missing. No installed files were changed.

### Separate MCP failure and remaining evidence gap

The same runtime lost `http://localhost:41125/stream` at `02:12:24Z` and received
connection-refused errors. The Agent Host identifies that endpoint as **Pylance
MCP** and reports failed initialization at `02:13:14.499Z`. Its old Extension Host
also exited at about `02:12:24Z`. This is concrete stale-bridge evidence, but it
does not prove that Pylance caused the tool-search wait that began four minutes
earlier. Another management connection disconnected at `02:07:45Z`; it must not
be attributed to this Chat without a client/window identity match.

Available logs do not establish whether the search reached its receiving tool,
waited in authentication/cache/embedding work, or lost its completion during
handoff. The tool-search phase messages are trace-level; the available receiving
log has no matching receipt/phase record. Do not label this an embedding network
outage or blame Notion/trading based on their later startup.

Development using local tools can continue without repeating discovery. This is
a workaround, not restoration of MCP-dependent development. A lasting fix belongs
at the Copilot client/Agent Host boundary: bounded search-specific execution,
explicit client ownership/receipt and phase timings, disconnect-aware failure,
and safe cancellation/late-result handling. Do not shorten all tool timeouts,
patch installed vendor bundles, disable all MCPs, or replay side-effecting calls.
The next decisive evidence is a bounded receiving-side trace correlated with
the tool-call ID, not another unattended 30-minute retry. Official
[Copilot issue guidance](https://github.com/microsoft/vscode/wiki/Copilot-Issues)
recommends targeted Window/Copilot Chat trace and reviewed request IDs; raw debug
exports can contain private content and must not be uploaded automatically.