import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import { ChatInferenceClock } from "./chat-inference-timing";
import { ApiChatMessage, ApiChatRequest, ApiChatToolEvent, ChatToolLoopGuard, chatInferenceOutputByteLimit, chatTransportReceipt, toolBudgetSummary } from "./api-chat-client";
import { ChatTokenUsage, checkReportedOutput } from "./api-chat-models";
import { abortable } from "./api-chat-tools";

/** VS Code model-list vendor for models served through the Copilot SDK runtime bundled with VS Code. */
export const copilotSdkVendor = "copilot-sdk";
const imageTokenAllowance = 2_000;
const modelCacheMs = 10 * 60_000;

export interface CopilotSdkModel {
  readonly vendor: typeof copilotSdkVendor;
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly version: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly capabilities: { toolCalling: boolean; imageInput: boolean };
  /** Routed models (Auto, HydraFusion) let the Copilot service pick the concrete model per turn. */
  readonly copilotSdk: { routed: boolean };
  sendRequest(): never;
  countTokens(): never;
}

interface SdkEvent { id?: string; type: string; data?: Record<string, unknown> }
interface SdkSession {
  readonly sessionId: string;
  on(handler: (event: SdkEvent) => void): () => void;
  send(options: { prompt: string; attachments?: unknown[]; mode?: "enqueue" | "immediate"; source?: "system" }): Promise<string>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}
interface SdkClient {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  createSession(config: Record<string, unknown>): Promise<SdkSession>;
  deleteSession?(sessionId: string): Promise<void>;
  rpc: { models: { list(params: { gitHubToken: string }): Promise<{ models: SdkModelInfo[] }> } };
}
export interface SdkModelInfo {
  id: string; name?: string;
  capabilities?: { family?: string; limits?: { max_prompt_tokens?: number; max_output_tokens?: number }; supports?: { tool_calls?: boolean; vision?: boolean; reasoning_effort?: unknown } };
  policy?: { state?: string };
  billing?: { tokenPrices?: { maxPromptTokens?: number } };
}
interface SdkModule {
  CopilotClient: new (options: Record<string, unknown>) => SdkClient;
  RuntimeConnection: { forStdio(options: { path: string }): unknown };
  defineTool(name: string, config: Record<string, unknown>): unknown;
}

/** Injectable runtime access so tests never spawn the real runtime or read real credentials. */
export interface CopilotSdkDeps {
  client(): Promise<{ sdk: SdkModule; client: SdkClient }>;
  token(interactive: boolean): Promise<string | undefined>;
}

class CopilotSdkChatError extends Error {}

function platformPackages(): string[] {
  const id = `${process.platform}-${process.arch}`;
  if (process.platform !== "linux") return [id];
  // VS Code installs its matching platform package. A process report also enumerates network interfaces
  // and can block the extension host for minutes; no report is needed to find an installed runtime.
  return [`linux-${process.arch}`, `linuxmusl-${process.arch}`];
}

type RuntimeLocation = { sdkDir: string; cliPath: string };

function* runtimeCandidates(appRoot: string | undefined, executablePath: string): Generator<{ location: RuntimeLocation; required: string[] }> {
  // Remote hosts may expose the client's appRoot; their Node executable lives in the server installation.
  const roots = [...new Set([appRoot, path.dirname(executablePath)].filter((root): root is string => !!root))];
  for (const modules of roots.flatMap(root => ["node_modules", "node_modules.asar.unpacked"].map(name => path.join(root, name)))) {
    const sdkDir = path.join(modules, "@github", "copilot-sdk");
    const manifest = path.join(sdkDir, "package.json");
    for (const cliPath of [...platformPackages().map(id => path.join(modules, "@github", `copilot-${id}`, "index.js")), path.join(modules, "@github", "copilot", "index.js")]) {
      yield { location: { sdkDir, cliPath }, required: [manifest, cliPath] };
    }
    // Newer SDKs ship a native runtime in @github/copilot-sdk-<platform>. Their own glibc/musl probe relies on
    // process.report, which is unreliable inside the extension host, so the installed package is chosen here.
    const wrapper = process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime";
    for (const id of platformPackages()) {
      const nativePath = path.join(modules, "@github", `copilot-sdk-${id}`, "prebuilds", id);
      const cliPath = path.join(nativePath, wrapper);
      yield { location: { sdkDir, cliPath }, required: [manifest, cliPath, path.join(nativePath, "runtime.node")] };
    }
  }
}

