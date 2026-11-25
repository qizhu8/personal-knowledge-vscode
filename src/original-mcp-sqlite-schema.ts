import { createHash } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";

export type OriginalMcpSqliteSchema = Array<Record<string, SQLOutputValue>>;
export function verifyOriginalMcpOptionalSchemaGroup(schema: OriginalMcpSqliteSchema,
  ddl: string, names: readonly string[]): Set<string> {
  const oracle = new DatabaseSync(":memory:");
  try {
    oracle.exec(ddl);
    const expected = oracle.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
    const actual = schema.filter(row => names.includes(String(row.tbl_name)));
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    if (digest(actual) !== digest(expected))
      throw new CoreError("RECOVERY_REQUIRED", "Cold native SQLite read refuses altered or incomplete optional admission DDL.");
    return new Set(expected.map(row => String(row.name)));
  } finally { oracle.close(); }
}
