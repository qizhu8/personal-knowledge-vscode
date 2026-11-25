import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { automaticAdmissionDdl, automaticCallsDdl, nestedArtifactDdl, automaticActionOperationId } from "./host-services.js";
import { nestedActionPlansDdl, readNestedActionPlan } from "./action-program-nested-artifacts.js";
import { verifyLegacyActionProposals } from "./legacy-action-mcp.js";
import { readActionCompiler } from "./action-compiler.js";
import { originalDigest } from "./domain/action-compiler-validation.js";
import { verifyOwnedActionArtifact } from "./legacy-action-artifacts.js";
import { exactPipelineArtifactInput } from "./action-runtime.js";
import { runtimeProcessJob } from "./runtime-process-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), identity = z.string().min(1).max(256);
const admission = z.strictObject({
  schema: z.literal("pkm.native-action-automatic-admission/v1"),
  proposalId: z.string().regex(/^proposal_[a-f0-9]{32}$/), actorId: z.literal("mcp:external"), workspaceId: identity,
  actionId: z.string().regex(/^[a-z][a-z0-9_.-]{2,100}$/), contentHash: digest, executableDigest: digest,
  trustEpoch: z.string().uuid(),
});
const link = z.strictObject({ actorId: z.literal("mcp:external"), workspaceId: identity, parentRunId: identity,
  childRunId: identity, artifactId: z.string().regex(/^artifact_[a-f0-9]{32}$/),
  sourceId: z.string().regex(/^artifact_[a-f0-9]{32}$/), childHash: digest });
