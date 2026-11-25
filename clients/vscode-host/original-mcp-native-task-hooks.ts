import {
  originalNativeTaskBinding, originalNativeTaskContextResult, OriginalNativeTaskSemanticError,
  type OriginalNativeManagedTaskExecutionPlan, type OriginalNativeTaskContextCallback,
  type OriginalNativeTaskContextResult,
} from "../../src/original-mcp-api-chat-task-execution-contracts.js";
import { originalNativeChatDigest } from "../../src/original-mcp-api-chat-contracts.js";

/** Hooks for the existing retained driver only. This module owns no model, tool, timer or inference loop. */
export function createOriginalNativeTaskRetainedHooks(plan: OriginalNativeManagedTaskExecutionPlan,
  context: OriginalNativeTaskContextCallback) {
  const binding = originalNativeTaskBinding.parse(plan.managedTask);
  const { bindingSha256, ...body } = binding;
  if (binding.requestId !== plan.requestId || binding.sourcePlanSha256 !== plan.sourcePlanSha256 || typeof context !== "function")
    throw new Error("NATIVE_TASK_CONTEXT_BINDING");
  if (originalNativeChatDigest(body) !== bindingSha256) throw new Error("NATIVE_TASK_CONTEXT_BINDING");
  const planSha256 = originalNativeChatDigest(plan);
  let latestRevision = binding.initialTaskRevision, afterRound: OriginalNativeTaskContextResult | undefined;
  let round = -1, inferenceId = "", hadTools = false, finalSummary = false, afterToolsObserved = false, closed = false;
  const ask = async (phase: "after-round" | "after-tools" | "settled") => {
    if (closed || round < 0 || !/^[a-f0-9]{64}$/.test(inferenceId)) throw new Error("NATIVE_TASK_CONTEXT_ORDER");
    const result = originalNativeTaskContextResult.parse(await context({
      phase, inferenceId, round, planSha256, bindingSha256: binding.bindingSha256,
      sourcePlanSha256: binding.sourcePlanSha256, hasToolCalls: hadTools, finalSummary,
    }));
    if (result.requestId !== plan.requestId || result.bindingSha256 !== binding.bindingSha256
      || result.planSha256 !== planSha256 || result.taskRevision < latestRevision)
      throw new Error("NATIVE_TASK_CONTEXT_BINDING");
    latestRevision = result.taskRevision;
    return result;
  };
  const rejected = (value: OriginalNativeTaskContextResult) => {
    if (value.decision === "reject") {
      closed = true; throw new OriginalNativeTaskSemanticError(value.errorCode ?? "TASK_STATE_INVALID");
    }
  };
  return Object.freeze({
    beginRound(input: { round: number; inferenceId: string; hasToolCalls: boolean; finalSummary: boolean }) {
      if (closed || input.round !== round + 1) throw new Error("NATIVE_TASK_CONTEXT_ORDER");
      round = input.round; inferenceId = input.inferenceId; hadTools = input.hasToolCalls; finalSummary = input.finalSummary;
      afterRound = undefined; afterToolsObserved = false;
    },
    async afterRound() { afterRound = await ask("after-round"); },
    beforeFinish(): string | undefined {
      if (closed || !afterRound || hadTools || finalSummary) throw new Error("NATIVE_TASK_CONTEXT_ORDER");
      rejected(afterRound);
      if (afterRound.decision === "finish") return undefined;
      if (!afterRound.continuation) throw new Error("NATIVE_TASK_CONTEXT_ORDER");
      return afterRound.continuation;
    },
    async afterTools() {
      if (!hadTools || !afterRound) throw new Error("NATIVE_TASK_CONTEXT_ORDER");
      const observed = await ask("after-tools"); rejected(observed); afterToolsObserved = true;
    },
    stopAfterTools(): boolean {
      if (!hadTools || !afterToolsObserved) throw new Error("NATIVE_TASK_CONTEXT_ORDER");
      return false;
    },
    async settled() {
      const result = await ask("settled"); rejected(result);
      closed = true;
      if (result.decision !== "finish" || result.goalStatus === "active")
        throw new OriginalNativeTaskSemanticError("GOAL_UNFINISHED");
    },
  });
}
