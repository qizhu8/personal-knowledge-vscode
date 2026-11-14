import { createHash } from "node:crypto";
import { z } from "zod";
import type { ManagerPlanBudget } from "../manager-plan.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().safe().positive();
const nonnegative = z.number().int().safe().nonnegative();
const timestamp = z.string().datetime();
const managerPlanBudget = z.object({
  maxWorkers: positive,
  maxConcurrentWorkers: positive,
  maxTasks: positive,
  maxAttemptsPerTask: positive,
});

export const managerProgressOverviewRequestSchema = z.strictObject({ runId: id });
export const managerProgressEventsRequestSchema = z.strictObject({
  runId: id,
  afterSeq: nonnegative.optional(),
  cursor: z.string().min(8).max(512).optional(),
  limit: positive.max(100).default(50),
}).refine(value => !(value.cursor !== undefined && value.afterSeq !== undefined), "Choose cursor or afterSeq.");
const feedbackTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("run") }),
  z.strictObject({ kind: z.literal("task"), taskId: id }),
  z.strictObject({ kind: z.literal("result"), taskId: id, attemptId: id, resultId: id }),
]);
export const managerProgressFeedbackRequestSchema = z.strictObject({
  operationId: z.string().uuid(),
  runId: id,
  expectedVersion: positive,
  target: feedbackTargetSchema,
  message: z.string().trim().min(1).max(8192)
    .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "Feedback contains unsupported control characters."),
});

const taskViewSchema = z.strictObject({
  taskId: id,
  title: z.string().min(1).max(256),
  phase: z.enum(["worker", "integrator", "verifier", "repair"]),
  state: z.enum(["doing", "completed", "remaining", "blocked"]),
  attemptId: id.optional(),
});
const blockerSchema = z.strictObject({
  id: z.string().min(1).max(160),
  kind: z.enum(["task", "run", "budget", "effect"]),
  taskId: id.optional(),
  label: z.string().min(1).max(160),
});
export const managerProgressOverviewSchema = z.strictObject({
  schema: z.literal("pkm.manager.progress/v1"),
  runId: id,
  projectId: id,
  version: positive,
  state: z.enum(["active", "succeeded", "paused", "cancelled", "unknown", "failed"]),
  phase: z.strictObject({ id: z.string().min(1).max(80), label: z.string().min(1).max(120) }),
  doing: z.array(taskViewSchema).max(1024),
  completed: z.array(taskViewSchema).max(1024),
  remaining: z.array(taskViewSchema).max(1024),
  blockers: z.array(blockerSchema).max(1024),
  budget: managerPlanBudget,
  updatedAt: timestamp,
  lastHeartbeatAt: timestamp.nullable(),
  freshness: z.enum(["fresh", "stale", "unknown"]),
});

export const managerProgressResultSchema = z.strictObject({
  id,
  summary: z.string().min(1).max(160),
  taskId: id.optional(),
  attemptId: id.optional(),
  artifact: z.strictObject({
    id,
    sourcePin: z.strictObject({ algorithm: z.literal("sha256"), value: digest }),
  }),
  verificationGrade: z.enum(["draft", "selfReport", "delivery", "module", "integration", "e2e", "accepted"]),
  verificationStatus: z.enum(["pending", "passed", "failed"]),
  scope: z.enum(["task", "run"]),
});
export const managerProgressEventSchema = z.strictObject({
  schema: z.literal("pkm.manager.progress.event/v1"),
  eventId: id,
  sequence: positive,
  cursor: z.string().min(8).max(512),
  time: timestamp,
  kind: z.enum(["result", "progress", "phase", "blocker", "error", "heartbeat", "feedback", "status"]),
  taskId: id.optional(),
  attemptId: id.optional(),
  result: managerProgressResultSchema.optional(),
  code: z.enum(["budget-exhausted", "effect-unknown", "run-paused", "task-check-failed", "integration-failed", "e2e-failed"]).optional(),
  critical: z.boolean(),
  coalescedFromSeq: positive.optional(),
});
const eventGapSchema = z.strictObject({ fromSeq: positive, toSeq: positive });
export const managerProgressEventsResponseSchema = z.strictObject({
  schema: z.literal("pkm.manager.progress.events/v1"),
  runId: id,
  events: z.array(managerProgressEventSchema).max(100),
  nextSeq: nonnegative,
  nextCursor: z.string().min(8).max(512),
  hasMore: z.boolean(),
  gaps: z.array(eventGapSchema).max(100),
  lastHeartbeatAt: timestamp.nullable(),
  freshness: z.enum(["fresh", "stale", "unknown"]),
});
export const managerProgressFeedbackReceiptSchema = z.strictObject({
  schema: z.literal("pkm.manager.progress.feedback-receipt/v1"),
  feedbackId: z.string().uuid(),
  runId: id,
  target: feedbackTargetSchema,
  status: z.literal("applied"),
  version: positive,
  receivedAt: timestamp,
});

