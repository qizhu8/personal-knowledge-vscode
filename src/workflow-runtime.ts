import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import { CoreError } from "./contracts.js";
import type { MarkdownRecord } from "./markdown.js";
import { readWorkflowCompiler } from "./workflow-compiler.js";
import { canonicalJson, type WorkflowDefinitionV1 } from "./domain/project-recipes-workflow-contracts.js";
import { workflowPlan } from "./domain/workflow-compiler-plan.js";
import {
  createRuntimeModel, transitionRun, transitionNode, createAttempt, transitionAttempt,
  setAttemptAuthority, recordCompletion, acceptOutcome, type RuntimeModel, type RunRecord,
} from "./domain/workflow-runtime-runtime.js";
import { workflowRuntimeDefinitions, workflowRuntimeRun, type WorkflowRuntimeRequest } from "./workflow-runtime-contracts.js";

export { workflowRuntimeDefinitions } from "./workflow-runtime-contracts.js";

export const WORKFLOW_RUNTIME_DDL = `
CREATE TABLE IF NOT EXISTS workflow_runtime_runs (
  actor_id TEXT NOT NULL, run_id TEXT NOT NULL, version INTEGER NOT NULL,
  snapshot TEXT NOT NULL, PRIMARY KEY(actor_id, run_id)
);
CREATE TABLE IF NOT EXISTS workflow_runtime_events (
  actor_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY(actor_id, run_id, sequence)
);
CREATE TABLE IF NOT EXISTS workflow_runtime_receipts (
  actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  result TEXT NOT NULL, PRIMARY KEY(actor_id, operation_id)
);`;

