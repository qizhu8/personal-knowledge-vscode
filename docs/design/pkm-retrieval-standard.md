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

### Indexed source materialization

Worker index submission appends a physical-document fingerprint to the source
revision. Chat resolves that indexed revision using the same normalization; it
must not compare it directly to the unqualified filesystem revision.

The pinned lexical engine's `SkillDocument` content hash is canonical JSON over
body, physical content type, description, metadata and title. It is distinct from
the host's index-event fingerprint. Host materialization validates both indexed
revision and that engine hash. Metadata key ordering follows Unicode codepoints,
including numeric-looking keys; it does not use JavaScript object enumeration.

Sources at most 160,000 UTF-16 code units retain the complete-source path.
Larger sources use the existing structural rule refiner against the original
body before transport. Parent metadata, exact passage ranges and all required
heading/shared-condition contexts remain separate. The 100-candidate boundary
admits or excludes whole dependency groups, never orphaned passages or prefixes.
Private, trashed, removed or changed revisions cannot materialize; send-time
validation checks the current physical source again.
Materialization takes the display title from that verified source rather than
trusting a provider's display label to declare its format. Empty or over-512-unit
titles fail explicitly without emitting content or invalid candidate metadata.

Result admission binds the original request/route, source scope (including an
explicit empty allowlist), content filter, generation policy and top-K. Duplicate
source IDs/ranks, non-finite timings/scores and string-coerced identities are
rejected. The current worker result schema contains L1 sources only: asking it
for `l2-passage` fails before dispatch instead of relabelling a source result.
Materialized candidates must match the physical source URI/type, revision and
complete body, or the exact original UTF-16 passage range/hash and parent identity.

`subscription` is also an origin filter: broker/subscription-URI sources retain
their concrete upstream Skill/Note/Research/Script type, read-only status and
source-scope restrictions. Host canonical hashing/materialization uses the same
upstream type as the worker while retaining the original index-event fingerprint.
It neither relabels all subscribed content as Skills nor bypasses local source
freshness checks. These compatibility cases run against the real pinned worker.

This closes the lexical worker-to-Chat identity mismatch and large-source
transport gap. It does not establish general provider admission, model-generated
spans, RST/code/history structural coverage, cross-Chat authorization or a
production task-quality SLA.

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

### Native Chat rule-passage implementation

The current native Chat path uses
[rule passages](../../src/retrieval/retrieval-passages.ts) for long, fully
materialized L1 sources. It does not relabel document ranking as model L2.
Markdown/Setext sections, paragraph boundaries and fenced examples remain
original text. Oversized pipe tables split only at complete rows, with the
original header and its units as dependencies. Ancestor introductory prose,
same-scope Conditions/Configuration/Environment/Units/Setup sections, explicitly
labelled condition blocks, and prose accompanying split tables remain required
original contexts. Oversized required contexts refuse dependent evidence rather
than inject an unqualified metric. Valid JSON root arrays preserve whole entities;
root objects with one records array also retain other root properties as shared
conditions, including conditions appearing after that array. Multiple root
arrays and duplicate root keys (including escaped spellings of the same key)
stay one original atomic object; oversized objects refuse rather than dropping
an uncertain condition array or key scope. Invalid explicitly declared JSON is
unavailable, never silently reclassified as prose. RST sources identified by `.rst` source URI/label or a
recognized overlined title use a conservative section path: adornment styles
define hierarchy, ancestor introductions, document preambles and same-scope
shared-condition sections remain required context. Original literal/directive
bodies and grid tables stay inside their whole section, including blank lines;
indented adornments are not headings. Oversized RST sections or required context
are refused, not paragraph-sliced. Includes, raw directives, substitutions and
cross-document roles explicitly refuse refinement rather than execute or omit
unresolved dependencies. This is a bounded RST subset, not a general RST renderer.
Explicit `.csv`/`.tsv` source URIs or labels route long sources to deterministic
whole-record refinement. The original first record is required header context
for each selected data record. Delimiters, escaped quotes and embedded quoted
newlines are scanned without changing original offsets, BOM or line endings.
At least two header columns and equal record widths are required; malformed
quoting or widths refuse the entire table, not just the failing tail. Oversized
records or required headers are refused rather than clipped. There is no
delimiter/header guessing for prose or headerless data.
Recognized explicit formats take precedence in source URI, then source label,
then type suffix order, before content heuristics. Explicit `.md`/`.markdown`
and `.rst` formats also apply to Script/file sources. Code files beginning with
`[` or `{` do not become inferred JSON; Markdown does not acquire JSON entity
scopes merely because its entire text parses as JSON. Only otherwise-untyped
JSON-looking text retains the warned original-prose fallback on invalid JSON.
The code lexical subset retains the complete prefix before its first recognized
symbol as mandatory original context, preserving module imports and recorded
conditions there. An oversized required prefix refuses the dependent symbol
instead of silently discarding it. This is not resolution of arbitrary
cross-symbol references or module-level bindings split into separate symbols.
Unsupported multi-array structures, Scripts without a recognized format, Recipes and
unknown kinds remain atomic; oversized units are refused instead of slicing
their prefix. This is not a general code parser or proof that all
cross-section shared test conditions are complete.

