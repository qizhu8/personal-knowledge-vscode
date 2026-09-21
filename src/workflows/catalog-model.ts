import { createHash, randomUUID } from "crypto";
import { canonicalJson } from "../workflow-contracts";
import { WorkflowPortDescriptor, normalizePortDescriptor } from "./value-contracts";

export type NodeKindSupportState = "active" | "deprecated" | "archived" | "revoked";
export type AdapterClass = "none" | "command" | "agent" | "check" | "human-gate" | "policy-gate" | "control" | "subflow";

export interface NodeKindRegistration {
  kindId: string;
  schemaVersion: string;
  configSchemaDigest: string;
  configValidatorDigest: string;
  runtimeOwner: string;
  adapterClass: AdapterClass;
  capabilityDeclarations: readonly string[];
  evidenceDeclarations: readonly string[];
  inputDeclarations: Readonly<Record<string, WorkflowPortDescriptor>>;
  outputDeclarations: Readonly<Record<string, WorkflowPortDescriptor>>;
  stateContractId: string;
  checkpointContractId: string;
  portability: Readonly<{ portable: boolean; installationRequirements: readonly string[]; runtimeAvailable: boolean }>;
  conformanceDigest: string;
  supportState: NodeKindSupportState;
  revocation: Readonly<{ revoked: boolean; reason?: string }>;
}

export type NodeKindRegistry = Readonly<Record<string, NodeKindRegistration>>;

export interface DefinitionDraft {
  readonly definitionId: string;
  readonly revision: number;
  readonly source: string;
  readonly sourceDigest: string;
  readonly compiledDefinition: unknown;
  readonly executableDigest: string;
}

export interface DependencyLockEntry {
  readonly slot: string;
  readonly definitionId: string;
  readonly versionId: string;
  readonly executableDigest: string;
  readonly dependencyLockDigest: string;
  readonly transitiveLock: DependencyLock;
}

export interface DependencyLock {
  readonly entries: readonly DependencyLockEntry[];
}

export interface ResourceEntry {
  path: string;
  mediaType: string;
  size: number;
  contentDigest: string;
}

export interface PublishedDefinitionVersion {
  readonly definitionId: string;
  readonly versionId: string;
  readonly draftRevision: number;
  readonly source: string;
  readonly compiledDefinition: unknown;
  readonly sourceDigest: string;
  readonly executableDigest: string;
  readonly dependencyLock: DependencyLock;
  readonly dependencyLockDigest: string;
  readonly resourceManifest: readonly ResourceEntry[];
  readonly resourceManifestDigest: string;
  readonly presentation: unknown;
  readonly presentationDigest: string;
  readonly capabilityManifest: readonly string[];
  readonly evidenceManifest: readonly string[];
  readonly bundleDigest: string;
  readonly runtimeStatus: "runnable" | "not-runnable-here";
  readonly unavailableKinds: readonly string[];
}

export interface PublicationReceipt {
  readonly commandId: string;
  readonly requestFingerprint: string;
  readonly definitionId: string;
  readonly versionId: string;
  readonly bundleDigest: string;
}

export interface InstallationRecord {
  readonly sourceRootId: string;
  readonly sourceDefinitionId: string;
  readonly sourceVersionId: string;
  readonly sourceBundleDigest: string;
  readonly localDefinitionId: string;
  readonly installationId: string;
}

export interface ForkRecord {
  readonly sourceDefinitionId: string;
  readonly localDefinitionId: string;
  readonly forkId: string;
}

export interface DefinitionCatalog {
  readonly versions: readonly PublishedDefinitionVersion[];
  readonly publicationReceipts: readonly PublicationReceipt[];
  readonly installations: readonly InstallationRecord[];
  readonly forks: readonly ForkRecord[];
}

export interface PublishRequest {
  commandId: string;
  expectedRevision: number;
  expectedExecutableDigest: string;
  dependencies: readonly { slot: string; versionId: string }[];
  resources: readonly ResourceEntry[];
  presentation: unknown;
  capabilityManifest: readonly string[];
  evidenceManifest: readonly string[];
}

export class WorkflowCatalogError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkflowCatalogError";
  }
}

