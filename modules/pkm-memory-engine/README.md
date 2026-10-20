# PKM Memory Engine 0.2.1

Standalone, standard-library-only Python storage and memory-policy module. Requires Python 3.10+
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
Storage mutations: `create`, `append`, `link`, `summary_commit`, `embedding_put`, `touch`,
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
  and stale projection rejection. Summary embeddings only.
- Explicit meaningful-access updates and lower-level-first, within-level LRU.
- Durable, revision-checked, bounded active-reader leases respected by eviction.
- Source-contribution purge, ancestor summary removal and deleted-Chat tombstones.
- Durable change stream and idempotent mutation receipts without source text.
- Resumable `turn_begin` / `turn_continue` / `turn_commit` policy: model-driven
  intent association, append-only statement extraction and on-demand summaries.
  Model requests are returned to the caller, never executed inside the module.
- Hierarchical topic context, earlier-message restoration, scoped `memory_read`,
  `overview`, `turn_receipt`, `enforce_capacity` and permanent `forget_scope`.
  Long message reads return complete statement chunks, up to 40 per byte-bounded page; follow
  `next` as `after` until it is null. No text is silently clipped inside a page.
- Permanent scope deletion also clears empty topics, private labels and saved
  turn inputs. Tombstones reject new turns and late model responses cannot
  recreate the deleted scope. Shared-source contributions outside that scope are
  still removed without deleting unrelated statements.

## Chat integration and verification

[ChatMemoryService](../../src/memory/chat-memory-service.ts) drives the policy
through the typed worker adapter. PKM Chat calls it only when History is enabled.
The host selects and calls the memory model, assembles reference blocks, and
records explicit preparation/model-fallback receipts. Background extraction does
not write the Chat file or bump another window's revision. Worker recovery shares
one replacement across concurrent callers; cancelled model output is not applied.
Failed model calls retain their requested token budget, bounded visible-output
character count and reported usage in the durable turn receipt. Failed output is
never applied as statements or summaries, even when it contains valid JSON. The
receipt does not store that failed output text. Provider-reported output usage
and visible character counts are different measurements; neither proves how
many reasoning tokens a provider used when that detail is not reported.

Hidden thinking is budgeted separately by the host setting
`personalKnowledge.chatMemoryThinkingBudget` (900, 1500, 2048 or unlimited;
default 2048). When the provider reports reasoning tokens, the receipt usage
includes `reasoningTokens`; the visible output must stay within the step's
`max_tokens` and thinking within the selected budget. If thinking is not reported
separately, total output must fit both budgets combined. VS Code models cannot be
interrupted mid-thought, so their check runs on reported usage after the step.

`tests/test-chat-memory-service.js` covers actual worker startup, concurrent crash
recovery, close, cancellation, isolation and persistence. The controller suite
(`node tests/test-api-chat.js`, after `npm run build`) also runs
`tests/test-chat-memory-controller.js`: real Python/SQLite with scripted model
responses, non-fallback intent receipts, unused-topic lazy behavior, summary
publication/reuse, out-of-window message restoration into the model payload,
provider failure and History off. This is **not** real-model quality validation.

## Integration boundaries and remaining work

This is a trusted local memory module, **not yet production-accepted**.
The host must authorize every source and graph read before invoking it. It is
not a public IPC server and does not implement multi-user ACLs. It never invokes
a model, generates a summary or executes an Action on its own.

Model job deduplication/leases, summary source-by-source claim coverage,
retrieval publication, host active-request lease coordination,
physical-space reclamation, cross-store delete recovery, source reconstruction,
live migrations and the four Agent Sessions views remain integration work.
Real-model multi-turn quality/latency, packaged-host behavior, long-running
failure/recovery and complete UI receipt delivery remain acceptance work.
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

The public worker protocol and standalone tests are the compatibility boundary,
not Python itself. Measure model latency, IPC/startup, SQLite operations and
policy CPU separately. If evidence identifies Python as a bottleneck, the engine
may be reimplemented in TypeScript or another suitable language while preserving
the contract and behavior tests; no language migration is justified by assumption.
