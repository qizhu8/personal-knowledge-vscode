import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

type Fields = Record<string, string | number | boolean | null>;

export class DiagnosticLog {
  readonly writerId = `${process.pid}-${randomUUID().replace(/-/g, "")}`;
  private sequence = 0;
  private rows = 0;
  private dropped = 0;
  private recordIndex = 0;
  private readonly recent: Record<string, unknown>[] = [];
  private lastError: string | undefined;

  constructor(readonly directory: string, readonly maxRows = 100_000, private chunkRows = 1_000,
    private readonly onError?: (error: Error) => void) {
    if (!Number.isInteger(maxRows) || !Number.isInteger(chunkRows) || maxRows < 1 || chunkRows < 1) {
      throw new RangeError("Log capacities must be positive integers");
    }
    this.chunkRows = Math.min(chunkRows, maxRows);
  }

  record(event: string, fields: Fields = {}): void {
    let entry: Record<string, unknown> | undefined;
    let written = false;
    try {
      entry = {
        schema: "pkm.diagnostic/v1", at: new Date().toISOString(), pid: process.pid,
        writerId: this.writerId, event: event.slice(0, 80),
        ...Object.fromEntries(Object.entries(fields).map(([key, value]) =>
          [key, typeof value === "string" ? value.slice(0, 1024) : value])),
        dropped: this.dropped,
        recordIndex: ++this.recordIndex, persisted: true,
      };
      const line = JSON.stringify(entry);
      if (Buffer.byteLength(line, "utf8") > 4096) {
        entry = { schema: "pkm.diagnostic/v1", at: entry.at, writerId: this.writerId, recordIndex: this.recordIndex,
          event: "diagnostic.record.dropped", sourceEvent: event.slice(0, 80), persisted: false };
        throw new Error("Diagnostic record exceeded the 4096-byte limit.");
      }
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (this.rows >= this.chunkRows) {
        this.sequence += 1;
        this.rows = 0;
      }
      fs.appendFileSync(this.filename(this.sequence), `${line}\n`, { encoding: "utf8", mode: 0o600 });
      written = true;
      this.rows += 1;
      const obsolete = this.sequence - (Math.ceil(this.maxRows / this.chunkRows) + 1);
      if (obsolete >= 0) fs.rmSync(this.filename(obsolete), { force: true });
      this.lastError = undefined;
    } catch (error) {
      if (!written) this.dropped += 1;
      if (entry) entry.persisted = written;
      this.reportFailure(error);
    } finally {
      if (entry) {
        this.recent.push(entry);
        if (this.recent.length > Math.min(200, this.maxRows)) this.recent.shift();
      }
    }
  }

  get persistenceError(): string | undefined { return this.lastError; }

  private reportFailure(error: unknown): void {
    const message = `PKM diagnostic logging unavailable: ${error instanceof Error ? error.message : "Unknown filesystem failure"}. Recent diagnostics remain in memory until the Extension Host reloads.`;
    if (this.lastError) return;
    this.lastError = message;
    try {
      if (this.onError) this.onError(new Error(message));
      else console.error(message);
    } catch (notificationError) { console.error("PKM diagnostic failure notification failed:", notificationError); }
  }

  latest(limit = 200): Record<string, unknown>[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxRows) {
      throw new RangeError(`limit must be between 1 and ${this.maxRows}`);
    }
    const records: Record<string, unknown>[] = [];
    const result = () => {
      const merged = new Map<unknown, Record<string, unknown>>();
      for (const entry of [...records, ...this.recent]) merged.set(entry.recordIndex, entry);
      return [...merged.values()].sort((left, right) => Number(left.recordIndex) - Number(right.recordIndex)).slice(-limit);
    };
    let filenames: string[];
    try {
      filenames = fs.readdirSync(this.directory).filter(filename =>
        filename.startsWith(`${this.writerId}.`) && filename.endsWith(".jsonl")).sort().reverse();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) this.reportFailure(error);
      return result();
    }
    for (const filename of filenames) {
      let lines: string[];
      try { lines = fs.readFileSync(path.join(this.directory, filename), "utf8").split("\n"); }
      catch (error) { this.reportFailure(error); continue; }
      for (const line of lines.reverse()) {
        try {
          const entry = JSON.parse(line);
          if (!entry || entry.schema !== "pkm.diagnostic/v1") continue;
          records.push(entry);
          if (records.length >= limit) return result();
        } catch { continue; }
      }
    }
    return result();
  }

  private filename(sequence: number): string {
    return path.join(this.directory, `${this.writerId}.${String(sequence).padStart(10, "0")}.jsonl`);
  }
}