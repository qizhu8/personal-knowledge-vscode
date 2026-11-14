import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { AsyncLocalStorage } from "async_hooks";

const lockDirectoryName = ".pkm-next-root-adoption-locks";
const readyScript = `
process.stdout.write(process.argv[1]);
const release = () => process.exit(0);
process.stdin.once("data", release);
process.stdin.once("end", release);
process.stdin.resume();
`;
const waitCell = new Int32Array(new SharedArrayBuffer(4));
interface WriterLease { fence: LinuxRootWriterFence; refs: number; }
interface WriterScope { root: string; lease: WriterLease; open: boolean; }
const writerScope = new AsyncLocalStorage<WriterScope>();

export interface LinuxRootWriterFence {
  readonly root: string;
  readonly mode: "shared" | "exclusive";
  assertHeld(): void;
  release(): void;
}

interface Paths {
  root: string;
  lockPath: string;
  markerPath: string;
  rollbackPath: string;
  siblingMarkerPath: string;
  siblingLockPath: string;
  device: bigint;
  inode: bigint;
}

function paths(root: string): Paths {
  const absolute = path.resolve(root);
  const canonical = fs.realpathSync.native(absolute);
  if (canonical !== absolute) throw new Error("Writer fencing requires a canonical Knowledge Root.");
  const rootStat = fs.lstatSync(canonical, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Writer fencing requires a real Knowledge Root.");
  const rootHash = createHash("sha256").update(canonical).digest("hex").slice(0, 40);
  const lockDirectory = path.join(path.dirname(canonical), lockDirectoryName);
  return {
    root: canonical, lockPath: canonical,
    markerPath: path.join(canonical, ".pkm-next-writer-fenced.json"),
    rollbackPath: path.join(canonical, ".pkm-next-root-adoption-rollback.json"),
    siblingMarkerPath: path.join(lockDirectory, `${rootHash}.writer-fenced.json`),
    siblingLockPath: path.join(lockDirectory, `${rootHash}.writer.lock`),
    device: rootStat.dev, inode: rootStat.ino,
  };
}

function assertRootIdentity(value: Paths): void {
  const stat = fs.lstatSync(value.root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== value.device || stat.ino !== value.inode)
    throw new Error("The fenced Knowledge Root identity changed.");
}

function assertNoSiblingPreview(value: Paths): void {
  try {
    const stat = fs.lstatSync(path.dirname(value.siblingLockPath));
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()
      || (stat.mode & 0o077) !== 0) throw new Error("The previous sibling writer-fence directory is unsafe.");
  } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  for (const file of [value.siblingLockPath, value.siblingMarkerPath]) {
    try { fs.lstatSync(file); throw new Error("A previous experimental sibling writer fence requires recovery."); }
    catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  }
}

function spawnHolder(value: Paths, mode: "shared" | "exclusive", timeoutMs: number, nonce: string): ChildProcess {
  const fd = fs.openSync(value.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isDirectory() || stat.dev !== value.device || stat.ino !== value.inode)
      throw new Error("The fenced Knowledge Root identity changed.");
    return spawn("sh", ["-c", `flock ${mode === "shared" ? "-s" : "-x"} -w "$1" 3 || exit $?; shift; exec "$@"`,
      "pkm-root-fence", String(timeoutMs / 1000), process.execPath, "-e", readyScript, nonce],
    { stdio: ["pipe", "pipe", "ignore", fd], windowsHide: true });
  } finally { fs.closeSync(fd); }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code === "EPERM"; }
}

function ready(child: ChildProcess, nonce: string): boolean {
  const descriptor = (child.stdout as unknown as { _handle?: { fd?: unknown } })?._handle?.fd;
  if (typeof descriptor !== "number") throw new Error("The writer-fence readiness pipe is unavailable.");
  const data = Buffer.alloc(Buffer.byteLength(nonce));
  try {
    const length = fs.readSync(descriptor, data, 0, data.length, null);
    if (length === 0) throw new Error("The writer-fence holder closed its readiness pipe.");
    if (length !== data.length || data.toString("utf8") !== nonce)
      throw new Error("The writer-fence lock holder readiness record is invalid.");
    return true;
  } catch (error: any) {
    if (error?.code === "EAGAIN" || error?.code === "EWOULDBLOCK") return false;
    throw error;
  }
}