export const managerProgressDefinitions = [
  { id: "manager.progress.get", readOnly: true, input: managerProgressOverviewRequestSchema, output: managerProgressOverviewSchema,
    description: "Read a trusted-owner, versioned Manager overview with evidence-backed task state and no percentage estimates." },
  { id: "manager.progress.events", readOnly: true, input: managerProgressEventsRequestSchema, output: managerProgressEventsResponseSchema,
    description: "Read ordered, run-scoped result and progress events using an exclusive reconnect cursor." },
  { id: "manager.progress.feedback", readOnly: false, input: managerProgressFeedbackRequestSchema, output: managerProgressFeedbackReceiptSchema,
    description: "Validate and queue ordinary feedback for an exact run, task or pinned result; actor authority comes from the native host." },
] as const;

export type ManagerProgressOverview = z.infer<typeof managerProgressOverviewSchema>;
export type ManagerProgressEvent = z.infer<typeof managerProgressEventSchema>;
export type ManagerProgressEventsResponse = z.infer<typeof managerProgressEventsResponseSchema>;
export type ManagerProgressFeedbackRequest = z.infer<typeof managerProgressFeedbackRequestSchema>;
export type ManagerProgressFeedbackReceipt = z.infer<typeof managerProgressFeedbackReceiptSchema>;
export type ManagerProgressFeedbackTarget = z.infer<typeof feedbackTargetSchema>;
export type ManagerProgressVerificationGrade = NonNullable<ManagerProgressEvent["result"]>["verificationGrade"];

const runtimeAttemptSchema = z.object({
  attemptId: id,
  number: positive,
  state: z.string().min(1).max(40),
  delivery: z.object({ artifact: z.string().min(1).max(1024), pin: digest }).passthrough().optional(),
  publications: z.array(z.object({ artifact: z.string().min(1).max(1024), pin: digest }).passthrough()).max(100).optional(),
}).passthrough();
const runtimeTaskSchema = z.object({
  definition: z.object({
    taskId: id,
    title: z.string().min(1).max(256),
    phase: z.enum(["worker", "integrator", "verifier", "repair"]),
  }).passthrough(),
  state: z.string().min(1).max(40),
  attempts: z.array(runtimeAttemptSchema).max(100),
}).passthrough();
const runtimeRunSchema = z.object({
  schema: z.literal("pkm.manager.runtime/v1"),
  runId: id,
  projectId: id,
  version: positive,
  state: z.enum(["active", "succeeded", "paused", "cancelled", "unknown", "failed"]),
  phase: z.string().min(1).max(80),
  budget: managerPlanBudget,
  tasks: z.array(runtimeTaskSchema).max(1024),
  checks: z.array(z.object({
    kind: z.string().min(1).max(40),
    result: z.object({ ok: z.boolean(), pin: digest.optional() }).passthrough(),
    pin: digest.optional(),
  }).passthrough()).max(2048).optional(),
  freeze: digest.nullable().optional(),
  integration: digest.nullable().optional(),
  lastSequence: nonnegative,
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  lastHeartbeatAt: z.union([z.number().finite().nonnegative(), timestamp]).optional(),
}).passthrough();
const runtimeEventSchema = z.object({
  seq: positive,
  runId: id,
  version: positive,
  type: z.string().min(1).max(80),
  time: z.number().finite().nonnegative(),
  data: z.record(z.string(), z.unknown()),
}).passthrough();
const runtimeEventPageSchema = z.object({
  items: z.array(runtimeEventSchema).max(100),
  nextSeq: nonnegative,
}).passthrough();