/** Locates bundled runtime paths synchronously; interactive bootstrap uses asynchronous checks. */
export function locateCopilotSdkRuntime(appRoot: string | undefined, executablePath = process.execPath): RuntimeLocation | undefined {
  for (const { location, required } of runtimeCandidates(appRoot, executablePath)) {
    if (required.every(file => fs.existsSync(file))) return location;
  }
  return undefined;
}

async function locateCopilotSdkRuntimeAsync(appRoot: string | undefined): Promise<RuntimeLocation | undefined> {
  const checks = new Map<string, Promise<boolean>>();
  const exists = (file: string) => {
    let check = checks.get(file);
    if (!check) { check = fs.promises.access(file).then(() => true, () => false); checks.set(file, check); }
    return check;
  };
  for (const { location, required } of runtimeCandidates(appRoot, process.execPath)) {
    if ((await Promise.all(required.map(exists))).every(Boolean)) return location;
  }
  return undefined;
}

let storageRoot: string | undefined;
type SharedRuntime = { client: Promise<{ sdk: SdkModule; client: SdkClient }>; stop?: () => Promise<unknown>; disposed?: boolean };
let shared: SharedRuntime | undefined;
let modelCache: { at: number; models: CopilotSdkModel[] } | undefined;

export function configureCopilotSdk(options: { storageDir: string }): void { storageRoot = options.storageDir; }

export async function disposeCopilotSdk(): Promise<void> {
  const current = shared;
  shared = undefined; modelCache = undefined;
  if (current) current.disposed = true;
  if (current?.stop) await current.stop().catch(() => undefined);
}

