# Authenticated original-root broker and relay

The cold broker retains its **explicitly reduced `knowledge-content-only/v1`
mode**. A separate same-owner `native-dogfood/v1` increment is described below;
neither mode is original MCP parity. Neither can be activated by an ordinary client, arbitrary workspace
settings or merely possessing a successful byte capture. Native enrollment
must obtain explicit operator scope acceptance and independently verify the
actual profile, installed extension/package and complete maintenance/recovery
bindings. No live profile registration or legacy service termination occurs in
this implementation.

## Provider contract (read-only)

`src/original-mcp-broker-descriptor.ts` exports:

```ts
verifyOriginalMcpBrokerDescriptor(
  path: string,
  independentSha256: string,
  expectedProfileSha256?: string,
): Promise<{
  schema: "pkm.original-mcp-broker-verification/v1";
  root: string; rootDevice: string; rootInode: string;
  workspaceId: string; profileSha256: string; operatorId: string;
  scope: "knowledge-content-only/v1" | "native-dogfood/v1"; writable: boolean;
  nodePath: string; nodeSha256: string;
  relayPath: string; relaySha256: string;
  runtimeBuildSha256: string;
  descriptorPath: string; descriptorSha256: string;
  brokerId: string; brokerPid: number;
  enabledOperationIds: string[];
  disabledOperationIds: string[];
  limitations: string[];
}>;
```

The verifier imports no `RootOwner`, Storage, runtime activation or broker
implementation. It never writes files, reads keyrings, creates admission
brands or returns the socket/token. It verifies descriptor bytes against the
independently retained SHA, exact owned 0700 directory/0600 file, canonical
paths, stable inode/stat pins, socket identity/mode, live broker PID/start
ticks/boot identity, current root/workspace/adoption/commit bindings and pinned
Node/relay files. A supplied profile digest must match exactly.

The provider must verify immediately before spawning the verified Node:

```text
command = nodePath
args = [relayPath, "relay", "--descriptor", descriptorPath,
        "--pin", descriptorSha256]
```

`relayPath` is the pinned `dist/original-mcp-relay-cli.js`. There are **no auth
tokens in argv, environment, stdout, provider settings or verifier results**.
The SHA must come from the trusted offline publisher/inherited readiness pipe,
not be recomputed from an untrusted replacement descriptor as a fallback.
The whole release/dependency closure must independently satisfy native package
integrity; the descriptor's runtime build identity does not replace that check.

## Cold operator API

`startOriginalMcpBroker(options)` in `src/original-mcp-broker.ts` accepts:

```ts
{
  plan: OriginalMcpPlan;
  writerFence: LinuxRootWriterFence; // actual held branded resource
  directory: string;               // existing empty canonical owned 0700 dir
  runtime: {
    node: { path: string; sha256: string };
    relay: { path: string; sha256: string };
    buildSha256: string;
  };
  manifest: Record<string, unknown>; // verified native lifecycle generation
  authorization: {
    schema: "pkm.original-mcp-broker-authorization/v1";
    operatorId: string;
    profileSha256: string;
    planSha256: string;
    acceptedScope: "knowledge-content-only/v1";
    writable: boolean;
  };
}
```

The operator/profile/plan must match custody exactly; scope acceptance and
write mode have no defaults and cannot be changed by relay/client arguments.
The runtime build must match the generation manifest. The broker directory
must be disjoint from original/custody roots; its Unix socket path must fit the
Linux native path limit. Capture/prepare and broker start can retain the same
real branded fence throughout. The broker calls `openOriginalMcpRoot` once,
transferring that exact fence into the actual canonical `RootOwner` and SQL
lease. Existing cold checks are not weakened or given a PID whitelist.

The returned handle is:

```ts
{
  descriptorPath: string; descriptorSha256: string;
  owner: RootOwner; storage: Storage;
  status(): {
    schema: "pkm.original-mcp-broker-status/v1";
    brokerId: string; workspaceId: string; writable: boolean;
    scope: "knowledge-content-only/v1" | "native-dogfood/v1";
    clients: number; pending: number; stopping: boolean;
    reason: "maintenance" | "critical-failure";
  };
  stop(): Promise<void>;
  closed: Promise<{reason: "maintenance" | "critical-failure"}>;
}
```

