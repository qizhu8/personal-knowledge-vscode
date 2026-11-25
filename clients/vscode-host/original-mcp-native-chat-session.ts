import * as vscode from "vscode";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createOriginalMcpNativeChatProducer } from "./original-mcp-native-chat.js";
import type { OriginalMcpNativeChatSession, OriginalMcpNativeChatFrame } from "../../src/original-mcp-native-chat-rpc.js";
import { originalVscodeModelRequestDigest, originalNativeChatDigest } from "../../src/original-mcp-api-chat-contracts.js";
import {
  originalNativeChatResolve, originalNativeChatPresentation, originalNativeChatRequest,
  originalNativeChatMemoryRequest, originalNativeChatMemoryChoice,
  type OriginalNativeChatMemoryPort, type OriginalNativeChatSessionPort, type OriginalVscodeChatModelPort,
} from "../../src/original-mcp-api-chat-contracts.js";
import { memoryText } from "../../src/memory-contracts.js";
import type { OriginalNativeTaskContextCallback } from "../../src/original-mcp-api-chat-task-execution-contracts.js";
import type { OriginalManagedTaskAdoptionPort } from "../../src/managed-chat-task-adoption-contracts.js";
import { originalSdkChatSelection, originalSdkDigest, type OriginalSdkChatPort,
  type originalSdkCatalogue } from "../../src/original-mcp-sdk-model-contracts.js";
import type { z } from "zod";
import type { OriginalSdkHostControl } from "./original-mcp-native-sdk-chat.js";

type Selection = Awaited<ReturnType<OriginalNativeChatSessionPort["resolve"]>>;
type Catalogue = Awaited<ReturnType<OriginalVscodeChatModelPort["catalogue"]>>;
type Consent = (title: string, detail: object, signal: AbortSignal, affirmative?: string) => Promise<void>;
function notSent(code: string): never {
  throw Object.assign(new Error(code), { code, dispatch: "not-sent" });
}

