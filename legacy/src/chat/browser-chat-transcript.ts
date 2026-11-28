import { createHash, randomBytes } from "node:crypto";
import type { ChatMessage } from "./api-chat-store";

export type BrowserChatGrant = Readonly<{
  actorId: string; workspaceRoot: string; generation: string; chatHostId?: string;
}>;
export type BrowserChatTranscriptRequest = Readonly<{ chatId: string; cursor?: string; limit?: number }>;

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const unavailable = () => new Error("The requested Chat is not available from this browser grant.");
const publicMessage = ({ id, role, content, status, recordedAt }: ChatMessage) =>
  ({ id, role, content, status, ...(recordedAt ? { recordedAt } : {}) });

export type BrowserChatSnapshot = { title: string; messages: readonly ChatMessage[]; revision?: string };

export function browserChatSnapshotDigest(chat: BrowserChatSnapshot): string {
  const hash = createHash("sha256").update(JSON.stringify([chat.title, chat.revision]));
  for (const message of chat.messages) hash.update(JSON.stringify(publicMessage(message)));
  return hash.digest("hex");
}

export function createBrowserChatTranscriptReader(grant: BrowserChatGrant, authority: {
  assertCurrent(grant: BrowserChatGrant): void;
  load(grant: BrowserChatGrant, chatId: string): Promise<BrowserChatSnapshot>;
} & ({ confirm(title: string, chatId: string): Promise<boolean> } |
  { assertConsented(chatId: string, snapshot: string): string })) {
  const pinned = Object.freeze({ ...grant });
  if (!pinned.chatHostId || !uuid.test(pinned.chatHostId)) throw unavailable();
  const cursors = new Map<string, { chatId: string; snapshot: string; consentId?: string; offset: number; expires: number }>();
  const current = (supplied: BrowserChatGrant) => {
    if (supplied.actorId !== pinned.actorId || supplied.workspaceRoot !== pinned.workspaceRoot ||
        supplied.generation !== pinned.generation || supplied.chatHostId !== pinned.chatHostId) throw unavailable();
    authority.assertCurrent(pinned);
  };
  let prompting = false;
  return async (supplied: BrowserChatGrant, input: BrowserChatTranscriptRequest) => {
    current(supplied);
    const { chatId, cursor, limit = 20 } = input;
    if (!uuid.test(chatId) || !Number.isInteger(limit) || limit < 1 || limit > 20 ||
        cursor !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(cursor)) throw unavailable();
    for (const [token, page] of cursors) if (page.expires <= Date.now()) cursors.delete(token);
    const previous = cursor === undefined ? undefined : cursors.get(cursor);
    if (cursor !== undefined && previous?.chatId !== chatId) throw unavailable();
    const read = async () => {
      try { return await authority.load(pinned, chatId); }
      catch { throw unavailable(); }
    };
    let chat = await read();
    current(supplied);
    const snapshot = browserChatSnapshotDigest(chat);
    const consentId = "assertConsented" in authority ? authority.assertConsented(chatId, snapshot) : undefined;
    if (previous) {
      if (previous.snapshot !== snapshot || previous.consentId !== consentId || previous.expires <= Date.now()) throw unavailable();
    } else if ("confirm" in authority) {
      if (prompting) throw unavailable();
      prompting = true;
      try { if (!await authority.confirm(chat.title, chatId)) throw unavailable(); }
      finally { prompting = false; }
      current(supplied);
      chat = await read();
      if (browserChatSnapshotDigest(chat) !== snapshot) throw unavailable();
    }
    current(supplied);
    const start = previous?.offset ?? 0;
    let bytes = 0;
    const messages: ReturnType<typeof publicMessage>[] = [];
    for (const message of chat.messages.slice(start, start + limit)) {
      const item = publicMessage(message);
      const size = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (bytes + size > 512 * 1024) {
        if (!messages.length) throw new Error("A Chat message exceeds the browser transcript page limit; open PKM Chat to read it.");
        break;
      }
      bytes += size;
      messages.push(item);
    }
    let nextCursor: string | null = null;
    if (start + messages.length < chat.messages.length) {
      nextCursor = randomBytes(32).toString("base64url");
      if (cursors.size >= 32) cursors.delete(cursors.keys().next().value!);
      cursors.set(nextCursor, { chatId, snapshot, consentId, offset: start + messages.length,
        expires: previous?.expires ?? Date.now() + 120_000 });
    }
    return { chatId, start, total: chat.messages.length, messages, nextCursor };
  };
}
