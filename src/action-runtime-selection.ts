import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";

const selection = z.strictObject({
  actorId: z.string().min(1), actionId: z.string().min(1),
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/), implementationId: z.string().min(1),
});
export const actionRuntimeSelectionDdl = `CREATE TABLE action_runtime_selections(
 sequence INTEGER PRIMARY KEY,payload TEXT NOT NULL,payload_sha256 TEXT NOT NULL);
 CREATE TRIGGER action_runtime_selections_no_update BEFORE UPDATE ON action_runtime_selections
 BEGIN SELECT RAISE(ABORT,'Action selection immutable'); END;
 CREATE TRIGGER action_runtime_selections_no_delete BEFORE DELETE ON action_runtime_selections
 BEGIN SELECT RAISE(ABORT,'Action selection immutable'); END;`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function readActionImplementationSelections(database: DatabaseSync) {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='action_runtime_selections'").get()) return [];
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(actionRuntimeSelectionDdl);
    const schema = (db: DatabaseSync) => db.prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'action_runtime_selections%' ORDER BY name").all();
    if (JSON.stringify(schema(database)) !== JSON.stringify(schema(expected)))
      throw new CoreError("RECOVERY_CONFLICT", "Action selection journal schema changed.");
  } finally { expected.close(); }
  return database.prepare("SELECT payload,payload_sha256 FROM action_runtime_selections ORDER BY sequence").all().map(row => {
    if (hash(String(row.payload)) !== row.payload_sha256) throw new CoreError("RECOVERY_CONFLICT", "Action selection bytes changed.");
    return selection.parse(JSON.parse(String(row.payload)));
  });
}
export function selectedActionImplementation(database: DatabaseSync, actorId: string, actionId: string, definitionDigest: string) {
  return readActionImplementationSelections(database).findLast(item => item.actorId === actorId && item.actionId === actionId
    && item.definitionDigest === definitionDigest)?.implementationId;
}
export function recordActionImplementation(database: DatabaseSync, input: z.infer<typeof selection>) {
  const history = readActionImplementationSelections(database);
  if (history.length >= 4096) throw new CoreError("RESOURCE_LIMIT", "Action selection journal capacity reached.");
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='action_runtime_selections'").get()) database.exec(actionRuntimeSelectionDdl);
  const payload = JSON.stringify(selection.parse(input));
  database.prepare("INSERT INTO action_runtime_selections(payload,payload_sha256) VALUES(?,?)").run(payload, hash(payload));
}
