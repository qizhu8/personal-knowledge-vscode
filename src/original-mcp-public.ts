import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { RootOwner, assertRootOwner } from "./root-owner.js";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import type { Actor } from "./contracts.js";
import type { NativeMcpBackend } from "./native-public-mcp-backend.js";
import { assertLegacyNoteBackendBinding } from "./legacy-note-mcp.js";
import { nativePublicBackendRoute, pythonMetadataJson } from "./native-public-mcp.js";
import compatibility from "./native-public-mcp-contracts.js";
import { originalPublicMcpContracts } from "./native-public-original-mcp-contracts.js";
import { todoCapabilities } from "./domain/legacy-mcp-registry.js";
import { legacyRecipeLazyOperations } from "./legacy-recipe-lazy-contracts.js";
import {
  assertOriginalMcpNativeHost, withOriginalMcpPublicRequest, originalMcpRequestDigest, type OriginalMcpNativeHost,
} from "./original-mcp-native-host.js";
import { readLegacyStateReceipt } from "./host-composition-legacy-state.js";
import { createLegacyCapabilityDispatcher, legacyCapabilityRequest } from "./legacy-capability-mcp.js";
import { assertOriginalMcpDomainSession } from "./original-mcp-domains.js";
import {
  getNativePrivateResourcePublicationPort, withNativePrivateResourcePublicationContext,
} from "./private-resource-publication-native.js";
import { getNativeOriginalTrashPort, withNativeOriginalTrashContext } from "./original-native-trash-native.js";
import { dispatchOriginalMcpTodoBasic, originalMcpTodoBasicTool, originalMcpTodoPublicArguments } from "./original-mcp-todo-basic.js";
import { dispatchOriginalMcpTodoGenesis } from "./original-mcp-todo-genesis-basic.js";
import { dispatchOriginalKnowledgeRecovery } from "./original-knowledge-recovery-runtime.js";
import { originalMcpPureActionOperationIds, originalMcpPureActionTool,
  invokeOriginalMcpPureAction } from "./original-mcp-action-pure.js";
import { originalMcpActionAuthoringOperationIds, originalMcpActionAuthoringTool,
  originalMcpActionOperationIds } from "./original-mcp-action-tools.js";
import { readNativeCurrentProcessDiagnostics } from "./native-current-process-diagnostics.js";
import { originalSubscriptionTools } from "./original-mcp-subscription-contracts.js";
import { readOriginalMcpSubscriptions } from "./original-mcp-subscription.js";

