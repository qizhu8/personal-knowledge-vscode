import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { inspectLegacyChatroomTree } from "./legacy-chatroom-continuation.js";
import type { Storage } from "./storage.js";
import { roomProject, writeRoomProject, type RoomProject } from "./next-room-projects.js";

export interface NativeRoomDefinition {
  roomId: string; name: string; sourceFingerprint: string; hostCredentialHash: string; joinSecretHash: string;
}

export function nativeRoomName(value: string): string {
  const name = Array.from(value.normalize("NFKC").trim().replace(/\s+/g, " ")).slice(0, 80).join("");
  if (!name) throw new Error("Room name is required.");
  return name;
}

export function readNativeRoom(database: DatabaseSync, roomId: string): NativeRoomDefinition | undefined {
  if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='native_chatroom_definitions'").get()) return undefined;
  const row = database.prepare(`SELECT room_id,name,source_fingerprint,host_credential_hash,join_secret_hash
    FROM native_chatroom_definitions WHERE room_id=?`).get(roomId);
  if (!row) return undefined;
  const definition = { roomId: String(row.room_id), name: String(row.name), sourceFingerprint: String(row.source_fingerprint),
    hostCredentialHash: String(row.host_credential_hash), joinSecretHash: String(row.join_secret_hash) };
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(definition.roomId) || nativeRoomName(definition.name) !== definition.name
    || !/^[a-f0-9]{64}$/.test(definition.sourceFingerprint) || !/^[a-f0-9]{64}$/.test(definition.hostCredentialHash)
    || !/^[a-f0-9]{64}$/.test(definition.joinSecretHash)) throw new Error("Native Room definition is invalid.");
  return definition;
}

export function inspectNativeRoom(storage: Storage, roomId: string): NativeRoomDefinition | undefined {
  storage.assertWorkspaceLease();
  const database = storage.connectNative();
  try {
    const definition = readNativeRoom(database, roomId);
    if (definition && existsSync(join(storage.workspaceRoot(), "chatrooms", roomId)))
      throw new Error("Native Room conflicts with a legacy archive.");
    return definition;
  } finally { database.close(); }
}
export function assertNativeRoomNameAvailable(storage: Storage, name: string, exceptRoomId?: string): void {
  storage.assertWorkspaceLease();
  if (nativeRoomName(name) !== name) throw new Error("Invalid Room name.");
  const root = storage.workspaceRoot(), key = name.toLocaleLowerCase();
  const archives = existsSync(join(root, "chatrooms")) ? inspectLegacyChatroomTree(root) : [];
  if (archives.some(room => room.roomId !== exceptRoomId && nativeRoomName(room.name).toLocaleLowerCase() === key))
    throw new Error("A Room with this name already exists.");
  const database = storage.connectNative();
  try {
    if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='native_chatroom_definitions'").get()) {
      const names = database.prepare("SELECT room_id,name FROM native_chatroom_definitions").all();
      if (names.some(row => row.room_id !== exceptRoomId && nativeRoomName(String(row.name)).toLocaleLowerCase() === key))
        throw new Error("A Room with this name already exists.");
    }
  } finally { database.close(); }
}

/** Call only after the parent profile has authorized this exact Room and its credentials. */
export function createNativeRoom(storage: Storage, input: NativeRoomDefinition & Partial<RoomProject>): void {
  storage.assertWorkspaceLease();
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(input.roomId) || nativeRoomName(input.name) !== input.name
    || ![input.sourceFingerprint, input.hostCredentialHash, input.joinSecretHash].every(value => /^[a-f0-9]{64}$/.test(value)))
    throw new Error("Native Room definition is invalid.");
  const root = storage.workspaceRoot();
  if (existsSync(join(root, "chatrooms", input.roomId))) throw new Error("Room ID conflicts with a legacy archive.");
  const key = input.name.toLocaleLowerCase();
  assertNativeRoomNameAvailable(storage, input.name, input.roomId);
  const database = storage.connectNative();
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      storage.assertWorkspaceLease();
      database.exec(`CREATE TABLE IF NOT EXISTS native_chatroom_definitions(
        room_id TEXT PRIMARY KEY, name TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
        host_credential_hash TEXT NOT NULL, join_secret_hash TEXT NOT NULL)`);
      const current = readNativeRoom(database, input.roomId);
      if (current) {
        if (JSON.stringify(current) !== JSON.stringify(input)) throw new Error("Native Room definition conflicts with the saved profile.");
      } else {
        const names = database.prepare("SELECT name FROM native_chatroom_definitions").all();
        if (names.some(row => nativeRoomName(String(row.name)).toLocaleLowerCase() === key))
          throw new Error("A Room with this name already exists.");
        database.prepare("INSERT INTO native_chatroom_definitions VALUES(?,?,?,?,?)").run(
          input.roomId, input.name, input.sourceFingerprint, input.hostCredentialHash, input.joinSecretHash);
        const ownership = roomProject(input);
        if (ownership) writeRoomProject(database, input.roomId, ownership);
      }
      storage.assertWorkspaceLease();
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  } finally { database.close(); }
}
