import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Core } from "./core.js";
import type { Actor } from "./contracts.js";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const commandId = z.string().max(128).refine(value => !value || !!value.trim());
const hostArgs = { host_id: uuid, command_id: commandId.default("") };
const capabilitiesInput = z.strictObject({});
const modelsInput = z.strictObject(hostArgs);
const listInput = z.strictObject({
  ...hostArgs, group_path: z.string().max(256).default(""),
  offset: z.number().int().safe().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(100),
});
const getInput = z.strictObject({ ...hostArgs, chat_id: z.string().min(1).max(512) });
const requestInput = z.strictObject({ host_id: uuid, request_id: z.string().regex(/^[a-f0-9]{64}$/) });

type JsonRecord = Record<string, any>;
type ApiChatCore = Pick<Core, "dispatch">;

async function coreResult(core: ApiChatCore, method: string, input: unknown, actor: Actor): Promise<JsonRecord> {
  const envelope = await core.dispatch(method, input, actor) as JsonRecord;
  if (envelope?.error) throw new Error(String(envelope.error.message || "Native Chat read failed."));
  if (!envelope?.result || typeof envelope.result !== "object" || Array.isArray(envelope.result))
    throw new Error("Native Chat read returned an unsupported result.");
  return envelope.result;
}

async function nativeRead(core: ApiChatCore, operation: string, args: JsonRecord, actor: Actor): Promise<JsonRecord> {
  return coreResult(core, "capability_read", { operation, version: 1, arguments: args }, actor);
}

async function hostId(core: ApiChatCore, selected: string, actor: Actor): Promise<string> {
  const info = await coreResult(core, "server_info", {}, actor);
  if (typeof info.workspaceId !== "string" || !uuid.safeParse(info.workspaceId).success)
    throw new Error("The native workspace has no canonical Host identity.");
  if (selected !== info.workspaceId)
    throw new Error("Select the exact local host_id returned by api_chat_capabilities; remote Hosts are unsupported.");
  const capabilities = await nativeRead(core, "chat.session.capabilities", {}, actor);
  if (capabilities.schema !== "pkm.chat.session.capabilities/v1"
    || capabilities.generation !== "unavailable" || capabilities.replay !== "never")
    throw new Error("Native Chat session authority is unsupported; no request was sent.");
  return info.workspaceId;
}

function localNamespace(workspaceId: string): string {
  return workspaceId.replace(/-/g, "").slice(0, 16);
}

function chatUrl(workspaceId: string, id: string): string {
  return `pkm://chats/${localNamespace(workspaceId)}/${id}`;
}

function chatIdentity(value: string, workspaceId: string): string {
  if (uuid.safeParse(value).success) return value;
  const match = /^pkm:\/\/chats\/([a-f0-9]{16})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(value);
  if (!match || match[1] !== localNamespace(workspaceId))
    throw new Error("Use a PKM Chat URL returned by api_chat_list for this Host; legacy UUIDs are also accepted.");
  return match[2]!;
}

async function listSessions(core: ApiChatCore, actor: Actor): Promise<JsonRecord[]> {
  const items: JsonRecord[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 6; pageNumber++) {
    const page = await nativeRead(core, "chat.session.list", {
      limit: 100, includeArchived: true, ...(cursor ? { cursor } : {}),
    }, actor);
    if (!Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== "string"))
      throw new Error("Native Chat list returned an unsupported page.");
    items.push(...page.items);
    if (items.length > 512) throw new Error("Native Chat list exceeds the supported actor limit.");
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("Native Chat list repeated a cursor; no result was returned.");
    if (cursor) seen.add(cursor);
    if (!cursor) return items;
  }
  throw new Error("Native Chat list exceeded its bounded page count.");
}

async function sessionMessages(core: ApiChatCore, id: string, actor: Actor): Promise<JsonRecord[]> {
  const items: JsonRecord[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await nativeRead(core, "chat.session.messages", {
      id, limit: 100, ...(cursor ? { cursor } : { afterSequence: 0 }),
    }, actor);
    if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean")
      throw new Error("Native Chat transcript returned an unsupported page.");
    items.push(...page.items);
    if (items.length > 10_000) throw new Error("Native Chat transcript exceeds the supported message limit.");
    if (!page.hasMore) return items;
    if (typeof page.nextCursor !== "string" || seen.has(page.nextCursor))
      throw new Error("Native Chat transcript repeated or omitted its cursor.");
    cursor = page.nextCursor;
    seen.add(cursor);
  }
  throw new Error("Native Chat transcript exceeded its bounded page count.");
}

function publicText(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 256
    && !/(?:https?:\/\/|(?:api[_-]?key|secret|token|password)\s*[:=]|(?:sk|rk)-[A-Za-z0-9_-]{16,})/i.test(value)
    ? value : undefined;
}

async function capabilities(core: ApiChatCore, actor: Actor) {
  const info = await coreResult(core, "server_info", {}, actor);
  if (typeof info.workspaceId !== "string" || !uuid.safeParse(info.workspaceId).success)
    throw new Error("The native workspace has no canonical Host identity.");
  const native = await nativeRead(core, "chat.session.capabilities", {}, actor);
  if (native.schema !== "pkm.chat.session.capabilities/v1"
    || native.generation !== "unavailable" || native.replay !== "never")
    throw new Error("Native Chat session authority is unsupported.");
  return {
    ok: true, schema_version: "1.0.0",
    hosts: [{
      host_id: info.workspaceId, workspace_paths: [], machine: null, build: null, send_limits: {},
      operations: ["models", "list", "get"],
    }],
    truncated: false,
    tools: ["api_chat_models", "api_chat_list", "api_chat_get", "api_chat_request_get"],
    policy: "Only this isolated native workspace is a Host. Chat reads are actor-private; model profiles are local configuration only. No external provider, generation, tool execution, legacy Host, request submission or replay is available.",
  };
}

