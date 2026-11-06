# PKM Next Server - isolated foundation

Experimental, standalone Node/TypeScript Core. This package does not participate in
the current extension's build, startup, configuration or installation. It never
imports the legacy Knowledge Root. Do not point it at existing PKM data.

## Run

Requires Node >=22.18.0. Node's built-in `node:sqlite` is experimental on Node 22;
its warning is intentional. No Python or VS Code process is needed.

```sh
cd next-server
npm ci
npm test

# The target directory must NOT already exist. Its parent must exist.
node dist/cli.js init --data /absolute/path/to/new-pkm-next-data

# Generate a local secret; do not commit or log it.
export PKM_NEXT_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
node dist/cli.js http --data /absolute/path/to/new-pkm-next-data --port 0
```

The HTTP command prints one JSON readiness line with its actual loopback URL.
`--port 0` selects a free port; an explicit port is also supported.
Stop with Ctrl+C/SIGTERM. Pending storage work drains before shutdown.
No server is automatically installed or left running by the test suite.

HTTP example (substitute the port from readiness):

```sh
curl http://127.0.0.1:PORT/v1/capabilities_search \
  -H "Authorization: Bearer $PKM_NEXT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

For MCP, configure a **separate** test server in your client:

```json
{
  "command": "node",
  "args": [
    "/absolute/path/to/next-server/dist/cli.js",
    "mcp",
    "--data",
    "/absolute/path/to/new-pkm-next-data"
  ]
}
```

MCP uses the actual SDK stdio protocol, not HTTP tool emulation. Protocol output
is reserved for stdout; diagnostics go to stderr. The client launching the process
is trusted, so stdio does not use the HTTP bearer secret. Add `--read-only` to
either transport command to restrict that process to read authority.
HTTP and MCP processes may share the same **new** workspace.
The HTTP API is JSON RPC-like POST, **not** MCP Streamable HTTP.

## Shared contracts

Both adapters use exactly one Core registry and executor. Five bootstrap methods
are available as MCP tools and `POST /v1/<method>`:

| Method | Input | Purpose |
| --- | --- | --- |
| `server_info` | `{}` | Isolation, limits and supported features |
| `capabilities_search` | Optional `query`, `offset`, `limit`, `revision` | Bounded authorized catalog summaries |
| `capabilities_describe` | `operation` | Exact version, input/output JSON Schema and authority |
| `capability_read` | `operation`, `version: 1`, `arguments` | Read-only operation |
| `capability_call` | `operation`, `version: 1`, `arguments` | Write-authorized mutation |

The read-only MCP process omits `capability_call` entirely. Its catalog excludes
mutations. HTTP retains the route but the Core denies mutations.

Six canonical operations:

- `knowledge.document.list`: metadata-only pages ordered by document ID.
- `knowledge.document.get`: full content and deletion state.
- `knowledge.document.create`: caller supplies stable document ID and UUID `operationId`.
- `knowledge.document.update`: replaces title/content with `expectedRevision`.
- `knowledge.document.trash`: retains content, sets deleted state using revision CAS.
- `knowledge.document.restore`: restores retained content using revision CAS.

Example mutation arguments after discovering/describing its contract:

```json
{
  "operation": "knowledge.document.create",
  "version": 1,
  "arguments": {
    "operationId": "f2811195-c5cd-4be6-933c-7f47155da0aa",
    "id": "example-document",
    "title": "Example",
    "content": "Only in the new isolated workspace."
  }
}
```

Core responses use `schema: "pkm.next-result/v1"`, a unique per-attempt `requestId`,
and exactly one `result` or `error`. Operation responses also identify the canonical
operation/version/catalog revision. Errors identify `code`, `message` and `effect`
(`not-committed` or `unknown`). HTTP pre-dispatch failures use the same envelope;
malformed MCP protocol/tool arguments may instead be rejected by the SDK itself.

### Concurrency and retry

- Document revisions and workspace revision advance in the same SQLite transaction
  as the mutation, actor receipt and result. Writes are serialized by SQLite,
  including writes from different server processes.
- `expectedRevision` is mandatory on update/trash/restore. Conflicts never
  automatically overwrite current content.
- Every mutation needs a fresh UUID `operationId`. For a lost response or unknown
  outcome, retry the **identical normalized request with the same operationId and
  actor**. This returns the original persisted result without writing again,
  including after restart or later edits. Never generate a new operationId merely
  because the transport timed out.
- Reusing an operationId for different arguments, operation or actor is a conflict.
  Receipts do not expire in this foundation; retention/compaction is future work.
- To page safely, reuse `workspaceRevision` from the first document page, or
  `revision` from the first catalog page. A changed revision requires restarting
  pagination. This detects changes; it is not a retained historical snapshot.

## Isolation and operational limits

- Initialization exclusively creates a new directory (mode 0700 where supported)
  and workspace marker (0600). Existing directories are refused, not adopted.
- Opening requires that marker and allows only the marker and SQLite database/WAL/
  SHM files. Root/entry symlinks are rejected; parent paths are canonicalized.
  This is an accidental-misconfiguration guard, not a sandbox against another
  local process/user able to replace workspace files.
- The database uses WAL, `synchronous=FULL`, transactional receipts and a 3-second
  busy timeout. Synchronous SQLite work runs in a dedicated worker thread so it
  does not block the HTTP/MCP event loop.
- The worker admits at most 32 pending requests per process; HTTP also admits at
  most 32 active requests. Saturation is an explicit `BUSY`, never a silent drop.
  These limits are per-process, not a global distributed scheduler.
- HTTP binds only `127.0.0.1`, requires a bearer secret of at least 32 characters,
  rejects browser Origin/non-loopback Host, and has no CORS support. Request body
  limit: 128 KiB; request/header timeout: 10 seconds; idle socket timeout: 15 seconds.
  Document content limit: 100,000 characters, independently of HTTP's byte limit.
- The transport is a trusted local owner or read-only principal, not multi-user
  authentication, document-level ACLs or remote hosting. Clients must treat document
  content as untrusted data, not instructions.
- No migration or backup command exists yet. Do not copy only `core.sqlite` while
  processes are running: committed data may be in WAL. No downgrade from an unknown
  database version is attempted. Never modify real PKM data to test this package.

## Scope and verification

`npm test` builds only this package and tests fresh temporary workspaces, real HTTP,
real SDK MCP child processes, cross-process CAS, durable replay after restart,
trash/restore, permissions, strict input/output shapes, bounded queue draining,
event-loop responsiveness during a write lock, pagination conflicts, invalid
workspaces, CLI startup, unsupported database versions and committed-WAL recovery
after an abrupt process exit. This does not simulate hardware power failure.

This is the first runnable foundation, **not a replacement for the existing PKM
server**. It does not yet include legacy Notes/assets/Todo/Memory migration,
browser UI, Chat/execution/approval state, online embedding learning/retrieval,
Python compute adapters or optional Teams plugins. No throughput/latency/capacity
improvement is claimed without representative workloads and SLO benchmarks.
The next step is independent Browser/Chat on these boundaries, followed by
feature parity, migration/rollback and qualification before any cutover.
