import { createHash } from "crypto";
import {
  NOOP_NODE_KIND,
  WorkflowCompileResult,
  canonicalJson,
  compileWorkflowDefinitionV1
} from "../workflow-contracts";
import { NodeKindRegistry } from "./catalog-model";

export const NL_COMPILER_REQUEST_SCHEMA = "pkm.workflow.nl-compiler.request/v1" as const;
export const NL_PROPOSAL_SCHEMA = "pkm.workflow.nl-proposal/v1" as const;
export const NL_REVIEW_SCHEMA = "pkm.workflow.nl-review/v1" as const;

const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const PROVENANCE_KINDS = new Set(["user-span", "selected-source", "registry-descriptor", "deterministic-default", "model-inference"]);
const RATIONALE_CATEGORIES = new Set(["explicit", "structural", "compatibility", "default", "inference"]);
const QUESTION_TYPES = new Set(["string", "boolean", "integer", "identifier", "choice"]);
const SLOT_TYPES = new Set(["node-kind", "node-id", "port", "outcome", "policy", "effect", "evidence", "capability", "secret-reference", "approver", "subflow"]);
const REQUIRED_REVIEW_SECTIONS = [
  "intent-to-node", "canonical-diff", "capabilities-tools-models", "network-secrets", "data-destinations",
  "evidence-retention", "effects-compensation", "gates-approvers", "budgets", "loops-concurrency",
  "subflows-locks", "warnings", "portability"
] as const;

export class NaturalLanguageCompilerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NaturalLanguageCompilerError";
  }
}

export interface PrivacyEligibilityInput {
  readonly classification: string;
  readonly contentScope: readonly string[];
  readonly remote?: Readonly<{ endpointId: string; allowedClassifications: readonly string[]; allowedScopes: readonly string[]; retention: string; training: boolean }>;
  readonly local?: Readonly<{ modelId: string; available: boolean; allowedClassifications: readonly string[] }>;
}

export type PrivacyEligibility =
  | Readonly<{ eligible: true; locality: "remote"; endpointId: string }>
  | Readonly<{ eligible: true; locality: "local"; modelId: string; remediation: "remote-policy-ineligible" }>
  | Readonly<{ eligible: false; locality: "none"; remediation: "configure-eligible-local-model" | "reduce-explicit-content-scope" | "approve-compatible-remote-endpoint" }>;

export interface GenerationRequestInput {
  readonly featureEnabled: boolean;
  readonly commandId: string;
  readonly text: string;
  readonly attachments: readonly Readonly<{ attachmentId: string; mediaType: string; bytes: Buffer | string }>[];
  readonly selectedDefinition?: Readonly<{ definitionId: string; sourceDigest: string; executableDigest: string }>;
  readonly registry: NodeKindRegistry;
  readonly policy: Readonly<{ rootDigest: string; projectDigest: string }>;
  readonly model: Readonly<{ modelId: string; modelDigest: string; endpointId: string; endpointDigest: string; promptTemplateId: string; promptTemplateDigest: string }>;
  readonly parameters: Readonly<Record<string, string | number | boolean | null>>;
  readonly locale: string;
  readonly privacy: PrivacyEligibilityInput;
}

export interface GenerationRequestV1 {
  readonly schema: typeof NL_COMPILER_REQUEST_SCHEMA;
  readonly commandId: string;
  readonly text: string;
  readonly textDigest: string;
  readonly attachments: readonly Readonly<{ attachmentId: string; mediaType: string; contentDigest: string }>[];
  readonly selectedDefinition?: GenerationRequestInput["selectedDefinition"];
  readonly registrySnapshot: readonly SanitizedDescriptor[];
  readonly registryDigest: string;
  readonly policy: GenerationRequestInput["policy"];
  readonly policyDigest: string;
  readonly model: GenerationRequestInput["model"];
  readonly parameters: GenerationRequestInput["parameters"];
  readonly locale: string;
  readonly privacy: PrivacyEligibility;
  readonly bindingDigest: string;
}

export interface SanitizedDescriptor {
  readonly kindId: string;
  readonly schemaVersion: string;
  readonly configSchemaDigest: string;
  readonly configValidatorDigest: string;
  readonly capabilityDeclarations: readonly string[];
  readonly evidenceDeclarations: readonly string[];
  readonly inputDeclarations: unknown;
  readonly outputDeclarations: unknown;
  readonly supportState: string;
  readonly runtimeAvailable: boolean;
}

