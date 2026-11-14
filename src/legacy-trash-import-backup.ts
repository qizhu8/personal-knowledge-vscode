import { randomUUID } from "node:crypto";
import { backup as sqliteBackup } from "node:sqlite";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  authorizeLegacyTrashNative, inspectLegacyTrashNative, rebindLegacyTrashBackup, validateLegacyTrashAdoptionReceipt,
  type LegacyTrashAdoptionReceipt, type LegacyTrashNativeHost,
} from "./legacy-trash-import-native.js";
import {
  legacyTrashImportSha256 as hash, publishLegacyTrashStage, snapshotLegacyTrashTree,
  trashImportAbsent, trashImportFail, trashImportRead, trashImportRealDirectory, trashImportSync, trashImportWrite,
} from "./legacy-trash-import.js";
import { legacyTrashFileSchema } from "./domain/legacy-trash-import-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const portableEntry = legacyTrashFileSchema.omit({ dev: true, ino: true });
const backupSchema = z.strictObject({
  schema: z.literal("pkm.legacy-trash-backup/v1"),
  workspaceId: z.string().min(1),
  receipt: z.unknown(),
  inventory: z.array(portableEntry).max(8192),
  files: z.array(z.strictObject({ path: z.string(), bytes: z.string() })).max(8192),
  sqlite: z.string(),
  sqliteSha256: digest,
  sha256: digest,
});
type Backup = z.infer<typeof backupSchema>;
const maximumBackup = 256 * 1024 * 1024;
function portable(inventory: Awaited<ReturnType<typeof snapshotLegacyTrashTree>>["inventory"]) {
  return inventory.map(({ dev: _dev, ino: _ino, ...entry }) => entry);
}
function validateBackup(bytes: Buffer, expected: string): Backup {
  if (hash(bytes) !== expected || !Buffer.from(bytes.toString("utf8")).equals(bytes)) trashImportFail("TAMPER", "Backup requires the externally trusted exact byte digest.");
  const backup = backupSchema.parse(JSON.parse(bytes.toString("utf8")));
  const { sha256, ...body } = backup;
  if (sha256 !== hash(JSON.stringify(body)) || hash(Buffer.from(backup.sqlite, "base64")) !== backup.sqliteSha256) trashImportFail("TAMPER", "Backup manifest/database digest changed.");
  const known = new Set<string>();
  for (const entry of backup.inventory) {
    if (!/^(notes|skills|papers)(?:\/|$)/.test(entry.path) || entry.path.split("/").some(part =>
      !part || part === "." || part === ".." || /[\\\u0000-\u001f]|secret|credential|private.?key|token|^\.env(?:\.|$)|\.(?:pem|key)$/i.test(part))
      || known.has(entry.path)) trashImportFail("UNSAFE_PATH", "Backup contains unqualified paths or collisions.");
    known.add(entry.path);
    if (entry.kind === "directory" ? entry.size !== 0 || entry.sha256 !== null : entry.sha256 === null) trashImportFail("TAMPER", "Invalid backup content pin.");
  }
  const paths = backup.files.map(file => file.path);
  if (new Set(paths).size !== paths.length || paths.length !== backup.inventory.filter(item => item.kind === "file").length) trashImportFail("TAMPER", "Backup has duplicate or missing file bytes.");
  for (const file of backup.files) {
    const bytes = Buffer.from(file.bytes, "base64"), item = backup.inventory.find(item => item.path === file.path);
    if (!item || item.kind !== "file" || item.size !== bytes.length || item.sha256 !== hash(bytes)
      || file.bytes !== bytes.toString("base64")) trashImportFail("TAMPER", "Backup opaque content changed.");
  }
  return backup;
}
/** Isolated qualified backup seam, not an opt-in to the existing shared backup allowlist. */
export async function captureLegacyTrashBackup(host: LegacyTrashNativeHost, actor: string, file: string): Promise<string> {
  authorizeLegacyTrashNative(host, actor, "knowledge.trash.backup");
  file = resolve(file);
  await trashImportRealDirectory(dirname(file));
  if (!await trashImportAbsent(file)) trashImportFail("COLLISION", "Backup file must be absent.");
  return host.withWriterLock(async () => {
    const before = await inspectLegacyTrashNative(host);
    const databaseStage = `${file}.sqlite-stage-${randomUUID()}`;
    try {
      await sqliteBackup(host.database, databaseStage);
      const sqlite = await trashImportRead(dirname(databaseStage), databaseStage.slice(dirname(databaseStage).length + 1), 67_108_864);
      const after = await inspectLegacyTrashNative(host);
      if (JSON.stringify(before.receipt) !== JSON.stringify(after.receipt)
        || JSON.stringify(before.snapshot.inventory) !== JSON.stringify(after.snapshot.inventory)) trashImportFail("SOURCE_CHANGED", "Native state changed during backup.");
      const body = {
        schema: "pkm.legacy-trash-backup/v1" as const, workspaceId: host.workspaceId, receipt: before.receipt,
        inventory: portable(before.snapshot.inventory),
        files: [...before.snapshot.files].map(([path, bytes]) => ({ path, bytes: bytes.toString("base64") })),
        sqlite: sqlite.toString("base64"), sqliteSha256: hash(sqlite),
      };
      const bytes = Buffer.from(JSON.stringify({ ...body, sha256: hash(JSON.stringify(body)) }));
      if (bytes.length > maximumBackup) trashImportFail("LIMIT", "Backup exceeds its conservative bound.");
      await trashImportWrite(dirname(file), file.slice(dirname(file).length + 1), bytes);
      await trashImportSync(dirname(file));
      return hash(bytes);
    } finally {
      if (!await trashImportAbsent(databaseStage)) await unlink(databaseStage);
    }
  });
}
export interface LegacyTrashBackupAuthority {
  backupFile: string; backupSha256: string; workspaceId: string; actorId: string;
  trustedImportPlanSha256: string;
  destination: string; stage: string; layoutVersion: "pkm.trash-lifecycle/v1";
}
/** Host factory owns the isolated connection/transaction/index. Restore cannot register a
 * production root or acquire a competing lock. The caller supplies trusted backup digest. */
