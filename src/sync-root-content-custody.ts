import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { coreDatabasePath } from "./workspace-storage-paths.js";
import { bootstrapTableRows, classifyStorageStartup, type BootstrapProfile } from "./storage-startup-classification.js";
import { STORAGE_BOOTSTRAP_PROFILE_JSON } from "./storage-bootstrap-profile.js";
import { readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { verifyOriginalMcpActionAuthoringReadSchema } from "./original-mcp-action-historical-schema.js";
import { verifyOriginalMcpOptionalSchemaGroup } from "./original-mcp-sqlite-schema.js";
import { originalMcpNativeHostReceiptDdl, originalMcpNativeHostReceiptTable,
  verifyOriginalMcpNativeHostReceiptDatabase } from "./original-mcp-native-host-receipt.js";
import { SyncPlanStore } from "./sync-plan-store.js";
import { readSyncApplyReceipt } from "./sync-apply.js";
import { syncApplyPlanSchema } from "./sync-apply-contracts.js";
import { syncPlanInputSchema } from "./sync-plan-contracts.js";
import { syncPlanHash } from "./sync-plan.js";
import { dataRuntimeDefinitions } from "./data-runtime-contracts.js";
import { readSyncContentFile } from "./sync-content-local.js";
import { validateSyncContentState } from "./sync-content.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fail(): never { throw new Error("Current native Sync byte custody is absent, unknown or changed; preserve all source and pending effects."); }

/** Passive root admission from genuine completed native byte receipts; never an execution/source grant. */
export function verifyNativeSyncRootContent(root: string, area: "servers" | "profiles" | "action-module-sets"): void {
  const file = coreDatabasePath(root), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || process.getuid !== undefined && stat.uid !== process.getuid()) fail();
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    database.exec("BEGIN DEFERRED");
    const classification = classifyStorageStartup(root, database);
    if (classification.kind !== "full-required") fail();
    if (classification.reason !== "durable-state") {
      if (classification.reason !== "schema") fail();
      const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
      const journal = readOriginalMcpJournal(root);
      const verified = new Set(verifyOriginalMcpActionAuthoringReadSchema(root, database, schema, journal));
      if (!verified.size) fail();
      if (schema.some(row => row.tbl_name === originalMcpNativeHostReceiptTable)) {
        if (!journal) fail();
        for (const name of verifyOriginalMcpOptionalSchemaGroup(schema, originalMcpNativeHostReceiptDdl,
          [originalMcpNativeHostReceiptTable])) verified.add(name);
        for (const row of database.prepare(`SELECT receipt_sha256 FROM ${originalMcpNativeHostReceiptTable}`).iterate())
          verifyOriginalMcpNativeHostReceiptDatabase(database, journal, String(row.receipt_sha256));
      }
      const remaining = hash(JSON.stringify(schema.filter(row => !verified.has(String(row.name)))));
      const profile = JSON.parse(STORAGE_BOOTSTRAP_PROFILE_JSON) as BootstrapProfile;
      const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
      const active = [profile, ...profile.derivedProfiles].find(candidate =>
        candidate.databaseVersion === version && candidate.schemaSha256 === remaining);
      if (!active || active.tables.some(table => table.role === "seed"
        && bootstrapTableRows(database, table.name) !== table.rows)) fail();
    }
    const identity = JSON.parse(readSyncContentFile(root, ".pkm-next-workspace").toString("utf8"));
    if (identity.schema !== "pkm.next-workspace/v2" || typeof identity.id !== "string") fail();
    const owner = database.prepare("SELECT owner_id,fence FROM native_runtime_owner WHERE singleton=1").get();
    if (!owner || typeof owner.owner_id !== "string" || Number(owner.fence) < 1) fail();
    const store = new SyncPlanStore(database), expected = new Map<string, string>(), directories = new Set([area as string]);
    let evidence = false;
    for (const row of database.prepare("SELECT * FROM sync_apply_journal ORDER BY rowid").all()) {
      const plan = syncApplyPlanSchema.parse(JSON.parse(String(row.plan_json)));
      if (![...plan.guards, ...plan.actions].some(member => member.path.startsWith(area + "/"))) continue;
      if (row.state !== "completed" || row.root_path !== root) fail();
      const input = syncPlanInputSchema.parse(JSON.parse(String(row.input_json)));
      for (const side of ["base", "local", "remote"] as const) {
        if (syncPlanHash(input[side].manifest) !== input[side].sha256 || input[side].sha256 !== plan.sourcePins[side]) fail();
      }
      const receipt = readSyncApplyReceipt(store, plan.planHash, root);
      if (!receipt || receipt.applyId !== row.apply_id || receipt.actorId !== row.actor_id) fail();
      const local = database.prepare("SELECT * FROM receipts WHERE operation='sync.apply' AND actor_id=? AND result=?")
        .all(plan.actorId, JSON.stringify(receipt));
      let shared = local.some(record => {
        const args = dataRuntimeDefinitions.find(definition => definition.id === "sync.apply")!.input.parse({
          sessionId: plan.sessionId, input, operationId: record.operation_id, expectedPlanHash: plan.planHash,
        });
        return record.fingerprint === hash(JSON.stringify({ operation: "sync.apply", actorId: plan.actorId, args }));
      });
      if (!shared) {
        const remote = database.prepare("SELECT * FROM remote_runtime_intents WHERE kind='remote.sync.apply' AND actor_id=? AND state='complete' AND result_json=?")
          .all(plan.actorId, JSON.stringify(receipt));
        shared = remote.some(record => {
          const fingerprint = syncPlanHash({ workspaceId: identity.id, actorId: plan.actorId, kind: "remote.sync.apply",
            operationId: record.operation_id, sessionId: plan.sessionId, input });
          return record.fingerprint === fingerprint && !!database.prepare(
            "SELECT 1 FROM receipts WHERE operation_id=? AND actor_id=? AND operation='remote.sync.apply' AND fingerprint=?")
            .get(record.operation_id, plan.actorId, fingerprint);
        });
      }
      if (!shared) fail();
      evidence = true;
      for (const member of [...plan.guards, ...plan.actions].filter(member => member.path.startsWith(area + "/"))) {
        const parts = member.path.split("/");
        for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join("/"));
      }
      for (const guard of plan.guards.filter(member => member.path.startsWith(area + "/"))) {
        if (guard.sha256) expected.set(guard.path, guard.sha256);
      }
      for (const action of plan.actions.filter(member => member.type === area)) {
        if (action.afterSha256 === null) expected.delete(action.path);
        else expected.set(action.path, action.afterSha256);
      }
      for (const side of ["local", "remote"] as const)
        validateSyncContentState(input[side].manifest.files.filter(member => member.type === area));
    }
    if (!evidence) fail();
    const observed = new Set<string>();
    const walk = (relative: string): void => {
      const location = path.join(root, relative), before = fs.lstatSync(location);
      if (!directories.has(relative) || !before.isDirectory() || before.isSymbolicLink()
        || process.getuid !== undefined && before.uid !== process.getuid()
        || area === "profiles" && process.platform !== "win32" && (before.mode & 0o077) !== 0) fail();
      for (const name of fs.readdirSync(location).sort()) {
        const member = relative + "/" + name, child = fs.lstatSync(path.join(root, member));
        if (child.isDirectory() && !child.isSymbolicLink()) walk(member);
        else {
          const wanted = expected.get(member);
          if (!wanted || area === "profiles" && process.platform !== "win32" && (child.mode & 0o077) !== 0
            || hash(readSyncContentFile(root, member)) !== wanted) fail();
          observed.add(member);
        }
      }
      const after = fs.lstatSync(location);
      if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail();
    };
    walk(area);
    if (observed.size !== expected.size) fail();
  } finally {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
  }
}
