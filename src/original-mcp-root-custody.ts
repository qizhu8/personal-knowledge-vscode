import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { validatePrivacyPolicy } from "./legacy-content-privacy.js";
import { bindKnowledgeReadRestriction } from "./fresh-note-query-contracts.js";

export const originalMcpJournal = ".pkm-next-original-mcp.json";
export const originalMcpCommit = ".pkm-next-original-mcp.commit.json";
export const originalMcpRollback = ".pkm-next-original-mcp.rollback.json";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const originalMcpLimits = z.strictObject({
  maxEntries: z.number().int().min(1).max(1_000_000),
  maxDepth: z.number().int().min(1).max(64),
  maxBytes: z.number().int().min(1).max(274_877_906_944),
  maxFileBytes: z.number().int().min(1).max(68_719_476_736),
});
export const originalMcpPlanV1Schema = z.strictObject({
  schema: z.literal("pkm.original-mcp-custody/v1"),
  root: z.string(), device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/),
  operatorId: z.string().min(1).max(128), profileSha256: digest,
  backup: z.string(), inventorySha256: digest, privacySha256: digest,
  entries: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(),
  limits: originalMcpLimits, auxiliary: z.array(z.string()).max(64),
  planSha256: digest,
});
export const originalMcpPlanV2Schema = originalMcpPlanV1Schema.extend({
  schema: z.literal("pkm.original-mcp-custody/v2"),
});
export const originalMcpPlanV3Schema = originalMcpPlanV2Schema.extend({
  schema: z.literal("pkm.original-mcp-custody/v3"),
});
export const originalMcpPlanSchema = z.discriminatedUnion("schema", [originalMcpPlanV1Schema, originalMcpPlanV2Schema, originalMcpPlanV3Schema]);
export type OriginalMcpPlan = z.infer<typeof originalMcpPlanSchema>;
export const originalMcpJournalV1Schema = z.strictObject({
  schema: z.literal("pkm.original-mcp-root/v1"), token: z.string().uuid(), workspaceId: z.string().uuid(),
  plan: originalMcpPlanV1Schema, journalSha256: digest,
});
export const originalMcpJournalV2Schema = originalMcpJournalV1Schema.extend({
  schema: z.literal("pkm.original-mcp-root/v2"), plan: originalMcpPlanV2Schema,
});
export const originalMcpJournalV3Schema = originalMcpJournalV2Schema.extend({
  schema: z.literal("pkm.original-mcp-root/v3"), plan: originalMcpPlanV3Schema,
});
export const originalMcpJournalSchema = z.discriminatedUnion("schema", [originalMcpJournalV1Schema, originalMcpJournalV2Schema, originalMcpJournalV3Schema]);
export type OriginalMcpJournal = z.infer<typeof originalMcpJournalSchema>;
export const originalMcpCommitSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-root-commit/v1"),
  journalSha256: digest, databaseSha256: digest, receiptSha256: digest,
});
export const originalMcpManagedNames = new Set([
  originalMcpJournal, originalMcpCommit, originalMcpRollback, ".pkm-next-workspace", ".pkm-next-writer-fenced.json",
  "core.sqlite", "core.sqlite-wal", "core.sqlite-shm",
]);
export const originalMcpPreservedNames = new Set([
  ".pkm", "chatrooms", "knowledge.db", "knowledge.db-wal", "knowledge.db-shm", "knowledge.db-journal",
  "notes", "skills", "papers", "AGENTS.md", ".gitignore",
]);
const scriptPreservedNames = new Set([...originalMcpPreservedNames, "scripts"]);
const opaquePreservedNames = new Set([...scriptPreservedNames, "prompts"]);
export function originalMcpPreservedNamesForPlan(schema: OriginalMcpPlan["schema"]): ReadonlySet<string> {
  if (schema === "pkm.original-mcp-custody/v1") return originalMcpPreservedNames;
  if (schema === "pkm.original-mcp-custody/v2") return scriptPreservedNames;
  if (schema === "pkm.original-mcp-custody/v3") return opaquePreservedNames;
  originalMcpFailure("Unknown original MCP custody preservation version.");
}
export const originalMcpAuxiliaryNames = new Set([
  ".git", "_feedback", "_proposals", "action-sources", "action-module-sets", "actions", "codebases", "envs", "mcp-server",
  "packages", "project", "prompts", "recipes", "scripts", "servers",
]);
export const jsonDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function originalMcpFailure(message: string): never {
  throw new CoreError("RECOVERY_REQUIRED", message);
}
export function parseOriginalMcpPlan(input: unknown): OriginalMcpPlan {
  const plan = originalMcpPlanSchema.parse(input);
  const { planSha256, ...body } = plan;
  if (jsonDigest(body) !== planSha256 || plan.entries > plan.limits.maxEntries || plan.bytes > plan.limits.maxBytes)
    originalMcpFailure("Original MCP plan digest or explicit inventory bounds changed.");
  return plan;
}
export function originalMcpPrivateBytes(path: string, maximumBytes = 65_536): Buffer {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximumBytes)
    || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o7077n) !== 0n)
    originalMcpFailure("Original MCP custody controls must be private, owned, bounded single-link files.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const pin = (s: typeof before) => [s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (pin(before) !== pin(opened)) originalMcpFailure("Original MCP control identity changed while opening.");
    const bytes = readFileSync(fd);
    if (pin(opened) !== pin(fstatSync(fd, { bigint: true }))
      || pin(opened) !== pin(lstatSync(path, { bigint: true })) || BigInt(bytes.length) !== opened.size)
      originalMcpFailure("Original MCP control changed while reading.");
    return bytes;
  } finally { closeSync(fd); }
}
export function readOriginalMcpJournal(root: string): OriginalMcpJournal | undefined {
  if (!lstatSync(join(root, originalMcpJournal), { throwIfNoEntry: false })) return;
  try {
    const journal = originalMcpJournalSchema.parse(JSON.parse(originalMcpPrivateBytes(join(root, originalMcpJournal)).toString("utf8")));
    const { journalSha256, ...body } = journal;
    const { planSha256, ...plan } = journal.plan;
    const stat = lstatSync(root, { bigint: true });
    if (process.platform !== "linux" || realpathSync(root) !== root || !stat.isDirectory() || stat.isSymbolicLink()
      || journal.plan.root !== root || String(stat.dev) !== journal.plan.device || String(stat.ino) !== journal.plan.inode
      || jsonDigest(body) !== journalSha256 || jsonDigest(plan) !== planSha256)
      originalMcpFailure("Original MCP custody is not bound to this root and exact plan.");
    return journal;
  } catch { originalMcpFailure("Original MCP custody journal is invalid; exact offline recovery is required."); }
}
const restrictedRoots = new Map<string, string>();
export function assertOriginalMcpPrivacy(root: string): OriginalMcpJournal | undefined {
  const journal = readOriginalMcpJournal(root);
  if (!journal) return;
  const bytes = originalMcpPrivateBytes(join(root, ".pkm", "content-privacy.json"), 2_097_152);
  validatePrivacyPolicy(bytes);
  if (createHash("sha256").update(bytes).digest("hex") !== journal.plan.privacySha256)
    originalMcpFailure("The archive-only original privacy policy changed.");
  const prior = restrictedRoots.get(root);
  if (prior !== undefined && prior !== journal.journalSha256)
    originalMcpFailure("A changed original MCP root requires a new process and explicit admission.");
  if (prior === undefined) {
    const expected = journal.journalSha256;
    bindKnowledgeReadRestriction(root, { privateTopLevels(area) {
      if (readOriginalMcpJournal(root)?.journalSha256 !== expected)
        originalMcpFailure("The original MCP private-denial binding changed while live.");
      return originalMcpPrivateTopLevels(root, area);
    } });
    restrictedRoots.set(root, expected);
  }
  return journal;
}

export function requireOriginalMcpScriptCustody(root: string): OriginalMcpJournal | undefined {
  const journal = assertOriginalMcpPrivacy(root);
  if (journal && journal.plan.schema === "pkm.original-mcp-custody/v1")
    originalMcpFailure("Script reads require a fresh version-2 custody capture and explicit original-root re-admission.");
  return journal;
}

/** Original restrictions remain denials, never a grant to private data or old runtimes. */
export function originalMcpPrivateTopLevels(root: string, area: string): ReadonlySet<string> {
  if (!assertOriginalMcpPrivacy(root)) return new Set();
  const policy = JSON.parse(originalMcpPrivateBytes(join(root, ".pkm", "content-privacy.json"), 2_097_152).toString("utf8"));
  const values: string[] = policy.private[area] ?? [];
  if (values.some(value => value !== value.trim() || /[/\\]/.test(value) || value === "." || value === ".."))
    originalMcpFailure("Original privacy entries require exact, unambiguous top-level names.");
  return new Set(values);
}
