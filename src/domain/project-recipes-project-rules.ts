import { createHash } from "node:crypto";
import type { WorkflowDefinitionV1 } from "./project-recipes-workflow-contracts.js";
import type { RecipeMethodologyV1 } from "./project-recipes-methodology-model.js";

function fail(code: string, message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  throw error;
}

export type ProjectSystemKind = "default-project";

export type ThreadSystemKind = "general-thread";

export type RecipeSystemKind = "built-in";

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
  goal?: string;
  successCriteria?: string[];
  status?: "planned" | "active" | "completed";
  currentMilestone?: string;
  owner?: string;
  deadline?: string;
  autonomyPolicyReference?: string;
  archivedAt?: string;
  deletedAt?: string;
  links?: ProjectSourceLink[];
  decisions?: ProjectDecision[];
  timeline?: ProjectTimelineEvent[];
}

export interface ProjectSourceLink {
  kind: "action-run" | "recipe-run" | "agent-session" | "chat";
  id: string;
  linkedAt: string;
}

export interface ProjectDecision {
  decisionId: string;
  at: string;
  reason: string;
  changes: { field: string; before: unknown; after: unknown }[];
}

export interface ProjectTimelineEvent {
  eventId: string;
  at: string;
  kind: string;
  summary: string;
  sourceId?: string;
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

export interface RecipeTrashRecord extends RecipeRecord {
  trashedAt: string;
}

export const PROJECT_ENTITY_DIRECTORIES = ["threads", "gantt", "collaboration"] as const;

export function safeProjectDirectoryName(name: string, projectId: string): string {
  const normalized = String(name || "").normalize("NFKC").trim();
  let segment = normalized
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/[ .-]+$/g, "")
    .replace(/^[ .-]+/g, "");
  if (!segment) segment = "project";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(segment)) segment += "-project";
  segment = segment.slice(0, 80).replace(/[ .-]+$/g, "") || "project";
  const safeId = String(projectId).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);
  if (!safeId) fail("project-id-path-invalid", "Project identity cannot be represented as a portable path.");
  return `${segment}.${safeId}`;
}

export function deriveSystemId(parentId: string, key: "pkm/default-project/v1" | "pkm/general-thread/v1"): string {
  const prefix = key.includes("default-project") ? "project_" : "thread_";
  return prefix + createHash("sha256").update(`${key}\0${parentId}`, "utf8").digest("hex").slice(0, 32);
}
