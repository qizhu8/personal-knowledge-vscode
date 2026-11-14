import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const type = z.enum(["skills", "notes", "papers", "prompts", "scripts", "packages", "servers", "recipes", "agentSnapshots", "actions", "action-module-sets", "profiles"]);
const privacy = z.enum(["public", "private"]);
const text = z.string().min(1).max(512);
export const syncPlanLimits = Object.freeze({
  nonNoteFiles: 1000, markdownBytes: 1_048_576, totalBytes: 8 * 1024 * 1024, noteAssetBytes: 16 * 1024 * 1024,
});
export function syncNoteFileHasUnlimitedText(file: { readonly type: string; readonly path: string }): boolean {
  return file.type === "notes"
    && (file.path.toLowerCase().endsWith(".md") || file.path.split("/").at(-1)?.toLowerCase() === "pkm-todo-board.json");
}
const file = z.strictObject({
  path: text, type, itemId: text, member: z.string().max(512),
  category: z.string().max(512), privacy, digest,
  contentBase64: z.string().optional(),
});
const deletion = z.strictObject({
  type, itemId: text, deletedAt: z.string().datetime({ offset: true }),
  category: z.string().max(512).optional(), privacy: privacy.optional(),
});
export const syncPlanManifestSchema = z.strictObject({
  schema: z.literal(3),
  minimumExtensionVersion: z.string().max(128).optional(),
  capabilities: z.strictObject({
    storage: z.literal("pkm.github.publication/v1"),
    required: z.array(z.enum(["explicit-deletions", "stable-entity-identity", "entity-partial-progress", "action-library-assets", "profile-cards"])).max(5),
  }),
  files: z.array(file),
  deletions: z.array(deletion),
}).superRefine((manifest, context) => {
  const nonNoteFiles = manifest.files.filter(item => item.type !== "notes").length;
  if (nonNoteFiles > syncPlanLimits.nonNoteFiles) {
    context.addIssue({ code: "custom", path: ["files"], message: "Non-Notes file count limit exceeded." });
  }
  const nonNoteDeletions = manifest.deletions.filter(item => item.type !== "notes").length;
  if (nonNoteDeletions > syncPlanLimits.nonNoteFiles) {
    context.addIssue({ code: "custom", path: ["deletions"], message: "Non-Notes deletion count limit exceeded." });
  }
});
const snapshot = z.strictObject({ manifest: syncPlanManifestSchema, sha256: digest });
export const syncPlanInputSchema = z.strictObject({ base: snapshot, local: snapshot, remote: snapshot });
export const syncPlanCreateSchema = z.strictObject({
  sessionId: z.string().uuid(), operationId: z.string().uuid(),
  actorId: z.string().trim().min(1).max(200), input: syncPlanInputSchema,
});
export const syncPlanDecisionSchema = z.strictObject({
  sessionId: z.string().uuid(), operationId: z.string().uuid(), actorId: z.string().trim().min(1).max(200),
  expectedRevision: z.number().int().safe().min(1), conflictId: digest,
  choice: z.enum(["base", "local", "remote", "delete"]), reason: z.string().trim().min(1).max(4000),
});
const state = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("live"), files: z.array(file).min(1) }),
  z.strictObject({ kind: z.literal("deleted"), deletion }),
  z.strictObject({ kind: z.literal("absent") }),
]);
const conflict = z.strictObject({
  id: digest, type, itemId: text, reason: z.enum(["path-collision", "unrecorded-absence", "missing-deletion-history", "move-review", "unrecorded-member-absence", "concurrent-change"]),
  base: state, local: state, remote: state,
});
export const syncPlanResultSchema = z.strictObject({
  schema: z.literal("pkm.sync-plan/v1"),
  pins: z.strictObject({ base: digest, local: digest, remote: digest }),
  proposals: z.array(z.strictObject({ type, itemId: text, source: z.enum(["local", "remote", "both"]), state })),
  conflicts: z.array(conflict),
  deletionHistory: z.array(z.strictObject({ source: z.enum(["base", "local", "remote"]), deletion })),
});
export const syncPlanSessionSchema = z.strictObject({
  sessionId: z.string().uuid(), revision: z.number().int().safe().min(1), plan: syncPlanResultSchema,
  decisions: z.array(z.strictObject({
    operationId: z.string().uuid(), actorId: z.string().min(1).max(200), conflictId: digest,
    choice: z.enum(["base", "local", "remote", "delete"]), reason: z.string().min(1).max(4000),
    revision: z.number().int().safe().min(2),
  })),
});
export type SyncManifest = z.infer<typeof syncPlanManifestSchema>;
export type SyncPlanInput = z.infer<typeof syncPlanInputSchema>;
export type SyncPlanCreate = z.infer<typeof syncPlanCreateSchema>;
export type SyncPlanDecision = z.infer<typeof syncPlanDecisionSchema>;

export const syncPlanDefinitions = [
  { id: "sync.plan", readOnly: true, description: "Offline three-way manifest planning only; no GitHub adapter or writes.", input: syncPlanInputSchema, output: syncPlanResultSchema },
  { id: "sync.plan.create", readOnly: false, description: "Persist an actor-private offline planning session, not a sync operation.", input: syncPlanCreateSchema.omit({ actorId: true }), output: syncPlanSessionSchema },
  { id: "sync.plan.get", readOnly: true, description: "Read the caller's offline planning session.", input: z.strictObject({ sessionId: z.string().uuid() }), output: syncPlanSessionSchema },
  { id: "sync.plan.decide", readOnly: false, description: "Record an explicit, revision-pinned resolution proposal; never applies it.", input: syncPlanDecisionSchema.omit({ actorId: true }), output: syncPlanSessionSchema },
] as const;
