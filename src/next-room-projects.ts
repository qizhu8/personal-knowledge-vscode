import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Storage } from "./storage.js";

export type RoomProject = { projectId: string; threadId: string };
export function roomProject(value: any): RoomProject | undefined {
  if (value?.projectId == null && value?.threadId == null) return undefined;
  if (typeof value?.projectId !== "string" || typeof value?.threadId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value.projectId)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value.threadId))
    throw new Error("Room Project/thread identity is invalid.");
  return { projectId: value.projectId, threadId: value.threadId };
}
export function readRoomProject(storage: Storage, roomId: string): RoomProject | undefined {
  storage.assertWorkspaceLease();
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(roomId)) throw new Error("Invalid Room identity.");
  const db = storage.connectNative();
  try {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_projects'").get()) {
      const row = db.prepare("SELECT project_id AS projectId,thread_id AS threadId FROM next_room_projects WHERE room_id=?").get(roomId);
      if (row) return roomProject(row);
    }
  } finally { db.close(); }
  const file = join(storage.workspaceRoot(), "chatrooms", roomId, "chatroom.db");
  if (!existsSync(file)) return undefined;
  const original = new DatabaseSync(file, { readOnly: true });
  try {
    original.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    const columns = original.prepare("PRAGMA table_info(room_metadata)").all().map(row => row.name);
    if (!columns.includes("project_id") && !columns.includes("thread_id")) return undefined;
    return roomProject(original.prepare("SELECT project_id AS projectId,thread_id AS threadId FROM room_metadata WHERE room_id=?").get(roomId));
  } finally { original.close(); }
}
export function writeRoomProject(db: DatabaseSync, roomId: string, value: RoomProject): void {
  const ownership = roomProject(value)!;
  db.exec("CREATE TABLE IF NOT EXISTS next_room_projects(room_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,UNIQUE(project_id,thread_id))");
  db.prepare("INSERT INTO next_room_projects VALUES(?,?,?)").run(roomId, ownership.projectId, ownership.threadId);
}