function waitForReady(child: ChildProcess, nonce: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready(child, nonce)) return;
    if (!child.pid || !processExists(child.pid)) throw new Error("Could not start the Linux flock writer-fence holder.");
    Atomics.wait(waitCell, 0, 0, 10);
  }
  throw new Error("Timed out acquiring the Linux cross-process writer fence.");
}

export function acquireLinuxRootWriterFence(
  root: string, mode: "shared" | "exclusive", timeoutMs = 30_000,
): LinuxRootWriterFence {
  if (process.platform !== "linux") {
    return { root: path.resolve(root), mode, assertHeld() {}, release() {} };
  }
  const value = paths(root);
  assertNoSiblingPreview(value);
  const nonce = randomUUID();
  const child = spawnHolder(value, mode, timeoutMs, nonce);
  child.stdin?.on("error", () => {});
  if (!child.pid) throw new Error("The Linux flock utility is required for cross-process writer fencing.");
  try { waitForReady(child, nonce, timeoutMs + 1000); assertRootIdentity(value); assertNoSiblingPreview(value); }
  catch (error) {
    child.stdin?.end();
    if (child.pid && processExists(child.pid)) {
      try { process.kill(child.pid, "SIGTERM"); } catch { /* The lock holder already exited. */ }
    }
    throw error;
  }
  return heldFence(value, child, mode);
}

function heldFence(value: Paths, child: ChildProcess, mode: "shared" | "exclusive"): LinuxRootWriterFence {
  let released = false;
  return {
    root: value.root,
    mode,
    assertHeld() {
      if (released || !child.pid || !processExists(child.pid)) throw new Error("The Linux cross-process writer fence was lost.");
      assertRootIdentity(value);
    },
    release() {
      if (released) return;
      released = true;
      const descriptor = (child.stdin as unknown as { _handle?: { fd?: unknown } })?._handle?.fd;
      try {
        if (typeof descriptor === "number" && Number.isInteger(descriptor) && descriptor >= 0)
          fs.writeSync(descriptor, "release\n");
        else child.stdin?.end();
      } catch { child.stdin?.end(); }
      child.stdin?.end();
    },
  };
}

async function acquireSharedFenceAsync(root: string, timeoutMs: number): Promise<LinuxRootWriterFence> {
  if (process.platform !== "linux") return acquireLinuxRootWriterFence(root, "shared", timeoutMs);
  const value = paths(root);
  assertNoSiblingPreview(value);
  const nonce = randomUUID();
  const child = spawnHolder(value, "shared", timeoutMs, nonce);
  child.stdin?.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out acquiring the Linux cross-process writer fence.")), timeoutMs + 1000);
      let response = "";
      child.stdout?.on("data", data => {
        response += data.toString();
        if (response.length < nonce.length) return;
        clearTimeout(timer);
        if (response !== nonce) reject(new Error("The writer-fence lock holder readiness record is invalid."));
        else resolve();
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Could not acquire the Linux cross-process writer fence.")); });
    });
    assertRootIdentity(value);
    assertNoSiblingPreview(value);
    return heldFence(value, child, "shared");
  } catch (error) {
    child.stdin?.end();
    try { child.kill("SIGTERM"); } catch { /* The holder already exited. */ }
    throw error;
  }
}

