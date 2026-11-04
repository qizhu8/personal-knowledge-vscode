# Agent harness: progress and resource review

Status: original scoring proposal archived; the reopened goal-ownership work
below has a local implementation candidate. This is not an implemented scoring
engine or a promise of durable unattended execution.

## Reopened review: goal ownership, 2026-10-24

The live Copilot investigation demonstrated actual tool execution but required
repeated external steering. Its last successful public-source investigation
settled a bounded subtask, not the user's overall authentication problem.
This reopens the goal-ownership question; it does not activate the archived
scoring proposal or authorize automatic retries.

### Verified PKM boundaries before this implementation

- `ApiChatView.send` recognizes explicit debugging phrases and stores a
  `debugRequest`. Another explicit debug input replaces its goal with the new
  text; implicit continuation only retains an `investigating` request. A
  `needs_input` or `blocked` request is not reactivated by that branch alone.
  There is no stable parent-goal identity in this debug record.
- `finish_debug` accepts `completed` with at least one successful diagnostic
  call. It checks call identity and execution, not whether the user's original
  acceptance criteria were met. This is useful evidence hygiene but not a
  resolution certificate.
- `beforeFinish` grants one correction when an investigating debug request
  tries to finish without an outcome. Once `finish_debug` records an outcome,
  that correction no longer applies. It is not an outer goal-continuation
  controller.
- Managed Tasks already have explicit task/constraint/acceptance/validation
  reports and `currentHarnessTaskState`, refreshed in model context. Those
  reports require `sessionId`, are agent interpretations, and explicitly do not
  complete the managed Task. Ordinary Chat cannot rely on them as a universal
  goal lifecycle. Reuse this existing surface rather than build a competing
  task database.
- `classifyTaskProgress` is used by the store's progress projection. Its
  distinct-call/activity signals do not certify acceptance or decide the next
  action. Changing a query can avoid identical-call detection without making
  useful progress.
  Running invocations do not contribute to repeated no-output or failure
  thresholds: they have no outcome yet. A running-to-terminal snapshot of the
  same call identity contributes once, and genuinely repeated terminal calls
  still trigger the existing loop threshold. Distinct tool activity remains
  an observation, not proof of artifact progress or task acceptance.
- The inspected model failure/cancellation path records failure and preserves
  prior effects, but does not itself schedule a reconciled goal continuation.
  This is appropriate for uncertain effects; recovery needs explicit ownership
  and admission, not blind replay.

### Bounded manager requests

The first three-Chat parallel trial exceeded prompt-only round targets and
external cancellation truncated two reports. Explicit API sends can now carry
a non-renewable `hard_tool_round_limit` (1-1000). The shared execution guard
applies it independently of timed review and Continue decisions, then permits
at most one tool-free summary. SDK transport first confirms stopping its
tool-capable session, then creates a tool-free summary session; failure to stop
prevents that summary session from starting.

The limit and observed boundary are persisted with the reply and exposed in
API/Harness diagnostics. Open goals remain interrupted rather than accepted;
Stop, errors and provider output/context limits still take precedence. Separate
activity review gates apply per submitted Chat response: 200 reported Copilot
credits by default and a 20-minute active-time review interval. Detached
background-process lifetime and non-inference tool work are not Copilot credit
usage; model inference used to track a process still is. At a gate, the user can
raise the response limit, bypass limits for that response or the whole Chat
session, pause, or cancel. Session bypass is persisted with the Chat and can be
reset in Model Settings. Missing provider usage remains unknown, never zero.
These gates do not add a cumulative input cap, progress evaluator or automatic
scheduler. Local fake provider/controller tests are not live SDK or
installed-build acceptance.

### Reference comparison

Reviewed only at the previously selected revisions; no reference project was
installed, activated or run. These are design references, not validated claims
that another product will solve the user's task.

