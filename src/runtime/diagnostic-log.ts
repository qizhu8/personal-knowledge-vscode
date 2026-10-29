import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

type Fields = Record<string, string | number | boolean | null>;

export class DiagnosticLog {
  readonly writerId = `${process.pid}-${randomUUID().replace(/-/g, "")}`;
  private sequence = 0;
  private rows = 0;
  private dropped = 0;

  constructor(readonly directory: string, readonly maxRows = 100_000, private chunkRows = 1_000) {
    if (!Number.isInteger(maxRows) || !Number.isInteger(chunkRows) || maxRows < 1 || chunkRows < 1) {
      throw new RangeError("Log capacities must be positive integers");
    }
    this.chunkRows = Math.min(chunkRows, maxRows);
  }

  record(event: string, fields: Fields = {}): void {
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (this.rows >= this.chunkRows) {
        this.sequence += 1;
        this.rows = 0;
      }
      const entry = {
        schema: "pkm.diagnostic/v1", at: new Date().toISOString(), pid: process.pid,
        writerId: this.writerId, event: event.slice(0, 80),
        ...Object.fromEntries(Object.entries(fields).map(([key, value]) =>
          [key, typeof value === "string" ? value.slice(0, 1024) : value])),
        dropped: this.dropped,
      };
      const line = JSON.stringify(entry);
      if (Buffer.byteLength(line, "utf8") > 4096) {
        this.dropped += 1;
        return;
      }
      fs.appendFileSync(this.filename(this.sequence), `${line}\n`, { encoding: "utf8", mode: 0o600 });
      this.rows += 1;
      const obsolete = this.sequence - (Math.ceil(this.maxRows / this.chunkRows) + 1);
      if (obsolete >= 0) fs.rmSync(this.filename(obsolete), { force: true });
    } catch {
      this.dropped += 1;
    }
  }

  latest(limit = 200): Record<string, unknown>[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxRows) {
      throw new RangeError(`limit must be between 1 and ${this.maxRows}`);
    }
    const records: Record<string, unknown>[] = [];
    let filenames: string[];
    try {
      filenames = fs.readdirSync(this.directory).filter(filename =>
        filename.startsWith(`${this.writerId}.`) && filename.endsWith(".jsonl")).sort().reverse();
    } catch {
      return records;
    }
    for (const filename of filenames) {
      let lines: string[];
      try { lines = fs.readFileSync(path.join(this.directory, filename), "utf8").split("\n"); }
      catch { continue; }
      for (const line of lines.reverse()) {
        try {
          const entry = JSON.parse(line);
          if (!entry || entry.schema !== "pkm.diagnostic/v1") continue;
          records.push(entry);
          if (records.length >= limit) return records.reverse();
        } catch { continue; }
      }
    }
    return records.reverse();
  }

  private filename(sequence: number): string {
    return path.join(this.directory, `${this.writerId}.${String(sequence).padStart(10, "0")}.jsonl`);
  }
}