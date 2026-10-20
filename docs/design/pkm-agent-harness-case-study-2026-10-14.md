# PKM Chat harness case study: AAGL Consumer

Date: 2026-10-14. This is an evidence-backed observation record, not a claim
about inaccessible Copilot internals and not authorization to submit an AML job.

## Evidence scope

The reviewed PKM Chat is `dd272c9d-9a5a-4c97-95b8-4322494e48d1`
(`Consumer`), stored under workspace namespace `71d6acd345276d69`. Its immutable
history contains 84 messages: 45 user/event messages and 39 assistant messages.
The 39 assistant attempts made 478 tool calls over 4,023.790 recorded seconds.
Thirty-six replies completed and three failed. The final attempt failed during a
VS Code model call and left one user input queued.

The selected model was the VS Code Copilot model labeled
`GPT-6.1 Sol · copilot`. The Chat used a requested context window of 460,896 and
requested output limit of 4,096. Provider-reported token usage was not available
in the persisted case evidence, so those values are configuration, not proof of
actual provider consumption.

The initial comparison target was VS Code Copilot Agent. The user reports
that its Consumer run completed the task and is waiting for the external result,
whereas the reviewed PKM run spent a long time without beginning actual AML job
submission. This is a user-observed outcome, not yet a trace-backed mechanism
comparison. No matching Agent trace, extension/VS Code version, initial
repository snapshot or tool catalog was supplied, and the remote Extension Host
does not expose the UI-side Copilot extension version.

On 2026-10-15, session discovery located the actual `AAGL Consumer` session
`09b01910-7fc8-4ce9-a159-1de5d0285838`, whose provider identity is `copilotcli`.
The user explicitly selected this Copilot SDK/CLI comparator for the new paired
experiment. It must not be relabeled as the built-in VS Code Copilot Agent.
The authorized experiment is an isolated, offline pre-submission replay:
no AML submission, upload, remote Cosmos read or production cache write.

## Live replay integration finding, 2026-10-15

Before grading task quality, the first live PKM setup attempt exposed a real
permission integration regression: two harmless builtin processes were denied
with `Request cancelled.` even though the owning Chat request was still active.
The real HTTP adapter uses its own deadline/cancellation signal for tool
execution; the approval controller incorrectly required that child signal to be
the identical object as the owning request's signal. This failed before the
Allow All or remembered-permission policy could be evaluated.

Approvals now retain both identities: the transport signal governs cancellation
of the tool and its pending approval, while an explicitly captured owner signal
must still match the original active request. A replaced or aborted owner is
rejected before and after awaiting approval. The same binding is used by builtin,
knowledge, delegation, VS Code and HTTP MCP permission callbacks. It does not
grant a permission, bypass host confirmations or transfer an old callback to a
new attempt.

Executable regressions cover child cancellation, owner replacement, unbound
children, cancelled owners, pending approvals, and real builtin processes through
both HTTP and native controller paths. The build, 118-test CTX core and legacy
API Chat regression passed; the strengthened native/HTTP controller suite then
passed all 45 tests. This is a newly reproduced integration failure, not proof
that the historical 478-call case had the same cause.

The SDK setup also encountered a recursive WebSocket-forwarder crash. The
experiment uses the SDK's explicitly nonexperimental HTTP mode, independently
verified with a real model response, and rejects unaudited WebSocket inference.
Both initial setup failures are retained rather than counted as successful task
runs.

The clean paired run uses 261 hash-verified source files reconstructed from
pre-run Git revisions and the original first two read-only attempts. Incomplete
original reads are labeled reference spans, not executable source. This is not a
recovery of the original complete dirty working tree. Both sides receive the same
prompt and production `run_process` schema; subprocesses run inside a filesystem
and network namespace with only their own writable workspace, no production HOME
and no network egress. PKM uses the actual headless production controller over
an authenticated SDK Responses adapter; the comparator uses SDK/CLI 1.0.87.
Retrieval, workers, external MCP and repository instructions are excluded from
this harness-only experiment. PKM's configured conservative context budget and
the SDK's default context management are recorded separately; they are not
claimed to be identical token budgets.

