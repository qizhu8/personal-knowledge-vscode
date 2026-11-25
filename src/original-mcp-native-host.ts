import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { z } from "zod";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { assertStorage, type Storage } from "./storage.js";
import { ModelConfigService, modelApiKeySecretId, type ModelConfigDependencies } from "./model-config.js";
import { ModelProviderError, type ModelProviderTransport } from "./model-provider-contracts.js";
import type { NativeRuntimeOptions } from "./native-runtime.js";
import type { ToolApprovalBinding } from "./tool-gateway-contracts.js";
import type { ApprovalBridgeReview, ApprovalBridgeReviewer } from "./approval-bridge-contracts.js";
import { toolArgumentsDigest, toolCanonicalJson } from "./domain/tool-gateway-projection.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import { originalNativeChatCatalogue, originalNativeChatSelection, originalNativeChatRequest,
  type OriginalNativeChatPorts } from "./original-mcp-api-chat-contracts.js";
import { originalSubscriptionReadDecision, type OriginalSubscriptionReadApproval } from "./original-mcp-subscription-contracts.js";
import type { RefreshView } from "./legacy-subscription-refresh.js";
import { nativeActionPackageSourceDecision, nativeActionPackageDestinationDecision,
  nativeActionPackageRequestSchemas, nativeActionPackageResultSchemas } from "./original-mcp-action-package-native-contracts.js";
import { NativeCurrentProcessDiagnosticWriter, bindNativeCurrentProcessDiagnostics,
  recordNativeCurrentProcessDiagnosticCall } from "./native-current-process-diagnostics.js";
import { originalMcpNativeHostReceiptSchema as receiptSchema, originalMcpNativeHostReceiptTable as table,
  originalMcpNativeHostReceiptDdl as ddl, originalMcpNativeHostReceiptDigest as originalMcpRequestDigest,
  verifyOriginalMcpNativeHostReceiptSchema as verifySchema, verifyOriginalMcpNativeHostReceiptDatabase,
  type OriginalMcpNativeHostReceipt } from "./original-mcp-native-host-receipt.js";
export type { OriginalMcpNativeHostReceipt } from "./original-mcp-native-host-receipt.js";
export { originalMcpRequestDigest };