type Snapshot = {
  run: RunRecord;
  definition: WorkflowDefinitionV1;
  definitionDigest: string;
  executableDigest: string;
  source: unknown;
  models: RuntimeModel[];
};
type Request = WorkflowRuntimeRequest & { actorId: string };
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const terminal = new Set(["succeeded", "failed", "cancelled"]);
const fail = (code: string, message: string): never => { throw new CoreError(code, message); };
export function initializeWorkflowRuntime(db: DatabaseSync): void { db.exec(WORKFLOW_RUNTIME_DDL); }
function actor(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) fail("INVALID_ARGUMENT", "An authenticated actor is required.");
}
function load(db: DatabaseSync, actorId: string, runId: string): Snapshot {
  actor(actorId);
  const row = db.prepare("SELECT snapshot FROM workflow_runtime_runs WHERE actor_id=? AND run_id=?")
    .get(actorId, runId) as { snapshot: string } | undefined;
  if (!row) return fail("NOT_FOUND", "Workflow run not found.");
  return JSON.parse(row.snapshot) as Snapshot;
}
function view(snapshot: Snapshot) {
  return workflowRuntimeRun.parse({
    runId: snapshot.run.runId, version: snapshot.run.version, state: snapshot.run.state,
    executableDigest: snapshot.executableDigest, definitionDigest: snapshot.definitionDigest,
    definition: snapshot.definition, source: snapshot.source, deadline: snapshot.run.deadline,
    nodes: snapshot.models.map(model => ({
      nodeId: model.node.nodeId, state: model.node.state, version: model.node.version,
      ...(model.node.authoritativeAttemptId ? { attemptId: model.node.authoritativeAttemptId } : {}),
    })), execution: "host-only-noop",
  });
}
function command(model: RuntimeModel, key: string, attempt = false) {
  return { commandId: key, fingerprint: digest(key), expected: {
    run: model.run.version, node: model.node.version,
    ...(attempt ? { attempt: model.attempts.find(item => item.attemptId === model.node.currentAttemptId)!.version } : {}),
  } };
}
function changeRun(snapshot: Snapshot, state: RunRecord["state"], key: string) {
  const model = { ...snapshot.models[0], run: snapshot.run } as RuntimeModel;
  const changed = transitionRun(model, command(model, key), state).model;
  snapshot.models[0] = changed;
  snapshot.run = changed.run;
  for (const item of snapshot.models) item.run = { ...snapshot.run };
}
function ready(snapshot: Snapshot): string[] {
  if (snapshot.run.state !== "ready" && snapshot.run.state !== "running") return [];
  const models = new Map(snapshot.models.map(model => [model.node.nodeId, model]));
  return workflowPlan(snapshot.definition, snapshot.definition).order.filter(id => {
    if (models.get(id)!.node.state !== "pending") return false;
    return snapshot.definition.spec.nodes.find(node => node.nodeId === id)!.dependsOn
      .every(edge => edge.accept.includes(models.get(edge.from)!.node.state));
  });
}
function expected(snapshot: Snapshot, version: unknown) {
  if (version !== snapshot.run.version) fail("CONFLICT", "Workflow run version changed.");
}
function event(db: DatabaseSync, actorId: string, snapshot: Snapshot, kind: string, nodeId?: string) {
  const row = db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM workflow_runtime_events WHERE actor_id=? AND run_id=?")
    .get(actorId, snapshot.run.runId) as { next: number };
  const value = { sequence: row.next, kind, version: snapshot.run.version, state: snapshot.run.state,
    ...(nodeId ? { nodeId } : {}) };
  db.prepare("INSERT INTO workflow_runtime_events VALUES(?,?,?,?)")
    .run(actorId, snapshot.run.runId, row.next, JSON.stringify(value));
}
function save(db: DatabaseSync, actorId: string, snapshot: Snapshot, previous: number) {
  const result = db.prepare("UPDATE workflow_runtime_runs SET version=?, snapshot=? WHERE actor_id=? AND run_id=? AND version=?")
    .run(snapshot.run.version, JSON.stringify(snapshot), actorId, snapshot.run.runId, previous);
  if (result.changes !== 1) fail("CONFLICT", "Workflow run compare-and-swap failed.");
}
function atomic<T>(db: DatabaseSync, actorId: string, operationId: string, fingerprint: string, mutate: () => T): T {
  actor(actorId);
  if (!db.isTransaction) fail("INVALID_ARGUMENT", "Workflow mutations require the caller's shared SQLite transaction, including its operation receipt.");
  const prior = db.prepare("SELECT fingerprint,result FROM workflow_runtime_receipts WHERE actor_id=? AND operation_id=?")
    .get(actorId, operationId) as { fingerprint: string; result: string } | undefined;
  if (prior) {
    if (prior.fingerprint !== fingerprint) fail("CONFLICT", "Workflow operationId reused with a different request.");
    return JSON.parse(prior.result) as T;
  }
  db.exec("SAVEPOINT workflow_runtime_mutation");
  try {
    const result = mutate();
    db.prepare("INSERT INTO workflow_runtime_receipts VALUES(?,?,?,?)")
      .run(actorId, operationId, fingerprint, JSON.stringify(result));
    db.exec("RELEASE workflow_runtime_mutation");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO workflow_runtime_mutation; RELEASE workflow_runtime_mutation");
    throw error;
  }
}
function parsed(request: Request) {
  const descriptor = workflowRuntimeDefinitions.find(item => item.id === request.operation);
  if (!descriptor) return fail("NOT_FOUND", "Unknown workflow runtime operation.");
  const args = descriptor.input.safeParse(request.args);
  if (!args.success) return fail("INVALID_ARGUMENT", args.error.message);
  return { descriptor, args: args.data as Record<string, unknown> };
}
export function readWorkflowRuntime(db: DatabaseSync, request: Request): unknown {
  const { descriptor, args } = parsed(request);
  if (!descriptor.readOnly) fail("INVALID_ARGUMENT", "Mutation requires shared transaction dispatch.");
  const snapshot = load(db, request.actorId, String(args.runId));
  if (request.operation === "workflow.run.get") return view(snapshot);
  expected(snapshot, args.expectedVersion);
  if (request.operation === "workflow.run.ready-nodes") return {
    runId: snapshot.run.runId, version: snapshot.run.version, nodes: ready(snapshot),
  };
  const rows = db.prepare("SELECT payload FROM workflow_runtime_events WHERE actor_id=? AND run_id=? AND sequence>? AND json_extract(payload,'$.version')<=? ORDER BY sequence LIMIT ?")
    .all(request.actorId, snapshot.run.runId, Number(args.after), snapshot.run.version, Number(args.limit) + 1) as { payload: string }[];
  const items = rows.slice(0, Number(args.limit)).map(row => JSON.parse(row.payload));
  return descriptor.output.parse({ runId: snapshot.run.runId, version: snapshot.run.version, items,
    nextAfter: rows.length > Number(args.limit) ? items.at(-1).sequence : null });
}
export function mutateWorkflowRuntime(
  root: string, db: DatabaseSync, request: Request, documents: MarkdownRecord[] = [],
): unknown {
  const { descriptor, args } = parsed(request);
  if (descriptor.readOnly) fail("INVALID_ARGUMENT", "Expected a workflow mutation.");
  return atomic(db, request.actorId, String(args.operationId), digest({ operation: request.operation, args }), () => {
    if (request.operation === "workflow.run.create") {
      const compiled = readWorkflowCompiler(root, {
        operation: "workflow.definition.compile", args: { source: args.source },
      }, documents) as { status: string; executableDigest: string; definition: WorkflowDefinitionV1; source: unknown };
      if (compiled.status !== "valid") fail("INVALID_ARGUMENT", "Workflow definition did not compile.");
      if (compiled.executableDigest !== args.expectedExecutableDigest) fail("CONFLICT", "Executable digest does not match the pinned definition.");
      const models = compiled.definition.spec.nodes.map(node =>
        createRuntimeModel(String(args.runId), node.nodeId, Number(args.deadline), Number(args.deadline)));
      const snapshot: Snapshot = {
        run: { ...models[0]!.run }, definition: compiled.definition, source: compiled.source,
        executableDigest: compiled.executableDigest, definitionDigest: digest(compiled.definition), models,
      };
      const supported = compiled.definition.spec.nodes.every(node => node.kind === "pkm.step.noop/v1"
        && (!node.control || node.control.mode === "single") && !node.dependsOn.some(edge => edge.loop || edge.fromOutput || edge.toInput));
      changeRun(snapshot, "validating", "create:validating");
      changeRun(snapshot, supported ? "ready" : "blocked", "create:compiled");
      if (db.prepare("SELECT 1 FROM workflow_runtime_runs WHERE actor_id=? AND run_id=?").get(request.actorId, args.runId as string)) {
        fail("CONFLICT", "Workflow run identity already exists.");
      }
      db.prepare("INSERT INTO workflow_runtime_runs VALUES(?,?,?,?)")
        .run(request.actorId, snapshot.run.runId, snapshot.run.version, JSON.stringify(snapshot));
      event(db, request.actorId, snapshot, "created");
      return view(snapshot);
    }
    const snapshot = load(db, request.actorId, String(args.runId));
    expected(snapshot, args.expectedVersion);
    if (terminal.has(snapshot.run.state)) fail("CONFLICT", "Terminal workflow runs are immutable.");
    const previous = snapshot.run.version;
    changeRun(snapshot, "cancelling", `${args.operationId}:cancelling`);
    snapshot.models = snapshot.models.map(model => terminal.has(model.node.state) ? model
      : transitionNode(model, command(model, `${args.operationId}:node:${model.node.nodeId}`), "cancelled").model);
    changeRun(snapshot, "cancelled", `${args.operationId}:cancelled`);
    save(db, request.actorId, snapshot, previous);
    event(db, request.actorId, snapshot, "cancelled");
    return view(snapshot);
  });
}

