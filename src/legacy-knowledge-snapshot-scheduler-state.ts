import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
export const snapshotScheduleDdl = `
CREATE TABLE native_knowledge_snapshot_schedule_events(sequence INTEGER PRIMARY KEY,payload TEXT NOT NULL,sha256 TEXT NOT NULL);
CREATE TRIGGER native_knowledge_snapshot_schedule_no_update BEFORE UPDATE ON native_knowledge_snapshot_schedule_events BEGIN SELECT RAISE(ABORT,'snapshot schedule immutable'); END;
CREATE TRIGGER native_knowledge_snapshot_schedule_no_delete BEFORE DELETE ON native_knowledge_snapshot_schedule_events BEGIN SELECT RAISE(ABORT,'snapshot schedule immutable'); END;`;
const timing = z.strictObject({
  next_run_utc: z.string().datetime({ offset: true }), next_run_local: z.string(),
  abbreviation: z.string(), timezone: z.string(), local_time: z.string(),
});
const configuration = z.strictObject({
  kind: z.literal("configure"), operationId: uuid, enabled: z.boolean(),
  local_time: z.string(), timezone: z.string(), unit: z.string(), dueUtc: z.string().datetime({ offset: true }),
});
const claim = z.strictObject({ kind: z.literal("claim"), operationId: uuid, configurationId: uuid,
  dueUtc: z.string().datetime({ offset: true }) });
const completion = z.strictObject({ kind: z.literal("complete"), operationId: uuid, configurationId: uuid,
  completedUtc: z.string().datetime({ offset: true }), timing });
const cancellation = z.strictObject({ kind: z.literal("cancel"), operationId: uuid, configurationId: uuid });
const eventSchema = z.strictObject({ previous: digest.nullable(), admissionSha256: digest,
  event: z.discriminatedUnion("kind", [configuration, claim, completion, cancellation]) });
