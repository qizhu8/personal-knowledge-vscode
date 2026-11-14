# Registered Python environment Workflow trial

## Supported, executable subset

1. Start a **fresh isolated Next trial** with `PKM: Start Isolated Next Trial`.
2. Run `PKM: Run Registered Python Environment Workflow Trial`.
3. Pick an existing `pyenvList()` registry entry. No arbitrary path picker is
   provided. In a trusted VS Code workspace, review the workspace, actor,
   registered environment ID, root, interpreter, canonical target and fixed
   `print(7)` script in the explicit modal confirmation.
4. The real Workflow scheduler dispatches the Python script through the existing
   Runtime Process service. The command displays `succeeded: 7`, environment ID
   and run ID, or an explicit failure/unknown result. No automatic retry occurs.

Actual call graph:

```text
extension.activate -> registerNextManagedTrial
  -> registerNextPythonEnvironment -> pyenvList picker + modal
  -> PythonEnvironmentAuthority.select/validate
  -> NextManagedClient.runPythonTrial
  -> forked managed-client-child [private Node IPC: python-trial]
  -> runHostPythonWorkflow
     -> compileWorkflowDefinitionV1 (environmentId only)
     -> WorkflowExecutor.create/tick (pinned native script adapter)
     -> private child challenge -> host revalidates exact handle digest,
        registry, workspace, actor, trust and current client
     -> RuntimeProcessService.launch/waitCaptured
     -> selected absolute interpreter ["-I", "-B", "-"], fixed script via stdin
  <- bounded status/stdout/exitCode; host checks successful output is exactly 7
```

This is a user-started, one-run diagnostic Workflow, **not** unrestricted
execution of imported Workflow scripts. The native `runHostPythonWorkflow`
composition accepts a host-configured script, not a Core/MCP/CLI script argument.
The installed private child only supplies the fixed `print(7)` script and rejects
extra IPC fields. The existing public Workflow executor remains unchanged;
there is no new HTTP/MCP launch, executable/path field or authority operation.

## Authority and persistence

The legacy `src/servers/pyenvs.ts` registry is machine-local. An environment ID
in a portable Workflow definition is not executable authority.
`PythonEnvironmentAuthority` binds a uniquely registered ID to the exact
workspace and actor. It validates canonical root/parent paths, the registered
conventional interpreter path, executable access, and root/entry/target
filesystem identity and timestamps. Both host and child refuse stale/mismapped
handles. Child admission also verifies the isolated root inode and workspace
marker before and after the one-use host challenge. Changed registry mappings,
wrong workspace/actor, denied trust, altered handle digests and missing host
approval fail closed.

Virtualenv interpreters commonly symlink to system Python. The selected
absolute interpreter entry is executed, **not** its resolved target, preserving
virtualenv identity. Both are pinned. The process has an explicit empty
environment: no PATH fallback, inherited credentials, Python options, pip,
package installation or requested network operations. Python is not a sandbox:
the selected interpreter and its startup files run with OS user permissions.
Pins detect changes; they do not prevent same-user replacement races between
validation and process creation. This path does not claim containment of
arbitrary Python or descendant processes.

The read-only handle crosses only the existing private fork IPC; it is not
stored in global configuration, workspace, archive, backup or MCP responses.
Workflow and Runtime records for this diagnostic use a private in-memory SQLite
connection, closed after the invocation. The result exposes only IDs, bounded
stdout, state and exit code; no interpreter paths. This diagnostic is not a
durable/resumable Workflow run.

Every command creates a new authority and requires selection/confirmation
again. Authority is revoked after the run. Restart and backup/restore inherit
neither handles nor mappings, even when a restored workspace retains its ID.
The current command refuses imported/read-only/resumed experiment clients;
start a fresh isolated trial and explicitly reselect the environment. No
restored run is silently adopted.

## Validation and remaining scope

`tests/test-python-environment-authority.js` and
`tests/test-next-python-workflow.js` cover real Python-created private venvs,
the production picker callback (VS Code APIs mocked), verified packaged child
IPC, real Workflow and Runtime invocation, process failure, second host
revalidation, handle tampering, workspace/actor/stale-root refusal, real
workspace backup/restore and fresh-client remapping. This is Linux evidence,
not native Windows or interactive VS Code UI evidence.

Run without shared `dist` output or package installation:

```sh
node_modules/.bin/tsc -p tsconfig.json --outDir .environment-run-root-build
next-server/node_modules/.bin/tsc -p next-server/tsconfig.json --outDir next-server/.environment-run-next-build
PKM_ENV_AUTHORITY_BUILD="$PWD/.environment-run-root-build" \
PKM_ENV_NEXT_BUILD="$PWD/next-server/.environment-run-next-build" \
node --test tests/test-python-environment-authority.js tests/test-next-python-workflow.js
```

Use fresh output names for concurrent work. Root output is CommonJS; Next output
must remain under its ESM package. Tests require `/usr/bin/python3` to resolve to
a root-owned non-group/world-writable system Python; they create an owned `0700`
fixture and run `venv --without-pip`, with no network or user environment changes.

The final targeted regression run passed **62 tests**, using the same two strict
builds, plus:

```sh
mkdir -m 700 .environment-regression-check
PKM_ENV_AUTHORITY_BUILD="$PWD/.environment-run-root-build" \
PKM_ENV_NEXT_BUILD="$PWD/next-server/.environment-run-next-build" \
PKM_TRIAL_EXTENSION_DIST="$PWD/.environment-run-root-build" \
PKM_TRIAL_TEST_ROOT="$PWD/.environment-regression-check" \
PKM_TRIAL_SERVER_DIST="$PWD/next-server/.environment-run-next-build" \
node --test --test-reporter=dot \
  tests/test-python-environment-authority.js tests/test-next-python-workflow.js \
  tests/test-next-managed-startup-lifecycle.js tests/test-next-trial-resource-ui.js \
  tests/test-next-trial-structured-ui.js tests/test-next-trial-document-editor.js
```

Changed files in this slice:

- `package.json` (one command contribution)
- `src/servers/pyenvs.ts` (read-only registry readiness check)
- `src/runtime/python-environment-authority.ts`
- `src/runtime/next-managed-client.ts`
- `src/ui/next-python-environment.ts`
- `src/ui/next-managed-trial.ts`
- `next-server/src/host-python-workflow.ts`
- `next-server/src/managed-client-child.ts`
- `tests/test-python-environment-authority.js`
- `tests/test-next-python-workflow.js`
- `docs/design/python-environment-host-authority.md`

**Still not migrated:** arbitrary stored Python Workflow execution and durable
resume, conda/venv/uv creation, unregister/delete, folder migration, package
maintenance and remote/model downloads. Legacy deletion does not establish
exclusive ownership and must not be exposed without second explicit confirmation
and stronger dedicated managed-ownership checks. This trial changes none of
those paths and does not complete the entire environments workstream.
