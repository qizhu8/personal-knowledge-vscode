#!/usr/bin/env node
const assert = require("assert");
const control = require("../dist/workflows/control-model.js");

const {
  WorkflowControlError, beginLoopIteration, bindSubflow, compareNfc, controlFingerprint,
  createGateChallenge, createLoop, createSubflowState, decimal, decideBranch, decideGate,
  evaluateExpression, int64, mapSubflowResult, recordLoopOutput, resolveCheck, resolveJoin,
  resolveMerge
} = control;

const A = "a".repeat(64);
const B = "b".repeat(64);
const error = (action, code) => assert.throws(action, value => value instanceof WorkflowControlError && value.code === code);
const literal = value => ({ kind: "literal", value });
const source = name => ({ kind: "source", name });
const binary = (kind, left, right) => ({ kind, left, right });
const compare = (operator, left, right) => ({ kind: "compare", operator, left, right });
const arithmetic = (operator, left, right) => ({ kind: "arithmetic", operator, left, right });
let commandId = 0;
const command = (state, overrides = {}) => ({
  commandId: `command-${++commandId}`, fingerprint: "fingerprint", expectedVersion: state.version, ...overrides
});

// Closed deterministic expression language: NFC strings, typed exact comparisons, and checked arithmetic.
assert.strictEqual(controlFingerprint({ b: 2, a: 1 }), controlFingerprint({ a: 1, b: 2 }));
assert.strictEqual(compareNfc("e\u0301", "é"), 0);
assert.strictEqual(compareNfc("a", "b"), -1);
assert.strictEqual(compareNfc("b", "a"), 1);
assert.strictEqual(compareNfc("a", "aa"), -1);
assert.strictEqual(compareNfc("aa", "a"), 1);
assert.deepStrictEqual(int64("0"), { type: "int64", value: "0" });
assert.deepStrictEqual(int64("-7"), { type: "int64", value: "-7" });
assert.deepStrictEqual(int64("9223372036854775807"), { type: "int64", value: "9223372036854775807" });
assert.deepStrictEqual(int64("-9223372036854775808"), { type: "int64", value: "-9223372036854775808" });
for (const value of ["01", "-0", "9223372036854775808", "-9223372036854775809"]) error(() => int64(value), "int64");
assert.deepStrictEqual(decimal("1.2300"), { type: "decimal", value: "1.23" });
assert.deepStrictEqual(decimal("-0.00"), { type: "decimal", value: "0" });
assert.deepStrictEqual(decimal("-2"), { type: "decimal", value: "-2" });
error(() => decimal("01.2"), "decimal");

const sources = {
  payload: { name: "e\u0301", values: [int64("4"), int64("8")] },
  yes: true,
  no: false
};
assert.strictEqual(evaluateExpression(literal(null), sources), null);
assert.strictEqual(evaluateExpression(literal(true), sources), true);
assert.strictEqual(evaluateExpression(literal("e\u0301"), sources), "é");
assert.deepStrictEqual(evaluateExpression(literal(["e\u0301", decimal("1.00")]), sources), ["é", decimal("1")]);
assert.deepStrictEqual(evaluateExpression(literal({ z: "last", a: "first" }), sources), { a: "first", z: "last" });
assert(Object.isFrozen(evaluateExpression(literal({ nested: ["value"] }), sources).nested));
error(() => evaluateExpression(literal({ "é": "one", "e\u0301": "two" }), sources), "expression-object-key");
assert.strictEqual(evaluateExpression(source("yes"), sources), true);
error(() => evaluateExpression(source("missing"), sources), "expression-source");
const field = { kind: "field", target: source("payload"), name: "name" };
assert.strictEqual(evaluateExpression(field, sources), "é");
error(() => evaluateExpression({ ...field, name: "missing" }, sources), "expression-field");
error(() => evaluateExpression({ ...field, target: source("yes") }, sources), "expression-field");
const index = value => ({ kind: "index", target: { kind: "field", target: source("payload"), name: "values" }, index: literal(value) });
assert.deepStrictEqual(evaluateExpression(index(int64("1")), sources), int64("8"));
error(() => evaluateExpression({ kind: "index", target: source("yes"), index: literal(int64("0")) }, sources), "expression-index");
error(() => evaluateExpression({ kind: "index", target: literal([]), index: literal("0") }, sources), "expression-index");
error(() => evaluateExpression(index(int64("-1")), sources), "expression-index-range");
error(() => evaluateExpression(index(int64("2")), sources), "expression-index-range");

