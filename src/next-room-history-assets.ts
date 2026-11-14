import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { meetingNotePath, validateMeetingSource } from "./next-room-meeting-source.js";

type Value = Record<string, any>;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const empty = () => ({ schema: 1, meetings: [] });
const bytesLimit = 128 * 1024 * 1024;

/** Room-only Core assets. Installation shares the history transaction, never writes retained files. */
export class NextRoomHistoryAssets {
  constructor(private readonly db: DatabaseSync, private readonly assert: () => void) {}
  snapshot(roomId: string): Value {
    this.assert();
    const hasMeetings = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_meetings'").get();
    const meeting = hasMeetings && this.db.prepare("SELECT * FROM next_room_meetings WHERE room_id=?").get(roomId);
    const transferred = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_meeting_transferred_sources'").get()
      && this.db.prepare("SELECT * FROM next_room_meeting_transferred_sources WHERE room_id=?").get(roomId);
    const notes = meeting ? this.db.prepare(
      "SELECT meeting_id,note_path,body,visible FROM next_room_meeting_notes WHERE room_id=? ORDER BY meeting_id").all(roomId) : [];
    const manual = new Set(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_meeting_manual_notes'").get()
      ? this.db.prepare("SELECT meeting_id FROM next_room_meeting_manual_notes WHERE room_id=?").all(roomId).map(row => row.meeting_id) : []);
    const files = this.db.prepare(
      "SELECT file_id,owner_id,metadata_json,complete,sha256,data FROM legacy_room_runtime_files WHERE room_id=? ORDER BY file_id").all(roomId);
    const recoveries = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_file_recoveries'").get()
      ? this.db.prepare("SELECT file_id,sha256 FROM next_room_file_recoveries WHERE room_id=?").all(roomId) : [];
    if (recoveries.some(recovery => !files.some(file => file.file_id === recovery.file_id && file.sha256 === recovery.sha256)))
      throw new Error("Saved attachment recovery provenance conflicts with retained bytes.");
    const recovered = new Set(recoveries.map(row => row.file_id));
    if (files.some(file => file.complete !== 1)) throw new Error("Incomplete Room attachments cannot be transferred or released.");
    return {
      meetings: { state: meeting ? String(meeting.state_json) : JSON.stringify(empty()),
        sourceCanonical: transferred ? transferred.source_canonical : meeting?.source_canonical ?? null,
        sourceNotes: transferred ? String(transferred.source_notes_json) : meeting ? String(meeting.source_notes_json) : "[]",
        notes: notes.map(note => ({ id: note.meeting_id, path: note.note_path, body: note.body, visible: note.visible,
          manual: Number(manual.has(note.meeting_id)) })) },
      files: files.map(file => ({ id: file.file_id, owner: file.owner_id, metadata: file.metadata_json,
        sha256: file.sha256, recovered: Number(recovered.has(file.file_id)), data: Buffer.from(file.data as Uint8Array).toString("base64") })),
    };
  }
  validate(roomId: string, assets: Value, room: Value) {
    if (!assets || !assets.meetings || typeof assets.meetings.state !== "string"
      || !Array.isArray(assets.meetings.notes) || !Array.isArray(assets.files) || assets.files.length > 128)
      throw new Error("Invalid Room asset inventory.");
    const state = validateMeetingSource(roomId, JSON.parse(assets.meetings.state));
    if (assets.meetings.sourceCanonical !== null && typeof assets.meetings.sourceCanonical !== "string"
      || typeof assets.meetings.sourceNotes !== "string") throw new Error("Invalid original Meeting provenance.");
    if (assets.meetings.sourceCanonical !== null)
      validateMeetingSource(roomId, JSON.parse(assets.meetings.sourceCanonical));
    if (!Array.isArray(JSON.parse(assets.meetings.sourceNotes))) throw new Error("Invalid original Meeting Note inventory.");
    const byId = new Map(state.meetings.map((meeting: Value) => [meeting.id, meeting]));
    const noteIds = new Set<string>(), fileIds = new Set<string>();
    let size = Buffer.byteLength(assets.meetings.state) + Buffer.byteLength(assets.meetings.sourceNotes)
      + Buffer.byteLength(assets.meetings.sourceCanonical ?? "");
    for (const note of assets.meetings.notes) {
      const meeting = byId.get(note?.id) as Value | undefined;
      if (!meeting || noteIds.has(note.id) || note.path !== meetingNotePath(meeting)
        || typeof note.body !== "string" || ![0, 1].includes(note.visible) || ![0, 1].includes(note.manual ?? 0)
        || note.visible !== Number(meeting.status !== "trashed"))
        throw new Error("Invalid, missing or cross-Room Meeting Note.");
      noteIds.add(note.id); size += Buffer.byteLength(note.body);
    }
    if (noteIds.size !== byId.size) throw new Error("Meeting transfer must include every Note, including Trash.");
    const participants = new Set(room.identity.memberships.map((member: Value) => member.participantId));
    for (const file of assets.files) {
      const metadata = typeof file?.metadata === "string" && JSON.parse(file.metadata);
      if (!metadata || !/^[A-Za-z0-9_-]{1,128}$/.test(file.id) || fileIds.has(file.id)
        || !participants.has(file.owner) || metadata.fileId !== file.id || typeof metadata.name !== "string"
        || metadata.name.length > 200 || /[\u0000-\u001f]/.test(metadata.name)
        || typeof metadata.mime !== "string" || metadata.mime.length > 200
        || Object.keys(metadata).sort().join(",") !== "fileId,mime,name,size"
        || !Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > 25 * 1024 * 1024
        || typeof file.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
        || !/^[a-f0-9]{64}$/.test(file.sha256) || ![0, 1].includes(file.recovered ?? 0))
        throw new Error("Invalid or cross-Room attachment inventory.");
      const bytes = Buffer.from(file.data, "base64");
      if (bytes.toString("base64") !== file.data || bytes.length !== metadata.size || hash(bytes) !== file.sha256)
        throw new Error("Attachment bytes do not match their immutable digest.");
      fileIds.add(file.id); size += bytes.length;
    }
    if (size > bytesLimit) throw new Error("Room asset budget exceeded; no bytes were pruned.");
    for (const message of room.messages) {
      const file = message.metadata?.file;
      if (file && !assets.files.some((item: Value) => item.id === file.fileId
        && item.owner === message.participantId
        && ["fileId", "name", "size", "mime"].every(key => JSON.parse(item.metadata)[key] === file[key])))
        throw new Error("Legacy attachment bytes are absent or conflict; preserve the metadata, do not invent bytes.");
    }
  }
  assertInitialBase(roomId: string, incoming: Value) {
    const local = this.snapshot(roomId);
    const originalState = incoming.meetings.sourceCanonical === null ? empty() : JSON.parse(incoming.meetings.sourceCanonical);
    const localState = JSON.parse(local.meetings.state);
    if (localState.meetings.length && JSON.stringify(localState) !== JSON.stringify(originalState))
      throw new Error("Local Meeting branch requires explicit reconciliation; nothing was overwritten.");
    const originalNotes = JSON.parse(incoming.meetings.sourceNotes);
    for (const note of local.meetings.notes)
      if (!originalNotes.some((original: Value) => original.id === note.id && original.path === note.path
        && (original.body === note.body || original.body === null && !note.visible)))
        throw new Error("Local manual Note differs from the source baseline; preserve both versions.");
    for (const file of local.files)
      if (!incoming.files.some((other: Value) => JSON.stringify(other) === JSON.stringify(file)))
        throw new Error("Local attachment branch requires explicit reconciliation.");
  }
  install(roomId: string, assets: Value) {
    this.assert();
    if (!this.db.isTransaction) throw new Error("Room assets require the atomic history transaction.");
    for (const file of this.snapshot(roomId).files)
      if (!assets.files.some((incoming: Value) => ["id", "owner", "metadata", "sha256", "data"]
        .every(key => incoming[key] === file[key])))
        throw new Error("Retained attachment bytes are immutable; preserve both branches.");
    this.db.exec(`CREATE TABLE IF NOT EXISTS next_room_meetings(
      room_id TEXT PRIMARY KEY,state_json TEXT NOT NULL,source_canonical TEXT,source_hash TEXT NOT NULL,source_notes_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS next_room_meeting_notes(
      room_id TEXT NOT NULL,meeting_id TEXT NOT NULL,note_path TEXT NOT NULL UNIQUE,body TEXT NOT NULL,visible INTEGER NOT NULL,
      PRIMARY KEY(room_id,meeting_id));
      CREATE TABLE IF NOT EXISTS next_room_meeting_imported_notes(room_id TEXT NOT NULL,meeting_id TEXT NOT NULL,
      PRIMARY KEY(room_id,meeting_id));
      CREATE TABLE IF NOT EXISTS next_room_meeting_manual_notes(room_id TEXT NOT NULL,meeting_id TEXT NOT NULL,
      PRIMARY KEY(room_id,meeting_id));
      CREATE TABLE IF NOT EXISTS next_room_meeting_transferred_sources(room_id TEXT PRIMARY KEY,
      source_canonical TEXT,source_notes_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS next_room_file_recoveries(room_id TEXT NOT NULL,file_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,PRIMARY KEY(room_id,file_id));`);
    const existing = this.db.prepare("SELECT 1 FROM next_room_meetings WHERE room_id=?").get(roomId);
    if (!existing) this.db.prepare("INSERT INTO next_room_meetings VALUES(?,?,NULL,?,?)")
      .run(roomId, JSON.stringify(empty()), hash("absent"), "[]");
    this.db.prepare("UPDATE next_room_meetings SET state_json=? WHERE room_id=?").run(assets.meetings.state, roomId);
    this.db.prepare(`INSERT INTO next_room_meeting_transferred_sources VALUES(?,?,?)
      ON CONFLICT(room_id) DO UPDATE SET source_canonical=excluded.source_canonical,source_notes_json=excluded.source_notes_json`)
      .run(roomId, assets.meetings.sourceCanonical, assets.meetings.sourceNotes);
    this.db.prepare("DELETE FROM next_room_meeting_notes WHERE room_id=?").run(roomId);
    this.db.prepare("DELETE FROM next_room_meeting_imported_notes WHERE room_id=?").run(roomId);
    this.db.prepare("DELETE FROM next_room_meeting_manual_notes WHERE room_id=?").run(roomId);
    for (const note of assets.meetings.notes) {
      this.db.prepare("INSERT INTO next_room_meeting_notes VALUES(?,?,?,?,?)").run(roomId, note.id, note.path, note.body, note.visible);
      this.db.prepare("INSERT INTO next_room_meeting_imported_notes VALUES(?,?)").run(roomId, note.id);
      if (note.manual) this.db.prepare("INSERT INTO next_room_meeting_manual_notes VALUES(?,?)").run(roomId, note.id);
    }
    this.db.prepare("DELETE FROM legacy_room_runtime_chunks WHERE room_id=?").run(roomId);
    this.db.prepare("DELETE FROM legacy_room_runtime_files WHERE room_id=?").run(roomId);
    this.db.prepare("DELETE FROM next_room_file_recoveries WHERE room_id=?").run(roomId);
    for (const file of assets.files) {
      const bytes = Buffer.from(file.data, "base64");
      this.db.prepare("INSERT INTO legacy_room_runtime_files VALUES(?,?,?,?,1,?,?)")
        .run(roomId, file.id, file.owner, file.metadata, file.sha256, bytes);
      if (file.recovered) this.db.prepare("INSERT INTO next_room_file_recoveries VALUES(?,?,?)").run(roomId, file.id, file.sha256);
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        const chunk = bytes.subarray(offset, offset + 32768);
        this.db.prepare("INSERT INTO legacy_room_runtime_chunks(room_id,file_id,sequence,sha256,data) VALUES(?,?,?,?,?)")
          .run(roomId, file.id, offset / 32768, hash(chunk), chunk);
      }
    }
  }
}