export interface FieldProvenance {
  readonly kind: "user-span" | "selected-source" | "registry-descriptor" | "deterministic-default" | "model-inference";
  readonly reference: string;
  readonly confidence: number;
  readonly rationaleCategory: "explicit" | "structural" | "compatibility" | "default" | "inference";
}

export interface ProposalNode {
  readonly nodeId: string;
  readonly kindId: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly ports: Readonly<{ inputs: readonly string[]; outputs: readonly string[] }>;
  readonly control: Readonly<{ mode: "step" | "branch" | "merge" | "loop" | "gate" | "subflow"; outcomes: readonly string[] }>;
}

export interface ProposalEdge {
  readonly edgeId: string;
  readonly from: Readonly<{ nodeId: string; port: string; outcome: string }>;
  readonly to: Readonly<{ nodeId: string; port: string }>;
  readonly required: boolean;
}

export interface ProposalIRV1 {
  readonly schema: typeof NL_PROPOSAL_SCHEMA;
  readonly nodes: readonly ProposalNode[];
  readonly edges: readonly ProposalEdge[];
  readonly unresolvedSlots: readonly Readonly<{ slotId: string; type: string; pointer: string; requiredForPublication: boolean; reason: string }>[];
  readonly assumptions: readonly Readonly<{ assumptionId: string; statement: string; risk: "low" | "medium" | "high" }>[];
  readonly alternatives: readonly Readonly<{ alternativeId: string; statement: string; tradeoff: string }>[];
  readonly questions: readonly Readonly<{ questionId: string; slotIds: readonly string[]; prompt: string; answerType: string; choices: readonly string[] }>[];
  readonly sourceMappings: readonly Readonly<{ sourceDigest: string; start: number; end: number; targetPointer: string }>[];
  readonly fieldProvenance: Readonly<Record<string, FieldProvenance>>;
  readonly requestedAuthorities: Readonly<{ endpointIds: readonly string[]; secretHandles: readonly string[]; approverIds: readonly string[]; capabilityIds: readonly string[] }>;
  readonly authorityAttempts: readonly string[];
}

export interface ProposalRevision {
  readonly proposalId: string;
  readonly revision: number;
  readonly requestBindingDigest: string;
  readonly proposal: ProposalIRV1;
  readonly proposalDigest: string;
  readonly answers: Readonly<Record<string, string | number | boolean>>;
}

export interface FailedAttempt {
  readonly commandId: string;
  readonly requestBindingDigest: string;
  readonly failure: "malformed" | "schema-mismatch" | "hallucination" | "policy-mismatch" | "timeout" | "nondeterministic-replay" | "quarantined";
  readonly diagnostics: readonly string[];
}

export interface GenerationReceipt {
  readonly commandId: string;
  readonly requestBindingDigest: string;
  readonly resultDigest: string;
  readonly proposalId?: string;
  readonly proposalRevision?: number;
  readonly failure?: FailedAttempt["failure"];
}

export interface NaturalLanguageCompilerState {
  readonly proposals: readonly ProposalRevision[];
  readonly attempts: readonly FailedAttempt[];
  readonly receipts: readonly GenerationReceipt[];
}

export interface LoweredProposal {
  readonly source: string;
  readonly sourceDigest: string;
  readonly compileResult?: WorkflowCompileResult;
  readonly diagnostics: readonly string[];
}

export interface ReviewManifestV1 {
  readonly schema: typeof NL_REVIEW_SCHEMA;
  readonly proposalDigest: string;
  readonly registryDigest: string;
  readonly policyDigest: string;
  readonly baseDefinitionDigest?: string;
  readonly sourceDigest: string;
  readonly executableDigest: string;
  readonly sections: Readonly<Record<typeof REQUIRED_REVIEW_SECTIONS[number], unknown>>;
  readonly manifestDigest: string;
}

export interface PublicationAuthorization {
  readonly authorized: true;
  readonly commandId: string;
  readonly reviewManifestDigest: string;
  readonly sourceDigest: string;
  readonly executableDigest: string;
}

