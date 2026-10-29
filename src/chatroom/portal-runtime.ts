import { PortalObservation } from "./portal-observation";

export interface PortalSource {
  hostname: string;
  endpoint: string;
  chatId?: string;
  chatName: string;
  participantId: string;
}

export function validPortalSource(value: unknown): value is PortalSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  for (const [field, maximum] of [["hostname", 255], ["endpoint", 1024], ["chatName", 200], ["participantId", 200]] as const) {
    const text = source[field];
    if (typeof text !== "string" || !text.length || text.length > maximum || /[\x00-\x1f]/.test(text)) return false;
  }
  return source.chatId === undefined || typeof source.chatId === "string" && /^[a-f0-9-]{36}$/.test(source.chatId);
}

interface PortalRuntime {
  state(chatId: string): Record<string, unknown> | undefined;
  permission(chatId: string, tool: string, resource?: string): boolean;
  invalidate(chatId: string): void;
  chatRemoved?(chatId: string): Promise<void>;
}
let runtime: PortalRuntime | undefined;
const listeners = new Set<() => void>();

export function configurePortalRuntime(value: PortalRuntime): void { runtime = value; }
export function portalState(chatId: string): Record<string, unknown> | undefined { return runtime?.state(chatId); }
/** resource: resolved absolute path for files-* tools; folder-scoped grants deny when it is absent or outside. */
export function portalToolAllowed(chatId: string, tool: string, resource?: string): boolean { return runtime?.permission(chatId, tool, resource) === true; }
export function invalidatePortalPermissions(chatId: string): void { runtime?.invalidate(chatId); }
export async function portalChatRemoved(chatId: string): Promise<void> { await runtime?.chatRemoved?.(chatId); }
// One failing view must not stop other listeners or the caller's Room push.
export function portalChanged(): void {
  for (const listener of listeners) {
    try { listener(); } catch (error) { console.error(`PKM Portal state listener failed: ${error instanceof Error ? error.stack || error.message : String(error)}`); }
  }
}
export function onPortalChanged(listener: () => void): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
}

export type PortalObserver = (value: PortalObservation) => void;

export interface PortalReview {
  id: string;
  pairId: string;
  requestId: string;
  state: "awaiting-approval" | "waiting-approval" | "waiting-input" | "restricted" | "completed" | "failed" | "cancelled" | "denied" | "unknown";
}

export function validPortalReview(value: unknown): value is PortalReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ["id", "pairId", "requestId"].every(key => typeof item[key] === "string" && /^[a-f0-9-]{36}$/.test(String(item[key])))
    && ["awaiting-approval", "waiting-approval", "waiting-input", "restricted", "completed", "failed", "cancelled", "denied", "unknown"].includes(String(item.state));
}
