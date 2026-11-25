import { RootOwner, assertRootOwner, type RootReadScope } from "./root-owner.js";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { startNativePublicMcp } from "./native-public-mcp.js";
import { createNativeScopedNoteRead, type NativeScopedNoteRead } from "./native-public-mcp-note-read.js";
import { z } from "zod";
import { legacyNoteInventoryArgs } from "./legacy-note-inventory-contracts.js";
import type { Actor } from "./contracts.js";
import type { Storage } from "./storage.js";
import type { NativeRuntimeOptions } from "./native-runtime.js";
import type { NativePublicBackend } from "./native-public-mcp.js";
import type { NativeMcpBackend } from "./native-public-mcp-backend.js";
import type { LegacyNoteCanonical } from "./legacy-note-mcp.js";
import type { FreshNoteQuery } from "./fresh-note-query-contracts.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { DeploymentIntegrity } from "./deployment-integrity.js";
import { CapabilityError, CapabilityRegistry, todoCapabilities, validateCapabilityInput } from "./domain/legacy-mcp-registry.js";
import { externalMemoryCapabilities } from "./domain/legacy-mcp-memory-contract.js";
import { readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import type { OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import type { createOriginalMcpPublicDispatcher } from "./original-mcp-public.js";

const capabilityDiscoveryRequest = z.strictObject({
  action: z.enum(["list", "search", "describe"]), args: z.record(z.string(), z.unknown()), workerToken: z.string().optional(),
});
const basicNoteSearchRequest = z.strictObject({
  tool: z.literal("search_notes"), arguments: z.record(z.string(), z.unknown()),
});
function basicNoteQuery(name: string, request: unknown): FreshNoteQuery | undefined {
  if (name === "list_notes") {
    const args = legacyNoteInventoryArgs.safeParse(request);
    return args.success ? { kind: "list", arguments: args.data } : undefined;
  }
  if (name !== "legacy_knowledge_read") return undefined;
  const parsed = basicNoteSearchRequest.safeParse(request);
  if (!parsed.success) return undefined;
  const args = parsed.data.arguments;
  if (args.detail !== undefined && args.detail !== "legacy" || args.route !== undefined && args.route !== "lexical") return undefined;
  const query = z.string().safeParse(args.query);
  const limit = z.number().int().optional().safeParse(args.limit);
  return query.success && limit.success ? { kind: "legacy-lexical",
    arguments: { query: query.data, ...(limit.data === undefined ? {} : { limit: limit.data }) } } : undefined;
}

export interface NativePublicOwnerOptions {
  readonly actor: Readonly<Actor>;
  readonly trustedActions?: boolean;
  readonly trustedPlugins?: boolean;
  readonly assetClassification?: boolean;
  readonly snapshotScheduler?: string;
  readonly deployment?: DeploymentIntegrity;
  readonly originalMcpHost?: OriginalMcpNativeHost;
}
export type { NativeScopedNoteRead } from "./native-public-mcp-note-read.js";

/** Evaluated on the one real Storage attachment, before its one canonical runtime is composed. */
export async function nativePublicFullOptions(storage: Storage,
  options: NativePublicOwnerOptions): Promise<Omit<NativeRuntimeOptions, "storage">> {
  const original = readOriginalMcpJournal(storage.workspaceRoot());
  if (original && (options.trustedActions || options.trustedPlugins || options.assetClassification || options.snapshotScheduler))
    throw new CoreError("ACCESS_DENIED", "Original MCP custody preserves old state without granting Action, plugin or private runtime authority.");
  const [notePolicy, pluginHost, actionHost] = await Promise.all([
    import("./legacy-mcp-note-policy.js"),
    options.trustedPlugins ? import("./vscode-plugin-host.js") : undefined,
    options.trustedActions ? import("./trusted-action-host.js") : undefined,
  ]);
  let plugins: NativeRuntimeOptions["plugins"];
  try {
    plugins = pluginHost ? await pluginHost.createVscodePluginRuntime(storage, { actorId: options.actor.id }) : undefined;
    if (plugins) {
      const owned = plugins;
      storage.retainNativeCleanup({ release: async () => { await owned.close(); } });
    }
    const hostServices = actionHost ? await actionHost.createTrustedActionHostOptions(storage) : undefined;
    const originalTrash = original && options.originalMcpHost
      ? (await import("./original-native-trash-native.js")).getNativeOriginalTrashPort(storage, options.originalMcpHost) : undefined;
    return {
      ...(plugins ? { plugins } : {}), ...(hostServices ? { hostServices } : {}),
      trash: originalTrash ? { layoutVersion: "pkm.trash-lifecycle/v1", original: originalTrash }
        : options.actor.canWrite && !original ? { layoutVersion: "pkm.trash-lifecycle/v1" } : undefined,
      legacyNoteWorkItems: await notePolicy.legacyMcpNotePolicy(storage, options.actor),
    };
  } catch (error) { await plugins?.close(); throw error; }
}

export async function startNativePublicOwnerMcp(directory: string,
  options: NativePublicOwnerOptions & { readonly manifest: Parameters<typeof startNativePublicMcp>[1]["manifest"] },
  transport?: Transport, scopedNote?: NativeScopedNoteRead) {
  options = Object.freeze({ ...options, actor: Object.freeze({ ...options.actor }) });
  const advanced = options.trustedActions || options.trustedPlugins || options.assetClassification || options.snapshotScheduler;
  if (advanced && options.deployment)
    throw new Error("Trusted/plugin/autonomous enrollment requires a separate full-foreground generation.");
  if (advanced) await Promise.all([
    import("./storage.js"), import("./native-runtime.js"), import("./legacy-note-mcp.js"), import("./legacy-mcp-note-policy.js"),
    options.trustedPlugins ? import("./vscode-plugin-host.js") : undefined,
    options.trustedActions ? import("./trusted-action-host.js") : undefined,
    options.assetClassification ? import("./legacy-asset-classification.js") : undefined,
    options.snapshotScheduler ? import("./legacy-knowledge-snapshot-scheduler.js") : undefined,
  ]);
  const owner = await RootOwner.open(directory, {
    ...(advanced ? { native: {} } : {}),
    prepareNative: storage => nativePublicFullOptions(storage, options),
  });
  const backend = createNativePublicOwnerBackend(owner, options, scopedNote ?? createNativeScopedNoteRead(owner));
  try {
    if (advanced || owner.startupClassification().kind === "full-required") {
      await options.deployment?.ensureCapabilities("all-deployment");
      await backend.prepareFull();
    }
    const facade = await startNativePublicMcp(backend, {
      writable: options.actor.canWrite, assetClassification: options.assetClassification,
      snapshotScheduler: !!options.snapshotScheduler, manifest: options.manifest, closeBackend: () => owner.close(),
      deployment: options.deployment,
    }, transport);
    owner.onLeaseLost(() => { facade.lifecycle.quiesce(); });
    return { ...facade, owner };
  } catch (error) {
    try { await options.deployment?.close(); await backend.close(); } finally { await owner.close(); }
    throw error;
  }
}

export function createNativePublicOwnerBackend(owner: RootOwner, options: NativePublicOwnerOptions,
  scopedNote?: NativeScopedNoteRead): NativePublicBackend & { prepareFull(): Promise<void> } {
  assertRootOwner(owner);
  options = Object.freeze({ ...options, actor: Object.freeze({ ...options.actor }) });
  const classification = owner.startupClassification();
  const original = readOriginalMcpJournal(owner.workspaceRoot());
  const nativeContext = classification.kind === "full-required" && classification.reason === "native-context";
  let fullTask: Promise<NativeMcpBackend> | undefined;
  let fullBackend: NativeMcpBackend | undefined;
  let failure: unknown;
  let closed = false;
  let closeTask: Promise<void> | undefined;
  let discoveryRegistry: CapabilityRegistry | undefined;
  let originalPublicTask: ReturnType<typeof createOriginalMcpPublicDispatcher> | undefined;

  const full = () => fullTask ??= (async () => {
    const { storage, runtime } = await owner.ensureFull();
    const [note, assets, snapshots] = await Promise.all([
      import("./legacy-note-mcp.js"),
      options.assetClassification ? import("./legacy-asset-classification.js") : undefined,
      options.snapshotScheduler ? import("./legacy-knowledge-snapshot-scheduler.js") : undefined,
    ]);
    if (assets) {
      const workspaceRoot = storage.workspaceRoot(), workspaceId = await storage.workspaceId();
      const authorityId = "legacy-compact-mcp.asset-classification.v1";
      const allowedTools = ["asset_classify_preview", "asset_classify_apply", "asset_classify_rollback"] as const;
      await assets.admitLegacyAssetClassification(storage, options.actor, {
        authorityId, allowedTools: [...allowedTools],
        authorize: binding => binding.actorId === options.actor.id && binding.workspaceId === workspaceId
          && binding.workspaceRoot === workspaceRoot && binding.authorityId === authorityId && binding.operation === "admit"
          && JSON.stringify([...binding.allowedTools].sort()) === JSON.stringify([...allowedTools].sort()),
      });
    }
    let snapshotHost: LegacyNoteCanonical["snapshotHost"];
    if (snapshots) {
      const scheduler = snapshots.createAdmittedLegacyKnowledgeSnapshotScheduler(storage, options.actor, options.snapshotScheduler!);
      owner.retainResource({ release: () => scheduler.close() });
      await scheduler.start();
      snapshotHost = scheduler.host;
    }
    const privateNoteQuery = async (query: FreshNoteQuery) => {
      if (options.actor.id !== "mcp:external")
        throw new CoreError("ACCESS_DENIED", "Private Note reads require the fixed native MCP actor.");
      const reply = await owner.withReadScope(async scope => {
        scope.assertHeld();
        if (scope.full?.storage !== storage)
          throw new CoreError("STORAGE_UNAVAILABLE", "Private Note reads require the actual same-owner Storage attachment.");
        const reply = await storage.readLegacyNotes(scope, query);
        scope.assertHeld();
        if (options.actor.id !== "mcp:external")
          throw new CoreError("ACCESS_DENIED", "Private Note publication requires the fixed native MCP actor.");
        return reply;
      });
      return reply.kind === "canonical-required" ? undefined : reply;
    };
    fullBackend = note.createLegacyNoteBackend(storage, {
      core: runtime.core, actor: options.actor, actionHost: runtime.services.hostServices,
      snapshotHost, assetClassificationEnabled: options.assetClassification,
      noteQuery: options.actor.id === "mcp:external" ? {
        list: arguments_ => privateNoteQuery({ kind: "list", arguments: arguments_ }),
        search: arguments_ => privateNoteQuery({ kind: "legacy-lexical", arguments: arguments_ }),
      } : undefined,
    });
    return fullBackend;
  })().catch(error => { failure = error; throw error; });
  const originalPublic = () => originalPublicTask ??= (async () => {
    if (!original || !options.originalMcpHost)
      throw new CoreError("ACCESS_DENIED", "The full original MCP adapter requires its exact fresh native profile/authority session.");
    const backend = await full();
    const { createOriginalMcpPublicDispatcher } = await import("./original-mcp-public.js");
    return createOriginalMcpPublicDispatcher(owner, options.actor, options.originalMcpHost, backend);
  })();

  async function simpleFullScope(scope: RootReadScope) {
    return (await owner.qualifyFreshLegacyReadScope(scope)).kind === "plain";
  }

  return {
    async prepareFull() { await full(); },
    async invoke(name, request, signal?: AbortSignal) {
      if (closed) throw new CoreError("STORAGE_UNAVAILABLE", "Native MCP backend is closed.");
      if (failure !== undefined) throw failure;
      options.deployment?.assertAdmitted();
      if (name === "original_mcp_public") return (await originalPublic()).invoke(request, signal);
      if (original && options.originalMcpHost && ["legacy_capability_read", "legacy_capability_call"].includes(name))
        return (await originalPublic()).invokeCanonical(name, request, signal);
      if (original) {
        const tool = request && typeof request === "object" ? (request as { tool?: unknown }).tool : undefined;
        const read = name === "legacy_knowledge_read" && typeof tool === "string"
          && ["get_note", "list_notes", "search_notes", "get_skill", "list_skills", "search_skills",
            "get_paper", "get_research", "list_papers", "list_research", "search_papers", "search_research"].includes(tool);
        const write = name === "legacy_knowledge_write" && typeof tool === "string"
          && ["add_note", "update_note", "add_skill", "update_skill", "add_paper", "update_paper"].includes(tool);
        const trashWrite = name === "legacy_knowledge_trash" && typeof tool === "string"
          && ["delete_note", "delete_skill", "delete_paper", "knowledge_file_trash"].includes(tool) && options.originalMcpHost
          && (await import("./original-native-trash-native.js")).getNativeOriginalTrashPort(
            (await owner.ensureFull()).storage, options.originalMcpHost) !== undefined;
        if (name !== "list_notes" && !read && !write && !trashWrite)
          throw new CoreError("NOT_AVAILABLE", "This original-root admission exposes only public Note/Skill/Paper content. Legacy Chat, Actions, Trash and private runtimes remain archive-only.");
      }
      if (name === "legacy_capability_read") {
        const parsed = capabilityDiscoveryRequest.safeParse(request);
        if (parsed.success) {
          owner.assertAttachmentAdmission();
          const { action, args, workerToken } = parsed.data;
          if (workerToken !== undefined) throw new CapabilityError("INVALID_ARGUMENT", "Worker tokens require an exact Todo Board.");
          if (JSON.stringify(args).length > 64000)
            throw new CapabilityError("INVALID_ARGUMENT", "Provide a bounded capability request object.");
          const registry = discoveryRegistry ??= new CapabilityRegistry([...todoCapabilities, ...externalMemoryCapabilities]
            .filter(operation => options.actor.canWrite || operation.readOnly));
          let value: Record<string, unknown>;
          if (action === "describe") {
            validateCapabilityInput(args, { type: "object", properties: { operation: { type: "string", maxLength: 100 } },
              required: ["operation"], additionalProperties: false });
            value = { ...registry.describe(String(args.operation)), catalogRevision: registry.revision };
          } else value = registry.discover(args, action === "search");
          return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
        }
      }
      // Canonical attachment is allowed here; do not make real basic reads await the deployment scan.
      const tool = request && typeof request === "object" ? (request as { tool?: unknown }).tool : undefined;
      const basic = name === "list_notes" || ["legacy_knowledge_read", "legacy_indexed_knowledge_read"].includes(name)
        && typeof tool === "string" && [
          "get_note", "list_notes", "search_notes", "get_skill", "list_skills", "search_skills",
          "get_knowledge", "search_knowledge", "get_script", "search_scripts", "retrieval_status",
          "get_paper", "search_papers", "get_research", "search_research",
        ].includes(tool);
      if (!basic) await options.deployment?.ensureCapabilities();
      if (!nativeContext && options.actor.id === "mcp:external" && !options.trustedActions && !options.trustedPlugins
        && !options.assetClassification && !options.snapshotScheduler) {
        const query = basicNoteQuery(name, request);
        if (query) {
          const reply = await owner.withReadScope(scope => owner.readBasicLegacyNotes(scope, query));
          if (reply !== undefined) {
            const value: unknown = JSON.parse(reply.text);
            if (query.kind === "list") {
              if (!value || typeof value !== "object" || Array.isArray(value))
                throw new CoreError("INVALID_RESULT", "The private Note inventory returned an invalid original result.");
              const result = z.record(z.string(), z.unknown()).parse(value);
              return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
            }
            if (!Array.isArray(value))
              throw new CoreError("INVALID_RESULT", "The private legacy Note search returned an invalid original result.");
            const result = { value, text: reply.text };
            return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
          }
        }
      }
      if (!original && !nativeContext && name === "legacy_knowledge_read" && scopedNote?.accepts(request)) {
        const attempted = await owner.withReadScope(async scope => {
          const read = async () => {
            if (scope.full && !await simpleFullScope(scope)) return undefined;
            const value = await scopedNote.read(scope, request);
            scope.assertHeld();
            if (scope.full && !await simpleFullScope(scope))
              throw new CoreError("CONFLICT", "Root admission changed during the read; its result was not published.");
            return value;
          };
          return scope.full ? scope.full.storage.withWorkspaceExclusive(read) : read();
        });
        if (attempted !== undefined) return attempted;
      }
      return (await full()).invoke(name, request);
    },
    close() {
      if (closeTask) return closeTask;
      closed = true;
      return closeTask = (async () => {
        if (fullTask) await fullTask.catch(() => undefined);
        if (originalPublicTask) await originalPublicTask.catch(() => undefined);
        await fullBackend?.close();
      })();
    },
  };
}
