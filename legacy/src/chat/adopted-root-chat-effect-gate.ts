import { createAdoptedRootChatParentSession } from "./adopted-root-chat-parent-session";

type Effect = Readonly<{ namespace: string; chatId: string; operation: "history" | "continue"; text?: string }>;
const prefix = "pkm.experimental-chat-effect/v1";
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

/**
 * Experimental direct-fork gate. The embedding must independently authorize
 * each exact effect from a real UI intent; IPC payloads are not authority.
 */
export function createAdoptedChatEffectParent(options: Parameters<typeof createAdoptedRootChatParentSession>[0] & {
  authorizeEffect(effect: Effect): boolean;
}) {
  if (typeof options.authorizeEffect !== "function") throw new Error("Effect intent authority is required.");
  const parent = createAdoptedRootChatParentSession(options), child = options.child;
  const view = parent.viewAuthority, chat = options.authority.chats[0], timeout = options.timeoutMs ?? 30_000;
  const binding = { root: view.root, workspaceId: view.workspaceId, sessionId: view.sessionId,
    profileId: view.profileId, actorId: "local:owner" as const, endpoint: view.endpoint, bearer: view.bearer,
    sourceFingerprint: view.sourceFingerprint };
  const active = new Set<string>(), seen = new Set<string>();
  const waiters = new Set<() => void>();
  let fenced = false, broken = false, closed = false;
  const fail = () => {
    broken = true;
    fenced = true;
    for (const wake of waiters) wake();
    void parent.revokeChat().catch(() => {});
  };
  const send = (message: object) => {
    try { child.send(message, error => { if (error) fail(); }); } catch { fail(); }
  };
  const changed = () => { for (const wake of waiters) wake(); };
  const onMessage = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.type === "pkm.owner-scope-revoked/v1" && message.sessionId === view.sessionId
      && message.scope === "chat" && message.drained === true && active.size) {
      broken = true;
      fenced = true;
      changed();
    }
    if (message.protocol !== prefix || message.sessionId !== view.sessionId) return;
    if (message.kind === "fault") { fail(); return; }
    if (typeof message.id !== "string" || !idPattern.test(message.id)) { fail(); return; }
    if (message.kind === "settled") {
      if (!active.delete(message.id)) { fail(); return; }
      changed(); return;
    }
    if (message.kind !== "request") { fail(); return; }
    if (seen.has(message.id) || seen.size >= 4096) { fail(); return; }
    seen.add(message.id);
    let admitted = false;
    try {
      const request = effect(message.effect);
      if (fenced || closed || broken || active.size >= 64 || request.namespace !== chat.namespace || request.chatId !== chat.chatId)
        throw new Error("Effect scope denied.");
      view.session.assertCurrent(binding);
      const decision = (options.authorizeEffect as (effect: Effect) => unknown)(request);
      if (decision && typeof (decision as { then?: unknown }).then === "function")
        void Promise.resolve(decision).catch(() => {});
      admitted = decision === true;
      view.session.assertCurrent(binding);
      if (fenced || closed || broken) admitted = false;
      if (admitted) active.add(message.id);
    } catch { admitted = false; }
    send({ protocol: prefix, sessionId: view.sessionId, kind: "reply", id: message.id, admitted });
  };
  const onAbort = () => { fenced = true; changed(); };
  child.on("message", onMessage);
  child.once("disconnect", fail);
  child.once("exit", fail);
  child.on("error", fail);
  view.session.signal.addEventListener("abort", onAbort, { once: true });

  const waitSettled = () => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error("Chat effect drain timed out; outcome unknown.")); }, timeout);
    const check = () => {
      if (broken || !child.connected) {
        clearTimeout(timer); waiters.delete(check); reject(new Error("Chat effect drain outcome unknown."));
      } else if (!active.size) { clearTimeout(timer); waiters.delete(check); resolve(); }
    };
    waiters.add(check); check();
  });
  const revoke = async () => {
    fenced = true;
    const drain = parent.revokeChat().then(() => {
      if (active.size) {
        broken = true;
        changed();
        throw new Error("Chat physical drain acknowledged before effects settled.");
      }
    });
    const [physical, effects] = await Promise.allSettled([drain, waitSettled()]);
    if (broken || physical.status !== "fulfilled" || effects.status !== "fulfilled")
      throw new Error("Chat effect and physical drain outcome unknown.");
  };
  const exposedView = Object.freeze({ ...view, session: Object.freeze({ ...view.session, revokeChat: revoke }) });
  return Object.freeze({
    viewAuthority: exposedView,
    revoke,
    async close() {
      await revoke();
      await parent.close();
      closed = true;
      child.removeListener("message", onMessage);
      child.removeListener("disconnect", fail);
      child.removeListener("exit", fail);
      child.removeListener("error", fail);
      view.session.signal.removeEventListener("abort", onAbort);
    },
  });
}

