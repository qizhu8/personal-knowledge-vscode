# Offline Retrieval Solution Packages

Ordinary installations continue to use Exact/BM25. No model weights are bundled
in the extension or downloaded automatically. Users can explicitly download the
pinned default model from Hugging Face, import that model from a local directory,
or import a complete offline solution ZIP. PKM never trains these weights.

## Export from Retrieval Observatory

Use Observatory's `scripts/export_solution_package.py` in its verified runtime:

```sh
python scripts/export_solution_package.py \
  --database /private/collector.sqlite3 \
  --task-id COMPLETED_MEASURED_TASK_ID \
  --pkm-root /private/skills \
  --name "My frozen retrieval solution" \
  --license MIT \
  --output /private/my-solution.retrieval.zip
```

The exporter checks that the trial completed, has real measured evidence, and
its labels remain current on a copied database. It verifies the selected local
model's pinned fingerprint. Declare the actual model license and verify your
right to redistribute the weights; this declaration is not a license audit.
Version one exposes export through this CLI, not an Observatory download button.

The ZIP contains a strict manifest and safetensors/tokenizer/model configuration
files. It excludes private corpus text, rankings, query logs, training examples,
optimizer state, source absolute paths, and arbitrary implementation code.
Manifest checksums identify package content; they are **not publisher signatures**.
Import only trusted packages. Large model files remain local.

V1 supports the registered dense document/section, hierarchical dense section,
PCA, dense/BM25 fusion and generic token-interaction paths. Learned graph and
cross-encoder paths fail export explicitly until their full portable state and
runtime contract are supported. Corpus-derived PCA/index state is reconstructed
on the receiving corpus. It is not represented as the original fitted index.
The candidate depth remains the measured executor's 20 results per route;
requesting more results does not silently change hybrid fusion's candidate pool.

## Router controls

Embedding retrieval is entirely optional. Router opens on **Skill Sources** for a
new UI state. Three always-visible Title Case tabs are **Skill Sources**,
**Retrieval & Performance**, and **Collector & Privacy**. Model acquisition and
model performance share the second view.
An unconfigured model is a neutral state, not a warning or a setup reminder.
No opening, refresh or background status update starts model setup.
The main view keeps states, progress and actions. Source explanations, model
hashes/paths, budgets, validation provenance and runtime diagnostics live in
associated `i` floating detail panels. Pointer hover or keyboard focus opens them;
they remain hoverable, fit the viewport, and Escape dismisses them. Background
snapshots preserve focus and open details. Actual setup failures stay visible
outside the detail panels.
Routing paths shows the default keyword route separately from the optional
Semantic / Dual path, with live readiness rather than the old disabled Hybrid
placeholder. Available means the model can serve explicit queries, not that it
served every request.

**Router -> Retrieval & Performance** has three acquisition methods, with runtime and
resource information in floating details. Source ordering and privacy have
their own top-level views. The separate
Router benchmark measures its lexical synthetic corpus, not the imported model.
It must not be mistaken for the live model-call chart.

### Call History, Calibration, and Adaptive Result Count

The **Collector & Privacy** view keeps its **Router Privacy Statement** directly
visible, never inside hover details. It discloses search/Skill event payloads,
hostname/session metadata, the default loopback collector and configurable remote
receiver, separate local feedback/learning retention, and the limits of deletion.
Adaptive Result Count is not a collector opt-out and does not erase history.
Receiver operators control received copies; this scoped notice is not a
general privacy policy for separately configured Chat/Sync/sharing services.

The model chart's x-axis is the persisted actual model-call sequence, not time or
the number of returned results. Its upper-right selector switches Runtime,
Recall, and Returned Results. Runtime measures worker retrieval, excluding history
persistence and transport; it is not encoder inference in isolation. The chart
includes attempts across routes for the current package and corpus; point
tooltips identify routes and failed attempts are red. Calibration Route changes
the displayed calibration function, not the invocation history.
Calls with no invoked model, including unconfigured
lexical fallback and empty capability scopes, do not increment the sequence.
No query text, paths, document content, or raw source IDs are collected by this
learning history. It retains 512 calls, displays at most 256, and retains only
models referenced by those calls. Call sequence numbers remain monotonic across
restart and pruning.

