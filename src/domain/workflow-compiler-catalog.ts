import { createHash } from "node:crypto";
import { canonicalJson } from "./project-recipes-workflow-contracts.js";
import { type WorkflowPortDescriptor, normalizePortDescriptor } from "./project-recipes-value-contracts.js";

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

export class WorkflowCatalogError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkflowCatalogError";
  }
}

const KIND_ID = /^(pkm|[a-z0-9]+(?:\.[a-z0-9-]+)+)\.[a-z][a-z0-9.-]*\/v[1-9][0-9]*$/;

const DIGEST = /^[a-f0-9]{64}$/;

export const BUILTIN_NODE_KIND_IDS = [
  "pkm.step.noop/v1",
  "pkm.step.command/v1",
  "pkm.step.script/v1",
  "pkm.step.pipeline/v1",
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
  const adapterClass: AdapterClass = kindId.includes(".command/") || kindId.includes(".script/") || kindId.includes(".pipeline/") ? "command"
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

function normalizeSet(values: readonly string[], label: string): readonly string[] {
  const normalized = [...values].sort();
  if (normalized.some(value => !value)) throw new WorkflowCatalogError("invalid-set-value", `Empty ${label} is not allowed.`);
  if (normalized.some((value, index) => index > 0 && value === normalized[index - 1])) throw new WorkflowCatalogError("duplicate-set-value", `Duplicate ${label}.`);
  return deepFreeze(normalized);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