/** An attachment owns these bindings; historical permission/model settings never create one. */
export function createOriginalMcpNativeChatSessionProducer(context: vscode.ExtensionContext, options: {
  session: OriginalMcpNativeChatSession;
  signal: AbortSignal;
  assertCurrent(): void;
  models: OriginalVscodeChatModelPort;
  sdk?: OriginalSdkChatPort;
  approve: Consent;
}): OriginalNativeChatSessionPort & OriginalManagedTaskAdoptionPort {
  const pending = new Map<string, {
    input: Parameters<OriginalNativeChatSessionPort["resolve"]>[0];
    selection?: Selection; catalogue?: Catalogue | z.infer<typeof originalSdkCatalogue>; modelSha256?: string;
    status: "resolving" | "resolved" | "adopting" | "authorizing" | "authorized" | "presenting" | "presented" | "retired";
    operation?: string;
    memoryChoice?: Awaited<ReturnType<OriginalNativeChatMemoryPort["select"]>>;
    memorySelecting?: boolean;
    memoryRequest?: Parameters<OriginalNativeChatMemoryPort["select"]>[0];
    adoption?: { request: Parameters<OriginalManagedTaskAdoptionPort["adopt"]>[0];
      decision: Awaited<ReturnType<OriginalManagedTaskAdoptionPort["adopt"]>> };
  }>();
  const bindings = new Map<string, Selection>(), documents = new Map<string, string>();
  let adoptionDto: Promise<typeof import("../../src/managed-chat-task-adoption-contracts.js")> | undefined;
  const adoptionContracts = () => adoptionDto ??= import(pathToFileURL(
    join(context.extensionPath, "next-runtime/server/dist/managed-chat-task-adoption-contracts.js")).href);
  let sourcePlanSha256: string | undefined, provider: vscode.Disposable | undefined;
  const scheme = `pkm-native-chat-${options.session.activationId}`;
  const revoke = () => { pending.clear(); bindings.clear(); documents.clear(); provider?.dispose(); provider = undefined; };
  options.signal.addEventListener("abort", revoke, { once: true });
  context.subscriptions.push({ dispose() { revoke(); options.signal.removeEventListener("abort", revoke); } });
  function current(signal: AbortSignal) {
    options.assertCurrent();
    if (signal.aborted || options.signal.aborted) notSent("NATIVE_CHAT_CANCELLED");
  }
  async function wait<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
    current(signal);
    const combined = AbortSignal.any([signal, options.signal]);
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("NATIVE_CHAT_CANCELLED"), { dispatch: "not-sent" }));
      combined.addEventListener("abort", abort, { once: true });
      Promise.resolve(work).then(value => {
        try { current(signal); resolve(value); } catch (error) { reject(error); }
      }, reject).finally(() => combined.removeEventListener("abort", abort));
      if (combined.aborted) abort();
    });
  }
  function source(digest: string) {
    if (sourcePlanSha256 && sourcePlanSha256 !== digest) notSent("NATIVE_CHAT_SOURCE_CHANGED");
    sourcePlanSha256 = digest;
  }
  async function catalogue(signal: AbortSignal) {
    current(signal);
    const value = await options.models.catalogue(signal);
    current(signal);
    if (value.epoch !== options.session.epoch) notSent("NATIVE_CHAT_MODEL_EPOCH");
    return value;
  }
  async function exact(state: NonNullable<ReturnType<typeof pending.get>>, signal: AbortSignal) {
    const fresh = state.selection?.provider === "copilot-sdk"
      ? await sdkCatalogue(signal) : await catalogue(signal);
    const model = fresh.models.find(item => item.id === state.selection!.modelId);
    if (!model || originalNativeChatDigest(model) !== state.modelSha256
      || originalNativeChatDigest(fresh) !== originalNativeChatDigest(state.catalogue))
      notSent("NATIVE_CHAT_STALE_MODEL");
    const bound = state.input.chatUrl ? bindings.get(state.input.chatUrl) : undefined;
    if (bound && originalNativeChatDigest(bound) !== originalNativeChatDigest(state.input.expectedSelection))
      notSent("NATIVE_CHAT_BINDING_CHANGED");
  }
  async function sdkCatalogue(signal: AbortSignal) {
    current(signal);
    if (!options.sdk) notSent("NATIVE_SDK_RUNTIME_INCOMPATIBLE");
    const value = await options.sdk.catalogue(signal);
    current(signal);
    if (value.epoch !== options.session.epoch) notSent("NATIVE_CHAT_MODEL_EPOCH");
    return value;
  }
  async function resolveSdk(state: NonNullable<ReturnType<typeof pending.get>>, signal: AbortSignal) {
    const input = state.input, fresh = await sdkCatalogue(signal);
    let id = input.requestedModelId;
    if (!id) {
      const selected = await wait(vscode.window.showQuickPick(fresh.models.map(model => ({
        label: model.label, description: model.id, detail: `Copilot SDK / ${model.routing}; no native token count`,
      })), { title: "Select exact SDK model; routed Auto stays service-routed", ignoreFocusOut: true }), signal);
      if (!selected) notSent("NATIVE_DENIED");
      id = selected.description!;
    }
    const model = fresh.models.find(model => model.id === id);
    if (!model || input.expectedSelection && (input.expectedSelection.provider !== "copilot-sdk"
      || input.expectedSelection.wireModelId !== model.sdkModelId)) notSent("NATIVE_CHAT_EXACT_MODEL_REQUIRED");
    const selection = originalSdkChatSelection.parse({
      protocol: "pkm.original-sdk-api-chat-execution/v1", provider: "copilot-sdk", epoch: options.session.epoch,
      modelId: model.id, wireModelId: model.sdkModelId, permissionMode: "protective",
      outputTokenCap: Math.min(model.maxOutputTokens ?? 8192, 8192),
      budget: { maxRequestBytes: 16 * 1024 * 1024, maxSendingBoundaries: 256,
        maxTotalOutputTokens: 32768, deadlineMs: 300000 },
    });
    if (input.expectedSelection && originalSdkDigest(selection) !== originalSdkDigest(input.expectedSelection))
      notSent("NATIVE_CHAT_BINDING_CHANGED");
    Object.assign(state, { selection, catalogue: structuredClone(fresh), modelSha256: originalSdkDigest(model) });
    await wait(options.approve("Bind this exact SDK model to this PKM Chat?", {
      requestId: input.requestId, chatUrl: input.chatUrl, sourcePlanSha256: input.sourcePlanSha256,
      selection, model,
      permission: "SDK identity, not vscode.lm. No native countTokens, per-inference approval or known/free cost claim. HTTP/WebSocket sending needs independently awaited current approval. Tools and humans retain separate authority.",
    }, signal), signal);
    await exact(state, signal); state.status = "resolved";
    return structuredClone(selection);
  }
  return Object.freeze({
    memory: Object.freeze({
      async select(value: Parameters<OriginalNativeChatMemoryPort["select"]>[0], signal: AbortSignal) {
        const input = originalNativeChatMemoryRequest.parse(value);
        current(signal); source(input.sourcePlanSha256);
        const state = pending.get(input.requestId);
        if (!state || state.status !== "resolved" || state.memoryChoice || state.memorySelecting || state.adoption
          || input.chatUrl !== state.input.chatUrl
          || originalNativeChatDigest(input.selection) !== originalNativeChatDigest(state.selection))
          notSent("NATIVE_CHAT_MEMORY_BINDING");
        state.memorySelecting = true;
        state.memoryRequest = structuredClone(input);
        const binding = { requestId: input.requestId, epoch: options.session.epoch,
          bindingSha256: originalNativeChatDigest(input) };
        const finish = (choice: Awaited<ReturnType<OriginalNativeChatMemoryPort["select"]>>) => {
          current(signal);
          state.memoryChoice = originalNativeChatMemoryChoice.parse(choice);
          return structuredClone(state.memoryChoice);
        };
        try {
          await exact(state, signal);
          const choice = await wait(vscode.window.showQuickPick([
            { label: "No live Memory recall (default)", description: "off", picked: true,
              detail: "Retained inline references remain archival. No live Memory reader is invoked." },
            { label: "Select live Memory for this exact request", description: "live",
              detail: input.scope ?? "Independent same-owner Memory source admission is not available." },
          ], { title: "Native PKM Chat: explicitly select live Memory?", ignoreFocusOut: true }), signal);
          if (!choice) return finish({ ...binding, mode: "refused", reason: "denied" });
          if (choice.description === "off") return finish({ ...binding, mode: "off" });
          if (choice.description !== "live") notSent("NATIVE_CHAT_MEMORY_BINDING");
          if (!input.scope) return finish({ ...binding, mode: "refused", reason: "source-not-admitted" });
          const query = await wait(vscode.window.showInputBox({
            title: "Exact native Memory query", ignoreFocusOut: true, value: input.proposedQuery ?? "",
            prompt: `Scope ${input.scope}. Literal query, 1–512 UTF-8 bytes; at most 3 full confirmed records. No query is truncated.`,
            validateInput: value => memoryText(512).safeParse(value).success ? undefined : "Enter 1–512 well-formed UTF-8 bytes.",
          }), signal);
          if (query === undefined) return finish({ ...binding, mode: "refused", reason: "denied" });
          if (!memoryText(512).safeParse(query).success)
            return finish({ ...binding, mode: "refused", reason: "invalid-query" });
          try {
            await wait(options.approve("Use this independently admitted live Memory scope for this exact native Chat request?", {
              ...input, proposedQuery: undefined, query, limit: 3, bindingSha256: binding.bindingSha256,
              permission: "Quoted Memory context only. This does not admit a missing Memory source, authorize writes, or grant model/tool permission.",
            }, signal), signal);
          } catch (error) {
            current(signal);
            if (error instanceof Error && "code" in error && error.code === "NATIVE_DENIED")
              return finish({ ...binding, mode: "refused", reason: "denied" });
            throw error;
          }
          await exact(state, signal);
          return finish({ ...binding, mode: "live", scope: input.scope, query, limit: 3 });
        } finally { state.memorySelecting = false; }
      },
    }),
    async resolve(value: Parameters<OriginalNativeChatSessionPort["resolve"]>[0], signal: AbortSignal) {
      const input = originalNativeChatResolve.parse(value);
      current(signal); source(input.sourcePlanSha256);
      if (pending.has(input.requestId)) notSent("NATIVE_CHAT_REQUEST_REPLAY");
      if (pending.size >= 4096) notSent("NATIVE_CHAT_REQUEST_LEDGER_FULL");
      const state: NonNullable<ReturnType<typeof pending.get>> = { input, status: "resolving" };
      pending.set(input.requestId, state);
      try {
        if (input.requestedModelId.startsWith("vscode:copilot-sdk:") || input.expectedSelection?.provider === "copilot-sdk")
          return await resolveSdk(state, signal);
        const found = await catalogue(signal);
        const bound = input.chatUrl ? bindings.get(input.chatUrl) : undefined;
        if (bound && (!input.expectedSelection
          || originalNativeChatDigest(bound) !== originalNativeChatDigest(input.expectedSelection)))
          notSent("NATIVE_CHAT_BINDING_CHANGED");
        if (input.expectedSelection && (input.expectedSelection.provider !== "vscode"
          || input.requestedModelId !== input.expectedSelection.modelId))
          notSent("NATIVE_CHAT_EXACT_MODEL_REQUIRED");
        let id = input.requestedModelId;
        if (!id) {
          const entries = found.models.map(model => ({
            label: model.label, description: model.id, detail: `${model.vendor} / ${model.family} / ${model.version}`,
          }));
          if (options.sdk) entries.push({ label: "Copilot SDK models", description: "sdk-picker",
            detail: "Independent provider; requires verified awaited HTTP/WebSocket runtime admission." });
          const choice = await wait(vscode.window.showQuickPick(entries,
            { title: "Choose an exact model for this PKM Chat", ignoreFocusOut: true }), signal);
          if (!choice) notSent("NATIVE_DENIED");
          if (choice.description === "sdk-picker") return await resolveSdk(state, signal);
          id = choice.description!;
        }
        const model = found.models.find(item => item.id === id);
        if (!model || input.expectedSelection && model.nativeModelId !== input.expectedSelection.wireModelId)
          notSent("NATIVE_CHAT_EXACT_MODEL_REQUIRED");
        const outputTokenCap = Math.min(model.maxOutputTokens ?? 8192, 8192);
        const selection: Selection = {
          protocol: "pkm.original-api-chat-execution/v1", epoch: options.session.epoch,
          modelId: model.id, wireModelId: model.nativeModelId, provider: "vscode", permissionMode: "protective",
          outputTokenCap, budget: { maxInputTokens: model.maxInputTokens, maxTotalOutputTokens: 32768, deadlineMs: 300000 },
        };
        Object.assign(state, { selection, catalogue: structuredClone(found), modelSha256: originalNativeChatDigest(model) });
        await wait(options.approve("Bind this exact native VS Code model to this PKM Chat?", {
          requestId: input.requestId, chatUrl: input.chatUrl, sourcePlanSha256: input.sourcePlanSha256,
          model, selection, permission: "Selection grants no inference, tool execution, or historical permission.",
        }, signal), signal);
        await exact(state, signal);
        current(signal); state.status = "resolved";
        return structuredClone(selection);
      } catch (error) { state.status = "retired"; throw error; }
    },
    async adopt(value: Parameters<OriginalManagedTaskAdoptionPort["adopt"]>[0], signal: AbortSignal) {
      const { originalManagedTaskAdoptionRequest, originalManagedTaskAdoptionDecision } = await adoptionContracts();
      const input = originalManagedTaskAdoptionRequest.parse(value);
      current(signal); source(input.sourcePlanSha256);
      const state = pending.get(input.requestId), goal = input.original.goal;
      if (!state || state.status !== "resolved" || state.adoption || state.memoryChoice || state.memorySelecting
        || state.input.expectedSelection !== null || !input.chatUrl || state.input.chatUrl !== input.chatUrl
        || state.input.sourcePlanSha256 !== input.sourcePlanSha256
        || originalNativeChatDigest(state.selection) !== originalNativeChatDigest(input.selection)
        || !goal || typeof goal !== "object" || Array.isArray(goal)
        || typeof goal.executionDigest !== "string" || typeof goal.inputId !== "string"
        || input.previousExecutionDigest !== goal.executionDigest
        || input.chatUrl !== `pkm://chats/${input.original.namespace}/${input.original.chatId}`
        || !input.original.sourceInputIds.includes(goal.inputId))
        notSent("NATIVE_CHAT_ADOPTION_BINDING");
      state.status = "adopting";
      const decision = (choice: "adopt-and-revalidate" | "deny") => originalManagedTaskAdoptionDecision.parse({
        decision: choice, actorId: "mcp:external", decisionId: randomUUID(), expiresAtMs: Date.now() + 300000,
        requestId: input.requestId, epoch: options.session.epoch, bindingSha256: originalNativeChatDigest(input),
      });
      try {
        await exact(state, signal);
        try {
          await wait(options.approve("Adopt this exact original PKM Task and revalidate its Goal?", {
            ...input,
            permission: "Preserve only these exact original Chat/Task/Goal/input identities and historical text. "
              + "The old model, permissions, verified acceptance and tool/Harness evidence are not current authority. "
              + "Rebind to this fresh native context and reset all current acceptance. "
              + "This review grants no send, inference, tool execution, worker/Recipe/file-version/image authority or Task completion.",
          }, signal, "Adopt this exact goal and reset acceptance"), signal);
        } catch (error) {
          current(signal);
          if (error instanceof Error && "code" in error && error.code === "NATIVE_DENIED") {
            state.status = "retired"; return decision("deny");
          }
          throw error;
        }
        await exact(state, signal); current(signal);
        const approved = decision("adopt-and-revalidate");
        state.adoption = { request: structuredClone(input), decision: approved };
        state.status = "resolved";
        return structuredClone(approved);
      } catch (error) { state.status = "retired"; throw error; }
    },
    async authorize(value: Parameters<OriginalNativeChatSessionPort["authorize"]>[0], signal: AbortSignal) {
      const input = originalNativeChatRequest.parse(value);
      current(signal); source(input.sourcePlanSha256);
      if (input.operation === "cancel") {
        if (!input.chatUrl || input.selection !== null || pending.has(input.requestId))
          notSent("NATIVE_CHAT_REQUEST_BINDING");
        if (pending.size >= 4096) notSent("NATIVE_CHAT_REQUEST_LEDGER_FULL");
        pending.set(input.requestId, { input: {
          requestId: input.requestId, requestedModelId: "", chatUrl: input.chatUrl,
          sourcePlanSha256: input.sourcePlanSha256, expectedSelection: null,
        }, status: "retired", operation: "cancel" });
        await wait(options.approve("Cancel this exact owned native PKM Chat request?", input, signal), signal);
        return true;
      }
      const state = pending.get(input.requestId);
      if (!state || state.status !== "resolved" || !input.selection || input.sourceUncertain
        || state.memorySelecting || state.memoryChoice?.mode === "refused"
        || state.adoption && (input.operation !== "send" || state.adoption.decision.decision !== "adopt-and-revalidate"
          || state.adoption.decision.expiresAtMs <= Date.now() || state.adoption.decision.epoch !== options.session.epoch
          || state.adoption.request.commandId !== input.commandId
          || state.adoption.request.argumentsSha256 !== input.argumentsSha256)
        || state.memoryRequest && state.memoryRequest.argumentsSha256 !== input.argumentsSha256
        || input.chatUrl !== state.input.chatUrl || input.sourcePlanSha256 !== state.input.sourcePlanSha256
        || originalNativeChatDigest(input.selection) !== originalNativeChatDigest(state.selection)
        || input.operation === "create" && input.chatUrl !== null
        || input.operation === "send" && input.chatUrl === null)
        notSent("NATIVE_CHAT_REQUEST_BINDING");
      state.status = "authorizing";
      try {
        await exact(state, signal);
        await wait(options.approve(input.operation === "create"
          ? "Create this native PKM Chat with the selected model?"
          : "Send this exact request to the bound native PKM Chat?", {
          ...input, ...(state.memoryChoice ? { liveMemory: state.memoryChoice } : {}),
          permission: "No model dispatch has occurred. Each inference and Core tool needs its separate admission.",
        }, signal), signal);
        await exact(state, signal);
        current(signal); state.status = "authorized"; state.operation = input.operation;
        if (input.chatUrl) bindings.set(input.chatUrl, structuredClone(input.selection));
        return true;
      } catch (error) { state.status = "retired"; throw error; }
    },
    async present(value: Parameters<OriginalNativeChatSessionPort["present"]>[0], signal: AbortSignal) {
      const input = originalNativeChatPresentation.parse(value);
      current(signal); source(input.sourcePlanSha256);
      const state = pending.get(input.requestId);
      if (!state || state.status !== "authorized" || state.operation !== "create"
        || state.input.chatUrl !== null || input.sourcePlanSha256 !== state.input.sourcePlanSha256
        || originalNativeChatDigest(input.selection) !== originalNativeChatDigest(state.selection)
        || bindings.has(input.chatUrl)) notSent("NATIVE_CHAT_PRESENTATION_BINDING");
      state.status = "presenting";
      try {
        await exact(state, signal);
        if (!provider) provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
          provideTextDocumentContent(uri) {
            current(options.signal);
            const text = documents.get(uri.toString());
            if (text === undefined) notSent("NATIVE_CHAT_PRESENTATION_BINDING");
            return text;
          },
        });
        const uri = vscode.Uri.from({ scheme, path: `/${input.requestId}/binding.txt` });
        documents.set(uri.toString(), [
          "PKM native Chat binding", "", `Chat: ${input.chatUrl}`, `Model: ${input.selection.modelId}`,
          `${input.selection.provider === "copilot-sdk" ? "SDK model" : "Native model"}: ${input.selection.wireModelId}`,
          `Permission: ${input.selection.permissionMode}`,
          `Root: ${options.session.binding.root}`, `Workspace: ${options.session.binding.workspaceId}`,
          `Profile: ${options.session.binding.profileSha256}`, `Source: ${input.sourcePlanSha256}`,
          `Activation: ${options.session.activationId}`, `Create request: ${input.requestId}`, "",
          "Read-only binding snapshot. Every operation rechecks the live attachment; this document grants no authority.",
          "This is not a restored legacy Chat editor or a grant to run models/tools.",
          "Use api_chat_send and api_chat_request_get for this exact Chat; native consent is required.",
        ].join("\n"));
        const document = await wait(vscode.workspace.openTextDocument(uri), signal);
        await wait(vscode.window.showTextDocument(document, { preview: false }), signal);
        current(signal);
        bindings.set(input.chatUrl, structuredClone(input.selection)); state.status = "presented";
      } catch (error) { state.status = "retired"; throw error; }
    },
  });
}