assert.strictEqual(evaluateExpression(binary("and", source("no"), source("missing")), sources), false);
assert.strictEqual(evaluateExpression(binary("and", source("yes"), source("yes")), sources), true);
assert.strictEqual(evaluateExpression(binary("or", source("yes"), source("missing")), sources), true);
assert.strictEqual(evaluateExpression(binary("or", source("no"), source("yes")), sources), true);
assert.strictEqual(evaluateExpression({ kind: "not", operand: source("no") }, sources), true);
error(() => evaluateExpression({ kind: "not", operand: literal("no") }, sources), "expression-boolean");

for (const [operator, expected] of [["eq", true], ["ne", false], ["lt", false], ["lte", true], ["gt", false], ["gte", true]]) {
  assert.strictEqual(evaluateExpression(compare(operator, literal("e\u0301"), literal("é")), sources), expected);
}
assert.strictEqual(evaluateExpression(compare("lt", literal(null), literal(null)), sources), false);
assert.strictEqual(evaluateExpression(compare("lt", literal(false), literal(true)), sources), true);
assert.strictEqual(evaluateExpression(compare("gt", literal(true), literal(false)), sources), true);
assert.strictEqual(evaluateExpression(compare("eq", literal(true), literal(true)), sources), true);
assert.strictEqual(evaluateExpression(compare("lt", literal(int64("1")), literal(int64("2"))), sources), true);
assert.strictEqual(evaluateExpression(compare("gt", literal(int64("2")), literal(int64("1"))), sources), true);
assert.strictEqual(evaluateExpression(compare("eq", literal(int64("2")), literal(int64("2"))), sources), true);
assert.strictEqual(evaluateExpression(compare("lt", literal(decimal("1.2")), literal(decimal("1.3"))), sources), true);
assert.strictEqual(evaluateExpression(compare("gt", literal(decimal("1.3")), literal(decimal("1.2"))), sources), true);
assert.strictEqual(evaluateExpression(compare("eq", literal(decimal("1.20")), literal(decimal("1.2"))), sources), true);
error(() => evaluateExpression(compare("eq", literal("1"), literal(int64("1"))), sources), "comparison-type");
error(() => evaluateExpression(compare("eq", literal([]), literal([])), sources), "comparison-value");
error(() => evaluateExpression(compare("eq", literal({}), literal({})), sources), "comparison-value");

assert.deepStrictEqual(evaluateExpression(arithmetic("add", literal(int64("2")), literal(int64("3"))), sources), int64("5"));
assert.deepStrictEqual(evaluateExpression(arithmetic("sub", literal(int64("2")), literal(int64("3"))), sources), int64("-1"));
assert.deepStrictEqual(evaluateExpression(arithmetic("mul", literal(int64("-2")), literal(int64("3"))), sources), int64("-6"));
error(() => evaluateExpression(arithmetic("add", literal(int64("9223372036854775807")), literal(int64("1"))), sources), "arithmetic-overflow");
error(() => evaluateExpression(arithmetic("sub", literal(int64("-9223372036854775808")), literal(int64("1"))), sources), "arithmetic-overflow");
assert.deepStrictEqual(evaluateExpression(arithmetic("add", literal(decimal("1.2")), literal(decimal("0.03"))), sources), decimal("1.23"));
assert.deepStrictEqual(evaluateExpression(arithmetic("add", literal(decimal("1")), literal(decimal("2"))), sources), decimal("3"));
assert.deepStrictEqual(evaluateExpression(arithmetic("sub", literal(decimal("1.2")), literal(decimal("2.3"))), sources), decimal("-1.1"));
assert.deepStrictEqual(evaluateExpression(arithmetic("mul", literal(decimal("-1.5")), literal(decimal("2"))), sources), decimal("-3"));
error(() => evaluateExpression(arithmetic("add", literal(int64("1")), literal(decimal("1"))), sources), "arithmetic-type");
error(() => evaluateExpression(literal(Symbol("unsupported")), sources), "expression-value");

