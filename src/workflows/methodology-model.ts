import { createHash } from "crypto";
import { canonicalJson } from "../workflow-contracts";

export const RECIPE_METHODOLOGY_SCHEMA = "pkm.recipe.methodology/v1" as const;

export const RECIPE_PHASES = [
  "clarify",
  "specify-objective",
  "establish-contract",
  "explore",
  "decide",
  "plan",
  "execute",
  "test",
  "validate",
  "deliver",
  "preserve-learning"
] as const;

export const COMMUNICATION_ASSURANCE_MODES = [
  "direct",
  "structured-acknowledgement",
  "confirmed-read-back",
  "high-assurance-contract"
] as const;

export const METHODOLOGY_EXPANSION_SIGNALS = [
  "ambiguity",
  "risk",
  "irreversibility",
  "destructive-scope",
  "execution-cost",
  "rework-cost",
  "cross-agent-handoff",
  "missing-shared-context",
  "terminology-mismatch",
  "user-request"
] as const;

export type RecipePhase = typeof RECIPE_PHASES[number];
export type CommunicationAssuranceMode = typeof COMMUNICATION_ASSURANCE_MODES[number];
export type MethodologyExpansionSignal = typeof METHODOLOGY_EXPANSION_SIGNALS[number];

export interface MethodologyRecipeReference {
  recipeId: string;
  revision: number;
  executableDigest: string;
}

export interface RecipeMethodologyV1 {
  schema: typeof RECIPE_METHODOLOGY_SCHEMA;
  family: string;
  phase: RecipePhase;
  abstract: boolean;
  extends?: MethodologyRecipeReference;
  mixins: MethodologyRecipeReference[];
  capabilities: string[];
  artifacts: {
    inputs: string[];
    outputs: string[];
  };
  gates: string[];
  invariants: string[];
  expansion: {
    mode: "atomic" | "adaptive" | "expanded";
    signals: MethodologyExpansionSignal[];
  };
  communication: {
    minimumAssurance: CommunicationAssuranceMode;
    escalateOn: MethodologyExpansionSignal[];
  };
  retrieval: {
    intents: string[];
    terminology: string[];
    operationalPoints: string[];
  };
}

export type RecipeMethodologyCompileResult =
  | { ok: true; model: RecipeMethodologyV1; methodologyDigest: string; diagnostics: [] }
  | { ok: false; diagnostics: RecipeMethodologyDiagnostic[] };

export interface RecipeMethodologyDiagnostic {
  code: string;
  pointer: string;
  message: string;
}

export interface MethodologyRecipeDescriptor {
  recipeId: string;
  revision: number;
  executableDigest: string;
  methodology?: RecipeMethodologyV1;
}

export interface ResolvedRecipeMethodology {
  methodology: RecipeMethodologyV1;
  methodologyDigest: string;
  lineage: MethodologyRecipeReference[];
}

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(code: string, pointer: string, message: string): RecipeMethodologyDiagnostic {
  return { code, pointer, message };
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], pointer: string, diagnostics: RecipeMethodologyDiagnostic[]): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value).filter(key => !known.has(key)).sort()) {
    diagnostics.push(diagnostic("methodology-unknown-field", `${pointer}/${key}`, `Unknown Methodology Manifest field: ${key}.`));
  }
}

function normalizeIdentifier(value: unknown, pointer: string, diagnostics: RecipeMethodologyDiagnostic[]): string | undefined {
  const normalized = typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
  if (!IDENTIFIER.test(normalized)) {
    diagnostics.push(diagnostic("methodology-identifier-invalid", pointer, "Expected a canonical lowercase identifier."));
    return undefined;
  }
  return normalized;
}

function normalizeIdentifierArray(value: unknown, pointer: string, diagnostics: RecipeMethodologyDiagnostic[]): string[] | undefined {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic("methodology-array-required", pointer, "Expected an array of canonical identifiers."));
    return undefined;
  }
  const normalized = value.map((entry, index) => normalizeIdentifier(entry, `${pointer}/${index}`, diagnostics));
  return normalized.every((entry): entry is string => Boolean(entry))
    ? [...new Set(normalized)].sort()
    : undefined;
}

