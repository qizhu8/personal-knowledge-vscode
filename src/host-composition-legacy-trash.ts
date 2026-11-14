import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { Storage } from "./storage.js";
import {
  LegacyTrashNativeAccess, type LegacyTrashNativeHost,
} from "./legacy-trash-import-native.js";
import {
  LegacyTrashImportError, legacyTrashStageReceiptPath, publishLegacyTrashStage, qualifyLegacyTrashAuthority,
  qualifyLegacyTrashSnapshotScope, stageLegacyTrashImport, trashImportAbsent, trashImportRealDirectory,
  trashImportRead, trashImportSync, verifyLegacyTrashSource, verifyLegacyTrashStage,
  type LegacyTrashImportPlan, type LegacyTrashLayoutAuthority, type LegacyTrashSnapshotScope,
} from "./legacy-trash-import.js";

export type NativeLegacyTrashOperation = Parameters<NonNullable<LegacyTrashNativeHost["authorize"]>>[1];

export interface NativeLegacyTrashPolicy {
  trustedImportPlanSha256: string;
  snapshotScope: LegacyTrashSnapshotScope;
  authorize(actorId: string, operation: NativeLegacyTrashOperation): boolean;
  recoveryActorId?: string;
  import?: { plan: LegacyTrashImportPlan; authority: LegacyTrashLayoutAuthority };
}

export function createNativeLegacyTrashAccess(options: {
  database: DatabaseSync;
  storage: Storage;
  root: string;
  workspaceId: string;
  policy: NativeLegacyTrashPolicy;
  transaction<T>(work: () => T): T;
  reconcileIndex(): void;
  assertOperationAvailable(operationId: string): void;
}): { host: LegacyTrashNativeHost; access: LegacyTrashNativeAccess } {
  if (!/^[a-f0-9]{64}$/.test(options.policy.trustedImportPlanSha256)
    || typeof options.policy.authorize !== "function" || !options.policy.snapshotScope) {
    throw new LegacyTrashImportError("AUTHORITY_REQUIRED", "Native trash requires external plan, scope and actor policy.");
  }
  const host: LegacyTrashNativeHost = {
    database: options.database,
    root: options.root,
    workspaceId: options.workspaceId,
    trustedImportPlanSha256: options.policy.trustedImportPlanSha256,
    snapshotScope: qualifyLegacyTrashSnapshotScope(options.policy.snapshotScope, true),
    withWriterLock: work => options.storage.withWorkspaceExclusive(work),
    transaction: options.transaction,
    reconcileIndex: options.reconcileIndex,
    assertOperationAvailable: options.assertOperationAvailable,
    authorize: (actorId, operation) => {
      try { return options.policy.authorize(actorId, operation) === true; } catch { return false; }
    },
  };
  return { host, access: new LegacyTrashNativeAccess(host) };
}

/** Publishes a complete imported workspace root; existing destinations are never merged. */
export async function publishLegacyTrashWorkspaceImport(
  plan: LegacyTrashImportPlan,
  authority: LegacyTrashLayoutAuthority,
  nativeScope: LegacyTrashSnapshotScope,
): Promise<{ root: string; workspaceId: string }> {
  z.string().uuid().parse(authority.workspaceId);
  const scope = qualifyLegacyTrashSnapshotScope(nativeScope, true);
  const trusted = qualifyLegacyTrashAuthority(plan, authority.destination, authority);
  await verifyLegacyTrashSource(plan);
  await stageLegacyTrashImport(plan, trusted.destination, trusted);
  const markerPath = join(trusted.stage, ".pkm-next-workspace");
  if (!await trashImportAbsent(markerPath)) {
    throw new LegacyTrashImportError("COLLISION", "Staged workspace identity marker must be absent.");
  }
  const marker = Buffer.from(JSON.stringify({ schema: "pkm.next-workspace/v2", id: trusted.workspaceId }));
  const handle = await open(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(marker); await handle.sync(); } finally { await handle.close(); }
  if (!marker.equals(await trashImportRead(trusted.stage, ".pkm-next-workspace", 4096))) {
    throw new LegacyTrashImportError("TAMPER", "Staged workspace identity marker changed.");
  }
  await trashImportSync(trusted.stage);
  await verifyLegacyTrashSource(plan);
  await verifyLegacyTrashStage(plan, trusted.stage, trusted, scope);
  await publishLegacyTrashStage(trusted.stage, trusted.destination);
  await trashImportRealDirectory(trusted.destination);
  if (!marker.equals(await trashImportRead(trusted.destination, ".pkm-next-workspace", 4096))) {
    throw new LegacyTrashImportError("TAMPER", "Published workspace identity marker changed.");
  }
  return { root: trusted.destination, workspaceId: trusted.workspaceId };
}

export { legacyTrashStageReceiptPath };
