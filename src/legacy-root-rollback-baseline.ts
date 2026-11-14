import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { LegacyImportError } from "./legacy-import.js";

/** Snapshot all persistent SQLite content except the ephemeral workspace lease. */
export function legacyRollbackDatabaseFingerprint(database: DatabaseSync): string {
  const hash = createHash("sha256");
  let bytes = 0;
  const add = (value: string) => {
    const encoded = Buffer.from(value, "utf8");
    bytes += encoded.length;
    if (bytes > 134_217_728) throw new LegacyImportError("RECOVERY_REQUIRED", "Rollback baseline exceeds its bounded inspection limit.");
    hash.update(String(encoded.length)).update(":").update(encoded);
  };
  const scalar = (value: unknown): unknown => {
    if (value === null) return ["null"];
    if (typeof value === "bigint") return ["integer", value.toString()];
    if (typeof value === "number") return ["number", Object.is(value, -0) ? "-0" : String(value)];
    if (typeof value === "string") return ["text", value];
    if (value instanceof Uint8Array) return ["blob", Buffer.from(value).toString("base64")];
    throw new LegacyImportError("RECOVERY_REQUIRED", "Rollback baseline contains an unsupported SQLite value.");
  };
  database.exec("BEGIN");
  try {
    const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
    add(JSON.stringify(schema));
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
    for (const row of tables) {
      const name = String(row.name);
      if (name === "native_runtime_owner") continue;
      add(name);
      const statement = database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`);
      statement.setReadBigInts(true);
      const values: string[] = [];
      for (const entry of statement.iterate()) {
        const encoded = JSON.stringify(Object.keys(entry).sort().map(key => [key, scalar(entry[key])]));
        bytes += Buffer.byteLength(encoded);
        if (bytes > 134_217_728) throw new LegacyImportError("RECOVERY_REQUIRED", "Rollback baseline exceeds its bounded inspection limit.");
        values.push(encoded);
      }
      values.sort();
      for (const value of values) add(value);
    }
    database.exec("COMMIT");
    return hash.digest("hex");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