function normalizeTextArray(value: unknown, pointer: string, diagnostics: RecipeMethodologyDiagnostic[]): string[] | undefined {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic("methodology-array-required", pointer, "Expected an array of text values."));
    return undefined;
  }
  const normalized = value.map((entry, index) => {
    const text = typeof entry === "string" ? entry.trim().normalize("NFC") : "";
    if (!text) diagnostics.push(diagnostic("methodology-text-required", `${pointer}/${index}`, "Expected non-empty text."));
    return text;
  });
  return normalized.every(Boolean) ? [...new Set(normalized)].sort() : undefined;
}

function normalizeReference(value: unknown, pointer: string, diagnostics: RecipeMethodologyDiagnostic[]): MethodologyRecipeReference | undefined {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("methodology-reference-required", pointer, "Expected a pinned Recipe reference."));
    return undefined;
  }
  rejectUnknownKeys(value, ["recipeId", "revision", "executableDigest"], pointer, diagnostics);
  const recipeId = typeof value.recipeId === "string" ? value.recipeId.trim() : "";
  const revision = value.revision;
  const executableDigest = typeof value.executableDigest === "string" ? value.executableDigest : "";
  if (!recipeId) diagnostics.push(diagnostic("methodology-reference-recipe-required", `${pointer}/recipeId`, "Recipe ID is required."));
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
    diagnostics.push(diagnostic("methodology-reference-revision-invalid", `${pointer}/revision`, "Recipe revision must be a positive integer."));
  }
  if (!SHA256.test(executableDigest)) {
    diagnostics.push(diagnostic("methodology-reference-digest-invalid", `${pointer}/executableDigest`, "Executable digest must be SHA-256 hex."));
  }
  return recipeId && Number.isSafeInteger(revision) && Number(revision) >= 1 && SHA256.test(executableDigest)
    ? { recipeId, revision: Number(revision), executableDigest }
    : undefined;
}

function normalizeReferenceArray(value: unknown, pointer: string, diagnostics: RecipeMethodologyDiagnostic[]): MethodologyRecipeReference[] | undefined {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic("methodology-array-required", pointer, "Expected an array of pinned Recipe references."));
    return undefined;
  }
  const normalized = value.map((entry, index) => normalizeReference(entry, `${pointer}/${index}`, diagnostics));
  if (!normalized.every((entry): entry is MethodologyRecipeReference => Boolean(entry))) return undefined;
  const identities = new Set<string>();
  for (const reference of normalized) {
    if (identities.has(reference.recipeId)) {
      diagnostics.push(diagnostic("methodology-reference-duplicate", pointer, `Recipe ${reference.recipeId} is referenced more than once.`));
    }
    identities.add(reference.recipeId);
  }
  return [...normalized].sort((left, right) => left.recipeId.localeCompare(right.recipeId));
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], pointer: string, diagnostics: RecipeMethodologyDiagnostic[]): T | undefined {
  if (!allowed.includes(value as T)) {
    diagnostics.push(diagnostic("methodology-enum-invalid", pointer, `Expected one of: ${allowed.join(", ")}.`));
    return undefined;
  }
  return value as T;
}

function normalizeSignalArray(value: unknown, pointer: string, diagnostics: RecipeMethodologyDiagnostic[]): MethodologyExpansionSignal[] | undefined {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic("methodology-array-required", pointer, "Expected an array of expansion signals."));
    return undefined;
  }
  const normalized = value.map((entry, index) =>
    normalizeEnum(entry, METHODOLOGY_EXPANSION_SIGNALS, `${pointer}/${index}`, diagnostics));
  return normalized.every((entry): entry is MethodologyExpansionSignal => Boolean(entry))
    ? [...new Set(normalized)].sort()
    : undefined;
}