const KIND_ID = /^(pkm|[a-z0-9]+(?:\.[a-z0-9-]+)+)\.[a-z][a-z0-9.-]*\/v[1-9][0-9]*$/;
const DEFINITION_ID = /^def_[A-Za-z0-9_-]+$/;
const DIGEST = /^[a-f0-9]{64}$/;

export const BUILTIN_NODE_KIND_IDS = [
  "pkm.step.noop/v1",
  "pkm.step.command/v1",
  "pkm.step.agent/v1",
  "pkm.check/v1",
  "pkm.gate.human/v1",
  "pkm.gate.policy/v1",
  "pkm.control.branch/v1",
  "pkm.control.merge/v1",
  "pkm.control.join/v1",
  "pkm.control.loop/v1",
  "pkm.subflow/v1"
] as const;

export function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function createNodeKindRegistry(registrations: readonly NodeKindRegistration[]): NodeKindRegistry {
  const registry: Record<string, NodeKindRegistration> = {};
  for (const candidate of registrations) {
    const registration = normalizeRegistration(candidate);
    if (registry[registration.kindId]) throw new WorkflowCatalogError("duplicate-node-kind", `Duplicate node kind ${registration.kindId}.`);
    registry[registration.kindId] = registration;
  }
  return deepFreeze(registry);
}

export function createBuiltinNodeKindRegistry(unavailableKinds: readonly string[] = []): NodeKindRegistry {
  const unavailable = new Set(unavailableKinds);
  return createNodeKindRegistry(BUILTIN_NODE_KIND_IDS.map(kindId => builtinRegistration(kindId, !unavailable.has(kindId))));
}

export function createDefinitionDraft(source: string, compiledDefinition: unknown, createId: () => string = randomUUID): DefinitionDraft {
  return makeDraft(`def_${createId()}`, 1, source, compiledDefinition);
}

export function reviseDefinitionDraft(draft: DefinitionDraft, source: string, compiledDefinition: unknown): DefinitionDraft {
  if (source === draft.source && digestCanonical(compiledDefinition) === draft.executableDigest) return draft;
  return makeDraft(draft.definitionId, draft.revision + 1, source, compiledDefinition);
}

export function emptyDefinitionCatalog(): DefinitionCatalog {
  return deepFreeze({ versions: [], publicationReceipts: [], installations: [], forks: [] });
}

export function publishDefinition(
  catalog: DefinitionCatalog,
  draft: DefinitionDraft,
  request: PublishRequest,
  registry: NodeKindRegistry,
  createId: () => string = randomUUID
): { catalog: DefinitionCatalog; version: PublishedDefinitionVersion; receipt: PublicationReceipt; replayed: boolean } {
  const fingerprint = publicationFingerprint(draft, request);
  const prior = catalog.publicationReceipts.find(receipt => receipt.commandId === request.commandId);
  if (prior) {
    if (prior.requestFingerprint !== fingerprint) throw new WorkflowCatalogError("command-conflict", "Publication command was already used for another request.");
    const version = catalog.versions.find(candidate => candidate.versionId === prior.versionId);
    if (!version) throw new WorkflowCatalogError("catalog-corrupt", "Publication receipt has no immutable version.");
    return { catalog, version, receipt: prior, replayed: true };
  }
  if (request.expectedRevision !== draft.revision || request.expectedExecutableDigest !== draft.executableDigest) {
    throw new WorkflowCatalogError("stale-draft", "Publication does not match the exact compiled Draft revision.");
  }
  const availability = validateKinds(draft.compiledDefinition, registry);
  const dependencyLock = resolveDependencyLock(catalog, draft.definitionId, request.dependencies);
  const dependencyLockDigest = digestCanonical(dependencyLock);
  const resourceManifest = normalizeResources(request.resources);
  const resourceManifestDigest = digestCanonical(resourceManifest);
  const presentationDigest = digestCanonical(request.presentation);
  const capabilityManifest = normalizeSet(request.capabilityManifest, "capability");
  const evidenceManifest = normalizeSet(request.evidenceManifest, "evidence");
  const versionId = `ver_${createId()}`;
  if (catalog.versions.some(version => version.versionId === versionId)) throw new WorkflowCatalogError("identity-conflict", "Generated Version identity already exists.");
  const unsignedManifest = {
    definitionId: draft.definitionId,
    versionId,
    schema: "pkm.workflow.publication/v1",
    draftRevision: draft.revision,
    sourceDigest: draft.sourceDigest,
    executableDigest: draft.executableDigest,
    dependencyLockDigest,
    resourceManifestDigest,
    presentationDigest,
    capabilityManifest,
    evidenceManifest,
    nodeKindValidators: availability.validators
  };
  const version: PublishedDefinitionVersion = deepFreeze({
    definitionId: draft.definitionId,
    versionId,
    draftRevision: draft.revision,
    source: draft.source,
    compiledDefinition: cloneCanonical(draft.compiledDefinition),
    sourceDigest: draft.sourceDigest,
    executableDigest: draft.executableDigest,
    dependencyLock,
    dependencyLockDigest,
    resourceManifest,
    resourceManifestDigest,
    presentation: cloneCanonical(request.presentation),
    presentationDigest,
    capabilityManifest,
    evidenceManifest,
    bundleDigest: digestCanonical(unsignedManifest),
    runtimeStatus: availability.unavailableKinds.length ? "not-runnable-here" : "runnable",
    unavailableKinds: availability.unavailableKinds
  });
  const receipt: PublicationReceipt = deepFreeze({ commandId: request.commandId, requestFingerprint: fingerprint, definitionId: draft.definitionId, versionId, bundleDigest: version.bundleDigest });
  const nextCatalog = deepFreeze({
    ...catalog,
    versions: [...catalog.versions, version],
    publicationReceipts: [...catalog.publicationReceipts, receipt]
  });
  return { catalog: nextCatalog, version, receipt, replayed: false };
}

