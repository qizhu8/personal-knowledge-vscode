import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/);
const nonempty = z.string().min(1);
const json = z.json();
const metadataField = z.strictObject({
  name: z.string(), description: z.string(), required: z.boolean().optional(),
});
const binding = z.strictObject({
  bindingId: identity, kind: z.enum(["skill", "note"]), knowledgeId: nonempty,
  contentHash: digest, usage: z.enum(["required", "recommended", "reference"]),
});
export const projectRecipeSchema = z.strictObject({
  schema: z.literal("pkm.knowledge/v1").optional(),
  knowledgeId: z.string().regex(/^knowledge_[a-f0-9]{24}$/).optional(),
  aliases: z.array(z.string()).optional(),
  recipeId: identity,
  trashedAt: nonempty.refine(value =>
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value).optional(),
  scope: z.enum(["global", "project"]),
  projectId: identity.optional(),
  category: z.string().optional(),
  systemKind: z.literal("built-in").optional(),
  name: nonempty,
  description: z.string(),
  methodology: json.optional(),
  methodologyDigest: digest.optional(),
  metadata: z.strictObject({
    applicableFunctions: z.array(z.string()), solution: z.string(),
    requiredInputs: z.array(metadataField), expectedOutputs: z.array(metadataField),
  }).optional(),
  editorLayout: z.strictObject({
    nodePositions: z.record(z.string(), z.strictObject({ x: z.number().finite(), y: z.number().finite() })),
    boundaryPositions: z.strictObject({
      input: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional(),
      output: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional(),
    }).optional(),
  }).optional(),
  definition: json,
  nodeBindings: z.array(z.strictObject({ nodeId: identity, bindings: z.array(binding) })).optional(),
  executableDigest: digest,
  revision: z.number().int().safe().min(1),
  origin: z.strictObject({
    kind: z.string(), sourceRecipeId: z.string().optional(), sourceKey: z.string().optional(),
    sourceRevision: z.number().int().safe().positive().optional(),
    sourceScope: z.enum(["global", "project"]).optional(), brokerName: z.string().optional(),
    publisherUser: z.string().optional(), publisherHost: z.string().optional(),
  }).optional(),
});
export const trashedProjectRecipeSchema = projectRecipeSchema.extend({ trashedAt: nonempty });

export const projectRecordSchema = z.strictObject({
  projectId: identity, name: nonempty, systemKind: z.literal("default-project").optional(),
  version: z.number().int().safe().min(1), goal: z.string().optional(),
  successCriteria: z.array(z.string()).optional(), status: z.enum(["planned", "active", "completed"]).optional(),
  currentMilestone: z.string().optional(), owner: z.string().optional(), deadline: z.string().optional(),
  autonomyPolicyReference: z.string().optional(), archivedAt: z.string().optional(), deletedAt: z.string().optional(),
  links: z.array(z.strictObject({
    kind: z.enum(["action-run", "recipe-run", "agent-session", "chat"]), id: nonempty, linkedAt: nonempty,
  })).optional(),
  decisions: z.array(z.strictObject({
    decisionId: identity, at: nonempty, reason: z.string(),
    changes: z.array(z.strictObject({ field: nonempty, before: json.nullable(), after: json.nullable() })),
  })).optional(),
  timeline: z.array(z.strictObject({
    eventId: identity, at: nonempty, kind: nonempty, summary: z.string(), sourceId: z.string().optional(),
  })).optional(),
});
export const projectThreadSchema = z.strictObject({
  threadId: identity, projectId: identity, name: nonempty, description: z.string(),
  archived: z.boolean(), systemKind: z.literal("general-thread").optional(),
  legacyAliases: z.array(z.string()),
  chatroom: z.strictObject({
    roomId: identity, roomName: z.string().refine(value => !!value.trim()), linkedAt: nonempty,
  }).optional(),
  version: z.number().int().safe().min(1),
});
export const projectGanttTaskSchema = z.strictObject({
  taskId: identity, projectId: identity, threadId: identity.optional(), title: nonempty,
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  progress: z.number().int().min(0).max(100),
  status: z.enum(["not-started", "in-progress", "blocked", "completed"]),
  owners: z.array(z.strictObject({
    name: z.string().refine(value => !!value.trim() && value === value.trim()),
    role: z.string().refine(value => !!value.trim() && value === value.trim()),
  })),
  dependencyIds: z.array(identity), version: z.number().int().safe().min(1),
});
export const projectCollaborationTaskSchema = z.strictObject({
  collaborationId: identity, title: nonempty, projectId: identity, threadId: identity,
  ganttTaskId: identity.optional(), agentSessionId: identity.optional(), recipeRunId: identity.optional(),
  objective: z.string().optional(), context: z.string().optional(), expectedOutput: z.string().optional(),
  artifactType: z.string().optional(), acceptanceCriteria: z.array(z.string()),
  decisionRequired: z.boolean(), evidenceLinks: z.array(z.string()), evidenceSummary: z.string().optional(),
  decisionResult: z.string().optional(), resultArtifact: z.string().optional(), blockedWaitingOn: z.array(z.string()),
  completionClaim: z.boolean(), primaryOwner: z.string().optional(),
  ownerPartitions: z.array(z.strictObject({ owner: nonempty, scope: nonempty })),
  resolvedResponders: z.array(z.string()), reviewerApprovals: z.array(z.string()), expectedReviewers: z.array(z.string()),
  version: z.number().int().safe().min(1),
  status: z.enum(["assigned", "working", "review", "synthesis", "completed", "blocked", "timed-out"]),
  phase: z.enum(["assignment", "work", "handoff", "review", "synthesis", "completion"]),
  lead: nonempty, owners: z.array(z.string()), reviewers: z.array(z.string()), expectedResponders: z.array(z.string()),
  deadlineAt: z.string().optional(),
  warnings: z.array(z.strictObject({ code: z.string(), message: z.string(), at: nonempty })),
  convergenceState: z.enum([
    "contract-incomplete", "awaiting-work", "awaiting-responders", "awaiting-review",
    "awaiting-decision", "ready-to-complete", "converged", "blocked", "escalated",
  ]),
  history: z.array(z.strictObject({
    version: z.number().int().safe().min(1),
    action: z.enum(["assign", "start", "handoff", "approve", "reject", "synthesize", "complete", "block", "timeout", "resume"]),
    actor: nonempty, actorRole: z.enum(["Lead", "Worker", "Reviewer"]), at: nonempty,
    note: z.string().optional(), warnings: z.array(z.strictObject({ code: z.string(), message: z.string(), at: nonempty })).optional(),
    convergenceState: z.enum([
      "contract-incomplete", "awaiting-work", "awaiting-responders", "awaiting-review",
      "awaiting-decision", "ready-to-complete", "converged", "blocked", "escalated",
    ]).optional(),
  })),
});