// Checks distinguish a valid failed verdict from transport failure.
assert.deepStrictEqual(resolveCheck({ kind: "verdict", passed: true, evidenceCitations: ["e1"] }, "require-passed"), {
  status: "passed", nodeResult: "succeeded", signal: false, evidenceCitations: ["e1"]
});
assert.deepStrictEqual(resolveCheck({ kind: "verdict", passed: false, evidenceCitations: ["e2"] }, "signal"), {
  status: "failed-verdict", nodeResult: "succeeded", signal: true, evidenceCitations: ["e2"]
});
assert.deepStrictEqual(resolveCheck({ kind: "verdict", passed: false, evidenceCitations: [] }, "require-passed"), {
  status: "failed-verdict", nodeResult: "failed", signal: false, evidenceCitations: []
});
assert.deepStrictEqual(resolveCheck({ kind: "adapter-failure", failureCode: "offline" }, "signal"), {
  status: "adapter-failure", nodeResult: "indeterminate", signal: false, evidenceCitations: [], failureCode: "offline"
});

// Gate responses are exact, authorized, expiring, one-use CAS operations.
const tuple = { runId: "run", runVersion: 1, nodeId: "node", nodeVersion: 2, attemptId: "attempt", attemptVersion: 3, definitionVersionId: "version" };
const evidence = [{ evidenceId: "ev-b", digest: B }, { evidenceId: "ev-a", digest: A }];
const challengeInput = (overrides = {}) => ({
  challengeId: "challenge", tuple, authorizedActors: ["zoe", "amy"], authorizationSnapshotId: "auth-1",
  evidence, expiresAt: 100, ...overrides
});
for (const input of [
  challengeInput({ challengeId: " " }), challengeInput({ authorizationSnapshotId: " " }),
  challengeInput({ tuple: { ...tuple, runId: "" } }), challengeInput({ tuple: { ...tuple, runVersion: 0 } }),
  challengeInput({ tuple: { ...tuple, nodeVersion: 1.2 } })
]) error(() => createGateChallenge(input), input.tuple !== tuple ? "gate-tuple" : input.challengeId.trim() ? "gate-authorization-snapshot" : "gate-challenge");
error(() => createGateChallenge(challengeInput({ expiresAt: Infinity })), "gate-expiry");
error(() => createGateChallenge(challengeInput({ authorizedActors: [] })), "gate-actor");
error(() => createGateChallenge(challengeInput({ authorizedActors: ["é", "e\u0301"] })), "gate-actor");
error(() => createGateChallenge(challengeInput({ evidence: [{ evidenceId: "", digest: A }] })), "gate-evidence");
error(() => createGateChallenge(challengeInput({ evidence: [{ evidenceId: "e", digest: "bad" }] })), "gate-evidence");
error(() => createGateChallenge(challengeInput({ evidence: [{ evidenceId: "e", digest: A }, { evidenceId: "e", digest: B }] })), "gate-evidence");
let challenge = createGateChallenge(challengeInput());
assert.deepStrictEqual(challenge.authorizedActors, ["amy", "zoe"]);
assert.deepStrictEqual(challenge.evidence.map(item => item.evidenceId), ["ev-a", "ev-b"]);
assert(Object.isFrozen(challenge.tuple));
const gateResponse = (overrides = {}) => ({ actorId: "amy", verdict: "approved", tuple, evidence, observedAt: 100, ...overrides });
error(() => decideGate(challenge, command(challenge, { expectedVersion: 0 }), gateResponse()), "command-stale");
error(() => decideGate(challenge, command(challenge), gateResponse({ observedAt: NaN })), "gate-observation");
error(() => decideGate(challenge, command(challenge), gateResponse({ observedAt: 101 })), "gate-expired");
error(() => decideGate(challenge, command(challenge), gateResponse({ actorId: "mallory" })), "gate-unauthorized");
error(() => decideGate(challenge, command(challenge), gateResponse({ tuple: { ...tuple, attemptVersion: 4 } })), "gate-stale");
error(() => decideGate(challenge, command(challenge), gateResponse({ evidence: [evidence[0]] })), "gate-evidence-stale");
const gateCommand = command(challenge);
const gateDecision = decideGate(challenge, gateCommand, gateResponse());
challenge = gateDecision.challenge;
assert.strictEqual(challenge.decision.verdict, "approved");
assert.strictEqual(gateDecision.replayed, false);
const gateReplay = decideGate(challenge, { ...gateCommand, expectedVersion: 0 }, gateResponse());
assert.strictEqual(gateReplay.replayed, true);
assert.strictEqual(gateReplay.challenge, challenge);
error(() => decideGate(challenge, { ...gateCommand, fingerprint: "other" }, gateResponse()), "command-conflict");
error(() => decideGate(challenge, command(challenge), gateResponse({ verdict: "rejected" })), "gate-consumed");