export interface ManagerProgressRuntimeReader {
  get(token: object, input: { runId: string }): unknown | Promise<unknown>;
  events(token: object, input: { runId: string; afterSeq: number; limit: number }): unknown | Promise<unknown>;
  feedback(token: object, input: {
    operationId: string; runId: string; expectedVersion: number; taskId?: string; message: string; urgent: false;
  }): unknown | Promise<unknown>;
  subscribeEvents?(token: object, input: { runId: string; afterSeq: number }, listener: (event: unknown) => void): () => void;
}

export class ManagerProgressError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const fail = (code: string, message: string): never => { throw new ManagerProgressError(code, message); };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const toIso = (value: number | string): string => {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("INVALID_TIMESTAMP", "Manager runtime supplied an invalid timestamp.");
  return date.toISOString();
};

export function managerProgressFreshness(
  lastHeartbeatAt: number | string | null | undefined,
  now = Date.now(),
  staleAfterMs = 30_000,
): { lastHeartbeatAt: string | null; freshness: "fresh" | "stale" | "unknown" } {
  if (!Number.isFinite(now) || !Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1) {
    fail("INVALID_CONFIGURATION", "Heartbeat freshness requires a finite clock and positive stale interval.");
  }
  if (lastHeartbeatAt === null || lastHeartbeatAt === undefined) return { lastHeartbeatAt: null, freshness: "stale" };
  const time = typeof lastHeartbeatAt === "number" ? lastHeartbeatAt : Date.parse(lastHeartbeatAt);
  if (!Number.isFinite(time) || time > now) return { lastHeartbeatAt: null, freshness: "unknown" };
  return { lastHeartbeatAt: toIso(time), freshness: now - time <= staleAfterMs ? "fresh" : "stale" };
}

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    planning: "Planning", working: "Working", freezing: "Freezing results",
    integrating: "Integrating", verifying: "End-to-end verification", succeeded: "Accepted",
    paused: "Paused", failed: "Failed", cancelled: "Cancelled", unknown: "Needs reconciliation",
  };
  return labels[phase] ?? "Manager active";
}

function taskState(state: string): "doing" | "completed" | "remaining" | "blocked" {
  if (state === "running") return "doing";
  if (state === "accepted" || state === "succeeded" || state === "completed") return "completed";
  if (state === "blocked") return "blocked";
  return "remaining";
}

function managerRun(value: unknown, runId: string) {
  const parsed = runtimeRunSchema.safeParse(value);
  if (!parsed.success) return fail("INVALID_RUNTIME_RECORD", "Manager runtime returned an invalid run record.");
  if (parsed.data.runId !== runId) fail("RUN_SCOPE_MISMATCH", "Manager runtime returned a different run.");
  return parsed.data;
}

function taskViews(run: z.infer<typeof runtimeRunSchema>) {
  return run.tasks.filter(task => !["conditional", "skipped"].includes(task.state)).map(task => ({
    taskId: task.definition.taskId,
    title: task.definition.title,
    phase: task.definition.phase,
    state: taskState(task.state),
    ...(task.attempts.at(-1)?.attemptId ? { attemptId: task.attempts.at(-1)!.attemptId } : {}),
  }));
}

function projectOverview(run: z.infer<typeof runtimeRunSchema>, now: number, staleAfterMs: number): ManagerProgressOverview {
  const tasks = taskViews(run);
  const blockers: ManagerProgressOverview["blockers"] = [];
  for (const task of tasks) if (task.state === "blocked") {
    blockers.push({ id: `task-${task.taskId}`, kind: "task", taskId: task.taskId, label: "Task is blocked" });
  }
  if (run.state === "paused") blockers.push({ id: "run-paused", kind: "run", label: "Run is paused" });
  if (run.state === "unknown") blockers.push({ id: "effect-unknown", kind: "effect", label: "Run requires reconciliation" });
  if (run.state === "failed") blockers.push({ id: "run-failed", kind: "run", label: "Run failed" });
  if (run.state === "active" && run.phase === "budget-exhausted") {
    blockers.push({ id: "budget-exhausted", kind: "budget", label: "Run budget is exhausted" });
  }
  const heartbeat = managerProgressFreshness(run.lastHeartbeatAt, now, staleAfterMs);
  return managerProgressOverviewSchema.parse({
    schema: "pkm.manager.progress/v1",
    runId: run.runId,
    projectId: run.projectId,
    version: run.version,
    state: run.state,
    phase: { id: run.phase, label: phaseLabel(run.phase) },
    doing: tasks.filter(task => task.state === "doing"),
    completed: tasks.filter(task => task.state === "completed"),
    remaining: tasks.filter(task => task.state === "remaining"),
    blockers,
    budget: run.budget,
    updatedAt: toIso(run.updatedAt),
    lastHeartbeatAt: heartbeat.lastHeartbeatAt,
    freshness: heartbeat.freshness,
  });
}

