import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Storage } from "./storage.js";
import { legacyApiChatBlocked as fail, validateLegacyApiChatImages } from "./legacy-api-chat-archive.js";
import { readLegacyChatSource, type LegacyChatSource } from "./legacy-api-chat-source.js";
import { nativeApiChatLibraryInput, validateLegacyApiChatLibrary, type LegacyApiChatLibrary,
  type NativeApiChatLibraryInput } from "./legacy-api-chat-library.js";

type Json = Record<string, any>;
export interface LegacyApiChatIdentity { namespace: string; chatId: string }
export interface LegacyApiChatContinue extends LegacyApiChatIdentity {
  operationId: string; expectedRevision: number; text: string; images?: Json[];
}
export interface LegacyApiChatRuntimeOptions {
  storage: Storage; actorId: string;
  chatSource?: LegacyChatSource;
  authorize(binding: LegacyApiChatIdentity & { root: string; workspaceId: string; actorId: string;
    sourceFingerprint: string; operation: "history" | "continue" }): Promise<boolean>;
  provider(messages: Array<{ role: "user" | "assistant"; content: string; images?: Json[] }>, signal: AbortSignal): Promise<string>;
  libraryChatIds?: readonly string[];
  authorizeLibrary?: (binding: { root: string; workspaceId: string; actorId: string;
    sourceFingerprint: string; operation: "read" | "write" }) => Promise<boolean>;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Explicit native-only host. No legacy provider, permission, tool, queue or Session authority is inherited. */
export class LegacyApiChatRuntime {
  private readonly database: DatabaseSync;
  private closed = false;
  private admitting = true;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();
  private stopping?: Promise<void>;
  constructor(private readonly options: LegacyApiChatRuntimeOptions) {
    if (!options.actorId || options.actorId.length > 500) fail("A fresh native actor is required.");
    options.storage.assertWorkspaceLease();
    this.database = options.storage.connectNative();
    try { this.transaction(() => {
      this.database.exec(`CREATE TABLE IF NOT EXISTS legacy_api_chat_schema(version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS legacy_api_chat_sessions(actor_id TEXT NOT NULL,namespace TEXT NOT NULL,chat_id TEXT NOT NULL,
          source_fingerprint TEXT NOT NULL,revision INTEGER NOT NULL,history_json TEXT NOT NULL,PRIMARY KEY(actor_id,namespace,chat_id));
        CREATE TABLE IF NOT EXISTS legacy_api_chat_operations(actor_id TEXT NOT NULL,operation_id TEXT NOT NULL,
          namespace TEXT NOT NULL,chat_id TEXT NOT NULL,request_hash TEXT NOT NULL,request_json TEXT NOT NULL,
          status TEXT NOT NULL,result_json TEXT,PRIMARY KEY(actor_id,operation_id));`);
      this.database.exec(`CREATE TABLE IF NOT EXISTS legacy_api_chat_libraries(
        actor_id TEXT PRIMARY KEY,source_fingerprint TEXT NOT NULL,revision INTEGER NOT NULL,state_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS legacy_api_chat_library_operations(
          actor_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,
          PRIMARY KEY(actor_id,operation_id));`);
      const versions = this.database.prepare("SELECT version FROM legacy_api_chat_schema").all();
      if (!versions.length) this.database.prepare("INSERT INTO legacy_api_chat_schema VALUES(1)").run();
      else if (versions.length !== 1 || versions[0].version !== 1) fail("Unsupported native API Chat schema.");
    }); } catch (error) { this.database.close(); this.closed = true; throw error; }
  }
  private owner() {
    if (!this.admitting || this.closed) fail("API Chat admission is closed.");
    try {
      this.options.storage.assertWorkspaceLease();
      const lease = this.options.storage.workspaceLease();
      const owner = this.database.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
      if (!owner || owner.owner_id !== lease.ownerId || owner.fence !== lease.fence || Number(owner.lease_until) <= Date.now())
        fail("Native API Chat workspace epoch is fenced.");
    } catch (error) { this.admitting = false; this.abort.abort(); throw error; }
  }
  private transaction<T>(work: () => T): T {
    this.owner();
    this.database.exec("BEGIN IMMEDIATE");
    try { this.owner(); const result = work(); this.owner(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    if (!this.admitting || this.closed) return Promise.reject(new Error("Native API Chat admission is closed."));
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  private async admitted(identity: LegacyApiChatIdentity, operation: "history" | "continue") {
    this.owner();
    if (!/^[a-f0-9]{16}$/.test(identity.namespace) || !/^[a-f0-9-]{36}$/.test(identity.chatId)) fail("Invalid original API Chat identity.");
    const archive = readLegacyChatSource(this.options.storage, this.options.chatSource);
    const chat = archive?.chats.find(chat => chat.namespace === identity.namespace && chat.id === identity.chatId);
    if (!archive || !chat) fail("No recognized original API Chat.");
    if (operation === "continue") {
      if (chat.metadata.sessionId !== undefined || chat.metadata.workerState !== undefined || chat.metadata.workerActivity !== undefined)
        fail("Managed Task/worker continuation requires its dedicated freshly authorized native worker host; plain text continuation is forbidden.");
      const currentLibrary = this.database.prepare("SELECT state_json FROM legacy_api_chat_libraries WHERE actor_id=?")
        .get(this.options.actorId);
      const library = currentLibrary ? JSON.parse(String(currentLibrary.state_json)) : archive.library;
      if (library?.placements[identity.chatId]?.trashedAt) fail("Restore this Chat from Trash before continuing.");
    }
    const binding = { ...identity, root: archive.root, workspaceId: await this.options.storage.workspaceId(),
      actorId: this.options.actorId, sourceFingerprint: archive.sourceFingerprint, operation };
    if (!await this.options.authorize(binding)) fail("API Chat host admission denied.");
    this.owner();
    if (readLegacyChatSource(this.options.storage, this.options.chatSource)?.sourceFingerprint !== archive.sourceFingerprint)
      fail("Original API Chat changed during authorization.");
    this.transaction(() => {
      const current = this.session(identity);
      if (current && current.source_fingerprint !== archive.sourceFingerprint) fail("Original API Chat source fingerprint changed.");
      if (!current) {
        const state = JSON.stringify({ metadata: chat.metadata, messages: chat.messages });
        if (Buffer.byteLength(state) > 67_108_864) fail("Original API Chat exceeds the native 64 MiB history bound.");
        this.database.prepare("INSERT INTO legacy_api_chat_sessions VALUES(?,?,?,?,?,?)")
          .run(this.options.actorId, identity.namespace, identity.chatId, archive.sourceFingerprint, 0, state);
      }
    });
    return archive.sourceFingerprint;
  }
  private session(identity: LegacyApiChatIdentity): any {
    return this.database.prepare("SELECT * FROM legacy_api_chat_sessions WHERE actor_id=? AND namespace=? AND chat_id=?")
      .get(this.options.actorId, identity.namespace, identity.chatId);
  }
  private libraryRow(): any {
    return this.database.prepare("SELECT * FROM legacy_api_chat_libraries WHERE actor_id=?").get(this.options.actorId);
  }
  private async admittedLibrary(operation: "read" | "write") {
    this.owner();
    const archive = readLegacyChatSource(this.options.storage, this.options.chatSource);
    if (!archive || !this.options.authorizeLibrary || !await this.options.authorizeLibrary({
      root: archive.root, workspaceId: await this.options.storage.workspaceId(), actorId: this.options.actorId,
      sourceFingerprint: archive.sourceFingerprint, operation,
    })) fail("Fresh native Chat Library authority is required.");
    this.owner();
    if (readLegacyChatSource(this.options.storage, this.options.chatSource)?.sourceFingerprint !== archive.sourceFingerprint)
      fail("Original Chat Library changed during authorization.");
    this.transaction(() => {
      const current = this.libraryRow();
      if (current && current.source_fingerprint !== archive.sourceFingerprint) fail("Original Chat Library fingerprint changed.");
      if (!current) this.database.prepare("INSERT INTO legacy_api_chat_libraries VALUES(?,?,0,?)")
        .run(this.options.actorId, archive.sourceFingerprint,
          JSON.stringify(archive.library ?? { version: 1, groups: [], placements: {} }));
    });
    return archive;
  }
  library(): Promise<{ revision: number; state: LegacyApiChatLibrary }> {
    return this.queue(async () => {
      await this.admittedLibrary("read");
      const current = this.libraryRow();
      return { revision: current.revision, state: JSON.parse(current.state_json) };
    });
  }
  mutateLibrary(input: NativeApiChatLibraryInput): Promise<{ revision: number; state: LegacyApiChatLibrary }> {
    input = nativeApiChatLibraryInput.parse(clone(input));
    return this.queue(async () => {
      const archive = await this.admittedLibrary("write");
      const requestHash = hash(JSON.stringify(input));
      const owners = new Set(archive.chats.map(chat => chat.id));
      const allowed = new Set(this.options.libraryChatIds ?? [...owners]);
      return this.transaction(() => {
        const prior = this.database.prepare("SELECT * FROM legacy_api_chat_library_operations WHERE actor_id=? AND operation_id=?")
          .get(this.options.actorId, input.operationId);
        if (prior) {
          if (prior.request_hash !== requestHash) fail("Chat Library operation ID conflicts with its original request.");
          return JSON.parse(String(prior.result_json));
        }
        const current = this.libraryRow();
        if (current.revision !== input.expectedRevision) fail("Chat Library changed; reopen before editing.");
        const state = JSON.parse(current.state_json) as LegacyApiChatLibrary;
        const group = "groupId" in input ? state.groups.find(group => group.id === input.groupId) : undefined;
        if ("groupId" in input && !group && input.groupId !== "ungroup") fail("Choose an existing Chat Library group.");
        if (input.kind === "rename" || input.kind === "delete-group") {
          if (Object.entries(state.placements).some(([id, placement]) => placement.groupId === input.groupId && !allowed.has(id)))
            fail("This Chat Library group contains a Chat outside its fresh host grant.");
        }
        if ("chatId" in input && (!owners.has(input.chatId) || !allowed.has(input.chatId)))
          fail("Chat Library mutation is outside its fresh host grant.");
        if (input.kind === "create" || input.kind === "rename") {
          const name = input.name.trim(), lower = name.toLowerCase();
          if (!name || /[\u0000-\u001f\u007f]/.test(name) || ["ungroup", "trash"].includes(lower)
            || state.groups.some(item => item !== group && item.name.toLowerCase() === lower))
            fail("Choose a unique Chat Library group name of 1–120 characters.");
          if (input.kind === "create") state.groups.push({ id: `chat_group_${randomUUID().replace(/-/g, "")}`, name });
          else group!.name = name;
        } else if (input.kind === "delete-group") {
          state.groups = state.groups.filter(group => group.id !== input.groupId);
          for (const placement of Object.values(state.placements))
            if (placement.groupId === input.groupId) placement.groupId = "ungroup";
        } else if (input.kind === "move") {
          state.placements[input.chatId] = { ...state.placements[input.chatId], groupId: input.groupId };
        } else if (input.kind === "move-named") {
          const name = input.name.trim(), lower = name.toLowerCase();
          if (!name || /[\u0000-\u001f\u007f]/.test(name) || ["ungroup", "trash"].includes(lower))
            fail("Choose a valid Chat Library group name of 1–120 characters.");
          let target = state.groups.find(group => group.name.toLowerCase() === lower);
          if (!target) {
            target = { id: `chat_group_${randomUUID().replace(/-/g, "")}`, name };
            state.groups.push(target);
          }
          state.placements[input.chatId] = { ...state.placements[input.chatId], groupId: target.id };
        } else if (input.kind === "trash") {
          if (this.database.prepare("SELECT 1 FROM legacy_api_chat_operations WHERE actor_id=? AND chat_id=? AND status!='complete'")
            .get(this.options.actorId, input.chatId)) fail("Reconcile the unfinished Chat operation before moving it to Trash.");
          if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_managed_chat_bindings'").get()) {
            const turns = this.database.prepare(`SELECT t.record FROM legacy_managed_chat_bindings b
              JOIN chat_turn_records t ON t.actor=b.actor AND t.id=b.turn_id WHERE b.actor=? AND b.chat_id=?`)
              .all(`legacy-managed:${this.options.actorId}`, input.chatId);
            if (turns.some(row => {
              const turn = JSON.parse(String(row.record));
              return turn.uncertain || !["completed", "failed", "cancelled"].includes(turn.status);
            })) fail("Reconcile the unfinished native Task outcome before moving it to Trash.");
          }
          state.placements[input.chatId] = { groupId: state.placements[input.chatId]?.groupId ?? "ungroup",
            trashedAt: new Date().toISOString() };
        } else {
          const placement = state.placements[input.chatId];
          if (!placement?.trashedAt) fail("This Chat is not in Trash.");
          delete placement.trashedAt;
        }
        validateLegacyApiChatLibrary(state, owners);
        const result = { revision: current.revision + 1, state };
        this.database.prepare("UPDATE legacy_api_chat_libraries SET revision=?,state_json=? WHERE actor_id=?")
          .run(result.revision, JSON.stringify(state), this.options.actorId);
        this.database.prepare("INSERT INTO legacy_api_chat_library_operations VALUES(?,?,?,?)")
          .run(this.options.actorId, input.operationId, requestHash, JSON.stringify(result));
        return result;
      });
    });
  }
  history(identity: LegacyApiChatIdentity): Promise<Json> {
    identity = { namespace: identity.namespace, chatId: identity.chatId };
    return this.queue(async () => {
      await this.admitted(identity, "history");
      this.owner();
      const current = this.session(identity), state = JSON.parse(current.history_json);
      const pending = this.database.prepare("SELECT operation_id,status,request_json FROM legacy_api_chat_operations WHERE actor_id=? AND namespace=? AND chat_id=? AND status!='complete'")
        .all(this.options.actorId, identity.namespace, identity.chatId)
        .map(row => ({ operationId: row.operation_id, status: row.status, request: JSON.parse(String(row.request_json)) }));
      return clone({ ...identity, revision: current.revision, ...state, pending, metadataAuthority: "archive_only" });
    });
  }
  continue(input: LegacyApiChatContinue): Promise<Json> {
    input = clone(input);
    return this.queue(async () => {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.operationId) || !Number.isSafeInteger(input.expectedRevision)
        || input.expectedRevision < 0 || typeof input.text !== "string" || !input.text.trim() || input.text.length > 100_000)
        fail("Invalid bounded API Chat continuation.");
      validateLegacyApiChatImages(input.images);
      await this.admitted(input, "continue");
      if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_managed_chat_task_state'").get()
        && this.database.prepare("SELECT 1 FROM legacy_managed_chat_task_state WHERE actor=? AND namespace=? AND chat_id=?")
          .get(`legacy-managed:${this.options.actorId}`, input.namespace, input.chatId))
        fail("This Chat requires its dedicated freshly authorized native worker host after Task control.");
      const requestHash = hash(JSON.stringify({ namespace: input.namespace, chatId: input.chatId,
        expectedRevision: input.expectedRevision, text: input.text, images: input.images ?? [] }));
      const operation = () => this.database.prepare("SELECT * FROM legacy_api_chat_operations WHERE actor_id=? AND operation_id=?")
        .get(this.options.actorId, input.operationId) as any;
      let existing = operation(), request: Json;
      if (existing && existing.request_hash !== requestHash) fail("Operation ID conflicts with its original request.");
      if (existing?.status === "complete") return JSON.parse(existing.result_json);
      if (existing?.status === "prepared") fail("Provider outcome is unknown; explicit reconciliation is required, never automatic reissue.");
      if (existing && existing.status !== "result") fail("Unknown API Chat operation state.");
      const current = this.session(input), history = JSON.parse(current.history_json);
      if (current.revision !== input.expectedRevision) fail("API Chat changed; reopen before continuing.");
      if (history.messages.length > 9998) fail("API Chat transcript bound reached; no original messages were removed.");
      if (!existing) {
        request = { ...input, userId: randomUUID(), assistantId: randomUUID() };
        this.transaction(() => {
          if (this.session(input).revision !== input.expectedRevision) fail("API Chat changed before provider admission.");
          if (this.database.prepare("SELECT 1 FROM legacy_api_chat_operations WHERE actor_id=? AND namespace=? AND chat_id=? AND status!='complete'")
            .get(this.options.actorId, input.namespace, input.chatId)) fail("An unfinished operation owns this Chat; reconcile it first.");
          this.database.prepare("INSERT INTO legacy_api_chat_operations VALUES(?,?,?,?,?,?,?,NULL)")
            .run(this.options.actorId, input.operationId, input.namespace, input.chatId, requestHash, JSON.stringify(request), "prepared");
        });
        // Only transcript content/images enter the host's freshly configured provider, never legacy executable metadata.
        const providerMessages = [...history.messages, { role: "user", content: input.text, images: input.images }]
          .map(({ role, content, images }: Json) => ({ role, content, ...(images ? { images } : {}) }));
        const text = await this.options.provider(providerMessages, this.abort.signal);
        if (typeof text !== "string" || Buffer.byteLength(text) > 16_777_216) fail("Invalid bounded provider result.");
        await this.admitted(input, "continue");
        this.transaction(() => this.database.prepare("UPDATE legacy_api_chat_operations SET status='result',result_json=? WHERE actor_id=? AND operation_id=?")
          .run(JSON.stringify({ text }), this.options.actorId, input.operationId));
        existing = operation();
      }
      request = JSON.parse(existing.request_json);
      return this.publish(input, request, JSON.parse(existing.result_json).text);
    });
  }
  private publish(input: LegacyApiChatContinue, request: Json, text: string): Json {
    return this.transaction(() => {
      const session = this.session(input);
      if (session.revision !== input.expectedRevision) fail("API Chat changed before publication.");
      const history = JSON.parse(session.history_json);
      const recordedAt = new Date().toISOString();
      history.messages.push({ id: request.userId, role: "user", content: request.text, status: "complete",
        submissionId: input.operationId, recordedAt,
        ...(request.images ? { images: request.images } : {}) },
      { id: request.assistantId, role: "assistant", content: text, status: "complete", inputId: request.userId, recordedAt });
      const encoded = JSON.stringify(history);
      if (Buffer.byteLength(encoded) > 67_108_864) fail("Native API Chat history exceeds 64 MiB; source remains untouched.");
      const result = { operationId: input.operationId, chatId: input.chatId, assistantId: request.assistantId,
        text, revision: session.revision + 1 };
      this.database.prepare("UPDATE legacy_api_chat_sessions SET revision=?,history_json=? WHERE actor_id=? AND namespace=? AND chat_id=?")
        .run(result.revision, encoded, this.options.actorId, input.namespace, input.chatId);
      this.database.prepare("UPDATE legacy_api_chat_operations SET status='complete',result_json=? WHERE actor_id=? AND operation_id=?")
        .run(JSON.stringify(result), this.options.actorId, input.operationId);
      return result;
    });
  }
  drain(): Promise<void> {
    return this.stopping ??= (async () => {
      this.admitting = false; this.abort.abort();
      await this.tail;
      if (!this.closed) { this.closed = true; this.database.close(); }
    })();
  }
}