export function compileRecipeMethodologyV1(value: unknown): RecipeMethodologyCompileResult {
  const diagnostics: RecipeMethodologyDiagnostic[] = [];
  if (!isRecord(value)) {
    return { ok: false, diagnostics: [diagnostic("methodology-object-required", "", "Expected a Methodology Manifest object.")] };
  }
  rejectUnknownKeys(value, [
    "schema", "family", "phase", "abstract", "extends", "mixins", "capabilities",
    "artifacts", "gates", "invariants", "expansion", "communication", "retrieval"
  ], "", diagnostics);
  if (value.schema !== RECIPE_METHODOLOGY_SCHEMA) {
    diagnostics.push(diagnostic("methodology-schema-invalid", "/schema", `Expected ${RECIPE_METHODOLOGY_SCHEMA}.`));
  }
  const family = normalizeIdentifier(value.family, "/family", diagnostics);
  const phase = normalizeEnum(value.phase, RECIPE_PHASES, "/phase", diagnostics);
  if (typeof value.abstract !== "boolean") {
    diagnostics.push(diagnostic("methodology-abstract-invalid", "/abstract", "Expected a boolean."));
  }
  const parent = value.extends === undefined ? undefined : normalizeReference(value.extends, "/extends", diagnostics);
  const mixins = normalizeReferenceArray(value.mixins, "/mixins", diagnostics);
  const capabilities = normalizeIdentifierArray(value.capabilities, "/capabilities", diagnostics);
  const gates = normalizeIdentifierArray(value.gates, "/gates", diagnostics);
  const invariants = normalizeIdentifierArray(value.invariants, "/invariants", diagnostics);

  let artifacts: RecipeMethodologyV1["artifacts"] | undefined;
  if (!isRecord(value.artifacts)) {
    diagnostics.push(diagnostic("methodology-artifacts-required", "/artifacts", "Expected artifact contracts."));
  } else {
    rejectUnknownKeys(value.artifacts, ["inputs", "outputs"], "/artifacts", diagnostics);
    const inputs = normalizeIdentifierArray(value.artifacts.inputs, "/artifacts/inputs", diagnostics);
    const outputs = normalizeIdentifierArray(value.artifacts.outputs, "/artifacts/outputs", diagnostics);
    if (inputs && outputs) artifacts = { inputs, outputs };
  }

  let expansion: RecipeMethodologyV1["expansion"] | undefined;
  if (!isRecord(value.expansion)) {
    diagnostics.push(diagnostic("methodology-expansion-required", "/expansion", "Expected an expansion policy."));
  } else {
    rejectUnknownKeys(value.expansion, ["mode", "signals"], "/expansion", diagnostics);
    const mode = normalizeEnum(value.expansion.mode, ["atomic", "adaptive", "expanded"] as const, "/expansion/mode", diagnostics);
    const signals = normalizeSignalArray(value.expansion.signals, "/expansion/signals", diagnostics);
    if (mode && signals) expansion = { mode, signals };
  }

  let communication: RecipeMethodologyV1["communication"] | undefined;
  if (!isRecord(value.communication)) {
    diagnostics.push(diagnostic("methodology-communication-required", "/communication", "Expected a communication assurance policy."));
  } else {
    rejectUnknownKeys(value.communication, ["minimumAssurance", "escalateOn"], "/communication", diagnostics);
    const minimumAssurance = normalizeEnum(
      value.communication.minimumAssurance, COMMUNICATION_ASSURANCE_MODES,
      "/communication/minimumAssurance", diagnostics);
    const escalateOn = normalizeSignalArray(value.communication.escalateOn, "/communication/escalateOn", diagnostics);
    if (minimumAssurance && escalateOn) communication = { minimumAssurance, escalateOn };
  }

  let retrieval: RecipeMethodologyV1["retrieval"] | undefined;
  if (!isRecord(value.retrieval)) {
    diagnostics.push(diagnostic("methodology-retrieval-required", "/retrieval", "Expected retrieval descriptors."));
  } else {
    rejectUnknownKeys(value.retrieval, ["intents", "terminology", "operationalPoints"], "/retrieval", diagnostics);
    const intents = normalizeTextArray(value.retrieval.intents, "/retrieval/intents", diagnostics);
    const terminology = normalizeTextArray(value.retrieval.terminology, "/retrieval/terminology", diagnostics);
    const operationalPoints = normalizeTextArray(value.retrieval.operationalPoints, "/retrieval/operationalPoints", diagnostics);
    if (intents && terminology && operationalPoints) retrieval = { intents, terminology, operationalPoints };
  }

  if (diagnostics.length || !family || !phase || typeof value.abstract !== "boolean"
    || !mixins || !capabilities || !artifacts || !gates || !invariants || !expansion || !communication || !retrieval) {
    return { ok: false, diagnostics };
  }

  const model: RecipeMethodologyV1 = {
    schema: RECIPE_METHODOLOGY_SCHEMA,
    family,
    phase,
    abstract: value.abstract,
    ...(parent ? { extends: parent } : {}),
    mixins,
    capabilities,
    artifacts,
    gates,
    invariants,
    expansion,
    communication,
    retrieval
  };
  return {
    ok: true,
    model,
    methodologyDigest: createHash("sha256").update(canonicalJson(model)).digest("hex"),
    diagnostics: []
  };
}

