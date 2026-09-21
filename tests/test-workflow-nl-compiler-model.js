#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { createHash } = require("crypto");
const { createBuiltinNodeKindRegistry } = require("../dist/workflows/catalog-model.js");
const {
  NL_COMPILER_REQUEST_SCHEMA,
  NL_PROPOSAL_SCHEMA,
  NL_REVIEW_SCHEMA,
  NaturalLanguageCompilerError,
  answerProposalQuestions,
  authorizePublication,
  completeGenerationAttempt,
  createCompilerTelemetry,
  createGenerationRequestV1,
  createReviewManifestV1,
  emptyNaturalLanguageCompilerState,
  evaluatePrivacyEligibility,
  lowerProposalRevision,
  recordPartialPreview
} = require("../dist/workflows/nl-compiler-model.js");

const digest = value => createHash("sha256").update(value).digest("hex");
const d = digest("bound");
const clone = value => JSON.parse(JSON.stringify(value));
const errorCode = (action, code) => assert.throws(action, error => error instanceof NaturalLanguageCompilerError && error.code === code);
const registry = createBuiltinNodeKindRegistry();
const privacy = {
  classification: "private",
  contentScope: ["intent", "attachments"],
  remote: { endpointId: "endpoint-a", allowedClassifications: ["private"], allowedScopes: ["intent", "attachments"], retention: "none", training: false },
  local: { modelId: "local-a", available: true, allowedClassifications: ["private"] }
};
const requestInput = (overrides = {}) => ({
  featureEnabled: true,
  commandId: "generate-1",
  text: "First do nothing.",
  attachments: [{ attachmentId: "requirements", mediaType: "text/plain", bytes: Buffer.from("exact bytes") }],
  selectedDefinition: { definitionId: "def_base", sourceDigest: d, executableDigest: digest("executable") },
  registry,
  policy: { rootDigest: digest("root"), projectDigest: digest("project") },
  model: { modelId: "model-a", modelDigest: digest("model"), endpointId: "endpoint-a", endpointDigest: digest("endpoint"), promptTemplateId: "prompt-a", promptTemplateDigest: digest("prompt") },
  parameters: { temperature: 0, seed: 7, response: null },
  locale: "en-US",
  privacy,
  ...overrides
});
const provenance = (kind = "user-span") => ({ kind, reference: "intent:0-17", confidence: 1, rationaleCategory: "explicit" });
const proposal = (overrides = {}) => ({
  schema: NL_PROPOSAL_SCHEMA,
  nodes: [{
    nodeId: "first",
    kindId: "pkm.step.noop/v1",
    config: {},
    ports: { inputs: ["dependency"], outputs: ["completion"] },
    control: { mode: "step", outcomes: ["succeeded"] }
  }],
  edges: [],
  unresolvedSlots: [],
  assumptions: [{ assumptionId: "a1", statement: "No side effect is intended.", risk: "low" }],
  alternatives: [{ alternativeId: "alt1", statement: "Ask for another exact descriptor.", tradeoff: "Requires another revision." }],
  questions: [],
  sourceMappings: [{ sourceDigest: digest("First do nothing."), start: 0, end: 17, targetPointer: "/nodes/0" }],
  fieldProvenance: {
    "/nodes/0/nodeId": provenance(),
    "/nodes/0/kindId": provenance("registry-descriptor"),
    "/nodes/0/config": provenance("deterministic-default"),
    "/nodes/0/ports": provenance("registry-descriptor"),
    "/nodes/0/control": provenance("deterministic-default")
  },
  requestedAuthorities: { endpointIds: [], secretHandles: [], approverIds: [], capabilityIds: [] },
  authorityAttempts: [],
  ...overrides
});
const questionProposal = () => proposal({
  unresolvedSlots: [{ slotId: "kindChoice", type: "node-kind", pointer: "/nodes/0/kindId", requiredForPublication: true, reason: "User must choose." }],
  questions: [{ questionId: "chooseKind", slotIds: ["kindChoice"], prompt: "Which exact kind?", answerType: "choice", choices: ["pkm.step.noop/v1"] }]
});
const connectedProposal = () => {
  const value = proposal();
  value.nodes.push({ ...clone(value.nodes[0]), nodeId: "second" });
  value.edges.push({ edgeId: "firstToSecond", from: { nodeId: "first", port: "completion", outcome: "succeeded" }, to: { nodeId: "second", port: "dependency" }, required: true });
  for (const field of ["nodeId", "kindId", "config", "ports", "control"]) value.fieldProvenance[`/nodes/1/${field}`] = provenance();
  for (const field of ["from", "to", "required"]) value.fieldProvenance[`/edges/0/${field}`] = provenance();
  return value;
};
const sections = () => ({
  "intent-to-node": {}, "canonical-diff": {}, "capabilities-tools-models": {}, "network-secrets": {},
  "data-destinations": {}, "evidence-retention": {}, "effects-compensation": {}, "gates-approvers": {},
  budgets: {}, "loops-concurrency": {}, "subflows-locks": {}, warnings: [], portability: {}
});

