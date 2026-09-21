#!/usr/bin/env node
const assert = require("assert");
const runtime = require("../dist/workflows/runtime-model.js");

const {
  ATTEMPT_STATES, NODE_STATES, RUN_STATES, WorkflowRuntimeError, acceptOutcome,
  canFinishEvidence, checkpointAttempt, closeIndeterminate, createAttempt,
  createRuntimeModel, executionAuthority, recordCompletion, recoverStagedCheckpoint,
  setAttemptAuthority, stageCheckpoint, transitionAttempt, transitionNode,
  transitionRun, validateDeadlines
} = runtime;

let commandNumber = 0;
const envelope = (model, fingerprint = "fp", attempt = false) => ({
  commandId: `cmd-${++commandNumber}`,
  fingerprint,
  expected: {
    run: model.run.version,
    node: model.node.version,
    ...(attempt ? { attempt: current(model).version } : {})
  }
});
const apply = result => result.model;
const current = model => model.attempts.find(attempt => attempt.attemptId === model.node.currentAttemptId);
const error = (action, code) => assert.throws(action, value => value instanceof WorkflowRuntimeError && value.code === code);
const initialInput = (attemptId = "attempt-1") => ({
  attemptId, executionDeadline: 100, evidenceDeadline: 120, leaseFence: 7, mode: "initial"
});
const withAttempt = () => {
  let model = createRuntimeModel("run-1", "node-1", 500, 400);
  model = apply(createAttempt(model, envelope(model), initialInput()));
  return model;
};
const executing = () => {
  let model = withAttempt();
  model = apply(transitionAttempt(model, envelope(model, "admit", true), "admitted", 7));
  model = apply(setAttemptAuthority(model, envelope(model, "lease", true), 7, true, false, "none"));
  model = apply(transitionAttempt(model, envelope(model, "execute", true), "executing", 7));
  return model;
};

assert.deepStrictEqual(RUN_STATES, [
  "draft", "validating", "ready", "running", "pausing", "paused", "cancelling",
  "reconciling", "blocked", "succeeded", "failed", "cancelled", "closed-indeterminate"
]);
assert.deepStrictEqual(NODE_STATES, [
  "pending", "attempting", "waiting-retry", "checkpointed", "paused", "reconciling",
  "blocked", "succeeded", "failed", "cancelled"
]);
assert.deepStrictEqual(ATTEMPT_STATES, [
  "planned", "admitted", "executing", "awaiting-evidence", "awaiting-outcome",
  "checkpointed", "reconciling", "succeeded", "failed", "cancelled", "indeterminate"
]);

let model = createRuntimeModel("run", "node", 50, 40);
assert.deepStrictEqual(model.run, { runId: "run", state: "draft", version: 1, deadline: 50 });
assert.deepStrictEqual(model.node, { nodeId: "node", state: "pending", version: 1, deadline: 40 });
error(() => createRuntimeModel("run", "node", 39, 40), "deadline-order");
let result = transitionRun(model, envelope(model, "validate"), "validating");
model = result.model;
assert.strictEqual(result.replayed, false);
assert.strictEqual(result.receipt.kind, "run-transition");
assert.strictEqual(result.receipt.attemptVersion, undefined);
const replay = transitionRun(model, { commandId: result.receipt.commandId, fingerprint: "validate", expected: { run: 0, node: 0 } }, "validating");
assert.strictEqual(replay.replayed, true);
assert.strictEqual(replay.model, model);
assert.strictEqual(replay.receipt, result.receipt);
error(() => transitionRun(model, { commandId: result.receipt.commandId, fingerprint: "different", expected: { run: 0, node: 0 } }, "ready"), "command-conflict");
error(() => transitionRun(model, { ...envelope(model), expected: { run: 0, node: model.node.version } }, "ready"), "version-conflict");
error(() => transitionRun(model, { ...envelope(model), expected: { run: model.run.version, node: 0 } }, "ready"), "version-conflict");
model = apply(transitionRun(model, envelope(model), "ready"));
model = apply(transitionRun(model, envelope(model), "running"));
model = apply(transitionRun(model, envelope(model), "pausing"));
model = apply(transitionRun(model, envelope(model), "paused"));
model = apply(transitionRun(model, envelope(model), "running"));
error(() => transitionRun(model, envelope(model), "ready"), "transition-illegal");
const terminalRun = apply(transitionRun(model, envelope(model), "succeeded"));
error(() => transitionRun(terminalRun, envelope(terminalRun), "failed"), "terminal-immutable");