// Branch selection is priority ordered and immutable; merge consumes not-selected only for exclusive decisions.
const paths = [
  { id: "z", priority: 2, when: source("yes") },
  { id: "b", priority: 1, when: source("yes") },
  { id: "a", priority: 1, when: source("yes") }
];
const branchCommand = { commandId: "branch-1", fingerprint: "branch-fingerprint" };
const exclusive = decideBranch("exclusive", paths, "default", sources, branchCommand);
assert.deepStrictEqual(exclusive.selected, ["a"]);
assert.deepStrictEqual(exclusive.notSelected, ["b", "default", "z"]);
assert(Object.isFrozen(exclusive));
assert.deepStrictEqual(decideBranch("multi", paths, undefined, sources, branchCommand).selected, ["a", "b", "z"]);
assert.deepStrictEqual(decideBranch("multi", [{ id: "no", priority: 0, when: source("no") }], undefined, sources, branchCommand).selected, []);
const defaulted = decideBranch("exclusive", [{ id: "no", priority: 0, when: source("no") }], "fallback", sources, branchCommand);
assert.deepStrictEqual(defaulted.selected, ["fallback"]);
assert.strictEqual(defaulted.defaultSelected, true);
error(() => decideBranch("exclusive", paths, undefined, sources, { ...branchCommand, commandId: " " }), "command");
error(() => decideBranch("exclusive", paths, undefined, sources, { ...branchCommand, fingerprint: " " }), "command");
error(() => decideBranch("exclusive", [{ id: "é", priority: 0, when: source("yes") }, { id: "e\u0301", priority: 1, when: source("yes") }], undefined, sources, branchCommand), "branch-path");
error(() => decideBranch("exclusive", [{ id: "a", priority: 1.5, when: source("yes") }], undefined, sources, branchCommand), "branch-priority");
error(() => decideBranch("exclusive", [{ id: "a", priority: 1, when: source("yes") }], "a", sources, branchCommand), "branch-default");
assert.deepStrictEqual(resolveMerge("exclusive", [
  { pathId: "a", state: "completed" }, { pathId: "b", state: "not-selected" }
]), { ready: true, consumed: ["a", "b"], failed: [] });
assert.deepStrictEqual(resolveMerge("exclusive", [
  { pathId: "a", state: "failed" }, { pathId: "b", state: "not-selected" }
]), { ready: false, consumed: ["a", "b"], failed: ["a"] });
assert.deepStrictEqual(resolveMerge("exclusive", [{ pathId: "a", state: "not-selected" }]), { ready: false, consumed: ["a"], failed: [] });
assert.deepStrictEqual(resolveMerge("multi", [{ pathId: "b", state: "completed" }, { pathId: "a", state: "completed" }]), { ready: true, consumed: ["a", "b"], failed: [] });
error(() => resolveMerge("multi", [{ pathId: "a", state: "not-selected" }]), "merge-not-selected");

