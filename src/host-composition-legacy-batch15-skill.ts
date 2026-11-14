import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import type { Storage } from "./storage.js";
import { resourcePath } from "./document-path.js";
import {
  legacySkillBindingSchema, legacySkillLifecycleInputSchema, legacySkillLifecycleOutputSchema,
  legacySkillManifestHash, type LegacySkillBinding, type LegacySkillInput, type LegacySkillPlan,
} from "./legacy-skill-lifecycle.js";
import {
  executeNativeLegacySkillLifecycle, recoverNativeLegacySkillLifecycle, scanNativeLegacySkillTree,
  validateNativeLegacySkillJournalSchema, type LegacySkillNativeAuthority,
} from "./legacy-skill-lifecycle-native.js";
import { assertSharedSourceRecoveryScope, inspectPausedSnapshotJournal } from "./host-composition-legacy-snapshot-restore.js";
import { assertSkillSourceIntegrated, inspectSkillSourceActivity } from "./host-composition-legacy-skill-source.js";

export const BATCH15_SKILL_HISTORY_DDL = `
CREATE TABLE IF NOT EXISTS legacy_skill_native_history (
 operation_id TEXT PRIMARY KEY, record TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS legacy_skill_native_history_no_update BEFORE UPDATE ON legacy_skill_native_history
BEGIN SELECT RAISE(ABORT,'Skill history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_skill_native_history_no_delete BEFORE DELETE ON legacy_skill_native_history
BEGIN SELECT RAISE(ABORT,'Skill history is immutable'); END;`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprint = (actor: Actor, binding: LegacySkillBinding, input: LegacySkillInput) =>
  hash({ actor, binding, operation: `legacy.skill.router.${input.action}`, input });

