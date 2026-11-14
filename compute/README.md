# Isolated Chat computation foundation

This is an internal **computation adapter**, not a complete Chat-memory migration.
No HTTP/MCP dispatch, Core integration, model provider, Markdown ingestion, cache
rebuild, authorization, or production lifecycle is installed by this foundation.

`pkm_memory_engine/` is a byte-identical capture of the original Python package.
`../migration/compute-provenance.json` records source commit, source Git blobs,
byte sizes, and SHA-256 hashes. Run `node next-server/scripts/capture-compute.mjs
--check` from the repository root to verify reproducibility. Recapture only
deliberately with the same command without `--check`.

## Trusted-host integration API

Import `ChatMemoryWorker` and types from
`next-server/src/compute/chat-memory-worker.ts` (built as
`dist/compute/chat-memory-worker.js`).

```ts
const worker = await ChatMemoryWorker.open({
  python: "/absolute/path/to/python3",
  runtimeDirectory: "/absolute/dedicated/runtime/partition",
  database: "/absolute/dedicated/runtime/partition/chat-memory.sqlite3",
  identity: "trusted-account-and-root-partition",
});
await worker.beginTurn({ scope, turn, input: { id, text } });
// Execute returned model requests in the host, then explicitly continue/commit.
await worker.close();
await worker.reopen(); // Explicit restart; never replays any prior request.
```

The interpreter must support Python 3.10+ and stdlib SQLite with WAL. Launch uses
fixed `-I -S -B -u` arguments, a bundled fixed script, no shell, and an isolated
environment. Interpreter/data paths and limits are **host configuration only**,
never caller-provided command lines. Database must be a direct regular-file child
of a canonical non-symlink runtime directory. Keep it separate from the Knowledge
Root. Do not open real/legacy data merely to initialize this adapter.

Lifecycle: `open(options)`, `close()`, `reopen()`; observations: `healthy`, `state`,
`processId`, `ready` (defensive copy), `diagnostics` (bounded raw stderr tail).
`close()` rejects unsent queued work, lets one active request finish, closes stdin,
and waits for process exit; the close deadline terminates a stuck child.

Named APIs (parameter fields retain the Python protocol's snake_case):

* Policy: `beginTurn`, `continueTurn`, `abortTurn`, `commitTurn`, `turnReceipt`,
  `readMemory`, `overview`, `enforceCapacity`, `forgetScope`.
* Reads: `readPiece`, `listPieces`, `neighbors`, `sources`, `changes`, `embedding`,
  `children`, `parents`, `usage`.
* Mutations: `createPiece`, `appendStatement`, `linkPieces`, `commitSummary`,
  `putEmbedding`, `touchPiece`, `acquireLease`, `releaseLease`, `evict`,
  `purgeChat`; each takes `(operationId, params)`.

All return `Promise<ComputeResult>` (object or array); response payloads preserve
the captured engine semantics. Full request parameter types live in
`src/compute/contracts.ts`. There is **no public generic/raw request API**, worker
path override, argument list, SQL endpoint, or explicit-memory API.

`ComputeError` exposes `code`, `outcome`, and `diagnostics`. Transport failures
mark submitted mutations `unknown`, submitted pure reads `read-only`, and unsent
requests `not-submitted`. A structured worker rejection is `rejected`.
`readMemory` is conservatively classified as a mutation because it touches usage.
Never infer a failed transport means rollback. Reconcile Chat turns using
receipts and authoritative Markdown history before deliberately resubmitting.
Operation-ID deduplication exists for engine mutations, but is **not** an
automatic retry policy; policy mutations have their original turn semantics.

## Storage and bounds

Markdown Chat/knowledge and Node explicit-memory records remain authoritative.
This worker exclusively owns its **runtime SQLite schema 2**: computation
pieces/statements, summaries, embeddings, leases, operation receipts, and turn
state. Captured schema initialization also creates unused explicit-memory tables;
the restricted wrapper denies **all** explicit-memory methods. Those tables are
not an authority and are never populated by this adapter.

Deleting the runtime database loses cached computation/turn state; reconstruction
from Markdown is a future host responsibility, not implemented here.

Defaults: startup/request deadlines 10 seconds, close deadline 2 seconds, 64
pending requests, 16 MiB aggregate queued+active bytes, 8 MiB request/response
frames including newline, 16 KiB raw stderr tail. Configurable validated bounds
are documented by `ComputeOptions`. Only one frame is submitted at a time;
request deadlines include queue wait. Fatal startup/protocol/IO/timeouts kill the
worker, reject all pending promises, and never restart or replay automatically.
Unresponsive children receive SIGKILL after a 250 ms termination grace.

## Disposable verification

From `next-server`, after the existing build:

```sh
COMPUTE_TEST_PYTHON=/absolute/path/to/python3 node --test tests/compute.test.mjs
```

Tests use project-local disposable fixture directories and actual subprocesses,
never a real Knowledge Root. Fault executables and POSIX process-signal tests
are skipped on Windows; normal captured-worker lifecycle/protocol/storage tests
remain portable when `COMPUTE_TEST_PYTHON` names the configured interpreter.
