import * as fs from "fs";

interface JsonCacheEntry {
  birthtimeMs: number;
  ctimeMs: number;
  ino: number;
  mtimeMs: number;
  size: number;
  value: unknown;
}

export class JsonFileCache {
  private readonly entries = new Map<string, JsonCacheEntry>();
  private hitCount = 0;
  private missCount = 0;

  constructor(private readonly maxEntries = 512) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive integer.");
    }
  }

  read<T>(filePath: string): T {
    const stat = fs.statSync(filePath);
    const cached = this.entries.get(filePath);
    if (cached
      && cached.birthtimeMs === stat.birthtimeMs
      && cached.ctimeMs === stat.ctimeMs
      && cached.ino === stat.ino
      && cached.mtimeMs === stat.mtimeMs
      && cached.size === stat.size) {
      this.entries.delete(filePath);
      this.entries.set(filePath, cached);
      this.hitCount += 1;
      return cached.value as T;
    }

    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    this.entries.delete(filePath);
    this.entries.set(filePath, {
      birthtimeMs: stat.birthtimeMs,
      ctimeMs: stat.ctimeMs,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      value,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.missCount += 1;
    return value;
  }

  invalidate(filePath: string): void {
    this.entries.delete(filePath);
  }

  stats(): { entries: number; hits: number; misses: number } {
    return { entries: this.entries.size, hits: this.hitCount, misses: this.missCount };
  }
}
