import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type * as vscode from "vscode";
import type { CopilotClientOptions, ToolInvocation } from "@github/copilot-sdk";
import type { copilotSdkModels, copilotSdkPrompt, streamCopilotSdkChat, SdkModelInfo } from "../../legacy/src/chat/api-chat-copilot-sdk.js";
import {
  originalSdkCatalogue, originalSdkSelection, originalSdkDigest, measureOriginalSdkSerializedPayload,
  originalSdkExecutionBinding, type OriginalSdkChatPort, type OriginalSdkExecutionBinding,
  type OriginalSdkExecutionCallbacks, type OriginalSdkSendingBoundary, type OriginalSdkUnavailableStatus,
} from "../../src/original-mcp-sdk-model-contracts.js";
import { createOriginalSdkForwardingHandler, OriginalSdkForwardingError,
  type OriginalSdkRuntimeAdmission } from "./original-mcp-native-sdk-forwarding.js";
import { createOriginalSdkClientDeps } from "./original-mcp-native-sdk-client-deps.js";
import { assertOriginalSdkOwnedHostControlCurrent } from "./original-mcp-native-sdk-control.js";
import type { OriginalSdkEgressLease } from "./original-mcp-native-sdk-egress.js";

export interface OriginalSdkHostControl {
  prepareClient?: () => Promise<OriginalSdkEgressLease>;
  unavailableReason?: OriginalSdkUnavailableStatus["reason"];
  sdk: typeof import("@github/copilot-sdk");
  runtimeAdmission: OriginalSdkRuntimeAdmission;
  clientOptions: Readonly<CopilotClientOptions>;
  accountToken(interactiveRequested: boolean, signal: AbortSignal): Promise<string | undefined>;
  retained: { copilotSdkModels: typeof copilotSdkModels; copilotSdkPrompt: typeof copilotSdkPrompt;
    streamCopilotSdkChat: typeof streamCopilotSdkChat };
  host: typeof vscode;
  epoch: string; hostReceiptSha256: string; sourcePlanSha256: string;
  assertCurrent(): void;
  assertDestination(url: string, transport: "http" | "websocket"): void;
  approveBoundary(boundary: Readonly<OriginalSdkSendingBoundary>, signal: AbortSignal): Promise<void>;
}