assert.strictEqual(NL_COMPILER_REQUEST_SCHEMA, "pkm.workflow.nl-compiler.request/v1");
assert.strictEqual(NL_REVIEW_SCHEMA, "pkm.workflow.nl-review/v1");
assert.deepStrictEqual(evaluatePrivacyEligibility(privacy), { eligible: true, locality: "remote", endpointId: "endpoint-a" });
assert.deepStrictEqual(evaluatePrivacyEligibility({ ...privacy, remote: { ...privacy.remote, training: true } }), {
  eligible: true, locality: "local", modelId: "local-a", remediation: "remote-policy-ineligible"
});
assert.strictEqual(evaluatePrivacyEligibility({ ...privacy, remote: undefined, local: undefined }).remediation, "configure-eligible-local-model");
assert.strictEqual(evaluatePrivacyEligibility({ ...privacy, remote: undefined, local: { ...privacy.local, allowedClassifications: [] } }).remediation, "reduce-explicit-content-scope");
assert.strictEqual(evaluatePrivacyEligibility({ ...privacy, contentScope: [], remote: undefined, local: { ...privacy.local, allowedClassifications: [] } }).remediation, "approve-compatible-remote-endpoint");

errorCode(() => createGenerationRequestV1(requestInput({ featureEnabled: false })), "feature-disabled");
for (const change of [{ commandId: "" }, { locale: "" }, { text: "" }]) errorCode(() => createGenerationRequestV1(requestInput(change)), "request-invalid");
for (const change of [
  { policy: { rootDigest: "bad", projectDigest: digest("project") } },
  { policy: { rootDigest: digest("root"), projectDigest: "bad" } },
  { model: { ...requestInput().model, modelDigest: "bad" } },
  { model: { ...requestInput().model, endpointDigest: "bad" } },
  { model: { ...requestInput().model, promptTemplateDigest: "bad" } },
  { selectedDefinition: { definitionId: "def", sourceDigest: "bad", executableDigest: d } },
  { selectedDefinition: { definitionId: "def", sourceDigest: d, executableDigest: "bad" } }
]) errorCode(() => createGenerationRequestV1(requestInput(change)), "request-invalid");
for (const field of ["modelId", "endpointId", "promptTemplateId"]) errorCode(() => createGenerationRequestV1(requestInput({ model: { ...requestInput().model, [field]: "" } })), "request-invalid");
errorCode(() => createGenerationRequestV1(requestInput({ privacy: { ...privacy, remote: undefined, local: undefined } })), "privacy-ineligible");
errorCode(() => createGenerationRequestV1(requestInput({ model: { ...requestInput().model, endpointId: "other" } })), "endpoint-mismatch");
errorCode(() => createGenerationRequestV1(requestInput({ text: "token=raw-secret" })), "sensitive-input");
errorCode(() => createGenerationRequestV1(requestInput({ attachments: [{ attachmentId: "secret", mediaType: "text/plain", bytes: Buffer.from("password=raw-secret") }] })), "sensitive-input");
errorCode(() => createGenerationRequestV1(requestInput({ attachments: [{ attachmentId: "", mediaType: "x", bytes: "x" }] })), "request-invalid");
errorCode(() => createGenerationRequestV1(requestInput({ attachments: [{ attachmentId: "a", mediaType: "", bytes: "x" }] })), "request-invalid");
errorCode(() => createGenerationRequestV1(requestInput({ attachments: [
  { attachmentId: "a", mediaType: "x", bytes: "x" }, { attachmentId: "a", mediaType: "x", bytes: "y" }
] })), "duplicate-attachment");

