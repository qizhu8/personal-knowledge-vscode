import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { readWorkflowCompiler } from "./workflow-compiler.js";
import { canonicalJson, type WorkflowDefinitionV1, type WorkflowNodeV1, type WorkflowNodeControlV1 } from "./domain/project-recipes-workflow-contracts.js";
import { normalizeTypedValue } from "./domain/project-recipes-value-contracts.js";
import { workflowRuntimeBindings, validateRuntimeBindings, resolveRuntimeNode, resolveRunOutputs,
  workflowRuntimeBindingsFromOriginalInputs, ORIGINAL_RECIPE_METADATA_SEMANTICS,
  type WorkflowRuntimeBindings } from "./domain/workflow-executor-bindings.js";
import { assertWorkflowCronSlot } from "./domain/workflow-executor-cron.js";
import { originalRecipeLoops, type OriginalRecipeLoop } from "./domain/workflow-executor-original-loops.js";
import {
  createAgentSnapshot, createSchedulerAssignment, offerAssignment, claimAssignment, expireLease,
  revokeAuthority, determineOutputAuthority, releaseLease, type SchedulerAssignment,
  type AgentSnapshot, type OutputSubmission,
} from "./domain/workflow-runtime-scheduler.js";
import {
  adapterKey, assertSupportedControls, dependencyState, acceptStepResult, settle,
  type Step, type RunState,
} from "./domain/workflow-executor-state.js";
import {
  WORKFLOW_EXECUTOR_LIMITS as L, workflowExecutorCreate, workflowExecutorCancel,
  workflowExecutorResult, workflowExecutorView, workflowExecutorDefinitions,
  type WorkflowExecutorCreate, type WorkflowExecutorCancel,
} from "./workflow-executor-contracts.js";

export { workflowExecutorDefinitions, WORKFLOW_EXECUTOR_LIMITS } from "./workflow-executor-contracts.js";
export { adapterKey } from "./domain/workflow-executor-state.js";
export const WORKFLOW_EXECUTOR_DDL = `
CREATE TABLE IF NOT EXISTS workflow_executor_runs (
 actor_id TEXT NOT NULL, run_id TEXT NOT NULL, version INTEGER NOT NULL,
 snapshot TEXT NOT NULL, PRIMARY KEY(actor_id,run_id)
);
CREATE TABLE IF NOT EXISTS workflow_executor_assignments (
 assignment_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, run_id TEXT NOT NULL,
 node_id TEXT NOT NULL, owner_id TEXT NOT NULL, record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_executor_assignment_run ON workflow_executor_assignments(actor_id,run_id);
CREATE TABLE IF NOT EXISTS workflow_executor_events (
 actor_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
 kind TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(actor_id,run_id,sequence)
);
CREATE TABLE IF NOT EXISTS workflow_executor_receipts (
 actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 result TEXT NOT NULL, PRIMARY KEY(actor_id,operation_id)
);`;
export function initializeWorkflowExecutor(database: DatabaseSync) { database.exec(WORKFLOW_EXECUTOR_DDL); }
export interface WorkflowInvocation {
  schema: "pkm.workflow.executor.invocation/v1";
  actorId: string; runId: string; node: WorkflowNodeV1; iteration: number;
  invocationId: string; executableDigest: string; adapter: AdapterPin;
  inputs: Record<string, unknown>; previousOutputs: Record<string, unknown>;
  inputDigest: string; deadline: number; lease: OutputSubmission;
  legacyRunInputs?: true;
  runtimeControl?: WorkflowNodeControlV1;
  executionSemantics?: typeof ORIGINAL_RECIPE_METADATA_SEMANTICS;
  loopContext?: { loopId: string; iteration: number; maxIterations: number; condition: string }[];
}
export interface WorkflowStepAdapter {
  id: string; version: number; outputContractDigest: string; authorizationDigest: string;
  authorizeDefinition(binding: Readonly<{
    actorId: string; executableDigest: string; source: unknown; node: WorkflowNodeV1;
    runtimeBindings?: WorkflowRuntimeBindings;
    executionSemantics?: typeof ORIGINAL_RECIPE_METADATA_SEMANTICS;
  }>): boolean;
  authorizeData?(binding: Readonly<{
    actorId: string; executableDigest: string; source: unknown; node: WorkflowNodeV1;
    definition: WorkflowDefinitionV1;
    inputs: Record<string, unknown>; previousOutputs: Record<string, unknown>;
    candidate?: { nodeId: string; outputs: Record<string, unknown> };
    runtimeBindings?: WorkflowRuntimeBindings;
    executionSemantics?: typeof ORIGINAL_RECIPE_METADATA_SEMANTICS;
  }>): boolean;
  execute(invocation: Readonly<WorkflowInvocation>, context: { signal: AbortSignal }): Promise<unknown>;
  validateOutput(outputs: Record<string, unknown>): boolean;
}
export interface WorkflowTriggerAuthorization {
  actorId: string; runId: string; executableDigest: string; source: unknown;
  trigger: Extract<NonNullable<WorkflowRuntimeBindings["trigger"]>, { mode: "automation" }>;
  phase: "create" | "dispatch";
}
type AdapterPin = Pick<WorkflowStepAdapter, "id" | "version" | "outputContractDigest" | "authorizationDigest"> & { key: string };
type Snapshot = {
  dispatchMode?: "explicit";
  legacyRunInputs?: true;
  runId: string; version: number; state: RunState; definition: WorkflowDefinitionV1;
  executableDigest: string; source: unknown; inputs: Record<string, unknown>;
  deadline: number; steps: number; eventSequence: number;
  nodes: Step[]; adapters: Record<string, AdapterPin>;
};
type Assignment = {
  scheduler: SchedulerAssignment; agent: AgentSnapshot; ownerId: string;
  invocation?: WorkflowInvocation;
};
type OriginalLoopState = OriginalRecipeLoop & {
  iteration: number; state: "running" | "completed" | "failed" | "limited";
  history: { iteration: number; nodes: Record<string, unknown> }[];
};
export interface WorkflowSubflowRecipe {
  recipeId: string; revision: number; executableDigest: string; compiledExecutableDigest: string;
}
export interface WorkflowSubflowLink {
  parentRunId: string; parentNodeId: string; parentInvocationId: string; childRunId: string;
  rootRunId: string; depth: number; attempt: number; childRecipe: WorkflowSubflowRecipe;
}
export interface WorkflowSubflowTreeBudget { maxSteps: number; maxDepth: number; maxRuns: number }
const treeBudgetSchema = z.strictObject({
  maxSteps: z.number().int().positive().max(L.treeSteps),
  maxDepth: z.number().int().positive().max(L.treeDepth),
  maxRuns: z.number().int().positive().max(L.treeRuns),
});
const subflowRecipeSchema = z.strictObject({
  recipeId: z.string().min(1).max(256), revision: z.number().int().positive(),
  executableDigest: z.string().regex(/^[a-f0-9]{64}$/), compiledExecutableDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const subflowLinkSchema = z.strictObject({
  parentRunId: z.string().min(1), parentNodeId: z.string().min(1), parentInvocationId: z.uuid(),
  childRunId: z.string().min(1), rootRunId: z.string().min(1),
  depth: z.number().int().positive().max(L.treeDepth), attempt: z.number().int().positive(),
  childRecipe: subflowRecipeSchema,
});
const originalNodeObservationSchema = z.strictObject({
  schema: z.literal("pkm.original-recipe-node-observation/v1"),
  actorId: z.string().min(1).max(256), runId: z.string().min(1).max(128),
  invocationId: z.uuid(), nodeId: z.string().min(1).max(128),
  iteration: z.number().int().min(0).max(L.steps - 1),
  progress: z.record(z.string(), z.json()),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  lastHeartbeatAt: z.iso.datetime({ offset: true }).nullable(),
  lastProgressAt: z.iso.datetime({ offset: true }).nullable(),
});
const invocationCompletionClockSchema = z.strictObject({
  schema: z.literal("pkm.workflow.invocation-completion-clock/v1"),
  invocationId: z.uuid(), assignmentId: z.string().min(1),
  completedAt: z.number().safe().int().nonnegative(),
});
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const fail = (code: string, message: string): never => { throw new CoreError(code, message); };
const active = (run: Snapshot) => run.state === "ready" || run.state === "running";
const pinSchema = z.strictObject({
  id: z.string().min(1).max(128), version: z.number().safe().int().positive(),
  outputContractDigest: z.string().regex(/^[a-f0-9]{64}$/),
  authorizationDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
function actor(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) fail("INVALID_ARGUMENT", "Authenticated actor required.");
}
function bounded(value: unknown, maximum: number): void {
  const stack = [{ value, depth: 0 }], seen = new Set<object>();
  let count = 0, bytes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++count > 32_768 || item.depth > 32) fail("RESOURCE_LIMIT", "Executor JSON nesting/value limit.");
    if (item.value === null || typeof item.value === "boolean") continue;
    if (typeof item.value === "string") { bytes += Buffer.byteLength(item.value); }
    else if (typeof item.value === "number" && Number.isFinite(item.value)) continue;
    else if (typeof item.value === "object") {
      if (seen.has(item.value)) fail("INVALID_ARGUMENT", "Executor JSON must not contain cycles or aliases.");
      seen.add(item.value);
      if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item.value))) fail("INVALID_ARGUMENT", "Plain JSON required.");
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item.value))) {
        if (Array.isArray(item.value) && key === "length") continue;
        if (!descriptor.enumerable || !("value" in descriptor)) fail("INVALID_ARGUMENT", "Plain JSON required.");
        bytes += Buffer.byteLength(key);
        stack.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    } else fail("INVALID_ARGUMENT", "Plain JSON required.");
    if (bytes > maximum) fail("RESOURCE_LIMIT", "Executor JSON byte limit.");
  }
  if (Buffer.byteLength(JSON.stringify(value)) > maximum) fail("RESOURCE_LIMIT", "Executor JSON byte limit.");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const item of Object.values(value)) freeze(item); }
  return value;
}
function command(scheduler: SchedulerAssignment, kind: string) {
  const commandId = randomUUID();
  return { commandId, fingerprint: hash({ commandId, kind }), expected: {
    ...scheduler.authority, assignmentVersion: scheduler.version,
  } };
}
function view(run: Snapshot) {
  return workflowExecutorView.parse({
    schema: "pkm.workflow.executor.run/v1", runId: run.runId, version: run.version,
    state: run.state, executableDigest: run.executableDigest, source: run.source,
    deadline: run.deadline, steps: run.steps, nodes: run.nodes.map(({ assignmentId: _assignment, ...node }) => node),
    execution: "native-injected",
    ...(run.dispatchMode ? { dispatchMode: run.dispatchMode } : {}),
  });
}