export function evaluatePrivacyEligibility(input: PrivacyEligibilityInput): PrivacyEligibility {
  const remote = input.remote;
  if (remote && remote.allowedClassifications.includes(input.classification)
    && input.contentScope.every(scope => remote.allowedScopes.includes(scope))
    && remote.retention === "none" && !remote.training) {
    return deepFreeze({ eligible: true, locality: "remote", endpointId: remote.endpointId });
  }
  const local = input.local;
  if (local?.available && local.allowedClassifications.includes(input.classification)) {
    return deepFreeze({ eligible: true, locality: "local", modelId: local.modelId, remediation: "remote-policy-ineligible" });
  }
  const remediation = !local?.available ? "configure-eligible-local-model"
    : input.contentScope.length ? "reduce-explicit-content-scope" : "approve-compatible-remote-endpoint";
  return deepFreeze({ eligible: false, locality: "none", remediation });
}

export function createGenerationRequestV1(input: GenerationRequestInput): GenerationRequestV1 {
  if (!input.featureEnabled) fail("feature-disabled", "Natural-language workflow compilation is disabled.");
  if (!input.commandId || !input.locale || !input.text) fail("request-invalid", "Command, locale, and exact input text are required.");
  validateDigest(input.policy.rootDigest, "root-policy-digest");
  validateDigest(input.policy.projectDigest, "project-policy-digest");
  validateDigest(input.model.modelDigest, "model-digest");
  validateDigest(input.model.endpointDigest, "endpoint-digest");
  validateDigest(input.model.promptTemplateDigest, "prompt-template-digest");
  for (const [label, identity] of [["model-id", input.model.modelId], ["endpoint-id", input.model.endpointId], ["prompt-template-id", input.model.promptTemplateId]]) requireText(identity, label);
  if (input.selectedDefinition) {
    validateDigest(input.selectedDefinition.sourceDigest, "selected-source-digest");
    validateDigest(input.selectedDefinition.executableDigest, "selected-executable-digest");
  }
  const privacy = evaluatePrivacyEligibility(input.privacy);
  if (!privacy.eligible) fail("privacy-ineligible", privacy.remediation);
  if (privacy.locality === "remote" && privacy.endpointId !== input.model.endpointId) fail("endpoint-mismatch", "Eligible endpoint does not match the bound endpoint.");
  if ([input.text, ...input.attachments.filter(item => typeof item.bytes === "string" || item.mediaType.startsWith("text/")).map(item => item.bytes.toString())].some(findSecret)) {
    fail("sensitive-input", "Raw secret-shaped content cannot be supplied to a model.");
  }
  const attachments = [...input.attachments].map(attachment => ({
    attachmentId: requireText(attachment.attachmentId, "attachment-id"),
    mediaType: requireText(attachment.mediaType, "attachment-media-type"),
    contentDigest: digestBytes(attachment.bytes)
  })).sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
  unique(attachments.map(item => item.attachmentId), "duplicate-attachment");
  const registrySnapshot = Object.values(input.registry).map(descriptor => deepFreeze({
    kindId: descriptor.kindId,
    schemaVersion: descriptor.schemaVersion,
    configSchemaDigest: descriptor.configSchemaDigest,
    configValidatorDigest: descriptor.configValidatorDigest,
    capabilityDeclarations: [...descriptor.capabilityDeclarations],
    evidenceDeclarations: [...descriptor.evidenceDeclarations],
    inputDeclarations: cloneCanonical(descriptor.inputDeclarations),
    outputDeclarations: cloneCanonical(descriptor.outputDeclarations),
    supportState: descriptor.supportState,
    runtimeAvailable: descriptor.portability.runtimeAvailable
  })).sort((left, right) => left.kindId.localeCompare(right.kindId));
  const registryDigest = digestCanonical(registrySnapshot);
  const policyDigest = digestCanonical(input.policy);
  const binding = {
    schema: NL_COMPILER_REQUEST_SCHEMA,
    commandId: input.commandId,
    textDigest: digestBytes(input.text),
    attachments,
    selectedDefinition: input.selectedDefinition,
    registryDigest,
    policyDigest,
    model: input.model,
    parameters: input.parameters,
    locale: input.locale,
    privacy
  };
  return deepFreeze({
    ...binding,
    text: input.text,
    registrySnapshot,
    policy: cloneCanonical(input.policy),
    model: cloneCanonical(input.model),
    parameters: cloneCanonical(input.parameters),
    bindingDigest: digestCanonical(binding)
  });
}

export function emptyNaturalLanguageCompilerState(): NaturalLanguageCompilerState {
  return deepFreeze({ proposals: [], attempts: [], receipts: [] });
}

