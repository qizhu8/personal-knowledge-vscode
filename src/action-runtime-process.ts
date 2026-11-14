import { randomUUID, createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { RuntimeProcessService, RuntimeProcessStore, RUNTIME_PROCESS_LIMITS } from "./runtime-process.js";
import type { RuntimeProcessAdapter } from "./runtime-process.js";
import type { ActionAuthorizationBinding, ActionNativeAdapter } from "./action-runtime.js";
import { originalDigest, schemaValueErrors } from "./domain/action-compiler-validation.js";
import { inspectActionBuild, materializeActionBuild, resolveActionExecutable, validateActionBuildOutputs,
  type ActionBuildPlan } from "./action-program-build.js";
import { createActionProgramInvocation } from "./action-program-invocation.js";

type ArgumentRule = { literal: string } | { pattern: RegExp; maxBytes: number };
export interface ActionProcessCommand {
  id: string;
  executable: string;
  cwd: string;
  arguments: readonly ArgumentRule[];
  directChildOnly: true;
  outputContractDigest: string;
  authorizationDigest: string;
  authorizeDefinition(binding: ActionAuthorizationBinding): boolean;
  authorizeData(binding: ActionAuthorizationBinding & { inputs: Record<string, unknown> }): boolean;
  approve(request: Readonly<{
    actorId: string; executableDigest: string; actionId: string; implementationId: string;
    nodeId: string; invocationId: string; commandId: string; arguments: readonly string[];
    inputDigest: string;
  }>): Promise<boolean>;
  redactOutput(output: unknown, actionId: string): unknown;
}
export interface ActionProcessBridgeOptions {
  database: DatabaseSync;
  workspaceRoot: string;
  commands: readonly ActionProcessCommand[];
  /** Explicit trusted-workspace opt-in, not a per-program allowlist. */
  trustedPrograms?: {
    approve(binding: ActionAuthorizationBinding & { inputs: Record<string, unknown> }, build?: ActionBuildPlan,
      artifact?: { artifactId: string; digest: string; size: number }): Promise<boolean>;
  };
  nestedArtifact?: {
    enabled(binding: ActionAuthorizationBinding & { inputs: Record<string, unknown> }): boolean;
    invoke(invocation: Parameters<ActionNativeAdapter["execute"]>[0],
      request: { actionId: string; inputs: Record<string, unknown>; key: string }, epoch: string, signal: AbortSignal): Promise<Record<string, unknown>>;
    validateOutput(invocation: Parameters<ActionNativeAdapter["execute"]>[0], output: unknown): boolean;
  };
  previousOwnerId?: string;
  beforeEffect?(): void;
  requirePreapproval?: boolean;
  authorizeLaunch?(binding: ActionAuthorizationBinding & { inputs: Record<string, unknown> }, trustEpoch?: string): boolean | Promise<boolean>;
  authorizationEpoch?(): string | undefined;
  limits?: ConstructorParameters<typeof RuntimeProcessService>[0]["limits"];
}
type Approval = Parameters<ActionProcessCommand["approve"]>[0];
type Pending = {
  command: ActionProcessCommand; approval: Approval; signal: AbortSignal; approved: boolean;
  binding: ActionAuthorizationBinding & { inputs: Record<string, unknown> };
  trustEpoch?: string;
  buildDirectory?: string;
  invocationEnvironment?: Record<string, string>;
};
type Json = z.infer<ReturnType<typeof z.json>>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

function assertDirectory(path: string, root: string): string {
  if (!isAbsolute(path)) throw new Error("Action process cwd must be absolute.");
  const actual = realpathSync(path), rel = relative(root, actual);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(actual).isDirectory()) {
    throw new Error("Action process cwd must remain inside the isolated workspace.");
  }
  return actual;
}
function matches(command: ActionProcessCommand, args: readonly string[]): boolean {
  return args.length === command.arguments.length && args.every((value, index) => {
    if (typeof value !== "string" || value.includes("\0")) return false;
    const rule = command.arguments[index]!;
    if ("literal" in rule) return value === rule.literal;
    const match = rule.pattern.exec(value);
    return Buffer.byteLength(value) <= rule.maxBytes && match?.index === 0 && match[0] === value;
  });
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function containsActionArtifactReference(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item)) for (const child of item) pending.push(child);
    else {
      const entries = Object.entries(item);
      if (entries.some(([key]) => key === "artifact_id")) return true;
      for (const [, child] of entries) pending.push(child);
    }
  }
  return false;
}

