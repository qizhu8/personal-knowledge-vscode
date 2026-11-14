import { z } from "zod";

export const RUNTIME_PROCESS_LIMITS = Object.freeze({
  concurrency: 4, queue: 32, jobs: 4096, events: 128,
  stdoutBytes: 65_536, stderrBytes: 65_536, inputBytes: 16_384,
  argumentBytes: 32_768, arguments: 128, deadlineMs: 300_000,
  graceMs: 2000, closeDrainMs: 30_000, page: 100,
});
export const runtimeProcessIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const runtimeProcessState = z.enum([
  "QUEUED", "RUNNING", "PAUSED", "SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "OUTPUT_LIMIT", "INTERRUPTED",
]);
const integer = z.number().int().safe().nonnegative();
export const runtimeProcessJob = z.strictObject({
  schema: z.literal("pkm.runtime-process.job/v1"),
  jobId: z.string().uuid(), operationId: z.string().uuid(),
  ownerId: z.string().uuid(), attemptId: z.string().uuid(),
  actorId: runtimeProcessIdentity, adapterId: runtimeProcessIdentity,
  state: runtimeProcessState,
  effect: z.enum(["not-started", "unknown", "completed"]),
  createdAt: integer, startedAt: integer.nullable(), finishedAt: integer.nullable(),
  deadlineAt: integer, pid: integer.positive().nullable(),
  exitCode: z.number().int().nullable(), signal: z.string().nullable(),
  reason: z.enum(["exit", "spawn-error", "cancel", "deadline", "output-limit", "shutdown", "restart", "persistence-error", "supervisor-error"]).nullable(),
  stdout: z.string().max(87_384), stderr: z.string().max(87_384),
  stdoutBytes: integer, stderrBytes: integer,
  stdoutDroppedBytes: integer, stderrDroppedBytes: integer,
  eventSequence: integer,
});
export const runtimeProcessEvent = z.strictObject({
  sequence: integer.positive(), at: integer, jobId: z.string().uuid(),
  kind: z.enum(["queued", "running", "spawned", "paused", "resumed", "stdout", "stderr", "stopping", "finished", "interrupted"]),
  state: runtimeProcessState, bytes: integer.optional(),
});
const jobInput = z.strictObject({ jobId: z.string().uuid() });
export const runtimeProcessDefinitions = [
  {
    id: "runtime.process.status", readOnly: true,
    description: "Read only the authenticated actor's explicitly owned job receipt and bounded base64 output. Never discovers host processes.",
    input: jobInput, output: runtimeProcessJob,
  },
  {
    id: "runtime.process.list", readOnly: true,
    description: "Page only the authenticated actor's job receipts. No command lines, environment, filesystem or host process inventory.",
    input: z.strictObject({ offset: integer.max(4096).default(0), limit: integer.min(1).max(100).default(20) }),
    output: z.strictObject({ items: z.array(runtimeProcessJob).max(100), total: integer }),
  },
  {
    id: "runtime.process.events", readOnly: true,
    description: "Read the actor-owned job's bounded durable event ring. A cursor gap is explicitly reported; events contain no raw output.",
    input: jobInput.extend({ after: integer.default(0), limit: integer.min(1).max(100).default(100) }),
    output: z.strictObject({
      items: z.array(runtimeProcessEvent).max(100), oldestSequence: integer,
      latestSequence: integer, gap: z.boolean(),
    }),
  },
  {
    id: "runtime.process.cancel", readOnly: false,
    description: "Idempotently request cancellation of the actor's owned job. Signals only a currently owned live child handle, never a persisted PID.",
    input: jobInput, output: runtimeProcessJob,
  },
  {
    id: "runtime.process.pause", readOnly: false,
    description: "Pause the actor's live, explicitly configured Linux process group; never signal a persisted PID.",
    input: jobInput, output: runtimeProcessJob,
  },
  {
    id: "runtime.process.resume", readOnly: false,
    description: "Resume the actor's live, explicitly configured Linux process group; never signal a persisted PID.",
    input: jobInput, output: runtimeProcessJob,
  },
] as const;
export const RUNTIME_PROCESS_MODULE_SCHEMA = Object.freeze({
  schema: "pkm.runtime-process.module/v1",
  jobSchema: "pkm.runtime-process.job/v1",
  persistenceVersion: 1,
  tables: ["runtime_process_owner", "runtime_process_jobs", "runtime_process_events"],
  publicOperations: runtimeProcessDefinitions.map(definition => definition.id),
  nativeLaunch: "RuntimeProcessService.launch: trusted authorization + configured adapter ID only",
  lifecycle: {
    QUEUED: ["RUNNING", "CANCELLED", "TIMED_OUT", "INTERRUPTED"],
    RUNNING: ["PAUSED", "SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "INTERRUPTED"],
    PAUSED: ["RUNNING", "CANCELLED", "TIMED_OUT", "INTERRUPTED"],
    terminal: ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "INTERRUPTED"],
  },
  restart: "interrupt-without-replay-or-pid-signals",
  shutdown: "await-close-before-database-close",
  processScope: "direct-child-by-default; explicit-linux-owned-session-group-only",
});
export type RuntimeProcessJob = z.infer<typeof runtimeProcessJob>;
export type RuntimeProcessEvent = z.infer<typeof runtimeProcessEvent>;
export type RuntimeProcessOperation = typeof runtimeProcessDefinitions[number]["id"];
export type RuntimeProcessRequest = { operation: RuntimeProcessOperation; args: unknown };
