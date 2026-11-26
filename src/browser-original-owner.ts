import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { createBrowserReleaseGate, type BrowserCommand } from "./browser-release-gate.js";
import { CoreError } from "./contracts.js";
import { checkedDocumentPath, documentPath } from "./document-path.js";

type ReadOperation = "list_notes" | "search_notes" | "get_note" |
  "api_chat_capabilities" | "api_chat_list" | "api_chat_get" | "api_chat_request_get";
export type OriginalBrowserGrant = Readonly<{
  actorId: string; workspaceRoot: string; generation: string; chatHostId?: string;
}>;
type TurnRef = Readonly<{ chatId: string; turnId: string }>;
interface OriginalBrowserChatTurns {
  getSendTarget(grant: OriginalBrowserGrant, input: Readonly<{ chatId: string }>): unknown;
  sendChatTurn(grant: OriginalBrowserGrant, input: TurnRef & Readonly<{ revision: string; text: string }>): unknown;
  getChatTurn(grant: OriginalBrowserGrant, input: TurnRef): unknown;
  stopChatTurn(grant: OriginalBrowserGrant, input: TurnRef): unknown;
}
export interface OriginalBrowserOwner {
  /** One credential, one actor and one pinned Original owner; never sourced from browser input. */
  token: string;
  grant: OriginalBrowserGrant;
  assertCurrent(grant: OriginalBrowserGrant): void;
  /** Use only the selected Original gateway's capability_read. Must not launch or reselect a gateway. */
  capabilityRead(grant: OriginalBrowserGrant, input: Readonly<{
    operation: `mcp.tool.${ReadOperation}`; version: 1; arguments: Readonly<Record<string, unknown>>;
  }>): Promise<unknown>;
  /** Private callback from bindBrowserChatTranscript, never an MCP or mailbox operation. */
  readChatTranscript?(grant: OriginalBrowserGrant,
    input: Readonly<{ chatId: string; cursor?: string; limit?: number }>): Promise<unknown>;
  chatTurns?: OriginalBrowserChatTurns;
}
const noteRow = z.object({
  slug: z.string().max(2045), title: z.string().max(8192), type: z.string(),
  category: z.string().optional(), updated_at: z.string().nullish(),
});
const chatId = z.string().uuid();
const chatRow = z.object({ id: chatId, title: z.string().max(8192) });
const turnTarget = z.object({ chatId, turnId: chatId, revision: chatId });
const turnReceipt = z.object({ chatId, turnId: chatId, status: z.enum([
  "ready", "confirming", "running", "stop-requested", "completed", "cancelled", "not-sent", "unknown",
]) });
const transcriptCursor = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const transcriptPage = z.object({ chatId, start: z.number().int().safe().nonnegative(),
  total: z.number().int().safe().nonnegative(),
  messages: z.array(z.object({ id: z.string().min(1).max(512), role: z.enum(["user", "assistant"]),
    content: z.string().max(512 * 1024), status: z.enum(["complete", "streaming", "cancelled", "failed", "interrupted"]),
    recordedAt: z.string().max(100).optional() })).max(20),
  nextCursor: transcriptCursor.nullable() });
const receipt = z.object({ ok: z.literal(true), host_id: chatId, request_id: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.string(), result: z.unknown() });
const unavailable = (message: string) => new CoreError("BUSY", message, "not-committed");
const note = (row: z.infer<typeof noteRow>) => ({
  slug: row.slug, path: documentPath.parse(`${row.slug}.md`), title: row.title,
  category: row.category && !row.category.split("/").some(part => Object.hasOwn(Object.prototype, part.trim())) ? row.category : "",
  type: /^[a-z0-9-]+$/.test(row.type) ? row.type : "general", updated_at: row.updated_at,
});