export interface NativeBatch15SkillAdmission {
  binding: LegacySkillBinding;
  sourceRelative: string;
  destinationRelative: string;
}
export interface NativeBatch15SkillPolicy {
  /** Narrow native-owned disposable fixture only. A SQLite lease alone is insufficient. */
  scope: "exclusive-native-disposable-fixture";
  admissionForActor(actor: Readonly<Actor>): NativeBatch15SkillAdmission | undefined;
  /** Live, I/O-free exclusion of every external writer, including parent replacement. */
  assertFixtureOwnership(admission: Readonly<NativeBatch15SkillAdmission>): void;
  authorize(actor: Readonly<Actor>, admission: Readonly<NativeBatch15SkillAdmission>, action: LegacySkillInput["action"]): boolean;
  approveRetry(actor: Readonly<Actor>, plan: LegacySkillPlan): boolean;
}
function roots(root: string, admission: NativeBatch15SkillAdmission) {
  for (const path of [admission.sourceRelative, admission.destinationRelative]) {
    if (!resourcePath.safeParse(path).success || !path.startsWith("packages/"))
      throw new CoreError("ACCESS_DENIED", "Skill fixture roots must be contained in workspace packages.");
  }
  return { source: join(root, admission.sourceRelative), destination: join(root, admission.destinationRelative) };
}
export function inspectBatch15SkillPending(db: DatabaseSync) {
  validateNativeLegacySkillJournalSchema(db);
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(BATCH15_SKILL_HISTORY_DDL);
    const sql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name IN ('legacy_skill_native_history','legacy_skill_native_history_no_update','legacy_skill_native_history_no_delete') ORDER BY name";
    if (JSON.stringify(expected.prepare(sql).all()) !== JSON.stringify(db.prepare(sql).all()))
      throw new CoreError("RECOVERY_CONFLICT", "Skill history schema changed.", "unknown");
  } finally { expected.close(); }
  const row = db.prepare("SELECT * FROM legacy_skill_native_intent WHERE singleton=1").get();
  if (row) {
    try {
      const plan = JSON.parse(String(row.plan_json)), pins = JSON.parse(String(row.roots_json));
      const binding = legacySkillBindingSchema.parse(plan.binding);
      const input = legacySkillLifecycleInputSchema.parse(plan.input);
      const result = legacySkillLifecycleOutputSchema.parse(plan.result);
      if (input.operationId !== row.operation_id || result.operationId !== input.operationId || result.action !== input.action
        || !binding.actorId || !/^[a-f0-9]{64}$/.test(String(row.fingerprint))
        || hash({ planJson: row.plan_json, rootsJson: row.roots_json, fingerprint: row.fingerprint }) !== row.plan_sha256
        || ![pins.source, pins.destination].every(pin => pin && /^\d+$/.test(pin.dev) && /^\d+$/.test(pin.ino))) throw new Error();
    } catch { throw new CoreError("RECOVERY_CONFLICT", "Skill intent identity or complete durable payload changed.", "unknown"); }
  }
  return row;
}
export function assertBatch15OtherPending(db: DatabaseSync, allowSkillSource = false) {
  assertSharedSourceRecoveryScope(db, false, !allowSkillSource, allowSkillSource);
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const name = String(row.name);
    if ((/journal|_pending$/i.test(name))
      && db.prepare(`SELECT 1 FROM "${name.replaceAll('"', '""')}" LIMIT 1`).get())
      throw new CoreError("RECOVERY_CONFLICT", "Another pending or unknown journal blocks Skill effects.", "unknown");
  }
  if (inspectPausedSnapshotJournal(db)) throw new CoreError("RECOVERY_REQUIRED", "Snapshot effect is unknown.", "unknown");
}
export function captureBatch15SkillHistory(db: DatabaseSync, workspaceId: string) {
  if (inspectBatch15SkillPending(db)) throw new CoreError("RECOVERY_REQUIRED", "Skill intent requires exact native retry; never startup apply.", "unknown");
  const rows = db.prepare("SELECT operation_id,record FROM legacy_skill_native_history ORDER BY rowid").all();
  if (rows.length !== Number(db.prepare("SELECT COUNT(*) n FROM legacy_skill_native_receipt").get()!.n))
    throw new CoreError("RECOVERY_CONFLICT", "Skill history and local receipts differ.", "unknown");
  const heads = new Map<string, { admission: NativeBatch15SkillAdmission; sourceSha256: string; result: ReturnType<typeof legacySkillLifecycleOutputSchema.parse> }>();
  for (const row of rows) {
    try {
      const record = JSON.parse(String(row.record));
      const binding = legacySkillBindingSchema.parse(record.admission.binding);
      const input = legacySkillLifecycleInputSchema.parse(record.input);
      const result = legacySkillLifecycleOutputSchema.parse(record.result);
      const global = db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(row.operation_id!);
      const local = db.prepare("SELECT * FROM legacy_skill_native_receipt WHERE operation_id=?").get(row.operation_id!);
      const pin = fingerprint(record.actor, binding, input);
      if (input.operationId !== row.operation_id || result.operationId !== input.operationId || result.action !== input.action
        || binding.workspaceId !== workspaceId || record.actor.canWrite !== true
        || !global || !local || global.fingerprint !== pin || local.fingerprint !== pin
        || global.actor_id !== binding.actorId || record.actor.id !== binding.actorId
        || global.operation !== `legacy.skill.router.${input.action}`
        || global.result !== JSON.stringify(result) || local.result_json !== JSON.stringify(result)
        || local.binding_json !== JSON.stringify(binding)) throw new Error();
      const key = record.admission.destinationRelative;
      const prior = heads.get(key);
      if (prior && (JSON.stringify(prior.admission) !== JSON.stringify(record.admission)
        || prior.result.manifestSha256 !== input.manifestSha256
        || prior.result.destinationSha256 !== input.destinationSha256)) throw new Error();
      heads.set(key, { admission: record.admission, sourceSha256: input.sourceSha256, result });
    } catch { throw new CoreError("RECOVERY_CONFLICT", "Skill durable history is invalid.", "unknown"); }
  }
  return { rows, heads, locals: db.prepare("SELECT * FROM legacy_skill_native_receipt ORDER BY operation_id").all(),
    globals: db.prepare("SELECT * FROM receipts WHERE operation IN ('legacy.skill.router.inject','legacy.skill.router.remove') ORDER BY operation_id").all() };
}
export function verifyBatch15SkillWorkspace(db: DatabaseSync, root: string, bridged = false) {
  if (db.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Skill verification must be outside SQL.");
  const workspaceId = JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id;
  const captured = captureBatch15SkillHistory(db, workspaceId);
  if (bridged) return;
  for (const head of captured.heads.values()) {
    const scan = scanNativeLegacySkillTree(db, () => {}, roots(root, head.admission));
    if (createHash("sha256").update(scan.source).digest("hex") !== head.sourceSha256
      || legacySkillManifestHash(scan.manifest) !== head.result.manifestSha256
      || (scan.destination === null ? null : createHash("sha256").update(scan.destination).digest("hex")) !== head.result.destinationSha256)
      throw new CoreError("RECOVERY_CONFLICT", "Skill fixture bytes differ from durable history.", "unknown");
  }
}
export function createBatch15SkillComposition(storage: Storage, db: DatabaseSync, workspaceId: string,
  policy: NativeBatch15SkillPolicy, assertSqlOwner: () => void, replaySource?: (actor: Actor) => unknown) {
  if (policy.scope !== "exclusive-native-disposable-fixture"
    || !["admissionForActor", "assertFixtureOwnership", "authorize", "approveRetry"].every(key => typeof policy[key as keyof NativeBatch15SkillPolicy] === "function"))
    throw new CoreError("INVALID_CONFIGURATION", "Skill projection requires explicit native-owned fixture authority.");
  function admission(actor: Actor) {
    const value = policy.admissionForActor(Object.freeze({ ...actor }));
    if (!value) throw new CoreError("ACCESS_DENIED", "No native Skill fixture admission.");
    const result = { ...value, binding: legacySkillBindingSchema.parse(value.binding) };
    if (result.binding.workspaceId !== workspaceId || result.binding.actorId !== actor.id)
      throw new CoreError("ACCESS_DENIED", "Skill admission is not bound to the authenticated workspace and actor.");
    roots(storage.workspaceRoot(), result);
    policy.assertFixtureOwnership(result);
    return result;
  }
  return {
    available(actor: Readonly<Actor> | undefined, operation: string) {
      if (!actor) return false;
      try {
        if (inspectSkillSourceActivity(db).active && replaySource) replaySource(actor);
        else assertSkillSourceIntegrated(db);
        const grant = admission(actor);
        return actor.canWrite && policy.authorize(actor, grant, operation.endsWith(".inject") ? "inject" : "remove") === true;
      }
      catch { return false; }
    },
    async dispatch(operation: string, args: Record<string, unknown>, actor: Actor) {
      return storage.withWorkspaceExclusive(() => {
        const grant = admission(actor), input = legacySkillLifecycleInputSchema.parse(args);
        if (operation !== `legacy.skill.router.${input.action}`) throw new CoreError("INVALID_ARGUMENT", "Skill action and operation differ.");
        const pin = fingerprint(actor, grant.binding, input);
        if (inspectSkillSourceActivity(db).active && replaySource) {
          replaySource(actor);
          if (!actor.canWrite || actor.collaborationKind !== "human" || policy.authorize(actor, grant, input.action) !== true)
            throw new CoreError("ACCESS_DENIED", "Legacy Skill replay requires live native authorization.");
          const row = db.prepare("SELECT record FROM legacy_skill_native_history WHERE operation_id=?").get(input.operationId);
          const global = db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(input.operationId);
          if (!row || !global) throw new CoreError("RECOVERY_CONFLICT", "Legacy writes cannot interleave after source bridge.");
          const record = JSON.parse(String(row.record));
          if (JSON.stringify(record.actor) !== JSON.stringify(actor) || JSON.stringify(record.admission) !== JSON.stringify(grant)
            || JSON.stringify(record.input) !== JSON.stringify(input) || global.fingerprint !== pin
            || global.actor_id !== actor.id || global.operation !== operation || global.result !== JSON.stringify(record.result))
            throw new CoreError("CONFLICT", "Legacy Skill replay requires its verbatim original request and receipt.");
          return legacySkillLifecycleOutputSchema.parse(record.result);
        }
        assertSkillSourceIntegrated(db);
        const host: LegacySkillNativeAuthority = {
          assertOwner() {
            assertSqlOwner();
            if (!db.isTransaction) policy.assertFixtureOwnership(grant);
          },
          authorize: (who, binding, action) => JSON.stringify(binding) === JSON.stringify(grant.binding)
            && JSON.stringify(admission(who)) === JSON.stringify(grant) && policy.authorize(who, grant, action) === true,
          authorizeRoots: (binding, selected) => JSON.stringify(binding) === JSON.stringify(grant.binding)
            && JSON.stringify(selected) === JSON.stringify(roots(storage.workspaceRoot(), grant)),
          approveRetry: (who, plan) => policy.approveRetry(who, plan) === true,
          assertNoOtherPending: assertBatch15OtherPending,
          globalReceipt(database, id) {
            const row = database.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(id);
            return row ? { fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result)) } : null;
          },
          writeGlobalReceipt(database, id, digest, result) {
            assertSqlOwner();
            database.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
              .run(id, digest, JSON.stringify(result), actor.id, operation, new Date().toISOString());
            database.prepare("INSERT INTO legacy_skill_native_history VALUES(?,?)")
              .run(id, JSON.stringify({ actor, admission: grant, input, result }));
          },
        };
        try {
          const pending = inspectBatch15SkillPending(db);
          if (pending) {
            const plan = JSON.parse(String(pending.plan_json));
            if (pending.operation_id !== input.operationId || pending.fingerprint !== pin
              || JSON.stringify(plan.input) !== JSON.stringify(input) || JSON.stringify(plan.binding) !== JSON.stringify(grant.binding))
              throw new CoreError("CONFLICT", "Retry requires the identical Skill operation, actor and arguments.", "unknown");
            return recoverNativeLegacySkillLifecycle(db, host, roots(storage.workspaceRoot(), grant), actor, input.operationId, pin);
          }
          verifyBatch15SkillWorkspace(db, storage.workspaceRoot());
          return executeNativeLegacySkillLifecycle(db, host, roots(storage.workspaceRoot(), grant), actor, grant.binding, input, pin);
        } catch (error) {
          if (inspectBatch15SkillPending(db)) throw new CoreError(error instanceof CoreError ? error.code : "RECOVERY_REQUIRED",
            "Skill outcome remains durably fenced; retry only identical native-approved operation.", "unknown");
          throw error;
        }
      });
    },
  };
}