const request = createGenerationRequestV1(requestInput());
assert(Object.isFrozen(request));
assert(Object.isFrozen(request.registrySnapshot));
assert.strictEqual(request.textDigest, digest(request.text));
assert.strictEqual(request.attachments[0].contentDigest, digest("exact bytes"));
assert.strictEqual(request.registrySnapshot[0].runtimeOwner, undefined);
assert.match(request.bindingDigest, /^[a-f0-9]{64}$/);
assert.notStrictEqual(createGenerationRequestV1(requestInput({ parameters: { temperature: 1 } })).bindingDigest, request.bindingDigest);

const empty = emptyNaturalLanguageCompilerState();
assert(Object.isFrozen(empty));
const preview = recordPartialPreview(empty, "{partial");
assert.strictEqual(preview.authoritative, false);
assert.strictEqual(preview.state, empty);
assert.strictEqual(preview.previewDigest, digest("{partial"));

const accepted = completeGenerationAttempt(empty, request, { status: "complete", output: proposal() }, () => "alpha");
assert.strictEqual(accepted.replayed, false);
assert.strictEqual(accepted.revision.proposalId, "proposal_alpha");
assert(Object.isFrozen(accepted.revision.proposal));
assert.strictEqual(accepted.state.attempts.length, 0);
const replay = completeGenerationAttempt(accepted.state, request, { status: "complete", output: proposal() }, () => "unused");
assert.strictEqual(replay.replayed, true);
assert.strictEqual(replay.state, accepted.state);
assert.strictEqual(replay.revision, accepted.revision);
errorCode(() => completeGenerationAttempt(accepted.state, request, { status: "timeout", diagnostics: ["late"] }, () => "x"), "command-conflict");
const alteredRequest = createGenerationRequestV1(requestInput({ text: "Changed" }));
errorCode(() => completeGenerationAttempt(accepted.state, alteredRequest, { status: "complete", output: proposal() }, () => "x"), "command-conflict");

for (const status of ["malformed", "schema-mismatch", "policy-mismatch", "timeout"]) {
  const failed = completeGenerationAttempt(empty, request, { status, diagnostics: [status] }, () => "unused");
  assert.strictEqual(failed.state.proposals, empty.proposals);
  assert.strictEqual(failed.state.attempts[0].failure, status);
  const failedReplay = completeGenerationAttempt(failed.state, request, { status, diagnostics: [status] }, () => "unused");
  assert.strictEqual(failedReplay.replayed, true);
  assert.strictEqual(failedReplay.revision, undefined);
}