async function models(core: ApiChatCore, args: z.infer<typeof modelsInput>, actor: Actor) {
  await hostId(core, args.host_id, actor);
  const catalog = await nativeRead(core, "model.config.catalog", {}, actor);
  if (catalog.schema !== "pkm.model-config.catalog/v1" || !Array.isArray(catalog.providers))
    throw new Error("Native model configuration returned an unsupported catalog.");
  const provider = catalog.providers.find((item: JsonRecord) => item.provider === "vscode");
  const profiles = provider?.status === "configured" && Array.isArray(provider.profiles)
    ? provider.profiles.filter((profile: JsonRecord) => profile.status === "active") : [];
  const values = profiles.map((profile: JsonRecord) => ({
    id: profile.id, label: profile.label, contextWindow: profile.contextWindow, maxOutputTokens: profile.maxOutputTokens,
  }));
  return { models: values.slice(0, 100), truncated: values.length > 100 };
}

async function list(core: ApiChatCore, args: z.infer<typeof listInput>, actor: Actor) {
  const workspaceId = await hostId(core, args.host_id, actor);
  const groupPath = args.group_path.replace(/^pkm:\/\/chat-groups\//, "");
  if (groupPath && groupPath !== "ungroup")
    throw new Error("Native Chat sessions have no imported user-group membership; group filtering is unsupported.");
  const all = await listSessions(core, actor);
  const end = args.offset + args.limit;
  const chats = all.slice(args.offset, end).map((session: JsonRecord) => {
    if (!uuid.safeParse(session.id).success || typeof session.title !== "string"
      || typeof session.updatedAt !== "string" || typeof session.archivedAt !== "string" && session.archivedAt !== null)
      throw new Error("Native Chat record cannot be represented by the original Chat locator contract.");
    return {
      id: session.id, workspaceNamespace: localNamespace(workspaceId), title: session.title,
      updatedAt: session.updatedAt, status: session.archivedAt ? "archived" : "idle",
      groupId: "ungroup", chatUrl: chatUrl(workspaceId, session.id),
    };
  });
  return {
    chats, groups: [], total: all.length,
    nextOffset: end < all.length ? end : null, truncated: end < all.length,
  };
}

async function get(core: ApiChatCore, args: z.infer<typeof getInput>, actor: Actor) {
  const workspaceId = await hostId(core, args.host_id, actor);
  const id = chatIdentity(args.chat_id, workspaceId);
  const session = await nativeRead(core, "chat.session.get", { id }, actor);
  if (session.id !== id || typeof session.title !== "string" || typeof session.messageCount !== "number"
    || typeof session.archivedAt !== "string" && session.archivedAt !== null
    || session.metadata !== undefined && (!session.metadata || typeof session.metadata !== "object" || Array.isArray(session.metadata)))
    throw new Error("Native Chat record identity is invalid.");
  const messages = await sessionMessages(core, id, actor);
  if (messages.length !== session.messageCount)
    throw new Error("Native Chat transcript does not match its stored summary.");
  const reply = [...messages].reverse().find((message: JsonRecord) => message.role === "assistant");
  const safeModel = publicText(reply?.model);
  return {
    chatId: id, chatUrl: chatUrl(workspaceId, id), title: session.title,
    status: session.archivedAt ? "archived" : "idle", sessionId: publicText(session.metadata?.sessionId) ?? null,
    permissionMode: "unavailable", model: safeModel ?? null,
    reply: reply ? {
      id: reply.id, model: safeModel ?? null, status: reply.status,
      content: reply.content.slice(0, 16_000), truncated: reply.content.length > 16_000,
      error: null, usage: null, credits: null, creditsStatus: "unavailable", creditUsage: null,
      context: null, toolRoundLimit: null,
      tools: (reply.toolCalls ?? []).map((tool: JsonRecord) => ({
        name: typeof tool.name === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) ? tool.name : "unavailable",
        status: tool.status,
      })),
    } : null,
  };
}

async function requestGet(core: ApiChatCore, args: z.infer<typeof requestInput>, actor: Actor) {
  await hostId(core, args.host_id, actor);
  throw new Error("No native original API Chat request-receipt store is available; no request was submitted or replayed.");
}

export function registerLegacyApiChatReadTools(server: McpServer, core: ApiChatCore, actor: Actor): void {
  const register = (name: string, schema: z.ZodTypeAny, handler: (args: any) => Promise<unknown>) => {
    const config = {
      description: `Safe local read-only compatibility view for ${name}; no model or external provider is invoked.`,
      inputSchema: schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    };
    const callback = async (args: unknown) => {
      const result = await handler(schema.parse(args));
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as JsonRecord };
    };
    server.registerTool(name, config as any, callback as any);
  };
  register("api_chat_capabilities", capabilitiesInput, () => capabilities(core, actor));
  register("api_chat_models", modelsInput, args => models(core, args, actor));
  register("api_chat_list", listInput, args => list(core, args, actor));
  register("api_chat_get", getInput, args => get(core, args, actor));
  register("api_chat_request_get", requestInput, args => requestGet(core, args, actor));
}