type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
type RuntimeRun = z.infer<typeof runtimeRunSchema>;

function cursorFor(run: RuntimeRun, sequence: number): string {
  return `mpc1.${Buffer.from(JSON.stringify({ runId: run.runId, projectId: run.projectId, sequence }), "utf8").toString("base64url")}`;
}

function sequenceFromCursor(cursor: string, run: RuntimeRun): number {
  if (!cursor.startsWith("mpc1.")) fail("INVALID_CURSOR", "Manager progress cursor is malformed.");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor.slice(5), "base64url").toString("utf8")); }
  catch { return fail("INVALID_CURSOR", "Manager progress cursor is malformed."); }
  const parsed = z.strictObject({ runId: id, projectId: id, sequence: nonnegative }).safeParse(value);
  if (!parsed.success || parsed.data.runId !== run.runId || parsed.data.projectId !== run.projectId) {
    return fail("INVALID_CURSOR", "Manager progress cursor belongs to a different run or project.");
  }
  return parsed.data.sequence;
}

function eventTask(run: RuntimeRun, taskId: unknown, attemptId: unknown) {
  if (typeof taskId !== "string" || typeof attemptId !== "string") return undefined;
  const task = run.tasks.find(item => item.definition.taskId === taskId);
  const attempt = task?.attempts.find(item => item.attemptId === attemptId);
  return task && attempt ? { task, attempt } : undefined;
}

function stableResultId(runId: string, taskId: string, attemptId: string, pin: string) {
  return `result-${sha256(`${runId}:${taskId}:${attemptId}:${pin}`).slice(0, 40)}`;
}