const digest = z.string().regex(/^[a-f0-9]{64}$/);
type Binding = Readonly<Omit<OriginalMcpNativeHostReceipt, "receiptSha256">>;
export interface OriginalMcpPublicApproval {
  operation: string; version: 1; tool: string; readOnly: boolean;
  arguments: Readonly<Record<string, unknown>>; argumentsDigest: string;
}
export interface OriginalMcpNativeHostPolicy {
  profileSha256: string;
  sourceCatalogSha256: string;
  authorityId: string;
  epoch: string;
  signal: AbortSignal;
  /** Authenticated native profile/epoch check, never an MCP request or historical permission grant. */
  assertCurrent(binding: Binding): void;
  authorizeAdmission(binding: Binding): Promise<boolean>;
  models: {
    configuration: ModelConfigDependencies["configuration"];
    registryAvailability: ModelConfigDependencies["registryAvailability"];
    /** Presence only. Actual SecretStorage values never leave the native host. */
    credentialAvailable(binding: Binding & { secretId: typeof modelApiKeySecretId }): Promise<boolean>;
    authorizeRequest(binding: Binding & { provider: string; model: string; requestSha256: string }, signal?: AbortSignal): Promise<boolean>;
    transport: ModelProviderTransport;
  };
  approveTool?: (binding: Binding & { request: Readonly<ToolApprovalBinding> }, signal: AbortSignal) => Promise<boolean>;
  toolCatalog?: NonNullable<NativeRuntimeOptions["toolCatalog"]>;
  reviewTool?: (binding: Binding & { review: Readonly<ApprovalBridgeReview> }) => ReturnType<ApprovalBridgeReviewer>;
  authorizePublic?: (binding: Binding & { request: Readonly<OriginalMcpPublicApproval> }, signal: AbortSignal) => Promise<boolean>;
  authorizeSubscriptionRead?: (binding: Binding & { request: Readonly<OriginalSubscriptionReadApproval> },
    signal: AbortSignal) => Promise<unknown>;
  subscriptionSource?: {
    capture(binding: Binding, signal: AbortSignal, expectedHead?: string): Promise<RefreshView>;
    assertCurrent(binding: Binding, head: string): void;
  };
  authorizeMemoryDecision?: NonNullable<NativeRuntimeOptions["authorizeMemoryDecision"]>;
  apiChat?: OriginalNativeChatPorts<Binding>;
  actionPackages?: {
    source(input: z.infer<typeof nativeActionPackageRequestSchemas["action.package.source.approve"]>, signal: AbortSignal): Promise<unknown>;
    destination(input: z.infer<typeof nativeActionPackageRequestSchemas["action.package.destination.approve"]>, signal: AbortSignal): Promise<unknown>;
    current(input: z.infer<typeof nativeActionPackageRequestSchemas["action.package.decision.current"]>, signal: AbortSignal): Promise<unknown>;
  };
}
const liveHosts = new WeakMap<object, { storage: Storage; check(): void }>();
const publicRequests = new AsyncLocalStorage<{
  storage: Storage; host: OriginalMcpNativeHost; request: Readonly<OriginalMcpPublicApproval>;
}>();
export function assertOriginalMcpNativeHost(value: unknown, storage: Storage): asserts value is OriginalMcpNativeHost {
  assertStorage(storage);
  const actual = value && typeof value === "object" ? liveHosts.get(value) : undefined;
  if (!actual || actual.storage !== storage) fail();
  actual.check();
}
export async function withOriginalMcpPublicRequest<T>(storage: Storage, host: OriginalMcpNativeHost,
  request: OriginalMcpPublicApproval, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  assertOriginalMcpNativeHost(host, storage);
  const pinned = Object.freeze({ ...request, arguments: structuredClone(request.arguments) });
  await host.authorizePublic(pinned, signal);
  assertOriginalMcpNativeHost(host, storage);
  return publicRequests.run({ storage, host, request: pinned }, async () => {
    const started = performance.now();
    recordNativeCurrentProcessDiagnosticCall(storage, host, "mcp.call.started", { readOnly: pinned.readOnly });
    try {
      const result = await work();
      try { assertOriginalMcpNativeHost(host, storage); }
      catch (error) {
        if (!pinned.readOnly)
          throw new CoreError("ACCESS_DENIED", "Native authority changed after dispatch; preserve/reconcile its durable receipt before retrying.", "unknown");
        throw error;
      }
      recordNativeCurrentProcessDiagnosticCall(storage, host, "mcp.call.completed", {
        readOnly: pinned.readOnly, outcome: "success", durationMs: performance.now() - started,
      });
      return result;
    }
    catch (error) {
      recordNativeCurrentProcessDiagnosticCall(storage, host, "mcp.call.completed", {
        readOnly: pinned.readOnly, outcome: "failure", durationMs: performance.now() - started,
      });
      throw error;
    }
  });
}
/** Only this request's fresh native approval may expose validated Recipe linkage to the public adapter. */
export function originalMcpPublicRequestActive(storage: Storage, tool: string, args?: Readonly<Record<string, unknown>>): boolean {
  const scope = publicRequests.getStore();
  if (!scope || scope.storage !== storage || scope.request.tool !== tool) return false;
  assertOriginalMcpNativeHost(scope.host, storage);
  if (args && (originalMcpRequestDigest(args) !== scope.request.argumentsDigest
    || originalMcpRequestDigest(scope.request.arguments) !== scope.request.argumentsDigest)) return false;
  return true;
}
export function originalMcpPublicRequestMatches(storage: Storage, host: OriginalMcpNativeHost,
  request: OriginalMcpPublicApproval): boolean {
  const scope = publicRequests.getStore();
  if (!scope || scope.storage !== storage || scope.host !== host) return false;
  assertOriginalMcpNativeHost(host, storage);
  const approved = scope.request;
  return approved.operation === request.operation && approved.version === request.version
    && approved.tool === request.tool && approved.readOnly === request.readOnly
    && approved.argumentsDigest === request.argumentsDigest
    && originalMcpRequestDigest(approved.arguments) === approved.argumentsDigest
    && originalMcpRequestDigest(request.arguments) === request.argumentsDigest;
}
const hash = originalMcpRequestDigest;
function fail(): never {
  throw new CoreError("ACCESS_DENIED", "The exact original-root/native-profile/model or approval authority is unavailable or changed.");
}
function configurationWithoutCredentials(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(configurationWithoutCredentials); return; }
  for (const [key, child] of Object.entries(value)) {
    const name = key.replace(/[^A-Za-z]/g, "").toLowerCase();
    if (name.includes("apikey") || name.includes("credential") || name.includes("secret")
      || ["password", "authorization", "token"].includes(name)) fail();
    configurationWithoutCredentials(child);
  }
}
export function verifyOriginalMcpNativeHostReceipt(storage: Storage, expectedSha256: string): OriginalMcpNativeHostReceipt {
  assertStorage(storage); storage.assertWorkspaceLease(); digest.parse(expectedSha256);
  const database = storage.connectNative();
  try {
    const journal = assertOriginalMcpPrivacy(storage.workspaceRoot());
    if (!journal) fail();
    const receipt = verifyOriginalMcpNativeHostReceiptDatabase(database, journal, expectedSha256);
    storage.assertWorkspaceLease();
    return receipt;
  } finally { database.close(); }
}