export function installExactBundle(
  catalog: DefinitionCatalog,
  source: { rootId: string; definitionId: string; versionId: string; bundleDigest: string },
  createId: () => string = randomUUID
): { catalog: DefinitionCatalog; installation: InstallationRecord; replayed: boolean } {
  const existing = catalog.installations.find(item => item.sourceRootId === source.rootId
    && item.sourceDefinitionId === source.definitionId && item.sourceVersionId === source.versionId
    && item.sourceBundleDigest === source.bundleDigest);
  if (existing) return { catalog, installation: existing, replayed: true };
  if (!DIGEST.test(source.bundleDigest)) throw new WorkflowCatalogError("invalid-bundle-digest", "Install requires an exact SHA-256 bundle digest.");
  const installation: InstallationRecord = deepFreeze({
    sourceRootId: source.rootId,
    sourceDefinitionId: source.definitionId,
    sourceVersionId: source.versionId,
    sourceBundleDigest: source.bundleDigest,
    localDefinitionId: `def_${createId()}`,
    installationId: `install_${createId()}`
  });
  return { catalog: deepFreeze({ ...catalog, installations: [...catalog.installations, installation] }), installation, replayed: false };
}

export function forkDefinition(catalog: DefinitionCatalog, sourceDefinitionId: string, createId: () => string = randomUUID): { catalog: DefinitionCatalog; fork: ForkRecord } {
  const fork: ForkRecord = deepFreeze({ sourceDefinitionId, localDefinitionId: `def_${createId()}`, forkId: `fork_${createId()}` });
  return { catalog: deepFreeze({ ...catalog, forks: [...catalog.forks, fork] }), fork };
}

function makeDraft(definitionId: string, revision: number, source: string, compiledDefinition: unknown): DefinitionDraft {
  if (!DEFINITION_ID.test(definitionId)) throw new WorkflowCatalogError("invalid-definition-id", "Definition ID must be an opaque prefixed identifier.");
  return deepFreeze({
    definitionId,
    revision,
    source,
    sourceDigest: createHash("sha256").update(source, "utf8").digest("hex"),
    compiledDefinition: cloneCanonical(compiledDefinition),
    executableDigest: digestCanonical(compiledDefinition)
  });
}

