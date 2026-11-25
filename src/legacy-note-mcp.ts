import { lstatSync, opendirSync, readdirSync } from "node:fs";
import { publicName } from "./public-identity.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { Storage } from "./storage.js";
import type { Core } from "./core.js";
import type { Actor } from "./contracts.js";
import { createLegacyCapabilityDispatcher, legacyCapabilityRequest } from "./legacy-capability-mcp.js";
import { runLegacyMcpPython } from "./legacy-mcp-python.js";
import { decodeMarkdownPath, readKnowledgePathSnapshot, scanMarkdown, sha256 } from "./markdown.js";
import { readProjectRecipeSnapshot } from "./project-recipes.js";
import { legacyKnowledgeTree, type LegacySnapshotFile } from "./legacy-knowledge-snapshot.js";
import { readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { originalMcpPublicRequestActive } from "./original-mcp-native-host.js";
import { legacyKnowledgeWrite, legacyKnowledgeWriteRequest } from "./legacy-knowledge-write.js";
import { createNativeLegacyNoteWorkItemsHost } from "./legacy-note-workitems.js";
import { parseLegacyRouterConfig } from "./legacy-router-config.js";
import { todoBoardFilename } from "./domain/todo-board.js";
import { randomUUID } from "node:crypto";
import { CoreError } from "./contracts.js";
import { legacyKnowledgeTrash, legacyKnowledgeTrashRequest } from "./legacy-knowledge-trash.js";
import { legacyIndexedKnowledgeRead, legacyIndexedKnowledgeRequest } from "./legacy-retrieval-index.js";
import { legacySkillMaintenance, legacySkillMaintenanceRequest } from "./legacy-skill-maintenance.js";
import { readLegacySkillMaintenanceGenesis } from "./host-composition-legacy-state.js";
import { LegacyMcpPythonWorker } from "./legacy-mcp-python-worker.js";
import { createNativeLegacyTodoBoard } from "./legacy-todo-board-create.js";
import { legacyTodoBoardCreateArguments } from "./legacy-todo-board-create-contracts.js";
import { legacyKnowledgeRecovery, legacyKnowledgeRecoveryRequest } from "./legacy-knowledge-recovery.js";
import {
  legacyActionCall, legacyActionCallRequest, legacyActionCapabilitiesRead, legacyActionCapabilitiesRequest,
  legacyActionRead, legacyActionReadRequest, legacyActionWrite, legacyActionWriteRequest,
} from "./legacy-action-mcp.js";
import type { createHostServices } from "./host-services.js";
import {
  legacyActionCatalog, legacyActionCatalogReadRequest, legacyActionCatalogWriteRequest,
} from "./legacy-action-catalog.js";
import { invokeAdmittedLegacyKnowledgeSnapshot, legacyKnowledgeSnapshot,
  type LegacyKnowledgeSnapshotHost } from "./legacy-knowledge-snapshots.js";
import { legacyActionArtifact } from "./legacy-action-artifacts.js";
import {
  createLegacyAssetClassificationSession, invokeAdmittedLegacyAssetClassification,
} from "./legacy-asset-classification.js";
import { registerLegacyChatroomContinuation, type LegacyChatroomContinuation } from "./legacy-chatroom-continuation.js";
import type { LegacyChatroomRuntime } from "./legacy-chatroom-runtime.js";
import type { LegacyApiChatRuntime } from "./legacy-api-chat-runtime.js";
import { NativeMcpBackend } from "./native-public-mcp-backend.js";
import type { FreshNoteQueryReply, LegacyNoteListArguments, LegacyNoteSearchArguments } from "./fresh-note-query-contracts.js";
import { knowledgeReadPrivateTopLevels } from "./fresh-note-query-contracts.js";
import {
  buildLegacyInventoryView, legacyInventoryPage, normalizeLegacyList, projectLegacyNote,
} from "./domain/legacy-note-query-original.js";

const canonicalBackends = new WeakMap<NativeMcpBackend, { storage: Storage; core: Core; actor: Readonly<Actor> }>();
export function assertLegacyNoteBackendBinding(backend: NativeMcpBackend, storage: Storage, core: Core, actor: Readonly<Actor>): void {
  const bound = canonicalBackends.get(backend);
  if (!bound || bound.storage !== storage || bound.core !== core || bound.actor.id !== actor.id
    || bound.actor.canWrite !== actor.canWrite || bound.actor.boardWorker || actor.boardWorker)
    throw new CoreError("ACCESS_DENIED", "The original public adapter requires its actual same-owner canonical backend and actor.");
}

const script = fileURLToPath(new URL("../compat/legacy-note-inventory.py", import.meta.url));
export const legacyNoteInventoryArgs = z.strictObject({
  type: z.string().nullable().optional(),
  directory: z.string().nullable().optional(),
  recursive: z.boolean().default(true),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(50),
  inventory_revision: z.string().nullable().optional(),
});
const legacySnapshotReadRequest = z.strictObject({
  tool: z.literal("knowledge_snapshot_status"), arguments: z.strictObject({}),
});
const legacySnapshotWriteRequest = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.literal("knowledge_snapshot_create"), arguments: z.strictObject({ reason: z.string().default("manual") }) }),
  z.strictObject({ tool: z.literal("knowledge_snapshot_configure"), arguments: z.strictObject({
    enabled: z.boolean().default(true), local_time: z.string().default("17:00"),
    timezone: z.string().default("America/Los_Angeles"),
  }) }),
  z.strictObject({ tool: z.literal("knowledge_snapshot_restore_preview"), arguments: z.strictObject({ tag: z.string() }) }),
  z.strictObject({ tool: z.literal("knowledge_snapshot_restore_apply"), arguments: z.strictObject({
    preview_id: z.string(), approved_sha256: z.string(),
  }) }),
]);

