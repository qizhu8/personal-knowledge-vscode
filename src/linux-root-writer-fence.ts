import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CoreError } from "./contracts.js";
import { renameNoReplaceSync } from "./rename-no-replace.js";

const lockDirectoryName = ".pkm-next-root-adoption-locks";
const readyScript = `
process.stdout.write(process.argv[1]);
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`;
const markerSchema = "pkm.linux-root-writer-fence/v1";
const trustedFences = new WeakSet<object>();

export interface LinuxRootWriterFence {
  readonly root: string;
  readonly mode: "exclusive";
  assertHeld(): void;
  publishRootNoReplace(destination: string, publish: (keepAlive: number) => void | Promise<void>): Promise<void>;
  renameNoReplaceWithinRoot(source: string, destination: string, pythonExecutable?: string): void;
  archiveFileToPrivateDirectory(source: string, directory: string, name: string): Promise<void>;
  release(): Promise<void>;
}

interface Paths {
  root: string;
  rootDevice: string;
  rootInode: string;
  lockDirectory: string;
  lockPath: string;
  markerPath: string;
  siblingLockPath: string;
  siblingMarkerPath: string;
}

async function paths(root: string): Promise<Paths> {
  const absolute = resolve(root), canonical = await realpath(absolute);
  if (canonical !== absolute) throw new CoreError("INVALID_WORKSPACE", "Writer fencing requires a canonical Knowledge Root without symlinks.");
  const rootStat = await lstat(canonical, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new CoreError("INVALID_WORKSPACE", "Writer fencing requires a real Knowledge Root.");
  const rootHash = createHash("sha256").update(canonical).digest("hex").slice(0, 40);
  const sibling = join(dirname(canonical), lockDirectoryName);
  return {
    root: canonical, rootDevice: rootStat.dev.toString(), rootInode: rootStat.ino.toString(),
    lockDirectory: canonical, lockPath: canonical,
    markerPath: join(canonical, ".pkm-next-writer-fenced.json"),
    siblingLockPath: join(sibling, `${rootHash}.writer.lock`),
    siblingMarkerPath: join(sibling, `${rootHash}.writer-fenced.json`),
  };
}

async function assertNoSiblingPreview(value: Paths): Promise<void> {
  try {
    const stat = await lstat(dirname(value.siblingLockPath));
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()
      || (stat.mode & 0o077) !== 0)
      throw new CoreError("RECOVERY_REQUIRED", "The previous sibling writer-fence directory is unsafe.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  for (const file of [value.siblingLockPath, value.siblingMarkerPath]) {
    try { await lstat(file); throw new CoreError("RECOVERY_REQUIRED", "A previous experimental sibling writer fence requires recovery."); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}

function assertRootIdentity(value: Paths): void {
  const stat = lstatSync(value.root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || stat.dev.toString() !== value.rootDevice || stat.ino.toString() !== value.rootInode)
    throw new CoreError("STORAGE_UNAVAILABLE", "The fenced Knowledge Root identity changed.", "unknown");
}

function waitForReady(child: ChildProcess, nonce: string, timeoutMs: number): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new CoreError("BUSY", "Timed out acquiring the Linux cross-process writer fence.")), timeoutMs);
    let response = "";
    child.stdout?.on("data", data => {
      response += data.toString();
      if (response.length < nonce.length) return;
      clearTimeout(timer);
      if (response !== nonce) rejectReady(new CoreError("INVALID_WORKSPACE", "The writer-fence lock holder readiness record is invalid."));
      else resolveReady();
    });
    child.once("error", error => { clearTimeout(timer); rejectReady(error); });
    child.once("exit", () => { clearTimeout(timer); rejectReady(new CoreError("BUSY", "Could not acquire the Linux cross-process writer fence.")); });
  });
}

function waitForChildClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolveClose => child.once("close", () => resolveClose()));
}