## Clean paired replay results, 2026-10-15

Both real model tasks finished without post-grade coaching or another model run.
The model was `gpt-6.1-sol`, with a 4,096-token output limit on both sides.
Independent scoring, followed by re-execution of each delivered offline entry
point in the same sandbox and another scoring pass, produced:

| Measurement | PKM production controller | Copilot SDK/CLI |
| --- | ---: | ---: |
| Independent offline contract checks | 37/37 | 37/37 |
| Wall time | 482.709 s | 543.281 s |
| Model dispatches | 51 | 36 |
| Process-tool calls | 50 | 84 |
| Provider input tokens, including cached tokens | 1,477,164 | 2,112,936 |
| Provider cached input tokens | 1,418,284 | 2,013,568 |
| Provider output tokens | 22,274 | 31,496 |
| Maximum serialized provider input | 227,193 bytes | 664,514 bytes |
| Independently rerun delivered unittest cases | 13 passed | 8 passed |

The 37 checks cover the supplied constraints, schema and extraction-size
estimate; honest cloud/stage status; existing artifacts; validator positive and
negative inputs; and exact assignment of the 31-row fixture across 12 partitions.
Both retained UDGv1, QB enabled/AQ disabled, ten assets and ten categories per
row, twelve A100 partitions, and the distinction between a 900-second sizing
estimate and a forbidden runtime cutoff. Both reported missing production
dependencies/identity as blockers instead of claiming cloud execution, stage
two/three completion or submission readiness.

The delivered tests are not identical business implementations. PKM delivered
configuration, validation, mapping and fixture checks. SDK/CLI additionally
changed the isolated runner's wrong-partition preflight and tested worker
completion/resume with explicitly fake CPU engines. Neither proves real GPU
inference, native protobuf conversion, Cosmos access, production cache writes
or end-to-end AML success.

All 51 PKM rounds were also independently reconstructed from the actual
Responses provider input. Their ordered message hashes and tool-schema hashes
match the production controller's transport receipts: 51/51, no mismatches.
The peak conservative transport estimate was 228,962 against an input budget
of 456,800; every planner receipt reported `fits`, with zero refinements and
zero omitted candidate IDs. This validates sustained tool use and constraint
retention in this sample, **not** long-task quality at a context boundary or
after compaction/recovery.

### Evaluator corrections and retained failures

- The first artifact check incorrectly rejected PKM's existing fixture directory
  because it only accepted regular files. The task did not prohibit directory
  artifacts. Accepting existing files or directories changes PKM's score from
  36/37 to 37/37 without changing agent code or prompting the model again.
  Original per-product `grade-initial.json` records are retained. The initial
  combined rendering was overwritten; `comparison-initial-reconstructed.json`
  is explicitly labeled as reconstructed from those original grade records.
- SDK/CLI encountered one `max_output_tokens` termination, recovered, produced
  a final public answer and emitted `session.idle`. The outer evaluator
  mistakenly retained the earlier termination as a fatal error after completion.
  Its raw `summary.json` still says failed; the grade explicitly records
  `agentCompleted` and `evaluatorError`, supported by the public event trace and
  final normally completed provider response. The transport fix has four passing
  regression tests. This is not a silently rewritten successful summary.
- The initial setup failures remain separate from this clean paired run.
  Independently rerunning the delivered entry points regenerates their local
  fixture/test reports; it does not modify their source code or invoke a model.
  Final scoring was repeated after those runners finished.

The final product fix also binds UI approval, quota-question and loop-review
decisions to the captured request owner, rather than comparing the transport
child signal to the root signal. Actual HTTP loop-review/UI continuation and
legacy UI approval regressions pass. Final `npm run test:chat-context` builds
successfully and reports **119 passed, 0 failed, 0 skipped, 0 TODO**.

### Interpretation and durable evidence

