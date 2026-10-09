# Agent harness: progress and resource review

Status: archived research proposal, deferred. This is not an implemented scoring
engine or a promise of durable unattended execution.

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