function defaultDeps(host: typeof vscode): CopilotSdkDeps {
  return {
    client: () => {
      if (shared) return shared.client;
      const entry: SharedRuntime = { client: Promise.resolve().then(async () => {
        const runtime = await locateCopilotSdkRuntimeAsync(host.env?.appRoot);
        if (!runtime) throw new CopilotSdkChatError("The Copilot SDK runtime is not available in this VS Code installation.");
        const baseDirectory = path.join(storageRoot || path.join(os.homedir(), ".pkm"), "copilot-sdk");
        await fs.promises.mkdir(baseDirectory, { recursive: true, mode: 0o700 });
        // This directory is private to PKM; transcripts left by an interrupted host are removed before reuse.
        await fs.promises.rm(path.join(baseDirectory, "session-state"), { recursive: true, force: true }).catch(() => undefined);
        // Let the picker paint before the SDK's unavoidable synchronous CommonJS import.
        await new Promise<void>(resolve => setImmediate(resolve));
        if (entry.disposed) throw new CopilotSdkChatError("Request cancelled.");
        const sdk = createRequire(__filename)(runtime.sdkDir) as SdkModule;
        // In desktop VS Code the extension host executable is Electron; the runtime script must run as plain Node.
        const client = new sdk.CopilotClient({ mode: "empty", useLoggedInUser: false, logLevel: "error", baseDirectory, workingDirectory: baseDirectory,
          connection: sdk.RuntimeConnection.forStdio({ path: runtime.cliPath }), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
        let stopping: Promise<unknown> | undefined;
        entry.stop = () => stopping ??= Promise.resolve().then(() => client.stop());
        try { await client.start(); }
        catch (error) {
          await entry.stop().catch(() => undefined);
          const reason = String((error as Error)?.message || error).split("\n")[0].slice(0, 200);
          throw new CopilotSdkChatError(`The Copilot SDK runtime bundled with VS Code failed to start: ${reason}`);
        }
        if (entry.disposed) { await entry.stop().catch(() => undefined); throw new CopilotSdkChatError("Request cancelled."); }
        return { sdk, client };
      }) };
      entry.client.catch(() => { if (shared === entry) shared = undefined; });
      shared = entry;
      return entry.client;
    },
    token: async interactive => {
      if (!host.authentication?.getSession) return undefined;
      const session = await host.authentication.getSession("github", ["user:email"], interactive ? { createIfNone: true } : {});
      return session?.accessToken;
    },
  };
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Maps the runtime catalog. Models without their own limits are service-routed and inherit the tightest limits of the models they can route to. */
export function copilotSdkModels(infos: SdkModelInfo[]): CopilotSdkModel[] {
  const unavailable = (): never => { throw new CopilotSdkChatError("Copilot SDK models are called through the Copilot SDK runtime, not the VS Code Language Model API."); };
  const enabled = infos.filter(info => info.id && (!info.policy?.state || info.policy.state === "enabled"));
  const concrete = enabled.flatMap(info => {
    const limits = info.capabilities?.limits || {};
    const prompt = Math.min(...[limits.max_prompt_tokens, info.billing?.tokenPrices?.maxPromptTokens].filter(positive));
    return Number.isSafeInteger(prompt) && prompt >= 256 ? [{ info, prompt, output: positive(limits.max_output_tokens) ? limits.max_output_tokens : 4096 }] : [];
  });
  const model = (info: SdkModelInfo, prompt: number, output: number, toolCalling: boolean, imageInput: boolean, routed: boolean): CopilotSdkModel => ({
    vendor: copilotSdkVendor, id: info.id, name: info.name || info.id, family: info.capabilities?.family || info.id, version: info.id,
    maxInputTokens: prompt, maxOutputTokens: output, capabilities: { toolCalling, imageInput }, copilotSdk: { routed }, sendRequest: unavailable, countTokens: unavailable,
  });
  const routed = concrete.length ? enabled.filter(info => !concrete.some(item => item.info === info) && !info.capabilities?.limits).map(info =>
    model(info, Math.min(...concrete.map(item => item.prompt)), Math.min(...concrete.map(item => item.output)), true,
      concrete.some(item => item.info.capabilities?.supports?.vision === true), true)) : [];
  return [...routed, ...concrete.map(({ info, prompt, output }) =>
    model(info, prompt, output, info.capabilities?.supports?.tool_calls !== false, info.capabilities?.supports?.vision === true, false))];
}

export function isCopilotSdkModel(model: unknown): model is CopilotSdkModel {
  return !!model && typeof model === "object" && (model as { vendor?: unknown }).vendor === copilotSdkVendor && "copilotSdk" in model;
}

/** Passive discovery never prompts; the model picker provides an explicit connection/consent entry. */
export async function discoverCopilotSdkModels(host: typeof vscode = vscode, signal?: AbortSignal, deps: CopilotSdkDeps = defaultDeps(host), interactive = false): Promise<CopilotSdkModel[]> {
  if (signal?.aborted) throw new CopilotSdkChatError("Request cancelled.");
  if (!interactive && modelCache && Date.now() - modelCache.at < modelCacheMs) return modelCache.models;
  try {
    const tokenRequest = deps.token(interactive);
    const token = signal ? await abortable(tokenRequest, signal) : await tokenRequest;
    if (signal?.aborted) throw new CopilotSdkChatError("Request cancelled.");
    if (!token) throw new CopilotSdkChatError("Copilot SDK needs GitHub account access. Choose Connect Copilot SDK in the model picker to sign in and grant access.");
    const pending = deps.client().then(({ client }) => {
      if (signal?.aborted) throw new CopilotSdkChatError("Request cancelled.");
      return client.rpc.models.list({ gitHubToken: token });
    });
    const { models } = signal ? await abortable(pending, signal) : await pending;
    if (signal?.aborted) throw new CopilotSdkChatError("Request cancelled.");
    const result = copilotSdkModels(models);
    if (!result.length) throw new CopilotSdkChatError("The Copilot SDK returned no usable models for this account.");
    modelCache = { at: Date.now(), models: result };
    return result;
  } catch (error) {
    if (signal?.aborted) throw new CopilotSdkChatError("Request cancelled.");
    if (interactive) {
      if (error instanceof CopilotSdkChatError) throw error;
      throw new CopilotSdkChatError("Cannot discover Copilot SDK models. Check GitHub sign-in, Copilot access and the runtime bundled with this VS Code installation.");
    }
    console.warn("[PKM Copilot SDK]", error instanceof CopilotSdkChatError ? error.message : "Model discovery failed. Use Connect Copilot SDK in the model picker to retry interactively.");
    return [];
  }
}

type CopilotSdkChatRequest = Pick<ApiChatRequest, "messages" | "signal" | "timeoutMs" | "maxOutputTokens" | "thinkingBudget" | "maxToolRounds" | "loopReviewAfterMs" | "loopReviewClock" | "loopExemptTools" | "onToolLoopNotice" | "contextWindow" | "tools" | "onTool" | "beforeRound" | "beforeFinish" | "automaticKnowledge" | "onTransportPrepared" | "onTransportSent" | "afterTools" | "onStage" | "onModelActivity" | "onUsage" | "onUsageMetadata" | "onInferenceTiming" | "onOutputBudgetWarning" | "onThinking">;

/** The runtime keeps no PKM history: each request is a fresh session seeded with a transcript of earlier turns. */
export function copilotSdkPrompt(messages: ApiChatMessage[]): { system: string; prompt: string; images: NonNullable<ApiChatMessage["images"]> } {
  const system = messages.filter(message => message.role === "system").map(message => message.content).join("\n\n");
  const turns = messages.filter(message => message.role !== "system");
  let last = turns.length - 1;
  while (last >= 0 && turns[last].role !== "user") last--;
  const render = (message: ApiChatMessage) => {
    const lines = [message.content];
    for (const call of message.tool_calls || []) lines.push(`[called tool ${call.function.name} (${call.id}) with ${call.function.arguments}]`);
    for (const image of message.images || []) lines.push(`[image omitted: ${image.label}]`);
    const role = message.role === "tool" ? `tool result ${message.tool_call_id || ""}`.trim() : message.role;
    return `### ${role}\n${lines.filter(Boolean).join("\n")}`;
  };
  const history = turns.filter((_, index) => index !== last).map(render).join("\n\n");
  const current = last >= 0 ? turns[last].content : "";
  return {
    system,
    prompt: history ? `Earlier conversation, for context only:\n<conversation>\n${history}\n</conversation>\n\nCurrent user message:\n${current}` : current,
    images: last >= 0 ? turns[last].images || [] : [],
  };
}

function usageFromEvent(data: Record<string, unknown>): ChatTokenUsage | undefined {
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const input = count(data.inputTokens), output = count(data.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  const cached = count(data.cacheReadTokens), reasoning = count(data.reasoningTokens);
  const nanoAiu = count((data.copilotUsage as { totalNanoAiu?: unknown } | undefined)?.totalNanoAiu);
  return { inputTokens: input, outputTokens: output, ...(cached !== undefined && cached <= input ? { cachedInputTokens: cached } : {}),
    ...(reasoning !== undefined && reasoning <= output ? { reasoningTokens: reasoning } : {}), ...(nanoAiu !== undefined ? { copilotNanoAiu: nanoAiu } : {}) };
}

export async function streamCopilotSdkChat(model: CopilotSdkModel, request: CopilotSdkChatRequest, onText: (text: string) => void,
  host: typeof vscode = vscode, deps: CopilotSdkDeps = defaultDeps(host)): Promise<void> {
  const { signal } = request;
  const loop = new ChatToolLoopGuard(request);
  const clock = new ChatInferenceClock("vscode", request.onInferenceTiming);
  let session: SdkSession | undefined;
  let client: SdkClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let failure: Error | undefined;
  let stopped = false;
  let settle: (() => void) | undefined;
  const finish = (error?: Error) => { if (error && !failure && !stopped) failure = error; settle?.(); };
  const stopSession = () => { void session?.abort().catch(() => undefined); };
  const cancel = () => { stopSession(); finish(new CopilotSdkChatError("Request cancelled.")); };
  const activity = () => {
    if (signal.aborted) return;
    clock.activity();
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; stopSession(); finish(new CopilotSdkChatError("timeout")); }, request.timeoutMs ?? 1_800_000);
  };
  const text = (value: unknown) => typeof value === "string" ? value.slice(0, 80) : "";
  const openRouting = new Map<string, string>();
  const routing = (label: string, status: "running" | "complete" | "failed", key?: string) => {
    request.onModelActivity?.({ operation: "model-access", label, status: "running" });
    if (status === "running") { if (key) openRouting.set(key, label); }
    else request.onModelActivity?.({ operation: "model-access", label, status });
  };
  const routingDone = (status: "complete" | "failed", key?: string) => {
    for (const [open, label] of [...openRouting]) if (key ? open === key : open.startsWith("fusion:")) {
      openRouting.delete(open);
      request.onModelActivity?.({ operation: "model-access", label, status });
    }
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new CopilotSdkChatError("Request cancelled.");
    if (request.tools?.length && !model.capabilities.toolCalling) throw new CopilotSdkChatError("This Copilot SDK model does not support tool calling. Disable tools or select a tool-capable model.");
    const remaining = request.maxOutputTokens ?? model.maxOutputTokens;
    if (!Number.isSafeInteger(remaining) || remaining < 1) throw new CopilotSdkChatError("Choose a positive per-inference output token budget.");
    const messages = [...request.messages];
    await loop.beforeRound(0, signal);
    try { request.beforeRound?.(messages, remaining); }
    catch (error) { throw new CopilotSdkChatError(error instanceof Error ? error.message : "Context budget exceeded."); }
    const { system, prompt, images } = copilotSdkPrompt(messages);
    if (images.length && !model.capabilities.imageInput) throw new CopilotSdkChatError("This Copilot SDK model does not accept image input. Select a vision-capable model.");
    const tools = request.tools || [];
    const schemas = tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    const inputBudget = (request.contextWindow === undefined ? model.maxInputTokens : Math.min(request.contextWindow, model.maxInputTokens)) - remaining;
    // Byte-level tokenizers never produce more tokens than UTF-8 bytes; images get a fixed allowance and make the count an estimate.
    const textBound = 96 + Buffer.byteLength(system, "utf8") + Buffer.byteLength(prompt, "utf8") + (schemas.length ? Buffer.byteLength(JSON.stringify(schemas), "utf8") + 32 : 0);
    const transport = chatTransportReceipt("vscode", [system, prompt, ...images.map(image => ({ label: image.label, mimeType: image.mimeType }))], schemas,
      textBound + images.length * imageTokenAllowance, images.length ? "utf8-byte-estimate" : "utf8-byte-upper-bound");
    if (request.automaticKnowledge) {
      const knowledgeBudget = request.automaticKnowledge;
      const knowledgeTokens = messages.reduce((sum, message) => knowledgeBudget.includes(message) ? sum + Buffer.byteLength(message.content, "utf8") + 32 : sum, 32);
      if (!Number.isSafeInteger(knowledgeBudget.inputBudget) || knowledgeBudget.inputBudget < 32 || knowledgeTokens > knowledgeBudget.inputBudget) throw new CopilotSdkChatError("Automatic PKM reference input budget exceeded; no model request was sent.");
      transport.automaticKnowledge = { inputBudget: knowledgeBudget.inputBudget, inputTokens: knowledgeTokens, countingMethod: "utf8-byte-upper-bound" };
    }
    if (!Number.isSafeInteger(inputBudget) || transport.inputTokens > inputBudget) throw new CopilotSdkChatError(`${images.length ? "Image context" : "Native context"} budget exceeded. Remove optional context or increase Context.`);
    try { request.onTransportPrepared?.(transport); }
    catch (error) { throw new CopilotSdkChatError(error instanceof Error ? error.message : "Transport receipt persistence failed."); }
    request.onOutputBudgetWarning?.("Copilot SDK models do not expose output token counting. The per-inference token limit is checked from provider usage; the separate 100,000-byte inference output limit remains active. Bytes are not tokens.");
    request.onStage?.("connecting");
    request.onModelActivity?.({ operation: "model-access", label: "Starting Copilot SDK session", status: "running" });
    const token = await abortable(deps.token(true), signal);
    if (!token) throw new CopilotSdkChatError("GitHub sign-in is required for Copilot SDK models. Sign in from the Accounts menu and allow PKM to use your GitHub account.");
    const runtime = await abortable(deps.client(), signal);
    client = runtime.client;

    let round = -1;
    let turnBytes = 0;
    let thinkingBytes = 0;
    let summaryTurn: number | undefined;
    let pendingCalls = 0;
    const streamedMessages = new Set<string>();
    const completedMessages = new Set<string>();
    const seenEvents = new Set<string>();
    const turnRounds = new Map<string, number>();
    let lastAssistant: { text: string; calls: number } | undefined;
    let toolQueue: Promise<unknown> = Promise.resolve();
    const names = new Set(tools.map(tool => tool.name));
    const runTool = async (name: string, args: unknown, callId: string, turn: number): Promise<string> => {
      const tool = tools.find(item => item.name === name);
      const arguments_ = JSON.stringify(args ?? {});
      const event: ApiChatToolEvent = { id: callId, name: tool?.label || name, arguments: arguments_, status: "running" };
      if (summaryTurn !== undefined && turn > summaryTurn) {
        stopSession();
        finish(new CopilotSdkChatError("The model requested more tools during the final summary. Completed results were preserved; no additional tool was executed."));
        return JSON.stringify({ error: "Not executed." });
      }
      await loop.beforeRound(turn + 1, signal);
      let result: string;
      if (loop.summarizing) {
        result = JSON.stringify({ error: "Not executed: tool-loop continuation was not approved; use completed results." });
        request.onTool?.({ ...event, status: "failed", result });
        if (summaryTurn === undefined) {
          summaryTurn = turn;
          void session?.send({ prompt: toolBudgetSummary, mode: "immediate", source: "system" }).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
        }
      } else {
        request.onTool?.(event);
        const reused = loop.reuse(name, arguments_, messages);
        if (reused) {
          result = reused.result;
          request.onTool?.({ ...event, status: "complete", result });
          loop.record(tool, name, arguments_, reused.original);
        } else {
          let succeeded = false;
          try {
            if (!tool) throw new Error("This tool is not enabled for the request.");
            if (!args || typeof args !== "object" || Array.isArray(args) || arguments_.length > 32_000) throw new Error("Invalid tool arguments.");
            result = await abortable(Promise.resolve().then(() => tool.execute(args as Record<string, unknown>, signal)), signal);
            if (typeof result !== "string" || result.length > 16_000) throw new Error("Tool result exceeded the local limit.");
            succeeded = true;
            request.onTool?.({ ...event, status: "complete", result });
          } catch (error) {
            if (signal.aborted) throw new CopilotSdkChatError("Request cancelled.");
            result = JSON.stringify({ error: error instanceof Error ? error.message : "Tool failed." });
            request.onTool?.({ ...event, status: "failed", result });
          }
          loop.remember(name, arguments_, callId, result, succeeded);
          loop.record(tool, name, arguments_, result);
        }
      }
      messages.push({ role: "tool", content: result, tool_call_id: callId });
      if (--pendingCalls === 0 && !loop.summarizing && request.afterTools?.()) { stopped = true; stopSession(); settle?.(); }
      return result;
    };
    const sdkTools = tools.map(tool => runtime.sdk.defineTool(tool.name, {
      description: tool.description, parameters: tool.parameters, skipPermission: true, defer: "never", overridesBuiltInTool: true,
      handler: (args: unknown, invocation: { toolCallId: string }) => {
        const turn = round;
        const next = toolQueue.then(() => runTool(tool.name, args, invocation.toolCallId, turn));
        toolQueue = next.catch(() => undefined);
        return next.catch(error => { finish(error instanceof Error ? error : new Error(String(error))); stopSession(); return JSON.stringify({ error: "Not executed." }); });
      },
    }));
    session = await abortable(client.createSession({
      model: model.id, gitHubToken: token, streaming: true,
      reasoningSummary: "concise",
      systemMessage: { mode: "replace", content: system || "You are a helpful assistant." },
      tools: sdkTools, availableTools: [...names],
      enableConfigDiscovery: false, skipCustomInstructions: true, enableSkills: false, infiniteSessions: { enabled: false },
      enableSessionStore: false, enableFileChangeTracking: false, enableHostGitOperations: false,
      onPermissionRequest: (permission: { kind?: string; toolName?: string }) => permission.kind === "custom-tool" && names.has(permission.toolName || "")
        ? { kind: "approve-once" } : { kind: "reject", feedback: "PKM exposes only its own tools." },
    }), signal);
    request.onModelActivity?.({ operation: "model-access", label: "Starting Copilot SDK session", status: "complete" });

    const settled = () => new Promise<void>(resolve => { settle = resolve; if (failure || stopped) resolve(); });
    let idle = settled();
    session.on(event => {
      const data = event.data || {};
      // Sub-agent events are not part of PKM's single-agent transcript.
      if (data.parentToolCallId) return;
      if (event.id) {
        if (seenEvents.has(event.id)) return;
        seenEvents.add(event.id);
      }
      try {
      switch (event.type) {
        case "assistant.turn_start": {
          clock.finish("interrupted");
          round++;
          if (typeof data.turnId === "string") turnRounds.set(data.turnId, round);
          turnBytes = 0; thinkingBytes = 0;
          activity();
          if (round > 0) {
            try {
              request.beforeRound?.(messages, remaining);
              const subsequent = chatTransportReceipt("vscode", messages, schemas);
              subsequent.payloadScope = "sdk-managed-context";
              request.onTransportPrepared?.(subsequent);
              request.onTransportSent?.(subsequent);
            }
            catch (error) { stopSession(); finish(new CopilotSdkChatError(error instanceof Error ? error.message : "Context budget exceeded.")); return; }
          }
          clock.start();
          request.onStage?.("waiting");
          break;
        }
        case "assistant.reasoning_delta": {
          activity();
          const text = typeof data.deltaContent === "string" ? data.deltaContent : "";
          if (text && thinkingBytes < 32 * 1024) {
            const kept = Buffer.from(text, "utf8").subarray(0, 32 * 1024 - thinkingBytes).toString("utf8").replace(/\uFFFD$/, "");
            thinkingBytes += Buffer.byteLength(kept, "utf8");
            if (kept) request.onThinking?.(kept);
          }
          break;
        }
        case "assistant.message_delta": {
          activity();
          const text = typeof data.deltaContent === "string" ? data.deltaContent : "";
          if (!text) break;
          clock.publicOutput();
          turnBytes += Buffer.byteLength(text, "utf8");
          if (turnBytes > chatInferenceOutputByteLimit) { stopSession(); finish(new CopilotSdkChatError("Inference output exceeded the 100,000-byte local size limit. Partial output was preserved; no pending tool was executed.")); break; }
          streamedMessages.add(typeof data.messageId === "string" ? data.messageId : `turn:${round}`);
          onText(text);
          break;
        }
        case "assistant.message": {
          activity();
          const content = typeof data.content === "string" ? data.content : "";
          const messageId = typeof data.messageId === "string" ? data.messageId : `turn:${round}`;
          if (completedMessages.has(messageId)) break;
          completedMessages.add(messageId);
          const requests = Array.isArray(data.toolRequests) ? data.toolRequests as Array<{ toolCallId?: string; name?: string; arguments?: unknown }> : [];
          if (content && !streamedMessages.has(messageId)) onText(content);
          if (!content && !requests.length) break;
          if (requests.length) {
            clock.publicOutput();
            turnBytes += Buffer.byteLength(JSON.stringify(requests), "utf8");
            if (turnBytes > chatInferenceOutputByteLimit) { stopSession(); finish(new CopilotSdkChatError("Inference output exceeded the 100,000-byte local size limit. Partial output was preserved; no pending tool was executed.")); break; }
            pendingCalls += requests.length;
          }
          lastAssistant = { text: content, calls: requests.length };
          messages.push({ role: "assistant", content, ...(requests.length ? { tool_calls: requests.map(call => ({ id: String(call.toolCallId || ""), type: "function" as const,
            function: { name: String(call.name || ""), arguments: JSON.stringify(call.arguments ?? {}) } })) } : {}) });
          break;
        }
        case "assistant.usage": {
          activity();
          const usage = usageFromEvent(data);
          request.onUsageMetadata?.(!!usage);
          if (!usage) break;
          const usageRound = typeof data.turnId === "string" ? turnRounds.get(data.turnId) : undefined;
          if (usageRound === undefined || usageRound === Math.max(0, round)) clock.finish("stream-ended");
          request.onUsage?.(usage, usageRound ?? Math.max(0, round));
          try { checkReportedOutput(usage, remaining, request.thinkingBudget); }
          catch (error) { stopSession(); finish(new CopilotSdkChatError((error as Error).message)); }
          break;
        }
        case "session.error": {
          const reason = typeof data.errorType === "string" ? data.errorType : "error";
          finish(new CopilotSdkChatError(`Copilot SDK model request failed (${reason.slice(0, 80)}). Partial output was preserved.`));
          break;
        }
        case "session.idle": settle?.(); break;
        case "session.auto_mode_resolved": {
          const chosen = text(data.chosenModel);
          if (chosen) routing(`Auto selected ${chosen}${data.fallback === true ? " (fallback)" : ""}`, "complete");
          break;
        }
        case "session.fusion_route_started": routing("HydraFusion · choosing a workflow", "running", `fusion:${text(data.attemptId)}`); break;
        case "session.fusion_resolved": {
          routingDone("complete");
          const secondary = text(data.secondaryModel);
          routing(`HydraFusion · ${text(data.pattern) || "workflow"} · ${text(data.primaryModel)}${secondary ? ` + ${secondary}` : ""}`, "complete");
          break;
        }
        case "session.fusion_route_failed": routingDone("failed"); routing(`HydraFusion routing failed; using ${text(data.fallbackModel) || "fallback model"}`, "failed"); break;
        case "assistant.fusion_phase_started": activity(); routing(`HydraFusion ${text(data.phaseKind) || "phase"} · ${text(data.model)}`, "running", `phase:${text(data.phaseId)}`); break;
        case "assistant.fusion_phase_completed": activity(); routingDone(data.status === "failed" ? "failed" : "complete", `phase:${text(data.phaseId)}`); break;
        case "assistant.fusion_phase_failed": activity(); routingDone("failed", `phase:${text(data.phaseId)}`); break;
      }
      } catch (error) {
        stopSession();
        finish(error instanceof CopilotSdkChatError ? error
          : new CopilotSdkChatError(error instanceof Error ? error.message : "Copilot SDK event processing failed."));
      }
    });
    request.onTransportSent?.(transport);
    activity();
    await session.send({ prompt, ...(images.length ? { attachments: images.map(image => ({ type: "blob", data: image.dataBase64, mimeType: image.mimeType, displayName: image.label })) } : {}) });
    while (true) {
      await idle;
      if (failure) throw failure;
      if (stopped) return;
      if (!lastAssistant || !lastAssistant.text && !lastAssistant.calls) throw new CopilotSdkChatError("The model returned an empty response.");
      const continuation = summaryTurn === undefined && request.beforeFinish?.();
      if (!continuation) return;
      messages.push({ role: "system", content: continuation });
      lastAssistant = undefined;
      idle = settled();
      await session.send({ prompt: continuation, source: "system" });
    }
  } catch (error) {
    if (timedOut) throw new CopilotSdkChatError("The Copilot SDK model call timed out due to inactivity. Partial output was preserved; no automatic retry was performed.");
    if (signal.aborted) throw new Error("Request cancelled.");
    if (error instanceof CopilotSdkChatError) throw error;
    throw new Error("Copilot SDK model request failed. Check GitHub sign-in, Copilot access and model availability. Partial output was preserved.");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    clock.finish("interrupted");
    for (const [, label] of openRouting) request.onModelActivity?.({ operation: "model-access", label, status: "failed" });
    // Session files contain the conversation, so they are removed as soon as the request ends.
    const ended = session;
    if (ended) {
      const cleanup = ended.disconnect().catch(() => undefined).then(() => client?.deleteSession?.(ended.sessionId)).catch(() => undefined);
      let cleanupTimer: NodeJS.Timeout | undefined;
      await Promise.race([cleanup, new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 5000); })]);
      clearTimeout(cleanupTimer);
    }
  }
}
