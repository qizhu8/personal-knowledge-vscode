import { z } from "zod";
import { migrationPreflightReportSchema } from "../migration-preflight.js";
import { legacyTrashImportPlanSchema } from "./legacy-trash-import-contracts.js";
import { legacyRecipeTrashImportPlanSchema } from "../legacy-recipe-trash-contracts.js";
import { subscriptionIdentityBindingSchema } from "../legacy-subscription-identity.js";
import { legacyMemoryImportPlanSchema, legacyMemoryImportReceiptSchema } from "./memory-import-contracts.js";
import { memoryScopeContinuitySchema } from "../memory-scope-continuity.js";
import { noReplacePlatformSupported } from "../rename-no-replace.js";
import { legacyRouterConfigPlanSchema } from "../legacy-router-config.js";
import { resourcePath } from "../document-path.js";
import { legacyRetrievalHistoryPlanSchema } from "../legacy-retrieval-history-import.js";
import { describeLegacySkillsHistoryArchive, legacySkillsHistoryArchiveSchema } from "../legacy-library.js";

export const legacyImportLimitsSchema = z.strictObject({
  maxEntries: z.number().int().min(1).max(20_000).default(20_000),
  maxDepth: z.number().int().min(0).max(32).default(32),
  maxReadBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(Number.MAX_SAFE_INTEGER),
  maxTotalBytes: z.number().int().min(1).max(536_870_912).default(536_870_912),
});

export const legacyImportEntrySchema = z.strictObject({
  source: z.string(),
  kind: z.enum(["directory", "document", "asset", "board-backing"]),
  size: z.number().int().nonnegative().optional(),
  mode: z.number().int().min(0).max(0o777).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  destination: z.string().optional(),
  documentId: z.string().optional(),
  boardSlug: z.string().optional(),
  mtimeNs: z.string().regex(/^-?(?:0|[1-9][0-9]{0,19})$/).optional(),
});