model = createRuntimeModel("run", "node", 50, 40);
model = apply(transitionNode(model, envelope(model), "paused"));
model = apply(transitionNode(model, envelope(model), "blocked"));
model = apply(transitionNode(model, envelope(model), "cancelled"));
error(() => transitionNode(model, envelope(model), "failed"), "terminal-immutable");
const illegalNode = createRuntimeModel("run", "node", 50, 40);
error(() => transitionNode(illegalNode, envelope(illegalNode), "succeeded"), "transition-illegal");

validateDeadlines(1, 1);
validateDeadlines(1, 2);
error(() => validateDeadlines(Infinity, 2), "deadline-invalid");
error(() => validateDeadlines(1, NaN), "deadline-invalid");
error(() => validateDeadlines(2, 1), "deadline-order");

model = createRuntimeModel("run", "node", 500, 400);
result = createAttempt(model, envelope(model, "initial"), initialInput());
model = result.model;
assert.strictEqual(result.receipt.attemptVersion, 1);
assert.deepStrictEqual(current(model), {
  attemptId: "attempt-1", number: 1, state: "planned", version: 1,
  previousAttemptId: undefined, resumedFromAttemptId: undefined, checkpointManifestId: undefined,
  reasonReceiptId: undefined, leaseFence: 7, leaseActive: false, resourcesReleased: true,
  effectState: "none", executionDeadline: 100, evidenceDeadline: 120
});
error(() => createAttempt(model, envelope(model), initialInput()), "attempt-id-conflict");
error(() => createAttempt({ ...model, node: { ...model.node, currentAttemptId: undefined } }, envelope({ ...model, node: { ...model.node, currentAttemptId: undefined } }), { ...initialInput("attempt-2"), mode: "initial" }), "attempt-mode");
error(() => createAttempt(createRuntimeModel("r", "n", 500, 400), envelope(createRuntimeModel("r", "n", 500, 400)), { ...initialInput(), mode: "retry", reasonReceiptId: "reason" }), "attempt-mode");
error(() => createAttempt(model, envelope(model), { ...initialInput("attempt-2"), mode: "retry", reasonReceiptId: "reason" }), "attempt-current");
const shortAggregate = createRuntimeModel("short-run", "short-node", 110, 110);
error(() => createAttempt(shortAggregate, envelope(shortAggregate), initialInput()), "aggregate-deadline");

error(() => transitionAttempt(model, envelope(model, "bad-version", false), "admitted", 7), "version-conflict");
error(() => transitionAttempt(model, { ...envelope(model, "bad-attempt", true), expected: { run: model.run.version, node: model.node.version, attempt: 0 } }, "admitted", 7), "version-conflict");
error(() => transitionAttempt(model, envelope(model, "no-fence", true), "admitted"), "lease-fenced");
error(() => transitionAttempt(model, envelope(model, "stale-fence", true), "admitted", 6), "lease-fenced");
error(() => transitionAttempt(model, envelope(model, "illegal", true), "succeeded", 7), "transition-illegal");
model = apply(transitionAttempt(model, envelope(model, "admit", true), "admitted", 7));
error(() => transitionAttempt(model, envelope(model, "execute-inactive", true), "executing", 7), "lease-inactive");
model = apply(setAttemptAuthority(model, envelope(model, "authority", true), 7, true, false, "settled"));
assert.strictEqual(current(model).leaseActive, true);
error(() => setAttemptAuthority(model, envelope(model, "authority-stale", true), 8, false, true, "none"), "lease-fenced");
model = apply(transitionAttempt(model, envelope(model, "execute", true), "executing", 7));
assert.strictEqual(executionAuthority(current(model), 100), "execute");
assert.strictEqual(executionAuthority(current(model), 101), "checkpoint-or-cancel");
error(() => recordCompletion(model, envelope(model, "late", true), 7, 101), "execution-deadline");
result = recordCompletion(model, envelope(model, "complete", true), 7, 100);
model = result.model;
assert.strictEqual(current(model).completionCommittedAt, 100);
error(() => recordCompletion(model, envelope(model, "wrong-state", true), 7, 99), "completion-state");
assert.strictEqual(canFinishEvidence(current(model), 120), true);
assert.strictEqual(canFinishEvidence(current(model), 121), false);
assert.strictEqual(canFinishEvidence({ ...current(model), completionCommittedAt: 101 }, 110), false);
assert.strictEqual(canFinishEvidence({ ...current(model), completionCommittedAt: undefined }, 110), false);
model = apply(transitionAttempt(model, envelope(model, "await-outcome", true), "awaiting-outcome", 7));
result = acceptOutcome(model, envelope(model, "accept", true), "manifest-outcome", "succeeded", 7, 120);
model = result.model;
assert.strictEqual(model.node.state, "succeeded");
assert.strictEqual(model.node.currentAttemptId, undefined);
assert.strictEqual(model.node.authoritativeAttemptId, "attempt-1");
assert.strictEqual(model.attempts[0].outcomeManifestId, "manifest-outcome");
error(() => transitionAttempt({ ...model, node: { ...model.node, currentAttemptId: "attempt-1" } }, envelope({ ...model, node: { ...model.node, currentAttemptId: "attempt-1" } }, "terminal", true), "failed", 7), "terminal-immutable");

