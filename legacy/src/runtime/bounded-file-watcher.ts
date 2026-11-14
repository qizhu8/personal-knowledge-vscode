import * as fs from "fs";
import * as path from "path";

// Shared by all PKM watchers in this Extension Host, including Chat.
export const MAX_PKM_NATIVE_WATCHERS = 64;
let nativeWatchers = 0;
const excludedDirectories = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv", "env", "envs",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".cache",
]);

export function isPkmWatchDirectory(name: string): boolean {
  return !excludedDirectories.has(name);
}

class PkmWatchPathError extends Error {}

export function isPkmWatchPathAllowed(filename: string, platform = process.platform): boolean {
  if (!filename.trim()) return false;
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  if (windows) {
    filename = filename.replace(/^\\\\\?\\([a-z]:\\)/i, "$1");
    if (/^\\\\[?.]\\/.test(filename)) return false;
  }
  const normalize = (value: string) => {
    const resolved = paths.resolve(value);
    return windows ? resolved.toLowerCase() : resolved;
  };
  const resolved = normalize(filename);
  if (resolved === normalize(paths.parse(resolved).root)) return false;
  const protectedRoots = windows
    ? [process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
      process.env.ProgramFiles || "C:\\Program Files", process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"]
    : ["/usr", "/lib", "/lib32", "/lib64", "/bin", "/sbin", "/etc", "/proc", "/sys", "/dev", "/boot", "/run",
      ...(platform === "darwin" ? ["/System", "/Library", "/Applications", "/private/etc", "/private/var/run", "/private/var/db"] : [])];
  return !protectedRoots.some(root => {
    const protectedPath = normalize(root);
    return resolved === protectedPath || resolved.startsWith(protectedPath + paths.sep);
  });
}

export async function assertPkmWatchRootAllowed(filename: string): Promise<void> {
  const refuse = () => {
    throw new PkmWatchPathError(`PKM refused system/root path ${filename}; it will not be watched or polled. Choose a dedicated Knowledge Root outside system directories.`);
  };
  if (!isPkmWatchPathAllowed(filename)) refuse();
  let canonical: string;
  try { canonical = await fs.promises.realpath(filename); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) return;
    throw error;
  }
  if (!isPkmWatchPathAllowed(canonical)) refuse();
}

