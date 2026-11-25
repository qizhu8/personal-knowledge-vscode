import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RootOwner, assertRootOwner } from "./root-owner.js";
import { CoreError, type Actor } from "./contracts.js";
import { originalPublicMcpContracts } from "./native-public-original-mcp-contracts.js";
import { pythonMetadataJson } from "./native-public-mcp.js";
import { assertOriginalMcpNativeHost, originalMcpPublicRequestMatches, originalMcpRequestDigest,
  withOriginalMcpPublicRequest, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { originalMcpApiChatSource, readOriginalMcpApiChatMessage, readOriginalMcpApiChatMetadata,
  readOriginalMcpApiChatMessagePage, originalMcpApiChatSourceDeadline } from "./original-mcp-api-chat-source.js";
import { openOriginalMcpCustodyReader } from "./original-mcp-root.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { originalApiChatContextSummary, originalApiChatCreditUsage } from "./domain/original-api-chat-projection.js";
import { OriginalApiChatContextAssembler, originalApiChatPreservedImages } from "./domain/original-api-chat-context.js";
import { createOriginalApiChatInputImageStore } from "./original-mcp-api-chat-input-images.js";
import { originalMcpApiChatRequestsNewTask } from "./original-mcp-api-chat-task.js";
import { readOriginalMcpMemoryContext, type OriginalMcpMemoryContextSnapshot } from "./original-mcp-memory-context.js";
import { readActiveMemoryScopeSession } from "./memory-scope-continuity.js";
import { assertOriginalMcpDomainSession } from "./original-mcp-domains.js";
import { memoryText } from "./memory-contracts.js";
import { assertModelProviderBinding } from "./model-provider.js";
import { chatTurnTerminal, type ChatTurnRecord } from "./chat-turn-contracts.js";
import { CHAT_SESSION_LIMITS, type ChatSessionMessage } from "./chat-session-contracts.js";
import { ChatTurnError } from "./chat-turn-store.js";
import { createOriginalMcpNativeExecution, readOriginalMcpNativeExecution } from "./original-mcp-api-chat-execution.js";
import { originalNativeChatDigest, originalNativeChatSelection, type OriginalNativeChatExecutionPlan, type OriginalNativeChatMessage,
  originalNativeChatMemoryRequest, originalNativeChatMemoryChoice,
  type OriginalNativeChatSessionPort, type OriginalNativeChatExecutionPort } from "./original-mcp-api-chat-contracts.js";
import type { createOriginalMcpApiChatTaskAdapter } from "./original-mcp-api-chat-task-adapter.js";
import { originalApiChatRequestDdl } from "./original-mcp-api-chat-schema.js";

type Json = Record<string, any>;
const liveRuntimes = new WeakSet<object>();
const names = ["capabilities", "models", "list", "get", "request_get", "create", "send", "cancel"] as const;
export const originalMcpApiChatOperationIds = Object.freeze(names.filter(name => !["send", "cancel"].includes(name))
  .map(name => `mcp.tool.api_chat_${name}`));
export const originalMcpApiChatConditionalOperationIds = Object.freeze(["mcp.tool.api_chat_send", "mcp.tool.api_chat_cancel"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = z.string().uuid(), command = z.string().max(128).refine(value => !value || !!value.trim());
const host = { host_id: uuid, command_id: command.default("") };
const locator = z.string().min(1).max(512);
const schemas: Record<string, z.ZodType<Json>> = {
  api_chat_capabilities: z.strictObject({}), api_chat_models: z.strictObject(host),
  api_chat_list: z.strictObject({ ...host, group_path: z.string().max(256).default(""),
    offset: z.number().int().safe().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(100) }),
  api_chat_get: z.strictObject({ ...host, chat_id: locator }),
  api_chat_request_get: z.strictObject({ host_id: uuid, request_id: z.string().regex(/^[a-f0-9]{64}$/) }),
  api_chat_create: z.strictObject({ host_id: uuid, title: z.string()
    .refine(value => !!value.trim() && value.trim().length <= 120 && !/[\u0000-\u001f]/u.test(value)),
    command_id: command.refine(value => !!value), model_id: z.string().max(512).default("") }),
  api_chat_send: z.strictObject({ host_id: uuid, chat_id: locator, prompt: z.string().min(1).max(16_000).refine(value => !!value.trim()),
    command_id: command.refine(value => !!value), hard_tool_round_limit: z.number().int().min(1).max(1000).nullable().default(null) }),
  api_chat_cancel: z.strictObject({ host_id: uuid, chat_id: locator, command_id: command.refine(value => !!value) }),
};
const result = (value: Json): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
function failure(code: string): never { throw new CoreError("NATIVE_AUTHORITY_REQUIRED", code); }
function chatId(value: string) {
  if (uuid.safeParse(value).success) return { id: value, namespace: undefined };
  const parsed = /^pkm:\/\/chats\/([a-f0-9]{16})\/([a-f0-9-]{36})$/.exec(value);
  if (!parsed || !uuid.safeParse(parsed[2]).success) throw new CoreError("INVALID_ARGUMENT", "Use an exact Chat URL or UUID from api_chat_list.");
  return { namespace: parsed[1], id: parsed[2]! };
}
const chatUrl = (namespace: string, id: string) => `pkm://chats/${namespace}/${id}`;

/** Original asynchronous Host protocol. Source custody and native producers are independent prerequisites. */
export async function createOriginalMcpApiChatRuntime(owner: RootOwner, actor: Readonly<Actor>, native: OriginalMcpNativeHost) {
  actor = Object.freeze({ ...actor });
  assertRootOwner(owner);
  const { storage, runtime } = await owner.ensureFull(), root = storage.workspaceRoot();
  assertOriginalMcpNativeHost(native, storage);
  originalMcpApiChatSource(storage, native);
  if (actor.id !== "mcp:external" || actor.boardWorker) failure("ORIGINAL_API_CHAT_CURRENT_HOST_REQUIRED");
  if (liveRuntimes.has(storage)) throw new CoreError("BUSY", "This canonical owner already has its original API Chat Host.");
  const hostId = await storage.workspaceId(), namespace = hash(root).slice(0, 16);
  const contracts = new Map(z.object({ contracts: z.array(z.object({
    id: z.string(), transportName: z.string(), readOnly: z.boolean(),
  })) }).parse(originalPublicMcpContracts()).contracts
    .filter(item => item.transportName.startsWith("api_chat_")).map(item => [item.transportName, item]));
  const db = storage.connectNative(), pending = new Set<Promise<void>>(), lifetime = new AbortController();
  let closed = false, backgroundFailure: unknown;
  let inputImages: ReturnType<typeof createOriginalApiChatInputImageStore>;
  let nativeExecution: ReturnType<typeof createOriginalMcpNativeExecution> | undefined;
  let managedTasks: Promise<Awaited<ReturnType<typeof createOriginalMcpApiChatTaskAdapter>>> | undefined;
  const taskPreparations = new Map<string, { requestId: string; abort: AbortController }>();
  const taskRuntime = () => managedTasks ??= import("./original-mcp-api-chat-task-adapter.js")
    .then(module => module.createOriginalMcpApiChatTaskAdapter(owner, native, actor));
  const executionPort: OriginalNativeChatExecutionPort = Object.freeze({
    async run(...[plan, callbacks, signal]: Parameters<OriginalNativeChatExecutionPort["run"]>) {
      if ("managedTask" in plan) {
        if (!managedTasks) failure("NATIVE_TASK_ACTUAL_EXECUTION_CONTEXT_REQUIRED");
        return (await managedTasks).execution.run(plan, callbacks, signal);
      }
      const id = chatId(plan.chatUrl).id;
      if (db.prepare("SELECT 1 FROM managed_chat_tasks WHERE actor_id=? AND chat_id=?").get(actor.id, id))
        failure("NATIVE_TASK_UNMANAGED_EXECUTION_REFUSED");
      if (!native.nativeChat) failure("AUTHENTICATED_NATIVE_CHAT_EXECUTION_LANE_REQUIRED");
      return native.nativeChat.execution.run(plan, callbacks, signal);
    },
  });
  const executor = () => {
    if (!native.nativeChat) failure("AUTHENTICATED_NATIVE_CHAT_EXECUTION_LANE_REQUIRED");
    return nativeExecution ??= createOriginalMcpNativeExecution(owner, actor, native, executionPort, native.nativeChat.sdk);
  };
  const current = () => {
    assertOriginalMcpNativeHost(native, storage);
    if (backgroundFailure) throw new CoreError("RECOVERY_REQUIRED", "Native Chat request persistence failed; preserve its pending receipts for reconciliation.", "unknown");
    if (closed || lifetime.signal.aborted || actor.id !== "mcp:external" || actor.boardWorker)
      failure("ORIGINAL_API_CHAT_CURRENT_HOST_REQUIRED");
    originalMcpApiChatSource(storage, native);
  };
  const chatAuthority = (): OriginalNativeChatSessionPort | undefined => {
    current();
    const resource = native.nativeChat;
    // assertOriginalMcpNativeHost already verifies this frozen authenticated resource.
    if (resource?.apiChat) return resource.apiChat;
    if (!native.apiChat) return;
    return {
      resolve: (input, signal) => native.apiChat!.resolve({
        requestedModelId: input.chatUrl ? "" : input.requestedModelId, chatUrl: input.chatUrl,
      }, signal),
      async authorize(input, signal) { await native.apiChat!.authorize(input, signal); return true; },
      present: (input, signal) => native.apiChat!.present(input.chatUrl, signal),
    };
  };
  const authorizeChat = async (port: OriginalNativeChatSessionPort,
    input: Parameters<OriginalNativeChatSessionPort["authorize"]>[0]) => {
    if (await port.authorize(input, lifetime.signal) !== true) failure("NATIVE_CHAT_REQUEST_DENIED");
    current();
  };
  const resolveChat = async (port: OriginalNativeChatSessionPort,
    input: Parameters<OriginalNativeChatSessionPort["resolve"]>[0]) => {
    const value = originalNativeChatSelection.parse(await port.resolve(input, lifetime.signal));
    current();
    if (value.epoch !== native.receipt.epoch) failure("NATIVE_CHAT_MODEL_EPOCH");
    return value;
  };
  const transaction = <T>(work: () => T) => {
    current(); db.exec("BEGIN IMMEDIATE");
    try { const value = work(); current(); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  try { current(); transaction(() => {
    db.exec(originalApiChatRequestDdl);
    inputImages = createOriginalApiChatInputImageStore(db);
    db.prepare(`UPDATE original_api_chat_request_state SET status='outcome_unknown',
      error='Native Host stopped before this request settled. Never replay it.' WHERE status IN ('queued','running')`).run();
    db.prepare("UPDATE original_api_chat_responses SET active=0,status='unknown' WHERE active=1").run();
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_native_chat_executions'").get())
      db.prepare(`UPDATE original_native_chat_executions SET status='unknown',failure='HOST_RESTARTED'
        WHERE status IN ('prepared','running')`).run();
  }); } catch (error) { db.close(); throw error; }
  liveRuntimes.add(storage);
  const nativeCall = async (operation: string, args: Json, write = false): Promise<Json> => {
    current();
    const response = await runtime.core.dispatch(write ? "capability_call" : "capability_read",
      { operation, version: 1, arguments: args }, actor);
    if (response.error) throw new CoreError(response.error.code, response.error.message, response.error.effect);
    current(); return response.result as Json;
  };
  const assertTranscriptCurrent = async (id: string, revision: number) => {
    const session = await nativeCall("chat.session.get", { id });
    if (session.revision !== revision || session.archivedAt)
      failure("NATIVE_CHAT_CONTEXT_SESSION_CHANGED: refresh the exact Chat; no request was replayed.");
    return session;
  };
  const readNativeTranscript = async (id: string, append: (message: ChatSessionMessage) => void) => {
    const session = await nativeCall("chat.session.get", { id });
    if (session.archivedAt || !Number.isSafeInteger(session.lastSequence)
      || session.lastSequence < 0 || session.lastSequence > CHAT_SESSION_LIMITS.messagesPerSession)
      failure("ORIGINAL_CHAT_CONTEXT_PROTOCOL_REQUIRED: invalid native transcript boundary.");
    let after = 0, cursor: string | undefined;
    const cursors = new Set<string>();
    // Cursors locate immutable messages, not snapshots. Pin revision and extent across every page.
    while (true) {
      const page = await nativeCall("chat.session.messages", { id, limit: 100,
        ...(cursor === undefined ? { afterSequence: 0 } : { cursor }) });
      if (page.id !== id || page.revision !== session.revision || page.lastSequence !== session.lastSequence)
        failure("NATIVE_CHAT_CONTEXT_SESSION_CHANGED: native transcript changed between pages.");
      if (!Array.isArray(page.items) || page.items.length > 100
        || typeof page.nextCursor !== "string" || !page.nextCursor || cursors.has(page.nextCursor))
        failure("ORIGINAL_CHAT_CONTEXT_PROTOCOL_REQUIRED: inconsistent native transcript cursor.");
      for (const [index, message] of page.items.entries())
        if (message.sequence !== after + index + 1 || message.sequence > session.lastSequence)
          failure("ORIGINAL_CHAT_CONTEXT_PROTOCOL_REQUIRED: native transcript sequence did not progress.");
      const next = page.items.at(-1)?.sequence ?? after;
      if (page.hasMore !== (next < session.lastSequence) || page.hasMore && next <= after)
        failure("ORIGINAL_CHAT_CONTEXT_PROTOCOL_REQUIRED: incomplete native transcript cursor progress.");
      for (const message of page.items) append(message);
      if (!page.hasMore) break;
      after = next; cursor = page.nextCursor; cursors.add(cursor);
    }
    await assertTranscriptCurrent(id, session.revision);
    return session;
  };
  const locate = (value: string): Json => {
    const parsed = chatId(value);
    const source = db.prepare("SELECT *,id AS chat_id FROM original_api_chat_source_chats WHERE id=? AND trashed_at IS NULL").get(parsed.id);
    const fresh = db.prepare("SELECT * FROM original_api_chat_current_chats WHERE id=?").get(parsed.id);
    const row = fresh || source ? { ...source, ...fresh } : undefined;
    if (!row || parsed.namespace && row.namespace !== parsed.namespace)
      throw new CoreError("NOT_FOUND", "Choose an existing non-Trash Chat in this exact original Root.");
    return { ...row, source: !!source, native: !!fresh };
  };
  const snapshot = async (value: string): Promise<Json> => {
    current();
    const chat = locate(value);
    const task = db.prepare(`SELECT t.*,a.request_id AS task_request_id,a.status AS attempt_status FROM managed_chat_tasks t
      JOIN managed_chat_task_attempts a ON a.attempt_id=t.current_attempt_id WHERE t.actor_id=? AND t.chat_id=? AND t.status!='cancelled'`)
      .get(actor.id, chat.id);
    const metadata = chat.source ? await readOriginalMcpApiChatMetadata(storage, native, chat.id) : undefined;
    let reply: Json | undefined;
    if (chat.source && chat.last_assistant !== null)
      reply = await readOriginalMcpApiChatMessage(storage, native, chat.id, Number(chat.last_assistant));
    if (chat.native) {
      const state = await nativeCall("chat.session.get", { id: chat.id });
      if (!chat.source) chat.title = state.title;
      const page = await nativeCall("chat.session.messages", { id: chat.id, limit: 100,
        afterSequence: Math.max(0, state.lastSequence - 100) });
      reply = [...page.items].reverse().find((message: Json) => message.role === "assistant") ?? reply;
    }
    const response = db.prepare("SELECT * FROM original_api_chat_responses WHERE chat_id=?").get(chat.id);
    const preparingTask = task && response?.engine === "native-original"
      && !db.prepare("SELECT 1 FROM original_native_chat_executions WHERE request_id=?").get(response.request_id);
    if (preparingTask) {
      reply = undefined; chat.source_status = ["prepared", "bound"].includes(String(task.attempt_status)) ? "running" : "stopped";
    } else if (response?.engine === "native-original") {
      const state = readOriginalMcpNativeExecution(storage, native, String(response.request_id));
      reply = { id: `native-response:${state.requestId}`, role: "assistant", content: state.output,
        status: state.status === "complete" ? "complete" : state.status === "cancelled" ? "cancelled"
          : state.status === "unknown" ? "interrupted" : state.status === "failed" ? "failed" : "streaming",
        model: JSON.parse(String(response.selection)).modelId, error: state.failure ?? undefined, toolCalls: state.tools,
        usage: state.usage, usageSource: state.usageSource, toolRoundLimit: state.toolRoundLimit,
        nativeCreditUsage: state.creditUsage, nativeContext: state.context };
      chat.source_status = state.status === "complete" ? "completed" : ["unknown", "failed", "cancelled"].includes(state.status) ? "stopped" : "running";
    } else if (response && runtime.services.chatTurns) {
      let turn: ChatTurnRecord | undefined;
      try { turn = runtime.services.chatTurns.get(actor.id, String(response.turn_id)); }
      catch (error) {
        if (!(error instanceof ChatTurnError && error.code === "NOT_FOUND")) throw error;
        chat.source_status = "failed";
      }
      if (turn) {
      reply = { id: `native-response:${turn.id}`, role: "assistant", content: turn.output,
        status: turn.status === "completed" ? "complete" : turn.status === "unknown" ? "interrupted"
          : turn.status === "cancelled" ? "cancelled" : turn.status === "failed" ? "failed" : "streaming",
        error: turn.failure ?? undefined, model: JSON.parse(String(response.selection)).modelId,
        toolCalls: turn.messages.flatMap(message => message.tool_calls ?? []).map(call => ({
          name: call.function.name, status: turn.messages.some(message => message.role === "tool" && message.tool_call_id === call.id)
            ? "complete" : chatTurnTerminal(turn.status) ? "failed" : "running", arguments: call.function.arguments,
        })) };
      chat.uncertain = turn.uncertain ? 1 : 0;
      chat.source_status = chatTurnTerminal(turn.status) ? turn.status === "completed" ? "completed" : "stopped" : "running";
      }
    }
    let taskProjection: Json | undefined;
    if (task) {
      taskProjection = { taskId: task.task_id, status: task.status, goal: JSON.parse(String(task.goal)),
        attemptId: task.current_attempt_id, attemptStatus: task.attempt_status, taskCompletion: "not-claimed", authority: "historical-only" };
      if (managedTasks) try {
        const actual = await (await managedTasks).getForChat(chat.id);
        if (actual) taskProjection = actual;
      } catch { current(); }
    }
    return { chatId: chat.id, chatUrl: chatUrl(chat.namespace, chat.id), title: chat.title,
      status: chat.uncertain ? "stopped" : chat.source_status ?? (reply?.status === "failed" ? "failed" : "idle"),
      sessionId: metadata?.sessionId ?? task?.task_id ?? null,
      ...(metadata?.sessionId || task ? { sessionAuthority: taskProjection?.authority === "current-native" ? "native_core" : "archive_only" } : {}),
      ...(taskProjection ? { managedTask: taskProjection } : {}),
      permissionMode: chat.native ? JSON.parse(chat.model_selection).permissionMode : "protective",
      model: chat.native ? JSON.parse(chat.model_selection).modelId : null,
      reply: reply ? { id: reply.id, model: reply.model ?? null, status: ["streaming", "running"].includes(reply.status) ? "interrupted" : reply.status,
        content: String(reply.content).slice(0, 16_000), truncated: String(reply.content).length > 16_000,
        error: typeof reply.error === "string" ? reply.error.slice(0, 1000) : undefined, usage: reply.usage ?? null,
        credits: (reply.nativeCreditUsage ?? originalApiChatCreditUsage(reply)).credits ?? null,
        creditsStatus: (reply.nativeCreditUsage ?? originalApiChatCreditUsage(reply)).status,
        creditUsage: reply.nativeCreditUsage ?? originalApiChatCreditUsage(reply),
        context: reply.nativeContext ?? originalApiChatContextSummary(reply),
        toolRoundLimit: reply.toolRoundLimit ?? null,
        tools: (reply.toolCalls ?? []).map((tool: Json) => ({ name: tool.name, status: tool.status,
          ...(tool.name === "invoke_vscode_tool" ? { nativeTool: (() => { try { return String(JSON.parse(tool.arguments).name || ""); } catch { return ""; } })() } : {}) })) } : null };
  };
  const list = async (args: Json): Promise<Json> => {
    const group = args.groupId?.replace(/^pkm:\/\/chat-groups\//, "") ?? "";
    if (group && !/^(?:ungroup|chat_group_[a-f0-9]{32})$/.test(group))
      throw new CoreError("INVALID_ARGUMENT", "Use a copied Chat group path.");
    const library = JSON.parse(String(db.prepare("SELECT payload FROM original_api_chat_source_library WHERE singleton=1").get()!.payload));
    if (group && group !== "ungroup" && !library.groups.some((item: Json) => item.id === group))
      throw new CoreError("NOT_FOUND", "The selected original user group does not exist.");
    const all = db.prepare(`SELECT id,namespace,title,updated_at,uncertain,source_status,summary,group_id FROM original_api_chat_source_chats
      WHERE trashed_at IS NULL AND (?='' OR group_id=?) ORDER BY updated_at DESC,id`).all(group, group) as Json[];
    for (const row of db.prepare("SELECT id,namespace FROM original_api_chat_current_chats").all() as Json[]) {
      if (group && group !== "ungroup") continue;
      const session = await nativeCall("chat.session.get", { id: row.id });
      if (!session.archivedAt && !all.some(item => item.id === row.id))
        all.push({ ...row, title: session.title, updated_at: session.updatedAt, uncertain: 0, group_id: "ungroup" });
    }
    all.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(a.id).localeCompare(String(b.id)));
    const end = args.offset + args.limit;
    return { chats: all.slice(args.offset, end).map(chat => ({ id: chat.id, workspaceNamespace: chat.namespace,
      ...(chat.summary ? JSON.parse(chat.summary) : { workerManager: false }),
      title: chat.title, updatedAt: chat.updated_at, status: chat.uncertain ? "stopped" : chat.source_status ?? "idle",
      groupId: chat.group_id, chatUrl: chatUrl(chat.namespace, chat.id) })),
      groups: library.groups.map((item: Json) => ({ ...item, groupUrl: `pkm://chat-groups/${item.id}` })),
      ...(group ? { group: { ...(group === "ungroup" ? { id: "ungroup", name: "Ungrouped" }
        : library.groups.find((item: Json) => item.id === group)), groupUrl: `pkm://chat-groups/${group}` } } : {}),
      total: all.length, nextOffset: end < all.length ? end : null, truncated: end < all.length };
  };
  const receipt = async (selectedHost: string, requestId: string): Promise<Json> => {
    current();
    const state = selectedHost === hostId
      ? db.prepare("SELECT * FROM original_api_chat_request_state WHERE request_id=?").get(requestId) : undefined;
    if (state) return { ok: true, host_id: hostId, request_id: requestId, status: state.status,
      result: state.result === null ? null : JSON.parse(String(state.result)), error: state.error,
      next_action: state.status === "outcome_unknown" ? "Inspect the existing receipt; never automatically replay an uncertain request."
        : ["queued", "running"].includes(String(state.status)) ? "Call api_chat_request_get for this request_id." : null };
    const archived = db.prepare("SELECT * FROM original_api_chat_source_controls WHERE host_id=? AND request_id=?").get(selectedHost, requestId);
    if (!archived) throw new CoreError("NOT_FOUND", "No exact original request receipt exists; nothing was submitted or replayed.");
    const journal = assertOriginalMcpPrivacy(root)!;
    const reader = await openOriginalMcpCustodyReader(journal.plan);
    try {
      const bytes = await reader.read(String(archived.path), 1_048_576);
      if (hash(bytes.toString("utf8")) !== archived.sha256) throw new CoreError("RECOVERY_REQUIRED", "Original request receipt changed.");
      const old = JSON.parse(bytes.toString("utf8"));
      if (old.operation === "portal") failure("ORIGINAL_PORTAL_PAIRING_IS_NOT_RESTORED");
      const status = ["queued", "running"].includes(old.status) ? "outcome_unknown" : old.status;
      return { ok: true, host_id: selectedHost, request_id: requestId, status,
        result: old.result ?? null, error: old.error ?? null,
        next_action: status === "outcome_unknown" ? "Inspect the existing receipt; never automatically replay an uncertain request." : null };
    } finally { reader.close(); }
  };
  const execute = async (operation: string, args: Json, requestId: string, commandId: string): Promise<Json> => {
    current();
    if (operation === "list") return list(args);
    if (operation === "get") return snapshot(args.chatId);
    if (operation === "models") {
      if (!native.apiChat && !native.nativeChat) failure("NATIVE_VSCODE_MODEL_CATALOGUE_REQUIRED");
      const catalogue = native.nativeChat ? await native.nativeChat.models.catalogue(lifetime.signal)
        : await native.apiChat!.catalogue(lifetime.signal);
      const sdkCatalogue = native.nativeChat?.sdk ? await native.nativeChat.sdk.catalogue(lifetime.signal) : undefined;
      const sdkUnavailable = !sdkCatalogue ? await native.nativeChat?.sdkStatus?.(lifetime.signal) : undefined;
      return { models: catalogue.models.slice(0, 100).map(model => ({
        id: model.id, label: model.label, contextWindow: model.maxInputTokens, maxOutputTokens: model.maxOutputTokens,
      })), truncated: catalogue.models.length > 100,
        sdk: sdkCatalogue ? { source: "copilot-sdk", epoch: sdkCatalogue.epoch,
          registryRevision: sdkCatalogue.registryRevision, models: sdkCatalogue.models.slice(0, 100),
          truncated: sdkCatalogue.models.length > 100, providerTokenCount: null }
          : { source: "copilot-sdk", ...(sdkUnavailable ?? { status: "unsupported", reason: "NATIVE_SDK_RUNTIME_INCOMPATIBLE" }) } };
    }
    if (operation === "create") {
      const authority = chatAuthority();
      if (!authority) failure("NATIVE_CHAT_SELECTION_AND_PRESENTATION_REQUIRED");
      const sourcePlanSha256 = originalMcpApiChatSource(storage, native).planSha256;
      const selection = await resolveChat(authority, { requestId, requestedModelId: args.modelId, chatUrl: null,
        sourcePlanSha256, expectedSelection: null });
      await authorizeChat(authority, { operation: "create", requestId, commandId, chatUrl: null,
        sourcePlanSha256: originalMcpApiChatSource(storage, native).planSha256, sourceUncertain: false,
        argumentsSha256: originalMcpRequestDigest(args), selection });
      const id = randomUUID();
      const session = await nativeCall("chat.session.create", { id, title: args.title, operationId: randomUUID(), expectedRevision: 0 }, true);
      transaction(() => db.prepare("INSERT INTO original_api_chat_current_chats VALUES(?,?,?,?)")
        .run(id, namespace, canonicalJson(selection), requestId));
      transaction(() => db.prepare("UPDATE original_api_chat_request_state SET result=? WHERE request_id=?")
        .run(JSON.stringify({ chatId: id, chatUrl: chatUrl(namespace, id), title: session.title, sessionId: null, model: selection.modelId }), requestId));
      await authority.present({ requestId, chatUrl: chatUrl(namespace, id), sourcePlanSha256, selection }, lifetime.signal);
      return { chatId: id, chatUrl: chatUrl(namespace, id), title: session.title, sessionId: null, model: selection.modelId };
    }
    if (operation === "send" || operation === "cancel") {
      const authority = chatAuthority();
      if (!authority) failure("NATIVE_CHAT_MODEL_AND_REQUEST_AUTHORITY_REQUIRED");
      const chat = locate(args.chatId), locator = chatUrl(chat.namespace, chat.id);
      const metadata = chat.source ? await readOriginalMcpApiChatMetadata(storage, native, chat.id) : undefined;
      const previousResponse = db.prepare("SELECT * FROM original_api_chat_responses WHERE chat_id=?").get(chat.id);
      if (operation === "send" && previousResponse?.engine === "native-original"
        && previousResponse.history_published !== 1)
        failure("ORIGINAL_NATIVE_CHAT_RECONCILIATION_REQUIRED: inspect retained native output before constructing another prompt.");
      const canonicalTask = db.prepare(`SELECT t.*,a.request_id,a.status AS attempt_status FROM managed_chat_tasks t
        JOIN managed_chat_task_attempts a ON a.attempt_id=t.current_attempt_id WHERE t.actor_id=? AND t.chat_id=? AND t.status!='cancelled'`).get(actor.id, chat.id);
      const originalTask = !!metadata?.sessionId;
      if (operation === "send" && (metadata?.workerState || chat.uncertain))
        failure("ORIGINAL_API_CHAT_EXECUTION_PROTOCOL_REQUIRED: worker or uncertain source requires its dedicated native protocol.");
      if (operation === "send" && originalTask && typeof native.nativeChat?.apiChat?.adopt !== "function")
        failure("ORIGINAL_API_CHAT_EXECUTION_PROTOCOL_REQUIRED: MISSING_NATIVE_METHOD chat.task.adopt; old metadata is not current authority.");
      if (operation === "cancel" && originalTask && !canonicalTask && !taskPreparations.has(chat.id))
        failure("ORIGINAL_API_CHAT_EXECUTION_PROTOCOL_REQUIRED: an archived Task is not an owned native cancellation target.");
      if (operation === "send" && (originalMcpApiChatRequestsNewTask(args.prompt) || canonicalTask || originalTask)) {
        if (originalTask && originalMcpApiChatRequestsNewTask(args.prompt))
          failure("ORIGINAL_TASK_ADOPTION_REPLACEMENT_REFUSED: continuation must preserve the original Goal; use a fresh Chat for a new Task.");
        if (!originalTask && (!chat.native || chat.source))
          failure("ORIGINAL_NATIVE_CHAT_MANAGED_GOAL_COMPOSITION_REQUIRED: only fresh native-created text Chats can enter the canonical Task protocol.");
        if (previousResponse?.active === 1 || previousResponse?.status === "unknown" || taskPreparations.has(chat.id))
          throw new CoreError("BUSY", "Inspect or cancel the existing owned response; never replay an uncertain Task.");
        const tasks = await taskRuntime(), preparing = { requestId, abort: new AbortController() };
        taskPreparations.set(chat.id, preparing);
        let started: Awaited<ReturnType<typeof tasks.start>> | undefined;
        try {
          const prepared = await tasks.prepare({ chatId: chat.id, requestId, commandId, prompt: args.prompt,
            hardToolRoundLimit: args.hardToolRoundLimit ?? null }, AbortSignal.any([lifetime.signal, preparing.abort.signal]));
          const run = await executor();
          started = await tasks.start(prepared);
          taskPreparations.delete(chat.id);
          const plan = await tasks.plan(started, run, args.hardToolRoundLimit ?? null);
          transaction(() => {
            const prior = db.prepare("SELECT * FROM original_api_chat_responses WHERE chat_id=?").get(chat.id);
            if (prior?.active === 1 || prior?.status === "unknown") throw new CoreError("BUSY", "The owned response changed during Task review.");
            db.prepare(`INSERT INTO original_api_chat_responses VALUES(?,?,?,?,1,'prepared','native-original',0)
              ON CONFLICT(chat_id) DO UPDATE SET turn_id=excluded.turn_id,request_id=excluded.request_id,
              selection=excluded.selection,active=1,status='prepared',engine='native-original',history_published=0`)
              .run(chat.id, requestId, requestId, JSON.stringify(started!.selection));
          });
          const { completed, semanticFailure } = await tasks.run(started.attempt, plan, run, lifetime.signal);
          transaction(() => db.prepare(`UPDATE original_api_chat_responses SET active=0,status=?,history_published=1
            WHERE chat_id=? AND request_id=?`).run(completed.status, chat.id, requestId));
          if (completed.status === "failed" || completed.status === "unknown")
            throw new CoreError("NATIVE_CHAT_FAILED",
              `${semanticFailure ? `Goal policy: ${semanticFailure}. ` : ""}Inspect the canonical Goal/Harness and exact native receipts; no Task completion or replay granted.`, "unknown");
          return snapshot(locator);
        } catch (error) {
          if (started) throw new CoreError("NATIVE_TASK_RECONCILIATION_REQUIRED",
            `Canonical Task ${started.attempt.taskId} exists. ${error instanceof Error ? error.message : "Inspect its current native receipts."}`, "unknown");
          throw error;
        } finally {
          if (taskPreparations.get(chat.id) === preparing) taskPreparations.delete(chat.id);
        }
      }
      const storedSelection = chat.native ? originalNativeChatSelection.parse(JSON.parse(chat.model_selection)) : null;
      // This is expected configuration for a fresh resolve/consent, never a restored model handle or approval.
      const expectedSelection = storedSelection?.protocol === "pkm.original-api-chat-execution/v1"
        || storedSelection?.protocol === "pkm.original-sdk-api-chat-execution/v1"
        ? { ...storedSelection, epoch: native.receipt.epoch } : storedSelection;
      const selection = operation === "cancel" ? null : await resolveChat(authority, { requestId,
        requestedModelId: expectedSelection?.modelId ?? "", chatUrl: locator,
        sourcePlanSha256: originalMcpApiChatSource(storage, native).planSha256, expectedSelection });
      const authorize = () => authorizeChat(authority, { operation, requestId, commandId, chatUrl: locator,
        sourcePlanSha256: originalMcpApiChatSource(storage, native).planSha256, sourceUncertain: !!chat.uncertain,
        argumentsSha256: originalMcpRequestDigest(args), selection });
      if (operation === "cancel") {
        await authorize();
        const response = db.prepare("SELECT * FROM original_api_chat_responses WHERE chat_id=?").get(chat.id);
        let cancellationPending = false;
        const preparing = taskPreparations.get(chat.id);
        if (preparing) { preparing.abort.abort("native-task-cancel"); cancellationPending = true; }
        const cancelTask = db.prepare(`SELECT a.request_id,a.status FROM managed_chat_tasks t
          JOIN managed_chat_task_attempts a ON a.attempt_id=t.current_attempt_id WHERE t.actor_id=? AND t.chat_id=? AND t.status!='cancelled'`)
          .get(actor.id, chat.id);
        if (cancelTask && ["prepared", "bound", "cancel-requested"].includes(String(cancelTask.status))) {
          const tasks = await taskRuntime();
          await tasks.cancel(String(cancelTask.request_id));
        }
        if (response?.engine === "native-original") {
          if (nativeExecution) cancellationPending = (await nativeExecution).cancel(String(response.request_id)).cancellationPending || cancellationPending;
        } else if (response && runtime.services.chatTurns) {
          const currentTurn = runtime.services.chatTurns.get(actor.id, String(response.turn_id));
          if (!chatTurnTerminal(currentTurn.status)) await nativeCall("chat.turn.cancel", {
            id: currentTurn.id, expectedRevision: currentTurn.revision, operationId: randomUUID(),
          }, true);
          await runtime.services.chatTurns.settled(actor.id, currentTurn.id);
        }
        return { ...await snapshot(locator), cancellation: { requested: true, pending: cancellationPending } };
      }
      if (!selection) failure("NATIVE_CHAT_EXACT_MODEL_BINDING_REQUIRED");
      if (selection.protocol === "pkm.original-api-chat-execution/v1"
        || selection.protocol === "pkm.original-sdk-api-chat-execution/v1") {
        const isSdk = selection.provider === "copilot-sdk";
        if (!native.nativeChat) failure("AUTHENTICATED_NATIVE_CHAT_EXECUTION_LANE_REQUIRED");
        if (isSdk && !native.nativeChat.sdk) failure("NATIVE_SDK_RUNTIME_INCOMPATIBLE: no independently admitted SDK lane; no native fallback.");
        const drafts = chat.source ? originalApiChatPreservedImages(metadata!.images) ?? [] : [];
        const imageSource = { chatId: String(chat.id),
          sourcePlanSha256: originalMcpApiChatSource(storage, native).planSha256, images: drafts };
        const imageClaim = drafts.length ? inputImages.read(imageSource) : undefined;
        const draftSha256 = drafts.length ? hash(JSON.stringify(drafts)) : null;
        let memory: OriginalMcpMemoryContextSnapshot | undefined;
        let memoryBinding: Parameters<OriginalApiChatContextAssembler["liveMemory"]>[1] | undefined;
        const memoryPort = isSdk ? undefined : native.nativeChat.apiChat?.memory;
        if (memoryPort) {
          let scope: string | null = null;
          let scopeError: unknown;
          try {
            assertOriginalMcpDomainSession(storage, native, "memory");
            scope = readActiveMemoryScopeSession(root, actor.id).scope;
          } catch (error) {
            current();
            scopeError = error;
          }
          const memoryRequest = originalNativeChatMemoryRequest.parse({
            requestId, chatUrl: locator, sourcePlanSha256: imageSource.sourcePlanSha256,
            argumentsSha256: originalMcpRequestDigest(args), selection, draftSha256, scope,
            proposedQuery: memoryText(512).safeParse(args.prompt).success ? args.prompt : null,
          });
          const choice = originalNativeChatMemoryChoice.parse(await memoryPort.select(memoryRequest, lifetime.signal));
          current();
          if (choice.requestId !== requestId || choice.epoch !== native.receipt.epoch
            || choice.bindingSha256 !== originalNativeChatDigest(memoryRequest))
            failure("NATIVE_CHAT_MEMORY_BINDING_CHANGED");
          if (choice.mode === "refused" && choice.reason === "source-not-admitted" && scopeError) throw scopeError;
          if (choice.mode === "refused")
            failure(choice.reason === "source-not-admitted" ? "ORIGINAL_MEMORY_SCOPE_ADMISSION_REQUIRED: explicitly admit the same-owner Memory source before selecting live recall."
              : `NATIVE_CHAT_MEMORY_REQUEST_REFUSED: ${choice.reason}; no live reader or fallback was used.`);
          if (choice.mode === "live") {
            if (!scope || choice.scope !== scope) failure("NATIVE_CHAT_MEMORY_SCOPE_CHANGED");
            memory = await readOriginalMcpMemoryContext(owner, native,
              { query: choice.query, limit: choice.limit, signal: lifetime.signal });
            memory.assertCurrent();
            if (memory.scope !== choice.scope) failure("NATIVE_CHAT_MEMORY_SCOPE_CHANGED");
            memoryBinding = { requestId, workspaceId: hostId, nativeEpoch: native.receipt.epoch,
              nativeHostReceiptSha256: native.receipt.receiptSha256,
              argumentsSha256: memoryRequest.argumentsSha256, modelSha256: originalNativeChatDigest(selection),
              draftSha256, choiceBindingSha256: choice.bindingSha256, query: choice.query, limit: choice.limit };
          }
        }
        const catalogue = isSdk ? await native.nativeChat.sdk!.catalogue(lifetime.signal)
          : await native.nativeChat.models.catalogue(lifetime.signal);
        memory?.assertCurrent();
        const rawModel = catalogue.models.find(item => item.id === selection.modelId);
        const model = rawModel && ("sdkModelId" in rawModel ? {
          id: rawModel.id, nativeModelId: rawModel.sdkModelId, imageInput: rawModel.imageInput,
          maxInputTokens: rawModel.contextWindowTokens,
        } : rawModel);
        if (!model || model.nativeModelId !== selection.wireModelId || selection.epoch !== native.receipt.epoch
          || selection.provider === "vscode" && (model.maxInputTokens === null || selection.budget.maxInputTokens > model.maxInputTokens))
          failure("NATIVE_CHAT_EXACT_MODEL_BINDING_REQUIRED");
        const rawSelected = isSdk ? await native.nativeChat.sdk!.select({ modelId: model.id, catalogueSha256: originalNativeChatDigest(catalogue) }, lifetime.signal)
          : await native.nativeChat.models.select({ modelId: model.id, catalogueSha256: originalNativeChatDigest(catalogue) }, lifetime.signal);
        const selected = "model" in rawSelected ? { ...rawSelected, modelId: rawSelected.model.id } : rawSelected;
        memory?.assertCurrent();
        if (selected.modelId !== model.id || selected.epoch !== native.receipt.epoch) failure("NATIVE_MODEL_SELECTION_CHANGED");
        const context = new OriginalApiChatContextAssembler({
          chatUrl: locator, sourcePlanSha256: originalMcpApiChatSource(storage, native).planSha256,
        }, model.imageInput === true);
        if (drafts.length && chat.native && !imageClaim)
          failure("ORIGINAL_CHAT_DRAFT_IMAGE_RECONCILIATION_REQUIRED: existing native history has no owning draft-image input; no old bytes were silently reassigned.");
        if (imageClaim && !chat.native)
          failure("ORIGINAL_CHAT_DRAFT_IMAGE_RECONCILIATION_REQUIRED: inspect the earlier image claim and incomplete native session; never consume it again.");
        // Draft bytes belong to the durable user input, not the inline reference-context assembler.
        if (chat.source) context.attached({ context: metadata!.context, agentContext: metadata!.agentContext });
        if (chat.source && metadata!.includeHistory) {
          let afterSequence = 0;
          while (afterSequence < chat.message_count) {
            const page = await readOriginalMcpApiChatMessagePage(storage, native,
              { chatId: chat.id, afterSequence, limit: 100, maximumBytes: 16_000_000 });
            memory?.assertCurrent();
            if (!page.items.length) failure("Original history paging did not progress.");
            for (const [index, item] of page.items.entries()) {
              context.historical(item, afterSequence + index + 1);
            }
            afterSequence = page.afterSequence;
          }
        }
        let contextRevision: number | undefined;
        if (memory && chat.native) {
          const session = await nativeCall("chat.session.get", { id: chat.id });
          memory.assertCurrent(); contextRevision = session.revision;
          if (session.archivedAt) failure("NATIVE_CHAT_MEMORY_CHAT_BINDING_CHANGED");
        }
        if (chat.native && (!chat.source || metadata!.includeHistory)) {
          let restored = false;
          const history = await readNativeTranscript(chat.id, item => {
            memory?.assertCurrent();
            if (imageClaim && item.id === imageClaim.messageId) {
              context.append(inputImages.restore(imageClaim, item)); restored = true;
            } else context.append({ role: item.role, content: item.content });
          });
          if (contextRevision !== undefined && history.revision !== contextRevision)
            failure("NATIVE_CHAT_MEMORY_CHAT_BINDING_CHANGED");
          contextRevision = history.revision;
          if (imageClaim && !restored)
            failure("ORIGINAL_CHAT_DRAFT_IMAGE_RECONCILIATION_REQUIRED: the owning native input was not retained in history; no image was omitted.");
        }
        if (memory && memoryBinding) context.liveMemory(memory, memoryBinding);
        context.append({ role: "user", content: args.prompt,
          ...(drafts.length && !imageClaim ? { images: drafts } : {}) });
        const messages: OriginalNativeChatMessage[] = context.messages();
        await authorize();
        memory?.assertCurrent();
        const run = await executor();
        const common = {
          requestId, chatUrl: locator, selectionId: selected.selectionId,
          sourcePlanSha256: originalMcpApiChatSource(storage, native).planSha256,
          messages, tools: [], hardToolRoundLimit: args.hardToolRoundLimit ?? null, outputTokenCap: selection.outputTokenCap,
        };
        const base: OriginalNativeChatExecutionPlan | import("./original-mcp-sdk-model-contracts.js").OriginalSdkChatPlan = selection.provider === "copilot-sdk" ? {
          ...common, schema: "pkm.original-sdk-api-chat-execution/v1", epoch: native.receipt.epoch,
          hostReceiptSha256: native.receipt.receiptSha256,
          deadlineAtMs: Math.min(Date.now() + selection.budget.deadlineMs, originalMcpApiChatSourceDeadline(storage, native)),
          budget: { ...selection.budget },
        } : {
          schema: "pkm.original-api-chat-execution/v1", requestId, chatUrl: locator,
          selectionId: selected.selectionId, sourcePlanSha256: originalMcpApiChatSource(storage, native).planSha256,
          messages, tools: [], hardToolRoundLimit: args.hardToolRoundLimit ?? null, outputTokenCap: selection.outputTokenCap,
          budget: { ...selection.budget, deadlineMs: Math.min(selection.budget.deadlineMs,
            originalMcpApiChatSourceDeadline(storage, native) - Date.now()) },
        };
        base.tools = await run.modelTools(base);
        if (base.schema === "pkm.original-sdk-api-chat-execution/v1") {
          const measurement = await native.nativeChat.sdk!.measure({
            selectionId: selected.selectionId, messages: base.messages, tools: base.tools,
          }, lifetime.signal);
          if (measurement.provider !== "copilot-sdk" || measurement.providerTokenCount !== null
            || measurement.serializedBytes > base.budget.maxRequestBytes)
            failure("NATIVE_SDK_REQUEST_BYTES_EXCEEDED: no native token-count or fallback admission.");
        }
        memory?.assertCurrent();
        if (contextRevision !== undefined) {
          const session = await nativeCall("chat.session.get", { id: chat.id });
          memory?.assertCurrent();
          if (session.revision !== contextRevision || session.archivedAt)
            failure(memory ? "NATIVE_CHAT_MEMORY_CHAT_BINDING_CHANGED" : "NATIVE_CHAT_CONTEXT_SESSION_CHANGED");
        }
        transaction(() => {
          const prior = db.prepare("SELECT * FROM original_api_chat_responses WHERE chat_id=?").get(chat.id);
          if (prior?.active === 1 || prior?.status === "unknown") throw new CoreError("BUSY", "Inspect the existing owned response; never replay an uncertain request.");
          db.prepare(`INSERT INTO original_api_chat_responses VALUES(?,?,?,?,1,'prepared','native-original',0)
            ON CONFLICT(chat_id) DO UPDATE SET turn_id=excluded.turn_id,request_id=excluded.request_id,
            selection=excluded.selection,active=1,status='prepared',engine='native-original',history_published=0`)
            .run(chat.id, requestId, requestId, JSON.stringify(selection));
          if (drafts.length && !imageClaim) inputImages.claim({ ...imageSource, requestId, prompt: args.prompt });
          if (chat.native) db.prepare("UPDATE original_api_chat_current_chats SET model_selection=? WHERE id=?")
            .run(JSON.stringify(selection), chat.id);
        });
        if (!chat.native) {
          await nativeCall("chat.session.create", { id: chat.id, title: chat.title.slice(0, 120) || "Original Chat continuation",
            expectedRevision: 0, operationId: randomUUID() }, true);
          transaction(() => db.prepare("INSERT INTO original_api_chat_current_chats VALUES(?,?,?,?)")
            .run(chat.id, chat.namespace, JSON.stringify(selection), requestId));
        }
        let session = contextRevision !== undefined ? await assertTranscriptCurrent(chat.id, contextRevision)
          : await nativeCall("chat.session.get", { id: chat.id });
        const appended = await nativeCall("chat.session.append", { id: chat.id, expectedRevision: session.revision, operationId: randomUUID(),
          message: { id: `api-input:${requestId}`, role: "user", content: args.prompt, status: "complete" } }, true);
        const requestRevision = appended.session.revision;
        const prepared = memory || contextRevision !== undefined ? {
          assertCurrent() {
            current(); memory?.assertCurrent();
            if (drafts.length) {
              const actual = inputImages.read(imageSource);
              if (!actual || actual.requestId !== (imageClaim?.requestId ?? requestId)
                || actual.imagesSha256 !== draftSha256) failure("NATIVE_CHAT_MEMORY_DRAFT_BINDING_CHANGED");
            }
          },
          async verifyChat() {
            const observed = await nativeCall("chat.session.get", { id: chat.id });
            if (observed.revision !== requestRevision || observed.archivedAt)
              failure(memory ? "NATIVE_CHAT_MEMORY_CHAT_BINDING_CHANGED" : "NATIVE_CHAT_CONTEXT_SESSION_CHANGED");
          },
        } : undefined;
        prepared?.assertCurrent();
        const completed = await run.run(base, isSdk ? model.id : model.nativeModelId, lifetime.signal, prepared);
        transaction(() => db.prepare("UPDATE original_api_chat_responses SET active=0,status=? WHERE chat_id=? AND request_id=?")
          .run(completed.status, chat.id, requestId));
        if (completed.output.length > 100_000)
          failure("ORIGINAL_NATIVE_CHAT_LONG_TRANSCRIPT_REQUIRED: full output retained in native execution journal; not truncated.");
        session = await nativeCall("chat.session.get", { id: chat.id });
        await nativeCall("chat.session.append", { id: chat.id, expectedRevision: session.revision, operationId: randomUUID(),
          message: { id: `api-response:${requestId}`, role: "assistant", content: completed.output,
            model: selection.modelId, status: completed.status === "complete" ? "complete"
              : completed.status === "cancelled" ? "cancelled" : completed.status === "unknown" ? "interrupted" : "failed" } }, true);
        transaction(() => db.prepare("UPDATE original_api_chat_responses SET history_published=1 WHERE chat_id=? AND request_id=?")
          .run(chat.id, requestId));
        if (completed.status === "unknown" || completed.status === "failed")
          throw new CoreError("NATIVE_CHAT_FAILED", "Inspect the exact native execution and retained partial output; never replay.", "unknown");
        return snapshot(locator);
      }
      await authorize();
      if (!runtime.services.chatTurns) failure("NATIVE_CHAT_MODEL_AND_REQUEST_AUTHORITY_REQUIRED");
      if (args.hardToolRoundLimit !== undefined)
        failure("ORIGINAL_API_CHAT_EXECUTION_PROTOCOL_REQUIRED: this bounded model Host does not advertise hard-round limits.");
      assertModelProviderBinding(runtime.services.modelProvider, native.options.modelConfig, native.options.providerTransport);
      const resolved = await native.options.modelConfig.resolve({});
      if (selection.provider === "vscode")
        failure("NATIVE_VSCODE_MODEL_TRANSPORT_REQUIRED: configured profiles/HTTP are not VS Code language-model support.");
      if (!resolved.profile || !["configured", "model-unverified"].includes(resolved.status)
        || resolved.provider !== selection.provider || resolved.profile.id !== selection.profileId
        || resolved.profile.model !== selection.wireModelId || selection.modelId !== selection.profileId)
        failure("NATIVE_CHAT_EXACT_MODEL_BINDING_REQUIRED: no default/profile fallback is permitted.");
      const messages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
      if (chat.source && (metadata!.context?.length || metadata!.agentContext || metadata!.images?.length))
        failure("ORIGINAL_CHAT_CONTEXT_PROTOCOL_REQUIRED: retained attached context/images were not silently omitted.");
      if (chat.source && metadata!.includeHistory && chat.message_count > 0) {
        failure("ORIGINAL_CHAT_CONTEXT_PROTOCOL_REQUIRED: archived history requires the original execution context port; the bounded session transport does not silently omit or replace it.");
      }
      const contextSession = chat.native ? await readNativeTranscript(chat.id, item => {
        messages.push({ role: item.role, content: item.content });
        if (messages.length > 125 || Buffer.byteLength(JSON.stringify(messages)) > 240_000)
          failure("ORIGINAL_CHAT_CONTEXT_PROTOCOL_REQUIRED: no retained messages were silently omitted.");
      }) : undefined;
      messages.push({ role: "user", content: args.prompt });
      if (messages.length > 126 || Buffer.byteLength(JSON.stringify(messages)) > 240_000)
        failure("ORIGINAL_CHAT_CONTEXT_PROTOCOL_REQUIRED: no retained messages were silently omitted.");
      const turnId = randomUUID();
      transaction(() => {
        const prior = db.prepare("SELECT * FROM original_api_chat_responses WHERE chat_id=?").get(chat.id);
        if (prior?.active === 1 || prior?.status === "unknown") throw new CoreError("BUSY", "Inspect the existing owned response; never replay an uncertain send.");
        db.prepare(`INSERT INTO original_api_chat_responses VALUES(?,?,?,?,1,'prepared','bounded',0)
          ON CONFLICT(chat_id) DO UPDATE SET turn_id=excluded.turn_id,request_id=excluded.request_id,
          selection=excluded.selection,active=1,status='prepared',engine='bounded',history_published=0`)
          .run(chat.id, turnId, requestId, canonicalJson(selection));
      });
      try {
        if (!chat.native) {
          await nativeCall("chat.session.create", { id: chat.id, title: chat.title.slice(0, 120) || "Original Chat continuation",
            operationId: randomUUID(), expectedRevision: 0 }, true);
          transaction(() => db.prepare("INSERT INTO original_api_chat_current_chats VALUES(?,?,?,?)")
            .run(chat.id, chat.namespace, canonicalJson(selection), requestId));
        }
        const session = contextSession ? await assertTranscriptCurrent(chat.id, contextSession.revision)
          : await nativeCall("chat.session.get", { id: chat.id });
        await nativeCall("chat.turn.start", { id: turnId, sessionId: chat.id, operationId: randomUUID(), expectedRevision: 0,
          expectedSessionRevision: session.revision, messages: [{ role: "user", content: args.prompt }], ...selection.budget,
          deadlineMs: Math.min(selection.budget.deadlineMs, originalMcpApiChatSourceDeadline(storage, native) - Date.now()) }, true);
        const turn = await runtime.services.chatTurns.settled(actor.id, turnId);
        transaction(() => db.prepare("UPDATE original_api_chat_responses SET active=0,status=? WHERE chat_id=? AND turn_id=?")
          .run(turn.status, chat.id, turnId));
        if (turn.status === "failed" || turn.status === "unknown")
          throw new CoreError("NATIVE_CHAT_FAILED", "The owned attempt failed or is unknown; inspect its original receipt and partial output.", "unknown");
        return snapshot(locator);
      } catch (error) {
        try {
          const turn = runtime.services.chatTurns.get(actor.id, turnId);
          if (chatTurnTerminal(turn.status)) transaction(() => db.prepare("UPDATE original_api_chat_responses SET active=0,status=? WHERE chat_id=? AND turn_id=?")
            .run(turn.status, chat.id, turnId));
        } catch (recoveryError) {
          if (recoveryError instanceof ChatTurnError && recoveryError.code === "NOT_FOUND")
            transaction(() => db.prepare("UPDATE original_api_chat_responses SET active=0,status='failed-before-model' WHERE chat_id=? AND turn_id=?")
              .run(chat.id, turnId));
          else throw new AggregateError([error, recoveryError], "Chat failure and durable response reconciliation both failed.");
        }
        throw error;
      }
    }
    throw new CoreError("NOT_FOUND", "Unknown original Chat operation.");
  };
  const submit = async (operation: string, args: Json, commandId: string): Promise<Json> => {
    const requestId = hash(pythonMetadataJson([hostId, commandId]).replace(/[\u007f-\uffff]/g,
      value => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`));
    const payload = hash(pythonMetadataJson({ operation, arguments: args, commandId }, true));
    const fresh = transaction(() => {
      if (db.prepare("SELECT 1 FROM original_api_chat_source_controls WHERE host_id=? AND request_id=?").get(hostId, requestId))
        throw new CoreError("CONFLICT", "This identity belongs to an archived request; never replay it as a new native command.");
      const old = db.prepare("SELECT payload_sha256 FROM original_api_chat_requests WHERE request_id=?").get(requestId);
      if (old) {
        if (old.payload_sha256 !== payload) throw new CoreError("CONFLICT", "This command_id already belongs to a different request; no action was repeated.");
        return false;
      }
      db.prepare("INSERT INTO original_api_chat_requests VALUES(?,?,?,?,?,?,?)")
        .run(requestId, hostId, commandId, operation, canonicalJson(args), payload, Date.now());
      db.prepare("INSERT INTO original_api_chat_request_state VALUES(?,'queued',NULL,NULL,?)").run(requestId, native.receipt.epoch);
      return true;
    });
    if (fresh) {
      const task = Promise.resolve().then(async () => {
        transaction(() => db.prepare("UPDATE original_api_chat_request_state SET status='running' WHERE request_id=? AND status='queued'").run(requestId));
        try {
          const value = await execute(operation, args, requestId, commandId);
          transaction(() => db.prepare("UPDATE original_api_chat_request_state SET status='succeeded',result=? WHERE request_id=?")
            .run(JSON.stringify(value), requestId));
        } catch (error) {
          if (!closed && !lifetime.signal.aborted && !native.signal.aborted) transaction(() => {
            const recorded = db.prepare("SELECT result FROM original_api_chat_request_state WHERE request_id=?").get(requestId);
            const uncertain = recorded?.result != null || error instanceof CoreError && error.effect === "unknown";
            db.prepare("UPDATE original_api_chat_request_state SET status=?,error=? WHERE request_id=?")
              .run(uncertain ? "outcome_unknown" : "failed", error instanceof CoreError ? error.message.slice(0, 1000)
                : error instanceof Error && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
                  ? error.code : "Native Chat request failed; inspect retained state.", requestId);
          });
        }
      }).finally(() => pending.delete(task));
      pending.add(task);
      void task.catch(error => { backgroundFailure = error; lifetime.abort(); });
    }
    return receipt(hostId, requestId);
  };
  const close = async () => {
    if (closed) return;
    closed = true; lifetime.abort();
    if (runtime.services.chatTurns) for (const row of db.prepare("SELECT turn_id FROM original_api_chat_responses WHERE active=1").all()) {
      let currentTurn;
      try { currentTurn = runtime.services.chatTurns.get(actor.id, String(row.turn_id)); }
      catch (error) { if (error instanceof ChatTurnError && error.code === "NOT_FOUND") continue; throw error; }
      if (!chatTurnTerminal(currentTurn.status)) runtime.services.chatTurns.cancel(actor.id, {
        id: currentTurn.id, expectedRevision: currentTurn.revision, operationId: randomUUID(),
      });
    }
    await Promise.all([...pending]);
    db.close();
    liveRuntimes.delete(storage);
    if (backgroundFailure) throw new AggregateError([backgroundFailure], "Native Chat request background persistence failed.");
  };
  owner.retainResource({ closeAdmission() { lifetime.abort(); }, release: close });
  return Object.freeze({
    operationIds: originalMcpApiChatOperationIds, close,
    async invoke(tool: string, input: Json, signal?: AbortSignal): Promise<CallToolResult> {
      current();
      const contract = contracts.get(tool);
      if (!contract || !schemas[tool]) throw new CoreError("NOT_FOUND", "Unknown original API Chat tool.");
      if (!originalMcpApiChatOperationIds.includes(contract.id) && !originalMcpApiChatConditionalOperationIds.includes(contract.id))
        failure("API_CHAT_CONTROL_ADAPTER_REQUIRED: original send/owned-response execution and budget protocol remain unqualified.");
      if (!contract.readOnly && !actor.canWrite) throw new CoreError("ACCESS_DENIED", "Read-only native principal.");
      const args = schemas[tool]!.parse(structuredClone(input));
      if (tool === "api_chat_send" && args.hard_tool_round_limit !== null && !native.nativeChat)
        failure("ORIGINAL_API_CHAT_EXECUTION_PROTOCOL_REQUIRED: this bounded native Host does not advertise the original hard-round-limit protocol; no request was submitted.");
      const approval = { operation: contract.id, version: 1 as const, tool, readOnly: contract.readOnly,
        arguments: structuredClone(input), argumentsDigest: originalMcpRequestDigest(input) };
      const work = async () => {
        if (tool === "api_chat_capabilities") return result({ ok: true, schema_version: "1.0.0",
          hosts: [{ host_id: hostId, workspace_paths: [], machine: null, build: null,
            send_limits: native.nativeChat ? { hardToolRoundLimit: { min: 1, max: 1000 }, requiresNativeOriginalModel: true } : {},
            operations: ["list", "get", ...(native.apiChat || native.nativeChat ? ["models"] : []),
              ...(chatAuthority() ? ["create",
              ...(runtime.services.chatTurns?.available || native.nativeChat ? ["send", "cancel"] : [])] : [])] }],
          truncated: false, tools: names.map(name => `api_chat_${name}`),
          policy: "Current native Host only. Archived Hosts/permissions/queued work are inert. Native execution/round-limit protocol is not yet qualified." });
        if (tool === "api_chat_request_get") return result(await receipt(args.host_id, args.request_id));
        if (args.host_id !== hostId) throw new CoreError("ACCESS_DENIED", "Select the exact current host_id; old Host IDs are read-only historical receipt identities.");
        const operation = tool.slice("api_chat_".length), commandId = args.command_id || randomUUID();
        const values = operation === "list" ? { offset: args.offset, limit: args.limit, ...(args.group_path ? { groupId: args.group_path } : {}) }
          : operation === "models" ? {} : operation === "create" ? { title: args.title, modelId: args.model_id }
            : { chatId: args.chat_id, ...(operation === "send" ? { prompt: args.prompt,
              ...(args.hard_tool_round_limit !== null ? { hardToolRoundLimit: args.hard_tool_round_limit } : {}) } : {}) };
        return result(await submit(operation, values, commandId));
      };
      return originalMcpPublicRequestMatches(storage, native, approval) ? work()
        : withOriginalMcpPublicRequest(storage, native, approval, work, signal);
    },
  });
}
