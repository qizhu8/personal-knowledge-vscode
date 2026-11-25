import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";

export const originalActionValidationJob = z.strictObject({
  job_id: z.string().regex(/^validation_[a-f0-9]{32}$/), key: z.string(),
  action_id: z.string(), content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  priority: z.number().int().min(0).max(3), allow_effects: z.boolean(),
  queued_at: z.number(), state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "outcome_unknown", "blocked"]),
  stage: z.string(), depends_on: z.array(z.string()), worker: z.string().optional(),
  started_at: z.string().optional(), completed_at: z.string().optional(),
  cancel_requested: z.boolean().optional(), run_id: z.string().optional(), error: z.string().optional(),
  evidence: z.array(z.strictObject({ run_id: z.string(), passed: z.boolean() })).optional(),
});
export type OriginalActionValidationJob = z.infer<typeof originalActionValidationJob>;
const envelope = z.strictObject({
  workspaceId: z.string().uuid(), actorId: z.literal("mcp:external"),
  previousSha256: z.string().nullable(), job: originalActionValidationJob,
});
const ddl = `CREATE TABLE original_mcp_action_validation(
 sequence INTEGER PRIMARY KEY,payload TEXT NOT NULL,payload_sha256 TEXT NOT NULL);
 CREATE TRIGGER original_mcp_action_validation_no_update BEFORE UPDATE ON original_mcp_action_validation
 BEGIN SELECT RAISE(ABORT,'Action validation history immutable'); END;
 CREATE TRIGGER original_mcp_action_validation_no_delete BEFORE DELETE ON original_mcp_action_validation
 BEGIN SELECT RAISE(ABORT,'Action validation history immutable'); END;`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function readOriginalActionValidation(database: DatabaseSync, workspaceId: string) {
  const jobs = new Map<string, OriginalActionValidationJob>();
  let previousSha256: string | null = null, sequence = 0;
  const present = database.prepare("SELECT 1 FROM sqlite_master WHERE name='original_mcp_action_validation'").get();
  if (!present) return { jobs, previousSha256, sequence };
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(ddl);
    const schema = (db: DatabaseSync) => db.prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'original_mcp_action_validation%' ORDER BY name").all();
    if (JSON.stringify(schema(database)) !== JSON.stringify(schema(expected)))
      throw new CoreError("RECOVERY_CONFLICT", "Action validation journal schema changed.");
  } finally { expected.close(); }
  for (const row of database.prepare("SELECT * FROM original_mcp_action_validation ORDER BY sequence").all()) {
    const value = envelope.parse(JSON.parse(String(row.payload)));
    if (Number(row.sequence) !== ++sequence || hash(String(row.payload)) !== row.payload_sha256
      || value.previousSha256 !== previousSha256 || value.workspaceId !== workspaceId)
      throw new CoreError("RECOVERY_CONFLICT", "Action validation journal binding changed.");
    jobs.set(value.job.job_id, value.job);
    previousSha256 = String(row.payload_sha256);
  }
  return { jobs, previousSha256, sequence };
}
export function appendOriginalActionValidation(database: DatabaseSync, workspaceId: string, job: OriginalActionValidationJob) {
  const state = readOriginalActionValidation(database, workspaceId);
  const previous = state.jobs.get(job.job_id);
  if (previous) {
    const identity = (value: OriginalActionValidationJob) => JSON.stringify([value.job_id, value.key, value.action_id,
      value.content_hash, value.allow_effects, value.queued_at, value.depends_on]);
    const allowed = previous.state === "queued" ? ["queued", "running", "cancelled", "blocked"]
      : previous.state === "running" ? ["running", "succeeded", "failed", "cancelled", "outcome_unknown", "blocked"] : [previous.state];
    if (identity(previous) !== identity(job) || job.priority > previous.priority || !allowed.includes(job.state))
      throw new CoreError("RECOVERY_CONFLICT", "Action validation identity or terminal-state fence changed.");
  }
  if (state.sequence >= 16384 || !state.jobs.has(job.job_id) && state.jobs.size >= 2048)
    throw new CoreError("RESOURCE_LIMIT", "Action validation history capacity reached.");
  if (!state.sequence && !database.prepare("SELECT 1 FROM sqlite_master WHERE name='original_mcp_action_validation'").get()) database.exec(ddl);
  const payload = JSON.stringify(envelope.parse({ workspaceId, actorId: "mcp:external",
    previousSha256: state.previousSha256, job }));
  database.prepare("INSERT INTO original_mcp_action_validation VALUES(?,?,?)").run(state.sequence + 1, payload, hash(payload));
}
