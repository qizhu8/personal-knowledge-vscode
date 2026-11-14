import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Separate, explicitly provisioned private native evidence directory. */
export class LegacyChatProcessCapture {
  private readonly directory: number;
  private readonly files = new Map<string, number>();
  constructor(path: string) {
    if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error("Chat process capture requires a canonical directory.");
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || (stat.mode & 0o7000) !== 0 || stat.uid !== process.getuid?.())
      throw new Error("Chat process capture directory must be private and owned.");
    this.directory = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(this.directory);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      closeSync(this.directory);
      throw new Error("Chat process capture directory changed.");
    }
  }
  private path(jobId: string, stream: "stdout" | "stderr") {
    if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new Error("Invalid native process identity.");
    return `/proc/self/fd/${this.directory}/${jobId}.${stream}.log`;
  }
  write(jobId: string, stream: "stdout" | "stderr", bytes: Buffer) {
    const key = `${jobId}:${stream}`;
    let fd = this.files.get(key);
    if (fd === undefined) {
      fd = openSync(this.path(jobId, stream), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      this.files.set(key, fd);
    }
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("Native process output write made no progress.");
      offset += written;
    }
  }
  finish(jobId: string) {
    const failures: unknown[] = [];
    for (const stream of ["stdout", "stderr"] as const) {
      const key = `${jobId}:${stream}`, fd = this.files.get(key);
      if (fd === undefined) continue;
      this.files.delete(key);
      try { fsyncSync(fd); } catch (error) { failures.push(error); }
      try { closeSync(fd); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Native process output could not be persisted.");
  }
  read(jobId: string, stream: "stdout" | "stderr", start: number, length: number) {
    let fd: number;
    try { fd = openSync(this.path(jobId, stream), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && start === 0)
        return { bytes: Buffer.alloc(0), size: 0 };
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid native process output.");
      if (start > stat.size) throw new Error("Output byte offset is beyond the available evidence.");
      const bytes = Buffer.alloc(Math.min(length, stat.size - start));
      const count = readSync(fd, bytes, 0, bytes.length, start);
      return { bytes: bytes.subarray(0, count), size: stat.size };
    } finally { closeSync(fd); }
  }
  close() {
    if (this.files.size) throw new Error("Native process output is still open.");
    closeSync(this.directory);
  }
}