History refreshes every ten seconds only while the model-enabled performance
view is visible, with at most one request in flight. Observation never starts a
worker or scans packages. A failed or timed-out refresh stops automatic polling
until an explicit refresh succeeds; late or mismatched responses are ignored.
Older workers without learning history remain usable for existing retrieval.

`retrieval_feedback(retrieval_id, relevant_source_ids, complete=true)` is a local
write. The caller must explicitly judge the relevant canonical source IDs,
including known missed items. Recall is retained-relevant / all-declared-relevant.
Missing or incomplete judgments are not inferred from usage, task success, or
silence. Complete all-negative judgments can train calibration, but Recall has
no denominator and remains unavailable. Repeated identical feedback is
idempotent; conflicting second feedback and unknown/expired receipts fail
explicitly.

The calibration plot compares the actual initialized sigmoid (slope 4, bias -2)
with the persisted current sigmoid. The input is the rank score divided by that
call's maximum absolute score, clamped to [0,1]. Explicit complete judgments
update only slope and bias through bounded logistic-gradient steps. The curve is
an estimated relevance mapping, **not** measured accuracy or embedding training.
Before the first update, it says **Not Trained Yet**; overlapping curves do not
mean training has happened. Calibration and gap thresholds are isolated by model
release, corpus revision, route, and score semantics.

Adaptive Result Count defaults on and has an explicit off switch. It never
raises or globally replaces the caller's limit. The worker preserves internal
candidate oversampling separately from the delivered limit, so MCP overfetch is
not mistaken for a request for more results.

Truncation requires eight consecutive explicitly judged safe proposals in that
context, a normalized score gap of at least the learned threshold (floor 0.15),
and calibrated estimates of at least 0.65 for the last retained result and at
most 0.35 for the first discarded result. Threshold targets are smoothed by
EWMA (0.9 old + 0.1 observed). Missed relevant results reset eligibility.
Exact terms and highest/required priorities are protected; unavailable/fallback
model paths, insufficient feedback, disabled adaptation, or no clear cliff keep
the original result limit. This is a conservative heuristic, **not a Recall
guarantee**. Returned counts do not by themselves quantify tokens saved.

- **Download from Hugging Face** explicitly confirms acquisition and activation
  of `intfloat/multilingual-e5-small` at revision
  `614241f622f53c4eeff9890bdc4f31cfecc418b3` (MIT). The checked-in receipt contains
  only file names, sizes and SHA-256 values, not weights. Downloads stream to a
  private temporary directory and show actual bytes / total (about 470 MiB).
  Every file must match; partial, oversized or corrupt downloads are rejected.
  A 60-second inactivity deadline detects stalled connections without imposing a
  short whole-file deadline on slow downloads. The VS Code notification permits
  cooperative cancellation. Temporary downloads are removed on success/failure.
- **Import model directory** accepts the same pinned default model downloaded
  by any other method. A directory picker and explicit activation confirmation
  are required. The nine required model/tokenizer/config files must exactly
  match the receipt. PKM copies verified files into its own package storage;
  the original directory is not modified. Other architectures/models still
  require a complete compatible offline solution ZIP, not an arbitrary HF ID.
  The same offline interface is available to local tooling:
  `python resources/retrieval_solution.py --model-directory /path/to/model --state /path/to/retrieval-state`
  (import-only; activation remains an explicit worker/UI action).
- Both default-model paths show **Runtime -- Download/Import -- Verify --
  Configure -- Build index -- Ready**, drawn as connected circles. Index stages
  use real worker status; readiness requires that exact package to be active.
  Failures stay on the failed stage with an explicit explanation. A concurrent
  user selection change blocks setup from overwriting it. Cancellation before
  activation can leave a verified imported package but never silently enable it.
  If activation already committed, use Disable to stop model retrieval.
- **Import offline package** retains the existing trusted ZIP interface. Its
  shorter chain ends at **Imported**, not Ready. Review its budget and explicitly
  Enable & build. Merely importing a ZIP does not activate it.

The default recipe uses dense sections with `query: ` and `passage: ` prefixes.
It carries no copied private-corpus validation scores: local quality must be
measured separately. No custom repository code, pickle weights, model dependency
installation or private knowledge uploads are performed by acquisition.

