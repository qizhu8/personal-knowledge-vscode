import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { RUNTIME_PROCESS_LIMITS, RuntimeProcessService, RuntimeProcessStore } from "./runtime-process.js";
import type { WorkflowInvocation, WorkflowStepAdapter } from "./workflow-executor.js";
import type { WorkflowNodeV1 } from "./domain/project-recipes-workflow-contracts.js";

type Json = z.infer<ReturnType<typeof z.json>>;
type Argument = { literal: string } | { pattern: RegExp; maxBytes: number };
export interface ProcessBridgeCommand {
  id: string;
  executable: string;
  /** Resolved by the trusted host; never taken from the workflow. */
  cwd: string;
  arguments: readonly Argument[];
  output: z.ZodType<Record<string, Json>>;
  /** Group mode is a separate trusted Linux host opt-in, not process containment. */
  directChildOnly: boolean;
  processScope?: "linux-process-group";
}
export interface ProcessBridgeApproval {
  actorId: string;
  executableDigest: string;
  nodeId: string;
  invocationId: string;
  commandId: string;
  arguments: readonly string[];
  processScope?: "linux-process-group";
}
export interface ProcessBridgeOptions {
  database: DatabaseSync;
  workspaceRoot: string;
  commands: readonly ProcessBridgeCommand[];
  adapterId: string;
  version: number;
  outputContractDigest: string;
  authorizationDigest: string;
  authorizeDefinition(binding: Readonly<{ actorId: string; executableDigest: string; source: unknown; node: WorkflowNodeV1 }>): boolean;
  authorizeData: NonNullable<WorkflowStepAdapter["authorizeData"]>;
  redactOutput(output: unknown, commandId: string): unknown;
  resolveStdin?(request: Readonly<ProcessBridgeApproval>, signal: AbortSignal): Promise<Uint8Array | undefined>;
  approve(request: Readonly<ProcessBridgeApproval>): Promise<boolean>;
  previousOwnerId?: string;
  limits?: ConstructorParameters<typeof RuntimeProcessService>[0]["limits"];
}
type Pending = { approval: ProcessBridgeApproval; signal: AbortSignal; approved: boolean };
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

function assertDirectory(path: string, root: string): string {
  if (!isAbsolute(path)) throw new Error("Trusted paths must be absolute.");
  const actual = realpathSync(path);
  const rel = relative(root, actual);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(actual).isDirectory()) {
    throw new Error("Trusted working directory must be inside the isolated workspace.");
  }
  return actual;
}
function matches(command: ProcessBridgeCommand, args: readonly string[]): boolean {
  return args.length === command.arguments.length && args.every((value, index) => {
    if (typeof value !== "string" || value.includes("\0")) return false;
    const rule = command.arguments[index]!;
    if ("literal" in rule) return value === rule.literal;
    const match = rule.pattern.exec(value);
    return Buffer.byteLength(value) <= rule.maxBytes && match?.index === 0 && match[0] === value;
  });
}

/**
 * Host-only composition. The trusted data policy must reject sensitive workflow definitions
 * and inputs before durable persistence; the output policy must redact before validation.
 * Stdin and raw process output are ephemeral. Never expose launch/approval to callers.
 */