function outputEvent(run: RuntimeRun, event: RuntimeEvent): ManagerProgressEvent {
  const common = {
    schema: "pkm.manager.progress.event/v1" as const,
    eventId: `event-${sha256(`${run.runId}:${event.seq}`).slice(0, 40)}`,
    sequence: event.seq,
    cursor: cursorFor(run, event.seq),
    time: toIso(event.time),
  };
  const { type, data } = event;
  const taskId = typeof data.taskId === "string" ? data.taskId : undefined;
  const attemptId = typeof data.attemptId === "string" ? data.attemptId : undefined;
  const taskAttempt = eventTask(run, taskId, attemptId);
  const pin = typeof data.pin === "string" && digest.safeParse(data.pin).success ? data.pin : undefined;
  if (type === "worker.delivery" || type === "worker.checked" || type === "worker.self-report" || type === "worker.draft") {
    const delivery = taskAttempt && taskAttempt.attempt.delivery?.pin === pin ? taskAttempt.attempt.delivery
      : taskAttempt?.attempt.publications?.find(item => item.pin === pin && (type !== "worker.delivery" || item.artifact === data.artifact));
    if (!taskAttempt || !pin || delivery?.pin !== pin
      || type === "worker.delivery" && (typeof data.artifact !== "string" || data.artifact !== delivery.artifact)) {
      return managerProgressEventSchema.parse({ ...common, kind: "status", taskId, attemptId, critical: false });
    }
    const grade = type === "worker.delivery" ? "delivery"
      : type === "worker.checked" ? "module" : type === "worker.self-report" ? "selfReport" : "draft";
    const verificationStatus = type === "worker.delivery" ? "pending"
      : type === "worker.checked" ? data.ok === true ? "passed" : "failed" : "pending";
    const artifactId = `artifact-${sha256(`${run.runId}:${taskId}:${attemptId}:${pin}`).slice(0, 40)}`;
    const resultId = stableResultId(run.runId, taskId!, attemptId!, pin);
    return managerProgressEventSchema.parse({
      ...common,
      kind: "result",
      taskId,
      attemptId,
      result: {
        id: resultId,
        summary: grade === "delivery" ? "Worker delivered an artifact" : grade === "module" ? "Artifact validation recorded" : "Unverified worker update",
        taskId,
        attemptId,
        artifact: { id: artifactId, sourcePin: { algorithm: "sha256", value: pin } },
        verificationGrade: grade,
        verificationStatus,
        scope: "task",
      },
      critical: type === "worker.checked" && data.ok === false,
      ...(type === "worker.checked" && data.ok === false ? { code: "task-check-failed" as const } : {}),
    });
  }
  if (type === "integration.checked" || type === "e2e.checked") {
    const ok = data.ok === true;
    const highLevelPin = pin;
    const checkKind = type === "integration.checked" ? "integration" : "e2e";
    const verifiedCheck = run.checks?.some(check => check.kind === checkKind && check.result.ok === ok
      && (check.result.pin === highLevelPin || check.pin === highLevelPin));
    if (!highLevelPin || !verifiedCheck) return managerProgressEventSchema.parse({
      ...common,
      kind: ok ? "status" : "error",
      critical: !ok,
      ...(!ok ? { code: checkKind === "integration" ? "integration-failed" as const : "e2e-failed" as const } : {}),
    });
    const grade = type === "integration.checked" ? "integration" : ok && run.state === "succeeded" ? "accepted" : "e2e";
    const resultId = `result-${sha256(`${run.runId}:${checkKind}:${highLevelPin}`).slice(0, 40)}`;
    const highLevelTask = taskAttempt ? { taskId, attemptId } : {};
    return managerProgressEventSchema.parse({
      ...common,
      kind: "result",
      ...highLevelTask,
      result: {
        id: resultId,
        summary: type === "integration.checked" ? "Integration verification recorded" : "End-to-end verification recorded",
        ...highLevelTask,
        artifact: { id: `artifact-${sha256(`${run.runId}:${highLevelPin}`).slice(0, 40)}`, sourcePin: { algorithm: "sha256", value: highLevelPin } },
        verificationGrade: grade,
        verificationStatus: ok ? "passed" : "failed",
        scope: taskAttempt ? "task" : "run",
      },
      critical: !ok,
      ...(!ok ? { code: type === "integration.checked" ? "integration-failed" as const : "e2e-failed" as const } : {}),
    });
  }
  if (type === "run.paused") {
    return managerProgressEventSchema.parse({ ...common, kind: "blocker", critical: true, code: "run-paused" });
  }
  if (type === "budget.exhausted") {
    return managerProgressEventSchema.parse({ ...common, kind: "blocker", taskId, critical: true, code: "budget-exhausted" });
  }
  if (type === "effect.unknown") {
    return managerProgressEventSchema.parse({ ...common, kind: "error", critical: true, code: "effect-unknown" });
  }
  if (type === "heartbeat") return managerProgressEventSchema.parse({ ...common, kind: "heartbeat", critical: false });
  if (type === "feedback.queued") return managerProgressEventSchema.parse({ ...common, kind: "feedback", taskId, critical: false });
  if (type.includes("failed") || type.includes("error")) {
    return managerProgressEventSchema.parse({ ...common, kind: "error", taskId, critical: true });
  }
  if (type.endsWith(".intent") || type === "worker.intent" || type === "workers.ready") {
    const knownTaskId = run.tasks.some(task => task.definition.taskId === taskId) ? taskId : undefined;
    const safeAttemptId = attemptId && id.safeParse(attemptId).success ? attemptId : undefined;
    return managerProgressEventSchema.parse({ ...common, kind: "progress", taskId: knownTaskId, attemptId: safeAttemptId, critical: false });
  }
  if (type.startsWith("run.")) return managerProgressEventSchema.parse({ ...common, kind: "status", critical: false });
  return managerProgressEventSchema.parse({ ...common, kind: "phase", critical: false });
}