Children carry their immutable L1 parent identity, half-open original range,
exact text hash and `offsetEncoding: "utf16"` for JavaScript character offsets.
No BOM/CRLF/Unicode normalization occurs. `contextIds` identifies separately
recorded original heading/shared-condition ranges. Context and its passage are admitted
or omitted together by the model input planner. L1 ordering and local L2
lexical ordering remain separate; raw scores are not compared across levels.
The actual rule provider identity and parent/range fields survive persisted
selection and sent-round receipts.

Complete L1 materialization has a 160,000-character transport boundary. Above
it the adapter refuses full materialization, without substituting a prefix.
For local Notes, Skills, Research, Scripts and available cached Subscriptions,
`pkm_search` discovers identities and `pkm_read` exposes a source URI and a body revision/hash handle:
`start`, `end`, `sourceRevision` and `contentHash` request an exact original
range of up to 4,000 UTF-16 code units. Stale handles, invalid ranges, split
surrogate pairs and oversized serialized responses fail explicitly. Default
preview reads still report `truncated`; a preview is not a complete source or
a successful L2 result. The body hash in this read handle is distinct from an
index provider's document hash and must be obtained from the read response.
Previews expose their exact range and `nextStart` without splitting a surrogate
pair, including when JSON escaping reduces the available preview length.
Research text uses the same original body/conclusions/implementation/assumptions
order as its retrieval snapshot; changing any of them invalidates the handle.
Script discovery excludes symlink entries and refuses a scripts root linked
outside its Knowledge Root. Reading scripts never executes them.
Subscription reads resolve only available entries in a fresh local retrieval
snapshot, retain their upstream source URI and read-only marker, and never
refresh/fetch the remote subscription. Removed/private entries or changed bytes
cannot satisfy an earlier handle. Read identities support up to 2,048 characters;
search queries remain limited to 512, and identities are never silently shortened.
Small Recipe reads retain their complete structured `definition`, `metadata`,
revision and executable digest. When that result would exceed 16,000 serialized
characters, the same read returns a version/hash-pinned JSON text preview and
the exact source-range contract above. Its source text is the serialized
`id`, `revision`, `executableDigest`, `definition` and `metadata` record, not the
worker's indexed body. Revision or metadata/body changes invalidate old handles,
even if the executable digest stays unchanged. Range fragments are read-only
evidence, not executable Recipes; they never create or resume Runs. Trashed or
removed Recipes cannot satisfy earlier handles.

Verification uses [passage tests](../../tests/test-retrieval-passages.js),
[real local source-range tests](../../tests/test-knowledge-source-ranges.js)
and the real controller/HTTP tail-evidence case in
[context contracts](../../tests/test-chat-context-contracts.js).
Model-passage admission, Action source-range contracts,
general semantic shared-condition coverage remain separate from these
deterministic structural guarantees.

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

The native worker adapter records its observed engine version, per-hit
`contributing_routes`, and, only when imported serving was actually used, the
served `packageId` and `releaseId`. A release identity is not guessed to be an
encoder checkpoint/model version. Fallback records the worker's error or
scope/unavailable reason without labeling an unserved package as active.
The result's legacy `route` remains the requested route; candidate `serving.route`
records actual contributing routes. A hit with no contributing routes is
explicitly `unreported`. Invalid serving metadata fails rather than borrowing
the requested model identity. Rule L2 has its own provider identity; its L1
parent's served identity remains in the same receipt.

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

Native Chat keeps its original source pool available across tool rounds.
Refinement is lazy and receives the current steering/task query. Derived
projections are round-local: they neither accumulate in the source pool nor
duplicate a whole source when that source later fits. Older complete tool
call/result groups are optional atomic evidence; the newest group is required.
A bounded safety ledger reminds the consumer that omitting evidence never
undoes execution and must not trigger mutation replay. Failed persistence rolls
back the planner pool as well as queued steering and prepared receipts.

The same bounded execution reminder is used for explicit response retry.
History-on retry includes the previous response/call identities and outcome
statuses, not a replay of arguments or results, so the enabled evidence reader
can recover originals after restart. History-off retry includes only a generic
side-effect warning, with no earlier response identities or results. Retrying
a response is not permission to repeat an operation. Delegated workers use the
same planner on their own Chat; parent evidence is not implicitly shared.

Refinement deduplicates message/reference identities both against existing
evidence and inside a single returned batch before counting or injection.
Unsupported deterministic formats and invalid JSON remain unavailable with
unresolved identities; no model rewrite/fallback request is dispatched.