/** Separate explicit native consent; attachment and public-read admission grant no model execution. */
export async function enableOriginalMcpNativeChatSession(context: vscode.ExtensionContext, options: {
  session: OriginalMcpNativeChatSession;
  signal: AbortSignal;
  assertCurrent(): void;
  send(frame: OriginalMcpNativeChatFrame): Promise<void>;
  close(): Promise<void>;
  diagnostics: Pick<vscode.OutputChannel, "appendLine">;
  sdkControl?: OriginalSdkHostControl;
}) {
  function current(signal: AbortSignal = options.signal) {
    options.assertCurrent();
    if (signal.aborted || options.signal.aborted) throw new Error("NATIVE_CHAT_CANCELLED");
  }
  async function approve(title: string, detail: object, signal: AbortSignal, affirmative = "Allow this native model request") {
    current(signal);
    const answerPromise = vscode.window.showWarningMessage(title, {
      modal: true, detail: JSON.stringify({
        root: options.session.binding.root, workspaceId: options.session.binding.workspaceId,
        profileSha256: options.session.binding.profileSha256, ...detail,
      }, null, 2),
    }, affirmative, "Deny");
    const combined = AbortSignal.any([signal, options.signal]);
    const answer = await new Promise<string | undefined>((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("NATIVE_CHAT_CANCELLED"), { dispatch: "not-sent" }));
      combined.addEventListener("abort", abort, { once: true });
      Promise.resolve(answerPromise).then(resolve, reject).finally(() => combined.removeEventListener("abort", abort));
      if (combined.aborted) abort();
    });
    current(signal);
    if (answer !== affirmative)
      throw Object.assign(new Error("Native model access was denied."), { code: "NATIVE_DENIED", dispatch: "not-sent" });
  }
  await approve("Enable the native VS Code model channel for this PKM session?", {
    permission: "Discover and count actual native models. Every selection and model execution needs a separate native confirmation. No HTTP fallback or business/tool permission is granted.",
  }, options.signal);
  if (options.sdkControl) await approve("Enable this independent SDK model catalogue?", {
    provider: "copilot-sdk",
    permission: "Discover models through the separately approved current-user account and qualified runtime only. This does not sign in, select/switch a model, approve sending, copy grants or authorize tools. SDK measurements are bytes, not native countTokens.",
  }, options.signal, "Enable this SDK catalogue");
  const sdkControl = options.sdkControl ? {
    ...options.sdkControl,
    assertCurrent() {
      current(); options.sdkControl!.assertCurrent();
      if (options.sdkControl!.epoch !== options.session.epoch) notSent("NATIVE_SDK_UNSUPPORTED_AUTHORITY");
    },
    async approveBoundary(boundary: Parameters<OriginalSdkHostControl["approveBoundary"]>[0], signal: AbortSignal) {
      await approve("Approve this exact SDK sending boundary?", {
        provider: "copilot-sdk", ...boundary,
        disclosure: "Exact UTF-8 serialized bytes and digest, not token counts or an inference count. Service-routed models may choose a backend. Provider costs remain unknown until usage reports; this grants no canonical tool or human approval.",
      }, signal, "Allow this exact SDK sending boundary");
    },
  } : undefined;
  const producer = await createOriginalMcpNativeChatProducer(context, options.diagnostics, sdkControl);
  current();
  const apiChat = createOriginalMcpNativeChatSessionProducer(context, {
    ...options, models: producer.models, sdk: producer.sdk, approve,
  });
  const pendingInferences = new Map<string, { model: string; signal: AbortSignal; used: boolean }>();
  const protocol: typeof import("../../src/original-mcp-native-chat-rpc.js") = await import(pathToFileURL(
    join(context.extensionPath, "next-runtime/server/dist/original-mcp-native-chat-rpc.js")).href);
  if (typeof protocol.createOriginalMcpNativeChatProducerChannel !== "function")
    throw new Error("MISSING_NATIVE_METHOD: The verified native model protocol is missing.");
  const runExecution = async (...[plan, ports, signal]: Parameters<typeof producer.execution.run>) => {
    const taskContext = ports.taskContext;
    if ("managedTask" in plan && !taskContext) notSent("MISSING_NATIVE_METHOD");
    await approve("Run this native PKM Chat request with the displayed limits?", {
      requestId: plan.requestId, chatUrl: plan.chatUrl, selectionId: plan.selectionId,
      sourcePlanSha256: plan.sourcePlanSha256, planSha256: originalNativeChatDigest(plan),
      messages: plan.messages.length, tools: plan.tools.map(tool => tool.name),
      hardToolRoundLimit: plan.hardToolRoundLimit, outputTokenCap: plan.outputTokenCap, budget: plan.budget,
      ...("managedTask" in plan ? { managedTask: plan.managedTask } : {}),
      permission: "The owning Core must admit every inference and approve each tool separately. Unknown old work is not replayed. A model response does not complete a managed Task.",
    }, signal);
    return producer.execution.run(plan, {
      beforeInference: async request => { current(signal); await ports.beforeInference(request); current(signal); },
      tool: async request => { current(signal); const result = await ports.tool(request); current(signal); return result; },
      text: async request => { current(signal); await ports.text(request); current(signal); },
      usage: async request => { current(signal); await ports.usage(request); current(signal); },
      ...(taskContext ? { taskContext: async (request: Parameters<OriginalNativeTaskContextCallback>[0]) => {
        current(signal); const result = await taskContext(request); current(signal); return result;
      } } : {}),
    }, signal, async (model, request, dispatch) => {
      current(signal);
      const digest = request.requestSha256;
      if (pendingInferences.has(digest)) throw new Error("NATIVE_CHAT_REQUEST_DIGEST");
      const intent = { model, signal, used: false };
      pendingInferences.set(digest, intent);
      try { await dispatch(); }
      finally { pendingInferences.delete(digest); }
    });
  };
  const channelOptions = {
    ...options,
    apiChat,
    models: {
      async catalogue(signal: AbortSignal) {
        current(signal);
        try { return await producer.models.catalogue(signal); }
        catch (error) {
          const code = error instanceof Error && /^NATIVE_CHAT_[A-Z_]+$/.test(error.message)
            ? error.message : "NATIVE_MODEL_PROVIDER_FAILED";
          console.error(`Native model catalogue failed (${code}); no model request was sent.`);
          throw error;
        }
      },
      async select(input: Parameters<OriginalVscodeChatModelPort["select"]>[0], signal: AbortSignal) {
        await approve("Select this exact native VS Code model?", input, signal);
        return producer.models.select(input, signal);
      },
      count: (input: Parameters<OriginalVscodeChatModelPort["count"]>[0], signal: AbortSignal) => { current(signal); return producer.models.count(input, signal); },
      async *stream(input: Parameters<OriginalVscodeChatModelPort["stream"]>[0], signal: AbortSignal) {
        const requestSha256 = originalVscodeModelRequestDigest({
          selectionId: input.selectionId, requestId: input.requestId, messages: input.messages,
          tools: input.tools, outputTokenCap: input.outputTokenCap,
        });
        if (input.requestSha256 !== requestSha256) throw new Error("NATIVE_CHAT_REQUEST_DIGEST");
        await approve("Send this exact inference to the selected native VS Code model?", {
          selectionId: input.selectionId, requestId: input.requestId, requestSha256,
          messages: input.messages.length, tools: input.tools.map(tool => tool.name), outputTokenCap: input.outputTokenCap,
          disclosure: "Counts and digest summarize this request; they are not the complete transcript.",
        }, signal);
        for await (const event of producer.models.stream(input, signal)) {
          current(signal); yield event;
        }
      },
    },
    execution: { run: runExecution, managedTask: { run: runExecution } },
    ...(producer.sdkUnavailable ? { async sdkStatus(signal: AbortSignal) {
      current(signal); return structuredClone(producer.sdkUnavailable!);
    } } : {}),
    ...(producer.sdk ? { sdk: {
      catalogue: producer.sdk.catalogue.bind(producer.sdk),
      select: producer.sdk.select.bind(producer.sdk),
      measure: producer.sdk.measure.bind(producer.sdk),
      authorizeBoundary: producer.sdk.authorizeBoundary.bind(producer.sdk),
      async run(...[plan, callbacks, signal]: Parameters<OriginalSdkChatPort["run"]>) {
        current(signal);
        await approve("Run this exact SDK PKM Chat plan?", {
          provider: "copilot-sdk", requestId: plan.requestId, planSha256: originalSdkDigest(plan),
          sourcePlanSha256: plan.sourcePlanSha256, selectionId: plan.selectionId, budget: plan.budget,
          outputTokenCap: plan.outputTokenCap, hardToolRoundLimit: plan.hardToolRoundLimit,
          tools: plan.tools.map(tool => tool.name),
          permission: "Every actual sending boundary waits for Core durability and separate native approval. No automatic replay, native token count, tool grant or human approval.",
        }, signal);
        return producer.sdk!.run(plan, callbacks, signal);
      },
    } } : {}),
  };
  const channel = protocol.createOriginalMcpNativeChatProducerChannel(channelOptions);
  return {
    ...channel,
    claimInference(model: string, digest: string) {
      const intent = pendingInferences.get(digest);
      if (!intent || intent.used || intent.model !== model || intent.signal.aborted || options.signal.aborted) return false;
      intent.used = true;
      return true;
    },
  };
}