export function recordPartialPreview(state: NaturalLanguageCompilerState, preview: string): Readonly<{ state: NaturalLanguageCompilerState; authoritative: false; previewDigest: string }> {
  return deepFreeze({ state, authoritative: false, previewDigest: digestBytes(preview) });
}

export function completeGenerationAttempt(
  state: NaturalLanguageCompilerState,
  request: GenerationRequestV1,
  outcome: Readonly<{ status: "complete"; output: unknown } | { status: "malformed" | "schema-mismatch" | "policy-mismatch" | "timeout"; diagnostics: readonly string[] }>,
  createId: () => string
): Readonly<{ state: NaturalLanguageCompilerState; receipt: GenerationReceipt; revision?: ProposalRevision; replayed: boolean }> {
  const resultDigest = digestCanonical(outcome);
  const prior = state.receipts.find(receipt => receipt.commandId === request.commandId);
  if (prior) {
    if (prior.requestBindingDigest !== request.bindingDigest || prior.resultDigest !== resultDigest) {
      fail("command-conflict", "Generation command was replayed with altered bound input or output.");
    }
    const revision = prior.proposalId === undefined ? undefined : state.proposals.find(item => item.proposalId === prior.proposalId && item.revision === prior.proposalRevision);
    return deepFreeze({ state, receipt: prior, revision, replayed: true });
  }
  if (outcome.status !== "complete") return failedResult(state, request, resultDigest, outcome.status, outcome.diagnostics);
  try {
    const proposal = validateProposal(outcome.output, request);
    const proposalId = `proposal_${requireText(createId(), "proposal-id")}`;
    const revision = deepFreeze({
      proposalId,
      revision: 1,
      requestBindingDigest: request.bindingDigest,
      proposal,
      proposalDigest: digestCanonical(proposal),
      answers: {}
    });
    const receipt = deepFreeze({ commandId: request.commandId, requestBindingDigest: request.bindingDigest, resultDigest, proposalId, proposalRevision: 1 });
    return deepFreeze({ state: deepFreeze({ proposals: [...state.proposals, revision], attempts: state.attempts, receipts: [...state.receipts, receipt] }), receipt, revision, replayed: false });
  } catch (error) {
    if (!(error instanceof NaturalLanguageCompilerError)) throw error;
    const failure = error.code === "quarantined" ? "quarantined" : error.code === "schema-mismatch" ? "schema-mismatch" : "hallucination";
    return failedResult(state, request, resultDigest, failure, [error.code]);
  }
}

export function answerProposalQuestions(
  state: NaturalLanguageCompilerState,
  proposalId: string,
  expectedRevision: number,
  answers: Readonly<Record<string, string | number | boolean>>,
  revisedOutput: unknown,
  request: GenerationRequestV1
): Readonly<{ state: NaturalLanguageCompilerState; revision: ProposalRevision }> {
  const current = state.proposals.find(item => item.proposalId === proposalId && item.revision === expectedRevision);
  if (!current) fail("proposal-revision-stale", "The exact proposal revision was not found.");
  if (current.requestBindingDigest !== request.bindingDigest) fail("request-binding-mismatch", "Answers do not match the bound generation request.");
  const questionIds = new Set(current.proposal.questions.map(question => question.questionId));
  if (!Object.keys(answers).length || Object.keys(answers).some(id => !questionIds.has(id))) fail("answer-invalid", "Answers must address known questions.");
  const proposal = validateProposal(revisedOutput, request);
  const revision = deepFreeze({
    proposalId,
    revision: current.revision + 1,
    requestBindingDigest: request.bindingDigest,
    proposal,
    proposalDigest: digestCanonical(proposal),
    answers: cloneCanonical(answers)
  });
  return deepFreeze({ state: deepFreeze({ ...state, proposals: [...state.proposals, revision] }), revision });
}

