import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import type { ApiConversation, ApiChatStatus, ChatMessage } from "./api-chat-store";

const segmentBytes = 1024 * 1024;
const indexPageSize = 64;
const inlineBytes = 512 * 1024;
interface MessageReference { id: string; bytes: number; parts: string[]; }
interface HistoryReference {
  schema: "pkm.chat.history/v1";
  messageCount: number;
  summary: { status: ApiChatStatus; workerManager: boolean };
  pages: Array<{ digest: string; count: number }>;
}
export type StoredChat = Omit<ApiConversation, "version"> & { version: 1 | 2; messageHistory?: HistoryReference };

export class ChatHistoryStorage {
  constructor(private readonly stateDirectory: string) {}

  private directory(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid segmented Chat identity.");
    const directory = path.join(this.stateDirectory, "api-chat-history", id);
    if (fs.existsSync(directory) && (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory())) throw new Error("Invalid Chat history segment directory.");
    return directory;
  }

  private file(id: string, digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid Chat history segment digest.");
    return path.join(this.directory(id), `${digest}.bin`);
  }

  private read(id: string, digest: string): Buffer {
    const file = this.file(id, digest);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > segmentBytes) throw new Error("Invalid Chat history segment size or file.");
    const bytes = fs.readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("Chat history segment integrity check failed.");
    return bytes;
  }

  private put(id: string, bytes: Buffer): string {
    if (bytes.length > segmentBytes) throw new Error("Chat history segment exceeds its individual size limit.");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const file = this.file(id, digest);
    if (fs.existsSync(file)) {
      this.read(id, digest);
      return digest;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Completed Tasks and worker archives can reference an earlier immutable snapshot.
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return digest;
  }

  pack(chat: ApiConversation, summary: HistoryReference["summary"]): StoredChat {
    const encoded = chat.messages.map(message => Buffer.from(JSON.stringify(message), "utf8"));
    if (encoded.reduce((total, bytes) => total + bytes.length, 0) <= inlineBytes) return chat;
    const entries = encoded.map((bytes, index): MessageReference => {
      const parts: string[] = [];
      for (let start = 0; start < bytes.length; start += segmentBytes) parts.push(this.put(chat.id, bytes.subarray(start, start + segmentBytes)));
      return { id: chat.messages[index].id, bytes: bytes.length, parts };
    });
    const pages: HistoryReference["pages"] = [];
    for (let start = 0; start < entries.length; start += indexPageSize) {
      const page = entries.slice(start, start + indexPageSize);
      pages.push({ digest: this.put(chat.id, Buffer.from(JSON.stringify(page), "utf8")), count: page.length });
    }
    return { ...chat, version: 2, messages: [], messageHistory: { schema: "pkm.chat.history/v1", messageCount: entries.length, summary, pages } };
  }

  private reference(chat: StoredChat): HistoryReference | undefined {
    const history = chat.messageHistory;
    if (history === undefined) {
      if (chat.version !== 1) throw new Error("Unsupported Chat history storage version.");
      return undefined;
    }
    if (chat.version !== 2 || !history || history.schema !== "pkm.chat.history/v1" || !Array.isArray(chat.messages) || chat.messages.length
      || !Number.isSafeInteger(history.messageCount) || history.messageCount < 1 || !Array.isArray(history.pages)
      || !history.summary || !["running", "idle", "completed", "new-result", "awaiting-input", "awaiting-result", "paused", "failed", "stopped"].includes(history.summary.status)
      || typeof history.summary.workerManager !== "boolean"
      || history.pages.some(page => !page || !/^[a-f0-9]{64}$/.test(page.digest) || !Number.isSafeInteger(page.count) || page.count < 1 || page.count > indexPageSize)
      || history.pages.reduce((count, page) => count + page.count, 0) !== history.messageCount) throw new Error("Invalid segmented Chat history index.");
    return history;
  }

  summary(chat: StoredChat): HistoryReference["summary"] | undefined {
    return this.reference(chat)?.summary;
  }

  remove(id: string): void {
    const directory = this.directory(id);
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) {
      if (/^[a-f0-9]{64}\.bin$/.test(name)) fs.unlinkSync(path.join(directory, name));
    }
    if (!fs.readdirSync(directory).length) fs.rmdirSync(directory);
  }

  messages(chat: StoredChat, start = 0, end?: number): ChatMessage[] {
    const history = this.reference(chat);
    const count = history?.messageCount ?? chat.messages.length;
    end ??= count;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > count) throw new Error("Invalid Chat history page range.");
    if (!history) return chat.messages.slice(start, end);
    const messages: ChatMessage[] = [];
    let offset = 0;
    for (const page of history.pages) {
      if (offset < end && offset + page.count > start) {
        const entries: MessageReference[] = JSON.parse(this.read(chat.id, page.digest).toString("utf8"));
        if (!Array.isArray(entries) || entries.length !== page.count) throw new Error("Invalid Chat history index page.");
        for (const entry of entries.slice(Math.max(0, start - offset), Math.min(page.count, end - offset))) {
          if (!entry || typeof entry.id !== "string" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || !Array.isArray(entry.parts)
            || entry.parts.length !== Math.ceil(entry.bytes / segmentBytes)) throw new Error("Invalid Chat message segment reference.");
          const bytes = Buffer.concat(entry.parts.map(digest => this.read(chat.id, digest)));
          if (bytes.length !== entry.bytes) throw new Error("Chat message segment length does not match its index.");
          const message: ChatMessage = JSON.parse(bytes.toString("utf8"));
          if (!message || message.id !== entry.id) throw new Error("Chat message identity does not match its index.");
          messages.push(message);
        }
      }
      offset += page.count;
      if (offset >= end) break;
    }
    return messages;
  }

  unpack(chat: StoredChat): ApiConversation {
    if (!this.reference(chat)) return { ...chat, version: 1 };
    const { messageHistory, ...metadata } = chat;
    return { ...metadata, version: 1, messages: this.messages(chat) };
  }
}
