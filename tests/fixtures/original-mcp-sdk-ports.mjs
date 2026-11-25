import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { originalSdkDigest, measureOriginalSdkSerializedPayload } from "../../dist/original-mcp-sdk-model-contracts.js";

/** Explicit SDK protocol fixtures, not a genuine SDK model, account, runtime, native approval or role authority. */
export function originalSdkProtocolFixture(epoch) {
  const model = { provider: "copilot-sdk", id: "vscode:copilot-sdk:fixture-auto", sdkModelId: "fixture-auto",
    label: "SDK protocol fixture", routing: "service-routed", contextWindowTokens: null,
    maxOutputTokens: null, toolCalling: true, imageInput: false };
  const state = { catalogues: 0, selections: 0, measurements: 0, authorizations: 0, sends: 0, toolResults: [], runs: 0 };
  let mode = "normal", authorize = async () => {};
  const sdk = {
    async catalogue() {
      state.catalogues++;
      return { source: "copilot-sdk", epoch: epoch(), registryRevision: "sdk-fixture-registry", models: [structuredClone(model)] };
    },
    async select(input) {
      const catalogue = { source: "copilot-sdk", epoch: epoch(), registryRevision: "sdk-fixture-registry", models: [model] };
      assert.equal(input.catalogueSha256, originalSdkDigest(catalogue)); assert.equal(input.modelId, model.id);
      state.selections++;
      return { provider: "copilot-sdk", epoch: epoch(), selectionId: randomUUID(),
        catalogueSha256: input.catalogueSha256, model: structuredClone(model) };
    },
    async measure(input) {
      state.measurements++;
      return { ...measureOriginalSdkSerializedPayload(JSON.stringify({ messages: input.messages, tools: input.tools })),
        countingMethod: "sdk-prompt-utf8-bytes" };
    },
    async authorizeBoundary(input, signal) { state.authorizations++; await authorize(input, signal); signal.throwIfAborted(); },
    async run(plan, callbacks, signal) {
      state.runs++;
      const binding = { provider: "copilot-sdk", admissionMode: "awaited-sdk-sending-boundary",
        requestId: plan.requestId, selectionId: plan.selectionId, modelId: model.id, sdkSessionId: randomUUID(),
        epoch: plan.epoch, hostReceiptSha256: plan.hostReceiptSha256, sourcePlanSha256: plan.sourcePlanSha256,
        planSha256: mode === "wrong-plan" ? "f".repeat(64) : originalSdkDigest(plan), deadlineAtMs: plan.deadlineAtMs,
        budget: { maxSendingBoundaries: plan.budget.maxSendingBoundaries, maxRequestBytes: plan.budget.maxRequestBytes } };
      const body = { schema: "pkm.original-sdk-sending-boundary/v1", binding, sdkRequestId: randomUUID(),
        sdkInvocationId: randomUUID(), kind: "http-request",
        measurement: measureOriginalSdkSerializedPayload('{"fixture":"serialized bytes, not a model request"}'),
        authority: "model-sending-boundary-only" };
      const boundary = { ...body, boundaryId: originalSdkDigest(body) };
      const args = { id: "Entry" }, call = { sdkSessionId: binding.sdkSessionId, sendingBoundaryId: boundary.boundaryId,
        provenance: "sdk-session-tool-invocation", callId: randomUUID(), name: "get_document",
        arguments: args, argumentsSha256: originalSdkDigest(args) };
      if (mode === "forged-tool-json") { await callbacks.tool(JSON.parse(JSON.stringify(call))); throw new Error("Unadmitted SDK tool callback was accepted."); }
      await callbacks.beforeSession({ binding, ordinal: 0, previousSessionId: null });
      await callbacks.beforeSendingBoundary(boundary);
      signal.throwIfAborted(); state.sends++;
      if (plan.tools.length) state.toolResults.push(await callbacks.tool(call));
      await callbacks.text({ sdkSessionId: binding.sdkSessionId, text: "SDK signed transport fixture text, not an actual model response." });
      await callbacks.usage({ sdkSessionId: binding.sdkSessionId, usageId: randomUUID(),
        source: "provider-reported", usage: { inputTokens: 7, outputTokens: 2 } });
      return { status: "complete", toolRoundLimit: null };
    },
  };
  return { sdk, state, model, mode(value) { mode = value; }, authorize(value) { authorize = value; } };
}

export function unavailableNativeModelFixture(epoch) {
  return {
    models: { async catalogue() { return { source: "vscode.lm", epoch: epoch(), models: [] }; },
      async select() { throw new Error("SDK test must not select a native LM."); },
      async count() { throw new Error("SDK bytes must not invoke native countTokens."); },
      async *stream() { throw new Error("SDK test must not invoke native LM."); } },
    execution: { async run() { throw new Error("SDK test must not fall through native execution."); } },
  };
}
