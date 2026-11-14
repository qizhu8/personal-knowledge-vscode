import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { managerPlanDefinitionHash, validateManagerCompletionContract, validateManagerPlan, type ManagerPlanValidation } from "./manager-plan.js";
import { relativeToolPath } from "./domain/manager-plan-original.js";
import {
  managerRuntimeStart, managerRuntimeFeedback, managerRuntimeCancel, managerRuntimeGet, managerRuntimeEvents,
  type ManagerRuntimeStart, type ManagerRuntimeFeedback, type ManagerRuntimeCancel,
} from "./manager-runtime-contracts.js";

export { managerRuntimeDefinitions, createManagerRuntimeDefinitions } from "./manager-runtime-contracts.js";
export class ManagerRuntimeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const fail = (code: string, message: string): never => { throw new ManagerRuntimeError(code, message); };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = (value: unknown) => JSON.stringify(value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const taskSchema = z.object({
  taskId: identifier, title: z.string().min(1).max(256), objective: z.string().min(1).max(8192),
  phase: z.enum(["worker", "integrator", "verifier", "repair"]), dependsOn: z.array(identifier).max(1024),
  readScope: z.array(z.string().max(4000)).max(256), writeScope: z.array(z.string().max(4000)).max(16),
  resources: z.array(z.string().max(4000)).max(16),
}).passthrough();
const deliverySchema = z.strictObject({
  artifact: z.string().min(1).max(1024), pin: digest, workerId: identifier,
  paths: z.array(z.string().min(1).max(512)).max(100),
});
const checkSchema = z.strictObject({
  ok: z.boolean(), reason: z.string().max(4096).optional(), taskId: identifier.optional(),
  pin: digest.optional(),
});
const freezeSchema = z.strictObject({ pin: digest });
type PlanTask = z.infer<typeof taskSchema>;
type Delivery = z.infer<typeof deliverySchema>;
type Check = z.infer<typeof checkSchema>;
type Budget = ManagerRuntimeStart["budget"];
type Effect = { id: string; kind: string; leaseUntil: number };
type Attempt = { attemptId: string; number: number; state: string; effect: Effect; effects: Effect[]; delivery?: Delivery; publications?: Delivery[]; reason?: string };
type Task = { definition: PlanTask; definitionHash: string; state: string; owner: string | null; attempts: Attempt[]; repairReason?: string };
type Feedback = { id: string; taskId?: string; message: string; urgent: boolean; state: "queued" | "delivered" };
export interface ManagerRun {
  schema: "pkm.manager.runtime/v1"; runId: string; projectId: string; version: number;
  state: "active" | "succeeded" | "paused" | "cancelled" | "unknown" | "failed";
  phase: string; contract: unknown; budget: Budget; plan: unknown | null; planHash: string | null;
  tasks: Task[]; checks: { kind: string; result: Check; pin?: string }[];
  feedback: Feedback[]; effect: Effect | null; freeze: string | null; integration: string | null;
  lastSequence: number; createdAt: number; updatedAt: number; reason: string | null;
  lastHeartbeatAt?: number;
}
export interface ManagerOwner { actorId: string; nativeOwnerId: string }
export interface ManagerEvent {
  seq: number; runId: string; version: number; type: string; time: number; data: Record<string, unknown>;
}
export type ManagerPlanResult = ManagerPlanValidation;
export interface ManagerRuntimeHost {
  resolveOwner(token: object): ManagerOwner | undefined;
  authorizeTask(owner: Readonly<ManagerOwner>, task: Readonly<PlanTask>, planHash: string): boolean;
  /** Must use the canonical Manager plan validator; never accepts a caller's fabricated plan. */
  plan(input: Readonly<{ owner: ManagerOwner; runId: string; contract: unknown; budget: Budget; effectId: string }>, signal: AbortSignal): Promise<ManagerPlanResult>;
  worker(input: Readonly<{ owner: ManagerOwner; runId: string; task: PlanTask; attemptId: string; workerId?: string; repairReason?: string;
    feedback: string[]; effectId: string;
    publish(update: { grade: "draft" | "selfReport" | "delivery"; delivery: Delivery }): void }>, signal: AbortSignal): Promise<Delivery>;
  validate(input: Readonly<{ owner: ManagerOwner; runId: string; task: PlanTask; attemptId: string; delivery: Delivery; effectId: string }>, signal: AbortSignal): Promise<Check>;
  freeze(input: Readonly<{ owner: ManagerOwner; runId: string; deliveries: { taskId: string; attemptId: string; delivery: Delivery }[]; effectId: string }>, signal: AbortSignal): Promise<{ pin: string }>;
  integrate(input: Readonly<{ owner: ManagerOwner; runId: string; freeze: string; effectId: string }>, signal: AbortSignal): Promise<Check>;
  verify(input: Readonly<{ owner: ManagerOwner; runId: string; contract: unknown; freeze: string; integration: string; effectId: string }>, signal: AbortSignal): Promise<Check>;
  cancel?(input: Readonly<{ owner: ManagerOwner; runId: string; effectId: string }>): Promise<void>;
  reconcile?(input: Readonly<{ owner: ManagerOwner; runId: string; effectId: string; kind: string }>, signal: AbortSignal):
    Promise<{ status: "unknown" | "not-executed" }>;
}
export function initializeManagerRuntimeSchema(db: DatabaseSync): void {
  if (!db.isTransaction) fail("TRANSACTION_REQUIRED", "Manager schema belongs to the parent migration transaction.");
  db.exec(`
    CREATE TABLE IF NOT EXISTS manager_runtime_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
    INSERT OR IGNORE INTO manager_runtime_schema VALUES(1,1);
    CREATE TABLE IF NOT EXISTS manager_runtime_runs(actor_id TEXT NOT NULL,owner_id TEXT NOT NULL,run_id TEXT NOT NULL,version INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(actor_id,owner_id,run_id));
    CREATE TABLE IF NOT EXISTS manager_runtime_events(actor_id TEXT NOT NULL,owner_id TEXT NOT NULL,run_id TEXT NOT NULL,seq INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(actor_id,owner_id,run_id,seq));
    CREATE TABLE IF NOT EXISTS manager_runtime_receipts(actor_id TEXT NOT NULL,owner_id TEXT NOT NULL,operation_id TEXT NOT NULL,fingerprint TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(actor_id,owner_id,operation_id));
  `);
  if (db.prepare("SELECT version FROM manager_runtime_schema WHERE singleton=1").get()?.version !== 1) fail("UNSUPPORTED_SCHEMA", "Unsupported Manager schema.");
}

/**
 * Native-only coordinator. All effects start after a committed intent. Never invoke
 * host adapters inside SQLite transactions; interrupted effects are not replayed.
 */
export function createManagerRuntime(db: DatabaseSync, options: {
  host: ManagerRuntimeHost; now?: () => number; leaseMs?: number; assertOwner?: () => void;
  onMutation?: (input: { owner: ManagerOwner; operationId: string; operation: string; args: unknown; result: ManagerRun }) => void;
}) {
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? 300_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 86_400_000) fail("INVALID_CONFIGURATION", "Invalid lease.");
  const running = new Set<string>();
  const tasks = new Set<Promise<void>>();
  const effects = new Set<Promise<unknown>>();
  const aborts = new Map<string, AbortController>();
  const heartbeatTimers = new Set<ReturnType<typeof setInterval>>();
  let closed = false;
  function outside() {
    if (db.isTransaction) fail("TRANSACTION_BOUNDARY", "Manager coordinator requires no enclosing transaction.");
    options.assertOwner?.();
  }
  function owner(token: object): ManagerOwner {
    outside();
    if (!token || typeof token !== "object") fail("UNAUTHORIZED", "Native owner token required.");
    const value = options.host.resolveOwner(token);
    if (!value || ![value.actorId, value.nativeOwnerId].every(v => typeof v === "string" && v.length > 0 && v.length <= 160 && !/[\u0000-\u001f]/.test(v))) {
      return fail("UNAUTHORIZED", "Native owner token was not issued by this host.");
    }
    return { ...value };
  }
  function atomic<T>(fn: () => T): T {
    outside(); db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); options.assertOwner?.(); db.exec("COMMIT"); return result; }
    catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  }
  function load(o: ManagerOwner, id: string): ManagerRun {
    const row = db.prepare("SELECT version,record FROM manager_runtime_runs WHERE actor_id=? AND owner_id=? AND run_id=?").get(o.actorId, o.nativeOwnerId, id);
    if (!row) return fail("NOT_FOUND", "Owned Manager run not found.");
    const run = JSON.parse(String(row.record)) as ManagerRun;
    if (run.schema !== "pkm.manager.runtime/v1" || run.runId !== id || run.version !== row.version) fail("STATE_CORRUPT", "Manager run index mismatch.");
    return run;
  }
  function event(o: ManagerOwner, run: ManagerRun, type: string, data: Record<string, unknown> = {}) {
    run.version++; run.updatedAt = now(); run.lastSequence++;
    if (run.state === "active") run.lastHeartbeatAt = run.updatedAt;
    const value: ManagerEvent = { seq: run.lastSequence, runId: run.runId, version: run.version, type, time: run.updatedAt, data };
    db.prepare("INSERT INTO manager_runtime_events VALUES(?,?,?,?,?)").run(o.actorId, o.nativeOwnerId, run.runId, value.seq, json(value));
  }
  function save(o: ManagerOwner, run: ManagerRun, expected: number) {
    if (Buffer.byteLength(json(run)) > 2_000_000) fail("LIMIT_EXCEEDED", "Manager state exceeds its durable boundary.");
    const updated = db.prepare("UPDATE manager_runtime_runs SET version=?,record=? WHERE actor_id=? AND owner_id=? AND run_id=? AND version=?")
      .run(run.version, json(run), o.actorId, o.nativeOwnerId, run.runId, expected);
    if (updated.changes !== 1) fail("REVISION_CONFLICT", "Manager version changed.");
  }
  function mutate(o: ManagerOwner, operation: string, input: { operationId: string }, fn: () => ManagerRun) {
    return atomic(() => {
      const fingerprint = hash({ operation, input });
      const prior = db.prepare("SELECT fingerprint,record FROM manager_runtime_receipts WHERE actor_id=? AND owner_id=? AND operation_id=?")
        .get(o.actorId, o.nativeOwnerId, input.operationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail("CONFLICT", "Operation id already belongs to a different request.");
        return JSON.parse(String(prior.record)) as ManagerRun;
      }
      const result = fn();
      options.onMutation?.({ owner: o, operationId: input.operationId, operation, args: input, result });
      db.prepare("INSERT INTO manager_runtime_receipts VALUES(?,?,?,?,?)").run(o.actorId, o.nativeOwnerId, input.operationId, fingerprint, json(result));
      return result;
    });
  }
  function effect(kind: string): Effect { return { id: randomUUID(), kind, leaseUntil: now() + leaseMs }; }
  function later(o: ManagerOwner, id: string) {
    const key = json([o.actorId, o.nativeOwnerId, id]);
    if (closed || running.has(key)) return;
    running.add(key);
    queueMicrotask(() => {
      const heartbeat = setInterval(() => {
        try {
          atomic(() => {
            const run = load(o, id), old = run.version;
            if (closed || run.state !== "active") return;
            event(o, run, "heartbeat"); save(o, run, old);
          });
        } catch { /* Lost native ownership must not publish freshness. */ }
      }, 10_000);
      heartbeat.unref(); heartbeatTimers.add(heartbeat);
      const task = drive(o, id).catch(() => {
        try {
          atomic(() => {
            const run = load(o, id), old = run.version;
            if (run.state !== "active") return;
            run.state = "paused"; run.reason = "Native scheduler failed; inspect durable effects before recovery.";
            event(o, run, "run.paused", { reason: run.reason }); save(o, run, old);
          });
        } catch { /* The parent owns connection and lease failures. */ }
      }).finally(() => { clearInterval(heartbeat); heartbeatTimers.delete(heartbeat); running.delete(key); tasks.delete(task); });
      tasks.add(task);
    });
  }
  async function invoke<T>(e: Effect, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (closed) throw new Error("Manager is closing.");
    const controller = new AbortController(); aborts.set(e.id, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const remaining = e.leaseUntil - now();
      if (remaining <= 0) throw new Error("effect lease expired");
      const operation = Promise.resolve().then(() => call(controller.signal));
      effects.add(operation);
      void operation.finally(() => effects.delete(operation)).catch(() => undefined);
      const result = await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("effect lease expired")); }, remaining);
          controller.signal.addEventListener("abort", () => reject(new Error("effect aborted")), { once: true });
        }),
      ]);
      if (now() >= e.leaseUntil) throw new Error("effect lease expired");
      return result;
    } finally { if (timer) clearTimeout(timer); aborts.delete(e.id); }
  }
  function unknown(o: ManagerOwner, id: string, e: Effect) {
    atomic(() => {
      const run = load(o, id), old = run.version;
      const attempt = run.tasks.flatMap(t => t.attempts).find(a => a.effect.id === e.id && a.state === "running");
      if (run.state !== "active" || (run.effect?.id !== e.id && !attempt)) return;
      if (attempt) attempt.state = "unknown";
      run.state = "unknown"; run.reason = "Native effect outcome is unknown; reconciliation is required.";
      event(o, run, "effect.unknown", { effectId: e.id, kind: e.kind }); save(o, run, old);
    });
  }
  function validatePlan(result: Extract<ManagerPlanResult, { status: "ready" }>, run: ManagerRun) {
    if (result?.status !== "ready" || !result.plan || result.plan.schema !== "pkm.manager.plan/v1"
      || !digest.safeParse(result.definitionHash).success || managerPlanDefinitionHash(result.plan.contract) !== managerPlanDefinitionHash(run.contract)
      || managerPlanDefinitionHash(result.plan.budget) !== managerPlanDefinitionHash(run.budget) || !Array.isArray(result.plan.tasks)) fail("INVALID_PLAN", "Native planner did not return the pinned contract and budget.");
    const validated = validateManagerPlan(result.plan);
    if (validated.status !== "ready" || validated.definitionHash !== result.definitionHash
      || managerPlanDefinitionHash(validated.taskDefinitionHashes) !== managerPlanDefinitionHash(result.taskDefinitionHashes)) {
      fail("INVALID_PLAN", "Native plan did not pass the canonical validator or has incorrect pins.");
    }
    const tasks = result.plan.tasks.map(t => taskSchema.parse(t));
    if (!tasks.length || tasks.length > run.budget.maxTasks || tasks.filter(t => t.phase === "worker").length > run.budget.maxWorkers
      || !tasks.some(t => t.phase === "worker") || run.budget.maxConcurrentWorkers > run.budget.maxWorkers) fail("INVALID_PLAN", "Plan exceeds worker or task bounds.");
    const ids = new Set(tasks.map(t => t.taskId));
    if (ids.size !== tasks.length || tasks.some(t => t.dependsOn.some(d => !ids.has(d) || d === t.taskId)
      || !digest.safeParse(result.taskDefinitionHashes[t.taskId]).success)) fail("INVALID_PLAN", "Plan task identities or pins are invalid.");
    return tasks;
  }
  function startPlan(o: ManagerOwner, id: string) {
    return atomic(() => {
      const run = load(o, id), old = run.version;
      if (run.state !== "active" || run.phase !== "planning" || run.effect) return null;
      const e = effect("plan"); run.effect = e; event(o, run, "plan.intent", { effectId: e.id, leaseUntil: e.leaseUntil }); save(o, run, old);
      return { run, e };
    });
  }
  async function planning(o: ManagerOwner, id: string) {
    const claim = startPlan(o, id); if (!claim) return;
    try {
      const result = await invoke(claim.e, signal => options.host.plan({ owner: o, runId: id, contract: claim.run.contract, budget: claim.run.budget, effectId: claim.e.id }, signal));
      atomic(() => {
        const run = load(o, id), old = run.version;
        if (run.state !== "active" || run.effect?.id !== claim.e.id) return;
        if (result.status !== "ready") {
          run.state = "paused"; run.effect = null;
          run.reason = result.status === "needsClarification" ? "Completion contract needs clarification." : "Planner returned an invalid plan.";
          event(o, run, result.status === "needsClarification" ? "plan.clarification" : "plan.invalid",
            result.status === "needsClarification" ? { questions: result.questions } : { errors: result.errors });
          save(o, run, old); return;
        }
        const tasks = validatePlan(result, run);
        if (tasks.some(task => options.host.authorizeTask(o, task, result.definitionHash) !== true)) fail("INVALID_PLAN", "Native task authorization denied.");
        run.plan = result.plan; run.planHash = result.definitionHash;
        run.tasks = tasks.map(t => ({ definition: t, definitionHash: result.taskDefinitionHashes[t.taskId],
          state: t.phase === "worker" ? "pending" : t.phase === "repair" ? "conditional" : "planned", owner: null, attempts: [] }));
        const general = run.feedback.filter(f => !f.taskId);
        run.feedback = run.feedback.filter(f => f.taskId);
        for (const f of general) for (const task of tasks.filter(t => t.phase === "worker")) run.feedback.push({ ...f, taskId: task.taskId });
        run.effect = null; run.phase = "working";
        event(o, run, "plan.ready", { planHash: result.definitionHash, tasks: tasks.length }); save(o, run, old);
      });
    } catch (error) {
      if (error instanceof ManagerRuntimeError && error.code === "INVALID_PLAN") {
        atomic(() => {
          const run = load(o, id), old = run.version;
          if (run.state !== "active" || run.effect?.id !== claim.e.id) return;
          run.state = "paused"; run.effect = null; run.reason = error.message;
          event(o, run, "plan.invalid", { reason: error.message }); save(o, run, old);
        });
      } else unknown(o, id, claim.e);
    }
  }
  function claimWorkers(o: ManagerOwner, id: string) {
    return atomic(() => {
      const run = load(o, id), old = run.version;
      if (run.state !== "active" || run.phase !== "working") return [];
      const workers = run.tasks.filter(t => t.definition.phase === "worker");
      const slots = run.budget.maxConcurrentWorkers - workers.filter(t => t.state === "running").length;
      const claims: { task: PlanTask; attemptId: string; e: Effect; workerId: string | null; repairReason?: string; feedback: string[] }[] = [];
      for (const task of workers) {
        if (claims.length >= slots) break;
        if (task.state !== "pending" || task.definition.dependsOn.some(dep => run.tasks.find(t => t.definition.taskId === dep)?.state !== "accepted")) continue;
        if (task.attempts.length >= run.budget.maxAttemptsPerTask) {
          task.state = "blocked";
          run.state = "paused"; run.reason = "Task attempt budget exhausted.";
          event(o, run, "budget.exhausted", { taskId: task.definition.taskId }); break;
        }
        const e = effect("worker"), attemptId = randomUUID();
        if (task.repairReason) for (const repair of run.tasks.filter(t => t.definition.phase === "repair" && t.state === "pending")) repair.state = "running";
        const messages = run.feedback.filter(f => f.state === "queued" && (!f.taskId || f.taskId === task.definition.taskId));
        messages.forEach(f => { f.state = "delivered"; });
        task.state = "running"; task.attempts.push({ attemptId, number: task.attempts.length + 1, state: "running", effect: e, effects: [e] });
        claims.push({ task: task.definition, attemptId, e, workerId: task.owner, repairReason: task.repairReason, feedback: messages.map(f => f.message) });
        event(o, run, "worker.intent", { taskId: task.definition.taskId, attemptId, effectId: e.id, leaseUntil: e.leaseUntil });
      }
      if (run.version !== old) save(o, run, old);
      return claims;
    });
  }
  async function worker(o: ManagerOwner, id: string, claim: ReturnType<typeof claimWorkers>[number]) {
    let activeEffect = claim.e;
    try {
      const delivery = deliverySchema.parse(await invoke(claim.e, signal => options.host.worker({
        owner: o, runId: id, task: claim.task, attemptId: claim.attemptId, effectId: claim.e.id,
        ...(claim.workerId ? { workerId: claim.workerId } : {}),
        ...(claim.repairReason ? { repairReason: claim.repairReason } : {}), feedback: claim.feedback,
        publish(update) {
          const grade = z.enum(["draft", "selfReport", "delivery"]).parse(update.grade);
          const delivery = deliverySchema.parse(update.delivery);
          atomic(() => {
            const run = load(o, id), old = run.version;
            const task = run.tasks.find(t => t.definition.taskId === claim.task.taskId);
            const attempt = task?.attempts.find(a => a.attemptId === claim.attemptId);
            if (!task || !attempt || closed || run.state !== "active" || task.state !== "running" || attempt.state !== "running"
              || attempt.effect.id !== claim.e.id || now() >= claim.e.leaseUntil || aborts.get(claim.e.id)?.signal.aborted) {
              fail("STALE_EFFECT", "Worker update no longer owns the current effect.");
            }
            if (!task || !attempt) return fail("STALE_EFFECT", "Worker attempt is missing.");
            if (task.owner && task.owner !== delivery.workerId) fail("INVALID_EVIDENCE", "Worker update owner changed.");
            if (!delivery.paths.every(path => relativeToolPath(path) === path && claim.task.writeScope.some(scope =>
              path === scope || path.startsWith(scope.endsWith("/") ? scope : scope + "/")))) fail("INVALID_EVIDENCE", "Worker update exceeds scope.");
            if ((attempt.publications?.length ?? 0) >= 100) fail("LIMIT_EXCEEDED", "Worker publication budget exhausted.");
            task.owner = delivery.workerId; attempt.delivery = delivery;
            (attempt.publications ??= []).push(delivery);
            event(o, run, grade === "selfReport" ? "worker.self-report" : grade === "draft" ? "worker.draft" : "worker.delivery",
              { taskId: task.definition.taskId, attemptId: attempt.attemptId, workerId: delivery.workerId, artifact: delivery.artifact, pin: delivery.pin });
            save(o, run, old);
          });
        },
      }, signal)));
      const validationEffect = atomic(() => {
        const run = load(o, id), old = run.version, task = run.tasks.find(t => t.definition.taskId === claim.task.taskId);
        const attempt = task?.attempts.find(a => a.attemptId === claim.attemptId);
        if (run.state !== "active" || task?.state !== "running" || attempt?.state !== "running") return null;
        if (task.owner && task.owner !== delivery.workerId) fail("INVALID_EVIDENCE", "Worker delivery is not from the pinned task owner.");
        task.owner = delivery.workerId;
        attempt.delivery = delivery;
        event(o, run, "worker.delivery", { taskId: claim.task.taskId, attemptId: claim.attemptId, workerId: delivery.workerId, artifact: delivery.artifact, pin: delivery.pin });
        const validation = effect("validate"); attempt.effect = validation; attempt.effects.push(validation);
        event(o, run, "worker.validation.intent", { taskId: claim.task.taskId, attemptId: claim.attemptId, effectId: validation.id, leaseUntil: validation.leaseUntil });
        save(o, run, old);
        return validation;
      });
      if (!validationEffect) return;
      activeEffect = validationEffect;
      const scoped = delivery.paths.every(path => {
        try {
          return relativeToolPath(path) === path
            && claim.task.writeScope.some(scope => path === scope || path.startsWith(scope.endsWith("/") ? scope : scope + "/"));
        } catch { return false; }
      });
      const checked = scoped ? checkSchema.parse(await invoke(validationEffect, signal => options.host.validate({
        owner: o, runId: id, task: claim.task, attemptId: claim.attemptId, delivery, effectId: validationEffect.id,
      }, signal))) : { ok: false, reason: "Delivery exceeds declared write scope." };
      if (checked.ok && checked.pin !== delivery.pin) fail("INVALID_EVIDENCE", "Delivery validation must pin the exact delivered artifact.");
      atomic(() => {
        const run = load(o, id), old = run.version, task = run.tasks.find(t => t.definition.taskId === claim.task.taskId);
        const attempt = task?.attempts.find(a => a.attemptId === claim.attemptId);
        if (run.state !== "active" || task?.state !== "running" || attempt?.state !== "running" || attempt.effect.id !== validationEffect.id) return;
        attempt.state = checked.ok ? "accepted" : "rejected"; attempt.reason = checked.reason;
        const queued = run.feedback.some(f => f.state === "queued" && (!f.taskId || f.taskId === task.definition.taskId));
        task.state = checked.ok && !queued ? "accepted" : "pending";
        task.repairReason = queued ? "Apply queued feedback at this checkpoint." : checked.ok ? undefined : checked.reason ?? "Delivery validation failed.";
        if (!checked.ok) for (const repair of run.tasks.filter(t => t.definition.phase === "repair")) repair.state = "pending";
        if (checked.ok && !queued && run.tasks.filter(t => t.definition.phase === "worker").every(t => t.state === "accepted")) {
          for (const repair of run.tasks.filter(t => t.definition.phase === "repair" && t.state === "running")) repair.state = "accepted";
        }
        run.checks.push({ kind: "delivery", result: checked, pin: delivery.pin });
        event(o, run, "worker.checked", { taskId: task.definition.taskId, attemptId: claim.attemptId, ok: checked.ok, pin: delivery.pin });
        save(o, run, old);
      });
    } catch { unknown(o, id, activeEffect); }
  }
  function claimPhase(o: ManagerOwner, id: string, phase: string) {
    return atomic(() => {
      const run = load(o, id), old = run.version;
      if (run.state !== "active" || run.phase !== phase || run.effect) return null;
      const e = effect(phase); run.effect = e;
      const stage = phase === "integrating" ? "integrator" : phase === "verifying" ? "verifier" : undefined;
      if (stage) for (const task of run.tasks.filter(t => t.definition.phase === stage)) task.state = "running";
      event(o, run, `${phase}.intent`, { effectId: e.id, leaseUntil: e.leaseUntil }); save(o, run, old);
      return { run, e };
    });
  }
  async function phaseEffect(o: ManagerOwner, id: string, phase: "freezing" | "integrating" | "verifying") {
    const claim = claimPhase(o, id, phase); if (!claim) return;
    try {
      const result = await invoke<Check | { pin: string }>(claim.e, signal => {
        if (phase === "freezing") {
          const deliveries = claim.run.tasks.filter(t => t.definition.phase === "worker").map(t => {
            const attempt = t.attempts.at(-1)!;
            return { taskId: t.definition.taskId, attemptId: attempt.attemptId, delivery: attempt.delivery! };
          });
          return options.host.freeze({ owner: o, runId: id, deliveries, effectId: claim.e.id }, signal);
        }
        if (phase === "integrating") return options.host.integrate({ owner: o, runId: id, freeze: claim.run.freeze!, effectId: claim.e.id }, signal);
        return options.host.verify({ owner: o, runId: id, contract: claim.run.contract, freeze: claim.run.freeze!,
          integration: claim.run.integration!, effectId: claim.e.id }, signal);
      });
      atomic(() => {
        const run = load(o, id), old = run.version;
        if (run.state !== "active" || run.effect?.id !== claim.e.id) return;
        run.effect = null;
        if (phase === "freezing") {
          const frozen = freezeSchema.parse(result); run.freeze = frozen.pin; run.integration = null; run.phase = "integrating";
          event(o, run, "freeze.ready", { pin: frozen.pin });
        } else {
          const checked = checkSchema.parse(result);
          const stageTasks = run.tasks.filter(t => t.definition.phase === (phase === "integrating" ? "integrator" : "verifier"));
          for (const task of stageTasks) task.state = checked.ok ? "accepted" : "blocked";
          run.checks.push({ kind: phase === "integrating" ? "integration" : "e2e", result: checked, pin: run.freeze! });
          if (checked.ok) {
            if (!checked.pin) fail("INVALID_EVIDENCE", "Successful native check must pin its output.");
            if (phase === "integrating") { run.integration = checked.pin!; run.phase = "verifying"; }
            else {
              run.state = "succeeded"; run.phase = "succeeded";
              for (const task of run.tasks.filter(t => t.definition.phase === "repair" && t.state === "conditional")) task.state = "skipped";
            }
          } else {
            const task = run.tasks.find(t => t.definition.phase === "worker" && t.definition.taskId === checked.taskId);
            if (!task) { run.state = "paused"; run.reason = "Verification failure has no exact worker owner."; }
            else {
              task.state = "pending"; task.repairReason = checked.reason ?? "Integration verification failed.";
              for (const stage of run.tasks.filter(t => t.definition.phase === "integrator" || t.definition.phase === "verifier")) stage.state = "planned";
              for (const repair of run.tasks.filter(t => t.definition.phase === "repair")) repair.state = "pending";
              run.freeze = null; run.integration = null; run.phase = "working";
            }
          }
          event(o, run, phase === "integrating" ? "integration.checked" : "e2e.checked",
            { ok: checked.ok, ...(checked.taskId ? { taskId: checked.taskId } : {}), ...(checked.pin ? { pin: checked.pin } : {}) });
        }
        save(o, run, old);
      });
    } catch { unknown(o, id, claim.e); }
  }
  async function drive(o: ManagerOwner, id: string) {
    const pending = new Set<Promise<void>>();
    for (let steps = 0; steps < 250_000; steps++) {
      const run = load(o, id);
      if (closed || run.state !== "active") { await Promise.all(pending); return; }
      if (run.phase === "planning") {
        if (run.effect) return;
        await planning(o, id); continue;
      }
      if (run.phase === "working") {
        const claims = claimWorkers(o, id);
        for (const claim of claims) {
          const promise = worker(o, id, claim).finally(() => pending.delete(promise));
          pending.add(promise);
        }
        if (pending.size) { await Promise.race(pending); continue; }
        const changed = atomic(() => {
          const current = load(o, id), old = current.version;
          if (current.state !== "active" || current.phase !== "working") return false;
          const workers = current.tasks.filter(t => t.definition.phase === "worker");
          if (workers.some(t => t.state === "running")) return false;
          if (workers.every(t => t.state === "accepted") && !current.feedback.some(f => f.state === "queued")) {
            current.phase = "freezing"; event(o, current, "workers.ready"); save(o, current, old); return true;
          }
          current.state = "paused"; current.reason = "Tasks are blocked, interrupted, or have undelivered feedback.";
          event(o, current, "run.paused", { reason: current.reason }); save(o, current, old); return false;
        });
        if (!changed) return;
        continue;
      }
      if (run.phase === "freezing" || run.phase === "integrating" || run.phase === "verifying") {
        if (run.effect) return;
        await phaseEffect(o, id, run.phase); continue;
      }
      return;
    }
    atomic(() => {
      const run = load(o, id), old = run.version;
      if (run.state === "active") {
        run.state = "paused"; run.reason = "Scheduler step limit reached.";
        event(o, run, "run.paused", { reason: run.reason }); save(o, run, old);
      }
    });
  }
  function cancelEffects(o: ManagerOwner, run: ManagerRun, taskId?: string) {
    const selectedEffects = [
      ...(!taskId && run.effect ? [run.effect] : []),
      ...run.tasks.filter(t => !taskId || t.definition.taskId === taskId)
        .flatMap(t => t.attempts.filter(a => a.state === "running" || a.state === "unknown").map(a => a.effect)),
    ];
    for (const e of selectedEffects) {
      aborts.get(e.id)?.abort();
      if (options.host.cancel) {
        const cancellation = options.host.cancel({ owner: o, runId: run.runId, effectId: e.id });
        effects.add(cancellation);
        void cancellation.finally(() => effects.delete(cancellation)).catch(() => undefined);
      }
    }
  }
  return {
    get(token: object, input: unknown): ManagerRun {
      const o = owner(token), parsed = managerRuntimeGet.parse(input);
      return load(o, parsed.runId);
    },
    events(token: object, input: unknown): { items: ManagerEvent[]; nextSeq: number } {
      const o = owner(token), parsed = managerRuntimeEvents.parse(input), run = load(o, parsed.runId);
      if (parsed.afterSeq > run.lastSequence) fail("INVALID_CURSOR", "Event cursor is beyond the durable run.");
      const rows = db.prepare("SELECT record FROM manager_runtime_events WHERE actor_id=? AND owner_id=? AND run_id=? AND seq>? ORDER BY seq LIMIT ?")
        .all(o.actorId, o.nativeOwnerId, parsed.runId, parsed.afterSeq, parsed.limit);
      const items = rows.map(row => JSON.parse(String(row.record)) as ManagerEvent);
      return { items, nextSeq: items.at(-1)?.seq ?? parsed.afterSeq };
    },
    start(token: object, value: ManagerRuntimeStart): ManagerRun {
      if (closed) fail("NOT_AVAILABLE", "Manager is closing.");
      const o = owner(token), input = managerRuntimeStart.parse(value);
      if (validateManagerCompletionContract(input.contract).status !== "ready") fail("INVALID_INPUT", "A complete Manager contract is required before planning.");
      if (input.budget.maxConcurrentWorkers > input.budget.maxWorkers) fail("INVALID_INPUT", "Concurrent workers exceed worker budget.");
      const result = mutate(o, "start", input, () => {
        const at = now();
        const run: ManagerRun = { schema: "pkm.manager.runtime/v1", runId: input.runId, projectId: input.projectId,
          version: 0, state: "active", phase: "planning", contract: input.contract, budget: input.budget,
          plan: null, planHash: null, tasks: [], checks: [], feedback: [], effect: null, freeze: null, integration: null,
          lastSequence: 0, createdAt: at, updatedAt: at, reason: null };
        event(o, run, "run.started");
        try { db.prepare("INSERT INTO manager_runtime_runs VALUES(?,?,?,?,?)").run(o.actorId, o.nativeOwnerId, input.runId, run.version, json(run)); }
        catch { fail("CONFLICT", "Manager run identity already exists."); }
        return run;
      });
      later(o, input.runId); return result;
    },
    feedback(token: object, value: ManagerRuntimeFeedback): ManagerRun {
      const o = owner(token), input = managerRuntimeFeedback.parse(value);
      const result = mutate(o, "feedback", input, () => {
        const run = load(o, input.runId), old = run.version;
        if (old !== input.expectedVersion) fail("REVISION_CONFLICT", "Manager version changed.");
        if (run.state !== "active" && !(run.state === "paused" && (input.goal !== undefined || input.budget !== undefined))) fail("INVALID_STATE", "Manager run is not active or awaiting a clarified contract.");
        const task = input.taskId ? run.tasks.find(t => t.definition.taskId === input.taskId && t.definition.phase === "worker") : undefined;
        if (input.taskId && !task) fail("NOT_FOUND", "Worker task not found.");
        if (run.feedback.length + Math.max(1, run.tasks.length) > 10_000) fail("LIMIT_EXCEEDED", "Feedback limit reached.");
        const targets = input.taskId ? [input.taskId] : run.tasks.filter(t => t.definition.phase === "worker").map(t => t.definition.taskId);
        for (const target of targets.length ? targets : [undefined]) {
          run.feedback.push({ id: input.operationId, ...(target ? { taskId: target } : {}), message: input.message, urgent: input.urgent, state: "queued" });
        }
        if (input.goal !== undefined || input.budget !== undefined) {
          run.state = "paused"; run.reason = "Goal or budget changed; replanning and new evidence are required.";
          if (input.goal !== undefined) run.contract = input.goal;
          if (input.budget) run.budget = input.budget;
          run.freeze = null; run.integration = null; run.checks = [];
          if (!run.effect && !run.tasks.some(t => t.attempts.some(a => ["running", "unknown"].includes(a.state)))
            && validateManagerCompletionContract(run.contract).status === "ready"
            && run.budget.maxConcurrentWorkers <= run.budget.maxWorkers) {
            run.plan = null; run.planHash = null; run.tasks = []; run.phase = "planning"; run.state = "active"; run.reason = null;
          }
        } else if (run.effect && run.phase !== "planning") {
          run.state = "paused"; run.reason = "Feedback interrupted a native effect; reconcile before replanning.";
          run.freeze = null; run.integration = null; run.checks = [];
        } else if (input.urgent) {
          if (!task) { run.state = "paused"; run.reason = "Urgent correction requires native reconciliation."; }
          else {
            if (task.state === "running") {
              task.state = "unknown";
              const attempt = task.attempts.at(-1);
              if (attempt) attempt.state = "unknown";
            } else task.state = "pending";
            run.freeze = null; run.integration = null; run.phase = "working";
          }
        } else {
          for (const selected of run.tasks.filter(t => t.definition.phase === "worker" && (!input.taskId || t.definition.taskId === input.taskId))) {
            if (selected.state === "accepted") {
              selected.state = "pending"; selected.repairReason = "Apply queued feedback.";
              run.freeze = null; run.integration = null; run.phase = "working";
            }
          }
        }
        event(o, run, "feedback.queued", { feedbackId: input.operationId, ...(input.taskId ? { taskId: input.taskId } : {}), urgent: input.urgent });
        save(o, run, old); return run;
      });
      if (input.urgent || input.goal !== undefined || input.budget !== undefined || result.state === "paused") cancelEffects(o, result, input.urgent && result.state !== "paused" && input.goal === undefined && input.budget === undefined ? input.taskId : undefined);
      later(o, input.runId); return result;
    },
    cancel(token: object, value: ManagerRuntimeCancel): ManagerRun {
      const o = owner(token), input = managerRuntimeCancel.parse(value);
      const result = mutate(o, "cancel", input, () => {
        const run = load(o, input.runId), old = run.version;
        if (old !== input.expectedVersion) fail("REVISION_CONFLICT", "Manager version changed.");
        if (run.state === "succeeded" || run.state === "cancelled") fail("INVALID_STATE", "Manager run is terminal.");
        run.state = "cancelled"; run.phase = "cancelled";
        event(o, run, "run.cancelled", { effectsMayBeUnknown: true }); save(o, run, old); return run;
      });
      cancelEffects(o, result); return result;
    },
    /** Native restart hook: never respawns a possibly executed effect. */
    recover(token: object, input: unknown): ManagerRun {
      const o = owner(token), parsed = managerRuntimeGet.parse(input);
      return atomic(() => {
        const run = load(o, parsed.runId), old = run.version;
        if (run.state === "active") {
          const inFlight = run.effect || run.tasks.some(t => t.attempts.some(a => a.state === "running"));
          run.state = inFlight ? "unknown" : "paused";
          run.reason = inFlight ? "Interrupted native effect requires reconciliation." : "Interrupted run requires explicit native recovery.";
          event(o, run, "run.recovered", { unknownEffects: !!inFlight }); save(o, run, old);
        }
        return run;
      });
    },
    /** Host-only: replay only effects positively confirmed never to have executed. */
    async reconcile(token: object, input: unknown): Promise<ManagerRun> {
      const o = owner(token), parsed = managerRuntimeGet.parse(input);
      if (!options.host.reconcile) fail("NOT_AVAILABLE", "Native effect reconciliation is not configured.");
      const current = load(o, parsed.runId);
      if (running.has(json([o.actorId, o.nativeOwnerId, parsed.runId]))) fail("BUSY", "Manager is still running.");
      if (!["unknown", "paused"].includes(current.state)) fail("INVALID_STATE", "Manager does not need reconciliation.");
      const interrupted = [
        ...(current.effect ? [current.effect] : []),
        ...current.tasks.flatMap(t => t.attempts.filter(a => ["running", "unknown"].includes(a.state)).map(a => a.effect)),
      ];
      const decisions = await Promise.all(interrupted.map(async e => {
        const status = await options.host.reconcile!({ owner: o, runId: current.runId, effectId: e.id, kind: e.kind }, new AbortController().signal);
        return { e, status: z.enum(["unknown", "not-executed"]).parse(status.status) };
      }));
      return atomic(() => {
        const run = load(o, parsed.runId), old = run.version;
        if (old !== current.version) fail("REVISION_CONFLICT", "Manager changed during reconciliation.");
        if (decisions.some(d => d.status === "unknown")) {
          run.state = "unknown"; run.reason = "Native host cannot determine interrupted effects.";
        } else {
          for (const { e } of decisions) {
            if (run.effect?.id === e.id) run.effect = null;
            for (const task of run.tasks) {
              const attempt = task.attempts.find(a => a.effect.id === e.id);
              if (attempt) { attempt.state = "not-executed"; task.state = "pending"; }
            }
          }
          run.state = "paused"; run.reason = "Reconciled native effects; explicit trusted resume is required.";
        }
        event(o, run, "run.reconciled", { unknownEffects: run.state === "unknown" }); save(o, run, old); return run;
      });
    },
    resume(token: object, input: unknown): ManagerRun {
      const o = owner(token);
      const parsed = z.strictObject({ runId: identifier, expectedVersion: z.number().int().positive().safe() }).parse(input);
      const result = atomic(() => {
        const run = load(o, parsed.runId), old = run.version;
        if (old !== parsed.expectedVersion) fail("REVISION_CONFLICT", "Manager version changed.");
        if (closed || run.state !== "paused" || run.effect
          || run.tasks.some(t => t.attempts.some(a => ["running", "unknown"].includes(a.state)))) fail("INVALID_STATE", "Unresolved effects cannot be resumed.");
        if (validateManagerCompletionContract(run.contract).status !== "ready") fail("INVALID_INPUT", "Completion requires clarification.");
        if (!run.plan || run.phase === "planning" || run.reason?.startsWith("Goal or budget changed")) {
          run.plan = null; run.planHash = null; run.tasks = []; run.phase = "planning"; run.freeze = null; run.integration = null;
        }
        run.state = "active"; run.reason = null;
        event(o, run, "run.resumed"); save(o, run, old); return run;
      });
      later(o, parsed.runId); return result;
    },
    async close(): Promise<void> {
      closed = true;
      for (const timer of heartbeatTimers) clearInterval(timer);
      heartbeatTimers.clear();
      for (const controller of aborts.values()) controller.abort();
      await Promise.allSettled([...tasks, ...effects]);
      while (effects.size) await Promise.allSettled([...effects]);
    },
  };
}
