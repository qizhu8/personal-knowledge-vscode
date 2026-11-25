export { VscodeClient, ClientError } from "./client.ts";
export type { Host, ServerBinding, ClientState, Document, DocumentPage, ChatSession, ChatTurn, ChatEvent,
  ManagerOverview, ManagerEvent, ManagerPage } from "./client.ts";
export type { OperationKey, OperationInput } from "./contracts.ts";
export { ChatActivity, ManagerActivity } from "./activity.ts";
export type { ActivityPage } from "./activity.ts";
export { bindWebview } from "./bridge.ts";
export type { WebviewHost } from "./bridge.ts";

import type { VscodeClient } from "./client.ts";

export interface CommandHost {
  registerCommand(id: string, handler: () => Promise<unknown> | unknown): { dispose(): void };
}
// Trusted extension host registers these only after a separate opt-in integration decision.
export function registerCommands(host: CommandHost, client: VscodeClient): { dispose(): void } {
  const registrations = [
    host.registerCommand("pkm.next.connect", () => client.connect()),
    host.registerCommand("pkm.next.disconnect", () => client.disconnect()),
    host.registerCommand("pkm.next.openHumanReview", () => client.openHumanReview()),
  ];
  return { dispose() { for (const registration of registrations) registration.dispose(); } };
}
