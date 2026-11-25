import { acquireOriginalMcpRootFence, captureOriginalMcpCustody, openOriginalMcpRoot } from "./original-mcp-root.js";
import { createLegacyNoteBackend } from "./legacy-note-mcp.js";
import { createOriginalMcpPublicDispatcher } from "./original-mcp-public.js";
import { createOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { createOriginalMcpNativeRequestPolicy, waitForOriginalMcpNativeSupport } from "./original-mcp-native-request.js";
import { startOriginalMcpNativeAttachmentServer, type AuthenticatedOriginalMcpNativeSession } from "./original-mcp-native-attachment.js";
import { createOriginalMcpNativeSourcePolicies } from "./original-mcp-native-source-policy.js";
import { createOriginalMcpNativeChatRpcPort, waitForOriginalMcpNativeChatSupport } from "./original-mcp-native-chat-rpc.js";
import type { ToolGatewayBinding } from "./tool-gateway-contracts.js";
import { createOriginalMcpNativeTodoWorkerPolicy, enrollOriginalMcpNativeTodoWorker } from "./original-mcp-native-todo-worker-policy.js";
import { createOriginalMcpNativeRecipeSourcePolicy } from "./original-mcp-native-recipe-policy.js";
import { createOriginalMcpNativeRoomAuthority } from "./original-mcp-native-room-authority.js";
import { createOriginalMcpRoomPublicPort } from "./original-mcp-room-public.js";
import { getOriginalMcpRoomLiveSession, openOriginalMcpRoomLiveSession } from "./original-mcp-room-live-session.js";
import {
  createNativePrivateResourcePublicationPort, approvePendingPrivateResourcePublications,
} from "./private-resource-publication-native.js";
import { privateResourcePublicationMethod } from "./private-resource-publication-contracts.js";
import { originalNativeTrashMethod } from "./original-native-trash-contracts.js";
import { createNativeOriginalTrashPort, approvePendingOriginalTrash } from "./original-native-trash-native.js";
import { originalMcpTodoGenesisMethod } from "./original-mcp-todo-genesis-contracts.js";
import {
  createOriginalMcpTodoGenesisPort, approvePendingOriginalMcpTodoGenesis,
  readOriginalMcpTodoGenesisSource, revokeOriginalMcpTodoGenesisSource,
  getOriginalMcpTodoGenesisSourceScope, withOriginalMcpTodoGenesisSourceActivation,
  activateOriginalMcpTodoGenesisSource,
} from "./original-mcp-todo-genesis-native.js";
import { prepareOriginalMcpTodoGenesisSourceActivation } from "./original-mcp-todo-genesis.js";
import { bindExperimentalTodoGenesisFault, type ExperimentalTodoGenesisCheckpoint } from "./original-mcp-todo-genesis-fault.js";
import { nativePublicFullOptions } from "./native-public-mcp-owner.js";
import { originalPublicMcpContracts } from "./native-public-original-mcp-contracts.js";
import type { OriginalMcpPlan } from "./original-mcp-root-custody.js";
import {
  assertOriginalMcpColdComponentFixture, captureOriginalMcpComponentB0, preserveOriginalMcpComponentB1,
  type OriginalMcpColdComponentFixture,
} from "./original-mcp-component-recovery.js";
import { join } from "node:path";
import { createOriginalRecoveryPhase1Port } from "./original-knowledge-recovery-native.js";
import { originalRecoveryPhase1Methods } from "./original-knowledge-recovery-contracts.js";

export {
  createOriginalMcpColdComponentFixture, retireOriginalMcpColdComponent, restoreOriginalMcpColdComponentB0,
} from "./original-mcp-component-recovery.js";
export type {
  OriginalMcpColdComponentFixture, OriginalMcpComponentRetirementTicket, OriginalMcpComponentRetirement,
} from "./original-mcp-component-recovery.js";

const tools = Object.freeze(["get_note", "list_notes", "search_notes", "get_skill", "list_skills", "search_skills", "get_paper", "list_papers", "search_papers",
  "knowledge_recovery_preview", "knowledge_recovery_apply",
  "action_templates", "action_definition_check", "action_graph_check", "action_capabilities",
  "get_research", "list_research", "search_research", "paper_graph", "get_script", "search_scripts",
  "todo_board_create", "get_board", "list_boards", "add_workitem", "get_workitem", "update_workitem",
  "claim_workitem", "change_workitem_state", "list_workitems", "list_workitem_history", "list_board_changes", "note_work_items",
  "add_note", "update_note", "add_skill", "update_skill", "add_paper", "update_paper",
  "delete_note", "delete_skill", "delete_paper", "knowledge_file_trash",
  "chat_join", "chat_read", "chat_status", "chat_leave", "chat_post",
  "recipe_run_start", "recipe_run_next", "recipe_run_report", "recipe_run_get"] as const);
type ComponentTool = typeof tools[number];
type Server = Awaited<ReturnType<typeof startOriginalMcpNativeAttachmentServer>>;
type AttachmentOptions = Parameters<typeof startOriginalMcpNativeAttachmentServer>[0];
type Options = {
  operatorId: string; profileSha256: string; limits: OriginalMcpPlan["limits"];
  attachment: Pick<AttachmentOptions, "directory" | "identity" | "identitySha256">
    & { payloadBuildId: string; hostEntrySha256: string };
  nativeModels?: { toolCatalog: readonly ToolGatewayBinding[] };
  experimentalTrashFaultInjector?: (point: string) => void;
  experimentalTodoGenesisFaultInjector?: (checkpoint: ExperimentalTodoGenesisCheckpoint) => void;
};
const components = new WeakMap<object, { fixture: OriginalMcpColdComponentFixture; closed(): boolean }>();
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

/**
 * Component experiment only. Cold admission uses the unchanged actual Linux guards;
 * native enrollment must precede it, and the actual editor must be fully closed.
 * The private descriptor never enrolls/publishes a business MCP.
 */
export async function bootstrapOriginalMcpColdComponent(fixture: OriginalMcpColdComponentFixture, options: Options) {
  await assertOriginalMcpColdComponentFixture(fixture);
  if (options.experimentalTrashFaultInjector !== undefined
    && typeof options.experimentalTrashFaultInjector !== "function") fail("COMPONENT_TRASH_FAULT_INJECTOR_INVALID");
  if (options.experimentalTodoGenesisFaultInjector !== undefined
    && typeof options.experimentalTodoGenesisFaultInjector !== "function") fail("COMPONENT_TODO_FAULT_INJECTOR_INVALID");
  if (options.profileSha256 !== options.attachment.identity.profileSha256) fail("COMPONENT_PROFILE_MISMATCH");
  const writerFence = await acquireOriginalMcpRootFence(fixture.root);
  let opened: Awaited<ReturnType<typeof openOriginalMcpRoot>> | undefined;
  let server: Server | undefined, host: OriginalMcpNativeHost | undefined;
  let sourcePolicies: ReturnType<typeof createOriginalMcpNativeSourcePolicies> | undefined;
  let nativeSession: AuthenticatedOriginalMcpNativeSession | undefined;
  let roomAuthority: ReturnType<typeof createOriginalMcpNativeRoomAuthority> | undefined;
  let recipeControl: ReturnType<typeof createOriginalMcpNativeRecipeSourcePolicy> | undefined;
  let backend: Awaited<ReturnType<typeof createOriginalMcpPublicDispatcher>> | undefined;
  let todoRoleControl: Promise<Awaited<ReturnType<typeof import("./original-mcp-todo-role-native.js").createOriginalNativeTodoRoles>>> | undefined;
  let legacyBackend: ReturnType<typeof createLegacyNoteBackend> | undefined;
  try {
    const b0 = await captureOriginalMcpComponentB0(fixture, options.limits, writerFence);
    const custody = await captureOriginalMcpCustody({
      root: fixture.root, backup: join(fixture.directory, "custody"),
      operatorId: options.operatorId, profileSha256: options.profileSha256, limits: options.limits,
    }, { writerFence });
    opened = await openOriginalMcpRoot(custody, { writerFence, prepareNative: async storage => {
      if (!server) fail("COMPONENT_PRIVATE_ATTACHMENT_UNAVAILABLE");
      const session = await server.waitForSession({ timeoutMs: 300000 });
      nativeSession = session;
      const nativeSupport = await waitForOriginalMcpNativeSupport(session, { timeoutMs: 120000 });
      let nativeChat;
      if (options.nativeModels) {
        const supported = await waitForOriginalMcpNativeChatSupport(session, { timeoutMs: 120000 });
        if (!["models.catalogue", "models.select", "models.count", "models.stream", "execution.run",
          "chat.resolve", "chat.authorize", "chat.present", "chat.memory.select"].every(method =>
          supported.some(candidate => candidate === method))) fail("COMPONENT_NATIVE_MODEL_METHODS_REQUIRED");
        nativeChat = createOriginalMcpNativeChatRpcPort(session);
      }
      host = await createOriginalMcpNativeHost(storage,
        createOriginalMcpNativeRequestPolicy(session, options.nativeModels
          ? { toolCatalog: options.nativeModels.toolCatalog } : {}),
        nativeChat ? { nativeChat } : {});
      sourcePolicies = createOriginalMcpNativeSourcePolicies(storage, host, session);
      if (nativeSupport.includes(originalRecoveryPhase1Methods.source) && nativeSupport.includes(originalRecoveryPhase1Methods.repair))
        createOriginalRecoveryPhase1Port(storage, host, session);
      const privateResourcePublicationRecovery = nativeSupport.some(method => method === privateResourcePublicationMethod)
        ? await approvePendingPrivateResourcePublications(createNativePrivateResourcePublicationPort(storage, host, session))
        : undefined;
      const trashPort = nativeSupport.includes(originalNativeTrashMethod)
        ? createNativeOriginalTrashPort(storage, host, session) : undefined;
      if (options.experimentalTrashFaultInjector && !trashPort) fail("COMPONENT_NATIVE_TRASH_METHOD_REQUIRED");
      const trashRecovery = trashPort ? await approvePendingOriginalTrash(trashPort) : undefined;
      const todoGenesisPort = nativeSupport.includes(originalMcpTodoGenesisMethod)
        ? createOriginalMcpTodoGenesisPort(storage, host, session) : undefined;
      if (options.experimentalTodoGenesisFaultInjector) {
        if (!todoGenesisPort) fail("COMPONENT_NATIVE_TODO_GENESIS_METHOD_REQUIRED");
        await bindExperimentalTodoGenesisFault(fixture, storage, host, session, options.experimentalTodoGenesisFaultInjector);
      }
      const originalTodoGenesisRecovery = todoGenesisPort
        ? await approvePendingOriginalMcpTodoGenesis(todoGenesisPort) : undefined;
      const publicData = await nativePublicFullOptions(storage, {
        actor: Object.freeze({ id: "mcp:external", canWrite: true }), originalMcpHost: host,
      });
      // Source-only experiments keep the model/Chat bundle unavailable.
      return {
        ...publicData,
        ...(options.nativeModels ? host.options : { authorizeTool: host.options.authorizeTool }),
        ...(privateResourcePublicationRecovery ? { privateResourcePublicationRecovery } : {}),
        ...(originalTodoGenesisRecovery ? { originalTodoGenesisRecovery } : {}),
        ...(trashPort ? { trash: { layoutVersion: "pkm.trash-lifecycle/v1" as const,
          original: trashPort, ...(trashRecovery ? { recovery: trashRecovery } : {}),
          ...(options.experimentalTrashFaultInjector ? { faultInjector: options.experimentalTrashFaultInjector } : {}) } } : {}),
      };
    } });
    const source = originalPublicMcpContracts() as { provenance: { metadataSha256: string } };
    server = await startOriginalMcpNativeAttachmentServer({
      directory: options.attachment.directory, identity: options.attachment.identity,
      identitySha256: options.attachment.identitySha256, maxPacketBytes: 65536,
      binding: {
        root: opened.root, workspaceId: opened.workspaceId, planSha256: opened.planSha256,
        catalogSha256: source.provenance.metadataSha256, profileSha256: options.profileSha256,
        payloadBuildId: options.attachment.payloadBuildId, hostEntrySha256: options.attachment.hostEntrySha256,
      },
    });
    const actual = opened, attachment = server, inflight = new Set<Promise<unknown>>();
    const lifetime = new AbortController();
    let closed = false, closeTask: Promise<void> | undefined, completed = false;
    let completion: Promise<OriginalMcpNativeHost> | undefined;
    const component = Object.freeze({
      kind: "pkm.original-mcp-cold-component/v1" as const, fixture, b0, custody,
      root: actual.root, workspaceId: actual.workspaceId, planSha256: actual.planSha256,
      journalSha256: actual.journalSha256, owner: actual.owner, storage: actual.storage,
      attachmentDescriptorPath: attachment.descriptorPath, attachmentDescriptorSha256: attachment.descriptorSha256,
      businessReady: false as const, fullCutoverQualified: false as const,
      complete(): Promise<OriginalMcpNativeHost> {
        if (closed) return Promise.reject(Object.assign(new Error("COMPONENT_CLOSED"), { code: "COMPONENT_CLOSED" }));
        return completion ??= (async () => {
          const full = await actual.owner.ensureFull();
          if (closed || !host || full.storage !== actual.storage) fail("COMPONENT_SAME_OWNER_REQUIRED");
          host.assertCurrent();
          const actor = Object.freeze({ id: "mcp:external", canWrite: true });
          legacyBackend = createLegacyNoteBackend(actual.storage, { core: full.runtime.core, actor });
          backend = await createOriginalMcpPublicDispatcher(actual.owner, actor, host, legacyBackend);
          completed = true;
          return host;
        })();
      },
      sourcePolicies() {
        if (closed || !completed || !host || !sourcePolicies) fail("COMPONENT_SOURCE_POLICIES_UNAVAILABLE");
        host.assertCurrent();
        sourcePolicies.assertCurrent();
        return sourcePolicies;
      },
      async enrollTodoWorker(input: Parameters<typeof enrollOriginalMcpNativeTodoWorker>[3]) {
        if (closed || !completed || !host || !nativeSession) fail("COMPONENT_NATIVE_WORKER_UNAVAILABLE");
        host.assertCurrent();
        return enrollOriginalMcpNativeTodoWorker(actual.storage, host, nativeSession, input);
      },
      revokeTodoWorkers() {
        if (closed || !completed || !host || !nativeSession) fail("COMPONENT_NATIVE_WORKER_UNAVAILABLE");
        host.assertCurrent();
        createOriginalMcpNativeTodoWorkerPolicy(actual.storage, host, nativeSession).revoke();
      },
      async todoRoles() {
        if (closed || !completed || !host || !nativeSession || !options.nativeModels || !host.nativeChat)
          fail("COMPONENT_NATIVE_TODO_ROLE_MODEL_REQUIRED");
        host.assertCurrent();
        const currentHost = host, currentSession = nativeSession;
        return todoRoleControl ??= import("./original-mcp-todo-role-native.js").then(({ createOriginalNativeTodoRoles }) => {
          if (closed) fail("COMPONENT_NATIVE_TODO_ROLE_MODEL_REQUIRED");
          return createOriginalNativeTodoRoles(actual.owner, currentHost, currentSession);
        });
      },
      revokeTodoGenesisSource(boardSlug: string) {
        if (closed || !completed || !host || !nativeSession) fail("COMPONENT_NATIVE_TODO_SOURCE_UNAVAILABLE");
        host.assertCurrent();
        if (typeof boardSlug !== "string" || !readOriginalMcpTodoGenesisSource(actual.storage, host, boardSlug))
          fail("NATIVE_AUTHORITY_REQUIRED");
        revokeOriginalMcpTodoGenesisSource(actual.storage, host, boardSlug);
      },
      async activateTodoGenesisSource(boardSlug: string, options: { signal?: AbortSignal } = {}) {
        if (closed || !completed || !host || !nativeSession) fail("COMPONENT_NATIVE_TODO_SOURCE_UNAVAILABLE");
        host.assertCurrent();
        if (typeof boardSlug !== "string" || !options || Object.keys(options).some(key => key !== "signal"))
          fail("COMPONENT_NATIVE_TODO_SOURCE_INPUT_INVALID");
        const currentHost = host;
        const port = createOriginalMcpTodoGenesisPort(actual.storage, currentHost, nativeSession);
        const signal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]);
        const request = (async () => {
          signal.throwIfAborted();
          const plan = await prepareOriginalMcpTodoGenesisSourceActivation(actual.storage, currentHost, boardSlug);
          signal.throwIfAborted();
          if (closed) fail("COMPONENT_NATIVE_TODO_SOURCE_UNAVAILABLE");
          await withOriginalMcpTodoGenesisSourceActivation(port, plan,
            () => activateOriginalMcpTodoGenesisSource(actual.storage, plan), signal);
          if (closed) fail("COMPONENT_NATIVE_TODO_SOURCE_UNAVAILABLE");
          return getOriginalMcpTodoGenesisSourceScope(actual.storage, currentHost, boardSlug)!;
        })();
        inflight.add(request);
        try { return await request; } finally { inflight.delete(request); }
      },
      async recipeSourceControl() {
        if (closed || !completed || !host || !nativeSession) fail("COMPONENT_NATIVE_RECIPE_UNAVAILABLE");
        host.assertCurrent();
        const control = await (recipeControl ??= createOriginalMcpNativeRecipeSourcePolicy(actual.owner, host, nativeSession));
        if (closed) fail("COMPONENT_NATIVE_RECIPE_UNAVAILABLE");
        control.assertCurrent();
        return control;
      },
      async selectRoom(roomId: string) {
        if (closed || !completed || !host || !nativeSession) fail("COMPONENT_NATIVE_ROOM_UNAVAILABLE");
        host.assertCurrent();
        roomAuthority ??= createOriginalMcpNativeRoomAuthority(actual.storage, host, nativeSession);
        await roomAuthority.admit(roomId);
        return createOriginalMcpRoomPublicPort(actual.storage, host, roomAuthority, roomId);
      },
      async openRoomLive(roomId: string, selection: unknown, options: { directory: string; signal?: AbortSignal }) {
        if (closed || !completed || !host || !nativeSession || !roomAuthority) fail("COMPONENT_NATIVE_ROOM_UNAVAILABLE");
        host.assertCurrent();
        const request = openOriginalMcpRoomLiveSession(actual.owner, host, nativeSession, roomAuthority, roomId, selection, options);
        inflight.add(request);
        try { return await request; } finally { inflight.delete(request); }
      },
      roomLive() {
        if (!completed || !host) fail("COMPONENT_NATIVE_ROOM_UNAVAILABLE");
        return getOriginalMcpRoomLiveSession(actual.storage, host);
      },
      async invokeCanonical(name: "legacy_capability_read" | "legacy_capability_call", input: unknown, signal?: AbortSignal) {
        if (closed || !completed || !backend || !host) fail("COMPONENT_NATIVE_CANONICAL_UNAVAILABLE");
        host.assertCurrent();
        const request = backend.invokeCanonical(name, input, signal);
        inflight.add(request);
        try { return await request; } finally { inflight.delete(request); }
      },
      async invoke(tool: ComponentTool, args: Readonly<Record<string, unknown>>, signal?: AbortSignal, callId?: string) {
        if (closed) fail("COMPONENT_CLOSED");
        if (!(tools as readonly string[]).includes(tool)) fail("COMPONENT_TOOL_NOT_ADMITTED");
        if (!completed || !backend || !host) fail("NATIVE_AUTHORITY_REQUIRED");
        host.assertCurrent();
        const request = backend.invoke({ tool, arguments: args }, signal, callId);
        inflight.add(request);
        try { return await request; } finally { inflight.delete(request); }
      },
      close(): Promise<void> {
        closed = true;
        lifetime.abort();
        return closeTask ??= (async () => {
          const failures: unknown[] = [];
          try { if (host) await getOriginalMcpRoomLiveSession(actual.storage, host)?.close(); }
          catch (error) { failures.push(error); }
          try { await attachment.close(); } catch (error) { failures.push(error); }
          await Promise.allSettled([...inflight, ...(completion ? [completion] : [])]);
          try { await legacyBackend?.close(); } catch (error) { failures.push(error); }
          try { await actual.owner.close(); } catch (error) { failures.push(error); }
          if (failures.length) throw new AggregateError(failures, "Cold component shutdown incomplete; retain all state.");
        })();
      },
    });
    let shutdownConfirmed = false;
    const publicComponent = Object.freeze({ ...component, async close() {
      await component.close(); shutdownConfirmed = true;
    } });
    components.set(publicComponent, { fixture, closed: () => shutdownConfirmed });
    return publicComponent;
  } catch (error) {
    const failures: unknown[] = [error];
    try { await server?.close(); } catch (cleanup) { failures.push(cleanup); }
    try { await legacyBackend?.close(); } catch (cleanup) { failures.push(cleanup); }
    try { if (opened) await opened.owner.close(); else await writerFence.release(); }
    catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, "Cold component bootstrap and cleanup failed; retain all state.");
    throw error;
  }
}
export async function preserveOriginalMcpColdComponentB1(component: Awaited<ReturnType<typeof bootstrapOriginalMcpColdComponent>>) {
  const binding = components.get(component);
  if (!binding?.closed()) fail("COMPONENT_CONFIRMED_SHUTDOWN_REQUIRED");
  return preserveOriginalMcpComponentB1(binding.fixture);
}
