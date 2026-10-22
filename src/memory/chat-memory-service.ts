import { createHash } from "crypto";
import { MemoryDialogueMessage, MemoryEngineClient, MemoryEngineClientOptions, MemoryMessage } from "./memory-engine-client";
import { memoryTurnAccounting, type MemoryModelAccounting } from "./memory-accounting";
import type { ChatTokenUsage } from "../chat/api-chat-models";

export interface MemoryModelRequest {
  purpose: "intent" | "summary" | "extract";
  max_tokens: number;
  messages: Array<{ role: "system" | "user"; content: string }>;
}
export interface MemoryModelResult { text: string; usage?: ChatTokenUsage; accounting?: MemoryModelAccounting }
export class MemoryModelError extends Error {
  constructor(message: string, readonly result: MemoryModelResult) {
    super(message);
    this.name = "MemoryModelError";
  }
}
export type MemoryModelRunner = (request: MemoryModelRequest, signal: AbortSignal) => Promise<MemoryModelResult>;

export interface MemoryContextBlock {
  kind: "focus-topic" | "earlier-message" | "related-topic" | "index";
  piece: string;
  priority: number;
  text: string;
}
export interface PreparedChatMemory {
  turn: string;
  blocks: MemoryContextBlock[];
  focus: string[];
  related: string[];
  receipt: Record<string, unknown>;
}

interface Step {
  turn: string;
  status: "model" | "ready" | "done";
  request?: MemoryModelRequest;
  receipt: Record<string, unknown>;
  context?: { blocks: MemoryContextBlock[]; focus: string[]; related: string[] };
}

function step(value: unknown): Step {
  const item = value as Partial<Step> | undefined;
  if (!item || typeof item.turn !== "string" || !["model", "ready", "done"].includes(String(item.status))
    || typeof item.receipt !== "object" || item.status === "model" && (!item.request || !Array.isArray(item.request.messages))) {
    throw new Error("Memory Engine returned an invalid turn step.");
  }
  return item as Step;
}

/** Stable per-Chat memory scope; Chats in different workspaces never share a scope. */
export function chatMemoryScope(namespace: string, chatId: string): string {
  return `${namespace}/${chatId}`;
}