type Json = Record<string, any>;
interface Contract {
  id: string; version: number; transportName: string; readOnly: boolean;
  inputSchema: Json; outputSchema: Json | null;
}
interface Catalog {
  provenance: { metadataSha256: string; producer: { revision: string } };
  contracts: Contract[];
}
const requestSchema = z.strictObject({ tool: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()) });
const readinessInput = z.strictObject({
  acceptedScope: z.literal("preserve-existing-mcp/v1"),
  catalogSha256: z.string().regex(/^[a-f0-9]{64}$/),
  catalogRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
const publicKnowledge = new Set([
  "get_note", "list_notes", "search_notes", "get_skill", "list_skills", "search_skills",
  "get_paper", "get_research", "list_papers", "list_research", "search_papers", "search_research",
  "paper_graph", "skill_context", "skill_capabilities", "add_note", "update_note", "add_skill",
  "update_skill", "add_paper", "update_paper",
]);
const indexedKnowledge = new Set(["get_knowledge", "get_script", "search_knowledge", "search_scripts",
  "retrieval_status", "retrieval_feedback"]);
const stateReads = new Set(["agent_session_capabilities", "agent_session_snapshot_list", "agent_session_snapshot_read",
  "list_agents", "recipe_usage_summary"]);
const nativeRecipeExecutionTools = new Set(["recipe_run_start", "recipe_run_start_adhoc", "recipe_run_next",
  "recipe_run_report", "recipe_run_get", "recipe_run_progress", "recipe_run_submit_input"]);
const snapshot = (name: string) => name.startsWith("knowledge_snapshot_");
const trash = (name: string) => ["delete_note", "delete_skill", "delete_paper", "knowledge_file_trash"].includes(name);
const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
function catalog(): Catalog { return originalPublicMcpContracts() as Catalog; }
function missing(contract: Contract) {
  const name = contract.transportName;
  const item = (code: string, adapter: string, reason: string) => ({ operationId: contract.id, code, adapter, reason });
  if (originalSubscriptionTools.some(tool => tool === name)) return undefined;
  if (["update_note", "update_skill", "update_paper"].includes(name))
    return item("PRIVATE_REFERENCE_MOVE_COMPATIBILITY_REQUIRED", "legacy-knowledge-write.ts + document-lifecycle.ts",
      "Content/CAS updates are implemented, but original rename/category moves with retained private reference subtrees still require a separately qualified complete source/write-ownership proof.");
  if (originalMcpPureActionOperationIds.includes(contract.id)) return undefined;
  if (originalMcpActionAuthoringOperationIds.includes(contract.id)) return undefined;
  if (originalMcpActionOperationIds.includes(contract.id)) return undefined;
  if (name === "recipe_create_from_skill" || name === "recipe_capabilities" || nativeRecipeExecutionTools.has(name)) return undefined;
  if (name.startsWith("action_")) return item("ACTION_FULL_RUNTIME_REQUIRED", "original-mcp-action-runtime.ts + host-services.ts",
    "Intrinsic native control/checkpoint/validation operations exist, but archived original Action source, runs/queue/history and effect/native-credential authority are not admitted; the remaining full runtime/Cosmos contract is not qualified.");
  if (name.startsWith("api_chat_")) return item("API_CHAT_CONTROL_ADAPTER_REQUIRED", "legacy-api-chat-managed-runtime.ts",
    "Paged original source/Host requests and authenticated full-loop callbacks with same-Core tools exist. Managed-goal/context assemblers and genuine high-level Chat/source/budget/UI bindings remain incomplete; installed native LM/Root qualification is not established by callback or socket fixtures.");
  if (name.startsWith("chat_") || name === "check_chat_version") return item("ROOM_MCP_SESSION_ADAPTER_REQUIRED",
    "legacy-chatroom-runtime.ts + legacy-chatroom-host-authority.ts",
    "Native Room ownership/rebind exists, but the original join/read/standby/post/member session API requires its own approved client/credential binding.");
  if (name.startsWith("recipe_") && name !== "recipe_search" && name !== "recipe_usage_summary")
    return item("FULL_RECIPE_PROTOCOL_REQUIRED", "native-recipe-public-api.ts + legacy-recipe-lazy-runtime.ts",
      "Remaining public Recipe operations require individually qualified adapters; selected authoring/execution routes do not establish full original Recipe parity.");
  if (snapshot(name) || name.startsWith("asset_classify_") || name.startsWith("knowledge_recovery_"))
    return item("LARGE_ROOT_PRIVATE_DOMAIN_ADMISSION_REQUIRED", "legacy-knowledge-snapshots.ts + legacy-asset-classification.ts + legacy-knowledge-recovery.ts",
      "Existing immutable native admissions require schema24–28/private-source domains; the archive-only large-root bootstrap must not silently activate them or bypass schema checks.");
  if (trash(name)) return item("ORIGINAL_TRASH_CUSTODY_ADMISSION_REQUIRED", "legacy-trash-import-native.ts + migration-runtime.ts",
    "Nonempty original Trash requires receipt-aware in-place coexistence/recovery; enabling generic native Trash would reinterpret preserved old buckets.");
  if (todoCapabilities.some(item => item.transportName === name) || name.startsWith("note_work_") || name === "todo_board_create")
    return item("ORIGINAL_BOARD_AND_WORKER_REBIND_REQUIRED", "legacy-todo-root-projection.ts + host-composition-legacy-note-workitems.ts",
      "Old Note/Board pairs need exact typed publication receipts and separately approved/reissued native worker authority, not inherited legacy worker tokens.");
  if (name.includes("subscrib")) return item("NATIVE_SUBSCRIPTION_PROFILE_ADMISSION_REQUIRED",
    "native-subscription-profile.ts + host-composition-legacy-state.ts",
    "Original protected subscription identity, cache and keys require typed profile/state receipts and native SecretStorage authorization.");
  if (name === "skill_feedback" || name === "propose_skill_update") return undefined;
  if (stateReads.has(name))
    return item("ORIGINAL_STATE_DOMAIN_RECEIPT_REQUIRED", "host-composition-legacy-state.ts",
      "A generic preserved .pkm archive is not the imported Agent/Recipe/Skill-maintenance read or mutation receipt.");
  if (name === "portal_control") return undefined;
  if (name === "diagnostics_latest") return undefined;
  if (publicKnowledge.has(name) || indexedKnowledge.has(name) || name === "recipe_search") return undefined;
  return item("NATIVE_ADAPTER_REQUIRED", "original-mcp-public.ts", "No qualified typed native executor is registered for this live operation.");
}

/**
 * Pure implementation gate for the trusted offline coordinator. Never accepts caller
 * booleans/callbacks or infers executable parity from advertised names/schema counts.
 */
export function verifyOriginalMcpImplementationReadiness(input: unknown) {
  const expected = readinessInput.parse(input), source = catalog();
  if (source.provenance.metadataSha256 !== expected.catalogSha256
    || source.provenance.producer.revision !== expected.catalogRevision)
    throw new CoreError("ACCESS_DENIED", "The requested full original MCP target differs from the independently pinned live catalog.");
  const missingImplementations = source.contracts.map(missing).filter((entry): entry is NonNullable<typeof entry> => !!entry);
  const canonicalCompatibilityMissing = [
    { operationId: "todo.workitem.assign", code: "ORIGINAL_LIVE_CHAT_ASSIGNMENT_AUTHORITY_REQUIRED" },
  ];
  return {
    schema: "pkm.original-mcp-implementation-readiness/v1" as const, ...expected,
    requiredOperationIds: source.contracts.map(item => item.id),
    implementedOperationIds: source.contracts.filter(item => !missing(item)).map(item => item.id),
    missingImplementations,
    authorityRequirements: [
      { id: "original-native-profile/v1", operationIds: source.contracts.map(item => item.id),
        requiredAction: "Use a separately authenticated native VS Code profile bridge or qualified same-ID MCP-only package. Read current secrets through VS Code SecretStorage; never copy raw keyring data." },
      { id: "native-model-provider/v1", operationIds: source.contracts.filter(item => item.transportName.startsWith("api_chat_")).map(item => item.id),
        requiredAction: "Approve the exact provider/model/profile/epoch and opaque credential presence; forward model streams and cancellation through the native host, with fresh tool review/effect approval." },
      { id: "native-action-effects/v1", operationIds: source.contracts.filter(item => item.transportName.startsWith("action_")).map(item => item.id),
        requiredAction: "Independently qualify the actual Action source identity and obtain fresh native trust plus exact revision/toolchain/input/effect approvals. Old settings and worker permission records grant nothing." },
      { id: "native-original-source-domains/v1", operationIds: ["todo.*", "memory.*",
        ...source.contracts.filter(item => item.transportName.startsWith("api_chat_")).map(item => item.id)],
        requiredAction: "Obtain separate genuine native approval for the exact independently captured source/custody/profile/actor scope. Model/public admission and archived permissions are not source-domain grants; typed callback fixtures are not a production producer." },
      { id: "native-original-todo-chat-directory/v1", operationIds: ["todo.agent.list"],
        requiredAction: "Admit both the exact Todo domain and original API Chat source under the current native epoch. Archive-only directory entries grant no assignment or worker authority." },
      { id: "native-original-recipe-usage-source/v1", operationIds: ["mcp.tool.recipe_usage_summary"],
        requiredAction: "Independently approve the exact sealed Recipe usage source under the current signed root/profile/actor/epoch. Historical accounting grants no Recipe execution." },
      { id: "native-room-credentials/v1", operationIds: source.contracts.filter(item => item.transportName.startsWith("chat_")).map(item => item.id),
        requiredAction: "Authorize exact Room ownership/join credentials through the actual native credential store and approve participant rebinding; do not treat a join secret/client ID as host ownership." },
      { id: "native-semantic-model/v1", operationIds: source.contracts.filter(item => indexedKnowledge.has(item.transportName)
        || item.transportName.startsWith("search_")).map(item => item.id),
        requiredAction: "Admit and select the exact original compatible model package/frozen corpus/learning scope with immutable native receipts. Do not silently downgrade semantic/graph/auto routes to lexical." },
    ],
    canonicalCompatibilityOperations: ["todo.*", "memory.*"],
    canonicalCompatibilityImplemented: ["memory.record.get", "memory.record.search", "memory.record.audit", "memory.record.propose", "todo.agent.list"],
    canonicalCompatibilityMissing,
    ready: missingImplementations.length === 0 && canonicalCompatibilityMissing.length === 0,
    qualification: "implementation inspection only; not live authority or production qualification",
  };
}
function result(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(object(value) ? { structuredContent: value } : {}) };
}
function originalReply(tool: string, response: CallToolResult): CallToolResult {
  if (response.isError) return response;
  const envelope = response.structuredContent;
  if (!object(envelope)) throw new CoreError("INVALID_RESULT", "The native original MCP adapter returned no typed result.");
  if (tool === "list_notes") return result(envelope);
  const flags = (compatibility as { routing: Record<string, Json> }).routing[tool];
  if (["action_capabilities", "action_run_get", "action_retrieve"].includes(tool)
    || flags?.native || flags?.dictionary || flags?.typed) return result(envelope.value);
  if (typeof envelope.text !== "string") throw new CoreError("INVALID_RESULT", "The native original MCP adapter returned an invalid original text result.");
  if (["add_note", "update_note", "add_skill", "update_skill", "add_paper", "update_paper"].includes(tool))
    return result(pythonMetadataJson(JSON.parse(envelope.text)).replace(/[\u007f-\uffff]/g,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`));
  return result(envelope.text);
}

/** Actual same-owner native dispatch. Unsupported implementations remain explicit blockers, never legacy-engine fallbacks. */
export async function createOriginalMcpPublicDispatcher(owner: RootOwner, actor: Readonly<Actor>,
  host: OriginalMcpNativeHost, backend: NativeMcpBackend) {
  assertRootOwner(owner);
  const { storage, runtime } = await owner.ensureFull(), source = catalog();
  assertOriginalMcpNativeHost(host, storage);
  assertLegacyNoteBackendBinding(backend, storage, runtime.core, actor);
  if (actor.id !== "mcp:external" || actor.boardWorker
    || !host.receipt.domains.includes("mcp-public")
    || host.receipt.sourceCatalogSha256 !== source.provenance.metadataSha256)
    throw new CoreError("ACCESS_DENIED", "The original public dispatcher requires its exact live-catalog/native-host/actor binding.");
  const byName = new Map(source.contracts.map(item => [item.transportName, item]));
  const validators = new AjvJsonSchemaValidator(), schemas = new Map<string, JsonSchemaValidator<unknown>>();
  let action: ReturnType<typeof import("./original-mcp-action-runtime.js").createOriginalMcpActionRuntime> | undefined;
  let apiChat: ReturnType<typeof import("./original-mcp-api-chat.js").createOriginalMcpApiChatRuntime> | undefined;
  let portal: ReturnType<typeof import("./original-mcp-portal.js").createOriginalMcpPortalRuntime> | undefined;
  let todoDispatcher: ReturnType<typeof createLegacyCapabilityDispatcher> | undefined;
  return {
    readiness: () => verifyOriginalMcpImplementationReadiness({ acceptedScope: "preserve-existing-mcp/v1",
      catalogSha256: source.provenance.metadataSha256, catalogRevision: source.provenance.producer.revision }),
    async invokeCanonical(name: string, input: unknown, _signal?: AbortSignal): Promise<CallToolResult> {
      assertOriginalMcpNativeHost(host, storage);
      assertLegacyNoteBackendBinding(backend, storage, runtime.core, actor);
      const request = legacyCapabilityRequest.parse(structuredClone(input));
      if (!["legacy_capability_read", "legacy_capability_call"].includes(name))
        throw new CoreError("ACCESS_DENIED", "Use the exact original canonical compatibility channel.");
      if (["list", "search", "describe"].includes(request.action)) {
        if (name !== "legacy_capability_read")
          throw new CoreError("ACCESS_DENIED", "Discovery uses the read channel and grants no operation authority.");
        return backend.invoke(name, request);
      }
      const operation = request.args.operation;
      if (typeof operation === "string" && ["knowledge.trash.list", "knowledge.trash.lifecycle.preview",
        "knowledge.trash.move", "knowledge.trash.restore"].includes(operation)) {
        const port = getNativeOriginalTrashPort(storage, host);
        if (!port) throw new CoreError("NOT_AVAILABLE", "Original Trash has no current native per-target producer.");
        const readOnly = operation === "knowledge.trash.list" || operation === "knowledge.trash.lifecycle.preview";
        if (name !== (readOnly ? "legacy_capability_read" : "legacy_capability_call")
          || request.action !== (readOnly ? "read" : "call"))
          throw new CoreError("ACCESS_DENIED", "Original Trash requires the exact canonical read/mutation channel.");
        const args = z.strictObject({ operation: z.string(), version: z.literal(1),
          arguments: z.record(z.string(), z.unknown()) }).parse(request.args);
        if (request.workerToken !== undefined) throw new CoreError("ACCESS_DENIED", "Board workers do not grant original Trash authority.");
        return withNativeOriginalTrashContext(port, async () => {
          const response = await runtime.core.dispatch(readOnly ? "capability_read" : "capability_call", args, actor);
          if (response.error) throw new CoreError(response.error.code, response.error.message, response.error.effect);
          return result(response.result);
        }, _signal);
      }
      if (typeof operation === "string" && (operation.startsWith("todo.") || operation.startsWith("memory."))) {
        assertOriginalMcpDomainSession(storage, host, operation.startsWith("todo.") ? "todo" : "memory");
        let response: CallToolResult;
        if (operation === "todo.agent.list" || operation === "todo.workitem.assign") {
          const expectedChannel = operation === "todo.agent.list" ? "legacy_capability_read" : "legacy_capability_call";
          if (name !== expectedChannel)
            throw new CoreError("ACCESS_DENIED", `Todo ${operation === "todo.agent.list" ? "Agent discovery" : "assignment"} uses the matching ${operation === "todo.agent.list" ? "read" : "mutation"} entry point.`);
          todoDispatcher ??= createLegacyCapabilityDispatcher(runtime.core, actor, storage, async (principal, arguments_) => {
            const { readOriginalMcpTodoAgentList } = await import("./original-mcp-todo-chat.js");
            return readOriginalMcpTodoAgentList(owner, host, principal, arguments_);
          }, async (principal, arguments_) => {
            const { dispatchOriginalMcpTodoChatAssignment } = await import("./original-mcp-todo-assignment.js");
            return dispatchOriginalMcpTodoChatAssignment(owner, host, principal, arguments_);
          });
          response = result(await todoDispatcher(request));
        } else response = await backend.invoke(name, request);
        try { assertOriginalMcpDomainSession(storage, host, operation.startsWith("todo.") ? "todo" : "memory"); }
        catch (error) {
          if (request.action === "call")
            throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "Native domain authority changed after dispatch; reconcile its durable receipt before any retry.", "unknown");
          throw error;
        }
        return response;
      }
      throw new CoreError("NOT_AVAILABLE", "This is not a supported original canonical compatibility operation.");
    },
    async invoke(input: unknown, signal?: AbortSignal, callId?: string): Promise<CallToolResult> {
      assertOriginalMcpNativeHost(host, storage);
      assertLegacyNoteBackendBinding(backend, storage, runtime.core, actor);
      const parsedRequest = requestSchema.parse(structuredClone(input)), operation = byName.get(parsedRequest.tool);
      if (!operation) throw new CoreError("NOT_AVAILABLE", "This tool is absent from the pinned live original MCP catalog.");
      if (!operation.readOnly && !actor.canWrite) throw new CoreError("ACCESS_DENIED", "This native original MCP principal is read-only.");
      let validate = schemas.get(operation.id);
      if (!validate) { validate = validators.getValidator(operation.inputSchema); schemas.set(operation.id, validate); }
      if (!validate(parsedRequest.arguments).valid) throw new CoreError("INVALID_ARGUMENT", "Original MCP arguments violate the independently pinned live contract.");
      const request = { ...parsedRequest, arguments: originalMcpTodoPublicArguments(parsedRequest.tool, parsedRequest.arguments) };
      if (request.tool.startsWith("chat_")) {
        const room = await import("./original-mcp-room-live-session.js");
        const live = room.getOriginalMcpRoomLiveSession(storage, host);
        if (live && room.originalMcpRoomLivePublicTools.some(tool => tool === request.tool))
          return result(await live.invokePublic(request.tool, request.arguments, signal, callId));
      }
      const publicationPort = getNativePrivateResourcePublicationPort(storage, host);
      const trashPort = getNativeOriginalTrashPort(storage, host);
      const dispatch = () => withOriginalMcpPublicRequest(storage, host, {
        operation: operation.id, version: 1, tool: request.tool, readOnly: operation.readOnly,
        arguments: request.arguments, argumentsDigest: originalMcpRequestDigest(request.arguments),
      }, async () => {
        if (request.tool === "portal_control") {
          const adapter = await import("./original-mcp-portal.js");
          portal ??= adapter.createOriginalMcpPortalRuntime(owner, actor, host, {
            apiChat: () => apiChat ??= import("./original-mcp-api-chat.js").then(module =>
              module.createOriginalMcpApiChatRuntime(owner, actor, host)),
          }).catch(error => { portal = undefined; throw error; });
          return (await portal).invoke(request.tool, request.arguments, signal);
        }
        if (request.tool === "api_chat_request_get" && portal) {
          if (request.arguments.host_id !== host.receipt.workspaceId)
            throw new CoreError("ACCESS_DENIED", "Select this exact current native Host.");
          const receipt = (await portal).readReceipt(String(request.arguments.request_id));
          if (receipt) return result(receipt);
        }
        if (request.tool === "diagnostics_latest")
          return result(readNativeCurrentProcessDiagnostics(storage, host, request.arguments, signal));
        if (request.tool === "knowledge_recovery_preview" || request.tool === "knowledge_recovery_apply")
          return result(await dispatchOriginalKnowledgeRecovery(storage, host, actor, request.tool, request.arguments, signal));
        if (request.tool === "todo_board_create")
          return result(await dispatchOriginalMcpTodoGenesis(owner, host, actor, request.arguments, signal));
        if (originalMcpTodoBasicTool(request.tool))
          return result(await dispatchOriginalMcpTodoBasic(owner, host, actor, request.tool, request.arguments, signal));
        if (request.tool.startsWith("api_chat_")) {
          const sources = await import("./original-mcp-api-chat-source.js");
          if (sources.originalMcpApiChatSourceActive(storage, host)) {
            const adapter = await import("./original-mcp-api-chat.js");
            if (adapter.originalMcpApiChatOperationIds.includes(operation.id)
              || adapter.originalMcpApiChatConditionalOperationIds.includes(operation.id)) {
              apiChat ??= adapter.createOriginalMcpApiChatRuntime(owner, actor, host).catch(error => {
                apiChat = undefined; throw error;
              });
              return (await apiChat).invoke(request.tool, request.arguments, signal);
            }
          }
        }
        if (request.tool.startsWith("action_")) {
          if (originalMcpActionAuthoringTool(request.tool)) {
            const { dispatchOriginalMcpActionAuthoring } = await import("./original-mcp-action-authoring.js");
            return result(await dispatchOriginalMcpActionAuthoring(owner, host, actor, request.tool, request.arguments, signal));
          }
          if (originalMcpPureActionTool(request.tool))
            return result(invokeOriginalMcpPureAction(request.tool, request.arguments));
          const adapter = await import("./original-mcp-action-runtime.js");
          if (adapter.originalMcpActionOperationIds.some(id => id === operation.id)) {
            action ??= adapter.createOriginalMcpActionRuntime(owner, actor, host).catch(error => {
              action = undefined; throw error;
            });
            return (await action).invoke(request.tool, request.arguments, signal);
          }
        }
        if (request.tool === "chat_status") {
          const { originalMcpRoomPublicPort } = await import("./original-mcp-room-public.js");
          return result(await originalMcpRoomPublicPort(storage, host).dispatch(operation.id, request.arguments, signal));
        }
        if (request.tool === "recipe_search") {
          const author = await import("./original-mcp-recipe-authoring.js");
          const native = await author.readOriginalMcpNativeRecipeLibrarySearch(owner, host, actor, request.arguments, signal);
          if (native !== undefined) return result(native);
          const library = await import("./original-mcp-recipe-library.js");
          if (await library.originalMcpRecipeLibrarySourceExists(owner, host))
            return result(await library.readOriginalMcpRecipeLibrarySearch(owner, host, actor, request.arguments, signal));
        }
        if (request.tool === "recipe_capabilities") {
          const recipe = await import("./original-mcp-recipe-execution.js");
          return result(await recipe.originalMcpRecipeCapabilities(owner, host, request.arguments));
        }
        if (request.tool === "recipe_usage_summary") {
          const { readOriginalMcpRecipeUsage } = await import("./original-mcp-recipe-usage.js");
          return result(await readOriginalMcpRecipeUsage(owner, host, actor, request.arguments, signal));
        }
        if (request.tool === "recipe_create_from_skill") {
          const author = await import("./original-mcp-recipe-authoring.js");
          return result(await author.dispatchOriginalMcpRecipeFromSkill(owner, host, actor, request.arguments, signal));
        }
        if (nativeRecipeExecutionTools.has(request.tool)) {
          const recipe = await import("./original-mcp-recipe-execution.js");
          const nativeGet = request.tool === "recipe_run_get" && await recipe.originalMcpRecipeExecutionRunExists(
            owner, host, String(request.arguments.run_id));
          if (request.tool !== "recipe_run_get" || nativeGet) {
            return result(await recipe.dispatchOriginalMcpRecipeExecution(owner, host, request.tool, request.arguments, actor, signal));
          }
        }
        if (request.tool === "recipe_run_get") {
          const { readOriginalMcpRecipeTerminal } = await import("./original-mcp-recipe-terminal.js");
          return result(await readOriginalMcpRecipeTerminal(owner, host, actor, request.arguments, signal));
        }
        const recipe = `mcp.tool.${request.tool}`;
        if (legacyRecipeLazyOperations.has(recipe)) {
          const described = await runtime.core.dispatch("capabilities_describe", { operation: recipe }, actor);
          if (described.error || !object(described.result))
            throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "The exact native Recipe host, source library and per-request execution approval must be composed.");
          const method = described.result.readOnly ? "capability_read" : "capability_call";
          const response = await runtime.core.dispatch(method, { operation: recipe, version: 1, arguments: request.arguments }, actor);
          if (response.error) throw new CoreError(response.error.code, response.error.message, response.error.effect);
          return result(response.result);
        }
        if (request.tool === "skill_feedback" || request.tool === "propose_skill_update") {
          const { dispatchOriginalMcpSkillMaintenance } = await import("./original-mcp-skill-maintenance.js");
          const advisory = await dispatchOriginalMcpSkillMaintenance(owner, host, actor, request.tool, request.arguments, signal);
          return result(advisory.text);
        }
        if (originalSubscriptionTools.some(tool => tool === request.tool))
          return result(await readOriginalMcpSubscriptions(storage, host, request.tool, request.arguments, signal));
        let limitation = missing(operation);
        if (trashPort && ["delete_note", "delete_skill", "delete_paper", "knowledge_file_trash"].includes(request.tool))
          limitation = undefined;
        if (stateReads.has(request.tool)) {
          const database = storage.connectNative();
          try {
            const receipt = readLegacyStateReceipt(database, await storage.workspaceId());
            if (!receipt?.plan.statePlan) throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "Original state reads require their exact typed native import/source receipt.");
            limitation = undefined;
          } finally { database.close(); }
        }
        if (limitation && limitation.code !== "PRIVATE_REFERENCE_MOVE_COMPATIBILITY_REQUIRED")
          throw new CoreError("ORIGINAL_MCP_ADAPTER_REQUIRED", `${limitation.code}: ${limitation.reason}`);
        const route = request.tool === "skill_context"
          ? "legacy_indexed_knowledge_read"
          : nativePublicBackendRoute(request.tool, request.arguments, operation.readOnly);
        return originalReply(request.tool, await backend.invoke(route,
          request.tool === "list_notes" ? request.arguments : { tool: request.tool, arguments: request.arguments }));
      }, signal);
      const dispatched = () => publicationPort
        ? withNativePrivateResourcePublicationContext(publicationPort, dispatch, signal) : dispatch();
      return trashPort && ["delete_note", "delete_skill", "delete_paper", "knowledge_file_trash"].includes(request.tool)
        ? withNativeOriginalTrashContext(trashPort, dispatched, signal, request) : dispatched();
    },
  };
}
