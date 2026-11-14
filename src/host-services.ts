import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import type { Actor } from "./contracts.js";
import type { Storage } from "./storage.js";
import {
  ActionRuntime, actionRuntimeDefinitions, mutateActionRuntime, readActionRuntime, validatePurePipeline,
  exactPipelineArtifactInput, hasArtifactField, isPipelineArtifactForward,
  type ActionNativeAdapter, type ActionInvocation, type ActionAuthorizationBinding, type ActionRuntimeHostRequest,
} from "./action-runtime.js";
import { createActionProcessBridge, type ActionProcessBridgeOptions } from "./action-runtime-process.js";
import { pureComponentAdapter, pureComponentAvailable } from "./action-pure-components.js";
import { artifactAdapter } from "./action-artifact-adapter.js";
import { admitLegacyActionArtifactPath, inspectActionArtifact, legacyActionArtifact,
  managedActionArtifactOwner, verifyOwnedActionArtifact } from "./legacy-action-artifacts.js";
import { inspectActionBuild } from "./action-program-build.js";
import { nestedActionPlansDdl, readNestedActionPlan, writeNestedActionPlan, type NestedActionPlan } from "./action-program-nested-artifacts.js";
import { readActionCompiler } from "./action-compiler.js";
import { builtinActionDefinitions, exactRunnableArtifactBuiltin, exactRunnablePureBuiltin,
  originalDefinitionValue, originalDigest } from "./domain/action-compiler-validation.js";
import {
  assertWorkspaceBackupQuiescent, createWorkspaceBackup, restoreWorkspaceBackup,
  type WorkspaceBackupOptions, type WorkspaceQuiescenceLease,
} from "./workspace-backup.js";

export interface HostBackupRequest {
  operation: "backup" | "restore";
  transport: "native-host" | "cli";
  workspaceId: string;
  destination: string;
  backupPath?: string;
}

export interface AutomaticActionTrustContext {
  workspaceId: string;
  actorId: string;
  trustedWorkspace: boolean;
  epoch: string;
}