| Reference | Relevant evidence | PKM application and limit |
| --- | --- | --- |
| [DeepSeek goal driver](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/goal/goal-round-driver/README.md) and its `src/index.ts` | Separates model/tool steps from an armed same-session goal driver. Reserves one continuation at idle, flushes state, fences revisions and yields to human input. Cancel/resume/unload do not silently rearm execution. | Strongest match for the missing outer loop. Its README explicitly says there is no independent evaluator; continuation alone does not certify success. Do not import Cordis or its runtime. |
| [Harness2 recursion](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/recursion.py) | Proposals are followed by actual rollouts before composition; rejected/failed proposal stages preserve fallback evidence. | Evaluate a changed approach against results, rather than treat another summary as progress. This optimizes harness candidates, not a drop-in business-task supervisor or permission to self-modify PKM. |
| [Diagnosing bugs](https://github.com/mattpocock/skills/blob/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/engineering/diagnosing-bugs/SKILL.md) | Prioritizes a red-capable feedback loop that catches the exact reported symptom, then hypothesis-linked probes and verification. | Require a test/observation tied to the user's failure. For intermittent external failures, record inaccessible evidence honestly rather than demand an impossible deterministic reproduction before any investigation. |
| [Ponytail](https://github.com/DietrichGebert/ponytail/blob/09c434ab73ca43761c5d8b0c5d341926c2fba710/.openclaw/skills/ponytail/SKILL.md) | Smallest complete change includes callers, fixtures, validation and limitations. | Retain end-to-end scope; a local fix or tool call is not completion. Do not add a workflow framework for its own sake. |
| [Orca sessions](https://github.com/stablyai/orca/blob/301059fb77d083eb93c744f20c5a89906d8c4c3a/docs/site/content/docs/model/agents-sessions.mdx) | Distinguishes working, needs-user, blocked/interrupted and restart lifecycle. | Make waiting and ownership visible. Its terminal quiet/idle detection is not PKM acceptance authority; do not copy its permissive launch defaults. |

### Smallest complete next implementation

1. Preserve a stable user objective and its scope/acceptance separately from
   the current attempt or diagnostic subtask. Incorporate new requirements
   without silently replacing the root objective. Do not automatically turn
   every ordinary question into a managed Task.
2. Distinguish attempt outcomes from goal outcomes: investigated, changed,
   verified, awaiting input/permission/external work, interrupted and resolved.
   Bind completion claims to acceptance evidence and state remaining criteria;
   no claim of universally automated semantic verification.
3. At an eligible idle boundary, review the unmet objective and choose one
   authorized next action, a changed approach or an explicit blocker. Reuse
   existing queue, revision/lock, permission, worker and budget mechanisms.
   Human messages/edit holds take precedence. Do not repeatedly nudge a
   blocked goal with identical prompts.
4. Preserve the goal on cancellation/access loss, but disarm execution. Resume
   only under applicable user authority, reconciling recorded calls, artifacts
   and uncertain effects first. Never replay mutations or remotely submitted
   work just to reconstruct receipts.
5. Accept the behavior with an uncoached end-to-end task: one initial objective,
   independent symptom-level verification, no external next-step prompts.
   Include an early-summary model, misleading successful diagnostic, blocked
   input followed by an answer, changed requirements, cancellation with an
   uncertain effect, cross-window ownership and editing races. Pair deterministic
   controller regressions with a real-model run; neither substitutes for the
   other. Report outcome and intervention count, not tool count as success.

The review above identified a control-loop gap without changing runtime behavior.

### Local implementation candidate

The user selected automatic goal ownership for explicit execution delegations,
not ordinary questions. The candidate persists an original work objective,
separates current attempts, retains root acceptance across follow-ups, requires
all ordered input IDs in `report_work`, and checks evidence references. Active
goals use the existing HTTP/native `beforeFinish` hook to continue in the same
request; repeated endings with no new execution evidence fail explicitly.
Blocked answers reactivate the same goal. Cancel/failure/host recovery disarm
unfinished work; explicit resume must reconcile effects, not replay them.
Existing managed Task authority, permission and budget mechanisms remain intact.

This deliberately does **not** implement DeepSeek's durable idle/new-request
driver, an independent semantic evaluator or general natural-language intent
classification. Evidence-linked acceptance remains a model claim. A successful
diagnostic is not independently proof that the original problem is fixed.

The work-intent admission baseline is evaluated through `prepareWorkGoal`,
separately from any change to runtime dispatch. Its 29 execution, exploration
and quoted-instruction fixtures have provisional labels: the current heuristic
misses 9 of 18 explicit execution requests (50% false-negative rate) and
admits 7 of 11 non-execution phrases (63.6% false-positive rate; 56.3%
precision on this sample). The user confirmed “Pause the current task.” is an
explicit pause command. The stop matcher now accepts “the current task” and a
negative-command regression verifies “Please do not pause the current task.”
does not pause. All four stop/resume controls pass.

`tools/work-intent-review/index.html` is an offline annotation bench for the 29
intent phrases and four controls. It hides provisional labels until a reviewer
decides, supports unclear/notes, local persistence, JSON import/export, and
comparison only after all samples are reviewed. It does not change dispatch.
The benchmark labels remain provisional pending user review; these small
sample results are not calibrated population rates or authorization to change
automatic goal activation.

The false-completion regression also resumes after a `continue` report that
contained successful evidence, then verifies that the new attempt clears those
receipts, rejects the prior assistant reply, and cannot resolve using the old
call ID alone.

The conditional requirement recall fixture now also corrects an AML rule,
deletes the superseded requirement, verifies the deletion suppression survives
a later source, and confirms a separate Root cannot see either requirement.

The complete related context gate passed 218/218 tests without skips, including
both transports, actual local fixture repair after an early diagnostic summary,
blocked-answer resume, cancellation/resume without duplicating an effect, and
persisted host-interruption recovery. Adjacent diagnostics/process/budget tests
passed 26/26. Those provider decisions were scripted. The VSIX isolated
dependency, resource and service gates also passed.

Candidate build `9da4ea4186fce604db080c80672bda226c7e89f1ab745335a226383ca779e36d`
was installed after user authorization. Only one idle AML-workspace host was
targeted for reload; its successor advertises the candidate and is ready.
The repository workspace remains on its previously loaded build. The registry
successor slot differed, so the coordinated reload acknowledgement has not
been verified; do not conflate a loaded candidate with that separate handshake.

The user authorized one isolated real-model repair task, not another production
authentication attempt. GPT-6.1 Sol received one original delegation and no
next-step coaching. It read the fixture, ran a failing symptom check, changed
and saved the implementation, then ran the check again. Independent execution
now passes the original 8/8 tests (baseline: 2 pass, 6 fail) and 131 extra contract
assertions. The existing test file predates submission and was not changed.
The final request receipt succeeded, the public reply is complete, and the
persisted original goal is resolved with current-attempt evidence. The first
`report_work` omitted the required root criterion and was rejected; the model
corrected it itself without another user input. This took 11 model rounds, with
one original user input and zero external next-step prompts. Actual credits
are not reported by the public API.

This establishes a small, uncoached repair task end to end, not universal
autonomy or proof of reliable long-running production recovery. The production
authentication problem remains unresolved and was not resumed. More complex
tasks and the separate reload-slot acknowledgement remain follow-up work.

## Bounded transition receipts, 2026-10-29

The `pkm-harness-improve` branch adds an optional, bounded list of up to 64
typed work-goal lifecycle transitions: delegation, follow-up/answer/resume,
pause, agent report/action, cancellation/failure and host recovery. Events
contain a timestamp and input/attempt IDs plus controlled reason/status enums;
they do not copy user text. Older records without the field remain valid.

This is diagnostic evidence, not an independently calibrated stop-reason
classifier. It does not change execution or permissions and has not been
installed. Focused build/tests are the only validation claimed here.

## Current pragmatic policy

A Chat activity means one submitted turn, including its model/tool rounds. UI
Activity events are execution history, not acceptance evidence or progress.
Native Chat reviews continuation only when both its active-time window has
elapsed and its tool guard has detected a repeated call/result loop. The default
window is 30 minutes, configurable with `apiChatLoopReviewMinutes`. Waiting for
PKM user input, approval or continuation is excluded. Continue starts a fresh
window without replaying completed tools. Answer with current results and Cancel
remain explicit alternatives; Allow All cannot approve continuation.

The first detector is deliberately coarse: three equal canonical argument/result
pairs for a non-exempt tool. Changed arguments/results clear that tool's evidence.
Interleaved tools are tracked separately. Time alone, tool count and UI event
count do not establish failure. Checks happen between model/tool calls; an
in-flight tool's internal loop cannot be diagnosed by this guard. Single model
calls, programs, output/context budgets, trust and permissions retain separate
limits. Native provider confirmations are outside PKM's tracked waiting states.

## Research question

How should an agent preserve required outcomes while stopping stale approaches,
dead loops and resource waste, without treating slow useful debugging as failure?

Activity is not meaningful progress. Even observable progress may have little
value or lead down a dead end. Separate the mandatory Task goal from the current
solution, which is replaceable. Freeze a solution, not necessarily the Task.

## Candidate evidence and decisions

- Start with rules for identical calls/results, repeated failures, state cycles
  and unchanged acceptance evidence. Nonexploratory tasks often permit cheap
  checks against tests, artifacts or explicit stage acceptance criteria.
- Preserve a necessary debugging goal despite slow progress. Change a stale
  method when its evidence stops changing rather than silently dropping the fix.
- For exploratory QPS work, freeze routes with negligible or negative gains and
  try authorized low-hanging fruit. Do not equate experiments run with benefit.
- Review expected gain, effort already spent, remaining coarse workload, risk
  and confidence. Estimates are uncertain; sunk effort is not a reason to continue.
- Let the agent choose obvious authorized alternatives. Ask the user about
  material tradeoffs, ambiguous priorities, new permissions or expanded budgets.
- Use time/resource thresholds to trigger review, not an automatic failure label.
  Distinguish these review triggers from security and true operational hard limits.
- Consult a reviewer at checkpoints, not every step, with bounded review overhead.

## Recovery and future work

Record a frozen solution's evidence, why it was frozen, alternatives considered
and conditions for returning to it. Durable long-task checkpoints and recovery,
workload estimation, semantic progress evaluation and calibrated route ranking
remain future work. Revisit them only after the basic harness is usable and real
failure cases demonstrate that the simple detector is inadequate.

The immediate motivating failure was a 120-second whole-request timer expiring
while `ask_user` waited for a privacy/sync decision. The approval was appropriate;
removing it would not fix the scheduling problem. There was no observed tool loop
in that failure. The new policy must not confuse human waiting with agent staleness.