Only the offline operator/supervisor calls `stop()` (or signals its own broker
process). It closes admission, quiesces **all** client lifecycles, drains real
in-flight operations, closes their transports, then closes the single shared
backend/owner. Cancellation or disconnect never rolls back, aborts or replays
an uncertain mutation. If shutdown fails, preserve state and inspect the
failure; do not infer that the writer lease was released.

Every client gets a fresh SDK `StdioServerTransport(readable, writable)`,
server/facade and lifecycle. Client close/quiesce closes only that session;
its backend close hooks cannot close shared storage or other clients. Warm
clients may attach after VS Code starts, without reopening the root or
re-running cold-owner admission. A new owner process still requires the
ordinary cold gate.

## Same-owner native dogfood API

`startOriginalMcpNativeBroker(options)` takes the same plan, held branded fence,
private empty broker directory, pinned runtime, lifecycle manifest and optional
Git protection, plus **already-open** `owner: RootOwner`, `storage: Storage`,
and `nativeHost: OriginalMcpNativeHost`. Authorization has the same exact
operator/profile/plan fields but requires `acceptedScope: "native-dogfood/v1"`;
`writable` remains explicit. The old broker does not accept this scope, and the
native broker does not accept the old or `preserve-existing-mcp/v1` scope.

The native broker validates genuine instance brands, the owner's actual full
Storage attachment, live host admission, root/workspace/plan/profile and pinned
original catalog. It never opens/reopens/replaces a root owner. Calls use the
existing same-owner original-full dispatcher and hybrid module aliases
(`note_read`, `note_modify`, `skill_read`, etc.), with fresh exact native public
approval rather than archived permissions. Canonical Todo/Memory channels are
not part of this increment.

Its descriptor adds `nativeHost: {receiptSha256, catalogSha256, catalogRevision,
authorityId, epoch}`. Availability additionally contains
`unconditionalOperationIds` and `conditionalOperationIds`: 25 operations pass
the current implementation gate before read-only filtering; the three content
update operations are separately conditional because retained-private-reference
moves remain unsupported. `enabledOperationIds` is their disjoint union;
every remaining catalog ID is disabled. Read-only mode filters all mutations.
Additionally, `knowledge_file_trash` is conditionally exposed only for a
writable broker with the genuine current native Trash port bound to the same
Storage/host. A captured root, writable flag, or separately registered unrelated
producer alone does not enable it. Script sources require custody v2 or v3;
Prompt sources require explicitly enrolled fresh v3 custody. Each call retains
the exact public and target-specific Trash approvals and no-replay rules.
Canonical restore/purge channels are not exposed by this broker condition.
The default availability query without a native port remains unchanged.
Semantic/graph/auto routes still require separately admitted native model/corpus
state. These counts do not certify every argument, native authority, live
installation, or full151 parity.

Client close/quiesce closes only that client. Native host revocation immediately
revokes business admission and drains the broker. `stop()` drains all admitted
client operations and closes only broker-owned backends/transports, **never**
the bootstrap-owned owner, Storage, host or root fence. The bootstrap must stop
the business broker before closing its owner. Drain failures reject both
`stop()` and `closed`; preserved state requires inspection, not write replay.
Maintenance draining tracks complete SDK responses, not just backend completion,
and flushes queued socket writes before closing transports. The listening socket
identity remains intact through final in-flight descriptor checks; new clients
are refused while admission is closed.

Descriptor replacement/permission changes, failed root/runtime bindings or
SQL lease loss revoke the broker and drain it. Unknown changed control files
are left for operator inspection, not overwritten/deleted as recovery.

## Private descriptor and handshake

`descriptor.json` is created no-replace as owned 0600 after binding socket `s`
as 0600 inside the owned 0700 directory. Its exact versioned schema is:

```text
schema: "pkm.original-mcp-broker/v1"
brokerId: UUID
descriptorPath: canonical absolute path of this exact descriptor
root: {path, device, inode}
workspaceId: UUID
planSha256, profileSha256, operatorId
scope: "knowledge-content-only/v1" | "native-dogfood/v1"
writable: boolean
runtime: {
  node: FilePin, relay: FilePin, buildSha256
}
process: {pid, startTimeTicks, bootId}
socket: {path, device, inode, mode: 384}
availability: {enabledOperationIds, disabledOperationIds, limitations}
// native-dogfood only: nativeHost binding and the two availability partitions above
token: 64 lowercase hex characters from 32 random bytes

FilePin: {path, device, inode, size, mtimeNs, ctimeNs, mode, uid, sha256}
```

