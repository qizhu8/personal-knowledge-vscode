import type { CopilotClient, CopilotClientOptions, CopilotRequestContext, SessionConfig, SessionEvent, Tool, ToolInvocation } from "@github/copilot-sdk";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { assertOriginalSdkEgressLease, type OriginalSdkEgressLease } from "./original-mcp-native-sdk-egress.js";
import { z } from "zod";
import type { CopilotSdkDeps } from "../../legacy/src/chat/api-chat-copilot-sdk.js";
import {
  OriginalSdkForwardingError, originalSdkClientOptionsDigest, type createOriginalSdkForwardingHandler,
} from "./original-mcp-native-sdk-forwarding.js";
import {
  originalSdkDigest, originalSdkExecutionBinding, type OriginalSdkExecutionBinding,
} from "../../src/original-mcp-sdk-model-contracts.js";

type PublicSdk = typeof import("@github/copilot-sdk");
type Guard = ReturnType<typeof createOriginalSdkForwardingHandler>;
type RetainedClientPort = Awaited<ReturnType<CopilotSdkDeps["client"]>>["client"];
const clientKeys = new Set(["connection", "mode", "baseDirectory", "workingDirectory", "env",
  "logLevel", "useLoggedInUser"]);
const preservedConfig = ["model", "streaming", "reasoningSummary", "enableConfigDiscovery",
  "skipCustomInstructions", "enableSkills", "enableSessionStore", "enableFileChangeTracking",
  "enableHostGitOperations", "systemMessage", "infiniteSessions", "availableTools"] as const;
const sessionKeys = new Set([...preservedConfig, "gitHubToken", "tools", "hooks", "onPermissionRequest"]);
const sessionData = z.strictObject({
  model: z.string().min(1), gitHubToken: z.string().min(1), streaming: z.literal(true),
  reasoningSummary: z.literal("concise"), enableConfigDiscovery: z.literal(false),
  skipCustomInstructions: z.literal(true), enableSkills: z.literal(false),
  enableSessionStore: z.literal(false), enableFileChangeTracking: z.literal(false),
  enableHostGitOperations: z.literal(false),
  systemMessage: z.strictObject({ mode: z.literal("replace"), content: z.string() }),
  infiniteSessions: z.strictObject({ enabled: z.literal(false) }),
  availableTools: z.array(z.string().min(1)).max(4096),
});
const permissionResult = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("approve-once") }),
  z.strictObject({ kind: z.literal("reject"), feedback: z.string().optional() }),
]);
const retainedMessage = z.strictObject({
  prompt: z.string(), mode: z.enum(["enqueue", "immediate"]).optional(),
  source: z.literal("system").optional(),
  attachments: z.array(z.strictObject({
    type: z.literal("blob"), data: z.string(), mimeType: z.enum(["image/png", "image/jpeg"]),
    displayName: z.string().optional(),
  })).max(128).optional(),
});

