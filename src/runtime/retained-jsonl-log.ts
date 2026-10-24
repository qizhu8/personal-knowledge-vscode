import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { withCrossProcessLock } from "./cross-process-lock";

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETAINED_ROWS = 1_000;
const MAX_LOG_BYTES = 4 * 1024 * 1024;

function latestLines(filename: string): string {
  const descriptor = fs.openSync(filename, "r");
  try {
    let position = fs.fstatSync(descriptor).size;
    const chunks: Buffer[] = [];
    let bytes = 0, newlines = 0;
    while (position > 0 && bytes < MAX_LOG_BYTES && newlines <= RETAINED_ROWS) {
      const length = Math.min(position, 64 * 1024, MAX_LOG_BYTES - bytes);
      position -= length;
      const chunk = Buffer.alloc(length);
      const read = fs.readSync(descriptor, chunk, 0, length, position);
      if (read !== length) throw new Error("Diagnostic log changed during retention.");
      for (const byte of chunk) if (byte === 10) newlines++;
      chunks.unshift(chunk);
      bytes += length;
    }
    const lines = Buffer.concat(chunks).toString("utf8").split("\n");
    if (position > 0) lines.shift();
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.filter(line => line.trim()).slice(-RETAINED_ROWS).map(line => `${line}\n`).join("");
  } finally { fs.closeSync(descriptor); }
}

function replaceFile(filename: string, content: string): void {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Batches writers under one lock; retention reads only a bounded tail, never the full log. */
export class RetainedJsonlLog {
  private lines: string[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private work: Promise<void> = Promise.resolve();
  private nextRetentionCheck = 0;

  constructor(readonly filename: string, private readonly onError: (error: unknown) => void,
    private readonly now: () => number = Date.now) {}

  append(entry: Record<string, unknown>): void {
    this.lines.push(`${JSON.stringify(entry)}\n`);
    if (!this.timer) {
      this.timer = setTimeout(() => { void this.flush().catch(this.onError); }, 250);
      this.timer.unref();
    }
  }

  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    const lines = this.lines.splice(0);
    const operation = this.work.then(() => withCrossProcessLock(`${this.filename}.lock`, "Sync diagnostic log", 5_000, async () => {
      if (lines.length) fs.appendFileSync(this.filename, lines.join(""), { encoding: "utf8", mode: 0o600 });
      const now = this.now();
      let size = 0;
      try { size = fs.statSync(this.filename).size; }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      if (now < this.nextRetentionCheck && size <= MAX_LOG_BYTES) return;
      const marker = `${this.filename}.retention.json`;
      let lastCompactedAt: number | undefined;
      try {
        const record = JSON.parse(fs.readFileSync(marker, "utf8"));
        if (record.schema !== "pkm.sync-log-retention/v1" || !Number.isFinite(record.lastCompactedAt) || record.lastCompactedAt < 0) {
          throw new Error("Invalid Sync diagnostic retention state.");
        }
        lastCompactedAt = record.lastCompactedAt;
      } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      const due = lastCompactedAt === undefined || lastCompactedAt > now || now - lastCompactedAt >= RETENTION_INTERVAL_MS;
      if (due || size > MAX_LOG_BYTES) {
        if (size) replaceFile(this.filename, latestLines(this.filename));
        fs.rmSync(`${this.filename}.previous`, { force: true });
        replaceFile(marker, JSON.stringify({ schema: "pkm.sync-log-retention/v1", lastCompactedAt: now }));
        this.nextRetentionCheck = now + RETENTION_INTERVAL_MS;
      } else {
        this.nextRetentionCheck = lastCompactedAt! + RETENTION_INTERVAL_MS;
      }
    }));
    this.work = operation.then(() => {}, () => {});
    return operation;
  }
}
