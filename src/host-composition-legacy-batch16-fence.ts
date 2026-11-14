import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import {
  inspectNativeClassificationAdoptions, inspectNativeClassificationHistory, inspectNativeClassificationPending,
  type LegacyClassificationNativeHost,
} from "./legacy-classification-native.js";
import { validateLegacyMemoryErasureLedger } from "./legacy-memory-erasure.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectLegacyClassificationCommand } from "./legacy-classification-command.js";

/**
 * Until native ownership and restore authority are composed, unknown Batch16
 * journals must not be interpreted as permission to recover or publish.
 */
export function assertBatch16UnintegratedClear(database: DatabaseSync, allowMemoryInspection = false, workspaceId?: string,
  allowClassification = false, allowMemory = false, allowOriginalClassification = false): void {
  const names = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all().map(row => String(row.name)));
  const original = inspectLegacyClassificationCommand(database);
  if (!allowOriginalClassification && (original.pending || original.receipts.length))
    throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Original-compatible classification history requires explicit native fixture and root-adoption authority.", "unknown");
  if ([...names].some(name => name.startsWith("legacy_classification_native_"))) {
    const adoptions = inspectNativeClassificationAdoptions(database);
    if (adoptions.length && !allowClassification)
      throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Adopted classification history requires explicit native lineage authority.", "unknown");
    if (adoptions.length && allowClassification) {
      inspectNativeClassificationPending(database);
    } else {
      const host = {
        globalReceipt(db: DatabaseSync, id: string) {
          const row = db.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(id);
          return row ? { fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result)) } : null;
        },
      } as LegacyClassificationNativeHost;
      const history = inspectNativeClassificationHistory(database, host);
      if (!allowClassification && (history.pending || history.receipts.length))
        throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Native classification history requires explicit integrated fixture authority.", "unknown");
    }
  }
  if ([...names].some(name => /^legacy_memory_erasure_(?:schema|state|operations)$/.test(name))) {
    let id = workspaceId;
    if (!id) {
      const main = database.prepare("PRAGMA database_list").all().find(row => row.name === "main");
      if (main?.file) {
        const path = String(main.file);
        id = JSON.parse(readFileSync(join(path, "..", ".pkm-next-workspace"), "utf8")).id;
      }
    }
    if (!id) {
      if (!allowMemoryInspection) throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Memory ledger requires workspace identity.", "unknown");
      return;
    }
    const inspection = validateLegacyMemoryErasureLedger(database, id);
    if (!allowMemoryInspection && !allowMemory && inspection.state !== "uninitialized")
      throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Native memory erasure requires integrated trusted epoch and recovery authority.", "unknown");
  }
}
