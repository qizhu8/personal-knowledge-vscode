import { randomUUID } from "node:crypto";
import type { BrowserChatGrant } from "./browser-chat-transcript";

type Ref = Readonly<{ chatId: string; turnId: string }>;
type Send = Ref & Readonly<{ revision: string; text: string }>;
type Target = Readonly<{ title: string; stamp: string }>;
type Status = "ready" | "confirming" | "running" | "stop-requested" | "completed" | "cancelled" | "not-sent" | "unknown";
type Receipt = Ref & Readonly<{ status: Status }>;
export type BrowserTurnAdmission = {
  readonly id: string;
  readonly signal: AbortSignal;
  assertUnchanged(): void;
  onPersisted(canStop: () => boolean): void;
};

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const unavailable = () => new Error("The requested Chat turn is unavailable from this browser grant.");

/** Bind once per authenticated grant. Keep the pre-issued turn ID before sending.
 * Receipts are local to this binder: on expiry/rebind, inspect the owning Chat
 * rather than issuing another Send to reconcile an unknown result. */
export function bindBrowserChatTurns(grant: BrowserChatGrant, authority: {
  assertCurrent(grant: BrowserChatGrant): void;
  target(chatId: string): Target;
  confirm(title: string, chatId: string, text: string): Promise<boolean>;
  send(chatId: string, text: string, admission: BrowserTurnAdmission): Promise<"completed" | "cancelled" | "unknown">;
}) {
  const pinned = Object.freeze({ ...grant });
  type Entry = Ref & { revision: string; target: Target; expires: number; status: Status; controller?: AbortController; canStop?: () => boolean };
  const turns = new Map<string, Entry>();
  const current = (supplied: BrowserChatGrant) => {
    if (supplied.actorId !== pinned.actorId || supplied.workspaceRoot !== pinned.workspaceRoot ||
        supplied.generation !== pinned.generation || supplied.chatHostId !== pinned.chatHostId) throw unavailable();
    authority.assertCurrent(pinned);
  };
  const lookup = (ref: Ref) => {
    if (!uuid.test(ref.chatId) || !uuid.test(ref.turnId)) throw unavailable();
    const entry = turns.get(ref.turnId);
    if (entry && entry.chatId !== ref.chatId) throw unavailable();
    return entry;
  };
  const receipt = (ref: Ref, status: Status): Receipt => ({ chatId: ref.chatId, turnId: ref.turnId, status });
  return {
    getSendTarget(supplied: BrowserChatGrant, { chatId }: { chatId: string }) {
      current(supplied);
      if (!uuid.test(chatId)) throw unavailable();
      const target = authority.target(chatId);
      for (const [id, entry] of turns) {
        if (entry.expires <= Date.now() && !["confirming", "running", "stop-requested"].includes(entry.status)) turns.delete(id);
      }
      if (turns.size >= 32) throw unavailable();
      const turnId = randomUUID(), revision = randomUUID();
      turns.set(turnId, { chatId, turnId, revision, target, expires: Date.now() + 120_000, status: "ready" });
      return { chatId, turnId, revision };
    },
    async sendChatTurn(supplied: BrowserChatGrant, input: Send): Promise<Receipt> {
      current(supplied);
      const entry = lookup(input);
      const text = input.text;
      if (!entry || entry.revision !== input.revision || typeof text !== "string" ||
          !text.trim() || text.length > 2000) throw unavailable();
      if (entry.status !== "ready") return receipt(entry, entry.status);
      const assertUnchanged = () => {
        current(supplied);
        if (entry.expires <= Date.now() || authority.target(entry.chatId).stamp !== entry.target.stamp) throw unavailable();
      };
      entry.status = "confirming";
      try {
        assertUnchanged();
        if (!await authority.confirm(entry.target.title, entry.chatId, text)) {
          entry.status = "not-sent";
          return receipt(entry, entry.status);
        }
        assertUnchanged();
      } catch {
        entry.status = "not-sent";
        return receipt(entry, entry.status);
      }
      const controller = new AbortController();
      entry.controller = controller;
      // Do not infer the result from a thrown transport or persistence error.
      try {
        entry.status = await authority.send(entry.chatId, text, {
          id: entry.turnId, signal: controller.signal, assertUnchanged,
          onPersisted(canStop) { entry.canStop = canStop; entry.status = "running"; },
        });
      } catch {
        entry.status = "unknown";
      } finally {
        entry.controller = undefined;
        entry.canStop = undefined;
        entry.expires = Date.now() + 120_000;
      }
      current(supplied);
      return receipt(entry, entry.status);
    },
    stopChatTurn(supplied: BrowserChatGrant, ref: Ref): Receipt {
      current(supplied);
      const entry = lookup(ref);
      if (!entry || !entry.controller || entry.status !== "running" || !entry.canStop?.()) throw unavailable();
      entry.status = "stop-requested";
      entry.controller.abort();
      return receipt(entry, entry.status);
    },
    getChatTurn(supplied: BrowserChatGrant, ref: Ref): Receipt {
      current(supplied);
      return receipt(ref, lookup(ref)?.status || "unknown");
    },
  };
}