export function lowerProposalRevision(revision: ProposalRevision, request: GenerationRequestV1): LoweredProposal {
  const diagnostics: string[] = [];
  if (revision.requestBindingDigest !== request.bindingDigest) diagnostics.push("request-binding-mismatch");
  for (const slot of revision.proposal.unresolvedSlots) if (slot.requiredForPublication) diagnostics.push(`unresolved:${slot.slotId}:${slot.type}`);
  const descriptors = new Map(request.registrySnapshot.map(descriptor => [descriptor.kindId, descriptor]));
  for (const node of revision.proposal.nodes) {
    const descriptor = descriptors.get(node.kindId);
    if (!descriptor) diagnostics.push(`unknown-kind:${node.kindId}`);
    else if (descriptor.kindId !== NOOP_NODE_KIND) diagnostics.push(`unsupported-by-d05:${node.kindId}`);
    else if (descriptor.supportState !== "active") diagnostics.push(`kind-not-active:${node.kindId}`);
    if (Object.keys(node.config).length) diagnostics.push(`unsupported-config:${node.nodeId}`);
  }
  if (diagnostics.length) return deepFreeze({ source: "", sourceDigest: digestBytes(""), diagnostics });
  const incoming = new Map<string, ProposalEdge[]>();
  for (const edge of revision.proposal.edges) incoming.set(edge.to.nodeId, [...(incoming.get(edge.to.nodeId) || []), edge]);
  const definition = {
    schema: "pkm.workflow.definition/v1",
    spec: {
      inputs: {},
      nodes: revision.proposal.nodes.map(node => ({
        nodeId: node.nodeId,
        kind: NOOP_NODE_KIND,
        config: {},
        dependsOn: (incoming.get(node.nodeId) || []).map(edge => ({ from: edge.from.nodeId, accept: [edge.from.outcome], required: true }))
      })),
      outputs: {},
      completion: { requiredNodes: terminalNodeIds(revision.proposal) }
    }
  };
  const source = `${canonicalJson(definition)}\n`;
  const compileResult = compileWorkflowDefinitionV1(definition);
  return deepFreeze({ source, sourceDigest: digestBytes(source), compileResult, diagnostics: compileResult.ok ? [] : compileResult.diagnostics.map(item => item.code) });
}

export function createReviewManifestV1(
  revision: ProposalRevision,
  request: GenerationRequestV1,
  lowered: LoweredProposal,
  sections: Readonly<Record<typeof REQUIRED_REVIEW_SECTIONS[number], unknown>>,
  baseDefinitionDigest?: string
): ReviewManifestV1 {
  if (!lowered.compileResult?.ok || lowered.diagnostics.length) fail("proposal-not-valid", "Only a D-05-valid proposal can be reviewed.");
  if (revision.requestBindingDigest !== request.bindingDigest) fail("request-binding-mismatch", "Review input is stale.");
  if (baseDefinitionDigest !== undefined) validateDigest(baseDefinitionDigest, "base-definition-digest");
  for (const section of REQUIRED_REVIEW_SECTIONS) if (!(section in sections)) fail("review-incomplete", `Missing review section ${section}.`);
  exactKeys(sections, REQUIRED_REVIEW_SECTIONS);
  const manifest = {
    schema: NL_REVIEW_SCHEMA,
    proposalDigest: revision.proposalDigest,
    registryDigest: request.registryDigest,
    policyDigest: request.policyDigest,
    baseDefinitionDigest,
    sourceDigest: lowered.sourceDigest,
    executableDigest: lowered.compileResult.executableDigest,
    sections: cloneCanonical(sections)
  };
  return deepFreeze({ ...manifest, manifestDigest: digestCanonical(manifest) });
}

export function authorizePublication(
  review: ReviewManifestV1,
  freshCommand: Readonly<{ schema: "pkm.workflow.publish-command/v1"; commandId: string; reviewManifestDigest: string; sourceDigest: string; executableDigest: string }>,
  current: Readonly<{ proposalDigest: string; registryDigest: string; policyDigest: string; baseDefinitionDigest?: string; sourceDigest: string; executableDigest: string }>
): PublicationAuthorization {
  if (freshCommand.schema !== "pkm.workflow.publish-command/v1" || !freshCommand.commandId || freshCommand.reviewManifestDigest !== review.manifestDigest
    || freshCommand.sourceDigest !== review.sourceDigest || freshCommand.executableDigest !== review.executableDigest) {
    fail("publication-command-mismatch", "D-09 command does not bind the exact reviewed bytes.");
  }
  for (const key of ["proposalDigest", "registryDigest", "policyDigest", "baseDefinitionDigest", "sourceDigest", "executableDigest"] as const) {
    if (review[key] !== current[key]) fail("review-stale", `Reviewed ${key} is stale.`);
  }
  return deepFreeze({ authorized: true, commandId: freshCommand.commandId, reviewManifestDigest: review.manifestDigest, sourceDigest: review.sourceDigest, executableDigest: review.executableDigest });
}