// Joins use durable transaction sequence, then NFC candidate ID, and state explicit loser actions.
const candidate = (id, state, transactionSequence) => ({ id, state, ...(transactionSequence === undefined ? {} : { transactionSequence }) });
error(() => resolveJoin("all", []), "join-candidates");
error(() => resolveJoin("all", [candidate("a", "pending"), candidate("a", "pending")]), "join-candidate");
error(() => resolveJoin("quorum", [candidate("a", "pending")], 0), "join-quorum");
error(() => resolveJoin("quorum", [candidate("a", "pending")], 2), "join-quorum");
error(() => resolveJoin("all", [candidate("a", "succeeded")]), "join-sequence");
error(() => resolveJoin("all", [candidate("a", "succeeded", 1.5)]), "join-sequence");
error(() => resolveJoin("all", [candidate("a", "failed", 0)]), "join-sequence");
assert.strictEqual(resolveJoin("all", [candidate("a", "pending")]).state, "pending");
assert.strictEqual(resolveJoin("all", [candidate("a", "failed", 1), candidate("b", "pending")]).state, "failed");
assert.deepStrictEqual(resolveJoin("all", [candidate("b", "succeeded", 2), candidate("a", "succeeded", 1)]).winners, ["a", "b"]);
assert.deepStrictEqual(resolveJoin("any", [candidate("z", "failed", 1), candidate("a", "succeeded", 1), candidate("p", "pending")]), {
  state: "succeeded", winners: ["a"], loserActions: [{ candidateId: "p", action: "cancel" }, { candidateId: "z", action: "ignore" }]
});
assert.strictEqual(resolveJoin("any", [candidate("a", "pending")]).state, "pending");
assert.strictEqual(resolveJoin("race", [candidate("a", "failed", 1), candidate("b", "succeeded", 2)]).state, "failed");
assert.strictEqual(resolveJoin("race", [candidate("a", "pending")]).state, "pending");
assert.deepStrictEqual(resolveJoin("first-success", [candidate("f", "failed", 1), candidate("s", "succeeded", 2), candidate("p", "pending")]).winners, ["s"]);
assert.strictEqual(resolveJoin("first-success", [candidate("a", "failed", 1), candidate("b", "failed", 2)]).state, "failed");
assert.strictEqual(resolveJoin("first-success", [candidate("a", "failed", 1), candidate("b", "pending")]).state, "pending");
assert.deepStrictEqual(resolveJoin("quorum", [candidate("b", "succeeded", 2), candidate("a", "succeeded", 1), candidate("p", "pending")], 2).winners, ["a", "b"]);
assert.strictEqual(resolveJoin("quorum", [candidate("a", "failed", 1), candidate("b", "failed", 2), candidate("p", "pending")], 2).state, "failed");
assert.strictEqual(resolveJoin("quorum", [candidate("a", "succeeded", 1), candidate("p", "pending"), candidate("q", "pending")], 2).state, "pending");