let outcomeModel = executing();
outcomeModel = apply(recordCompletion(outcomeModel, envelope(outcomeModel, "completion", true), 7, 90));
outcomeModel = apply(transitionAttempt(outcomeModel, envelope(outcomeModel, "outcome", true), "awaiting-outcome", 7));
error(() => acceptOutcome({ ...outcomeModel, node: { ...outcomeModel.node, authoritativeAttemptId: "other" } }, envelope({ ...outcomeModel, node: { ...outcomeModel.node, authoritativeAttemptId: "other" } }, "duplicate", true), "m", "failed", 7, 100), "outcome-already-authoritative");
error(() => acceptOutcome(outcomeModel, envelope(outcomeModel, "stale", true), "m", "failed", 8, 100), "lease-fenced");
error(() => acceptOutcome({ ...outcomeModel, attempts: outcomeModel.attempts.map(attempt => ({ ...attempt, effectState: "uncertain" })) }, envelope({ ...outcomeModel, attempts: outcomeModel.attempts.map(attempt => ({ ...attempt, effectState: "uncertain" })) }, "uncertain", true), "m", "failed", 7, 100), "effect-unresolved");
error(() => acceptOutcome(outcomeModel, envelope(outcomeModel, "expired", true), "m", "failed", 7, 121), "evidence-deadline");

let checkpointModel = executing();
const inactiveCheckpoint = { ...checkpointModel, attempts: checkpointModel.attempts.map(attempt => ({ ...attempt, leaseActive: false })) };
error(() => checkpointAttempt(inactiveCheckpoint, envelope(inactiveCheckpoint, "inactive", true), "manifest", "cursor", 7), "lease-inactive");
error(() => checkpointAttempt(checkpointModel, envelope(checkpointModel, "blank", true), "manifest", " ", 7), "usage-cursor-required");
error(() => checkpointAttempt(checkpointModel, envelope(checkpointModel, "fenced", true), "manifest", "cursor", 8), "lease-fenced");
result = checkpointAttempt(checkpointModel, envelope(checkpointModel, "checkpoint", true), "manifest", "cursor", 7);
checkpointModel = result.model;
assert.strictEqual(checkpointModel.node.state, "checkpointed");
assert.strictEqual(checkpointModel.node.currentAttemptId, undefined);
assert.strictEqual(checkpointModel.attempts[0].state, "checkpointed");
assert.strictEqual(checkpointModel.attempts[0].leaseFence, 8);
assert.strictEqual(checkpointModel.attempts[0].resourcesReleased, true);
assert.strictEqual(checkpointModel.attempts[0].checkpointUsageCursor, "cursor");
const terminalCheckpoint = { ...checkpointModel, node: { ...checkpointModel.node, currentAttemptId: "attempt-1" }, attempts: checkpointModel.attempts.map(attempt => ({ ...attempt, leaseActive: true })) };
error(() => checkpointAttempt(terminalCheckpoint, envelope(terminalCheckpoint, "checkpoint-terminal", true), "m2", "cursor", 8), "checkpoint-state");

