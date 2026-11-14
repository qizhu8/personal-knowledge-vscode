#!/usr/bin/env node
const assert = require("assert");
const executor = require("../dist/workflows/executor-model.js");

const {
  WorkflowExecutorError, acknowledgeExecution, cancelExecution, checkpointExecution,
  completeExecution, coreVisibleResult, createAdapterRegistry, createExecutorProtocol,
  createInvocationEnvelope, digestExecutorValue, dispatchExecution, proveTransportConformance,
  recordExecutionEvidence, resolveAdapterProfile, startExecution
} = executor;

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const error = (action, code) => assert.throws(action, value => value instanceof WorkflowExecutorError && value.code === code);
const profile = (transport, overrides = {}) => ({
  profileId: `profile-${transport}`,
  transport,
  capabilities: ["execute", "checkpoint", "execute"],
  capabilityProfileDigest: A,
  attestationDigest: B,
  conformanceFixtureDigest: C,
  revoked: false,
  ...overrides
});
const envelopeInput = (overrides = {}) => ({
  schema: "pkm.workflow.executor-invocation/v1",
  run: { id: "run-1", version: 2 },
  node: { id: "node-1", version: 3 },
  attempt: { id: "attempt-1", version: 4 },
  assignment: { id: "assignment-1", version: 5 },
  lease: { id: "lease-1", version: 6, fence: 7 },
  definition: {
    versionId: "version-1", executableDigest: A, dependencyLockDigest: B,
    nodeKind: "pkm.step.command/v1", nodeKindValidatorDigest: C
  },
  requiredInputDigest: A,
  context: { projectId: "project-1", environmentId: "environment-1", configurationSnapshotId: "config-1" },
  environment: {
    locale: "en-US", workingDirectory: "/workspace",
    resourceCeiling: { cpuMillis: 1000, memoryBytes: 2048, outputBytes: 4096 }
  },
  secretHandles: [{ name: "token", handle: "secret://token", versionId: "secret-v1" }],
  deadlines: { executionAt: 100, evidenceAt: 120 },
  evidencePolicy: { policyId: "evidence-standard", policyDigest: B },
  effectIdempotencyKey: "effect-run-1-node-1-attempt-1",
  ...overrides
});
const envelopeWith = (path, value) => {
  const input = envelopeInput();
  input[path] = value;
  return input;
};
const receipt = (overrides = {}) => ({
  receiptId: "receipt-1", digest: A, mediaType: "application/json", byteLength: 10,
  truncated: false, ...overrides
});
let commandNumber = 0;
const command = (protocol, overrides = {}) => ({
  commandId: `command-${++commandNumber}`, fingerprint: "canonical",
  expectedVersion: protocol.version, expectedFence: protocol.leaseFence, ...overrides
});
const apply = result => result.protocol;

assert.strictEqual(digestExecutorValue({ b: 2, a: 1 }), digestExecutorValue({ a: 1, b: 2 }));

error(() => createAdapterRegistry([profile("inline", { profileId: " " })]), "adapter-profile-invalid");
error(() => createAdapterRegistry([profile("inline", { conformanceFixtureDigest: "bad" })]), "adapter-conformance-invalid");
error(() => createAdapterRegistry([profile("inline", { capabilities: ["execute", " "] })]), "adapter-capability-invalid");
error(() => createAdapterRegistry([profile("inline"), profile("inline", { profileId: "other" })]), "adapter-profile-duplicate");
const registry = createAdapterRegistry([
  profile("inline"), profile("local-isolated"), profile("remote")
]);
assert.deepStrictEqual(registry.profiles[0].capabilities, ["checkpoint", "execute"]);
assert(Object.isFrozen(registry));
assert(Object.isFrozen(registry.profiles));
error(() => resolveAdapterProfile(createAdapterRegistry([]), "inline", [], C), "adapter-profile-unsupported");
error(() => resolveAdapterProfile(createAdapterRegistry([profile("inline", { attestationDigest: "" })]), "inline", [], C), "adapter-profile-unattested");
error(() => resolveAdapterProfile(createAdapterRegistry([profile("inline", { attestationDigest: "bad" })]), "inline", [], C), "adapter-profile-unattested");
error(() => resolveAdapterProfile(createAdapterRegistry([profile("inline", { capabilityProfileDigest: "bad" })]), "inline", [], C), "adapter-profile-unattested");
error(() => resolveAdapterProfile(createAdapterRegistry([profile("inline", { revoked: true })]), "inline", [], C), "adapter-profile-revoked");
error(() => resolveAdapterProfile(registry, "inline", [], B), "adapter-conformance-mismatch");
error(() => resolveAdapterProfile(registry, "inline", ["network"], C), "adapter-capability-missing");
assert.strictEqual(resolveAdapterProfile(registry, "inline", ["execute"], C).profileId, "profile-inline");