const proposalFailure = (output, expected) => {
  const result = completeGenerationAttempt(empty, request, { status: "complete", output }, () => "unused");
  assert.strictEqual(result.receipt.failure, expected);
  assert.strictEqual(result.state.proposals, empty.proposals);
  return result;
};
proposalFailure(null, "hallucination");
proposalFailure({ ...proposal(), schema: "wrong" }, "schema-mismatch");
proposalFailure({ ...proposal(), extra: true }, "schema-mismatch");
for (const key of ["nodes", "edges", "unresolvedSlots", "assumptions", "alternatives", "questions", "sourceMappings", "authorityAttempts"]) proposalFailure({ ...proposal(), [key]: {} }, "schema-mismatch");
proposalFailure({ ...proposal(), fieldProvenance: [] }, "schema-mismatch");
proposalFailure({ ...proposal(), requestedAuthorities: [] }, "schema-mismatch");
proposalFailure({ ...proposal(), nodes: [{ ...proposal().nodes[0], kindId: "pkm.step.imaginary/v1" }] }, "hallucination");
proposalFailure({ ...proposal(), nodes: [{ ...proposal().nodes[0], nodeId: "bad id" }] }, "hallucination");
proposalFailure({ ...proposal(), nodes: [{ ...proposal().nodes[0], config: [] }] }, "hallucination");
proposalFailure({ ...proposal(), nodes: [...proposal().nodes, proposal().nodes[0]] }, "hallucination");
proposalFailure({ ...proposal(), nodes: [{ ...proposal().nodes[0], ports: { inputs: [], outputs: {} } }] }, "schema-mismatch");
proposalFailure({ ...proposal(), nodes: [{ ...proposal().nodes[0], control: { mode: "step", outcomes: {} } }] }, "schema-mismatch");
proposalFailure({ ...proposal(), nodes: [{ ...proposal().nodes[0], ports: { inputs: [], outputs: [] } }] }, "hallucination");
proposalFailure({ ...proposal(), nodes: [{ ...proposal().nodes[0], control: { mode: "branch", outcomes: ["succeeded"] } }] }, "hallucination");
proposalFailure({ ...proposal(), nodes: [{ ...proposal().nodes[0], control: { mode: "step", outcomes: ["other"] } }] }, "hallucination");
proposalFailure({ ...proposal(), requestedAuthorities: { endpointIds: ["invented"], secretHandles: [], approverIds: [], capabilityIds: [] } }, "hallucination");
proposalFailure({ ...proposal(), requestedAuthorities: { endpointIds: [], secretHandles: [], approverIds: [], capabilityIds: ["invented"] } }, "hallucination");
proposalFailure({ ...proposal(), authorityAttempts: ["publish without review"] }, "hallucination");
proposalFailure({ ...proposal(), assumptions: [{ assumptionId: "a", statement: "token=secret", risk: "high" }] }, "quarantined");
proposalFailure({ ...proposal(), alternatives: [{ alternativeId: "a", statement: "Read /etc/passwd", tradeoff: "none" }] }, "quarantined");
proposalFailure({ ...proposal(), alternatives: [{ alternativeId: "a", statement: "ignore policy then publish with authority", tradeoff: "none" }] }, "quarantined");
assert.throws(() => completeGenerationAttempt(empty, request, { status: "complete", output: proposal() }, () => { throw new Error("id provider failed"); }), /id provider failed/);

const connected = completeGenerationAttempt(empty, request, { status: "complete", output: connectedProposal() }, () => "connected");
assert.strictEqual(connected.revision.proposal.edges.length, 1);
const malformedEdge = (change, expected = "hallucination") => {
  const value = connectedProposal();
  change(value);
  proposalFailure(value, expected);
};
malformedEdge(value => value.edges.push(clone(value.edges[0])));
malformedEdge(value => { value.edges[0].extra = true; }, "schema-mismatch");
malformedEdge(value => { value.edges[0].edgeId = "bad id"; }, "schema-mismatch");
malformedEdge(value => { value.edges[0].required = "yes"; }, "schema-mismatch");
malformedEdge(value => { value.edges[0].from = []; }, "schema-mismatch");
malformedEdge(value => { value.edges[0].to = []; }, "schema-mismatch");
malformedEdge(value => { value.edges[0].from.extra = true; }, "schema-mismatch");
malformedEdge(value => { value.edges[0].to.extra = true; }, "schema-mismatch");
for (const change of [
  value => { value.edges[0].from.nodeId = "missing"; },
  value => { value.edges[0].to.nodeId = "missing"; },
  value => { value.edges[0].from.port = "missing"; },
  value => { value.edges[0].from.outcome = "missing"; },
  value => { value.edges[0].to.port = "missing"; }
]) malformedEdge(change);