Runtime files must be canonical, owned by root/current user, single-link,
non-special and non-world-writable. Group-write modes require an owned private
ancestor; no original modes are changed to make validation pass.

Before any MCP bytes, the relay verifies its descriptor/runtime and sends one
newline-terminated `pkm.original-mcp-auth/v1` record containing brokerId,
descriptorSha256 and token. Authentication is limited to 2048 bytes, two
seconds and at most 32 simultaneous connections; pipelined pre-auth MCP bytes
are refused. Tokens are compared in constant time. Only after a matching
`pkm.original-mcp-auth-result/v1` acknowledgement and a second unchanged
descriptor check does the relay forward **raw** stdio bytes.

The transport boundary retains numeric source lexemes, including across
chunking, so `version: 1.0` and `version: 1e0` cannot become accepted integer
`1` through JSON reserialization. Repeated request IDs have independent
lexical decisions. Unexpected broker exit closes the relay non-successfully;
there is no reconnect, owner spawn or automatic request replay.

## Exact reduced availability

Discovery advertises only the enabled IDs. `check_version` and the private
descriptor include the exact full `enabledOperationIds`, `disabledOperationIds`
and limitations for the operator-selected mode.

Enabled content IDs, when present in the pinned native catalog:

* `mcp.tool.get_note`, `mcp.tool.list_notes`, `mcp.tool.search_notes`
* `mcp.tool.get_skill`, `mcp.tool.list_skills`, `mcp.tool.search_skills`
* `mcp.tool.get_paper`, `mcp.tool.get_research`, `mcp.tool.list_papers`,
  `mcp.tool.list_research`, `mcp.tool.search_papers`, `mcp.tool.search_research`
* Writable authorization additionally enables `mcp.tool.add_note`,
  `mcp.tool.update_note`, `mcp.tool.add_skill`, `mcp.tool.update_skill`,
  `mcp.tool.add_paper`, `mcp.tool.update_paper`.

Every other ID in the pinned catalog is explicitly disabled, including
automation/Actions, indexed/graph retrieval, scripts, Chat, memory,
subscriptions, private snapshots, worker/Todo APIs, Trash restore/purge and
other legacy runtime authority. Unsupported indexed arguments on an enabled
search/get operation still return `NOT_AVAILABLE`, not a silent fallback.
Standard compact discovery/lifecycle envelopes remain available. No descriptor
or approval asserts original MCP parity or imports old private permissions.

## Cold CLI and tests

Cold supervisor entry point:

```text
node dist/original-mcp-broker-cli.js serve --request PRIVATE_JSON --pin SHA256
```

The private 0600 request schema is
`pkm.original-mcp-broker-request/v1` plus `plan`, `directory`, `runtime`,
`manifest`, `authorization` as above. It must be independently pinned.
The CLI acquires a fresh real cold fence and revalidates the original plan;
same-process API startup is required when retaining a pre-existing capture
fence. The supervisor must provide an inherited pipe at **fd 3**. Readiness is
written only there:

```json
{"schema":"pkm.original-mcp-broker-ready/v1","descriptorPath":"…","descriptorSha256":"…"}
```

Keep the readiness channel/pin independent of mutable provider configuration.
SIGTERM/SIGINT of this operator-owned CLI performs the same draining shutdown;
there is no global shutdown command available to MCP clients.

`tests/original-mcp-broker.test.mjs` uses real SDK stdio relay subprocesses and
real source-controlled original-layout fixtures. It covers shared canonical
lease/fence ownership, concurrent/warm clients after a VS-Code-shaped process
starts, per-client quiesce/close, cancellation and once-only writes, decimal/
exponent/duplicate-ID lexical versions, denied capabilities/write modes,
wrong tokens/pins/profile/location, private modes, replaced descriptors,
private CLI readiness and unexpected broker death. These are isolated
regressions, not live profile/cutover qualification.
