import { z } from "zod";

export const migrationPreflightLimitsSchema = z.strictObject({
  maxEntries: z.number().int().min(1).default(Number.MAX_SAFE_INTEGER),
  maxDepth: z.number().int().min(0).max(32).default(32),
  maxReadBytes: z.number().int().min(0).default(Number.MAX_SAFE_INTEGER),
});
const legacyTrashPreflightPaths = new Set([
  "notes/.trash", "skills/.trash", "papers/.trash", ".pkm/state/knowledge-deletions.json",
  "recipes/.trash", ".pkm/state/projects.json",
]);
export const migrationPreflightOptionsSchema = migrationPreflightLimitsSchema.extend({
  excludedPaths: z.array(z.string().min(1).max(255)).max(6).default([]),
}).superRefine((value, context) => {
  if (new Set(value.excludedPaths).size !== value.excludedPaths.length
    || value.excludedPaths.some(path => !legacyTrashPreflightPaths.has(path))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only exact independently-qualified original trash or ProjectStore envelope paths may be excluded." });
  }
});
export const migrationPreflightEntrySchema = z.strictObject({
  path: z.string(), kind: z.enum(["directory", "document", "asset", "board-backing", "library-file", "unsupported", "symlink"]),
  size: z.number().int().nonnegative().optional(),
  mode: z.number().int().min(0).max(0o777).optional(),
  documentId: z.string().optional(), knowledgeId: z.string().optional(),
  board: z.enum(["descriptor", "backing", "descriptor-and-backing"]).optional(),
});
export const migrationPreflightDiagnosticSchema = z.strictObject({
  code: z.string(), path: z.string(), message: z.string(), relatedPath: z.string().optional(),
});
export const migrationPreflightReportSchema = z.strictObject({
  version: z.literal(1), complete: z.boolean(),
  ready: z.boolean().describe("No detected blockers in this bounded inspection; not import or rollback qualification."),
  limits: migrationPreflightLimitsSchema,
  excludedPaths: z.array(z.string()).optional(),
  entries: z.array(migrationPreflightEntrySchema), blockers: z.array(migrationPreflightDiagnosticSchema),
});
export type MigrationPreflightReport = z.infer<typeof migrationPreflightReportSchema>;
export type MigrationPreflightOptions = z.input<typeof migrationPreflightOptionsSchema>;