export function createCompilerTelemetry(
  request: GenerationRequestV1,
  result: Readonly<{ status: "accepted" | "failed"; nodeCount: number; edgeCount: number; unresolvedCount: number; diagnosticCodes: readonly string[] }>
): Readonly<Record<string, unknown>> {
  return deepFreeze({
    requestBindingDigest: request.bindingDigest,
    registryDigest: request.registryDigest,
    policyDigest: request.policyDigest,
    modelIdentityDigest: digestCanonical(request.model),
    status: result.status,
    nodeCount: result.nodeCount,
    edgeCount: result.edgeCount,
    unresolvedCount: result.unresolvedCount,
    diagnosticCodes: [...result.diagnosticCodes].sort()
  });
}

function validateProposal(value: unknown, request: GenerationRequestV1): ProposalIRV1 {
  if (!isRecord(value)) fail("malformed", "Proposal output must be an object.");
  exactKeys(value, ["schema", "nodes", "edges", "unresolvedSlots", "assumptions", "alternatives", "questions", "sourceMappings", "fieldProvenance", "requestedAuthorities", "authorityAttempts"]);
  if (value.schema !== NL_PROPOSAL_SCHEMA) fail("schema-mismatch", "Proposal schema does not match.");
  for (const key of ["nodes", "edges", "unresolvedSlots", "assumptions", "alternatives", "questions", "sourceMappings", "authorityAttempts"] as const) {
    if (!Array.isArray(value[key])) fail("schema-mismatch", `${key} must be an array.`);
  }
  if (!isRecord(value.fieldProvenance) || !isRecord(value.requestedAuthorities)) fail("schema-mismatch", "Provenance and authority declarations are required.");
  const proposal = cloneCanonical(value) as unknown as ProposalIRV1;
  validateNodes(proposal.nodes, request);
  validateEdges(proposal.edges, proposal.nodes);
  validateSlotsAndQuestions(proposal.unresolvedSlots, proposal.questions);
  validateNarrative(proposal.assumptions, ["assumptionId", "statement", "risk"], "assumption");
  validateNarrative(proposal.alternatives, ["alternativeId", "statement", "tradeoff"], "alternative");
  validateMappings(proposal.sourceMappings, request);
  validateProvenance(proposal.fieldProvenance, proposal);
  validateAuthorities(proposal.requestedAuthorities, proposal.nodes, request);
  if (proposal.authorityAttempts.length) fail("prompt-injection-authority", "Content attempted to alter compiler authority.");
  const unsafe = findUnsafeGeneratedContent(proposal);
  if (unsafe) fail("quarantined", unsafe);
  return deepFreeze(proposal);
}

function validateNodes(nodes: readonly ProposalNode[], request: GenerationRequestV1): void {
  const knownKinds = new Set(request.registrySnapshot.map(item => item.kindId));
  unique(nodes.map(node => node.nodeId), "duplicate-node-id");
  for (const node of nodes) {
    exactKeys(node as unknown as Record<string, unknown>, ["nodeId", "kindId", "config", "ports", "control"]);
    if (!IDENTIFIER.test(node.nodeId) || !knownKinds.has(node.kindId) || !isRecord(node.config)) fail("invented-identifier", "Node uses an invalid or unavailable identifier.");
    if (!isRecord(node.ports) || !Array.isArray(node.ports.inputs) || !Array.isArray(node.ports.outputs)) fail("schema-mismatch", "Node ports are malformed.");
    exactKeys(node.ports as unknown as Record<string, unknown>, ["inputs", "outputs"]);
    if (!isRecord(node.control) || !Array.isArray(node.control.outcomes) || !["step", "branch", "merge", "loop", "gate", "subflow"].includes(node.control.mode)) fail("schema-mismatch", "Node control is malformed.");
    exactKeys(node.control as unknown as Record<string, unknown>, ["mode", "outcomes"]);
    unique([...node.ports.inputs, ...node.ports.outputs, ...node.control.outcomes], "duplicate-port-or-outcome");
    if (node.kindId === NOOP_NODE_KIND && canonicalJson(node.ports) !== canonicalJson({ inputs: ["dependency"], outputs: ["completion"] })) fail("invented-port", "Noop nodes use the exact D-05 dependency port profile.");
    if (node.kindId === NOOP_NODE_KIND && (node.control.mode !== "step" || canonicalJson(node.control.outcomes) !== canonicalJson(["succeeded"]))) fail("invented-outcome", "Noop nodes use the exact D-05 succeeded outcome profile.");
  }
}

