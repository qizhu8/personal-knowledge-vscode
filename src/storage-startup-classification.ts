import { createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { coreDatabasePath } from "./workspace-storage-paths.js";
import { STORAGE_BOOTSTRAP_PROFILE_JSON, STORAGE_BOOTSTRAP_PROFILE_SHA256 } from "./storage-bootstrap-profile.js";

export type RootClassification =
  | { kind: "plain"; database: "absent" | "owner-only-v0" | "plain-v23" }
  | { kind: "full-required"; reason: "layout" | "native-context" | "profile" | "schema" | "durable-state" };
export interface BootstrapTable {
  name: string;
  role: "owner" | "documents" | "derived" | "empty" | "seed";
  rows?: string;
}
export interface BootstrapProfile {
  schema: "pkm.storage-bootstrap-profile/v1";
  sourceSha256: string;
  sourceFiles: Array<{ path: string; sha256: string }>;
  databaseVersion: 23;
  schemaSha256: string;
  ownerSchemaSha256: string;
  tables: BootstrapTable[];
  derivedProfiles: Array<{ databaseVersion: 0 | 23; schemaSha256: string; tables: BootstrapTable[] }>;
}
export const bootstrapHash = (value: string): string => createHash("sha256").update(value).digest("hex");
export function bootstrapSchemaHash(database: DatabaseSync): string {
  return bootstrapHash(JSON.stringify(database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all()));
}
export function bootstrapTableRows(database: DatabaseSync, name: string): string {
  const rows = database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
  return JSON.stringify(rows.map(row => JSON.stringify(row)).sort());
}
// This caches release constants only, never workspace schema, rows, or admission.
let releaseProfileChecked = false;
let checkedReleaseProfile: BootstrapProfile | undefined;
function releaseProfile(): BootstrapProfile | undefined {
  if (releaseProfileChecked) return checkedReleaseProfile;
  releaseProfileChecked = true;
  try {
    if (!STORAGE_BOOTSTRAP_PROFILE_JSON || bootstrapHash(STORAGE_BOOTSTRAP_PROFILE_JSON) !== STORAGE_BOOTSTRAP_PROFILE_SHA256) return;
    const profile = JSON.parse(STORAGE_BOOTSTRAP_PROFILE_JSON) as BootstrapProfile;
    if (profile.schema !== "pkm.storage-bootstrap-profile/v1" || profile.databaseVersion !== 23
      || !/^[a-f0-9]{64}$/.test(profile.sourceSha256)
      || bootstrapHash(JSON.stringify(profile.sourceFiles)) !== profile.sourceSha256
      || !Array.isArray(profile.tables) || new Set(profile.tables.map(table => table.name)).size !== profile.tables.length
      || profile.tables.some(table => !["owner", "documents", "empty", "seed"].includes(table.role)
        || table.role === "seed" && typeof table.rows !== "string")
      || profile.tables.filter(table => table.role === "owner" && table.name === "native_runtime_owner").length !== 1
      || profile.tables.filter(table => table.role === "documents" && table.name === "documents").length !== 1
      || profile.tables.find(table => table.name === "receipts")?.role !== "empty"
      || !Array.isArray(profile.derivedProfiles)
      || profile.derivedProfiles.some(variant => ![0, 23].includes(variant.databaseVersion)
        || !/^[a-f0-9]{64}$/.test(variant.schemaSha256) || !Array.isArray(variant.tables)
        || variant.tables.some(table => !["owner", "documents", "derived", "empty", "seed"].includes(table.role)
          || table.role === "seed" && typeof table.rows !== "string"))) return;
    checkedReleaseProfile = profile;
    return checkedReleaseProfile;
  } catch { return; }
}
const emptyTableChecks = new WeakMap<DatabaseSync, { tables: BootstrapTable[]; statement: StatementSync }>();
function hasNonemptyTables(database: DatabaseSync, tables: BootstrapTable[]): boolean {
  let check = emptyTableChecks.get(database);
  if (check?.tables !== tables) {
    const empty = tables.filter(table => table.role === "empty");
    if (!empty.length) return false;
    const statement = database.prepare(`SELECT 1 WHERE ${empty.map(table =>
      `EXISTS(SELECT 1 FROM "${table.name.replaceAll('"', '""')}")`).join(" OR ")}`);
    check = { tables, statement };
    emptyTableChecks.set(database, check);
  }
  // Reuse compiled SQL only; every call executes against the caller's current snapshot.
  return check.statement.get() !== undefined;
}
export function classifyStorageStartup(root: string, connection?: DatabaseSync): RootClassification {
  const profile = releaseProfile();
  if (!profile) return { kind: "full-required", reason: "profile" };
  let database: DatabaseSync | undefined;
  let ownsTransaction = false;
  try {
    const path = coreDatabasePath(root), stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return { kind: "plain", database: "absent" };
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      return { kind: "full-required", reason: "schema" };
    database = connection ?? new DatabaseSync(path, { readOnly: true });
    if (!database.isTransaction) { database.exec("BEGIN DEFERRED"); ownsTransaction = true; }
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    const schemaHash = bootstrapSchemaHash(database);
    if (version === 0 && (schemaHash === bootstrapHash("[]") || schemaHash === profile.ownerSchemaSha256))
      return { kind: "plain", database: "owner-only-v0" };
    const active = version === profile.databaseVersion && schemaHash === profile.schemaSha256
      ? profile : profile.derivedProfiles.find(variant => variant.databaseVersion === version && variant.schemaSha256 === schemaHash);
    if (!active) return { kind: "full-required", reason: "schema" };
    for (const table of active.tables) {
      if (table.role === "seed" && bootstrapTableRows(database, table.name) !== table.rows)
        return { kind: "full-required", reason: "durable-state" };
    }
    if (hasNonemptyTables(database, active.tables)) return { kind: "full-required", reason: "durable-state" };
    return { kind: "plain", database: version === 0 ? "owner-only-v0" : "plain-v23" };
  } catch {
    return { kind: "full-required", reason: "schema" };
  } finally {
    if (ownsTransaction && database?.isTransaction) database.exec("ROLLBACK");
    if (!connection) database?.close();
  }
}