export function createBoundedFileWatcher<T>(
  roots: string[],
  options: {
    toEvent: (filename: string) => T;
    onError: (error: Error) => void;
    accept?: (filename: string) => boolean;
    descend?: (directory: string) => boolean;
    intervalMs?: number;
  },
): {
  dispose(): void;
  onDidCreate(listener: (event: T) => unknown): { dispose(): void };
  onDidChange(listener: (event: T) => unknown): { dispose(): void };
  onDidDelete(listener: (event: T) => unknown): { dispose(): void };
} {
  const listeners = {
    create: new Set<(event: T) => unknown>(),
    change: new Set<(event: T) => unknown>(),
    delete: new Set<(event: T) => unknown>(),
  };
  const watchers = new Map<string, fs.FSWatcher>();
  let snapshot = new Map<string, string>();
  let disposed = false;
  let initialized = false;
  let scanning = false;
  let dirty = false;
  let nativeUnavailable = false;
  let blocked = false;
  let pending: NodeJS.Timeout | undefined;
  const report = (error: unknown) => options.onError(error instanceof Error ? error : new Error(String(error)));
  const emit = (kind: keyof typeof listeners, filename: string) => {
    if (disposed || options.accept && !options.accept(filename)) return;
    for (const listener of listeners[kind]) {
      if (disposed) return;
      try { Promise.resolve(listener(options.toEvent(filename))).catch(report); }
      catch (error) { report(error); }
    }
  };
  const close = (directory: string) => {
    const watcher = watchers.get(directory);
    if (!watcher) return;
    watchers.delete(directory);
    nativeWatchers--;
    watcher.close();
  };
  const schedule = () => {
    if (disposed || blocked || pending) return;
    pending = setTimeout(() => { pending = undefined; void scan(); }, 250);
    pending.unref?.();
  };
  const watch = (directory: string) => {
    if (disposed || nativeUnavailable || watchers.has(directory) || nativeWatchers >= MAX_PKM_NATIVE_WATCHERS) return;
    try {
      // Native rename events cannot distinguish creation from deletion. Diff the
      // snapshot instead, also avoiding notifications for excluded descendants.
      const watcher = fs.watch(directory, { recursive: false }, schedule);
      nativeWatchers++;
      watchers.set(directory, watcher);
      watcher.on("error", error => {
        close(directory);
        nativeUnavailable = true;
        report(new Error(`PKM native watch failed at ${directory}; bounded polling remains active: ${error.message}`));
      });
    } catch (error) {
      nativeUnavailable = true;
      report(new Error(`PKM native watch unavailable at ${directory}; bounded polling remains active: ${String(error)}`));
    }
  };
  const scan = async () => {
    if (disposed || blocked) return;
    if (scanning) { dirty = true; return; }
    scanning = true;
    const next = new Map<string, string>();
    const directories = new Set<string>();
    const visit = async (filename: string, explicitRoot = false): Promise<void> => {
      if (disposed) return;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(filename);
        // A configured root may itself be a symlink; never follow child links.
        if (explicitRoot && stat.isSymbolicLink()) stat = await fs.promises.stat(filename);
      }
      catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) return;
        throw error;
      }
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        if (!isPkmWatchDirectory(path.basename(filename)) || options.descend && !options.descend(filename)) return;
        directories.add(filename);
        watch(filename);
        let children: fs.Dirent[];
        try { children = await fs.promises.readdir(filename, { withFileTypes: true }); }
        catch (error) {
          if (["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) return;
          throw error;
        }
        for (const child of children) {
          if (disposed) return;
          if (child.isSymbolicLink() || child.isDirectory() && !isPkmWatchDirectory(child.name)) continue;
          const childPath = path.join(filename, child.name);
          if (child.isFile() && options.accept && !options.accept(childPath)) continue;
          await visit(childPath);
        }
      } else if (stat.isFile() && (!options.accept || options.accept(filename))) {
        next.set(filename, `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`);
      }
    };
    try {
      for (const root of roots) {
        await assertPkmWatchRootAllowed(root);
        await visit(path.resolve(root), true);
      }
      if (disposed) return;
      for (const directory of watchers.keys()) if (!directories.has(directory)) close(directory);
      if (initialized) {
        for (const [filename, fingerprint] of next) {
          if (!snapshot.has(filename)) emit("create", filename);
          else if (snapshot.get(filename) !== fingerprint) emit("change", filename);
        }
        for (const filename of snapshot.keys()) if (!next.has(filename)) emit("delete", filename);
      }
      snapshot = next;
      initialized = true;
    } catch (error) {
      if (error instanceof PkmWatchPathError) {
        blocked = true;
        clearInterval(timer);
        if (pending) clearTimeout(pending);
        for (const directory of watchers.keys()) close(directory);
        snapshot.clear();
      }
      if (!disposed) report(error);
    }
    finally {
      scanning = false;
      if (dirty && !disposed) { dirty = false; schedule(); }
    }
  };
  const timer = setInterval(() => { void scan(); }, options.intervalMs ?? 15_000);
  timer.unref?.();
  setImmediate(() => { void scan(); });
  const subscribe = (kind: keyof typeof listeners, listener: (event: T) => unknown) => {
    listeners[kind].add(listener);
    return { dispose: () => { listeners[kind].delete(listener); } };
  };
  return {
    onDidCreate: listener => subscribe("create", listener),
    onDidChange: listener => subscribe("change", listener),
    onDidDelete: listener => subscribe("delete", listener),
    dispose: () => {
      disposed = true;
      clearInterval(timer);
      if (pending) clearTimeout(pending);
      for (const directory of watchers.keys()) close(directory);
      for (const callbacks of Object.values(listeners)) callbacks.clear();
      snapshot.clear();
    },
  };
}