Offline contract correctness ties in this one sample. PKM used less wall time,
fewer process calls and fewer provider tokens, but more model dispatches.
Different system prompts, context management, adapter overhead and nonidentical
delivered tests prevent causal or statistical claims about superiority, cost,
general parity or loop elimination. This is a reconstructed task using a
headless PKM HTTP controller, not an installed native UI comparison; retrieval
was disabled. No production extension was replaced and no AML job was submitted.
VAL-02/VAL-03 and broader HAR validation remain open.

Durable evidence is under session
`dda87460-5a50-41f8-b3e5-cfa3ffbbbcd5`, `files/aagl-replay/run-02/`:
`snapshot.json`, `comparison.json`, both products' `evidence/grade.json`,
original summaries, provider requests/responses, public tool/event records,
delivered offline test logs, and `pkm/evidence/wire-audit.json`.
The following sections retain the original historical review and backlog;
current implementation/acceptance state is tracked in
[the roadmap](../../next-step/todo.md).

## Reconstructed task and authoritative changes

1. The initial request asked PKM to prepare an AAGL Consumer experiment over the
   supplied Cosmos stream using UDGv1 and Singularity, initially framing one-hour
   inference attempts.
2. The user required QB, explicitly excluded asset quality, stated that one input
   row yields ten assets, supplied 420 million rows, and selected twelve A100
   partitions.
3. The task was then narrowed to a three-step plan. Step one was a 15-minute
   Consumer experiment proving slice assignment, partition logs, JSON
   post-processing, JSON-to-protobuf conversion, multi-partition aggregation,
   cache update and inference-result storage. Step two was self-trigger testing.
   Step three was configuration-read testing.
4. The user then directed execution through experiment submission.
5. A worker proposed an active inference budget inside the runner. The user
   corrected that design: the inference unit must finish its assigned work; the
   target duration only estimates extraction size. Later worker evidence records
   that the runtime budget/API was withdrawn.
6. The user supplied the required schema, `ads-creativegen` cluster, Singularity
   A100 choice, QB, twelve A100s, a prior AML pipeline ID, `AssetType=headline`
   and `AdType=TA`, and repeatedly asked for AML submission.
7. The Chat did not persist a durable top-level acceptance state tying these
   changes together. It ended without submission evidence and with the request to
   document inputs, goal, tests, three-step plan and Singularity settings still
   queued.

## First reproducible capability divergence

The first divergence that can be reproduced from PKM code and trace evidence is
the local process-output guard. A worker reported that `git diff --stat` exceeded
the tool output limit and the process tree was terminated. Before this review,
`run_process` used a combined 6,000-character display buffer and killed the
process as soon as that buffer filled.

The implementation now separates these budgets:

- stdout and stderr continue to completion after the model preview reaches its
  6,000-character combined threshold;
- the result contains bounded head/tail previews and explicit `truncated=true`;
- complete stdout and stderr are stored under
  `.pkm/state/api-chat-tool-results/<chat-id>/`;
- a distinct 64 MiB storage hard limit can still terminate the process and
  reports the evidence paths;
- cancellation and the independently approved 1-120 second process timeout
  retain their existing behavior.

`npm run test:api-chat` verifies that a process emitting more than 14,000
characters exits normally, preserves both output tails and writes complete local
logs.

## Root-cause ranking

| Rank | Finding | Evidence | Confidence | Alternative explanation |
| --- | --- | --- | --- | --- |
| 1 | Task state and acceptance evidence were not durable enough for the evolving multi-step goal. | The user changed the meaning of the time limit, narrowed the plan, added schema/platform settings and repeatedly requested submission. Worker reports continued to revisit the withdrawn runner-budget direction. The final documentation request remained queued. | High | The model may have understood individual turns but failed later for unrelated provider reasons; no payload-by-payload semantic grading exists yet. |
| 2 | Tool evidence and worker coordination overwhelmed useful progress. | The task used 478 tool calls, including 153 file reads, 87 file finds, 73 processes and 20 worker messages. Multiple worker messages repeated the same read-only findings and budget withdrawal. | High | Some repetition may have been necessary because files changed concurrently; the trace does not yet label every duplicate by source revision. |
| 3 | A model-visible output cap incorrectly terminated healthy tools. | Worker evidence reports the `git diff --stat` termination; the former implementation killed on 6,000 displayed characters. | High | This did not by itself prevent AML submission, but it increased uncertainty and repeated inspection. |
| 4 | Completion judgment was reply-oriented rather than task-oriented. | Thirty-six assistant messages completed while the user repeatedly asked whether work and submission were finished. No durable submission receipt exists. | High | External permissions or missing authoritative job inputs may legitimately have blocked submission; that should have produced an explicit blocked task state. |
| 5 | Model timeout and local output budget ended later attempts. | Persisted failures include one VS Code model timeout and one local output-budget exhaustion. The final attempt failed during a model call. | High | These are terminal symptoms, not proof that larger budgets would fix planning or state retention. |
| 6 | Retrieval quality may have contributed, but is not established as the primary cause. | All 39 attempts have retrieval receipts; most selected 7-10 candidates. The current system ranks from the current query and injects bounded materializations. | Medium-low | Candidate count does not measure evidence coverage; no per-turn gold or sent-payload audit exists for this case. |