export interface AutomaticActionTrustAuthority {
  /** Supplied only by the trusted native host; MCP input cannot set or override it. */
  current(): AutomaticActionTrustContext;
  /** Refreshes trust from the owning VS Code process when the host uses a process bridge. */
  refresh?(): Promise<AutomaticActionTrustContext>;
  /** Rechecks the exact revision and current epoch immediately before native process launch. */
  authorize?(actionId: string, contentHash: string, epoch: string): Promise<boolean>;
  pickArtifactSource?(epoch: string): Promise<{ path: string; selectedRoot: string; expectedSha256: string; size: number } | undefined>;
  pickArtifactDestination?(epoch: string, artifact: { artifactId: string; digest: string; size: number }):
    Promise<{ path: string; selectedRoot: string } | undefined>;
  /** Must revoke trust and advance the epoch before resolving. */
  revoke(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface HostServicesOptions {
  database: DatabaseSync;
  storage: Storage;
  workspaceId: string;
  assertOwner(): void;
  beforeEffect?(): void;
  action?: {
    adapters?: Readonly<Record<string, ActionNativeAdapter>>;
    process?: Omit<ActionProcessBridgeOptions, "database" | "workspaceRoot" | "authorizeLaunch">;
    automaticTrusted?: AutomaticActionTrustAuthority;
    approvePurePipeline?(binding: ActionAuthorizationBinding & { inputs: Record<string, unknown> },
      artifact?: Readonly<{ artifactId: string; digest: string; size: number }>): Promise<boolean>;
    approveManagedArtifact?(binding: ActionAuthorizationBinding & { inputs: Record<string, unknown> },
      source: Readonly<{ artifactId: string; digest: string; size: number }>): Promise<boolean>;
    maxConcurrent?: number;
  };
  onLifecycle?(): void;
  assertQuiescent?(): void;
  acquireQuiescence?(): Promise<WorkspaceQuiescenceLease>;
  authorizeBackup?(request: Readonly<HostBackupRequest>): Promise<boolean> | boolean;
  backupOptions?: Omit<WorkspaceBackupOptions, "database">;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const trustIdentity = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const trustEpoch = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const automaticProposal = z.strictObject({
  schema: z.literal("pkm.action.proposal/v1"),
  proposal_id: z.string().regex(/^proposal_[a-f0-9]{32}$/),
  state: z.literal("pending"),
  action_id: z.string().regex(/^[a-z][a-z0-9_.-]{2,100}$/),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  base_content_hash: z.null(),
  definition: z.record(z.string(), z.json()),
  submitted_at: z.string().datetime(),
});
const automaticProposalEnvelope = z.strictObject({
  actorId: z.string().min(1), workspaceId: z.string().min(1), proposal: automaticProposal,
});
const automaticAdmissionDdl = `
CREATE TABLE IF NOT EXISTS native_action_automatic_admissions(
  proposal_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  action_id TEXT NOT NULL, content_hash TEXT NOT NULL, executable_digest TEXT NOT NULL,
  trust_epoch TEXT NOT NULL, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS native_action_automatic_admissions_no_update
BEFORE UPDATE ON native_action_automatic_admissions BEGIN SELECT RAISE(ABORT,'native Action admission immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_action_automatic_admissions_no_delete
BEFORE DELETE ON native_action_automatic_admissions BEGIN SELECT RAISE(ABORT,'native Action admission immutable'); END;
CREATE TABLE IF NOT EXISTS native_action_automatic_readmissions(
  proposal_id TEXT NOT NULL, trust_epoch TEXT NOT NULL, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  PRIMARY KEY(proposal_id,trust_epoch)
);
CREATE TRIGGER IF NOT EXISTS native_action_automatic_readmissions_no_update
BEFORE UPDATE ON native_action_automatic_readmissions BEGIN SELECT RAISE(ABORT,'native Action readmission immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_action_automatic_readmissions_no_delete
BEFORE DELETE ON native_action_automatic_readmissions BEGIN SELECT RAISE(ABORT,'native Action readmission immutable'); END;`;
const automaticCallsDdl = `
CREATE TABLE IF NOT EXISTS native_action_automatic_calls(
  actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
  operation_id TEXT NOT NULL, run_id TEXT NOT NULL, deadline INTEGER NOT NULL,
  PRIMARY KEY(actor_id,idempotency_key), UNIQUE(actor_id,operation_id), UNIQUE(actor_id,run_id)
);
CREATE TRIGGER IF NOT EXISTS native_action_automatic_calls_no_update
BEFORE UPDATE ON native_action_automatic_calls BEGIN SELECT RAISE(ABORT,'native Action call receipt immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_action_automatic_calls_no_delete
BEFORE DELETE ON native_action_automatic_calls BEGIN SELECT RAISE(ABORT,'native Action call receipt immutable'); END;`;
const nestedArtifactDdl = `
CREATE TABLE IF NOT EXISTS native_action_nested_artifacts(
  actor_id TEXT NOT NULL, parent_run_id TEXT NOT NULL, child_run_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
  payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL, PRIMARY KEY(actor_id,parent_run_id,child_run_id)
);
CREATE TRIGGER IF NOT EXISTS native_action_nested_artifacts_no_update
BEFORE UPDATE ON native_action_nested_artifacts BEGIN SELECT RAISE(ABORT,'native nested artifact immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_action_nested_artifacts_no_delete
BEFORE DELETE ON native_action_nested_artifacts BEGIN SELECT RAISE(ABORT,'native nested artifact immutable'); END;`;
const nestedArtifactLink = z.strictObject({
  actorId: z.literal("mcp:external"), workspaceId: z.string().min(1), parentRunId: z.string().min(1),
  childRunId: z.string().min(1), artifactId: z.string().regex(/^artifact_[a-f0-9]{32}$/),
  sourceId: z.string().regex(/^artifact_[a-f0-9]{32}$/), childHash: z.string().regex(/^[a-f0-9]{64}$/),
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function uuidFromDigest(value: string): string {
  const bytes = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  bytes[12] = "4";
  bytes[16] = (8 + (Number.parseInt(bytes[16]!, 16) & 3)).toString(16);
  const hex = bytes.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Uses the host's initialized connection and global receipt transaction, never a second owner. */
export function createHostServices(options: HostServicesOptions) {
  const { database } = options;
  options.assertOwner();
  if (database.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Host services must be composed after the shared migration commits.");
  const concurrency = options.action?.maxConcurrent ?? 8;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new CoreError("INVALID_CONFIGURATION", "Action scheduling concurrency must be between 1 and 32.");
  }
  if (options.action?.automaticTrusted && (!(options.action.process?.commands.length || options.action.process?.trustedPrograms) || options.action.adapters
    && Object.keys(options.action.adapters).length)) {
    throw new CoreError("INVALID_CONFIGURATION",
      "Automatic trusted Actions require a native process policy and cannot wrap generic Action adapters.");
  }
  if (options.action?.automaticTrusted
    && (typeof options.action.automaticTrusted.current !== "function" || typeof options.action.automaticTrusted.revoke !== "function")) {
    throw new CoreError("INVALID_CONFIGURATION", "Automatic Action trust requires a native host authority with revocation.");
  }
  if (options.action?.automaticTrusted) database.exec(`${automaticAdmissionDdl}${automaticCallsDdl}${nestedArtifactDdl}${nestedActionPlansDdl}`);
  const adapters = { ...options.action?.adapters };
  for (const command of options.action?.process?.commands ?? []) {
    if (Object.hasOwn(adapters, `program:${command.id}`)) {
      throw new CoreError("INVALID_CONFIGURATION", "Action adapter authority must be unique.");
    }
  }
  new ActionRuntime(database, {
    workspaceRoot: options.storage.workspaceRoot(), adapters, initialized: true, deferRecovery: true,
    assertOwner: options.assertOwner,
  });
  const readTrust = (): AutomaticActionTrustContext | undefined => {
    const authority = options.action?.automaticTrusted;
    if (!authority) return undefined;
    try {
      const current = authority.current();
      if (!current || current.workspaceId !== options.workspaceId || !trustIdentity.test(current.actorId)
        || !trustEpoch.test(current.epoch) || typeof current.trustedWorkspace !== "boolean") return undefined;
      return current.trustedWorkspace ? current : undefined;
    } catch { return undefined; }
  };
  const authorizePicked = (actor: Actor, authorityId: string, artifact?: { artifactId: string; digest: string }) => {
    const current = readTrust();
    return !!current && current.actorId === actor.id && actor.canWrite && !actor.boardWorker
      && (authorityId === `pkm-action-picker:${current.epoch}:v1`
        || !!artifact && authorityId === `pkm-action-picker:${current.epoch}:export:${artifact.artifactId}:${artifact.digest}`);
  };
  const nestedCopyHash = String(originalDefinitionValue(builtinActionDefinitions().get("core.artifact.copy")!).content_hash);
  const nestedCopyEnabled = (binding: ActionAuthorizationBinding & { inputs: Record<string, unknown> }) => {
    const dependencies = binding.definition.dependencies;
    const effects = binding.definition.effects;
    return binding.implementation.kind === "program" && binding.implementation.build === undefined
      && isRecord(dependencies) && Object.keys(dependencies).length === 1 && dependencies["core.artifact.copy"] === nestedCopyHash
      && Array.isArray(effects) && ["local-read", "local-write"].every(effect => effects.includes(effect))
      && !!exactPipelineArtifactInput(binding.inputs);
  };
  const readProposal = (proposalId: string, expectedContentHash: string, actorId: string) => {
    const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_action_mcp_proposals'").get();
    if (!exists) throw new CoreError("NOT_FOUND", "The exact pending Action proposal is unavailable.");
    const row = database.prepare("SELECT payload,payload_sha256 FROM legacy_action_mcp_proposals WHERE proposal_id=?").get(proposalId);
    if (!row || hash(String(row.payload)) !== row.payload_sha256) throw new CoreError("RECOVERY_CONFLICT", "Action proposal bytes failed integrity verification.");
    const envelope = automaticProposalEnvelope.parse(JSON.parse(String(row.payload)));
    const value = envelope.proposal;
    if (envelope.actorId !== actorId
      || envelope.workspaceId !== options.workspaceId || value.proposal_id !== proposalId
      || value.content_hash !== expectedContentHash || value.action_id !== value.definition.action_id) {
      throw new CoreError("CONFLICT", "The exact pending Action proposal changed or belongs to another workspace.");
    }
    const sourceDefinition = Object.fromEntries(Object.entries(value.definition).filter(([key]) => key !== "knowledgeId"));
    const source = { kind: "inline" as const, definition: sourceDefinition };
    const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source } }) as {
      status?: string; definitionDigest?: string; definition?: Record<string, unknown>; source?: unknown;
    };
    const canonicalDefinition = originalDefinitionValue(value.definition as Record<string, unknown>);
    if (compiled.status !== "valid" || !/^[a-f0-9]{64}$/.test(compiled.definitionDigest ?? "")
      || canonicalDefinition.content_hash !== expectedContentHash) {
      throw new CoreError("INVALID_ARGUMENT", "The Action proposal does not compile to its exact pinned revision.");
    }
    return { envelope, proposal: value, source, compiled, executableDigest: compiled.definitionDigest!, contentHash: expectedContentHash };
  };
  const hasAdmission = (binding: ActionAuthorizationBinding): boolean => {
    if (!options.action?.automaticTrusted || !isRecord(binding.source) || binding.source.kind !== "inline"
      || typeof binding.source.action_id !== "string" || !binding.workspaceId) return false;
    const current = readTrust();
    if (!current || current.actorId !== binding.actorId || current.workspaceId !== binding.workspaceId) return false;
    try {
      const sourceActionId = binding.source.action_id;
      const row = database.prepare("SELECT * FROM native_action_automatic_admissions WHERE actor_id=? AND workspace_id=? AND action_id=? AND executable_digest=? ORDER BY rowid DESC LIMIT 1")
        .get(binding.actorId, binding.workspaceId, sourceActionId, binding.executableDigest);
      if (!row || hash(String(row.payload)) !== row.payload_sha256) return false;
      const latest = database.prepare("SELECT proposal_id,content_hash,trust_epoch FROM native_action_automatic_admissions WHERE actor_id=? AND workspace_id=? AND action_id=? ORDER BY rowid DESC LIMIT 1")
        .get(binding.actorId, binding.workspaceId, sourceActionId);
      if (!latest || latest.proposal_id !== row.proposal_id || latest.content_hash !== row.content_hash) return false;
      let payload = String(row.payload);
      if (row.trust_epoch !== current.epoch) {
        const renewed = database.prepare("SELECT payload,payload_sha256 FROM native_action_automatic_readmissions WHERE proposal_id=? AND trust_epoch=?")
          .get(row.proposal_id, current.epoch);
        if (!renewed || hash(String(renewed.payload)) !== renewed.payload_sha256) return false;
        payload = String(renewed.payload);
      }
      const admission = JSON.parse(payload) as Record<string, unknown>;
      if (admission.proposalId !== row.proposal_id || admission.actorId !== current.actorId
        || admission.workspaceId !== current.workspaceId || admission.actionId !== sourceActionId
        || admission.contentHash !== row.content_hash || admission.executableDigest !== binding.executableDigest
        || admission.trustEpoch !== current.epoch) return false;
      const exact = readProposal(String(row.proposal_id), String(row.content_hash), current.actorId);
      return exact.proposal.action_id === sourceActionId && exact.executableDigest === binding.executableDigest;
    } catch { return false; }
  };
  const nestedSignals = new Map<string, AbortSignal>();
  const nestedParentIsActive = (invocation: ActionInvocation): boolean => {
    const plan = readNestedActionPlan(database, invocation.actorId, invocation.runId);
    if (!plan) return true;
    const current = readTrust();
    const parentSignal = nestedSignals.get(plan.parentRunId);
    if (!parentSignal || parentSignal.aborted || !current || current.epoch !== plan.trustEpoch || current.actorId !== invocation.actorId
      || plan.workspaceId !== options.workspaceId || exactPipelineArtifactInput(invocation.inputs) !== plan.sourceId
      || invocation.actionId !== "core.artifact.copy") return false;
    const row = database.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?")
      .get(invocation.actorId, plan.parentRunId);
    if (!row) return false;
    const parent = JSON.parse(String(row.snapshot)) as { state?: string; cancelRequested?: boolean; actionId?: string;
      definitionDigest?: string; definition?: Record<string, unknown>; source?: unknown;
      implementation?: ActionAuthorizationBinding["implementation"]; inputs?: Record<string, unknown> };
    if (parent.state !== "running" || parent.cancelRequested || !parent.definition || !parent.implementation
      || !parent.actionId || !parent.definitionDigest || exactPipelineArtifactInput(parent.inputs) !== plan.sourceId) return false;
    return nestedCopyEnabled({ actorId: invocation.actorId, workspaceId: options.workspaceId,
      executableDigest: parent.definitionDigest, source: parent.source, actionId: parent.actionId,
      definition: parent.definition, implementation: parent.implementation, nodeId: "action", inputs: parent.inputs! })
      && hasAdmission({ actorId: invocation.actorId, workspaceId: options.workspaceId, executableDigest: parent.definitionDigest,
        source: parent.source, actionId: parent.actionId, definition: parent.definition, implementation: parent.implementation,
        nodeId: "action" });
  };
  const refreshNestedParent = async (invocation: ActionInvocation): Promise<boolean> => {
    if (!readNestedActionPlan(database, invocation.actorId, invocation.runId)) return true;
    await options.action?.automaticTrusted?.refresh?.();
    return nestedParentIsActive(invocation);
  };
  const processBridge = options.action?.process && createActionProcessBridge({
    ...options.action.process, database, workspaceRoot: options.storage.workspaceRoot(),
    beforeEffect: options.beforeEffect,
    requirePreapproval: !!options.action.automaticTrusted,
    ...(options.action.automaticTrusted ? {
      nestedArtifact: {
        enabled: nestedCopyEnabled,
        invoke: invokeNestedArtifact,
        validateOutput: (invocation, output) => !!validateNestedArtifact(invocation.actorId, invocation.runId,
          invocation.inputs, invocation.definition, output),
      },
      authorizationEpoch: () => readTrust()?.epoch,
      authorizeLaunch: async (binding: ActionAuthorizationBinding & { inputs: Record<string, unknown> }, trustEpoch?: string) => {
        const current = readTrust();
        if (!current || !trustEpoch || current.epoch !== trustEpoch || !hasAdmission(binding)) return false;
        if (options.action?.automaticTrusted?.authorize) {
          let contentHash: unknown;
          try { contentHash = originalDefinitionValue(binding.definition as Record<string, unknown>).content_hash; }
          catch { return false; }
          if (typeof contentHash !== "string" || !/^[a-f0-9]{64}$/.test(contentHash)) return false;
          if (!await options.action.automaticTrusted.authorize(binding.actionId, contentHash, current.epoch)) return false;
        }
        return readTrust()?.epoch === trustEpoch && hasAdmission(binding);
      },
    } : {}),
  });
  for (const [key, adapter] of Object.entries(processBridge?.adapters ?? {})) {
    if (Object.hasOwn(adapters, key)) throw new CoreError("INVALID_CONFIGURATION", "Action adapter authority must be unique.");
    adapters[key] = adapter;
  }
  if (options.action?.automaticTrusted) {
    for (const [key, adapter] of Object.entries(adapters)) {
      adapters[key] = Object.freeze({
        ...adapter,
        authorizeDefinition: (binding: ActionAuthorizationBinding) => hasAdmission(binding) && adapter.authorizeDefinition(binding),
        authorizeData: (binding: ActionAuthorizationBinding & { inputs: Record<string, unknown> }) =>
          hasAdmission(binding) && adapter.authorizeData(binding),
      });
    }
  }
  function notify() {
    try { options.onLifecycle?.(); } catch { /* Durable events remain available to bounded readers. */ }
  }
  const runtime = new ActionRuntime(database, {
    workspaceRoot: options.storage.workspaceRoot(), workspaceId: options.workspaceId,
    adapters, assertOwner: options.assertOwner, initialized: true, deferRecovery: true,
    authorizePipelineArtifact(actorId, inputs, output) {
      const current = readTrust(), artifactId = exactPipelineArtifactInput(inputs);
      if (!current || current.actorId !== actorId || !artifactId || !isPipelineArtifactForward(inputs, output)) return false;
      try {
        const actor = { id: actorId, canWrite: true };
        const owner = managedActionArtifactOwner(database, options.workspaceId, actor, artifactId);
        if (!owner) return false;
        verifyOwnedActionArtifact(database, options.workspaceId, actor, owner, artifactId);
        const row = database.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?").get(actorId, owner);
        const snapshot = row && JSON.parse(String(row.snapshot)) as { actionId?: string; definitionDigest?: string };
        const registered = snapshot?.actionId && registeredAction(current, snapshot.actionId);
        return !!registered && registered.executableDigest === snapshot?.definitionDigest;
      } catch (error) {
        if (error instanceof CoreError) return false;
        throw error;
      }
    },
    resolveAdapter: options.action?.automaticTrusted && options.action.process?.trustedPrograms
      ? (key, outputDigest) => {
        const adapter = processBridge?.resolveAdapter(key, outputDigest)
          ?? (options.action?.approvePurePipeline ? pureComponentAdapter(key, outputDigest) : undefined)
          ?? (options.action?.approveManagedArtifact
            ? artifactAdapter(key, outputDigest, database, options.storage.workspaceRoot(), options.workspaceId, options.assertOwner,
              hasAdmission, id => authorizePicked({ id: "mcp:external", canWrite: true }, id),
              nestedParentIsActive, refreshNestedParent)
            : undefined);
        return adapter && {
          ...adapter,
          authorizeDefinition: binding => hasAdmission(binding) && adapter.authorizeDefinition(binding),
          authorizeData: binding => hasAdmission(binding) && adapter.authorizeData(binding),
        };
      } : undefined,
    beforeEffect: options.beforeEffect,
    onLifecycle: notify,
  });
  const scheduled = new Map<string, Promise<unknown>>();
  const fenced = new Set<string>();
  const shutdown = new AbortController();
  let started = false, closing = false, queued = false;
  let retry: NodeJS.Timeout | undefined;
  let trustMonitor: NodeJS.Timeout | undefined;
  let trustMonitorTask: Promise<void> | undefined;
  const configured = options.action !== undefined;
  function available() {
    options.assertOwner();
    if (closing) throw new CoreError("CLOSED", "Native host services are closing.");
    if (!configured) throw new CoreError("ADAPTER_UNAVAILABLE", "Action execution requires an explicit native host policy.");
  }
  function wake() {
    if (!started || closing || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (closing || !started) return;
      if (database.isTransaction) return;
      try {
        options.assertOwner();
        const rows = database.prepare("SELECT actor_id,run_id,snapshot FROM action_runtime_runs WHERE json_extract(snapshot,'$.state') IN ('ready','cancelling') ORDER BY actor_id,run_id").all();
        if (!rows.some(row => {
          const key = `${row.actor_id}\0${row.run_id}`;
          return !scheduled.has(key) && !fenced.has(key);
        })) return;
        options.beforeEffect?.();
        for (const row of rows) {
          if (scheduled.size >= concurrency) break;
          const actorId = String(row.actor_id), runId = String(row.run_id), key = `${actorId}\0${runId}`;
          if (scheduled.has(key) || fenced.has(key)) continue;
          const snapshot = JSON.parse(String(row.snapshot)) as { definition?: { dependencies?: Record<string, unknown> }; state?: string };
          if (snapshot.state === "ready" && snapshot.definition?.dependencies?.["core.artifact.copy"] === nestedCopyHash
            && scheduled.size >= concurrency - 1) continue;
          const work = runtime.tick(actorId, runId);
          scheduled.set(key, work);
          void work.then(settled, () => { fenced.add(key); settled(); });
          function settled() {
            processBridge?.discardApproval(runId);
            scheduled.delete(key);
            notify();
            wake();
          }
        }
      } catch (error) {
        if (error instanceof CoreError && error.code === "BUSY" && !retry) {
          retry = setTimeout(() => { retry = undefined; wake(); }, 25);
          retry.unref();
        }
        // Ownership loss fences scheduling; recovery belongs to the next native host.
      }
    });
  }
  async function fenceUntrustedRuns() {
    if (trustMonitorTask) await trustMonitorTask;
    if (!options.action?.automaticTrusted || !started || closing || database.isTransaction) return;
    const task = (async () => {
      try {
        options.assertOwner();
        await options.action?.automaticTrusted?.refresh?.();
        const rows = database.prepare("SELECT actor_id,run_id,snapshot FROM action_runtime_runs WHERE json_extract(snapshot,'$.state') IN ('ready','running') ORDER BY actor_id,run_id")
          .all() as Array<{ actor_id: string; run_id: string; snapshot: string }>;
        for (const row of rows) {
          if (closing) return;
          let snapshot: Record<string, unknown>;
          try { snapshot = JSON.parse(row.snapshot) as Record<string, unknown>; } catch { continue; }
          const definition = snapshot.definition;
          const actionId = isRecord(definition) && typeof definition.action_id === "string" ? definition.action_id : "";
          const binding: ActionAuthorizationBinding = {
            actorId: row.actor_id, workspaceId: options.workspaceId,
            executableDigest: String(snapshot.definitionDigest ?? ""),
            source: snapshot.source, actionId, definition: isRecord(definition) ? definition : {},
            implementation: isRecord(snapshot.implementation)
              ? snapshot.implementation as ActionAuthorizationBinding["implementation"] : { kind: "", platforms: [] },
            nodeId: "trust-fence",
          };
          if (hasAdmission(binding) && processBridge?.isApprovalCurrent(row.run_id) !== false) continue;
          try {
            const current = runtime.get(row.actor_id, row.run_id);
            await runtime.cancel(row.actor_id, {
              operationId: randomUUID(), runId: row.run_id, expectedVersion: current.version,
            });
            processBridge?.discardApproval(row.run_id);
          } catch { /* The owning runtime will reconcile a racing terminal or fenced run. */ }
        }
      } catch {
        // An unavailable or malformed trust authority cannot authorize new effects.
      }
    })();
    trustMonitorTask = task;
    try { await task; }
    finally { if (trustMonitorTask === task) trustMonitorTask = undefined; }
  }
  function assertQuiescent() {
    options.assertOwner();
    if (scheduled.size) throw new CoreError("BUSY", "Action execution has not drained.");
    runtime.assertQuiescent();
    assertWorkspaceBackupQuiescent(database);
    options.assertQuiescent?.();
  }
  async function authorize(request: HostBackupRequest) {
    options.assertOwner();
    if (closing || !["native-host", "cli"].includes(request.transport)
      || !options.authorizeBackup || await options.authorizeBackup(Object.freeze(request)) !== true) {
      throw new CoreError("FORBIDDEN", "Backup and restore require explicit native-host or CLI authority.");
    }
    options.assertOwner();
  }
  async function trustedContext(actor: Actor): Promise<AutomaticActionTrustContext> {
    await options.action?.automaticTrusted?.refresh?.();
    const current = readTrust();
    if (!options.action?.automaticTrusted || !actor.canWrite || !current
      || actor.id !== current.actorId || current.workspaceId !== options.workspaceId) {
      throw new CoreError("ACCESS_DENIED", "Automatic Action admission requires the trusted native workspace and exact host actor.");
    }
    return current;
  }
  function supportedProgram(exact: ReturnType<typeof readProposal>, current: AutomaticActionTrustContext) {
    const definition = exact.compiled.definition;
    const implementations = definition?.implementations;
    const platform = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Darwin" : "Linux";
    const implementation = Array.isArray(implementations)
      ? implementations.find(item => isRecord(item) && Array.isArray(item.platforms) && item.platforms.includes(platform))
      : undefined;
    if (options.action?.process?.trustedPrograms && isRecord(implementation) && implementation.kind === "pipeline") {
      if (!options.action.approvePurePipeline)
        throw new CoreError("NOT_AVAILABLE", "This host does not provide pure pipeline consent.");
      validatePurePipeline(definition!, implementation);
      if (!pureComponentAvailable()) throw new CoreError("ADAPTER_UNAVAILABLE",
        "The original JavaScript component engine is unavailable or failed its source hash.");
      return true;
    }
    if (options.action?.process?.trustedPrograms && isRecord(implementation) && implementation.kind === "builtin") {
      if (exactRunnableArtifactBuiltin(definition)) {
        if (!options.action.approveManagedArtifact || process.platform !== "linux")
          throw new CoreError("NOT_AVAILABLE", "Managed Action artifact copy requires native consent and Linux descriptor-safe paths.");
        return true;
      }
      if (!exactRunnablePureBuiltin(definition))
        throw new CoreError("NOT_AVAILABLE", "Only exact packaged core.cast.string-to-float and core.artifact.copy builtins are available.");
      if (!pureComponentAvailable()) throw new CoreError("ADAPTER_UNAVAILABLE",
        "The original JavaScript component engine is unavailable or failed its source hash.");
      return true;
    }
    if (options.action?.process?.trustedPrograms
      && (!isRecord(implementation) || implementation.kind !== "program"))
      throw new CoreError("NOT_AVAILABLE",
        "Trusted Actions support programs, supported pure pipelines and exact packaged pure string-cast builtins; other builtins and MCP implementations are unavailable.");
    if (options.action?.process?.trustedPrograms && isRecord(implementation) && implementation.kind === "program"
      && isRecord(definition?.dependencies) && Object.keys(definition.dependencies).length) {
      const effects = definition.effects;
      if (Object.keys(definition.dependencies).length !== 1 || definition.dependencies["core.artifact.copy"] !== nestedCopyHash
        || implementation.build !== undefined || !Array.isArray(effects)
        || !["local-read", "local-write"].every(effect => effects.includes(effect)) || concurrency < 2)
        throw new CoreError("NOT_AVAILABLE", "Only one exact core.artifact.copy program dependency is supported, without build and with declared local-read/local-write effects.");
    }
    if (options.action?.process?.trustedPrograms && isRecord(implementation)
      && implementation.kind === "program" && implementation.build !== undefined) {
      try {
        inspectActionBuild(options.storage.workspaceRoot(), {
          actorId: current.actorId, workspaceId: current.workspaceId, executableDigest: exact.executableDigest,
          source: exact.compiled.source, actionId: exact.proposal.action_id, definition: definition!,
          implementation: implementation as ActionAuthorizationBinding["implementation"], nodeId: "action",
        });
      } catch (error) {
        if (error instanceof Error && "code" in error) throw error;
        const unavailable = new CoreError("NOT_AVAILABLE", error instanceof Error ? error.message : "Action build is unavailable.");
        unavailable.cause = error;
        throw unavailable;
      }
    }
    if (options.action?.process?.trustedPrograms && isRecord(implementation)
      && implementation.result_protocol !== undefined && implementation.result_protocol !== "pkm.action.result/v1")
      throw new CoreError("NOT_AVAILABLE", "The declared Action result protocol is unavailable.");
    if (!definition || !isRecord(implementation) || implementation.kind !== "program"
      || typeof implementation.program !== "string" || !Array.isArray(implementation.platforms)) return false;
    const adapter = processBridge?.adapters[`program:${implementation.program}`]
      ?? processBridge?.resolveAdapter(`program:${implementation.program}`, originalDigest(definition.output_schema));
    if (!adapter || adapter.outputContractDigest !== originalDigest(definition.output_schema)) return false;
    try {
      const allowed = adapter.authorizeDefinition({
        actorId: current.actorId, workspaceId: current.workspaceId, executableDigest: exact.executableDigest,
        source: exact.compiled.source, actionId: exact.proposal.action_id, definition,
        implementation: implementation as ActionAuthorizationBinding["implementation"], nodeId: "action",
      }) === true;
      if (!allowed && options.action?.process?.trustedPrograms
        && !processBridge?.adapters[`program:${implementation.program}`]) {
        throw new CoreError("ADAPTER_UNAVAILABLE",
          "The declared program is unavailable or its arguments exceed process limits. No runtime is installed automatically.");
      }
      return allowed;
    } catch (error) {
      if (error instanceof CoreError || error instanceof Error && "code" in error) throw error;
      return false;
    }
  }
  function registeredAction(current: AutomaticActionTrustContext, actionId: string, contentHash?: string) {
    const row = database.prepare("SELECT proposal_id,content_hash,trust_epoch FROM native_action_automatic_admissions WHERE actor_id=? AND workspace_id=? AND action_id=? ORDER BY rowid DESC LIMIT 1")
      .get(current.actorId, current.workspaceId, actionId);
    if (!row) return undefined;
    if (contentHash !== undefined && row.content_hash !== contentHash)
      throw new CoreError("ACCESS_DENIED", "The requested Action revision is not the current trusted registration.");
    const exact = readProposal(String(row.proposal_id), String(row.content_hash), current.actorId);
    const implementation = (exact.compiled.definition?.implementations as ActionAuthorizationBinding["implementation"][] | undefined)
      ?.find(item => Array.isArray(item.platforms) && item.platforms.includes(
        process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Darwin" : "Linux"));
    if (!implementation || !supportedProgram(exact, current) || !hasAdmission({
      actorId: current.actorId, workspaceId: current.workspaceId, executableDigest: exact.executableDigest,
      source: exact.compiled.source, actionId, definition: exact.compiled.definition!, implementation, nodeId: "action",
    })) throw new CoreError("ACCESS_DENIED", "The registered Action no longer has current native authority.");
    return exact;
  }
  function validateNestedArtifact(actorId: string, parentRunId: string, inputs: unknown,
    definition: Record<string, unknown>, output: unknown): string | undefined {
    const sourceId = exactPipelineArtifactInput(inputs);
    if (!sourceId || !isRecord(output) || Object.keys(output).length !== 1 || typeof output.artifact_id !== "string"
      || !isRecord(definition.dependencies) || definition.dependencies["core.artifact.copy"] !== nestedCopyHash) return undefined;
    const row = database.prepare(`SELECT child_run_id,artifact_id,payload,payload_sha256 FROM native_action_nested_artifacts
      WHERE actor_id=? AND parent_run_id=? AND artifact_id=?`).get(actorId, parentRunId, output.artifact_id);
    if (!row || hash(String(row.payload)) !== row.payload_sha256) return undefined;
    const parsed = nestedArtifactLink.safeParse(JSON.parse(String(row.payload)));
    if (!parsed.success) return undefined;
    const link = parsed.data;
    if (link.actorId !== actorId || link.workspaceId !== options.workspaceId || link.parentRunId !== parentRunId
      || link.childRunId !== row.child_run_id || link.artifactId !== row.artifact_id
      || link.sourceId !== sourceId || link.childHash !== nestedCopyHash) return undefined;
    const child = database.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?").get(actorId, link.childRunId);
    const snapshot = child && JSON.parse(String(child.snapshot)) as { actionId?: string; inputs?: unknown; state?: string };
    if (!snapshot || snapshot.actionId !== "core.artifact.copy" || snapshot.state !== "succeeded"
      || exactPipelineArtifactInput(snapshot.inputs) !== sourceId) return undefined;
    verifyOwnedActionArtifact(database, options.workspaceId, { id: actorId, canWrite: true }, link.childRunId, link.artifactId, parentRunId);
    return link.childRunId;
  }
  async function invokeNestedArtifact(invocation: Parameters<ActionNativeAdapter["execute"]>[0],
    request: { actionId: string; inputs: Record<string, unknown>; key: string }, epoch: string, signal: AbortSignal) {
    if (nestedSignals.has(invocation.runId)) throw new CoreError("CONFLICT", "Only one nested artifact invocation is supported.");
    nestedSignals.set(invocation.runId, signal);
    try {
    const actor = { id: invocation.actorId, canWrite: true };
    const sourceId = exactPipelineArtifactInput(invocation.inputs);
    const fence = () => {
      const current = readTrust();
      if (signal.aborted || closing || !current || current.epoch !== epoch || current.actorId !== invocation.actorId
        || current.workspaceId !== invocation.workspaceId || !hasAdmission(invocation)) return false;
      const row = database.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?")
        .get(invocation.actorId, invocation.runId);
      if (!row) return false;
      const snapshot = JSON.parse(String(row.snapshot)) as { state?: string; cancelRequested?: boolean };
      return snapshot.state === "running" && snapshot.cancelRequested !== true;
    };
    if (!fence() || !nestedCopyEnabled({ ...invocation, inputs: invocation.inputs })
      || request.actionId !== "core.artifact.copy" || !sourceId
      || exactPipelineArtifactInput(request.inputs) !== sourceId)
      throw new CoreError("ACCESS_DENIED", "Nested artifact copy is outside the pinned parent invocation.");
    const nestedKey = `internal-nested-${hash(`${invocation.runId}\0${request.key}`)}`;
    const result = await createActionRunFromProposal(actor, { actionId: "core.artifact.copy", contentHash: nestedCopyHash,
      idempotencyKey: nestedKey, inputs: request.inputs }, { fence, plan: {
        actorId: "mcp:external", workspaceId: options.workspaceId, parentRunId: invocation.runId,
        sourceId, childHash: nestedCopyHash, trustEpoch: epoch,
      } });
    if (!isRecord(result) || typeof result.runId !== "string") throw new CoreError("RECOVERY_CONFLICT", "Nested Action run is unavailable.");
    const childRunId = result.runId;
    for (;;) {
      const child = runtime.get(actor.id, childRunId);
      if (!fence()) {
        if (!["succeeded", "failed", "cancelled", "unknown"].includes(child.state)) {
          try { await runtime.cancel(actor.id, { operationId: randomUUID(), runId: childRunId, expectedVersion: child.version }); }
          catch { /* A racing terminal child cannot be replayed. */ }
        }
        throw new CoreError("ACCESS_DENIED", "Parent Action invocation was cancelled or revoked.");
      }
      if (child.state === "succeeded") break;
      if (["failed", "cancelled", "unknown"].includes(child.state))
        throw new CoreError("NOT_AVAILABLE", "Nested artifact copy did not succeed.");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const output = await readAutomaticActionResult(actor, childRunId, invocation.runId);
    if (!fence() || !output || Object.keys(output).length !== 1 || typeof output.artifact_id !== "string"
      || output.artifact_id === sourceId) throw new CoreError("ACCESS_DENIED", "Nested artifact output is unavailable.");
    verifyOwnedActionArtifact(database, options.workspaceId, actor, childRunId, output.artifact_id, invocation.runId);
    const link = nestedArtifactLink.parse({ actorId: actor.id, workspaceId: options.workspaceId, parentRunId: invocation.runId,
      childRunId, artifactId: output.artifact_id, sourceId, childHash: nestedCopyHash });
    const payload = JSON.stringify(link);
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!fence()) throw new CoreError("ACCESS_DENIED", "Parent Action invocation was revoked before publication.");
      database.prepare("INSERT INTO native_action_nested_artifacts VALUES(?,?,?,?,?,?)")
        .run(actor.id, invocation.runId, childRunId, output.artifact_id, payload, hash(payload));
      options.assertOwner();
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
    return output;
    } finally {
      if (nestedSignals.get(invocation.runId) === signal) nestedSignals.delete(invocation.runId);
    }
  }
  async function readRegisteredAction(actor: Actor, actionId: string): Promise<Record<string, unknown> | undefined> {
    available();
    const exists = database.prepare("SELECT 1 FROM native_action_automatic_admissions WHERE actor_id=? AND workspace_id=? AND action_id=? LIMIT 1")
      .get(actor.id, options.workspaceId, actionId);
    if (!exists) return undefined;
    const current = await trustedContext(actor);
    const exact = registeredAction(current, actionId);
    if (exact && options.action?.automaticTrusted?.authorize
      && !await options.action.automaticTrusted.authorize(actionId, exact.contentHash, current.epoch))
      throw new CoreError("ACCESS_DENIED", "The host denied this registered Action revision.");
    const refreshed = readTrust();
    if (!refreshed || refreshed.actorId !== current.actorId || refreshed.workspaceId !== current.workspaceId
      || refreshed.epoch !== current.epoch || (exact && !registeredAction(current, actionId, exact.contentHash)))
      throw new CoreError("ACCESS_DENIED", "Action registration or workspace trust changed during lookup.");
    return exact ? originalDefinitionValue(exact.proposal.definition) : undefined;
  }
  async function readAutomaticActionResult(actor: Actor, runId: string, activeParent?: string): Promise<Record<string, unknown> | undefined> {
    available();
    const current = await trustedContext(actor);
    const owned = database.prepare("SELECT 1 FROM native_action_automatic_calls WHERE actor_id=? AND run_id=?")
      .get(actor.id, runId);
    if (!owned) return undefined;
    const run = runtime.get(actor.id, runId);
    const row = database.prepare(`SELECT proposal_id,content_hash FROM native_action_automatic_admissions
      WHERE actor_id=? AND workspace_id=? AND action_id=? AND executable_digest=? ORDER BY rowid DESC LIMIT 1`)
      .get(actor.id, current.workspaceId, run.actionId, run.definitionDigest);
    if (!row) throw new CoreError("RECOVERY_CONFLICT", "The owned Action result has no exact revision admission.");
    const exact = readProposal(String(row.proposal_id), String(row.content_hash), actor.id);
    if (exact.executableDigest !== run.definitionDigest)
      throw new CoreError("RECOVERY_CONFLICT", "The owned Action result revision changed.");
    const output = runtime.getOwnedResult(actor.id, runId, exact.compiled.definition!);
    if (output === undefined) return undefined;
    if (hasArtifactField(output)) {
      if (exactRunnableArtifactBuiltin(exact.compiled.definition) && Object.keys(output).length === 1
        && typeof output.artifact_id === "string") {
        const plan = readNestedActionPlan(database, actor.id, runId);
        if (activeParent && plan?.parentRunId !== activeParent)
          throw new CoreError("ACCESS_DENIED", "The nested Action parent does not match.");
        verifyOwnedActionArtifact(database, options.workspaceId, actor, runId, output.artifact_id, activeParent);
      } else {
        const row = database.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?").get(actor.id, runId);
        const snapshot = row && JSON.parse(String(row.snapshot)) as { implementation?: { kind?: string }; inputs?: unknown };
        if (!snapshot || typeof output.artifact_id !== "string")
          throw new CoreError("NOT_AVAILABLE", "The Action artifact output is unsupported.");
        const owner = snapshot.implementation?.kind === "pipeline" && isPipelineArtifactForward(snapshot.inputs, output)
          ? managedActionArtifactOwner(database, options.workspaceId, actor, output.artifact_id)
          : snapshot.implementation?.kind === "program"
            ? validateNestedArtifact(actor.id, runId, snapshot.inputs, exact.compiled.definition!, output) : undefined;
        if (!owner || owner === runId) throw new CoreError("ACCESS_DENIED", "The Action artifact has no authorized owned producer.");
        verifyOwnedActionArtifact(database, options.workspaceId, actor, owner, output.artifact_id);
        const original = await readAutomaticActionResult(actor, owner,
          snapshot.implementation?.kind === "program" ? runId : undefined);
        if (!original || original.artifact_id !== output.artifact_id)
          throw new CoreError("ACCESS_DENIED", "The forwarded artifact producer is unavailable.");
      }
    }
    if (options.action?.automaticTrusted?.authorize
      && !await options.action.automaticTrusted.authorize(run.actionId, exact.contentHash, current.epoch))
      throw new CoreError("ACCESS_DENIED", "The host denied this Action result revision.");
    const refreshed = readTrust();
    if (!refreshed || refreshed.actorId !== current.actorId || refreshed.workspaceId !== current.workspaceId
      || refreshed.epoch !== current.epoch)
      throw new CoreError("ACCESS_DENIED", "Workspace trust changed during Action result lookup.");
    const nestedPlan = readNestedActionPlan(database, actor.id, runId);
    if (nestedPlan && !activeParent) {
      const parent = await readAutomaticActionResult(actor, nestedPlan.parentRunId);
      if (!parent || parent.artifact_id !== output.artifact_id)
        throw new CoreError("ACCESS_DENIED", "The nested artifact root result is unavailable.");
    }
    return output;
  }
  async function prepareManagedArtifactExport(actor: Actor, artifactId: string): Promise<(() => boolean) | undefined> {
    const owner = managedActionArtifactOwner(database, options.workspaceId, actor, artifactId);
    if (!owner) return undefined;
    const output = await readAutomaticActionResult(actor, owner);
    if (!output || output.artifact_id !== artifactId)
      throw new CoreError("ACCESS_DENIED", "Managed Action artifact export requires its exact owned result.");
    const current = readTrust();
    if (!current || current.actorId !== actor.id)
      throw new CoreError("ACCESS_DENIED", "Managed Action artifact export requires current workspace trust.");
    return () => {
      const live = readTrust();
      return !closing && !!live && live.actorId === actor.id && live.workspaceId === current.workspaceId
        && live.epoch === current.epoch;
    };
  }
  async function preparePickedArtifactAccess(actor: Actor): Promise<(authorityId: string, artifact?: { artifactId: string; digest: string }) => boolean> {
    await options.action?.automaticTrusted?.refresh?.();
    return (authorityId, artifact) => authorizePicked(actor, authorityId, artifact);
  }
  async function pickAndImportArtifact(actor: Actor) {
    available();
    const current = await trustedContext(actor), authority = options.action?.automaticTrusted;
    if (!authority?.pickArtifactSource) throw new CoreError("NOT_AVAILABLE", "The native Action artifact picker is unavailable.");
    const source = await authority.pickArtifactSource(current.epoch);
    if (!source) throw new CoreError("ACCESS_DENIED", "Action artifact selection was cancelled.");
    const authorizePicked = await preparePickedArtifactAccess(actor);
    const authorityId = `pkm-action-picker:${current.epoch}:v1`;
    if (!authorizePicked(authorityId)) throw new CoreError("ACCESS_DENIED", "Action trust changed during artifact selection.");
    const grant = await admitLegacyActionArtifactPath(options.storage, actor, {
      kind: "source", selectedRoot: source.selectedRoot, path: source.path, expectedSha256: source.expectedSha256,
      authorityId, authorize: binding => authorizePicked(authorityId) && binding.actorId === actor.id
        && binding.workspaceId === current.workspaceId && binding.workspaceRoot === options.storage.workspaceRoot()
        && binding.path === source.path && binding.selectedRoot === source.selectedRoot
        && binding.expectedSha256 === source.expectedSha256 && binding.authorityId === authorityId,
    });
    if (!authorizePicked(authorityId)) throw new CoreError("ACCESS_DENIED", "Action trust changed before artifact import.");
    return legacyActionArtifact(options.storage, actor, { tool: "action_artifact_import", local_path: source.path },
      { authorizePicked, selectedGrantId: grant.id });
  }
  async function pickAndExportArtifact(actor: Actor, artifactId: string) {
    available();
    const current = await trustedContext(actor), authority = options.action?.automaticTrusted;
    if (!authority?.pickArtifactDestination) throw new CoreError("NOT_AVAILABLE", "The native Action artifact destination picker is unavailable.");
    const authorizeManaged = await prepareManagedArtifactExport(actor, artifactId);
    if (!authorizeManaged) throw new CoreError("ACCESS_DENIED", "Only published managed Action artifacts can be exported through the picker.");
    const artifact = inspectActionArtifact(database, options.storage.workspaceRoot(), options.workspaceId, actor, artifactId);
    const destination = await authority.pickArtifactDestination(current.epoch, artifact);
    if (!destination) throw new CoreError("ACCESS_DENIED", "Action artifact destination selection was cancelled.");
    const authorizePicked = await preparePickedArtifactAccess(actor);
    const authorityId = `pkm-action-picker:${current.epoch}:export:${artifact.artifactId}:${artifact.digest}`;
    if (!authorizePicked(authorityId, artifact) || !authorizeManaged())
      throw new CoreError("ACCESS_DENIED", "Action trust changed during destination selection.");
    const grant = await admitLegacyActionArtifactPath(options.storage, actor, {
      kind: "destination", selectedRoot: destination.selectedRoot, path: destination.path, authorityId,
      authorize: binding => authorizePicked(authorityId, artifact) && authorizeManaged() && binding.actorId === actor.id
        && binding.workspaceId === current.workspaceId && binding.workspaceRoot === options.storage.workspaceRoot()
        && binding.path === destination.path && binding.selectedRoot === destination.selectedRoot
        && binding.kind === "destination" && binding.expectedSha256 === null && binding.authorityId === authorityId,
    });
    if (!authorizePicked(authorityId, artifact) || !authorizeManaged())
      throw new CoreError("ACCESS_DENIED", "Action trust changed before artifact export.");
    return legacyActionArtifact(options.storage, actor, { tool: "action_artifact_export", artifact_id: artifactId, destination: destination.path },
      { authorizeManaged, authorizePicked, selectedGrantId: grant.id });
  }
  async function admitActionProposal(actor: Actor, proposalId: string, contentHash: string): Promise<boolean> {
    available();
    const current = await trustedContext(actor);
    if (database.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Automatic Action admission requires an idle host database.");
    const exact = readProposal(proposalId, contentHash, actor.id);
    if (!supportedProgram(exact, current)) return false;
    if (options.action?.automaticTrusted?.authorize
      && !await options.action.automaticTrusted.authorize(exact.proposal.action_id, contentHash, current.epoch)) return false;
    const refreshed = readTrust();
    if (!refreshed || refreshed.actorId !== current.actorId || refreshed.workspaceId !== current.workspaceId
      || refreshed.epoch !== current.epoch) return false;
    const payload = JSON.stringify({
      schema: "pkm.native-action-automatic-admission/v1", proposalId, actorId: actor.id,
      workspaceId: current.workspaceId, actionId: exact.proposal.action_id,
      contentHash, executableDigest: exact.executableDigest, trustEpoch: current.epoch,
    });
    const payloadSha256 = hash(payload);
    database.exec("BEGIN IMMEDIATE");
    try {
      const prior = database.prepare("SELECT payload,payload_sha256 FROM native_action_automatic_admissions WHERE proposal_id=?")
        .get(proposalId);
      if (prior) {
        if (hash(String(prior.payload)) !== prior.payload_sha256)
          throw new CoreError("RECOVERY_CONFLICT", "The existing Action registration failed integrity verification.");
        const previous = JSON.parse(String(prior.payload)) as Record<string, unknown>;
        if (previous.proposalId !== proposalId || previous.actorId !== actor.id || previous.workspaceId !== current.workspaceId
          || previous.actionId !== exact.proposal.action_id || previous.contentHash !== contentHash
          || previous.executableDigest !== exact.executableDigest)
          throw new CoreError("CONFLICT", "This proposal was admitted for a different actor, workspace or revision.");
        const latest = database.prepare("SELECT proposal_id FROM native_action_automatic_admissions WHERE actor_id=? AND workspace_id=? AND action_id=? ORDER BY rowid DESC LIMIT 1")
          .get(actor.id, current.workspaceId, exact.proposal.action_id);
        if (latest?.proposal_id !== proposalId)
          throw new CoreError("CONFLICT", "A newer Action revision is already registered.");
        if (previous.trustEpoch !== current.epoch) {
          const renewed = database.prepare("SELECT payload,payload_sha256 FROM native_action_automatic_readmissions WHERE proposal_id=? AND trust_epoch=?")
            .get(proposalId, current.epoch);
          if (renewed) {
            if (hash(String(renewed.payload)) !== renewed.payload_sha256 || renewed.payload_sha256 !== payloadSha256)
              throw new CoreError("RECOVERY_CONFLICT", "The Action readmission failed integrity verification.");
          } else {
            const count = database.prepare("SELECT count(*) n FROM native_action_automatic_readmissions").get();
            if (!count || Number(count.n) >= 10000) throw new CoreError("RESOURCE_LIMIT", "Automatic Action readmission capacity reached.");
            database.prepare("INSERT INTO native_action_automatic_readmissions VALUES(?,?,?,?)")
              .run(proposalId, current.epoch, payload, payloadSha256);
          }
        } else if (prior.payload_sha256 !== payloadSha256) {
          throw new CoreError("RECOVERY_CONFLICT", "The Action registration failed integrity verification.");
        }
        database.exec("COMMIT");
        return true;
      }
      const admissionCount = database.prepare("SELECT count(*) n FROM native_action_automatic_admissions").get();
      if (!admissionCount || Number(admissionCount.n) >= 10000)
        throw new CoreError("RESOURCE_LIMIT", "Automatic Action admission capacity reached.");
      const latest = database.prepare("SELECT proposal_id,content_hash FROM native_action_automatic_admissions WHERE actor_id=? AND workspace_id=? AND action_id=? ORDER BY rowid DESC LIMIT 1")
        .get(actor.id, current.workspaceId, exact.proposal.action_id);
      if (latest) {
        const previous = readProposal(String(latest.proposal_id), String(latest.content_hash), actor.id);
        if (typeof exact.proposal.definition.version !== "number"
          || typeof previous.proposal.definition.version !== "number"
          || exact.proposal.definition.version <= previous.proposal.definition.version)
          throw new CoreError("CONFLICT", "Updating a registered Action requires a larger version.");
      }
      database.prepare("INSERT INTO native_action_automatic_admissions VALUES(?,?,?,?,?,?,?,?,?)")
        .run(proposalId, actor.id, current.workspaceId, exact.proposal.action_id,
          contentHash, exact.executableDigest, current.epoch, payload, payloadSha256);
      database.exec("COMMIT");
      return true;
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }
  const pendingAutomaticCalls = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  type AutomaticCall = {
    proposalId?: string; actionId: string; contentHash: string; idempotencyKey: string; inputs: Record<string, unknown>;
  };
  type NestedCall = { fence(): boolean; plan: Omit<NestedActionPlan, "childRunId"> };
  async function createActionRunFromProposal(actor: Actor, request: AutomaticCall, nested?: NestedCall): Promise<unknown> {
    if (request.idempotencyKey.startsWith("internal-nested-") && !nested)
      throw new CoreError("ACCESS_DENIED", "Nested Action invocation keys are host-reserved.");
    const key = `${actor.id}\0${request.idempotencyKey}`;
    const fingerprint = hash(canonicalJson(request));
    const pending = pendingAutomaticCalls.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new CoreError("CONFLICT", "Action idempotency key is already in use.");
      return pending.promise;
    }
    const promise = createActionRunFromProposalInternal(actor, request, nested);
    pendingAutomaticCalls.set(key, { fingerprint, promise });
    try { return await promise; }
    finally { if (pendingAutomaticCalls.get(key)?.promise === promise) pendingAutomaticCalls.delete(key); }
  }
  async function createActionRunFromProposalInternal(actor: Actor, request: AutomaticCall, nested?: NestedCall) {
    available();
    if (nested && !nested.fence()) throw new CoreError("ACCESS_DENIED", "Parent Action invocation is unavailable.");
    const current = await trustedContext(actor);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(request.idempotencyKey)
      || !/^[a-z][a-z0-9_.-]{2,100}$/.test(request.actionId)
      || (request.proposalId !== undefined && !/^proposal_[a-f0-9]{32}$/.test(request.proposalId))
      || !/^[a-f0-9]{64}$/.test(request.contentHash)
      || !isRecord(request.inputs)) throw new CoreError("INVALID_ARGUMENT", "Invalid pinned Action call.");
    const exact = registeredAction(current, request.actionId, request.contentHash);
    if (!exact || (request.proposalId !== undefined && exact.proposal.proposal_id !== request.proposalId))
      throw new CoreError("ACCESS_DENIED", "The exact Action registration is unavailable.");
    if (options.action?.automaticTrusted?.authorize
      && !await options.action.automaticTrusted.authorize(request.actionId, request.contentHash, current.epoch))
      throw new CoreError("ACCESS_DENIED", "The host denied this registered Action revision.");
    const refreshed = readTrust();
    if (!refreshed || refreshed.actorId !== current.actorId || refreshed.workspaceId !== current.workspaceId
      || refreshed.epoch !== current.epoch || !registeredAction(current, request.actionId, request.contentHash))
      throw new CoreError("ACCESS_DENIED", "Action registration or workspace trust changed during call admission.");
    if (exact.proposal.action_id !== request.actionId) throw new CoreError("CONFLICT", "Action ID differs from the exact proposal revision.");
    const definition = exact.compiled.definition!;
    const platform = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Darwin" : "Linux";
    const implementation = (definition.implementations as ActionAuthorizationBinding["implementation"][] | undefined)
      ?.find(item => Array.isArray(item.platforms) && item.platforms.includes(platform));
    if (!implementation) throw new CoreError("INVALID_DEFINITION", "Action proposal has no native implementation.");
    if (!hasAdmission({
      actorId: actor.id, workspaceId: current.workspaceId, executableDigest: exact.executableDigest,
      source: { kind: "inline", action_id: request.actionId }, actionId: request.actionId,
      definition: exact.proposal.definition as ActionAuthorizationBinding["definition"],
      implementation,
      nodeId: "action",
    })) throw new CoreError("ACCESS_DENIED", "This exact Action revision has no current trusted-workspace admission.");

    const requestSha256 = hash(canonicalJson({
      proposalId: exact.proposal.proposal_id, actionId: request.actionId, contentHash: request.contentHash, inputs: request.inputs,
    }));
    const operationId = uuidFromDigest(`${current.workspaceId}\0${actor.id}\0${request.idempotencyKey}`);
    const runId = `action_run_${operationId.replaceAll("-", "")}`;
    if (database.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Action call admission requires an idle host database.");
    const prior = database.prepare("SELECT request_sha256,operation_id,run_id,deadline FROM native_action_automatic_calls WHERE actor_id=? AND idempotency_key=?")
      .get(actor.id, request.idempotencyKey) as { request_sha256: string; operation_id: string; run_id: string; deadline: number } | undefined;
    if (prior && prior.request_sha256 !== requestSha256)
      throw new CoreError("CONFLICT", "Action idempotency key was reused with a different revision or inputs.");
    const call = prior ?? { request_sha256: requestSha256, operation_id: operationId, run_id: runId, deadline: Date.now() + 300_000 };
    const createArgs = actionRuntimeDefinitions[0].input.parse({
      operationId: call.operation_id, runId: call.run_id, source: exact.source,
      expectedDefinitionDigest: exact.executableDigest, deadline: call.deadline, inputs: request.inputs,
    });
    const managedArtifact = exactRunnableArtifactBuiltin(definition);
    const binding: ActionAuthorizationBinding & { inputs: Record<string, unknown> } = {
      actorId: actor.id, workspaceId: current.workspaceId, executableDigest: exact.executableDigest,
      source: exact.compiled.source, actionId: request.actionId, definition, implementation,
      nodeId: "action", inputs: request.inputs,
    };
    const nestedProgram = nestedCopyEnabled(binding);
    if (implementation.kind === "program" && isRecord(definition.dependencies)
      && Object.keys(definition.dependencies).length && !nestedProgram)
      throw new CoreError("NOT_AVAILABLE", "This program dependency requires one exact source artifact input.");
    const pipelineArtifactId = implementation.kind === "pipeline" ? exactPipelineArtifactInput(request.inputs) : undefined;
    if (hasArtifactField(request.inputs) && !managedArtifact && !pipelineArtifactId && !nestedProgram)
      throw new CoreError("NOT_AVAILABLE", "Managed Action artifact inputs are unavailable in this program host.");
    if (prior) {
      if (nested) {
        const plan = readNestedActionPlan(database, actor.id, call.run_id);
        if (!plan || canonicalJson(plan) !== canonicalJson({ ...nested.plan, childRunId: call.run_id }))
          throw new CoreError("RECOVERY_CONFLICT", "Nested Action invocation binding changed.");
      }
      const value = runtime.create(actor.id, createArgs);
      wake();
      return value;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      runtime.createInTransaction(actor.id, createArgs);
      database.exec("ROLLBACK");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
    const source = (managedArtifact || nestedProgram) && isRecord(request.inputs.source) && typeof request.inputs.source.artifact_id === "string"
      ? inspectActionArtifact(database, options.storage.workspaceRoot(), options.workspaceId, actor, request.inputs.source.artifact_id,
        id => authorizePicked(actor, id))
      : undefined;
    if (managedArtifact && !source) throw new CoreError("INVALID_ARGUMENT", "An exact owned Action artifact input is required.");
    let forwardedArtifact: { artifactId: string; digest: string; size: number } | undefined;
    if (pipelineArtifactId) {
      const owner = managedActionArtifactOwner(database, options.workspaceId, actor, pipelineArtifactId);
      if (!owner) throw new CoreError("ACCESS_DENIED", "Pipeline artifacts must be published managed outputs of this actor.");
      verifyOwnedActionArtifact(database, options.workspaceId, actor, owner, pipelineArtifactId);
      const original = await readAutomaticActionResult(actor, owner);
      if (!original || original.artifact_id !== pipelineArtifactId)
        throw new CoreError("ACCESS_DENIED", "The pipeline artifact producer is unavailable.");
      forwardedArtifact = inspectActionArtifact(database, options.storage.workspaceRoot(), options.workspaceId, actor, pipelineArtifactId);
    }
    if (!processBridge) throw new CoreError("ADAPTER_UNAVAILABLE", "The native Action process bridge is unavailable.");
    try {
      let approved: boolean | undefined;
      if (implementation.kind === "builtin" && !managedArtifact) approved = true;
      else if (implementation.kind === "pipeline" || managedArtifact) {
        const remaining = call.deadline - Date.now();
        if (remaining <= 0 || managedArtifact && !options.action?.approveManagedArtifact
          || !managedArtifact && !options.action?.approvePurePipeline)
          throw new CoreError("ADAPTER_UNAVAILABLE", "Action invocation approval is unavailable.");
        const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(remaining)]);
        let abort!: () => void;
        const interrupted = new Promise<undefined>(resolve => {
          abort = () => resolve(undefined);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) resolve(undefined);
        });
        try {
          const approval = managedArtifact && source
            ? options.action!.approveManagedArtifact!(binding, source)
            : options.action!.approvePurePipeline!(binding, forwardedArtifact);
          approved = await Promise.race([approval, interrupted]);
        }
        finally { signal.removeEventListener("abort", abort); }
        if (approved === undefined || signal.aborted)
          throw new CoreError("CLOSED", "Action invocation approval was interrupted.");
      } else approved = await processBridge.approveRun(call.run_id, binding, call.deadline, nestedProgram ? source : undefined);
      if (!approved) throw new CoreError("ACCESS_DENIED", "ACTION_EFFECT_CONSENT_REQUIRED: The host operator did not approve this exact Action invocation.");
      if (options.action?.automaticTrusted?.authorize
        && !await options.action.automaticTrusted.authorize(request.actionId, request.contentHash, current.epoch))
        throw new CoreError("ACCESS_DENIED", "The host denied this registered Action revision.");
      const finalTrust = readTrust();
      if (nested && !nested.fence() || !finalTrust || finalTrust.actorId !== current.actorId || finalTrust.workspaceId !== current.workspaceId
        || finalTrust.epoch !== current.epoch || !registeredAction(current, request.actionId, request.contentHash))
        throw new CoreError("ACCESS_DENIED", "Action registration or workspace trust changed during effect consent.");
      if (database.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Action call requires an idle host database.");
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("INSERT INTO native_action_automatic_calls VALUES(?,?,?,?,?,?)")
          .run(actor.id, request.idempotencyKey, requestSha256, call.operation_id, call.run_id, call.deadline);
        if (nested) {
          if (!nested.fence()) throw new CoreError("ACCESS_DENIED", "Parent Action invocation was revoked before child creation.");
          writeNestedActionPlan(database, { ...nested.plan, childRunId: call.run_id });
        }
        const value = runtime.createInTransaction(actor.id, createArgs);
        options.assertOwner();
        database.exec("COMMIT");
        wake();
        return value;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      processBridge.discardApproval(call.run_id);
      throw error;
    }
  }
  function automaticActionTrustStatus() {
    const current = readTrust();
    return { enabled: !!options.action?.automaticTrusted, trustedWorkspace: !!current,
      ...(current ? { workspaceId: current.workspaceId, actorId: current.actorId, epoch: current.epoch } : {}) };
  }
  async function revokeAutomaticActionTrust() {
    const authority = options.action?.automaticTrusted;
    if (!authority) throw new CoreError("NOT_AVAILABLE", "Automatic Action trust is not configured by this host.");
    const previous = authority.current();
    await authority.revoke();
    const next = authority.current();
    if (next.trustedWorkspace || next.epoch === previous.epoch)
      throw new CoreError("INVALID_CONFIGURATION", "Host revocation must disable workspace trust and advance its epoch.");
    await fenceUntrustedRuns();
    options.assertOwner();
    return automaticActionTrustStatus();
  }
  return {
    definitions: actionRuntimeDefinitions,
    automaticActionTrustEnabled: !!options.action?.automaticTrusted,
    automaticActionTrustStatus,
    revokeAutomaticActionTrust,
    admitActionProposal,
    readRegisteredAction,
    readAutomaticActionResult,
    prepareManagedArtifactExport,
    preparePickedArtifactAccess,
    pickAndImportArtifact,
    pickAndExportArtifact,
    createActionRunFromProposal,
    readAction(request: ActionRuntimeHostRequest): unknown {
      available();
      return readActionRuntime(runtime, request);
    },
    mutateAction(request: ActionRuntimeHostRequest): unknown {
      available();
      return mutateActionRuntime(runtime, request);
    },
    async start() {
      if (closing) throw new CoreError("CLOSED", "Native host services are closing.");
      if (started) return;
      try { await options.action?.automaticTrusted?.refresh?.(); }
      catch { /* An unavailable authority is fail-closed but does not prevent non-Action services from starting. */ }
      runtime.recoverInterrupted();
      started = true;
      if (configured) wake();
      if (options.action?.automaticTrusted && !trustMonitor) {
        trustMonitor = setInterval(() => { void fenceUntrustedRuns(); }, 100);
        trustMonitor.unref();
      }
    },
    wake,
    assertQuiescent,
    async backup(destination: string, transport: "native-host" | "cli" = "native-host") {
      await authorize({ operation: "backup", transport, workspaceId: options.workspaceId, destination });
      if (!options.acquireQuiescence) throw new CoreError("QUIESCENCE_REQUIRED", "Native host admission must be stopped before backup.");
      return createWorkspaceBackup(options.storage, destination, {
        async acquireQuiescence() {
          const lease = await options.acquireQuiescence!();
          try { lease.assertHeld(); assertQuiescent(); }
          catch (error) { await lease.release(); throw error; }
          return {
            assertHeld() { lease.assertHeld(); assertQuiescent(); },
            release: () => lease.release(),
          };
        },
      }, { ...options.backupOptions, database });
    },
    async restore(backupPath: string, destination: string, transport: "native-host" | "cli" = "native-host") {
      await authorize({ operation: "restore", transport, workspaceId: options.workspaceId, destination, backupPath });
      return restoreWorkspaceBackup(backupPath, destination, options.backupOptions);
    },
    async close(closeOptions: { drainMs?: number } = {}) {
      closing = true;
      shutdown.abort();
      if (retry) { clearTimeout(retry); retry = undefined; }
      if (trustMonitor) { clearInterval(trustMonitor); trustMonitor = undefined; }
      await trustMonitorTask;
      await runtime.close(closeOptions);
      await processBridge?.close(closeOptions);
      await Promise.allSettled([...scheduled.values()]);
      await options.action?.automaticTrusted?.close?.();
    },
  };
}
