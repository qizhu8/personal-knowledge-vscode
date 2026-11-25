import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readProtectedRefreshAtRoot } from "./legacy-subscription-refresh.js";
import { knowledgeReadPrivateTopLevels } from "./fresh-note-query-contracts.js";

export interface LegacySnapshotFile {
  area: string; path: string; raw?: string; mtimeNs: string; pin: string; size: number; directory?: boolean;
}

/** Snapshot the isolated cache/resources, not the original globalStorage or a host-selected path. */
export function legacyKnowledgeTree(root: string, area: string, relative = "", metadataOnly = false,
  includeContent: (path: string) => boolean = () => true): LegacySnapshotFile[] {
  const privateTopLevels = knowledgeReadPrivateTopLevels(root, area);
  if (relative && privateTopLevels.has(relative.split("/")[0]!)) return [];
  for (const prefix of [area, ...relative.split("/").slice(0, -1)].map((_part, index, parts) => parts.slice(0, index + 1))) {
    const stat = lstatSync(join(root, ...prefix), { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error("INVALID_DOCUMENT: Knowledge snapshot parents must be regular directories.");
  }
  if (area === "subscriptions" && relative === "cache") {
    const refresh = readProtectedRefreshAtRoot(root);
    if (refresh) {
      const directories = refresh.directories.map(path => ({
        area, path: path.slice("subscriptions/".length), mtimeNs: "0", pin: `refresh:${refresh.head}:${path}`, size: 0, directory: true,
      }));
      const content = refresh.files.map(file => {
        const row: LegacySnapshotFile = { area, path: file.path, mtimeNs: "0",
          pin: `refresh:${refresh.head}:${file.sha256}`, size: file.size };
        if (!metadataOnly && includeContent(file.path)) {
          try { row.raw = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); } catch { /* Binary cache asset. */ }
        }
        return row;
      });
      return [...directories, ...content];
    }
  }
  const files: LegacySnapshotFile[] = [];
  function walk(path: string) {
    if (path && privateTopLevels.has(path.split("/")[0]!)) return;
    const full = join(root, area, path);
    const stat = lstatSync(full, { bigint: true, throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1n))
      throw new Error("INVALID_DOCUMENT: Knowledge snapshots refuse links and special files.");
    const pin = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const row: LegacySnapshotFile = { area, path, mtimeNs: String(stat.mtimeNs), pin, size: Number(stat.size) };
    if (stat.isDirectory()) {
      files.push({ ...row, directory: true });
      const directory = opendirSync(full);
      const folders: string[] = [];
      try {
        for (let entry; (entry = directory.readSync()) !== null;) {
          const child = path ? `${path}/${entry.name}` : entry.name;
          if (entry.isDirectory()) folders.push(child);
          else walk(child);
        }
      } finally { directory.closeSync(); }
      for (const folder of folders) walk(folder);
    } else {
      if (!metadataOnly && includeContent(path)) {
        const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true });
          if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== pin)
            throw new Error("CONFLICT: Knowledge changed during snapshot.");
          try { row.raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
          catch { /* Original cache search skips non-UTF-8 resources. */ }
        } finally { closeSync(fd); }
      }
      files.push(row);
    }
  }
  walk(relative);
  return files;
}