export function createProcessBridge(options: ProcessBridgeOptions): {
  adapter: WorkflowStepAdapter;
  pause(actorId: string, runId: string): Promise<void>;
  resume(actorId: string, runId: string): Promise<void>;
  close(): Promise<void>;
} {
  id.parse(options.adapterId); z.number().int().positive().safe().parse(options.version);
  digest.parse(options.outputContractDigest); digest.parse(options.authorizationDigest);
  if (typeof options.authorizeDefinition !== "function" || typeof options.approve !== "function"
    || typeof options.authorizeData !== "function" || typeof options.redactOutput !== "function"
    || (options.resolveStdin !== undefined && typeof options.resolveStdin !== "function")) throw new Error("Explicit authorization and data policies required.");
  const { authorizeDefinition, authorizeData, approve, resolveStdin, redactOutput } = options;
  if (!isAbsolute(options.workspaceRoot)) throw new Error("Isolated workspace root must be absolute.");
  const root = realpathSync(options.workspaceRoot);
  if (!statSync(root).isDirectory()) throw new Error("Workspace root must be a directory.");
  const commands = new Map<string, ProcessBridgeCommand>();
  for (const original of options.commands) {
    id.parse(original.id);
    if (commands.has(original.id) || !((original.directChildOnly === true && original.processScope === undefined)
      || (original.directChildOnly === false && original.processScope === "linux-process-group" && process.platform === "linux"))
      || !isAbsolute(original.executable)
      || original.executable.includes("\0") || !original.output || typeof original.output.safeParse !== "function"
      || !Array.isArray(original.arguments) || original.arguments.length > RUNTIME_PROCESS_LIMITS.arguments) {
      throw new Error("Invalid configured command.");
    }
    const executable = realpathSync(original.executable);
    if (!statSync(executable).isFile()) throw new Error("Executable must be a file.");
    const rules = original.arguments.map(rule => {
      if ("literal" in rule) {
        if (typeof rule.literal !== "string" || rule.literal.includes("\0") || Buffer.byteLength(rule.literal) > RUNTIME_PROCESS_LIMITS.argumentBytes) throw new Error("Invalid literal argument.");
        return Object.freeze({ literal: rule.literal });
      }
      if (!(rule.pattern instanceof RegExp) || rule.pattern.global || rule.pattern.sticky
        || !rule.pattern.source.startsWith("^") || !rule.pattern.source.endsWith("$")
        || !Number.isSafeInteger(rule.maxBytes) || rule.maxBytes < 1 || rule.maxBytes > RUNTIME_PROCESS_LIMITS.argumentBytes) throw new Error("Invalid argument rule.");
      return Object.freeze({ pattern: new RegExp(rule.pattern.source, rule.pattern.flags), maxBytes: rule.maxBytes });
    });
    commands.set(original.id, Object.freeze({ ...original, executable, cwd: assertDirectory(original.cwd, root), arguments: Object.freeze(rules) }));
  }
  const pending = new Map<string, Pending>();
  const shutdown = new AbortController();
  const runtime = new RuntimeProcessService({
    repositoryFactory: (ownerId, events) => new RuntimeProcessStore(options.database, ownerId, events, options.previousOwnerId),
    adapters: [...commands.values()].map(command => ({
      id: command.id, executable: command.executable, cwd: command.cwd,
      stdin: true, outputPersistence: "ephemeral" as const,
      processScope: command.processScope,
      arguments: (input: Json) => {
        const parsed = z.strictObject({ invocationId: z.uuid(), args: z.array(z.string()) }).parse(input);
        if (!matches(command, parsed.args)) throw new Error("Invalid configured arguments.");
        return parsed.args;
      },
    })),
    authorizeLaunch: async request => {
      const parsed = z.strictObject({ invocationId: z.uuid(), args: z.array(z.string()) }).safeParse(request.input);
      if (!parsed.success) return false;
      const context = pending.get(parsed.data.invocationId), command = commands.get(request.adapterId);
      if (!context || !context.approved || !command || context.signal.aborted || context.approval.actorId !== request.actorId
        || context.approval.commandId !== request.adapterId || !matches(command, parsed.data.args)
        || JSON.stringify(context.approval.arguments) !== JSON.stringify(parsed.data.args)) return false;
      return true;
    },
    limits: { ...options.limits, stderrBytes: 0 },
  });
  let closed = false;
  const running = new Set<Promise<unknown>>();
  const activeJobs = new Map<string, Set<string>>();
  function commandFor(node: WorkflowNodeV1) {
    if (node.kind !== "pkm.step.command/v1" || node.config.cwd !== undefined) return undefined;
    const command = commands.get(node.config.program);
    if (!command || !matches(command, node.config.args)
      || node.config.maxOutputBytes < 1 || node.config.maxOutputBytes > runtime.limits.stdoutBytes
      || node.config.timeoutSeconds * 1000 > runtime.limits.deadlineMs) return undefined;
    return command;
  }
  async function execute(invocation: Readonly<WorkflowInvocation>, signal: AbortSignal) {
    const node = invocation.node, command = commandFor(node);
    if (!command || node.kind !== "pkm.step.command/v1" || closed || signal.aborted) return { status: "failed", outputs: {} };
    const stepDeadline = Math.min(invocation.deadline, Date.now() + node.config.timeoutSeconds * 1000);
    const approvalSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, stepDeadline - Date.now()))]);
    const args = [...node.config.args];
    const approval: ProcessBridgeApproval = Object.freeze({ actorId: invocation.actorId, executableDigest: invocation.executableDigest,
      nodeId: node.nodeId, invocationId: invocation.invocationId, commandId: command.id, arguments: Object.freeze(args),
      ...(command.processScope ? { processScope: command.processScope } : {}) });
    if (pending.has(invocation.invocationId)) return { status: "unknown", outputs: {} };
    const pendingApproval = { approval, signal: approvalSignal, approved: false };
    pending.set(invocation.invocationId, pendingApproval);
    let jobId: string | undefined;
    const cancel = () => {
      if (!jobId) return;
      const expired = signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
      void (expired ? runtime.expire(invocation.actorId, jobId) : runtime.cancel(invocation.actorId, jobId)).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const remaining = Math.min(stepDeadline - Date.now(), runtime.limits.deadlineMs);
      if (remaining < 1 || signal.aborted) return { status: "unknown", outputs: {} };
      const interruptible = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
        let abort!: () => void;
        const interrupted = new Promise<undefined>(resolve => {
          abort = () => resolve(undefined);
          approvalSignal.addEventListener("abort", abort, { once: true });
          if (approvalSignal.aborted) resolve(undefined);
        });
        try { return await Promise.race([Promise.resolve().then(work), interrupted]); }
        finally { approvalSignal.removeEventListener("abort", abort); }
      };
      if (await interruptible(() => approve(approval)) !== true || approvalSignal.aborted) return { status: "unknown", outputs: {} };
      pendingApproval.approved = true;
      const stdin = resolveStdin ? await interruptible(() => resolveStdin(approval, approvalSignal)) : undefined;
      if (approvalSignal.aborted || (stdin !== undefined && (!(stdin instanceof Uint8Array) || stdin.byteLength > runtime.limits.inputBytes))) return { status: "unknown", outputs: {} };
      const deadlineMs = Math.min(remaining, stepDeadline - Date.now());
      if (deadlineMs < 1) return { status: "unknown", outputs: {} };
      const job = await runtime.launch({ actorId: invocation.actorId, operationId: invocation.invocationId,
        adapterId: command.id, input: { invocationId: invocation.invocationId, args }, deadlineMs, stdin });
      jobId = job.jobId;
      const key = JSON.stringify([invocation.actorId, invocation.runId]);
      const jobs = activeJobs.get(key) ?? new Set<string>();
      jobs.add(jobId); activeJobs.set(key, jobs);
      if (signal.aborted || closed) {
        const expired = signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
        await (expired ? runtime.expire(invocation.actorId, jobId) : runtime.cancel(invocation.actorId, jobId));
      }
      const captured = await runtime.waitCaptured(invocation.actorId, jobId);
      if (!captured) return { status: "unknown", outputs: {} };
      const result = captured.job;
      if (result.state === "FAILED" && result.effect !== "unknown") return { status: "failed", outputs: {} };
      if (result.state !== "SUCCEEDED" || result.stdoutDroppedBytes || result.stdoutBytes > node.config.maxOutputBytes) return { status: "unknown", outputs: {} };
      let output: unknown;
      try { output = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(captured.stdout)); }
      catch { return { status: "unknown", outputs: {} }; }
      const validated = command.output.safeParse(redactOutput(output, command.id));
      if (!validated.success) return { status: "unknown", outputs: {} };
      return { status: "succeeded", outputs: validated.data };
    } catch { return { status: "unknown", outputs: {} }; }
    finally {
      if (jobId) {
        const key = JSON.stringify([invocation.actorId, invocation.runId]);
        const jobs = activeJobs.get(key);
        jobs?.delete(jobId);
        if (!jobs?.size) activeJobs.delete(key);
      }
      pending.delete(invocation.invocationId); signal.removeEventListener("abort", cancel);
    }
  }
  const adapter: WorkflowStepAdapter = {
    id: options.adapterId, version: options.version, outputContractDigest: options.outputContractDigest,
    authorizationDigest: options.authorizationDigest,
    authorizeDefinition: binding => !!commandFor(binding.node) && authorizeDefinition(binding) === true,
    authorizeData: binding => authorizeData(binding) === true,
    execute(invocation, context) {
      const stepTimeout = invocation.node.kind === "pkm.step.command/v1" ? invocation.node.config.timeoutSeconds * 1000 : runtime.limits.deadlineMs;
      const group = commandFor(invocation.node)?.processScope === "linux-process-group";
      const remaining = Math.max(1, group ? invocation.deadline - Date.now()
        : Math.min(stepTimeout, runtime.limits.deadlineMs, invocation.deadline - Date.now()));
      const signal = AbortSignal.any([context.signal, shutdown.signal, AbortSignal.timeout(remaining)]);
      const work = execute(invocation, signal);
      running.add(work); void work.finally(() => running.delete(work));
      return work;
    },
    validateOutput: outputs => Object.keys(outputs).length === 0 || [...commands.values()].some(command => command.output.safeParse(outputs).success),
  };
  return {
    adapter,
    async pause(actorId, runId) {
      const jobs = activeJobs.get(JSON.stringify([actorId, runId]));
      if (closed || jobs?.size !== 1) throw new Error("No unambiguous active owned process for this workflow.");
      await runtime.pause(actorId, [...jobs][0]!);
    },
    async resume(actorId, runId) {
      const jobs = activeJobs.get(JSON.stringify([actorId, runId]));
      if (closed || jobs?.size !== 1) throw new Error("No unambiguous active owned process for this workflow.");
      await runtime.resume(actorId, [...jobs][0]!);
    },
    async close() {
      closed = true;
      shutdown.abort();
      await runtime.close({ drainMs: 0 });
      await Promise.allSettled([...running]);
    },
  };
}
