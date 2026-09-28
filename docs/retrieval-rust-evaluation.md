# Retrieval Engine Evaluation

The retrieval boundary is now versioned independently from its engine:

- `pkm.retrieval.query/v1`
- `pkm.retrieval.result/v1`
- `pkm.retrieval.index-event/v1`

Run the reproducible labeled benchmark with:

```bash
npm run benchmark:retrieval
```

The default run measures bounded 1K and 10K synthetic tiers and labels English,
Chinese, mixed-language, exact-ID, code-symbol, and relation queries. The report
records quality at 10, p50/p95/p99, startup, submit acknowledgement, ready
cutover, RSS where the host exposes it, persisted snapshot size, and update
mode. The 50K and 100K tiers remain explicitly `planned-not-run` unless an
extended run includes them. Results must never be copied from estimates.

## Measured revision 2 run

Linux x64, Node 22.23.1, five repetitions per labeled query, 2026-09-28:

| Tier | Relevant@10 | Query p50/p95/p99 | Startup | Full ack + ready | One-upsert ack + ready | RSS | Persisted snapshot |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1K | 6/6 labels | 9.432 / 16.097 / 16.097 ms | 136.6 ms | 71.0 + 54.8 ms | 39.3 + 58.4 ms | 37.1 MiB | 0.473 MiB |
| 10K | 6/6 labels | 20.554 / 30.516 / 30.516 ms | 108.0 ms | 291.3 + 358.2 ms | 210.7 + 454.2 ms | 118.0 MiB | 4.746 MiB |

The labels were English, Chinese, mixed-language, exact ID, code symbol, and
relation traversal. These are bounded synthetic measurements, not claims about
the live personal corpus. The delta path persisted one event and advanced the
ready generation atomically, but the capability report correctly identifies
that the Python engine rebuilt all in-memory lexical and graph state. The 50K
and 100K tiers were not run.

No Rust measurements exist: no executable candidate artifact was available.
Python packaging was measured only on Linux in this run. The existing Windows
no-console launcher and managed macOS Python path remain covered by their
compatibility tests, but this run does not claim Windows or macOS performance.

## Decision

**Protocol boundary ready; Tantivy/Rust candidate recommended but rewrite
deferred until a labeled benchmark and candidate artifacts exist.**

The current Python worker remains the production lexical engine. It persists
incremental events but honestly reports that each accepted update rebuilds all
in-memory lexical state. A Rust/Tantivy candidate must provide reproducible
artifacts for Windows, macOS, and Linux and must be measured against the same
labeled corpus before a rewrite can be authorized. Python remains an optional
sidecar for embeddings or other ML routes; semantic routing is not advertised
as available until such an engine is installed and measured.