Choose an existing model-capable Python with **Choose model Python** when the
lightweight MCP runtime lacks inference dependencies. PKM probes the complete
serving/package modules and torch, sentence-transformers, scikit-learn and NumPy
offline before persisting this choice. It does not modify the MCP or SI environment.
Worker startup and import load the integrity-checked bundled engine, not an
unrelated older installed package. Engine sources are extracted to a private
process-lifetime directory because index fingerprints require real source files.
Retrieval Python helpers, the pinned engine wheel and default-model receipt are
also staged into an immutable `runtimes/<build>/` under the retrieval state
directory before launch. Worker reuse checks this build as well as the engine,
configuration and selected interpreter; an obsolete same-engine process is
gracefully replaced. Removing an old VS Code extension therefore cannot break
lazy imports or index fingerprints referring to its old helpers. Old immutable
runtime directories are retained; they are not garbage-collected while in use.
Runtime changes use authenticated worker shutdown and wait for state ownership
to be released before replacement; they do not bulk-terminate processes.
The machine-local runtime selection also retains its inference thread budget
(one by default), shown separately from measured CPU usage. OMP/MKL settings are
library thread budgets, not an OS CPU quota or a whole-process memory limit.
Raw document/token vectors are cached in private, data-only SQLite batches
keyed by package, runtime/implementation identity, encoder purpose and text hash.
Corpus changes or a cancelled preparation retain completed batches, so unchanged
text is not repeatedly encoded. Queries and source text are not stored there.
Corpus-fitted PCA, indexes and admission are still recomputed for the current
revision; this cache does not relax generation or privacy checks. Successful
builds prune unused vectors and old implementation namespaces. Rebuild/Delete
also remove this derived cache. Cache corruption fails explicitly rather than
silently substituting vectors; Router reports reused/new units and cache bytes.

The current Router additionally exposes **Explicit semantic / dual readiness**:
the worker-reported semantic status, requested and active package IDs, frozen
Skill release readiness and concrete preparation/admission errors. A lexical
worker reporting `ready=true` does not mean its embedding path is usable.
Absent status fields are shown as not reported, never inferred as ready.
Readiness follows the live catalog polling and action responses, so finishing
preparation also updates the semantic status without a full Router refresh.
Model-card keyboard focus and expanded budget details are preserved.

Knowledge collections default **Ctrl+F** to **Filter files**: literal text
filtering (with the existing case/regex controls) in the normal category tree.
It does not run BM25 or load a model. **Keyword retrieval**, **Semantic** and
**Dual** are explicit alternatives; their bounded candidates are shown in a
source-folder tree, with per-hit retrieval evidence collapsed by default.
Current local identities and subscription cache keys are resolved before
opening details. Missing or ambiguous targets show an error instead of passing
an index path to the Skill-name API. Indexed retrieval still requires the
worker and preserves its reported readiness/fallback/incompleteness evidence.

In **Router → Text retrieval solutions**:

The embedded interface separates the **current text path**, **solution cards**,
and **measured preparation resources**. Each card shows model size, build RAM
and index estimates plus counts for Skills, Notes, Recipes, Scripts, Research
papers and subscribed text. Resource assumptions and source validation are
collapsed by default; source priority controls elsewhere remain Skill-specific.
An empty state explains Import → Review budget → Enable & build.
Desktop and narrow (360 px) layouts use the existing PKM theme.
Live updates preserve keyboard focus and expanded details; repeat load/rebuild
actions are disabled during preparation. Native picker cancellation completes
the pending action instead of leaving its button stuck.
Read-only refresh and background progress cannot acknowledge another pending
mutation. Completions carry an operation identity; timeout reports uncertainty
without cancelling or replaying the action.

1. **Import solution package**: select the ZIP and confirm its trusted source.
   The importer verifies entries, manifest, sizes, hashes and model loader
   configuration before publishing a content-addressed package directory.
   Duplicate import of the same verified package is idempotent.
2. **Enable**: requires the built-in Exact/BM25 fallback to remain enabled.
   Model loading and indexing use the local worker's Python environment. No
   runtime installation or downloads occur. Missing `sentence-transformers`,
   torch, sklearn or an incompatible engine is shown as blocked.
   Provision optional inference libraries explicitly in the **managed MCP runtime**
   whose Python path is shown in Config. `personalKnowledge.mcpPythonPath`
   selects its base interpreter, not an arbitrary serving interpreter; changing
   it does not inherit another environment's installed libraries.