## Harness comparison matrix

The native Session viewer now has a dedicated
[subgraph UI and read-only browser host](pkm-native-harness-ui.md).
This exposes recorded evidence; it does not close the comparison or runtime
instrumentation gaps below.

| Mechanism | PKM evidence | Copilot comparison | Status |
| --- | --- | --- | --- |
| Task goal and acceptance state | Chat messages, Task identity and worker tree exist, but this case has no durable evolving goal/acceptance ledger. | No matching Agent trace or version supplied. | PKM code/trace observed; Copilot unknown |
| Tool discovery | Builtin, VS Code and MCP tools are persisted per attempt. | Exact comparison catalog unavailable. | PKM trace observed; Copilot unknown |
| Context assembly | Recent short dialogue, query-based current-Chat memory, pinned context and knowledge retrieval are code-confirmed. | Internal assembly/compaction unavailable. | PKM code confirmed; Copilot unknown |
| Tool output handling | Former 6,000-character display guard killed the process; this case triggered it. | No equivalent trace supplied. | PKM trace reproduced; Copilot unknown |
| Steering | Inputs can queue, but the final user request remained queued after failure. | No equivalent trace supplied. | PKM trace observed; Copilot unknown |
| Continuation and retry | Forty numbered attempts are persisted; final progress records a retry relationship. | No equivalent trace supplied. | PKM trace observed; Copilot unknown |
| Worker delegation | One worker tree and repeated worker messages/results are persisted. | No equivalent delegation trace supplied. | PKM trace observed; Copilot unknown |
| Recovery | Segmented immutable message history remained readable after failure. | No equivalent trace supplied. | PKM code/trace observed; Copilot unknown |
| Completion judgment | Completed replies did not establish completion of AML submission. | No equivalent acceptance receipt supplied. | PKM trace observed; Copilot unknown |

The context review found one concrete source of stagnation: historical worker
events were eligible for the six-message recent-dialogue window and could evict
authoritative user/assistant dialogue. Worker events already arrive as the
current input that wakes the manager, and remain retrievable as historical
evidence. They are now excluded only from the generic recent-dialogue window.
`npm run test:chat-context` covers this behavior.

## Budget ledger baseline