export const legacyImportBoardSchema = z.strictObject({
  source: z.string(),
  slug: z.string(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  itemCount: z.number().int().nonnegative(),
});

const inPlaceChatroomArchiveSchema = z.strictObject({
  roomId: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.strictObject({
    path: z.string().regex(/^chatrooms\/[A-Za-z0-9_-]{6,80}\/chatroom\.(?:db|journal)$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
    mode: z.number().int().min(0).max(0o777),
    dev: z.number().int().nonnegative(),
    ino: z.number().int().nonnegative(),
    mtimeMs: z.number().finite().nonnegative(),
  })).min(1).max(2),
});

export const legacyStateImportPlanSchema = z.strictObject({
  schema: z.literal("pkm.legacy-state-import/v1"),
  sourceRoot: z.string(),
  subscriptionRoot: z.string().optional(),
  keyEpoch: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  subscriptionIdentity: subscriptionIdentityBindingSchema.optional(),
  protectedSubscriptions: z.strictObject({
    authorityId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    epoch: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    gatewaySha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    emptyDownloads: z.literal(true).optional(),
    snapshots: z.array(z.strictObject({
      name: z.string().regex(/^[A-Za-z0-9_-]+-\d+\.json$/),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      status: z.enum(["authenticated-current", "unverified"]),
    })).max(512),
  }).optional(),
  entries: z.array(z.strictObject({
    source: z.string(), destination: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    sourceSize: z.number().int().nonnegative().optional(),
    projection: z.literal("protected-subscription").optional(),
  })).refine(entries => entries.filter(entry => !entry.destination.startsWith("subscriptions/cache/")
    && !entry.destination.startsWith("_feedback/") && !entry.destination.startsWith("_proposals/")).length <= 512),
  directories: z.array(resourcePath.refine(path => path === "subscriptions/cache" || path.startsWith("subscriptions/cache/")
    || path === "subscriptions/snapshots"
    || ["_feedback", "_proposals", "_proposals/skills"].includes(path))).optional(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const legacyImportPlanSchema = z.strictObject({
  schema: z.literal("pkm.legacy-import-plan/v1"),
  sourceRoot: z.string(),
  ready: z.boolean(),
  inPlaceOnly: z.boolean().optional(),
  inPlacePkmPrivacySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  inPlaceEmptyActionSettingsSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  inPlaceApiChatArchive: z.strictObject({
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.array(z.strictObject({
      path: z.string().regex(/^\.pkm\/state\/(?:api-chats|api-chat-history|agent-groups|agent-sessions|api-chat-worker-trees|api-chat-worker-results|api-chat-control)(?:\/|$)/),
      kind: z.enum(["file", "directory"]), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      size: z.number().int().nonnegative(), mode: z.number().int().min(0).max(0o777),
      device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/),
      mtimeNs: z.string().regex(/^\d+$/), ctimeNs: z.string().regex(/^\d+$/),
    })).min(1).max(4096),
  }).optional(),
  inPlaceManagedWriterSession: z.strictObject({
    schema: z.literal("pkm.legacy-managed-writer-session/v1"),
    sessionId: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    retrieval: z.strictObject({
      completedRequests: z.number().int().nonnegative().max(10_000),
      completedBuilds: z.number().int().positive().max(10_000).optional(), workerDrain: z.literal("unknown"),
    }).refine(value => value.completedRequests > 0 || value.completedBuilds !== undefined).optional(),
    files: z.array(z.strictObject({
      path: z.string().regex(/^\.pkm\/state\/managed-writer-session(?:\/|$)/),
      kind: z.enum(["file", "directory"]), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      size: z.number().int().nonnegative(), mode: z.number().int().min(0).max(0o777),
      device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/),
      mtimeNs: z.string().regex(/^\d+$/), ctimeNs: z.string().regex(/^\d+$/),
    })).min(1).max(20_000),
  }).optional(),
  inPlaceUiBootstrap: z.strictObject({
    schema: z.literal("pkm.legacy-ui-bootstrap-compatibility/v1"),
    root: z.string(),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    privateRootGuard: z.strictObject({
      device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/),
      uid: z.string().regex(/^\d+$/), mode: z.number().int().min(0).max(0o777),
      ancestors: z.array(z.strictObject({
        path: z.string(), device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/),
        uid: z.string().regex(/^\d+$/), mode: z.number().int().min(0).max(0o777),
      })).min(1).max(64).optional(),
      containers: z.array(z.strictObject({
        path: z.enum([".pkm", ".pkm/state"]), device: z.string().regex(/^\d+$/),
        inode: z.string().regex(/^\d+$/), mode: z.number().int().min(0).max(0o777),
        ctimeNs: z.string().regex(/^\d+$/),
      })).length(2).optional(),
    }).optional(),
    files: z.array(z.strictObject({
      path: z.string().regex(/^(?:project(?:\/|$)|\.pkm\/state\/(?:(?:actions|diagnostics|mcp-usage|project-store-migration|project-store\.json|projects\.json)(?:\/|$)|knowledge-deletions\.json$|recipe-health\.json$|recipe-runs(?:$|\/recipe_run_[a-f0-9]{24}\.json$)))/),
      kind: z.enum(["file", "directory"]), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      size: z.number().int().nonnegative(), mode: z.number().int().min(0).max(0o777),
      device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/),
      mtimeNs: z.string().regex(/^\d+$/), ctimeNs: z.string().regex(/^\d+$/),
    })).min(1).max(20_000),
    knowledgeDeletions: z.strictObject({
      schema: z.literal(1), sha256: z.string().regex(/^[a-f0-9]{64}$/),
      records: z.number().int().min(0).max(10_000), authority: z.literal("preserved-original-sync-only"),
    }).optional(),
    project: z.strictObject({
      rootId: z.string(), storeVersion: z.number().int().positive(),
      sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), canonicalDigest: z.string().regex(/^[a-f0-9]{64}$/),
      orderedReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
      counts: z.strictObject({
        projects: z.number().int().nonnegative(), threads: z.number().int().nonnegative(),
        ganttTasks: z.number().int().nonnegative(), collaborationTasks: z.number().int().nonnegative(),
        recipes: z.number().int().nonnegative(),
      }),
    }),
    components: z.strictObject({
      project: z.literal("verified-cutover"), recipes: z.literal("validated-preserved-envelope"),
      actions: z.literal("blocked-no-workers"), telemetry: z.literal("paired-completed"),
      knowledgeDeletions: z.literal("validated-preserved-original-sync-only").optional(),
    }),
  }).optional(),
  inPlaceChatroomArchives: z.array(inPlaceChatroomArchiveSchema).max(32).optional(),
  limits: legacyImportLimitsSchema,
  preflight: migrationPreflightReportSchema,
  blockers: z.array(migrationPreflightReportSchema.shape.blockers.element),
  entries: z.array(legacyImportEntrySchema),
  boards: z.array(legacyImportBoardSchema),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  statePlan: legacyStateImportPlanSchema.optional(),
  trashPlan: legacyTrashImportPlanSchema.optional(),
  recipeTrashPlan: legacyRecipeTrashImportPlanSchema.optional(),
  skillsHistoryArchive: legacySkillsHistoryArchiveSchema.optional(),
  projectEnvelopePlan: z.unknown().optional(),
  memoryPlan: legacyMemoryImportPlanSchema.optional(),
  routerConfigPlan: legacyRouterConfigPlanSchema.optional(),
  retrievalHistoryPlan: legacyRetrievalHistoryPlanSchema.optional(),
}).superRefine((plan, context) => {
  if (plan.inPlacePkmPrivacySha256 && !plan.inPlaceOnly)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["inPlacePkmPrivacySha256"], message: "In-place privacy bindings require an adoption-only plan." });
  if (plan.inPlaceEmptyActionSettingsSha256 && (!plan.inPlaceOnly || !plan.inPlacePkmPrivacySha256
    || !plan.entries.some(entry => entry.source === ".pkm/state/actions/settings.json"
      && entry.sha256 === plan.inPlaceEmptyActionSettingsSha256)))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["inPlaceEmptyActionSettingsSha256"],
      message: "Empty Action settings require their exact privacy-bound in-place source bytes." });
  if (plan.inPlaceUiBootstrap) {
    const receipt = plan.inPlaceUiBootstrap;
    const deletionFiles = receipt.files.filter(file => file.path === ".pkm/state/knowledge-deletions.json");
    if (receipt.knowledgeDeletions
      ? deletionFiles.length !== 1 || deletionFiles[0]!.kind !== "file"
        || deletionFiles[0]!.sha256 !== receipt.knowledgeDeletions.sha256
        || receipt.components.knowledgeDeletions !== "validated-preserved-original-sync-only"
      : deletionFiles.length !== 0 || receipt.components.knowledgeDeletions !== undefined)
      context.addIssue({ code: "custom", path: ["inPlaceUiBootstrap", "knowledgeDeletions"],
        message: "Original Sync deletions require one exact immutable source file and no native Sync authority." });
    if (!plan.inPlaceOnly || !plan.inPlacePkmPrivacySha256 || receipt.root !== plan.sourceRoot
      || new Set(receipt.files.map(file => file.path)).size !== receipt.files.length
      || receipt.files.some(file => {
        const entry = plan.entries.find(candidate => candidate.source === file.path);
        return !entry || entry.kind !== (file.kind === "file" ? "asset" : "directory") || entry.mode !== file.mode
          || file.kind === "file" && (!file.sha256 || entry.sha256 !== file.sha256 || entry.size !== file.size)
          || file.kind === "directory" && file.sha256 !== undefined;
      })) context.addIssue({ code: "custom", path: ["inPlaceUiBootstrap"], message: "UI bootstrap semantics require their exact in-place source inventory." });
  }
  if (plan.inPlaceApiChatArchive) {
    if (!plan.inPlaceOnly || !plan.inPlacePkmPrivacySha256)
      context.addIssue({ code: "custom", path: ["inPlaceApiChatArchive"], message: "API Chat archive requires an in-place privacy-bound plan." });
    const files = plan.inPlaceApiChatArchive.files;
    const entries = plan.entries.filter(entry => /^\.pkm\/state\/(?:api-chats|api-chat-history|agent-groups|agent-sessions|api-chat-worker-trees|api-chat-worker-results|api-chat-control)(?:\/|$)/.test(entry.source));
    if (new Set(files.map(file => file.path)).size !== files.length || entries.length !== files.length
      || files.some(file => {
        const entry = entries.find(candidate => candidate.source === file.path);
        return !entry || entry.kind !== (file.kind === "file" ? "asset" : "directory") || entry.mode !== file.mode
          || file.kind === "file" && (!file.sha256 || entry.sha256 !== file.sha256 || entry.size !== file.size)
          || file.kind === "directory" && file.sha256 !== undefined;
      })) context.addIssue({ code: "custom", path: ["inPlaceApiChatArchive"], message: "API Chat archive entries do not match the pinned inventory." });
  }
  if (plan.inPlaceManagedWriterSession) {
    const receipt = plan.inPlaceManagedWriterSession;
    if (!plan.inPlaceOnly || !plan.inPlacePkmPrivacySha256 || new Set(receipt.files.map(file => file.path)).size !== receipt.files.length)
      context.addIssue({ code: "custom", path: ["inPlaceManagedWriterSession"], message: "Managed writer session requires a unique in-place privacy-bound inventory." });
    const entries = plan.entries.filter(entry => entry.source.startsWith(".pkm/state/managed-writer-session"));
    if (entries.length !== receipt.files.length || receipt.files.some(file => {
      const entry = entries.find(candidate => candidate.source === file.path);
      return !entry || entry.kind !== (file.kind === "file" ? "asset" : "directory") || entry.mode !== file.mode
        || file.kind === "file" && (!file.sha256 || entry.sha256 !== file.sha256 || entry.size !== file.size)
        || file.kind === "directory" && file.sha256 !== undefined;
    })) context.addIssue({ code: "custom", path: ["inPlaceManagedWriterSession"], message: "Managed writer session entries do not match the exact pinned inventory." });
  }
  if (plan.inPlaceChatroomArchives && !plan.inPlaceOnly)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["inPlaceChatroomArchives"], message: "In-place Chatroom archives require an adoption-only plan." });
  if (plan.inPlaceChatroomArchives && new Set(plan.inPlaceChatroomArchives.map(archive => archive.roomId)).size !== plan.inPlaceChatroomArchives.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["inPlaceChatroomArchives"], message: "In-place Chatroom room IDs must be unique." });
  if (plan.inPlaceChatroomArchives) {
    const pinnedFiles = plan.inPlaceChatroomArchives.flatMap(archive => archive.files);
    const chatroomEntries = plan.entries.filter(entry => entry.source.startsWith("chatrooms/") && entry.kind !== "directory");
    if (pinnedFiles.length !== chatroomEntries.length || pinnedFiles.some(file => {
      const entry = chatroomEntries.find(candidate => candidate.source === file.path);
      return !entry || entry.kind !== "asset" || entry.sha256 !== file.sha256 || entry.size !== file.size || entry.mode !== file.mode;
    })) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["inPlaceChatroomArchives"], message: "Every retained Chatroom file must be byte- and mode-bound by the adoption import entries." });
    }
  }
  let described: ReturnType<typeof describeLegacySkillsHistoryArchive>;
  try { described = describeLegacySkillsHistoryArchive(plan.entries); }
  catch { context.addIssue({ code: z.ZodIssueCode.custom, path: ["skillsHistoryArchive"], message: "Invalid Skills history archive inventory." }); return; }
  if (JSON.stringify(described) !== JSON.stringify(plan.skillsHistoryArchive))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["skillsHistoryArchive"], message: "Skills history archive summary does not match its mapped entries." });
});

