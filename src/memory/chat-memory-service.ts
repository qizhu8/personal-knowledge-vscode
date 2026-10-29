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

  /** Inspection does not touch LRU, publish summaries, ingest messages or invoke a model. */
  async inspect(scope: string, piece?: string, after = 0): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid Memory statement cursor.");
    const engine = await this.engine();
    if (piece !== undefined) {
      if (typeof piece !== "string" || !piece.startsWith(`${scope}|`) || piece.length > 1024) {
        throw new Error("Choose a Memory piece in this Chat.");
      }
      const page = await engine.request({ method: "read", params: { piece_id: piece, after, limit: 20 } }) as {
        piece: { scope: string }; statements: Array<{ id: string }>; next: number;
      };
      if (page.piece.scope !== scope) throw new Error("The Memory piece belongs to another Chat.");
      const statements = await Promise.all(page.statements.map(async statement => ({
        ...statement,
        sources: (await engine.request({ method: "sources", params: { statement_id: statement.id, limit: 20 } }) as Array<{ chat: string }>)
          .filter(source => source.chat === scope),
        sourceLimit: 20,
      })));
      const more = await engine.request({ method: "read", params: { piece_id: piece, after: page.next, limit: 1 } }) as { statements: unknown[] };
      return { ...page, statements, next: more.statements.length ? page.next : null, observedAt: Date.now(),
        note: "Current stored revision, not a reconstruction of historical model context. Source lists are bounded to 20 per statement." };
    }
    const kinds = ["project", "topic", "message", "piece"] as const;
    const groups = await Promise.all(kinds.map(async kind => ({
      kind, pieces: await engine.request({ method: "pieces", params: { scope, kind, limit: 200 } }) as Array<{
        id: string; label: string; kind: string; level: number; revision: number; bytes: number; summary_current: number | null;
      }>,
    })));
    const pieces = groups.flatMap(group => group.pieces);
    const topics = pieces.filter(item => item.kind === "topic" || item.kind === "project");
    const ids = new Set(pieces.map(item => item.id));
    const relationships = await Promise.all(topics.map(async item =>
      await engine.request({ method: "neighbors", params: { piece_id: item.id, limit: 100 } }) as Array<{
        parent: string; child: string; relation: string;
      }>));
    const edges = [...new Map(relationships.flat().filter(edge => ids.has(edge.parent) && ids.has(edge.child))
      .map(edge => [JSON.stringify(edge), edge])).values()];
    return { scope, observedAt: Date.now(), usage: await engine.request({ method: "usage", params: { scope } }),
      pieces, edges, pieceLimitPerKind: 200, edgeLimitPerPiece: 100,
      possiblyTruncated: groups.some(group => group.pieces.length === 200) || relationships.some(edges => edges.length === 100),
      note: "Live non-evicted pieces in this Chat only. Bounded snapshot; counts by level describe displayed pieces, not all disk contents. Inspection does not update meaningful-access times." };
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