error(() => createInvocationEnvelope(envelopeInput({ schema: "bad" })), "invocation-schema-invalid");
for (const key of ["run", "node", "attempt", "assignment"]) {
  error(() => createInvocationEnvelope(envelopeWith(key, { id: "", version: 1 })), "invocation-binding-invalid");
  error(() => createInvocationEnvelope(envelopeWith(key, { id: "x", version: 0 })), "invocation-binding-invalid");
}
error(() => createInvocationEnvelope(envelopeWith("lease", { id: "", version: 6, fence: 7 })), "invocation-binding-invalid");
error(() => createInvocationEnvelope(envelopeWith("lease", { id: "lease", version: 0, fence: 7 })), "invocation-binding-invalid");
error(() => createInvocationEnvelope(envelopeWith("lease", { id: "lease", version: 1, fence: 0 })), "lease-fence-invalid");
error(() => createInvocationEnvelope(envelopeWith("lease", { id: "lease", version: 1, fence: 1.5 })), "lease-fence-invalid");
for (const digestField of ["executableDigest", "dependencyLockDigest", "nodeKindValidatorDigest"]) {
  const input = envelopeInput(); input.definition[digestField] = "bad";
  error(() => createInvocationEnvelope(input), "invocation-digest-invalid");
}
error(() => createInvocationEnvelope(envelopeInput({ requiredInputDigest: "bad" })), "invocation-digest-invalid");
error(() => createInvocationEnvelope(envelopeInput({ evidencePolicy: { policyId: "p", policyDigest: "bad" } })), "invocation-digest-invalid");
const requiredTextCases = [
  ["definition", { ...envelopeInput().definition, versionId: " " }],
  ["definition", { ...envelopeInput().definition, nodeKind: " " }],
  ["context", { ...envelopeInput().context, projectId: " " }],
  ["context", { ...envelopeInput().context, environmentId: " " }],
  ["context", { ...envelopeInput().context, configurationSnapshotId: " " }],
  ["environment", { ...envelopeInput().environment, locale: " " }],
  ["environment", { ...envelopeInput().environment, workingDirectory: " " }],
  ["evidencePolicy", { ...envelopeInput().evidencePolicy, policyId: " " }],
  ["effectIdempotencyKey", " "]
];
for (const [key, value] of requiredTextCases) error(() => createInvocationEnvelope(envelopeInput({ [key]: value })), "invocation-field-required");
for (const resource of ["cpuMillis", "memoryBytes", "outputBytes"]) {
  const ceiling = { ...envelopeInput().environment.resourceCeiling, [resource]: 0 };
  error(() => createInvocationEnvelope(envelopeInput({ environment: { ...envelopeInput().environment, resourceCeiling: ceiling } })), "resource-ceiling-invalid");
  const fractional = { ...envelopeInput().environment.resourceCeiling, [resource]: 1.5 };
  error(() => createInvocationEnvelope(envelopeInput({ environment: { ...envelopeInput().environment, resourceCeiling: fractional } })), "resource-ceiling-invalid");
}
for (const deadlines of [
  { executionAt: Infinity, evidenceAt: 120 }, { executionAt: 100, evidenceAt: Infinity },
  { executionAt: 0, evidenceAt: 120 }, { executionAt: 100, evidenceAt: 99 }
]) error(() => createInvocationEnvelope(envelopeInput({ deadlines })), "deadline-invalid");
error(() => createInvocationEnvelope(envelopeInput({ secretHandles: [{ name: "token", handle: "h", versionId: "v", bytes: "SECRET" }] })), "secret-material-forbidden");
for (const secret of [
  { name: " ", handle: "h", versionId: "v" }, { name: "n", handle: " ", versionId: "v" }, { name: "n", handle: "h", versionId: " " }
]) error(() => createInvocationEnvelope(envelopeInput({ secretHandles: [secret] })), "secret-handle-invalid");

