import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { readActionCompiler } from "./action-compiler.js";
import {
  ACTION_RUNTIME_LIMITS as L, actionRuntimeDefinitions, type ActionRuntimeCreate, type ActionRuntimeCancel,
  type ActionRuntimeRequest, type ActionNodeReason,
} from "./action-runtime-contracts.js";
import { initializeActionRuntime } from "./domain/action-runtime-store.js";
import { containsActionArtifactReference } from "./action-runtime-process.js";
import { supportedPureMathExpression } from "./action-pure-components.js";
import { actionCheckpoint, checkpointResponse, checkActionCheckpointAnswer, newActionCheckpoint,
  type ActionCheckpoint } from "./action-runtime-checkpoints.js";
import { recordActionImplementation, selectedActionImplementation } from "./action-runtime-selection.js";
import {
  actionComponents, builtinActionDefinitions, exactRunnableArtifactBuiltin, exactRunnablePureBuiltin, loadModuleSet, originalDigest, schemaValueErrors,
  type ActionModuleSnapshot,
} from "./domain/action-compiler-validation.js";

export { actionRuntimeDefinitions, ACTION_RUNTIME_LIMITS } from "./action-runtime-contracts.js";
export { ACTION_RUNTIME_DDL } from "./domain/action-runtime-store.js";

type JsonRecordValue = Record<string, unknown>;
type Implementation = JsonRecordValue & { kind: string; platforms: string[] };
export type ActionInvocation = Readonly<{
  runId: string;
  actorId: string; workspaceId?: string; executableDigest: string; source: unknown; actionId: string;
  definition: JsonRecordValue; implementation: Implementation; nodeId: string;
  inputs: JsonRecordValue; deadline: number;
}>;
export type ActionAuthorizationBinding = Readonly<{
  runId?: string;
  actorId: string; workspaceId?: string; executableDigest: string; source: unknown; actionId: string;
  definition: JsonRecordValue; implementation: Implementation; nodeId: string;
  step?: JsonRecordValue;
}>;
export interface ActionNativeAdapter {
  id: string;
  version: number;
  outputContractDigest: string;
  authorizationDigest: string;
  authorizeDefinition(binding: ActionAuthorizationBinding): boolean;
  authorizeData(binding: ActionAuthorizationBinding & { inputs: JsonRecordValue }): boolean;
  execute(invocation: ActionInvocation, context: { signal: AbortSignal }): Promise<unknown>;
}
type AdapterPin = {
  key: string; id: string; version: number; outputContractDigest: string; authorizationDigest: string;
};
type NodeRecord = {
  nodeId: string; state: "pending" | "running" | "waiting" | "succeeded" | "failed" | "skipped" | "cancelled" | "unknown";
  reason?: ActionNodeReason;
  outputs?: JsonRecordValue; dependencies: string[];
};
type Snapshot = {
  runId: string; version: number; state: "ready" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "cancelling" | "unknown";
  actionId: string; actionVersion: number; definitionDigest: string; definition: JsonRecordValue;
  source: unknown; sourceSnapshot: unknown; implementation: Implementation;
  deadline: number; inputs: JsonRecordValue; nodes: NodeRecord[];
  adapters: Record<string, AdapterPin>; eventSequence: number; cancelRequested: boolean;
  checkpoints?: ActionCheckpoint[];
  selectedActionId?: string;
  originalAdmissionSha256?: string;
  reconciledOutput?: JsonRecordValue;
  reconciliations?: Array<{ kind: "manual"; expectedVersion: number; sourceReceiptSha256: string;
    outcome: string; evidence: JsonRecordValue; at: number }>;
};
export type ActionRuntimeHostRequest = ActionRuntimeRequest & { actorId: string };
export type ActionObservedReconciliation = {
  runId: string; expectedVersion: number; sourceReceiptSha256: string;
  outcome: "succeeded"; evidence: JsonRecordValue;
};
export interface RecoveredActionRun {
  operationId: string; runId: string; source: ActionRuntimeCreate["source"]; actionId?: string;
  previousVersion: number;
  expectedDefinitionDigest: string; implementationId: string; inputs: Record<string, z.infer<ReturnType<typeof z.json>>>;
  state: "unknown" | "waiting" | "succeeded" | "failed" | "cancelled";
  sourceReceiptSha256: string;
  completed: Record<string, Record<string, z.infer<ReturnType<typeof z.json>>>>;
  checkpoint?: ActionCheckpoint;
  history: ActionCheckpoint[];
  expectedOutput?: Record<string, z.infer<ReturnType<typeof z.json>>>;
}
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const terminal = new Set(["succeeded", "failed", "cancelled", "unknown"]);
const fail = (code: string, message: string): never => { throw new CoreError(code, message); };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keyFor = (actorId: string, runId: string) => `${actorId}\u0000${runId}`;
const invocationFingerprint = (run: Snapshot) => originalDigest({
  action_id: run.actionId, hash: run.definitionDigest, inputs: run.inputs, run_id: run.runId,
});