/** Host-only scheduler. Shared DB calls are synchronous; native dispatch is never inside a transaction.
 * The host supplies authenticated actors, an isolated workspace and immutable adapter registrations.
 */
export class WorkflowExecutor {
  private readonly adapters: Readonly<Record<string, Readonly<WorkflowStepAdapter>>>;
  private readonly controllers = new Map<string, { actorId: string; runId: string; controller: AbortController }>();
  private readonly clock: () => number;
  private readonly leaseMs: number;
  private closed = false;
  private lastNow = 0;
  private readonly waits = new Map<ReturnType<typeof setTimeout>, () => void>();
  constructor(private readonly database: DatabaseSync, private readonly options: {
    workspaceRoot: string; ownerId: string; adapters: Readonly<Record<string, WorkflowStepAdapter>>;
    clock?: () => number; leaseMs?: number; assertOwner?: () => void;
    authorizeTrigger?(binding: Readonly<WorkflowTriggerAuthorization>): boolean;
    resolveRecipe?(source: unknown): { status: string; executableDigest: string; definition: WorkflowDefinitionV1; source: unknown };
  }) {
    z.string().min(1).max(128).parse(options.ownerId);
    this.clock = options.clock ?? Date.now;
    this.leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1 || this.leaseMs > L.leaseMs) fail("INVALID_ARGUMENT", "Lease bound invalid.");
    this.adapters = Object.freeze(Object.fromEntries(Object.entries(options.adapters).map(([key, adapter]) => {
      pinSchema.parse({ id: adapter.id, version: adapter.version, outputContractDigest: adapter.outputContractDigest, authorizationDigest: adapter.authorizationDigest });
      if (typeof adapter.execute !== "function" || typeof adapter.validateOutput !== "function" || typeof adapter.authorizeDefinition !== "function") {
        fail("INVALID_ARGUMENT", "Native adapter functions and explicit definition authorization required.");
      }
      return [key, Object.freeze({ ...adapter, execute: adapter.execute.bind(adapter),
        validateOutput: adapter.validateOutput.bind(adapter), authorizeDefinition: adapter.authorizeDefinition.bind(adapter),
        ...(adapter.authorizeData ? { authorizeData: adapter.authorizeData.bind(adapter) } : {}) })];
    })));
    this.outside(); initializeWorkflowExecutor(database);
  }
  private now() {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < this.lastNow) fail("CLOCK_INVALID", "Monotonic server clock required.");
    this.lastNow = now; return now;
  }
  private outside() {
    if (this.closed) fail("CLOSED", "Executor is closed.");
    if (this.database.isTransaction) fail("TRANSACTION_BOUNDARY", "Host scheduling must run outside caller transactions.");
    this.options.assertOwner?.();
  }
  private atomic<T>(fn: () => T): T {
    this.outside(); this.database.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.options.assertOwner?.(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  private load(actorId: string, runId: string): Snapshot {
    actor(actorId);
    const row = this.database.prepare("SELECT snapshot FROM workflow_executor_runs WHERE actor_id=? AND run_id=?").get(actorId, runId);
    if (!row) return fail("NOT_FOUND", "Owned executor run not found.");
    return JSON.parse(String(row.snapshot)) as Snapshot;
  }
  private event(actorId: string, run: Snapshot, kind: string, record: unknown) {
    if (++run.eventSequence > L.events) fail("RESOURCE_LIMIT", "Executor event capacity reached.");
    this.database.prepare("INSERT INTO workflow_executor_events VALUES(?,?,?,?,?)")
      .run(actorId, run.runId, run.eventSequence, kind, JSON.stringify(record));
  }
  private save(actorId: string, run: Snapshot, previous: number) {
    run.version = previous + 1;
    bounded(run, L.snapshotBytes);
    const result = this.database.prepare("UPDATE workflow_executor_runs SET version=?,snapshot=? WHERE actor_id=? AND run_id=? AND version=?")
      .run(run.version, JSON.stringify(run), actorId, run.runId, previous);
    if (result.changes !== 1) fail("CONFLICT", "Executor run CAS failed.");
  }
  private receipt<T>(actorId: string, operationId: string, fingerprint: string, fn: () => T): T {
    actor(actorId);
    const prior = this.database.prepare("SELECT fingerprint,result FROM workflow_executor_receipts WHERE actor_id=? AND operation_id=?").get(actorId, operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail("CONFLICT", "Executor operationId reused.");
      return JSON.parse(String(prior.result)) as T;
    }
    this.database.exec("SAVEPOINT workflow_executor_mutation");
    try {
      if (Number(this.database.prepare("SELECT count(*) AS n FROM workflow_executor_receipts").get()!.n) >= L.receipts) {
        fail("RESOURCE_LIMIT", "Executor receipt capacity reached; trusted archival required.");
      }
      const result = fn();
      this.database.prepare("INSERT INTO workflow_executor_receipts VALUES(?,?,?,?)").run(actorId, operationId, fingerprint, JSON.stringify(result));
      this.database.exec("RELEASE workflow_executor_mutation");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK TO workflow_executor_mutation; RELEASE workflow_executor_mutation");
      throw error;
    }
  }
  private installed(pin: AdapterPin) {
    const adapter = this.adapters[pin.key];
    if (!adapter || adapter.id !== pin.id || adapter.version !== pin.version || adapter.outputContractDigest !== pin.outputContractDigest
      || adapter.authorizationDigest !== pin.authorizationDigest) {
      return fail("ADAPTER_UNAVAILABLE", "Exact pinned native adapter/output contract is not installed.");
    }
    return adapter;
  }
  private assertCurrentSource(actorId: string, run: Snapshot) {
    if (!this.hostControl(actorId, run.runId, "runtime-bindings") && !this.executionSemantics(actorId, run.runId)) return;
    const source = run.source as { kind: string; recipeId?: string; revision?: number };
    const requestSource = source.kind === "inline" ? { kind: "inline", definition: run.definition }
      : { kind: "recipe", recipeId: source.recipeId, expectedRevision: source.revision, expectedExecutableDigest: run.executableDigest };
    const compiled = source.kind === "recipe" && this.options.resolveRecipe
      ? this.options.resolveRecipe(run.source)
      : readWorkflowCompiler(this.options.workspaceRoot, { operation: "workflow.definition.compile", args: { source: requestSource } }, []) as { status: string; executableDigest: string };
    if (compiled.status !== "valid" || compiled.executableDigest !== run.executableDigest) fail("CONFLICT", "Pinned workflow source changed.");
  }
  private assertDelivery(actorId: string, run: Snapshot, now: number) {
    const trigger = this.bindings(actorId, run.runId).trigger;
    if (trigger?.mode === "automation" && (now < trigger.dueAt || now >= trigger.expiresAt
      || this.options.authorizeTrigger?.(freeze({ actorId, runId: run.runId, executableDigest: run.executableDigest,
        source: run.source, trigger, phase: "dispatch" })) !== true)) fail("FORBIDDEN", "Cron delivery consent is no longer current.");
  }
  create(actorId: string, args: WorkflowExecutorCreate) { return this.atomic(() => this.createInTransaction(actorId, args)); }
  createInTransaction(actorId: string, args: WorkflowExecutorCreate, host?: {
    dispatchMode: "explicit"; legacyUntypedInputs?: true; legacyRunInputs?: true; originalRecipeMetadata?: true;
    treeBudget?: WorkflowSubflowTreeBudget;
    subflowParent?: { runId: string; invocationId: string; childRecipe: WorkflowSubflowRecipe };
  }) {
    if (this.closed || !this.database.isTransaction) fail("TRANSACTION_BOUNDARY", "Create requires the shared transaction.");
    bounded(args, 262_144);
    const parsed = workflowExecutorCreate.parse(args);
    const link = host?.subflowParent ? this.validateSubflowChild(actorId, parsed, host.subflowParent) : undefined;
    if (link && !host?.originalRecipeMetadata) fail("FORBIDDEN", "Child intent requires the trusted Original metadata host.");
    if (link && host?.treeBudget) fail("INVALID_ARGUMENT", "Child execution inherits the root tree budget.");
    if (host?.treeBudget && !host.originalRecipeMetadata) fail("INVALID_ARGUMENT", "Tree budget requires the Original host.");
    return this.receipt(actorId, parsed.operationId, hash({ operation: "create", args: parsed, ...(host ? { host } : {}) }), () => {
      const now = this.now();
      if (parsed.deadline <= now || parsed.deadline > now + L.deadlineMs) fail("INVALID_ARGUMENT", "Deadline outside execution bound.");
      if (Number(this.database.prepare("SELECT count(*) AS n FROM workflow_executor_runs").get()!.n) >= L.runs) fail("RESOURCE_LIMIT", "Run capacity reached.");
      let compiled = (parsed.source.kind === "recipe" && this.options.resolveRecipe
        ? this.options.resolveRecipe(parsed.source)
        : readWorkflowCompiler(this.options.workspaceRoot, { operation: "workflow.definition.compile", args: { source: parsed.source } }, [])) as {
        status: string; executableDigest: string; definition: WorkflowDefinitionV1; source: unknown;
      };
      if (compiled.status !== "valid") fail("INVALID_DEFINITION", "Workflow compiler rejected the definition.");
      if (compiled.executableDigest !== parsed.expectedExecutableDigest) fail("CONFLICT", "Executable digest changed.");
      if (link) {
        const source = compiled.source as { kind?: string; recipeId?: string; revision?: number; executableDigest?: string; snapshotRevision?: string };
        if (source.kind !== "recipe" || source.recipeId !== link.childRecipe.recipeId
          || source.revision !== link.childRecipe.revision || source.executableDigest !== link.childRecipe.compiledExecutableDigest
          || parsed.source.kind !== "recipe" || source.snapshotRevision !== parsed.source.snapshotRevision)
          fail("CONFLICT", "Resolved subflow child source does not match its admitted pins.");
      }
      if (host?.originalRecipeMetadata && parsed.source.kind === "inline") {
        const authored = parsed.source.definition as unknown as WorkflowDefinitionV1;
        const nodes = new Map(compiled.definition.spec.nodes.map(node => [node.nodeId, node]));
        compiled = { ...compiled, definition: { ...compiled.definition, spec: { ...compiled.definition.spec,
          nodes: authored.spec.nodes.map(node => nodes.get(node.nodeId)!),
        } } };
      }
      if (host?.originalRecipeMetadata && parsed.runtimeBindings) fail("INVALID_ARGUMENT", "Original metadata and native control bindings are distinct execution modes.");
      try { assertSupportedControls(compiled.definition, host?.originalRecipeMetadata); }
      catch { fail("UNSUPPORTED_EXECUTION", "Definition requires unqualified control/output features."); }
      const runtimeBindings = workflowRuntimeBindings.parse(parsed.runtimeBindings ?? {});
      if (!host?.originalRecipeMetadata) validateRuntimeBindings(compiled.definition, runtimeBindings);
      if (runtimeBindings.trigger?.mode === "automation") {
        const trigger = runtimeBindings.trigger;
        assertWorkflowCronSlot(compiled.definition.spec.trigger!, trigger.dueAt);
        if (trigger.dueAt <= now || trigger.dueAt >= parsed.deadline || trigger.expiresAt <= trigger.dueAt
          || trigger.expiresAt > parsed.deadline) fail("INVALID_ARGUMENT", "Cron consent expiry/due slot must be inside the execution deadline.");
        if (this.options.authorizeTrigger?.(freeze({ actorId, runId: parsed.runId, executableDigest: compiled.executableDigest,
          source: compiled.source, trigger, phase: "create" })) !== true) fail("FORBIDDEN", "Current explicit future-run consent required.");
        const claimed = this.database.prepare(`SELECT run_id FROM workflow_executor_events
          WHERE actor_id=? AND kind='runtime-bindings' AND json_extract(record,'$.trigger.consentId')=?
          AND json_extract(record,'$.trigger.dueAt')=?`).get(actorId, trigger.consentId, trigger.dueAt);
        if (claimed) fail("CONFLICT", "Cron consent due slot already owns a durable run.");
      }
      const adapters: Record<string, AdapterPin> = Object.create(null);
      for (const node of compiled.definition.spec.nodes) {
        const key = adapterKey(node), adapter = this.adapters[key];
        if (!adapter) fail("ADAPTER_UNAVAILABLE", "Explicit native adapter configuration required for every node.");
        if (adapter.authorizeDefinition(freeze(JSON.parse(JSON.stringify({
          actorId, executableDigest: compiled.executableDigest, source: compiled.source, node,
          ...(parsed.runtimeBindings ? { runtimeBindings } : {}),
          ...(host?.originalRecipeMetadata ? { executionSemantics: ORIGINAL_RECIPE_METADATA_SEMANTICS } : {}),
        })))) !== true) fail("FORBIDDEN", "Native adapter denied this exact actor/definition/source binding.");
        adapters[node.nodeId] = { key, id: adapter.id, version: adapter.version,
          outputContractDigest: adapter.outputContractDigest, authorizationDigest: adapter.authorizationDigest };
      }
      const inputs: Record<string, unknown> = Object.create(null);
      if (link) Object.assign(inputs, parsed.inputs);
      else if ((host?.legacyUntypedInputs || host?.originalRecipeMetadata) && Object.keys(compiled.definition.spec.inputs).length === 0)
        Object.assign(inputs, parsed.inputs);
      else if (Object.keys(parsed.inputs).some(key => !Object.hasOwn(compiled.definition.spec.inputs, key))) fail("INVALID_ARGUMENT", "Unknown workflow input.");
      for (const [key, descriptor] of link ? [] : Object.entries(compiled.definition.spec.inputs)) {
        const value = Object.hasOwn(parsed.inputs, key) ? parsed.inputs[key] : descriptor.default;
        if (value === undefined) { if (descriptor.required) fail("INVALID_ARGUMENT", "Required workflow input missing."); continue; }
        inputs[key] = normalizeTypedValue(descriptor, value);
      }
      for (const node of compiled.definition.spec.nodes) {
        const binding = runtimeBindings.nodes[node.nodeId];
        if (binding?.repeat?.source.kind === "input" || binding?.cases?.kind === "input")
          resolveRuntimeNode(node, runtimeBindings, inputs, [], 0);
      }
      if (host?.originalRecipeMetadata && workflowRuntimeBindingsFromOriginalInputs(compiled.definition, inputs))
        fail("INVALID_ARGUMENT", "Explicit native controls cannot execute as Original metadata.");
      for (const node of compiled.definition.spec.nodes) {
        const adapter = this.adapters[adapters[node.nodeId]!.key]!;
        if (adapter.authorizeData && adapter.authorizeData(freeze(JSON.parse(JSON.stringify({
          actorId, executableDigest: compiled.executableDigest, source: compiled.source, definition: compiled.definition, node, inputs, previousOutputs: {},
          ...(parsed.runtimeBindings ? { runtimeBindings } : {}),
          ...(host?.originalRecipeMetadata ? { executionSemantics: ORIGINAL_RECIPE_METADATA_SEMANTICS } : {}),
        })))) !== true) fail("FORBIDDEN", "Native adapter denied persistent workflow data.");
      }
      const run: Snapshot = {
        ...(host ? { dispatchMode: host.dispatchMode } : parsed.runtimeBindings ? { dispatchMode: "explicit" as const } : {}),
        ...(host?.legacyRunInputs || host?.originalRecipeMetadata ? { legacyRunInputs: true } : {}),
        runId: parsed.runId, version: 1, state: "ready", definition: compiled.definition,
        executableDigest: compiled.executableDigest, source: compiled.source, inputs,
        deadline: parsed.deadline, steps: 0, eventSequence: 0, adapters,
        nodes: compiled.definition.spec.nodes.map(node => ({ nodeId: node.nodeId, state: "pending", iteration: 0, effect: "not-started", outputs: {} })),
      };
      this.event(actorId, run, "created", { executableDigest: run.executableDigest, adapters });
      if (parsed.runtimeBindings) this.event(actorId, run, "runtime-bindings", runtimeBindings);
      if (parsed.runtimeBindings && !host) this.event(actorId, run, "native-runtime-control", { schema: "pkm.workflow.runtime-controls/v1" });
      if (host?.originalRecipeMetadata) this.event(actorId, run, "original-recipe-control-semantics", {
        executionSemantics: ORIGINAL_RECIPE_METADATA_SEMANTICS,
        delivery: "manual",
        repeat: "authoring-metadata-not-repeat-execution",
        dynamicCases: "declared-outcomes-explicitly-reported",
        outputs: "original-current-result-node-results-not-typed-output-mapping",
      });
      if (!link && host?.originalRecipeMetadata && (host.treeBudget || run.definition.spec.nodes.some(node => node.kind === "pkm.subflow/v1"))) {
        this.event(actorId, run, "host-subflow-tree", treeBudgetSchema.parse(host.treeBudget ?? {
          maxSteps: L.treeSteps, maxDepth: L.treeDepth, maxRuns: L.treeRuns,
        }));
      }
      if (link) this.event(actorId, run, "host-subflow-parent", link);
      bounded(run, L.snapshotBytes);
      this.database.prepare("INSERT INTO workflow_executor_runs VALUES(?,?,?,?)").run(actorId, run.runId, run.version, JSON.stringify(run));
      if (link) {
        const parent = this.load(actorId, link.parentRunId), previous = parent.version;
        this.event(actorId, parent, "host-subflow-child", link); this.save(actorId, parent, previous);
      }
      return view(run);
    });
  }
  createHostOwnedSubflowChildInTransaction(actorId: string, parentRunId: string, invocationId: string,
    childArgs: WorkflowExecutorCreate, childRecipe: WorkflowSubflowRecipe) {
    const result = this.createInTransaction(actorId, childArgs, { dispatchMode: "explicit", originalRecipeMetadata: true,
      subflowParent: { runId: parentRunId, invocationId, childRecipe } });
    return view(this.load(actorId, result.runId));
  }
  getSubflowLinks(actorId: string, parentRunId: string): WorkflowSubflowLink[] {
    this.options.assertOwner?.(); this.load(actorId, parentRunId);
    return this.database.prepare(`SELECT record FROM workflow_executor_events
      WHERE actor_id=? AND run_id=? AND kind='host-subflow-child' ORDER BY sequence`).all(actorId, parentRunId)
      .map(row => {
        const link = subflowLinkSchema.parse(JSON.parse(String(row.record)));
        if (link.parentRunId !== parentRunId) fail("INTEGRITY_ERROR", "Subflow link belongs to a different parent.");
        return link;
      });
  }
  hostOwnedSubflowChildren(actorId: string, parentRunId: string) {
    return this.getSubflowLinks(actorId, parentRunId);
  }
  private subflowParent(actorId: string, runId: string): WorkflowSubflowLink | undefined {
    const value = this.hostControl(actorId, runId, "host-subflow-parent");
    return value === undefined ? undefined : subflowLinkSchema.parse(value);
  }
  private subflowTree(actorId: string, runId: string) {
    const rootRunId = this.subflowParent(actorId, runId)?.rootRunId ?? runId;
    const value = this.hostControl(actorId, rootRunId, "host-subflow-tree");
    if (value === undefined) return undefined;
    const budget = treeBudgetSchema.parse(value), root = this.load(actorId, rootRunId);
    const links: WorkflowSubflowLink[] = [], pending = [rootRunId], ids = new Set(pending);
    while (pending.length) for (const link of this.getSubflowLinks(actorId, pending.pop()!)) {
      if (link.rootRunId !== rootRunId || ids.has(link.childRunId) || ids.size >= budget.maxRuns)
        fail("INTEGRITY_ERROR", "Subflow tree journal is invalid.");
      ids.add(link.childRunId); pending.push(link.childRunId); links.push(link);
    }
    return { rootRunId, root, budget, links,
      runs: [root, ...links.map(link => this.load(actorId, link.childRunId))] };
  }
  private assertSubflowTree(actorId: string, run: Snapshot, offering = false) {
    const tree = this.subflowTree(actorId, run.runId);
    if (!tree) return;
    let child = run, parent = this.subflowParent(actorId, child.runId), depth = 0;
    while (parent) {
      if (++depth > tree.budget.maxDepth) fail("INTEGRITY_ERROR", "Subflow ancestry exceeds its admitted depth.");
      const ancestor = this.load(actorId, parent.parentRunId);
      if (!active(ancestor)) fail("CONFLICT", "Subflow ancestor no longer permits execution.");
      const step = ancestor.nodes.find(node => node.nodeId === parent!.parentNodeId);
      if (step?.state !== "running" || !step.assignmentId
        || this.assignment(step.assignmentId).invocation?.invocationId !== parent.parentInvocationId)
        fail("CONFLICT", "Subflow parent invocation is no longer current.");
      const assignment = this.assignment(step!.assignmentId!);
      if (assignment.ownerId !== this.options.ownerId) fail("FOREIGN_TREE_OWNER", "Subflow belongs to another current host.");
      if (!assignment.invocation
        || !determineOutputAuthority(assignment.scheduler, assignment.invocation.lease, assignment.agent, this.now()).authoritative)
        fail("FORBIDDEN", "Subflow ancestor lease no longer permits execution.");
      child = ancestor; parent = this.subflowParent(actorId, child.runId);
    }
    if (this.now() >= tree.root.deadline || run.deadline > tree.root.deadline)
      fail("INVALID_ARGUMENT", "Subflow root deadline does not permit execution.");
    const claims = tree.runs.reduce((sum, item) => sum + item.steps
      + item.nodes.filter(node => node.state === "offered" || node.state === "claimed").length, 0);
    if (claims > tree.budget.maxSteps || (offering && claims === tree.budget.maxSteps))
      fail("RESOURCE_LIMIT", "Shared subflow tree claim budget exhausted.");
  }
  private validateSubflowChild(actorId: string, args: WorkflowExecutorCreate,
    value: { runId: string; invocationId: string; childRecipe: WorkflowSubflowRecipe }): WorkflowSubflowLink {
    this.options.assertOwner?.(); z.uuid().parse(value.invocationId);
    const childRecipe = subflowRecipeSchema.parse(value.childRecipe), parent = this.load(actorId, value.runId);
    if (parent.dispatchMode !== "explicit" || !this.executionSemantics(actorId, parent.runId) || !active(parent))
      return fail("FORBIDDEN", "Subflow requires the active Original parent.");
    this.assertCurrentSource(actorId, parent);
    const step = parent.nodes.find(node => node.state === "running" && node.assignmentId
      && this.assignment(node.assignmentId).invocation?.invocationId === value.invocationId);
    if (!step) return fail("CONFLICT", "Exact running parent invocation required.");
    const assignment = this.assignment(step.assignmentId!), invocation = assignment.invocation!;
    if (assignment.ownerId !== this.options.ownerId
      || !determineOutputAuthority(assignment.scheduler, invocation.lease, assignment.agent, this.now()).authoritative)
      fail("FORBIDDEN", "Subflow requires the current owned parent lease.");
    const node = parent.definition.spec.nodes.find(node => node.nodeId === step.nodeId)!;
    if (node.kind !== "pkm.subflow/v1" || node.config.recipeId !== childRecipe.recipeId
      || node.config.revision !== childRecipe.revision || node.config.executableDigest !== childRecipe.executableDigest)
      fail("CONFLICT", "Subflow child does not match the exact authored pins.");
    if (args.source.kind !== "recipe" || args.source.recipeId !== childRecipe.recipeId
      || args.source.expectedRevision !== childRecipe.revision
      || args.source.expectedExecutableDigest !== childRecipe.executableDigest
      || args.expectedExecutableDigest !== childRecipe.compiledExecutableDigest || args.deadline !== parent.deadline)
      fail("CONFLICT", "Subflow child source or deadline changed.");
    if (hash(args.inputs) !== hash(parent.inputs)) fail("CONFLICT", "Subflow must forward the exact parent global inputs.");
    const parentSource = parent.source as { snapshotRevision?: string };
    if (parentSource.snapshotRevision !== undefined && args.source.kind === "recipe"
      && args.source.snapshotRevision !== parentSource.snapshotRevision)
      fail("CONFLICT", "Subflow must retain the exact root source snapshot.");
    const attempt = invocation.iteration + 1;
    const childRunId = `recipe_run_${createHash("sha256").update(`${parent.runId}:${node.nodeId}:${attempt}`).digest("hex").slice(0, 24)}`;
    if (args.runId !== childRunId) fail("CONFLICT", "Subflow child identity is not deterministic.");
    const existing = this.getSubflowLinks(actorId, parent.runId).find(link => link.parentInvocationId === value.invocationId);
    if (existing && (existing.childRunId !== args.runId || hash(existing.childRecipe) !== hash(childRecipe)))
      fail("CONFLICT", "Parent invocation already owns a different child.");
    if (existing) {
      const child = this.load(actorId, existing.childRunId);
      this.assertCurrentSource(actorId, child);
      for (const node of child.definition.spec.nodes) {
        const adapter = this.installed(child.adapters[node.nodeId]!);
        const binding = freeze(JSON.parse(JSON.stringify({ actorId, executableDigest: child.executableDigest,
          source: child.source, node, definition: child.definition, inputs: child.inputs,
          previousOutputs: child.nodes.find(step => step.nodeId === node.nodeId)!.outputs,
          executionSemantics: ORIGINAL_RECIPE_METADATA_SEMANTICS })));
        if (adapter.authorizeDefinition(binding) !== true || adapter.authorizeData && adapter.authorizeData(binding) !== true)
          fail("FORBIDDEN", "Current child authority is required before replaying its creation receipt.");
      }
    }
    const tree = this.subflowTree(actorId, parent.runId);
    if (!tree) return fail("FORBIDDEN", "Subflow parent lacks the admitted root budget.");
    this.assertSubflowTree(actorId, parent);
    let ancestor = parent, ancestorLink = this.subflowParent(actorId, parent.runId), depth = 1;
    for (;;) {
      const source = ancestor.source as { kind?: string; recipeId?: string };
      if (source.kind === "recipe" && source.recipeId === childRecipe.recipeId)
        fail("INVALID_DEFINITION", "Recursive Recipe subflow invocation is not allowed.");
      if (!ancestorLink) break;
      if (ancestorLink.childRecipe.recipeId === childRecipe.recipeId)
        fail("INVALID_DEFINITION", "Recursive Recipe subflow invocation is not allowed.");
      ancestor = this.load(actorId, ancestorLink.parentRunId); ancestorLink = this.subflowParent(actorId, ancestor.runId); depth++;
    }
    if (depth > tree.budget.maxDepth || (!existing && tree.runs.length >= tree.budget.maxRuns))
      fail("RESOURCE_LIMIT", "Subflow tree depth or run capacity exhausted.");
    return { parentRunId: parent.runId, parentNodeId: node.nodeId, parentInvocationId: value.invocationId,
      childRunId, rootRunId: tree.rootRunId, depth, attempt, childRecipe };
  }
  private subflowDescendants(actorId: string, runId: string) {
    const ids = new Set([runId]), pending = [runId];
    while (pending.length) for (const link of this.getSubflowLinks(actorId, pending.pop()!)) {
      if (ids.has(link.childRunId) || ids.size >= L.treeRuns) fail("INTEGRITY_ERROR", "Subflow descendant journal is invalid.");
      ids.add(link.childRunId); pending.push(link.childRunId);
    }
    return ids;
  }
  private fenceSubflowDescendants(actorId: string, runId: string, reason: string) {
    for (const childId of this.subflowDescendants(actorId, runId)) {
      if (childId === runId) continue;
      const child = this.load(actorId, childId), previous = child.version;
      if (!active(child)) continue;
      this.fence(actorId, child, reason, false);
      for (const step of child.nodes) if (step.state === "pending") step.state = "cancelled";
      child.state = child.nodes.some(step => step.effect === "unknown") ? "unknown" : "cancelled";
      this.event(actorId, child, "host-subflow-ancestor-fenced", { ancestorRunId: runId, reason });
      this.save(actorId, child, previous);
    }
  }
  private abortSubflowControllers(actorId: string, runId: string) {
    const ids = this.subflowDescendants(actorId, runId);
    for (const item of this.controllers.values()) if (item.actorId === actorId && ids.has(item.runId)) item.controller.abort();
  }
  private denySubflowTree(actorId: string, run: Snapshot, previous: number, error: unknown) {
    if (error instanceof CoreError && error.code === "FOREIGN_TREE_OWNER") return;
    this.fence(actorId, run, "subflow-tree-denied", false);
    for (const step of run.nodes) if (step.state === "pending") step.state = "cancelled";
    run.state = run.nodes.some(step => step.effect === "unknown") ? "unknown" : "failed";
    this.fenceSubflowDescendants(actorId, run.runId, "subflow-tree-denied");
    this.event(actorId, run, "host-subflow-tree-denied", {}); this.save(actorId, run, previous);
  }
  get(actorId: string, runId: string) { this.outside(); return view(this.load(actorId, runId)); }
  knownInvocationResult(actorId: string, runId: string, invocationId: string):
    { known: true; status: "succeeded" | "failed"; assignmentId: string; completedAt?: number } | undefined {
    this.options.assertOwner?.(); this.load(actorId, runId); z.uuid().parse(invocationId);
    const rows = this.database.prepare(`SELECT record FROM workflow_executor_events WHERE actor_id=? AND run_id=?
      AND kind='completion' AND json_extract(record,'$.invocationId')=? ORDER BY sequence DESC LIMIT 1`).all(actorId, runId, invocationId);
    if (!rows.length) return undefined;
    const record = z.strictObject({
      nodeId: z.string(), state: z.string(), assignmentId: z.string(), authoritative: z.boolean(),
      invocationId: z.uuid(), acceptedResult: z.enum(["succeeded", "failed"]).optional(),
    }).parse(JSON.parse(String(rows[0]!.record)));
    if (!record.authoritative || !record.acceptedResult) return undefined;
    const assignment = this.assignment(record.assignmentId);
    if (assignment.invocation?.actorId !== actorId || assignment.invocation.runId !== runId
      || assignment.invocation.invocationId !== invocationId || assignment.invocation.node.nodeId !== record.nodeId)
      fail("INTEGRITY_ERROR", "Invocation completion journal does not match its exact assignment.");
    const clockRow = this.database.prepare(`SELECT record FROM workflow_executor_events WHERE actor_id=? AND run_id=?
      AND kind='invocation-completion-clock' AND json_extract(record,'$.invocationId')=?
      ORDER BY sequence DESC LIMIT 1`).get(actorId, runId, invocationId);
    const clock = clockRow && invocationCompletionClockSchema.parse(JSON.parse(String(clockRow.record)));
    if (clock && (clock.invocationId !== invocationId || clock.assignmentId !== record.assignmentId))
      fail("INTEGRITY_ERROR", "Completion clock does not match its exact known invocation.");
    return { known: true, status: record.acceptedResult, assignmentId: record.assignmentId,
      ...(clock ? { completedAt: clock.completedAt } : {}) };
  }
  list(actorId: string) {
    this.outside(); actor(actorId);
    return this.database.prepare("SELECT snapshot FROM workflow_executor_runs WHERE actor_id=? ORDER BY run_id")
      .all(actorId).map(row => view(JSON.parse(String(row.snapshot)) as Snapshot));
  }
  events(actorId: string, runId: string, after = 0, limit = 100) {
    this.outside(); this.load(actorId, runId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("INVALID_ARGUMENT", "Invalid event window.");
    return this.database.prepare("SELECT sequence,kind,record FROM workflow_executor_events WHERE actor_id=? AND run_id=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(actorId, runId, after, limit).map(row => ({ sequence: Number(row.sequence), kind: String(row.kind), record: JSON.parse(String(row.record)) }));
  }
  hostControl(actorId: string, runId: string, kind: string): unknown {
    this.options.assertOwner?.(); actor(actorId);
    const row = this.database.prepare("SELECT record FROM workflow_executor_events WHERE actor_id=? AND run_id=? AND kind=? ORDER BY sequence DESC LIMIT 1")
      .get(actorId, runId, kind);
    return row ? JSON.parse(String(row.record)) : undefined;
  }
  recordHostControlInTransaction(actorId: string, runId: string, kind: string, record: unknown) {
    this.options.assertOwner?.();
    if (this.closed || !this.database.isTransaction) fail("TRANSACTION_BOUNDARY", "Host control requires the shared transaction.");
    if (!["legacy-recipe-automation", "legacy-recipe-node-observation"].includes(kind)) fail("INVALID_ARGUMENT", "Unsupported host control journal.");
    bounded(record, 4096);
    const run = this.load(actorId, runId), previous = run.version;
    if (run.dispatchMode !== "explicit") fail("FORBIDDEN", "Host control requires an explicitly owned run.");
    if (kind === "legacy-recipe-node-observation") {
      const observation = originalNodeObservationSchema.parse(record);
      if (observation.actorId !== actorId || observation.runId !== runId || !active(run)
        || !this.executionSemantics(actorId, runId)) fail("FORBIDDEN", "Observation requires the active Original actor/run.");
      const reporter = run.nodes.find(step => step.state === "running" && step.assignmentId
        && this.assignment(step.assignmentId).invocation?.invocationId === observation.invocationId);
      if (!reporter) return fail("CONFLICT", "Observation requires the exact running reporter invocation.");
      const assignment = this.assignment(reporter.assignmentId!);
      if (assignment.ownerId !== this.options.ownerId || !assignment.invocation
        || !determineOutputAuthority(assignment.scheduler, assignment.invocation.lease, assignment.agent, this.now()).authoritative)
        fail("FORBIDDEN", "Observation requires the current owned reporter lease.");
      this.assertCurrentSource(actorId, run); this.assertSubflowTree(actorId, run);
      const observed = run.nodes.find(step => step.nodeId === observation.nodeId);
      if (!observed || (observed !== reporter && observed.effect !== "known")
        || observation.iteration !== observed.iteration - (observed.effect === "known" ? 1 : 0)
        || observed === reporter && observation.completedAt !== null)
        fail("CONFLICT", "Observation does not match a current running or known node attempt.");
      for (const target of new Set([reporter, observed])) {
        const node = run.definition.spec.nodes.find(node => node.nodeId === target!.nodeId)!;
        const adapter = this.installed(run.adapters[node.nodeId]!);
        const binding = freeze(JSON.parse(JSON.stringify({ actorId, executableDigest: run.executableDigest,
          source: run.source, node, definition: run.definition, inputs: run.inputs,
          previousOutputs: target!.outputs, executionSemantics: ORIGINAL_RECIPE_METADATA_SEMANTICS })));
        if (adapter.authorizeDefinition(binding) !== true || adapter.authorizeData && adapter.authorizeData(binding) !== true)
          fail("FORBIDDEN", "Observation requires current source and node data authority.");
      }
      record = observation;
    }
    this.event(actorId, run, kind, record); this.save(actorId, run, previous);
  }
  hostOwnedOriginalNodeObservation(actorId: string, runId: string, nodeId: string, iteration: number) {
    this.options.assertOwner?.(); this.load(actorId, runId);
    z.string().min(1).max(128).parse(nodeId); z.number().int().min(0).max(L.steps - 1).parse(iteration);
    const row = this.database.prepare(`SELECT record FROM workflow_executor_events WHERE actor_id=? AND run_id=?
      AND kind='legacy-recipe-node-observation' AND json_extract(record,'$.nodeId')=?
      AND json_extract(record,'$.iteration')=? ORDER BY sequence DESC LIMIT 1`).get(actorId, runId, nodeId, iteration);
    if (!row) return undefined;
    const record = originalNodeObservationSchema.parse(JSON.parse(String(row.record)));
    if (record.actorId !== actorId || record.runId !== runId || record.nodeId !== nodeId || record.iteration !== iteration)
      fail("INTEGRITY_ERROR", "Observation journal identity does not match its actor/run/node attempt.");
    const completed = this.database.prepare(`SELECT record FROM workflow_executor_assignments
      WHERE actor_id=? AND run_id=? AND node_id=? AND json_extract(record,'$.invocation.iteration')=?
      ORDER BY rowid DESC LIMIT 1`).get(actorId, runId, nodeId, iteration);
    if (!completed) return undefined;
    const assignment = JSON.parse(String(completed.record)) as Assignment;
    if (!assignment.invocation) return undefined;
    const proof = this.knownInvocationResult(actorId, runId, assignment.invocation.invocationId);
    if (!proof) return undefined;
    return { ...record, completedAt: proof.completedAt === undefined ? null : new Date(proof.completedAt).toISOString() };
  }
  recordNativeEffectApprovalInTransaction(actorId: string, runId: string, invocationId: string, metadata: unknown) {
    this.options.assertOwner?.();
    if (this.closed || !this.database.isTransaction) fail("TRANSACTION_BOUNDARY", "Effect approval requires the shared transaction.");
    z.uuid().parse(invocationId); bounded(metadata, 24_576);
    const run = this.load(actorId, runId), previous = run.version;
    if (run.dispatchMode !== "explicit" || this.hostControl(actorId, runId, "native-runtime-control"))
      fail("FORBIDDEN", "Effect approval requires a Recipe-owned explicit run.");
    const step = run.nodes.find(step => step.state === "running" && step.assignmentId
      && this.assignment(step.assignmentId).invocation?.invocationId === invocationId);
    if (!active(run) || !step) return fail("CONFLICT", "Exact running invocation required for effect approval.");
    const assignment = this.assignment(step.assignmentId!);
    if (assignment.ownerId !== this.options.ownerId || !assignment.invocation
      || !determineOutputAuthority(assignment.scheduler, assignment.invocation.lease, assignment.agent, this.now()).authoritative)
      fail("FORBIDDEN", "Effect approval requires the current owned invocation lease.");
    return this.receipt(actorId, `native-effect:${invocationId}`, hash({ runId, invocationId, metadata }), () => {
      this.event(actorId, run, "legacy-recipe-native-effect", { invocationId, metadata });
      this.save(actorId, run, previous);
      return { recorded: true, invocationId };
    });
  }
  private bindings(actorId: string, runId: string) {
    return workflowRuntimeBindings.parse(this.hostControl(actorId, runId, "runtime-bindings") ?? {});
  }
  executionSemantics(actorId: string, runId: string): typeof ORIGINAL_RECIPE_METADATA_SEMANTICS | undefined {
    this.options.assertOwner?.(); this.load(actorId, runId);
    const record = this.hostControl(actorId, runId, "original-recipe-control-semantics") as { executionSemantics?: unknown } | undefined;
    return record?.executionSemantics === ORIGINAL_RECIPE_METADATA_SEMANTICS ? ORIGINAL_RECIPE_METADATA_SEMANTICS : undefined;
  }
  private policyControls(actorId: string, runId: string) {
    const executionSemantics = this.executionSemantics(actorId, runId);
    return executionSemantics ? { executionSemantics } : this.hostControl(actorId, runId, "runtime-bindings")
      ? { runtimeBindings: this.bindings(actorId, runId) } : {};
  }
  originalRecipeLoopState(actorId: string, runId: string, history = true): Record<string, OriginalLoopState> {
    this.options.assertOwner?.();
    const run = this.load(actorId, runId);
    if (!this.executionSemantics(actorId, runId)) return {};
    const loops: Record<string, OriginalLoopState> = {};
    for (const definition of originalRecipeLoops(run.definition)) {
      const latest = this.database.prepare(`SELECT json_extract(record,'$.iteration') AS iteration,
        json_extract(record,'$.state') AS state FROM workflow_executor_events
        WHERE actor_id=? AND run_id=? AND kind='original-recipe-loop-state'
        AND json_extract(record,'$.loopId')=? ORDER BY sequence DESC LIMIT 1`).get(actorId, runId, definition.loopId);
      const iteration = latest ? Number(latest.iteration) : 1;
      const state = latest ? String(latest.state) : "running";
      if (!Number.isSafeInteger(iteration) || iteration < 1 || iteration > definition.maxIterations
        || !["running", "completed", "failed", "limited"].includes(state)) fail("INTEGRITY_ERROR", "Original loop journal is invalid.");
      loops[definition.loopId] = { ...definition, iteration, state: state as OriginalLoopState["state"], history: [] };
    }
    if (history) for (const row of this.database.prepare(`SELECT record FROM workflow_executor_events
      WHERE actor_id=? AND run_id=? AND kind='original-recipe-loop-state' ORDER BY sequence`).all(actorId, runId)) {
      const record = JSON.parse(String(row.record)) as {
        loopId: string; completedIteration: number; snapshot: Step[];
      };
      const loop = loops[record.loopId];
      if (!loop || !Array.isArray(record.snapshot)) fail("INTEGRITY_ERROR", "Original loop snapshot is invalid.");
      const nodes = Object.fromEntries(record.snapshot.map(step => [step.nodeId,
        step.state === "pending" ? { state: "pending" } : {
          state: step.state, outcome: step.branch ?? step.state,
          result: step.state === "skipped" ? null : Object.hasOwn(step.outputs, "result") ? step.outputs.result : step.outputs,
          error: step.state === "skipped" ? "Dependency outcome did not select this path."
            : Object.hasOwn(step.outputs, "reportedError") ? String(step.outputs.reportedError) : "",
          ...(step.iteration ? { attempt: step.iteration } : {}),
        }]));
      loop!.history.push({ iteration: record.completedIteration, nodes });
    }
    return loops;
  }
  private applyOriginalLoopOutcome(actorId: string, run: Snapshot, nodeId: string, outcome: string) {
    const loops = this.originalRecipeLoopState(actorId, run.runId, false);
    for (const loop of Object.values(loops).filter(loop => loop.source === nodeId)) {
      const body = run.nodes.filter(step => loop.body.includes(step.nodeId));
      if (body.some(step => step.effect === "unknown" || ["offered", "claimed", "running"].includes(step.state)))
        fail("CONFLICT", "Original loop reset requires settled authoritative outcomes.");
      const completedIteration = loop.iteration;
      const snapshot = JSON.parse(JSON.stringify(body)) as Step[];
      let state: OriginalLoopState["state"], iteration = completedIteration;
      if (!loop.accept.includes(outcome)) state = outcome === "failed" ? "failed" : "completed";
      else if (completedIteration >= loop.maxIterations) {
        state = "limited";
        const source = run.nodes.find(step => step.nodeId === nodeId)!;
        source.state = "failed"; delete source.branch;
      } else {
        state = "running"; iteration++;
        for (const step of body) {
          step.state = "pending"; step.outputs = {}; step.effect = "not-started";
          delete step.branch; delete step.assignmentId;
        }
      }
      bounded(snapshot, L.snapshotBytes);
      this.event(actorId, run, "original-recipe-loop-state", {
        schema: "pkm.workflow.original-loop-state/v1", loopId: loop.loopId,
        completedIteration, iteration, state, outcome, snapshot,
      });
      if (state === "limited") break;
    }
  }
  autoDispatchAllowed(actorId: string, runId: string) {
    this.outside();
    const run = this.load(actorId, runId);
    return run.dispatchMode !== "explicit" || this.hostControl(actorId, runId, "native-runtime-control") !== undefined;
  }
  outputs(actorId: string, runId: string): Record<string, unknown> {
    this.outside();
    const run = this.load(actorId, runId);
    if (this.executionSemantics(actorId, runId)) fail("UNSUPPORTED_EXECUTION", "Original Recipe metadata mode exposes completed node results, not typed run-output execution.");
    if (run.state !== "succeeded") fail("NOT_READY", "Run outputs require authoritative successful completion.");
    return resolveRunOutputs(run.definition, this.bindings(actorId, runId), run.inputs, run.nodes);
  }
  async waitForDispatch(actorId: string, runId: string) {
    this.outside();
    const run = this.load(actorId, runId), trigger = this.bindings(actorId, runId).trigger;
    if (!active(run) || trigger?.mode !== "automation" || trigger.dueAt <= this.now()) return false;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.waits.delete(timer); resolve(); }, Math.min(1000, trigger.dueAt - this.now()));
      this.waits.set(timer, resolve);
    });
    return true;
  }
  private assignment(id: string): Assignment {
    const row = this.database.prepare("SELECT record FROM workflow_executor_assignments WHERE assignment_id=?").get(id);
    if (!row) return fail("CONFLICT", "Assignment missing.");
    return JSON.parse(String(row.record)) as Assignment;
  }
  private writeAssignment(value: Assignment) {
    this.database.prepare("UPDATE workflow_executor_assignments SET record=? WHERE assignment_id=?")
      .run(JSON.stringify(value), value.scheduler.assignmentId);
  }
  private fence(actorId: string, run: Snapshot, reason: string, expiredOnly: boolean) {
    const now = this.now();
    for (const step of run.nodes.filter(step => ["offered", "claimed", "running"].includes(step.state))) {
      const assignment = this.assignment(step.assignmentId!);
      const scheduler = assignment.scheduler;
      const expiry = scheduler.lease?.expiresAt ?? scheduler.offer?.expiresAt ?? 0;
      if (expiredOnly && now <= expiry) continue;
      if (scheduler.state === "leased" && expiredOnly) {
        assignment.scheduler = expireLease(scheduler, command(scheduler, "expire"), now).assignment;
      } else {
        assignment.scheduler = revokeAuthority(scheduler, command(scheduler, "revoke"), reason).assignment;
      }
      this.writeAssignment(assignment);
      const running = step.state === "running";
      const node = run.definition.spec.nodes.find(item => item.nodeId === step.nodeId);
      const resumableGate = running && node?.kind === "pkm.gate.human/v1"
        && ["lease-expired", "private-host-restarted", "host-closed"].includes(reason);
      step.state = resumableGate ? "pending" : running ? "unknown" : expiredOnly ? "pending" : "cancelled";
      step.effect = resumableGate ? "not-started" : running ? "unknown" : "not-started";
      this.event(actorId, run, resumableGate ? "human-gate-wait-resumed" : running ? "interrupted-unknown" : "fenced",
        { nodeId: step.nodeId, assignmentId: step.assignmentId, reason });
    }
  }
  private settle(actorId: string, run: Snapshot) {
    const originalMetadata = !!this.executionSemantics(actorId, run.runId);
    run.state = settle(run.definition, run.nodes, originalMetadata);
    if (originalMetadata && run.state !== "unknown") {
      if (Object.values(this.originalRecipeLoopState(actorId, run.runId, false)).some(loop => loop.state === "limited"))
        run.state = "failed";
      else if (run.definition.spec.completion.requiredNodes.some(id => run.nodes.find(step => step.nodeId === id)!.state === "skipped"))
        run.state = "failed";
      else if (run.definition.spec.completion.requiredNodes.every(id => run.nodes.find(step => step.nodeId === id)!.state === "succeeded"))
        run.state = "succeeded";
    }
    if (run.state === "succeeded" && !this.executionSemantics(actorId, run.runId) && Object.keys(run.definition.spec.outputs).length) {
      try { resolveRunOutputs(run.definition, this.bindings(actorId, run.runId), run.inputs, run.nodes); }
      catch { run.state = "failed"; this.event(actorId, run, "run-output-invalid", {}); }
    }
    if (run.state === "unknown") {
      this.fence(actorId, run, "unknown-run", false);
      for (const step of run.nodes) if (step.state === "pending") step.state = "cancelled";
      this.fenceSubflowDescendants(actorId, run.runId, "unknown-ancestor");
    }
  }
  cancel(actorId: string, args: WorkflowExecutorCancel) {
    const result = this.atomic(() => this.cancelInTransaction(actorId, args));
    this.abortSubflowControllers(actorId, args.runId);
    return result;
  }
  cancelInTransaction(actorId: string, args: WorkflowExecutorCancel) {
    if (this.closed || !this.database.isTransaction) fail("TRANSACTION_BOUNDARY", "Cancel requires the shared transaction.");
    const parsed = workflowExecutorCancel.parse(args);
    return this.receipt(actorId, parsed.operationId, hash({ operation: "cancel", args: parsed }), () => {
      const run = this.load(actorId, parsed.runId), previous = run.version;
      if (previous !== parsed.expectedVersion) fail("CONFLICT", "Executor run version changed.");
      if (active(run)) {
        this.fence(actorId, run, "cancel", false);
        this.fenceSubflowDescendants(actorId, run.runId, "cancel-ancestor");
        for (const step of run.nodes) if (step.state === "pending") step.state = "cancelled";
        run.state = "cancelled"; this.event(actorId, run, "cancelled", {}); this.save(actorId, run, previous);
      }
      return view(run);
    });
  }
  recover(actorId: string, runId: string) {
    return this.atomic(() => {
      const run = this.load(actorId, runId), previous = run.version;
      if (!active(run)) return view(run);
      this.fence(actorId, run, "lease-expired", true);
      this.settle(actorId, run);
      this.save(actorId, run, previous); return view(run);
    });
  }
  interruptHostOwnedRun(actorId: string, runId: string) {
    const result = this.atomic(() => {
      const run = this.load(actorId, runId), previous = run.version;
      if (!active(run)) return view(run);
      this.fence(actorId, run, "private-host-restarted", false);
      this.fenceSubflowDescendants(actorId, runId, "private-ancestor-host-restarted");
      const unknown = run.nodes.some(step => step.effect === "unknown");
      const resumableGate = run.definition.spec.nodes.some(node => node.kind === "pkm.gate.human/v1"
        && run.nodes.find(step => step.nodeId === node.nodeId)?.state === "pending");
      const resumableMetadata = !unknown && !!this.executionSemantics(actorId, runId);
      if (unknown || !(resumableGate || resumableMetadata)) for (const step of run.nodes) if (step.state === "pending") step.state = "cancelled";
      run.state = unknown ? "unknown" : resumableGate || resumableMetadata ? "ready" : "cancelled";
      this.event(actorId, run, resumableMetadata ? "host-interrupted-original-metadata-resumable"
        : resumableGate && !unknown ? "host-interrupted-human-gate-resumable" : "host-interrupted-without-replay", {});
      this.save(actorId, run, previous);
      return view(run);
    });
    this.abortSubflowControllers(actorId, runId);
    return result;
  }
  private offer(actorId: string, runId: string): string | undefined {
    return this.atomic(() => {
      const run = this.load(actorId, runId), previous = run.version, now = this.now();
      if (!active(run)) return;
      const originalMetadata = !!this.executionSemantics(actorId, runId);
      if (originalMetadata && run.nodes.some(step => ["offered", "claimed", "running"].includes(step.state))) return;
      const trigger = this.bindings(actorId, runId).trigger;
      if (trigger?.mode === "automation") {
        if (now < trigger.dueAt) return;
        let authorized = false;
        try { authorized = now < trigger.expiresAt && (run.steps > 0 || now - trigger.dueAt <= trigger.maxLatenessMs)
          && this.options.authorizeTrigger?.(freeze({ actorId, runId, executableDigest: run.executableDigest,
            source: run.source, trigger, phase: "dispatch" })) === true; } catch { /* Denied without dispatch. */ }
        if (!authorized) {
          this.fence(actorId, run, "cron-consent-revoked-or-slot-expired", false);
          for (const step of run.nodes) if (step.state === "pending") step.state = "cancelled";
          run.state = run.nodes.some(step => step.effect === "unknown") ? "unknown" : "cancelled";
          this.event(actorId, run, "cron-delivery-denied", {}); this.save(actorId, run, previous); return;
        }
      }
      this.fence(actorId, run, "lease-expired", true);
      this.settle(actorId, run);
      if (!active(run)) { this.save(actorId, run, previous); return; }
      try { this.assertSubflowTree(actorId, run); }
      catch (error) { this.denySubflowTree(actorId, run, previous, error); return; }
      if (now >= run.deadline) {
        this.fence(actorId, run, "deadline", false);
        for (const step of run.nodes) if (step.state === "pending") step.state = "cancelled";
        run.state = run.nodes.some(step => step.effect === "unknown") ? "unknown" : "failed";
        this.event(actorId, run, "deadline", {}); this.save(actorId, run, previous); return;
      }
      const node = run.definition.spec.nodes.find(node => {
        const step = run.nodes.find(step => step.nodeId === node.nodeId)!;
        return step.state === "pending" && dependencyState(node, run.nodes, originalMetadata) === "ready";
      });
      if (!node) { this.save(actorId, run, previous); return; }
      try { this.assertSubflowTree(actorId, run, true); }
      catch (error) { this.denySubflowTree(actorId, run, previous, error); return; }
      this.installed(run.adapters[node.nodeId]!);
      if (run.steps >= L.steps) fail("RESOURCE_LIMIT", "Step dispatch capacity reached.");
      if (run.eventSequence > L.events - 16 || Number(this.database.prepare(
        "SELECT count(*) AS n FROM workflow_executor_assignments WHERE actor_id=? AND run_id=?",
      ).get(actorId, runId)!.n) >= L.assignmentsPerRun) fail("RESOURCE_LIMIT", "Assignment capacity reached; no further offer dispatched.");
      const assignmentId = randomUUID(), step = run.nodes.find(step => step.nodeId === node.nodeId)!;
      const expiry = Math.min(now + this.leaseMs, run.deadline);
      const agent = createAgentSnapshot({ executorId: this.options.ownerId, agentId: this.options.ownerId,
        state: "available", capabilities: [run.adapters[node.nodeId]!.key], refreshedAt: now, refreshDeadline: expiry });
      let scheduler = createSchedulerAssignment(assignmentId, randomUUID(), { runVersion: previous, readyVersion: step.iteration + 1, policyVersion: 1 });
      scheduler = offerAssignment(scheduler, command(scheduler, "offer"), agent, {
        offerId: randomUUID(), now, expiresAt: expiry, maxOfferDuration: this.leaseMs, requiredCapabilities: [run.adapters[node.nodeId]!.key],
      }).assignment;
      const assignment: Assignment = { scheduler, agent, ownerId: this.options.ownerId };
      this.database.prepare("INSERT INTO workflow_executor_assignments VALUES(?,?,?,?,?,?)")
        .run(assignmentId, actorId, runId, node.nodeId, this.options.ownerId, JSON.stringify(assignment));
      step.assignmentId = assignmentId; step.state = "offered";
      this.event(actorId, run, "offered", { nodeId: node.nodeId, assignmentId });
      this.save(actorId, run, previous); return assignmentId;
    });
  }
  private claim(actorId: string, runId: string, assignmentId: string) {
    return this.atomic(() => {
      const run = this.load(actorId, runId), previous = run.version;
      const step = run.nodes.find(step => step.assignmentId === assignmentId), assignment = this.assignment(assignmentId);
      if (!active(run) || step?.state !== "offered" || assignment.ownerId !== this.options.ownerId) return false;
      const scheduler = assignment.scheduler, now = this.now();
      if (now >= run.deadline || now > scheduler.offer!.expiresAt) return false;
      this.assertSubflowTree(actorId, run);
      assignment.scheduler = claimAssignment(scheduler, command(scheduler, "claim"), assignment.agent, {
        offerId: scheduler.offer!.offerId, leaseId: randomUUID(), now, expiresAt: scheduler.offer!.expiresAt,
      }).assignment;
      step.state = "claimed"; this.writeAssignment(assignment);
      this.event(actorId, run, "claimed", { nodeId: step.nodeId, assignmentId });
      this.save(actorId, run, previous); return true;
    });
  }
  private start(actorId: string, runId: string, assignmentId: string): WorkflowInvocation | undefined {
    return this.atomic(() => {
      const run = this.load(actorId, runId), previous = run.version, assignment = this.assignment(assignmentId);
      const step = run.nodes.find(step => step.assignmentId === assignmentId);
      if (!active(run) || step?.state !== "claimed" || assignment.ownerId !== this.options.ownerId) return;
      const now = this.now(), scheduler = assignment.scheduler, lease = scheduler.lease!;
      if (now >= run.deadline || now > lease.expiresAt) return;
      const node = run.definition.spec.nodes.find(node => node.nodeId === step.nodeId)!;
      const adapter = this.installed(run.adapters[node.nodeId]!);
      if (adapter.authorizeDefinition(freeze(JSON.parse(JSON.stringify({
        actorId, executableDigest: run.executableDigest, source: run.source, node,
        ...this.policyControls(actorId, runId),
      })))) !== true) {
        assignment.scheduler = revokeAuthority(scheduler, command(scheduler, "revoke"), "authorization-revoked").assignment;
        this.writeAssignment(assignment); step.state = "failed";
        this.settle(actorId, run); this.event(actorId, run, "authorization-denied", { nodeId: step.nodeId });
        this.save(actorId, run, previous); return;
      }
      const inputs: Record<string, unknown> = { ...run.inputs };
      for (const edge of node.dependsOn.filter(edge => !run.legacyRunInputs && !edge.loop && edge.toInput)) {
        const from = run.nodes.find(step => step.nodeId === edge.from)!;
        if (!Object.hasOwn(from.outputs, edge.fromOutput!)) fail("INVALID_OUTPUT", "Pinned dependency output missing.");
        inputs[edge.toInput!] = from.outputs[edge.fromOutput!];
      }
      let executionNode = node, executionInputs = inputs;
      try {
        this.assertCurrentSource(actorId, run); this.assertDelivery(actorId, run, now); this.assertSubflowTree(actorId, run);
        const semantics = this.executionSemantics(actorId, runId);
        const metadataControl = node.control?.mode === "repeat" ? { mode: "single" as const }
          : node.control?.mode === "branch" ? { mode: "branch" as const, kind: node.control.kind, cases: node.control.cases } : node.control;
        const resolved = semantics ? { node: { ...node, control: metadataControl }, inputs }
          : resolveRuntimeNode(node, this.bindings(actorId, runId), inputs, run.nodes, step.iteration);
        executionNode = resolved.node; executionInputs = resolved.inputs;
      } catch {
        assignment.scheduler = revokeAuthority(scheduler, command(scheduler, "revoke"), "runtime-binding-or-source-invalid").assignment;
        this.writeAssignment(assignment); step.state = "failed";
        this.settle(actorId, run); this.event(actorId, run, "runtime-binding-or-source-invalid", { nodeId: step.nodeId });
        this.save(actorId, run, previous); return;
      }
      if (adapter.authorizeData && adapter.authorizeData(freeze(JSON.parse(JSON.stringify({
        actorId, executableDigest: run.executableDigest, source: run.source, definition: run.definition, node, inputs: executionInputs, previousOutputs: step.outputs,
        ...this.policyControls(actorId, runId),
      })))) !== true) {
        assignment.scheduler = revokeAuthority(scheduler, command(scheduler, "revoke"), "data-policy-denied").assignment;
        this.writeAssignment(assignment); step.state = "failed";
        this.settle(actorId, run); this.event(actorId, run, "data-policy-denied", { nodeId: step.nodeId });
        this.save(actorId, run, previous); return;
      }
      const proof: OutputSubmission = {
        ...scheduler.authority, assignmentId, attemptId: scheduler.attemptId, assignmentVersion: scheduler.version,
        leaseId: lease.leaseId, leaseVersion: lease.version, fencingToken: lease.fencingToken,
        executorId: this.options.ownerId, agentId: this.options.ownerId,
      };
      const invocation: WorkflowInvocation = {
        schema: "pkm.workflow.executor.invocation/v1", actorId, runId, node, iteration: step.iteration,
        ...(executionNode !== node ? { runtimeControl: executionNode.control } : {}),
        ...(this.executionSemantics(actorId, runId) ? { executionSemantics: ORIGINAL_RECIPE_METADATA_SEMANTICS } : {}),
        ...(this.executionSemantics(actorId, runId) ? { loopContext: Object.values(this.originalRecipeLoopState(actorId, runId, false))
          .filter(loop => loop.body.includes(node.nodeId)).map(({ loopId, iteration, maxIterations, condition }) => ({
            loopId, iteration, maxIterations, condition,
          })) } : {}),
        ...(run.legacyRunInputs ? { legacyRunInputs: true } : {}),
        invocationId: scheduler.attemptId, executableDigest: run.executableDigest,
        adapter: run.adapters[node.nodeId]!, inputs: executionInputs, previousOutputs: step.outputs,
        inputDigest: hash(executionInputs), deadline: Math.min(run.deadline, lease.expiresAt), lease: proof,
      };
      assignment.invocation = invocation; step.state = "running"; step.effect = "unknown";
      run.steps++; this.writeAssignment(assignment);
      this.event(actorId, run, "start-intent", { nodeId: node.nodeId, invocation });
      this.save(actorId, run, previous); return freeze(JSON.parse(JSON.stringify(invocation)) as WorkflowInvocation);
    });
  }
  async tick(actorId: string, runId: string) {
    this.outside();
    const assignmentId = this.offer(actorId, runId);
    if (!assignmentId || !this.claim(actorId, runId, assignmentId)) return this.get(actorId, runId);
    const invocation = this.start(actorId, runId, assignmentId);
    if (!invocation) return this.get(actorId, runId);
    const adapter = this.installed(invocation.adapter), controller = new AbortController();
    this.controllers.set(assignmentId, { actorId, runId, controller });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<undefined>(resolve => {
      controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      timer = setTimeout(() => { controller.abort(); resolve(undefined); }, Math.max(1, invocation.deadline - this.now()));
    });
    const cancellationWatch = setInterval(() => {
      if (this.closed || this.database.isTransaction || controller.signal.aborted) return;
      try {
        const run = this.load(actorId, runId);
        const step = run.nodes.find(item => item.assignmentId === assignmentId);
        if (!active(run) || step?.state !== "running") controller.abort();
      } catch { controller.abort(); }
    }, 20);
    let result: unknown;
    try {
      this.outside();
      result = await Promise.race([Promise.resolve().then(() => adapter.execute(invocation, { signal: controller.signal })), interrupted]);
      if (result !== undefined) {
        bounded(result, L.outputBytes);
        result = freeze(JSON.parse(JSON.stringify(workflowExecutorResult.parse(result))));
        const parsed = result as z.infer<typeof workflowExecutorResult>;
        if ((parsed.status === "succeeded" || Object.keys(parsed.outputs).length > 0) && !adapter.validateOutput(parsed.outputs)) result = undefined;
        else result = JSON.parse(JSON.stringify(result));
      }
    } catch { result = undefined; }
    finally { if (timer) clearTimeout(timer); clearInterval(cancellationWatch); this.controllers.delete(assignmentId); }
    if (this.closed) return undefined;
    return this.atomic(() => {
      const run = this.load(actorId, runId), previous = run.version, assignment = this.assignment(assignmentId);
      const step = run.nodes.find(step => step.assignmentId === assignmentId);
      if (!active(run) || step?.state !== "running" || assignment.ownerId !== this.options.ownerId) return view(run);
      const now = this.now();
      if (result !== undefined) {
        try {
          this.assertCurrentSource(actorId, run); this.assertDelivery(actorId, run, now); this.assertSubflowTree(actorId, run);
          if (adapter.authorizeDefinition(freeze(JSON.parse(JSON.stringify({
            actorId, executableDigest: run.executableDigest, source: run.source, node: invocation.node,
            ...this.policyControls(actorId, runId),
          })))) !== true) result = undefined;
        } catch { result = undefined; }
      }
      if (result !== undefined) {
        const candidate = workflowExecutorResult.parse(result);
        for (const node of run.definition.spec.nodes) {
          const policy = this.installed(run.adapters[node.nodeId]!).authorizeData;
          if (policy) {
            let allowed = false;
            try { allowed = policy(freeze(JSON.parse(JSON.stringify({
              actorId, executableDigest: run.executableDigest, source: run.source, definition: run.definition, node,
              inputs: run.inputs, previousOutputs: run.nodes.find(item => item.nodeId === node.nodeId)!.outputs,
              candidate: { nodeId: invocation.node.nodeId, outputs: candidate.outputs },
              ...this.policyControls(actorId, runId),
            })))) === true; } catch { /* Deny before persisting candidate output. */ }
            if (!allowed) { result = undefined; break; }
          }
        }
      }
      const authority = determineOutputAuthority(assignment.scheduler, invocation.lease, assignment.agent, now);
      let acceptedResult: "succeeded" | "failed" | undefined;
      if (invocation.node.kind === "pkm.gate.human/v1" && controller.signal.aborted
        && result === undefined && now >= invocation.deadline && now < run.deadline) {
        step.state = "pending"; step.effect = "not-started"; step.outputs = {};
        assignment.scheduler = revokeAuthority(assignment.scheduler, command(assignment.scheduler, "revoke"), "human-gate-wait-expired").assignment;
        this.event(actorId, run, "human-gate-wait-resumed", { nodeId: step.nodeId, assignmentId, reason: "lease-expired" });
      } else if (!authority.authoritative || now >= run.deadline || result === undefined) {
        step.state = "unknown"; step.effect = "unknown"; step.outputs = {};
        assignment.scheduler = revokeAuthority(assignment.scheduler, command(assignment.scheduler, "revoke"), "unknown-effect").assignment;
      } else {
        try {
          const parsed = workflowExecutorResult.parse(result), ports = invocation.node.ports?.outputs;
          if (ports && !(run.legacyRunInputs && invocation.node.kind === "pkm.step.noop/v1")
            && ((parsed.status === "succeeded" && ports.some(key => !Object.hasOwn(parsed.outputs, key))) || Object.keys(parsed.outputs).some(key => !ports.includes(key)))) {
            fail("INVALID_OUTPUT", "Adapter outputs do not match pinned node output ports.");
          }
          const resultNode = invocation.runtimeControl ? { ...invocation.node, control: invocation.runtimeControl } : invocation.node;
          if (invocation.node.kind === "pkm.subflow/v1" && parsed.status !== "unknown") {
            const link = this.getSubflowLinks(actorId, runId).find(item => item.parentInvocationId === invocation.invocationId);
            const child = link && this.load(actorId, link.childRunId);
            if (!child || parsed.status !== child.state)
              fail("INVALID_OUTPUT", "Subflow outcome requires the exact authoritative child terminal state.");
          }
          acceptStepResult(invocation.executionSemantics ? { ...resultNode, dependsOn: resultNode.dependsOn.filter(edge => !edge.loop) } : resultNode, step, parsed);
          if (invocation.executionSemantics && parsed.status !== "unknown")
            this.applyOriginalLoopOutcome(actorId, run, step.nodeId, parsed.branch ?? parsed.status);
          bounded(run, L.snapshotBytes - 4096);
          if (parsed.status !== "unknown") acceptedResult = parsed.status;
        }
        catch { step.state = "unknown"; step.effect = "unknown"; step.outputs = {}; delete step.branch; }
        assignment.scheduler = releaseLease(assignment.scheduler, command(assignment.scheduler, "release"), invocation.lease, now).assignment;
      }
      this.writeAssignment(assignment);
      this.settle(actorId, run);
      this.event(actorId, run, "completion", { nodeId: step.nodeId, state: step.state, assignmentId,
        invocationId: invocation.invocationId, authoritative: authority.authoritative,
        ...(acceptedResult ? { acceptedResult } : {}) });
      if (acceptedResult && invocation.executionSemantics) this.event(actorId, run, "invocation-completion-clock", {
        schema: "pkm.workflow.invocation-completion-clock/v1", invocationId: invocation.invocationId,
        assignmentId, completedAt: now,
      });
      this.save(actorId, run, previous); return view(run);
    });
  }
  close() {
    if (this.closed) return;
    this.outside();
    const runs = new Map<string, { actorId: string; runId: string }>();
    for (const item of this.controllers.values()) runs.set(JSON.stringify([item.actorId, item.runId]), item);
    for (const item of runs.values()) this.atomic(() => {
      const run = this.load(item.actorId, item.runId), previous = run.version;
      if (!active(run)) return;
      this.fence(item.actorId, run, "host-closed", false);
      this.settle(item.actorId, run);
      this.save(item.actorId, run, previous);
    });
    for (const item of this.controllers.values()) item.controller.abort();
    for (const [timer, resolve] of this.waits) { clearTimeout(timer); resolve(); }
    this.waits.clear();
    this.closed = true;
  }
}

