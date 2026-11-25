import { z } from "zod";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CoreError, type Actor } from "./contracts.js";
import { RootOwner, assertRootOwner } from "./root-owner.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertOriginalMcpDomainSession } from "./original-mcp-domains.js";
import { originalMcpApiChatSource, readOriginalMcpApiChatMetadata } from "./original-mcp-api-chat-source.js";
import { openOriginalMcpCustodyReader } from "./original-mcp-root.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import { validateLegacyApiChatLibrary, type LegacyApiChatLibrary } from "./legacy-api-chat-library.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { CHAT_SESSION_LIMITS, chatSessionDefinitions } from "./chat-session-contracts.js";
import { planTodo } from "./boards.js";
import { todoDefinitions } from "./todo-definitions.js";
import type { TodoChat } from "./todo-store-contract.js";

export interface OriginalMcpTodoAgentListArguments {
  board_slug: string; query?: string; offset?: number; limit?: number;
}
export interface OriginalMcpTodoChatDirectoryPort {
  readonly schema: "pkm.original-mcp-todo-chat-directory/v1";
  readAgentList(actor: Readonly<Actor>, arguments_: Readonly<OriginalMcpTodoAgentListArguments>): Promise<OriginalMcpTodoAgentList>;
  assertCurrent(): void;
}
const agentListResult = z.strictObject({
  actorId: z.string().min(1), board_slug: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/),
  items: z.array(z.strictObject({
    id: z.string().min(1), kind: z.enum(["pkm-chat", "missing-chat", "user", "external"]), title: z.string(),
    chatUrl: z.string().optional(), sourceAuthority: z.literal("archive_only").optional(),
    assignmentAvailable: z.literal(false).optional(),
  })).max(100),
  total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100), next_offset: z.number().int().nonnegative().nullable(),
  chatDirectory: z.strictObject({ available: z.boolean(), reason: z.string().min(1) }),
});
export type OriginalMcpTodoAgentList = z.infer<typeof agentListResult>;
const ports = new WeakSet<object>();
const nativeList = chatSessionDefinitions.find(item => item.id === "chat.session.list")!;
const agentList = todoDefinitions.find(item => item.id === "todo.agent.list")!;
const sourceChat = z.strictObject({
  id: z.string().uuid().regex(/^[a-f0-9-]{36}$/), namespace: z.string().regex(/^[a-f0-9]{16}$/),
});
function denied(message: string): never { throw new CoreError("NATIVE_AUTHORITY_REQUIRED", message); }
function sourcePin(path: string): string | undefined {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return stat ? [stat.dev, stat.ino, stat.mode, stat.nlink, stat.uid, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") : undefined;
}

/** Source discovery is not an assignment binding, worker grant, or restored historical Chat authority. */
export async function createOriginalMcpTodoChatDirectoryPort(owner: RootOwner, host: OriginalMcpNativeHost):
Promise<OriginalMcpTodoChatDirectoryPort> {
  assertRootOwner(owner);
  const { storage, runtime } = await owner.ensureFull(), root = storage.workspaceRoot();
  const current = () => {
    assertRootOwner(owner);
    storage.assertWorkspaceLease();
    assertOriginalMcpNativeHost(host, storage);
    assertOriginalMcpDomainSession(storage, host, "todo");
    return originalMcpApiChatSource(storage, host);
  };
  current();
  const port: OriginalMcpTodoChatDirectoryPort = Object.freeze({
    schema: "pkm.original-mcp-todo-chat-directory/v1" as const,
    assertCurrent() { current(); },
    async readAgentList(actor: Readonly<Actor>, arguments_: Readonly<OriginalMcpTodoAgentListArguments>) {
      actor = Object.freeze({ ...actor });
      const args = agentList.input.parse(structuredClone(arguments_)) as Record<string, unknown>;
      if (actor.id !== "mcp:external" || actor.boardWorker)
        throw new CoreError("ACCESS_DENIED", "Original Chat discovery requires the exact native source owner; a Board worker grant is not Chat authority.");
      const source = current(), nativeChats = new Map<string, TodoChat>(), seen = new Set<string>();
      const workspaceId = await storage.workspaceId();
      const namespace = workspaceId.replaceAll("-", "").slice(0, 16);
      let cursor: string | undefined, complete = false;
      for (let pageNumber = 0; pageNumber < Math.ceil(CHAT_SESSION_LIMITS.sessionsPerActor / 100); pageNumber++) {
        const response = await runtime.core.dispatch("capability_read", { operation: "chat.session.list", version: 1,
          arguments: { limit: 100, includeArchived: false, ...(cursor ? { cursor } : {}) } }, actor);
        current();
        if (response.error) throw new CoreError(response.error.code, response.error.message, response.error.effect);
        const page = nativeList.output.parse(response.result) as {
          items: { id: string; title: string }[]; nextCursor: string | null;
        };
        for (const chat of page.items) {
          sourceChat.shape.id.parse(chat.id);
          if (nativeChats.has(chat.id)) throw new CoreError("CURSOR_INVALID", "Native Chat directory repeated an identity.");
          nativeChats.set(chat.id, { hostSessionId: chat.id, title: chat.title, chatUrl: `pkm://chats/${namespace}/${chat.id}` });
        }
        cursor = page.nextCursor ?? undefined;
        if (!cursor) { complete = true; break; }
        if (seen.has(cursor)) throw new CoreError("CURSOR_INVALID", "Native Chat directory repeated a cursor.");
        seen.add(cursor);
      }
      if (!complete || nativeChats.size > CHAT_SESSION_LIMITS.sessionsPerActor)
        throw new CoreError("LIMIT_EXCEEDED", "Native Chat directory exceeded its complete bounded enumeration.");
      return storage.withWorkspaceExclusive(async () => {
        if (current().planSha256 !== source.planSha256) denied("Original Chat source changed during Todo discovery.");
        storage.assertNoPendingLegacyNoteWorkItems();
        const db = storage.connectNative();
        try {
          if (db.prepare("SELECT 1 FROM pending_todo WHERE singleton=1").get())
            throw new CoreError("RECOVERY_REQUIRED", "Pending Todo publication must settle before original Chat discovery.");
          const rows = db.prepare("SELECT id,namespace,trashed_at FROM original_api_chat_source_chats ORDER BY id")
            .all().map(row => sourceChat.extend({ trashed_at: z.string().nullable() }).parse(row));
          if (rows.length !== source.chats) denied("Original Chat source directory changed from its exact admission.");
          const sourcePins = new Map<string, string | undefined>();
          const reader = await openOriginalMcpCustodyReader(assertOriginalMcpPrivacy(root)!.plan);
          try {
            const path = ".pkm/state/api-chats/library.json", entry = reader.entry(path);
            sourcePins.set(join(root, path), sourcePin(join(root, path)));
            if (!entry && lstatSync(join(root, path), { throwIfNoEntry: false }))
              denied("An unadmitted original Chat Library appeared after source admission.");
            const library: LegacyApiChatLibrary = entry ? validateLegacyApiChatLibrary(
              JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await reader.read(path, 1_048_576))),
              new Set(rows.map(row => row.id))) : { version: 1, groups: [], placements: {} };
            const retained = db.prepare("SELECT payload FROM original_api_chat_source_library WHERE singleton=1").get();
            if (!retained || retained.payload !== canonicalJson(library)
              || rows.some(row => row.trashed_at !== (library.placements[row.id]?.trashedAt ?? null)))
              denied("Original Chat Library directory source changed; no retained discovery result was replayed.");
            reader.assertCurrent();
          } finally { reader.close(); }
          const chats = new Map(nativeChats), archival = new Set<string>();
          for (const row of rows.filter(row => row.trashed_at === null)) {
            const path = join(root, ".pkm/state/api-chats", row.namespace, `${row.id}.json`);
            sourcePins.set(path, sourcePin(path));
            const metadata = await readOriginalMcpApiChatMetadata(storage, host, row.id);
            current();
            // Preserve the original URL even when this same UUID also has a fresh canonical native session.
            const native = nativeChats.get(row.id);
            chats.set(row.id, { hostSessionId: row.id, title: native?.title ?? metadata.title,
              chatUrl: `pkm://chats/${row.namespace}/${row.id}` });
            if (!native) archival.add(`chat:${row.id}`);
          }
          if (current().planSha256 !== source.planSha256) denied("Original Chat source changed during Todo discovery.");
          const plan = planTodo(root, { operation: "todo.agent.list", args, actorId: actor.id }, () => [...chats.values()], db);
          if (plan.write) denied("Chat directory discovery cannot publish a Board mutation.");
          const result = agentListResult.parse(agentList.output.parse(plan.result));
          result.items = result.items.map(item => archival.has(item.id)
            ? { ...item, sourceAuthority: "archive_only", assignmentAvailable: false } : item);
          result.chatDirectory = { available: true,
            reason: "Exact admitted original Chat sources and active native Chat sessions owned by the authenticated actor. Archive-only sources grant no live assignment or worker authority." };
          current();
          for (const [path, pin] of sourcePins) if (sourcePin(path) !== pin)
            denied("Original Chat directory source changed while its complete result was being assembled.");
          return agentListResult.parse(result);
        } finally { db.close(); }
      });
    },
  });
  ports.add(port);
  return port;
}

export function assertOriginalMcpTodoChatDirectoryPort(value: unknown): asserts value is OriginalMcpTodoChatDirectoryPort {
  if (!value || typeof value !== "object" || !ports.has(value))
    denied("A genuine same-owner original Todo Chat directory port is required.");
  (value as OriginalMcpTodoChatDirectoryPort).assertCurrent();
}

/** Route only todo.agent.list here, after the caller's normal native-public approval; this port admits no mutations. */
export async function readOriginalMcpTodoAgentList(owner: RootOwner, host: OriginalMcpNativeHost,
  actor: Readonly<Actor>, arguments_: unknown): Promise<OriginalMcpTodoAgentList> {
  actor = Object.freeze({ ...actor });
  const parsed = agentList.input.parse(structuredClone(arguments_)) as OriginalMcpTodoAgentListArguments;
  return (await createOriginalMcpTodoChatDirectoryPort(owner, host)).readAgentList(actor, parsed);
}