// Loop allocation/output changes are transactional; outputs remain index ordered and deeply immutable.
error(() => createLoop(-1, "fail"), "loop-bound");
error(() => createLoop(1.5, "fail"), "loop-bound");
let loop = createLoop(2, "fail");
error(() => beginLoopIteration(loop, command(loop, { expectedVersion: 0 })), "command-stale");
const beginZeroCommand = command(loop);
let mutation = beginLoopIteration(loop, beginZeroCommand);
loop = mutation.loop;
assert.strictEqual(mutation.index, 0);
assert.strictEqual(mutation.replayed, false);
assert.strictEqual(beginLoopIteration(loop, { ...beginZeroCommand, expectedVersion: 0 }).index, 0);
error(() => beginLoopIteration(loop, { ...beginZeroCommand, fingerprint: "other" }), "command-conflict");
error(() => recordLoopOutput(loop, command(loop), -1, "bad"), "loop-index");
error(() => recordLoopOutput(loop, command(loop), 1, "bad"), "loop-index");
const outputZeroCommand = command(loop);
mutation = recordLoopOutput(loop, outputZeroCommand, 0, { text: "e\u0301" });
loop = mutation.loop;
assert.strictEqual(mutation.replayed, false);
assert.strictEqual(recordLoopOutput(loop, { ...outputZeroCommand, expectedVersion: 0 }, 0, "ignored").replayed, true);
error(() => recordLoopOutput(loop, command(loop), 0, "duplicate"), "loop-output-duplicate");
mutation = beginLoopIteration(loop, command(loop));
loop = mutation.loop;
assert.strictEqual(mutation.index, 1);
mutation = recordLoopOutput(loop, command(loop), 1, ["later"]);
loop = mutation.loop;
assert.deepStrictEqual(loop.outputs.map(output => output.index), [0, 1]);
assert.strictEqual(loop.outputs[0].value.text, "é");
assert(Object.isFrozen(loop.outputs[1].value));
mutation = beginLoopIteration(loop, command(loop));
loop = mutation.loop;
assert.strictEqual(loop.limited, true);
assert.strictEqual(loop.limitResult, "failed");
assert.strictEqual(mutation.index, undefined);
assert.strictEqual(beginLoopIteration(loop, { ...mutation.receipt, expectedVersion: 0 }).replayed, true);
error(() => beginLoopIteration(loop, command(loop)), "loop-closed");
const completeLimit = beginLoopIteration(createLoop(0, "complete"), command(createLoop(0, "complete")));
assert.strictEqual(completeLimit.loop.limitResult, "completed");

// Subflow binding is exact and idempotent; all child terminal classes map exhaustively.
let subflow = createSubflowState();
const lock = { definitionId: "definition", versionId: "version", bundleDigest: A };
error(() => bindSubflow(subflow, command(subflow, { expectedVersion: 0 }), "child", lock), "command-stale");
error(() => bindSubflow(subflow, command(subflow), " ", lock), "subflow-child");
error(() => bindSubflow(subflow, command(subflow), "child", { ...lock, definitionId: " " }), "subflow-definition");
error(() => bindSubflow(subflow, command(subflow), "child", { ...lock, versionId: " " }), "subflow-version");
error(() => bindSubflow(subflow, command(subflow), "child", { ...lock, bundleDigest: "bad" }), "subflow-lock");
const bindCommand = command(subflow);
let binding = bindSubflow(subflow, bindCommand, "child", lock);
subflow = binding.subflow;
assert.strictEqual(binding.replayed, false);
assert(Object.isFrozen(subflow.binding.lock));
assert.strictEqual(bindSubflow(subflow, { ...bindCommand, expectedVersion: 0 }, "ignored", lock).replayed, true);
error(() => bindSubflow(subflow, { ...bindCommand, fingerprint: "other" }, "child", lock), "command-conflict");
error(() => bindSubflow(subflow, command(subflow), "other", lock), "subflow-bound");
for (const result of ["succeeded", "failed", "cancelled", "indeterminate"]) assert.strictEqual(mapSubflowResult(result), result);
assert.notStrictEqual(mapSubflowResult("indeterminate"), "succeeded");

console.log("workflow control model test: deterministic expressions, checks, gates, branches, joins, loops, and subflows OK");
