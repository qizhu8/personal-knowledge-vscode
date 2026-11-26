import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { withCrossProcessLockSync } from "../runtime/cross-process-lock";
import { ApiChatStore } from "./api-chat-store";
import { browserChatSnapshotDigest, createBrowserChatTranscriptReader, type BrowserChatGrant } from "./browser-chat-transcript";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const unavailable = () => new Error("The requested Chat is not available from this browser grant.");
const lifetimeMs = 24 * 60 * 60 * 1000;

/**
 * Provisioned by the trusted owner, never from browser input or MCP.
 * The detached service must revalidate this exact grant independently of the
 * VS Code host heartbeat; reconnecting or replacing the grant cannot inherit consent.
 */
export interface DetachedBrowserChatAuthority {
  grant: BrowserChatGrant;
  namespace: string;
  assertCurrent(grant: BrowserChatGrant): void;
}

function bind(authority: DetachedBrowserChatAuthority) {
  const { namespace } = authority;
  const grant = Object.freeze({ ...authority.grant });
  if (!grant.actorId || !grant.generation || !grant.chatHostId || !uuid.test(grant.chatHostId) ||
      !/^[a-f0-9]{16}$/.test(namespace) || !path.isAbsolute(grant.workspaceRoot)) throw unavailable();
  const root = grant.workspaceRoot;
  const original = fs.lstatSync(root);
  if (!original.isDirectory() || fs.realpathSync(root) !== root) throw unavailable();
  const state = path.join(root, ".pkm", "state");
  const directory = path.join(state, "browser-transcript-consent");
  const store = new ApiChatStore(state, namespace);
  const current = () => {
    authority.assertCurrent(grant);
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.dev !== original.dev || stat.ino !== original.ino ||
        fs.realpathSync(root) !== root) throw unavailable();
  };
  const consentFile = (chatId: string) => {
    if (!uuid.test(chatId)) throw unavailable();
    const key = createHash("sha256").update(JSON.stringify([
      grant.actorId, root, original.dev, original.ino, namespace, grant.generation, grant.chatHostId, chatId,
    ])).digest("hex");
    return path.join(directory, `${key}.json`);
  };
  const privateDirectory = (create = false) => {
    if (fs.realpathSync(state) !== state) throw unavailable();
    if (create) {
      try { fs.mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || fs.realpathSync(directory) !== directory ||
        (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw unavailable();
  };
  const readConsent = (chatId: string) => {
    try {
      privateDirectory();
      const file = consentFile(chatId);
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 || fs.realpathSync(file) !== file ||
            (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw unavailable();
        const record = JSON.parse(fs.readFileSync(fd, "utf8"));
        if (record?.version !== 1 || record.key !== path.basename(file) || typeof record.id !== "string" || !uuid.test(record.id) ||
            typeof record.snapshot !== "string" ||
            !/^[a-f0-9]{64}$/.test(record.snapshot) || !Number.isSafeInteger(record.expiresAt)) throw unavailable();
        return { id: record.id as string, snapshot: record.snapshot as string, expiresAt: record.expiresAt as number };
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw unavailable();
    }
  };
  const liveConsent = (chatId: string) => {
    const consent = readConsent(chatId);
    if (!consent || consent.expiresAt <= Date.now()) throw unavailable();
    return consent;
  };
  const writeConsent = (file: string, snapshot: string, expiresAt: number) => {
    const id = randomUUID();
    const temp = `${file}.${id}.tmp`;
    try {
      const fd = fs.openSync(temp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ version: 1, key: path.basename(file), id, snapshot, expiresAt }));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  };
  const update = <T>(chatId: string, action: (file: string) => T): T => {
    const file = consentFile(chatId);
    privateDirectory(true);
    return withCrossProcessLockSync(`${file}.lock`, "Chat transcript consent", () => {
      current();
      privateDirectory();
      return action(file);
    });
  };
  return { grant, store, current, readConsent, liveConsent, writeConsent, update };
}

/** The detached PKM service can consume existing consent; it cannot ask for or renew consent. */
export function bindDetachedBrowserChatTranscript(authority: DetachedBrowserChatAuthority) {
  const binding = bind(authority);
  return createBrowserChatTranscriptReader(binding.grant, {
    assertCurrent: binding.current,
    async load(_grant, chatId) {
      binding.liveConsent(chatId);
      return binding.store.readBrowserTranscript(chatId);
    },
    assertConsented(chatId, snapshot) {
      const consent = binding.liveConsent(chatId);
      if (consent.snapshot !== snapshot) throw unavailable();
      return consent.id;
    },
  });
}

/** Extension-host only: the native UI must confirm before a receipt is written. */
export function bindNativeBrowserChatTranscriptConsent(authority: DetachedBrowserChatAuthority,
  confirm: (title: string, chatId: string) => Promise<boolean>) {
  const binding = bind(authority);
  const pending = new Map<string, symbol>();
  return {
    async allow(chatId: string): Promise<boolean> {
      binding.current();
      if (pending.has(chatId)) return false;
      const attempt = Symbol();
      pending.set(chatId, attempt);
      try {
        const previous = binding.readConsent(chatId)?.id;
        const chat = binding.store.readBrowserTranscript(chatId);
        const snapshot = browserChatSnapshotDigest(chat);
        if (!await confirm(chat.title, chatId) || pending.get(chatId) !== attempt) return false;
        return binding.update(chatId, file => {
          if (previous !== binding.readConsent(chatId)?.id ||
              snapshot !== browserChatSnapshotDigest(binding.store.readBrowserTranscript(chatId))) throw unavailable();
          binding.writeConsent(file, snapshot, Date.now() + lifetimeMs);
          return true;
        });
      } finally { if (pending.get(chatId) === attempt) pending.delete(chatId); }
    },
    revoke(chatId: string): void {
      binding.current();
      pending.delete(chatId);
      // Tombstone also prevents an already-open prompt in another window from restoring consent.
      binding.update(chatId, file => binding.writeConsent(file, "0".repeat(64), 0));
    },
  };
}
