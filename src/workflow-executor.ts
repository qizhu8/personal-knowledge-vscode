import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { readWorkflowCompiler } from "./workflow-compiler.js";
import { canonicalJson, type WorkflowDefinitionV1, type WorkflowNodeV1 } from "./domain/project-recipes-workflow-contracts.js";
import { normalizeTypedValue } from "./domain/project-recipes-value-contracts.js";
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
}
export interface WorkflowStepAdapter {
  id: string; version: number; outputContractDigest: string; authorizationDigest: string;
  authorizeDefinition(binding: Readonly<{
    actorId: string; executableDigest: string; source: unknown; node: WorkflowNodeV1;
  }>): boolean;
  authorizeData?(binding: Readonly<{
    actorId: string; executableDigest: string; source: unknown; node: WorkflowNodeV1;
    definition: WorkflowDefinitionV1;
    inputs: Record<string, unknown>; previousOutputs: Record<string, unknown>;
    candidate?: { nodeId: string; outputs: Record<string, unknown> };
  }>): boolean;
  execute(invocation: Readonly<WorkflowInvocation>, context: { signal: AbortSignal }): Promise<unknown>;
  validateOutput(outputs: Record<string, unknown>): boolean;
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
  constructor(private readonly database: DatabaseSync, private readonly options: {
    workspaceRoot: string; ownerId: string; adapters: Readonly<Record<string, WorkflowStepAdapter>>;
    clock?: () => number; leaseMs?: number; assertOwner?: () => void;
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
  create(actorId: string, args: WorkflowExecutorCreate) { return this.atomic(() => this.createInTransaction(actorId, args)); }
  createInTransaction(actorId: string, args: WorkflowExecutorCreate, host?: {
    dispatchMode: "explicit"; legacyUntypedInputs?: true; legacyRunInputs?: true;
  }) {
    if (this.closed || !this.database.isTransaction) fail("TRANSACTION_BOUNDARY", "Create requires the shared transaction.");
    bounded(args, 262_144);
    const parsed = workflowExecutorCreate.parse(args);
    return this.receipt(actorId, parsed.operationId, hash({ operation: "create", args: parsed, ...(host ? { host } : {}) }), () => {
      const now = this.now();
      if (parsed.deadline <= now || parsed.deadline > now + L.deadlineMs) fail("INVALID_ARGUMENT", "Deadline outside execution bound.");
      if (Number(this.database.prepare("SELECT count(*) AS n FROM workflow_executor_runs").get()!.n) >= L.runs) fail("RESOURCE_LIMIT", "Run capacity reached.");
      const compiled = (parsed.source.kind === "recipe" && this.options.resolveRecipe
        ? this.options.resolveRecipe(parsed.source)
        : readWorkflowCompiler(this.options.workspaceRoot, { operation: "workflow.definition.compile", args: { source: parsed.source } }, [])) as {
        status: string; executableDigest: string; definition: WorkflowDefinitionV1; source: unknown;
      };
      if (compiled.status !== "valid") fail("INVALID_DEFINITION", "Workflow compiler rejected the definition.");
      if (compiled.executableDigest !== parsed.expectedExecutableDigest) fail("CONFLICT", "Executable digest changed.");
      try { assertSupportedControls(compiled.definition); }
      catch { fail("UNSUPPORTED_EXECUTION", "Definition requires unqualified control/output features."); }
      const adapters: Record<string, AdapterPin> = Object.create(null);
      for (const node of compiled.definition.spec.nodes) {
        const key = adapterKey(node), adapter = this.adapters[key];
        if (!adapter) fail("ADAPTER_UNAVAILABLE", "Explicit native adapter configuration required for every node.");
        if (adapter.authorizeDefinition(freeze(JSON.parse(JSON.stringify({
          actorId, executableDigest: compiled.executableDigest, source: compiled.source, node,
        })))) !== true) fail("FORBIDDEN", "Native adapter denied this exact actor/definition/source binding.");
        adapters[node.nodeId] = { key, id: adapter.id, version: adapter.version,
          outputContractDigest: adapter.outputContractDigest, authorizationDigest: adapter.authorizationDigest };
      }
      const inputs: Record<string, unknown> = Object.create(null);
      if (host?.legacyUntypedInputs && Object.keys(compiled.definition.spec.inputs).length === 0)
        Object.assign(inputs, parsed.inputs);
      else if (Object.keys(parsed.inputs).some(key => !Object.hasOwn(compiled.definition.spec.inputs, key))) fail("INVALID_ARGUMENT", "Unknown workflow input.");
      for (const [key, descriptor] of Object.entries(compiled.definition.spec.inputs)) {
        const value = Object.hasOwn(parsed.inputs, key) ? parsed.inputs[key] : descriptor.default;
        if (value === undefined) { if (descriptor.required) fail("INVALID_ARGUMENT", "Required workflow input missing."); continue; }
        inputs[key] = normalizeTypedValue(descriptor, value);
      }
      for (const node of compiled.definition.spec.nodes) {
        const adapter = this.adapters[adapters[node.nodeId]!.key]!;
        if (adapter.authorizeData && adapter.authorizeData(freeze(JSON.parse(JSON.stringify({
          actorId, executableDigest: compiled.executableDigest, source: compiled.source, definition: compiled.definition, node, inputs, previousOutputs: {},
        })))) !== true) fail("FORBIDDEN", "Native adapter denied persistent workflow data.");
      }
      const run: Snapshot = {
        ...(host ? { dispatchMode: host.dispatchMode } : {}),
        ...(host?.legacyRunInputs ? { legacyRunInputs: true } : {}),
        runId: parsed.runId, version: 1, state: "ready", definition: compiled.definition,
        executableDigest: compiled.executableDigest, source: compiled.source, inputs,
        deadline: parsed.deadline, steps: 0, eventSequence: 0, adapters,
        nodes: compiled.definition.spec.nodes.map(node => ({ nodeId: node.nodeId, state: "pending", iteration: 0, effect: "not-started", outputs: {} })),
      };
      this.event(actorId, run, "created", { executableDigest: run.executableDigest, adapters });
      bounded(run, L.snapshotBytes);
      this.database.prepare("INSERT INTO workflow_executor_runs VALUES(?,?,?,?)").run(actorId, run.runId, run.version, JSON.stringify(run));
      return view(run);
    });
  }
  get(actorId: string, runId: string) { this.outside(); return view(this.load(actorId, runId)); }
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
    run.state = settle(run.definition, run.nodes);
    if (run.state === "unknown") {
      this.fence(actorId, run, "unknown-run", false);
      for (const step of run.nodes) if (step.state === "pending") step.state = "cancelled";
    }
  }
  cancel(actorId: string, args: WorkflowExecutorCancel) {
    const result = this.atomic(() => this.cancelInTransaction(actorId, args));
    for (const item of this.controllers.values()) if (item.actorId === actorId && item.runId === args.runId) item.controller.abort();
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
    return this.atomic(() => {
      const run = this.load(actorId, runId), previous = run.version;
      if (!active(run)) return view(run);
      this.fence(actorId, run, "private-host-restarted", false);
      const unknown = run.nodes.some(step => step.effect === "unknown");
      const resumableGate = run.definition.spec.nodes.some(node => node.kind === "pkm.gate.human/v1"
        && run.nodes.find(step => step.nodeId === node.nodeId)?.state === "pending");
      if (unknown || !resumableGate) for (const step of run.nodes) if (step.state === "pending") step.state = "cancelled";
      run.state = unknown ? "unknown" : resumableGate ? "ready" : "cancelled";
      this.event(actorId, run, resumableGate && !unknown ? "host-interrupted-human-gate-resumable" : "host-interrupted-without-replay", {});
      this.save(actorId, run, previous);
      return view(run);
    });
  }
  private offer(actorId: string, runId: string): string | undefined {
    return this.atomic(() => {
      const run = this.load(actorId, runId), previous = run.version, now = this.now();
      if (!active(run)) return;
      this.fence(actorId, run, "lease-expired", true);
      this.settle(actorId, run);
      if (!active(run)) { this.save(actorId, run, previous); return; }
      if (now >= run.deadline) {
        this.fence(actorId, run, "deadline", false);
        for (const step of run.nodes) if (step.state === "pending") step.state = "cancelled";
        run.state = run.nodes.some(step => step.effect === "unknown") ? "unknown" : "failed";
        this.event(actorId, run, "deadline", {}); this.save(actorId, run, previous); return;
      }
      const node = run.definition.spec.nodes.find(node => {
        const step = run.nodes.find(step => step.nodeId === node.nodeId)!;
        return step.state === "pending" && dependencyState(node, run.nodes) === "ready";
      });
      if (!node) { this.save(actorId, run, previous); return; }
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
      if (adapter.authorizeData && adapter.authorizeData(freeze(JSON.parse(JSON.stringify({
        actorId, executableDigest: run.executableDigest, source: run.source, definition: run.definition, node, inputs, previousOutputs: step.outputs,
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
        ...(run.legacyRunInputs ? { legacyRunInputs: true } : {}),
        invocationId: scheduler.attemptId, executableDigest: run.executableDigest,
        adapter: run.adapters[node.nodeId]!, inputs, previousOutputs: step.outputs,
        inputDigest: hash(inputs), deadline: Math.min(run.deadline, lease.expiresAt), lease: proof,
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
        const candidate = workflowExecutorResult.parse(result);
        for (const node of run.definition.spec.nodes) {
          const policy = this.installed(run.adapters[node.nodeId]!).authorizeData;
          if (policy) {
            let allowed = false;
            try { allowed = policy(freeze(JSON.parse(JSON.stringify({
              actorId, executableDigest: run.executableDigest, source: run.source, definition: run.definition, node,
              inputs: run.inputs, previousOutputs: run.nodes.find(item => item.nodeId === node.nodeId)!.outputs,
              candidate: { nodeId: invocation.node.nodeId, outputs: candidate.outputs },
            })))) === true; } catch { /* Deny before persisting candidate output. */ }
            if (!allowed) { result = undefined; break; }
          }
        }
      }
      const authority = determineOutputAuthority(assignment.scheduler, invocation.lease, assignment.agent, now);
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
          acceptStepResult(invocation.node, step, parsed);
          bounded(run, L.snapshotBytes - 4096);
        }
        catch { step.state = "unknown"; step.effect = "unknown"; step.outputs = {}; delete step.branch; }
        assignment.scheduler = releaseLease(assignment.scheduler, command(assignment.scheduler, "release"), invocation.lease, now).assignment;
      }
      this.writeAssignment(assignment);
      this.settle(actorId, run);
      this.event(actorId, run, "completion", { nodeId: step.nodeId, state: step.state, assignmentId, authoritative: authority.authoritative });
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
  operation: "workflow.executor.get"; actorId: string; args: unknown;
}) {
  if (request.operation !== "workflow.executor.get") fail("NOT_FOUND", "Unknown workflow executor read.");
  const args = workflowExecutorDefinitions[1].input.parse(request.args);
  return executor.get(request.actorId, args.runId);
}