const invocation = createInvocationEnvelope(envelopeInput());
assert(Object.isFrozen(invocation));
assert(Object.isFrozen(invocation.environment.resourceCeiling));
assert(!JSON.stringify(invocation).includes("SECRET"));
assert.deepStrictEqual(invocation.secretHandles, [{ name: "token", handle: "secret://token", versionId: "secret-v1" }]);

const inline = resolveAdapterProfile(registry, "inline", ["execute"], C);
error(() => createExecutorProtocol(invocation, { ...inline, revoked: true }), "adapter-profile-revoked");
let protocol = createExecutorProtocol(invocation, inline);
assert.strictEqual(protocol.phase, "created");
assert.strictEqual(protocol.leaseFence, 7);
assert.strictEqual(protocol.invocationDigest, digestExecutorValue(invocation));

error(() => acknowledgeExecution(protocol, command(protocol)), "protocol-state");
const staleVersion = command(protocol, { expectedVersion: 0 });
error(() => dispatchExecution(protocol, staleVersion), "protocol-version-conflict");
const staleFence = command(protocol, { expectedFence: 8 });
error(() => dispatchExecution(protocol, staleFence), "lease-fenced");
let result = dispatchExecution(protocol, command(protocol));
protocol = result.protocol;
assert.strictEqual(result.replayed, false);
assert.strictEqual(result.receipt.operation, "dispatch");
assert.strictEqual(result.receipt.protocolVersion, 2);
assert.strictEqual(result.receipt.leaseFence, 7);
const replay = dispatchExecution(protocol, {
  commandId: result.receipt.commandId, fingerprint: "canonical", expectedVersion: 0, expectedFence: 0
});
assert.strictEqual(replay.replayed, true);
assert.strictEqual(replay.protocol, protocol);
assert.strictEqual(replay.receipt, result.receipt);
error(() => dispatchExecution(protocol, {
  commandId: result.receipt.commandId, fingerprint: "different", expectedVersion: 0, expectedFence: 0
}), "command-conflict");
protocol = apply(acknowledgeExecution(protocol, command(protocol)));
protocol = apply(startExecution(protocol, command(protocol)));

error(() => recordExecutionEvidence(protocol, command(protocol), receipt({ receiptId: " " })), "receipt-invalid");
error(() => recordExecutionEvidence(protocol, command(protocol), receipt({ mediaType: " " })), "receipt-invalid");
error(() => recordExecutionEvidence(protocol, command(protocol), receipt({ digest: "bad" })), "receipt-invalid");
error(() => recordExecutionEvidence(protocol, command(protocol), receipt({ byteLength: -1 })), "receipt-length-invalid");
error(() => recordExecutionEvidence(protocol, command(protocol), receipt({ byteLength: 1.5 })), "receipt-length-invalid");
error(() => recordExecutionEvidence(protocol, command(protocol), receipt({ truncated: true })), "receipt-truncation-invalid");
error(() => recordExecutionEvidence(protocol, command(protocol), receipt({ truncated: true, originalByteLength: 9 })), "receipt-truncation-invalid");
error(() => recordExecutionEvidence(protocol, command(protocol), receipt({ originalByteLength: 10 })), "receipt-truncation-invalid");
protocol = apply(recordExecutionEvidence(protocol, command(protocol), receipt()));
protocol = apply(recordExecutionEvidence(protocol, command(protocol), receipt({ receiptId: "receipt-2", truncated: true, byteLength: 5, originalByteLength: 10, bytes: "SECRET" })));
assert.strictEqual(protocol.phase, "collecting-evidence");
assert.strictEqual(protocol.evidence.length, 2);
assert(!JSON.stringify(protocol.evidence).includes("SECRET"));
assert(!JSON.stringify(protocol.commandReceipts).includes("secret://"));
protocol = apply(checkpointExecution(protocol, command(protocol), receipt({ receiptId: "checkpoint" })));
assert.strictEqual(protocol.phase, "checkpointed");
assert.strictEqual(protocol.checkpoint.receiptId, "checkpoint");
protocol = apply(completeExecution(protocol, command(protocol), { status: "succeeded", result: receipt(), artifacts: [receipt({ receiptId: "artifact" })] }));
assert.strictEqual(protocol.phase, "completed");
assert.strictEqual(protocol.outcome.state, "succeeded");
error(() => completeExecution(protocol, command(protocol), { status: "succeeded" }), "protocol-state");