function union<T extends string>(...values: readonly T[][]): T[] {
  return [...new Set(values.flat())].sort();
}

function assuranceRank(mode: CommunicationAssuranceMode): number {
  return COMMUNICATION_ASSURANCE_MODES.indexOf(mode);
}

export function resolveRecipeMethodology(
  root: MethodologyRecipeDescriptor,
  lookup: (recipeId: string) => MethodologyRecipeDescriptor | undefined
): ResolvedRecipeMethodology {
  if (!root.methodology) throw new Error(`Recipe ${root.recipeId} has no Methodology Manifest.`);
  const visiting = new Set<string>();
  const resolved = new Map<string, ResolvedRecipeMethodology>();

  const visit = (recipe: MethodologyRecipeDescriptor): ResolvedRecipeMethodology => {
    const cached = resolved.get(recipe.recipeId);
    if (cached) return cached;
    if (visiting.has(recipe.recipeId)) throw new Error(`Methodology inheritance cycle includes ${recipe.recipeId}.`);
    if (!recipe.methodology) throw new Error(`Recipe ${recipe.recipeId} has no Methodology Manifest.`);
    visiting.add(recipe.recipeId);
    const references = [recipe.methodology.extends, ...recipe.methodology.mixins].filter(
      (reference): reference is MethodologyRecipeReference => Boolean(reference));
    const parents = references.map(reference => {
      const candidate = lookup(reference.recipeId);
      if (!candidate) throw new Error(`Methodology Recipe ${reference.recipeId} was not found.`);
      if (candidate.revision !== reference.revision || candidate.executableDigest !== reference.executableDigest) {
        throw new Error(`Methodology Recipe ${reference.recipeId} no longer matches its pinned revision and digest.`);
      }
      return visit(candidate);
    });
    const manifests = [...parents.map(parent => parent.methodology), recipe.methodology];
    const minimumAssurance = manifests.map(manifest => manifest.communication.minimumAssurance)
      .sort((left, right) => assuranceRank(right) - assuranceRank(left))[0];
    const methodology: RecipeMethodologyV1 = {
      ...recipe.methodology,
      capabilities: union(...manifests.map(manifest => manifest.capabilities)),
      artifacts: {
        inputs: union(...manifests.map(manifest => manifest.artifacts.inputs)),
        outputs: union(...manifests.map(manifest => manifest.artifacts.outputs))
      },
      gates: union(...manifests.map(manifest => manifest.gates)),
      invariants: union(...manifests.map(manifest => manifest.invariants)),
      expansion: {
        mode: recipe.methodology.expansion.mode,
        signals: union(...manifests.map(manifest => manifest.expansion.signals))
      },
      communication: {
        minimumAssurance,
        escalateOn: union(...manifests.map(manifest => manifest.communication.escalateOn))
      },
      retrieval: {
        intents: union(...manifests.map(manifest => manifest.retrieval.intents)),
        terminology: union(...manifests.map(manifest => manifest.retrieval.terminology)),
        operationalPoints: union(...manifests.map(manifest => manifest.retrieval.operationalPoints))
      }
    };
    const compiled = compileRecipeMethodologyV1(methodology);
    if (!compiled.ok) throw new Error(`Resolved Methodology Manifest for ${recipe.recipeId} is invalid.`);
    const lineage = [
      ...parents.flatMap(parent => parent.lineage),
      { recipeId: recipe.recipeId, revision: recipe.revision, executableDigest: recipe.executableDigest }
    ].filter((reference, index, all) => all.findIndex(candidate => candidate.recipeId === reference.recipeId) === index);
    const result = { methodology: compiled.model, methodologyDigest: compiled.methodologyDigest, lineage };
    resolved.set(recipe.recipeId, result);
    visiting.delete(recipe.recipeId);
    return result;
  };

  return visit(root);
}
