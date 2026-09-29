import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

interface LockRecord { pid: number; nonce: string; acquiredAt: number; owner: string; }

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code === "EPERM"; }
}

function readLock(lockPath: string): LockRecord | undefined {
  try { return JSON.parse(fs.readFileSync(lockPath, "utf8")) as LockRecord; }
  catch { return undefined; }
}

export async function withCrossProcessLock<T>(lockPath: string, owner: string, timeoutMs: number, action: () => Promise<T>, leaseMs = Math.max(timeoutMs * 2, 30_000)): Promise<T> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const record: LockRecord = { pid: process.pid, nonce: randomUUID(), acquiredAt: Date.now(), owner };
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readLock(lockPath);
      const expired = !!existing && Date.now() - Number(existing.acquiredAt || 0) > leaseMs;
      if (!existing || !processAlive(existing.pid) || expired) {
        try { fs.unlinkSync(lockPath); } catch { /* another contender recovered it */ }
      } else if (Date.now() >= deadline) {
        throw new Error(`${owner} lock timed out; owned by ${existing.owner || "another PKM window"} (PID ${existing.pid}).`);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { return await action(); }
  finally {
    const current = readLock(lockPath);
    if (current?.nonce === record.nonce) { try { fs.unlinkSync(lockPath); } catch { /* already released */ } }
  }
}

export function withCrossProcessLockSync<T>(lockPath: string, owner: string, action: () => T): T {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const record: LockRecord = { pid: process.pid, nonce: randomUUID(), acquiredAt: Date.now(), owner };
  const deadline = Date.now() + 2_000;
  const leaseMs = 30_000;
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { return action(); }
      finally {
        const current = readLock(lockPath);
        if (current?.nonce === record.nonce) { try { fs.unlinkSync(lockPath); } catch { /* already released */ } }
      }
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readLock(lockPath);
      const expired = !!existing && Date.now() - Number(existing.acquiredAt || 0) > leaseMs;
      if (!existing || !processAlive(existing.pid) || expired) {
        try { fs.unlinkSync(lockPath); } catch { /* another contender recovered it */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`${owner} is busy in another PKM window (PID ${existing.pid}). Try again.`);
      }
      Atomics.wait(waitArray, 0, 0, 50);
    }
  }
}