const protocolAt = phase => ({ ...createExecutorProtocol(invocation, inline), phase });
for (const phase of ["dispatched", "acknowledged", "started", "collecting-evidence", "checkpointed"]) {
  const cancelled = apply(cancelExecution(protocolAt(phase), command(protocolAt(phase))));
  assert.deepStrictEqual(cancelled.outcome, { state: "cancelled", failureClass: "cancelled", artifacts: [] });
}
error(() => cancelExecution(protocolAt("created"), command(protocolAt("created"))), "protocol-state");

assert.deepStrictEqual(coreVisibleResult({ status: "unknown-effect" }), { state: "reconciling", artifacts: [] });
assert.deepStrictEqual(coreVisibleResult({ status: "succeeded" }), { state: "succeeded", artifacts: [] });
assert.deepStrictEqual(coreVisibleResult({ status: "cancelled", result: receipt() }), { state: "cancelled", failureClass: "cancelled", result: receipt(), artifacts: [] });
for (const [code, failureClass] of [
  ["definition-invalid", "definition-invalid"], ["input-invalid", "input-invalid"],
  ["resource-exhausted", "resource-exhausted"], ["deadline-exceeded", "deadline-exceeded"],
  ["adapter-unavailable", "adapter-unavailable"], ["other", "execution-failed"], [undefined, "execution-failed"]
]) assert.strictEqual(coreVisibleResult({ status: "failed", code }).failureClass, failureClass);
const reconciling = apply(completeExecution(protocolAt("started"), command(protocolAt("started")), { status: "unknown-effect" }));
assert.strictEqual(reconciling.phase, "reconciling");
for (const phase of ["started", "collecting-evidence", "checkpointed"]) {
  const completed = apply(completeExecution(protocolAt(phase), command(protocolAt(phase)), { status: "failed", code: "input-invalid" }));
  assert.strictEqual(completed.phase, "completed");
}
const checkpointFromStart = apply(checkpointExecution(protocolAt("started"), command(protocolAt("started")), receipt()));
assert.strictEqual(checkpointFromStart.phase, "checkpointed");

const adapters = ["inline", "local-isolated", "remote"].map(transport => ({
  profile: profile(transport),
  execute: received => {
    assert.strictEqual(received, invocation);
    return { status: "succeeded", result: receipt(), artifacts: [receipt({ receiptId: "artifact" })] };
  }
}));
error(() => proveTransportConformance(invocation, adapters, "bad"), "conformance-fixture-invalid");
error(() => proveTransportConformance(invocation, adapters.slice(0, 2), C), "adapter-profile-unsupported");
const mismatchedFixture = adapters.map(adapter => adapter.profile.transport === "remote"
  ? { ...adapter, profile: { ...adapter.profile, conformanceFixtureDigest: B } } : adapter);
error(() => proveTransportConformance(invocation, mismatchedFixture, C), "adapter-conformance-mismatch");
const divergent = adapters.map(adapter => adapter.profile.transport === "remote"
  ? { ...adapter, execute: () => ({ status: "failed", code: "input-invalid" }) } : adapter);
error(() => proveTransportConformance(invocation, divergent, C), "transport-conformance-failed");
const proof = proveTransportConformance(invocation, adapters, C);
assert.strictEqual(proof.fixtureDigest, C);
assert.strictEqual(proof.coreResultDigest, digestExecutorValue(proof.results.inline));
assert.deepStrictEqual(Object.keys(proof.results), ["inline", "local-isolated", "remote"]);
assert(Object.isFrozen(proof.results.remote.result));

console.log("workflow executor model test: envelope, profiles, fenced protocol, receipts, outcomes, and transport conformance OK");