function validateEdges(edges: readonly ProposalEdge[], nodes: readonly ProposalNode[]): void {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  unique(edges.map(edge => edge.edgeId), "duplicate-edge-id");
  for (const edge of edges) {
    exactKeys(edge as unknown as Record<string, unknown>, ["edgeId", "from", "to", "required"]);
    if (!IDENTIFIER.test(edge.edgeId) || typeof edge.required !== "boolean" || !isRecord(edge.from) || !isRecord(edge.to)) fail("schema-mismatch", "Edge is malformed.");
    exactKeys(edge.from as unknown as Record<string, unknown>, ["nodeId", "port", "outcome"]);
    exactKeys(edge.to as unknown as Record<string, unknown>, ["nodeId", "port"]);
    const from = byId.get(edge.from.nodeId);
    const to = byId.get(edge.to.nodeId);
    if (!from || !to || !from.ports.outputs.includes(edge.from.port) || !from.control.outcomes.includes(edge.from.outcome) || !to.ports.inputs.includes(edge.to.port)) {
      fail("invented-port", "Edge references an unavailable node, port, or outcome.");
    }
  }
}

function validateSlotsAndQuestions(slots: ProposalIRV1["unresolvedSlots"], questions: ProposalIRV1["questions"]): void {
  unique(slots.map(slot => slot.slotId), "duplicate-slot-id");
  const slotIds = new Set(slots.map(slot => slot.slotId));
  for (const slot of slots) {
    exactKeys(slot as unknown as Record<string, unknown>, ["slotId", "type", "pointer", "requiredForPublication", "reason"]);
    if (!IDENTIFIER.test(slot.slotId) || !SLOT_TYPES.has(slot.type) || !slot.pointer.startsWith("/") || typeof slot.requiredForPublication !== "boolean" || !slot.reason) fail("schema-mismatch", "Unresolved slot is malformed.");
  }
  unique(questions.map(question => question.questionId), "duplicate-question-id");
  const covered = new Set<string>();
  for (const question of questions) {
    exactKeys(question as unknown as Record<string, unknown>, ["questionId", "slotIds", "prompt", "answerType", "choices"]);
    if (!IDENTIFIER.test(question.questionId) || !question.prompt || !QUESTION_TYPES.has(question.answerType) || !Array.isArray(question.slotIds) || !Array.isArray(question.choices)) fail("schema-mismatch", "Question is malformed.");
    if (!question.slotIds.length || question.slotIds.some(slotId => !slotIds.has(slotId) || covered.has(slotId))) fail("question-not-minimal", "Each question must cover known slots once.");
    if ((question.answerType === "choice") !== (question.choices.length > 0)) fail("question-choice-mismatch", "Only choice questions have choices.");
    question.slotIds.forEach(slotId => covered.add(slotId));
  }
  if (slots.some(slot => slot.requiredForPublication && !covered.has(slot.slotId))) fail("blocking-slot-unquestioned", "Publication-blocking slots require a question.");
}

function validateNarrative(items: readonly unknown[], keys: readonly string[], label: string): void {
  for (const item of items) {
    if (!isRecord(item)) fail("schema-mismatch", `${label} must be an object.`);
    exactKeys(item, keys);
    if (Object.values(item).some(value => typeof value !== "string" || !value)) fail("schema-mismatch", `${label} fields must be non-empty strings.`);
  }
}

function validateMappings(mappings: ProposalIRV1["sourceMappings"], request: GenerationRequestV1): void {
  const sourceDigests = new Set([request.textDigest, ...request.attachments.map(item => item.contentDigest), request.selectedDefinition?.sourceDigest].filter((item): item is string => Boolean(item)));
  for (const mapping of mappings) {
    exactKeys(mapping as unknown as Record<string, unknown>, ["sourceDigest", "start", "end", "targetPointer"]);
    if (!sourceDigests.has(mapping.sourceDigest) || !Number.isSafeInteger(mapping.start) || !Number.isSafeInteger(mapping.end) || mapping.start < 0 || mapping.end < mapping.start || !mapping.targetPointer.startsWith("/")) {
      fail("source-mapping-invalid", "Source mapping does not bind an available source span.");
    }
  }
}