3. **Background preparation**: the Router shows requested/active package,
   queued/building/ready/blocked state, source validation, errors and phase
   progress. The extension also registers the job in **Background Tasks** and
   pushes progress once per second while building, even if the Router pane is
   closed. Model verification/loading, PCA fitting, index restore and persistence
   are indeterminate stages; encoding reports batches of 16 items. There is no
   fabricated whole-job percentage or ETA.
4. **Disable**: immediately fences pending builds and in-flight package results.
   New requests use the built-in path; weights and persistent index stay available
   for later use. Cancellation is cooperative between stages/batches: it cannot
   interrupt a model-library call that is already running.
5. **Delete**: asks for confirmation. An active package is disabled first, then
   its private package directory and derived index directory are removed. Original ZIP/model directories,
   knowledge documents and metric history are untouched.

**Rebuild index** explicitly discards that package's derived cache and prepares
it again. This is also the recovery action for a corrupt/incompatible index;
corruption is shown as blocked, not silently hidden by a successful rebuild.

Each package owns its copied weights; there is no cross-package deduplication
in v1. No cache/index is shared across package identities. Document, section and
token vectors plus fitted PCA state are persisted as data-only NumPy arrays
(`allow_pickle=False`) under `solution-indexes/<package-id>/`. Publication is
atomic and fenced against disable/delete. Cache identity includes package,
ordered text-document versions, index/algorithm implementation and inference library
versions. A worker restart loads the model and cached index instead of
re-encoding documents or refitting PCA. Lightweight BM25 postings and document
associations are reconstructed from the lexical snapshot when applicable.
Unchanged document versions reuse the index; changes to any indexed text type rebuild it
with lexical fallback available. Successful publication prunes previous corpus
caches for that package. The cache contains private derived knowledge and must
not be redistributed with the portable ZIP.
The known model library's allocator may retain process memory after disable;
PKM drops its references but does not promise immediate OS memory reclamation.

## Resource planning and observations

Before enabling an imported package, Router shows local text/unit counts, model
size, estimated vector-index bytes, estimated additional peak disk, free disk
and estimated build RAM. Estimates use model dimension, section count, float64
stored vectors, Python float/tuple overhead, temporary arrays and model-loading
allowance. Token paths use maximum sequence length as a conservative workload
assumption. The disk estimate is **additional space after import**, not the
space already occupied by the ZIP and installed model. Missing dimensions are
reported as unavailable, never zero.

These are heuristics, not reservations or hard limits. Runtime/library overhead,
PCA workspace, tokenizer configuration, allocator behavior and concurrent
retrieval can make actual usage differ. Router warns when estimates exceed
reported free disk or available host RAM. CPU inference can use all available
cores; this implementation does not enforce CPU/RAM quotas.

During preparation, a 500 ms sampler records whole-worker RSS, sampled peak RSS,
elapsed time and average CPU core equivalents (one core = 100%). Router also
shows available logical CPUs and host available RAM. Linux measurements use
`/proc`; unsupported memory measurements on other platforms explicitly appear
as unavailable. Host memory may exceed a container's actual memory limit.
These observations include concurrent requests and are not incremental
model-only cost or a guarantee that an unsampled peak did not occur.

The existing worker process owns background construction. Closing a webview
does not cancel it. A worker crash/restart repeats an incomplete build; there is
no mid-batch resume or automatically detached OS training service.

The extension's code-only retrieval wheel and worker protocol are updated
together. Loading the updated extension and refreshing its managed MCP runtime
is required; this source change does not hot-replace an existing private
systemd serving deployment. No production service or user package selection is
changed by building or testing this feature.
Normal MCP Create/Repair installs the bundled code-only engine when the old
runtime lacks package support. That existing setup operation is distinct from
package import/enable and does not provision the optional inference libraries.

## Metrics and evidence

Local SQLite metrics record requested/actual package, corpus revision, entry
point, request/error counts, returned hit counts and enum fallback reasons.
No query text, returned content, source paths or exception details are stored
in metric buckets. Errors remain visible separately in runtime diagnostics.

Latency p50/p95 uses the latest 256 observations per bucket; the UI shows the
sample count and latest 100 buckets. Counts persist across worker restarts and
package deletion. History is local and has no automatic remote upload.
Returned-hit count is not a relevance or success metric. Source validation
scores remain clearly separate from online measurements on the importing corpus.

