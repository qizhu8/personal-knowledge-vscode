# Managed PKM MCP generations

Run `npm run test:mcp-lifecycle` to build coherent bundles and execute the
generated-runtime/Chat connector Node tests plus real FastMCP concurrency tests.
The fixtures use the existing repository `.venv` and a `python` on PATH with
FastMCP available. All server instances and generations belong to isolated test
directories; this command does not upgrade or reconnect production clients.

Generating a server is **not** upgrading an existing MCP connection. In particular,
an already connected 2.17 process keeps executing its old code. Generated version
constants, a detected PID, provider registration and listed tools are not proof
that the connected process upgraded.

## Runtime ownership

The unified managed entry remains `<managed directory>/server.py`. It is now a
stable launcher that reads `latest-generation.json` (or the original
`active-generation.json` for pre-migration installs) once and executes one complete
generation under `generations/<id>/`. A generation contains:

- Generated unified and internal Chat Python modules and their Python/JS helpers.
- A private copy of bundled `dist` and runtime resource code, including the shared
  Knowledge mutation/asset/deletion-journal implementation.
- An immutable Recipe compiler and its configuration.
- `manifest.json`: generation, extension version, component schemas, Node executable,
  enabled feature domains, runtime build digest and individual file hashes.

The launcher verifies hashes before importing the server. Knowledge helpers use
the generation's runtime, not an installed extension or development fixture path.
Removing an old extension directory therefore cannot redirect an in-flight Skill
write into a different implementation.

Generation is serialized across extension windows. Failed staging leaves the
predecessor active. Only a complete generation is published through the atomic
pointer. Old generations are deliberately retained: do not remove them while
clients may still be using them. There is no automatic generation garbage
collection.

Compatible publication retains `active-generation.json` as a marked compatibility
baseline for already-running lifecycle implementations that read only that file;
new launchers and hosts use `latest-generation.json`. Thus an older session is not
silently upgraded, fenced or terminated merely because new code was installed.
An incompatible publication changes the baseline first, fencing old admission,
then commits the latest pointer. An incomplete incompatible transition fails
closed. Both pointers remain account-owned control files, not drain receipts.

The Python environment is shared, not copied into every code generation.
Managed Create/Repair serializes maintenance, blocks new launcher starts, and
refuses in-place dependency changes/replacement when a managed process is running
or its safety cannot be established. Close all PKM clients first, preserve/review
uncertain writes, or select a new empty runtime path. On Windows passive process
inspection is unavailable, so an existing possibly active environment is not
silently replaced. This protection does not authorize changing external runtimes,
nor does it make external/manual `pip` invocations safe.

## Admission and bounded draining

New instrumented unified processes install `ManagedMcpLifecycle` as outer FastMCP
middleware. Each actual call checks the shared generation before admission.
An unchanged API contract permits old processes/windows to keep using their
discovered tools. Component schema major versions, the explicit
`pkm.mcp.api/1` contract and enabled feature domains determine compatibility,
not extension version equality or a new build hash. New tools require discovery
on a newer connection; they are not invented in an old catalog. Backwards-
incompatible argument, response, storage or write semantics must bump the
component API major or the explicit API contract, even for a patch release.
Feature-domain removal, incompatible/unknown API transitions, explicit quiesce,
maintenance and unavailable control still fence admission. Already admitted
calls continue against their original generation.

`mcp_lifecycle_status` reports:

- `accepting`: this process owns the current or a compatible retained generation.
  `updateAvailable` distinguishes a compatible update without claiming a reload.
- `draining`: superseded, with actual calls still in flight.
- `action-required`: the 30-second drain budget expired and calls remain.
- `drained`: this instrumented process has no remaining admitted calls.
- `retired`: a superseded, instrumented managed server closed its own stdio
  session normally after real calls and responses completed.

New managed generations retire themselves after a one-second quiet period only
when a valid successor pointer fences admission, tracked actual/uncertain calls
are zero, no protocol handler is active and lifecycle control/registry remains
available. The owned read pipe is cancellation-aware so an idle client keeping
stdin open cannot pin the old process indefinitely. This uses the FastMCP
lifespan and underlying MCP stdio session; the normal SDK stdin worker cannot
be cancelled while blocked on input. Explicit quiesce, maintenance, missing or
invalid control alone never authorize retirement. Legacy already-running
processes do not acquire this behavior retroactively and are never signalled.

The deadline is an observation/action boundary, **not** a forced cancellation or
claim that writes stopped. Cancellation by a caller does not remove an executing
write from the in-flight ledger: the execution is shielded and counted until its
actual completion. A caller that lost its response must inspect durable state
before deciding what to do. No automatic tool replay, process signal, restart,
external-server termination, or native-client trust bypass is performed.

`check_version` and `mcp_lifecycle_status` remain callable after fencing so that
clients can discover the boundary. Fencing is sticky; rolling back a pointer
cannot re-enable an already superseded instance.