export async function restoreLegacyTrashBackup(
  authority: LegacyTrashBackupAuthority,
  hostFactory: (root: string, workspaceId: string) => Promise<LegacyTrashNativeHost & { close(): Promise<void> }>,
  authorize?: (authority: LegacyTrashBackupAuthority) => boolean,
): Promise<void> {
  if (!authorize?.(authority) || authority.layoutVersion !== "pkm.trash-lifecycle/v1"
    || [authority.backupFile, authority.destination, authority.stage].some(path => path !== resolve(path))
    || dirname(authority.destination) !== dirname(authority.stage) || authority.destination === authority.stage
    || !authority.actorId || !authority.workspaceId
    || [authority.stage, authority.destination].some(path => authority.backupFile === path || authority.backupFile.startsWith(path + "/"))
    || [authority.stage, authority.destination].some((path, i, all) => path.startsWith(all[1 - i]! + "/"))) {
    trashImportFail("AUTHORITY_REQUIRED", "Exact nonoverlapping authenticated absent backup restore layout is required.");
  }
  await trashImportRealDirectory(dirname(authority.stage));
  if (!await trashImportAbsent(authority.stage) || !await trashImportAbsent(authority.destination)) trashImportFail("COLLISION", "Backup restore never overwrites stage/destination.");
  const backup = validateBackup(await trashImportRead(dirname(authority.backupFile), authority.backupFile.slice(dirname(authority.backupFile).length + 1), maximumBackup), authority.backupSha256);
  if (backup.workspaceId !== authority.workspaceId) trashImportFail("TAMPER", "Backup workspace identity changed.");
  validateLegacyTrashAdoptionReceipt(backup.receipt, authority.trustedImportPlanSha256);
  await mkdir(authority.stage, { mode: 0o700 });
  for (const item of backup.inventory.filter(item => item.kind === "directory").sort((a, b) =>
    a.path.split("/").length - b.path.split("/").length)) await mkdir(join(authority.stage, item.path), { mode: 0o700 });
  for (const file of backup.files) await trashImportWrite(authority.stage, file.path, Buffer.from(file.bytes, "base64"));
  await trashImportWrite(authority.stage, "core.sqlite", Buffer.from(backup.sqlite, "base64"));
  const staged = await snapshotLegacyTrashTree(authority.stage, true);
  if (JSON.stringify(portable(staged.inventory)) !== JSON.stringify(backup.inventory)) trashImportFail("TAMPER", "Copied backup does not match authenticated portable inventory.");
  const host = await hostFactory(authority.stage, authority.workspaceId);
  try {
    authorizeLegacyTrashNative(host, authority.actorId, "knowledge.trash.backup");
    if (host.root !== authority.stage || host.workspaceId !== authority.workspaceId
      || host.trustedImportPlanSha256 !== authority.trustedImportPlanSha256) trashImportFail("AUTHORITY_REQUIRED", "Backup factory returned a different root/workspace/import authority.");
    await host.withWriterLock(() => rebindLegacyTrashBackup(host, backup.receipt as LegacyTrashAdoptionReceipt, authority.backupSha256));
  } finally { await host.close(); }
  for (const item of backup.inventory.filter(item => item.kind === "directory").sort((a, b) =>
    b.path.split("/").length - a.path.split("/").length)) await trashImportSync(join(authority.stage, item.path));
  await trashImportSync(authority.stage);
  // Root binding is finalized only after the no-replace filesystem publication.
  await publishLegacyTrashStage(authority.stage, authority.destination);
  const published = await hostFactory(authority.destination, authority.workspaceId);
  try {
    const row = published.database.prepare("SELECT receipt_json FROM legacy_trash_import_receipt WHERE workspace_id=?").get(authority.workspaceId);
    const receipt = JSON.parse(String(row?.receipt_json)) as LegacyTrashAdoptionReceipt;
    await published.withWriterLock(() => rebindLegacyTrashBackup(published, receipt, authority.backupSha256));
  } finally { await published.close(); }
}
