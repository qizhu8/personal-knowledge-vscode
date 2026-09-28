import { createHash, randomUUID } from "crypto";
import {
  COMMAND_NODE_KIND,
  HUMAN_GATE_NODE_KIND,
  NOOP_NODE_KIND,
  SCRIPT_NODE_KIND,
  WORKFLOW_DEFINITION_SCHEMA,
  WorkflowDefinitionV1,
  compileWorkflowDefinitionV1
} from "../workflow-contracts";
import {
  CollaborationError,
  CollaborationTaskRecord,
  CollaborationTransition,
  collaborationGanttProjection,
  createCollaborationTask as createStructuredCollaborationTask,
  normalizeCollaborationTaskRecord,
  transitionCollaborationTask as transitionStructuredCollaborationTask,
  CollaborationOwnerPartition,
} from "../collaboration-model";
import {
  RECIPE_METHODOLOGY_SCHEMA,
  RecipeMethodologyV1,
  compileRecipeMethodologyV1
} from "./methodology-model";

export type ProjectSystemKind = "default-project";
export type ThreadSystemKind = "general-thread";
export type RecipeSystemKind = "built-in";
export type MigrationState = "pending" | "running" | "completed" | "failed";

export interface RecipeKnowledgeBinding {
  bindingId: string;
  kind: "skill" | "note";
  knowledgeId: string;
  contentHash: string;
  usage: "required" | "recommended" | "reference";
}

export interface RecipeNodeBindings {
  nodeId: string;
  bindings: RecipeKnowledgeBinding[];
}

export interface RecipeMetadataField {
  name: string;
  description: string;
  required?: boolean;
}

export interface RecipeMetadata {
  applicableFunctions: string[];
  solution: string;
  requiredInputs: RecipeMetadataField[];
  expectedOutputs: RecipeMetadataField[];
}

export interface ProjectRecord {
  projectId: string;
  name: string;
  systemKind?: ProjectSystemKind;
  version: number;
}

export interface ThreadRecord {
  threadId: string;
  projectId: string;
  name: string;
  description: string;
  archived: boolean;
  systemKind?: ThreadSystemKind;
  legacyAliases: string[];
  chatroom?: {
    roomId: string;
    roomName: string;
    linkedAt: string;
  };
  version: number;
}

export type GanttTaskStatus = "not-started" | "in-progress" | "blocked" | "completed";

export interface GanttTaskOwner {
  name: string;
  role: string;
}

export interface GanttTaskRecord {
  taskId: string;
  projectId: string;
  threadId?: string;
  title: string;
  startDate: string;
  endDate: string;
  progress: number;
  status: GanttTaskStatus;
  owners: GanttTaskOwner[];
  dependencyIds: string[];
  version: number;
}

export interface GanttTaskInput {
  threadId?: string;
  title: string;
  startDate: string;
  endDate: string;
  progress: number;
  status: GanttTaskStatus;
  owners?: GanttTaskOwner[];
  dependencyIds?: string[];
}

export interface CollaborationTaskInput {
  collaborationId: string;
  title: string;
  threadId: string;
  ganttTaskId?: string;
  lead: string;
  owners: string[];
  reviewers: string[];
  expectedResponders?: string[];
  deadlineAt?: string;
  agentSessionId?: string;
  recipeRunId?: string;
  objective?: string;
  context?: string;
  expectedOutput?: string;
  artifactType?: string;
  acceptanceCriteria?: string[];
  decisionRequired?: boolean;
  primaryOwner?: string;
  ownerPartitions?: CollaborationOwnerPartition[];
  at: string;
}

export interface RecipeRecord {
  schema?: "pkm.knowledge/v1";
  knowledgeId?: string;
  aliases?: string[];
  recipeId: string;
  scope: "global" | "project";
  projectId?: string;
  category?: string;
  systemKind?: RecipeSystemKind;
  name: string;
  description: string;
  methodology?: RecipeMethodologyV1;
  methodologyDigest?: string;
  metadata?: RecipeMetadata;
  editorLayout?: { nodePositions: Record<string, { x: number; y: number }> };
  definition: WorkflowDefinitionV1;
  nodeBindings?: RecipeNodeBindings[];
  executableDigest: string;
  revision: number;
  origin?: {
    kind: "direct-sync" | "subscription-fork" | string;
    sourceRecipeId?: string;
    sourceKey?: string;
    sourceRevision?: number;
    sourceScope?: "global" | "project";
    brokerName?: string;
    publisherUser?: string;
    publisherHost?: string;
  };
}

export interface RecipeImportOptions {
  kind: "direct-sync" | "subscription-fork";
  sourceKey: string;
  preserveIdentity: boolean;
  categoryPrefix?: string;
  brokerName?: string;
  publisherUser?: string;
  publisherHost?: string;
  rejectExisting?: boolean;
}

export interface RecipeTrashRecord extends RecipeRecord {
  trashedAt: string;
}

export interface RecipeUpdate {
  name: string;
  category: string;
  description: string;
  methodology?: RecipeMethodologyV1;
  metadata?: RecipeMetadata;
  editorLayout?: { nodePositions: Record<string, { x: number; y: number }> };
  definition: WorkflowDefinitionV1;
  nodeBindings?: RecipeNodeBindings[];
}

export interface LegacyRoom {
  identity: string;
  roomId?: string;
  name: string;
  description?: string;
  active?: boolean;
}

export interface MigrationEntry {
  legacyIdentity: string;
  state: MigrationState;
  threadId?: string;
  receiptId?: string;
  error?: string;
}

export interface ProjectModelState {
  schema: 1;
  rootId: string;
  projects: ProjectRecord[];
  threads: ThreadRecord[];
  ganttTasks?: GanttTaskRecord[];
  collaborationTasks?: CollaborationTaskRecord[];
  recipes?: RecipeRecord[];
  recipeFolders?: string[];
  recipeTrash?: RecipeTrashRecord[];
  migrations: MigrationEntry[];
  audit: Array<{ event: string; entityId: string }>;
}

export interface ThreadMovePlan {
  threadId: string;
  destinationProjectId: string;
  linkedActiveRunIds: string[];
  includedRunIds: string[];
  audienceChanges: boolean;
  audienceChangeConfirmed: boolean;
}

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const RECIPE_FOLDER_MAX_PATH_LENGTH = 1024;
const RECIPE_FOLDER_MAX_SEGMENT_LENGTH = 255;

function normalizeRecipeFolderPath(value: string): string {
  const raw = String(value || "").trim();
  if (!raw || raw.length > RECIPE_FOLDER_MAX_PATH_LENGTH || raw.includes("\\") || raw.startsWith("/") || raw.endsWith("/") || raw.includes("//")) {
    throw new ProjectModelError("recipe-folder-path-invalid", "Recipe folder path is invalid.");
  }
  const segments = raw.split("/").map(segment => segment.trim());
  if (segments.some(segment => !segment || segment === "." || segment === ".." || segment === "(uncategorized)"
    || segment.length > RECIPE_FOLDER_MAX_SEGMENT_LENGTH || /[\u0000-\u001f\u007f]/.test(segment))) {
    throw new ProjectModelError("recipe-folder-path-invalid", "Recipe folder path is invalid.");
  }
  return segments.join("/");
}