function validateProvenance(provenance: ProposalIRV1["fieldProvenance"], proposal: ProposalIRV1): void {
  const requiredPointers = [
    ...proposal.nodes.flatMap((_, index) => [`/nodes/${index}/nodeId`, `/nodes/${index}/kindId`, `/nodes/${index}/config`, `/nodes/${index}/ports`, `/nodes/${index}/control`]),
    ...proposal.edges.flatMap((_, index) => [`/edges/${index}/from`, `/edges/${index}/to`, `/edges/${index}/required`])
  ];
  if (requiredPointers.some(pointer => !(pointer in provenance))) fail("provenance-incomplete", "Every proposed executable field requires provenance.");
  for (const [pointer, item] of Object.entries(provenance)) {
    if (!pointer.startsWith("/") || !isRecord(item)) fail("provenance-invalid", "Field provenance is malformed.");
    exactKeys(item, ["kind", "reference", "confidence", "rationaleCategory"]);
    if (!PROVENANCE_KINDS.has(String(item.kind)) || typeof item.reference !== "string" || typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1 || !RATIONALE_CATEGORIES.has(String(item.rationaleCategory))) {
      fail("provenance-invalid", "Field provenance is malformed.");
    }
  }
}

function validateAuthorities(authorities: ProposalIRV1["requestedAuthorities"], nodes: readonly ProposalNode[], request: GenerationRequestV1): void {
  exactKeys(authorities as unknown as Record<string, unknown>, ["endpointIds", "secretHandles", "approverIds", "capabilityIds"]);
  if (![authorities.endpointIds, authorities.secretHandles, authorities.approverIds, authorities.capabilityIds].every(Array.isArray)) fail("schema-mismatch", "Authority declarations must be arrays.");
  if (authorities.endpointIds.length || authorities.secretHandles.length || authorities.approverIds.length) fail("invented-authority", "Proposal cannot select endpoints, secrets, or approvers.");
  const descriptors = new Map(request.registrySnapshot.map(item => [item.kindId, item]));
  const allowedCapabilities = new Set(nodes.flatMap(node => descriptors.get(node.kindId)!.capabilityDeclarations));
  if (authorities.capabilityIds.some(capability => !allowedCapabilities.has(capability))) fail("invented-capability", "Proposal requested an undeclared capability.");
}

function findUnsafeGeneratedContent(value: unknown): string | undefined {
  for (const text of collectStrings(value)) {
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_ -]?key|token|password)\s*[:=]\s*\S+/i.test(text)) return "generated-secret";
    if (/(?:^|[\s"'])(?:\.\.\/|\/(?:home|root|etc|var|tmp|Users)\/|[A-Za-z]:\\)/.test(text)) return "unsafe-path";
    if (/(?:ignore|override|bypass).{0,40}(?:instruction|policy|diagnostic|review).{0,80}(?:publish|execute|authority|secret|approver)/i.test(text)) return "prompt-injection-authority";
  }
  return undefined;
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (isRecord(value)) return Object.values(value).flatMap(collectStrings);
  return [];
}

function terminalNodeIds(proposal: ProposalIRV1): string[] {
  const sources = new Set(proposal.edges.map(edge => edge.from.nodeId));
  return proposal.nodes.map(node => node.nodeId).filter(nodeId => !sources.has(nodeId));
}

function failedResult(state: NaturalLanguageCompilerState, request: GenerationRequestV1, resultDigest: string, failure: FailedAttempt["failure"], diagnostics: readonly string[]) {
  const attempt = deepFreeze({ commandId: request.commandId, requestBindingDigest: request.bindingDigest, failure, diagnostics: [...diagnostics] });
  const receipt = deepFreeze({ commandId: request.commandId, requestBindingDigest: request.bindingDigest, resultDigest, failure });
  return deepFreeze({ state: deepFreeze({ proposals: state.proposals, attempts: [...state.attempts, attempt], receipts: [...state.receipts, receipt] }), receipt, replayed: false as const });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) fail("schema-mismatch", "Object contains missing or unknown fields.");
}

function validateDigest(value: string, label: string): void {
  if (!DIGEST.test(value)) fail("request-invalid", `${label} must be an exact SHA-256 digest.`);
}

function unique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) fail(code, code);
}

function requireText(value: string, label: string): string {
  if (!value) fail("request-invalid", `${label} is required.`);
  return value;
}

function digestBytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestCanonical(value: unknown): string {
  return digestBytes(canonicalJson(value));
}

function findSecret(text: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_ -]?key|token|password)\s*[:=]\s*\S+/i.test(text);
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string): never {
  throw new NaturalLanguageCompilerError(code, message);
}