export type ProjectRecord = z.infer<typeof projectRecordSchema>;
export type ProjectRecipeRecord = z.infer<typeof projectRecipeSchema>;
export type RecipeRecord = ProjectRecipeRecord;
export interface RecipeKnowledgeBinding {
  bindingId: string;
  kind: "skill" | "note";
  knowledgeId: string;
  contentHash: string;
  usage: "required" | "recommended" | "reference";
}
export type ProjectRecipeOperation =
  | "project.list"
  | "project.get"
  | "project.recipe.list"
  | "project.recipe.get"
  | "project.recipe.bundle.get";
export type ProjectRecipeRequest = {
  operation: ProjectRecipeOperation;
  args: Record<string, unknown>;
  actorId: string;
  receiptOnly?: boolean;
  memoryDecision?: { decisionId: string; actorId: string; documentSha256: string };
};

const pageInput = {
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(100).default(20),
  snapshotRevision: digest.optional(),
};
const pageOutput = z.strictObject({
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nextOffset: z.number().int().nonnegative().nullable(),
  snapshotRevision: digest,
});
const recipeSummary = z.strictObject({
  recipeId: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/),
  knowledgeId: z.string().regex(/^knowledge_[a-f0-9]{24}$/),
  revision: z.number().int().safe().min(1), name: nonempty, description: z.string(),
  category: z.string(), systemKind: z.literal("built-in").optional(), executableDigest: digest,
});

export const projectRecipeDefinitions = [
  {
    id: "project.list", readOnly: true,
    description: "Page Project records from this isolated workspace's optional project/ tree. Pins snapshotRevision across pages; does not initialize Project storage.",
    input: z.strictObject(pageInput),
    output: z.strictObject({ items: z.array(projectRecordSchema), ...pageOutput.shape }),
  },
  {
    id: "project.get", readOnly: true,
    description: "Read a Project and its stored Thread, Gantt, and Collaboration records by exact projectId. An optional version and snapshotRevision prevent stale reads.",
    input: z.strictObject({
      id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/),
      expectedVersion: z.number().int().safe().min(1).optional(), snapshotRevision: digest.optional(),
    }),
    output: z.strictObject({
      item: projectRecordSchema, threads: z.array(projectThreadSchema), ganttTasks: z.array(projectGanttTaskSchema),
      collaborationTasks: z.array(projectCollaborationTaskSchema), snapshotRevision: digest,
    }),
  },
  {
    id: "project.recipe.list", readOnly: true,
    description: "Page validated Recipe records from the isolated workspace; an explicitly composed native Library includes its same-root SQL overlays. Optional projectId selects the original Project/<safe-project-name>/ category; snapshotRevision pins the read.",
    input: z.strictObject({
      ...pageInput, projectId: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/).optional(),
      category: z.string().max(2048).optional(),
    }),
    output: z.strictObject({ items: z.array(recipeSummary), ...pageOutput.shape }),
  },
  {
    id: "project.recipe.get", readOnly: true,
    description: "Read one validated Recipe by exact recipeId, optionally pinning its revision and executable digest as well as the workspace snapshot.",
    input: z.strictObject({
      id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/),
      expectedRevision: z.number().int().safe().min(1).optional(),
      expectedExecutableDigest: digest.optional(), snapshotRevision: digest.optional(),
    }),
    output: z.strictObject({ item: projectRecipeSchema, snapshotRevision: digest }),
  },
  {
    id: "project.recipe.bundle.get", readOnly: true,
    description: "Read the original Project Recipe bundle projection for recipes stored under Project/<safe-project-name>/. Bound Note/Skill Markdown is resolved from the isolated workspace's indexed documents and checked against each Recipe binding's content hash.",
    input: z.strictObject({
      projectId: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/),
      exportedAt: z.string().datetime({ offset: true }).optional(), snapshotRevision: digest.optional(),
    }),
    output: z.strictObject({ item: json, snapshotRevision: digest }),
  },
] as const;