/** Public constructor/configuration adapter for the one retained SDK executor, not an executor or authentication owner. */
export function createOriginalSdkClientDeps(options: {
  sdk: PublicSdk;
  guard: Guard;
  binding: Readonly<OriginalSdkExecutionBinding>;
  sdkModelId: string;
  clientOptions: Readonly<CopilotClientOptions>;
  accountToken(interactiveRequested: boolean, signal: AbortSignal): Promise<string | undefined>;
  nextSessionGuard(binding: OriginalSdkExecutionBinding): Guard;
  beforeSession(binding: OriginalSdkExecutionBinding, ordinal: 0 | 1, previousSessionId: string | null): Promise<void>;
  observeEvent(sessionId: string, event: SessionEvent): void;
  withToolInvocation(invocation: ToolInvocation, work: () => Promise<unknown>): Promise<unknown>;
  allowSummarySession: boolean;
  prepareClient?: () => Promise<OriginalSdkEgressLease>;
  signal: AbortSignal;
}): CopilotSdkDeps & { dispose(): Promise<void> } {
  let closed = false, created = 0, token: string | undefined;
  let client: CopilotClient | undefined, pending: ReturnType<CopilotSdkDeps["client"]> | undefined;
  let disposal: Promise<void> | undefined;
  let launch: OriginalSdkEgressLease | undefined;
  let launchAdmitted = false;
  let binding = originalSdkExecutionBinding.parse(structuredClone(options.binding));
  let activeGuard = options.guard;
  const sdkModelId = options.sdkModelId;
  const lifetime = new AbortController(), signal = AbortSignal.any([options.signal, lifetime.signal]);
  const guards = new Map<string, Guard>([[binding.sdkSessionId, activeGuard]]);
  const sessions = new Map<string, Awaited<ReturnType<CopilotClient["createSession"]>>>();
  let timer: NodeJS.Timeout | undefined;
  const declaredTools = new Map<object, Tool>(), calls = new Set<string>();
  const dispatchState = () => [...guards.values()].some(guard => guard.dispatchState() === "uncertain") ? "uncertain" as const : "not-sent" as const;
  const fail: (code: string) => never = code => {
    const dispatch = dispatchState();
    closed = true; lifetime.abort(); clearTimeout(timer);
    for (const guard of guards.values()) guard.dispose();
    throw new OriginalSdkForwardingError(code, dispatch);
  };
  const current = () => {
    if (closed || signal.aborted) fail("NATIVE_SDK_CANCELLED");
    activeGuard.assertCurrent();
    if (launchAdmitted && launch) {
      try { assertOriginalSdkEgressLease(launch); }
      catch { fail("NATIVE_SDK_RUNTIME_INCOMPATIBLE"); }
    }
  };
  const wait = async <T>(work: Promise<T>): Promise<T> => {
    current();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new OriginalSdkForwardingError("NATIVE_SDK_CANCELLED", dispatchState()));
      signal.addEventListener("abort", abort, { once: true });
      work.then(value => {
        try { current(); resolve(value); } catch (error) { reject(error); }
      }, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  };
  const sanitized = async <T>(code: string, work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (error) {
      closed = true; lifetime.abort();
      for (const guard of guards.values()) guard.dispose();
      if (error instanceof OriginalSdkForwardingError) throw error;
      return fail(code);
    }
  };
  const defineTool: Awaited<ReturnType<CopilotSdkDeps["client"]>>["sdk"]["defineTool"] = (name, raw) => {
    current();
    const { handler } = raw;
    if (typeof handler !== "function" || raw.skipPermission !== true
      || raw.overridesBuiltInTool !== true || raw.defer !== "never"
      || typeof raw.description !== "string"
      || Object.keys(raw).some(key => !["handler", "skipPermission", "overridesBuiltInTool",
        "defer", "description", "parameters"].includes(key))) fail("NATIVE_SDK_TOOL_CONFIG_DENIED");
    const tool = options.sdk.defineTool(name, {
      description: raw.description, parameters: z.record(z.string(), z.json()).parse(raw.parameters),
      skipPermission: true, overridesBuiltInTool: true, defer: "never",
      handler: (args, invocation) => sanitized("NATIVE_SDK_TOOL_UNAVAILABLE", async () => {
        current();
        if (invocation.sessionId !== [...guards.keys()][0] || invocation.sessionId !== binding.sdkSessionId || invocation.toolName !== name
          || invocation.agentId || !invocation.toolCallId || calls.has(invocation.toolCallId)
          || originalSdkDigest(args) !== originalSdkDigest(invocation.arguments))
          fail("NATIVE_SDK_TOOL_BINDING_DENIED");
        calls.add(invocation.toolCallId);
        const result: unknown = await wait(options.withToolInvocation(invocation, () => Promise.resolve(handler(args, invocation))));
        if (typeof result !== "string" || result.length > 16_000) fail("NATIVE_SDK_TOOL_RESULT_DENIED");
        return result;
      }),
    });
    declaredTools.set(tool, tool);
    return tool;
  };
  const configureSession = (raw: Readonly<Record<string, unknown>>): SessionConfig => {
    const { tools: rawTools, hooks: rawHooks, onPermissionRequest: permission, ...data } = raw;
    const parsed = sessionData.parse(data);
    if (!Array.isArray(rawTools) || typeof permission !== "function") fail("NATIVE_SDK_SESSION_CONFIG_DENIED");
    const tools = rawTools.map(value => {
      if (!value || typeof value !== "object") return fail("NATIVE_SDK_TOOL_CONFIG_DENIED");
      return declaredTools.get(value) ?? fail("NATIVE_SDK_TOOL_CONFIG_DENIED");
    });
    if (tools.length !== new Set(parsed.availableTools).size
      || tools.some(tool => !parsed.availableTools.includes(tool.name))) fail("NATIVE_SDK_TOOL_CONFIG_DENIED");
    let hooks: SessionConfig["hooks"];
    if (rawHooks !== undefined) {
      if (!rawHooks || typeof rawHooks !== "object" || Object.keys(rawHooks).some(key => key !== "onPostToolUse"))
        fail("NATIVE_SDK_SESSION_CONFIG_DENIED");
      const hook = Reflect.get(rawHooks, "onPostToolUse");
      if (typeof hook !== "function") fail("NATIVE_SDK_SESSION_CONFIG_DENIED");
      hooks = { onPostToolUse: (input, invocation) => sanitized("NATIVE_SDK_HOOK_UNAVAILABLE", async () => {
        current();
        const result: unknown = await wait(Promise.resolve(hook(input, invocation)));
        return result === undefined ? undefined : z.strictObject({ additionalContext: z.string() }).parse(result);
      }) };
    }
    return {
      ...parsed, tools, ...(hooks ? { hooks } : {}),
      onPermissionRequest: (request, invocation) => sanitized("NATIVE_SDK_PERMISSION_UNAVAILABLE", async () => {
        current();
        if (request.kind !== "custom-tool" || invocation.sessionId !== binding.sdkSessionId)
          return { kind: "reject", feedback: "Only independently authorized canonical tools are exposed." };
        return permissionResult.parse(await wait(Promise.resolve(permission(request, invocation))));
      }),
    };
  };
  current();
  const supplied = options.clientOptions;
  if (Object.keys(supplied).some(key => !clientKeys.has(key))
    || supplied.mode !== "empty" || supplied.useLoggedInUser !== false
    || !supplied.baseDirectory || !isAbsolute(supplied.baseDirectory)
    || !supplied.workingDirectory || !isAbsolute(supplied.workingDirectory)
    || !supplied.connection || !["stdio", "tcp"].includes(supplied.connection.kind)
    || !("path" in supplied.connection) || !supplied.connection.path || !isAbsolute(supplied.connection.path)
    || binding.modelId !== `vscode:copilot-sdk:${encodeURIComponent(sdkModelId)}`
    || originalSdkDigest(binding) !== options.guard.bindingSha256
    || originalSdkClientOptionsDigest(supplied) !== options.guard.clientOptionsSha256)
    fail("NATIVE_SDK_CLIENT_CONFIG_DENIED");
  class Router extends options.sdk.CopilotRequestHandler {
    protected override sendRequest(request: Request, context: CopilotRequestContext) {
      current();
      const guard = context.sessionId ? guards.get(context.sessionId) : undefined;
      if (!guard || context.sessionId !== binding.sdkSessionId) fail("NATIVE_SDK_SESSION_BINDING_DENIED");
      return guard.handler.forwardHttp(request, context);
    }
    protected override openWebSocket(context: CopilotRequestContext) {
      current();
      const guard = context.sessionId ? guards.get(context.sessionId) : undefined;
      if (!guard || context.sessionId !== binding.sdkSessionId) fail("NATIVE_SDK_SESSION_BINDING_DENIED");
      return guard.handler.forwardWebSocket(context);
    }
  }
  const config: CopilotClientOptions = { ...structuredClone(supplied), requestHandler: new Router() };
  timer = setTimeout(() => lifetime.abort(), Math.max(1, binding.deadlineAtMs - Date.now()));
  timer.unref();
  const deps: CopilotSdkDeps = {
    token(interactiveRequested) { return sanitized("NATIVE_SDK_ACCOUNT_UNAVAILABLE", async () => {
      current();
      const observed = await wait(options.accountToken(interactiveRequested, signal));
      current();
      if (!observed || token !== undefined && observed !== token)
        fail("NATIVE_SDK_ACCOUNT_UNAVAILABLE");
      token = observed;
      return token;
    }); },
    client() {
      current();
      return pending ??= (async () => {
        current();
        try {
          if (options.prepareClient) launch = await wait(options.prepareClient());
          client = new options.sdk.CopilotClient(launch ? { ...launch.clientOptions, requestHandler: config.requestHandler } : config);
          launch?.bindClient(() => client!.stop());
          await wait(client.start());
          if (launch) { await wait(launch.ready()); assertOriginalSdkEgressLease(launch); launchAdmitted = true; }
          current();
          // start() awaits enrollment but ignores its success field in SDK 1.0.34.
          // This real RPC acknowledgment is necessary, never sufficient runtime qualification.
          const enrollment = await wait(client.rpc.llmInference.setProvider());
          if (enrollment.success !== true) fail("NATIVE_SDK_RUNTIME_INCOMPATIBLE");
          current();
          const owned = client;
          const adapted: RetainedClientPort = {
              start: async () => { current(); },
              stop: () => depsOwner.dispose(),
              rpc: owned.rpc,
              createSession(raw) { return sanitized("NATIVE_SDK_SESSION_UNAVAILABLE", async () => {
                current();
                if (created >= (options.allowSummarySession ? 2 : 1) || Object.keys(raw).some(key => !sessionKeys.has(key))
                  || raw.sessionId !== undefined || raw.model !== sdkModelId
                  || !token || raw.gitHubToken !== token)
                  fail("NATIVE_SDK_SESSION_BINDING_DENIED");
                const configured = configureSession(Object.freeze({ ...raw }));
                current();
                if (Object.keys(configured).some(key => !sessionKeys.has(key))
                  || configured.sessionId !== undefined || configured.gitHubToken !== token
                  || configured.gitHubTokenProvider || configured.provider || configured.providers
                  || configured.models || configured.cloud || configured.trustWorkingDirectory
                  || preservedConfig.some(key => JSON.stringify(configured[key]) !== JSON.stringify(raw[key]))
                  || configured.enableConfigDiscovery !== false || configured.skipCustomInstructions !== true
                  || configured.enableSkills !== false || configured.enableSessionStore !== false
                  || configured.enableFileChangeTracking !== false || configured.enableHostGitOperations !== false
                  || configured.infiniteSessions?.enabled !== false)
                  fail("NATIVE_SDK_SESSION_CONFIG_DENIED");
                const previousSessionId = created ? binding.sdkSessionId : null;
                if (created) {
                  if (configured.tools?.length) fail("NATIVE_SDK_SUMMARY_TOOLS_DENIED");
                  const previous = sessions.get(binding.sdkSessionId);
                  if (!previous) fail("NATIVE_SDK_SESSION_BINDING_DENIED");
                  await wait(previous.abort());
                  await wait(previous.disconnect());
                  const next = originalSdkExecutionBinding.parse({ ...binding, sdkSessionId: randomUUID() });
                  const nextGuard = options.nextSessionGuard(next);
                  if (nextGuard.bindingSha256 !== originalSdkDigest(next)) fail("NATIVE_SDK_SESSION_BINDING_DENIED");
                  const priorGuard = activeGuard;
                  activeGuard = nextGuard; binding = next; guards.set(binding.sdkSessionId, nextGuard);
                  priorGuard.dispose();
                }
                await wait(options.beforeSession(structuredClone(binding), created === 0 ? 0 : 1, previousSessionId));
                created++;
                const session = await wait(owned.createSession({ ...configured, sessionId: binding.sdkSessionId }));
                current();
                if (session.sessionId !== binding.sdkSessionId) fail("NATIVE_SDK_SESSION_BINDING_DENIED");
                const sessionId = session.sessionId;
                sessions.set(sessionId, session);
                return {
                  sessionId: session.sessionId,
                  on(handler) {
                    current();
                    return session.on(event => {
                      if (closed || signal.aborted || sessionId !== binding.sdkSessionId) return;
                      options.observeEvent(sessionId, event);
                      handler({
                      id: event.id, type: event.type, timestamp: event.timestamp,
                      ...("agentId" in event ? { agentId: event.agentId } : {}),
                      data: { ...event.data },
                      });
                    });
                  },
                  send(message) { return sanitized("NATIVE_SDK_MESSAGE_UNAVAILABLE", async () => {
                    current();
                    const parsed = retainedMessage.safeParse(message);
                    if (!parsed.success) return fail("NATIVE_SDK_MESSAGE_CONFIG_DENIED");
                    return wait(session.send(parsed.data));
                  }); },
                  abort: () => session.abort(),
                  disconnect: () => session.disconnect(),
                };
              }); },
              async deleteSession(sessionId) {
                if (!guards.has(sessionId)) fail("NATIVE_SDK_SESSION_BINDING_DENIED");
                try { await owned.deleteSession(sessionId); }
                catch { fail("NATIVE_SDK_CLEANUP_UNCONFIRMED"); }
              },
          };
          // The frozen module type also exposes a legacy constructor returning its
          // old event API. This composition facade shares the one genuine client;
          // it never reconstructs a runtime, mutates the SDK or creates an executor.
          let facadeConstructed = false;
          class RetainedClientFacade implements RetainedClientPort {
              constructor(raw: Record<string, unknown>) {
                current();
                if (facadeConstructed || Object.keys(raw).length) fail("NATIVE_SDK_CLIENT_REPLAY_DENIED");
                facadeConstructed = true;
              }
              start = adapted.start;
              stop = adapted.stop;
              rpc = adapted.rpc;
              createSession = adapted.createSession;
              deleteSession = adapted.deleteSession;
          }
          return {
              sdk: {
                CopilotClient: RetainedClientFacade,
                RuntimeConnection: options.sdk.RuntimeConnection,
                defineTool,
              },
              client: new RetainedClientFacade({}),
          };
        } catch (error) {
          closed = true;
          lifetime.abort(); clearTimeout(timer);
          for (const guard of guards.values()) guard.dispose();
          let cleanupFailed = false;
          try { await client?.stop(); } catch { cleanupFailed = true; }
          try { await launch?.close(); } catch { cleanupFailed = true; }
          if (cleanupFailed) fail("NATIVE_SDK_CLEANUP_UNCONFIRMED");
          if (error instanceof OriginalSdkForwardingError) throw error;
          return fail("NATIVE_SDK_CLIENT_UNAVAILABLE");
        }
      })();
    },
  };
  const depsOwner = Object.freeze({
    ...deps,
    dispose() {
      if (disposal) return disposal;
      closed = true;
      lifetime.abort(); clearTimeout(timer);
      for (const guard of guards.values()) guard.dispose();
      return disposal = (async () => {
        await pending?.catch(() => undefined);
        if (client) {
          try { await client.stop(); }
          finally { await launch?.close(); }
        }
        else await launch?.close();
      })();
    },
  });
  return depsOwner;
}