function immediateCriticalEvent(run: RuntimeRun, event: RuntimeEvent): ManagerProgressEvent {
  const taskId = typeof event.data.taskId === "string"
    && run.tasks.some(task => task.definition.taskId === event.data.taskId) ? event.data.taskId : undefined;
  const attemptId = typeof taskId === "string" && typeof event.data.attemptId === "string"
    && run.tasks.some(task => task.definition.taskId === taskId && task.attempts.some(attempt => attempt.attemptId === event.data.attemptId))
    ? event.data.attemptId : undefined;
  if (event.type === "worker.checked" && event.data.ok === false) {
    return managerProgressEventSchema.parse({
      schema: "pkm.manager.progress.event/v1",
      eventId: `event-${sha256(`${run.runId}:${event.seq}`).slice(0, 40)}`,
      sequence: event.seq,
      cursor: cursorFor(run, event.seq),
      time: toIso(event.time),
      kind: "error",
      taskId,
      attemptId,
      code: "task-check-failed",
      critical: true,
    });
  }
  const projected = outputEvent(run, event);
  if (projected.critical) return projected;
  return managerProgressEventSchema.parse({
    schema: "pkm.manager.progress.event/v1",
    eventId: `event-${sha256(`${run.runId}:${event.seq}`).slice(0, 40)}`,
    sequence: event.seq,
    cursor: cursorFor(run, event.seq),
    time: toIso(event.time),
    kind: "error",
    taskId,
    attemptId,
    critical: true,
  });
}

function isCriticalRuntimeEvent(event: RuntimeEvent): boolean {
  return event.type === "run.paused" || event.type === "budget.exhausted" || event.type === "effect.unknown"
    || event.type.includes("failed") || event.type.includes("error")
    || event.type === "worker.checked" && event.data.ok === false
    || (event.type === "integration.checked" || event.type === "e2e.checked") && event.data.ok === false;
}

function orderedUniqueEvents(run: RuntimeRun, value: unknown, afterSeq: number) {
  const parsed = runtimeEventPageSchema.safeParse(value);
  if (!parsed.success) return fail("INVALID_EVENT_PAGE", "Manager runtime returned an invalid event page.");
  if (parsed.data.nextSeq < afterSeq) fail("INVALID_EVENT_PAGE", "Manager event cursor moved backwards.");
  if (parsed.data.items.some(event => event.runId !== run.runId)) {
    fail("RUN_SCOPE_MISMATCH", "Manager runtime returned an event from a different run.");
  }
  const sorted = parsed.data.items
    .filter(event => event.seq > afterSeq)
    .sort((a, b) => a.seq - b.seq);
  const unique: RuntimeEvent[] = [];
  const seen = new Set<number>();
  for (const event of sorted) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    unique.push(event);
  }
  const gaps: Array<{ fromSeq: number; toSeq: number }> = [];
  let expected = afterSeq + 1;
  for (const event of unique) {
    if (event.seq > expected) gaps.push({ fromSeq: expected, toSeq: event.seq - 1 });
    expected = event.seq + 1;
  }
  if (parsed.data.nextSeq >= expected && parsed.data.nextSeq > afterSeq) {
    gaps.push({ fromSeq: expected, toSeq: parsed.data.nextSeq });
  }
  const nextSeq = parsed.data.nextSeq;
  if (nextSeq > run.lastSequence) fail("INVALID_EVENT_PAGE", "Manager event page is newer than its run.");
  if (unique.length && nextSeq < unique.at(-1)!.seq) fail("INVALID_EVENT_PAGE", "Manager event page cursor precedes its final event.");
  return { items: unique.map(event => outputEvent(run, event)), nextSeq, gaps };
}

export function coalesceManagerProgressEvents(events: readonly ManagerProgressEvent[]): ManagerProgressEvent[] {
  const progressByTask = new Map<string, ManagerProgressEvent>();
  const retained: ManagerProgressEvent[] = [];
  for (const event of events) {
    if (event.kind !== "progress" || event.critical) {
      retained.push(event);
      continue;
    }
    const key = event.taskId ?? "project";
    const previous = progressByTask.get(key);
    progressByTask.set(key, previous
      ? { ...event, coalescedFromSeq: previous.coalescedFromSeq ?? previous.sequence }
      : event);
  }
  return [...retained, ...progressByTask.values()].sort((a, b) => a.sequence - b.sequence);
}