function normalizeRegistration(candidate: NodeKindRegistration): NodeKindRegistration {
  if (!KIND_ID.test(candidate.kindId)) throw new WorkflowCatalogError("invalid-node-kind", `Invalid exact node kind ${candidate.kindId}.`);
  if (!candidate.schemaVersion || !DIGEST.test(candidate.configSchemaDigest) || !DIGEST.test(candidate.configValidatorDigest) || !DIGEST.test(candidate.conformanceDigest)) {
    throw new WorkflowCatalogError("invalid-node-kind-contract", `Node kind ${candidate.kindId} has an incomplete exact contract.`);
  }
  if (candidate.revocation.revoked !== (candidate.supportState === "revoked")) throw new WorkflowCatalogError("invalid-revocation", "Revocation state must agree with support state.");
  const inputs = normalizePorts(candidate.inputDeclarations);
  const outputs = normalizePorts(candidate.outputDeclarations);
  return deepFreeze({
    ...candidate,
    capabilityDeclarations: normalizeSet(candidate.capabilityDeclarations, "capability"),
    evidenceDeclarations: normalizeSet(candidate.evidenceDeclarations, "evidence"),
    inputDeclarations: inputs,
    outputDeclarations: outputs,
    portability: { ...candidate.portability, installationRequirements: normalizeSet(candidate.portability.installationRequirements, "installation requirement") },
    revocation: { ...candidate.revocation }
  });
}

function normalizePorts(ports: Readonly<Record<string, WorkflowPortDescriptor>>): Readonly<Record<string, WorkflowPortDescriptor>> {
  const normalized: Record<string, WorkflowPortDescriptor> = {};
  for (const name of Object.keys(ports).sort()) normalized[name] = normalizePortDescriptor(ports[name], `/${name}`);
  return deepFreeze(normalized);
}

function builtinRegistration(kindId: typeof BUILTIN_NODE_KIND_IDS[number], runtimeAvailable: boolean): NodeKindRegistration {
  const adapterClass: AdapterClass = kindId.includes(".command/") ? "command"
    : kindId.includes(".agent/") ? "agent"
      : kindId === "pkm.check/v1" ? "check"
        : kindId === "pkm.gate.human/v1" ? "human-gate"
          : kindId === "pkm.gate.policy/v1" ? "policy-gate"
            : kindId === "pkm.subflow/v1" ? "subflow"
              : kindId === "pkm.step.noop/v1" ? "none" : "control";
  const portable = adapterClass !== "command";
  return {
    kindId,
    schemaVersion: "v1",
    configSchemaDigest: digestCanonical({ kindId, contract: "config/v1" }),
    configValidatorDigest: digestCanonical({ kindId, contract: "validator/v1" }),
    runtimeOwner: adapterClass === "control" || adapterClass === "none" ? "pkm.runtime" : `pkm.adapter.${adapterClass}`,
    adapterClass,
    capabilityDeclarations: adapterClass === "none" || adapterClass === "control" ? [] : [`pkm.capability.${adapterClass}`],
    evidenceDeclarations: adapterClass === "none" ? ["invocation-receipt"] : ["attempt-receipt"],
    inputDeclarations: {},
    outputDeclarations: {},
    stateContractId: adapterClass === "control" ? "pkm.node-state.control/v1" : "pkm.node-state.attempt/v1",
    checkpointContractId: adapterClass === "control" || adapterClass === "none" ? "pkm.checkpoint.none/v1" : "pkm.checkpoint.adapter/v1",
    portability: { portable, installationRequirements: portable ? [`runtime:${kindId}`] : [], runtimeAvailable },
    conformanceDigest: digestCanonical({ kindId, contract: "conformance/v1" }),
    supportState: "active",
    revocation: { revoked: false }
  };
}

function validateKinds(compiledDefinition: unknown, registry: NodeKindRegistry): { validators: readonly { kindId: string; schemaVersion: string; configValidatorDigest: string }[]; unavailableKinds: readonly string[] } {
  const nodes = readNodes(compiledDefinition);
  const kinds = normalizeSet(nodes.map(node => node.kind), "node kind");
  const unavailableKinds: string[] = [];
  const validators = kinds.map(kindId => {
    const registration = registry[kindId];
    if (!registration) throw new WorkflowCatalogError("unknown-node-kind", `Unknown node kind ${kindId}.`);
    if (registration.supportState === "revoked" || registration.revocation.revoked) throw new WorkflowCatalogError("revoked-node-kind", `Revoked node kind ${kindId}.`);
    if (!registration.portability.runtimeAvailable) {
      if (!registration.portability.portable) throw new WorkflowCatalogError("runtime-unavailable", `Required runtime for ${kindId} is unavailable.`);
      unavailableKinds.push(kindId);
    }
    return { kindId, schemaVersion: registration.schemaVersion, configValidatorDigest: registration.configValidatorDigest };
  });
  return deepFreeze({ validators, unavailableKinds });
}

