import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

interface LockRecord { pid: number; nonce: string; acquiredAt: number; owner: string; }

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code === "EPERM"; }
}

function retryableFileError(error: any): boolean {
  return error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES";
}

function unlinkWithRetry(lockPath: string): void {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      fs.unlinkSync(lockPath);
      return;
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      if (!retryableFileError(error) || attempt >= 7) throw error;
      Atomics.wait(waitArray, 0, 0, 15 * (attempt + 1));
    }
  }
}

function lockAttempt(lockPath: string, owner: string): { acquire: () => boolean; release: () => void; cleanup: () => void } {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const record: LockRecord = { pid: process.pid, nonce: randomUUID(), acquiredAt: Date.now(), owner };
  const staging = `${lockPath}.${record.nonce}.pending`;
  const member = `${record.nonce}.json`;
  const removeMember = (directory: string, filename: string): void => {
    try { unlinkWithRetry(path.join(directory, filename)); }
    catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    try { fs.rmdirSync(directory); }
    catch (error: any) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error; }
  };
  fs.mkdirSync(staging, { mode: 0o700 });
  let initialized = false;
  try {
    const fd = fs.openSync(path.join(staging, member), "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    initialized = true;
  } finally {
    if (!initialized) removeMember(staging, member);
  }
  return {
    acquire: () => {
      // Publishing a nonempty directory is exclusive on Windows and POSIX.
      // Reapers remove only the observed nonce member, never a successor's lock.
      try { fs.renameSync(staging, lockPath); return true; }
      catch (error: any) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "ENOTDIR", "EISDIR"].includes(error?.code)) throw error;
      }
      let stat: fs.Stats;
      try { stat = fs.lstatSync(lockPath); }
      catch (error: any) { if (["ENOENT", "ENOTDIR"].includes(error?.code)) return false; throw error; }
      if (stat.isSymbolicLink()) throw new Error(`${owner}: refusing a symbolic-link lock at ${lockPath}.`);
      let filename = lockPath;
      if (stat.isDirectory()) {
        let entries: string[];
        try { entries = fs.readdirSync(lockPath); }
        catch (error: any) { if (error?.code === "ENOENT") return false; throw error; }
        if (!entries.length) {
          try { fs.rmdirSync(lockPath); }
          catch (error: any) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error; }
          return false;
        }
        if (entries.length !== 1 || !/^[a-f0-9-]{36}\.json$/.test(entries[0])) {
          throw new Error(`${owner}: invalid lock directory at ${lockPath}; preserve it for recovery.`);
        }
        filename = path.join(lockPath, entries[0]);
      }
      let existing: LockRecord;
      try { existing = JSON.parse(fs.readFileSync(filename, "utf8")) as LockRecord; }
      catch (error: any) {
        if (["ENOENT", "EISDIR", "ENOTDIR"].includes(error?.code) || error instanceof SyntaxError) return false;
        throw error;
      }
      if (!Number.isSafeInteger(existing.pid) || existing.pid <= 0 || typeof existing.nonce !== "string") {
        throw new Error(`${owner}: invalid lock owner at ${lockPath}; preserve it for recovery.`);
      }
      // Elapsed time alone cannot revoke a live operation's ownership.
      if (!processAlive(existing.pid)) {
        if (stat.isDirectory()) removeMember(lockPath, path.basename(filename));
        else {
          try { unlinkWithRetry(lockPath); }
          catch (error: any) { if (!["ENOENT", "EISDIR", "EPERM"].includes(error?.code)) throw error; }
        }
      }
      return false;
    },
    release: () => removeMember(lockPath, member),
    cleanup: () => removeMember(staging, member),
  };
}

export async function withCrossProcessLock<T>(lockPath: string, owner: string, timeoutMs: number, action: () => Promise<T>, _leaseMs = Math.max(timeoutMs * 2, 30_000)): Promise<T> {
  const attempt = lockAttempt(lockPath, owner);
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  try {
    while (!(acquired = attempt.acquire())) {
      if (Date.now() >= deadline) throw new Error(`${owner} lock timed out; another live operation or an incomplete legacy lock owns ${lockPath}.`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return await action();
  } finally {
    if (acquired) attempt.release();
    attempt.cleanup();
  }
}

export function withCrossProcessLockSync<T>(lockPath: string, owner: string, action: () => T): T {
  const attempt = lockAttempt(lockPath, owner);
  const deadline = Date.now() + 2_000;
  let acquired = false;
  try {
    while (!(acquired = attempt.acquire())) {
      if (Date.now() >= deadline) throw new Error(`${owner} is busy in another PKM window or has an incomplete legacy lock at ${lockPath}. Try again.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    return action();
  } finally {
    if (acquired) attempt.release();
    attempt.cleanup();
  }
}