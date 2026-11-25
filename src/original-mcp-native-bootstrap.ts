import { z } from "zod";
import { openOriginalMcpRoot, type OriginalMcpAdoptionOptions } from "./original-mcp-root.js";
import { parseOriginalMcpPlan, type OriginalMcpPlan } from "./original-mcp-root-custody.js";
import {
  startOriginalMcpNativeAttachmentServer, type OriginalMcpNativeAttachmentOptions,
  assertAuthenticatedOriginalMcpNativeSession,
} from "./original-mcp-native-attachment.js";
import { createOriginalMcpNativeRequestPolicy, waitForOriginalMcpNativeSupport } from "./original-mcp-native-request.js";
import { createOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { createOriginalMcpNativeChatRpcPort, waitForOriginalMcpNativeChatSupport } from "./original-mcp-native-chat-rpc.js";
import { nativePublicFullOptions } from "./native-public-mcp-owner.js";
import { originalPublicMcpContracts } from "./native-public-original-mcp-contracts.js";
import { isTrustedLinuxRootWriterFence, type LinuxRootWriterFence } from "./linux-root-writer-fence.js";
import {
  createNativePrivateResourcePublicationPort, approvePendingPrivateResourcePublications,
} from "./private-resource-publication-native.js";
import { privateResourcePublicationMethod } from "./private-resource-publication-contracts.js";
import { originalNativeTrashMethod } from "./original-native-trash-contracts.js";
import { createNativeOriginalTrashPort, approvePendingOriginalTrash } from "./original-native-trash-native.js";
import { originalMcpTodoGenesisMethod } from "./original-mcp-todo-genesis-contracts.js";
import { createOriginalMcpTodoGenesisPort, approvePendingOriginalMcpTodoGenesis } from "./original-mcp-todo-genesis-native.js";
import { createOriginalMcpCurrentSubscriptionSource } from "./original-mcp-subscription-current-source.js";
import { originalSubscriptionReadMethod } from "./original-mcp-subscription-contracts.js";
import { originalSubscriptionProfileMethod } from "./original-mcp-subscription-profile-contracts.js";
import { createOriginalMcpNativeSyncDataHost } from "./original-mcp-native-sync.js";
import { originalNativeSyncMethod } from "./original-mcp-native-sync-contracts.js";

type AttachmentOptions = Pick<OriginalMcpNativeAttachmentOptions, "directory" | "identity" | "identitySha256">
  & { payloadBuildId: string; hostEntrySha256: string };
const completionSchema = z.strictObject({ enableModels: z.boolean().default(false) });
const bootstraps = new WeakMap<object, { current(): void; admitted(): boolean }>();
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

/**
 * Same-owner startup after independently verified cold custody. This publishes
 * only identity/consent IPC; business publication and rollback are separate.
 */
export async function bootstrapOriginalMcpNativeRuntime(options: {
  plan: OriginalMcpPlan;
  writerFence: LinuxRootWriterFence;
  attachment: AttachmentOptions;
  gitProtection?: OriginalMcpAdoptionOptions["gitProtection"];
}) {
  const plan = parseOriginalMcpPlan(options.plan), actor = Object.freeze({ id: "mcp:external", canWrite: true });
  if (!isTrustedLinuxRootWriterFence(options.writerFence, plan.root)
    || options.attachment.identity.profileSha256 !== plan.profileSha256)
    fail("NATIVE_BOOTSTRAP_BINDING_REQUIRED");
  options.writerFence.assertHeld();
  const lifetime = new AbortController();
  let server: Awaited<ReturnType<typeof startOriginalMcpNativeAttachmentServer>> | undefined;
  let opened: Awaited<ReturnType<typeof openOriginalMcpRoot>> | undefined;
  let host: OriginalMcpNativeHost | undefined;
  let modelPort: ReturnType<typeof createOriginalMcpNativeChatRpcPort> | undefined;
  let completion: Promise<OriginalMcpNativeHost> | undefined, requestedModels: boolean | undefined;
  let closed = false, admitted = false, failure: unknown;
  let closing: Promise<void> | undefined;
  try {
    opened = await openOriginalMcpRoot(plan, {
      writerFence: options.writerFence,
      ...(options.gitProtection ? { gitProtection: options.gitProtection } : {}),
      prepareNative: async storage => {
        if (!server || requestedModels === undefined || lifetime.signal.aborted) fail("NATIVE_BOOTSTRAP_ADMISSION_REQUIRED");
        const session = await server.waitForSession({ timeoutMs: 120000, signal: lifetime.signal });
        assertAuthenticatedOriginalMcpNativeSession(session);
        const support = await waitForOriginalMcpNativeSupport(session, { timeoutMs: 120000, signal: lifetime.signal });
        if (!support.includes("admission.approve") || !support.includes("public.approve"))
          fail("MISSING_NATIVE_METHOD");
        if (requestedModels) {
          if (!support.includes("model.approve")) fail("MISSING_NATIVE_METHOD");
          await waitForOriginalMcpNativeChatSupport(session, { timeoutMs: 120000, signal: lifetime.signal });
          modelPort = createOriginalMcpNativeChatRpcPort(session);
        }
        const subscriptionSource = support.includes(originalSubscriptionReadMethod)
          && support.includes(originalSubscriptionProfileMethod)
          ? createOriginalMcpCurrentSubscriptionSource(storage, session) : undefined;
        host = await createOriginalMcpNativeHost(storage, createOriginalMcpNativeRequestPolicy(session,
          subscriptionSource ? { subscriptionSource } : {}),
          modelPort ? { nativeChat: modelPort } : undefined);
        if (lifetime.signal.aborted) fail("NATIVE_BOOTSTRAP_CLOSED");
        session.signal.addEventListener("abort", revoked, { once: true });
        storage.retainNativeCleanup({ release: async () => {
          session.signal.removeEventListener("abort", revoked);
          await modelPort?.dispose();
        } });
        const trashPort = support.includes(originalNativeTrashMethod)
          ? createNativeOriginalTrashPort(storage, host, session) : undefined;
        const trashRecovery = trashPort ? await approvePendingOriginalTrash(trashPort, lifetime.signal) : undefined;
        const todoGenesisPort = support.includes(originalMcpTodoGenesisMethod)
          ? createOriginalMcpTodoGenesisPort(storage, host, session) : undefined;
        const originalTodoGenesisRecovery = todoGenesisPort
          ? await approvePendingOriginalMcpTodoGenesis(todoGenesisPort, lifetime.signal) : undefined;
        const base = await nativePublicFullOptions(storage, { actor, originalMcpHost: host });
        const registeredActions = support.includes("action.registered.review") && support.includes("action.registered.status")
          ? await (await import("./original-mcp-registered-action-host.js"))
            .createOriginalMcpRegisteredActionHost(storage, host, session) : undefined;
        const syncData = support.some(method => String(method) === originalNativeSyncMethod)
          ? createOriginalMcpNativeSyncDataHost(storage, host, session) : undefined;
        const privateResourcePublicationRecovery = support.some(method => method === privateResourcePublicationMethod)
          ? await approvePendingPrivateResourcePublications(createNativePrivateResourcePublicationPort(storage, host, session), lifetime.signal)
          : undefined;
        return { ...base, ...(registeredActions ? { hostServices: { ...base.hostServices, action: registeredActions } } : {}),
          authorizeTool: host.options.authorizeTool,
          ...(syncData ? { data: { ...base.data, ...syncData, namespace: base.data?.namespace ?? syncData.namespace } } : {}),
          ...(originalTodoGenesisRecovery ? { originalTodoGenesisRecovery } : {}),
          ...(trashPort ? { trash: { layoutVersion: "pkm.trash-lifecycle/v1" as const,
            original: trashPort, ...(trashRecovery ? { recovery: trashRecovery } : {}) } } : {}),
          ...(privateResourcePublicationRecovery ? { privateResourcePublicationRecovery } : {}) };
      },
    });
    const source = z.object({ provenance: z.object({ metadataSha256: z.string() }) }).parse(originalPublicMcpContracts());
    server = await startOriginalMcpNativeAttachmentServer({
      directory: options.attachment.directory, identity: options.attachment.identity,
      identitySha256: options.attachment.identitySha256, maxPacketBytes: 65536,
      binding: {
        root: opened.root, workspaceId: opened.workspaceId, planSha256: plan.planSha256,
        profileSha256: plan.profileSha256, catalogSha256: source.provenance.metadataSha256,
        payloadBuildId: options.attachment.payloadBuildId, hostEntrySha256: options.attachment.hostEntrySha256,
      },
    });
    const actual = opened, attachment = server;
    const current = () => {
      if (closed || failure) fail("NATIVE_BOOTSTRAP_CLOSED");
      actual.owner.assertWorkspaceLease();
      options.writerFence.assertHeld();
      options.gitProtection?.assertCurrent();
      if (admitted) host!.assertCurrent();
    };
    const bootstrap = Object.freeze({
      kind: "pkm.original-mcp-native-bootstrap/v1" as const,
      owner: actual.owner, storage: actual.storage, root: actual.root, workspaceId: actual.workspaceId,
      planSha256: plan.planSha256, journalSha256: actual.journalSha256,
      custody: structuredClone(plan),
      attachmentDescriptorPath: attachment.descriptorPath, attachmentDescriptorSha256: attachment.descriptorSha256,
      businessReady: false as const,
      status() {
        return { closed, admitted, failure: failure ? "NATIVE_BOOTSTRAP_FAILED" : null,
          businessReady: false as const, modelChannel: admitted && !!host?.nativeChat };
      },
      complete(input: unknown = {}): Promise<OriginalMcpNativeHost> {
        const parsed = completionSchema.parse(input);
        current();
        if (requestedModels !== undefined && requestedModels !== parsed.enableModels)
          fail("NATIVE_BOOTSTRAP_ADMISSION_CHANGED");
        requestedModels = parsed.enableModels;
        return completion ??= (async () => {
          try {
            const full = await actual.owner.ensureFull();
            if (full.storage !== actual.storage || !host || lifetime.signal.aborted)
              fail("NATIVE_BOOTSTRAP_SAME_OWNER_REQUIRED");
            host.assertCurrent();
            admitted = true;
            current();
            return host;
          } catch (error) {
            failure = error;
            throw error;
          }
        })();
      },
      assertCurrent: current,
      close,
    });
    bootstraps.set(bootstrap, { current, admitted: () => admitted });
    actual.owner.onLeaseLost(revoked);
    return bootstrap;
  } catch (error) {
    const failures: unknown[] = [error];
    try { await close(); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, "Native bootstrap failed and shutdown could not be confirmed.");
    throw error;
  }
  function revoked() {
    if (closed) return;
    failure = Object.assign(new Error("Native producer or owner was revoked."), { code: "NATIVE_BOOTSTRAP_REVOKED" });
    void host?.close().catch(error => {
      console.error("Native bootstrap authority shutdown failed; retained state requires inspection.");
      failure = error;
    });
  }
  function close(): Promise<void> {
    closed = true; lifetime.abort();
    return closing ??= (async () => {
      const failures: unknown[] = [];
      try { await server?.close(); } catch (error) { failures.push(error); }
      if (completion) await completion.catch(() => {});
      try { await host?.close(); } catch (error) { failures.push(error); }
      try {
        if (opened) await opened.owner.close();
        else await options.writerFence.release();
      } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Native bootstrap shutdown incomplete; preserve all state.");
    })();
  }
}

export function assertOriginalMcpNativeRuntimeBootstrap(value: unknown, admitted = false):
  asserts value is Awaited<ReturnType<typeof bootstrapOriginalMcpNativeRuntime>> {
  const state = value && typeof value === "object" ? bootstraps.get(value) : undefined;
  if (!state || admitted && !state.admitted()) fail("NATIVE_BOOTSTRAP_REQUIRED");
  state.current();
}
