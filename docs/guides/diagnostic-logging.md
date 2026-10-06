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