export async function legacyNoteInventory(storage: Storage, args: z.infer<typeof legacyNoteInventoryArgs>): Promise<Record<string, unknown>> {
  return storage.withWorkspaceExclusive(async () => {
    storage.assertWorkspaceLease();
    const root = storage.workspaceRoot(), privateTopLevels = knowledgeReadPrivateTopLevels(root, "notes");
    if (privateTopLevels.size) {
      const normalized = normalizeLegacyList(args);
      if (privateTopLevels.has(normalized.directory.split("/")[0]!))
        throw new CoreError("ACCESS_DENIED", "Original private Note directories remain archive-only.");
      const visible = (path: string) => {
        const parts = path.split("/");
        return /\.md$/i.test(path) && !parts.some(part => part.startsWith(".") || part === "_assets" || /\.assets$/i.test(part))
          && (!normalized.directory || path.startsWith(`${normalized.directory}/`))
          && (normalized.recursive || !path.slice(normalized.directory ? normalized.directory.length + 1 : 0).includes("/"));
      };
      // The existing Root-bound snapshot denies private subtrees before stat/open/read.
      // Never send this admitted Root to the unrestricted filesystem Python inventory.
      const files = legacyKnowledgeTree(root, "notes", "", true);
      if (normalized.directory && !files.some(file => file.directory && file.path === normalized.directory))
        throw new CoreError("INVALID_ARGUMENT", "Notes directory was not found.");
      const paths = new Set(files.map(file => file.path));
      const rows = files.filter(file => !file.directory && visible(file.path)).map(file => {
        const snapshot = readKnowledgePathSnapshot(root, file.path, "notes");
        if (!snapshot.file) throw new CoreError("CONFLICT", "Notes changed during inventory; restart from offset 0.");
        let raw: string;
        try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot.file.bytes); }
        catch { throw new CoreError("INVALID_DOCUMENT", "Note inventory requires valid UTF-8 Markdown."); }
        return projectLegacyNote({
          path: file.path, raw, mtimeNs: snapshot.file.mtimeNs, sha256: sha256(snapshot.file.bytes),
          boardPresent: paths.has(`${file.path.slice(0, -3)}.assets/pkm-todo-board.json`),
        }).row;
      });
      if (JSON.stringify(files) !== JSON.stringify(legacyKnowledgeTree(root, "notes", "", true)))
        throw new CoreError("CONFLICT", "Notes changed during inventory; restart from offset 0.");
      storage.assertWorkspaceLease();
      return JSON.parse(legacyInventoryPage(buildLegacyInventoryView(rows, normalized), normalized));
    }
    const result = await runLegacyMcpPython(script, [storage.workspaceRoot()], args);
    storage.assertWorkspaceLease();
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Legacy Note inventory returned an invalid result.");
    return result as Record<string, unknown>;
  });
}

export interface LegacyNoteCanonical {
  core: Core; actor: Actor; snapshotHost?: LegacyKnowledgeSnapshotHost; assetClassificationEnabled?: boolean;
    actionHost?: ReturnType<typeof createHostServices>; chatroomContinuation?: LegacyChatroomContinuation;
    chatroomRuntime?: LegacyChatroomRuntime; apiChatRuntime?: LegacyApiChatRuntime;
    noteQuery?: {
      list(arguments_: LegacyNoteListArguments): Promise<FreshNoteQueryReply | undefined>;
      search(arguments_: LegacyNoteSearchArguments): Promise<FreshNoteQueryReply | undefined>;
    };
}

export async function startLegacyNoteMcp(storage: Storage, transport: Transport = new StdioServerTransport(),
  canonical?: LegacyNoteCanonical,
  control?: {
    allowTool(name: string): boolean;
    invoke<T>(name: string, work: () => T | Promise<T>): Promise<T>;
    trackWorkerClose(close: Promise<void>): void;
  }) {
  const server = new McpServer({ name: publicName, version: "0.1.0" });
  if (control) {
    const registerTool = server.registerTool.bind(server);
    server.registerTool = ((name: string, config: unknown, callback: (...args: any[]) => unknown) => {
      const registered = registerTool(name, config as never,
        ((...args: any[]) => control.invoke(name, () => callback(...args))) as never);
      if (!control.allowTool(name)) registered.disable();
      return registered;
    }) as typeof server.registerTool;
  }
  const backend = createLegacyNoteBackend(storage, canonical);
  if (canonical?.chatroomContinuation) registerLegacyChatroomContinuation(server, canonical.chatroomContinuation);
  for (const [name, tool] of backend.tools) {
    server.registerTool(name, {
      description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations,
    }, async args => tool.invoke(args));
  }
  const closeServer = server.close.bind(server);
  server.close = async () => { try { await closeServer(); } finally { await backend.close(); } };
  server.server.onclose = () => {
    const closing = backend.close();
    if (control) control.trackWorkerClose(closing);
    else void closing.catch(error => server.server.onerror?.(error));
  };
  try { await server.connect(transport); }
  catch (error) { await backend.close(); throw error; }
  return server;
}

