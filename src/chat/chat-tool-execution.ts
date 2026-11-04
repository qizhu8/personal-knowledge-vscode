import type { ApiChatMessage, ApiChatRequest, ApiChatTool, ChatToolLoopGuard } from "./api-chat-client";

/** Unannotated tools are exclusive barriers; only Host-declared independent reads may overlap. */
export class ChatToolScheduler {
  private barrier: Promise<unknown> = Promise.resolve();
  private readers: Promise<unknown>[] = [];
  private all: Promise<unknown> = Promise.resolve();
  constructor(private readonly concurrency = 4) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("Choose tool concurrency from 1 to 16.");
  }
  schedule<T>(tool: ApiChatTool | undefined, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const readOnly = tool?.execution === "parallel-read";
    const previous = readOnly ? this.barrier : Promise.all([this.barrier, ...this.readers]);
    const next = previous.then(() => {
      if (signal.aborted) throw new Error("Request cancelled.");
      return run();
    });
    const settled = next.then(() => undefined, () => undefined);
    this.all = Promise.all([this.all, settled]);
    if (readOnly) {
      this.readers.push(settled);
      if (this.readers.length >= this.concurrency) {
        this.barrier = Promise.all(this.readers); this.readers = [];
      }
    } else { this.barrier = settled; this.readers = []; }
    return next;
  }
  async drain(): Promise<void> { await this.all; }
}

export async function executeChatToolBatch(
  calls: NonNullable<ApiChatMessage["tool_calls"]>, request: Pick<ApiChatRequest, "tools" | "onTool" | "afterTools">,
  messages: ApiChatMessage[], loop: ChatToolLoopGuard, signal: AbortSignal, round: number,
): Promise<void> {
  await loop.beforeRound(round, signal);
  const scheduler = new ChatToolScheduler();
  const completed: ApiChatMessage[] = [];
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) controller.abort();
  const batchSignal = controller.signal;
  try {
  const outputs = await Promise.allSettled(calls.map(call => {
    const tool = request.tools?.find(item => item.name === call.function.name);
    const queuedAt = Date.now();
    return scheduler.schedule(tool, batchSignal, async () => {
      if (tool?.execution !== "parallel-read") await loop.beforeRound(round, batchSignal);
      const event = { id: call.id, name: tool?.label || call.function.name, arguments: call.function.arguments,
        queuedMs: Math.max(0, Date.now() - queuedAt), round };
      if (loop.summarizing || request.afterTools?.()) {
        const result = JSON.stringify({ error: "Not executed: the request has stopped; use completed results." });
        request.onTool?.({ ...event, status: "failed", result });
        return { role: "tool" as const, content: result, tool_call_id: call.id };
      }
      request.onTool?.({ ...event, status: "running" });
      let result: string, succeeded = false, reused = false;
      try {
        if (!tool) throw new Error("This tool is not enabled for the request.");
        const args: unknown = JSON.parse(call.function.arguments);
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object.");
        const version = await tool.readVersion?.(args as Record<string, unknown>, batchSignal);
        const prior = loop.reuse(tool.name, call.function.arguments, [...messages, ...completed], version);
        if (prior) {
          result = prior.result; reused = true;
          loop.record(tool, tool.name, call.function.arguments, prior.original);
        } else {
          result = await cancellable(tool.execute(args as Record<string, unknown>, batchSignal), batchSignal);
          if (typeof result !== "string" || result.length > 16_000) throw new Error("Tool result exceeded the local limit.");
          loop.remember(tool.name, call.function.arguments, call.id, result, true, version);
          loop.record(tool, tool.name, call.function.arguments, result, true);
        }
        succeeded = true;
      } catch (error) {
        if (batchSignal.aborted) throw new Error("Request cancelled.");
        result = JSON.stringify({ error: error instanceof Error ? error.message : "Tool failed." });
        loop.remember(call.function.name, call.function.arguments, call.id, result, false);
        loop.record(tool, call.function.name, call.function.arguments, result, false);
      }
      request.onTool?.({ ...event, status: succeeded ? "complete" : "failed", result, reused });
      const output = { role: "tool" as const, content: result, tool_call_id: call.id };
      completed.push(output);
      return output;
    }).catch(error => { controller.abort(); throw error; });
  }));
  for (const output of outputs) if (output.status === "fulfilled") messages.push(output.value);
  const failed = outputs.find(output => output.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  } finally { signal.removeEventListener("abort", cancel); }
}

function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error("Request cancelled."));
    signal.addEventListener("abort", cancel, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    if (signal.aborted) cancel();
  });
}