/**
 * Trusted host-only, atomic in-process noop execution. This is intentionally not a
 * capability definition: callers cannot submit a successful native/tool result.
 * No external adapter may execute inside this transaction.
 */
export function advanceWorkflowNoop(db: DatabaseSync, input: {
  actorId: string; operationId: string; runId: string; expectedVersion: number; nodeId: string; now: number;
}): z.infer<typeof workflowRuntimeRun> {
  if (!Number.isFinite(input.now) || !/^[0-9a-f-]{36}$/i.test(input.operationId)) fail("INVALID_ARGUMENT", "Invalid host command.");
  return atomic(db, input.actorId, input.operationId, digest({ hostNoop: input }), () => {
    const snapshot = load(db, input.actorId, input.runId);
    expected(snapshot, input.expectedVersion);
    if (!ready(snapshot).includes(input.nodeId)) fail("CONFLICT", "Node is not ready for deterministic noop execution.");
    const previous = snapshot.run.version;
    if (snapshot.run.state === "ready") changeRun(snapshot, "running", `${input.operationId}:running`);
    let model = snapshot.models.find(item => item.node.nodeId === input.nodeId)!;
    const apply = (result: { model: RuntimeModel }) => { model = result.model; };
    const key = (part: string, attempt = false) => command(model, `${input.operationId}:${part}`, attempt);
    if (input.now > snapshot.run.deadline) {
      apply(transitionNode(model, key("blocked"), "blocked"));
      apply(transitionNode(model, key("failed"), "failed"));
      snapshot.models[snapshot.models.findIndex(item => item.node.nodeId === input.nodeId)] = model;
      changeRun(snapshot, "failed", `${input.operationId}:deadline`);
    } else {
      apply(createAttempt(model, key("attempt"), { attemptId: `${input.runId}:${input.nodeId}:1`,
        executionDeadline: snapshot.run.deadline, evidenceDeadline: snapshot.run.deadline, leaseFence: 1, mode: "initial" }));
      apply(transitionAttempt(model, key("admitted", true), "admitted", 1));
      apply(setAttemptAuthority(model, key("authority", true), 1, true, false, "none"));
      apply(transitionAttempt(model, key("executing", true), "executing", 1));
      apply(recordCompletion(model, key("completion", true), 1, input.now));
      apply(transitionAttempt(model, key("outcome", true), "awaiting-outcome", 1));
      apply(acceptOutcome(model, key("accept", true), `noop:${snapshot.executableDigest}:${input.nodeId}`, "succeeded", 1, input.now));
      snapshot.models[snapshot.models.findIndex(item => item.node.nodeId === input.nodeId)] = model;
      const complete = snapshot.definition.spec.completion.requiredNodes.every(id =>
        snapshot.models.find(item => item.node.nodeId === id)!.node.state === "succeeded");
      if (complete) changeRun(snapshot, "succeeded", `${input.operationId}:succeeded`);
      else {
        snapshot.run = { ...snapshot.run, version: snapshot.run.version + 1 };
        for (const item of snapshot.models) item.run = { ...snapshot.run };
      }
    }
    save(db, input.actorId, snapshot, previous);
    event(db, input.actorId, snapshot, "step-result", input.nodeId);
    return view(snapshot);
  });
}