export const legacyImportReceiptSchema = z.strictObject({
  schema: z.literal("pkm.legacy-import-receipt/v1"),
  destination: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  receiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  documentCount: z.number().int().nonnegative(),
  assetCount: z.number().int().nonnegative(),
  boardCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  documents: z.array(z.strictObject({ path: z.string(), documentId: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  assets: z.array(z.strictObject({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(),
    mode: z.number().int().min(0).max(0o777).optional() })),
  archivedDirectories: z.array(z.strictObject({ path: z.string(), mode: z.number().int().min(0).max(0o777) })).optional(),
  boards: z.array(legacyImportBoardSchema),
  statePlan: legacyStateImportPlanSchema.optional(),
  routerConfigPlan: legacyRouterConfigPlanSchema.optional(),
  retrievalHistoryPlan: legacyRetrievalHistoryPlanSchema.optional(),
  legacyTrash: z.strictObject({
    planSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    markerSha256: z.string().regex(/^[a-f0-9]{64}$/),
    authority: z.strictObject({
      source: z.string().min(1), destination: z.string().min(1), stage: z.string().min(1),
      workspaceId: z.string().uuid(), actorId: z.string().min(1).max(500),
      planSha256: z.string().regex(/^[a-f0-9]{64}$/),
      layoutVersion: z.literal("pkm.trash-lifecycle/v1"),
    }),
  }).optional(),
  importPlanSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  controls: z.array(z.strictObject({
    path: z.string(),
    table: z.enum(["legacy_project_control", "legacy_recipe_control"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
  })).optional(),
  recipeTrashPlan: legacyRecipeTrashImportPlanSchema.optional(),
  skillsHistoryArchive: legacySkillsHistoryArchiveSchema.optional(),
  memoryImport: legacyMemoryImportReceiptSchema.optional(),
  memoryScopeContinuity: memoryScopeContinuitySchema.optional(),
  projectEnvelope: z.strictObject({
    schema: z.literal("pkm.legacy-project-envelope-adoption/v1"),
    workspaceId: z.string().uuid(),
    stageId: z.string().uuid(),
    sourcePath: z.literal(".pkm/state/projects.json"),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceBytes: z.number().int().nonnegative(),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    projectionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    rootId: z.string().min(1).max(4096),
    storeVersion: z.number().int().positive(),
    projectControlSha256: z.string().regex(/^[a-f0-9]{64}$/),
    orderedReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    counts: z.strictObject({
      projects: z.number().int().nonnegative(), threads: z.number().int().nonnegative(),
      ganttTasks: z.number().int().nonnegative(), collaborationTasks: z.number().int().nonnegative(),
      recipes: z.number().int().nonnegative(),
    }),
  }).optional(),
});

export const legacyImportOutcomeSchema = z.strictObject({
  schema: z.literal("pkm.legacy-import-outcome/v1"),
  token: z.string().uuid(),
  destination: z.string(),
  workspaceId: z.string().uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.literal("prepared"),
  receipt: legacyImportReceiptSchema,
});

export function legacyImportNoReplacePlatformError(platform: string): string | undefined {
  return noReplacePlatformSupported(platform)
    ? undefined
    : "Atomic no-replace directory publication requires Linux or Windows; target was not published.";
}

export type LegacyImportLimits = z.infer<typeof legacyImportLimitsSchema>;
export type LegacyImportEntry = z.infer<typeof legacyImportEntrySchema>;
export type LegacyImportBoard = z.infer<typeof legacyImportBoardSchema>;
export type LegacyImportPlan = z.infer<typeof legacyImportPlanSchema>;
export type LegacyImportReceipt = z.infer<typeof legacyImportReceiptSchema>;
export type LegacyImportOutcome = z.infer<typeof legacyImportOutcomeSchema>;
