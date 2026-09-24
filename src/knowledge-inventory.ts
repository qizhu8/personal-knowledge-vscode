import { Worker } from "worker_threads";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

export interface KnowledgeInventoryEntry {
  area: string; relativePath: string; fullPath: string; fingerprint: string;
  mtimeMs: number; size: number; category: string; title: string; slug: string;
  name: string; description: string; type: string; tags: string; source_project: string; extension: string;
  pinned?: boolean;
}
export interface KnowledgeInventorySnapshot {
  schema: 1; root: string; revision: string; updatedAt: string;
  entries: Record<string, KnowledgeInventoryEntry>;
  stats: { scanned: number; reused: number; parsed: number; removed: number };
}

export class KnowledgeInventoryManager {
  private snapshotValue: KnowledgeInventorySnapshot;
  private refreshPromise: Promise<KnowledgeInventorySnapshot> | undefined;
  private readonly folderCache = new Map<string, string[]>();

  constructor(private readonly root: string, private readonly stateDir: string, private readonly workerScript: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.snapshotValue = this.readSnapshot() || { schema: 1, root, revision: "", updatedAt: "", entries: {}, stats: { scanned: 0, reused: 0, parsed: 0, removed: 0 } };
  }

  get snapshot(): KnowledgeInventorySnapshot { return this.snapshotValue; }
  entries(area?: string): KnowledgeInventoryEntry[] {
    return Object.values(this.snapshotValue.entries).filter(entry => !area || entry.area === area);
  }
  notes(): any[] {
    return this.entries("notes").filter(entry => entry.extension === ".md").map(entry => ({
      slug: entry.slug, title: entry.title, description: entry.description, type: entry.type,
      tags: entry.tags, pinned: false, category: entry.category,
      created_at: new Date(entry.mtimeMs).toISOString(), updated_at: new Date(entry.mtimeMs).toISOString(),
    })).sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }
  skills(): any[] {
    return this.entries("skills").filter(entry => entry.extension === ".md").map(entry => ({
      name: entry.name, description: entry.description, category: entry.category, tags: entry.tags,
      source_project: entry.source_project, pinned: !!entry.pinned, updated_at: new Date(entry.mtimeMs).toISOString(),
    })).sort((left, right) => left.name.localeCompare(right.name));
  }
  scripts(): any[] {
    const language = (extension: string): string => ({
      ".py": "Python", ".js": "JavaScript", ".ts": "TypeScript", ".sh": "Shell", ".ps1": "PowerShell",
      ".sql": "SQL", ".scope": "Scope", ".cs": "C#", ".json": "JSON", ".yaml": "YAML", ".yml": "YAML",
    } as Record<string, string>)[extension] || extension.replace(/^\./, "").toUpperCase() || "Text";
    return this.entries("scripts").map(entry => ({
      path: entry.relativePath, file: path.posix.basename(entry.relativePath), category: entry.category || "(root)",
      extension: entry.extension, lang: language(entry.extension), size: entry.size, updatedAt: new Date(entry.mtimeMs).toISOString(),
    })).sort((left, right) => left.path.localeCompare(right.path));
  }
  folders(area: string): string[] {
    const cached = this.folderCache.get(area);
    if (cached) return cached;
    const folders = new Set<string>();
    for (const entry of this.entries(area)) {
      const parts = entry.category.split("/").filter(Boolean);
      for (let depth = 1; depth <= parts.length; depth++) folders.add(parts.slice(0, depth).join("/"));
    }
    const walk = (directory: string, relative: string): void => {
      let children: fs.Dirent[];
      try { children = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const child of children) {
        if (!child.isDirectory() || child.name.startsWith(".") || child.name === "_assets") continue;
        const childRelative = relative ? `${relative}/${child.name}` : child.name;
        folders.add(childRelative);
        walk(path.join(directory, child.name), childRelative);
      }
    };
    walk(path.join(this.root, area), "");
    const result = [...folders].sort();
    this.folderCache.set(area, result);
    return result;
  }

  refresh(onProgress?: (progress: { scanned: number; reused: number; parsed: number; batchCount: number }) => void): Promise<KnowledgeInventorySnapshot> {
    if (this.refreshPromise) return this.refreshPromise;
    this.folderCache.clear();
    this.refreshPromise = this.refreshInner(onProgress);
    return this.refreshPromise.finally(() => { this.refreshPromise = undefined; });
  }

  private refreshInner(onProgress?: (progress: { scanned: number; reused: number; parsed: number; batchCount: number }) => void): Promise<KnowledgeInventorySnapshot> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerScript, { workerData: { root: this.root, previous: this.snapshotValue.entries } });
      worker.on("message", message => {
        if (message?.event === "progress") {
          const batch = message.batch && typeof message.batch === "object" ? message.batch : {};
          Object.assign(this.snapshotValue.entries, batch);
          onProgress?.({ scanned: Number(message.scanned || 0), reused: Number(message.reused || 0), parsed: Number(message.parsed || 0), batchCount: Object.keys(batch).length });
        }
        if (message?.event !== "complete") return;
        const entries = message.entries as Record<string, KnowledgeInventoryEntry>;
        const tuples = Object.keys(entries).sort().map(key => [key, entries[key].fingerprint]);
        const snapshot: KnowledgeInventorySnapshot = {
          schema: 1, root: this.root,
          revision: createHash("sha256").update(JSON.stringify(tuples)).digest("hex"),
          updatedAt: new Date().toISOString(), entries,
          stats: { scanned: Number(message.scanned || 0), reused: Number(message.reused || 0), parsed: Number(message.parsed || 0), removed: Number(message.removed || 0) },
        };
        this.writeSnapshot(snapshot);
        this.snapshotValue = snapshot;
        resolve(snapshot);
      });
      worker.once("error", reject);
      worker.once("exit", code => { if (code !== 0) reject(new Error(`Knowledge inventory worker exited with code ${code}.`)); });
    });
  }

  private manifestPath(): string { return path.join(this.stateDir, "manifest.json"); }
  private readSnapshot(): KnowledgeInventorySnapshot | undefined {
    try {
      const snapshot = JSON.parse(fs.readFileSync(this.manifestPath(), "utf8"));
      return snapshot?.schema === 1 && snapshot.root === this.root ? snapshot : undefined;
    } catch { return undefined; }
  }
  private writeSnapshot(snapshot: KnowledgeInventorySnapshot): void {
    const temporary = `${this.manifestPath()}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
    fs.renameSync(temporary, this.manifestPath());
  }
}
