import * as vscode from "vscode";
import {
  originalRoomSessionNativeMethods, originalRoomUserLinkNativeMethods, originalRoomSessionDigest,
  parseOriginalRoomSessionNativePayload, type OriginalRoomSessionNativeMethod,
} from "../../src/original-mcp-room-session-contracts.js";
import { originalNativeRoomSessionSchema, type OriginalNativeRoomSession } from "../../src/original-mcp-native-room-contracts.js";
import { createOriginalMcpNativeRoomSessionProducer } from "./original-mcp-native-room-session.js";

type Native = Awaited<ReturnType<typeof createOriginalMcpNativeRoomSessionProducer>>;
type Entry = {
  id: string; digest: string; lifetime: AbortController;
  opening: Promise<{ native: Native } | { error: unknown }>;
  closing?: Promise<void>;
};
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

/** Network resources belong to the attachment, not the short-lived open RPC. */
export function createOriginalMcpNativeRoomSessionsProducer(context: vscode.ExtensionContext, options: {
  session: OriginalNativeRoomSession; signal: AbortSignal; assertCurrent(): void;
}) {
  const session = originalNativeRoomSessionSchema.parse(options.session);
  const entries = new Map<string, Entry>(), retired = new Map<string, string>();
  let disposed = false, closing: Promise<void> | undefined;
  function current(signal?: AbortSignal) {
    options.assertCurrent();
    if (disposed || options.signal.aborted || signal?.aborted) fail("ROOM_SESSION_NATIVE_CANCELLED");
  }
  function closeEntry(entry: Entry): Promise<void> {
    return entry.closing ??= (async () => {
      entry.lifetime.abort();
      try {
        const opened = await entry.opening;
        if ("native" in opened) await opened.native.close();
      } finally {
        if (entries.get(entry.id) === entry) entries.delete(entry.id);
        retired.set(entry.id, entry.digest);
        if (retired.size > 256) retired.delete(retired.keys().next().value!);
      }
    })();
  }
  function dispose(): Promise<void> {
    disposed = true;
    return closing ??= (async () => {
      options.signal.removeEventListener("abort", abort);
      const results = await Promise.allSettled([...entries.values()].map(closeEntry));
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), "Native Room cleanup requires reconciliation.");
    })();
  }
  const abort = () => {
    void dispose().catch(() => console.error("Native Room session cleanup requires reconciliation."));
  };
  options.signal.addEventListener("abort", abort, { once: true });
  function entry(id: string, digest: string) {
    const value = entries.get(id);
    if (!value || value.digest !== digest) fail("ROOM_SESSION_NATIVE_CURRENT_RESOURCE_REQUIRED");
    return value;
  }
  return Object.freeze({
    methods: Object.freeze([...originalRoomSessionNativeMethods, ...originalRoomUserLinkNativeMethods]),
    async handle(method: OriginalRoomSessionNativeMethod, value: unknown, _requestId: string, signal: AbortSignal) {
      current();
      if (method === "room.session.open") {
        const input = parseOriginalRoomSessionNativePayload(method, value, session);
        current(signal);
        if (entries.size || retired.has(input.effect.sessionId)) fail("ROOM_SESSION_NATIVE_ALREADY_OPENED");
        const lifetime = new AbortController();
        const abortOpen = () => lifetime.abort();
        signal.addEventListener("abort", abortOpen, { once: true });
        const opening = createOriginalMcpNativeRoomSessionProducer(context, {
          session, effect: input.effect, persistence: input.persistence,
          signal: AbortSignal.any([options.signal, lifetime.signal]), assertCurrent: options.assertCurrent,
        }).then(native => ({ native }), error => ({ error }));
        const resource: Entry = { id: input.effect.sessionId, digest: originalRoomSessionDigest(input.effect), lifetime, opening };
        entries.set(resource.id, resource);
        try {
          const opened = await opening;
          if ("error" in opened) throw opened.error;
          current(signal);
          return {
            sessionId: opened.native.effect.sessionId, effectSha256: resource.digest,
            endpoint: opened.native.endpoint, alias: opened.native.effect.selection.alias,
            expiresAtMs: opened.native.effect.expiresAtMs,
          };
        } catch (error) {
          try { await closeEntry(resource); }
          catch (cleanup) { throw new AggregateError([error, cleanup], "Native Room open and cleanup failed."); }
          throw error;
        } finally { signal.removeEventListener("abort", abortOpen); }
      }
      if (method === "room.session.close") {
        const input = parseOriginalRoomSessionNativePayload(method, value, session);
        if (retired.get(input.sessionId) === input.effectSha256) return { closed: true as const };
        await closeEntry(entry(input.sessionId, input.effectSha256));
        return { closed: true as const };
      }
      current(signal);
      if (method === "room.session.join") {
        const input = parseOriginalRoomSessionNativePayload(method, value, session);
        const opened = await entry(input.sessionId, input.effectSha256).opening;
        if ("error" in opened) throw opened.error;
        const result = await opened.native.invokeUserJoin(input.callId, input.arguments, input.intent);
        current(signal); return result;
      }
      const input = parseOriginalRoomSessionNativePayload(method, value, session);
      const opened = await entry(input.sessionId, input.effectSha256).opening;
      if ("error" in opened) throw opened.error;
      const result = await opened.native.invoke(input.callId, input.call);
      current(signal); return result;
    },
    dispose,
  });
}
