import { createHash, randomUUID } from "crypto";
import {
  NOOP_NODE_KIND,
  WORKFLOW_DEFINITION_SCHEMA,
  WorkflowDefinitionV1,
  compileWorkflowDefinitionV1
} from "../workflow-contracts";

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
  version: number;
}

export interface RecipeRecord {
  recipeId: string;
  scope: "global" | "project";
  projectId?: string;
  category?: string;
  systemKind?: RecipeSystemKind;
  name: string;
  description: string;
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
  recipes?: RecipeRecord[];
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
  if (!existing) return ensureBuiltInRecipes(ensureSystemEntities({ schema: 1, rootId: `root_${createId()}`, projects: [], threads: [], recipes: [], recipeTrash: [], migrations: [], audit: [] }));
  if (!existing.rootId) {
    if ((existing.projects?.length || 0) + (existing.threads?.length || 0) > 0) throw new ProjectModelError("root-identity-missing", "Root identity cannot be regenerated while child records exist.");
    return ensureBuiltInRecipes(ensureSystemEntities({ schema: 1, rootId: `root_${createId()}`, projects: [], threads: [], recipes: existing.recipes || [], recipeTrash: existing.recipeTrash || [], migrations: existing.migrations || [], audit: existing.audit || [] }));
  }
  const restored: ProjectModelState = {
    schema: 1,
    rootId: existing.rootId,
    projects: [...(existing.projects || [])],
    threads: [...(existing.threads || [])],
    migrations: [...(existing.migrations || [])],
    audit: [...(existing.audit || [])]
  };
  if (existing.recipes) restored.recipes = [...existing.recipes];
  if (existing.recipeTrash) restored.recipeTrash = [...existing.recipeTrash];
  return ensureBuiltInRecipes(ensureSystemEntities(restored));
}

