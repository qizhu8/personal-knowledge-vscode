# PKM Retrieval Standard

Status: version-one contract baseline. Existing retrieval routes remain compatible
while producers and consumers migrate to the common candidate and receipt types.

## Goals

The standard separates retrieval-model behavior from context construction.
Lexical, dense, sparse, graph, reranker, imported-package and future remote
providers can change without changing Chat, MCP or other PKM consumers.

The boundary has two responsibilities:

1. A **Retriever Provider** discovers candidates and reports immutable source
   identity, ranking semantics and the exact serving implementation.
2. A **Context Consumer** validates source revisions, allocates its own budget,
   selects projections and records what it actually transmitted.

A provider score never grants permission, overrides an explicit source scope or
decides what enters a model request.

Retrieval itself has two standardized levels:

1. **L1 Source Retrieval** selects whole PKM resources.
2. **L2 Passage Retrieval** locates evidence inside the selected resources or
   inside Chat-owned memory/history.

L1 and L2 can be implemented, released and upgraded independently.

## Retrieval Levels

### L1 Source Retrieval

L1 uses level `l1-source`. It selects addressable PKM resources such as:

- Knowledge;
- Skills;
- Notes;
- Recipes;
- Actions;
- Scripts;
- Research and subscribed text.

An L1 result identifies a whole source by canonical URI, source revision and
content hash. It does not manufacture a passage range. L1 is the authorization
and corpus-selection boundary: visibility, capability scope, source type and
read-only policy are applied before candidate truncation.

### L2 Passage Retrieval

L2 uses level `l2-passage`. It selects bounded evidence such as:

- Chat Memory pieces;
- conversation History pieces;
- tool-result and tool-error pieces;
- sections, paragraphs, tables or code spans inside an L1 source.

Every L2 projection from an L1 resource must carry `parentId`,
`parentRevision`, `parentContentHash` and a half-open `range`. A consumer rejects
an orphan projection or a projection whose parent has changed. Chat-owned memory
and history pieces use their immutable message/tool source as the parent.

L2 may run:

- directly over Chat-owned evidence;
- scoped to explicit source IDs;
- as a second stage over selected L1 results.

The standard does not require L1 and L2 to use the same engine, model, index,
release cadence or process. Capability negotiation declares which levels a
provider supports.

### Cascaded Retrieval

A cascaded request first selects L1 sources, then passes only their immutable
identities and allowed scope into L2. The coordinator owns deadlines and budgets
for both stages and records both serving identities. It must not concatenate L1
and L2 raw scores or silently widen L2 beyond the admitted L1 scope.

If L2 is unavailable, returning whole L1 sources is an explicit fallback, not a
successful L2 result. The receipt records the fallback and resulting granularity.

## Versioned Contracts

The canonical TypeScript contracts live in
`src/retrieval/retrieval-contracts.ts`.

| Schema | Purpose |
| --- | --- |
| `pkm.retrieval.capabilities/v1` | Provider negotiation and bounded limits |
| `pkm.retrieval.query/v1` | Corpus query, scope, route and generation policy |
| `pkm.retrieval.result/v1` | Ranked immutable corpus hits |
| `pkm.retrieval.index-event/v1` | Idempotent corpus mutation stream |
| `pkm.retrieval.selection-receipt/v1` | Final consumer selection and budget evidence |

Unknown schema major versions must be rejected. Additive optional fields can be
introduced within a major version only when old consumers safely ignore them.
Required-field, meaning or privacy changes require a new major schema.

## Provider Interface

A provider implements `RetrievalProviderV1`:

```ts
interface RetrievalProviderV1<TQuery, TResult> {
  capabilities(): Promise<RetrievalProviderCapabilitiesV1>;
  retrieve(query: TQuery, signal: AbortSignal): Promise<TResult>;
}
```

Capabilities are data, not inferred behavior. They declare supported query and
result schemas, retrieval levels, source kinds, routes, score semantics, optional
features and hard limits. A consumer must negotiate capabilities before using a non-builtin
provider and must not silently substitute an unsupported route.

Cancellation and deadlines are part of the call contract. A cancelled, stale or
failed call cannot produce a completed selection receipt.

## Candidate Identity And Provenance

Every selectable candidate uses `RetrievalCandidateV1`. Providers should supply:

- stable candidate ID;
- retrieval level;
- source ID and canonical `pkm://` URI;
- source revision and content hash;
- source kind and optional parent/range;
- rank, method, raw score, score semantics and bounded score components;
- exact serving identity.

`sourceRevision + contentHash + range` identifies the evidence version.
Message position, mutable filename or array index alone is not a valid immutable
identity. Consumers must reject a candidate when its live revision/hash no longer
matches.

Ranges are half-open: `start` is inclusive and `end` is exclusive. Their unit is
explicitly characters, bytes or lines. L2 child projections retain their parent
ID, revision and content hash.

## Scores And Ranking

