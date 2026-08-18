import * as fs from "fs";
import * as os from "os";
import { randomUUID } from "crypto";

export interface ChatRoomLockRecord {
  installationId: string;
  pid: number;
  instanceNonce: string;
  hostname: string;
  acquiredAt: number;
  roomId?: string;
  roomName?: string;
  activeUrl?: string;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code === "EPERM"; }
}

function readRecord(filePath: string): ChatRoomLockRecord | undefined {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")) as ChatRoomLockRecord; }
  catch { return undefined; }
}

function writeExclusive(filePath: string, record: ChatRoomLockRecord): void {
  const fd = fs.openSync(filePath, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function acquireRecoveryGuard(lockPath: string, record: ChatRoomLockRecord): string {
  const guardPath = `${lockPath}.recovery`;
  try { writeExclusive(guardPath, record); return guardPath; }
  catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    const guard = readRecord(guardPath);
    if (guard?.hostname === os.hostname() && !processAlive(guard.pid)) {
      try { fs.unlinkSync(guardPath); } catch { /* another contender recovered it */ }
      try { writeExclusive(guardPath, record); return guardPath; }
      catch (retryError: any) { if (retryError?.code !== "EEXIST") throw retryError; }
    }
    throw new Error("Room lock recovery is already in progress.");
  }
}

export class ChatRoomLock {
  private released = false;

  private constructor(readonly lockPath: string, readonly record: ChatRoomLockRecord) {}

  static acquire(lockPath: string, installationId: string): ChatRoomLock {
    const record: ChatRoomLockRecord = {
      installationId,
      pid: process.pid,
      instanceNonce: randomUUID(),
      hostname: os.hostname(),
      acquiredAt: Date.now(),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeExclusive(lockPath, record);
        return new ChatRoomLock(lockPath, record);
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        const owner = readRecord(lockPath);
        const sameMachineDead = owner?.hostname === os.hostname() && !processAlive(owner.pid);
        if (!sameMachineDead || attempt > 0) {
          const detail = owner ? `${owner.hostname}:${owner.pid}` : "an unreadable lock";
          throw new Error(`Room is already hosted by ${detail}.`);
        }
        const guardPath = acquireRecoveryGuard(lockPath, record);
        try {
          const current = readRecord(lockPath);
          const currentDead = current?.hostname === os.hostname() && !processAlive(current.pid);
          if (!currentDead) throw new Error(`Room became active during recovery at ${current?.hostname}:${current?.pid}.`);
          try { fs.unlinkSync(lockPath); }
          catch (unlinkError: any) { if (unlinkError?.code !== "ENOENT") throw unlinkError; }
        } finally {
          try { fs.unlinkSync(guardPath); } catch { /* stale guard is recoverable by PID */ }
        }
      }
    }
    throw new Error("Unable to acquire Room lock.");
  }

  updateDescriptor(descriptor: { roomId: string; roomName: string; activeUrl: string }): void {
    const owner = readRecord(this.lockPath);
    if (!owner || owner.instanceNonce !== this.record.instanceNonce) throw new Error("Room lock ownership changed.");
    const next = { ...owner, ...descriptor };
    const temporary = `${this.lockPath}.${this.record.instanceNonce}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temporary, this.lockPath);
    Object.assign(this.record, descriptor);
  }

  release(): boolean {
    if (this.released) return false;
    const owner = readRecord(this.lockPath);
    if (!owner || owner.instanceNonce !== this.record.instanceNonce) return false;
    fs.unlinkSync(this.lockPath);
    this.released = true;
    return true;
  }
}