const BUILT_IN_RECIPES: ReadonlyArray<{
  key: string;
  name: string;
  category: string;
  description: string;
  applicableFunctions: string[];
  definition: unknown;
}> = [
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
    description: "Prepare releases on a dedicated branch, validate and push the branch, merge and push main, then publish the Personal Knowledge Manager VSIX to the VS Code Marketplace through the canonical GitHub Actions workflow.",
    applicableFunctions: ["VSIX packaging", "VS Code extension release", "Marketplace publishing", "Pre-release promotion"],
    definition: {
      schema: WORKFLOW_DEFINITION_SCHEMA,
      spec: {
        inputs: {},
        nodes: [
          {
            nodeId: "create-release-branch", kind: NOOP_NODE_KIND, config: {}, dependsOn: [],
            generalInstruction: "Before any release edit, build, version bump, commit, or other mutation, fetch origin and verify main is synchronized and free of unrelated changes. Create and switch to a new dedicated release/<version> branch from that synchronized main commit. Never perform release development or commit release changes directly on main. If work was accidentally started on main but remains uncommitted, immediately create the release branch in place so the working tree moves without stash, reset, or data loss; record the branch name and base SHA.",
            ports: { inputs: ["release-request"], outputs: ["release-branch"] }, control: { mode: "single" }
          },
          {
            nodeId: "define-release-contract", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "On the dedicated release branch, confirm the exact release source, package.json version, publisher Uone, extension personal-knowledge, stable or pre-release channel, canonical GitHub Actions method, branch name and base SHA, and expected user impact. Creating or running this Recipe is not approval to mutate the Marketplace.",
            dependsOn: [{ from: "create-release-branch", fromOutput: "release-branch", toInput: "release-branch", accept: ["succeeded"], required: true }],
            ports: { inputs: ["release-branch"], outputs: ["release-contract"] }, control: { mode: "single" }
          },
          {
            nodeId: "verify-release-readiness", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Verify package.json, package-lock.json, and CHANGELOG.md agree on the target version; inspect the exact release diff and privacy-safe media; run npm run test:release and git diff --check. Treat activation loops or repeated popup failures as release blockers. Stable releases require successful pre-release soak covering clean install, upgrade, offline or stale state, and repeated reload startup behavior.",
            dependsOn: [{ from: "define-release-contract", fromOutput: "release-contract", toInput: "release-contract", accept: ["succeeded"], required: true }],
            ports: { inputs: ["release-contract"], outputs: ["readiness-evidence"] }, control: { mode: "single" }
          },
          {
            nodeId: "package-and-verify-vsix", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Build and package the exact target version locally with the selected channel marker. Run scripts/verify-vsix-package.js against the artifact and confirm identity Uone.personal-knowledge, version, channel, file boundaries, and installability. Preserve the artifact digest and validation output as evidence; do not publish from this node.",
            dependsOn: [{ from: "verify-release-readiness", fromOutput: "readiness-evidence", toInput: "readiness-evidence", accept: ["succeeded"], required: true }],
            ports: { inputs: ["readiness-evidence"], outputs: ["verified-artifact"] }, control: { mode: "single" }
          },
          {
            nodeId: "commit-and-push-release-source", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Verify the current branch is the dedicated release/<version> branch and is not main. Stage only the audited release files, commit the exact tested release source on that branch, and push the branch to origin. Never commit release changes directly on main. Record the immutable branch commit SHA and verify origin/<release-branch> resolves to it. Do not tag, merge, create a GitHub Release, or mutate Marketplace state unless the user requested the corresponding operation.",
            dependsOn: [{ from: "package-and-verify-vsix", fromOutput: "verified-artifact", toInput: "verified-artifact", accept: ["succeeded"], required: true }],
            ports: { inputs: ["verified-artifact"], outputs: ["release-branch-source"] }, control: { mode: "single" }
          },
          {
            nodeId: "merge-release-branch", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Only after the validated release commit is pushed to origin, merge the release branch into main using the repository release convention. Synchronize main first, refuse force-push or history rewrites, merge the reviewed release branch, and push main. Verify origin/main contains the exact release branch commit and record the resulting main commit SHA. Marketplace publication must use this merged main commit, never the unmerged branch.",
            dependsOn: [{ from: "commit-and-push-release-source", fromOutput: "release-branch-source", toInput: "release-branch-source", accept: ["succeeded"], required: true }],
            ports: { inputs: ["release-branch-source"], outputs: ["merged-release-source"] }, control: { mode: "single" }
          },
          {
            nodeId: "obtain-marketplace-approval", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "After the release branch is committed, pushed, merged into main, and main is pushed, obtain the user's explicit current approval immediately before any Marketplace mutation for exactly: publisher Uone, extension personal-knowledge, merged main commit, target version, stable or pre-release channel, publication method .github/workflows/publish-marketplace.yml, and expected user impact. Prior build, package, install, branch commit or push, merge, tag, GitHub Release, Recipe start, or earlier approval does not authorize publication. Do not report this node succeeded until that exact approval is received.",
            dependsOn: [{ from: "merge-release-branch", fromOutput: "merged-release-source", toInput: "merged-release-source", accept: ["succeeded"], required: true }],
            ports: { inputs: ["merged-release-source"], outputs: ["approval"] }, control: { mode: "single" }
          },
          {
            nodeId: "dispatch-publish-workflow", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Only after the immediately preceding approval, dispatch Publish VS Code Marketplace from the verified merged main commit with mode publish, the exact approved version, and exact approved channel. Confirm the workflow head SHA equals origin/main and includes the release branch commit. Use GitHub Actions OIDC and vsce --azure-credential through the canonical workflow; never introduce PAT, client-secret, local Azure login, or Device Code Flow credentials.",
            dependsOn: [{ from: "obtain-marketplace-approval", fromOutput: "approval", toInput: "approval", accept: ["succeeded"], required: true }],
            ports: { inputs: ["approval"], outputs: ["workflow-run"] }, control: { mode: "single" }
          },
          {
            nodeId: "verify-marketplace-release", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Verify the workflow's build, tests, package boundary check, publisher permission check, and publish step all succeeded. Confirm the exact version and channel on the Uone.personal-knowledge Marketplace listing, allowing for validation delay. A retry, promotion, unpublish, deprecation, removal, or availability change is a new mutation and requires renewed explicit approval.",
            dependsOn: [{ from: "dispatch-publish-workflow", fromOutput: "workflow-run", toInput: "workflow-run", accept: ["succeeded"], required: true }],
            ports: { inputs: ["workflow-run"], outputs: ["publication-evidence"] }, control: { mode: "single" }
          },
          {
            nodeId: "report-and-reflect", kind: NOOP_NODE_KIND, config: {},
            generalInstruction: "Report the release branch, branch commit and push evidence, main merge and push evidence, published identity, immutable version, channel, merged source commit, workflow run, Marketplace verification, and user impact. Then run the Reflection Recipe to capture evidence-backed release or Recipe improvements without storing credentials or transient secrets.",
            dependsOn: [{ from: "verify-marketplace-release", fromOutput: "publication-evidence", toInput: "publication-evidence", accept: ["succeeded"], required: true }],
            ports: { inputs: ["publication-evidence"], outputs: ["release-result"] }, control: { mode: "single" }
          }
        ],
        outputs: {},
        completion: { requiredNodes: ["report-and-reflect"] }
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

export function ensureBuiltInRecipes(state: ProjectModelState): ProjectModelState {
  const recipes = [...(state.recipes || [])];
  for (const descriptor of BUILT_IN_RECIPES) {
    const recipeId = builtInRecipeId(descriptor.key);
    const existing = recipes.find(recipe => recipe.recipeId === recipeId);
    if (existing) {
      if (existing.systemKind !== "built-in") throw new ProjectModelError("system-recipe-conflict", "Built-in Recipe identity is conflicting.");
      const compiled = compileBuiltInRecipe(descriptor.definition);
      if (existing.executableDigest !== compiled.executableDigest) {
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
          definition: compiled.definition,
          executableDigest: compiled.executableDigest,
          revision: existing.revision + 1
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
      definition: compiled.definition,
      executableDigest: compiled.executableDigest,
      revision: 1
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

export function updateRecipe(state: ProjectModelState, recipeId: string, update: RecipeUpdate): ProjectModelState {
  const recipes = state.recipes || [];
  const index = recipes.findIndex(recipe => recipe.recipeId === recipeId);
  if (index < 0) throw new ProjectModelError("recipe-not-found", "Recipe does not exist.");
  const name = update.name.trim();
  if (!name) throw new ProjectModelError("recipe-name-required", "Recipe name is required.");
  const compiled = compileWorkflowDefinitionV1(update.definition);
  if (!compiled.ok) throw new ProjectModelError("recipe-definition-invalid", "Recipe definition is invalid.", { diagnostics: compiled.diagnostics });
  const current = recipes[index];
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
    recipeId,
    scope: "global",
    ...(category ? { category } : {}),
    name: value.name.trim(),
    description: value.description.trim(),
    metadata: normalizeRecipeMetadata(value.metadata),
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