Raw scores are meaningful only inside the declared method and score semantics.
Consumers must not compare cosine similarity, distance, BM25, probability and
RRF values as though they share one scale.

Cross-provider composition uses an explicit fusion policy such as bounded
round-robin, reciprocal-rank fusion or normalized per-method ranking. The policy
and score components must remain inspectable. UI flow thickness is not a
probability unless the provider declares `probability`.

Provider upgrades change `providerVersion`, and model/package upgrades also
change their corresponding serving identity fields. Evaluation and feedback use
the served identity, never only the requested route.

## Context Selection

Retrieval returns candidates; it does not render model messages. The consumer:

1. preserves mandatory system, current-input, pinned and active tool-pair data;
2. validates candidate source identity and permissions;
3. measures the selected subset against the target budget;
4. refines only after the measured subset does not fit;
5. stops on fit, deadline, attempt limit or no progress;
6. emits `pkm.retrieval.selection-receipt/v1` from the final payload.

The receipt records the consumer and target, actual selected candidates, serving
identities, budget unit/available/selected values, incompleteness and warnings.
Candidate bodies are not duplicated in durable receipts.

Deterministic projection is preferred. LLM rewriting is a separate capability
and approval boundary, never an implicit fallback.

## PKM Source Adapters

Skills, Notes, Research, Scripts, Recipes and Subscriptions already enter the
generation-aware corpus contracts. Chat Memory and tool outcomes adapt to the
common candidate contract but remain Chat-owned sources.

Tool results are independent evidence units. Their availability does not depend
on the containing assistant response being complete. Successful and failed
outcomes must remain distinguishable. Recent and old evidence use the same
retrieval interface; recency can affect ranking but cannot force full tool-result
replay.

Specialized policy tools may filter or reorder common retrieval results, but
must not reinterpret source identity, serving identity or score semantics.

## Privacy And Feedback

Default durable receipts contain bounded metadata, hashes, public enum values,
counts and timings, not raw query or candidate bodies. Raw-query collection,
training events and serving-weight updates remain separately consented features.

Clicks are interaction evidence, not automatic relevance labels. Feedback binds
to the actual provider/model/package version, corpus revision and immutable
candidate identity.

## Compatibility And Admission

A provider release is admitted only when:

- its capabilities validate;
- its declared schemas are supported;
- model/package artifacts pass their existing integrity checks;
- source scope and generation policy are satisfied;
- returned candidates validate and resolve to current source versions;
- fallback is explicit in serving identity and the receipt.

Provider failure is explicit. A consumer may use a configured fallback only when
policy allows it and must record that fallback; it cannot return success-shaped
empty results while claiming the requested provider served the query.

## Failure Containment

Retrieval relevance is allowed to be poor. A low, negative or unexpectedly
ordered finite score is still valid provider behavior and can reduce precision or
recall. It must not crash PKM.

Protocol corruption is not relevance degradation. PKM rejects or isolates:

- non-finite scores and score components;
- duplicate or unbounded candidate identities;
- unsupported schemas, levels or score semantics;
- more candidates than the negotiated boundary;
- invalid or unbounded ranges and content;
- orphan L2 passages;
- stale source or parent revisions;
- provider exceptions and deadline overruns.

Valid candidates can survive beside invalid candidates. The batch is marked
`degraded`, invalid candidates are excluded, and the consumer can continue with
the valid subset. If no safe candidates remain, retrieval is `unavailable` and
the consumer continues without automatic references or uses an explicitly
configured fallback.

Caller cancellation is not converted into fallback success. It propagates as
cancellation so cancelled work cannot create a completed receipt.

The learned serving worker validates model hits before publication. An invalid
learned hit causes explicit Exact/BM25 fallback for that request; the worker
remains alive for subsequent requests. The TypeScript worker validates the
normalized result again, and each consumer validates current source revisions
before injecting content.

## Required Test Conformance

Every new retrieval provider must run:

1. **Contract unit tests** for capabilities, queries, results and candidates.
2. **Failure-containment unit tests** for throw, timeout, cancellation, malformed
   scores, duplicates, oversized batches, invalid ranges and stale sources.
3. **Worker E2E tests** proving malformed model output falls back without process
   death and that the next healthy request succeeds.
4. **Consumer E2E tests** proving stale or invalid evidence is not transmitted,
   while the primary PKM operation completes with no retrieval references.

Quality benchmarks are reported separately. A provider may fail a relevance
target without violating runtime conformance, but it cannot pass conformance if a
bad model response crashes the worker, Host, Chat or another PKM subsystem.

## Migration

1. PKM Chat candidates now implement the common candidate contract.
2. Chat Memory should add content hashes, source revisions, ranges and serving
   identity while replacing full recent tool-history replay.
3. The context planner should emit the common selection receipt after rendering.
4. The retrieval worker should expose the common capabilities schema from status.
5. Python serving paths should map package/architecture/model identity into the
   same serving identity before crossing the worker boundary.

The existing `pkm.retrieval.query/result/v1` worker protocol remains valid during
this migration.
