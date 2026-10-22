# Offline Retrieval Solution Packages

Ordinary installations continue to use Exact/BM25. No model weights are bundled
in the extension, fetched on demand, or selected automatically. Importing a
solution is separate from enabling it. PKM never trains the imported weights.

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

**Current integration gap:** the current extension Router renders the mature
Exact/BM25 toggle, its benchmark and a disabled proposed model map. It does not
yet expose the text-solution import, selection or preparation controls described
below. The local worker has solution catalog and enable/rebuild/disable/delete
interfaces, but these are not wired into the current Router message handlers.
The following UI workflow is the intended contract, not a currently available
end-to-end desktop workflow. There is no model-weight download button. A Router
benchmark measures the lexical synthetic corpus, not an imported model.
Router now explicitly labels this availability boundary. End-to-end model
management remains pending: package provenance/import, selected versus ready
model, explicit weight acquisition, dependency readiness, preparation progress,
resource observations and per-query path visualization need one connected UX.

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
No extension was installed or reloaded, no existing service was restarted, and
no package was enabled in production as part of this verification.