function normalizedRecipeFolders(folders: string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const folder of folders || []) {
    const segments = normalizeRecipeFolderPath(folder).split("/");
    for (let depth = 1; depth <= segments.length; depth++) normalized.add(segments.slice(0, depth).join("/"));
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function recipeCategoryFolders(state: ProjectModelState): Set<string> {
  const folders = new Set(normalizedRecipeFolders(state.recipeFolders));
  for (const recipe of state.recipes || []) {
    if (recipe.scope !== "global") continue;
    const segments = String(recipe.category || "").split("/").map(segment => segment.trim()).filter(Boolean);
    for (let depth = 1; depth <= segments.length; depth++) folders.add(segments.slice(0, depth).join("/"));
  }
  return folders;
}

function promoteRecipeFolderPath(value: string | undefined, folder: string): string | undefined {
  const category = String(value || "").trim();
  if (category !== folder && !category.startsWith(`${folder}/`)) return value;
  const parent = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
  const suffix = category === folder ? "" : category.slice(folder.length + 1);
  return [parent, suffix].filter(Boolean).join("/") || undefined;
}

function normalizeRecipeMetadata(metadata: RecipeMetadata | undefined): RecipeMetadata {
  const normalizeFields = (fields: RecipeMetadataField[] | undefined, includeRequired: boolean): RecipeMetadataField[] => (fields || [])
    .map(field => ({
      name: String(field?.name || "").trim(),
      description: String(field?.description || "").trim(),
      ...(includeRequired ? { required: field?.required !== false } : {})
    }))
    .filter(field => field.name);
  return {
    applicableFunctions: [...new Set((metadata?.applicableFunctions || []).map(value => String(value).trim()).filter(Boolean))],
    solution: String(metadata?.solution || "").trim(),
    requiredInputs: normalizeFields(metadata?.requiredInputs, true),
    expectedOutputs: normalizeFields(metadata?.expectedOutputs, false)
  };
}

export class ProjectModelError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export function deriveSystemId(parentId: string, key: "pkm/default-project/v1" | "pkm/general-thread/v1"): string {
  const prefix = key.includes("default-project") ? "project_" : "thread_";
  return prefix + createHash("sha256").update(`${key}\0${parentId}`, "utf8").digest("hex").slice(0, 32);
}

export function initializeProjectModel(existing: Partial<ProjectModelState> | undefined, createId: () => string = randomUUID): ProjectModelState {
  if (!existing) return ensureBuiltInRecipes(ensureSystemEntities({ schema: 1, rootId: `root_${createId()}`, projects: [], threads: [], ganttTasks: [], collaborationTasks: [], recipes: [], recipeFolders: [], recipeTrash: [], migrations: [], audit: [] }));
  if (!existing.rootId) {
    if ((existing.projects?.length || 0) + (existing.threads?.length || 0) > 0) throw new ProjectModelError("root-identity-missing", "Root identity cannot be regenerated while child records exist.");
    return ensureBuiltInRecipes(ensureSystemEntities({ schema: 1, rootId: `root_${createId()}`, projects: [], threads: [], ganttTasks: [], collaborationTasks: [], recipes: existing.recipes || [], recipeFolders: normalizedRecipeFolders(existing.recipeFolders), recipeTrash: existing.recipeTrash || [], migrations: existing.migrations || [], audit: existing.audit || [] }));
  }
  const restored: ProjectModelState = {
    schema: 1,
    rootId: existing.rootId,
    projects: [...(existing.projects || [])],
    threads: [...(existing.threads || [])],
    ganttTasks: [...(existing.ganttTasks || [])],
    collaborationTasks: (existing.collaborationTasks || []).map(normalizeCollaborationTaskRecord),
    migrations: [...(existing.migrations || [])],
    audit: [...(existing.audit || [])]
  };
  if (existing.recipes) restored.recipes = [...existing.recipes];
  restored.recipeFolders = normalizedRecipeFolders(existing.recipeFolders);
  if (existing.recipeTrash) restored.recipeTrash = [...existing.recipeTrash];
  const initialized = ensureBuiltInRecipes(ensureSystemEntities(restored));
  validateThreadChatrooms(initialized);
  validateGanttTasks(initialized);
  return initialized;
}

const CONFIGURABLE_TESTING_MODULES = [
  ["model-contracts", "schema, model, typed value, compiler, and state-machine contracts"],
  ["integration", "integration boundaries and real persistence adapters"],
  ["ui", "real-browser UI interaction, accessibility, responsive states, and error presentation"],
  ["security", "trust boundaries, authorization, unsafe input, secrets, and abuse cases"],
  ["simulation", "deterministic multi-actor, state-transition, and failure-injection simulation"],
  ["migration", "legacy data, import/export, upgrade, downgrade refusal, and compatibility"],
  ["performance", "latency, throughput, scale, resource, and regression budgets"],
  ["recovery", "restart, interruption, fallback, rollback, and zero-loss recovery"],
  ["concurrency", "parallel clients, stale state, conflicts, idempotency, and replay"],
  ["subscriber-broker", "Subscriber, Broker, fork, provenance, cache, and offline behavior"],
  ["agent-collaboration", "handoff, terminology, convergence, ineffective communication, and approval"],
  ["full-e2e", "complete user journeys through real public surfaces and acceptance"]
] as const;

function configurableTestingModuleNodes(): unknown[] {
  return CONFIGURABLE_TESTING_MODULES.flatMap(([moduleId, scope]) => [
    {
      nodeId: `select-${moduleId}`, kind: NOOP_NODE_KIND, config: {},
      generalInstruction: `Decide whether the ${moduleId} module is required from the declared risk profile, assurance level, changed surfaces, environment matrix, historical failures, and non-downgradable invariants. Return include or skip with a machine-readable rationale; never skip a module required by the active safety profile.`,
      dependsOn: [{ from: "compile-test-matrix", fromOutput: "test-matrix", toInput: "test-matrix", accept: ["succeeded"], required: true }],
      ports: { inputs: ["test-matrix"], outputs: ["include", "skip"] },
      control: { mode: "branch", kind: "switch", cases: ["include", "skip"] }
    },
    {
      nodeId: `test-${moduleId}`, kind: NOOP_NODE_KIND, config: {},
      generalInstruction: `Execute the selected ${moduleId} testing module covering ${scope}. Produce reproducible evidence, observed failures, and explicit unverified boundaries; coverage percentages are supporting telemetry, not acceptance.`,
      dependsOn: [{ from: `select-${moduleId}`, fromOutput: "include", toInput: "selection", accept: ["include"], required: true }],
      ports: { inputs: ["selection"], outputs: ["evidence"] },
      control: { mode: "single" }
    }
  ]);
}

const BUILT_IN_RECIPES: ReadonlyArray<{
  key: string;
  revision?: number;
  name: string;
  category: string;
  description: string;
  applicableFunctions: string[];
  methodology?: RecipeMethodologyV1;
  definition: unknown;
}> = [
  {
    key: "universal-unknown-task",
    name: "Universal Unknown Task",
    category: "System/PKM/Fundamental",
    description: "Turn an ambiguous intent into a standardized Task Contract, resolve the appropriate Recipe family, and preserve unresolved terminology instead of guessing.",
    applicableFunctions: ["Unknown task", "Task clarification", "Recipe resolution", "Fallback"],
    methodology: {
      schema: RECIPE_METHODOLOGY_SCHEMA,
      family: "universal-unknown-task",
      phase: "clarify",
      abstract: false,
      mixins: [],
      capabilities: ["methodology-resolution", "objective-contract", "task-contract", "terminology-handshake"],
      artifacts: { inputs: ["intent"], outputs: ["problem-statement", "objective-contract", "task-contract"] },
      gates: ["clarification-gate", "objective-gate"],
      invariants: ["evidence-before-acceptance", "no-false-understanding", "no-silent-safety-weakening"],
      expansion: {
        mode: "adaptive",
        signals: ["ambiguity", "risk", "rework-cost", "missing-shared-context", "terminology-mismatch", "user-request"]
      },
      communication: {
        minimumAssurance: "direct",
        escalateOn: ["risk", "irreversibility", "destructive-scope", "cross-agent-handoff", "terminology-mismatch", "user-request"]
      },
      retrieval: {
        intents: ["clarify an unknown task", "find a fallback recipe", "turn a vague request into a task contract"],
        terminology: ["intent", "problem statement", "objective contract", "task contract", "terminology handshake"],
        operationalPoints: ["task definition", "recipe family resolution", "communication assurance"]
      }
    },
    definition: linearRecipeDefinition([
      ["capture-intent", "Capture the user's intent without silently strengthening, narrowing, or reinterpreting it. Preserve exact unknown, ambiguous, conflicting, and assumed terminology."],
      ["clarify-problem", "Resolve decision-relevant terminology and produce a Problem Statement with included scope, excluded scope, stakeholders, known facts, assumptions, and unresolved questions."],
      ["define-objective", "Produce an Objective Contract with primary and secondary metrics, operating regime, hard constraints, success thresholds, non-goals, and decision ownership."],
      ["establish-task-contract", "Produce a standardized Task Contract covering inputs, outputs, boundaries, expected artifacts, required evidence, acceptance criteria, risk class, and communication assurance."],
      ["resolve-recipe-family", "Search for a qualified Recipe using the complete Task Contract. Select an exact Recipe, a task-family fallback, or retain this universal fallback; do not force a weak match."],
      ["confirm-understanding", "Apply the communication assurance policy. For confirmed read-back or high-assurance work, present the structured understanding to its owner and report failure unless the current receipt is explicitly approved."]
    ])
  },
  {
    key: "closed-loop-communication",
    name: "Conditional Closed-Loop Communication",
    category: "System/PKM/Fundamental",
    description: "Select a communication assurance mode and require structured acknowledgement or approved read-back when ambiguity, risk, cost, or handoff boundaries justify it.",
    applicableFunctions: ["Task clarification", "Agent handoff", "High-risk operation", "Design approval", "Acceptance"],
    methodology: {
      schema: RECIPE_METHODOLOGY_SCHEMA,
      family: "closed-loop-communication",
      phase: "clarify",
      abstract: false,
      mixins: [],
      capabilities: ["communication-assurance", "terminology-handshake", "understanding-receipt"],
      artifacts: { inputs: ["intent", "task-contract"], outputs: ["terminology-ledger", "understanding-receipt"] },
      gates: ["clarification-gate", "understanding-approval-gate"],
      invariants: ["no-false-understanding", "version-bound-approval"],
      expansion: {
        mode: "adaptive",
        signals: [
          "ambiguity", "risk", "irreversibility", "destructive-scope", "execution-cost",
          "rework-cost", "cross-agent-handoff", "missing-shared-context", "terminology-mismatch", "user-request"
        ]
      },
      communication: {
        minimumAssurance: "direct",
        escalateOn: [
          "ambiguity", "risk", "irreversibility", "destructive-scope", "rework-cost",
          "cross-agent-handoff", "terminology-mismatch", "user-request"
        ]
      },
      retrieval: {
        intents: ["confirm shared understanding", "require read-back", "validate an agent handoff"],
        terminology: ["closed-loop communication", "read-back", "understanding receipt", "communication assurance"],
        operationalPoints: ["sender intent", "receiver interpretation", "approval", "context version"]
      }
    },
    definition: {
      schema: WORKFLOW_DEFINITION_SCHEMA,
      spec: {
        inputs: {},
        nodes: [
          {
            nodeId: "assess-assurance", kind: NOOP_NODE_KIND, config: {}, dependsOn: [],
            generalInstruction: "Select the minimum sufficient communication assurance mode from direct, structured-acknowledgement, confirmed-read-back, or high-assurance-contract using ambiguity, risk, irreversibility, destructive scope, cost, handoff boundaries, terminology mismatch, and explicit user requirements.",
            ports: { inputs: ["task-contract"], outputs: ["direct", "structured-acknowledgement", "confirmed-read-back", "high-assurance-contract"] },
            control: { mode: "branch", kind: "switch", cases: ["direct", "structured-acknowledgement", "confirmed-read-back", "high-assurance-contract"] }
          },
          {
            nodeId: "direct", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Resolve any concrete unknown or ambiguous terminology, record the selected direct mode, and release the dependent work without a full read-back.",
            dependsOn: [{ from: "assess-assurance", fromOutput: "direct", toInput: "mode", accept: ["direct"], required: true }]
          },
          {
            nodeId: "structured-acknowledgement", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Produce a concise structured acknowledgement of objective, scope, constraints, expected outputs, assumptions, unresolved terms, and next action. Report failure if a material mismatch remains.",
            dependsOn: [{ from: "assess-assurance", fromOutput: "structured-acknowledgement", toInput: "mode", accept: ["structured-acknowledgement"], required: true }]
          },
          {
            nodeId: "confirmed-read-back", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Construct a version-bound Understanding Receipt, read it back to the information owner, and obtain explicit approval. Report failure rather than success when approval is missing, corrected, rejected, stale, or bound to a different task/context version.",
            dependsOn: [{ from: "assess-assurance", fromOutput: "confirmed-read-back", toInput: "mode", accept: ["confirmed-read-back"], required: true }]
          },
          {
            nodeId: "high-assurance-contract", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Resolve critical terminology and construct a detailed Understanding Receipt covering objective, scope, non-goals, risks, rollback, evidence, acceptance, and ownership. Obtain explicit version-bound owner approval and any required independent review; report failure unless every required approval is current.",
            dependsOn: [{ from: "assess-assurance", fromOutput: "high-assurance-contract", toInput: "mode", accept: ["high-assurance-contract"], required: true }]
          }
        ],
        outputs: {},
        completion: { requiredNodes: ["direct", "structured-acknowledgement", "confirmed-read-back", "high-assurance-contract"] }
      }
    }
  },
  {
    key: "configurable-validation-and-testing",
    name: "Configurable Validation and Testing",
    category: "System/PKM/Fundamental",
    description: "Compile a risk-based test matrix, run only applicable testing modules, and independently reject missing evidence or illegal skips. Coverage alone is never acceptance.",
    applicableFunctions: ["Testing", "Validation", "Release qualification", "Regression prevention", "Safety verification"],
    methodology: {
      schema: RECIPE_METHODOLOGY_SCHEMA,
      family: "validation-and-testing",
      phase: "validate",
      abstract: false,
      mixins: [],
      capabilities: ["adaptive-test-selection", "behavior-first-validation", "independent-acceptance", "risk-based-assurance"],
      artifacts: { inputs: ["task-contract", "execution-plan", "artifact"], outputs: ["test-matrix", "evidence-bundle", "acceptance-decision"] },
      gates: ["test-matrix-gate", "independent-acceptance-gate"],
      invariants: [
        "coverage-is-not-acceptance", "evidence-before-acceptance", "illegal-skip-fails-acceptance",
        "safety-profile-minimums-cannot-be-downgraded"
      ],
      expansion: {
        mode: "adaptive",
        signals: [
          "ambiguity", "risk", "irreversibility", "destructive-scope", "execution-cost",
          "rework-cost", "cross-agent-handoff", "missing-shared-context", "user-request"
        ]
      },
      communication: {
        minimumAssurance: "structured-acknowledgement",
        escalateOn: ["risk", "irreversibility", "destructive-scope", "cross-agent-handoff", "user-request"]
      },
      retrieval: {
        intents: ["validate a feature end to end", "build a risk based test plan", "test a high risk file operation"],
        terminology: ["test matrix", "assurance level", "illegal skip", "independent acceptance", "behavior-first testing"],
        operationalPoints: [
          "model contracts", "integration", "ui", "security", "simulation", "migration", "performance",
          "recovery", "concurrency", "subscriber broker", "agent collaboration", "full e2e"
        ]
      }
    },
    definition: {
      schema: WORKFLOW_DEFINITION_SCHEMA,
      spec: {
        inputs: {
          taskContract: { type: "artifact", required: true, nullable: false, schema: {} },
          riskProfile: { type: "string", required: true, nullable: false, schema: {} },
          assuranceLevel: { type: "string", required: true, nullable: false, schema: {} },
          changedSurfaces: {
            type: "array", required: true, nullable: false,
            schema: { items: { type: "string", required: true, nullable: false, schema: {} }, minItems: 1 }
          },
          requestedModules: {
            type: "array", required: false, nullable: false, default: [],
            schema: { items: { type: "string", required: true, nullable: false, schema: {} } }
          },
          environments: {
            type: "array", required: false, nullable: false, default: [],
            schema: { items: { type: "string", required: true, nullable: false, schema: {} } }
          },
          recoveryRequired: { type: "boolean", required: false, nullable: false, default: false, schema: {} },
          timeBudgetMinutes: { type: "int64", required: false, nullable: false, default: "60", schema: {} },
          maxRetries: { type: "int64", required: false, nullable: false, default: "0", schema: {} }
        },
        nodes: [
          {
            nodeId: "compile-test-matrix", kind: NOOP_NODE_KIND, config: {}, dependsOn: [],
            generalInstruction: "Compile a versioned Test Matrix from the typed configuration. For every available module, record required, selected, skipped, or blocked with applicability evidence. File-safety profiles must require recovery, zero-loss, concurrency, failure injection, and full E2E; external-input or authorization surfaces must require security; multi-Agent workflows must require simulation and collaboration convergence.",
            ports: { inputs: ["taskContract", "riskProfile", "assuranceLevel", "changedSurfaces", "requestedModules", "environments", "recoveryRequired", "timeBudgetMinutes", "maxRetries"], outputs: ["test-matrix"] },
            control: { mode: "single" }
          },
          ...configurableTestingModuleNodes(),
          {
            nodeId: "independent-acceptance", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Independently compare the Test Matrix, module selection receipts, and Evidence Bundle against the active safety profile and acceptance policy. Fail when required modules were skipped, evidence is missing or non-reproducible, recovery or zero-loss claims are unproven, browser behavior was replaced by static inspection, or only code coverage supports success.",
            dependsOn: CONFIGURABLE_TESTING_MODULES.map(([moduleId]) => ({
              from: `test-${moduleId}`, fromOutput: "evidence", toInput: `${moduleId}-evidence`,
              accept: ["succeeded", "skipped"], required: true
            })),
            ports: { inputs: CONFIGURABLE_TESTING_MODULES.map(([moduleId]) => `${moduleId}-evidence`), outputs: ["acceptance-decision", "evidence-bundle"] },
            control: { mode: "single" }
          }
        ],
        outputs: {},
        completion: { requiredNodes: ["independent-acceptance"] }
      }
    }
  },
  {
    key: "software-development",
    name: "Software Development",
    category: "Software Development",
    description: "Develop a software change from clarified requirements through implementation, validation, and delivery.",
    applicableFunctions: ["Software Development"],
    definition: linearRecipeDefinition([
      ["understand", "Clarify the requested software outcome, users, constraints, affected behavior, and acceptance evidence. Inspect the relevant code and current behavior before proposing a solution; resolve material ambiguity instead of guessing."],
      ["plan", "Translate the clarified outcome into the smallest coherent implementation plan. Identify the owning code paths, behavioral contracts, risks, and focused checks that can falsify the proposed change."],
      ["implement", "Implement the planned change at the owning abstraction, following repository conventions and preserving unrelated behavior. Keep the change focused, and update supporting contracts or documentation only where the behavior requires it."],
      ["validate", "Run the cheapest behavior-focused checks first, then the relevant tests, type checks, or build. Investigate failures rather than weakening assertions, and distinguish defects caused by this change from unrelated repository failures."],
      ["deliver", "Review the final diff for scope and correctness, summarize the implemented behavior and validation evidence, and clearly report any remaining limitation or follow-up without claiming unverified success."]
    ])
  },
  {
    key: "bug-fix",
    name: "Bug Fix",
    category: "Software Development",
    description: "Reproduce a defect, identify its root cause, implement a focused fix, and verify against regressions.",
    applicableFunctions: ["Software Development", "Debugging"],
    definition: linearRecipeDefinition([
      ["reproduce", "Establish a minimal, deterministic reproduction of the reported defect. Record the triggering inputs, observed result, expected result, environment, and the narrowest executable check that demonstrates the failure."],
      ["investigate", "Trace the reproduced failure to the code that directly controls the behavior. Use runtime evidence, diagnostics, nearby contracts, and history as needed to identify a falsifiable root-cause hypothesis."],
      ["fix", "Correct the root cause with the smallest change that restores the intended contract. Preserve adjacent behavior, avoid masking errors, and add or adjust focused coverage for the failing case."],
      ["regression-check", "Run the original reproduction and focused regression test, followed by relevant neighboring tests or build checks. Confirm both that the defect is fixed and that the changed contract did not break supported cases."],
      ["report", "Summarize the root cause, corrective change, and concrete validation evidence. Call out residual risk, unrelated failures, or scenarios that remain unverified."]
    ])
  },
  {
    key: "ui-development",
    name: "UI Development",
    category: "Software Development",
    description: "Turn a user experience goal into an implemented, accessible, responsive, and reviewed interface.",
    applicableFunctions: ["Software Development", "UI Development"],
    definition: linearRecipeDefinition([
      ["understand-ux", "Define the user's workflow, information hierarchy, interaction states, target viewports, accessibility needs, and existing design-system constraints. Inspect the current interface before choosing a visual direction."],
      ["prototype", "Design the smallest complete interaction model before implementation. Specify layout, responsive behavior, controls, empty/loading/error states, keyboard behavior, and the visual relationships that must remain stable."],
      ["implement-ui", "Implement the approved interaction using the product's existing components, tokens, icons, and state patterns. Keep controls functional, responsive, accessible, and connected to real data rather than decorative placeholders."],
      ["validate-ui", "Exercise the interface at representative desktop and mobile sizes. Verify primary actions, keyboard access, focus, loading and empty states, text fit, non-overlap, and browser console output; capture screenshots when visual evidence is useful."],
      ["review", "Compare the result against the requested workflow and established visual language. Resolve usability or consistency issues, then summarize the final behavior and validation evidence with any remaining accessibility or viewport risk."]
    ])
  },
  {
    key: "reflection",
    name: "Reflection",
    category: "Learning & Improvement",
    description: "Reflect on completed work, identify reusable learning, and maintain the relevant PKM Skills with evidence.",
    applicableFunctions: ["Task completion", "Retrospective", "Skill maintenance", "Continual learning"],
    definition: {
      schema: WORKFLOW_DEFINITION_SCHEMA,
      spec: {
        inputs: {},
        nodes: [
          {
            nodeId: "reflect-on-outcome", kind: NOOP_NODE_KIND, config: {}, dependsOn: [],
            generalInstruction: "Review the completed task, its validation evidence, surprises, mistakes, and decisions. Separate one-off task state from lessons that are reusable across future work.",
            ports: { inputs: ["task-result"], outputs: ["reflection"] }, control: { mode: "single" }
          },
          {
            nodeId: "find-related-skills", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Use PKM skill_context with the task, workspace, changed files, and diagnostics to find the smallest relevant Skill set. Load only selected Skills and retain each skill_id, content_hash, and interaction_id.",
            dependsOn: [{ from: "reflect-on-outcome", fromOutput: "reflection", toInput: "reflection", accept: ["succeeded"], required: true }],
            ports: { inputs: ["reflection"], outputs: ["related-skills"] }, control: { mode: "single" }
          },
          {
            nodeId: "maintain-skills", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Call skill_feedback for the Skills used and the verified outcome. Propose a Skill update only when the reflection reveals evidence-backed knowledge reusable across sessions; never store transient task state, secrets, or unsupported hypotheses as a Skill.",
            dependsOn: [{ from: "find-related-skills", fromOutput: "related-skills", toInput: "skills", accept: ["succeeded"], required: true }],
            ports: { inputs: ["skills"], outputs: ["maintenance-result"] }, control: { mode: "single" }
          }
        ],
        outputs: {},
        completion: { requiredNodes: ["maintain-skills"] }
      }
    }
  },
  {
    key: "evidence-based-recipe-evolution",
    name: "Evolve Recipes from Evidence",
    category: "Learning & Improvement",
    description: "Turn repeated, validated work into a reviewable Recipe update or design without promoting one-off or speculative orchestration.",
    applicableFunctions: ["Recipe authoring", "Recipe maintenance", "Workflow reflection", "Continual improvement"],
    definition: {
      schema: WORKFLOW_DEFINITION_SCHEMA,
      spec: {
        inputs: {},
        nodes: [
          {
            nodeId: "summarize-work-and-evidence", kind: NOOP_NODE_KIND, config: {}, dependsOn: [],
            generalInstruction: "Summarize the completed work, the concrete inputs and outputs, and validation evidence that demonstrates the outcome. Record observed repetition and friction separately from guesses, future ideas, or transient task state.",
            ports: { inputs: ["completed-work"], outputs: ["evidence-summary"] }, control: { mode: "single" }
          },
          {
            nodeId: "search-recipe-library", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Search Recipe Library with recipe_search before proposing any Recipe. Compare candidates by purpose, stable inputs and outputs, constraints, and graph shape rather than name alone; exclude this Recipe and other orchestration Recipes from candidates to avoid recursive orchestration.",
            dependsOn: [{ from: "summarize-work-and-evidence", fromOutput: "evidence-summary", toInput: "evidence-summary", accept: ["succeeded"], required: true }],
            ports: { inputs: ["evidence-summary"], outputs: ["library-assessment"] }, control: { mode: "single" }
          },
          {
            nodeId: "assess-reusable-pattern", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Reject Recipe creation for one-off, unstable, speculative, weakly evidenced, or recursively orchestrated patterns. Require demonstrated recurrence, stable and reusable inputs and outputs, a bounded workflow, and validation evidence. Prefer updating or extending the closest qualified existing Recipe when it can own the learning without distorting its purpose.",
            dependsOn: [{ from: "search-recipe-library", fromOutput: "library-assessment", toInput: "library-assessment", accept: ["succeeded"], required: true }],
            ports: { inputs: ["library-assessment"], outputs: ["reuse-decision"] }, control: { mode: "single" }
          },
          {
            nodeId: "propose-reviewable-change", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Produce a reviewable update or extension proposal for the closest existing Recipe when one qualifies. Only when no close Recipe qualifies and recurrence, stable inputs and outputs, bounded steps, and evidence all justify a new reusable workflow, produce a reviewable new Recipe design or create action; otherwise explicitly return no Recipe change and preserve the evidence for future reflection.",
            dependsOn: [{ from: "assess-reusable-pattern", fromOutput: "reuse-decision", toInput: "reuse-decision", accept: ["succeeded"], required: true }],
            ports: { inputs: ["reuse-decision"], outputs: ["recipe-change-proposal"] }, control: { mode: "single" }
          }
        ],
        outputs: {},
        completion: { requiredNodes: ["propose-reviewable-change"] }
      }
    }
  },
  {
    key: "use-recipe-library",
    name: "Use Recipe Library",
    category: "System/PKM",
    description: "Discover, qualify, pin, execute, validate, and reflect on a reusable Recipe Library workflow without forcing a weak match.",
    applicableFunctions: ["Recipe discovery", "Workflow execution", "Agent onboarding", "Task orchestration"],
    definition: {
      schema: WORKFLOW_DEFINITION_SCHEMA,
      spec: {
        inputs: {},
        nodes: [
          {
            nodeId: "establish-task-contract", kind: NOOP_NODE_KIND, config: {}, dependsOn: [],
            generalInstruction: "Describe the requested outcome, constraints, inputs, expected outputs, Project scope, and validation evidence as a task contract. Decide whether the work is a reusable pattern or a concrete one-off instance; do not turn a live backlog or one-off plan into a Library Recipe.",
            ports: { inputs: ["task"], outputs: ["task-contract"] }, control: { mode: "single" }
          },
          {
            nodeId: "search-and-qualify", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Call recipe_search with the task contract and relevant category or Project. Evaluate candidate metadata and definition against the contract; never select by name alone, never force a weak match, and exclude Use Recipe Library itself unless the task is explicitly about Recipe orchestration. If no Recipe qualifies, use an ad hoc task for concrete work or design a reusable Recipe only when repeated use is justified.",
            dependsOn: [{ from: "establish-task-contract", fromOutput: "task-contract", toInput: "task-contract", accept: ["succeeded"], required: true }],
            ports: { inputs: ["task-contract"], outputs: ["qualified-recipe"] }, control: { mode: "single" }
          },
          {
            nodeId: "start-pinned-run", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "For a qualified Library candidate, call recipe_run_start with its recipe_id plus expected_revision and expected_digest from recipe_search. Pass only task inputs, not transient secrets. For concrete work without a qualifying template, call recipe_run_start_adhoc so the instance remains outside Recipe Library.",
            dependsOn: [{ from: "search-and-qualify", fromOutput: "qualified-recipe", toInput: "qualified-recipe", accept: ["succeeded"], required: true }],
            ports: { inputs: ["qualified-recipe"], outputs: ["run"] }, control: { mode: "single" }
          },
          {
            nodeId: "execute-and-report", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Repeat recipe_run_next and execute exactly the claimed node. After focused validation, call recipe_run_report with succeeded or failed plus structured result evidence. Never report unverified work as succeeded. Continue until the run returns next_action none; preserve child runs, checkpoints, and failures in the Agent Session.",
            dependsOn: [{ from: "start-pinned-run", fromOutput: "run", toInput: "run", accept: ["succeeded"], required: true }],
            ports: { inputs: ["run"], outputs: ["run-result"] }, control: { mode: "single" }
          },
          {
            nodeId: "validate-and-reflect", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Validate the overall requested outcome, not only node completion. Then run the Reflection Recipe with the task result and evidence to record what worked, Recipe friction, relevant Skill feedback, and only evidence-backed Skill update proposals.",
            dependsOn: [{ from: "execute-and-report", fromOutput: "run-result", toInput: "run-result", accept: ["succeeded"], required: true }],
            ports: { inputs: ["run-result"], outputs: ["validated-result"] }, control: { mode: "single" }
          }
        ],
        outputs: {},
        completion: { requiredNodes: ["validate-and-reflect"] }
      }
    }
  },
  {
    key: "publish-personal-knowledge-vsix",
    name: "Publish Personal Knowledge VSIX",
    category: "Release/VS Code",
    description: "Prepare, validate, package, approve, and publish the Personal Knowledge VSIX from a dedicated release branch through the canonical GitHub Actions workflow.",
    applicableFunctions: ["VSIX packaging", "VS Code extension release", "Marketplace publishing", "Pre-release promotion"],
    definition: {
      schema: WORKFLOW_DEFINITION_SCHEMA,
      spec: {
        inputs: {},
        nodes: [
          {
            nodeId: "create-release-branch", kind: NOOP_NODE_KIND, config: {}, dependsOn: [],
            generalInstruction: "Before any release mutation, fetch origin and verify main is synchronized and free of unrelated changes. Create and switch to a dedicated release/<version> branch from that main commit. If uncommitted release work already exists on main, create the release branch in place without stash, reset, or data loss. Record the branch name and base SHA.",
            ports: { inputs: ["release-request"], outputs: ["release-branch"] }, control: { mode: "single" }
          },
          {
            nodeId: "define-release-contract", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Confirm the exact source commit, package version, publisher Uone, extension personal-knowledge, stable or pre-release channel, canonical publication workflow, expected user impact, and required soak coverage. Starting this Recipe does not authorize a Marketplace mutation.",
            dependsOn: [{ from: "create-release-branch", accept: ["succeeded"], required: true }],
            ports: { inputs: ["release-branch"], outputs: ["release-contract"] }, control: { mode: "single" }
          },
          {
            nodeId: "validate-and-package", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Verify package.json, package-lock.json, and CHANGELOG.md agree on the target version. Audit the release diff, run npm run test:release and git diff --check, package the exact source locally, run scripts/verify-vsix-package.js, force-install the artifact, and complete the required clean-install, upgrade, stale/offline, and reload soak. Preserve the artifact SHA-256 and validation output; do not publish.",
            dependsOn: [{ from: "define-release-contract", accept: ["succeeded"], required: true }],
            ports: { inputs: ["release-contract"], outputs: ["verified-artifact"] }, control: { mode: "single" }
          },
          {
            nodeId: "commit-push-and-merge", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "On the dedicated release branch, stage only audited release files, commit the exact tested source, and push the branch. Merge it into synchronized main using the repository convention, push main without force or history rewrites, and verify origin/main contains the release commit. Record the immutable branch and main SHAs. Do not publish from this Module.",
            dependsOn: [{ from: "validate-and-package", accept: ["succeeded"], required: true }],
            ports: { inputs: ["verified-artifact"], outputs: ["merged-release-source"] }, control: { mode: "single" }
          },
          {
            nodeId: "ask-user-input", kind: HUMAN_GATE_NODE_KIND,
            config: { prompt: "Approve publishing the verified Uone.personal-knowledge version and channel from the recorded origin/main commit through .github/workflows/publish-marketplace.yml?", inputKind: "approval" },
            generalInstruction: "Reusable ask-user-input Module: present the publisher, extension, version, channel, origin/main commit, artifact digest, publication workflow, and expected user impact, then wait for explicit current user approval. Human Gate completion must come from submitted user input and cannot be replaced by an Agent report. Earlier approval, Recipe start, packaging, installation, commit, push, merge, tag, or GitHub Release does not authorize Marketplace publication.",
            dependsOn: [{ from: "commit-push-and-merge", accept: ["succeeded"], required: true }],
            ports: { inputs: ["merged-release-source"], outputs: ["approved", "rejected"] }, control: { mode: "single" }
          },
          {
            nodeId: "dispatch-publish-workflow", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Only after the immediately preceding Human Gate approval, dispatch Publish VS Code Marketplace from the verified origin/main commit with mode publish and the exact approved version and channel. Confirm the workflow head SHA equals the approved main SHA. Use GitHub Actions OIDC and vsce --azure-credential through the canonical workflow; never introduce a PAT, client secret, local Azure login, or Device Code Flow credential.",
            dependsOn: [{ from: "ask-user-input", fromOutput: "approved", toInput: "approval", accept: ["succeeded"], required: true }],
            ports: { inputs: ["approval"], outputs: ["workflow-run"] }, control: { mode: "single" }
          },
          {
            nodeId: "verify-and-report-release", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Verify the workflow build, tests, package boundary check, publisher permission check, and publish step succeeded. Confirm the exact version and channel on the Uone.personal-knowledge Marketplace listing, allowing for validation delay. Report branch, commits, artifact digest, workflow run, Marketplace evidence, and user impact. A retry, promotion, unpublish, deprecation, removal, or availability change is a new mutation requiring renewed explicit approval.",
            dependsOn: [{ from: "dispatch-publish-workflow", accept: ["succeeded"], required: true }],
            ports: { inputs: ["workflow-run"], outputs: ["release-result"] }, control: { mode: "single" }
          }
        ],
        outputs: {},
        completion: { requiredNodes: ["verify-and-report-release"] }
      }
    }
  },
  {
    key: "executable-module-examples",
    name: "Executable Module Examples",
    category: "Examples/Modules",
    description: "Runnable examples of Background command, Bash, Python, and required user input Modules with safe configurations and agent-readable guidance.",
    applicableFunctions: ["Recipe authoring", "Module examples", "Python automation", "Bash automation"],
    definition: {
      schema: WORKFLOW_DEFINITION_SCHEMA,
      spec: {
        inputs: {},
        nodes: [
          {
            nodeId: "run-background-command", kind: COMMAND_NODE_KIND,
            config: { program:"node", args:["--version"], timeoutSeconds:30, maxOutputBytes:8192 },
            generalInstruction: "Example: run a subprocess without a shell. Prefer this Module when a program and its arguments can be passed directly. Replace node --version with the required executable and argument list; never concatenate untrusted input into a shell command.",
            dependsOn: [], ports: { inputs:["parameters"], outputs:["result"] }, control: { mode:"single" }
          },
          {
            nodeId: "run-bash-script", kind: SCRIPT_NODE_KIND,
            config: { runtime:"bash", script:"set -euo pipefail\nprintf 'platform=%s\\n' \"$(uname -s)\"\nprintf 'working_directory=%s\\n' \"$PWD\"\n", timeoutSeconds:30, maxOutputBytes:8192 },
            generalInstruction: "Example: run a short Bash script on Linux or macOS. Keep set -euo pipefail, quote paths and variables, use a bounded timeout, and emit concise evidence for the next Module.",
            dependsOn: [{ from:"run-background-command", accept:["succeeded"], required:true }],
            ports: { inputs:["parameters"], outputs:["result"] }, control: { mode:"single" }
          },
          {
            nodeId: "run-python-script", kind: SCRIPT_NODE_KIND,
            config: { runtime:"python", environmentId:"analysis-env", script:"import json\nimport platform\nprint(json.dumps({'python': platform.python_version(), 'platform': platform.platform()}))\n", timeoutSeconds:30, maxOutputBytes:8192 },
            generalInstruction: "Example: run Python with an explicit PKM Environment. Before execution, select or create a real Environment and replace analysis-env with its stable ID. Keep the script deterministic and return machine-readable JSON when another Module will consume the result.",
            dependsOn: [{ from:"run-bash-script", accept:["succeeded"], required:true }],
            ports: { inputs:["parameters"], outputs:["result"] }, control: { mode:"single" }
          },
          {
            nodeId: "review-executable-output", kind: HUMAN_GATE_NODE_KIND,
            config: { prompt:"Review the command, Bash, and Python example evidence. What should be adjusted before reuse?", inputKind:"text" },
            generalInstruction: "Example: pause the Recipe for required human text input. Use a Human Gate when execution must not continue from an Agent report alone, and write a prompt that makes the required decision or evidence explicit.",
            dependsOn: [{ from:"run-python-script", accept:["succeeded"], required:true }],
            ports: { inputs:["request"], outputs:["response"] }, control: { mode:"single" }
          }
        ],
        outputs: {},
        completion: { requiredNodes:["review-executable-output"] }
      }
    }
  },
  {
    key: "control-module-examples",
    name: "Branch and Repeat Module Examples",
    category: "Examples/Modules",
    description: "Agent-readable examples of ordinary, branch, repeat, and required user input control Modules.",
    applicableFunctions: ["Recipe authoring", "Branching", "Bounded repetition", "Human approval"],
    definition: {
      schema: WORKFLOW_DEFINITION_SCHEMA,
      spec: {
        inputs: {},
        nodes: [
          {
            nodeId:"request-strategy", kind:HUMAN_GATE_NODE_KIND,
            config:{ prompt:"Choose the example strategy.", inputKind:"choice", choices:["fast","thorough"] },
            generalInstruction:"Example: require an explicit user choice before selecting a branch. Human Gate completion must come from submitted user input, never from an ordinary Agent report.",
            dependsOn:[], ports:{ inputs:["request"], outputs:["fast","thorough"] }, control:{ mode:"single" }
          },
          {
            nodeId:"select-strategy", kind:NOOP_NODE_KIND, config:{},
            generalInstruction:"Example: evaluate the submitted choice and return exactly one declared branch outcome. Use If / Else for a boolean decision or Switch for named cases such as fast and thorough.",
            dependsOn:[{ from:"request-strategy", accept:["succeeded"], required:true }],
            ports:{ inputs:["choice"], outputs:["fast","thorough"] }, control:{ mode:"branch", kind:"switch", cases:["fast","thorough"] }
          },
          {
            nodeId:"repeat-bounded-check", kind:NOOP_NODE_KIND, config:{},
            generalInstruction:"Example: repeat the same evidence check exactly three times. Keep repetition bounded, report each iteration separately, and use dynamic xK only when the upstream collection determines a safe finite count.",
            dependsOn:[{ from:"select-strategy", fromOutput:"thorough", toInput:"strategy", accept:["succeeded"], required:true }],
            ports:{ inputs:["strategy"], outputs:["check-result"] }, control:{ mode:"repeat", count:{ kind:"fixed", value:3 } }
          },
          {
            nodeId:"summarize-control-flow", kind:NOOP_NODE_KIND, config:{},
            generalInstruction:"Example: ordinary single-execution Module that combines the chosen branch and bounded repeat evidence into one final result without adding another control structure.",
            dependsOn:[{ from:"repeat-bounded-check", accept:["succeeded"], required:true }],
            ports:{ inputs:["check-result"], outputs:["summary"] }, control:{ mode:"single" }
          }
        ],
        outputs:{},
        completion:{ requiredNodes:["summarize-control-flow"] }
      }
    }
  },
  {
    key: "dlis-offline-job-log-diagnosis-example",
    name: "DLIS Offline Job Log Diagnosis Example",
    category: "Examples/Diagnostics",
    description: "A safe example that combines Human Gate, command, Bash, Python, branch, and synthesis Modules to diagnose a sanitized offline job.log without claiming a live DLIS integration.",
    applicableFunctions: ["DLIS diagnostics", "Offline job log diagnosis", "Python analysis", "Bash log triage"],
    definition: {
      schema: WORKFLOW_DEFINITION_SCHEMA,
      spec: {
        inputs:{},
        nodes:[
          {
            nodeId:"confirm-sanitized-log", kind:HUMAN_GATE_NODE_KIND,
            config:{ prompt:"Confirm that a sanitized offline log is available as job.log in the Recipe working directory.", inputKind:"approval" },
            generalInstruction:"Require the user to confirm that the log is an authorized sanitized offline copy. This example does not download logs, access a live DLIS service, or handle credentials.",
            dependsOn:[], ports:{ inputs:["request"], outputs:["approved","rejected"] }, control:{ mode:"single" }
          },
          {
            nodeId:"verify-log-file", kind:COMMAND_NODE_KIND,
            config:{ program:"test", args:["-f","job.log"], timeoutSeconds:15, maxOutputBytes:4096 },
            generalInstruction:"Use a direct background command to verify that job.log exists. This Linux/macOS example passes arguments without a shell; replace it with a platform-appropriate executable when necessary.",
            dependsOn:[{ from:"confirm-sanitized-log", fromOutput:"approved", toInput:"approval", accept:["succeeded"], required:true }],
            ports:{ inputs:["approval"], outputs:["result"] }, control:{ mode:"single" }
          },
          {
            nodeId:"extract-log-signals", kind:SCRIPT_NODE_KIND,
            config:{ runtime:"bash", script:"set -euo pipefail\nprintf '%s\\n' '--- summary ---'\nwc -l job.log\nprintf '%s\\n' '--- recent diagnostic signals ---'\ngrep -Ein 'error|exception|timeout|out of memory|oom|failed|retry' job.log | tail -n 200 || true\n", timeoutSeconds:60, maxOutputBytes:65536 },
            generalInstruction:"Use Bash for bounded textual triage of the sanitized log. Quote file paths, cap output, preserve the original line numbers, and treat no grep matches as evidence rather than a script failure.",
            dependsOn:[{ from:"verify-log-file", accept:["succeeded"], required:true }],
            ports:{ inputs:["result"], outputs:["signals"] }, control:{ mode:"single" }
          },
          {
            nodeId:"classify-log-signals", kind:SCRIPT_NODE_KIND,
            config:{ runtime:"python", environmentId:"analysis-env", script:"import json, re\nfrom pathlib import Path\ntext = Path('job.log').read_text(errors='replace')\npatterns = {'timeout': r'timeout|timed out', 'capacity': r'out of memory|\\boom\\b|quota|capacity', 'configuration': r'invalid config|configuration|permission denied', 'failure': r'error|exception|failed'}\nprint(json.dumps({name: len(re.findall(pattern, text, re.I)) for name, pattern in patterns.items()}, sort_keys=True))\n", timeoutSeconds:60, maxOutputBytes:65536 },
            generalInstruction:"Use Python for deterministic signal classification and emit JSON counts. Replace analysis-env with a real PKM Environment before execution. Counts are leads for evidence review, not a final root-cause claim.",
            dependsOn:[{ from:"extract-log-signals", accept:["succeeded"], required:true }],
            ports:{ inputs:["signals"], outputs:["classification"] }, control:{ mode:"single" }
          },
          {
            nodeId:"assess-diagnosis", kind:NOOP_NODE_KIND, config:{},
            generalInstruction:"Compare Bash line evidence and Python counts, then return exactly one disposition: retryable, capacity, configuration, or unknown. Prefer unknown when evidence conflicts or does not establish causality.",
            dependsOn:[{ from:"classify-log-signals", accept:["succeeded"], required:true }],
            ports:{ inputs:["classification"], outputs:["retryable","capacity","configuration","unknown"] },
            control:{ mode:"branch", kind:"switch", cases:["retryable","capacity","configuration","unknown"] }
          },
          {
            nodeId:"report-diagnosis", kind:NOOP_NODE_KIND, config:{},
            generalInstruction:"Produce an evidence-first offline diagnosis with cited log line numbers, the chosen disposition, confidence, safe next checks, and explicit unknowns. Do not claim that the example contacted DLIS or changed the job.",
            dependsOn:[{ from:"assess-diagnosis", accept:["succeeded"], required:true }],
            ports:{ inputs:["diagnosis"], outputs:["report"] }, control:{ mode:"single" }
          }
        ],
        outputs:{},
        completion:{ requiredNodes:["report-diagnosis"] }
      }
    }
  },
  {
    key: "pkm-tutorial",
    name: "PKM Tutorial",
    category: "Examples/PKM",
    description: "Answer PKM usage questions by understanding the question, retrieving relevant system guidance, validating what is known, and synthesizing an honest answer.",
    applicableFunctions: ["PKM help", "PKM tutorial", "Usage question"],
    definition: {
      schema: WORKFLOW_DEFINITION_SCHEMA,
      spec: {
        inputs: {},
        nodes: [
          {
            nodeId: "understand-question", kind: NOOP_NODE_KIND, config: {}, dependsOn: [],
            generalInstruction: "Brief: determine what the user is trying to do in PKM. Clarify the requested outcome, affected PKM surface, constraints, and the exact uncertainty before searching for guidance.",
            ports: { inputs: ["question"], outputs: ["understood-question"] }, control: { mode: "single" }
          },
          {
            nodeId: "find-relevant-guidance", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Brief: find authoritative guidance for the understood question. Use the System/PKM/PKM Skills system Skill, select only relevant sections, follow every required instruction, and retain the Skill identity and content hash as evidence.",
            dependsOn: [{ from: "understand-question", fromOutput: "understood-question", toInput: "question", accept: ["succeeded"], required: true }],
            ports: { inputs: ["question"], outputs: ["guidance"] }, control: { mode: "single" }
          },
          {
            nodeId: "validate-guidance", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Brief: validate whether the retrieved guidance answers the question. Return disposition validated when directly supported, known when a reliable answer is known but the retrieved section is insufficient, or unknown when the answer cannot be established. Insufficient evidence is a valid result, not a node execution failure.",
            dependsOn: [{ from: "find-relevant-guidance", fromOutput: "guidance", toInput: "guidance", accept: ["succeeded"], required: true }],
            ports: { inputs: ["guidance"], outputs: ["validated", "known", "unknown"] },
            control: { mode: "branch", kind: "switch", cases: ["validated", "known", "unknown"] }
          },
          {
            nodeId: "synthesize-answer", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Brief: integrate the question, relevant PKM guidance, and validation disposition into the final answer. Cite the relevant guidance when validated, label unsupported knowledge honestly, and when disposition is unknown explicitly say that the answer is not known and identify the missing evidence or next safe lookup.",
            dependsOn: [{ from: "validate-guidance", accept: ["succeeded"], required: true }],
            ports: { inputs: ["validation"], outputs: ["answer"] }, control: { mode: "single" }
          }
        ],
        outputs: {},
        completion: { requiredNodes: ["synthesize-answer"] }
      }
    }
  }
] as const;

function builtInRecipeId(key: string): string {
  return `recipe_${createHash("sha256").update(`pkm/built-in-recipe/v1\0${key}`, "utf8").digest("hex").slice(0, 32)}`;
}

const RETIRED_BUILT_IN_RECIPE_KEYS: ReadonlyArray<string> = [];

function linearRecipeDefinition(steps: ReadonlyArray<readonly [nodeId: string, generalInstruction: string]>): unknown {
  return {
    schema: WORKFLOW_DEFINITION_SCHEMA,
    spec: {
      inputs: {},
      nodes: steps.map(([nodeId, generalInstruction], index) => ({
        nodeId,
        kind: NOOP_NODE_KIND,
        config: {},
        generalInstruction,
        dependsOn: index ? [{ from: steps[index - 1][0], accept: ["succeeded"], required: true }] : []
      })),
      outputs: {},
      completion: { requiredNodes: [steps[steps.length - 1][0]] }
    }
  };
}

function compileBuiltInRecipe(definition: unknown): { definition: WorkflowDefinitionV1; executableDigest: string } {
  const compiled = compileWorkflowDefinitionV1(definition);
  if (!compiled.ok) throw new ProjectModelError("recipe-template-invalid", "Built-in Recipe template did not compile.");
  return { definition: compiled.model, executableDigest: compiled.executableDigest };
}

function compileBuiltInMethodology(methodology: RecipeMethodologyV1 | undefined): {
  methodology?: RecipeMethodologyV1;
  methodologyDigest?: string;
} {
  if (!methodology) return {};
  const compiled = compileRecipeMethodologyV1(methodology);
  if (!compiled.ok) throw new ProjectModelError("recipe-methodology-invalid", "Built-in Recipe methodology did not compile.", { diagnostics: compiled.diagnostics });
  return { methodology: compiled.model, methodologyDigest: compiled.methodologyDigest };
}

export function ensureBuiltInRecipes(state: ProjectModelState): ProjectModelState {
  const retiredRecipeIds = new Set(RETIRED_BUILT_IN_RECIPE_KEYS.map(builtInRecipeId));
  const recipes = [...(state.recipes || [])].filter(recipe =>
    recipe.systemKind !== "built-in" || !retiredRecipeIds.has(recipe.recipeId));
  for (const descriptor of BUILT_IN_RECIPES) {
    const recipeId = builtInRecipeId(descriptor.key);
    const packagedRevision = descriptor.revision || 1;
    const existing = recipes.find(recipe => recipe.recipeId === recipeId);
    if (existing) {
      if (existing.systemKind !== "built-in") throw new ProjectModelError("system-recipe-conflict", "Built-in Recipe identity is conflicting.");
      if (existing.revision > packagedRevision) continue;
      const compiled = compileBuiltInRecipe(descriptor.definition);
      const methodology = compileBuiltInMethodology(descriptor.methodology);
      if (existing.executableDigest !== compiled.executableDigest
        || existing.methodologyDigest !== methodology.methodologyDigest) {
        const nodeIds = new Set(compiled.definition.spec.nodes.map(node => node.nodeId));
        const nodePositions = Object.fromEntries(Object.entries(existing.editorLayout?.nodePositions || {})
          .filter(([nodeId, position]) => nodeIds.has(nodeId) && Number.isFinite(position?.x) && Number.isFinite(position?.y)));
        const nodeBindings = normalizeRecipeNodeBindings(existing.nodeBindings || [], nodeIds);
        const upgraded: RecipeRecord = {
          ...existing,
          name: descriptor.name,
          category: descriptor.category,
          description: descriptor.description,
          metadata: {
            ...normalizeRecipeMetadata(existing.metadata),
            applicableFunctions: descriptor.applicableFunctions,
            solution: descriptor.description
          },
          ...methodology,
          definition: compiled.definition,
          executableDigest: compiled.executableDigest,
          revision: Math.max(existing.revision + 1, packagedRevision)
        };
        delete upgraded.editorLayout;
        delete upgraded.nodeBindings;
        if (Object.keys(nodePositions).length) upgraded.editorLayout = { nodePositions };
        if (nodeBindings.length) upgraded.nodeBindings = nodeBindings;
        recipes[recipes.indexOf(existing)] = upgraded;
      }
      continue;
    }
    const compiled = compileBuiltInRecipe(descriptor.definition);
    const methodology = compileBuiltInMethodology(descriptor.methodology);
    recipes.push({
      recipeId,
      scope: "global",
      category: descriptor.category,
      systemKind: "built-in",
      name: descriptor.name,
      description: descriptor.description,
      metadata: {
        applicableFunctions: descriptor.applicableFunctions,
        solution: descriptor.description,
        requiredInputs: [{ name: "task", description: "The requested outcome and its constraints.", required: true }],
        expectedOutputs: [{ name: "result", description: "The implemented or analyzed result with validation evidence." }]
      },
      ...methodology,
      definition: compiled.definition,
      executableDigest: compiled.executableDigest,
      revision: packagedRevision
    });
  }
  return { ...state, recipes };
}

export function ensureSystemEntities(state: ProjectModelState): ProjectModelState {
  const defaultProjectId = deriveSystemId(state.rootId, "pkm/default-project/v1");
  const markedProjects = state.projects.filter(project => project.systemKind === "default-project");
  if (markedProjects.length > 1 || (markedProjects[0] && markedProjects[0].projectId !== defaultProjectId)) {
    throw new ProjectModelError("system-project-conflict", "Default Project identity is conflicting or duplicated.");
  }
  let projects = state.projects;
  let audit = state.audit;
  if (!markedProjects.length) {
    projects = [...projects, { projectId: defaultProjectId, name: "Default Project", systemKind: "default-project", version: 1 }];
    audit = [...audit, { event: "system-project-repaired", entityId: defaultProjectId }];
  }
  const generalThreadId = deriveSystemId(defaultProjectId, "pkm/general-thread/v1");
  const markedThreads = state.threads.filter(thread => thread.systemKind === "general-thread" && thread.projectId === defaultProjectId);
  if (markedThreads.length > 1 || (markedThreads[0] && markedThreads[0].threadId !== generalThreadId)) {
    throw new ProjectModelError("system-thread-conflict", "General Thread identity is conflicting or duplicated.");
  }
  let threads = state.threads;
  if (!markedThreads.length) {
    threads = [...threads, { threadId: generalThreadId, projectId: defaultProjectId, name: "General", description: "", archived: false, systemKind: "general-thread", legacyAliases: [], version: 1 }];
    audit = [...audit, { event: "system-thread-repaired", entityId: generalThreadId }];
  }
  return { ...state, projects, threads, audit };
}

export function createProject(state: ProjectModelState, name: string, createId: () => string = randomUUID): ProjectModelState {
  const normalized = name.trim();
  if (!normalized) throw new ProjectModelError("project-name-required", "Project name is required.");
  const projectId = `project_${createId()}`;
  if (state.projects.some(project => project.projectId === projectId)) throw new ProjectModelError("identity-conflict", "Generated Project identity already exists.");
  const generalThreadId = deriveSystemId(projectId, "pkm/general-thread/v1");
  return {
    ...state,
    projects: [...state.projects, { projectId, name: normalized, version: 1 }],
    threads: [...state.threads, { threadId: generalThreadId, projectId, name: "General", description: "", archived: false, systemKind: "general-thread", legacyAliases: [], version: 1 }],
    audit: [...state.audit, { event: "project-created", entityId: projectId }, { event: "system-thread-created", entityId: generalThreadId }]
  };
}

export function createThread(state: ProjectModelState, projectId: string, name: string, createId: () => string = randomUUID): ProjectModelState {
  if (!state.projects.some(project => project.projectId === projectId)) throw new ProjectModelError("project-not-found", "Project does not exist.");
  const normalized = name.trim();
  if (!normalized) throw new ProjectModelError("thread-name-required", "Thread name is required.");
  const threadId = `thread_${createId()}`;
  if (state.threads.some(thread => thread.threadId === threadId)) throw new ProjectModelError("identity-conflict", "Generated Thread identity already exists.");
  return {
    ...state,
    threads: [...state.threads, { threadId, projectId, name: normalized, description: "", archived: false, legacyAliases: [], version: 1 }],
    audit: [...state.audit, { event: "thread-created", entityId: threadId }]
  };
}

export function renameThread(state: ProjectModelState, threadId: string, name: string): ProjectModelState {
  const thread = state.threads.find(candidate => candidate.threadId === threadId);
  if (!thread) throw new ProjectModelError("thread-not-found", "Thread does not exist.");
  if (thread.systemKind === "general-thread") throw new ProjectModelError("system-thread-rename-forbidden", "General Thread cannot be renamed.");
  const normalized = String(name || "").trim();
  if (!normalized) throw new ProjectModelError("thread-name-required", "Thread name is required.");
  if (normalized === thread.name) return state;
  return {
    ...state,
    threads: state.threads.map(candidate => candidate.threadId === threadId
      ? { ...candidate, name: normalized, version: candidate.version + 1 }
      : candidate),
    audit: [...state.audit, { event: "thread-renamed", entityId: threadId }]
  };
}

export function linkThreadChatroom(
  state: ProjectModelState,
  threadId: string,
  association: { roomId: string; roomName: string; linkedAt: string }
): ProjectModelState {
  const thread = state.threads.find(candidate => candidate.threadId === threadId);
  if (!thread) throw new ProjectModelError("thread-not-found", "Thread does not exist.");
  if (!ID_PATTERN.test(String(association.roomId || ""))) throw new ProjectModelError("chatroom-id-invalid", "Chatroom identity is invalid.");
  const roomName = String(association.roomName || "").trim();
  if (!roomName) throw new ProjectModelError("chatroom-name-required", "Chatroom name is required.");
  const linkedAt = normalizeTimestamp(association.linkedAt, "chatroom-linked-at-invalid");
  const owner = state.threads.find(candidate => candidate.threadId !== threadId && candidate.chatroom?.roomId === association.roomId);
  if (owner) throw new ProjectModelError("chatroom-already-linked", "Chatroom is already linked to another Thread.");
  const chatroom = { roomId: association.roomId, roomName, linkedAt };
  if (JSON.stringify(thread.chatroom) === JSON.stringify(chatroom)) return state;
  return {
    ...state,
    threads: state.threads.map(candidate => candidate.threadId === threadId
      ? { ...candidate, chatroom, version: candidate.version + 1 }
      : candidate),
    audit: [...state.audit, { event: "thread-chatroom-linked", entityId: threadId }]
  };
}

export function createGanttTask(
  state: ProjectModelState,
  projectId: string,
  input: GanttTaskInput,
  createId: () => string = randomUUID
): ProjectModelState {
  if (!state.projects.some(project => project.projectId === projectId)) throw new ProjectModelError("project-not-found", "Project does not exist.");
  const taskId = `task_${createId()}`;
  if ((state.ganttTasks || []).some(task => task.taskId === taskId)) throw new ProjectModelError("identity-conflict", "Generated Gantt task identity already exists.");
  const task = normalizeGanttTask({ ...input, owners: input.owners || [], dependencyIds: input.dependencyIds || [], taskId, projectId, version: 1 }, state);
  const next = { ...state, ganttTasks: [...(state.ganttTasks || []), task] };
  validateGanttTasks(next);
  return { ...next, audit: [...state.audit, { event: "gantt-task-created", entityId: taskId }] };
}

export function updateGanttTask(state: ProjectModelState, taskId: string, input: GanttTaskInput): ProjectModelState {
  const current = (state.ganttTasks || []).find(task => task.taskId === taskId);
  if (!current) throw new ProjectModelError("gantt-task-not-found", "Gantt task does not exist.");
  const updated = normalizeGanttTask({ ...input, owners: input.owners || [], dependencyIds: input.dependencyIds || [],
    taskId, projectId: current.projectId, version: current.version + 1 }, state);
  const next = {
    ...state,
    ganttTasks: (state.ganttTasks || []).map(task => task.taskId === taskId ? updated : task)
  };
  validateGanttTasks(next);
  return { ...next, audit: [...state.audit, { event: "gantt-task-updated", entityId: taskId }] };
}

export function createCollaborationTask(
  state: ProjectModelState,
  projectId: string,
  input: CollaborationTaskInput,
): ProjectModelState {
  if (!state.projects.some(project => project.projectId === projectId)) throw new ProjectModelError("project-not-found", "Project does not exist.");
  const thread = state.threads.find(candidate => candidate.threadId === input.threadId);
  if (!thread || thread.projectId !== projectId) throw new ProjectModelError("collaboration-thread-mismatch", "Collaboration Thread must belong to its Project.");
  if ((state.collaborationTasks || []).some(task => task.collaborationId === input.collaborationId)) {
    throw new ProjectModelError("collaboration-already-exists", "Collaboration identity already exists.");
  }
  if (input.ganttTaskId) {
    const gantt = (state.ganttTasks || []).find(task => task.taskId === input.ganttTaskId);
    if (!gantt || gantt.projectId !== projectId || (gantt.threadId && gantt.threadId !== input.threadId)) {
      throw new ProjectModelError("collaboration-gantt-mismatch", "Linked Gantt task must belong to the Collaboration Project and Thread.");
    }
  }
  try {
    const task = createStructuredCollaborationTask({ ...input, projectId });
    return {
      ...state,
      collaborationTasks: [...(state.collaborationTasks || []), task],
      audit: [...state.audit, { event: "collaboration-assigned", entityId: task.collaborationId }],
    };
  } catch (error) {
    if (error instanceof CollaborationError) throw new ProjectModelError(error.code, error.message);
    throw error;
  }
}

export function transitionCollaborationTask(
  state: ProjectModelState,
  transition: CollaborationTransition,
): ProjectModelState {
  const current = (state.collaborationTasks || []).find(task => task.collaborationId === transition.collaborationId);
  if (!current) throw new ProjectModelError("collaboration-not-found", "Collaboration does not exist.");
  try {
    const updated = transitionStructuredCollaborationTask(current, transition);
    if (updated.primaryOwner && updated.blockedWaitingOn.length) {
      const waits = new Map<string, string[]>();
      for (const task of state.collaborationTasks || []) {
        if (task.primaryOwner) waits.set(task.primaryOwner, task.collaborationId === updated.collaborationId ? updated.blockedWaitingOn : task.blockedWaitingOn || []);
      }
      waits.set(updated.primaryOwner, updated.blockedWaitingOn);
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const cyclic = (owner: string): boolean => {
        if (visiting.has(owner)) return true;
        if (visited.has(owner)) return false;
        visiting.add(owner);
        for (const dependency of waits.get(owner) || []) if (cyclic(dependency)) return true;
        visiting.delete(owner);
        visited.add(owner);
        return false;
      };
      if (cyclic(updated.primaryOwner)) {
        const cycleWarning = {
          code: "collaboration-dependency-cycle",
          message: "Mutual waiting/dependency cycle detected; reassign ownership or remove a waiting dependency.",
          at: new Date(transition.at).toISOString(),
        };
        updated.warnings = [...updated.warnings, cycleWarning];
        updated.convergenceState = "blocked";
        updated.history[updated.history.length - 1].warnings = [
          ...(updated.history[updated.history.length - 1].warnings || []),
          cycleWarning,
        ];
        updated.history[updated.history.length - 1].convergenceState = "blocked";
      }
    }
    let next: ProjectModelState = {
      ...state,
      collaborationTasks: (state.collaborationTasks || []).map(task =>
        task.collaborationId === updated.collaborationId ? updated : task),
      audit: [...state.audit, { event: `collaboration-${transition.action}`, entityId: updated.collaborationId }],
    };
    if (updated.ganttTaskId) {
      const gantt = (state.ganttTasks || []).find(task => task.taskId === updated.ganttTaskId);
      if (!gantt) throw new ProjectModelError("gantt-task-not-found", "Linked Gantt task does not exist.");
      if (transition.expectedGanttTaskVersion !== gantt.version) {
        throw new ProjectModelError("gantt-task-version-conflict", `Gantt task changed from version ${transition.expectedGanttTaskVersion ?? "unknown"} to ${gantt.version}. Refresh and retry.`);
      }
      const projection = collaborationGanttProjection(updated.status);
      next = updateGanttTask(next, gantt.taskId, {
        threadId: gantt.threadId,
        title: gantt.title,
        startDate: gantt.startDate,
        endDate: gantt.endDate,
        progress: projection.progress,
        status: projection.status,
        owners: gantt.owners,
        dependencyIds: gantt.dependencyIds,
      });
    }
    return next;
  } catch (error) {
    if (error instanceof CollaborationError) throw new ProjectModelError(error.code, error.message);
    throw error;
  }
}

export function deleteGanttTask(state: ProjectModelState, taskId: string): ProjectModelState {
  if (!(state.ganttTasks || []).some(task => task.taskId === taskId)) throw new ProjectModelError("gantt-task-not-found", "Gantt task does not exist.");
  const collaboration = (state.collaborationTasks || []).find(task => task.ganttTaskId === taskId && task.status !== "completed");
  if (collaboration) throw new ProjectModelError("gantt-task-collaboration-in-use", `Complete or unlink Collaboration ${collaboration.title} before deleting this Gantt task.`);
  const dependents = (state.ganttTasks || []).filter(task => task.dependencyIds.includes(taskId));
  if (dependents.length) {
    throw new ProjectModelError("gantt-task-dependency-in-use", `Remove dependencies from: ${dependents.map(task => task.title).join(", ")}`, {
      dependentTaskIds: dependents.map(task => task.taskId)
    });
  }
  return {
    ...state,
    ganttTasks: (state.ganttTasks || []).filter(task => task.taskId !== taskId),
    audit: [...state.audit, { event: "gantt-task-deleted", entityId: taskId }]
  };
}

export function createRecipe(state: ProjectModelState, scope: { kind: "global" } | { kind: "project"; projectId: string }, name: string, createId: () => string = randomUUID, category = ""): ProjectModelState {
  if (scope.kind === "project" && !state.projects.some(project => project.projectId === scope.projectId)) throw new ProjectModelError("project-not-found", "Project does not exist.");
  const normalized = name.trim();
  if (!normalized) throw new ProjectModelError("recipe-name-required", "Recipe name is required.");
  const recipeId = `recipe_${createId()}`;
  if ([...(state.recipes || []), ...(state.recipeTrash || [])].some(recipe => recipe.recipeId === recipeId)) throw new ProjectModelError("identity-conflict", "Generated Recipe identity already exists.");
  const compiled = compileWorkflowDefinitionV1({
    schema: WORKFLOW_DEFINITION_SCHEMA,
    spec: {
      inputs: {},
      nodes: [{ nodeId: "start", kind: NOOP_NODE_KIND, config: {}, dependsOn: [] }],
      outputs: {},
      completion: { requiredNodes: ["start"] }
    }
  });
  if (!compiled.ok) throw new ProjectModelError("recipe-template-invalid", "Built-in Recipe template did not compile.");
  const recipe: RecipeRecord = {
    recipeId,
    scope: scope.kind,
    ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
    ...(category.trim() ? { category: category.trim() } : {}),
    name: normalized,
    description: "",
    definition: compiled.model,
    executableDigest: compiled.executableDigest,
    revision: 1
  };
  return {
    ...state,
    recipes: [...(state.recipes || []), recipe],
    audit: [...state.audit, { event: "recipe-created", entityId: recipeId }]
  };
}

export function createRecipeFolder(state: ProjectModelState, parent: string, name: string): ProjectModelState {
  const parentPath = String(parent || "").trim();
  const childPath = normalizeRecipeFolderPath(name);
  const folder = normalizeRecipeFolderPath([parentPath, childPath].filter(Boolean).join("/"));
  if (recipeCategoryFolders(state).has(folder)) throw new ProjectModelError("recipe-folder-exists", `Recipe folder already exists: ${folder}`);
  return {
    ...state,
    recipeFolders: normalizedRecipeFolders([...(state.recipeFolders || []), folder]),
    audit: [...state.audit, { event: "recipe-folder-created", entityId: folder }]
  };
}

export function deleteRecipeFolder(state: ProjectModelState, value: string): ProjectModelState {
  const folder = normalizeRecipeFolderPath(value);
  if (!recipeCategoryFolders(state).has(folder)) throw new ProjectModelError("recipe-folder-not-found", `Recipe folder does not exist: ${folder}`);
  const updateCategory = <T extends RecipeRecord>(recipe: T): T => {
    const category = promoteRecipeFolderPath(recipe.category, folder);
    if (category === recipe.category) return recipe;
    const updated = { ...recipe, category, revision: recipe.revision + 1 };
    if (!category) delete updated.category;
    return updated;
  };
  const recipeFolders = normalizedRecipeFolders((state.recipeFolders || [])
    .map(candidate => promoteRecipeFolderPath(candidate, folder))
    .filter((candidate): candidate is string => Boolean(candidate)));
  return {
    ...state,
    recipes: (state.recipes || []).map(recipe => recipe.scope === "global" ? updateCategory(recipe) : recipe),
    recipeTrash: (state.recipeTrash || []).map(recipe => recipe.scope === "global" ? updateCategory(recipe) : recipe),
    recipeFolders,
    audit: [...state.audit, { event: "recipe-folder-deleted", entityId: folder }]
  };
}

export function updateRecipe(state: ProjectModelState, recipeId: string, update: RecipeUpdate): ProjectModelState {
  const recipes = state.recipes || [];
  const index = recipes.findIndex(recipe => recipe.recipeId === recipeId);
  if (index < 0) throw new ProjectModelError("recipe-not-found", "Recipe does not exist.");
  const name = update.name.trim();
  if (!name) throw new ProjectModelError("recipe-name-required", "Recipe name is required.");
  const compiled = compileWorkflowDefinitionV1(update.definition);
  if (!compiled.ok) throw new ProjectModelError("recipe-definition-invalid", "Recipe definition is invalid.", { diagnostics: compiled.diagnostics });
  const current = recipes[index];
  const methodologySource = update.methodology ?? current.methodology;
  const methodology = methodologySource ? compileRecipeMethodologyV1(methodologySource) : undefined;
  if (methodology && !methodology.ok) {
    throw new ProjectModelError("recipe-methodology-invalid", "Recipe Methodology Manifest is invalid.", { diagnostics: methodology.diagnostics });
  }
  const nodeIds = new Set(compiled.model.spec.nodes.map(node => node.nodeId));
  const nodePositions = Object.fromEntries(Object.entries(update.editorLayout?.nodePositions || current.editorLayout?.nodePositions || {})
    .filter(([nodeId, position]) => nodeIds.has(nodeId) && Number.isFinite(position?.x) && Number.isFinite(position?.y))
    .map(([nodeId, position]) => [nodeId, { x: Math.max(0, Math.round(position.x)), y: Math.max(0, Math.round(position.y)) }]));
  const nodeBindings = normalizeRecipeNodeBindings(update.nodeBindings ?? current.nodeBindings ?? [], nodeIds);
  const next: RecipeRecord = {
    ...current,
    name,
    category: update.category.trim() || undefined,
    description: update.description.trim(),
    metadata: normalizeRecipeMetadata(update.metadata || current.metadata),
    ...(methodology?.ok ? { methodology: methodology.model, methodologyDigest: methodology.methodologyDigest } : {}),
    ...(Object.keys(nodePositions).length ? { editorLayout: { nodePositions } } : {}),
    definition: compiled.model,
    ...(nodeBindings.length ? { nodeBindings } : {}),
    executableDigest: compiled.executableDigest,
    revision: current.revision + 1
  };
  if (!nodeBindings.length) delete next.nodeBindings;
  return {
    ...state,
    recipes: recipes.map((recipe, recipeIndex) => recipeIndex === index ? next : recipe),
    audit: [...state.audit, { event: "recipe-updated", entityId: recipeId }]
  };
}

export function replaceRecipeFromSync(state: ProjectModelState, value: RecipeRecord): ProjectModelState {
  if (!value || typeof value !== "object" || !ID_PATTERN.test(String(value.recipeId || ""))
    || typeof value.name !== "string" || typeof value.description !== "string"
    || !["global", "project"].includes(String(value.scope)) || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new ProjectModelError("recipe-sync-invalid", "Synchronized Recipe metadata is invalid.");
  }
  const compiled = compileWorkflowDefinitionV1(value.definition);
  if (!compiled.ok) {
    throw new ProjectModelError("recipe-sync-definition-invalid", "Synchronized Recipe definition is invalid.", { diagnostics: compiled.diagnostics });
  }
  const methodology = value.methodology ? compileRecipeMethodologyV1(value.methodology) : undefined;
  if (methodology && !methodology.ok) {
    throw new ProjectModelError("recipe-sync-methodology-invalid", "Synchronized Recipe Methodology Manifest is invalid.", {
      diagnostics: methodology.diagnostics
    });
  }
  if (value.scope === "project" && (!value.projectId || !state.projects.some(project => project.projectId === value.projectId))) {
    throw new ProjectModelError("recipe-sync-project-missing", "Synchronized project Recipe references a project that does not exist on this machine.");
  }
  const recipes = state.recipes || [];
  const index = recipes.findIndex(recipe => recipe.recipeId === value.recipeId);
  const current = index >= 0 ? recipes[index] : undefined;
  if (current?.systemKind === "built-in" && value.systemKind !== "built-in") {
    throw new ProjectModelError("recipe-sync-system-kind-invalid", "A built-in Recipe cannot be replaced by a non-built-in Recipe.");
  }
  if (!current?.systemKind && value.systemKind === "built-in") {
    throw new ProjectModelError("recipe-sync-system-kind-invalid", "A synchronized Recipe cannot acquire built-in status.");
  }
  const nodeIds = new Set(compiled.model.spec.nodes.map(node => node.nodeId));
  const nodeBindings = normalizeRecipeNodeBindings(Array.isArray(value.nodeBindings) ? value.nodeBindings : [], nodeIds);
  const nodePositions = Object.fromEntries(Object.entries(value.editorLayout?.nodePositions || {})
    .filter(([nodeId, position]) => nodeIds.has(nodeId) && Number.isFinite(position?.x) && Number.isFinite(position?.y))
    .map(([nodeId, position]) => [nodeId, { x: Math.max(0, Math.round(position.x)), y: Math.max(0, Math.round(position.y)) }]));
  const synchronized: RecipeRecord = {
    ...value,
    name: value.name.trim(),
    description: value.description.trim(),
    category: value.category?.trim() || undefined,
    metadata: normalizeRecipeMetadata(value.metadata),
    definition: compiled.model,
    executableDigest: compiled.executableDigest,
    ...(methodology?.ok ? { methodology: methodology.model, methodologyDigest: methodology.methodologyDigest } : {}),
    ...(Object.keys(nodePositions).length ? { editorLayout: { nodePositions } } : {}),
    ...(nodeBindings.length ? { nodeBindings } : {}),
  };
  if (value.scope === "global") delete synchronized.projectId;
  if (!methodology) {
    delete synchronized.methodology;
    delete synchronized.methodologyDigest;
  }
  if (!Object.keys(nodePositions).length) delete synchronized.editorLayout;
  if (!nodeBindings.length) delete synchronized.nodeBindings;
  return {
    ...state,
    recipes: index >= 0
      ? recipes.map((recipe, recipeIndex) => recipeIndex === index ? synchronized : recipe)
      : [...recipes, synchronized],
    audit: [...state.audit, { event: "recipe-synchronized", entityId: value.recipeId }]
  };
}

export function importRecipe(state: ProjectModelState, value: RecipeRecord, options: RecipeImportOptions, createId: () => string = randomUUID): ProjectModelState {
  if (!value || typeof value !== "object" || !ID_PATTERN.test(String(value.recipeId || ""))
    || typeof value.name !== "string" || typeof value.description !== "string"
    || !["global", "project"].includes(String(value.scope)) || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new ProjectModelError("recipe-import-invalid", "Imported Recipe metadata is invalid.");
  }
  const compiled = compileWorkflowDefinitionV1(value.definition);
  if (!compiled.ok || compiled.executableDigest !== value.executableDigest) {
    throw new ProjectModelError("recipe-import-digest-invalid", "Imported Recipe definition or executable digest is invalid.", { diagnostics: compiled.diagnostics });
  }
  const methodology = value.methodology ? compileRecipeMethodologyV1(value.methodology) : undefined;
  if (methodology && (!methodology.ok || methodology.methodologyDigest !== value.methodologyDigest)) {
    throw new ProjectModelError("recipe-import-methodology-invalid", "Imported Recipe Methodology Manifest or digest is invalid.", {
      diagnostics: methodology.ok ? [] : methodology.diagnostics
    });
  }
  const sourceKey = options.sourceKey.trim();
  if (!sourceKey) throw new ProjectModelError("recipe-import-source-required", "Imported Recipe source identity is required.");
  const recipes = state.recipes || [];
  const existingIndex = recipes.findIndex(recipe => recipe.origin?.kind === options.kind
    && recipe.origin?.sourceKey === sourceKey && recipe.origin?.sourceRecipeId === value.recipeId);
  const identityIndex = options.preserveIdentity ? recipes.findIndex(recipe => recipe.recipeId === value.recipeId) : -1;
  const targetIndex = existingIndex >= 0 ? existingIndex : identityIndex;
  if (targetIndex >= 0 && (options.rejectExisting || recipes[targetIndex].systemKind === "built-in")) {
    throw new ProjectModelError("recipe-import-conflict", `A local Recipe already exists for ${value.recipeId}.`);
  }
  const recipeId = targetIndex >= 0 ? recipes[targetIndex].recipeId : options.preserveIdentity ? value.recipeId : `recipe_${createId()}`;
  if (targetIndex < 0 && recipes.some(recipe => recipe.recipeId === recipeId)) throw new ProjectModelError("identity-conflict", "Generated Recipe identity already exists.");
  const nodeIds = new Set(compiled.model.spec.nodes.map(node => node.nodeId));
  const nodeBindings = normalizeRecipeNodeBindings(Array.isArray(value.nodeBindings) ? value.nodeBindings : [], nodeIds);
  const nodePositions = Object.fromEntries(Object.entries(value.editorLayout?.nodePositions || {})
    .filter(([nodeId, position]) => nodeIds.has(nodeId) && Number.isFinite(position?.x) && Number.isFinite(position?.y))
    .map(([nodeId, position]) => [nodeId, { x: Math.max(0, Math.round(position.x)), y: Math.max(0, Math.round(position.y)) }]));
  const category = [options.categoryPrefix?.trim(), String(value.category || "").trim()].filter(Boolean).join("/");
  const imported: RecipeRecord = {
    ...(options.preserveIdentity && value.schema === "pkm.knowledge/v1" && value.knowledgeId
      ? { schema: value.schema, knowledgeId: value.knowledgeId, aliases: [...(value.aliases || [])] }
      : {}),
    recipeId,
    scope: "global",
    ...(category ? { category } : {}),
    name: value.name.trim(),
    description: value.description.trim(),
    metadata: normalizeRecipeMetadata(value.metadata),
    ...(methodology?.ok ? { methodology: methodology.model, methodologyDigest: methodology.methodologyDigest } : {}),
    ...(Object.keys(nodePositions).length ? { editorLayout: { nodePositions } } : {}),
    definition: compiled.model,
    ...(nodeBindings.length ? { nodeBindings } : {}),
    executableDigest: compiled.executableDigest,
    revision: targetIndex >= 0 ? recipes[targetIndex].revision + 1 : 1,
    origin: {
      kind: options.kind,
      sourceRecipeId: value.recipeId,
      sourceKey,
      sourceRevision: value.revision,
      sourceScope: value.scope,
      ...(options.brokerName ? { brokerName: options.brokerName } : {}),
      ...(options.publisherUser ? { publisherUser: options.publisherUser } : {}),
      ...(options.publisherHost ? { publisherHost: options.publisherHost } : {}),
    }
  };
  return {
    ...state,
    recipes: targetIndex >= 0 ? recipes.map((recipe, index) => index === targetIndex ? imported : recipe) : [...recipes, imported],
    audit: [...state.audit, { event: "recipe-imported", entityId: recipeId }]
  };
}

export function deleteRecipe(state: ProjectModelState, recipeId: string): ProjectModelState {
  const recipe = (state.recipes || []).find(candidate => candidate.recipeId === recipeId);
  if (!recipe) throw new ProjectModelError("recipe-not-found", "Recipe does not exist.");
  if (recipe.systemKind === "built-in") throw new ProjectModelError("system-recipe-delete", "Built-in Recipes cannot be deleted.");
  return {
    ...state,
    recipes: (state.recipes || []).filter(candidate => candidate.recipeId !== recipeId),
    audit: [...state.audit, { event: "recipe-deleted", entityId: recipeId }]
  };
}

export function moveRecipeToTrash(state: ProjectModelState, recipeId: string, trashedAt = new Date().toISOString()): ProjectModelState {
  const recipe = (state.recipes || []).find(candidate => candidate.recipeId === recipeId);
  if (!recipe) throw new ProjectModelError("recipe-not-found", "Recipe does not exist.");
  if (recipe.systemKind === "built-in") throw new ProjectModelError("system-recipe-delete", "Built-in Recipes cannot be moved to Trash.");
  return {
    ...state,
    recipes: (state.recipes || []).filter(candidate => candidate.recipeId !== recipeId),
    recipeTrash: [...(state.recipeTrash || []), { ...recipe, trashedAt }],
    audit: [...state.audit, { event: "recipe-trashed", entityId: recipeId }]
  };
}

export function restoreRecipeFromTrash(state: ProjectModelState, recipeId: string): ProjectModelState {
  const recipe = (state.recipeTrash || []).find(candidate => candidate.recipeId === recipeId);
  if (!recipe) throw new ProjectModelError("recipe-trash-not-found", "Recipe is not in Trash.");
  if ((state.recipes || []).some(candidate => candidate.recipeId === recipeId)) throw new ProjectModelError("identity-conflict", "A Recipe with the same identity already exists.");
  const { trashedAt: _trashedAt, ...restored } = recipe;
  return {
    ...state,
    recipes: [...(state.recipes || []), restored],
    recipeTrash: (state.recipeTrash || []).filter(candidate => candidate.recipeId !== recipeId),
    audit: [...state.audit, { event: "recipe-restored", entityId: recipeId }]
  };
}

export function deleteRecipeFromTrash(state: ProjectModelState, recipeId: string): ProjectModelState {
  if (!(state.recipeTrash || []).some(candidate => candidate.recipeId === recipeId)) throw new ProjectModelError("recipe-trash-not-found", "Recipe is not in Trash.");
  return {
    ...state,
    recipeTrash: (state.recipeTrash || []).filter(candidate => candidate.recipeId !== recipeId),
    audit: [...state.audit, { event: "recipe-trash-deleted", entityId: recipeId }]
  };
}

function normalizeRecipeNodeBindings(value: RecipeNodeBindings[], nodeIds: Set<string>): RecipeNodeBindings[] {
  const seenNodes = new Set<string>();
  return value.filter(node => nodeIds.has(node.nodeId)).map(node => {
    if (seenNodes.has(node.nodeId)) throw new ProjectModelError("recipe-binding-node-duplicate", `Recipe bindings repeat Step ${node.nodeId}.`);
    seenNodes.add(node.nodeId);
    const seenBindings = new Set<string>();
    const bindings = node.bindings.map(binding => {
      if (!binding.bindingId || !["skill", "note"].includes(binding.kind) || !binding.knowledgeId
        || !/^[a-f0-9]{64}$/.test(binding.contentHash) || !["required", "recommended", "reference"].includes(binding.usage)) {
        throw new ProjectModelError("recipe-binding-invalid", `Recipe binding on Step ${node.nodeId} is invalid.`);
      }
      const identity = `${binding.kind}:${binding.knowledgeId}`;
      if (seenBindings.has(identity)) throw new ProjectModelError("recipe-binding-duplicate", `Recipe binding ${identity} is duplicated on Step ${node.nodeId}.`);
      seenBindings.add(identity);
      return { ...binding };
    });
    return { nodeId: node.nodeId, bindings };
  }).filter(node => node.bindings.length);
}

function normalizeTimestamp(value: string, code: string): string {
  const text = String(value || "").trim();
  const parsed = Date.parse(text);
  if (!text || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new ProjectModelError(code, "Timestamp must be a canonical ISO 8601 value.");
  }
  return text;
}

function validateThreadChatrooms(state: ProjectModelState): void {
  const roomIds = new Set<string>();
  for (const thread of state.threads) {
    if (!thread.chatroom) continue;
    if (!ID_PATTERN.test(String(thread.chatroom.roomId || "")) || !String(thread.chatroom.roomName || "").trim()) {
      throw new ProjectModelError("chatroom-association-invalid", "Thread Chatroom association is invalid.");
    }
    normalizeTimestamp(thread.chatroom.linkedAt, "chatroom-linked-at-invalid");
    if (roomIds.has(thread.chatroom.roomId)) throw new ProjectModelError("chatroom-already-linked", "Chatroom is linked to more than one Thread.");
    roomIds.add(thread.chatroom.roomId);
  }
}

function normalizeGanttDate(value: string, field: string): string {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ProjectModelError("gantt-date-invalid", `${field} must use YYYY-MM-DD.`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new ProjectModelError("gantt-date-invalid", `${field} is not a valid calendar date.`);
  }
  return text;
}

function normalizeGanttTask(task: GanttTaskRecord, state: ProjectModelState): GanttTaskRecord {
  if (!ID_PATTERN.test(String(task.taskId || ""))) throw new ProjectModelError("gantt-task-id-invalid", "Gantt task identity is invalid.");
  if (!state.projects.some(project => project.projectId === task.projectId)) throw new ProjectModelError("project-not-found", "Gantt task Project does not exist.");
  const title = String(task.title || "").trim();
  if (!title) throw new ProjectModelError("gantt-title-required", "Gantt task title is required.");
  const startDate = normalizeGanttDate(task.startDate, "Start date");
  const endDate = normalizeGanttDate(task.endDate, "End date");
  if (startDate > endDate) throw new ProjectModelError("gantt-date-range-invalid", "Gantt task end date must be on or after its start date.");
  if (!Number.isInteger(task.progress) || task.progress < 0 || task.progress > 100) {
    throw new ProjectModelError("gantt-progress-invalid", "Gantt task progress must be an integer from 0 to 100.");
  }
  if (!(["not-started", "in-progress", "blocked", "completed"] as string[]).includes(task.status)) {
    throw new ProjectModelError("gantt-status-invalid", "Gantt task status is invalid.");
  }
  const threadId = String(task.threadId || "").trim() || undefined;
  if (threadId && !state.threads.some(thread => thread.threadId === threadId && thread.projectId === task.projectId)) {
    throw new ProjectModelError("gantt-thread-invalid", "Gantt task Thread must belong to its Project.");
  }
  const owners = (task.owners || []).map(owner => ({ name: String(owner?.name || "").trim(), role: String(owner?.role || "").trim() }));
  if (owners.some(owner => !owner.name || !owner.role)) throw new ProjectModelError("gantt-owner-invalid", "Every Gantt task owner requires a name and role.");
  const ownerKeys = owners.map(owner => `${owner.name.toLocaleLowerCase()}\0${owner.role.toLocaleLowerCase()}`);
  if (new Set(ownerKeys).size !== ownerKeys.length) throw new ProjectModelError("gantt-owner-duplicate", "Gantt task owners must be unique.");
  const dependencyIds = (task.dependencyIds || []).map(value => String(value || "").trim());
  if (dependencyIds.some(value => !ID_PATTERN.test(value)) || new Set(dependencyIds).size !== dependencyIds.length || dependencyIds.includes(task.taskId)) {
    throw new ProjectModelError("gantt-dependency-invalid", "Gantt task dependencies must be unique task IDs and cannot reference the task itself.");
  }
  if (!Number.isSafeInteger(task.version) || task.version < 1) throw new ProjectModelError("gantt-version-invalid", "Gantt task version is invalid.");
  return { taskId: task.taskId, projectId: task.projectId, ...(threadId ? { threadId } : {}), title, startDate, endDate,
    progress: task.progress, status: task.status, owners, dependencyIds, version: task.version };
}

function validateGanttTasks(state: ProjectModelState): void {
  const tasks = state.ganttTasks || [];
  const ids = new Set<string>();
  for (const candidate of tasks) {
    if (ids.has(candidate.taskId)) throw new ProjectModelError("gantt-task-id-duplicate", "Gantt task identity is duplicated.");
    ids.add(candidate.taskId);
    normalizeGanttTask(candidate, state);
  }
  for (const task of tasks) {
    const missing = task.dependencyIds.find(dependencyId => !ids.has(dependencyId));
    if (missing) throw new ProjectModelError("gantt-dependency-not-found", `Gantt dependency ${missing} does not exist.`);
    const crossProject = task.dependencyIds.find(dependencyId => tasks.find(candidate => candidate.taskId === dependencyId)?.projectId !== task.projectId);
    if (crossProject) throw new ProjectModelError("gantt-dependency-cross-project", "Gantt dependencies must belong to the same Project.");
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map(task => [task.taskId, task]));
  const visit = (taskId: string, path: string[]): void => {
    if (visiting.has(taskId)) {
      const start = path.indexOf(taskId);
      throw new ProjectModelError("gantt-dependency-cycle", `Gantt dependency cycle: ${[...path.slice(start), taskId].join(" → ")}`);
    }
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependencyId of byId.get(taskId)?.dependencyIds || []) visit(dependencyId, [...path, taskId]);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.taskId, []);
}

