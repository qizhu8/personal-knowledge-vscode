import { randomUUID } from "node:crypto";
import {
  CHAT_TURN_LIMITS, chatTurnCancelInput, chatTurnStartInput, chatTurnTerminal,
  type ChatTurnCall, type ChatTurnMessage, type ChatTurnRecord,
} from "./chat-turn-contracts.js";
import { ChatTurnError, chatTurnActor, chatTurnBytes, chatTurnDigest, type ChatTurnPersistentStore } from "./chat-turn-store.js";
import { chatToolRoundBudgetNotice } from "./domain/chat-turn-original.js";
import { estimateChatPromptTokens } from "./domain/chat-prompt-budget.js";

export type ChatTurnModelEvent =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "finish"; reason: "stop" | "tool_calls" | "length" };
export interface ChatTurnModelPort {
  readonly available: boolean;
  activity?(): number;
  readonly imageInput?: boolean;
  readonly preDispatchAdmission?: boolean;
  stream(request: {
    actor: string; turnId: string; step: number; messages: ChatTurnMessage[];
    maxOutputTokens: number; maxInputTokens: number; signal: AbortSignal;
    images?: { messageIndex: number; items: Array<{ label: string; mimeType: "image/png" | "image/jpeg"; dataBase64: string }> };
    beforeDispatch?: () => void;
  }): AsyncIterable<ChatTurnModelEvent>;
}
export interface ChatTurnToolPort {
  readonly available: boolean;
  activity?(): number;
  execute(request: {
    actor: string; turnId: string; call: ChatTurnCall; operationId: string; signal: AbortSignal;
    onApproval: (event: { executionId: string; status: "pending" | "approved" | "denied" }) => void;
  }): Promise<{ content: string; executionId: string; resultStatus?: "complete" | "failed";
    evidence?: { operation: string; operationId: string; executionId: string;
      resource?: { kind: "manager-run"; id: string } } }>;
}
export class ChatTurnToolError extends Error {
  constructor(readonly effect: "not-committed" | "committed" | "unknown", readonly code = "TOOL_FAILED") {
    super(code); this.name = "ChatTurnToolError";
  }
}
export interface ChatTurnDependencies {
  store: ChatTurnPersistentStore;
  /** Must commit synchronously, including the parent's operation receipt, before returning. */
  transaction: <T>(fn: () => T) => T;
  model?: ChatTurnModelPort;
  tools?: ChatTurnToolPort;
  now?: () => number;
  /** Host-only prompt admission, e.g. a pinned MemoryContextResult.assertCurrent. */
  admitPrompt?: (actor: string, turnId: string, messages: readonly ChatTurnMessage[]) => void;
  /** Preview host inputs; commit only after the selected model has checked its budget. */
  preparePrompt?: (actor: string, turnId: string) => void | {
    messages: ChatTurnMessage[];
    beforeDispatch(): void;
  };
}

function boundedJson(value: unknown, maximum: number) {
  const pending = [{ value, depth: 0 }], seen = new Set<object>();
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > 4096 || item.depth > 16) throw new ChatTurnError("INVALID_MODEL_EVENT");
    const current = item.value;
    if (current === null || typeof current === "boolean" || typeof current === "string") continue;
    if (typeof current === "number" && Number.isFinite(current)) continue;
    if (typeof current !== "object" || seen.has(current)
      || (!Array.isArray(current) && ![Object.prototype, null].includes(Object.getPrototypeOf(current))))
      throw new ChatTurnError("INVALID_MODEL_EVENT");
    seen.add(current);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
      if (Array.isArray(current) && key === "length") continue;
      if (!descriptor.enumerable || !("value" in descriptor)) throw new ChatTurnError("INVALID_MODEL_EVENT");
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  if (chatTurnBytes(value) > maximum) throw new ChatTurnError("BYTE_LIMIT");
}
function abortable<T>(value: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new ChatTurnError(signal.reason === "deadline" ? "DEADLINE_EXCEEDED" : "CANCELLED"));
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
const callId = (value: string) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

