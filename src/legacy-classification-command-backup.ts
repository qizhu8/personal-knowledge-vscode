import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { LEGACY_CLASSIFICATION_COMMAND_ID } from "./legacy-classification-command-contracts.js";
import {
  inspectLegacyClassificationCommand, validateLegacyClassificationCommandLayout,
  type LegacyClassificationCommandHost,
} from "./legacy-classification-command.js";
import { scanNativeClassification } from "./legacy-classification-native.js";
import type { NativeClassificationBackupRequest } from "./workspace-backup.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface OriginalClassificationBackupPolicy {
  originalCompatible: true;
  sourceRootId: string;
  assertFixtureOwnership(): void;
  assertHistoryAnchor: LegacyClassificationCommandHost["assertHistoryAnchor"];
  assertAdoptionAnchor?: LegacyClassificationCommandHost["assertAdoptionAnchor"];
}
export function originalClassificationBackupHost(policy: OriginalClassificationBackupPolicy) {
  return {
    assertOwnedDisposableFixture: policy.assertFixtureOwnership,
    assertAdoptionAnchor: policy.assertAdoptionAnchor,
    globalReceipt(db: DatabaseSync, id: string) {
      const row = db.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(id);
      return row ? { fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result)) } : null;
    },
  };
}
export function verifyOriginalClassificationBackupHistory(db: DatabaseSync, workspaceId: string, root: string,
  policy: OriginalClassificationBackupPolicy, backupRequest?: Readonly<NativeClassificationBackupRequest>) {
  policy.assertFixtureOwnership();
  const host = originalClassificationBackupHost(policy);
  const history = inspectLegacyClassificationCommand(db, host);
  for (const i of history.receipts) {
    const global = db.prepare("SELECT actor_id,operation FROM receipts WHERE operation_id=?").get(i.request.operationId);
    if (!global || global.actor_id !== i.actor.id || global.operation !== LEGACY_CLASSIFICATION_COMMAND_ID)
      throw new CoreError("RECOVERY_CONFLICT", "Original classification global provenance differs.", "unknown");
  }
  const scan = scanNativeClassification(db, host, root);
  const logicalPin = backupRequest ? { dev: backupRequest.rootDevice, ino: backupRequest.rootInode } : scan.pin;
  const status = validateLegacyClassificationCommandLayout(history, { workspaceId, sourceRootId: policy.sourceRootId }, scan, logicalPin);
  const first = history.receipts[0] ?? history.pending;
  const genesisSha256 = first ? hash(first.before) : scan.layoutSha256, historySha256 = hash(history.receipts);
  if (backupRequest && (status.status !== "committed" || backupRequest.genesisSha256 !== genesisSha256
    || backupRequest.historySha256 !== historySha256 || backupRequest.layoutSha256 !== scan.layoutSha256))
    throw new CoreError("RECOVERY_CONFLICT", "Original classification backup source pins differ.", "unknown");
  policy.assertHistoryAnchor(Object.freeze({ workspaceId, sourceRootId: policy.sourceRootId,
    rootPin: first?.rootPin ?? logicalPin, genesisSha256, historySha256 }));
  return { history, scan, status, genesisSha256, historySha256,
    lineage: { rootPins: history.rootPins.length ? history.rootPins : [logicalPin], adoptions: history.adoptions } };
}
export function verifyOriginalClassificationBackup(db: DatabaseSync, request: Readonly<NativeClassificationBackupRequest>,
  root: string, policy: OriginalClassificationBackupPolicy) {
  return verifyOriginalClassificationBackupHistory(db, request.workspaceId, join(root, request.sourceRelative), policy, request);
}