export async function createOriginalBrowserRoute(owner: OriginalBrowserOwner, { allowDevelopment = false } = {}) {
  const grant = Object.freeze({ ...owner.grant });
  if (!grant.actorId.trim() || !isAbsolute(grant.workspaceRoot) || realpathSync(grant.workspaceRoot) !== grant.workspaceRoot
      || !grant.generation || !owner.token ||
      grant.chatHostId !== undefined && !chatId.safeParse(grant.chatHostId).success)
    throw new Error("Invalid Original browser grant.");
  const assertCurrent = owner.assertCurrent.bind(owner), capabilityRead = owner.capabilityRead.bind(owner);
  const readChatTranscript = grant.chatHostId ? owner.readChatTranscript?.bind(owner) : undefined;
  const turns = readChatTranscript ? owner.chatTurns : undefined;
  let sending = false;
  const gate = await createBrowserReleaseGate(owner.token, false, allowDevelopment);
  if (!gate) throw new Error("Original browser bundle unavailable.");
  const root = lstatSync(grant.workspaceRoot);
  if (!root.isDirectory()) throw new Error("Invalid Original browser root.");
  const authorized = () => {
    try {
      assertCurrent(grant);
      const current = lstatSync(grant.workspaceRoot);
      return current.isDirectory() && current.dev === root.dev && current.ino === root.ino;
    }
    catch { return false; }
  };
  const noteFile = (relative: string) => {
    if (relative.split("/").includes("_assets")) throw unavailable("Original assets are not Notes.");
    const stat = lstatSync(checkedDocumentPath(grant.workspaceRoot, relative, false));
    if (!stat.isFile() || stat.nlink !== 1) throw unavailable("Original Note is not a regular unlinked document.");
    return stat;
  };
  let pending = 0;
  const readOriginal = async (input: BrowserCommand, current: () => boolean) => {
    if (pending >= 4) throw unavailable("Original browser read limit reached.");
    pending++;
    try {
      const read = async (operation: ReadOperation, args: Record<string, unknown>) => {
        if (!current()) throw unavailable("Original browser grant is no longer current.");
        let value: unknown;
        try { value = await capabilityRead(grant, { operation: `mcp.tool.${operation}`, version: 1, arguments: args }); }
        catch { throw unavailable("Original owner did not return a verified read."); }
        if (!current()) throw unavailable("Original browser grant is no longer current.");
        return value;
      };
      const chatHost = async () => {
        const host = grant.chatHostId;
        if (!host) throw unavailable("No Original Chat Host is bound to this browser grant.");
        const hosts = z.object({ ok: z.literal(true), hosts: z.array(z.object({
          host_id: chatId, workspace_paths: z.array(z.string()), operations: z.array(z.string()),
        })), truncated: z.literal(false) }).parse(await read("api_chat_capabilities", {})).hosts
          .filter(row => row.workspace_paths.includes(grant.workspaceRoot) && row.operations.includes("list") && row.operations.includes("get"));
        if (hosts.length !== 1 || hosts[0]?.host_id !== host)
          throw unavailable("The bound Original Chat Host is offline or ambiguous.");
        return host;
      };
      const chatRead = async (operation: "api_chat_list" | "api_chat_get", args: Record<string, unknown>) => {
        const host_id = await chatHost();
        const deadline = Date.now() + 5000;
        let value = receipt.parse(await read(operation, { ...args, host_id, command_id: randomUUID() }));
        const request_id = value.request_id;
        for (;;) {
          if (value.host_id !== host_id || value.request_id !== request_id) break;
          if (value.status === "succeeded") return value.result;
          if (!["queued", "running"].includes(value.status) || Date.now() >= deadline) break;
          await new Promise(resolve => setTimeout(resolve, 125));
          value = receipt.parse(await read("api_chat_request_get", { host_id, request_id }));
        }
        throw unavailable("Original Chat read did not return a verified receipt.");
      };
      switch (input.command) {
        case "list": {
          if (!input.q) {
            const page = z.object({ schema: z.literal("pkm.note-inventory/v1"), ok: z.literal(true), notes: z.array(noteRow).max(100),
              total: z.number().int().nonnegative() }).parse(await read("list_notes", { limit: 100 }));
            return { items: page.notes.map(note), total: page.total };
          }
          if (input.caseSensitive) throw unavailable("Original lexical Note search is not case-sensitive.");
          const hits = z.array(noteRow).max(100).parse(await read("search_notes", { query: input.q, limit: 100 }));
          const items = hits.map(row => note({ category: row.slug.split("/").slice(0, -1).join("/"), ...row }));
          for (const item of items) noteFile(item.path);
          return { items, total: hits.length };
        }
        case "detail": {
          if (!/\.md$/i.test(input.path)) throw unavailable("Original Note reads require a Markdown path.");
          const before = noteFile(input.path);
          const slug = input.path.slice(0, -3);
          const row = noteRow.extend({ content: z.string().max(400_000), tags: z.array(z.string()).optional() })
            .parse(await read("get_note", { slug }));
          const after = noteFile(input.path);
          if (row.slug !== slug || before.dev !== after.dev || before.ino !== after.ino ||
              before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
            throw unavailable("Original Note identity or content changed while reading.");
          const item = note(row);
          return { ...item, note_type: item.type, type: "note", documentKind: "markdown",
            content: row.content, tags: JSON.stringify(row.tags ?? []), editPin: null };
        }
        case "chatCapabilities":
          return { history: false, nativeTranscript: !!readChatTranscript, latestReply: !!grant.chatHostId && !readChatTranscript,
            nativeTurns: !!turns, create: false, send: false, stop: false, review: false };
        case "originalChatTarget":
        case "originalChatSend":
        case "originalChatStatus":
        case "originalChatStop": {
          if (!turns || !current()) throw unavailable("Original Chat turn controls are unavailable.");
          const mutation = input.command === "originalChatSend" || input.command === "originalChatStop";
          const send = input.command === "originalChatSend";
          if (send && sending) throw unavailable("Another browser send is in progress.");
          if (send) sending = true;
          try {
            if (input.command === "originalChatTarget") {
              const target = turnTarget.parse(await turns.getSendTarget(grant, { chatId: input.chatId }));
              if (!current() || target.chatId !== input.chatId) throw Error();
              return target;
            }
            const ref = { chatId: input.chatId, turnId: input.turnId };
            const receipt = turnReceipt.parse(await (input.command === "originalChatSend"
              ? turns.sendChatTurn(grant, { ...ref, revision: input.revision, text: input.text })
              : input.command === "originalChatStop" ? turns.stopChatTurn(grant, ref) : turns.getChatTurn(grant, ref)));
            if (!current() || receipt.chatId !== ref.chatId || receipt.turnId !== ref.turnId) throw Error();
            return receipt;
          } catch {
            if (mutation) throw new CoreError("BUSY", "Outcome not confirmed. Check this turn; do not resend.", "unknown");
            throw unavailable("The owning PKM Chat could not verify this turn or send target.");
          } finally { if (send) sending = false; }
        }
        case "chatMessages": {
          if (!readChatTranscript || !current()) throw unavailable("Original Chat transcript sharing is unavailable.");
          const id = chatId.parse(input.id);
          const cursor = input.cursor === undefined ? undefined : transcriptCursor.parse(input.cursor);
          let result;
          try { result = await readChatTranscript(grant, { chatId: id, cursor, limit: 20 }); }
          catch { throw unavailable("The owning PKM Chat did not share this transcript page."); }
          if (!current()) throw unavailable("Original browser grant is no longer current.");
          const page = transcriptPage.parse(result);
          const end = page.start + page.messages.length;
          if (page.chatId !== id || (!cursor ? page.start !== 0 : page.start === 0)
              || end > page.total || (page.nextCursor !== null) !== (end < page.total)
              || page.nextCursor !== null && (!page.messages.length || page.nextCursor === cursor)
              || Buffer.byteLength(JSON.stringify(page.messages)) > 512 * 1024 + 2)
            throw unavailable("The owning PKM Chat returned an invalid transcript page.");
          return page;
        }
        case "chatList": {
          if (input.cursor !== undefined && !/^(?:0|[1-9]\d{0,7})$/.test(input.cursor))
            throw unavailable("Invalid Original Chat page.");
          const page = z.object({ chats: z.array(chatRow).max(100), nextOffset: z.number().int().safe().nonnegative().nullable() })
            .parse(await chatRead("api_chat_list", { offset: Number(input.cursor ?? 0), limit: 100 }));
          return { items: page.chats, nextCursor: page.nextOffset === null ? null : String(page.nextOffset) };
        }
        case "chatGet": {
          if (readChatTranscript) throw unavailable("Request the transcript from the owning PKM Chat.");
          const id = chatId.parse(input.id);
          const result = z.object({ chatId, title: z.string().max(8192), status: z.string().max(100),
            reply: z.object({ status: z.string().max(100), content: z.string().max(16_000), truncated: z.boolean() }).nullable(),
          }).parse(await chatRead("api_chat_get", { chat_id: id }));
          if (result.chatId !== id) throw unavailable("Original Chat identity did not match the requested conversation.");
          return { id, title: result.title, status: result.status, latestReply: result.reply };
        }
        default: throw unavailable("This operation is not available from the Original browser owner.");
      }
    } catch (error) {
      // Do not return gateway diagnostics or validation paths (they may contain Original data).
      if (error instanceof CoreError) throw error;
      throw unavailable("Original owner did not return the expected browser read.");
    } finally { pending--; }
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== "/webview" && !req.url?.startsWith("/webview/")) return false;
    const host = `127.0.0.1:${req.socket.localPort}`;
    if (req.socket.localAddress !== "127.0.0.1" || req.socket.remoteAddress !== "127.0.0.1" ||
        req.headers.host !== host || req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) {
      res.writeHead(403, { "Cache-Control": "no-store" }).end();
      return true;
    }
    return gate(req, res, { accepting: authorized, authorized, readOriginal });
  };
}
