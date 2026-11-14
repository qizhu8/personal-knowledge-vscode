/**
 * Child-only qualification preload. Never imported by the host: invocation requires
 * an explicit --import and a disposable test fixture. SQLite's C I/O is not patched.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, workerData } from "node:worker_threads";

type Rule = {
  enabled: boolean; syscall: "open" | "write" | "fsync" | "rename";
  code: "ENOSPC" | "EIO" | "EACCES"; phase: "before" | "after" | "partial";
  pathKind: "temporary" | "directory"; ordinal: number; matches: number; hits: number;
};
const fixture = process.env.PKM_STORAGE_IO_FAULT_FIXTURE;
if (fixture) {
  const base = resolve(fileURLToPath(new URL("../tests/", import.meta.url)));
  const parent = resolve(fixture);
  if (dirname(parent) !== base || !/^\.storage-io-fault-[a-f0-9-]+$/.test(parent.slice(base.length + 1))) {
    throw new Error("I/O qualification requires a direct disposable tests fixture.");
  }
  const root = resolve(parent, "workspace"), control = resolve(parent, "control.json"), trace = resolve(parent, "trace.jsonl");
  const native = {
    open: fs.openSync.bind(fs), write: fs.writeFileSync.bind(fs), sync: fs.fsyncSync.bind(fs),
    rename: fs.renameSync.bind(fs), close: fs.closeSync.bind(fs), read: fs.readFileSync.bind(fs),
    append: fs.appendFileSync.bind(fs), stat: fs.lstatSync.bind(fs), writeSync: fs.writeSync.bind(fs),
  };
  for (const path of [parent, root]) {
    const stat = native.stat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe fault fixture.");
  }
  const descriptors = new Map<number, string>();
  function scoped(path: unknown): string | undefined {
    if (path instanceof URL) path = fileURLToPath(path);
    if (Buffer.isBuffer(path)) path = path.toString();
    if (typeof path !== "string") return undefined;
    const full = resolve(path), rel = relative(root, full);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
    // Check real ancestors, not merely a lexical prefix, before granting injection.
    for (let ancestor = dirname(full);; ancestor = dirname(ancestor)) {
      const stat = native.stat(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Fault path escaped fixture.");
      if (ancestor === root) break;
    }
    return full;
  }
  function boundary(syscall: Rule["syscall"], path: string | undefined, action: () => unknown, partial?: () => number) {
    if (!path) return action();
    const rule: Rule = JSON.parse(native.read(control, "utf8"));
    if (!rule.enabled || rule.syscall !== syscall || rule.hits
      || (rule.pathKind === "temporary" ? !/\/\.pkm-write-[a-f0-9-]+$/.test(path) : !native.stat(path).isDirectory())) return action();
    rule.matches++;
    const hit = rule.matches === rule.ordinal;
    if (hit) { rule.hits++; rule.enabled = false; }
    native.write(control, JSON.stringify(rule));
    if (!hit) return action();
    let partialBytes = 0;
    if (rule.phase === "after") action();
    if (rule.phase === "partial") {
      if (!partial) throw new Error("Partial fault is only supported for descriptor writes.");
      partialBytes = partial();
    }
    native.append(trace, JSON.stringify({
      syscall, code: rule.code, phase: rule.phase, path: relative(root, path).split(sep).join("/"),
      ordinal: rule.ordinal, matches: rule.matches, hits: rule.hits, partialBytes,
      storageWorker: !isMainThread && workerData === root,
    }) + "\n");
    throw Object.assign(new Error(`Injected filesystem ${rule.code} at ${syscall} boundary`), {
      code: rule.code, syscall, path, errno: { ENOSPC: -28, EIO: -5, EACCES: -13 }[rule.code],
    });
  }
  fs.openSync = ((path, flags, mode) => {
    const full = scoped(path);
    const fd = boundary("open", full, () => native.open(path, flags, mode)) as number;
    if (full) descriptors.set(fd, full);
    return fd;
  }) as typeof fs.openSync;
  fs.closeSync = fd => { try { native.close(fd); } finally { descriptors.delete(fd); } };
  fs.writeFileSync = ((file, data, options) => {
    const full = typeof file === "number" ? descriptors.get(file) : scoped(file);
    return boundary("write", full, () => native.write(file, data, options), () => {
      if (typeof file !== "number") throw new Error("Partial qualification requires an owned descriptor.");
      const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data as Uint8Array);
      return native.writeSync(file, bytes, 0, Math.min(7, bytes.length));
    });
  }) as typeof fs.writeFileSync;
  fs.fsyncSync = fd => { boundary("fsync", descriptors.get(fd), () => native.sync(fd)); };
  fs.renameSync = (from, to) => {
    const source = scoped(from), destination = scoped(to);
    boundary("rename", source && destination ? source : undefined, () => native.rename(from, to));
  };
  syncBuiltinESMExports();
}