function heartbeatFromPage(run: RuntimeRun, events: RuntimeEvent[]) {
  let last: number | string | null | undefined = run.lastHeartbeatAt;
  for (const event of events) if (event.type === "heartbeat") {
    const priorTime = typeof last === "string" ? Date.parse(last) : last ?? -Infinity;
    if (event.time > priorTime) last = event.time;
  }
  return last;
}

export class ManagerProgressService {
  private readonly runtime: ManagerProgressRuntimeReader;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  constructor(runtime: ManagerProgressRuntimeReader, options: { now?: () => number; staleAfterMs?: number } = {}) {
    this.runtime = runtime;
    this.now = options.now ?? Date.now;
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
    if (!Number.isSafeInteger(this.staleAfterMs) || this.staleAfterMs < 1) fail("INVALID_CONFIGURATION", "Heartbeat stale interval must be positive.");
  }

  async overview(token: object, input: unknown): Promise<ManagerProgressOverview> {
    const request = managerProgressOverviewRequestSchema.parse(input);
    const run = managerRun(await this.runtime.get(token, { runId: request.runId }), request.runId);
    return projectOverview(run, this.now(), this.staleAfterMs);
  }

  async events(token: object, input: unknown): Promise<ManagerProgressEventsResponse> {
    const request = managerProgressEventsRequestSchema.parse(input);
    let run = managerRun(await this.runtime.get(token, { runId: request.runId }), request.runId);
    const afterSeq = request.cursor ? sequenceFromCursor(request.cursor, run) : request.afterSeq ?? 0;
    if (afterSeq > run.lastSequence) fail("INVALID_CURSOR", "Manager progress cursor is ahead of the run.");
    const rawValue = await this.runtime.events(token, {
      runId: request.runId, afterSeq, limit: request.limit,
    });
    const raw = runtimeEventPageSchema.parse(rawValue);
    if (Math.max(raw.nextSeq, ...raw.items.map(event => event.seq)) > run.lastSequence) {
      run = managerRun(await this.runtime.get(token, { runId: request.runId }), request.runId);
    }
    const page = orderedUniqueEvents(run, raw, afterSeq);
    const heartbeat = managerProgressFreshness(heartbeatFromPage(run, raw.items), this.now(), this.staleAfterMs);
    const nextCursor = cursorFor(run, page.nextSeq);
    return managerProgressEventsResponseSchema.parse({
      schema: "pkm.manager.progress.events/v1",
      runId: run.runId,
      events: coalesceManagerProgressEvents(page.items),
      nextSeq: page.nextSeq,
      nextCursor,
      hasMore: page.nextSeq < run.lastSequence,
      gaps: page.gaps,
      lastHeartbeatAt: heartbeat.lastHeartbeatAt,
      freshness: heartbeat.freshness,
    });
  }

