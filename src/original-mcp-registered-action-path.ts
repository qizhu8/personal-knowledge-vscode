import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";

export function registeredActionPathExists(path: string) {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function pinRegisteredActionPath(path: string) {
  const entries: Array<[string, string, string]> = [];
  let bytes = 0;
  const identity = (stat: Stats) => [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  const visit = (absolute: string, name: string, depth: number) => {
    const stat = lstatSync(absolute);
    if (depth > 16 || entries.length >= 128 || stat.isSymbolicLink() || realpathSync(absolute) !== absolute)
      throw new Error("REGISTERED_ACTION_PATH_CUSTODY_REQUIRED");
    if (stat.isFile()) {
      bytes += stat.size;
      if (stat.nlink !== 1 || bytes > 33554432) throw new Error("REGISTERED_ACTION_PATH_BOUND_EXCEEDED");
      const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const content = readFileSync(fd);
        if (content.length !== stat.size || identity(fstatSync(fd)) !== identity(stat))
          throw new Error("REGISTERED_ACTION_PATH_CHANGED");
        entries.push([name, "file", createHash("sha256").update(content).digest("hex")]);
      } finally { closeSync(fd); }
    } else if (stat.isDirectory()) {
      entries.push([name, "directory", ""]);
      for (const child of readdirSync(absolute).sort()) visit(join(absolute, child), `${name}/${child}`, depth + 1);
    } else throw new Error("REGISTERED_ACTION_PATH_KIND_REQUIRED");
    if (identity(lstatSync(absolute)) !== identity(stat)) throw new Error("REGISTERED_ACTION_PATH_CHANGED");
  };
  visit(path, "", 0);
  return { entryKind: entries[0]![1] as "file" | "directory",
    sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex") };
}
