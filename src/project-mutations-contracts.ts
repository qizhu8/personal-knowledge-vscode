import { z } from "zod";
import { projectRecordSchema, projectRecipeSchema, projectThreadSchema } from "./project-recipes-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/);
const uuid = z.string().uuid();
const at = z.string().datetime({ offset: true });

const operation = {
  operationId: uuid,
  expectedSnapshotRevision: digest,
};

const overview = z.strictObject({
  goal: z.string().max(8000).optional(),
  successCriteria: z.array(z.string().max(4000)).max(100).optional(),
  status: z.enum(["planned", "active", "completed"]).optional(),
  currentMilestone: z.string().max(8000).optional(),
  owner: z.string().max(8000).optional(),
  deadline: z.string().max(8000).optional(),
  autonomyPolicyReference: z.string().max(8000).optional(),
});

export const projectMutationInputs = {
  "project.create": z.strictObject({
    ...operation,
    name: z.string().trim().min(1).max(500),
    at,
    template: z.enum(["research", "delivery"]).optional(),
    overview: overview.optional(),
    sources: z.array(z.strictObject({
      kind: z.enum(["action-run", "recipe-run", "agent-session", "chat"]),
      id: z.string().min(1).max(128),
    })).max(100).optional(),
  }),
  "project.update": z.strictObject({
    ...operation,
    projectId: identity,
    expectedVersion: z.number().int().safe().min(1),
    expectedSha256: digest,
    overview,
    reason: z.string().max(8000),
    at,
  }),
  "project.archive": z.strictObject({
    ...operation,
    projectId: identity,
    expectedVersion: z.number().int().safe().min(1),
    expectedSha256: digest,
    at,
  }),
  "project.recipe.create": z.strictObject({
    ...operation,
    scope: z.enum(["global", "project"]),
    projectId: identity.optional(),
    name: z.string().trim().min(1).max(500),
    category: z.string().max(2048).default(""),
  }).refine(value => value.scope === "project" ? value.projectId !== undefined : value.projectId === undefined,
    "projectId is required only for Project-scoped Recipe creation."),
  "project.recipe.update": z.strictObject({
    ...operation,
    recipeId: identity,
    expectedRevision: z.number().int().safe().min(1),
    expectedExecutableDigest: digest,
    expectedSha256: digest,
    name: z.string().max(500),
    category: z.string().max(2048),
    description: z.string().max(32_768),
    methodology: z.json().optional(),
    metadata: z.strictObject({
      applicableFunctions: z.array(z.string()), solution: z.string(),
      requiredInputs: z.array(z.strictObject({ name: z.string(), description: z.string(), required: z.boolean().optional() })),
      expectedOutputs: z.array(z.strictObject({ name: z.string(), description: z.string(), required: z.boolean().optional() })),
    }).optional(),
    editorLayout: z.strictObject({
      nodePositions: z.record(z.string(), z.strictObject({ x: z.number().finite(), y: z.number().finite() })),
    }).optional(),
    definition: z.json(),
    nodeBindings: z.array(z.strictObject({
      nodeId: identity,
      bindings: z.array(z.strictObject({
        bindingId: identity, kind: z.enum(["skill", "note"]), knowledgeId: z.string().min(1),
        contentHash: digest, usage: z.enum(["required", "recommended", "reference"]),
      })),
    })).optional(),
  }),
} as const;

export type ProjectMutationOperation = keyof typeof projectMutationInputs;
export type ProjectMutationRequest = {
  operation: ProjectMutationOperation;
  args: Record<string, unknown>;
  actorId: string;
};

export const projectMutationResultSchema = z.strictObject({
  operationId: uuid,
  operation: z.enum([
    "project.create", "project.update", "project.archive", "project.recipe.create", "project.recipe.update",
  ]),
  entityKind: z.enum(["project", "recipe"]),
  entityId: identity,
  version: z.number().int().safe().min(1),
  snapshotRevision: digest,
  item: z.union([projectRecordSchema, projectRecipeSchema]),
  createdThread: projectThreadSchema.optional(),
});

export const projectMutationPlanSchema = z.strictObject({
  schema: z.literal("pkm.project-mutation-plan/v1"),
  actorId: z.string().min(1).max(500),
  operationId: uuid,
  operation: z.enum([
    "project.create", "project.update", "project.archive", "project.recipe.create", "project.recipe.update",
  ]),
  workspaceId: uuid,
  rootPin: digest,
  files: z.array(z.strictObject({
    relativePath: z.string().min(1).max(2048),
    order: z.number().int().min(0).max(1),
    beforeSha256: digest.nullable(),
    beforeBase64: z.string().max(2_796_204).nullable(),
    afterSha256: digest.nullable(),
    afterBase64: z.string().max(2_796_204).nullable(),
  })).max(2),
  guards: z.array(z.strictObject({
    relativePath: z.string().min(1).max(512),
    sha256: digest,
  })).max(3),
  result: projectMutationResultSchema,
});

export type ProjectMutationPlan = z.infer<typeof projectMutationPlanSchema>;
export type ProjectMutationPlanResult = ProjectMutationPlan["result"];
export type ProjectMutationFile = ProjectMutationPlan["files"][number];

export const projectMutationDefinitions = [
  {
    id: "project.create", readOnly: false,
    description: "Plan original Project creation with its derived General Thread. The isolated Project tree must already contain the canonical Default Project; storage is not initialized or repaired.",
    input: projectMutationInputs["project.create"], output: projectMutationResultSchema,
  },
  {
    id: "project.update", readOnly: false,
    description: "Plan an original Project overview update using snapshot, Project version, and exact file SHA256 compare-and-swap pins. Goal or success-criteria changes require a decision reason.",
    input: projectMutationInputs["project.update"], output: projectMutationResultSchema,
  },
  {
    id: "project.archive", readOnly: false,
    description: "Plan original Project archival. The Default Project is protected; isolated runtime state is conservatively checked and must contain no unverified Run records.",
    input: projectMutationInputs["project.archive"], output: projectMutationResultSchema,
  },
  {
    id: "project.recipe.create", readOnly: false,
    description: "Plan original Recipe creation with a compiled no-op workflow, deterministic Knowledge identity, normalized storage path, and optional Project category.",
    input: projectMutationInputs["project.recipe.create"], output: projectMutationResultSchema,
  },
  {
    id: "project.recipe.update", readOnly: false,
    description: "Plan original Recipe update with revision, executable-digest, file-SHA256, and workspace snapshot pins. Workflow/methodology digests and supplied Note/Skill binding content pins are revalidated.",
    input: projectMutationInputs["project.recipe.update"], output: projectMutationResultSchema,
  },
] as const;

export const projectMutationReadDefinitions = [{
  id: "project.mutation.pin", readOnly: true,
  description: "Obtain the exact on-disk Project or Recipe file SHA256 and version for mutation CAS, pinned to the Project/Recipe snapshot.",
  input: z.strictObject({
    entityKind: z.enum(["project", "recipe"]), id: identity, snapshotRevision: digest.optional(),
  }),
  output: z.strictObject({
    entityKind: z.enum(["project", "recipe"]), entityId: identity,
    version: z.number().int().safe().min(1), sha256: digest, snapshotRevision: digest,
    executableDigest: digest.optional(),
  }),
}] as const;
