# PKM Memory Engine 0.1.0

Standalone, standard-library-only Python storage module. Requires Python 3.10+
and a local disk-backed SQLite database. It does not import VS Code, a model SDK
or a retrieval implementation.

The canonical architecture and requirements are in the
[PKM design Note](pkm://notes/Research/PKM/Memory%20Management%20Engine%20-%20Problem%20Statement%20and%20Design).

## Run and test without installation

From this module's directory:

```sh
PYTHONPATH=src python3 -m unittest discover -s tests -v
PYTHONPATH=src python3 tests/benchmark_storage.py --pieces 10000 --statements 10 --large-mib 200
PYTHONPATH=src python3 -m pkm_memory_engine --database /local/private/memory.sqlite3 --identity account-root-id
```

The worker accepts one JSON request per line over inherited private stdio:

```json
{"protocol":1,"id":"request-1","operation_id":"create-1","method":"create","params":{"piece":"problem-1","label":"Memory continuity"}}
```

The extension's typed adapter is
[MemoryEngineClient](../../src/memory/memory-engine-client.ts). Run the Python
and real Node/worker integration tests together from the extension root with
`npm run test:memory-engine`. Opening the adapter is explicit; activation does
not start a worker or ingest live Chats.

Read methods: `capabilities`, `read`, `sources`, `neighbors`, `changes`, `embedding`.
Mutations: `create`, `append`, `link`, `summary_commit`, `embedding_put`, `touch`,
`evict`, `purge_chat`, `lease_acquire`, `lease_release`. Mutations require unique operation IDs; identical retries
return the stored result, conflicting reuse fails. Source IDs must name immutable
message/tool revisions and exact section locators.

The package can be built with standard Python packaging tools through
[pyproject.toml](./pyproject.toml). Database schema 1 and protocol 1 are checked
independently of package version. Unsupported versions fail without replacing
the database. Backups use the SQLite backup API.

## Delivered scope

- Actual disk-backed WAL transactions, identity partitioning, paged statements,
  many-to-many provenance and typed directed edges.
- Abstraction cycle rejection, ancestor revision invalidation, append-only
  contradictory statements and CAS publication of externally generated summaries.
- Nullable binary embedding column, float32 validation, independent model spaces
  and stale projection rejection. Version 0.1 accepts summary embeddings only.
- Explicit meaningful-access updates and lower-level-first, within-level LRU.
- Durable, revision-checked, bounded active-reader leases respected by eviction.
- Source-contribution purge, ancestor summary removal and deleted-Chat tombstones.
- Durable change stream and idempotent mutation receipts without source text.

## Integration boundaries and remaining work

This is a trusted local storage core, **not yet a production Chat integration**.
The host must authorize every source and graph read before invoking it. It is
not a public IPC server and does not implement multi-user ACLs. It never invokes
a model, generates a summary or executes an Action on its own.

Model job deduplication/leases, summary source-by-source claim coverage, automatic
intent extraction, retrieval publication, host active-request lease coordination,
physical-space reclamation, cross-store delete recovery, source reconstruction,
live migrations and the four Agent Sessions views remain integration work.
The host must acquire/release or renew storage leases around active context
use and summary jobs. The optional `protected` argument supplies additional
exclusions, not a replacement for those leases.

`read` is a paged inspection/snapshot API; it includes a clearly marked stale
summary for incremental consolidation. A host must not treat `summary_current:
false` as a current conclusion. Plain inspection does not refresh LRU; use `touch`
for actual content use, not search candidates or background scans.

Memory deletion does not promise forensic erasure of SQLite pages, WAL or backup
copies. Existing Chat files and independently saved long-term assets are never
changed by this module. No automatic private-data import is performed.

Abstraction height propagation visits affected ancestors on link insertion, not
all Pieces. The design's full 100k-Piece performance target is not yet claimed.