export function migrateLegacyRoom(state: ProjectModelState, room: LegacyRoom, createId: () => string = randomUUID): ProjectModelState {
  const existingEntry = state.migrations.find(entry => entry.legacyIdentity === room.identity);
  if (existingEntry?.state === "completed") return state;
  if (room.active) return setMigration(state, room.identity, { state: "pending", error: "active-room-deferred" });
  const defaultProject = state.projects.find(project => project.systemKind === "default-project")!;
  const reusableRoomId = room.roomId && ID_PATTERN.test(room.roomId) && !state.threads.some(thread => thread.threadId === room.roomId);
  const threadId = reusableRoomId ? room.roomId! : `thread_${createId()}`;
  if (state.threads.some(thread => thread.threadId === threadId)) return setMigration(state, room.identity, { state: "failed", error: "thread-identity-conflict" });
  if (state.threads.some(thread => thread.legacyAliases.includes(room.identity))) return setMigration(state, room.identity, { state: "failed", error: "legacy-alias-conflict" });
  const aliasRequired = threadId !== room.roomId;
  const thread: ThreadRecord = {
    threadId,
    projectId: defaultProject.projectId,
    name: room.name.trim() || "Legacy Thread",
    description: room.description || "",
    archived: false,
    legacyAliases: aliasRequired ? [room.identity] : [],
    version: 1
  };
  const receiptId = `migration_${createHash("sha256").update(`${room.identity}\0${threadId}`).digest("hex").slice(0, 24)}`;
  const migrated = { ...state, threads: [...state.threads, thread], audit: [...state.audit, { event: "legacy-room-migrated", entityId: threadId }] };
  return setMigration(migrated, room.identity, { state: "completed", threadId, receiptId });
}