export function markLinuxRootNextOwned(root: string): void {
  if (process.platform !== "linux") return;
  const value = paths(root);
  assertNoSiblingPreview(value);
  const rootStat = fs.lstatSync(value.root, { bigint: true });
  const marker = {
    schema: "pkm.linux-root-writer-fence/v1",
    root: value.root,
    device: rootStat.dev.toString(),
    inode: rootStat.ino.toString(),
    owner: "next-server",
  };
  try {
    const existing = JSON.parse(fs.readFileSync(value.markerPath, "utf8"));
    if (JSON.stringify(existing) !== JSON.stringify(marker)) throw new Error("The durable writer-fence marker belongs to another root.");
    const stat = fs.lstatSync(value.markerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
      throw new Error("The durable writer-fence marker is unsafe.");
    return;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${value.markerPath}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(marker)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    fs.renameSync(temporary, value.markerPath);
    const dir = fs.openSync(value.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { try { fs.unlinkSync(temporary); } catch { /* The atomic rename already consumed it. */ } }
}

export function assertLinuxRootStillLegacyWritable(root: string): void {
  if (process.platform !== "linux") return;
  const value = paths(root);
  for (const marker of [value.markerPath, value.siblingMarkerPath, value.rollbackPath]) {
    try {
      const stat = fs.lstatSync(marker);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
        throw new Error("The durable writer-fence marker is unsafe.");
      throw new Error("This Knowledge Root has been handed to next-server; legacy writes are fenced.");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export function withLegacyLinuxRootWriter<T>(root: string, action: () => T, timeoutMs = 30_000): T {
  if (process.platform !== "linux") return action();
  const parent = writerScope.getStore();
  if (parent) {
    if (!parent.open || path.resolve(root) !== parent.root) throw new Error("The legacy writer scope is no longer valid.");
    parent.lease.fence.assertHeld();
    parent.lease.refs++;
    const nested = { ...parent, open: true };
    try { return writerScope.run(nested, action); }
    finally { nested.open = false; releaseWriterLease(parent.lease); }
  }
  const fence = acquireLinuxRootWriterFence(root, "shared", timeoutMs);
  const lease = { fence, refs: 1 };
  const scope = { root: fence.root, lease, open: true };
  try {
    assertLinuxRootStillLegacyWritable(root);
    fence.assertHeld();
    return writerScope.run(scope, action);
  } finally { scope.open = false; releaseWriterLease(lease); }
}

/** Give a child its own shared flock so it remains fenced if its owner dies. */
export function legacyLinuxRootWriterChild(command: string, args: string[]): { command: string; args: string[] } {
  const scope = writerScope.getStore();
  if (process.platform !== "linux" || !scope) return { command, args };
  if (!scope.open) throw new Error("The legacy writer scope is no longer valid.");
  scope.lease.fence.assertHeld();
  const value = paths(scope.root);
  assertNoSiblingPreview(value);
  return {
    command: "flock",
    args: ["--shared", "--no-fork", value.lockPath, "sh", "-c",
      'if [ -e "$1" ] || [ -L "$1" ] || [ -e "$2" ] || [ -L "$2" ] || [ -e "$3" ] || [ -L "$3" ]; then echo "Knowledge Root was handed to next-server" >&2; exit 75; fi; shift 3; exec "$@"',
      "pkm-writer-child", value.markerPath, value.siblingMarkerPath, value.rollbackPath, command, ...args],
  };
}

function releaseWriterLease(lease: WriterLease): void {
  if (--lease.refs === 0) lease.fence.release();
}

/** Covers the full awaited operation, including nested synchronous writers. */
export async function withLegacyLinuxRootWriterAsync<T>(root: string, action: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  if (process.platform !== "linux") return action();
  const parent = writerScope.getStore();
  if (parent) {
    if (!parent.open || path.resolve(root) !== parent.root) throw new Error("The legacy writer scope is no longer valid.");
    parent.lease.fence.assertHeld();
    parent.lease.refs++;
    const nested = { ...parent, open: true };
    try { return await writerScope.run(nested, action); }
    finally { nested.open = false; releaseWriterLease(parent.lease); }
  }
  const fence = await acquireSharedFenceAsync(root, timeoutMs);
  const lease = { fence, refs: 1 };
  const scope = { root: fence.root, lease, open: true };
  try {
    assertLinuxRootStillLegacyWritable(root);
    fence.assertHeld();
    return await writerScope.run(scope, action);
  } finally { scope.open = false; releaseWriterLease(lease); }
}