/** Dispatcher hook: initialize before the enclosing shared transaction; never expose tick/result ingestion. */
export function mutateWorkflowExecutor(executor: WorkflowExecutor, request: {
  operation: "workflow.executor.create" | "workflow.executor.cancel"; actorId: string; args: unknown;
}) {
  const descriptor = workflowExecutorDefinitions.find(item => item.id === request.operation);
  if (!descriptor || descriptor.readOnly) return fail("NOT_FOUND", "Unknown workflow executor mutation.");
  bounded(request.args, 262_144);
  const args = descriptor.input.parse(request.args);
  return request.operation === "workflow.executor.create"
    ? executor.createInTransaction(request.actorId, workflowExecutorCreate.parse(args))
    : executor.cancelInTransaction(request.actorId, workflowExecutorCancel.parse(args));
}

export function readWorkflowExecutor(executor: WorkflowExecutor, request: {
  operation: "workflow.executor.get" | "workflow.executor.outputs"; actorId: string; args: unknown;
}) {
  if (request.operation === "workflow.executor.outputs") {
    const args = workflowExecutorDefinitions[3].input.parse(request.args);
    return executor.outputs(request.actorId, args.runId);
  }
  if (request.operation !== "workflow.executor.get") fail("NOT_FOUND", "Unknown workflow executor read.");
  const args = workflowExecutorDefinitions[1].input.parse(request.args);
  return executor.get(request.actorId, args.runId);
}
