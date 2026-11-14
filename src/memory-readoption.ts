import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { sha256 } from "./file-write.js";
import { scanMarkdown } from "./markdown.js";
import { readLegacyMemoryImportReceipt } from "./memory-import.js";
import { openMemoryContinuitySnapshot, readMemoryScopeContinuity } from "./memory-scope-continuity.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const memoryHostPinSchema = z.strictObject({
  schema: z.literal("pkm.memory-host-pin/v1"),
  workspaceId: z.string().uuid(),
  actorId: z.literal("local:owner"),
  scope: z.string().min(1).max(1024),
  sourceScopeSha256: digest,
  sourceDatabaseSha256: digest,
  importPlanSha256: digest,
  importReceiptSha256: digest,
  receiptStateSha256: digest,
});
export type MemoryHostPin = z.infer<typeof memoryHostPinSchema>;

/** Evidence only. Approval requires an independently retained trusted-host copy of this pin. */
export function inspectMemoryHostPin(root: string, liveDatabase = false): MemoryHostPin {
  const stat = lstatSync(root);
  if (resolve(root) !== root || realpathSync(root) !== root || stat.isSymbolicLink() || !stat.isDirectory()
    || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new CoreError("NOT_AVAILABLE", "A private canonical isolated Memory workspace is required.");
  for (const name of [".pkm-next-workspace", "core.sqlite"]) {
    const item = lstatSync(join(root, name));
    if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1)
      throw new CoreError("NOT_AVAILABLE", "Memory provenance must remain in owned regular files.");
  }
  const marker = JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8"));
  if (!liveDatabase && (existsSync(join(root, "core.sqlite-journal"))
    || existsSync(join(root, "core.sqlite-wal")) && lstatSync(join(root, "core.sqlite-wal")).size > 0))
    throw new CoreError("NOT_AVAILABLE", "Read-only Memory reopening requires a closed checkpointed isolated database.");
  const database = liveDatabase ? new DatabaseSync(join(root, "core.sqlite"), { readOnly: true }) : openMemoryContinuitySnapshot(root);
  try {
    database.exec("BEGIN");
    const binding = readMemoryScopeContinuity(database, String(marker.id));
    const receipt = readLegacyMemoryImportReceipt(database, String(marker.id));
    if (!binding || binding.schema !== "pkm.memory-scope-continuity/v2" || binding.actorId !== "local:owner" || !receipt)
      throw new CoreError("NOT_AVAILABLE", "Exact v2 imported Memory provenance and an independent host pin are required.");
    const documents = scanMarkdown(root);
    for (const expected of receipt.documents) {
      const observed = documents.find(item => `${item.record.area}/${item.record.path}` === expected.path);
      if (!observed || observed.record.id !== expected.id || observed.record.sha256 !== expected.sha256)
        throw new CoreError("NOT_AVAILABLE", "Imported Memory bytes differ from the sealed source receipt.");
    }
    const original = database.prepare("SELECT * FROM legacy_memory_import_operations ORDER BY operation_id").all();
    const native = database.prepare(`SELECT r.operation_id,r.fingerprint,r.result,r.actor_id,r.operation,r.committed_at
      FROM receipts r JOIN legacy_memory_import_operations i ON i.operation_id=r.operation_id
      ORDER BY r.operation_id`).all();
    if (original.length !== receipt.operations || native.length !== original.length)
      throw new CoreError("NOT_AVAILABLE", "Imported Memory operation receipts are incomplete.");
    return memoryHostPinSchema.parse({
      schema: "pkm.memory-host-pin/v1", workspaceId: binding.workspaceId, actorId: binding.actorId,
      scope: binding.scope, sourceScopeSha256: binding.sourceScopeSha256,
      sourceDatabaseSha256: binding.sourceDatabaseSha256, importPlanSha256: binding.importPlanSha256,
      importReceiptSha256: binding.importReceiptSha256,
      receiptStateSha256: sha256(JSON.stringify({ receipt, original, native })),
    });
  } finally { database.close(); }
}