export class ChatTurnService {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly outstanding = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private readonly now: () => number;
  private closed = false;
  constructor(private readonly dependencies: ChatTurnDependencies) {
    this.now = dependencies.now ?? Date.now;
  }
  get available() { return this.dependencies.model?.available === true; }
  private key(actor: string, id: string) { return JSON.stringify([actor, id]); }
  private commit<T>(fn: () => T): T {
    const result = this.dependencies.transaction(fn);
    if (result && typeof (result as { then?: unknown }).then === "function") throw new ChatTurnError("ASYNC_TRANSACTION_FORBIDDEN");
    return result;
  }
  private track<T>(value: PromiseLike<T>): Promise<T> {
    const pending = Promise.resolve(value);
    this.outstanding.add(pending);
    void pending.then(() => this.outstanding.delete(pending), () => this.outstanding.delete(pending));
    return pending;
  }
  get(actor: string, id: string) { return this.dependencies.store.get(actor, id); }
  events(actor: string, id: string, after = 0, limit = 20) { return this.dependencies.store.events(actor, id, after, limit); }
  list(actor: string, sessionId: string, after?: string, limit = 20) {
    if (!this.dependencies.store.list) throw new ChatTurnError("UNSUPPORTED_OPERATION");
    return this.dependencies.store.list(actor, sessionId, after, limit);
  }
  activity() {
    return { active: Math.max(this.active.size, this.dependencies.store.interrupted().length, this.outstanding.size,
      this.dependencies.model?.activity?.() ?? 0, this.dependencies.tools?.activity?.() ?? 0),
      uncertain: this.dependencies.store.uncertain?.() ?? 0 };
  }
  start(actor: string, input: unknown): ChatTurnRecord {
    if (this.closed) throw new ChatTurnError("SERVICE_CLOSED");
    chatTurnActor(actor);
    if (!this.available) throw new ChatTurnError("PROVIDER_UNAVAILABLE");
    const parsed = chatTurnStartInput.safeParse(input);
    if (!parsed.success) throw new ChatTurnError("INVALID_INPUT");
    const created = this.commit(() => this.dependencies.store.create(actor, parsed.data));
    if (!created.replayed) {
      const controller = new AbortController();
      const key = this.key(actor, created.record.id);
      // Scheduling is native-only. Neither reads nor receipt replay can enter drive().
      const done = Promise.resolve().then(() => this.drive(actor, created.record.id, controller))
        .finally(() => this.active.delete(key));
      // Persistence errors remain observable through settled(), without an unhandled background rejection.
      void done.catch(() => undefined);
      this.active.set(key, { controller, done });
    }
    return created.record;
  }
  async settled(actor: string, id: string): Promise<ChatTurnRecord> {
    this.get(actor, id);
    await this.active.get(this.key(actor, id))?.done;
    return this.get(actor, id);
  }
  cancel(actor: string, input: unknown): ChatTurnRecord {
    chatTurnActor(actor);
    const parsed = chatTurnCancelInput.safeParse(input);
    if (!parsed.success) throw new ChatTurnError("INVALID_INPUT");
    const args = parsed.data;
    const result = this.commit(() => this.dependencies.store.change(
      actor, args.id, args.expectedRevision, args.operationId, "cancel", {}, record => {
        record.uncertain = record.pendingTool !== null;
        record.status = "cancelled"; record.failure = record.uncertain ? "CANCELLED_EFFECT_UNKNOWN" : "CANCELLED";
      },
    ));
    this.active.get(this.key(actor, args.id))?.controller.abort("cancel");
    return result;
  }
  /** Call only during exclusive native startup, before accepting requests. Never resumes a model or tool. */
  recover() {
    if (this.closed || this.active.size) throw new ChatTurnError("RECOVERY_REQUIRES_QUIESCENCE");
    return this.commit(() => this.dependencies.store.interrupted().map(value => this.dependencies.store.change(
      value.actor, value.id, value.revision, randomUUID(), "interrupted", {}, record => {
        record.status = "unknown"; record.failure = "RESTART_INTERRUPTED"; record.uncertain = true;
      },
    )));
  }
  closeAdmission(): void {
    this.closed = true;
    for (const item of this.active.values()) item.controller.abort("closed");
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closeAdmission();
    const active = [...this.active.values()];
    this.closing = Promise.resolve().then(async () => {
      await Promise.all(active.map(item => item.done));
      // Allow cooperative abort handlers to unwind without waiting for genuinely outstanding effects.
      await new Promise<void>(resolve => setImmediate(resolve));
      if (this.activity().active) throw new ChatTurnError("EFFECTS_NOT_RETIRED");
    }).catch(error => {
      if (error instanceof ChatTurnError && error.code === "EFFECTS_NOT_RETIRED") this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
  private change(actor: string, id: string, type: string, data: Record<string, unknown>,
    mutate: (record: ChatTurnRecord) => void) {
    const current = this.get(actor, id);
    return this.commit(() => this.dependencies.store.change(actor, id, current.revision, randomUUID(), type, data, mutate));
  }
  private async drive(actor: string, id: string, controller: AbortController) {
    const signal = controller.signal;
    const first = this.get(actor, id);
    if (chatTurnTerminal(first.status)) return;
    const timer = setTimeout(() => controller.abort("deadline"), Math.max(0, first.deadline - this.now()));
    let phase: "model" | "tool" = "model";
    let iterator: AsyncIterator<ChatTurnModelEvent> | undefined;
    const check = () => {
      if (signal.aborted) throw new ChatTurnError(signal.reason === "deadline" ? "DEADLINE_EXCEEDED" : "CANCELLED");
      if (this.now() >= first.deadline) throw new ChatTurnError("DEADLINE_EXCEEDED");
      if (chatTurnTerminal(this.get(actor, id).status)) throw new ChatTurnError("TURN_TERMINAL");
    };
    try {
      for (;;) {
        check();
        const prepared = this.dependencies.preparePrompt?.(actor, id);
        check();
        let current = this.get(actor, id);
        if (current.step >= current.bounds.maxSteps) throw new ChatTurnError("STEP_LIMIT");
        const budgetNotice = chatToolRoundBudgetNotice(current.step, current.bounds.maxSteps)!;
        const promptMessages = [...current.messages, ...(prepared?.messages ?? [])];
        const messages: ChatTurnMessage[] = [{ role: "system", content: budgetNotice }, ...structuredClone(promptMessages)];
        if (promptMessages.length > CHAT_TURN_LIMITS.messages || chatTurnBytes(messages) > CHAT_TURN_LIMITS.promptBytes)
          throw new ChatTurnError("PROMPT_LIMIT");
        const inputTokens = estimateChatPromptTokens(messages);
        if (inputTokens > current.bounds.maxInputTokens) throw new ChatTurnError("INPUT_TOKEN_LIMIT");
        this.dependencies.admitPrompt?.(actor, id, structuredClone(promptMessages));
        phase = "model";
        current = this.change(actor, id, "model-intent", {
          step: current.step + 1, inputTokens, budgetNotice, promptDigest: chatTurnDigest(messages),
        }, record => {
          record.status = "model"; record.step++; record.inputTokens += inputTokens;
        });
        check();
        const outputBudget = Math.min(current.bounds.maxOutputTokens, current.bounds.maxTotalOutputTokens - current.outputTokens);
        if (outputBudget < 1) throw new ChatTurnError("OUTPUT_TOKEN_LIMIT");
        iterator = this.dependencies.model!.stream({ actor, turnId: id, step: current.step, messages,
          maxOutputTokens: outputBudget, maxInputTokens: current.bounds.maxInputTokens, signal,
          ...(prepared ? { beforeDispatch: () => { check(); prepared.beforeDispatch(); } } : {}) })[Symbol.asyncIterator]();
        let text = "", finish: string | undefined, usage: { inputTokens: number; outputTokens: number } | undefined;
        let inferenceBytes = 0, conservativeOutput = 0;
        const calls: ChatTurnCall[] = [];
        const seen = new Set(current.messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? []));
        for (;;) {
          const next = await abortable(this.track(iterator.next()), signal);
          check();
          if (next.done) break;
          const event = next.value;
          boundedJson(event, CHAT_TURN_LIMITS.eventBytes - 1024);
          if (finish && event.type !== "usage") throw new ChatTurnError("EVENT_AFTER_FINISH");
          if (event.type === "text") {
            if (typeof event.text !== "string" || !event.text.length) throw new ChatTurnError("INVALID_MODEL_EVENT");
            const bytes = Buffer.byteLength(event.text);
            inferenceBytes += bytes; conservativeOutput += bytes;
            if (inferenceBytes > CHAT_TURN_LIMITS.outputBytes || conservativeOutput > outputBudget
              || this.get(actor, id).outputBytes + bytes > CHAT_TURN_LIMITS.outputBytes) throw new ChatTurnError("OUTPUT_LIMIT");
            text += event.text;
            this.change(actor, id, "text", { text: event.text }, record => {
              record.output += event.text; record.outputBytes += bytes;
            });
          } else if (event.type === "tool") {
            if (!callId(event.id) || !callId(event.name) || seen.has(event.id)
              || !event.arguments || Array.isArray(event.arguments) || typeof event.arguments !== "object")
              throw new ChatTurnError("INVALID_TOOL_CALL");
            seen.add(event.id);
            const call = { id: event.id, name: event.name, arguments: event.arguments };
            const size = chatTurnBytes(call);
            inferenceBytes += size; conservativeOutput += size;
            if (inferenceBytes > CHAT_TURN_LIMITS.outputBytes || conservativeOutput > outputBudget
              || calls.length >= CHAT_TURN_LIMITS.toolsPerStep || current.toolCount + calls.length >= CHAT_TURN_LIMITS.tools)
              throw new ChatTurnError("TOOL_LIMIT");
            calls.push(structuredClone(call));
          } else if (event.type === "usage") {
            if (![event.inputTokens, event.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)
              || usage && (event.inputTokens < usage.inputTokens || event.outputTokens < usage.outputTokens)
              || event.inputTokens > current.bounds.maxInputTokens || event.outputTokens > outputBudget)
              throw new ChatTurnError("INVALID_USAGE");
            usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
          } else if (event.type === "finish") {
            if (!["stop", "tool_calls", "length"].includes(event.reason)) throw new ChatTurnError("INVALID_FINISH");
            finish = event.reason;
          } else throw new ChatTurnError("INVALID_MODEL_EVENT");
        }
        iterator = undefined;
        if (!finish) throw new ChatTurnError("INCOMPLETE_STREAM");
        if (finish === "length") throw new ChatTurnError("OUTPUT_TRUNCATED");
        if ((finish === "stop" && (calls.length || !text)) || (finish === "tool_calls" && !calls.length))
          throw new ChatTurnError("INVALID_COMPLETION");
        if (this.get(actor, id).messages.length + 1 + calls.length > CHAT_TURN_LIMITS.messages)
          throw new ChatTurnError("PROMPT_LIMIT");
        this.change(actor, id, "model-complete", {
          inputTokens: usage?.inputTokens ?? inputTokens, outputTokens: usage?.outputTokens ?? conservativeOutput,
          countingMethod: usage ? "provider-reported" : "utf8-byte-upper-bound",
        }, record => {
          record.outputTokens += usage?.outputTokens ?? conservativeOutput;
          record.messages.push({ role: "assistant", content: text,
            ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: "function" as const,
              function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) });
        });
        if (finish === "stop") {
          this.change(actor, id, "complete", {}, record => { record.status = "completed"; });
          return;
        }
        if (!this.dependencies.tools?.available) throw new ChatTurnError("TOOLS_UNAVAILABLE");
        for (const call of calls) {
          check();
          const operationId = randomUUID();
          this.change(actor, id, "tool-intent", { call, operationId }, record => {
            record.status = "tool"; record.pendingTool = { call, operationId }; record.toolCount++;
          });
          phase = "tool";
          check();
          const result = await abortable(this.track(this.dependencies.tools.execute({
            actor, turnId: id, call: structuredClone(call), operationId, signal,
            onApproval: event => {
              check();
              if (!callId(event.executionId) || !["pending", "approved", "denied"].includes(event.status))
                throw new ChatTurnError("INVALID_APPROVAL_EVENT");
              this.change(actor, id, "approval", { ...event }, record => {
                record.status = event.status === "pending" ? "approval" : "tool";
              });
            },
          })), signal);
          check();
          if (!callId(result.executionId)) throw new ChatTurnError("INVALID_TOOL_RESULT");
          // Original Chat reports an oversized result to the model as a failed tool result instead of aborting.
          if (result.resultStatus !== undefined && !["complete", "failed"].includes(result.resultStatus))
            throw new ChatTurnError("INVALID_TOOL_RESULT");
          const invalidContent = typeof result.content !== "string" || result.content.length > 16000;
          const content = invalidContent ? JSON.stringify({ error: "Tool result exceeded the local limit." }) : result.content;
          if (result.evidence) {
            boundedJson(result.evidence, 4096);
            if (!callId(result.evidence.operation) || !callId(result.evidence.executionId)
              || result.evidence.executionId !== result.executionId || result.evidence.operationId !== operationId
              || result.evidence.resource && (result.evidence.resource.kind !== "manager-run" || !callId(result.evidence.resource.id))) {
              throw new ChatTurnError("INVALID_TOOL_EVIDENCE");
            }
          }
          this.change(actor, id, "tool-complete", { executionId: result.executionId, callId: call.id,
            resultStatus: invalidContent ? "failed" : result.resultStatus ?? "complete",
            ...(result.evidence ? { evidence: result.evidence } : {}) }, record => {
            record.messages.push({ role: "tool", tool_call_id: call.id, content });
            record.pendingTool = null; record.status = "model";
          });
          phase = "model";
        }
      }
    } catch (error) {
      const current = this.get(actor, id);
      if (!chatTurnTerminal(current.status)) {
        const uncertain = phase === "tool" && !(error instanceof ChatTurnToolError && error.effect === "not-committed");
        const code = (error instanceof ChatTurnError || error instanceof ChatTurnToolError)
          && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) ? error.code : "NATIVE_DEPENDENCY_FAILED";
        this.change(actor, id, "failed", { code, uncertain }, record => {
          record.status = uncertain ? "unknown" : "failed"; record.failure = code; record.uncertain = uncertain;
        });
      }
    } finally {
      clearTimeout(timer);
      controller.abort("settled");
      // Never await an uncooperative provider's return() after cancellation.
      if (iterator?.return) {
        try { void this.track(iterator.return()).catch(() => undefined); }
        catch { /* An uncooperative native iterator cannot alter durable settlement. */ }
      }
    }
  }
}