let replacementBase = checkpointModel;
error(() => createAttempt(replacementBase, envelope(replacementBase), { ...initialInput("retry-2"), mode: "retry" }), "retry-reason-required");
error(() => createAttempt(replacementBase, envelope(replacementBase), { ...initialInput("resume-2"), mode: "resume" }), "resume-checkpoint-required");
result = createAttempt(replacementBase, envelope(replacementBase, "resume"), {
  ...initialInput("attempt-2"), mode: "resume", checkpointManifestId: "manifest", leaseFence: 9
});
let resumed = result.model;
assert.strictEqual(current(resumed).number, 2);
assert.strictEqual(current(resumed).previousAttemptId, "attempt-1");
assert.strictEqual(current(resumed).resumedFromAttemptId, "attempt-1");
assert.strictEqual(current(resumed).checkpointManifestId, "manifest");

let retryBase = executing();
retryBase = apply(setAttemptAuthority(retryBase, envelope(retryBase, "settle", true), 7, false, true, "none"));
retryBase = apply(transitionAttempt(retryBase, envelope(retryBase, "failure", true), "failed", 7));
retryBase = { ...retryBase, node: { ...retryBase.node, state: "waiting-retry", currentAttemptId: undefined, version: retryBase.node.version + 1 } };
result = createAttempt(retryBase, envelope(retryBase, "retry"), {
  ...initialInput("attempt-2"), mode: "retry", reasonReceiptId: "decision-1", leaseFence: 9
});
assert.strictEqual(current(result.model).reasonReceiptId, "decision-1");
assert.strictEqual(current(result.model).resumedFromAttemptId, undefined);
const retriedAdmitted = apply(transitionAttempt(result.model, envelope(result.model, "retry-admitted", true), "admitted", 9));
assert.strictEqual(retriedAdmitted.attempts[0], result.model.attempts[0]);
assert.strictEqual(retriedAdmitted.attempts[1].state, "admitted");

const unsettledCases = [
  { state: "executing", leaseActive: false, resourcesReleased: true, effectState: "none" },
  { state: "failed", leaseActive: true, resourcesReleased: true, effectState: "none" },
  { state: "failed", leaseActive: false, resourcesReleased: false, effectState: "none" },
  { state: "failed", leaseActive: false, resourcesReleased: true, effectState: "uncertain" }
];
for (const update of unsettledCases) {
  const blocked = { ...retryBase, attempts: retryBase.attempts.map(attempt => ({ ...attempt, ...update })) };
  error(() => createAttempt(blocked, envelope(blocked), { ...initialInput("new"), mode: "retry", reasonReceiptId: "reason" }), "attempt-unsettled");
}

let stagedModel = executing();
const sourceVersions = { run: stagedModel.run.version, node: stagedModel.node.version, attempt: current(stagedModel).version };
const staged = { manifestId: "staged-1", sourceAttemptId: "attempt-1", sourceVersions, leaseFence: 7, state: "staged" };
stagedModel = stageCheckpoint(stagedModel, staged);
error(() => stageCheckpoint(stagedModel, staged), "manifest-id-conflict");
error(() => recoverStagedCheckpoint(stagedModel, envelope(stagedModel, "missing", true), "missing", "abandon"), "staged-checkpoint-missing");
const wrongSource = { ...stagedModel, stagedCheckpoints: [{ ...staged, sourceAttemptId: "other" }] };
error(() => recoverStagedCheckpoint(wrongSource, envelope(wrongSource, "source", true), "staged-1", "abandon"), "staged-checkpoint-source");
error(() => recoverStagedCheckpoint(stagedModel, envelope(stagedModel, "cursor", true), "staged-1", "complete"), "usage-cursor-required");
result = recoverStagedCheckpoint(stagedModel, envelope(stagedModel, "recover", true), "staged-1", "complete", "usage");
assert.strictEqual(result.model.node.state, "checkpointed");

