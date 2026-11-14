import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { Storage } from "./storage.js";
import { inspectRetainedMeetingSource, meetingNotePath, validateMeetingSource } from "./next-room-meeting-source.js";
import { assertPrivateRoomAdmissions, privateMeetingNoteResolver } from "./next-room-private-admission.js";

type RecordValue = Record<string, any>;
export type RetainedMeetingStore = new (...args: any[]) => any;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Reuse the original reducer, but commit canonical state and its Note in one owned SQLite transaction. */
export function createNextRoomMeetings(options: {
  storage: Storage; Store: RetainedMeetingStore;
  assertAuthority(): void; authorize(roomId: string): Promise<void>;
}) {
  const root = options.storage.workspaceRoot(), admitted = new Set<string>();
  let current: { db: DatabaseSync; roomId: string } | undefined;
  const assert = () => { options.assertAuthority(); options.storage.assertWorkspaceLease(); };
  const notePath = meetingNotePath, validate = validateMeetingSource;
  const source = (roomId: string) => inspectRetainedMeetingSource(root, roomId, privateMeetingNoteResolver(options.storage, roomId));
  const connection = () => {
    assert();
    if (!current) throw new Error("Meeting writes require their owned SQLite transaction.");
    return current.db;
  };
  const verifyOriginal = (roomId: string, db: DatabaseSync) => {
    const row = db.prepare("SELECT source_hash FROM next_room_meetings WHERE room_id=?").get(roomId);
    if (!row || row.source_hash !== source(roomId).hash)
      throw new Error("Original Meeting source changed after admission; preserve both versions.");
  };
  const backend = {
    read(roomId: string): any {
      assert();
      if (!admitted.has(roomId)) throw new Error("This Room's original Meetings have not been admitted by its Host.");
      if (current && current.roomId !== roomId) throw new Error("Cross-Room Meeting transaction.");
      const db = current?.db ?? options.storage.connectNative();
      try {
        const row = db.prepare("SELECT state_json FROM next_room_meetings WHERE room_id=?").get(roomId);
        if (!row) throw new Error("Admitted Meeting state is missing.");
        return validate(roomId, JSON.parse(String(row.state_json)));
      } finally { if (!current) db.close(); }
    },
    write(roomId: string, state: RecordValue) {
      if (current?.roomId !== roomId) throw new Error("Cross-Room Meeting mutation.");
      validate(roomId, state);
      if (connection().prepare("UPDATE next_room_meetings SET state_json=? WHERE room_id=?")
        .run(JSON.stringify(state), roomId).changes !== 1) throw new Error("Meeting state disappeared.");
    },
    writeMarkdown(meeting: RecordValue, body: string) {
      if (current?.roomId !== meeting.roomId) throw new Error("Cross-Room Meeting Note write.");
      const retained = source(meeting.roomId).notes.some((note: RecordValue) => note.id === meeting.id && note.body !== null)
        || !!(connection().prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_meeting_imported_notes'").get()
          && connection().prepare("SELECT 1 FROM next_room_meeting_imported_notes WHERE room_id=? AND meeting_id=?")
            .get(meeting.roomId, meeting.id));
      const manual = !!(connection().prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_meeting_manual_notes'").get()
        && connection().prepare("SELECT 1 FROM next_room_meeting_manual_notes WHERE room_id=? AND meeting_id=?")
          .get(meeting.roomId, meeting.id));
      connection().prepare(`INSERT INTO next_room_meeting_notes VALUES(?,?,?,?,1)
        ON CONFLICT(room_id,meeting_id) DO UPDATE SET note_path=excluded.note_path,
        body=CASE WHEN (? OR ? AND next_room_meeting_notes.visible=0) AND next_room_meeting_notes.body IS NOT NULL
          THEN next_room_meeting_notes.body ELSE excluded.body END,visible=1`)
        .run(meeting.roomId, meeting.id, notePath(meeting), body, manual ? 1 : 0, retained ? 1 : 0);
    },
    removeMarkdown(meeting: RecordValue) {
      if (current?.roomId !== meeting.roomId) throw new Error("Cross-Room Meeting Note removal.");
      const state = backend.read(meeting.roomId);
      if (state.meetings.some((item: RecordValue) => item.id === meeting.id))
        connection().prepare("UPDATE next_room_meeting_notes SET visible=0 WHERE room_id=? AND meeting_id=?").run(meeting.roomId, meeting.id);
      else {
        connection().prepare("DELETE FROM next_room_meeting_notes WHERE room_id=? AND meeting_id=?").run(meeting.roomId, meeting.id);
        if (connection().prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_meeting_imported_notes'").get())
          connection().prepare("DELETE FROM next_room_meeting_imported_notes WHERE room_id=? AND meeting_id=?").run(meeting.roomId, meeting.id);
        if (connection().prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_meeting_manual_notes'").get())
          connection().prepare("DELETE FROM next_room_meeting_manual_notes WHERE room_id=? AND meeting_id=?").run(meeting.roomId, meeting.id);
      }
    },
    async transaction<T>(roomId: string, operation: () => T): Promise<T> {
      await assertPrivateRoomAdmissions(options.storage);
      await options.authorize(roomId);
      assert();
      if (!admitted.has(roomId) || current) throw new Error("Meeting Room is not admitted, or another transaction is active.");
      const db = options.storage.connectNative();
      try {
        db.exec("BEGIN IMMEDIATE");
        verifyOriginal(roomId, db);
        current = { db, roomId };
        const result = operation();
        if (result instanceof Promise) throw new Error("Meeting reducers must be synchronous inside the SQLite transaction.");
        verifyOriginal(roomId, db);
        assert(); db.exec("COMMIT");
        return result;
      } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
      finally { current = undefined; db.close(); }
    },
  };
  const store = new options.Store("", "", backend);
  store.readNote = async (roomId: string, meetingId: string) => {
    await assertPrivateRoomAdmissions(options.storage);
    await options.authorize(roomId); assert();
    const state = backend.read(roomId);
    const meeting = state.meetings.find((item: RecordValue) => item.id === meetingId && item.status !== "trashed");
    if (!meeting) throw new Error("Meeting Note was not found or is in Trash.");
    const db = options.storage.connectNative();
    try {
      const row = db.prepare("SELECT note_path,body FROM next_room_meeting_notes WHERE room_id=? AND meeting_id=? AND visible=1")
        .get(roomId, meetingId);
      if (!row || row.note_path !== notePath(meeting)) throw new Error("Meeting Note is missing or conflicts with its canonical record.");
      verifyOriginal(roomId, db);
      assert();
      return { path: String(row.note_path), content: String(row.body), sha256: hash(String(row.body)) };
    } finally { db.close(); }
  };
  store.writeNote = async (roomId: string, meetingId: string, content: string, expectedSha256: string) => {
    if (typeof content !== "string" || Buffer.byteLength(content) > 16 * 1024 * 1024
      || typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256))
      throw new Error("A bounded Note and its previously reviewed content hash are required.");
    return backend.transaction(roomId, () => {
      const state = backend.read(roomId);
      const meeting = state.meetings.find((item: RecordValue) => item.id === meetingId && item.status !== "trashed");
      const db = connection();
      const row = db.prepare("SELECT note_path,body FROM next_room_meeting_notes WHERE room_id=? AND meeting_id=? AND visible=1")
        .get(roomId, meetingId);
      if (!meeting || !row || row.note_path !== notePath(meeting)) throw new Error("Meeting Note was not found or is in Trash.");
      if (hash(String(row.body)) !== expectedSha256) throw new Error("Meeting Note changed since it was opened; reopen and review both versions.");
      db.prepare("UPDATE next_room_meeting_notes SET body=? WHERE room_id=? AND meeting_id=?").run(content, roomId, meetingId);
      db.exec("CREATE TABLE IF NOT EXISTS next_room_meeting_manual_notes(room_id TEXT NOT NULL,meeting_id TEXT NOT NULL,PRIMARY KEY(room_id,meeting_id))");
      db.prepare("INSERT OR IGNORE INTO next_room_meeting_manual_notes VALUES(?,?)").run(roomId, meetingId);
      return { sha256: hash(content) };
    });
  };
  return {
    store,
    async admit(roomId: string) {
      await assertPrivateRoomAdmissions(options.storage);
      await options.authorize(roomId); assert();
      const original = source(roomId), db = options.storage.connectNative();
      try {
        db.exec("BEGIN IMMEDIATE");
        db.exec(`CREATE TABLE IF NOT EXISTS next_room_meetings(
          room_id TEXT PRIMARY KEY,state_json TEXT NOT NULL,source_canonical TEXT,source_hash TEXT NOT NULL,source_notes_json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS next_room_meeting_notes(
          room_id TEXT NOT NULL,meeting_id TEXT NOT NULL,note_path TEXT NOT NULL UNIQUE,
          body TEXT NOT NULL,visible INTEGER NOT NULL,PRIMARY KEY(room_id,meeting_id));`);
        const prior = db.prepare("SELECT source_hash FROM next_room_meetings WHERE room_id=?").get(roomId);
        if (prior) {
          if (prior.source_hash !== original.hash) throw new Error("Original Meeting source changed after admission; preserve both versions.");
        } else {
          db.prepare("INSERT INTO next_room_meetings VALUES(?,?,?,?,?)")
            .run(roomId, JSON.stringify(original.state), original.canonical, original.hash, JSON.stringify(original.notes));
          for (const note of original.notes) {
            const meeting = original.state.meetings.find((item: RecordValue) => item.id === note.id);
            db.prepare("INSERT INTO next_room_meeting_notes VALUES(?,?,?,?,?)")
              .run(roomId, note.id, note.path, note.body ?? store.markdown(clone(meeting)), note.visible ? 1 : 0);
          }
        }
        verifyOriginal(roomId, db);
        assert(); db.exec("COMMIT");
        admitted.add(roomId);
      } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
      finally { db.close(); }
    },
  };
}