function actor(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) fail("INVALID_ARGUMENT", "Authenticated actor required.");
}
function isRecord(value: unknown): value is JsonRecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function targetCompatible(implementation: Implementation) {
  const platform = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Darwin" : "Linux";
  const architecture = process.arch === "x64" ? "x86_64" : process.arch;
  return implementation.platforms.includes(platform)
    && (!Array.isArray(implementation.architectures) || !implementation.architectures.length || implementation.architectures.includes(architecture));
}
export function exactPipelineArtifactInput(inputs: unknown): string | undefined {
  if (!isRecord(inputs) || Object.keys(inputs).length !== 1 || !isRecord(inputs.source)
    || Object.keys(inputs.source).length !== 1 || typeof inputs.source.artifact_id !== "string"
    || !/^artifact_[a-f0-9]{32}$/.test(inputs.source.artifact_id)) return undefined;
  return inputs.source.artifact_id;
}
export function isPipelineArtifactForward(inputs: unknown, output: unknown): boolean {
  const source = exactPipelineArtifactInput(inputs);
  return !!source && isRecord(output) && Object.keys(output).length === 1 && output.artifact_id === source;
}
export function hasArtifactField(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) pending.push(...item);
    else if (isRecord(item)) {
      if (Object.hasOwn(item, "artifact_id")) return true;
      pending.push(...Object.values(item));
    }
  }
  return false;
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function bounded(value: unknown, maximum: number): void {
  const pending = [{ value, depth: 0 }], seen = new Set<object>();
  let count = 0, bytes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > L.jsonValues || item.depth > L.jsonDepth) fail("RESOURCE_LIMIT", "Action JSON depth/value budget exceeded.");
    if (item.value === null || typeof item.value === "boolean" || typeof item.value === "number") {
      if (typeof item.value === "number" && !Number.isFinite(item.value)) fail("INVALID_ARGUMENT", "Finite JSON values required.");
      continue;
    }
    if (typeof item.value === "string") { bytes += Buffer.byteLength(item.value); }
    else if (typeof item.value === "object") {
      if (seen.has(item.value)) fail("INVALID_ARGUMENT", "Action JSON must not contain cycles or aliases.");
      seen.add(item.value);
      if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item.value))) fail("INVALID_ARGUMENT", "Plain JSON required.");
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item.value))) {
        if (Array.isArray(item.value) && key === "length") continue;
        if (!descriptor.enumerable || !("value" in descriptor)) fail("INVALID_ARGUMENT", "Plain JSON required.");
        bytes += Buffer.byteLength(key); pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    } else fail("INVALID_ARGUMENT", "Plain JSON required.");
    if (bytes > maximum) fail("RESOURCE_LIMIT", "Action JSON byte budget exceeded.");
  }
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return fail("INVALID_ARGUMENT", "JSON value required."); }
  if (Buffer.byteLength(serialized) > maximum) fail("RESOURCE_LIMIT", "Action JSON byte budget exceeded.");
}
function validateSchema(schema: unknown, value: unknown, message: string): void {
  const errors = schemaValueErrors(schema, value);
  if (errors.length) fail("INVALID_ARGUMENT", `${message}: ${errors[0]!.path} ${errors[0]!.message}`);
}
function pipelineSteps(implementation: Implementation): JsonRecordValue[] {
  if (implementation.kind !== "pipeline") return [];
  const rawSteps = implementation.steps;
  if (!Array.isArray(rawSteps)) return fail("INVALID_DEFINITION", "Action pipeline steps must be an array.");
  if (rawSteps.length > L.steps) return fail("RESOURCE_LIMIT", "Action step budget exceeded.");
  const steps: unknown[] = rawSteps;
  if (steps.some(item => !isRecord(item) || typeof item.id !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(item.id)
    || !isRecord(item.inputs ?? {})) || new Set(steps.map(item => (item as JsonRecordValue).id)).size !== steps.length) {
    fail("INVALID_DEFINITION", "Invalid Action pipeline steps.");
  }
  return steps as JsonRecordValue[];
}
function stepDependencies(value: unknown, known: Set<string>, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) { for (const item of value) stepDependencies(item, known, result); return result; }
  if (!isRecord(value)) return result;
  if (Object.keys(value).length === 1 && Object.hasOwn(value, "$literal")) return result;
  if (Object.keys(value).length === 1 && typeof value.$step === "string") {
    const [nodeId] = value.$step.split(".");
    if (!nodeId || !known.has(nodeId)) fail("INVALID_DEFINITION", "Action output dependency references an unknown step.");
    result.add(nodeId); return result;
  }
  for (const item of Object.values(value)) stepDependencies(item, known, result);
  return result;
}
export function validatePurePipeline(definition: JsonRecordValue, implementation: JsonRecordValue): void {
    if (implementation.kind !== "pipeline" || !Array.isArray(definition.effects)
      || definition.effects.length !== 1 || definition.effects[0] !== "pure"
      || (isRecord(definition.dependencies) && Object.keys(definition.dependencies).length)
      || Object.keys(implementation).some(key => !["id", "kind", "platforms", "architectures", "steps", "output"].includes(key)))
      fail("NOT_AVAILABLE", "Only pure, dependency-free component pipelines are supported.");
    const steps = pipelineSteps(implementation as Implementation);
    if (!steps.length || !isRecord(implementation.output)) fail("INVALID_DEFINITION", "A pure pipeline requires steps and an output object.");
    for (const step of steps) {
      if (!["core.constant", "core.math-expression", "core.cast", "core.lookup"].includes(String(step.component))
        || step.implementation !== "javascript" || !isRecord(step.inputs)
        || Object.keys(step).some(key => !["id", "component", "implementation", "inputs", "output_schema"].includes(key)))
        fail("NOT_AVAILABLE", "Only explicit JavaScript core.constant, core.math-expression, core.cast and core.lookup steps are supported.");
      if (step.component === "core.math-expression" && isRecord(step.inputs)
        && typeof step.inputs.expression === "string" && !supportedPureMathExpression(step.inputs.expression))
        fail("NOT_AVAILABLE", "Round expressions require a single numeric operand and optional literal integer precision.");
    }
    const inspect = (value: unknown): void => {
      if (containsActionArtifactReference(value)) fail("NOT_AVAILABLE", "Managed Action artifacts are unavailable in pure pipelines.");
      const stack = [value];
      while (stack.length) {
        const item = stack.pop();
        if (Array.isArray(item)) { for (const child of item) stack.push(child); continue; }
        if (!isRecord(item)) continue;
        const keys = Object.keys(item);
        if (keys.length === 1 && Object.hasOwn(item, "$literal")) continue;
        if (keys.some(key => ["$op", "$var"].includes(key))
          || (keys.some(key => ["$step", "$input"].includes(key))
            && (keys.length !== 1 || typeof (item.$step ?? item.$input) !== "string")))
          fail("NOT_AVAILABLE", "This pipeline expression is not supported.");
        for (const child of Object.values(item)) stack.push(child);
      }
    };
    for (const step of steps) inspect(step.inputs);
    inspect(implementation.output);
    const nodes = assertAcyclic(steps);
    stepDependencies(implementation.output, new Set(nodes.map(node => node.nodeId)));
}
function assertAcyclic(steps: JsonRecordValue[]): NodeRecord[] {
  const ids = new Set(steps.map(step => String(step.id)));
  const records = steps.map(step => ({
    nodeId: String(step.id), state: "pending" as const, dependencies: [...stepDependencies(step.inputs ?? {}, ids)],
  }));
  const remaining = new Set(records.map(record => record.nodeId));
  while (remaining.size) {
    const eligible = records.filter(record => remaining.has(record.nodeId) && record.dependencies.every(dep => !remaining.has(dep)));
    if (!eligible.length) fail("INVALID_DEFINITION", "Action pipeline contains a dependency cycle.");
    for (const item of eligible) remaining.delete(item.nodeId);
  }
  return records;
}
function publicView(run: Snapshot) {
  return {
    schema: "pkm.action.runtime.run/v1" as const, runId: run.runId, version: run.version,
    state: run.state, actionId: run.actionId, actionVersion: run.actionVersion,
    definitionDigest: run.definitionDigest, source: run.source, deadline: run.deadline,
    nodes: run.nodes.map(node => ({ nodeId: node.nodeId, state: node.state, ...(node.reason ? { reason: node.reason } : {}) })),
    execution: "native-action-plan" as const,
  };
}
function load(database: DatabaseSync, actorId: string, runId: string): Snapshot {
  const row = database.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?").get(actorId, runId);
  if (!row) return fail("NOT_FOUND", "Owned Action run not found.");
  return JSON.parse(String(row.snapshot)) as Snapshot;
}
function schemaFor(step: JsonRecordValue, definition: JsonRecordValue): unknown {
  return isRecord(step.output_schema) ? step.output_schema : definition.output_schema;
}
function resolveInputs(value: unknown, run: Snapshot): unknown {
  if (Array.isArray(value)) return value.map(item => resolveInputs(item, run));
  if (!isRecord(value)) return value;
  if (Object.keys(value).length === 1 && Object.hasOwn(value, "$literal")) return clone(value.$literal);
  if (Object.keys(value).length === 1 && typeof value.$step === "string") {
    const index = value.$step.indexOf(".");
    const nodeId = index < 0 ? value.$step : value.$step.slice(0, index);
    const port = index < 0 ? undefined : value.$step.slice(index + 1);
    const node = run.nodes.find(item => item.nodeId === nodeId);
    if (!node) return fail("INVALID_DEFINITION", "Action step output is not available.");
    const outputs = node.outputs;
    if (node.state !== "succeeded") return fail("INVALID_DEFINITION", "Action step output is not available.");
    if (!outputs) return fail("INVALID_DEFINITION", "Action step output is not available.");
    if (port === undefined) return clone(outputs);
    if (!port || !Object.hasOwn(outputs, port)) return fail("INVALID_DEFINITION", "Action step output is not available.");
    return clone(outputs[port]);
  }
  if (Object.keys(value).length === 1 && typeof value.$input === "string") {
    if (!Object.hasOwn(run.inputs, value.$input)) fail("INVALID_DEFINITION", "Action input reference is unavailable.");
    return clone(run.inputs[value.$input]);
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveInputs(child, run)]));
}
function availableDefinitions(source: unknown): Map<string, JsonRecordValue> {
  const result = builtinActionDefinitions();
  for (const [componentId, definition] of Object.entries(actionComponents())) result.set(componentId, definition);
  if (isRecord(source) && source.kind === "inline") {
    const definition = source.definition;
    if (isRecord(definition) && typeof definition.action_id === "string") result.set(definition.action_id, definition);
  } else if (isRecord(source) && source.kind === "moduleSet") {
    const loaded = loadModuleSet(source as unknown as ActionModuleSnapshot);
    for (const [actionId, definition] of loaded.definitions) result.set(actionId, definition);
  }
  return result;
}

/**
 * Host-only Action execution. All mutations may be called inside the host's shared SQLite
 * transaction; no native adapter is ever invoked while a transaction is open.
 */
export class ActionRuntime {
  private readonly adapters: Readonly<Record<string, Readonly<ActionNativeAdapter>>>;
  private readonly active = new Map<string, AbortController>();
  private readonly running = new Set<Promise<unknown>>();
  private closed = false;
  private closing = false;
  private readonly clock: () => number;

  constructor(private readonly database: DatabaseSync, private readonly options: {
    workspaceRoot: string; adapters: Readonly<Record<string, ActionNativeAdapter>>;
    resolveAdapter?: (key: string, outputContractDigest: string) => ActionNativeAdapter | undefined;
    authorizePipelineArtifact?: (actorId: string, inputs: unknown, output: unknown) => boolean;
    authorizeObservedReconciliation?: (actorId: string, input: ActionObservedReconciliation) => boolean;
    clock?: () => number; assertOwner?: () => void; workspaceId?: string;
    initialized?: boolean; deferRecovery?: boolean; onLifecycle?: () => void; beforeEffect?: () => void;
  }) {
    this.clock = options.clock ?? Date.now;
    this.adapters = Object.freeze(Object.fromEntries(Object.entries(options.adapters).map(([key, adapter]) => {
      id.parse(adapter.id); z.number().safe().int().positive().parse(adapter.version);
      digest.parse(adapter.outputContractDigest); digest.parse(adapter.authorizationDigest);
      if (typeof adapter.execute !== "function" || typeof adapter.authorizeDefinition !== "function"
        || typeof adapter.authorizeData !== "function") fail("INVALID_CONFIGURATION", "Action adapters require execution and exact authorization policies.");
      return [key, Object.freeze({ ...adapter, execute: adapter.execute.bind(adapter),
        authorizeDefinition: adapter.authorizeDefinition.bind(adapter), authorizeData: adapter.authorizeData.bind(adapter) })];
    })));
    this.options.assertOwner?.();
    if (!options.initialized) initializeActionRuntime(database);
    if (!options.deferRecovery) this.recoverInterrupted();
  }

