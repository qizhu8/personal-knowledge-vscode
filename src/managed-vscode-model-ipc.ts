import { randomUUID } from "node:crypto";
import type { ChatTurnModelPort } from "./chat-turn.js";
import type { ModelProviderTool } from "./model-provider-contracts.js";
import { ChatTurnError } from "./chat-turn-store.js";

/** Pull-based model stream across the managed child's authenticated parent IPC. */
export function managedVscodeModelIpc(options: { send(message: object): void; connected(): boolean }) {
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  const request = (session: string, streamId: string, type: string, extra: object, signal: AbortSignal, timeoutMs: number) =>
    new Promise<any>((resolve, reject) => {
      if (signal.aborted || !options.connected()) { reject(new ChatTurnError("MODEL_CANCELLED")); return; }
      const id = randomUUID();
      const finish = (error?: Error, value?: any) => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => {
        options.send({ type: "selected-lm-cancel", id: randomUUID(), session, streamId });
        finish(new ChatTurnError("MODEL_CANCELLED"));
      };
      const timer = setTimeout(() => {
        options.send({ type: "selected-lm-cancel", id: randomUUID(), session, streamId });
        finish(new ChatTurnError("MODEL_TIMEOUT"));
      }, timeoutMs);
      pending.set(id, { resolve: value => finish(undefined, value), reject: error => finish(error) });
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      try { options.send({ type, id, session, streamId, ...extra }); }
      catch { finish(new ChatTurnError("MODEL_PROVIDER_ERROR")); }
    });
  return {
    handle(message: Record<string, unknown>) {
      if (message.type !== "selected-lm-result") return false;
      if (typeof message.id !== "string") return true;
      const item = pending.get(message.id);
      if (item) message.error ? item.reject(new ChatTurnError(
        ["MODEL_AUTHENTICATION", "MODEL_PROVIDER_UNAVAILABLE", "MODEL_PROVIDER_ERROR"].includes(String(message.error))
          ? String(message.error) : "MODEL_PROVIDER_ERROR")) : item.resolve(message.result);
      return true;
    },
    model(session: string, tools: ModelProviderTool[], assertCurrent: () => void, timeoutMs: number, imageInput = false): ChatTurnModelPort {
      return {
        available: true,
        imageInput,
        preDispatchAdmission: true,
        async *stream(input) {
          assertCurrent();
          const streamId = randomUUID();
          try {
            const opened = await request(session, streamId, "selected-lm-open", {
              messages: input.messages, maxInputTokens: input.maxInputTokens,
              maxOutputTokens: input.maxOutputTokens, tools, ...(input.images ? { images: input.images } : {}),
              ...(input.beforeDispatch ? { prepareOnly: true } : {}),
            }, input.signal, timeoutMs);
            assertCurrent();
            if (input.beforeDispatch) {
              if (opened?.prepared !== true) throw new ChatTurnError("MODEL_PROVIDER_ERROR");
              input.beforeDispatch();
              const dispatched = await request(session, streamId, "selected-lm-dispatch", {}, input.signal, timeoutMs);
              assertCurrent();
              if (dispatched?.opened !== true) throw new ChatTurnError("MODEL_PROVIDER_ERROR");
            } else if (opened?.opened !== true) throw new ChatTurnError("MODEL_PROVIDER_ERROR");
            for (;;) {
              const value = await request(session, streamId, "selected-lm-next", {}, input.signal, timeoutMs);
              assertCurrent();
              if (!value?.event || !["text", "tool", "finish"].includes(value.event.type)) throw new ChatTurnError("MODEL_PROVIDER_ERROR");
              yield value.event;
              if (value.event.type === "finish") break;
            }
          } finally {
            options.send({ type: "selected-lm-cancel", id: randomUUID(), session, streamId });
          }
        },
      };
    },
  };
}