The imported route serves fuzzy text queries across Skills, Notes, Recipes,
Scripts and Research papers, plus subscribed text. `search_knowledge` is the
unified entry point, with an optional strict `content_type_filter`; specialized
tools such as Recipe methodology resolution retain their own policies.
Research covers already-indexed text, not raw PDF extraction, OCR or multimodal
retrieval. Type, source, visibility and read-only admission occurs **before**
candidate truncation, so other categories cannot crowd a requested type out of
the top results. Scopes reuse indexed vectors without re-encoding. Exact syntax,
deadlines and generation checks retain their existing contracts.
Source priority and `skill_context` metadata
admission may further reorder/filter results after worker retrieval.

## Verification and rollout boundary

The package-contract baseline passed 536 Observatory tests (100% statement and
branch coverage). The persistent-index update passed 25 focused PKM Python cases
plus 31 subtests, including exact restored rankings for all ten supported
architectures, seven Router/MCP Node scripts, the extension build and an
extracted VSIX packaging test. The packaging check excludes both `next-step/`
and `retrieval-solutions/`, even when a real weight ZIP is present locally.
The real offline E5 test exercises import, explicit enable, responsive lexical
queries during preparation, local indexing, retrieval, metrics, worker restart,
Skill edits, corrupt-cache rejection/rebuild, disable and deletion.

The opt-in real-model test is
[`test-retrieval-package-e2e.py`](../tests/test-retrieval-package-e2e.py);
set `PKM_SOLUTION_SMOKE_PACKAGE` to your trusted exported ZIP and run it in the
prepared inference environment with `HF_HUB_OFFLINE=1` and
`TRANSFORMERS_OFFLINE=1`. It does not modify the real Router state.
`PKM_SOLUTION_SMOKE_SKILL_COUNT=128` selects a larger synthetic workload.

For read-only acceptance against an already running, ready worker, set
`PKM_RETRIEVAL_LIVE_STATE` to its state directory and run
[`test-pkm-skill-mcp.js`](../tests/test-pkm-skill-mcp.js). Its generated FastMCP
server calls the real worker through the Skill, Note, Script, Research and Paper
semantic interfaces, checking package identity and typed hits. Test knowledge
and telemetry remain isolated; this does not synchronize fixture documents into
the shared worker or prove that an existing external MCP connection has refreshed
its schema. Such a connection still needs to reconnect to discover new tools.

On 2026-10-05, an isolated test with 128 synthetic Skills / 254 sections and the
local multilingual E5-small model measured:

| Quantity | Observation |
| --- | --- |
| Installed model files | 492,795,290 bytes |
| Estimated vector index | 1,173,504 bytes |
| Actual persisted index | 1,176,196 bytes |
| Estimated build RAM | 2,522,134,120 bytes |
| Sampled peak whole-worker RSS | 1,096,966,144 bytes |
| First preparation | 12.54 seconds |
| Restart with persisted index | 5.13 seconds, including model loading |
| Average whole-worker CPU during first preparation | 1.08 cores |

This test set `OMP_NUM_THREADS=1` and `MKL_NUM_THREADS=1`; it is not a prediction
for the user's corpus or an enforced production CPU limit. Source validation
quality was not remeasured on this synthetic workload.

Router rendering and state transitions were validated by automated tests.
The actual bundled renderer and styles were also exercised in headless Chromium:
desktop and 360 px layouts, empty/building/blocked/ready states, progress values,
keyboard focus, expanded details and action payloads. This is not an
installed-extension native file-picker test.
These isolated checks do not by themselves establish a production rollout,
native picker acceptance or retrieval quality on a user's current corpus.
Installing an updated extension does not hot-reload an already running window.
Package readiness also does not change an explicitly lexical query into a
semantic one: inspect actual contributing routes and serving identity.
The specialized MCP tools `search_skills`, `search_notes`, `search_scripts`,
`search_research` and its `search_papers` alias all accept `route="semantic"` or
`route="dual"`. These explicit model routes always return the shared status
envelope, including zero-hit/off/unavailable results; they never silently
substitute a legacy substring response. Defaults remain lexical and retain
their historical shapes. This discovery schema requires a current MCP
connection; replacing generated files does not change an old process's tools.