The owned Chat connector closes local admission immediately on close/lifetime
cancellation. It calls `mcp_lifecycle_quiesce` on that same transport to fence
that process before observing drain; this also fences tools queued but not yet
admitted. The control is omitted from the Chat model's catalog. Only verified
zero actual/uncertain calls allows closing the owned transport. Timeout,
ownership mismatch or lost observation leaves action-required and does not
terminate uncertain writes; an explicit later close can retry observation.
The local drain-observation deadline does not cancel an outstanding lifecycle
control request. A delayed response may still arrive after action-required;
this does not resume local admission or permit automatic tool replay. Control
RPCs retain their independent bounded transport timeout.

Instance files under `instances/` are metadata-only observations. Stale/missing
heartbeats mean **unknown**, not drained or stopped. An instance registry never
establishes that the current Chat/native MCP client is ready.
Config keeps routine unverified connection observations in neutral collapsed
details, not a permanent global failure banner. Fresh draining, uncertain or
control-error observations keep actionable warnings and expanded details.

## Successor handshake and client integration

After the client explicitly reconnects, use the **same connected transport** to
list tools and call `check_version` plus `mcp_lifecycle_status`.
`handshakeManagedMcpConnection(directory, invoke, toolNames)` verifies the active
generation before/after those calls; `invoke` must return each tool's decoded
structured payload, not the MCP content envelope.
It validates the connected process against its own immutable manifest and checks
that its API remains compatible with the configured successor. The Chat connector
keeps using that actual generation/catalog across compatible publications rather
than rejecting every subsequent call because a different generation exists.

`waitForManagedMcpDrain(oldInvoke)` bounds observation of an already fenced
connection (30 seconds by default). Only `state === "drained"` permits closing
that owned connection without interrupting tracked calls. Missing lifecycle
support, an accepting/unfenced old process, timeout, cancellation of execution,
or transport loss is `action-required`, never fabricated completion. Handshake
reads also have a bounded timeout. Neither helper reconnects or closes a client
on its own; the caller must apply the relevant client's explicit controls.

`verifyManagedMcpHandshake(manifest, version, lifecycle, toolNames)` is the pure
validator. It requires unified/component versions, generation/build identity,
accepting admission, exact enabled domains, advertised managed-lifecycle support,
and required Skill-write/Chat tool presence. Only its `state === "ready"` result
justifies a connected-ready claim. A generated/current server is still merely
configured until this handshake succeeds.

For an uninstrumented old process, missing lifecycle discovery, stale
observations, or a failed handshake, show **Reconnect / action required**. Do not
claim automatic drain completion. Existing 2.17 connections cannot be retrofitted
with middleware; clients must close/reconnect them through their own controls.
The separate legacy standalone Chat entry is not a managed unified connection;
move those registrations to the unified launcher explicitly.

For extension/Chat wiring, import the helpers from `mcp/mcp`. After generating
the successor, the host must treat the old connection's drain result separately
from the successor's readiness:

```ts
const boundary = await waitForManagedMcpDrain(invokeOldDecodedTool);
if (boundary.state !== "drained") {
  // Surface action-required; do not automatically close/replay uncertain calls.
  throw new Error(boundary.reason);
}
await oldOwnedConnection.close();
// Connect a new owned client using mcpServerDefinitionData().
const readiness = await handshakeManagedMcpConnection(
  managedMcpServerDirectory(), invokeNewDecodedTool, actualNewToolNames,
);
if (readiness.state !== "ready") throw new Error(readiness.reason);
```

The adapter functions above invoke tools on their respective **actual**
connections and decode structured JSON. They must not route discovery to a
different temporary probe process. For native/external registrations the host
cannot substitute `oldOwnedConnection.close()`; show the client's explicit
Reconnect action and then verify that client's actual tool surface. The
configured-state UI can display `mcpStatus().lifecycle`, whose connection state
deliberately remains `unverified`.

Its exact fields are `state: "unverified"`, `connectionState: "unverified"`,
`generation`, `configuredGeneration`, `reason`, `action`, and `instances`.
With a coherent manifest, `reason` starts: “Managed runtime prepared; actual
client connection not yet verified.” Local integration preparation can be ready
for Host migration/reload coordination without claiming any external/native
client has completed its own handshake.

## Focused validation

```sh
node --test tests/test-mcp-lifecycle.js
node --test tests/test-chat-managed-mcp.js
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python tests/test-mcp-lifecycle.py -v
node_modules/.bin/tsc --noEmit
```

The JavaScript suite stages/publishes real generations, tests corruption and
failure handling, verifies strict handshakes, then starts the actual generated
unified FastMCP server and performs Skill add/update after removing its source
extension fixture. The Python suite uses actual concurrent stdio/FastMCP clients
to test multi-window fencing, bounded draining, explicit MCP cancellation with an
uncertain write, failure cleanup, and missing/malformed generation control.
All fixtures remain under the repository's `tests/` directory.
The Chat suite additionally verifies same-client manifest identity, same-version
legacy/build-mismatch rejection, successor generation changes, and actual
threaded-write cancellation/close timeouts. The generated-server integration
also writes a Skill through the production Chat connector after extension removal.