  async subscribeEvents(token: object, input: unknown, listener: (message: ManagerProgressEvent | { kind: "gap"; fromSeq: number; toSeq: number }) => void): Promise<() => void> {
    const request = managerProgressEventsRequestSchema.parse(input);
    const subscribeEvents = this.runtime.subscribeEvents;
    if (!subscribeEvents) return fail("LIVE_SUBSCRIPTION_UNAVAILABLE", "A live Manager event source is not configured; no polling fallback is used.");
    const run = managerRun(await this.runtime.get(token, { runId: request.runId }), request.runId);
    let lastSequence = request.cursor ? sequenceFromCursor(request.cursor, run) : request.afterSeq ?? 0;
    if (lastSequence > run.lastSequence) fail("INVALID_CURSOR", "Manager progress cursor is ahead of the run.");
    let active = true;
    const pending = new Map<string, ManagerProgressEvent>();
    let scheduled = false;
    let chain = Promise.resolve();
    const flush = () => {
      scheduled = false;
      const values = [...pending.values()].sort((a, b) => a.sequence - b.sequence);
      pending.clear();
      for (const value of values) if (active) listener(value);
    };
    const unsubscribe = subscribeEvents.call(this.runtime, token, { runId: request.runId, afterSeq: lastSequence }, raw => {
      if (!active) return;
      const event = runtimeEventSchema.safeParse(raw);
      if (!event.success || event.data.runId !== request.runId || event.data.seq <= lastSequence) return;
      if (event.data.seq > lastSequence + 1) listener({ kind: "gap", fromSeq: lastSequence + 1, toSeq: event.data.seq - 1 });
      lastSequence = event.data.seq;
      if (isCriticalRuntimeEvent(event.data)) {
        flush();
        listener(immediateCriticalEvent(run, event.data));
        return;
      }
      if (event.data.type.endsWith(".intent") || event.data.type === "worker.intent" || event.data.type === "workers.ready") {
        const projected = outputEvent(run, event.data);
        const key = projected.taskId ?? "project";
        const prior = pending.get(key);
        pending.set(key, prior ? { ...projected, coalescedFromSeq: prior.coalescedFromSeq ?? prior.sequence } : projected);
        if (pending.size >= 100) flush();
        else if (!scheduled) { scheduled = true; queueMicrotask(flush); }
        return;
      }
      chain = chain.then(async () => {
        if (!active) return;
        const currentRun = managerRun(await this.runtime.get(token, { runId: request.runId }), request.runId);
        const projected = outputEvent(currentRun, event.data);
        if (projected.kind !== "progress" || projected.critical) {
          flush();
          listener(projected);
          return;
        }
        const key = projected.taskId ?? "project";
        const prior = pending.get(key);
        pending.set(key, prior ? { ...projected, coalescedFromSeq: prior.coalescedFromSeq ?? prior.sequence } : projected);
        if (pending.size >= 100) flush();
        else if (!scheduled) { scheduled = true; queueMicrotask(flush); }
      }).catch(() => undefined);
    });
    return () => { active = false; pending.clear(); unsubscribe(); };
  }

  async feedback(token: object, input: unknown): Promise<ManagerProgressFeedbackReceipt> {
    const request = managerProgressFeedbackRequestSchema.parse(input);
    const run = managerRun(await this.runtime.get(token, { runId: request.runId }), request.runId);
    if (run.version !== request.expectedVersion) fail("VERSION_CONFLICT", "Manager run changed before feedback was accepted.");
    let taskId: string | undefined;
    const target = request.target;
    if (target.kind !== "run") {
      const task = run.tasks.find(item => item.definition.taskId === target.taskId && item.definition.phase === "worker");
      if (!task) return fail("INVALID_FEEDBACK_TARGET", "Feedback must target a task owned by this Manager run.");
      taskId = task.definition.taskId;
      if (target.kind === "result") {
        const attempt = task.attempts.find(item => item.attemptId === target.attemptId);
        const deliveries = [...(attempt?.delivery ? [attempt.delivery] : []), ...(attempt?.publications ?? [])];
        if (!attempt || !deliveries.length) return fail("INVALID_FEEDBACK_TARGET", "Feedback result does not match an owned pinned delivery.");
        if (!deliveries.some(delivery => stableResultId(run.runId, task.definition.taskId, attempt.attemptId, delivery.pin) === target.resultId)) {
          return fail("INVALID_FEEDBACK_TARGET", "Feedback result pin does not match the owned artifact.");
        }
      }
    }
    if (typeof this.runtime.feedback !== "function") return fail("FEEDBACK_UNAVAILABLE", "Manager feedback writer is not configured.");
    const result = await this.runtime.feedback(token, {
      operationId: request.operationId,
      runId: request.runId,
      expectedVersion: request.expectedVersion,
      ...(taskId ? { taskId } : {}),
      message: request.message,
      urgent: false,
    });
    const acceptedRun = managerRun(result, request.runId);
    return managerProgressFeedbackReceiptSchema.parse({
      schema: "pkm.manager.progress.feedback-receipt/v1",
      feedbackId: request.operationId,
      runId: request.runId,
      target: request.target,
      status: "applied",
      version: acceptedRun.version,
      receivedAt: toIso(acceptedRun.updatedAt),
    });
  }

}

export type ManagerProgressRuntimeBudget = ManagerPlanBudget;