export function messageRevision(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/**
 * Host-side driver: the Python policy decides, this class only transports model steps.
 * One worker per host; a failed worker is reopened for the next call, never retried mid-mutation.
 */
export class ChatMemoryService {
  private client?: Promise<MemoryEngineClient>;
  private closed = false;

  constructor(private readonly options: MemoryEngineClientOptions) {}

  private async engine(): Promise<MemoryEngineClient> {
    if (this.closed) throw new Error("Chat memory service is closed.");
    const pending = this.client;
    if (pending) {
      const current = await pending;
      if (this.closed) throw new Error("Chat memory service is closed.");
      if (current.healthy) return current;
      if (this.client === pending) this.client = undefined;
      await current.close();
      return this.engine();
    }
    const opening = MemoryEngineClient.open({ timeoutMs: 30_000, ...this.options });
    this.client = opening;
    try {
      const current = await opening;
      if (this.closed) {
        await current.close();
        throw new Error("Chat memory service is closed.");
      }
      return current;
    } catch (error) {
      if (this.client === opening) this.client = undefined;
      throw error;
    }
  }

  private async drive(initial: unknown, run: MemoryModelRunner, signal: AbortSignal, onStep?: (purpose: string) => void): Promise<Step> {
    let current = step(initial);
    for (let index = 0; current.status === "model"; index++) {
      if (index >= 12) throw new Error("Memory turn exceeded its model-step limit.");
      const request = current.request!;
      onStep?.(request.purpose);
      let params: { turn: string; output?: string; error?: string; usage?: Record<string, number>; accounting?: MemoryModelAccounting };
      let result: MemoryModelResult | undefined;
      try {
        if (signal.aborted) throw new Error("Request cancelled.");
        result = await run(request, signal);
        if (signal.aborted) throw new Error("Request cancelled.");
        params = { turn: current.turn, output: result.text, ...(result.usage ? { usage: { ...result.usage } } : {}),
          ...(result.accounting ? { accounting: result.accounting } : {}) };
      } catch (error) {
        const partial = error instanceof MemoryModelError ? error.result : result;
        if (signal.aborted) {
          await (await this.engine()).request({ method: "turn_abort", params: { turn: current.turn, error: "Request cancelled; model output was not applied.",
            ...(partial?.usage ? { usage: { ...partial.usage } } : {}), ...(partial?.accounting ? { accounting: partial.accounting } : {}) } });
          throw error;
        }
        params = { turn: current.turn, error: error instanceof Error ? error.message : String(error),
          ...(partial ? { output: partial.text, ...(partial.usage ? { usage: { ...partial.usage } } : {}),
            ...(partial.accounting ? { accounting: partial.accounting } : {}) } : {}) };
      }
      current = step(await (await this.engine()).request({ method: "turn_continue", params }));
    }
    return current;
  }

  async prepare(scope: string, turn: string, input: { id: string; text: string }, recent: MemoryDialogueMessage[], budgetChars: number,
    run: MemoryModelRunner, signal: AbortSignal, onStep?: (purpose: string) => void): Promise<PreparedChatMemory> {
    if (signal.aborted) throw new Error("Request cancelled.");
    const engine = await this.engine();
    if (signal.aborted) throw new Error("Request cancelled.");
    const ready = await this.drive(await engine.request({ method: "turn_begin", params: {
      scope, turn, input, recent: recent.map(message => ({ ...message, text: message.text.slice(0, 20_000) })),
      budget_chars: Math.max(2000, Math.min(400_000, Math.floor(budgetChars))),
    } }), run, signal, onStep);
    if (ready.status !== "ready" || !ready.context) throw new Error("Memory turn did not produce context.");
    return { turn, blocks: ready.context.blocks, focus: ready.context.focus, related: ready.context.related,
      receipt: { ...ready.receipt, accounting: memoryTurnAccounting(ready.receipt) } };
  }

  async commit(scope: string, turn: string, user: MemoryMessage, assistant: MemoryMessage, run: MemoryModelRunner, signal: AbortSignal,
    maxBytes?: number): Promise<Record<string, unknown>> {
    if (signal.aborted) throw new Error("Request cancelled.");
    const engine = await this.engine();
    if (signal.aborted) throw new Error("Request cancelled.");
    // Raw Chat files stay authoritative; memory keeps a bounded copy of very large messages.
    const bounded = (message: MemoryMessage) => ({ ...message, revision: message.revision || messageRevision(message.text),
      text: message.text.length > 2_000_000 ? `${message.text.slice(0, 2_000_000)}\n…[truncated in memory; see the Chat message]` : message.text });
    const done = await this.drive(await engine.request({ method: "turn_commit", params: { turn, scope, user: bounded(user), assistant: bounded(assistant) } }), run, signal);
    if (maxBytes) await engine.request({ method: "enforce_capacity", params: { max_bytes: maxBytes } });
    return { ...done.receipt, accounting: memoryTurnAccounting(done.receipt) };
  }

  async read(scope: string, piece: string, after = 0): Promise<Record<string, unknown>> {
    return await (await this.engine()).request({ method: "memory_read", params: { scope, piece, after } }) as Record<string, unknown>;
  }

  async overview(scope: string): Promise<Record<string, unknown>> {
    return await (await this.engine()).request({ method: "overview", params: { scope } }) as Record<string, unknown>;
  }

  async receipt(turn: string): Promise<Record<string, unknown>> {
    const receipt = await (await this.engine()).request({ method: "turn_receipt", params: { turn } }) as Record<string, unknown>;
    return { ...receipt, accounting: memoryTurnAccounting(receipt) };
  }

  async forget(scope: string): Promise<void> {
    await (await this.engine()).request({ method: "forget_scope", params: { scope } });
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client && await this.client.catch(() => undefined);
    await client?.close();
  }
}