export function createLegacyNoteBackend(storage: Storage, canonical?: LegacyNoteCanonical): NativeMcpBackend {
  const server = new NativeMcpBackend();
  if (canonical) {
    canonicalBackends.set(server, { storage, core: canonical.core, actor: Object.freeze({ ...canonical.actor }) });
    server.onClose(() => { canonicalBackends.delete(server); });
  }
  const archiveOnlyOriginal = !!readOriginalMcpJournal(storage.workspaceRoot());
  if (canonical?.apiChatRuntime) {
    const identity = { namespace: z.string().regex(/^[a-f0-9]{16}$/), chatId: z.string().uuid() };
    const reply = async (work: () => Promise<unknown>) => {
      try { return { content: [{ type: "text" as const, text: JSON.stringify(await work()) }] }; }
      catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Native API Chat refused." }] }; }
    };
    server.registerTool("legacy_api_chat_history", {
      inputSchema: z.strictObject(identity),
      description: "Explicit fresh host-authorized native API Chat history, including original segmented messages and inline image bytes.",
    }, args => reply(() => canonical.apiChatRuntime!.history(args)));
    if (canonical.actor.canWrite) server.registerTool("legacy_api_chat_continue", {
      inputSchema: z.strictObject({ ...identity, operationId: z.string().min(1).max(128),
        expectedRevision: z.number().int().nonnegative(), text: z.string().min(1).max(100_000),
        images: z.array(z.strictObject({ label: z.string(), mimeType: z.string(), dataBase64: z.string() })).max(32).optional() }),
      description: "Explicit experimental native API Chat continuation through a fresh host-configured provider; durable operation recovery, no inherited legacy execution permissions.",
    }, args => reply(() => canonical.apiChatRuntime!.continue(args)));
  }
  if (canonical?.chatroomRuntime) server.registerTool("legacy_chatroom_reopen", {
    inputSchema: z.strictObject({ roomId: z.string().uuid() }),
    description: "Explicit experimental native host for an authorized same-root legacy Room. No inherited legacy credentials; mutable state stays in core.sqlite.",
  }, async args => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await canonical.chatroomRuntime!.reopen(args.roomId)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Native Room refused." }] }; }
  });
  let indexedWorker: LegacyMcpPythonWorker | undefined;
  server.registerTool("list_notes", {
    description: "Experimental original Note inventory in the isolated legacy compatibility server.",
    inputSchema: legacyNoteInventoryArgs,
    annotations: { readOnlyHint: true },
  }, async args => {
    const fresh = await canonical?.noteQuery?.list(args);
    const value: unknown = fresh === undefined ? await legacyNoteInventory(storage, args) : JSON.parse(fresh.text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new CoreError("INVALID_RESULT", "The private Note inventory returned an invalid original result.");
    const result = z.record(z.string(), z.unknown()).parse(value);
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  });
  if (canonical) {
    const assetClassificationSession = createLegacyAssetClassificationSession();
    if (canonical.assetClassificationEnabled) {
      server.registerTool("legacy_asset_classification_preview", {
        description: "Original asset classification preview under an existing native host admission, with session-local approval state.",
        inputSchema: z.strictObject({ tool: z.literal("asset_classify_preview"), arguments: z.strictObject({}) }),
        annotations: { readOnlyHint: true },
      }, async request => {
        const value = await invokeAdmittedLegacyAssetClassification(storage, canonical.actor, {
          tool: request.tool, args: request.arguments, operationId: randomUUID(),
        }, assetClassificationSession), text = JSON.stringify(value);
        return { content: [{ type: "text", text }], structuredContent: { value, text } };
      });
      if (canonical.actor.canWrite) server.registerTool("legacy_asset_classification_write", {
        description: "Original explicitly approved asset classification subset or journal rollback under existing native host admission.",
        inputSchema: z.discriminatedUnion("tool", [
          z.strictObject({ tool: z.literal("asset_classify_apply"),
            arguments: z.strictObject({ preview_id: z.string(), proposal_ids: z.array(z.string()) }) }),
          z.strictObject({ tool: z.literal("asset_classify_rollback"), arguments: z.strictObject({ journal_id: z.string() }) }),
        ]),
        annotations: { readOnlyHint: false },
      }, async request => {
        const value = await invokeAdmittedLegacyAssetClassification(storage, canonical.actor, {
          tool: request.tool, args: request.arguments, operationId: randomUUID(),
        }, assetClassificationSession), text = JSON.stringify(value);
        return { content: [{ type: "text", text }], structuredContent: { value, text } };
      });
    }
    if (canonical.actor.canWrite) server.registerTool("legacy_action_artifact_write", {
      description: "Original borrowed artifact import and exclusive export, only from exact independently host-approved paths within one fixed selected workspace. Unknown effects require native reconciliation.",
      inputSchema: z.discriminatedUnion("tool", [
        z.strictObject({ tool: z.literal("action_artifact_import"), arguments: z.strictObject({ local_path: z.string() }) }),
        z.strictObject({ tool: z.literal("action_artifact_export"), arguments: z.strictObject({ artifact_id: z.string(), destination: z.string() }) }),
      ]),
      annotations: { readOnlyHint: false },
    }, async request => {
      const authorizeManaged = request.tool === "action_artifact_export" && canonical.actionHost
        ? await canonical.actionHost.prepareManagedArtifactExport(canonical.actor, request.arguments.artifact_id) : undefined;
      const authorizePicked = canonical.actionHost
        ? await canonical.actionHost.preparePickedArtifactAccess(canonical.actor) : undefined;
      const value = request.tool === "action_artifact_import"
        ? await legacyActionArtifact(storage, canonical.actor, { tool: request.tool, ...request.arguments }, { authorizePicked })
        : await legacyActionArtifact(storage, canonical.actor, { tool: request.tool, ...request.arguments }, { authorizeManaged, authorizePicked });
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: { value, text: JSON.stringify(value) } };
    });
    if (canonical.actor.canWrite && canonical.actionHost) server.registerTool("action_artifact_pick_import", {
      description: "Ask the trusted VS Code host to select and approve one exact artifact source; caller supplies no path.",
      inputSchema: z.strictObject({}), annotations: { readOnlyHint: false },
    }, async () => {
      const value = await canonical.actionHost!.pickAndImportArtifact(canonical.actor);
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: { value } };
    });
    if (canonical.actor.canWrite && canonical.actionHost) server.registerTool("action_artifact_pick_export", {
      description: "Ask the trusted VS Code host to select and approve a new destination for an owned managed Action artifact.",
      inputSchema: z.strictObject({ artifact_id: z.string().regex(/^artifact_[a-f0-9]{32}$/) }),
      annotations: { readOnlyHint: false },
    }, async request => {
      const value = await canonical.actionHost!.pickAndExportArtifact(canonical.actor, request.artifact_id);
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: { value } };
    });
    server.registerTool("legacy_snapshot_read", {
      description: "Original private-Git snapshot status using a pre-existing native host admission, never workspace-backup substitution or a caller path grant.",
      inputSchema: legacySnapshotReadRequest, annotations: { readOnlyHint: true },
    }, async request => {
      const value = await invokeAdmittedLegacyKnowledgeSnapshot(storage, canonical.actor, {
        tool: request.tool, args: request.arguments, operationId: randomUUID(),
      }), text = JSON.stringify(value);
      return { content: [{ type: "text", text }], structuredContent: { value, text } };
    });
    if (canonical.actor.canWrite) server.registerTool("legacy_snapshot_write", {
      description: "Original private-Git create/preview/approved restore, and scheduling only with an attached native host. No public root override.",
      inputSchema: legacySnapshotWriteRequest, annotations: { readOnlyHint: false },
    }, async request => {
      const invocation = { tool: request.tool, args: request.arguments, operationId: randomUUID() };
      const value = request.tool === "knowledge_snapshot_configure"
        ? canonical.snapshotHost
          ? await legacyKnowledgeSnapshot(storage, canonical.actor, invocation, canonical.snapshotHost)
          : (() => { throw new CoreError("NOT_AVAILABLE", "A started native snapshot scheduler is required."); })()
        : await invokeAdmittedLegacyKnowledgeSnapshot(storage, canonical.actor, invocation);
      const text = JSON.stringify(value);
      return { content: [{ type: "text", text }], structuredContent: { value, text } };
    });
    server.registerTool("legacy_action_catalog_read", {
      description: "Original ModuleSet inventory from immutable host-admitted packages; no host filesystem discovery or execution authority.",
      inputSchema: legacyActionCatalogReadRequest, annotations: { readOnlyHint: true },
    }, async args => {
      const value = await legacyActionCatalog(storage, canonical.actor, args), text = JSON.stringify(value);
      return { content: [{ type: "text", text }], structuredContent: { value, text } };
    });
    if (canonical.actor.canWrite) server.registerTool("legacy_action_catalog_write", {
      description: "Original portable ModuleSet import/selection/removal from separately host-approved exact package sources. Selection never grants admission, qualification or execution.",
      inputSchema: legacyActionCatalogWriteRequest, annotations: { readOnlyHint: false },
    }, async args => {
      const value = await legacyActionCatalog(storage, canonical.actor, args), text = JSON.stringify(value);
      return { content: [{ type: "text", text }], structuredContent: { value, text } };
    });
    server.registerTool("legacy_action_capabilities_read", {
      description: "Limited original action_capabilities projection: deterministic compiler metadata only. Runtime/provider capabilities are unavailable; no execution or mutation.",
      inputSchema: legacyActionCapabilitiesRequest, annotations: { readOnlyHint: true },
    }, async request => {
      const value = legacyActionCapabilitiesRead(canonical.actor, request), text = JSON.stringify(value);
      return { content: [{ type: "text", text }], structuredContent: { value, text } };
    });
    server.registerTool("legacy_action_read", {
      description: "Action diagnostics, trusted registrations and native-owned run status. A successful trusted program run may include its validated output for the fixed authorized actor; no inputs, raw process logs, environment or legacy run records.",
      inputSchema: legacyActionReadRequest, annotations: { readOnlyHint: true },
    }, async args => {
      const value = await legacyActionRead(storage, canonical.actor, args, async (operation, runtimeArgs) => {
        const response = await canonical.core.dispatch("capability_read", {
          operation, version: 1, arguments: runtimeArgs,
        }, canonical.actor);
        if (response.error) throw new CoreError(response.error.code, response.error.message, response.error.effect);
        return response.result;
      }, canonical.actionHost?.automaticActionTrustEnabled
        ? (actor, actionId) => canonical!.actionHost!.readRegisteredAction(actor, actionId)
        : undefined, canonical.actionHost?.automaticActionTrustEnabled
        ? (actor, runId) => canonical!.actionHost!.readAutomaticActionResult(actor, runId)
        : undefined), text = JSON.stringify(value);
      return { content: [{ type: "text", text }], structuredContent: { value, text } };
    });
    if (canonical.actor.canWrite) server.registerTool("legacy_action_write", {
      description: "Create an exact Action revision proposal. A trusted native host may automatically admit that revision; GPT review is optional, while adapter, input, and effect-consent policies remain required.",
      inputSchema: legacyActionWriteRequest, annotations: { readOnlyHint: false },
    }, async args => {
      const value = await legacyActionWrite(storage, canonical.actor, args,
        canonical.actionHost?.automaticActionTrustEnabled
          ? (actor, proposalId, contentHash) => canonical!.actionHost!.admitActionProposal(actor, proposalId, contentHash)
          : undefined), text = JSON.stringify(value);
      return { content: [{ type: "text", text }], structuredContent: { value, text } };
    });
    if (canonical.actor.canWrite && canonical.actionHost?.automaticActionTrustEnabled) server.registerTool("action_call", {
      description: "Run an automatically admitted exact Action proposal. Native host trust, input policy, and per-invocation effect consent are rechecked; GPT review is not required.",
      inputSchema: legacyActionCallRequest, annotations: { readOnlyHint: false },
    }, async args => {
      const value = await legacyActionCall(canonical!.actor, args,
        (actor, request) => canonical!.actionHost!.createActionRunFromProposal(actor, {
          proposalId: request.proposal_id, actionId: request.action_id, contentHash: request.content_hash,
          idempotencyKey: request.idempotency_key, inputs: request.inputs,
        }));
      const text = JSON.stringify(value);
      return { content: [{ type: "text", text }], structuredContent: { value, text } };
    });
    if (canonical.actor.canWrite && canonical.actionHost?.automaticActionTrustEnabled) {
      server.registerTool("action_trust_status", {
        description: "Inspect this native host's Action trust state.",
        inputSchema: z.strictObject({}), annotations: { readOnlyHint: true },
      }, async () => {
        const value = canonical.actionHost!.automaticActionTrustStatus(), text = JSON.stringify(value);
        return { content: [{ type: "text", text }], structuredContent: { value, text } };
      });
      server.registerTool("action_trust_revoke", {
        description: "Revoke this host's Action trust and fence running Actions.",
        inputSchema: z.strictObject({}), annotations: { readOnlyHint: false },
      }, async () => {
        const value = await canonical.actionHost!.revokeAutomaticActionTrust(), text = JSON.stringify(value);
        return { content: [{ type: "text", text }], structuredContent: { value, text } };
      });
    }
    const executeWorker = (input: unknown) => {
      indexedWorker ??= new LegacyMcpPythonWorker(fileURLToPath(new URL("../compat/legacy-knowledge-mcp.py", import.meta.url)));
      return indexedWorker.execute(input);
    };
    server.onClose(async () => {
      assetClassificationSession.close();
      await indexedWorker?.close();
    });
    const recoveryRead = legacyKnowledgeRecoveryRequest.options[0], recoveryWrite = legacyKnowledgeRecoveryRequest.options[1];
    server.registerTool("legacy_knowledge_recovery_preview", {
      description: "Exact original missing-only recovery preview against native host-approved immutable evidence and a fixed actor/root.",
      inputSchema: recoveryRead, annotations: { readOnlyHint: true },
    }, async args => {
      const value = await legacyKnowledgeRecovery(storage, canonical.actor, args), result = { value, text: JSON.stringify(value) };
      return { content: [{ type: "text", text: result.text }], structuredContent: result };
    });
    if (canonical.actor.canWrite) server.registerTool("legacy_knowledge_recovery_apply", {
      description: "Original missing-only raw-byte recovery with exact plan approval, separately approved external audit root and durable native intent; no overwrite or caller path authority.",
      inputSchema: recoveryWrite, annotations: { readOnlyHint: false },
    }, async args => {
      const value = await legacyKnowledgeRecovery(storage, canonical.actor, args), result = { value, text: JSON.stringify(value) };
      return { content: [{ type: "text", text: result.text }], structuredContent: result };
    });
    if (canonical.actor.canWrite) server.registerTool("legacy_skill_maintenance", {
      description: "Original advisory Skill feedback/proposals through immutable native receipts; never changes formal Skills or contacts an external collector.",
      inputSchema: legacySkillMaintenanceRequest, annotations: { readOnlyHint: false },
    }, async args => {
      const database = storage.connectNative();
      let genesis;
      try { genesis = readLegacySkillMaintenanceGenesis(database, await storage.workspaceId()); }
      finally { database.close(); }
      const result = await legacySkillMaintenance(storage, canonical.actor, args, { genesis });
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    });
    const indexedRead = async (args: z.infer<typeof legacyIndexedKnowledgeRequest>) => {
      if (args.tool === "retrieval_feedback") throw new CoreError("ACCESS_DENIED", "Relevance judgments require the write entry point.");
      return indexedExecute(args);
    };
    const indexedExecute = async (args: z.infer<typeof legacyIndexedKnowledgeRequest>) => {
      const result = await legacyIndexedKnowledgeRead(storage, args, async () => {
        const pages: unknown[] = [];
        let offset: number | null = 0, revision: string | undefined;
        while (offset !== null) {
          const response = await canonical.core.dispatch("capability_read", { operation: "subscription.list", version: 1,
            arguments: { offset, limit: 100, ...(revision ? { expectedRevision: revision } : {}) } }, canonical.actor);
          if (response.error) throw new CoreError(response.error.code, response.error.message, response.error.effect);
          const page = response.result as { nextOffset: number | null; revision: string };
          pages.push(page); offset = page.nextOffset; revision = page.revision;
        }
        return pages;
      }, executeWorker, canonical.actor);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    };
    server.registerTool("legacy_indexed_knowledge_read", {
      description: "Original lexical/graph unified retrieval through pinned Exact/BM25 and atomically published derived shared-SQL generations. Imported native subscriber caches preserve read-only provenance; configured models and feedback remain unavailable.",
      inputSchema: legacyIndexedKnowledgeRequest, annotations: { readOnlyHint: true },
    }, indexedRead);
    if (canonical.actor.canWrite) server.registerTool("legacy_indexed_knowledge_feedback", {
      description: "Original model relevance judgments against immutable native actor/source/model receipts and shared-SQL original learner state.",
      inputSchema: legacyIndexedKnowledgeRequest, annotations: { readOnlyHint: false },
    }, async args => {
      if (args.tool !== "retrieval_feedback") throw new CoreError("INVALID_ARGUMENT", "Expected original retrieval_feedback call.");
      return indexedExecute(args);
    });
    const noteWorkItems = createNativeLegacyNoteWorkItemsHost(storage, {
      authorize: actor => actor.id === canonical.actor.id,
    });
    server.registerTool("legacy_native_read", {
      description: "Original read contracts through existing native isolated-workspace adapters and fixed actor.",
      inputSchema: z.strictObject({
        tool: z.enum(["note_work_items", "note_work_item_notes"]), arguments: z.record(z.string(), z.unknown()),
      }), annotations: { readOnlyHint: true },
    }, async args => {
      const snapshot = () => storage.withWorkspaceExclusive(() => {
        storage.assertWorkspaceLease();
        const documents = scanMarkdown(storage.workspaceRoot(), { metadata: false }).filter(document => document.record.area === "notes");
        return JSON.stringify({
          documents: documents.map(document => ({ id: document.record.id, path: document.record.path, raw: document.raw })),
          resources: documents.flatMap(document => legacyKnowledgeTree(storage.workspaceRoot(), "notes",
            `${document.record.path.replace(/\.md$/i, ".assets")}/${todoBoardFilename}`)),
        });
      });
      const before = await snapshot();
      const operation = args.tool === "note_work_items" ? "legacy.note.workitems.read" : "legacy.note.workitems.notes";
      const response = await canonical.core.dispatch("capability_read", { operation, version: 1, arguments: args.arguments }, canonical.actor);
      if (response.error && response.error.code !== "NOT_AVAILABLE") throw new CoreError(response.error.code, response.error.message, response.error.effect);
      const value = response.error ? await noteWorkItems.dispatch(operation, args.arguments, canonical.actor) : response.result;
      if (before !== await snapshot()) throw new Error("CONFLICT: Original Note source changed during read.");
      const result = { value };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    });
    if (canonical.actor.canWrite) server.registerTool("legacy_native_write", {
      description: "Original Note Work Item worker signatures through the existing exact-pair admission, native Todo journal and full-snapshot receipt binding. Inline/unadmitted Boards and non-equivalent edits/tokens remain unavailable.",
      inputSchema: z.strictObject({
        tool: z.enum(["note_work_item_command", "note_work_item_upsert", "todo_board_create"]), arguments: z.record(z.string(), z.unknown()),
      }), annotations: { readOnlyHint: false },
    }, async args => {
      if (args.tool === "todo_board_create") {
        const input = legacyTodoBoardCreateArguments.parse(args.arguments);
        const value = await createNativeLegacyTodoBoard(storage, canonical.actor, { ...input, operationId: randomUUID() },
          actor => actor.id === canonical.actor.id && actor.canWrite === canonical.actor.canWrite);
        const result = { value };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      }
      const operation = args.tool === "note_work_item_command" ? "legacy.note.workitems.command" : "legacy.note.workitems.upsert";
      if ("operationId" in args.arguments) throw new CoreError("INVALID_ARGUMENT", "Original signatures do not accept caller operation IDs.");
      const input = { ...args.arguments };
      if (args.tool === "note_work_item_command" && input.worker_token === null) delete input.worker_token;
      const response = await canonical.core.dispatch("capability_call", {
        operation, version: 1, arguments: { ...input, operationId: randomUUID() },
      }, canonical.actor);
      if (response.error) throw new CoreError(response.error.code, response.error.message, response.error.effect);
      const result = { value: response.result };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    });
    if (canonical.actor.canWrite) server.registerTool("legacy_knowledge_write", {
      description: "Original call signatures under approved preserve-identities policy: canonical CAS and atomic path/content/paired-resource updates; original destructive metadata replacement is not reproduced.",
      inputSchema: legacyKnowledgeWriteRequest, annotations: { readOnlyHint: false },
    }, async args => {
      const result = await legacyKnowledgeWrite(canonical.core, storage, canonical.actor, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    });
    if (canonical.actor.canWrite) server.registerTool("legacy_knowledge_trash", {
      description: "Original Trash calls through the byte-preserving native journal with original numeric-hex entry identities; unsupported targets fail closed.",
      inputSchema: legacyKnowledgeTrashRequest, annotations: { readOnlyHint: false },
    }, async args => {
      const result = await legacyKnowledgeTrash(canonical.core, storage, canonical.actor, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    });
    server.registerTool("legacy_knowledge_read", {
      description: "Internal source-captured original Knowledge reads against a lease-owned immutable Markdown snapshot.",
      inputSchema: z.strictObject({
        tool: z.enum(["list_papers", "list_research", "get_research", "get_paper", "paper_graph", "get_note", "list_skills",
          "get_skill", "search_notes", "search_skills", "search_research", "search_papers", "list_subscriptions",
          "search_subscribed_content", "get_subscribed_content", "get_subscribed_content_by_path",
          "skill_capabilities", "skill_context", "agent_session_capabilities", "agent_session_snapshot_list",
          "agent_session_snapshot_read", "recipe_search", "recipe_usage_summary", "recipe_run_get"]),
        arguments: z.record(z.string(), z.unknown()),
      }),
      annotations: { readOnlyHint: true },
    }, async args => {
      if (canonical.noteQuery && args.tool === "search_notes"
        && (args.arguments.detail === undefined || args.arguments.detail === "legacy")
        && (args.arguments.route === undefined || args.arguments.route === "lexical")) {
        const query = z.string().parse(args.arguments.query);
        const limit = args.arguments.limit === undefined ? undefined : z.number().int().parse(args.arguments.limit);
        const fresh = await canonical.noteQuery.search({ query, ...(limit === undefined ? {} : { limit }) });
        if (fresh !== undefined) {
          const value: unknown = JSON.parse(fresh.text);
          if (!Array.isArray(value)) throw new CoreError("INVALID_RESULT", "The private legacy Note search returned an invalid original result.");
          const result = { value, text: fresh.text };
          return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
        }
      }
      return storage.withWorkspaceExclusive(async () => {
      storage.assertWorkspaceLease();
      const identifier = args.arguments.id, slug = args.arguments.slug;
      const pathKey = args.tool === "get_note" && (identifier === undefined || typeof identifier === "string")
        && (slug === undefined || slug === null || typeof slug === "string")
        && !(identifier && slug && identifier !== slug)
        ? String(identifier || slug || "").trim() : "";
      const scopedNote = !!pathKey && !/^(?:pkm:\/\/(?:knowledge|script|subscriptions)\/|knowledge_|script_)/.test(pathKey);
      let firstNote: ReturnType<typeof readKnowledgePathSnapshot> | undefined;
      let explicitBoard = false;
      if (scopedNote) {
        firstNote = readKnowledgePathSnapshot(storage.workspaceRoot(), `${pathKey}.md`, "notes", true);
        if (firstNote.file) {
          let raw: string;
          try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(firstNote.file.bytes); }
          catch { throw new CoreError("INVALID_DOCUMENT", "Markdown must be valid UTF-8."); }
          decodeMarkdownPath(raw, `${pathKey}.md`);
          explicitBoard = z.strictObject({ todoBoard: z.boolean() }).parse(await executeWorker({
            tool: "get_note", arguments: args.arguments, noteReadDependencies: true,
            files: [{ area: "notes", path: `${pathKey}.md`, raw }],
          })).todoBoard;
        }
      }
      function pathSnapshot(first = false) {
        const path = `${pathKey}.md`, note = first ? firstNote!
          : readKnowledgePathSnapshot(storage.workspaceRoot(), path, "notes", true);
        const files: LegacySnapshotFile[] = [];
        const readSet = [note.parents];
        let recipes: ReturnType<typeof readProjectRecipeSnapshot> | undefined;
        if (note.file) {
          let raw: string;
          try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(note.file.bytes); }
          catch { throw new CoreError("INVALID_DOCUMENT", "Markdown must be valid UTF-8."); }
          decodeMarkdownPath(raw, path);
          files.push({ area: "notes", path, raw, pin: note.file.pin, mtimeNs: note.file.mtimeNs, size: note.file.size });
          if (!explicitBoard) {
            const boardPath = `${pathKey}.assets/pkm-todo-board.json`;
            const board = readKnowledgePathSnapshot(storage.workspaceRoot(), boardPath, "notes");
            readSet.push(board.parents);
            if (board.file) files.push({ area: "notes", path: boardPath, raw: "", pin: board.file.pin,
              mtimeNs: board.file.mtimeNs, size: board.file.size });
            else if (!archiveOnlyOriginal || originalMcpPublicRequestActive(storage, args.tool, args.arguments))
              recipes = readProjectRecipeSnapshot(storage.workspaceRoot(), { publication: true });
          }
        }
        return { files, recipes: recipes?.recipes ?? [], recipeSnapshotRevision: recipes?.snapshotRevision,
          subscriptionsPresent: false, readSet };
      }
      function snapshot() {
        if (scopedNote) return pathSnapshot();
        const noteTool = ["get_note", "search_notes"].includes(args.tool);
        const skillTool = ["list_skills", "get_skill", "search_skills", "skill_context", "skill_capabilities"].includes(args.tool);
        const subscriptionTool = args.tool.includes("subscri");
        const agentTool = args.tool.startsWith("agent_session_");
        const recipeTool = args.tool.startsWith("recipe_");
        const area = noteTool ? "notes" : skillTool ? "skills" : "papers";
        const documents = subscriptionTool || agentTool || recipeTool ? []
          : scanMarkdown(storage.workspaceRoot(), { metadata: false }).filter(document => document.record.area === area);
        const byPath = new Map(documents.map(document => [document.record.path, document]));
        const populatedFolders = new Set(documents.flatMap(document => {
          const parts = document.record.path.split("/");
          return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"));
        }));
        const ordered: typeof documents = [];
        function walk(prefix: string) {
          const path = join(storage.workspaceRoot(), area, prefix);
          const stat = lstatSync(path, { throwIfNoEntry: false });
          if (!stat && !documents.length) return;
          if (!stat?.isDirectory() || stat.isSymbolicLink())
            throw new Error("INVALID_DOCUMENT: Knowledge snapshot directories must not be links.");
          const directory = opendirSync(path);
          const folders: string[] = [];
          try {
            for (let entry; (entry = directory.readSync()) !== null;) {
              const relative = prefix + entry.name;
              const document = byPath.get(relative);
              if (document) ordered.push(document);
              if (entry.isDirectory() && populatedFolders.has(relative))
                folders.push(relative + "/");
            }
          } finally { directory.closeSync(); }
          for (const folder of folders) walk(folder);
        }
        if (!subscriptionTool && !agentTool && !recipeTool) walk("");
        if (ordered.length !== documents.length)
          throw new Error("CONFLICT: Knowledge directory membership changed during snapshot capture.");
        const files: LegacySnapshotFile[] = ordered.flatMap(document => {
          const stat = lstatSync(join(storage.workspaceRoot(), area, document.record.path), { bigint: true });
          const rows: LegacySnapshotFile[] = [{ area, path: document.record.path, raw: document.raw, mtimeNs: String(stat.mtimeNs), size: Number(stat.size),
            pin: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` }];
          if (area === "notes") {
            const path = `${document.record.path.replace(/\.md$/i, "")}.assets/pkm-todo-board.json`;
            const full = join(storage.workspaceRoot(), area, path);
            const parent = lstatSync(join(full, ".."), { throwIfNoEntry: false });
            if (parent && (!parent.isDirectory() || parent.isSymbolicLink()))
              throw new Error("INVALID_DOCUMENT: Note assets must be a regular non-symlink directory.");
            const board = parent && lstatSync(full, { bigint: true, throwIfNoEntry: false });
            if (board) {
              if (!board.isFile() || board.isSymbolicLink())
                throw new Error("INVALID_DOCUMENT: Note Board resource must be a regular non-symlink file.");
              rows.push({ area, path, raw: "", mtimeNs: String(board.mtimeNs), size: Number(board.size),
                pin: `${board.dev}:${board.ino}:${board.size}:${board.mtimeNs}:${board.ctimeNs}` });
            }
          }
          if (args.tool === "get_skill")
            rows.push(...legacyKnowledgeTree(storage.workspaceRoot(), area,
              document.record.path.replace(/\.md$/i, ".assets"), true));
          return rows;
        });
        const recipeSnapshot = (!archiveOnlyOriginal || originalMcpPublicRequestActive(storage, args.tool, args.arguments))
          && (args.tool === "get_note" || skillTool || args.tool === "recipe_search")
          ? readProjectRecipeSnapshot(storage.workspaceRoot(), { publication: true }) : undefined;
        const subscriptions = join(storage.workspaceRoot(), "subscriptions");
        const subscriptionDirectory = skillTool || subscriptionTool || args.tool === "recipe_search"
          ? lstatSync(subscriptions, { throwIfNoEntry: false }) : undefined;
        if (subscriptionDirectory && (!subscriptionDirectory.isDirectory() || subscriptionDirectory.isSymbolicLink()))
          throw new Error("INVALID_DOCUMENT: Subscriptions must be a regular non-symlink directory.");
        if (subscriptionDirectory) files.push(...legacyKnowledgeTree(storage.workspaceRoot(), "subscriptions", "cache"));
        if (["search_skills", "skill_context"].includes(args.tool)) {
          const configuration = legacyKnowledgeTree(storage.workspaceRoot(), "knowledge-read-config", "retrieval/router-config.json");
          for (const file of configuration) {
            if (file.directory || file.raw === undefined)
              throw new Error("INVALID_DOCUMENT: Router configuration must be a regular UTF-8 file.");
            parseLegacyRouterConfig(file.raw);
          }
          files.push(...configuration);
        }
        if (agentTool) {
          files.push(...legacyKnowledgeTree(storage.workspaceRoot(), "agent-snapshot-reads", ".pkm/state/agent-snapshots"));
          files.push(...legacyKnowledgeTree(storage.workspaceRoot(), "agent-snapshot-reads", ".pkm/state/agent-sessions"));
        }
        if (args.tool === "recipe_usage_summary" || args.tool === "recipe_run_get")
          files.push(...legacyKnowledgeTree(storage.workspaceRoot(), "recipe-usage-reads", ".pkm/state/recipe-runs"));
        return { files, recipes: recipeSnapshot?.recipes ?? [], recipeSnapshotRevision: recipeSnapshot?.snapshotRevision,
          subscriptionsPresent: (skillTool || subscriptionTool || args.tool === "recipe_search")
          && subscriptionDirectory !== undefined && readdirSync(subscriptions).length > 0 };
      }
      const before = scopedNote ? pathSnapshot(true) : snapshot();
      const input = { ...args, ...before };
      // Match the pinned Original MCP text reads without normalizing raw custody/CAS snapshots.
      const parserInput = ["get_skill", "get_paper", "get_research"].includes(args.tool)
        ? { ...input, files: input.files.map(file => file.raw === undefined ? file
          : { ...file, raw: file.raw.replace(/\r\n?/g, "\n") }) } : input;
      const result = z.strictObject({ value: z.json(), text: z.string() }).parse(
        ["get_note", "search_notes"].includes(args.tool) ? await executeWorker(input)
          : await runLegacyMcpPython(fileURLToPath(new URL("../compat/legacy-knowledge-mcp.py", import.meta.url)), [], parserInput));
      storage.assertWorkspaceLease();
      let after: ReturnType<typeof snapshot>;
      try { after = snapshot(); }
      catch (error) {
        if (!scopedNote) throw error;
        throw new CoreError("CONFLICT", "CONFLICT: Knowledge path or dependency changed during read.");
      }
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new Error("CONFLICT: Knowledge changed during read; retry against the current source.");
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      });
    });
    server.registerTool("legacy_subscription_share_markers", {
      description: "Local broker share markers through the fixed actor and authorized native subscription snapshot.",
      inputSchema: z.strictObject({
        type: z.enum(["skills", "notes", "papers", "prompts", "scripts", "packages", "recipes", "servers"]),
        items: z.array(z.record(z.string(), z.json())).max(4096),
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      }),
      annotations: { readOnlyHint: true },
    }, async args => {
      const result = await canonical.core.dispatch("capability_read", {
        operation: "subscription.broker.share-markers", version: 1, arguments: args,
      }, canonical.actor);
      return { isError: !!result.error, content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    });
    const dispatch = createLegacyCapabilityDispatcher(canonical.core, canonical.actor, storage);
    const entries: [string, string[]][] = [
      ["legacy_capability_read", ["list", "search", "describe", "read"]],
    ];
    if (canonical.actor.canWrite) entries.push(["legacy_capability_call", ["call"]]);
    for (const [name, actions] of entries) {
      server.registerTool(name, {
        description: "Internal legacy Todo/Memory compatibility dispatch with fixed native actor.",
        inputSchema: legacyCapabilityRequest,
        annotations: { readOnlyHint: name === "legacy_capability_read" },
      }, async args => {
        if (!actions.includes(args.action)) throw new Error("ACCESS_DENIED: Use the matching compatibility entry point.");
        const result = await dispatch(args);
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      });
    }
  }
  return server;
}