export const automaticActionSchemaGroups = [
  { ddl: automaticAdmissionDdl, tables: ["native_action_automatic_admissions", "native_action_automatic_readmissions"] },
  { ddl: automaticCallsDdl, tables: ["native_action_automatic_calls"] },
  { ddl: nestedArtifactDdl, tables: ["native_action_nested_artifacts"] },
  { ddl: nestedActionPlansDdl, tables: ["native_action_nested_plans"] },
] as const;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function fail(): never { throw new CoreError("RECOVERY_REQUIRED", "Native registered Action custody lost its exact source, actor, epoch or run binding."); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/** Passive historical integrity only. No source admission, process consent or replay permission is restored. */
export function verifyAutomaticActionCustody(database: DatabaseSync, workspaceId: string, epochs: ReadonlySet<string>) {
  if (!database.isTransaction) fail();
  const rows = (table: string) => {
    const records = database.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT 10001`).all();
    if (records.length > 10000) fail();
    return records;
  };
  const proposals = new Map(verifyLegacyActionProposals(database, workspaceId).map(value => [value.proposal_id, value]));
  const admissions = new Map<string, z.infer<typeof admission>>();
  for (const row of rows("native_action_automatic_admissions")) {
    const value = admission.parse(JSON.parse(String(row.payload))), proposal = proposals.get(value.proposalId);
    if (sha(String(row.payload)) !== row.payload_sha256 || value.workspaceId !== workspaceId || !epochs.has(value.trustEpoch)
      || value.proposalId !== row.proposal_id || value.actorId !== row.actor_id || value.workspaceId !== row.workspace_id
      || value.actionId !== row.action_id || value.contentHash !== row.content_hash
      || value.executableDigest !== row.executable_digest || value.trustEpoch !== row.trust_epoch
      || !proposal || proposal.action_id !== value.actionId || proposal.content_hash !== value.contentHash) fail();
    const definition = Object.fromEntries(Object.entries(proposal.definition).filter(([key]) => key !== "knowledgeId"));
    const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source: { kind: "inline", definition } } }) as
      { status: string; definitionDigest?: string };
    if (compiled.status !== "valid" || compiled.definitionDigest !== value.executableDigest) fail();
    admissions.set(value.proposalId, value);
  }
  for (const row of rows("native_action_automatic_readmissions")) {
    const value = admission.parse(JSON.parse(String(row.payload))), original = admissions.get(value.proposalId);
    if (!original || sha(String(row.payload)) !== row.payload_sha256 || value.proposalId !== row.proposal_id
      || value.trustEpoch !== row.trust_epoch || !epochs.has(value.trustEpoch)
      || originalDigest({ ...original, trustEpoch: value.trustEpoch }) !== originalDigest(value)) fail();
  }
  const runs = new Set<string>();
  const runSources = new Map<string, { admission: z.infer<typeof admission>; inputs: unknown }>();
  for (const row of rows("native_action_automatic_calls")) {
    if (row.actor_id !== "mcp:external" || typeof row.idempotency_key !== "string" || !row.idempotency_key.trim()
      || !digest.safeParse(row.request_sha256).success || !z.string().uuid().safeParse(row.operation_id).success
      || row.operation_id !== automaticActionOperationId(workspaceId, String(row.actor_id), row.idempotency_key)
      || row.run_id !== `action_run_${String(row.operation_id).replaceAll("-", "")}` || !Number.isSafeInteger(row.deadline)) fail();
    const stored = database.prepare("SELECT version,snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?")
      .get(row.actor_id, row.run_id);
    if (!stored) fail();
    const run = JSON.parse(String(stored.snapshot));
    const selected = [...admissions.values()].find(value => value.actionId === run.actionId
      && value.executableDigest === run.definitionDigest && row.request_sha256 === sha(canonical({
        proposalId: value.proposalId, actionId: value.actionId, contentHash: value.contentHash, inputs: run.inputs,
      })));
    if (!selected || run.runId !== row.run_id || run.version !== stored.version || run.deadline !== row.deadline) fail();
    const proposal = proposals.get(selected.proposalId)!;
    const definition = Object.fromEntries(Object.entries(proposal.definition).filter(([key]) => key !== "knowledgeId"));
    const source = { kind: "inline", definition };
    const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source } }) as
      { definition?: unknown; source?: unknown };
    if (originalDigest(run.sourceSnapshot) !== originalDigest(source)
      || originalDigest(run.definition) !== originalDigest(compiled.definition)
      || originalDigest(run.source) !== originalDigest(compiled.source)) fail();
    for (const entry of z.array(z.strictObject({ kind: z.literal("manual"),
      expectedVersion: z.number().safe().int().positive(), sourceReceiptSha256: digest,
      outcome: z.literal("succeeded"), at: z.number().safe().int().nonnegative(),
      evidence: z.strictObject({ reason: z.string().trim().min(1).max(4096), output: z.record(z.string(), z.json()),
        observation: z.strictObject({ processJobId: z.string().uuid(), processOperationId: z.string().uuid(),
          processReceiptSha256: digest, processJobSha256: digest, processOwnerId: z.string().uuid(), outputSha256: digest }) }),
    })).max(1).parse(run.reconciliations ?? [])) {
      const observed = entry.evidence.observation;
      const sourceReceipt = database.prepare("SELECT payload_sha256 FROM native_action_automatic_admissions WHERE proposal_id=?")
        .get(selected.proposalId);
      const receipt = database.prepare("SELECT record_json,fingerprint FROM runtime_process_jobs WHERE actor_id=? AND job_id=? AND operation_id=?")
        .get(row.actor_id, observed.processJobId, observed.processOperationId);
      if (!receipt || sourceReceipt?.payload_sha256 !== entry.sourceReceiptSha256
        || receipt.fingerprint !== observed.processReceiptSha256 || entry.expectedVersion >= run.version
        || originalDigest(entry.evidence.output) !== observed.outputSha256
        || originalDigest(run.reconciledOutput) !== observed.outputSha256) fail();
      const job = runtimeProcessJob.parse(JSON.parse(String(receipt.record_json)));
      if (job.actorId !== row.actor_id || job.ownerId !== observed.processOwnerId || job.adapterId !== "trusted-program"
        || job.jobId !== observed.processJobId || job.operationId !== observed.processOperationId
        || job.state !== "SUCCEEDED" || job.effect !== "completed" || job.exitCode !== 0 || job.signal !== null
        || originalDigest(job) !== observed.processJobSha256) fail();
    }
    runs.add(run.runId);
    runSources.set(run.runId, { admission: selected, inputs: run.inputs });
  }
  for (const row of rows("native_action_nested_plans")) {
    const plan = readNestedActionPlan(database, String(row.actor_id), String(row.child_run_id));
    if (!plan || plan.workspaceId !== workspaceId || !epochs.has(plan.trustEpoch)
      || !runs.has(plan.parentRunId) || !runs.has(plan.childRunId)) fail();
  }
  for (const row of rows("native_action_nested_artifacts")) {
    const value = link.parse(JSON.parse(String(row.payload)));
    const plan = readNestedActionPlan(database, value.actorId, value.childRunId);
    if (sha(String(row.payload)) !== row.payload_sha256 || value.workspaceId !== workspaceId
      || value.actorId !== row.actor_id || value.parentRunId !== row.parent_run_id || value.childRunId !== row.child_run_id
      || value.artifactId !== row.artifact_id || !runs.has(value.parentRunId) || !runs.has(value.childRunId)
      || !plan || plan.parentRunId !== value.parentRunId || plan.sourceId !== value.sourceId || plan.childHash !== value.childHash
      || runSources.get(value.childRunId)?.admission.contentHash !== value.childHash
      || exactPipelineArtifactInput(runSources.get(value.parentRunId)?.inputs) !== value.sourceId) fail();
    verifyOwnedActionArtifact(database, workspaceId, { id: value.actorId, canWrite: true },
      value.childRunId, value.artifactId, value.parentRunId);
  }
}