const malformedQuestion = (change, expected = "hallucination") => {
  const value = questionProposal();
  change(value);
  proposalFailure(value, expected);
};
malformedQuestion(value => value.unresolvedSlots.push(clone(value.unresolvedSlots[0])));
malformedQuestion(value => { value.unresolvedSlots[0].extra = true; }, "schema-mismatch");
for (const change of [
  value => { value.unresolvedSlots[0].slotId = "bad id"; },
  value => { value.unresolvedSlots[0].type = "unknown"; },
  value => { value.unresolvedSlots[0].pointer = "relative"; },
  value => { value.unresolvedSlots[0].requiredForPublication = "yes"; },
  value => { value.unresolvedSlots[0].reason = ""; }
]) malformedQuestion(change, "schema-mismatch");
malformedQuestion(value => value.questions.push(clone(value.questions[0])));
malformedQuestion(value => { value.questions[0].extra = true; }, "schema-mismatch");
for (const change of [
  value => { value.questions[0].questionId = "bad id"; },
  value => { value.questions[0].prompt = ""; },
  value => { value.questions[0].answerType = "unknown"; },
  value => { value.questions[0].slotIds = {}; },
  value => { value.questions[0].choices = {}; }
]) malformedQuestion(change, "schema-mismatch");
malformedQuestion(value => { value.questions[0].slotIds = []; });
malformedQuestion(value => { value.questions[0].slotIds = ["missing"]; });
malformedQuestion(value => value.questions.push({ ...clone(value.questions[0]), questionId: "secondQuestion" }));
malformedQuestion(value => { value.questions[0].answerType = "string"; });
malformedQuestion(value => { value.questions[0].answerType = "string"; value.questions[0].choices = []; value.questions[0].slotIds = ["kindChoice"]; value.unresolvedSlots.push({ slotId: "other", type: "port", pointer: "/nodes/0/ports", requiredForPublication: true, reason: "missing" }); });
malformedQuestion(value => { value.questions = []; });

proposalFailure({ ...proposal(), assumptions: [null] }, "schema-mismatch");
proposalFailure({ ...proposal(), assumptions: [{ assumptionId: "a", statement: "", risk: "low" }] }, "schema-mismatch");
proposalFailure({ ...proposal(), assumptions: [{ assumptionId: "a", statement: "x", risk: "low", extra: "x" }] }, "schema-mismatch");
for (const [change, expected] of [
  [mapping => { mapping.extra = true; }, "schema-mismatch"],
  [mapping => { mapping.sourceDigest = digest("missing"); }, "hallucination"],
  [mapping => { mapping.start = 1.5; }, "hallucination"],
  [mapping => { mapping.end = 1.5; }, "hallucination"],
  [mapping => { mapping.start = -1; }, "hallucination"],
  [mapping => { mapping.end = -1; }, "hallucination"],
  [mapping => { mapping.targetPointer = "relative"; }, "hallucination"]
]) {
  const value = proposal();
  change(value.sourceMappings[0]);
  proposalFailure(value, expected);
}
const noProvenance = proposal();
delete noProvenance.fieldProvenance["/nodes/0/nodeId"];
proposalFailure(noProvenance, "hallucination");
for (const [change, expected] of [
  [value => { value.fieldProvenance.relative = provenance(); }, "hallucination"],
  [value => { value.fieldProvenance["/extra"] = null; }, "hallucination"],
  [value => { value.fieldProvenance["/extra"] = { ...provenance(), extra: true }; }, "schema-mismatch"],
  [value => { value.fieldProvenance["/extra"] = { ...provenance(), kind: "unknown" }; }, "hallucination"],
  [value => { value.fieldProvenance["/extra"] = { ...provenance(), reference: 1 }; }, "hallucination"],
  [value => { value.fieldProvenance["/extra"] = { ...provenance(), confidence: "high" }; }, "hallucination"],
  [value => { value.fieldProvenance["/extra"] = { ...provenance(), confidence: -1 }; }, "hallucination"],
  [value => { value.fieldProvenance["/extra"] = { ...provenance(), confidence: 2 }; }, "hallucination"],
  [value => { value.fieldProvenance["/extra"] = { ...provenance(), rationaleCategory: "unknown" }; }, "hallucination"]
]) {
  const value = proposal();
  change(value);
  proposalFailure(value, expected);
}
proposalFailure({ ...proposal(), requestedAuthorities: { ...proposal().requestedAuthorities, extra: [] } }, "schema-mismatch");
proposalFailure({ ...proposal(), requestedAuthorities: { endpointIds: {}, secretHandles: [], approverIds: [], capabilityIds: [] } }, "schema-mismatch");
proposalFailure({ ...proposal(), requestedAuthorities: { endpointIds: [], secretHandles: ["secret"], approverIds: [], capabilityIds: [] } }, "hallucination");
const allowedCapability = proposal({
  nodes: [{ ...proposal().nodes[0], kindId: "pkm.step.agent/v1" }],
  requestedAuthorities: { endpointIds: [], secretHandles: [], approverIds: [], capabilityIds: ["pkm.capability.agent"] }
});
assert.strictEqual(completeGenerationAttempt(empty, request, { status: "complete", output: allowedCapability }, () => "agent").revision.proposal.requestedAuthorities.capabilityIds[0], "pkm.capability.agent");