function readNodes(compiledDefinition: unknown): { kind: string }[] {
  if (!isRecord(compiledDefinition) || !isRecord(compiledDefinition.spec) || !Array.isArray(compiledDefinition.spec.nodes)) {
    throw new WorkflowCatalogError("invalid-compiled-definition", "Compiled Definition must contain spec.nodes.");
  }
  return compiledDefinition.spec.nodes.map(node => {
    if (!isRecord(node) || typeof node.kind !== "string") throw new WorkflowCatalogError("invalid-compiled-node", "Every compiled node requires an exact kind.");
    return { kind: node.kind };
  });
}

function resolveDependencyLock(catalog: DefinitionCatalog, parentDefinitionId: string, requested: PublishRequest["dependencies"]): DependencyLock {
  const slots = new Set<string>();
  const entries = requested.map(binding => {
    if (slots.has(binding.slot)) throw new WorkflowCatalogError("duplicate-dependency-slot", `Duplicate dependency slot ${binding.slot}.`);
    slots.add(binding.slot);
    const child = catalog.versions.find(version => version.versionId === binding.versionId);
    if (!child) throw new WorkflowCatalogError("dependency-not-found", `Dependency version ${binding.versionId} was not found.`);
    if (child.definitionId === parentDefinitionId || lockContainsDefinition(child.dependencyLock, parentDefinitionId)) {
      throw new WorkflowCatalogError("dependency-cycle", `Dependency slot ${binding.slot} creates a Definition cycle.`);
    }
    return {
      slot: binding.slot,
      definitionId: child.definitionId,
      versionId: child.versionId,
      executableDigest: child.executableDigest,
      dependencyLockDigest: child.dependencyLockDigest,
      transitiveLock: child.dependencyLock
    };
  }).sort((left, right) => left.slot.localeCompare(right.slot));
  return deepFreeze({ entries });
}

function lockContainsDefinition(lock: DependencyLock, definitionId: string): boolean {
  return lock.entries.some(entry => entry.definitionId === definitionId || lockContainsDefinition(entry.transitiveLock, definitionId));
}

function normalizeResources(resources: readonly ResourceEntry[]): readonly ResourceEntry[] {
  const normalized = resources.map(resource => {
    if (!resource.path || !resource.mediaType || !Number.isSafeInteger(resource.size) || resource.size < 0 || !DIGEST.test(resource.contentDigest)) {
      throw new WorkflowCatalogError("invalid-resource", "Resource manifest entry is invalid.");
    }
    return { ...resource };
  }).sort((left, right) => left.path.localeCompare(right.path) || left.mediaType.localeCompare(right.mediaType) || left.contentDigest.localeCompare(right.contentDigest));
  for (let index = 1; index < normalized.length; index += 1) {
    if (canonicalJson(normalized[index]) === canonicalJson(normalized[index - 1])) throw new WorkflowCatalogError("duplicate-resource", `Duplicate resource ${normalized[index].path}.`);
  }
  return deepFreeze(normalized);
}

function normalizeSet(values: readonly string[], label: string): readonly string[] {
  const normalized = [...values].sort();
  if (normalized.some(value => !value)) throw new WorkflowCatalogError("invalid-set-value", `Empty ${label} is not allowed.`);
  if (normalized.some((value, index) => index > 0 && value === normalized[index - 1])) throw new WorkflowCatalogError("duplicate-set-value", `Duplicate ${label}.`);
  return deepFreeze(normalized);
}

function publicationFingerprint(draft: DefinitionDraft, request: PublishRequest): string {
  return digestCanonical({
    definitionId: draft.definitionId,
    revision: request.expectedRevision,
    sourceDigest: draft.sourceDigest,
    executableDigest: request.expectedExecutableDigest,
    dependencies: [...request.dependencies].sort((left, right) => left.slot.localeCompare(right.slot)),
    resources: normalizeResources(request.resources),
    presentation: request.presentation,
    capabilityManifest: normalizeSet(request.capabilityManifest, "capability"),
    evidenceManifest: normalizeSet(request.evidenceManifest, "evidence")
  });
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}