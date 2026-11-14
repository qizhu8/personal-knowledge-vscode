import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./contracts.js";
import { inspectPortalLifecycleRecovery, type PortalLifecycleHost } from "./portal-lifecycle.js";

export type NativePortalPolicy = Pick<PortalLifecycleHost, "authorizeHuman" | "authorizeRoom" | "resolveChannelOwnerToken">;

export function assertPortalRecoveryClear(database: DatabaseSync): void {
  if (inspectPortalLifecycleRecovery(database).length) {
    throw new CoreError("PORTAL_OUTCOME_UNKNOWN", "Interrupted Portal effects require explicit native reconciliation; no invitation is replayed.", "unknown");
  }
}
