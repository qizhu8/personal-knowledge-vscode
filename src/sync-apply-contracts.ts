import { z } from "zod";
import {
  syncNoteFileHasUnlimitedText, syncPlanInputSchema, syncPlanLimits,
} from "./sync-plan-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const type = z.enum(["skills", "notes", "papers", "prompts", "scripts", "packages", "servers", "recipes", "agentSnapshots", "actions", "action-module-sets", "profiles"]);
const identity = z.string().min(1).max(512);

const action = z.strictObject({
  path: z.string().min(1).max(512),
  type,
  itemId: identity,
  member: z.string().max(512),
  privacy: z.enum(["public", "private"]),
  beforeSha256: digest.nullable(),
  afterSha256: digest.nullable(),
  beforeMode: z.number().int().min(0).max(0o777).optional(),
  afterMode: z.number().int().min(0).max(0o777).optional(),
  contentBase64: z.string().optional(),
});

const guard = z.strictObject({ path: z.string().min(1).max(512), sha256: digest.nullable() });
const acceptedDecision = z.strictObject({
  conflictId: digest,
  operationId: z.string().uuid(),
  actorId: z.string().min(1).max(200),
  revision: z.number().int().safe().min(2),
  choice: z.enum(["base", "local", "remote", "delete"]),
  reason: z.string().min(1).max(4000),
});
const tombstone = z.strictObject({
  type,
  itemId: identity,
  deletedAt: z.string().datetime({ offset: true }).optional(),
  source: z.enum(["proposal", "decision"]),
  conflictId: digest.optional(),
});

export const syncApplyPlanSchema = z.strictObject({
  schema: z.literal("pkm.sync-apply-plan/v1"),
  sessionId: z.string().uuid(),
  revision: z.number().int().safe().min(1),
  actorId: z.string().min(1).max(200),
  sourcePins: z.strictObject({ base: digest, local: digest, remote: digest }),
  sessionHash: digest,
  decisions: z.array(acceptedDecision),
  guards: z.array(guard),
  actions: z.array(action),
  modeBaselineHash: digest.optional(),
  tombstones: z.array(tombstone),
  planHash: digest,
}).superRefine((plan, context) => {
  const paths = new Set<string>();
  let nonNoteActionCount = 0, nonNoteBytes = 0;
  for (const [index, item] of plan.actions.entries()) {
    if (paths.has(item.path)) context.addIssue({ code: "custom", path: ["actions", index, "path"], message: "Duplicate action path" });
    paths.add(item.path);
    const hasMode = item.beforeMode !== undefined || item.afterMode !== undefined;
    if (item.beforeMode !== undefined && item.afterMode === undefined) {
      context.addIssue({ code: "custom", path: ["actions", index], message: "Permission action requires both modes" });
    }
    if (item.beforeSha256 === item.afterSha256 && !hasMode) {
      context.addIssue({ code: "custom", path: ["actions", index], message: "No-op action" });
    }
    if (hasMode && (item.beforeSha256 !== item.afterSha256 || item.afterSha256 === null
      || item.afterMode !== 0o600 || item.privacy !== "private")) {
      context.addIssue({ code: "custom", path: ["actions", index], message: "Invalid private permission action" });
    }
    if (item.afterSha256 === null && (item.contentBase64 !== undefined || hasMode)
      || item.afterSha256 !== null && ((hasMode && item.contentBase64 !== undefined)
        || (!hasMode && item.contentBase64 === undefined))) {
      context.addIssue({ code: "custom", path: ["actions", index], message: "Action content does not match its result hash" });
    }
    if (!syncNoteFileHasUnlimitedText(item)) {
      if (++nonNoteActionCount > syncPlanLimits.nonNoteFiles) {
        context.addIssue({ code: "custom", path: ["actions", index], message: "Non-Notes action count limit exceeded." });
      }
      if (item.contentBase64 !== undefined) {
        const size = Buffer.from(item.contentBase64, "base64").length;
        if (item.type === "notes") {
          if (size > syncPlanLimits.noteAssetBytes) {
            context.addIssue({ code: "custom", path: ["actions", index, "contentBase64"], message: "Note asset exceeds its resource limit." });
          }
        } else if (size > syncPlanLimits.markdownBytes || (nonNoteBytes += size) > syncPlanLimits.totalBytes) {
          context.addIssue({ code: "custom", path: ["actions", index, "contentBase64"], message: "Non-Notes sync content exceeds its limit." });
        }
      }
    }
  }
  const permissionActions = plan.actions.filter(item => item.afterMode !== undefined);
  if (plan.modeBaselineHash !== undefined
    && (permissionActions.length === 0 || permissionActions.some(item => item.beforeMode === undefined))) {
    context.addIssue({ code: "custom", path: ["modeBaselineHash"], message: "Mode baseline hash requires captured permission actions" });
  }
  const guardPaths = new Set<string>();
  for (const [index, item] of plan.guards.entries()) {
    if (guardPaths.has(item.path)) context.addIssue({ code: "custom", path: ["guards", index, "path"], message: "Duplicate guard path" });
    guardPaths.add(item.path);
  }
});

export const syncApplyRequestSchema = z.strictObject({
  sessionId: z.string().uuid(),
  actorId: z.string().trim().min(1).max(200),
  input: syncPlanInputSchema,
});

export const syncApplyReceiptSchema = z.strictObject({
  schema: z.literal("pkm.sync-apply-receipt/v1"),
  applyId: z.string().uuid(),
  planHash: digest,
  sessionId: z.string().uuid(),
  actorId: z.string().min(1).max(200),
  rootPath: z.string().min(1).max(4096),
  operations: z.array(z.strictObject({
    path: z.string().min(1).max(512),
    beforeSha256: digest.nullable(),
    afterSha256: digest.nullable(),
    beforeMode: z.number().int().min(0).max(0o777).optional(),
    afterMode: z.number().int().min(0).max(0o777).optional(),
  })),
  tombstones: z.array(tombstone),
  completedAt: z.string().datetime({ offset: true }),
});

export type SyncApplyPlan = z.infer<typeof syncApplyPlanSchema>;
export type SyncApplyReceipt = z.infer<typeof syncApplyReceiptSchema>;
