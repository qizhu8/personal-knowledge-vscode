import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Storage } from "./storage.js";
import { legacyApiChatBlocked as fail, validateLegacyApiChatImages } from "./legacy-api-chat-archive.js";
import { readLegacyChatSource, type LegacyChatSource } from "./legacy-api-chat-source.js";
import type { LegacyApiChatIdentity, LegacyApiChatContinue } from "./legacy-api-chat-runtime.js";
import { ChatTurnStore, type ChatTurnPersistentStore } from "./chat-turn-store.js";
import { ChatTurnService, ChatTurnToolError, type ChatTurnModelPort, type ChatTurnToolPort } from "./chat-turn.js";
import { chatTurnTerminal, type ChatTurnRecord } from "./chat-turn-contracts.js";
import { nativeApiChatTaskControl, type NativeApiChatTaskControl, type NativeApiChatTaskState } from "./legacy-api-chat-task-control.js";
import { nativeApiChatQueueInput, nativeApiChatReviewInput, nativeQueueNewTask, nativeQueueStop,
  type NativeApiChatQueueInput, type NativeApiChatQueueState, type NativeApiChatReviewInput } from "./legacy-api-chat-workflow.js";

type Json = Record<string, any>;
export interface LegacyManagedChatBinding extends LegacyApiChatIdentity {
  root: string; workspaceId: string; actorId: string; sourceFingerprint: string; sourceSessionId?: string;
  taskSessionId?: string;
  casual?: true;
  turnId: string; inputId: string;
  parentTurnId?: string;
  title?: string;
}
export interface LegacyManagedChatRuntimeOptions {
  storage: Storage; actorId: string; model: ChatTurnModelPort;
  chatSource?: LegacyChatSource;
  authorize(binding: LegacyManagedChatBinding & {
    operation: "history" | "start" | "tool" | "control"; tool?: string; control?: NativeApiChatTaskControl["kind"];
  }): Promise<boolean>;
  tools: {
    readonly available: boolean;
    execute(request: Parameters<ChatTurnToolPort["execute"]>[0] & { binding: LegacyManagedChatBinding }):
      ReturnType<ChatTurnToolPort["execute"]>;
  };
  authorizeQueue?: (binding: LegacyManagedChatBinding & { kind: NativeApiChatQueueInput["kind"] }) => Promise<boolean>;
  authorizeUserReview?: (binding: LegacyManagedChatBinding & NativeApiChatReviewInput & { userRequired: true }) => Promise<boolean>;
  memoryContext?: (binding: LegacyManagedChatBinding, request: Parameters<ChatTurnModelPort["stream"]>[0]) =>
    Promise<{ messages: Parameters<ChatTurnModelPort["stream"]>[0]["messages"]; assertCurrent(): void }>;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const turnScope = (binding: LegacyManagedChatBinding) => binding.taskSessionId
  ?? `chat_scope_${hash([binding.actorId, binding.workspaceId, binding.namespace, binding.chatId]).slice(0, 32)}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function modelFailureMessage(failure: string | null): string | undefined {
  if (!failure) return undefined;
  const guidance: Record<string, string> = {
    MODEL_INVALID_REQUEST: "Check the selected model request and configuration.",
    MODEL_AUTHENTICATION: "Check the selected model credentials or VS Code permission.",
    MODEL_CONFIGURATION_UNAVAILABLE: "Check the selected model configuration.",
    MODEL_PROVIDER_UNAVAILABLE: "The selected model provider is unavailable.",
    MODEL_CONTEXT_BUDGET: "The selected model context budget was exceeded.",
    MODEL_OUTPUT_BUDGET: "The selected model output budget was exceeded.",
    MODEL_INVALID_STREAM: "The selected model returned an invalid response stream.",
    MODEL_INVALID_TOOL: "The selected model returned an invalid tool call.",
    MODEL_CANCELLED: "The selected model request was cancelled.",
    MODEL_TIMEOUT: "The selected model request timed out.",
    MODEL_RATE_LIMITED: "The selected model provider rate-limited the request.",
    MODEL_PROVIDER_ERROR: "The selected model provider rejected the request.",
    MODEL_TRANSPORT_ERROR: "The selected model connection failed.",
  };
  if (!Object.hasOwn(guidance, failure)) return undefined;
  return `Model request failed (${failure}). ${guidance[failure]}`;
}

/** Separate native turn authority. Original Sessions, worker grants, PIDs and queued inputs are never executed. */
export class LegacyManagedApiChatRuntime {
  private readonly db: DatabaseSync;
  private readonly turns: ChatTurnService;
  private readonly actor: string;
  private readonly turnStore: ChatTurnStore;
  private closing = false;
  private closeTask?: Promise<void>;
  private draining = new Set<string>();
  private readonly instanceId = randomUUID();
  private closed = false;
  constructor(private readonly options: LegacyManagedChatRuntimeOptions) {
    if (!options.actorId || Buffer.byteLength(options.actorId) > 200) fail("Fresh managed Chat actor required.");
    this.actor = `legacy-managed:${options.actorId}`;
    options.storage.assertWorkspaceLease();
    this.db = options.storage.connectNative();
    try {
      this.transaction(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS legacy_managed_chat_owner(actor TEXT PRIMARY KEY,owner_id TEXT NOT NULL,
          fence INTEGER NOT NULL,instance_id TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS legacy_managed_chat_bindings(actor TEXT NOT NULL,turn_id TEXT NOT NULL,
            namespace TEXT NOT NULL,chat_id TEXT NOT NULL,source_fingerprint TEXT NOT NULL,request_hash TEXT NOT NULL,
            request_json TEXT NOT NULL,binding_json TEXT NOT NULL,PRIMARY KEY(actor,turn_id));
          CREATE TABLE IF NOT EXISTS legacy_managed_chat_receipts(actor TEXT NOT NULL,operation_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL,PRIMARY KEY(actor,operation_id));
          CREATE TABLE IF NOT EXISTS legacy_managed_chat_task_state(actor TEXT NOT NULL,namespace TEXT NOT NULL,
            chat_id TEXT NOT NULL,state_json TEXT NOT NULL,PRIMARY KEY(actor,namespace,chat_id));
          CREATE TABLE IF NOT EXISTS legacy_managed_chat_task_operations(actor TEXT NOT NULL,operation_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(actor,operation_id));
          CREATE TABLE IF NOT EXISTS legacy_managed_chat_queue(actor TEXT NOT NULL,namespace TEXT NOT NULL,chat_id TEXT NOT NULL,
            state_json TEXT NOT NULL,PRIMARY KEY(actor,namespace,chat_id));
          CREATE TABLE IF NOT EXISTS legacy_managed_chat_workflow_operations(actor TEXT NOT NULL,operation_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(actor,operation_id));
          CREATE TABLE IF NOT EXISTS legacy_managed_chat_reviews(actor TEXT NOT NULL,turn_id TEXT NOT NULL,signature TEXT NOT NULL,
            decision_json TEXT NOT NULL,PRIMARY KEY(actor,turn_id,signature));`);
        const lease = options.storage.workspaceLease();
        const prior = this.db.prepare("SELECT * FROM legacy_managed_chat_owner WHERE actor=?").get(this.actor);
        if (prior?.owner_id === lease.ownerId && prior.fence === lease.fence)
          fail("This fresh managed Chat actor already has an exclusive runtime.");
        this.db.prepare("INSERT OR REPLACE INTO legacy_managed_chat_owner VALUES(?,?,?,?)")
          .run(this.actor, lease.ownerId, lease.fence, this.instanceId);
      });
      const store = new ChatTurnStore(this.db, { receipt: receipt => {
        this.db.prepare("INSERT INTO legacy_managed_chat_receipts VALUES(?,?,?)")
          .run(receipt.actor, receipt.operationId, receipt.fingerprint);
      } });
      this.turnStore = store;
      this.transaction(() => store.initialize());
      const scoped: ChatTurnPersistentStore = {
        get: (...args) => store.get(...args), create: (...args) => store.create(...args),
        change: (...args) => store.change(...args), events: (...args) => store.events(...args),
        interrupted: () => store.interrupted().filter(turn => turn.actor === this.actor),
      };
      this.turns = new ChatTurnService({
        store: scoped, transaction: work => this.transaction(work),
        model: { available: options.model.available, stream: request => this.modelStream(request) },
        admitPrompt: (_actor, turnId) => this.assertSource(this.binding(turnId)),
        preparePrompt: (_actor, turnId) => this.applySteering(turnId),
        tools: { available: options.tools.available, execute: async request => {
          const binding = this.binding(request.turnId);
          await this.authorized(binding, "tool", request.call.name);
          if (request.signal.aborted) throw new ChatTurnToolError("not-committed", "MANAGED_CHAT_TOOL_CANCELLED_BEFORE_DISPATCH");
          const result = await options.tools.execute({ ...request, binding });
          try { await this.authorized(binding, "tool", request.call.name); }
          catch { throw new ChatTurnToolError("unknown", "MANAGED_CHAT_SCOPE_CHANGED_AFTER_TOOL"); }
          return result;
        } },
      });
      this.turns.recover();
      this.transaction(() => {
        for (const row of this.db.prepare("SELECT namespace,chat_id,state_json FROM legacy_managed_chat_queue WHERE actor=?").all(this.actor)) {
          const state = JSON.parse(String(row.state_json)) as NativeApiChatQueueState;
          if (!state.needsReview && state.items.some(item => item.status === "queued")) {
            state.needsReview = true; state.revision++;
            this.saveQueue({ namespace: String(row.namespace), chatId: String(row.chat_id) }, state);
          }
        }
      });
    } catch (error) {
      try { this.transaction(() => this.db.prepare("DELETE FROM legacy_managed_chat_owner WHERE actor=? AND instance_id=?")
        .run(this.actor, this.instanceId)); } catch {}
      this.db.close(); throw error;
    }
  }
  private owner() {
    if (this.closed) fail("Managed Chat runtime is closed.");
    this.options.storage.assertWorkspaceLease();
    const lease = this.options.storage.workspaceLease();
    const current = this.db.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
    if (!current || current.owner_id !== lease.ownerId || current.fence !== lease.fence
      || Number(current.lease_until) <= Date.now()) fail("Managed Chat runtime is fenced.");
  }
  private transaction<T>(work: () => T): T {
    this.owner();
    const nested = this.db.isTransaction;
    if (!nested) this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work(); this.owner();
      if (!nested) this.db.exec("COMMIT");
      return result;
    } catch (error) { if (!nested) this.db.exec("ROLLBACK"); throw error; }
  }
  private binding(turnId: string): LegacyManagedChatBinding {
    this.owner();
    const row = this.db.prepare("SELECT binding_json FROM legacy_managed_chat_bindings WHERE actor=? AND turn_id=?")
      .get(this.actor, turnId);
    if (!row) fail("Native turn has no original Chat binding.");
    return JSON.parse(String(row.binding_json));
  }
  private assertSource(binding: LegacyManagedChatBinding) {
    this.owner();
    if (readLegacyChatSource(this.options.storage, this.options.chatSource)?.sourceFingerprint !== binding.sourceFingerprint)
      fail("Original managed Chat source changed.");
  }
  private async authorized(binding: LegacyManagedChatBinding, operation: "history" | "start" | "tool" | "control", tool?: string,
    control?: NativeApiChatTaskControl["kind"]) {
    this.assertSource(binding);
    const checkControl = () => {
      const state = this.savedTaskState(binding);
      if ((operation === "start" || operation === "tool")
        && (state?.stopped || state?.paused && !binding.parentTurnId
          || state && state.activeSessionId !== (binding.taskSessionId ?? null)))
        throw new ChatTurnToolError("not-committed", "MANAGED_CHAT_PAUSED_OR_STOPPED");
    };
    checkControl();
    if (!await this.options.authorize({ ...binding, operation, ...(tool ? { tool } : {}), ...(control ? { control } : {}) }))
      throw new ChatTurnToolError("not-committed", "MANAGED_CHAT_FRESH_AUTHORITY_DENIED");
    this.assertSource(binding);
    checkControl();
  }
  private async *modelStream(request: Parameters<ChatTurnModelPort["stream"]>[0]) {
    const binding = this.binding(request.turnId);
    await this.authorized(binding, "start");
    if (this.options.authorizeQueue && (request.beforeDispatch || this.queueState(binding, binding.sourceFingerprint).items
      .some(item => item.status === "applied" && item.attemptId === request.turnId))
      && !await this.options.authorizeQueue({ ...binding, kind: "run" }))
      throw new ChatTurnToolError("not-committed", "MANAGED_CHAT_STEER_AUTHORITY_DENIED");
    if (request.signal.aborted) throw new Error("Native Task model request was cancelled before dispatch.");
    const memory = this.options.memoryContext ? await this.options.memoryContext(binding, request) : undefined;
    await this.authorized(binding, "start");
    if (this.options.authorizeQueue && (request.beforeDispatch || this.queueState(binding, binding.sourceFingerprint).items
      .some(item => item.status === "applied" && item.attemptId === request.turnId))
      && !await this.options.authorizeQueue({ ...binding, kind: "run" }))
      throw new ChatTurnToolError("not-committed", "MANAGED_CHAT_STEER_AUTHORITY_DENIED");
    this.assertSource(binding);
    if (request.signal.aborted) throw new Error("Native Task model request was cancelled before dispatch.");
    memory?.assertCurrent();
    const row = this.db.prepare("SELECT request_json FROM legacy_managed_chat_bindings WHERE actor=? AND turn_id=?")
      .get(this.actor, request.turnId);
    const saved = row ? JSON.parse(String(row.request_json)) : undefined;
    const messages = memory ? memory.messages : request.messages;
    let images: Parameters<ChatTurnModelPort["stream"]>[0]["images"];
    if (saved?.images?.length) {
      validateLegacyApiChatImages(saved.images);
      if (!Number.isSafeInteger(saved.imageMessageIndex) || messages[saved.imageMessageIndex]?.role !== "user"
        || messages[saved.imageMessageIndex]?.content !== saved.text)
        fail("Image input no longer matches its admitted user message.");
      images = { messageIndex: saved.imageMessageIndex, items: saved.images };
    }
    if (request.beforeDispatch && this.options.model.preDispatchAdmission !== true)
      throw new ChatTurnToolError("not-committed", "MANAGED_CHAT_STEER_ADMISSION_UNAVAILABLE");
    const beforeDispatch = request.beforeDispatch && (() => {
      this.assertSource(binding);
      const state = this.savedTaskState(binding);
      if (request.signal.aborted || state?.stopped || state?.paused || state && state.activeSessionId !== (binding.taskSessionId ?? null))
        throw new ChatTurnToolError("not-committed", "MANAGED_CHAT_PAUSED_OR_STOPPED");
      memory?.assertCurrent();
      request.beforeDispatch!();
    });
    for await (const event of this.options.model.stream({ ...request, messages, beforeDispatch, ...(images ? { images } : {}) })) {
      memory?.assertCurrent();
      yield event;
    }
    await this.authorized(binding, "start");
  }
  private savedTaskState(identity: LegacyApiChatIdentity): NativeApiChatTaskState | undefined {
    const row = this.db.prepare("SELECT state_json FROM legacy_managed_chat_task_state WHERE actor=? AND namespace=? AND chat_id=?")
      .get(this.actor, identity.namespace, identity.chatId);
    return row ? JSON.parse(String(row.state_json)) : undefined;
  }
  hasTaskControl(identity: LegacyApiChatIdentity): boolean {
    this.owner();
    return !!this.savedTaskState(identity);
  }
  async controlState(identity: LegacyApiChatIdentity): Promise<NativeApiChatTaskState> {
    const { archive, chat } = await this.admitted(identity, "history", "", true);
    return clone(this.taskState(archive, chat));
  }
  private taskState(archive: any, chat: any): NativeApiChatTaskState {
    const saved = this.savedTaskState({ namespace: chat.namespace, chatId: chat.id });
    if (saved) {
      if (saved.sourceFingerprint !== archive.sourceFingerprint) fail("Task control source binding changed.");
      return saved;
    }
    const source = archive.managed?.sessions.find((session: Json) => session.sessionId === chat.metadata.sessionId);
    return { revision: 0, sourceFingerprint: archive.sourceFingerprint, activeSessionId: source?.sessionId ?? null,
      paused: chat.metadata.paused === true, stopped: false, tasks: source ? [{
        sessionId: source.sessionId, title: source.task, createdAt: source.createdAt, authority: "archive_only",
      }] : [] };
  }
  private async admitted(identity: LegacyApiChatIdentity, operation: "history" | "start", turnId = "", allowOrdinary = false) {
    this.owner();
    const archive = readLegacyChatSource(this.options.storage, this.options.chatSource);
    const chat = archive?.chats.find(chat => chat.namespace === identity.namespace && chat.id === identity.chatId);
    if (!archive || !chat || !allowOrdinary && !this.hasTaskControl(identity)
      && !chat.metadata.sessionId && !chat.metadata.workerState) fail("No supported original managed Chat.");
    const tree = archive.managed?.trees.find(tree => tree.id === chat.metadata.workerState?.treeId);
    const sourceSessionId = chat.metadata.sessionId
      ?? archive.chats.find(owner => owner.id === tree?.rootChatId)?.metadata.sessionId;
    const state = this.taskState(archive, chat);
    const binding: LegacyManagedChatBinding = { namespace: identity.namespace, chatId: identity.chatId,
      root: archive.root, workspaceId: await this.options.storage.workspaceId(), actorId: this.options.actorId,
      sourceFingerprint: archive.sourceFingerprint, ...(sourceSessionId ? { sourceSessionId } : {}),
      ...(state.activeSessionId ? { taskSessionId: state.activeSessionId } : { casual: true as const }), turnId, inputId: turnId };
    await this.authorized(binding, operation);
    if (operation === "start") {
      if (!state.activeSessionId && !this.hasTaskControl(identity)) fail("Start a managed Task before continuing.");
      if (state.paused || state.stopped) fail("Resume this paused or stopped Task before sending a fresh input.");
      if (archive.managed?.uncertainChats.includes(chat.id) && !this.sourceReviewed(archive, chat))
        fail("Original Task execution is uncertain; an explicit user-required outcome review is necessary.");
      const hasLibrary = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_api_chat_libraries'").get();
      const row = hasLibrary && this.db.prepare("SELECT state_json FROM legacy_api_chat_libraries WHERE actor_id=?").get(this.options.actorId);
      const library = row ? JSON.parse(String(row.state_json)) : archive.library;
      if (library?.placements[chat.id]?.trashedAt) fail("Restore this Chat before executing its Task.");
    }
    return { archive, chat, binding, state };
  }
  private rows(identity: LegacyApiChatIdentity, children = false): any[] {
    return this.db.prepare("SELECT * FROM legacy_managed_chat_bindings WHERE actor=? AND namespace=? AND chat_id=? ORDER BY rowid")
      .all(this.actor, identity.namespace, identity.chatId)
      .filter(row => children || !JSON.parse(String(row.binding_json)).parentTurnId);
  }
  private baseMessages(archive: any, chat: any): Json[] {
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_api_chat_sessions'").get()) {
      const row = this.db.prepare("SELECT source_fingerprint,history_json FROM legacy_api_chat_sessions WHERE actor_id=? AND namespace=? AND chat_id=?")
        .get(this.options.actorId, chat.namespace, chat.id);
      if (row) {
        if (row.source_fingerprint !== archive.sourceFingerprint) fail("Original plain transcript binding changed.");
        return JSON.parse(String(row.history_json)).messages;
      }
    }
    return chat.messages;
  }
  private queueState(identity: LegacyApiChatIdentity, sourceFingerprint: string): NativeApiChatQueueState {
    const row = this.db.prepare("SELECT state_json FROM legacy_managed_chat_queue WHERE actor=? AND namespace=? AND chat_id=?")
      .get(this.actor, identity.namespace, identity.chatId);
    const state = row ? JSON.parse(String(row.state_json)) : { revision: 0, sourceFingerprint, needsReview: false, items: [] };
    if (state.sourceFingerprint !== sourceFingerprint) fail("Queue source binding changed.");
    return state;
  }
  private saveQueue(identity: LegacyApiChatIdentity, state: NativeApiChatQueueState) {
    this.db.prepare("INSERT OR REPLACE INTO legacy_managed_chat_queue VALUES(?,?,?,?)")
      .run(this.actor, identity.namespace, identity.chatId, JSON.stringify(state));
  }
  private reviewFor(id: string, signature: string): Json | undefined {
    const row = this.db.prepare("SELECT decision_json FROM legacy_managed_chat_reviews WHERE actor=? AND turn_id=? AND signature=?")
      .get(this.actor, id, signature);
    return row ? JSON.parse(String(row.decision_json)) : undefined;
  }
  private unresolved(turn: ChatTurnRecord): boolean {
    return !chatTurnTerminal(turn.status) || (turn.uncertain || turn.status === "unknown") && !this.reviewFor(turn.id, hash(turn));
  }
  private sourceReviewed(archive: any, chat: any) {
    return this.reviewFor(`source:${chat.id}`, hash([archive.sourceFingerprint, chat.id]));
  }
  private workflowReceipt(input: { operationId: string }): Json | undefined {
    const row = this.db.prepare("SELECT fingerprint,result_json FROM legacy_managed_chat_workflow_operations WHERE actor=? AND operation_id=?")
      .get(this.actor, input.operationId);
    if (!row) return;
    const result = JSON.parse(String(row.result_json));
    if (row.fingerprint !== hash(input)) {
      const enqueue = input as Partial<NativeApiChatQueueInput>;
      if (enqueue.kind !== "enqueue" || !Number.isSafeInteger(result.revision) || result.revision < 1
        || row.fingerprint !== hash({ ...input, expectedRevision: result.revision - 1 }))
        fail("Workflow operation identity conflicts.");
    }
    return result;
  }
  private saveWorkflowReceipt(input: { operationId: string }, value: unknown) {
    this.db.prepare("INSERT INTO legacy_managed_chat_workflow_operations VALUES(?,?,?,?)")
      .run(this.actor, input.operationId, hash(input), JSON.stringify(value));
  }
  async queue(input: NativeApiChatQueueInput): Promise<NativeApiChatQueueState> {
    input = nativeApiChatQueueInput.parse(input);
    if (this.closing || !this.options.authorizeQueue) fail("Fresh queue authority is unavailable.");
    const { archive, chat, binding } = await this.admitted(input, "history", "", true);
    if (!await this.options.authorizeQueue({ ...binding, kind: input.kind })) fail("Fresh queue authority denied.");
    if (input.kind === "enqueue" && input.mode === "steer" && nativeQueueStop.test(input.text))
      await this.authorized(binding, "control", undefined, "pause");
    this.assertSource(binding);
    if (this.closing) fail("Managed Chat runtime is closing.");
    const state = this.transaction(() => {
      const replay = this.workflowReceipt(input);
      if (replay) return input.kind === "enqueue" ? clone(this.queueState(input, archive.sourceFingerprint))
        : replay as NativeApiChatQueueState;
      const state = this.queueState(input, archive.sourceFingerprint), task = this.taskState(archive, chat);
      if (state.revision !== input.expectedRevision) fail("Queue changed; reopen before editing.");
      if (!this.savedTaskState(input) && !task.activeSessionId)
        fail("This Chat has no managed execution scope.");
      if (!this.savedTaskState(input)) this.db.prepare("INSERT INTO legacy_managed_chat_task_state VALUES(?,?,?,?)")
        .run(this.actor, input.namespace, input.chatId, JSON.stringify(task));
      const queued = state.items.filter(item => item.status === "queued");
      if (input.kind === "enqueue" || input.kind === "adopt") {
        if (task.paused || task.stopped || task.activeSessionId !== input.taskSessionId)
          fail("Resume and select the exact Chat scope before queuing.");
        const source = input.kind === "adopt" ? (chat.metadata.queuedInputs ?? []).find((item: Json) => item.id === input.sourceId) : undefined;
        if (input.kind === "adopt" && (!source || state.items.some(item => item.sourceId === input.sourceId)))
          fail("Choose an original queued input that was not already imported.");
        const text = input.kind === "enqueue" ? input.text : source!.text;
        const mode = input.kind === "enqueue" ? input.mode : "task";
        const attempt = this.rows(input).map(row => this.turns.get(this.actor, row.turn_id))
          .find(turn => !chatTurnTerminal(turn.status));
        if (mode === "steer" && (nativeQueueNewTask.test(text) || !attempt
          || !["model", "tool", "approval"].includes(attempt.status) || input.kind !== "enqueue" || input.attemptId !== attempt.id))
          fail(`Steering requires the exact running attempt (${attempt?.id ?? "none"}; requested ${
            input.kind === "enqueue" ? input.attemptId ?? "none" : "none"}) and cannot declare a new task.`);
        if (state.items.some(item => item.id === input.submissionId)
          || this.db.prepare("SELECT 1 FROM legacy_managed_chat_bindings WHERE actor=? AND turn_id=?").get(this.actor, input.submissionId))
          fail("Submission identity was already used; recover its receipt instead.");
        if (queued.length >= 20 || text.length > 16000) fail("Queue limit is 20 bounded text inputs.");
        if (state.items.length >= 1000) fail("Queue audit bound reached; no earlier evidence was removed.");
        if (!queued.length && !this.rows(input, true).some(row => {
          const turn = this.turns.get(this.actor, row.turn_id);
          return chatTurnTerminal(turn.status) && this.unresolved(turn);
        }) && (!archive.managed?.uncertainChats.includes(chat.id) || this.sourceReviewed(archive, chat))) {
          state.needsReview = false;
          const previous = this.rows(input).map(row => this.turns.get(this.actor, row.turn_id)).at(-1);
          state.explicitFailureContinuationId = previous?.status === "failed" ? previous.id : undefined;
        }
        state.items.push({ id: input.submissionId, text, mode, taskSessionId: task.activeSessionId,
          ...(mode === "steer" ? { attemptId: attempt!.id } : {}),
          ...(input.kind === "adopt" ? { sourceId: input.sourceId } : {}), status: "queued" });
      } else if (input.kind === "run") {
        if (task.paused || task.stopped || queued.some(item => item.editToken))
          fail("Resume the Chat and finish queued editors before running.");
        if (queued.some(item => item.taskSessionId !== task.activeSessionId)) fail("Queue belongs to a different Task.");
        if (this.rows(input, true).some(row => this.unresolved(this.turns.get(this.actor, row.turn_id)))
          || archive.managed?.uncertainChats.includes(chat.id) && !this.sourceReviewed(archive, chat))
          fail("Review unfinished or unknown outcomes before explicitly running this queue.");
        for (const item of queued) { item.mode = "task"; }
        const previous = this.rows(input).map(row => this.turns.get(this.actor, row.turn_id)).at(-1);
        state.explicitFailureContinuationId = previous?.status === "failed" ? previous.id : undefined;
        state.needsReview = false;
      } else {
        const item = queued.find(item => item.id === input.id);
        if (!item) fail("Choose an actual queued input.");
        if (input.kind === "remove") {
          if (item.editToken) fail("Finish or cancel the queued editor before removing it.");
          item.status = "removed";
        } else {
          if (item.editToken && item.editToken !== input.token) fail("Another queued editor owns this input.");
          if (input.action === "begin") item.editToken = input.token;
          else {
            if (item.editToken !== input.token) fail("Queued editor changed; reopen before saving.");
            if (input.action === "save") {
              if (!input.text || item.mode === "steer" && nativeQueueNewTask.test(input.text)) fail("Choose a bounded valid queued message.");
              item.text = input.text;
            }
            delete item.editToken;
          }
        }
      }
      state.revision++; this.saveQueue(input, state); this.saveWorkflowReceipt(input, state); return clone(state);
    });
    this.scheduleQueueDrain(input);
    return state;
  }
  private applySteering(turnId: string) {
    const binding = this.binding(turnId);
    if (binding.parentTurnId || !this.options.authorizeQueue) return;
    return this.transaction(() => {
      const state = this.queueState(binding, binding.sourceFingerprint);
      const pending = state.items.filter(item => item.status === "queued");
      if (state.needsReview || !pending.length || pending.some(item => item.editToken || item.mode === "task")) return;
      const steering = pending.filter(item => item.attemptId === turnId && item.taskSessionId === (binding.taskSessionId ?? null));
      if (!steering.length) return;
      if (steering.some(item => nativeQueueStop.test(item.text))) {
        const saved = this.savedTaskState(binding);
        if (saved) {
          saved.paused = true; saved.revision++;
          this.db.prepare("UPDATE legacy_managed_chat_task_state SET state_json=? WHERE actor=? AND namespace=? AND chat_id=?")
            .run(JSON.stringify(saved), this.actor, binding.namespace, binding.chatId);
        }
        const current = this.turns.get(this.actor, turnId);
        this.turns.cancel(this.actor, { id: turnId, expectedRevision: current.revision, operationId: randomUUID() });
        return;
      }
      const expectedRevision = state.revision;
      const additions = steering.map(item => ({ role: "user" as const, content: item.text }));
      return { messages: additions, beforeDispatch: () => this.transaction(() => {
        const currentState = this.queueState(binding, binding.sourceFingerprint);
        if (currentState.revision !== expectedRevision || currentState.needsReview)
          fail("Steering changed while the model prompt was prepared.");
        const currentItems = currentState.items.filter(item => item.status === "queued");
        if (currentItems.some(item => item.editToken || item.mode === "task")
          || steering.some(item => !currentItems.some(candidate => candidate.id === item.id && candidate.mode === "steer"
            && candidate.attemptId === turnId && candidate.taskSessionId === (binding.taskSessionId ?? null) && candidate.text === item.text)))
          fail("Steering changed while the model prompt was prepared.");
        const turn = this.turns.get(this.actor, turnId);
        if (chatTurnTerminal(turn.status)) fail("Steering attempt has ended.");
        this.turnStore.change(this.actor, turnId, turn.revision, randomUUID(), "native-steering",
          { inputIds: steering.map(item => item.id) }, record => { record.messages.push(...additions); });
        for (const item of currentItems) if (steering.some(candidate => candidate.id === item.id)) item.status = "applied";
        currentState.revision++; this.saveQueue(binding, currentState);
      }) };
    });
  }
  private watchQueue(identity: LegacyApiChatIdentity, operationId: string) {
    if (!this.options.authorizeQueue) return;
    this.scheduleQueueDrain(identity, this.turns.settled(this.actor, operationId));
  }
  private scheduleQueueDrain(identity: LegacyApiChatIdentity, settled?: Promise<unknown>) {
    void (async () => { await settled; await this.drainQueue(identity); })().catch(() => {
      if (this.closing || this.closed) return;
      try {
        this.transaction(() => {
          const row = this.db.prepare("SELECT state_json FROM legacy_managed_chat_queue WHERE actor=? AND namespace=? AND chat_id=?")
            .get(this.actor, identity.namespace, identity.chatId);
          if (!row) return;
          const state: NativeApiChatQueueState = JSON.parse(String(row.state_json));
          if (state.needsReview || !state.items.some(item => item.status === "queued")) return;
          state.needsReview = true; state.revision++; this.saveQueue(identity, state);
        });
      } catch { /* An unavailable or fenced store cannot safely dispatch retained work. */ }
    });
  }
  private async drainQueue(identity: LegacyApiChatIdentity) {
    const key = `${identity.namespace}:${identity.chatId}`;
    if (this.closed || this.closing || !this.options.authorizeQueue || this.draining.has(key)) return;
    this.draining.add(key);
    try {
      const { archive, chat, binding } = await this.admitted(identity, "history");
      const state = this.queueState(identity, archive.sourceFingerprint), task = this.taskState(archive, chat);
      const item = state.items.find(item => item.status === "queued");
      if (!item || state.needsReview || task.paused || task.stopped || state.items.some(item => item.editToken)) return;
      const rows = this.rows(identity, true).map(row => this.turns.get(this.actor, row.turn_id));
      const previous = rows.filter(turn => !this.binding(turn.id).parentTurnId).at(-1);
      if (rows.some(turn => !chatTurnTerminal(turn.status))) return;
      if (rows.some(turn => this.unresolved(turn)) || previous?.status === "failed" && state.explicitFailureContinuationId !== previous.id
        || item.mode === "steer" || archive.managed?.uncertainChats.includes(chat.id) && !this.sourceReviewed(archive, chat)) {
        this.transaction(() => {
          const current = this.queueState(identity, archive.sourceFingerprint);
          if (!current.needsReview) { current.needsReview = true; current.revision++; this.saveQueue(identity, current); }
        });
        return;
      }
      if (!await this.options.authorizeQueue({ ...binding, kind: "run" })) fail("Fresh queue dispatch authority denied.");
      this.assertSource(binding);
      await this.startBound({ ...identity, operationId: item.id, expectedRevision: this.rows(identity).length, text: item.text }, item.id);
    } finally { this.draining.delete(key); }
  }
  async reviewSnapshot(identity: LegacyApiChatIdentity): Promise<Json> {
    const { archive, chat } = await this.admitted(identity, "history");
    const turns = this.rows(identity, true).map(row => this.turns.get(this.actor, row.turn_id));
    const unknown = turns.filter(turn => chatTurnTerminal(turn.status) && this.unresolved(turn));
    const sourceUncertain = !!archive.managed?.uncertainChats.includes(chat.id) && !this.sourceReviewed(archive, chat);
    const summary = { namespace: identity.namespace, chatId: identity.chatId,
      sourceFingerprint: archive.sourceFingerprint, task: this.taskState(archive, chat),
      sourceUncertain, turns: unknown.map(turn => ({ id: turn.id, revision: turn.revision, signature: hash(turn),
        status: turn.status, pendingTool: turn.pendingTool, failure: turn.failure })),
      sourceEffects: sourceUncertain ? {
        queuedInputs: (chat.metadata.queuedInputs ?? []).map((item: Json) => ({ id: item.id, text: item.text, mode: item.mode })),
        messages: chat.messages.filter((message: Json) => message.status === "streaming"
          || message.toolCalls?.some((call: Json) => call.status === "running")),
        controls: (archive.managed?.controls ?? []).filter((control: Json) =>
          ["queued", "running"].includes(control.status)
          && (!control.arguments?.id || control.arguments.id === chat.id)),
      } : undefined,
      active: turns.some(turn => !chatTurnTerminal(turn.status)) };
    return { ...summary, digest: hash(summary), available: !!this.options.authorizeUserReview };
  }
  async review(input: NativeApiChatReviewInput): Promise<Json> {
    input = nativeApiChatReviewInput.parse(input);
    if (!this.options.authorizeUserReview || this.closing) fail("A separate user-required outcome decision authority is unavailable.");
    const { binding, archive, chat } = await this.admitted(input, "history");
    if (!await this.options.authorizeUserReview({ ...binding, ...input, userRequired: true })) fail("User-required outcome decision denied.");
    this.assertSource(binding);
    const replay = this.workflowReceipt(input);
    if (replay) return replay;
    const snapshot = await this.reviewSnapshot(input);
    return this.transaction(() => {
      const replay = this.workflowReceipt(input);
      if (replay) return replay;
      if (snapshot.digest !== input.expectedDigest || snapshot.active || !snapshot.turns.length && !snapshot.sourceUncertain)
        fail("Outcome evidence changed or execution is still active; reopen the user review.");
      if (hash(this.taskState(archive, chat)) !== hash(snapshot.task)) fail("Task controls changed during outcome review.");
      for (const item of snapshot.turns) {
        if (hash(this.turns.get(this.actor, item.id)) !== item.signature) fail("Outcome evidence changed during review.");
      }
      const result = { ...input, userRequired: true, decidedAt: new Date().toISOString(), outcome: "still-unknown", replay: "never" };
      for (const item of snapshot.turns) this.db.prepare("INSERT INTO legacy_managed_chat_reviews VALUES(?,?,?,?)")
        .run(this.actor, item.id, item.signature, JSON.stringify(result));
      if (snapshot.sourceUncertain) this.db.prepare("INSERT INTO legacy_managed_chat_reviews VALUES(?,?,?,?)")
        .run(this.actor, `source:${chat.id}`, hash([archive.sourceFingerprint, chat.id]), JSON.stringify(result));
      const queue = this.queueState(input, archive.sourceFingerprint);
      queue.needsReview = true; queue.revision++; this.saveQueue(input, queue);
      this.saveWorkflowReceipt(input, result); return result;
    });
  }
  async history(identity: LegacyApiChatIdentity): Promise<Json> {
    const { archive, chat } = await this.admitted(identity, "history");
    const control = this.taskState(archive, chat);
    const queue = this.queueState(identity, archive.sourceFingerprint);
    const messages = clone(this.baseMessages(archive, chat)), pending: Json[] = [], nativeTurns: Json[] = [];
    for (const row of this.rows(identity)) {
      if (row.source_fingerprint !== archive.sourceFingerprint) fail("Managed native history source binding changed.");
      const turn = this.turns.get(this.actor, row.turn_id), request = JSON.parse(row.request_json);
      const turnBinding = JSON.parse(row.binding_json) as LegacyManagedChatBinding;
      const taskId = turnBinding.casual ? undefined : turnBinding.taskSessionId ?? turnBinding.sourceSessionId;
      const calls = turn.messages.flatMap(message => message.tool_calls ?? []).map(call => {
        const result = turn.messages.find(message => message.role === "tool" && message.tool_call_id === call.id);
        return { id: call.id, name: call.function.name, arguments: call.function.arguments,
          status: result ? "complete" : chatTurnTerminal(turn.status) ? "failed" : "running",
          ...(result ? { result: result.content } : turn.uncertain ? {
            result: "Outcome unknown. Original execution intent retained; never automatically replay.",
            nativeEffect: "unknown",
          } : {}) };
      });
      messages.push({ id: request.operationId, submissionId: request.operationId, role: "user", content: request.text,
        taskId, recordedAt: turn.createdAt, status: "complete", mode: "task",
        ...(request.images?.length ? { images: request.images } : {}) });
      messages.push(...queue.items.filter(item => item.status === "applied" && item.attemptId === turn.id).map(item => ({
        id: item.id, submissionId: item.id, role: "user", content: item.text, taskId, status: "complete", inputKind: "steer",
      })));
      messages.push({ id: `native-response:${turn.id}`, inputId: request.operationId, recordedAt: turn.updatedAt,
        role: "assistant", content: turn.output, taskId,
        ...(modelFailureMessage(turn.failure) ? { error: modelFailureMessage(turn.failure) } : {}),
        status: turn.status === "completed" ? "complete" : turn.status === "unknown" ? "interrupted"
          : turn.status === "cancelled" ? "cancelled" : turn.status === "failed" ? "failed" : "streaming",
        toolCalls: calls, nativeTurn: { id: turn.id, status: turn.status, replay: turn.replay, uncertain: turn.uncertain },
        progress: { attemptId: turn.id, attempt: 1, startedAt: turn.createdAt, finishedAt: chatTurnTerminal(turn.status) ? turn.updatedAt : undefined,
          status: turn.status === "completed" ? "complete" : chatTurnTerminal(turn.status) ? "failed" : "running",
          tools: calls.map(call => call.name), steps: [] } });
      nativeTurns.push({ id: turn.id, text: request.text, taskSessionId: taskId,
        status: turn.status, updatedAt: turn.updatedAt, uncertain: turn.uncertain, replay: turn.replay,
        userReview: this.reviewFor(turn.id, hash(turn)) });
      if (this.unresolved(turn))
        pending.push({ operationId: request.operationId, status: turn.uncertain || turn.status === "unknown" ? "prepared" : "running", request });
    }
    const nativeWorkers = this.rows(identity, true).filter(row => JSON.parse(row.binding_json).parentTurnId).map(row => {
      const binding = JSON.parse(row.binding_json), turn = this.turns.get(this.actor, row.turn_id);
      return { id: turn.id, parentTurnId: binding.parentTurnId, casual: binding.casual === true,
        taskSessionId: binding.casual ? undefined : binding.taskSessionId ?? binding.sourceSessionId, title: binding.title,
        status: turn.status, createdAt: turn.createdAt, updatedAt: turn.updatedAt, replay: turn.replay,
        uncertain: turn.uncertain, messages: turn.messages, output: turn.output,
        userReview: this.reviewFor(turn.id, hash(turn)) };
    });
    const sourceExecutionUncertain = archive.managed?.uncertainChats.includes(chat.id) ?? false;
    if (sourceExecutionUncertain && !this.sourceReviewed(archive, chat)) pending.push({ operationId: `source:${chat.id}`, status: "prepared" });
    const archivedWorkers = (archive.managed?.results ?? []).filter(result =>
      archive.managed!.trees.some(tree => tree.rootChatId === chat.id && tree.id === result.chat.workerState.treeId))
      .map(result => ({ chatId: result.chat.id, receiptId: result.receiptId, title: result.chat.title,
        parentChatId: result.managerChatId, status: result.chat.messages.at(-1)?.status === "complete" ? "completed" : "failed" }));
    const metadata = { ...clone(chat.metadata), sessionId: control.activeSessionId ?? undefined,
      paused: control.paused || control.stopped,
      memoryTasks: [...(chat.metadata.memoryTasks ?? []), ...control.tasks.filter(task => task.authority === "native_core")
        .map(task => ({ id: task.sessionId, title: task.title, createdAt: task.createdAt }))] };
    return { ...identity, metadata, metadataAuthority: "archive_only", taskControl: control,
      queueControl: this.options.authorizeQueue ? queue : undefined,
      archivedQueue: (chat.metadata.queuedInputs ?? []).map((item: Json) => ({ id: item.id, text: item.text, mode: item.mode,
        imported: queue.items.some(queued => queued.sourceId === item.id), authority: "archive_only" })),
      userReviewAvailable: !!this.options.authorizeUserReview, sourceUserReview: this.sourceReviewed(archive, chat),
      sourceExecutionUncertain, messages, pending, nativeTurns, nativeWorkers, archivedWorkers, revision: nativeTurns.length,
      sourceSessionId: chat.metadata.sessionId };
  }
  async control(input: NativeApiChatTaskControl): Promise<NativeApiChatTaskState> {
    input = nativeApiChatTaskControl.parse(input);
    const { archive, chat, binding } = await this.admitted(input, "history", "", true);
    await this.authorized(binding, "control", undefined, input.kind);
    return this.transaction(() => {
      const fingerprint = hash(input), receipt = this.db.prepare(
        "SELECT fingerprint,result_json FROM legacy_managed_chat_task_operations WHERE actor=? AND operation_id=?")
        .get(this.actor, input.operationId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail("Task control operation identity conflicts.");
        return JSON.parse(String(receipt.result_json));
      }
      const state = this.taskState(archive, chat);
      if (state.revision !== input.expectedRevision) fail("Task control changed; reopen before controlling this Task.");
      if (this.db.prepare("SELECT 1 FROM legacy_managed_chat_bindings WHERE actor=? AND turn_id=?").get(this.actor, input.operationId))
        fail("Task control identity already belongs to a native input.");
      if (!["pause", "cancel"].includes(input.kind)) {
        const row = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_api_chat_libraries'").get()
          && this.db.prepare("SELECT state_json FROM legacy_api_chat_libraries WHERE actor_id=?").get(this.options.actorId);
        const library = row ? JSON.parse(String(row.state_json)) : archive.library;
        if (library?.placements[chat.id]?.trashedAt) fail("Restore this Chat before changing its Task.");
      }
      const records = this.rows(input, true).map(row => this.turns.get(this.actor, row.turn_id));
      const unresolved = records.some(turn => this.unresolved(turn));
      if (input.kind === "create" || input.kind === "complete") {
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_api_chat_operations'").get()
          && this.db.prepare("SELECT 1 FROM legacy_api_chat_operations WHERE actor_id=? AND namespace=? AND chat_id=? AND status!='complete'")
            .get(this.options.actorId, input.namespace, input.chatId))
          fail("Resolve the unfinished plain Chat operation before changing Tasks.");
        if (this.queueState(input, archive.sourceFingerprint).items.some(item => item.status === "queued"))
          fail("Finish or explicitly remove queued inputs before changing Tasks.");
        if (unresolved || archive.managed?.uncertainChats.includes(chat.id) && !this.sourceReviewed(archive, chat))
          fail("Resolve the unfinished or uncertain Task outcome before changing Tasks.");
        if (input.kind === "create") {
          if (state.activeSessionId) fail("Complete the current Task before starting another Task.");
          const sessionId = `agent_session_${hash([this.actor, input.operationId]).slice(0, 32)}`;
          state.tasks.push({ sessionId, title: input.title!, createdAt: new Date().toISOString(), authority: "native_core" });
          state.activeSessionId = sessionId; state.paused = false; state.stopped = false;
        } else {
          const task = state.tasks.find(task => task.sessionId === state.activeSessionId);
          if (!task) fail("This Chat has no active Task.");
          const source = archive.managed?.sessions.find(session => session.sessionId === task.sessionId);
          if (source && !["completed", "stopped"].includes(source.status)
            && (source.todos.some((todo: Json) => !["succeeded", "skipped"].includes(todo.status)) || source.recipeRunIds.length))
            fail("Resolve original Todos and Recipes before completing this Task.");
          task.completedAt = new Date().toISOString(); state.activeSessionId = null;
        }
      } else {
        if (!state.activeSessionId && !this.savedTaskState(input)) fail("This Chat has no managed execution scope.");
        state.paused = input.kind === "pause";
        state.stopped = !!state.activeSessionId && input.kind === "cancel";
      }
      state.revision++;
      this.db.prepare("INSERT OR REPLACE INTO legacy_managed_chat_task_state VALUES(?,?,?,?)")
        .run(this.actor, input.namespace, input.chatId, JSON.stringify(state));
      if (input.kind === "pause" || input.kind === "cancel") {
        const queue = this.queueState(input, archive.sourceFingerprint);
        queue.needsReview = true; queue.revision++; this.saveQueue(input, queue);
        for (const turn of records.filter(turn => !chatTurnTerminal(turn.status)
          && (input.kind === "cancel" || !this.binding(turn.id).parentTurnId))) {
          const digest = hash([input.operationId, turn.id]);
          const operationId = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
          this.turns.cancel(this.actor, { id: turn.id, operationId, expectedRevision: turn.revision });
        }
      }
      this.db.prepare("INSERT INTO legacy_managed_chat_task_operations VALUES(?,?,?,?)")
        .run(this.actor, input.operationId, fingerprint, JSON.stringify(state));
      return clone(state);
    });
  }
  async start(input: LegacyApiChatContinue): Promise<ChatTurnRecord> { return this.startBound(input); }
  private async startBound(input: LegacyApiChatContinue, queuedId?: string): Promise<ChatTurnRecord> {
    if (this.closing) fail("Managed Chat runtime is closing.");
    input = clone(input);
    if (!/^[a-f0-9-]{36}$/.test(input.operationId) || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 0 || typeof input.text !== "string" || !input.text.trim() || input.text.length > 16000
      || (input.images?.length ?? 0) > 2)
      fail("A bounded fresh managed Task operation is required.");
    validateLegacyApiChatImages(input.images);
    if (input.images?.length && (queuedId || this.options.model.imageInput !== true))
      fail("Images require an explicitly selected vision-capable model and a fresh Task input.");
    const { archive, chat, binding, state: admittedState } = await this.admitted(input, "start", input.operationId);
    const record = this.transaction(() => {
      if (this.closing) fail("Managed Chat runtime is closing.");
      if (!queuedId && (this.db.prepare("SELECT 1 FROM legacy_managed_chat_workflow_operations WHERE actor=? AND operation_id=?")
        .get(this.actor, input.operationId)
        || this.queueState(input, archive.sourceFingerprint).items.some(item => item.id === input.operationId)))
        fail("This operation identity belongs to a workflow receipt; never reissue it directly.");
      if (this.db.prepare("SELECT 1 FROM legacy_managed_chat_task_operations WHERE actor=? AND operation_id=?")
        .get(this.actor, input.operationId)) fail("This operation identity belongs to a Task control.");
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_api_chat_operations'").get()
        && this.db.prepare("SELECT 1 FROM legacy_api_chat_operations WHERE actor_id=? AND operation_id=?")
          .get(this.options.actorId, input.operationId))
        fail("This operation belongs to an earlier plain transcript; never reissue it through a managed Task.");
      const prior = this.db.prepare("SELECT * FROM legacy_managed_chat_bindings WHERE actor=? AND turn_id=?")
        .get(this.actor, input.operationId);
      const fingerprint = hash(input);
      if (prior) {
        if (prior.source_fingerprint !== binding.sourceFingerprint) fail("Original managed Chat source changed.");
        if (prior.request_hash !== fingerprint) fail("Managed Chat operation ID conflicts with its original request.");
        return this.turns.get(this.actor, input.operationId);
      }
      const rows = this.rows(input);
      const currentTask = this.taskState(archive, chat);
      const queue = this.queueState(input, archive.sourceFingerprint), head = queue.items.find(item => item.status === "queued");
      if (queuedId) {
        if (queue.needsReview || !head || head.id !== queuedId || head.editToken || head.taskSessionId !== currentTask.activeSessionId
          || head.text !== input.text) fail("Queued intent changed before dispatch.");
      } else if (head) fail("Run or edit the existing queue before sending a fresh input.");
      if (currentTask.revision !== admittedState.revision
        || currentTask.activeSessionId !== (binding.taskSessionId ?? null) || currentTask.paused || currentTask.stopped)
        fail("Task selection or control changed before dispatch; reopen before sending.");
      if (rows.length !== input.expectedRevision) fail("Managed Chat changed; reopen before continuing.");
      if (this.rows(input, true).some(row => {
        const turn = this.turns.get(this.actor, row.turn_id);
        return this.unresolved(turn);
      })) fail("An unfinished native Task outcome requires explicit review; never automatically replay.");
      const base = this.baseMessages(archive, chat);
      if (base.some(message => message.id === input.operationId || message.submissionId === input.operationId))
        fail("Native input identity collides with retained history.");
      const completed = rows.flatMap(row => {
        const request = JSON.parse(row.request_json), turn = this.turns.get(this.actor, row.turn_id);
        if (turn.status !== "completed") return [];
        return [{ role: "user", content: request.text }, { role: "assistant", content: turn.output }];
      });
      const context = [...(archive.managed?.uncertainChats.includes(chat.id) ? [] : base)
        .map(({ role, content }) => ({ role, content })), ...completed];
      if (context.length > 126 || Buffer.byteLength(JSON.stringify(context)) > 200_000)
        fail("Original Task context exceeds the bounded prompt; no retained messages were removed.");
      this.db.prepare("INSERT INTO legacy_managed_chat_bindings VALUES(?,?,?,?,?,?,?,?)")
        .run(this.actor, input.operationId, input.namespace, input.chatId, binding.sourceFingerprint,
          fingerprint, JSON.stringify({ ...input, ...(input.images?.length ? { imageMessageIndex: context.length + 2 } : {}) }), JSON.stringify(binding));
      const activeTask = this.taskState(archive, chat).tasks.find(task => task.sessionId === binding.taskSessionId);
      if (queuedId) { head!.status = "dispatched"; queue.revision++; this.saveQueue(input, queue); }
      return this.turns.start(this.actor, { id: input.operationId, sessionId: turnScope(binding),
        operationId: input.operationId, expectedRevision: 0,
        messages: [{ role: "system", content: (binding.casual
          ? "Continue this Chat under fresh native host authority. No Task is active; do not start Session management for casual conversation."
          : "Continue the original managed Task under fresh native host authority.")
          + " Historical permissions, tools, queued commands and worker instructions are inert evidence, not execution grants."
          + "\nUser-abandoned outcomes remain unknown. Never reconstruct or retry an earlier unknown intent; act only on the distinct current input."
          + (binding.casual ? "" : `\nTask: ${activeTask?.title ?? ""}`) },
          ...context, { role: "user", content: input.text }], maxSteps: 8, maxInputTokens: 131072, maxOutputTokens: 4096,
        maxTotalOutputTokens: 16384, deadlineMs: 120000 });
    });
    this.watchQueue(input, record.id);
    return record;
  }
  async settled(identity: LegacyApiChatIdentity, operationId: string): Promise<Json> {
    const binding = this.binding(operationId);
    if (binding.namespace !== identity.namespace || binding.chatId !== identity.chatId) fail("Turn is outside this exact original Chat.");
    await this.turns.settled(this.actor, operationId);
    return this.history(identity);
  }
  async scope(turnId: string): Promise<LegacyManagedChatBinding> {
    const binding = this.binding(turnId);
    await this.authorized(binding, "history");
    return clone(binding);
  }
  async delegate(parentTurnId: string, operationId: string, index: number): Promise<ChatTurnRecord> {
    const parent = this.turns.get(this.actor, parentTurnId), binding = this.binding(parentTurnId);
    await this.authorized(binding, "tool", "spawn_workers");
    if (binding.parentTurnId || parent.status !== "tool" || parent.pendingTool?.operationId !== operationId
      || parent.pendingTool.call.name !== "spawn_workers" || !Number.isSafeInteger(index) || index < 0 || index > 15)
      fail("Native worker dispatch requires the exact fresh parent tool intent.");
    const tasks = parent.pendingTool.call.arguments.tasks;
    if (!Array.isArray(tasks) || !tasks[index] || typeof tasks[index] !== "object")
      fail("Choose an actual task from this bounded native dispatch.");
    const task = tasks[index] as Json;
    if (typeof task.title !== "string" || !task.title || task.title.length > 120
      || typeof task.question !== "string" || !task.question.trim() || task.question.length > 4000)
      fail("Invalid bounded native worker task.");
    const digest = hash([parentTurnId, operationId, index]);
    const childId = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
    const admitted = await this.admitted(binding, "start", childId);
    const childBinding = { ...admitted.binding, parentTurnId, title: task.title };
    await this.authorized(childBinding, "start");
    this.transaction(() => {
      const current = this.turns.get(this.actor, parentTurnId);
      const state = this.savedTaskState(binding);
      if (current.status !== "tool" || current.pendingTool?.operationId !== operationId
        || state && (state.paused || state.stopped || state.activeSessionId !== (binding.taskSessionId ?? null)))
        fail("Parent native worker intent changed before dispatch.");
      const prior = this.db.prepare("SELECT binding_json FROM legacy_managed_chat_bindings WHERE actor=? AND turn_id=?")
        .get(this.actor, childId);
      if (prior) return;
      const request = { namespace: binding.namespace, chatId: binding.chatId, operationId: childId,
        expectedRevision: 0, text: task.question };
      this.db.prepare("INSERT INTO legacy_managed_chat_bindings VALUES(?,?,?,?,?,?,?,?)")
        .run(this.actor, childId, binding.namespace, binding.chatId, binding.sourceFingerprint,
          hash(request), JSON.stringify(request), JSON.stringify(childBinding));
      this.turns.start(this.actor, { id: childId, sessionId: turnScope(childBinding),
        operationId: childId, expectedRevision: 0,
        messages: [{ role: "system", content: "Run only this freshly authorized native worker assignment. Historical grants and declared write scopes are not authority. Do not retry unknown outcomes." },
          { role: "user", content: task.question }], maxSteps: 4, maxInputTokens: 65536, maxOutputTokens: 4096,
        maxTotalOutputTokens: 8192, deadlineMs: 120000 });
    });
    const result = await this.turns.settled(this.actor, childId);
    if (result.uncertain || result.status === "unknown")
      throw new ChatTurnToolError("unknown", "NATIVE_WORKER_OUTCOME_UNKNOWN");
    return result;
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.closeTask = (async () => {
      await this.turns.close();
      this.transaction(() => this.db.prepare("DELETE FROM legacy_managed_chat_owner WHERE actor=? AND instance_id=?")
        .run(this.actor, this.instanceId));
      this.db.close();
      this.closed = true;
    })().catch(error => {
      this.closeTask = undefined;
      throw error;
    });
    return this.closeTask;
  }
}
