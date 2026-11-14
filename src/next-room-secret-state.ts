import { createHash } from "node:crypto";
import type { Storage } from "./storage.js";

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const valid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const rotations = new WeakMap<Storage, Set<string>>();

/** Reconcile only the two recorded candidates against the actual profile secret. */
export function resolveRoomJoinSecretHash(storage: Storage, roomId: string, originalHash: string, secret: string): string {
  if (rotations.get(storage)?.has(roomId)) throw new Error("Room secret rotation is in progress; its journal cannot be recovered yet.");
  storage.assertWorkspaceLease();
  const db = storage.connectNative();
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_secret_state'").get()) return originalHash;
    db.exec("BEGIN IMMEDIATE");
    try {
      storage.assertWorkspaceLease();
      const state = db.prepare("SELECT current_hash,pending_hash FROM next_room_secret_state WHERE room_id=?").get(roomId);
      if (!state) { db.exec("COMMIT"); return originalHash; }
      if (!valid(state.current_hash) || state.pending_hash !== null && !valid(state.pending_hash))
        throw new Error("Room secret rotation journal is invalid.");
      const actual = hash(secret);
      if (state.pending_hash !== null) {
        if (actual !== state.current_hash && actual !== state.pending_hash)
          throw new Error("Profile secret matches neither recorded rotation candidate; preserve the journal.");
        db.prepare("UPDATE next_room_secret_state SET current_hash=?,pending_hash=NULL WHERE room_id=?").run(actual, roomId);
      }
      storage.assertWorkspaceLease();
      db.exec("COMMIT");
      return state.pending_hash !== null ? actual : String(state.current_hash);
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}

export async function rotateRoomJoinSecret(options: {
  storage: Storage; roomId: string; current: string; next: string;
  assertAuthority(): void; replace(secret: string): Promise<void>;
}): Promise<string> {
  const assert = () => { options.assertAuthority(); options.storage.assertWorkspaceLease(); };
  assert();
  const currentHash = hash(options.current), nextHash = hash(options.next);
  if (resolveRoomJoinSecretHash(options.storage, options.roomId, currentHash, options.current) !== currentHash)
    throw new Error("Room secret changed before rotation.");
  let active = rotations.get(options.storage);
  if (!active) { active = new Set(); rotations.set(options.storage, active); }
  const db = options.storage.connectNative();
  active.add(options.roomId);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      assert();
      db.exec(`CREATE TABLE IF NOT EXISTS next_room_secret_state(
        room_id TEXT PRIMARY KEY,current_hash TEXT NOT NULL,pending_hash TEXT)`);
      db.prepare(`INSERT INTO next_room_secret_state VALUES(?,?,?)
        ON CONFLICT(room_id) DO UPDATE SET pending_hash=excluded.pending_hash
        WHERE current_hash=excluded.current_hash AND pending_hash IS NULL`).run(options.roomId, currentHash, nextHash);
      const state = db.prepare("SELECT current_hash,pending_hash FROM next_room_secret_state WHERE room_id=?").get(options.roomId);
      if (state?.current_hash !== currentHash || state.pending_hash !== nextHash) throw new Error("Another Room rotation is pending.");
      assert(); db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    await options.replace(options.next);
    assert();
    db.exec("BEGIN IMMEDIATE");
    try {
      assert();
      const result = db.prepare(`UPDATE next_room_secret_state SET current_hash=?,pending_hash=NULL
        WHERE room_id=? AND current_hash=? AND pending_hash=?`).run(nextHash, options.roomId, currentHash, nextHash);
      if (result.changes !== 1) throw new Error("Room rotation outcome is unknown; preserve its journal.");
      assert(); db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    return options.next;
  } finally {
    try { db.close(); } finally { active.delete(options.roomId); }
  }
}