/** One independently admitted SDK provider. The control port is client-owned, never a business grant or runtime proof DTO. */
export function createOriginalSdkChatPort(control: OriginalSdkHostControl): OriginalSdkChatPort {
  assertOriginalSdkOwnedHostControlCurrent(control);
  if (control.unavailableReason)
    throw new OriginalSdkForwardingError(control.unavailableReason.code, "not-sent");
  const selections = new Map<string, { selection: ReturnType<typeof originalSdkSelection.parse>; infos: SdkModelInfo[] }>();
  const invoked = new Set<string>(), pending = new Map<string, { boundary: OriginalSdkSendingBoundary; used: boolean; signal: AbortSignal }>();
  const fail: (code: string) => never = code => { throw new OriginalSdkForwardingError(code, "not-sent"); };
  const current = (signal: AbortSignal) => { control.assertCurrent(); if (signal.aborted) fail("NATIVE_SDK_CANCELLED"); };
  function guard(binding: OriginalSdkExecutionBinding, signal: AbortSignal,
    callbacks?: OriginalSdkExecutionCallbacks, confirmed?: Map<string, OriginalSdkSendingBoundary>) {
    return createOriginalSdkForwardingHandler(control.sdk, {
      runtimeAdmission: control.runtimeAdmission, runtimeClientOptions: control.clientOptions, binding, signal,
      assertCurrent(value) {
        current(signal);
        if (value.epoch !== control.epoch || value.hostReceiptSha256 !== control.hostReceiptSha256
          || value.sourcePlanSha256 !== control.sourcePlanSha256) fail("NATIVE_SDK_UNSUPPORTED_AUTHORITY");
      },
      assertDestination: control.assertDestination.bind(control),
      async approve(boundary, boundarySignal) {
        if (!callbacks || pending.has(boundary.boundaryId)) fail("NATIVE_SDK_UNSUPPORTED_AUTHORITY");
        const snapshot = structuredClone(boundary);
        pending.set(boundary.boundaryId, { boundary: snapshot, used: false, signal: boundarySignal });
        try {
          await callbacks.beforeSendingBoundary(snapshot);
          current(boundarySignal);
          if (!pending.get(boundary.boundaryId)?.used) fail("NATIVE_SDK_UNSUPPORTED_AUTHORITY");
          if (boundary.kind !== "websocket-connect") confirmed?.set(boundary.binding.sdkSessionId, structuredClone(boundary));
        } finally { pending.delete(boundary.boundaryId); }
      },
    });
  }
  function catalogueBinding() {
    const id = randomUUID();
    return originalSdkExecutionBinding.parse({
      provider: "copilot-sdk", admissionMode: "awaited-sdk-sending-boundary",
      requestId: id, selectionId: id, modelId: "vscode:copilot-sdk:catalogue", sdkSessionId: randomUUID(),
      epoch: control.epoch, hostReceiptSha256: control.hostReceiptSha256, sourcePlanSha256: control.sourcePlanSha256,
      planSha256: originalSdkDigest({ operation: "sdk.catalogue", epoch: control.epoch, id }),
      deadlineAtMs: Date.now() + 300000, budget: { maxRequestBytes: 16 * 1024 * 1024, maxSendingBoundaries: 1 },
    });
  }
  async function catalogue(signal: AbortSignal) {
    current(signal);
    const binding = catalogueBinding(), initial = guard(binding, signal);
    const deps = createOriginalSdkClientDeps({
      sdk: control.sdk, guard: initial, binding, sdkModelId: "catalogue", clientOptions: control.clientOptions,
      accountToken: control.accountToken.bind(control), signal, allowSummarySession: false,
      prepareClient: control.prepareClient,
      nextSessionGuard: () => fail("NATIVE_SDK_UNSUPPORTED_AUTHORITY"),
      beforeSession: async () => fail("NATIVE_SDK_UNSUPPORTED_AUTHORITY"),
      observeEvent() {}, withToolInvocation: async () => fail("NATIVE_SDK_UNSUPPORTED_AUTHORITY"),
    });
    try {
      const token = await deps.token(false);
      if (!token) fail("NATIVE_SDK_ACCOUNT_UNAVAILABLE");
      const { client } = await deps.client(), { models: infos } = await client.rpc.models.list({ gitHubToken: token });
      current(signal);
      const retained = control.retained.copilotSdkModels(infos);
      const models = retained.map(model => {
        const info = infos.find(info => info.id === model.id);
        if (!info) fail("NATIVE_SDK_MODEL_UNAVAILABLE");
        const limits = info.capabilities?.limits;
        const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
        return {
          provider: "copilot-sdk" as const, id: `vscode:copilot-sdk:${encodeURIComponent(info.id)}`,
          sdkModelId: info.id, label: info.name || info.id,
          routing: model.copilotSdk.routed ? "service-routed" as const : "fixed" as const,
          contextWindowTokens: positive(limits?.max_prompt_tokens), maxOutputTokens: positive(limits?.max_output_tokens),
          toolCalling: info.capabilities?.supports?.tool_calls ?? null, imageInput: info.capabilities?.supports?.vision ?? null,
        };
      });
      return { catalogue: originalSdkCatalogue.parse({ source: "copilot-sdk", epoch: control.epoch,
        registryRevision: originalSdkDigest(models), models }), infos };
    } finally { await deps.dispose(); }
  }
  const port: OriginalSdkChatPort = {
    async catalogue(signal) { return (await catalogue(signal)).catalogue; },
    async select(input, signal) {
      const fresh = await catalogue(signal);
      if (originalSdkDigest(fresh.catalogue) !== input.catalogueSha256 || selections.size >= 256)
        fail("NATIVE_SDK_STALE_CATALOGUE");
      const model = fresh.catalogue.models.find(model => model.id === input.modelId);
      if (!model) fail("NATIVE_SDK_MODEL_UNAVAILABLE");
      const selected = originalSdkSelection.parse({ provider: "copilot-sdk", selectionId: randomUUID(),
        epoch: control.epoch, catalogueSha256: input.catalogueSha256, model });
      selections.set(selected.selectionId, { selection: selected, infos: fresh.infos });
      return structuredClone(selected);
    },
    async measure(input, signal) {
      current(signal);
      if (!selections.has(input.selectionId)) fail("NATIVE_SDK_STALE_SELECTION");
      const prompt = control.retained.copilotSdkPrompt(input.messages.map(({ images, ...message }) => ({
        ...structuredClone(message), ...(images ? { images: structuredClone([...images]) } : {}),
      })));
      const measurement = measureOriginalSdkSerializedPayload(JSON.stringify({ prompt, tools: input.tools }));
      return { ...measurement, countingMethod: "sdk-prompt-utf8-bytes" as const };
    },
    async authorizeBoundary(input, signal) {
      current(signal);
      const intent = pending.get(input.boundaryId);
      if (!intent || intent.used || intent.signal.aborted || originalSdkDigest(intent.boundary) !== originalSdkDigest(input))
        fail("NATIVE_SDK_UNSUPPORTED_AUTHORITY");
      intent.used = true;
      await control.approveBoundary(structuredClone(intent.boundary), AbortSignal.any([signal, intent.signal]));
      current(signal);
    },
    async run(plan, callbacks, signal) {
      current(signal);
      const selected = selections.get(plan.selectionId);
      if (!selected || invoked.has(plan.requestId) || invoked.size >= 4096 || plan.epoch !== control.epoch
        || plan.hostReceiptSha256 !== control.hostReceiptSha256 || plan.sourcePlanSha256 !== control.sourcePlanSha256)
        fail("NATIVE_SDK_UNSUPPORTED_AUTHORITY");
      invoked.add(plan.requestId);
      const fresh = await catalogue(signal);
      if (originalSdkDigest(fresh.catalogue) !== selected.selection.catalogueSha256) fail("NATIVE_SDK_STALE_SELECTION");
      const model = control.retained.copilotSdkModels(fresh.infos).find(model => model.id === selected.selection.model.sdkModelId);
      if (!model) fail("NATIVE_SDK_MODEL_UNAVAILABLE");
      const abort = new AbortController(), combined = AbortSignal.any([signal, abort.signal]);
      const binding = originalSdkExecutionBinding.parse({
        provider: "copilot-sdk", admissionMode: "awaited-sdk-sending-boundary",
        requestId: plan.requestId, selectionId: plan.selectionId, modelId: selected.selection.model.id,
        sdkSessionId: randomUUID(), epoch: control.epoch, hostReceiptSha256: control.hostReceiptSha256,
        sourcePlanSha256: plan.sourcePlanSha256, planSha256: originalSdkDigest(plan),
        deadlineAtMs: plan.deadlineAtMs,
        budget: { maxRequestBytes: plan.budget.maxRequestBytes, maxSendingBoundaries: plan.budget.maxSendingBoundaries },
      });
      const invocation = new AsyncLocalStorage<ToolInvocation>();
      const confirmed = new Map<string, OriginalSdkSendingBoundary>();
      let eventSession: string | undefined, sequence = 0, sinkFailure: unknown;
      let hardReceipt: { limit: number; rounds: number; reached: boolean } | null = null;
      let sinks = Promise.resolve();
      const serialized = <T>(work: () => Promise<T>): Promise<T> => {
        const operation = sinks.then(work);
        sinks = operation.then(() => {}, error => { sinkFailure ??= error; abort.abort(); });
        return operation;
      };
      const sink = (work: () => Promise<void>) => {
        void serialized(work).catch(() => {});
      };
      const drain = async () => { await sinks; current(combined); if (sinkFailure) throw sinkFailure; };
      const ordered: OriginalSdkExecutionCallbacks = {
        ...callbacks,
        beforeSession: request => serialized(() => callbacks.beforeSession(request)),
        beforeSendingBoundary: request => serialized(() => callbacks.beforeSendingBoundary(request)),
      };
      const deps = createOriginalSdkClientDeps({
        sdk: control.sdk, guard: guard(binding, combined, ordered, confirmed), binding, sdkModelId: model.id,
        clientOptions: control.clientOptions, accountToken: control.accountToken.bind(control), signal: combined,
        prepareClient: control.prepareClient,
        allowSummarySession: plan.hardToolRoundLimit !== null,
        nextSessionGuard: next => guard(next, combined, ordered, confirmed),
        beforeSession: (next, ordinal, previousSessionId) => ordered.beforeSession({ binding: next, ordinal, previousSessionId }),
        observeEvent(sessionId) { eventSession = sessionId; },
        withToolInvocation: (context, work) => invocation.run(context, work),
      });
      try {
        await control.retained.streamCopilotSdkChat(model, {
          messages: plan.messages.map(({ images, ...message }) => ({
            ...structuredClone(message), ...(images ? { images: structuredClone([...images]) } : {}),
          })), signal: combined, timeoutMs: plan.budget.deadlineMs,
          maxOutputTokens: plan.outputTokenCap, hardToolRoundLimit: plan.hardToolRoundLimit ?? undefined,
          onHardToolRoundLimit(receipt) { hardReceipt = { ...receipt, reached: true }; },
          beforeWork: drain,
          tools: plan.tools.map(tool => ({
            name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters),
            async execute(args) {
              await drain();
              const actual = invocation.getStore();
              if (!actual || actual.toolName !== tool.name) fail("NATIVE_SDK_TOOL_BINDING_DENIED");
              const sending = confirmed.get(actual.sessionId);
              if (!sending) fail("NATIVE_SDK_TOOL_BINDING_DENIED");
              const result = await serialized(() => callbacks.tool({ callId: actual.toolCallId, name: tool.name,
                sdkSessionId: actual.sessionId, sendingBoundaryId: sending.boundaryId, provenance: "sdk-session-tool-invocation",
                arguments: z.record(z.string(), z.json()).parse(args), argumentsSha256: originalSdkDigest(args) }));
              if (result.effect === "unknown") { abort.abort(); fail("NATIVE_SDK_TOOL_OUTCOME_UNKNOWN"); }
              return result.content;
            },
          })),
          onUsage(usage) {
            const sdkSessionId = eventSession;
            if (!sdkSessionId) { abort.abort(); return; }
            const usageId = `${sdkSessionId}:${sequence++}`;
            sink(() => callbacks.usage({ sdkSessionId, usageId, source: "provider-reported", usage }));
          },
        }, text => {
          const sdkSessionId = eventSession;
          if (!sdkSessionId) { abort.abort(); return; }
          sink(() => callbacks.text({ sdkSessionId, text }));
        }, control.host, deps);
        await drain();
        return { status: "complete", toolRoundLimit: hardReceipt };
      } catch (error) {
        if (error instanceof OriginalSdkForwardingError) throw error;
        throw new OriginalSdkForwardingError("NATIVE_SDK_EXECUTION_FAILED", "uncertain");
      } finally { await deps.dispose(); }
    },
  };
  const admission = guard(catalogueBinding(), new AbortController().signal);
  admission.dispose();
  return Object.freeze(port);
}