export function moveThread(state: ProjectModelState, plan: ThreadMovePlan): ProjectModelState {
  const thread = state.threads.find(candidate => candidate.threadId === plan.threadId);
  if (!thread) throw new ProjectModelError("thread-not-found", "Thread does not exist.");
  if (thread.systemKind === "general-thread") throw new ProjectModelError("system-thread-move-forbidden", "General Thread cannot move between Projects.");
  if (!state.projects.some(project => project.projectId === plan.destinationProjectId)) throw new ProjectModelError("project-not-found", "Destination Project does not exist.");
  const omittedRuns = plan.linkedActiveRunIds.filter(runId => !plan.includedRunIds.includes(runId));
  if (omittedRuns.length) throw new ProjectModelError("active-run-move-blocked", `Active Runs must move or be resolved: ${omittedRuns.join(", ")}`);
  if (plan.audienceChanges && !plan.audienceChangeConfirmed) throw new ProjectModelError("audience-confirmation-required", "Thread movement changes its effective audience.");
  if (thread.projectId === plan.destinationProjectId) return state;
  const scheduled = (state.ganttTasks || []).filter(task => task.threadId === thread.threadId);
  if (scheduled.length) {
    throw new ProjectModelError("gantt-thread-move-blocked", "Move or remove Thread-associated Gantt tasks before moving this Thread.", {
      taskIds: scheduled.map(task => task.taskId)
    });
  }
  return {
    ...state,
    threads: state.threads.map(candidate => candidate.threadId === thread.threadId ? { ...candidate, projectId: plan.destinationProjectId, version: candidate.version + 1 } : candidate),
    audit: [...state.audit, { event: "thread-moved", entityId: thread.threadId }]
  };
}

export function resolveThreadId(state: ProjectModelState, identity: string): string | undefined {
  return state.threads.find(thread => thread.threadId === identity || thread.legacyAliases.includes(identity))?.threadId;
}

function setMigration(state: ProjectModelState, legacyIdentity: string, update: Omit<MigrationEntry, "legacyIdentity">): ProjectModelState {
  const entry = { legacyIdentity, ...update };
  const exists = state.migrations.some(candidate => candidate.legacyIdentity === legacyIdentity);
  return { ...state, migrations: exists ? state.migrations.map(candidate => candidate.legacyIdentity === legacyIdentity ? entry : candidate) : [...state.migrations, entry] };
}