/**
 * Trusted embedding only: real Storage/lease + fresh profile approval produce native ports,
 * not a generic MCP proxy. This does not grant old Action, worker, Room or Chat-history authority.
 */
export async function createOriginalMcpNativeHost(storage: Storage, policy: OriginalMcpNativeHostPolicy,
  options?: { nativeChat?: ReturnType<typeof import("./original-mcp-native-chat-rpc.js").createOriginalMcpNativeChatRpcPort> }) {
  assertStorage(storage); storage.assertWorkspaceLease();
  const packageDecisions = new WeakMap<object, object>();
  const root = storage.workspaceRoot(), journal = assertOriginalMcpPrivacy(root);
  if (!journal || policy.profileSha256 !== journal.plan.profileSha256
    || !policy.signal || policy.signal.aborted || typeof policy.assertCurrent !== "function"
    || typeof policy.authorizeAdmission !== "function" || !policy.models
    || typeof policy.models.credentialAvailable !== "function" || typeof policy.models.authorizeRequest !== "function"
    || typeof policy.models.transport?.open !== "function" || typeof policy.models.transport.supports !== "function") fail();
  const nativeChat = options?.nativeChat;
  if (nativeChat) {
    const protocol: typeof import("./original-mcp-native-chat-rpc.js") = await import("./original-mcp-native-chat-rpc.js");
    protocol.assertOriginalMcpNativeChatRpcPort(nativeChat);
    const binding = nativeChat.session.binding;
    if (nativeChat.session.activationId !== policy.epoch || binding.root !== root
      || binding.workspaceId !== await storage.workspaceId() || binding.planSha256 !== journal.plan.planSha256
      || binding.profileSha256 !== policy.profileSha256 || binding.catalogSha256 !== policy.sourceCatalogSha256)
      fail();
  }
  if (policy.reviewTool && !policy.approveTool) fail();
  policy = Object.freeze({ ...policy,
    assertCurrent: policy.assertCurrent.bind(policy), authorizeAdmission: policy.authorizeAdmission.bind(policy),
    ...(policy.approveTool ? { approveTool: policy.approveTool.bind(policy) } : {}),
    ...(policy.reviewTool ? { reviewTool: policy.reviewTool.bind(policy) } : {}),
    ...(policy.authorizePublic ? { authorizePublic: policy.authorizePublic.bind(policy) } : {}),
    ...(policy.authorizeSubscriptionRead ? { authorizeSubscriptionRead: policy.authorizeSubscriptionRead.bind(policy) } : {}),
    ...(policy.subscriptionSource ? { subscriptionSource: Object.freeze({
      capture: policy.subscriptionSource.capture.bind(policy.subscriptionSource),
      assertCurrent: policy.subscriptionSource.assertCurrent.bind(policy.subscriptionSource),
    }) } : {}),
    ...(policy.authorizeMemoryDecision ? { authorizeMemoryDecision: policy.authorizeMemoryDecision.bind(policy) } : {}),
    ...(policy.apiChat ? { apiChat: Object.freeze({
      catalogue: policy.apiChat.catalogue.bind(policy.apiChat), resolve: policy.apiChat.resolve.bind(policy.apiChat),
      authorize: policy.apiChat.authorize.bind(policy.apiChat), present: policy.apiChat.present.bind(policy.apiChat),
    }) } : {}),
    ...(policy.toolCatalog ? { toolCatalog: Object.freeze(policy.toolCatalog.map(item => Object.freeze({ ...item }))) } : {}),
    models: Object.freeze({ ...policy.models,
      credentialAvailable: policy.models.credentialAvailable.bind(policy.models),
      authorizeRequest: policy.models.authorizeRequest.bind(policy.models),
      registryAvailability: Object.freeze({ ...policy.models.registryAvailability }),
      transport: Object.freeze({
        supports: policy.models.transport.supports.bind(policy.models.transport),
        open: policy.models.transport.open.bind(policy.models.transport),
      }),
    }),
  });
  configurationWithoutCredentials(policy.models.configuration);
  const configuration = structuredClone(policy.models.configuration);
  const domains: OriginalMcpNativeHostReceipt["domains"] = policy.approveTool
    ? ["model-provider", "tool-approval"] : ["model-provider"];
  if (policy.authorizePublic) domains.push("mcp-public");
  if (policy.apiChat || nativeChat) domains.push("api-chat-native");
  const body: Binding = Object.freeze({
    schema: "pkm.original-mcp-native-host-admission/v1", root, workspaceId: await storage.workspaceId(),
    planSha256: journal.plan.planSha256, profileSha256: policy.profileSha256,
    sourceCatalogSha256: digest.parse(policy.sourceCatalogSha256),
    authorityId: policy.authorityId, epoch: policy.epoch, actorId: "mcp:external",
    domains,
    configurationSha256: hash(JSON.parse(JSON.stringify({ configuration, registryAvailability: policy.models.registryAvailability,
      toolCatalog: policy.toolCatalog ?? [] }))),
  });
  const receipt = Object.freeze(receiptSchema.parse({ ...body, receiptSha256: hash(body) }));
  Object.freeze(body.domains); Object.freeze(receipt.domains);
  const lifetime = new AbortController();
  const diagnostics = new NativeCurrentProcessDiagnosticWriter();
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let closing: Promise<void> | undefined;
  const revoked = () => { void close().catch(() => {}); };
  let admitted = false;
  policy.signal.addEventListener("abort", revoked, { once: true });
  function assertCurrent() {
    storage.assertWorkspaceLease();
    try { nativeChat?.assertCurrent(); }
    catch { lifetime.abort(); fail(); }
    if (policy.signal.aborted || lifetime.signal.aborted) fail();
    const current = assertOriginalMcpPrivacy(root);
    if (!current || current.journalSha256 !== journal!.journalSha256) fail();
    try {
      const result = policy.assertCurrent(body) as unknown;
      if (result !== undefined) {
        if (result && (typeof result === "object" || typeof result === "function") && "then" in result)
          void Promise.resolve(result).catch(() => {});
        fail();
      }
    }
    catch { lifetime.abort(); fail(); }
    if (policy.signal.aborted || lifetime.signal.aborted) fail();
    if (admitted) verifyOriginalMcpNativeHostReceipt(storage, receipt.receiptSha256);
  }
  function close() {
    lifetime.abort(); diagnostics.close(); policy.signal.removeEventListener("abort", revoked);
    return closing ??= Promise.all([...readers].map(reader => reader.cancel())).then(() => { readers.clear(); },
      () => { throw new ModelProviderError("transport-error", "uncertain"); });
  }
  try {
    assertCurrent();
    if (await policy.authorizeAdmission(body) !== true) fail();
    assertCurrent();
    await storage.withWorkspaceExclusive(() => {
      assertCurrent();
      const database = storage.connectNative();
      try {
        database.exec("BEGIN IMMEDIATE");
        if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(table)) database.exec(ddl);
        verifySchema(database);
        const payload = toolCanonicalJson(receipt);
        const existing = database.prepare(`SELECT payload FROM ${table} WHERE receipt_sha256=?`).get(receipt.receiptSha256);
        if (existing && existing.payload !== payload) fail();
        if (!existing) database.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(receipt.receiptSha256, payload);
        assertCurrent(); database.exec("COMMIT");
      } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
      finally { database.close(); }
    });
    admitted = true;
    const modelConfig = new class extends ModelConfigService {
      override async catalog() {
        assertCurrent(); const value = await super.catalog(); assertCurrent(); return value;
      }
      override async resolve(input: unknown) {
        assertCurrent(); const value = await super.resolve(input); assertCurrent(); return value;
      }
    }({
      configuration, registryAvailability: { ...policy.models.registryAvailability },
      secretResolver: { async resolveSecret(secretId) {
        assertCurrent();
        const available = await policy.models.credentialAvailable({ ...body, secretId });
        assertCurrent();
        return available === true ? Object.freeze({}) : undefined;
      } },
    });
    const providerTransport: ModelProviderTransport = {
      supports(provider) { assertCurrent(); return policy.models.transport.supports(provider); },
      async open(request) {
        assertCurrent();
        const payload = structuredClone(request.payload), requestSha256 = hash(payload);
        const dispatch = new AbortController();
        const signal = AbortSignal.any([request.signal, lifetime.signal, policy.signal, dispatch.signal]);
        if (signal.aborted) throw new ModelProviderError("cancelled");
        const allowed = await policy.models.authorizeRequest({ ...body, provider: request.provider,
          model: payload.model, requestSha256 }, signal);
        assertCurrent();
        if (allowed !== true || signal.aborted) throw new ModelProviderError("cancelled");
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          reader = (await policy.models.transport.open({ ...request, payload, signal })).getReader();
          readers.add(reader);
          assertCurrent();
        } catch {
          dispatch.abort();
          if (reader) { readers.delete(reader); await reader.cancel().catch(() => {}); }
          throw new ModelProviderError("transport-error", "uncertain");
        }
        const source = reader;
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              assertCurrent();
              if (signal.aborted) throw new ModelProviderError("cancelled", "uncertain");
              const next = await source.read();
              assertCurrent();
              if (signal.aborted) throw new ModelProviderError("cancelled", "uncertain");
              if (next.done) { readers.delete(source); controller.close(); } else controller.enqueue(next.value);
            } catch {
              dispatch.abort(); readers.delete(source);
              void source.cancel().catch(() => {});
              controller.error(new ModelProviderError("cancelled", "uncertain"));
            }
          },
          async cancel() { dispatch.abort(); readers.delete(source); await source.cancel(); },
        });
      },
    };
    const authorizeTool: NativeRuntimeOptions["authorizeTool"] = policy.approveTool ? async (request, requestSignal) => {
      assertCurrent();
      if (request.actorId !== body.actorId || request.workspaceId !== body.workspaceId
        || request.version !== 1 || toolArgumentsDigest(request.arguments) !== request.argumentsDigest) fail();
      const signal = AbortSignal.any([requestSignal, lifetime.signal, policy.signal]);
      if (signal.aborted) return false;
      const approved = await policy.approveTool!({ ...body, request: structuredClone(request) }, signal);
      assertCurrent();
      return approved === true && !signal.aborted;
    } : undefined;
    const reviewer: ApprovalBridgeReviewer | undefined = policy.reviewTool ? async review => {
      assertCurrent();
      if (review.actorId !== body.actorId || review.workspaceId !== body.workspaceId) fail();
      const decision = await policy.reviewTool!({ ...body, review: structuredClone(review) });
      assertCurrent();
      if (decision && decision.actorId !== body.actorId) fail();
      return decision;
    } : undefined;
    storage.retainNativeCleanup({ release: close });
    const host = Object.freeze({
      receipt, assertCurrent, close, signal: lifetime.signal, nativeChat,
      actionPackageApprovalAvailable: !!policy.actionPackages,
      async approveActionPackageSource(sourcePath: string, requestSignal?: AbortSignal):
        Promise<z.infer<typeof nativeActionPackageSourceDecision> | undefined> {
        assertCurrent();
        if (!policy.actionPackages) return undefined;
        const context = publicRequests.getStore();
        if (context?.storage !== storage || context.host !== host || context.request.tool !== "action_module_set_import"
          || context.request.readOnly || typeof context.request.arguments.local_path !== "string"
          || resolve(context.request.arguments.local_path) !== sourcePath) fail();
        const payload = nativeActionPackageRequestSchemas["action.package.source.approve"].parse({ binding: body, sourcePath });
        const signal = AbortSignal.any([lifetime.signal, policy.signal, ...(requestSignal ? [requestSignal] : [])]);
        const result = nativeActionPackageSourceDecision.nullable().parse(await policy.actionPackages.source(payload, signal));
        assertCurrent(); signal.throwIfAborted();
        if (!result || result.root !== body.root || result.workspaceId !== body.workspaceId || result.actorId !== body.actorId
          || result.profileSha256 !== body.profileSha256 || result.epoch !== body.epoch || result.sourcePath !== sourcePath
          || result.requestSha256 !== originalMcpRequestDigest(payload) || result.expiresAtMs <= Date.now()
          || result.expiresAtMs > Date.now() + 300000) fail();
        const admitted = Object.freeze(result); packageDecisions.set(admitted, context);
        return admitted;
      },
      async approveActionPackageDestination(input: Omit<z.infer<typeof nativeActionPackageRequestSchemas["action.package.destination.approve"]>, "binding">,
        requestSignal?: AbortSignal): Promise<z.infer<typeof nativeActionPackageDestinationDecision> | undefined> {
        assertCurrent();
        if (!policy.actionPackages) return undefined;
        const context = publicRequests.getStore(), args = context?.request.arguments;
        if (context?.storage !== storage || context.host !== host || context.request.tool !== "action_module_set_export"
          || context.request.readOnly || typeof args?.destination !== "string"
          || resolve(args.destination) !== input.destination || args.module_set_id !== input.moduleSetId
          || args.version !== input.version || originalMcpRequestDigest(args.action_ids) !== originalMcpRequestDigest(input.actionIds)) fail();
        const payload = nativeActionPackageRequestSchemas["action.package.destination.approve"].parse({ binding: body, ...input });
        const signal = AbortSignal.any([lifetime.signal, policy.signal, ...(requestSignal ? [requestSignal] : [])]);
        const result = nativeActionPackageDestinationDecision.nullable().parse(await policy.actionPackages.destination(payload, signal));
        assertCurrent(); signal.throwIfAborted();
        if (!result || result.root !== body.root || result.workspaceId !== body.workspaceId || result.actorId !== body.actorId
          || result.profileSha256 !== body.profileSha256 || result.epoch !== body.epoch || result.destination !== input.destination
          || result.packageSha256 !== input.packageSha256 || result.size !== input.size
          || result.requestSha256 !== originalMcpRequestDigest(payload) || result.expiresAtMs <= Date.now()
          || result.expiresAtMs > Date.now() + 300000) fail();
        const admitted = Object.freeze(result); packageDecisions.set(admitted, context);
        return admitted;
      },
      async assertActionPackageDecisionCurrent(value: z.infer<typeof nativeActionPackageSourceDecision> | z.infer<typeof nativeActionPackageDestinationDecision>,
        requestSignal?: AbortSignal): Promise<void> {
        assertCurrent();
        const context = publicRequests.getStore(), purpose = "sourcePath" in value ? "source" : "destination";
        if (!policy.actionPackages || !context || packageDecisions.get(value) !== context
          || value.epoch !== body.epoch || value.expiresAtMs <= Date.now()) fail();
        if (context?.storage !== storage || context.host !== host || context.request.readOnly
          || context.request.tool !== (purpose === "source" ? "action_module_set_import" : "action_module_set_export")) fail();
        const payload = nativeActionPackageRequestSchemas["action.package.decision.current"].parse({
          binding: body, decisionId: value.decisionId, requestSha256: value.requestSha256, purpose,
        });
        const signal = AbortSignal.any([lifetime.signal, policy.signal, ...(requestSignal ? [requestSignal] : [])]);
        const response = nativeActionPackageResultSchemas["action.package.decision.current"].parse(await policy.actionPackages.current(payload, signal));
        assertCurrent(); signal.throwIfAborted();
        if (!response.current || value.expiresAtMs <= Date.now()) fail();
      },
      async authorizeNativeModelRequest(model: string, requestSha256: string, requestSignal?: AbortSignal) {
        assertCurrent(); digest.parse(requestSha256);
        const signal = AbortSignal.any([lifetime.signal, policy.signal, ...(requestSignal ? [requestSignal] : [])]);
        if (signal.aborted || await policy.models.authorizeRequest({ ...body, provider: "vscode", model, requestSha256 }, signal) !== true)
          fail();
        assertCurrent(); if (signal.aborted) fail();
      },
      apiChat: policy.apiChat ? Object.freeze({
        async catalogue(requestSignal?: AbortSignal) {
          assertCurrent();
          const signal = AbortSignal.any([lifetime.signal, policy.signal, ...(requestSignal ? [requestSignal] : [])]);
          const value = originalNativeChatCatalogue.parse(await policy.apiChat!.catalogue(body, signal));
          assertCurrent();
          if (signal.aborted || value.epoch !== body.epoch || new Set(value.models.map(model => model.id)).size !== value.models.length) fail();
          return value;
        },
        async resolve(request: { requestedModelId: string; chatUrl: string | null }, requestSignal?: AbortSignal) {
          assertCurrent();
          const input = structuredClone(request);
          const signal = AbortSignal.any([lifetime.signal, policy.signal, ...(requestSignal ? [requestSignal] : [])]);
          const value = originalNativeChatSelection.parse(await policy.apiChat!.resolve({ ...body, ...input }, signal));
          assertCurrent();
          if (signal.aborted || value.epoch !== body.epoch || input.requestedModelId && value.modelId !== input.requestedModelId) fail();
          return value;
        },
        async authorize(request: import("zod").infer<typeof originalNativeChatRequest>, requestSignal?: AbortSignal) {
          assertCurrent();
          const input = originalNativeChatRequest.parse(structuredClone(request));
          const signal = AbortSignal.any([lifetime.signal, policy.signal, ...(requestSignal ? [requestSignal] : [])]);
          const approved = await policy.apiChat!.authorize({ ...body, request: input }, signal);
          assertCurrent();
          if (approved !== true || signal.aborted || input.selection && input.selection.epoch !== body.epoch) fail();
        },
        async present(chatUrl: string, requestSignal?: AbortSignal) {
          assertCurrent();
          if (!/^pkm:\/\/chats\/[a-f0-9]{16}\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(chatUrl)) fail();
          const signal = AbortSignal.any([lifetime.signal, policy.signal, ...(requestSignal ? [requestSignal] : [])]);
          await policy.apiChat!.present({ ...body, chatUrl }, signal);
          assertCurrent(); if (signal.aborted) fail();
        },
      }) : undefined,
      async captureSubscriptionSource(requestSignal?: AbortSignal, expectedHead?: string) {
        assertCurrent();
        if (!policy.subscriptionSource || !policy.authorizeSubscriptionRead) fail();
        const signal = AbortSignal.any([lifetime.signal, policy.signal, ...(requestSignal ? [requestSignal] : [])]);
        if (signal.aborted) fail();
        let value: RefreshView;
        try { value = structuredClone(await policy.subscriptionSource.capture(body, signal, expectedHead)); }
        catch { fail(); }
        assertCurrent();
        if (signal.aborted) fail();
        try { policy.subscriptionSource.assertCurrent(body, value!.head); } catch { fail(); }
        return value!;
      },
      assertSubscriptionSource(head: string) {
        assertCurrent();
        if (!policy.subscriptionSource) fail();
        try {
          if (policy.subscriptionSource.assertCurrent(body, head) !== undefined) fail();
        } catch { fail(); }
        assertCurrent();
      },
      async authorizeSubscriptionRead(request: OriginalSubscriptionReadApproval, requestSignal?: AbortSignal) {
        assertCurrent();
        if (!policy.authorizeSubscriptionRead || !policy.subscriptionSource || !receipt.domains.includes("mcp-public")) fail();
        const signal = AbortSignal.any([lifetime.signal, policy.signal, ...(requestSignal ? [requestSignal] : [])]);
        let decision: z.infer<typeof originalSubscriptionReadDecision>;
        try { decision = originalSubscriptionReadDecision.parse(await policy.authorizeSubscriptionRead(
          { ...body, request: structuredClone(request) }, signal)); } catch { fail(); }
        assertCurrent();
        if (!decision! || signal.aborted || decision!.sourceSha256 !== hash(request.source)
          || decision!.argumentsSha256 !== hash(request.arguments) || decision!.expiresAtMs <= Date.now()
          || decision!.expiresAtMs > Date.now() + 300000) fail();
        return decision!;
      },
      async authorizePublic(request: OriginalMcpPublicApproval, requestSignal?: AbortSignal) {
        assertCurrent();
        if (!policy.authorizePublic || !receipt.domains.includes("mcp-public")
          || request.version !== 1 || request.operation !== `mcp.tool.${request.tool}`
          || originalMcpRequestDigest(request.arguments) !== request.argumentsDigest) fail();
        const signal = AbortSignal.any([lifetime.signal, policy.signal, ...(requestSignal ? [requestSignal] : [])]);
        if (signal.aborted) fail();
        const approved = await policy.authorizePublic({ ...body, request: structuredClone(request) }, signal);
        assertCurrent();
        if (approved !== true || signal.aborted)
          throw new CoreError("ACCESS_DENIED", "Fresh exact native approval is required for this original MCP operation.");
      },
      options: Object.freeze({ modelConfig, providerTransport, ...(authorizeTool ? { authorizeTool } : {}),
        ...(policy.authorizeMemoryDecision ? { authorizeMemoryDecision: async (request: Parameters<NonNullable<NativeRuntimeOptions["authorizeMemoryDecision"]>>[0]) => {
          assertCurrent();
          const decision = await policy.authorizeMemoryDecision!(structuredClone(request));
          assertCurrent();
          return decision;
        } } : {}),
        ...(reviewer ? { reviewer, toolCatalog: policy.toolCatalog } : {}) }),
    });
    liveHosts.set(host, { storage, check: assertCurrent });
    bindNativeCurrentProcessDiagnostics(storage, host, diagnostics);
    return host;
  } catch (error) { await close(); throw error; }
}
export type OriginalMcpNativeHost = Awaited<ReturnType<typeof createOriginalMcpNativeHost>>;