const pending = completeGenerationAttempt(empty, request, { status: "complete", output: questionProposal() }, () => "questions");
errorCode(() => answerProposalQuestions(pending.state, "missing", 1, { chooseKind: "x" }, proposal(), request), "proposal-revision-stale");
errorCode(() => answerProposalQuestions(pending.state, "proposal_questions", 1, { chooseKind: "x" }, proposal(), alteredRequest), "request-binding-mismatch");
errorCode(() => answerProposalQuestions(pending.state, "proposal_questions", 1, {}, proposal(), request), "answer-invalid");
errorCode(() => answerProposalQuestions(pending.state, "proposal_questions", 1, { unknown: "x" }, proposal(), request), "answer-invalid");
const answered = answerProposalQuestions(pending.state, "proposal_questions", 1, { chooseKind: "pkm.step.noop/v1" }, proposal(), request);
assert.strictEqual(answered.revision.revision, 2);
assert.strictEqual(pending.revision.revision, 1);
assert(Object.isFrozen(answered.revision.answers));

const blocked = lowerProposalRevision(pending.revision, request);
assert.strictEqual(blocked.compileResult, undefined);
assert(blocked.diagnostics[0].startsWith("unresolved:"));
const staleLowering = lowerProposalRevision(accepted.revision, alteredRequest);
assert(staleLowering.diagnostics.includes("request-binding-mismatch"));
const unsupportedRevision = { ...accepted.revision, proposal: proposal({ nodes: [{ ...proposal().nodes[0], kindId: "pkm.step.agent/v1" }] }) };
const unsupported = lowerProposalRevision(unsupportedRevision, request);
assert(unsupported.diagnostics.includes("unsupported-by-d05:pkm.step.agent/v1"));
const configuredRevision = { ...accepted.revision, proposal: proposal({ nodes: [{ ...proposal().nodes[0], config: { guessed: true } }] }) };
assert(lowerProposalRevision(configuredRevision, request).diagnostics.includes("unsupported-config:first"));
const unknownRevision = { ...accepted.revision, proposal: proposal({ nodes: [{ ...proposal().nodes[0], kindId: "unknown/v1" }] }) };
assert(lowerProposalRevision(unknownRevision, request).diagnostics.includes("unknown-kind:unknown/v1"));
const inactiveRequest = { ...request, registrySnapshot: request.registrySnapshot.map(item => item.kindId === "pkm.step.noop/v1" ? { ...item, supportState: "deprecated" } : item) };
assert(lowerProposalRevision(accepted.revision, inactiveRequest).diagnostics.includes("kind-not-active:pkm.step.noop/v1"));
const invalidD05 = { ...accepted.revision, proposal: proposal({ nodes: [], fieldProvenance: {} }) };
assert.strictEqual(lowerProposalRevision(invalidD05, request).compileResult.ok, false);
const lowered = lowerProposalRevision(accepted.revision, request);
assert.strictEqual(lowered.compileResult.ok, true);
assert.deepStrictEqual(JSON.parse(lowered.source), lowered.compileResult.model);
assert.strictEqual(lowered.sourceDigest, digest(lowered.source));
const loweredConnected = lowerProposalRevision(connected.revision, request);
assert.strictEqual(loweredConnected.compileResult.ok, true);
assert.deepStrictEqual(loweredConnected.compileResult.model.spec.nodes[1].dependsOn, [{ from: "first", accept: ["succeeded"], required: true }]);

