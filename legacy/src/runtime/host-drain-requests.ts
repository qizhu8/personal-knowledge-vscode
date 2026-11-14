import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fingerprint = /^[a-f0-9]{64}$/;
type ManagedTarget = Readonly<{ sessionId: string; operationIds: readonly string[] }>;

/** Routing only: a root fingerprint is not a user grant or a drain receipt. */
export function hostDrainRootFingerprint(root: string): string {
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root)
    throw new Error("Host drain root is not canonical.");
  const stat = fs.lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Host drain root is not a directory.");
  return createHash("sha256").update(`${root}\0${stat.dev}\0${stat.ino}`).digest("hex");
}

/**
 * Untrusted, short-lived request routing. Each receiving host must separately
 * obtain its own user consent. A request or its disappearance is not an ACK.
 */
export class HostDrainRequests {
  private readonly handled = new Map<string, number>();
  constructor(private readonly directory: string, private readonly hostId: string,
    private readonly now: () => number = Date.now) {
    if (!uuid.test(hostId) || !path.isAbsolute(directory)) throw new Error("Invalid host drain router.");
  }

  private checkDirectory(): void {
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(this.directory) !== this.directory
      || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077))
      throw new Error("Host drain request directory is unavailable.");
  }

  request(rootFingerprint: string, hostIds: readonly string[], managed?: ManagedTarget): string {
    if (!fingerprint.test(rootFingerprint) || !hostIds.length || hostIds.length > 100
      || hostIds.some(id => !uuid.test(id)) || new Set(hostIds).size !== hostIds.length
      || managed && (!uuid.test(managed.sessionId) || !Array.isArray(managed.operationIds)
        || !managed.operationIds.length || managed.operationIds.length > 100
        || managed.operationIds.some(id => !uuid.test(id))
        || new Set(managed.operationIds).size !== managed.operationIds.length))
      throw new Error("Host drain request targets are invalid.");
    this.checkDirectory();
    const id = randomUUID(), staging = path.join(this.directory, `managed-drain-${id}.staging`);
    const target = path.join(this.directory, "managed-drain-request.json");
    const payload = JSON.stringify({ schema: "pkm.host-drain-request/v1", id,
      rootFingerprint, hostIds: [...hostIds], createdAt: this.now(),
      ...(managed ? { managed: { sessionId: managed.sessionId, operationIds: [...managed.operationIds] } } : {}) });
    let created = false;
    try {
      const fd = fs.openSync(staging, fs.constants.O_WRONLY | fs.constants.O_CREAT
        | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      created = true;
      try { fs.writeFileSync(fd, payload); } finally { fs.closeSync(fd); }
      this.checkDirectory();
      fs.renameSync(staging, target);
      created = false;
    } finally { try { if (created) fs.unlinkSync(staging); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } }
    return id;
  }

  poll(rootFingerprint: string, managed?: Readonly<{ sessionId: string; operationId: string }>): boolean {
    if (!fingerprint.test(rootFingerprint)) return false;
    this.checkDirectory();
    const target = path.join(this.directory, "managed-drain-request.json");
    let fd: number;
    try { fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    let value: any;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 8192) return false;
      try { value = JSON.parse(fs.readFileSync(fd, "utf8")); } catch { return false; }
    } finally { fs.closeSync(fd); }
    const now = this.now();
    for (const [id, expiry] of this.handled) if (expiry < now) this.handled.delete(id);
    if (value?.schema !== "pkm.host-drain-request/v1" || typeof value.id !== "string" || !uuid.test(value.id)
      || this.handled.has(value.id) || this.handled.size >= 1000 || value.rootFingerprint !== rootFingerprint
      || !Number.isSafeInteger(value.createdAt) || value.createdAt > this.now()
      || this.now() - value.createdAt > 60_000
      || !Array.isArray(value.hostIds) || value.hostIds.length > 100
      || value.hostIds.some((id: unknown) => typeof id !== "string" || !uuid.test(id))
      || !value.hostIds.includes(this.hostId)) return false;
    if (managed) {
      if (!uuid.test(managed.sessionId) || !uuid.test(managed.operationId)
        || value.managed?.sessionId !== managed.sessionId || !Array.isArray(value.managed.operationIds)
        || !value.managed.operationIds.length || value.managed.operationIds.length > 100
        || value.managed.operationIds.some((id: unknown) => typeof id !== "string" || !uuid.test(id))
        || new Set(value.managed.operationIds).size !== value.managed.operationIds.length
        || !value.managed.operationIds.includes(managed.operationId)) return false;
    } else if (value.managed !== undefined) return false;
    this.handled.set(value.id, value.createdAt + 60_000);
    return true;
  }
}