| Budget | Owner and unit | Configured/default scope | Observed behavior and receipt gap |
| --- | --- | --- | --- |
| Context/input | Chat/model profile; current estimator uses UTF-8 bytes plus 32 per message | Per model call; native saved value 460,896 in this case | Not a tokenizer. Tool schemas and calls are counted as serialized text; provider input usage was unavailable. |
| Output | Model profile and local stream; tokens plus 100,000 local output bytes | 4,096 requested tokens in this case | One local output-budget failure occurred. Requested, local observed and provider-reported values are not yet one receipt. |
| Model timeout | Extension; milliseconds per model call | 120 seconds default, configurable 10-600 | One model timeout occurred. Human/tool time is separate. First-token, idle and total inference time are not separately receipted. |
| Tool rounds/loop review | Chat loop guard; rounds and active milliseconds | Native active review 30 minutes; repeated equal call/result evidence at 3 | The case reached attempt 40; activity count is not acceptance progress. |
| Tool calls | Transport; calls and argument characters | 16 calls per HTTP round and 32,000 argument characters | The case made 478 calls across attempts. There is no task-level tool-cost ledger. |
| Local process timeout | Builtin tool; seconds | Default 30, approved integer 1-120 | Still a hard execution limit. Long background handles remain future work. |
| Local process preview | Builtin tool; characters | 6,000 combined bounded preview | Now truncates the preview without killing a healthy process. |
| Local process evidence | Builtin tool; bytes | Complete local logs; 64 MiB hard storage limit | Added by this review. Range/tail retrieval and background handles remain open. |
| HTTP MCP timeout | MCP client; milliseconds | 30,000 | Approval/wait semantics and durable late results need unified receipts. |
| Knowledge retrieval | Retrieval worker; milliseconds and candidates | L1 lexical, topK 20, 5,000 ms | Selected counts exist, but materialized/sent provenance is incomplete. |
| Workers | Task tree; concurrent workers | 3 automatic, 10 maximum by default | No task-level token/cost/CPU ledger yet. |

### Per-round ledger follow-up, 2026-10-20

The historical table above describes the reviewed case, not the current timeout
default. Current Chat uses an inactivity timeout of 1,800 seconds, configurable
from 10 to 86,400 seconds. Tool execution and tracked user waits do not count as
model inactivity. The user explicitly chose **Provider-default main Chat
thinking**; no thinking override or new budget enforcement is introduced.

New `pkm.chat.budget/v1` receipts optionally contain
`pkm.chat.budget-ledger/v1`. Native and HTTP controller paths record:

- per-round planned input estimates, transport counting and provider usage as
  distinct observations, each with its source, unit, owner and scope;
- configured output/inactivity limits versus active-time/tool-round review
  triggers, without presenting continuation review as a hard task deadline;
- reported input/output/cache/reasoning usage and derived visible output only
  when the provider exposes the corresponding quantities;
- cumulative attempt active time, tracked question/approval/continuation waits,
  recorded tool-call identities, context refinement counts and terminal outcome;
- configured-price cost estimates only when both prices and provider usage are
  available, not a bill or an estimate covering unreported inference rounds.

Usage frames are snapshots of the current inference: repeated/cumulative frames
replace that round's usage. Only distinct rounds accumulate. Missing reasoning,
cache or pricing is not zero. Attempt counters are cumulative observations and
must not be summed across round snapshots. An approved continuation can reset
the review window without resetting cumulative accounting. Native provider
confirmations remain outside PKM's tracked wait states.

The ledger survives normal persistence and read-only Session Snapshots. Restart
marks the last observation interrupted without inventing active time or provider
usage during downtime. The existing Harness graph exposes each row as read-only
accounting; legacy receipts without a ledger retain their original view.

This first layer does **not** close BUD-01: per-tool timeout/output/log-storage
receipts, retrieval deadlines, separate Memory-model aggregation, task-wide
worker/resource allocation, CPU/RSS, model first-token/idle measurements and
provider invoices still need their own actual sources and lifecycle wiring.
They cannot be inferred from elapsed wall time, UI event counts or local bytes.

Repeatable validation: `npm run test:chat-budget-ledger` covers accounting,
real HTTP/native controller paths, duplicate usage frames, persistence/recovery
and production-renderer desktop/narrow browser navigation without model calls.
The browser portion uses an existing Playwright/Chromium installation; set
`PKM_PLAYWRIGHT_PATH` when it is outside the package, as documented in the
[native UI acceptance](pkm-native-harness-ui.md). It does not install or download
browsers automatically.

## Open evidence

- Provide the exact Copilot product/mode/version and its trace for the same
  repository snapshot before completing HAR-01.
- Recover or recreate the original repository snapshot and authoritative AML
  submission state before judging whether submission was possible.
- Add per-round selected/materialized/sent manifests before attributing this case
  to retrieval quality.
- Implement durable goal/constraint/acceptance state before claiming HAR-02.
- Add background process handles, range/tail reads and restart recovery before
  claiming HAR-03 complete.
