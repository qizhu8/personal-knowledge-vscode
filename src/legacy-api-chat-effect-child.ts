import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

type Effect = Readonly<{ namespace: string; chatId: string; operation: "history" | "continue"; text?: string }>;
const prefix = "pkm.experimental-chat-effect/v1";

function effect(value: unknown): Effect {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Chat effect.");
  const item = value as Record<string, unknown>, keys = Object.keys(item).sort().join(",");
  if (typeof item.namespace !== "string" || !/^[a-f0-9]{16}$/.test(item.namespace)
    || typeof item.chatId !== "string" || !/^[a-f0-9-]{36}$/.test(item.chatId)
    || (item.operation === "history" ? keys !== "chatId,namespace,operation"
      : item.operation !== "continue" || keys !== "chatId,namespace,operation,text"
        || typeof item.text !== "string" || item.text.length < 1 || item.text.length > 100_000))
    throw new Error("Invalid Chat effect.");
  return Object.freeze({ namespace: item.namespace, chatId: item.chatId, operation: item.operation,
    ...(item.operation === "continue" ? { text: item.text as string } : {}) }) as Effect;
}

function processStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), end = stat.lastIndexOf(")");
  const fields = end >= 0 ? stat.slice(end + 2).trim().split(/\s+/) : [];
  if (!fields[0] || ["Z", "X"].includes(fields[0]) || !/^[0-9]+$/.test(fields[19] || ""))
    throw new Error("Chat effect parent is unavailable.");
  return fields[19];
}

/**
 * Experimental child gate: trusted embedding must keep executors private and
 * route every effect through run; this module cannot prove that property.
 */
export function createAdoptedChatEffectChild(options: {
  sessionId: string; chat: Readonly<{ namespace: string; chatId: string }>; scopeSignal: AbortSignal;
  assertLocalCurrent(): void;
  executors: { history(request: Effect, signal: AbortSignal): Promise<unknown>;
    continue(request: Effect, signal: AbortSignal): Promise<unknown> };
  timeoutMs?: number;
}) {
  const timeout = options.timeoutMs ?? 30_000, parentPid = process.ppid;
  if (process.platform !== "linux" || !process.connected || typeof process.send !== "function"
    || !/^[a-f0-9-]{36}$/.test(options.sessionId) || !options.scopeSignal
    || typeof options.assertLocalCurrent !== "function" || typeof options.executors?.history !== "function"
    || typeof options.executors?.continue !== "function" || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000)
    throw new Error("A trusted direct-parent effect embedding is required.");
  const chat = effect({ ...options.chat, operation: "history" }), start = processStart(parentPid);
  const controller = new AbortController();
  const pending = new Map<string, { resolve(value: boolean): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let closed = false, running = 0;
  const send = (value: object) => {
    try { process.send!(value, error => { if (error) fault(); }); } catch { fault(); }
  };
  const fault = () => {
    if (closed) return;
    closed = true; controller.abort();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Chat effect IPC outcome unknown.")); }
    pending.clear();
    if (process.connected) send({ protocol: prefix, sessionId: options.sessionId, kind: "fault" });
  };
  const check = () => {
    if (closed || controller.signal.aborted || options.scopeSignal.aborted || !process.connected
      || process.ppid !== parentPid || processStart(parentPid) !== start)
      throw new Error("Chat effect scope is unavailable.");
    const result = (options.assertLocalCurrent as () => unknown)();
    if (result !== undefined) {
      if (result && typeof (result as { then?: unknown }).then === "function")
        void Promise.resolve(result).catch(() => {});
      throw new Error("Effect fence must be synchronous.");
    }
    if (closed || options.scopeSignal.aborted || !process.connected || process.ppid !== parentPid || processStart(parentPid) !== start)
      throw new Error("Chat effect scope is unavailable.");
  };
  const onMessage = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.protocol !== prefix || message.sessionId !== options.sessionId || message.kind !== "reply") return;
    if (typeof message.id !== "string" || typeof message.admitted !== "boolean") { fault(); return; }
    const item = pending.get(message.id);
    if (!item) { fault(); return; }
    pending.delete(message.id); clearTimeout(item.timer); item.resolve(message.admitted);
  };
  const onAbort = () => controller.abort();
  process.on("message", onMessage);
  process.once("disconnect", fault);
  options.scopeSignal.addEventListener("abort", onAbort, { once: true });
  try { check(); } catch (error) {
    process.removeListener("message", onMessage);
    process.removeListener("disconnect", fault);
    options.scopeSignal.removeEventListener("abort", onAbort);
    throw error;
  }
  return Object.freeze({
    async run(value: unknown): Promise<unknown> {
      const request = effect(value);
      if (request.namespace !== chat.namespace || request.chatId !== chat.chatId) throw new Error("Chat effect scope denied.");
      check();
      const id = randomUUID();
      const admitted = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => { fault(); reject(new Error("Chat effect admission timed out; outcome unknown.")); }, timeout);
        pending.set(id, { resolve, reject, timer });
        send({ protocol: prefix, sessionId: options.sessionId, kind: "request", id, effect: request });
      });
      if (!admitted) throw new Error("Chat effect denied.");
      try {
        check();
        running++;
        try {
          return await options.executors[request.operation](request, controller.signal);
        } finally { running--; }
      } finally {
        send({ protocol: prefix, sessionId: options.sessionId, kind: "settled", id });
      }
    },
    close() {
      if (!options.scopeSignal.aborted || pending.size || running) throw new Error("Chat effects have not drained.");
      closed = true;
      process.removeListener("message", onMessage);
      process.removeListener("disconnect", fault);
      options.scopeSignal.removeEventListener("abort", onAbort);
    },
  });
}