  private outside() {
    if (this.closed) fail("CLOSED", "Action runtime is closed.");
    if (this.database.isTransaction) fail("TRANSACTION_BOUNDARY", "Action dispatch cannot run inside a SQLite transaction.");
    this.options.assertOwner?.();
  }
  private atomic<T>(work: () => T): T {
    this.outside(); this.database.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.options.assertOwner?.(); this.database.exec("COMMIT"); return result; }
    catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }
  private mutate<T>(work: () => T): T {
    if (this.closed || this.closing) fail("CLOSED", "Action runtime is closing.");
    this.options.assertOwner?.();
    if (!this.database.isTransaction) fail("TRANSACTION_BOUNDARY", "Action runtime mutations require the shared SQLite transaction.");
    return work();
  }
  private receipt<T>(actorId: string, operationId: string, fingerprint: string, work: () => T): T {
    actor(actorId);
    const prior = this.database.prepare("SELECT fingerprint,result FROM action_runtime_receipts WHERE actor_id=? AND operation_id=?")
      .get(actorId, operationId) as { fingerprint: string; result: string } | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail("CONFLICT", "Action runtime operationId reused with a different request.");
      return JSON.parse(prior.result) as T;
    }
    this.database.exec("SAVEPOINT action_runtime_mutation");
    try {
      if (Number(this.database.prepare("SELECT count(*) n FROM action_runtime_receipts").get()!.n) >= L.receipts) {
        fail("RESOURCE_LIMIT", "Action runtime receipt capacity reached.");
      }
      const result = work();
      this.database.prepare("INSERT INTO action_runtime_receipts VALUES(?,?,?,?)").run(actorId, operationId, fingerprint, JSON.stringify(result));
      this.database.exec("RELEASE action_runtime_mutation");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK TO action_runtime_mutation; RELEASE action_runtime_mutation");
      throw error;
    }
  }
  private event(actorId: string, run: Snapshot, kind: string, nodeId?: string) {
    if (++run.eventSequence > L.events) fail("RESOURCE_LIMIT", "Action event capacity reached.");
    const value = { sequence: run.eventSequence, kind, version: run.version, at: this.clock(), state: run.state,
      ...(nodeId ? { nodeId } : {}) };
    this.database.prepare("INSERT INTO action_runtime_events VALUES(?,?,?,?)")
      .run(actorId, run.runId, run.eventSequence, JSON.stringify(value));
    if (this.options.onLifecycle) queueMicrotask(() => {
      if (!this.closed && !this.database.isTransaction && this.database.prepare(
        "SELECT 1 FROM action_runtime_events WHERE actor_id=? AND run_id=? AND sequence=?",
      ).get(actorId, run.runId, value.sequence)) this.options.onLifecycle?.();
    });
  }
  private save(actorId: string, run: Snapshot, previous: number) {
    run.version = previous + 1;
    bounded(JSON.parse(JSON.stringify(run)), L.snapshotBytes);
    const result = this.database.prepare("UPDATE action_runtime_runs SET version=?,snapshot=? WHERE actor_id=? AND run_id=? AND version=?")
      .run(run.version, JSON.stringify(run), actorId, run.runId, previous);
    if (result.changes !== 1) fail("CONFLICT", "Action run compare-and-swap failed.");
  }
  private pin(key: string, schema: unknown, binding: ActionAuthorizationBinding): AdapterPin {
    const contractDigest = originalDigest(schema);
    const adapter = this.adapters[key] ?? this.options.resolveAdapter?.(key, contractDigest);
    if (!adapter) return fail("ADAPTER_UNAVAILABLE", `No native Action adapter is allowlisted for ${key}.`);
    if (adapter.outputContractDigest !== contractDigest
      || adapter.authorizeDefinition(freeze(clone(binding))) !== true) {
      return fail("FORBIDDEN", "Action adapter denied the exact actor, definition, implementation, or output contract.");
    }
    return { key, id: adapter.id, version: adapter.version, outputContractDigest: adapter.outputContractDigest,
      authorizationDigest: adapter.authorizationDigest };
  }
  private installed(pin: AdapterPin) {
    const adapter = this.adapters[pin.key] ?? this.options.resolveAdapter?.(pin.key, pin.outputContractDigest);
    if (!adapter || adapter.id !== pin.id || adapter.version !== pin.version
      || adapter.outputContractDigest !== pin.outputContractDigest || adapter.authorizationDigest !== pin.authorizationDigest) {
      return fail("ADAPTER_UNAVAILABLE", "Exact pinned Action adapter authorization/output contract is not installed.");
    }
    return adapter;
  }
  recoverInterrupted(actorId?: string) {
    this.outside();
    if (actorId !== undefined) actor(actorId);
    if (this.database.isTransaction) fail("TRANSACTION_BOUNDARY", "Action recovery requires an idle shared database.");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.database.prepare("SELECT actor_id,run_id,version,snapshot FROM action_runtime_runs WHERE json_extract(snapshot,'$.state') IN ('running','cancelling')")
        .all() as Array<{ actor_id: string; run_id: string; version: number; snapshot: string }>;
      const reconciled: string[] = [];
      for (const row of rows) {
        if (actorId !== undefined && actorId !== row.actor_id || this.active.has(keyFor(row.actor_id, row.run_id))) continue;
        const run = JSON.parse(row.snapshot) as Snapshot, previous = run.version;
        for (const node of run.nodes) {
          if (node.state === "running") node.state = "unknown";
          else if (node.state === "pending") node.state = "cancelled";
        }
        run.state = "unknown"; this.event(row.actor_id, run, "run-unknown");
        this.save(row.actor_id, run, previous);
        reconciled.push(run.runId);
      }
      this.database.exec("COMMIT");
      return reconciled;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  create(actorId: string, args: ActionRuntimeCreate) { return this.atomic(() => this.createInTransaction(actorId, args)); }
  createInTransaction(actorId: string, args: ActionRuntimeCreate) {
    return this.mutate(() => {
      actor(actorId); bounded(args, L.inputBytes);
      const parsed = actionRuntimeDefinitions[0].input.parse(args) as ActionRuntimeCreate;
      // Check the selected source identity before replaying a receipt from another process version.
      const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source: parsed.source } }) as {
        status: string; definitionDigest: string; definition: JsonRecordValue; source: unknown;
      };
      if (compiled.status !== "valid") fail("INVALID_DEFINITION", "Original Action compiler rejected this definition.");
      if (compiled.definitionDigest !== parsed.expectedDefinitionDigest) fail("CONFLICT", "Action definition digest changed before pinning.");
      return this.receipt(actorId, parsed.operationId, hash({ operation: "action.runtime.create", args: parsed }), () => {
        const now = this.clock();
        if (!Number.isSafeInteger(now) || parsed.deadline <= now || parsed.deadline > now + L.deadlineMs) {
          fail("INVALID_ARGUMENT", "Action run deadline is outside the configured bound.");
        }
        if (Number(this.database.prepare("SELECT count(*) n FROM action_runtime_runs").get()!.n) >= L.runs) fail("RESOURCE_LIMIT", "Action run capacity reached.");
        if (!isRecord(compiled.definition)) return fail("INVALID_DEFINITION", "Compiled Action definition is not an object.");
        const definition = compiled.definition;
        validateSchema(definition.input_schema, parsed.inputs, "Action input violates its pinned schema");
        const inputs = clone(parsed.inputs) as JsonRecordValue;
        const implementations = Array.isArray(definition.implementations) ? definition.implementations as Implementation[] : [];
        const selected = selectedActionImplementation(this.database, actorId, String(definition.action_id), compiled.definitionDigest);
        const compatible = implementations.filter(targetCompatible);
        const implementation = selected ? compatible.find(item => item.id === selected)
          : compatible.length === 1 ? compatible[0] : undefined;
        if (!selected && compatible.length > 1) fail("CONFLICT", "Select an explicit compatible Action implementation.");
        if (!implementation) return fail("ADAPTER_UNAVAILABLE", "No Action implementation is available on this platform.");
        const steps = pipelineSteps(implementation);
        const nodes = implementation.kind === "pipeline" ? assertAcyclic(steps)
          : [{ nodeId: "action", state: "pending" as const, dependencies: [] }];
        const available = availableDefinitions(parsed.source);
        const pins: Record<string, AdapterPin> = Object.create(null);
        const bindingBase = { actorId, runId: parsed.runId, workspaceId: this.options.workspaceId,
          executableDigest: compiled.definitionDigest, source: compiled.source, definition };
        if (implementation.kind === "program") {
          pins.action = this.pin(`program:${String(implementation.program)}`, definition.output_schema, {
            ...bindingBase, actionId: String(definition.action_id), implementation, nodeId: "action",
          });
        } else if (implementation.kind === "pipeline") {
          if (!steps.length) fail("INVALID_DEFINITION", "Action pipeline must contain at least one step.");
          for (const step of steps) {
            const actionId = typeof step.component === "string" ? step.component
              : typeof step.action_id === "string" ? step.action_id : "";
            if (!actionId) return fail("INVALID_DEFINITION", "Action step must name a component or pinned Action.");
            const componentStep = typeof step.component === "string";
            const child = available.get(actionId);
            if (!child) return fail("INVALID_DEFINITION", `Nested Action is not in the pinned source: ${actionId}`);
            if (!componentStep) {
              const dependencyPin = isRecord(definition.dependencies) ? definition.dependencies[actionId] : undefined;
              if (dependencyPin !== child.content_hash) fail("CONFLICT", "Nested Action dependency content hash is not pinned.");
            }
            const schema = schemaFor(step, child);
            const key = `${componentStep ? "component" : "action"}:${actionId}`;
            pins[step.id as string] = this.pin(key, schema, {
              ...bindingBase, actionId, definition: child, implementation,
              nodeId: String(step.id), step,
            });
          }
        } else if (implementation.kind === "builtin") {
          pins.action = this.pin(`action:${String(definition.action_id)}`, definition.output_schema, {
            ...bindingBase, actionId: String(definition.action_id), implementation, nodeId: "action",
          });
        } else fail("ADAPTER_UNAVAILABLE", "This Action implementation kind is not installed.");
        for (const node of nodes) {
          const pin = pins[node.nodeId] ?? pins.action;
          if (!pin) return fail("ADAPTER_UNAVAILABLE", "Action plan contains an unpinned native node.");
          const adapter = this.installed(pin);
          const binding: ActionAuthorizationBinding = {
            ...bindingBase, actionId: String(definition.action_id), implementation,
            nodeId: node.nodeId,
            ...(implementation.kind === "pipeline" ? { step: steps.find(step => step.id === node.nodeId) } : {}),
          };
          if (adapter.authorizeData(freeze({ ...clone(binding), inputs })) !== true) {
            fail("FORBIDDEN", "Action data policy denied this exact actor, definition, and input snapshot.");
          }
        }
        const run: Snapshot = {
          runId: parsed.runId, version: 1, state: "ready", actionId: String(definition.action_id),
          actionVersion: Number(definition.version), definitionDigest: compiled.definitionDigest,
          definition, source: compiled.source, sourceSnapshot: clone(parsed.source), implementation,
          deadline: parsed.deadline, inputs, nodes, adapters: pins, eventSequence: 0, cancelRequested: false,
        };
        bounded(JSON.parse(JSON.stringify(run)), L.snapshotBytes);
        this.event(actorId, run, "created");
        this.database.prepare("INSERT INTO action_runtime_runs VALUES(?,?,?,?)")
          .run(actorId, run.runId, run.version, JSON.stringify(run));
        return publicView(run);
      });
    });
  }
  get(actorId: string, runId: string) {
    this.outside(); actor(actorId); id.parse(runId);
    return actionRuntimeDefinitions[1].output.parse(publicView(load(this.database, actorId, runId)));
  }
  importRecoveredBatch(actorId: string, inputs: readonly RecoveredActionRun[]) {
    if (inputs.length > L.runs) return fail("RESOURCE_LIMIT", "Historical Action Run batch exceeds its domain bound.");
    return this.atomic(() => inputs.map(input => this.importRecoveredInTransaction(actorId, input)));
  }
  private importRecoveredInTransaction(actorId: string, input: RecoveredActionRun) {
    return this.mutate(() => {
      actor(actorId); id.parse(input.runId); z.uuid().parse(input.operationId);
      digest.parse(input.sourceReceiptSha256); digest.parse(input.expectedDefinitionDigest);
      z.number().safe().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1).parse(input.previousVersion);
      bounded(input, L.snapshotBytes);
      if (!["unknown", "waiting", "succeeded", "failed", "cancelled"].includes(input.state))
        return fail("INVALID_ARGUMENT", "Historical Action admission cannot dispatch a worker.");
      const compiled = readActionCompiler({ operation: "action.definition.compile",
        args: { source: input.source, ...(input.actionId ? { actionId: input.actionId } : {}) } }) as {
          status: string; definitionDigest: string; definition: JsonRecordValue; source: unknown;
        };
      if (compiled.status !== "valid" || compiled.definitionDigest !== input.expectedDefinitionDigest)
        return fail("CONFLICT", "The historical Action requires its exact independently selected compiler identity.");
      return this.receipt(actorId, input.operationId, hash({ operation: "action.runtime.import-recovered", input }), () => {
        if (this.database.prepare("SELECT 1 FROM action_runtime_runs WHERE actor_id=? AND run_id=?").get(actorId, input.runId))
          return fail("CONFLICT", "Historical Action admission will not replace an existing canonical Run.");
        const definition = compiled.definition;
        validateSchema(definition.input_schema, input.inputs, "Historical Action inputs violate the pinned schema");
        const implementation = (definition.implementations as Implementation[]).find((item, index) =>
          (typeof item.id === "string" ? item.id : `index:${index}`) === input.implementationId);
        if (!implementation) return fail("INVALID_DEFINITION", "The historical implementation is not pinned in its source.");
        const steps = pipelineSteps(implementation);
        const nodes: NodeRecord[] = implementation.kind === "pipeline" ? assertAcyclic(steps)
          : [{ nodeId: "action", state: "pending", dependencies: [] }];
        const pins: Record<string, AdapterPin> = Object.create(null);
        const available = availableDefinitions(input.source);
        for (const [nodeId, outputs] of Object.entries(input.completed)) {
          const node = nodes.find(item => item.nodeId === nodeId), step = steps.find(item => item.id === nodeId);
          const child = step ? available.get(String(step.component ?? step.action_id)) : definition;
          if (!node || !child) return fail("RECOVERY_CONFLICT", "Historical step receipt does not name a pinned native node.");
          validateSchema(schemaFor(step ?? {}, child), outputs, "Historical step output violates its pinned schema");
          node.state = "succeeded"; node.outputs = clone(outputs);
        }
        const run: Snapshot = {
          runId: input.runId, version: input.previousVersion + 1, state: input.state, actionId: String(definition.action_id),
          actionVersion: Number(definition.version), definitionDigest: compiled.definitionDigest, definition,
          source: compiled.source, sourceSnapshot: clone(input.source), implementation,
          deadline: this.clock() + L.deadlineMs, inputs: clone(input.inputs), nodes, adapters: pins,
          eventSequence: 0, cancelRequested: input.state === "cancelled",
          checkpoints: input.history.map(item => actionCheckpoint.parse(item)),
          originalAdmissionSha256: input.sourceReceiptSha256,
          ...(input.actionId ? { selectedActionId: input.actionId } : {}),
        };
        if (input.state === "waiting") {
          if (!targetCompatible(implementation) || implementation.kind !== "pipeline" || !input.checkpoint)
            return fail("RECOVERY_CONFLICT", "Only a quiescent compatible pinned native checkpoint may be rebound.");
          const checkpoint = actionCheckpoint.parse(input.checkpoint), node = nodes.find(item => item.nodeId === checkpoint.step);
          if (!node || node.state !== "pending" || checkpoint.run_id !== input.runId || checkpoint.state !== "waiting"
            || originalDigest(checkpoint.proposal) !== checkpoint.proposal_digest)
            return fail("RECOVERY_CONFLICT", "The historical checkpoint does not match its exact native continuation.");
          const checkpointStep = steps.find(step => step.id === checkpoint.step);
          const checkpointInputs = checkpointStep && resolveInputs(checkpointStep.inputs, run);
          if (!checkpointStep || !isRecord(checkpointInputs))
            return fail("RECOVERY_CONFLICT", "Historical checkpoint inputs cannot be resolved from exact prior receipts.");
          const expected = newActionCheckpoint(input.runId, checkpoint.step, String(checkpointStep.component),
            checkpointInputs, this.clock(), run.deadline);
          const binding = (value: ActionCheckpoint) => ({
            kind: value.kind, proposal: value.proposal, evidence: value.evidence, owner: value.owner,
            deadline: value.deadline, timeout_behavior: value.timeout_behavior, answer_schema: value.answer_schema, trigger: value.trigger,
          });
          if (originalDigest(binding(expected)) !== originalDigest(binding(checkpoint)))
            return fail("RECOVERY_CONFLICT", "The old proposal/trigger is not the exact pinned source continuation.");
          for (const step of steps) {
            const child = available.get(String(step.component));
            if (!child || !["core.checkpoint", "core.wait", "core.constant", "core.math-expression", "core.cast", "core.lookup"].includes(String(step.component)))
              return fail("NOT_AVAILABLE", "This historical continuation requires an unimplemented native nested/effect handler.");
            const binding = { actorId, runId: run.runId, workspaceId: this.options.workspaceId, executableDigest: run.definitionDigest,
              source: run.source, actionId: String(child.action_id), definition: child, implementation,
              nodeId: String(step.id), step };
            const pin = this.pin(`component:${String(step.component)}`, schemaFor(step, child), binding);
            if (this.installed(pin).authorizeData(freeze({ ...clone(binding), inputs: run.inputs })) !== true)
              return fail("ACCESS_DENIED", "Native Action admission denied this historical input/continuation.");
            pins[String(step.id)] = pin;
          }
          node.state = "waiting";
          run.checkpoints!.push(checkpoint);
          run.deadline = this.clock() + Math.ceil(Math.min(checkpoint.remaining_seconds, L.deadlineMs / 1000) * 1000);
        } else if (input.state === "succeeded") {
          if (nodes.some(node => node.state !== "succeeded"))
            return fail("RECOVERY_CONFLICT", "Successful historical Runs require every exact completed step receipt.");
          const output = implementation.kind === "pipeline" ? resolveInputs(implementation.output, run) : nodes[0]?.outputs;
          validateSchema(definition.output_schema, output, "Historical result violates its pinned source");
          if (!input.expectedOutput || originalDigest(output) !== originalDigest(input.expectedOutput))
            return fail("RECOVERY_CONFLICT", "Historical output does not match the exact completed step receipts.");
        } else {
          for (const node of nodes) if (node.state === "pending") node.state = input.state === "cancelled" ? "cancelled" : "unknown";
        }
        if (Number(this.database.prepare("SELECT count(*) n FROM action_runtime_runs").get()!.n) >= L.runs)
          return fail("RESOURCE_LIMIT", "Action run capacity reached.");
        this.event(actorId, run, "created");
        if (input.state === "waiting") this.event(actorId, run, "checkpoint-created", input.checkpoint!.step);
        else this.event(actorId, run, input.state === "succeeded" ? "run-succeeded" : input.state === "failed" ? "run-failed"
          : input.state === "cancelled" ? "run-cancelled" : "run-unknown");
        bounded(clone(run), L.snapshotBytes);
        this.database.prepare("INSERT INTO action_runtime_runs VALUES(?,?,?,?)").run(actorId, run.runId, run.version, JSON.stringify(run));
        return publicView(run);
      });
    });
  }
  selectImplementation(actorId: string, source: ActionRuntimeCreate["source"], expectedDigest: string, implementationId: string) {
    this.outside(); actor(actorId); digest.parse(expectedDigest);
    const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source } }) as {
      status: string; definitionDigest: string; definition: JsonRecordValue;
    };
    if (compiled.status !== "valid" || compiled.definitionDigest !== expectedDigest) fail("CONFLICT", "Action definition changed before selection.");
    const implementations = compiled.definition.implementations as Implementation[];
    if (!implementations.some(item => item.id === implementationId && targetCompatible(item)))
      fail("INVALID_ARGUMENT", "Implementation is unavailable on the current target host.");
    return this.atomic(() => {
      recordActionImplementation(this.database, { actorId, actionId: String(compiled.definition.action_id),
        definitionDigest: expectedDigest, implementationId });
      return { ok: true, action_id: String(compiled.definition.action_id), implementation_id: implementationId };
    });
  }
  /** Native-only owned result read; metadata and events remain output-free. */
  getOwnedResult(actorId: string, runId: string, pinnedDefinition: JsonRecordValue): JsonRecordValue | undefined {
    this.outside(); actor(actorId); id.parse(runId);
    const run = load(this.database, actorId, runId);
    if (run.state !== "succeeded") return undefined;
    if (pinnedDefinition.action_id !== run.actionId || originalDigest(pinnedDefinition) !== originalDigest(run.definition))
      return fail("RECOVERY_CONFLICT", "The owned Action output requires its exact pinned definition.");
    if (run.reconciledOutput) {
      validateSchema(pinnedDefinition.output_schema, run.reconciledOutput, "Reconciled output violates its pinned schema");
      return clone(run.reconciledOutput);
    }
    let output: unknown;
    if (run.implementation.kind === "program" || run.implementation.kind === "builtin") {
      if (run.implementation.kind === "builtin") {
        const selected = (Array.isArray(pinnedDefinition.implementations) ? pinnedDefinition.implementations : [])
          .find(item => isRecord(item) && hash(item) === hash(run.implementation));
        if (!(exactRunnablePureBuiltin(pinnedDefinition) || exactRunnableArtifactBuiltin(pinnedDefinition))
          || !isRecord(selected) || hash(selected) !== hash(run.implementation))
          return fail("RECOVERY_CONFLICT", "The owned builtin revision is unavailable or invalid.");
        const pin = run.adapters.action;
        if (!pin || pin.key !== `action:${run.actionId}` || pin.outputContractDigest !== originalDigest(pinnedDefinition.output_schema))
          return fail("RECOVERY_CONFLICT", "The owned builtin adapter pin is unavailable or invalid.");
        this.installed(pin);
      }
      if (run.nodes.length !== 1 || run.nodes[0]?.nodeId !== "action"
        || run.nodes[0].state !== "succeeded" || !isRecord(run.nodes[0].outputs))
        return fail("RECOVERY_CONFLICT", "The successful Action result is unavailable or invalid.");
      output = run.nodes[0].outputs;
    } else if (run.implementation.kind === "pipeline") {
      const selected = (Array.isArray(pinnedDefinition.implementations) ? pinnedDefinition.implementations : [])
        .find(item => isRecord(item) && hash(item) === hash(run.implementation));
      if (!isRecord(selected) || hash(selected) !== hash(run.implementation))
        return fail("RECOVERY_CONFLICT", "The owned pipeline revision is unavailable or invalid.");
      if (run.checkpoints?.length) {
        if (!Array.isArray(pinnedDefinition.effects) || pinnedDefinition.effects.some(effect => !["pure", "human-input"].includes(String(effect)))
          || !Array.isArray(selected.steps) || selected.steps.some(step => !isRecord(step)
            || !["core.checkpoint", "core.wait", "core.constant", "core.cast", "core.lookup", "core.math-expression"].includes(String(step.component))))
          return fail("ACCESS_DENIED", "The checkpoint result requires a supported intrinsic/pure pipeline.");
      } else validatePurePipeline(pinnedDefinition, selected);
      const steps = pipelineSteps(selected as Implementation), components = actionComponents();
      if (run.nodes.length !== steps.length) return fail("RECOVERY_CONFLICT", "The owned pipeline result is incomplete.");
      for (const step of steps) {
        const node = run.nodes.find(item => item.nodeId === step.id);
        const component = components[String(step.component)];
        if (!component || !node || node.state !== "succeeded" || !isRecord(node.outputs))
          return fail("RECOVERY_CONFLICT", "The owned pipeline result is incomplete.");
        bounded(node.outputs, L.outputBytes);
        validateSchema(schemaFor(step, component), node.outputs, "Stored pipeline node output violates its pinned schema");
      }
      output = resolveInputs(selected.output, run);
    } else return undefined;
    if (!isRecord(output)) return fail("RECOVERY_CONFLICT", "The successful Action result is unavailable or invalid.");
    bounded(output, L.outputBytes);
    validateSchema(pinnedDefinition.output_schema, output, "Stored Action output violates its pinned schema");
    return clone(output);
  }
  getCurrentOwnedResult(actorId: string, runId: string) {
    this.outside(); actor(actorId); id.parse(runId);
    const run = load(this.database, actorId, runId);
    if (run.state !== "succeeded") return undefined;
    for (const node of run.nodes) {
      const step = pipelineSteps(run.implementation).find(item => item.id === node.nodeId);
      const child = step ? availableDefinitions(run.sourceSnapshot).get(String(step.component ?? step.action_id)) : run.definition;
      const pin = run.adapters[node.nodeId] ?? run.adapters.action, adapter = pin && this.installed(pin);
      const inputs = step ? resolveInputs(step.inputs, run) : run.inputs;
      if (!child || !adapter || !isRecord(inputs)) return fail("ACCESS_DENIED", "The exact native Action result policy is unavailable.");
      const binding = { actorId, runId, workspaceId: this.options.workspaceId, executableDigest: run.definitionDigest, source: run.source,
        actionId: String(child.action_id), definition: child, implementation: run.implementation, nodeId: node.nodeId, ...(step ? { step } : {}) };
      if (adapter.authorizeDefinition(freeze(clone(binding))) !== true
        || adapter.authorizeData(freeze({ ...clone(binding), inputs })) !== true)
        return fail("ACCESS_DENIED", "The current native policy denied this exact Action result.");
    }
    return this.getOwnedResult(actorId, runId, run.definition);
  }
  maintenanceSnapshot(actorId: string, runId: string) {
    this.outside(); actor(actorId); id.parse(runId);
    const run = load(this.database, actorId, runId);
    const compiled = readActionCompiler({ operation: "action.definition.compile", args: {
      source: run.sourceSnapshot, ...(isRecord(run.sourceSnapshot) && run.sourceSnapshot.kind === "moduleSet" ? { actionId: run.actionId } : {}),
    } }) as { status: string; definitionDigest: string; definition: JsonRecordValue };
    if (compiled.status !== "valid" || compiled.definitionDigest !== run.definitionDigest
      || originalDigest(compiled.definition) !== originalDigest(run.definition))
      fail("RECOVERY_CONFLICT", "Action maintenance requires the exact stored source and definition.");
    const view = actionRuntimeDefinitions[1].output.parse(publicView(run));
    bounded(run.inputs, L.inputBytes);
    const outputs = run.state === "succeeded" ? [this.getOwnedResult(actorId, runId, compiled.definition)] : run.nodes.map(node => node.outputs ?? {});
    if (run.state === "succeeded" && outputs[0] === undefined)
      fail("RECOVERY_CONFLICT", "Action maintenance cannot release ownership without its exact successful result.");
    bounded(outputs, L.snapshotBytes);
    const event = this.database.prepare("SELECT record_json FROM action_runtime_events WHERE actor_id=? AND run_id=? ORDER BY sequence DESC LIMIT 1")
      .get(actorId, runId);
    const at = event && (JSON.parse(String(event.record_json)) as { at?: unknown }).at;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0)
      fail("RECOVERY_CONFLICT", "Action maintenance requires its recorded terminal event time.");
    return { ...view, inputs: clone(run.inputs), outputs: clone(outputs), completedAt: Number(at) };
  }
  reconcileRecovered(actorId: string, input: { runId: string; expectedVersion: number; sourceReceiptSha256: string;
      outcome: "succeeded" | "failed" | "cancelled" | "review"; evidence: Record<string, unknown> }) {
      return this.atomic(() => {
        actor(actorId); bounded(input, L.outputBytes);
        const run = load(this.database, actorId, input.runId), previous = run.version;
        if (run.originalAdmissionSha256 !== digest.parse(input.sourceReceiptSha256) || run.state !== "unknown"
          || run.version !== input.expectedVersion) return fail("CONFLICT", "Reconciliation requires this admitted uncertain Run's exact current revision.");
        if (typeof input.evidence.reason !== "string" || !input.evidence.reason.trim())
          return fail("INVALID_ARGUMENT", "Manual reconciliation requires an explicit evidence reason.");
        if (!["succeeded", "failed", "cancelled", "review"].includes(input.outcome))
          return fail("INVALID_ARGUMENT", "Unsupported manual reconciliation outcome.");
        if (input.outcome === "succeeded") {
          validateSchema(run.definition.output_schema, input.evidence.output, "Manual evidence output violates the pinned source");
          if (!isRecord(input.evidence.output)) return fail("INVALID_ARGUMENT", "A typed Action output object is required.");
          run.reconciledOutput = clone(input.evidence.output);
        }
        if (input.outcome !== "review") run.state = input.outcome;
        run.reconciliations = [...run.reconciliations ?? [], { kind: "manual", expectedVersion: input.expectedVersion,
          sourceReceiptSha256: input.sourceReceiptSha256, evidence: clone(input.evidence), outcome: input.outcome, at: this.clock() }];
        this.event(actorId, run, "run-reconciled"); this.save(actorId, run, previous);
        return publicView(run);
      });
    }
  reconcileObserved(actorId: string, input: ActionObservedReconciliation) {
    return this.atomic(() => {
      actor(actorId); bounded(input, L.outputBytes); digest.parse(input.sourceReceiptSha256);
      const run = load(this.database, actorId, input.runId), previous = run.version;
      if (run.originalAdmissionSha256 !== undefined || run.state !== "unknown" || run.version !== input.expectedVersion
        || input.outcome !== "succeeded" || this.options.authorizeObservedReconciliation?.(actorId, input) !== true)
        return fail("CONFLICT", "Observed reconciliation requires this native uncertain Run's exact authorized revision and process evidence.");
      if (typeof input.evidence.reason !== "string" || !input.evidence.reason.trim())
        return fail("INVALID_ARGUMENT", "Observed reconciliation requires an explicit evidence reason.");
      validateSchema(run.definition.output_schema, input.evidence.output, "Observed output violates the pinned source");
      if (!isRecord(input.evidence.output)) return fail("INVALID_ARGUMENT", "A typed observed Action output is required.");
      run.reconciledOutput = clone(input.evidence.output); run.state = "succeeded";
      run.reconciliations = [...run.reconciliations ?? [], { kind: "manual", expectedVersion: input.expectedVersion,
        sourceReceiptSha256: input.sourceReceiptSha256, evidence: clone(input.evidence), outcome: "succeeded", at: this.clock() }];
      this.event(actorId, run, "run-reconciled"); this.save(actorId, run, previous);
      return publicView(run);
    });
  }
  events(actorId: string, args: unknown) {
    this.outside(); actor(actorId);
    const parsed = actionRuntimeDefinitions[2].input.parse(args);
    const run = load(this.database, actorId, parsed.runId);
    const rows = this.database.prepare("SELECT record_json FROM action_runtime_events WHERE actor_id=? AND run_id=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(actorId, run.runId, parsed.after, parsed.limit + 1) as Array<{ record_json: string }>;
    const items = rows.slice(0, parsed.limit).map(row => JSON.parse(row.record_json));
    const oldestSequence = Number(this.database.prepare("SELECT min(sequence) n FROM action_runtime_events WHERE actor_id=? AND run_id=?")
      .get(actorId, run.runId)!.n ?? 0);
    return actionRuntimeDefinitions[2].output.parse({
      runId: run.runId, items, oldestSequence, latestSequence: run.eventSequence,
      gap: parsed.after < oldestSequence - 1,
    });
  }
  cancel(actorId: string, args: ActionRuntimeCancel) { return this.atomic(() => this.cancelInTransaction(actorId, args)); }
  cancelInTransaction(actorId: string, args: ActionRuntimeCancel) {
    return this.mutate(() => {
      const parsed = actionRuntimeDefinitions[3].input.parse(args);
      return this.receipt(actorId, parsed.operationId, hash({ operation: "action.runtime.cancel", args: parsed }), () => {
        const run = load(this.database, actorId, parsed.runId);
        if (run.version !== parsed.expectedVersion) fail("CONFLICT", "Action run version changed.");
        if (terminal.has(run.state)) return publicView(run);
        const previous = run.version;
        run.cancelRequested = true; run.state = "cancelling";
        for (const checkpoint of run.checkpoints ?? []) if (checkpoint.state === "waiting") checkpoint.state = "cancelled";
        for (const node of run.nodes) if (node.state === "pending" || node.state === "waiting") {
          node.state = "cancelled"; this.event(actorId, run, "node-cancelled", node.nodeId);
        }
        if (!run.nodes.some(node => node.state === "running")) {
          run.state = "cancelled"; this.event(actorId, run, "run-cancelled");
        } else this.event(actorId, run, "cancel-requested");
        this.save(actorId, run, previous);
        const controller = this.active.get(keyFor(actorId, run.runId));
        if (controller) queueMicrotask(() => {
          if (!this.closed && !this.database.isTransaction && load(this.database, actorId, run.runId).cancelRequested) {
            controller.abort(new DOMException("Action run cancelled", "AbortError"));
          }
        });
        return publicView(run);
      });
    });
  }
  checkpoints(actorId: string, runId: string, includeHistory = false) {
    this.outside(); actor(actorId); id.parse(runId); z.boolean().parse(includeHistory);
    const run = load(this.database, actorId, runId);
    const checkpoints = (run.checkpoints ?? []).map(item => actionCheckpoint.parse(item));
    return { ok: true, checkpoints: clone(includeHistory ? checkpoints : checkpoints.slice(-1)) };
  }
  respondCheckpoint(actorId: string, args: z.infer<typeof checkpointResponse>) {
    const parsed = checkpointResponse.parse(args);
    return this.atomic(() => {
      actor(actorId); bounded(parsed, L.outputBytes);
      const run = load(this.database, actorId, parsed.run_id);
      const checkpoint = run.checkpoints?.at(-1);
      if (!checkpoint || checkpoint.checkpoint_id !== parsed.checkpoint_id) return fail("CONFLICT", "Checkpoint identity is stale.");
      if (checkpoint.resume_token !== parsed.resume_token || checkpoint.proposal_digest !== parsed.proposal_digest
        || originalDigest(checkpoint.proposal) !== parsed.proposal_digest)
        fail("ACCESS_DENIED", "Response must bind the exact proposal and resume token.");
      if (checkpoint.state === "resolved") {
        if (checkpoint.answer_digest !== originalDigest(parsed.answer)) fail("CONFLICT", "Checkpoint has already been answered differently.");
        return { ok: true, run_id: run.runId, replayed: true };
      }
      if (checkpoint.trigger.kind !== "human") fail("ACCESS_DENIED", "This checkpoint is owned by its durable trigger.");
      this.resolveCheckpoint(actorId, run, checkpoint, parsed.answer, parsed.event_key);
      return { ok: true, run_id: run.runId, replayed: false };
    });
  }
  private resolveCheckpoint(actorId: string, run: Snapshot, checkpoint: ActionCheckpoint,
    answer: z.infer<typeof checkpointResponse>["answer"], eventKey: string) {
    if (run.state !== "waiting" || checkpoint.state !== "waiting") fail("CONFLICT", "Checkpoint is no longer waiting.");
    if (checkpoint.deadline !== null && this.clock() / 1000 >= checkpoint.deadline) fail("CONFLICT", "Checkpoint deadline expired; run the safety scan.");
    checkActionCheckpointAnswer(checkpoint, answer);
    const node = run.nodes.find(item => item.nodeId === checkpoint.step);
    if (!node || node.state !== "waiting" || run.nodes.some(item => item.state === "running"))
      return fail("RECOVERY_CONFLICT", "Checkpoint continuation is not quiescent.");
    const previous = run.version;
    checkpoint.state = "resolved"; checkpoint.answer = clone(answer); checkpoint.answer_digest = originalDigest(answer);
    checkpoint.event_key = eventKey; checkpoint.resolved_at = this.clock() / 1000;
    node.state = "succeeded"; node.outputs = { value: clone(answer) };
    run.state = "ready"; run.deadline = this.clock() + Math.ceil(checkpoint.remaining_seconds * 1000);
    this.event(actorId, run, "checkpoint-resolved", node.nodeId);
    this.event(actorId, run, "node-succeeded", node.nodeId);
    this.save(actorId, run, previous);
  }
  wakeCheckpoint(actorId: string, runId: string, eventKey: string, eventName: string) {
    this.outside(); actor(actorId); z.string().min(1).max(200).parse(eventKey);
    return this.atomic(() => {
      const run = load(this.database, actorId, runId), checkpoint = run.checkpoints?.at(-1);
      if (!checkpoint || checkpoint.trigger.kind !== "event" || checkpoint.trigger.name !== eventName)
        return fail("CONFLICT", "Wakeup does not match the current event trigger.");
      if (checkpoint.state === "resolved") {
        if (checkpoint.event_key !== eventKey) fail("CONFLICT", "Another event already resolved this checkpoint.");
        return { ok: true, run_id: runId, replayed: true };
      }
      this.resolveCheckpoint(actorId, run, checkpoint, { event: eventName }, eventKey);
      return { ok: true, run_id: runId, replayed: false };
    });
  }
  scanCheckpoints(actorId: string, limit = 8) {
    this.outside(); actor(actorId); z.number().int().min(1).max(32).parse(limit);
    return this.atomic(() => {
      const reviewed: string[] = [], ready: string[] = [];
      const rows = this.database.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=? AND json_extract(snapshot,'$.state')='waiting' ORDER BY json_extract(snapshot,'$.checkpoints[#-1].created_at'),run_id")
        .all(actorId);
      for (const row of rows) {
        if (ready.length + reviewed.length >= limit) break;
        const run = JSON.parse(String(row.snapshot)) as Snapshot, checkpoint = run.checkpoints?.at(-1);
        if (!checkpoint) return fail("RECOVERY_CONFLICT", "Waiting Action has no typed checkpoint.");
        if (checkpoint.deadline !== null && this.clock() / 1000 >= checkpoint.deadline) {
          const previous = run.version;
          checkpoint.state = "expired";
          run.state = checkpoint.timeout_behavior === "cancel" ? "cancelled" : "unknown";
          for (const node of run.nodes) if (node.state === "waiting" || node.state === "pending")
            node.state = run.state === "cancelled" ? "cancelled" : "unknown";
          this.event(actorId, run, "checkpoint-expired", checkpoint.step);
          this.event(actorId, run, run.state === "cancelled" ? "run-cancelled" : "run-unknown");
          this.save(actorId, run, previous); reviewed.push(run.runId);
        } else if (checkpoint.trigger.kind === "timer" && this.clock() / 1000 >= checkpoint.trigger.at) {
          this.resolveCheckpoint(actorId, run, checkpoint, { at: checkpoint.trigger.at }, `timer:${checkpoint.checkpoint_id}`);
          ready.push(run.runId);
        } else if (checkpoint.trigger.kind === "dependency") {
          let dependency: Snapshot | undefined;
          try { dependency = load(this.database, actorId, checkpoint.trigger.run_id); }
          catch (error) { if (!(error instanceof CoreError) || error.code !== "NOT_FOUND") throw error; }
          if (!dependency || dependency.version < checkpoint.trigger.expected_version
            || invocationFingerprint(dependency) !== checkpoint.trigger.invocation_fingerprint
            || ["failed", "cancelled", "unknown"].includes(dependency.state)) {
            const previous = run.version;
            run.state = "unknown";
            for (const node of run.nodes) if (node.state === "waiting" || node.state === "pending") node.state = "unknown";
            this.event(actorId, run, "run-unknown"); this.save(actorId, run, previous); reviewed.push(run.runId);
          } else if (dependency.state === "succeeded") {
            this.resolveCheckpoint(actorId, run, checkpoint, { run_id: dependency.runId }, `dependency:${checkpoint.checkpoint_id}`);
            ready.push(run.runId);
          }
        }
      }
      return { ok: true, ready, reviewed };
    });
  }
  request(actorId: string, request: ActionRuntimeRequest): unknown {
    const definition = actionRuntimeDefinitions.find(item => item.id === request.operation);
    if (!definition) return fail("NOT_FOUND", "Unknown Action runtime operation.");
    const args = definition.input.parse(request.args);
    switch (request.operation) {
      case "action.runtime.create": return this.create(actorId, args as ActionRuntimeCreate);
      case "action.runtime.get": return this.get(actorId, String(args.runId));
      case "action.runtime.events": return this.events(actorId, args);
      case "action.runtime.cancel": return this.cancel(actorId, args as ActionRuntimeCancel);
    }
  }

  async tick(actorId: string, runId: string): Promise<unknown> {
    if (this.closing) fail("CLOSED", "Action runtime is closing.");
    this.outside(); actor(actorId); id.parse(runId);
    const pinned = load(this.database, actorId, runId);
    const selected = readActionCompiler({
      operation: "action.definition.compile", args: { source: pinned.sourceSnapshot,
        ...(pinned.selectedActionId ? { actionId: pinned.selectedActionId } : {}) },
    }) as { status: string; definitionDigest?: string };
    if (selected.status !== "valid" || selected.definitionDigest !== pinned.definitionDigest)
      fail("CONFLICT", "Stored Action belongs to a different source identity; execution requires its own version and admission.");
    const key = keyFor(actorId, runId);
    if (this.active.has(key)) fail("BUSY", "Action run already has an execution owner.");
    const controller = new AbortController(); this.active.set(key, controller);
    const task = this.executeRun(actorId, runId, controller);
    this.running.add(task); void task.then(() => this.running.delete(task), () => this.running.delete(task));
    try { return await task; } finally { this.active.delete(key); }
  }
  private async executeRun(actorId: string, runId: string, controller: AbortController): Promise<unknown> {
    let started = false;
    try {
      for (;;) {
        this.outside();
        const run = this.atomic(() => {
          const current = load(this.database, actorId, runId);
          if (current.state === "ready") {
            const previous = current.version; current.state = "running";
            this.event(actorId, current, "run-started");
            this.save(actorId, current, previous);
          }
          return current;
        });
        if (run.cancelRequested || run.state === "cancelling" || controller.signal.aborted) {
          return this.finishCancelled(actorId, runId);
        }
        if (run.state !== "running") return publicView(run);
        started = true;
        if (this.clock() >= run.deadline) {
          controller.abort(new DOMException("Action deadline exceeded", "TimeoutError"));
          return this.finishUnknown(actorId, runId);
        }
        const ready = run.nodes.filter(node => node.state === "pending"
          && node.dependencies.every(dep => run.nodes.find(item => item.nodeId === dep)?.state === "succeeded"));
        if (!ready.length) {
          const snapshot = this.atomic(() => {
            const current = load(this.database, actorId, runId), previous = current.version;
            const unresolved = current.nodes.filter(node => node.state === "pending");
            if (unresolved.length) {
              for (const node of unresolved) { node.state = "skipped"; this.event(actorId, current, "node-skipped", node.nodeId); }
              current.state = "failed"; this.event(actorId, current, "run-failed");
            } else if (current.implementation.kind === "pipeline") {
              try {
                    const output = resolveInputs(current.implementation.output ?? {}, current);
                    if (!isRecord(output) || hasArtifactField(output)
                      && (!isPipelineArtifactForward(current.inputs, output)
                        || this.options.authorizePipelineArtifact?.(actorId, current.inputs, output) !== true))
                      fail("NOT_AVAILABLE", "Managed Action artifact results are unavailable.");
                    bounded(output, L.outputBytes);
                    validateSchema(current.definition.output_schema, output, "Action output violates its pinned schema");
                    current.state = "succeeded"; this.event(actorId, current, "run-succeeded");
              } catch {
                current.state = "unknown"; this.event(actorId, current, "run-unknown");
              }
            } else {
              current.state = "succeeded"; this.event(actorId, current, "run-succeeded");
            }
            this.save(actorId, current, previous);
            return current;
          });
          return publicView(snapshot);
        }
        // A suspension must not strand parallel effects without receipts. Complete its peers first.
        const steps = pipelineSteps(run.implementation);
        const controls = ready.filter(node => steps.some(step => step.id === node.nodeId
          && ["core.checkpoint", "core.wait"].includes(String(step.component))));
        const batch = controls.length ? ready.filter(node => !controls.includes(node)) : ready;
        const selected = batch.length ? batch : controls.slice(0, 1);
        for (const node of selected) this.markStarted(actorId, runId, node.nodeId);
        const outcomes = await Promise.all(selected.map(node => this.dispatchNode(actorId, runId, node.nodeId, controller)));
        let terminalResult: Snapshot | undefined;
        for (const outcome of outcomes) {
          const updated = this.finishNode(actorId, runId, outcome.nodeId, outcome.status, outcome.outputs, outcome.reason, outcome.checkpoint);
          if (updated.state !== "running") terminalResult = updated;
        }
        if (terminalResult) return publicView(terminalResult);
        started = true;
      }
    } catch {
      if (started || controller.signal.aborted) {
        try { return publicView(this.finishUnknown(actorId, runId)); } catch { return this.get(actorId, runId); }
      }
      throw new CoreError("EXECUTION_FAILED", "Action execution could not be safely started.");
    }
  }
  private markStarted(actorId: string, runId: string, nodeId: string) {
    this.atomic(() => {
      const run = load(this.database, actorId, runId), previous = run.version;
      if (run.cancelRequested || run.state !== "running") fail("CONFLICT", "Action cancellation fenced dispatch.");
      const node = run.nodes.find(item => item.nodeId === nodeId);
      if (!node) return fail("CONFLICT", "Action node is no longer pending.");
      if (node.state !== "pending") return fail("CONFLICT", "Action node is no longer pending.");
      node.state = "running"; this.event(actorId, run, "node-started", nodeId); this.save(actorId, run, previous);
    });
  }
  private async dispatchNode(actorId: string, runId: string, nodeId: string, controller: AbortController): Promise<{
    nodeId: string; status: "succeeded" | "failed" | "unknown" | "waiting"; outputs?: JsonRecordValue;
    reason?: ActionNodeReason; checkpoint?: ActionCheckpoint;
  }> {
    try {
      const run = load(this.database, actorId, runId);
      const step = pipelineSteps(run.implementation).find(item => item.id === nodeId);
      const pin = run.adapters[nodeId] ?? run.adapters.action;
      if (!pin) return { nodeId, status: "unknown" };
      const adapter = this.installed(pin);
      const childDefinition = step ? availableDefinitions(run.sourceSnapshot).get(String(step.component ?? step.action_id)) : run.definition;
      if (!childDefinition || adapter.outputContractDigest !== originalDigest(schemaFor(step ?? {}, childDefinition))) {
        return { nodeId, status: "unknown" };
      }
      const implementation = run.implementation;
      const binding: ActionAuthorizationBinding = freeze({
        actorId, runId, workspaceId: this.options.workspaceId, executableDigest: run.definitionDigest, source: run.source, actionId: String(childDefinition.action_id),
        definition: childDefinition, implementation, nodeId, ...(step ? { step } : {}),
      });
      const inputs = step ? resolveInputs(step.inputs ?? {}, run) : run.inputs;
      if (!isRecord(inputs)) return { nodeId, status: "failed" };
      try { validateSchema(childDefinition.input_schema, inputs, "Action step input violates its pinned schema"); }
      catch { return { nodeId, status: "failed" }; }
      if (adapter.authorizeDefinition(freeze(clone(binding))) !== true
        || adapter.authorizeData(freeze({ ...clone(binding), inputs })) !== true) return { nodeId, status: "failed" };
      if (step && ["core.checkpoint", "core.wait"].includes(String(step.component))) {
        const checkpoint = newActionCheckpoint(runId, nodeId, String(step.component), inputs, this.clock(), run.deadline);
        if (checkpoint.trigger.kind === "dependency") {
          if (checkpoint.trigger.run_id === runId) return { nodeId, status: "failed" };
          const dependency = load(this.database, actorId, checkpoint.trigger.run_id);
          if (dependency.version < checkpoint.trigger.expected_version || checkpoint.trigger.invocation_fingerprint !== undefined
            && checkpoint.trigger.invocation_fingerprint !== invocationFingerprint(dependency)) return { nodeId, status: "failed" };
          checkpoint.trigger.invocation_fingerprint = invocationFingerprint(dependency);
        }
        return { nodeId, status: "waiting", checkpoint };
      }
      const remaining = run.deadline - this.clock();
      if (remaining < 1 || controller.signal.aborted) return { nodeId, status: "unknown" };
      const timeout = AbortSignal.timeout(Math.min(remaining, L.deadlineMs));
      const signal = AbortSignal.any([controller.signal, timeout]);
      const invocation: ActionInvocation = freeze({
        runId, actorId, workspaceId: this.options.workspaceId, executableDigest: run.definitionDigest, source: run.source, actionId: String(childDefinition.action_id),
        definition: childDefinition, implementation, nodeId, inputs, deadline: run.deadline,
      });
      this.options.assertOwner?.();
      this.options.beforeEffect?.();
      const interrupted = new Promise<undefined>(resolve => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
      const result = await Promise.race([adapter.execute(invocation, { signal }), interrupted]);
      if (result === undefined || signal.aborted) return { nodeId, status: "unknown" };
      if (isRecord(result) && ["succeeded", "failed", "unknown"].includes(String(result.status))) {
        if (result.status !== "succeeded") return {
          nodeId, status: result.status as "failed" | "unknown",
          ...(["ACTION_EFFECT_CONSENT_REQUIRED", "ACTION_RESULT_PROTOCOL_INVALID",
            "ACTION_RESULT_PROTOCOL_OVERSIZED", "ACTION_RESULT_REPORTED_FAILURE", "ACTION_RESULT_REPORTED_BLOCKED",
            "ACTION_RESULT_ARTIFACT_UNSUPPORTED", "ACTION_COMPONENT_UNSUPPORTED", "ACTION_ARTIFACT_INPUT_UNAVAILABLE",
            "ACTION_ARTIFACT_QUOTA_EXCEEDED", "ACTION_BUILD_FAILED",
            "ACTION_BUILD_INTERRUPTED", "ACTION_BUILD_CHANGED", "ACTION_BUILD_OUTPUT_INVALID"].includes(String(result.reason))
            ? { reason: result.reason as ActionNodeReason } : {}),
        };
        const outputs = result.outputs;
        if (!isRecord(outputs)) return { nodeId, status: "unknown" };
        validateSchema(schemaFor(step ?? {}, childDefinition), outputs, "Native Action output violates its pinned schema");
        bounded(outputs, L.outputBytes);
        return { nodeId, status: "succeeded", outputs: clone(outputs) };
      }
      if (!isRecord(result)) return { nodeId, status: "unknown" };
      validateSchema(schemaFor(step ?? {}, childDefinition), result, "Native Action output violates its pinned schema");
      bounded(result, L.outputBytes);
      return { nodeId, status: "succeeded", outputs: clone(result) };
    } catch {
      return { nodeId, status: "unknown" };
    }
  }
  private finishNode(actorId: string, runId: string, nodeId: string, status: "succeeded" | "failed" | "unknown" | "waiting",
    outputs?: JsonRecordValue, reason?: ActionNodeReason, checkpoint?: ActionCheckpoint): Snapshot {
    return this.atomic(() => {
      const run = load(this.database, actorId, runId), previous = run.version;
      const node = run.nodes.find(item => item.nodeId === nodeId);
      if (!node) return run;
      if (node.state !== "running") return run;
      if (run.cancelRequested || run.state === "cancelling") {
        node.state = "unknown"; run.state = "unknown";
        this.event(actorId, run, "node-unknown", nodeId); this.event(actorId, run, "run-unknown");
      } else if (status === "waiting" && checkpoint) {
        node.state = "waiting"; run.state = "waiting";
        run.checkpoints = [...run.checkpoints ?? [], actionCheckpoint.parse(checkpoint)];
        this.event(actorId, run, "checkpoint-created", nodeId);
      } else {
        node.state = status; if (status === "succeeded") node.outputs = outputs;
        if (status !== "succeeded" && reason) node.reason = reason;
        this.event(actorId, run, status === "succeeded" ? "node-succeeded" : status === "failed" ? "node-failed" : "node-unknown", nodeId);
        if (status === "unknown") { run.state = "unknown"; this.event(actorId, run, "run-unknown"); }
        else if (status === "failed") {
          for (const pending of run.nodes) if (pending.state === "pending") {
            pending.state = "skipped"; this.event(actorId, run, "node-skipped", pending.nodeId);
          }
          run.state = "failed"; this.event(actorId, run, "run-failed");
        }
      }
      this.save(actorId, run, previous);
      return run;
    });
  }
  private finishCancelled(actorId: string, runId: string): Snapshot {
    return this.atomic(() => {
      const run = load(this.database, actorId, runId), previous = run.version;
      for (const node of run.nodes) {
        if (node.state === "running") { node.state = "unknown"; this.event(actorId, run, "node-unknown", node.nodeId); }
        else if (node.state === "pending") { node.state = "cancelled"; this.event(actorId, run, "node-cancelled", node.nodeId); }
      }
      run.state = run.nodes.some(node => node.state === "unknown") ? "unknown" : "cancelled";
      this.event(actorId, run, run.state === "unknown" ? "run-unknown" : "run-cancelled");
      this.save(actorId, run, previous); return run;
    });
  }
  private finishUnknown(actorId: string, runId: string): Snapshot {
    return this.atomic(() => {
      const run = load(this.database, actorId, runId), previous = run.version;
      for (const node of run.nodes) {
        if (node.state === "running") { node.state = "unknown"; this.event(actorId, run, "node-unknown", node.nodeId); }
        else if (node.state === "pending") { node.state = "cancelled"; this.event(actorId, run, "node-cancelled", node.nodeId); }
      }
      run.state = "unknown"; this.event(actorId, run, "run-unknown");
      this.save(actorId, run, previous); return run;
    });
  }
  async close(options: { drainMs?: number } = {}) {
    if (this.closed) return;
    const drainMs = options.drainMs ?? L.drainMs;
    if (!Number.isSafeInteger(drainMs) || drainMs < 0 || drainMs > L.drainMs) fail("INVALID_ARGUMENT", "Action drain bound invalid.");
    this.closing = true;
    for (const controller of this.active.values()) controller.abort(new DOMException("Action runtime closing", "AbortError"));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.running]), new Promise(resolve => { timer = setTimeout(resolve, drainMs); })]);
    if (timer) clearTimeout(timer);
    if (this.running.size) fail("BUSY", "Action runtime did not drain; its shared database must remain open.");
    if (this.database.isTransaction) fail("TRANSACTION_BOUNDARY", "Action runtime closed while a shared transaction is active.");
    this.closed = true;
  }

  assertQuiescent(): void {
    this.outside();
    if (this.active.size || this.running.size) fail("BUSY", "Action dispatch is still active.");
    if (this.database.prepare("SELECT 1 FROM action_runtime_runs WHERE json_extract(snapshot,'$.state') IN ('ready','running','waiting','cancelling') LIMIT 1").get()) {
      fail("BUSY", "Action runs still require native execution or reconciliation.");
    }
  }
}

export function mutateActionRuntime(runtime: ActionRuntime, request: ActionRuntimeHostRequest): unknown {
  if (request.operation === "action.runtime.create") return runtime.createInTransaction(request.actorId, request.args as ActionRuntimeCreate);
  if (request.operation === "action.runtime.cancel") return runtime.cancelInTransaction(request.actorId, request.args as never);
  return fail("INVALID_ARGUMENT", "Only Action create/cancel operations mutate state.");
}

export function readActionRuntime(runtime: ActionRuntime, request: ActionRuntimeHostRequest): unknown {
  if (request.operation === "action.runtime.get") {
    const parsed = actionRuntimeDefinitions[1].input.parse(request.args);
    return runtime.get(request.actorId, parsed.runId);
  }
  if (request.operation === "action.runtime.events") return runtime.events(request.actorId, request.args);
  return fail("INVALID_ARGUMENT", "Only Action get/events operations are read-only.");
}