Each prepared budget record includes `pkm.chat.context-plan/v1`: input estimates,
fit/refinement/limit/stale-source outcome, unresolved/omitted identities, schema
hash and per-message role/hash/reference/call manifest. The controller tests
compare these persisted manifests with real HTTP payloads on every inference,
including refined ranges and revoked sources. These are preparation records,
not proof of provider acceptance. Native VS Code transforms the canonical
messages into its own structured prompt; the canonical hash is not claimed to
hash that transformed envelope.

## PKM Source Adapters

Skills, Notes, Research, Scripts, Recipes and Subscriptions already enter the
generation-aware corpus contracts. Chat Memory and tool outcomes adapt to the
common candidate contract but remain Chat-owned sources.

Tool results are independent evidence units. Their availability does not depend
on the containing assistant response being complete. Successful and failed
outcomes must remain distinguishable. Recent and old evidence use the same
retrieval interface; recency can affect ranking but cannot force full tool-result
replay.

When the already-enabled `session_info` tool receives `evidenceCallId`, it reads
original stored arguments/results without executing the source tool. Optional
`evidenceMessageId` disambiguates call IDs reused across assistant responses.
History on permits only this Chat's current Task; History off permits only the
current response. Failed assistant responses do not erase independent complete
or failed tool outcomes. Running, missing, ambiguous or out-of-scope evidence
fails explicitly.

Default evidence reads return an explicitly truncated, transport-bounded preview
with the full content hash and next offset. `evidenceStart`/`evidenceEnd` plus
`evidenceHash` request exact half-open UTF-16 ranges of at most 4,000 code units.
Exact ranges reject stale hashes, split surrogate pairs and oversized serialized
results; they are never shortened. HTTP tool IDs are checked across the request
before dispatch so a provider cannot overwrite earlier outcomes by reusing a
call ID.

Validation: `npm run test:chat-context` covers bounded mechanisms, real
controller/HTTP, production source fingerprint revalidation, transactional
steering, stored-evidence restart/privacy/ranges, structural passages, native
adapter envelopes, serving identities and delegated-worker isolation.
Duplicate-only operations, eight refinements, 100 cumulative candidates and a
one-second default deadline are checked before further refinement; elapsed
synchronous operations are checked again before accepting their output.
Synchronous parsers are not forcibly preempted. Candidate exhaustion reports
`candidate-limit` and unresolved identities instead of failing the primary Chat.
No automatic rewrite/summary LLM fallback is introduced.

The canonical plan retains per-message hashes/reference IDs. Each prepared
budget also records `pkm.chat.transport/v1`: hashes of the actual transformed
HTTP/native messages and actual active tool schema, not the canonical schema
stand-in. Native input counting uses `countTokens` on final native messages and
schemas plus explicit overhead; invalid counts, native input overflow and
receipt-persistence failures prevent dispatch. Without native token counting,
the transformed envelope uses a labelled conservative UTF-8 estimate.
Neither counting method claims hidden provider-envelope/tokenizer accuracy;
prepared is not proof of provider acceptance. HTTP canonical and serialized
envelope estimates are recorded separately.

All M01-M18 placeholders have executable acceptance in the core suite plus
the following environment-dependent gates, not silent skips:

- `npm run test:chat-context:feedback`: the real offline imported encoder serves
  queries at all diagnostics levels, its actual package/release/engine/route
  are checked, and every package file hash remains unchanged across queries
  and worker restart. All persisted state files and real SQLite tables are
  audited for query/capability sentinels and training-event collection.
- `npm run test:chat-context:host`: installs the built VSIX into temporary
  extension/user/HOME directories and starts two distinct real Extension Hosts.
  Real HTTP context/evidence persists, the actual installed Webview and browser
  render refinement/transport receipts, and native message serialization is
  checked with the real host API classes and a controlled local model.
  This is not a live paid model, real SSH forwarding or cross-platform claim.
- `npm run test:chat-context:acceptance`: core, default real Python worker,
  imported feedback audit, production Chromium renderer and installed-host
  restart gates together.

The feedback gate requires `PKM_RETRIEVAL_TEST_PYTHON` and
`PKM_RETRIEVAL_TEST_MODEL` pointing to the existing offline runtime/local encoder.
Browser gates use installed Playwright or `PKM_PLAYWRIGHT_PATH`; the host gate
requires VS Code test-electron, packaging tools and DISPLAY/Xvfb. It isolates
HOME as well as user data, because the account MCP binding otherwise overrides
the configured Knowledge Root. It does not replace the user's installed build.
When the installed browser is a headless-shell-only or custom installation, set
`PKM_CHROMIUM_EXECUTABLE` to that existing executable for the installed-host gate.
The runner forwards this explicit path into the isolated Host rather than forcing
Playwright's full Chromium executable path (which may not be installed). Without
an explicit executable, Playwright uses its normal browser selection; its browser
cache must be accessible under the isolated HOME or an explicit
`PLAYWRIGHT_BROWSERS_PATH`. No browser or model is downloaded by these gates.
The default-worker audit independently verifies unchanged corpus generation
and query-free metrics under all diagnostics levels.
Local Chat history and its explicit retrieval audit receipts are not a training
feedback collection pipeline.

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
