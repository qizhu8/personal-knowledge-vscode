import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { createOwnerHostSessions } from "./owner-host-sessions.js";

type Registry = ReturnType<typeof createOwnerHostSessions>;
type Scope = "chat" | "environment" | "mcp";

function parentStartTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const end = stat.lastIndexOf(")");
  const fields = end >= 0 ? stat.slice(end + 2).trim().split(/\s+/) : [];
  const start = fields[19];
  if (!fields[0] || ["Z", "X"].includes(fields[0]) || !start || !/^[0-9]+$/.test(start))
    throw new Error("Parent process identity is unavailable.");
  return start;
}

/**
 * Bind one session to an inherited parent IPC channel. The embedding must
 * independently authorize the exact profile, root, owner and each scope.
 */
export function bindOwnerParentSession(options: {
  registry: Registry;
  hostKey: string;
  expectedParentPid: number;
  assertHostCurrent(): void;
  assertScopeCurrent(scope: Scope): void;
  onCloseError(error: unknown): void;
}) {
  if (process.platform !== "linux" || !options || !Number.isSafeInteger(options.expectedParentPid)
    || options.expectedParentPid <= 1 || process.ppid !== options.expectedParentPid
    || !process.connected || typeof options.assertHostCurrent !== "function"
    || typeof options.assertScopeCurrent !== "function")
    throw new Error("A connected direct parent and independent authorization are required.");
  const parent = options.expectedParentPid, start = parentStartTime(parent), sessionId = randomUUID();
  const { hostKey, assertHostCurrent, assertScopeCurrent, onCloseError } = options;
  const connection = new AbortController();
  const disconnected = () => connection.abort();
  const parentCurrent = () => process.connected && process.ppid === parent && parentStartTime(parent) === start;
  process.once("disconnect", disconnected);
  try {
    const session = options.registry.open({
      hostKey, connection: connection.signal,
      assertHostCurrent() {
        if (!parentCurrent())
          throw new Error("Parent IPC binding is no longer current.");
        const result = (assertHostCurrent as () => unknown)();
        if (result !== undefined) {
          if (result && (typeof result === "object" || typeof result === "function")
            && typeof (result as { then?: unknown }).then === "function")
            void Promise.resolve(result).catch(() => {});
          throw new Error("Parent authority fence must synchronously return undefined.");
        }
        if (!parentCurrent()) throw new Error("Parent IPC binding is no longer current.");
      },
      assertScopeCurrent,
      onCloseError,
    });
    const onMessage = (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const message = value as Record<string, unknown>;
      if (message.type !== "pkm.owner-scope-revoke/v1" || message.sessionId !== sessionId
        || typeof message.id !== "string" || !/^[a-f0-9-]{36}$/.test(message.id)
        || typeof message.scope !== "string" || !["chat", "environment", "mcp"].includes(message.scope)) return;
      try {
        if (!parentCurrent()) { disconnected(); return; }
      } catch { disconnected(); return; }
      const { id, scope } = message;
      void session.revokeScope(scope as Scope).then(() => reply(true), () => reply(false));
      function reply(drained: boolean) {
        try {
          if (process.connected) process.send?.({ type: "pkm.owner-scope-revoked/v1",
            id, sessionId, scope, drained }, () => {});
        } catch { /* A missing acknowledgement is not proof of drain. */ }
      }
    };
    process.on("message", onMessage);
    const parentWatch = setInterval(() => {
      try { if (!parentCurrent()) disconnected(); }
      catch { disconnected(); }
    }, 500);
    parentWatch.unref();
    session.signal.addEventListener("abort", () => {
      clearInterval(parentWatch);
      process.removeListener("message", onMessage);
      process.removeListener("disconnect", disconnected);
    }, { once: true });
    if (!process.connected) disconnected();
    return Object.freeze({
      ...session,
      sessionId,
      async revoke() {
        await session.revoke();
        process.removeListener("disconnect", disconnected);
        process.removeListener("message", onMessage);
      },
    });
  } catch (error) {
    process.removeListener("disconnect", disconnected);
    throw error;
  }
}