export type SnapshotScheduleEvent = z.infer<typeof eventSchema>["event"];
export interface SnapshotScheduleState {
  configuration?: z.infer<typeof configuration>;
  pending?: z.infer<typeof claim>;
  dueUtc?: string;
  lastCompletedUtc?: string;
  previous: string | null;
}
export const snapshotScheduleHash = (value: string) => createHash("sha256").update(value).digest("hex");
function fail(message: string): never { throw new CoreError("INVALID_WORKSPACE", message); }
export function verifySnapshotSchedule(db: DatabaseSync): SnapshotScheduleState {
  const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB 'native_knowledge_snapshot_schedule_*' ORDER BY name";
  const objects = db.prepare(query).all();
  const state: SnapshotScheduleState = { previous: null };
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
  if (version === 26 && !objects.length) fail("Schema26 requires its native snapshot schedule owner.");
  if (!objects.length) return state;
  if (![26, 27, 28].includes(version)) fail("Native snapshot schedules require downgrade-fenced schema26 or newer.");
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(snapshotScheduleDdl);
    if (JSON.stringify(objects) !== JSON.stringify(expected.prepare(query).all()))
      fail("Private snapshot schedule schema differs from its fixed native owner.");
  } finally { expected.close(); }
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_knowledge_snapshot_admission' AND type='table'").get())
    fail("Snapshot schedule has no native snapshot owner schema.");
  const admission = db.prepare("SELECT payload,sha256 FROM legacy_knowledge_snapshot_admission WHERE singleton=1").get();
  if (!admission || snapshotScheduleHash(String(admission.payload)) !== admission.sha256)
    fail("Snapshot schedule requires its original immutable snapshot admission.");
  const authority = JSON.parse(String(admission.payload));
  if (!["knowledge_snapshot_create", "knowledge_snapshot_configure"].every(tool => authority.allowedTools.includes(tool)))
    fail("Snapshot schedule admission must explicitly authorize both configuration and actual creation.");
  const configurations = new Set<string>(), operations = new Set<string>();
  for (const row of db.prepare("SELECT payload,sha256 FROM native_knowledge_snapshot_schedule_events ORDER BY sequence").all()) {
    const raw = String(row.payload);
    if (snapshotScheduleHash(raw) !== row.sha256) fail("Snapshot schedule event digest changed.");
    const envelope = eventSchema.parse(JSON.parse(raw)), event = envelope.event;
    if (envelope.previous !== state.previous || envelope.admissionSha256 !== admission.sha256)
      fail("Snapshot schedule lost its immutable admission or event chain.");
    if (event.kind === "configure") {
      if (configurations.has(event.operationId)) fail("Snapshot schedule configuration was duplicated.");
      const owner = db.prepare("SELECT payload FROM legacy_knowledge_snapshot_events WHERE operation_id=?").get(event.operationId)
        ?? db.prepare("SELECT payload FROM legacy_knowledge_snapshot_intent WHERE singleton=1").get();
      const receipt = owner && JSON.parse(String(owner.payload));
      if (!receipt || receipt.operationId !== event.operationId || receipt.tool !== "knowledge_snapshot_configure"
        || receipt.result.enabled !== event.enabled || receipt.result.local_time !== event.local_time
        || receipt.result.timezone !== event.timezone || receipt.result.unit !== event.unit
        || receipt.result.next_run_utc !== event.dueUtc)
        fail("Snapshot schedule configuration has no exact native configuration intent or receipt.");
      configurations.add(event.operationId);
      state.configuration = event; state.dueUtc = event.dueUtc;
    } else if (event.kind === "claim") {
      if (!state.configuration?.enabled || state.pending || operations.has(event.operationId)
        || event.configurationId !== state.configuration.operationId || event.dueUtc !== state.dueUtc)
        fail("Snapshot scheduled job is not bound to the exact enabled due occurrence.");
      operations.add(event.operationId); state.pending = event;
    } else {
      if (!state.pending || state.pending.operationId !== event.operationId
        || state.pending.configurationId !== event.configurationId)
        fail("Snapshot schedule completion or cancellation lost its exact pending job.");
      if (event.kind === "complete") {
        const owner = db.prepare("SELECT payload FROM legacy_knowledge_snapshot_events WHERE operation_id=?").get(event.operationId);
        const receipt = owner && JSON.parse(String(owner.payload));
        if (!receipt || receipt.tool !== "knowledge_snapshot_create" || receipt.args.reason !== "scheduled-daily")
          fail("Snapshot scheduled completion has no actual original private Git create receipt.");
        if (event.timing.local_time !== state.configuration?.local_time || event.timing.timezone !== state.configuration.timezone
          || Date.parse(event.timing.next_run_utc) <= Date.parse(event.completedUtc))
          fail("Snapshot scheduled completion has invalid subsequent timing.");
        state.dueUtc = event.timing.next_run_utc; state.lastCompletedUtc = event.completedUtc;
      } else if (state.configuration?.operationId === event.configurationId && state.configuration.enabled) {
        fail("An enabled unchanged snapshot schedule cannot silently cancel a claimed occurrence.");
      }
      state.pending = undefined;
    }
    state.previous = String(row.sha256);
  }
  return state;
}
export function appendSnapshotSchedule(db: DatabaseSync, event: SnapshotScheduleEvent) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='native_knowledge_snapshot_schedule_events'").get())
    db.exec(`PRAGMA user_version=${Math.max(26, Number(db.prepare("PRAGMA user_version").get()?.user_version))};${snapshotScheduleDdl}`);
  const state = verifySnapshotSchedule(db);
  const admission = db.prepare("SELECT sha256 FROM legacy_knowledge_snapshot_admission WHERE singleton=1").get();
  const payload = JSON.stringify(eventSchema.parse({ previous: state.previous, admissionSha256: admission?.sha256, event }));
  db.prepare("INSERT INTO native_knowledge_snapshot_schedule_events(payload,sha256) VALUES(?,?)")
    .run(payload, snapshotScheduleHash(payload));
  verifySnapshotSchedule(db);
}