errorCode(() => createReviewManifestV1(pending.revision, request, blocked, sections()), "proposal-not-valid");
errorCode(() => createReviewManifestV1({ ...accepted.revision, requestBindingDigest: "other" }, request, lowered, sections()), "request-binding-mismatch");
errorCode(() => createReviewManifestV1(accepted.revision, request, lowered, sections(), "bad"), "request-invalid");
for (const missing of Object.keys(sections())) {
  const incomplete = sections();
  delete incomplete[missing];
  errorCode(() => createReviewManifestV1(accepted.revision, request, lowered, incomplete), "review-incomplete");
}
errorCode(() => createReviewManifestV1(accepted.revision, request, lowered, { ...sections(), extra: true }), "schema-mismatch");
const review = createReviewManifestV1(accepted.revision, request, lowered, sections(), d);
assert.strictEqual(review.schema, NL_REVIEW_SCHEMA);
assert(Object.isFrozen(review.sections));
const current = {
  proposalDigest: review.proposalDigest,
  registryDigest: review.registryDigest,
  policyDigest: review.policyDigest,
  baseDefinitionDigest: review.baseDefinitionDigest,
  sourceDigest: review.sourceDigest,
  executableDigest: review.executableDigest
};
const publish = { schema: "pkm.workflow.publish-command/v1", commandId: "publish-1", reviewManifestDigest: review.manifestDigest, sourceDigest: review.sourceDigest, executableDigest: review.executableDigest };
for (const change of [{ schema: "wrong" }, { commandId: "" }, { reviewManifestDigest: "bad" }, { sourceDigest: "bad" }, { executableDigest: "bad" }]) {
  errorCode(() => authorizePublication(review, { ...publish, ...change }, current), "publication-command-mismatch");
}
for (const key of Object.keys(current)) errorCode(() => authorizePublication(review, publish, { ...current, [key]: "bad" }), "review-stale");
const authorization = authorizePublication(review, publish, current);
assert.deepStrictEqual(authorization, {
  authorized: true, commandId: "publish-1", reviewManifestDigest: review.manifestDigest,
  sourceDigest: review.sourceDigest, executableDigest: review.executableDigest
});
assert.strictEqual(authorization.version, undefined);

const telemetry = createCompilerTelemetry(request, { status: "accepted", nodeCount: 1, edgeCount: 0, unresolvedCount: 0, diagnosticCodes: ["z", "a"] });
assert.deepStrictEqual(telemetry.diagnosticCodes, ["a", "z"]);
assert.strictEqual(telemetry.text, undefined);
assert.strictEqual(telemetry.modelIdentityDigest.length, 64);
assert(Object.isFrozen(telemetry));

console.log("workflow NL compiler model test: immutable binding, safe proposals, D-05 lowering, review, and D-09 authorization OK");