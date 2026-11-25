import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { basename, resolve } from "node:path";
import { canonicalJson, compileWorkflowDefinitionV1 } from "./domain/project-recipes-workflow-contracts.js";
import type { WorkflowStepAdapter, WorkflowInvocation } from "./workflow-executor.js";
import type { OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import type { AuthenticatedOriginalMcpNativeSession } from "./original-mcp-native-attachment.js";
import { requestOriginalMcpNative } from "./original-mcp-native-request.js";
import { resolveActionExecutable } from "./action-program-build.js";
import { RuntimeProcessService, RuntimeProcessStore } from "./runtime-process.js";
import { originalRecipeEffectMethod, originalRecipeEffectRequest, assertOriginalRecipeEffectDecision, renderRecipeEffectText,
  type OriginalRecipeEffectRequest, type OriginalRecipeEffectDecision } from "./original-mcp-recipe-effect-contracts.js";
import { pinRecipeEffectCwd, pinRecipeEffectFile, assertRecipeEffectExecutable } from "./original-mcp-recipe-effect-files.js";
import { selectRegisteredHostPythonEnvironment } from "./host-python-environment.js";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
type DefinitionBinding = Parameters<WorkflowStepAdapter["authorizeDefinition"]>[0];
type Effect = { request: OriginalRecipeEffectRequest; controller: AbortController; decision?: OriginalRecipeEffectDecision;
  jobId?: string; cancelled: boolean; outputs?: Record<string, unknown> };
/** The durable intent/result remains in the one WorkflowExecutor. This attachment owns only live child handles. */
export function createOriginalMcpRecipeEffects(options: {
  root: string; host: OriginalMcpNativeHost; session: AuthenticatedOriginalMcpNativeSession; signal: AbortSignal;
  source: { workspaceId: string; planSha256: string; recordSha256: string; recipeId: string; revision: number; executableDigest: string };
  definition: unknown; assertCurrent(): void; refresh(): Promise<void>; authorize(binding: DefinitionBinding): boolean;
  approved(runId: string, invocationId: string, metadata: unknown): void;
  executionSemantics?: OriginalRecipeEffectRequest["executionSemantics"];
  sourceInputs(runId: string): Record<string, unknown>;
  sourceForRun?(runId: string): {
    recipeId: string; revision: number; executableDigest: string; recordSha256: string; definition: unknown;
  };
}) {
  const database = new DatabaseSync(":memory:"), effects = new Map<string, Effect>(), retiredDecisions = new Set<string>();
  let closing: Promise<void> | undefined;
  function check(effect: Effect, beforeSpawn = false) {
    options.assertCurrent(); options.session.assertCurrent();
    if (options.signal.aborted || effect.controller.signal.aborted && beforeSpawn) throw new Error("RECIPE_EFFECT_CANCELLED");
    if (hash(pinRecipeEffectCwd(options.root, effect.request.cwd.path)) !== hash(effect.request.cwd))
      throw new Error("RECIPE_EFFECT_CWD_CHANGED");
    for (const file of effect.request.sources)
      if (hash(pinRecipeEffectFile(file.path)) !== hash(file)) throw new Error("RECIPE_EFFECT_SOURCE_FILE_CHANGED");
    if (effect.request.executable && hash(pinRecipeEffectFile(effect.request.executable.path, undefined, true)) !== hash(effect.request.executable))
      throw new Error("RECIPE_EFFECT_SOURCE_FILE_CHANGED");
    const decision = effect.decision;
    if (decision?.environment) {
      if (hash(selectRegisteredHostPythonEnvironment(decision.environment.registry.path, effect.request.workspaceId,
        effect.request.actorId, effect.request.environmentId!)) !== hash(decision.environment)
        || pinRecipeEffectFile(decision.environment.handle.target, undefined, true).sha256 !== decision.executableSha256)
        throw new Error("RECIPE_EFFECT_ENVIRONMENT_CHANGED");
    }
    if (beforeSpawn && (!decision || decision.expiresAtMs <= Date.now() || effect.request.deadline <= Date.now()))
      throw new Error("RECIPE_EFFECT_DECISION_EXPIRED");
  }
  const runtime = new RuntimeProcessService({
    repositoryFactory: (ownerId, capacity) => new RuntimeProcessStore(database, ownerId, capacity),
    adapters: [],
    authorizeLaunch: async request => {
      await options.refresh();
      const effect = effects.get(String((request.input as Record<string, unknown>).invocationId));
      if (request.actorId !== "mcp:external" || request.adapterId !== "original-recipe-owned-child" || !effect) return false;
      check(effect, true); return true;
    },
    resolveAdapter(id, input) {
      const effect = effects.get(String((input as Record<string, unknown>).invocationId));
      if (id !== "original-recipe-owned-child" || !effect?.decision) return undefined;
      const request = effect.request, compiled = compileWorkflowDefinitionV1(request.definition);
      const node = compiled.ok && compiled.model.spec.nodes.find(node => node.nodeId === request.nodeId);
      if (!node || node.kind !== "pkm.step.command/v1" && node.kind !== "pkm.step.script/v1") return undefined;
      return { id, executable: request.executable?.path ?? effect.decision.environment!.handle.executable,
        cwd: request.cwd.path, env: {}, stdin: request.script !== null, outputPersistence: "stored", processScope: "direct-child",
        outputLimits: { stdoutBytes: node.config.maxOutputBytes, stderrBytes: node.config.maxOutputBytes },
        arguments: () => request.script === null ? request.arguments : ["-I", "-B", "-", ...request.arguments],
        assertCurrent: () => check(effect, true) };
    },
  });
  function supported(binding: DefinitionBinding) {
    if (!options.authorize(binding)) return false;
    const node = binding.node;
    return (node.kind === "pkm.step.command/v1" || node.kind === "pkm.step.script/v1" && node.config.runtime === "python")
      && (!node.control || node.control.mode === "single" || !!options.executionSemantics)
      && (!node.dependsOn.some(edge => edge.loop) || options.executionSemantics === "original-recipe-metadata/v1")
      && node.config.timeoutSeconds <= 300 && node.config.maxOutputBytes <= 65536
      && (node.config.args ?? []).length <= 128
      && (node.kind !== "pkm.step.script/v1" || Buffer.byteLength(node.config.script) <= 16383);
  }
  function result(effect: Effect, value: Record<string, unknown>, succeeded: boolean) {
    effect.outputs = { result: value, nativeEffect: {
      invocationId: effect.request.invocationId, requestSha256: hash(effect.request),
      decisionId: effect.decision?.decisionId ?? null, jobId: effect.jobId ?? null,
      sourcePlanSha256: effect.request.sourcePlanSha256, automaticReplay: false,
    } };
    return { status: succeeded ? "succeeded" : "failed", outputs: effect.outputs };
  }
  const adapter: WorkflowStepAdapter = {
    id: "original-native-reviewed-recipe-owned-child", version: 1,
    outputContractDigest: hash("original-recipe-command-result/v1"),
    authorizationDigest: hash({ source: options.source.planSha256, scope: "exact-recipe-owned-direct-child/v1", replay: false }),
    authorizeDefinition: supported,
    authorizeData(binding) {
      if (!supported(binding)) return false;
      if (binding.candidate) {
        const receipt = binding.candidate.outputs.nativeEffect as Record<string, unknown> | undefined;
        const effect = receipt && effects.get(String(receipt.invocationId));
        const candidate = compileWorkflowDefinitionV1(options.definition);
        const node = candidate.ok && candidate.model.spec.nodes.find(node => node.nodeId === binding.candidate!.nodeId);
        if (node && (node.kind === "pkm.step.command/v1" || node.kind === "pkm.step.script/v1")) {
          if (!effect || effect.request.nodeId !== binding.candidate.nodeId || !effect.outputs
            || hash(effect.outputs) !== hash(binding.candidate.outputs)) return false;
          check(effect);
        }
      }
      return true;
    },
    validateOutput: outputs => !!outputs.result && typeof outputs.result === "object"
      && typeof (outputs.result as Record<string, unknown>).ok === "boolean"
      && typeof (outputs.result as Record<string, unknown>).stdout === "string"
      && typeof (outputs.result as Record<string, unknown>).stderr === "string",
    async execute(invocation: Readonly<WorkflowInvocation>, context) {
      options.assertCurrent(); await options.refresh();
      if (effects.size >= 4096 || effects.has(invocation.invocationId)) throw new Error("RECIPE_EFFECT_REPLAY_OR_LIMIT");
      const node = invocation.node;
      if (invocation.actorId !== "mcp:external" || node.kind !== "pkm.step.command/v1" && node.kind !== "pkm.step.script/v1")
        throw new Error("RECIPE_EFFECT_SOURCE_REQUIRED");
      const source = options.sourceForRun?.(invocation.runId)
        ?? { ...options.source, definition: options.definition };
      if (source.executableDigest !== invocation.executableDigest)
        throw new Error("RECIPE_EFFECT_SOURCE_CHANGED");
      const args = (node.config.args ?? []).map(arg => renderRecipeEffectText(arg, invocation.inputs));
      let executable: ReturnType<typeof pinRecipeEffectFile> | null = null;
      const sources: ReturnType<typeof pinRecipeEffectFile>[] = [];
      const cwd = pinRecipeEffectCwd(options.root, resolve(options.root, renderRecipeEffectText(node.config.cwd || ".", invocation.inputs)));
      const program = node.kind === "pkm.step.command/v1" ? renderRecipeEffectText(node.config.program, invocation.inputs) : null;
      if (node.kind === "pkm.step.command/v1") {
        const path = resolveActionExecutable(program!);
        if (!path) throw new Error("RECIPE_EFFECT_PROGRAM_UNAVAILABLE");
        assertRecipeEffectExecutable(path); executable = pinRecipeEffectFile(path, undefined, true);
        if (/^(?:node|nodejs|python(?:\d+(?:\.\d+)*)?)(?:\.exe)?$/i.test(basename(path))
          && args[0] && !args[0].startsWith("-"))
          sources.push(pinRecipeEffectFile(resolve(cwd.path, args[0]), 32768));
      }
      const request = originalRecipeEffectRequest.parse({
        schema: "pkm.original-recipe-effect-request/v1", root: options.root, actorId: "mcp:external",
        workspaceId: options.source.workspaceId, profileSha256: options.host.receipt.profileSha256,
        epoch: options.host.receipt.epoch, nativeHostReceiptSha256: options.host.receipt.receiptSha256,
        sourcePlanSha256: options.source.planSha256, sourceRecordSha256: source.recordSha256,
        recipeId: source.recipeId, revision: source.revision, executableDigest: invocation.executableDigest,
        runId: invocation.runId, nodeId: node.nodeId, invocationId: invocation.invocationId,
        definition: source.definition, inputs: invocation.inputs, inputsDigest: hash(invocation.inputs),
        sourceInputs: options.sourceInputs(invocation.runId), controlOutputs: invocation.previousOutputs,
        executionSemantics: options.executionSemantics ?? "static-original/v1",
        iteration: invocation.iteration, runtimeControl: invocation.runtimeControl ?? node.control ?? null, program,
        loopContext: invocation.loopContext ?? [],
        deadline: invocation.deadline, cwd, executable, sources, arguments: args,
        script: node.kind === "pkm.step.script/v1" ? renderRecipeEffectText(node.config.script, invocation.inputs) : null,
        environmentId: node.kind === "pkm.step.script/v1" ? node.config.environmentId : null,
        authority: { scope: "exact-recipe-owned-direct-child/v1", shell: false,
          inheritedEnvironment: false, credentials: false, automaticReplay: false },
      });
      const effect: Effect = { request, controller: new AbortController(), cancelled: false }; effects.set(invocation.invocationId, effect);
      const cancel = () => { effect.cancelled = true; effect.controller.abort();
        if (effect.jobId) void runtime.cancel(invocation.actorId, effect.jobId).catch(() => undefined); };
      context.signal.addEventListener("abort", cancel, { once: true }); options.signal.addEventListener("abort", cancel, { once: true });
      if (context.signal.aborted || options.signal.aborted) cancel();
      let watcher: ReturnType<typeof setInterval> | undefined, checking = false;
      try {
        const { receiptSha256: _receipt, ...binding } = options.host.receipt;
        const decision = assertOriginalRecipeEffectDecision(await requestOriginalMcpNative(options.session, originalRecipeEffectMethod,
          { binding, request }, { signal: AbortSignal.any([context.signal, options.signal, effect.controller.signal]),
            timeoutMs: Math.max(1, Math.min(120000, invocation.deadline - Date.now())) }), request);
        if (!decision) return result(effect, { ok: false, stdout: "", stderr: "", exitCode: null,
          error: "Separate native process effect permission denied; no child was started.", cancelled: false }, false);
        if (retiredDecisions.has(decision.decisionId)) throw new Error("RECIPE_EFFECT_DECISION_REPLAY");
        retiredDecisions.add(decision.decisionId); effect.decision = decision; check(effect, true);
        await options.refresh(); check(effect, true);
        options.approved(invocation.runId, invocation.invocationId, {
          schema: "pkm.original-recipe-native-effect-approval/v1", actorId: invocation.actorId,
          sourcePlanSha256: request.sourcePlanSha256, sourceRecordSha256: request.sourceRecordSha256,
          executableDigest: request.executableDigest, requestSha256: hash(request),
          executionSemantics: request.executionSemantics, iteration: request.iteration, runtimeControl: request.runtimeControl,
          loopContext: request.loopContext,
          executable: request.executable, sources: request.sources, cwd: request.cwd, decision,
          effect: "not-started", automaticReplay: false,
        });
        const job = await runtime.launch({ actorId: invocation.actorId, operationId: invocation.invocationId,
          adapterId: "original-recipe-owned-child", input: { invocationId: invocation.invocationId },
          deadlineMs: Math.max(1, Math.min(node.config.timeoutSeconds * 1000, invocation.deadline - Date.now())),
          ...(request.script === null ? {} : { stdin: Buffer.from(request.script + "\n") }) });
        effect.jobId = job.jobId;
        watcher = setInterval(() => {
          if (checking) return; checking = true;
          void options.refresh().then(() => check(effect)).catch(cancel).finally(() => { checking = false; });
        }, 100); watcher.unref();
        if (effect.cancelled) await runtime.cancel(invocation.actorId, job.jobId);
        const finished = await runtime.wait(invocation.actorId, job.jobId);
        await options.refresh(); check(effect);
        if (finished.effect === "unknown") throw new Error("RECIPE_EFFECT_OUTCOME_UNKNOWN");
        return result(effect, { ok: finished.state === "SUCCEEDED",
          stdout: Buffer.from(finished.stdout, "base64").toString("utf8"), stderr: Buffer.from(finished.stderr, "base64").toString("utf8"),
          exitCode: finished.exitCode, timedOut: finished.state === "TIMED_OUT", cancelled: finished.reason === "cancel",
          truncated: finished.stdoutDroppedBytes > 0 || finished.stderrDroppedBytes > 0,
          ...(finished.state === "SUCCEEDED" ? {} : { error: `Owned Recipe child ${finished.reason ?? finished.state}.` }) }, finished.state === "SUCCEEDED");
      } finally {
        clearInterval(watcher); context.signal.removeEventListener("abort", cancel); options.signal.removeEventListener("abort", cancel);
      }
    },
  };
  return Object.freeze({
    adapters: Object.freeze({ "pkm.step.command/v1": adapter, "pkm.step.script/v1": adapter }),
    async requestCancel(request: { runId: string; nodeId: string }) {
      options.assertCurrent();
      const effect = [...effects.values()].find(effect => effect.request.runId === request.runId
        && effect.request.nodeId === request.nodeId && !effect.outputs);
      if (!effect) throw new Error("No current owned Recipe process intent.");
      effect.cancelled = true; effect.controller.abort();
      if (effect.jobId) await runtime.cancel("mcp:external", effect.jobId);
    },
    close() {
      return closing ??= (async () => {
        for (const effect of effects.values()) effect.controller.abort();
        try { await runtime.close(); } finally { effects.clear(); retiredDecisions.clear(); database.close(); }
      })();
    },
  });
}