async function assertExistingMarker(value: Paths): Promise<void> {
  try {
    const stat = await lstat(value.markerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096
      || process.platform !== "win32" && ((stat.mode & 0o077) !== 0
        || process.getuid && stat.uid !== process.getuid())) {
      throw new CoreError("RECOVERY_REQUIRED", "The durable writer-fence marker is unsafe.");
    }
    const marker: unknown = JSON.parse(await readFile(value.markerPath, "utf8"));
    if (!marker || typeof marker !== "object" || Array.isArray(marker)
      || (marker as Record<string, unknown>).schema !== markerSchema
      || (marker as Record<string, unknown>).root !== value.root
      || (marker as Record<string, unknown>).device !== value.rootDevice
      || (marker as Record<string, unknown>).inode !== value.rootInode
      || (marker as Record<string, unknown>).owner !== "next-server") {
      throw new CoreError("RECOVERY_REQUIRED", "The durable writer-fence marker does not match this Knowledge Root.");
    }
  } catch (error) {
    if (error instanceof CoreError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export async function assertLinuxRootOwnerMarker(root: string): Promise<void> {
  if (process.platform !== "linux") return;
  await assertExistingMarker(await paths(root));
}

export async function acquireLinuxRootWriterFence(
  root: string, timeoutMs = 30_000,
): Promise<LinuxRootWriterFence> {
  if (process.platform !== "linux") {
    const fence = { root: resolve(root), mode: "exclusive" as const, assertHeld() {},
      async publishRootNoReplace() { throw new CoreError("STORAGE_UNAVAILABLE", "This fenced publication requires Linux."); },
      renameNoReplaceWithinRoot() { throw new CoreError("STORAGE_UNAVAILABLE", "This fenced move requires Linux."); },
      async archiveFileToPrivateDirectory() { throw new CoreError("STORAGE_UNAVAILABLE", "This fenced move requires Linux."); },
      async release() {} };
    trustedFences.add(fence);
    return fence;
  }
  const value = await paths(root);
  await assertNoSiblingPreview(value);
  const nonce = randomUUID();
  const directory = await open(value.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let child: ChildProcess;
  try {
    const stat = await directory.stat({ bigint: true });
    if (!stat.isDirectory() || stat.dev.toString() !== value.rootDevice || stat.ino.toString() !== value.rootInode)
      throw new CoreError("STORAGE_UNAVAILABLE", "The fenced Knowledge Root identity changed.", "unknown");
    child = spawn("sh", ["-c", 'flock -x -w "$1" 3 || exit $?; shift; exec "$@"',
      "pkm-root-fence", String(timeoutMs / 1000), process.execPath, "-e", readyScript, nonce],
    { stdio: ["pipe", "pipe", "ignore", directory.fd], windowsHide: true });
  } finally { await directory.close(); }
  if (!child.pid) throw new CoreError("STORAGE_UNAVAILABLE", "The Linux flock utility is required for cross-process writer fencing.");
  try { await waitForReady(child, nonce, timeoutMs + 1000); assertRootIdentity(value); await assertNoSiblingPreview(value); }
  catch (error) {
    child.stdin?.end();
    try { child.kill("SIGTERM"); } catch { /* The lock holder already exited. */ }
    await waitForChildClose(child);
    throw error;
  }
  let released = false;
  const fence: LinuxRootWriterFence = {
    root: value.root,
    mode: "exclusive",
    assertHeld() {
      if (released || child.exitCode !== null || child.signalCode !== null)
        throw new CoreError("STORAGE_UNAVAILABLE", "The Linux cross-process writer fence was lost.", "unknown");
      assertRootIdentity(value);
    },
    async publishRootNoReplace(destination, publish) {
      fence.assertHeld();
      if (resolve(destination) !== destination || destination === value.root
        || dirname(destination) !== dirname(value.root))
        throw new CoreError("INVALID_WORKSPACE", "Fenced root publication requires a distinct canonical sibling destination.");
      const targetHash = createHash("sha256").update(destination).digest("hex").slice(0, 40);
      const targetValue = { ...value, root: destination, lockDirectory: destination,
        markerPath: join(destination, ".pkm-next-writer-fenced.json"),
        siblingLockPath: join(dirname(value.siblingLockPath), `${targetHash}.writer.lock`),
        siblingMarkerPath: join(dirname(value.siblingMarkerPath), `${targetHash}.writer-fenced.json`) };
      await assertNoSiblingPreview(targetValue);
      await assertExistingMarker(value);
      try {
        await lstat(destination);
        throw new CoreError("CONFLICT", "The root publication destination already exists.");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const keepAlive = (child.stdin as unknown as { _handle?: { fd?: unknown } })?._handle?.fd;
      if (typeof keepAlive !== "number" || !Number.isInteger(keepAlive) || keepAlive < 0)
        throw new CoreError("STORAGE_UNAVAILABLE", "The Linux writer-fence keepalive descriptor is unavailable.", "unknown");
      // Bind the marker before publication so a crash cannot expose an unfenced target.
      await writeOwnerMarker(value, destination);
      fence.assertHeld();
      await publish(keepAlive);
      assertRootIdentity(targetValue);
      await assertExistingMarker(targetValue);
    },
    renameNoReplaceWithinRoot(source, destination, pythonExecutable) {
      fence.assertHeld();
      for (const path of [source, destination]) {
        const member = relative(value.root, path);
        if (resolve(path) !== path || !member || member === ".." || member.startsWith(`..${sep}`))
          throw new CoreError("INVALID_WORKSPACE", "Fenced moves require absolute paths inside the fenced root.");
        let current = value.root;
        const parts = member.split(sep);
        for (const part of parts.slice(0, -1)) {
          current = join(current, part);
          const stat = lstatSync(current);
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new CoreError("INVALID_WORKSPACE", "Fenced move parents must be real directories.");
        }
      }
      if (lstatSync(source).isSymbolicLink())
        throw new CoreError("INVALID_WORKSPACE", "Fenced moves cannot move symbolic links.");
      if (!child.stdin || child.stdin.destroyed)
        throw new CoreError("STORAGE_UNAVAILABLE", "The Linux writer-fence keepalive pipe is unavailable.", "unknown");
      // The helper inherits the pipe's write end, keeping flock alive if this process dies mid-rename.
      const keepAlive = (child.stdin as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
      if (typeof keepAlive !== "number" || !Number.isInteger(keepAlive) || keepAlive < 0)
        throw new CoreError("STORAGE_UNAVAILABLE", "The Linux writer-fence keepalive descriptor is unavailable.", "unknown");
      renameNoReplaceSync(source, destination, pythonExecutable, keepAlive);
      fence.assertHeld();
    },
    async archiveFileToPrivateDirectory(source, directory, name) {
      fence.assertHeld();
      const sourceMember = relative(value.root, source);
      if (resolve(source) !== source || source !== value.markerPath
        && (!sourceMember || sourceMember.includes(sep) || sourceMember === ".."))
        throw new CoreError("INVALID_WORKSPACE", "Only a root-owned file or its writer marker may be archived.");
      const directoryMember = relative(value.lockDirectory, directory);
      if (resolve(directory) !== directory || !directoryMember || directoryMember.includes(sep)
        || directoryMember === ".." || !/^[A-Za-z0-9._-]+$/.test(directoryMember)
        || !name || name.includes(sep) || name === "." || name === "..")
        throw new CoreError("INVALID_WORKSPACE", "Rollback archive must be a private direct child of the lock directory.");
      const info = lstatSync(directory), sourceInfo = lstatSync(source), rootInfo = lstatSync(value.root);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
        || process.getuid === undefined || info.uid !== process.getuid()
        || info.dev !== rootInfo.dev || sourceInfo.dev !== info.dev || !sourceInfo.isFile()
        || sourceInfo.isSymbolicLink() || sourceInfo.nlink !== 1)
        throw new CoreError("RECOVERY_REQUIRED", "Rollback archive or source is unsafe or crosses filesystems.");
      if (source === value.markerPath) await assertExistingMarker(value);
      fence.assertHeld();
      const keepAlive = (child.stdin as unknown as { _handle?: { fd?: unknown } })?._handle?.fd;
      if (typeof keepAlive !== "number" || !Number.isInteger(keepAlive) || keepAlive < 0)
        throw new CoreError("STORAGE_UNAVAILABLE", "The Linux writer-fence keepalive descriptor is unavailable.", "unknown");
      renameNoReplaceSync(source, join(directory, name), undefined, keepAlive);
      fence.assertHeld();
    },
    async release() {
      if (released) return;
      released = true;
      child.stdin?.end();
      const deadline = Date.now() + 3000;
      if (child.exitCode === null && child.signalCode === null) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            new Promise<void>(resolveExit => child.once("close", () => resolveExit())),
            new Promise<void>(resolveTimeout => { timer = setTimeout(resolveTimeout, Math.max(0, deadline - Date.now())); }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
      }
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGTERM"); } catch { /* The lock holder already exited. */ }
        await waitForChildClose(child);
      }
    },
  };
  trustedFences.add(fence);
  return fence;
}

export async function markLinuxRootNextOwned(root: string, fence: LinuxRootWriterFence): Promise<void> {
  fence.assertHeld();
  if (fence.mode !== "exclusive" || resolve(root) !== fence.root)
    throw new CoreError("STORAGE_UNAVAILABLE", "Only the exclusive writer fence may mark this root as Next-owned.");
  if (process.platform !== "linux") return;
  const value = await paths(fence.root);
  assertRootIdentity(value);
  await assertNoSiblingPreview(value);
  await assertExistingMarker(value);
  try {
    await lstat(value.markerPath);
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await writeOwnerMarker(value, value.root);
}

async function writeOwnerMarker(value: Paths, root: string): Promise<void> {
  const marker = {
    schema: markerSchema,
    root,
    device: value.rootDevice,
    inode: value.rootInode,
    owner: "next-server",
  };
  const temporary = `${value.markerPath}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(JSON.stringify(marker)); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(temporary, value.markerPath);
    const directory = await open(value.lockDirectory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    try { await unlink(temporary); } catch { /* The atomic rename already consumed it. */ }
  }
}

export function isTrustedLinuxRootWriterFence(value: unknown, root: string): value is LinuxRootWriterFence {
  return !!value && typeof value === "object" && trustedFences.has(value)
    && (value as LinuxRootWriterFence).mode === "exclusive"
    && (value as LinuxRootWriterFence).root === root
    && typeof (value as LinuxRootWriterFence).assertHeld === "function"
    && typeof (value as LinuxRootWriterFence).release === "function";
}
