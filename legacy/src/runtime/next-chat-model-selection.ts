import * as vscode from "vscode";
import { modelProfiles, assertModelAvailable, type ChatModelProfile } from "../chat/api-chat-models";
import { assertVscodeModelCallable, vscodeModelProfile, type VscodeChatModel } from "../chat/api-chat-vscode";
import { discoverCopilotSdkModels, type CopilotSdkDeps, type CopilotSdkModel } from "../chat/api-chat-copilot-sdk";
import type { NextManagedClient } from "./next-managed-client";

function awaitSelection<T>(work: () => PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const complete = (error?: Error, value?: T) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve(value as T);
    };
    const cancel = () => complete(new Error("Selected Chat model selection was revoked."));
    const timer = setTimeout(() => complete(new Error("Selected Chat model selection timed out.")), 30000);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    try { Promise.resolve(work()).then(value => complete(undefined, value), () => complete(new Error("Selected Chat model selection failed."))); }
    catch { complete(new Error("Selected Chat model selection failed.")); }
  });
}

export async function selectedChatModel(context: vscode.ExtensionContext,
  chat: Awaited<ReturnType<NextManagedClient["listSelectedChats"]>>[number], signal?: AbortSignal,
  privateSdk?: () => Promise<CopilotSdkDeps>) {
  const cfg = vscode.workspace.getConfiguration("personalKnowledge");
  const provider = chat.modelProvider ?? cfg.get<string>("apiChatProvider", "openai-compatible");
  if (privateSdk && ["openai-compatible", "azure-openai"].includes(provider)) {
    const choice = await awaitSelection(() => vscode.window.showQuickPick([
      { label: "Use the configured HTTP model", sdk: false },
      { label: "Choose a VS Code or Copilot SDK model for this session", sdk: true },
    ], { title: "Choose the independent Chat model source", ignoreFocusOut: true }), signal);
    if (!choice) throw new Error("Independent Chat model selection was cancelled.");
    if (choice.sdk) return selectedChatModel(context, { ...chat, modelProvider: "vscode", vscodeModelId: null }, signal, privateSdk);
  }
  if (provider === "vscode") {
    const savedSdk = chat.vscodeModelId?.startsWith("vscode:copilot-sdk:") === true;
    const sdkPreferred = savedSdk && !!privateSdk;
    const models = (!sdkPreferred && vscode.lm?.selectChatModels ? await awaitSelection(() => vscode.lm.selectChatModels(), signal) : [] as VscodeChatModel[])
      .filter(model => model.vendor !== "copilotcli" && model.vendor !== "copilot-sdk");
    const choices = (models as VscodeChatModel[]).map(model => ({ model: model as VscodeChatModel | CopilotSdkModel, profile: vscodeModelProfile(model) }));
    let selected = chat.vscodeModelId ? choices.find(item => item.profile.id === chat.vscodeModelId) : undefined;
    let choose = !chat.vscodeModelId, discoverSdk = sdkPreferred;
    if (selected && privateSdk) {
      const source = await awaitSelection(() => vscode.window.showQuickPick([
        { label: `Use saved model: ${selected!.profile.label}`, mode: "saved" as const },
        { label: "Choose another VS Code model", mode: "native" as const },
        { label: "Discover Copilot SDK models", mode: "sdk" as const },
      ], { title: "Choose the independent Chat model", ignoreFocusOut: true }), signal);
      if (!source) throw new Error("Independent Chat model selection was cancelled.");
      if (source.mode === "native") { selected = undefined; choose = true; }
      if (source.mode === "sdk") { selected = undefined; discoverSdk = true; }
    }
    if (chat.vscodeModelId && !selected && !sdkPreferred) {
      choose = await awaitSelection(() => vscode.window.showWarningMessage("The saved VS Code model is unavailable for independent Chat.",
        { modal: true, detail: "Choose another model only for this independent session. Original Chat settings will not be changed." },
        "Choose Another Model"), signal) === "Choose Another Model";
    }
    if (choose) {
      const choice = await awaitSelection(() => vscode.window.showQuickPick(choices.map(item => ({
        label: item.profile.label, description: `${item.profile.contextWindow} input tokens`, item, sdk: false,
      })).concat(privateSdk ? [{ label: "Discover Copilot SDK models", description: "Requires GitHub account access",
        item: undefined as unknown as typeof choices[number], sdk: true }] : []),
      { title: "Choose a VS Code model for the independent Chat", ignoreFocusOut: true }), signal);
      if (choice?.sdk) discoverSdk = true;
      else selected = choice?.item;
    }
    if (discoverSdk) {
      if (!privateSdk) throw new Error("Private Copilot SDK runtime is unavailable.");
      const approval = await awaitSelection(() => vscode.window.showWarningMessage("Discover Copilot SDK models for this independent Chat?",
        { modal: true, detail: "This uses your GitHub account and an independent private SDK runtime. No original Chat settings are changed." },
        "Discover SDK Models"), signal);
      if (approval !== "Discover SDK Models") throw new Error("Copilot SDK discovery was not approved.");
      const deps = await privateSdk();
      const sdkModels = await awaitSelection(() => discoverCopilotSdkModels(vscode, signal, deps, true, false), signal);
      const sdkChoices = sdkModels.map(model => ({ model: model as VscodeChatModel | CopilotSdkModel,
        profile: vscodeModelProfile(model as unknown as VscodeChatModel) }));
      selected = savedSdk ? sdkChoices.find(item => item.profile.id === chat.vscodeModelId) : undefined;
      if (savedSdk && !selected && await awaitSelection(() => vscode.window.showWarningMessage("The saved Copilot SDK model is unavailable.",
        { modal: true, detail: "Choose another model only for this independent session. Original Chat settings will not be changed." },
        "Choose Another SDK Model"), signal) !== "Choose Another SDK Model")
        throw new Error("The selected Copilot SDK model is unavailable; no fallback was used.");
      if (!selected) {
        const choice = await awaitSelection(() => vscode.window.showQuickPick(sdkChoices.map(item => ({
          label: item.profile.label, description: `${item.profile.contextWindow} input tokens`, item,
        })), { title: "Choose a Copilot SDK model for the independent Chat", ignoreFocusOut: true }), signal);
        selected = choice?.item;
      }
    }
    if (!selected) throw new Error("The selected VS Code model is unavailable; no fallback was used.");
    if (selected.model.vendor !== "copilot-sdk") assertVscodeModelCallable(selected.model.vendor);
    const contextWindow = Math.min(chat.contextWindow || selected.profile.contextWindow, selected.profile.contextWindow);
    const maxOutputTokens = Math.min(chat.maxOutputTokens || selected.profile.maxOutputTokens,
      selected.profile.maxOutputTokens, 4096, Math.floor(contextWindow / 4));
    const toolCapability = selected.model.capabilities?.toolCalling;
    const vscodeTools = toolCapability !== false && (typeof toolCapability !== "number" || toolCapability >= 4);
    return { configuration: { provider: "vscode" as const, endpoint: "", model: selected.model.id,
      vscodeModelId: selected.profile.id, apiKey: "", contextWindow, maxOutputTokens, outputTokenParameter: "max_tokens" as const,
      includeUsage: false, status: "active" as const, timeoutMs: 1800000, vscodeTools,
      vscodeImageInput: selected.model.capabilities?.imageInput === true }, vscodeModel: selected.model };
  }
  if (!["openai-compatible", "azure-openai"].includes(provider)) throw new Error("The selected model provider is unavailable.");
  const defaultModel = cfg.get<string>("aiModel", "gpt-4o-mini");
  const saved = context.globalState.get<{ provider: string; profile: ChatModelProfile }>("apiChat.defaultModel");
  const values = cfg.get<unknown>("apiChatModelProfiles", []);
  const entries = Array.isArray(values) ? values : [];
  const remembered = saved?.provider === provider && saved.profile?.id === chat.modelProfileId ? saved.profile : undefined;
  const profiles = modelProfiles([...entries, ...(remembered && !entries.some(item => item?.id === remembered.id) ? [remembered] : [])],
    [defaultModel, ...cfg.get<string[]>("apiChatModels", []), chat.modelProfileId ?? ""]);
  const profile = profiles.find(item => item.id === (chat.modelProfileId || defaultModel));
  if (!profile) throw new Error("The selected Chat model profile is unavailable.");
  for (const alias of profiles.filter(item => item.model === profile.model)) assertModelAvailable(alias);
  const timeoutSeconds = cfg.get<number>("apiChatTimeoutSeconds", 1800);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds > 1800)
    throw new Error("Next Chat requires a model timeout no longer than 1800 seconds.");
  return { configuration: {
    provider: provider as "openai-compatible" | "azure-openai",
    endpoint: cfg.get<string>("aiEndpoint", ""), model: profile.model,
    apiVersion: cfg.get<string>("aiAzureApiVersion", "2024-06-01"),
    apiKey: await awaitSelection(() => context.secrets.get("personalKnowledge.aiApiKey"), signal) ?? "",
    contextWindow: chat.contextWindow || profile.contextWindow, maxOutputTokens: chat.maxOutputTokens || profile.maxOutputTokens,
    outputTokenParameter: profile.outputTokenParameter, includeUsage: profile.includeUsage, status: profile.status,
    ...(profile.deprecatedAt ? { deprecatedAt: profile.deprecatedAt } : {}),
    timeoutMs: Math.max(10, timeoutSeconds) * 1000,
  } };
}
