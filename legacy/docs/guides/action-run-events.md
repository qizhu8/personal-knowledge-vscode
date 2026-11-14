# Action run events

The native Action runtime persists a run snapshot and its lifecycle events in the
workspace SQLite store. Events are written in the same transaction as the state
transition they describe. The production MCP read path is
`capability_read` with operation `action.runtime.events`:

```json
{
  "operation": "action.runtime.events",
  "version": 1,
  "arguments": {
    "runId": "action_run_...",
    "after": 0,
    "limit": 50
  }
}
```

`after` is an exclusive sequence cursor: start at `0`, then pass the final
returned event's `sequence` to read the next page. Pages contain at most 100
events and report `oldestSequence`, `latestSequence`, and `gap`. Events and run
snapshots are scoped to the authenticated actor and the already-isolated
workspace database. Event payloads contain lifecycle metadata only, not Action
inputs, raw child output, or environment data.

The runtime retains at most 8,192 events per run. It does not prune old events:
when the bound is reached, it fails closed instead of silently replacing
history. On host restart, interrupted `running` or `cancelling` runs transition
to `unknown`; native effects are never replayed, and `unknown` is not reported as
success. A failed or interrupted direct child likewise remains unknown unless
the native result protocol proves a terminal result.

This is not a migration of every older Action producer. The original source has
no source-equivalent durable typed checkpoint/resume-token store, validation
queue job producer, or process-scoped diagnostic event journal. The durable
native run snapshot and event sequence are not substitutes for those contracts;
no legacy or historical records are synthesized. Those operations remain
unavailable until their original producer and ownership/recovery protocol are
available. GPT/function validation remains a manual, optional action and is
not an execution gate.

## Focused verification

From the repository root, the following commands build into a dedicated
next-server output directory (not the shared `dist`) and run the real child,
restart/recovery, actor-isolation, production MCP paging, and CLI regressions:

```sh
npx tsc -p next-server/tsconfig.json --outDir next-server/.pkm-action-events-build
PKM_ACTION_BUILD="$PWD/next-server/.pkm-action-events-build" node --test --test-name-pattern='Action compiler source executes|strict result validation|cancellation fences|real direct-child crash|host crash during|parallel Action branches' next-server/tests/action-runtime.test.mjs
PKM_ACTION_BUILD="$PWD/next-server/.pkm-action-events-build" node --test next-server/tests/vscode-action-trust-bridge-e2e.test.mjs
PKM_ACTION_BUILD="$PWD/next-server/.pkm-action-events-build" node --test next-server/tests/trusted-action-cli.test.mjs
```