let abandonModel = executing();
const abandonVersions = { run: abandonModel.run.version, node: abandonModel.node.version, attempt: current(abandonModel).version };
abandonModel = stageCheckpoint(abandonModel, { manifestId: "abandon", sourceAttemptId: "attempt-1", sourceVersions: abandonVersions, leaseFence: 7, state: "staged" });
abandonModel = stageCheckpoint(abandonModel, { manifestId: "unrelated", sourceAttemptId: "attempt-1", sourceVersions: abandonVersions, leaseFence: 7, state: "staged" });
result = recoverStagedCheckpoint(abandonModel, envelope(abandonModel, "abandon", true), "abandon", "abandon");
assert.strictEqual(result.model.stagedCheckpoints[0].state, "abandoned");
assert.strictEqual(result.model.stagedCheckpoints[1].state, "staged");
error(() => recoverStagedCheckpoint(result.model, envelope(result.model, "again", true), "abandon", "abandon"), "staged-checkpoint-missing");
const inactiveAbandon = { ...abandonModel, attempts: abandonModel.attempts.map(attempt => ({ ...attempt, leaseActive: false })) };
error(() => recoverStagedCheckpoint(inactiveAbandon, envelope(inactiveAbandon, "inactive", true), "abandon", "abandon"), "abandon-authority");
const staleAbandon = { ...abandonModel, stagedCheckpoints: [{ ...abandonModel.stagedCheckpoints[0], leaseFence: 6 }] };
error(() => recoverStagedCheckpoint(staleAbandon, envelope(staleAbandon, "stale-abandon", true), "abandon", "abandon"), "abandon-authority");

let reconcileModel = executing();
const reconcileVersions = { run: reconcileModel.run.version, node: reconcileModel.node.version, attempt: current(reconcileModel).version };
reconcileModel = stageCheckpoint(reconcileModel, { manifestId: "reconcile", sourceAttemptId: "attempt-1", sourceVersions: reconcileVersions, leaseFence: 7, state: "staged" });
result = recoverStagedCheckpoint(reconcileModel, envelope(reconcileModel, "reconcile", true), "reconcile", "reconcile");
reconcileModel = result.model;
assert.strictEqual(current(reconcileModel).state, "reconciling");
assert.strictEqual(current(reconcileModel).effectState, "uncertain");
assert.strictEqual(current(reconcileModel).leaseFence, 8);
error(() => transitionRun({ ...reconcileModel, run: { ...reconcileModel.run, state: "running" } }, envelope({ ...reconcileModel, run: { ...reconcileModel.run, state: "running" } }), "failed"), "effect-unresolved");
error(() => transitionNode(reconcileModel, envelope(reconcileModel), "failed"), "effect-unresolved");
error(() => transitionAttempt(reconcileModel, envelope(reconcileModel, "ordinary", true), "failed", 8), "effect-unresolved");
error(() => closeIndeterminate(reconcileModel, envelope(reconcileModel, "untrusted", true), false, "scope"), "trusted-close-required");
error(() => closeIndeterminate(reconcileModel, envelope(reconcileModel, "blank-scope", true), true, " "), "trusted-close-required");
const notReconciling = { ...reconcileModel, attempts: reconcileModel.attempts.map(attempt => ({ ...attempt, state: "executing" })) };
error(() => closeIndeterminate(notReconciling, envelope(notReconciling, "not-applicable", true), true, "scope"), "indeterminate-not-applicable");
result = closeIndeterminate(reconcileModel, envelope(reconcileModel, "trusted", true), true, "payments/order-1");
assert.strictEqual(result.model.run.state, "closed-indeterminate");
assert.strictEqual(result.model.node.currentAttemptId, undefined);
assert.strictEqual(result.model.attempts[0].state, "indeterminate");
assert.strictEqual(result.model.attempts[0].resourcesReleased, true);
assert.strictEqual(result.model.attempts[0].residualRiskScope, "payments/order-1");

const noCurrent = createRuntimeModel("r", "n", 2, 1);
error(() => transitionAttempt(noCurrent, { ...envelope(noCurrent), expected: { run: 1, node: 1, attempt: 1 } }, "admitted", 1), "attempt-current-missing");
const staleStaged = executing();
const staleVersionModel = stageCheckpoint(staleStaged, {
  manifestId: "stale-version", sourceAttemptId: "attempt-1",
  sourceVersions: { run: staleStaged.run.version - 1, node: staleStaged.node.version, attempt: current(staleStaged).version },
  leaseFence: 7, state: "staged"
});
error(() => recoverStagedCheckpoint(staleVersionModel, envelope(staleVersionModel, "stale-version", true), "stale-version", "complete", "cursor"), "version-conflict");

console.log("workflow runtime model test: lifecycle, CAS, fencing, recovery, outcomes, and deadlines OK");