/** Create shell-free Action program adapters under a native host policy. */
export function createActionProcessBridge(options: ActionProcessBridgeOptions): {
  adapters: Readonly<Record<string, ActionNativeAdapter>>;
  resolveAdapter(key: string, outputContractDigest: string): ActionNativeAdapter | undefined;
  approveRun(runId: string, binding: ActionAuthorizationBinding & { inputs: Record<string, unknown> }, deadline: number,
    artifact?: { artifactId: string; digest: string; size: number }): Promise<boolean>;
  discardApproval(runId: string): void;
  isApprovalCurrent(runId: string): boolean | undefined;
  close(options?: { drainMs?: number }): Promise<void>;
} {
  if (!isAbsolute(options.workspaceRoot)) throw new Error("Action process workspace root must be absolute.");
  const root = realpathSync(options.workspaceRoot);
  if (!statSync(root).isDirectory()) throw new Error("Action process workspace root must be a directory.");
  const commands = new Map<string, ActionProcessCommand>();
  for (const original of options.commands) {
    identity.parse(original.id);
    if (original.id.length > 110 || options.trustedPrograms && original.id === "trusted-program"
      || commands.has(original.id) || original.directChildOnly !== true || !isAbsolute(original.executable)
      || original.executable.includes("\0") || typeof original.approve !== "function"
      || typeof original.authorizeDefinition !== "function" || typeof original.authorizeData !== "function"
      || typeof original.redactOutput !== "function" || !/^[a-f0-9]{64}$/.test(original.outputContractDigest)
      || !/^[a-f0-9]{64}$/.test(original.authorizationDigest)
      || original.arguments.length > RUNTIME_PROCESS_LIMITS.arguments) throw new Error("Invalid Action program command policy.");
    const executable = realpathSync(original.executable);
    if (!statSync(executable).isFile()) throw new Error("Allowlisted Action executable must be a file.");
    const arguments_ = original.arguments.map(rule => {
      if ("literal" in rule) {
        if (typeof rule.literal !== "string" || rule.literal.includes("\0")
          || Buffer.byteLength(rule.literal) > RUNTIME_PROCESS_LIMITS.argumentBytes) throw new Error("Invalid Action literal argument.");
        return Object.freeze({ literal: rule.literal });
      }
      if (!(rule.pattern instanceof RegExp) || rule.pattern.global || rule.pattern.sticky
        || !rule.pattern.source.startsWith("^") || !rule.pattern.source.endsWith("$")
        || !Number.isSafeInteger(rule.maxBytes) || rule.maxBytes < 1
        || rule.maxBytes > RUNTIME_PROCESS_LIMITS.argumentBytes) throw new Error("Invalid Action argument rule.");
      return Object.freeze({ pattern: new RegExp(rule.pattern.source, rule.pattern.flags), maxBytes: rule.maxBytes });
    });
    commands.set(original.id, Object.freeze({ ...original, executable, cwd: assertDirectory(original.cwd, root),
      arguments: Object.freeze(arguments_) }));
  }
  const pending = new Map<string, Pending>();
  const approvals = new Map<string, { fingerprint: string; approval: Approval; build?: ActionBuildPlan; trustEpoch?: string }>();
  const activeEpochs = new Map<string, string>();
  const shutdown = new AbortController();
  const runtime = new RuntimeProcessService({
    repositoryFactory: (ownerId, events) => new RuntimeProcessStore(options.database, ownerId, events, options.previousOwnerId),
    adapters: [...commands.values()].map(command => ({
      id: command.id, executable: command.executable, cwd: command.cwd,
      stdin: true, outputPersistence: "ephemeral" as const,
      arguments(input: Json) {
        const parsed = z.strictObject({ invocationId: z.uuid(), args: z.array(z.string()) }).parse(input);
        if (!matches(command, parsed.args)) throw new Error("Action program arguments are outside the allowlist.");
        return parsed.args;
      },
    } satisfies RuntimeProcessAdapter)),
    resolveAdapter: (id, input) => {
      if (id !== "trusted-program" || !input || typeof input !== "object" || Array.isArray(input)
        || typeof input.invocationId !== "string") return undefined;
      const context = pending.get(input.invocationId);
      if (!context || context.command.id !== id) return undefined;
      const command = context.command;
      return {
        id, executable: command.executable, cwd: command.cwd,
        env: { PATH: process.env.PATH ?? "", ...(context.buildDirectory
          ? { TMPDIR: context.buildDirectory, TMP: context.buildDirectory, TEMP: context.buildDirectory } : {}),
          ...context.invocationEnvironment },
        stdin: true, outputPersistence: "ephemeral",
        arguments(value) {
          const parsed = z.strictObject({ invocationId: z.uuid(), args: z.array(z.string()) }).parse(value);
          if (parsed.invocationId !== context.approval.invocationId || !matches(command, parsed.args))
            throw new Error("Action program arguments changed.");
          return parsed.args;
        },
      };
    },
    authorizeLaunch: async request => {
      options.beforeEffect?.();
      const parsed = z.strictObject({ invocationId: z.uuid(), args: z.array(z.string()) }).safeParse(request.input);
      if (!parsed.success) return false;
      const context = pending.get(parsed.data.invocationId);
      if (!context || !context.approved || context.signal.aborted
        || context.approval.actorId !== request.actorId
        || context.command.id !== request.adapterId
        || JSON.stringify(context.approval.arguments) !== JSON.stringify(parsed.data.args)
        || !matches(context.command, parsed.data.args)) return false;
      options.beforeEffect?.();
      return !context.signal.aborted
        && (!options.authorizeLaunch || await options.authorizeLaunch(context.binding, context.trustEpoch));
    },
    limits: { ...options.limits, stderrBytes: 0 },
  });
  let closed = false;
  const running = new Set<Promise<unknown>>();
  function commandFor(binding: ActionAuthorizationBinding) {
    if (binding.implementation.kind !== "program" || typeof binding.implementation.program !== "string"
      || (binding.implementation.result_protocol !== undefined
        && binding.implementation.result_protocol !== "pkm.action.result/v1")) return undefined;
    let command = binding.implementation.build === undefined ? commands.get(binding.implementation.program) : undefined;
    const args = binding.implementation.args ?? [];
    if (!command && options.trustedPrograms && Array.isArray(args) && args.every(value => typeof value === "string")
      && args.length <= runtime.limits.arguments
      && Buffer.byteLength(JSON.stringify(args)) <= runtime.limits.argumentBytes
      && args.every(value => !(value as string).includes("\0"))
      && (binding.implementation.result_protocol === undefined
        || binding.implementation.result_protocol === "pkm.action.result/v1")) {
      let build: ActionBuildPlan | undefined;
      try { if (binding.implementation.build !== undefined) build = inspectActionBuild(root, binding); }
      catch (error) {
        if (error instanceof Error && "code" in error) throw error;
        return undefined;
      }
      const executable = build?.compiler ?? resolveActionExecutable(binding.implementation.program);
      if (!executable) return undefined;
      command = {
        id: "trusted-program", executable, cwd: root, directChildOnly: true,
        arguments: args.map(value => ({ literal: value as string })),
        outputContractDigest: originalDigest(binding.definition.output_schema),
        authorizationDigest: digest("pkm.trusted-workspace-program/v1"),
        authorizeDefinition: () => true, authorizeData: () => true,
        approve: () => options.trustedPrograms!.approve(binding as ActionAuthorizationBinding & { inputs: Record<string, unknown> }, build),
        redactOutput: output => output,
      };
    }
    return command && Array.isArray(args) && args.every(value => typeof value === "string")
      && matches(command, args as string[]) ? command : undefined;
  }
  function approvalFor(binding: ActionAuthorizationBinding & { inputs: Record<string, unknown> }, command: ActionProcessCommand): Approval {
    return Object.freeze({
      actorId: binding.actorId, executableDigest: binding.executableDigest, actionId: binding.actionId,
      implementationId: String(binding.implementation.id ?? "default"), nodeId: binding.nodeId,
      invocationId: randomUUID(), commandId: command.id,
      arguments: Object.freeze([...(binding.implementation.args as string[] | undefined ?? [])]),
      inputDigest: digest(canonical(binding.inputs)),
    });
  }
  function approvalFingerprint(binding: ActionAuthorizationBinding & { inputs: Record<string, unknown> }): string {
    return digest(canonical(binding));
  }
  async function execute(invocation: Parameters<ActionNativeAdapter["execute"]>[0], signal: AbortSignal) {
    const binding: ActionAuthorizationBinding = {
      actorId: invocation.actorId, workspaceId: invocation.workspaceId, executableDigest: invocation.executableDigest,
      source: invocation.source, actionId: invocation.actionId, definition: invocation.definition,
      implementation: invocation.implementation, nodeId: invocation.nodeId,
    };
    const selected = commandFor(binding);
    if (!selected || closed || signal.aborted || selected.outputContractDigest !== originalDigest(invocation.definition.output_schema)) {
      activeEpochs.delete(invocation.runId);
      return { status: "unknown", outputs: {} };
    }
    let command: ActionProcessCommand = selected;
    let args = [...(invocation.implementation.args as string[] | undefined ?? [])];
    const inputText = canonical(invocation.inputs), inputDigest = digest(inputText);
    const bound = { ...binding, inputs: invocation.inputs };
    const reserved = options.requirePreapproval ? approvals.get(invocation.runId) : undefined;
    if (options.requirePreapproval) approvals.delete(invocation.runId);
    if (options.requirePreapproval && (!reserved || reserved.fingerprint !== approvalFingerprint(bound))) {
      activeEpochs.delete(invocation.runId);
      return { status: "unknown", outputs: {} };
    }
    let approval = reserved?.approval ?? approvalFor(bound, command);
    let invocationId = approval.invocationId;
    if (approval.inputDigest !== inputDigest) {
      activeEpochs.delete(invocation.runId);
      return { status: "unknown", outputs: {} };
    }
    const context: Pending = { command, approval, signal, approved: false, binding: { ...binding, inputs: invocation.inputs },
      ...(reserved?.trustEpoch ? { trustEpoch: reserved.trustEpoch } : {}) };
    pending.set(invocationId, context);
    let jobId: string | undefined;
    let nested: Awaited<ReturnType<typeof createActionProgramInvocation>> | undefined;
    const onAbort = () => {
      if (jobId) void runtime.cancel(invocation.actorId, jobId).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const interruptible = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
      let abort!: () => void;
      const interrupted = new Promise<undefined>(resolve => {
        abort = () => resolve(undefined);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) resolve(undefined);
      });
      try { return await Promise.race([Promise.resolve().then(work), interrupted]); }
      finally { signal.removeEventListener("abort", abort); }
    };
    try {
      if (!options.requirePreapproval) {
        const approvalResult = await interruptible(() => command.approve(approval));
        if (signal.aborted || approvalResult === undefined) return { status: "unknown", outputs: {} };
        if (approvalResult === false) return { status: "failed", reason: "ACTION_EFFECT_CONSENT_REQUIRED", outputs: {} };
        if (approvalResult !== true) return { status: "unknown", outputs: {} };
      }
      context.approved = true;
      let deadlineMs = Math.min(invocation.deadline - Date.now(), runtime.limits.deadlineMs);
      if (deadlineMs < 1 || Buffer.byteLength(inputText) > runtime.limits.inputBytes) return { status: "unknown", outputs: {} };
      if (options.authorizeLaunch && await options.authorizeLaunch({ ...binding, inputs: invocation.inputs }, context.trustEpoch) !== true)
        return { status: "unknown", outputs: {} };
      if (signal.aborted || closed) return { status: "unknown", outputs: {} };
      options.beforeEffect?.();
      if (invocation.implementation.build !== undefined) {
        const plan = reserved?.build;
        if (!plan || canonical(inspectActionBuild(root, binding)) !== canonical(plan))
          return { status: "unknown", reason: "ACTION_BUILD_CHANGED", outputs: {} };
        const staged = materializeActionBuild(root, plan);
        context.buildDirectory = staged.directory;
        const buildArgs = staged.args;
        context.command = { ...command, executable: plan.compiler, cwd: staged.directory,
          arguments: buildArgs.map(literal => ({ literal })) };
        context.approval = { ...approval, arguments: buildArgs };
        deadlineMs = Math.min(deadlineMs, plan.timeoutSeconds * 1000);
        const buildJob = await runtime.launch({
          actorId: invocation.actorId, operationId: invocationId, adapterId: command.id,
          input: { invocationId, args: buildArgs }, deadlineMs,
        });
        jobId = buildJob.jobId;
        if (signal.aborted || closed) await runtime.cancel(invocation.actorId, jobId);
        const built = await runtime.waitCaptured(invocation.actorId, jobId);
        jobId = undefined;
        if (!built || signal.aborted || built.job.effect === "unknown"
          || built.job.state === "TIMED_OUT" || built.job.state === "CANCELLED")
          return { status: "unknown", reason: "ACTION_BUILD_INTERRUPTED", outputs: {} };
        if (built.job.state !== "SUCCEEDED" || built.job.stdoutDroppedBytes)
          return built.job.signal
            ? { status: "unknown", reason: "ACTION_BUILD_INTERRUPTED", outputs: {} }
            : { status: "failed", reason: "ACTION_BUILD_FAILED", outputs: {} };
        try {
          if (canonical(inspectActionBuild(root, binding)) !== canonical(plan))
            return { status: "unknown", reason: "ACTION_BUILD_CHANGED", outputs: {} };
          validateActionBuildOutputs(staged.directory, plan.outputs);
        } catch { return { status: "failed", reason: "ACTION_BUILD_OUTPUT_INVALID", outputs: {} }; }
        const executable = plan.runtime.startsWith("${build_dir}/")
          ? join(staged.directory, plan.runtime.slice("${build_dir}/".length)) : plan.runtime;
        accessSync(executable, constants.X_OK);
        args = args.map(arg => arg.replaceAll("${build_dir}", staged.directory));
        pending.delete(invocationId);
        approval = { ...approval, invocationId: randomUUID(), arguments: args };
        invocationId = approval.invocationId;
        command = { ...command, executable, cwd: staged.directory, arguments: args.map(literal => ({ literal })) };
        context.command = command;
        context.approval = approval;
        pending.set(invocationId, context);
        deadlineMs = Math.min(invocation.deadline - Date.now(), runtime.limits.deadlineMs);
        if (deadlineMs < 1 || signal.aborted) return { status: "unknown", reason: "ACTION_BUILD_INTERRUPTED", outputs: {} };
      }
      if (options.nestedArtifact?.enabled(bound)) {
        if (!context.trustEpoch) return { status: "unknown", reason: "ACTION_RESULT_ARTIFACT_UNSUPPORTED", outputs: {} };
        nested = await createActionProgramInvocation({
          root, runId: invocation.runId, signal,
          invoke: request => options.nestedArtifact!.invoke(invocation, request, context.trustEpoch!, signal),
        });
        context.invocationEnvironment = nested.env;
        nested.verify();
      }
      const job = await runtime.launch({
        actorId: invocation.actorId, operationId: invocationId, adapterId: command.id,
        input: { invocationId, args }, deadlineMs, stdin: Buffer.from(inputText, "utf8"),
      });
      jobId = job.jobId;
      if (signal.aborted || closed) await runtime.cancel(invocation.actorId, jobId);
      const captured = await runtime.waitCaptured(invocation.actorId, jobId);
      const protocol = invocation.implementation.result_protocol === "pkm.action.result/v1";
      if (captured && !signal.aborted && (captured.job.stdoutDroppedBytes
        || captured.job.stdoutBytes > runtime.limits.stdoutBytes)) return {
        status: "unknown", outputs: {}, ...(protocol ? { reason: "ACTION_RESULT_PROTOCOL_OVERSIZED" } : {}),
      };
      if (!captured || captured.job.state === "TIMED_OUT" || captured.job.state === "CANCELLED"
        || captured.job.effect === "unknown") return { status: "unknown", outputs: {} };
      if (captured.job.state !== "SUCCEEDED") {
        return captured.job.signal ? { status: "unknown", outputs: {} } : { status: "failed", outputs: {} };
      }
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(captured.stdout)); }
      catch { return { status: "unknown", outputs: {}, ...(protocol ? { reason: "ACTION_RESULT_PROTOCOL_INVALID" } : {}) }; }
      if (protocol && raw && typeof raw === "object" && Object.hasOwn(raw, "artifacts")) {
        return { status: "unknown", reason: "ACTION_RESULT_ARTIFACT_UNSUPPORTED", outputs: {} };
      }
      if (protocol) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)
          || typeof (raw as Record<string, unknown>).ok !== "boolean") {
          return { status: "unknown", reason: "ACTION_RESULT_PROTOCOL_INVALID", outputs: {} };
        }
        const envelope = raw as Record<string, unknown>;
        if (envelope.ok === false) {
          const failure = envelope.failure;
          if (Object.keys(envelope).some(key => !["ok", "failure"].includes(key))
            || !failure || typeof failure !== "object" || Array.isArray(failure)
            || typeof (failure as Record<string, unknown>).code !== "string"
            || typeof (failure as Record<string, unknown>).message !== "string"
            || (Object.hasOwn(failure, "blocked") && typeof (failure as Record<string, unknown>).blocked !== "boolean")) {
            return { status: "unknown", reason: "ACTION_RESULT_PROTOCOL_INVALID", outputs: {} };
          }
          const effects = invocation.definition.effects;
          const readOnly = Array.isArray(effects) && effects.length > 0
            && effects.every(effect => ["pure", "read", "local-read", "remote-read", "human-input"].includes(String(effect)));
          return { status: readOnly ? "failed" : "unknown",
            reason: (failure as Record<string, unknown>).blocked === true
              ? "ACTION_RESULT_REPORTED_BLOCKED" : "ACTION_RESULT_REPORTED_FAILURE", outputs: {} };
        }
        if (!Object.hasOwn(envelope, "output") || Object.keys(envelope).some(key => !["ok", "output"].includes(key)))
          return { status: "unknown", reason: "ACTION_RESULT_PROTOCOL_INVALID", outputs: {} };
        raw = envelope.output;
      }
      let output: unknown;
      try { output = command.redactOutput(raw, invocation.actionId); }
      catch { return { status: "unknown", outputs: {} }; }
      if (containsActionArtifactReference(output)) {
        if (!nested || options.nestedArtifact?.validateOutput(invocation, output) !== true)
          return { status: "unknown", reason: "ACTION_RESULT_ARTIFACT_UNSUPPORTED", outputs: {} };
        nested.verify();
      }
      if (!output || typeof output !== "object" || Array.isArray(output)
        || schemaValueErrors(invocation.definition.output_schema, output).length) return {
        status: "unknown", outputs: {}, ...(protocol ? { reason: "ACTION_RESULT_PROTOCOL_INVALID" } : {}),
      };
      return { status: "succeeded", outputs: output };
    } catch { return { status: "unknown", outputs: {} }; }
    finally {
      if (nested) await nested.close();
      pending.delete(invocationId); activeEpochs.delete(invocation.runId); signal.removeEventListener("abort", onAbort);
    }
  }
  const adapters: Record<string, ActionNativeAdapter> = Object.create(null);
  for (const command of commands.values()) {
    const adapter: ActionNativeAdapter = {
      id: `action-process-${command.id}`, version: 1,
      outputContractDigest: command.outputContractDigest, authorizationDigest: command.authorizationDigest,
      authorizeDefinition(binding) {
        const selected = commandFor(binding);
        return selected?.id === command.id && command.authorizeDefinition(binding) === true;
      },
      authorizeData(binding) {
        const selected = commandFor(binding);
        return selected?.id === command.id && command.authorizeData(binding) === true;
      },
      execute(invocation, context) {
        const work = execute(invocation, AbortSignal.any([context.signal, shutdown.signal]));
        running.add(work); void work.then(() => running.delete(work), () => running.delete(work));
        return work;
      },
    };
    adapters[`program:${command.id}`] = adapter;
  }
  function resolveAdapter(key: string, outputContractDigest: string): ActionNativeAdapter | undefined {
    if (!options.trustedPrograms || !key.startsWith("program:")) return undefined;
    return {
      id: "action-trusted-program", version: 1, outputContractDigest,
      authorizationDigest: digest("pkm.trusted-workspace-program/v1"),
      authorizeDefinition(binding) { return `program:${String(binding.implementation.program)}` === key && !!commandFor(binding); },
      authorizeData(binding) { return `program:${String(binding.implementation.program)}` === key && !!commandFor(binding); },
      execute(invocation, context) {
        const work = execute(invocation, AbortSignal.any([context.signal, shutdown.signal]));
        running.add(work); void work.then(() => running.delete(work), () => running.delete(work));
        return work;
      },
    };
  }
  return {
    adapters: Object.freeze(adapters),
    resolveAdapter,
    async approveRun(runId, binding, deadline, artifact) {
      if (!options.requirePreapproval || closed || approvals.has(runId)) throw new Error("Action approval is unavailable.");
      const command = commandFor(binding);
      if (!command || command.outputContractDigest !== originalDigest(binding.definition.output_schema)) return false;
      const build = binding.implementation.build !== undefined ? inspectActionBuild(root, binding) : undefined;
      const trustEpoch = options.authorizationEpoch?.();
      if (options.authorizationEpoch && !trustEpoch) throw new Error("Action trust epoch is unavailable.");
      const approval = approvalFor(binding, command);
      const remaining = Math.min(deadline - Date.now(), runtime.limits.deadlineMs);
      if (remaining < 1) throw new Error("Action approval deadline expired.");
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(remaining)]);
      if (signal.aborted) throw new Error("Action approval was interrupted.");
      let abort!: () => void;
      const interrupted = new Promise<undefined>(resolve => {
        abort = () => resolve(undefined);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) resolve(undefined);
      });
      let result: boolean | undefined;
      try { result = await Promise.race([Promise.resolve().then(() =>
        build || artifact ? options.trustedPrograms!.approve(binding, build, artifact) : command.approve(approval)), interrupted]); }
      finally { signal.removeEventListener("abort", abort); }
      if (signal.aborted || result === undefined) throw new Error("Action approval was interrupted.");
      if (result !== true) return false;
      if (options.authorizationEpoch && options.authorizationEpoch() !== trustEpoch)
        throw new Error("Action trust epoch changed during approval.");
      approvals.set(runId, { fingerprint: approvalFingerprint(binding), approval, ...(build ? { build } : {}),
        ...(trustEpoch ? { trustEpoch } : {}) });
      if (trustEpoch) activeEpochs.set(runId, trustEpoch);
      return true;
    },
    discardApproval(runId) { approvals.delete(runId); activeEpochs.delete(runId); },
    isApprovalCurrent(runId) {
      const epoch = activeEpochs.get(runId);
      return epoch === undefined ? undefined : options.authorizationEpoch?.() === epoch;
    },
    async close(closeOptions = {}) {
      closed = true; shutdown.abort(); approvals.clear(); activeEpochs.clear();
      await runtime.close({ drainMs: closeOptions.drainMs ?? 0 });
      await Promise.allSettled([...running]);
    },
  };
}
